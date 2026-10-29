#!/usr/bin/env node
/**
 * G 片（GY-R68-G）· 演练**执行器**：按 `tools/lib/g-drill-readings.mjs` 的 `DRILL_PLAN` 逐条真跑，
 * 每条命令的 `stdout`/`stderr` **落盘**到 `$env:TEMP\gy-g-drill\<sha>\<id>.log`，最后产出
 * `readings.json`（含 `sha/host/node/pg/python/startedAt/durationMs/exit` 与每条命令的读数）。
 *
 * ⛔ 日志**不入库**：它们带本机路径与用户名、量级是 MB；证据页只留读数与命令。
 * ⛔ 本文件**不判定**文档对不对（那是 `tools/verify-g-drill-readings.mjs` 的事）：它只如实采集。
 *
 * 用法：
 *   node tools/collect-g-drill.mjs                     # 全跑，读数写到 <logDir>/readings.json
 *   node tools/collect-g-drill.mjs --list              # 只列计划，不跑
 *   node tools/collect-g-drill.mjs --only=unit,lint    # 只跑几条（id 见 --list）
 *   node tools/collect-g-drill.mjs --out=<path>        # 换 readings.json 的位置
 *   node tools/collect-g-drill.mjs --timeout=<ms>      # 单条超时（默认 30 分钟）
 *
 * 退出码：0 = 每条命令都 exit 0；1 = 至少一条非 0（读数照样写盘——失败本身就是要记录的读数）。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DRILL_PLAN,
  GDrillError,
  renderReadout,
  summarizeLog,
} from './lib/g-drill-readings.mjs';

/** 仓库根：由脚本位置推出（`tools/` → `..`），⛔ 不用 `process.cwd()`。 */
export const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 单条命令的默认超时：`gate` / `pg` 类 30 分钟。 */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * `tap` 类（`node --test` 系）的默认超时：**15 分钟**。
 * 依据：本机实测这 3 条 tap 命令各 2–3 分钟（`unit` 一次 152.5 s、另两条 ~2 s / ~11 s）；
 * 15 分钟已是「正常值的 6 倍以上」，再宽只会让挂死白等半小时（30 分钟那条曾整轮卡住）。
 */
export const TAP_TIMEOUT_MS = 15 * 60 * 1000;

/** 按命令类别取默认超时；`--timeout` 显式给了就以它为准（不按类别打折）。 */
export function defaultTimeoutFor(entry) {
  return entry !== null && entry !== undefined && entry.kind === 'tap' ? TAP_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

const USAGE = [
  '用法：node tools/collect-g-drill.mjs [--only=id1,id2] [--list] [--out=<path>] [--timeout=<ms>] [--root <目录>]',
  '',
  '  （无参数）   按演练计划全跑，读数写到 <logDir>/readings.json',
  '  --list       只列计划，不跑',
  '  --only=…     只跑指定的几条（id 见 `--list`）',
  '  --out=<path>  readings.json 的输出位置（默认 <logDir>/readings.json）',
  '  --timeout=ms 单条命令超时（默认按类别：`gate` / `pg` 30 分钟、`node --test` 类 15 分钟）',
  '  --root <目录> 演练的树（默认本脚本所在的仓库根）',
  '',
  '日志落在 `$env:TEMP\\gy-g-drill\\<sha>\\<id>.log`，**不入库**。',
].join('\n');

/** 解析参数；未知参数直接抛错（不静默忽略）。 */
export function parseArgs(argv) {
  // `timeoutMs = null`：没给 `--timeout` ⇒ 按命令类别取默认（`defaultTimeoutFor`）。
  const options = { only: null, list: false, out: null, timeoutMs: null, root: TOOL_ROOT, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') options.list = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--only') {
      const value = argv[i + 1];
      if (!value) throw new GDrillError('--only 需要一个逗号分隔的 id 列表');
      options.only = value.split(',').map((item) => item.trim()).filter(Boolean);
      i += 1;
    } else if (arg.startsWith('--only=')) {
      options.only = arg.slice('--only='.length).split(',').map((item) => item.trim()).filter(Boolean);
    } else if (arg === '--out') {
      const value = argv[i + 1];
      if (!value) throw new GDrillError('--out 需要一个文件路径');
      options.out = resolve(value);
      i += 1;
    } else if (arg.startsWith('--out=')) {
      options.out = resolve(arg.slice('--out='.length));
    } else if (arg === '--timeout') {
      const value = argv[i + 1];
      if (!value) throw new GDrillError('--timeout 需要一个毫秒数');
      options.timeoutMs = Number(value);
      i += 1;
    } else if (arg.startsWith('--timeout=')) {
      options.timeoutMs = Number(arg.slice('--timeout='.length));
    } else if (arg === '--root') {
      const value = argv[i + 1];
      if (!value) throw new GDrillError('--root 需要一个目录参数');
      options.root = resolve(value);
      i += 1;
    } else if (arg.startsWith('--root=')) {
      options.root = resolve(arg.slice('--root='.length));
    } else {
      throw new GDrillError(`未知参数：${arg}`);
    }
  }
  if (options.timeoutMs !== null && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new GDrillError('--timeout 必须是正数（毫秒）');
  }
  return options;
}

