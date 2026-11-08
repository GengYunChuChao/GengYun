/**
 * 真库臂：注销去身份（GY-I19 / `#19` 片1 / 迁移 `0057_deidentify_account_on_deletion.sql`）。
 *
 * 被测对象是**库层**的 `public.deidentify_account(p_user_id uuid)` 与把它接进受理事务的
 * `services/api/src/privacy/deletion-requests-pg.ts`。本臂只认真库（`GY_PG_BIN` 指向 PG 17 的
 * `initdb`/`pg_ctl`/`createdb`），拿不到就整链 `SKIP` + 退出码 77（＝未取得，⛔ 不是通过）。
 *
 * 十一条断言（编号与设计页 A1–A11 一一对应）：
 *   A1 正常擦除的读数：`identity=1`、`exports=1`、`generation=1`（0 → 1）
 *   A2 四列 PII 全为 NULL，且 `state`/`auth_epoch`/`revision` 一字未动
 *   A3 幂等：第二次调用 `identity=0`、`exports=0`，且 `generation` 不再自增
 *   A4 `state='active'` ⇒ `G0015`，且一个字节都没写（fail-closed）
 *   A5 不存在的 uuid ⇒ `G0002`
 *   A6 `exports` 行仍在、逐列不变，**只有** `provider_request_ref_cipher` 变 NULL（`updated_at` 前移）
 *   A7 `export_writebacks` 一字不变（该表没有 PII 列，⛔ 不在本片擦除面）
 *   A8 `SET ROLE gengyun_api_runtime`：可 EXECUTE，直改/直读 `users.nickname` 各 42501
 *   A9 走真实 `createRequest()`：`deidentified.identity=1`，且 `state`/`auth_epoch`/会话/`deletion_requests` 全部正确
 *   A10 收回 EXECUTE 后 `createRequest()` 抛 `PROVIDER_UNAVAILABLE(retryable:false)`，
 *       且 `users` 仍 `active`、`deletion_requests` 零行（整笔回滚）
 *   A11 擦除后后台读面的 `display_name` 回落到 `耕云用户XXXX`（`md5(id)` 前 4 位大写）
 *
 * 端口纪律：⛔ 不用 `554xx` 段（落在 Linux ephemeral 区间会被出站源端口占住），
 * 一律 `pickFreePort()` 现分配 + `portBusy()` 探活，最多试 `MAX_PORT_ATTEMPTS` 次；
 * POSIX 追加 `-k <dataDir>`（PGDG 包的默认 socket 目录普通用户写不了）。
 * 收尾无论成败都 `pg_ctl stop -m immediate` 并删临时数据目录。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { createPool } from '../../services/api/src/db/pool.ts';
import { createPostgresDeletionRequestStore } from '../../services/api/src/privacy/deletion-requests-pg.ts';
import { pickFreePort } from './lib/free-port.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const binDir = (process.env.GY_PG_BIN ?? '').trim();
const DB_NAME = 'gengyun_i19_deidentify_test';
const RUNTIME_ROLE = 'gengyun_api_runtime';
const RUNTIME_PASSWORD = 'i19deidentify';
const MIGRATION = '0057_deidentify_account_on_deletion.sql';
const ROLES_FILE = 'deploy/postgres-cvm/sql/20-login-roles.sql';
const DELETION_REGION = 'gy-i19-deletion-grant';
const DEIDENTIFY_REGION = 'gy-i19-deidentify-grant';
/** 起集群最多换几个候选端口（每个都来自内核分配；见 `startCluster()`）。 */
const MAX_PORT_ATTEMPTS = 8;
const TOOL = name => join(binDir, process.platform === 'win32' ? `${name}.exe` : name);
const note = line => console.log(`  · ${line}`);
const pass = line => console.log(`  ✓ ${line}`);

