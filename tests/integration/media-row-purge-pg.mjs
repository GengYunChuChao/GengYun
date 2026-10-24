// GY-R34 / #19 片 2：public.purge_owner_media(uuid) 的真库集成臂。
//
// 为什么必须有这条臂：0035 的四谓词（本人 + 终态 + 未被三条引用面指向 + 已入队）与
// 「public.media 对运行时零表级 DELETE」这两件事，静态测试只能证明「SQL 文本长这样」，
// 证明不了 PG 真跑起来会这样。本脚本用一次性集群把整条链跑一遍：
//   全链迁移 → 建运行时角色 → 应用 20-login-roles.sql 段 M（媒体域生产授权面）
//   + 段 D4（本片新增的 EXECUTE）→ 按运行时身份读权限面 → 以运行时身份调函数
//   → 逐行核对「删了哪些、留了哪些、台账还在不在」。
//
// 探针分段（编号与下面的 PASS 文案对应）：
//   [1] 权限面：media 无表级 DELETE；media_derivatives / media_object_cleanup 有；
//       purge_owner_media 的 EXECUTE 只落在运行时身上（0034 两条函数未被本片顺手放开）。
//   [1b] 反向控制：运行时对 public.media 直接发 DELETE ⇒ 42501。
//   [2] 正常批：读数逐键对账 + 逐行核对「该删的三行没了、非终态三行还在」。
//   [3] 硬条件 ①：一个终态媒体缺清理意图行 ⇒ G0007，且**同批本来可删的行也必须还在**（整批不删）。
//   [4] 硬条件 ②：initiated/uploaded/processing/ready/deleting 一行都不许动。
//   [5] 硬条件 ③：三条引用面（content_media_refs / community_media_grants /
//       public_authors.avatar_media_id）指向的行留原地，skipped_referenced 逐条对得上。
//   [6] 幂等：第二次调用读数全 0，被引用的行仍然在（不报成「删干净了」）。
//   [7] 参数域：p_owner IS NULL ⇒ G0001。
//   [8] 台账不随父行消失（0029 的 media_object_cleanup 故意无外键）：桶对象回收仍归清理器。
//
// ⛔ 本脚本刻意不提供 --allow-skip；缺 GY_PG_BIN 就 exit 77（未取得 ≠ 通过）。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';

const binDir = process.env.GY_PG_BIN ?? '';
if (binDir === '') {
  console.log('SKIP: 未设置 GY_PG_BIN（postgres 二进制目录，含 initdb/pg_ctl）⇒ 真库臂跳过，');
  console.log('      本次**未验证** purge_owner_media 的真库语义（未取得，不是通过）。');
  console.log('EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本脚本刻意不提供 --allow-skip）。');
  process.exit(77);
}

const DB_NAME = 'gengyun_media_row_purge_test';
const RUNTIME_ROLE = 'gengyun_api_runtime';
const serverLog =
  process.env.GY_R34_PG_LOG ?? join(tmpdir(), `gy-r34-media-purge-pg-${randomBytes(3).toString('hex')}.log`);
const migrationsDir = new URL('../../services/api/db/migrations/', import.meta.url);
const readSql = (path) => readFileSync(new URL(`../../services/api/db/${path}`, import.meta.url), 'utf8');
const deploySqlFile = (name) =>
  readFileSync(new URL(`../../deploy/postgres-cvm/sql/${name}`, import.meta.url), 'utf8');

let passed = 0;
const say = (label) => {
  passed += 1;
  console.log(`PASS ${passed}: ${label}`);
  return passed;
};
const note = (line) => console.log(`  - ${line}`);

let port = 0;
let adminBase = '';
let targetUrl = '';
let owner = null;
let pool = null;
let dataDir = '';

const rootDir = process.env.GY_R34_PG_ROOT ?? tmpdir();
const tool = (name) => join(binDir, process.platform === 'win32' ? `${name}.exe` : name);

async function portIsFree(candidate) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(candidate, '127.0.0.1');
  });
}

