#!/usr/bin/env node
/**
 * `docs/verification/**` 的「注释锚点」影子闸门。
 *
 * 缺口（为什么需要这个独立工具）：主工具 `tools/verify-doc-anchors.mjs` 的符号行判据只对
 * `docs/architecture/**` 生效（见该文件 `SYMBOL_LINE_SCOPE`），`docs/verification/**` 里
 * **锚在一行注释上**的引用只进 `SYMBOL-LINE` 的「作用域外」读数，既不进 `commentAnchors`、
 * 也不进 `findings`。于是「把 `// PASS 9 · 24h 自衰减…` 这样的块首注释当成行为证据」在证据页里
 * 可以长期全绿：行号还在文件里、区间也有内容，四类结构判据没有一条会响。
 *
 * 本工具只做一件事：按主工具**同一套抽取口径**（显式 `path:NNN` + 同块继承的裸锚点 + 链接锚点，
 * 围栏代码块内的行不判）扫 `docs/verification/**` 下的 Markdown，判断每条锚点落到的**目标行**
 * 是不是注释行。是注释行的逐条列出（`doc:line -> target:NNN` + 该行原文前 120 字符），并按基线判「新增」。
 *
 * 判据边界（本片**不**声称的事，见证据页）：
 *   - 注释锚点不等于错锚点：证据页逐字引用一段判据注释原文，是本仓合法的证据形态；
 *     本工具只把它们从「无人看见」变成「有账可查」，不裁定每一条该不该改。
 *   - 只覆盖 `docs/verification/**`；`docs/architecture/**` 的注释锚点由主工具的
 *     `--symbol=strict` 管，本工具不替代、不扩面。
 *   - 只判「目标行的词法形态」，不判注释内容与文档断言是否同一件事。
 *
 * 基线 `tools/verification-comment-anchor-baseline.json`：条目含 `doc` / `line` / `target` / `from`
 * 四元组（外加 `to` / `kind` 便于阅读），`accepted` / `why` 记「为什么这批不立刻修」。
 * 闸门规则：**本次命中数 > 基线 ⇒ EXIT 1 并逐条点名**；≤ 基线 ⇒ EXIT 0，命中项仍逐条打印 WARN。
 * 基线里有、本次已不是注释行的条目 ⇒ 打印「可收紧基线」提示（缺省 WARN；`--require-no-stale` 可改判红）。
 * `--write-baseline` 只在显式传参时写盘，并打印「写入了 N 条」。
 *
 * 位移配对（2026-11-09 修订，事故见 `docs/verification/gy-r90-comment-anchor-relocation-20261109.md`）：
 * 旧键 `doc|line|target|from` 把**文档行号**编进去，于是「在锚点上方插一行散文」会让整页锚点换键，
 * 全部落到「基线外新增」⇒ 纯位移被误判成红。现在键拆两半：
 *   - **身份** = `doc|target|from|kindClass`（去掉文档行号，`kindClass` 只分 comment/code）；
 *   - **位置** = 文档行号 `line`。
 * 判定先按身份做**多重集**配对（同一身份可能出现多次，必须按重数配对，不能用 Set 去重）：
 *   同身份、文档行号相同 ⇒ `SAME`（打印 WARN）；
 *   同身份、文档行号不同 ⇒ `RELOCATED`（新分类，**缺省只告警、不判红**，另起一行读数）；
 *   当前侧身份重数多于基线 ⇒ 多出来的仍算 `NEW`（**承重判据，缺省 EXIT 1，不降级**）；
 *   基线侧多出来 ⇒ `STALE`（缺省 WARN，`--require-no-stale` 可改判红）。
 *
 * 区间锚点的判定行（同一片修订）：`to > from` 时不再只看 `from` 行——取**窗口内首个行为行**
 * （非空、且不是注释行）作证据行；有则 `kind=range-covers-code`、`text` 引用该行为行原文，
 * 并在 WARN/RELOCATED 行标注「区间证据行 N」。是否计入注释锚点仍按 `from` 行判：字节面上的
 * 「锚点落在注释行」这个契约不变，改的只是「区间里真正承载证据的那一行」与它的 kind 标签。
 *
 * 用法：
 *   node tools/verify-verification-comment-anchors.mjs
 *   node tools/verify-verification-comment-anchors.mjs --write-baseline
 *   node tools/verify-verification-comment-anchors.mjs --require-no-stale
 *   node tools/verify-verification-comment-anchors.mjs --root <夹具树> [--scan docs/verification] [--baseline tools/...json]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  attributeBareAnchors,
  buildFileNameIndex,
  extractReferences,
  isCommentLine,
  resolveScanTargets,
  resolveTarget,
  splitLines,
} from './verify-doc-anchors.mjs';

export const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SCAN = 'docs/verification';
export const DEFAULT_BASELINE = 'tools/verification-comment-anchor-baseline.json';
export const GATE = 'VERIFICATION-COMMENT-ANCHOR';
export const DEFAULT_ACCEPTED = 'gy-r90-comment-anchor-shadow-batch';
export const DEFAULT_WHY = '「逐字引用判据注释原文」在本仓是合法证据形态的一类（例如证据页引用 workflow 注释说明不变量），'
  + '这批历史命中未经逐条人工裁定，先整批登记为影子基线；闸门只拦基线之外的新增，修掉一条再由 --write-baseline 收紧。';

const JS_LIKE = new Set(['mjs', 'cjs', 'js', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'json', 'jsonc', 'css']);
const HTML_LIKE = new Set(['md', 'html']);

function toPosix(value) {
  return value.split('\\').join('/');
}

function extensionOf(path) {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  return match === null ? '' : match[1].toLowerCase();
}

/** 注释行的细分类（用于读数的分类构成；判定本身只看「是不是注释」）。 */
function commentKindOf(trimmed) {
  if (trimmed.startsWith('/**')) return 'jsdoc';
  if (trimmed.startsWith('//')) return 'line-comment';
  if (trimmed.startsWith('/*') || trimmed.startsWith('*/') || trimmed.startsWith('*')) return 'block-comment';
  if (trimmed.startsWith('--')) return 'sql-comment';
  if (trimmed.startsWith('#')) return 'hash-comment';
  if (trimmed.startsWith('<!--') || trimmed.startsWith('-->')) return 'html-comment';
  return 'comment';
}

