#!/usr/bin/env node
/**
 * 耕云本机演示栈：一条命令把「一次性 PostgreSQL 簇 + 迁移 + 种子 + API」拉起来。
 *
 * 设计约束（为什么不是简单的 `npm run dev`）：
 * 1. **幂等**：重复 `up` 不重复 initdb、不重复种子、不重启已在跑的 API；
 * 2. **可诊断**：每一步有编号与结论；失败打印「分类 + 修法」以及最后 30 行 API 日志；
 * 3. **不随调用者一起死**：API 用 `detached` + pid 文件（DSH 后台作业被杀不会连带 postmaster）；
 * 4. **端口被占要点名**：打印持有进程的 pid / 进程名 / 命令行，而不是只说「端口占用」；
 * 5. **不打印密钥**：env 只打键名与来源；生成的签名钥匙写在 state-dir/secrets.env（0600）。
 *
 * 纯逻辑在 `tools/lib/demo-stack.mjs`（单测覆盖），本文件只做 IO 与编排。
 * 运行手册：docs/demo/本地演示-stack.md；实跑证据：docs/verification/gy-r90-demo-stack-20261109.md。
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';

import {
  DEFAULT_PORTS, DEMO_FLAG_KEYS,
  ENV_FILE_TEMPLATE,
  GENERATED_KEYS,
  INSTANCE_FLAG,
  UsageError,
  assembleApiEnv, buildDemoFlagSql,
  buildPidRecord,
  buildPsqlFileArgs,
  classifyFailure,
  commandHasInstance,
  describeEnvSources,
  healthVerdict,
  nextPollDelay,
  nextStepsLines,
  parseArgs,
  parsePidRecord,
  readEnvFile,
  readSecretsFile,
  renderSecretsFile,
  requiredEnvMissing,
  resolvePaths,
  statusLines,
  tailLines,
  usage,
} from './lib/demo-stack.mjs';
import {
  buildCreateDatabaseSql,
  buildDatabaseExistsSql,
  buildDatabaseUrl,
  buildInitdbArgs,
  buildPgStartArgs,
  buildPgStatusArgs,
  buildPgStopArgs,
  buildPsqlArgs,
  redactConnectionStrings,
} from './lib/local-env.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_ENTRY = join(REPO_ROOT, 'services', 'api', 'src', 'server.ts');
const MIGRATE_ENTRY = join(REPO_ROOT, 'services', 'api', 'src', 'db', 'migrate.ts');
const SEED_FILES = ['seed_reference.sql', 'seed_herbicides_verified.sql'].map((name) => join(REPO_ROOT, 'db', 'seeds', name));
// 演示资料种子：只有 `--seed-demo` 显式打开才跑。灌进去的是**演示用资料**，
// 不是生产数据、也不代表第三方审核（文件头与 docs/demo 运行手册都写明了）。
const DEMO_SEED_FILE = join(REPO_ROOT, 'db', 'seeds', 'demo_catalog_verified.sql');
const DATABASE_NAME = 'gengyun';

/** 退出码：不同阶段不同码，脚本与人都能据此判断卡在哪。 */
const EXIT = { OK: 0, USAGE: 1, PORT: 2, PG: 3, MIGRATE: 4, SEED: 5, API: 6, HEALTH: 7, DEMO: 8 };

const WIN = process.platform === 'win32';

function say(line = '') {
  process.stdout.write(`${line}\n`);
}

function warn(line) {
  process.stderr.write(`${line}\n`);
}

function failHead(title, detail) {
  warn(`✗ ${title}${detail ? `：${detail}` : ''}`);
}

function failWith(failure, extra = []) {
  const classified = classifyFailure(failure);
  failHead(classified.code, stripAnsi(redactConnectionStrings(String(failure.output ?? '').trim()).split(/\r?\n/u)[0] ?? ''));
  warn(`  处理：${classified.hint}`);
  for (const line of extra) warn(line);
  return classified;
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/gu, '');
}

