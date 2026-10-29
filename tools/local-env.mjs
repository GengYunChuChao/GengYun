#!/usr/bin/env node
/**
 * 本地受控环境：`npm run local:up` / `local:down` / `local:status`。
 *
 * 这个命令把「起一套可用的本地受控环境」固化成可重复的三步，消灭每一轮手搓都会重复踩的环境红：
 *
 *   1. **端口不能照抄文档**：起服务前先查 `Get-NetTCPConnection -State Listen` 与持有进程命令行；
 *      被占就点名（pid/进程名/命令行）并换下一个可用端口；`--strict-port` 下直接失败。
 *      默认端口**故意错开**历史默认：PG 5555、API 3111（README 的 3100 在本机常被无关进程占着）。
 *   2. **`db:migrate` 失败不许当「起好了」**：非零退出即失败、分类、原文脱敏；
 *      已起的组件按「本次运行是否由自己启动」回滚，`local:down` 仍可安全重复执行。
 *   3. **不在仓库里留任何密钥**：两个临时密钥（32 字节 CSPRNG，base64url）只进进程环境与
 *      `<state-dir>/secrets.env`（state-dir 默认在**仓库外**）；输出里只有「生成了/长度满足」布尔，
 *      打印前还会跑一次泄密断言（{@link assertNoSecretLeaks}）。
 *
 * ⛔ 本工具不修改任何产品代码、不新增迁移、不往 `consent_policies` 插行（那是另一个切片的事）。
 * ⛔ 副作用（建簇/起进程/写文件/发 HTTP）只在本文件；纯判定在 `tools/lib/local-env.mjs`（可单测）。
 *
 * 退出码（`up`）：
 *   0 全部就绪且 6 个端点都符合预期；1 用法/内部错误；2 端口被占（`--strict-port`）或换号耗尽；
 *   3 服务起来了但端点读数不符合预期（摘要仍会写盘）；4 迁移失败（已回滚）；5 PG 建簇/启动/建库失败（已回滚）。
 * `down` / `status`：0 表示已收干净/读数成功（「本来就没起」也是 0）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_DATABASE,
  DEFAULT_PORTS,
  INITDB_DEFAULTS,
  PORT_MAX_OFFSET,
  REQUIRED_ENDPOINTS,
  SCHEMA_ID,
  SECRET_ENV_NAMES,
  allEndpointsExpected,
  assertNoSecretLeaks,
  buildConsentPoliciesCountSql,
  buildCreateDatabaseSql,
  buildDatabaseExistsSql,
  buildDatabaseUrl,
  buildInitdbArgs,
  buildPgStartArgs,
  buildPgStatusArgs,
  buildPgStopArgs,
  buildPsqlArgs,
  buildSummary,
  classifyMigrateFailure,
  describeHolder,
  keyDescriptor,
  knownBoundaryLines,
  normalizeOccupancy,
  parseMigrateOutput,
  planPort,
  redactConnectionStrings,
  serializeSummary,
} from './lib/local-env.mjs';

// ---------------------------------------------------------------------------
// 路径：一律从本文件的 URL 推导，⛔ 不用 process.cwd()（相对路径按进程 cwd 解析是上一轮的坑之一）
// ---------------------------------------------------------------------------

/** 仓库根（本文件在 `<repo>/tools/local-env.mjs`）。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** API 入口（迁移与服务都从这里派生，不依赖工作目录）。 */
export const API_ENTRY = join(REPO_ROOT, 'services', 'api', 'src', 'server.ts');

/**
 * 默认 state 目录：**仓库外**的兄弟目录，`<workspace>/.local-env/<repo-name>`。
 *
 * 为什么不用系统 temp：Windows 的 `%TEMP%` 会被清理工具扫走，而 PG 数据目录被清掉之后
 * `pg_ctl status` 只会说「没起」，看不出「簇被删了」；放在工作区兄弟目录里既在仓外、
 * 又和具体 checkout 一一对应（多工作树并行时互不干扰）。
 */
export const DEFAULT_STATE_ROOT = join(dirname(REPO_ROOT), '.local-env', basename(REPO_ROOT));

/** 退出码（见文件头）。 */
export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 1,
  PORT: 2,
  ENDPOINTS: 3,
  MIGRATE: 4,
  POSTGRES: 5,
});

