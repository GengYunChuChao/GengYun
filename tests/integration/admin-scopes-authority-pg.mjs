/**
 * 真库臂：`#18` S2 片1（迁移 0041）后台管理员 scope 的**唯一写路径**与闭集约束。
 *
 * 为什么要有这一臂
 * ----------------
 * 迁移 0041 的全部语义都只存在于 SQL 里：`SECURITY DEFINER` 到底有没有真的以属主身份写、
 * `ON CONFLICT … WHERE revoked_at IS NOT NULL` 的复活分支到底会不会重置 `granted_by`/`granted_at`、
 * 事务级 advisory 锁内的「最后授权者」计数到底排不排除停用账号、审计行与状态变更到底是不是
 * 同一事务、运行时角色到底有没有偷偷拿到 `admin_scopes` 的写权。这些只有真 PG 才回答得了，
 * 单测用假 port 一条都证明不了。
 *
 * 本臂做两件事
 * ------------
 *   1) **部署形态**：迁移走生产路径（`migrate.ts up`），随后按 `provision-db.sh` 的顺序跑
 *      `services/api/db/roles/*.sql` ⇒ `20-login-roles.sql` ⇒ `90-assert-least-privilege.sql`，
 *      断言 90-assert 末行 `ok`（既有断言仍为真）且新增的 103/104 两条**逐条为真**。
 *   2) **直调**：以 `gengyun_api_runtime` 身份直调两条函数，覆盖正常授予/撤销、幂等、
 *      非 `scopes:write` 被拒、自授被拒、授予未持有的 scope 被拒、目标停用被拒、版本冲突、
 *      撤销后复活、最后授权者被拒（含「停用账号不计入」）、审计原子性（撞主键回滚）。
 *
 * 起集群的方式与兄弟臂不同（按裁定：⛔ 不用 `pg_ctl start`）
 * ---------------------------------------------------------
 * 本臂直接 `spawn` `postgres.exe -D <目录> -p <端口> -h 127.0.0.1` 前台进程，收尾用
 * `pg_ctl stop -m fast`（只做优雅停机，不负责启动）。数据目录落在 `GY_R37_PG_ROOT`（默认
 * 系统临时目录）下，删目录前先确认 basename 前缀是本脚本自己的，避免误删。
 *
 * 怎么跑
 * ------
 *   $env:GY_PG_BIN = 'E:\GengYunCommander\.pg17\pgsql\bin'   # 含 initdb/psql/pg_ctl/pg_isready 的目录（PG 17.11）
 *   $env:GY_R37_PG_ROOT = 'E:\GengYunCommander\.pg17\tmp'    # 可选：数据目录的父目录
 *   node tests/integration/admin-scopes-authority-pg.mjs
 *
 * 没设 `GY_PG_BIN` 时**明确 SKIP**：打印 3 行原因并以 **77 退出**（未取得，不是通过），
 * 与 `admin-audit-logs-pg` / `backup-purge-pg` 等自起集群脚本同一口径。
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const binDir = (process.env.GY_PG_BIN ?? '').trim();
// 库名为什么必须是 `gengyun`（而不是 `gengyun_r37_scope_test`）：`20-login-roles.sql:93-99` 有硬前置
// `current_database() = 'gengyun'`（原话「避免在测试库/别人的库上误建身份」），`provision-db.sh:186`
// 同样要求 `current_database() == $DB_NAME`。本臂走的是**生产路径**（20-login-roles.sql 必须真跑），
// 所以只能在「一次性集群」里建一个名叫 `gengyun` 的库 —— 集群由本脚本自己 `initdb` 出来、独占，
// 收尾 `pg_ctl stop` 并删目录，碰不到任何既有库。
const DB_NAME = 'gengyun';
// 生产口径（deploy/postgres-cvm/install-postgres.sh:60,465）：集群的引导超级用户就是迁移管理员
// `gengyun_cvm_owner`，**不是** `postgres`。90-assert 的断言里既有「除 gengyun_cvm_owner 外不得有
// 超级用户」，也有 `pg_has_role('gengyun_api_runtime','gengyun_cvm_owner','MEMBER')`（角色不存在会直接
// 报错而不是判红），所以本臂必须按生产形态 initdb。
const OWNER_ROLE = 'gengyun_cvm_owner';
const RUNTIME_ROLE = 'gengyun_api_runtime';
// 20-login-roles.sql 的口令 `\getenv` 守卫要求 48 位小写十六进制（openssl rand -hex 24）。
const RUNTIME_PASSWORD = '0123456789abcdef0123456789abcdef0123456789abcdef';
const TOOL = name => join(binDir, process.platform === 'win32' ? `${name}.exe` : name);
const pass = line => console.log(`  ✓ ${line}`);
const note = line => console.log(`  · ${line}`);

// 四个固定管理员 id（固定值便于失败时人工复现；在审计里也一眼能认出是测试夹具）。
const ACTOR_A = 'a0000000-0000-4000-8000-00000000a001'; // 元权限操作者
const TARGET_B = 'b0000000-0000-4000-8000-00000000b001'; // 被授权者
const SUSPENDED_C = 'c0000000-0000-4000-8000-00000000c001'; // 已停用（持 scopes:write 但不计入）
const PLAIN_D = 'd0000000-0000-4000-8000-00000000d001'; // 不持 scopes:write 的操作者
const REQUEST_1 = '11111111-1111-4111-8111-111111111111';
const REQUEST_2 = '22222222-2222-4222-8222-222222222222';

const GRANT_SQL = 'SELECT public.grant_admin_scope('
  + '$1::uuid, $2::uuid, $3::text, $4::text, $5::uuid, $6::uuid, $7::integer) AS result';
const REVOKE_SQL = 'SELECT public.revoke_admin_scope('
  + '$1::uuid, $2::uuid, $3::text, $4::text, $5::uuid, $6::uuid, $7::integer) AS result';

if (binDir === '' || !existsSync(TOOL('initdb'))) {
  console.log(
    'SKIP: 未设置 GY_PG_BIN（含 initdb/psql/pg_ctl 的目录）⇒ 真库臂跳过，'
      + '没有验证迁移 0041 的 scope 写路径（未取得，不是通过）。',
  );
  console.log('SKIP: 本臂只认 GY_PG_BIN 指向的 PG 17 二进制，找不到就整链未取得。');
  console.log('SKIP: 退出码 77 ＝ 未取得（⛔ 不是通过）；调用方必须把它显式判红，另见 tests/unit/integration-script-coverage.test.mjs。');
  process.exit(77);
}

const rootDir = (process.env.GY_R37_PG_ROOT ?? tmpdir()).trim();
mkdirSync(rootDir, { recursive: true });
const toolLog = join(rootDir, 'gy-r37-scope-pg-tools.log');
const logFd = openSync(toolLog, 'a');

let dataDir = '';
let child = null;
let port = 0;
let ownerUrl = '';
let runtimeUrl = '';

function runTool(name, args, options = {}) {
  return spawnSync(TOOL(name), args, {
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, PGCONNECT_TIMEOUT: '5' },
    timeout: options.timeout ?? 180_000,
    windowsHide: true,
    cwd: ROOT,
  });
}

/** 跑一份部署 SQL（psql -f）。`env` 只为 `20-login-roles.sql` 的 `\getenv` 口令准备。 */
function runSqlFile(file, env = {}) {
  return spawnSync(TOOL('psql'), [
    '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', ownerUrl, '-f', file,
  ], {
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, PGCONNECT_TIMEOUT: '5', ...env },
    timeout: 180_000,
    windowsHide: true,
    cwd: ROOT,
  });
}

