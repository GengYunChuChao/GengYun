/**
 * 文档手写行号闸门：`docs/**` 里写成 `services/api/src/xxx.ts:17-30` 的引用，代码一动就变成假证据。
 *
 * 这个工具只判**能被机械证伪**的五件事，判不了的一律如实记「不可解析」，不冒充通过：
 *   BROKEN       —— 引用里的路径在仓库里找不到（也没法唯一解析）。
 *   OUT_OF_RANGE —— 路径找到了，但 `起-止` 超出该文件的行数。
 *   SUSPECT      —— 行号合法，可整个区间里没有一行实质内容（全空行／全右括号／全注释）。
 *   NOT_SYMBOL_LINE —— 「符号引脚」没落在符号行上：目标行在注释里，而这段注释**紧贴声明行**
 *                   （即该声明的文档注释），文档行又没有逐字引用这段注释里的文字。
 *                   这就是一次真实事故的假绿通道——上方插入约 30 行后，`:123` 从真声明行漂到
 *                   `fetchAccountsPage` 的 JSDoc 中间（甚至漂到块注释收尾行 ` *&#47;`），三判据照样全绿。
 *                   **只对 `docs/architecture/**` 且目标为源码后缀判**，判据边界见 `NOT_SYMBOL_LINE` 上方注释。
 *   ANCHOR_DRIFT —— 引用行里同一行的行内代码片段（`` `...` ``）在目标文件里 0 命中／多处命中，
 *                   或只命中在引用窗口之外：行号还在界内，指的却已经不是那段代码。
 *                   **只对 `docs/architecture/**` 判**，判据边界见 `ANCHOR_DRIFT` 常量上方的注释。
 *   COMMENT_ANCHOR（仅 `--symbol=strict`）—— 作用域内、目标是源码，但锚点**没有落在代码行上**：
 *                   `注释但非文档注释`（引用的是注释块，目标文件里没有对应的声明行可指）＋
 *                   `逐字引用注释文案`（文档逐字引注释原文，同上没有代码行可指）。
 *                   这两档原先只进 `SYMBOL-LINE` 读数、谁都不判；`--symbol=strict` 把它们并入
 *                   基线／新增加陈旧这套既有语义（基线见 `tools/doc-anchors-symbol-baseline.json`）。
 *                   `落在文档注释里` 那一档**保持原样**（仍由 `NOT_SYMBOL_LINE` ＋ 结构基线判）。
 *
 * 为什么**不**用「内容 sha256 全等」当判据：任何合法改代码（加一行日志、改一个错别字）都会让
 * 哈希变红，红的原因与「文档是不是假证据」无关，等于用噪声换掉原有的真信号，最后只能整片关掉。
 * 本工具判的是**结构性**事实（路径在不在、行号在不在文件里、区间里有没有东西、符号引脚落没落在
 * 符号行上），这些事实只在「文档确实指错了地方」时才变红。内容是否仍然描述同一段实现，属人工判断，
 * 本工具不证明（见 docs/verification/gy-r31-doc-anchors-20261022.md）。
 *
 * 基线：仓内既有文档本来就有历史遗留的行号漂移，全量清零不是本片能做的事。已知问题登记在
 * `tools/doc-anchors-baseline.json`（受版本控制，每条含 path / reason / owner / reference），
 * `--strict` 只报「基线之外新增的」，因此不会因为历史债把门禁钉成永红；反过来，某条基线
 * 修好之后它就「陈旧」了——`tests/unit/doc-anchors-guard.test.mjs` 会点名要求删掉，不让基线悄悄变成免罚名单。
 *
 * 用法：
 *   node tools/verify-doc-anchors.mjs                      # dry-run：全量清单 + 三类计数
 *   node tools/verify-doc-anchors.mjs --strict             # 基线之外有新增才 exit 1
 *   node tools/verify-doc-anchors.mjs --scan docs/reference --scan 'docs/features/**\/*.md'
 *   node tools/verify-doc-anchors.mjs --emit-baseline      # 打印基线 JSON（不写盘）
 *   node tools/verify-doc-anchors.mjs --write-baseline     # 写 tools/doc-anchors-baseline.json
 *   node tools/verify-doc-anchors.mjs --emit-orphan-baseline  # 打印裸锚点孤儿册 JSON（不写盘）
 *   node tools/verify-doc-anchors.mjs --write-orphan-baseline --accept=<新增条数> --why="<理由>"
 *                                                          # 写 tools/doc-anchors-orphan-baseline.json
 *                                                          # （CI 里拒绝执行；理由落进 accept 账本）
 *   node tools/verify-doc-anchors.mjs --write-anchor-count-baseline --accept=<净增减> --why="<理由>"
 *                                                          # 写 tools/doc-anchors-anchor-count-baseline.json
 *   node tools/verify-doc-anchors.mjs --root <目录>        # 指向夹具树（单测用）
 *   node tools/verify-doc-anchors.mjs --symbol=count       # 符号关联统计（只统计，不参与退出码）
 *   node tools/verify-doc-anchors.mjs --strict --symbol=strict
 *                                                          # 作用域内锚点必须落在代码行上：
 *                                                          # 未落代码行的走符号基线，基线外新增在
 *                                                          # `--strict` 下 exit 1（CI 用的就是这条）
 *
 * 裸锚点（只写 `:1316`／`:1341-1350`）：路径从**同块**（同一段落／列表项／表格单元格／代码块）
 * 内最近的显式锚点继承，链接 `[:321](path)` 直接从 href 取；继承到的锚点与显式锚点**同权**——
 * 越界、区间无实质内容、符号落点、`--strict` 汇总都算它，所以把 `path:130` 删成 `:130` 不会洗白。
 * 归属失败（同块没有显式锚点、或同块显式锚点指向不同文件）的裸锚点进 `BARE_ORPHAN`：单条不判红
 * （猜路径比漏判更坏），但**逐条登记在册**——`tools/doc-anchors-orphan-baseline.json`，键为
 * `文档|原文|原因`（键里没有行号，插行不会刷出成批假增删）。`--strict` 下「基线之外的新增孤儿」**与
 * 「册上已不再命中的陈旧条目」都判红**：新增要点名补回路径或登记，陈旧要点名删行——删条目换绿不成立。
 * 同一份册子还登记「作用域外、按同口径本会红」的继承锚点（键 `文档|引用|判据`），以免
 * `docs/verification/**` 成为无人复核的免检区。写盘必须 `--accept=<实际新增条数>` ＋ `--why="<理由>"`
 * （理由落进 `accept` 账本），且 CI 环境里拒绝写模式。
 * 另有一份**锚点清册** `tools/doc-anchors-anchor-count-baseline.json`：按文档登记「进判据的锚点条数」，
 * 某文档计数下降即判红——它管的是「该出现的锚点是否还在」，因为四类结构判据只审**已经出现**的锚点，
 * 把一条锚点整句改写成散文（「见第 4 行」）本来能让它无声离开判据面。
 * 清册里「没扫到」分四桶，只有最后一桶算合法跳过：①键根本不是可扫的 `.md`（非 `.md` 路径、目录名、
 * `walkMarkdown` 跳过的目录）②键在**本次运行面**内却扫不到 ③两张面都不在（改名成 `README.md` 这类面外文档）
 * ——①②③都判红；④可扫的文档、在清册记下的生成面内、但不在本次面内（默认面 vs `--scan docs` 的日常）才跳过。
 * 运行面**认 glob**（与 `--scan` 共用同一个 `globToRegExp`），所以把 CI 那一行换成 `--scan 'docs/**\/*.md'`
 * 关不掉这一闸。清册还带 `documents_digest`（FNV-1a 64 位，只覆盖这张表自己的数字）：把某文档条数、
 * `judged_total`、accept 账本末条三处一起改齐，求和与账本都自洽，但仍会被摘要抓住——摘要只由写模式重算。
 * 注意：这两道都只是**留痕**，不是「不可能放弃判据」——孤儿册与清册都是可登记的白名单，区别只在于
 * 每次放宽都必须带条数与理由、并出现在 diff 里。
 * 继承锚点的判红作用域与 `SYMBOL_LINE_SCOPE` 同口径（`docs/architecture/**`），历史取证页只计数。
 *
 * 两种扫描口径的数字**不可互换**：`npm run verify:anchors` 走默认 `docs/architecture` + `docs/verification`；
 * `--scan docs` 还多扫 `docs/` 下其余页面（README、development-progress、evaluation 等）。
 * 引用 `BARE`／`BARE-SCOPE`／`BARE-ORPHAN`／`ANCHOR-COUNT` 读数前，先确认命令用的是哪一种。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { associateSymbol, declarationBlocks, scanComments, symbolLineVerdict } from './lib/anchor-resolve.mjs';

export const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 默认扫描面：架构文档 + 证据页。用 `--scan` 可加，不改这里也能扩。 */
export const DEFAULT_SCAN_TARGETS = Object.freeze(['docs/architecture', 'docs/verification']);
export const DEFAULT_BASELINE = 'tools/doc-anchors-baseline.json';
/**
 * 裸锚点孤儿册：`BARE_ORPHAN` 逐条登记在这里（键 `文档|原文|原因`），另有 `outsideRed`
 * 数组登记「作用域外、按同口径本会红」的继承锚点（键 `文档|引用|判据`）。
 *
 * 键里**故意不带文档行号**：带行号的话，在页面顶部插一行空行就会让整页的键同时错位，一次刷出成批的
 * 「新增 + 陈旧」噪声，真正的增删反而看不见。同一个裸锚点在一页里出现多次由「重数法」承担。
 *
 * 为什么必须落成文件：孤儿不判红，若每次现算，删掉路径前缀就等于让一条锚点退出全部判据而**不留痕迹**——
 * PR diff 里看不到增减，评审无从复核。落成册之后，这条路要么被同块继承抓住（该红照红），要么在册子上
 * 留下一行增删。写盘必须带 `--accept=<实际新增条数>` 与 `--why="<理由>"`，这句理由会落进册子的
 * `accept` 账本（追加式），并且 CI 环境里拒绝写模式——生成基线是**人工裁决**，不是门禁的一部分。
 */
export const DEFAULT_ORPHAN_BASELINE = 'tools/doc-anchors-orphan-baseline.json';
/**
 * 锚点清册：按**文档**登记「进判据的锚点条数」，`--strict` 下某文档计数下降即判红。
 *
 * 为什么还需要它：孤儿册只管「归不到路径的裸锚点」，`BROKEN／OUT_OF_RANGE／SUSPECT／NOT_SYMBOL_LINE`
 * 四类判据都只审**出现了的锚点**——把 `services/api/src/app.ts:4` 整条改写成「第 4 行」，那条锚点就
 * 干净地离开判据面，什么都不会红。清册把「该出现的锚点仍在」也变成判据：少一条就得登记，或者把路径写回来。
 */
export const DEFAULT_ANCHOR_COUNT_BASELINE = 'tools/doc-anchors-anchor-count-baseline.json';
export const BROKEN = 'BROKEN';
export const OUT_OF_RANGE = 'OUT_OF_RANGE';
export const SUSPECT = 'SUSPECT';
export const NOT_SYMBOL_LINE = 'NOT_SYMBOL_LINE';
export const REASONS = Object.freeze([BROKEN, OUT_OF_RANGE, SUSPECT, NOT_SYMBOL_LINE]);

/**
 * 符号行判据的作用域：只判**在用的实现说明**（架构页），与 `ANCHOR_DRIFT` 同一理由——
 * `docs/verification/**` 是某一版树的历史读数，行号按当时的树写、正文也声明了基线，
 * 要求它们「落在当前树的符号行上」等于逼历史证据跟着代码一起改写，正好毁掉证据的价值。
 * 作用域外同形状的引用只统计（`SYMBOL-LINE` 读数的「作用域外」那一格），不判红。
 */
export const SYMBOL_LINE_SCOPE = 'docs/architecture/';

/**
 * 套「符号行」口径的目标后缀：只有源码才有可识别的声明行（`export` / `function` / `class` /
 * `interface` / `type` / `enum` / `CONSTANT =` …）。JSON/SQL/MD/YML 不套——裁定 ④ 不强制它们
 * 长出「函数符号」，SQL 的 `CREATE TABLE`、MD 的标题是另一套语义，硬套只会造出无从修的红。
 * 清单定义在文件后半段（与 `--symbol=count` 共用一份，见 `SYMBOL_SOURCE_EXTENSIONS`）。
 */

/** 只认这些扩展名：`10.20.0.0:16` 这类 IP／端口不会被误当成「路径:行号」。 */
const ANCHOR_EXTENSIONS = Object.freeze([
  'mjs', 'cjs', 'js', 'jsx', 'ts', 'tsx', 'json', 'jsonc', 'sql',
  'md', 'yml', 'yaml', 'css', 'html', 'py', 'sh', 'ps1', 'toml',
]);
const ANCHOR_PATTERN = new RegExp(
  `(?<![\\w.\\-/])((?:[\\w.\\-]+/)*[\\w.\\-]+\\.(?:${ANCHOR_EXTENSIONS.join('|')})):(\\d+)(?:-(\\d+))?(?!\\d)`,
  'g',
);
/**
 * 裸锚点：只写 `:1316`／`:1341-1350`、路径靠上下文继承的写法。
 *
 * 为什么必须认它：`ANCHOR_PATTERN` 要求锚点自带「文件名.扩展名」，于是「见 `services/api/src/app.ts:1316-1330`…
 * 同文件 `:1341`」里的那个裸 `:1341` 根本不在扫描面里——把 `path:130` 删成 `:130` 就能让任何锚点绕过全部判据
 * 与基线，是一条通用后门。裸锚点因此要**先归属、再与显式锚点同权**：继承到的锚点照样进
 * `BROKEN`／`OUT_OF_RANGE`／`SUSPECT`／`NOT_SYMBOL_LINE` 与 `--strict` 的失败汇总。
 *
 * 前置字符里额外排除 `:`——`tests/integration/x.mjs::3)` 这种「`::` 后的场景号」不是行号。
 */
const BARE_ANCHOR_PATTERN = /(?<![\w.\-/:]):(\d+)(?:-(\d+))?(?!\d)/g;
/** 链接把路径藏在 href 里时的写法：`[:321](../../services/api/src/privacy/x.ts)`。 */
const LINK_ANCHOR_PATTERN = /\[\s*:(\d+)(?:-(\d+))?\s*\]\(\s*<?([^)\s>]+)>?\s*\)/g;

/**
 * 裸锚点「无主」桶：同块内没有可继承的显式锚点，或同块显式锚点指向不同文件因而无法唯一归属。
 * 这类锚点**单条不判红**（猜路径比漏判更坏），但每条都进 `tools/doc-anchors-orphan-baseline.json`：
 * `--strict` 只报基线之外的新增、并对已消失的基线条目点名要求删——所以「删掉路径前缀」不会静默消失，
 * 它会以孤儿册上的一行增删留在 diff 里。
 */
export const BARE_ORPHAN = 'BARE_ORPHAN';
/**
 * 继承锚点参与判红的作用域：与 `SYMBOL_LINE_SCOPE`／`ANCHOR_DRIFT_SCOPE` 同一口径。
 * `docs/verification/**` 是某一版树的历史取证页（行号按当时的树写、正文也声明了基线），把裸锚点按今天的树判红
 * 等于逼历史证据跟着代码一起改写，正好毁掉证据的价值；作用域外只计数（`BARE-SCOPE` 那一行）。
 */
export const BARE_ANCHOR_SCOPE = 'docs/architecture/';

/** 遍历仓库建「同名文件」索引时跳过的目录：依赖与产物不是文档该引用的源码证据。 */
const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', '.pnpm-store', 'dist', 'coverage', '.pg17', '.pgdata',
  '.venv', '__pycache__', '.next', '.cache', '.turbo',
]);

// —— 区间内容判据：一行算不算「实质内容」 ——————————————————————————————
// 各家注释标记分开认，否则 markdown 的 `# 标题` 会被当成 python 注释，证据页之间的行号引用全变 SUSPECT。
const COMMENT_PREFIXES = Object.freeze({
  js: ['//', '/*', '*', '*/'],
  sql: ['--'],
  hash: ['#'],
  md: ['<!--', '-->'],
});
const CLOSING_ONLY = /^[}\]\)]+[;,)]*$/;
const JS_LIKE = new Set(['mjs', 'cjs', 'js', 'jsx', 'ts', 'tsx', 'json', 'jsonc', 'css']);
const HASH_LIKE = new Set(['py', 'sh', 'ps1', 'yml', 'yaml', 'toml']);

/** 一份文本的逻辑行（末尾换行不算「多一行」，否则每个文件都白送一条可越界行）。 */
export function splitLines(text) {
  const lines = text.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

function commentPrefixesOf(extension) {
  if (JS_LIKE.has(extension)) return COMMENT_PREFIXES.js;
  if (HASH_LIKE.has(extension)) return COMMENT_PREFIXES.hash;
  if (extension === 'sql') return COMMENT_PREFIXES.sql;
  if (extension === 'md') return COMMENT_PREFIXES.md;
  return [];
}

/**
 * 实质内容行 = 非空、且不是**纯收尾括号**（`}` / `});` / `];` / `},` 这类）。
 * 与 `tools/verify-contract-status.mjs` 的 `isSubstantiveLine` 同源（那边的 CLOSING_LINE 规则），
 * 一处口径两处用，免得同一个仓库里对「有没有内容」有两种答案。
 *
 * 刻意**不**把注释行算作「无内容」：引用一段判据注释是合法证据形态（例如证据页引用
 * `.github/workflows/*.yml` 里说明不变量的注释），把它判 SUSPECT 只会把 300 多条写对了地方的
 * 引用打成噪声，淹掉真正「指到空白/收尾括号」的假引用。纯注释区间单独计数（只计不判红）。
 */
export function isSubstantiveLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  return !CLOSING_ONLY.test(trimmed);
}

