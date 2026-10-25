/**
 * 证据锚点解析的**唯一来源**：行号形态与符号形态都在这里算，任何工具都不许另写一套提取器。
 *
 * 为什么要有这一层：台账里的证据锚点此前只有「文件 + 起-止行号」一种形态，代码一往前挪就漂。
 * `accountDeletionWired` 引用的 `services/api/src/app.ts` 同一段在 #407／#419／#469／#474 四张 PR 里
 * 各改一次 ⇒ 任意两张同存即 1 块互斥冲突，谁后合谁都要重锚。符号形态把「行号」换成
 * 「文件 + 符号名（函数 / 方法 / 路由注册块）」，行号在运行时按**同一套归属块口径**算出来。
 *
 * 归属块口径（`enclosingBlock`，与 `--reanchor` 落盘用的口径逐字一致）：
 *  1) 从命中行向上（含命中行自身）找最近的「声明行」：function / class / interface / type /
 *     `const|let|var X =` / `xxx.<verb>(` 路由注册 / 对象与类方法 `async name(`。
 *  2) 声明行必须带块体：声明行之后、遇到「括号深度 0 的 `;`」之前出现 `{`；否则不算块声明。
 *  3) 从该 `{` 起按花括号深度配到结束行；字符串、模板（含 ${...} 插值）与注释都跳过。
 *  4) 块必须覆盖命中行；覆盖不了就继续向上找。
 *  5) 一路找不到就退化为「命中行 ±0 的单行」并标 fallback，报告里必须可见（不许假装定位到了）。
 * 不认正则字面量里的花括号：`/^\d{2}$/` 这类配平量词无影响；真出现不配平的花括号 → 配对失败 → FALLBACK。
 *
 * 符号形态（`locator: {symbol, file?}`）比行号形态严一档：**不向上找**，只认「符号自己的块体」。
 * 找不到带块体的同名声明 ⇒ MISSING／NO_BLOCK，同名声明落在多个不同块 ⇒ AMBIGUOUS，三种都报候选并
 * 由调用方 exit 1；⛔ 不许静默降级成「不可核」。
 *
 * 消费者：`tools/verify-contract-status.mjs`（含 `--reanchor` / `--write-doc`）、
 * `tools/contract-status-core.mjs`（对照表渲染）。后续接文档行号闸门时从这里 import，不许再抄一份。
 */

/** 符号形态的定位器键：证据项上的 `locator: {symbol, file?}`（与行号形态的 `lines` 二选一）。 */
export const LOCATOR_KEY = 'locator';

const DECLARATION_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'new', 'delete', 'void', 'throw', 'yield', 'else', 'do', 'try', 'with']);
const DECLARATION_PATTERNS = [
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/,
  /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+[A-Za-z_$]/,
  /^(?:export\s+)?(?:declare\s+)?(?:interface|type)\s+[A-Za-z_$]/,
  /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::|=)/,
  /^[A-Za-z_$][\w$]*\s*\.\s*(?:get|post|put|patch|delete|head|options)\s*\(/,
];
const METHOD_DECLARATION = /^(?:(?:public|private|protected|static|readonly|async|get|set|declare)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
const FUNCTION_NAME = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const CLASS_NAME = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
const TYPE_NAME = /^(?:export\s+)?(?:declare\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/;
const VARIABLE_NAME = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::|=)/;

export function isDeclarationLine(line) {
  const trimmed = String(line).trim();
  if (DECLARATION_PATTERNS.some(pattern => pattern.test(trimmed))) return true;
  const match = METHOD_DECLARATION.exec(trimmed);
  return match !== null && !DECLARATION_KEYWORDS.has(match[1]);
}

/** 声明行声明的名字（函数/类/接口/类型/变量/具名调用或方法）；匿名或无名返回 null。 */
export function declarationName(line) {
  const trimmed = String(line).trim();
  for (const pattern of [FUNCTION_NAME, CLASS_NAME, TYPE_NAME, VARIABLE_NAME]) {
    const match = pattern.exec(trimmed);
    if (match !== null) return match[1];
  }
  const method = METHOD_DECLARATION.exec(trimmed);
  if (method !== null && !DECLARATION_KEYWORDS.has(method[1])) return method[1];
  return null;
}

/** 1-based 行号：`value` 在 `text` 里每次出现的行号（含重叠命中）。 */
export function anchorLineNumbers(text, value) {
  const hits = [];
  for (let index = text.indexOf(value); index !== -1; index = text.indexOf(value, index + 1)) {
    hits.push(text.slice(0, index).split('\n').length);
  }
  return hits;
}

const skipLineComment = (text, start) => { const end = text.indexOf('\n', start); return end < 0 ? text.length : end; };
const skipBlockComment = (text, start) => { const end = text.indexOf('*/', start + 2); return end < 0 ? text.length : end + 2; };
function skipQuoted(text, start, quote) {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') { index += 2; continue; }
    if (char === quote) return index + 1;
    if (char === '\n') return index; // 未闭合的单行字符串：就地止损，不吞掉后面的代码
    index += 1;
  }
  return index;
}
function skipInterpolation(text, start) {
  let index = start, depth = 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'") { index = skipQuoted(text, index, char); continue; }
    if (char === '`') { index = skipTemplate(text, index); continue; }
    if (char === '/' && text[index + 1] === '/') { index = skipLineComment(text, index); continue; }
    if (char === '/' && text[index + 1] === '*') { index = skipBlockComment(text, index); continue; }
    if (char === '{') depth += 1;
    else if (char === '}') { depth -= 1; if (depth === 0) return index + 1; }
    index += 1;
  }
  return index;
}
function skipTemplate(text, start) {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') { index += 2; continue; }
    if (char === '`') return index + 1;
    if (char === '$' && text[index + 1] === '{') { index = skipInterpolation(text, index + 2); continue; }
    index += 1;
  }
  return index;
}

