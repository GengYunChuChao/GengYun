/** Contract projection checks; semantic completion remains a human judgement. */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  operationKey, scanMountedRoutes, mountedMismatches, runtimeMountedRoutes,
  evidenceWithinRepository, replaceStatusTables,
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

// Only regenerate tables after coverage, evidence and assembly have passed.
if (errors.length === 0) {
  try {
    const original = readFileSync(DOCUMENT_FILE, 'utf8').replaceAll('\r\n', '\n');
    const expected = replaceStatusTables(original, status);
    if (flags.has('--write-doc')) {
      if (original !== expected) writeFileSync(DOCUMENT_FILE, expected);
    } else check(original === expected, '中文对照表与 JSON 不一致；核对状态后使用 --write-doc 同步表格');
  } catch (error) { errors.push(`文档校验失败：${error.message}`); }
}
if (errors.length > 0) {
  console.error(errors.map(error => `ERROR: ${error}`).join('\n'));
  console.error(`FAIL: 契约实现状态对照校验未通过（${errors.length} 项）`);
  process.exit(1);
}
const count = (list, value) => list.filter(entry => entry.status === value).length;
console.log(`PASS: 覆盖 ${status.operations.length} 条契约操作；已装配 ${mounted.size} 条；implemented ${count(status.operations, 'implemented')} / partial ${count(status.operations, 'partial')} / planned ${count(status.operations, 'planned')}；横切维度 ${status.dimensions.length} 条；中文表格一致`);
if (flags.has('--runtime')) console.log('PASS: 无凭据 stub 子进程中的实际 Fastify 产品装配与静态扫描、对照表一致（不监听 / 不请求服务）。');
if (unassembled.length) console.log(`未装配的路由文件：${unassembled.join('、')}`);
console.log('PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。');
