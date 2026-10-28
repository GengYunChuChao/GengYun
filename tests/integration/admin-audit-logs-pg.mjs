/**
 * 真库臂：`GET /admin/audit-logs` 的读通道（迁移 0033 的 `public.list_admin_audit_logs()`）。
 *
 * 为什么要有这一臂
 * ----------------
 * 单测用假 port，证明不了 SQL 本身：七个参数怎么绑、键集比较用的是不是 `(created_at, id)`、
 * `SECURITY DEFINER` 之后运行时角色到底还能不能读表、以及 `target_ref` 的允许列表投影是否真
 * 把多余键裁掉。这些只有真 PG 才能回答。
 *
 * 本臂自己起**一次性集群**（`initdb` 新目录），因此不依赖本机既有实例；端口由 `./lib/free-port.mjs`
 * 向内核要一个此刻空闲的（⛔ 不再在 55436–55467 这种固定区间里挑：那落在 Linux ephemeral 区间内），
 * 收尾 `pg_ctl stop` + 删数据目录（`server.log` 随目录删；工具日志在 root 下、不删、取证用）。
 *
 * 怎么跑
 * ------
 *   $env:GY_PG_BIN = 'E:\GengYunCommander\.pg17\pgsql\bin'   # 含 initdb/pg_ctl 的目录（PG 17.11）
 *   $env:GY_R34_PG_ROOT = 'E:\GengYunCommander\.pg17\tmp'    # 可选：数据目录的父目录
 *   node tests/integration/admin-audit-logs-pg.mjs
 *
 * 没设 `GY_PG_BIN` 时**明确 SKIP**：打印 3 行原因并以 **77 退出**（未取得，不是通过）——
 * 与 `backup-purge-pg` / `online-purge-pg` 等自起集群脚本同一口径；77 由调用方（workflow）显式判红。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync,
} from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { createAdminAuditLogService } from '../../services/api/src/admin/audit/service.ts';
import { createPostgresAdminAuditLogPort } from '../../services/api/src/admin/audit/pg.ts';
import { createPool } from '../../services/api/src/db/pool.ts';
import { pickFreePort } from './lib/free-port.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const binDir = (process.env.GY_PG_BIN ?? '').trim();
const DB_NAME = 'gengyun_r34_audit_logs_test';
const RUNTIME_ROLE = 'gengyun_api_runtime';
const RUNTIME_PASSWORD = 'r34auditarm';
/** 起集群最多换几个候选端口（每个都来自内核分配；见 `startCluster()`）。 */
const MAX_PORT_ATTEMPTS = 8;
const UNGRANTED_ROLE = 'r34_audit_logs_no_grant';
const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQUEST_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SIGNING_KEY = 'gy-r34-audit-logs-arm-signing-key';
const NOW = () => new Date('2026-10-23T00:00:00.000Z');
const TOOL = name => join(binDir, process.platform === 'win32' ? `${name}.exe` : name);
const pass = line => console.log(`  ✓ ${line}`);
const note = line => console.log(`  · ${line}`);

if (binDir === '' || !existsSync(TOOL('initdb'))) {
  console.log(
    'SKIP: 未设置 GY_PG_BIN（含 initdb/pg_ctl 的目录）⇒ 真库臂跳过，'
      + '没有验证迁移 0033 的读通道（未取得，不是通过）。',
  );
  console.log('SKIP: 本臂只认 GY_PG_BIN 指向的 PG 17 二进制（initdb/pg_ctl），找不到就整链未取得。');
  console.log('SKIP: 退出码 77 ＝ 未取得（⛔ 不是通过）；调用方必须把它显式判红，另见 tests/unit/integration-script-coverage.test.mjs。');
  // 77 ＝ 未取得（POSIX skipped），⛔ 不是 0：整链跳过不许被读成通过。
  process.exit(77);
}

const rootDir = (process.env.GY_R34_PG_ROOT ?? tmpdir()).trim();
let dataDir = '';
const toolLog = join(rootDir, 'gy-r34-audit-logs-pg-tools.log');
mkdirSync(rootDir, { recursive: true });
const logFd = openSync(toolLog, 'a');

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

/**
 * 端口是否已有人在听？
 *
 * 本机是 Windows：`SO_REUSEADDR` 允许「绑定别人已经监听的地址」，所以**不能**用 `listen()`
 * 成功与否判断空闲（本片踩过：Node 认为 55432 空闲，postgres 却拿到 WSAEACCES）。能连上就是
 * 有人；连不上（ECONNREFUSED）才可以往下试。
 */
