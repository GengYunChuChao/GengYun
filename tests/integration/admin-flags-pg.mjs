/**
 * GY-I18（#18）· `feature_flags` 持久化真库验收（迁移 `0020_feature_flags.sql`）。
 *
 * 口径来源：`.pg17/ruling-feature-flags-persistence-20261018.md` §1/§3/§4。
 *
 * 跑法（便携 PG 17.11，回环地址，库名硬钉）：
 *   createdb -h 127.0.0.1 -p <port> gengyun_flags_test
 *   node tests/integration/admin-flags-pg.mjs \
 *     postgres://postgres@127.0.0.1:<port>/gengyun_flags_test \
 *     postgres://gengyun_api_runtime:<pw>@127.0.0.1:<port>/gengyun_flags_test
 *
 * 第二个参数（运行时角色 URL）可省略：省略时读面/写面仍以 owner 跑通（[M][A][B][C][D]），
 * 但最小权限反向控制（[P]）与真实 HTTP 装配（[E][F]）记为「未取得」。
 *
 * 角色口径（与 `admin-jobs-pg.mjs` 的 #428 收口同族）：角色与口令落在**集群级** `pg_authid`，硬钉库名只护住
 * 「库」、护不住「角色身份」——同集群别的库里复用该角色的既有客户端会在新连接时认证失败，而收尾只按
 * `pg_roles` 差集 DROP 本轮新建的角色，不会把既有的口令/LOGIN 位回滚。因此本臂**只允许动自己本轮新建的角色**：
 *   - 默认路径（省略 argv[3]）在任何写库动作之前先跑 `preflightRuntimeRole`：发现 `gengyun_api_runtime`
 *     已在本集群存在 ⇒ 硬失败（exit 1），⛔ 不再 `ALTER ROLE … LOGIN PASSWORD '<随机>'` 接管它；
 *   - `provisionRoles()` 只 `CREATE ROLE`（建之前断言此刻角色必不存在），角色由收尾按 `pg_roles` 差集
 *     DROP 回原状；
 *   - 要复用既有测试角色必须用 argv[3] 显式给出它的**既有**凭据，本臂对该角色零 DDL
 *     （不 CREATE / 不 ALTER / 不改 LOGIN / 不改口令）；
 *   - 收尾用 `checkRoleCredentials` 复读 `pg_authid`，给出「既有角色（含别的业务角色）的认证材料一字不差」的
 *     负控制读数；失败路径也打印读数（strict=false 只打印不抛，⛔ 不冒充通过）。
 *
 * 覆盖（裁定 §4 的 ①–⑥）：
 *   [M] 迁移三连：UP → 三行全 false/revision=1 → DOWN（函数与表消失、审计表不越界）→ REPLAY
 *   [A] 表结构（闭集 CHECK / revision CHECK / changed_by FK 指向 admin_accounts）
 *   [P] 运行时角色：feature_flags 只可 SELECT；直接写/改/删/DDL 与审计读一律 42501；函数可 EXECUTE
 *   [B] 正常 commit：revision+1、changed_by/reason 落库、changed_at 变、审计恰 1 行（固定口径）
 *   [C] 陈旧 revision ⇒ ok:false REVISION_CONFLICT，行与审计都不变
 *   [D] 并发两笔同 revision ⇒ 恰一笔成功、一笔冲突、审计恰 1 行
 *   [E] 真实 HTTP：listFlags/PUT/If-Match 409/值未变短路/`/herbicides` 关→409 开→恢复 + 并发 PUT
 *   [F] `pool === null` 的 real 装配与今天逐字相同：后台 503 fail-closed、开关门不 armed
 *   [G] 武装就绪探测（T-R12-08R / #282）：只应用迁移子集的库（没有 0020 的表）⇒ 探测 **missing**
 *       （to_regclass IS NULL，**确认**缺表）、门不武装、`/herbicides` 200 —— 与 CI 里
 *       `egress-ledger-pg.mjs:322` 修好后的 202 同一机制；
 *       同一库补齐全部迁移 ⇒ 探测 ready、门武装、默认 false ⇒ 409 OBJECT_UNAVAILABLE(FLAG_CLOSED)。
 *       #282 补的一句：**探测异常/读不懂必须是 `unknown`（保持武装 + fail-closed），不得退成
 *       `missing`（未武装 ⇒ 放行）** —— 旧实现把两者折叠成一个 `false`，一次连接/权限抖动就会
 *       让已接真实端口的门永久放行受控面。
 *   [H] 行锁的行为分量（证伪 `SELECT … FOR UPDATE`）：外部会话持行锁 + 端口「值未变」短路
 *       ⇒ 等锁 ≥3000ms 后 504 PROVIDER_TIMEOUT(retryable:true)；删掉 FOR UPDATE 则数毫秒返回成功，
 *       耗时下界断言必红。HTTP 的 PUT 到不了这里（service 层「值未变」在端口之前就返回 200）。
 *   [I] 开关**真库端到端**（#18「真实生效」的产出面证据，不是读面回显）：先显式 PUT 开启（revision 从读面取，
 *       不假设种子）⇒ `POST /posts` 201 且 `community_posts` 恰 +1 行；再 PUT 关闭 ⇒ 同一路由 409
 *       OBJECT_UNAVAILABLE（details 带 FLAG_CLOSED）且内容表**零新增**；重开 ⇒ 同一进程、无重启、无缓存等待
 *       立刻再投 201；未登录仍 401 `SESSION_REQUIRED` 且响应不泄露 FLAG_CLOSED（鉴权先于开关）；
 *       每次切换 `admin_audit_events` **恰 1 行**（action=set_flag / scope=flags:write）。
 *
 * 说明：[M] 段**不再断言**「迁移目录的最大号是几」——那是**随 main 前进就会变假的时点事实**
 * （旧写法写死 `0020`，main 的迁移走到 `0023` 后该断言必红，且没有任何门禁会跑到它）。
 * 现在锁的是恒成立的结构不变量：目录原始扫描出的 `*.sql` 集合必须与 `discoverMigrations()`
 * 发现的集合**逐项相等**（发现器不漏项／不多项），再核对 `0020` 确实被迁移器发现
 * （本脚本随后要原样执行它）。缺号连续性由 `tests/integration/migrations-negative-pg.mjs` 覆盖，本脚本不重复。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createPool } from '../../services/api/src/db/pool.ts';
import { discoverMigrations } from '../../services/api/src/db/migrate.ts';
import { createMemoryAuthStore, createPostgresAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { createPostgresFeatureFlags } from '../../services/api/src/admin/ops/flags-pg.ts';
import { CONTRACT_FLAG_KEYS } from '../../services/api/src/admin/ops/flags.ts';
// GY-I18 新臂 [I]：投稿面 `public_posting` 授权闸的**合成授权夹具**（与 `community-pg.mjs` /
// `moderation-full-chain-pg.mjs` 同一份，避免两套授权口径）。注入的是**前置授权**，不是被验证对象。
import { createPublicPostingConsent } from '../unit/community-posting-consent-fixtures.mjs';
// GY-I18 新臂 [I]：规则层（发布前内容筛查）的**确定性闸门夹具**（与 `community-pg.mjs:891` /
// `moderation-full-chain-pg.mjs:274` 同一份）。规则层缺省按 **50ms 墙钟**预算判超时
// （`services/api/src/conversations/screen.ts:127-128`），CI 机器负载高时会把干净的投稿抖成
// 422 INPUT_UNCERTAIN(RULE_TIMEOUT)；`makeGate()` 冻结时钟（`tests/unit/community-fixtures.mjs:59`
// `FROZEN_CLOCK = () => 0`）⇒ 本臂断言的「开关控制产出面」不再被无关的规则层时延抖动污染。
// 注入的是**规则层**闸，被验证的开关门（`createFeatureFlagGate`）仍是真库真端口。
import { makeGate } from '../unit/community-fixtures.mjs';

const API = '/api/v1';
const DB = 'gengyun_flags_test';
const MIGRATION = '0020_feature_flags.sql';
const DOWN = 'migrations/rollback/0020_feature_flags.down.sql';
const FUNCTION_SIGNATURE = 'public.set_feature_flag(text,integer,boolean,uuid,uuid,uuid,text,text)';
const RUNTIME_ROLE = 'gengyun_api_runtime';
const GRANT_REGION = 'gy-i18-flags-grant';
/** 集群级角色认证材料（`pg_authid` 仅超管可读；读不到时记「未取得」，不冒充通过）。 */
const ROLE_FINGERPRINT_SQL =
  "SELECT rolname, rolcanlogin, rolvaliduntil, rolpassword FROM pg_authid WHERE rolname !~ '^pg_' ORDER BY rolname";
