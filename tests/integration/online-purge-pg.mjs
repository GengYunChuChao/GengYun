#!/usr/bin/env node
/**
 * 真库臂（W6 / #19）：**7 日在线到期执行者** + **回执 `backupState` 由真行推导**。
 *
 * 运行（本机 PG 17.11）：
 *   $env:GY_PG_BIN = 'E:\GengYunCommander\.pg17\pgsql\bin'   # 必填：含 initdb/pg_ctl 的目录
 *   $env:GY_I19_PG_ROOT = 'E:\GengYunCommander\.pg17\tmp'    # 选填：数据目录根（默认 os.tmpdir()）
 *   node tests/integration/online-purge-pg.mjs
 *
 * 未设置 `GY_PG_BIN` ⇒ 打印 SKIP 并以 **77** 退出（POSIX「skipped」）：没有 PG 二进制就如实跳过，
 * 不伪造 PASS。`--allow-skip` / `GY_ALLOW_SKIP=1` 只用于「本机明知没有 PG、只想看跳过原因」，
 * ⛔ 不得接进门禁。
 *
 * 本臂用**注入的固定 cutoff**（不读墙钟）验证：
 *   [1] 运行时角色权限形状：四域 DELETE 已有；`deletion_requests` 读不了（42501）⇒ 命令必须走运维角色
 *   [2] 到期边界（闭区间）：等于/早于 cutoff 的请求被清，晚 1 秒的行**一个字都不动**
 *   [3] 幂等：同一 cutoff 再跑 ⇒ 0 行删除、逐请求 `already_purged`
 *   [4] 批量上限：`--limit` 严格生效，剩余量如实报出
 *   [4b] 批次推进（[P1] 监工 1021/1806）：**超过 `--limit` 的到期集合连续运行后全部处理**——
 *       limit=2、5 个到期请求、每轮只推进一页 ⇒ 三轮处理 2/2/1 全部清空；同一条 SQL 不传游标时
 *       仍只返回队首 A/B（饿死反证）；且全程**不写** `deletion_requests.state`（不伪造整体 completed）
 *   [4c] 同一闭环走生产入口：三条**独立进程** + 磁盘游标（`--cursor-file`）⇒ 跨进程也推进，
 *       走到队尾时游标文件被删掉；`--no-cursor` 退回"只跑一页"
 *   [5] 失败不阻塞：一个模块抛错只让该请求落 failed，同请求已成功模块的证据保留、其它请求照跑
 *   [6] `--dry-run`：只列不删
 *   [7] 证据：每个成功 (request, module) 一行 `sha256:` 摘要，可**独立复算**；报告不含 `user_id`
 *   [8] 回执 `backupState`：真受理 → 四域 `pending` →（31 天后）到期未清 ⇒ `blocked`
 *       →（真清副本 + 证据）⇒ 四域 `completed` ⇒ 整体 `completed`
 *   [9] 在线证据落库 + 回执在线态可推导（迁移 0031）：到期清完 ⇒ `completed` 且落库证据逐条可复算；
 *       未到期 ⇒ `pending`；到期未清 / 闭区间到期 ⇒ `blocked` + `STORE_REJECTED`；
 *       重跑 0 行不追加、同 (module,evidence_ref) 幂等；**换新进程**（另起 node + 另开池）仍读回 completed；
 *       权限面：运行时直读 `deletion_requests`（含两个新列）仍恰好 42501，只多两函数 EXECUTE；
 *       append-only 触发器（G0005）与成对约束（23514）、写函数四类非法入参（G0001/G0002）。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { createPostgresBackupPurgePort } from '../../services/api/src/privacy/backup-copies-pg.ts';
import { createPostgresBackupStateReader } from '../../services/api/src/privacy/backup-state-derivation.ts';
import { createPostgresDeletionRequestStore } from '../../services/api/src/privacy/deletion-requests-pg.ts';
import { createPostgresOnlinePurgeEvidenceRecorder } from '../../services/api/src/privacy/online-purge-evidence.ts';
import { createPostgresOnlineStateReader } from '../../services/api/src/privacy/online-state-derivation.ts';
import {
  USER_DATA_DELETION_MODULES,
  createUserDataDeletion,
} from '../../services/api/src/privacy/user-data-deletion.ts';
import { RECEIPT_TTL_MS } from '../../services/api/src/privacy/account-deletion.ts';
import {
  drainDueOnlineDeletions,
  formatOnlinePurgeReport,
  listDueOnlineDeletions,
  onlinePurgeEvidenceRef,
  onlinePurgeExitCode,
} from '../../services/api/src/privacy/online-purge-driver.ts';
import { createPostgresFavoritesStore } from '../../services/api/src/favorites/store-pg.ts';
import { createPostgresHistoryStore } from '../../services/api/src/history/store-pg.ts';
import { createPostgresMessagesStore } from '../../services/api/src/messages/store-pg.ts';
import { createPostgresConversationStore } from '../../services/api/src/conversations/store-pg.ts';

const binDir = process.env.GY_PG_BIN ?? '';
const ALLOW_SKIP = process.argv.includes('--allow-skip') || process.env.GY_ALLOW_SKIP === '1';
if (binDir === '') {
  console.log('SKIP: 未设置 GY_PG_BIN（postgres 二进制目录，含 initdb/pg_ctl）⇒ 真库臂跳过，没有验证 7 日在线到期执行者（未取得，不是通过）。');
  if (ALLOW_SKIP) {
    console.log('EXITCODE=0（--allow-skip / GY_ALLOW_SKIP=1 已显式授权：仅本机开发，⛔ 不得接进门禁）。');
    process.exit(0);
  }
  console.log('EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped）。');
  process.exit(77);
}

const DB_NAME = 'gy_w6_online_purge';
const migrationsDir = new URL('../../services/api/db/migrations/', import.meta.url);
const sqlFile = (path) => readFileSync(new URL(`../../services/api/db/${path}`, import.meta.url), 'utf8');
const deploySqlFile = (name) => readFileSync(new URL(`../../deploy/postgres-cvm/sql/${name}`, import.meta.url), 'utf8');

const DAY_MS = 24 * 60 * 60 * 1000;
const SECOND_MS = 1000;
/** 注入的固定时钟：本臂**不读墙钟**，所有到期判定都对着这个字符串。 */
const CUTOFF = '2026-04-01T00:00:00.000Z';
const shift = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();

let passed = 0;
const say = (label) => {
  passed += 1;
  console.log(`PASS ${passed}: ${label}`);
  return passed;
};
const note = (line) => console.log(`  - ${line}`);

const rootDir = process.env.GY_I19_PG_ROOT ?? tmpdir();
const dataDir = join(rootDir, `gy-w6-online-purge-${randomBytes(4).toString('hex')}`);
const serverLog = join(rootDir, `gy-w6-online-purge-client-${randomBytes(4).toString('hex')}.log`);
let port = 0;
let adminBase = '';
let targetUrl = '';
const tool = (name) => join(binDir, process.platform === 'win32' ? `${name}.exe` : name);

function portIsFree(candidate) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(candidate, '127.0.0.1');
  });
}

async function pickPort() {
  // 缺省 556xx：避开本机 5432 与本仓其它临时臂用的 55436；每次都先探活（同机可能已有别人的集群）。
  // `GY_I19_PG_PORT`：片 B 的派单要求「独立集群固定 55433」，只影响**本脚本自己**起的临时集群；
  // 端口被占时仍按失败处理（不静默换口，否则读数与派单对不上）。
  const pinned = process.env.GY_I19_PG_PORT ?? '';
  if (pinned !== '') {
    const candidate = Number(pinned);
    if (!Number.isSafeInteger(candidate) || candidate < 1024 || candidate > 65535) {
      throw new Error(`GY_I19_PG_PORT 必须是 1024..65535 的整数（收到 ${pinned}）`);
    }
    if (!(await portIsFree(candidate))) throw new Error(`GY_I19_PG_PORT=${candidate} 已被占用（拒绝换口）`);
    return candidate;
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = 55600 + randomInt(0, 300);
    if (await portIsFree(candidate)) return candidate;
  }
  throw new Error('556xx 区间内找不到空闲端口（同机临时集群过多）');
}

/** 子进程输出去**文件**：本机 sandbox 禁命名管道，用管道收集会等到超时。 */
function runTool(name, args) {
  const fd = openSync(serverLog, 'a');
  try {
    return spawnSync(tool(name), args, {
      stdio: ['ignore', fd, fd],
      env: { ...process.env, PGCONNECT_TIMEOUT: '5' },
      timeout: 180_000,
      windowsHide: true,
    });
  } finally {
    closeSync(fd);
  }
}

function serverOptions() {
  const options = [`-p ${port}`, '-c listen_addresses=127.0.0.1', '-c max_connections=32'];
  if (process.platform !== 'win32') options.push(`-k ${dataDir}`);
  return options.join(' ');
}

