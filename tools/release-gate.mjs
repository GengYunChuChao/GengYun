#!/usr/bin/env node
/**
 * 发布门禁汇总（release gate）—— 一条命令跑完发版前必过的几项门禁，并给出**机器可读**汇总。
 *
 * 运行：`node tools/release-gate.mjs`（退出码 0 = 全过；1 = 有失败项；2 = 用法错误）。
 *
 * ## 输出契约（谁读谁依赖）
 * - **stdout 只有 JSON**（单个对象，`JSON.stringify(report, null, 2)` ＋ 换行）：给 CI / 脚本解析。
 * - **人读摘要只走 stderr**：`[PASS]/[FAIL]/[SKIP] <id> <毫秒>ms` 加一行判定；这样
 *   `node tools/release-gate.mjs | jq .verdict` 不会被摘要污染。
 * - `--out <path>` 把**同一份** JSON 落盘（默认 `release-gate-report.json`，已进 `.gitignore`）。
 *
 * ## 门禁项（`--only` / `--skip` 用下面的 id 选择）
 * | id | 含义 | 默认 |
 * | --- | --- | --- |
 * | `typecheck` | 工作区递归类型检查 | 跑 |
 * | `unit` | 单元测试（根 `test:unit` 优先，其次工作区递归） | 跑 |
 * | `contract` | 契约测试 `test:contract` ＋（存在时）`tools/verify-contract-status.mjs` | 跑 |
 * | `secrets` | 待发布 diff 新增行的私密信息扫描（`sk-`／`SecretKey`／`BEGIN PRIVATE KEY`／本机绝对路径） | 跑 |
 * | `artifacts` | 待发布 diff 新增文件的大文件与二进制检查 | 跑 |
 * | `pg` | 真库臂（`test:integration:*-pg`） | **跳过并标注理由**，`--pg` 才跑 |
 *
 * ## 包管理器：本仓是 **npm workspaces**，不是 pnpm
 * 仓库里没有 `pnpm-lock.yaml`，根 `package.json` 用的是 `workspaces` 数组，靠
 * `npm run <script> --workspaces` 递归；pnpm 对 `workspaces` 字段不识别（需 `pnpm-workspace.yaml`），
 * 这一点仓库自己的证据页已实测记录（`docs/verification/gy-i19-backup-domain-20261018.md`
 * 「`ERR_PNPM_NO_LOCKFILE`」段）。所以本工具**默认自动判定**：存在 `pnpm-workspace.yaml` 或
 * `pnpm-lock.yaml` ⇒ 用 pnpm 递归；否则用 npm workspaces。判定结果写进报告 `packageManager`，
 * 每条门禁的**实际命令行**也写进 `command` 字段，不靠猜。
 *
 * ## 为什么「真库臂」默认跳过
 * 真库臂要本机 PostgreSQL 17 ＋ 连接参数 ＋ 预置 fixture，属**环境依赖**而非仓库事实；
 * 默认跑它会让「没装库的机器」把发布门禁跑红，掩盖真正的代码失败。⇒ 默认 `skipped` 且
 * `skipReason` 写明打开方式（`--pg`），报告里 `counts.skipped` 可见，⛔ 不伪装成通过。
 *
 * ## 扫描面：「待发布 diff」＝ `git diff <base>...HEAD` 的**新增行**
 * 只扫新增行（`+`），因为删除行不可能泄漏；`--base` 默认按
 * `upstream/main` → `origin/main` → `main` → `HEAD` 顺序解析（写进 `base`）。
 * 扫描结果**只给掩码**：命中片段按 `前 4 字符 + …[redacted]` 输出，⛔ 不把密钥原文写进
 * stdout／报告／终端。
 *
 * ## 本工具**不**代表什么
 * 不部署、不连云、不连库（除 `--pg` 且你给的连接）、不做验收结论；门禁绿只说明这几条命令通过。
 */
import { spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_OUT = 'release-gate-report.json';
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ERROR_LINES = 3;
const MAX_LINE_CHARS = 400;
const MAX_CAPTURED_BYTES = 32 * 1024 * 1024;
const SCHEMA_VERSION = 1;

/** 门禁 id 的**全集与顺序**（报告里按此顺序输出，`--only` 也按此顺序）。 */
const GATE_IDS = ['typecheck', 'unit', 'contract', 'secrets', 'artifacts', 'pg'];

/** `--help` 文本。走 stderr，保持 stdout 只有 JSON。 */
const USAGE = `发布门禁汇总（release gate）

用法：
  node tools/release-gate.mjs [选项]

选项：
  --only <id,id>        只跑这些门禁（逗号分隔；未知 id ⇒ 退出码 2）
  --skip <id,id>        跳过这些门禁
  --base <ref>          待发布 diff 的基线（默认按 upstream/main → origin/main → main → HEAD 解析）
  --out <path>          JSON 报告落盘路径（默认 ${DEFAULT_OUT}）
  --root <dir>          仓库根（默认本脚本上一级目录）
  --max-file-bytes <n>  大文件阈值（默认 ${DEFAULT_MAX_FILE_BYTES} 字节）
  --timeout-ms <n>      单条命令超时（默认 0 = 不限）
  --binary-allow <.ext,.ext>  允许进入仓库的二进制扩展名（默认空 = 一律算失败）
  --plan <path>         用 JSON 计划覆盖门禁定义（自动化测试／注入用）
  --pg                  启用真库臂（默认跳过并标注）
  --list                列出全部门禁 id 后退出（stdout 输出 JSON 数组）
  -h, --help            显示本帮助

门禁 id：${GATE_IDS.join(' / ')}

退出码：0 = 全过（跳过项不算失败）；1 = 有失败项；2 = 用法错误。
`;

/** 用法错误：一律退出码 2（与「门禁失败」区分开，CI 才能区别对待）。 */
class UsageError extends Error {}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

/**
 * 解析 argv。
 * 支持 `--opt value` 与 `--opt=value` 两种写法；`-h/--help`、`--list`、`--pg` 为布尔开关。
 */
function parseArgs(argv) {
  const opts = {
    only: null,
    skip: null,
    base: null,
    out: DEFAULT_OUT,
    root: DEFAULT_ROOT,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    timeoutMs: 0,
    binaryAllow: [],
    plan: null,
    pg: false,
    list: false,
    help: false,
  };
  const valueOpts = new Set([
    'only', 'skip', 'base', 'out', 'root', 'max-file-bytes', 'timeout-ms', 'binary-allow', 'plan',
  ]);
  const flagOpts = new Set(['pg', 'list', 'help', 'h']);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('-')) throw new UsageError(`无法识别的参数：${token}`);
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.replace(/^--?/, '') : token.slice(token.startsWith('--') ? 2 : 1, eq);
    const inlineValue = eq === -1 ? null : token.slice(eq + 1);

    if (flagOpts.has(name)) {
      if (inlineValue !== null) throw new UsageError(`开关 ${token.slice(0, eq)} 不接受取值`);
      if (name === 'h' || name === 'help') opts.help = true;
      else if (name === 'pg') opts.pg = true;
      else if (name === 'list') opts.list = true;
      continue;
    }
    if (!valueOpts.has(name)) throw new UsageError(`未知选项：${token}`);

    let value = inlineValue;
    if (value === null) {
      i += 1;
      if (i >= argv.length) throw new UsageError(`选项 ${token} 缺少取值`);
      value = argv[i];
    }
    if (value === '') throw new UsageError(`选项 ${token} 的取值为空`);

    switch (name) {
      case 'only': opts.only = splitIds(value, '--only'); break;
      case 'skip': opts.skip = splitIds(value, '--skip'); break;
      case 'base': opts.base = value; break;
      case 'out': opts.out = value; break;
      case 'root': opts.root = resolve(value); break;
      case 'max-file-bytes': opts.maxFileBytes = parsePositiveInt(value, '--max-file-bytes'); break;
      case 'timeout-ms': opts.timeoutMs = parseNonNegativeInt(value, '--timeout-ms'); break;
      case 'binary-allow': opts.binaryAllow = splitIds(value, '--binary-allow').map((e) => normalizeExt(e)); break;
      case 'plan': opts.plan = resolve(value); break;
      default: throw new UsageError(`未知选项：${token}`);
    }
  }

  // `--only` 与 `--skip` 同时点名同一项 ⇒ 语义冲突，按用法错误处理（不静默择一）。
  if (opts.only && opts.skip) {
    const both = opts.only.filter((id) => opts.skip.includes(id));
    if (both.length > 0) throw new UsageError(`同一门禁不能既 --only 又 --skip：${both.join(', ')}`);
  }
  // id 合法性**留到选择阶段**再判：`--plan` 会替换门禁集合，此时校验必须对着计划里的 id，
  // 而不是对着内置 GATE_IDS（否则注入式测试永远无法用 --only 选自己的门禁）。
  return opts;
}

function splitIds(value, flag) {
  const ids = value.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) throw new UsageError(`${flag} 需要一个或多个 id`);
  return ids;
}

