// GY-R29 S7 · 审核判定台账接真实 PostgreSQL 17.11 · 端到端证据（迁移 0028）
//
// 运行（本机隔离集群，仅回环；库名硬钉，要求**空库**）：
//   createdb -h 127.0.0.1 -p <port> gengyun_moderation_test
//   node tests/integration/moderation-ledger-pg.mjs postgres://postgres@127.0.0.1:<port>/gengyun_moderation_test
//
// 本脚本只讲一件事：**"当前结论"这条不变式由数据库给**，不是应用里先查后写换来的：
//   - 幂等靠主键 `job_id` + `ON CONFLICT (job_id) DO NOTHING`（重复落库不产生第二行）；
//   - "每个目标版本每个内容类别至多一条当前任务"靠**部分唯一索引**
//     `moderation_decisions_current_key ... WHERE superseded = FALSE`；
//   - 下架是终态靠 `moderation_withdrawals` 主键 + `ON CONFLICT DO NOTHING`（重放不新增行）。
//
// 覆盖的读数：
//   [M] 迁移三连：编号体检（未声明缺号 / 保留号躺平 / count＋保留 === max）⇒ 0001..0026 ⇒
//       **0027（origin/main 的真实文件，按序先于 0028）** ⇒ UP（两表/四条索引/部分唯一索引出现，
//       列数 26 与 5，且 0027 的函数仍在岗）⇒ ROLLBACK（本片对象消失，`users` 与社区/消息表
//       逐字仍在，0027 的对象不被连带拆掉）⇒ REPLAY（再出现）。
//   [F] 保留号躺平判据回归（无数据库）：临时目录（已含真实 0027）+ **夹具台账**（登记 27；并与真实台账合并
//       投喂 ⇒ 合流后真实台账已清空，眼下等于只喂夹具）⇒ 条目被判"必须删除"、`count＋保留 !== max` 同时判红、
//       计划顺序为 0027 → 0028。
//   [W] 写穿透：`create` + `flush` ⇒ 台账行真的在库里（列值与内存台账逐字段相等）；
//       同 `job_id` 再 `create` ⇒ 同步抛错且库里仍是 1 行。
//   [S] supersede：同目标版本再建任务 ⇒ 旧行 `superseded=true`、新行 `false`，当前行恒 1 条。
//   [V] 多版本共存：同目标不同 revision ⇒ 两行都 `superseded=false`（唯一性是**按 revision** 的）。
//   [U] 更新：状态/结论推进落到同一行；目标身份列（`target_type/target_id/target_revision`）逐字不变。
//   [X] 下架幂等：两次 `markWithdrawn` ⇒ `moderation_withdrawals` 恰好 1 行。
//   [H] 下架集合**回填**（W43）：实例 A 下架 + flush ⇒ **另起**实例 B，`hydrate()` 后
//       `isWithdrawn(已下架)=true`、`isWithdrawn(未下架)=false`、`snapshotCounts().withdrawn` 等于库里行数；
//       实例 C 只走 `flush()`（`service.ts` 的 `flushLedger()` 路径）同样就位。
//       这是"重启后旧回调不能复活已下架版本"（`service.ts:939` / `:1287`）的真库证据。
//   [C] 并发：两个台账实例同时建同一目标版本的任务 ⇒ 当前行恒 1 条（数据库判定，不是应用判定）。
//   [R] real 模式即便本表在场也 fail-closed：`submitScreening` 拒绝且**零行**落库
//       （不许为了让真库臂变绿伪造 published 写入）。
//   [I] 审核域**持久幂等台账**（迁移 0051 / R72-W41）：建表形制（六列 / 主键 `(scope, key_hash)` /
//       `moderation_idempotency_expires_idx`）⇒ `claimIdempotent` → `finalizeIdempotent` → `findIdempotent`
//       （payload 逐字取回、`pending=false`）⇒ 同键未过期再 claim ⇒ `exists` 且库里的 `request_hash`/`payload`
//       **不被覆盖**（409 由调用方判，不是 store 判）⇒ 把行改成已过期后 claim ⇒ `claimed`（`WHERE expires_at <= $7`
//       就地重占）⇒ `purgeIdempotent(未来时刻)` ⇒ 表 0 行 ⇒ 配对回滚整表拆除。
//       ⛔ 运行时可用的**列级授权**不在本臂判：本臂以库 owner 连库、不跑 20-login-roles.sql；角色面由
//       deploy/postgres-cvm/sql/90-assert-least-privilege.sql 的 `runtime_moderation_idempotency_dml_exec`
//       探针在 deploy-sql-gate 作业里判（六列 SELECT / 六列 INSERT + ON CONFLICT / 四列 UPDATE / DELETE 零行必须全成功）。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

import { discoverMigrations, formatMigrationVersion, inspectMigrationNumbering, loadMigrationReservations } from '../../services/api/src/db/migrate.ts';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createPostgresModerationLedger } from '../../services/api/src/moderation/ledger-pg.ts';
import { createPgModerationIdempotencyStore } from '../../services/api/src/moderation/idempotency-store.ts';

const DB = 'gengyun_moderation_test';
const MIGRATION = '0028_moderation_persistence.sql';
const DOWN = `migrations/rollback/${MIGRATION.replace(/\.sql$/, '.down.sql')}`;

const ownerUrl = new URL(process.argv[2] ?? `postgres://postgres@127.0.0.1:5432/${DB}`);
assert.equal(ownerUrl.hostname, '127.0.0.1', '本测试只允许回环地址');
assert.equal(ownerUrl.pathname, `/${DB}`, `库名必须硬钉为 ${DB}（防误连）`);

const notes = [];
function note(line) {
  notes.push(line);
  console.log(line);
}

const readSql = (rel) => readFileSync(new URL(`../../services/api/db/${rel}`, import.meta.url), 'utf8');
const migrationsDir = new URL('../../services/api/db/migrations/', import.meta.url);

const owner = new pg.Client({ connectionString: ownerUrl.href });
await owner.connect();
const pool = new pg.Pool({ connectionString: ownerUrl.href });

const q = async (text, params = []) => (await owner.query(text, params)).rows;
const one = async (text, params = []) => (await q(text, params))[0];
const countOf = async (text, params = []) => Number((await one(text, params)).v);