/**
 * 每行「是不是注释行」的词法判定，带块注释状态：
 * C 风格块注释（含 JSDoc）与 HTML 注释的**中间行**即使不以 `*` 开头也算注释行；
 * 空行保持 `null`（空行是单独分类，且注释块里的空行不应把一条锚点算成「注释锚点」）。
 */
export function commentKindsOf(text, extension) {
  const lines = splitLines(text);
  const kinds = new Array(lines.length).fill(null);
  const js = JS_LIKE.has(extension);
  const html = HTML_LIKE.has(extension);
  let block = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let kind = block === null ? null : (block === 'js' ? 'block-comment' : 'html-comment');
    if (kind === null && isCommentLine(line, extension)) kind = commentKindOf(trimmed);
    if (js) {
      if (block === 'js') {
        if (line.includes('*/')) block = null;
      } else if (trimmed.startsWith('/*')) {
        // 只从「整行以块注释开头」的行开状态：`const url = 'audio/*'` 这类字符串里的 `/*`
        // 不是注释，按字符扫会把后面整份 JSON 误判成注释（2026-11-09 在 openapi.json 上实测过）。
        if (line.indexOf('*/', 2) === -1) block = 'js';
      }
    } else if (html) {
      if (block === 'html') {
        if (line.includes('-->')) block = null;
      } else if (trimmed.startsWith('<!--')) {
        if (line.indexOf('-->', 4) === -1) block = 'html';
      }
    }
    kinds[index] = kind;
  }
  return kinds;
}

function readTargetInfo(root, relativePath, cache) {
  if (!cache.has(relativePath)) {
    const text = readFileSync(join(root, relativePath), 'utf8');
    cache.set(relativePath, { lines: splitLines(text), kinds: commentKindsOf(text, extensionOf(relativePath)) });
  }
  return cache.get(relativePath);
}

