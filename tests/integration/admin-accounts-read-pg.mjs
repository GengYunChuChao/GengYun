// GY-I18（#18）· 后台账号读面 `GET /admin/accounts` 接真实 `public.users` · 真实 PostgreSQL 17.11 证据
//
// 运行（本机隔离集群，仅回环；库名硬钉，要求空库）：
//   createdb -h 127.0.0.1 -p <port> gengyun_admin_accounts_read_test
//   node tests/integration/admin-accounts-read-pg.mjs \
//     postgres://<owner>@127.0.0.1:<port>/gengyun_admin_accounts_read_test \
//     postgres://gengyun_api_runtime:<pw>@127.0.0.1:<port>/gengyun_admin_accounts_read_test
//
// 第二个参数（运行时角色 URL）可省略：省略时只跑「库侧 + 权限侧」证据，**HTTP 证据**会被标为
// `未取得（缺运行时角色 URL）` —— 不允许被读成通过。
//
// 本脚本只讲一件事：**账号读面是一个窄口径 `SECURITY DEFINER` 函数（迁移 0021）**。运行时角色
// `gengyun_api_runtime` 对 `public.users` 的 `nickname` / `created_at` **仍然没有任何 SELECT 权限**
// （`42501`），读面之所以能回答，是因为它只拿到 `public.list_admin_accounts()` 的 EXECUTE。
// 换句话说：**放行的是能力，不是权限面**。
//
// 覆盖的读数（编号与派单 §3 对齐）：
//   [M] 迁移三连：全链应用（目录内全部迁移，按目录序）⇒ 函数存在且 `SECURITY DEFINER` / `search_path=pg_catalog` /
//       属主非运行时 ⇒ ROLLBACK（函数消失、0017 的 `admin_account_display_name` 仍在）⇒ REPLAY（再出现）；
//   [P] 最小权限反向控制（运行时角色）：`SELECT nickname/created_at FROM users` 与派单逐字 SQL 一律
//       `42501`；`SELECT id,revision,state FROM users` 成功（行级可达，缺的只是那两列）；
//       而 `SELECT * FROM public.list_admin_accounts()` 成功且**恰好四列**；
//   [H] HTTP（真实模式装配）：插 3 个用户（active / suspended / deletion_pending；一个 nickname 为 NULL、
//       一个为纯空白）⇒ `GET /admin/accounts` 200、恰好 3 条、`created_at` 序、字段集合恰好
//       `{id,revision,state,display_name}`、NULL/空白 nickname ⇒ 非空回退名（契约 minLength:1）、
//       正文不含 wechat/cipher/lookup/auth_epoch/deletion_generation、游标翻页正确；
//       负控制：只有 `accounts:suspend` 的管理员 ⇒ 403 `SCOPE_DENIED`；无令牌 ⇒ 401；
//   [S] `90-assert-least-privilege.sql` 的整体 verdict（含本片新增的函数级/列级断言）。
//
// 未取得（如实登记，见证据页与交接）：真机、后台 UI 联调、超 1 万账号规模、HTTP 层之外的审计。

import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';

