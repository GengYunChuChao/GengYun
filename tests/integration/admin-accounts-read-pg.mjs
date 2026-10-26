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
//   [W] `#18` S2 PR-3 管理员 scope **写面**（同一脚本，追加在最后）：授予后属主连接回读
//       `granted_by`/`granted_at` 真的被写；幂等重放不写第二条审计；撤销写 `revoked_at` 且保留
//       `granted_by`；**并发两会话互撤 `scopes:write` 恰好一方成功**（`pg_advisory_xact_lock`
//       真的在起作用，事后有效持有者仍为 1）；**最后授权者自撤 ⇒ 409 `LAST_SCOPE_MANAGER`**
//       且整笔回滚（`revoked_at` 仍为 NULL）；缺 `scopes:write` ⇒ 403、自授 ⇒ 403
//       `SELF_SCOPE_GRANT_DENIED`。⛔ 为什么追加在这里而不是新建文件：
//       `.github/workflows/real-pg-integration.yml` 是**逐文件列举**，新文件 CI 跑不到。
//   [G] PR-4b · 停用守卫（裁定 A-b「无处可挂」）：`admin_accounts` 没有任何产品路径能改 `state`
//       ⇒ 「停用最后一名 `scopes:write` 持有者会永久锁死」这条担忧**无触发面**。三组读数：
//       实体分离（对 `public.users` 停用 2 行 ⇒ `admin_scopes` 计数不变、两名管理员仍 `active`）／
//       零持有者下停用同样不变且不抛任何错误／负控制（事务内人为把「停用顺带撤销」做出来 ⇒
//       计数变 0，`ROLLBACK` 复原）。同样追加在本文件，理由同上（新文件 CI 跑不到）。
//
// 未取得（如实登记，见证据页与交接）：真机、后台 UI 联调、超 1 万账号规模、HTTP 层之外的审计。

import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';

import { loadConfig } from '../../services/api/src/config.ts';
import { buildApp } from '../../services/api/src/app.ts';
import { createPostgresAccountAuthority } from '../../services/api/src/admin/ops/account-authority-pg.ts';
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
    // `#18` S2 PR-3：管理员 scope 写面的两条函数 EXECUTE（迁移 0041 的
    // `grant_admin_scope` / `revoke_admin_scope`）。原样执行出厂区域，不复制粘贴 SQL ——
    // 授权被删／被改宽就变红。
    { name: 'gy-r37-s2-scope-grant', grants: 2 },
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

