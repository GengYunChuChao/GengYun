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
 *     `execFile` / `spawn`）**跑真仓里的这个文件**，且**这一次 spawn 的退出码**被断言——不是「同文件
 *     别处断言过 `.status`」（那是文件级证据，会让同一文件里另一个没断言退出码的 spawn 蹭成接线）。
 *     「跑真仓」的判定：工具路径必须锚在**仓库根解析出的绝对路径**上（`join(ROOT,'tools','x.mjs')`、
 *     `new URL('../tools/x.mjs', import.meta.url)`、或由它们赋值的别名），且 `cwd` 显式指向仓库根、或
 *     未传 `cwd`（继承，`npm run test:unit` 在仓库根）、或是默认参数且默认值就是仓库根；argv 里的裸相对
 *     字面量（`['tools/x.mjs', ...]`）只有在该 spawn 的 `cwd` 已核实为仓库根时才认。`cwd` 是夹具变量、
 *     `--root/--dir/--project/--workspace` 被改指夹具、或工具是从临时树里的**副本**（`cpSync` 后跑副本）
 *     ⇒ 都不算。
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
 *   ⑤ 反向控制：把合成文本喂给同一批判据函数，钉住 20 条边（YAML 注释 run 不算、块标量里的 shell
 *      注释不算、`echo` 之后的路径不算、`node --check` 算、整词才算、`paths:` 不造 run 步、仅 import
 *      ⇒ 0 站点、夹具 cwd 不算、`--root` 改指夹具不算、真仓 spawn + `.status` 算、无 `.status` 断言不算、
 *      默认参数是仓库根算、同文件里只有一站断言 ⇒ 另一站仍不算、cpSync 副本 ⇒ 0 站点、裸相对字面量
 *      有/无 cwd 的两种结果、参数位/重定向目标/`bash -c` 内层/npm 参数位不算执行、`'--root=' + tmp`
 *      拼接算改指、helper 的调用点站（真仓臂算 / 夹具臂不算）、同文件同名 `const result` 不串号）。
 *   ⑥ `gap` 台账：登记为「本该接线」的条目逐条打印（不判红），并打印一份读数（已接线各档 / 白名单
 *      各档）供证据页对账。`gap` 是本片留给后续片的待办清单，不是「已经没问题了」的证明。
 *
 * 白名单里 `gap` 的退场方式：本片新增 `tests/unit/tools-repo-run-smoke.test.mjs`，在仓库根跑
 * `tools/run-python.mjs`（argv 契约）/ `tools/openapi-route-parity.mjs` / `tools/verify-gy-i09-candidates.mjs`
 * 并断言退出码，于是这三条从 `gap` 变成真的 B 类接线，gap 台账清零。
 *
 * 不声称：
 *   * 不声称这些脚本的**判据本身正确**——本闸门只看「有没有人跑它」，不看它判得对不对。
 *   * 不声称 A 的强度足够：`node --check` 只做语法级，本闸门把它与真正执行同等记为「已接线」，
 *     强/弱只落在 `docs/verification/gy-r90-tools-wiring-metagate-20261109.md` 的表格里。
 *   * 不声称 B 的强度足够：判据只要求「这一次 spawn 的退出码被断言」，不要求断言覆盖该工具的全部判定面
 *     （`tests/unit/tools-repo-run-smoke.test.mjs` 里 run-python 只断言了不带参数的 argv 契约）。
 *   * 不声称替代真正的 CI 接线：`gap` 是**已知缺口**，不是豁免；`in-process` / `library` 的宿主接线
 *     也不等于工具本身在 CI 里被独立判定。
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

/** 去掉 shell 行内注释：引号外的 `#`（行首或前面是空白）之后都不算命令。 */
function stripShellComments(text) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      let quote = null;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quote) {
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === "'" || ch === '"') {
          quote = ch;
          continue;
        }
        if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

/** 会「执行后面那个路径」的命令词；`echo` 之类的非执行命令整段都不算接线。 */
const RUNNERS = new Set(['node', 'nodejs', 'npx', 'tsx', 'npm', 'pnpm', 'yarn', 'python', 'python3', 'py',
  'bash', 'sh', 'pwsh', 'powershell', 'cmd', 'env', 'exec', 'time', 'nohup']);
