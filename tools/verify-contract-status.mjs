/** Contract projection checks; semantic completion remains a human judgement. */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  operationKey, scanMountedRoutes, mountedMismatches, runtimeMountedRoutes,
  evidenceWithinRepository, replaceStatusTables,
  routeDeclarations, declarationSegments, assertionArgumentRanges, operationMentions,
} from './contract-status-core.mjs';
// 锚点归属块的提取器与符号解析只有一份实现（tools/lib/anchor-resolve.mjs），
// `--reanchor` 落盘用的区间与符号形态运行时算出的区间走的是同一套口径，不另写第二份。
import { anchorLineNumbers, enclosingBlock, locatorSpec, resolveSymbolBlock } from './lib/anchor-resolve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATUS_FILE = join(ROOT, 'docs/architecture/contract-status.json');
const DOCUMENT_FILE = join(ROOT, 'docs/architecture/contract-implementation-status.md');
const OPERATIONS_FILE = join(ROOT, 'packages/contracts/operations.json');
const flags = new Set(process.argv.slice(2));
if ([...flags].some(flag => !['--runtime', '--write-doc', '--reanchor'].includes(flag))) {
  console.error('用法：node tools/verify-contract-status.mjs [--runtime] [--write-doc] [--reanchor]');
  process.exit(1);
}
const errors = [];
const check = (condition, message) => { if (!condition) errors.push(message); };
// 三类输出互不冒充：形状错误（引用形式）、语义错误（引用与操作的对应关系）、表格漂移（文档未同步）。
// 三者分开收集、分开计数，任何一类都不得被另一类的通过冲掉。
const semanticErrors = [];
const driftErrors = [];
const semanticCounts = { intervals: 0, snippets: 0 };
const uncertifiable = { intervals: 0, snippets: 0 };
// 证据锚点（符号）校验：引用若自带锚点文本，锚点必须真的出现在它引用的那几行里，否则引用与符号对不上。
// 容差 ±2 行的实测依据（基线 56042f7 的 229 条带行号引用，向上找最近的 function/const/class 声明行）：
// 区间起点正好落在声明行 41 条、落在声明后 1 行 25 条、后 2 行 9 条、后 3 行 12 条、更远 121 条，另有 21 条上方无声明。
// 取 0 会把「引用裁掉了声明行后的空行/注释」那 34 条（14.85%）正确锚点误判成错位；取 3 只多覆盖 12 条（5.24%），
// 却开始把「隔一条语句」也算命中，判别力反而下降。故取 2，并在证据页写清依据。
const ANCHOR_TOLERANCE = 2;
const anchorCounts = { referenced: 0, inRange: 0, fileOnly: 0 };
const anchorGaps = { lineOnly: 0, noLines: 0, testNoName: 0 };
const anchorSuspicions = [];
// 区间内容口径：纯行号引用也要能「咬」到东西——整段只剩空白/收尾行说明引用没指到实现。
// 基线 56042f7 实测 229 条区间里 15 条整段无实质内容（多为社区域 `:200-200` 这类指向 `});` 的引用），
// 命中率不为 0，所以只计可疑、不判红；区间首行为空行 24 条同样只计数。
const CLOSING_LINE = /^(?:[}\]\)]+;?|end;?|--|\/\*.*\*\/)$/i;
const isSubstantiveLine = line => {
  const trimmed = line.trim();
  return trimmed !== '' && !CLOSING_LINE.test(trimmed);
};
const contentCounts = { lineRefs: 0, symbolRefs: 0, contentless: 0, blankStart: 0 };
const contentlessSuspicions = [];
let synchronized = false;
const evidenceTexts = new Map();
const readEvidence = absolute => {
  if (!evidenceTexts.has(absolute)) evidenceTexts.set(absolute, readFileSync(absolute, 'utf8'));
  return evidenceTexts.get(absolute);
};
// 引用必须是**文件**：目录（以及 FIFO、socket 等非常规文件）自己不是可读证据。
// statSync 会跟随符号链接，仓库边界仍由 evidenceWithinRepository 单独判定。
const isRegularFile = path => {
  try { return statSync(path).isFile(); } catch { return false; }
};
// 锚点字段：`symbol` 与 `anchor` 同义、二选一（同给且不同值即形状错误）；test 引用的 `name` 本身就是用例名锚点。
// 锚点语义是「这段引用里属于本操作的那一行/那几行」，不是「所属函数名」——后者落在区间外，本工具会判语义错误。
const anchorSpec = item => {
  const present = ['symbol', 'anchor'].filter(key => item[key] !== undefined);
  if (present.length === 2 && item.symbol !== item.anchor) return { kind: 'conflict' };
  if (present.length >= 1) {
    const [key] = present;
    if (typeof item[key] !== 'string' || item[key].trim() === '') return { kind: 'invalid', key };
    return { kind: 'value', key, value: item[key] };
  }
  if (typeof item.test === 'string' && typeof item.name === 'string' && item.name !== '') return { kind: 'value', key: 'name', value: item.name };
  return { kind: 'none' };
};
// ── 锚点两种形态：行号形态与符号形态 ──────────────────────────────────────────
// 行号形态：`lines: "1825-1833"`——值由人写死，代码往上一挪就漂（app.ts 同一段在 #407／#419／#469／#474
//   四张 PR 里各改一次，任意两张同存即 1 块互斥冲突，谁后合谁都要重锚）。
// 符号形态：`locator: {symbol: "registerAccountDeletionRoutes", file?: "…"}`——台账里不存行号，
//   每次运行用 tools/lib/anchor-resolve.mjs 的**同一套**归属块口径算出来（与 `--reanchor` 落盘同源）。
// 两种形态二选一：同时给 `lines` 与 `locator` 是形状错误（两套值并存 = 不知道该信哪个）。
// 解析失败（MISSING 0 个候选 / NO_BLOCK 声明无块体 / AMBIGUOUS 多个候选）一律**形状错误 ⇒ exit 1 并列出候选**；
//   ⛔ 不许静默降级成「没有行号 ⇒ 只计不可核」——那正是漂移长期不被自动发现的旧路。
// 区间级校验（内容/语义/锚点容差）拿到的是同一份解析结果（按证据项缓存一次，不重算也不另写一套）。
const anchorRanges = new Map();
const symbolAnchors = [];
function anchorRange(item, path, text) {
  if (anchorRanges.has(item)) return anchorRanges.get(item);
  const locator = locatorSpec(item);
  const match = /^(\d+)-(\d+)$/.exec(typeof item.lines === 'string' ? item.lines : '');
  const target = locator.kind === 'value' ? (locator.file ?? path) : path;
  // 符号形态的 `file` 可以指到另一个文件：内容与锚点文本都以被指的那个文件为准。
  const targetReadable = target !== undefined && (target === path || (evidenceWithinRepository(ROOT, target) && isRegularFile(resolve(ROOT, target))));
  const targetText = targetReadable && target !== path ? readEvidence(resolve(ROOT, target)) : text;
  const record = locator.kind === 'value'
    ? { source: 'symbol', from: 0, to: 0, target, text: targetText, symbol: locator.symbol, locator, failure: null }
    : { source: match === null ? 'none' : 'lines', from: match === null ? 0 : Number(match[1]), to: match === null ? 0 : Number(match[2]), target, text: targetText, symbol: null, locator, failure: null };
  if (locator.kind === 'value') {
    // 文件不可读时不拿别的文件去猜：直接记 UNREADABLE，区间级校验跳过，形状校验负责报红。
    if (!targetReadable || targetText === null) {
      record.failure = { status: 'UNREADABLE', reason: `UNREADABLE：locator.file 不可读或不在公开仓库源码范围内 ${target}` };
    } else {
      const resolved = resolveSymbolBlock(targetText, locator.symbol);
      if (resolved.status === 'OK') { record.from = resolved.candidates[0].start; record.to = resolved.candidates[0].end; }
      else record.failure = resolved;
    }
  }
  anchorRanges.set(item, record);
  return record;
}
// 报告里怎么称呼一条引用：行号形态 `path:起-止`，符号形态 `path#符号（解析为 起-止）`。
const rangeLabel = record => record.source === 'symbol'
  ? `${record.target}#${record.symbol}（解析为 ${record.from}-${record.to}）`
  : `${record.target}:${record.from}-${record.to}`;
