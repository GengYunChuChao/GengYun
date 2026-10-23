import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
 API_PREFIX,
 DOC_PATH,
 MOUNTED_EXEMPTIONS,
 buildParityReport,
 contractOperations,
 ledgerIndex,
 normalizeMountedUrl,
 readContractInputs,
 readDocBlock,
 renderParityDoc,
} from '../../tools/openapi-route-parity.mjs';
import {operationKey} from '../../tools/contract-status-core.mjs';

// 「实现 × 契约」双向门禁。此前仓库里只有 `tools/contract-status-runtime.mjs` 的
// 「契约 → 实现」（hasRoute）单向确认，反方向没人守：多挂一个没进契约的路由不会红。
// 本文件同时钉住契约内部完整性（operationId/路径参数/错误码枚举）与对照表文档的新鲜度。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const {openapi, ledger} = readContractInputs(root);
const operations = contractOperations(openapi);
// 顶层直接 `buildParityReport(root)` 会把冷启动（TS 加载 + buildApp + printRoutes 子进程）压进
// 模块加载阶段：子进程一超时，整个文件 10 条用例一起塌，报错还只剩 `spawnSync ... ETIMEDOUT`。
// 改成首次用到时才算；失败也缓存，10 条用例拿到同一条可读错误，不会各等一次超时。
let _report;
let _reportError;
const report = () => {
  if (_reportError) throw _reportError;
  if (!_report) {
    try { _report = buildParityReport(root); }
    catch (e) {
      _reportError = new Error(`路由清单生成失败（buildApp/printRoutes 超时或崩溃）：${e.message}`);
      throw _reportError;
    }
  }
  return _report;
};

test('实现里每个已挂载路由都在契约里（除显式例外）', () => {
  assert.deepEqual(report().mountedOnly, [], [
    '以下已挂载路由在 packages/contracts/openapi.json 里没有对应操作：',
    ...report().mountedOnly.map(entry => `  ${entry.key}  ← ${entry.route}`),
    '要么补契约（paths + components.schemas + operations.json + 台账），',
    '要么在 tools/openapi-route-parity.mjs 的 MOUNTED_EXEMPTIONS 里写清依据后放行。',
  ].join('\n'));
});

test('契约里的每个路径都有实现，或台账明确标为 planned', () => {
  assert.deepEqual(report().missing, [], [
    '以下契约操作既没有实现，台账也没标 route_mounted=false + status=planned：',
    ...report().missing.map(entry => `  ${entry.key}（${entry.operationId}）台账：${entry.ledger}`),
  ].join('\n'));
});

test('台账 route_mounted 与运行时实况一致', () => {
  assert.deepEqual(report().ledgerDrift, [], [
    'docs/architecture/contract-status.json 的 route_mounted 与 buildApp() 实况不一致：',
    ...report().ledgerDrift.map(entry => `  ${entry.key}：台账 ${entry.ledger} / 实际 ${entry.actual}`),
  ].join('\n'));
});

test('例外表只放行真实挂载且确实不在契约里的路由', () => {
  const mountedKeys = new Set(report().rows.filter(row => row.mounted).map(row => operationKey(row.method, API_PREFIX + row.path)));
  for (const key of MOUNTED_EXEMPTIONS.keys()) {
    assert.ok(key.startsWith('get /health'), `例外表出现未评审的条目：${key}`);
  }
  assert.equal(MOUNTED_EXEMPTIONS.size, 1, '新增例外需要在 tests/contract 这里同步评审');
  assert.equal(report().exempt.length, 1);
  assert.equal(mountedKeys.has('get /health'), false, '/health 不该出现在契约操作里');
});

test('契约与 operations.json 的操作集合、operationId 一一对应', () => {
  const doc = JSON.parse(readFileSync(resolve(root, 'packages/contracts/operations.json'), 'utf8'));
  const list = Array.isArray(doc) ? doc : doc.operations;
  assert.equal(list.length, operations.length, 'operations.json 与 openapi.json 操作数不一致');
  const byKey = new Map(list.map(entry => [operationKey(entry.method, entry.path), entry]));
  for (const op of operations) {
    const key = operationKey(op.method, op.path);
    const entry = byKey.get(key);
    assert.ok(entry, `operations.json 缺 ${key}`);
    assert.equal(op.operationId, entry.id, `${key} 的 operationId 与 operations.json 的 id 不一致`);
  }
  const seen = new Set();
  for (const op of operations) {
    assert.ok(!seen.has(op.operationId), `operationId 重复：${op.operationId}`);
    seen.add(op.operationId);
  }
});

