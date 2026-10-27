#!/usr/bin/env node
/**
 * GY-I19（#19 片B-演练）· 7/30 日「加速时钟」演练集成测试 —— 纯测试，无迁移。
 *
 * ## 为什么有这份演练
 * `online-purge-driver.ts`（7 日在线到期执行者）与 `backup-purge-driver.ts`（30 日备份副本
 * 到期执行者）都已合并，但它们都只是「运维命令 + 外部 cron」驱动的**模块**，仓内没有进程级
 * 调度设施。因此「真实任务时间到 7/30 日、驱动真的把到期数据删掉」这件事此前没有一份
 * 一次性、可证的三态验收。本演练用**可注入的加速时钟**把时间推到第 7 日 / 第 30 日的边界，
 * 在 stub（纯逻辑，不碰 PG）与 PG（一次性临时集群）两层各证一遍：
 *
 *   1. **未到期不删**：差 1ms 到 7/30 日 ⇒ 一行都不动；
 *   2. **刚好到期删**（闭区间）：`cutoff === online_due_at`（第 7 日）删在线四域，
 *      `cutoff === backup_due_at`（第 30 日）删备份副本 —— 相等那一刻即到期；
 *   3. **到期删除**：早于边界的到期行照删，且「第 7 日在线已清、第 30 日备份未动」的时序
 *      顺序也被钉死（备份的 30 日到点前，在线数据已经先被清掉）。
 *
 * ## 三态（可证，不伪装）
 *   - **通过**（exit 0）：stub 臂 + PG 臂全部断言通过；
 *   - **未取得**（exit 77）：未设置 `GY_PG_BIN`（postgres 二进制目录，含 initdb/pg_ctl），
 *     真库臂如实跳过 —— 不是通过；`--allow-skip` / `GY_ALLOW_SKIP=1` 只降级为 0（本机开发用，
 *     ⛔ 不得接进门禁）；
 *   - **失败**（exit 1）：任一断言失败（含真库起不来 / 真删除没发生）。
 *
 * ## 运行
 *   $env:GY_PG_BIN = 'E:\GengYunCommander\.pg17\pgsql\bin'   # 必填：含 initdb/pg_ctl 的目录
 *   $env:GY_I19_PG_ROOT = 'E:\GengYunCommander\.pg17\tmp'    # 选填：数据目录根（默认 os.tmpdir()）
 *   node tests/integration/retention-clock-drill-pg.mjs
 *
 * 本演练只改 `tests/` 下的测试（及测试支撑），⛔ 不改 `services/`、`tools/`、`deploy/`、
 * 迁移、CI —— 驱动与删除端口都是只读消费。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import pg from 'pg';

import { copyPayloadDigest, copyPayloadJson } from '../../packages/privacy/backup-copies.mjs';
import { createPostgresBackupPurgePort } from '../../services/api/src/privacy/backup-copies-pg.ts';
import {
  listDueBackupCopyGroups,
  runBackupPurgeBatch,
} from '../../services/api/src/privacy/backup-purge-driver.ts';
import {
  BACKUP_RETENTION_MS,
  ONLINE_RETENTION_MS,
  deletionAgingDeadlines,
  evaluateDeletionAging,
} from '../../services/api/src/privacy/deletion-aging.ts';
import {
  drainDueOnlineDeletions,
  listDueOnlineDeletions,
  runOnlinePurgeBatch,
} from '../../services/api/src/privacy/online-purge-driver.ts';
import { USER_DATA_DELETION_MODULES } from '../../services/api/src/privacy/user-data-deletion.ts';
import { createPostgresConversationStore } from '../../services/api/src/conversations/store-pg.ts';
import { createPostgresFavoritesStore } from '../../services/api/src/favorites/store-pg.ts';
import { createPostgresHistoryStore } from '../../services/api/src/history/store-pg.ts';
import { createPostgresMessagesStore } from '../../services/api/src/messages/store-pg.ts';
import { pickFreePort } from './lib/free-port.mjs';

const binDir = process.env.GY_PG_BIN ?? '';
// 缺 PG 二进制时的出口：默认 77（未取得，不是通过）；只有显式 `--allow-skip` / `GY_ALLOW_SKIP=1` 才降级为 0。
const ALLOW_SKIP = process.argv.includes('--allow-skip') || process.env.GY_ALLOW_SKIP === '1';
if (binDir === '') {
  console.log('SKIP: 未设置 GY_PG_BIN（postgres 二进制目录，含 initdb/pg_ctl）⇒ 真库臂跳过，没有验证 7/30 日到期执行（未取得，不是通过）。');
  if (ALLOW_SKIP) {
    console.log('EXITCODE=0（--allow-skip / GY_ALLOW_SKIP=1 已显式授权：仅本机开发，⛔ 不得接进门禁）。');
    process.exit(0);
  }
  console.log('EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本机明知没有 PG 二进制时可显式加 --allow-skip 取 0）。');
  process.exit(77);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const shift = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();

let passed = 0;
const say = (label) => {
  passed += 1;
  console.log(`PASS ${passed}: ${label}`);
  return passed;
};
const note = (line) => console.log(`  - ${line}`);

// ---------------------------------------------------------------------------
// 臂 0：stub 层（纯逻辑、不读墙钟、不碰 PG）—— 加速时钟的 7/30 日边界三态
//
// 驱动与到期模块本身不读系统时钟：cutoff / now 由调用方注入。这里直接喂「加速后的时刻」，
// 证明「未到期不删 / 刚好到期删 / 到期删」三态在 stub 端口上就是逐行可证的事实。
// ---------------------------------------------------------------------------
const REQUESTED = '2026-10-01T00:00:00.000Z';
const ONLINE_DUE = shift(REQUESTED, 7 * DAY_MS); // 第 7 日当天（闭区间：相等即到期）
const BACKUP_DUE = shift(REQUESTED, 30 * DAY_MS); // 第 30 日当天

{
  const deadlines = deletionAgingDeadlines(REQUESTED);
  assert.equal(ONLINE_RETENTION_MS, 7 * DAY_MS, '在线保留期必须逐毫秒等于 7 日');
  assert.equal(BACKUP_RETENTION_MS, 30 * DAY_MS, '备份保留期必须逐毫秒等于 30 日');
  assert.equal(deadlines.online_due_at, ONLINE_DUE, '在线到期 = 受理 + 7 日');
  assert.equal(deadlines.backup_due_at, BACKUP_DUE, '备份到期 = 受理 + 30 日');
  say('stub·期限口径：在线 +7 日 / 备份 +30 日（逐毫秒）');
}

{
  const at7 = evaluateDeletionAging({ requestedAt: REQUESTED, phase: 'online', now: ONLINE_DUE });
  const before7 = evaluateDeletionAging({ requestedAt: REQUESTED, phase: 'online', now: shift(ONLINE_DUE, -1) });
  assert.equal(at7.is_due, true, '第 7 日当天那一毫秒即到期（闭区间）');
  assert.equal(at7.online_due, true);
  assert.equal(at7.backup_due, false, '第 7 日当天备份尚未到期');
  assert.equal(before7.is_due, false, '差 1ms 到第 7 日 ⇒ 未到期');
  assert.equal(before7.state, 'pending');

  const at30 = evaluateDeletionAging({ requestedAt: REQUESTED, phase: 'backup', now: BACKUP_DUE });
  const before30 = evaluateDeletionAging({ requestedAt: REQUESTED, phase: 'backup', now: shift(BACKUP_DUE, -1) });
  assert.equal(at30.is_due, true, '第 30 日当天即到期（闭区间）');
  assert.equal(before30.is_due, false, '差 1ms 到第 30 日 ⇒ 未到期');
  assert.equal(before30.state, 'pending');
  say('stub·到期判定：闭区间（=7/30 日即到期，差 1ms 仍 pending）');
}

{
  // 在线驱动（stub 端口）：三个候选 = 未到期（cutoff+1ms）/ 刚好到期（cutoff）/ 已到期（cutoff-1ms）。
  const cutoff = ONLINE_DUE;
  const candidates = [
    { requestId: randomUUID(), userId: randomUUID(), onlineDueAt: shift(cutoff, 1) },
    { requestId: randomUUID(), userId: randomUUID(), onlineDueAt: cutoff },
    { requestId: randomUUID(), userId: randomUUID(), onlineDueAt: shift(cutoff, -1) },
  ];
  const report = await runOnlinePurgeBatch({
    cutoff,
    limit: 10,
    requests: candidates,
    totalDue: candidates.length,
    dryRun: false,
    modules: ['favorites'],
    purge: {
      async purgeModule({ module }) {
        assert.equal(module, 'favorites');
        return { removed: 1, idempotency: 0 };
      },
    },
  });
  assert.equal(report.processed, 3);
  assert.equal(report.succeeded, 2, '刚好到期与已到期 ⇒ 删（succeeded=2）');
  assert.equal(report.skipped, 1, '未到期 ⇒ 跳过（不删）');
  assert.equal(report.skipReasons.not_due, 1);
  assert.equal(report.rowsPurged, 2, '只有两个到期候选被删（各 1 行）');
  say('stub·在线驱动：未到期跳过 / 刚好到期删 / 已到期删（rowsPurged=2、not_due=1）');
}

{
  // 备份驱动（stub purge）：三个组 = 未到期（cutoff+1ms）/ 刚好到期（cutoff）/ 已到期（cutoff-1ms）。
  const cutoff = BACKUP_DUE;
  const mk = (retentionUntil) => ({
    requestId: randomUUID(),
    userId: randomUUID(),
    module: 'favorites',
    rowCount: 1,
    pendingRows: 1,
    failedRows: 0,
    retentionUntil,
  });
  const groups = [mk(shift(cutoff, 1)), mk(cutoff), mk(shift(cutoff, -1))];
  const report = await runBackupPurgeBatch({
    cutoff,
    groups,
    limit: 10,
    purge: async ({ userId, module, requestId }) => {
      assert.equal(typeof userId, 'string');
      assert.equal(module, 'favorites');
      assert.equal(typeof requestId, 'string');
      return { purged: true, outcome: 'purged' };
    },
  });
  assert.equal(report.processed, 3);
  assert.equal(report.succeeded, 2, '刚好到期与已到期 ⇒ 清（succeeded=2）');
  assert.equal(report.skipped, 1, '未到期 ⇒ 跳过（不清）');
  assert.equal(report.skipReasons.not_due, 1);
  assert.equal(report.rowsPurged, 2, '只有两个到期组被清（各 1 行）');
  say('stub·备份驱动：未到期跳过 / 刚好到期清 / 已到期清（rowsPurged=2、not_due=1）');
}

// ---------------------------------------------------------------------------
// 临时集群（数据目录随机；端口向内核要一个此刻空闲的 —— ⛔ 不再用 `55600 + randomInt(0, 300)`：
// 那套挑法落在 Linux 默认 ephemeral 区间 32768–60999 里，会被出站连接的源端口占住）
// ---------------------------------------------------------------------------
const DB_NAME = 'gy_i19_clock_drill';
const migrationsDir = new URL('../../services/api/db/migrations/', import.meta.url);
const sqlFile = (path) => readFileSync(new URL(`../../services/api/db/${path}`, import.meta.url), 'utf8');
const deploySqlFile = (name) => readFileSync(new URL(`../../deploy/postgres-cvm/sql/${name}`, import.meta.url), 'utf8');

const rootDir = process.env.GY_I19_PG_ROOT ?? tmpdir();
const dataDir = join(rootDir, `gy-i19-clock-drill-${randomBytes(4).toString('hex')}`);
const serverLog = join(rootDir, `gy-i19-clock-drill-${randomBytes(4).toString('hex')}.log`);
let port = 0;
let adminBase = '';
let targetUrl = '';
const tool = (name) => join(binDir, process.platform === 'win32' ? `${name}.exe` : name);

/** 子进程统一把 stdout/stderr 重定向到**文件**：本机 sandbox 禁止命名管道，用管道收集会等到超时。 */
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
  port = await pickFreePort();
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
    `pg_ctl start 失败（status=${start.status}，工具日志见 ${serverLog}；server.log 尾部：\n${tailOfFile(join(dataDir, 'server.log'))}）`,
  );
  note(`临时集群：数据目录 ${dataDir}，端口 ${port}（只监听 127.0.0.1）`);
}

