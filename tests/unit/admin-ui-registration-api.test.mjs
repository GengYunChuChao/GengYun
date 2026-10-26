/**
 * 注册资料族 HTTP 层单测：`apps/admin/src/lib/admin-content-api.mjs` 的 6 个操作
 * （契约 `listAdminRegistration` / `getAdminRegistration` / `createRegistrationDraft` /
 * `editRegistrationDraft` / `publishRegistration` / `withdrawRegistration`）。
 *
 * 钉住四件事：
 *  1. **URL + method 逐动作对齐契约**（路径是 `/admin/registrations`，不是 `/admin/sources`）；
 *  2. 写面一律带 `Idempotency-Key`；PATCH／publish／withdraw 另带 `If-Match: "<revision>"`，
 *     缺失**本地就拒绝**，不发出必然 428/400 的请求；
 *  3. `changed` 三值语义：编辑看修订是否前进（`true`/`false`）；发布／撤回的 200 是
 *     `RegistrationPublicationOutcome`，读**必填**布尔 `changed`（真迁移 `true`／内存幂等短路
 *     `false`），回执里缺它才退回 `null`（未知），且幂等 no-op 的文案里**不写「成功」**
 *     —— no-op 不得被显示成新动作；
 *  4. 503 `PROVIDER_UNAVAILABLE`（real 未接线 fail-closed）如实显示为「服务端未接线」，不给自动重试。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createRegistration,
  deriveChanged,
  describeWriteFailure,
  describeWriteOutcome,
  editRegistration,
  getRegistration,
  listRegistration,
  publishRegistration,
  withdrawRegistration,
} from '../../apps/admin/src/lib/admin-content-api.mjs';

const TOKEN = 'test-token-not-a-real-secret';
const UUID = '00000000-0000-4000-8000-000000000001';
const SOURCE_ID = '00000000-0000-4000-8000-0000000000f1';
const REQUEST_ID = '00000000-0000-4000-9000-000000000009';

/** `RegistrationDraftInput`（契约 :15112）——6 个必填字段，`valid_to` 可为 null。 */
const REGISTRATION_INPUT = {
  formulation: {
    registration_number: 'PD20260001',
    producer: '示例农药有限公司',
    dosage_form: '乳油',
    ingredients: [{ name: '稻瘟灵', content_text: '40', unit_text: '%' }],
  },
  source_id: SOURCE_ID,
  source_version: '2026.1',
  registered_name: '40% 稻瘟灵乳油',
  valid_from: '2026-01-02T03:04:05.000Z',
  valid_to: null,
};

function registrationDraft(overrides = {}) {
  return {
    id: UUID,
    revision: 4,
    review_status: 'unverified',
    content: REGISTRATION_INPUT,
    ...overrides,
  };
}

/**
 * `RegistrationPublicationOutcome`（契约 :17553）= 同族出参 + **必填**布尔 `changed`：
 * 服务端真迁移分支 `true`（状态已改、审计已写），内存幂等短路分支 `false`（一字未动）。
 */
function registrationOutcome(overrides = {}) {
  return { ...registrationDraft(), changed: true, ...overrides };
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
    meta: { request_id: '00000000-0000-4000-9000-0000000000aa' },
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

test('列表：GET /admin/registrations（limit 显式带、cursor 只在续页带）', async () => {
  const { fetchImpl, calls } = spy(() => jsonResponse(200, envelope({ items: [registrationDraft()], next_cursor: null })));
  const page = await listRegistration({ fetchImpl, baseUrl: '/api/v1', token: TOKEN, limit: 20 });
  assert.equal(page.ok, true, JSON.stringify(page));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/admin/registrations?limit=20');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(page.page.items.length, 1);
  assert.equal(page.page.nextCursor, null);

  const page2 = await listRegistration({ fetchImpl, baseUrl: '/api/v1', token: TOKEN, cursor: 'c2', limit: 50 });
  assert.equal(calls[1].url, '/api/v1/admin/registrations?limit=50&cursor=c2');
  assert.equal(page2.ok, true);
});

test('详情：GET /admin/registrations/{id}，回传强 ETag 供 If-Match 使用', async () => {
  const { fetchImpl, calls } = spy(() => jsonResponse(200, envelope(registrationDraft()), { etag: '"4"' }));
  const result = await getRegistration({ fetchImpl, baseUrl: '/api/v1', token: TOKEN, id: UUID });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, `/api/v1/admin/registrations/${UUID}`);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(result.etag, '"4"');
  assert.equal(result.item.revision, 4);
  assert.equal(result.requestId, REQUEST_ID);
});