function parsePositiveInt(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${flag} 需要正整数，收到：${value}`);
  return n;
}

function parseNonNegativeInt(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`${flag} 需要非负整数，收到：${value}`);
  return n;
}

function normalizeExt(ext) {
  const trimmed = ext.trim().toLowerCase();
  if (!trimmed) throw new UsageError('--binary-allow 里有空扩展名');
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

// ---------------------------------------------------------------------------
// 仓库事实读取
// ---------------------------------------------------------------------------

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 读根 `package.json`；读不到就让调用方决定（不抛，便于给出可读的 skipped 理由）。 */
function readRootManifest(root) {
  const path = join(root, 'package.json');
  if (!existsSync(path)) return null;
  try {
    return readJsonFile(path);
  } catch (error) {
    throw new UsageError(`根 package.json 不是合法 JSON：${error.message}`);
  }
}

/** 展开 `workspaces` 字段（数组或 `{ packages: [] }`），支持末段 `*` 通配。 */
function listWorkspaceDirs(root, manifest) {
  const raw = manifest?.workspaces;
  const patterns = Array.isArray(raw) ? raw : Array.isArray(raw?.packages) ? raw.packages : [];
  const dirs = [];
  for (const pattern of patterns) {
    if (pattern.includes('*')) {
      const prefix = pattern.slice(0, pattern.lastIndexOf('/'));
      const base = join(root, prefix);
      if (!existsSync(base)) continue;
      for (const entry of readFileSyncDirectoryNames(base)) dirs.push(join(prefix, entry));
      continue;
    }
    dirs.push(pattern);
  }
  return dirs.filter((dir) => existsSync(join(root, dir, 'package.json')));
}

/** 列某个目录下的**子目录名**（工作区通配展开用；只读，失败返回空数组）。 */
function readFileSyncDirectoryNames(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** 判定包管理器：有 pnpm 工作区/锁文件 ⇒ pnpm，否则 npm（本仓即 npm workspaces）。 */
function detectPackageManager(root) {
  if (existsSync(join(root, 'pnpm-workspace.yaml')) || existsSync(join(root, 'pnpm-lock.yaml'))) {
    return { id: 'pnpm', reason: '发现 pnpm-workspace.yaml 或 pnpm-lock.yaml' };
  }
  if (existsSync(join(root, 'package-lock.json'))) {
    return { id: 'npm', reason: '发现 package-lock.json 且无 pnpm 工作区/锁文件（npm workspaces）' };
  }
  return { id: 'npm', reason: '没有 pnpm 工作区/锁文件，默认按 npm workspaces 处理' };
}

/** `npm run <script>` / `pnpm run <script>`，递归与否按调用方给的命令模板决定。 */
function pmRun(pm, script, { recursive = false } = {}) {
  if (pm === 'pnpm') {
    return recursive
      ? { command: 'pnpm', args: ['-r', '--if-present', 'run', script] }
      : { command: 'pnpm', args: ['run', script] };
  }
  return recursive
    ? { command: 'npm', args: ['run', script, '--workspaces', '--if-present'] }
    : { command: 'npm', args: ['run', script] };
}

/** 某脚本是否至少被一个工作区定义（决定「递归」是否有意义，避免跑出空门禁而假绿）。 */
function workspaceHasScript(root, dirs, script) {
  for (const dir of dirs) {
    try {
      const manifest = readJsonFile(join(root, dir, 'package.json'));
      if (manifest?.scripts?.[script]) return true;
    } catch {
      // 单个工作区 package.json 坏掉时不影响判定，交给真实门禁去红。
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 子进程
// ---------------------------------------------------------------------------

/** 引号化单个 argv，供 `shell: true` 拼行（Windows 下 npm/pnpm 是 .cmd，必须过 shell）。 */
function quoteArg(arg) {
  const text = String(arg);
  if (text !== '' && /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

/** 把 `{command,args}` 拼成一行命令，并把 `node` 解析成本进程的 node（不依赖 PATH）。 */
function commandLine(step) {
  const command = step.command === 'node' ? process.execPath : step.command;
  return [command, ...step.args].map(quoteArg).join(' ');
}

/**
 * 跑一条外部命令。
 * 只保留**错误行**进报告（完整 stdout/stderr 可能数万行），并记录字节数便于排查。
 */
function runCommand(ctx, step) {
  const line = commandLine(step);
  const started = Date.now();
  const result = spawnSync(line, {
    shell: true,
    cwd: ctx.root,
    encoding: 'utf8',
    timeout: ctx.opts.timeoutMs > 0 ? ctx.opts.timeoutMs : undefined,
    maxBuffer: MAX_CAPTURED_BYTES,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const durationMs = Date.now() - started;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  let exitCode = result.status;
  let errorLines = [];
  if (result.error?.code === 'ETIMEDOUT') {
    exitCode = null;
    errorLines = [`命令超时（--timeout-ms=${ctx.opts.timeoutMs}）：${line}`];
  } else if (exitCode === null) {
    errorLines = [`命令无法执行（${result.error?.code ?? 'unknown'}）：${line}`];
  }
  return {
    line,
    durationMs,
    exitCode,
    status: exitCode === 0 ? 'passed' : 'failed',
    errorLines: exitCode === 0
      ? []
      : errorLines.length > 0
        ? errorLines
        : extractErrorLines(`${stdout}\n${stderr}`),
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
  };
}

/** 去掉 ANSI 颜色（本机 Windows 终端/CI 混用）。 */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex -- 目的就是匹配 ESC 序列
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * 从输出里挑「首条关键错误行」+ 紧随其后至多 2 行上下文（合计 ≤ 3 行）。
 *
 * 分三档，逐档放宽（**不做语义猜测**，只保证可读且不刷屏）：
 *   1. 强失败信号（`not ok`/`FAIL`/`Error:`/`error TS…`/`✖` …）——最像「红的那一条」；
 *   2. 弱信号（出现 error/失败 字样）；
 *   3. 都没有：取末尾 3 行（静默失败时致命信息通常在尾部，取开头只会捞到进度噪音）。
 * 前两档都**跳过通过行**（`✔`/`ok`/`PASS` 开头）——测试名里常带 error 字样，
 * 选到一条「通过」的行就等于把真正的失败藏到后面去了（本脚本自己在真跑时踩过）。
 */
function extractErrorLines(output) {
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim() !== '');
  if (lines.length === 0) return ['（命令失败但没有输出）'];

  const strong = /(^|\s)(not ok|FAIL\b|FAILED|ERR_[A-Z]+|Error:|error TS\d+|✖|AssertionError|失败[:：])/;
  const weak = /(^|\s)(error|Error|ERROR|失败|错误|TypeError)/;
  const passing = /^\s*(✔|ok\b|PASS\b)/;
  const pick = (pattern) => lines.findIndex((line) => !passing.test(line) && pattern.test(line));

  const hit = [pick(strong), pick(weak)].find((index) => index !== -1);
  const start = hit === undefined ? Math.max(0, lines.length - MAX_ERROR_LINES) : hit;
  return lines.slice(start, start + MAX_ERROR_LINES).map((line) => redactForOutput(truncate(line, MAX_LINE_CHARS)));
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// 私密信息扫描规则
// ---------------------------------------------------------------------------

/**
 * 规则表。`severity: high` 的命中片段**必须掩码**（密钥/私钥原文永不外泄）；
 * `medium` 是本机绝对路径（本身不是密钥，但要拦在仓库外，故原样展示便于修）。
 *
 * ⚠️ 规则 id 自身不能写成会被本表命中的形状：本脚本也在「待发布 diff」里，
 * 真跑时 id `sk` 后面接一长串连字符词会被自己的第一条规则命中（自指假阳性，踩过一次）。
 * 因此第一条规则的 id 用「代号」而不是前缀直写；描述写在 `label` 里。
 */
const SCAN_RULES = [
  {
    id: 'openai-style-key',
    severity: 'high',
    label: '疑似 sk- 前缀 API Key',
    regex: /\bsk-[A-Za-z0-9_-]{8,}/g,
  },
  {
    id: 'secret-key-assignment',
    severity: 'high',
    label: 'SecretKey 赋值（疑似云厂商私钥）',
    regex: /\bsecret[_-]?key\b"?\s*[:=]\s*"?[A-Za-z0-9/+=_-]{8,}/gi,
  },
  {
    id: 'private-key-block',
    severity: 'high',
    label: '内嵌私钥块（BEGIN ... PRIVATE KEY）',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    id: 'local-absolute-path',
    severity: 'medium',
    label: '本机绝对路径（E:\\ / C:\\ 等，不应进仓库）',
    regex: /(?:^|[\s"'`(=,[])([A-Za-z]:\\[^\s"'`)\],;]*)/g,
    mask: false,
    offsetGroup: 1,
  },
];

/** 掩码：留前 4 个字符便于定位，其余替换（长度也隐藏掉一部分，避免被反推）。 */
function maskToken(token) {
  const head = token.slice(0, 4);
  return `${head}…[redacted]`;
}

/**
 * 输出前的兜底脱敏：错误行里也可能出现 `sk-…` 或私钥头（例如失败时把配置打印出来）。
 * 这是「无论哪条门禁失败都不外泄」的最后一道闸。
 */
function redactForOutput(text) {
  let output = text;
  for (const rule of SCAN_RULES) {
    if (rule.severity !== 'high') continue;
    output = output.replace(new RegExp(rule.regex.source, rule.regex.flags), (match) => maskToken(match));
  }
  return output;
}

// ---------------------------------------------------------------------------
// git 侧事实
// ---------------------------------------------------------------------------

/** 跑一条只读 git 命令，返回 `{ok, stdout, stderr}`（不抛，便于把失败写成门禁失败）。 */
function git(root, args) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', '-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: MAX_CAPTURED_BYTES,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

/** 解析基线：显式 `--base` 优先；否则按 upstream/main → origin/main → main → HEAD 逐个试。 */
function resolveBase(root, requested) {
  const candidates = requested ? [requested] : ['upstream/main', 'origin/main', 'main', 'HEAD'];
  for (const ref of candidates) {
    const probe = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (probe.ok) return { ref, sha: probe.stdout.trim(), attempts: candidates };
  }
  return { ref: requested ?? candidates[0], sha: null, attempts: candidates };
}

/**
 * 取「待发布 diff」的新增行：`git diff <base>...HEAD`（三点＝相对共同祖先）。
 * 只认 `+` 行；hunk 头给出的新文件行号用来对齐 `file:line`。
 */
function collectAddedLines(root, base) {
  const diff = git(root, ['diff', '--unified=0', '--no-color', '--diff-filter=AM', `${base}...HEAD`]);
  if (!diff.ok) return { ok: false, error: diff.stderr, lines: [] };

  const lines = [];
  let file = null;
  let newLine = 0;
  for (const raw of diff.stdout.split(/\r?\n/)) {
    if (raw.startsWith('+++ b/')) {
      file = raw.slice('+++ b/'.length);
      continue;
    }
    if (raw.startsWith('+++ /dev/null')) {
      file = null;
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('diff --git ') || raw.startsWith('index ')) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('+')) {
      if (file !== null) lines.push({ file, line: newLine, text: raw.slice(1) });
      newLine += 1;
      continue;
    }
    if (raw.startsWith('-')) continue;
    if (raw.startsWith('\\')) continue;
    // `--unified=0` 下不应有上下文行；出现了就按新文件行号顺延，保持行号不漂移。
    if (file !== null && raw !== '') newLine += 1;
  }
  return { ok: true, error: null, lines };
}

