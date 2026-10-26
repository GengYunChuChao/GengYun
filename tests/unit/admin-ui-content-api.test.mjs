/**
 * 后台「资料管理」HTTP 层单测：`apps/admin/src/lib/admin-content-api.mjs`。
 *
 * 重点钉住「写操作必须带 If-Match + Idempotency-Key」：
 *  - 创建草稿只带 Idempotency-Key；
 *  - 编辑／发布／下架必须带 `If-Match: "<revision>"` 与 `Idempotency-Key`；
 *  - 缺头时**本地就拒绝**，不发出请求（服务端会 428/400，前端不该先发一个必败请求）；
 *  - 失败时错误码原样保留，`sentHeaders` 回显真实发出的头。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  createKnowledge,
  createSource,
  editCategory,
  editKnowledge,
  editSource,
  fetchAuditEventPage,
  findAuditEventsForRequest,
  getKnowledge,
  getSource,
  listCategories,
  listKnowledge,
  listSources,
  publishKnowledge,
  publishSource,
  withdrawKnowledge,
  withdrawSource,
  describeWriteFailure,
} from '../../apps/admin/src/lib/admin-content-api.mjs';

/**
 * R64 追加：知识族「取详情 / 建草稿 / 撤回」三个动作的契约事实一律在运行期从
 * `packages/contracts/openapi.json` 取（不是抄记忆）——
 *   - `GET  /admin/knowledge/{id}`         `getAdminKnowledge`   scope `sources:read`；请求头只有 authorization/accept
 *   - `POST /admin/knowledge`              `createKnowledgeDraft` scope `sources:write`；参数**只有** IdempotencyKey
 *                                          （`x-version-required: false` ⇒ 创建不带 If-Match），请求体 `KnowledgeDraftInput`
 *   - `POST /admin/knowledge/{id}/withdraw` `withdrawKnowledge`   scope `sources:write`；参数 IdempotencyKey + IfMatch，
 *                                          请求体 `ReasonInput = { reason }`
 */
const CONTRACT = JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'));
const KNOWLEDGE_ITEM = CONTRACT.paths['/admin/knowledge/{id}'].get;
const KNOWLEDGE_CREATE = CONTRACT.paths['/admin/knowledge'].post;
const KNOWLEDGE_WITHDRAW = CONTRACT.paths['/admin/knowledge/{id}/withdraw'].post;
const KNOWLEDGE_INPUT_SCHEMA = CONTRACT.components.schemas.KnowledgeDraftInput;
const REASON_INPUT_SCHEMA = CONTRACT.components.schemas.ReasonInput;

function paramNames(operation) {
  return operation.parameters.map((parameter) => ('$ref' in parameter ? parameter.$ref.split('/').pop() : parameter.name));
}

const TOKEN = 'test-token-not-a-real-secret';
const UUID = '00000000-0000-4000-8000-000000000001';
const HASH = 'b'.repeat(64);

const SOURCE_INPUT = {
  title: '水稻田稗草防治技术要点',
  url: 'https://example.org/source',
  publisher: '示例出版社',
  source_kind: 'database',
  evidence_kind: 'research',
  version: '2026.1',
  content_hash: HASH,
  locator: 'p12-l34',
  valid_from: '2026-01-02T03:04:05.000Z',
  valid_to: null,
};

const KNOWLEDGE_INPUT = {
  type: 'species',
  title: '稗草识别',
  body: '正文',
  source_id: UUID,
  source_version: '2026.1',
  conditions: null,
  formulation_id: null,
};

function sourceDraft(overrides = {}) {
  return {
    id: UUID,
    revision: 4,
    visibility: 'private',
    source: {
      id: UUID,
      version: '2026.1',
      title: '水稻田稗草防治技术要点',
      url: 'https://example.org/source',
      publisher: '示例出版社',
      source_kind: 'database',
      evidence_kind: 'research',
      validity: 'valid',
      review_status: 'unverified',
      updated_at: '2026-01-02T03:04:05.000Z',
    },
    ...overrides,
  };
}