test('新建草稿：POST /admin/registrations，只带 Idempotency-Key（不带 If-Match）', async () => {
  const { fetchImpl, calls } = spy(() => jsonResponse(201, envelope(registrationDraft()), { etag: '"4"' }));
  const result = await createRegistration({ fetchImpl, baseUrl: '/api/v1', token: TOKEN, idempotencyKey: 'key-reg-create-01', body: REGISTRATION_INPUT });
  assert.equal(result.ok, true);
  assert.equal(result.status, 201);
  assert.equal(calls[0].url, '/api/v1/admin/registrations');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['idempotency-key'], 'key-reg-create-01');
  assert.equal('if-match' in calls[0].init.headers, false, '创建不需要 If-Match');
  assert.deepEqual(JSON.parse(calls[0].init.body), REGISTRATION_INPUT);
  assert.deepEqual(result.sentHeaders, { 'idempotency-key': 'key-reg-create-01' });
});

test('编辑草稿：PATCH /admin/registrations/{id}，If-Match 与 Idempotency-Key 都真发出去', async () => {
  const { fetchImpl, calls } = spy(() => jsonResponse(200, envelope(registrationDraft({ revision: 5 })), { etag: '"5"' }));
  const result = await editRegistration({
    fetchImpl,
    baseUrl: '/api/v1',
    token: TOKEN,
    id: UUID,
    ifMatch: '"4"',
    idempotencyKey: 'key-reg-edit-001',
    body: REGISTRATION_INPUT,
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, `/api/v1/admin/registrations/${UUID}`);
  assert.equal(calls[0].init.method, 'PATCH');
  assert.equal(calls[0].init.headers['if-match'], '"4"');
  assert.equal(calls[0].init.headers['idempotency-key'], 'key-reg-edit-001');
  assert.deepEqual(result.sentHeaders, { 'idempotency-key': 'key-reg-edit-001', 'if-match': '"4"' });
  assert.equal(result.item.revision, 5);
});

test('发布／撤回：路径后缀正确，且都必须带 If-Match；请求体按契约共用形状', async () => {
  const publishSpy = spy(() => jsonResponse(200, envelope(registrationOutcome()), { etag: '"4"' }));
  const published = await publishRegistration({
    fetchImpl: publishSpy.fetchImpl,
    baseUrl: '/api/v1',
    token: TOKEN,
    id: UUID,
    ifMatch: '"4"',
    idempotencyKey: 'key-reg-publish-1',
    body: { evidence_ref: 'ev-reg-1', reason: '登记证已核验' },
  });
  assert.equal(published.ok, true);
  assert.equal(publishSpy.calls[0].url, `/api/v1/admin/registrations/${UUID}/publish`);
  assert.equal(publishSpy.calls[0].init.method, 'POST');
  assert.equal(publishSpy.calls[0].init.headers['if-match'], '"4"');
  assert.equal(publishSpy.calls[0].init.headers['idempotency-key'], 'key-reg-publish-1');
  assert.deepEqual(JSON.parse(publishSpy.calls[0].init.body), { evidence_ref: 'ev-reg-1', reason: '登记证已核验' });

  const withdrawSpy = spy(() => jsonResponse(200, envelope(registrationOutcome()), { etag: '"4"' }));
  const withdrawn = await withdrawRegistration({
    fetchImpl: withdrawSpy.fetchImpl,
    baseUrl: '/api/v1',
    token: TOKEN,
    id: UUID,
    ifMatch: '"4"',
    idempotencyKey: 'key-reg-withdraw-1',
    body: { reason: '登记证到期' },
  });
  assert.equal(withdrawn.ok, true);
  assert.equal(withdrawSpy.calls[0].url, `/api/v1/admin/registrations/${UUID}/withdraw`);
  assert.equal(withdrawSpy.calls[0].init.method, 'POST');
  assert.equal(withdrawSpy.calls[0].init.headers['if-match'], '"4"');
  assert.deepEqual(JSON.parse(withdrawSpy.calls[0].init.body), { reason: '登记证到期' });
});

test('缺 If-Match ⇒ 编辑／发布／撤回本地拒绝、**一个请求都不发**', async () => {
  const { fetchImpl, calls } = spy(() => jsonResponse(200, envelope(registrationDraft())));
  for (const ifMatch of [null, '', '4', '*', '"0"']) {
    const edited = await editRegistration({ fetchImpl, baseUrl: '/api/v1', token: TOKEN, id: UUID, ifMatch, idempotencyKey: 'key-reg-edit-002', body: REGISTRATION_INPUT });
    assert.equal(edited.kind, 'missing_if_match', `ifMatch=${String(ifMatch)} 应本地拒绝`);
    const published = await publishRegistration({ fetchImpl, baseUrl: '/api/v1', token: TOKEN, id: UUID, ifMatch, idempotencyKey: 'key-reg-publish-2', body: { evidence_ref: 'ev', reason: 'r' } });
    assert.equal(published.kind, 'missing_if_match');
    const withdrawn = await withdrawRegistration({ fetchImpl, baseUrl: '/api/v1', token: TOKEN, id: UUID, ifMatch, idempotencyKey: 'key-reg-withdraw-2', body: { reason: 'r' } });
    assert.equal(withdrawn.kind, 'missing_if_match');
  }
  assert.equal(calls.length, 0, '本地拒绝时不得发出任何请求');
});

test('缺／过短幂等键 ⇒ 本地拒绝、不发请求（服务端会回 400）', async () => {
  const { fetchImpl, calls } = spy(() => jsonResponse(201, envelope(registrationDraft())));
  for (const idempotencyKey of [null, '', 'short', 'x'.repeat(129)]) {
    const result = await createRegistration({ fetchImpl, baseUrl: '/api/v1', token: TOKEN, idempotencyKey, body: REGISTRATION_INPUT });
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'missing_idempotency_key');
  }
  assert.equal(calls.length, 0);
});