const NON_EXEC = new Set(['echo', 'printf', 'cat', 'ls', 'grep', 'rg', 'head', 'tail', 'sed', 'awk', 'test',
  '[', '[[', 'export', 'set', 'unset', 'cd', 'true', ':', 'which', 'type', 'tee', 'xargs', 'find', 'wc']);

function commandSegments(text) {
  return stripShellComments(text)
    .split(/[\n;]|&&|\|\||\|/)
    .map((segment) => segment.trim())
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

/**
 * 命令文本里是否**执行**了某个仓内路径（P1-4：只认执行位，不认「同段里出现过」）。
 *
 * 判据：切段 → 段首不是 `echo` / `cat` 这类只打印不执行的命令 → 找到该段的**执行脚本位**：
 * - `npm/pnpm/yarn run <script>`：只有 script 名可能算（路径出现在这之后都是参数位）；
 * - 解释器（`node` / `python` / `bash` …）后面跳过 `--flag`，**第一个非 flag 参数**才是被执行脚本；
 * - 段首本身就是可执行脚本（`./tools/x.mjs`、`tools/x.mjs`）时，它自己就是执行位；
 * - shell 的 `-c "…"` 内层字符串再切一次递归判；
 * - `>` / `>>` 之后的重定向目标位不算执行。
 *
 * ⚠️ 降级说明（写进证据页「不声称」）：不做完整 shell 解析。`node --import ./pre.mjs tools/x.mjs`
 * 这种「flag 带值」会被判成**没接线**（宁可低估），而不是放宽成「同段任意 token 都算执行位」。
 */
function namesPathInCommand(text, relPath) {
  const target = toPosix(relPath);
  const matches = (token) => token === target
    || token.endsWith(`/${target}`)
    || (token.includes('*') && globToRegExp(token).test(target));

  for (const segment of commandSegments(text)) {
    const tokens = commandTokens(segment);
    if (tokens.length === 0) continue;
    const head = tokens[0].replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
    if (NON_EXEC.has(tokens[0]) || NON_EXEC.has(head)) continue;

    // `bash -c "node tools/x.mjs"`：内层字符串另切一次再判。
    const inlineAt = tokens.findIndex((token) => token === '-c' || token === '/c' || token === '-Command');
    if (inlineAt >= 0 && ['bash', 'sh', 'pwsh', 'powershell', 'cmd'].includes(head)) {
      const inner = tokens.slice(inlineAt + 1).join(' ');
      if (inner && namesPathInCommand(inner, relPath)) return true;
      continue;
    }

    // `npm run <script>`：路径不会出现在 script 名位置上，后面的一律是参数。
    if (['npm', 'pnpm', 'yarn'].includes(head)) continue;

    const redirectAt = tokens.findIndex((token) => token === '>' || token === '>>' || /^>>?[^\s>]/.test(token));
    const limit = redirectAt === -1 ? tokens.length : redirectAt;

    let scriptAt = -1;
    if (/\.(mjs|cjs|js|py|sh|ps1)$/.test(head) && !RUNNERS.has(head)) {
      scriptAt = 0;
    } else if (RUNNERS.has(head)) {
      for (let i = 1; i < limit; i += 1) {
        if (tokens[i].startsWith('-')) continue;
        scriptAt = i;
        break;
      }
    }
    if (scriptAt < 0 || scriptAt >= limit) continue;
    if (matches(tokens[scriptAt])) return true;
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

/** 从 `from` 读到**本语句**结束：顶层 `;` 或换行（跳过字符串与成对括号）。 */
function readStatementValue(source, from) {
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
    } else if (depth === 0 && (ch === ';' || ch === '\n' || ch === '\r')) {
      break;
    }
    index += 1;
  }
  return source.slice(from, index).trim();
}

/**
 * 把 `resolve(dirname(fileURLToPath(import.meta.url)), '../..')` 这类**位置表达式**按文件位置求值。
 * 求不出来返回 null——**不猜**。这就是 P1-3：`resolve(dirname(...))` 只说明「相对本文件算了个路径」，
 * 不等于「这就是仓库根」；夹具里同样可以写出这种形式，必须真的落点相等才算。
 */
function locationExpressionValue(expression, fileRel) {
  if (!fileRel) return null;
  const match = /^(?:path\.)?(resolve|join)\(\s*(?:path\.)?dirname\(\s*(?:path\.)?fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)([\s\S]*)\)$/
    .exec(String(expression).trim());
  if (!match) return null;
  const base = dirname(join(REPO_ROOT, fileRel));
  const parts = quoteLiterals(match[2]);
  return match[1] === 'resolve' ? resolve(base, ...parts) : join(base, ...parts);
}

/** 仓库根标识符：值必须**求值后恰好等于 REPO_ROOT**（写错层级、指向夹具都不登记）。 */
function repoRootIdents(source, fileRel) {
  const idents = new Set();
  for (const match of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g)) {
    const value = readStatementValue(source, match.index + match[0].length);
    if (locationExpressionValue(value, fileRel) === REPO_ROOT) idents.add(match[1]);
  }
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

/** 某个 tools 模块自己算出来的根（只认 `(REPO_)?ROOT` / `root` 这类名字），求值后必须等于 REPO_ROOT。 */
function moduleRootValue(sourceRel) {
  let text;
  try {
    text = readRepo(sourceRel);
  } catch {
    return null;
  }
  for (const match of text.matchAll(/(?:const|let|var)\s+((?:REPO_)?ROOT|root)\s*=\s*/g)) {
    const value = locationExpressionValue(readStatementValue(text, match.index + match[0].length), sourceRel);
    if (value) return value;
  }
  return null;
}

/**
 * 从 `tools/*.mjs` 里 import 进来的仓库根常量：工具自己按 `fileURLToPath(import.meta.url)` 算过根，
 * 测试直接复用它当 `join()` 的基准（`tests/evaluation/gy-i20-sample-gap-recompute.test.mjs:15` 就是这种写法）。
 * 只认 `REPO_ROOT` / `ROOT` 这两个名字，**并且要核那个模块算出来的根确实等于 REPO_ROOT**（同一把尺子，不白信）。
 */
function importedRootIdents(source, fileRel) {
  const idents = new Set();
  if (!fileRel) return idents;
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']*tools\/[^']+\.mjs)'/g)) {
    const sourceRel = toPosix(relative(REPO_ROOT, resolve(dirname(join(REPO_ROOT, fileRel)), match[2])));
    if (moduleRootValue(sourceRel) !== REPO_ROOT) continue;
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
 * 把一段源码按**顶层逗号**切成参数 / 数组元素（跳过字符串与成对括号）。
 * `spawnSync(process.execPath, [TOOL, '--check'], {cwd: ROOT})` → 2 个参数，第 2 个是数组字面量。
 */
