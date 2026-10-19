// GY-I19（#19）· 逐用户备份副本域 · **真实 PostgreSQL 17** 集成证据
//
// 运行（自起自停的临时集群，只走 127.0.0.1）：
//   $env:GY_PG_BIN = 'E:\GengYunCommander\.pg17\pgsql\bin'      # 必填：含 initdb/pg_ctl 的目录
//   $env:GY_I19_PG_ROOT = 'E:\GengYunCommander\.pg17\tmp'       # 选填：数据目录根（默认 os.tmpdir()）
//   node tests/integration/backup-purge-pg.mjs
// 未设置 `GY_PG_BIN` ⇒ 打印 SKIP 并 exit 0（本机/CI 没有 PG 二进制时如实跳过，不伪造 PASS）。
//
// 本脚本自证的**唯一**事情：设计文档里「已定死但没接线」的那三件事在真库上真的接上了——
//   [1] 迁移 0023：表/约束/索引**真的**能建；`apply → rollback → 再 apply` 三连如实出现—消失—出现；
//       CHECK 负例（state/purged 证据/摘要形状/水位倒挂）与 `request_id … ON DELETE RESTRICT` 都是
//       库侧拒绝（`23514`/`23503`），不是应用层口头约定；
//   [2] 写入路径：注销受理的**同一事务**里写清单行（`executeHandlers()` 之前）。0 对象模块也写一行；
//       事务内失败 ⇒ 整笔回滚 ⇒ **202 不签发**（`deletion_requests` 零行、`users.state` 仍是 active）；
//       每行 `retention_until` 与 `deletion_requests.backup_due_at` 逐行相等（设计 §4.4 对账 0 行）；
//   [3] 清除端口：30 天到期后由**请求重放**驱动（R1 的选定触发者），`UPDATE`+**删除后复核**才置
//       `completed`；证据摘要可由行内 `payload_digest` **独立复算**；行**保留**（payload 置 `null`）；
//       重放幂等（不降级 pending、不重复计数）；清不掉 ⇒ `blocked` + 证据码（不是 pending）；
//       没有副本行 ⇒ `blocked` + `EVIDENCE_REQUIRED`（空集不是成功）；
//       非 UUID 主体 ⇒ `PrivacyError('SESSION_REQUIRED')`（先例 `privacy/ledger-pg.ts:540-542`）。
//
// 权限口径（**本片最容易搞错的地方**）：运行时角色 `gengyun_api_runtime` 对 `user_backup_copies`
// 拿到的是**列级** SELECT/INSERT/UPDATE（`roles/auth_privacy.sql` 与
// `deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-i19-backup-copies-grant` 区域各一份），
// ⛔ 没有表级 DML、没有 DELETE —— 因为 `90-assert-least-privilege.sql` 的 `table_dml_allowlist`
// 只允许 `idempotency_keys` 有表级写入。脚本里对这两点都做**实测**（`has_table_privilege` = false、
// `has_any_column_privilege` = true、DELETE 报 `42501`），而不是引用注释。
//
// 时钟：本脚本注入**脚本化时钟**（不是真时钟）。受理函数与 0023 的 CHECK 都不与库侧 `now()` 比较
// （`covered_through <= created_at` 两列同值写入），因此冻结时刻是安全的；所有期限断言写成
// 「与 `backup_due_at` 相等」或「31 天后」的相对推演，不依赖机器时间。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import pg from 'pg';

import { copyPayloadDigest, copyPayloadJson, purgeEvidenceRef } from '../../packages/privacy/backup-copies.mjs';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { RECEIPT_TTL_MS } from '../../services/api/src/privacy/account-deletion.ts';
import { createPostgresBackupPurgePort } from '../../services/api/src/privacy/backup-copies-pg.ts';
import { createPostgresDeletionRequestStore } from '../../services/api/src/privacy/deletion-requests-pg.ts';
import { createUserDataDeletion } from '../../services/api/src/privacy/user-data-deletion.ts';

const binDir = process.env.GY_PG_BIN ?? '';
if (binDir === '') {
  console.log('SKIP: 未设置 GY_PG_BIN（postgres 二进制目录，含 initdb/pg_ctl）⇒ 真库臂跳过，exit 0');
  process.exit(0);
}

const DAY_MS = 86_400_000;
const START = '2026-10-20T00:00:00.000Z';
const DB_NAME = 'gengyun_backup_purge_test';
const COPIES_MIGRATION = '0023_user_backup_copies.sql';
const COPIES_DOWN = 'migrations/rollback/0023_user_backup_copies.down.sql';
const serverLog = process.env.GY_I19_PG_LOG ?? join(tmpdir(), `gy-i19-pg-${randomBytes(3).toString('hex')}.log`);

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
// 临时集群（数据目录与端口都随机；端口取 55500+，避开本机既有 5432）
// ---------------------------------------------------------------------------
const rootDir = process.env.GY_I19_PG_ROOT ?? tmpdir();
const dataDir = join(rootDir, `gy-i19-pg-${randomBytes(4).toString('hex')}`);
const port = 55500 + randomInt(0, 500);
const tool = (name) => join(binDir, process.platform === 'win32' ? `${name}.exe` : name);

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
      timeout: 180_000,
      windowsHide: true,
    });
  } finally {
    closeSync(fd);
  }
}