test('changed 三值：编辑按修订是否前进判定；发布／撤回读回执的必填 changed，缺它才退回 null', async () => {
  const bumped = { ok: true, status: 200, etag: '"5"', requestId: REQUEST_ID, item: registrationDraft({ revision: 5 }) };
  assert.equal(deriveChanged('edit', bumped, { previousRevision: 4 }), true);
  assert.equal(deriveChanged('edit', bumped, { previousRevision: 5 }), false);
  assert.equal(deriveChanged('edit', bumped), null, '没有操作前 revision 时不许猜');

  // 契约真值优先：回执带布尔 changed 就原样用，绝不回退到「比 revision」的推断。
  const noop = { ok: true, status: 200, etag: '"4"', requestId: REQUEST_ID, item: registrationOutcome({ changed: false }) };
  assert.equal(deriveChanged('publish', noop), false, 'changed:false ⇒ 内存幂等短路，本次未改动');
  assert.equal(deriveChanged('withdraw', noop), false);
  const migrated = { ...noop, item: registrationOutcome({ changed: true }) };
  assert.equal(deriveChanged('publish', migrated), true, 'changed:true ⇒ 服务端真的做了迁移');
  assert.equal(deriveChanged('withdraw', migrated), true);

  // 回执里**没有** changed（create 的 201、或不合契约的响应）⇒ 不猜。
  const missing = { ok: true, status: 200, etag: '"4"', requestId: REQUEST_ID, item: registrationDraft() };
  assert.equal(deriveChanged('publish', missing), null, '拿不到契约真值 ⇒ null');

  const noopOutcome = describeWriteOutcome(noop, { action: 'publish', familyLabel: '注册资料' });
  assert.equal(noopOutcome.changed, false);
  assert.match(noopOutcome.title, /服务端未改动状态/);
  assert.doesNotMatch(noopOutcome.title, /发布成功|撤回成功|已成功/, '不得把幂等 no-op 显示成成功');
  assert.match(noopOutcome.changedLabel, /未改动/);
  assert.match(noopOutcome.advice, /已是该状态/, '必须给出确认「已是该状态」的路径');

  // 真迁移 ⇒ changed:true ⇒ 才写「已撤回」。
  const migratedOutcome = describeWriteOutcome(migrated, { action: 'withdraw', familyLabel: '注册资料' });
  assert.equal(migratedOutcome.changed, true);
  assert.match(migratedOutcome.title, /服务端已撤回/);
  assert.match(migratedOutcome.changedLabel, /已改动/);

  // 拿不到 changed ⇒ 只写「已受理」，不猜。
  const unknownOutcome = describeWriteOutcome(missing, { action: 'publish', familyLabel: '注册资料' });
  assert.equal(unknownOutcome.changed, null);
  assert.match(unknownOutcome.title, /服务端已受理/);
  assert.match(unknownOutcome.changedLabel, /无法判定/);

  // 编辑回传同一修订 ⇒ changed:false ⇒ 明写「已是该状态」，且不记为本次成功。
  const sameRevision = describeWriteOutcome(missing, { action: 'edit', previousRevision: 4 });
  assert.equal(sameRevision.changed, false);
  assert.match(sameRevision.title, /已是该状态/);
  assert.doesNotMatch(sameRevision.title, /编辑成功|已成功/);

  const created = describeWriteOutcome({ ok: true, status: 201, etag: '"4"', requestId: REQUEST_ID, item: registrationDraft() }, { action: 'create' });
  assert.match(created.title, /已创建/);
  assert.doesNotMatch(created.title, /创建成功|已成功/);
  assert.equal(describeWriteOutcome({ ok: false, kind: 'forbidden' }, { action: 'publish' }), null, '失败不走 2xx 文案');
});