// ── 锚点自动重定位（--reanchor）────────────────────────────────────────────────
// 只重写 evidence 的 `lines` 字符串值：默认 dry-run 只报不改，`--reanchor --write-doc` 才落盘。
// 存在任一拒绝项就整体 exit 1 且不写盘（写盘前先把全部候选算完）：
//   MISSING   锚点文本在文件里出现 0 次——无从定位，不许猜；
//   AMBIGUOUS 锚点落在多个不同归属块里——不猜，列出全部候选行号；
//   UNSAFE    算出的区间会被校验器自己判红（区间等于整个文件），或写盘前的字节保真自检不通过；
//   SYMBOL    符号形态（`locator`）解析失败——台账里没有行号可写，只能报出来让人判断。
// 符号形态的引用**没有可重写的东西**：只把当前解析出的区间打出来（`REANCHOR: …#符号 … ⇒ 起-止`），
//   台账一字节不动；漂移由运行时解析吸收，这正是本片要的效果，不是「漏重锚」。
// 「已漂移」的判据与 checkAnchors 同口径：锚点命中行全部落在 lines ±容差之外（或 lines 越界/不成形）。
// 归属块的求法在 tools/lib/anchor-resolve.mjs 的 enclosingBlock，口径写在那里，报告里 FALLBACK 可见。
const ledgerEntries = ledger => [
  ...(ledger.operations ?? []).map(entry => ({ entry, owner: entry.id ?? operationKey(entry.method, entry.path), operation: true })),
  ...(ledger.dimensions ?? []).map(entry => ({ entry, owner: `dimension ${entry.key}`, operation: false })),
];
// 台账文本里 "lines" 字符串值的出现次序：先 operations 再 dimensions，各自按 evidence 顺序。
const ledgerLinesOrder = ledger => {
  const order = new Map();
  let index = 0;
  for (const { entry } of ledgerEntries(ledger)) {
    for (const item of entry.evidence ?? []) {
      if (typeof item.lines !== 'string') continue;
      order.set(item, index);
      index += 1;
    }
  }
  return order;
};
const ledgerLinesValues = ledger => ledgerEntries(ledger)
  .flatMap(({ entry }) => (entry.evidence ?? []).filter(item => typeof item.lines === 'string').map(item => item.lines));
