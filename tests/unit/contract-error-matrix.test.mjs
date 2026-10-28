// A05「错误矩阵」结构性闸门：契约不得声明「这个 operation 根本不可能产出」的错误状态码。
//
// 判据**全部从契约自身派生**（方法是哪个、有没有 requestBody、parameters 里有没有条件请求头），
// 不含任何 operationId 白名单/黑名单：新加一条 operation 自动进入扫描面。
//
// 规则与代码依据（改判据前先读这三处，别凭印象改）：
//   规则 1 —— bodyless 方法（Fastify 的 `GET/HEAD/TRACE`）不得声明 `413` / `415`。
//     413/415 的出口有两处，且都发生在「已经要处理请求体」之后：
//     ① 统一错误处理器 `services/api/src/app.ts:2612` / `:2616` 把 Fastify 的 `FST_ERR_CTP_*`
//        （内容类型解析错）映射成 413/415；② 应用层 `MediaError` 族（`packages/media/validate.mjs`
//        的 7 个 throw 点 + `services/api/src/media/service.ts:1072`）经 `rethrowMediaError`
//        走 `ERROR_STATUS_MAP`，只挂在 POST 上传/完成上传面（要解码上传的图片）。
//     Fastify 5.12.5 对 bodyless 方法**根本不跑 contentTypeParser**（`node_modules/fastify/fastify.js`
//     的 bodyless 集合 + `lib/handle-request.js` 的 `if (bodyless.has(method)) { handler(...); return }`），
//     所以无请求体的 GET 不可能产出它们。
//     注意：`DELETE` 在 Fastify 里属于 **bodywith**（会跑 contentTypeParser），带体的 DELETE 仍可能
//     产出 413/415，因此本规则**只判 bodyless**，不把 DELETE 一起扫进来——这是有意的语义收窄，
//     理由写在 `docs/verification/…` 的 A05 报告里，不是漏判。
//   规则 2 —— 没有条件请求头（`If-Match` / `If-None-Match` / `If-Unmodified-Since` / `If-Modified-Since`
//     / `If-Range`）的 operation 不得声明 `412` / `428`。
//     428 的唯一错误码是 `REVISION_REQUIRED`（`services/api/src/contract.ts` 的 `ERROR_STATUS_MAP`），
//     它只由 `requireIfMatch` / `parseIfMatchHeader` / `requireStrongEtag` 系函数在「缺前置条件」时抛出；
//     `412` 在 `ERROR_STATUS_MAP` 里根本没有对应错误码，全仓也没有一个 throw 点。
//   规则 3 —— 本片实测「服务端自己会产出 504（`PROVIDER_TIMEOUT`）」，故**不删 504**，闸门也就不判它；
//     若哪天要加「不做网关假设」的判据，必须先证明全仓没有 504 的 throw 点。
//
// 反空转：扫描面有下界（真实 operation 数用 `>=` 卡），且每条规则都要报出「可判多少条」，
// 断言里同时要求「至少一条规则在本仓当前状态下 0 违规」**且该规则可判面非空**，避免恒真。
//
// 方向：本闸门只判「不该声明却声明了」这一个方向；反方向（该声明却没声明）由
// `tools/validate_contracts.py` 把守（bodyless 禁 413/415、其余必含；有条件头必含 428、无条件头禁 412/428）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACT_PATH = 'packages/contracts/openapi.json';

/** Fastify 的 bodyless 方法集（不含 DELETE：它属于 bodywith，见文件头规则 1 的注释）。 */
export const BODYLESS_METHODS = new Set(['get', 'head', 'trace']);
/** 只在「解析请求体」这一步才可能产出的状态码。 */
export const BODY_STATUS_CODES = ['413', '415'];
/** 只在「要求前置条件」时才可能产出的状态码。 */
export const PRECONDITION_STATUS_CODES = ['412', '428'];
/** 条件请求头（契约里出现过的 + HTTP 语义等价的一族）。 */
export const PRECONDITION_HEADERS = new Set([
  'if-match',
  'if-none-match',
  'if-unmodified-since',
  'if-modified-since',
  'if-range',
]);
/** 每个 operation 都该声明 `500`（`Error500`）；与 tests/contract/contract-codes.test.mjs 的口径一致，这里只做形状自检。 */
const UNIVERSAL_STATUS = '500';
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