test('回执契约：发布／撤回的 200 缺 changed 或类型不对 ⇒ invalid_response（不拿草稿信封冒充回执）', async () => {
  const draftEnvelope = await publishRegistration({
    fetchImpl: async () => jsonResponse(200, envelope(registrationDraft()), { etag: '"4"' }),
    baseUrl: '/api/v1',
    token: TOKEN,
    id: UUID,
    ifMatch: '"4"',
    idempotencyKey: 'key-reg-publish-4',
    body: { evidence_ref: 'ev-reg-1', reason: '登记证已核验' },
  });
  assert.equal(draftEnvelope.ok, false, '缺必填 changed 必须拦下');
  assert.equal(draftEnvelope.kind, 'invalid_response');

  const wrongType = await withdrawRegistration({
    fetchImpl: async () => jsonResponse(200, envelope(registrationOutcome({ changed: 'true' })), { etag: '"4"' }),
    baseUrl: '/api/v1',
    token: TOKEN,
    id: UUID,
    ifMatch: '"4"',
    idempotencyKey: 'key-reg-withdraw-4',
    body: { reason: '登记证到期' },
  });
  assert.equal(wrongType.ok, false, 'changed 必须是布尔，字符串不算契约真值');
  assert.equal(wrongType.kind, 'invalid_response');
  assert.match(wrongType.message, /changed/);
});

