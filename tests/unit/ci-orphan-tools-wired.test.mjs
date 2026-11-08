/**
 * tools/** 接线面元闸门：**每个 `tools/*.mjs` 要么被常跑 workflow 的 `run:` 点名，要么被某个
 * 在真仓上运行它并断言退出码的测试覆盖**；两者都不是，就必须进白名单并写明理由。
 *
 * 缺口（为什么需要这个文件）：仓库已有 `tests/unit/ci-orphan-tests-wired.test.mjs` 管 `tests/**`
 * 的孤儿，但 `tools/**` 是空档——「有工具、没接线」可以长期存在而 CI 全绿。真实事故：
 * `tools/verify-verification-comment-anchors.mjs` 只有临时夹具单测（该测试文件自己写着
 * 「全部用临时目录夹具 + 直接调 main()，⛔ 不 spawn 子进程、不写仓库内文件」），**真仓从来没跑过它**；
 * 结果 main 上曾同时成立三件事：单测绿 + 真仓 EXIT 1（基线外新增 9 条）+ CI 绿。
 * 三者不矛盾，因为「测试文件存在」≠「工具在真仓上跑过」。
 *
 * 判类口径（只认这两条，其余一律算未接线）：
 *   A 接线：某份 `.github/workflows/*.yml` 的 `run:` 文本里点名了该路径（`node tools/x.mjs`、
 *     `node --check tools/x.mjs` 都算；`paths:` / `paths-ignore:` 列表**不算**，那只是触发面）。
 *     A2 转接：`package.json` 的 script 命令文本里点名该路径，且该 script 被某份 workflow 以
 *     `npm run <script>` 调用（与 `ci-orphan-tests-wired.test.mjs` 的 npm 侧口径一致：只认真的被调用的 script）。
 *   B 接线：`tests/` 下某个 `.mjs` 里用 spawn 家族（`spawnSync` / `execFileSync` / `execSync` /
 *     `execFile` / `spawn`）**跑真仓里的这个文件**，且同文件里有退出码断言（`assert.*(... .status`）。
 *     「跑真仓」的判定：`cwd` 显式指向仓库根；或未传 `cwd`（继承，`npm run test:unit` 在仓库根）；
 *     或 `cwd` 是该文件的默认参数且默认值是仓库根标识符。`cwd` 是夹具变量、`cwd` 简写、或参数
 *     `--root/--dir/--project/--workspace` 被改指夹具 ⇒ 不算。
 *
 * 四种「看起来像接线、其实不算」（本片要防的正是这四种）：
 *   ① **仅 import**：测试 `import { x } from '../../tools/y.mjs'` 后调导出函数——那是模块级单测，
 *      没有进程、没有退出码，工具的 CLI 入口（argv/env/退出码/写盘）一行都没跑。
 *   ② **只夹具**：把工具复制进临时树（或 `--root <夹具>`）再 spawn——测的是夹具，不是本仓。
 *   ③ **无退出码断言**：spawn 了但只看 stdout/不 assert `.status`，工具可以 EXIT 1 而测试全绿。
 *   ④ **只在文档/注释/README 里出现**：`tests/failmatrix/README.md` 写了命令 ≠ 有人跑。
 * 反例（本文件的原始动机）：`tools/verify-verification-comment-anchors.mjs` 属于 ①②：它的守卫
 *   `tests/unit/verify-verification-comment-anchors.test.mjs:29` 只 import 三个导出函数，
 *   在 `mkdtempSync` 夹具树上直接调 `main()`，一个子进程都不起 ⇒ 真仓的 9 条基线外新增无人发现。
 *
 * 判据：
 *   ① 扫描面下界（tools / workflow / run 步 / 测试文件数），防止「路径写错 ⇒ 扫了个寂寞 ⇒ 全绿」。
 *   ② 未接线且不在白名单 ⇒ 红，逐条点名并给三种修法。
 *   ③ 白名单里已接线的条目 ⇒ 红「已过期，删掉它」（与 `ci-orphan-tests-wired.test.mjs` 同口径：
 *      过期判红，不是只提示）。
 *   ④ 白名单自身可核：路径必须是真的 `tools/*.mjs`；`kind` 必须是
 *      `by-design`（确实不该接）/ `library`（库模块，由 host 脚本承担接线）/ `in-process`
 *      （没有 CLI 入口，被某个**CI 真的会跑**的测试在进程内驱动）/ `gap`（本该接线，本片接不了）；
 *      `reason` 必须写清楚；`library` 的 host 必须存在且最终接到一个已接线脚本；`in-process`
 *      的 `exercisedBy` 必须是真测试文件且该文件被某份 workflow 的 `run:`（含 `npm run` 转接）点名。
 *   ⑤ 反向控制：把合成文本喂给同一批判据函数，钉住 6 条边（注释 run 不算、块标量里的 shell 注释不算、
 *      `node --check` 算、仅 import 不算、夹具 spawn 不算、真仓 spawn 无 `.status` 断言不算）。
 *   ⑥ `gap` 台账：登记为「本该接线」的条目逐条打印（不判红）。它是本片留给后续片的待办清单，
 *      不是「已经没问题了」的证明。
 *
 * 不声称：
 *   * 不声称这些脚本的**判据本身正确**——本闸门只看「有没有人跑它」，不看它判得对不对。
 *   * 不声称 A 的强度足够：`node --check` 只做语法级，本闸门把它与真正执行同等记为「已接线」，
 *     强/弱只落在 `docs/verification/gy-r90-tools-wiring-metagate-20261109.md` 的表格里。
 *   * 不声称替代真正的 CI 接线：白名单里的 `gap` 是**已知缺口**，不是豁免。
 *   * 只覆盖 `tools/*.mjs`（顶层）与「被顶层 import 的 `tools/lib/**`」；`tools/evaluation/**`、
 *     `tools/knowledge/**` 的 python 脚本不在扫描面内。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOLS_DIR = join(REPO_ROOT, 'tools');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const TESTS_DIR = join(REPO_ROOT, 'tests');
const BASELINE_PATH = join(TESTS_DIR, 'unit', 'orphan-tools-wired-baseline.json');

/** 反空转下界（a30c8adb 实测：47 个 tools 脚本 / 15 份 workflow / 713 个测试文件，留余量）。 */
const FLOOR = Object.freeze({tools: 44, workflows: 14, runSteps: 140, testFiles: 600});