/** End index of the brace block opening at openIndex, or -1 when it never closes. */
export function braceBlockEnd(text, openIndex) {
  let index = openIndex, depth = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'") { index = skipQuoted(text, index, char); continue; }
    if (char === '`') { index = skipTemplate(text, index); continue; }
    if (char === '/' && text[index + 1] === '/') { index = skipLineComment(text, index); continue; }
    if (char === '/' && text[index + 1] === '*') { index = skipBlockComment(text, index); continue; }
    if (char === '{') { depth += 1; index += 1; continue; }
    if (char === '}') { depth -= 1; index += 1; if (depth === 0) return index - 1; continue; }
    index += 1;
  }
  return -1;
}

/**
 * 候选块体 `{` 之后出现这些记号，说明这一行的**签名还没写完**，刚跳过的那个 `{ ... }` 只是签名里的一段：
 *   `:` 返回类型／变量类型／属性类型；`=` 赋值右值、默认值、箭头；
 *   `{` 后面还有一个真正的块体（前一个 `{ ... }` 是类型字面量）；
 *   `|` `&` 联合／交叉类型继续；`<` `>` 泛型参数收尾（`Promise<{ items: Row[] }>` 的 `>`）。
 */
const SIGNATURE_CONTINUES = Object.freeze(new Set([':', '=', '{', '|', '&', '<', '>']));

/**
 * 光标停在这些记号上时本行**没写完**，下一行还是同一语句（`const x =`、`a +`、`f(` …）。
 * 反之停在 `)`、`]`、`}`、标识符上，在**无分号（ASI）**文件里就是语句结束——这是 ASI 的判据。
 */
const CONTINUES_STATEMENT = Object.freeze(new Set([
  '=', '+', '-', '*', '/', '%', '&', '|', '^', '!', '<', '>', '?', ':', ',', '.', '(', '[', '{', '~',
]));

/** 找块体时从声明行起最多看这么多行。预算按**行**算，且块内换行照样计入。 */
const MAX_SCAN_LINES = 20;

/** [from, to) 里的换行数。 */
function countNewlines(text, from, to) {
  let count = 0;
  for (let index = from; index < to; index += 1) if (text[index] === '\n') count += 1;
  return count;
}

/** 跳过空白与注释后的下一个有效字符；到文件尾返回 ''。 */
function nextSignificantChar(text, start) {
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') { index += 1; continue; }
    if (char === '/' && text[index + 1] === '/') { index = skipLineComment(text, index); continue; }
    if (char === '/' && text[index + 1] === '*') { index = skipBlockComment(text, index); continue; }
    return char;
  }
  return '';
}

