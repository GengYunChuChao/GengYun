/**
 * 限制资料族 HTTP 层单测：`apps/admin/src/lib/admin-content-api.mjs` 的 6 个操作
 * （契约 `listAdminRestriction` / `getAdminRestriction` / `createRestrictionDraft` /
 * `editRestrictionDraft` / `publishRestriction` / `withdrawRestriction`）。
 *
 * 与注册资料族同一套写面纪律（Idempotency-Key + If-Match、本地拒绝、错误码原样），
 * 另外钉住本族**独有**的契约点：
 *  - `RestrictionInput.conditions` **不可为 null**（`crop_id` + `region_code` 恒必填）；
 *  - `effect` 是闭集 `prohibited｜restricted｜unknown`，闭集外的值一律判畸形响应；
 *  - `formulation_id`／`valid_to` 可为 null；
 *  - 读面 `Restriction` 没有 visibility ⇒ 不做生命周期推断。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createRestriction,
  deriveChanged,
  describeWriteFailure,
  describeWriteOutcome,
  editRestriction,
  getRestriction,
  listRestriction,
  publishRestriction,
  withdrawRestriction,
} from '../../apps/admin/src/lib/admin-content-api.mjs';

const TOKEN = 'test-token-not-a-real-secret';
const UUID = '00000000-0000-4000-8000-000000000002';
const SOURCE_ID = '00000000-0000-4000-8000-0000000000f2';
const REQUEST_ID = '00000000-0000-4000-9000-00000000000a';

/** `RestrictionInput`（契约 :15189）——8 个必填键，`conditions` 恒为对象。 */
const RESTRICTION_INPUT = {
  source_id: SOURCE_ID,
  source_version: '2026.1',
  formulation_id: null,
  conditions: { crop_id: 'rice', region_code: '330100' },
  effect: 'restricted',
  reason: '水稻田抽穗期禁用，避免药害',
  valid_from: '2026-01-02T03:04:05.000Z',
  valid_to: null,
};

function restriction(overrides = {}) {
  return {
    id: UUID,
    revision: 2,
    review_status: 'verified',
    content: RESTRICTION_INPUT,
    ...overrides,
  };
}

function envelope(data) {
  return { data, meta: { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'stub' } };
}

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

function errorResponse(status, code, { message = `服务端说明 ${code}`, retryable = false } = {}) {
  return jsonResponse(status, {
    error: { code, message, retryable },
    meta: { request_id: '00000000-0000-4000-9000-0000000000bb' },
  });
}

function spy(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  return { fetchImpl, calls };
}

test('列表：GET /admin/restrictions（limit 显式带、cursor 只在续页带）', async () => {
  const { fetchImpl, calls } = spy(() => jsonResponse(200, envelope({ items: [restriction()], next_cursor: 'c9' })));
  const page = await listRestriction({ fetchImpl, baseUrl: '/api/v1', token: TOKEN, limit: 20 });
  assert.equal(page.ok, true, JSON.stringify(page));
  assert.equal(calls[0].url, '/api/v1/admin/restrictions?limit=20');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(page.page.nextCursor, 'c9');

  await listRestriction({ fetchImpl, baseUrl: '/api/v1', token: TOKEN, cursor: 'c9', limit: 50 });
  assert.equal(calls[1].url, '/api/v1/admin/restrictions?limit=50&cursor=c9');
});

test('详情：GET /admin/restrictions/{id}，回传强 ETag 供 If-Match 使用', async () => {
  const { fetchImpl, calls } = spy(() => jsonResponse(200, envelope(restriction()), { etag: '"2"' }));
  const result = await getRestriction({ fetchImpl, baseUrl: '/api/v1', token: TOKEN, id: UUID });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, `/api/v1/admin/restrictions/${UUID}`);
  assert.equal(result.etag, '"2"');
  assert.equal(result.item.content.effect, 'restricted');
  assert.equal(result.requestId, REQUEST_ID);
});