const KINDS = new Set(['by-design', 'library', 'in-process', 'gap']);

const SPAWN_FNS = ['spawnSync', 'execFileSync', 'execSync', 'execFile', 'spawn'];
/** 把工具指到夹具上的参数：值不是仓库根 ⇒ 这次 spawn 测的是夹具。 */
const ROOT_FLAGS = ['--root', '--dir', '--project', '--workspace'];
const STATUS_ASSERT = /assert\.[A-Za-z_$][\w$]*\([^)]*\.status\b/;

const toPosix = (path) => path.split(sep).join('/');
const readRepo = (relPath) => readFileSync(join(REPO_ROOT, relPath), 'utf8');
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// ---------------------------------------------------------------- 扫描面

function listToolScripts() {
  return readdirSync(TOOLS_DIR)
    .filter((name) => name.endsWith('.mjs'))
    .sort()
    .map((name) => `tools/${name}`)
    .filter((rel) => statSync(join(REPO_ROOT, rel)).isFile());
}

function listWorkflowFiles() {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map((name) => `.github/workflows/${name}`);
}

function listTestFiles(dir = TESTS_DIR, acc = []) {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listTestFiles(full, acc);
    else if (entry.name.endsWith('.mjs')) acc.push(toPosix(relative(REPO_ROOT, full)));
  }
  return acc.sort();
}

// ---------------------------------------------------------------- workflow 侧

/**
 * 解析一份 workflow：抽出每个 `run:` 的**可执行文本**（块标量按缩进收进来），跳过 YAML 注释行与
 * 块标量里的 shell 注释行。`paths:` / `paths-ignore:` 只记存在与否，**不当作接线证据**。
 */
