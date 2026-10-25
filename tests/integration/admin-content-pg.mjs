// GY-R34-I18（#18）· 内容域 PG 落点 · **真实 PostgreSQL 17** 全链路证据
//
// 运行（自起自停的临时集群，只走 127.0.0.1）：
//   $env:GY_PG_BIN = 'E:\GengYunCommander\.pg17\pgsql\bin'      # 必填：含 initdb/pg_ctl 的目录
//   $env:GY_I18_PG_ROOT = 'E:\GengYunCommander\.pg17\tmp'        # 选填：数据目录根（默认 os.tmpdir()）
//   node tests/integration/admin-content-pg.mjs
// 未设置 `GY_PG_BIN` ⇒ 打印 SKIP 并以 **77** 退出（POSIX「skipped」/未取得，**不是通过**）。
// ⚠ `pg` 依赖必须**闸门之后**再 `await import('pg')`：静态 `import pg from 'pg'` 会被提升到
//   闸门之上，于是"没有 PG 二进制"会被报成"依赖缺失 ⇒ 失败"，而正确语义是"跳过"。
//
// ## 本脚本自证什么（对应证据页 §6 的变异/真库臂）
//
// 组号与运行时 say('[n] …') 一一对应（改一处必须同步另一处，否则证据页读数对不上）：
// [0] 全链迁移（0001…0036）建出三张表；
// [1] 运行时角色 gengyun_api_runtime 按**列**拿到 SELECT/INSERT/UPDATE（区域 gy-r34-content-grant）；
// [2] 授权读数：列级真；表级 DELETE/TRUNCATE/REFERENCES/TRIGGER 三张表全假；
// [3] 组装层 buildApp({ pool }) + execution_mode=real ⇒ 内容域 24 条**不再 503**，走产品真实路径
//     （HTTP → routes/admin.ts → service.ts → admin/ops/content-pg.ts）；建草稿 201 + 同 key 重放逐字一致
//     （PG 台账 1 行，不是内存 Map）；
// [4] 列表 200 → 读 200（ETag）→ 改 200（If-Match 守卫，revision 1→2）；
// [5] 发布 200 → 撤回 200，状态位真的写进了 PG；
// [6] 库内真值（库属主视角读，不混授权）：实体 1 行 + 版本 ≥2 行 + 台账 1 行；
// [7] 归属隔离：另一个 steward 的列表看不见本实体（steward_id 过滤在 SQL 里）；
// [8] 授权面**负控制**（"列级而非表级"的硬证据）：运行时直接 DELETE / TRUNCATE / 改未授权列 steward_id
//     ⇒ 一律 **42501**；改已授权列则在同一条语句上**通过**（对照）；
// [9] **公开读可见性（端到端）**：0036 就绪（onReady 探测 ready）＋ 来源已撤回 ⇒ `/herbicides`
//     必须**隐藏**该条且仍 200（不是 503）—— 真实 PG + 真实解析器，不用桩；
// [10] 迁移回滚 rollback/0036_*.down.sql 能把三张表删净（在独立模板库里跑）。
//
// ## 为什么是「自起临时集群」而不是接既有 env
// 生产路径要两个身份：库属主（建表/迁移/造账号行）＋运行时角色（真正的读写者）。共享 CI 集群里
// 角色与授权是**跨库残留**的，接既有库要么复用别人的角色（拿不到「本片授权够不够」的读数），
// 要么在别人库里建角色（留下残留）。自起集群能保证：空库 ⇒ 全链迁移 ⇒ 干净角色 ⇒ 跑完
// `pg_ctl stop` 并删数据目录，**零残留**。端口取 55600–55699 并先探活再 initdb。

const binDir = process.env.GY_PG_BIN ?? '';
if (binDir === '') {
  console.log('SKIP: 未设置 GY_PG_BIN（postgres 二进制目录，含 initdb/pg_ctl）⇒ 内容域真库臂跳过。');
  console.log('SKIP: 因此本机没有取得「0036 三表 + 列级授权 + 全生命周期落库」的真库读数（未取得，不是通过）。');
  console.log('EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本脚本刻意不提供 --allow-skip）。');
  process.exit(77);
}

// ⚠ 必须在闸门之后动态加载：静态 import 会被提升，把"跳过"变成"失败"。
const pg = (await import('pg')).default;