function knowledgeDraft(overrides = {}) {
  return {
    id: UUID,
    revision: 2,
    visibility: 'private',
    review_status: 'unverified',
    content: KNOWLEDGE_INPUT,
    ...overrides,
  };
}

function envelope(data) {
  return { data, meta: { request_id: '00000000-0000-4000-9000-000000000009', contract_version: '1.0.0', execution_mode: 'stub' } };
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

function errorResponse(status, code) {
  return jsonResponse(status, { error: { code, message: `服务端说明 ${code}` }, meta: { request_id: '00000000-0000-4000-9000-0000000000aa' } });
}

function spy(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  return { fetchImpl, calls };
}

test('创建资料来源草稿：POST /admin/sources，只带 Idempotency-Key（不带 If-Match）', async () => {
  const { fetchImpl, calls } = spy(() => jsonResponse(201, envelope(sourceDraft()), { etag: '"4"' }));
  const result = await createSource({ fetchImpl, baseUrl: '/api/v1', token: TOKEN, idempotencyKey: 'key-create-0001', body: SOURCE_INPUT });

  assert.equal(result.ok, true);
  assert.equal(result.status, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/admin/sources');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['idempotency-key'], 'key-create-0001');
  assert.equal('if-match' in calls[0].init.headers, false);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), SOURCE_INPUT);
  assert.equal(result.etag, '"4"');
  assert.equal(result.requestId, '00000000-0000-4000-9000-000000000009');
  assert.deepEqual(result.sentHeaders, { 'idempotency-key': 'key-create-0001' });
});

test('编辑资料来源：PATCH /admin/sources/{id}，If-Match 与 Idempotency-Key 都真的发出去', async () => {
  const { fetchImpl, calls } = spy(() => jsonResponse(200, envelope(sourceDraft({ revision: 5 })), { etag: '"5"' }));
  const result = await editSource({
    fetchImpl,
    baseUrl: '/api/v1',
    token: TOKEN,
    id: UUID,
    ifMatch: '"4"',
    idempotencyKey: 'key-edit-0001',
    body: SOURCE_INPUT,
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].url, `/api/v1/admin/sources/${UUID}`);
  assert.equal(calls[0].init.method, 'PATCH');
  assert.equal(calls[0].init.headers['if-match'], '"4"');
  assert.equal(calls[0].init.headers['idempotency-key'], 'key-edit-0001');
  assert.deepEqual(result.sentHeaders, { 'idempotency-key': 'key-edit-0001', 'if-match': '"4"' });
  assert.equal(result.item.revision, 5);
});

test('编辑缺少 If-Match ⇒ 本地拒绝、不发请求（不让服务端先回 428）', async () => {
  const { fetchImpl, calls } = spy(() => jsonResponse(200, envelope(sourceDraft())));
  for (const ifMatch of [null, '', '4', '*', '"0"']) {
    const result = await editSource({ fetchImpl, baseUrl: '/api/v1', token: TOKEN, id: UUID, ifMatch, idempotencyKey: 'key-edit-0002', body: SOURCE_INPUT });
    assert.equal(result.ok, false, `ifMatch=${String(ifMatch)} 应本地拒绝`);
    assert.equal(result.kind, 'missing_if_match');
  }
  assert.equal(calls.length, 0);
});

test('缺少幂等键 ⇒ 本地拒绝、不发请求', async () => {
  const { fetchImpl, calls } = spy(() => jsonResponse(200, envelope(sourceDraft())));
  const result = await createSource({ fetchImpl, baseUrl: '/api/v1', token: TOKEN, idempotencyKey: 'short', body: SOURCE_INPUT });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'missing_idempotency_key');
  assert.equal(calls.length, 0);
});

