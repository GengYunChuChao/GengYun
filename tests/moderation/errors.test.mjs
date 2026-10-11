/**
 * GY-I14 确定性硬规则审核层 · 错误封套回归。
 *
 * 两个目的：
 *   1) 组件内错误码**不伪造**契约错误码与 HTTP 状态（本片没有路由，`http_status` 必须为 null）；
 *   2) 非组件错误**不透出原始 message**——原始异常常含输入正文／PII／坐标／SDK 嵌套原文。
 *      （与 `tests/privacy/errors.test.mjs` 同一防线。）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  MODERATION_ERROR_CODES,
  ModerationError,
  ModerationInputError,
  RuleEvaluationError,
  toErrorEnvelope,
} from '../../packages/moderation/errors.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const states = JSON.parse(readFileSync(join(repoRoot, 'packages/contracts/states.json'), 'utf8'));

test('组件内错误码闭集，且不与契约错误码重名（不得被读成已映射）', () => {
  assert.deepEqual([...MODERATION_ERROR_CODES], [
    'MODERATION_INVALID_INPUT',
    'MODERATION_RULE_FAILED',
    'MODERATION_INTERNAL_ERROR',
  ]);
  const contractCodes = new Set(Object.values(states.error_status_map).flat());
  for (const code of MODERATION_ERROR_CODES) {
    assert.equal(code.startsWith('MODERATION_'), true);
    assert.equal(
      contractCodes.has(code),
      false,
      `${code} 与契约错误码重名，会被误读成"已经映射到 HTTP 状态"`,
    );
  }
});

test('ModerationInputError：组件内错误码 + http_status=null + 不可重试', () => {
  const error = new ModerationInputError('输入缺少 text 字段');
  assert.equal(error instanceof ModerationError, true);
  assert.equal(error.code, 'MODERATION_INVALID_INPUT');
  assert.equal(error.http_status, null);
  assert.equal(error.retryable, false);
});

test('RuleEvaluationError：携带 rule_id，用于失败隔离定位', () => {
  const error = new RuleEvaluationError('MR-01', '规则内部抛错', { cause: new Error('inner') });
  assert.equal(error.code, 'MODERATION_RULE_FAILED');
  assert.equal(error.rule_id, 'MR-01');
  assert.equal(error.http_status, null);
  assert.equal(error.name, 'RuleEvaluationError');
});

test('toErrorEnvelope：保留组件码并显式标注尚未接线', () => {
  const envelope = toErrorEnvelope(new RuleEvaluationError('MR-09', '规则失败'));
  assert.equal(envelope.error.code, 'MODERATION_RULE_FAILED');
  assert.equal(envelope.error.http_status, null);
  assert.equal(envelope.error.rule_id, 'MR-09');
  assert.equal(envelope.meta.wired_to_http, false);
  assert.equal(envelope.meta.contract_version, '1.0.0');
});

test('toErrorEnvelope：非组件错误不透出原始 message（防正文/PII 外泄）', () => {
  const secret = '13812345678 与 30.274158,120.155070 不该出现在封套里';
  const envelope = toErrorEnvelope(new Error(secret));
  const serialized = JSON.stringify(envelope);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('13812345678'), false);
  assert.equal(serialized.includes('30.274158'), false);
  assert.equal(envelope.error.message, '审核组件内部错误');
  assert.equal(envelope.error.code, 'MODERATION_INTERNAL_ERROR');
  assert.equal(envelope.error.http_status, null);
  assert.equal(envelope.meta.error_type, 'Error');
});

test('toErrorEnvelope：字符串/嵌套异常同样不透出原文', () => {
  for (const thrown of ['synthetic-secret-string', { message: 'nested-secret' }, 42, null]) {
    const envelope = toErrorEnvelope(thrown);
    const serialized = JSON.stringify(envelope);
    assert.equal(serialized.includes('synthetic-secret-string'), false);
    assert.equal(serialized.includes('nested-secret'), false);
    assert.equal(typeof envelope.meta.error_type, 'string');
  }
});
