/**
 * R67-A02b：后台内容页读 `Retry-After` 响应头 → `failure.retryAfterSeconds` → 文案「建议等待 N 秒」。
 *
 * 服务端已对「可重试的 503/504」与 429、409 `REQUEST_IN_PROGRESS` 统一下发 `Retry-After`（整数秒，
 * 唯一出口是 `services/api/src/errors.ts` 的 `retryAfterSecondsFor`，全仓只有 `app.ts` 的统一错误
 * 出口写这个头）。但读面此前只读响应体里的 `retryable`，秒数永远拿不到——本条臂钉住四件事：
 *
 *   1. 头是**正整数秒**才回填（`retry-after: 7` ⇒ `retryAfterSeconds === 7`），并原样喂给 view model
 *      的 `retryHintOf`，文案出现「建议等待 7 秒」；
 *   2. 无头 ⇒ `null`，且 detail **逐字**回到改动前的文字（不猜一个好看的秒数）；
 *   3. `0`／`abc`／`1.5`／`-5`／空串这类非法值一律 `null`（判别力：写成 `Number(x) > 0` 会漏 `1.5`）；
 *   4. 头名大小写不敏感；429 与写操作（409）走的是同一个出口，读法必须一致。
 *
 * 断言的文案不手搓：failure 走真实的 `reduceFamily → describeFamily`，文案由 view model 产出。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createSource,
  getSource,
  listSources,
} from '../../apps/admin/src/lib/admin-content-api.mjs';
import {
  describeFamily,
  initialFamilyState,
  reduceFamily,
} from '../../apps/admin/src/lib/admin-content-view-model.mjs';

const TOKEN = 'test-token-not-a-real-secret';
const UUID = '00000000-0000-4000-8000-000000000001';
const REQUEST_ID = '00000000-0000-4000-9000-0000000000aa';

const SOURCE_INPUT = {
  title: '水稻田稗草防治技术要点',
  url: 'https://example.org/source',
  publisher: '示例出版社',
  source_kind: 'database',
  evidence_kind: 'research',
  version: '2026.1',
  content_hash: 'b'.repeat(64),
  locator: 'p12-l34',
  valid_from: '2026-01-02T03:04:05.000Z',
  valid_to: null,
};

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

function errorBody(code, { retryable = true, message } = {}) {
  return {
    error: { code, message: message ?? `服务端说明 ${code}`, retryable },
    meta: { request_id: REQUEST_ID },
  };
}

function spy(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  return { fetchImpl, calls };
}

/** 失败对象 → 页面文案：走真实状态机，不手搓 detail。 */
function viewOf(failure) {
  const started = reduceFamily(initialFamilyState(), { type: 'LOAD_START', reset: true });
  return describeFamily(reduceFamily(started, { type: 'LOAD_FAIL', failure }), { label: '资料来源' });
}

test('① 可重试 503 + `retry-after: 7` ⇒ failure 带 7，文案给出「建议等待 7 秒」', async () => {
  const { fetchImpl } = spy(() => jsonResponse(503, errorBody('PROVIDER_UNAVAILABLE'), { 'retry-after': '7' }));
  const result = await listSources({ fetchImpl, baseUrl: '/api/v1', token: TOKEN });

  assert.equal(result.ok, false);
  assert.equal(result.kind, 'unavailable');
  assert.equal(result.status, 503);
  assert.equal(result.retryAfterSeconds, 7, '头是秒数字符串 ⇒ 回填正整数');
  assert.equal(result.declaredRetryable, true, '响应体的 retryable 照旧保留');

  const view = viewOf(result);
  assert.equal(view.canRetry, true);
  assert.equal(view.detail.includes('建议等待 7 秒'), true);
  assert.equal(view.retryAfterSeconds, 7);
});

test('② 无 `Retry-After` ⇒ retryAfterSeconds 为 null，detail 逐字回到旧文字', async () => {
  const { fetchImpl } = spy(() => jsonResponse(503, errorBody('PROVIDER_UNAVAILABLE')));
  const result = await listSources({ fetchImpl, baseUrl: '/api/v1', token: TOKEN });

  assert.equal(result.retryAfterSeconds, null);
  const view = viewOf(result);
  assert.equal(view.detail, 'PROVIDER_UNAVAILABLE（HTTP 503）服务端说明 PROVIDER_UNAVAILABLE', '缺头时 detail 必须与改动前逐字一致');
  assert.equal(view.detail.includes('建议等待'), false);
  assert.equal(view.retryAfterSeconds, null);
});

test('③ 非法值（0／abc／1.5／-5／空串／1e3／+7）⇒ null，不猜；文案不出现等待秒数', async () => {
  const cases = ['0', 'abc', '1.5', '-5', '', '1e3', '+7'];
  for (const raw of cases) {
    const { fetchImpl } = spy(() => jsonResponse(503, errorBody('PROVIDER_UNAVAILABLE'), { 'retry-after': raw }));
    const result = await listSources({ fetchImpl, baseUrl: '/api/v1', token: TOKEN });
    assert.equal(result.retryAfterSeconds, null, `retry-after: ${JSON.stringify(raw)} 不是正整数秒 ⇒ null`);
    assert.equal(viewOf(result).detail.includes('建议等待'), false, `retry-after: ${JSON.stringify(raw)} 不得编出等待秒数`);
  }
});

test('④ 429 带 `retry-after: 7` 同样生效（头名大小写不敏感）', async () => {
  const { fetchImpl } = spy(() => jsonResponse(429, errorBody('RATE_LIMITED'), { 'Retry-After': '7' }));
  const result = await listSources({ fetchImpl, baseUrl: '/api/v1', token: TOKEN });

  assert.equal(result.kind, 'rate_limited');
  assert.equal(result.retryAfterSeconds, 7, '`Retry-After` 与 `retry-after` 等价');
  const view = viewOf(result);
  assert.equal(view.canRetry, true);
  assert.equal(view.detail.includes('建议等待 7 秒'), true);
});

test('⑤ 三个出口同口径：读详情、写操作也读同一个头（不是只补列表那一处）', async () => {
  const detail = await getSource({
    fetchImpl: spy(() => jsonResponse(503, errorBody('PROVIDER_UNAVAILABLE'), { 'retry-after': '5' })).fetchImpl,
    baseUrl: '/api/v1',
    token: TOKEN,
    id: UUID,
  });
  assert.equal(detail.ok, false);
  assert.equal(detail.retryAfterSeconds, 5);

  const write = await createSource({
    fetchImpl: spy(() => jsonResponse(409, errorBody('REQUEST_IN_PROGRESS'), { 'retry-after': '1' })).fetchImpl,
    baseUrl: '/api/v1',
    token: TOKEN,
    idempotencyKey: 'key-create-0001',
    body: SOURCE_INPUT,
  });
  assert.equal(write.ok, false);
  assert.equal(write.code, 'REQUEST_IN_PROGRESS');
  assert.equal(write.retryAfterSeconds, 1, '处理中 409 带 `Retry-After: 1`，写面也要读出来');
});