function splitArguments(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (quote) {
      if (ch === '\\') { index += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

/**
 * spawn 调用里**被执行的那个脚本位**（子进程 argv[0]）：`spawnSync(node, [X, …], opts)` → `X`。
 *
 * ⚠️ P1-2：只认 argv[0]，而且必须是「被 spawn 的那个元素本身」。窗口里别处出现
 * `'tools/x.mjs'`（参数位、比较位、`cpSync` 源路径）一律不算——否则
 * `spawnSync(node, [copy, '--compare', 'tools/zzz.mjs'], {cwd: ROOT})` 会把「跑了 tmp 副本」
 * 判成「跑了仓里那份」。解析不出来就判没接线（宁可低估）。
 */
function spawnArgvZero(window) {
  const args = splitArguments(window.replace(/\)\s*$/, ''));
  if (args.length < 2) return null;
  const argv = args[1].trim();
  if (!argv.startsWith('[')) return null;
  const close = argv.lastIndexOf(']');
  if (close < 0) return null;
  const elements = splitArguments(argv.slice(1, close));
  return elements.length > 0 ? elements[0] : null;
}

/** 函数形参名：`function f(a, b = 1)` 与 `const f = (a, b) => …` 两种写法。 */
function functionParams(source, name) {
  const decl = new RegExp(
    `function\\s+${name}\\s*\\(([^)]*)\\)|(?:const|let|var)\\s+${name}\\s*=\\s*(?:\\(([^)]*)\\)|[A-Za-z_$][\\w$]*)\\s*=>`,
  ).exec(source);
  if (!decl) return [];
  return (decl[1] ?? decl[2] ?? '').split(',').map((one) => one.split('=')[0].trim()).filter(Boolean);
}

/** 调用了某个 helper 的所有位置（跳过它的声明本身），带实参列表与调用结束位置。 */
function helperCallSites(source, name) {
  const calls = [];
  for (const match of source.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))) {
    const before = source.slice(Math.max(0, match.index - 16), match.index);
    if (/function\s*$/.test(before)) continue;
    const at = match.index + match[0].length;
    const window = callWindow(source, at);
    calls.push({index: match.index, end: at + window.length, args: splitArguments(window.replace(/\)\s*$/, ''))});
  }
  return calls;
}