function planReanchors(ledger) {
  const order = ledgerLinesOrder(ledger);
  const plan = { candidates: [], MISSING: [], AMBIGUOUS: [], UNSAFE: [], SYMBOL: [], symbolResolved: [], scanned: 0, symbols: 0, consistent: 0, unreadable: 0 };
  for (const { entry, owner, operation } of ledgerEntries(ledger)) {
    for (const item of entry.evidence ?? []) {
      const anchor = anchorSpec(item);
      const path = [item.path, item.test].find(value => typeof value === 'string');
      // 符号形态：台账里没有行号，只核「能不能解析出来」，解析不了就报 SYMBOL 并整体拒绝。
      const locator = locatorSpec(item);
      if (locator.kind === 'value') {
        plan.symbols += 1;
        const target = locator.file ?? path;
        if (target === undefined || !evidenceWithinRepository(ROOT, target) || !isRegularFile(resolve(ROOT, target))) { plan.unreadable += 1; continue; }
        const resolved = resolveSymbolBlock(readEvidence(resolve(ROOT, target)), locator.symbol);
        if (resolved.status === 'OK') plan.symbolResolved.push({ owner, target, symbol: locator.symbol, block: resolved.candidates[0] });
        else plan.SYMBOL.push({ owner, target, symbol: locator.symbol, reason: resolved.reason });
        continue;
      }
      // 行号形态（旧形态）：「有锚点文本 + 有行号」才谈得上重写。
      if (anchor.kind !== 'value' || typeof item.lines !== 'string') continue;
      plan.scanned += 1;
      const reference = `${path}:${item.lines}`;
      if (path === undefined || !evidenceWithinRepository(ROOT, path)) { plan.unreadable += 1; continue; }
      const absolute = resolve(ROOT, path);
      if (!isRegularFile(absolute)) { plan.unreadable += 1; continue; }
      const text = readEvidence(absolute);
      const hits = anchorLineNumbers(text, anchor.value);
      if (hits.length === 0) { plan.MISSING.push({ owner, reference, value: anchor.value }); continue; }
      const totalLines = text.split('\n').length;
      const match = /^(\d+)-(\d+)$/.exec(item.lines);
      const from = match === null ? 0 : Number(match[1]);
      const to = match === null ? 0 : Number(match[2]);
      const valid = match !== null && from >= 1 && to >= from && to <= totalLines;
      if (valid && hits.some(line => from - ANCHOR_TOLERANCE <= line && line <= to + ANCHOR_TOLERANCE)) { plan.consistent += 1; continue; }
      const blocks = [];
      for (const line of hits) {
        const block = enclosingBlock(text, line);
        if (!blocks.some(other => other.start === block.start && other.end === block.end)) blocks.push(block);
      }
      if (blocks.length > 1) { plan.AMBIGUOUS.push({ owner, reference, value: anchor.value, hits, blocks }); continue; }
      const [block] = blocks;
      if (operation && block.start === 1 && block.end >= totalLines - 1) { plan.UNSAFE.push({ owner, reference, value: anchor.value, block }); continue; }
      plan.candidates.push({ owner, path, value: anchor.value, hits, block, oldLines: item.lines, newLines: `${block.start}-${block.end}`, order: order.get(item) });
    }
  }
  return plan;
}
// 按字符偏移只替换 `"lines"` 的字符串值：键顺序、缩进、EOL、中文都不经过再序列化，天然逐字节保留。
// 先按出现次序把文本里的 "lines" 值与解析后的条目一一对上；数量或取值对不上就拒绝写盘。
function rewriteLineValues(ledger, raw, candidates) {
  const spans = [...raw.matchAll(/"lines"\s*:\s*"([^"\\]*)"/g)].map(match => ({
    value: match[1],
    start: match.index + match[0].length - 1 - match[1].length,
  }));
  const expected = ledgerLinesValues(ledger);
  if (spans.length !== expected.length || spans.some((span, index) => span.value !== expected[index])) {
    return { error: `台账文本里的 "lines" 值（${spans.length} 处）与解析后的条目（${expected.length} 处）对不上，拒绝写盘（宁可不改，也不猜哪一处属于哪一条）` };
  }
  const ordered = [...candidates].sort((left, right) => right.order - left.order);
  let updated = raw;
  for (const candidate of ordered) {
    const span = spans[candidate.order];
    updated = updated.slice(0, span.start) + candidate.newLines + updated.slice(span.start + span.value.length);
  }
  // 字节保真自检：把新值逐个换回旧值必须逐字节还原原文，否则说明动到了 lines 以外的字节。
  let restored = updated;
  for (const candidate of ordered) {
    const span = spans[candidate.order];
    restored = restored.slice(0, span.start) + span.value + restored.slice(span.start + candidate.newLines.length);
  }
  if (restored !== raw) return { error: '写盘前字节保真自检失败：除 lines 值以外的字节没有原样保留' };
  try { JSON.parse(updated); } catch (error) { return { error: `写盘前自检失败：改写后不是合法 JSON（${error.message}）` }; }
  return { text: updated };
}
if (flags.has('--reanchor')) {
  const raw = readFileSync(STATUS_FILE, 'utf8');
  let ledger;
  try { ledger = JSON.parse(raw); } catch (error) {
    console.error(`ERROR: 形状错误 · 台账 JSON 无法解析，锚点重定位跳过：${error.message}`);
    process.exit(1);
  }
  const plan = planReanchors(ledger);
  for (const item of plan.MISSING) console.error(`ERROR: 重定位错误 · ${item.owner} ${item.reference} 的锚点「${item.value}」在文件里出现 0 次（MISSING）`);
  for (const item of plan.AMBIGUOUS) console.error(`ERROR: 重定位错误 · ${item.owner} ${item.reference} 的锚点「${item.value}」落在 ${item.blocks.length} 个不同归属块（候选行号第 ${item.hits.join('、')} 行；归属块 ${item.blocks.map(block => `${block.start}-${block.end}`).join('、')}）（AMBIGUOUS）`);
  for (const item of plan.UNSAFE) console.error(`ERROR: 重定位错误 · ${item.owner} ${item.reference} 算出的区间 ${item.block.start}-${item.block.end} 等于整个文件，校验器会判红（UNSAFE）`);
  for (const item of plan.SYMBOL) console.error(`ERROR: 重定位错误 · ${item.owner} ${item.target}#${item.symbol} 的符号锚点解析失败（${item.reason}）（SYMBOL）`);
  if (plan.MISSING.length + plan.AMBIGUOUS.length + plan.UNSAFE.length + plan.SYMBOL.length > 0) {
    console.error(`FAIL: 锚点重定位被拒绝（MISSING ${plan.MISSING.length} / AMBIGUOUS ${plan.AMBIGUOUS.length} / UNSAFE ${plan.UNSAFE.length} / SYMBOL ${plan.SYMBOL.length}），未写盘`);
    process.exit(1);
  }
  for (const item of plan.symbolResolved) {
    console.log(`REANCHOR: ${item.owner} ${item.target}#${item.symbol} 符号形态锚点，运行时解析为 ${item.block.start}-${item.block.end}（台账里没有行号，无需重写）`);
  }
  for (const candidate of plan.candidates) {
    console.log(`REANCHOR: ${candidate.owner} ${candidate.path} 旧 lines ${candidate.oldLines} → 新 lines ${candidate.newLines}（锚点「${candidate.value}」命中第 ${candidate.hits.join('、')} 行；归属块 ${candidate.block.start}-${candidate.block.end}${candidate.block.fallback ? '，FALLBACK 上方找不到声明行，退化为命中行单行' : ''}）`);
  }
  if (plan.candidates.length === 0) {
    console.log(`REANCHOR: 无可重定位项（带锚点且带行号的引用 ${plan.scanned} 条，锚点都在 ±${ANCHOR_TOLERANCE} 行容差内；符号形态 ${plan.symbols} 条按运行时解析，不写盘）`);
  } else if (!flags.has('--write-doc')) {
    console.log(`REANCHOR: 只报不改（dry-run）；${plan.candidates.length} 条候选，加 --write-doc 才会写盘。`);
  } else {
    const outcome = rewriteLineValues(ledger, raw, plan.candidates);
    if (outcome.error !== undefined) {
      console.error(`ERROR: 重定位错误 · ${outcome.error}（UNSAFE）`);
      console.error('FAIL: 锚点重定位被拒绝（UNSAFE 1），未写盘');
      process.exit(1);
    }
    writeFileSync(STATUS_FILE, outcome.text);
    console.log(`REANCHOR: 已重写 ${plan.candidates.length} 条 lines 值（只动这些字符串值，其余字节与改写前一致）。`);
  }
}
const status = JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
const operations = JSON.parse(readFileSync(OPERATIONS_FILE, 'utf8'));
const statuses = new Set(['implemented', 'partial', 'planned']);
const contractKeys = new Map(operations.operations.map(op => [operationKey(op.method, op.path), op]));
const seen = new Map();
check(status.contract_version === operations.contract_version, 'contract_version 与 operations.json 不一致');
check(Array.isArray(status.operations) && status.operations.length > 0, '缺少 operations 数组');
for (const entry of status.operations ?? []) {
  const key = operationKey(entry.method, entry.path);
  check(!seen.has(key), `重复条目：${key}`);
  seen.set(key, entry);
  const source = contractKeys.get(key);
  check(source !== undefined, `对照表出现契约中不存在的操作：${key}`);
  if (source) check(entry.id === source.id, `${key}: 操作 id 不一致`);
  check(typeof entry.route_mounted === 'boolean', `${key}: 缺少 route_mounted 布尔标记`);
  checkEntry(entry, key);
}
for (const key of contractKeys.keys()) check(seen.has(key), `对照表遗漏契约操作：${key}`);