if (binDir === '' || !existsSync(TOOL('initdb'))) {
  console.log(
    'SKIP: 未设置 GY_PG_BIN（含 initdb/pg_ctl 的目录）⇒ 真库臂跳过，'
      + '没有验证 public.deidentify_account() 的擦除面与受理事务接线（未取得，不是通过）。',
  );
  console.log('SKIP: 本臂只认 GY_PG_BIN 指向的 PG 17 二进制（initdb/pg_ctl/createdb），找不到就整链未取得。');
  console.log('SKIP: 退出码 77 ＝ 未取得（⛔ 不是通过）；调用方必须把它显式判红，另见 tests/unit/integration-script-coverage.test.mjs。');
  // 77 ＝ 未取得（POSIX skipped），⛔ 不是 0：整链跳过不许被读成通过。
  process.exit(77);
}

const rootDir = (process.env.GY_I19_PG_ROOT ?? tmpdir()).trim();
const dataDir = join(rootDir, `gy-i19-deidentify-pg-${randomUUID().slice(0, 8)}`);
const toolLog = join(rootDir, 'gy-i19-deidentify-pg-tools.log');
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
let runtimePool = null;
let port = null;
const started = { cluster: false };

async function startCluster() {
  const init = runTool('initdb', ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--locale=C']);
  assert.equal(init.status, 0, `initdb 失败：${tail(toolLog)}`);
  // 端口：向内核要一个**此刻空闲**的（`listen(0)` 现分配），最多试 `MAX_PORT_ATTEMPTS` 次。
  // ⛔ 不用「554xx 逐个数字试」：那段落在 Linux 默认 ephemeral 区间 32768–60999 内，会被任何
  // 出站连接的源端口占住，`pg_ctl start` 就偶发 `could not bind IPv4 address "127.0.0.1": Address already in use`。
  const seen = new Set();
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
    let candidate;
    try {
      // eslint-disable-next-line no-await-in-loop
      candidate = await pickFreePort();
    } catch {
      break; // 连内核都给不出空口：交给下面的断言如实判红，不静默降级
    }
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    // eslint-disable-next-line no-await-in-loop
    if (await portBusy(candidate)) continue;
    port = candidate;
    break;
  }
  assert.ok(port !== null, '连续 8 次都没能拿到空闲端口（兄弟集群占满了？）');
  // POSIX 专有坑：Debian/Ubuntu 的 PGDG 包把 `unix_socket_directories` 的编译默认钉在
  // `/var/run/postgresql`，GitHub runner 的普通用户写不了 ⇒ `pg_ctl start` 直接 `could not start server`。
  // 显式把 socket 目录指到本臂自己的数据目录（Unix 域 socket 随目录一起删），两个平台走同一条码。
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

const userRow = async id => one('SELECT * FROM public.users WHERE id = $1', [id]);
const exportRow = async id => one('SELECT * FROM public.exports WHERE id = $1', [id]);
const writebackRow = async id => one('SELECT * FROM public.export_writebacks WHERE export_id = $1', [id]);
const callDeidentify = async id => (await one('SELECT public.deidentify_account($1::uuid) AS result', [id])).result;

/**
 * `updated_at` 的**微秒**读数（`timestamptz` 的真实精度）。
 * ⛔ 不用 `String(row.updated_at)` 比对：`Date#toString` 只到秒，同一秒内的两次写入会假「没变」。
 */
const updatedAtMicros = async (table, key, id) => {
  const row = await one(
    `SELECT (extract(epoch FROM updated_at) * 1000000)::bigint AS us FROM public.${table} WHERE ${key} = $1`,
    [id],
  );
  assert.ok(row !== undefined, `${table}.${key}=${id} 必须存在（读不到 updated_at）`);
  return Number(row.us);
};

async function sqlState(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error.code ?? null;
  }
}

/** `admin_account_display_name()` 的回落算法（迁移 0017）：`耕云用户` + `md5(id)` 前 4 位大写。 */
const fallbackDisplayName = id => `耕云用户${createHash('md5').update(id).digest('hex').slice(0, 4).toUpperCase()}`;

