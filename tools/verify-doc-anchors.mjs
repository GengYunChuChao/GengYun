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
 *   node tools/verify-doc-anchors.mjs --write-orphan-baseline # 写 tools/doc-anchors-orphan-baseline.json
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
 * `文档:文档行:原文|原因`。`--strict` 下「基线之外的新增孤儿」判红并逐条打印，基线里已经不在文档中的
 * 条目打 `STALE-ORPHAN` 点名要求删。同一份册子还登记「作用域外、按同口径本会红」的继承锚点
 * （键 `文档:文档行:引用|判据`），以免 `docs/verification/**` 成为无人复核的免检区。于是删掉路径前缀
 * 只有两个出口：被同块继承抓住（该红照红），或者在孤儿册上留下一条增删（评审看得见）——都不会静默消失。
 * 继承锚点的判红作用域与 `SYMBOL_LINE_SCOPE` 同口径（`docs/architecture/**`），历史取证页只计数。
 *
 * 两种扫描口径的数字**不可互换**：`npm run verify:anchors` 走默认 `docs/architecture` + `docs/verification`
 * （375 份文档）；`--scan docs` 还多扫 `docs/` 下其余页面（README、development-progress、evaluation 等）。
 * 引用 `BARE`／`BARE-SCOPE`／`BARE-ORPHAN` 读数前，先确认命令用的是哪一种。
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
 * 裸锚点孤儿册：`BARE_ORPHAN` 逐条登记在这里（键 `文档:文档行:原文|原因`），另有 `outsideRed`
 * 数组登记「作用域外、按同口径本会红」的继承锚点（键 `文档:文档行:引用|判据`）。
 *
 * 为什么必须落成文件：孤儿不判红，若每次现算，删掉路径前缀就等于让一条锚点退出全部判据而**不留痕迹**——
 * PR diff 里看不到增减，评审无从复核。落成册之后，这条路要么被同块继承抓住（该红照红），要么在册子上
 * 留下一行增删。册子只由 `--write-orphan-baseline` 生成，不手写。
 */
export const DEFAULT_ORPHAN_BASELINE = 'tools/doc-anchors-orphan-baseline.json';
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
  return { findings, stats, unresolved, commentAnchors, bareOrphans, outsideRedAnchors };
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
  "docs/architecture/ai-ops-spec-status.md:197#{ actorId, reasonCode: 'job_cancelled', requestId }", // drift-gone｜0 命中｜真漂移：service.ts:776-780 现在是 account.suspend 的审计，job_cancelled 实际在 service.ts:880/962
  "docs/architecture/gy-i19-user-backup-copies-design.md:26#{ purged: false }", // drift-unique｜实际在 services/api/src/privacy/user-data-deletion.ts:329｜历史树锚点：该页行号是 GY-R34-I19 树的读数
  "docs/architecture/gy-i19-user-backup-copies-design.md:303#{ purged: boolean, evidenceRef?: string }", // drift-gone｜0 命中｜历史树锚点：同上
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
 * 孤儿册的键：`文档:文档行:原文|原因`。
 *
 * 为什么不学结构基线的「path|reason|reference」：孤儿**没有可解析的路径**，它的 `reference` 就是那个裸
 * `:130` 本身，同一页会出现很多次；把文档行和原文一起放进键，才能在 diff 里定位到具体是哪一行在变。
 */
export const orphanKey = item => `${item.doc}:${item.docLine}:${item.raw}|${item.reason}`;
/** 作用域外「本会红」的继承锚点：`reference` 已经带路径（继承来的），键同结构基线口径再补文档行。 */
export const outsideRedKey = item => `${item.doc}:${item.docLine}:${item.reference}|${item.reason}`;

/** 读孤儿册；文件不存在按空册处理（首次落地前的合法状态），坏结构直接抛。 */
export function loadOrphanBaseline(root, baselinePath = DEFAULT_ORPHAN_BASELINE) {
  const absolute = resolve(root, baselinePath);
  if (!existsSync(absolute)) return { path: baselinePath, orphans: [], outsideRed: [], missing: true };
  const parsed = JSON.parse(readFileSync(absolute, 'utf8'));
  const readList = (name, list) => {
    if (list === undefined) return [];
    if (!Array.isArray(list)) throw new Error(`孤儿册的 ${name} 字段必须是字符串数组：${baselinePath}`);
    for (const key of list) {
      if (typeof key !== 'string' || !key.includes('|')) {
        throw new Error(`孤儿册 ${name} 的条目必须是「…|原因」形状的字符串：${JSON.stringify(key)}`);
      }
    }
    return list;
  };
  return {
    path: baselinePath,
    orphans: readList('orphans', parsed.orphans),
    outsideRed: readList('outsideRed', parsed.outsideRed),
    missing: false,
  };
}