function portBusy(candidate) {
  return new Promise((resolve) => {
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

/** 从部署 SQL 里原样抽出授权段（运维执行顺序：迁移 ⇒ 20-login-roles.sql）。 */
function grantRegion(file, region) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const start = text.indexOf(`-- #region ${region}`);
  const end = text.indexOf(`-- #endregion ${region}`);
  assert.ok(start >= 0 && end > start, `部署 SQL 里找不到授权段 ${region}`);
  return text.slice(start, end);
}

let port = 0;
let ownerUrl = '';
let runtimeUrl = '';
let ownerPool = null;
let runtimePool = null;

/**
 * 起一次性集群：最多试 `MAX_PORT_ATTEMPTS` 个候选，每个候选都向内核要（`pickFreePort()`）。
 *
 * ⛔ 不再「在 55436–55467 里逐个数字试」：那段落在 Linux 默认 ephemeral 区间 32768–60999 内，
 * 会被任何出站连接的源端口占住，`pg_ctl start` 就偶发
 * `could not bind IPv4 address "127.0.0.1": Address already in use`（C05 真库臂事故同一根因）。
 *
 * 为什么挑到空口还要「起不来就换一个」：Windows 还有**保留/排除端口区间**
 * （`netsh int ipv4 show excludedportrange protocol=tcp`，本机 55441–55540 在列），
 * postgres 在这些端口上会拿到 WSAEACCES。所以真正的判据是「postgres 能不能 bind」——
 * 失败就换下一个候选，并把原因如实打出来（不静默降级、不假装通过）。
 * 同理保留 `portBusy()` 先探活：Windows 上 `listen()` 成功**不**证明端口空闲
 * （SO_REUSEADDR 语义），只有 connect 才会告诉你「已经有人在监听」。
 *
 * POSIX 上还**必须**把 unix socket 指到本集群自己的数据目录：Debian/Ubuntu（含 PGDG 的
 * `postgresql-17`）把编译默认 `unix_socket_directories` 钉成 `/var/run/postgresql`，runner
 * 的普通用户写不了 ⇒ `pg_ctl start` 直接 FATAL `could not create lock file
 * "/var/run/postgresql/.s.PGSQL.<port>.lock"`（2026-10-27 CI 实测，见 R66 证据页 §5.4）。
 * 本臂原先只在 Windows 上跑过（Windows 不用 unix socket），所以这一条一直没暴露。
 */
function serverOptions(candidate, dir) {
  const options = [`-p ${candidate}`, '-c listen_addresses=127.0.0.1', '-c max_connections=32'];
  if (process.platform !== 'win32') options.push(`-k ${dir}`);
  return options.join(' ');
}

async function startCluster() {
  const tried = [];
  const seen = new Set();
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const candidate = await pickFreePort();
    if (seen.has(candidate)) {
      tried.push(`${candidate}:本轮已试过`);
      continue;
    }
    seen.add(candidate);
    // eslint-disable-next-line no-await-in-loop
    if (await portBusy(candidate)) {
      tried.push(`${candidate}:已有人监听`);
      continue;
    }
    const dir = join(rootDir, `gy-r34-audit-logs-pg-${candidate}-${randomUUID().slice(0, 6)}`);
    mkdirSync(dir, { recursive: true });
    const init = runTool('initdb', [
      '-D', dir, '--no-sync', '--encoding=UTF8', '--locale=C', '-U', 'postgres', '--auth=trust',
    ]);
    if (init.status !== 0) {
      tried.push(`${candidate}:initdb=${init.status}`);
      rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
      continue;
    }
    const start = runTool('pg_ctl', [
      '-D', dir,
      '-l', join(dir, 'server.log'),
      '-o', serverOptions(candidate, dir),
      '-t', '60', '-w', 'start',
    ]);
    if (start.status !== 0) {
      const reason = tail(join(dir, 'server.log'), 6)
        .split('\n')
        .filter(line => line.includes('FATAL') || line.includes('ERROR'))
        .slice(-1)[0] ?? '见 server.log';
      tried.push(`${candidate}:${reason.slice(0, 80)}`);
      runTool('pg_ctl', ['-D', dir, '-m', 'immediate', '-w', 'stop'], { timeout: 60_000 });
      rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
      continue;
    }

    port = candidate;
    dataDir = dir;
    ownerUrl = `postgresql://postgres@127.0.0.1:${port}/${DB_NAME}`;
    runtimeUrl = `postgresql://${RUNTIME_ROLE}:${RUNTIME_PASSWORD}@127.0.0.1:${port}/${DB_NAME}`;
    note(`临时集群：${dir}，端口 ${port}（仅 127.0.0.1）`);

    const admin = await connectWithRetry(`postgresql://postgres@127.0.0.1:${port}`);
    try {
      const { rows } = await admin.query('SHOW server_version');
      note(`server_version = ${rows[0].server_version}`);
    } finally {
      await admin.end();
    }
    return;
  }
  throw new Error(`连续 ${MAX_PORT_ATTEMPTS} 次都没能起出一个临时集群：${tried.join('；')}`);
}

function stopCluster() {
  if (!basename(dataDir).startsWith('gy-r34-audit-logs-pg-')) {
    throw new Error(`拒绝删除非本脚本创建的目录：${dataDir}`);
  }
  if (existsSync(join(dataDir, 'PG_VERSION'))) {
    const stop = runTool('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { timeout: 60_000 });
    // 必须显式判返回码与 `error`：`spawnSync` 在 stdio 里拿到**已关闭的 fd** 时**不抛错**，只把失败
    // 塞进 `error`（此时 `status` 为 `null`）。只看 `status` 或干脆不看返回值，这次「停止」就会静默
    // 不执行 —— 2026-10-27 之前本臂正是这样：`closeSync(logFd)` 排在 `stopCluster()` 之前，
    // 每次 stop 都拿到 `status=null / error.code=EBADF` 并被丢弃，于是集群留在宿主上、目录删不掉，
    // 而读数照绿（R66 复盘；现改为收尾之后才关 fd，见 finally 里的注释）。
    if (stop.error || stop.status !== 0) {
      const reason = stop.error
        ? `${stop.error.code ?? 'ERROR'} ${stop.error.message}`.trim()
        : `exit ${stop.status}`;
      throw new Error(`pg_ctl stop 失败：${reason}（目录 ${dataDir}，需人工清理）`);
    }
  }
  // `pg_ctl -w stop` 返回不等于 postgres 已经放开文件句柄：先等 postmaster.pid 消失，再删目录。
  // 删不掉不算测试失败（读数已经拿到），只打印目录路径让人工清理。
  for (let wait = 0; wait < 100; wait += 1) {
    if (!existsSync(join(dataDir, 'postmaster.pid'))) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  }
  console.warn(`⚠ 临时集群目录未能删除（句柄滞留，不影响读数）：${dataDir}`);
}

async function bootstrapDatabase() {
  const admin = await connectWithRetry(`postgresql://postgres@127.0.0.1:${port}`);
  try {
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    await admin.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${RUNTIME_PASSWORD}'`);
    await admin.query(`CREATE ROLE ${UNGRANTED_ROLE} LOGIN PASSWORD '${RUNTIME_PASSWORD}'`);
    await admin.query(`GRANT CONNECT ON DATABASE ${DB_NAME} TO ${RUNTIME_ROLE}, ${UNGRANTED_ROLE}`);
  } finally {
    await admin.end();
  }

  // 迁移走**生产路径**（migrate.ts up），不是手抄 SQL：这样 0033 的发现/校验/编号规则都真跑一遍。
  const migrate = spawnSync(
    process.execPath,
    [join(ROOT, 'services/api/src/db/migrate.ts'), 'up'],
    {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: ownerUrl },
      stdio: ['ignore', logFd, logFd],
      timeout: 180_000,
      windowsHide: true,
    },
  );
  assert.equal(
    migrate.status,
    0,
    `migrate.ts up 失败（status=${migrate.status}，日志见 ${toolLog}；尾部：\n${tail(toolLog, 25)}）`,
  );

  ownerPool = createPool(ownerUrl);
  assert.ok(ownerPool !== null);
  const applied = await ownerPool.query(
    'SELECT version FROM public.schema_migrations ORDER BY version DESC LIMIT 1',
  );
  // 版本钉是**字面量**，新增迁移落地时要把这里同步到新的末位号（本切片：仓库末位＝`0048`）。
  // 演进史：曾钉 `'0033'`，迁移推到 0044 后陈旧了 11 号 —— 当时本文件**尚未**接入
  // `.github/workflows/real-pg-integration.yml`，没有 CI 来提醒，只能靠这条注释；
  // （R66 起它已是 `real-pg-17.11` job 里的一步：钉旧了 CI 直接红，这条注释退回「演进史」用途。）
  // 第二次：S3 片 A 的 0045（人工 approve/reject 的施动者快照列 `decided_by`）落地，末位随之前移到 0045。
  // ⛔ 也不要图省事改成「取迁移目录末项再比」：`tests/unit/migration-pin-guard.test.mjs` 把
  // 「读迁移清单末位」整类列为仓库级红项（D1 末项索引 / D2 `.at(-1)` 等形态，跨 PR 互斥）——
  // 本切片实测这样写会让该守卫用例直接变红。
  // 第三次：`#18` S2 收尾片的 0046（scope 操作被拒的留痕写入口 `record_admin_scope_denial`）落地，末位随之前移到 0046。
  // 第四次：R64 的 0047（后台下架 `post.hide` 的审计真落库 `record_admin_post_hide_audit`）落地，末位随之前移到 0047。
  // 第五次：R68 的 0048（后台**停用/恢复管理员账号**的唯一写入口 `disable_admin_account` /
  // `enable_admin_account`）落地，末位随之前移到 0048。
  // 第六次：R68-A01 的 0049（后台分类字典 `public.admin_categories` + 审计窄函数
  // `record_admin_category_update`）落地，末位随之前移到 0049。
  assert.equal(applied.rows[0].version, '0049', '迁移 0049（R68-A01：后台分类字典 public.admin_categories 与审计窄函数 record_admin_category_update，与审计同事务；此前 0048 是 R68 的 disable_admin_account / enable_admin_account、0047 是 R64 的 record_admin_post_hide_audit）必须是最后一条已应用版本');
  pass('迁移 0049 经 migrate.ts up 落到真库（schema_migrations 末项 0049）');

  await ownerPool.query(`GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE}, ${UNGRANTED_ROLE}`);
  const region = grantRegion('deploy/postgres-cvm/sql/20-login-roles.sql', 'gy-r34-audit-logs-grant');
  await ownerPool.query(region);
  pass('部署授权段 gy-r34-audit-logs-grant 原样执行通过（存在性检查 + REVOKE PUBLIC + GRANT 运行时）');

  runtimePool = createPool(runtimeUrl);
  assert.ok(runtimePool !== null);
}

// ---------------------------------------------------------------------------
// 造数：六行，覆盖「三个写入点的真实形状」+ 键集并列 + 时间窗外 + target_ref 夹带多余键
// ---------------------------------------------------------------------------
const ROWS = [
  {
    id: '00111111-1111-4111-8111-111111111111',
    action: 'account.suspend',
    scope: 'accounts:suspend',
    target_hint: 'account:99999999-9999-4999-8999-999999999999',
    reason_code: 'account_suspended',
    created_at: '2026-10-20T10:00:00.000Z',
  },
  {
    id: '00222222-2222-4222-8222-222222222222',
    action: 'account.restore',
    scope: 'accounts:suspend',
    target_hint: 'account:99999999-9999-4999-8999-999999999999',
    reason_code: 'account_restored',
    created_at: '2026-10-20T10:00:01.000Z',
  },
  {
    // target_ref 里故意夹带 ip / credential：读通道只允许 type/id/revision，多出来的必须被裁掉。
    id: '00333333-3333-4333-8333-333333333333',
    action: 'set_flag',
    scope: 'flags:write',
    target_hint: 'community.posts.hide',
    reason_code: 'manual_takedown',
    created_at: '2026-10-20T10:00:02.000Z',
    target_ref: {
      type: 'job',
      id: '77777777-7777-4777-8777-777777777777',
      revision: 1,
      ip: '203.0.113.7',
      credential: 'hidden-secret',
      user_agent: 'Mozilla/5.0 (r34 arm)',
    },
    before_value: { enabled: false, revision: 3 },
    after_value: { enabled: true, revision: 4 },
  },
  {
    // 与下一行 created_at 完全相同：键集必须靠 id 决定先后，否则翻页会漏行/重复。
    id: '00100000-0000-4000-8000-000000000000',
    action: 'set_flag',
    scope: 'flags:write',
    target_hint: 'community.posts.hide',
    reason_code: 'manual_takedown',
    created_at: '2026-10-20T10:00:03.000Z',
  },
  {
    id: '00200000-0000-4000-8000-000000000000',
    action: 'set_flag',
    scope: 'flags:write',
    target_hint: 'community.posts.hide',
    reason_code: 'manual_takedown',
    created_at: '2026-10-20T10:00:03.000Z',
  },
  {
    // 时间窗外：from 过滤必须把它排除。
    id: '00444444-4444-4444-8444-444444444444',
    action: 'account.suspend',
    scope: 'accounts:suspend',
    target_hint: 'account:88888888-8888-4888-8888-888888888888',
    reason_code: 'account_suspended',
    created_at: '2026-10-19T23:00:00.000Z',
  },
];

async function seedRows() {
  for (const row of ROWS) {
    await ownerPool.query(
      `INSERT INTO public.admin_audit_events
         (id, actor_id, action, scope, target_ref, target_hint, reason_code,
          request_id, result, before_value, after_value, created_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7, $8::uuid, $9, $10::jsonb, $11::jsonb, $12::timestamptz)`,
      [
        row.id,
        ADMIN_ID,
        row.action,
        row.scope,
        row.target_ref === undefined ? null : JSON.stringify(row.target_ref),
        row.target_hint,
        row.reason_code,
        REQUEST_ID,
        'accepted',
        row.before_value === undefined ? null : JSON.stringify(row.before_value),
        row.after_value === undefined ? null : JSON.stringify(row.after_value),
        row.created_at,
      ],
    );
  }
  pass(`造数 ${ROWS.length} 行（三写入点形状 + 键集并列 + 时间窗外 + target_ref 夹带多余键）`);
}

async function assertPrivileges() {
  const { rows } = await ownerPool.query(
    `SELECT has_table_privilege($1, 'public.admin_audit_events', 'SELECT') AS table_select,
            has_function_privilege($1,
              'public.list_admin_audit_logs(integer,timestamp with time zone,timestamp with time zone,text[],text[],timestamp with time zone,uuid)',
              'EXECUTE') AS fn_execute,
            has_function_privilege($2,
              'public.list_admin_audit_logs(integer,timestamp with time zone,timestamp with time zone,text[],text[],timestamp with time zone,uuid)',
              'EXECUTE') AS ungranted_execute`,
    [RUNTIME_ROLE, UNGRANTED_ROLE],
  );
  const row = rows[0];
  assert.equal(row.table_select, false, '运行时角色不得拥有 admin_audit_events 的 SELECT（最小权限）');
  assert.equal(row.fn_execute, true, '运行时角色必须能 EXECUTE 只读函数（授权段生效）');
  assert.equal(row.ungranted_execute, false, '未授权角色不得能 EXECUTE 只读函数（负向对照）');
  pass('权限：运行时零表级 SELECT、函数 EXECUTE 已授予、未授权角色被拒（负向对照）');

  let denied = null;
  try {
    await runtimePool.query('SELECT 1 FROM public.admin_audit_events LIMIT 1');
  } catch (error) {
    denied = error;
  }
  assert.ok(denied !== null, '运行时角色直接查表必须失败，不能悄悄成功');
  assert.equal(denied.code, '42501', `直查表应以 insufficient_privilege(42501) 失败，实际 ${denied.code}`);
  pass('运行时直查表被数据库拒（SQLSTATE 42501），读面只能走函数');
}

async function runService() {
  const port_ = createPostgresAdminAuditLogPort({ pool: runtimePool });
  const service = createAdminAuditLogService({
    port: port_,
    now: NOW,
    signingKey: SIGNING_KEY,
    executionMode: 'real',
  });
  const context = {
    identity: { userId: ADMIN_ID, authEpoch: 1, role: 'admin', scopes: ['audit:read'] },
    requestId: REQUEST_ID,
  };
  return { service, context };
}

async function main() {
  await startCluster();
  await bootstrapDatabase();
  await seedRows();
  await assertPrivileges();

  const { service, context } = await runService();

  // 1) 全量顺序：created_at DESC，并列时 id DESC。
  const all = await service.listAuditLogs(context, { limit: 50 });
  assert.equal(all.status, 200);
  assert.equal(all.headers['Cache-Control'], 'no-store');
  assert.deepEqual(
    all.body.data.items.map(item => item.id),
    [
      '00200000-0000-4000-8000-000000000000',
      '00100000-0000-4000-8000-000000000000',
      '00333333-3333-4333-8333-333333333333',
      '00222222-2222-4222-8222-222222222222',
      '00111111-1111-4111-8111-111111111111',
      '00444444-4444-4444-8444-444444444444',
    ],
    '全量顺序必须是 created_at DESC, id DESC（并列行靠 id 定序）',
  );
  pass('条数与顺序：6 行，created_at DESC + id DESC（并列组 id 大者在前）');

  // 2) 键集翻页：limit=2，三页收全，无重复无遗漏。
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = await service.listAuditLogs(context, { limit: 2, ...(cursor === null ? {} : { cursor }) });
    assert.equal(page.status, 200);
    seen.push(...page.body.data.items.map(item => item.id));
    cursor = page.body.data.next_cursor;
    pages += 1;
    assert.ok(pages <= 10, '翻页次数异常（游标可能没有推进）');
  } while (cursor !== null);
  assert.deepEqual(seen, all.body.data.items.map(item => item.id), '键集翻页必须与全量顺序逐项一致');
  assert.equal(new Set(seen).size, seen.length, '翻页不得重复');
  assert.equal(pages, 3, '6 行 / 每页 2 行必须恰好 3 页');
  pass('键集翻页：3 页收全 6 行，顺序一致、无重复、末页 next_cursor 为 null');

  // 3) 时间区间：from 排除窗口外那一行；to 是闭区间。
  const fromOnly = await service.listAuditLogs(context, { limit: 50, from: '2026-10-20T00:00:00Z' });
  assert.equal(fromOnly.body.data.items.length, 5);
  assert.ok(!fromOnly.body.data.items.some(item => item.id.startsWith('0044')));
  const bounded = await service.listAuditLogs(context, {
    limit: 50, from: '2026-10-20T00:00:00Z', to: '2026-10-20T10:00:01Z',
  });
  assert.deepEqual(
    bounded.body.data.items.map(item => item.id),
    ['00222222-2222-4222-8222-222222222222', '00111111-1111-4111-8111-111111111111'],
    'to 必须是闭区间（含 10:00:01 那一行）',
  );
  pass('时间区间：from 排除窗口外 1 行（5 行），from+to 闭区间取到 2 行');

  // 4) 事件类型：action 与 entity（scope 列）分别过滤。
  const suspend = await service.listAuditLogs(context, {
    limit: 50, action: 'account.suspend', from: '2026-10-20T00:00:00Z',
  });
  assert.deepEqual(suspend.body.data.items.map(item => item.id), ['00111111-1111-4111-8111-111111111111']);
  const flagRows = await service.listAuditLogs(context, {
    limit: 50, entity: 'flag', from: '2026-10-20T00:00:00Z',
  });
  assert.deepEqual(
    flagRows.body.data.items.map(item => item.id),
    [
      '00200000-0000-4000-8000-000000000000',
      '00100000-0000-4000-8000-000000000000',
      '00333333-3333-4333-8333-333333333333',
    ],
  );
  const accountRows = await service.listAuditLogs(context, { limit: 50, entity: 'account' });
  assert.equal(accountRows.body.data.items.length, 3, 'entity=account 覆盖 accounts:suspend 的 3 行');
  pass('事件类型：action=account.suspend 取 1 行；entity=flag 取 3 行、entity=account 取 3 行');

  // 5) 脱敏：允许列表投影裁掉 target_ref 的多余键；响应里没有 ip / user_agent / 凭据 / actor_id。
  const withTarget = all.body.data.items.find(item => item.id === '00333333-3333-4333-8333-333333333333');
  assert.deepEqual(Object.keys(withTarget.target_ref).sort(), ['id', 'revision', 'type']);
  assert.deepEqual(withTarget.before_value, { enabled: false, revision: 3 });
  assert.deepEqual(withTarget.after_value, { enabled: true, revision: 4 });
  const serialized = JSON.stringify(all.body);
  for (const forbidden of ['203.0.113.7', 'hidden-secret', 'Mozilla/5.0', 'user_agent', 'actor_id']) {
    assert.equal(serialized.includes(forbidden), false, `响应里不得出现 ${forbidden}`);
  }
  assert.equal(withTarget.actor, ADMIN_ID, 'actor_id 必须以 actor 暴露（列名映射）');
  assert.deepEqual(
    Object.keys(withTarget).sort(),
    [
      'action', 'actor', 'after_value', 'before_value', 'created_at',
      'id', 'reason_code', 'request_id', 'result', 'scope', 'target_hint', 'target_ref',
    ],
    '条目字段必须恰好是契约 AuditEvent 的 12 个键',
  );
  pass('脱敏：target_ref 只留 type/id/revision；无 ip / user_agent / 凭据字段；actor_id 映射为 actor');

  // 5b) **同一毫秒、不同微秒**：游标位置必须保留微秒，否则「微秒更晚」的行会被整片跳过。
  //     这一组是审查发现的真缺陷的回归钉子，正反两侧都要有读数（见下）。
  const SAME_MS_ROWS = [
    { id: 'a0040000-0000-4000-8000-000000000000', created_at: '2026-10-22T10:00:10.123456Z' },
    { id: 'a0010000-0000-4000-8000-000000000000', created_at: '2026-10-22T10:00:10.123001Z' },
    { id: 'a0020000-0000-4000-8000-000000000000', created_at: '2026-10-22T10:00:10.123000Z' },
  ];
  for (const row of SAME_MS_ROWS) {
    await ownerPool.query(
      `INSERT INTO public.admin_audit_events
         (id, actor_id, action, scope, target_hint, reason_code, request_id, result, created_at)
       VALUES ($1::uuid, $2::uuid, 'account.restore', 'accounts:suspend', $3, 'account_restored', $4::uuid, 'accepted', $5::timestamptz)`,
      [row.id, ADMIN_ID, `account:${row.id}`, REQUEST_ID, row.created_at],
    );
  }
  const sameMsWindow = { from: '2026-10-22T10:00:10Z', to: '2026-10-22T10:00:11Z' };
  const sameMsAll = await service.listAuditLogs(context, { limit: 50, ...sameMsWindow });
  assert.deepEqual(
    sameMsAll.body.data.items.map(item => item.id),
    [
      'a0040000-0000-4000-8000-000000000000',
      'a0010000-0000-4000-8000-000000000000',
      'a0020000-0000-4000-8000-000000000000',
    ],
    '同一毫秒内按微秒降序：.123456 > .123001 > .123000',
  );
  // 三行的 `created_at` 在 JSON 出口里都是 `.123Z`（契约只到毫秒），所以这三行**无法**
  // 靠 `created_at` 区分 —— 位置若取它，就必然把 .123000 判成「已翻过」。
  assert.deepEqual(
    [...new Set(sameMsAll.body.data.items.map(item => item.created_at))],
    ['2026-10-22T10:00:10.123Z'],
    '三行在契约出口里必须是同一个毫秒（这正是缺陷现场）',
  );

  const msPage1 = await service.listAuditLogs(context, { limit: 2, ...sameMsWindow });
  assert.deepEqual(
    msPage1.body.data.items.map(item => item.id),
    ['a0040000-0000-4000-8000-000000000000', 'a0010000-0000-4000-8000-000000000000'],
  );
  const msPage2 = await service.listAuditLogs(context, {
    limit: 2, ...sameMsWindow, cursor: msPage1.body.data.next_cursor,
  });
  assert.deepEqual(
    msPage2.body.data.items.map(item => item.id),
    ['a0020000-0000-4000-8000-000000000000'],
    '同一毫秒内微秒更小的行必须出现在下一页：不得因毫秒截断被跳过（漏行回归）',
  );
  assert.equal(msPage2.body.data.next_cursor, null);

  // 反例（旧实现的形态）：拿毫秒截断的位置继续翻页 ⇒ 下一页为空，a002 静默消失。
  const truncated = await ownerPool.query(
    `SELECT id FROM public.list_admin_audit_logs(
       $1::integer, $2::timestamptz, $3::timestamptz, NULL, NULL, $4::timestamptz, $5::uuid)`,
    [2, sameMsWindow.from, sameMsWindow.to, '2026-10-22T10:00:10.123Z', 'a0010000-0000-4000-8000-000000000000'],
  );
  assert.deepEqual(truncated.rows, [], '毫秒位置（.123）必须复现漏行：下一页 0 行');
  // 正例：同一位置换成微秒精度 ⇒ a002 回来了。
  const precise = await ownerPool.query(
    `SELECT id FROM public.list_admin_audit_logs(
       $1::integer, $2::timestamptz, $3::timestamptz, NULL, NULL, $4::timestamptz, $5::uuid)`,
    [2, sameMsWindow.from, sameMsWindow.to, '2026-10-22T10:00:10.123001Z', 'a0010000-0000-4000-8000-000000000000'],
  );
  assert.deepEqual(
    precise.rows.map(row => row.id),
    ['a0020000-0000-4000-8000-000000000000'],
    '微秒位置（.123001）必须能取回 a002（正反两侧读数）',
  );
  pass('同毫秒不同微秒：微秒位置翻页收全 3 行；毫秒位置复现漏行（下一页 0 行），微秒位置取回 a002');

  // 6) 真实数据量下的读面代价（只打印读数，不设阈值：这里的数字是给索引取舍用的证据）。
  await ownerPool.query(
    `INSERT INTO public.admin_audit_events
       (id, actor_id, action, scope, target_hint, reason_code, request_id, result, created_at)
     SELECT gen_random_uuid(), $1::uuid,
            CASE WHEN g % 50 = 0 THEN 'account.suspend'
                 WHEN g % 50 = 1 THEN 'account.restore'
                 ELSE 'set_flag' END,
            CASE WHEN g % 50 IN (0, 1) THEN 'accounts:suspend' ELSE 'flags:write' END,
            'bulk:' || g, 'bulk_seed', $2::uuid, 'accepted',
            timestamptz '2026-09-01T00:00:00Z' + (g || ' seconds')::interval
       FROM generate_series(1, 20000) AS g`,
    [ADMIN_ID, REQUEST_ID],
  );
  const total = await ownerPool.query('SELECT count(*)::int AS n FROM public.admin_audit_events');
  note(`规模：表内 ${total.rows[0].n} 行（含 9 行夹具：6 行基础夹具 + 3 行同毫秒不同微秒）`);

  const explain = async (label, sql, params) => {
    const { rows } = await ownerPool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
    const plan = rows[0]['QUERY PLAN'][0];
    const nodes = [];
    const walk = node => {
      nodes.push(`${node['Node Type']}${node['Index Name'] ? `(${node['Index Name']})` : ''}`);
      for (const child of node.Plans ?? []) walk(child);
    };
    walk(plan.Plan);
    note(`${label}：${(plan['Execution Time']).toFixed(2)}ms，plan=${nodes.join(' → ')}`);
    return { ms: plan['Execution Time'], nodes };
  };

  await explain(
    '首页无筛选',
    'SELECT id FROM public.list_admin_audit_logs($1::integer, NULL, NULL, NULL, NULL, NULL, NULL)',
    [50],
  );
  await explain(
    'action 过滤（约 2%）',
    'SELECT id FROM public.list_admin_audit_logs($1::integer, NULL, NULL, $2::text[], NULL, NULL, NULL)',
    [50, ['account.suspend']],
  );
  await explain(
    '深翻页（键集，第 200 页）',
    'SELECT id FROM public.list_admin_audit_logs($1::integer, NULL, NULL, NULL, NULL, $2::timestamptz, $3::uuid)',
    [50, '2026-09-01T00:05:00.000Z', '00000000-0000-4000-8000-000000000000'],
  );

  // 7) **P0 回归钉子：0041 形状的 `admin_scope.grant` 行不得再让整页 503**。
  //    读函数 0033 只按时间/动作/scope/actor 过滤（`0033_admin_audit_log_read.sql:96-107`），
  //    0041 写的 `jsonb_build_object('scopes', …, 'reason', …)`（`:326-327` / `:479-480`）必然流到解码器；
  //    契约把 `before_value`/`after_value` 的类型钉成 `FlagReading | null` ⇒ 非开关动作的读数如实 `null`。
  const GRANT_ROW_ID = '00555555-5555-4555-8555-555555555555';
  const GRANT_WINDOW = { from: '2026-10-20T00:00:00Z', to: '2026-10-24T23:59:59Z' };
  await ownerPool.query(
    `INSERT INTO public.admin_audit_events
       (id, actor_id, action, scope, target_ref, target_hint, reason_code,
        request_id, result, before_value, after_value, created_at)
     VALUES ($1::uuid, $2::uuid, 'admin_scope.grant', 'scopes:write', NULL, $3, 'admin_scope_granted',
             $4::uuid, 'accepted',
             jsonb_build_object('scopes', to_jsonb(ARRAY[]::text[]), 'reason', 'arm:grant'),
             jsonb_build_object('scopes', to_jsonb(ARRAY['sources:write']::text[]), 'reason', 'arm:grant'),
             $5::timestamptz)`,
    [GRANT_ROW_ID, ADMIN_ID, `admin:${ADMIN_ID}`, REQUEST_ID, '2026-10-24T10:00:00.000Z'],
  );
  // 造数自检：库里这行**真的是** `{scopes, reason}`（否则下面"读成 null"可能是空断言）。
  const grantStored = await ownerPool.query(
    `SELECT before_value, after_value FROM public.admin_audit_events WHERE id = $1::uuid`,
    [GRANT_ROW_ID],
  );
  assert.deepEqual(
    grantStored.rows[0].before_value,
    { scopes: [], reason: 'arm:grant' },
    '造数：库里 before_value 必须是 0041 的 {scopes, reason} 形状',
  );
  assert.deepEqual(
    grantStored.rows[0].after_value,
    { scopes: ['sources:write'], reason: 'arm:grant' },
    '造数：库里 after_value 必须是 0041 的 {scopes, reason} 形状',
  );

  // 7a) 不过滤的列表：整页必须 200（改前这里 503 读数形状不符），该行在结果里且读数为 null。
  const allWithGrant = await service.listAuditLogs(context, { limit: 50 });
  assert.equal(allWithGrant.status, 200, '结果集里有 0041 形状的 admin_scope.grant 行时整页必须 200');
  const grantItem = allWithGrant.body.data.items.find(item => item.id === GRANT_ROW_ID);
  assert.ok(grantItem !== undefined, '0041 形状的 admin_scope.grant 行必须在全量列表里（不得被静默丢弃）');
  assert.equal(grantItem.before_value, null, '非开关动作的 before_value 必须如实为 null（⛔ 不 503、⛔ 不伪造读数）');
  assert.equal(grantItem.after_value, null, '非开关动作的 after_value 必须如实为 null');
  assert.equal(grantItem.action, 'admin_scope.grant');
  assert.equal(grantItem.scope, 'scopes:write');
  assert.equal(grantItem.actor, ADMIN_ID, '其余字段必须原样透出（actor_id → actor 映射）');
  assert.equal(grantItem.target_hint, `admin:${ADMIN_ID}`);
  pass('7a) 不过滤列表 200，0041 形状的 admin_scope.grant 行在结果里，before_value/after_value 均为 null，其余字段原样');

  // 7b) `?action=admin_scope.grant` 也必须能返回它（action 维度不做 scope 收窄）。
  const grantOnly = await service.listAuditLogs(context, { limit: 50, action: 'admin_scope.grant' });
  assert.equal(grantOnly.status, 200);
  assert.deepEqual(
    grantOnly.body.data.items.map(item => item.id),
    [GRANT_ROW_ID],
    '?action=admin_scope.grant 必须精确取回这一行',
  );
  assert.equal(grantOnly.body.data.items[0].before_value, null);
  assert.equal(grantOnly.body.data.items[0].after_value, null);
  pass('7b) ?action=admin_scope.grant 精确取回该行（仅 1 行，无 scope 收窄），读数仍为 null');

  // 7c) 同一次查询里既有「非开关行」又有 `set_flag` 行：开关读数**仍然**在（证明没有整体抹掉读数）。
  const sameQuery = await service.listAuditLogs(context, { limit: 50, ...GRANT_WINDOW });
  assert.equal(sameQuery.status, 200);
  const sameQueryIds = sameQuery.body.data.items.map(item => item.id);
  assert.deepEqual(sameQueryIds, [
    GRANT_ROW_ID,
    'a0040000-0000-4000-8000-000000000000',
    'a0010000-0000-4000-8000-000000000000',
    'a0020000-0000-4000-8000-000000000000',
    '00200000-0000-4000-8000-000000000000',
    '00100000-0000-4000-8000-000000000000',
    '00333333-3333-4333-8333-333333333333',
    '00222222-2222-4222-8222-222222222222',
    '00111111-1111-4111-8111-111111111111',
  ], '时间窗内 9 行（新增 1 行 + 3 行同毫秒 + 5 行 10-20 夹具）按 created_at DESC, id DESC');
  const flagInSameQuery = sameQuery.body.data.items
    .find(item => item.id === '00333333-3333-4333-8333-333333333333');
  assert.deepEqual(
    flagInSameQuery.before_value,
    { enabled: false, revision: 3 },
    '同一次查询里的 set_flag 行必须仍然带 before_value 读数（分派 ≠ 抹掉读数）',
  );
  assert.deepEqual(
    flagInSameQuery.after_value,
    { enabled: true, revision: 4 },
    '同一次查询里的 set_flag 行必须仍然带 after_value 读数',
  );
  assert.equal(
    sameQuery.body.data.items.find(item => item.id === GRANT_ROW_ID).before_value,
    null,
    '同一次查询里两类行必须各按自己的 action 解码（不是整页一刀切）',
  );
  pass('7c) 同一次查询 9 行顺序不变；set_flag 行仍带 {enabled:false,revision:3} / {enabled:true,revision:4}，grant 行仍为 null');

  // 7d) 总行数与分页游标仍然正确（既有报文的语义不变，只是多了一行）。
  const countAfterGrant = await ownerPool.query(
    'SELECT count(*)::int AS n FROM public.admin_audit_events',
  );
  assert.equal(
    countAfterGrant.rows[0].n,
    20010,
    '总行数 = 20000 批量 + 9 行夹具 + 1 行 0041 形状的 admin_scope.grant（新增行只加 1，没有删改既有行）',
  );

  const windowPaged = [];
  let windowCursor = null;
  let windowPages = 0;
  do {
    const page = await service.listAuditLogs(context, {
      limit: 2,
      ...GRANT_WINDOW,
      ...(windowCursor === null ? {} : { cursor: windowCursor }),
    });
    assert.equal(page.status, 200, '含 0041 形状行的窗口翻页必须每页 200');
    windowPaged.push(...page.body.data.items.map(item => item.id));
    windowCursor = page.body.data.next_cursor;
    windowPages += 1;
    assert.ok(windowPages <= 10, '翻页次数异常（游标可能没有推进）');
  } while (windowCursor !== null);
  assert.deepEqual(windowPaged, sameQueryIds, '加入 0041 形状的行后键集翻页必须仍与全量顺序逐项一致');
  assert.equal(new Set(windowPaged).size, windowPaged.length, '翻页不得重复');
  assert.equal(windowPages, 5, '9 行 / 每页 2 行必须恰好 5 页');
  assert.equal(windowPaged.length, 9);

  // 全表第一页（无时间筛选）：新增行是**最新一行**，紧随其后的是同毫秒组里最大的一条。
  const headPage = await service.listAuditLogs(context, { limit: 2 });
  assert.equal(headPage.status, 200);
  assert.deepEqual(
    headPage.body.data.items.map(item => item.id),
    [GRANT_ROW_ID, 'a0040000-0000-4000-8000-000000000000'],
    '全表第一页（hasMore）顺序不变，新增行按 created_at DESC 排在最前',
  );
  assert.ok(headPage.body.data.next_cursor !== null);
  const headPage2 = await service.listAuditLogs(context, {
    limit: 2, cursor: headPage.body.data.next_cursor,
  });
  assert.deepEqual(
    headPage2.body.data.items.map(item => item.id),
    ['a0010000-0000-4000-8000-000000000000', 'a0020000-0000-4000-8000-000000000000'],
    '游标继续翻页仍然正确（微秒位置生效）',
  );
  pass('7d) 总行数 20010；时间窗 limit=2 恰好 5 页收全 9 行、无重复、顺序与全量一致；全表首页与第二页游标正确');
  pass('P0 回归：0041 形状的 admin_scope.grant 行整页 200、读数为 null、?action 精确命中；同查询 set_flag 读数仍在；总行数与游标不变');

  // =========================================================================
  // 8) **C05：读面必须扛得住 `0041` / `0046` 自己写出来的「真实数据形状」**
  //
  //    第 7 段那行 `admin_scope.grant` 是**手抄的 jsonb 字面量**：它和迁移今天同形，但迁移哪天
  //    改了（`jsonb_build_object` 换字段名、`to_jsonb` 换包裹、或者干脆不写读数），手抄夹具照样
  //    同形、照样绿 —— 夹具不会跟着迁移走，读面就算退回「只认开关形状」也可能一片绿。
  //    这一段改成**迁移函数自己写**：`grant_admin_scope` / `revoke_admin_scope`（0041）与
  //    `record_admin_scope_denial`（0046）在真库里各写一行，再由读面读回来。三种形状同页出现
  //    （grant/revoke 的 `{scopes, reason}` + deny 的「不写读数」+ `set_flag` 的 `{enabled, revision}`），
  //    只有**按 `action` 分派**才解得开。
  //    ⛔ 既有 7a–7d 的断言一行不动，本段只追加。
  // =========================================================================

  // 8-0) 写面走**运行时的真实路径**。运维顺序是「迁移 ⇒ 20-login-roles.sql」，而本臂上面只执行了
  //      读函数的授权段（`gy-r34-audit-logs-grant`）。这里把 0041 / 0046 的三条写入口授权段也原样
  //      执行：下面三行写入用的是 `gengyun_api_runtime`（零表级写权限），而不是属主。
  //      属主直接 `INSERT` 造不出「函数把形状写对了」这件事，只有让写入口自己写才算。
  for (const writeRegion of ['gy-r37-s2-scope-grant', 'gy-r64-pr4a-denial-trace-grant']) {
    await ownerPool.query(grantRegion('deploy/postgres-cvm/sql/20-login-roles.sql', writeRegion));
  }
  pass('8-0) 写面授权段 gy-r37-s2-scope-grant / gy-r64-pr4a-denial-trace-grant 原样执行通过（0041/0046 的写入口对运行时可见）');

  const C05_ACTOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const C05_TARGET = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  // 三个审计行 id 由调用方经 `p_audit_id` 指定；刻意让 `id` 的降序与写入顺序一致：
  // 万一三行落在**同一微秒**，键集排序回落到 `id DESC`，读数顺序仍然稳定。
  const C05_GRANT_AUDIT = '005a0001-0000-4000-8000-000000000001';
  const C05_REVOKE_AUDIT = '005a0002-0000-4000-8000-000000000002';
  const C05_DENY_AUDIT = '005a0003-0000-4000-8000-000000000003';
  const C05_IDS = [C05_GRANT_AUDIT, C05_REVOKE_AUDIT, C05_DENY_AUDIT];
  const C05_GRANT_REASON = 'C05 夹具：逐字同形 grant';
  const C05_REVOKE_REASON = 'C05 夹具：逐字同形 revoke';
  const C05_SET_FLAG_ID = '00333333-3333-4333-8333-333333333333';

  // 0041 的门：actor 必须存在 + `state='active'` + 当前有效持 `scopes:write`（`:239-254`），
  // 且「只能授自己当前有效持有的 scope」（`:274-282`）⇒ actor 自己要持 `scopes:write` 与
  // `sources:write`（两者都是闭集成员，见 `0041:178-194` 的 CHECK）。目标账号初始不带任何 scope。
  await ownerPool.query(
    `INSERT INTO public.admin_accounts (id, login_name, credential_hash) VALUES
       ($1::uuid, 'c05-actor', 'scrypt$c05$actor$placeholder'),
       ($2::uuid, 'c05-target', 'scrypt$c05$target$placeholder')`,
    [C05_ACTOR, C05_TARGET],
  );
  await ownerPool.query(
    `INSERT INTO public.admin_scopes (admin_id, scope, granted_by) VALUES
       ($1::uuid, 'scopes:write', $1::uuid),
       ($1::uuid, 'sources:write', $1::uuid)`,
    [C05_ACTOR],
  );

  // 8a) 三个写入口各写一行（**真实签名**：0041 是 7 参、0046 是 6 参，见 `0041:199-207` / `0046:137-144`）。
  const granted = await runtimePool.query(
    `SELECT public.grant_admin_scope($1::uuid, $2::uuid, 'sources:write', $3::text, $4::uuid, $5::uuid) AS result`,
    [C05_ACTOR, C05_TARGET, C05_GRANT_REASON, REQUEST_ID, C05_GRANT_AUDIT],
  );
  assert.equal(
    granted.rows[0].result.changed,
    true,
    '0041 的 grant_admin_scope 必须真的落了变更（changed=true 才写审计行；changed=false 表示夹具本身没生效）',
  );
  assert.equal(
    granted.rows[0].result.audit_id,
    C05_GRANT_AUDIT,
    '0041 的审计行 id 必须就是调用方给的 p_audit_id（不是函数另生的 uuid）',
  );

  const revoked = await runtimePool.query(
    `SELECT public.revoke_admin_scope($1::uuid, $2::uuid, 'sources:write', $3::text, $4::uuid, $5::uuid) AS result`,
    [C05_ACTOR, C05_TARGET, C05_REVOKE_REASON, REQUEST_ID, C05_REVOKE_AUDIT],
  );
  assert.equal(revoked.rows[0].result.changed, true, '0041 的 revoke_admin_scope 必须真的落了变更（否则下面读的就是空行）');
  assert.equal(revoked.rows[0].result.audit_id, C05_REVOKE_AUDIT, '0041 撤销行的 id 必须就是 p_audit_id');

  const denial = await runtimePool.query(
    `SELECT public.record_admin_scope_denial(
              $1::uuid, $2::uuid, 'scopes:write', 'self_scope_grant_denied', $3::uuid, $4::uuid) AS audit_id`,
    [C05_ACTOR, C05_TARGET, REQUEST_ID, C05_DENY_AUDIT],
  );
  assert.equal(
    denial.rows[0].audit_id,
    C05_DENY_AUDIT,
    '0046 的 record_admin_scope_denial 必须回写它插进去的那一行 id（= p_audit_id）',
  );

  // 造数自检：库里这 3 行**真的是**迁移写出来的形状（否则下面「读成 null」可能是空断言）。
  // ⛔ 不 UPDATE 任何行：`admin_audit_events_append_only` 触发器把 UPDATE/DELETE 判成 G0006。
  const c05Stored = await ownerPool.query(
    `SELECT id::text AS id, actor_id::text AS actor_id, action, scope, target_ref, target_hint,
            reason_code, request_id::text AS request_id, result::text AS result,
            before_value, after_value, created_at
       FROM public.admin_audit_events
      WHERE id = ANY($1::uuid[])`,
    [C05_IDS],
  );
  assert.equal(c05Stored.rows.length, 3, '三个写入口必须各留 1 行（grant/revoke 幂等、deny 刻意不幂等）');
  const c05StoredById = new Map(c05Stored.rows.map(row => [row.id, row]));

  const grantStoredRow = c05StoredById.get(C05_GRANT_AUDIT);
  assert.equal(grantStoredRow.action, 'admin_scope.grant');
  assert.equal(grantStoredRow.actor_id, C05_ACTOR, '0041 的 actor_id 必须是函数里定的操作者（不是属主、不是调用方自报）');
  assert.equal(grantStoredRow.scope, 'sources:write');
  assert.equal(grantStoredRow.target_ref, null, '契约 TargetRef 闭集没有 account ⇒ 0041 写 NULL，标识落 target_hint');
  assert.equal(grantStoredRow.target_hint, `admin_account:${C05_TARGET}`);
  assert.equal(grantStoredRow.reason_code, 'scope_granted');
  assert.equal(grantStoredRow.result, 'accepted');
  assert.equal(grantStoredRow.request_id, REQUEST_ID);
  assert.deepEqual(
    grantStoredRow.before_value,
    { scopes: [], reason: C05_GRANT_REASON },
    '0041 的 grant 行 before_value 必须是 jsonb_build_object(\'scopes\', …, \'reason\', …)（`0041:326`）',
  );
  assert.deepEqual(
    grantStoredRow.after_value,
    { scopes: ['sources:write'], reason: C05_GRANT_REASON },
    '0041 的 grant 行 after_value 同形（`0041:327`），scopes 是变更后的有效集合',
  );

  const revokeStoredRow = c05StoredById.get(C05_REVOKE_AUDIT);
  assert.equal(revokeStoredRow.action, 'admin_scope.revoke');
  assert.equal(revokeStoredRow.actor_id, C05_ACTOR);
  assert.equal(revokeStoredRow.scope, 'sources:write');
  assert.equal(revokeStoredRow.target_hint, `admin_account:${C05_TARGET}`);
  assert.equal(revokeStoredRow.reason_code, 'scope_revoked');
  assert.equal(revokeStoredRow.result, 'accepted');
  assert.deepEqual(
    revokeStoredRow.before_value,
    { scopes: ['sources:write'], reason: C05_REVOKE_REASON },
    '0041 的撤销行 before_value 同形（`0041:479`），scopes 是撤销前的有效集合',
  );
  assert.deepEqual(
    revokeStoredRow.after_value,
    { scopes: [], reason: C05_REVOKE_REASON },
    '0041 的撤销行 after_value 同形（`0041:480`）',
  );

  const denyStoredRow = c05StoredById.get(C05_DENY_AUDIT);
  assert.equal(denyStoredRow.action, 'admin_scope.deny');
  assert.equal(denyStoredRow.actor_id, C05_ACTOR);
  assert.equal(denyStoredRow.scope, 'scopes:write');
  assert.equal(denyStoredRow.target_hint, `admin_account:${C05_TARGET}`);
  assert.equal(denyStoredRow.reason_code, 'self_scope_grant_denied', '0046 的拒绝理由码来自闭集四值');
  assert.equal(denyStoredRow.result, 'denied', '0046 写死 result=denied（`0046:218`）');
  assert.equal(denyStoredRow.before_value, null, '0046 拒绝行的 before_value 不写 ⇒ NULL（`0046:81` 裁定：没有「变更前后」的事实）');
  assert.equal(denyStoredRow.after_value, null, '0046 拒绝行的 after_value 同上');

  // 字段名不是我起的：逐字对 `0041:326-327` / `:479-480` 的 `jsonb_build_object`。
  for (const [label, value] of [
    ['grant.before_value', grantStoredRow.before_value],
    ['grant.after_value', grantStoredRow.after_value],
    ['revoke.before_value', revokeStoredRow.before_value],
    ['revoke.after_value', revokeStoredRow.after_value],
  ]) {
    assert.deepEqual(
      Object.keys(value).sort(),
      ['reason', 'scopes'],
      `${label} 的 jsonb 键必须逐字是 scopes / reason（⛔ 本臂不自己发明字段名）`,
    );
  }
  pass('8a) 三个写入口（0041 grant/revoke、0046 deny）经运行时角色各写 1 行，库里形状与迁移源码逐字一致：grant/revoke 的 before/after 都是 {scopes, reason}，deny 的读数为 NULL');

  // 8b) 整页取回：**这段窗口由库里的实际时间反推**（三个函数写的是 `now()`，不是夹具时间），
  //     并先确认窗口内没有别的行 —— 否则下面「恰好 3 行」的读数不可信。
  const c05Span = await ownerPool.query(
    `SELECT min(created_at) AS lo, max(created_at) AS hi
       FROM public.admin_audit_events WHERE id = ANY($1::uuid[])`,
    [C05_IDS],
  );
  const c05From = new Date(c05Span.rows[0].lo.getTime() - 60_000).toISOString();
  const c05To = new Date(c05Span.rows[0].hi.getTime() + 60_000).toISOString();
  const c05Neighbours = await ownerPool.query(
    `SELECT count(*)::int AS n FROM public.admin_audit_events
      WHERE NOT (id = ANY($1::uuid[])) AND created_at >= $2::timestamptz AND created_at <= $3::timestamptz`,
    [C05_IDS, c05From, c05To],
  );
  assert.equal(
    c05Neighbours.rows[0].n,
    0,
    `C05 时间窗内混进了 ${c05Neighbours.rows[0].n} 行别的夹具 ⇒ 「恰好 3 行」不可信（宿主时钟是否落在固定夹具附近？）`,
  );
  const C05_WINDOW = { from: c05From, to: c05To };

  const c05Page = await service.listAuditLogs(context, { limit: 50, ...C05_WINDOW });
  assert.equal(
    c05Page.status,
    200,
    '结果集里有 0041/0046 真实写出的行时整页必须 200（解码器退回「只认开关形状」时这里 503 读数形状不符）',
  );
  assert.deepEqual(
    c05Page.body.data.items.map(item => item.id),
    [C05_DENY_AUDIT, C05_REVOKE_AUDIT, C05_GRANT_AUDIT],
    '三行按 created_at DESC 取回（deny 最后写 ⇒ 最新；同一微秒落库时键集回落到 id DESC，顺序不变）',
  );

  const c05Items = new Map(c05Page.body.data.items.map(item => [item.id, item]));
  for (const [id, action, scope, reasonCode, result] of [
    [C05_DENY_AUDIT, 'admin_scope.deny', 'scopes:write', 'self_scope_grant_denied', 'denied'],
    [C05_REVOKE_AUDIT, 'admin_scope.revoke', 'sources:write', 'scope_revoked', 'accepted'],
    [C05_GRANT_AUDIT, 'admin_scope.grant', 'sources:write', 'scope_granted', 'accepted'],
  ]) {
    const item = c05Items.get(id);
    assert.ok(item !== undefined, `${action} 行必须在列表里（⛔ 不得被静默丢弃）`);
    assert.equal(item.action, action);
    assert.equal(item.scope, scope);
    assert.equal(item.reason_code, reasonCode);
    assert.equal(item.result, result);
    assert.equal(item.actor, C05_ACTOR, 'actor 必须是写入口记下的操作者（actor_id → actor 映射）');
    assert.equal(item.target_hint, `admin_account:${C05_TARGET}`);
    assert.equal(item.target_ref, null);
    assert.equal(item.request_id, REQUEST_ID);
    assert.equal(
      item.created_at,
      c05StoredById.get(id).created_at.toISOString(),
      'created_at 必须原样透出（毫秒 ISO）',
    );
    // 契约边界（不是本片的取舍，已在 findings 里登记）：`AuditEvent.before_value` / `after_value`
    // 的类型是 `FlagReading | null`（`{enabled, revision}`，`additionalProperties: false`），
    // 装不下 `{scopes, reason}` ⇒ 读面今天如实给 `null`。**库里那两个字段确实可读**，由上面 8a 的
    // deepEqual 逐字证明；「经 HTTP 读得到 scopes/reason」要等契约扩展片，本片不改契约。
    assert.equal(
      item.before_value,
      null,
      `${action} 的 before_value 在契约里装不下 {scopes, reason} ⇒ 必须如实 null（⛔ 不是 503、⛔ 不是伪造读数）`,
    );
    assert.equal(item.after_value, null, `${action} 的 after_value 同上`);
  }
  assert.deepEqual(
    Object.keys(c05Items.get(C05_DENY_AUDIT)).sort(),
    [
      'action', 'actor', 'after_value', 'before_value', 'created_at', 'id',
      'reason_code', 'request_id', 'result', 'scope', 'target_hint', 'target_ref',
    ],
    '契约 AuditEvent 就是这 12 个字段：读面没有 metadata 位（scopes/reason 只能按契约扩展片再暴露）',
  );
  pass('8b) 真实写出来的三行同页取回：整页 200、顺序 deny→revoke→grant、action/actor/scope/reason_code/result/created_at 逐项对得上，读数如实为 null（契约 12 字段无 metadata 位）');

  // 8c) 分页计数：3 行 / 每页 2 行 = 2 页，无重复、无漏行、顺序与全量一致。
  const c05Paged = [];
  let c05Cursor = null;
  let c05Pages = 0;
  do {
    const page = await service.listAuditLogs(context, {
      limit: 2,
      ...C05_WINDOW,
      ...(c05Cursor === null ? {} : { cursor: c05Cursor }),
    });
    assert.equal(page.status, 200, '含 0041/0046 真实形状行的窗口翻页必须每页 200');
    c05Paged.push(...page.body.data.items.map(item => item.id));
    c05Cursor = page.body.data.next_cursor;
    c05Pages += 1;
    assert.ok(c05Pages <= 10, '翻页次数异常（游标可能没有推进）');
  } while (c05Cursor !== null);
  assert.deepEqual(
    c05Paged,
    [C05_DENY_AUDIT, C05_REVOKE_AUDIT, C05_GRANT_AUDIT],
    '键集翻页必须与全量顺序逐项一致',
  );
  assert.equal(new Set(c05Paged).size, 3, '翻页不得重复、不得漏行');
  assert.equal(c05Pages, 2, '3 行 / 每页 2 行必须恰好 2 页');
  pass('8c) 分页计数正确：3 行 / 每页 2 行恰好 2 页，2+1 无重复无漏行，顺序与全量一致');

  // 8d) **判别力所在：一页里混杂三种形状**。窗口从 10-20 起 ⇒ `set_flag`（开关读数）、
  //     7 段手抄的 0041 行、以及本段真实写出的三行**同页出现**；两条形状必须各自解码正确。
  const c05MixedIds = [
    C05_DENY_AUDIT,
    C05_REVOKE_AUDIT,
    C05_GRANT_AUDIT,
    GRANT_ROW_ID,
    'a0040000-0000-4000-8000-000000000000',
    'a0010000-0000-4000-8000-000000000000',
    'a0020000-0000-4000-8000-000000000000',
    '00200000-0000-4000-8000-000000000000',
    '00100000-0000-4000-8000-000000000000',
    C05_SET_FLAG_ID,
    '00222222-2222-4222-8222-222222222222',
    '00111111-1111-4111-8111-111111111111',
  ];
  const mixedPage = await service.listAuditLogs(context, {
    limit: 50, from: '2026-10-20T00:00:00Z', to: c05To,
  });
  assert.equal(mixedPage.status, 200, '混杂三种形状的一页必须 200');
  assert.deepEqual(
    mixedPage.body.data.items.map(item => item.id),
    c05MixedIds,
    '混杂页 12 行（3 行真实写入口 + 1 行手抄 0041 + 3 行同毫秒 + 5 行 10-20 夹具）顺序必须 created_at DESC, id DESC',
  );
  const mixedById = new Map(mixedPage.body.data.items.map(item => [item.id, item]));
  assert.deepEqual(
    mixedById.get(C05_SET_FLAG_ID).before_value,
    { enabled: false, revision: 3 },
    '同页的 set_flag 行必须**仍然**按开关形状解码（分派 ≠ 整页一刀切）',
  );
  assert.deepEqual(
    mixedById.get(C05_SET_FLAG_ID).after_value,
    { enabled: true, revision: 4 },
    '同页的 set_flag 行 after_value 同前',
  );
  for (const id of [C05_DENY_AUDIT, C05_REVOKE_AUDIT, C05_GRANT_AUDIT, GRANT_ROW_ID]) {
    assert.equal(
      mixedById.get(id).before_value,
      null,
      `${mixedById.get(id).action} 行与开关行同页时必须按自己的 action 解码成 null（不是 503、不是开关读数）`,
    );
    assert.equal(mixedById.get(id).after_value, null, `${mixedById.get(id).action} 行 after_value 同上`);
  }
  assert.deepEqual(
    mixedPage.body.data.items
      .filter(item => item.before_value !== null || item.after_value !== null)
      .map(item => item.id),
    [C05_SET_FLAG_ID],
    '整页只有 set_flag 那一行有读数：0041 的 grant/revoke、0046 的 deny、以及 10-20 的其余行一律 null',
  );

  const mixedPaged = [];
  let mixedCursor = null;
  let mixedPages = 0;
  do {
    const page = await service.listAuditLogs(context, {
      limit: 5,
      from: '2026-10-20T00:00:00Z',
      to: c05To,
      ...(mixedCursor === null ? {} : { cursor: mixedCursor }),
    });
    assert.equal(page.status, 200, '混杂页翻页必须每页 200');
    mixedPaged.push(...page.body.data.items.map(item => item.id));
    mixedCursor = page.body.data.next_cursor;
    mixedPages += 1;
    assert.ok(mixedPages <= 10, '翻页次数异常（游标可能没有推进）');
  } while (mixedCursor !== null);
  assert.deepEqual(mixedPaged, c05MixedIds, '混杂页键集翻页必须与全量顺序逐项一致');
  assert.equal(new Set(mixedPaged).size, 12, '混杂页翻页不得重复');
  assert.equal(mixedPages, 3, '12 行 / 每页 5 行必须恰好 3 页');
  pass('8d) 一页混杂三种形状：12 行顺序正确、set_flag 行仍取到 {enabled:false,revision:3}/{enabled:true,revision:4}、其余 4 行读数 null；12 行 / 每页 5 行恰好 3 页');

  // 8e) 三个新 action 各自 `?action=` 精确命中（action 维度不做 scope 收窄）。
  for (const [action, expectedIds] of [
    ['admin_scope.grant', [C05_GRANT_AUDIT]],
    ['admin_scope.revoke', [C05_REVOKE_AUDIT]],
    ['admin_scope.deny', [C05_DENY_AUDIT]],
  ]) {
    const only = await service.listAuditLogs(context, { limit: 50, ...C05_WINDOW, action });
    assert.equal(only.status, 200, `?action=${action} 必须 200`);
    assert.deepEqual(
      only.body.data.items.map(item => item.id),
      expectedIds,
      `?action=${action} 必须精确取回这一行`,
    );
    assert.equal(only.body.data.items[0].action, action);
    assert.equal(only.body.data.items[0].before_value, null);
  }
  pass('8e) ?action=admin_scope.grant / .revoke / .deny 各自精确命中 1 行，读数仍为 null');

  // 8f) 总行数：只加 3 行，没有删改任何既有行。
  const countAfterC05 = await ownerPool.query(
    'SELECT count(*)::int AS n FROM public.admin_audit_events',
  );
  assert.equal(
    countAfterC05.rows[0].n,
    20013,
    '总行数 = 20010（7d 时）+ 3 行真实写入口产出（grant/revoke/deny 各 1 行）',
  );
  pass('8f) 总行数 20013（+3），既有 20010 行一行未删未改');
  pass('C05 真实形状覆盖：0041 的 grant/revoke 与 0046 的 deny 由迁移函数自己写入真库，读面按 action 分派解码，同页混杂开关行时两条形状各自正确');

  console.log('真库臂 PASS：读通道的 SQL、权限、键集、筛选、脱敏全部在真 PG 17.11 上取得读数。');
}