function tailOfFile(file, maxLines = 15) {
  try {
    return readFileSync(file, 'utf8').replace(/\s+$/, '').split('\n').slice(-maxLines).join('\n');
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
    `pg_ctl start 失败（status=${start.status}；server.log 尾部：\n${tailOfFile(join(dataDir, 'server.log'))}）`,
  );
  note(`临时集群：数据目录 ${dataDir}，端口 ${port}（只监听 127.0.0.1）`);
}

function stopCluster() {
  assert.ok(basename(dataDir).startsWith('gy-w6-online-purge-'), `拒绝删除非本脚本创建的目录：${dataDir}`);
  // `-m fast`：等在途语句收尾后停库（片 B 派单要求 fast；immediate 会在证据落库后留下未完成恢复）。
  if (existsSync(join(dataDir, 'PG_VERSION'))) runTool('pg_ctl', ['-D', dataDir, '-m', 'fast', '-w', 'stop']);
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

/**
 * 从 `20-login-roles.sql` 主体里取出**原文**的单句 GRANT/REVOKE（不包 region 的那些）。
 *
 * 为什么要它：四域 DELETE（`favorites` / `history` / `conversations`）在 `20-login-roles.sql`
 * 的**主体**（`gy-r28-runtime-domain-grants` 区域之外），整份文件含 psql 元命令不能直接执行。
 * 这里只把涉及本片四域与幂等台账的语句**原样**取出执行，⛔ 不新增、不改写任何授权文本。
 */
function grantStatementsFor(tables) {
  const lines = deploySqlFile('20-login-roles.sql').split(/\r?\n/);
  const statements = [];
  let buffer = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (buffer === null) {
      if (trimmed.startsWith('GRANT ') || trimmed.startsWith('REVOKE ')) buffer = [line];
      continue;
    }
    buffer.push(line);
    if (trimmed.endsWith(';')) {
      const text = buffer.join('\n');
      // 含 psql 元命令（`\echo` 等）的语句一定是「跨过语句末尾又吞了元命令」的假阳性：整句丢掉。
      // 区域内的授权已由上面的 `#region` 抽取执行过，丢它不影响本臂口径。
      const polluted = text.split('\n').some((row) => row.trim().startsWith('\\'));
      if (!polluted && tables.some((table) => text.includes(`public.${table}`))) statements.push(text);
      buffer = null;
    }
  }
  assert.equal(buffer, null, '20-login-roles.sql 里有未闭合的 GRANT/REVOKE 语句');
  return statements;
}

// ---------------------------------------------------------------------------
// 造数（全部由**库属主**写入）
// ---------------------------------------------------------------------------
async function insertUser(owner) {
  const userId = randomUUID();
  await owner.query('INSERT INTO users (id) VALUES ($1::uuid)', [userId]);
  return userId;
}

/**
 * 一条真实的注销请求行。
 * 期限关系照 `0003` 的 `deletion_requests_due_order`（`backup_due_at >= online_due_at >= requested_at`）：
 * `requested_at = online_due_at − 7 日`、`backup_due_at = requested_at + 30 日`。
 */
async function insertDeletionRequest(owner, { userId, onlineDueAt }) {
  const requestId = randomUUID();
  const requestedAt = shift(onlineDueAt, -7 * DAY_MS);
  await owner.query(
    `INSERT INTO public.deletion_requests (
       id, user_id, receipt_hash, generation, state, requested_at,
       online_due_at, backup_due_at, revision, receipt_issued_at, receipt_expires_at
     ) VALUES ($1::uuid, $2::uuid, $3, 1, 'requested', $4::timestamptz,
               $5::timestamptz, $6::timestamptz, 1, $4::timestamptz, $7::timestamptz)`,
    [
      requestId,
      userId,
      randomBytes(32).toString('hex'),
      requestedAt,
      onlineDueAt,
      shift(requestedAt, 30 * DAY_MS),
      shift(requestedAt, 35 * DAY_MS),
    ],
  );
  return { requestId, requestedAt };
}

/** 四域各造一行本人数据（域内最小的合法行，只用于「到期必须真的被删」的读数）。 */
async function seedDomainRows(owner, userId) {
  await owner.query(
    `INSERT INTO public.favorites (id, owner_id, target_type, target_id, target_revision)
     VALUES ($1::uuid, $2::uuid, 'species', $3, 1)`,
    [randomUUID(), userId, `sp-${randomUUID()}`],
  );
  await owner.query(
    `INSERT INTO public.history (id, owner_id, kind, target_type, target_id, target_revision, job_id, job_state, event_key)
     VALUES ($1::uuid, $2::uuid, 'recognition', 'species', $3, 1, $4, 'succeeded', $5)`,
    [randomUUID(), userId, `sp-${randomUUID()}`, `job-${randomUUID()}`, `ev-${randomUUID()}`],
  );
  await owner.query(
    `INSERT INTO public.messages (id, owner_id, type, event_key) VALUES ($1::uuid, $2::uuid, 'system', $3)`,
    [randomUUID(), userId, `ev-${randomUUID()}`],
  );
  await owner.query('INSERT INTO public.conversations (owner_id) VALUES ($1::uuid)', [userId]);
}

const ROW_COUNT_SQL = {
  favorites: 'SELECT count(*)::integer AS n FROM public.favorites WHERE owner_id = $1::uuid',
  history: 'SELECT count(*)::integer AS n FROM public.history WHERE owner_id = $1::uuid',
  messages: 'SELECT count(*)::integer AS n FROM public.messages WHERE owner_id = $1::uuid',
  conversations: 'SELECT count(*)::integer AS n FROM public.conversations WHERE owner_id = $1::uuid',
};

async function domainRowCounts(owner, userId) {
  const counts = {};
  for (const [module, sql] of Object.entries(ROW_COUNT_SQL)) {
    counts[module] = (await owner.query(sql, [userId])).rows[0].n;
  }
  return counts;
}

async function retire(owner, requestIds) {
  if (requestIds.length === 0) return;
  // 仅为了让**下一臂**的候选集只含本臂造数（生产里这个状态由协调器写完，本片不写状态位）。
  // `0003` 的 CHECK `deletion_requests_complete_pair` 要求 state 与 completed_at 成对出现。
  await owner.query(
    'UPDATE public.deletion_requests SET state = $2, completed_at = $3::timestamptz WHERE id = ANY($1::uuid[])',
    [requestIds, 'completed', new Date().toISOString()],
  );
}

/** 这些主体里四域行**全部**被清空的那几个（按入参顺序返回 `requestId`）——批次推进的直接读数。 */
async function emptiedRequests(targets) {
  const done = [];
  for (const target of targets) {
    const counts = await domainRowCounts(owner, target.userId);
    if (Object.values(counts).every((count) => count === 0)) done.push(target.requestId);
  }
  return done;
}

/** 四域 PG store 组成的在线清除端口（CLI 里的 `createFourDomainPurgePort` 同一实现）。 */
function fourDomainPort(pool) {
  const stores = new Map([
    ['favorites', createPostgresFavoritesStore(pool)],
    ['history', createPostgresHistoryStore(pool)],
    ['messages', createPostgresMessagesStore({ pool })],
    ['conversations', createPostgresConversationStore(pool)],
  ]);
  return {
    async purgeModule({ userId, module }) {
      const store = stores.get(module);
      if (store === undefined) {
        const error = new Error(`未实现的模块：${module}`);
        error.code = 'STORE_REJECTED';
        throw error;
      }
      const purgeOwnerData = store.purgeOwnerData;
      if (typeof purgeOwnerData === 'function') {
        const counts = await purgeOwnerData.call(store, userId);
        return { removed: counts.records, idempotency: counts.idempotency };
      }
      return { removed: await store.deleteAllByOwner(userId), idempotency: 0 };
    },
  };
}

/**
 * 跑一轮（与 CLI 同一条路径：`listDueOnlineDeletions` 取页 → `drainDueOnlineDeletions` 推进）。
 * 缺省 `maxBatches: 1` ⇒ 一页一轮，读数与旧口径的"单批"一致（[2]–[8] 各臂沿用）。
 * `after` 是上一轮落下的游标；`maxBatches: 1` + 游标 = CLI 每次 cron 调用的行为。
 */
async function driveOnce({ cutoff, limit, dryRun = false, purge, evidence, after = null, maxBatches = 1 }) {
  return drainDueOnlineDeletions({
    cutoff,
    limit,
    maxBatches,
    dryRun,
    modules: USER_DATA_DELETION_MODULES,
    purge,
    ...(evidence === undefined ? {} : { evidence }),
    after,
    fetchPage: (pageInput) => listDueOnlineDeletions(ownerClient, pageInput),
  });
}

/** 以独立进程跑生产入口 `tools/purge-expired-online-data.mjs`（跨进程游标必须真的落盘才生效）。 */
function runCli(args, extraEnv = {}) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('../../tools/purge-expired-online-data.mjs', import.meta.url)), ...args], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: targetUrl, ...extraEnv },
    timeout: 120_000,
    windowsHide: true,
  });
}

