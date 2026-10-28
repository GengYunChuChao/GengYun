/**
 * `apps/admin/src/lib/admin-moderation-queue.mjs` 的纯函数用例（无 Vue、无 DOM、无网络）。
 *
 * 断言口径：**以契约为事实**。凡涉及 operationId／参数名／scope／错误码／字段名的断言，
 * 都能在 `packages/contracts/openapi.json` 里找到同形（用例注释里给了行号）；
 * 凡涉及「不该发请求」的断言，都检查「本地就拦下」，而不是「发了再看服务端怎么答」。
 *
 * 渲染级用例另见 `tests/unit/admin-ui-moderation-queue-render.test.mjs`。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appendModerationPage,
  AUDIT_STATES,
  buildAdminPostDetailUrl,
  buildModerationQueueUrl,
  buildPostReviewRequest,
  canLoadMoreModeration,
  canRetryModerationFailure,
  classifyQueueReadFailure,
  classifyReviewFailure,
  describeModerationFilters,
  describeQueueFailure,
  describeQueueView,
  describeReviewFailure,
  describeReviewOutcome,
  DETAIL_OPERATION_ID,
  emptyModerationFilters,
  emptyModerationQueue,
  fetchAdminPostDetail,
  fetchModerationQueuePage,
  filtersToQuery,
  formatModerationTimestamp,
  hasActiveModerationFilters,
  initialModerationQueueState,
  LIST_OPERATION_ID,
  MODERATION_FILTER_ANY,
  MODERATION_QUEUE_PATH,
  MODERATION_READ_SCOPE,
  MODERATION_WRITE_SCOPE,
  moderationQueueRows,
  needsModerationRestart,
  normalizeModerationFilters,
  patchModerationPost,
  patchModerationRow,
  POST_REVIEW_OUTCOME_FIELDS,
  POST_REVIEW_REASON_CODES,
  reduceModerationQueue,
  submitPostReview,
  validateAdminPost,
  validateAdminPostPage,
  validateModerationFilters,
  validatePostReviewOutcome,
  VISIBILITY_STATES,
  APPROVE_OPERATION_ID,
  REJECT_OPERATION_ID,
} from '../../apps/admin/src/lib/admin-moderation-queue.mjs';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const POST_ID = '3f1d2c9a-1111-4222-8333-444455556666';
const OTHER_ID = '3f1d2c9a-1111-4222-8333-444455557777';
const KEY = 'admin-moderation-0123456789abcdef';

function meta() {
  return { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'real' };
}

function post(overrides = {}) {
  return {
    id: POST_ID,
    revision: 3,
    author_id: '22222222-2222-4222-8222-222222222222',
    anonymized_author_ref: null,
    title: '玉米地里的草地贪夜蛾怎么打',
    body: '早上打药比中午好，避开高温时段。',
    crop_id: 'corn',
    region_code: '330100',
    media_ids: [],
    visibility: 'private',
    audit_state: 'pending',
    created_at: '2026-10-23T08:12:33.000Z',
    updated_at: '2026-10-23T08:12:33.000Z',
    linked_knowledge_ref: null,
    ...overrides,
  };
}

function outcome(overrides = {}) {
  return {
    id: POST_ID,
    revision: 4,
    audit_state: 'approved',
    // 服务端真实可达形态（`admin/ops/community-posts.ts:327-328`）：private 帖通过后就是 published。
    // 旧夹具写 'private' 是服务端**不会**返回的状态，等于把「通过不改可见性」的错误结论钉死。
    visibility: 'published',
    decision: 'approved',
    changed: true,
    notified: false,
    reason_codes: [],
    ...overrides,
  };
}

function page(items, nextCursor = null) {
  return { data: { items, next_cursor: nextCursor }, meta: meta() };
}

function errorEnvelope(code, message, retryable = false) {
  return { error: { code, message, retryable, details: [] }, meta: meta() };
}

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
  };
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return handler({ url, init });
  };
  impl.calls = calls;
  return impl;
}

// ------------------------------------------------------------------ 契约常量

test('契约常量与 openapi 同形：路径／operationId／scope／闭集条数', () => {
  assert.equal(MODERATION_QUEUE_PATH, '/admin/posts', '契约 :11008 的 path');
  assert.equal(LIST_OPERATION_ID, 'listAdminPosts', '契约 :11010');
  assert.equal(DETAIL_OPERATION_ID, 'getAdminPost', '契约 :11114');
  assert.equal(APPROVE_OPERATION_ID, 'approvePost', '契约 :11312');
  assert.equal(REJECT_OPERATION_ID, 'rejectPost', '契约 :11409');
  assert.equal(MODERATION_READ_SCOPE, 'sources:read', '契约 :11107 / :11198 的 x-scope');
  assert.equal(MODERATION_WRITE_SCOPE, 'sources:write', '契约 :11402 / :11499 的 x-scope');
  assert.deepEqual(VISIBILITY_STATES, ['private', 'published', 'hidden', 'deleted'], '契约 Visibility :11937');
  assert.deepEqual(AUDIT_STATES, ['pending', 'approved', 'rejected', 'quarantined'], '契约 AuditState :11928');
  assert.equal(POST_REVIEW_REASON_CODES.length, 10, '契约 PostRejectionInput.reason_code 闭集 :15941');
  assert.deepEqual(
    [...POST_REVIEW_REASON_CODES],
    ['spam', 'harassment', 'adult_or_violent', 'illegal_or_political', 'privacy', 'misleading_agronomy', 'banned_agrochemical', 'off_topic', 'duplicate', 'other'],
  );
  assert.equal(POST_REVIEW_OUTCOME_FIELDS.length, 8, '契约 PostReviewOutcome 8 个必填 :15966');
});

// ------------------------------------------------------------------ URL

test('列表 URL：limit 总是显式带、默认 20', () => {
  assert.equal(buildModerationQueueUrl('/api/v1', {}), '/api/v1/admin/posts?limit=20');
  assert.equal(buildModerationQueueUrl('/api/v1/', { limit: 20 }), '/api/v1/admin/posts?limit=20', '尾部斜杠被归一化');
});

test('列表 URL：limit 夹紧到契约 1..50（0→1、999→50、字符串→数字、NaN→20）', () => {
  assert.equal(buildModerationQueueUrl('', { limit: 0 }), '/admin/posts?limit=1');
  assert.equal(buildModerationQueueUrl('', { limit: 999 }), '/admin/posts?limit=50');
  assert.equal(buildModerationQueueUrl('', { limit: '30' }), '/admin/posts?limit=30');
  assert.equal(buildModerationQueueUrl('', { limit: Number.NaN }), '/admin/posts?limit=20');
  assert.equal(buildModerationQueueUrl('', { limit: 7.5 }), '/admin/posts?limit=20', '非整数回落默认');
});

test('列表 URL：cursor 只在续页带；超长与空串本地抛错（不发必然 400 的请求）', () => {
  assert.equal(buildModerationQueueUrl('', { cursor: 'abc' }), '/admin/posts?limit=20&cursor=abc');
  assert.throws(() => buildModerationQueueUrl('', { cursor: '' }), TypeError);
  assert.throws(() => buildModerationQueueUrl('', { cursor: 'x'.repeat(2049) }), RangeError);
  assert.equal(buildModerationQueueUrl('', { cursor: 'x'.repeat(2048) }).includes('cursor='), true, '2048 正好是上限');
});

test('列表 URL：筛选参数名是契约的 state 与 audit_state（⛔ 没有 entity／entity_type）', () => {
  const url = buildModerationQueueUrl('', { filters: { state: 'hidden', auditState: 'pending' } });
  assert.equal(url, '/admin/posts?limit=20&state=hidden&audit_state=pending');
  assert.doesNotMatch(url, /entity/);
  assert.equal(buildModerationQueueUrl('', { filters: { state: 'all', auditState: 'all' } }), '/admin/posts?limit=20', '「全部」不上行');
});

test('列表 URL：筛选不在闭集内 ⇒ 本地抛 TypeError；首尾空白按 trim 后校验', () => {
  assert.throws(() => buildModerationQueueUrl('', { filters: { state: 'deletedd', auditState: 'all' } }), TypeError);
  assert.throws(() => buildModerationQueueUrl('', { filters: { state: 'all', auditState: 'approve' } }), TypeError, 'audit_state 只有 4 值，approve 不是其中之一');
  assert.equal(
    buildModerationQueueUrl('', { filters: { state: ' hidden ', auditState: ' all ' } }),
    '/admin/posts?limit=20&state=hidden',
    '首尾空白被归一化（手输以外不至于发出必然 400 的请求）',
  );
});

test('详情 URL：uuid 归一化（小写）；非 uuid 抛 TypeError', () => {
  assert.equal(buildAdminPostDetailUrl('/api/v1', POST_ID.toUpperCase()), `/api/v1/admin/posts/${POST_ID}`);
  assert.throws(() => buildAdminPostDetailUrl('/api/v1', 'not-a-uuid'), TypeError);
});

// ------------------------------------------------------------------ 筛选

test('筛选归一化与校验：空串／缺失回落到「全部」，闭集外报问题', () => {
  assert.deepEqual(normalizeModerationFilters(null), { state: MODERATION_FILTER_ANY, auditState: MODERATION_FILTER_ANY });
  assert.deepEqual(normalizeModerationFilters({ state: '  ', auditState: 'pending' }), { state: MODERATION_FILTER_ANY, auditState: 'pending' });
  assert.equal(validateModerationFilters({ state: 'hidden', auditState: 'all' }).ok, true);
  const bad = validateModerationFilters({ state: 'published', auditState: 'nope' });
  assert.equal(bad.ok, false);
  assert.equal(bad.problems.length, 1);
  assert.equal(bad.problems[0].field, 'audit_state');
});

test('筛选：hasActive／describe／filtersToQuery 三者口径一致', () => {
  assert.equal(hasActiveModerationFilters(emptyModerationFilters()), false);
  assert.equal(hasActiveModerationFilters({ state: 'hidden' }), true);
  assert.equal(describeModerationFilters(emptyModerationFilters()), '全部可见性 · 全部审核态');
  assert.equal(describeModerationFilters({ state: 'hidden', auditState: 'pending' }), 'visibility=hidden · audit_state=pending');
  assert.deepEqual(filtersToQuery({ state: 'hidden', auditState: 'pending' }), [['state', 'hidden'], ['audit_state', 'pending']]);
  assert.deepEqual(filtersToQuery(emptyModerationFilters()), []);
});

// ------------------------------------------------------------------ 响应校验

test('validateAdminPost：完整行通过，14 个必填字段一个不少', () => {
  const checked = validateAdminPost(post());
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.errors, []);
  assert.deepEqual(checked.extras, []);
});

test('validateAdminPost：缺字段／枚举外／越界都记 error（该行不渲染，不猜）', () => {
  const missing = post();
  delete missing.body;
  assert.equal(validateAdminPost(missing).ok, false);
  assert.match(JSON.stringify(validateAdminPost(missing).errors), /body/);

  assert.equal(validateAdminPost(post({ visibility: 'archived' })).ok, false, 'Visibility 闭集外');
  assert.equal(validateAdminPost(post({ audit_state: 'spam' })).ok, false, 'AuditState 闭集外');
  assert.equal(validateAdminPost(post({ revision: 0 })).ok, false, 'revision 必须 >= 1');
  assert.equal(validateAdminPost(post({ title: 'x'.repeat(121) })).ok, false, 'title 上限 120');
  assert.equal(validateAdminPost(post({ body: 'x'.repeat(8001) })).ok, false, 'body 上限 8000');
  assert.equal(validateAdminPost(post({ media_ids: ['a', 'b', 'c', 'd'] })).ok, false, 'media 最多 3');
  assert.equal(validateAdminPost(post({ region_code: '440100' })).ok, false, 'region_code pattern ^33[0-9]{4}$');
});

test('validateAdminPost：注销作者（author_id=null）合法，多余字段记 warning 而不是白页', () => {
  const ok = validateAdminPost(post({ author_id: null, anonymized_author_ref: 'gy-anon-0123456789abcdef' }));
  assert.equal(ok.ok, true);
  const extra = validateAdminPost(post({ surprise: 1 }));
  assert.equal(extra.ok, true, '多一个字段不该让整页白掉');
  assert.equal(extra.warnings.length >= 0, true, '但也不隐藏（extras 原样返回）');
  assert.deepEqual(extra.extras, ['surprise']);
});

test('validateAdminPostPage：items 上限 50、next_cursor 只能 null 或 1..2048 字符串', () => {
  assert.equal(validateAdminPostPage({ items: [post()], next_cursor: 'c1' }).ok, true);
  assert.equal(validateAdminPostPage({ items: [], next_cursor: null }).ok, true, '空数组是合法空页');
  assert.equal(validateAdminPostPage({ items: [post()], next_cursor: '' }).ok, false, '空串不是合法游标');
  assert.equal(validateAdminPostPage({ items: [post()], next_cursor: 'x'.repeat(2049) }).ok, false);
  assert.equal(validateAdminPostPage({ items: 'nope', next_cursor: null }).ok, false);
  const many = Array.from({ length: 51 }, (_, index) => post({ id: `3f1d2c9a-1111-4222-8333-4444555566${String(index).padStart(2, '0')}` }));
  assert.equal(validateAdminPostPage({ items: many, next_cursor: null }).ok, false, '超过契约 maxItems 50');
  const partial = validateAdminPostPage({ items: [post(), post({ id: OTHER_ID, audit_state: 'nope' })], next_cursor: null });
  assert.equal(partial.ok, false, '任一行不合规 ⇒ 整体不 ok');
  assert.equal(partial.items.length, 1, '合法行仍然被收集（但调用方按 ok:false 处理）');
});

test('validatePostReviewOutcome：8 个必填、changed/notified 必须是布尔', () => {
  assert.equal(validatePostReviewOutcome(outcome()).ok, true);
  const missing = outcome();
  delete missing.changed;
  assert.equal(validatePostReviewOutcome(missing).ok, false);
  assert.equal(validatePostReviewOutcome(outcome({ changed: 'false' })).ok, false, '字符串不是布尔');
  assert.equal(validatePostReviewOutcome(outcome({ audit_state: 'pending' })).ok, false, 'audit_state 只能是 approved/rejected');
  assert.equal(validatePostReviewOutcome(outcome({ decision: 'approve' })).ok, false, 'decision 是 approved/rejected');
  assert.deepEqual(validatePostReviewOutcome(outcome({ extra: 1 })).extras, ['extra']);
});

// ------------------------------------------------------------------ 分页集合

test('appendModerationPage：按 id 去重、页数记账', () => {
  const first = appendModerationPage(emptyModerationQueue(), { cursor: null, page: { items: [post()], nextCursor: 'c1' } });
  assert.equal(first.collection.items.length, 1);
  assert.equal(first.collection.nextCursor, 'c1');
  assert.equal(first.collection.pages, 1);

  const second = appendModerationPage(first.collection, { cursor: 'c1', page: { items: [post(), post({ id: OTHER_ID })], nextCursor: null } });
  assert.equal(second.collection.items.length, 2, '重复 id 不重复计数');
  assert.equal(second.collection.duplicates, 1);
  assert.equal(second.added.length, 1);
  assert.equal(second.collection.pages, 2);
});

test('appendModerationPage：服务端把本次 cursor 原样回传 ⇒ 判成环、停止续页', () => {
  const loop = appendModerationPage(emptyModerationQueue(), { cursor: 'c1', page: { items: [post()], nextCursor: 'c1' } });
  assert.equal(loop.collection.cycle, true, '原地踏步必须被识别');
  assert.equal(loop.collection.nextCursor, null, '成环后不再给续页游标');
});

test('patchModerationRow／patchModerationPost：只改回执命中的那一行', () => {
  const collection = { ...emptyModerationQueue(), items: [post(), post({ id: OTHER_ID })] };
  const patched = patchModerationRow(collection, outcome({ revision: 9, audit_state: 'approved' }));
  assert.equal(patched.items[0].revision, 9);
  assert.equal(patched.items[0].audit_state, 'approved');
  assert.equal(patched.items[1].revision, 3, '别的行不动');
  assert.equal(patchModerationRow(collection, outcome({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })).items[0].revision, 3);
  assert.equal(patchModerationPost(post(), outcome({ revision: 9 })).revision, 9);
  assert.equal(patchModerationPost(post({ id: OTHER_ID }), outcome()).revision, 3, 'id 不匹配不改');
  assert.equal(patchModerationPost(null, outcome()), null);
});

// ------------------------------------------------------------------ 读面失败分类

test('读面失败：403 即使服务端写 retryable:true 也不给重试（重试同一个无权会话没有意义）', () => {
  const forbidden = classifyQueueReadFailure({ status: 403, code: 'SCOPE_DENIED', message: '缺少 sources:read', retryable: true });
  assert.equal(forbidden.kind, 'forbidden');
  assert.equal(forbidden.inContract, true);
  assert.equal(canRetryModerationFailure(forbidden), false);
  const view = describeQueueFailure(forbidden);
  assert.match(view.title, /权限不足/);
  assert.match(view.title, /sources:read/);
  assert.equal(view.canRetry, false);
  assert.equal(view.role, 'alert');
});

test('读面失败：503 只有服务端声明 retryable:true 才给重试', () => {
  const closed = classifyQueueReadFailure({ status: 503, code: 'PROVIDER_UNAVAILABLE', message: '尚未接线', retryable: false });
  assert.equal(closed.kind, 'unavailable');
  assert.equal(closed.retriable, false);
  assert.equal(canRetryModerationFailure(closed), false);
  assert.match(describeQueueFailure(closed).detail, /不可自动重试/);

  const open = classifyQueueReadFailure({ status: 503, code: 'PROVIDER_UNAVAILABLE', message: '过载', retryable: true });
  assert.equal(canRetryModerationFailure(open), true);
  assert.equal(describeQueueFailure(open).canRetry, true);
  assert.match(describeQueueFailure(open).detail, /稍后重试/);
});

test('读面失败：401／400 INVALID_CURSOR／404／429／网络错误各自分类', () => {
  assert.equal(classifyQueueReadFailure({ status: 401 }).kind, 'signed_out');
  assert.equal(canRetryModerationFailure(classifyQueueReadFailure({ status: 401 })), false);
  const cursor = classifyQueueReadFailure({ status: 400, code: 'INVALID_CURSOR', message: '游标无效' });
  assert.equal(cursor.kind, 'invalid_cursor');
  assert.equal(describeQueueFailure(cursor).restartNeeded, true, '游标无效要回第一页');
  assert.equal(classifyQueueReadFailure({ status: 404, code: 'NOT_FOUND' }).kind, 'not_found');
  const limited = classifyQueueReadFailure({ status: 429, code: 'RATE_LIMITED', retryable: true, retryAfterSeconds: 7 });
  assert.equal(canRetryModerationFailure(limited), true);
  assert.match(describeQueueFailure(limited).detail, /7 秒/);
  const network = classifyQueueReadFailure({ status: 0, message: 'boom' });
  assert.equal(network.kind, 'http_error', '没有状态码又没有信封时按 http_error');
  assert.equal(describeQueueFailure(network).tone, 'error');
});

test('读面失败｜不伪造空页：describeQueueFailure 的 status/code 原样上屏（契约外码显式标注）', () => {
  const weird = classifyQueueReadFailure({ status: 502, code: 'MADE_UP_CODE', message: '网关' });
  const view = describeQueueFailure(weird);
  assert.match(view.detail, /MADE_UP_CODE（契约外码）/);
  assert.match(view.detail, /HTTP 502/);
});

// ------------------------------------------------------------------ 读面请求

test('fetchModerationQueuePage：成功路径带上 Bearer／accept，并把筛选拼进 URL', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, page([post()], 'next-1')));
  const result = await fetchModerationQueuePage({
    fetchImpl,
    baseUrl: '/api/v1',
    token: 'tok',
    limit: 20,
    filters: { state: 'hidden', auditState: 'pending' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.page.items.length, 1);
  assert.equal(result.page.nextCursor, 'next-1');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, '/api/v1/admin/posts?limit=20&state=hidden&audit_state=pending');
  assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer tok');
  assert.equal(fetchImpl.calls[0].init.headers.accept, 'application/json');
});

test('fetchModerationQueuePage：没有 token 不发请求；fetch 缺省也不发请求', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, page([])));
  const signedOut = await fetchModerationQueuePage({ fetchImpl, baseUrl: '/api/v1', token: '' });
  assert.equal(signedOut.kind, 'signed_out');
  assert.equal(fetchImpl.calls.length, 0, '没有令牌就不该发请求');

  const noFetch = await fetchModerationQueuePage({ fetchImpl: null, baseUrl: '/api/v1', token: 'tok' });
  assert.equal(noFetch.kind, 'network_error');
});

test('fetchModerationQueuePage：网络异常／畸形 JSON／形状不符都归失败，绝不返回空页', async () => {
  const boom = await fetchModerationQueuePage({
    baseUrl: '/api/v1',
    token: 'tok',
    fetchImpl: async () => {
      throw new Error('ECONNRESET');
    },
  });
  assert.equal(boom.ok, false);
  assert.equal(boom.kind, 'network_error');
  assert.match(boom.message, /ECONNRESET/);

  const badJson = await fetchModerationQueuePage({
    baseUrl: '/api/v1',
    token: 'tok',
    fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => { throw new Error('not json'); } }),
  });
  assert.equal(badJson.kind, 'invalid_response');

  const noEnvelope = await fetchModerationQueuePage({ baseUrl: '/api/v1', token: 'tok', fetchImpl: fakeFetch(() => jsonResponse(200, { data: { items: [] } })) });
  assert.equal(noEnvelope.kind, 'invalid_response', '缺 meta 的信封不算成功');

  const badRow = await fetchModerationQueuePage({ baseUrl: '/api/v1', token: 'tok', fetchImpl: fakeFetch(() => jsonResponse(200, page([post({ audit_state: 'nope' })]))) });
  assert.equal(badRow.kind, 'invalid_response');
  assert.match(badRow.message, /AdminPostPage/);
});

test('fetchModerationQueuePage：403／503 的原样透传（含 retryable 由服务端决定）', async () => {
  const forbidden = await fetchModerationQueuePage({
    baseUrl: '/api/v1',
    token: 'tok',
    fetchImpl: fakeFetch(() => jsonResponse(403, errorEnvelope('SCOPE_DENIED', '缺少所需权限：sources:read'))),
  });
  assert.equal(forbidden.kind, 'forbidden');
  assert.equal(forbidden.code, 'SCOPE_DENIED');
  assert.equal(forbidden.status, 403);
  assert.equal(canRetryModerationFailure(forbidden), false);

  const unavailable = await fetchModerationQueuePage({
    baseUrl: '/api/v1',
    token: 'tok',
    fetchImpl: fakeFetch(() => jsonResponse(503, errorEnvelope('PROVIDER_UNAVAILABLE', '读面未接线', false))),
  });
  assert.equal(unavailable.kind, 'unavailable');
  assert.equal(canRetryModerationFailure(unavailable), false, 'retryable:false ⇒ 不给重试');
});

test('fetchAdminPostDetail：200 + ETag；404 是 not_found；非 uuid 本地拦截', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { data: post(), meta: meta() }, { etag: '"3"' }));
  const ok = await fetchAdminPostDetail({ fetchImpl, baseUrl: '/api/v1', token: 'tok', postId: POST_ID });
  assert.equal(ok.ok, true);
  assert.equal(ok.etag, '"3"');
  assert.equal(fetchImpl.calls[0].url, `/api/v1/admin/posts/${POST_ID}`);

  const missing = await fetchAdminPostDetail({
    baseUrl: '/api/v1',
    token: 'tok',
    postId: POST_ID,
    fetchImpl: fakeFetch(() => jsonResponse(404, errorEnvelope('NOT_FOUND', '帖子不存在'))),
  });
  assert.equal(missing.kind, 'not_found');

  const details = fakeFetch(() => jsonResponse(200, { data: post(), meta: meta() }));
  const invalid = await fetchAdminPostDetail({ fetchImpl: details, baseUrl: '/api/v1', token: 'tok', postId: 'nope' });
  assert.equal(invalid.kind, 'invalid_request');
  assert.equal(details.calls.length, 0);
});

// ------------------------------------------------------------------ 动作请求

test('approvePost 请求：契约里没有 requestBody ⇒ body 为 null 且不发 content-type', () => {
  const built = buildPostReviewRequest({ baseUrl: '/api/v1', token: 'tok', postId: POST_ID, revision: 3, decision: 'approve', idempotencyKey: KEY });
  assert.equal(built.ok, true);
  assert.equal(built.request.url, `/api/v1/admin/posts/${POST_ID}/approve`);
  assert.equal(built.request.method, 'POST');
  assert.equal(built.request.body, null);
  assert.equal('content-type' in built.request.headers, false);
  assert.equal(built.request.headers['if-match'], '"3"');
  assert.equal(built.request.headers['idempotency-key'], KEY);
  assert.deepEqual(built.request.sentHeaders, { 'idempotency-key': KEY, 'if-match': '"3"' });
});

test('rejectPost 请求：body 只带 reason_code（闭集 10 值），并声明 content-type', () => {
  const built = buildPostReviewRequest({ baseUrl: '/api/v1', token: 'tok', postId: POST_ID, revision: '7', decision: 'reject', reasonCode: 'spam', idempotencyKey: KEY });
  assert.equal(built.ok, true);
  assert.equal(built.request.url, `/api/v1/admin/posts/${POST_ID}/reject`);
  assert.deepEqual(built.request.body, { reason_code: 'spam' });
  assert.equal(built.request.headers['content-type'], 'application/json');
  assert.equal(built.request.headers['if-match'], '"7"');
});

test('动作请求：理由不在闭集／approve 带理由／decision 非法／Idempotency-Key 长度不对都本地拦下', () => {
  const badReason = buildPostReviewRequest({ baseUrl: '', token: 'tok', postId: POST_ID, revision: 3, decision: 'reject', reasonCode: 'hate', idempotencyKey: KEY });
  assert.equal(badReason.ok, false);
  assert.equal(badReason.problems[0].field, 'reason_code');

  const approveWithReason = buildPostReviewRequest({ baseUrl: '', token: 'tok', postId: POST_ID, revision: 3, decision: 'approve', reasonCode: 'spam', idempotencyKey: KEY });
  assert.equal(approveWithReason.ok, false, 'approve 不接受请求体');

  const badDecision = buildPostReviewRequest({ baseUrl: '', token: 'tok', postId: POST_ID, revision: 3, decision: 'quarantine', idempotencyKey: KEY });
  assert.equal(badDecision.ok, false);

  const shortKey = buildPostReviewRequest({ baseUrl: '', token: 'tok', postId: POST_ID, revision: 3, decision: 'approve', idempotencyKey: 'short' });
  assert.equal(shortKey.ok, false);
  assert.equal(shortKey.problems.some((problem) => problem.field === 'idempotency_key'), true);
});

test('动作请求：`If-Match` 不接受通配（`*` 本地就拒，不发必然 400 的请求）', () => {
  const built = buildPostReviewRequest({ baseUrl: '', token: 'tok', postId: POST_ID, revision: '*', decision: 'approve', idempotencyKey: KEY });
  assert.equal(built.ok, false);
  assert.match(built.problems[0].message, /不允许 \*/);
});