function parseWorkflow(text) {
  const lines = text.split(/\r?\n/);
  const runs = [];
  let hasPaths = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;
    if (/^\s*(paths|paths-ignore)\s*:/.test(line)) hasPaths = true;
    const match = /^(\s*)(?:-\s*)?run\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const indent = match[1].length;
    let body = match[2].trim();
    if (/^[|>][-+0-9]*$/.test(body)) {
      const collected = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const inner = lines[j];
        if (/^\s*$/.test(inner)) {
          collected.push('');
          continue;
        }
        const innerIndent = /^\s*/.exec(inner)[0].length;
        if (innerIndent <= indent) break;
        if (/^\s*#/.test(inner)) continue; // 块标量里的注释行
        collected.push(inner.trim());
      }
      body = collected.join('\n');
    }
    runs.push({line: i + 1, text: body});
  }
  return {runs, hasPaths};
}

function commandTokens(text) {
  return text
    .replace(/["']/g, ' ')
    .split(/[\s;|&()<>,]+/)
    .filter(Boolean);
}

function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/** 命令文本里是否点名了某个仓内路径：整词相等、以 `/` 收尾的整词、或含 `*` 的 glob 命中。 */
function namesPathInCommand(text, relPath) {
  const target = toPosix(relPath);
  for (const token of commandTokens(text)) {
    if (token === target) return true;
    if (token.endsWith(`/${target}`)) return true;
    if (token.includes('*') && globToRegExp(token).test(target)) return true;
  }
  return false;
}

function loadPackageScripts() {
  const pkg = JSON.parse(readRepo('package.json'));
  return pkg.scripts ?? {};
}

/** workflow 里所有 `npm run <script>` 调用（含块标量内部的）。 */
function scriptInvocations(workflows) {
  const calls = [];
  for (const wf of workflows) {
    for (const run of wf.runs) {
      for (const match of run.text.matchAll(/npm\s+run\s+([A-Za-z0-9:_.-]+)/g)) {
        calls.push({script: match[1], workflow: wf.file, line: run.line});
      }
    }
  }
  return calls;
}

// ---------------------------------------------------------------- tests 侧

/** 仓库根标识符：`const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')`（允许多级前缀）。 */
function repoRootIdents(source) {
  const idents = new Set();
  const pattern = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:path\.)?(?:resolve|join)\(\s*(?:path\.)?dirname\(\s*(?:path\.)?fileURLToPath\(import\.meta\.url\)/g;
  for (const match of source.matchAll(pattern)) idents.add(match[1]);
  return idents;
}

/** 默认值就是仓库根标识符的形参名（`function gate(args, cwd = ROOT)`）。 */
function rootDefaultParams(source, rootIdents) {
  const params = new Set();
  for (const match of source.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*[,)]/g)) {
    if (rootIdents.has(match[2])) params.add(match[1]);
  }
  return params;
}

/**
 * 从 `tools/*.mjs` 里 import 进来的仓库根常量：工具自己按 `fileURLToPath(import.meta.url)` 算过根，
 * 测试直接复用它当 `join()` 的基准（tests/evaluation/gy-i20-sample-gap-recompute.test.mjs:15 就是这种写法）。
 * 只认 `REPO_ROOT` / `ROOT` 这两个名字，别的导入标识符不猜。
 */
function importedRootIdents(source) {
  const idents = new Set();
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'[^']*tools\/[^']+\.mjs'/g)) {
    for (const raw of match[1].split(',')) {
      const [imported, local] = raw.trim().split(/\s+as\s+/);
      if (/^(?:REPO_)?ROOT$/.test(imported ?? '')) idents.add((local ?? imported).trim());
    }
  }
  return idents;
}

function quoteLiterals(expression) {
  return [...expression.matchAll(/'([^']*)'|"([^"]*)"/g)].map((match) => match[1] ?? match[2]);
}

function isRepoRootExpression(expression, context) {
  const expr = String(expression).trim().replace(/^\((.*)\)$/, '$1').trim();
  if (!expr) return false;
  if (context.rootIdents.has(expr) || context.rootParams.has(expr)) return true;
  // `fileURLToPath(new URL('../../', import.meta.url))`：只在文件正好是 <root>/tests/<子目录>/*.mjs 时是仓库根。
  const url = /^(?:fileURLToPath\(\s*)?new URL\(\s*'([^']+)'\s*,\s*import\.meta\.url\s*\)\s*\)?$/.exec(expr);
  if (url && context.fileRel) {
    const base = dirname(join(REPO_ROOT, context.fileRel));
    return resolve(base, url[1]) === REPO_ROOT;
  }
  return false;
}

