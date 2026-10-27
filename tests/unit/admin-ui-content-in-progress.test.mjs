/**
 * 后台内容族写面 · 409 `REQUEST_IN_PROGRESS` 的 UI 出口（R67-A02c）。
 *
 * 钉住三件事：
 *  1. **服务端事实**：409 + `REQUEST_IN_PROGRESS` 落到专用失败类型，`Retry-After` 秒数原样读到；
 *  2. **给用户出路**：文案必须说清「等 N 秒后用**同一个**幂等键重放不会重复生效」；没有
 *     `Retry-After` 头时**不编造秒数**；服务端显式 `retryable:false` 时**不给**自动重试；
 *  3. **判据只有一处**：能不能重试由 `admin-api.mjs` 的 `serverAllowsRetry` 决定（服务端声明优先），
 *     内容族客户端不自造第二份；fail-closed 503（`retryable:false`）必须仍然 `action:'none'`。
 *
 * ⛔ 断言里不写死「源文件:行号」（`tests/unit/test-line-anchors-guard.test.mjs` 会判红）：
 *    要定位源码就按文件文本／导出名匹配。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import * as adminApi from '../../apps/admin/src/lib/admin-api.mjs';
import { describeWriteFailure, editSource } from '../../apps/admin/src/lib/admin-content-api.mjs';

const TOKEN = 'test-token-not-a-real-secret';
const UUID = '00000000-0000-4000-8000-000000000001';
const IDEMPOTENCY_KEY = 'key-edit-in-progress-01';
const REQUEST_ID = '00000000-0000-4000-9000-0000000000aa';

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async json() {
      return body;
    },
  };
}

/** 契约 `ErrorEnvelope`：`retryable` 是契约必填布尔（本用例按服务端真实取值传）。 */
function errorBody(code, { retryable = false, message = `服务端说明 ${code}` } = {}) {
  return { error: { code, message, retryable }, meta: { request_id: REQUEST_ID } };
}

/** 一次带 If-Match + Idempotency-Key 的编辑写请求（真实写面：`PATCH /admin/sources/{id}`）。 */
function editWith(responder) {
  return editSource({
    fetchImpl: responder,
    baseUrl: '/api/v1',
    token: TOKEN,
    id: UUID,
    ifMatch: '"4"',
    idempotencyKey: IDEMPOTENCY_KEY,
    body: {},
  });
}