// ---------------------------------------------------------------- 进程与端口

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Windows 上取命令行（归属判据）；拿不到就返回 null，调用方不得据此「猜归属」而杀进程。 */
function commandLineOf(pid) {
  if (!WIN) {
    const result = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  }
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter ("ProcessId=${pid}") -ErrorAction SilentlyContinue;`,
    'if ($p) { $p.CommandLine }',
  ].join(' ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  const line = (result.stdout ?? '').trim();
  return line === '' ? null : line;
}

function tcpListening(port, host = '127.0.0.1', timeoutMs = 600) {
  return new Promise((resolvePromise) => {
    const socket = connect({ port, host });
    const done = (value) => {
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 端口持有者：PowerShell 一次调用（拿到 pid / 进程名 / 命令行），TCP 连接负责「是否真在听」。 */
async function probePort(port) {
  const listening = await tcpListening(port);
  if (!listening) return { port, listening: false, pid: null, name: null, commandLine: null };
  let holder = { pid: null, name: null, commandLine: null };
  if (WIN) {
    const script = [
      `$c = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1;`,
      'if ($c) { $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $c.OwningProcess) -ErrorAction SilentlyContinue;',
      '@{ pid = [int]$c.OwningProcess; name = $(if ($p) { $p.Name } else { $null }); commandLine = $(if ($p) { $p.CommandLine } else { $null }) } | ConvertTo-Json -Compress }',
    ].join(' ');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    });
    if (result.status === 0 && (result.stdout ?? '').trim() !== '') {
      try {
        const parsed = JSON.parse(result.stdout.trim());
        holder = { pid: parsed.pid ?? null, name: parsed.name ?? null, commandLine: parsed.commandLine ?? null };
      } catch {
        holder = { pid: null, name: null, commandLine: null };
      }
    }
  }
  return { port, listening: true, ...holder };
}

function describeHolder(holder) {
  if (!holder?.listening) return '空闲';
  const who = holder.pid ? `pid ${holder.pid}${holder.name ? `（${holder.name}）` : ''}` : '持有进程未知';
  const cmd = holder.commandLine ? `\n     命令行：${redactConnectionStrings(holder.commandLine).slice(0, 300)}` : '';
  return `被占用：${who}${cmd}`;
}

// ---------------------------------------------------------------- 文件与状态

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function readTextIfExists(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJsonIfExists(file) {
  const text = readTextIfExists(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 从本仓库向上找「指挥器根目录」：含 `.pg17` 的目录，或本身就是 `.pg17`。找不到就用仓库上级。 */
function findCommanderRoot(start) {
  let current = start;
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(current, '.pg17', 'pgsql', 'bin')) || existsSync(join(current, '.pg17', 'demo-stack'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    if (resolve(parent) === resolve(current)) break;
    const parentBase = parent.split(/[\\/]/u).pop();
    if (parentBase === '.pg17') return dirname(parent);
    current = parent;
  }
  return dirname(start);
}

const COMMANDER_ROOT = findCommanderRoot(REPO_ROOT);

function defaultStateDir() {
  return join(COMMANDER_ROOT, '.pg17', 'demo-stack');
}

function defaultPgBin() {
  return join(COMMANDER_ROOT, '.pg17', 'pgsql', 'bin');
}

function pgTool(pgBin, name) {
  return join(pgBin, WIN ? `${name}.exe` : name);
}

function run(cmd, args, { cwd = REPO_ROOT, env, timeoutMs = 120_000, input } = {}) {
  return spawnSync(cmd, args, {
    cwd,
    env: env ?? process.env,
    encoding: 'utf8',
    timeout: timeoutMs,
    input,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function runOrThrow(cmd, args, context) {
  const result = run(cmd, args);
  if (result.error) {
    return { ok: false, status: null, stdout: result.stdout ?? '', stderr: `${result.error.code ?? ''} ${result.error.message}` };
  }
  if (result.status !== 0) {
    return { ok: false, status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }
  return { ok: true, status: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '', context };
}

// ---------------------------------------------------------------- 健康检查

async function probeHealth(port, timeoutMs = 2500) {
  const url = `http://127.0.0.1:${port}/health`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    let body = null;
    const text = await response.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { ...healthVerdict({ statusCode: response.status, body }), statusCode: response.status, body, url };
  } catch (error) {
    const message = error?.name === 'TimeoutError' ? '请求超时' : error?.cause?.code ?? error?.code ?? error?.message;
    return { ...healthVerdict({ error: String(message) }), statusCode: null, body: null, url };
  }
}

async function waitForHealth(port, timeoutMs) {
  const startedAt = Date.now();
  let last = await probeHealth(port);
  let attempt = 0;
  const trace = [];
  while (!last.state || last.state !== 'ready') {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) {
      return { ok: false, elapsedMs: elapsed, last, trace, attempts: attempt + 1 };
    }
    const delay = nextPollDelay(attempt);
    trace.push(`${elapsed}ms ${last.state}：${last.reason}`);
    // 不用 await 睡满整个剩余预算：最后一次探测后立即返回，超时读数更准。
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(delay, Math.max(0, timeoutMs - elapsed))));
    last = await probeHealth(port);
    attempt += 1;
  }
  return { ok: true, elapsedMs: Date.now() - startedAt, last, trace, attempts: attempt + 1 };
}

// ---------------------------------------------------------------- PostgreSQL

function pgRunning(pgBin, dataDir) {
  if (!existsSync(dataDir)) return false;
  const result = run(pgTool(pgBin, 'pg_ctl'), buildPgStatusArgs({ dataDir }), { timeoutMs: 20000 });
  return result.status === 0;
}

function pgVersion(pgBin) {
  const result = run(pgTool(pgBin, 'postgres'), ['--version'], { timeoutMs: 20000 });
  const text = (result.stdout || result.stderr || '').trim();
  return /(\d+\.\d+(?:\.\d+)?)/u.exec(text)?.[1] ?? null;
}

function psql(pgBin, args, timeoutMs = 120_000) {
  return run(pgTool(pgBin, 'psql'), args, { timeoutMs });
}