/**
 * 声明行里的候选块体：从行首扫到语句结束、ASI 换行、或行预算用尽。
 * 每个 `{` 记一个候选并**整块跳过**（块内部的花括号不会被当候选），同时记下它所在的括号深度、
 * 以及闭括号之后的第一个有效记号——后半段是判「参数解构／类型字面量」还是「真块体」的唯一依据。
 *
 * 两条硬约束（由 `miniprogram/pages/messages/messages.js:175` 那一类误归属促成）：
 *   - **ASI**：无分号文件里，括号深度为 0、且光标停在「语句已完整」的记号上时，下一非空行若以
 *     标识符／关键字开头就是**新语句**，立刻停——不许把下一条语句里的 `{` 当块体；
 *   - **行预算**：块内换行照样计入（`index = close + 1` 之后不许重新起算）。否则跳过一个几十行的块
 *     等于白送几十行预算，扫描能一路跨到别的方法上去。
 *
 * ⛔ ASI 判据里**不许有「本行已经出现过 `{` 就不再判 ASI」这类全局 latch**：声明行本身常含对象字面量
 * （`const decision = …decide({`、`const ops = a || (b = {})`、`…filter(function (e) { … })[0]`），
 * 一置真就把 ASI 永久关掉，扫描照样跨语句抓后面的块，再被「语句级候选立即返回」抢占
 * （实测 `voice.js:571-574 → decision(566-575)`、`profile.js:67 → ops(64-75)`、
 *  `messages.js:268-294 → item(267-276)` 六条误命中）。判据只看**当前行的括号深度**：
 * 只有 `paren === 0` 且 `after` 不是续写记号的 `{` 才算本语句的块。
 *
 * 语句级（括号深度 0）且闭括号后不是签名续写记号的候选**一出现就返回**：它就是块体，不必再往远处找；
 * 也正因如此，行预算只约束「被跳过的块」，不会误伤函数体本身有几千行的情况。
 */
function bodyCandidates(text, lineStart) {
  const candidates = [];
  let index = lineStart, paren = 0, line = 0, lastSignificant = '';
  /** 跳过一段（字符串/模板/注释/块）后把其中的换行计入预算，超预算即停。 */
  const skipSpan = (start, end) => {
    line += countNewlines(text, start, end);
    return line > MAX_SCAN_LINES;
  };
  while (index < text.length && line <= MAX_SCAN_LINES) {
    const char = text[index];
    if (char === ' ' || char === '\t' || char === '\r') { index += 1; continue; }
    if (char === '\n') {
      // ASI：括号深度 0、且停在「语句已完整」的记号上，下一行以标识符／关键字开头 ⇒ 新语句。
      // （不设任何「本行出现过 `{`」的 latch——那会把无分号文件里的跨语句抓块放回来。）
      if (paren === 0 && !CONTINUES_STATEMENT.has(lastSignificant)
        && /[A-Za-z_$]/.test(nextSignificantChar(text, index + 1))) break;
      line += 1;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = skipQuoted(text, index, char);
      if (skipSpan(index, end)) break;
      lastSignificant = char;
      index = end;
      continue;
    }
    if (char === '`') {
      const end = skipTemplate(text, index);
      if (skipSpan(index, end)) break;
      lastSignificant = '`';
      index = end;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') { index = skipLineComment(text, index); continue; }
    if (char === '/' && text[index + 1] === '*') {
      const end = skipBlockComment(text, index);
      if (skipSpan(index, end)) break;
      index = end;
      continue;
    }
    if (char === '(' || char === '[') { paren += 1; index += 1; lastSignificant = char; continue; }
    if (char === ')' || char === ']') { if (paren > 0) paren -= 1; index += 1; lastSignificant = char; continue; }
    if (char === ';' && paren <= 0) break; // 先遇到语句结束：这条声明没有块体
    if (char === '{') {
      const close = braceBlockEnd(text, index);
      if (close < 0) break; // 配不平：不许假装定位到了，交给调用方按「没有块体」处理
      const after = nextSignificantChar(text, close + 1);
      // 只有「括号深度 0 且后面不是签名续写记号」的 `{` 才配当本语句的块体。
      if (paren === 0 && !SIGNATURE_CONTINUES.has(after)) return [{ open: index, paren, after }];
      candidates.push({ open: index, paren, after });
      if (skipSpan(index, close)) break; // 跳过的块里的换行也计入预算，不许重新起算
      lastSignificant = '}';
      index = close + 1;
      continue;
    }
    index += 1;
    lastSignificant = char;
  }
  return candidates;
}

/**
 * 哪个 `{` 是这条声明的块体：返回 `{open, fallback}`，没有块体时 `open` 为 -1。
 *
 * 修复前这里是「从声明行起遇到第一个 `{` 就返回」，于是三类声明全被算错（`tests/unit/anchor-resolve-block.test.mjs`）：
 *   ① 参数解构 `export function buildApp({ config, ... }: BuildAppOptions) { ... }` —— 第一个 `{` 是解构模式，
 *      块被算成声明行本身（单行块）。真实实例：`services/api/src/app.ts`。
 *   ② 类型字面量 `function f(): { a: 1 } { ... }` / `const x: { a: 1 } = { ... }` / `Promise<{ items: Row[] }>`。
 *   ③ 只补「括号深度必须为 0」也不行：路由回调的块体本来就在调用括号内
 *      （`app.get('/x', async (req, reply) => { ... })`、`registerX(app, ..., { ... })`）。
 *
 * 分三档取：
 *  1) **语句级候选优先**（括号深度 0）且闭括号之后不是签名续写记号：函数的块体、class/interface/type 的体、
 *     `const x = { ... }` 的对象都在这一档。
 *  2) 没有上面那种，才取括号内的候选：调用括号里的回调体／对象实参——不能因为它们「不在括号深度 0」被判成没有块体。
 *  3) 全都不合格时**回退到第一个 `{`**（= 修复前的行为）并打 `bodyFallback` 标记：宁可把「块体可能不准」
 *     标出来给人看，也不把原本能解析的符号变成 NO_BLOCK（那会让 `verify-contract-status` 整体 exit 1，
 *     等于用这个解析器的改动去改另一道门禁的口径）。
 */
function locateBlockBody(text, lineStart) {
  const candidates = bodyCandidates(text, lineStart);
  if (candidates.length === 0) return { open: -1, fallback: false };
  const statementLevel = candidates.find(candidate => candidate.paren === 0 && !SIGNATURE_CONTINUES.has(candidate.after));
  if (statementLevel !== undefined) return { open: statementLevel.open, fallback: false };
  const nested = candidates.find(candidate => !SIGNATURE_CONTINUES.has(candidate.after));
  if (nested !== undefined) return { open: nested.open, fallback: false };
  return { open: candidates[0].open, fallback: true };
}

const lineStarts = text => {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) if (text[index] === '\n') starts.push(index + 1);
  return starts;
};
const lineText = (text, starts, line) => {
  const start = starts[line - 1];
  const end = text.indexOf('\n', start);
  return text.slice(start, end < 0 ? text.length : end).replace(/\r$/, '');
};

