// GY-R34 · 保留策略执行器（`tools/purge-retention-expired.mjs`）的**真库臂**。
//
// 跑法（Windows / PowerShell 5.1，本机已验证）：
//   $env:GY_PG_BIN = 'E:\GengYunCommander\.pg17\pgsql\bin'      # 必填：含 initdb/pg_ctl 的目录
//   node tests/integration/retention-purge-pg.mjs
//
// 没给 `GY_PG_BIN` ⇒ 打印 SKIP 并 **exit 77**（刻意不提供 `--allow-skip`：CI 一旦跳过就必须是红的，
// 不能让「没装 PG」静默变成绿）。
//
// 本臂自起临时集群（端口 55432–55467，避开发脑上 55436 的遗留集群；可用 `GY_PG_PORT` 钉死）：
// 空库 ⇒ 跑全链迁移（0001…0032）⇒ 造过期/未过期数据 ⇒ dry-run ⇒ 真执行 ⇒ 再执行一次
// ⇒ 机制臂（合成策略行：archive_marker / anonymize+revision）⇒ 权限失败。
//
// 断言的是**用户可见的承诺**，不是实现细节：
//   1. dry-run 一行都不写（所有相关表的计数在 dry-run 前后完全一致）；
//   2. 真执行只动「年龄 ≥ 保留天数」的行，未过期行（含 12 小时/29 天贴边行）原样不动；
//   3. 真实策略表只登记 2 张表且都是 delete ⇒ 另外两张（`admin_sessions` / `community_reports`，
//      天数无出处已在 `RETENTION_EXCLUSIONS` 里）**一行都不许动**：行数、标记、detail 全部原样；
//   4. 重复执行第二次删 0 行（退出码 0，不是失败）；
//   5. 机制臂（合成策略行，不是仓内口径）证明 archive_marker / anonymize 的 SQL 在真库上可执行，
//      且匿名化确实把 `revision` 推进了 1（与 store-pg.ts:1005-1011 同口径）、第二轮 0 行；
//   6. 没有 DELETE 授权时表级失败被如实分类（PERMISSION_DENIED），另一张表照跑，失败表一行未动。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

// 机制臂（[6]）要在进程内跑同一套执行器 + 合成策略行，所以直接 import（工具末尾有 invokedDirectly 闸门，不会自己跑）。
import { runRetentionPurge } from '../../tools/purge-retention-expired.mjs';

const binDir = process.env.GY_PG_BIN ?? '';
if (binDir === '') {
  console.error(
    'SKIP: 未设置 GY_PG_BIN（postgres 二进制目录，含 initdb/pg_ctl）⇒ 真库臂跳过，'
      + '保留策略执行器的真库读数本轮**未取得**（退出码 77，不算通过）',
  );
  process.exit(77);
}

const DB_NAME = 'gengyun_retention_purge_test';
const LIMITED_ROLE = 'gy_r34_retention_limited';
const toolPath = fileURLToPath(new URL('../../tools/purge-retention-expired.mjs', import.meta.url));
const migrationsDir = new URL('../../services/api/db/migrations/', import.meta.url);
const logFile = process.env.GY_R34_PG_LOG ?? join(tmpdir(), `gy-r34-purge-${randomBytes(3).toString('hex')}.log`);
const rootDir = process.env.GY_R34_PG_ROOT ?? tmpdir();
const dataDir = join(rootDir, `gy-r34-retention-pg-${randomBytes(4).toString('hex')}`);
const tool = (name) => join(binDir, process.platform === 'win32' ? `${name}.exe` : name);

let port = 0;
let adminBase = '';
let ownerBase = '';
let passed = 0;
/** 已经证明「bind 被人抢走」的端口：重试时不再挑。 */
const takenPorts = new Set();

const say = (label) => {
  passed += 1;
  console.log(`PASS ${passed}: ${label}`);
};
const note = (line) => console.log(`  - ${line}`);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 端口空闲？（只探 127.0.0.1：集群也只监听回环） */
function portIsFree(candidate) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => { server.close(() => resolve(true)); });
    server.listen(candidate, '127.0.0.1');
  });
}

