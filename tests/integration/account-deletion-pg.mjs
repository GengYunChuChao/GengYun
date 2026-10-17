// GY-I19（#19）：注销受理**持久化 + 同一事务内撤销** · **真实 PostgreSQL** 端到端证据
//
// 运行（本机隔离集群，仅回环；库名硬钉，要求空库）：
//   createdb -h 127.0.0.1 -p <port> gengyun_deletion_test
//   node tests/integration/account-deletion-pg.mjs postgres://<superuser>@127.0.0.1:<port>/gengyun_deletion_test
//
// 本脚本只讲一件事：**受理注销这件事在真库上必须原子**，且**唯一写路径是一个窄口径
// `SECURITY DEFINER` 函数**。运行时角色 `gengyun_api_runtime` 对 `users.state` /
// `users.auth_epoch` / `users.revision` / `deletion_requests` **没有任何直接列权限**
// （见 `services/api/db/roles/auth_privacy.sql`），因此「绕过函数直接改列、直接写台账」
// 在本脚本里是**权限拒绝**（`42501`），不是约定、不是口头承诺。
//
// 覆盖的证据（编号沿用判定者报告 §6）：
//   [1] 迁移三连：全量迁移 up（跳过 0016）⇒ **回执唯一索引**；（在仓库清单里）版本号无重复；
//   [2] 0016 单独 **UP → ROLLBACK → REPLAY**：函数/列/约束/索引如实出现—消失—再出现；
//   [3] 最小权限：域组角色 + 运行时 LOGIN，**只有 EXECUTE** 这一条写路径；
//       直接 `UPDATE users SET auth_epoch=…`、直接写 `deletion_requests`、DDL 一律 `42501`；
//   [4] 臂 1 + 臂 10：受理端到端 ⇒ 202；`state=deletion_pending`、`auth_epoch` 恰好 +1、
//       `revision` +1、全会话撤销、台账恰好一行（属主/摘要/7-30-35 日期限）；
//   [5] 旧 token 语义（臂 5）：受理后旧 token ⇒ **401 `SESSION_EXPIRED`**（受理同时撤销了会话行
//       ⇒ 会话门先命中）；**臂 6**：仅 `auth_epoch+1`（state 仍 active、不撤会话）⇒ **403
//       `ACCOUNT_INACTIVE`**，message 是「会话已因账号变更失效」＝**epoch 分支**；
//       **臂 8**：仅撤会话行（state/epoch 不动）⇒ 401 `SESSION_EXPIRED`。三者互相可分辨。
//   [6] 臂 2 事务原子性：在 COMMIT 之前注入失败 ⇒ 503、库内 state/epoch/会话/台账**全部原样**、
//       旧 token **仍 200**（不复活也不被误杀）；「反向控制的反向控制」⇒ 去掉事务包装
//       （自动提交）后同一注入 ⇒ 库断言**全部翻转**，证明上一条的「原样」是事务的功劳；
//   [7] 级联失败**不得**回退撤销（提交点在级联之前）：收藏清理抛错 ⇒ 202 但 `state=blocked`
//       （如实不谎称完成），而账号状态/epoch/会话撤销**已提交**、旧 token **不复活**；
//   [8] 并发双受理（臂 3）：同一账号两个不同 `Idempotency-Key` 并发 ⇒ 恰好一个 202，
//       另一个 403/409（都不是 5xx 谎报），台账恰好一行、`auth_epoch` 恰好 +1；
//   [9] 跨用户（臂 9）：另一账号 state/epoch/会话/台账零变化，旧 token 仍 200
//       （不得「按全局键取第一行」误伤他人）；
//   [10] 幂等重放：同一 `Idempotency-Key` 重放 ⇒ 会话已在受理时被撤销 ⇒ 鉴权层先拦，
//       台账不得出现第二行；
//   [11] `real` 模式整域不可用：`available === false`，POST/GET 均 503
//       `PROVIDER_UNAVAILABLE`(`retryable=false`：未接线属确定性缺陷，重试不会成功)，零状态变更。
//
// 时钟口径（踩过的坑，别再踩）：注入的 `now` **必须是真时钟**。`idempotency_keys` 表有
// CHECK `expires_at > created_at`，而该表由**两条不同来源**的语句写入——台账 `claim()` 的
// `expires_at` 来自被注入的 `now`（100% 受控），`created_at` 是**库侧真时间**（`now()` 默认
// 值，注入不到）。冻结在过去的时刻（例如 `2026-10-15T03:00Z`）会让 `expires_at` 早于库侧
// `created_at` ⇒ 首次登录就在 `INSERT` 上撞 `23514` ⇒ ErrorHandler 回 500，**不是**契约
// 错误的噪声，而是测试自伤。真时钟下两条时间同源、恒满足约束；本文件所有期限断言都写成
// **差值**（7/30/35 日）而不是绝对时刻，故不依赖时钟可控。需要定位这类 500 时，运行前设
// `I19_DELETION_TEST_DEBUG=1` ⇒ 升到 `error` 级、把 pino 挂到进程 stderr（只多打印服务端
// 已记录的错误行，不改任何断言）。

import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';

import { loadConfig } from '../../services/api/src/config.ts';
import { buildApp } from '../../services/api/src/app.ts';
import { createPool } from '../../services/api/src/db/pool.ts';

const url = new URL(process.argv[2] ?? 'postgres://postgres@127.0.0.1:5432/gengyun_deletion_test');
assert.equal(url.hostname, '127.0.0.1', '本测试只允许回环地址');
assert.equal(url.pathname, '/gengyun_deletion_test', '库名必须硬钉为 gengyun_deletion_test（防误连）');

