/**
 * R29-S5（GY-I18 第一批）真库臂：后台 AI 作业读面 / 取消 / 开关变更留痕 / 投稿开关真实生效。
 *
 * 场景要点（每条都给「改前真红」的判别力）：
 *   [M] 0001→0027 全量应用：admin_audit_events 多出 before_value/after_value（jsonb、可空）；
 *       set_feature_flag 函数体自造前后值；list_admin_flag_audit 存在 / SECURITY DEFINER / PUBLIC 无 EXECUTE
 *   [P] 运行时角色最小权限：审计读函数可 EXECUTE、开关表可读；admin_audit_events 直读与作业表未授列直读 42501
 *   [A] A→B→A 两行审计的**行序与前后值**（不看这两项就等于只验了「有审计」）
 *   [J] GET /admin/jobs 真读三张域表；失败作业的 error_code 原样透出；普通账号 401/403；只读后台账号 cancel 403
 *   [C] 取消：revision 1→2、库内同值、`job.cancel` 审计**落库恰 1 行**（target_ref={job,id,revision:1}）；对终态作业 409 且不改写
 *   [E] submissions_enabled 关 ⇒ POST /posts 409 OBJECT_UNAVAILABLE(FLAG_CLOSED) + 零新增行；开 ⇒ 放行；
 *       同一 app 实例关→开→关立刻生效（反证读面无跨请求缓存）
 *
 * 用法：`node tests/integration/admin-jobs-pg.mjs [ownerUrl] [runtimeUrl]`
 *   ownerUrl 缺省 `postgres://postgres@127.0.0.1:5432/gengyun_admin_jobs_test`（只允许回环 + 硬钉库名）。
 *   runtimeUrl 省略时，脚本**只在自己本轮新建** `gengyun_api_runtime` 的前提下派生 URL；该角色若已在本集群
 *   存在则**拒绝运行**（角色与口令是集群级对象，专用测试库不授权本臂接管别的库也在用的运行时身份，
 *   见 `preflightRuntimeRole`）。要复用一个既有测试角色，必须用 argv[3] 显式给出它的既有凭据，本臂
 *   对该角色零 DDL（不 CREATE / 不 ALTER / 不改 LOGIN / 不改口令）。
 *   收尾用 `checkRoleCredentials` 复读 `pg_authid`，给出「既有角色（含别的业务角色）的密码未被改动」的负控制读数。
 *
 * 库内脚本自带 root 环境变量；不要把连接串写进仓库。
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

const API = '/api/v1';
const DB = 'gengyun_admin_jobs_test';
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
 * 既有角色认证材料快照。角色与其口令是**集群级**对象：同一个 `gengyun_api_runtime` 完全可能同时被
 * 别的库的客户端用来登录，硬钉库名只护住「库」、护不住「角色身份」。所以本臂只允许动自己本轮新建的
 * 角色，收尾前逐项比对这份快照（`checkRoleCredentials`）。
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
    `[M] 迁移清单 ${discovered.length} 个，与 discoverMigrations() 逐项一致；最大号 ${versions.at(-1)}`
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
    + `       node tests/integration/admin-jobs-pg.mjs <ownerUrl> postgres://${RUNTIME_ROLE}:<既有口令>@127.0.0.1:<port>/${DB}\n`
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

async function seedUserToken() {
  const user = await seedStore.createUser(subjectOf('00001818'));
  const token = mintOpaqueToken();
  await seedStore.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    audience: 'user',
  });
  return token;
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

// ===========================================================================
// [S5] 本片新增的真库臂：AI 作业读面/取消 · 开关变更留痕（A→B→A）· 投稿开关真阻断
// ===========================================================================
import { createPostgresAdminJobPort, ADMIN_JOB_LIST_LIMIT } from '../../services/api/src/admin/ops/jobs-pg.ts';

const SET_FLAG_SIGNATURE = 'public.set_feature_flag(text,integer,boolean,uuid,uuid,uuid,text,text)';
const LIST_AUDIT_SIGNATURE = 'public.list_admin_flag_audit(integer,timestamp with time zone,uuid)';
const AUDIT_GRANT_REGION = 'gy-i18-flag-audit-grant';
const API_V1 = (path) => `${API}${path}`;

const aclHasPublicExecute = async (signature) =>
  (await q(
    `SELECT EXISTS (
       SELECT 1 FROM pg_proc p,
                    aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
        WHERE p.oid = to_regprocedure($1) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
     ) AS public_exec`,
    [signature],
  ))[0].public_exec;

const aclGrantsExecuteTo = async (signature, role) =>
  (await q(
    `SELECT EXISTS (
       SELECT 1 FROM pg_proc p,
                    aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
        WHERE p.oid = to_regprocedure($1) AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = $2)
          AND a.privilege_type = 'EXECUTE'
     ) AS granted`,
    [signature, role],
  ))[0].granted;

// ---------------------------------------------------------------------------
// [M] 迁移：全量 0001→0027（真库）
// ---------------------------------------------------------------------------
async function migrationArm() {
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  const discovered = discoverMigrations().map((migration) => migration.filename).sort();
  assert.deepEqual(discovered, files, 'discoverMigrations() 的发现集合必须与迁移目录原始扫描逐项相等');
  assert.ok(files.includes('0027_admin_audit_observability.sql'), '迁移目录必须含 0027');
  for (const name of files) await owner.query(readSql(`migrations/${name}`));

  const cols = await q(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'admin_audit_events'
        AND column_name IN ('actor_id', 'target_hint', 'target_ref', 'before_value', 'after_value')`,
  );
  const byName = new Map(cols.map((col) => [col.column_name, col]));
  for (const name of ['before_value', 'after_value']) {
    const col = byName.get(name);
    assert.ok(col !== undefined, `admin_audit_events 必须新增 ${name} 列`);
    assert.equal(col.data_type, 'jsonb', `${name} 必须是 jsonb`);
    assert.equal(col.is_nullable, 'YES', `${name} 必须可空（历史行没有前后值）`);
  }
  assert.ok(byName.get('actor_id') !== undefined, '既有 actor_id 不得被改动');

  const writer = (await q(`SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure($1)`, [SET_FLAG_SIGNATURE]))[0];
  assert.ok(writer !== undefined, 'set_feature_flag 必须存在');
  assert.match(writer.prosrc, /before_value/, 'set_feature_flag 必须在同一条 INSERT 里写 before_value');
  assert.match(writer.prosrc, /after_value/, 'set_feature_flag 必须在同一条 INSERT 里写 after_value');

  const reader = (
    await q(
      `SELECT oid::regprocedure::text AS sig, prosecdef, proconfig
         FROM pg_proc WHERE oid = to_regprocedure($1)`,
      [LIST_AUDIT_SIGNATURE],
    )
  )[0];
  assert.ok(reader !== undefined, `审计读函数 ${LIST_AUDIT_SIGNATURE} 必须存在`);
  assert.equal(reader.prosecdef, true, '审计读函数必须 SECURITY DEFINER');
  assert.ok(
    (reader.proconfig ?? []).some((entry) => entry.startsWith('search_path=')),
    '审计读函数必须钉死 search_path',
  );
  assert.equal(await aclHasPublicExecute(LIST_AUDIT_SIGNATURE), false, 'PUBLIC 不得对审计读函数持有 EXECUTE');
  note(
    '[M] 0001→0027 全量应用（真 PG）：admin_audit_events 多出 before_value/after_value（jsonb、可空、未动 actor_id）；'
      + 'set_feature_flag 函数体自造前后值；list_admin_flag_audit 存在、SECURITY DEFINER、search_path 已钉、PUBLIC 无 EXECUTE',
  );
}

// ---------------------------------------------------------------------------
// [P] 运行时角色最小权限（出厂文件的两个区域原样执行）
// ---------------------------------------------------------------------------
async function runtimePrivilegeArm() {
  if (runtimeUrl === null) {
    unread('[P] 运行时角色最小权限（审计读函数）', '未提供运行时角色 URL（argv[3]），本机未取得');
    return;
  }
  await owner.query(regionOf(AUDIT_GRANT_REGION));
  assert.equal(await aclGrantsExecuteTo(LIST_AUDIT_SIGNATURE, RUNTIME_ROLE), true, '区域必须把 EXECUTE 授给运行时角色');
  assert.equal(await aclHasPublicExecute(SET_FLAG_SIGNATURE), false, 'PUBLIC 不得对 set_feature_flag 持有 EXECUTE');

  const client = new pg.Client({ connectionString: runtimeUrl.href });
  await client.connect();
  try {
    const readable = await client.query('SELECT key, enabled, revision FROM public.feature_flags');
    assert.equal(readable.rows.length, 3, '运行时角色必须能读三行开关');

    const denied = async (sql, label) => {
      let code = null;
      try {
        await client.query(sql);
      } catch (error) {
        code = error.code ?? null;
      }
      assert.equal(code, '42501', `${label} 必须 42501，实际 ${String(code)}`);
    };
    await denied('SELECT * FROM admin_audit_events', 'admin_audit_events 直接读');
    await denied("INSERT INTO ocr_jobs (id) VALUES (gen_random_uuid())", 'ocr_jobs 直接写');
    await denied("UPDATE ocr_jobs SET state = 'cancelled'", 'ocr_jobs 直接改');

    // 作业表的列级 SELECT 授权属于 0024/0025/0026 各自的出厂区域，本臂不重复执行那些区域
    // —— 因此这里断言的是「未授列就不能读」，而不是拿别人的授权顺手发一个读面。
    await denied('SELECT * FROM recognition_jobs LIMIT 1', 'recognition_jobs 未授列的直读');
    const audit = await client.query('SELECT * FROM public.list_admin_flag_audit(10, NULL, NULL)');
    assert.ok(Array.isArray(audit.rows), '运行时角色必须能调审计读函数');
    note(
      '[P] 运行时角色：feature_flags 三行可读、审计读函数可 EXECUTE；'
        + 'admin_audit_events 直读 42501、作业表未授列直读 42501（本臂不代发别人的列级授权）',
    );
  } finally {
    await client.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// [A] 开关变更留痕：A→B→A 两行、行序、前后值、actor
// ---------------------------------------------------------------------------
async function auditTrailArm(flagsPort, adminId) {
  const key = 'specific_herbicide_output_enabled';
  const first = await flagsPort.get(key);
  assert.equal(first.enabled, false, '种子必须为关');
  assert.equal(first.revision, 1, '种子 revision 必须为 1');

  const up = await flagsPort.commitIfCurrent(key, 1, { enabled: true }, {
    changedBy: adminId,
    reason: 'R29-S5 真库臂 A→B',
    requestId: randomUUID(),
  });
  assert.equal(up.ok, true, `第一次开启必须成功，实际 ${JSON.stringify(up)}`);
  const down = await flagsPort.commitIfCurrent(key, 2, { enabled: false }, {
    changedBy: adminId,
    reason: 'R29-S5 真库臂 B→A',
    requestId: randomUUID(),
  });
  assert.equal(down.ok, true, `第二次关闭必须成功，实际 ${JSON.stringify(down)}`);

  const rows = await q(
    `SELECT id, actor_id, action, scope, target_hint, target_ref, result, before_value, after_value, created_at
       FROM public.admin_audit_events WHERE target_hint = $1
      ORDER BY created_at DESC, id DESC`,
    [key],
  );
  assert.equal(rows.length, 2, `A→B→A 必须恰两行审计，实际 ${rows.length}`);
  const [newest, oldest] = rows;
  assert.equal(newest.action, 'set_flag');
  assert.equal(newest.scope, 'flags:write');
  assert.equal(newest.target_hint, key);
  assert.equal(newest.target_ref, null, '开关行的 target_ref 恒为 NULL（契约 TargetRef 无 flag 成员）');
  assert.equal(newest.result, 'accepted');
  assert.equal(newest.actor_id, adminId, 'actor_id 必须是真实操作者');
  assert.deepEqual(newest.before_value, { enabled: true, revision: 2 }, '新行的 before 必须是上一次的 after');
  assert.deepEqual(newest.after_value, { enabled: false, revision: 3 }, '新行的 after 必须是本次结果');
  assert.deepEqual(oldest.before_value, { enabled: false, revision: 1 });
  assert.deepEqual(oldest.after_value, { enabled: true, revision: 2 });
  note(
    '[A] A→B→A 两行审计：最新行 before={enabled:true,revision:2} after={enabled:false,revision:3}、'
      + '旧行 before={enabled:false,revision:1} after={enabled:true,revision:2}；actor_id=' + adminId.slice(0, 8)
      + '、target_hint 为裸 key、target_ref=NULL、action=set_flag/scope=flags:write/result=accepted',
  );

  const page = await flagsPort.listAudit({ limit: 10, before: null });
  assert.equal(page.items.length, 2, '端口读面必须返回两行');
  assert.equal(page.hasMore, false);
  assert.deepEqual(
    page.items.map((item) => item.id),
    rows.map((row) => row.id),
    '端口读面的键集顺序必须与 SQL 键集顺序一致（created_at DESC, id DESC）',
  );
  note('[A] 端口 listAudit 与 SQL 直读逐行同序同值（键集游标 (created_at,id) 降序）');
}

// ---------------------------------------------------------------------------
// [J] AI 作业读面 + [C] 取消（真库 + 真实 HTTP）
// ---------------------------------------------------------------------------
async function seedUserWithToken() {
  const user = await seedStore.createUser(subjectOf('00001818'));
  const token = mintOpaqueToken();
  await seedStore.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    audience: 'user',
  });
  return { id: user.id, token };
}

async function seedJobRows(userId) {
  const now = Date.now();
  const rows = {
    ocr: randomUUID(),
    recognition: randomUUID(),
    transcription: randomUUID(),
  };
  const at = (offsetMs) => new Date(now + offsetMs).toISOString();
  await owner.query(
    `INSERT INTO public.ocr_jobs (id, revision, kind, owner_user_id, ocr_id, media_id, media_revision,
                                  state, deadline_at, created_at, updated_at, error_code)
     VALUES ($1, 1, 'ocr', $2, $3, $4, 1, 'failed', $5, $5, $5, 'PROVIDER_TIMEOUT')`,
    [rows.ocr, userId, randomUUID(), randomUUID(), at(-3000)],
  );
  await owner.query(
    `INSERT INTO public.recognition_jobs (id, revision, kind, owner_user_id, recognition_id, media_id, media_revision,
                                          state, deadline_at, created_at, updated_at, error_code)
     VALUES ($1, 1, 'recognition', $2, $3, $4, 1, 'queued', $5, $5, $5, NULL)`,
    [rows.recognition, userId, randomUUID(), randomUUID(), at(-2000)],
  );
  await owner.query(
    `INSERT INTO public.speech_jobs (id, revision, kind, owner_user_id, transcription_id, media_id, media_revision,
                                     state, deadline_at, created_at, updated_at, error_code)
     VALUES ($1, 1, 'transcription', $2, $3, $4, 1, 'running', $5, $5, $5, NULL)`,
    [rows.transcription, userId, randomUUID(), randomUUID(), at(-1000)],
  );
  return rows;
}

async function jobsArm(app, jobsToken, userToken, userScopesAdminToken, jobsAdminId) {
  const port = createPostgresAdminJobPort({ pool: ownerPool });
  assert.equal(port.wired, true, '真库端口必须 wired=true');
  const viaPort = await port.list();
  assert.equal(viaPort.length, 3, '端口必须从三张域表读到三条作业');
  assert.deepEqual(
    viaPort.map((job) => job.kind),
    ['transcription', 'recognition', 'ocr'],
    '跨源合并后必须按 created_at DESC 排序（最新在前）',
  );
  note('[J] 端口 list：三源合并 3 条，顺序 transcription → recognition → ocr（created_at DESC, id DESC）');

  const listed = await injectCall(app, API_V1('/admin/jobs'), { token: jobsToken });
  assert.equal(listed.status, 200, `GET /admin/jobs 必须 200，实际 ${listed.status} ${listed.text.slice(0, 200)}`);
  const items = listed.body.data.items;
  assert.equal(items.length, 3);
  const ocr = items.find((item) => item.kind === 'ocr');
  assert.equal(ocr.state, 'failed');
  assert.equal(ocr.error_code, 'PROVIDER_TIMEOUT', '失败作业的错误分类必须原样透出（不折叠成 unknown）');
  assert.equal(ocr.target_ref.type, 'ocr');
  assert.equal(ocr.result, null, 'AdminJob.result 恒为 null（列表不带结果体）');
  assert.deepEqual(Object.keys(ocr).sort(), ['created_at', 'deadline_at', 'error_code', 'id', 'kind', 'result', 'revision', 'state', 'target_ref'].sort());
  note('[J] GET /admin/jobs 200：共 3 条；失败作业带 error_code=PROVIDER_TIMEOUT、target_ref.type=ocr、result=null；字段面恰契约 9 项');

  const forbidden = await injectCall(app, API_V1('/admin/jobs'), { token: userToken });
  assert.ok([401, 403].includes(forbidden.status), `普通用户读后台作业必须被拒，实际 ${forbidden.status}`);
  assert.ok(
    ['SESSION_REQUIRED', 'SESSION_EXPIRED', 'SCOPE_DENIED'].includes(forbidden.body.error.code),
    `普通用户必须是会话/权限拒绝，实际 ${forbidden.body.error.code}`,
  );
  const readOnlyAdmin = await injectCall(app, API_V1('/admin/jobs'), { token: userScopesAdminToken });
  assert.equal(readOnlyAdmin.status, 200, '只有 jobs:read 的后台账号可读');
  const cantCancel = await injectCall(app, API_V1(`/admin/jobs/${ocr.id}/cancel`), {
    method: 'POST',
    token: userScopesAdminToken,
    headers: { 'idempotency-key': randomUUID(), 'if-match': '"1"' },
    body: { reason: 'R29-S5 真库臂：越权取消探针' },
  });
  assert.equal(cantCancel.status, 403, `无 jobs:cancel 的后台账号必须 403，实际 ${cantCancel.status}`);
  assert.equal(cantCancel.body.error.code, 'SCOPE_DENIED');
  note('[J] 普通账号 401/403 无一例外；只有 jobs:read 的后台账号能读、但 cancel 被 403 SCOPE_DENIED（读面与写面分离）');

  // [C] 取消
  const target = items.find((item) => item.kind === 'recognition');
  const cancelled = await injectCall(app, API_V1(`/admin/jobs/${target.id}/cancel`), {
    method: 'POST',
    token: jobsToken,
    headers: { 'idempotency-key': randomUUID(), 'if-match': '"1"' },
    body: { reason: 'R29-S5 真库臂：取消排队作业' },
  });
  assert.equal(cancelled.status, 200, `取消 queued 作业必须 200，实际 ${cancelled.status} ${cancelled.text.slice(0, 200)}`);
  assert.equal(cancelled.body.data.state, 'cancelled');
  assert.equal(cancelled.body.data.revision, 2, '取消必须让 revision 1→2');
  const after = (await q('SELECT state, revision FROM public.recognition_jobs WHERE id = $1::uuid', [target.id]))[0];
  assert.deepEqual(after, { state: 'cancelled', revision: 2 }, '库内必须是 cancelled/revision=2');
  // 内容审计（job.cancel 等内容/作业类操作）走平台既有的审计读面；PG 里的 admin_audit_events
  // 只承载开关变更（存储函数内写）。两条路径都要“可查”，但不得互相冒充。
  // 审计边界（真读数）：内容审计读面在 real 模式下由“账号依赖”边界失闭（503）。
  // **R18（迁移 0043）**：`job.cancel` 的审计行已从**进程内存落库** —— 成功取消时由
  // `public.record_admin_job_cancel_audit(...)`（窄口径 SECURITY DEFINER，运行时不持有
  // `admin_audit_events` 任何直写权）在同一请求里写一行。本臂因此不再拿“单元测试覆盖”替身，
  // 而是直接钉「库内**恰 1 行** + 字段逐项正确」；内存路径仍由
  // `tests/unit/admin-ops-job-integrity.test.mjs:161` 覆盖（stub 域口径未变）。
  const cancelAudit = await q(
    `SELECT actor_id, action, scope, target_ref, target_hint, reason_code, result, request_id
       FROM public.admin_audit_events
      WHERE action = 'job.cancel'`,
  );
  assert.equal(
    cancelAudit.length,
    1,
    `job.cancel 审计必须**恰 1 行**落在 public.admin_audit_events，实际 ${cancelAudit.length} 行：${JSON.stringify(cancelAudit)}`,
  );
  assert.deepEqual(
    cancelAudit[0].actor_id,
    jobsAdminId,
    '审计行 actor 必须是本次取消的后台账号 id（不得被调用方伪造）',
  );
  assert.equal(cancelAudit[0].action, 'job.cancel');
  assert.equal(cancelAudit[0].scope, 'jobs:cancel');
  assert.deepEqual(
    cancelAudit[0].target_ref,
    { type: 'job', id: target.id, revision: 1 },
    `target_ref 必须是 {type:'job', id, revision}，且 revision 是**取消前**的 1，实际 ${JSON.stringify(cancelAudit[0].target_ref)}`,
  );
  assert.equal(cancelAudit[0].target_hint, null, '作业取消的 target_hint 必须是 null（不是 account:/flag 形态）');
  assert.equal(cancelAudit[0].reason_code, 'job_cancelled');
  assert.equal(cancelAudit[0].result, 'accepted');
  assert.match(
    String(cancelAudit[0].request_id),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    '审计行 request_id 必须是本次请求的 uuid（NOT NULL 列，不是占位字符串）',
  );
  const auditFeed = await injectCall(app, API_V1('/admin/audit-events?limit=20'), { token: jobsToken });
  assert.equal(auditFeed.status, 503, `real 模式内容审计读面必须失闭，实际 ${auditFeed.status}`);
  assert.equal(auditFeed.body.error.code, 'PROVIDER_UNAVAILABLE');
  note('[C] POST /admin/jobs/{id}/cancel 200：state=cancelled、revision 1→2（库内同值）；R18 起 job.cancel 审计行**落库恰 1 行**（actor=操作者、scope=jobs:cancel、target_ref={job,id,revision:1}、reason=job_cancelled、result=accepted）；内容审计读面仍如实失闭 503 PROVIDER_UNAVAILABLE');

  const terminal = items.find((item) => item.kind === 'ocr');
  const refused = await injectCall(app, API_V1(`/admin/jobs/${terminal.id}/cancel`), {
    method: 'POST',
    token: jobsToken,
    headers: { 'idempotency-key': randomUUID(), 'if-match': '"1"' },
    body: { reason: 'R29-S5 真库臂：终态不可取消' },
  });
  assert.equal(refused.status, 409, `对终态作业取消必须 409，实际 ${refused.status}`);
  const untouched = (await q('SELECT state, revision FROM public.ocr_jobs WHERE id = $1::uuid', [terminal.id]))[0];
  assert.deepEqual(untouched, { state: 'failed', revision: 1 }, '终态作业不得被改写');
  note(`[C] 终态作业取消 ⇒ 409 ${refused.body.error.code}，库内仍 failed/revision=1（终态不可迁移）`);
}

// ---------------------------------------------------------------------------
// [E] 投稿开关真实阻断：关⇒409+零新增；开⇒真实写成功；同一实例立即生效
// ---------------------------------------------------------------------------
async function postingsFlagArm(app, flagsPort, adminId, user) {
  const count = async () => (await q('SELECT count(*)::int AS c FROM public.community_posts'))[0].c;
  assert.equal(await count(), 0, '起点必须零行');
  const idem = () => ({ 'idempotency-key': randomUUID() });
  const post = () =>
    injectCall(app, API_V1('/posts'), {
      method: 'POST',
      token: user.token,
      headers: idem(),
      body: { title: 'R29-S5 真库臂投稿', body: '开关关闭时这条不得落库；打开后必须真写入。', media_ids: [] },
    });

  const closed = await post();
  assert.equal(closed.status, 409, `开关关闭时投稿必须 409，实际 ${closed.status} ${closed.text.slice(0, 200)}`);
  assert.equal(closed.body.error.code, 'OBJECT_UNAVAILABLE');
  assert.ok(
    (closed.body.error.details ?? []).some((detail) => detail.code === 'FLAG_CLOSED'),
    '409 必须带 FLAG_CLOSED 证据',
  );
  assert.equal(await count(), 0, '被开关拦下的投稿不得留下任何行');
  note('[E] submissions_enabled=false ⇒ POST /posts 409 OBJECT_UNAVAILABLE(FLAG_CLOSED)，community_posts 仍 0 行');

  // 合成授权账本（本脚本验的是开关生数，不是授权链路；授权闸仍按真实实现执行）
  const grant = await injectCall(app, API_V1('/me/consents'), {
    method: 'POST',
    token: user.token,
    headers: idem(),
    body: { purpose: 'public_posting', policy_version: 'synthetic-test-policy-v1', recipient_ids: [] },
  });
  let consentNote;
  if (grant.status < 300) {
    consentNote = `public_posting 授权已合成入账（${grant.status}）`;
  } else {
    consentNote = `public_posting 授权合成未取得（${grant.status} ${grant.body?.error?.code ?? ''}）`;
  }

  const open = await flagsPort.commitIfCurrent('submissions_enabled', 1, { enabled: true }, {
    changedBy: adminId,
    reason: 'R29-S5 真库臂：打开投稿',
    requestId: randomUUID(),
  });
  assert.equal(open.ok, true, '打开投稿开关必须成功');

  const allowed = await post();
  if (allowed.status < 300) {
    assert.equal(await count(), 1, '开关打开后投稿必须真落库一行');
    note(`[E] 打开开关后同一 app 实例立刻放行：POST /posts ${allowed.status}，community_posts 0→1 行（${consentNote}）`);
  } else {
    assert.notEqual(
      allowed.body?.error?.code,
      'OBJECT_UNAVAILABLE',
      '开关打开后不得再以 OBJECT_UNAVAILABLE 拦截（否则说明在读陈旧缓存）',
    );
    unread(
      '[E] 开关打开后的真实写入',
      `放行到授权闸后仍未成功（${allowed.status} ${allowed.body?.error?.code ?? ''}，${consentNote}）；`
        + '本脚本不伪造授权链路，故只取得「不再被开关拦截」这一半',
    );
  }

  const close = await flagsPort.commitIfCurrent('submissions_enabled', 2, { enabled: false }, {
    changedBy: adminId,
    reason: 'R29-S5 真库臂：关闭投稿',
    requestId: randomUUID(),
  });
  assert.equal(close.ok, true, '关闭投稿开关必须成功');
  const closedAgain = await post();
  assert.equal(closedAgain.status, 409, `再次关闭后必须立刻 409（反证无陈旧缓存），实际 ${closedAgain.status}`);
  assert.equal(await count(), allowed.status < 300 ? 1 : 0, '关闭后的投稿不得再增行');
  note('[E] 再次关闭 ⇒ 同一实例立刻回到 409：开关读面没有跨请求缓存（关→开→关三次读数与库内一致）');
}

const regionOf = (name) => {
  const matched = deploySql('20-login-roles.sql').match(
    new RegExp(`-- #region ${name}\\r?\\n([\\s\\S]*?)\\r?\\n\\s*-- #endregion ${name}`),
  );
  assert.ok(matched !== null, `20-login-roles.sql 必须含 ${name} 区域`);
  return matched[1];
};


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
  await migrationArm();
  await provisionRoles();
  await runtimePrivilegeArm();

  const flagsPort = createPostgresFeatureFlags({ pool: ownerPool });
  const fullAdmin = await seedAdmin(['jobs:read', 'jobs:cancel', 'flags:read', 'flags:write', 'audit:read']);
  await auditTrailArm(flagsPort, fullAdmin.adminId);

  const user = await seedUserWithToken();
  const rows = await seedJobRows(user.id);

  const app = buildApp({
    config: loadConfig(REAL_ENV),
    pool: ownerPool,
    wechat: wechatPort,
    now: () => new Date(),
    consentGrantTestOptions: { allowSyntheticGrantPolicy: true },
  });
  registeredApps.push(app);
  await app.ready();
  assert.equal(app.featureFlagGate.armed, true, '表就绪 ⇒ 开关门必须武装');

  const readOnlyAdmin = await seedAdmin(['jobs:read']);
  await jobsArm(app, fullAdmin.token, user.token, readOnlyAdmin.token, fullAdmin.adminId);
  await postingsFlagArm(app, flagsPort, fullAdmin.adminId, user);

  const auditHttp = await injectCall(app, API_V1('/admin/flag-audit-events?limit=1'), { token: fullAdmin.token });
  assert.equal(auditHttp.status, 200, `GET /admin/flag-audit-events 必须 200，实际 ${auditHttp.status} ${auditHttp.text.slice(0, 300)}`);
  const firstPage = auditHttp.body.data;
  assert.equal(firstPage.items.length, 1, 'limit=1 必须只回一行');
  assert.ok(firstPage.next_cursor !== null, '还有下一页时首页必须给出 next_cursor');
  const row = firstPage.items[0];
  for (const field of ['actor', 'target_hint', 'before_value', 'after_value']) {
    assert.ok(field in row, `契约 AuditEvent 必须暴露可选字段 ${field}`);
  }
  assert.equal(row.actor, fullAdmin.adminId, 'actor 必须是真实操作者 id');
  assert.equal(row.target_hint, 'submissions_enabled', 'target_hint 必须指出改的是哪个开关');
  assert.deepEqual(row.before_value, { enabled: true, revision: 2 });
  assert.deepEqual(row.after_value, { enabled: false, revision: 3 });
  const cursor = firstPage.next_cursor;
  assert.ok(typeof cursor === 'string' && cursor.length > 0, '首页必须给出游标');
  const secondPage = await injectCall(app, API_V1(`/admin/flag-audit-events?limit=1&cursor=${encodeURIComponent(cursor)}`), {
    token: fullAdmin.token,
  });
  assert.equal(secondPage.status, 200);
  assert.equal(secondPage.body.data.items.length, 1, '第二页必须仍有一行');
  assert.notEqual(secondPage.body.data.items[0].id, row.id, '键集游标不得重复上一页的行');
  note('[E] GET /admin/flag-audit-events 走真实 HTTP：可选字段 actor/target_hint/before_value/after_value 全部出网；键集游标翻页不重不漏');

  // [F] 作业台列表服务端过滤（本片新增；独立场景段，定义见文件末尾）。
  await jobsFilterArm(app, fullAdmin.token, user.id);

  // 全绿之前再过一道身份闸：既有角色（含别的库在用的运行时角色）的认证材料必须一字不差。
  await checkRoleCredentials(true);

  note('[ALL PASS] R29-S5 真库臂 ①开关真实生效 ②作业/错误可见 ③变更留痕 A→B ④最小权限 全部取得');
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

// ===========================================================================
// [F] 作业台列表服务端过滤（issue #18 本片新增）：`state` / `error_code` 下推到 SQL
//     —— 独立场景段，追加在本文件末尾；上方的 [M]/[P]/[A]/[J]/[C]/[E] 臂一行未改。
// ===========================================================================
/**
 * 判别力：改动前 `listSql` 没有 WHERE，`?state=failed` 会**静默返回全量**（5 条），
 * 于是下面每条「只回 N 条」的断言在改动前都是真红；闭集外取值在改动前不校验（同样真红）。
 */
