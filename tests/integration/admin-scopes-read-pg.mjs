/**
 * `#18` S2 PR-2 · 真库臂：后台**只读展示他人权限**（`GET /admin/administrators`、
 * `GET /admin/administrators/{id}/scopes`）。
 *
 * 为什么要有这一臂
 * ----------------
 * 单测（`tests/unit/admin-scopes-read.test.mjs`）用内存假实现，证明不了三件只有真 PG 才回答的事：
 *   1. **列授权面**：运行时角色对 `public.admin_scopes` 到底能不能读 `granted_by` / `granted_at`
 *      —— 契约里没有这两个字段不是"暂时没做"，而是运行时**根本读不到**（42501）；
 *   2. **库层闭集**：迁移 0041 的 `admin_scopes_scope_closed_set` 与 `src/admin/scopes.ts` 的
 *      `ADMIN_SCOPES` 是否逐项同源（应用层出口守卫与库层 CHECK 不能各说一套）；
 *   3. **两个 id 空间**：`/admin/administrators` 的 `id` 来自 `public.admin_accounts`，
 *      与 `public.users.id`（`/admin/accounts` 的形状）没有任何映射 —— 拿用户 id 必须 404。
 *
 * 本臂自己起**一次性集群**（`initdb` 新目录），不依赖本机既有实例；端口在 55468–55499 里
 * 探活后取空闲者（55432–55467 留给已存在的兄弟集群），收尾 `pg_ctl stop` + 删目录。
 *
 * 怎么跑
 * ------
 *   $env:GY_PG_BIN = 'E:\GengYunCommander\.pg17\pgsql\bin'   # 含 initdb/pg_ctl 的目录（PG 17.11）
 *   $env:GY_R37_PG_ROOT = 'E:\GengYunCommander\.pg17\tmp'    # 可选：数据目录的父目录
 *   node tests/integration/admin-scopes-read-pg.mjs
 *
 * 没设 `GY_PG_BIN` 时**明确 SKIP**：打印原因并以 **77 退出**（未取得，不是通过）——
 * 与 `admin-audit-logs-pg` / `admin-accounts-read-pg` 等自起集群脚本同一口径。
 * 本机沙箱禁回环监听时同样会在这里如实失败（不是通过）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { loadConfig } from '../../services/api/src/config.ts';
import { buildApp } from '../../services/api/src/app.ts';
import { createPool } from '../../services/api/src/db/pool.ts';
import { createPostgresAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { ADMIN_SCOPES } from '../../services/api/src/admin/scopes.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const binDir = (process.env.GY_PG_BIN ?? '').trim();
const DB_NAME = 'gengyun_r37_scope_read_test';
const RUNTIME_ROLE = 'gengyun_api_runtime';
const RUNTIME_PASSWORD = 'r37scoperead';
const API = '/api/v1';
const MIGRATION = '0041_admin_scope_write_authority.sql';
const CONSTRAINT = 'admin_scopes_scope_closed_set';
const TOOL = name => join(binDir, process.platform === 'win32' ? `${name}.exe` : name);
const note = line => console.log(`  · ${line}`);
const pass = line => console.log(`  ✓ ${line}`);

if (binDir === '' || !existsSync(TOOL('initdb'))) {
  console.log(
    'SKIP: 未设置 GY_PG_BIN（含 initdb/pg_ctl 的目录）⇒ 真库臂跳过，'
      + '没有验证运行时列授权面与库层闭集（未取得，不是通过）。',
  );
  console.log('SKIP: 本臂只认 GY_PG_BIN 指向的 PG 17 二进制（initdb/pg_ctl），找不到就整链未取得。');
  console.log('SKIP: 退出码 77 ＝ 未取得（⛔ 不是通过）；调用方必须把它显式判红，另见 tests/unit/integration-script-coverage.test.mjs。');
  // 77 ＝ 未取得（POSIX skipped），⛔ 不是 0：整链跳过不许被读成通过。
  process.exit(77);
}

const rootDir = (process.env.GY_R37_PG_ROOT ?? tmpdir()).trim();
const dataDir = join(rootDir, `gy-r37-scope-read-pg-${randomUUID().slice(0, 8)}`);
const toolLog = join(rootDir, 'gy-r37-scope-read-pg-tools.log');
mkdirSync(rootDir, { recursive: true });
const logFd = openSync(toolLog, 'a');

const readSql = rel => readFileSync(join(ROOT, `services/api/db/${rel}`), 'utf8');
const migrationsDir = join(ROOT, 'services/api/db/migrations');

function runTool(name, args, options = {}) {
  return spawnSync(TOOL(name), args, {
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, PGCONNECT_TIMEOUT: '5' },
    timeout: options.timeout ?? 180_000,
    windowsHide: true,
    cwd: ROOT,
  });
}

function tail(file, lines = 12) {
  try {
    return readFileSync(file, 'utf8').replace(/\s+$/, '').split('\n').slice(-lines).join('\n');
  } catch (error) {
    return `（读不到 ${file}：${error.message}）`;
  }
}

/** Windows 上「能连上 ⇒ 有人在听」才是可靠的空闲判据（不能靠 listen 成功与否）。 */
function portBusy(candidate) {
  return new Promise(resolve => {
    const socket = new Socket();
    let settled = false;
    const done = busy => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(400, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.connect(candidate, '127.0.0.1');
  });
}

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

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

let owner = null;
let ownerPool = null;
let port = null;
const started = { cluster: false };

async function startCluster() {
  const init = runTool('initdb', ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--locale=C']);
  assert.equal(init.status, 0, `initdb 失败：${tail(toolLog)}`);
  for (let candidate = 55468; candidate <= 55499; candidate += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await portBusy(candidate))) {
      port = candidate;
      break;
    }
  }
  assert.ok(port !== null, '55468–55499 内没有空闲端口（兄弟集群占满了？）');
  // POSIX 专有坑（R67-C 把它接进 CI 后第一次真跑才暴露）：Debian/Ubuntu 的 PGDG 包把
  // `unix_socket_directories` 的编译默认钉在 `/var/run/postgresql`，GitHub runner 的普通用户
  // 写不了 ⇒ 连 `.s.PGSQL.<port>.lock` 都建不出来，`pg_ctl start` 直接 `could not start server`。
  // Windows 不用 unix socket，故本臂此前只在 Windows 跑过、从未暴露。显式把 socket 目录指到本臂
  // 自己的数据目录（Unix 域 socket 随目录一起删），两个平台走同一条码。
  const socketOption = process.platform === 'win32' ? '' : ` -k ${dataDir}`;
  const up = runTool('pg_ctl', ['-D', dataDir, '-l', join(dataDir, 'server.log'), '-o', `-p ${port} -h 127.0.0.1${socketOption}`, '-w', 'start']);
  assert.equal(up.status, 0, `pg_ctl start 失败（沙箱禁回环监听时会走到这里）：${tail(toolLog)}`);
  started.cluster = true;
  const created = runTool('createdb', ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', DB_NAME]);
  assert.equal(created.status, 0, `createdb 失败：${tail(toolLog)}`);
  owner = await connectWithRetry(`postgres://postgres@127.0.0.1:${port}/${DB_NAME}`);
  ownerPool = new pg.Pool({ connectionString: `postgres://postgres@127.0.0.1:${port}/${DB_NAME}` });
  note(`集群就位：port=${port}，db=${DB_NAME}，data=${dataDir}`);
}

const q = async (text, params = []) => (await owner.query(text, params)).rows;
const one = async (text, params = []) => (await q(text, params))[0];

// ---------------------------------------------------------------------------
// [M] 迁移全链 + 库层闭集
// ---------------------------------------------------------------------------
async function migrationsAndClosedSet() {
  const discovered = readdirSync(migrationsDir).filter(name => /^\d{4,}_[a-z0-9_]+\.sql$/.test(name)).sort();
  const versions = discovered.map(name => name.slice(0, 4));
  assert.equal(new Set(versions).size, versions.length, `迁移版本号重复：${versions.join(',')}`);
  assert.ok(discovered.includes(MIGRATION), `迁移清单必须含 ${MIGRATION}`);
  for (const name of discovered) {
    // 每一片都应用；本臂不假设顺序以外的东西（迁移器另有单测）。
    // eslint-disable-next-line no-await-in-loop
    await owner.query(readSql(`migrations/${name}`));
  }
  note(`[M] 全链应用 ${discovered.length} 个迁移（含 ${MIGRATION}，现场最大号 ${versions.at(-1)}）`);

  // 约束存在且逐项等于应用层 `ADMIN_SCOPES`（13 项）：两侧漂移即红。
  const def = await one(
    `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint AS c
      WHERE c.conname = $1 AND c.conrelid = 'public.admin_scopes'::regclass`,
    [CONSTRAINT],
  );
  assert.ok(def !== undefined, `admin_scopes 上必须有约束 ${CONSTRAINT}`);
  const inDb = [...def.def.matchAll(/'([a-z]+:[a-z]+)'/g)].map(match => match[1]);
  assert.deepEqual([...inDb].sort(), [...ADMIN_SCOPES].sort(), `库层 CHECK 必须与应用层闭集逐项同源（库层：${inDb.join(',')}）`);
  note(`[M] ${CONSTRAINT} = ${inDb.length} 项，与应用层 ADMIN_SCOPES 逐项相等`);

  // 闭集外取值写不进来（属主直写也拦）⇒ 23514。
  const adminId = randomUUID();
  await owner.query(
    "INSERT INTO public.admin_accounts (id, login_name, credential_hash) VALUES ($1, 'closed-set-probe', 'x')",
    [adminId],
  );
  let code = null;
  try {
    await owner.query("INSERT INTO public.admin_scopes (admin_id, scope) VALUES ($1, 'scopes:grant')", [adminId]);
  } catch (error) {
    code = error.code;
  }
  assert.equal(code, '23514', `闭集外 scope 必须以 23514 拒绝，实际 ${String(code)}`);
  await owner.query('DELETE FROM public.admin_accounts WHERE id = $1', [adminId]);
  note('[M] 闭集外 scope（scopes:grant）⇒ 23514（属主直写同样被拦）');
}

// ---------------------------------------------------------------------------
// [P] 最小权限反向控制：读得到什么、读不到什么
// ---------------------------------------------------------------------------
async function provisionRoles() {
  for (const name of ['gengyun_auth_privacy']) {
    await owner.query(`DROP ROLE IF EXISTS ${name}`).catch(() => {});
  }
  await owner.query(`DROP ROLE IF EXISTS ${RUNTIME_ROLE}`).catch(() => {});
  await owner.query(readSql('roles/auth_privacy.sql'));
  await owner.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${RUNTIME_PASSWORD}'`);
  await owner.query(`GRANT gengyun_auth_privacy TO ${RUNTIME_ROLE}`);
  note('[P] 已执行出厂 roles/auth_privacy.sql，并把组角色授给运行时登录角色（未新增任何授权）');
}

async function leastPrivilege() {
  const runtime = new pg.Client({
    connectionString: `postgres://${RUNTIME_ROLE}:${RUNTIME_PASSWORD}@127.0.0.1:${port}/${DB_NAME}`,
  });
  await runtime.connect();
  try {
    // ① 读面需要的两列可读。
    await runtime.query('SELECT scope FROM public.admin_scopes');
    await runtime.query('SELECT id, login_name, state, auth_epoch, revision FROM public.admin_accounts');
    note('[P] 运行时：admin_scopes.scope 与 admin_accounts 五列可读（读面只依赖这些）');

    // ② `granted_by` / `granted_at` 一律 42501 —— 这就是契约里没有它们的**物理原因**。
    for (const column of ['granted_by', 'granted_at']) {
      let code = null;
      try {
        await runtime.query(`SELECT ${column} FROM public.admin_scopes`);
      } catch (error) {
        code = error.code ?? null;
      }
      assert.equal(code, '42501', `${column} 直读必须以 42501 拒绝，实际 ${String(code)}`);
    }
    const colGrantedBy = await one("SELECT has_column_privilege($1, 'public.admin_scopes', 'granted_by', 'SELECT') AS v", [RUNTIME_ROLE]);
    const colGrantedAt = await one("SELECT has_column_privilege($1, 'public.admin_scopes', 'granted_at', 'SELECT') AS v", [RUNTIME_ROLE]);
    assert.equal(colGrantedBy.v, false, '运行时不得有 admin_scopes.granted_by 列级 SELECT');
    assert.equal(colGrantedAt.v, false, '运行时不得有 admin_scopes.granted_at 列级 SELECT');
    note(`[P] granted_by / granted_at 直读 ⇒ 42501（列级 SELECT：${colGrantedBy.v} / ${colGrantedAt.v}）`);

    // ③ 写面（授予/撤销）在库层只能走 0041 的 SECURITY DEFINER 函数 ⇒ 表级写权必须为 false。
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
      // eslint-disable-next-line no-await-in-loop
      const row = await one("SELECT has_table_privilege($1, 'public.admin_scopes', $2) AS v", [RUNTIME_ROLE, privilege]);
      assert.equal(row.v, false, `运行时不得有 admin_scopes 的 ${privilege} 表级权限`);
    }
    note('[P] 运行时对 admin_scopes 的 INSERT/UPDATE/DELETE 表级权限全为 false（写面只能走 0041 的函数）');
    pass('[P] 最小权限读数全部符合预期');
  } finally {
    await runtime.end();
  }
}