const USAGE_TEXT = `用法：
  node tools/local-env.mjs up      [选项]    起 PG + 建库 + 迁移 + 后台起 stub API + 打 6 个端点 + 打印摘要 JSON
  node tools/local-env.mjs down    [选项]    停 API（按 pid 文件）与 PG；幂等（本来没起 ⇒ exit 0）
  node tools/local-env.mjs status  [选项]    只读：在跑/没跑 + 端口 + pid

选项（up）：
  --pg-port <n>        PG 首选端口（默认 ${DEFAULT_PORTS.pg}）
  --api-port <n>       API 首选端口（默认 ${DEFAULT_PORTS.api}）
  --pg-bin <路径>      PostgreSQL 的 bin 目录（默认 $GY_PG_BIN 或 <workspace>/.pg17/pgsql/bin）
  --state-dir <路径>   状态/数据/密钥/日志目录（默认 ${DEFAULT_STATE_ROOT}，⛔ 必须在仓库外）
  --out <路径>         摘要 JSON 落盘路径（默认 <state-dir>/local-env-summary.json）
  --database <名>     库名（默认 ${DEFAULT_DATABASE}）
  --database-url <串> 覆盖连接串（连已有库/故障注入用；给了就不建库）
  --strict-port       首选端口被占即失败（点名持有进程），不换号
  --timeout-ms <n>    等 /health 就绪的上限（默认 30000）

选项（down / status）：--pg-bin / --state-dir
`;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function say(line = '') {
  process.stdout.write(`${line}\n`);
}

function warn(line) {
  process.stderr.write(`${line}\n`);
}

function readJsonIfExists(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 运行一个子进程并收集输出（不抛异常；退出码/错误码都交给调用方判定）。 */
function run(command, args, { cwd = REPO_ROOT, env = process.env, timeoutMs = 180000, shell = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    shell,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    command,
    status: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    errorCode: result.error?.code ?? null,
    errorMessage: result.error?.message ?? null,
  };
}

/** 端口上是否有人 listening（只探回环；超时=当作没人听）。 */
function portListening(port, timeoutMs = 400) {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * 端口占用探测：**先 PowerShell**（能拿到持有进程的命令行，这是「点名」的来源），
 * 再用 TCP 连接探测兜底（PowerShell 不可用时至少知道「有人在听」，只是持有者未知）。
 */
function probePorts(ports) {
  const list = [...new Set(ports)].filter((port) => Number.isInteger(port));
  const occupancy = new Map();
  let source = 'powershell';
  let psError = null;

  if (list.length > 0) {
    const script = [
      `$ports = @(${list.join(',')});`,
      // 只查**一次**监听表，再在 PowerShell 内筛端口：逐端口调 `-LocalPort` 会线性变慢，
      // 40 多个候选会把探测拖到超时（实测过一次 ETIMEDOUT，探测降级成「拿不到持有进程」）。
      '$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort });',
      '$seen = @{};',
      '$rows = foreach ($l in $listeners) {',
      'if (-not $seen.ContainsKey($l.OwningProcess)) { $seen[$l.OwningProcess] = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $l.OwningProcess) -ErrorAction SilentlyContinue };',
      '$proc = $seen[$l.OwningProcess];',
      '[pscustomobject]@{ port = [int]$l.LocalPort; pid = [int]$l.OwningProcess;',
      'name = $(if ($proc) { $proc.Name } else { $null }); commandLine = $(if ($proc) { $proc.CommandLine } else { $null }) } };',
      '@($rows) | ConvertTo-Json -Compress -Depth 4',
    ].join(' ');
    const result = run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeoutMs: 60000 },
    );
    const text = result.stdout.trim();
    if (result.status === 0 && text !== '') {
      try {
        const parsed = JSON.parse(text);
        for (const [port, holder] of normalizeOccupancy(parsed)) occupancy.set(port, holder);
      } catch {
        psError = 'PowerShell 输出不是合法 JSON';
        source = 'tcp';
      }
    } else if (result.status === 0 && text === '') {
      // 没有占用的端口：正常空表。
    } else {
      const detail =
        result.errorCode === 'ETIMEDOUT'
          ? `调用超时（${String(result.signal)}）`
          : (result.stderr || result.errorMessage || '未知错误').split(/\r?\n/)[0];
      psError = redactConnectionStrings(detail).slice(0, 200);
      source = 'tcp';
    }
  }

  return Promise.all(list.map(async (port) => ({ port, listening: await portListening(port) }))).then((probes) => {
    for (const probe of probes) {
      if (!probe.listening) {
        // TCP 不通 ⇒ 一定没人听（以它为准，避免 PowerShell 报了个已关闭的旧连接）。
        occupancy.delete(probe.port);
        continue;
      }
      if (!occupancy.has(probe.port)) {
        occupancy.set(probe.port, { port: probe.port, pid: null, name: null, commandLine: null });
        if (source === 'powershell') source = 'tcp+partial';
      }
    }
    return { source, psError, occupancy };
  });
}

function pgBinDefault() {
  const fromEnv = process.env.GY_PG_BIN;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim());
  return join(dirname(REPO_ROOT), '.pg17', 'pgsql', 'bin');
}

function pgTool(pgBin, name) {
  return join(pgBin, `${name}.exe`);
}

function pgVersion(pgBin) {
  const result = run(pgTool(pgBin, 'postgres'), ['--version'], { timeoutMs: 20000 });
  const text = (result.stdout || result.stderr).trim();
  const match = /(\d+\.\d+(?:\.\d+)?)/.exec(text);
  return match === null ? null : match[1];
}