let mounted = new Set(), unassembled = [];
try {
  ({ mounted, unassembled } = scanMountedRoutes(ROOT));
  errors.push(...mountedMismatches(status.operations ?? [], mounted));
  for (const key of mounted) check(seen.has(key), `源码已装配但对照表未登记：${key}`);
  if (flags.has('--runtime')) {
    const runtime = runtimeMountedRoutes(ROOT, operations.operations);
    errors.push(...mountedMismatches(status.operations ?? [], runtime).map(error => `实际产品装配：${error}`));
    for (const key of mounted) check(runtime.has(key), `静态扫描与实际装配不一致：${key}`);
    for (const key of runtime) check(mounted.has(key), `实际装配与静态扫描不一致：${key}`);
  }
} catch (error) { errors.push(`装配校验失败：${error.message}`); }

const required = ['error_codes', 'pagination', 'versioning', 'idempotency', 'source_kind', 'execution_modes', 'cancel', 'timeout'];
check(Array.isArray(status.dimensions) && status.dimensions.length > 0, '缺少 dimensions 数组');
const dimensionKeys = new Set();
for (const dimension of status.dimensions ?? []) {
  check(!dimensionKeys.has(dimension.key), `重复横切维度：${dimension.key}`);
  dimensionKeys.add(dimension.key);
  check(required.includes(dimension.key), `未知横切维度：${dimension.key}`);
  check(typeof dimension.source_anchor === 'string' && dimension.source_anchor.trim() !== '', `${dimension.key}: 缺少来源锚点`);
  checkEntry(dimension, `dimension ${dimension.key}`);
}
for (const key of required) check(dimensionKeys.has(key), `缺少横切维度：${key}`);

