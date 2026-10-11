/**
 * GY-I01 契约实现状态对照的可回归校验（docs/architecture/contract-status.md 的机器可读副本）。
 *
 * 这个脚本刻意只做「能被机器证明」的三件事，不替人判断契约是否被满足：
 *
 * 1. 覆盖性：packages/contracts/operations.json 的每个 (method,path) 在
 *    docs/architecture/contract-status.json 中恰好出现一次，不遗漏、不臆造。
 * 2. 声明的「是否已装配 HTTP 路由」与 sources 静态扫描结果一致 —— 防止有人加了路由或删了路由
 *    而对照表没跟着改（这是本文件最容易腐烂的地方）。
 * 3. 每条 implemented / partial 的证据可复核：源码路径存在且行数不少于所引用行号；
 *    测试文件的用例名子串确实出现在该文件里。
 *
 * 它**不能**证明 implemented 的语义正确，也不请求任何服务；语义仍靠各任务自己的
 * HTTP/集成用例与监工复核。校验失败即 exit 1，不打印「通过」以外的结论。
 */
import { readFileSync, existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTES_DIR = join(ROOT, 'services', 'api', 'src', 'routes');
const STATUS_FILE = join(ROOT, 'docs', 'architecture', 'contract-status.json');
const OPERATIONS_FILE = join(ROOT, 'packages', 'contracts', 'operations.json');

const STATUSES = new Set(['implemented', 'partial', 'planned']);
const REQUIRED_DIMENSIONS = [
  'error_codes',
  'pagination',
  'versioning',
  'idempotency',
  'source_kind',
  'execution_modes',
  'cancel',
  'timeout',
];

const errors = [];
const check = (condition, message) => {
  if (!condition) errors.push(message);
};

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const operations = readJson(OPERATIONS_FILE);
const status = readJson(STATUS_FILE);

// ---------------------------------------------------------------------------
// 1. 覆盖性
// ---------------------------------------------------------------------------
const key = (method, path) => `${method.toLowerCase()} ${path}`;
const contractKeys = new Map(operations.operations.map((op) => [key(op.method, op.path), op]));

check(
  typeof status.contract_version === 'string' && status.contract_version === operations.contract_version,
  `contract_version 与 operations.json 不一致：${status.contract_version} vs ${operations.contract_version}`,
);
check(Array.isArray(status.operations) && status.operations.length > 0, 'contract-status.json 缺少 operations 数组');

const seen = new Map();
for (const entry of status.operations ?? []) {
  const k = key(entry.method, entry.path);
  check(!seen.has(k), `重复条目：${k}`);
  seen.set(k, entry);
  check(contractKeys.has(k), `对照表出现契约中不存在的操作：${k}`);
  check(STATUSES.has(entry.status), `${k}: 非法状态 ${entry.status}`);
  check(typeof entry.blocker === 'string' && entry.blocker.trim() !== '', `${k}: 缺少阻塞/缺项说明`);
  check(Array.isArray(entry.evidence), `${k}: evidence 必须是数组`);
  check(typeof entry.route_mounted === 'boolean', `${k}: 缺少 route_mounted 布尔标记`);
  const source = contractKeys.get(k);
  if (source) check(entry.id === source.id, `${k}: 操作 id 不一致（${entry.id} vs ${source.id}）`);
  if (entry.status === 'planned') {
    check(entry.evidence.length === 0, `${k}: planned 条目不应声明证据`);
  } else {
    check(entry.evidence.length > 0, `${k}: ${entry.status} 条目必须给出可复核证据`);
  }
}
for (const k of contractKeys.keys()) check(seen.has(k), `对照表遗漏契约操作：${k}`);

// ---------------------------------------------------------------------------
// 2. 路由装配声明 vs 源码静态扫描
// ---------------------------------------------------------------------------
const KIND = ['get', 'post', 'put', 'patch', 'delete'];
const mounted = new Set();
const unassembled = [];

// 关键一步（对应监工口径「契约里有定义 ≠ 已实现」）：一个 routes/*.ts 里写了 app.get(...) 并不代表
// 它被装配。只有 app.ts 真的调用了该文件的 register* 导出，其中的路由才算已挂载。
const appSource = readFileSync(join(ROOT, 'services', 'api', 'src', 'app.ts'), 'utf8');

// profile.ts 用 `for (const kind of ['crops','regions'])` 生成两条路径；这里显式展开，
// 不做通用模板求值（宁可少扫，也不猜）。route 文本里的 `${kind}` 只允许这两个取值。
const TEMPLATE_EXPANSIONS = { kind: ['crops', 'regions'] };

function expand(route) {
  const variables = [...route.matchAll(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)].map((m) => m[1]);
  if (variables.length === 0) return [route];
  let out = [route];
  for (const name of variables) {
    const values = TEMPLATE_EXPANSIONS[name];
    if (!values) return [`<unresolved:${name}>`];
    out = out.flatMap((current) => values.map((value) => current.replaceAll('${' + name + '}', value)));
  }
  return out;
}

for (const file of readdirSync(ROUTES_DIR)) {
  if (!file.endsWith('.ts')) continue;
  const text = readFileSync(join(ROUTES_DIR, file), 'utf8');
  const registrar = /export function (register[A-Za-z0-9_]+)/.exec(text)?.[1] ?? null;
  const assembled = registrar !== null && new RegExp(`\\b${registrar}\\s*\\(`).test(appSource);
  if (!assembled) {
    if (/app\.(get|post|put|patch|delete)\(/.test(text)) unassembled.push(`${file}${registrar ? ` (${registrar})` : ''}`);
    continue;
  }
  // 兼容模板字面量（`${API_PREFIX}/...`）与普通字符串（'/api/v1/public/home'）两种写法。
  for (const match of text.matchAll(/app\.(get|post|put|patch|delete)\(\s*[`']([^`']+)[`']/g)) {
    const method = match[1];
    check(KIND.includes(method), `${file}: 未预期的方法 ${method}`);
    const template = match[2].replaceAll('${API_PREFIX}', '/api/v1');
    for (const route of expand(template)) {
      const normalized = route.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');
      if (!normalized.startsWith('/api/v1/')) {
        // /health 是运营端点，不在业务契约内。
        check(normalized === '/health', `${file}: 扫描到契约外且非运营端点的路由 ${normalized}`);
        continue;
      }
      mounted.add(key(method, normalized.slice('/api/v1'.length)));
    }
  }
}

for (const [k, entry] of seen) {
  const isMounted = mounted.has(k);
  check(
    entry.route_mounted === isMounted,
    `${k}: 对照表声明 route_mounted=${entry.route_mounted}，源码扫描结果=${isMounted}`,
  );
}
for (const k of mounted) check(seen.has(k), `源码已装配但对照表未登记：${k}`);

// ---------------------------------------------------------------------------
// 3. 证据可复核
// ---------------------------------------------------------------------------
function checkEvidence(owner, evidence) {
  for (const item of evidence) {
    const targets = [item.path, item.test].filter((value) => typeof value === 'string');
    check(targets.length === 1, `${owner}: 证据项必须且只能给 path 或 test`);
    const relative = targets[0];
    const absolute = resolve(ROOT, relative);
    check(existsSync(absolute), `${owner}: 证据文件不存在 ${relative}`);
    if (!existsSync(absolute)) continue;
    if (item.test !== undefined) {
      const text = readFileSync(absolute, 'utf8');
      if (typeof item.name === 'string' && item.name !== '') {
        check(text.includes(item.name), `${owner}: ${relative} 中找不到用例名「${item.name}」`);
      }
    }
    if (item.lines !== undefined) {
      const match = /^(\d+)-(\d+)$/.exec(item.lines);
      check(match !== null, `${owner}: ${relative} 的 lines 必须是 "起-止" 形式：${item.lines}`);
      if (match !== null) {
        const [, from, to] = match;
        const total = readFileSync(absolute, 'utf8').split('\n').length;
        check(Number(from) >= 1, `${owner}: ${relative} lines 起点必须 >= 1`);
        check(Number(to) >= Number(from), `${owner}: ${relative} lines 终点必须 >= 起点`);
        check(Number(to) <= total, `${owner}: ${relative} 只有 ${total} 行，lines=${item.lines} 越界`);
      }
    }
  }
}

for (const entry of status.operations ?? []) {
  checkEvidence(entry.id, entry.evidence);
}

// ---------------------------------------------------------------------------
// 4. 横切维度覆盖 #1 范围点名的约定
// ---------------------------------------------------------------------------
check(Array.isArray(status.dimensions) && status.dimensions.length > 0, 'contract-status.json 缺少 dimensions 数组');
const dimensionKeys = new Set((status.dimensions ?? []).map((item) => item.key));
for (const required of REQUIRED_DIMENSIONS) {
  check(dimensionKeys.has(required), `缺少横切维度：${required}`);
}
for (const item of status.dimensions ?? []) {
  check(STATUSES.has(item.status), `dimension ${item.key}: 非法状态 ${item.status}`);
  check(typeof item.source_anchor === 'string' && item.source_anchor.trim() !== '', `dimension ${item.key}: 缺少来源锚点`);
  check(typeof item.blocker === 'string' && item.blocker.trim() !== '', `dimension ${item.key}: 缺少阻塞/缺项说明`);
  check(Array.isArray(item.evidence), `dimension ${item.key}: evidence 必须是数组`);
  if (item.status === 'planned') {
    check(item.evidence.length === 0, `dimension ${item.key}: planned 条目不应声明证据`);
  } else {
    check(item.evidence.length > 0, `dimension ${item.key}: ${item.status} 条目必须给出可复核证据`);
  }
  checkEvidence(`dimension ${item.key}`, item.evidence);
}

// ---------------------------------------------------------------------------
if (errors.length > 0) {
  console.error(errors.map((error) => `ERROR: ${error}`).join('\n'));
  console.error(`FAIL: 契约实现状态对照校验未通过（${errors.length} 项）`);
  process.exit(1);
}

const count = (list, status_) => list.filter((item) => item.status === status_).length;
const ops = status.operations;
const dims = status.dimensions;
console.log(
  `PASS: 对照表覆盖 ${ops.length} 条契约操作（${operations.operations.length} 条一致）；已装配路由 ${mounted.size} 条与源码扫描一致；` +
    `implemented ${count(ops, 'implemented')} / partial ${count(ops, 'partial')} / planned ${count(ops, 'planned')}；` +
    `横切维度 ${dims.length} 条（implemented ${count(dims, 'implemented')} / partial ${count(dims, 'partial')} / planned ${count(dims, 'planned')}）`,
);
if (unassembled.length > 0) {
  console.log(`注意：以下路由文件有 app.* 声明但未被 app.ts 装配，其中路由不计入已挂载：${unassembled.join('、')}`);
}
console.log('PASS: 状态为人工判定；本脚本只校验覆盖性、装配一致性与证据可复核，不证明实现的语义正确。');