/** 待发布 diff 里新增/修改的文件清单（供大文件与二进制检查）。 */
function collectChangedFiles(root, base) {
  const listing = git(root, ['diff', '--name-only', '--diff-filter=AM', `${base}...HEAD`]);
  if (!listing.ok) return { ok: false, error: listing.stderr, files: [] };
  return {
    ok: true,
    error: null,
    files: listing.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
  };
}

/** 读文件前 8 KiB 判二进制：出现 NUL 字节即视为二进制（与 git 的启发式同源）。 */
function looksBinary(path) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    for (let i = 0; i < read; i += 1) {
      if (buffer[i] === 0) return true;
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// 门禁定义
// ---------------------------------------------------------------------------

/**
 * 构造门禁列表。每项：`{id,title,kind,steps?}`。
 * `kind: 'command'` 逐条跑命令（首条失败即停，因为后续步骤通常依赖前者）；
 * `kind: 'scan'` 走进程内扫描（secrets / artifacts）。
 */
function buildGates(ctx) {
  const { root, opts, manifest, workspaceDirs, pm } = ctx;
  const scripts = manifest?.scripts ?? {};
  const gates = [];

  // 1) 类型检查：工作区递归优先（本仓两个工作区都定义了 typecheck），根脚本兜底。
  const typecheckRecursive = workspaceHasScript(root, workspaceDirs, 'typecheck');
  if (typecheckRecursive) {
    gates.push({
      id: 'typecheck',
      title: '工作区类型检查（tsc --noEmit）',
      kind: 'command',
      steps: [{ label: 'workspace typecheck', ...pmRun(pm, 'typecheck', { recursive: true }) }],
    });
  } else if (scripts.typecheck) {
    gates.push({
      id: 'typecheck',
      title: '类型检查（根脚本）',
      kind: 'command',
      steps: [{ label: 'root typecheck', ...pmRun(pm, 'typecheck') }],
    });
  }

  // 2) 单元测试：根 `test:unit` 覆盖 tests/unit + privacy/media/reference/moderation；
  //    工作区都不定义它，所以「递归」对它是空门禁 ⇒ 有根脚本就跑根脚本。
  if (scripts['test:unit']) {
    gates.push({
      id: 'unit',
      title: '单元测试（node --test）',
      kind: 'command',
      steps: [{ label: 'root test:unit', ...pmRun(pm, 'test:unit') }],
    });
  } else if (workspaceHasScript(root, workspaceDirs, 'test:unit')) {
    gates.push({
      id: 'unit',
      title: '单元测试（工作区递归）',
      kind: 'command',
      steps: [{ label: 'workspace test:unit', ...pmRun(pm, 'test:unit', { recursive: true }) }],
    });
  }

  // 3) 契约测试：有 `test:contract` 才跑；再叠加（存在时）契约状态一致性校验，与 CI `contract` job 同口径。
  const contractSteps = [];
  if (scripts['test:contract']) {
    contractSteps.push({ label: 'root test:contract', ...pmRun(pm, 'test:contract') });
  }
  if (existsSync(join(root, 'tools', 'verify-contract-status.mjs'))) {
    contractSteps.push({ label: 'verify-contract-status', command: 'node', args: ['tools/verify-contract-status.mjs'] });
  }
  if (contractSteps.length > 0) {
    gates.push({ id: 'contract', title: '契约测试与契约状态一致性', kind: 'command', steps: contractSteps });
  }

  // 4) 私密信息扫描 / 5) 大文件与二进制：进程内，扫的是待发布 diff。
  gates.push({ id: 'secrets', title: '私密信息泄漏扫描（待发布 diff 新增行）', kind: 'scan' });
  gates.push({ id: 'artifacts', title: '大文件与二进制检查（待发布 diff 新增文件）', kind: 'scan' });

  // 6) 真库臂：默认跳过并标注；`--pg` 时跑根 `test:integration:*-pg` 脚本（有几个跑几个）。
  const pgScripts = Object.keys(scripts).filter((name) => /^test:integration:.*-pg$/.test(name)).sort();
  gates.push({
    id: 'pg',
    title: '真库集成臂（PostgreSQL）',
    kind: 'command',
    defaultSkipReason: '真库臂需要本机 PostgreSQL 17 ＋ 连接参数 ＋ 预置 fixture；默认跳过，用 --pg 显式开启',
    steps: opts.pg && pgScripts.length > 0
      ? pgScripts.map((name) => ({ label: `root ${name}`, ...pmRun(pm, name) }))
      : [],
  });

  return gates;
}

/** 用 `--plan` 覆盖门禁定义（自动化测试与故障注入用；字段与内置结构同构）。 */
function gatesFromPlan(ctx, planPath) {
  let plan;
  try {
    plan = readJsonFile(planPath);
  } catch (error) {
    // 计划文件坏掉属**用法错误**（exit 2），不能伪装成「门禁失败」（exit 1）。
    throw new UsageError(`计划文件不是合法 JSON：${planPath}（${error.message}）`);
  }
  if (!Array.isArray(plan.gates) || plan.gates.length === 0) {
    throw new UsageError(`计划文件缺少非空 gates 数组：${planPath}`);
  }
  const seen = new Set();
  return plan.gates.map((gate) => {
    if (typeof gate?.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(gate.id)) {
      throw new UsageError(`计划文件里的门禁 id 不合法：${JSON.stringify(gate?.id)}`);
    }
    if (seen.has(gate.id)) throw new UsageError(`计划文件里的门禁 id 重复：${gate.id}`);
    seen.add(gate.id);
    if (gate.kind === 'scan') return { ...gate, kind: 'scan' };
    const steps = gate.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new UsageError(`计划文件里门禁 ${gate.id} 缺少非空 steps`);
    }
    for (const step of steps) {
      if (typeof step?.command !== 'string' || !Array.isArray(step.args)) {
        throw new UsageError(`计划文件里门禁 ${gate.id} 的 steps 需要 {command,args}`);
      }
    }
    return { ...gate, kind: 'command' };
  });
}