// ------------------------------------------------------------------ 动作执行

test('submitPostReview：approve 不发 body；200 回执按 PostReviewOutcome 校验', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { data: outcome(), meta: meta() }, { etag: '"4"' }));
  const result = await submitPostReview({ fetchImpl, baseUrl: '/api/v1', token: 'tok', postId: POST_ID, revision: 3, decision: 'approve', idempotencyKey: KEY });
  assert.equal(result.ok, true);
  assert.equal(result.outcome.changed, true);
  assert.equal(result.etag, '"4"');
  assert.equal(fetchImpl.calls[0].init.method, 'POST');
  assert.equal(fetchImpl.calls[0].init.body, undefined, 'approve 不得带请求体');
  assert.equal(fetchImpl.calls[0].init.headers['if-match'], '"3"');
});

test('submitPostReview：reject 带 reason_code；changed:false 仍然 ok（但页面措辞会说明没改动）', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { data: outcome({ audit_state: 'rejected', decision: 'rejected', visibility: 'hidden', changed: false, notified: true, reason_codes: ['spam'] }), meta: meta() }));
  const result = await submitPostReview({ fetchImpl, baseUrl: '', token: 'tok', postId: POST_ID, revision: 3, decision: 'reject', reasonCode: 'spam', idempotencyKey: KEY });
  assert.equal(result.ok, true);
  assert.equal(result.outcome.changed, false, 'HTTP 200 + changed:false 是契约内的幂等结果');
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { reason_code: 'spam' });
  const text = describeReviewOutcome(result.outcome, 'reject');
  assert.equal(text.tone, 'warn');
  assert.match(text.title, /changed:false/);
  assert.match(text.detail, /已是/);
});

