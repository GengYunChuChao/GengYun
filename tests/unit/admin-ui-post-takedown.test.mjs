/**
 * 后台「社区帖子下架」纯函数层单测：`apps/admin/src/lib/post-takedown-{api,form}.mjs`。
 *
 * 钉住的都是**契约事实**（逐条可核）：
 *  - 路径与形状：`POST /admin/posts/{id}/hide`，体只有 `{reason}`（`ReasonInput`，1..500）；
 *  - `If-Match` 必须是 `"<正整数>"`，**永不为 `*`**（服务端 `parseIfMatchHeader` 显式拒绝通配）；
 *  - 必带 `Idempotency-Key`（缺 400），且同键只对应同一请求（换内容必须换键）；
 *  - 状态映射按后端**实际**返回：404 `NOT_FOUND`、409 `OBJECT_UNAVAILABLE`/`REVISION_CONFLICT`、
 *    428 `REVISION_REQUIRED`、503 `PROVIDER_UNAVAILABLE`（real 未接线 / 下架已生效但审核域未完成）；
 *    **412 不是本后端的状态**（`REVISION_CONFLICT` 映射为 409），这里只验「不折叠、原样失败」；
 *  - 失败一律不当作成功；503 必须如实标「处置可能已生效」；本模块**不自动重试**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  POSTS_PATH,
  SOURCES_WRITE_SCOPE,
  buildHidePostRequest,
  buildIfMatch,
  buildReason,
  checkIfMatchHeader,
  classifyHideFailure,
  describeTakedownFailure,
  describeTakedownSuccess,
  hidePost,
  newIdempotencyKey,
  normalizePostId,
  planIdempotencyKey,
  requestFingerprint,
  validateAck,
  validateRevision,
} from '../../apps/admin/src/lib/post-takedown-api.mjs';
import {
  CONFIRM_LABEL,
  emptyTakedownForm,
  submitBlockReason,
  validateTakedownForm,
} from '../../apps/admin/src/lib/post-takedown-form.mjs';

const TOKEN = 'test-token-not-a-real-secret';
const POST_ID = '00000000-0000-4000-8000-000000000001';
const KEY = 'admin-post-takedown-0123456789abcdef0123456789abcdef';
const BASE = '/api/v1';

const ACK_BODY = {
  data: { accepted: true },
  meta: { request_id: '11111111-1111-4111-8111-111111111111', contract_version: '1.0.0', execution_mode: 'stub' },
};

function errorBody(code, { message = '', retryable = false, executionMode = 'real' } = {}) {
  return {
    error: { code, message, retryable, details: [] },
    meta: { request_id: '22222222-2222-4222-8222-222222222222', contract_version: '1.0.0', execution_mode: executionMode },
  };
}

function jsonResponse(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body };
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return handler({ url, init, call: calls.length });
  };
  impl.calls = calls;
  return impl;
}

const VALID_REQUEST = {
  baseUrl: BASE,
  token: TOKEN,
  postId: POST_ID,
  revision: 7,
  reason: '社区举报核实为不实用药建议，紧急下架',
  idempotencyKey: KEY,
};

// ------------------------------------------------------------------ 请求构造

test('buildHidePostRequest：路径/方法/头/体逐个钉住，If-Match 是 "7" 而不是 *', () => {
  const built = buildHidePostRequest(VALID_REQUEST);
  assert.equal(built.ok, true);
  const { request } = built;
  assert.equal(request.url, `${BASE}${POSTS_PATH}/${POST_ID}/hide`);
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['if-match'], '"7"');
  assert.equal(request.headers['idempotency-key'], KEY);
  assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.deepEqual(request.body, { reason: VALID_REQUEST.reason });
  // If-Match 永不通配：任何头值都不含 `*`。
  assert.equal(
    Object.values(request.headers).some((value) => value.includes('*')),
    false,
    '请求头里不得出现通配 *',
  );
  // 页面可复述的写头只有两个，且**不含 token**。
  assert.deepEqual(request.sentHeaders, { 'idempotency-key': KEY, 'if-match': '"7"' });
  assert.equal(JSON.stringify(request.sentHeaders).includes(TOKEN), false);
});

test('buildHidePostRequest：baseUrl 去尾斜杠、空 baseUrl 保持相对路径；uuid 归一化小写', () => {
  const trailing = buildHidePostRequest({ ...VALID_REQUEST, baseUrl: 'https://api.example.org/api/v1///' });
  assert.equal(trailing.request.url, `https://api.example.org/api/v1${POSTS_PATH}/${POST_ID}/hide`);
  const relative = buildHidePostRequest({ ...VALID_REQUEST, baseUrl: '  ' });
  assert.equal(relative.request.url, `${POSTS_PATH}/${POST_ID}/hide`);
  const upper = buildHidePostRequest({ ...VALID_REQUEST, postId: POST_ID.toUpperCase() });
  assert.equal(upper.request.postId, POST_ID);
  assert.equal(upper.request.url.endsWith(`/${POST_ID}/hide`), true);
});

test('buildHidePostRequest：非 uuid / 缺键 / 缺令牌 / 理由越界都逐字段报错且不构造请求', () => {
  const notUuid = buildHidePostRequest({ ...VALID_REQUEST, postId: 'not-a-uuid' });
  assert.equal(notUuid.ok, false);
  assert.equal(notUuid.request, undefined);
  assert.deepEqual(notUuid.problems.map((problem) => problem.field), ['post_id']);

  const shortKey = buildHidePostRequest({ ...VALID_REQUEST, idempotencyKey: 'short' });
  assert.equal(shortKey.ok, false);
  assert.deepEqual(shortKey.problems.map((problem) => problem.field), ['idempotency_key']);

  const noToken = buildHidePostRequest({ ...VALID_REQUEST, token: '' });
  assert.equal(noToken.ok, false);
  assert.deepEqual(noToken.problems.map((problem) => problem.field), ['token']);

  const longReason = buildHidePostRequest({ ...VALID_REQUEST, reason: 'x'.repeat(501) });
  assert.equal(longReason.ok, false);
  assert.deepEqual(longReason.problems.map((problem) => problem.field), ['reason']);

  const blankReason = buildHidePostRequest({ ...VALID_REQUEST, reason: '   ' });
  assert.equal(blankReason.ok, false);
  assert.deepEqual(blankReason.problems.map((problem) => problem.field), ['reason']);
});

// ------------------------------------------------------------------ revision / If-Match

test('validateRevision：接受 7／"7"／"\\"7\\""，归一成同一个正整数', () => {
  for (const raw of [7, '7', '"7"', ' 7 ']) {
    const checked = validateRevision(raw);
    assert.equal(checked.ok, true, `${String(raw)} 应被接受`);
    assert.equal(checked.revision, 7);
  }
});

test('validateRevision：通配 * 明确拒绝（服务端会 400），0/负/小数/字母/空串各有专属 code', () => {
  const wildcard = validateRevision('*');
  assert.equal(wildcard.ok, false);
  assert.equal(wildcard.code, 'wildcard');
  assert.match(wildcard.problem, /\*/);
  const quoted = validateRevision('"*"');
  assert.equal(quoted.code, 'wildcard');

  assert.equal(validateRevision('').code, 'empty');
  assert.equal(validateRevision('0').code, 'too_small');
  assert.equal(validateRevision('-1').code, 'not_integer');
  assert.equal(validateRevision('1.5').code, 'not_integer');
  assert.equal(validateRevision('abc').code, 'not_integer');
  assert.equal(validateRevision(0).code, 'too_small');
  assert.equal(validateRevision(1.5).code, 'not_integer');
});