/** 跑一份部署 SQL 并抓 stdout（90-assert 的判决行就是靠这个读的）。 */
function captureSqlFile(file) {
  const result = spawnSync(TOOL('psql'), [
    '-X', '-q', '-d', ownerUrl, '-f', file,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PGCONNECT_TIMEOUT: '5' },
    timeout: 180_000,
    windowsHide: true,
    cwd: ROOT,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function tail(file, lines = 12) {
  try {
    return readFileSync(file, 'utf8').replace(/\s+$/, '').split('\n').slice(-lines).join('\n');
  } catch (error) {
    return `（读不到 ${file}：${error.message}）`;
  }
}

/** 端口是否已有人在听？（Windows 上 `SO_REUSEADDR` 让 listen 成功不代表空闲，故用「能连上」判定。） */
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

/**
 * 起一次性集群：直接 spawn `postgres.exe -D … -p … -h 127.0.0.1`（裁定：⛔ 不用 `pg_ctl start`）。
 *
 * 候选端口 55600–55639：与兄弟臂（55432–55467）错开，避开本机保留区间。bind 失败的判据是
 * 「子进程退出 / 连不上」，失败就换下一个候选并把 server.log 的 FATAL 行如实打出来。
 */
async function startCluster() {
  const tried = [];
  for (let candidate = 55600; candidate <= 55639; candidate += 1) {
    if (await portBusy(candidate)) {
      tried.push(`${candidate}:已有人监听`);
      continue;
    }
    const dir = join(rootDir, `gy-r37-scope-pg-${candidate}-${randomUUID().slice(0, 6)}`);
    mkdirSync(dir, { recursive: true });
    const init = runTool('initdb', [
      '-D', dir, '--no-sync', '--encoding=UTF8', '--locale=C', '-U', OWNER_ROLE, '--auth=trust',
    ]);
    if (init.status !== 0) {
      tried.push(`${candidate}:initdb=${init.status}`);
      rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
      continue;
    }

    const server = spawn(TOOL('postgres'), [
      '-D', dir,
      '-p', String(candidate),
      '-h', '127.0.0.1',
      '-c', 'max_connections=32',
      '-c', 'timezone=UTC',
    ], {
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      cwd: ROOT,
    });

    dataDir = dir;
    child = server;
    const ready = await waitReady(candidate, server);
    if (!ready) {
      tried.push(`${candidate}:postgres 未就绪（${firstFailure(dir)}）`);
      stopServer(dir);
      child = null;
      dataDir = '';
      rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
      continue;
    }

    port = candidate;
    ownerUrl = `postgresql://${OWNER_ROLE}@127.0.0.1:${port}/${DB_NAME}`;
    runtimeUrl = `postgresql://${RUNTIME_ROLE}:${RUNTIME_PASSWORD}@127.0.0.1:${port}/${DB_NAME}`;
    note(`临时集群：${dir}，端口 ${port}（仅 127.0.0.1，postgres.exe 前台进程 pid=${server.pid}）`);

    const admin = await connectWithRetry(`postgresql://${OWNER_ROLE}@127.0.0.1:${port}/postgres`);
    try {
      const { rows } = await admin.query('SHOW server_version');
      note(`server_version = ${rows[0].server_version}`);
    } finally {
      await admin.end();
    }
    return;
  }
  throw new Error(`55600–55639 内没有可用端口：${tried.join('；')}`);
}

/** 等 postgres 能接受连接；子进程提前退出即判失败。 */
async function waitReady(candidate, server) {
  const url = `postgresql://${OWNER_ROLE}@127.0.0.1:${candidate}/postgres`;
  for (let index = 0; index < 80; index += 1) {
    if (server.exitCode !== null) return false;
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1_000 });
    try {
      await client.connect();
      await client.end();
      return true;
    } catch {
      await client.end().catch(() => {});
      await sleep(250);
    }
  }
  return false;
}