/**
 * 该声明行**自己**的块体（不向上找）：`{start,end}` 或 null。
 * 块体判定只能靠 `locateBlockBody` 的三档（见其注释）；走了兜底回退时结果会带 `bodyFallback: true`，
 * 调用方必须把它当成「块体可能不准」报出来，不许静默当对块用。
 */
export function declarationBlock(text, line, starts = lineStarts(text)) {
  if (!(line >= 1 && line <= starts.length)) return null;
  if (!isDeclarationLine(lineText(text, starts, line))) return null;
  const { open, fallback } = locateBlockBody(text, starts[line - 1]);
  if (open < 0) return null;
  const close = braceBlockEnd(text, open);
  if (close < 0) return null;
  const endLine = text.slice(0, close).split('\n').length;
  if (endLine < line) return null;
  return fallback ? { start: line, end: endLine, bodyFallback: true } : { start: line, end: endLine };
}

/** Enclosing declaration block `{start,end,fallback}` of a 1-based hit line. */
export function enclosingBlock(text, hitLine) {
  const starts = lineStarts(text);
  for (let current = Math.min(hitLine, starts.length); current >= 1; current -= 1) {
    const block = declarationBlock(text, current, starts);
    if (block === null) continue;
    if (block.end < hitLine) continue; // 块在命中行之前就结束了，不是归属块
    return { ...block, fallback: false };
  }
  return { start: hitLine, end: hitLine, fallback: true };
}

/**
 * 证据项上的符号定位器：`locator: {symbol, file?}`。
 * 返回 `{kind:'none'}`（没有符号形态）、`{kind:'invalid', message}`（形状非法）或
 * `{kind:'value', symbol, file}`。`file` 缺省时由调用方取 `item.path`／`item.test`。
 */
export function locatorSpec(item) {
  const value = item?.[LOCATOR_KEY];
  if (value === undefined) return { kind: 'none' };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { kind: 'invalid', message: 'locator 必须是 {symbol, file?} 对象' };
  const unknown = Object.keys(value).filter(key => key !== 'symbol' && key !== 'file');
  if (unknown.length > 0) return { kind: 'invalid', message: `locator 出现未知字段 ${unknown.join('、')}（只认 symbol 与 file）` };
  if (typeof value.symbol !== 'string' || value.symbol.trim() === '') return { kind: 'invalid', message: 'locator.symbol 必须是非空字符串' };
  if (value.file !== undefined && (typeof value.file !== 'string' || value.file.trim() === '')) return { kind: 'invalid', message: 'locator.file 必须是非空字符串' };
  return { kind: 'value', symbol: value.symbol, file: value.file };
}