test('发布 / 下架：路径后缀正确，且都必须带 If-Match', async () => {
  const publishSpy = spy(() => jsonResponse(200, envelope(sourceDraft({ revision: 5, visibility: 'published' })), { etag: '"5"' }));
  const published = await publishSource({
    fetchImpl: publishSpy.fetchImpl,
    baseUrl: '/api/v1',
    token: TOKEN,
    id: UUID,
    ifMatch: '"4"',
    idempotencyKey: 'key-publish-01',
    body: { evidence_ref: 'ev-1', reason: '资料已核验' },
  });
  assert.equal(published.ok, true);
  assert.equal(publishSpy.calls[0].url, `/api/v1/admin/sources/${UUID}/publish`);
  assert.equal(publishSpy.calls[0].init.method, 'POST');
  assert.equal(publishSpy.calls[0].init.headers['if-match'], '"4"');

  const withdrawSpy = spy(() => jsonResponse(200, envelope(sourceDraft({ revision: 6, visibility: 'hidden' })), { etag: '"6"' }));
  const withdrawn = await withdrawSource({
    fetchImpl: withdrawSpy.fetchImpl,
    baseUrl: '/api/v1',
    token: TOKEN,
    id: UUID,
    ifMatch: '"5"',
    idempotencyKey: 'key-withdraw-1',
    body: { reason: '来源过期' },
  });
  assert.equal(withdrawn.ok, true);
  assert.equal(withdrawSpy.calls[0].url, `/api/v1/admin/sources/${UUID}/withdraw`);
  assert.equal(withdrawSpy.calls[0].init.headers['if-match'], '"5"');

  const noMatch = await publishSource({ fetchImpl: publishSpy.fetchImpl, baseUrl: '/api/v1', token: TOKEN, id: UUID, idempotencyKey: 'key-publish-02', body: { evidence_ref: 'ev-1', reason: 'x' } });
  assert.equal(noMatch.kind, 'missing_if_match');
});

test('科普内容：列表 / 编辑 / 发布走 /admin/knowledge，形状按 KnowledgeDraft 校验', async () => {
  const listSpy = spy(() => jsonResponse(200, envelope({ items: [knowledgeDraft()], next_cursor: null })));
  const page = await listKnowledge({ fetchImpl: listSpy.fetchImpl, baseUrl: '/api/v1', token: TOKEN, limit: 5 });
  assert.equal(page.ok, true, JSON.stringify(page));
  assert.equal(listSpy.calls[0].url, '/api/v1/admin/knowledge?limit=5');
  assert.equal(page.page.items.length, 1);

  const editSpy = spy(() => jsonResponse(200, envelope(knowledgeDraft({ revision: 3 })), { etag: '"3"' }));
  const edited = await editKnowledge({ fetchImpl: editSpy.fetchImpl, baseUrl: '/api/v1', token: TOKEN, id: UUID, ifMatch: '"2"', idempotencyKey: 'key-k-edit-01', body: KNOWLEDGE_INPUT });
  assert.equal(edited.ok, true);
  assert.equal(editSpy.calls[0].init.method, 'PATCH');
  assert.equal(editSpy.calls[0].init.headers['if-match'], '"2"');

  const publishSpy = spy(() => jsonResponse(200, envelope(knowledgeDraft({ revision: 4, visibility: 'published' })), { etag: '"4"' }));
  const published = await publishKnowledge({ fetchImpl: publishSpy.fetchImpl, baseUrl: '/api/v1', token: TOKEN, id: UUID, ifMatch: '"3"', idempotencyKey: 'key-k-pub-01', body: { evidence_ref: 'ev-2', reason: '科普已核验' } });
  assert.equal(published.ok, true);
  assert.equal(publishSpy.calls[0].url, `/api/v1/admin/knowledge/${UUID}/publish`);
});

