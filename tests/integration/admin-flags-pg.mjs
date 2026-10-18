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
 * 覆盖（裁定 §4 的 ①–⑥）：
 *   [M] 迁移三连：UP → 三行全 false/revision=1 → DOWN（函数与表消失、审计表不越界）→ REPLAY
 *   [A] 表结构（闭集 CHECK / revision CHECK / changed_by FK 指向 admin_accounts）
 *   [P] 运行时角色：feature_flags 只可 SELECT；直接写/改/删/DDL 与审计读一律 42501；函数可 EXECUTE
 *   [B] 正常 commit：revision+1、changed_by/reason 落库、changed_at 变、审计恰 1 行（固定口径）
 *   [C] 陈旧 revision ⇒ ok:false REVISION_CONFLICT，行与审计都不变
 *   [D] 并发两笔同 revision ⇒ 恰一笔成功、一笔冲突、审计恰 1 行
 *   [E] 真实 HTTP：listFlags/PUT/If-Match 409/值未变短路/`/herbicides` 关→409 开→恢复 + 并发 PUT
 *   [F] `pool === null` 的 real 装配与今天逐字相同：后台 503 fail-closed、开关门不 armed
 *
 * 说明：本分支缺 `0018`/`0019`（在途 PR），故不跑 `migrations-negative-pg.mjs` 的「无缺号」断言；
 * 合并顺序 `#272`(0018) → 消息片(0019) → 本片(0020) → 账号读面片(0021)。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createPool } from '../../services/api/src/db/pool.ts';
import { createMemoryAuthStore, createPostgresAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { createPostgresFeatureFlags } from '../../services/api/src/admin/ops/flags-pg.ts';
import { CONTRACT_FLAG_KEYS } from '../../services/api/src/admin/ops/flags.ts';

const API = '/api/v1';
const DB = 'gengyun_flags_test';
const MIGRATION = '0020_feature_flags.sql';
const DOWN = 'migrations/rollback/0020_feature_flags.down.sql';
const FUNCTION_SIGNATURE = 'public.set_feature_flag(text,integer,boolean,uuid,uuid,uuid,text,text)';
const RUNTIME_ROLE = 'gengyun_api_runtime';
const GRANT_REGION = 'gy-i18-flags-grant';

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
  const discovered = readdirSync(migrationsDir)
    .filter((name) => /^\d{4,}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  const versions = discovered.map((name) => name.slice(0, 4));
  assert.equal(new Set(versions).size, versions.length, `迁移版本号重复：${versions.join(',')}`);
  assert.ok(discovered.includes(MIGRATION), `迁移清单必须含 ${MIGRATION}`);
  assert.equal(
    versions[versions.length - 1],
    '0020',
    `0020 必须是本分支最大号（在途 0018/0019 未合入，现场：${versions.join(',')}）`,
  );
  const missing = ['0018', '0019'].filter((version) => !versions.includes(version));
  note(`[M] 迁移清单 ${discovered.length} 个（${versions.join(',')}）；在途缺号：${missing.join(',') || '无'}；最大号 0020`);

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

async function provisionRoles() {
  const region = grantRegion();
  assert.equal(/^\s*(\\(echo|set|pset|if|endif|getenv|gexec))/m.test(region), false, '区域不得含 psql 元命令');
  assert.equal((region.match(/GRANT EXECUTE ON FUNCTION/g) ?? []).length, 1, '区域必须恰好一条 GRANT EXECUTE');
  assert.equal((region.match(/GRANT SELECT ON TABLE public\.feature_flags/g) ?? []).length, 1, '区域必须恰好一条 SELECT 授权');

  if (providedRuntimeUrl === null) {
    await owner.query(`DROP OWNED BY ${RUNTIME_ROLE}`).catch(() => {});
    await owner.query(`DROP ROLE IF EXISTS ${RUNTIME_ROLE}`).catch(() => {});
    await owner.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${runtimePassword}'`);
    const derived = new URL(ownerUrl.href);
    derived.username = RUNTIME_ROLE;
    derived.password = runtimePassword;
    runtimeUrl = derived;
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
  await resetDatabase();
  await migrationTriple();
  await tableShape();
  await provisionRoles();
  await leastPrivilege();
  await portArms();
  await httpArm();
  await nullPoolArm();
  note('[ALL PASS] feature_flags 持久化真库验收 ①–⑥ 全部取得');
} catch (error) {
  process.exitCode = 1;
  console.error('[FAIL]', error?.message ?? error);
  console.error(error?.stack ?? '');
  throw error;
} finally {
  await cleanup();
}