/** 表达式 → `tools/x.mjs`（只认锚在仓库根 / 本测试文件相对路径上的工具路径）。 */
function toolPathOfExpression(expression, context, aliases) {
  const expr = String(expression).trim();
  const joinCall = /^(?:path\.)?(?:join|resolve)\(\s*([\s\S]+?)\s*,\s*([\s\S]+)\)$/.exec(expr);
  if (joinCall) {
    if (!isRepoRootExpression(joinCall[1], context)) return null;
    const parts = quoteLiterals(joinCall[2]);
    if (parts.length === 0) return null;
    const rel = parts.join('/').replace(/^\.\//, '');
    return /^tools\/[A-Za-z0-9_.-]+\.mjs$/.test(rel) ? rel : null;
  }
  const newUrl = /^new URL\(\s*'([^']+)'\s*,\s*import\.meta\.url\s*\)$/.exec(expr);
  if (newUrl && context.fileRel) {
    const base = dirname(join(REPO_ROOT, context.fileRel));
    const rel = toPosix(relative(REPO_ROOT, resolve(base, newUrl[1])));
    return /^tools\/[A-Za-z0-9_.-]+\.mjs$/.test(rel) ? rel : null;
  }
  const wrapped = /^fileURLToPath\(\s*([\s\S]+?)\s*\)$/.exec(expr);
  if (wrapped) {
    if (aliases.has(wrapped[1].trim())) return aliases.get(wrapped[1].trim());
    return toolPathOfExpression(wrapped[1], context, aliases);
  }
  if (aliases.has(expr)) return aliases.get(expr);
  // `const TOOL = 'tools/x.mjs'`：相对仓库根的裸路径字面量（cwd 是不是仓库根，由 cwd 判定单独管）。
  const literal = /^'([^']+)'$|^"([^"]+)"$/.exec(expr);
  if (literal) {
    const rel = (literal[1] ?? literal[2]).replace(/^\.\//, '');
    return /^tools\/[A-Za-z0-9_.-]+\.mjs$/.test(rel) ? rel : null;
  }
  return null;
}

/** 文件里所有「标识符 → tools/x.mjs」的别名（支持 fileURLToPath 链式），最多展开 4 轮。 */
function toolAliases(source, context) {
  const declared = new Map();
  for (const match of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) {
    declared.set(match[1], match[2].trim());
  }
  const aliases = new Map();
  for (let pass = 0; pass < 4; pass += 1) {
    for (const [ident, expr] of declared) {
      if (aliases.has(ident)) continue;
      const tool = toolPathOfExpression(expr, context, aliases);
      if (tool) aliases.set(ident, tool);
    }
  }
  return aliases;
}

/** 从 `(` 之后开始，截到配对的 `)`（跳过字符串里的括号）。 */
function callWindow(source, from) {
  let depth = 1;
  let index = from;
  let quote = null;
  while (index < source.length && depth > 0) {
    const ch = source[index];
    if (quote) {
      if (ch === '\\') {
        index += 2;
        continue;
      }
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
    }
    index += 1;
  }
  return source.slice(from, index);
}

/**
 * 从 `from` 读一个参数值：走到顶层的 `,` / `}` / 换行 / 语句结尾为止（跳过字符串与成对括号）。
 * ⚠️ 不能用 `/cwd\s*:\s*([^,}\n]+)/`——嵌套调用（`fileURLToPath(new URL('../../', import.meta.url))`）
 * 里的逗号会把它截断，`purge-expired-online-data` 的 B 证据就是这么被误判成夹具的。
 */
function readValue(source, from) {
  let depth = 0;
  let index = from;
  let quote = null;
  while (index < source.length) {
    const ch = source[index];
    if (quote) {
      if (ch === '\\') {
        index += 2;
        continue;
      }
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && (ch === ',' || ch === '\n' || ch === ';')) {
      break;
    }
    index += 1;
  }
  return source.slice(from, index).trim();
}

