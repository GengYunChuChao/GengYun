// GY-I19（#19）· 备份副本 30 日到期清除**驱动** · 真实 PostgreSQL 17 集成证据
//
// 运行（自起自停的临时集群，只走 127.0.0.1；本片不用 55436）：
//   $env:GY_PG_BIN = 'E:\GengYunCommander\.pg17\pgsql\bin'        # 必填：含 initdb/pg_ctl 的目录
//   $env:GY_I19_PG_ROOT = 'E:\GengYunCommander\.pg17\tmp'         # 选填：数据目录根（默认 os.tmpdir()）
//   node tests/integration/backup-copies-purge-pg.mjs
// 未设置 `GY_PG_BIN` ⇒ 打印 SKIP 并以 **77** 退出（POSIX「skipped」）：没有 PG 二进制就如实跳过，不伪造 PASS。
//   本机明知没有 PG 二进制、只想看跳过原因时可显式加 `--allow-skip`（或 `GY_ALLOW_SKIP=1`）取 0 —— ⛔ 不得用于门禁。
//
// 本脚本自证的是「P0-4 的执行者真的在真库上跑得通」，逐臂（编号即 PASS 序号）：
//   [1] 权限形状：运行时角色对 `user_backup_copies` **只有列级**权限（表级 SELECT/INSERT/UPDATE=false、
//       payload 列不可读、DELETE ⇒ 42501）⇒ 本驱动**不需要新增任何授权**
//       （`20-login-roles.sql` / `allow_table_dml` / `expected(tbl,…,del)` 三处一处都不用改）；
//   [2] 到期扫描（注入固定 cutoff，不依赖墙钟）：恰好等于 cutoff 与早 1 秒的组进集合，晚 1 秒的组不进；
//   [3] 成功行：`state='purged'` + `payload='null'` + `purged_at=cutoff` + 证据摘要可由
//       `payload_digest` **独立复算**（`purgeEvidenceRef()`，逐字相等）；晚 1 秒组 payload 原样；
//   [4] 批量上限：limit=2 时只清 2 组（按到期先后），剩余组原样留给下一轮；
//   [5] 真实端口的失败留痕：把「部分到期」的组交给端口 ⇒ blocked，行置 `failed`
//       （`last_error_code='EVIDENCE_REQUIRED'`、`purge_attempts+1`），未到期行 payload 仍在；
//   [6] 失败不阻塞：一组注入 blocked（退出码 1），同批的另一组照常清成 purged；
//   [7] 部分到期：该组**不进待清集合**（不误清、不误标），但 `mixedGroups` 如实上报、退出码 1；
//   [8] failed 行默认口径：扫描看得见、本轮不清（payload 仍在、purge_attempts 不变）、退出码 1；
//   [9] `--retry-failed`：failed 行改回 `pending_purge` 后清成功，`last_error_code`/`purge_attempts` 保留；
//  [10] 幂等重跑：再跑一次 0 组 / 0 行，已清行的 `purged_at`/`purge_attempts`/`evidence_ref` 逐行不变；
//  [11] 边界外：`deletion_requests` / `users` 一行不改（本驱动不碰回执与受理状态）；
//  [12] CLI `--dry-run`：看得到到期组但一行未清（status 仍 pending_purge、payload 原样），exit=0；
//  [13] CLI 端到端：`node tools/purge-expired-backup-copies.mjs --limit 50` 在真库上真清（exit=0），
//       未到期行原样；
//  [14] CLI 幂等：第二次运行 exit=0 且打印「没有到期的备份副本行」（0 组）。
//
// 时钟口径：边界与上限臂**注入**固定 cutoff（`2026-10-21T00:00:00.000Z`），因为墙钟会走；
// CLI 臂用库自己的 `now()`（那是产线真实路径：`SELECT now()` 只取一次，见驱动模块注释）。
// 形状说明：「部分到期」的组是本脚本**构造**出来的畸形形状（产线不应出现：同一受理的所有副本行
// `retention_until` 恒等于 `backup_due_at`），验证完即由脚本清理，避免后面的「0 组 / exit=0」读数被它污染。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { copyPayloadDigest, copyPayloadJson, purgeEvidenceRef } from '../../packages/privacy/backup-copies.mjs';
import { createPostgresBackupPurgePort } from '../../services/api/src/privacy/backup-copies-pg.ts';
import {
  backupPurgeExitCode,
  formatBackupPurgeReport,
  listDueBackupCopyGroups,
  requeueFailedBackupCopyGroup,
  runBackupPurgeBatch,
} from '../../services/api/src/privacy/backup-purge-driver.ts';