const RULE_BODYLESS = '规则1：bodyless 方法（get/head/trace）不解析请求体 ⇒ 不可能产出 413/415';
const RULE_PRECONDITION = '规则2：没有条件请求头 ⇒ 不可能产出 412/428';

/** `#/components/parameters/X` → 参数定义；解析不到直接抛（不静默跳过，否则判据会假绿）。 */
function resolveParameter(parameter, components) {
  if (parameter === null || typeof parameter !== 'object') {
    throw new TypeError(`parameter 不是对象：${JSON.stringify(parameter)}`);
  }
  if (typeof parameter.$ref === 'string') {
    const prefix = '#/components/parameters/';
    if (!parameter.$ref.startsWith(prefix)) {
      throw new Error(`不认识的 parameter $ref：${parameter.$ref}`);
    }
    const name = parameter.$ref.slice(prefix.length);
    const resolved = components?.[name];
    if (!resolved) throw new Error(`parameter $ref 解析不到：${parameter.$ref}`);
    return { ...resolved, rawName: name };
  }
  return { ...parameter, rawName: parameter.name };
}

/**
 * 把一个 OpenAPI 文档拍平成 operation 列表（判据需要的字段都在这里，判分只看这些）。
 * @returns {Array<{path: string, method: string, operationId: string, hasRequestBody: boolean,
 *   headerNames: string[], statusCodes: string[], parameterRefs: string[]}>}
 */
export function collectOperations(doc) {
  const components = doc?.components?.parameters ?? {};
  const operations = [];
  for (const [path, item] of Object.entries(doc?.paths ?? {})) {
    for (const [method, operation] of Object.entries(item ?? {})) {
      if (!HTTP_METHODS.includes(method)) continue;
      const parameterRefs = [];
      const headerNames = [];
      for (const parameter of operation.parameters ?? []) {
        const resolved = resolveParameter(parameter, components);
        if (typeof parameter.$ref === 'string') parameterRefs.push(parameter.$ref);
        if (resolved.in === 'header' && typeof resolved.name === 'string') {
          headerNames.push(resolved.name.toLowerCase());
        }
      }
      operations.push({
        path,
        method,
        operationId: operation.operationId ?? '',
        hasRequestBody: 'requestBody' in operation,
        headerNames,
        statusCodes: Object.keys(operation.responses ?? {}),
        parameterRefs,
      });
    }
  }
  return operations;
}

/**
 * 判一个 operation：返回违规条目（空数组 = 合规）。
 * 违规条目自带「触发哪条规则」，供调用方逐条点名。
 * @returns {Array<{method: string, path: string, operationId: string, code: string, rule: string}>}
 */
export function judgeOperation(operation) {
  const violations = [];
  const push = (code, rule) => violations.push({
    method: operation.method,
    path: operation.path,
    operationId: operation.operationId,
    code,
    rule,
  });
  if (BODYLESS_METHODS.has(operation.method)) {
    for (const code of BODY_STATUS_CODES) {
      if (operation.statusCodes.includes(code)) push(code, RULE_BODYLESS);
    }
  }
  const conditional = operation.headerNames.some((name) => PRECONDITION_HEADERS.has(name));
  if (!conditional) {
    for (const code of PRECONDITION_STATUS_CODES) {
      if (operation.statusCodes.includes(code)) push(code, RULE_PRECONDITION);
    }
  }
  return violations;
}

/** 判整份文档（真实契约的唯一入口）。 */
export function judgeDocument(doc) {
  const operations = collectOperations(doc);
  const violations = operations.flatMap((operation) => judgeOperation(operation));
  return { operations, violations };
}

/** 逐条点名，格式固定为 `method path → 不该声明的状态码 → 触发哪条规则`。 */
export function formatViolations(violations) {
  return violations
    .map((v) => `${v.method.toUpperCase()} ${v.path} → ${v.code}（${v.operationId}）→ ${v.rule}`)
    .join('\n');
}