/**
 * 分析一份测试源码里的 spawn 站点。返回的每个站点带 `cwdType`（root|inherit|fixture|unknown）与
 * `redirected`（`--root` 等被指向夹具）。`isRealRepoRun()` 才是一条 B 证据。
 */
/**
 * 从一个 spawn 窗口里抓出它指向的 `tools/x.mjs`：裸字面量、内联 `join/resolve/new URL` 调用、别名标识符。
 * 内联写法（`spawnSync(node, [join(ROOT, 'tools', 'x.mjs')])`）没有别名可查，必须在这里就地解析。
 */
function toolPathsInWindow(window, context, aliases) {
  const found = new Set();
  for (const match of window.matchAll(/tools\/([A-Za-z0-9_.-]+\.mjs)/g)) found.add(`tools/${match[1]}`);
  for (const match of window.matchAll(/((?:path\.)?(?:join|resolve)|new URL)\s*\(/g)) {
    const inner = callWindow(window, match.index + match[0].length); // 含右括号
    const tool = toolPathOfExpression(`${match[1]}(${inner}`, context, aliases);
    if (tool) found.add(tool);
  }
  for (const [ident, tool] of aliases) {
    if (new RegExp(`\\b${ident.replace(/\$/g, '\\$')}\\b`).test(window)) found.add(tool);
  }
  return found;
}

function analyzeTestSource(source, fileRel) {
  const rootIdents = new Set([...repoRootIdents(source), ...importedRootIdents(source)]);
  const context = {rootIdents, rootParams: rootDefaultParams(source, rootIdents), fileRel};
  const aliases = toolAliases(source, context);
  const statusAssert = STATUS_ASSERT.test(source);
  const sites = [];
  const pattern = new RegExp(`\\b(${SPAWN_FNS.join('|')})\\s*\\(`, 'g');
  for (const match of source.matchAll(pattern)) {
    const window = callWindow(source, match.index + match[0].length);
    const tools = toolPathsInWindow(window, context, aliases);
    if (tools.size === 0) continue;
    let cwdType = 'inherit';
    const cwdAssign = /\bcwd\s*:\s*/.exec(window);
    if (cwdAssign) {
      const value = readValue(window, cwdAssign.index + cwdAssign[0].length);
      cwdType = isRepoRootExpression(value, context) ? 'root' : 'fixture';
    } else {
      // `{cwd, ...}` 简写：只有 cwd 的默认值就是仓库根（`function gate(args, cwd = ROOT)`）才算 root。
      const shorthand = /[{,]\s*([A-Za-z_$][\w$]*)\s*[,}]/.exec(window);
      if (shorthand && shorthand[1] === 'cwd') {
        cwdType = context.rootParams.has(shorthand[1]) || context.rootIdents.has(shorthand[1]) ? 'root' : 'unknown';
      }
    }
    let redirected = false;
    for (const flag of ROOT_FLAGS) {
      const spaced = new RegExp(`['"]${flag}['"]\\s*,\\s*`).exec(window);
      if (spaced && !isRepoRootExpression(readValue(window, spaced.index + spaced[0].length), context)) redirected = true;
      const inline = new RegExp(`${flag}=([^\\s'"]+)`).exec(window);
      if (inline && !isRepoRootExpression(`'${inline[1]}'`, context)) redirected = true;
    }
    sites.push({file: fileRel, line: lineOf(source, match.index), tools: [...tools], cwdType, redirected, statusAssert});
  }
  return sites;
}

function isRealRepoRun(site) {
  return site.statusAssert && !site.redirected && (site.cwdType === 'root' || site.cwdType === 'inherit');
}

// ---------------------------------------------------------------- 模型与判类

function buildModel() {
  const workflows = listWorkflowFiles().map((file) => ({file, ...parseWorkflow(readRepo(file))}));
  const scripts = loadPackageScripts();
  const testFiles = listTestFiles();
  const sites = testFiles.flatMap((file) => analyzeTestSource(readRepo(file), file));
  return {workflows, scripts, testFiles, sites};
}

/** 该仓内路径是否被某份 workflow 的 `run:` 点名（含 `npm run <script>` 转接）。 */
function runInCi(relPath, model) {
  for (const wf of model.workflows) {
    for (const run of wf.runs) if (namesPathInCommand(run.text, relPath)) return `${wf.file}:${run.line}`;
  }
  for (const call of scriptInvocations(model.workflows)) {
    const command = model.scripts[call.script];
    if (typeof command === 'string' && namesPathInCommand(command, relPath)) return `${call.workflow}:${call.line}（npm run ${call.script}）`;
  }
  return null;
}

/** 一个 tools 脚本的接线证据（空数组 = 未接线）。 */
function classify(tool, model = MODEL) {
  const evidence = [];
  for (const wf of model.workflows) {
    for (const run of wf.runs) {
      if (namesPathInCommand(run.text, tool)) evidence.push(`${wf.file}:${run.line}（run: 点名）`);
    }
  }
  for (const call of scriptInvocations(model.workflows)) {
    const command = model.scripts[call.script];
    if (typeof command === 'string' && namesPathInCommand(command, tool)) {
      evidence.push(`${call.workflow}:${call.line}（npm run ${call.script} → package.json scripts.${call.script}）`);
    }
  }
  for (const site of model.sites) {
    if (site.tools.includes(tool) && isRealRepoRun(site)) {
      evidence.push(`${site.file}:${site.line}（spawn 真仓 + .status 断言）`);
    }
  }
  return evidence;
}

function loadBaseline() {
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8').replace(/^\uFEFF/, ''));
  assert.ok(Array.isArray(parsed.entries), `${BASELINE_PATH} 必须有 entries 数组`);
  return parsed;
}

const MODEL = buildModel();
const TOOLS = listToolScripts();

// ---------------------------------------------------------------- 判据

test('① 扫描面下界：tools / workflow / run 步 / 测试文件都还在', () => {
  const runSteps = MODEL.workflows.reduce((sum, wf) => sum + wf.runs.length, 0);
  assert.ok(TOOLS.length >= FLOOR.tools, `tools/*.mjs 只有 ${TOOLS.length} 个（下界 ${FLOOR.tools}）——路径写错或扫描面被改小`);
  assert.ok(MODEL.workflows.length >= FLOOR.workflows, `workflow 只有 ${MODEL.workflows.length} 份（下界 ${FLOOR.workflows}）`);
  assert.ok(runSteps >= FLOOR.runSteps, `run: 步只有 ${runSteps} 条（下界 ${FLOOR.runSteps}）——解析器坏了会全绿`);
  assert.ok(MODEL.testFiles.length >= FLOOR.testFiles, `tests/**/*.mjs 只有 ${MODEL.testFiles.length} 个（下界 ${FLOOR.testFiles}）`);
  assert.ok(MODEL.sites.length > 0, '一个 spawn 站点都没解析出来——判据 B 的解析器坏了');
});

test('② 未接线的 tools/*.mjs 必须在白名单里写明理由', () => {
  const listed = new Map(loadBaseline().entries.map((entry) => [entry.path, entry]));
  const unwired = TOOLS.filter((tool) => classify(tool).length === 0);
  const unlisted = unwired.filter((tool) => !listed.has(tool));
  const report = unlisted
    .map((tool) => `  - ${tool}\n    修法：①在某份常跑 workflow 的 run: 里点名它（node ${tool} …）；`
      + `②或在 tests/** 用 spawnSync/execFileSync 在仓库根跑它并断言 .status；`
      + `③确有不接的理由 ⇒ 写进 tests/unit/orphan-tools-wired-baseline.json（path / kind / reason）。`)
    .join('\n');
  assert.equal(
    unlisted.length,
    0,
    `以下 ${unlisted.length} 个 tools 脚本既没被 workflow 的 run: 点名，也没有在真仓上跑它并断言退出码的测试，`
      + `且不在白名单里（只 import / 只夹具 / 无 .status 断言都不算接线）：\n${report}`,
  );
  assert.ok(unwired.length <= TOOLS.length * 0.6, `未接线脚本 ${unwired.length}/${TOOLS.length} 个，超过六成——先确认 workflow 解析没坏`);
});

test('③ 白名单不得过期：已接线的条目必须删掉', () => {
  const stale = loadBaseline().entries
    .map((entry) => ({entry, evidence: classify(entry.path)}))
    .filter((item) => item.evidence.length > 0);
  assert.deepEqual(
    stale.map((item) => `${item.entry.path}（${item.evidence[0]}）`),
    [],
    '白名单里有条目已经被接线了（已过期，删掉它，否则白名单会越养越松）：',
  );
});

test('④ 白名单自身可核：路径 / 类别 / 理由 / host / exercisedBy', () => {
  const {entries} = loadBaseline();
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const problems = [];
  for (const entry of entries) {
    const label = String(entry.path);
    if (!TOOLS.includes(label)) {
      problems.push(`${label}：不是顶层的 tools/*.mjs（写错路径，或脚本已删除/改名）`);
      continue;
    }
    if (!KINDS.has(entry.kind)) {
      problems.push(`${label}：kind=${JSON.stringify(entry.kind)} 不在 ${[...KINDS].join(' / ')} 里`);
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 12) {
      problems.push(`${label}：reason 太短或缺失——白名单要写「为什么不能接」，不是「暂时放着」`);
    }
    if (entry.kind === 'library') {
      if (!TOOLS.includes(String(entry.host))) {
        problems.push(`${label}：library 必须声明 host（承载接线的 tools 脚本），当前 host=${JSON.stringify(entry.host)}`);
      } else {
        const seen = new Set([label]);
        let cursor = entry;
        let wired = false;
        for (let hop = 0; hop < 8 && cursor; hop += 1) {
          if (classify(cursor.host).length > 0) {
            wired = true;
            break;
          }
          if (seen.has(cursor.host)) break;
          seen.add(cursor.host);
          cursor = byPath.get(cursor.host);
        }
        if (!wired) problems.push(`${label}：host ${entry.host} 没接到任何已接线脚本（先接线 host，或改成 gap）`);
      }
    }
    if (entry.kind === 'in-process') {
      const exercisedBy = String(entry.exercisedBy ?? '');
      if (!MODEL.testFiles.includes(exercisedBy)) {
        problems.push(`${label}：in-process 必须声明 exercisedBy=${JSON.stringify(entry.exercisedBy)}，且它是 tests/**/*.mjs`);
      } else if (!runInCi(exercisedBy, MODEL)) {
        problems.push(`${label}：exercisedBy ${exercisedBy} 没有被任何 workflow 的 run: 跑到（含 npm run 转接）——进程内驱动不算「CI 会跑」`);
      }
    }
  }
  assert.deepEqual(problems, [], '白名单条目不合法：');
});

test('⑤ 反向控制：合成文本喂同一批判据函数', () => {
  const tool = 'tools/verify-demo.mjs';

  // a) YAML 注释行里的 run: 不算
  assert.deepEqual(parseWorkflow('      # - run: node tools/verify-demo.mjs').runs, [], 'YAML 注释行不该被解析成 run 步');
  // b) 块标量里的 shell 注释行不算
  const block = ['      - run: |', '          # node tools/verify-demo.mjs', '          node tools/other.mjs'].join('\n');
  const parsed = parseWorkflow(block);
  assert.equal(parsed.runs.length, 1);
  assert.equal(namesPathInCommand(parsed.runs[0].text, tool), false, '块标量里的注释行不该算接线');
  assert.equal(namesPathInCommand(parsed.runs[0].text, 'tools/other.mjs'), true);
  // c) `node --check` 也算点名（语法级，但确实在跑）
  assert.equal(namesPathInCommand('node --check tools/verify-demo.mjs', tool), true);
  // d) 整词才算：前缀相同的另一个脚本不算
  assert.equal(namesPathInCommand('node tools/verify-demo-extra.mjs', tool), false);
  // e) `paths:` 只是触发面，不造 run 步（access-verification.yml:4 就是这种写法）
  const pathsOnly = parseWorkflow('    paths: [tools/verify-demo.mjs]');
  assert.equal(pathsOnly.runs.length, 0, 'paths: 不该造出 run 步');
  assert.equal(pathsOnly.hasPaths, true);

  const rootPrelude = "const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');\n";
  const spawn = (args, options) => `spawnSync(process.execPath, [${args}], {${options}});\nassert.equal(result.status, 0);\n`;
  // f) 仅 import ⇒ 0 个站点（模块级单测不是 B）
  assert.deepEqual(analyzeTestSource(`${rootPrelude}import { main } from '../../tools/verify-demo.mjs';\nmain();\n`, 'tests/unit/synthetic.test.mjs'), []);
  // g) 夹具 spawn ⇒ 站点存在但不算真仓（cwd 指向临时树，脚本还是仓里那份）
  const fixtureSpawn = analyzeTestSource(
    `${rootPrelude}const root = mkdtempSync('x');\n${spawn("join(ROOT, 'tools', 'verify-demo.mjs'), ['--json']", "cwd: root, encoding: 'utf8'")}`,
    'tests/unit/synthetic.test.mjs',
  );
  assert.equal(fixtureSpawn.length, 1);
  assert.equal(fixtureSpawn[0].cwdType, 'fixture');
  assert.equal(isRealRepoRun(fixtureSpawn[0]), false, '夹具树上的 spawn 不算接线');
  // h) `--root` 改指夹具 ⇒ 不算（哪怕 cwd 是仓库根）
  const redirected = analyzeTestSource(
    `${rootPrelude}${spawn("join(ROOT, 'tools', 'verify-demo.mjs'), ['--root', root]", "cwd: ROOT")}`,
    'tests/unit/synthetic.test.mjs',
  );
  assert.equal(redirected.length, 1);
  assert.equal(redirected[0].tools[0], tool);
  assert.equal(isRealRepoRun(redirected[0]), false, '--root 指夹具时不算在真仓跑');
  // i) 真仓 spawn + .status 断言 ⇒ 算 B
  const realRun = analyzeTestSource(
    `${rootPrelude}const TOOL = join(ROOT, 'tools', 'verify-demo.mjs');\n${spawn('TOOL, [\'--check\']', "cwd: ROOT, encoding: 'utf8'")}`,
    'tests/unit/synthetic.test.mjs',
  );
  assert.equal(realRun.length, 1);
  assert.equal(realRun[0].tools[0], tool);
  assert.equal(isRealRepoRun(realRun[0]), true, '真仓 spawn + .status 断言必须被认成接线');
  // j) 真仓 spawn 但没有 .status 断言 ⇒ 不算（工具可以 EXIT 1 而测试全绿）
  const noAssert = analyzeTestSource(
    `${rootPrelude}${spawn("join(ROOT, 'tools', 'verify-demo.mjs'), ['--check']", "cwd: ROOT")}`.replace('assert.equal(result.status, 0);\n', ''),
    'tests/unit/synthetic.test.mjs',
  );
  assert.equal(noAssert.length, 1);
  assert.equal(isRealRepoRun(noAssert[0]), false, '没有退出码断言的 spawn 不算接线');
  // k) 默认参数是仓库根（function gate(args, cwd = ROOT)）也算
  const defaultParam = analyzeTestSource(
    `${rootPrelude}function gate(args, cwd = ROOT) { return spawnSync(process.execPath, [TOOL, ...args], {cwd, encoding: 'utf8'}); }\n`
      + "const TOOL = join(ROOT, 'tools', 'verify-demo.mjs');\nassert.equal(run.status, 0);\n",
    'tests/unit/synthetic.test.mjs',
  );
  assert.equal(defaultParam.length, 1);
  assert.equal(isRealRepoRun(defaultParam[0]), true, 'cwd 默认值是仓库根时必须被认成真仓');
});

test('⑥ gap 台账：登记为「本该接线」的条目逐条打印', (t) => {
  const gaps = loadBaseline().entries.filter((entry) => entry.kind === 'gap');
  for (const entry of gaps) t.diagnostic(`gap ${entry.path} —— ${entry.reason}`);
  t.diagnostic(`gap ${gaps.length} 条：它们是本片（A 档，不改 .github/**）关不掉的真实缺口，不是豁免。`);
});
