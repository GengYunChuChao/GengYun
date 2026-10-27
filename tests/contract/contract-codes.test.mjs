import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTRACT_VERSION,
  ERROR_CODES,
  ERROR_STATUS_MAP,
  EXECUTION_MODES,
  isErrorCode,
  statusForErrorCode,
} from '../../services/api/src/contract.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const states = JSON.parse(readFileSync(resolve(root, 'packages/contracts/states.json'), 'utf8'));
const openapi = JSON.parse(readFileSync(resolve(root, 'packages/contracts/openapi.json'), 'utf8'));

test('API 错误码与 HTTP 状态映射与契约 states.json 完全一致', () => {
  const contractMap = Object.fromEntries(
    Object.entries(states.error_status_map).map(([status, codes]) => [Number(status), codes]),
  );
  assert.deepEqual(ERROR_STATUS_MAP, contractMap);
});

test('API ExecutionMode 与契约 states.json 一致', () => {
  assert.deepEqual([...EXECUTION_MODES].sort(), [...states.states.ExecutionMode].sort());
});

test('API 错误码集合与 openapi ErrorCode 枚举一致', () => {
  const openapiCodes = openapi.components.schemas.ErrorCode.enum;
  assert.deepEqual([...ERROR_CODES].sort(), [...openapiCodes].sort());
  for (const code of ERROR_CODES) {
    assert.ok(isErrorCode(code));
    assert.equal(statusForErrorCode(code) >= 400, true);
  }
});

test('错误码在状态映射中不重复归属', () => {
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length);
});

test('meta.contract_version 与契约 Meta 常量一致，且必填字段齐备', () => {
  const meta = openapi.components.schemas.Meta;
  assert.equal(meta.properties.contract_version.const, CONTRACT_VERSION);
  assert.deepEqual([...meta.required].sort(), ['contract_version', 'execution_mode', 'request_id']);
});

test('Error / ErrorEnvelope 形状与契约一致', () => {
  const error = openapi.components.schemas.Error;
  assert.deepEqual([...error.required].sort(), ['code', 'details', 'message', 'retryable']);
  assert.equal(openapi.components.schemas.ErrorEnvelope.required.includes('meta'), true);
  assert.equal(openapi.components.schemas.ErrorEnvelope.required.includes('error'), true);
});

/**
 * GY-R67-A03：500 必须**在契约里可表达**，而不是一个「没有错误码的缺口」。
 *
 * 这一条刻意不写任何单侧条数钉（`assert.equal(enum.length, 28)` 那种）：契约说「枚举里有 28 个码」
 * 和服务端说「我的 ERROR_STATUS_MAP 摊出 28 个」各自都能对上而不互相约束，改一处仍会永久绿。
 * 所以每一处都做**双向**：契约 500 档 ⇄ 服务端 `ERROR_STATUS_MAP` 的 500 档、契约映射表 ⇄
 * `states.json`（与 `tools/validate_contracts.py` 用同一判据）、每个 operation 的 500 声明 ⇄ 该文件里
 * 的 operation 数（同一份文档内两侧相等，不是手抄常数）。
 */
test('500 在契约里可表达：INTERNAL_ERROR 进枚举、500 档双向一致、Error500 不带 Retry-After', () => {
  const enumCodes = openapi.components.schemas.ErrorCode.enum;
  const contractMap = openapi['x-error-status-map'];

  // ① 码进枚举、且 500 档只映射到它（契约侧自证「500 有合法码可用」）。
  assert.ok(enumCodes.includes('INTERNAL_ERROR'), `ErrorCode.enum 缺 INTERNAL_ERROR：${enumCodes.join(', ')}`);
  assert.deepEqual(contractMap['500'], ['INTERNAL_ERROR'], '契约 x-error-status-map 的 500 档必须只含 INTERNAL_ERROR');

  // ② 双向：契约 500 档 ⇄ 服务端 ERROR_STATUS_MAP 的 500 档 ⇄ ApiError.status 的反推。
  assert.deepEqual(contractMap['500'], ERROR_STATUS_MAP[500], '契约 500 档与服务端 ERROR_STATUS_MAP[500] 必须逐字相等');
  assert.equal(statusForErrorCode('INTERNAL_ERROR'), 500, 'INTERNAL_ERROR 必须反推出 500（ApiError.status 靠这条）');

  // ③ 契约映射表 ⇄ states.json（`tools/validate_contracts.py` 的同一判据，两处都必须改）。
  assert.deepEqual(contractMap, states.error_status_map, 'openapi 的 x-error-status-map 必须与 states.json 的 error_status_map 逐档相等');

  // ④ 每个 operation 都声明 500：两侧都从本文件数出来，不写死 126。
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
  const operations = [];
  for (const item of Object.values(openapi.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (methods.has(method)) operations.push(operation);
    }
  }
  const declared = operations.filter((operation) => operation.responses?.['500']?.$ref === '#/components/responses/Error500');
  assert.ok(operations.length > 0, 'operation 数为 0：契约路径解析失败，下面的比例没有意义');
  assert.equal(declared.length, operations.length, `每个 operation 都要声明 500（Error500）：${declared.length}/${operations.length}`);

  // ⑤ 共享响应：引用既有错误信封 schema，且 **不** 声明 `Retry-After`（500 不是「稍后重试就会好」，
  //    本仓 `retryable` 口径见 services/api/src/errors.ts 的 ApiError 注释）。
  const error500 = openapi.components.responses.Error500;
  assert.ok(error500, 'components.responses 缺 Error500');
  assert.deepEqual(error500.content['application/json'].schema, { $ref: '#/components/schemas/ErrorEnvelope' });
  assert.equal('headers' in error500, false, 'Error500 不得声明 headers（尤其 Retry-After）');
});