async function pickPort() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = 55700 + randomInt(0, 300);
    if (candidate === 55436) continue;
    if (await portIsFree(candidate)) return candidate;
  }
  throw new Error('557xx 区间内找不到空闲端口（同机临时集群过多）');
}

function runTool(name, args) {
  // 本机 sandbox 禁止命名管道：用管道收集 postgres/pg_ctl 的输出会等 EOF 等到超时，
  // 因此一律把子进程 stdout/stderr 重定向到文件。
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
  // Debian 编译默认 unix_socket_directories=/var/run/postgresql，普通用户写不了 ⇒ 显式指到数据目录。
  if (process.platform !== 'win32') options.push(`-k ${dataDir}`);
  return options;
}

function tailOfFile(file, maxLines = 15) {
  try {
    const lines = readFileSync(file, 'utf8').split('\n');
    return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
  } catch {
    return '(读不到日志)';
  }
}

async function startCluster() {
  port = await pickPort();
  adminBase = `postgresql://postgres@127.0.0.1:${port}`;
  targetUrl = `${adminBase}/${DB_NAME}`;
  assert.ok(existsSync(tool('initdb')), `GY_PG_BIN 下找不到 initdb：${binDir}`);
  dataDir = join(rootDir, `gy-r34-media-purge-pg-${randomBytes(4).toString('hex')}`);
  mkdirSync(dataDir, { recursive: true });
  const init = runTool('initdb', [
    '-D', dataDir,
    '--no-sync',
    '--encoding=UTF8',
    '--locale=C',
    '-U', 'postgres',
    '--auth=trust',
  ]);
  assert.equal(init.status, 0, `initdb 失败：\n${tailOfFile(serverLog)}`);
  const start = runTool('pg_ctl', [
    '-D', dataDir,
    '-l', join(dataDir, 'server.log'),
    '-o', serverOptions(),
    '-t', '60',
    '-w', 'start',
  ]);
  assert.equal(start.status, 0, `pg_ctl start 失败：\n${tailOfFile(serverLog)}`);
  note(`临时集群已起：${dataDir}`);
  note(`回环端口 ${port}（127.0.0.1，未监听外部地址）`);
}

function stopCluster() {
  if (dataDir === '') return;
  assert.ok(
    basename(dataDir).startsWith('gy-r34-media-purge-pg-'),
    `拒绝删除非本脚本创建的数据目录：${dataDir}`,
  );
  if (existsSync(join(dataDir, 'PG_VERSION'))) {
    runTool('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) {
        note(`⚠️ 临时数据目录未能删除（${error?.message ?? error}），需手工清理：${dataDir}`);
      }
    }
  }
}

async function connectWithRetry(connectionString, attempts = 40) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
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
  throw lastError ?? new Error(`连不上 ${connectionString}`);
}

// ---------------------------------------------------------------------------
// 从生产 SQL 里切出「要应用到临时库的授权段」：不抄授权面，只切，避免两份事实漂移。
// ---------------------------------------------------------------------------

function stripEcho(raw, label) {
  const lines = raw.split('\n').filter((line) => !/^\s*\\echo\b/.test(line));
  const text = lines.join('\n');
  const other = text.split('\n').find((line) => /^\s*\\/.test(line));
  assert.equal(other, undefined, `${label} 里出现了 \echo 之外的 psql 元命令：${String(other)}`);
  return text;
}

function regionBlock(text, name) {
  const start = text.indexOf(`-- #region ${name}`);
  const end = text.indexOf(`-- #endregion ${name}`);
  assert.ok(start >= 0, `找不到 -- #region ${name}`);
  assert.ok(end > start, `找不到 -- #endregion ${name}`);
  const raw = text.slice(text.indexOf('\n', start) + 1, end);
  return { raw, sql: stripEcho(raw, name) };
}