/** 注释行（按目标语言认标记：markdown 的 `#` 是标题不是注释，所以必须分语言）。 */
export function isCommentLine(line, extension) {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  return commentPrefixesOf(extension).some(prefix => trimmed.startsWith(prefix));
}

function extensionOf(path) {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  return match === null ? '' : match[1].toLowerCase();
}

function isRegularFile(absolute) {
  try {
    return statSync(absolute).isFile();
  } catch {
    return false;
  }
}

function toPosix(path) {
  return path.split(sep).join('/');
}

// —— 扫描面 ——————————————————————————————————————————————————————————
/** `docs/architecture` 这类目录（递归 .md）或 `docs/features/**\/*.md` 这类 glob → 相对路径列表。 */
export function globToRegExp(pattern) {
  const escaped = toPosix(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\*\*\/?/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*');
  return new RegExp(`^${body}$`);
}

function walkMarkdown(absoluteDirectory, root) {
  const results = [];
  const stack = [absoluteDirectory];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) stack.push(absolute);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(toPosix(relative(root, absolute)));
      }
    }
  }
  return results;
}

/** 把 `--scan` 的若干目标（目录或 glob）展开成文档相对路径清单，去重排序。 */
export function resolveScanTargets(root, targets = DEFAULT_SCAN_TARGETS) {
  const collected = new Set();
  for (const target of targets) {
    const normalized = toPosix(target).replace(/^\.\//, '').replace(/\/$/, '');
    if (!normalized.includes('*')) {
      const absolute = resolve(root, normalized);
      if (!existsSync(absolute)) {
        throw new Error(`扫描目标不存在：${normalized}（相对扫描根 ${root}）`);
      }
      if (isRegularFile(absolute)) collected.add(toPosix(relative(root, absolute)));
      else for (const file of walkMarkdown(absolute, root)) collected.add(file);
      continue;
    }
    const pattern = globToRegExp(normalized);
    const base = normalized.split('/')[0];
    for (const file of walkMarkdown(resolve(root, base), root)) {
      if (pattern.test(file)) collected.add(file);
    }
  }
  return [...collected].sort();
}

// —— 引用抽取 ——————————————————————————————————————————————————————————
/**
 * 从一份文档里抽出所有 `路径:起-止` 与 `路径:单行`。
 * 返回 `{ reference, raw, target, from, to }`；`to` 单行引用时等于 `from`。
 */
export function extractReferences(text) {
  const lines = text.split('\n');
  const references = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    ANCHOR_PATTERN.lastIndex = 0;
    let match = ANCHOR_PATTERN.exec(line);
    while (match !== null) {
      const prefix = line.slice(Math.max(0, match.index - 3), match.index);
      // URL（`https://host/a.ts:12`）不是仓内路径；`://` 之后的东西一律不认。
      if (!prefix.includes('://')) {
        const raw = match[0];
        const from = Number(match[2]);
        const to = match[3] === undefined ? from : Number(match[3]);
        references.push({
          raw,
          reference: raw.replace(/^\.\//, ''),
          target: match[1].replace(/^\.\//, ''),
          from,
          to,
          docLine: index + 1,
        });
      }
      match = ANCHOR_PATTERN.exec(line);
    }
  }
  return references;
}

// —— 块切分与裸锚点归属 ————————————————————————————————————————————————
// 「同块」= 同一段落／同一列表项／同一表格单元格／同一代码块；空行、标题行、列表项边界、表格行各自断开。
// 表格行**按单元格**再断一次：同一行不同列是不同证据位（一行里写着「旧文件:35」与「新文件 `:79`」时，
// 把 `:79` 归给左列的路径就是错案，实测确有此类跨列误归）。
const HEADING_LINE = /^#{1,6}\s/;
const LIST_ITEM_LINE = /^\s*(?:[-*+]|\d+[.)])\s/;
const TABLE_ROW_LINE = /^\s*\|/;
const QUOTE_LINE = /^\s*>/;
const FENCE_LINE = /^\s*(?:```|~~~)/;
const CLOSING_FENCE_LINE = /^\s*(?:```+|~~~+)\s*$/;

/** 表格行里，第 `offset` 个字符落在第几个单元格（`\|` 是转义竖线，不算分隔）。 */
function cellIndexAt(line, offset) {
  let cell = 0;
  for (let index = 0; index < offset && index < line.length; index += 1) {
    if (line[index] === '|' && line[index - 1] !== '\\') cell += 1;
  }
  return cell;
}

/**
 * 把一份文档切成块，返回 `{ blockOf, blocks }`：`blockOf[行号]` = 块序号（1 起），空行为 -1。
 * 切分口径（裸锚点继承只认「同块」）：空行断开；标题行自成一块且断开；表格行一行一块（再按单元格细分）；
 * 列表项一项一块（续行归该项）；引用块连续成块；围栏代码块整块一块（块内空行不切断）。
 */
export function segmentDocumentBlocks(lines) {
  const blockOf = new Array(lines.length + 1).fill(-1);
  const blocks = [];
  let current = null;
  let fence = null;
  const open = (lineNumber, kind) => {
    current = { index: blocks.length, kind, startLine: lineNumber, endLine: lineNumber };
    blocks.push(current);
    blockOf[lineNumber] = current.index;
  };
  const extend = lineNumber => {
    current.endLine = lineNumber;
    blockOf[lineNumber] = current.index;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    const trimmed = line.trim();
    if (fence !== null) {
      extend(lineNumber);
      if (CLOSING_FENCE_LINE.test(line) && trimmed.startsWith(fence)) fence = null;
      continue;
    }
    if (trimmed === '') { current = null; continue; }
    if (FENCE_LINE.test(line)) { open(lineNumber, 'code'); fence = trimmed.slice(0, 3); continue; }
    if (HEADING_LINE.test(line)) { open(lineNumber, 'heading'); current = null; continue; }
    if (TABLE_ROW_LINE.test(line)) { open(lineNumber, 'table'); current = null; continue; }
    if (LIST_ITEM_LINE.test(line)) { open(lineNumber, 'list-item'); continue; }
    if (QUOTE_LINE.test(line) && (current === null || current.kind !== 'quote')) { open(lineNumber, 'quote'); continue; }
    if (current === null || current.kind === 'heading' || current.kind === 'table') { open(lineNumber, 'paragraph'); continue; }
    extend(lineNumber);
  }
  return { blockOf, blocks };
}

/** 裸锚点是否在「参与判红」的作用域内（`docs/architecture/**`），口径见 `BARE_ANCHOR_SCOPE`。 */
export function isBareAnchorScope(docPath) {
  return toPosix(docPath).startsWith(BARE_ANCHOR_SCOPE);
}

const canonicalAnchor = (target, from, to) => (
  to === from ? `${target}:${from}` : `${target}:${from}-${to}`
);

/**
 * 给裸锚点找归属：① 链接 href（`[:321](../../path.ts)`）优先；② 否则继承**同块内最近**的显式锚点路径。
 * 同块显式锚点路径不一致而裸锚点无法唯一归属 ⇒ 进 `orphans`（不猜）；同块没有显式锚点 ⇒ 也进 `orphans`。
 *
 * `resolveIdentity(reference)` 用来判断「同块的两个显式锚点是不是同一份文件」（`app.ts:495` 与
 * `services/api/src/app.ts:100` 是同一份）——解析归调用方，本函数不碰文件系统。
 * 返回的继承项形状与 `extractReferences` 一致，另加 `bare`／`inheritedFrom`／`via`；`reference` 已规范化成
 * `路径:起-止`，所以它与同一条显式锚点共用同一套去重键、符号基线与失效判据（继承后同权）。
 */
export function attributeBareAnchors({ text, references, resolveIdentity = null }) {
  const lines = text.split('\n');
  const { blockOf, blocks } = segmentDocumentBlocks(lines);
  const identityOf = resolveIdentity ?? (reference => reference.reference);
  const links = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    LINK_ANCHOR_PATTERN.lastIndex = 0;
    let link = LINK_ANCHOR_PATTERN.exec(lines[index]);
    while (link !== null) {
      const href = link[3].replace(/[#?].*$/, '');
      if (!href.includes('://')) {
        const from = Number(link[1]);
        const to = link[2] === undefined ? from : Number(link[2]);
        links.set(`${index + 1}|${from}|${to}`, { target: href.replace(/^\.\//, ''), rawLink: link[0] });
      }
      link = LINK_ANCHOR_PATTERN.exec(lines[index]);
    }
  }
  const explicit = references.map(reference => {
    const line = lines[reference.docLine - 1] ?? '';
    const column = Math.max(0, line.indexOf(reference.raw));
    return {
      reference,
      column,
      cell: TABLE_ROW_LINE.test(line) ? cellIndexAt(line, column) : -1,
      identity: identityOf(reference),
    };
  });
  const inherited = [];
  const orphans = [];
  for (let index = 0; index < lines.length; index += 1) {
    const docLine = index + 1;
    const line = lines[index];
    if (line.trim() === '') continue;
    const inTable = TABLE_ROW_LINE.test(line);
    BARE_ANCHOR_PATTERN.lastIndex = 0;
    let match = BARE_ANCHOR_PATTERN.exec(line);
    while (match !== null) {
      const column = match.index;
      const from = Number(match[1]);
      const to = match[2] === undefined ? from : Number(match[2]);
      const raw = match[0];
      const link = links.get(`${docLine}|${from}|${to}`);
      if (link !== undefined) {
        inherited.push({
          raw,
          reference: canonicalAnchor(link.target, from, to),
          target: link.target,
          from,
          to,
          docLine,
          bare: true,
          via: 'link',
          inheritedFrom: { reference: link.rawLink, docLine },
        });
      } else {
        const block = blockOf[docLine];
        const cell = inTable ? cellIndexAt(line, column) : -1;
        const around = block < 0 ? [] : explicit.filter(item => (
          blockOf[item.reference.docLine] === block
          && item.cell === cell
          && (item.reference.docLine < docLine || (item.reference.docLine === docLine && item.column < column))
        ));
        if (around.length === 0) {
          orphans.push({ docLine, raw, from, to, reason: 'no-explicit-in-block', text: line });
        } else {
          const nearest = around[around.length - 1];
          if (around.some(item => item.identity !== nearest.identity)) {
            orphans.push({
              docLine,
              raw,
              from,
              to,
              reason: 'ambiguous-block',
              text: line,
              candidates: [...new Set(around.map(item => item.identity))],
            });
          } else {
            inherited.push({
              raw,
              reference: canonicalAnchor(nearest.reference.target, from, to),
              target: nearest.reference.target,
              from,
              to,
              docLine,
              bare: true,
              via: 'block',
              inheritedFrom: { reference: nearest.reference.reference, docLine: nearest.reference.docLine },
            });
          }
        }
      }
      match = BARE_ANCHOR_PATTERN.exec(line);
    }
  }
  return { inherited, orphans, blocks: blocks.length };
}

// —— 路径解析 ————————————————————————————————————————————————————————
/** 同名文件索引：`service.ts` → 仓库里所有同名文件的相对路径（用于「裸文件名」引用）。 */
export function buildFileNameIndex(root) {
  const index = new Map();
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) stack.push(join(current, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = toPosix(relative(root, join(current, entry.name)));
      const list = index.get(entry.name);
      if (list === undefined) index.set(entry.name, [relativePath]);
      else list.push(relativePath);
    }
  }
  for (const list of index.values()) list.sort();
  return index;
}

/**
 * 解析引用里的路径。四档：resolved / missing（→ BROKEN）/ ambiguous（不可解析，如实计数不判红）。
 * 顺序：① 仓库根相对（`services/api/src/app.ts`，裸 `README.md` 也先按根上那一份算）；
 * ② 相对当前文档所在目录（`../../packages/x.ts`）；③ **唯一后缀匹配**（`messages/store-pg.ts` →
 * `services/api/src/messages/store-pg.ts`、裸 `app.ts` → 全仓唯一的 app.ts）。文档里写相对子路径是
 * 既有习惯，直接判 BROKEN 会把 200 条写对了地方的引用算成「路径不存在」，噪声淹没真问题；
 * 同名多个时无法判断指的是哪一个，记 ambiguous 而不是瞎猜。
 * 注：裸 `README.md:440` 会落到根 README（272 行）而报越界，即使作者心里指的是
 * `deploy/postgres-cvm/README.md:440`——这不是误判，是**引用写得不唯一**：不加目录就没人能复原
 * 它指哪份文件，写全路径才算证据。
 */
export function resolveTarget({ root, docPath, target, fileIndex }) {
  const direct = resolve(root, target);
  if (target.startsWith('..') === false && isRegularFile(direct)) {
    return { status: 'resolved', relative: toPosix(relative(root, direct)) };
  }
  const fromDoc = resolve(root, dirname(docPath), target);
  if (isRegularFile(fromDoc)) return { status: 'resolved', relative: toPosix(relative(root, fromDoc)) };
  const suffix = `/${target}`;
  const candidates = (fileIndex.get(basename(target)) ?? [])
    .filter(candidate => candidate === target || candidate.endsWith(suffix))
    .filter(candidate => isRegularFile(join(root, candidate)));
  if (candidates.length === 1) return { status: 'resolved', relative: candidates[0] };
  if (candidates.length === 0) return { status: 'missing', relative: target };
  return { status: 'ambiguous', relative: target, candidates };
}

// —— 判定 ————————————————————————————————————————————————————————————
/**
 * 单条引用的判定。返回 `{ reason }` 或 `{ reason: null }`（通过），另带 `commentOnly`
 * 作为「引用指到注释块」的提示位（只计数不判红）。
 */
export function classifyReference({ lines, from, to, extension }) {
  if (from < 1 || to < from || to > lines.length) return { reason: OUT_OF_RANGE, lineCount: lines.length };
  const slice = lines.slice(from - 1, to);
  if (!slice.some(line => isSubstantiveLine(line))) return { reason: SUSPECT };
  const commentOnly = slice.every(line => !isSubstantiveLine(line) || isCommentLine(line, extension));
  return { reason: null, commentOnly };
}

// —— 符号行判据（NOT_SYMBOL_LINE） ————————————————————————————————————
/**
 * 该文档是否在符号行判据的作用域内（`docs/architecture/**`，见 `SYMBOL_LINE_SCOPE`）。
 */
export function isSymbolLineScope(docPath) {
  return toPosix(docPath).startsWith(SYMBOL_LINE_SCOPE);
}

/**
 * 闸门侧入口：判据本体在 `tools/lib/anchor-resolve.mjs` 的 `symbolLineVerdict`（**一处口径**，
 * 单测与闸门调的是同一个函数，不许在这里再抄一份判定）。返回 `{...verdict, inScope, applicable}`：
 * `status` ∈ `code` / `comment-detached` / `comment-cited` / `comment-attached`；
 * `inScope` = 文档在 `SYMBOL_LINE_SCOPE` 内，`applicable` = 目标是源码后缀。
 * **只有 `inScope && status === 'comment-attached'` 判红**（`NOT_SYMBOL_LINE`）。
 */
export function judgeSymbolLine({ docPath, docLineText, target, text, lines, from, to, scan = null }) {
  const verdict = symbolLineVerdict({ text, docLineText, lines, from, to, scan });
  return { ...verdict, inScope: isSymbolLineScope(docPath), applicable: SYMBOL_SOURCE_EXTENSIONS.has(extensionOf(target)) };
}

/**
 * 记录一条「作用域内、没落代码行」的锚点（`--symbol=strict` 的判据面）。
 * 去重口径与 `findings` 一致：同一文档里同一条引用只记一条（key = `doc|reference`）。
 */
function recordCommentAnchor(list, seen, anchor) {
  const key = commentAnchorKey(anchor);
  if (seen.has(key)) return;
  seen.add(key);
  list.push(anchor);
}

/**
 * 全量扫描：返回 `{ findings, stats, unresolved, commentAnchors, bareOrphans }`。
 * `findings` 每条 = `{ reason, reference, target, path, owner, doc, docLine, detail }`；
 * 同一文档里同一条引用出现多次只记一条（按 doc + reference 去重）。
 * `commentAnchors` = 作用域内、目标是源码、但**没落在代码行上**的锚点（`--symbol=strict` 的判据面，
 * 见 `COMMENT_ANCHOR`）；与 `findings` 一样按 doc + reference 去重，仅这两档不会进 `findings`。
 * `bareOrphans` = 归不到路径的裸锚点（见 `BARE_ORPHAN`）：不进 `findings`、不影响退出码，但逐条进
 * `tools/doc-anchors-orphan-baseline.json`（基线外新增在 `--strict` 下判红）。
 * `outsideRedAnchors` = 作用域外、按同口径**本会红**的继承锚点：`docs/verification/**` 不判红（历史读数），
 * 但它们进同一份孤儿册的 `outsideRed` 数组，新增同样在 `--strict` 下判红——否则证据页会变成免检区。
 */
export function collectFindings({
  root = TOOL_ROOT,
  targets = DEFAULT_SCAN_TARGETS,
  fileIndex = null,
  documents = null,
} = {}) {
  const index = fileIndex ?? buildFileNameIndex(root);
  const files = documents ?? resolveScanTargets(root, targets);
  const fileLines = new Map();
  const fileTexts = new Map();
  const fileScan = new Map();
  const findings = [];
  const commentAnchors = [];
  const unresolved = [];
  const seen = new Set();
  const seenComment = new Set();
  const bareOrphans = [];
  const outsideRedAnchors = [];
  // 每份文档「进判据的锚点」清单（显式锚点 + 继承到路径的裸锚点）：给锚点清册用，
  // 让「把 `path:4` 改写成『第 4 行』」这种逃逸在计数上留下痕迹。
  const judgedByDoc = new Map();
  const stats = {
    documents: files.length,
    candidates: 0,
    resolved: 0,
    deduped: 0,
    blankStart: 0,
    commentOnly: 0,
    symbol: { inScope: 0, code: 0, detached: 0, cited: 0, attached: 0, outside: 0 },
    bare: { total: 0, inherited: 0, link: 0, orphan: 0, orphanInScope: 0, judged: 0, outside: 0, outsideRed: 0 },
    counts: { [BROKEN]: 0, [OUT_OF_RANGE]: 0, [SUSPECT]: 0, [NOT_SYMBOL_LINE]: 0 },
  };
  const readText = relativePath => {
    if (!fileTexts.has(relativePath)) fileTexts.set(relativePath, readFileSync(join(root, relativePath), 'utf8'));
    return fileTexts.get(relativePath);
  };
  const readLines = relativePath => {
    if (!fileLines.has(relativePath)) fileLines.set(relativePath, splitLines(readText(relativePath)));
    return fileLines.get(relativePath);
  };
  const readScan = relativePath => {
    if (!fileScan.has(relativePath)) fileScan.set(relativePath, scanComments(readText(relativePath)));
    return fileScan.get(relativePath);
  };
  for (const docPath of files) {
    const text = readFileSync(join(root, docPath), 'utf8');
    const docLines = splitLines(text);
    const explicit = extractReferences(text);
    // 裸锚点先归属：继承到的锚点与显式锚点走同一段判据；`report` 只决定它是否真的进 findings／commentAnchors
    // （作用域外的历史取证页只计数，见 `BARE_ANCHOR_SCOPE`）。
    const attribution = attributeBareAnchors({
      text,
      references: explicit,
      resolveIdentity: reference => {
        const probe = resolveTarget({ root, docPath, target: reference.target, fileIndex: index });
        return probe.status === 'resolved' ? probe.relative : `?${reference.target}`;
      },
    });
    const bareInScope = isBareAnchorScope(docPath);
    stats.bare.inherited += attribution.inherited.length;
    stats.bare.link += attribution.inherited.filter(item => item.via === 'link').length;
    stats.bare.total += attribution.inherited.length + attribution.orphans.length;
    stats.bare.orphan += attribution.orphans.length;
    for (const orphan of attribution.orphans) {
      if (bareInScope) stats.bare.orphanInScope += 1;
      bareOrphans.push({
        doc: docPath,
        docLine: orphan.docLine,
        raw: orphan.raw,
        reason: orphan.reason,
        inScope: bareInScope,
        text: orphan.text.trim().slice(0, 160),
        ...(Array.isArray(orphan.candidates) ? { candidates: orphan.candidates } : {}),
      });
    }
    const queue = [
      ...explicit.map(reference => ({ reference, report: true })),
      ...attribution.inherited.map(reference => ({ reference, report: bareInScope })),
    ];
    for (const { reference, report } of queue) {
      const bare = reference.bare === true;
      if (report) {
        const judged = judgedByDoc.get(docPath);
        if (judged === undefined) judgedByDoc.set(docPath, [reference.reference]);
        else judged.push(reference.reference);
      }
      if (bare) {
        if (report) stats.bare.judged += 1;
        else stats.bare.outside += 1;
      } else {
        stats.candidates += 1;
      }
      const resolved = resolveTarget({ root, docPath, target: reference.target, fileIndex: index });
      if (resolved.status !== 'resolved') {
        if (resolved.status === 'ambiguous') {
          // 不可解析≠不存在：如实记账，不冒充 BROKEN，也不静默丢弃。
          if (!report) continue;
          unresolved.push({ doc: docPath, docLine: reference.docLine, reference: reference.reference, candidates: resolved.candidates });
          continue;
        }
        if (!report) {
          stats.bare.outsideRed += 1;
          outsideRedAnchors.push({ doc: docPath, docLine: reference.docLine, reference: reference.reference, reason: BROKEN });
          continue;
        }
        const key = `${docPath}|${reference.reference}|${BROKEN}`;
        if (seen.has(key)) { stats.deduped += 1; continue; }
        seen.add(key);
        stats.counts[BROKEN] += 1;
        findings.push({
          reason: BROKEN,
          reference: reference.reference,
          target: reference.target,
          path: resolved.relative,
          owner: ownerOf(reference.target),
          doc: docPath,
          docLine: reference.docLine,
          detail: '路径在仓库里找不到',
          ...(bare ? { bare, inheritedFrom: reference.inheritedFrom } : {}),
        });
        continue;
      }
      if (!bare) stats.resolved += 1;
      const lines = readLines(resolved.relative);
      if (lines[reference.from - 1] !== undefined && lines[reference.from - 1].trim() === '') stats.blankStart += 1;
      const verdict = classifyReference({
        lines,
        from: reference.from,
        to: reference.to,
        extension: extensionOf(resolved.relative),
      });
      if (verdict.reason === null) {
        if (verdict.commentOnly) stats.commentOnly += 1;
        const symbol = judgeSymbolLine({
          docPath,
          docLineText: docLines[reference.docLine - 1] ?? '',
          target: resolved.relative,
          text: readText(resolved.relative),
          lines,
          from: reference.from,
          to: reference.to,
          scan: readScan(resolved.relative),
        });
        if (symbol.applicable) {
          if (!symbol.inScope) {
            // 作用域外（历史证据页）同形状的引用只统计：见 `SYMBOL_LINE_SCOPE` 的理由，不判红。
            if (symbol.status === 'comment-attached') stats.symbol.outside += 1;
          } else {
            stats.symbol.inScope += 1;
            if (symbol.status === 'code') stats.symbol.code += 1;
            else if (symbol.status === 'comment-detached') {
              stats.symbol.detached += 1;
              recordCommentAnchor(commentAnchors, seenComment, {
                doc: docPath,
                docLine: reference.docLine,
                reference: reference.reference,
                target: resolved.relative,
                from: reference.from,
                to: reference.to,
                bucket: symbol.status,
                span: symbol.span === null ? null : { start: symbol.span.start, end: symbol.span.end },
                lineText: lines[reference.from - 1] ?? '',
                owner: ownerOf(resolved.relative),
              });
            } else if (symbol.status === 'comment-cited') {
              stats.symbol.cited += 1;
              recordCommentAnchor(commentAnchors, seenComment, {
                doc: docPath,
                docLine: reference.docLine,
                reference: reference.reference,
                target: resolved.relative,
                from: reference.from,
                to: reference.to,
                bucket: symbol.status,
                span: symbol.span === null ? null : { start: symbol.span.start, end: symbol.span.end },
                lineText: lines[reference.from - 1] ?? '',
                owner: ownerOf(resolved.relative),
                citation: symbol.citation,
              });
            } else if (symbol.status === 'comment-attached') {
              stats.symbol.attached += 1;
              const key = `${docPath}|${reference.reference}|${NOT_SYMBOL_LINE}`;
              if (!seen.has(key)) {
                seen.add(key);
                stats.counts[NOT_SYMBOL_LINE] += 1;
                findings.push({
                  reason: NOT_SYMBOL_LINE,
                  reference: reference.reference,
                  target: reference.target,
                  path: resolved.relative,
                  owner: ownerOf(resolved.relative),
                  doc: docPath,
                  docLine: reference.docLine,
                  detail: describeSymbolMiss({ target: resolved.relative, span: symbol.span, declaration: symbol.declaration }),
                  ...(bare ? { bare, inheritedFrom: reference.inheritedFrom } : {}),
                });
              } else {
                stats.deduped += 1;
              }
            }
          }
        }
        continue;
      }
      if (!report) {
        stats.bare.outsideRed += 1;
        outsideRedAnchors.push({ doc: docPath, docLine: reference.docLine, reference: reference.reference, reason: verdict.reason });
        continue;
      }
      const key = `${docPath}|${reference.reference}|${verdict.reason}`;
      if (seen.has(key)) { stats.deduped += 1; continue; }
      seen.add(key);
      stats.counts[verdict.reason] += 1;
      findings.push({
        reason: verdict.reason,
        reference: reference.reference,
        target: reference.target,
        path: resolved.relative,
        owner: ownerOf(resolved.relative),
        doc: docPath,
        docLine: reference.docLine,
        detail: verdict.reason === OUT_OF_RANGE
          ? `行号超出文件行数（该文件 ${verdict.lineCount} 行）`
          : '区间内没有任何实质内容行（全空行／全右括号）',
        ...(bare ? { bare, inheritedFrom: reference.inheritedFrom } : {}),
      });
    }
  }
  findings.sort((left, right) => (
    REASONS.indexOf(left.reason) - REASONS.indexOf(right.reason)
    || left.path.localeCompare(right.path)
    || left.reference.localeCompare(right.reference)
    || left.doc.localeCompare(right.doc)
  ));
  return { findings, stats, unresolved, commentAnchors, bareOrphans, outsideRedAnchors, judgedByDoc };
}

// —— 锚点身份判据（ANCHOR_DRIFT，只对 docs/architecture/**） ———————————————————
/**
 * 结构三判据只回答「指的地方存不存在」，回答不了「指的还是不是那段代码」：把 `app.ts:1291`
 * 改成 `:1341` 之后，行号仍在界内、区间里也有代码，三条判据照样全绿，文档却已经指到别的实现上。
 * 这一条判据补的就是那半个问题：拿**引用行里同一行的行内代码片段**当「期望文本」，去目标文件里搜。
 *
 * 判定按**文档行**成组（不是按引用成组）：一行里常有多条引用，片段属于哪一条要看命中位置，
 * 而不是看它离哪个反引号更近。四档：
 *   绿                  —— 至少一个片段落在任意一条引用的 `[起-2, 止+2]` 内（±2 与 contract 锚点同口径）。
 *   ANCHOR_DRIFT 可自动 —— 某条引用的片段在目标文件里**恰 1 处**命中，但那不在窗口内 ⇒ 按文本重定位即可，
 *                         报出实际行号，作者把引用改成 `路径:实际行号` 就对了。
 *   ANCHOR_DRIFT 不可自动 —— 该行只有 1 条引用，且所有片段在目标文件里 0 命中 ⇒ 代码可能换了写法、
 *                         也可能这条引用早就不指这段实现了，机器判不了，必须人工确认改文档还是改代码。
 *   其余（只计数）      —— 多引用行且片段都 0 命中、或只有多处命中：归属与文本都不唯一，判红只会制造噪声。
 *   跳过（只计数）      —— 引用行里没有「像代码」的片段（现状大量如此）。不猜、不判。
 *
 * **为什么只对 `docs/architecture/**` 判**：证据页（`docs/verification/**`）是**某一版树的历史读数**，
 * 行号按当时的树写、正文里也声明了基线；按当前树重新搜必然「漂移」，对它们判红等于要求历史证据跟着
 * 代码一起改写，正好毁掉证据的价值。架构页是**在用的**实现说明，指错地方就是假证据。
 *
 * 误判的代价不对称：漏判有结构三判据兜着，误判会让作者去「修」一条其实写对了的引用（例如片段属于
 * 同一行里用散文写的另一处引用）。所以片段过滤宁可严：太短、没有空白、不像代码、含省略号的都不算。
 */
export const ANCHOR_DRIFT = 'ANCHOR_DRIFT';
/** 判据作用域：只判架构页（见上方「为什么只对 docs/architecture 判」）。 */
export const ANCHOR_DRIFT_SCOPE = 'docs/architecture/';
/** 容差：与 `tools/verify-contract-status.mjs` 的锚点 ±2 行同口径。 */
export const ANCHOR_DRIFT_WINDOW = 2;
const MIN_FRAGMENT_LENGTH = 12;
const INLINE_CODE_SPAN = /`([^`\n]+)`/g;
const ROUTE_LIKE_SPAN = /^(?:GET|POST|PUT|PATCH|DELETE)\s+\//;
const ANCHOR_LIKE_SPAN = /\.(?:mjs|cjs|js|jsx|ts|tsx|json|jsonc|sql|md|yml|yaml|css|html|py|sh|ps1|toml):\d/;

/** 判据作用域：`docs/architecture/**` 之外一律不判（证据页的历史读数不算漂移）。 */
export function isAnchorDriftScope(docPath) {
  return toPosix(docPath).startsWith(ANCHOR_DRIFT_SCOPE);
}

/** 片段正规化：折叠空白、去掉行尾分号——只判「同一段文本」，不判语义等价。 */
export function normalizeFragment(text) {
  return text.trim().replace(/\s+/g, ' ').replace(/;+$/, '');
}

/**
 * 一段行内代码像不像「可以拿去搜的代码」。
 * 这层过滤决定判据的量级：不过滤时 `docs/architecture/**` 会冒出 344 条命中（符号名、HTTP 路径、
 * 表格共同列注解全被当指纹），过完是 16 条。
 */
export function isCodeFragment(span) {
  const text = span.trim();
  if (text.length < MIN_FRAGMENT_LENGTH) return false;
  if (ANCHOR_LIKE_SPAN.test(text)) return false;                 // 片段自己就是锚点（`app.ts:12`）
  if (text.includes('://')) return false;                        // URL 不是仓内文本
  if (ROUTE_LIKE_SPAN.test(text)) return false;                  // `GET /admin/posts` 这类路由
  if (!/\s/.test(text)) return false;                            // 单个标识符不唯一
  if (!/[=;(){}]/.test(text)) return false;                      // 含运算符/括号，才像代码而不是短语
  if (text.includes('...') || text.includes('…')) return false;   // 缩写/省略号不是可搜文本
  return true;
}

/**
 * 一份文档里「哪一行有哪些可用片段」（1 基行号 → 片段文本数组）。
 * 片段必须同时满足：像代码（`isCodeFragment`）、且**只出现在这一行**——后者排除表格里反复出现的
 * 共同列注解（「已实现」「只读代码取证」这类），它们不是某条引用行的私有指纹。
 */
export function collectLineFragments(docText) {
  const lines = docText.split('\n');
  const occurrences = new Map();
  const spansByLine = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const spans = [];
    INLINE_CODE_SPAN.lastIndex = 0;
    let match = INLINE_CODE_SPAN.exec(lines[index]);
    while (match !== null) {
      const normalized = normalizeFragment(match[1]);
      spans.push({ text: match[1], normalized });
      if (!occurrences.has(normalized)) occurrences.set(normalized, new Set());
      occurrences.get(normalized).add(index + 1);
      match = INLINE_CODE_SPAN.exec(lines[index]);
    }
    if (spans.length > 0) spansByLine.set(index + 1, spans);
  }
  const fragmentsByLine = new Map();
  for (const [docLine, spans] of spansByLine) {
    const fragments = spans
      .filter(span => isCodeFragment(span.text))
      .filter(span => (occurrences.get(span.normalized)?.size ?? 0) === 1)
      .map(span => span.text);
    if (fragments.length > 0) fragmentsByLine.set(docLine, fragments);
  }
  return fragmentsByLine;
}

/**
 * 全量跑锚点身份判据：返回 `{ findings, stats }`。每条 finding 形如
 * `{ reason: ANCHOR_DRIFT, kind, doc, docLine, reference, path, from, to, fragments, actualLine, suggestion, owner, detail }`。
 */
export function collectAnchorDrift({
  root = TOOL_ROOT,
  targets = DEFAULT_SCAN_TARGETS,
  fileIndex = null,
  documents = null,
} = {}) {
  const index = fileIndex ?? buildFileNameIndex(root);
  const documentsInScope = (documents ?? resolveScanTargets(root, targets)).filter(isAnchorDriftScope).sort();
  const fileLines = new Map();
  const readLines = relativePath => {
    if (!fileLines.has(relativePath)) fileLines.set(relativePath, splitLines(readFileSync(join(root, relativePath), 'utf8')));
    return fileLines.get(relativePath);
  };
  const findings = [];
  const stats = {
    documents: documentsInScope.length,
    referenceLines: 0,
    skipped: 0,
    green: 0,
    ambiguous: 0,
    counts: { [ANCHOR_DRIFT]: 0 },
  };
  for (const docPath of documentsInScope) {
    const text = readFileSync(join(root, docPath), 'utf8');
    if (!text.includes('`')) continue;
    const fragmentsByLine = collectLineFragments(text);
    const referencesByLine = new Map();
    for (const reference of extractReferences(text)) {
      const list = referencesByLine.get(reference.docLine);
      if (list === undefined) referencesByLine.set(reference.docLine, [reference]);
      else list.push(reference);
    }
    for (const docLine of [...referencesByLine.keys()].sort((left, right) => left - right)) {
      stats.referenceLines += 1;
      const references = referencesByLine.get(docLine);
      const fragments = fragmentsByLine.get(docLine) ?? [];
      // 没有可用片段 ⇒ 这条判据没有线索，如实跳过（不猜、也不冒充通过）。
      if (fragments.length === 0) { stats.skipped += 1; continue; }
      const placements = [];
      for (const reference of references) {
        const resolved = resolveTarget({ root, docPath, target: reference.target, fileIndex: index });
        if (resolved.status !== 'resolved') continue;
        const lines = readLines(resolved.relative);
        const perFragment = fragments.map(fragment => {
          const needle = normalizeFragment(fragment);
          const hits = [];
          for (let index2 = 0; index2 < lines.length; index2 += 1) {
            if (normalizeFragment(lines[index2]).includes(needle)) hits.push(index2 + 1);
          }
          return { fragment, hits };
        });
        placements.push({ reference, path: resolved.relative, from: reference.from, to: reference.to, perFragment });
      }
      if (placements.length === 0) { stats.skipped += 1; continue; }
      const inWindow = placement => placement.perFragment.some(item => item.hits.some(
        line => line >= placement.from - ANCHOR_DRIFT_WINDOW && line <= placement.to + ANCHOR_DRIFT_WINDOW,
      ));
      if (placements.some(inWindow)) { stats.green += 1; continue; }
      const uniqueOut = placements.filter(placement => placement.perFragment.some(item => item.hits.length === 1));
      if (uniqueOut.length > 0) {
        const placement = uniqueOut[0];
        const item = placement.perFragment.find(entry => entry.hits.length === 1);
        stats.counts[ANCHOR_DRIFT] += 1;
        findings.push({
          reason: ANCHOR_DRIFT,
          kind: 'drift-unique',
          doc: docPath,
          docLine,
          reference: placement.reference.reference,
          path: placement.path,
          from: placement.from,
          to: placement.to,
          fragments,
          actualLine: item.hits[0],
          suggestion: `${placement.path}:${item.hits[0]}`,
          owner: ownerOf(placement.path),
          detail: `片段「${item.fragment}」在目标文件里只出现在第 ${item.hits[0]} 行，不在引用窗口 ${placement.from}-${placement.to}（±${ANCHOR_DRIFT_WINDOW}）内 ⇒ 可按文本重定位`,
        });
        continue;
      }
      const anyHit = placements.some(placement => placement.perFragment.some(item => item.hits.length > 0));
      // 多引用行 + 片段全 0 命中：片段可能属于同行的另一处引用（归属不唯一），只计数不判红。
      if (anyHit || references.length !== 1) { stats.ambiguous += 1; continue; }
      const placement = placements[0];
      stats.counts[ANCHOR_DRIFT] += 1;
      findings.push({
        reason: ANCHOR_DRIFT,
        kind: 'drift-gone',
        doc: docPath,
        docLine,
        reference: placement.reference.reference,
        path: placement.path,
        from: placement.from,
        to: placement.to,
        fragments,
        actualLine: null,
        suggestion: null,
        owner: ownerOf(placement.path),
        detail: `片段 ${fragments.map(fragment => `「${fragment}」`).join('、')} 在目标文件里 0 命中 ⇒ 引用可能早已不指这段实现，需人工确认改文档还是改代码`,
      });
    }
  }
  findings.sort((left, right) => (
    left.doc.localeCompare(right.doc) || left.docLine - right.docLine
  ));
  return { findings, stats };
}

/** 锚点身份判据的基线 key：`文档:行号#片段签名`——片段本身进 key，文档行改写后 key 变 ⇒ 算新增。 */
export function driftBaselineKey(finding) {
  const signature = [...finding.fragments].map(normalizeFragment).sort().join(' && ');
  return `${finding.doc}:${finding.docLine}#${signature}`;
}

/**
 * 与结构基线同语义：命中＝已登记、新增＝未登记（`--strict` 下红）、陈旧＝登记了但已不命中（只提示）。
 * 基线是**逐条人工裁决**的结果，不写数字上限：多一条未登记的漂移就红，修好一条则那一条变陈旧。
 */
export function partitionDriftByBaseline(findings, entries = ARCHITECTURE_ANCHOR_BASELINE) {
  const registered = new Set(entries);
  const covered = findings.filter(finding => registered.has(driftBaselineKey(finding)));
  const fresh = findings.filter(finding => !registered.has(driftBaselineKey(finding)));
  const hit = new Set(covered.map(finding => driftBaselineKey(finding)));
  const stale = entries.filter(entry => !hit.has(entry));
  return { fresh, covered, stale };
}

/**
 * `docs/architecture/**` 上锚点身份判据的已登记清单（2026-10-27 实测 N=16）。
 *
 * 为什么不用 `--emit-baseline` 那一套：那套基线的条目形状是 `path|reason|reference`，只覆盖结构三判据，
 * 而且 `tests/unit/doc-anchors-guard.test.mjs` 要求「条目陈旧就必须删」；把 ANCHOR_DRIFT 混进
 * `tools/doc-anchors-baseline.json` 会让那份文件的语义变味，也让两套判据的陈旧处理互相牵制。
 * 因此这里是**独立常量**，与 `tools/doc-anchors-baseline.json` 的 13 条互不干扰。
 *
 * 每条的分类写在行尾注释里：`drift-unique`（片段唯一命中但在窗口外，可按文本重定位）／
 * `drift-gone`（单引用行、片段 0 命中，需人工判断）／`归属误判`（片段其实属于同一行里用散文写的
 * 另一处引用，引用本身没错）／`历史树锚点`（该页行号是当时那棵树的历史读数，页内已声明）。
 * 新增漂移必须**先人工看**再决定是改文档还是登记；⛔ 不要把这条判据当成可以随便扩的白名单。
 */
export const ARCHITECTURE_ANCHOR_BASELINE = Object.freeze([
  // 2026-10-27 实测 16 条，逐条人工裁决；key 形状见 driftBaselineKey（文档:行号#片段指纹）。
  // 2026-10-28（GY-R68-D09b，base de2aa3c6）删去 1 条 ⇒ 15 条。删掉的是原来这条：
  //   "docs/architecture/s4-data-traceability.md:186#available: config.executionMode !== 'real'",
  //   行尾注记当时写「drift-unique｜实际在 services/api/src/app.ts:2221｜真漂移」。那个 :2221 在写下时是**对的**：
  //   1a8af906（app.ts 2659 行）的第 2221 行正是 `    available: config.executionMode !== 'real',`，该片段全文件唯一；
  //   到 base de2aa3c6（2695 行）相对那棵树 +36 行后，唯一落点漂到 2257，这条注记才 stale（是漂移失效，不是出生即错）。
  //   本片把该页那处引用改成真实落点 :2257，漂移修好后这条 key 再也命中不了 ⇒ 留着只是留一条永远命不中的假基线：
  //   实测把它加回去 `--strict` 仍 exit 0，只多一行 `STALE-DRIFT`（陈旧漂移条目不进 exit code）。
  //   所以删它属于「基线治理、不留假基线」，判据逻辑与 `ANCHOR_DRIFT_WINDOW` 一个字没改，也不是闸门硬要求。
  // 行尾注释：判定档｜片段实际落点｜归类原因。
  "docs/architecture/acceptance-map.md:69#HUMAN_REVIEW_STATE = 'under_construction'", // drift-unique｜实际在 services/api/src/moderation/nonbypass.ts:15｜归属误判：片段属于同一行里用散文写的 moderation/types.ts:110-115；nonbypass.ts:161-168 的引用本身没错
  "docs/architecture/ai-ops-spec-status.md:195#{ actorId, reasonCode: 'job_cancelled', requestId }", // drift-gone｜0 命中｜真漂移：片段是散文式简写（代码里该对象跨 977-981 四行），故永不逐字命中；锚点区间本身对（service.ts:977-981 就是取消审计那一笔）。key 的文档行号随 N02 销号删两行由 197 移到 195
  "docs/architecture/gy-i19-user-backup-copies-design.md:26#{ purged: false }", // drift-unique｜实际在 services/api/src/privacy/user-data-deletion.ts:329｜历史树锚点：该页行号是 GY-R34-I19 树的读数
  "docs/architecture/gy-i19-user-backup-copies-design.md:312#purged === true", // drift-gone｜0 命中｜历史树锚点：同上
  "docs/architecture/gy-i19-user-backup-copies-design.md:354#MIGRATION_COUNT === LAST_VERSION_NUMBER", // drift-gone｜0 命中｜历史树锚点：同上
  "docs/architecture/gy-r34-retention-policy.md:46#SET \"detail\" = NULL, \"detail\" = \"detail\" + 1 && SET detail = NULL, revision = revision + 1", // drift-unique｜实际在 services/api/src/community/store-pg.ts:1086｜真漂移
  "docs/architecture/gy-r34-retention-policy.md:112#UPDATE (revoked_at)", // drift-gone｜0 命中｜表述差异：实际 SQL 是 GRANT UPDATE (token_hash,revoked_at) ON admin_sessions，片段少了授权前缀
  "docs/architecture/gy-r34-retention-policy.md:156#expires_at <= now()", // drift-unique｜实际在 services/api/src/auth/idempotency.ts:261｜真漂移，同一句里已经写了 :261
  "docs/architecture/gy-r59-retention-backup-thirdparty-map.md:32#online_due_at <= cutoff AND state <> 'completed'", // drift-gone｜0 命中｜归属误判：片段属于同一行的 tools/purge-expired-online-data.mjs:16；package.json:35 引用本身没错
  "docs/architecture/gy-r59-retention-backup-thirdparty-map.md:33#state <> 'purged' AND retention_until <= cutoff", // drift-gone｜0 命中｜归属误判：同上（package.json:34）
  "docs/architecture/gy-r59-retention-backup-thirdparty-map.md:84#record_third_party_deletion(p_request_id uuid, p_recipient_id text, p_export_ref uuid, p_state text, p_evidence_ref text, p_error_code text, p_at timestamptz) RETURNS jsonb", // drift-gone｜0 命中｜表述差异：SQL 是 CREATE FUNCTION public.record_third_party_deletion( 多行签名，文档写成一行的完整签名
  "docs/architecture/gy-r59-retention-backup-thirdparty-map.md:108#REPLAY_MANIFEST_VERSION = 1", // drift-unique｜实际在 services/api/src/privacy/backup-replay-manifest.ts:85｜真漂移，同一句里已经写了 :85
  "docs/architecture/rate-limit-policy.md:185#(_address, hop) => hop < trustProxy", // drift-gone｜0 命中｜真漂移：app.ts:2450-2455 现为 OCR 作业源注释；trustProxy 的 hop 判据在 app.ts:2649，且文档片段省略了类型标注
  "docs/architecture/state-contract.md:117#createPostgresBackupPurgePort({ pool, now }) && payload = 'null'::jsonb && state = 'purged'", // drift-unique｜实际在 services/api/db/migrations/0023_user_backup_copies.sql:75｜真漂移（引用写的是 :34）
]);

/** 谁该修：按被引用路径的归属分组，方便派活；判断不了就给 repo。 */
export function ownerOf(targetPath) {
  const path = toPosix(targetPath);
  if (path.startsWith('services/api/src/')) return 'api-server';
  if (path.startsWith('apps/')) return 'admin-web';
  if (path.startsWith('miniprogram/')) return 'miniprogram';
  if (path.startsWith('packages/')) return 'contracts';
  if (path.startsWith('.github/')) return 'ci';
  if (path.startsWith('docs/')) return 'docs';
  if (path.startsWith('tools/')) return 'tooling';
  if (path.startsWith('deploy/')) return 'deploy';
  return 'repo';
}

// —— 符号关联统计（--symbol=count：只统计，不参与退出码） ——————————————————
/**
 * 只有这些扩展名有「声明块」口径。JSON/SQL/MD/YML 的目标**不算无法判定**：
 * 裁定 ④ 明确「不强制所有 JSON/SQL/历史读数都套函数符号」，硬套只会把合规引用记成红的。
 * 同一份清单也用于 `NOT_SYMBOL_LINE` 的作用域判定（见 `SYMBOL_LINE_SCOPE` 上方注释）。
 */
export const SYMBOL_SOURCE_EXTENSIONS = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs']);

/**
 * 逐条引用做符号关联：**每个引用位置分别关联**，不按行去重、也不取「一行一个」。
 * 三档计数（`可核` 是 `命中` 的超集）：
 *   可核   —— 能唯一关联到一个声明块；
 *   命中   —— 可核且引用区间**完整**落在该声明块内；
 *   无法判定 —— 路径找不到／路径不唯一／该行不在任何声明块内／声明块并列无法定序（**不猜、不算通过**）。
 * 另记「不适用」（目标不是源码扩展名，裁定 ④ 不要求套函数符号）与「兜底回退」（块体可能不准，必须可见）。
 * 返回值**不参与退出码**：`--strict` 的结构性判据（BROKEN／OUT_OF_RANGE／SUSPECT ＋ 基线）一切照旧。
 */
export function countSymbolAssociations({
  root = TOOL_ROOT,
  targets = DEFAULT_SCAN_TARGETS,
  fileIndex = null,
  documents = null,
} = {}) {
  const index = fileIndex ?? buildFileNameIndex(root);
  const files = documents ?? resolveScanTargets(root, targets);
  const blocksByFile = new Map();
  const stats = { references: 0, checkable: 0, hit: 0, undecidable: 0, notApplicable: 0, fallback: 0 };
  const reasons = new Map();
  const undecidable = [];
  const fallbacks = [];
  const blocksOf = relativePath => {
    if (!blocksByFile.has(relativePath)) {
      blocksByFile.set(relativePath, declarationBlocks(readFileSync(join(root, relativePath), 'utf8')));
    }
    return blocksByFile.get(relativePath);
  };
  const recordUndecidable = (where, target, reason) => {
    stats.undecidable += 1;
    // 直方图按**类别**归并（剥掉括号里的具体行区间），否则「并列」的每一组都会自成一类，看不出主因。
    const category = reason.replace(/（.*$/, '');
    reasons.set(category, (reasons.get(category) ?? 0) + 1);
    undecidable.push({ ...where, target, reason });
  };
  for (const docPath of files) {
    const text = readFileSync(join(root, docPath), 'utf8');
    // extractReferences 本来就是逐行 while 取**全部**匹配：一行里两条引用就是两条，不许退化成一行一条。
    for (const reference of extractReferences(text)) {
      stats.references += 1;
      const where = { doc: docPath, docLine: reference.docLine };
      const resolved = resolveTarget({ root, docPath, target: reference.target, fileIndex: index });
      if (resolved.status !== 'resolved') {
        recordUndecidable(
          where,
          reference.reference,
          resolved.status === 'ambiguous' ? '引用路径不唯一（同名多文件），定不了目标文件' : '引用路径在仓库里找不到',
        );
        continue;
      }
      if (!SYMBOL_SOURCE_EXTENSIONS.has(extensionOf(resolved.relative))) {
        stats.notApplicable += 1;
        continue;
      }
      const association = associateSymbol(blocksOf(resolved.relative), { from: reference.from, to: reference.to });
      const symbol = association.block?.symbol ?? '';
      const target = `${resolved.relative}:${reference.from === reference.to ? reference.from : `${reference.from}-${reference.to}`}${symbol === '' ? '' : `（${symbol}）`}`;
      if (association.status === 'undecidable') {
        recordUndecidable(where, target, association.reason);
        continue;
      }
      stats.checkable += 1;
      if (association.status === 'hit') stats.hit += 1;
      if (association.block?.bodyFallback === true) {
        stats.fallback += 1;
        fallbacks.push({ ...where, symbol, target, reason: association.reason });
      }
    }
  }
  return { stats, reasons, undecidable, fallbacks };
}

// —— 符号落点严格档（`--symbol=strict`：注释里的锚点进「基线／新增／陈旧」） ——————————
/**
 * `--symbol=strict` 的判据名（也是符号基线条目的 `reason`）：作用域内、目标是源码，但锚点**没有落在
 * 代码行上**——`注释但非文档注释` ＋ `逐字引用注释文案` 两档。这两档原来只进 `SYMBOL-LINE` 读数、
 * 没有判据管：锚点可能指到一段注释、一个空行旁边、或与符号完全无关的行，闸门照样绿。
 *
 * 为什么不直接判红：仓里这两档是**既有证据形态**（引用代码里的旧文案、判据说明、门禁注释），
 * 一次性 39 条不属本片能修的范围，直接判红等于把门禁钉成永红或者逼人乱重锚（篡改证据语义）。
 * 因此沿用 `--strict` 的既有语义：命中基线只计数（打读数）、基线外新增在 `--strict` 下 exit 1、
 * 基线条目修好（不再命中）报 `STALE` 要求删。
 *
 * `落在文档注释里`（`comment-attached`）**不在这里判**：它仍是 `NOT_SYMBOL_LINE` ＋
 * `tools/doc-anchors-baseline.json` 的既有口径，两类基线互不干扰（语义、陈旧处理各自独立）。
 */
export const COMMENT_ANCHOR = 'COMMENT_ANCHOR';
/** 符号基线只认这一种 `reason`：出现别的取值说明文件被改坏了，直接报错退出。 */
export const SYMBOL_ANCHOR_REASONS = Object.freeze([COMMENT_ANCHOR]);
/**
 * 符号落点基线的默认路径：与 `tools/doc-anchors-baseline.json` **同目录同风格**的独立清单。
 * 为什么不塞进那份文件：那份的 `reason` 只允许结构四判据（`REASONS`），
 * `tests/unit/doc-anchors-guard.test.mjs` 也按结构判据逐条反查；混进来会让两份语义互相牵制。
 */
export const DEFAULT_SYMBOL_BASELINE = 'tools/doc-anchors-symbol-baseline.json';

/** 符号基线 key：`文档|引用`。文档行号**不进 key**（正文插一行不该让整条基线失效），行号另记字段供人读。 */
export const commentAnchorKey = anchor => `${anchor.doc}|${anchor.reference}`;

/** 读符号基线；文件不存在按空基线处理（等于所有注释锚点都算新增），坏 JSON／缺字段／缺原因直接抛。 */
export function loadSymbolBaseline(root, baselinePath = DEFAULT_SYMBOL_BASELINE) {
  const absolute = resolve(root, baselinePath);
  if (!existsSync(absolute)) return { path: baselinePath, entries: [], missing: true };
  const parsed = JSON.parse(readFileSync(absolute, 'utf8'));
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  for (const entry of entries) {
    if (typeof entry.doc !== 'string' || typeof entry.reference !== 'string' || typeof entry.reason !== 'string') {
      throw new Error(`符号基线条目缺字段（需要 doc / reference / reason）：${JSON.stringify(entry)}`);
    }
    if (!SYMBOL_ANCHOR_REASONS.includes(entry.reason)) {
      throw new Error(`符号基线条目的 reason 不是 ${SYMBOL_ANCHOR_REASONS.join(' / ')}：${entry.reason}`);
    }
    // 硬要求：基线条目必须**逐条带原因**，不许只写坐标（否则基线就退化成一串没人负责的行号）。
    if (typeof entry.note !== 'string' || entry.note.trim() === '') {
      throw new Error(`符号基线条目缺原因（note 不得为空，要写清「为什么这条锚点只能指注释」）：${JSON.stringify(entry)}`);
    }
  }
  return { path: baselinePath, entries, missing: false };
}

/** 与结构基线同语义：命中＝已登记（只计数）、新增＝未登记（`--strict` 下红）、陈旧＝登记了但已不命中。 */
export function partitionSymbolByBaseline(anchors, entries = []) {
  const known = new Map();
  for (const entry of entries) {
    const key = commentAnchorKey(entry);
    known.set(key, (known.get(key) ?? 0) + 1);
  }
  const covered = [];
  const fresh = [];
  for (const anchor of anchors) {
    const key = commentAnchorKey(anchor);
    const remaining = known.get(key) ?? 0;
    if (remaining > 0) {
      known.set(key, remaining - 1);
      covered.push(anchor);
    } else {
      fresh.push(anchor);
    }
  }
  const stale = [];
  for (const entry of entries) {
    const key = commentAnchorKey(entry);
    const remaining = known.get(key) ?? 0;
    if (remaining > 0) {
      known.set(key, remaining - 1);
      stale.push(entry);
    }
  }
  return { fresh, covered, stale };
}

/**
 * 一条「注释锚点」的失败正文：文档 file:line、目标文件、**该行实际内容**、以及这段注释为什么没有
 * 代码行可指——作者不用回目标文件里自己找「到底指到了什么」。
 */
export function describeCommentAnchor(anchor) {
  const raw = String(anchor.lineText ?? '').trim();
  const text = raw === '' ? '（空行／纯空白）' : (raw.length > 96 ? `${raw.slice(0, 96)}…` : raw);
  const range = anchor.from === anchor.to ? `${anchor.from}` : `${anchor.from}-${anchor.to}`;
  const span = anchor.span === null ? '注释里' : `第 ${anchor.span.start}-${anchor.span.end} 行的注释里`;
  const why = anchor.bucket === 'comment-cited'
    ? '文档逐字引用了这段注释原文（该注释块紧贴声明行，但文档引的是注释不是声明）'
    : '锚点落在注释上，该注释块后面没有声明行可指';
  return `${anchor.doc}:${anchor.docLine} → ${anchor.reference}（目标文件 ${anchor.target} 第 ${range} 行的实际内容「${text}」；${why}；位置在${span}；owner=${anchor.owner}）`;
}

function printSymbolStrict(streams, { stats, baseline, fresh, covered, stale, anchors }) {
  const { symbol } = stats;
  const offCode = symbol.detached + symbol.cited;
  const deduped = offCode - anchors;
  streams.log('SYMBOL: --symbol=strict 判「作用域内的锚点必须落在目标文件的代码行上」——未落代码行的进符号基线（基线内只计数、基线外新增在 --strict 下 exit 1；--symbol=count 的口径与文案不变）');
  streams.log(`SYMBOL-STRICT: 作用域 ${SYMBOL_LINE_SCOPE}** × 源码后缀——可判 ${symbol.inScope} 条：落代码行 ${symbol.code} 条通过、未落代码行 ${offCode} 条进基线（注释但非文档注释 ${symbol.detached}、逐字引用注释文案 ${symbol.cited}${deduped > 0 ? `；同文档重复 ${deduped} 条按 doc+reference 去重后 ${anchors} 条` : ''}）、落在文档注释里 ${symbol.attached} 条仍按 ${NOT_SYMBOL_LINE} ＋结构基线判；作用域外同形状 ${symbol.outside} 条只统计、不判红`);
  streams.log(`SYMBOL-STRICT-BASELINE: ${baseline.path} 登记 ${baseline.entries.length} 条；本次命中 ${covered.length} 条、基线外新增 ${fresh.length} 条、陈旧 ${stale.length} 条`);
  const cited = covered.filter(anchor => anchor.bucket === 'comment-cited').length;
  if (covered.length > 0) {
    streams.log(`SYMBOL-STRICT-COVERED: 基线内 ${covered.length} 条只计数不判红（注释但非文档注释 ${covered.length - cited} 条、逐字引用注释文案 ${cited} 条）——理由逐条写在 ${baseline.path} 的 note 字段里`);
  }
  if (stale.length > 0) {
    streams.log(`STALE-SYMBOL: ${stale.length} 条符号基线条目已不再命中（锚点被重锚到代码行，或文档已改写）——删掉这些条目，否则符号基线会慢慢变成免罚名单：`);
    for (const entry of stale.slice(0, 20)) {
      streams.log(`  · ${entry.doc} → ${entry.reference}（${entry.reason}，owner=${entry.owner ?? '未标'}）`);
    }
  }
}

// —— 基线 ————————————————————————————————————————————————————————————
export const baselineKey = entry => `${entry.path}|${entry.reason}|${entry.reference}`;

/** 读基线；文件不存在按空基线处理（首次落地前的合法状态），坏 JSON 直接抛。 */
export function loadBaseline(root, baselinePath = DEFAULT_BASELINE) {
  const absolute = resolve(root, baselinePath);
  if (!existsSync(absolute)) return { path: baselinePath, entries: [], missing: true };
  const parsed = JSON.parse(readFileSync(absolute, 'utf8'));
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  for (const entry of entries) {
    if (typeof entry.path !== 'string' || typeof entry.reference !== 'string' || typeof entry.reason !== 'string') {
      throw new Error(`基线条目缺字段（需要 path / reason / reference）：${JSON.stringify(entry)}`);
    }
    if (!REASONS.includes(entry.reason)) throw new Error(`基线条目的 reason 不是登记的四类之一（${REASONS.join(' / ')}）：${entry.reason}`);
  }
  return { path: baselinePath, entries, missing: false };
}

/** 把全量 findings 与基线比对：返回新增（未登记）与陈旧（登记了但已不命中）。 */
export function partitionByBaseline(findings, entries) {
  const known = new Map();
  for (const entry of entries) {
    const key = baselineKey(entry);
    known.set(key, (known.get(key) ?? 0) + 1);
  }
  const fresh = [];
  const covered = [];
  for (const finding of findings) {
    const key = baselineKey(finding);
    const remaining = known.get(key) ?? 0;
    if (remaining > 0) {
      known.set(key, remaining - 1);
      covered.push(finding);
    } else {
      fresh.push(finding);
    }
  }
  const stale = [];
  for (const entry of entries) {
    const key = baselineKey(entry);
    const remaining = known.get(key) ?? 0;
    if (remaining > 0) {
      known.set(key, remaining - 1);
      stale.push(entry);
    }
  }
  return { fresh, covered, stale };
}

/** 生成基线 JSON 文本（键序固定，便于 diff 审阅）。 */
export function renderBaseline(findings) {
  const entries = findings.map(finding => ({
    path: finding.path,
    reason: finding.reason,
    owner: finding.owner,
    reference: finding.reference,
  }));
  const document = {
    schema_version: 1,
    note: '文档手写行号的已知遗留（BROKEN／OUT_OF_RANGE／SUSPECT／NOT_SYMBOL_LINE）。--strict 只报本文件之外的**新增**；条目修好后会变「陈旧」，tests/unit/doc-anchors-guard.test.mjs 会点名要求删除。⛔ 不要为了让门禁变绿而把新问题追加进来。',
    generated_by: 'node tools/verify-doc-anchors.mjs --emit-baseline',
    entries,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

// —— 裸锚点孤儿册（BARE_ORPHAN ＋ 作用域外本会红）——————————————————————————
/**
 * 孤儿册的键：`文档|原文|原因`（作用域外本会红：`文档|引用|原因`）。
 *
 * **不含文档行号**——这是刻意的：键里带行号时，在某页顶部插一行空行会让整页键同时错位，一次刷出成批的
 * 「新增 + 陈旧」（实测 25 新增 / 25 陈旧），真正的增删被噪声埋掉。改成「文档 + 原文 + 原因」之后，同一个
 * 裸锚点在一页出现多次由**重数法**承担（登记 3 条就免罚 3 条），插行不再改变任何键。
 */
export const orphanKey = item => `${item.doc}|${item.raw}|${item.reason}`;
/** 作用域外「本会红」的继承锚点：`reference` 已经带路径（继承来的），键同样不带文档行号。 */
export const outsideRedKey = item => `${item.doc}|${item.reference}|${item.reason}`;
/** 孤儿册 `accept` 账本条目：写模式必须留名，理由落进文件、进 diff。 */
const ORPHAN_REASONS = new Set(['no-explicit-in-block', 'ambiguous-block']);

/**
 * 写模式的**人工裁决闸门**：生成基线不是门禁的一部分，必须有人签名。
 *
 * 三件同时要求：`--accept=<n>` 与实际增量**逐条对得上**（不是「随便给个数」）、`--why` 非空、且**不在 CI 里**
 * （`CI`／`GITHUB_ACTIONS` 命中即拒绝）。理由：写模式只写不判，若允许「红 → write → 绿」在 CI 里自动跑，
 * 那等于给「删掉路径前缀」开了一条自助通道；把 write 限定在本地 + 显式 accept/why，它才是一次可评审的动作。
 */
const CI_ENV_KEYS = Object.freeze(['CI', 'GITHUB_ACTIONS', 'CONTINUOUS_INTEGRATION']);

export function assertWritable({ accept, why, expected, label }) {
  const inCi = CI_ENV_KEYS.find(key => {
    const value = process.env[key];
    return value !== undefined && value !== '' && value !== '0' && value !== 'false';
  });
  if (inCi !== undefined) {
    throw new Error(`${label} 在 CI 环境（检测到 ${inCi}）里被拒绝执行：生成基线是人工裁决，不能由门禁自己改基线。请在本地复核后提交。`);
  }
  if (typeof why !== 'string' || why.trim() === '') {
    throw new Error(`${label} 必须带 --why="<理由>"：这句理由会写进基线的 accept 账本，评审靠它知道这次为什么放行。`);
  }
  if (accept === null || !Number.isInteger(accept)) {
    throw new Error(`${label} 必须带 --accept=<n>（本次实际新增／净增减的条数），收到：${accept === null ? '（未给）' : accept}`);
  }
  if (accept !== expected) {
    throw new Error(`${label} 的 --accept=${accept} 与实际增量 ${expected} 不符：` +
      '先看清 diff 里到底多了几条，再按实际条数落盘——数字对不上就是没复核。');
  }
}

/** 读孤儿册；文件不存在按空册处理（首次落地前的合法状态），坏结构直接抛。 */
export function loadOrphanBaseline(root, baselinePath = DEFAULT_ORPHAN_BASELINE) {
  const absolute = resolve(root, baselinePath);
  if (!existsSync(absolute)) return { path: baselinePath, orphans: [], outsideRed: [], accept: [], missing: true };
  const parsed = JSON.parse(readFileSync(absolute, 'utf8'));
  const readList = (name, list, reasons) => {
    if (list === undefined) return [];
    if (!Array.isArray(list)) throw new Error(`孤儿册的 ${name} 字段必须是字符串数组：${baselinePath}`);
    let previous = null;
    for (const key of list) {
      if (typeof key !== 'string' || key.split('|').length !== 3) {
        throw new Error(`孤儿册 ${name} 的条目必须是「文档|原文|原因」三段形状的字符串：${JSON.stringify(key)}`);
      }
      const [doc, , reason] = key.split('|');
      if (doc.trim() === '') throw new Error(`孤儿册 ${name} 的条目缺文档路径：${JSON.stringify(key)}`);
      if (!reasons.has(reason)) {
        throw new Error(`孤儿册 ${name} 的原因只能是 ${[...reasons].join('／')}（收到：${JSON.stringify(reason)}）`);
      }
      // 生成器排序落盘；手写插入的行几乎一定破坏顺序，顺手把「有人手改过」暴露出来。
      if (previous !== null && key < previous) {
        throw new Error(`孤儿册 ${name} 未按字典序排列（${JSON.stringify(previous)} 之后是 ${JSON.stringify(key)}）：这份文件只由 --write-orphan-baseline 生成，不要手写。`);
      }
      previous = key;
    }
    return list;
  };
  const orphans = readList('orphans', parsed.orphans, ORPHAN_REASONS);
  const outsideRed = readList('outsideRed', parsed.outsideRed, new Set(REASONS));
  const accept = Array.isArray(parsed.accept) ? parsed.accept : [];
  const last = accept[accept.length - 1];
  if (accept.length > 0) {
    if (typeof last !== 'object' || last === null || typeof last.why !== 'string' || last.why.trim() === '') {
      throw new Error(`孤儿册的 accept 账本条目必须是 { why, orphans, outsideRed } 形状且 why 非空：${JSON.stringify(last)}`);
    }
    if (last.orphans !== orphans.length || last.outsideRed !== outsideRed.length) {
      throw new Error(`孤儿册与 accept 账本对不上：账本记 orphans=${last.orphans}／outsideRed=${last.outsideRed}，实际 ${orphans.length}／${outsideRed.length}。` +
        '手改条目必须重新走 --write-orphan-baseline（带 --accept 与 --why）——这是「谁放行的」在 diff 里留痕的唯一方式。');
    }
  }
  return { path: baselinePath, orphans, outsideRed, accept, missing: false };
}

/**
 * 重数法比对（与 `partitionByBaseline` 同构）：同名键登记了几条就只免罚几条，多出来的算新增。
 * `entries` 既接受已算好的字符串键，也接受对象（好让调用方直接传 `loadOrphanBaseline` 的条目）。
 *
 * `scannedDocs`／`docExists` 只影响**陈旧**判定：孤儿册按两种扫描面（`--strict` 的默认面、CI 的
 * `--scan docs`）共用一份文件，若把「本次没扫到的文档」也算陈旧，就跑哪个面都会刷一片假陈旧。键的第一段
 * 是文档路径（仓内相对路径没有 `|`），据此跳过「文件还在、只是不在本次扫描面里」的条目。
 * 但**文件根本不存在**的条目必须照报陈旧——否则册子里塞一条指向不存在文档的假条目就永久隐身了。
 */
export function partitionOrphanBaseline(items, keyOf, entries, scannedDocs = null, docExists = null) {
  const keyOfEntry = entry => (typeof entry === 'string' ? entry : keyOf(entry));
  const docOfKey = key => String(key).slice(0, String(key).indexOf('|'));
  const known = new Map();
  for (const entry of entries) {
    const key = keyOfEntry(entry);
    known.set(key, (known.get(key) ?? 0) + 1);
  }
  const fresh = [];
  const covered = [];
  for (const item of items) {
    const key = keyOf(item);
    const remaining = known.get(key) ?? 0;
    if (remaining > 0) {
      known.set(key, remaining - 1);
      covered.push(item);
    } else {
      fresh.push(item);
    }
  }
  const stale = [];
  for (const entry of entries) {
    const key = keyOfEntry(entry);
    const doc = docOfKey(key);
    if (scannedDocs !== null && !scannedDocs.has(doc) && (docExists === null || docExists(doc))) continue;
    const remaining = known.get(key) ?? 0;
    if (remaining > 0) {
      known.set(key, remaining - 1);
      stale.push(key);
    }
  }
  return { fresh, covered, stale };
}

/**
 * 生成孤儿册 JSON：两个数组都**排序**后再落盘，同一棵树上重复生成必须逐字节相同
 * （否则每次重跑都是一片挪行噪声，评审时看不出真正的增删）。
 *
 * `accept` 账本是**追加式**的：每次写盘追加一条 `{ why, accept, orphans, outsideRed }`，读回来的 loader 会校
 * 「最后一条与实际条数一致」——手改数组而不重跑写模式，当场报错。
 */
export function renderOrphanBaseline({ orphans, outsideRed, accept = null, ledger = [] }) {
  const keys = orphans.map(orphanKey).sort();
  const outsideKeys = outsideRed.map(outsideRedKey).sort();
  const entries = [...ledger];
  if (accept !== null) {
    entries.push({ why: accept.why, accept: accept.accepted, orphans: keys.length, outsideRed: outsideKeys.length });
  }
  const document = {
    schema_version: 1,
    note: '归不到路径的裸锚点（BARE_ORPHAN）与「作用域外、按同口径本会红」的继承锚点快照。键 = 文档|原文|原因（outsideRed 为 文档|引用|判据），**键里没有行号**，所以插行不会刷出成批的假增删。--strict 对「基线外新增」与「陈旧」都判红；改这份文件只能走 --write-orphan-baseline（带 --accept=<实际新增条数> 与 --why="<理由>"，CI 里拒绝执行），理由落进下面的 accept 账本。⛔ 删掉文档里的路径前缀会在这里留下增删——那正是它该有的评审痕迹。',
    generated_by: 'node tools/verify-doc-anchors.mjs --write-orphan-baseline --accept=<n> --why="<理由>"',
    accept: entries,
    orphans: keys,
    outsideRed: outsideKeys,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** 孤儿册的读数行：登记多少、命中多少、基线外新增多少、陈旧多少，以及最后一次放行的理由。 */
function printOrphanBaseline(streams, { baseline, orphans, outside, orphanTotal, outsideTotal }) {
  streams.log(`BARE-ORPHAN: ${BARE_ORPHAN} ${orphanTotal} 条归不到路径的裸锚点——册 ${baseline.path} 登记 ${baseline.orphans.length} 条；本次命中 ${orphans.covered.length} 条、基线外新增 ${orphans.fresh.length} 条、本次扫描面内陈旧 ${orphans.stale.length} 条（新增与陈旧在 --strict 下都判红）`);
  streams.log(`BARE-ORPHAN-OUTSIDE: 作用域外「本会红」${outsideTotal} 条——同一册 outsideRed 登记 ${baseline.outsideRed.length} 条；命中 ${outside.covered.length} 条、基线外新增 ${outside.fresh.length} 条、陈旧 ${outside.stale.length} 条`);
  if (baseline.missing) streams.log(`NOTE: 孤儿册 ${baseline.path} 不存在，按空册处理（等于每一条孤儿都算新增）。`);
  const last = baseline.accept[baseline.accept.length - 1];
  if (last !== undefined) streams.log(`BARE-ORPHAN-ACCEPT: 最近一次放行 ${last.why}（当时 accept=${last.accept}、orphans=${last.orphans}、outsideRed=${last.outsideRed}）`);
  const staleKeys = [...orphans.stale, ...outside.stale];
  if (staleKeys.length > 0) {
    streams.log(`STALE-ORPHAN: ${staleKeys.length} 条孤儿册条目已不再命中（那条裸锚点补回路径了、或文档改写／删段了）——删掉这些行，否则册子会慢慢变成免罚名单。删除同样要重跑 --write-orphan-baseline（它会把这件事记进 accept 账本）：`);
    for (const key of staleKeys.slice(0, 20)) streams.log(`  · ${key}`);
  }
}

/**
 * 锚点清册：把「每份文档进判据的锚点条数」也变成判据。
 *
 * 为什么必须另立一份：`BROKEN／OUT_OF_RANGE／SUSPECT／NOT_SYMBOL_LINE` 都只审**出现了的**锚点，于是
 * 「把 `services/api/src/app.js:4` 整条改写成『第 4 行』」能让一条锚点干净地离开判据面而全绿。清册记的是
 * 每份文档「本该有这么多条锚点在判据里」，少一条就得登记——登记要带 `--accept`／`--why`，理由进账本。
 */
export const ANCHOR_COUNT_KEY = 'judged';

export function buildAnchorCounts(judgedByDoc) {
  const counts = new Map();
  for (const [doc, references] of judgedByDoc) counts.set(doc, references.length);
  return counts;
}

/**
 * 键必须是**已经规范化的仓库相对 posix 路径**。
 *
 * 为什么单查这一条：`documents` 的键是「哪些文档受清册管辖」的全部信息，而 `./`、`..`、反斜杠这些写法会让
 * 同一个文档有多个字面形式——把 `docs/architecture/x.md` 改成 `docs/architecture/./x.md` 就能让 `scannedDocs.has()`
 * 查不中（于是这条锚点被跳过、清册总数与账本又都不变）。所以在 loader 里直接拒绝，而不是静默 normalize：
 * 静默 normalize 会让人以为改法生效了。
 */
function assertNormalizedDocKey(doc, baselinePath) {
  const segments = doc.split('/');
  const dirty = doc === '' || doc.includes('\\') || doc.startsWith('/') || doc.endsWith('/') ||
    segments.some(segment => segment === '' || segment === '.' || segment === '..');
  if (dirty) {
    throw new Error(`锚点清册 ${baselinePath} 的键不是规范化的仓库相对路径：${JSON.stringify(doc)}。` +
      '不要写 `./`、`..`、连续斜杠、反斜杠或绝对路径——同一个文档换个写法就能绕过「本次有没有扫到它」的判断，' +
      '所以这里直接报错，不做静默 normalize。');
  }
}

/**
 * 64 位 FNV-1a，返回 16 位大写十六进制。
 *
 * 为什么不是 sha256：本工具的判据刻意**不**用「内容哈希全等」（见文件头），也不 import `node:crypto`
 * （`tests/unit/doc-anchors-guard.test.mjs` 钉着这一条）。这里只给清册**自己的数字**算一个确定性校验和。
 */
function fnv1a64Hex(text) {
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(text, 'utf8')) hash = ((hash ^ BigInt(byte)) * prime) & mask;
  return hash.toString(16).toUpperCase().padStart(16, '0');
}

/**
 * 清册 `documents` 的确定性摘要：`fnv1a64:` + 16 位大写十六进制，覆盖 `total` 与「排序后的 键<TAB>条数」。
 *
 * 用途只有一条：拦住「手改 documents 而不同步重生成」。求和与 accept 账本这两道算术只抓得住**单改一个数字**；
 * 把某文档条数、`judged_total`、账本末条**一起**改，或者干脆整键删掉，算术就自洽了（第五轮复审实测两条都 exit 0）。
 * 摘要把「这张表到底长什么样」钉进文件：手改之后摘要对不上 ⇒ loader 直接 exit 2。
 * 强度说清楚：这是**校验和**不是签名，愿意读源码的人能重算；它拦的是「顺手改册子」，和整本册子可以重生成是同层留痕。
 */
export function anchorCountDocumentsDigest(documents, total) {
  const lines = [`total\t${total}`];
  for (const doc of Object.keys(documents).sort()) lines.push(`${doc}\t${documents[doc]}`);
  return `fnv1a64:${fnv1a64Hex(lines.join('\n'))}`;
}

export function loadAnchorCountBaseline(root, baselinePath = DEFAULT_ANCHOR_COUNT_BASELINE, { allowMissingDigest = false } = {}) {
  const absolute = resolve(root, baselinePath);
  if (!existsSync(absolute)) return { path: baselinePath, documents: {}, total: 0, accept: [], scan: [], missing: true, documents_digest: null };
  const parsed = JSON.parse(readFileSync(absolute, 'utf8'));
  const documents = parsed.documents;
  if (typeof documents !== 'object' || documents === null || Array.isArray(documents)) {
    throw new Error(`锚点清册的 documents 字段必须是「文档路径 → 条数」的对象：${baselinePath}`);
  }
  // 清册记下自己的生成扫描面：本次的面比它窄（默认面 vs `--scan docs`）时，面内的键可以合法跳过；
  // 面外的键（被改成一个根本不在生成面里的文档）必须判红，否则「改名换姓」就是一条免罚通道。
  // ⚠️ 这条面只用来判「合法跳过」，**不能**用来判「扫没扫到」：键落在本次面内却没扫到（`docs/**` 下不是 .md
  // 的路径、或目录名）时，只看这张面就等于每次都被跳过——第二刀在 partitionAnchorCountBaseline（传本次面）。
  const scan = parsed.scan === undefined ? [] : parsed.scan;
  if (!Array.isArray(scan) || scan.some(target => typeof target !== 'string' || target.trim() === '')) {
    throw new Error(`锚点清册的 scan 字段必须是「生成时所扫目录／glob」的字符串数组：${JSON.stringify(parsed.scan)}`);
  }
  let sum = 0;
  for (const [doc, value] of Object.entries(documents)) {
    assertNormalizedDocKey(doc, baselinePath);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`锚点清册 ${doc} 的条数必须是非负整数（收到：${JSON.stringify(value)}）`);
    }
    sum += value;
  }
  if (!Number.isInteger(parsed.judged_total) || parsed.judged_total !== sum) {
    throw new Error(`锚点清册自相矛盾：judged_total=${JSON.stringify(parsed.judged_total)}，但 documents 逐项相加是 ${sum}。` +
      '手改某个文档的条数必须同时重算总数——而这正是「偷偷放宽」最容易露馅的地方。');
  }
  const accept = Array.isArray(parsed.accept) ? parsed.accept : [];
  const last = accept[accept.length - 1];
  if (accept.length > 0) {
    if (typeof last !== 'object' || last === null || typeof last.why !== 'string' || last.why.trim() === '') {
      throw new Error(`锚点清册的 accept 账本条目必须是 { why, accept, judged_total } 形状且 why 非空：${JSON.stringify(last)}`);
    }
    if (last.judged_total !== parsed.judged_total) {
      throw new Error(`锚点清册与 accept 账本对不上：账本记 judged_total=${last.judged_total}，文件里是 ${parsed.judged_total}。` +
        '只改数字不改账本，等于绕过「谁放行的」这一问——请重跑 --write-anchor-count-baseline（带 --accept 与 --why）。');
    }
  }
  // 第三道：`documents` 摘要。前两道算术只抓「单改一个数字」——把文档条数、judged_total、账本末条一起改，
  // 或者整键删掉，算术就自洽了（第五轮复审实测两种都能 exit 0，唯一痕迹是「上升 N 份」）。摘要覆盖整张表，
  // 手改之后必然对不上；只有 --write-anchor-count-baseline 会重算它，而那条路会在 accept 账本里留名。
  const digest = anchorCountDocumentsDigest(documents, sum);
  // `allowMissingDigest` 只给**写模式**做引导用：清册还没有摘要字段时（首次引入摘要、或有人把整本册子删了重来），
  // 写模式必须能读到旧册子才能重生成；而重生成会把摘要算准、并在 accept 账本里留一条名。
  // 校验路径（默认）一律要求摘要存在——删掉摘要再手改，走的是这条默认路径，所以还是 exit 2。
  const digestMissing = parsed.documents_digest === undefined;
  if (parsed.documents_digest !== digest && !(allowMissingDigest && digestMissing)) {
    throw new Error(`锚点清册 ${baselinePath} 的 documents 摘要不符（或缺失）：文件里是 ${JSON.stringify(parsed.documents_digest)}，按当前 documents 重算是 ${digest}。` +
      '这张表只能由 --write-anchor-count-baseline（带 --accept 与 --why）重生成——手改条数、judged_total 与账本末条' +
      '三处一起改齐就能绕过求和与账本这两道算术，摘要正是为这一步准备的：不许手改。');
  }
  return { path: baselinePath, documents, total: sum, accept, scan, missing: false, documents_digest: digest };
}

/**
 * 键是否落在某个扫描面里（`scan: ['docs']` ⇒ `docs/**`）。
 *
 * **认 glob**：`resolveScanTargets` 允许 `--scan 'docs/**\/*.md'` 这样的面（文件头与 USAGE 都写着），
 * 而「面」与「扫」必须同一口径——只做前缀比较的话，glob 面下任何键都匹配不上，
 * 「面内却扫不到」这一刀就成了不可达代码（第五轮复审 B1：改 CI 那一行参数即可关掉清册判据）。
 * 这里复用 `resolveScanTargets` 用的同一个 `globToRegExp`，不另造一套通配语义。
 */
function isInsideFace(doc, face) {
  return face.some(target => {
    const normalized = toPosix(target).replace(/^\.\//, '').replace(/\/+$/u, '');
    if (normalized.includes('*')) return globToRegExp(normalized).test(doc);
    return doc === normalized || doc.startsWith(`${normalized}/`);
  });
}

/**
 * 键本身长得像「`walkMarkdown` 会收的文档」吗？只判形状，不碰磁盘。
 *
 * `docs/**` 下不是 `.md` 的路径（`…/contract-status.json`）、目录名（`docs/architecture`）、
 * 落在 `SKIP_DIRECTORIES` 或 `.` 开头目录里的路径，`walkMarkdown` **永远不会**收它们。
 * 这种键在任何扫描面下都不许算「合法跳过」：算的话，把键换成这类名字就等于让那份文档永久退出判据面，
 * 而 judged_total、账本、摘要三处一个数字都不用动。
 */
function isCollectibleDocKey(doc) {
  if (!doc.endsWith('.md')) return false;
  return doc.split('/').slice(0, -1).every(segment =>
    segment === '.github' || (!segment.startsWith('.') && !SKIP_DIRECTORIES.has(segment)));
}

/**
 * 比对：只判「减少」。某份文档的进判据锚点比基线少 ⇒ 红（少掉的那条必须写回路径，或登记成一条 accept）。
 * 增加不判红（有人在文档里补了引用是好事），只报读数。
 *
 * **没扫到的键**要看「它在不在**本次运行面**里」，而不是只看「它在不在**清册记下的生成面**里」。
 * 只看后者会留一条通用通道：把键写成 `docs/**` 下**任何人扫不到**的名字（非 `.md` 的路径，或目录名），
 * 它就永远落在「清册面内、本次没扫到」，于是每次都被当成合法跳过——`judged_total` 一条不少、账本也对，
 * 这份文档却已经永久退出判据面，连 `--accept` 都不用记。所以「没扫到」分四桶，只有最后一桶算合法：
 * - 键根本不是可扫的文档（不是 `.md`，或落在 `walkMarkdown` 跳过的目录里）⇒ 判红（`collectible: false`）；
 * - 键在本次运行面内，却没扫到 ⇒ 判红（`inRunFace: true`）；
 * - 两张面都不在（把键改名成 `README.md` 这类面外文档）⇒ 判红（`inBookFace: false`）；
 * - 可扫的文档、在清册记下的生成面内、但不在本次面内（默认面 vs `--scan docs` 的日常）⇒ 合法跳过，只计数。
 * 少了任何一刀，「换个文档名」「换成一个扫不到的名字」「换成一个 glob 面」都能让某份文档永远退出判据面，
 * 而求和、账本、摘要全都对得上。
 *
 * `face` 只该由调用点传**本次运行面**（`options.scan`）；不传时退回清册自己记的面——那是「本次面未知」
 * 的保守近似，不是这次要判的那一刀。
 */
export function partitionAnchorCountBaseline(counts, baseline, scannedDocs = null, docExists = null, face = null) {
  const bookFace = baseline.scan ?? [];
  const runFace = face ?? bookFace;
  const drops = [];
  const unscanned = [];
  let skipped = 0;
  for (const [doc, expected] of Object.entries(baseline.documents)) {
    if (scannedDocs !== null && !scannedDocs.has(doc) && (docExists === null || docExists(doc))) {
      const inRunFace = runFace.length > 0 && isInsideFace(doc, runFace);
      const inBookFace = bookFace.length > 0 && isInsideFace(doc, bookFace);
      const collectible = isCollectibleDocKey(doc);
      if (collectible && !inRunFace && inBookFace) {
        skipped += 1;
      } else {
        unscanned.push({
          doc,
          expected,
          inRunFace,
          inBookFace,
          collectible,
          reason: !collectible
            ? '键不是一份可扫的 Markdown 文档（不是 .md，或落在 walkMarkdown 跳过的目录里）——这种名字任何扫描面都扫不到'
            : bookFace.length === 0
              ? '清册没有记下生成扫描面'
              : inRunFace
                ? '键在本次扫描面内，却没扫到它——不是 .md，或落在 walkMarkdown 跳过的目录里'
                : '键不在清册记下的生成扫描面内',
        });
      }
      continue;
    }
    const actual = counts.get(doc) ?? 0;
    if (actual < expected) drops.push({ doc, expected, actual });
  }
  const growth = [];
  for (const [doc, actual] of counts) {
    const expected = baseline.documents[doc] ?? 0;
    if (actual > expected) growth.push({ doc, expected, actual });
  }
  return { drops, growth, unscanned, skipped };
}

export function renderAnchorCountBaseline({ counts, baseline, accept = null, ledger = [], scan = [] }) {
  const documents = {};
  for (const doc of [...counts.keys()].sort()) documents[doc] = counts.get(doc);
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  const entries = [...ledger];
  if (accept !== null) entries.push({ why: accept.why, accept: accept.accepted, judged_total: total });
  const document = {
    schema_version: 1,
    note: '按文档的「进判据锚点条数」清册（显式锚点 + 继承到路径的裸锚点，按文档计数、不去重以避免同一行多引用的假象）。--strict 判：某文档条数比这里少 ⇒ exit 1（少掉的那条锚点必须写回路径，或用 --write-anchor-count-baseline --accept=<净增减> --why="<理由>" 登记）。judged_total 必须等于 documents 逐项之和，且最后一条 accept 账本的 judged_total 必须与之一致——单改一个数字会当场被这两道算术抓住。scan 记下生成时的扫描面：本次跑的面更窄（默认面）时可跳过面内的键，面外的键（改名成别的文档）照样判红。documents_digest 钉住这张表本身（judged_total + 排序后的 键/条数）：把条数、judged_total、账本末条三处一起改齐也会被摘要抓住，摘要只由 --write-anchor-count-baseline 重算，不许手改。',
    generated_by: 'node tools/verify-doc-anchors.mjs --scan <目录> --write-anchor-count-baseline --accept=<净增减> --why="<理由>"',
    scan: [...new Set(scan)].sort(),
    judged_total: total,
    documents_digest: anchorCountDocumentsDigest(documents, total),
    accept: entries,
    documents,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

function printAnchorCountBaseline(streams, { baseline, counts, partition }) {
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  const registered = Object.keys(baseline.documents).length;
  const uncollectible = partition.unscanned.filter(item => !item.collectible).length;
  const outOfFace = partition.unscanned.filter(item => item.collectible && !item.inRunFace).length;
  const insideButUnscanned = partition.unscanned.length - outOfFace - uncollectible;
  streams.log(`ANCHOR-COUNT: 进判据锚点 ${total} 条 / ${counts.size} 份文档——清册 ${baseline.path} 登记 ${baseline.total} 条 / ${registered} 份；本次计数下降的文档 ${partition.drops.length} 份、上升 ${partition.growth.length} 份、面外未扫的键 ${outOfFace} 个、面内本次未扫 ${partition.skipped} 个（清册面内、本次面外：合法跳过）、面内却扫不到的键 ${insideButUnscanned} 个（按本次面本该扫到却没扫到：判红）、永远扫不到的键 ${uncollectible} 个（键根本不是可扫的文档：判红）`);
  if (baseline.missing) streams.log(`NOTE: 锚点清册 ${baseline.path} 不存在，按空册处理（不判「该出现的锚点仍在」这一条）。`);
  const last = baseline.accept[baseline.accept.length - 1];
  if (last !== undefined) streams.log(`ANCHOR-COUNT-ACCEPT: 最近一次放行 ${last.why}（当时 accept=${last.accept}、judged_total=${last.judged_total}）`);
}

// —— CLI ——————————————————————————————————————————————————————————————
const USAGE = 'usage: node tools/verify-doc-anchors.mjs [--strict] [--scan <目录或glob>]... [--baseline <路径>] [--orphan-baseline <路径>] [--anchor-count-baseline <路径>] [--root <目录>] [--symbol=count|strict] [--emit-baseline | --write-baseline] [--emit-orphan-baseline | --write-orphan-baseline] [--emit-anchor-count-baseline | --write-anchor-count-baseline --accept <净增减> --why "理由"]';
const KNOWN_FLAGS = new Set(['--strict', '--scan', '--baseline', '--orphan-baseline', '--anchor-count-baseline', '--root', '--symbol', '--emit-baseline', '--write-baseline', '--emit-orphan-baseline', '--write-orphan-baseline', '--emit-anchor-count-baseline', '--write-anchor-count-baseline', '--accept', '--why']);
/** `--symbol` 的取值是**白名单**：不认识的取值直接报错退出，绝不当成「没传、照旧绿灯」。 */
const SYMBOL_MODES = new Set(['count', 'strict']);
const MAX_PRINTED = 300;
const MAX_PRINTED_UNDECIDABLE = 500;
/** `BARE_ORPHAN` 的逐条打印上限：作用域内全列，作用域外的历史取证页只抽样（数字仍在汇总行）。 */
const MAX_PRINTED_ORPHAN_OUTSIDE = 40;

export function parseArgs(argv) {
  const options = { strict: false, scan: [], baseline: DEFAULT_BASELINE, orphanBaseline: DEFAULT_ORPHAN_BASELINE, anchorCountBaseline: DEFAULT_ANCHOR_COUNT_BASELINE, root: TOOL_ROOT, symbol: null, accept: null, why: null, emit: false, write: false, emitOrphan: false, writeOrphan: false, emitCount: false, writeCount: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [flag, inline] = argument.includes('=') ? [argument.slice(0, argument.indexOf('=')), argument.slice(argument.indexOf('=') + 1)] : [argument, undefined];
    // 未知参数一律报错退出：参数被静静忽略却显示绿灯，比没有这个参数更糟。
    if (!KNOWN_FLAGS.has(flag)) throw new Error(`未知参数：${argument}\n${USAGE}`);
    const value = () => {
      if (inline !== undefined) return inline;
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} 缺少取值\n${USAGE}`);
      return argv[index];
    };
    if (flag === '--strict') options.strict = true;
    else if (flag === '--emit-baseline') options.emit = true;
    else if (flag === '--write-baseline') options.write = true;
    else if (flag === '--emit-orphan-baseline') options.emitOrphan = true;
    else if (flag === '--write-orphan-baseline') options.writeOrphan = true;
    else if (flag === '--emit-anchor-count-baseline') options.emitCount = true;
    else if (flag === '--write-anchor-count-baseline') options.writeCount = true;
    else if (flag === '--scan') options.scan.push(value());
    else if (flag === '--baseline') options.baseline = value();
    else if (flag === '--orphan-baseline') options.orphanBaseline = value();
    else if (flag === '--anchor-count-baseline') options.anchorCountBaseline = value();
    else if (flag === '--accept') {
      const raw = value();
      if (!/^-?\d+$/.test(raw)) throw new Error(`--accept 只接受整数（收到：${raw}）\n${USAGE}`);
      options.accept = Number.parseInt(raw, 10);
    }
    else if (flag === '--why') options.why = value();
    else if (flag === '--root') options.root = resolve(value());
    else if (flag === '--symbol') {
      const mode = value();
      if (!SYMBOL_MODES.has(mode)) throw new Error(`--symbol 只支持 ${[...SYMBOL_MODES].join('|')}（收到：${mode}）\n${USAGE}`);
      options.symbol = mode;
    }
  }
  if (options.emit && options.write) throw new Error('--emit-baseline 与 --write-baseline 只能二选一');
  if (options.emitOrphan && options.writeOrphan) throw new Error('--emit-orphan-baseline 与 --write-orphan-baseline 只能二选一');
  if (options.emitCount && options.writeCount) throw new Error('--emit-anchor-count-baseline 与 --write-anchor-count-baseline 只能二选一');
  const generating = [
    options.emit || options.write,
    options.emitOrphan || options.writeOrphan,
    options.emitCount || options.writeCount,
  ].filter(Boolean).length;
  if (generating > 1) {
    throw new Error('四份基线的生成要分别做：--emit/--write-baseline、--emit/--write-orphan-baseline、--emit/--write-anchor-count-baseline 一次只能选一组');
  }
  const writing = options.write || options.writeOrphan || options.writeCount;
  if (generating > 0 && options.symbol !== null) {
    throw new Error(`--symbol=${options.symbol} 不能与基线生成同时用（生成基线时统计会被忽略）`);
  }
  // `--accept`／`--why` 只在**写模式**有意义：干跑时给它们会让人以为「已经登记过了」。
  if (!writing && (options.accept !== null || options.why !== null)) {
    throw new Error('--accept 与 --why 只跟 --write-*-baseline 一起用（试运行不接受「放行」参数）');
  }
  if (options.scan.length === 0) options.scan = [...DEFAULT_SCAN_TARGETS];
  return options;
}

function describe(finding) {
  // 裸锚点（`:130`）报错时必须带上「它继承了谁」——否则读者看到 `→ app.ts:130` 会不知道这个路径是从哪来的。
  const inherited = finding.inheritedFrom === undefined
    ? ''
    : `［裸锚点，继承同块 ${finding.inheritedFrom.reference}（文档第 ${finding.inheritedFrom.docLine} 行）］`;
  return `${finding.reason} ${finding.doc}:${finding.docLine} → ${finding.reference}${inherited}（${finding.detail}；owner=${finding.owner}）`;
}

/**
 * 孤儿（`BARE_ORPHAN`）的逐条描述：文档、行号、原文、原因、片段，`ambiguous-block` 连候选路径一起打。
 * 候选是归属时**已经算出来的**事实，不打出来等于让读者回去手数同块里的显式锚点。
 */
function describeOrphan(item) {
  const candidates = Array.isArray(item.candidates) && item.candidates.length > 0
    ? `；候选 ${item.candidates.join(' / ')}`
    : '';
  return `${item.doc}:${item.docLine} ${item.raw}（${item.reason}${candidates}）｜${item.text}`;
}

/**
 * `NOT_SYMBOL_LINE` 的报错正文：一眼能改对——说清注释块的行区间、**该注释块后面的声明行是哪个
 * `path:N`**、以及那段注释的首行（截断），作者不用回目标文件里自己找「到底该指哪一行」。
 */
function describeSymbolMiss({ target, span, declaration }) {
  const head = (String(span.text).split('\n')[0] ?? '').trim().slice(0, 60);
  const symbol = declaration.symbol === null ? '' : `（${declaration.symbol}）`;
  return `符号引脚落在第 ${span.start}-${span.end} 行的注释里；该注释块后面的声明行是 ${target}:${declaration.line}${symbol}；注释首行「${head}」`;
}

export function main(argv = process.argv.slice(2), streams = { log: console.log, error: console.error }) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    streams.error(error.message);
    return 2;
  }
  const { findings, stats, unresolved, commentAnchors, bareOrphans, outsideRedAnchors, judgedByDoc } = collectFindings({ root: options.root, targets: options.scan });
  const anchorCounts = buildAnchorCounts(judgedByDoc);
  if (options.emit) {
    process.stdout.write(renderBaseline(findings));
    return 0;
  }
  if (options.write) {
    const absolute = resolve(options.root, options.baseline);
    writeFileSync(absolute, renderBaseline(findings));
    streams.log(`WRITE: 已写 ${options.baseline}（${findings.length} 条）。基线是**人工裁决**的结果，提交前逐条看过；新问题不要往里加。`);
    return 0;
  }
  if (options.emitOrphan) {
    process.stdout.write(renderOrphanBaseline({ orphans: bareOrphans, outsideRed: outsideRedAnchors }));
    return 0;
  }
  if (options.writeOrphan) {
    // 现有册子可能还是旧格式（键里带行号）：那说明这是一次**格式迁移**，整份重登——于是 accept 会很大，
    // 而这正是它该有的样子：口径变了就是变了一遍，不该被伪装成「只多了三条」。
    let current;
    try {
      current = loadOrphanBaseline(options.root, options.orphanBaseline);
    } catch (error) {
      streams.log(`NOTE: 现有孤儿册按当前格式无法解析（${String(error.message).split('\n')[0]}）——本次按空册重登，--accept 必须等于全量条目数。`);
      current = { path: options.orphanBaseline, orphans: [], outsideRed: [], accept: [], missing: true };
    }
    const keySet = new Set(current.orphans.map(key => key));
    const outsideSet = new Set(current.outsideRed.map(key => key));
    const freshOrphans = bareOrphans.filter(item => !keySet.has(orphanKey(item)));
    const freshOutside = outsideRedAnchors.filter(item => !outsideSet.has(outsideRedKey(item)));
    try {
      assertWritable({ accept: options.accept, why: options.why, expected: freshOrphans.length + freshOutside.length, label: '--write-orphan-baseline' });
    } catch (error) {
      streams.error(error.message);
      return 2;
    }
    const absolute = resolve(options.root, options.orphanBaseline);
    writeFileSync(absolute, renderOrphanBaseline({
      orphans: bareOrphans,
      outsideRed: outsideRedAnchors,
      accept: { why: options.why, accepted: options.accept },
      ledger: current.accept,
    }));
    streams.log(`WRITE: 已写 ${options.orphanBaseline}（孤儿 ${bareOrphans.length} 条、作用域外本会红 ${outsideRedAnchors.length} 条；本次新增 ${freshOrphans.length + freshOutside.length} 条，与 --accept=${options.accept} 一致）。理由已记进 accept 账本：${options.why}`);
    return 0;
  }
  if (options.emitCount) {
    const current = loadAnchorCountBaseline(options.root, options.anchorCountBaseline);
    process.stdout.write(renderAnchorCountBaseline({ counts: anchorCounts, baseline: current, scan: options.scan.length > 0 ? options.scan : current.scan }));
    return 0;
  }
  if (options.writeCount) {
    const current = loadAnchorCountBaseline(options.root, options.anchorCountBaseline, { allowMissingDigest: true });
    const currentTotal = [...anchorCounts.values()].reduce((sum, value) => sum + value, 0);
    // 这里**没有**「必须显式给 --scan」这道闸：`parseArgs` 在填默认面之后才返回，`options.scan` 永远非空，
    // 写在这种位置的空面检查是死代码（旧注释说「口径必须与 CI 一致」，但 code path 到不了）。
    // 真正挡住「照窄面重写＝静默丢键」的是下面这道 lostKeys：写模式的硬约束是**新键集 ⊇ 旧键集**
    // （实测：默认面 218 份/6111 条 vs `--scan docs` 的 226 份/6217 条，少掉的 8 份在这里被点名拦下），
    // 比「必须给 --scan」更硬——给了 `--scan` 但面仍比清册窄，一样被拦。
    const lostKeys = Object.keys(current.documents).filter(doc => !anchorCounts.has(doc));
    if (lostKeys.length > 0) {
      streams.error(`ERROR: 本次扫描面里没有这 ${lostKeys.length} 份文档，重写会把它们从清册里静默删掉（等于让它们永久退出判据面）：`);
      for (const doc of lostKeys.slice(0, 40)) streams.error(`  · ${doc}（清册 ${current.documents[doc]} 条）`);
      streams.error('  修法：用与 CI 相同的口径重跑（`--scan docs`）；确有文档被删除/移走的，先单独确认，再手工把这次收缩当成一次审查决定处理。');
      return 2;
    }
    try {
      assertWritable({ accept: options.accept, why: options.why, expected: currentTotal - current.total, label: '--write-anchor-count-baseline' });
    } catch (error) {
      streams.error(error.message);
      return 2;
    }
    const absolute = resolve(options.root, options.anchorCountBaseline);
    writeFileSync(absolute, renderAnchorCountBaseline({
      counts: anchorCounts,
      baseline: current,
      accept: { why: options.why, accepted: options.accept },
      ledger: current.accept,
      scan: options.scan,
    }));
    streams.log(`WRITE: 已写 ${options.anchorCountBaseline}（进判据锚点 ${currentTotal} 条 / ${anchorCounts.size} 份文档；净增减 ${currentTotal - current.total} 条，与 --accept=${options.accept} 一致）。理由已记进 accept 账本：${options.why}`);
    return 0;
  }
  const baseline = loadBaseline(options.root, options.baseline);
  const { fresh, covered, stale } = partitionByBaseline(findings, baseline.entries);
  // dry-run 打全量清单（人工排查用）；--strict 只打归纳，失败清单走 stderr——
  // 否则上百条历史遗留会把台账工具的 PASS 行淹掉，看门禁的人反而找不到真信号。
  if (!options.strict) {
    const printed = findings.slice(0, MAX_PRINTED);
    for (const finding of printed) streams.log(describe(finding));
    if (findings.length > printed.length) streams.log(`… 另有 ${findings.length - printed.length} 条未打印（清单同上格式）`);
  }
  printSummary(streams, { stats, unresolved, findings, fresh, covered, stale, baseline, strict: options.strict });
  printBareOrphans(streams, bareOrphans);
  let orphanBaseline;
  try {
    orphanBaseline = loadOrphanBaseline(options.root, options.orphanBaseline);
  } catch (error) {
    streams.error(`ERROR: ${error.message}`);
    return 2;
  }
  const scannedDocs = new Set(resolveScanTargets(options.root, options.scan));
  const docExists = docPath => existsSync(resolve(options.root, docPath));
  const orphanPartition = partitionOrphanBaseline(bareOrphans, orphanKey, orphanBaseline.orphans, scannedDocs, docExists);
  const outsidePartition = partitionOrphanBaseline(outsideRedAnchors, outsideRedKey, orphanBaseline.outsideRed, scannedDocs, docExists);
  printOrphanBaseline(streams, {
    baseline: orphanBaseline,
    orphans: orphanPartition,
    outside: outsidePartition,
    orphanTotal: bareOrphans.length,
    outsideTotal: outsideRedAnchors.length,
  });
  // 两份册子都可能被人手改：写法不是「相信它」，而是让**算术对不上**当场炸出来（见各自的 loader）。
  let anchorCountBaseline;
  try {
    anchorCountBaseline = loadAnchorCountBaseline(options.root, options.anchorCountBaseline);
  } catch (error) {
    streams.error(`ERROR: ${error.message}`);
    return 2;
  }
  // 第 5 参是**本次运行面**：键在面内却没扫到（`docs/**` 下不是 .md 的路径、或目录名）必须判红，
  // 不能因为「它在清册记下的那个更宽的面里」就永远算合法跳过（那是一条零账本的退出通道）。
  const countPartition = partitionAnchorCountBaseline(anchorCounts, anchorCountBaseline, scannedDocs, docExists, options.scan);
  printAnchorCountBaseline(streams, { baseline: anchorCountBaseline, counts: anchorCounts, partition: countPartition });
  // 明细只在 dry-run 打：--strict 的失败清单走 stderr（同结构四判据的既有分工，免得同一份清单打印两遍）。
  if (countPartition.drops.length > 0 && !options.strict) {
    streams.log(`ANCHOR-COUNT-DROP: ${countPartition.drops.length} 份文档的「进判据锚点」比清册少（--strict 下判红）：`);
    for (const drop of countPartition.drops.slice(0, 20)) {
      streams.log(`  · ${drop.doc}：清册 ${drop.expected} 条 → 本次 ${drop.actual} 条（少 ${drop.expected - drop.actual} 条）`);
    }
  }
  const drift = collectAnchorDrift({ root: options.root, targets: options.scan });
  const driftPartition = partitionDriftByBaseline(drift.findings);
  printDriftSummary(streams, { drift, partition: driftPartition });
  if (options.symbol === 'count') printSymbolCount(streams, countSymbolAssociations({ root: options.root, targets: options.scan }));
  // `--symbol=strict`：只在这里才读符号基线（`--symbol=count` 与其余路径的行为、文案一字不改）。
  let symbolStrict = null;
  if (options.symbol === 'strict') {
    const symbolBaseline = loadSymbolBaseline(options.root);
    const partition = partitionSymbolByBaseline(commentAnchors, symbolBaseline.entries);
    symbolStrict = { baseline: symbolBaseline, ...partition };
    printSymbolStrict(streams, { stats, baseline: symbolBaseline, anchors: commentAnchors.length, ...partition });
    if (symbolBaseline.missing) {
      streams.log(`NOTE: 符号基线 ${symbolBaseline.path} 不存在，按空基线处理（等于所有未落代码行的锚点都算新增）。`);
    }
  }
  if (baseline.missing) streams.log(`NOTE: 基线 ${options.baseline} 不存在，按空基线处理（等于所有问题都算新增）。`);
  if (stale.length > 0) {
    streams.log(`STALE: ${stale.length} 条基线已不再命中（引用被修好或路径改名）——删掉这些条目，否则基线会慢慢变成免罚名单：`);
    for (const entry of stale.slice(0, 20)) streams.log(`  · ${entry.reference}（${entry.reason}，owner=${entry.owner ?? '未标'}）`);
  }
  if (driftPartition.stale.length > 0) {
    // 与结构基线同语义：陈旧只提示不判红——历史树锚点被修掉之后，基线腐烂不该把合并永久卡死。
    streams.log(`STALE-DRIFT: ${driftPartition.stale.length} 条 ARCHITECTURE_ANCHOR_BASELINE 条目已不再命中（文档行改过片段，或那条漂移已修好）——删掉/更新这些 key：`);
    for (const entry of driftPartition.stale.slice(0, 20)) streams.log(`  · ${entry}`);
  }
  const structuralFailed = options.strict && fresh.length > 0;
  const driftFailed = options.strict && driftPartition.fresh.length > 0;
  const symbolStrictFailed = options.strict && symbolStrict !== null && symbolStrict.fresh.length > 0;
  const orphanFailed = options.strict && (orphanPartition.fresh.length > 0 || outsidePartition.fresh.length > 0 || orphanPartition.stale.length > 0 || outsidePartition.stale.length > 0);
  const countFailed = options.strict && (countPartition.drops.length > 0 || countPartition.unscanned.length > 0);
  if (structuralFailed) {
    streams.error(`FAIL: 文档行号闸门未通过（基线之外新增 ${fresh.length} 条）`);
    for (const finding of fresh.slice(0, 40)) streams.error(`  · ${describe(finding)}`);
  }
  if (driftFailed) {
    streams.error(`FAIL: 锚点身份闸门未通过（ANCHOR_DRIFT 基线之外新增 ${driftPartition.fresh.length} 条；判据只管 ${ANCHOR_DRIFT_SCOPE}**）`);
    for (const finding of driftPartition.fresh.slice(0, 40)) streams.error(`  · ${describeDrift(finding)}`);
    streams.error('  修法：按片段在目标文件里的真实行号改写引用（报错里给了「实际行号」）；确属历史遗留/归属不唯一的，人工裁决后加进 tools/verify-doc-anchors.mjs 的 ARCHITECTURE_ANCHOR_BASELINE 并写明分类。');
  }
  if (symbolStrictFailed) {
    streams.error(`FAIL: 符号落点闸门未通过（--symbol=strict 的 ${COMMENT_ANCHOR} 基线之外新增 ${symbolStrict.fresh.length} 条；判据只管 ${SYMBOL_LINE_SCOPE}** × 源码后缀）`);
    for (const anchor of symbolStrict.fresh.slice(0, 40)) streams.error(`  · ${describeCommentAnchor(anchor)}`);
    streams.error('  修法：把锚点改到目标文件里真正的声明行／代码行（报错里给了该行实际内容，按它找）；确属「引用注释原文、没有代码行可指」的合法证据，人工裁决后登记进 tools/doc-anchors-symbol-baseline.json 并在 note 里写明原因。⛔ 不要为了让门禁变绿去改被引用的注释。');
  }
  if (orphanFailed) {
    streams.error(`FAIL: 裸锚点孤儿册未通过（${BARE_ORPHAN} 基线之外新增 ${orphanPartition.fresh.length} 条、作用域外本会红新增 ${outsidePartition.fresh.length} 条、册上陈旧 ${orphanPartition.stale.length + outsidePartition.stale.length} 条）`);
    for (const item of orphanPartition.fresh.slice(0, 40)) streams.error(`  · ${describeOrphan(item)}`);
    for (const item of outsidePartition.fresh.slice(0, 40)) streams.error(`  · ${item.doc}:${item.docLine} → ${item.reference}（${item.reason}，作用域外本会红）`);
    for (const key of [...orphanPartition.stale, ...outsidePartition.stale].slice(0, 20)) streams.error(`  · 陈旧 ${key}`);
    streams.error('  修法：给这条裸锚点补回路径（`path:N`），或把段落写成「同块前面已有显式锚点」的形状。确属历史取证页逐字引用、补不回路径的，本地跑 --write-orphan-baseline --accept=<实际新增条数> --why="<理由>" 重新生成：那是把「放弃判据」登记成册上一行 + 一条署名理由（CI 里这个写模式会被拒绝执行）。⛔ 不要靠删条目换绿——陈旧条数同样判红。');
  }
  if (countFailed) {
    streams.error(`FAIL: 锚点清册未通过（${countPartition.drops.length} 份文档的「进判据锚点」比 ${options.anchorCountBaseline} 少、${countPartition.unscanned.length} 个键本次没扫到）`);
    for (const drop of countPartition.drops.slice(0, 20)) streams.error(`  · ${drop.doc}：清册 ${drop.expected} 条 → 本次 ${drop.actual} 条（少 ${drop.expected - drop.actual} 条）`);
    for (const item of countPartition.unscanned.slice(0, 20)) {
      streams.error(`  · ${item.doc}：清册 ${item.expected} 条，但本次根本没扫到它（${item.reason}）——` +
        (!item.collectible
          ? '键根本不是可扫的文档，等于让这份文档永久退出判据面（换成非 .md 路径、目录名或跳过目录里的路径都是这一桶）'
          : item.inRunFace
            ? '键在本次扫描面内，扫不到它等于这份文档的锚点从判据面上消失（换成非 .md 路径或目录名同样算）'
            : '键被换成了面外的文档，等于让这份文档永久退出判据面'));
    }
    streams.error('  修法：这条锚点必须留在判据里——把删掉的路径写回（`path:N`），或把「第 N 行」这类散文改回锚点。确属有意放弃判据的，本地跑 --scan docs --write-anchor-count-baseline --accept=<净增减> --why="<理由>" 登记（CI 里拒绝执行）；单改清册数字会被 judged_total 求和、accept 账本、documents 摘要、键必须是规范化路径这四道抓住。⛔ 不要把键换成 `README.md` 这类面外文档，也不要换成 `docs/**` 下不是 .md 的文件或目录名——两种都是「扫不到」，两种都判红；把 CI 那一行改成 glob 面（`--scan docs/**/*.md`）也一样判红，别指望换扫描面参数能让这一闸失效。');
  }
  if (structuralFailed || driftFailed || symbolStrictFailed || orphanFailed || countFailed) return 1;
  if (options.strict) streams.log(`PASS: --strict 下没有基线之外的新增（结构四判据、ANCHOR_DRIFT、${BARE_ORPHAN}、ANCHOR-COUNT${symbolStrict === null ? '' : ` 与 ${COMMENT_ANCHOR}`} 都按基线内条目只计数、不判红；陈旧条目见 STALE／STALE-DRIFT／STALE-ORPHAN${symbolStrict === null ? '' : '／STALE-SYMBOL'}）`);
  return 0;
}

function printSummary(streams, { stats, unresolved, findings, fresh, covered, stale, baseline, strict }) {
  const { counts } = stats;
  streams.log(`SCAN: 文档 ${stats.documents} 份；抽出「路径:行号」引用 ${stats.candidates} 条（解析成功 ${stats.resolved} 条、同名多文件无法唯一解析 ${unresolved.length} 条不计红${stats.deduped > 0 ? `、同文档重复 ${stats.deduped} 条已去重` : ''}）`);
  streams.log(`COUNT: BROKEN ${counts[BROKEN]} / OUT_OF_RANGE ${counts[OUT_OF_RANGE]} / SUSPECT ${counts[SUSPECT]} / ${NOT_SYMBOL_LINE} ${counts[NOT_SYMBOL_LINE]}（合计 ${findings.length} 条；另只计数不判红：区间首行为空行 ${stats.blankStart} 条、区间全是注释行 ${stats.commentOnly} 条）`);
  streams.log(`SYMBOL-LINE: 作用域 ${SYMBOL_LINE_SCOPE}** × 源码后缀——可判 ${stats.symbol.inScope} 条：落代码行 ${stats.symbol.code}、注释但非文档注释 ${stats.symbol.detached}、逐字引用注释文案 ${stats.symbol.cited}、落在文档注释里 ${stats.symbol.attached}（其中判红 ${counts[NOT_SYMBOL_LINE]} 条）；作用域外（历史证据页）同形状 ${stats.symbol.outside} 条只统计、不判红`);
  const bare = stats.bare;
  streams.log(`BARE: 裸锚点（只写 :N／:N-M、路径继承同块显式锚点）${bare.total} 条——继承到路径 ${bare.inherited} 条（链接 href ${bare.link} 条、同块 ${bare.inherited - bare.link} 条）、无主 ${bare.orphan} 条（${BARE_ORPHAN}，见下方逐条）`);
  streams.log(`BARE-SCOPE: 参与判红的作用域 ${BARE_ANCHOR_SCOPE}**——进判据 ${bare.judged} 条（继承后与显式锚点同权：BROKEN／OUT_OF_RANGE／SUSPECT／${NOT_SYMBOL_LINE}／--strict 汇总都算它）；作用域外 ${bare.outside} 条只计数（同口径本会红 ${bare.outsideRed} 条，历史取证页不复判）、作用域内无主 ${bare.orphanInScope} 条`);
  streams.log(`BASELINE: ${baseline.path} 登记 ${baseline.entries.length} 条；本次命中 ${covered.length} 条、基线外新增 ${fresh.length} 条、陈旧 ${stale.length} 条`);
  if (strict) streams.log('MODE: --strict（只在新增加非零时 exit 1）');
  else streams.log('MODE: dry-run（只打印，不判退出码）');
}

/**
 * `BARE_ORPHAN` 的逐条打印：文档、行号、原文片段、归属失败的原因；`ambiguous-block` 连**候选路径**一起打
 * （候选已经算出来了，不打出来等于让人回去手数）。作用域内全列（数量可控，也很可能是该补路径的）；
 * 作用域外的历史取证页只抽样，数字仍在 `BARE-SCOPE` 行。
 */
function printBareOrphans(streams, bareOrphans) {
  if (bareOrphans.length === 0) return;
  const inScope = bareOrphans.filter(item => item.inScope);
  const outside = bareOrphans.filter(item => !item.inScope);
  streams.log(`${BARE_ORPHAN}: ${bareOrphans.length} 条裸锚点归不到路径（同块内没有显式锚点，或同块显式锚点指向不同文件）——单条不判红（判红只能靠猜），但每条都进 ${DEFAULT_ORPHAN_BASELINE}：--strict 报「基线外新增」与「册上陈旧」两类，且 ${DEFAULT_ANCHOR_COUNT_BASELINE} 还会盯住每份文档的进判据条数。所以「删掉路径前缀」要么被同块继承抓住（该红照红），要么至少要在那两份册子上留下一行增删（带 --accept 条数与 --why 理由）。`);
  for (const item of inScope) {
    streams.log(`  · ${describeOrphan(item)}`);
  }
  for (const item of outside.slice(0, MAX_PRINTED_ORPHAN_OUTSIDE)) {
    streams.log(`  · ${describeOrphan(item)}`);
  }
  if (outside.length > MAX_PRINTED_ORPHAN_OUTSIDE) {
    streams.log(`  … 另有 ${outside.length - MAX_PRINTED_ORPHAN_OUTSIDE} 条作用域外未打印（抽样上限 ${MAX_PRINTED_ORPHAN_OUTSIDE} 条，作用域内的已全列）`);
  }
}

/** ANCHOR_DRIFT 的读数行：作用域、可判/跳过规模、两类命中的条数、与常量的比对结果。 */
function printDriftSummary(streams, { drift, partition }) {
  const { stats } = drift;
  const unique = drift.findings.filter(finding => finding.kind === 'drift-unique').length;
  const gone = drift.findings.filter(finding => finding.kind === 'drift-gone').length;
  streams.log(`DRIFT: 作用域 ${ANCHOR_DRIFT_SCOPE}**（${stats.documents} 份文档）；带「路径:行号」引用的行 ${stats.referenceLines} 行——无行内代码片段跳过 ${stats.skipped} 行、区间内命中 ${stats.green} 行、归属或文本不唯一只计数 ${stats.ambiguous} 行`);
  streams.log(`DRIFT-COUNT: ${ANCHOR_DRIFT} ${drift.findings.length} 条（可按文本重定位 ${unique} 条 / 需人工确认 ${gone} 条）`);
  streams.log(`DRIFT-BASELINE: ARCHITECTURE_ANCHOR_BASELINE 登记 ${ARCHITECTURE_ANCHOR_BASELINE.length} 条；本次命中 ${partition.covered.length} 条、基线外新增 ${partition.fresh.length} 条、陈旧 ${partition.stale.length} 条`);
}

function describeDrift(finding) {
  const actual = finding.actualLine === null ? '片段 0 命中' : `实际在第 ${finding.actualLine} 行`;
  const suggestion = finding.suggestion === null ? '' : `；建议改写成 ${finding.suggestion}`;
  return `${finding.doc}:${finding.docLine} → ${finding.reference}（${finding.kind}，${actual}${suggestion}；owner=${finding.owner}）`;
}

/**
 * `--symbol=count` 的输出：三档计数 + **逐条**列出「无法判定」（文件:行 + 引用位置 + 原因），
 * 便于按裁定 ③ 分派给文档所属模块；兜底回退的块体单独提示，不许静默当对块。
 * 只打印，不改退出码。
 */
function printSymbolCount(streams, { stats, reasons, undecidable, fallbacks }) {
  streams.log('SYMBOL: --symbol=count 只统计不判红（退出码仍只由 --strict ＋ 基线外新增决定；结构性的 BROKEN／OUT_OF_RANGE／SUSPECT／NOT_SYMBOL_LINE 判据一切照旧）');
  streams.log(`SYMBOL-COUNT: 引用 ${stats.references} 条（每个引用位置分别关联，未按行去重）：可核 ${stats.checkable} 条（其中命中 ${stats.hit} 条）/ 无法判定 ${stats.undecidable} 条 / 不适用 ${stats.notApplicable} 条（目标不是源码扩展名，裁定 ④ 不强制套函数符号）`);
  if (reasons.size > 0) {
    streams.log(`SYMBOL-UNDECIDABLE-REASONS: ${[...reasons].map(([reason, count]) => `${reason} ${count} 条`).join('；')}`);
    streams.log(`SYMBOL-UNDECIDABLE: ${undecidable.length} 条逐条列出（文档:行 → 引用位置；原因）——这些**不计入通过**，也不猜：`);
    for (const item of undecidable.slice(0, MAX_PRINTED_UNDECIDABLE)) {
      streams.log(`  · ${item.doc}:${item.docLine} → ${item.target}（${item.reason}）`);
    }
    if (undecidable.length > MAX_PRINTED_UNDECIDABLE) {
      streams.log(`  … 另有 ${undecidable.length - MAX_PRINTED_UNDECIDABLE} 条未打印（格式同上）`);
    }
  }
  if (stats.fallback > 0) {
    streams.log(`SYMBOL-FALLBACK: ${stats.fallback} 条引用所属的符号块走了兜底回退（块体可能不准，必须人工看一眼）：`);
    const seen = new Set();
    for (const item of fallbacks) {
      const key = `${item.symbol}|${item.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      streams.log(`  · 符号 ${item.symbol}（${item.target}）回退到首个 {，块体可能不准：${item.doc}:${item.docLine}`);
      if (seen.size >= 20) break;
    }
    if (seen.size < stats.fallback) streams.log(`  … 其余 ${stats.fallback - seen.size} 条同理`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