test('buildIfMatch/checkIfMatchHeader：生成带回引号的强 ETag，且拒绝任何含 * 的头值', () => {
  assert.equal(buildIfMatch(3), '"3"');
  assert.throws(() => buildIfMatch('*'), RangeError);
  assert.throws(() => buildIfMatch(0), RangeError);

  assert.deepEqual(checkIfMatchHeader('"12"'), { ok: true, revision: 12 });
  assert.equal(checkIfMatchHeader('*').code, 'wildcard');
  assert.equal(checkIfMatchHeader('"*"').code, 'wildcard');
  assert.equal(checkIfMatchHeader('12').code, 'shape');
  assert.equal(checkIfMatchHeader('').code, 'empty');
});

test('buildReason/validateAck/normalizePostId：契约边界（1..500、accepted 布尔、uuid）', () => {
  assert.equal(buildReason('  紧急下架  ').reason, '紧急下架');
  assert.equal(buildReason('').code, 'empty');
  assert.equal(buildReason('x'.repeat(500)).ok, true);
  assert.equal(buildReason('x'.repeat(501)).code, 'too_long');

  assert.equal(validateAck({ accepted: true }).ok, true);
  assert.equal(validateAck({ accepted: 'yes' }).ok, false);
  assert.deepEqual(validateAck({ accepted: true, extra: 1 }).extras, ['extra']);

  assert.equal(normalizePostId(POST_ID), POST_ID);
  assert.equal(normalizePostId(''), null);
  assert.equal(normalizePostId(null), null);
});