import { loadConfig } from '../../services/api/src/config.ts';
import { buildApp } from '../../services/api/src/app.ts';
import { createPool } from '../../services/api/src/db/pool.ts';
import { discoverMigrations } from '../../services/api/src/db/migrate.ts';
import { createPostgresAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';

const API = '/api/v1';
const DB = 'gengyun_admin_accounts_read_test';
const MIGRATION = '0021_admin_accounts_read.sql';
const DOWN = 'migrations/rollback/0021_admin_accounts_read.down.sql';
const RUNTIME_ROLE = 'gengyun_api_runtime';

const ownerUrl = new URL(process.argv[2] ?? `postgres://postgres@127.0.0.1:5432/${DB}`);
assert.equal(ownerUrl.hostname, '127.0.0.1', '本测试只允许回环地址');
assert.equal(ownerUrl.pathname, `/${DB}`, `库名必须硬钉为 ${DB}（防误连）`);
const runtimeArg = process.argv[3];
const runtimeUrl = runtimeArg === undefined ? null : new URL(runtimeArg);
if (runtimeUrl !== null) {
  assert.equal(runtimeUrl.hostname, '127.0.0.1', '运行时 URL 也只允许回环地址');
  assert.equal(runtimeUrl.pathname, `/${DB}`, '运行时 URL 必须连同一个硬钉库');
  assert.equal(decodeURIComponent(runtimeUrl.username), RUNTIME_ROLE, `运行时 URL 的用户必须是 ${RUNTIME_ROLE}`);
}

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
/** 建过但未关闭的 app 实例：不关会让 node 进程挂着不退出（本片踩过：ALL PASS 后仍不退出）。 */
const registeredApps = [];
await owner.connect();
const ownerPool = new pg.Pool({ connectionString: ownerUrl.href });
const seedStore = createPostgresAuthStore({ query: (text, params) => ownerPool.query(text, params) });

const q = async (text, params = []) => (await owner.query(text, params)).rows;
const one = async (text, params = []) => (await q(text, params))[0];

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
  note(`[M] 迁移清单 ${discovered.length} 个，版本号无重复，含 ${MIGRATION}（目录最大号 ${versions[versions.length - 1]}，现算）`);

  const objects = async () => ({
    read: (await one("SELECT to_regprocedure('public.list_admin_accounts()') AS v")).v,
    display: (await one("SELECT to_regprocedure('public.admin_account_display_name(text,uuid)') AS v")).v,
    users: (await one("SELECT to_regclass('public.users') AS v")).v,
  });
  const shape = async () => {
    const row = await one(
      `SELECT p.prosecdef AS secdef,
              p.proconfig AS config,
              pg_get_userbyid(p.proowner) AS owner,
              pg_get_function_result(p.oid) AS returns
         FROM pg_proc AS p
        WHERE p.oid = 'public.list_admin_accounts()'::regprocedure`,
    );
    return row;
  };

  // UP：全链按目录序应用（每一片都应用；0021 依赖 0017 的 display_name）。
  const applied = [];
  for (const name of discovered) {
    await owner.query(readSql(`migrations/${name}`));
    applied.push(name.slice(0, 4));
  }
  assert.deepEqual(applied, versions, `本脚本必须按目录序把全部迁移应用一遍（现场：${applied.join(',')}）`);
  // 结构不变量（在 main 上恒成立、不随 main 前进变假）：实际应用序必须与**迁移器**发现的版本序
  // 逐项相等。比对对象是产品侧 `discoverMigrations()`（独立于本文件的正则扫描）⇒ 不是自比：
  // 发现器漏项／多项／错序，或本文件的扫描口径与发现器分叉，这里都会红。
  const runnerVersions = discoverMigrations().map((migration) => migration.version);
  assert.deepEqual(
    applied,
    runnerVersions,
    '全链应用序必须与 discoverMigrations() 的发现序逐项相等（发现器漏项／多项／错序都算失败）'
      + `；应用：${applied.join(',')}；发现器：${runnerVersions.join(',')}`,
  );
  // 「0021 是本脚本的对象」用**包含**表达：⛔ 不再钉「末项」（那只是分支时点事实，main 一前进必红）。
  assert.ok(
    applied.includes(MIGRATION.slice(0, 4)),
    `全链必须包含 ${MIGRATION.slice(0, 4)}（本脚本对象在位；现场：${applied.join(',')}）`,
  );
  let state = await objects();
  assert.ok(state.read && state.display && state.users, 'UP 后读函数、0017 投影函数、users 表必须都在');
  let fn = await shape();
  assert.equal(fn.secdef, true, '读函数必须是 SECURITY DEFINER');
  assert.ok(Array.isArray(fn.config) && fn.config.includes('search_path=pg_catalog'), `search_path 必须固定为 pg_catalog（现场：${JSON.stringify(fn.config)}）`);
  assert.notEqual(fn.owner, RUNTIME_ROLE, '函数属主不得是运行时角色（否则等于给运行时 DDL 权）');
  assert.match(fn.returns, /id uuid, revision integer, state user_state, display_name text/, `返回列必须恰好四列（现场：${fn.returns}）`);
  note(`[M] UP：public.list_admin_accounts() 出现；SECURITY DEFINER=true；search_path=${JSON.stringify(fn.config)}；属主=${fn.owner}；返回=${fn.returns}`);

  // ROLLBACK（本片同片交付的回滚脚本，原样执行）
  await owner.query(readSql(DOWN));
  state = await objects();
  assert.equal(state.read, null, 'ROLLBACK 后读函数必须消失');
  assert.ok(state.display && state.users, '回滚不得触碰 0017 的投影函数与 0001 的 users 表');
  note('[M] ROLLBACK：list_admin_accounts() 消失；admin_account_display_name(text,uuid) 与 users 仍在（回滚不越界）');

  // REPLAY
  await owner.query(readSql(`migrations/${MIGRATION}`));
  state = await objects();
  fn = await shape();
  assert.ok(state.read && state.display && state.users && fn.secdef === true, 'REPLAY 后必须完整恢复');
  note('[M] REPLAY：读函数再次出现且仍为 SECURITY DEFINER（迁移可重放）');
}