/**
 * 保留策略片的端口区间是 **55432–55467**（派单硬约束）。
 * 55436 在开发机上曾遗留一个临时集群：范围包含它，但这里硬挡一次，防止踩到别人的库。
 *
 * 同机并行跑多个臂时必须能钉死端口（否则两个臂各自「先探活再绑定」会撞在同一个端口上，
 * 表现为 pg_ctl 报 `could not bind IPv4 address "127.0.0.1": Permission denied`）：
 * 给 `GY_PG_PORT` 就直接用它（仍校验区间外可用性），不给才随机挑。
 */
async function pickPort() {
  const fixed = process.env.GY_PG_PORT;
  if (fixed !== undefined && fixed.trim() !== '') {
    const candidate = Number(fixed.trim());
    assert.ok(
      Number.isInteger(candidate) && candidate >= 1024 && candidate <= 65535,
      `GY_PG_PORT 不是合法端口：${JSON.stringify(fixed)}`,
    );
    assert.notEqual(candidate, 55436, 'GY_PG_PORT 不得用 55436（该端口有遗留集群）');
    assert.ok(await portIsFree(candidate), `GY_PG_PORT=${candidate} 已被占用（换一个空闲端口）`);
    return candidate;
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = 55432 + randomInt(0, 36);
    if (candidate === 55436) continue;
    if (takenPorts.has(candidate)) continue;
    if (await portIsFree(candidate)) return candidate;
  }
  throw new Error('55432–55467 区间内找不到空闲端口（同机临时集群过多）');
}

/**
 * 子进程统一把 stdout/stderr 重定向到**文件**：本机 sandbox 禁止命名管道，
 * 用管道收集 postgres/pg_ctl 的输出会让调用方等 EOF 等到超时。
 */
function runTool(name, args) {
  const fd = openSync(logFile, 'a');
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

/**
 * `pg_ctl -o` 的 postgres 参数。
 *
 * POSIX 上**必须**把 unix socket 指到本集群自己的数据目录：Debian/Ubuntu（含 PGDG 的
 * `postgresql-17`）把编译默认 `unix_socket_directories` 钉成 `/var/run/postgresql`，
 * runner 的普通用户既写不了那个目录、只装包没启服务时该目录甚至不存在 ⇒ `pg_ctl start` 直接失败。
 */
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
  assert.ok(existsSync(tool('initdb')), `GY_PG_BIN 下没有 initdb：${tool('initdb')}`);
  // 只建父目录：数据目录交给 initdb 自己创建。先 mkdir 再 initdb 会让 initdb 去 chmod
  // 一个已存在的目录，在受限沙箱里 chmod 会 Permission denied（本机实测）。
  mkdirSync(rootDir, { recursive: true });
  const init = runTool('initdb', ['-D', dataDir, '--no-sync', '--encoding=UTF8', '--locale=C', '-U', 'postgres', '--auth=trust']);
  assert.equal(init.status, 0, `initdb 失败（status=${init.status}，日志见 ${logFile}）`);

  // 同一台机器上常有多个并行片同时起临时集群：端口在「本脚本 bind 探活通过」与
  // 「postgres 以 SO_EXCLUSIVEADDRUSE 独占绑定」之间可能被别人抢走，此时 Windows 报
  // `could not bind IPv4 address "127.0.0.1": Permission denied`（WSAEACCES）。
  // 这类失败只换端口重试，**不重跑 initdb**（数据目录已就绪）。
  let lastTail = '';
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    port = await pickPort();
    adminBase = `postgresql://postgres@127.0.0.1:${port}`;
    ownerBase = `${adminBase}/${DB_NAME}`;
    const start = runTool('pg_ctl', ['-D', dataDir, '-l', join(dataDir, 'server.log'), '-o', serverOptions(), '-t', '60', '-w', 'start']);
    if (start.status === 0) {
      note(`临时集群：数据目录 ${dataDir}，端口 ${port}（只监听 127.0.0.1）`);
      return;
    }
    lastTail = tailOfFile(join(dataDir, 'server.log'));
    const bindConflict = /could not bind|could not create any TCP\/IP sockets/i.test(lastTail);
    if (!bindConflict) break;
    takenPorts.add(port);
    note(`端口 ${port} 已被别的集群占用（bind 失败），换端口重试（第 ${attempt + 1} 次）`);
    runTool('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
  }
  assert.fail(`pg_ctl start 失败（工具日志见 ${logFile}；server.log 尾部：\n${lastTail}）`);
}