function pgIsRunning(pgBin, dataDir) {
  if (!existsSync(dataDir)) return false;
  const result = run(pgTool(pgBin, 'pg_ctl'), buildPgStatusArgs({ dataDir }), { timeoutMs: 20000 });
  return result.status === 0;
}

function psql(pgBin, args) {
  return run(pgTool(pgBin, 'psql'), args, { timeoutMs: 60000 });
}

/**
 * `npm run …` 的启动方式：优先用「`node <npm-cli.js> run …`」而不是 `shell: true`。
 *
 * 原因：Node 22+ 对「`shell: true` + 参数数组」有 DEP0190 弃用告警，而 `.cmd` 又不能直接 spawn；
 * 用 npm 自带的 `npm-cli.js` 是同一件事（`npm run db:migrate` 的等价调用），且不经过 shell，
 * 路径里有空格也不会被拆开。都找不到时才退回 shell（此时行为与手工敲命令一致）。
 */
function npmInvocation() {
  const fromEnv = process.env.npm_execpath;
  if (typeof fromEnv === 'string' && fromEnv.endsWith('.js') && existsSync(fromEnv)) {
    return { command: process.execPath, args: [fromEnv], shell: false };
  }
  const bundled = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(bundled)) return { command: process.execPath, args: [bundled], shell: false };
  return { command: 'npm', args: [], shell: true };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const command = argv[0];
  const options = {
    pgPort: DEFAULT_PORTS.pg,
    apiPort: DEFAULT_PORTS.api,
    pgBin: null,
    stateDir: null,
    out: null,
    database: DEFAULT_DATABASE,
    databaseUrl: null,
    strictPort: false,
    timeoutMs: 30000,
  };
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    return { command: 'help', options };
  }
  if (!['up', 'down', 'status'].includes(command)) {
    return { command: 'invalid', options, error: `未知子命令：${command}（只支持 up | down | status）` };
  }
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error(`${arg} 需要一个值`);
      return value;
    };
    if (arg === '--strict-port') options.strictPort = true;
    else if (arg === '--pg-port') options.pgPort = Number(next());
    else if (arg === '--api-port') options.apiPort = Number(next());
    else if (arg === '--pg-bin') options.pgBin = next();
    else if (arg === '--state-dir') options.stateDir = next();
    else if (arg === '--out') options.out = next();
    else if (arg === '--database') options.database = next();
    else if (arg === '--database-url') options.databaseUrl = next();
    else if (arg === '--timeout-ms') options.timeoutMs = Number(next());
    else if (arg === '--help' || arg === '-h') return { command: 'help', options };
    else throw new Error(`未知参数：${arg}`);
  }
  return { command, options };
}

/** state-dir 校验：必须在仓库外（密钥与数据目录不落进仓库，也不落进 `git status`）。 */
function resolveStateDir(optionValue) {
  const raw = optionValue ?? process.env.GY_LOCAL_ENV_STATE_DIR ?? DEFAULT_STATE_ROOT;
  const absolute = resolve(raw);
  const relativeToRepo = relative(REPO_ROOT, absolute);
  // `relative` 为空 ⇒ 就是仓库根本身；不以 `..` 开头且不是绝对路径（跨盘时为绝对）⇒ 落在仓库内。
  const insideRepo =
    relativeToRepo === '' || (!relativeToRepo.startsWith('..') && !isAbsolute(relativeToRepo));
  if (insideRepo) {
    throw new Error(`--state-dir 必须落在仓库外：${absolute}（⛔ 密钥与数据不落进仓库）`);
  }
  return absolute;
}

function loadState(stateDir) {
  return readJsonIfExists(join(stateDir, 'state.json'));
}

function saveState(stateDir, state) {
  writeJson(join(stateDir, 'state.json'), { schema: SCHEMA_ID, ...state });
}

// ---------------------------------------------------------------------------
// up
// ---------------------------------------------------------------------------