function firstFailure(dir) {
  // postgres 前台进程的 stderr 直接进 logFd（未开 logging_collector）⇒ server.log 可能不存在；
  // 这里只读“若存在”的文件，读不到就退化成工具日志的尾部，不让诊断路径自己抛错。
  let lines = [];
  try {
    lines = readFileSync(join(dir, 'server.log'), 'utf8').split('\n');
  } catch {
    lines = tail(toolLog, 20).split('\n');
  }
  const fatal = lines.filter(line => line.includes('FATAL') || line.includes('ERROR')
    || line.includes('could not bind')).slice(-1)[0];
  return (fatal ?? lines.slice(-1)[0] ?? '见工具日志').slice(0, 160);
}

/** 优雅停机：`pg_ctl stop -m fast`（不负责启动），失败再兜底 kill 子进程句柄。 */
function stopServer(dir) {
  if (!existsSync(join(dir, 'postmaster.pid'))) return;
  const stop = runTool('pg_ctl', ['-D', dir, '-m', 'fast', '-w', '-t', '60', 'stop'], { timeout: 90_000 });
  if (stop.status === 0) return;
  try {
    child?.kill();
  } catch {
    /* 已经退出 */
  }
  for (let wait = 0; wait < 100; wait += 1) {
    if (!existsSync(join(dir, 'postmaster.pid'))) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

function cleanupCluster() {
  if (dataDir === '') return;
  if (!basename(dataDir).startsWith('gy-r37-scope-pg-')) {
    throw new Error(`拒绝删除非本脚本创建的目录：${dataDir}`);
  }
  stopServer(dataDir);
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

// ---------------------------------------------------------------------------
// 部署形态：建库 ⇒ migrate.ts up ⇒ roles/*.sql ⇒ 20-login-roles.sql ⇒ 90-assert
// ---------------------------------------------------------------------------
async function bootstrapDatabase() {
  const admin = await connectWithRetry(`postgresql://${OWNER_ROLE}@127.0.0.1:${port}/postgres`);
  try {
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
  } finally {
    await admin.end();
  }

  // 迁移走**生产路径**（migrate.ts up），不是手抄 SQL：发现/编号/校验/记账都真跑一遍。
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
  pass('迁移经 migrate.ts up 落到真库（生产路径）');

  const ownerPool = new pg.Client({ connectionString: ownerUrl });
  await ownerPool.connect();
  const applied = await ownerPool.query(
    'SELECT version FROM public.schema_migrations ORDER BY version DESC LIMIT 1',
  );
  assert.equal(applied.rows[0].version, '0043', '迁移 0043（#18 R18 片：后台作业取消审计落库，窄口径 SECURITY DEFINER 函数 + 只授运行时 EXECUTE）必须是最后一条已应用版本');
  pass('schema_migrations 末项 = 0043');

  const hasCheck = await ownerPool.query(
    `SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid = 'public.admin_scopes'::regclass
        AND conname = 'admin_scopes_scope_closed_set' AND contype = 'c'`,
  );
  assert.equal(hasCheck.rows[0].n, 1, '0041 必须在 admin_scopes.scope 上建出闭集 CHECK');
  pass('闭集约束 admin_scopes_scope_closed_set 已建出（1 条）');
  await ownerPool.end();

  // 既有 NOLOGIN 组（按 provision-db.sh 的顺序：先组、再 20-login-roles、再 90-assert）。
  //
  // ⛔ 只跑 provision-db.sh 的**默认 5 组形态**（`ROLE_GROUP_FILES`，provision-db.sh:275-281），
  //    不是 `roles/*.sql` 全量。为什么必须收窄（本臂真库首跑实测踩到）：
  //    `services/api/db/roles/egress_ledger.sql` 在**两种部署形态下都不被执行**
  //    （`20-login-roles.sql:36` 原话「egress_ledger.sql 当前不被任何部署脚本执行」；
  //    `tests/unit/roles-file-disposition.test.mjs` 判它的处置是 not_provisioned），
  //    而它会建 `gengyun_egress_ledger` 并把它授予运行时。全量执行 ⇒ 造出**生产永不出现**的
  //    状态 `revision_upd/cancelled_upd=false` ＋ `egress_role/egress_grant=true`，
  //    90-assert 的断言 102 `runtime_ledger_readiness_biconditional` 会如实判红 ——
  //    那是**本臂部署形态错了**，不是被测代码错。收窄后形态回到「整块未就绪」（形态 A），
  //    与生产/CI 的 `deploy-sql-17.11` job 一致。
  const rolesDir = join(ROOT, 'services/api/db/roles');
  const roleFiles = [
    'auth_privacy.sql',
    'catalog_readers.sql',
    'consent_granter.sql',
    'profile_runtime.sql',
    'knowledge_runtime.sql',
  ];
  for (const file of roleFiles) {
    assert.ok(
      existsSync(join(rolesDir, file)),
      `缺少 services/api/db/roles/${file}（provision-db.sh 默认 5 组形态需要它）`,
    );
    const run = runSqlFile(join(rolesDir, file));
    assert.equal(run.status, 0, `roles/${file} 执行失败（status=${run.status}，见 ${toolLog}）`);
  }
  pass(`${roleFiles.length} 个 NOLOGIN 组执行通过（provision-db.sh 默认 5 组形态，含 gengyun_auth_privacy）`);

  const login = runSqlFile(join(ROOT, 'deploy/postgres-cvm/sql/20-login-roles.sql'), {
    GENGYUN_API_RUNTIME_PASSWORD: RUNTIME_PASSWORD,
  });
  assert.equal(
    login.status,
    0,
    `20-login-roles.sql 执行失败（status=${login.status}；尾部：\n${tail(toolLog, 30)}）`,
  );
  pass('20-login-roles.sql 全量执行通过（含新区域 gy-r37-s2-scope-grant）');

  // 90-assert 的真值在**会话级临时表** `pg_temp.r28_assert_results` 里（90-assert:1110-1115 建表，
  // 判决行与末尾 DO 块都读它）；断言行本身**不打印**。所以「103/104 存在且为真」不能靠 grep stdout
  // —— 那样只能看见判决行，`labelLine()` 永远返回空串（本臂首跑实测：假红）。做法是在同一 psql
  // 会话里、90-assert 之后追加一段只读探针，从临时表里把这两行取出来。
  const assertPath = join(ROOT, 'deploy/postgres-cvm/sql/90-assert-least-privilege.sql');
  const probePath = join(rootDir, 'gy-r37-scope-90-assert-probe.sql');
  writeFileSync(
    probePath,
    `${readFileSync(assertPath, 'utf8')}\n`
      + '\\echo GY_R37_PROBE_BEGIN\n'
      + 'SELECT label, ok FROM r28_assert_results\n'
      + " WHERE label IN ('admin_scope_write_functions_execute_exact',\n"
      + "                  'admin_scopes_scope_check_closed_set')\n"
      + ' ORDER BY label;\n'
      + '\\echo GY_R37_PROBE_END\n',
    'utf8',
  );

  const assert1 = captureSqlFile(probePath);
  const full = assert1.stdout;
  assert.equal(
    assert1.status,
    0,
    `90-assert 必须 exit 0（status=${assert1.status}）：\n${full.slice(-3000)}\n${assert1.stderr.slice(-2000)}`,
  );

  const [verdictPart, probePart = ''] = full.split('GY_R37_PROBE_BEGIN');
  assert.ok(verdictPart !== undefined && probePart !== '', '90-assert 输出里必须出现探针分界行（否则判据会静默失效）');
  const out = verdictPart.trim();
  const lastLine = out.split('\n').filter(line => line.trim() !== '').slice(-1)[0] ?? '';
  assert.equal(lastLine.trim(), 'ok', `90-assert 末行判决必须是 ok（现场：${lastLine.trim().slice(0, 400)}）`);
  assert.equal(/\nFAIL: /u.test(out), false, '判决行不得含 FAIL（fail-closed）');
  pass('90-assert-least-privilege.sql 末行 ok、exit 0（既有断言全绿）');

  // 新增的两条断言必须真的在结果集里且为 true（不是「没报错」就算过）。临时表行的格式是
  // `label|t`（90-assert:50-51 已 `\pset tuples_only on` + `\pset format unaligned`）。
  const probeRows = probePart.split('GY_R37_PROBE_END')[0]
    .split('\n').map(line => line.trim()).filter(line => line !== '');
  for (const label of ['admin_scope_write_functions_execute_exact', 'admin_scopes_scope_check_closed_set']) {
    assert.ok(
      probeRows.includes(`${label}|t`),
      `断言 ${label} 必须存在且为 true（临时表实测行：${probeRows.join(' , ') || '（无）'}）`,
    );
  }
  pass('90-assert 新增断言 103/104 存在且为 true（从 pg_temp.r28_assert_results 实读，不是「缺行当作过」）');
}

// ---------------------------------------------------------------------------
// 造数：四个管理员 + 受控初始化（引导播种直接 INSERT，不经过函数）
// ---------------------------------------------------------------------------
async function seedAdministrators() {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO public.admin_accounts (id, login_name, credential_hash, state) VALUES
         ($1, 'r37-actor',    'scrypt$fixture$a', 'active'),
         ($2, 'r37-target',   'scrypt$fixture$b', 'active'),
         ($3, 'r37-suspended','scrypt$fixture$c', 'suspended'),
         ($4, 'r37-plain',    'scrypt$fixture$d', 'active')`,
      [ACTOR_A, TARGET_B, SUSPENDED_C, PLAIN_D],
    );
    // 受控初始化（裁定①）：首个元权限不经过函数——函数本身要求操作者已持 scopes:write，
    // 否则会形成「谁都无法给出第一个元权限」的死锁。这里相当于运维手工播种。
    await client.query(
      `INSERT INTO public.admin_scopes (admin_id, scope, granted_by, granted_at) VALUES
         ($1, 'scopes:write',  NULL, now()),
         ($1, 'scopes:read',   NULL, now()),
         ($1, 'sources:read',  NULL, now()),
         ($2, 'scopes:write',  NULL, now()),
         ($3, 'accounts:read', NULL, now())`,
      [ACTOR_A, SUSPENDED_C, PLAIN_D],
    );
    return await snapshot(client);
  } finally {
    await client.end();
  }
}

async function snapshot(client) {
  const scopes = await client.query(
    `SELECT admin_id, scope, granted_by, granted_at, revoked_at
       FROM public.admin_scopes ORDER BY admin_id, scope`,
  );
  const audits = await client.query(
    `SELECT id, actor_id, action, scope, target_hint, reason_code, request_id,
            result, before_value, after_value
       FROM public.admin_audit_events
      WHERE action LIKE 'admin_scope.%'
      ORDER BY created_at, id`,
  );
  const revisions = await client.query(
    'SELECT id, state, revision FROM public.admin_accounts ORDER BY login_name',
  );
  return { scopes: scopes.rows, audits: audits.rows, revisions: revisions.rows };
}

async function readState() {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    return await snapshot(client);
  } finally {
    await client.end();
  }
}

/** 调一次函数并返回 jsonb 结果。 */
async function call(fn, client, args) {
  const sql = fn === 'grant' ? GRANT_SQL : REVOKE_SQL;
  const { rows } = await client.query(sql, args);
  return rows[0].result;
}

/** 断言某次调用以指定 SQLSTATE 失败，并返回错误对象（供后续核对 message/detail）。 */
async function expectFailure(label, promise, sqlState) {
  try {
    await promise;
  } catch (error) {
    assert.equal(
      error.code,
      sqlState,
      `${label}：期望 SQLSTATE ${sqlState}，实际 ${error.code}（${error.message}）`,
    );
    return error;
  }
  assert.fail(`${label}：期望以 ${sqlState} 失败，但调用成功了`);
}

const grant = (client, [actor, target, scope, reason, request, auditId = null, rev] = []) =>
  call('grant', client, [actor, target, scope, reason, request, auditId, rev]);
const revoke = (client, [actor, target, scope, reason, request, auditId = null, rev] = []) =>
  call('revoke', client, [actor, target, scope, reason, request, auditId, rev]);

const scopesOf = (state, adminId) => state.scopes
  .filter(row => row.admin_id === adminId && row.revoked_at === null)
  .map(row => row.scope);

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
let runtime = null;

try {
  await startCluster();
  await bootstrapDatabase();
  const seeded = await seedAdministrators();
  assert.deepEqual(scopesOf(seeded, ACTOR_A), ['scopes:read', 'scopes:write', 'sources:read']);
  assert.deepEqual(scopesOf(seeded, SUSPENDED_C), ['scopes:write']);
  pass('夹具：4 个管理员；A 持 scopes:write/scopes:read/sources:read；C 已停用但持 scopes:write');

  runtime = new pg.Client({ connectionString: runtimeUrl });
  await runtime.connect();

  // ---------------------------------------------------------------- 权限面 --
  const surface = await runtime.query(`
    SELECT has_table_privilege(current_user, 'public.admin_scopes', 'INSERT') AS tbl_ins,
           has_table_privilege(current_user, 'public.admin_scopes', 'UPDATE') AS tbl_upd,
           has_table_privilege(current_user, 'public.admin_scopes', 'DELETE') AS tbl_del,
           has_column_privilege(current_user, 'public.admin_scopes', 'scope', 'UPDATE') AS col_upd,
           has_column_privilege(current_user, 'public.admin_scopes', 'granted_by', 'UPDATE') AS col_granted_by_upd,
           has_function_privilege(current_user,
             'public.grant_admin_scope(uuid,uuid,text,text,uuid,uuid,integer)', 'EXECUTE') AS grant_exec,
           has_function_privilege(current_user,
             'public.revoke_admin_scope(uuid,uuid,text,text,uuid,uuid,integer)', 'EXECUTE') AS revoke_exec,
           has_function_privilege('public',
             'public.grant_admin_scope(uuid,uuid,text,text,uuid,uuid,integer)', 'EXECUTE') AS public_grant_exec,
           (SELECT prosecdef FROM pg_proc
             WHERE oid = 'public.grant_admin_scope(uuid,uuid,text,text,uuid,uuid,integer)'::regprocedure) AS grant_secdef,
           (SELECT prosecdef FROM pg_proc
             WHERE oid = 'public.revoke_admin_scope(uuid,uuid,text,text,uuid,uuid,integer)'::regprocedure) AS revoke_secdef
  `);
  const s = surface.rows[0];
  assert.equal(s.tbl_ins, false);
  assert.equal(s.tbl_upd, false);
  assert.equal(s.tbl_del, false);
  assert.equal(s.col_upd, false, '运行时的 scope 列必须不可 UPDATE（90-assert 槽 9 的红线）');
  assert.equal(s.col_granted_by_upd, false);
  assert.equal(s.grant_exec, true);
  assert.equal(s.revoke_exec, true);
  assert.equal(s.public_grant_exec, false, 'PUBLIC 不得持有写函数的 EXECUTE（默认 ACL 必须被收回）');
  assert.equal(s.grant_secdef, true);
  assert.equal(s.revoke_secdef, true);
  pass('权限面：运行时零表级写/零列级 UPDATE、两条函数 SECURITY DEFINER 且只有运行时持 EXECUTE、PUBLIC 无 EXECUTE');

  // 运行时对三列 SELECT 仍可用（三列读是 PR-2 读面的前提），第四列读不到。
  const threeCols = await runtime.query('SELECT admin_id, scope, revoked_at FROM public.admin_scopes LIMIT 1');
  assert.equal(threeCols.rowCount, 1, '运行时必须仍能读 admin_scopes 的三列（授权在 roles/auth_privacy.sql）');
  await expectFailure(
    '运行时直读 granted_by',
    runtime.query('SELECT granted_by FROM public.admin_scopes LIMIT 1'),
    '42501',
  );
  pass('运行时只读 admin_id/scope/revoked_at 三列（读 granted_by 得 42501）');

  await expectFailure(
    '运行时直写 admin_scopes（INSERT）',
    runtime.query("INSERT INTO public.admin_scopes (admin_id, scope) VALUES ($1, 'audit:read')", [TARGET_B]),
    '42501',
  );
  await expectFailure(
    '运行时直写 admin_scopes（UPDATE revoked_at）',
    runtime.query('UPDATE public.admin_scopes SET revoked_at = now()'),
    '42501',
  );
  pass('运行时直接 INSERT/UPDATE admin_scopes 均 42501（只能经两条函数）');

  // ------------------------------------------------------------ 正常授予 --
  const granted = await grant(runtime, [ACTOR_A, TARGET_B, 'sources:read', '工单 T-1：给 B 看资料来源', REQUEST_1]);
  assert.equal(granted.changed, true);
  assert.deepEqual(granted.scopes, ['sources:read']);
  assert.equal(granted.admin_id, TARGET_B);
  assert.equal(typeof granted.revision, 'number');
  assert.match(String(granted.audit_created_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  const afterGrant = await readState();
  const grantRow = afterGrant.scopes.find(row => row.admin_id === TARGET_B && row.scope === 'sources:read');
  assert.equal(grantRow.granted_by, ACTOR_A, 'granted_by 必须真实写入操作者');
  assert.ok(grantRow.revoked_at === null);
  const grantAudit = afterGrant.audits.filter(row => row.action === 'admin_scope.grant');
  assert.equal(grantAudit.length, 1);
  assert.equal(grantAudit[0].scope, 'sources:read');
  assert.equal(grantAudit[0].target_hint, `admin_account:${TARGET_B}`);
  assert.equal(grantAudit[0].reason_code, 'scope_granted');
  assert.equal(grantAudit[0].request_id, REQUEST_1);
  assert.deepEqual(grantAudit[0].before_value.scopes, []);
  assert.deepEqual(grantAudit[0].after_value.scopes, ['sources:read']);
  assert.equal(grantAudit[0].after_value.reason, '工单 T-1：给 B 看资料来源');
  const revA1 = afterGrant.revisions.find(row => row.id === TARGET_B).revision;
  pass(`正常授予：changed=true、scopes=['sources:read']、granted_by=A、审计 1 行、B.revision=${revA1}`);

  // ---------------------------------------------------- 二次授予：幂等 --
  const grantedAtBefore = grantRow.granted_at;
  const again = await grant(runtime, [ACTOR_A, TARGET_B, 'sources:read', '重复授予（应幂等）', REQUEST_2]);
  assert.equal(again.changed, false);
  assert.deepEqual(again.scopes, ['sources:read']);
  const afterAgain = await readState();
  assert.equal(
    afterAgain.audits.filter(row => row.action === 'admin_scope.grant').length,
    1,
    '幂等授予不得写第二条审计',
  );
  assert.equal(
    afterAgain.revisions.find(row => row.id === TARGET_B).revision,
    revA1,
    '幂等授予不得 bump revision',
  );
  const rowAgain = afterAgain.scopes.find(row => row.admin_id === TARGET_B && row.scope === 'sources:read');
  assert.equal(rowAgain.granted_at.getTime(), grantedAtBefore.getTime(), '幂等授予不得改 granted_at');
  pass('二次授予：changed=false、无第二条审计、revision 与 granted_at 均未变（幂等）');

  // -------------------------------------------------------- 各类拒绝路径 --
  const deniedByPlain = await expectFailure(
    '非 scopes:write 操作者授予',
    grant(runtime, [PLAIN_D, TARGET_B, 'accounts:read', 'D 没有元权限', REQUEST_1]),
    'G0010',
  );
  assert.equal(deniedByPlain.message, 'SCOPE_DENIED');
  pass('非 scopes:write 操作者：G0010 SCOPE_DENIED（拒绝）');

  const selfGrant = await expectFailure(
    '自授',
    grant(runtime, [ACTOR_A, ACTOR_A, 'audit:read', '自己给自己', REQUEST_1]),
    'G0008',
  );
  assert.equal(selfGrant.message, 'SELF_SCOPE_GRANT_DENIED');
  pass('自授：G0008 SELF_SCOPE_GRANT_DENIED（403 口径；自撤另测）');

  const notHeld = await expectFailure(
    '授予自己没持有的 scope',
    grant(runtime, [ACTOR_A, TARGET_B, 'flags:write', 'A 自己都没有 flags:write', REQUEST_1]),
    'G0011',
  );
  assert.equal(notHeld.message, 'SCOPE_NOT_HELD');
  pass('授予自己未持有：G0011 SCOPE_NOT_HELD（拒绝）');

  await expectFailure(
    '目标管理员不存在',
    grant(runtime, [ACTOR_A, 'e0000000-0000-4000-8000-00000000e001', 'sources:read', '不存在', REQUEST_1]),
    'G0002',
  );
  pass('目标管理员不存在：G0002 NOT_FOUND');

  const suspendedTarget = await expectFailure(
    '目标已停用',
    grant(runtime, [ACTOR_A, SUSPENDED_C, 'sources:read', '给已停用账号授权', REQUEST_1]),
    'G0004',
  );
  assert.equal(suspendedTarget.message, 'OBJECT_UNAVAILABLE');
  pass('目标已停用：G0004 OBJECT_UNAVAILABLE（不写行、不写审计）');

  await expectFailure(
    '版本冲突',
    grant(runtime, [ACTOR_A, TARGET_B, 'scopes:read', '旧 revision 上的写入', REQUEST_1, null, 1]),
    'G0003',
  );
  pass('If-Match 版本不符：G0003 REVISION_CONFLICT');

  // ------------------------------------------------------- 撤销 + 复活 --
  const revoked = await revoke(runtime, [ACTOR_A, TARGET_B, 'sources:read', '工单 T-2：收回', REQUEST_2]);
  assert.equal(revoked.changed, true);
  assert.deepEqual(revoked.scopes, []);
  const afterRevoke = await readState();
  const revokedRow = afterRevoke.scopes.find(row => row.admin_id === TARGET_B && row.scope === 'sources:read');
  assert.ok(revokedRow.revoked_at instanceof Date, 'revoked_at 必须落值');
  assert.equal(revokedRow.granted_by, ACTOR_A, '撤销不得抹掉 granted_by（历史由审计承担）');
  assert.equal(afterRevoke.audits.filter(row => row.action === 'admin_scope.revoke').length, 1);
  pass('撤销：changed=true、revoked_at 落值、审计 admin_scope.revoke 1 行');

  const revokeAgain = await revoke(runtime, [ACTOR_A, TARGET_B, 'sources:read', '重复撤销', REQUEST_2]);
  assert.equal(revokeAgain.changed, false);
  assert.equal(
    (await readState()).audits.filter(row => row.action === 'admin_scope.revoke').length,
    1,
    '幂等撤销不得写第二条审计',
  );
  pass('重复撤销：changed=false、无第二条审计（幂等空操作）');

  await new Promise(resolve => setTimeout(resolve, 20));
  const regranted = await grant(runtime, [ACTOR_A, TARGET_B, 'sources:read', '工单 T-3：重新授予', REQUEST_1]);
  assert.equal(regranted.changed, true, '撤销后重新授予必须能写回（store.ts 的 ON CONFLICT DO NOTHING 做不到）');
  assert.deepEqual(regranted.scopes, ['sources:read']);
  const revivedRow = (await readState()).scopes
    .find(row => row.admin_id === TARGET_B && row.scope === 'sources:read');
  assert.equal(revivedRow.revoked_at, null);
  assert.equal(revivedRow.granted_by, ACTOR_A);
  assert.ok(revivedRow.granted_at.getTime() > grantRow.granted_at.getTime(), '复活必须重置 granted_at');
  pass('撤销后重新授予：写回成功、revoked_at=NULL、granted_at 前进（复活语义）');

  // --------------------------------------------- 最后授权者守卫（含停用）--
  const grantedMeta = await grant(runtime, [ACTOR_A, TARGET_B, 'scopes:write', '委派元权限给 B', REQUEST_1]);
  assert.equal(grantedMeta.changed, true);
  assert.deepEqual(scopesOf(await readState(), TARGET_B), ['scopes:write', 'sources:read']);
  pass('委派元权限：A 把自己持有的 scopes:write 授予 B（changed=true）');

  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    await owner.query("UPDATE public.admin_accounts SET state = 'suspended' WHERE id = $1", [TARGET_B]);
  } finally {
    await owner.end();
  }
  pass('把 B 停用（此时「有效元权限持有者」只剩 A；C、B 都已停用 ⇒ 都不计入）');

  const lastGuard = await expectFailure(
    '撤销最后一个有效元权限',
    revoke(runtime, [ACTOR_A, ACTOR_A, 'scopes:write', '自撤最后一个元权限（应被硬拦）', REQUEST_1]),
    'G0009',
  );
  assert.equal(lastGuard.message, 'LAST_SCOPE_MANAGER');
  const afterGuard = await readState();
  assert.deepEqual(scopesOf(afterGuard, ACTOR_A), ['scopes:read', 'scopes:write', 'sources:read'],
    '被拒后 A 的元权限必须原样保留（拒绝 = 整笔回滚，不是静默成功）');
  assert.equal(
    afterGuard.audits.filter(row => row.action === 'admin_scope.revoke' && row.scope === 'scopes:write').length,
    0,
    '被拒路径不得留下审计行（拒绝留痕属 PR-3，本片不假装实现）',
  );
  pass('最后授权者：自撤 scopes:write ⇒ G0009 LAST_SCOPE_MANAGER，且 A 的元权限原样保留（停用账号不计入）');

  // 夹具复位：上一段刻意把 B 停用来证明「停用账号不计入有效授权者」；下面的审计原子性注入
  // 还要经函数往 B 的行上写（函数对 `state <> 'active'` 的目标一律 G0004 OBJECT_UNAVAILABLE）。
  // 复位只改 `state`（不授也不撤任何 scope），属**夹具动作**、不是被测语义。
  const ownerReset = new pg.Client({ connectionString: ownerUrl });
  await ownerReset.connect();
  try {
    await ownerReset.query("UPDATE public.admin_accounts SET state = 'active' WHERE id = $1", [TARGET_B]);
  } finally {
    await ownerReset.end();
  }
  pass('夹具复位：B 恢复 active（否则后续经函数的写入一律 G0004；复位不改任何 scope）');

  // ------------------------------------------------- 审计原子性（注入）--
  // 注入点必须让「状态确实要变」：只有 changed=true 才会走到审计 INSERT、才可能撞主键。
  // 而 `grant` 的入参自检里还有一条「只能授予自己当前有效持有的 scope」⇒ 注入用的 scope
  // 必须是 **A 持有、且 B 当前未有效持有** 的那一个。`scopes:read` 同时满足两边：
  // A 在受控初始化里就有它；B 这一步之前没有（上面的 sources:read 已复活、scopes:write 已委派）。
  const auditId = randomUUID();
  const withAudit = await grant(runtime, [ACTOR_A, TARGET_B, 'scopes:read', '带指定审计 id', REQUEST_2, auditId, null]);
  assert.equal(withAudit.changed, true);
  assert.equal(withAudit.audit_id, auditId);
  // 撤掉刚授予的那一行，把「复活」这条路重新腾出来（撤销不需要「持有」校验，只要操作者持
  // scopes:write；它自己那条审计用的是新 uuid，不会干扰下面的撞主键）。
  const freed = await revoke(runtime, [ACTOR_A, TARGET_B, 'scopes:read', '为原子性注入腾出可复活的空位', REQUEST_2]);
  assert.equal(freed.changed, true, '腾空位这一步必须真的撤掉一行（否则下面的注入会因为 changed=false 而只返回幂等结果）');
  const beforeClash = await readState();
  const clashScopes = scopesOf(beforeClash, TARGET_B);
  await expectFailure(
    '审计 id 撞主键（原子性注入）',
    // 同一个 auditId + 可复活的同一 scope ⇒ 一定会 INSERT 审计 ⇒ 23505 ⇒ 整笔回滚。
    grant(runtime, [ACTOR_A, TARGET_B, 'scopes:read', '撞主键必须整笔回滚', REQUEST_1, auditId, null]),
    '23505',
  );
  const afterClash = await readState();
  assert.deepEqual(scopesOf(afterClash, TARGET_B), clashScopes, '撞主键后 B 的 scope 集合必须一字未动');
  assert.equal(
    afterClash.revisions.find(row => row.id === TARGET_B).revision,
    beforeClash.revisions.find(row => row.id === TARGET_B).revision,
    '撞主键后 revision 不得前进（零写入）',
  );
  pass('审计原子性：复用审计 id ⇒ 23505，scope 与 revision 全部回滚（零写入）');

  // -------------------------------------------------------- 闭集约束面 --
  const ownerForCheck = new pg.Client({ connectionString: ownerUrl });
  await ownerForCheck.connect();
  try {
    const check = await ownerForCheck.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'public.admin_scopes'::regclass AND conname = 'admin_scopes_scope_closed_set'`,
    );
    const def = check.rows[0].def;
    for (const scope of ['scopes:read', 'scopes:write', 'audit:read', 'sources:write']) {
      assert.ok(def.includes(`'${scope}'`), `闭集必须含 ${scope}`);
    }
    for (const forbidden of ["'user'", "'public'", "'receipt'"]) {
      assert.equal(def.includes(forbidden), false, `闭集不得含 ${forbidden}（那是路由访问标记）`);
    }
    pass('闭集定义：含 13 个后台权限、不含 user/public/receipt');

    for (const badScope of ['user', 'receipt', 'moderation']) {
      const error = await ownerForCheck
        .query('INSERT INTO public.admin_scopes (admin_id, scope) VALUES ($1, $2)', [TARGET_B, badScope])
        .then(() => null)
        .catch(err => err);
      assert.ok(error, `闭集外取值 ${badScope} 必须被库层 CHECK 拒绝（属主直写也一样）`);
      assert.equal(error.code, '23514', `${badScope} 期望 23514，实际 ${error.code}`);
      assert.match(String(error.constraint), /admin_scopes_scope_closed_set/u);
    }
    pass('属主直写闭集外取值（user/receipt/moderation）全部 23514 + 约束名（库层兜底，不靠应用层）');
  } finally {
    await ownerForCheck.end();
  }

  // ------------------------------------------------------ 审计留痕汇总 --
  const finalState = await readState();
  note(`审计留痕（admin_scope.*）共 ${finalState.audits.length} 行：`
    + finalState.audits.map(row => `${row.action}/${row.scope}/${row.reason_code}`).join(' '));
  pass('全链读数一致（授予/撤销/复活/委派各留下自己的审计行，被拒路径零行）');
} finally {
  if (runtime) await runtime.end().catch(() => {});
  cleanupCluster();
  // 自证：端口不再有人在听（postgres 已停）。
  if (port > 0) {
    assert.equal(await portBusy(port), false, `端口 ${port} 收尾后不得仍有监听`);
  }
  console.log('  · 收尾：临时集群已停、目录已删、端口无监听');
}