/** 规则可判面：bodyless 的条数 / 无条件请求头的条数（用于反空转断言）。 */
export function ruleApplies(operations) {
  return {
    bodyless: operations.filter((op) => BODYLESS_METHODS.has(op.method)).length,
    unconditional: operations.filter(
      (op) => !op.headerNames.some((name) => PRECONDITION_HEADERS.has(name)),
    ).length,
  };
}

const contract = JSON.parse(readFileSync(join(ROOT, CONTRACT_PATH), 'utf8'));

test('契约路径存在且能被 JSON.parse（判据的前提）', () => {
  assert.equal(typeof contract.openapi, 'string', `${CONTRACT_PATH} 应有 openapi 版本字段`);
  assert.ok(contract.paths && Object.keys(contract.paths).length > 0, `${CONTRACT_PATH} 应有 paths`);
});

test('扫描面下界：真实契约的 operation 数与 path 数不得低于仓内现状', () => {
  const { operations } = judgeDocument(contract);
  const paths = Object.keys(contract.paths);
  assert.ok(operations.length >= 126, `扫描面塌了：只数到 ${operations.length} 个 operation（下界 126）`);
  assert.ok(paths.length >= 86, `扫描面塌了：只数到 ${paths.length} 条 path（下界 86）`);
  const noId = operations.filter((op) => op.operationId === '');
  assert.deepEqual(noId.map((op) => `${op.method} ${op.path}`), [], '每个 operation 都要有 operationId');
  const noUniversal = operations.filter((op) => !op.statusCodes.includes(UNIVERSAL_STATUS));
  assert.deepEqual(
    noUniversal.map((op) => `${op.method} ${op.path}`),
    [],
    `每个 operation 都要声明 ${UNIVERSAL_STATUS}（本片不碰 500 的声明面）`,
  );
  const badRefs = operations.flatMap((op) => op.parameterRefs
    .filter((ref) => !ref.startsWith('#/components/parameters/')));
  assert.deepEqual(badRefs, [], 'parameters 的 $ref 只允许指向 components.parameters（否则判据解析不到）');
});

test('真实契约零违规（逐条点名 method path → 状态码 → 规则）', () => {
  const { operations, violations } = judgeDocument(contract);
  assert.ok(operations.length >= 126, `扫描面塌了：${operations.length}`);
  assert.equal(
    violations.length,
    0,
    `契约声明了不可能产出的错误状态码：\n${formatViolations(violations)}`,
  );
});

test('反空转：两条规则的可判面都非空，且至少一条规则当前 0 违规', () => {
  const { operations, violations } = judgeDocument(contract);
  const applies = ruleApplies(operations);
  // 可判面必须真的存在：否则「0 违规」可能只是「一条都没判」。
  assert.ok(applies.bodyless >= 40, `规则1 可判面塌了：bodyless operation 只有 ${applies.bodyless} 个`);
  assert.ok(applies.unconditional >= 40, `规则2 可判面塌了：无条件请求头 operation 只有 ${applies.unconditional} 个`);
  const byRule = new Map();
  for (const violation of violations) byRule.set(violation.rule, (byRule.get(violation.rule) ?? 0) + 1);
  const clean = [RULE_BODYLESS, RULE_PRECONDITION].filter((rule) => (byRule.get(rule) ?? 0) === 0);
  assert.ok(
    clean.length >= 1,
    `至少要有一条规则在真实契约上 0 违规（当前：${JSON.stringify([...byRule])}）`,
  );
  // 再补一刀：判据必须对「旧的全站同构矩阵」有声，不然上面的 0 违规没意义。
  const legacyGet = {
    path: '/fixture', method: 'get', operationId: 'fixtureGet',
    hasRequestBody: false, headerNames: [], statusCodes: ['200', '400', '413', '415', '428', '500'],
  };
  assert.equal(judgeOperation(legacyGet).length, 3, '旧形态（GET 声明 413/415/428）必须被点 3 条');
});