const binDir = process.env.GY_PG_BIN ?? '';
const ALLOW_SKIP = process.argv.includes('--allow-skip') || process.env.GY_ALLOW_SKIP === '1';
if (binDir === '') {
  console.log('SKIP: 未设置 GY_PG_BIN（postgres 二进制目录，含 initdb/pg_ctl）⇒ 真库臂跳过，没有验证备份副本到期驱动（未取得，不是通过）。');
  if (ALLOW_SKIP) {
    console.log('EXITCODE=0（--allow-skip / GY_ALLOW_SKIP=1 已显式授权：仅本机开发，⛔ 不得接进门禁）。');
    process.exit(0);
  }
  console.log('EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本机明知没有 PG 二进制时可显式加 --allow-skip 取 0）。');
  process.exit(77);
}

const DAY_MS = 86_400_000;
const SECOND_MS = 1000;
const CUTOFF = '2026-10-21T00:00:00.000Z';
const DB_NAME = 'gengyun_backup_purge_driver_test';
const DRIVER_TOOL = new URL('../../tools/purge-expired-backup-copies.mjs', import.meta.url);
const driverPath = fileURLToPath(DRIVER_TOOL);
const serverLog = process.env.GY_I19_PG_LOG ?? join(tmpdir(), `gy-i19-purge-pg-${randomBytes(3).toString('hex')}.log`);
const cliLog = join(tmpdir(), `gy-i19-purge-cli-${randomBytes(3).toString('hex')}.log`);

const migrationsDir = new URL('../../services/api/db/migrations/', import.meta.url);
const sqlFile = (path) => readFileSync(new URL(`../../services/api/db/${path}`, import.meta.url), 'utf8');
const deploySqlFile = (name) => readFileSync(new URL(`../../deploy/postgres-cvm/sql/${name}`, import.meta.url), 'utf8');

let passed = 0;
const say = (label) => {
  passed += 1;
  console.log(`PASS ${passed}: ${label}`);
  return passed;
};
const note = (line) => console.log(`  - ${line}`);

// ---------------------------------------------------------------------------
// 临时集群（数据目录与端口都随机；端口取 556xx，避开本机既有 5432/55436）
//
// 端口先**探活**再 initdb：同机可能同时跑着别人的临时集群（本片开发时就撞到过 55613
// 已被占用 ⇒ `could not create any TCP/IP sockets`），随机端口不能假设一定空闲。
// ---------------------------------------------------------------------------
const rootDir = process.env.GY_I19_PG_ROOT ?? tmpdir();
const dataDir = join(rootDir, `gy-i19-purge-pg-${randomBytes(4).toString('hex')}`);
let port = 0;
let adminBase = '';
let targetUrl = '';
const tool = (name) => join(binDir, process.platform === 'win32' ? `${name}.exe` : name);

/** 端口空闲？（只探 127.0.0.1：集群也只监听回环） */
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
    const candidate = 55600 + randomInt(0, 300);
    if (await portIsFree(candidate)) return candidate;
  }
  throw new Error('556xx 区间内找不到空闲端口（同机临时集群过多）');
}

/**
 * 子进程统一把 stdout/stderr 重定向到**文件**：本机 sandbox 禁止命名管道，
 * 用管道收集 postgres/pg_ctl（以及 CLI 自己）的输出会让调用方等 EOF 等到超时。
 */
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