function stopCluster() {
  assert.ok(basename(dataDir).startsWith('gy-i19-clock-drill-'), `拒绝删除非本脚本创建的目录：${dataDir}`);
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
 * 从 `20-login-roles.sql` 主体里取出**原文**的单句 GRANT/REVOKE（四域 DELETE 授权不在 region 里，
 * 而在文件主体）。只取涉及本演练四域与幂等台账的语句，⛔ 不新增、不改写任何授权文本。
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

/** 一条真实的注销请求行：`requested_at = online_due_at − 7 日`、`backup_due_at = requested_at + 30 日`。 */
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
  return { requestId, requestedAt, backupDueAt: shift(requestedAt, 30 * DAY_MS) };
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

/** 一行=一个模块一段范围的备份副本清单行（`state` 缺省 pending_purge）。 */
async function insertCopyRow(owner, fields) {
  const objectRefs = fields.objectRefs ?? [randomUUID()];
  const payloadJson = copyPayloadJson({ objectRefs, records: objectRefs.length });
  const digest = copyPayloadDigest(payloadJson);
  const createdAt = fields.createdAt;
  assert.ok(typeof createdAt === 'string', 'insertCopyRow 必须给出 createdAt（水位与 created_at 同值，满足 0023 的 watermark CHECK）');
  await owner.query(
    `INSERT INTO public.user_backup_copies (
       user_id, request_id, module, scope, delete_generation, lineage,
       covered_through, payload, payload_digest, state, retention_until, created_at, updated_at
     ) VALUES ($1::uuid, $2::uuid, $3, $4, 1, 'deletion-manifest/v1',
               $5::timestamptz, $6::jsonb, $7::char(64), $8, $9::timestamptz, $5::timestamptz, $5::timestamptz)`,
    [
      fields.userId,
      fields.requestId,
      fields.module,
      fields.scope,
      createdAt,
      payloadJson,
      digest,
      fields.state ?? 'pending_purge',
      fields.retentionUntil,
    ],
  );
  return digest;
}

const copiesOf = async (owner, requestId) =>
  (
    await owner.query(
      `SELECT module, scope, state, payload, retention_until, purged_at
         FROM public.user_backup_copies
        WHERE request_id = $1::uuid
        ORDER BY module, scope`,
      [requestId],
    )
  ).rows;

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

/** 在线驱动跑一轮（与 CLI 同一条路径：`listDueOnlineDeletions` 取页 → `drainDueOnlineDeletions` 推进）。 */
async function driveOnlineOnce({ cutoff, limit = 10, dryRun = false, purge, after = null, maxBatches = 1 }) {
  return drainDueOnlineDeletions({
    cutoff,
    limit,
    maxBatches,
    dryRun,
    modules: USER_DATA_DELETION_MODULES,
    purge,
    after,
    fetchPage: (pageInput) => listDueOnlineDeletions(ownerClient, pageInput),
  });
}

/** 备份驱动跑一轮（`listDueBackupCopyGroups` 枚举 → `runBackupPurgeBatch` 执行；注入固定 cutoff，不读墙钟）。 */
async function driveBackupOnce(pool, { cutoff, limit = 10, dryRun = false, retryFailed = false } = {}) {
  const { groups, totalDue, mixedGroups } = await listDueBackupCopyGroups(pool, { cutoff, limit });
  const port = createPostgresBackupPurgePort({ pool, now: () => new Date(cutoff) });
  const report = await runBackupPurgeBatch({
    cutoff,
    groups,
    limit,
    totalDue,
    mixedGroups,
    retryFailed,
    dryRun,
    purge: (input) => port.purge(input),
  });
  return { groups, totalDue, mixedGroups, report };
}

// ---------------------------------------------------------------------------
let owner; // 库属主 client（造数 + 在线候选枚举）
let ownerClient = null; // 在线驱动的 fetchPage 用属主身份读 deletion_requests（运行时读不了，第 48 项）
let runtimePool; // 运行时角色池（真清数据用）

try {
  await startCluster();
  const admin = await connectWithRetry(`${adminBase}/postgres`);
  await admin.query('DROP DATABASE IF EXISTS ' + DB_NAME);
  await admin.query('CREATE DATABASE ' + DB_NAME);
  await admin.end();

  owner = await connectWithRetry(targetUrl);
  ownerClient = owner;
  note(`PostgreSQL ${(await owner.query('SHOW server_version')).rows[0].server_version}`);

  // ---- 迁移：全部既有迁移（0001..00xx，含 0003/0016/0023/0031），与出厂顺序一致 ----
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
  note(`已执行 20-login-roles.sql 的 4 个 region + 主体里涉及四域的 ${domainGrants.length} 条 GRANT/REVOKE`);

  const runtimeDsn = `postgresql://${runtimeRole}:${password}@127.0.0.1:${port}/${DB_NAME}`;
  runtimePool = new pg.Pool({ connectionString: runtimeDsn, max: 4 });

  // 权限面（最小自证）：运行时角色必须真的能删四域、能列级读备份清单 —— 这是「真实执行」的前提。
  const privilege = (
    await runtimePool.query(
      `SELECT has_table_privilege(current_user, 'public.favorites', 'DELETE') AS favorites_delete,
              has_table_privilege(current_user, 'public.history', 'DELETE') AS history_delete,
              has_table_privilege(current_user, 'public.messages', 'DELETE') AS messages_delete,
              has_table_privilege(current_user, 'public.conversations', 'DELETE') AS conversations_delete`,
    )
  ).rows[0];
  assert.equal(privilege.favorites_delete, true, '运行时角色必须已有 favorites 的 DELETE');
  assert.equal(privilege.history_delete, true, '运行时角色必须已有 history 的 DELETE');
  assert.equal(privilege.messages_delete, true, '运行时角色必须已有 messages 的 DELETE');
  assert.equal(privilege.conversations_delete, true, '运行时角色必须已有 conversations 的 DELETE');
  say('PG·权限前提：运行时角色四域 DELETE 齐备（真实执行的前提，零新增授权）');

  // =========================================================================
  // 加速时钟演练：一个人、一次受理、四域在线行 + 四份备份副本，把时钟从第 7 日推到第 30 日
  // =========================================================================
  const userId = await insertUser(owner);
  const { requestId, requestedAt, backupDueAt } = await insertDeletionRequest(owner, { userId, onlineDueAt: ONLINE_DUE });
  await seedDomainRows(owner, userId);
  for (const module of USER_DATA_DELETION_MODULES) {
    await insertCopyRow(owner, {
      userId,
      requestId,
      module,
      scope: module === 'conversations' ? 'conversation' : module === 'history' ? 'history' : module === 'messages' ? 'message' : 'favorite',
      createdAt: requestedAt,
      retentionUntil: backupDueAt,
    });
  }
  note(`造数：requested_at=${requestedAt} online_due_at=${ONLINE_DUE} backup_due_at=${backupDueAt}`);

  // ---- 在线未到期：cutoff = 第 7 日 − 1ms ⇒ 四域一行不动 ----
  const onlineBefore = await driveOnlineOnce({ cutoff: shift(ONLINE_DUE, -1), purge: fourDomainPort(runtimePool) });
  assert.equal(onlineBefore.rowsPurged, 0, `差 1ms 到第 7 日 ⇒ 0 行删除（实际 ${onlineBefore.rowsPurged}）`);
  assert.deepEqual(
    await domainRowCounts(owner, userId),
    { favorites: 1, history: 1, messages: 1, conversations: 1 },
    '差 1ms 到第 7 日：四域行必须原样',
  );
  say('PG·在线未到期：cutoff=online_due_at−1ms ⇒ 0 行删除、四域各 1 行原样');

  // ---- 在线刚好到期：cutoff = 第 7 日 ⇒ 四域全删（闭区间） ----
  const onlineDue = await driveOnlineOnce({ cutoff: ONLINE_DUE, purge: fourDomainPort(runtimePool) });
  assert.equal(onlineDue.succeeded, 1, '第 7 日当天必须处理 1 个请求');
  assert.equal(onlineDue.rowsPurged, 4, '四域各 1 行 ⇒ 删 4 行');
  assert.equal(onlineDue.failed, 0);
  assert.deepEqual(
    await domainRowCounts(owner, userId),
    { favorites: 0, history: 0, messages: 0, conversations: 0 },
    '第 7 日当天：四域行必须全删（真实 7 日在线执行落地）',
  );
  say('PG·在线到期：cutoff=online_due_at（第 7 日）⇒ 四域 4 行真的被删');

  // ---- 时序钉死：第 7 日当天，备份副本仍 pending（30 日未到，⛔ 不得提前清） ----
  const backupAtOnlineDue = await driveBackupOnce(runtimePool, { cutoff: ONLINE_DUE });
  assert.equal(backupAtOnlineDue.groups.length, 0, '第 7 日当天备份副本尚未到期（0 组）');
  assert.equal((await copiesOf(owner, requestId)).every((row) => row.state === 'pending_purge'), true, '第 7 日当天备份副本必须仍 pending_purge');
  say('PG·时序：第 7 日在线已清、备份副本仍 pending_purge（30 日未到不提前清）');

  // ---- 备份未到期：cutoff = 第 30 日 − 1ms ⇒ 备份副本一行不动 ----
  const backupBefore = await driveBackupOnce(runtimePool, { cutoff: shift(backupDueAt, -1) });
  assert.equal(backupBefore.groups.length, 0, `差 1ms 到第 30 日 ⇒ 0 组到期（实际 ${backupBefore.groups.length}）`);
  assert.equal((await copiesOf(owner, requestId)).every((row) => row.state === 'pending_purge'), true, '差 1ms 到第 30 日：备份副本必须原样');
  say('PG·备份未到期：cutoff=backup_due_at−1ms ⇒ 0 组、副本行原样 pending_purge');

  // ---- 备份刚好到期：cutoff = 第 30 日 ⇒ 备份副本全清（闭区间） ----
  const backupDue = await driveBackupOnce(runtimePool, { cutoff: backupDueAt });
  assert.equal(backupDue.groups.length, 4, '第 30 日当天必须枚举到 4 个模块组');
  assert.equal(backupDue.report.succeeded, 4, '四份副本全部置 purged');
  assert.equal(backupDue.report.failed, 0);
  assert.equal(backupDue.report.rowsPurged, 4);
  const purgedCopies = await copiesOf(owner, requestId);
  assert.equal(purgedCopies.length, 4);
  assert.equal(purgedCopies.every((row) => row.state === 'purged'), true, '第 30 日当天：四份副本必须置 purged');
  assert.equal(purgedCopies.every((row) => row.payload === null), true, 'purged 行 payload 必须为 jsonb null（内容真的没了）');
  assert.equal(purgedCopies.every((row) => row.purged_at !== null), true);
  say('PG·备份到期：cutoff=backup_due_at（第 30 日）⇒ 四份副本 purged、payload=null');

  console.log(`\nRESULT=PASS ${passed} 组；PostgreSQL ${(await owner.query('SHOW server_version')).rows[0].server_version}（本机隔离、仅回环）；7/30 日「加速时钟」演练三态：通过（exit 0）`);
} finally {
  await runtimePool?.end().catch(() => {});
  await owner?.end().catch(() => {});
  try {
    if (existsSync(serverLog)) {
      const tail = readFileSync(serverLog, 'utf8').split(/\r?\n/).slice(-8).join('\n');
      if (tail.trim().length > 0) note(`工具日志尾（${serverLog}）：\n${tail}`);
    }
    stopCluster();
    console.log('CLEANUP=done（临时集群已停、数据目录已删；未触碰工作树与既有库）');
  } catch (cleanupError) {
    console.error(`CLEANUP=FAILED：${cleanupError.message}`);
    throw cleanupError;
  }
}