function startCluster() {
  assert.ok(existsSync(tool('initdb')), `GY_PG_BIN 下没有 initdb：${tool('initdb')}`);
  mkdirSync(dataDir, { recursive: true });
  const init = runTool('initdb', ['-D', dataDir, '--no-sync', '--encoding=UTF8', '--locale=C', '-U', 'postgres', '--auth=trust']);
  assert.equal(init.status, 0, `initdb 失败（status=${init.status}，日志见 ${serverLog}）`);
  const start = runTool('pg_ctl', [
    '-D',
    dataDir,
    '-l',
    join(dataDir, 'server.log'),
    '-o',
    `-p ${port} -c listen_addresses=127.0.0.1 -c max_connections=32`,
    '-w',
    'start',
  ]);
  assert.equal(start.status, 0, `pg_ctl start 失败（status=${start.status}，日志见 ${serverLog}）`);
  note(`临时集群：数据目录 ${dataDir}，端口 ${port}（只监听 127.0.0.1）`);
}

function stopCluster() {
  // 只删本脚本自己建的那个目录（名字前缀硬钉，避免误删工作树/源码）。
  assert.ok(basename(dataDir).startsWith('gy-i19-pg-'), `拒绝删除非本脚本创建的目录：${dataDir}`);
  if (existsSync(join(dataDir, 'PG_VERSION'))) runTool('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10 });
}

const adminBase = `postgresql://postgres@127.0.0.1:${port}`;
const targetUrl = `${adminBase}/${DB_NAME}`;

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
// 时钟 / 造数 / 清单行 helper
// ---------------------------------------------------------------------------
function scriptedClock(startIso) {
  let ms = Date.parse(startIso);
  return {
    now: () => new Date(ms),
    iso: () => new Date(ms).toISOString(),
    advanceDays(days) {
      ms += days * DAY_MS;
    },
  };
}

const seededFavoriteIds = new Map();

async function seedFavorites(store, ownerId, count) {
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID();
    await store.insertFavorite({
      id,
      revision: 1,
      owner_id: ownerId,
      target_ref: { type: 'answer', id: randomUUID(), revision: 1 },
      created_at: START,
    });
    ids.push(id);
  }
  seededFavoriteIds.set(ownerId, ids);
  return ids;
}

async function seedHistory(store, ownerId, count) {
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID();
    await store.insertHistory({
      id,
      revision: 1,
      owner_id: ownerId,
      kind: 'ocr',
      target_ref: { type: 'ocr', id: randomUUID(), revision: 1 },
      job_id: randomUUID(),
      job_state: 'succeeded',
      created_at: START,
      event_key: randomUUID(),
    });
    ids.push(id);
  }
  return ids;
}

/** 以**库属主**身份补一行清单（只用于构造「同模块多范围」「未到期」「已失败」这些真实形状）。 */
async function insertCopyRow(owner, fields) {
  const payloadJson = copyPayloadJson({ objectRefs: fields.objectRefs ?? [], records: (fields.objectRefs ?? []).length });
  const digest = copyPayloadDigest(payloadJson);
  await owner.query(
    `INSERT INTO public.user_backup_copies (
       user_id, request_id, module, scope, delete_generation, lineage,
       covered_through, payload, payload_digest, state, retention_until, created_at, updated_at
     ) VALUES ($1::uuid, $2::uuid, $3, $4, 1, 'deletion-manifest/v1',
               $5::timestamptz, $6::jsonb, $7::char(64), 'pending_purge', $8::timestamptz, $5::timestamptz, $5::timestamptz)`,
    [fields.userId, fields.requestId, fields.module, fields.scope, fields.coveredThrough, payloadJson, digest, fields.retentionUntil],
  );
  return digest;
}

const copiesOf = async (owner, requestId) =>
  (
    await owner.query(
      `SELECT module, scope, state, payload, payload_digest, retention_until, purged_at, evidence_ref,
              last_error_code, purge_attempts, delete_generation, lineage
         FROM public.user_backup_copies
        WHERE request_id = $1::uuid
        ORDER BY module, scope`,
      [requestId],
    )
  ).rows;

const receiptRow = (deletion, requestId) => deletion.receipt(requestId);
const handlerOf = (receipt, module) => receipt.handlers.find((row) => row.module === module);

/** 设计 §4.4 的对账：`retention_until` 与 `backup_due_at` 必须逐行相等（期望 0 行不等）。 */
async function reconciliationRows(owner) {
  const result = await owner.query(
    `SELECT count(*)::int AS n
       FROM public.user_backup_copies c
       JOIN public.deletion_requests r ON r.id = c.request_id
      WHERE c.retention_until <> r.backup_due_at`,
  );
  return Number(result.rows[0].n);
}