/**
 * `pg_ctl start` 的输出必须写进文件，不能走管道：postmaster 会继承 pg_ctl 的 stdio 句柄，
 * 用管道时 spawnSync 要等所有句柄关闭才返回，于是「服务器已启动」之后还要卡满整段超时
 * （2026-11-09 实测：pg.log 里 0.3s 就 ready，工具却停 90s 并把 ETIMEDOUT 当成功）。
 * 文件句柄不参与等待，pg_ctl 一退出就返回；诊断信息留在 pg-ctl.log 里。
 */
function runPgCtlStart(pgBin, args, logFile, timeoutMs = 90_000) {
  writeFileSync(logFile, '', 'utf8');
  const fd = openSync(logFile, 'a');
  try {
    return spawnSync(pgTool(pgBin, 'pg_ctl'), args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['ignore', fd, fd],
      timeout: timeoutMs,
      windowsHide: true,
    });
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------- 状态文件

function readState(paths) {
  const state = readJsonIfExists(paths.stateFile);
  if (!state || typeof state !== 'object') return { seeded: [] };
  return { seeded: Array.isArray(state.seeded) ? state.seeded : [], ...state };
}

function writeState(paths, patch) {
  const previous = readState(paths);
  writeJson(paths.stateFile, { ...previous, ...patch, updatedAt: new Date().toISOString() });
}

function loadSecrets(paths) {
  const text = readTextIfExists(paths.secretsFile);
  return text === null ? {} : readSecretsFile(text);
}

function persistSecrets(paths, env) {
  const merged = { ...loadSecrets(paths) };
  let changed = false;
  for (const key of GENERATED_KEYS) {
    if (typeof env[key] === 'string' && env[key] !== '' && merged[key] !== env[key]) {
      merged[key] = env[key];
      changed = true;
    }
  }
  if (!changed) return;
  ensureDir(paths.stateDir);
  writeFileSync(paths.secretsFile, renderSecretsFile(merged), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(paths.secretsFile, 0o600);
  } catch {
    /* Windows 上 chmod 只是尽力而为 */
  }
}

function loadEnvFile(path) {
  if (!path) return { values: {}, errors: [] };
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (!existsSync(absolute)) throw new UsageError(`--env-file 不存在：${absolute}`);
  const text = readFileSync(absolute, 'utf8');
  const parsed = readEnvFile(text);
  if (parsed.errors.length > 0) {
    const detail = parsed.errors.map((item) => `第 ${item.line} 行 ${item.reason}`).join('；');
    throw new UsageError(`--env-file 格式有误：${detail}`);
  }
  return { values: parsed.values, errors: [], path: absolute };
}

// ---------------------------------------------------------------- 各子命令

function contextFromOptions(options) {
  const stateDir = options.stateDir ? resolve(process.cwd(), options.stateDir) : defaultStateDir();
  const pgBin = options.pgBin ? resolve(process.cwd(), options.pgBin) : defaultPgBin();
  const paths = resolvePaths({ stateDir, repoRoot: REPO_ROOT });
  // 端口没显式给时沿用上一次 up 记下的端口：否则 `up --port 3210` 之后，
  // `status`/`down` 会跑去查默认的 3000（那里可能正好有别的服务，结论会误导人）。
  const state = readJsonIfExists(paths.stateFile) ?? {};
  const apiPort = options.apiPortExplicit ? options.apiPort : Number.isInteger(state.apiPort) ? state.apiPort : options.apiPort;
  const pgPort = options.pgPortExplicit ? options.pgPort : Number.isInteger(state.pgPort) ? state.pgPort : options.pgPort;
  return { options: { ...options, apiPort, pgPort }, paths, pgBin };
}

function printPlan(context) {
  const { options, paths, pgBin } = context;
  say(`[1/9] 参数与状态目录`);
  say(`  模式：${options.mode}`);
  say(`  API：http://127.0.0.1:${options.apiPort}`);
  say(`  PG：127.0.0.1:${options.pgPort}（只听本机）`);
  say(`  状态目录：${paths.stateDir}`);
  say(`  数据目录：${paths.dataDir}`);
  say(`  PG bin：${pgBin}`);
}

/**
 * 演示档：迁移完成后把三个契约开关置为开启。
 *
 * 只走 psql 的**一个** `-c`：三条 UPDATE 在同一个 simple query 里，失败整组回滚；
 * SQL 自带幂等条件，重复 `up --demo` 不会再次累加 revision。这里不改迁移、不碰 `services/**`。
 */
function applyDemoProfile({ options, pgBin }) {
  const result = psql(pgBin, buildPsqlArgs({ port: options.pgPort, database: DATABASE_NAME, sql: buildDemoFlagSql({ demo: true }) }), 60_000);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status !== 0) {
    failWith({ stage: 'demo-profile', output }, [
      '  栈的其它部分已就绪，但三个开关没有写成演示档；先修 psql 报错，再重跑 `up --demo`。',
    ]);
    return EXIT.DEMO;
  }

  const updated = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => DEMO_FLAG_KEYS.includes(line));
  say('[8/9] 演示开关：已开启 submissions_enabled / specific_herbicide_output_enabled / ai_enabled（非生产）');
  if (updated.length === 0) {
    say('  已是演示档：3 个开关均已开启且 reason 一致，revision 未重复累加（幂等）');
  } else {
    say(`  本次更新 ${updated.length}/3 个开关（revision +1）：${updated.join(' / ')}`);
  }
  return EXIT.OK;
}