function checkEntry(entry, owner) {
  check(statuses.has(entry.status), `${owner}: 非法状态 ${entry.status}`);
  check(typeof entry.blocker === 'string' && entry.blocker.trim() !== '', `${owner}: 缺少缺口 / 条件`);
  check(Array.isArray(entry.evidence), `${owner}: evidence 必须是数组`);
  if (!Array.isArray(entry.evidence)) return;
  check(entry.status === 'planned' ? entry.evidence.length === 0 : entry.evidence.length > 0, `${owner}: 状态与证据数量不符`);
  for (const item of entry.evidence) {
    const targets = [item.path, item.test].filter(value => typeof value === 'string');
    check(targets.length === 1, `${owner}: 证据项必须且只能给 path 或 test`);
    if (targets.length !== 1) continue;
    const path = targets[0];
    if (!evidenceWithinRepository(ROOT, path)) {
      errors.push(`${owner}: 证据不在公开仓库源码范围内 ${path}`);
      continue;
    }
    const absolute = resolve(ROOT, path);
    check(isRegularFile(absolute), `${owner}: 证据文件不存在或不是文件 ${path}`);
    if (!isRegularFile(absolute)) continue;
    const text = readFileSync(absolute, 'utf8');
    if (typeof item.name === 'string' && item.name !== '') check(text.includes(item.name), `${owner}: ${path} 中找不到用例名「${item.name}」`);
    const anchor = anchorSpec(item);
    if (anchor.kind === 'conflict') errors.push(`${owner}: ${path} 的 symbol 与 anchor 同给且取值不同，锚点必须唯一`);
    if (anchor.kind === 'invalid') errors.push(`${owner}: ${path} 的锚点 ${anchor.key} 必须是非空字符串`);
    // 「锚点指不到任何东西」与「找不到用例名」同级：都是引用形式错误，不是语义判断。
    if (anchor.kind === 'value' && anchor.key !== 'name' && !text.includes(anchor.value)) {
      errors.push(`${owner}: ${path} 中找不到锚点「${anchor.value}」`);
    }
    if (item.lines !== undefined) {
      const match = /^(\d+)-(\d+)$/.exec(item.lines);
      check(match !== null, `${owner}: ${path} lines 必须是起-止`);
      if (match) check(Number(match[1]) >= 1 && Number(match[2]) >= Number(match[1]) && Number(match[2]) <= text.split('\n').length, `${owner}: ${path} lines=${item.lines} 越界`);
    }
    // 符号形态的形状校验：定位器必须成形、文件必须在仓库内、符号必须解析成**唯一**的块。
    // 解析失败一律形状错误（exit 1）并列出候选，不降级成「不可核」——降级等于让漂移重新隐形。
    const locator = locatorSpec(item);
    if (locator.kind === 'invalid') errors.push(`${owner}: ${path} 的符号锚点 locator 形状非法：${locator.message}`);
    if (locator.kind === 'value') {
      if (item.lines !== undefined) errors.push(`${owner}: ${path} 同时给了 lines 与 locator，锚点两种形态只能二选一`);
      const target = locator.file ?? path;
      const targetAbsolute = resolve(ROOT, target);
      const readable = evidenceWithinRepository(ROOT, target) && isRegularFile(targetAbsolute);
      if (!readable) {
        errors.push(`${owner}: 符号锚点 locator.file 不可读或不在公开仓库源码范围内 ${target}`);
      } else {
        const record = anchorRange(item, path, text);
        if (record.failure !== null) errors.push(`${owner}: ${target} 的符号锚点「${locator.symbol}」解析失败（${record.failure.reason}）`);
        else symbolAnchors.push({ owner, target, symbol: locator.symbol, from: record.from, to: record.to });
      }
    }
  }
}