function stopCluster() {
  // 只删本脚本自己建的那个目录（名字前缀硬钉，避免误删工作树/源码）。
  assert.ok(basename(dataDir).startsWith('gy-r34-retention-pg-'), `拒绝删除非本脚本创建的目录：${dataDir}`);
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
// 跑工具的 helper：连接串只走 `DATABASE_URL`（与生产同一入口），输出落文件再读。
// ---------------------------------------------------------------------------
let runSeq = 0;
function runPurge(args, { url, label }) {
  runSeq += 1;
  const outFile = join(tmpdir(), `gy-r34-purge-run-${runSeq}-${randomBytes(3).toString('hex')}.txt`);
  const fd = openSync(outFile, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [toolPath, ...args], {
      stdio: ['ignore', fd, fd],
      env: { ...process.env, DATABASE_URL: url },
      timeout: 180_000,
      windowsHide: true,
    });
  } finally {
    closeSync(fd);
  }
  const text = readFileSync(outFile, 'utf8');
  rmSync(outFile, { force: true });
  note(`${label}：node tools/purge-retention-expired.mjs ${args.join(' ')} ⇒ exit=${result.status}`);
  return { status: result.status, text };
}

/** 从 `--json` 的末行取机读报告（前面是人读流水）。 */
function parseReport(text) {
  const lines = text.trimEnd().split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line.startsWith('{')) return JSON.parse(line);
  }
  throw new Error(`--json 没输出机读报告（末 5 行：${lines.slice(-5).join(' | ')}）`);
}

// ---------------------------------------------------------------------------
let owner;
const pendingPools = [];