// ---------------------------------------------------------------------------
// 门禁执行
// ---------------------------------------------------------------------------

function runCommandGate(ctx, gate) {
  const started = Date.now();
  const executed = [];
  let failure = null;
  for (const step of gate.steps) {
    const result = runCommand(ctx, step);
    executed.push({ label: step.label ?? result.line, command: result.line, durationMs: result.durationMs, exitCode: result.exitCode, status: result.status });
    if (result.status === 'failed') {
      failure = result;
      break;
    }
  }
  const durationMs = Date.now() - started;
  if (!failure) {
    return {
      id: gate.id,
      title: gate.title ?? gate.id,
      status: 'passed',
      durationMs,
      exitCode: 0,
      command: executed.map((item) => item.command).join(' && '),
      skipReason: null,
      errorLines: [],
      details: { steps: executed },
    };
  }
  return {
    id: gate.id,
    title: gate.title ?? gate.id,
    status: 'failed',
    durationMs,
    exitCode: failure.exitCode,
    command: failure.line,
    skipReason: null,
    errorLines: failure.errorLines.slice(0, MAX_ERROR_LINES),
    details: { steps: executed },
  };
}

/** 私密信息扫描：只报掩码，命中即失败（`medium` 路径命中同样失败——本机路径不该进仓库）。 */
function runSecretsGate(ctx, gate) {
  const started = Date.now();
  const base = ctx.base;
  if (!base.sha) {
    return failedScan(gate, started, `无法解析基线（试过：${base.attempts.join(' → ')}），无法确定待发布 diff；请用 --base 指定`, {
      base: { ref: base.ref, sha: null },
    });
  }
  const collected = collectAddedLines(ctx.root, base.sha);
  if (!collected.ok) {
    return failedScan(gate, started, `git diff 失败：${truncate(collected.error.trim(), MAX_LINE_CHARS)}`, {
      base: { ref: base.ref, sha: base.sha },
    });
  }

  const hits = [];
  for (const item of collected.lines) {
    for (const rule of SCAN_RULES) {
      const regex = new RegExp(rule.regex.source, rule.regex.flags);
      let match;
      while ((match = regex.exec(item.text)) !== null) {
        const raw = rule.offsetGroup ? match[rule.offsetGroup] : match[0];
        if (!raw) continue;
        hits.push({
          file: item.file,
          line: item.line,
          rule: rule.id,
          severity: rule.severity,
          label: rule.label,
          // high 规则一律掩码；medium（本机路径）原样给出，便于定位与修复。
          preview: rule.mask === false ? truncate(raw, 120) : maskToken(raw),
        });
        if (regex.lastIndex === match.index) regex.lastIndex += 1; // 零宽匹配防死循环
      }
    }
  }
  const durationMs = Date.now() - started;
  const scanned = collected.lines.length;
  if (hits.length === 0) {
    return {
      id: gate.id,
      title: gate.title ?? gate.id,
      status: 'passed',
      durationMs,
      exitCode: 0,
      command: `git diff ${base.ref}...HEAD（新增行扫描）`,
      skipReason: null,
      errorLines: [],
      details: { base: { ref: base.ref, sha: base.sha }, scannedLines: scanned, hits: [] },
    };
  }
  const high = hits.filter((hit) => hit.severity === 'high');
  const first = hits.slice(0, MAX_ERROR_LINES).map((hit) => `${hit.file}:${hit.line} ${hit.label} ⇒ ${hit.preview}`);
  return {
    id: gate.id,
    title: gate.title ?? gate.id,
    status: 'failed',
    durationMs,
    exitCode: 1,
    command: `git diff ${base.ref}...HEAD（新增行扫描）`,
    skipReason: null,
    errorLines: first,
    details: {
      base: { ref: base.ref, sha: base.sha },
      scannedLines: scanned,
      hitCount: hits.length,
      highSeverityCount: high.length,
      hits,
    },
  };
}