/** 指纹口径：LOGIN 位 / 口令哈希 / 到期时间，任一变化都算「这个角色的身份被改过」。 */
const roleFingerprint = (row) => JSON.stringify([row.rolcanlogin, row.rolvaliduntil ?? null, row.rolpassword ?? null]);

const ownerUrl = new URL(process.argv[2] ?? `postgres://postgres@127.0.0.1:5432/${DB}`);
assert.equal(ownerUrl.hostname, '127.0.0.1', '本测试只允许回环地址');
assert.equal(ownerUrl.pathname, `/${DB}`, `库名必须硬钉为 ${DB}（防误连）`);
const runtimeArg = process.argv[3];
const providedRuntimeUrl = runtimeArg === undefined ? null : new URL(runtimeArg);
if (providedRuntimeUrl !== null) {
  assert.equal(providedRuntimeUrl.hostname, '127.0.0.1', '运行时 URL 也只允许回环地址');
  assert.equal(providedRuntimeUrl.pathname, `/${DB}`, '运行时 URL 必须连同一个硬钉库');
  assert.equal(decodeURIComponent(providedRuntimeUrl.username), RUNTIME_ROLE, `运行时 URL 的用户必须是 ${RUNTIME_ROLE}`);
}
/** 未给 argv[3] 时，脚本自己建运行时角色并派生 URL（密码只在本进程内存里，落盘即一次性集群）。 */
const runtimePassword = randomBytes(24).toString('hex');
let runtimeUrl = providedRuntimeUrl;

const notes = [];
function note(line) {
  notes.push(line);
  console.log(line);
}
const unread = (label, why) => note(`未取得 ${label}：${why}`);

const readSql = (rel) => readFileSync(new URL(`../../services/api/db/${rel}`, import.meta.url), 'utf8');
const deploySql = (name) => readFileSync(new URL(`../../deploy/postgres-cvm/sql/${name}`, import.meta.url), 'utf8');
const migrationsDir = new URL('../../services/api/db/migrations/', import.meta.url);

const owner = new pg.Client({ connectionString: ownerUrl.href });
/** 建过但未关闭的 app / pool：不关会让 node 进程挂着不退出。 */
const registeredApps = [];
const registeredPools = [];

await owner.connect();
const baselineRoles = new Set((await owner.query('SELECT rolname FROM pg_roles')).rows.map((row) => row.rolname));
/**
 * 既有角色认证材料快照。角色与其口令是**集群级**对象：同一个 `gengyun_api_runtime` 完全可能同时被别的库的
 * 客户端用来登录，硬钉库名只护住「库」、护不住「角色身份」。所以本臂只允许动自己本轮新建的角色，
 * 收尾前逐项比对这份快照（`checkRoleCredentials`）。
 */
let baselineCredentials = null;
try {
  baselineCredentials = new Map(
    (await owner.query(ROLE_FINGERPRINT_SQL)).rows.map((row) => [row.rolname, roleFingerprint(row)]),
  );
} catch (error) {
  unread('[P] 既有角色认证材料快照', `owner 连接读不到 pg_authid（${error.code ?? error.message}），本轮不作「别的角色密码未被改动」比对`);
}
const ownerPool = new pg.Pool({ connectionString: ownerUrl.href });
registeredPools.push(ownerPool);
const seedStore = createPostgresAuthStore({ query: (text, params) => ownerPool.query(text, params) });

const q = async (text, params = []) => (await owner.query(text, params)).rows;
const one = async (text, params = []) => (await q(text, params))[0];

const keyOf = (row) => `${row.key}`;
const assertContractOrder = (items) =>
  assert.deepEqual(items.map(keyOf), [...CONTRACT_FLAG_KEYS], '开关必须按契约声明序输出（submissions → specific_herbicide → ai）');

// ---------------------------------------------------------------------------
// [M] 迁移三连
// ---------------------------------------------------------------------------
async function migrationTriple() {
  // 目录原始扫描（只按 `.sql` 后缀取，**不**复用发现器的正则）——这是与迁移器相互独立的一路。
  const rawSqlFiles = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  const discovered = rawSqlFiles.filter((name) => /^\d{4,}_[a-z0-9_]+\.sql$/.test(name));
  const versions = discovered.map((name) => name.slice(0, 4));
  assert.equal(new Set(versions).size, versions.length, `迁移版本号重复：${versions.join(',')}`);
  assert.ok(discovered.includes(MIGRATION), `迁移清单必须含 ${MIGRATION}`);
  // 结构不变量（在 main 上恒成立、不随 main 前进变假）：发现器给出的文件名集合必须与目录原始
  // 扫描逐项相等。少一项＝迁移器会**静默少跑一片**（`migrations-negative-pg.mjs` 防的正是这一类），
  // 多一项＝发现器给出了目录里并不存在的文件名。
  const foundByRunner = discoverMigrations().map((migration) => migration.filename).sort();
  assert.deepEqual(
    foundByRunner,
    rawSqlFiles,
    'discoverMigrations() 的发现集合必须与迁移目录原始扫描逐项相等（不漏项／不多项）'
      + `；发现器：${foundByRunner.join(',')}；目录：${rawSqlFiles.join(',')}`,
  );
  assert.ok(
    foundByRunner.includes(MIGRATION),
    `迁移器必须真实发现 ${MIGRATION}（本脚本随后要原样执行它；只存在于目录扫描里不算）`,
  );
  note(
    `[M] 迁移清单 ${discovered.length} 个，与 discoverMigrations() 逐项一致；最大号 ${versions[versions.length - 1]}`
      + '（现算，不断言——最大号随 main 前进，锁死它只会制造时炸弹）',
  );

  const objects = async () => ({
    table: (await one("SELECT to_regclass('public.feature_flags') AS v")).v,
    fn: (await one(`SELECT to_regprocedure('${FUNCTION_SIGNATURE}') AS v`)).v,
    audit: (await one("SELECT to_regclass('public.admin_audit_events') AS v")).v,
    users: (await one("SELECT to_regclass('public.users') AS v")).v,
    admins: (await one("SELECT to_regclass('public.admin_accounts') AS v")).v,
  });

  for (const name of discovered) {
    if (name === MIGRATION) continue;
    await owner.query(readSql(`migrations/${name}`));
  }

  // UP
  await owner.query(readSql(`migrations/${MIGRATION}`));
  let state = await objects();
  assert.ok(state.table, 'UP 后 feature_flags 必须存在');
  assert.ok(state.fn, 'UP 后 set_feature_flag 必须存在');
  assert.ok(state.audit && state.users && state.admins, 'UP 后 0017/0001 既有对象必须仍在');
  const seeded = await q('SELECT key, enabled, revision FROM public.feature_flags ORDER BY key');
  assert.equal(seeded.length, 3, 'UP 后必须恰好三行（不许缺行、不许多行）');
  for (const row of seeded) {
    assert.equal(row.enabled, false, `${row.key} 默认必须为关`);
    assert.equal(row.revision, 1, `${row.key} 默认 revision 必须为 1`);
  }
  note(`[M] UP：表 + 函数出现，种子恰好 3 行且全为 false/revision=1（${seeded.map(keyOf).join(',')}）`);

  // ROLLBACK（同片交付的回滚脚本，原样执行）
  await owner.query(readSql(DOWN));
  state = await objects();
  assert.equal(state.table, null, 'ROLLBACK 后 feature_flags 必须消失');
  assert.equal(state.fn, null, 'ROLLBACK 后 set_feature_flag 必须消失');
  assert.ok(state.audit && state.users && state.admins, '回滚不得触碰 0017/0001 既有表');
  note('[M] ROLLBACK：函数与表消失，admin_audit_events/users/admin_accounts 仍在（回滚不越界）');

  // REPLAY
  await owner.query(readSql(`migrations/${MIGRATION}`));
  state = await objects();
  assert.ok(state.table && state.fn, 'REPLAY 后表与函数必须完整恢复');
  const replayed = await q('SELECT count(*)::int AS c FROM public.feature_flags');
  assert.equal(replayed[0].c, 3, 'REPLAY 后种子仍为三行（可重放）');
  note('[M] REPLAY：表 + 函数再次出现，种子仍三行（迁移可重放）');
}