try {
  await startCluster();
  const admin = await connectWithRetry(`${adminBase}/postgres`);
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();

  owner = await connectWithRetry(ownerBase);
  const version = (await owner.query('SHOW server_version')).rows[0].server_version;
  note(`PostgreSQL ${version}`);

  // ---- [0] 全链迁移：本片要的是 0001（users/admin_*）/ 0008（idempotency_keys）/ 0022（community_reports）----
  const discovered = readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  for (const name of discovered) await owner.query(readFileSync(new URL(name, migrationsDir), 'utf8'));
  const present = (
    await owner.query(
      `SELECT to_regclass('public.idempotency_keys') AS keys,
              to_regclass('public.sessions') AS sessions,
              to_regclass('public.admin_sessions') AS admin_sessions,
              to_regclass('public.community_reports') AS reports`,
    )
  ).rows[0];
  assert.deepEqual(present, {
    keys: 'idempotency_keys',
    sessions: 'sessions',
    admin_sessions: 'admin_sessions',
    reports: 'community_reports',
  }, '策略表登记的两张表 + 机制臂引用的两张表必须都在迁移后真实存在');
  say(`[0] 全链迁移 ${discovered.length} 个已应用；策略表 2 张表 + 机制臂 2 张表全部在岗`);

  // ---- [1] 造数：每张表都造「过期 / 未过期 / 贴边」三档，贴边档是最容易被写错的地方 ----
  const userId = (await owner.query("INSERT INTO public.users (nickname) VALUES ('r34-retention-subject') RETURNING id")).rows[0].id;
  const adminId = (
    await owner.query("INSERT INTO public.admin_accounts (login_name, credential_hash) VALUES ('r34-retention-admin', 'x') RETURNING id")
  ).rows[0].id;

  // 幂等台账：1200 行过期（为了让「分批」真的需要 3 批）、40 行未过期、7 行贴边（过期 12 小时，仍在 1 天宽限内）
  await owner.query(
    `INSERT INTO public.idempotency_keys (scope, key_hash, request_hash, response_status, created_at, expires_at)
     SELECT 'r34/expired/' || g, decode(md5(g::text) || md5('k' || g::text), 'hex'), repeat('a', 64), 200,
            now() - interval '3 days', now() - interval '2 days'
       FROM generate_series(1, 1200) AS g`,
  );
  await owner.query(
    `INSERT INTO public.idempotency_keys (scope, key_hash, request_hash, response_status, created_at, expires_at)
     SELECT 'r34/fresh/' || g, decode(md5('f' || g::text) || md5('fk' || g::text), 'hex'), repeat('b', 64), 200,
            now() - interval '1 hour', now() + interval '23 hours'
       FROM generate_series(1, 40) AS g`,
  );
  await owner.query(
    `INSERT INTO public.idempotency_keys (scope, key_hash, request_hash, response_status, created_at, expires_at)
     SELECT 'r34/borderline/' || g, decode(md5('b' || g::text) || md5('bk' || g::text), 'hex'), repeat('c', 64), 200,
            now() - interval '2 days', now() - interval '12 hours'
       FROM generate_series(1, 7) AS g`,
  );

  // 用户会话：5 行过期（过期 31 天 > 30 天窗口）、5 行未过期、3 行贴边（过期 29 天，还没到 30 天）
  await owner.query(
    `INSERT INTO public.sessions (user_id, token_hash, auth_epoch, created_at, expires_at)
     SELECT $1::uuid, decode(md5('s-old-' || g) || md5('so-' || g), 'hex'), 1, now() - interval '40 days', now() - interval '31 days'
       FROM generate_series(1, 5) AS g`,
    [userId],
  );
  await owner.query(
    `INSERT INTO public.sessions (user_id, token_hash, auth_epoch, created_at, expires_at)
     SELECT $1::uuid, decode(md5('s-new-' || g) || md5('sn-' || g), 'hex'), 1, now() - interval '1 day', now() + interval '1 day'
       FROM generate_series(1, 5) AS g`,
    [userId],
  );
  await owner.query(
    `INSERT INTO public.sessions (user_id, token_hash, auth_epoch, created_at, expires_at)
     SELECT $1::uuid, decode(md5('s-edge-' || g) || md5('se-' || g), 'hex'), 1, now() - interval '30 days', now() - interval '29 days'
       FROM generate_series(1, 3) AS g`,
    [userId],
  );

  // 后台会话：4 行过期（91 天 > 90 天窗口）、4 行未过期（89 天）—— 处置是「仅归档标记」，行不消失
  await owner.query(
    `INSERT INTO public.admin_sessions (admin_id, token_hash, auth_epoch, created_at, expires_at)
     SELECT $1::uuid, decode(md5('a-old-' || g) || md5('ao-' || g), 'hex'), 1, now() - interval '100 days', now() - interval '91 days'
       FROM generate_series(1, 4) AS g`,
    [adminId],
  );
  await owner.query(
    `INSERT INTO public.admin_sessions (admin_id, token_hash, auth_epoch, created_at, expires_at)
     SELECT $1::uuid, decode(md5('a-new-' || g) || md5('an-' || g), 'hex'), 1, now() - interval '90 days', now() - interval '89 days'
       FROM generate_series(1, 4) AS g`,
    [adminId],
  );

  // 举报台账：6 行超过 180 天（detail 应被清空、行保留）、4 行未超过、2 行「早就匿名化过」（重复执行不得再动）
  await owner.query(
    `INSERT INTO public.community_reports (id, revision, reporter_id, target_type, target_id, target_revision,
                                           state, reason_code, detail, created_at)
     SELECT gen_random_uuid(), 1, $1::uuid, 'post', gen_random_uuid(), 1, 'closed', 'privacy',
            'old-private-detail-' || g, now() - interval '200 days'
       FROM generate_series(1, 6) AS g`,
    [userId],
  );
  await owner.query(
    `INSERT INTO public.community_reports (id, revision, reporter_id, target_type, target_id, target_revision,
                                           state, reason_code, detail, created_at)
     SELECT gen_random_uuid(), 1, $1::uuid, 'comment', gen_random_uuid(), 1, 'closed', 'privacy',
            'recent-private-detail-' || g, now() - interval '100 days'
       FROM generate_series(1, 4) AS g`,
    [userId],
  );
  await owner.query(
    `INSERT INTO public.community_reports (id, revision, reporter_id, target_type, target_id, target_revision,
                                           state, reason_code, detail, created_at)
     SELECT gen_random_uuid(), 1, $1::uuid, 'post', gen_random_uuid(), 1, 'closed', 'other',
            NULL, now() - interval '220 days'
       FROM generate_series(1, 2) AS g`,
    [userId],
  );

  const snapshot = async () => {
    const row = (
      await owner.query(
        `SELECT (SELECT count(*) FROM public.idempotency_keys) AS keys,
                (SELECT count(*) FROM public.sessions) AS sessions,
                (SELECT count(*) FROM public.admin_sessions) AS admin_sessions,
                (SELECT count(*) FROM public.community_reports) AS reports,
                (SELECT count(*) FROM public.admin_sessions WHERE revoked_at IS NOT NULL) AS admin_marked,
                (SELECT count(*) FROM public.community_reports WHERE detail IS NULL) AS reports_scrubbed`,
      )
    ).rows[0];
    return {
      keys: Number(row.keys),
      sessions: Number(row.sessions),
      admin_sessions: Number(row.admin_sessions),
      reports: Number(row.reports),
      admin_marked: Number(row.admin_marked),
      reports_scrubbed: Number(row.reports_scrubbed),
    };
  };

  const before = await snapshot();
  assert.deepEqual(before, {
    keys: 1247, sessions: 13, admin_sessions: 8, reports: 12, admin_marked: 0, reports_scrubbed: 2,
  });
  say('[1] 造数就位：idempotency 1200 过期/40 未过期/7 贴边；sessions 5/5/3；admin_sessions 4/4；reports 6 超期/4 未超期/2 早已匿名');

  // ---- [2] dry-run（显式 --dry-run）：一行都不许写 ----
  const dry = runPurge(['--dry-run', '--json'], { url: ownerBase, label: '[2] dry-run' });
  assert.equal(dry.status, 0, `dry-run 必须退出 0（实际 ${dry.status}）：\n${dry.text}`);
  assert.match(dry.text, /mode=dry-run/);
  const dryReport = parseReport(dry.text);
  assert.equal(dryReport.dry_run, true);
  assert.equal(dryReport.entries.length, 2, '真实策略表只有 2 张表');
  assert.equal(dryReport.totals.rows, 1205, 'dry-run 汇总 = 1200 幂等台账 + 5 会话（另外两张表已降级为排除项）');
  assert.equal(dryReport.totals.batches, 0, 'dry-run 不许开批次');
  assert.equal(dryReport.totals.failures, 0);
  assert.deepEqual(await snapshot(), before, 'dry-run 之后库里的行数与标记必须一模一样');
  assert.doesNotMatch(dry.text, /tx=committed/, 'dry-run 不许提交任何事务');
  assert.doesNotMatch(dry.text, /postgres(ql)?:\/\//, '输出不得回显连接串');
  say('[2] dry-run：报告 rows=1205 batches=0，库内计数与标记前后完全一致（一行未写）');

  // ---- [3] 真执行：只动过期行，三种处置各按本分做事 ----
  const real = runPurge(['--yes', '--batch', '500', '--max-batches', '10', '--json'], { url: ownerBase, label: '[3] --yes' });
  assert.equal(real.status, 0, `真执行必须退出 0（实际 ${real.status}）：\n${real.text}`);
  assert.match(real.text, /mode=execute/);
  const realReport = parseReport(real.text);
  assert.equal(realReport.totals.failures, 0);
  const byTable = Object.fromEntries(realReport.entries.map((entry) => [entry.table, entry]));
  assert.equal(realReport.entries.length, 2);
  assert.equal(byTable['public.idempotency_keys'].rows, 1200);
  assert.equal(byTable['public.idempotency_keys'].batches, 3, '1200 行按 500/500/200 三批');
  assert.equal(byTable['public.idempotency_keys'].drained, true);
  assert.equal(byTable['public.sessions'].rows, 5);
  assert.equal(realReport.totals.rows, 1205);
  assert.equal(realReport.totals.batches, 4, '幂等台账 3 批（500/500/200）+ 会话 1 批');
  assert.equal(realReport.totals.drained, 2);
  assert.match(real.text, /tx=committed/);

  const after = await snapshot();
  assert.deepEqual(after, {
    keys: 47, // 40 未过期 + 7 贴边（过期 12h，仍在 1 天宽限内）
    sessions: 8, // 5 未过期 + 3 贴边（过期 29 天 < 30 天窗口）
    admin_sessions: 8, // 一行都没少：本片不登记它（90 天无出处）
    reports: 12, // 一行都没少：本片不登记它（180 天无出处）
    admin_marked: 0, // 一行都没标记
    reports_scrubbed: 2, // 仍是造数时那 2 行「早已匿名」，本片没再动
  }, '真执行后：过期行消失，未过期/贴边行原样；两张降级表的行数、标记、detail 全部零改动');
  say('[3] 真执行：删 1200+5 行；未过期与贴边行一行未动（keys=47 / sessions=8）；两张降级表零改动');

  // 逐条复核「只删过期、降级表不动」，而不是只看行数
  const leftovers = (
    await owner.query(
      `SELECT (SELECT count(*) FROM public.idempotency_keys WHERE expires_at < now() - interval '1 day') AS stale_keys,
              (SELECT count(*) FROM public.sessions WHERE expires_at < now() - interval '30 days') AS stale_sessions,
              (SELECT count(*) FROM public.admin_sessions WHERE revoked_at IS NOT NULL) AS admin_marked,
              (SELECT count(*) FROM public.admin_sessions
                WHERE expires_at < now() - interval '90 days' AND revoked_at IS NULL) AS stale_unmarked_admins,
              (SELECT count(*) FROM public.community_reports
                WHERE detail IS NOT NULL AND created_at < now() - interval '180 days') AS stale_report_details,
              (SELECT count(*) FROM public.community_reports WHERE revision <> 1) AS bumped_revisions`,
    )
  ).rows[0];
  assert.deepEqual(
    {
      stale_keys: Number(leftovers.stale_keys),
      stale_sessions: Number(leftovers.stale_sessions),
      admin_marked: Number(leftovers.admin_marked),
      stale_unmarked_admins: Number(leftovers.stale_unmarked_admins),
      stale_report_details: Number(leftovers.stale_report_details),
      bumped_revisions: Number(leftovers.bumped_revisions),
    },
    {
      stale_keys: 0,
      stale_sessions: 0,
      admin_marked: 0,
      stale_unmarked_admins: 4, // 4 行超期后台会话仍是「过期未标记」：本片不登记该表
      stale_report_details: 6, // 6 行超期举报的 detail 仍非空：本片不登记该表
      bumped_revisions: 0, // revision 一动没动
    },
  );
  say('[4] 复核：过期行清零；降级表一行未动（admin_sessions 4 行超期未标记 / community_reports 6 行 detail 非空，revision 全为 1）');

  // ---- [5] 再跑一次：0 行、退出 0（幂等；cron 的日常读数就长这样）----
  const again = runPurge(['--yes', '--json'], { url: ownerBase, label: '[5] 重复执行' });
  assert.equal(again.status, 0, `重复执行必须退出 0（0 行不是失败）：\n${again.text}`);
  const againReport = parseReport(again.text);
  assert.equal(againReport.totals.rows, 0);
  // 第二轮的 batches 是「尝试过的批次」= 每表一次空批（2 张表 ⇒ 2），行数必须是 0。
  assert.equal(againReport.totals.batches, 2, '空批也是一批：每张表都会试一次，然后第一轮就 drained');
  for (const entry of againReport.entries) {
    assert.equal(entry.rows, 0, `${entry.table} 第二轮必须 0 行`);
    assert.equal(entry.drained, true);
    assert.equal(entry.batches, 1);
  }
  assert.deepEqual(await snapshot(), after, '重复执行不改任何行');
  assert.match(again.text, /没有到期行/);
  say('[5] 重复执行：rows=0（2 张表各一次空批）exit=0，库内状态与上一轮完全一致');

  // ---- [6] 机制臂：真实策略表已不登记这两张表，但 archive_marker / anonymize+revision 的 SQL
  // 必须仍然可执行、可重复。用**合成策略行**（不是仓内口径；仓内口径在 RETENTION_EXCLUSIONS 里）
  // 在这同一个临时库上走一遍 in-process API，证明机制没坏、将来启用时不必重写 SQL。
  const MARKER_ENTRY = Object.freeze({
    table: 'public.admin_sessions',
    ageColumn: 'expires_at',
    retentionDays: 90,
    basis: 'audit',
    basisRef: 'docs/implementation-requirements.md:284',
    disposition: 'archive_marker',
    targetColumn: 'revoked_at',
    markerSource: 'age_column',
    revisionColumn: null,
    why: '机制臂合成行：只为证明归档标记 SQL 在真库可执行（仓内策略表不登记本表）',
    idempotent: true,
  });
  const ANONYMIZE_ENTRY = Object.freeze({
    table: 'public.community_reports',
    ageColumn: 'created_at',
    retentionDays: 180,
    basis: 'legal',
    basisRef: 'docs/implementation-requirements.md:284',
    disposition: 'anonymize',
    targetColumn: 'detail',
    markerSource: null,
    revisionColumn: 'revision',
    why: '机制臂合成行：只为证明匿名化 SQL 会按 store-pg.ts:1005-1011 同口径推进 revision（仓内策略表不登记本表）',
    idempotent: true,
  });
  const mechClient = new pg.Client({ connectionString: ownerBase });
  await mechClient.connect();
  try {
    const mechNow = (await mechClient.query('SELECT now() AS now')).rows[0].now;
    const mechRun = () => runRetentionPurge({
      connect: async () => ({
        query: (text, params) => mechClient.query(text, params),
        release: () => {},
      }),
      now: mechNow,
      dryRun: false,
      policy: [MARKER_ENTRY, ANONYMIZE_ENTRY],
    });

    const mechReport = await mechRun();
    assert.equal(mechReport.totals.failures, 0, `机制臂不该失败：${JSON.stringify(mechReport.entries)}`);
    assert.equal(mechReport.totals.rows, 10, '4 行超期后台会话被标记 + 6 行超期举报被匿名化');
    assert.equal(mechReport.entries[0].disposition, 'archive_marker');
    assert.equal(mechReport.entries[1].revision_column, 'revision');

    const mechState = (
      await owner.query(
        `SELECT (SELECT count(*) FROM public.admin_sessions WHERE revoked_at IS NOT NULL) AS marked_admins,
                (SELECT count(*) FROM public.admin_sessions
                  WHERE revoked_at IS NOT NULL AND revoked_at IS DISTINCT FROM expires_at) AS bad_markers,
                (SELECT count(*) FROM public.community_reports
                  WHERE created_at < now() - interval '180 days' AND detail IS NULL) AS scrubbed_reports,
                (SELECT count(*) FROM public.community_reports
                  WHERE created_at < now() - interval '180 days' AND detail IS NULL AND revision = 2) AS bumped,
                (SELECT count(*) FROM public.community_reports
                  WHERE detail IS NULL AND revision = 1) AS untouched_revisions`,
      )
    ).rows[0];
    assert.equal(Number(mechState.marked_admins), 4);
    assert.equal(Number(mechState.bad_markers), 0, 'archive_marker 写入的值必须恰好是 age 列的值');
    assert.equal(Number(mechState.scrubbed_reports), 8, '原有 2 + 本次 6');
    assert.equal(Number(mechState.bumped), 6, '本次被匿名化的 6 行 revision 必须 1→2');
    assert.equal(Number(mechState.untouched_revisions), 2, '早已匿名的 2 行 detail 本就为 NULL ⇒ 不该被再次清理、revision 仍为 1');

    const mechAgain = await mechRun();
    assert.equal(mechAgain.totals.rows, 0, '机制臂第二轮必须 0 行（两条谓词各自带 IS NULL 闸门）');
    assert.equal(mechAgain.totals.failures, 0);
  } finally {
    await mechClient.end().catch(() => {});
  }
  say('[6] 机制臂（合成策略行）：标记 4 行（值 = expires_at）、匿名化 6 行且 revision 1→2、早已匿名 2 行未再动、第二轮 0 行');

  // ---- [7] 权限失败：没有 DELETE 授权的表必须如实报 PERMISSION_DENIED，另一张表照跑 ----
  // 只给「幂等台账 DELETE + 两张表的 SELECT」，**故意不给** sessions 的 DELETE。
  const limitedPassword = randomBytes(18).toString('hex');
  await owner.query(`DROP ROLE IF EXISTS ${LIMITED_ROLE}`);
  await owner.query(`CREATE ROLE ${LIMITED_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${limitedPassword}'`);
  await owner.query(`GRANT SELECT ON public.idempotency_keys, public.sessions TO ${LIMITED_ROLE}`);
  await owner.query(`GRANT DELETE ON public.idempotency_keys TO ${LIMITED_ROLE}`);

  // 重新造一轮「两张表各有一条到期行」，这样失败表能证明「一行未动」，能跑的表证明「照跑」。
  await owner.query(
    `INSERT INTO public.sessions (user_id, token_hash, auth_epoch, created_at, expires_at)
     VALUES ($1::uuid, decode(md5('s-perm') || md5('sp'), 'hex'), 1, now() - interval '40 days', now() - interval '35 days')`,
    [userId],
  );
  await owner.query(
    `INSERT INTO public.idempotency_keys (scope, key_hash, request_hash, response_status, created_at, expires_at)
     VALUES ('r34/permission', decode(md5('perm') || md5('pk'), 'hex'), repeat('d', 64), 200,
             now() - interval '3 days', now() - interval '2 days')`,
  );

  const limitedUrl = `postgresql://${LIMITED_ROLE}:${limitedPassword}@127.0.0.1:${port}/${DB_NAME}`;
  const denied = runPurge(['--yes', '--json'], { url: limitedUrl, label: '[7] 受限角色' });
  assert.equal(denied.status, 1, `有表失败时退出码必须是 1（实际 ${denied.status}）：\n${denied.text}`);
  const deniedReport = parseReport(denied.text);
  const deniedByTable = Object.fromEntries(deniedReport.entries.map((entry) => [entry.table, entry]));
  assert.equal(deniedReport.totals.failures, 1);
  assert.equal(deniedReport.totals.rows, 1, '失败表拖不动别人：有授权的那张表照样处理 1 行');
  assert.equal(deniedByTable['public.sessions'].error, 'PERMISSION_DENIED', '缺 DELETE 授权必须分类为 PERMISSION_DENIED');
  assert.equal(deniedByTable['public.sessions'].rows, 0);
  assert.equal(deniedByTable['public.idempotency_keys'].error, null);
  assert.equal(deniedByTable['public.idempotency_keys'].rows, 1, '失败了别的表也要照跑');
  assert.match(denied.text, /FAIL table=public\.sessions code=PERMISSION_DENIED/);
  assert.doesNotMatch(denied.text, new RegExp(limitedPassword), '输出不得回显口令');

  const permState = (
    await owner.query(
      `SELECT (SELECT count(*) FROM public.sessions WHERE expires_at < now() - interval '30 days') AS stale_sessions,
              (SELECT count(*) FROM public.idempotency_keys WHERE scope = 'r34/permission') AS perm_keys`,
    )
  ).rows[0];
  assert.equal(Number(permState.stale_sessions), 1, '失败表必须一行未动（事务回滚）');
  assert.equal(Number(permState.perm_keys), 0, '有授权的表照常处理');
  say('[7] 受限角色：sessions 报 PERMISSION_DENIED 且一行未动，幂等台账照跑；exit=1');

  console.log(`\n全绿：${passed} 个断言组通过（临时集群端口 ${port}，日志 ${logFile}）`);
  process.exitCode = 0;
} catch (error) {
  console.error('\n真库臂失败：');
  console.error(error);
  console.error(`\n工具日志：${logFile}`);
  console.error(`server.log 尾部：\n${tailOfFile(join(dataDir, 'server.log'), 30)}`);
  process.exitCode = 1;
} finally {
  for (const pool of pendingPools) await pool?.end?.().catch(() => {});
  await owner?.end?.().catch(() => {});
  try {
    if (existsSync(join(dataDir, 'PG_VERSION'))) stopCluster();
  } catch (error) {
    console.error(`清理临时集群失败（需手动删除 ${dataDir}）：${error.message}`);
  }
}