test('newIdempotencyKey：前缀固定、长度在 8..128、两次不同', () => {
  const first = newIdempotencyKey();
  const second = newIdempotencyKey();
  assert.match(first, /^admin-post-takedown-[0-9a-f]{32}$/);
  assert.equal(first.length >= 8 && first.length <= 128, true);
  assert.notEqual(first, second);
});

test('planIdempotencyKey：同指纹复用同一键，换内容必须换新键（否则服务端 409 幂等冲突）', () => {
  const fingerprint = requestFingerprint({ postId: POST_ID, ifMatch: '"7"', reason: 'r' });
  const first = planIdempotencyKey({ previous: null, fingerprint, generate: () => 'admin-post-takedown-aaaaaaaa' });
  assert.equal(first.reused, false);
  assert.equal(first.key, 'admin-post-takedown-aaaaaaaa');

  const replay = planIdempotencyKey({
    previous: { key: first.key, fingerprint },
    fingerprint,
    generate: () => 'admin-post-takedown-bbbbbbbb',
  });
  assert.equal(replay.reused, true);
  assert.equal(replay.key, first.key);

  const changed = planIdempotencyKey({
    previous: { key: first.key, fingerprint },
    fingerprint: requestFingerprint({ postId: POST_ID, ifMatch: '"8"', reason: 'r' }),
    generate: () => 'admin-post-takedown-cccccccc',
  });
  assert.equal(changed.reused, false);
  assert.equal(changed.key, 'admin-post-takedown-cccccccc');
});

// ------------------------------------------------------------------ 成功路径

test('hidePost：200 accepted:true ⇒ 受理回执（读 ETag 与 request_id），且请求体只含 reason', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, ACK_BODY, { etag: '"8"' }));
  const result = await hidePost({ ...VALID_REQUEST, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.accepted, true);
  assert.equal(result.etag, '"8"');
  assert.equal(result.requestId, ACK_BODY.meta.request_id);
  assert.equal(fetchImpl.calls.length, 1);
  const sent = fetchImpl.calls[0];
  assert.equal(sent.init.method, 'POST');
  assert.deepEqual(JSON.parse(sent.init.body), { reason: VALID_REQUEST.reason });
  assert.equal(sent.init.headers['if-match'], '"7"');
});

test('hidePost：200 但 accepted 不是 true / 信封缺 meta ⇒ 一律 invalid_response，不当作成功', async () => {
  const notAccepted = await hidePost({
    ...VALID_REQUEST,
    fetchImpl: fakeFetch(() => jsonResponse(200, { ...ACK_BODY, data: { accepted: false } })),
  });
  assert.equal(notAccepted.ok, false);
  assert.equal(notAccepted.kind, 'invalid_response');
  assert.match(notAccepted.message, /accepted/);

  const noMeta = await hidePost({
    ...VALID_REQUEST,
    fetchImpl: fakeFetch(() => jsonResponse(200, { data: { accepted: true } })),
  });
  assert.equal(noMeta.kind, 'invalid_response');
  assert.match(noMeta.message, /meta/);
});

test('describeTakedownSuccess：只说「服务端已受理」，绝不出现「已下架成功/成功下架」', () => {
  const receipt = describeTakedownSuccess({ ok: true, status: 200, etag: '"8"', requestId: 'r-1' });
  assert.match(receipt.title, /服务端已受理/);
  assert.match(receipt.title, /200/);
  assert.match(receipt.title, /accepted:true/);
  const text = `${receipt.title}${receipt.detail}${receipt.advice}`;
  assert.doesNotMatch(text, /已下架成功|成功下架|已完成下架/);
  assert.match(text, /未在本页验证/);
  assert.equal(describeTakedownSuccess({ ok: false }), null);
});

// ------------------------------------------------------------------ 失败映射