/**
 * 解析一个「脚本位表达式」到 `tools/x.mjs`：
 * - 锚在仓库根上的 `join(ROOT,'tools',…)` / `new URL('../tools/…', import.meta.url)` / 别名标识符；
 * - **裸相对字面量** `'tools/x.mjs'` 只有 cwd 已被核实为仓库根时才算（否则可能是夹具里的副本）。
 */
function scriptToolOf(element, cwdType, context, aliases) {
  if (!element) return null;
  const expr = element.trim();
  const bare = /^['"`](tools\/[A-Za-z0-9_.-]+\.mjs)['"`]$/.exec(expr);
  if (bare) return cwdType === 'root' ? bare[1] : null;
  return toolPathOfExpression(expr, context, aliases);
}

/**
 * 断言里被断 `.status` 的标识符 → **断言所在位置**（`assert.equal(r.status, 0)` → r@index）。
 * 带位置是为了做作用域比对（P1-3）：不按名字跨作用域串号。
 */
function statusAssertions(source) {
  const map = new Map();
  for (const match of source.matchAll(/assert\.[A-Za-z_$][\w$]*\s*\(/g)) {
    const window = callWindow(source, match.index + match[0].length);
    for (const inner of window.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*status\b/g)) {
      if (!map.has(inner[1])) map.set(inner[1], []);
      map.get(inner[1]).push(match.index);
    }
  }
  return map;
}

/** `index` 所在的**最内层 `{}` 块**（[开始, 结束]）；不在任何块里时返回整个文件。 */
function enclosingBlock(source, index) {
  const stack = [];
  let quote = null;
  for (let at = 0; at < index; at += 1) {
    const ch = source[at];
    if (quote) {
      if (ch === '\\') { at += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '{') stack.push(at);
    else if (ch === '}') stack.pop();
  }
  if (stack.length === 0) return [0, source.length];
  const start = stack[stack.length - 1];
  let depth = 0;
  quote = null;
  for (let at = start; at < source.length; at += 1) {
    const ch = source[at];
    if (quote) {
      if (ch === '\\') { at += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return [start, at];
    }
  }
  return [start, source.length];
}

/** spawn 调用所在的最内层具名函数（`function gate(...) {}` 或 `const gate = (...) => {}`），没有就 null。 */
function enclosingFunctionName(source, callIndex) {
  const starts = [];
  for (const match of source.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)) {
    starts.push({name: match[1], bodyAt: match.index + match[0].length - 1});
  }
  for (const match of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g)) {
    starts.push({name: match[1], bodyAt: match.index + match[0].length - 1});
  }
  let best = null;
  for (const candidate of starts) {
    if (candidate.bodyAt >= callIndex) continue;
    const body = source.slice(candidate.bodyAt, callIndex);
    let depth = 0;
    for (const ch of body) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    if (depth <= 0) continue; // 该函数体在调用前就闭合了
    if (!best || candidate.bodyAt > best.bodyAt) best = candidate;
  }
  return best ? best.name : null;
}

/** 「谁的返回值是从谁那儿来的」：provider → (接收它返回值的标识符 → 该绑定的位置)。 */
function valueConsumers(source) {
  const map = new Map();
  const add = (provider, consumer, at) => {
    if (!map.has(provider)) map.set(provider, new Map());
    if (!map.get(provider).has(consumer)) map.get(provider).set(consumer, at);
  };
  for (const match of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g)) {
    add(match[2], match[1], match.index);
  }
  for (const match of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    add(match[2], match[1], match.index);
  }
  return map;
}