/** `pg_ctl -o` 的 postgres 参数（POSIX 上必须把 socket 指到本集群自己的数据目录，理由同 `backup-purge-pg.mjs:110-120`）。 */
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
  assert.ok(basename(dataDir).startsWith('gy-i19-purge-pg-'), `拒绝删除非本脚本创建的目录：${dataDir}`);
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

// ---------------------------------------------------------------------------
// 造数（全部由**库属主**写入：运行时角色只需要驱动用到的那几列）
// ---------------------------------------------------------------------------
const shift = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();

/** 一行=一个模块一段范围的副本清单行；`state` 缺省 pending_purge。 */
async function insertCopyRow(owner, fields) {
  const objectRefs = fields.objectRefs ?? [randomUUID()];
  const payloadJson = copyPayloadJson({ objectRefs, records: objectRefs.length });
  const digest = copyPayloadDigest(payloadJson);
  const createdAt = fields.createdAt;
  assert.ok(typeof createdAt === 'string', 'insertCopyRow 必须给出 createdAt（水位与 created_at 同值，满足 0023 的 watermark/retention CHECK）');
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

/**
 * 一个真实的注销请求行（`user_backup_copies.request_id` 是 RESTRICT 外键，必须真有受理）。
 *
 * 期限关系照 `0003` 的 `deletion_requests_due_order`（`backup_due_at >= online_due_at >= requested_at`）反推：
 * `requested_at = backup_due_at − 30 日`、`online_due_at = requested_at + 7 日`。
 */
async function insertDeletionRequest(owner, { userId, backupDueAt }) {
  const requestId = randomUUID();
  const requestedAt = shift(backupDueAt, -30 * DAY_MS);
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
      shift(requestedAt, 7 * DAY_MS),
      backupDueAt,
      shift(requestedAt, 35 * DAY_MS),
    ],
  );
  return { requestId, requestedAt };
}

/** 造一个「一个人 + 一次受理 + 若干模块行」的完整三元组。 */
async function makeGroup(owner, { module = 'favorites', scope = 'favorite', retentionUntil, state }) {
  const userId = randomUUID();
  await owner.query('INSERT INTO users (id) VALUES ($1::uuid)', [userId]);
  const { requestId, requestedAt } = await insertDeletionRequest(owner, { userId, backupDueAt: retentionUntil });
  await insertCopyRow(owner, {
    userId,
    requestId,
    module,
    scope,
    createdAt: requestedAt,
    retentionUntil,
    state,
  });
  return { userId, requestId, module, scope, retentionUntil, requestedAt };
}

const copiesOf = async (owner, requestId) =>
  (
    await owner.query(
      `SELECT module, scope, state, payload, payload_digest, retention_until, purged_at, evidence_ref,
              last_error_code, purge_attempts
         FROM public.user_backup_copies
        WHERE request_id = $1::uuid
        ORDER BY module, scope`,
      [requestId],
    )
  ).rows;

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

/** 以运行时角色跑一次驱动的「枚举 + 执行」（注入固定 cutoff，不依赖墙钟）。 */
async function driveOnce(pool, { limit, retryFailed, dryRun, cutoff = CUTOFF, purgeOverride } = {}) {
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
    purge: (input) => (purgeOverride === undefined ? port.purge(input) : purgeOverride(input, port)),
    requeue: ({ requestId, userId, module }) => requeueFailedBackupCopyGroup(pool, { requestId, userId, module, cutoff }),
  });
  return { groups, totalDue, mixedGroups, report };
}

// ---------------------------------------------------------------------------
let owner;
let pool;
let runtimeDsn;