// ---------------------------------------------------------------------------
// [A] 表结构（硬约束）
// ---------------------------------------------------------------------------
async function tableShape() {
  const columns = await q(
    "SELECT column_name, is_nullable, data_type, column_default FROM information_schema.columns " +
      "WHERE table_schema = 'public' AND table_name = 'feature_flags' ORDER BY ordinal_position",
  );
  assert.deepEqual(columns.map((row) => row.column_name), ['key', 'enabled', 'revision', 'changed_by', 'reason', 'changed_at']);
  const byName = Object.fromEntries(columns.map((row) => [row.column_name, row]));
  assert.equal(byName['enabled'].is_nullable, 'NO');
  assert.match(String(byName['enabled'].column_default), /false/);
  assert.equal(byName['revision'].is_nullable, 'NO');
  assert.match(String(byName['revision'].column_default), /1/);
  assert.equal(byName['changed_by'].is_nullable, 'YES');
  assert.equal(byName['reason'].is_nullable, 'YES');
  assert.equal(byName['changed_at'].is_nullable, 'NO');
  assert.match(String(byName['changed_at'].column_default), /now\(\)/);

  const checks = (await q(
    "SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint " +
      "WHERE conrelid = 'public.feature_flags'::regclass AND contype = 'c'",
  )).map((row) => `${row.conname}:${row.def}`).join('\n');
  for (const key of CONTRACT_FLAG_KEYS) assert.ok(checks.includes(`'${key}'`), `CHECK 闭集必须含 ${key}`);
  assert.match(checks, /revision >= 1/, '必须有 revision >= 1 的 CHECK');

  const fk = (await q(
    "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint " +
      "WHERE conrelid = 'public.feature_flags'::regclass AND contype = 'f'",
  )).map((row) => row.def).join('\n');
  assert.match(fk, /REFERENCES (public\.)?admin_accounts\(id\)/, 'changed_by 必须引用 admin_accounts（不是 users）');
  assert.match(fk, /ON DELETE SET NULL/);

  // 库层面就不接受第四个键（闭集不是靠应用层自觉）。
  let code = null;
  try {
    await owner.query("INSERT INTO public.feature_flags (key) VALUES ('unknown_fourth_flag')");
  } catch (error) {
    code = error.code ?? null;
  }
  assert.equal(code, '23514', `第四个键必须被 CHECK 拒绝（实际 ${String(code)}）`);
  note('[A] 六列形状/默认值/闭集 CHECK/revision CHECK/changed_by→admin_accounts(ON DELETE SET NULL) 全部核对通过；第四键插入 ⇒ 23514');

  const fn = await one(
    "SELECT prosecdef, pg_get_userbyid(proowner) AS owner, proconfig FROM pg_proc WHERE oid = $1::regprocedure",
    [FUNCTION_SIGNATURE],
  );
  assert.equal(fn.prosecdef, true, 'set_feature_flag 必须是 SECURITY DEFINER');
  const config = fn.proconfig ?? [];
  assert.ok(config.includes('search_path=pg_catalog'), `函数必须钉住 search_path=pg_catalog（实际 ${config.join(',')}）`);
  assert.ok(config.some((item) => /^TimeZone=UTC$/.test(item)), '函数必须钉住 TimeZone=UTC');
  note(`[A] 函数 SECURITY DEFINER、属主 ${fn.owner}、proconfig=${config.join(',')}`);
}

// ---------------------------------------------------------------------------
// [P] 角色与最小权限（执行出厂文件里的区域，不复制粘贴 SQL）
// ---------------------------------------------------------------------------
function grantRegion() {
  const matched = deploySql('20-login-roles.sql').match(
    new RegExp(`-- #region ${GRANT_REGION}\\r?\\n([\\s\\S]*?)\\r?\\n\\s*-- #endregion ${GRANT_REGION}`),
  );
  assert.ok(matched !== null, `20-login-roles.sql 必须含 ${GRANT_REGION} 区域`);
  return matched[1];
}

/**
 * [P1] 开跑前的角色接管闸门（在任何写库动作之前，包括 `resetDatabase()`）。
 *
 * 机制：`CREATE ROLE` / `ALTER ROLE … PASSWORD …` 落的是**集群**的 `pg_authid`，不是本库的 schema。
 * 硬钉库名只能证明「我连的是专用库」，证明不了「这个角色是本测试独占的」：别的库（乃至同名的业务
 * 运行时角色）也在用同一份口令登录。因此默认路径**只接受自己新建**，发现同名角色已存在就硬失败，
 * 并给出两条可核验的出路 —— 绝不为了「重复跑通」去重置一个未知角色的密码或 LOGIN 状态。
 */
async function preflightRuntimeRole() {
  const existing = await owner.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [RUNTIME_ROLE]);
  if (providedRuntimeUrl !== null) {
    assert.equal(
      existing.rowCount,
      1,
      `argv[3] 显式复用要求角色 ${RUNTIME_ROLE} 在本集群已存在（口令由 argv[3] 提供，本脚本不改它）`,
    );
    note(`[P] argv[3] 提供既有测试凭据 ⇒ 复用 ${RUNTIME_ROLE}；本轮对它零 DDL（不 CREATE/不 ALTER/不改 LOGIN/不改口令）`);
    return;
  }
  if (existing.rowCount === 0) return;
  throw new Error(
    `拒绝接管既有角色 ${RUNTIME_ROLE}：它已在本集群存在、且不是本轮创建的。\n`
    + '  角色与认证口令属于整个 PG 集群（别的库的客户端也用同一份口令登录），专用测试库不授权本臂'
    + '重置它的密码、LOGIN 位或删除重建。\n'
    + '  二选一：\n'
    + '   (a) 用一次性专用集群跑（`initdb` 新目录 ⇒ 角色天然不存在，本臂自己建、收尾自己 DROP）；\n'
    + `   (b) 若它确实是一次性测试角色，用 argv[3] 显式提供它的**既有**凭据：\n`
    + `       node tests/integration/admin-flags-pg.mjs <ownerUrl> postgres://${RUNTIME_ROLE}:<既有口令>@127.0.0.1:<port>/${DB}\n`
    + `  上一次运行被强杀留下的同名角色也走 (b)；或由人确认后用 \`DROP ROLE ${RUNTIME_ROLE}\` 清掉再跑。`,
  );
}