/**
 * 重数法比对（与 `partitionByBaseline` 同构）：同名键登记了几条就只免罚几条，多出来的算新增。
 * `entries` 既接受已算好的字符串键，也接受对象（好让调用方直接传 `loadOrphanBaseline` 的条目）。
 *
 * `scannedDocs`／`docExists` 只影响**陈旧**判定：孤儿册按两种扫描面（`--strict` 的默认面、CI 的
 * `--scan docs`）共用一份文件，若把「本次没扫到的文档」也算陈旧，就跑哪个面都会刷一片假陈旧。键的第一段
 * 是文档路径（仓内相对路径没有 `:`），据此跳过「文件还在、只是不在本次扫描面里」的条目。
 * 但**文件根本不存在**的条目必须照报陈旧——否则册子里塞一条指向不存在文档的假条目就永久隐身了。
 */
export function partitionOrphanBaseline(items, keyOf, entries, scannedDocs = null, docExists = null) {
  const keyOfEntry = entry => (typeof entry === 'string' ? entry : keyOf(entry));
  const docOfKey = key => String(key).slice(0, String(key).indexOf(':'));
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
 */
export function renderOrphanBaseline({ orphans, outsideRed }) {
  const document = {
    schema_version: 1,
    note: '归不到路径的裸锚点（BARE_ORPHAN）与「作用域外、按同口径本会红」的继承锚点快照。键 = 文档:文档行:原文|原因（outsideRed 为 文档:文档行:引用|判据）。--strict 只报本文件之外的**新增**（新增 ⇒ exit 1）；条目消失后会变「STALE-ORPHAN 陈旧」，复核后删掉那一行。⛔ 删掉文档里的路径前缀会在这里留下增删——那正是它该有的评审痕迹，不要靠删条目让它变绿。',
    generated_by: 'node tools/verify-doc-anchors.mjs --write-orphan-baseline',
    orphans: orphans.map(orphanKey).sort(),
    outsideRed: outsideRed.map(outsideRedKey).sort(),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** 孤儿册的读数行：登记多少、命中多少、基线外新增多少、陈旧多少。 */
function printOrphanBaseline(streams, { baseline, orphans, outside, orphanTotal, outsideTotal }) {
  streams.log(`BARE-ORPHAN: ${BARE_ORPHAN} ${orphanTotal} 条归不到路径的裸锚点——册 ${baseline.path} 登记 ${baseline.orphans.length} 条；本次命中 ${orphans.covered.length} 条、基线外新增 ${orphans.fresh.length} 条、本次扫描面内陈旧 ${orphans.stale.length} 条`);
  streams.log(`BARE-ORPHAN-OUTSIDE: 作用域外「本会红」${outsideTotal} 条——同一册 outsideRed 登记 ${baseline.outsideRed.length} 条；命中 ${outside.covered.length} 条、基线外新增 ${outside.fresh.length} 条`);
  if (baseline.missing) streams.log(`NOTE: 孤儿册 ${baseline.path} 不存在，按空册处理（等于每一条孤儿都算新增）。`);
  if (orphans.stale.length > 0 || outside.stale.length > 0) {
    streams.log(`STALE-ORPHAN: ${orphans.stale.length + outside.stale.length} 条孤儿册条目已不再命中（那条裸锚点补回路径了、或文档改写了）——删掉这些行，否则孤儿册会慢慢变成免罚名单：`);
    for (const key of [...orphans.stale, ...outside.stale].slice(0, 20)) streams.log(`  · ${key}`);
  }
}

// —— CLI ——————————————————————————————————————————————————————————————
const USAGE = 'usage: node tools/verify-doc-anchors.mjs [--strict] [--scan <目录或glob>]... [--baseline <路径>] [--orphan-baseline <路径>] [--root <目录>] [--symbol=count|strict] [--emit-baseline | --write-baseline] [--emit-orphan-baseline | --write-orphan-baseline]';
const KNOWN_FLAGS = new Set(['--strict', '--scan', '--baseline', '--orphan-baseline', '--root', '--symbol', '--emit-baseline', '--write-baseline', '--emit-orphan-baseline', '--write-orphan-baseline']);
/** `--symbol` 的取值是**白名单**：不认识的取值直接报错退出，绝不当成「没传、照旧绿灯」。 */
const SYMBOL_MODES = new Set(['count', 'strict']);
const MAX_PRINTED = 300;
const MAX_PRINTED_UNDECIDABLE = 500;
/** `BARE_ORPHAN` 的逐条打印上限：作用域内全列，作用域外的历史取证页只抽样（数字仍在汇总行）。 */
const MAX_PRINTED_ORPHAN_OUTSIDE = 40;

export function parseArgs(argv) {
  const options = { strict: false, scan: [], baseline: DEFAULT_BASELINE, orphanBaseline: DEFAULT_ORPHAN_BASELINE, root: TOOL_ROOT, symbol: null, emit: false, write: false, emitOrphan: false, writeOrphan: false };
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
    else if (flag === '--scan') options.scan.push(value());
    else if (flag === '--baseline') options.baseline = value();
    else if (flag === '--orphan-baseline') options.orphanBaseline = value();
    else if (flag === '--root') options.root = resolve(value());
    else if (flag === '--symbol') {
      const mode = value();
      if (!SYMBOL_MODES.has(mode)) throw new Error(`--symbol 只支持 ${[...SYMBOL_MODES].join('|')}（收到：${mode}）\n${USAGE}`);
      options.symbol = mode;
    }
  }
  if (options.emit && options.write) throw new Error('--emit-baseline 与 --write-baseline 只能二选一');
  if (options.emitOrphan && options.writeOrphan) throw new Error('--emit-orphan-baseline 与 --write-orphan-baseline 只能二选一');
  if ((options.emit || options.write) && (options.emitOrphan || options.writeOrphan)) {
    throw new Error('结构基线与孤儿册要分别生成：--emit-baseline／--write-baseline 不能和 --emit-orphan-baseline／--write-orphan-baseline 同时用');
  }
  if (options.symbol !== null && (options.emit || options.write)) {
    throw new Error(`--symbol=${options.symbol} 不能与 --emit-baseline／--write-baseline 同时用（生成基线时统计会被忽略）`);
  }
  if (options.symbol !== null && (options.emitOrphan || options.writeOrphan)) {
    throw new Error(`--symbol=${options.symbol} 不能与 --emit-orphan-baseline／--write-orphan-baseline 同时用（生成孤儿册时统计会被忽略）`);
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
  const { findings, stats, unresolved, commentAnchors, bareOrphans, outsideRedAnchors } = collectFindings({ root: options.root, targets: options.scan });
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
  const orphanDocument = renderOrphanBaseline({ orphans: bareOrphans, outsideRed: outsideRedAnchors });
  if (options.emitOrphan) {
    process.stdout.write(orphanDocument);
    return 0;
  }
  if (options.writeOrphan) {
    const absolute = resolve(options.root, options.orphanBaseline);
    writeFileSync(absolute, orphanDocument);
    streams.log(`WRITE: 已写 ${options.orphanBaseline}（孤儿 ${bareOrphans.length} 条、作用域外本会红 ${outsideRedAnchors.length} 条）。这是**快照**不是裁决：只由本工具生成，不手写；提交前确认增量确实该留在册上。`);
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
  const orphanBaseline = loadOrphanBaseline(options.root, options.orphanBaseline);
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
  const orphanFailed = options.strict && (orphanPartition.fresh.length > 0 || outsidePartition.fresh.length > 0);
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
    streams.error(`FAIL: 裸锚点孤儿册未通过（${BARE_ORPHAN} 基线之外新增 ${orphanPartition.fresh.length} 条、作用域外本会红新增 ${outsidePartition.fresh.length} 条）`);
    for (const item of orphanPartition.fresh.slice(0, 40)) streams.error(`  · ${describeOrphan(item)}`);
    for (const item of outsidePartition.fresh.slice(0, 40)) streams.error(`  · ${item.doc}:${item.docLine} → ${item.reference}（${item.reason}，作用域外本会红）`);
    streams.error('  修法：给这条裸锚点补回路径（`path:N`），或把段落写成「同块前面已有显式锚点」的形状；确属历史取证页逐字引用、补不回路径的，人工裁决后用 --write-orphan-baseline 重新生成孤儿册（那不是「让它变绿」，是把「放弃判据」这件事登记成册上的一行）。');
  }
  if (structuralFailed || driftFailed || symbolStrictFailed || orphanFailed) return 1;
  if (options.strict) streams.log(`PASS: --strict 下没有基线之外的新增（结构四判据、ANCHOR_DRIFT、${BARE_ORPHAN}${symbolStrict === null ? '' : ` 与 ${COMMENT_ANCHOR}`} 都按基线内条目只计数、不判红；陈旧条目见 STALE／STALE-DRIFT／STALE-ORPHAN${symbolStrict === null ? '' : '／STALE-SYMBOL'}）`);
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
  streams.log(`${BARE_ORPHAN}: ${bareOrphans.length} 条裸锚点归不到路径（同块内没有显式锚点，或同块显式锚点指向不同文件）——单条不判红（判红只能靠猜），但每条都进 ${DEFAULT_ORPHAN_BASELINE}：--strict 只报基线外新增、并对已消失的条目点名要求删，所以「删掉路径前缀」要么被同块继承抓住，要么在孤儿册上留下增删：`);
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