// ---------------------------------------------------------------------------
// [W] `#18` S2 PR-3 · 管理员 scope 的**写面**（授予 / 撤销 / 最后授权者 / 并发）
//
// 为什么这些读数只能真库给：`granted_by` / `granted_at` / `revoked_at` 三列运行时角色**读不到**
// （只有 `admin_id/scope/revoked_at` 三列 SELECT），所以"真的写了"必须用**属主连接**回读；
// 「最后授权者」守卫在函数内的 `pg_advisory_xact_lock` 之后按当前行计数，应用层怎么数都重现不了；
// 并发两会话互撤时"只有一方成功"更是只有真库的事务隔离 + advisory 锁能证明。
//
// 为什么不新建一个 `tests/integration/*.mjs`：`.github/workflows/real-pg-integration.yml`
// 是**逐文件列举**跑 `tests/integration/*.mjs`，新文件 CI 根本不会执行（跑不到的臂 = 没验证）。
// 因此本片把写面读数**追加进这个已接线的文件**（它本来就有真实运行时角色 + 真 HTTP 装配）。
// ---------------------------------------------------------------------------
async function seedScopeAdmin(loginName, scopes) {
  const adminId = await seedStore.createAdmin({
    loginName,
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

async function scopeWriteEvidence() {
  if (runtimeUrl === null) {
    unread('[W] 管理员 scope 写面', '未提供运行时角色 URL（argv[3]），无法以最小权限跑真实 HTTP');
    return;
  }
  // 一次性集群可反复跑：按 FK 安全序清空身份/授权/审计面（只清本脚本自己要造的夹具）。
  for (const table of ['public.admin_sessions', 'public.admin_scopes', 'public.admin_audit_events', 'public.admin_accounts']) {
    await owner.query(`DELETE FROM ${table}`);
  }

  // actor 必须**自己持有**要授予的 scope（库层 G0011），所以它同时持 audit:read。
  const actor = await seedScopeAdmin('gy-scope-actor', ['scopes:write', 'scopes:read', 'audit:read']);
  const target = await seedScopeAdmin('gy-scope-target', ['scopes:write', 'accounts:read']);

  const revisionOf = async (id) => Number((await one('SELECT revision FROM public.admin_accounts WHERE id = $1::uuid', [id])).revision);
  const holders = async () => Number((await one(
    `SELECT count(*)::int AS c
       FROM public.admin_scopes AS s
       JOIN public.admin_accounts AS a ON a.id = s.admin_id
      WHERE s.scope = 'scopes:write' AND s.revoked_at IS NULL AND a.state = 'active'`,
  )).c);

  const runtimePool = createPool(runtimeUrl.href);
  assert.ok(runtimePool !== null, '运行时 pool 必须建出来');
  const { app, call } = await launchApp(runtimePool);
  registeredApps.push(app);

  const write = (token, body, revision, key) => ({
    token,
    body,
    headers: { 'idempotency-key': key, 'if-match': `"${revision}"` },
  });

  // ── [W1] 授予：granted_by / granted_at 真的落库 ─────────────────────────
  // `rev1` 只取一次：幂等请求摘要**包含 If-Match**（`idempotencyRequestHash`），
  // 真正的重放必须原样重发同一个请求（同一个 `If-Match`），否则会正确地撞 `IDEMPOTENCY_CONFLICT`。
  const rev1 = await revisionOf(target.adminId);
  const grant = await call(
    `${API}/admin/administrators/${target.adminId}/scopes`,
    {
      method: 'POST',
      ...write(actor.token, { scope: 'audit:read', reason: '集成臂：交接授予审计读' }, rev1, 'gy-w-grant-0001'),
    },
  );
  assert.equal(grant.status, 200, `授予必须 200，实际 ${grant.status} ${grant.text.slice(0, 300)}`);
  assert.equal(grant.body.data.changed, true, '第一次授予必须 changed=true');
  assert.deepEqual(grant.body.data.scopes, ['accounts:read', 'audit:read', 'scopes:write'], '响应里的有效集合必须含新授的 audit:read');
  const grantedRow = await one(
    "SELECT granted_by, granted_at, revoked_at FROM public.admin_scopes WHERE admin_id = $1::uuid AND scope = 'audit:read'",
    [target.adminId],
  );
  assert.equal(grantedRow.granted_by, actor.adminId, 'granted_by 必须是被授予者的操作者 id（⛔ 不是 NULL、也不是被授者自己）');
  assert.ok(grantedRow.granted_at instanceof Date, 'granted_at 必须真的写进去');
  assert.equal(grantedRow.revoked_at, null, '新授行必须是有效态（revoked_at IS NULL）');
  note(`[W1] 授予 ⇒ 200，changed=true；granted_by=${grantedRow.granted_by}，granted_at=${grantedRow.granted_at.toISOString()}（属主连接回读）`);

  // 幂等重放：同键**同体同 If-Match** ⇒ 命中已定型结果、不再写第二条审计、不动 revision。
  const replay = await call(
    `${API}/admin/administrators/${target.adminId}/scopes`,
    {
      method: 'POST',
      ...write(actor.token, { scope: 'audit:read', reason: '集成臂：交接授予审计读' }, rev1, 'gy-w-grant-0001'),
    },
  );
  assert.equal(replay.status, 200, replay.text.slice(0, 200));
  assert.equal(replay.body.data.changed, true, '幂等重放回放的是第一次的定型结果（changed=true）');
  const auditsAfterReplay = Number((await one("SELECT count(*)::int AS c FROM public.admin_audit_events WHERE action = 'admin_scope.grant'")).c);
  assert.equal(auditsAfterReplay, 1, `幂等重放不得写第二条审计（现场 ${auditsAfterReplay} 条）`);
  note(`[W1b] 幂等重放 ⇒ 200（回放定型结果）；admin_scope.grant 审计行仍恰好 1 条`);

  // ── [W2] 撤销：revoked_at 真的落库 ──────────────────────────────────────
  const revoke = await call(
    `${API}/admin/administrators/${target.adminId}/scopes/audit:read`,
    {
      method: 'DELETE',
      ...write(actor.token, { reason: '集成臂：交接收回审计读' }, await revisionOf(target.adminId), 'gy-w-revoke-0001'),
    },
  );
  assert.equal(revoke.status, 200, `撤销必须 200，实际 ${revoke.status} ${revoke.text.slice(0, 300)}`);
  assert.equal(revoke.body.data.changed, true);
  assert.deepEqual(revoke.body.data.scopes, ['accounts:read', 'scopes:write'], '撤销后有效集合不得再含 audit:read');
  const revokedRow = await one(
    "SELECT revoked_at, granted_by FROM public.admin_scopes WHERE admin_id = $1::uuid AND scope = 'audit:read'",
    [target.adminId],
  );
  assert.ok(revokedRow.revoked_at instanceof Date, 'revoked_at 必须真的写进去');
  assert.equal(revokedRow.granted_by, actor.adminId, '撤销是 UPDATE，不得抹掉 granted_by（授权链要留痕）');
  note(`[W2] 撤销（scope 在路径里）⇒ 200，changed=true；revoked_at=${revokedRow.revoked_at.toISOString()}，granted_by 保留`);

  // ── [W3] 并发：两会话同时互撤 scopes:write ⇒ 恰好一方成功 ────────────────
  // 起手 2 个有效持有者（actor / target），两条请求各撤掉对方。
  // 没有 advisory 锁时两边都还看得见对方的有效行 ⇒ 都提交 ⇒ 元权限归零（系统永久失去授权维护能力）。
  // 有锁时按 scope 串行化：先提交的那条留下 1 个持有者；后到的那条要么因"归零"被 G0009 拒
  // （409 LAST_SCOPE_MANAGER），要么因自己刚被撤掉 scopes:write 而在第 ③ 步被 G0010 拒
  // （403 SCOPE_DENIED）—— 两种都是**拒绝**，共同性质是"恰好一方成功"。
  const actorRevBefore = await revisionOf(actor.adminId);
  const targetRevBefore = await revisionOf(target.adminId);
  const [raceA, raceB] = await Promise.all([
    call(
      `${API}/admin/administrators/${target.adminId}/scopes/scopes:write`,
      { method: 'DELETE', ...write(actor.token, { reason: '并发臂 A：撤对方' }, targetRevBefore, 'gy-w-race-a-0001') },
    ),
    call(
      `${API}/admin/administrators/${actor.adminId}/scopes/scopes:write`,
      { method: 'DELETE', ...write(target.token, { reason: '并发臂 B：撤对方' }, actorRevBefore, 'gy-w-race-b-0001') },
    ),
  ]);
  const statuses = [raceA.status, raceB.status];
  assert.equal(statuses.filter((status) => status === 200).length, 1,
    `并发互撤必须恰好一方 200（现场 ${statuses.join(' / ')}）`);
  const winners = [raceA, raceB].filter((r) => r.status === 200);
  const losers = [raceA, raceB].filter((r) => r.status !== 200);
  assert.equal(winners.length, 1, `并发互撤必须恰好一方成功（现场 ${raceA.status} / ${raceB.status}）`);
  assert.equal(losers.length, 1);
  assert.ok([403, 409].includes(losers[0].status), `失败方的状态必须是 403/409（现场 ${losers[0].status} ${losers[0].text.slice(0, 200)}）`);
  assert.ok(
    ['LAST_SCOPE_MANAGER', 'SCOPE_DENIED'].includes(losers[0].body?.error?.code),
    `失败方的错误码必须是 LAST_SCOPE_MANAGER 或 SCOPE_DENIED（现场 ${losers[0].body?.error?.code}）`,
  );
  assert.equal(losers[0].body.error.retryable, false, '两种拒绝都不可重试');
  assert.equal(await holders(), 1, '并发之后必须仍**恰好 1 个**有效 scopes:write 持有者（advisory 锁真的在起作用）');
  note(`[W3] 并发两会话互撤 ⇒ ${raceA.status} / ${raceB.status}，成功 1 方、拒绝 1 方（${losers[0].body.error.code}），有效持有者仍为 1`);

  // ── [W4] 最后授权者：唯一持有者自撤 ⇒ 409 LAST_SCOPE_MANAGER（确定性） ──
  const survivors = [
    { who: 'actor', admin: actor },
    { who: 'target', admin: target },
  ];
  const survivor = [];
  for (const item of survivors) {
    const held = await one(
      "SELECT 1 AS v FROM public.admin_scopes WHERE admin_id = $1::uuid AND scope = 'scopes:write' AND revoked_at IS NULL",
      [item.admin.adminId],
    );
    if (held !== undefined) survivor.push(item);
  }
  assert.equal(survivor.length, 1, `并发后必须恰好 1 个持有者（现场 ${survivor.map((s) => s.who).join(',')}）`);
  const last = survivor[0];
  const beforeLast = await one(
    "SELECT revoked_at FROM public.admin_scopes WHERE admin_id = $1::uuid AND scope = 'scopes:write'",
    [last.admin.adminId],
  );
  assert.equal(beforeLast.revoked_at, null, '前置：自撤前该行必须仍有效');
  const lastRes = await call(
    `${API}/admin/administrators/${last.admin.adminId}/scopes/scopes:write`,
    {
      method: 'DELETE',
      ...write(last.admin.token, { reason: '集成臂：最后授权者自撤' }, await revisionOf(last.admin.adminId), 'gy-w-last-0001'),
    },
  );
  assert.equal(lastRes.status, 409, `最后授权者自撤必须 409，实际 ${lastRes.status} ${lastRes.text.slice(0, 300)}`);
  assert.equal(lastRes.body.error.code, 'LAST_SCOPE_MANAGER', `错误码必须是 LAST_SCOPE_MANAGER，实际 ${lastRes.body.error.code}`);
  assert.equal(lastRes.body.error.retryable, false, '裁定⑥：两个新码都必须 retryable:false');
  const afterLast = await one(
    "SELECT revoked_at FROM public.admin_scopes WHERE admin_id = $1::uuid AND scope = 'scopes:write'",
    [last.admin.adminId],
  );
  assert.equal(afterLast.revoked_at, null, '409 必须整笔回滚：revoked_at 不得被写上（否则就是"报错但已生效"）');
  assert.equal(await holders(), 1, '被拒的那次不得改变持有者数量');
  note(`[W4] 最后授权者（${last.who}）自撤 ⇒ 409 LAST_SCOPE_MANAGER（retryable=false），revoked_at 仍为 NULL（整笔回滚）`);

  // ── [W5] 越权与自授：应用层与库层两道 ───────────────────────────────────
  // 缺 scopes:write 的操作者：用一个只持 accounts:read 的管理员。
  const plain = await seedScopeAdmin('gy-scope-plain', ['accounts:read']);
  const denied = await call(
    `${API}/admin/administrators/${last.admin.adminId}/scopes`,
    {
      method: 'POST',
      ...write(plain.token, { scope: 'accounts:read', reason: '不应生效' }, await revisionOf(last.admin.adminId), 'gy-w-denied-0001'),
    },
  );
  assert.equal(denied.status, 403, `缺 scopes:write 必须 403，实际 ${denied.status}`);
  assert.equal(denied.body.error.code, 'SCOPE_DENIED');
  // 自授：唯一持有者给自己授一个**它自己没持有**的 scope ⇒ G0011（同样 403，但 details 指明 scope）。
  const selfGrant = await call(
    `${API}/admin/administrators/${last.admin.adminId}/scopes`,
    {
      method: 'POST',
      ...write(last.admin.token, { scope: 'jobs:cancel', reason: '自授' }, await revisionOf(last.admin.adminId), 'gy-w-self-0001'),
    },
  );
  assert.equal(selfGrant.status, 403, `自授必须 403，实际 ${selfGrant.status}`);
  assert.equal(selfGrant.body.error.code, 'SELF_SCOPE_GRANT_DENIED', `自授必须是 SELF_SCOPE_GRANT_DENIED，实际 ${selfGrant.body.error.code}`);
  assert.equal(selfGrant.body.error.retryable, false);
  note('[W5] 缺 scopes:write ⇒ 403 SCOPE_DENIED；自授 ⇒ 403 SELF_SCOPE_GRANT_DENIED（均 retryable=false）');

  await runtimePool.end();
}

// ---------------------------------------------------------------------------
// [G] PR-4b · 停用守卫（裁定 A-b）：把「无处可挂」钉成可执行断言
//
// ## 这一组钉的是什么（背景事实，逐条在仓内复核过，行号即复核位置）
// * 后台管理员的 scope 存在 `public.admin_scopes`（`admin_id → public.admin_accounts.id`，
//   `0001_initial_schema.sql:89-96`），写路径只有迁移 **`0041`** 的
//   `public.grant_admin_scope()`（`0041_admin_scope_write_authority.sql:199`）/
//   `public.revoke_admin_scope()`（同文件 `:352`）。
// * `0041` 里有「最后一名 `scopes:write` 持有者不能撤」的守卫（同文件 `:439-457`），
//   SQLSTATE **`G0009`**（`:450`），应用层映射 `LAST_SCOPE_MANAGER`(409)。计数只算
//   `revoked_at IS NULL` **且** `admin_accounts.state = 'active'` 的管理员（`:440-446`）。
// * 但**没有任何产品路径能停用一个 `admin_accounts` 行**：全仓对 `admin_accounts` 的写只有
//   `0041:312` 与 `0041:466` 两处 `revision = revision + 1`（授权 / 撤销的 revision bump），
//   以及 `services/api/src/auth/store.ts:383-386` 的一条 INSERT（建号，`state` 落默认值）；
//   **没有** state 变更、**没有**删除。`admin_accounts` / `admin_scopes` 上也没有任何触发器
//   （全迁移目录 `ON public.admin_accounts` / `ON public.admin_scopes` 命中 0 处）。
// * 而迁移 **`0017`**（`0017_account_suspend_authority.sql:134-233`）的
//   `public.suspend_account(p_actor_id, p_audit_id, p_user_id, p_expected_revision, p_request_id)`
//   作用对象是 `public.users`（终端用户）+ `public.sessions` + `public.admin_audit_events`，
//   函数体里一次都没有出现 `admin_accounts` / `admin_scopes` ⇒ 与 `admin_accounts`
//   **不是同一实体**。
// ⇒ 「停用最后一名 `scopes:write` 持有者导致永久锁死」这条担忧**没有触发面**。
//   本组不改任何库代码、不改任何迁移、不碰 `0017`、不给 `suspend_account` 加 actor 权限核验
//   （那会打红 `tests/integration/account-suspend-pg.mjs` 的合成 actor 直调），
//   只把上面这段推理钉成可执行断言：任何一天真的出现「停用管理员」的产品路径，[G1] 会先红。
//
// ## 三组断言分别钉住什么
//   [G1] 实体分离（主断言）：2 名 `state='active'` 且各持 `scopes:write` 的管理员 ⇒ 记下
//        `admin_scopes` 里 `scope='scopes:write' AND revoked_at IS NULL` 的计数 = 2 ⇒ 对**同数量**
//        的 `public.users` 行调停用（走产品端口，调用形态与 `account-suspend-pg.mjs` 一致）⇒
//        再查同一个计数 ⇒ **仍是 2**，且那两行 `admin_accounts` 的 `state` 仍是 `'active'`、
//        `revision` 一位没动（证明 `suspend_account` 一行都没碰）。
//   [G2] 零持有者也不因停用而变：把 `scopes:write` 用**直接 SQL** 撤到 0 持有者（这是唯一能
//        归零的方式：走 `revoke_admin_scope()` 必被 `G0009` 拒绝）⇒ 再停用 `public.users` 行 ⇒
//        计数仍是 **0**，且**不抛任何错误**（证明停用路径上没有隐式守卫挂上来）。
//   [G3] 负控制（必须红、且只红这一条）：在**独立事务**里把「停用会牵动 `admin_scopes`」这件事
//        人为做出来（`UPDATE admin_scopes SET revoked_at = now() WHERE scope='scopes:write'`，
//        模拟"停用顺带撤销"这种错误实现）⇒ 主断言口径必读到 0；`ROLLBACK` 复原 ⇒ 回到 2。
//        ⛔ 这个变异只活在这一个事务里（随后 `ROLLBACK`），不留在代码里、不落库；
//        它证明的是：**若把停用实现成顺带撤销，[G1] 的主断言会红**。
//
// ## 为什么这三组必须走真库
// [G1]/[G2] 读的是 `admin_scopes` 与 `admin_accounts` 两表在**真实停用事务提交之后**的联合读数，
// 内存替身无法呈现「`suspend_account` 的四步写完之后，另一张表有没有被牵动」；
// [G3] 的「变 0 再复原」需要事务可见性与 `ROLLBACK` 语义，只有真库能给。
// ---------------------------------------------------------------------------
async function suspendGuardEvidence() {
  /** 主断言口径：**逐字**按派单给出的计数 SQL（`admin_scopes` 侧，不折叠 `admin_accounts.state`）。 */
  const writeHolders = async (client = owner) => Number((await client.query(
    "SELECT count(*)::int AS c FROM public.admin_scopes WHERE scope = 'scopes:write' AND revoked_at IS NULL",
  )).rows[0].c);
  /** `0041:440-446` 守卫真正用的口径：再 JOIN `admin_accounts`，只算 `state='active'`。 */
  const writeHoldersActive = async (client = owner) => Number((await client.query(
    `SELECT count(*)::int AS c
       FROM public.admin_scopes AS s
       JOIN public.admin_accounts AS a ON a.id = s.admin_id
      WHERE s.scope = 'scopes:write' AND s.revoked_at IS NULL AND a.state = 'active'`,
  )).rows[0].c);

  // 归一化起点：把前面用例留下的 `scopes:write` 有效持有者全部**直接 SQL** 撤销
  // （⛔ 不走 `revoke_admin_scope()`：撤最后一名会被 `G0009` 拒绝；本组要的是"确定的 0 起手"）。
  await owner.query("UPDATE public.admin_scopes SET revoked_at = now() WHERE scope = 'scopes:write' AND revoked_at IS NULL");
  assert.equal(await writeHolders(), 0, '[G] 归一化后 scopes:write 有效持有者必须为 0（否则下面的计数不可信）');

  // 造 2 名 `state='active'` 且各持 `scopes:write` 的管理员（走建号路径，`admin_state` 落默认 `active`）。
  const holderA = await seedScopeAdmin(`gy-pr4b-holder-a-${randomUUID().slice(0, 8)}`, ['scopes:write']);
  const holderB = await seedScopeAdmin(`gy-pr4b-holder-b-${randomUUID().slice(0, 8)}`, ['scopes:write']);
  const holderIds = [holderA.adminId, holderB.adminId];

  /** 两名持有者在 `admin_accounts` 侧的读数（`state` 与 `revision` 都要一字不动）。 */
  const holderRows = async () => q(
    'SELECT id, state::text AS state, revision FROM public.admin_accounts WHERE id = ANY($1::uuid[]) ORDER BY id',
    [holderIds],
  );
  /** 造一行「可被停用」的终端用户（`state='active'`；与 [H] 夹具同一 INSERT 形状）。 */
  const seedSuspendTarget = async () => {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO public.users (id, wechat_subject_lookup, state, revision, nickname)
       VALUES ($1::uuid, $2, 'active'::public.user_state, 1, '停用守卫夹具')`,
      [id, randomBytes(32)],
    );
    return id;
  };
  // 产品写路径：与 `tests/integration/account-suspend-pg.mjs` 同一调用形态
  // （`createPostgresAccountAuthority({ pool }).suspend({ actorId, auditId, userId,
  //   expectedRevision, requestId })`，端口内部就是 `SELECT public.suspend_account($1::uuid,
  //   $2::uuid, $3::uuid, $4::integer, $5::uuid)` 那一条语句 + 显式事务）。
  // ⛔ 不在这里另拼一份 `SELECT public.suspend_account(...)`：那样测的是"函数能跑"，
  //    测不到"产品路径怎么调它"。
  const authority = createPostgresAccountAuthority({ pool: ownerPool });
  const suspendTarget = (userId) => authority.suspend({
    actorId: holderA.adminId,
    auditId: randomUUID(),
    userId,
    expectedRevision: null,
    requestId: randomUUID(),
  });

  // ── [G1] 实体分离（主断言） ────────────────────────────────────────────────
  const before = await holderRows();
  assert.equal(before.length, 2, `[G1] 必须恰好 2 名持有者（现场 ${before.length}）`);
  assert.deepEqual(before.map((row) => row.state), ['active', 'active'], '[G1] 两名持有者都必须 state=active（否则 0041 的守卫口径不计入）');
  assert.equal(await writeHolders(), 2, '[G1] 停用前 scopes:write 有效持有者计数必须为 2');
  assert.equal(await writeHoldersActive(), 2, '[G1] 停用前「守卫口径」（含 state=active）必须同为 2');

  const usersG1 = [await seedSuspendTarget(), await seedSuspendTarget()];
  assert.equal(usersG1.length, 2, '[G1] 必须对**同数量**（2 行）的 public.users 执行停用');
  for (const userId of usersG1) {
    const outcome = await suspendTarget(userId);
    // 反向自证：停用**真的生效了**。否则「计数没变」是空断言（什么都没发生当然不会变）。
    assert.equal(outcome.changed, true, `[G1] 夹具用户 ${userId} 的停用必须真的生效（否则「计数不变」是空断言）`);
    assert.equal(outcome.account.state, 'suspended', '[G1] 停用后该 users 行的 state 必须是 suspended');
  }
  const suspendedG1 = Number((await one(
    "SELECT count(*)::int AS c FROM public.users WHERE id = ANY($1::uuid[]) AND state = 'suspended'",
    [usersG1],
  )).c);
  assert.equal(suspendedG1, 2, `[G1] 2 行 users 必须都已 suspended（现场 ${suspendedG1}）`);

  assert.equal(await writeHolders(), 2, '[G1] 停用 2 行 public.users 后 scopes:write 有效持有者仍必须是 2（停用不牵动 admin_scopes）');
  assert.equal(await writeHoldersActive(), 2, '[G1] 「守卫口径」同样仍必须是 2');
  const after = await holderRows();
  assert.deepEqual(after, before, '[G1] 停用后两名管理员的 admin_accounts 行必须逐列不变（state 仍 active、revision 未动）');
  assert.deepEqual(after.map((row) => row.state), ['active', 'active'], '[G1] 两名管理员停用后必须仍是 state=active（suspend_account 一行都没碰）');
  note(`[G1] 实体分离：停用前 holders=${before.length}（active 各 1 次 revision=${before.map((row) => row.revision).join('/')}）`
    + ` ⇒ 对 ${usersG1.length} 行 public.users 停用（changed=true×2）⇒ holders 仍 ${await writeHolders()}，`
    + `两名管理员 state 仍 active、revision 未动`);

  // ── [G2] 零持有者也不因停用而变 ────────────────────────────────────────────
  // 唯一的归零方式：直接 SQL。走 `revoke_admin_scope()` 会被 `G0009 LAST_SCOPE_MANAGER` 拒绝
  // （[W4] 已经证明过那条路径），所以这里必须绕开函数才能造出"0 持有者"这个前置状态。
  await owner.query("UPDATE public.admin_scopes SET revoked_at = now() WHERE scope = 'scopes:write' AND revoked_at IS NULL");
  assert.equal(await writeHolders(), 0, '[G2] 直接 SQL 撤销后 scopes:write 有效持有者必须恰好为 0');
  assert.equal(await writeHoldersActive(), 0, '[G2] 「守卫口径」同样必须为 0');

  const usersG2 = [await seedSuspendTarget(), await seedSuspendTarget()];
  const outcomesG2 = [];
  let thrownG2 = null;
  for (const userId of usersG2) {
    try {
      outcomesG2.push(await suspendTarget(userId));
    } catch (error) {
      thrownG2 = error;
    }
  }
  // 「不抛任何错误」是本组的核心读数：停用路径上没有任何隐式守卫（不会因为元权限归零而拒绝）。
  assert.equal(thrownG2, null, `[G2] 零持有者下停用不得抛任何错误（现场：${thrownG2?.code ?? ''} ${thrownG2?.message ?? ''}）`);
  assert.deepEqual(outcomesG2.map((outcome) => outcome.changed), [true, true], '[G2] 两次停用都必须真的生效（证明调用真的落库，不是被静默跳过）');
  assert.equal(await writeHolders(), 0, '[G2] 零持有者下停用之后仍是 0（停用不牵动 admin_scopes）');
  assert.equal(await writeHoldersActive(), 0, '[G2] 「守卫口径」同样仍是 0');
  note(`[G2] 零持有者：SQL 直撤到 0 ⇒ 再停用 ${usersG2.length} 行 public.users（changed=true×2、零错误）`
    + ' ⇒ holders 仍 0（停用路径上没有隐式守卫）');

  // ── [G3] 负控制：把「停用顺带撤销」人为做出来 ⇒ 主断言口径必变 0 ────────────
  // 复原前置：[G2] 用直接 SQL 撤掉的那两行授权原样置回有效（只针对这两名持有者，
  // ⛔ 不是 `WHERE scope='scopes:write'` 全表复活，那会把历史已撤销的行一起搬回来）。
  await owner.query(
    "UPDATE public.admin_scopes SET revoked_at = NULL WHERE scope = 'scopes:write' AND admin_id = ANY($1::uuid[])",
    [holderIds],
  );
  assert.equal(await writeHolders(), 2, '[G3] 负控制起手必须是 2（否则下面的「变 0」不成立）');

  // 独立事务（独立连接）：变异只在这个事务里存在，随后 `ROLLBACK` 复原。
  const tx = new pg.Client({ connectionString: ownerUrl.href });
  await tx.connect();
  let mutated = null;
  try {
    await tx.query('BEGIN');
    // 「错误实现」的样子：停用的同时把 `scopes:write` 顺带撤销。
    // 与 `[G2]` 同形：只动**仍然有效**的行（`revoked_at IS NULL`），不改写历史已撤销行 ——
    // 否则模拟的就不是「停用顺带撤销有效授权」，而是「停用顺带改写全部历史」，两者语义不同。
    await tx.query("UPDATE public.admin_scopes SET revoked_at = now() WHERE scope = 'scopes:write' AND revoked_at IS NULL");
    mutated = await writeHolders(tx);
    const mutatedActive = await writeHoldersActive(tx);
    // 负控制必须真的红：变异实现让主断言口径读到 0，否则这条负控制等于没验。
    assert.equal(mutated, 0, '[G3] 「停用顺带撤销」的变异实现必须让主断言口径读到 0（否则负控制没红）');
    assert.equal(mutatedActive, 0, '[G3] 「守卫口径」同样必须读到 0');
  } finally {
    await tx.query('ROLLBACK').catch(() => {});
    await tx.end().catch(() => {});
  }
  const restored = await writeHolders();
  assert.equal(restored, 2, '[G3] ROLLBACK 之后计数必须回到 2（变异只活在事务里，⛔ 不落库）');
  assert.equal(await writeHoldersActive(), 2, '[G3] 「守卫口径」同样必须回到 2');
  note(`[G3] 负控制：事务内「停用顺带撤销」⇒ 计数 2→${mutated}；ROLLBACK 后回到 ${restored}`
    + '（若把停用实现成顺带撤销，[G1] 的主断言会红；变异未留在代码里）');
}

try {
  await migrationTriple();
  await provisionRoles();
  await seedUsers();
  await leastPrivilege();
  await assertLeastPrivilegeFile();
  await httpEvidence();
  // `#18` S2 PR-3：管理员 scope 写面（授予/撤销/幂等/并发/最后授权者/越权）。放在最后：
  // 它会清空身份面并重建夹具，跑在前面会把 [H] 的用户夹具冲掉。
  await scopeWriteEvidence();
  // PR-4b · 停用守卫（裁定 A-b「无处可挂」）：实体分离 / 零持有者 / 负控制。同样放在最后：
  // 它要先归一化 `scopes:write` 的持有者数量，跑在 [W] 前面会把写面用例的并发前置冲掉。
  await suspendGuardEvidence();
} finally {
  for (const app of registeredApps) {
    await app.close().catch(() => {});
  }
  await ownerPool.end().catch(() => {});
  await owner.end().catch(() => {});
}

if (runtimeUrl === null) {
  note('结论：库侧/权限侧证据全部通过（含 PR-4b 停用守卫三组：实体分离 / 零持有者 / 负控制）；'
    + 'HTTP 一手证据未取得（缺运行时角色 URL）——不得读成「HTTP 已验证」。');
  process.exitCode = 0;
} else {
  note('结论：迁移三连 + 最小权限反向控制 + 真实模式 HTTP（三态/nickname 回退/游标翻页/两条负控制）'
    + ' + `#18` S2 PR-3 写面（授予落 granted_by/granted_at / 撤销落 revoked_at / 幂等 / 并发恰一方成功 / '
    + '最后授权者 409 LAST_SCOPE_MANAGER / 缺权限与自授 403）'
    + ' + PR-4b 停用守卫（实体分离：停用 public.users 不牵动 admin_scopes、管理员 state 不被动 / '
    + '零持有者下停用零错误 / 负控制事务内造变异必红后 ROLLBACK 复原）全部通过；'
    + '90 号断言由 psql -f 单独执行并回读 verdict。');
}