async function up(options) {
  const secrets = [];
  const startedAt = new Date().toISOString();
  const stateDir = resolveStateDir(options.stateDir);
  const pgBin = resolve(options.pgBin ?? pgBinDefault());
  const outPath = resolve(options.out ?? join(stateDir, 'local-env-summary.json'));
  const dataDir = join(stateDir, 'pg-data');
  const pgLog = join(stateDir, 'pg.log');
  const apiOutLog = join(stateDir, 'api.log');
  const apiErrLog = join(stateDir, 'api-error.log');
  const apiPidFile = join(stateDir, 'api.pid');
  const secretsFile = join(stateDir, 'secrets.env');
  const migrateLog = join(stateDir, 'migrate.log');

  for (const candidate of ['initdb', 'pg_ctl', 'psql']) {
    if (!existsSync(pgTool(pgBin, candidate))) {
      throw new Error(
        `PG 二进制缺失：${pgTool(pgBin, candidate)}\n` +
          '  处理：--pg-bin 指向 PostgreSQL 17 的 bin 目录，或设 GY_PG_BIN。本机已知位置：<workspace>\\.pg17\\pgsql\\bin',
      );
    }
  }
  if (options.databaseUrl !== null && !/^postgres(ql)?:\/\/\S+$/i.test(options.databaseUrl)) {
    throw new Error('--database-url 必须是 postgres:// 或 postgresql:// 连接串');
  }

  mkdirSync(stateDir, { recursive: true });
  say(`仓库根：${REPO_ROOT}`);
  say(`状态目录（仓外）：${stateDir}`);

  const previous = loadState(stateDir) ?? {};
  let pgStartedHere = false;
  let apiStartedHere = false;
  let apiPid = null;

  const rollback = () => {
    if (apiStartedHere) stopApi(apiPid, apiPidFile);
    if (pgStartedHere) {
      const result = run(pgTool(pgBin, 'pg_ctl'), buildPgStopArgs({ dataDir }), { timeoutMs: 60000 });
      say(`回滚：pg_ctl stop ⇒ ${result.status === 0 ? '已停' : '停止失败（看 pg.log）'}`);
    }
  };

  // ---- ① 端口探测 ---------------------------------------------------------
  say('');
  say('[1/8] 端口探测（Get-NetTCPConnection -State Listen + 持有进程命令行）');
  const pgRunning = pgIsRunning(pgBin, dataDir);
  const apiRunning = Number.isInteger(previous?.api?.pid) && pidAlive(previous.api.pid);
  const scanPorts = [];
  for (let offset = 0; offset <= PORT_MAX_OFFSET; offset += 1) {
    scanPorts.push(options.pgPort + offset, options.apiPort + offset);
  }
  const probe = await probePorts(scanPorts);
  if (probe.psError !== null) {
    warn(`  ！PowerShell 探测失败（${probe.psError}）⇒ 已退回 TCP 连接探测：能判「有人听」，但拿不到持有进程`);
  }

  let pgPort;
  let pgSkipped = [];
  if (pgRunning) {
    pgPort = Number(previous?.pg?.port ?? options.pgPort);
    say(`  PG 已在跑（${pgPort}，数据目录 ${dataDir}）⇒ 复用，不重启`);
  } else {
    const decision = planPort({
      preferred: options.pgPort,
      occupied: probe.occupancy,
      strict: options.strictPort,
      maxOffset: PORT_MAX_OFFSET,
    });
    if (!decision.ok) {
      warn(`✗ ${decision.detail}`);
      if (decision.reason === 'PORT_OCCUPIED_STRICT') {
        warn('  --strict-port 已要求「占就失败」：去掉该参数可自动换号。');
      }
      return EXIT.PORT;
    }
    pgPort = decision.port;
    pgSkipped = decision.skipped;
    say(`  PG 端口：${pgPort}（${decision.detail}）`);
    for (const item of decision.skipped) say(`    跳过 ${item.port}：${describeHolder(item.holder)}`);
  }

  let apiPort;
  let apiSkipped = [];
  if (apiRunning) {
    apiPort = Number(previous?.api?.port ?? options.apiPort);
    say(`  API 已在跑（${apiPort}，pid ${previous.api.pid}）⇒ 复用，不重启`);
  } else {
    const decision = planPort({
      preferred: options.apiPort,
      occupied: probe.occupancy,
      strict: options.strictPort,
      maxOffset: PORT_MAX_OFFSET,
      reserved: [pgPort],
    });
    if (!decision.ok) {
      warn(`✗ ${decision.detail}`);
      if (decision.reason === 'PORT_OCCUPIED_STRICT') {
        warn('  --strict-port 已要求「占就失败」：去掉该参数可自动换号。');
      }
      return EXIT.PORT;
    }
    apiPort = decision.port;
    apiSkipped = decision.skipped;
    say(`  API 端口：${apiPort}（${decision.detail}）`);
    for (const item of decision.skipped) say(`    跳过 ${item.port}：${describeHolder(item.holder)}`);
  }

  // ---- ② 建簇 -------------------------------------------------------------
  say('');
  say('[2/8] 初始化簇（无簇才建：initdb -U postgres -A trust --locale=C --encoding=UTF8）');
  if (!existsSync(join(dataDir, 'PG_VERSION'))) {
    const initArgs = buildInitdbArgs({ dataDir, ...INITDB_DEFAULTS });
    say(`  initdb ${initArgs.join(' ')}`);
    const result = run(pgTool(pgBin, 'initdb'), initArgs, { timeoutMs: 180000 });
    if (result.status !== 0) {
      warn('✗ initdb 失败，原文（已脱敏）：');
      warn(redactConnectionStrings(result.stderr || result.stdout).slice(0, 4000));
      rollback();
      return EXIT.POSTGRES;
    }
    say('  initdb 完成');
  } else {
    say(`  簇已存在（${dataDir}/PG_VERSION）⇒ 跳过 initdb`);
  }

  // ---- ③ 起 PG ------------------------------------------------------------
  say('');
  say('[3/8] 起 PostgreSQL 并等就绪');
  if (!pgRunning) {
    const startArgs = buildPgStartArgs({ dataDir, port: pgPort, logFile: pgLog, waitSeconds: 60 });
    const result = run(pgTool(pgBin, 'pg_ctl'), startArgs, { timeoutMs: 120000 });
    if (result.status !== 0) {
      warn('✗ pg_ctl start 失败，原文（已脱敏）：');
      warn(redactConnectionStrings(result.stderr || result.stdout).slice(0, 4000));
      warn(`  子进程日志：${pgLog}`);
      rollback();
      return EXIT.POSTGRES;
    }
    pgStartedHere = true;
  }
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const ping = psql(pgBin, buildPsqlArgs({ port: pgPort, sql: 'SELECT 1' }));
    if (ping.status === 0 && ping.stdout.trim() === '1') {
      ready = true;
      break;
    }
    await sleep(250);
  }
  if (!ready) {
    warn(`✗ PG 在 ${pgPort} 上没有就绪（psql SELECT 1 未成功），看 ${pgLog}`);
    rollback();
    return EXIT.POSTGRES;
  }
  const version = pgVersion(pgBin);
  say(`  PG 就绪：127.0.0.1:${pgPort}（PostgreSQL ${version ?? '版本未知'}）`);

  saveState(stateDir, {
    repoRoot: REPO_ROOT,
    stateDir,
    pg: { port: pgPort, dataDir, host: '127.0.0.1', user: INITDB_DEFAULTS.superuser, database: options.database, version },
    api: { port: apiPort, pid: apiRunning ? previous.api.pid : null },
    startedAt,
  });

  // ---- ④ 建库 + 迁移 ------------------------------------------------------
  say('');
  say('[4/8] 建库 + npm run db:migrate');
  const databaseUrl =
    options.databaseUrl ?? buildDatabaseUrl({ port: pgPort, database: options.database });
  if (options.databaseUrl !== null) {
    say('  --database-url 已覆盖连接串 ⇒ 跳过建库（连别人的库时不要替它建库）');
  } else {
    const exists = psql(pgBin, buildPsqlArgs({ port: pgPort, sql: buildDatabaseExistsSql(options.database) }));
    if (exists.status !== 0) {
      warn(`✗ 查库存在性失败：${redactConnectionStrings(exists.stderr).slice(0, 1000)}`);
      rollback();
      return EXIT.POSTGRES;
    }
    if (exists.stdout.trim() !== '1') {
      const created = psql(pgBin, buildPsqlArgs({ port: pgPort, sql: buildCreateDatabaseSql(options.database) }));
      if (created.status !== 0) {
        warn(`✗ 建库失败：${redactConnectionStrings(created.stderr).slice(0, 1000)}`);
        rollback();
        return EXIT.POSTGRES;
      }
      say(`  已建库：${options.database}`);
    } else {
      say(`  库已存在：${options.database}`);
    }
  }

  const migrateEnv = { ...process.env, DATABASE_URL: databaseUrl };
  const npm = npmInvocation();
  const migrate = run(npm.command, [...npm.args, 'run', 'db:migrate'], {
    env: migrateEnv,
    timeoutMs: 300000,
    shell: npm.shell === true,
  });
  writeFileSync(migrateLog, `${migrate.stdout}\n--- stderr ---\n${migrate.stderr}\n`, 'utf8');
  const verdict = classifyMigrateFailure({ exitCode: migrate.status, stdout: migrate.stdout, stderr: migrate.stderr, secrets });
  const migrationReadout = parseMigrateOutput(migrate.stdout);
  if (verdict.failed) {
    warn(`✗ db:migrate 失败（exit ${String(migrate.status ?? migrate.errorCode)}，分类 ${verdict.kind}，retryable=${String(verdict.retryable)}）`);
    if (verdict.evidence !== null) warn(`  证据（已脱敏）：${verdict.evidence}`);
    warn(`  下一步：${verdict.hint}`);
    warn(`  完整输出（已脱敏）：${migrateLog}`);
    rollback();
    return EXIT.MIGRATE;
  }
  say(
    `  迁移 OK：发现 ${migrationReadout.discovered ?? '?'} 个，` +
      `本次应用 ${migrationReadout.appliedCount ?? '?'} 条，已存在跳过 ${migrationReadout.skippedCount ?? '?'} 条`,
  );

  // ---- ⑤ 临时密钥 ---------------------------------------------------------
  say('');
  say('[5/8] 生成临时密钥（只写进程环境与仓外临时文件，⛔ 不打印值）');
  const keyValues = {};
  for (const name of SECRET_ENV_NAMES) keyValues[name] = randomBytes(32).toString('base64url');
  secrets.push(...Object.values(keyValues));
  const secretsBody = `${SECRET_ENV_NAMES.map((name) => `${name}=${keyValues[name]}`).join('\n')}\n`;
  writeFileSync(secretsFile, secretsBody, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(secretsFile, 0o600);
  } catch {
    // Windows 上 chmod 只影响只读位；这里失败不影响「不落进仓库」这条硬边界。
  }
  const keyReadouts = {};
  for (const name of SECRET_ENV_NAMES) keyReadouts[name] = keyDescriptor(keyValues[name]);
  say(`  ${SECRET_ENV_NAMES.map((name) => `${name}: 已生成，长度满足=${String(keyReadouts[name].length_ok)}`).join('；')}`);
  say(`  落盘位置（仓外）：${secretsFile}`);

  // ---- ⑥ 后台起 API -------------------------------------------------------
  say('');
  say('[6/8] 后台起 API（APP_EXECUTION_MODE=stub）');
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  if (!apiRunning) {
    const apiEnv = {
      ...process.env,
      APP_EXECUTION_MODE: 'stub',
      API_HOST: '127.0.0.1',
      API_PORT: String(apiPort),
      DATABASE_URL: databaseUrl,
      SESSION_SIGNING_KEY: keyValues.SESSION_SIGNING_KEY,
      DELETION_LEDGER_KEY: keyValues.DELETION_LEDGER_KEY,
      LOG_LEVEL: process.env.GY_LOCAL_ENV_API_LOG_LEVEL ?? 'info',
    };
    const outFd = openSync(apiOutLog, 'a');
    const errFd = openSync(apiErrLog, 'a');
    const child = spawn(process.execPath, [API_ENTRY], {
      cwd: REPO_ROOT,
      env: apiEnv,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
    });
    child.unref();
    apiPid = child.pid ?? null;
    apiStartedHere = true;
    writeFileSync(apiPidFile, `${String(apiPid)}\n`, 'utf8');
    say(`  已启动：pid ${String(apiPid)}（日志 ${apiOutLog} / ${apiErrLog}）`);
  } else {
    apiPid = previous.api.pid;
    say(`  API 已在跑：pid ${apiPid} ⇒ 不重启`);
  }

  // ---- ⑦ 等就绪 + 打 6 个端点 ---------------------------------------------
  say('');
  say(`[7/8] 等 /health 就绪（上限 ${options.timeoutMs}ms）`);
  const health = await waitForHealth(baseUrl, options.timeoutMs);
  if (!health.ok) {
    warn(`✗ /health 未就绪：${health.detail}`);
    warn(`  API 日志：${apiOutLog} / ${apiErrLog}`);
    const endpoints = await probeEndpoints(baseUrl, Math.min(5000, options.timeoutMs));
    const summary = buildSummary({
      generatedAt: new Date().toISOString(),
      repoRoot: REPO_ROOT,
      stateDir,
      outPath,
      ports: { pg: { preferred: options.pgPort, actual: pgPort, skipped: pgSkipped }, api: { preferred: options.apiPort, actual: apiPort, skipped: apiSkipped } },
      postgres: { version, port: pgPort, dataDir, database: options.database, ready: false },
      api: { baseUrl, port: apiPort, pid: apiPid, executionMode: 'stub', health: 'degraded' },
      migrations: migrationReadout,
      keys: { ...keyReadouts, storage: secretsFile },
      endpoints,
      consentPoliciesRows: null,
    });
    emitSummary(summary, outPath, secrets);
    rollback();
    return EXIT.ENDPOINTS;
  }
  say(`  /health 就绪：status=${health.status}，database.status=${health.databaseStatus}`);

  say('');
  say('[8/8] 端点可达性（6 个）');
  const endpoints = await probeEndpoints(baseUrl, Math.min(15000, Math.max(3000, options.timeoutMs / 2)));
  for (const row of endpoints) {
    const mark = row.ok ? '✓' : '✗';
    say(`  ${mark} ${row.method} ${row.path} ⇒ ${row.status ?? '无响应'}（期望 ${row.expected_status}）${row.detail === null ? '' : ` — ${row.detail}`}`);
  }

  // 已知边界：consent_policies 行数（只读；⛔ 不插行）
  const consent = psql(pgBin, buildPsqlArgs({ port: pgPort, database: options.database, sql: buildConsentPoliciesCountSql() }));
  const consentRows = consent.status === 0 ? Number(consent.stdout.trim()) : null;
  say('');
  for (const boundary of knownBoundaryLines(consentRows)) {
    say(`  已知边界：${boundary.detail}`);
  }

  saveState(stateDir, {
    repoRoot: REPO_ROOT,
    stateDir,
    pg: { port: pgPort, dataDir, host: '127.0.0.1', user: INITDB_DEFAULTS.superuser, database: options.database, version },
    api: { port: apiPort, pid: apiPid },
    startedAt,
  });

  const summary = buildSummary({
    generatedAt: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    stateDir,
    outPath,
    ports: {
      pg: { preferred: options.pgPort, actual: pgPort, skipped: pgSkipped },
      api: { preferred: options.apiPort, actual: apiPort, skipped: apiSkipped },
    },
    postgres: { version, host: '127.0.0.1', port: pgPort, dataDir, database: options.database, ready: true },
    api: { baseUrl, port: apiPort, pid: apiPid, executionMode: 'stub', health: health.status },
    migrations: migrationReadout,
    keys: { ...keyReadouts, storage: secretsFile },
    endpoints,
    consentPoliciesRows: consentRows,
  });
  emitSummary(summary, outPath, secrets);

  if (!allEndpointsExpected(endpoints)) {
    warn('');
    warn('✗ 有端点的读数不符合预期（摘要已写盘，如实记录，⛔ 不当成功）。');
    return EXIT.ENDPOINTS;
  }
  say('');
  say(`就绪：API ${baseUrl}；PG 127.0.0.1:${pgPort}；收工前请跑 npm run local:down。`);
  return EXIT.OK;
}