test('反向控制：判据双向都动（违规能点名，合法形态不误伤）', () => {
  const cases = [
    {
      label: 'GET 无请求体却声明 413 ⇒ 违规（规则1）',
      operation: { path: '/x', method: 'get', operationId: 'xGet', hasRequestBody: false, headerNames: [], statusCodes: ['200', '413'] },
      expected: [{ code: '413', rule: RULE_BODYLESS }],
    },
    {
      label: 'GET 无请求体却声明 415 ⇒ 违规（规则1）',
      operation: { path: '/x', method: 'get', operationId: 'xGet', hasRequestBody: false, headerNames: [], statusCodes: ['200', '415'] },
      expected: [{ code: '415', rule: RULE_BODYLESS }],
    },
    {
      label: 'GET 无条件请求头却声明 428 ⇒ 违规（规则2）',
      operation: { path: '/x', method: 'get', operationId: 'xGet', hasRequestBody: false, headerNames: [], statusCodes: ['200', '428'] },
      expected: [{ code: '428', rule: RULE_PRECONDITION }],
    },
    {
      label: 'GET 无条件请求头却声明 412 ⇒ 违规（规则2）',
      operation: { path: '/x', method: 'get', operationId: 'xGet', hasRequestBody: false, headerNames: [], statusCodes: ['200', '412'] },
      expected: [{ code: '412', rule: RULE_PRECONDITION }],
    },
    {
      label: '带 If-Match 的 PUT 声明 412 ⇒ 合法（有条件请求头）',
      operation: { path: '/x', method: 'put', operationId: 'xPut', hasRequestBody: true, headerNames: ['if-match'], statusCodes: ['200', '412', '428'] },
      expected: [],
    },
    {
      label: '带 If-Match 的 PUT 声明 413/415 ⇒ 合法（bodywith 会解析请求体）',
      operation: { path: '/x', method: 'put', operationId: 'xPut', hasRequestBody: true, headerNames: ['if-match'], statusCodes: ['200', '413', '415'] },
      expected: [],
    },
    {
      label: 'DELETE 无请求体声明 413/415 ⇒ 合法（Fastify 把 DELETE 归 bodywith，带体仍可达）',
      operation: { path: '/x', method: 'delete', operationId: 'xDelete', hasRequestBody: false, headerNames: [], statusCodes: ['204', '413', '415'] },
      expected: [],
    },
    {
      label: '无请求体的 POST 声明 415 ⇒ 合法（同上，POST 属 bodywith）',
      operation: { path: '/x', method: 'post', operationId: 'xPost', hasRequestBody: false, headerNames: [], statusCodes: ['201', '415'] },
      expected: [],
    },
  ];
  for (const testCase of cases) {
    const violations = judgeOperation(testCase.operation);
    assert.deepEqual(
      violations.map((v) => ({ code: v.code, rule: v.rule })),
      testCase.expected,
      `${testCase.label}：实际 ${JSON.stringify(violations.map((v) => v.code))}`,
    );
  }
  // 点名格式本身也要动：一个违规必须说清 method/path/code/rule 四要素。
  const named = judgeOperation({ path: '/x', method: 'get', operationId: 'xGet', hasRequestBody: false, headerNames: [], statusCodes: ['413'] });
  assert.equal(named.length, 1);
  assert.match(formatViolations(named), /^GET \/x → 413（xGet）→ 规则1/m);
});

test('判据从契约自身派生：$ref 解析得到条件请求头，写在内联参数里也算', () => {
  const doc = {
    openapi: '3.1.1',
    components: {
      parameters: {
        IfMatch: { name: 'If-Match', in: 'header', required: true, schema: { type: 'string' } },
      },
    },
    paths: {
      '/ref': { put: { operationId: 'refPut', parameters: [{ $ref: '#/components/parameters/IfMatch' }], responses: { 200: {}, 428: {} } } },
      '/inline': { put: { operationId: 'inlinePut', parameters: [{ name: 'if-none-match', in: 'header' }], responses: { 200: {}, 412: {} } } },
      '/bare': { put: { operationId: 'barePut', parameters: [], responses: { 200: {}, 428: {} } } },
    },
  };
  const { operations, violations } = judgeDocument(doc);
  assert.equal(operations.length, 3);
  assert.deepEqual(
    violations.map((v) => `${v.operationId}:${v.code}`),
    ['barePut:428'],
    `只有无条件请求头的 barePut 该被判：实际 ${JSON.stringify(violations)}`,
  );
});