async function seedUser({ state = 'active', withPii = true } = {}) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO public.users
       (id, wechat_subject_cipher, wechat_subject_lookup, nickname, avatar_media_id,
        state, auth_epoch, revision, deletion_generation)
     VALUES ($1, $2, decode($3, 'hex'), $4, $5, $6::public.user_state, 1, 1, 0)`,
    [
      id,
      withPii ? 'cipher-fixture-v1' : null,
      withPii ? randomBytes(32).toString('hex') : null,
      withPii ? '耕云测试昵称' : null,
      withPii ? randomUUID() : null,
      state,
    ],
  );
  return id;
}

async function seedExport(userId) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO public.exports
       (id, user_id, object_type, object_id, object_revision, purpose, consent_epoch,
        recipient_id, recipient_config_version, auth_epoch, provider_request_ref_cipher)
     VALUES ($1, $2, 'recognition', $3, 1, 'external_inference', 1,
             'vendor-fixture', 'cfg-v1', 1, 'ref-cipher-fixture')`,
    [id, userId, randomUUID()],
  );
  return id;
}

async function seedWriteback(exportId, userId) {
  await owner.query(
    `INSERT INTO public.export_writebacks (export_id, user_id, revision, result)
     VALUES ($1, $2, 1, '{"status":"ok","written":1}'::jsonb)`,
    [exportId, userId],
  );
}

// ---------------------------------------------------------------------------
// [M] 迁移全链 + 角色 + 两条区域授权（真实次序：migrate.ts up ⇒ 20-login-roles.sql）
// ---------------------------------------------------------------------------
async function applyMigrations() {
  const discovered = readdirSync(migrationsDir).filter(name => /^\d{4,}_[a-z0-9_]+\.sql$/.test(name)).sort();
  assert.ok(discovered.includes(MIGRATION), `迁移清单必须含 ${MIGRATION}`);
  for (const name of discovered) {
    // 每一片都应用；本臂不假设顺序以外的东西（迁移器另有单测）。
    // eslint-disable-next-line no-await-in-loop
    await owner.query(readSql(`migrations/${name}`));
  }
  const fn = await one(
    `SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
            pg_get_function_identity_arguments(p.oid) AS args
       FROM pg_proc AS p
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'deidentify_account'`,
  );
  assert.ok(fn !== undefined, '迁移全链应用后 public.deidentify_account 必须存在');
  assert.equal(fn.args, 'p_user_id uuid', `签名必须恰是 (p_user_id uuid)，实际 (${fn.args})`);
  assert.equal(fn.prosecdef, true, '必须是 SECURITY DEFINER');
  assert.ok((fn.proconfig ?? []).includes('search_path=pg_catalog'), `proconfig 必须钉 search_path=pg_catalog（现场：${JSON.stringify(fn.proconfig)}）`);
  assert.notEqual(fn.owner, RUNTIME_ROLE, '属主不得是运行时登录角色');
  note(
    `[M] 全链应用 ${discovered.length} 个迁移（最大号 ${String(Math.max(...discovered.map((name) => Number(name.slice(0, 4)))))}），`
      + '0057 的函数已就位且 SECURITY DEFINER',
  );
}

function rolesRegion(name) {
  const source = readFileSync(join(ROOT, ROLES_FILE), 'utf8');
  // 连同 `-- ` 前缀一起抽（`#region` 本身不是 SQL，只有 `-- #region …` 才是注释行）。
  const found = source.match(new RegExp(`-- #region ${name}[\\s\\S]*?#endregion`));
  assert.ok(found !== null, `${ROLES_FILE} 必须含 #region ${name}`);
  return found[0];
}

// 运行时登录角色实际继承的 5 个 NOLOGIN 组（与 `20-login-roles.sql` 段 C 的 GRANT 逐字同源）。
const RUNTIME_GROUPS = Object.freeze([
  'gengyun_auth_privacy',
  'gengyun_preview_reader',
  'gengyun_consent_granter',
  'gengyun_profile_runtime',
  'gengyun_knowledge_runtime',
]);