/**
 * 这次 spawn 的退出码是否被断言：只看**这一个站点**的返回值（P1-1），且断言必须与这条返回值绑定
 * 在**同一个块**里（P1-3：不按标识符名字跨作用域串号）。
 *
 * 反例（审查给的）：test a 里 `const result = spawnSync(...)` 只断言 `.stdout`；test b 里
 * `const result = compute(); assert.equal(result.status, 0)` —— 名字相同，但断言不在 a 的块里，
 * 所以 a 这站必须仍判**未接线**。
 */
function statusAssertForSite(source, callIndex, windowEnd, assertions, consumers) {
  if (/^\s*\.\s*status\b/.test(source.slice(windowEnd))) return true;
  const prefix = source.slice(0, callIndex);
  /** 「这条 spawn 的返回值绑到了哪个标识符、绑在哪条语句」。 */
  const bindings = [];
  const assign = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/.exec(prefix);
  if (assign) bindings.push({ident: assign[1], at: callIndex});
  // 表达式体箭头函数（`const run = (args) => spawnSync(...)`）：provider 是这个箭头自己的名字。
  const arrow = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*$/.exec(prefix);
  if (arrow) bindings.push({ident: arrow[1], at: callIndex});
  const provider = enclosingFunctionName(source, callIndex);
  if (provider) bindings.push({ident: provider, at: callIndex});
  const resolved = [...bindings];
  for (let hop = 0; hop < 4; hop += 1) {
    const batch = [];
    for (const one of resolved) {
      for (const [consumer, at] of consumers.get(one.ident) ?? new Map()) {
        if (!resolved.some((seen) => seen.ident === consumer)) batch.push({ident: consumer, at});
      }
    }
    if (batch.length === 0) break;
    resolved.push(...batch);
  }
  for (const one of resolved) {
    const hits = assertions.get(one.ident) ?? [];
    const [start, end] = enclosingBlock(source, one.at);
    if (hits.some((hit) => hit > start && hit < end)) return true;
  }
  return false;
}