test('real 未接线：503 PROVIDER_UNAVAILABLE 如实显示为「服务端未接线」，且不给自动重试', async () => {
  const result = await listRegistration({
    fetchImpl: async () => errorResponse(503, 'PROVIDER_UNAVAILABLE', {
      message: 'real 模式未接真实持久后端：后台业务不可用（拒绝以内存 store 返回成功封套）',
      retryable: false,
    }),
    baseUrl: '/api/v1',
    token: TOKEN,
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'unavailable');
  assert.equal(result.status, 503);
  assert.equal(result.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(result.declaredRetryable, false, '服务端 retryable 必须原样读到');
  const described = describeWriteFailure(result);
  assert.equal(described.title, '服务端未接线（HTTP 503 · fail-closed）');
  assert.equal(described.action, 'none', 'retryable:false 时不给「重试」按钮');
  assert.match(described.detail, /PROVIDER_UNAVAILABLE/);
  assert.match(described.detail, /503/);
});

test('畸形响应与闭集：缺 content／review_status 不在闭集 ⇒ invalid_response，不渲染任何行', async () => {
  const missingContent = await listRegistration({
    fetchImpl: async () => jsonResponse(200, envelope({ items: [{ id: UUID, revision: 1, review_status: 'unverified' }], next_cursor: null })),
    baseUrl: '/api/v1',
    token: TOKEN,
  });
  assert.equal(missingContent.ok, false);
  assert.equal(missingContent.kind, 'invalid_response');
  assert.match(missingContent.message, /\$\.items\[0\]/);

  const badEnum = await getRegistration({
    fetchImpl: async () => jsonResponse(200, envelope(registrationDraft({ review_status: 'approved_by_nobody' }))),
    baseUrl: '/api/v1',
    token: TOKEN,
  });
  assert.equal(badEnum.ok, false);
  assert.equal(badEnum.kind, 'invalid_response');
  assert.match(badEnum.message, /review_status/);

  const signedOut = await listRegistration({ fetchImpl: async () => errorResponse(401, 'SESSION_EXPIRED'), baseUrl: '/api/v1', token: TOKEN });
  assert.equal(signedOut.kind, 'signed_out');

  const noToken = await getRegistration({ fetchImpl: async () => jsonResponse(200, envelope(registrationDraft())), baseUrl: '/api/v1', token: '' });
  assert.equal(noToken.kind, 'signed_out');
});

test('错误码原样保留：409 REVISION_CONFLICT / 403 SCOPE_DENIED / 422 SOURCE_CONFLICT', async () => {
  const conflict = await editRegistration({
    fetchImpl: async () => errorResponse(409, 'REVISION_CONFLICT'),
    baseUrl: '/api/v1',
    token: TOKEN,
    id: UUID,
    ifMatch: '"4"',
    idempotencyKey: 'key-reg-edit-003',
    body: REGISTRATION_INPUT,
  });
  assert.equal(conflict.kind, 'revision_conflict');
  assert.equal(conflict.code, 'REVISION_CONFLICT');
  assert.equal(conflict.inContract, true);
  assert.deepEqual(conflict.sentHeaders, { 'idempotency-key': 'key-reg-edit-003', 'if-match': '"4"' });
  assert.equal(describeWriteFailure(conflict).action, 'reload_detail');

  const forbidden = await createRegistration({ fetchImpl: async () => errorResponse(403, 'SCOPE_DENIED'), baseUrl: '/api/v1', token: TOKEN, idempotencyKey: 'key-reg-create-02', body: REGISTRATION_INPUT });
  assert.equal(forbidden.kind, 'forbidden');

  const gate = await publishRegistration({
    fetchImpl: async () => errorResponse(422, 'SOURCE_CONFLICT'),
    baseUrl: '/api/v1',
    token: TOKEN,
    id: UUID,
    ifMatch: '"4"',
    idempotencyKey: 'key-reg-publish-3',
    body: { evidence_ref: 'ev', reason: 'r' },
  });
  assert.equal(gate.kind, 'source_conflict');
  assert.equal(gate.code, 'SOURCE_CONFLICT');
});