test('分类：列表 GET /admin/categories（不是 /admin/admin-categories），编辑用不透明 id 并编码', async () => {
  const category = { id: 'crop-rice', revision: 2, type: 'crop', name: '水稻', description: '示例分类', active: true };
  const listSpy = spy(() => jsonResponse(200, envelope({ items: [category], next_cursor: 'next-1' })));
  const page = await listCategories({ fetchImpl: listSpy.fetchImpl, baseUrl: '/api/v1', token: TOKEN, limit: 20 });
  assert.equal(page.ok, true);
  assert.equal(listSpy.calls[0].url, '/api/v1/admin/categories?limit=20');
  assert.equal(page.page.nextCursor, 'next-1');

  const editSpy = spy(() => jsonResponse(200, envelope({ ...category, revision: 3, active: false }), { etag: '"3"' }));
  const edited = await editCategory({
    fetchImpl: editSpy.fetchImpl,
    baseUrl: '/api/v1',
    token: TOKEN,
    id: 'crop/rice 01',
    ifMatch: '"2"',
    idempotencyKey: 'key-cat-edit-1',
    body: { name: '水稻', description: '示例分类', active: false },
  });
  assert.equal(edited.ok, true);
  assert.equal(editSpy.calls[0].url, '/api/v1/admin/categories/crop%2Frice%2001');
  assert.equal(editSpy.calls[0].init.headers['if-match'], '"2"');
  assert.equal(edited.item.active, false);
});

test('写失败：409 REVISION_CONFLICT / 403 SCOPE_DENIED / 422 SOURCE_CONFLICT 的错误码与写头都保留', async () => {
  const conflict = await editSource({
    fetchImpl: async () => errorResponse(409, 'REVISION_CONFLICT'),
    baseUrl: '/api/v1',
    token: TOKEN,
    id: UUID,
    ifMatch: '"4"',
    idempotencyKey: 'key-edit-0003',
    body: SOURCE_INPUT,
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.kind, 'revision_conflict');
  assert.equal(conflict.code, 'REVISION_CONFLICT');
  assert.equal(conflict.inContract, true);
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.sentHeaders, { 'idempotency-key': 'key-edit-0003', 'if-match': '"4"' });
  assert.equal(conflict.requestId, '00000000-0000-4000-9000-0000000000aa');
  const described = describeWriteFailure(conflict);
  assert.equal(described.action, 'reload_detail');
  assert.equal(described.detail.includes('REVISION_CONFLICT'), true);

  const forbidden = await createSource({ fetchImpl: async () => errorResponse(403, 'SCOPE_DENIED'), baseUrl: '/api/v1', token: TOKEN, idempotencyKey: 'key-create-0002', body: SOURCE_INPUT });
  assert.equal(forbidden.kind, 'forbidden');

  const gate = await publishSource({
    fetchImpl: async () => errorResponse(422, 'SOURCE_CONFLICT'),
    baseUrl: '/api/v1',
    token: TOKEN,
    id: UUID,
    ifMatch: '"4"',
    idempotencyKey: 'key-publish-03',
    body: { evidence_ref: 'ev-1', reason: 'x' },
  });
  assert.equal(gate.kind, 'source_conflict');
  assert.equal(gate.code, 'SOURCE_CONFLICT');
});

