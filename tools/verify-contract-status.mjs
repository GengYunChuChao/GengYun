/** Contract projection checks; semantic completion remains a human judgement. */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  operationKey, scanMountedRoutes, mountedMismatches, runtimeMountedRoutes,
  evidenceWithinRepository, replaceStatusTables,
  routeDeclarations, declarationSegments, assertionArgumentRanges, operationMentions,
} from './contract-status-core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATUS_FILE = join(ROOT, 'docs/architecture/contract-status.json');
const DOCUMENT_FILE = join(ROOT, 'docs/architecture/contract-implementation-status.md');
const OPERATIONS_FILE = join(ROOT, 'packages/contracts/operations.json');
const flags = new Set(process.argv.slice(2));
if ([...flags].some(flag => !['--runtime', '--write-doc'].includes(flag))) {
  console.error('用法：node tools/verify-contract-status.mjs [--runtime] [--write-doc]');
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
    if (item.lines !== undefined) {
      const match = /^(\d+)-(\d+)$/.exec(item.lines);
      check(match !== null, `${owner}: ${path} lines 必须是起-止`);
      if (match) check(Number(match[1]) >= 1 && Number(match[2]) >= Number(match[1]) && Number(match[2]) <= text.split('\n').length, `${owner}: ${path} lines=${item.lines} 越界`);
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
    if (item.lines !== undefined) checkIntervalSemantics(entry, owner, path, text, item);
  }
}
function checkIntervalSemantics(entry, owner, path, text, item) {
  const match = /^(\d+)-(\d+)$/.exec(item.lines);
  if (!match) return; // 形状错误已单独报告
  const lines = text.split('\n');
  const from = Number(match[1]), to = Number(match[2]);
  if (from < 1 || to < from || to > lines.length) return; // 越界已单独报告
  if (from === 1 && to >= lines.length - 1) {
    semanticErrors.push(`${owner}: ${path}:${item.lines} 区间等于整个文件，无法定位具体实现`);
    return;
  }
  const declarations = routeDeclarations(text);
  if (declarations.length === 0) { uncertifiable.intervals += 1; return; }
  const segments = declarationSegments(text, declarations);
  const covered = segments.filter(segment => from <= segment.from && segment.to <= to);
  if (covered.length >= 2) {
    semanticErrors.push(`${owner}: ${path}:${item.lines} 区间跨越 ${covered.length} 个操作注册块（${covered.map(segment => segment.routes.join('/')).join('、')}）`);
    return;
  }
  if (covered.length === 1) {
    const [segment] = covered;
    const key = operationKey(entry.method, entry.path);
    if (!segment.routes.includes(key)) {
      semanticErrors.push(`${owner}: ${path}:${item.lines} 区间覆盖的是 ${segment.routes.join('、')} 的注册块，与 ${key} 不符`);
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
  semanticErrors.push(`${owner}: ${path}:${item.lines} 区间落在 ${enclosing.routes.join('、')} 的注册块内，未覆盖任何本操作注册块，与 ${key} 不符`);
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
if (synchronized) console.log('SYNC: 中文表格此前不是「中文表格一致」状态，已按 JSON 重写；本次重写不计入通过。');
else console.log('PASS: 中文表格一致');
if (flags.has('--runtime')) console.log('PASS: 无凭据 stub 子进程中的实际 Fastify 产品装配与静态扫描、对照表一致（不监听 / 不请求服务）。');
if (unassembled.length) console.log(`未装配的路由文件：${unassembled.join('、')}`);
console.log('PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。');