// 段 M = 媒体域的生产授权面。切法用两级稳定锚点（节标题 → 下一个 #region），
// 并在切之前钉住「media 无表级 DELETE」这句裁定本身。
function mediaDomainGrants() {
  const text = deploySqlFile('20-login-roles.sql');
  const start = text.indexOf('-- M. 媒体域（R28-W12）');
  const end = text.indexOf('-- #region gy-r29-moderation-ledger-grant');
  assert.ok(start >= 0, '在 20-login-roles.sql 里找不到段 M 的节标题');
  assert.ok(end > start, '在 20-login-roles.sql 里找不到段 M 的结束锚点');
  const raw = text.slice(start, end);
  assert.match(raw, /media 故意不授 DELETE/, '段 M 的裁定原句不见了：本片的禁止面正是由它定义的');
  assert.match(raw, /GRANT\s+DELETE\s+ON\s+public\.media_derivatives\s+TO\s+gengyun_api_runtime;/);
  assert.match(raw, /GRANT\s+DELETE\s+ON\s+public\.media_object_cleanup\s+TO\s+gengyun_api_runtime;/);
  assert.doesNotMatch(raw, /GRANT\s+DELETE\s+ON\s+public\.media\s+TO/, '段 M 里出现了 public.media 的表级 DELETE');
  return stripEcho(raw, '段 M');
}

// ---------------------------------------------------------------------------
// 造数：形状全部取自 0001/0029 的实测 DDL。
// ---------------------------------------------------------------------------

// 仍持有对象键的信封（四段式 v1.<iv 16>.<tag 22>.<密文>，见 media/object-ref-cipher.ts）。
const LIVE_CIPHER = `v1.${'A'.repeat(16)}.${'B'.repeat(22)}.Zm9vYmFy`;
// 「已清空」＝空明文的信封 ⇒ 密文段为空、封以 `.` 收尾，该列不再持有任何对象键。
const CLEARED_CIPHER = `v1.${'A'.repeat(16)}.${'B'.repeat(22)}.`;

let digestSeed = 0;