try {
  await main();
} catch (error) {
  console.error('真库臂 FAIL：', error?.message ?? error);
  if (error?.stack) console.error(error.stack);
  console.error(`工具日志：${toolLog}`);
  if (dataDir !== '') console.error(`server.log 尾部：\n${tail(join(dataDir, 'server.log'))}`);
  process.exitCode = 1;
} finally {
  await ownerPool?.end().catch(() => {});
  await runtimePool?.end().catch(() => {});
  if (dataDir === '') {
    // 没有起成集群（候选端口全不可用）：没有东西可清理。
  } else {
    try {
      stopCluster();
    } catch (error) {
      console.error(`清理临时集群失败：${error.message}（目录 ${dataDir} 需人工删除）`);
      process.exitCode = 1;
    }
  }
  // 工具日志 fd 必须**在 `stopCluster()` 之后**关：`runTool` 把这个 fd 直接当 `pg_ctl`/`postgres` 的
  // stdout/stderr（见 `runTool`），提前关掉会让 `spawnSync` 拿到 EBADF 且**不抛错**
  // （`status=null`、`error.code=EBADF`），`pg_ctl stop` 于是静默不执行 —— 顺序反过来是最小、
  // 也最不容易再把这条 bug 带回来的写法（R66 修复）。
  closeSync(logFd);
}