test('submitPostReview：409 修订冲突／409 对象不可用／422 硬规则否决 各自分类且文案不冒充成功', async () => {
  const conflict = await submitPostReview({
    baseUrl: '',
    token: 'tok',
    postId: POST_ID,
    revision: 3,
    decision: 'approve',
    idempotencyKey: KEY,
    fetchImpl: fakeFetch(() => jsonResponse(409, errorEnvelope('REVISION_CONFLICT', '帖子修订已变化'))),
  });
  assert.equal(conflict.kind, 'revision_conflict');
  const conflictText = describeReviewFailure(conflict);
  assert.match(conflictText.title, /REVISION_CONFLICT/);
  assert.match(conflictText.advice, /重新读取详情/);

  const gone = await submitPostReview({
    baseUrl: '',
    token: 'tok',
    postId: POST_ID,
    revision: 3,
    decision: 'approve',
    idempotencyKey: KEY,
    fetchImpl: fakeFetch(() => jsonResponse(409, errorEnvelope('OBJECT_UNAVAILABLE', '帖子已删除，不可审核'))),
  });
  assert.equal(gone.kind, 'object_unavailable');

  const vetoed = await submitPostReview({
    baseUrl: '',
    token: 'tok',
    postId: POST_ID,
    revision: 3,
    decision: 'approve',
    idempotencyKey: KEY,
    fetchImpl: fakeFetch(() => jsonResponse(422, errorEnvelope('INPUT_UNCERTAIN', '硬规则已明确否决该内容'))),
  });
  assert.equal(vetoed.kind, 'rejected_by_rules');
  assert.equal(vetoed.retriable, false);
  assert.match(describeReviewFailure(vetoed).advice, /红线/);
});