async function provisionRoles() {
  const region = grantRegion();
  assert.equal(/^\s*(\\(echo|set|pset|if|endif|getenv|gexec))/m.test(region), false, '区域不得含 psql 元命令');
  assert.equal((region.match(/GRANT EXECUTE ON FUNCTION/g) ?? []).length, 1, '区域必须恰好一条 GRANT EXECUTE');
  assert.equal((region.match(/GRANT SELECT ON TABLE public\.feature_flags/g) ?? []).length, 1, '区域必须恰好一条 SELECT 授权');

  if (providedRuntimeUrl === null) {
    // `preflightRuntimeRole()` 已在开跑前挡住「同名角色已存在」；能走到这里的角色必然是**本轮新建**的。
    const existing = await owner.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [RUNTIME_ROLE]);
    assert.equal(existing.rowCount, 0, `${RUNTIME_ROLE} 已存在：本臂不得接管既有运行时身份（见 preflightRuntimeRole）`);
    await owner.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${runtimePassword}'`);
    const derived = new URL(ownerUrl.href);
    derived.username = RUNTIME_ROLE;
    derived.password = runtimePassword;
    runtimeUrl = derived;
    note(`[P] 新建运行时角色 ${RUNTIME_ROLE}（口令只在本进程内存里；收尾按 pg_roles 差集 DROP 回原状）`);
  }
  // 出厂文件的基础段落还会 `GRANT USAGE ON SCHEMA public`（角色在迁移后才创建）；这里只补这一条，
  // 其余权限一律来自区域本身，避免测试悄悄放宽最小权限面。
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE}`);
  await owner.query(region);
  note(`[P] 出厂区域 ${GRANT_REGION} 原样执行：feature_flags=SELECT、set_feature_flag=EXECUTE（运行时角色无任何写权限）`);
}

async function leastPrivilege() {
  if (runtimeUrl === null) {
    unread('[P] 最小权限反向控制', '未提供运行时角色 URL（argv[3]）');
    return;
  }
  const client = new pg.Client({ connectionString: runtimeUrl.href });
  await client.connect();
  try {
    const readable = await client.query('SELECT key, enabled, revision FROM public.feature_flags');
    assert.equal(readable.rows.length, 3, '运行时角色必须能读三行（读面走表）');

    const probes = [
      ["UPDATE feature_flags SET enabled = true WHERE key = 'ai_enabled'", 'feature_flags 直接 UPDATE'],
      ["INSERT INTO feature_flags (key) VALUES ('ai_enabled')", 'feature_flags 直接 INSERT'],
      ['DELETE FROM feature_flags', 'feature_flags 直接 DELETE'],
      ['SELECT * FROM admin_audit_events', 'admin_audit_events 直接读'],
      ['ALTER TABLE feature_flags ADD COLUMN probe integer', 'DDL'],
    ];
    for (const [sql, label] of probes) {
      let code = null;
      try {
        await client.query(sql);
      } catch (error) {
        code = error.code ?? null;
      }
      assert.equal(code, '42501', `${label} 必须以 42501 拒绝，实际 ${String(code)}`);
    }

    // 函数是唯一写面：参数不合格在库内就被 G0001 拒绝（不是靠应用层兜底）。
    let g0001 = null;
    try {
      await client.query(
        "SELECT public.set_feature_flag('ai_enabled', 0, true, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), NULL, 'ADMIN_SET_FLAG')",
      );
    } catch (error) {
      g0001 = error.code ?? null;
    }
    assert.equal(g0001, 'G0001', `expected_revision=0 必须由函数以 G0001 拒绝，实际 ${String(g0001)}`);
    note('[P] 运行时角色：三行可读；UPDATE/INSERT/DELETE/审计表读/DDL 五条全部 42501；函数入参自检 G0001');
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// 通用断言工具
// ---------------------------------------------------------------------------
async function auditRows(targetHint) {
  return q(
    'SELECT id, actor_id, action, scope, target_ref, target_hint, reason_code, request_id, result, created_at ' +
      'FROM public.admin_audit_events WHERE target_hint = $1 ORDER BY created_at, id',
    [targetHint],
  );
}

async function flagRow(key) {
  return one('SELECT key, enabled, revision, changed_by, reason, changed_at FROM public.feature_flags WHERE key = $1', [key]);
}

async function seedAdmin(scopes) {
  const adminId = await seedStore.createAdmin({
    loginName: `gy-i18-${randomUUID().slice(0, 8)}`,
    credentialHash: 'synthetic-not-a-real-credential-hash',
    scopes,
  });
  const token = mintOpaqueToken();
  await seedStore.createSession({
    userId: adminId,
    tokenHashHex: hashToken(token),
    authEpoch: 1,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    audience: 'admin',
  });
  return { adminId, token };
}

const subjectOf = (label) => randomBytes(32).toString('hex').replace(/^(.{56}).{8}$/, `$1${label.padStart(8, '0')}`);

async function seedUserAccount(label = '00001818') {
  const user = await seedStore.createUser(subjectOf(label));
  const token = mintOpaqueToken();
  await seedStore.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    audience: 'user',
  });
  return { userId: user.id, token };
}

async function seedUserToken() {
  return (await seedUserAccount()).token;
}

const REAL_ENV = {
  APP_EXECUTION_MODE: 'real',
  LOG_LEVEL: 'silent',
  SESSION_SIGNING_KEY: randomBytes(32).toString('hex'),
  DATABASE_URL: 'postgres://synthetic_local_only@127.0.0.1:5432/gengyun_synthetic_never_connected',
  DELETION_LEDGER_KEY: 'synthetic-not-a-real-ledger-key',
  WECHAT_APP_ID: 'synthetic-not-a-real-appid',
  WECHAT_APP_SECRET: 'synthetic-not-a-real-appsecret',
  OBJECT_STORAGE_ENDPOINT: 'https://example.invalid',
  OBJECT_STORAGE_BUCKET: 'synthetic-not-a-real-bucket',
  OBJECT_STORAGE_ACCESS_KEY: 'synthetic-not-a-real-access-key',
  OBJECT_STORAGE_SECRET_KEY: 'synthetic-not-a-real-secret-key',
};

const wechatPort = { exchange: async (code) => ({ subjectLookupHex: code.startsWith('sub-') ? code.slice(4) : subjectOf('00000000') }) };

async function injectCall(app, path, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await app.inject({
    method,
    url: path,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { payload: body }),
  });
  const text = response.body;
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.statusCode, body: parsed, text, etag: response.headers['etag'] };
}

// ---------------------------------------------------------------------------
// [B][C][D] 端口层：正常提交 / 陈旧 revision / 并发
// ---------------------------------------------------------------------------
async function portArms() {
  const pool = createPool((runtimeUrl ?? ownerUrl).href);
  registeredPools.push(pool);
  const port = createPostgresFeatureFlags({ pool });

  const listed = await port.list();
  assert.equal(listed.length, 3, `list() 必须返回三行`);
  assert.deepEqual([...listed].map(keyOf).sort(), [...CONTRACT_FLAG_KEYS].sort(), 'list() 的键集合必须等于契约闭集');
  const got = await port.get('ai_enabled');
  assert.deepEqual(got, { key: 'ai_enabled', enabled: false, revision: 1 });

  const admin = await seedAdmin(['flags:read', 'flags:write']);
  const before = await flagRow('ai_enabled');
  const requestId = randomUUID();
  const committed = await port.commitIfCurrent(
    'ai_enabled',
    1,
    { enabled: true },
    { changedBy: admin.adminId, reason: 'GY I18 evidence run', requestId },
  );
  assert.equal(committed.ok, true, '正常提交必须成功');
  assert.deepEqual(committed.record, { key: 'ai_enabled', enabled: true, revision: 2 });

  const after = await flagRow('ai_enabled');
  assert.equal(after.enabled, true);
  assert.equal(after.revision, 2, 'revision 必须 +1');
  assert.equal(after.changed_by, admin.adminId, 'changed_by 必须落库为管理员 id');
  assert.equal(after.reason, 'GY I18 evidence run', 'reason 必须原样落库');
  assert.ok(new Date(after.changed_at) > new Date(before.changed_at), 'changed_at 必须变新');

  let audits = await auditRows('ai_enabled');
  assert.equal(audits.length, 1, '一次真实变更必须恰好一行审计');
  const audit = audits[0];
  assert.equal(audit.action, 'set_flag');
  assert.equal(audit.scope, 'flags:write');
  assert.equal(audit.target_hint, 'ai_enabled');
  assert.equal(audit.target_ref, null);
  assert.equal(audit.result, 'accepted');
  assert.equal(audit.actor_id, admin.adminId);
  assert.equal(audit.request_id, requestId, '审计 request_id 必须等于调用方请求 id');
  assert.equal(audit.reason_code, 'GY_I18_EVIDENCE_RUN', 'reason 必须归一成 [A-Z0-9_] 短码');
  note('[B] commitIfCurrent ⇒ revision 1→2、changed_by/reason 落库、changed_at 变新、审计恰 1 行（action=set_flag/scope=flags:write/target_hint=ai_enabled/target_ref=NULL/result=accepted）');

  // [C] 陈旧 revision：一行都不许动，审计也不许加。
  const stale = await port.commitIfCurrent('ai_enabled', 1, { enabled: false }, {
    changedBy: admin.adminId,
    reason: 'stale write must fail',
    requestId: randomUUID(),
  });
  assert.deepEqual(stale, { ok: false, reason: 'REVISION_CONFLICT' });
  assert.deepEqual(await flagRow('ai_enabled'), after, '陈旧 revision 必须零写入（行逐字不变）');
  assert.equal((await auditRows('ai_enabled')).length, 1, '陈旧 revision 不得追加审计');
  note('[C] 陈旧 revision ⇒ ok:false REVISION_CONFLICT；行与审计都不变');

  // [D] 并发两笔同 revision：恰一笔成功、一笔冲突、审计恰 1 行。
  const [first, second] = await Promise.all([
    port.commitIfCurrent('submissions_enabled', 1, { enabled: true }, {
      changedBy: admin.adminId,
      reason: 'concurrent a',
      requestId: randomUUID(),
    }),
    port.commitIfCurrent('submissions_enabled', 1, { enabled: true }, {
      changedBy: admin.adminId,
      reason: 'concurrent b',
      requestId: randomUUID(),
    }),
  ]);
  const outcomes = [first, second];
  assert.equal(outcomes.filter((result) => result.ok === true).length, 1, '并发必须恰一笔成功');
  assert.equal(
    outcomes.filter((result) => result.ok === false && result.reason === 'REVISION_CONFLICT').length,
    1,
    '并发必须恰一笔冲突',
  );
  const submissions = await flagRow('submissions_enabled');
  assert.equal(submissions.revision, 2, '并发后 revision 只能 +1');
  assert.equal((await auditRows('submissions_enabled')).length, 1, '并发后审计只能一行');
  note('[D] Promise.all 两笔同 revision ⇒ 恰一笔成功一笔 REVISION_CONFLICT，revision 只 +1，审计恰 1 行');

  // [H] 行锁的行为分量（能证伪 `SELECT … FOR UPDATE`）：外部会话持行锁，再调端口走
  //     「值未变 ⇒ 幂等短路」路径。带锁 ⇒ 短路判定被行锁挡住，4s（`SET LOCAL lock_timeout='4s'`）
  //     后 55P03 ⇒ 504 PROVIDER_TIMEOUT；删掉 FOR UPDATE ⇒ 读快照数毫秒返回 ok:true ⇒ 耗时下界必红。
  //     注：HTTP 的 PUT 到不了这里（service.ts 的「值未变」分支在端口之前就返回 200），故本用例按
  //     审查者的同一探针在端口层取证；生产代码按 r2 派单 §2 不改。
  const locked = await flagRow('ai_enabled');
  const auditBeforeLock = (await auditRows('ai_enabled')).length;
  let lockElapsedMs = -1;
  let lockError = null;
  await owner.query('BEGIN');
  try {
    await owner.query("SELECT 1 FROM public.feature_flags WHERE key = 'ai_enabled' FOR UPDATE");
    const lockStartedAt = Date.now();
    try {
      lockError = await port.commitIfCurrent(
        'ai_enabled',
        locked.revision,
        { enabled: locked.enabled },
        { changedBy: admin.adminId, reason: 'lock-wait probe' },
      );
    } catch (error) {
      lockError = error;
    } finally {
      lockElapsedMs = Date.now() - lockStartedAt;
    }
  } finally {
    await owner.query('ROLLBACK');
  }
  assert.ok(
    lockElapsedMs >= 3000,
    `外部持锁时「值未变」短路必须等锁到 lock_timeout（≥3000ms）；实测 ${lockElapsedMs}ms ⇒ 行锁没有行为分量（删掉 FOR UPDATE 会在 10ms 内返回成功）`,
  );
  assert.ok(lockError instanceof Error, '带锁调用必须失败（504 PROVIDER_TIMEOUT），不得静默返回陈旧成功');
  assert.equal(lockError.status, 504, '带锁调用必须是 504');
  assert.equal(lockError.code, 'PROVIDER_TIMEOUT', '带锁调用必须是 PROVIDER_TIMEOUT');
  assert.equal(lockError.retryable, true, '锁超时是可重试的瞬时故障');
  assert.notEqual(lockError.code, 'PROVIDER_UNAVAILABLE', '不得把锁超时折叠成 503');

  // 反面对照：锁释放后同一笔请求 ⇒ 成功、revision 不变、审计不增（证明上一条 504 不是环境噪声）。
  const unlocked = await port.commitIfCurrent(
    'ai_enabled',
    locked.revision,
    { enabled: locked.enabled },
    { changedBy: admin.adminId, reason: 'lock-wait probe' },
  );
  assert.equal(unlocked.ok, true, '锁释放后同一笔「值未变」请求必须成功');
  assert.equal(unlocked.record.revision, locked.revision, '幂等短路不得改 revision');
  assert.equal(unlocked.record.enabled, locked.enabled, '幂等短路不得改值');
  assert.equal((await flagRow('ai_enabled')).revision, locked.revision, '行锁探针不得改变库内 revision');
  assert.equal((await auditRows('ai_enabled')).length, auditBeforeLock, '幂等短路不得写审计');
  note(
    `[H] 外部持锁 + 「值未变」commitIfCurrent ⇒ 等锁 ${lockElapsedMs}ms 后 504 PROVIDER_TIMEOUT(retryable:true)；` +
      '释放后同请求 ⇒ ok、revision 不变、审计 0 增（删掉 FOR UPDATE 则本行必红）',
  );
}

// ---------------------------------------------------------------------------
// [E] 真实 HTTP 装配（real + 运行时 pool ⇒ 开关端口已接）
// ---------------------------------------------------------------------------
async function httpArm() {
  if (runtimeUrl === null) {
    unread('[E] 真实 HTTP 装配', '未提供运行时角色 URL（argv[3]）');
    return;
  }

  // 装配口径：不给 adminInjection，app.ts 必须自己从 pool 造出端口并把开关门 armed（只断言装配，不发请求）。
  const wiringApp = buildApp({ config: loadConfig(REAL_ENV), pool: ownerPool, wechat: wechatPort, now: () => new Date() });
  assert.equal(wiringApp.featureFlagGate.armed, true, 'real + pool!==null ⇒ app.ts 必须自动接端口并 armed');
  await wiringApp.close();

  // HTTP 证据：认证/会话面用 owner 连接（20-login-roles.sql 的整段基础授权不在测试里重放），
  // 但开关端口显式注入「运行时角色」连接 ⇒ flags 读写仍走最小权限角色 + SECURITY DEFINER 函数。
  const flagsPool = createPool(runtimeUrl.href);
  registeredPools.push(flagsPool);
  const app = buildApp({
    config: loadConfig(REAL_ENV),
    pool: ownerPool,
    wechat: wechatPort,
    now: () => new Date(),
    adminInjection: { flagsPort: createPostgresFeatureFlags({ pool: flagsPool }) },
  });
  registeredApps.push(app);
  assert.equal(app.featureFlagGate.armed, true, 'real + 开关端口已接 ⇒ 开关门必须 armed');

  const admin = await seedAdmin(['flags:read', 'flags:write']);
  const userToken = await seedUserToken();

  // 读面：三键、契约序、revision 反映 [B][D] 的真实提交。
  const list = await injectCall(app, `${API}/admin/feature-flags`, { token: admin.token });
  assert.equal(list.status, 200, `listFlags 必须 200，实际 ${list.status} ${list.text.slice(0, 300)}`);
  const items = list.body.data.items;
  assertContractOrder(items);
  assert.deepEqual(
    items.map((item) => [item.key, item.enabled, item.revision]),
    [
      ['submissions_enabled', true, 2],
      ['specific_herbicide_output_enabled', false, 1],
      ['ai_enabled', true, 2],
    ],
    '读面必须反映库内真实状态（不是内存种子）',
  );
  note('[E] GET /admin/feature-flags ⇒ 200，三键按契约序，revision 与库内一致（2/1/2）');

  // ② 正确 If-Match ⇒ 200、revision+1、changed_by/reason 落库、审计恰 1 行。
  const put = await injectCall(app, `${API}/admin/feature-flags/specific_herbicide_output_enabled`, {
    method: 'PUT',
    token: admin.token,
    body: { enabled: true, reason: '打开除草剂专项输出' },
    headers: { 'if-match': '"1"', 'idempotency-key': randomUUID() },
  });
  assert.equal(put.status, 200, `正确 If-Match 必须 200，实际 ${put.status} ${put.text.slice(0, 400)}`);
  assert.equal(put.body.data.revision, 2);
  assert.equal(put.body.data.enabled, true);
  assert.equal(put.etag, '"2"', '响应 ETag 必须是新 revision');
  const specific = await flagRow('specific_herbicide_output_enabled');
  assert.equal(specific.revision, 2);
  assert.equal(specific.changed_by, admin.adminId);
  assert.equal(specific.reason, '打开除草剂专项输出');
  const specificAudits = await auditRows('specific_herbicide_output_enabled');
  assert.equal(specificAudits.length, 1);
  assert.equal(specificAudits[0].reason_code, 'ADMIN_SET_FLAG', '纯中文理由归一为空 ⇒ 固定短码');
  note('[E] PUT 正确 If-Match ⇒ 200/ETag "2"、revision 2、changed_by 与中文理由落库、审计 1 行（reason_code=ADMIN_SET_FLAG）');

  // ③ 错误 If-Match ⇒ 409、revision 不变、审计 0 增。
  const stalePut = await injectCall(app, `${API}/admin/feature-flags/specific_herbicide_output_enabled`, {
    method: 'PUT',
    token: admin.token,
    body: { enabled: false, reason: 'should conflict' },
    headers: { 'if-match': '"1"', 'idempotency-key': randomUUID() },
  });
  assert.equal(stalePut.status, 409, `错误 If-Match 必须 409，实际 ${stalePut.status} ${stalePut.text.slice(0, 300)}`);
  assert.equal(stalePut.body.error.code, 'REVISION_CONFLICT');
  assert.equal((await flagRow('specific_herbicide_output_enabled')).revision, 2);
  assert.equal((await auditRows('specific_herbicide_output_enabled')).length, 1);
  note('[E] PUT 错误 If-Match ⇒ 409 REVISION_CONFLICT；revision 不变、审计 0 增');

  // 值未变 ⇒ 幂等短路：200 原 ETag、不写库、不写审计。
  const sameValue = await injectCall(app, `${API}/admin/feature-flags/specific_herbicide_output_enabled`, {
    method: 'PUT',
    token: admin.token,
    body: { enabled: true, reason: 'same value' },
    headers: { 'if-match': '"2"', 'idempotency-key': randomUUID() },
  });
  assert.equal(sameValue.status, 200);
  assert.equal(sameValue.etag, '"2"');
  assert.equal((await flagRow('specific_herbicide_output_enabled')).revision, 2, '值未变不得递增 revision');
  assert.equal((await auditRows('specific_herbicide_output_enabled')).length, 1, '值未变不得写审计');
  note('[E] PUT 值未变 ⇒ 200 原 ETag "2"、库与审计都不动（幂等短路）');

  // ⑤ 关掉开关 ⇒ `/herbicides` 409 OBJECT_UNAVAILABLE；开回 ⇒ 恢复。
  const openBefore = await injectCall(app, `${API}/herbicides`, { token: userToken });
  assert.equal(openBefore.status, 200, `开关开时 /herbicides 必须 200，实际 ${openBefore.status} ${openBefore.text.slice(0, 300)}`);
  const close = await injectCall(app, `${API}/admin/feature-flags/specific_herbicide_output_enabled`, {
    method: 'PUT',
    token: admin.token,
    body: { enabled: false, reason: '关闭除草剂专项输出' },
    headers: { 'if-match': '"2"', 'idempotency-key': randomUUID() },
  });
  assert.equal(close.status, 200);
  assert.equal(close.body.data.revision, 3);
  const closed = await injectCall(app, `${API}/herbicides`, { token: userToken });
  assert.equal(closed.status, 409, `开关关时 /herbicides 必须 409，实际 ${closed.status} ${closed.text.slice(0, 300)}`);
  assert.equal(closed.body.error.code, 'OBJECT_UNAVAILABLE');
  assert.ok(closed.text.includes('FLAG_CLOSED'), `开关关闭错误必须带 FLAG_CLOSED 细节：${closed.text.slice(0, 300)}`);
  const reopen = await injectCall(app, `${API}/admin/feature-flags/specific_herbicide_output_enabled`, {
    method: 'PUT',
    token: admin.token,
    body: { enabled: true, reason: '恢复除草剂专项输出' },
    headers: { 'if-match': '"3"', 'idempotency-key': randomUUID() },
  });
  assert.equal(reopen.status, 200);
  assert.equal(reopen.body.data.revision, 4);
  const openAfter = await injectCall(app, `${API}/herbicides`, { token: userToken });
  assert.equal(openAfter.status, 200, `开关开回后 /herbicides 必须恢复 200，实际 ${openAfter.status}`);
  note('[E] 关 specific_herbicide_output_enabled ⇒ GET /herbicides 409 OBJECT_UNAVAILABLE(FLAG_CLOSED)；开回 ⇒ 200 恢复');

  // ④ HTTP 并发：两笔同 revision ⇒ 恰一笔 200、一笔 409，审计恰 2 行（[B] 一行 + 胜者一行）。
  const [left, right] = await Promise.all([
    injectCall(app, `${API}/admin/feature-flags/ai_enabled`, {
      method: 'PUT',
      token: admin.token,
      body: { enabled: false, reason: '并发关闭 A' },
      headers: { 'if-match': '"2"', 'idempotency-key': randomUUID() },
    }),
    injectCall(app, `${API}/admin/feature-flags/ai_enabled`, {
      method: 'PUT',
      token: admin.token,
      body: { enabled: false, reason: '并发关闭 B' },
      headers: { 'if-match': '"2"', 'idempotency-key': randomUUID() },
    }),
  ]);
  const statuses = [left.status, right.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409], `并发 PUT 必须恰一笔 200、一笔 409，实际 ${JSON.stringify(statuses)}`);
  assert.equal((await flagRow('ai_enabled')).revision, 3, '并发后仅一次生效');
  assert.equal((await auditRows('ai_enabled')).length, 2, '并发后审计恰 2 行（一次历史 + 一次胜者）');
  note('[E] 并发两笔同 If-Match PUT ⇒ 恰一笔 200、一笔 409，revision 只 +1，审计只多一行');
}

// ---------------------------------------------------------------------------
// [F] pool === null：real 默认装配与今天逐字相同
// ---------------------------------------------------------------------------
async function nullPoolArm() {
  const memory = createMemoryAuthStore();
  const app = buildApp({ config: loadConfig(REAL_ENV), store: memory });
  registeredApps.push(app);
  assert.equal(app.featureFlagGate.armed, false, 'pool === null ⇒ 开关门不得 armed（无库可读，不得猜开）');

  const adminId = await memory.createAdmin({
    loginName: `gy-i18-null-${randomUUID().slice(0, 8)}`,
    credentialHash: 'synthetic-not-a-real-credential-hash',
    scopes: ['flags:read', 'flags:write'],
  });
  const adminToken = mintOpaqueToken();
  await memory.createSession({
    userId: adminId,
    tokenHashHex: hashToken(adminToken),
    authEpoch: 1,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    audience: 'admin',
  });
  const user = await memory.createUser(subjectOf('00009999'));
  const userToken = mintOpaqueToken();
  await memory.createSession({
    userId: user.id,
    tokenHashHex: hashToken(userToken),
    authEpoch: user.authEpoch,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    audience: 'user',
  });

  const list = await injectCall(app, `${API}/admin/feature-flags`, { token: adminToken });
  assert.equal(list.status, 503, `pool===null 时 listFlags 必须 503，实际 ${list.status}`);
  assert.equal(list.body.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(list.body.error.retryable, false);
  assert.equal(list.body.data, undefined, '不得伪造成功封套');

  const put = await injectCall(app, `${API}/admin/feature-flags/ai_enabled`, {
    method: 'PUT',
    token: adminToken,
    body: { enabled: true, reason: 'must not persist' },
    headers: { 'if-match': '"1"', 'idempotency-key': randomUUID() },
  });
  assert.equal(put.status, 503);
  assert.equal(put.body.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(put.body.data, undefined);

  // 开关门不 armed ⇒ 与今天一致：/herbicides 不被开关拦（库里的 false 不生效）。
  const herbicides = await injectCall(app, `${API}/herbicides`, { token: userToken });
  assert.equal(herbicides.status, 200, `pool===null 时开关门不生效，/herbicides 必须 200，实际 ${herbicides.status}`);
  note('[F] pool===null：listFlags/PUT ⇒ 503 PROVIDER_UNAVAILABLE(retryable:false) 且无成功封套；开关门 armed=false，/herbicides 行为同今天');
}

// ---------------------------------------------------------------------------
// [G] 武装就绪探测：子集迁移库不武装，补齐 0020 后武装（T-R12-08R）
// ---------------------------------------------------------------------------
/** 与 `tests/integration/egress-ledger-pg.mjs:216` 完全相同的迁移子集（CI 红的那台库的库形状）。 */
const SUBSET_MIGRATIONS = [
  '0001_initial_schema.sql',
  '0003_privacy_consent.sql',
  '0008_auth_session.sql',
  '0009_consent_policy.sql',
  '0011_export_ledger.sql',
];

async function applyMigrationFiles(names) {
  for (const name of names) await owner.query(readSql(`migrations/${name}`));
}

async function armingArm() {
  // --- 场景 1：只应用迁移子集 ⇒ 库里没有 public.feature_flags
  await resetDatabase();
  await applyMigrationFiles(SUBSET_MIGRATIONS);
  const missing = (await owner.query("SELECT to_regclass('public.feature_flags') AS oid")).rows[0].oid;
  assert.equal(missing, null, '子集库必须没有 public.feature_flags（这正是 CI 的库形状）');
  const subsetToken = await seedUserToken();

  const subsetApp = buildApp({
    config: loadConfig(REAL_ENV),
    pool: ownerPool,
    wechat: wechatPort,
    now: () => new Date(),
  });
  registeredApps.push(subsetApp);
  assert.equal(
    subsetApp.featureFlagGate.armed,
    true,
    '探测前的静态口径：real + 有池 ⇒ 初始 armed=true（确认缺表/探测异常才由运行时探测裁决）',
  );
  await subsetApp.ready();
  assert.equal(
    subsetApp.featureFlagGate.armed,
    false,
    '子集库 ⇒ to_regclass IS NULL ⇒ 探测 **missing**（确认缺表）⇒ 开关门降级未武装',
  );
  const subsetHerbicides = await injectCall(subsetApp, `${API}/herbicides`, { token: subsetToken });
  assert.equal(
    subsetHerbicides.status,
    200,
    `未武装时 /herbicides 不得被开关拦（不得 503/409），实际 ${subsetHerbicides.status}`,
  );
  note(
    '[G] 子集迁移库（0001/0003/0008/0009/0011，无 0020）：onReady 探测 missing（to_regclass IS NULL）⇒ 门 armed=false，/herbicides 200（CI 的 503 不再发生）',
  );

  // --- 场景 2：同一库补齐全部迁移（含 0020）⇒ 表就绪 ⇒ 武装且按库判定
  await resetDatabase();
  const allNames = readdirSync(migrationsDir)
    .filter((name) => /^\d{4,}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  await applyMigrationFiles(allNames);
  const oid = (await owner.query("SELECT to_regclass('public.feature_flags') AS oid")).rows[0].oid;
  assert.notEqual(oid, null, '补齐全部迁移后 public.feature_flags 必须存在');
  const seeded = await q('SELECT key, enabled FROM public.feature_flags ORDER BY key');
  assert.equal(seeded.length, 3, '迁移种子必须恰好 3 行');
  assert.ok(seeded.every((row) => row.enabled === false), '迁移种子必须全 false（默认关闭）');
  const armedToken = await seedUserToken();

  const armedApp = buildApp({
    config: loadConfig(REAL_ENV),
    pool: ownerPool,
    wechat: wechatPort,
    now: () => new Date(),
  });
  registeredApps.push(armedApp);
  await armedApp.ready();
  assert.equal(
    armedApp.featureFlagGate.armed,
    true,
    '表就绪 ⇒ 必须武装（否则"关了却照常产出"的老问题会回来）',
  );
  const armedHerbicides = await injectCall(armedApp, `${API}/herbicides`, { token: armedToken });
  assert.equal(
    armedHerbicides.status,
    409,
    `武装后默认 false ⇒ /herbicides 必须 409，实际 ${armedHerbicides.status}`,
  );
  assert.equal(armedHerbicides.body.error.code, 'OBJECT_UNAVAILABLE');
  const detailCodes = (armedHerbicides.body.error.details ?? []).map((detail) => detail.code);
  assert.ok(detailCodes.includes('FLAG_CLOSED'), '409 必须带既有 flag-gate 的 FLAG_CLOSED 证据');
  note(
    '[G] 同一库补齐全部迁移（含 0020）：探测 ready ⇒ 门 armed=true；默认 false ⇒ /herbicides 409 OBJECT_UNAVAILABLE(FLAG_CLOSED)',
  );
}

// ---------------------------------------------------------------------------
// [I] 开关真库端到端（#18「真实生效」）：开关必须真的控制**产出面**，不只是读面回显
// ---------------------------------------------------------------------------
/**
 * 跑在 `armingArm()` 之后 —— 那一步最后一次 `resetDatabase()` + 全部迁移 ⇒ `community_posts`（0022）
 * 与 0020 的三行种子都在（种子 revision=1/全 false），所以本臂**先读真实 revision 再显式 PUT**，
 * 不假设任何种子值。
 *
 * 装配口径：
 *   - 只用 owner 池。`resetDatabase()` 连 `public` schema 一起重建，`20-login-roles.sql` 的授权随之失效；
 *     开关端口的「最小权限」证据由 [P]/[E] 各自单独取证，本臂只证**行为**。
 *   - 不注入 `adminInjection.flagsPort` ⇒ real + pool 时由 `app.ts` 自建 PG 端口（`armed=true`）。
 *   - 注入 `privacyInjection.consent`（社区已有的合成授权夹具）：`public_posting` 是投稿的**前置授权**，
 *     与本用例主题无关，用既有夹具补齐（真实 grant 链路，不跳过授权闸）。
 *   - 注入 `communityInjection.moderation = null`：real 未接真实 tms/ims 时审核域整域 fail-closed（503），
 *     会把 `POST /posts` 挡在开关判定之前；`app.ts` 的装配点显式支持这个注入（隔离用）。规则层闸照常参与。
 *   - 注入 `communityInjection.gate = makeGate()`：规则层缺省 50ms 墙钟预算（`screen.ts:127-128`），
 *     高负载机器上会把干净投稿抖成 422 RULE_TIMEOUT。冻结时钟只去掉**与本用例无关的时延抖动**，
 *     开关门（`createFeatureFlagGate`）仍是真的：关闭时 409 由它抛出。
 */
async function flagSurfaceArm() {
  const publicPosting = createPublicPostingConsent();
  const app = buildApp({
    config: loadConfig(REAL_ENV),
    pool: ownerPool,
    wechat: wechatPort,
    now: () => new Date(),
    privacyInjection: { consent: publicPosting.gate },
    communityInjection: { moderation: null, gate: makeGate() },
  });
  registeredApps.push(app);
  assert.equal(
    app.featureFlagGate.armed,
    true,
    'real + 有池 ⇒ 开关门必须武装（不武装就等于没接开关，本臂的 409 会变成假绿）',
  );
  await app.ready();
  assert.equal(app.featureFlagGate.armed, true, '全迁移库 ⇒ onReady 探测必须 ready（不得降级成未武装）');

  const admin = await seedAdmin(['flags:read', 'flags:write']);
  const author = await seedUserAccount('00001819');
  await publicPosting.grant(author.userId);

  /** 每次投稿换一个标题：既避开规则层的重复内容判定，也让「零落行」可以按标题精确查证。 */
  const postPayload = (attempt) => ({
    title: `GY-I18 开关端到端：第 ${attempt} 次投稿`,
    body: '用于证明「关闭期间零落行、重开即恢复」的合成正文。',
    media_ids: [],
  });
  /** 一次真实投稿。每次都换 `Idempotency-Key`，避免幂等重放把「到底有没有落库」掩盖成 201。 */
  const submitPost = (token, attempt) =>
    injectCall(app, `${API}/posts`, {
      method: 'POST',
      ...(token === undefined ? {} : { token }),
      body: postPayload(attempt),
      headers: { 'idempotency-key': randomUUID() },
    });
  const contentRows = async () => (await q('SELECT count(*)::int AS n FROM community_posts'))[0].n;
  /** 按标题查某次投稿真的落了几行（行数相等之外的第二重证据）。 */
  const titledRows = async (attempt) =>
    (await q('SELECT count(*)::int AS n FROM community_posts WHERE title = $1', [postPayload(attempt).title]))[0].n;
  const putFlag = (enabled, ifMatch, reason) =>
    injectCall(app, `${API}/admin/feature-flags/submissions_enabled`, {
      method: 'PUT',
      token: admin.token,
      body: { enabled, reason },
      headers: { 'if-match': ifMatch, 'idempotency-key': randomUUID() },
    });
  /** 该键在 `admin_audit_events` 的 id 集合，用来按差集算「这次切换恰好写了 1 行」。 */
  const auditIdSet = async () => new Set((await auditRows('submissions_enabled')).map((row) => row.id));
  const auditRowsAdded = async (before) => (await auditRows('submissions_enabled')).filter((row) => !before.has(row.id));

  // ① 先**显式** PUT 成开启：revision 取自读面，不假设种子。
  const list = await injectCall(app, `${API}/admin/feature-flags`, { token: admin.token });
  assert.equal(list.status, 200, `读面必须 200，实际 ${list.status} ${list.text.slice(0, 300)}`);
  const listed = list.body.data.items.find((item) => item.key === 'submissions_enabled');
  assert.notEqual(listed, undefined, '读面必须含 submissions_enabled');
  const auditsBeforeOpen = await auditIdSet();
  const opened = await putFlag(true, `"${listed.revision}"`, '显式开启社区投稿受理');
  assert.equal(opened.status, 200, `显式开启必须 200，实际 ${opened.status} ${opened.text.slice(0, 300)}`);
  assert.equal(opened.body.data.enabled, true, '显式 PUT 后开关必须是 true（本臂不依赖种子默认值）');
  assert.equal((await flagRow('submissions_enabled')).enabled, true, '开启必须当场落到 feature_flags');
  const openAudits = await auditRowsAdded(auditsBeforeOpen);
  assert.equal(openAudits.length, 1, `一次切换必须恰写 1 行审计，实际 ${openAudits.length} 行`);

  const contentAtOpen = await contentRows();
  const firstPost = await submitPost(author.token, 1);
  assert.equal(firstPost.status, 201, `开关开启时 POST /posts 必须 2xx，实际 ${firstPost.status} ${firstPost.text.slice(0, 400)}`);
  assert.equal(firstPost.body.data.revision, 1, '首次投稿的 revision 必须是 1');
  assert.equal(firstPost.body.data.visibility, 'published', '审核联动关闭（隔离注入）⇒ 无媒体投稿应直接 published');
  assert.equal(await contentRows(), contentAtOpen + 1, '开启时一次投稿必须**恰好**落 1 行社区内容');
  assert.equal(await titledRows(1), 1, '第 1 次投稿必须真的落库 1 行');
  note('[I] 显式 PUT submissions_enabled=true（revision 取自读面）⇒ POST /posts 201，community_posts 恰 +1 行');

  // ② 关闭 ⇒ 同一个产出面立刻 409 OBJECT_UNAVAILABLE（details 带 FLAG_CLOSED）。
  const auditsBeforeClose = await auditIdSet();
  const closed = await putFlag(false, opened.etag, '关闭社区投稿受理');
  assert.equal(closed.status, 200, `关闭必须 200，实际 ${closed.status} ${closed.text.slice(0, 300)}`);
  assert.equal(closed.body.data.enabled, false, '关闭必须落 enabled=false');
  const closeAudits = await auditRowsAdded(auditsBeforeClose);
  assert.equal(closeAudits.length, 1, `关闭一次必须恰写 1 行审计，实际 ${closeAudits.length} 行`);
  assert.equal(closeAudits[0].action, 'set_flag', '审计 action 必须是 set_flag');
  assert.equal(closeAudits[0].scope, 'flags:write', '审计 scope 必须是 flags:write');
  assert.equal(closeAudits[0].target_hint, 'submissions_enabled', '审计 target_hint 必须钉住被切的键');
  assert.equal(closeAudits[0].result, 'accepted', '审计 result 必须是 accepted');
  assert.equal(closeAudits[0].actor_id, admin.adminId, '审计 actor 必须是这次操作的运营账号');

  const contentAtClose = await contentRows();
  const blocked = await submitPost(author.token, 2);
  assert.equal(blocked.status, 409, `开关关闭时 POST /posts 必须 409，实际 ${blocked.status} ${blocked.text.slice(0, 400)}`);
  assert.equal(blocked.body.error.code, 'OBJECT_UNAVAILABLE', '关闭口径必须是 OBJECT_UNAVAILABLE');
  const blockedCodes = (blocked.body.error.details ?? []).map((detail) => detail?.code);
  assert.ok(blockedCodes.includes('FLAG_CLOSED'), `409 的 details 必须带 FLAG_CLOSED，实际 ${JSON.stringify(blockedCodes)}`);
  assert.equal(blocked.body.data, undefined, '被开关拒绝时不得返回任何内容对象');
  note('[I] PUT submissions_enabled=false ⇒ POST /posts 409 OBJECT_UNAVAILABLE（details: FLAG_CLOSED），审计恰 1 行');

  // ③ 关闭期间库内**零新增**：关前/关后各查一次行数，必须相等。
  const contentAfterBlocked = await contentRows();
  assert.equal(contentAfterBlocked, contentAtClose, '开关关闭期间 community_posts 不得新增任何行（零产出保证）');
  assert.equal(await titledRows(2), 0, '被 409 拒绝的那次投稿不得在 community_posts 留下任何行（按标题精确查证）');
  note('[I] 关闭期间 community_posts 行数前后相等 ⇒ 开关真的控制了产出面，不只是读面回显');

  // ④ 未登录仍 401：**此刻开关是关的**，鉴权必须先于开关判定，且响应不得泄露开关状态。
  assert.equal((await flagRow('submissions_enabled')).enabled, false, '前置：此刻库里该键确实是关闭的');
  const anonymous = await submitPost(undefined, 4);
  assert.equal(anonymous.status, 401, `未登录 POST /posts 必须 401（鉴权先于开关），实际 ${anonymous.status} ${anonymous.text.slice(0, 400)}`);
  assert.equal(anonymous.body.error.code, 'SESSION_REQUIRED', '未登录的鉴权口径必须是 SESSION_REQUIRED');
  assert.equal(anonymous.text.includes('FLAG_CLOSED'), false, '401 响应不得泄露开关状态（否则等于把开关当鉴权用）');
  assert.equal(await titledRows(4), 0, '未登录被拒的那次投稿同样不得落行');
  note('[I] 开关关闭时未登录 POST /posts ⇒ 401 SESSION_REQUIRED（不泄露 FLAG_CLOSED）：鉴权前置未被打乱');

  // ⑤ 重开 ⇒ **同一进程、无重启、无缓存等待**：立刻再投必须恢复 2xx。
  const auditsBeforeReopen = await auditIdSet();
  const reopened = await putFlag(true, closed.etag, '恢复社区投稿受理');
  assert.equal(reopened.status, 200, `重开必须 200，实际 ${reopened.status} ${reopened.text.slice(0, 300)}`);
  assert.equal(reopened.body.data.enabled, true, '重开必须落 enabled=true');
  assert.equal((await flagRow('submissions_enabled')).enabled, true, '重开必须当场落库');
  const reopenAudits = await auditRowsAdded(auditsBeforeReopen);
  assert.equal(reopenAudits.length, 1, `重开一次必须恰写 1 行审计，实际 ${reopenAudits.length} 行`);

  const contentBeforeResume = await contentRows();
  const resumed = await submitPost(author.token, 3);
  assert.equal(resumed.status, 201, `重开后同一进程立刻投稿必须恢复 2xx，实际 ${resumed.status} ${resumed.text.slice(0, 400)}`);
  assert.notEqual(resumed.body.data.id, firstPost.body.data.id, '恢复后的投稿必须是新内容（不是 409 前的旧对象回放）');
  assert.equal(await contentRows(), contentBeforeResume + 1, '重开后投稿必须重新落 1 行');
  assert.equal(await titledRows(3), 1, '第 3 次投稿（重开后）必须真的落库 1 行');
  note('[I] 重开 ⇒ 同一进程、零重启、零等待，POST /posts 立刻回到 201 并重新落 1 行');
}

// ---------------------------------------------------------------------------
// [P1] 负控制：既有角色的认证材料必须一字不差
// ---------------------------------------------------------------------------
let credentialsReported = false;
/**
 * 复读 `pg_authid`，与开跑前的快照逐项比对：**既有角色的口令哈希 / LOGIN 位 / 到期时间不得有任何变化**。
 * 这是「本臂只在专用角色命名空间里动手」的可复现读数 —— 老实现会在角色已存在时
 * `ALTER ROLE … PASSWORD '<随机>'`，本断言当场判红。
 * `strict=false` 只打印读数不抛（失败路径用；⛔ 不得用它冒充通过）。
 */
async function checkRoleCredentials(strict) {
  if (credentialsReported) return;
  if (baselineCredentials === null) {
    note('[P] 既有角色认证材料比对：未取得（owner 读不到 pg_authid），本轮不作结论');
    credentialsReported = true;
    return;
  }
  const now = new Map((await owner.query(ROLE_FINGERPRINT_SQL)).rows.map((row) => [row.rolname, roleFingerprint(row)]));
  const drifted = [];
  for (const [role, before] of baselineCredentials) {
    if (!now.has(role)) drifted.push(`${role}（已消失）`);
    else if (now.get(role) !== before) drifted.push(`${role}（认证材料被改）`);
  }
  credentialsReported = true;
  if (drifted.length > 0) {
    const message = `既有角色的认证材料被改动（本臂只允许建/删自己本轮新建的角色）：${drifted.join('、')}`;
    if (strict) assert.deepEqual(drifted, [], message);
    note(`[FAIL] ${message}`);
    return;
  }
  const bystanders = [...baselineCredentials.keys()].filter((role) => role !== RUNTIME_ROLE);
  note(
    `[P] 负控制：既有角色 ${baselineCredentials.size} 个（其中非 ${RUNTIME_ROLE} 的其它角色 ${bystanders.length} 个：`
    + `${bystanders.slice(0, 4).join('、') || '无'}）的 LOGIN 位/口令哈希/到期时间与开跑前逐字节相同`,
  );
}

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------
async function cleanup() {
  // 上一次失败可能把连接留在 aborted transaction 里（迁移文件自带 BEGIN/COMMIT）⇒ 先归位再清角色。
  await owner.query('ROLLBACK').catch(() => {});
  for (const app of registeredApps.reverse()) await app.close().catch(() => {});
  for (const pool of registeredPools.reverse()) await pool.end().catch(() => {});
  const after = new Set((await owner.query('SELECT rolname FROM pg_roles')).rows.map((row) => row.rolname));
  for (const role of after) {
    if (baselineRoles.has(role)) continue;
    await owner.query(`DROP OWNED BY ${role}`).catch(() => {});
    await owner.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
  }
  await owner.end().catch(() => {});
}

// 本脚本要反复跑：迁移不幂等（`CREATE SCHEMA knowledge_staging` 等），所以先把库里所有非系统 schema 清掉自愈。
async function resetDatabase() {
  await owner.query('ROLLBACK').catch(() => {});
  const schemas = await owner.query(
    "SELECT nspname FROM pg_namespace WHERE nspname <> 'public' AND nspname !~ '^pg_' AND nspname <> 'information_schema'",
  );
  for (const row of schemas.rows) await owner.query(`DROP SCHEMA IF EXISTS "${row.nspname}" CASCADE`);
  await owner.query('DROP SCHEMA IF EXISTS public CASCADE');
  await owner.query('CREATE SCHEMA public');
}

try {
  await preflightRuntimeRole();
  await resetDatabase();
  await migrationTriple();
  await tableShape();
  await provisionRoles();
  await leastPrivilege();
  await portArms();
  await httpArm();
  await nullPoolArm();
  await armingArm();
  await flagSurfaceArm();

  // 全绿之前再过一道身份闸：既有角色（含别的库在用的运行时角色）的认证材料必须一字不差。
  await checkRoleCredentials(true);

  note('[ALL PASS] feature_flags 持久化真库验收 ①–⑥ + 行锁判别 + 武装就绪探测 + 开关端到端产出面（[I]）全部取得');
} catch (error) {
  process.exitCode = 1;
  console.error('[FAIL]', error?.message ?? error);
  console.error(error?.stack ?? '');
  throw error;
} finally {
  // 失败路径也把读数打出来（只打印不抛，免得盖掉真正的失败原因）。
  await checkRoleCredentials(false).catch(() => {});
  await cleanup();
}