const TS = '2026-10-22T04:00:00.000Z';
const TARGET = Object.freeze({ type: 'post', id: randomUUID(), revision: 1 });
const ACTOR = { userId: randomUUID(), role: 'user', authEpoch: 1 };

function record(overrides = {}) {
  return {
    job_id: randomUUID(),
    target_ref: TARGET,
    content_kind: 'text',
    port_kind: 'tms',
    prompt_id: 'text_moderation',
    job_revision: 1,
    state: 'succeeded',
    lease_token: null,
    authorization_epoch: 1,
    submitted_by: ACTOR.userId,
    deadline_at: null,
    decision: 'approved',
    reason_codes: [],
    hard_rule_passed: true,
    rule_version: 'mr1+sha256:b4309f21',
    model_version: 'synthetic-tms-model@1.0',
    prompt_version: 'mp1+sha256:e24f2f6a',
    contract_value: null,
    gate_holder: null,
    error_code: null,
    evidence: { execution_mode: 'stub', reasons: [], text_length: 12 },
    superseded: false,
    created_at: TS,
    updated_at: TS,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// [M] 迁移三连（含 0027 → 0028 的**前向合流**自证）
// ---------------------------------------------------------------------------
// 为什么这条臂里要塞 0027：#428（feat/gy-r28-admin-audit-observability）带来了迁移 0027，
// 本分支只带 0028。合流前 `services/api/db/migration-reservations.json` 把 0027 登记为「有意缺号」，
// 而"登记"只是记账 —— 真正要证明的是**两条迁移按序落到同一个库上不打架**。
// **#434 合流 origin/main @ d4d48088 后（2026-10-22）**：0027 已是 `services/api/db/migrations/`
// 里的真实文件（不再是 `tests/integration/fixtures/` 的冻结夹具），台账里 27 号条目也已按 remove_when
// 删除 ⇒ 本臂改读**真实 0027**，顺序自证（0027 之前 before_value 不存在、之后在岗）逐条不动。
// ⚠ 本臂只证明"0027 → 0028 顺序不打架"，不主张 0027 本身被验收（那是 #428 的事）。
const RESERVED_FILENAME = '0027_admin_audit_observability.sql';
const RESERVED_MIGRATION_PATH = `migrations/${RESERVED_FILENAME}`;

async function migrationTriple() {
  // 编号体检交给产品代码 `inspectMigrationNumbering()`（与 4 条真库臂同一口径）：
  // 未声明缺号必须为空、保留台账里的号必须仍然缺位、`count + 保留数 === max`。
  const discovered = discoverMigrations();
  const numbering = inspectMigrationNumbering(discovered);
  assert.ok(
    discovered.some((migration) => migration.filename === MIGRATION),
    `迁移清单必须含 ${MIGRATION}`,
  );
  assert.deepEqual(
    numbering.undeclaredGaps.map(formatMigrationVersion),
    [],
    `迁移版本必须连续无缺号，且缺号必须在保留台账里声明（未声明：${numbering.undeclaredGaps.join(',')}）`,
  );
  assert.deepEqual(
    numbering.reservedButPresent.map(formatMigrationVersion),
    [],
    '保留台账里的号必须仍然缺位：文件已出现 ⇒ 删掉那条登记（保留项不许躺平）',
  );
  assert.equal(
    numbering.countMatchesMax,
    true,
    `迁移总数 + 已声明保留数必须等于最大版本号（count=${numbering.count}，reserved=${numbering.reserved.length}，max=${numbering.maxVersion}）`,
  );
  note(
    `[M] 迁移清单 ${numbering.count} 个（0001..${formatMigrationVersion(numbering.maxVersion)}），无未声明缺号；`
      + `保留号 [${numbering.reserved.map(formatMigrationVersion).join(',') || '无'}]；count＋保留 === max`,
  );

  const objects = async () => ({
    decisions: (await one("SELECT to_regclass('public.moderation_decisions') AS v")).v,
    withdrawals: (await one("SELECT to_regclass('public.moderation_withdrawals') AS v")).v,
    indexes: await countOf(
      "SELECT count(*)::int AS v FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('moderation_decisions','moderation_withdrawals')",
    ),
    named: await countOf(
      "SELECT count(*)::int AS v FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('moderation_decisions_current_key','moderation_decisions_target_idx','moderation_decisions_created_idx','moderation_withdrawals_recent_idx')",
    ),
    partial: await countOf(
      "SELECT count(*)::int AS v FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'moderation_decisions_current_key' AND indexdef LIKE '%WHERE%superseded%'",
    ),
    columns: await countOf(
      "SELECT count(*)::int AS v FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'moderation_decisions'",
    ),
    withdrawalColumns: await countOf(
      "SELECT count(*)::int AS v FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'moderation_withdrawals'",
    ),
    users: (await one("SELECT to_regclass('public.users') AS v")).v,
    community: (await one("SELECT to_regclass('public.community_posts') AS v")).v,
    messages: (await one("SELECT to_regclass('public.messages') AS v")).v,
    // #428 的 0027 在 0001..0026 之上"改写"了既有的 set_feature_flag（0020 已建同签名 8 参数函数），
    // 并给 admin_audit_events 补 before_value/after_value 两列 ⇒ 用这两处读数判"0027 真的落地了"。
    adminFlagWriter: (await one("SELECT to_regprocedure('public.set_feature_flag(text, integer, boolean, uuid, uuid, uuid, text, text)') AS v")).v,
    adminFlagReader: (await one("SELECT to_regprocedure('public.list_admin_flag_audit(integer, timestamptz, uuid)') AS v")).v,
    writerWritesBeforeValue: (await one(
      `SELECT (pg_get_functiondef('public.set_feature_flag(text, integer, boolean, uuid, uuid, uuid, text, text)'::regprocedure) LIKE '%before_value%') AS v`,
    )).v,
    auditBefore: await countOf(
      "SELECT count(*)::int AS v FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'admin_audit_events' AND column_name = 'before_value'",
    ),
  });

  // ① 0001..0026（即"本片之前的一切"）：0027 与 0028 都留到后面按序单独应用，
  //    这样"0027 应用前 before_value 不存在"的顺序自证才有个可观测的 before。
  //    ⛔ 相位边界必须按**号段**切（`version < 27`），不能写成"除 0027／0028 外全应用"：
  //    0029 起的后续迁移可以**依赖 0027 补的列**（如 R34／#525 的
  //    `0033_admin_audit_log_read.sql` 建的 `list_admin_audit_logs()` 读
  //    `admin_audit_events.before_value`），把它们排在 0027 之前应用会以
  //    `42703 column e.before_value does not exist` 直接炸掉——那与本臂要判的
  //    「0027 改写 / 0028 读写面 / 回滚 / 重放」毫无关系。整链按号顺跑（含 0033）由
  //    `tests/integration/admin-audit-logs-pg.mjs`（走 `migrate.ts up`）与
  //    `migrations-negative-pg.mjs` 等臂负责，覆盖没有减少。
  for (const migration of discovered) {
    if (migration.version >= 27) continue;
    await owner.query(readSql(`migrations/${migration.filename}`));
  }
  let state = await objects();
  assert.equal(state.decisions, null, '应用其它迁移后本片建的表必须还不存在（证明 UP 才是它出现的唯一原因）');
  assert.equal(state.withdrawals, null, '下架表同理');
  assert.equal(state.auditBefore, 0, '0027 夹具尚未应用时，它补的 before_value 列必须还不存在（顺序自证的另一半）');
  assert.equal(state.adminFlagReader, null, '0027 新建的读函数 list_admin_flag_audit 在应用前必须不存在');
  assert.equal(
    state.adminFlagWriter,
    'set_feature_flag(text,integer,boolean,uuid,uuid,uuid,text,text)',
    '0020 已经建过同签名的 set_feature_flag ⇒ 0027 是"改写"而不是"新建"，应用前它就该在岗',
  );
  assert.equal(state.writerWritesBeforeValue, false, '0020 版 set_feature_flag 不写 before_value（0027 才改写它）');

  // ② 0027（origin/main 的真实 DDL，按数字序先于 0028）⇒ ③ 0028。这就是"前向合流"的真库读数。
  await owner.query(readSql(RESERVED_MIGRATION_PATH));
  state = await objects();
  assert.equal(state.auditBefore, 1, '0027 给 admin_audit_events 补的 before_value 列必须在岗');
  assert.equal(
    state.adminFlagReader,
    'list_admin_flag_audit(integer,timestamp with time zone,uuid)',
    `0027 的读函数必须在 0001..0026 之上独立建出来（实测 to_regprocedure=${String(state.adminFlagReader)}）`,
  );
  assert.equal(
    state.writerWritesBeforeValue,
    true,
    '0027 必须真的改写了 set_feature_flag（函数体出现 before_value）；否则这条臂就只是跑了个寂寞',
  );
  note('[M] 0027（origin/main 真实文件）已按序应用：before_value 列 / list_admin_flag_audit / 改写后的 set_feature_flag 全部在岗');

  // ④ UP（0028 落在 0027 之后，与 #428 合入后的真实数字序一致）
  await owner.query(readSql(`migrations/${MIGRATION}`));
  state = await objects();
  assert.equal(state.decisions, 'moderation_decisions', 'UP 后台账表必须在岗');
  assert.equal(state.withdrawals, 'moderation_withdrawals', 'UP 后下架表必须在岗');
  assert.equal(state.indexes, 6, `四条显式索引 + 两表主键索引 = 6，现场 ${state.indexes}`);
  assert.equal(state.named, 4, `四条显式索引必须按名字在岗，现场 ${state.named}`);
  assert.equal(state.partial, 1, '"当前任务至多一条"必须是**部分**唯一索引（WHERE superseded = FALSE）');
  assert.equal(state.columns, 26, `台账列数锁定 26，现场 ${state.columns}`);
  assert.equal(state.withdrawalColumns, 5, `下架列数锁定 5，现场 ${state.withdrawalColumns}`);
  assert.ok(state.users && state.community && state.messages, 'UP 不得影响既有表（users/community_posts/messages 逐字仍在）');
  assert.equal(state.auditBefore, 1, '0028 不得覆盖/清理 0027 的对象（两片共存）');
  assert.equal(state.writerWritesBeforeValue, true, '0028 不得让 0027 改写的函数回退');
  note('[M] UP（0027 → 0028）：两表 / 四条索引 / 部分唯一索引 WHERE superseded=FALSE / 26+5 列 全部出现，0027 的对象仍在岗');

  // ROLLBACK
  await owner.query(readSql(DOWN));
  state = await objects();
  assert.equal(state.decisions, null, '回滚后台账表必须消失');
  assert.equal(state.withdrawals, null, '回滚后下架表必须消失');
  assert.ok(state.users && state.community && state.messages, '回滚不得动既有表');
  assert.equal(state.named, 0, '回滚后四条显式索引必须全部消失');
  assert.equal(state.auditBefore, 1, '0028 的回滚脚本不得连带拆掉 0027 的对象（回滚面只覆盖自己）');
  assert.equal(state.writerWritesBeforeValue, true, '0028 的回滚脚本不得让 0027 的函数回退');
  note('[M] ROLLBACK：本片建的两表与索引全部消失，既有表与 0027 的对象逐字仍在');

  // REPLAY
  await owner.query(readSql(`migrations/${MIGRATION}`));
  state = await objects();
  assert.equal(state.decisions, 'moderation_decisions', '重放迁移必须能再建起来');
  assert.equal(state.indexes, 6, '重放后索引计数一致');
  assert.equal(state.named, 4, '重放后四条显式索引仍在岗');
  note('[M] REPLAY：再跑一次 UP，读数与首次逐项相同');
}

// ---------------------------------------------------------------------------
// [F] 保留号台账的前向合流读数（不动真目录：在临时目录里把 0027 放进去）
// ---------------------------------------------------------------------------
// 这条臂回答的是"台账条目在上游合入后还咬不咬人"，不需要数据库：
//   1. 0027 一出现，`reservedButPresent` 立刻非空 ⇒ 保留条目必须删（防躺平）；
//   2. `count + 保留数 === max` 随之变假 ⇒ 第二条不变量同时变红（双保险，不靠单一判据）；
//   3. 计划顺序里 0027 紧邻 0028 之前 ⇒ 与合流后的真实数字序一致。
// **#434 合流后**：0027 已是真实文件、真实台账已按要求清空 ⇒ 本臂改用下面这份**夹具台账**
// （登记 27）来验证判据本身；断言逐字不动，判的是机制，不是当前台账内容。
const FIXTURE_RESERVATION = Object.freeze([{
  version: 27,
  filename: RESERVED_FILENAME,
  owner: 'PR #428（feat/gy-r28-admin-audit-observability）',
  reason: 'fixture：仅用于证明「上游合入后台账条目必须删除」这条判据仍然咬得动',
  remove_when: 'fixture：0027 落盘即删',
}]);

function forwardMergeNumbering() {
  const tmp = mkdtempSync(join(tmpdir(), 'gy-r29-migrations-'));
  try {
    // 真实目录里 0027 已在岗（合流后），这里整目录复制即可，不再需要夹具覆盖。
    // 末项取树上的真实最大号：R68 的 0048（`public.disable_admin_account` / `enable_admin_account`——
    // 后台**停用/恢复管理员账号**的唯一写入口，改的是账号与会话状态而不是审计面，与审计同事务、
    // 审计写不进去连停用一起回滚，fail-closed）、
    // 其上一条是 R64 的 0047（`public.record_admin_post_hide_audit`——后台下架 `post.hide`
    // 的审计真落库唯一写入口，与下架同一事务、审计写不进去连帖子一起回滚，fail-closed）、
    // 其上一条是 `#18` S2 收尾片的 0046（`public.record_admin_scope_denial`——scope 操作
    // 被拒时的留痕写入口，只记应用层申报、**不是**库层证明，不重核权限也不判 admin_scopes 状态）、
    // 其上一条是 S3 片 A 的 0045（`community_moderation_decisions` 增 `decided_by uuid`——
    // 人工 approve/reject 的施动者快照列，非外键、不加索引、不参与可见性判定，回滚件同名 `.down.sql`）、
    // GY-S4 P1 的 0044（第三方删除持久化：
    // `public.record_third_party_deletion(...)` / `list_third_party_deletions(uuid)` 两条窄口径 SECURITY DEFINER
    // + 只授运行时 EXECUTE + 终态不可回退的单调守卫）、R18（`#18`）的 0043（把后台「作业取消」的审计从进程内存落到库：
    // 窄口径 SECURITY DEFINER + 只授运行时 EXECUTE）、
    // GY-R37 片的 0042（`favorites`/`history` 的 `target_type` 闭集补第 17 值 `conversation_turn`）、
    // #18 S2 片1 的 0041（后台管理员 scope 唯一写路径 + 闭集约束）、GY-R35 的 0040（exports 台账 object_key 契约回填）、#22 片C 的 0039（deletion_state 增 cancelled）、
    // #19 片B 的 0038（删除回执 bearer 台账持久化）、#538 的 0036（后台内容/资料域落库）、#535 的 0035（R34 媒体行清理）、
    // #19 的 0031（在线清理证据）、#15 的 0032（举报者行级注销引用）、R34/#525 的 0033（管理端审计日志读函数）
    // 与 #19 的 0034（注销内容清理窄函数）都已在树上
    // ⇒ 目录 `0001..0048` 里只剩 0037（#14）一条是在飞缺号、已在保留台账登记，其余**无缺号**；
    //   真实台账眼下就登记着这一条（31/33/36 号三条保留条目都已按各自的 remove_when 删除）。
    // ⛔ 不要再按号段裁剪或写死末项：那会让本臂随"下一支迁移"过期，而它判的是**判据本身**。
    for (const name of readdirSync(migrationsDir)) {
      if (/^\d{4,}_[a-z0-9_]+\.sql$/.test(name)) {
        copyFileSync(new URL(name, migrationsDir), join(tmp, name));
      }
    }
    assert.equal(readdirSync(tmp).includes(RESERVED_FILENAME), true, `临时目录必须含真实 ${RESERVED_FILENAME}（否则本臂是空的）`);
    const merged = discoverMigrations(tmp);
    // 台账取「真实台账 + 夹具」：真实台账眼下只剩 0037/#14 一条在飞缺号（31/33/36 号三条保留条目
    // 都已按各自的 remove_when 删除），该号在本臂的临时目录里同样缺位、不构成"躺平" ⇒ 躺平判据仍只由夹具的 0027 触发；
    // 保留双喂形态，是为了将来再有分支登记缺号时本臂不会把"已声明缺号"误判成「未声明缺号」（发现器漏项的形态）。
    const numbering = inspectMigrationNumbering(merged, [...loadMigrationReservations(), ...FIXTURE_RESERVATION]);
    assert.deepEqual(
      numbering.reservedButPresent.map(formatMigrationVersion),
      ['0027'],
      '0027 一出现就必须被认成"保留项躺平"（否则 #428 合入后没人清理台账）',
    );
    assert.deepEqual(
      numbering.undeclaredGaps.map(formatMigrationVersion),
      [],
      '0027 补齐后不应再有任何未声明缺号（0029/#419、0031/#19、0032/#15、0033/#525、0034/#19、0035/#535、0036/#538、0038/#19片B、0039/#22片C、0040/GY-R35、0041/#18 S2 片1、0042/GY-R37 片 与 0043/#18 R18（作业取消审计落库）都已在树上；仅剩 0037 一条为 #14 的在飞缺号并已在台账登记）',
    );
    assert.equal(
      numbering.maxVersion,
      Math.max(...merged.map((migration) => Number(migration.version))),
      'maxVersion 必须等于树上真实最大版本号（不写死，避免随下一支迁移过期）',
    );
    assert.equal(
      formatMigrationVersion(numbering.maxVersion),
      '0051',
      '合流树末项是 0051（R72-W41 的 0051_moderation_idempotency.sql：审核域**持久幂等台账** public.moderation_idempotency 六列 scope/key_hash/request_hash/payload/pending/expires_at + 主键 (scope, key_hash) + moderation_idempotency_expires_idx，形制与 0026 speech_idempotency / 0024 ocr_idempotency 逐字同形；五条语句在 services/api/src/moderation/idempotency-store.ts，列级授权在 20-login-roles.sql 的 gy-r72-moderation-idempotency-grant 区、表级 DELETE 在 …-delete 独立区，90-assert 三处独立复述 + 四条零行探针 runtime_moderation_idempotency_dml_exec；⛔ 本片不接线（service.ts / app.ts 逐字未改），取消回放接线在 W42）；上一支 0050 是 R72-W2 的 0050_provider_invocations.sql：`public.provider_invocations` 是**每一次真实外发**一行的调用记录，16 列（数据字典 14 列 + created_at），`job_id` uuid 可空且**无外键**（public.jobs 全仓零 INSERT ⇒ 加 FK 会让唯一写入方无处落笔）而 `unique (job_id, attempt)` 照建、`usage` 取 jsonb（jsonb_typeof=object）、`invocation_state` 闭集 sent/send_failed/blocked、`export_id` 挂 public.exports ON DELETE CASCADE；写原语是 services/api/src/privacy/ledger-pg.ts 的 recordInvocation、唯一写点是外发口 task-egress.ts 的 ChatEgress.send、读面只有 listInvocations（⛔ 本片无 HTTP 面；⛔ 迁移本身不授权，运行时 GRANT 待批）；配对回滚 rollback/0050_provider_invocations.down.sql 先数行、有任何一行即 G0019 中止；上一支 0049 是 R68-A01 的 0049_admin_categories.sql：后台分类字典 public.admin_categories（id/type/name/description/active/revision/created_at/updated_at）从 public.crops 与 public.species 一次性回填，`ALTER TABLE … ADD COLUMN IF NOT EXISTS` 逐列补 + pg_constraint 预检后加四条 CHECK（type 闭集/name 1..120/description 1..2000/revision>=1），写面靠应用层 CAS `UPDATE … WHERE id = $1 AND revision = $2`、审计走同事务窄口径 SECURITY DEFINER 函数 record_admin_category_update(uuid,text,integer,uuid)（函数内固定 action=category.update / scope=sources:write / result=accepted、target_ref=NULL、target_hint 由形参重建，并核审计 revision 必须等于库内现值）；20-login-roles.sql 段 gy-r68-catalog-grant 按列授 SELECT 6 / UPDATE 5、无 INSERT/DELETE、函数只授运行时 EXECUTE；配对回滚 rollback/0049_admin_categories.down.sql 先数 category.update 审计行与 revision>1 的目录行，>0 即 G0019 中止；上一支 0048 是 R68 的 0048_admin_account_disable.sql：后台**停用/恢复管理员账号**的唯一写入口 disable_admin_account(uuid,uuid,uuid,integer,uuid,text) / enable_admin_account(同形)，窄口径 SECURITY DEFINER + SET search_path=pg_catalog + SET TimeZone=UTC + REVOKE ALL … FROM PUBLIC + 只授运行时 EXECUTE；锁序先拿 0041 同一把事务级 `pg_advisory_xact_lock(hashtextextended(\'admin_scope:\' || \'scopes:write\', 18040))` 再对 admin_accounts 行 FOR UPDATE；停用写 state=suspended + auth_epoch+1 + revision+1（CAS）并同事务把 admin_sessions 的 live 行置 revoked_at，审计行 action 固定 admin_account.disable、before_value/after_value 为 NULL；停用自己 ⇒ G0020 SELF_DISABLE_DENIED、停用唯一持 scopes:write 的管理员 ⇒ G0009（与 0041 同一个码），停用与审计**同一事务** ⇒ 审计写不进去连停用一起 ROLLBACK（fail-closed）；配对回滚 rollback/0048_admin_account_disable.down.sql 只 DROP FUNCTION、⛔ 不删审计行；上一支 0047 是 R64 的 0047_admin_post_hide_audit.sql：后台下架 `post.hide` 的审计**真落库**唯一写入口 record_admin_post_hide_audit(uuid,uuid,integer,text,uuid)，窄口径 SECURITY DEFINER + REVOKE ALL … FROM PUBLIC + 只授运行时 EXECUTE，action/scope/result 由函数体字面量固定、target_ref 由形参重建（调用方伪造不了），下架与审计**同一事务** ⇒ 审计写不进去连帖子一起 ROLLBACK（fail-closed）；配对回滚 rollback/0047_admin_post_hide_audit.down.sql 只删函数；上一支 0046 是 #18 S2 收尾片的 0046_admin_scope_denial_trace.sql：后台 scope 操作**被拒**时的留痕唯一写入口 record_admin_scope_denial(uuid,uuid,text,text,uuid,uuid)，窄口径 SECURITY DEFINER + REVOKE ALL … FROM PUBLIC + 只授运行时 EXECUTE，scope 走后台权限 13 项闭集、reason_code 走四值闭集（self_scope_grant_denied / last_scope_manager / scope_denied / scope_not_held），且刻意只核 actor 存在、不核 active、不核是否持 scopes:write；上一支 0045 是 S3 片 A 的 0045_community_post_review_actor.sql，给 community_moderation_decisions 增 decided_by uuid——人工 approve/reject 的施动者快照列，非外键、不加索引、不参与可见性判定，回滚件同名 .down.sql；0044 是 #18 S4 片的 0044_third_party_deletion_persistence.sql，第三方删除持久化：record_third_party_deletion / list_third_party_deletions 两条 SECURITY DEFINER 函数 + 状态闭集 requested/confirmed/failed/unsupported + 终态不可回退的单调守卫，表本身只授运行时 EXECUTE；0043 是 #18 R18 片的 0043_admin_job_cancel_audit.sql，把后台「作业取消」审计从进程内存落到库：窄口径 SECURITY DEFINER 函数 record_admin_job_cancel_audit + REVOKE PUBLIC + 只授运行时 EXECUTE，回滚件 G0016；0042 是 GY-R37 片的 0042_favorites_history_target_type_conversation_turn.sql，`favorites`/`history` 的 `target_type` 闭集补第 17 值 `conversation_turn`；0041 是 #18 S2 片1 库层的 0041_admin_scope_write_authority.sql，后台管理员 scope 的唯一写路径 + 闭集约束；0040 是 GY-R35 的 0040_export_object_key_contract_backfill.sql，exports 台账 object_key 按契约回填 + 收 80；0039 是 #22 片C 的 deletion_state 增 cancelled；0038 是 #19 片B 的删除回执 bearer 台账持久化、0036 是 #538 的后台内容/资料域落库、0035 是 #535 的 R34 媒体行清理、0031 是 #19 的在线清理证据、0032 是 #15 的举报者行级注销引用、0033 是 R34/#525 的管理端审计日志读函数、0034 是 #19 的注销内容清理窄函数，均已在树上；仅 0037=#14 为保留号）；若这里变了，说明又落了新迁移，请复核本臂',
    );
    assert.equal(
      numbering.countMatchesMax,
      false,
      `count(${numbering.count}) + 保留(${numbering.reserved.length}) = ${numbering.count + numbering.reserved.length} ≠ max(${numbering.maxVersion}) ⇒ 第二条不变量必须同时判红`,
    );
    const order = merged.map((migration) => migration.filename);
    const at27 = order.indexOf(RESERVED_FILENAME);
    const at28 = order.indexOf(MIGRATION);
    assert.ok(at27 >= 0 && at28 === at27 + 1, `0027 必须紧邻 0028 之前（现场 at27=${at27} at28=${at28}）`);
    note('[F] 保留号躺平判据回归：真实目录已含 0027 + 夹具台账登记 27 ⇒ 条目被判必须删除（reservedButPresent=[0027]，count＋保留≠max），且数字序为 0027 → 0028');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// [W] 写穿透 / [S] supersede / [V] 多版本 / [U] 更新 / [X] 下架
// ---------------------------------------------------------------------------
async function writeThrough() {
  const ledger = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  const first = record();
  ledger.create(first);
  await ledger.flush();

  const row = await one(
    `SELECT job_id, target_type, target_id, target_revision, content_kind, state, decision,
            reason_codes, hard_rule_passed, rule_version, model_version, superseded
       FROM public.moderation_decisions WHERE job_id = $1::uuid`,
    [first.job_id],
  );
  assert.ok(row !== undefined, 'create + flush 后台账行必须真的在库里');
  assert.equal(row.target_id, TARGET.id);
  assert.equal(Number(row.target_revision), TARGET.revision);
  assert.equal(row.content_kind, 'text');
  assert.equal(row.state, 'succeeded');
  assert.equal(row.decision, 'approved');
  assert.deepEqual(row.reason_codes, [], 'jsonb 数组必须落成 JSON 数组而不是字符串');
  assert.equal(row.superseded, false);
  assert.equal(row.model_version, 'synthetic-tms-model@1.0', '模型版本必须可追溯');
  note(`[W] 写穿透：job ${first.job_id} 在库里，state=succeeded decision=approved superseded=false`);

  assert.throws(() => ledger.create(record({ job_id: first.job_id })), /审核任务 job_id 重复/u);
  await ledger.flush();
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.moderation_decisions WHERE job_id = $1::uuid', [first.job_id]),
    1,
    '重复 job_id 不得在库里产生第二行',
  );
  note('[W] 幂等：重复 job_id 同步抛错，库里仍是 1 行');

  // [S] supersede
  const second = record({ model_version: 'synthetic-tms-model@2.0' });
  ledger.create(second);
  await ledger.flush();
  const current = await q(
    'SELECT job_id, superseded FROM public.moderation_decisions WHERE target_id = $1::text ORDER BY created_at, job_id',
    [TARGET.id],
  );
  assert.equal(current.length, 2, '旧任务进历史，不删');
  assert.equal(
    await countOf(
      'SELECT count(*)::int AS v FROM public.moderation_decisions WHERE target_id = $1::text AND superseded = FALSE',
      [TARGET.id],
    ),
    1,
    '当前行恒 1 条（部分唯一索引的直接读数）',
  );
  assert.equal(ledger.current(TARGET, 'text')?.job_id, second.job_id);
  note('[S] supersede：同目标版本两行历史、当前行 1 条、内存 current 指向新任务');

  // [V] 多版本共存
  const v2 = { type: 'post', id: TARGET.id, revision: 2 };
  ledger.create(record({ target_ref: v2, job_id: randomUUID() }));
  await ledger.flush();
  assert.equal(
    await countOf(
      'SELECT count(*)::int AS v FROM public.moderation_decisions WHERE target_id = $1::text AND superseded = FALSE',
      [TARGET.id],
    ),
    2,
    'r1 与 r2 各自的当前行可以并存（唯一性按 revision 分桶）',
  );
  note('[V] 多版本：同目标 r1/r2 各一条当前任务并存');

  // [U] 更新
  const settled = { ...ledger.byJobId(second.job_id), state: 'succeeded', decision: 'rejected', reason_codes: ['MODEL_REJECTED'], updated_at: TS };
  ledger.update(settled);
  await ledger.flush();
  const updated = await one(
    'SELECT state, decision, reason_codes, target_type, target_id, target_revision FROM public.moderation_decisions WHERE job_id = $1::uuid',
    [second.job_id],
  );
  assert.equal(updated.decision, 'rejected');
  assert.deepEqual(updated.reason_codes, ['MODEL_REJECTED']);
  assert.equal(updated.target_id, TARGET.id, '更新不得改写目标身份列');
  assert.equal(Number(updated.target_revision), 1);
  note('[U] 更新：结论与理由码落到同一行，目标身份列逐字不变');

  // [X] 下架幂等
  ledger.markWithdrawn(TARGET);
  ledger.markWithdrawn(TARGET);
  await ledger.flush();
  assert.equal(
    await countOf(
      'SELECT count(*)::int AS v FROM public.moderation_withdrawals WHERE target_id = $1::text AND target_revision = 1',
      [TARGET.id],
    ),
    1,
    '重放下架不得新增行',
  );
  assert.equal(ledger.isWithdrawn(TARGET), true);
  note('[X] 下架：两次 markWithdrawn ⇒ 库里恰好 1 行，isWithdrawn=true');
}

// ---------------------------------------------------------------------------
// [H] 下架集合**回填**（W43）：新实例（≈ 重启后的进程）能把库里的下架行读回内存
// ---------------------------------------------------------------------------
// 为什么这条臂必须在真库上判：缺陷不是"函数少写了一行"，而是**内存集合是进程私有的**。
// 单测用假池只能证明"SELECT 发出去了、行搬进去了"，证明不了"另一条连接上真能读到那一行"。
// 这里让实例 A 下架并落库、再**另起**实例 B（内存台账全新），B 不回填的话 `isWithdrawn` 必答 false ——
// 而 `service.ts:939`（发布前 TARGET_WITHDRAWN）与 `:1287`（旧回调 CALLBACK_TARGET_WITHDRAWN）
// 都只问它，于是旧回调能把已下架的版本翻回 published。B 的 true 就是"这条复活路径被堵死"的读数。
async function withdrawReadback() {
  const target = { type: 'post', id: randomUUID(), revision: 1 };
  const untouched = { type: 'post', id: randomUUID(), revision: 1 };

  // 实例 A：只下架、只落库（不依赖任何回填）。
  const a = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  assert.equal(a.withdrawalsHydrated, false, '惰性：构造时还没回填');
  a.markWithdrawn(target);
  await a.flush();
  assert.equal(a.isWithdrawn(target), true, 'A 自己记得（内存集合）');
  assert.equal(a.withdrawalsHydrated, true, 'A 的 flush 必须先回填');
  assert.equal(
    await countOf(
      'SELECT count(*)::int AS v FROM public.moderation_withdrawals WHERE target_id = $1::text AND target_revision = $2::int',
      [target.id, target.revision],
    ),
    1,
    '下架行必须真的在库里（回填读的就是这张表）',
  );
  const total = await countOf('SELECT count(*)::int AS v FROM public.moderation_withdrawals');
  note(`[H] 实例 A：markWithdrawn + flush ⇒ 库里 ${total} 行下架记录（本目标 1 行）`);

  // 实例 B：全新实例 = 重启后的进程，内存台账什么都没有。
  const b = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  assert.equal(b.isWithdrawn(target), false, '回填前 B 不记得（这正是被修的缺陷现场）');
  assert.equal(b.withdrawalsHydrated, false);
  await b.hydrate();
  assert.equal(b.withdrawalsHydrated, true, 'hydrate() 成功后必须声称已回填');
  assert.equal(b.isWithdrawn(target), true, '核心读数：另一条连接上的下架行必须能被 B 答出来');
  assert.equal(b.isWithdrawn(untouched), false, '没下架过的目标不得被回填误伤');
  assert.equal(b.snapshotCounts().withdrawn, total, `B 的 withdrawn 读数应等于库里下架行数（现场 ${total}）`);
  note(`[H] 实例 B：hydrate() ⇒ isWithdrawn(已下架)=true、isWithdrawn(未下架)=false、snapshotCounts().withdrawn=${total}`);

  // 实例 C：只走 `flush()`（service.ts 的真实路径，`flushLedger()` 只调 flush，从不显式调 hydrate）。
  const c = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  await c.flush();
  assert.equal(c.withdrawalsHydrated, true, 'flush 必须自己先把回填做完（否则闸门读到的是空集合）');
  assert.equal(c.isWithdrawn(target), true, '只 flush 一次也要读回下架行');
  note('[H] 实例 C：只 flush 不显式 hydrate ⇒ 下架集合同样就位（service.ts 的 flushLedger 路径）');
}

// ---------------------------------------------------------------------------
// [C] 并发：两个台账实例同时建同一目标版本
// ---------------------------------------------------------------------------
async function concurrent() {
  const target = { type: 'post', id: randomUUID(), revision: 1 };
  const left = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  const right = createPostgresModerationLedger({ pool, now: () => new Date(TS) });
  left.create(record({ target_ref: target }));
  right.create(record({ target_ref: target }));

  const outcomes = await Promise.allSettled([left.flush(), right.flush()]);
  const rejected = outcomes.filter((item) => item.status === 'rejected');
  for (const item of rejected) {
    assert.ok(
      item.reason?.code === 'PROVIDER_UNAVAILABLE' || item.reason?.code === 'PROVIDER_TIMEOUT',
      `并发冲突必须折算成 PROVIDER_*（现场：${item.reason?.code ?? item.reason}）`,
    );
  }
  const current = await countOf(
    'SELECT count(*)::int AS v FROM public.moderation_decisions WHERE target_id = $1::text AND superseded = FALSE',
    [target.id],
  );
  const total = await countOf('SELECT count(*)::int AS v FROM public.moderation_decisions WHERE target_id = $1::text', [target.id]);
  assert.equal(current, 1, '并发建同一目标版本后，当前结论必须恰好 1 条（数据库判定）');
  assert.ok(total >= 1 && total <= 2, `总行数落在 1..2（现场 ${total}）`);
  note(`[C] 并发：两个实例同时建同一目标版本 ⇒ 当前行 1 条、总行 ${total}、被拒 ${rejected.length} 次（均为 PROVIDER_*）`);
}

// ---------------------------------------------------------------------------
// [R] real 模式即便本表在场也 fail-closed
// ---------------------------------------------------------------------------
async function realModeFailClosed() {
  const before = await countOf('SELECT count(*)::int AS v FROM public.moderation_decisions');
  const config = { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), executionMode: 'real' };
  const app = buildApp({ config, pool, now: () => new Date(TS) });
  let code = null;
  try {
    await app.moderationService.submitScreening({
      actor: ACTOR,
      content: { target_ref: { type: 'post', id: randomUUID(), revision: 1 }, text: '干净正文，无违规内容。', media: [] },
    });
  } catch (error) {
    code = error?.code ?? null;
  }
  await app.close();
  assert.equal(code, 'PROVIDER_UNAVAILABLE', `real 模式必须整域 fail-closed（现场 ${code}）`);
  const after = await countOf('SELECT count(*)::int AS v FROM public.moderation_decisions');
  assert.equal(after, before, 'real 模式下不许有任何台账行被写进来（不伪造成功封套）');
  note(`[R] real 模式：submitScreening ⇒ PROVIDER_UNAVAILABLE，台账行数前后都是 ${before}（零写入）`);
}

// ---------------------------------------------------------------------------
// [I] 审核域持久幂等台账（迁移 0051 / R72-W41）：表形制 + 五条语句的真库读数
//
// 本片**不接线**（service.ts / app.ts 逐字未改），所以这一节判的是「表 + 存储层」两层事实，
// 而不是「取消端点会不会回放」——那是 W42 的事。判据写死到列名/约束名，是为了让 0051 与
// 0026（speech_idempotency）/0024（ocr_idempotency）这种**逐字同形**的形制一旦漂移就当场红。
// ---------------------------------------------------------------------------
const IDEM_MIGRATION = '0051_moderation_idempotency.sql';
const IDEM_DOWN = `migrations/rollback/${IDEM_MIGRATION.replace(/\.sql$/, '.down.sql')}`;

async function moderationIdempotency() {
  await owner.query(readSql(`migrations/${IDEM_MIGRATION}`));

  const columns = (
    await q(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'moderation_idempotency'
        ORDER BY ordinal_position`,
    )
  ).map((row) => `${row.column_name}:${row.data_type}:${row.is_nullable}`);
  assert.deepEqual(
    columns,
    [
      'scope:character varying:NO',
      'key_hash:character varying:NO',
      'request_hash:character varying:NO',
      'payload:jsonb:NO',
      'pending:boolean:NO',
      'expires_at:timestamp with time zone:NO',
    ],
    `0051 必须建出六列且与 0026/0024 的幂等台账逐字同形（现场 ${JSON.stringify(columns)}）`,
  );
  assert.equal(
    await countOf(
      `SELECT count(*)::int AS v FROM pg_constraint
        WHERE conrelid = 'public.moderation_idempotency'::regclass
          AND contype = 'p'
          AND pg_get_constraintdef(oid) = 'PRIMARY KEY (scope, key_hash)'`,
    ),
    1,
    '主键必须是 (scope, key_hash)：claim 的 `ON CONFLICT (scope, key_hash)` 冲突目标就是它',
  );
  assert.equal(
    await countOf(
      `SELECT count(*)::int AS v FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'moderation_idempotency'
          AND indexname = 'moderation_idempotency_expires_idx'`,
    ),
    1,
    '过期清理扫描（purgeIdempotent）必须有 moderation_idempotency_expires_idx',
  );
  note('[I] 0051 建表：六列 / 主键 (scope, key_hash) / moderation_idempotency_expires_idx 全部在岗');

  const store = createPgModerationIdempotencyStore({ pool });
  const scope = `user:${randomUUID()}\nPOST\n/moderation/jobs/${randomUUID()}/cancel`;
  const keyHash = 'b'.repeat(64);
  const firstExpiry = new Date('2026-10-22T05:00:00.000Z');
  const payload = { job_id: randomUUID(), state: 'cancelled', revision: 3 };
  const at = new Date(TS);

  assert.equal(
    await store.claimIdempotent(
      scope,
      keyHash,
      { scope, keyHash, requestHash: 'req-1', payload, pending: true, expiresAt: firstExpiry },
      at,
    ),
    'claimed',
    '首次 claim 必须抢到（INSERT 一路）',
  );
  await store.finalizeIdempotent(scope, keyHash, payload);
  const found = await store.findIdempotent(scope, keyHash);
  assert.deepEqual(
    { requestHash: found?.requestHash, payload: found?.payload, pending: found?.pending },
    { requestHash: 'req-1', payload, pending: false },
    'claim → finalize → find 必须把 payload 逐字取回（jsonb 往返不掉键）',
  );
  note('[I] claim → finalize → find：request_hash=req-1 / pending=false / payload 三键 deepEqual');

  assert.equal(
    await store.claimIdempotent(
      scope,
      keyHash,
      {
        scope,
        keyHash,
        requestHash: 'req-2',
        payload: { poisoned: true },
        pending: false,
        expiresAt: new Date('2026-10-23T00:00:00.000Z'),
      },
      at,
    ),
    'exists',
    '同键未过期再 claim ⇒ exists（那条 `WHERE … expires_at <= $7` 不该命中）',
  );
  const stillThere = await store.findIdempotent(scope, keyHash);
  assert.deepEqual(stillThere?.payload, payload, 'exists 分支不得覆盖既有 payload');
  assert.equal(stillThere?.requestHash, 'req-1', 'exists 分支不得把新请求的 request_hash 写进去（409 由调用方判）');
  note('[I] 同键再 claim ⇒ exists：库里仍是 req-1 的 payload（未被 req-2 覆盖）');

  // 就地重占：把行改成**已过期**（不删、不 purge），claim 必须抢到同一行。
  await owner.query('UPDATE public.moderation_idempotency SET expires_at = $1::timestamptz WHERE scope = $2', [
    '2026-10-21T00:00:00.000Z',
    scope,
  ]);
  assert.equal(
    await store.claimIdempotent(
      scope,
      keyHash,
      {
        scope,
        keyHash,
        requestHash: 'req-3',
        payload: { reclaimed: true },
        pending: true,
        expiresAt: new Date('2026-10-24T00:00:00.000Z'),
      },
      at,
    ),
    'claimed',
    '已过期行必须被就地重占（`WHERE public.moderation_idempotency.expires_at <= $7` 的唯一用途）',
  );
  note('[I] 过期行就地重占：claim ⇒ claimed（req-3 替换 req-1，行数仍是 1）');

  const rowsBeforePurge = await countOf('SELECT count(*)::int AS v FROM public.moderation_idempotency');
  assert.equal(rowsBeforePurge, 1, `purge 前表里应恰好 1 行（现场 ${rowsBeforePurge}）`);
  assert.equal(
    await store.purgeIdempotent(new Date('2030-01-01T00:00:00.000Z')),
    rowsBeforePurge,
    'purgeIdempotent 的返回值必须是**删掉的行数**（与 purge 前总行数对齐）',
  );
  assert.equal(
    await countOf('SELECT count(*)::int AS v FROM public.moderation_idempotency'),
    0,
    'purgeIdempotent(未来时刻) 之后表里必须 0 行（物理删除，不是软删）',
  );
  note('[I] purgeIdempotent(未来时刻) ⇒ 删除 1 行、表里 0 行');

  await owner.query(readSql(IDEM_DOWN));
  const afterDown = await one("SELECT to_regclass('public.moderation_idempotency') AS o");
  assert.equal(afterDown.o, null, '配对回滚必须能整表拆除（索引随表消失）');
  note('[I] 配对回滚：0051 的表整表拆除（expires_idx 随表消失）');
}

// ---------------------------------------------------------------------------
forwardMergeNumbering();
await migrationTriple();
await writeThrough();
await withdrawReadback();
await concurrent();
await realModeFailClosed();
await moderationIdempotency();

await owner.end();
await pool.end();
note('[√] ALL PASS');
