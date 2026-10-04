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