/**
 * **换新进程**读回执在线态：另起一个 node 进程、另开一条池，import 同一个推导端口。
 *
 * 为什么非要真进程：`refreshOnlineStates` 的进程内账本随重启清空 ⇒「读得到」只可能来自
 * **落库的证据**。同进程再 new 一个 reader 只能证明"没有对象级缓存"，证明不了「重启后还在」。
 * 子进程只输出一行 JSON（stdout 末行），其余（pg 的连接日志等）一律不进判定。
 */
function readOnlineStateInFreshProcess({ requestId, userId, nowIso }) {
  const moduleUrl = new URL('../../services/api/src/privacy/online-state-derivation.ts', import.meta.url).href;
  const code = `
const { createPostgresOnlineStateReader } = await import(${JSON.stringify(moduleUrl)});
const pg = (await import('pg')).default;
const pool = new pg.Pool({ connectionString: process.env.GY_ONLINE_STATE_URL, max: 1 });
try {
  const reader = createPostgresOnlineStateReader({ pool, now: () => new Date(process.env.GY_ONLINE_STATE_NOW) });
  const derived = await reader.derive({
    requestId: process.env.GY_ONLINE_STATE_REQUEST,
    userId: process.env.GY_ONLINE_STATE_USER,
    modules: JSON.parse(process.env.GY_ONLINE_STATE_MODULES),
  });
  console.log(JSON.stringify(derived));
} finally {
  await pool.end().catch(() => {});
}
`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    encoding: 'utf8',
    env: {
      ...process.env,
      GY_ONLINE_STATE_URL: runtimeUrl,
      GY_ONLINE_STATE_NOW: nowIso,
      GY_ONLINE_STATE_REQUEST: requestId,
      GY_ONLINE_STATE_USER: userId,
      GY_ONLINE_STATE_MODULES: JSON.stringify([...USER_DATA_DELETION_MODULES]),
    },
    timeout: 120_000,
    windowsHide: true,
  });
}

async function expectSqlState(client, label, sql, params, expectedCode) {
  let error;
  try {
    await client.query(sql, params);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error !== undefined, `${label}：期望库侧拒绝，但语句成功了`);
  assert.equal(error.code, expectedCode, `${label}：SQLSTATE ${error.code}（期望 ${expectedCode}）— ${error.message}`);
}

/** `jsonb` 列在 `pg` 里通常是 JS 数组；兼容个别驱动的字符串形态，且**不猜**：不是数组就是空。 */
function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
let owner; // 库属主 client（造数 + 候选枚举 + 迁移）
let ownerClient = null;
let runtimePool; // 运行时角色池（真清数据用）
let ownerPool; // 属主池（受理事务用）
let runtimeUrl = ''; // 运行时角色连接串（换新进程读证据时传给子进程）