async function provisionRoles() {
  for (const name of [...RUNTIME_GROUPS, 'gengyun_evidence_reader']) {
    // eslint-disable-next-line no-await-in-loop
    await owner.query(`DROP ROLE IF EXISTS ${name}`).catch(() => {});
  }
  await owner.query(`DROP ROLE IF EXISTS ${RUNTIME_ROLE}`).catch(() => {});
  for (const file of ['auth_privacy', 'catalog_readers', 'consent_granter', 'profile_runtime', 'knowledge_runtime']) {
    // eslint-disable-next-line no-await-in-loop
    await owner.query(readSql(`roles/${file}.sql`));
  }
  await owner.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${RUNTIME_PASSWORD}'`);
  for (const group of RUNTIME_GROUPS) {
    // eslint-disable-next-line no-await-in-loop
    await owner.query(`GRANT ${group} TO ${RUNTIME_ROLE}`);
  }
  const deletionRegion = rolesRegion(DELETION_REGION);
  assert.ok(deletionRegion.includes(`TO ${RUNTIME_ROLE};`), `#region ${DELETION_REGION} 必须把 EXECUTE 授给运行时`);
  await owner.query(deletionRegion);
  const deidentifyRegion = rolesRegion(DEIDENTIFY_REGION);
  assert.equal(
    (deidentifyRegion.match(new RegExp(`TO ${RUNTIME_ROLE};`, 'g')) ?? []).length,
    1,
    `#region ${DEIDENTIFY_REGION} 只允许一条 GRANT（授给运行时）`,
  );
  await owner.query(deidentifyRegion);
  const granted = await one(
    "SELECT has_function_privilege($1, 'public.deidentify_account(uuid)', 'EXECUTE') AS v",
    [RUNTIME_ROLE],
  );
  assert.equal(granted.v, true, '迁移零 GRANT ⇒ 运行时只能靠 20-login-roles.sql 的区域拿到 EXECUTE');
  note('[M] 出厂角色 + 两条区域授权已按真实次序执行；运行时对 deidentify_account 的 EXECUTE 来自 20-login-roles.sql');
}