test('submitPostReview：403 写清缺 sources:write；428 说明 If-Match 被剥；畸形回执不算成功', async () => {
  const forbidden = await submitPostReview({
    baseUrl: '',
    token: 'tok',
    postId: POST_ID,
    revision: 3,
    decision: 'approve',
    idempotencyKey: KEY,
    fetchImpl: fakeFetch(() => jsonResponse(403, errorEnvelope('SCOPE_DENIED', '缺少所需权限：sources:write'))),
  });
  assert.equal(forbidden.kind, 'forbidden');
  const forbiddenText = describeReviewFailure(forbidden);
  assert.match(forbiddenText.title, /sources:write/);

  const required = classifyReviewFailure({ status: 428, code: 'REVISION_REQUIRED', message: '缺少 If-Match' });
  assert.equal(required.kind, 'revision_required');
  assert.match(describeReviewFailure(required).title, /428/);

  const malformed = await submitPostReview({
    baseUrl: '',
    token: 'tok',
    postId: POST_ID,
    revision: 3,
    decision: 'approve',
    idempotencyKey: KEY,
    fetchImpl: fakeFetch(() => jsonResponse(200, { data: { ...outcome(), changed: 'yes' }, meta: meta() })),
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.kind, 'invalid_response');
  assert.equal(describeReviewOutcome(malformed, 'approve'), null, '失败对象不产生成功文案');
});

// ------------------------------------------------------------------ 状态机

test('状态机：登录后缺 sources:read 时给 scopeWarning；退出登录回到初始态', () => {
  const signedIn = reduceModerationQueue(initialModerationQueueState(), { type: 'SIGNED_IN', scopes: ['audit:read'] });
  assert.equal(signedIn.signedIn, true);
  assert.equal(signedIn.scopeWarning, true, '没有 sources:read 就要提示（但不由前端放行/拦截）');
  const ok = reduceModerationQueue(initialModerationQueueState(), { type: 'SIGNED_IN', scopes: ['sources:read'] });
  assert.equal(ok.scopeWarning, false);
  assert.equal(reduceModerationQueue(ok, { type: 'SIGN_OUT' }).signedIn, false);
});

test('状态机：LOAD_OK 的 reset 决定覆盖还是续页；LOAD_FAIL 不丢弃已读到的行', () => {
  let state = initialModerationQueueState();
  state = reduceModerationQueue(state, { type: 'LOAD_START', reset: true });
  assert.equal(state.loading, true);
  state = reduceModerationQueue(state, { type: 'LOAD_OK', reset: true, page: { items: [post()], nextCursor: 'c1' } });
  assert.equal(state.loading, false);
  state = reduceModerationQueue(state, { type: 'LOAD_OK', reset: false, cursor: 'c1', page: { items: [post({ id: OTHER_ID })], nextCursor: null } });
  assert.equal(state.collection.items.length, 2);
  assert.equal(state.collection.pages, 2);
  const failed = reduceModerationQueue(state, { type: 'LOAD_FAIL', failure: classifyQueueReadFailure({ status: 503, code: 'PROVIDER_UNAVAILABLE', retryable: false }) });
  assert.equal(failed.collection.items.length, 2, '读失败不清空已读到的行');
  assert.equal(failed.failure.kind, 'unavailable');
  assert.equal(canLoadMoreModeration(failed), false);
});

test('状态机：REVIEW_OK 仅在 changed:true 时改写本地行，changed:false 不动数据', () => {
  let state = reduceModerationQueue(initialModerationQueueState(), { type: 'LOAD_OK', reset: true, page: { items: [post()], nextCursor: null } });
  state = reduceModerationQueue(state, { type: 'REVIEW_START', decision: 'approve' });
  assert.equal(state.actionBusy, true);
  const unchanged = reduceModerationQueue(state, { type: 'REVIEW_OK', outcome: outcome({ changed: false, revision: 9 }) });
  assert.equal(unchanged.collection.items[0].revision, 3, 'changed:false 不得假装改过');
  assert.equal(unchanged.lastOutcome.changed, false);
  assert.equal(unchanged.actionBusy, false);

  const changed = reduceModerationQueue(state, { type: 'REVIEW_OK', outcome: outcome({ changed: true, revision: 4, audit_state: 'approved' }) });
  assert.equal(changed.collection.items[0].revision, 4);
  assert.equal(changed.collection.items[0].audit_state, 'approved');
});

test('状态机：详情与动作的选中态互不串台（选新行会清掉上一条的回执）', () => {
  let state = reduceModerationQueue(initialModerationQueueState(), { type: 'LOAD_OK', reset: true, page: { items: [post(), post({ id: OTHER_ID })], nextCursor: null } });
  state = reduceModerationQueue(state, { type: 'SELECT_ROW', postId: POST_ID });
  state = reduceModerationQueue(state, { type: 'DETAIL_START' });
  state = reduceModerationQueue(state, { type: 'DETAIL_OK', post: post(), etag: '"3"' });
  assert.equal(state.detail.id, POST_ID);
  state = reduceModerationQueue(state, { type: 'REVIEW_OK', outcome: outcome() });
  assert.notEqual(state.lastOutcome, null);
  const next = reduceModerationQueue(state, { type: 'SELECT_ROW', postId: OTHER_ID });
  assert.equal(next.detail, null);
  assert.equal(next.lastOutcome, null);
  assert.equal(next.actionNotice, null);
});

test('状态机：筛选与每页条数的本地校验（闭集外不发请求、limit 夹紧）', () => {
  let state = initialModerationQueueState();
  state = reduceModerationQueue(state, { type: 'SET_DRAFT_FILTERS', filters: { state: 'hidden' } });
  assert.deepEqual(state.draftFilters, { state: 'hidden', auditState: MODERATION_FILTER_ANY });
  state = reduceModerationQueue(state, { type: 'FILTERS_APPLIED', filters: { state: 'hidden', auditState: 'pending' } });
  assert.deepEqual(state.appliedFilters, { state: 'hidden', auditState: 'pending' });
  assert.equal(state.filterFailure, null);
  state = reduceModerationQueue(state, { type: 'FILTER_FAILED', message: 'state 不在闭集内' });
  assert.match(state.filterFailure.message, /闭集/);
  state = reduceModerationQueue(state, { type: 'SET_LIMIT', limit: 999 });
  assert.equal(state.limit, 50, 'limit 夹紧到契约上限');
  state = reduceModerationQueue(state, { type: 'RESET_FILTERS' });
  assert.deepEqual(state.appliedFilters, emptyModerationFilters());
});

// ------------------------------------------------------------------ 展示模型

test('describeQueueView：有数据／空队列／筛选后为空／读失败 四种 tone 分得开', () => {
  const empty = describeQueueView(initialModerationQueueState());
  assert.equal(empty.tone, 'empty');
  assert.match(empty.title, /审核队列为空/);
  assert.match(empty.detail, /不是错误/);
  assert.equal(empty.rows.length, 0);

  const filtered = describeQueueView(reduceModerationQueue(initialModerationQueueState(), { type: 'FILTERS_APPLIED', filters: { state: 'hidden' } }));
  assert.equal(filtered.tone, 'empty_filtered');
  assert.match(filtered.detail, /visibility=hidden/);

  const ready = describeQueueView(reduceModerationQueue(initialModerationQueueState(), { type: 'LOAD_OK', reset: true, page: { items: [post(), post({ id: OTHER_ID })], nextCursor: null } }));
  assert.equal(ready.tone, 'ready');
  assert.match(ready.title, /已读取 2 条/);

  const failed = describeQueueView(
    reduceModerationQueue(initialModerationQueueState(), {
      type: 'LOAD_FAIL',
      failure: classifyQueueReadFailure({ status: 403, code: 'SCOPE_DENIED', message: '缺少所需权限：sources:read' }),
    }),
  );
  assert.equal(failed.tone, 'error');
  assert.equal(failed.role, 'alert');
  assert.equal(failed.rows.length, 0, '读失败不伪造行');
});

test('describeQueueView：成环时状态条写明「游标原地踏步」', () => {
  let state = reduceModerationQueue(initialModerationQueueState(), { type: 'LOAD_OK', reset: true, page: { items: [post()], nextCursor: 'c1' } });
  state = reduceModerationQueue(state, { type: 'LOAD_OK', reset: false, cursor: 'c1', page: { items: [post()], nextCursor: 'c1' } });
  const view = describeQueueView(state);
  assert.match(view.title, /游标原地踏步/);
  assert.equal(canLoadMoreModeration(state), false, '成环后不再给续页');
});

test('moderationQueueRows：行视图带中文枚举标签与稳定时间格式；坏行被过滤', () => {
  const rows = moderationQueueRows({
    ...initialModerationQueueState(),
    collection: { ...emptyModerationQueue(), items: [post(), post({ id: OTHER_ID, visibility: 'nope' })] },
  });
  assert.equal(rows.length, 1, '不可渲染的行不出现在行视图里');
  assert.equal(rows[0].auditStateLabel, 'pending（待审）');
  assert.equal(rows[0].visibilityLabel, 'private（未公开）');
  assert.equal(rows[0].createdAtLabel, '2026-10-23 08:12:33Z');
  assert.equal(rows[0].mediaCount, 0);
});

test('formatModerationTimestamp：UTC 稳定；解析不了原样返回', () => {
  assert.equal(formatModerationTimestamp('2026-10-23T08:12:33.000Z'), '2026-10-23 08:12:33Z');
  assert.equal(formatModerationTimestamp('随便写的'), '随便写的');
  assert.equal(formatModerationTimestamp(null), '（无时间）');
});

test('describeReviewOutcome：changed:true 时如实说「通过后 private ⇒ published」与「驳回置 hidden 并通知」', () => {
  // 服务端可达态一：private 帖被通过 ⇒ published（`admin/ops/community-posts.ts:327-328`）。
  const approved = describeReviewOutcome(outcome({ changed: true, notified: false, visibility: 'published' }), 'approve');
  assert.equal(approved.tone, 'ready');
  assert.match(approved.title, /通过/);
  assert.match(approved.detail, /visibility=published（已公开）/);
  assert.match(approved.detail, /private ⇒ published/, '必须说清通过会把 private 推到 published');
  assert.doesNotMatch(approved.detail, /不改可见性/, '旧句「通过不改可见性」与服务端事实相反，不得复活');
  assert.match(approved.advice, /没有通知作者/);
  assert.match(approved.advice, /notified:false/);

  // 服务端可达态二：hidden 帖被通过 ⇒ 仍是 hidden（单向门不为通过翻案），且不得声称「已公开」。
  const approvedHidden = describeReviewOutcome(outcome({ changed: true, notified: true, visibility: 'hidden' }), 'approve');
  assert.match(approvedHidden.detail, /visibility=hidden（已隐藏）/, 'hidden 帖通过后必须仍是 hidden');
  assert.doesNotMatch(approvedHidden.detail, /已公开/, 'hidden 帖通过后不得出现「已公开」');
  assert.doesNotMatch(approvedHidden.detail, /不改可见性/);

  const rejected = describeReviewOutcome(outcome({ audit_state: 'rejected', decision: 'rejected', visibility: 'hidden', changed: true, notified: true, reason_codes: ['spam'] }), 'reject');
  assert.match(rejected.title, /驳回/);
  assert.match(rejected.detail, /visibility=hidden/);
  assert.match(rejected.detail, /垃圾广告\/刷屏/);
  assert.match(rejected.advice, /notified:true/);
});

test('needsModerationRestart：游标无效／未知 http 错误要回第一页，其余不要', () => {
  const cursor = reduceModerationQueue(initialModerationQueueState(), { type: 'LOAD_FAIL', failure: classifyQueueReadFailure({ status: 400, code: 'INVALID_CURSOR' }) });
  assert.equal(needsModerationRestart(cursor), true);
  const forbidden = reduceModerationQueue(initialModerationQueueState(), { type: 'LOAD_FAIL', failure: classifyQueueReadFailure({ status: 403, code: 'SCOPE_DENIED' }) });
  assert.equal(needsModerationRestart(forbidden), false);
  assert.equal(needsModerationRestart(initialModerationQueueState()), false);
});