function analyzeTestSource(source, fileRel) {
  const rootIdents = new Set([...repoRootIdents(source, fileRel), ...importedRootIdents(source, fileRel)]);
  const context = {rootIdents, rootParams: rootDefaultParams(source, rootIdents), fileRel};
  const aliases = toolAliases(source, context);
  const assertions = statusAssertions(source);
  const consumers = valueConsumers(source);
  const sites = [];

  /** 窗口里的 cwd：`cwd: X` 或 `{cwd, …}` 简写（只有默认值就是仓库根才算 root）。 */
  const cwdOfWindow = (window) => {
    const assign = /\bcwd\s*:\s*/.exec(window);
    if (assign) {
      const value = readValue(window, assign.index + assign[0].length);
      return isRepoRootExpression(value, context) ? 'root' : 'fixture';
    }
    const shorthand = /[{,]\s*cwd\s*[,}]/.test(window);
    if (shorthand) {
      return context.rootParams.has('cwd') || context.rootIdents.has('cwd') ? 'root' : 'unknown';
    }
    return 'inherit';
  };

  /** `--root` / `--dir` 等被指向夹具 ⇒ 这一站点不是真仓。 */
  const redirectedOf = (text) => {
    for (const flag of ROOT_FLAGS) {
      const spaced = new RegExp(`['"]${flag}['"]\\s*,\\s*`).exec(text);
      if (spaced && !isRepoRootExpression(readValue(text, spaced.index + spaced[0].length), context)) return true;
      const inline = new RegExp(`${flag}=([^\\s'"]+)`).exec(text);
      if (inline && !isRepoRootExpression(`'${inline[1]}'`, context)) return true;
      // `'--root=' + tmp` 这种拼接写法（P2：原来被引号截断，识别不出来）
      const concat = new RegExp(`['"]${flag}=['"]\\s*\\+\\s*([A-Za-z_$][\\w$]*)`).exec(text);
      if (concat && !context.rootIdents.has(concat[1]) && !context.rootParams.has(concat[1])) return true;
    }
    return false;
  };

  const pattern = new RegExp(`\\b(${SPAWN_FNS.join('|')})\\s*\\(`, 'g');
  for (const match of source.matchAll(pattern)) {
    const window = callWindow(source, match.index + match[0].length);
    const windowEnd = match.index + match[0].length + window.length;
    const cwdType = cwdOfWindow(window);
    const redirected = redirectedOf(window);
    const argvZero = spawnArgvZero(window);
    const tool = scriptToolOf(argvZero, cwdType, context, aliases);
    if (tool) {
      sites.push({file: fileRel, line: lineOf(source, match.index), tools: [tool], cwdType, redirected,
        statusAssert: statusAssertForSite(source, match.index, windowEnd, assertions, consumers)});
      continue;
    }
    /**
     * helper 站点（P1-1）：`function runTool(toolPath, args, cwd) { … spawnSync(node, [toolPath, …], {cwd}) }`
     * 这种形态里被跑的脚本是**形参**，真路径与 cwd 在**调用点**的实参里。把站点建到调用点上：
     * 脚本位实参必须是仓库根锚定的 `tools/x.mjs`、cwd 实参必须是仓库根，退出码断言落在该调用点的块里。
     * 这样既认得 `runTool(TOOL, [...], ROOT)` 这种真仓臂，也不会把 `runTool(tree.tool, [...], tree.root)`
     * （夹具副本）算成接线。
     */
    const paramName = argvZero?.trim();
    if (!paramName || !/^[A-Za-z_$][\w$]*$/.test(paramName)) continue;
    const provider = enclosingFunctionName(source, match.index);
    if (!provider) continue;
    const params = functionParams(source, provider);
    const toolParam = params.indexOf(paramName);
    if (toolParam < 0) continue;
    const cwdParam = /\bcwd\b/.test(window) ? params.indexOf('cwd') : -1;
    for (const call of helperCallSites(source, provider)) {
      const callCwd = cwdParam >= 0 && cwdParam < call.args.length
        ? (isRepoRootExpression(call.args[cwdParam], context) ? 'root' : 'fixture')
        : 'inherit';
      const callTool = scriptToolOf(call.args[toolParam], callCwd, context, aliases);
      if (!callTool) continue;
      sites.push({file: fileRel, line: lineOf(source, call.index), tools: [callTool], cwdType: callCwd,
        redirected: redirectedOf(call.args.join(',')),
        statusAssert: statusAssertForSite(source, call.index, call.end, assertions, consumers)});
    }
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
  const spawn = (args, options) => `const result = spawnSync(process.execPath, [${args}], {${options}});
assert.equal(result.status, 0);
`;
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
    `${rootPrelude}function gate(args, cwd = ROOT) { return spawnSync(process.execPath, [TOOL, ...args], {cwd, encoding: 'utf8'}); }
const TOOL = join(ROOT, 'tools', 'verify-demo.mjs');
const run = gate(['--check']);
assert.equal(run.status, 0);
`,
    'tests/unit/synthetic.test.mjs',
  );
  assert.equal(defaultParam.length, 1);
  assert.equal(isRealRepoRun(defaultParam[0]), true, 'cwd 默认值是仓库根时必须被认成真仓');

  // l) 同一文件两个站点，只有一个断言 .status ⇒ 另一个仍必须判未接线（P1-1：断言是站点级的）
  const twoSites = analyzeTestSource(
    `${rootPrelude}const TOOL = join(ROOT, 'tools', 'verify-demo.mjs');
const first = spawnSync(process.execPath, [TOOL, '--check'], {cwd: ROOT, encoding: 'utf8'});
assert.equal(first.status, 0);
const second = spawnSync(process.execPath, [TOOL, '--other'], {cwd: ROOT, encoding: 'utf8'});
`,
    'tests/unit/synthetic.test.mjs',
  );
  assert.equal(twoSites.length, 2);
  assert.equal(twoSites[0].statusAssert, true, '断言了 first.status 的站点应算接线');
  assert.equal(twoSites[1].statusAssert, false, '同文件另一站没有断言 ⇒ 不能蹭前一个站点的 .status');

  // m) 夹具副本：cpSync 到 tmpdir 后 spawn **副本**，cwd 还是仓库根 ⇒ 不算（P1-B 的反例）
  const copiedTool = analyzeTestSource(
    `${rootPrelude}const copy = join(mkdtempSync('x'), 'tools', 'verify-demo.mjs');
cpSync(join(ROOT, 'tools', 'verify-demo.mjs'), copy);
const result = spawnSync(process.execPath, [copy, '--check'], {cwd: ROOT, encoding: 'utf8'});
assert.equal(result.status, 0);
`,
    'tests/unit/synthetic.test.mjs',
  );
  assert.equal(copiedTool.length, 0, 'spawn 的是 tmpdir 里的副本，不能算跑了仓里的脚本');

  // n) argv 里的裸相对字面量：cwd 核实为仓库根时算（`['tools/x.mjs', ...]` 落在仓里那份）；
  //    没有 cwd（继承本进程）时不算——静态上没法证明基准，宁可低估。
  const bareWithRoot = analyzeTestSource(
    `${rootPrelude}const result = spawnSync(process.execPath, ['tools/verify-demo.mjs', '--check'], {cwd: ROOT});
assert.equal(result.status, 0);
`,
    'tests/unit/synthetic.test.mjs',
  );
  assert.equal(bareWithRoot.length, 1, 'cwd 是仓库根 + 裸相对路径 ⇒ 就是仓里那份，应认成接线');
  assert.equal(isRealRepoRun(bareWithRoot[0]), true);
  const bareNoCwd = analyzeTestSource(
    `${rootPrelude}const result = spawnSync(process.execPath, ['tools/verify-demo.mjs', '--check']);
assert.equal(result.status, 0);
`,
    'tests/unit/synthetic.test.mjs',
  );
  assert.equal(bareNoCwd.length, 0, '没有 cwd 时裸相对路径不算——无法静态证明跑的是仓里那份');

  // o) P1-2 反例：spawn 的是 tmp 副本，窗口里**别处**有 'tools/x.mjs' 字面量（参数位 / cpSync 源）
  //    ⇒ 一个站点都不该算出（只看 argv[0]，不看窗口里任意位置）。
  const copyWithLiteralArg = analyzeTestSource(
    `${rootPrelude}const copy = join(mkdtempSync('x'), 'tools', 'verify-demo.mjs');
cpSync(join(ROOT, 'tools', 'verify-demo.mjs'), copy);
const result = spawnSync(process.execPath, [copy, '--compare', 'tools/verify-demo.mjs'], {cwd: ROOT});
assert.equal(result.status, 0);
`,
    'tests/unit/synthetic.test.mjs',
  );
  assert.equal(copyWithLiteralArg.length, 0, '跑的是副本，参数位里的仓内路径不能算接线');
  // p) P1-2 变体：argv[0] 是**另一个**仓内脚本，被检路径出现在参数位（`--compare tools/x.mjs`）⇒ 只算 argv[0] 那个
  const otherThenPath = analyzeTestSource(
    `${rootPrelude}const other = join(ROOT, 'tools', 'verify-other.mjs');
const result = spawnSync(process.execPath, [other, 'tools/verify-demo.mjs'], {cwd: ROOT});
assert.equal(result.status, 0);
`,
    'tests/unit/synthetic.test.mjs',
  );
  assert.equal(otherThenPath.length, 1, '一次 spawn 只有一个被执行对象（argv[0]）');
  assert.equal(otherThenPath[0].tools[0], 'tools/verify-other.mjs', '参数位里的 tools 路径不算接线');
  assert.equal(isRealRepoRun(otherThenPath[0]), true);

  // q) P1-3 反例：同文件两个 `result`，只断言后一个（前者只断言 .stdout）⇒ 前者必须仍判未接线
  const shadowed = analyzeTestSource(
    `${rootPrelude}const TOOL = join(ROOT, 'tools', 'verify-demo.mjs');
test('a', () => {
  const result = spawnSync(process.execPath, [TOOL, '--check'], {cwd: ROOT, encoding: 'utf8'});
  assert.equal(result.stdout, '');
});
test('b', () => {
  const result = compute();
  assert.equal(result.status, 0);
});
`,
    'tests/unit/synthetic.test.mjs',
  );
  assert.equal(shadowed.length, 1);
  assert.equal(shadowed[0].statusAssert, false, '同名的 result 在别的块里被断言，不能算这一站的证据');

  // r) P1-4：只有执行位算，参数位 / 重定向目标 / bash -c 内层 / npm 参数位都不算
  assert.equal(namesPathInCommand('node tools/build.mjs --target tools/verify-demo.mjs', tool), false, '参数位不算执行');
  assert.equal(namesPathInCommand('node tools/gen.mjs > tools/verify-demo.mjs', tool), false, '重定向目标位不算执行');
  assert.equal(namesPathInCommand('npm run test:unit -- tools/verify-demo.mjs', tool), false, 'npm 的 script 名之后是参数位');
  assert.equal(namesPathInCommand('bash -c "node tools/build.mjs tools/verify-demo.mjs"', tool), false, 'bash -c 内层还是参数位');
  assert.equal(namesPathInCommand('bash -c "node tools/verify-demo.mjs"', tool), true, 'bash -c 内层真在执行时必须认出来');

  // s) P1-1 helper 站点：脚本位是形参时，站点建到**调用点**上（真仓臂算，夹具臂不算）
  const helperPrelude = `${rootPrelude}const TOOL = join(ROOT, 'tools', 'verify-demo.mjs');
function runTool(toolPath, args, cwd) {
  const result = spawnSync(process.execPath, [toolPath, ...args], {cwd, encoding: 'utf8'});
  return {status: result.status, stdout: result.stdout ?? ''};
}
`;
  const helperReal = analyzeTestSource(
    `${helperPrelude}const result = runTool(TOOL, ['--check'], ROOT);
assert.equal(result.status, 0);
`,
    'tests/unit/synthetic.test.mjs',
  );
  assert.equal(helperReal.length, 1, 'helper 的真仓调用点必须被认成一个站点');
  assert.equal(helperReal[0].tools[0], tool);
  assert.equal(isRealRepoRun(helperReal[0]), true, 'helper 真仓臂 + .status 断言 ⇒ 算 B（i22 证据表生成器就是这种形状）');
  const helperFixture = analyzeTestSource(
    `${helperPrelude}const tree = {tool: join(mkdtempSync('x'), 'tools', 'verify-demo.mjs'), root: mkdtempSync('y')};
const result = runTool(tree.tool, ['--check'], tree.root);
assert.equal(result.status, 0);
`,
    'tests/unit/synthetic.test.mjs',
  );
  assert.equal(helperFixture.filter(isRealRepoRun).length, 0, 'helper 调用点传的是夹具副本/夹具根 ⇒ 不算接线');

  // t) P2：`'--root=' + tmp` 拼接也要算改指夹具（正则曾在引号处截断）
  const concatRedirect = analyzeTestSource(
    `${rootPrelude}const tmp = mkdtempSync('x');
const result = spawnSync(process.execPath, [join(ROOT, 'tools', 'verify-demo.mjs'), '--root=' + tmp], {cwd: ROOT});
assert.equal(result.status, 0);
`,
    'tests/unit/synthetic.test.mjs',
  );
  assert.equal(concatRedirect.length, 1);
  assert.equal(isRealRepoRun(concatRedirect[0]), false, "`'--root=' + tmp` 这种拼接也必须被识别成改指夹具");
});

