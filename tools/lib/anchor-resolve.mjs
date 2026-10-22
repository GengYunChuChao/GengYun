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

/** Index of the block body `{` that belongs to a declaration line, or -1 for a body-less line. */
function blockBodyIndex(text, lineStart) {
  let index = lineStart, paren = 0, lineBreaks = 0;
  while (index < text.length && lineBreaks <= 20) {
    const char = text[index];
    if (char === '\n') { lineBreaks += 1; index += 1; continue; }
    if (char === '"' || char === "'") { index = skipQuoted(text, index, char); continue; }
    if (char === '`') { index = skipTemplate(text, index); continue; }
    if (char === '/' && text[index + 1] === '/') { index = skipLineComment(text, index); continue; }
    if (char === '/' && text[index + 1] === '*') { index = skipBlockComment(text, index); continue; }
    if (char === '(' || char === '[') { paren += 1; index += 1; continue; }
    if (char === ')' || char === ']') { if (paren > 0) paren -= 1; index += 1; continue; }
    if (char === ';' && paren <= 0) return -1; // 先遇到语句结束：这条声明没有块体
    if (char === '{') return index;
    index += 1;
  }
  return -1;
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

/** 该声明行**自己**的块体（不向上找）：`{start,end}` 或 null。 */
export function declarationBlock(text, line, starts = lineStarts(text)) {
  if (!(line >= 1 && line <= starts.length)) return null;
  if (!isDeclarationLine(lineText(text, starts, line))) return null;
  const open = blockBodyIndex(text, starts[line - 1]);
  if (open < 0) return null;
  const close = braceBlockEnd(text, open);
  if (close < 0) return null;
  const endLine = text.slice(0, close).split('\n').length;
  if (endLine < line) return null;
  return { start: line, end: endLine };
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
