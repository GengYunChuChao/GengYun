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
 *   [5] 失败不阻塞：一个模块抛错只让该请求落 failed，同请求已成功模块的证据保留、其它请求照跑
 *   [6] `--dry-run`：只列不删
 *   [7] 证据：每个成功 (request, module) 一行 `sha256:` 摘要，可**独立复算**；报告不含 `user_id`
 *   [8] 回执 `backupState`：真受理 → 四域 `pending` →（31 天后）到期未清 ⇒ `blocked`
 *       →（真清副本 + 证据）⇒ 四域 `completed` ⇒ 整体 `completed`
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import pg from 'pg';

import { createPostgresBackupPurgePort } from '../../services/api/src/privacy/backup-copies-pg.ts';
import { createPostgresBackupStateReader } from '../../services/api/src/privacy/backup-state-derivation.ts';
import { createPostgresDeletionRequestStore } from '../../services/api/src/privacy/deletion-requests-pg.ts';
import {
  USER_DATA_DELETION_MODULES,
  createUserDataDeletion,
} from '../../services/api/src/privacy/user-data-deletion.ts';
import { RECEIPT_TTL_MS } from '../../services/api/src/privacy/account-deletion.ts';
import {
  formatOnlinePurgeReport,
  listDueOnlineDeletions,
  onlinePurgeEvidenceRef,
  onlinePurgeExitCode,
  normalizeOnlinePurgeLimit,
  runOnlinePurgeBatch,
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
  // 556xx：避开本机 5432 与本仓其它临时臂用的 55436；每次都先探活（同机可能已有别人的集群）。
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

/** 以库属主枚举候选（运行时角色读不了 `deletion_requests`），执行走注入口。 */
async function driveOnce({ cutoff, limit, dryRun = false, purge }) {
  const { requests, totalDue } = await listDueOnlineDeletions(ownerClient, { cutoff, limit });
  const report = await runOnlinePurgeBatch({
    cutoff,
    limit,
    requests,
    totalDue,
    dryRun,
    modules: USER_DATA_DELETION_MODULES,
    purge,
  });
  return report;
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

// ---------------------------------------------------------------------------
let owner; // 库属主 client（造数 + 候选枚举 + 迁移）
let ownerClient = null;
let runtimePool; // 运行时角色池（真清数据用）
let ownerPool; // 属主池（受理事务用）

try {
  await startCluster();
  const admin = await connectWithRetry(`${adminBase}/postgres`);
  await admin.query('DROP DATABASE IF EXISTS ' + DB_NAME);
  await admin.query('CREATE DATABASE ' + DB_NAME);
  await admin.end();

  owner = await connectWithRetry(targetUrl);
  ownerClient = owner;
  note(`PostgreSQL ${(await owner.query('SHOW server_version')).rows[0].server_version}`);

  // ---- 迁移：全部既有迁移，与出厂顺序一致（**本片不新增迁移**）----
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
  for (const region of ['gy-i19-deletion-grant', 'gy-i19-backup-copies-grant', 'gy-r28-runtime-domain-grants']) {
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

  runtimePool = new pg.Pool({ connectionString: `postgresql://${runtimeRole}:${password}@127.0.0.1:${port}/${DB_NAME}`, max: 4 });
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
  console.log('DEBUG boundary=' + JSON.stringify(boundary));
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

  // ---- 31 天后：到期但**没清** ⇒ 必须 blocked，⛔ 不是 completed ----
  clockMs += 31 * DAY_MS;
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