const assert = (await import('node:assert/strict')).default;
const { spawnSync } = await import('node:child_process');
const { randomBytes, randomInt, randomUUID } = await import('node:crypto');
const { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } = await import('node:fs');
const net = (await import('node:net')).default;
const { tmpdir } = await import('node:os');
const { basename, join } = await import('node:path');
const { setTimeout: sleep } = await import('node:timers/promises');

const { buildApp } = await import('../../services/api/src/app.ts');
const { loadConfig } = await import('../../services/api/src/config.ts');
const { createMemoryAuthStore } = await import('../../services/api/src/auth/store.ts');
const { hashToken, mintOpaqueToken } = await import('../../services/api/src/auth/tokens.ts');

const API = '/api/v1';
const DB_NAME = 'gengyun_admin_content_pg_test';
const RUNTIME_ROLE = 'gengyun_api_runtime';
const TABLES = ['admin_content_entities', 'admin_content_revisions', 'admin_content_idempotency'];
const serverLog = process.env.GY_I18_PG_LOG ?? join(tmpdir(), `gy-i18-pg-${randomBytes(3).toString('hex')}.log`);

const migrationsDir = new URL('../../services/api/db/migrations/', import.meta.url);
const readSql = (path) => readFileSync(new URL(`../../services/api/db/${path}`, import.meta.url), 'utf8');
const deploySqlFile = (name) => readFileSync(new URL(`../../deploy/postgres-cvm/sql/${name}`, import.meta.url), 'utf8');

let passed = 0;
const say = (label) => {
  passed += 1;
  console.log(`PASS ${passed}: ${label}`);
  return passed;
};
const note = (line) => console.log(`  - ${line}`);

// ---------------------------------------------------------------------------
// 临时集群（数据目录与端口都随机；端口取 55600–55699，避开 55436 的遗留集群与本机 5432）
// ---------------------------------------------------------------------------
const rootDir = process.env.GY_I18_PG_ROOT ?? tmpdir();
const dataDir = join(rootDir, `gy-i18-admin-content-pg-${randomBytes(4).toString('hex')}`);
let port = 0;
let adminBase = '';
let targetUrl = '';
const tool = (name) => join(binDir, process.platform === 'win32' ? `${name}.exe` : name);

function portIsFree(candidate) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(candidate, '127.0.0.1');
  });
}

async function pickPort() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = 55600 + randomInt(0, 100);
    if (candidate === 55436 || candidate === 55437) continue; // 别人的遗留集群，硬挡
    if (await portIsFree(candidate)) return candidate;
  }
  throw new Error('556xx 区间内找不到空闲端口（同机临时集群过多）');
}

/**
 * 子进程统一把 stdout/stderr 重定向到**文件**：本机 sandbox 禁止命名管道，
 * 用管道收集 postgres/pg_ctl 的输出会让调用方等 EOF 等到超时。
 */
function runTool(name, args) {
  const fd = openSync(serverLog, 'a');
  try {
    return spawnSync(tool(name), args, {
      stdio: ['ignore', fd, fd],
      env: { ...process.env, PGCONNECT_TIMEOUT: '5' },
      timeout: 300_000,
      windowsHide: true,
    });
  } finally {
    closeSync(fd);
  }
}

/**
 * `pg_ctl -o` 的 postgres 参数（**一个字符串**：传给 `-o` 的数组会被当成一个参数）。
 * POSIX 上必须把 unix socket 指到本集群自己的数据目录，否则 `pg_ctl start` 会因
 * `/var/run/postgresql` 不可写而失败。
 */
function serverOptions() {
  const options = [`-p ${port}`, '-c listen_addresses=127.0.0.1', '-c max_connections=32'];
  if (process.platform !== 'win32') options.push(`-k ${dataDir}`);
  return options.join(' ');
}

function tailOfFile(file, maxLines = 15) {
  try {
    const lines = readFileSync(file, 'utf8').replace(/\s+$/, '').split('\n');
    return lines.slice(-maxLines).join('\n');
  } catch (error) {
    return `（读不到 ${file}：${error.message}）`;
  }
}