async function seedMedia(ownerId, state, cipher) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO public.media (id, owner_id, purpose, mime, bytes, sha256, state, object_ref_cipher)
     VALUES ($1::uuid, $2::uuid, 'community_image', 'image/jpeg', 1024, $3, $4::public.media_state, $5)`,
    [id, ownerId, 'a'.repeat(64), state, cipher],
  );
  return id;
}

async function seedCleanup(mediaId) {
  digestSeed += 1;
  await owner.query(
    `INSERT INTO public.media_object_cleanup (media_id, object_ref_cipher, object_ref_digest, reason)
     VALUES ($1::uuid, $2, $3, 'owner_delete')`,
    [mediaId, LIVE_CIPHER, digestSeed.toString(16).padStart(64, '0')],
  );
}

async function seedDerivative(mediaId, cipher) {
  await owner.query(
    `INSERT INTO public.media_derivatives (media_id, derivative_kind, object_ref_cipher, hash, state)
     VALUES ($1::uuid, 'thumb', $2, $3, 'rejected')`,
    [mediaId, cipher, 'b'.repeat(64)],
  );
}

const countOf = async (sql, params) => Number((await owner.query(sql, params)).rows[0].v);
const idsOfMedia = async (ownerId) =>
  (await owner.query('SELECT id::text AS id FROM public.media WHERE owner_id = $1::uuid ORDER BY id', [ownerId]))
    .rows.map((row) => row.id);

async function callPurge(subject) {
  const { rows } = await pool.query('SELECT public.purge_owner_media($1::uuid) AS r', [subject]);
  return rows[0].r;
}

async function callPurgeError(subject) {
  try {
    await pool.query('SELECT public.purge_owner_media($1::uuid) AS r', [subject]);
    return null;
  } catch (error) {
    return error;
  }
}

async function main() {
  await startCluster();

  const bootstrap = await connectWithRetry(`${adminBase}/postgres`);
  await bootstrap.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await bootstrap.query(`CREATE DATABASE ${DB_NAME}`);
  await bootstrap.end();

  owner = await connectWithRetry(targetUrl);
  const version = (await owner.query('SHOW server_version')).rows[0].server_version;
  note(`server_version=${version}`);

  // ---- 全链迁移（与 migrate.ts up 同序：按文件名排序逐个应用）---------------------
  const migrationFiles = readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  const versions = migrationFiles.map((name) => Number(name.slice(0, 4)));
  for (let index = 0; index < versions.length; index += 1) {
    assert.equal(versions[index], index + 1, `迁移号必须从 0001 起连续无缺号，缺 ${index + 1}`);
  }
  assert.ok(versions.includes(35), '迁移清单里必须有 0035（本片的媒体行窄函数）');
  assert.equal(versions.length, Math.max(...versions), '迁移个数必须等于最大号（无空洞）');
  for (const name of migrationFiles) {
    await owner.query(readFileSync(new URL(name, migrationsDir), 'utf8'));
  }
  say(`全链迁移应用完成：${migrationFiles.length} 个文件，编号 1..${Math.max(...versions)} 连续`);

  const fn = (
    await owner.query(
      `SELECT p.prosecdef AS secdef,
              p.prorettype = 'jsonb'::regtype AS returns_jsonb,
              pg_get_function_identity_arguments(p.oid) AS args,
              coalesce(array_to_string(p.proconfig, ','), '') AS conf
         FROM pg_proc p
        WHERE p.oid = 'public.purge_owner_media(uuid)'::regprocedure`,
    )
  ).rows;
  assert.equal(fn.length, 1, 'public.purge_owner_media(uuid) 不在岗（0035 没生效）');
  assert.equal(fn[0].args, 'p_owner uuid');
  assert.equal(fn[0].secdef, true, '函数不是 SECURITY DEFINER');
  assert.equal(fn[0].returns_jsonb, true, '函数不返回 jsonb');
  assert.match(fn[0].conf, /search_path=pg_catalog/, '函数没有 SET search_path = pg_catalog');
  assert.match(fn[0].conf, /TimeZone=UTC/, "函数没有 SET TimeZone = 'UTC'");
  say('函数在岗且收口：SECURITY DEFINER + SET search_path=pg_catalog + SET TimeZone=UTC + RETURNS jsonb');

  // ---- 授权面：建运行时角色，只应用「段 M（媒体域）+ 段 D4（本片新增）」-----------
  const password = randomBytes(9).toString('hex');
  await owner.query(
    `CREATE ROLE ${RUNTIME_ROLE} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
  );
  const rolesSql = deploySqlFile('20-login-roles.sql');
  const mediaGrants = mediaDomainGrants();
  const mediaPurgeGrant = regionBlock(rolesSql, 'gy-r34-i19-media-row-purge-grant');
  assert.match(
    mediaPurgeGrant.sql,
    /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.purge_owner_media\(uuid\)\s+TO\s+gengyun_api_runtime;/,
    '段 D4 里没有授予 purge_owner_media 的 EXECUTE',
  );
  assert.doesNotMatch(mediaPurgeGrant.sql, /GRANT\s+(DELETE|INSERT|UPDATE|TRUNCATE)/, '段 D4 竟然动了表级权限');
  await owner.query(mediaGrants);
  await owner.query(mediaPurgeGrant.sql);
  say('授权面应用完成：段 M（媒体域生产授权）+ 段 D4（仅 EXECUTE，未动任何表级权限）');

  pool = new pg.Pool({
    connectionString: `postgresql://${RUNTIME_ROLE}:${password}@127.0.0.1:${port}/${DB_NAME}`,
    max: 6,
  });

  const privileges = (
    await pool.query(`SELECT
        has_table_privilege(current_user, 'public.media', 'DELETE')                    AS media_delete,
        has_table_privilege(current_user, 'public.media_derivatives', 'DELETE')        AS deriv_delete,
        has_table_privilege(current_user, 'public.media_object_cleanup', 'DELETE')     AS cleanup_delete,
        has_table_privilege(current_user, 'public.media', 'TRUNCATE')                  AS media_truncate,
        has_function_privilege(current_user, 'public.purge_owner_media(uuid)', 'EXECUTE')        AS media_exec,
        has_function_privilege(current_user, 'public.purge_owner_recognitions(uuid)', 'EXECUTE') AS recog_exec,
        has_function_privilege(current_user, 'public.purge_owner_speech(uuid)', 'EXECUTE')       AS speech_exec`)
  ).rows[0];
  assert.equal(privileges.media_delete, false, '运行时竟然有 public.media 的表级 DELETE');
  assert.equal(privileges.media_truncate, false, '运行时竟然有 public.media 的 TRUNCATE');
  assert.equal(privileges.deriv_delete, true, 'media_derivatives 的表级 DELETE 丢了（段 M 回归）');
  assert.equal(privileges.cleanup_delete, true, 'media_object_cleanup 的表级 DELETE 丢了（段 M 回归）');
  assert.equal(privileges.media_exec, true, 'purge_owner_media 的 EXECUTE 没授上');
  assert.equal(privileges.recog_exec, false, '0034 的 purge_owner_recognitions 被本片顺手放开了');
  assert.equal(privileges.speech_exec, false, '0034 的 purge_owner_speech 被本片顺手放开了');
  say('[1] 权限面：media 无表级 DELETE/TRUNCATE；两张从属表保留表级 DELETE；EXECUTE 只落在 media 这一条上');

  const denied = await pool
    .query('DELETE FROM public.media WHERE false')
    .then(() => null, (error) => error);
  assert.ok(denied, '运行时居然能对 public.media 发 DELETE —— 表级禁止面不成立');
  assert.equal(denied.code, '42501', `期望 42501，实际 ${denied.code}: ${denied.message}`);
  say('[1b] 反向控制：运行时对 public.media 直接 DELETE ⇒ 42501');

  // ---- 造数 -------------------------------------------------------------------
  const subjectA = randomUUID();
  const subjectB = randomUUID();
  const subjectC = randomUUID();
  for (const id of [subjectA, subjectB, subjectC]) {
    await owner.query('INSERT INTO public.users (id) VALUES ($1::uuid)', [id]);
  }

  // A：该删的三行
  const aGoneClean = await seedMedia(subjectA, 'rejected', LIVE_CIPHER);
  await seedCleanup(aGoneClean);
  const aGoneCleared = await seedMedia(subjectA, 'deleted', CLEARED_CIPHER); // 密文已清空 ⇒ 无需入队
  const aGoneWithDeriv = await seedMedia(subjectA, 'rejected', CLEARED_CIPHER);
  await seedCleanup(aGoneWithDeriv);
  await seedDerivative(aGoneWithDeriv, LIVE_CIPHER);

  // A：非终态三行（② 的口径）
  const aReady = await seedMedia(subjectA, 'ready', CLEARED_CIPHER);
  const aUploaded = await seedMedia(subjectA, 'uploaded', CLEARED_CIPHER);
  const aDeleting = await seedMedia(subjectA, 'deleting', CLEARED_CIPHER);

  // A：三条引用面各指向一行终态媒体（③ 的口径）
  const aRefContent = await seedMedia(subjectA, 'rejected', LIVE_CIPHER);
  await seedCleanup(aRefContent);
  await owner.query(
    `INSERT INTO public.content_media_refs (target_type, target_id, content_revision, media_id, media_revision)
     VALUES ('post', $1::uuid, 1, $2::uuid, 1)`,
    [randomUUID(), aRefContent],
  );

  const aRefGrant = await seedMedia(subjectA, 'deleted', CLEARED_CIPHER);
  await owner.query(
    `INSERT INTO public.community_media_grants
       (requester_id, session_ref, requester_auth_epoch, content_type, content_id, content_revision,
        slot, media_id, media_revision, public_posting_epoch, token_hash, expires_at)
     VALUES ($1::uuid, $2::uuid, 1, 'post', $3::uuid, 1,
             'attachment', $4::uuid, 1, 1, $5::bytea, now() + interval '60 seconds')`,
    [subjectA, randomUUID(), randomUUID(), aRefGrant, randomBytes(16)],
  );

  const aRefAvatar = await seedMedia(subjectA, 'rejected', LIVE_CIPHER);
  await seedCleanup(aRefAvatar);
  await owner.query(
    `INSERT INTO public.public_authors (id, display_name, avatar_media_id, avatar_media_revision, avatar_audit_state)
     VALUES ($1::uuid, '作者甲', $2::uuid, 1, 'approved')`,
    [randomUUID(), aRefAvatar],
  );

  // B：同形数据但本片不调用 ⇒ 一行都不许被动到
  const bRejected = await seedMedia(subjectB, 'rejected', LIVE_CIPHER);
  await seedCleanup(bRejected);
  const bDeleted = await seedMedia(subjectB, 'deleted', CLEARED_CIPHER);

  // C：一个终态媒体**没有**清理意图行 ⇒ G0007 必须整批不删（含同批本来可删的那行）
  const cUnqueued = await seedMedia(subjectC, 'rejected', LIVE_CIPHER);
  const cCleanable = await seedMedia(subjectC, 'deleted', CLEARED_CIPHER);

  const aBefore = await idsOfMedia(subjectA);
  assert.equal(aBefore.length, 6, `A 的媒体行应为 6 条，实际 ${aBefore.length}`);

  // ---- [2] 正常批 ---------------------------------------------------------------
  const first = await callPurge(subjectA);
  assert.deepEqual(first, { media: 3, derivatives: 1, queued: 2, skipped_referenced: 3 });
  say('[2] 正常批读数：media=3 / derivatives=1 / queued=2 / skipped_referenced=3');

  const aAfter = await idsOfMedia(subjectA);
  assert.deepEqual(aAfter, [aReady, aUploaded, aDeleting, aRefContent, aRefGrant, aRefAvatar].sort());
  assert.equal(aAfter.includes(aGoneClean), false, `${aGoneClean} 该删但还在`);
  assert.equal(aAfter.includes(aGoneCleared), false, `${aGoneCleared} 该删但还在`);
  assert.equal(aAfter.includes(aGoneWithDeriv), false, `${aGoneWithDeriv} 该删但还在`);
  say('[2] 逐行核对：该删的三行已消失，非终态与三条被引用的行全部还在');

  assert.equal(
    await countOf('SELECT count(*) AS v FROM public.media_derivatives WHERE media_id = $1::uuid', [aGoneWithDeriv]),
    0,
    '派生行没有跟着删（子先父后）',
  );
  say('[2] 派生行随父行一并删除（0035 显式先删，读数 derivatives 单独可对账）');

  // ---- [3] 硬条件 ① -------------------------------------------------------------
  const g0007 = await callPurgeError(subjectC);
  assert.ok(g0007, '缺清理意图行时函数居然成功返回了 —— 硬条件① 失效');
  assert.equal(g0007.code, 'G0007', `期望 G0007，实际 ${g0007.code}: ${g0007.message}`);
  const cAfter = await idsOfMedia(subjectC);
  assert.deepEqual(cAfter, [cUnqueued, cCleanable].sort(), 'G0007 之后 C 的媒体行被动了 —— 不是整批回滚');
  assert.equal(await countOf('SELECT count(*) AS v FROM public.media WHERE id = $1::uuid', [cCleanable]), 1);
  say('[3] 硬条件①：缺清理意图行 ⇒ G0007；同批本来可删的行也留原地（整批不删）');

  // ---- [4] 硬条件 ② -------------------------------------------------------------
  assert.equal(await countOf('SELECT count(*) AS v FROM public.media WHERE id = $1::uuid', [aReady]), 1);
  assert.equal(await countOf('SELECT count(*) AS v FROM public.media WHERE id = $1::uuid', [aUploaded]), 1);
  assert.equal(await countOf('SELECT count(*) AS v FROM public.media WHERE id = $1::uuid', [aDeleting]), 1);
  const nonTerminal = await countOf(
    `SELECT count(*) AS v FROM public.media
      WHERE owner_id = $1::uuid AND state IN ('initiated', 'uploaded', 'processing', 'ready', 'deleting')`,
    [subjectA],
  );
  assert.equal(nonTerminal, 3, `A 的非终态行应为 3 条，实际 ${nonTerminal}`);
  say('[4] 硬条件②：initiated/uploaded/processing/ready/deleting 一行都没动');

  // ---- [5] 硬条件 ③ -------------------------------------------------------------
  assert.equal(await countOf('SELECT count(*) AS v FROM public.content_media_refs WHERE media_id = $1::uuid', [aRefContent]), 1);
  assert.equal(await countOf('SELECT count(*) AS v FROM public.community_media_grants WHERE media_id = $1::uuid', [aRefGrant]), 1);
  assert.equal(await countOf('SELECT count(*) AS v FROM public.public_authors WHERE avatar_media_id = $1::uuid', [aRefAvatar]), 1);
  for (const [label, id] of [
    ['content_media_refs', aRefContent],
    ['community_media_grants', aRefGrant],
    ['public_authors.avatar_media_id', aRefAvatar],
  ]) {
    assert.equal(await countOf('SELECT count(*) AS v FROM public.media WHERE id = $1::uuid', [id]), 1,
      `被 ${label} 引用的媒体行被删了 —— 越过了引用面`);
  }
  say('[5] 硬条件③：三条引用面指向的行全部留原地，且 skipped_referenced=3 与逐条核对一致');

  // B 完全没被碰过
  assert.deepEqual(await idsOfMedia(subjectB), [bRejected, bDeleted].sort());
  say('[5] 未被调用的一方（subject B）两行原样保留：函数只作用于 p_owner 本人');

  // ---- [6] 幂等 -----------------------------------------------------------------
  const second = await callPurge(subjectA);
  assert.deepEqual(second, { media: 0, derivatives: 0, queued: 0, skipped_referenced: 3 });
  say('[6] 幂等：第二次调用读数 media/derivatives/queued 全 0，skipped_referenced 仍如实报 3');

  // ---- [7] 参数域 ---------------------------------------------------------------
  const nullError = (
    await pool.query('SELECT public.purge_owner_media(NULL::uuid) AS r').then(() => null, (error) => error)
  );
  assert.ok(nullError, 'p_owner IS NULL 时函数居然成功返回了');
  assert.equal(nullError.code, 'G0001', `期望 G0001，实际 ${nullError.code}: ${nullError.message}`);
  say('[7] 参数域：p_owner IS NULL ⇒ G0001（不是「没有目标」而是调用错误）');

  // ---- [8] 台账不随父行消失 -----------------------------------------------------
  assert.equal(
    await countOf('SELECT count(*) AS v FROM public.media_object_cleanup WHERE media_id = ANY($1::uuid[])',
      [[aGoneClean, aGoneWithDeriv, aRefContent, aRefAvatar]]),
    4,
    '清理意图行随父行消失了（0029 故意不建外键，删干净就再也枚举不到待清对象）',
  );
  assert.equal(
    await countOf('SELECT count(*) AS v FROM public.media_object_cleanup c WHERE c.media_id = $1::uuid', [aGoneClean]),
    1,
  );
  say('[8] 台账留存：4 条清理意图行仍在（含已删父行的那两条），桶对象回收仍归清理器');

  assert.equal(await countOf('SELECT count(*) AS v FROM public.users WHERE id = ANY($1::uuid[])',
    [[subjectA, subjectB, subjectC]]), 3, '账号行被动到了（本片不动 public.users）');
  say('[8] 账号行未被本片触碰：注销的收尾仍归上层删除协议');

  console.log('');
  console.log(`ALL PASS：${passed} 条真库断言（exit code 0）`);
  console.log('EXITCODE=0');
}

try {
  await main();
} catch (error) {
  console.error(`FAIL: ${error?.stack ?? error}`);
  if (dataDir !== '' && existsSync(join(dataDir, 'server.log'))) {
    console.error('--- postgres 日志尾部 ---');
    console.error(tailOfFile(join(dataDir, 'server.log'), 25));
  }
  process.exitCode = 1;
} finally {
  await pool?.end().catch(() => {});
  await owner?.end().catch(() => {});
  stopCluster();
}