/** 大文件与二进制：默认「超过阈值」与「二进制」都算失败；`--binary-allow` 可按扩展名放行二进制。 */
function runArtifactsGate(ctx, gate) {
  const started = Date.now();
  const base = ctx.base;
  if (!base.sha) {
    return failedScan(gate, started, `无法解析基线（试过：${base.attempts.join(' → ')}），无法确定待发布 diff；请用 --base 指定`, {
      base: { ref: base.ref, sha: null },
    });
  }
  const changed = collectChangedFiles(ctx.root, base.sha);
  if (!changed.ok) {
    return failedScan(gate, started, `git diff --name-only 失败：${truncate(changed.error.trim(), MAX_LINE_CHARS)}`, {
      base: { ref: base.ref, sha: base.sha },
    });
  }

  const findings = [];
  for (const file of changed.files) {
    const full = join(ctx.root, file);
    if (!existsSync(full)) continue;
    const stat = statSync(full);
    if (!stat.isFile()) continue;
    const ext = extname(file).toLowerCase();
    const binary = looksBinary(full);
    const tooLarge = stat.size > ctx.opts.maxFileBytes;
    const binaryAllowed = binary && ctx.opts.binaryAllow.includes(ext);
    if (tooLarge) {
      findings.push({ file, bytes: stat.size, binary, problem: 'too-large', thresholdBytes: ctx.opts.maxFileBytes });
    }
    if (binary && !binaryAllowed) {
      findings.push({ file, bytes: stat.size, binary, problem: 'binary', thresholdBytes: ctx.opts.maxFileBytes });
    }
  }
  const durationMs = Date.now() - started;
  if (findings.length === 0) {
    return {
      id: gate.id,
      title: gate.title ?? gate.id,
      status: 'passed',
      durationMs,
      exitCode: 0,
      command: `git diff ${base.ref}...HEAD（新增文件）`,
      skipReason: null,
      errorLines: [],
      details: {
        base: { ref: base.ref, sha: base.sha },
        scannedFiles: changed.files.length,
        thresholdBytes: ctx.opts.maxFileBytes,
        binaryAllow: ctx.opts.binaryAllow,
        findings: [],
      },
    };
  }
  return {
    id: gate.id,
    title: gate.title ?? gate.id,
    status: 'failed',
    durationMs,
    exitCode: 1,
    command: `git diff ${base.ref}...HEAD（新增文件）`,
    skipReason: null,
    errorLines: findings.slice(0, MAX_ERROR_LINES).map((finding) => (
      finding.problem === 'too-large'
        ? `${finding.file} 体积 ${finding.bytes} 字节 > 阈值 ${finding.thresholdBytes}`
        : `${finding.file} 是二进制文件（${finding.bytes} 字节），非白名单扩展名`
    )),
    details: {
      base: { ref: base.ref, sha: base.sha },
      scannedFiles: changed.files.length,
      thresholdBytes: ctx.opts.maxFileBytes,
      binaryAllow: ctx.opts.binaryAllow,
      findings,
    },
  };
}