/**
 * 把符号名解析成当前行范围。**不向上找归属块**：只认同名声明自己的块体。
 * 返回 `{status, symbol, hits, candidates, reason}`：
 *  - OK        `candidates` 恰好 1 个 `{start,end}`；
 *  - MISSING   文件里没有同名声明行（`hits` 空，`occurrences` 给出裸文本命中数）；
 *  - NO_BLOCK  有同名声明行，但没有一处带块体（`hits` 非空）；
 *  - AMBIGUOUS 同名声明落在多个不同归属块（`candidates` 全部列出）；
 *  - INVALID   符号名不是非空字符串。
 */
export function resolveSymbolBlock(text, symbol) {
  const empty = { symbol, hits: [], candidates: [], occurrences: [] };
  if (typeof symbol !== 'string' || symbol.trim() === '') {
    return { ...empty, status: 'INVALID', reason: 'INVALID：符号名必须是非空字符串' };
  }
  const lines = text.split('\n');
  const hits = [];
  for (let line = 1; line <= lines.length; line += 1) {
    if (!isDeclarationLine(lines[line - 1])) continue;
    if (declarationName(lines[line - 1]) !== symbol) continue;
    hits.push(line);
  }
  if (hits.length === 0) {
    const occurrences = anchorLineNumbers(text, symbol);
    return {
      ...empty,
      status: 'MISSING',
      occurrences,
      reason: `MISSING：符号在文件里出现 ${occurrences.length} 次，但没有一处是声明行（要函数/方法/路由注册块，或 const/class/interface/type 声明）`,
    };
  }
  const starts = lineStarts(text);
  const candidates = [];
  const withoutBlock = [];
  for (const line of hits) {
    const block = declarationBlock(text, line, starts);
    if (block === null) { withoutBlock.push(line); continue; }
    if (!candidates.some(other => other.start === block.start && other.end === block.end)) candidates.push(block);
  }
  if (candidates.length === 0) {
    return {
      ...empty,
      status: 'NO_BLOCK',
      hits,
      reason: `NO_BLOCK：符号在第 ${withoutBlock.join('、')} 行是声明但没有块体（没有 { } 体），不猜`,
    };
  }
  if (candidates.length > 1) {
    return {
      ...empty,
      status: 'AMBIGUOUS',
      hits,
      candidates,
      reason: `AMBIGUOUS：符号落在 ${candidates.length} 个不同归属块（候选 ${candidates.map(block => `${block.start}-${block.end}`).join('、')}；命中行 ${hits.join('、')}）`,
    };
  }
  return { ...empty, status: 'OK', hits, candidates, reason: '' };
}

/**
 * 一份源码里所有**声明块**（按起始行升序）：`{start, end, symbol, bodyFallback?}`。
 * 供「按每个引用的位置分别关联」的统计口径使用；不参与任何退出码。
 * 走兜底回退的块带 `bodyFallback: true`，调用方必须把它当「块体可能不准」报出来。
 */
export function declarationBlocks(text) {
  const starts = lineStarts(text);
  const blocks = [];
  for (let line = 1; line <= starts.length; line += 1) {
    const block = declarationBlock(text, line, starts);
    if (block === null) continue;
    blocks.push({ ...block, symbol: declarationName(lineText(text, starts, line)) });
  }
  return blocks;
}

/**
 * 把一个**引用位置**（`from`-`to`，1-based 行号）关联到唯一的声明块。返回 `{status, block, reason}`：
 *  - `hit`         唯一的最内层声明块覆盖整段 `from-to`；
 *  - `checkable`   唯一的最内层声明块覆盖了 `from`，但区间越过了块尾（符号确定、范围不确定）；
 *  - `undecidable` 没有块覆盖该行，或最内层块并列无法定序 —— **不猜、不算通过**。
 * 判定只认「覆盖该行的块里，没有被别的块严格包含的那一个」；不是最内层就不算关联成功，
 * 否则同一个位置能同时属于两个符号，等于把猜测当结论。
 */
export function associateSymbol(blocks, { from, to }) {
  const containing = blocks.filter(block => block.start <= from && from <= block.end);
  if (containing.length === 0) return { status: 'undecidable', reason: '该行不在任何声明块内' };
  const innermost = containing.filter(block => !containing.some(other => (
    other !== block && other.start >= block.start && other.end <= block.end
    && (other.start > block.start || other.end < block.end)
  )));
  if (innermost.length !== 1) {
    return {
      status: 'undecidable',
      candidates: innermost,
      reason: `覆盖该行的声明块并列、无法定序（${innermost.length} 个：${innermost.map(block => `${block.start}-${block.end}`).join('、')}）`,
    };
  }
  const block = innermost[0];
  if (to > block.end) return { status: 'checkable', block, reason: `引用区间超出所在声明块（第 ${block.start}-${block.end} 行）` };
  return { status: 'hit', block, reason: '' };
}