test('每个契约操作都声明了路径参数、成功响应与安全要求', () => {
  const entries = ledgerIndex(ledger);
  const problems = [];
  for (const [path, item] of Object.entries(openapi.paths)) {
    for (const op of operations.filter(candidate => candidate.path === path)) {
      const operation = item[op.method];
      const template = [...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
      const declared = new Set((operation.parameters || []).filter(param => param.in === 'path').map(param => param.name));
      for (const name of template) if (!declared.has(name)) problems.push(`${op.operationId}: 路径参数 ${name} 未在 parameters 里声明`);
      if (!(operation.parameters || []).some(param => param.in === 'path' && param.required === true) && template.length) {
        problems.push(`${op.operationId}: 路径参数没有 required=true`);
      }
      const codes = Object.keys(operation.responses || {});
      if (!codes.some(code => /^2\d\d$/.test(code))) problems.push(`${op.operationId}: 没有 2xx 响应`);
      // `security: []` 是 OpenAPI 里「显式不需要鉴权」的写法，只允许出现在 scope=public 的操作上。
      if (!Array.isArray(operation.security)) problems.push(`${op.operationId}: 缺 security 字段（无鉴权也要显式写成 []）`);
      else {
        const scope = entries.get(operationKey(op.method, API_PREFIX + path))?.scope;
        if (scope === 'public' && operation.security.length) problems.push(`${op.operationId}: scope=public 但声明了鉴权 ${JSON.stringify(operation.security)}`);
        if (scope !== 'public' && !operation.security.length) problems.push(`${op.operationId}: scope=${scope} 却声明 security=[]`);
      }
      if (typeof operation.operationId !== 'string' || !operation.operationId) problems.push(`${op.method} ${path}: 缺 operationId`);
    }
  }
  assert.deepEqual(problems, []);
});

test('契约内所有 $ref 都能解析', () => {
  const raw = readFileSync(resolve(root, 'packages/contracts/openapi.json'), 'utf8');
  const unresolved = [...new Set([...raw.matchAll(/"\$ref":\s*"([^"]+)"/g)].map(match => match[1]))].filter(ref => {
    if (!ref.startsWith('#/')) return true;
    let cursor = openapi;
    for (const segment of ref.slice(2).split('/')) {
      cursor = cursor && cursor[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    return cursor === undefined;
  });
  assert.deepEqual(unresolved, []);
});

test('共享错误响应的错误码与 ErrorCode 枚举、states.json 状态映射三方一致', () => {
  const states = JSON.parse(readFileSync(resolve(root, 'packages/contracts/states.json'), 'utf8'));
  const known = new Set(openapi.components.schemas.ErrorCode.enum);
  const statusOf = new Map();
  for (const [status, codes] of Object.entries(states.error_status_map)) for (const code of codes) statusOf.set(code, Number(status));
  const problems = [];
  for (const [name, response] of Object.entries(openapi.components.responses)) {
    const status = Number(name.replace('Error', ''));
    const declared = (response.description || '').split(',').map(segment => segment.trim()).filter(Boolean);
    for (const code of declared) {
      if (!known.has(code)) problems.push(`${name}: ${code} 不在 components.schemas.ErrorCode.enum`);
      else if (statusOf.get(code) !== status) problems.push(`${name}: ${code} 在 states.json 里映射到 ${statusOf.get(code)}`);
    }
    for (const code of states.error_status_map[String(status)] || []) {
      if (!declared.includes(code)) problems.push(`${name}: states.json[${status}] 里的 ${code} 未写进响应说明`);
    }
  }
  assert.deepEqual(problems, []);
});

test('对照表文档与重新生成的结果一致', () => {
  const block = readDocBlock(root);
  assert.ok(block, `${DOC_PATH} 不存在；先跑 node tools/openapi-route-parity.mjs --write-doc`);
  assert.equal(block, renderParityDoc(report(), {contractVersion: openapi.info?.version || ''}),
    `${DOC_PATH} 的标记块已过期；跑 node tools/openapi-route-parity.mjs --write-doc 重新生成，不要手改`);
});

test('台账里的路由写法与契约路径参数写法一致（:id vs {id}）', () => {
  const entries = ledgerIndex(ledger);
  const problems = [];
  for (const op of operations) {
    const key = operationKey(op.method, API_PREFIX + op.path);
    const entry = entries.get(key);
    if (!entry) { problems.push(`${key} 在台账里缺行`); continue; }
    if (normalizeMountedUrl(entry.route || '') !== API_PREFIX + op.path) problems.push(`${key}: 台账 route=${entry.route}`);
    if (entry.id !== op.operationId) problems.push(`${key}: 台账 id=${entry.id} 与 operationId 不一致`);
  }
  assert.deepEqual(problems, []);
});