function failedScan(gate, started, message, details) {
  return {
    id: gate.id,
    title: gate.title ?? gate.id,
    status: 'failed',
    durationMs: Date.now() - started,
    exitCode: 1,
    command: null,
    skipReason: null,
    errorLines: [truncate(message, MAX_LINE_CHARS)],
    details,
  };
}

function skippedGate(gate, reason) {
  return {
    id: gate.id,
    title: gate.title ?? gate.id,
    status: 'skipped',
    durationMs: 0,
    exitCode: null,
    command: null,
    skipReason: reason,
    errorLines: [],
    details: {},
  };
}

/** 单项分发：默认跳过 → 扫描 → 命令。 */
function runGate(ctx, gate) {
  if (gate.defaultSkipReason && !ctx.opts.pg) return skippedGate(gate, gate.defaultSkipReason);
  if (gate.kind === 'scan') {
    if (gate.id === 'secrets') return runSecretsGate(ctx, gate);
    if (gate.id === 'artifacts') return runArtifactsGate(ctx, gate);
    return skippedGate(gate, `未知扫描门禁：${gate.id}`);
  }
  if (!gate.steps || gate.steps.length === 0) {
    return skippedGate(gate, gate.skipReason ?? '没有任何可执行步骤');
  }
  return runCommandGate(ctx, gate);
}