async function startCluster() {
  port = await pickPort();
  adminBase = `postgresql://postgres@127.0.0.1:${port}`;
  targetUrl = `${adminBase}/${DB_NAME}`;
  assert.ok(existsSync(tool('initdb')), `GY_PG_BIN 下没有 initdb：${tool('initdb')}`);
  mkdirSync(dataDir, { recursive: true });
  const init = runTool('initdb', ['-D', dataDir, '--no-sync', '--encoding=UTF8', '--locale=C', '-U', 'postgres', '--auth=trust']);
  assert.equal(init.status, 0, `initdb 失败（status=${init.status}，日志见 ${serverLog}）`);
  const start = runTool('pg_ctl', ['-D', dataDir, '-l', join(dataDir, 'server.log'), '-o', serverOptions(), '-t', '60', '-w', 'start']);
  assert.equal(
    start.status,
    0,
    `pg_ctl start 失败（status=${start.status}，工具日志见 ${serverLog}；`
      + `server.log 尾部：\n${tailOfFile(join(dataDir, 'server.log'))}）`,
  );
  note(`临时集群：数据目录 ${dataDir}，端口 ${port}（只监听 127.0.0.1）`);
}

function stopCluster() {
  // 只删本脚本自己建的那个目录（名字前缀硬钉，避免误删工作树/源码）。
  assert.ok(basename(dataDir).startsWith('gy-i18-admin-content-pg-'), `拒绝删除非本脚本创建的目录：${dataDir}`);
  if (existsSync(join(dataDir, 'PG_VERSION'))) runTool('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10 });
}

async function connectWithRetry(connectionString, attempts = 40) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 2_000 });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      await sleep(250);
    }
  }
  throw lastError;
}

/** 部署脚本里的具名区域（`-- #region <name>` … `-- #endregion <name>`），并拒绝 psql 元命令。 */
function deployRegion(name) {
  const matched = deploySqlFile('20-login-roles.sql').match(
    new RegExp(`-- #region ${name}\\r?\\n([\\s\\S]*?)\\r?\\n\\s*-- #endregion ${name}`),
  );
  assert.ok(matched !== null, `20-login-roles.sql 必须含 ${name} 区域`);
  const region = matched[1];
  assert.equal(/\\(echo|set|pset|if|endif|getenv|gexec)/.test(region), false, `${name} 区域不得含 psql 元命令`);
  return region;
}

/** 断言某条语句以 42501（权限不足）失败；用于授权面的**负控制**。 */
async function expectDenied(client, sql, label) {
  try {
    await client.query(sql);
  } catch (error) {
    assert.equal(error.code, '42501', `${label} 必须以 42501 失败，实际 ${error.code}：${error.message}`);
    return error.code;
  }
  throw new Error(`${label} 竟然成功了 —— 授权面漏了（这是负控制的红线）`);
}

const SOURCE_INPUT = () => ({
  title: '浙江省水稻田稗草防治技术指导意见',
  url: 'https://example.invalid/agri/rice',
  publisher: '示例出版单位',
  source_kind: 'verified_seed',
  evidence_kind: 'research',
  version: '2026-09',
  content_hash: 'a'.repeat(64),
  locator: 'p.12 §3.2',
  valid_from: '2026-09-01T00:00:00.000Z',
  valid_to: null,
});

const ADMIN_SCOPES = ['sources:read', 'sources:write', 'audit:read'];

async function seedAdmin(authStore) {
  const adminId = await authStore.createAdmin({
    loginName: `gyi18-pg-${Math.random().toString(36).slice(2, 10)}`,
    credentialHash: 'synthetic-not-a-real-credential-hash',
    scopes: ADMIN_SCOPES,
  });
  const token = mintOpaqueToken();
  await authStore.createSession({
    userId: adminId,
    tokenHashHex: hashToken(token),
    authEpoch: 1,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    audience: 'admin',
  });
  return token;
}

// ---------------------------------------------------------------------------
let owner;
let pool;
let app;