const API = '/api/v1';
const DELETION_PATH = `${API}/me/account/deletion`;
// 探针端点：`GET /auth/session`（`services/api/src/routes/auth.ts:85` 挂 `guards.requireUser`）。
// **不用** `/me/favorites`：该路径在 stub 装配下未接线 ⇒ 404 `未实现的路径`，会把鉴权结论整体带偏。
const SESSION_PROBE_PATH = `${API}/auth/session`;
const ACCOUNT_DELETION_FUNCTION = 'public.request_account_deletion';
const NEW_MIGRATION = '0016_account_deletion_persistence.sql';
const DOWN_MIGRATION = 'migrations/rollback/0016_account_deletion_persistence.down.sql';
const HOUR_MS = 3600 * 1000;

const serverNow = () => new Date();

const owner = new pg.Client({ connectionString: url.href });
await owner.connect();
/** 收工自证用：装载角色文件前先快照，收工后**任何**新出现的角色都必须被清掉。 */
const baselineRoles = new Set((await owner.query('SELECT rolname FROM pg_roles')).rows.map((row) => row.rolname));
// 与出厂 provisioning **同形**：5 个既有 NOLOGIN 域组 + 运行时可登录角色 `gengyun_api_runtime`
// （`deploy/postgres-cvm/sql/20-login-roles.sql` 的 A/B/C 段口径）。
const groups = [
  'gengyun_auth_privacy',
  'gengyun_preview_reader',
  'gengyun_consent_granter',
  'gengyun_profile_runtime',
  'gengyun_knowledge_runtime',
];
const roleFiles = [
  'roles/auth_privacy.sql',
  'roles/catalog_readers.sql',
  'roles/consent_granter.sql',
  'roles/profile_runtime.sql',
  'roles/knowledge_runtime.sql',
];
const runtimeRole = 'gengyun_api_runtime';
const password = randomBytes(24).toString('hex');
const hashKey = randomBytes(32).toString('hex');
const sqlFile = (path) => readFileSync(new URL(`../../services/api/db/${path}`, import.meta.url), 'utf8');
const deploySqlFile = (name) => readFileSync(new URL(`../../deploy/postgres-cvm/sql/${name}`, import.meta.url), 'utf8');
const migrationsDir = new URL('../../services/api/db/migrations/', import.meta.url);

/**
 * 从**出厂文件** `deploy/postgres-cvm/sql/20-login-roles.sql` 的区域标记里抽取注销授权语句并原样执行：
 * 不复制粘贴 SQL（授权语句被删/被改宽 ⇒ 本测试必须变红），并断言 EXECUTE **只**授予运行时角色。
 */
function deletionGrantRegion() {
  const matched = deploySqlFile('20-login-roles.sql').match(
    /-- #region gy-i19-deletion-grant\r?\n([\s\S]*?)\r?\n\s*-- #endregion gy-i19-deletion-grant/,
  );
  assert.ok(matched !== null, '20-login-roles.sql 必须含 gy-i19-deletion-grant 区域');
  const region = matched[1];
  assert.ok(region.includes('REVOKE ALL ON FUNCTION public.request_account_deletion'), '区域必须含 REVOKE … FROM PUBLIC');
  assert.equal((region.match(/GRANT EXECUTE ON FUNCTION/g) ?? []).length, 1, '区域必须**恰好一条** GRANT EXECUTE');
  assert.ok(region.includes(`TO ${runtimeRole};`), 'EXECUTE 只能授予运行时登录角色');
  assert.equal(/\\(echo|set|pset|if|endif|getenv|gexec)/.test(region), false, '区域不得含 psql 元命令（要能被 node 原样执行）');
  return region;
}

/** 回执摘要＝回执 bearer 的 sha256（**独立**用 node:crypto 算，不复用被测代码）。 */
const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');
/** 登录主体：三个 code 映射到**同一个** subject ⇒ 同一账号、三个会话（分离变量需要多会话）。 */
const subjectOf = (code) => createHmac('sha256', hashKey).update(`synthetic\n${code}`).digest('hex');

let pool;
const apps = [];
const createdRoles = [];
let passed = 0;
const say = (label) => {
  passed += 1;
  console.log(`PASS ${passed}: ${label}`);
};
const note = (line) => console.log(`  - ${line}`);

const userIdOf = async (code) =>
  (await owner.query('SELECT id FROM users WHERE wechat_subject_lookup=$1', [Buffer.from(subjectOf(code), 'hex')])).rows[0]
    ?.id;

const userRow = async (userId) =>
  (await owner.query('SELECT id,state,auth_epoch,revision FROM users WHERE id=$1', [userId])).rows[0];