/** 读一条 `git` 输出（失败返回空串：夹具树不是 git 仓库是合法情况）。 */
function gitOutput(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return '';
  return String(result.stdout ?? '').trim();
}

/** 提交 SHA（40 位 hex；读不到就写 `unknown`，CLI 会因形状不合法而红——那是如实的）。 */
export function readSha(root) {
  const sha = gitOutput(root, ['rev-parse', 'HEAD']);
  return /^[0-9a-f]{40}$/.test(sha) ? sha : 'unknown';
}

/**
 * 采集时工作区是否干净：**这一列 sha 只代表检出提交**，工作区脏就意味着被测代码可能不在该提交里
 * （本片 r2 复审抓到的就是这件事：`1f056b8b` 里并没有那 5 个文件，采集却在它上面跑完）。
 * 这里只如实记录、并让 CLI 把话喊出来；要不要把它变成硬闸门，是另一个决定。
 */
export function readDirty(root) {
  const porcelain = gitOutput(root, ['status', '--porcelain']);
  const paths = porcelain === '' ? [] : porcelain.split(/\r?\n/).filter((line) => line.trim() !== '');
  return { dirty: paths.length > 0, paths: paths.length };
}

/**
 * 本机工具链读数（`node` / `pg` / `python`）：只跑各自 `--version`，读不到就写 `未安装`——**不猜**。
 */
export function readToolchain(env = process.env) {
  const probe = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8', env, windowsHide: true });
    if (result.status !== 0 || typeof result.stdout !== 'string') return '未安装';
    const text = result.stdout.trim().split(/\r?\n/)[0];
    return text === '' ? '未安装' : text;
  };
  const pgBin = env.GY_PG_BIN ?? '';
  const pg = pgBin === '' ? '未安装' : probe(join(pgBin, 'psql'), ['--version']);
  // `node` 必须是 **node 自己的版本**：`node:os` 的 `version()` 给的是操作系统版本号（这里曾误写，已改）。
  return { node: process.version, python: probe('python', ['--version']), pg, pgBin };
}

/**
 * 演练用的环境：`GY_PG_BIN` 前置进 `PATH`（`psql`），`C:\msys64\usr\bin` 前置（`awk`）。
 * ⛔ 不改宿主环境，只给子进程一份拷贝。
 */
export function drillEnv(base = process.env) {
  const env = { ...base };
  const pgBin = env.GY_PG_BIN ?? '';
  if (pgBin === '') return env;
  // ⛔ Windows 上 `process.env` 的键通常叫 `Path`（不是 `PATH`）：另建一个 `PATH` 会让
  // 环境块里出现两条同名变量，子进程挑中「只有 psql/awk」的那条 ⇒ `'node' is not recognized`。
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  env[key] = `${pgBin};C:\\msys64\\usr\\bin;${env[key] ?? ''}`;
  return env;
}

/**
 * 自起集群那两条真库臂（`retention-purge-pg` / `admin-audit-logs-pg`）的**数据根目录**。
 *
 * ⛔ 不能落在 `%TEMP%` 下：本机实测 `initdb` 在 `$env:TEMP\...` 下建目录会
 * `initdb: error: could not create directory ... Permission denied`（同一套二进制在
 * `E:\GengYunCommander\.pg17\` 下正常）。所以默认放到 `GY_PG_BIN` 旁边的 `drill-pgroot`
 * （`...\.pg17\drill-pgroot`，在仓外、不入库），可用 `GY_DRILL_PG_ROOT` 覆盖。
 */
export function pgDrillRoot(env = process.env) {
  const explicit = (env.GY_DRILL_PG_ROOT ?? '').trim();
  if (explicit !== '') return explicit;
  const pgBin = (env.GY_PG_BIN ?? '').trim();
  if (pgBin === '') return '';
  return join(pgBin, '..', '..', 'drill-pgroot');
}

/** 一条命令 → `{ id, command, exit, durationMs, log, summary, readout }`（`stdout`+`stderr` 合并进同一文件）。 */
export function runOne({ root, entry, logDir, timeoutMs, env }) {
  const logPath = join(logDir, `${entry.id}.log`);
  const command = String(entry.command).replace(/\{logDir\}/g, logDir);
  const fd = openSync(logPath, 'w');
  const startedAt = Date.now();
  let result;
  try {
    // ⛔ 显式传空 `args` 数组：只传 options 对象时，新版 Node 会把对象当成 `args`
    // （`DEP0190`）后拼成一条走不通的命令行——实测症状是 `'npm' is not recognized`。
    result = spawnSync(command, [], {
      cwd: root,
      shell: true,
      env,
      stdio: ['ignore', fd, fd],
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
      windowsHide: true,
    });
  } finally {
    closeSync(fd);
  }
  const durationMs = Date.now() - startedAt;
  let text = '';
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    text = '';
  }
  const summary = summarizeLog(text);
  const exit = typeof result.status === 'number' ? result.status : 124;
  return {
    id: entry.id,
    command: entry.command,
    exit,
    durationMs,
    log: logPath,
    summary,
    readout: renderReadout(entry.kind, summary, durationMs),
  };
}

