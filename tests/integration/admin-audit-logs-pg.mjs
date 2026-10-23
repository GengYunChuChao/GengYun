/**
 * 真库臂：`GET /admin/audit-logs` 的读通道（迁移 0033 的 `public.list_admin_audit_logs()`）。
 *
 * 为什么要有这一臂
 * ----------------
 * 单测用假 port，证明不了 SQL 本身：七个参数怎么绑、键集比较用的是不是 `(created_at, id)`、
 * `SECURITY DEFINER` 之后运行时角色到底还能不能读表、以及 `target_ref` 的允许列表投影是否真
 * 把多余键裁掉。这些只有真 PG 才能回答。
 *
 * 本臂自己起**一次性集群**（`initdb` 新目录），因此不依赖本机既有实例；端口在
 * 55436–55467 里探活后取空闲者（55432–55435 留给已存在的兄弟集群），收尾 `pg_ctl stop` + 删目录。
 *
 * 怎么跑
 * ------
 *   $env:GY_PG_BIN = 'E:\GengYunCommander\.pg17\pgsql\bin'   # 含 initdb/pg_ctl 的目录（PG 17.11）
 *   $env:GY_R34_PG_ROOT = 'E:\GengYunCommander\.pg17\tmp'    # 可选：数据目录的父目录
 *   node tests/integration/admin-audit-logs-pg.mjs
 *
 * 没设 `GY_PG_BIN` 时**明确 SKIP**（打印原因并 exit 0）：跳过不是通过。
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

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const binDir = (process.env.GY_PG_BIN ?? '').trim();
const DB_NAME = 'gengyun_r34_audit_logs_test';
const RUNTIME_ROLE = 'gengyun_api_runtime';
const RUNTIME_PASSWORD = 'r34auditarm';
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
  process.exit(0);
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
 * 起一次性集群：在 55436–55467 里逐个候选试（55432–55435 已被兄弟切片占用，不碰）。
 *
 * 为什么不是「探到一个空闲端口就 initdb」：Windows 还有**保留/排除端口区间**
 * （`netsh int ipv4 show excludedportrange protocol=tcp`，本机 55441–55540 在列），
 * postgres 在这些端口上会拿到 WSAEACCES。所以真正的判据是「postgres 能不能 bind」——
 * 失败就换下一个候选，并把原因如实打出来（不静默降级、不假装通过）。
 */
async function startCluster() {
  const tried = [];
  for (let candidate = 55436; candidate <= 55467; candidate += 1) {
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
      '-o', [`-p ${candidate}`, '-c listen_addresses=127.0.0.1', '-c max_connections=32'].join(' '),
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
  throw new Error(`55436–55467 内没有可用端口：${tried.join('；')}`);
}

function stopCluster() {
  if (!basename(dataDir).startsWith('gy-r34-audit-logs-pg-')) {
    throw new Error(`拒绝删除非本脚本创建的目录：${dataDir}`);
  }
  if (existsSync(join(dataDir, 'PG_VERSION'))) {
    runTool('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { timeout: 60_000 });
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
  assert.equal(applied.rows[0].version, '0033', '迁移 0033 必须是最后一条已应用版本');
  pass('迁移 0033 经 migrate.ts up 落到真库（schema_migrations 末项 0033）');

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
  closeSync(logFd);
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
}