try {
  await startCluster();
  const admin = await connectWithRetry(`${adminBase}/postgres`);
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();

  owner = await connectWithRetry(targetUrl);
  note(`PostgreSQL ${(await owner.query('SHOW server_version')).rows[0].server_version}`);

  // ---- [0] 全链迁移（含本片 0036）----
  const discovered = readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  for (const name of discovered) await owner.query(readFileSync(new URL(name, migrationsDir), 'utf8'));
  const presence = (
    await owner.query(
      `SELECT to_regclass('public.admin_content_entities') AS entities,
              to_regclass('public.admin_content_revisions') AS revisions,
              to_regclass('public.admin_content_idempotency') AS idempotency`,
    )
  ).rows[0];
  assert.equal(presence.entities, 'admin_content_entities', '迁移后 public.admin_content_entities 必须存在');
  assert.equal(presence.revisions, 'admin_content_revisions', '迁移后 public.admin_content_revisions 必须存在');
  assert.equal(presence.idempotency, 'admin_content_idempotency', '迁移后 public.admin_content_idempotency 必须存在');
  assert.ok(discovered.includes('0036_r34_admin_content_persistence.sql'), '全链迁移必须包含 0036');
  say(`[0] 全链迁移 ${discovered.length} 个（含 0036_r34_admin_content_persistence.sql）；三张内容表在岗`);

  // ---- [1] 角色与授权：与出厂 provisioning 同形（5 个 NOLOGIN 域组 → 运行时 LOGIN → 内容域授权区域）----
  for (const file of [
    'roles/auth_privacy.sql',
    'roles/catalog_readers.sql',
    'roles/consent_granter.sql',
    'roles/profile_runtime.sql',
    'roles/knowledge_runtime.sql',
  ]) {
    await owner.query(readSql(file));
  }
  const password = randomBytes(24).toString('hex');
  await owner.query(
    `CREATE ROLE ${RUNTIME_ROLE} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
  );
  const runtimeUrl = `postgresql://${RUNTIME_ROLE}:${password}@127.0.0.1:${port}/${DB_NAME}`;
  await owner.query(deployRegion('gy-r34-content-grant'));
  // `/herbicides` 是受控输出面（开关门按库判定）。部署顺序是「migrate ⇒ 20-login-roles.sql」，
  // 运行时角色对 `public.feature_flags` 的 SELECT 由 `gy-i18-flags-grant` 段授予（迁移里授不了：
  // 那时角色还不存在）⇒ 本臂必须照部署口径补这一段，否则开关读不成 ⇒ 公开面一律 503。
  await owner.query(deployRegion('gy-i18-flags-grant'));
  say('[1] 角色/授权：gengyun_api_runtime 已按列拿到内容域 SELECT/INSERT/UPDATE（区域 gy-r34-content-grant）');

  // ---- [2] 授权面读数：列级真、表级禁（负控制，见 [6]）----
  pool = new pg.Pool({ connectionString: runtimeUrl, max: 6 });
  const privilege = (
    await pool.query(
      `SELECT current_user AS role,
              has_column_privilege(current_user, 'public.admin_content_entities', 'published_reason', 'UPDATE') AS upd_granted,
              has_column_privilege(current_user, 'public.admin_content_entities', 'steward_id', 'UPDATE') AS upd_ungranted,
              has_column_privilege(current_user, 'public.admin_content_entities', 'family', 'INSERT') AS ins_granted,
              has_column_privilege(current_user, 'public.admin_content_revisions', 'content', 'SELECT') AS rev_sel,
              has_table_privilege(current_user, 'public.admin_content_entities', 'DELETE') AS tbl_delete,
              has_table_privilege(current_user, 'public.admin_content_entities', 'TRUNCATE') AS tbl_truncate,
              has_table_privilege(current_user, 'public.admin_content_entities', 'REFERENCES') AS tbl_references,
              has_table_privilege(current_user, 'public.admin_content_entities', 'TRIGGER') AS tbl_trigger,
              has_table_privilege(current_user, 'public.admin_content_revisions', 'DELETE') AS rev_delete,
              has_table_privilege(current_user, 'public.admin_content_idempotency', 'DELETE') AS idem_delete`,
    )
  ).rows[0];
  assert.equal(privilege.role, RUNTIME_ROLE, '读写必须跑在运行时角色上（不是库属主）');
  assert.equal(privilege.upd_granted, true, 'published_reason 的 UPDATE 必须已授（发布要写理由）');
  assert.equal(privilege.upd_ungranted, false, 'steward_id 不在 UPDATE 列清单里 ⇒ 未授');
  assert.equal(privilege.ins_granted, true, 'family 的 INSERT 必须已授');
  assert.equal(privilege.rev_sel, true, '版本表 content 的 SELECT 必须已授');
  for (const key of ['tbl_delete', 'tbl_truncate', 'tbl_references', 'tbl_trigger', 'rev_delete', 'idem_delete']) {
    assert.equal(privilege[key], false, `${key} 必须是 false（禁止面：不授 DELETE/TRUNCATE/REFERENCES/TRIGGER）`);
  }
  say('[2] 授权读数：列级 SELECT/INSERT/UPDATE 为真；表级 DELETE/TRUNCATE/REFERENCES/TRIGGER 全为假（三张表）');

  // ---- [3] 组装层：real + 有池 ⇒ 内容域不再 503（产品真实路径）----
  const authStore = createMemoryAuthStore();
  const config = loadConfig({
    APP_EXECUTION_MODE: 'real',
    LOG_LEVEL: 'silent',
    DATABASE_URL: runtimeUrl,
    SESSION_SIGNING_KEY: 'synthetic-not-a-real-signing-key',
    DELETION_LEDGER_KEY: 'synthetic-not-a-real-ledger-key',
    WECHAT_APP_ID: 'synthetic-not-a-real-appid',
    WECHAT_APP_SECRET: 'synthetic-not-a-real-appsecret',
    OBJECT_STORAGE_ENDPOINT: 'https://example.invalid',
    OBJECT_STORAGE_BUCKET: 'synthetic-not-a-real-bucket',
    OBJECT_STORAGE_ACCESS_KEY: 'synthetic-not-a-real-access-key',
    OBJECT_STORAGE_SECRET_KEY: 'synthetic-not-a-real-secret-key',
  });
  app = buildApp({ config, store: authStore, pool });
  assert.equal(app.adminContentService.store.persistent, true, '有池时内容域必须是持久化实现');
  const token = await seedAdmin(authStore);
  const headers = (extra = {}) => ({ authorization: `Bearer ${token}`, ...extra });

  // 建草稿：201
  const created = await app.inject({
    method: 'POST',
    url: `${API}/admin/sources`,
    headers: headers({ 'content-type': 'application/json', 'idempotency-key': 'gy-i18-pg-source-0001' }),
    payload: SOURCE_INPUT(),
  });
  assert.equal(created.statusCode, 201, `建草稿必须 201（不再是 503）⇒ ${created.body}`);
  const draft = created.json().data;
  const entityId = draft.id;
  assert.match(entityId, /^[0-9a-f-]{36}$/, '实体 id 必须是 uuid');
  const etag = created.headers.etag ?? created.headers.ETag;
  assert.ok(typeof etag === 'string' && etag.length > 0, '建草稿必须返回 ETag');

  // 幂等重放：同一个 key ⇒ 同响应、库里仍 1 条台账
  const replay = await app.inject({
    method: 'POST',
    url: `${API}/admin/sources`,
    headers: headers({ 'content-type': 'application/json', 'idempotency-key': 'gy-i18-pg-source-0001' }),
    payload: SOURCE_INPUT(),
  });
  assert.equal(replay.statusCode, created.statusCode, '幂等重放的状态码必须一致');
  assert.deepEqual(replay.json().data, draft, '幂等重放必须逐字返回首次响应');
  const ledgerRows = Number(
    (await owner.query('SELECT count(*)::int AS v FROM public.admin_content_idempotency')).rows[0].v,
  );
  assert.equal(ledgerRows, 1, `同一 idempotency-key 只允许一条台账行，实际 ${ledgerRows}`);
  say('[3] 建草稿 201 + 幂等重放逐字一致（PG 台账 1 行，不是内存 Map）');

  // 列表 / 读 / 改
  const list1 = await app.inject({ method: 'GET', url: `${API}/admin/sources`, headers: headers() });
  assert.equal(list1.statusCode, 200, list1.body);
  assert.equal(list1.json().data.items.length, 1, '列表必须看见刚建的草稿');

  const read = await app.inject({ method: 'GET', url: `${API}/admin/sources/${entityId}`, headers: headers() });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().data.id, entityId);

  const edited = await app.inject({
    method: 'PATCH',
    url: `${API}/admin/sources/${entityId}`,
    headers: headers({ 'content-type': 'application/json', 'if-match': etag, 'idempotency-key': 'gy-i18-pg-source-0002' }),
    payload: { ...SOURCE_INPUT(), title: '浙江省水稻田稗草防治技术指导意见（修订）' },
  });
  assert.equal(edited.statusCode, 200, `改草稿必须 200 ⇒ ${edited.body}`);
  const editEtag = edited.headers.etag ?? edited.headers.ETag;
  assert.equal(edited.json().data.revision, 2, '改草稿后 revision 必须是 2');
  say('[4] 列表 200 / 读 200 / 改 200（revision 1 → 2，ETag 与 If-Match 守卫生效）');

  // 发布 → 撤回
  const published = await app.inject({
    method: 'POST',
    url: `${API}/admin/sources/${entityId}/publish`,
    headers: headers({ 'content-type': 'application/json', 'if-match': editEtag, 'idempotency-key': 'gy-i18-pg-source-0003' }),
    payload: { evidence_ref: 'EVID-2026-09-001', reason: '核验通过' },
  });
  assert.equal(published.statusCode, 200, `发布必须 200 ⇒ ${published.body}`);
  // 出参是契约的单修订投影（families.ts 的 projectRevisionData）：生命周期投影成 visibility/validity。
  assert.equal(published.json().data.visibility, 'published', '发布后 visibility 必须是 published');
  assert.equal(published.json().data.source.validity, 'valid', '发布后 sources 的 validity 必须是 valid');
  assert.equal(published.json().data.source.review_status, 'verified', '发布后 review_status 必须是 verified');
  const publishedEtag = published.headers.etag ?? published.headers.ETag;

  const withdrawn = await app.inject({
    method: 'POST',
    url: `${API}/admin/sources/${entityId}/withdraw`,
    headers: headers({ 'content-type': 'application/json', 'if-match': publishedEtag, 'idempotency-key': 'gy-i18-pg-source-0004' }),
    payload: { reason: '来源更新，撤回' },
  });
  assert.equal(withdrawn.statusCode, 200, `撤回必须 200 ⇒ ${withdrawn.body}`);
  assert.equal(withdrawn.json().data.visibility, 'hidden', '撤回后 visibility 必须是 hidden');
  assert.equal(withdrawn.json().data.source.validity, 'withdrawn', '撤回后 sources 的 validity 必须是 withdrawn');
  say('[5] 发布 200（published）→ 撤回 200（withdrawn）—— 状态位真的写进了 PG');

  // ---- [4] 库里的真值（用库属主视角读，不混授权）----
  const entity = (
    await owner.query(
      `SELECT family, steward_id, lifecycle, published_revision, published_reason, withdrawn_reason
         FROM public.admin_content_entities WHERE id = $1::uuid`,
      [entityId],
    )
  ).rows[0];
  assert.equal(entity.family, 'sources');
  assert.equal(entity.lifecycle, 'withdrawn', '库里 lifecycle 必须是 withdrawn');
  assert.equal(entity.published_revision, 2, '发布的必须是 revision 2');
  assert.equal(entity.published_reason, '核验通过');
  assert.equal(entity.withdrawn_reason, '来源更新，撤回');
  const revisionRows = (
    await owner.query(
      'SELECT revision, author_id FROM public.admin_content_revisions WHERE entity_id = $1::uuid ORDER BY revision',
      [entityId],
    )
  ).rows;
  assert.ok(revisionRows.length >= 2, `版本行必须 ≥2，实际 ${revisionRows.length}`);
  assert.deepEqual(revisionRows.map((row) => row.revision), [1, 2], '版本号必须是 1 → 2 且逐 revision 不可变');
  say(`[6] 库内真值：实体 1 行（lifecycle=${entity.lifecycle}，published_revision=${entity.published_revision}）、版本 ${revisionRows.length} 行、台账 ${ledgerRows} 行`);

  // ---- [5] 归属隔离：另一个 steward 看不见本实体 ----
  const otherStore = createMemoryAuthStore();
  const otherToken = await seedAdmin(otherStore);
  const otherApp = buildApp({ config, store: otherStore, pool });
  try {
    const otherList = await otherApp.inject({
      method: 'GET',
      url: `${API}/admin/sources`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    assert.equal(otherList.statusCode, 200, otherList.body);
    assert.deepEqual(otherList.json().data.items, [], '另一个 steward 的列表必须看不见本实体（steward_id 过滤在 SQL 里）');
    const otherRead = await otherApp.inject({
      method: 'GET',
      url: `${API}/admin/sources/${entityId}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    assert.equal(otherRead.statusCode, 404, `他人实体必须 404（不泄露存在性）⇒ ${otherRead.body}`);
  } finally {
    await otherApp.close();
  }
  say('[7] 归属隔离：他人列表为空、他人按 id 读 404（steward_id 过滤在 SQL 谓词里）');

  // ---- [6] 授权面负控制：运行时角色直接 DDL/DML 必须 42501 ----
  const runtime = new pg.Client({ connectionString: runtimeUrl });
  await runtime.connect();
  try {
    assert.equal(await expectDenied(runtime, 'DELETE FROM public.admin_content_entities', '运行时 DELETE 实体行'), '42501');
    assert.equal(await expectDenied(runtime, 'TRUNCATE public.admin_content_entities', '运行时 TRUNCATE 实体表'), '42501');
    assert.equal(
      await expectDenied(runtime, `UPDATE public.admin_content_entities SET steward_id = 'x'`, '运行时改未授权列 steward_id'),
      '42501',
    );
    assert.equal(
      await expectDenied(runtime, 'DELETE FROM public.admin_content_idempotency', '运行时 DELETE 幂等台账'),
      '42501',
    );
    // 对照：改**已授权**列必须成功（否则上面四条 42501 可能只是"整表都改不动"）
    const allowed = await runtime.query(
      `UPDATE public.admin_content_entities SET withdrawn_reason = withdrawn_reason
        WHERE id = $1::uuid RETURNING id`,
      [entityId],
    );
    assert.equal(allowed.rows.length, 1, '已授权列的 UPDATE 必须成功（对照臂）');
  } finally {
    await runtime.end();
  }
  say('[8] 负控制：运行时 DELETE/TRUNCATE/改未授权列一律 42501；改已授权列成功（说明授权是列级精确的）');

  // ---- [9] 公开读可见性（端到端：HTTP 公开面 × 真实 PG × 真实解析器）----
  // 复审第 4 项：0036 **已就绪**（onReady 探测到 ready）+ 来源**已撤回** ⇒ 公开读必须**不可见**。
  // 这里不用桩：拿公开面种子里**真实存在**的 `source_id`，在 0036 里以同一 id 建 source 实体并置
  // withdrawn ⇒ `createAdminContentReferenceResolver` 会真的去 PG 问这一条 ⇒ unavailable ⇒ 隐藏。
  const { createPostgresAdminContentStore } = await import('../../services/api/src/admin/ops/content-pg.ts');
  const reader = await authStore.createUser('gy-i18-pg-public-reader');
  const readerId = reader.id;
  const readerToken = mintOpaqueToken();
  await authStore.createSession({
    userId: readerId,
    tokenHashHex: hashToken(readerToken),
    authEpoch: 1,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    audience: 'user',
  });
  // `real` ＋有池时，用户状态／纪元以 **PG 为准**（会话守卫查 `SELECT state, auth_epoch FROM public.users`）
  // ⇒ 光在内存 store 里造会话不够，必须落一行真账号，否则公开面一律 401 SESSION_EXPIRED。
  await owner.query('INSERT INTO public.users (id, state, auth_epoch) VALUES ($1::uuid, $2, $3)', [
    readerId,
    'active',
    1,
  ]);
  // 迁移 0020 默认三键全关（裁定 §1）⇒ `/herbicides` 会先被开关门判 409。本组测的是**可见性**，
  // 所以先按管理员口径把 `specific_herbicide_output_enabled` 打开（revision 同步 +1，符合 CAS 语义）；
  // 表级写权限只有库属主有，运行时角色仍是只读（见 [1]/[2]）。
  await owner.query(
    `UPDATE public.feature_flags SET enabled = true, revision = revision + 1
      WHERE key = 'specific_herbicide_output_enabled'`,
  );
  const publicItems = async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${API}/herbicides`,
      headers: { authorization: `Bearer ${readerToken}` },
    });
    assert.equal(
      res.statusCode,
      200,
      `0036 已就绪且解析器真实接线 ⇒ 公开读必须 200（不得 503/409），实际 ${res.statusCode} ⇒ ${res.body}`,
    );
    return res.json().data.items;
  };

  const beforeItems = await publicItems();
  assert.ok(beforeItems.length >= 1, '前置：公开面种子里必须有可见行，否则本组测不到解析器');
  const target = beforeItems.find((item) => {
    const source = item?.source;
    return (
      typeof source?.id === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(source.id)
      && typeof source.version === 'string'
      && source.version !== ''
    );
  });
  assert.ok(target !== undefined, '前置：必须有一条带 uuid `source.id` + 非空 `source.version` 的种子行（判定输入来自响应投影）');
  const withdrawnSourceId = target.source.id;
  const targetId = String(target.id);
  assert.ok(targetId !== '', '前置：目标行必须有自己的 `id`，供前后逐条比对');

  const contentStore = createPostgresAdminContentStore({ pool });
  const stewardId = await authStore.createAdmin({
    loginName: `gyi18-pg-steward-${randomBytes(3).toString('hex')}`,
    credentialHash: 'synthetic-not-a-real-credential-hash',
    scopes: ADMIN_SCOPES,
  });
  const source = await contentStore.createEntity({
    id: withdrawnSourceId,
    family: 'sources',
    stewardId,
    createdAt: new Date(),
  });
  // 0036 的 `admin_content_entities_withdrawn_group` CHECK：`lifecycle='withdrawn'` 必须同时有
  // `withdrawn_at` 与 `withdrawn_by_id` ⇒ 按服务层同样姿势先补齐撤回字段组再落库（否则 23514）。
  await contentStore.setLifecycle(
    {
      ...source,
      lifecycle: 'withdrawn',
      withdrawnAt: new Date(),
      withdrawnById: stewardId,
      withdrawnReason: 'synthetic integration：来源撤回后公开读必须不可见',
    },
    'withdrawn',
  );
  const lifecycleRow = (
    await owner.query('SELECT family, lifecycle FROM public.admin_content_entities WHERE id = $1::uuid', [
      withdrawnSourceId,
    ])
  ).rows[0];
  assert.equal(lifecycleRow.family, 'sources');
  assert.equal(lifecycleRow.lifecycle, 'withdrawn', '前置：库里 lifecycle 必须是 withdrawn（不是 draft）');

  // 判定是**逐条**的：先数清"受影响来源"到底覆盖了几条，再逐条判掉 ⇒ 不预设"只隐藏一条"。
  const affectedCount = beforeItems.filter((item) => item?.source?.id === withdrawnSourceId).length;
  assert.ok(affectedCount >= 1, '前置：至少要有一条行挂在这个来源上');
  const afterItems = await publicItems();
  assert.equal(
    afterItems.some((item) => String(item.id) === targetId),
    false,
    '来源已撤回 ⇒ 该条公开读必须被隐藏（hidden 不许因接线而变可见）',
  );
  assert.equal(
    afterItems.filter((item) => item?.source?.id === withdrawnSourceId).length,
    0,
    '同一来源的行必须逐条判掉，不得只看首条就放行整页',
  );
  assert.equal(
    afterItems.length,
    beforeItems.length - affectedCount,
    `只隐藏该来源的 ${affectedCount} 条，其余照旧（判定逐条，不整页吞）`,
  );
  say('[9] 公开读可见性：0036 就绪 + 来源已撤回 ⇒ /herbicides 隐藏该条（200，不是 503；其余不变）');

  // ---- [10] 回滚脚本：在独立库里跑 rollback/0036_*.down.sql，三张表必须消失 ----
  const downSql = readFileSync(new URL('rollback/0036_r34_admin_content_persistence.down.sql', migrationsDir), 'utf8');
  await owner.query(downSql);
  const gone = (
    await owner.query(
      `SELECT to_regclass('public.admin_content_entities') AS entities,
              to_regclass('public.admin_content_revisions') AS revisions,
              to_regclass('public.admin_content_idempotency') AS idempotency`,
    )
  ).rows[0];
  assert.deepEqual(
    [gone.entities, gone.revisions, gone.idempotency],
    [null, null, null],
    '回滚后三张表必须全部消失（down 脚本与 up 成对）',
  );
  say('[10] 回滚：rollback/0036_r34_admin_content_persistence.down.sql 把三张表删净（to_regclass 全为 NULL）');

  // 组数钉住：以后谁删掉一组证据（或把它降级成 note），这里立刻红 —— 不允许「悄悄少一组还报 ALL PASS」。
  assert.equal(passed, 11, `通过组数必须正好 11 组（[0]…[10]），实际 ${passed}`);
  console.log(`\nALL PASS：${passed} 组（内容域 PG 落点 · 真实 PostgreSQL 17）`);
} finally {
  if (app !== undefined) await app.close().catch(() => {});
  if (owner !== undefined) await owner.end().catch(() => {});
  if (pool !== undefined) await pool.end().catch(() => {});
  stopCluster();
}