test('⑥ gap 台账：登记为「本该接线」的条目逐条打印', (t) => {
  const entries = loadBaseline().entries;
  const gaps = entries.filter((entry) => entry.kind === 'gap');
  for (const entry of gaps) t.diagnostic(`gap ${entry.path} —— ${entry.reason}`);
  t.diagnostic(`gap ${gaps.length} 条：它们是本片（A 档，不改 .github/**）关不掉的真实缺口，不是豁免。`);

  // 读数（给人对账用，不参与判定）：A 直连 / A 经 npm script / B 测试在真仓跑 / 白名单四档。
  const wired = TOOLS.filter((tool) => classify(tool).length > 0);
  const bucket = {a1: 0, a2: 0, b: 0};
  for (const tool of wired) {
    const evidence = classify(tool);
    if (evidence.some((line) => line.includes('run: 点名'))) bucket.a1 += 1;
    else if (evidence.some((line) => line.includes('npm run '))) bucket.a2 += 1;
    else bucket.b += 1;
  }
  const byKind = entries.reduce((acc, entry) => ({...acc, [entry.kind]: (acc[entry.kind] ?? 0) + 1}), {});
  t.diagnostic(`读数：tools ${TOOLS.length} 个 = 已接线 ${wired.length}（A 直连 ${bucket.a1} / A 经 npm script ${bucket.a2} / B 真仓 spawn ${bucket.b}）`
    + ` + 白名单 ${entries.length}（library ${byKind.library ?? 0} / in-process ${byKind['in-process'] ?? 0}`
    + ` / by-design ${byKind['by-design'] ?? 0} / gap ${byKind.gap ?? 0}）`);
});