async function expectSqlState(owner, label, sql, params, expectedCode) {
  let error;
  try {
    await owner.query(sql, params);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error !== undefined, `${label}：期望库侧拒绝，但语句成功了`);
  assert.equal(error.code, expectedCode, `${label}：SQLSTATE ${error.code}（期望 ${expectedCode}）— ${error.message}`);
}

// ---------------------------------------------------------------------------
let owner;
let pool;

try {
  startCluster();
  const admin = await connectWithRetry(`${adminBase}/postgres`);
  await admin.query('DROP DATABASE IF EXISTS ' + DB_NAME);
  await admin.query('CREATE DATABASE ' + DB_NAME);
  await admin.end();

  owner = await connectWithRetry(targetUrl);
  const version = (await owner.query('SHOW server_version')).rows[0].server_version;
  note(`PostgreSQL ${version}`);

  // [1] 迁移：先建全部既有迁移（0016 的 SECURITY DEFINER 函数是受理的唯一写路径），
  //     再对 0023 做 apply → rollback → 再 apply 三连。
  const discovered = readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  assert.ok(discovered.includes(COPIES_MIGRATION), `迁移清单必须含 ${COPIES_MIGRATION}`);
  for (const name of discovered) {
    if (name === COPIES_MIGRATION) continue;
    await owner.query(readFileSync(new URL(name, migrationsDir), 'utf8'));
  }
  note(`既有迁移（${discovered.length - 1} 个）已应用：${discovered.filter((n) => n !== COPIES_MIGRATION).join(' ')}`);

  const tableExists = async () =>
    (await owner.query("SELECT to_regclass('public.user_backup_copies') AS reg")).rows[0].reg !== null;

  assert.equal(await tableExists(), false, '0023 应用前表必须不存在');
  await owner.query(sqlFile(`migrations/${COPIES_MIGRATION}`));
  assert.equal(await tableExists(), true, '0023 应用后表必须存在');
  const indexes = await owner.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'user_backup_copies' ORDER BY indexname`,
  );
  assert.deepEqual(
    indexes.rows.map((row) => row.indexname),
    ['user_backup_copies_due_idx', 'user_backup_copies_key', 'user_backup_copies_pkey', 'user_backup_copies_subject_idx'],
    '主键 + 三个 designed 索引必须齐全（唯一键 + 主体 + 到期部分索引）',
  );
  await owner.query(sqlFile(COPIES_DOWN));
  assert.equal(await tableExists(), false, '0023 回滚后表必须消失（down 必须能干净回滚）');
  await owner.query(sqlFile(`migrations/${COPIES_MIGRATION}`));
  assert.equal(await tableExists(), true, '0023 再 apply 后表必须重新出现');
  say(`迁移 0023：apply（表 + 3 索引出现）→ rollback（表消失）→ 再 apply（表重现）；索引 = ${indexes.rows.map((r) => r.indexname).join(', ')}`);

  // 角色与授权：与出厂 provisioning 同形（先建 5 个 NOLOGIN 组，再建运行时 LOGIN，再跑两个区域）。
  const roleFiles = [
    'roles/auth_privacy.sql',
    'roles/catalog_readers.sql',
    'roles/consent_granter.sql',
    'roles/profile_runtime.sql',
    'roles/knowledge_runtime.sql',
  ];
  for (const file of roleFiles) await owner.query(sqlFile(file));
  const runtimeRole = 'gengyun_api_runtime';
  const password = randomBytes(24).toString('hex');
  await owner.query(
    `CREATE ROLE ${runtimeRole} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
  );
  await owner.query(`GRANT gengyun_auth_privacy TO ${runtimeRole}`);

  function deployRegion(name) {
    const matched = deploySqlFile('20-login-roles.sql').match(
      new RegExp(`-- #region ${name}\\r?\\n([\\s\\S]*?)\\r?\\n\\s*-- #endregion ${name}`),
    );
    assert.ok(matched !== null, `20-login-roles.sql 必须含 ${name} 区域`);
    const region = matched[1];
    assert.equal(/\\(echo|set|pset|if|endif|getenv|gexec)/.test(region), false, `${name} 区域不得含 psql 元命令`);
    return region;
  }
  await owner.query(deployRegion('gy-i19-deletion-grant'));
  const copiesRegion = deployRegion('gy-i19-backup-copies-grant');
  assert.ok(copiesRegion.includes('to_regclass'), '备份副本授权区域必须断言迁移已执行（缺表即显式失败）');
  await owner.query(copiesRegion);
  note('已执行 20-login-roles.sql 的两个区域（注销函数 EXECUTE＋备份副本列级 DML）');

  pool = new pg.Pool({ connectionString: `postgresql://${runtimeRole}:${password}@127.0.0.1:${port}/${DB_NAME}`, max: 6 });
  const requestStore = createPostgresDeletionRequestStore({ pool });

  // [2] 权限形状实测：列级有、表级无（这是 90-assert 的 `table_dml_allowlist` 放行的原因）。
  const privilege = (
    await pool.query(
      `SELECT has_table_privilege(current_user, 'public.user_backup_copies', 'SELECT') AS table_select,
              has_table_privilege(current_user, 'public.user_backup_copies', 'INSERT') AS table_insert,
              has_any_column_privilege(current_user, 'public.user_backup_copies', 'SELECT') AS any_column_select,
              has_column_privilege(current_user, 'public.user_backup_copies', 'payload', 'SELECT') AS payload_select`,
    )
  ).rows[0];
  assert.equal(privilege.table_select, false, '运行时角色不得有表级 SELECT');
  assert.equal(privilege.table_insert, false, '运行时角色不得有表级 INSERT');
  assert.equal(privilege.any_column_select, true, '运行时角色必须有列级 SELECT');
  assert.equal(privilege.payload_select, false, '未授予的列（payload）必须不可读');
  await expectSqlState(pool, '运行时直接 DELETE 清单行', 'DELETE FROM public.user_backup_copies', [], '42501');
  say('最小权限：运行时对清单表**只有列级** SELECT/INSERT/UPDATE（表级 SELECT/INSERT = false、payload 列不可读、DELETE = 42501）');

  // -------------------------------------------------------------------------
  // 臂 A：有对象 + 0 对象模块 ⇒ 两行都写；31 天后重放 ⇒ completed 且证据可复算
  // -------------------------------------------------------------------------
  const userA = randomUUID();
  await owner.query('INSERT INTO users (id) VALUES ($1::uuid)', [userA]);
  const clockA = scriptedClock(START);
  const favoritesA = createMemoryFavoritesStore({ now: () => clockA.now().getTime() });
  const historyA = createMemoryHistoryStore({ now: () => clockA.now().getTime() });
  const favoriteIdsA = await seedFavorites(favoritesA, userA, 2);
  const portA = createPostgresBackupPurgePort({ pool, now: () => clockA.now() });
  const deletionA = createUserDataDeletion({
    favoritesStore: favoritesA,
    historyStore: historyA,
    backupPurge: portA,
    requests: requestStore,
    receiptTtlMs: RECEIPT_TTL_MS,
    now: clockA.now,
  });
  const requestA = deletionA.requestDeletionFor(userA);
  await deletionA.executeHandlers(requestA.id);

  const rowsA = await copiesOf(owner, requestA.id);
  assert.equal(rowsA.length, 2, '两个必需模块都必须写清单行（0 对象也要写）');
  const favoritesRowA = rowsA.find((row) => row.module === 'favorites');
  const historyRowA = rowsA.find((row) => row.module === 'history');
  assert.ok(favoritesRowA !== undefined && historyRowA !== undefined, '模块名必须如实落库');
  assert.equal(favoritesRowA.scope, 'favorite');
  assert.equal(historyRowA.scope, 'history');
  assert.equal(Number(favoritesRowA.payload.records), 2, '收藏清单必须记 2 个对象');
  assert.equal(favoritesRowA.payload.object_refs.length, 2);
  assert.deepEqual(new Set(favoritesRowA.payload.object_refs), new Set(favoriteIdsA), '清单只能是不透明行 id');
  assert.equal(Number(historyRowA.payload.records), 0, '0 对象模块也必须写一行且 records=0');
  assert.deepEqual(historyRowA.payload.object_refs, []);
  assert.deepEqual(Object.keys(favoritesRowA.payload).sort(), ['object_refs', 'records'], 'payload 只许这两个键（最小化）');
  assert.equal(favoritesRowA.payload_digest, copyPayloadDigest(copyPayloadJson({ objectRefs: favoritesRowA.payload.object_refs, records: 2 })));
  assert.equal(favoritesRowA.state, 'pending_purge');
  assert.equal(Number(favoritesRowA.purge_attempts), 0);
  assert.equal(Number(favoritesRowA.delete_generation), 1);
  assert.equal(favoritesRowA.lineage, 'deletion-manifest/v1');
  assert.equal(await reconciliationRows(owner), 0, '§4.4 对账：retention_until 必须逐行等于 backup_due_at');
  const receiptA1 = receiptRow(deletionA, requestA.id);
  assert.equal(handlerOf(receiptA1, 'favorites').backup_state, 'pending', '未到期 ⇒ 只可能是 pending');
  assert.equal(handlerOf(receiptA1, 'favorites').error_code, null);
  say('写入路径：受理同一事务内写 2 行（收藏 2 个不透明 ref + 历史 0 对象 ref）、state=pending_purge、purge_attempts=0、lineage/水位/摘要自洽；§4.4 对账 0 行不等');

  // 11 天后仍在保留窗口内 ⇒ 重放不能提前清（waiting 不是 completed，也不是 blocked）。
  clockA.advanceDays(11);
  await deletionA.executeHandlers(requestA.id);
  const receiptA2 = receiptRow(deletionA, requestA.id);
  assert.equal(handlerOf(receiptA2, 'favorites').backup_state, 'pending', '保留期内重放必须仍 pending');
  assert.equal((await copiesOf(owner, requestA.id)).every((row) => row.state === 'pending_purge'), true);
  say('保留窗口内（+11 天）重放：仍 pending、行仍是 pending_purge（waiting 既不算完成也不算失败）');

  clockA.advanceDays(20); // 累计 31 天 > 30 天
  await deletionA.executeHandlers(requestA.id);
  const receiptA3 = receiptRow(deletionA, requestA.id);
  assert.equal(handlerOf(receiptA3, 'favorites').backup_state, 'completed', '到期后清成功必须 completed');
  assert.equal(handlerOf(receiptA3, 'history').backup_state, 'completed', '0 对象模块同样必须 completed（有证据行）');
  assert.equal(receiptA3.state, 'completed', '两个模块都完成 ⇒ 整体 completed');
  const rowsA3 = await copiesOf(owner, requestA.id);
  assert.equal(rowsA3.length, 2, '清除后**行必须保留**（唯一的「清过」证据）');
  for (const row of rowsA3) {
    assert.equal(row.state, 'purged');
    assert.equal(row.payload, null, 'payload 必须置 jsonb null（正文/引用都不留）');
    assert.equal(row.purged_at.toISOString(), clockA.iso(), 'purged_at 必须是本次清除时刻');
    assert.match(row.evidence_ref, /^sha256:[0-9a-f]{64}$/);
    const expected = purgeEvidenceRef({ requestId: requestA.id, module: row.module, payloadDigests: [row.payload_digest] });
    assert.equal(row.evidence_ref, expected, `${row.module} 的证据必须能由 payload_digest 独立复算`);
  }
  assert.ok(deletionA.evidenceOf(requestA.id).favorites.includes('backup-purged:sha256:'), '诊断证据串必须带清除摘要');
  say('到期清除（+31 天重放）：两行 purged、payload=null、purged_at=清除时刻、证据摘要由 payload_digest 独立复算逐字相等、行保留 ⇒ 整体 completed');

  const purgedAtA = rowsA3.map((row) => row.purged_at.toISOString());
  clockA.advanceDays(1);
  await deletionA.executeHandlers(requestA.id);
  const receiptA4 = receiptRow(deletionA, requestA.id);
  const rowsA4 = await copiesOf(owner, requestA.id);
  assert.equal(handlerOf(receiptA4, 'favorites').backup_state, 'completed', '重放不得把 completed 降级');
  assert.deepEqual(rowsA4.map((row) => row.purged_at.toISOString()), purgedAtA, '重放不得改写 purged_at');
  assert.equal(rowsA4.every((row) => Number(row.purge_attempts) === 0), true, '重放不得累加尝试次数');
  say('重放幂等：再跑一次仍 completed，purged_at 不变、purge_attempts 仍 0（ALL_PURGED 只复核，不重复清）');

  // -------------------------------------------------------------------------
  // 臂 B：清单写入在事务内失败 ⇒ 整笔回滚、202 不签发
  // -------------------------------------------------------------------------
  const userB = randomUUID();
  await owner.query('INSERT INTO users (id) VALUES ($1::uuid)', [userB]);
  const clockB = scriptedClock(START);
  const favoritesB = createMemoryFavoritesStore({ now: () => clockB.now().getTime() });
  const historyB = createMemoryHistoryStore({ now: () => clockB.now().getTime() });
  await seedFavorites(favoritesB, userB, 1);
  // 只有**第二个**模块的枚举器抛错 ⇒ 第 1 行已写、第 2 行写失败，正好卡在同一事务中间。
  const historyBExploding = {
    ...historyB,
    async snapshotOwner() {
      throw new Error('模拟受理事务内清单枚举失败');
    },
  };
  const deletionB = createUserDataDeletion({
    favoritesStore: favoritesB,
    historyStore: historyBExploding,
    backupPurge: createPostgresBackupPurgePort({ pool, now: () => clockB.now() }),
    requests: requestStore,
    receiptTtlMs: RECEIPT_TTL_MS,
    now: clockB.now,
  });
  const requestB = deletionB.requestDeletionFor(userB);
  await assert.rejects(deletionB.executeHandlers(requestB.id), (error) => {
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE', `受理必须失败关闭，实际：${error.code}`);
    assert.equal(error.status, 503);
    assert.equal(error.retryable, false, '清单写不进属确定性缺陷（要修数据/权限），不是可重试的瞬时故障');
    return true;
  });
  const requestsB = await owner.query('SELECT count(*)::int AS n FROM public.deletion_requests WHERE user_id = $1::uuid', [userB]);
  const copiesB = await owner.query('SELECT count(*)::int AS n FROM public.user_backup_copies WHERE user_id = $1::uuid', [userB]);
  const userBRow = (await owner.query('SELECT state, auth_epoch FROM public.users WHERE id = $1::uuid', [userB])).rows[0];
  assert.equal(Number(requestsB.rows[0].n), 0, '受理行必须随事务回滚（不得「已答应受理但库里没有」）');
  assert.equal(Number(copiesB.rows[0].n), 0, '清单行必须随事务回滚（不得半写）');
  assert.equal(userBRow.state, 'active', '函数内的 users 状态迁移必须一起回滚');
  assert.equal(Number(userBRow.auth_epoch), 1, 'auth_epoch 也必须一起回滚');
  say('清单写入失败（事务内）：503 PROVIDER_UNAVAILABLE(retryable=false)、deletion_requests 0 行、清单 0 行、users.state 仍 active ⇒ 202 不可能签发');

  // -------------------------------------------------------------------------
  // 臂 C：复核不过（该模块还有未清行）⇒ 回滚 + 置 failed + blocked/EVIDENCE_REQUIRED
  // -------------------------------------------------------------------------
  const userC = randomUUID();
  await owner.query('INSERT INTO users (id) VALUES ($1::uuid)', [userC]);
  const clockC = scriptedClock(START);
  const favoritesC = createMemoryFavoritesStore({ now: () => clockC.now().getTime() });
  const historyC = createMemoryHistoryStore({ now: () => clockC.now().getTime() });
  await seedFavorites(favoritesC, userC, 1);
  const deletionC = createUserDataDeletion({
    favoritesStore: favoritesC,
    historyStore: historyC,
    backupPurge: createPostgresBackupPurgePort({ pool, now: () => clockC.now() }),
    requests: requestStore,
    receiptTtlMs: RECEIPT_TTL_MS,
    now: clockC.now,
  });
  const requestC = deletionC.requestDeletionFor(userC);
  await deletionC.executeHandlers(requestC.id);
  // 同模块的第二个范围「还没到期」（真实形状：一个模块可能有多个范围）：复核必然看到未清行。
  clockC.advanceDays(31);
  await insertCopyRow(owner, {
    userId: userC,
    requestId: requestC.id,
    module: 'favorites',
    scope: 'favorite_archive',
    coveredThrough: clockC.iso(),
    retentionUntil: new Date(clockC.now().getTime() + 30 * DAY_MS).toISOString(),
  });
  await deletionC.executeHandlers(requestC.id);
  const receiptC = receiptRow(deletionC, requestC.id);
  const favoritesCState = handlerOf(receiptC, 'favorites');
  assert.equal(favoritesCState.backup_state, 'blocked', '该清没清干净必须 blocked（不是 pending）');
  assert.equal(favoritesCState.error_code, 'EVIDENCE_REQUIRED', '复核不过 ⇒ EVIDENCE_REQUIRED');
  assert.equal(receiptC.state, 'blocked');
  const rowsC = await copiesOf(owner, requestC.id);
  const dueC = rowsC.find((row) => row.scope === 'favorite');
  const lateC = rowsC.find((row) => row.scope === 'favorite_archive');
  // 回滚的实证是「purged_at 仍为 NULL + payload 原样」，不是 state（失败留痕会把 pending 行统一改成 failed）。
  assert.equal(dueC.purged_at, null, '复核不过 ⇒ 清除 UPDATE 必须整笔回滚（到期行不得留下 purged_at）');
  assert.notEqual(dueC.payload, null, '到期行的 payload 必须原样保留（回滚的实证）');
  assert.equal(dueC.state, 'failed', '该模块没清干净 ⇒ 留痕 failed（供显式重排），不是假装已清');
  assert.equal(dueC.last_error_code, 'EVIDENCE_REQUIRED');
  assert.equal(Number(dueC.purge_attempts), 1, '失败留痕必须把 purge_attempts +1');
  assert.equal(lateC.state, 'failed', '未清行同样置 failed（留痕，供显式重排）');
  assert.equal(lateC.last_error_code, 'EVIDENCE_REQUIRED');
  assert.equal(Number(lateC.purge_attempts), 1);
  say('复核不过（同模块还有未到期行）：清除整笔回滚（purged_at 仍 NULL、payload 原样）、该模块 pending 行统一 failed + EVIDENCE_REQUIRED + attempts=1、回执 blocked（不是 pending/completed）');

  // -------------------------------------------------------------------------
  // 臂 D：清除期数据库报错 ⇒ 回滚 + 置 failed + blocked/STORE_UNREACHABLE
  // -------------------------------------------------------------------------
  const userD = randomUUID();
  await owner.query('INSERT INTO users (id) VALUES ($1::uuid)', [userD]);
  const clockD = scriptedClock(START);
  const favoritesD = createMemoryFavoritesStore({ now: () => clockD.now().getTime() });
  const historyD = createMemoryHistoryStore({ now: () => clockD.now().getTime() });
  await seedFavorites(favoritesD, userD, 1);
  const deletionD = createUserDataDeletion({
    favoritesStore: favoritesD,
    historyStore: historyD,
    backupPurge: createPostgresBackupPurgePort({ pool, now: () => clockD.now() }),
    requests: requestStore,
    receiptTtlMs: RECEIPT_TTL_MS,
    now: clockD.now,
  });
  const requestD = deletionD.requestDeletionFor(userD);
  await deletionD.executeHandlers(requestD.id);
  // 只对该用户、只对「置 purged」的 UPDATE 注入故障：markFailed 那一步必须还能落库。
  await owner.query(
    `CREATE FUNCTION public.gy_i19_block_purge() RETURNS trigger LANGUAGE plpgsql AS $fn$
     BEGIN
       RAISE EXCEPTION '模拟清除期数据库故障（测试注入）';
     END;
     $fn$`,
  );
  await owner.query(
    `CREATE TRIGGER gy_i19_block_purge BEFORE UPDATE ON public.user_backup_copies
       FOR EACH ROW WHEN (OLD.user_id = '${userD}'::uuid AND NEW.state = 'purged')
       EXECUTE FUNCTION public.gy_i19_block_purge()`,
  );
  clockD.advanceDays(31);
  await deletionD.executeHandlers(requestD.id);
  const receiptD = receiptRow(deletionD, requestD.id);
  assert.equal(handlerOf(receiptD, 'favorites').backup_state, 'blocked');
  assert.equal(handlerOf(receiptD, 'favorites').error_code, 'STORE_UNREACHABLE', '清除抛错 ⇒ STORE_UNREACHABLE');
  const rowsD = await copiesOf(owner, requestD.id);
  const failedD = rowsD.find((row) => row.module === 'favorites');
  assert.equal(failedD.state, 'failed', '清除抛错的行必须置 failed');
  assert.equal(failedD.last_error_code, 'STORE_UNREACHABLE');
  assert.equal(Number(failedD.purge_attempts), 1);
  assert.equal(rowsD.some((row) => row.state === 'purged'), false, '不得留下半清状态');
  await owner.query('DROP TRIGGER gy_i19_block_purge ON public.user_backup_copies');
  await owner.query('DROP FUNCTION public.gy_i19_block_purge()');
  say('清除期抛错：事务回滚（无 purged 行）、行置 failed + STORE_UNREACHABLE + attempts=1、回执 blocked（不是 pending）');

  // -------------------------------------------------------------------------
  // 臂 E：同模块多行到期 ⇒ 一条 UPDATE 清完，证据覆盖**排序后的多个** digest
  // -------------------------------------------------------------------------
  const userE = randomUUID();
  await owner.query('INSERT INTO users (id) VALUES ($1::uuid)', [userE]);
  const clockE = scriptedClock(START);
  const favoritesE = createMemoryFavoritesStore({ now: () => clockE.now().getTime() });
  const historyE = createMemoryHistoryStore({ now: () => clockE.now().getTime() });
  await seedFavorites(favoritesE, userE, 1);
  const deletionE = createUserDataDeletion({
    favoritesStore: favoritesE,
    historyStore: historyE,
    backupPurge: createPostgresBackupPurgePort({ pool, now: () => clockE.now() }),
    requests: requestStore,
    receiptTtlMs: RECEIPT_TTL_MS,
    now: clockE.now,
  });
  const requestE = deletionE.requestDeletionFor(userE);
  await deletionE.executeHandlers(requestE.id);
  // 第二个范围、同样在保留期边界内到期（与主线同一天到期）。
  const extraDigestE = await insertCopyRow(owner, {
    userId: userE,
    requestId: requestE.id,
    module: 'favorites',
    scope: 'favorite_archive',
    coveredThrough: START,
    retentionUntil: new Date(Date.parse(START) + 30 * DAY_MS).toISOString(),
  });
  clockE.advanceDays(31);
  await deletionE.executeHandlers(requestE.id);
  const receiptE = receiptRow(deletionE, requestE.id);
  assert.equal(handlerOf(receiptE, 'favorites').backup_state, 'completed');
  const rowsE = await copiesOf(owner, requestE.id);
  const favoritesE2 = rowsE.filter((row) => row.module === 'favorites');
  assert.equal(favoritesE2.length, 2);
  assert.equal(favoritesE2.every((row) => row.state === 'purged' && row.payload === null), true);
  const digestsE = [favoritesE2[0].payload_digest, extraDigestE];
  const expectedE = purgeEvidenceRef({ requestId: requestE.id, module: 'favorites', payloadDigests: digestsE });
  assert.equal(favoritesE2[0].evidence_ref, expectedE, '多行证据必须覆盖排序后的全部 digest');
  assert.equal(favoritesE2[1].evidence_ref, expectedE);
  say('同模块两行同时到期：一条 UPDATE 清完（2 行 purged）、证据摘要 = 排序后两个 payload_digest 的合成摘要（独立复算相等）');

  // -------------------------------------------------------------------------
  // 臂 F/G：空集与非法主体 —— 端口必须如实 blocked / 抛 SESSION_REQUIRED
  // -------------------------------------------------------------------------
  const noCopies = await portA.purge({ userId: userA, module: 'favorites', onlineRemoved: 0, requestId: randomUUID() });
  assert.equal(noCopies.purged, false);
  assert.equal(noCopies.outcome, 'blocked');
  assert.equal(noCopies.errorCode, 'EVIDENCE_REQUIRED', '没有副本行的「清除」不产生证据 ⇒ EVIDENCE_REQUIRED');
  say('空集不当成功：未知 requestId 的清除请求 ⇒ blocked + EVIDENCE_REQUIRED（不是 completed、不是 waiting）');

  await assert.rejects(
    portA.purge({ userId: 'not-a-uuid', module: 'favorites', onlineRemoved: 0, requestId: randomUUID() }),
    (error) => {
      assert.equal(error.code, 'SESSION_REQUIRED', '缺身份上下文必须显式抛 SESSION_REQUIRED');
      return true;
    },
  );
  await assert.rejects(
    portA.purge({ userId: userA, module: 'favorites', onlineRemoved: 0 }),
    (error) => {
      assert.equal(error.code, 'SESSION_REQUIRED', '没有受理请求 id 同样不能猜主体');
      return true;
    },
  );
  say('非 UUID 主体 / 缺受理请求 id：显式 PrivacyError(SESSION_REQUIRED)，不查库、不猜主体（先例 ledger-pg.ts:540-542）');

  // -------------------------------------------------------------------------
  // 臂 H：0023 的 CHECK 与 ON DELETE RESTRICT 都是库侧拒绝
  // -------------------------------------------------------------------------
  const digestPlaceholder = copyPayloadDigest(copyPayloadJson({ objectRefs: [], records: 0 }));
  const insertCopySql = `INSERT INTO public.user_backup_copies (
      user_id, request_id, module, scope, delete_generation, lineage, covered_through,
      payload, payload_digest, state, retention_until, purged_at, evidence_ref, last_error_code
    ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::integer, $6, $7::timestamptz, $8::jsonb, $9::char(64), $10,
              $11::timestamptz, $12::timestamptz, $13, $14)`;
  const copyBase = (overrides) => [
    overrides.userId ?? userC,
    overrides.requestId ?? requestC.id,
    overrides.module ?? 'favorites',
    overrides.scope ?? 'favorite_negative',
    overrides.generation ?? 1,
    overrides.lineage ?? 'deletion-manifest/v1',
    overrides.coveredThrough ?? clockC.iso(),
    overrides.payload ?? '{"object_refs":[],"records":0}',
    overrides.digest ?? digestPlaceholder,
    overrides.state ?? 'pending_purge',
    overrides.retentionUntil ?? new Date(clockC.now().getTime() + 30 * DAY_MS).toISOString(),
    overrides.purgedAt ?? null,
    overrides.evidenceRef ?? null,
    overrides.errorCode ?? null,
  ];

  await expectSqlState(owner, 'purged 但 payload 未置 null', insertCopySql, copyBase({
    state: 'purged',
    purgedAt: clockC.iso(),
    evidenceRef: 'sha256:' + 'a'.repeat(64),
  }), '23514');
  await expectSqlState(owner, 'purged 但没有证据', insertCopySql, copyBase({
    state: 'purged',
    payload: 'null',
    purgedAt: clockC.iso(),
  }), '23514');
  await expectSqlState(owner, 'failed 但没有 last_error_code', insertCopySql, copyBase({ state: 'failed' }), '23514');
  await expectSqlState(owner, 'pending_purge 却带 purged_at', insertCopySql, copyBase({ purgedAt: clockC.iso() }), '23514');
  await expectSqlState(owner, '摘要形状非法', insertCopySql, copyBase({ digest: 'xyz' }), '23514');
  await expectSqlState(owner, 'scope 形状非法', insertCopySql, copyBase({ scope: 'Favorite-Archive' }), '23514');
  await expectSqlState(owner, '水位晚于 created_at', insertCopySql, copyBase({
    coveredThrough: new Date(clockC.now().getTime() + DAY_MS).toISOString(),
  }), '23514');
  await expectSqlState(owner, 'delete_generation = 0', insertCopySql, copyBase({ generation: 0 }), '23514');
  await expectSqlState(owner, '删除仍被清单引用的注销请求', 'DELETE FROM public.deletion_requests WHERE id = $1::uuid', [requestC.id], '23503');
  say('库侧约束：purged 必须 payload=null + 非空证据、failed 必须原因码、pending_purge 不得有 purged_at、摘要/scope 形状、水位倒挂、generation≥1 全部 23514；删除被引用的注销请求 23503（RESTRICT）');

  console.log(`\nRESULT=PASS ${passed} 组；PostgreSQL ${version}（本机隔离、仅回环）；未发出任何对外请求；迁移清单 ${discovered.length} 个（含 ${COPIES_MIGRATION}）`);
} finally {
  await pool?.end?.().catch(() => {});
  await owner?.end?.().catch(() => {});
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