test('409 REQUEST_IN_PROGRESS 走专用失败类型：错误码、Retry-After 秒数与本次幂等键都留下', async () => {
  const result = await editWith(async () =>
    jsonResponse(409, errorBody('REQUEST_IN_PROGRESS', { retryable: true }), { 'retry-after': '7' }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.kind, 'in_progress', '409 REQUEST_IN_PROGRESS 不能落到泛化的 http_error');
  assert.equal(result.status, 409);
  assert.equal(result.code, 'REQUEST_IN_PROGRESS');
  assert.equal(result.inContract, true);
  assert.equal(result.declaredRetryable, true, '服务端 retryable 必须原样读到');
  assert.equal(result.retriable, true);
  assert.equal(result.retryAfterSeconds, 7, 'Retry-After 的秒数必须原样读到（不猜）');
  // 重放的前提：本次请求确实带了幂等键，重试要复用它。
  assert.equal(result.sentHeaders['idempotency-key'], IDEMPOTENCY_KEY);
});

test('UI 文案：请求仍在处理中时给出「等 N 秒重试」，并说清同一幂等键重放不会重复生效', async () => {
  const result = await editWith(async () =>
    jsonResponse(409, errorBody('REQUEST_IN_PROGRESS', { retryable: true }), { 'retry-after': '7' }),
  );
  const described = describeWriteFailure(result);

  assert.equal(
    `${described.title}${described.detail}`,
    '上一次请求仍在处理中（HTTP 409 · REQUEST_IN_PROGRESS），建议等待 7 秒后重试；同一幂等键重放不会重复生效',
  );
  assert.equal(described.action, 'retry', '服务端声明可重试 ⇒ 必须给出重试出口，而不是「失败」了事');
  assert.equal(described.retriable, true);
});

test('没有 Retry-After 时不编造秒数：只说「稍后再试（服务端未给出等待秒数）」，但仍给重试出口', async () => {
  const result = await editWith(async () => jsonResponse(409, errorBody('REQUEST_IN_PROGRESS', { retryable: true })));
  const described = describeWriteFailure(result);

  assert.equal(result.retryAfterSeconds, null, '没有该头就是不知道，不许填 0/1 之类的假值');
  assert.equal(
    `${described.title}${described.detail}`,
    '上一次请求仍在处理中（HTTP 409 · REQUEST_IN_PROGRESS），建议稍后再试（服务端未给出等待秒数）；同一幂等键重放不会重复生效',
  );
  assert.equal(/秒后重试/.test(described.detail), false, '没有秒数就不许出现「N 秒后重试」字样');
  assert.equal(described.action, 'retry');
  assert.equal(described.retriable, true);
});

test('服务端显式 retryable:false 的 409 不带进重试出口：action 仍是 none', async () => {
  const result = await editWith(async () =>
    jsonResponse(409, errorBody('REQUEST_IN_PROGRESS', { retryable: false }), { 'retry-after': '7' }),
  );
  const described = describeWriteFailure(result);

  assert.equal(result.kind, 'in_progress');
  assert.equal(result.declaredRetryable, false);
  assert.equal(result.retriable, false, '服务端说不可重试，本地就不许自行改口');
  assert.equal(described.action, 'none');
  assert.equal(described.retriable, false);
  assert.equal(/建议等待/.test(described.detail), false, '不可重试时不许承诺「等 N 秒」');
  assert.equal(described.detail.includes('服务端声明不可自动重试（retryable:false）'), true);
});

test('负向守卫：fail-closed 503（retryable:false）仍是 action:none，只有可重试的 503 才给 retry', async () => {
  const unwired = await editWith(async () =>
    jsonResponse(503, errorBody('PROVIDER_UNAVAILABLE', { retryable: false, message: '未接线' })),
  );
  const unwiredDescribed = describeWriteFailure(unwired);
  assert.equal(unwired.kind, 'unavailable');
  assert.equal(unwiredDescribed.title, '服务端未接线（HTTP 503 · fail-closed）');
  assert.equal(unwiredDescribed.action, 'none', 'fail-closed 的语义就是「别自动重试」');

  const transient = await editWith(async () =>
    jsonResponse(503, errorBody('PROVIDER_UNAVAILABLE', { retryable: true, message: '上游暂不可用' })),
  );
  const transientDescribed = describeWriteFailure(transient);
  assert.equal(transientDescribed.title, '服务端未接线（HTTP 503 · fail-closed）');
  assert.equal(transientDescribed.action, 'retry', '服务端声明 retryable:true 时才给重试');
});

test('负向守卫：其他 409 码不借用「处理中」分支', async () => {
  const conflict = await editWith(async () => jsonResponse(409, errorBody('IDEMPOTENCY_CONFLICT', { retryable: false })));
  assert.equal(conflict.kind, 'idempotency_conflict');
  assert.equal(describeWriteFailure(conflict).action, 'new_key');

  const revision = await editWith(async () => jsonResponse(409, errorBody('REVISION_CONFLICT', { retryable: false })));
  assert.equal(revision.kind, 'revision_conflict');
  assert.equal(describeWriteFailure(revision).action, 'reload_detail');
});

test('判据 serverAllowsRetry：服务端声明优先，缺声明才回落本地闭集', () => {
  const allows = adminApi.serverAllowsRetry;
  assert.equal(typeof allows, 'function', 'admin-api.mjs 必须导出唯一判据 serverAllowsRetry');

  // 服务端说了算：哪怕本地闭集认为这类失败值得重试，服务端 false 也不给。
  assert.equal(allows({ kind: 'rate_limited', declaredRetryable: false }), false);
  assert.equal(allows({ kind: 'unavailable', declaredRetryable: false }), false);
  assert.equal(allows({ kind: 'in_progress', declaredRetryable: true }), true);
  // jobs 族的字段拼写同样生效（同一判据，两种失败对象形状）。
  assert.equal(allows({ kind: 'in_progress', serverRetryable: true }), true);
  assert.equal(allows({ kind: 'revision_conflict', serverRetryable: false }), false);
  // 拿不到声明（无响应/旧失败对象）才回落到本地闭集。
  assert.equal(allows({ kind: 'network_error' }), true);
  assert.equal(allows({ kind: 'invalid_response' }), false);
  assert.equal(allows(null), false);
});

test('判据只有一处：内容族客户端从 admin-api.mjs 取判据，不自造第二份副本', () => {
  const shared = readFileSync(new URL('../../apps/admin/src/lib/admin-api.mjs', import.meta.url), 'utf8');
  assert.equal(/export function serverAllowsRetry\(/.test(shared), true, 'admin-api.mjs 是判据的唯一归属');

  const contentApi = readFileSync(new URL('../../apps/admin/src/lib/admin-content-api.mjs', import.meta.url), 'utf8');
  assert.equal(/function serverAllowsRetry\(/.test(contentApi), false, '不许在内容族里再抄一份同形判据');
  assert.equal(
    /import\s*\{[^}]*serverAllowsRetry[^}]*\}\s*from\s*'\.\/admin-api\.mjs'/.test(contentApi),
    true,
    '内容族必须从 admin-api.mjs 复用同一份判据',
  );
});

test('fail-closed 注释与实现一致：503 一律 retryable:false —— 客户端不应自动重试', () => {
  const source = readFileSync(
    new URL('../../services/api/src/admin/fail-closed-services.ts', import.meta.url),
    'utf8',
  );

  // 实现：两处 reject 都是 retryable: false（本片只改注释，代码一字不动）。
  const rejections = source.match(/new ApiError\('PROVIDER_UNAVAILABLE', reason, \{ retryable: false \}\)/g) ?? [];
  assert.equal(rejections.length, 2, '实现里两处失闭都必须显式 retryable: false');

  // 注释：头部那段不许再写「(503, retryable)」这种与实现对不上、会诱导自动重试的措辞。
  assert.equal(/503,\s*retryable\)/.test(source), false, '注释与实现自相矛盾：实现是 retryable:false');
  assert.equal(
    /503[^\n]{0,60}retryable:\s*false/.test(source),
    true,
    '注释必须如实写成「503 + retryable:false = fail-closed，别自动重试」',
  );
});