async function jobsFilterArm(app, jobsToken, userId) {
  // 追加两行专用种子：同 state、不同 error_code，再加上一行别的 state —— 过滤才有「二选一」的判别力。
  // 只在本臂（脚本最后一段）插入，且新 id 不出现在任何既有断言里。
  const extra = { failed: randomUUID(), succeeded: randomUUID() };
  const now = Date.now();
  const at = (offsetMs) => new Date(now + offsetMs).toISOString();
  await q(
    `INSERT INTO public.recognition_jobs (id, revision, kind, owner_user_id, recognition_id, media_id, media_revision,
                                          state, deadline_at, created_at, updated_at, error_code)
     VALUES ($1, 1, 'recognition', $2, $3, $4, 1, 'failed', $5, $5, $5, 'PROVIDER_QUOTA_EXCEEDED')`,
    [extra.failed, userId, randomUUID(), randomUUID(), at(-500)],
  );
  await q(
    `INSERT INTO public.speech_jobs (id, revision, kind, owner_user_id, transcription_id, media_id, media_revision,
                                     state, deadline_at, created_at, updated_at, error_code)
     VALUES ($1, 1, 'transcription', $2, $3, $4, 1, 'succeeded', $5, $5, $5, NULL)`,
    [extra.succeeded, userId, randomUUID(), randomUUID(), at(-250)],
  );

  // ① 不加过滤 ≡ 改动前的全量读面（本片没有偷偷改变默认语义）
  const unfiltered = await injectCall(app, API_V1('/admin/jobs'), { token: jobsToken });
  assert.equal(unfiltered.status, 200);
  assert.equal(unfiltered.body.data.items.length, 5, '不加过滤必须仍回全量（3 条既有 + 2 条本臂种子）');
  note('[F] 不加过滤 ≡ 全量：5 条（三源合并 + 本臂两条种子），默认语义未变');

  // ② state 过滤：库里两条 failed（ocr + 本臂 recognition），SQL 必须收敛到 2 条
  const byState = await injectCall(app, API_V1('/admin/jobs?state=failed'), { token: jobsToken });
  assert.equal(byState.status, 200, `?state=failed 必须 200，实际 ${byState.status} ${byState.text.slice(0, 200)}`);
  assert.equal(byState.body.data.items.length, 2, '?state=failed 必须只回两条失败作业（改动前会回 5 条 ⇒ 真红）');
  assert.deepEqual(byState.body.data.items.map((item) => item.state), ['failed', 'failed'], '过滤后每条都必须是 failed');
  assert.deepEqual(byState.body.data.items.map((item) => item.kind), ['recognition', 'ocr'], '过滤后仍按 created_at DESC 排序');
  note('[F] GET /admin/jobs?state=failed ⇒ 200 / 2 条（recognition, ocr），逐条 state=failed');

  // ③ error_code 过滤：按 `varchar` 文本列比较，闭集值原样透出
  const byError = await injectCall(app, API_V1('/admin/jobs?error_code=PROVIDER_QUOTA_EXCEEDED'), { token: jobsToken });
  assert.equal(byError.status, 200);
  assert.equal(byError.body.data.items.length, 1, '?error_code=… 必须只回一条');
  assert.equal(byError.body.data.items[0].kind, 'recognition');
  assert.equal(byError.body.data.items[0].error_code, 'PROVIDER_QUOTA_EXCEEDED');
  note('[F] GET /admin/jobs?error_code=PROVIDER_QUOTA_EXCEEDED ⇒ 200 / 1 条（recognition），error_code 原样透出');

  // ④ 两个条件同时给：AND 语义（$2/$3 顺序绑定）
  const both = await injectCall(app, API_V1('/admin/jobs?state=failed&error_code=PROVIDER_TIMEOUT'), { token: jobsToken });
  assert.equal(both.status, 200);
  assert.equal(both.body.data.items.length, 1, 'state+error_code 必须 AND 收敛到一条');
  assert.equal(both.body.data.items[0].kind, 'ocr');
  note('[F] state=failed&error_code=PROVIDER_TIMEOUT ⇒ 200 / 1 条（ocr）：两条件 AND，不是 OR');

  // ⑤ 匹配不到 ⇒ 200 空页（不是 404、不是 503）
  const emptyHit = await injectCall(app, API_V1('/admin/jobs?state=queued'), { token: jobsToken });
  assert.equal(emptyHit.status, 200, `匹配不到必须 200 空页，实际 ${emptyHit.status}`);
  assert.deepEqual(emptyHit.body.data.items, [], 'queue 里已无作业（recognitions 那条已被上面的取消臂改成 cancelled）');
  assert.equal(emptyHit.body.data.next_cursor, null, '空页不得给游标');
  note('[F] ?state=queued ⇒ 200 空页（items=[]、next_cursor=null）：过滤不是 404 也不是 503');

  // ⑥ 闭集外入参 ⇒ 400 INVALID_REQUEST（⛔ 不是 503：那是「读出来的值不认识」）
  const badState = await injectCall(app, API_V1('/admin/jobs?state=FAILED'), { token: jobsToken });
  assert.equal(badState.status, 400, `闭集外 state 必须 400，实际 ${badState.status}`);
  assert.equal(badState.body.error.code, 'INVALID_REQUEST');
  assert.ok(
    (badState.body.error.details ?? []).some((detail) => detail.field === 'state' && detail.code === 'enum'),
    '400 必须带 details[{field:state,code:enum}] 证据',
  );
  const badErrorCode = await injectCall(app, API_V1('/admin/jobs?error_code=NOT_A_CODE'), { token: jobsToken });
  assert.equal(badErrorCode.status, 400, `闭集外 error_code 必须 400，实际 ${badErrorCode.status}`);
  assert.equal(badErrorCode.body.error.code, 'INVALID_REQUEST');
  assert.ok(
    (badErrorCode.body.error.details ?? []).some((detail) => detail.field === 'error_code' && detail.code === 'enum'),
    '400 必须带 details[{field:error_code,code:enum}] 证据',
  );
  note('[F] ?state=FAILED / ?error_code=NOT_A_CODE ⇒ 400 INVALID_REQUEST（details 指出字段与 enum），不是 503');

  // ⑦ 游标绑「筛选组合」：换了筛选必须回第一页（沿用无过滤得到的游标 ⇒ INVALID_CURSOR）
  const firstPage = await injectCall(app, API_V1('/admin/jobs?limit=2'), { token: jobsToken });
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.body.data.items.length, 2);
  const cursor = firstPage.body.data.next_cursor;
  assert.ok(typeof cursor === 'string' && cursor.length > 0, '还有下一页时首页必须给出 next_cursor');
  const crossed = await injectCall(app, API_V1(`/admin/jobs?state=failed&limit=2&cursor=${encodeURIComponent(cursor)}`), {
    token: jobsToken,
  });
  assert.equal(crossed.status, 400, `拿全量游标去翻过滤结果必须 400，实际 ${crossed.status}`);
  assert.equal(crossed.body.error.code, 'INVALID_CURSOR');
  note('[F] 游标绑筛选组合：全量页的 cursor 换到 ?state=failed 上 ⇒ 400 INVALID_CURSOR');

  // ⑧ 过滤 + 分页：同一组筛选内翻页不重不漏
  const pageOne = await injectCall(app, API_V1('/admin/jobs?state=failed&limit=1'), { token: jobsToken });
  assert.equal(pageOne.status, 200);
  assert.equal(pageOne.body.data.items.length, 1, 'limit=1 必须只回一行');
  assert.ok(pageOne.body.data.next_cursor !== null, '还有一页时首页必须给出 next_cursor');
  const pageTwo = await injectCall(
    app,
    API_V1(`/admin/jobs?state=failed&limit=1&cursor=${encodeURIComponent(pageOne.body.data.next_cursor)}`),
    { token: jobsToken },
  );
  assert.equal(pageTwo.status, 200);
  assert.equal(pageTwo.body.data.items.length, 1, '第二页必须仍有一行');
  assert.notEqual(pageTwo.body.data.items[0].id, pageOne.body.data.items[0].id, '键集游标不得重复上一页的行');
  note('[F] ?state=failed&limit=1 两页：1+1 行、不重不漏（游标在同一筛选组合内可用）');

  // ⑨ 端口直调：过滤由端口下推到 SQL（不经 HTTP 也一样），非法值同样 400
  const port = createPostgresAdminJobPort({ pool: ownerPool });
  const viaPort = await port.list({ state: 'failed' });
  assert.deepEqual(viaPort.map((job) => job.kind), ['recognition', 'ocr'], '端口 list({state}) 必须交出过滤后的两行');
  await assert.rejects(
    () => port.list({ state: 'FAILED' }),
    (error) => error.code === 'INVALID_REQUEST',
    '端口直调闭集外取值也必须 400 INVALID_REQUEST',
  );
  note('[F] 端口直调 list({state:"failed"}) ⇒ 2 条；list({state:"FAILED"}) ⇒ 拒绝 INVALID_REQUEST（读面自带闭集校验）');
}