async function teardown(context, { keepData = true } = {}) {
  const { options, paths, pgBin } = context;
  const stopped = { api: '未运行', pg: '未运行' };

  const pidRecord = parsePidRecord(readTextIfExists(paths.pidFile) ?? '');
  if (pidRecord) {
    if (!processAlive(pidRecord.pid)) {
      stopped.api = `pid ${pidRecord.pid} 已不在（清理陈旧 pid 文件）`;
      rmSync(paths.pidFile, { force: true });
    } else {
      const commandLine = commandLineOf(pidRecord.pid);
      if (!commandHasInstance(commandLine, pidRecord.instanceId)) {
        stopped.api = `pid ${pidRecord.pid} 不是本工具起的实例（命令行无实例标记），不杀`;
        warn(`  ！${stopped.api}；如确认要停它，请手动结束该进程`);
      } else {
        try {
          process.kill(pidRecord.pid, 'SIGTERM');
        } catch {
          /* 已经退出 */
        }
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && processAlive(pidRecord.pid)) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
        }
        if (processAlive(pidRecord.pid) && WIN) {
          run('taskkill', ['/PID', String(pidRecord.pid), '/T', '/F'], { timeoutMs: 20000 });
        }
        stopped.api = processAlive(pidRecord.pid) ? `pid ${pidRecord.pid} 仍在运行（强制失败）` : `已停（pid ${pidRecord.pid}）`;
        if (!processAlive(pidRecord.pid)) rmSync(paths.pidFile, { force: true });
      }
    }
  }

  if (pgRunning(pgBin, paths.dataDir)) {
    const result = run(pgTool(pgBin, 'pg_ctl'), buildPgStopArgs({ dataDir: paths.dataDir, mode: 'fast' }), { timeoutMs: 60000 });
    stopped.pg = result.status === 0 ? '已停（fast）' : `停止失败：${(result.stderr || result.stdout || '').trim().split(/\r?\n/u)[0]}`;
  } else if (existsSync(paths.dataDir)) {
    stopped.pg = '未运行';
  }

  if (!keepData) {
    rmSync(paths.stateDir, { recursive: true, force: true });
    stopped.data = `已删除 ${paths.stateDir}`;
  }
  return stopped;
}