/**
 * 按计划（或 `only` 子集）跑一遍，返回 readings 对象。`main` 与 `--live` 共用这一段。
 */
export function runDrillPlan({ root, only = null, timeoutMs = null, log = () => {}, baseEnv = process.env } = {}) {
  const entries = only === null ? [...DRILL_PLAN] : DRILL_PLAN.filter((entry) => only.includes(entry.id));
  if (entries.length === 0) throw new GDrillError(`--only 里没有任何已知的 id（已知：${DRILL_PLAN.map((item) => item.id).join(' / ')}）`);
  const sha = readSha(root);
  const dirty = readDirty(root);
  if (dirty.dirty) {
    log(`  ⚠ 工作区不干净（git status --porcelain ${dirty.paths} 条）：这次读数的 sha 只代表检出提交 ${sha.slice(0, 8)}，`
      + '不代表代码就在该提交里 ⇒ 请把改动提交后再采集，或把这条如实写进证据页');
  }
  const logDir = join(tmpdir(), 'gy-g-drill', sha);
  mkdirSync(logDir, { recursive: true });
  const env = drillEnv(baseEnv);
  // `{pgRoot}` 占位符：自起集群的真库臂需要一个**不在 `%TEMP%` 下**的数据根（见 `pgDrillRoot`）。
  const pgRoot = pgDrillRoot(baseEnv);
  if (pgRoot !== '') mkdirSync(pgRoot, { recursive: true });
  const startedAt = new Date();
  const commands = [];
  for (const entry of entries) {
    // 超时按类别取默认（tap 15 分钟、其余 30 分钟）；`--timeout` 显式给了就一律用它。
    const entryTimeout = timeoutMs ?? defaultTimeoutFor(entry);
    log(`▶ ${entry.id} … ${entry.command}`);
    // 每条命令可以在计划里钉自己的环境（真库臂的 `DATABASE_TEST_URL` 就是这么来的）。
    const entryEnv = Object.fromEntries(
      Object.entries(entry.env ?? {}).map(([key2, value]) => [key2, String(value).replace(/\{pgRoot\}/g, pgRoot)]),
    );
    const result = runOne({ root, entry, logDir, timeoutMs: entryTimeout, env: { ...env, ...entryEnv } });
    commands.push(result);
    log(`  ← exit ${result.exit}（${result.durationMs}ms）${result.readout}`);
    if (result.exit === 124) {
      log(`  ⏱ ${entry.id}：${Math.round(entryTimeout / 60000)} 分钟未结束 ⇒ 疑似挂死（不是断言失败）：`
        + '先 `Get-Process node` 清掉残留进程，再用 `node --test <该文件>` 单独复核那条命令');
    }
  }
  const toolchain = readToolchain(baseEnv);
  const failed = commands.filter((item) => item.exit !== 0).map((item) => item.id);
  return {
    schemaVersion: '1.0.0',
    sha,
    // 采集时工作区干不干净：`sha` 列只说明「检出的是哪个提交」，见 `readDirty`。
    dirty: dirty.dirty,
    dirtyPaths: dirty.paths,
    host: hostname(),
    node: toolchain.node,
    python: toolchain.python,
    pg: toolchain.pg,
    pgBin: toolchain.pgBin,
    platform: `${process.platform} ${release()}`,
    logDir,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    commands,
    summary: { total: commands.length, ok: commands.length - failed.length, failed },
  };
}

/** CLI 主流程。返回退出码（单测可直接调用，不必 spawn）。 */
export function main(argv = process.argv.slice(2), { log = console.log, error = console.error, baseEnv = process.env } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (failure) {
    error(String(failure.message ?? failure));
    error(USAGE);
    return 1;
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }
  if (options.list) {
    for (const entry of DRILL_PLAN) log(`${entry.id}\t${entry.group}\t${entry.command}`);
    return 0;
  }
  let readings;
  try {
    readings = runDrillPlan({ root: options.root, only: options.only, timeoutMs: options.timeoutMs, log, baseEnv });
  } catch (failure) {
    error(String(failure.message ?? failure));
    return 1;
  }
  const out = options.out ?? join(readings.logDir, 'readings.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(readings, null, 2)}\n`, 'utf8');
  log('');
  log(`读数：${out}`);
  log(`日志：${readings.logDir}（不入库）`);
  log(`汇总：${readings.summary.ok}/${readings.summary.total} 条 exit 0${readings.summary.failed.length === 0 ? '' : `；失败：${readings.summary.failed.join(' / ')}`}`);
  return readings.summary.failed.length === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exitCode = main();
}