/**
 * 区间锚点的证据行：`[from, to]` 里**首个行为行**（非空、且 `commentKindsOf` 判成代码行）。
 * 为什么不是直接看 `from`：`path:1337-1342` 的 1337 常是「判据注释」的块首，真正承载证据的是
 * 1338 那一行代码；只按 `from` 判 kind 会把这类锚点一律算成注释锚点，并把注释原文当成证据引用。
 * 返回 `null` = 整个窗口都是注释/空行（此时沿用 `from` 行的 kind）。
 */
export function findRangeEvidenceLine(lines, kinds, from, to) {
  for (let line = from; line <= to; line += 1) {
    if ((lines[line - 1] ?? '').trim() === '') continue;
    if ((kinds[line - 1] ?? null) === null) return line;
  }
  return null;
}

/**
 * 全量扫描：返回 `{ documents, anchors, unresolved, outOfRange, counts }`。
 * `anchors` 每条 = `{ doc, line, target, from, to, kind, text, bare }`；
 * `counts` 的六格互斥：`comment` / `code` / `blank` / `outOfRange` / `unresolved` / `fenced`；
 * `duplicate` 是同一文档行/目标/起始行的重复引用（显式锚点与继承锚点撞车），
 * 六格 + `duplicate` 相加等于 `candidates`。
 */
export function collectCommentAnchors({ root = TOOL_ROOT, scan = DEFAULT_SCAN } = {}) {
  const documents = resolveScanTargets(root, [scan]);
  const fileIndex = buildFileNameIndex(root);
  const targetCache = new Map();
  const anchors = [];
  const unresolved = [];
  const outOfRange = [];
  const counts = {
    documents: documents.length,
    candidates: 0,
    comment: 0,
    code: 0,
    blank: 0,
    outOfRange: 0,
    unresolved: 0,
    ambiguous: 0,
    fenced: 0,
    duplicate: 0,
  };
  for (const docPath of documents) {
    const text = readFileSync(join(root, docPath), 'utf8');
    const explicit = extractReferences(text);
    const attribution = attributeBareAnchors({
      text,
      references: explicit,
      resolveIdentity: reference => {
        const probe = resolveTarget({ root, docPath, target: reference.target, fileIndex });
        return probe.status === 'resolved' ? probe.relative : `?${reference.target}`;
      },
    });
    const rawQueue = [
      ...explicit.map(reference => ({ reference })),
      ...attribution.inherited.map(reference => ({ reference })),
    ];
    // 显式锚点与「同块裸锚点」可能指向同一行同一目标（`:12` 与 `path:12` 并存），先去重再计数，
    // 否则 `counts` 六格相加会小于 `candidates`，读起来像丢数。
    const refSeen = new Set();
    const queue = rawQueue.filter(({ reference }) => {
      const key = `${reference.docLine}|${reference.target}|${reference.from}|${reference.to}`;
      if (refSeen.has(key)) return false;
      refSeen.add(key);
      return true;
    });
    const seen = new Set();
    for (const { reference } of queue) {
      counts.candidates += 1;
      if (reference.fenced === true) {
        counts.fenced += 1;
        continue;
      }
      const resolved = resolveTarget({ root, docPath, target: reference.target, fileIndex });
      if (resolved.status !== 'resolved') {
        counts.unresolved += 1;
        if (resolved.status === 'ambiguous') counts.ambiguous += 1;
        unresolved.push({
          doc: docPath,
          line: reference.docLine,
          target: reference.target,
          from: reference.from,
          reason: resolved.status,
        });
        continue;
      }
      const { lines, kinds } = readTargetInfo(root, resolved.relative, targetCache);
      if (reference.from < 1 || reference.to < reference.from || reference.to > lines.length) {
        counts.outOfRange += 1;
        outOfRange.push({
          doc: docPath,
          line: reference.docLine,
          target: resolved.relative,
          from: reference.from,
          to: reference.to,
          lineCount: lines.length,
        });
        continue;
      }
      const raw = lines[reference.from - 1] ?? '';
      if (raw.trim() === '') {
        counts.blank += 1;
        continue;
      }
      const kind = kinds[reference.from - 1] ?? null;
      if (kind === null) {
        counts.code += 1;
        continue;
      }
      // 区间锚点：证据行取窗口内首个行为行（见 findRangeEvidenceLine 的说明）；
      // 是否算注释锚点仍按 `from` 判，改的只是「哪一行承载证据」与 kind 标签。
      const evidenceFrom = reference.to > reference.from
        ? findRangeEvidenceLine(lines, kinds, reference.from, reference.to)
        : null;
      const key = `${docPath}|${reference.docLine}|${resolved.relative}|${reference.from}`;
      if (seen.has(key)) {
        counts.duplicate += 1;
        continue;
      }
      seen.add(key);
      counts.comment += 1;
      const evidenceRaw = evidenceFrom === null ? raw : (lines[evidenceFrom - 1] ?? raw);
      anchors.push({
        doc: docPath,
        line: reference.docLine,
        target: resolved.relative,
        from: reference.from,
        to: reference.to,
        kind: evidenceFrom === null ? kind : 'range-covers-code',
        evidenceFrom,
        text: evidenceRaw.trim().slice(0, 120),
        bare: reference.bare === true,
      });
    }
  }
  anchors.sort(compareAnchors);
  unresolved.sort((a, b) => a.doc.localeCompare(b.doc) || a.line - b.line);
  outOfRange.sort((a, b) => a.doc.localeCompare(b.doc) || a.line - b.line);
  return { documents, scan, anchors, unresolved, outOfRange, counts };
}