// 语义可核校验：只判「引用位置与操作身份可证伪地冲突」的形态；判不了的如实记不可核，不默认通过。
// 形状错误（形式/边界/文件存在性）已由 checkEntry 收集，这里不重复判定，也不冒充形状通过。
const operationIds = (status.operations ?? []).map(entry => entry.id).filter(id => typeof id === 'string');
function checkSemantics(entry, owner) {
  for (const item of entry.evidence ?? []) {
    const path = [item.path, item.test].find(value => typeof value === 'string');
    if (path === undefined || !evidenceWithinRepository(ROOT, path)) continue;
    const absolute = resolve(ROOT, path);
    if (!isRegularFile(absolute)) continue;
    const text = readEvidence(absolute);
    if (typeof item.name === 'string' && item.name !== '') checkSnippetSemantics(entry, owner, path, text, item);
    // 两种锚点形态走同一条区间语义校验：符号形态用的是运行时解析出的区间，不是台账里的数字。
    const range = anchorRange(item, path, text);
    if (range.failure === null) checkIntervalSemantics(entry, owner, range);
  }
}
function checkIntervalSemantics(entry, owner, range) {
  const { from, to } = range;
  if (range.source === 'none') return; // 没有定位范围（形状错误已单独报告）
  // 符号形态的 locator.file 可能指到另一个文件：区间边界按**被定位的那个文件**算。
  const lines = range.text.split('\n');
  if (from < 1 || to < from || to > lines.length) return; // 越界已单独报告
  const label = rangeLabel(range);
  if (from === 1 && to >= lines.length - 1) {
    semanticErrors.push(`${owner}: ${label} 区间等于整个文件，无法定位具体实现`);
    return;
  }
  const declarations = routeDeclarations(range.text);
  if (declarations.length === 0) { uncertifiable.intervals += 1; return; }
  const segments = declarationSegments(range.text, declarations);
  const covered = segments.filter(segment => from <= segment.from && segment.to <= to);
  if (covered.length >= 2) {
    semanticErrors.push(`${owner}: ${label} 区间跨越 ${covered.length} 个操作注册块（${covered.map(segment => segment.routes.join('/')).join('、')}）`);
    return;
  }
  if (covered.length === 1) {
    const [segment] = covered;
    const key = operationKey(entry.method, entry.path);
    if (!segment.routes.includes(key)) {
      semanticErrors.push(`${owner}: ${label} 区间覆盖的是 ${segment.routes.join('、')} 的注册块，与 ${key} 不符`);
      return;
    }
    semanticCounts.intervals += 1;
    return;
  }
  const key = operationKey(entry.method, entry.path);
  const enclosing = segments.find(segment => segment.from <= from && to <= segment.to);
  if (enclosing === undefined) { uncertifiable.intervals += 1; return; }
  if (enclosing.routes.includes(key)) { semanticCounts.intervals += 1; return; }
  // 区间落在另一个操作的注册块里（未覆盖任何本操作注册块）：这是可证伪的错位，不是「不可核」。
  semanticErrors.push(`${owner}: ${label} 区间落在 ${enclosing.routes.join('、')} 的注册块内，未覆盖任何本操作注册块，与 ${key} 不符`);
}
function checkSnippetSemantics(entry, owner, path, text, item) {
  const positions = [];
  for (let index = text.indexOf(item.name); index !== -1; index = text.indexOf(item.name, index + 1)) positions.push(index);
  if (positions.length === 0) return; // 「找不到用例名」已作为形状错误报告
  const ranges = assertionArgumentRanges(text);
  const insideAssertion = positions.every(position => ranges.some(([start, end]) => start <= position && position + item.name.length <= end));
  if (!insideAssertion) { uncertifiable.snippets += 1; return; }
  const mentioned = operationMentions(item.name, operationIds);
  const foreign = mentioned.filter(id => id !== entry.id);
  if (foreign.length > 0 && !mentioned.includes(entry.id)) {
    semanticErrors.push(`${owner}: ${path} 片段「${item.name}」取自 ${foreign.join('、')} 的断言，与 ${entry.id} 不符`);
    return;
  }
  semanticCounts.snippets += 1;
}
for (const entry of status.operations ?? []) checkSemantics(entry, entry.id ?? operationKey(entry.method, entry.path));