// ---------------------------------------------------------------------------
// 汇总与输出
// ---------------------------------------------------------------------------

function summarize(gates, ctx) {
  const counts = { total: gates.length, passed: 0, failed: 0, skipped: 0 };
  for (const gate of gates) counts[gate.status] += 1;
  const verdict = counts.failed > 0 ? 'fail' : 'pass';
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: 'release-gate',
    generatedAt: new Date().toISOString(),
    root: ctx.root,
    packageManager: ctx.pm,
    base: { ref: ctx.base.ref, sha: ctx.base.sha, attempts: ctx.base.attempts },
    verdict,
    exitCode: verdict === 'fail' ? 1 : 0,
    counts,
    gates,
    notes: [
      'stdout 只输出本 JSON；人读摘要走 stderr。',
      'skipped 不计入失败，但会写进 counts 与 skipReason，不得当成通过。',
      `二进制放行扩展名：${ctx.opts.binaryAllow.length === 0 ? '（无）' : ctx.opts.binaryAllow.join(', ')}`,
    ],
  };
}

/** 人读摘要（stderr）：一行一项 ＋ 判定行 ＋ 失败项的关键错误行。 */
function writeHumanSummary(report) {
  const lines = [];
  for (const gate of report.gates) {
    const mark = gate.status === 'passed' ? 'PASS' : gate.status === 'failed' ? 'FAIL' : 'SKIP';
    const exit = gate.exitCode === null ? '' : ` exit=${gate.exitCode}`;
    lines.push(`[${mark}] ${gate.id}  ${gate.durationMs}ms${exit}${gate.skipReason ? `  — ${gate.skipReason}` : ''}`);
    for (const errorLine of gate.errorLines) lines.push(`        ${errorLine}`);
  }
  lines.push(`判定：${report.verdict.toUpperCase()}（通过 ${report.counts.passed} / 失败 ${report.counts.failed} / 跳过 ${report.counts.skipped}）`);
  process.stderr.write(`${lines.join('\n')}\n`);
}

/** 门禁选择：`--only` 白名单优先，其次按 `--skip` 剔除；空选择按用法错误处理。 */
function selectGates(all, opts) {
  const byId = new Map(all.map((gate) => [gate.id, gate]));
  if (opts.only) {
    const missing = opts.only.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new UsageError(`这些门禁在当前仓库/计划里不存在：${missing.join(', ')}（可用：${[...byId.keys()].join(' / ')}）`);
    }
    return opts.only.map((id) => byId.get(id));
  }
  const unknownSkip = (opts.skip ?? []).filter((id) => !byId.has(id));
  if (unknownSkip.length > 0) {
    throw new UsageError(`--skip 里有当前仓库/计划不存在的门禁：${unknownSkip.join(', ')}（可用：${[...byId.keys()].join(' / ')}）`);
  }
  const kept = all.filter((gate) => !(opts.skip ?? []).includes(gate.id));
  if (kept.length === 0) throw new UsageError('过滤后没有任何门禁可跑（检查 --skip）');
  return kept;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`用法错误：${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }

  if (opts.help) {
    process.stderr.write(USAGE);
    return 0;
  }
  if (opts.list) {
    process.stdout.write(`${JSON.stringify({ gates: GATE_IDS }, null, 2)}\n`);
    return 0;
  }
  if (!existsSync(opts.root)) {
    process.stderr.write(`用法错误：--root 不存在：${opts.root}\n`);
    return 2;
  }
  if (opts.plan && !existsSync(opts.plan)) {
    process.stderr.write(`用法错误：--plan 不存在：${opts.plan}\n`);
    return 2;
  }

  const manifest = readRootManifest(opts.root);
  const pm = detectPackageManager(opts.root).id;
  const ctx = {
    root: opts.root,
    opts,
    manifest,
    pm,
    workspaceDirs: listWorkspaceDirs(opts.root, manifest),
    base: resolveBase(opts.root, opts.base),
  };

  let report;
  try {
    const all = opts.plan ? gatesFromPlan(ctx, opts.plan) : buildGates(ctx);
    const selected = selectGates(all, opts);
    const results = selected.map((gate) => runGate(ctx, gate));
    report = summarize(results, ctx);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`用法错误：${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }

  const payload = `${JSON.stringify(report, null, 2)}\n`;
  const outPath = resolve(opts.root, opts.out);
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, payload, 'utf8');
  } catch (error) {
    process.stderr.write(`无法写入报告文件 ${outPath}：${error.message}\n`);
  }
  process.stdout.write(payload);
  writeHumanSummary(report);
  return report.exitCode;
}

process.exitCode = main(process.argv.slice(2));