const activeSessions = async (userId) =>
  Number(
    (await owner.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1 AND revoked_at IS NULL', [userId])).rows[0]
      .n,
  );
const requestRows = async (userId) =>
  (await owner.query('SELECT * FROM deletion_requests WHERE user_id=$1 ORDER BY requested_at DESC', [userId])).rows;
const requestCount = async (userId) =>
  Number((await owner.query('SELECT count(*)::int n FROM deletion_requests WHERE user_id=$1', [userId])).rows[0].n);

/** 回环 HTTP（只走 127.0.0.1）。请求体在这里**统一序列化一次**。 */
function makeHttp(origin) {
  return async function http(path, options = {}) {
    const headers = {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    };
    const response = await fetch(origin + path, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return {
      status: response.status,
      body,
      text,
      etag: response.headers.get('etag'),
      cache: response.headers.get('cache-control'),
    };
  };
}

/** 装机：迁移（跳过 0016，它单独演练）+ 后面再装最小权限角色与运行时 LOGIN。 */
async function applyMigrations() {
  const discovered = readdirSync(migrationsDir)
    .filter((name) => /^\d{4,}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  const versions = discovered.map((name) => name.slice(0, 4));
  assert.equal(new Set(versions).size, versions.length, `迁移版本号重复：${versions.join(',')}`);
  assert.ok(discovered.includes(NEW_MIGRATION), `迁移清单必须含 ${NEW_MIGRATION}`);
  note(`迁移清单（${discovered.length} 个）：${discovered.join(' ')}`);
  for (const name of discovered) {
    if (name === NEW_MIGRATION) continue; // 0016 由下面的 UP→ROLLBACK→REPLAY 单独演练
    await owner.query(sqlFile(`migrations/${name}`));
  }
  return discovered;
}

const runtimeUrl = () => {
  const runtime = new URL(url.href);
  runtime.username = runtimeRole;
  runtime.password = password;
  return runtime;
};

const debugLog = process.env.I19_DELETION_TEST_DEBUG === '1';
const debugStream = debugLog ? { write: (line) => process.stderr.write(`[server] ${line}`) } : undefined;
const stubConfig = () => ({
  ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: debugLog ? 'error' : 'silent' }),
  sessionSigningKey: hashKey,
});
const wechatPort = { exchange: async (code) => ({ subjectLookupHex: subjectOf(code.replace(/-\d+$/, '')) }) };

/** 建一个回环 app（可注入 pool/端口），返回 { app, http, origin }。 */
async function launch(overrides = {}) {
  const built = buildApp({
    config: stubConfig(),
    pool,
    wechat: wechatPort,
    now: serverNow,
    ...(debugStream === undefined ? {} : { logStream: debugStream }),
    ...overrides,
  });
  apps.push(built);
  const origin = await built.listen({ host: '127.0.0.1', port: 0 });
  return { app: built, http: makeHttp(origin), origin };
}

/**
 * 登录一次（同一 subject ⇒ 同一账号的新会话）；返回会话 token。
 *
 * `code`/`body` 一律交给本文件的 `makeHttp()` 序列化（**不要**在这里再 `JSON.stringify` 一次：
 * 双层编码会让请求体变成 JSON 字符串 ⇒ 契约校验 400 `must be object`）。
 */
async function login(http, code, suffix) {
  const res = await http(`${API}/auth/wechat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `login-${code}-${suffix}` },
    body: { code: `${code}-${suffix}` },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.access_token;
}

/** 受理一次；返回原始 HTTP 结果。 */
async function requestDeletion(http, token, key) {
  return http(DELETION_PATH, {
    method: 'POST',
    token,
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    // 同样交给 `makeHttp()` 序列化一次（双层编码 ⇒ 400 `must be object`）。
    body: { confirmation: 'delete_account' },
  });
}

/** 一条注入式「函数已执行、提交前已失败」的 pool 代理（**只**对注销受理那一句生效）。 */
function failingPoolAfterFunction(real) {
  const clientProxy = (client) => ({
    release: () => client.release(),
    async query(text, values) {
      const result = await client.query(text, values);
      if (typeof text === 'string' && text.includes('request_account_deletion')) {
        // 三处写入**已在事务内生效**，但提交尚未发生 ⇒ 正确行为是整体回滚。
        throw Object.assign(new Error('注入故障：函数已执行、COMMIT 之前失败'), { code: 'G0006' });
      }
      return result;
    },
  });
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property === 'connect') return async () => clientProxy(await target.connect());
      // 本代理被多个 app 共享：**不**真关池（关掉会让后续 app 无法复用同一集群连接）。
      if (property === 'end') return async () => {};
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** 事务控制语句（去事务包装的反向控制里要把它们变成空操作）。 */
const TRANSACTION_CONTROL_SQL = new Set(['BEGIN', 'COMMIT', 'ROLLBACK']);

/**
 * 反向控制（「反向控制的反向控制」）用的 pool 代理：**把事务包装拆成空操作**。
 *
 * 与 [6] 的注入**共用同一个真 store 工厂、同一份错误映射**，唯一差别是
 * `BEGIN`/`COMMIT`/`ROLLBACK`/`SET LOCAL` 不再发给服务器 ⇒ 那句函数调用变成**自动提交**
 * （语句级提交，服务器端真的落库），随后注入的 `G0006` 仍会让 store 抛出 503。
 * 因此两条臂只在「有没有事务」这一个变量上不同：若无事务时库断言立刻翻转，
 * 就证明 [6] 的整体回滚是**承重**的，而不是碰巧因为别的原因没写进去。
 */
function withoutTransaction(real) {
  const clientProxy = (client) => ({
    release: () => client.release(),
    async query(text, values) {
      const statement = typeof text === 'string' ? text.trim().toUpperCase() : '';
      if (TRANSACTION_CONTROL_SQL.has(statement) || statement.startsWith('SET LOCAL')) {
        return { rows: [], rowCount: 0 };
      }
      return client.query(text, values);
    },
  });
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property === 'connect') return async () => clientProxy(await target.connect());
      if (property === 'end') return async () => {};
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

try {
  // ---------------------------------------------------------------- [1] 前置与迁移三连
  const version = (await owner.query('SHOW server_version')).rows[0].server_version;
  assert.match(version, /^17\.11(?:\D|$)/);
  console.log(`Native PostgreSQL: ${version} @ ${url.hostname}:${url.port}${url.pathname}`);
  assert.equal((await owner.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0);
  assert.equal(
    (await owner.query('SELECT count(*)::int n FROM pg_roles WHERE rolname=ANY($1)', [[...groups, runtimeRole]])).rows[0].n,
    0,
  );
  const discovered = await applyMigrations();

  // [2] 0016 单独 UP → ROLLBACK → REPLAY（函数/列/约束/索引如实出现—消失—再出现）
  const functionCount = async () =>
    Number(
      (
        await owner.query(
          "SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='public' AND p.proname='request_account_deletion'",
        )
      ).rows[0].n,
    );
  const columnCount = async () =>
    Number(
      (
        await owner.query(
          "SELECT count(*)::int n FROM information_schema.columns WHERE table_name='deletion_requests' AND column_name=ANY(ARRAY['user_id','receipt_issued_at','receipt_expires_at'])",
        )
      ).rows[0].n,
    );
  const indexCount = async () =>
    Number(
      (
        await owner.query(
          "SELECT count(*)::int n FROM pg_indexes WHERE tablename='deletion_requests' AND indexname='deletion_requests_user_requested_idx'",
        )
      ).rows[0].n,
    );
  const constraintCount = async () =>
    Number((await owner.query("SELECT count(*)::int n FROM pg_constraint WHERE conname='deletion_requests_receipt_validity'")).rows[0].n);

  assert.equal(await functionCount(), 0);
  assert.equal(await columnCount(), 0);
  await owner.query(sqlFile(`migrations/${NEW_MIGRATION}`));
  assert.equal(await functionCount(), 1);
  assert.equal(await columnCount(), 3);
  assert.equal(await indexCount(), 1);
  assert.equal(await constraintCount(), 1);
  await owner.query(sqlFile(DOWN_MIGRATION));
  assert.equal(await functionCount(), 0, '回滚后函数必须消失');
  assert.equal(await columnCount(), 0, '回滚后三列必须消失');
  assert.equal(await indexCount(), 0);
  assert.equal(await constraintCount(), 0);
  await owner.query(sqlFile(`migrations/${NEW_MIGRATION}`));
  assert.equal(await functionCount(), 1, 'REPLAY 后函数必须回来');
  assert.equal(await columnCount(), 3);
  say(`迁移三连（真库）：全量 up（跳过 0016）⇒ ${NEW_MIGRATION} UP(函数 1/列 3/索引 1/约束 1) → ROLLBACK(全 0) → REPLAY(全回来)，版本号无重复`);

  // ---------------------------------------------------------------- [3] 最小权限
  // 与出厂 provisioning 同形：先装域组角色文件，再建运行时 LOGIN 并授组，最后**原样执行**
  // `20-login-roles.sql` 的注销授权区域（含「函数必须已存在」的前置）。
  for (const file of roleFiles) await owner.query(sqlFile(file));
  createdRoles.push(...groups);
  await owner.query(
    `CREATE ROLE ${runtimeRole} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
  );
  createdRoles.push(runtimeRole);
  await owner.query(`GRANT ${groups.join(', ')} TO ${runtimeRole}`);
  await owner.query(deletionGrantRegion());
  pool = createPool(runtimeUrl().href);
  const flags = (await pool.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.ok(Object.values(flags).every((value) => value === false));

  const executables = (
    await pool.query(
      `SELECT has_function_privilege(current_user, '${ACCOUNT_DELETION_FUNCTION}(uuid,uuid,text,integer,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz)', 'EXECUTE') AS ok`,
    )
  ).rows[0].ok;
  assert.equal(executables, true, '运行时角色必须能执行注销受理函数（唯一写路径）');
  const acl = (await owner.query(`SELECT coalesce(array_to_string(proacl, ','), '') acl FROM pg_proc WHERE proname='request_account_deletion'`)).rows[0].acl;
  assert.equal(/(^|,)=/.test(acl), false, `proacl 不得含 PUBLIC 授权：${acl}`);
  const definer = (await owner.query(`SELECT prosecdef, proconfig, pg_get_userbyid(proowner) owner FROM pg_proc WHERE proname='request_account_deletion'`)).rows[0];
  assert.equal(definer.prosecdef, true, '函数必须是 SECURITY DEFINER');
  assert.ok(definer.proconfig.includes('search_path=pg_catalog'), `search_path 必须固定：${definer.proconfig}`);
  assert.notEqual(definer.owner, runtimeRole, '函数属主不得是运行时角色');
  assert.equal(
    (await owner.query(`SELECT NOT pg_has_role('${runtimeRole}', pg_get_userbyid(proowner), 'MEMBER') AS ok FROM pg_proc WHERE proname='request_account_deletion'`)).rows[0].ok,
    true,
    '运行时不得能 SET ROLE 成函数属主',
  );
  assert.equal(
    (
      await owner.query(
        `SELECT has_column_privilege(pg_get_userbyid(proowner),'public.users','state','UPDATE') AND has_column_privilege(pg_get_userbyid(proowner),'public.users','auth_epoch','UPDATE') AND has_column_privilege(pg_get_userbyid(proowner),'public.users','revision','UPDATE') AND has_table_privilege(pg_get_userbyid(proowner),'public.deletion_requests','INSERT') AS ok FROM pg_proc WHERE proname='request_account_deletion'`,
      )
    ).rows[0].ok,
    true,
    '函数属主必须真有能完成三处特权写入',
  );
  note(`函数级契约：SECURITY DEFINER=true、search_path 固定、proacl=${acl}、属主=${definer.owner}`);

  const forbidden = [
    'UPDATE users SET auth_epoch = auth_epoch + 1',
    "UPDATE users SET state='deleted'",
    'UPDATE users SET revision = revision + 1',
    'UPDATE sessions SET auth_epoch = auth_epoch + 1',
    "INSERT INTO deletion_requests(id,user_id,receipt_hash,generation,online_due_at,backup_due_at,receipt_expires_at) VALUES(gen_random_uuid(),gen_random_uuid(),repeat('a',64),1,now(),now(),now())",
    "UPDATE deletion_requests SET state='completed'",
    'DELETE FROM deletion_requests',
    'ALTER TABLE deletion_requests ADD COLUMN forbidden int',
    'CREATE TABLE forbidden(x int)',
  ];
  for (const sql of forbidden) {
    await assert.rejects(pool.query(sql), (error) => error.code === '42501', `必须被权限拒绝：${sql}`);
  }
  // 反向控制的正向半边：既有授权**没有**被顺手收紧（撤销单会话仍是运行时的日常工作）。
  await pool.query('UPDATE sessions SET revoked_at = revoked_at WHERE false');
  await pool.query('SELECT id,state,auth_epoch,revision FROM users LIMIT 1');
  say(
    `最小权限（真库）：运行时 LOGIN 继承 ${groups.join('+')}，**只有 EXECUTE** 唯一写路径、可读 users 四列、可撤单会话；` +
      '直接改 users.state/auth_epoch/revision、改 sessions.auth_epoch、写/改/删 deletion_requests、DDL 一律 42501',
  );

  // ---------------------------------------------------------------- 装配 A：正常路径
  const primary = await launch();
  const http = primary.http;
  const codeA = 'i19-del-a';
  const tokenA1 = await login(http, codeA, 1);
  await login(http, codeA, 2);
  await login(http, codeA, 3);
  const userA = await userIdOf(codeA);
  assert.ok(userA, '账号必须已建立');
  const beforeA = await userRow(userA);
  assert.equal(beforeA.state, 'active');
  assert.equal(Number(beforeA.auth_epoch), 1);
  assert.equal(await activeSessions(userA), 3);
  assert.equal(await requestCount(userA), 0);

  // [4] 臂 1 + 臂 10：受理端到端
  const accepted = await requestDeletion(http, tokenA1, 'i19-del-a-key-1');
  assert.equal(accepted.status, 202, `受理必须 202（不得 42501 权限错）：${accepted.text}`);
  assert.equal(accepted.body.meta.execution_mode, 'stub');
  assert.equal(accepted.cache, 'no-store');
  // 202 的 `data` 形状由 `services/api/src/routes/account-deletion.ts:167-171` 定：
  // `{ receipt_token, receipt_expires_at, deletion }` ⇒ 注销请求 id 在 **`data.deletion.id`**。
  const requestId = accepted.body.data.deletion.id;
  const receiptToken = accepted.body.data.receipt_token;
  assert.match(String(requestId), /^[0-9a-f-]{36}$/, `受理必须回注销请求 id：${accepted.text}`);
  assert.equal(accepted.body.data.deletion.state === 'completed', false, '受理不得自称已完成');

  const afterA = await userRow(userA);
  assert.equal(afterA.state, 'deletion_pending', '状态必须迁移');
  assert.equal(Number(afterA.auth_epoch), 2, 'auth_epoch 必须恰好 +1');
  assert.equal(Number(afterA.revision), 2, 'revision 必须 +1');
  assert.equal(await activeSessions(userA), 0, '该用户全部活跃会话必须撤销');
  const rowsA = await requestRows(userA);
  assert.equal(rowsA.length, 1, '注销请求必须恰好落库一行');
  const rowA = rowsA[0];
  assert.equal(rowA.id, requestId);
  assert.equal(rowA.state, 'requested');
  assert.equal(rowA.generation, 1);
  // 回执 bearer 的摘要：服务端**只存 sha256 摘要、不存明文**（`services/api/src/privacy/account-deletion.ts:19`）。
  // 注意口径（实测，别写过头）：202 响应里的 `receipt_token` 是回执台账**另发**的 bearer，与
  // 持久列 `receipt_hash` 存的不是同一个串；后者是 `requestDeletionFor()` 传入的回执输入摘要。
  // 故这里只断言「确实是一个 sha256 摘要、且不是回执 bearer 的摘要」，**不**宣称列里就是 bearer 的摘要。
  assert.match(String(rowA.receipt_hash), /^[0-9a-f]{64}$/, '库内回执摘要必须是 sha256 hex');
  assert.notEqual(rowA.receipt_hash, sha256Hex(receiptToken), '库内摘要不得等于回执 bearer 的明文摘要（两者是不同凭据）');
  note(`回执摘要：库内=${String(rowA.receipt_hash).slice(0, 16)}…（sha256 hex，非回执 bearer 摘要）`);
  assert.equal(Number(rowA.receipt_expires_at) - Number(rowA.receipt_issued_at), 35 * 24 * HOUR_MS, '回执期限必须 35 日');
  assert.equal(Number(rowA.online_due_at) - Number(rowA.requested_at), 7 * 24 * HOUR_MS, '在线截止必须 +7 日');
  assert.equal(Number(rowA.backup_due_at) - Number(rowA.requested_at), 30 * 24 * HOUR_MS, '备份截止必须 +30 日');
  assert.equal(Number(rowA.revision), 1);
  assert.equal(rowA.completed_at, null, '受理不得写完成时刻（未完成不得谎称完成）');

  const receiptRead = await http(`${API}/account/deletions/${requestId}`, { token: receiptToken });
  assert.equal(receiptRead.status, 200, JSON.stringify(receiptRead.body));
  assert.equal(receiptRead.body.data.id, requestId);
  const sessionOnReceiptPath = await http(`${API}/account/deletions/${requestId}`, { token: tokenA1 });
  assert.equal(sessionOnReceiptPath.status, 401, '回执路径不接受登录会话');
  say(
    `臂 10/臂 1（真库）：运行时角色经唯一写路径受理 ⇒ 202；库内 state=deletion_pending、auth_epoch 1→2、revision 1→2、活跃会话 3→0、` +
      'deletion_requests 恰 1 行（属主=该账号、回执摘要=sha256 hex 且非回执 bearer 的摘要、7/30/35 日期限），回执 GET 200、会话顶替 401',
  );

  // [5] 旧 token 语义（臂 5）——**冻结口径**：受理路径同时撤销会话行 ⇒ 会话门先命中 ⇒ **401**
  //     `SESSION_EXPIRED`；若**只**递增 `auth_epoch`（不撤会话行）才得 403 `ACCOUNT_INACTIVE`
  //     （见下面臂 6）。`tests/unit/auth-routes.test.mjs:230-243` 钉住的正是后者那句。
  const oldTokenAfter = await http(SESSION_PROBE_PATH, { token: tokenA1 });
  assert.equal(oldTokenAfter.status, 401, JSON.stringify(oldTokenAfter.body));
  assert.equal(oldTokenAfter.body.error.code, 'SESSION_EXPIRED', '受理撤销会话行 ⇒ 会话门先命中');
  say(
    '臂 5（真库）：受理后旧 token ⇒ 401 SESSION_EXPIRED（会话行已被受理撤销 ⇒ 会话门先命中）；' +
      '要 403 ACCOUNT_INACTIVE 只能「仅递增 auth_epoch、不撤会话」——见臂 6',
  );

  // [9] 跨用户对照（臂 9）
  const codeB = 'i19-del-b';
  const tokenB1 = await login(http, codeB, 1);
  await login(http, codeB, 2);
  const userB = await userIdOf(codeB);
  const bAfterA = await userRow(userB);
  assert.equal(bAfterA.state, 'active');
  assert.equal(Number(bAfterA.auth_epoch), 1);
  assert.equal(await activeSessions(userB), 2);
  assert.equal(await requestCount(userB), 0);
  assert.equal((await http(SESSION_PROBE_PATH, { token: tokenB1 })).status, 200);
  say('跨用户（真库）：另一账号 state/epoch/会话/删除请求零变化、旧 token 仍 200 ⇒ 不「按全局键取第一行」');

  // [10] 幂等键：受理后同键重放被鉴权层拦下（会话已撤销），持久化层不得出现第二行
  const replay = await requestDeletion(http, tokenA1, 'i19-del-a-key-1');
  assert.ok([401, 403].includes(replay.status), `已被撤销的会话不得再受理：${replay.status}`);
  assert.equal(await requestCount(userA), 1, '重放不得产生第二条删除请求');
  const ledgerRows = Number(
    (await owner.query("SELECT count(*)::int n FROM idempotency_keys WHERE scope LIKE '%me/account/deletion%'")).rows[0].n,
  );
  assert.equal(ledgerRows, 1, '幂等台账必须恰好一行（同键重放不新增）');
  say(`幂等（真库）：同键重放 ⇒ ${replay.status}（会话已在受理时被撤销，鉴权层先拦）；deletion_requests 仍 1 行、幂等台账仍 1 行`);

  // [8] 并发双受理（臂 3）
  const codeC = 'i19-del-c';
  const tokenC1 = await login(http, codeC, 1);
  const userC = await userIdOf(codeC);
  const [raceOne, raceTwo] = await Promise.all([
    requestDeletion(http, tokenC1, 'i19-del-c-key-1'),
    requestDeletion(http, tokenC1, 'i19-del-c-key-2'),
  ]);
  const statuses = [raceOne.status, raceTwo.status].sort((a, b) => a - b);
  const acceptedCount = statuses.filter((status) => status === 202).length;
  const loserStatuses = statuses.filter((status) => status !== 202);
  assert.equal(acceptedCount, 1, `并发双受理必须恰好一个 202：${statuses.join(',')}`);
  // 败者的**确定**失败面（三种都合法，且都不是 5xx 谎报）：受理同时撤销会话行 ⇒ 后到者可能
  // 在鉴权层就被会话门拦下（401）；若进到受理服务，则被状态门拦下（403）或撞修订冲突（409）。
  assert.equal(loserStatuses.length, 1, `并发必须恰好一个败者：${statuses.join(',')}`);
  assert.ok(
    [401, 403, 409].includes(loserStatuses[0]),
    `并发失败面必须确定性（401/403/409），不得 5xx：${statuses.join(',')}`,
  );
  const cRow = await userRow(userC);
  assert.equal(cRow.state, 'deletion_pending');
  assert.equal(Number(cRow.auth_epoch), 2, 'auth_epoch 必须恰好 +1（不得双递增）');
  assert.equal(await requestCount(userC), 1, '并发不得产生第二条删除请求');
  assert.equal(await activeSessions(userC), 0);
  say(`臂 3（真库）：同账号两个不同幂等键并发 ⇒ 状态码 ${statuses.join('/')}（恰好一个 202），deletion_requests 恰 1 行、auth_epoch 恰 +1、活跃会话 0`);

  // [5'] 分离变量：仅 auth_epoch+1（state 仍 active）⇒ 403 但 message 是 **epoch 分支**
  const codeE = 'i19-del-epoch';
  const tokenE1 = await login(http, codeE, 1);
  const userE = await userIdOf(codeE);
  await owner.query('UPDATE users SET auth_epoch = auth_epoch + 1 WHERE id=$1', [userE]);
  const eRow = await userRow(userE);
  assert.equal(eRow.state, 'active', '本臂**只**加 auth_epoch，state 必须仍是 active');
  assert.equal(Number(eRow.auth_epoch), 2);
  assert.equal(await activeSessions(userE), 1, '本臂不动会话表');
  const epochOnly = await http(SESSION_PROBE_PATH, { token: tokenE1 });
  assert.equal(epochOnly.status, 403, JSON.stringify(epochOnly.body));
  assert.equal(epochOnly.body.error.code, 'ACCOUNT_INACTIVE');
  assert.equal(epochOnly.body.error.message, '会话已因账号变更失效', '必须是 epoch 分支的文案（区别状态门的「账号不可用」）');
  say(
    '臂 6（分离变量·真库）：state 仍 active ＋**仅** auth_epoch 递增 ⇒ 403 ACCOUNT_INACTIVE（message=会话已因账号变更失效 ⇒ epoch 分支）；' +
      '⚠ 登记：裁定旧文此处期望 401 SESSION_EXPIRED，实测冻结行为是 403（`tests/unit/auth-routes.test.mjs` 固化）',
  );

  // [5''] 仅撤会话行（state/epoch 不动）⇒ 401 SESSION_EXPIRED（两个机制可分辨）
  const codeF = 'i19-del-session';
  const tokenF1 = await login(http, codeF, 1);
  const userF = await userIdOf(codeF);
  await owner.query('UPDATE sessions SET revoked_at = now() WHERE user_id=$1 AND revoked_at IS NULL', [userF]);
  const fRow = await userRow(userF);
  assert.equal(fRow.state, 'active');
  assert.equal(Number(fRow.auth_epoch), 1, '本臂不动 auth_epoch');
  const sessionOnly = await http(SESSION_PROBE_PATH, { token: tokenF1 });
  assert.equal(sessionOnly.status, 401, JSON.stringify(sessionOnly.body));
  assert.equal(sessionOnly.body.error.code, 'SESSION_EXPIRED');
  say('臂 8（分离变量·真库）：**仅**撤销会话行（state=active、epoch 不动）⇒ 401 SESSION_EXPIRED ⇒ 与臂 6 的 403 可分辨（两个独立机制，不得混用）');

  // ---------------------------------------------------------------- [6] 事务原子性（臂 2）
  const codeD = 'i19-del-rollback';
  const rolledBack = await launch({ pool: failingPoolAfterFunction(pool) });
  const tokenD1 = await login(rolledBack.http, codeD, 1);
  await login(rolledBack.http, codeD, 2);
  await login(rolledBack.http, codeD, 3);
  const userD = await userIdOf(codeD);
  assert.equal(await activeSessions(userD), 3);
  const failed = await requestDeletion(rolledBack.http, tokenD1, 'i19-del-d-key-1');
  assert.notEqual(failed.status, 202, `中途失败绝不能回 202：${failed.text}`);
  assert.equal(failed.status, 503, JSON.stringify(failed.body));
  assert.equal(failed.body.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(failed.body.error.retryable, true);
  assert.equal(rolledBack.app.deletionReceipts.liveCount(), 0, '失败不得签发任何回执');
  const dRow = await userRow(userD);
  assert.equal(dRow.state, 'active', '整体回滚：状态必须原样');
  assert.equal(Number(dRow.auth_epoch), 1, '整体回滚：auth_epoch 必须原样');
  assert.equal(await activeSessions(userD), 3, '整体回滚：三个会话必须仍活跃');
  assert.equal(await requestCount(userD), 0, '整体回滚：不得留下半行删除请求');
  const dTokenAfter = await http(SESSION_PROBE_PATH, { token: tokenD1 });
  assert.equal(dTokenAfter.status, 200, '事务内失败不得误杀旧 token（库内零写入 ⇒ 会话理论仍有效）');
  say(
    '臂 2（真库·事务内失败）：受理在 COMMIT 前抛错 ⇒ 503 PROVIDER_UNAVAILABLE(retryable)、零回执、库内 state/epoch/会话/删除请求**全部原样**、旧 token **仍 200**（未复活也未被误杀）',
  );

  // 反向控制的反向控制：**去掉事务包装**（BEGIN/COMMIT/ROLLBACK/SET LOCAL 全部空操作）⇒
  // 同一份注入、同一个真 store、同一份错误映射 ⇒ 库断言必须翻转。
  const codeG = 'i19-del-autocommit';
  const autoCommit = await launch({
    pool: withoutTransaction(failingPoolAfterFunction(pool)),
  });
  const tokenG1 = await login(autoCommit.http, codeG, 1);
  const userG = await userIdOf(codeG);
  const naive = await requestDeletion(autoCommit.http, tokenG1, 'i19-del-g-key-1');
  assert.notEqual(naive.status, 202);
  assert.equal(naive.status, 503);
  const gRow = await userRow(userG);
  assert.equal(gRow.state, 'deletion_pending', '反向控制：拆掉事务 ⇒ 状态变更**已提交**（证明臂 2 的回滚是承重的）');
  assert.equal(Number(gRow.auth_epoch), 2);
  assert.equal(await activeSessions(userG), 0);
  assert.equal(await requestCount(userG), 1);
  const gProbe = await http(SESSION_PROBE_PATH, { token: tokenG1 });
  assert.equal(gProbe.status, 401, '反向控制：旧 token 已被这次「未回滚」的写入杀掉（会话行已撤 ⇒ 401）');
  assert.equal(gProbe.body.error.code, 'SESSION_EXPIRED');
  say(
    '臂 2 的反向控制的反向控制（真库）：把事务包装拆掉（自动提交）后同一注入 ⇒ 库断言**全部翻转**（deletion_pending/epoch+1/会话 0/请求 1 行、旧 token 401 已失效）⇒ 上一条的回滚确为承重',
  );

  // ---------------------------------------------------------------- [7] 级联失败不得回退撤销
  const codeH = 'i19-del-cascade';
  const cascadeFail = await launch({
    favoritesInjection: {
      store: {
        deleteAllByOwner: async () => {
          throw new Error('注入级联故障：在线清理失败');
        },
        insertFavorite: async () => {},
        listFavorites: async () => [],
      },
    },
  });
  const tokenH1 = await login(cascadeFail.http, codeH, 1);
  const userH = await userIdOf(codeH);
  const cascadeResult = await requestDeletion(cascadeFail.http, tokenH1, 'i19-del-h-key-1');
  assert.equal(cascadeResult.status, 202, JSON.stringify(cascadeResult.body));
  assert.equal(
    cascadeResult.body.data.deletion.state,
    'blocked',
    '级联失败必须如实 blocked（不得谎称 completed）',
  );
  const hRow = await userRow(userH);
  assert.equal(hRow.state, 'deletion_pending', '级联失败**不得**回退已提交的撤销');
  assert.equal(Number(hRow.auth_epoch), 2);
  assert.equal(await activeSessions(userH), 0);
  assert.equal(await requestCount(userH), 1);
  const hProbe = await http(SESSION_PROBE_PATH, { token: tokenH1 });
  assert.equal(hProbe.status, 401, '级联失败后旧 token 不得复活（会话行已撤 ⇒ 401）');
  assert.equal(hProbe.body.error.code, 'SESSION_EXPIRED');
  say('级联失败（真库）：收藏清理抛错 ⇒ 202 但 state=blocked（如实）；账号撤销**已提交**且旧 token 不得复活（401）⇒ 提交点在级联之前');

  // ---------------------------------------------------------------- [11] real 模式整域闸
  const codeI = 'i19-del-real';
  const tokenI1 = await login(http, codeI, 1);
  const userI = await userIdOf(codeI);
  const realApp = buildApp({
    config: loadConfig({
      APP_EXECUTION_MODE: 'real',
      LOG_LEVEL: 'silent',
      SESSION_SIGNING_KEY: hashKey,
      DATABASE_URL: 'postgres://synthetic_local_only@127.0.0.1:5432/gengyun_synthetic_never_connected',
      DELETION_LEDGER_KEY: 'synthetic-not-a-real-ledger-key',
      WECHAT_APP_ID: 'synthetic-not-a-real-appid',
      WECHAT_APP_SECRET: 'synthetic-not-a-real-appsecret',
      OBJECT_STORAGE_ENDPOINT: 'https://example.invalid',
      OBJECT_STORAGE_BUCKET: 'synthetic-not-a-real-bucket',
      OBJECT_STORAGE_ACCESS_KEY: 'synthetic-not-a-real-access-key',
      OBJECT_STORAGE_SECRET_KEY: 'synthetic-not-a-real-secret-key',
    }),
    pool,
    wechat: wechatPort,
    now: serverNow,
  });
  apps.push(realApp);
  const realOrigin = await realApp.listen({ host: '127.0.0.1', port: 0 });
  const realHttp = makeHttp(realOrigin);
  assert.equal(realApp.accountDeletion.available, false, 'real 模式下注销域必须不可用（即使装配了真库）');
  const realPost = await requestDeletion(realHttp, tokenI1, 'i19-del-i-key-1');
  assert.equal(realPost.status, 503, JSON.stringify(realPost.body));
  assert.equal(realPost.body.error.code, 'PROVIDER_UNAVAILABLE');
  // 现状说明：未接线／未装配属**确定性缺陷**（要运维改配置才能好），同一请求重试不会成功 ⇒ 口径必须是
  // `retryable:false`（唯一口径见 `services/api/src/errors.ts:31-32`；同族断言在 main 的
  // `tests/integration/account-deletion-http.mjs:406` 已按 #233 收敛为 false）。
  assert.equal(realPost.body.error.retryable, false);
  const realGet = await realHttp(`${API}/account/deletions/${requestId}`, { token: receiptToken });
  assert.equal(realGet.status, 503, 'real 下回执面同样 503（门先于存在性判断）');
  const iRow = await userRow(userI);
  assert.equal(iRow.state, 'active');
  assert.equal(Number(iRow.auth_epoch), 1);
  assert.equal(await activeSessions(userI), 1);
  assert.equal(await requestCount(userI), 0);
  assert.equal(realApp.deletionReceipts.liveCount(), 0);
  say('real 模式（真库）：`available === false`，POST/GET 均 503 PROVIDER_UNAVAILABLE(retryable=false：未接线不可重试)，且该账号零状态变化、零回执 ⇒ 真库存在也不放行 real 域');

  console.log(`\nRESULT=PASS ${passed} 组；真实 PostgreSQL ${version}（本机隔离、仅回环）；未发出任何对外付费请求；发现迁移 ${discovered.length} 个`);
} finally {
  for (const built of apps) await built?.close?.().catch(() => {});
  await pool?.end?.().catch(() => {});
  for (const role of [...createdRoles].reverse()) {
    await owner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`).catch(() => {});
    await owner.query(`DROP OWNED BY ${role}`).catch(() => {});
    await owner.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
  }
  // 角色文件会顺带建出别的角色（例如 gengyun_evidence_reader）：按**快照差集**清，不容残留。
  const leftover = (await owner.query('SELECT rolname FROM pg_roles')).rows
    .map((row) => row.rolname)
    .filter((name) => !baselineRoles.has(name));
  for (const role of leftover) {
    await owner.query(`DROP OWNED BY ${role}`).catch(() => {});
    await owner.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
  }
  const residue = (await owner.query('SELECT rolname FROM pg_roles')).rows
    .map((row) => row.rolname)
    .filter((name) => !baselineRoles.has(name));
  await owner.end();
  if (residue.length > 0) throw new Error(`收工残留角色（必须人工清理并查明）：${residue.join(', ')}`);
  console.log('CLEANUP=done（运行时 LOGIN 与本次新建的所有角色已清理并复核为空；库由运行器删除）');
}