// ---------------------------------------------------------------------------
// [A] A1–A7：函数本身的擦除面 / 幂等 / 守卫 / 只清一列
// ---------------------------------------------------------------------------
async function eraseArms() {
  const userId = await seedUser({ state: 'deletion_pending' });
  const exportId = await seedExport(userId);
  await seedWriteback(exportId, userId);
  const beforeUser = await userRow(userId);
  const beforeExport = await exportRow(exportId);
  const beforeWriteback = await writebackRow(exportId);
  const beforeUserMicros = await updatedAtMicros('users', 'id', userId);
  const beforeExportMicros = await updatedAtMicros('exports', 'id', exportId);
  assert.equal(beforeUser.deletion_generation, 0, '夹具：擦除前 generation 必须是 0');

  const first = await callDeidentify(userId);
  assert.deepEqual(
    { identity: first.identity, exports: first.exports, generation: first.generation },
    { identity: 1, exports: 1, generation: 1 },
    `A1 正常擦除读数必须是 identity=1 / exports=1 / generation=1，实际 ${JSON.stringify(first)}`,
  );
  assert.equal(first.userId, userId, 'A1 返回值必须回显 userId');
  assert.equal(first.state, 'deletion_pending', 'A1 返回值必须回显 state（函数不改 state）');
  pass('A1 正常擦除：identity=1、exports=1、generation 0 → 1（读数来自 GET DIAGNOSTICS / RETURNING）');

  const afterUser = await userRow(userId);
  for (const column of ['nickname', 'avatar_media_id', 'wechat_subject_cipher', 'wechat_subject_lookup']) {
    assert.equal(afterUser[column], null, `A2 users.${column} 必须被擦成 NULL`);
  }
  assert.equal(afterUser.state, beforeUser.state, 'A2 state 不归本函数管（一字未动）');
  assert.equal(afterUser.auth_epoch, beforeUser.auth_epoch, 'A2 auth_epoch 不动（撤销会话是 0016 的事）');
  assert.equal(afterUser.revision, beforeUser.revision, 'A2 revision 不动 —— 202 的 accountRevision 不许被去身份顶掉');
  assert.equal(afterUser.deletion_generation, 1, 'A2 generation 必须 +1');
  assert.ok(
    (await updatedAtMicros('users', 'id', userId)) > beforeUserMicros,
    'A2 users.updated_at 必须前移（按微秒比，秒级字符串会假「没变」）',
  );
  pass('A2 四列 PII 全 NULL；state / auth_epoch / revision 一字未动，deletion_generation=1');

  const afterUserMicros = await updatedAtMicros('users', 'id', userId);
  const second = await callDeidentify(userId);
  assert.deepEqual(
    { identity: second.identity, exports: second.exports, generation: second.generation },
    { identity: 0, exports: 0, generation: 1 },
    `A3 幂等读数必须是 identity=0 / exports=0 / generation 仍 1，实际 ${JSON.stringify(second)}`,
  );
  const afterSecond = await userRow(userId);
  assert.equal(afterSecond.deletion_generation, 1, 'A3 幂等调用不得再次自增 generation');
  assert.equal(
    await updatedAtMicros('users', 'id', userId),
    afterUserMicros,
    'A3 幂等调用不得再写 users（updated_at 必须一字不动，按微秒比）',
  );
  pass('A3 幂等：第二次 identity=0、exports=0，generation 不再自增、updated_at 不动');

  const activeUser = await seedUser({ state: 'active' });
  const code4 = await sqlState(() => callDeidentify(activeUser));
  assert.equal(code4, 'G0015', `A4 active 用户必须 G0015，实际 ${String(code4)}`);
  const activeAfter = await userRow(activeUser);
  assert.equal(activeAfter.nickname, '耕云测试昵称', 'A4 被拒时一个字节都不许写');
  assert.equal(activeAfter.deletion_generation, 0, 'A4 被拒时 generation 也不许动');
  pass('A4 state=active ⇒ G0015，且零写入（fail-closed）');

  const code5 = await sqlState(() => callDeidentify(randomUUID()));
  assert.equal(code5, 'G0002', `A5 不存在的 uuid 必须 G0002，实际 ${String(code5)}`);
  pass('A5 不存在的 uuid ⇒ G0002');

  const afterExport = await exportRow(exportId);
  assert.ok(afterExport !== undefined, 'A6 exports 行必须还在（外发台账是 F13 取证材料，⛔ 不删行）');
  // `updated_at` 单列出来按微秒判（同一秒内的两次写入用 `String(Date)` 会假「没变」）；
  // 其余列逐列按原文比，变化集合必须**只有** provider_request_ref_cipher。
  const changed = Object.keys(beforeExport)
    .filter(key => key !== 'updated_at')
    .filter(key => String(beforeExport[key]) !== String(afterExport[key]));
  assert.deepEqual(changed.sort(), ['provider_request_ref_cipher'], `A6 只允许这一列变化，实际变化列：${changed.join(',')}`);
  assert.ok(
    (await updatedAtMicros('exports', 'id', exportId)) > beforeExportMicros,
    'A6 exports.updated_at 必须前移（台账写入时刻）',
  );
  assert.equal(afterExport.provider_request_ref_cipher, null, 'A6 provider_request_ref_cipher 必须变 NULL');
  assert.equal(afterExport.recipient_id, beforeExport.recipient_id, 'A6 recipient_id 是 NOT NULL 证据链，不许动');
  assert.equal(afterExport.object_id, beforeExport.object_id, 'A6 object_id 受 0015 双向 XOR 约束，不许动');
  assert.equal(afterExport.object_key, beforeExport.object_key, 'A6 object_key 同上');
  assert.equal(afterExport.state, beforeExport.state, 'A6 台账状态属于撤销流程，不归本函数');
  pass('A6 exports 行仍在；逐列比对后只有 provider_request_ref_cipher 变 NULL（updated_at 前移），recipient_id/object_id 原样');

  const afterWriteback = await writebackRow(exportId);
  assert.deepEqual(afterWriteback, beforeWriteback, 'A7 export_writebacks 必须一字不变（该表没有 PII 列）');
  pass('A7 export_writebacks 整行逐字段不变（不在本片擦除面）');
}