function compareAnchors(a, b) {
  return a.doc.localeCompare(b.doc) || a.line - b.line || a.target.localeCompare(b.target) || a.from - b.from;
}

/**
 * 基线条目键（**位置敏感**的旧四元组 `doc + line + target + from`）。
 * 2026-11-09 起它只用于「同一位置是否仍在」的簿记；闸门判定改用 `identityKey` + 多重集配对，
 * 否则「文档插一行散文」会让整页锚点换键、全被判成 NEW（见文件头「位移配对」）。
 */
export function baselineKey(entry) {
  return `${entry.doc}|${entry.line}|${entry.target}|${entry.from}`;
}

/**
 * 身份键（**位置无关**）：`doc|target|from|kindClass`，去掉文档行号。
 * `kind` 只取粗类 comment/code——细分 kind（jsdoc / line-comment / block-comment /
 * range-covers-code）是描述性的，若进身份键，注释风格改写或本片对区间 kind 的修订
 * 会让冻结条目整体掉出配对、被误判成 NEW。
 */
export function identityKey(entry) {
  const kindClass = entry.kind === null || entry.kind === undefined || entry.kind === 'code' ? 'code' : 'comment';
  return `${entry.doc}|${entry.target}|${entry.from}|${kindClass}`;
}

export function loadBaseline(root = TOOL_ROOT, baselinePath = DEFAULT_BASELINE) {
  const absolute = resolve(root, baselinePath);
  if (!existsSync(absolute)) {
    return { path: toPosix(baselinePath), missing: true, entries: [], accepted: '', why: '' };
  }
  const book = JSON.parse(readFileSync(absolute, 'utf8'));
  return {
    path: toPosix(baselinePath),
    missing: false,
    entries: Array.isArray(book.entries) ? book.entries : [],
    accepted: typeof book.accepted === 'string' ? book.accepted : '',
    why: typeof book.why === 'string' ? book.why : '',
  };
}

/** 生成基线 JSON：排序稳定、不带时间戳；条目只留四元组 + `to` / `kind`（不带原文，避免注释文案改动刷 diff）。 */
export function renderBaseline({ anchors, accepted = DEFAULT_ACCEPTED, why = DEFAULT_WHY }) {
  const entries = anchors
    .map(({ doc, line, target, from, to, kind }) => ({ doc, line, target, from, to, kind }))
    .sort(compareAnchors);
  const book = {
    version: 1,
    scope: `${DEFAULT_SCAN}/**/*.md`,
    accepted,
    why,
    entries,
  };
  return `${JSON.stringify(book, null, 2)}\n`;
}