try {
  await startCluster();
  const admin = await connectWithRetry(`${adminBase}/postgres`);
  await admin.query('DROP DATABASE IF EXISTS ' + DB_NAME);
  await admin.query('CREATE DATABASE ' + DB_NAME);
  await admin.end();

  owner = await connectWithRetry(targetUrl);
  const version = (await owner.query('SHOW server_version')).rows[0].server_version;
  note(`PostgreSQL ${version}`);

  // ---- 迁移：全部既有迁移（0001..0026，含 0023），与出厂顺序一致 ----
  const discovered = readdirSync(migrationsDir).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  assert.ok(discovered.includes('0023_user_backup_copies.sql'), '迁移清单必须含 0023');
  for (const name of discovered) await owner.query(readFileSync(new URL(name, migrationsDir), 'utf8'));
  note(`迁移已应用：${discovered.length} 个（${discovered[0]} … ${discovered.at(-1)}）`);

  // ---- 角色与授权：与出厂 provisioning 同形（只跑本片相关的那一个区域） ----
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
  const matched = deploySqlFile('20-login-roles.sql').match(
    /-- #region gy-i19-backup-copies-grant\r?\n([\s\S]*?)\r?\n\s*-- #endregion gy-i19-backup-copies-grant/,
  );
  assert.ok(matched !== null, '20-login-roles.sql 必须含 gy-i19-backup-copies-grant 区域');
  assert.equal(/\\(echo|set|pset|if|endif|getenv|gexec)/.test(matched[1]), false, '该区域不得含 psql 元命令');
  await owner.query(matched[1]);
  note('已执行 20-login-roles.sql 的 gy-i19-backup-copies-grant 区域（列级 SELECT/INSERT/UPDATE；无表级 DML、无 DELETE）');

  runtimeDsn = `postgresql://${runtimeRole}:${password}@127.0.0.1:${port}/${DB_NAME}`;
  pool = new pg.Pool({ connectionString: runtimeDsn, max: 4 });

  // -------------------------------------------------------------------------
  // [1] 权限形状：驱动**不需要**新授权
  // -------------------------------------------------------------------------
  const privilege = (
    await pool.query(
      `SELECT has_table_privilege(current_user, 'public.user_backup_copies', 'SELECT') AS table_select,
              has_table_privilege(current_user, 'public.user_backup_copies', 'INSERT') AS table_insert,
              has_table_privilege(current_user, 'public.user_backup_copies', 'UPDATE') AS table_update,
              has_any_column_privilege(current_user, 'public.user_backup_copies', 'SELECT') AS any_column_select,
              has_column_privilege(current_user, 'public.user_backup_copies', 'state', 'UPDATE') AS state_update,
              has_column_privilege(current_user, 'public.user_backup_copies', 'payload', 'SELECT') AS payload_select`,
    )
  ).rows[0];
  assert.equal(privilege.table_select, false, '运行时角色不得有表级 SELECT');
  assert.equal(privilege.table_insert, false, '运行时角色不得有表级 INSERT');
  assert.equal(privilege.table_update, false, '运行时角色不得有表级 UPDATE');
  assert.equal(privilege.any_column_select, true, '驱动器读到期组只需要列级 SELECT');
  assert.equal(privilege.state_update, true, '显式重排用的 state 列必须在既有 UPDATE 授权里');
  assert.equal(privilege.payload_select, false, 'payload 列不可读（驱动压根不读正文）');
  await expectSqlState(pool, '运行时直接 DELETE 清单行', 'DELETE FROM public.user_backup_copies', [], '42501');
  say('权限形状：运行时角色只有列级 SELECT/UPDATE（表级 DML=false、payload 不可读、DELETE=42501）⇒ 本驱动零新增授权');

  // -------------------------------------------------------------------------
  // [2]/[3] 到期边界 + 成功行形状（注入固定 cutoff）
  // -------------------------------------------------------------------------
  const exact = await makeGroup(owner, { retentionUntil: CUTOFF }); // 恰好等于 cutoff
  const early = await makeGroup(owner, { retentionUntil: shift(CUTOFF, -SECOND_MS), module: 'history', scope: 'history' }); // 早 1 秒
  const late = await makeGroup(owner, { retentionUntil: shift(CUTOFF, SECOND_MS) }); // 晚 1 秒

  const scan = await listDueBackupCopyGroups(pool, { cutoff: CUTOFF });
  const scannedRequests = scan.groups.map((group) => group.requestId).sort();
  assert.deepEqual(
    scannedRequests,
    [exact.requestId, early.requestId].sort(),
    '到期扫描：等于 cutoff 与早 1 秒的组都要进来，晚 1 秒的组**不得**进来',
  );
  assert.equal(scan.totalDue, 2);
  say(`到期扫描（cutoff=${CUTOFF}）：取到 2 组（恰好等于 cutoff、早 1 秒），晚 1 秒的组不在集合内；total_due=2`);

  const boundary = await driveOnce(pool, { cutoff: CUTOFF });
  assert.equal(boundary.report.succeeded, 2);
  assert.equal(boundary.report.failed, 0);
  assert.equal(boundary.report.rowsPurged, 2);
  for (const target of [exact, early]) {
    const [row] = await copiesOf(owner, target.requestId);
    assert.equal(row.state, 'purged', `${target.module} 到期必须清`);
    assert.equal(row.payload, null, 'payload 必须置 jsonb null（内容真的没了）');
    assert.equal(row.purged_at.toISOString(), CUTOFF, 'purged_at 必须是本次 cutoff（注入时钟逐字落库）');
    assert.match(row.evidence_ref, /^sha256:[0-9a-f]{64}$/);
    assert.equal(
      row.evidence_ref,
      purgeEvidenceRef({ requestId: target.requestId, module: row.module, payloadDigests: [row.payload_digest] }),
      '证据摘要必须能由 payload_digest 独立复算（逐字相等）',
    );
    assert.equal(row.purge_attempts, 0);
  }
  const [lateRow] = await copiesOf(owner, late.requestId);
  assert.equal(lateRow.state, 'pending_purge', '晚 1 秒的组**不得**被提前清');
  assert.notEqual(lateRow.payload, null, '未到期行的 payload 必须原样保留');
  assert.equal(lateRow.purged_at, null);
  assert.equal(lateRow.evidence_ref, null);
  say('到期清除：2 组 purged（payload=null、purged_at=cutoff、证据由 payload_digest 独立复算相等）；晚 1 秒组仍 pending_purge 且 payload 原样');

  // -------------------------------------------------------------------------
  // [4] 批量上限
  // -------------------------------------------------------------------------
  const dueGroups = [];
  for (let index = 0; index < 3; index += 1) {
    // 越靠前的组越早到期：SQL 按 `due_at` 升序取，因此「先到期的先处理」可用下标断言。
    dueGroups.push(await makeGroup(owner, { retentionUntil: shift(CUTOFF, -DAY_MS * (3 - index)) }));
  }
  const batch1 = await driveOnce(pool, { cutoff: CUTOFF, limit: 2 });
  assert.equal(batch1.report.processed, 2);
  assert.equal(batch1.report.succeeded, 2);
  assert.equal(batch1.report.remaining, batch1.report.totalDue - 2);
  const afterBatch1 = [];
  for (const target of dueGroups) afterBatch1.push((await copiesOf(owner, target.requestId))[0].state);
  assert.deepEqual(afterBatch1, ['purged', 'purged', 'pending_purge'], 'limit=2 ⇒ 只剩第三组没处理');
  const batch2 = await driveOnce(pool, { cutoff: CUTOFF, limit: 2 });
  assert.equal(batch2.report.succeeded, 1, '第二轮把剩下的那一组清掉');
  assert.equal((await copiesOf(owner, dueGroups[2].requestId))[0].state, 'purged');
  say('批量上限：limit=2 时第一批只清 2 组（剩余 1 组仍 pending_purge），第二批清掉最后 1 组');

  // -------------------------------------------------------------------------
  // [5] 失败不阻塞（注入单组失败）+ 真实端口的 failed 留痕
  // -------------------------------------------------------------------------
  const keeper = await makeGroup(owner, { retentionUntil: shift(CUTOFF, -DAY_MS * 2) });
  const poisoned = await makeGroup(owner, { retentionUntil: shift(CUTOFF, -DAY_MS * 2), module: 'history', scope: 'history' });
  const mixed = await makeGroup(owner, { retentionUntil: shift(CUTOFF, -DAY_MS * 2) });
  // 让 mixed 变成「部分到期」：同组再插一行未到期（真实形状：写入错位/时钟漂移）。
  await insertCopyRow(owner, {
    userId: mixed.userId,
    requestId: mixed.requestId,
    module: mixed.module,
    scope: 'favorite_extra',
    createdAt: mixed.requestedAt,
    retentionUntil: shift(CUTOFF, DAY_MS),
  });

  const poisonPort = createPostgresBackupPurgePort({ pool, now: () => new Date(CUTOFF) });
  const mixedExpectedBlocked = await poisonPort.purge({ userId: mixed.userId, module: mixed.module, requestId: mixed.requestId });
  assert.equal(mixedExpectedBlocked.outcome, 'blocked', '部分到期的组**不得**报完成');
  const mixedRows = await copiesOf(owner, mixed.requestId);
  assert.equal(mixedRows.some((row) => row.state === 'failed'), true, '清不掉必须留 failed 行');
  const failedRow = mixedRows.find((row) => row.state === 'failed');
  assert.equal(failedRow.last_error_code, 'EVIDENCE_REQUIRED');
  assert.equal(failedRow.purge_attempts, 1, '失败必须 purge_attempts+1');
  say(`真实端口的失败留痕：部分到期的组 ⇒ blocked，行置 failed（last_error_code=${failedRow.last_error_code}、purge_attempts=1），未到期行 payload 仍在`);

  const nonBlocking = await driveOnce(pool, {
    cutoff: CUTOFF,
    purgeOverride: async (input, port) => {
      if (input.requestId === poisoned.requestId) {
        return { purged: false, outcome: 'blocked', errorCode: 'STORE_UNREACHABLE', reason: '注入的单组失败（只替换这一组的端口返回值）' };
      }
      return port.purge(input);
    },
  });
  assert.equal(nonBlocking.report.failed, 1, '注入失败的那一组必须计入失败');
  assert.equal((await copiesOf(owner, poisoned.requestId))[0].state, 'pending_purge', '注入组本轮没清（如实）');
  assert.equal((await copiesOf(owner, keeper.requestId))[0].state, 'purged', '失败不得阻塞后面的组');
  assert.equal(backupPurgeExitCode(nonBlocking.report), 1);
  note(`失败不阻塞的那一轮读数：处理 ${nonBlocking.report.processed} 组 / 成功 ${nonBlocking.report.succeeded} / 跳过 ${nonBlocking.report.skipped} / 失败 ${nonBlocking.report.failed}`);
  say('失败不阻塞：一组注入 blocked（退出码 1），同批的另一组照常清成 purged');

  // 「部分到期」的组不进待清集合（⛔ 不误清未到期行），但必须被计数上报。
  const mixedScan = await driveOnce(pool, { cutoff: CUTOFF });
  assert.equal(
    mixedScan.groups.some((group) => group.requestId === mixed.requestId),
    false,
    '部分到期的组不得进入待清集合（否则端口会回滚并把未到期行误标 failed）',
  );
  assert.equal(mixedScan.report.mixedGroups, 1, '部分到期的组数必须如实上报（不清 ≠ 看不见）');
  assert.equal(backupPurgeExitCode(mixedScan.report), 1, '存在部分到期的组 ⇒ 退出码 1（需人工处置）');
  say(`部分到期：mixed 组不进待清集合、mixedGroups=${mixedScan.report.mixedGroups}、退出码 1（只上报不处理）`);

  // 本脚本构造的畸形形状到此为止：清掉它，好让后面的「幂等 0 组 / CLI exit=0」读数不被这条永久 1 污染。
  // （产线不应出现该形状：同一受理的所有副本行 retention_until 恒等于 backup_due_at。）
  await owner.query('DELETE FROM public.user_backup_copies WHERE request_id = $1::uuid', [mixed.requestId]);
  await owner.query('DELETE FROM public.deletion_requests WHERE id = $1::uuid', [mixed.requestId]);
  note('已清理本脚本构造的「部分到期」组（仅测试库；产线不应出现这种形状）');

  // -------------------------------------------------------------------------
  // [6] failed 行：默认跳过 → --retry-failed 重排后清成功
  // -------------------------------------------------------------------------
  const retryTarget = await makeGroup(owner, { retentionUntil: shift(CUTOFF, -DAY_MS * 3) });
  await owner.query(
    `UPDATE public.user_backup_copies
        SET state = 'failed', last_error_code = 'STORE_UNREACHABLE', purge_attempts = 2, updated_at = now()
      WHERE request_id = $1::uuid`,
    [retryTarget.requestId],
  );

  const skipFailed = await driveOnce(pool, { cutoff: CUTOFF });
  const failingGroup = skipFailed.groups.find((group) => group.requestId === retryTarget.requestId);
  assert.ok(failingGroup !== undefined, '有 failed 行的组仍要被扫描到（否则运维永远看不到它）');
  assert.equal(failingGroup.failedRows, 1);
  const [stillFailed] = await copiesOf(owner, retryTarget.requestId);
  assert.equal(stillFailed.state, 'failed', '默认口径不重试 failed 行');
  assert.notEqual(stillFailed.payload, null);
  assert.equal(stillFailed.purge_attempts, 2);
  assert.equal(backupPurgeExitCode(skipFailed.report), 1, '存在 failed 行 ⇒ 退出码 1（不是干净）');
  say('failed 行默认口径：扫描能看到该组，但本轮不清（state 仍 failed、payload 仍在、purge_attempts 不变），退出码 1');

  const retryRun = await driveOnce(pool, { cutoff: CUTOFF, retryFailed: true });
  assert.equal(retryRun.report.requeued, 1, '显式重排必须真的改回 pending_purge');
  const [afterRetry] = await copiesOf(owner, retryTarget.requestId);
  assert.equal(afterRetry.state, 'purged', '重排后本轮必须清成功');
  assert.equal(afterRetry.payload, null);
  assert.equal(afterRetry.last_error_code, 'STORE_UNREACHABLE', '上一轮失败原因作为留痕保留（不擦掉）');
  assert.equal(afterRetry.purge_attempts, 2, '重排不重置尝试次数');
  say('--retry-failed：failed 行改回 pending_purge 后清成功（payload=null），last_error_code/purge_attempts 作为留痕保留');

  // -------------------------------------------------------------------------
  // [7] 幂等重跑
  // -------------------------------------------------------------------------
  const beforeRerun = await owner.query(
    `SELECT request_id, module, scope, state, purged_at, purge_attempts, evidence_ref
       FROM public.user_backup_copies WHERE state = 'purged' ORDER BY request_id, module, scope`,
  );
  const rerun = await driveOnce(pool, { cutoff: CUTOFF });
  assert.equal(rerun.report.candidates, 0, `到期集合必须已空（实际 ${rerun.report.candidates} 组）`);
  assert.equal(rerun.report.processed, 0);
  assert.equal(rerun.report.succeeded, 0);
  assert.equal(rerun.report.remaining, 0);
  assert.equal(backupPurgeExitCode(rerun.report), 0, '0 组可做也算干净（退出码 0）');
  const afterRerun = await owner.query(
    `SELECT request_id, module, scope, state, purged_at, purge_attempts, evidence_ref
       FROM public.user_backup_copies WHERE state = 'purged' ORDER BY request_id, module, scope`,
  );
  assert.deepEqual(afterRerun.rows, beforeRerun.rows, '重跑不得改写 purged_at/purge_attempts/evidence_ref');
  note(`幂等重跑的读数：candidates=${rerun.report.candidates} processed=${rerun.report.processed} failed=${rerun.report.failed} remaining=${rerun.report.remaining}`);
  say(`幂等重跑：第二次运行 0 组 / 0 行（已清 ${afterRerun.rows.length} 行的 purged_at/purge_attempts/evidence_ref 逐行不变），退出码 0`);

  // -------------------------------------------------------------------------
  // [8] 边界外：受理与账号行一行不改
  // -------------------------------------------------------------------------
  const untouched = await owner.query(
    `SELECT (SELECT count(*)::int FROM public.deletion_requests) AS requests,
            (SELECT count(*)::int FROM public.users) AS users,
            (SELECT count(*)::int FROM public.deletion_requests WHERE state <> 'requested') AS advanced`,
  );
  assert.equal(untouched.rows[0].advanced, 0, '本驱动不改写任何受理状态');
  assert.ok(untouched.rows[0].requests > 0 && untouched.rows[0].users > 0);
  say(`边界外：deletion_requests(${untouched.rows[0].requests} 行) 与 users(${untouched.rows[0].users} 行) 未被驱动改写（state 全部仍是 requested）`);

  // -------------------------------------------------------------------------
  // [9] CLI 端到端（真 now()，真退出码）
  // -------------------------------------------------------------------------
  const cliTargets = [];
  for (let index = 0; index < 2; index += 1) {
    cliTargets.push(await makeGroup(owner, { retentionUntil: shift(new Date().toISOString(), -DAY_MS * 5) }));
  }
  // 另外造一条明确未到期的行：CLI 跑完必须原样。
  const cliFuture = await makeGroup(owner, { retentionUntil: shift(new Date().toISOString(), DAY_MS * 3) });

  const runCli = (args = []) => {
    const offset = existsSync(cliLog) ? statSync(cliLog).size : 0;
    const fd = openSync(cliLog, 'a');
    try {
      const result = spawnSync(process.execPath, [driverPath, ...args], {
        stdio: ['ignore', fd, fd],
        env: { ...process.env, DATABASE_URL: runtimeDsn },
        timeout: 120_000,
        windowsHide: true,
      });
      return { status: result.status, output: readFileSync(cliLog, 'utf8').slice(offset).trimEnd() };
    } finally {
      closeSync(fd);
    }
  };

  // 先跑 --dry-run：它必须看到到期组、什么都不清。
  const cliDry = runCli(['--dry-run', '--limit', '50']);
  assert.equal(cliDry.status, 0, `--dry-run 必须 exit=0，实际 ${cliDry.status}；输出：\n${cliDry.output}`);
  assert.match(cliDry.output, /dry-run=true/);
  assert.match(cliDry.output, /succeeded=0 .*skipped=[1-9]/);
  for (const target of cliTargets) {
    const [row] = await copiesOf(owner, target.requestId);
    assert.equal(row.state, 'pending_purge', '--dry-run 一行都不许清');
    assert.notEqual(row.payload, null);
  }
  say(`--dry-run：EXITCODE=${cliDry.status}，看到到期组但一行未清（status 仍 pending_purge、payload 原样）`);

  const cliFirst = runCli(['--limit', '50']);
  assert.equal(cliFirst.status, 0, `CLI 首次必须 exit=0，实际 ${cliFirst.status}；输出：\n${cliFirst.output}`);
  assert.match(cliFirst.output, /SUMMARY .*succeeded=[1-9]/);
  for (const target of cliTargets) {
    const [row] = await copiesOf(owner, target.requestId);
    assert.equal(row.state, 'purged', 'CLI 必须真的清掉到期行');
    assert.equal(row.payload, null);
  }
  const [futureRow] = await copiesOf(owner, cliFuture.requestId);
  assert.equal(futureRow.state, 'pending_purge', 'CLI 不得清未到期的行');
  say(`CLI 端到端：node tools/purge-expired-backup-copies.mjs --limit 50 ⇒ EXITCODE=${cliFirst.status}，到期行 purged、未到期行原样`);

  const cliSecond = runCli();
  assert.equal(cliSecond.status, 0, `CLI 第二次必须 exit=0（幂等），实际 ${cliSecond.status}；输出：\n${cliSecond.output}`);
  assert.match(cliSecond.output, /没有到期的备份副本行/);
  note(`CLI 第二次输出尾部：\n${cliSecond.output.split('\n').slice(-3).join('\n')}`);
  say('CLI 幂等：第二次运行 exit=0 且打印「没有到期的备份副本行」（0 组）');

  console.log(`\nALL PASS：${passed} 条真库断言（exit code 0）`);
} finally {
  await pool?.end().catch(() => {});
  await owner?.end().catch(() => {});
  stopCluster();
  rmSync(cliLog, { force: true });
}