// ---------------------------------------------------------------------------
// [H] HTTP 手臂（真实模式装配：`app.ts` 的 real 分支自己接认证存储）
// ---------------------------------------------------------------------------
const wechatPort = { exchange: async () => ({ subjectLookupHex: randomBytes(32).toString('hex') }) };

async function launchApp(pool) {
  // 被测对象是 `app.ts` 的 real 分支装配（executionMode + pool ⇒ 自己建目录与外壳）。
  const config = { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), executionMode: 'real' };
  const app = buildApp({ config, pool, wechat: wechatPort, now: () => new Date() });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const call = async (path, { method = 'GET', token, body } = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
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
    return { status: response.status, body: parsed, text, headers: response.headers };
  };
  return { app, origin, call };
}

let seedStore = null;

async function seedAdmin(scopes, { state = 'active' } = {}) {
  const adminId = await seedStore.createAdmin({
    loginName: `gy-r37-read-${randomUUID().slice(0, 8)}`,
    credentialHash: 'synthetic-not-a-real-credential-hash',
    scopes,
  });
  if (state !== 'active') {
    await owner.query('UPDATE public.admin_accounts SET state = $2::public.admin_state WHERE id = $1', [adminId, state]);
  }
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
  const runtimePool = createPool(`postgres://${RUNTIME_ROLE}:${RUNTIME_PASSWORD}@127.0.0.1:${port}/${DB_NAME}`);
  assert.ok(runtimePool !== null, '运行时 pool 必须建出来');
  const { app, call } = await launchApp(runtimePool);
  const apps = [app];
  try {
    // 夹具：一个持 scopes:read 的读者、一个只有 accounts:read 的、一个 suspended 的、一个普通用户。
    const reader = await seedAdmin(['scopes:read', 'accounts:read']);
    const accountsOnly = await seedAdmin(['accounts:read']);
    const suspended = await seedAdmin(['scopes:read'], { state: 'suspended' });
    const user = await seedStore.createUser(randomBytes(32).toString('hex'));

    // ① 目录：id 必须逐字来自 admin_accounts（含 suspended 行，不按 state 过滤）。
    const list = await call(`${API}/admin/administrators`, { token: reader.token });
    assert.equal(list.status, 200, `目录必须 200，实际 ${list.status} ${list.text.slice(0, 300)}`);
    const items = list.body.data.items;
    const ids = items.map(item => item.id);
    for (const expected of [reader.adminId, accountsOnly.adminId, suspended.adminId]) {
      assert.ok(ids.includes(expected), `目录必须包含 ${expected}（现场：${ids.join(',')}）`);
    }
    assert.equal(ids.includes(user.id), false, '目录不得包含 users.id（两个 id 空间无映射）');
    for (const item of items) {
      assert.deepEqual(Object.keys(item).sort(), ['id', 'login_name', 'scopes', 'state'], `字段集合必须恰好四列（现场：${Object.keys(item).join(',')}）`);
      assert.ok(Array.isArray(item.scopes), 'scopes 必须是数组');
    }
    note(`[H] GET ${API}/admin/administrators ⇒ 200，items=${items.length}，id 全部来自 admin_accounts`);

    // ② 单条：只返 scope 字符串数组，⛔ 无 granted_by/granted_at/login_name，且不发 ETag。
    const scopes = await call(`${API}/admin/administrators/${reader.adminId}/scopes`, { token: reader.token });
    assert.equal(scopes.status, 200, `权限读面必须 200，实际 ${scopes.status} ${scopes.text.slice(0, 300)}`);
    assert.deepEqual(Object.keys(scopes.body.data), ['scopes'], 'data 只允许一个键：scopes');
    assert.deepEqual(scopes.body.data.scopes, ['accounts:read', 'scopes:read'], '去重 + 码元序');
    assert.equal(scopes.headers.get('etag'), null, '权限读面不得发 ETag');
    const lowered = scopes.text.toLowerCase();
    for (const forbidden of ['granted_by', 'granted_at', 'login_name', 'revoked_at', 'auth_epoch']) {
      assert.equal(lowered.includes(forbidden), false, `响应正文不得含 ${forbidden}（正文：${scopes.text.slice(0, 400)}）`);
    }
    note(`[H] GET ${API}/admin/administrators/{id}/scopes ⇒ 200，scopes=${JSON.stringify(scopes.body.data.scopes)}，无 granted_by/granted_at/ETag`);

    // ③ 负控制：只有 accounts:read ⇒ 403 SCOPE_DENIED（裁定④：两种能力）。
    for (const path of [`${API}/admin/administrators`, `${API}/admin/administrators/${reader.adminId}/scopes`]) {
      // eslint-disable-next-line no-await-in-loop
      const denied = await call(path, { token: accountsOnly.token });
      assert.equal(denied.status, 403, `${path} 缺 scopes:read 必须 403，实际 ${denied.status} ${denied.text.slice(0, 200)}`);
      assert.equal(denied.body.error.code, 'SCOPE_DENIED', `错误码必须 SCOPE_DENIED，实际 ${denied.body.error.code}`);
    }
    note('[H] 负控制：只有 accounts:read 的管理员 ⇒ 两条读面均 403 SCOPE_DENIED');

    // ④ 负控制：users.id 与随机 uuid ⇒ 404 NOT_FOUND（不是空数组）。
    for (const id of [user.id, randomUUID()]) {
      // eslint-disable-next-line no-await-in-loop
      const missing = await call(`${API}/admin/administrators/${id}/scopes`, { token: reader.token });
      assert.equal(missing.status, 404, `${id} 必须 404，实际 ${missing.status}`);
      assert.equal(missing.body.error.code, 'NOT_FOUND');
      assert.equal(missing.body.data, undefined, '404 不得带 data（不许用空数组冒充"没有权限"）');
    }
    note('[H] 负控制：users.id 与随机 uuid ⇒ 404 NOT_FOUND（⛔ 空数组）');

    // ⑤ 负控制：无令牌 ⇒ 401。
    const anonymous = await call(`${API}/admin/administrators`);
    assert.equal(anonymous.status, 401, `无令牌必须 401，实际 ${anonymous.status}`);
    note(`[H] 负控制：无令牌 ⇒ ${anonymous.status}`);
    pass('[H] 真实模式 HTTP 读数全部符合预期');
  } finally {
    for (const app of apps) await app.close().catch(() => {});
    await runtimePool.end().catch(() => {});
  }
}

try {
  await startCluster();
  seedStore = createPostgresAuthStore({ query: (text, params) => ownerPool.query(text, params) });
  await migrationsAndClosedSet();
  await provisionRoles();
  await leastPrivilege();
  await httpEvidence();
  note('[S] 90-assert-least-privilege.sql 含 psql 元命令（\\echo/\\if）⇒ 由 `psql -f` 单独执行并回读 verdict（不在本脚本内代跑）');
  pass('结论：库层闭集 + 运行时列授权面 + 真实模式 HTTP（目录/单条/三条负控制）全部通过');
} catch (error) {
  console.error(`FAIL: ${error?.message ?? error}`);
  if (started.cluster) console.error(`    （集群日志尾部：${tail(join(dataDir, 'server.log'))}）`);
  process.exitCode = 1;
} finally {
  await ownerPool?.end().catch(() => {});
  await owner?.end().catch(() => {});
  if (started.cluster) {
    runTool('pg_ctl', ['-D', dataDir, '-m', 'immediate', 'stop']);
    rmSync(dataDir, { recursive: true, force: true });
  }
  closeSync(logFd);
}