/** 基线里有、本次没命中：说清是哪一种「收紧」，避免把「已修」和「文档行号移动」混为一谈。 */
export function describeStale(entry, { root = TOOL_ROOT, fileIndex = null } = {}) {
  if (!existsSync(join(root, entry.doc))) return '文档已不存在';
  const index = fileIndex ?? buildFileNameIndex(root);
  const resolved = resolveTarget({ root, docPath: entry.doc, target: entry.target, fileIndex: index });
  if (resolved.status !== 'resolved') return '目标文件已无法解析';
  const { lines, kinds } = readTargetInfo(root, resolved.relative, new Map());
  if (entry.from < 1 || entry.from > lines.length) return '目标行号越界';
  if ((kinds[entry.from - 1] ?? null) !== null) return `目标行仍是注释行（基线文档行 ${entry.line} 未配到同身份条目：锚点可能已删/改编，或目标行位移后仍无法配对）`;
  return '目标行已不是注释行（疑似已修）';
}

/**
 * 闸门判定：基线外新增 ⇒ 红（`requireNoNew` 缺省开）；基线陈旧 ⇒ 只提示，`requireNoStale` 可改判红。
 * 返回的 `same` / `relocated` / `newAnchors` / `staleEntries` 就是输出清单，调用方不再二次筛选。
 *
 * 配对口径（多重集，不是 Set）：
 *   1. 先按 `identityKey` 把基线条目与本次命中各自分组——同一身份可以出现多次（例如两行文档
 *      引用同一目标的同一行），**必须按重数配对**；
 *   2. 组内先配文档行号相同的（`SAME`），再按行号排序把两侧剩下的按 `min(重数)` 配成
 *      `RELOCATED`（文档行号变了、锚点语义没变）；
 *   3. 当前侧剩下的重数才是 `NEW`（承重判据）；基线侧剩下的重数才是 `STALE`。
 * 这样「删掉重复锚点里的一条」只会消掉一条，同身份的另一条不会被配对吞掉。
 */
export function evaluateCommentAnchorGate({
  anchors,
  baseline,
  requireNoNew = true,
  requireNoStale = false,
  root = TOOL_ROOT,
  fileIndex = null,
}) {
  const groupBy = (items, keyOf) => {
    const groups = new Map();
    for (const item of items) {
      const key = keyOf(item);
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [item]);
      else group.push(item);
    }
    return groups;
  };
  const baselineByIdentity = groupBy(baseline.entries, identityKey);
  const currentByIdentity = groupBy(anchors, identityKey);
  const identities = new Set([...baselineByIdentity.keys(), ...currentByIdentity.keys()]);

  const same = [];
  const relocated = [];
  const newAnchors = [];
  const staleRaw = [];
  for (const identity of identities) {
    const currentAnchors = currentByIdentity.get(identity) ?? [];
    const remainingBaseline = (baselineByIdentity.get(identity) ?? []).slice();
    const remainingCurrent = [];
    for (const anchor of currentAnchors) {
      const at = remainingBaseline.findIndex(entry => entry.line === anchor.line);
      if (at === -1) {
        remainingCurrent.push(anchor);
        continue;
      }
      remainingBaseline.splice(at, 1);
      same.push(anchor);
    }
    remainingCurrent.sort(compareAnchors);
    remainingBaseline.sort((a, b) => a.line - b.line);
    const paired = Math.min(remainingCurrent.length, remainingBaseline.length);
    for (let index = 0; index < paired; index += 1) {
      relocated.push({ anchor: remainingCurrent[index], entry: remainingBaseline[index] });
    }
    for (let index = paired; index < remainingCurrent.length; index += 1) newAnchors.push(remainingCurrent[index]);
    for (let index = paired; index < remainingBaseline.length; index += 1) staleRaw.push(remainingBaseline[index]);
  }
  const index = fileIndex ?? buildFileNameIndex(root);
  const staleEntries = staleRaw
    .map(entry => ({ ...entry, staleReason: describeStale(entry, { root, fileIndex: index }) }))
    .sort((a, b) => a.doc.localeCompare(b.doc) || a.line - b.line);
  same.sort(compareAnchors);
  newAnchors.sort(compareAnchors);
  relocated.sort((a, b) => compareAnchors(a.anchor, b.anchor));
  const failed = (requireNoNew && newAnchors.length > 0) || (requireNoStale && staleEntries.length > 0);
  return { same, relocated, newAnchors, staleEntries, failed };
}