function emitSummary(summary, outPath, secrets) {
  const text = serializeSummary(summary);
  assertNoSecretLeaks('摘要 JSON', text, secrets);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text, 'utf8');
  say('');
  say(`结构化摘要 JSON（已脱敏，落盘 ${outPath}）：`);
  say(text.trimEnd());
}

async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = '尚无响应';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      const body = await response.json().catch(() => null);
      const databaseStatus = body?.checks?.database?.status ?? null;
      const status = body?.status ?? null;
      if (response.status === 200 && status === 'ok' && databaseStatus === 'ok') {
        return { ok: true, status, databaseStatus, detail: null };
      }
      lastDetail = `HTTP ${response.status}，body.status=${String(status)}，checks.database.status=${String(databaseStatus)}`;
      if (databaseStatus === 'error') {
        lastDetail += `（database.category=${String(body?.checks?.database?.category ?? 'null')}）`;
      }
    } catch (error) {
      lastDetail = `请求失败：${error?.name ?? 'Error'}`;
    }
    await sleep(250);
  }
  return { ok: false, status: null, databaseStatus: null, detail: lastDetail };
}

async function probeEndpoints(baseUrl, timeoutMs) {
  const rows = [];
  let token = null;
  for (const endpoint of REQUIRED_ENDPOINTS) {
    const headers = { accept: 'application/json' };
    let body;
    if (endpoint.method === 'POST') {
      headers['content-type'] = 'application/json';
      headers['idempotency-key'] = `local-env-${randomUUID()}`;
      body = JSON.stringify({ code: 'local-env-smoke' });
    }
    if (endpoint.auth && token !== null) headers.authorization = `Bearer ${token}`;
    try {
      const response = await fetch(`${baseUrl}${endpoint.path}`, {
        method: endpoint.method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (endpoint.name === 'auth_wechat' && response.status === 200) {
        token = extractAccessToken(text);
      }
      const ok = response.status === endpoint.expected;
      rows.push({
        name: endpoint.name,
        method: endpoint.method,
        path: endpoint.path,
        expected_status: endpoint.expected,
        status: response.status,
        ok,
        detail: ok ? null : `响应片段：${redactConnectionStrings(text).slice(0, 160).replace(/\s+/g, ' ')}`,
      });
    } catch (error) {
      rows.push({
        name: endpoint.name,
        method: endpoint.method,
        path: endpoint.path,
        expected_status: endpoint.expected,
        status: null,
        ok: false,
        detail: `请求失败：${error?.name ?? 'Error'}`,
      });
    }
  }
  return rows;
}

function extractAccessToken(text) {
  try {
    const parsed = JSON.parse(text);
    const token = parsed?.data?.access_token;
    return typeof token === 'string' && token !== '' ? token : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// down / status
// ---------------------------------------------------------------------------

function stopApi(pid, pidFile) {
  if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
    try {
      process.kill(pid);
    } catch (error) {
      warn(`  ！结束 API 失败（pid ${pid}）：${error?.message ?? '未知错误'}`);
    }
  }
  // 同步等待：down 是收尾动作，调用方要看到「端口真的放了」。
  const deadline = Date.now() + 10000;
  while (pidAlive(pid) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  if (pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已经没了。
    }
  }
  if (pidFile !== null && existsSync(pidFile)) {
    try {
      rmSync(pidFile);
    } catch {
      // pid 文件删不掉不影响「进程已停」这个事实。
    }
  }
  return !pidAlive(pid);
}

async function down(options) {
  const stateDir = resolveStateDir(options.stateDir);
  const pgBin = resolve(options.pgBin ?? pgBinDefault());
  const state = loadState(stateDir);
  const apiPidFile = join(stateDir, 'api.pid');
  const apiPidFromFile = existsSync(apiPidFile) ? Number(readFileSync(apiPidFile, 'utf8').trim()) : null;
  const apiPid = Number.isInteger(apiPidFromFile) ? apiPidFromFile : Number(state?.api?.pid ?? NaN);
  const apiPort = Number(state?.api?.port ?? DEFAULT_PORTS.api);
  const pgPort = Number(state?.pg?.port ?? DEFAULT_PORTS.pg);
  const dataDir = typeof state?.pg?.dataDir === 'string' ? state.pg.dataDir : join(stateDir, 'pg-data');

  say(`状态目录（仓外）：${stateDir}`);
  if (state === null) say('  没有 state.json ⇒ 这套环境没有被 local:up 起过（仍然继续收尾，幂等）');

  let stoppedSomething = false;

  say('');
  say('[1/2] 停 API（按 pid 文件）');
  if (Number.isInteger(apiPid) && pidAlive(apiPid)) {
    const stopped = stopApi(apiPid, apiPidFile);
    say(`  API pid ${apiPid} ⇒ ${stopped ? '已停' : '未能停止（看任务管理器）'}`);
    stoppedSomething = true;
  } else {
    say(`  API 没起（pid ${Number.isInteger(apiPid) ? apiPid : '未知'} 不在）`);
    if (existsSync(apiPidFile)) {
      try {
        rmSync(apiPidFile);
      } catch {
        // 忽略。
      }
    }
  }

  say('');
  say('[2/2] 停 PostgreSQL（pg_ctl stop -m fast）');
  if (existsSync(dataDir) && pgIsRunning(pgBin, dataDir)) {
    const result = run(pgTool(pgBin, 'pg_ctl'), buildPgStopArgs({ dataDir }), { timeoutMs: 60000 });
    if (result.status === 0) {
      say(`  PG（数据目录 ${dataDir}）⇒ 已停`);
      stoppedSomething = true;
    } else {
      warn(`✗ pg_ctl stop 失败：${redactConnectionStrings(result.stderr || result.stdout).slice(0, 1500)}`);
      warn(`  日志：${join(stateDir, 'pg.log')}`);
      return EXIT.POSTGRES;
    }
  } else {
    say('  PG 没起（pg_ctl status 非 0）');
  }

  const apiListening = await portListening(apiPort);
  const pgListening = await portListening(pgPort);
  say('');
  say(`端口实测：${apiPort} ${apiListening ? '仍在监听（✗）' : '已释放'}；${pgPort} ${pgListening ? '仍在监听（✗）' : '已释放'}`);
  if (apiListening || pgListening) {
    warn('✗ 仍有端口在监听：可能有别的进程占了同名端口，或停止未生效。');
    return EXIT.POSTGRES;
  }
  say(stoppedSomething ? '已停：API 与 PG 都已收干净（数据保留在 state-dir）。' : '本来就没起：没有需要停的进程（exit 0）。');
  return EXIT.OK;
}

async function status(options) {
  const stateDir = resolveStateDir(options.stateDir);
  const pgBin = resolve(options.pgBin ?? pgBinDefault());
  const state = loadState(stateDir);
  const apiPidFile = join(stateDir, 'api.pid');
  const apiPid = existsSync(apiPidFile) ? Number(readFileSync(apiPidFile, 'utf8').trim()) : Number(state?.api?.pid ?? NaN);
  const apiPort = Number(state?.api?.port ?? DEFAULT_PORTS.api);
  const pgPort = Number(state?.pg?.port ?? DEFAULT_PORTS.pg);
  const dataDir = typeof state?.pg?.dataDir === 'string' ? state.pg.dataDir : join(stateDir, 'pg-data');

  const apiAlive = Number.isInteger(apiPid) && pidAlive(apiPid);
  const pgAlive = existsSync(dataDir) && pgIsRunning(pgBin, dataDir);
  const apiListening = await portListening(apiPort);
  const pgListening = await portListening(pgPort);

  say(`状态目录（仓外）：${stateDir}`);
  say(
    `PG   端口 ${pgPort}  ${pgAlive ? '在跑' : '没跑'}  ${pgListening ? '端口在听' : '端口空闲'}  数据目录 ${dataDir}`,
  );
  // pid 只在**活着**时才打印：`state.json` 里的旧 pid 会在 `down` 之后留下来，
  // 直接显示它会让「已停」看起来像「还在跑」——那正是这个工具要消灭的那类误读。
  const pidText = apiAlive ? `${apiPid}` : `无（上次 ${Number.isInteger(apiPid) ? apiPid : '未知'} 已退出）`;
  say(
    `API  端口 ${apiPort}  ${apiAlive ? '在跑' : '没起'}  ${apiListening ? '端口在听' : '端口空闲'}  ` +
      `pid ${pidText}  模式 stub`,
  );
  say('');
  say(pgAlive || apiAlive ? '在用：npm run local:down 收工。' : '没起：npm run local:up 起一套。');
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    warn(`✗ ${error.message}`);
    warn('');
    warn(USAGE_TEXT);
    return EXIT.USAGE;
  }
  if (parsed.command === 'help') {
    say(USAGE_TEXT);
    return EXIT.OK;
  }
  if (parsed.command === 'invalid') {
    warn(`✗ ${parsed.error}`);
    warn('');
    warn(USAGE_TEXT);
    return EXIT.USAGE;
  }
  try {
    if (parsed.command === 'up') return await up(parsed.options);
    if (parsed.command === 'down') return await down(parsed.options);
    return await status(parsed.options);
  } catch (error) {
    warn(`✗ ${error?.message ?? String(error)}`);
    return EXIT.USAGE;
  }
}

function isDirectRun() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return resolve(entry) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