// ---------------------------------------------------------------------------
// [A8] 最小权限：运行时只能通过函数擦，直改/直读 users.nickname 各 42501
// ---------------------------------------------------------------------------
async function runtimeLeastPrivilege() {
  const userId = await seedUser({ state: 'deletion_pending' });
  await owner.query(`SET ROLE ${RUNTIME_ROLE}`);
  try {
    const result = (await one('SELECT public.deidentify_account($1::uuid) AS result', [userId])).result;
    assert.equal(result.identity, 1, `A8 运行时必须能 EXECUTE（identity 应为 1，实际 ${JSON.stringify(result)}）`);
    const updateCode = await sqlState(() => owner.query("UPDATE public.users SET nickname = 'x' WHERE id = $1", [userId]));
    assert.equal(updateCode, '42501', `A8 运行时直改 users.nickname 必须 42501，实际 ${String(updateCode)}`);
    const selectCode = await sqlState(() => owner.query('SELECT nickname FROM public.users WHERE id = $1', [userId]));
    assert.equal(selectCode, '42501', `A8 运行时应读不到 users.nickname（42501），实际 ${String(selectCode)}`);
  } finally {
    await owner.query('RESET ROLE');
  }
  const row = await userRow(userId);
  assert.equal(
    row.nickname,
    null,
    "A8 直改被拒后 nickname 必须仍是函数擦除后的 NULL（⛔ 不是 'x'，证明 42501 之后一个字节都没写）",
  );
  pass('A8 SET ROLE 运行时：EXECUTE 成功（identity=1），直改/直读 users.nickname 各 42501');
}

// ---------------------------------------------------------------------------
// [A9–A10] 走真实 createRequest()：接线成功 / 收回 EXECUTE 后 fail-closed
// ---------------------------------------------------------------------------
function deletionInput(userId) {
  const now = Date.now();
  return {
    id: randomUUID(),
    userId,
    receiptHash: randomBytes(32).toString('hex'),
    generation: 1,
    requestedAt: new Date(now).toISOString(),
    onlineDueAt: new Date(now + 7 * 24 * 3600 * 1000).toISOString(),
    backupDueAt: new Date(now + 37 * 24 * 3600 * 1000).toISOString(),
    receiptIssuedAt: new Date(now).toISOString(),
    receiptExpiresAt: new Date(now + 7 * 24 * 3600 * 1000).toISOString(),
  };
}