// 锚点校验：同时覆盖 operations 与 dimensions（dimensions 的带行号证据此前从没被区间检查覆盖过）。
// 三档互不冒充：找不到锚点 = 形状错误；锚点在文件里但落区间外 = 语义错误（可核计数）；
// 压根没有锚点 = 只计「不可核」并列可疑，不判红（基线实测 0/409 条锚点，缺锚点是台账现状，不是本片要的错）。
// 区间内容可疑档与锚点无关：任何有定位范围的引用（行号形态或符号形态）都量「这段里有没有实质内容行」。
function checkAnchors(entry, owner) {
  for (const item of entry.evidence ?? []) {
    const anchor = anchorSpec(item);
    const path = [item.path, item.test].find(value => typeof value === 'string');
    if (path === undefined) continue;
    const readable = evidenceWithinRepository(ROOT, path) && isRegularFile(resolve(ROOT, path));
    const text = readable ? readEvidence(resolve(ROOT, path)) : null;
    const range = text === null ? null : anchorRange(item, path, text);
    const located = range !== null && range.source !== 'none' && range.failure === null;
    const reference = item.lines !== undefined
      ? `${path}:${item.lines}`
      : (range !== null && range.source === 'symbol' ? `${path}#${range.symbol}` : path);
    if (anchor.kind !== 'value') {
      if (typeof item.test === 'string') anchorGaps.testNoName += 1;
      else if (located) anchorGaps.lineOnly += 1; // 有定位范围（行号或符号），只是没写锚点文本
      else anchorGaps.noLines += 1;
      anchorSuspicions.push(`${owner} ${reference}`);
    }
    if (text === null) continue;
    if (located) {
      const targetLines = range.text.split('\n');
      // 越界已作为形状错误报告；这里只量合法区间的内容。
      if (range.from >= 1 && range.to >= range.from && range.to <= targetLines.length) {
        contentCounts.lineRefs += 1;
        if (range.source === 'symbol') contentCounts.symbolRefs += 1;
        const slice = targetLines.slice(range.from - 1, range.to);
        if (!slice.some(isSubstantiveLine)) {
          contentCounts.contentless += 1;
          contentlessSuspicions.push(`${owner} ${reference}`);
        }
        if (slice[0].trim() === '') contentCounts.blankStart += 1;
      }
    }
    if (anchor.kind !== 'value') continue;
    const evidenceText = range?.text ?? text;
    if (!evidenceText.includes(anchor.value)) continue; // 「找不到锚点」已作为形状错误报告
    anchorCounts.referenced += 1;
    // 无定位范围：只能证「文件里出现过」，不冒充区间可核。
    if (!located) { anchorCounts.fileOnly += 1; continue; }
    if (range.from < 1 || range.to < range.from || range.to > range.text.split('\n').length) continue; // 越界已作为形状错误报告
    const hits = anchorLineNumbers(range.text, anchor.value);
    if (hits.some(line => range.from - ANCHOR_TOLERANCE <= line && line <= range.to + ANCHOR_TOLERANCE)) { anchorCounts.inRange += 1; continue; }
    // 锚点在文件里但不在引用行范围内：引用指到了别处，这是可证伪的错位，不是「不可核」。
    semanticErrors.push(`${owner}: ${reference} 的锚点「${anchor.value}」不在引用行范围内（容差 ±${ANCHOR_TOLERANCE} 行；实际出现在第 ${hits.slice(0, 5).join('、')}${hits.length > 5 ? ' 等' : ''} 行）`);
  }
}
for (const entry of status.operations ?? []) checkAnchors(entry, entry.id ?? operationKey(entry.method, entry.path));
for (const dimension of status.dimensions ?? []) checkAnchors(dimension, `dimension ${dimension.key}`);