test('契约外错误码：不吞、标 inContract:false，仍显示原文', async () => {
  const result = await editCategory({
    fetchImpl: async () => errorResponse(400, 'TOTALLY_UNKNOWN_CODE'),
    baseUrl: '/api/v1',
    token: TOKEN,
    id: 'crop-rice',
    ifMatch: '"1"',
    idempotencyKey: 'key-cat-edit-2',
    body: { name: '水稻', description: '示例', active: true },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOTALLY_UNKNOWN_CODE');
  assert.equal(result.inContract, false);
  assert.equal(describeWriteFailure(result).detail.includes('契约外码'), true);
});

test('列表：游标续页、畸形行拒绝渲染、401 归为未登录', async () => {
  const okSpy = spy(() => jsonResponse(200, envelope({ items: [sourceDraft()], next_cursor: 'c2' })));
  const page = await listSources({ fetchImpl: okSpy.fetchImpl, baseUrl: '/api/v1', token: TOKEN, cursor: 'c2', limit: 50 });
  assert.equal(okSpy.calls[0].url, '/api/v1/admin/sources?limit=50&cursor=c2');
  assert.equal(page.page.nextCursor, 'c2');

  const badRow = await listSources({
    fetchImpl: async () => jsonResponse(200, envelope({ items: [sourceDraft({ revision: 0 })], next_cursor: null })),
    baseUrl: '/api/v1',
    token: TOKEN,
  });
  assert.equal(badRow.ok, false);
  assert.equal(badRow.kind, 'invalid_response');
  assert.equal(badRow.message.includes('$.items[0].revision'), true);

  const signedOut = await listSources({ fetchImpl: async () => errorResponse(401, 'SESSION_EXPIRED'), baseUrl: '/api/v1', token: TOKEN });
  assert.equal(signedOut.kind, 'signed_out');

  const noToken = await getSource({ fetchImpl: async () => jsonResponse(200, envelope(sourceDraft())), baseUrl: '/api/v1', token: '' });
  assert.equal(noToken.kind, 'signed_out');
});

test('审计台账：按 request_id 筛选，找不到时如实报告扫描条数与截断', async () => {
  const events = [
    { id: UUID, action: 'source.edit', scope: 'sources:write', target_ref: null, reason_code: 'revision_appended', request_id: '00000000-0000-4000-9000-000000000001', result: 'accepted', created_at: '2026-01-02T03:04:05Z' },
    { id: '00000000-0000-4000-8000-0000000000ff', action: 'source.publish', scope: 'sources:write', target_ref: null, reason_code: 'publish_gate_passed', request_id: '00000000-0000-4000-9000-000000000002', result: 'accepted', created_at: '2026-01-02T03:04:06Z' },
  ];

  const found = await findAuditEventsForRequest({
    fetchImpl: async () => jsonResponse(200, envelope({ items: events, next_cursor: null })),
    baseUrl: '/api/v1',
    token: TOKEN,
    requestId: '00000000-0000-4000-9000-000000000002',
  });
  assert.equal(found.ok, true);
  assert.equal(found.events.length, 1);
  assert.equal(found.events[0].action, 'source.publish');
  assert.equal(found.scanned, 2);
  assert.equal(found.truncated, false);

  const missing = await findAuditEventsForRequest({
    fetchImpl: async () => jsonResponse(200, envelope({ items: [], next_cursor: 'c9' })),
    baseUrl: '/api/v1',
    token: TOKEN,
    requestId: '00000000-0000-4000-9000-000000000003',
    maxPages: 2,
    limit: 50,
  });
  assert.equal(missing.ok, true);
  assert.equal(missing.events.length, 0);
  assert.equal(missing.truncated, true); // 扫到上限仍有后续页 ⇒ 不能说「没有记录」
  assert.equal(missing.scanned, 0);

  const noRequestId = await findAuditEventsForRequest({ fetchImpl: async () => jsonResponse(200, envelope({ items: [], next_cursor: null })), baseUrl: '/api/v1', token: TOKEN, requestId: null });
  assert.equal(noRequestId.ok, false);

  const page = await fetchAuditEventPage({ fetchImpl: async () => jsonResponse(200, envelope({ items: events, next_cursor: null })), baseUrl: '/api/v1', token: TOKEN });
  assert.equal(page.ok, true);
  assert.equal(page.requestUrl, '/api/v1/admin/audit-events?limit=20');
});

// ---------------------------------------------------------------------------
// R64 追加：知识族的「取详情 / 建草稿 / 撤回」三个动作
//
// 补的理由：R64 侦察核出的「有 UI 入口但无 admin-ui 测试」里，`getAdminKnowledge`(:154)、
// `createKnowledgeDraft`(:257)、`withdrawKnowledge`(:324) 三条知识族 operation 一条断言都没有
// —— 上面既有的科普用例只覆盖列表／编辑／发布。三条动作的差别**恰好在请求头**：
// 取详情无写头、建草稿只有幂等键、撤回两个头都要 ⇒ 混了就会 428/409/400。
// ---------------------------------------------------------------------------

/** 请求体键集合逐字等于给定契约 schema 的 properties（`additionalProperties:false`）。 */
function assertContractBody(bodyText, schema, expected, schemaName) {
  assert.equal(typeof bodyText, 'string', `${schemaName} 请求必须带 JSON body`);
  const body = JSON.parse(bodyText);
  assert.equal(schema.additionalProperties, false, `契约 ${schemaName} 必须是 additionalProperties:false`);
  assert.deepEqual(
    Object.keys(body).sort(),
    Object.keys(schema.properties).sort(),
    `请求体键集合必须恰为契约 ${schemaName}.properties，实测 ${JSON.stringify(Object.keys(body))}`,
  );
  assert.deepEqual(Object.keys(body).sort(), Object.keys(expected).sort(), `${schemaName} 必填字段必须都在`);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(body[key], value, `${schemaName}.${key} 必须原样发出`);
  }
  return body;
}

test('知识详情：GET /admin/knowledge/{id}，只带 authorization/accept，ETag 与 request_id 原样返回', async () => {
  // 契约前提：读面只有 id 一个路径参数，scope 是 sources:read。
  assert.equal(KNOWLEDGE_ITEM.operationId, 'getAdminKnowledge');
  assert.equal(KNOWLEDGE_ITEM['x-scope'], 'sources:read');
  assert.deepEqual(paramNames(KNOWLEDGE_ITEM), ['id']);

  const { fetchImpl, calls } = spy(() => jsonResponse(200, envelope(knowledgeDraft({ revision: 5 })), { etag: '"5"' }));
  const result = await getKnowledge({ fetchImpl, baseUrl: '/api/v1', token: TOKEN, id: UUID });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/v1/admin/knowledge/${UUID}`, '路径必须逐字等于契约 GET /admin/knowledge/{id}');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.headers.accept, 'application/json');
  assert.equal('if-match' in calls[0].init.headers, false, '读面不得带 If-Match');
  assert.equal('idempotency-key' in calls[0].init.headers, false, '读面不得带 Idempotency-Key');
  assert.equal('body' in calls[0].init, false, 'GET 不得带请求体');
  assert.equal(result.etag, '"5"', '详情必须带回强 ETag（后续编辑/发布/撤回都靠它）');
  assert.equal(result.requestId, '00000000-0000-4000-9000-000000000009');
  assert.equal(result.item.revision, 5);
  assert.equal(result.item.content.title, KNOWLEDGE_INPUT.title);
});

test('知识详情：id 为空串 ⇒ 本地拒绝不发请求；404 ⇒ not_found；缺 visibility ⇒ 判畸形响应', async () => {
  const { fetchImpl, calls } = spy(() => jsonResponse(200, envelope(knowledgeDraft())));
  const emptyId = await getKnowledge({ fetchImpl, baseUrl: '/api/v1', token: TOKEN, id: '' });
  assert.equal(emptyId.ok, false, 'id="" 应本地拒绝');
  assert.equal(emptyId.kind, 'invalid_request');
  assert.equal(calls.length, 0, '没有 id 的请求不得发出去');

  // ⚠ 源码缺陷（只报告、不修）：`fetchFamilyItem()` 不校验 `id` **缺失**——`id: null`/`undefined`
  // 会被 `buildFamilyUrl()` 当成「没有 id」而拼出**集合** URL（`/admin/knowledge`），于是
  // 「取详情」退化成一次列表 GET，再被 `validateKnowledgeDraft` 判成 invalid_response。
  // 结果不算错（不会渲染假详情），但错误类别是 misleading 的。修好后本条应变红 ⇒ 改成断言 invalid_request。
  const missingIdCalls = spy(() => jsonResponse(200, envelope({ items: [], next_cursor: null })));
  const missingId = await getKnowledge({ fetchImpl: missingIdCalls.fetchImpl, baseUrl: '/api/v1', token: TOKEN, id: null });
  assert.equal(missingIdCalls.calls[0].url, '/api/v1/admin/knowledge', '缺陷现状：缺 id 时退回集合 URL');
  assert.equal(missingId.ok, false, '集合分页不得被当成详情渲染');
  assert.equal(missingId.kind, 'invalid_response');

  const missing = await getKnowledge({ fetchImpl: async () => errorResponse(404, 'NOT_FOUND'), baseUrl: '/api/v1', token: TOKEN, id: UUID });
  assert.equal(missing.ok, false);
  assert.equal(missing.kind, 'not_found');

  const { visibility, ...withoutVisibility } = knowledgeDraft();
  assert.equal(visibility, 'private');
  const malformed = await getKnowledge({
    fetchImpl: async () => jsonResponse(200, envelope(withoutVisibility)),
    baseUrl: '/api/v1',
    token: TOKEN,
    id: UUID,
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.kind, 'invalid_response');
  assert.match(malformed.message, /\$\.visibility/);
});

test('建草稿：POST /admin/knowledge 只带 Idempotency-Key（契约 x-version-required:false ⇒ 不带 If-Match），请求体恰为 KnowledgeDraftInput', async () => {
  // 契约前提：创建面只有 IdempotencyKey 一个写头参数，且不要求版本。
  assert.equal(KNOWLEDGE_CREATE.operationId, 'createKnowledgeDraft');
  assert.equal(KNOWLEDGE_CREATE['x-scope'], 'sources:write');
  assert.deepEqual(paramNames(KNOWLEDGE_CREATE), ['IdempotencyKey']);
  assert.equal(KNOWLEDGE_CREATE['x-version-required'], false);

  const { fetchImpl, calls } = spy(() => jsonResponse(201, envelope(knowledgeDraft({ revision: 1 })), { etag: '"1"' }));
  const result = await createKnowledge({
    fetchImpl,
    baseUrl: '/api/v1',
    token: TOKEN,
    idempotencyKey: 'key-knowledge-create-01',
    body: KNOWLEDGE_INPUT,
    // 故意多传 ifMatch：创建面不吃它，也**不得**把它发出去（服务端会当成版本要求的误用）。
    ifMatch: '"9"',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/admin/knowledge', '建草稿是集合 POST，不是 /research_knowledge');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['idempotency-key'], 'key-knowledge-create-01');
  assert.equal('if-match' in calls[0].init.headers, false, '创建面不得带 If-Match（契约只声明 IdempotencyKey）');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assertContractBody(calls[0].init.body, KNOWLEDGE_INPUT_SCHEMA, KNOWLEDGE_INPUT, 'KnowledgeDraftInput');
  assert.equal(result.status, 201);
  assert.equal(result.etag, '"1"');
  assert.deepEqual(result.sentHeaders, { 'idempotency-key': 'key-knowledge-create-01' }, '回显真实发出的头');
  assert.equal(result.item.visibility, 'private', '新建草稿必须是 private（契约不自动发布）');
  assert.equal(result.item.review_status, 'unverified');
});

test('建草稿：缺幂等键 ⇒ 本地拒绝不发请求（不让服务端先回 400）', async () => {
  const { fetchImpl, calls } = spy(() => jsonResponse(201, envelope(knowledgeDraft())));
  for (const idempotencyKey of [undefined, '', 'short', 'k'.repeat(129)]) {
    const result = await createKnowledge({ fetchImpl, baseUrl: '/api/v1', token: TOKEN, idempotencyKey, body: KNOWLEDGE_INPUT });
    assert.equal(result.ok, false, `idempotencyKey=${String(idempotencyKey)} 应本地拒绝`);
    assert.equal(result.kind, 'missing_idempotency_key');
  }
  assert.equal(calls.length, 0);
});

test('撤回：POST /admin/knowledge/{id}/withdraw，If-Match 与 Idempotency-Key 都真的发出，请求体恰为 ReasonInput', async () => {
  // 契约前提：撤回是写面，要求版本（x-version-required: true）+ 两个写头。
  assert.equal(KNOWLEDGE_WITHDRAW.operationId, 'withdrawKnowledge');
  assert.equal(KNOWLEDGE_WITHDRAW['x-scope'], 'sources:write');
  assert.deepEqual(paramNames(KNOWLEDGE_WITHDRAW).sort(), ['IdempotencyKey', 'IfMatch', 'id']);
  assert.equal(KNOWLEDGE_WITHDRAW['x-version-required'], true);

  const { fetchImpl, calls } = spy(() => jsonResponse(200, envelope(knowledgeDraft({ revision: 5, visibility: 'hidden' })), { etag: '"5"' }));
  const result = await withdrawKnowledge({
    fetchImpl,
    baseUrl: '/api/v1',
    token: TOKEN,
    id: UUID,
    ifMatch: '"4"',
    idempotencyKey: 'key-knowledge-withdraw-1',
    body: { reason: '科普内容与已核验来源不一致' },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/v1/admin/knowledge/${UUID}/withdraw`, '撤回路径后缀必须是 /withdraw（不是 /hide 或 /unpublish）');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['if-match'], '"4"', 'If-Match 必须来自已读到的 revision');
  assert.notEqual(calls[0].init.headers['if-match'], '*');
  assert.equal(calls[0].init.headers['idempotency-key'], 'key-knowledge-withdraw-1');
  assertContractBody(calls[0].init.body, REASON_INPUT_SCHEMA, { reason: '科普内容与已核验来源不一致' }, 'ReasonInput');
  assert.equal(result.item.visibility, 'hidden');
  assert.deepEqual(result.sentHeaders, { 'idempotency-key': 'key-knowledge-withdraw-1', 'if-match': '"4"' });
});