test('新建草稿：POST /admin/restrictions，只带 Idempotency-Key', async () => {
  const { fetchImpl, calls } = spy(() => jsonResponse(201, envelope(restriction()), { etag: '"2"' }));
  const result = await createRestriction({ fetchImpl, baseUrl: '/api/v1', token: TOKEN, idempotencyKey: 'key-res-create-01', body: RESTRICTION_INPUT });
  assert.equal(result.ok, true);
  assert.equal(result.status, 201);
  assert.equal(calls[0].url, '/api/v1/admin/restrictions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['idempotency-key'], 'key-res-create-01');
  assert.equal('if-match' in calls[0].init.headers, false);
  assert.deepEqual(JSON.parse(calls[0].init.body), RESTRICTION_INPUT);
});

test('编辑草稿：PATCH /admin/restrictions/{id}，If-Match 与 Idempotency-Key 都真发出去', async () => {
  const { fetchImpl, calls } = spy(() => jsonResponse(200, envelope(restriction({ revision: 3 })), { etag: '"3"' }));
  const result = await editRestriction({
    fetchImpl,
    baseUrl: '/api/v1',
    token: TOKEN,
    id: UUID,
    ifMatch: '"2"',
    idempotencyKey: 'key-res-edit-001',
    body: RESTRICTION_INPUT,
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, `/api/v1/admin/restrictions/${UUID}`);
  assert.equal(calls[0].init.method, 'PATCH');
  assert.equal(calls[0].init.headers['if-match'], '"2"');
  assert.deepEqual(result.sentHeaders, { 'idempotency-key': 'key-res-edit-001', 'if-match': '"2"' });
});

test('发布／撤回：路径后缀正确，且都必须带 If-Match', async () => {
  const publishSpy = spy(() => jsonResponse(200, envelope(restriction()), { etag: '"2"' }));
  const published = await publishRestriction({
    fetchImpl: publishSpy.fetchImpl,
    baseUrl: '/api/v1',
    token: TOKEN,
    id: UUID,
    ifMatch: '"2"',
    idempotencyKey: 'key-res-publish-1',
    body: { evidence_ref: 'ev-res-1', reason: '限制结论已核验' },
  });
  assert.equal(published.ok, true);
  assert.equal(publishSpy.calls[0].url, `/api/v1/admin/restrictions/${UUID}/publish`);
  assert.equal(publishSpy.calls[0].init.method, 'POST');
  assert.equal(publishSpy.calls[0].init.headers['if-match'], '"2"');

  const withdrawSpy = spy(() => jsonResponse(200, envelope(restriction()), { etag: '"2"' }));
  const withdrawn = await withdrawRestriction({
    fetchImpl: withdrawSpy.fetchImpl,
    baseUrl: '/api/v1',
    token: TOKEN,
    id: UUID,
    ifMatch: '"2"',
    idempotencyKey: 'key-res-withdraw-1',
    body: { reason: '限制已解除' },
  });
  assert.equal(withdrawn.ok, true);
  assert.equal(withdrawSpy.calls[0].url, `/api/v1/admin/restrictions/${UUID}/withdraw`);
  assert.equal(withdrawSpy.calls[0].init.headers['if-match'], '"2"');
});

test('缺 If-Match ⇒ 编辑／发布／撤回本地拒绝、一个请求都不发；缺幂等键同理', async () => {
  const { fetchImpl, calls } = spy(() => jsonResponse(200, envelope(restriction())));
  for (const ifMatch of [null, '', '2', '*', '"0"']) {
    const edited = await editRestriction({ fetchImpl, baseUrl: '/api/v1', token: TOKEN, id: UUID, ifMatch, idempotencyKey: 'key-res-edit-002', body: RESTRICTION_INPUT });
    assert.equal(edited.kind, 'missing_if_match', `ifMatch=${String(ifMatch)} 应本地拒绝`);
    const published = await publishRestriction({ fetchImpl, baseUrl: '/api/v1', token: TOKEN, id: UUID, ifMatch, idempotencyKey: 'key-res-publish-2', body: { evidence_ref: 'ev', reason: 'r' } });
    assert.equal(published.kind, 'missing_if_match');
  }
  const noKey = await createRestriction({ fetchImpl, baseUrl: '/api/v1', token: TOKEN, idempotencyKey: 'short', body: RESTRICTION_INPUT });
  assert.equal(noKey.kind, 'missing_idempotency_key');
  assert.equal(calls.length, 0);
});

test('changed 三值：编辑看修订；发布／撤回不可判定（null）且不写「成功」', async () => {
  const replay = { ok: true, status: 200, etag: '"2"', requestId: REQUEST_ID, item: restriction() };
  assert.equal(deriveChanged('edit', { ...replay, item: restriction({ revision: 3 }) }, { previousRevision: 2 }), true);
  assert.equal(deriveChanged('edit', replay, { previousRevision: 2 }), false);
  assert.equal(deriveChanged('publish', replay), null);
  assert.equal(deriveChanged('withdraw', replay), null);

  const outcome = describeWriteOutcome(replay, { action: 'withdraw', familyLabel: '限制资料' });
  assert.equal(outcome.changed, null);
  assert.match(outcome.title, /服务端已受理/);
  assert.doesNotMatch(outcome.title, /撤回成功|已成功/);
  assert.match(outcome.advice, /已是该状态/);

  const edited = describeWriteOutcome(replay, { action: 'edit', previousRevision: 2 });
  assert.equal(edited.changed, false);
  assert.match(edited.title, /已是该状态/);
});

test('闭集：conditions 缺失、effect 越界 ⇒ invalid_response（不渲染、不猜）', async () => {
  const noConditions = await listRestriction({
    fetchImpl: async () => jsonResponse(200, envelope({ items: [{ ...restriction(), content: { ...RESTRICTION_INPUT, conditions: null } }], next_cursor: null })),
    baseUrl: '/api/v1',
    token: TOKEN,
  });
  assert.equal(noConditions.ok, false);
  assert.equal(noConditions.kind, 'invalid_response');
  assert.match(noConditions.message, /conditions/);

  const badEffect = await getRestriction({
    fetchImpl: async () => jsonResponse(200, envelope(restriction({ content: { ...RESTRICTION_INPUT, effect: 'forbidden_by_operator' } }))),
    baseUrl: '/api/v1',
    token: TOKEN,
  });
  assert.equal(badEffect.ok, false);
  assert.equal(badEffect.kind, 'invalid_response');
  assert.match(badEffect.message, /effect/);

  const badRegion = await getRestriction({
    fetchImpl: async () => jsonResponse(200, envelope(restriction({ content: { ...RESTRICTION_INPUT, conditions: { crop_id: 'rice', region_code: '110100' } } }))),
    baseUrl: '/api/v1',
    token: TOKEN,
  });
  assert.equal(badRegion.ok, false, 'region_code 必须匹配 ^33[0-9]{4}$');
  assert.match(badRegion.message, /region_code/);
});

test('real 未接线：503 如实显示「服务端未接线」；401 归为未登录', async () => {
  const unwired = await listRestriction({
    fetchImpl: async () => errorResponse(503, 'PROVIDER_UNAVAILABLE', {
      message: 'real 模式未接真实持久后端：后台业务不可用（拒绝以内存 store 返回成功封套）',
      retryable: false,
    }),
    baseUrl: '/api/v1',
    token: TOKEN,
  });
  assert.equal(unwired.kind, 'unavailable');
  assert.equal(unwired.declaredRetryable, false);
  const described = describeWriteFailure(unwired);
  assert.equal(described.title, '服务端未接线（HTTP 503 · fail-closed）');
  assert.equal(described.action, 'none');

  const signedOut = await listRestriction({ fetchImpl: async () => errorResponse(401, 'SESSION_REQUIRED'), baseUrl: '/api/v1', token: TOKEN });
  assert.equal(signedOut.kind, 'signed_out');
});