try {
  await startCluster();
  const admin = await connectWithRetry(`${adminBase}/postgres`);
  await admin.query('DROP DATABASE IF EXISTS ' + DB_NAME);
  await admin.query('CREATE DATABASE ' + DB_NAME);
  await admin.end();

  owner = await connectWithRetry(targetUrl);
  ownerClient = owner;
  note(`PostgreSQL ${(await owner.query('SHOW server_version')).rows[0].server_version}`);

  // ---- 迁移：加载**全部**迁移，与出厂顺序一致（含本片新增的 0031_online_purge_evidence.sql）----
  const discovered = readdirSync(migrationsDir).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  for (const name of discovered) await owner.query(readFileSync(new URL(name, migrationsDir), 'utf8'));
  note(`迁移已应用：${discovered.length} 个（${discovered[0]} … ${discovered.at(-1)}）`);

  // ---- 角色与授权：与出厂 provisioning 同形 ----
  for (const file of [
    'roles/auth_privacy.sql',
    'roles/catalog_readers.sql',
    'roles/consent_granter.sql',
    'roles/profile_runtime.sql',
    'roles/knowledge_runtime.sql',
  ]) {
    await owner.query(sqlFile(file));
  }
  const runtimeRole = 'gengyun_api_runtime';
  const password = randomBytes(24).toString('hex');
  await owner.query(
    `CREATE ROLE ${runtimeRole} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
  );
  await owner.query(`GRANT gengyun_auth_privacy TO ${runtimeRole}`);
  for (const region of ['gy-i19-deletion-grant', 'gy-i19-backup-copies-grant', 'gy-r32-i19-online-evidence-grant', 'gy-r28-runtime-domain-grants']) {
    const matched = deploySqlFile('20-login-roles.sql').match(
      new RegExp(`-- #region ${region}\\r?\\n([\\s\\S]*?)\\r?\\n\\s*-- #endregion ${region}`),
    );
    assert.ok(matched !== null, `20-login-roles.sql 必须含 ${region} 区域`);
    assert.equal(/\\(echo|set|pset|if|endif|getenv|gexec)/.test(matched[1]), false, `区域 ${region} 不得含 psql 元命令`);
    await owner.query(matched[1]);
  }
  // 四域 DELETE 授权在文件**主体**里（未包 region）⇒ 取原文语句执行，⛔ 不新增授权文本。
  const domainGrants = grantStatementsFor(['favorites', 'history', 'messages', 'conversations', 'idempotency_keys']);
  assert.ok(domainGrants.length >= 4, `没取到四域授权语句（取到 ${domainGrants.length} 条）`);
  for (const statement of domainGrants) await owner.query(statement);
  note(`已执行 20-login-roles.sql 主体里涉及四域的 ${domainGrants.length} 条 GRANT/REVOKE（原文取出，未新增授权）`);

  runtimeUrl = `postgresql://${runtimeRole}:${password}@127.0.0.1:${port}/${DB_NAME}`;
  runtimePool = new pg.Pool({ connectionString: runtimeUrl, max: 4 });
  ownerPool = new pg.Pool({ connectionString: targetUrl, max: 2 });

  // =========================================================================
  // [1] 权限形状
  // =========================================================================
  const privilege = (
    await runtimePool.query(
      `SELECT has_table_privilege(current_user, 'public.favorites', 'DELETE') AS favorites_delete,
              has_table_privilege(current_user, 'public.history', 'DELETE') AS history_delete,
              has_table_privilege(current_user, 'public.messages', 'DELETE') AS messages_delete,
              has_table_privilege(current_user, 'public.conversations', 'DELETE') AS conversations_delete,
              has_table_privilege(current_user, 'public.user_backup_copies', 'SELECT') AS copies_table_select,
              has_column_privilege(current_user, 'public.user_backup_copies', 'evidence_ref', 'SELECT') AS copies_evidence_select,
              has_table_privilege(current_user, 'public.deletion_requests', 'SELECT') AS requests_select`,
    )
  ).rows[0];
  assert.equal(privilege.favorites_delete, true, '运行时角色必须已有 favorites 的 DELETE（既有授权）');
  assert.equal(privilege.history_delete, true, '运行时角色必须已有 history 的 DELETE（既有授权）');
  assert.equal(privilege.messages_delete, true, '运行时角色必须已有 messages 的 DELETE（既有授权）');
  assert.equal(privilege.conversations_delete, true, '运行时角色必须已有 conversations 的 DELETE（既有授权）');
  assert.equal(privilege.copies_table_select, false, '清单表仍无表级 SELECT（只有列级）');
  assert.equal(privilege.copies_evidence_select, true, '推导备份态只需要列级 SELECT（含 evidence_ref）');
  assert.equal(privilege.requests_select, false, '运行时角色读不到 deletion_requests（第 48 项反向控制）');
  await expectSqlState(runtimePool, '运行时角色枚举到期请求', 'SELECT id FROM public.deletion_requests', [], '42501');
  say('权限形状：四域 DELETE 运行时角色已有（零新增授权）；`deletion_requests` 读不了（42501）⇒ 到期枚举必须走运维/属主角色');

  // =========================================================================
  // [2] 到期边界（闭区间）+ 真的删了
  // =========================================================================
  const exact = { userId: await insertUser(owner), dueAt: CUTOFF };
  exact.request = await insertDeletionRequest(owner, { userId: exact.userId, onlineDueAt: CUTOFF });
  const early = { userId: await insertUser(owner), dueAt: shift(CUTOFF, -SECOND_MS) };
  early.request = await insertDeletionRequest(owner, { userId: early.userId, onlineDueAt: early.dueAt });
  const late = { userId: await insertUser(owner), dueAt: shift(CUTOFF, SECOND_MS) };
  late.request = await insertDeletionRequest(owner, { userId: late.userId, onlineDueAt: late.dueAt });
  for (const target of [exact, early, late]) await seedDomainRows(owner, target.userId);

  const boundary = await driveOnce({ cutoff: CUTOFF, limit: 10, purge: fourDomainPort(runtimePool) });
  const boundaryIds = boundary.evidence.map((row) => row.requestId);
  assert.ok(boundaryIds.includes(exact.request.requestId), '等于 cutoff 的请求必须进候选');
  assert.ok(boundaryIds.includes(early.request.requestId), '早 1 秒的请求必须进候选');
  assert.ok(!boundaryIds.includes(late.request.requestId), '晚 1 秒的请求**不得**被清');
  assert.equal(boundary.rowsPurged, 8, `两个到期主体 × 四域各 1 行 ⇒ 8 行；实际 ${boundary.rowsPurged}`);
  const exactCounts = await domainRowCounts(owner, exact.userId);
  const earlyCounts = await domainRowCounts(owner, early.userId);
  const lateCounts = await domainRowCounts(owner, late.userId);
  assert.deepEqual(exactCounts, { favorites: 0, history: 0, messages: 0, conversations: 0 }, '到期主体的四域行必须全没');
  assert.deepEqual(earlyCounts, { favorites: 0, history: 0, messages: 0, conversations: 0 }, '早 1 秒的主体同样必须被清');
  assert.deepEqual(lateCounts, { favorites: 1, history: 1, messages: 1, conversations: 1 }, '晚 1 秒的主体**一行都不能动**');
  say(`到期边界（cutoff=${CUTOFF}）：等于/早 1 秒的两主体四域共 8 行真的被删；晚 1 秒的主体四域各 1 行原样保留`);

  // =========================================================================
  // [3] 幂等：同一 cutoff 再跑
  // =========================================================================
  const rerun = await driveOnce({ cutoff: CUTOFF, limit: 10, purge: fourDomainPort(runtimePool) });
  assert.equal(rerun.rowsPurged, 0, '重复跑不得再删任何行');
  assert.equal(rerun.evidence.length, 0, '没有一行被删 ⇒ 不产证据行');
  const rerunDone = rerun.skipReasons.already_purged ?? 0;
  assert.ok(rerunDone >= 2, `已清主体必须如实落 already_purged（应 ≥2，实际 ${rerunDone}）`);
  assert.equal(rerun.failed, 0, '重复跑不得把「已经没有了」当失败');
  assert.equal(onlinePurgeExitCode(rerun), 0, '重复跑退出码必须是 0（cron 判据）');
  const stillEmpty = await domainRowCounts(owner, exact.userId);
  assert.deepEqual(stillEmpty, { favorites: 0, history: 0, messages: 0, conversations: 0 });
  say(`幂等：同一 cutoff 第二遍 ⇒ rowsPurged=0、证据 0 行、${rerunDone} 个已清主体落 already_purged、exitCode=0`);

  await retire(owner, [exact.request.requestId, early.request.requestId, late.request.requestId]);

  // =========================================================================
  // [4] 批量上限
  // =========================================================================
  const batchTargets = [];
  for (let index = 0; index < 3; index += 1) {
    const userId = await insertUser(owner);
    const request = await insertDeletionRequest(owner, { userId, onlineDueAt: shift(CUTOFF, -DAY_MS * (3 - index)) });
    await seedDomainRows(owner, userId);
    batchTargets.push({ userId, requestId: request.requestId });
  }
  const limited = await driveOnce({ cutoff: CUTOFF, limit: 2, purge: fourDomainPort(runtimePool) });
  assert.equal(limited.processed, 2, `--limit 2 必须严格只处理 2 个请求（实际 ${limited.processed}）`);
  assert.equal(limited.succeeded, 2);
  assert.equal(limited.remaining, limited.totalDue - 2, '剩余量必须如实报出');
  assert.ok(limited.remaining >= 1, '三个到期请求只处理两个 ⇒ 至少还剩 1');
  const untouched = [];
  for (const target of batchTargets) {
    const counts = await domainRowCounts(owner, target.userId);
    if (counts.favorites === 1) untouched.push(target.requestId);
  }
  assert.equal(untouched.length, 1, `三个主体里必须只有一个没被处理（实际 ${untouched.length}）`);
  assert.ok(!limited.evidence.some((row) => row.requestId === untouched[0]), '没处理的请求不得出现在证据里');
  say(`批量上限：3 个到期请求 + --limit 2 ⇒ processed=2、succeeded=2、remaining=${limited.remaining}、第 3 个主体四域行原样`);

  // =========================================================================
  // [5] 失败不阻塞
  // =========================================================================
  await retire(owner, batchTargets.map((target) => target.requestId));

  // =========================================================================
  // [4b] 批次推进（[P1] 监工 1021/1806）：超过 --limit 的到期集合连续运行后全部处理
  // =========================================================================
  // 旧口径（固定 `ORDER BY online_due_at, id LIMIT n`，且清理不回写请求状态）在这里必然饿死：
  // 每轮都只取到最早的那两个请求，它们早已被清空 ⇒ 每轮记 already_purged，第三个永远进不了候选。
  // 本臂用真 SQL + 真四域清空证明：带上游标连续跑，**超出 limit 的剩余到期请求会被逐个处理掉**。
  const drainLimit = 2;
  const drainTargets = [];
  for (let index = 0; index < 5; index += 1) {
    const onlineDueAt = shift(CUTOFF, -DAY_MS * (5 - index));
    const userId = await insertUser(owner);
    const request = await insertDeletionRequest(owner, { userId, onlineDueAt });
    await seedDomainRows(owner, userId);
    drainTargets.push({ userId, requestId: request.requestId, onlineDueAt });
  }
  const drainIds = drainTargets.map((target) => target.requestId);
  const pageIds = (report) => [...new Set(report.evidence.map((row) => row.requestId))];

  const headFirst = await listDueOnlineDeletions(owner, { cutoff: CUTOFF, limit: drainLimit, after: null });
  assert.deepEqual(
    headFirst.requests.map((row) => row.requestId),
    [drainIds[0], drainIds[1]],
    '队首页必须是最早到期的两个请求',
  );

  const rush1 = await driveOnce({ cutoff: CUTOFF, limit: drainLimit, purge: fourDomainPort(runtimePool) });
  assert.equal(rush1.batches, 1, '每轮只推进一页（--max-batches 1）');
  assert.equal(rush1.processed, 2, `第一轮只处理 limit 条（实际 ${rush1.processed}）`);
  assert.equal(rush1.succeeded, 2);
  assert.equal(rush1.remaining, 3, '剩余量必须如实报出 3');
  assert.equal(rush1.drained, false, '5 个到期请求只处理 2 个 ⇒ 本轮没到队尾');
  assert.notEqual(rush1.nextCursor, null, '没到队尾 ⇒ 必须给出下一轮从哪一行之后继续');
  assert.deepEqual(pageIds(rush1), [drainIds[0], drainIds[1]]);
  assert.deepEqual(await emptiedRequests(drainTargets), [drainIds[0], drainIds[1]], '第一轮清空的正是最早的两个主体');

  // 饿死反证：**不传游标**再查队首，拿到的仍是同一批（已被清空）的 A/B ——
  // 旧口径下一轮就会原地打转，第三个请求永远进不了候选。
  const headAfterRush1 = await listDueOnlineDeletions(owner, { cutoff: CUTOFF, limit: drainLimit, after: null });
  assert.deepEqual(
    headAfterRush1.requests.map((row) => row.requestId),
    [drainIds[0], drainIds[1]],
    '不传游标时必须仍返回同一批已清空的请求（这就是饿死：它们占满了 limit）',
  );

  const rush2 = await driveOnce({
    cutoff: CUTOFF,
    limit: drainLimit,
    purge: fourDomainPort(runtimePool),
    after: rush1.nextCursor,
  });
  assert.equal(rush2.processed, 2);
  assert.equal(rush2.succeeded, 2);
  assert.equal(rush2.drained, false, '还剩 1 个 ⇒ 仍没到队尾');
  assert.deepEqual(pageIds(rush2), [drainIds[2], drainIds[3]], '第二轮必须轮到 C/D，⛔ 不是再撞 A/B');
  assert.deepEqual(await emptiedRequests(drainTargets), [drainIds[0], drainIds[1], drainIds[2], drainIds[3]]);

  const rush3 = await driveOnce({
    cutoff: CUTOFF,
    limit: drainLimit,
    purge: fourDomainPort(runtimePool),
    after: rush2.nextCursor,
  });
  assert.equal(rush3.processed, 1, '第三轮只剩最后 1 个');
  assert.equal(rush3.succeeded, 1);
  assert.equal(rush3.drained, true, '页内不足 limit 条 ⇒ 已到队尾');
  assert.equal(rush3.nextCursor, null, '走到队尾 ⇒ 下一轮从队首重扫');
  assert.deepEqual(pageIds(rush3), [drainIds[4]]);
  assert.deepEqual(await emptiedRequests(drainTargets), drainIds, '连续三轮之后：5 个到期请求的四域行**全部**清空');

  // 走到队尾之后从头整轮重扫（游标为空、页数给足）：全是 already_purged、一行都不再删、退出码 0。
  const rushWrap = await driveOnce({ cutoff: CUTOFF, limit: drainLimit, maxBatches: 5, purge: fourDomainPort(runtimePool) });
  assert.equal(rushWrap.batches, 3, '整轮重扫要翻 2+2+1 三页才到队尾');
  assert.equal(rushWrap.drained, true);
  assert.equal(rushWrap.rowsPurged, 0, '重扫不得再删任何行');
  assert.equal(rushWrap.evidence.length, 0);
  assert.equal(
    rushWrap.skipReasons.already_purged,
    5,
    `5 个请求都该如实落 already_purged（实际 ${rushWrap.skipReasons.already_purged}）`,
  );
  assert.equal(rushWrap.failed, 0);
  assert.equal(onlinePurgeExitCode(rushWrap), 0);

  // 不伪造整体完成：只清了在线四域，请求状态仍然不是 completed（完成判定归协调器）。
  const drainStates = (
    await owner.query('SELECT id, state, completed_at FROM public.deletion_requests WHERE id = ANY($1::uuid[])', [drainIds])
  ).rows;
  assert.equal(drainStates.length, 5);
  assert.equal(drainStates.every((row) => row.state !== 'completed'), true, '清完在线四域不得把请求标 completed');
  assert.equal(drainStates.every((row) => row.completed_at === null), true, 'completed_at 也不得被写');
  note(`批次推进：[4b] 三元组读数 processed=${rush1.processed}/${rush2.processed}/${rush3.processed}、drained=${rush1.drained}/${rush2.drained}/${rush3.drained}`);
  say(
    `批次推进（[P1] 闭环，in-process）：limit=${drainLimit}、5 个到期请求、每轮一页 ⇒ 三轮处理 2/2/1 全部清空；` +
      '同一 SQL 不传游标仍返回队首 A/B（饿死反证）；请求 state 全程未被写（不伪造 completed）',
  );

  await retire(owner, drainIds);

  // =========================================================================
  // [4c] 同一闭环走**生产入口**：三条独立进程 + 磁盘游标
  // =========================================================================
  // cron 每次都是新进程：进度只可能来自磁盘上的游标文件。[4b] 证明驱动会推进，这里证明
  // "跨进程也会推进"，而且走到队尾时游标文件被删掉（下一轮回到队首 = 一整轮）。
  const cliLimit = 2;
  const cliCursorFile = join(rootDir, `gy-w6-cli-cursor-${randomBytes(4).toString('hex')}.json`);
  const cliNowMs = Date.now();
  const cliTargets = [];
  for (let index = 0; index < 5; index += 1) {
    const onlineDueAt = new Date(cliNowMs - DAY_MS * (5 - index)).toISOString();
    const userId = await insertUser(owner);
    const request = await insertDeletionRequest(owner, { userId, onlineDueAt });
    await seedDomainRows(owner, userId);
    cliTargets.push({ userId, requestId: request.requestId, onlineDueAt });
  }
  const cliIds = cliTargets.map((target) => target.requestId);
  const cliArgs = ['--limit', String(cliLimit), '--max-batches', '1', '--cursor-file', cliCursorFile];

  const cli1 = runCli(cliArgs);
  assert.equal(cli1.status, 0, `CLI 第一次运行必须退出 0（status=${cli1.status}｜stdout=${cli1.stdout}｜stderr=${cli1.stderr}）`);
  assert.match(cli1.stdout, /批次 1（逐页处理 2）/, 'CLI 必须打印批次读数');
  assert.match(cli1.stdout, /游标已更新：下一轮从 request=/);
  assert.equal(existsSync(cliCursorFile), true, '没到队尾 ⇒ 游标文件必须落盘');
  assert.deepEqual(await emptiedRequests(cliTargets), [cliIds[0], cliIds[1]]);

  const cli2 = runCli(cliArgs);
  assert.equal(cli2.status, 0, `CLI 第二次运行必须退出 0（status=${cli2.status}｜stderr=${cli2.stderr}）`);
  assert.match(cli2.stdout, /从 request=[0-9a-f-]{36}（online_due_at=/);
  assert.deepEqual(
    await emptiedRequests(cliTargets),
    [cliIds[0], cliIds[1], cliIds[2], cliIds[3]],
    '第二次进程必须接着上次的游标处理 C/D',
  );

  const cli3 = runCli(cliArgs);
  assert.equal(cli3.status, 0, `CLI 第三次运行必须退出 0（status=${cli3.status}｜stderr=${cli3.stderr}）`);
  assert.match(cli3.stdout, /游标已清：本轮走到队尾/);
  assert.equal(existsSync(cliCursorFile), false, '走到队尾 ⇒ 游标文件必须被删掉（下一轮回队首）');
  assert.deepEqual(await emptiedRequests(cliTargets), cliIds, '三个独立进程跑完：5 个到期请求全部清空');

  // `--no-cursor` 退回"只跑一页"：两个都已是 already_purged，一行都不再删。
  const cliNoCursor = runCli(['--limit', String(cliLimit), '--no-cursor']);
  assert.equal(cliNoCursor.status, 0, '--no-cursor 也必须退出 0');
  assert.match(cliNoCursor.stdout, /--no-cursor：只跑一页/);
  assert.match(cliNoCursor.stdout, /already_purged=2/);

  const cliStates = (
    await owner.query('SELECT id, state FROM public.deletion_requests WHERE id = ANY($1::uuid[])', [cliIds])
  ).rows;
  assert.equal(cliStates.length, 5);
  assert.equal(cliStates.every((row) => row.state !== 'completed'), true, 'CLI 也不得把只清了在线四域的请求标 completed');
  say(
    `批次推进（[P1] 闭环，CLI 跨进程）：3 个独立 node 进程 + 磁盘游标 ⇒ 5 个到期请求 2/2/1 全部清空，` +
      '走到队尾时游标文件被删、--no-cursor 只跑一页；请求 state 仍非 completed',
  );

  await retire(owner, cliIds);
  const failing = { userId: await insertUser(owner) };
  failing.request = await insertDeletionRequest(owner, { userId: failing.userId, onlineDueAt: shift(CUTOFF, -2 * DAY_MS) });
  const healthy = { userId: await insertUser(owner) };
  healthy.request = await insertDeletionRequest(owner, { userId: healthy.userId, onlineDueAt: shift(CUTOFF, -DAY_MS) });
  await seedDomainRows(owner, failing.userId);
  await seedDomainRows(owner, healthy.userId);

  const realPort = fourDomainPort(runtimePool);
  const flakyPort = {
    async purgeModule(input) {
      if (input.requestId === failing.request.requestId && input.module === 'history') {
        const error = new Error('注入：该域存储不可达');
        error.code = 'STORE_UNREACHABLE';
        throw error;
      }
      return realPort.purgeModule(input);
    },
  };
  const mixed = await driveOnce({ cutoff: CUTOFF, limit: 10, purge: flakyPort });
  assert.equal(mixed.failed, 1, '只有一个请求落 failed');
  assert.equal(mixed.succeeded, 1, '另一个请求必须照常成功（失败不阻塞）');
  assert.equal(mixed.failures.length, 1);
  assert.equal(mixed.failures[0].requestId, failing.request.requestId);
  assert.equal(mixed.failures[0].module, 'history');
  assert.equal(mixed.failures[0].errorCode, 'STORE_UNREACHABLE', '安全码必须原样透出，不折成 DRIVER_EXCEPTION');
  assert.deepEqual(await domainRowCounts(owner, healthy.userId), { favorites: 0, history: 0, messages: 0, conversations: 0 });
  const failingCounts = await domainRowCounts(owner, failing.userId);
  assert.equal(failingCounts.favorites, 0, '同请求里已成功的模块照样真的删了（证据保留，不因邻居失败而回滚）');
  assert.equal(failingCounts.history, 1, '抛错的那个模块不得被谎称清掉');
  assert.equal(onlinePurgeExitCode(mixed), 1, '有失败行 ⇒ 退出码 1');
  say('失败不阻塞：注入 history 抛 STORE_UNREACHABLE ⇒ 该请求 failed（码原样），同请求 favorites 已删、history 行还在，另一请求四域全清');

  // =========================================================================
  // [6] dry-run
  // =========================================================================
  await retire(owner, [failing.request.requestId, healthy.request.requestId]);
  const dryUserId = await insertUser(owner);
  const dryRequest = await insertDeletionRequest(owner, { userId: dryUserId, onlineDueAt: shift(CUTOFF, -DAY_MS) });
  await seedDomainRows(owner, dryUserId);
  const dryRun = await driveOnce({ cutoff: CUTOFF, limit: 10, dryRun: true, purge: fourDomainPort(runtimePool) });
  assert.equal(dryRun.rowsPurged, 0, 'dry-run 不得删任何行');
  assert.equal(dryRun.evidence.length, 0);
  assert.deepEqual(await domainRowCounts(owner, dryUserId), { favorites: 1, history: 1, messages: 1, conversations: 1 });
  assert.ok((dryRun.skipReasons.dry_run ?? 0) >= 1, 'dry-run 的跳过原因必须如实报出');
  say(`dry-run：rowsPurged=0、证据 0 行、dry_run 跳过 ${dryRun.skipReasons.dry_run} 个请求，四域行原样`);
  // 本臂的四域行**故意没删**（dry-run 的读数就是"原样"）；为了让 [9] 的到期集合只含它自己的造数，
  // 这里按既有口径把请求标成 completed（与 [3]/[4]/[5] 的收尾同一做法，⛔ 不是伪造完成判定）。
  await retire(owner, [dryRequest.requestId]);

  // =========================================================================
  // [7] 证据可复算 + 报告不含 user_id
  // =========================================================================
  const evidenceRow = boundary.evidence.find((row) => row.requestId === exact.request.requestId && row.module === 'favorites');
  assert.ok(evidenceRow !== undefined, '到期主体的 favorites 必须有证据行');
  assert.match(evidenceRow.evidenceRef, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    evidenceRow.evidenceRef,
    onlinePurgeEvidenceRef({
      requestId: evidenceRow.requestId,
      module: evidenceRow.module,
      removed: evidenceRow.removed,
      idempotency: evidenceRow.idempotency,
    }),
    '证据摘要必须能由 (request_id, module, removed, idempotency) 独立复算（逐字相等）',
  );
  assert.equal(boundary.evidence.length, boundary.succeeded * USER_DATA_DELETION_MODULES.length);
  const reportText = formatOnlinePurgeReport(boundary).join('\n');
  assert.equal(reportText.includes(exact.userId), false, '报告文本不得出现 user_id');
  assert.equal(reportText.includes(exact.request.requestId), true, '报告必须给出 request_id（对得上台账）');
  say('证据：每个成功 (request, module) 一行 sha256 摘要、可独立复算；报告只给 request_id，不含 user_id');

  // =========================================================================
  // [8] 回执 `backupState`：由真实 user_backup_copies 行推导
  // =========================================================================
  let clockMs = Date.parse('2026-05-01T00:00:00.000Z');
  const clock = () => new Date(clockMs);
  const deletion = createUserDataDeletion({
    favoritesStore: createPostgresFavoritesStore(runtimePool, { now: () => clockMs }),
    historyStore: createPostgresHistoryStore(runtimePool, { now: () => clockMs }),
    messagesStore: createPostgresMessagesStore({ pool: runtimePool }),
    conversationsStore: createPostgresConversationStore(runtimePool),
    backupPurge: createPostgresBackupPurgePort({ pool: runtimePool, now: clock }),
    backupStates: createPostgresBackupStateReader({ pool: runtimePool, now: clock }),
    // 迁移 0031：在线清理的成功行证据落库（运行时可执行唯一写函数）＋ 回执在线态可推导。
    onlineEvidence: createPostgresOnlinePurgeEvidenceRecorder({ pool: runtimePool, now: clock }),
    onlineStates: createPostgresOnlineStateReader({ pool: runtimePool, now: clock }),
    requests: createPostgresDeletionRequestStore({ pool: ownerPool }),
    receiptTtlMs: RECEIPT_TTL_MS,
    now: clock,
  });

  const receiptUser = await insertUser(owner);
  await owner.query(
    `INSERT INTO public.favorites (id, owner_id, target_type, target_id, target_revision)
     VALUES ($1::uuid, $2::uuid, 'species', $3, 1)`,
    [randomUUID(), receiptUser, `sp-${randomUUID()}`],
  );
  const accepted = deletion.requestDeletionFor(receiptUser, { receiptInput: `w6-${randomUUID()}` });
  const receiptId = String(accepted.id);
  await deletion.executeHandlers(receiptId);
  assert.equal(deletion.completionStatus(receiptId).completed, false, '刚受理不得算完成');

  // ---- 迁移 0031：处理器清完在线四域后，**每个成功行**都必须留下可复算的落库证据 ----
  const onlineEvidenceAfterAccept = (
    await owner.query(
      'SELECT online_purged_at, online_purge_evidence FROM public.deletion_requests WHERE id = $1::uuid',
      [receiptId],
    )
  ).rows[0];
  const acceptEntries = onlineEvidenceAfterAccept.online_purge_evidence ?? [];
  assert.equal(
    acceptEntries.length,
    USER_DATA_DELETION_MODULES.length,
    `受理时的在线清除必须为四域各写一条证据（实际 ${acceptEntries.length}）`,
  );
  assert.notEqual(onlineEvidenceAfterAccept.online_purged_at, null, '证据落库必须同时写 online_purged_at');
  for (const module of USER_DATA_DELETION_MODULES) {
    const one = acceptEntries.find((entry) => entry.module === module);
    assert.ok(one !== undefined, `四域证据里必须有 ${module}`);
    assert.equal(
      one.evidence_ref,
      onlinePurgeEvidenceRef({
        requestId: receiptId,
        module,
        removed: one.removed,
        idempotency: one.idempotency,
      }),
      `${module} 的落库证据必须能由 (request_id, module, removed, idempotency) 独立复算`,
    );
  }
  note(`在线证据（受理时）：${acceptEntries.map((entry) => `${entry.module}:${entry.evidence_ref.slice(0, 15)}…`).join('｜')}`);

  const copiesAfterAccept = (
    await owner.query(
      `SELECT module, state, retention_until, evidence_ref FROM public.user_backup_copies
        WHERE request_id = $1::uuid ORDER BY module`,
      [receiptId],
    )
  ).rows;
  assert.deepEqual(
    copiesAfterAccept.map((row) => row.module).sort(),
    [...USER_DATA_DELETION_MODULES].sort(),
    '受理事务必须为四个必需模块各写一行副本清单',
  );
  assert.equal(copiesAfterAccept.every((row) => row.state === 'pending_purge'), true);

  const receipt1 = deletion.receipt(receiptId);
  for (const module of USER_DATA_DELETION_MODULES) {
    const handler = receipt1.handlers.find((row) => row.module === module);
    assert.ok(handler !== undefined, `回执必须含 ${module}`);
    assert.equal(handler.online_state, 'completed', `${module} 在线侧已清`);
    assert.equal(handler.backup_state, 'pending', `${module} 备份未到期 ⇒ 必须如实 pending（⛔ 不得 completed）`);
  }
  assert.notEqual(receipt1.state, 'completed', '四域备份都还没做 ⇒ 整体不得 completed');
  say('回执（受理后）：四域 online=completed、backup=pending、error_code=null，整体非 completed（四域未齐）');

  // ---- 31 天后：在线证据可复算 ⇒ completed（未到期 ≠ 未清；到期也不会把已清读成 blocked）----
  clockMs += 31 * DAY_MS;
  const dueOnline = await deletion.refreshOnlineStates(receiptId);
  assert.ok(dueOnline !== null, '接线了 onlineStates ⇒ 必须给出推导结果');
  assert.equal(
    dueOnline.derived.overall,
    'completed',
    `受理时已清 + 证据可复算 ⇒ 到期后在线四域必须 completed（实际 ${dueOnline.derived.overall}）`,
  );
  for (const module of USER_DATA_DELETION_MODULES) {
    const one = dueOnline.derived.modules.find((row) => row.module === module);
    assert.equal(one.state, 'completed', `${module} 在线态必须 completed`);
    assert.equal(one.errorCode, null, `${module} 完成后不得留错误码`);
    assert.match(String(one.evidenceRef), /^sha256:[0-9a-f]{64}$/);
  }
  const receiptOnline = deletion.receipt(receiptId);
  for (const module of USER_DATA_DELETION_MODULES) {
    const handler = receiptOnline.handlers.find((row) => row.module === module);
    assert.equal(handler.online_state, 'completed', `${module} 回执在线态必须 completed`);
  }

  // ---- 31 天后：到期但**没清** ⇒ 必须 blocked，⛔ 不是 completed ----
  const dueNotPurged = await deletion.refreshBackupStates(receiptId);
  assert.ok(dueNotPurged !== null, '接线了 backupStates ⇒ 必须给出推导结果');
  assert.equal(dueNotPurged.derived.overall, 'blocked', '30 日已过但仍未清 ⇒ 整体 blocked');
  for (const module of USER_DATA_DELETION_MODULES) {
    const one = dueNotPurged.derived.modules.find((row) => row.module === module);
    assert.equal(one.state, 'blocked', `${module} 到期未清 ⇒ blocked`);
    assert.equal(one.reason, 'BACKUP_PURGE_DUE_NOT_EXECUTED', `${module} 原因必须是「到期未执行」`);
  }
  const receipt2 = deletion.receipt(receiptId);
  for (const module of USER_DATA_DELETION_MODULES) {
    const handler = receipt2.handlers.find((row) => row.module === module);
    assert.equal(handler.backup_state, 'blocked', `${module} 回执必须如实 blocked`);
    assert.equal(handler.error_code, 'STORE_REJECTED', `${module} 必须带出安全错误码`);
  }
  assert.equal(receipt2.state, 'blocked');
  say('回执（30 日已过、副本仍在）：四域 backup=blocked + error_code=STORE_REJECTED、reason=PURGE_DUE_NOT_EXECUTED、整体 blocked');

  // ---- 真清副本（写证据）后再推导 ⇒ 四域齐备 ⇒ completed ----
  const purgePort = createPostgresBackupPurgePort({ pool: runtimePool, now: clock });
  for (const module of USER_DATA_DELETION_MODULES) {
    const outcome = await purgePort.purge({ userId: receiptUser, module, requestId: receiptId, onlineRemoved: 0 });
    assert.equal(outcome.outcome, 'purged', `${module} 到期后真清必须成功：${JSON.stringify(outcome)}`);
    assert.match(String(outcome.evidenceRef), /^sha256:[0-9a-f]{64}$/, `${module} 清完必须带证据`);
  }
  const purgedRows = (
    await owner.query(
      `SELECT module, state, payload, evidence_ref, purged_at FROM public.user_backup_copies
        WHERE request_id = $1::uuid ORDER BY module`,
      [receiptId],
    )
  ).rows;
  assert.equal(purgedRows.every((row) => row.state === 'purged'), true);
  assert.equal(purgedRows.every((row) => row.payload === null), true, '清完 payload 必须是 jsonb null');
  assert.equal(purgedRows.every((row) => row.purged_at !== null), true);

  const fresh = await deletion.refreshBackupStates(receiptId);
  assert.ok(fresh !== null);
  assert.equal(fresh.derived.overall, 'completed', `四域齐备 ⇒ 整体 completed（实际 ${fresh.derived.overall}）`);
  assert.equal(fresh.changed.length, USER_DATA_DELETION_MODULES.length, '四域都该被改写');
  const receipt3 = deletion.receipt(receiptId);
  for (const module of USER_DATA_DELETION_MODULES) {
    const handler = receipt3.handlers.find((row) => row.module === module);
    assert.equal(handler.backup_state, 'completed', `${module} 备份态必须 completed`);
    assert.equal(handler.error_code, null, `${module} 完成后不得留错误码`);
  }
  assert.equal(receipt3.state, 'completed', '四域齐备 ⇒ 回执整体 completed');
  assert.equal(deletion.completionStatus(receiptId).completed, true);
  const evidenceOfReceipt = deletion.evidenceOf(receiptId);
  for (const module of USER_DATA_DELETION_MODULES) {
    assert.match(
      String(evidenceOfReceipt?.[module] ?? ''),
      new RegExp(`${module}:backup-purged:sha256:[0-9a-f]{64}`),
      `${module} 的证据串必须含可复算的备份摘要`,
    );
  }
  note(`回执证据：${JSON.stringify(evidenceOfReceipt)}`);
  say('回执（四域齐备）：refreshBackupStates 后四域 backup=completed、error_code=null、证据带 sha256 摘要，整体与 completionStatus 均为 completed');

  // =========================================================================
  // [9] 证据落库 + 回执在线态可推导（迁移 0031 / #19 片 B）
  // =========================================================================
  // 判据（与派单 §2 逐条对齐）：
  //   ① 到期清完 ⇒ 四域在线态 completed 且证据可复算（落库的 jsonb 元素逐条复算）；
  //   ② 未到期 ⇒ pending；
  //   ③ 到期未清 ⇒ blocked + STORE_REJECTED（⛔ 不得 pending）；
  //   ④ 重跑 0 行 ⇒ 证据不重复（同 (module, evidence_ref) 幂等，不追加）；
  //   ⑤ **换新进程**（另起 node + 另开池）仍能读回 completed ⇒ 证据真的在库里。
  // 权限面：运行时仍读不了 deletion_requests（表级/列级都是 0），只多两个窄口径函数的 EXECUTE。
  // =========================================================================
  const runtimeReader = createPostgresOnlineStateReader({ pool: runtimePool, now: () => new Date(shift(CUTOFF, DAY_MS)) });
  const ownerRecorder = createPostgresOnlinePurgeEvidenceRecorder({ pool: ownerPool, now: () => new Date(CUTOFF) });

  const onlinePrivilege = (
    await runtimePool.query(
      `SELECT has_table_privilege(current_user, 'public.deletion_requests', 'SELECT') AS table_select,
              has_column_privilege(current_user, 'public.deletion_requests', 'online_purge_evidence', 'SELECT') AS evidence_select,
              has_column_privilege(current_user, 'public.deletion_requests', 'online_purged_at', 'SELECT') AS purged_at_select,
              has_function_privilege(current_user, 'public.read_online_purge_evidence(uuid,uuid)', 'EXECUTE') AS read_exec,
              has_function_privilege(current_user,
                'public.record_online_purge_evidence(uuid,text,text,integer,integer,timestamptz)', 'EXECUTE') AS record_exec`,
    )
  ).rows[0];
  assert.equal(onlinePrivilege.table_select, false, '运行时仍然读不了 deletion_requests（第 48 项反向控制不动）');
  assert.equal(onlinePrivilege.evidence_select, false, '运行时不得在新列上拿到任何直接列权限');
  assert.equal(onlinePrivilege.purged_at_select, false);
  assert.equal(onlinePrivilege.read_exec, true, '运行时必须能执行只读回执函数');
  assert.equal(onlinePrivilege.record_exec, true, '运行时必须能执行唯一写证据函数（处理器路径）');
  await expectSqlState(
    runtimePool,
    '运行时直读 online_purge_evidence 列',
    'SELECT online_purge_evidence FROM public.deletion_requests LIMIT 0',
    [],
    '42501',
  );
  say('证据权限面：deletion_requests 表级/列级对运行时仍为 0（直读新列恰好 42501），只多两个 SECURITY DEFINER 函数的 EXECUTE');

  // ---- ① 到期清完：证据落库 + 可复算 ----
  const dueTarget = { userId: await insertUser(owner) };
  const dueRequest = await insertDeletionRequest(owner, { userId: dueTarget.userId, onlineDueAt: shift(CUTOFF, -DAY_MS) });
  await seedDomainRows(owner, dueTarget.userId);
  const recordedRun = await driveOnce({
    cutoff: CUTOFF,
    limit: 10,
    purge: fourDomainPort(runtimePool),
    evidence: ownerRecorder,
  });
  assert.equal(recordedRun.succeeded, 1, `本轮只应处理这一个到期请求（实际 succeeded=${recordedRun.succeeded}）`);
  assert.equal(recordedRun.failed, 0);
  const recordedForTarget = recordedRun.evidence.filter((row) => row.requestId === dueRequest.requestId);
  assert.equal(recordedForTarget.length, USER_DATA_DELETION_MODULES.length, '成功请求的四域证据必须都在本轮报告里');

  const storedEvidence = (
    await owner.query(
      'SELECT online_purged_at, online_purge_evidence FROM public.deletion_requests WHERE id = $1::uuid',
      [dueRequest.requestId],
    )
  ).rows[0];
  assert.notEqual(storedEvidence.online_purged_at, null, '成功行必须落 online_purged_at（不是只进 stdout）');
  assert.equal(jsonArray(storedEvidence.online_purge_evidence).length, USER_DATA_DELETION_MODULES.length);
  for (const module of USER_DATA_DELETION_MODULES) {
    const entry = jsonArray(storedEvidence.online_purge_evidence).find((item) => item.module === module);
    assert.ok(entry !== undefined, `落库证据必须含 ${module}`);
    assert.equal(entry.removed, 1, `${module} 的 removed 必须是真实读数`);
    assert.equal(entry.idempotency, 0);
    assert.equal(
      entry.evidence_ref,
      onlinePurgeEvidenceRef({ requestId: dueRequest.requestId, module, removed: entry.removed, idempotency: entry.idempotency }),
      `${module} 的落库证据必须能独立复算（逐字相等）`,
    );
    assert.match(String(entry.purged_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }

  const derivedCompleted = await runtimeReader.derive({
    requestId: dueRequest.requestId,
    userId: dueTarget.userId,
    modules: [...USER_DATA_DELETION_MODULES],
  });
  assert.equal(derivedCompleted.overall, 'completed', `到期且证据齐备 ⇒ completed（实际 ${derivedCompleted.overall}）`);
  for (const module of USER_DATA_DELETION_MODULES) {
    const one = derivedCompleted.modules.find((item) => item.module === module);
    assert.equal(one.state, 'completed', `${module} 必须 completed`);
    assert.equal(one.errorCode, null);
    assert.match(String(one.evidenceRef), /^sha256:[0-9a-f]{64}$/);
  }
  say('证据落库：到期清除的每个成功 (request,module) 行写出 sha256 证据（4 条，逐条可复算）⇒ 在线四域 completed');

  // ---- ④ 重跑 0 行：证据不重复 ----
  const rerunForEvidence = await driveOnce({
    cutoff: CUTOFF,
    limit: 10,
    purge: fourDomainPort(runtimePool),
    evidence: ownerRecorder,
  });
  assert.equal(rerunForEvidence.rowsPurged, 0);
  assert.equal(rerunForEvidence.evidence.length, 0, '0 行 ⇒ 报告里也不产证据行');
  const storedAfterRerun = (
    await owner.query('SELECT online_purge_evidence FROM public.deletion_requests WHERE id = $1::uuid', [dueRequest.requestId])
  ).rows[0];
  assert.equal(jsonArray(storedAfterRerun.online_purge_evidence).length, USER_DATA_DELETION_MODULES.length, '重跑不得追加证据');

  // 同一 (module, evidence_ref) 再写一次：幂等，不重复追加（DB 侧防重，不只靠驱动不调用）。
  const runtimeRecorder = createPostgresOnlinePurgeEvidenceRecorder({ pool: runtimePool, now: () => new Date(CUTOFF) });
  await runtimeRecorder.record({
    requestId: dueRequest.requestId,
    module: 'favorites',
    removed: 0,
    idempotency: 0,
  });
  const afterFirstAppend = (
    await owner.query('SELECT online_purge_evidence FROM public.deletion_requests WHERE id = $1::uuid', [dueRequest.requestId])
  ).rows[0];
  assert.equal(
    jsonArray(afterFirstAppend.online_purge_evidence).length,
    USER_DATA_DELETION_MODULES.length + 1,
    '新读数（removed=0）是不同事实 ⇒ 允许追加一条',
  );
  await runtimeRecorder.record({
    requestId: dueRequest.requestId,
    module: 'favorites',
    removed: 0,
    idempotency: 0,
  });
  const afterSecondAppend = (
    await owner.query('SELECT online_purge_evidence FROM public.deletion_requests WHERE id = $1::uuid', [dueRequest.requestId])
  ).rows[0];
  assert.equal(
    jsonArray(afterSecondAppend.online_purge_evidence).length,
    USER_DATA_DELETION_MODULES.length + 1,
    '同一 (module, evidence_ref) 重复调用不得重复追加（证据不重复）',
  );
  say('证据不重复：重跑 0 行不追加；同一 (module,evidence_ref) 重复写入被库侧幂等挡住（条数不变）');

  // ---- ⑤ 换新进程仍可读 ----
  const freshProcess = readOnlineStateInFreshProcess({
    requestId: dueRequest.requestId,
    userId: dueTarget.userId,
    nowIso: shift(CUTOFF, DAY_MS),
  });
  assert.equal(
    freshProcess.status,
    0,
    `换新进程读在线态必须成功（status=${freshProcess.status}｜stdout=${freshProcess.stdout}｜stderr=${freshProcess.stderr}）`,
  );
  const freshDerived = JSON.parse(String(freshProcess.stdout).trim().split(/\r?\n/).at(-1));
  assert.equal(freshDerived.overall, 'completed', '新进程只能靠落库证据 ⇒ 必须仍读回 completed');
  // 对照臂在**同一时点**重算（证据条数在上面的幂等臂里变过 4→5，旧读数不能拿来比）。
  const currentDerived = await runtimeReader.derive({
    requestId: dueRequest.requestId,
    userId: dueTarget.userId,
    modules: [...USER_DATA_DELETION_MODULES],
  });
  assert.deepEqual(
    freshDerived,
    JSON.parse(JSON.stringify(currentDerived)),
    '新进程与同进程读到的推导结果必须逐字段一致',
  );
  say('换新进程：另起 node 进程 + 另开连接池 ⇒ 仍读回 completed（证据在库里，不在进程内账本）');

  // ---- ② 未到期 ⇒ pending ----
  const pendingTarget = { userId: await insertUser(owner) };
  const pendingRequest = await insertDeletionRequest(owner, { userId: pendingTarget.userId, onlineDueAt: shift(CUTOFF, 7 * DAY_MS) });
  const derivedPending = await runtimeReader.derive({
    requestId: pendingRequest.requestId,
    userId: pendingTarget.userId,
    modules: [...USER_DATA_DELETION_MODULES],
  });
  assert.equal(derivedPending.overall, 'pending', `未到期 ⇒ pending（实际 ${derivedPending.overall}）`);
  for (const one of derivedPending.modules) {
    assert.equal(one.state, 'pending');
    assert.equal(one.errorCode, null, 'pending 不得带错误码');
  }
  say('未到期：四域证据为空且 online_due_at 未到 ⇒ pending（唯一正当的 pending 语义）');

  // ---- ③ 到期未清 ⇒ blocked（⛔ 不是 pending）----
  const blockedTarget = { userId: await insertUser(owner) };
  const blockedRequest = await insertDeletionRequest(owner, { userId: blockedTarget.userId, onlineDueAt: shift(CUTOFF, -2 * DAY_MS) });
  const derivedBlocked = await runtimeReader.derive({
    requestId: blockedRequest.requestId,
    userId: blockedTarget.userId,
    modules: [...USER_DATA_DELETION_MODULES],
  });
  assert.equal(derivedBlocked.overall, 'blocked', `到期未清必须 blocked（实际 ${derivedBlocked.overall}）`);
  for (const one of derivedBlocked.modules) {
    assert.equal(one.state, 'blocked', `${one.module} 到期未清 ⇒ blocked，⛔ 不得 pending`);
    assert.equal(one.reason, 'ONLINE_PURGE_DUE_NOT_EXECUTED');
    assert.equal(one.errorCode, 'STORE_REJECTED');
  }
  // 闭区间：`now === online_due_at` 也算到期（与驱动/候选 SQL 同口径）。
  const exactDueTarget = { userId: await insertUser(owner) };
  const exactDueRequest = await insertDeletionRequest(owner, { userId: exactDueTarget.userId, onlineDueAt: CUTOFF });
  const atDueReader = createPostgresOnlineStateReader({ pool: runtimePool, now: () => new Date(CUTOFF) });
  const derivedAtDue = await atDueReader.derive({
    requestId: exactDueRequest.requestId,
    userId: exactDueTarget.userId,
    modules: [...USER_DATA_DELETION_MODULES],
  });
  assert.equal(derivedAtDue.overall, 'blocked', 'now === online_due_at 也必须是 blocked（闭区间，不判 pending）');
  say('到期未清：四域 blocked + STORE_REJECTED；now === online_due_at 的闭区间同样 blocked');

  // ---- 证据只可追加：清空/置 NULL/少一项都被触发器挡住 ----
  await expectSqlState(
    owner,
    '证据数组不得被清空',
    `UPDATE public.deletion_requests SET online_purge_evidence = '[]'::jsonb WHERE id = $1::uuid`,
    [dueRequest.requestId],
    'G0005',
  );
  await expectSqlState(
    owner,
    '证据数组不得被整列置 NULL',
    'UPDATE public.deletion_requests SET online_purge_evidence = NULL, online_purged_at = NULL WHERE id = $1::uuid',
    [dueRequest.requestId],
    'G0005',
  );
  await expectSqlState(
    owner,
    '证据数组不得丢掉已有条目',
    `UPDATE public.deletion_requests
        SET online_purge_evidence = jsonb_build_array(jsonb_array_element(online_purge_evidence, 0))
      WHERE id = $1::uuid`,
    [dueRequest.requestId],
    'G0005',
  );
  await expectSqlState(
    owner,
    'evidence 与 purged_at 必须成对',
    'UPDATE public.deletion_requests SET online_purged_at = NULL WHERE id = $1::uuid',
    [dueRequest.requestId],
    '23514',
  );
  // 唯一写路径的入参自检：模块名/摘要形状/请求存在性都不能靠"库会兜住"。
  await expectSqlState(
    owner,
    '证据模块名形状非法',
    'SELECT public.record_online_purge_evidence($1::uuid, $2, $3, 1, 0, now())',
    [dueRequest.requestId, 'Bad Module', `sha256:${'0'.repeat(64)}`],
    'G0001',
  );
  await expectSqlState(
    owner,
    '证据摘要形状非法',
    'SELECT public.record_online_purge_evidence($1::uuid, $2, $3, 1, 0, now())',
    [dueRequest.requestId, 'favorites', 'not-a-sha256'],
    'G0001',
  );
  const absentRequest = randomUUID();
  await expectSqlState(
    owner,
    '不存在的注销请求不得被写证据',
    'SELECT public.record_online_purge_evidence($1::uuid, $2, $3, 1, 0, now())',
    [absentRequest, 'favorites', onlinePurgeEvidenceRef({ requestId: absentRequest, module: 'favorites', removed: 1, idempotency: 0 })],
    'G0002',
  );
  const wrongSubject = await owner.query('SELECT public.read_online_purge_evidence($1::uuid, $2::uuid) AS state', [
    dueRequest.requestId,
    randomUUID(),
  ]);
  assert.equal(wrongSubject.rows[0].state, null, '读路径必须按 (request_id, user_id) 过滤：错误主体读不到任何行');
  say('证据只可追加：清空/置 NULL/删条目 = G0005；只清 purged_at = 23514；模块名/摘要/请求/主体四类非法输入均被拒');

  await retire(owner, [dueRequest.requestId, pendingRequest.requestId, blockedRequest.requestId, exactDueRequest.requestId]);

  note(`EXITCODE=0（共 ${passed} 组 PASS）`);
  process.exitCode = 0;
} catch (error) {
  console.error(`FAIL: ${error?.stack ?? error}`);
  console.error(`工具日志：${serverLog}`);
  process.exitCode = 1;
} finally {
  await runtimePool?.end().catch(() => {});
  await ownerPool?.end().catch(() => {});
  await owner?.end().catch(() => {});
  try {
    stopCluster();
  } catch (error) {
    console.error(`清理临时集群失败：${error?.message ?? error}`);
    process.exitCode = process.exitCode === 0 ? 1 : process.exitCode;
  }
}