test('撤回：缺 If-Match 或传 * ⇒ 本地拒绝不发请求；409 保留错误码与已发头', async () => {
  const { fetchImpl, calls } = spy(() => jsonResponse(200, envelope(knowledgeDraft())));
  for (const ifMatch of [undefined, null, '', '4', '*', '"0"']) {
    const result = await withdrawKnowledge({
      fetchImpl,
      baseUrl: '/api/v1',
      token: TOKEN,
      id: UUID,
      ifMatch,
      idempotencyKey: 'key-knowledge-withdraw-2',
      body: { reason: '科普内容与已核验来源不一致' },
    });
    assert.equal(result.ok, false, `ifMatch=${String(ifMatch)} 应本地拒绝`);
    assert.equal(result.kind, 'missing_if_match');
  }
  assert.equal(calls.length, 0, '必然 428/400 的请求不许发出去');

  const conflict = await withdrawKnowledge({
    fetchImpl: async () => errorResponse(409, 'REVISION_CONFLICT'),
    baseUrl: '/api/v1',
    token: TOKEN,
    id: UUID,
    ifMatch: '"4"',
    idempotencyKey: 'key-knowledge-withdraw-3',
    body: { reason: '科普内容与已核验来源不一致' },
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.kind, 'revision_conflict');
  assert.equal(conflict.code, 'REVISION_CONFLICT');
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.sentHeaders, { 'idempotency-key': 'key-knowledge-withdraw-3', 'if-match': '"4"' });
  assert.equal(describeWriteFailure(conflict).action, 'reload_detail');
});