async function commandUp(options) {
  const context = contextFromOptions(options);
  const { paths, pgBin } = context;
  options = context.options;

  printPlan(context);

  // ---- ② 端口
  say('');
  say('[2/9] 端口探测');
  const apiHolder = await probePort(options.apiPort);
  const pgHolder = await probePort(options.pgPort);
  say(`  API ${options.apiPort}：${describeHolder(apiHolder)}`);
  say(`  PG  ${options.pgPort}：${describeHolder(pgHolder)}`);

  if (apiHolder.listening) {
    const record = parsePidRecord(readTextIfExists(paths.pidFile) ?? '');
    const ours = record !== null && record.pid === apiHolder.pid && commandHasInstance(apiHolder.commandLine, record.instanceId);
    if (!ours) {
      warn('');
      failHead(`API 端口 ${options.apiPort} 已被占用`, apiHolder.pid ? `pid ${apiHolder.pid}${apiHolder.name ? `（${apiHolder.name}）` : ''}` : '持有进程未知');
      if (apiHolder.commandLine) warn(`  命令行：${redactConnectionStrings(apiHolder.commandLine).slice(0, 300)}`);
      warn(`  处理：换一个端口（--port 3001）或先结束该进程；本工具不会去杀不是自己起的进程`);
      return EXIT.PORT;
    }
    say(`  API 是本工具上一次起的实例（pid ${apiHolder.pid}）⇒ 不重复启动，等它变健康`);
    const health = await waitForHealth(options.apiPort, options.timeoutMs);
    if (!health.ok) {
      failHead('健康检查未通过', `${health.elapsedMs}ms 后仍 ${health.last.state}`);
      warn(`  API 日志（最后 30 行，${paths.apiLog}）：`);
      for (const line of tailLines(readTextIfExists(paths.apiLog) ?? '', 30).split('\n')) warn(`    ${line}`);
      return EXIT.HEALTH;
    }
    say(`  ✓ /health → ${health.last.reason}（${health.elapsedMs}ms）`);
    for (const line of nextStepsLines({ mode: options.mode, apiPort: options.apiPort, seedDemo: options.seedDemo })) say(line);
    return EXIT.OK;
  }

  if (pgHolder.listening && !pgRunning(pgBin, paths.dataDir)) {
    warn('');
    failHead(`PG 端口 ${options.pgPort} 已被别的进程占用`, pgHolder.pid ? `pid ${pgHolder.pid}` : '持有进程未知');
    if (pgHolder.commandLine) warn(`  命令行：${redactConnectionStrings(pgHolder.commandLine).slice(0, 300)}`);
    warn('  处理：换 --pg-port，或先停掉那个 PG 实例');
    return EXIT.PORT;
  }

  // ---- ③ env：放在端口探测之后，已有实例能直接短路，不必先备凭据
  say('');
  say('[3/9] 检查 env 与凭据');
  const envFile = loadEnvFile(options.envFile);
  const existingSecrets = loadSecrets(paths);
  const secrets = { ...existingSecrets };
  let assembled = assembleApiEnv({
    mode: options.mode,
    apiPort: options.apiPort,
    databaseUrl: buildDatabaseUrl({ port: options.pgPort, database: DATABASE_NAME }),
    envFile: envFile.values,
    ambient: process.env,
    existingGenerated: secrets,
  });
  if (options.mode === 'real' && assembled.missing.length > 0) {
    warn('');
    failHead('real 模式缺 env 项', assembled.missing.join(', '));
    warn('  这些键必须来自真实凭据（微信 2 项 + 对象存储 4 项），本工具不生成、不猜测：');
    for (const key of assembled.missing) warn(`   - ${key}`);
    warn('  做法：把这些键写进一个不提交的 env 文件，再 `--env-file <path>` 重跑。模板：');
    for (const line of ENV_FILE_TEMPLATE.trimEnd().split('\n')) warn(`    ${line}`);
    warn(`  SESSION_SIGNING_KEY / DELETION_LEDGER_KEY 可缺省（工具生成并保存在 ${paths.secretsFile}）`);
    return EXIT.USAGE;
  }
  if (assembled.generated.length > 0) {
    persistSecrets(paths, assembled.env);
    say(`  已生成并保存本地签名钥匙：${assembled.generated.join(', ')}（值不打印）`);
  }
  say(`  env 来源：`);
  for (const line of describeEnvSources(assembled.sources)) say(`    ${line}`);

  // ---- ③ PG 版本
  say('');
  say('[4/9] 检查 PostgreSQL');
  if (!existsSync(pgTool(pgBin, 'pg_ctl'))) {
    failHead('找不到 pg_ctl', pgBin);
    warn(`  处理：确认 --pg-bin 指向 PG 17 的 bin 目录（本机默认 ${defaultPgBin()}）`);
    return EXIT.PG;
  }
  const version = pgVersion(pgBin);
  say(`  ${version ? `PostgreSQL ${version}` : '（版本号未识别）'}：${pgBin}`);

  // ---- ④ 数据目录
  say('');
  if (options.reset) {
    say('  --reset：先停栈并删除旧数据目录（随后重建）');
    const stopped = await teardown(context, { keepData: false });
    say(`  API：${stopped.api}`);
    say(`  PG：${stopped.pg}`);
    say(`  数据：${stopped.data}`);
    assembled = assembleApiEnv({
      mode: options.mode,
      apiPort: options.apiPort,
      databaseUrl: buildDatabaseUrl({ port: options.pgPort, database: DATABASE_NAME }),
      envFile: envFile.values,
      ambient: process.env,
      existingGenerated: secrets,
    });
  }
  say('[5/9] 数据目录与 initdb');
  ensureDir(paths.stateDir);
  const freshDataDir = !existsSync(join(paths.dataDir, 'PG_VERSION'));
  if (freshDataDir) {
    say(`  没有簇：initdb → ${paths.dataDir}（trust / locale=C / UTF8）`);
    ensureDir(dirname(paths.dataDir));
    const result = run(pgTool(pgBin, 'initdb'), buildInitdbArgs({ dataDir: paths.dataDir }), { timeoutMs: 180_000 });
    if (result.status !== 0) {
      failWith({ stage: 'pg-init', output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` });
      return EXIT.PG;
    }
    say('  ✓ initdb 完成');
  } else {
    say(`  ✓ 已有簇，复用（不重复 initdb）：${paths.dataDir}`);
  }

  // ---- ⑥ 起簇
  say('');
  say('[6/9] 启动 PG 簇');
  if (pgRunning(pgBin, paths.dataDir)) {
    say(`  ✓ 已在运行（pg_ctl status=0）`);
  } else {
    const ctlLog = join(paths.stateDir, 'pg-ctl.log');
    const result = runPgCtlStart(
      pgBin,
      buildPgStartArgs({ dataDir: paths.dataDir, port: options.pgPort, logFile: paths.pgLog, waitSeconds: 60 }),
      ctlLog,
    );
    if (result.error || result.status !== 0) {
      const pgLog = tailLines(readTextIfExists(paths.pgLog) ?? '', 20);
      const ctlOutput = tailLines(readTextIfExists(ctlLog) ?? '', 15);
      const classified = failWith(
        { stage: 'pg-start', output: `${result.error ? `pg_ctl error: ${result.error.code ?? result.error.message}` : ''}\n${ctlOutput}\n${pgLog}` },
        [
          `  pg_ctl 输出（最后 15 行，${ctlLog}）：`,
          ...(ctlOutput === '' ? ['    （空）'] : ctlOutput.split('\n').map((line) => `    ${line}`)),
          `  PG 日志（最后 20 行，${paths.pgLog}）：`,
          ...pgLog.split('\n').map((line) => `    ${line}`),
        ],
      );
      return classified.code === 'PORT_IN_USE' ? EXIT.PORT : EXIT.PG;
    }
    say(`  ✓ 已启动（日志 ${paths.pgLog}）`);
  }

  // ---- ⑦ 建库 + 迁移
  say('');
  say('[7/9] 建库与迁移');
  const existsQuery = psql(pgBin, buildPsqlArgs({ port: options.pgPort, database: 'postgres', sql: buildDatabaseExistsSql(DATABASE_NAME) }), 30000);
  if (existsQuery.status !== 0) {
    failWith({ stage: 'createdb', output: `${existsQuery.stdout ?? ''}\n${existsQuery.stderr ?? ''}` });
    return EXIT.PG;
  }
  const dbExists = (existsQuery.stdout ?? '').trim() === '1';
  if (dbExists) {
    say(`  ✓ 数据库 ${DATABASE_NAME} 已存在`);
  } else {
    const created = psql(pgBin, buildPsqlArgs({ port: options.pgPort, database: 'postgres', sql: buildCreateDatabaseSql(DATABASE_NAME) }), 30000);
    if (created.status !== 0) {
      failWith({ stage: 'createdb', output: `${created.stdout ?? ''}\n${created.stderr ?? ''}` });
      return EXIT.PG;
    }
    say(`  ✓ 已建库 ${DATABASE_NAME}`);
  }

  const databaseUrl = buildDatabaseUrl({ port: options.pgPort, database: DATABASE_NAME });
  const migrate = run(process.execPath, [MIGRATE_ENTRY, 'up'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeoutMs: 300_000,
  });
  const migrateOutput = `${migrate.stdout ?? ''}\n${migrate.stderr ?? ''}`;
  const applied = /已应用[:：]\s*(.*)/u.exec(migrate.stdout ?? '')?.[1]?.trim();
  if (migrate.status !== 0) {
    failWith({ stage: 'migrate', exitCode: migrate.status, output: migrateOutput }, [
      `  迁移输出（最后 20 行）：`,
      ...tailLines(migrateOutput, 20).split('\n').map((line) => `    ${line}`),
    ]);
    return EXIT.MIGRATE;
  }
  say(`  ✓ 迁移完成${applied && applied !== '（无）' ? `：应用 ${applied.split(',').length} 个` : '（无待应用）'}`);

  // ---- ⑧ 种子
  say('');
  say('[8/9] 种子数据');
  const stateBefore = readState(paths);
  const seedKey = `${options.mode}:${DATABASE_NAME}`;
  const demoSeedKey = `demo:${DATABASE_NAME}`;
  const alreadySeeded = Array.isArray(stateBefore.seeded) && stateBefore.seeded.includes(seedKey);
  const demoAlreadySeeded = Array.isArray(stateBefore.seeded) && stateBefore.seeded.includes(demoSeedKey);
  if (options.mode !== 'real') {
    say('  stub 模式：跳过种子（stub 只是链路自检，不写业务资料）');
  } else {
    if (alreadySeeded && !options.reset) {
      say(`  ✓ 参考数据已导入过（state 记录 ${seedKey}），跳过；要重灌用 \`up --reset\``);
    } else {
      for (const file of SEED_FILES) {
        const name = file.split(/[\\/]/u).pop();
        const result = psql(pgBin, buildPsqlFileArgs({ port: options.pgPort, database: DATABASE_NAME, file }), 180_000);
        if (result.status !== 0) {
          failWith({ stage: 'seed', output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` }, [
            `  失败的种子：${name}`,
            `  输出（最后 15 行）：`,
            ...tailLines(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, 15).split('\n').map((line) => `    ${line}`),
          ]);
          return EXIT.SEED;
        }
        say(`  ✓ ${name}`);
      }
      writeState(paths, { seeded: [...new Set([...(stateBefore.seeded ?? []), seedKey])] });
    }

    // --seed-demo 是**显式**开关：默认不开。不开时首页自然是空列表，
    // 这不是故障；要卡片就得自己带上这个参数（并在报告里写明是演示资料）。
    if (!options.seedDemo) {
      say(
        demoAlreadySeeded
          ? '  · 演示资料：库内已有（本次未带 --seed-demo，不重复灌）'
          : '  · 演示资料：未灌（默认不开）⇒ 首页会返回 200 但列表为空；要卡片请加 --seed-demo',
      );
    } else if (demoAlreadySeeded && !options.reset) {
      say(`  ✓ 演示资料已灌过（state 记录 ${demoSeedKey}），跳过；要重灌用 \`up --reset\``);
    } else {
      const result = psql(pgBin, buildPsqlFileArgs({ port: options.pgPort, database: DATABASE_NAME, file: DEMO_SEED_FILE }), 180_000);
      if (result.status !== 0) {
        failWith({ stage: 'seed', output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` }, [
          '  失败的种子：demo_catalog_verified.sql',
          '  输出（最后 15 行）：',
          ...tailLines(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, 15).split('\n').map((line) => `    ${line}`),
        ]);
        return EXIT.SEED;
      }
      writeState(paths, { seeded: [...new Set([...(readState(paths).seeded ?? []), demoSeedKey])] });
      say('  ✓ 已灌演示资料（非生产数据）：db/seeds/demo_catalog_verified.sql');
      say('    卡片文字取自 db/seeds/seed_reference.sql 的物种参考行；不是生产数据，也不代表第三方审核。');
    }
  }

  // ---- ⑧b 演示档（可选）：迁移完成后再动 feature_flags
  say('');
  if (options.demo) {
    const demoCode = applyDemoProfile({ options, pgBin });
    if (demoCode !== EXIT.OK) return demoCode;
  } else {
    say('演示开关：未开（默认）');
  }

  // ---- ⑨ 起 API
  say('');
  say('[9/9] 启动 API');
  const stalePid = parsePidRecord(readTextIfExists(paths.pidFile) ?? '');
  if (stalePid && !processAlive(stalePid.pid)) {
    rmSync(paths.pidFile, { force: true });
    say(`  清理陈旧 pid 文件（pid ${stalePid.pid} 已退出）`);
  } else if (stalePid && stalePid.port !== options.apiPort) {
    // 端口探测只看新端口，旧端口上的本工具实例可能还活着 —— 不静默并存两个 API。
    warn('');
    failHead('已有一个实例跑在别的端口上', `pid ${stalePid.pid} 在 ${stalePid.port}，这次要求 ${options.apiPort}`);
    warn('  处理：先 `node tools/demo-stack.mjs down`，再按新端口重跑 up');
    return EXIT.USAGE;
  }

  const instanceId = randomUUID();
  const startedAt = new Date().toISOString();
  ensureDir(paths.stateDir);
  writeFileSync(paths.apiLog, '', 'utf8');
  const outFd = openSync(paths.apiLog, 'a');
  let child;
  try {
    child = spawn(process.execPath, [API_ENTRY, `${INSTANCE_FLAG}${instanceId}`], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...assembled.env },
      detached: true,
      windowsHide: true,
      stdio: ['ignore', outFd, outFd],
    });
  } finally {
    closeSync(outFd);
  }
  child.unref();
  const pid = child.pid;
  if (!Number.isInteger(pid)) {
    failHead('spawn 没有返回 pid', '不写假 pid 进文件');
    return EXIT.API;
  }
  writeFileSync(paths.pidFile, `${JSON.stringify(buildPidRecord({ pid, port: options.apiPort, mode: options.mode, instanceId, startedAt, logFile: paths.apiLog }), null, 2)}\n`, 'utf8');
  writeState(paths, { mode: options.mode, apiPort: options.apiPort, pgPort: options.pgPort, lastUpAt: startedAt });
  say(`  已启动：pid ${pid}（日志 ${paths.apiLog}）`);

  // 进程早退要立刻发现，而不是等满超时。
  let exited = null;
  child.once('exit', (code, signal) => {
    exited = { code, signal };
  });

  say(`  等 /health 变 200（上限 ${options.timeoutMs}ms）`);
  const health = await waitForHealth(options.apiPort, options.timeoutMs);
  if (!health.ok) {
    const logTail = tailLines(readTextIfExists(paths.apiLog) ?? '', 30);
    // 首行进「✗ CODE：…」，所以先给一句人能读的现场，再附日志（分类规则仍能扫到日志正文）。
    const headline = exited ? `API 进程退出了（exit=${String(exited.code)}）` : `API 没在 ${options.timeoutMs}ms 内返回 200`;
    const output = `${headline}\nAPI 日志：\n${logTail}`;
    // 处理建议由 failWith 统一打印（它内部先 classifyFailure 再拼提示），这里只补现场。
    failWith(
      { stage: exited ? 'api-start' : 'health', timedOut: !exited, exitCode: exited?.code ?? null, output },
      [
        exited ? `  进程已退出：exit=${String(exited.code)} signal=${String(exited.signal)}` : `  进程仍在跑（pid ${pid}），只是没到 200`,
        `  API 日志（最后 30 行，${paths.apiLog}）：`,
        ...(logTail === '' ? ['    （空）'] : logTail.split('\n').map((line) => `    ${line}`)),
        `  重来：node tools/demo-stack.mjs down && node tools/demo-stack.mjs up --mode ${options.mode}`,
      ],
    );
    return exited ? EXIT.API : EXIT.HEALTH;
  }

  say(`  ✓ /health → ${health.last.reason}（${health.elapsedMs}ms，探测 ${health.attempts} 次）`);
  say('');
  say(`演示栈已就绪：API http://127.0.0.1:${options.apiPort}（${options.mode}），PG 127.0.0.1:${options.pgPort}`);
  for (const line of nextStepsLines({ mode: options.mode, apiPort: options.apiPort, seedDemo: options.seedDemo })) say(line);
  if (options.mode === 'real') {
    say('');
    if (options.seedDemo) {
      say('资料侧说明：本次带 --seed-demo，已灌**演示资料（非生产数据）**；首页卡片文字来自仓库既有物种参考行，');
      say('  不代表任何第三方审核，也不构成识别结论或防治/用药建议。重灌见 `up --reset --seed-demo`。');
    } else {
      say('资料侧说明：库内已核对（verified）来源为 0 条 ⇒ 首页 200 但列表可能为空；这是资料接入缺项，不是栈故障。');
      say('  要本机演示卡片：`node tools/demo-stack.mjs up --mode real --seed-demo`（灌的是演示资料，非生产数据）。');
    }
  }
  return EXIT.OK;
}

async function commandDown(options) {
  const context = contextFromOptions(options);
  options = context.options;
  say(`停演示栈：${context.paths.stateDir}`);
  const stopped = await teardown(context, { keepData: true });
  say(`  API：${stopped.api}`);
  say(`  PG：${stopped.pg}`);
  say('  数据目录保留（下次 up 直接复用；要重来用 reset --yes）');

  const apiPort = await probePort(options.apiPort);
  const pgPort = await probePort(options.pgPort);
  say(`  复核：API 端口 ${options.apiPort} ${apiPort.listening ? `仍被占用（pid ${apiPort.pid ?? '未知'}）` : '已释放'}；PG 端口 ${options.pgPort} ${pgPort.listening ? `仍被占用（pid ${pgPort.pid ?? '未知'}）` : '已释放'}`);
  return apiPort.listening || pgPort.listening ? EXIT.PORT : EXIT.OK;
}

async function commandStatus(options) {
  const context = contextFromOptions(options);
  const { paths, pgBin } = context;
  options = context.options;
  const record = parsePidRecord(readTextIfExists(paths.pidFile) ?? '');
  const alive = record !== null && processAlive(record.pid);
  const commandLine = alive ? commandLineOf(record.pid) : null;
  const owned = alive && commandHasInstance(commandLine, record.instanceId);

  const port = await probePort(options.apiPort);
  const pgUp = pgRunning(pgBin, paths.dataDir);
  const health = await probeHealth(options.apiPort);
  const lines = statusLines({
    api: { running: alive, pid: record?.pid, mode: record?.mode, owned, pidFile: record !== null },
    port,
    health,
  });
  if (options.json) {
    say(
      JSON.stringify(
        {
          api: { running: alive, pid: record?.pid ?? null, owned, mode: record?.mode ?? null },
          port: { port: options.apiPort, listening: port.listening, pid: port.pid, name: port.name },
          pg: { running: pgUp, port: options.pgPort, dataDir: paths.dataDir },
          health: { state: health.state, statusCode: health.statusCode, reason: health.reason, url: health.url },
        },
        null,
        2,
      ),
    );
    return EXIT.OK;
  }
  for (const line of lines) say(line);
  say(`  PG 簇：${pgUp ? '在运行' : '未运行'}（127.0.0.1:${options.pgPort}，数据 ${paths.dataDir}）`);
  say(`  日志：${paths.apiLog}`);
  if (record && !alive) say(`  ！pid 文件还在（pid ${record.pid}），进程已退出；下一次 up 会清理`);
  return EXIT.OK;
}

function commandLogs(options) {
  const context = contextFromOptions(options);
  const { paths } = context;
  const apiText = readTextIfExists(paths.apiLog);
  const pgText = readTextIfExists(paths.pgLog);
  say(`== API 日志（最后 ${options.lines} 行，${paths.apiLog}）==`);
  say(apiText === null ? '  （没有 api.log：API 还没起过）' : tailLines(apiText, options.lines) || '  （空）');
  say('');
  say(`== PG 日志（最后 ${options.lines} 行，${paths.pgLog}）==`);
  say(pgText === null ? '  （没有 pg.log：簇还没起过）' : tailLines(pgText, options.lines) || '  （空）');
  return EXIT.OK;
}

async function commandReset(options) {
  const context = contextFromOptions(options);
  const { paths } = context;
  if (!options.yes) {
    failHead('reset 会删除整个状态目录', paths.stateDir);
    warn('  包括数据目录（本机演示数据会全部丢失）、日志、pid 文件。');
    warn('  确认要重来就加 --yes：node tools/demo-stack.mjs reset --yes');
    return EXIT.USAGE;
  }
  say(`reset：停栈并删除 ${paths.stateDir}`);
  const stopped = await teardown(context, { keepData: false });
  say(`  API：${stopped.api}`);
  say(`  PG：${stopped.pg}`);
  say(`  ${stopped.data}`);
  say('  下次 up 会重新 initdb。');
  return EXIT.OK;
}

// ---------------------------------------------------------------- 入口

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      warn(`✗ ${error.message}`);
      warn(`  用法见 \`node tools/demo-stack.mjs --help\``);
      return EXIT.USAGE;
    }
    throw error;
  }

  if (options.help) {
    say(usage());
    return EXIT.OK;
  }

  switch (options.command) {
    case 'up':
      return commandUp(options);
    case 'down':
      return commandDown(options);
    case 'status':
      return commandStatus(options);
    case 'logs':
      return commandLogs(options);
    case 'reset':
      return commandReset(options);
    default:
      warn(`✗ 未知子命令 ${options.command}`);
      return EXIT.USAGE;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = typeof code === 'number' ? code : EXIT.OK;
  })
  .catch((error) => {
    warn(`✗ 未预期的错误：${error?.stack ?? error}`);
    process.exitCode = EXIT.USAGE;
  });