// Only regenerate tables after coverage, evidence and assembly have passed.
if (errors.length === 0) {
  try {
    const original = readFileSync(DOCUMENT_FILE, 'utf8').replaceAll('\r\n', '\n');
    const expected = replaceStatusTables(original, status);
    if (original !== expected) {
      if (!flags.has('--write-doc')) {
        driftErrors.push('中文对照表与 JSON 不一致；核对状态后使用 --write-doc 同步表格');
      } else if (semanticErrors.length > 0) {
        // 语义错误存在时不得写盘：同步会把错误引用固化进对照表，从此不可见。
        driftErrors.push('中文对照表与 JSON 不一致；因存在语义错误，--write-doc 未写盘');
      } else {
        writeFileSync(DOCUMENT_FILE, expected);
        synchronized = true;
      }
    }
  } catch (error) { errors.push(`文档校验失败：${error.message}`); }
}
const failures = [
  ...errors.map(message => ({ kind: '形状错误', message })),
  ...semanticErrors.map(message => ({ kind: '语义错误', message })),
  ...driftErrors.map(message => ({ kind: '表格漂移', message })),
];
if (failures.length > 0) {
  console.error(failures.map(({ kind, message }) => `ERROR: ${kind} · ${message}`).join('\n'));
  const count = kind => failures.filter(failure => failure.kind === kind).length;
  // 分类计数附在括注里，保留既有「（N 项）」前缀供旧断言使用；三类互不冒充。
  const prefix = `[形状错误 ${count('形状错误')} / 语义错误 ${count('语义错误')} / 表格漂移 ${count('表格漂移')}]`;
  console.error(`FAIL: 契约实现状态对照校验未通过（${failures.length} 项）${prefix}`);
  process.exit(1);
}
const count = (list, value) => list.filter(entry => entry.status === value).length;
console.log(`PASS: 覆盖 ${status.operations.length} 条契约操作；已装配 ${mounted.size} 条；implemented ${count(status.operations, 'implemented')} / partial ${count(status.operations, 'partial')} / planned ${count(status.operations, 'planned')}；横切维度 ${status.dimensions.length} 条；形状错误 0 项；语义错误 0 项`);
console.log(`PASS: 语义可核 ${semanticCounts.intervals} 条区间 + ${semanticCounts.snippets} 条片段；不可核 ${uncertifiable.intervals} 条区间 + ${uncertifiable.snippets} 条片段（不可核不计入通过）`);
const anchorGapTotal = anchorGaps.lineOnly + anchorGaps.noLines + anchorGaps.testNoName;
console.log(`PASS: 证据锚点 ${anchorCounts.referenced} 条引用自带锚点（区间内 ${anchorCounts.inRange} 条 + 仅整文件 ${anchorCounts.fileOnly} 条）；无锚点不可核 ${anchorGapTotal} 条（纯行号 ${anchorGaps.lineOnly} + 无行号源文件 ${anchorGaps.noLines} + 无用例名 ${anchorGaps.testNoName}），只计数不判红`);
const suspects = anchorSuspicions.slice(0, 5);
if (suspects.length > 0) console.log(`WARN: 无锚点可疑引用前 ${suspects.length}/${anchorSuspicions.length} 条：${suspects.join('、')}`);
// 符号形态要说清「这次解析到哪」：台账里没有行号，读的人只能从这一行看到当前值。
if (symbolAnchors.length > 0) {
  const shown = symbolAnchors.slice(0, 5).map(item => `${item.target}#${item.symbol} ⇒ ${item.from}-${item.to}`);
  console.log(`PASS: 符号形态锚点 ${symbolAnchors.length} 条（运行时解析，台账里不存行号：${shown.join('、')}${symbolAnchors.length > 5 ? ' 等' : ''}）`);
}
console.log(`PASS: 行号区间 ${contentCounts.lineRefs} 条（台账直写 ${contentCounts.lineRefs - contentCounts.symbolRefs} 条 + 符号解析 ${contentCounts.symbolRefs} 条；有实质内容 ${contentCounts.lineRefs - contentCounts.contentless} 条；整段仅空白/收尾行 ${contentCounts.contentless} 条、区间首行为空行 ${contentCounts.blankStart} 条，只计可疑不判红）`);
const contentless = contentlessSuspicions.slice(0, 5);
if (contentless.length > 0) console.log(`WARN: 整段无实质内容的前 ${contentless.length}/${contentlessSuspicions.length} 条：${contentless.join('、')}`);
if (synchronized) console.log('SYNC: 中文表格此前不是「中文表格一致」状态，已按 JSON 重写；本次重写不计入通过。');
else console.log('PASS: 中文表格一致');
if (flags.has('--runtime')) console.log('PASS: 无凭据 stub 子进程中的实际 Fastify 产品装配与静态扫描、对照表一致（不监听 / 不请求服务）。');
if (unassembled.length) console.log(`未装配的路由文件：${unassembled.join('、')}`);
console.log('PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。');