test('hidePost：404 有/无错误信封**同形**（同一 kind、同一文案），且不是「已删除」', async () => {
  const withEnvelope = await hidePost({
    ...VALID_REQUEST,
    fetchImpl: fakeFetch(() => jsonResponse(404, errorBody('NOT_FOUND', { message: '帖子不存在' }))),
  });
  const bare = await hidePost({ ...VALID_REQUEST, fetchImpl: fakeFetch(() => jsonResponse(404, null)) });

  assert.equal(withEnvelope.ok, false);
  assert.equal(withEnvelope.kind, 'not_found');
  assert.equal(bare.kind, 'not_found');
  assert.equal(describeTakedownFailure(withEnvelope).title, describeTakedownFailure(bare).title);
  assert.match(describeTakedownFailure(withEnvelope).title, /404/);
  assert.match(describeTakedownFailure(withEnvelope).advice, /OBJECT_UNAVAILABLE/);
});

test('hidePost：409 按 code 细分为 OBJECT_UNAVAILABLE / REVISION_CONFLICT，且无 code 的 409 不猜', async () => {
  const unavailable = await hidePost({
    ...VALID_REQUEST,
    fetchImpl: fakeFetch(() =>
      jsonResponse(409, errorBody('OBJECT_UNAVAILABLE', { message: '帖子已删除，不可隐藏（已删除内容不复活）' })),
    ),
  });
  assert.equal(unavailable.kind, 'object_unavailable');
  assert.equal(unavailable.status, 409);
  assert.match(describeTakedownFailure(unavailable).title, /OBJECT_UNAVAILABLE/);
  // 原文必须上屏（两支只能靠它区分），但不判成功。
  assert.match(describeTakedownFailure(unavailable).detail, /已删除内容不复活/);

  const conflict = await hidePost({
    ...VALID_REQUEST,
    fetchImpl: fakeFetch(() => jsonResponse(409, errorBody('REVISION_CONFLICT', { message: '修订已变化' }))),
  });
  assert.equal(conflict.kind, 'revision_conflict');
  assert.equal(conflict.retriable, false);

  const noCode = await hidePost({ ...VALID_REQUEST, fetchImpl: fakeFetch(() => jsonResponse(409, null)) });
  assert.equal(noCode.kind, 'conflict_unknown');
  assert.match(describeTakedownFailure(noCode).title, /没有可解析的错误码/);
});

test('hidePost：428/400/403/401 各自归位，错误码原样保留', async () => {
  const cases = [
    [428, 'REVISION_REQUIRED', 'revision_required'],
    [400, 'INVALID_REQUEST', 'invalid_request'],
    [400, 'IDEMPOTENCY_KEY_REQUIRED', 'invalid_request'],
    [403, 'SCOPE_DENIED', 'forbidden'],
    [401, 'SESSION_EXPIRED', 'signed_out'],
  ];
  for (const [status, code, kind] of cases) {
    const result = await hidePost({
      ...VALID_REQUEST,
      fetchImpl: fakeFetch(() => jsonResponse(status, errorBody(code, { message: 'x' }))),
    });
    assert.equal(result.ok, false);
    assert.equal(result.kind, kind, `${status} ${code} 应归到 ${kind}`);
    assert.equal(result.status, status);
    assert.equal(result.code, code);
  }
});

test('hidePost：real 模式 503 如实失败（retryable 取服务端声明），并标「处置可能已生效」', async () => {
  const unwired = await hidePost({
    ...VALID_REQUEST,
    fetchImpl: fakeFetch(() =>
      jsonResponse(503, errorBody('PROVIDER_UNAVAILABLE', { message: '社区帖子存储尚未接线', retryable: false })),
    ),
  });
  assert.equal(unwired.ok, false);
  assert.equal(unwired.kind, 'unavailable');
  assert.equal(unwired.retriable, false);
  assert.equal(unwired.maybeEffective, true);
  assert.equal(unwired.executionMode, 'real');
  const described = describeTakedownFailure(unwired);
  assert.match(described.title, /503/);
  assert.match(described.detail, /尚未接线/);
  assert.match(described.detail, /real|execution_mode/);
  assert.match(described.advice, /处置可能已生效/);
  assert.match(described.advice, /不会自动重试/);

  // 服务端声明 retryable:true 时照服务端，不在本地另立一套。
  const retriable = await hidePost({
    ...VALID_REQUEST,
    fetchImpl: fakeFetch(() =>
      jsonResponse(503, errorBody('PROVIDER_UNAVAILABLE', { message: '瞬时故障', retryable: true })),
    ),
  });
  assert.equal(retriable.retriable, true);
});