async function storeArms() {
  assert.ok(runtimePool !== null, '运行时 pool 必须建出来');
  const store = createPostgresDeletionRequestStore({ pool: runtimePool });

  const userId = await seedUser({ state: 'active' });
  const exportId = await seedExport(userId);
  await owner.query(
    `INSERT INTO public.sessions (id, user_id, token_hash, auth_epoch, expires_at)
     VALUES ($1, $2, decode($3, 'hex'), 1, now() + interval '1 hour')`,
    [randomUUID(), userId, randomBytes(32).toString('hex')],
  );
  const record = await store.createRequest(deletionInput(userId));
  assert.deepEqual(
    record.deidentified,
    { identity: 1, exports: 1, generation: 1 },
    `A9 受理记录必须合流去身份读数 identity=1 / exports=1 / generation=1，实际 ${JSON.stringify(record.deidentified)}`,
  );
  assert.equal(record.accountState, 'deletion_pending', 'A9 受理后账号必须进 deletion_pending');
  assert.equal(record.authEpoch, 2, 'A9 受理后 auth_epoch 必须 +1（0016 的事，⛔ 不是去身份函数做的）');
  assert.equal(record.accountRevision, 2, 'A9 受理后 revision 必须 +1 —— 去身份函数不许碰 revision，否则这里会掉队');
  assert.equal(record.revokedSessions, 1, 'A9 会话必须被撤销（0016 的 ROW_COUNT）');
  const user = await userRow(userId);
  assert.equal(user.state, 'deletion_pending', 'A9 落库 state 必须是 deletion_pending');
  assert.equal(user.nickname, null, 'A9 落库 nickname 必须已擦除（同一事务）');
  const live = await one('SELECT count(*)::int AS n FROM public.sessions WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  assert.equal(live.n, 0, 'A9 不得残留未撤销会话');
  const requests = await q('SELECT id, state, generation FROM public.deletion_requests WHERE user_id = $1', [userId]);
  assert.equal(requests.length, 1, 'A9 必须恰好一条 deletion_requests 行');
  assert.equal(requests[0].id, record.id, 'A9 记录 id 必须与库内行一致');
  pass('A9 真实 createRequest()：deidentified={identity:1,exports:1,generation:1}；state=deletion_pending、auth_epoch=2、revision=2、会话撤销 1、deletion_requests 1 行');

  // A10：收回 EXECUTE ⇒ 整笔回滚（users 仍 active、deletion_requests 零行），错误码 retryable:false。
  await owner.query(`REVOKE EXECUTE ON FUNCTION public.deidentify_account(uuid) FROM ${RUNTIME_ROLE}`);
  const blockedUser = await seedUser({ state: 'active' });
  await seedExport(blockedUser);
  try {
    let caught = null;
    try {
      await store.createRequest(deletionInput(blockedUser));
    } catch (error) {
      caught = error;
    }
    assert.ok(caught !== null, 'A10 收回 EXECUTE 后 createRequest() 必须抛（⛔ 不许静默受理）');
    assert.equal(caught.code, 'PROVIDER_UNAVAILABLE', `A10 错误码必须 PROVIDER_UNAVAILABLE，实际 ${String(caught.code)}`);
    assert.equal(caught.retryable, false, 'A10 retryable 必须 false（缺授权是运维缺陷，重试不会好）');
    const blocked = await userRow(blockedUser);
    assert.equal(blocked.state, 'active', 'A10 整笔回滚：users.state 必须仍是 active');
    assert.equal(blocked.nickname, '耕云测试昵称', 'A10 整笔回滚：nickname 必须还在');
    const pending = await one('SELECT count(*)::int AS n FROM public.deletion_requests WHERE user_id = $1', [blockedUser]);
    assert.equal(pending.n, 0, 'A10 整笔回滚：deletion_requests 必须零行（不签发 202）');
  } finally {
    await owner.query(`GRANT EXECUTE ON FUNCTION public.deidentify_account(uuid) TO ${RUNTIME_ROLE}`);
  }
  pass('A10 收回 EXECUTE ⇒ PROVIDER_UNAVAILABLE(retryable:false)，users 仍 active、nickname 未动、deletion_requests 零行');

  // A11：擦除后后台读面的展示名回落到 `耕云用户XXXX`。
  const listed = await one('SELECT display_name FROM public.list_admin_accounts() WHERE id = $1', [userId]);
  assert.ok(listed !== undefined, 'A11 已擦除账号必须仍在后台目录里（注销中不等于消失）');
  assert.equal(
    listed.display_name,
    fallbackDisplayName(userId),
    `A11 display_name 必须回落到 耕云用户 + md5(id) 前 4 位大写，实际 ${listed.display_name}`,
  );
  pass(`A11 后台 display_name 回落到 ${listed.display_name}（nickname 为 NULL 时的 0017 回落算法）`);
}

try {
  await startCluster();
  await applyMigrations();
  await provisionRoles();
  runtimePool = createPool(`postgres://${RUNTIME_ROLE}:${RUNTIME_PASSWORD}@127.0.0.1:${port}/${DB_NAME}`);
  await eraseArms();
  await runtimeLeastPrivilege();
  await storeArms();
  note('[S] 90-assert-least-privilege.sql 含 psql 元命令（\\echo/\\if）⇒ 由 `psql -f` 单独执行并回读 verdict（不在本脚本内代跑）');
  pass('结论：注销去身份的函数擦除面（A1–A7）+ 最小权限（A8）+ 受理事务接线与 fail-closed（A9–A10）+ 后台展示名回落（A11）全部通过');
} catch (error) {
  console.error(`FAIL: ${error?.message ?? error}`);
  if (started.cluster) console.error(`    （集群日志尾部：${tail(join(dataDir, 'server.log'))}）`);
  process.exitCode = 1;
} finally {
  await runtimePool?.end().catch(() => {});
  await ownerPool?.end().catch(() => {});
  await owner?.end().catch(() => {});
  if (started.cluster) {
    runTool('pg_ctl', ['-D', dataDir, '-m', 'immediate', 'stop']);
    rmSync(dataDir, { recursive: true, force: true });
  }
  closeSync(logFd);
}
