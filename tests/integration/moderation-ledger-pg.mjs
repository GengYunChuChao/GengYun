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
//   [M] 迁移三连：清单结构不变量 ⇒ UP（两表/四条索引/部分唯一索引出现，列数 26 与 5）⇒
//       ROLLBACK（本片对象消失，`users` 与社区/消息表逐字仍在）⇒ REPLAY（再出现）。
//   [W] 写穿透：`create` + `flush` ⇒ 台账行真的在库里（列值与内存台账逐字段相等）；
//       同 `job_id` 再 `create` ⇒ 同步抛错且库里仍是 1 行。
//   [S] supersede：同目标版本再建任务 ⇒ 旧行 `superseded=true`、新行 `false`，当前行恒 1 条。
//   [V] 多版本共存：同目标不同 revision ⇒ 两行都 `superseded=false`（唯一性是**按 revision** 的）。
//   [U] 更新：状态/结论推进落到同一行；目标身份列（`target_type/target_id/target_revision`）逐字不变。
//   [X] 下架幂等：两次 `markWithdrawn` ⇒ `moderation_withdrawals` 恰好 1 行。
//   [C] 并发：两个台账实例同时建同一目标版本的任务 ⇒ 当前行恒 1 条（数据库判定，不是应用判定）。
//   [R] real 模式即便本表在场也 fail-closed：`submitScreening` 拒绝且**零行**落库
//       （不许为了让真库臂变绿伪造 published 写入）。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createPostgresModerationLedger } from '../../services/api/src/moderation/ledger-pg.ts';

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
// [M] 迁移三连
// ---------------------------------------------------------------------------
async function migrationTriple() {
  const discovered = readdirSync(migrationsDir)
    .filter((name) => /^\d{4,}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  assert.ok(discovered.includes(MIGRATION), `迁移清单必须含 ${MIGRATION}`);
  const versions = discovered.map((name) => Number(name.slice(0, 4)));
  for (let index = 1; index < versions.length; index += 1) {
    assert.ok(versions[index - 1] < versions[index], `版本号必须严格递增（现场：${versions.join(',')}）`);
  }
  note(`[M] 迁移清单 ${discovered.length} 个，版本号严格递增，末项 ${String(versions[versions.length - 1]).padStart(4, '0')}`);

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
  });

  for (const name of discovered) {
    if (name === MIGRATION) continue;
    await owner.query(readSql(`migrations/${name}`));
  }
  let state = await objects();
  assert.equal(state.decisions, null, '应用其它迁移后本片建的表必须还不存在（证明 UP 才是它出现的唯一原因）');
  assert.equal(state.withdrawals, null, '下架表同理');

  // UP
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
  note('[M] UP：两表 / 四条索引 / 部分唯一索引 WHERE superseded=FALSE / 26+5 列 全部出现');

  // ROLLBACK
  await owner.query(readSql(DOWN));
  state = await objects();
  assert.equal(state.decisions, null, '回滚后台账表必须消失');
  assert.equal(state.withdrawals, null, '回滚后下架表必须消失');
  assert.ok(state.users && state.community && state.messages, '回滚不得动既有表');
  assert.equal(state.named, 0, '回滚后四条显式索引必须全部消失');
  note('[M] ROLLBACK：本片建的两表与索引全部消失，既有表逐字仍在');

  // REPLAY
  await owner.query(readSql(`migrations/${MIGRATION}`));
  state = await objects();
  assert.equal(state.decisions, 'moderation_decisions', '重放迁移必须能再建起来');
  assert.equal(state.indexes, 6, '重放后索引计数一致');
  assert.equal(state.named, 4, '重放后四条显式索引仍在岗');
  note('[M] REPLAY：再跑一次 UP，读数与首次逐项相同');
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
await migrationTriple();
await writeThrough();
await concurrent();
await realModeFailClosed();

await owner.end();
await pool.end();
note('[√] ALL PASS');