test('hidePost：412 是契约外状态，原样失败且**不折叠**成 409 修订冲突', async () => {
  const result = await hidePost({ ...VALID_REQUEST, fetchImpl: fakeFetch(() => jsonResponse(412, null)) });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'precondition_failed');
  assert.equal(result.status, 412);
  const described = describeTakedownFailure(result);
  assert.match(described.title, /412/);
  assert.match(described.advice, /不折叠|不是 412/);
  assert.equal(classifyHideFailure({ status: 409, code: 'REVISION_CONFLICT' }).kind, 'revision_conflict');
});

test('hidePost：本地校验不通过就**不发请求**（revision 填 *）', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, ACK_BODY));
  const result = await hidePost({ ...VALID_REQUEST, revision: '*', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'invalid_request');
  assert.match(result.message, /If-Match 不允许 \*/);
  assert.equal(fetchImpl.calls.length, 0, '不应发出一个必然 400 的请求');
});

test('hidePost：网络错误 ⇒ network_error + 结果未知，且**不自动重试**（fetch 只被调用一次）', async () => {
  const fetchImpl = fakeFetch(() => {
    throw new TypeError('fetch failed');
  });
  const result = await hidePost({ ...VALID_REQUEST, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'network_error');
  assert.equal(result.maybeEffective, true);
  assert.equal(result.requestUrl, `${BASE}${POSTS_PATH}/${POST_ID}/hide`);
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(describeTakedownFailure(result).advice, /同一/);
  assert.match(describeTakedownFailure(result).advice, /幂等键/);
});

// ------------------------------------------------------------------ 表单层

test('validateTakedownForm：填全 ⇒ ok，且 value 归一化（小写 uuid、整数 revision、trim 理由）', () => {
  const checked = validateTakedownForm({
    post_id: ` ${POST_ID.toUpperCase()} `,
    revision: '"9"',
    reason: '  紧急下架  ',
    confirmed: true,
  });
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.value, { postId: POST_ID, revision: 9, reason: '紧急下架' });
});

test('validateTakedownForm：逐字段问题都能定位（含 revision 填 *、未勾选确认）', () => {
  const empty = validateTakedownForm(emptyTakedownForm());
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.problems.map((problem) => problem.field), ['post_id', 'revision', 'reason', 'confirmed']);

  const wildcard = validateTakedownForm({ post_id: POST_ID, revision: '*', reason: '理由', confirmed: true });
  assert.equal(wildcard.ok, false);
  assert.deepEqual(wildcard.problems.map((problem) => problem.field), ['revision']);
  assert.match(wildcard.problems[0].message, /不允许 \*/);

  const unconfirmed = validateTakedownForm({ post_id: POST_ID, revision: '3', reason: '理由', confirmed: false });
  assert.equal(unconfirmed.ok, false);
  assert.deepEqual(unconfirmed.problems.map((problem) => problem.field), ['confirmed']);
  assert.ok(unconfirmed.problems[0].message.includes(CONFIRM_LABEL));
});

test('submitBlockReason：顺序固定 submitting → scope_missing → post_id → revision → reason → confirmed', () => {
  const valid = { post_id: POST_ID, revision: '3', reason: '理由', confirmed: true };
  assert.equal(submitBlockReason(valid), null);

  assert.equal(submitBlockReason(valid, { submitting: true }).code, 'submitting');
  assert.equal(submitBlockReason(valid, { hasWriteScope: false }).code, 'scope_missing');
  assert.ok(submitBlockReason(valid, { hasWriteScope: false }).message.includes(SOURCES_WRITE_SCOPE));

  // 缺 revision：即使其它字段都填了、确认也勾了，仍然只报 revision 这一条。
  const noRevision = submitBlockReason({ ...valid, revision: '' });
  assert.equal(noRevision.code, 'revision');
  assert.match(noRevision.message, /revision 必填/);

  assert.equal(submitBlockReason({ ...valid, post_id: '' }).code, 'post_id');
  assert.equal(submitBlockReason({ ...valid, reason: '' }).code, 'reason');
  assert.equal(submitBlockReason({ ...valid, confirmed: false }).code, 'confirmed');
  // 一条都没填时先报第一项（不是把 4 条一起糊上去）。
  assert.equal(submitBlockReason(emptyTakedownForm()).code, 'post_id');
});