/** 本脚本会创建的角色名（全部是出厂文件里的固定名字；只在这个一次性集群里出现）。 */
const ROLE_NAMES = [
  'gengyun_auth_privacy',
  'gengyun_preview_reader',
  'gengyun_evidence_reader',
  'gengyun_consent_granter',
  'gengyun_profile_runtime',
  'gengyun_knowledge_runtime',
  RUNTIME_ROLE,
];

/**
 * 幂等重置：让同一个一次性集群可以反复跑。
 * 角色是 **cluster 级**对象（`dropdb` 不会带走它），且成员关系会阻止 `DROP ROLE`，
 * 因此必须先删运行时登录角色、再删它所属的 NOLOGIN 组；`DROP OWNED BY` 清掉本库里的授权残留。
 */
async function resetRoles() {
  for (const name of [RUNTIME_ROLE, ...ROLE_NAMES.filter((role) => role !== RUNTIME_ROLE)]) {
    await owner.query(`DROP OWNED BY ${name}`).catch(() => {});
    await owner.query(`DROP ROLE IF EXISTS ${name}`).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 角色与授权（执行**出厂文件**里的区域，不复制粘贴 SQL）
// ---------------------------------------------------------------------------
async function provisionRoles() {
  await resetRoles();
  for (const file of ['auth_privacy', 'catalog_readers', 'consent_granter', 'profile_runtime', 'knowledge_runtime']) {
    await owner.query(readSql(`roles/${file}.sql`));
  }
  // 角色口令：有运行时 URL 时沿用 URL 里的口令（本地一次性集群、仅回环），否则随机——
  // 保证 argv[3] 传入的连接串在 provisionRoles 之后真的能连上。
  const runtimePassword = runtimeUrl === null ? randomBytes(24).toString('hex') : decodeURIComponent(runtimeUrl.password);
  assert.ok(runtimePassword.length > 0, '运行时 URL 必须带口令');
  await owner.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${runtimePassword.replace(/'/g, "''")}'`);
  await owner.query(
    `GRANT gengyun_auth_privacy, gengyun_preview_reader, gengyun_consent_granter,
           gengyun_profile_runtime, gengyun_knowledge_runtime TO ${RUNTIME_ROLE}`,
  );
  // 出厂 20-login-roles.sql 的三个函数授权区域：本片只**新增**第三个；前两个是 0016/0017 的既有口径，
  // 一并执行是为了让 `90-assert-least-privilege.sql`（它断言三者都只授给运行时）在本集群可整体求值。
  const REGIONS = [
    { name: 'gy-i19-deletion-grant', grants: 1 },
    { name: 'gy-i22-suspend-grant', grants: 3 },
    { name: 'gy-i18-accounts-read-grant', grants: 1 },
  ];
  for (const { name, grants } of REGIONS) {
    const matched = deploySql('20-login-roles.sql').match(
      new RegExp(`-- #region ${name}\\r?\\n([\\s\\S]*?)\\r?\\n\\s*-- #endregion ${name}`),
    );
    assert.ok(matched !== null, `20-login-roles.sql 必须含 ${name} 区域`);
    const region = matched[1];
    assert.equal(/^\s*(\\(echo|set|pset|if|endif|getenv|gexec))/m.test(region), false, `${name} 区域不得含 psql 元命令`);
    assert.equal((region.match(/GRANT EXECUTE ON FUNCTION/g) ?? []).length, grants, `${name} 区域必须恰好 ${grants} 条 GRANT EXECUTE`);
    await owner.query(region);
  }
  const canExecute = await one("SELECT has_function_privilege($1, 'public.list_admin_accounts()', 'EXECUTE') AS v", [RUNTIME_ROLE]);
  assert.equal(canExecute.v, true, '运行时角色必须拿到 EXECUTE');
  note('[P] 已按出厂区域 gy-i18-accounts-read-grant 授予 EXECUTE（恰好 1 条：list_admin_accounts）');
}

// ---------------------------------------------------------------------------
// [P] 最小权限反向控制
// ---------------------------------------------------------------------------
async function leastPrivilege() {
  assert.ok(runtimeUrl !== null, '运行时 URL 必须提供（本片的全部权限证据都以运行时角色计）');
  const client = new pg.Client({ connectionString: runtimeUrl.href });
  await client.connect();
  const probes = [
    ['SELECT nickname FROM public.users', 'users.nickname 直接读'],
    ['SELECT created_at FROM public.users', 'users.created_at 直接读'],
    ['SELECT deletion_generation FROM public.users', 'users.deletion_generation 直接读'],
    ['SELECT id, revision, state, nickname FROM public.users ORDER BY created_at ASC, id ASC', '派单 §2.1 逐字 SQL（含 nickname/created_at）'],
    ["UPDATE users SET state = 'suspended'", 'users.state 直接写'],
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
  note('[P] 运行时角色：nickname/created_at/deletion_generation 直读、派单逐字 SQL、state 直写 全部 42501');

  // 行级可达 ≠ 列级可达：三列（id/revision/state）本来就有列权限，这里只是把「缺的恰好是 nickname/created_at」钉死。
  const three = await client.query('SELECT id, revision, state FROM public.users');
  assert.equal(three.rowCount, 3, `运行时直读三列必须看到 3 行，实际 ${three.rowCount}`);
  note('[P] 运行时直读 `SELECT id, revision, state FROM public.users` ⇒ 成功（3 行）：缺的只是 nickname / created_at');

  // 唯一读路径：函数返回四列，调用方无法多取一列。
  const viaFn = await client.query('SELECT * FROM public.list_admin_accounts()');
  assert.equal(viaFn.rowCount, 3, `函数必须返回 3 行，实际 ${viaFn.rowCount}`);
  assert.deepEqual(Object.keys(viaFn.rows[0]).sort(), ['display_name', 'id', 'revision', 'state'], `函数必须恰好四列（现场：${Object.keys(viaFn.rows[0]).join(',')}）`);
  const tableSelect = await one("SELECT has_table_privilege($1, 'public.users', 'SELECT') AS v", [RUNTIME_ROLE]);
  const colNick = await one("SELECT has_column_privilege($1, 'public.users', 'nickname', 'SELECT') AS v", [RUNTIME_ROLE]);
  const colCreated = await one("SELECT has_column_privilege($1, 'public.users', 'created_at', 'SELECT') AS v", [RUNTIME_ROLE]);
  assert.equal(tableSelect.v, false, '运行时不得有 users 表级 SELECT');
  assert.equal(colNick.v, false, '运行时不得有 users.nickname 列级 SELECT');
  assert.equal(colCreated.v, false, '运行时不得有 users.created_at 列级 SELECT');
  note(`[P] 权限面读数：表级 SELECT=${tableSelect.v}，nickname SELECT=${colNick.v}，created_at SELECT=${colCreated.v} ⇒ 读面放行的是函数能力，不是权限面`);
  await client.end();
}

async function assertLeastPrivilegeFile() {
  const sql = deploySql('90-assert-least-privilege.sql');
  if (/^\s*\\/m.test(sql)) {
    // 该出厂脚本含 psql 元命令（`\echo` / `\if`），**不能**经 pg 客户端执行：
    // 由驱动命令用 `psql -f` 跑并回读 verdict（证据页贴原文）。这里如实记录，不假装跑过。
    note('[S] 90-assert-least-privilege.sql 含 psql 元命令 ⇒ 由 `psql -f` 单独执行并回读 verdict（不在本脚本内代跑）');
    return;
  }
  const result = await owner.query(sql);
  const verdict = result.at(-1).rows[0].verdict;
  assert.equal(verdict, 'ok', `90 号最小权限断言必须全绿，现场：${verdict}`);
  note('[S] 90-assert-least-privilege.sql verdict=ok（含本片新增的函数级/列级断言）');
}

// ---------------------------------------------------------------------------
// [H] HTTP 手臂（真实模式装配：app.ts 的 real 分支自己接目录）
// ---------------------------------------------------------------------------
const wechatPort = { exchange: async () => ({ subjectLookupHex: randomBytes(32).toString('hex') }) };

const fallbackName = (id) => `耕云用户${createHash('md5').update(id).digest('hex').slice(0, 4).toUpperCase()}`;

/** 三个夹具用户：状态覆盖 active / suspended / deletion_pending；nickname 覆盖正常 / NULL / 纯空白。 */
const FIXTURES = [
  { id: '11111111-1111-4111-8111-111111111111', state: 'active', revision: 1, nickname: 'Smaug', age: '3 hours' },
  { id: '22222222-2222-4222-8222-222222222222', state: 'suspended', revision: 3, nickname: null, age: '2 hours' },
  { id: '33333333-3333-4333-8333-333333333333', state: 'deletion_pending', revision: 2, nickname: '   ', age: '1 hour' },
];

async function seedUsers() {
  // 一次性集群可反复跑：先清空身份面（CASCADE 带走依赖 users 的夹具行），再插 3 行。
  await owner.query('TRUNCATE TABLE public.users CASCADE');
  for (const row of FIXTURES) {
    await owner.query(
      `INSERT INTO public.users (id, wechat_subject_lookup, state, revision, nickname, created_at)
       VALUES ($1, $2, $3::public.user_state, $4, $5, now() - $6::interval)`,
      [row.id, randomBytes(32), row.state, row.revision, row.nickname, row.age],
    );
  }
  note(`[H] 夹具 3 行就位（created_at 序：${FIXTURES.map((row) => `${row.state}/${row.revision}/${row.nickname === null ? 'NULL' : JSON.stringify(row.nickname)}`).join(' , ')}）`);
}

async function launchApp(pool) {
  // 被测对象是 `app.ts` 的 **real 分支装配**（executionMode + pool ⇒ 自己建目录与外壳），
  // 配置校验本身不在本脚本的断言范围（另有 config 单测），故以 stub 基线构造后把模式置 real。
  const config = { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), executionMode: 'real' };
  const app = buildApp({ config, pool, wechat: wechatPort, now: () => new Date() });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const call = async (path, { method = 'GET', token, body, headers = {} } = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed, text };
  };
  return { app, origin, call };
}

async function seedAdmin(scopes) {
  const adminId = await seedStore.createAdmin({
    loginName: `gy-i18-read-${randomUUID().slice(0, 8)}`,
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

async function httpEvidence() {
  if (runtimeUrl === null) {
    unread('[H] HTTP 手臂', '未提供运行时角色 URL（argv[3]），无法以最小权限跑真实 HTTP');
    return;
  }
  const runtimePool = createPool(runtimeUrl.href);
  assert.ok(runtimePool !== null, '运行时 pool 必须建出来');
  const { app, call } = await launchApp(runtimePool);
  registeredApps.push(app);

  const reader = await seedAdmin(['accounts:read']);
  const first = await call(`${API}/admin/accounts`, { token: reader.token });
  assert.equal(first.status, 200, `读面必须 200，实际 ${first.status} ${first.text.slice(0, 300)}`);
  const items = first.body.data.items;
  assert.equal(items.length, 3, `必须恰好 3 条，实际 ${items.length}`);
  for (const item of items) {
    assert.deepEqual(Object.keys(item).sort(), ['display_name', 'id', 'revision', 'state'], `字段集合必须恰好四列（现场：${Object.keys(item).join(',')}）`);
  }
  assert.deepEqual(items.map((item) => item.id), FIXTURES.map((row) => row.id), '必须按 created_at ASC, id ASC 定序');
  assert.deepEqual(items.map((item) => item.state), FIXTURES.map((row) => row.state), 'state 必须逐行等于种子状态');
  assert.deepEqual(items.map((item) => item.revision), FIXTURES.map((row) => row.revision), 'revision 必须逐行等于种子值');
  assert.equal(items[0].display_name, 'Smaug', '正常 nickname 必须原样透出');
  assert.equal(items[1].display_name, fallbackName(FIXTURES[1].id), `NULL nickname 必须回退为「耕云用户+4 位摘要」（现场：${items[1].display_name}）`);
  assert.equal(items[2].display_name, fallbackName(FIXTURES[2].id), `纯空白 nickname 必须同样回退（现场：${items[2].display_name}）`);
  for (const item of items) {
    assert.ok(typeof item.display_name === 'string' && item.display_name.length >= 1, 'display_name 必须非空（契约 minLength:1）');
  }
  note(`[H] GET ${API}/admin/accounts ⇒ 200，items=3，字段集合恰好 {id,revision,state,display_name}，display_name=[${items.map((item) => item.display_name).join(' , ')}]`);

  // 字符串级否定断言：响应正文不得出现任何越界列名/值。
  const lowered = first.text.toLowerCase();
  for (const forbidden of ['wechat', 'cipher', 'lookup', 'auth_epoch', 'deletion_generation']) {
    assert.equal(lowered.includes(forbidden), false, `响应正文不得含 ${forbidden}（正文：${first.text.slice(0, 400)}）`);
  }
  note('[H] 正文不含 wechat / cipher / lookup / auth_epoch / deletion_generation（字符串级否定断言）');

  // 游标翻页：limit=2 ⇒ 2 条 + next_cursor；再取 ⇒ 1 条 + next_cursor=null。
  const pageOne = await call(`${API}/admin/accounts?limit=2`, { token: reader.token });
  assert.equal(pageOne.status, 200);
  assert.equal(pageOne.body.data.items.length, 2, 'limit=2 必须恰好 2 条');
  assert.equal(typeof pageOne.body.data.next_cursor, 'string', '首页必须给出 next_cursor');
  const pageTwo = await call(`${API}/admin/accounts?limit=2&cursor=${encodeURIComponent(pageOne.body.data.next_cursor)}`, { token: reader.token });
  assert.equal(pageTwo.status, 200, `游标翻页必须 200，实际 ${pageTwo.status} ${pageTwo.text.slice(0, 200)}`);
  assert.equal(pageTwo.body.data.items.length, 1, '第二页必须恰好 1 条');
  assert.equal(pageTwo.body.data.next_cursor, null, '最后一页 next_cursor 必须为 null');
  assert.equal(pageTwo.body.data.items[0].id, FIXTURES[2].id, '第二页必须是第三行');
  note('[H] 游标翻页：limit=2 ⇒ 2 条 + next_cursor；续页 ⇒ 1 条 + next_cursor=null');

  // 负控制 1：只有停用面 scope 的管理员 ⇒ 403 SCOPE_DENIED。
  const suspender = await seedAdmin(['accounts:suspend']);
  const denied = await call(`${API}/admin/accounts`, { token: suspender.token });
  assert.equal(denied.status, 403, `缺 accounts:read 必须 403，实际 ${denied.status} ${denied.text.slice(0, 200)}`);
  assert.equal(denied.body.error.code, 'SCOPE_DENIED', `错误码必须 SCOPE_DENIED，实际 ${denied.body.error.code}`);
  note(`[H] 负控制：只有 accounts:suspend 的管理员 ⇒ ${denied.status} ${denied.body.error.code}`);

  // 负控制 2：无令牌 ⇒ 401。
  const anonymous = await call(`${API}/admin/accounts`);
  assert.equal(anonymous.status, 401, `无令牌必须 401，实际 ${anonymous.status}`);
  note(`[H] 负控制：无令牌 ⇒ ${anonymous.status}`);

  await runtimePool.end();
}

try {
  await migrationTriple();
  await provisionRoles();
  await seedUsers();
  await leastPrivilege();
  await assertLeastPrivilegeFile();
  await httpEvidence();
} finally {
  for (const app of registeredApps) {
    await app.close().catch(() => {});
  }
  await ownerPool.end().catch(() => {});
  await owner.end().catch(() => {});
}

if (runtimeUrl === null) {
  note('结论：库侧/权限侧证据全部通过；HTTP 一手证据未取得（缺运行时角色 URL）——不得读成「HTTP 已验证」。');
  process.exitCode = 0;
} else {
  note('结论：迁移三连 + 最小权限反向控制 + 真实模式 HTTP（三态/nickname 回退/游标翻页/两条负控制）全部通过；90 号断言由 psql -f 单独执行并回读 verdict。');
}