export function parseArgs(argv) {
  const options = {
    root: TOOL_ROOT,
    scan: DEFAULT_SCAN,
    baseline: DEFAULT_BASELINE,
    requireNoNew: true,
    requireNoStale: false,
    writeBaseline: false,
    accepted: null,
    why: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const value = () => {
      if (inline !== null) return inline;
      index += 1;
      if (index >= argv.length) throw new Error(`${name} 需要一个值`);
      return argv[index];
    };
    if (name === '--root') options.root = value();
    else if (name === '--scan') options.scan = value();
    else if (name === '--baseline') options.baseline = value();
    else if (name === '--accepted') options.accepted = value();
    else if (name === '--why') options.why = value();
    else if (name === '--write-baseline') options.writeBaseline = true;
    else if (name === '--require-no-new') options.requireNoNew = true;
    else if (name === '--no-require-no-new') options.requireNoNew = false;
    else if (name === '--require-no-stale') options.requireNoStale = true;
    else if (name === '--help' || name === '-h') options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

function printSummary(streams, collected) {
  const { counts } = collected;
  streams.log(`${GATE}: candidates=${counts.candidates} comment=${counts.comment} code=${counts.code} `
    + `blank=${counts.blank} out-of-range=${counts.outOfRange} unresolved=${counts.unresolved} fenced=${counts.fenced} `
    + `duplicate=${counts.duplicate}`);
  streams.log(`${GATE}-SCOPE: ${collected.scan}/**/*.md documents=${counts.documents} `
    + `（unresolved 中 ambiguous=${counts.ambiguous}）`);
}

function printAnchor(streams, label, anchor, note = '') {
  const range = anchor.to === anchor.from ? `${anchor.from}` : `${anchor.from}-${anchor.to}`;
  const evidence = anchor.evidenceFrom === null || anchor.evidenceFrom === undefined
    ? ''
    : `（区间证据行 ${anchor.evidenceFrom}）`;
  streams.log(`${label} ${anchor.doc}:${anchor.line} -> ${anchor.target}:${range}  ${note}${evidence}${anchor.text}`);
}

/** FAIL 时逐条落点：说清是哪一条、以及它该登记到基线 JSON 的哪四个字段。 */
function printFailedEntries(streams, newAnchors, limit = 100) {
  for (const anchor of newAnchors.slice(0, limit)) {
    const range = anchor.to === anchor.from ? `${anchor.from}` : `${anchor.from}-${anchor.to}`;
    streams.error(`${GATE}-FAIL-ENTRY: ${anchor.doc}:${anchor.line} -> ${anchor.target}:${range}`
      + `（kind=${anchor.kind}；登记落点：doc/line/target/from 四字段）`);
  }
  if (newAnchors.length > limit) {
    streams.error(`${GATE}-FAIL-ENTRY: 另有 ${newAnchors.length - limit} 条，见上面的 NEW 行`);
  }
}

export function main(argv = process.argv.slice(2), streams = { log: console.log, error: console.error }) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    streams.error(`ERR: ${error.message}`);
    return 2;
  }
  if (options.help === true) {
    streams.log(`${GATE}: see header of tools/verify-verification-comment-anchors.mjs`);
    return 0;
  }
  const root = resolve(options.root);
  let collected;
  try {
    collected = collectCommentAnchors({ root, scan: options.scan });
  } catch (error) {
    streams.error(`ERR: ${error.message}`);
    return 2;
  }
  const baseline = loadBaseline(root, options.baseline);
  if (options.writeBaseline) {
    const accepted = options.accepted ?? (baseline.accepted === '' ? DEFAULT_ACCEPTED : baseline.accepted);
    const why = options.why ?? (baseline.why === '' ? DEFAULT_WHY : baseline.why);
    const body = renderBaseline({ anchors: collected.anchors, accepted, why });
    writeFileSync(resolve(root, options.baseline), body);
    streams.log(`WRITE: ${toPosix(options.baseline)} 写入了 ${collected.anchors.length} 条`
      + `（accepted=${accepted}）`);
    return 0;
  }
  printSummary(streams, collected);
  streams.log(`${GATE}-BASELINE: path=${baseline.path} entries=${baseline.entries.length}`
    + `${baseline.missing ? '（缺失：按 0 条基线处理，所有命中都算新增）' : ''}`
    + `${baseline.accepted === '' ? '' : ` accepted=${baseline.accepted}`}`);
  const gate = evaluateCommentAnchorGate({
    anchors: collected.anchors,
    baseline,
    requireNoNew: options.requireNoNew,
    requireNoStale: options.requireNoStale,
    root,
  });
  const newSet = new Set(gate.newAnchors);
  const relocatedByAnchor = new Map(gate.relocated.map(pair => [pair.anchor, pair.entry]));
  for (const anchor of collected.anchors) {
    if (newSet.has(anchor)) {
      printAnchor(streams, 'NEW ', anchor);
    } else if (relocatedByAnchor.has(anchor)) {
      const entry = relocatedByAnchor.get(anchor);
      printAnchor(streams, 'RELOCATED', anchor, `（位移：基线文档行 ${entry.line} → ${anchor.line}）`);
    } else {
      printAnchor(streams, 'WARN', anchor);
    }
  }
  for (const entry of gate.staleEntries) {
    const range = entry.to === entry.from ? `${entry.from}` : `${entry.from}-${entry.to}`;
    streams.log(`STALE ${entry.doc}:${entry.line} -> ${entry.target}:${range} （可收紧基线：${entry.staleReason}；`
      + '确认后跑 --write-baseline 收册）');
  }
  streams.log(`${GATE}-GATE: 本次命中 ${collected.anchors.length}、基线 ${baseline.entries.length}、`
    + `基线外新增 ${gate.newAnchors.length}、可收紧 ${gate.staleEntries.length}`
    + `（--require-no-new=${options.requireNoNew ? 'on' : 'off'}、--require-no-stale=${options.requireNoStale ? 'on' : 'off'}）`);
  // 新增读数另起一行（上面 -GATE 行的格式被测试与证据页 grep，逐字不动）。
  streams.log(`${GATE}-RELOCATED: RELOCATED ${gate.relocated.length} 条（同一身份 doc|target|from、文档行号变化；`
    + '默认只告警、不判红）');
  const rangeAnchors = collected.anchors.filter(anchor => anchor.to > anchor.from);
  const rangeEvidence = rangeAnchors.filter(anchor => anchor.evidenceFrom !== null && anchor.evidenceFrom !== undefined);
  streams.log(`${GATE}-RANGE: 区间锚点 ${rangeAnchors.length} 条，其中窗口内有行为行 ${rangeEvidence.length} 条`
    + '（kind=range-covers-code；行上标注「区间证据行」）');
  if (gate.newAnchors.length > 0 && options.requireNoNew) {
    streams.error(`${GATE}-FAIL: 基线外新增 ${gate.newAnchors.length} 条注释锚点（见上面的 NEW 行）——`
      + '要么把锚点改到实质行，要么显式 --write-baseline 登记并写明理由');
    printFailedEntries(streams, gate.newAnchors);
    return 1;
  }
  if (gate.staleEntries.length > 0 && options.requireNoStale) {
    streams.error(`${GATE}-FAIL: 基线有 ${gate.staleEntries.length} 条已不再命中（见上面的 STALE 行）`);
    return 1;
  }
  if (gate.staleEntries.length > 0) {
    streams.log(`${GATE}-WARN: 基线有 ${gate.staleEntries.length} 条已不再命中，可收紧基线`
      + '（当前只提示、不改退出码；需要钉死时加 --require-no-stale）');
  }
  streams.log(`${GATE}-PASS: 基线内 ${collected.anchors.length - gate.newAnchors.length} 条注释锚点只告警，`
    + `没有基线外新增${gate.staleEntries.length > 0 ? '；另有可收紧条目待人工收册' : ''}`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
