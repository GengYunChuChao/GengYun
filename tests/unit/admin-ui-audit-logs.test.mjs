/**
 * R60 · 「审计总台账（只读）」前端读面的**单元测试**（纯逻辑，不渲染）。
 *
 * 钉住的事：
 * 1. 参数名照抄契约：`entity`（⛔ 不是 `entity_type`）、`action` 四项闭集、`from`/`to` RFC 3339；
 * 2. 换筛选必须回第一页（游标与 [from,to,action,entity] 绑定，否则后端 INVALID_CURSOR）；
 * 3. 403 与「空台账」是两种状态——无权限不得被渲染成 0 条；
 * 4. 失败态分类只用品格内的 ErrorCode，不自造错误码。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AUDIT_LOG_ACTIONS,
  AUDIT_LOG_ENTITIES,
  AUDIT_LOGS_PATH,
  AUDIT_LOGS_SCOPE,
  appendAuditLogPage,
  auditLogRowView,
  buildAuditLogsUrl,
  canLoadMoreAuditLogs,
  describeAuditLogFilters,
  describeAuditLogTarget,
  describeAuditLogView,
  emptyAuditLogCollection,
  fetchAuditLogsPage,
  formatAuditLogTimestamp,
  hasActiveAuditLogFilters,
  initialAuditLogState,
  readAuditLogsResponse,
  reduceAuditLog,
  validateAuditLogFilters,
  validateAuditLogPage,
} from '../../apps/admin/src/lib/admin-audit-logs.mjs';

const UUID_A = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
const UUID_B = '2c5f39cb-3fb2-22e3-9940-1127e4ddb538';

function jsonResponse(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body };
}

function page(items, nextCursor = null) {
  return {
    data: { items, next_cursor: nextCursor },
    meta: { request_id: UUID_A, contract_version: '1.0.0', execution_mode: 'real' },
  };
}

function event(overrides = {}) {
  return {
    id: UUID_B,
    action: 'set_flag',
    scope: 'flags:write',
    target_ref: { type: 'job', id: 'job-1', revision: 3 },
    reason_code: 'manual',
    request_id: UUID_A,
    result: 'accepted',
    created_at: '2026-10-23T00:00:00.000Z',
    actor: null,
    target_hint: null,
    before_value: null,
    after_value: null,
    ...overrides,
  };
}

test('契约形状：路径/scope/闭集与后端 catalog 逐字一致；⛔ 没有 entity_type', () => {
  assert.equal(AUDIT_LOGS_PATH, '/admin/audit-logs');
  assert.equal(AUDIT_LOGS_SCOPE, 'audit:read');
  assert.deepEqual([...AUDIT_LOG_ACTIONS], [
    'account.suspend',
    'account.restore',
    'set_flag',
    'job.cancel',
    'admin_scope.grant',
    'admin_scope.revoke',
    'admin_scope.deny',
  ]);
  assert.deepEqual([...AUDIT_LOG_ENTITIES], ['account', 'flag', 'job', 'admin_scope']);
  assert.equal(AUDIT_LOG_ACTIONS.includes('entity_type'), false);
});

test('URL：limit 总是带；筛选用 entity（不是 entity_type）；all 不下传', () => {
  const plain = buildAuditLogsUrl('/api/v1', { limit: 20 });
  assert.equal(plain, '/api/v1/admin/audit-logs?limit=20');

  const filtered = buildAuditLogsUrl('/api/v1/', {
    limit: 50,
    filters: { action: 'set_flag', entity: 'flag', from: '2026-10-23T00:00:00Z', to: '2026-10-24T00:00:00Z' },
  });
  const url = new URL(filtered, 'http://x');
  assert.equal(url.pathname, '/api/v1/admin/audit-logs');
  assert.equal(url.searchParams.get('limit'), '50');
  assert.equal(url.searchParams.get('action'), 'set_flag');
  assert.equal(url.searchParams.get('entity'), 'flag');
  assert.equal(url.searchParams.get('from'), '2026-10-23T00:00:00Z');
  assert.equal(url.searchParams.get('to'), '2026-10-24T00:00:00Z');
  assert.equal(url.searchParams.has('entity_type'), false, '契约没有 entity_type，不得自己造');

  const all = buildAuditLogsUrl('/api/v1', { limit: 20, filters: { action: 'all', entity: 'all', from: '  ', to: '' } });
  const allUrl = new URL(all, 'http://x');
  assert.equal(allUrl.searchParams.has('action'), false);
  assert.equal(allUrl.searchParams.has('entity'), false);
  assert.equal(allUrl.searchParams.has('from'), false);
  assert.equal(allUrl.searchParams.has('to'), false);
});

test('URL：limit 越界被夹回 1..50；超长游标抛 RangeError', () => {
  assert.match(buildAuditLogsUrl('/api/v1', { limit: 500 }), /limit=50/);
  assert.match(buildAuditLogsUrl('/api/v1', { limit: 0 }), /limit=1/);
  assert.match(buildAuditLogsUrl('/api/v1', { limit: Number.NaN }), /limit=20/u);
  assert.throws(() => buildAuditLogsUrl('/api/v1', { cursor: 'x'.repeat(2049) }), /游标超过 2048 字符/u);
});

test('筛选校验：非法时间/闭集外 action/entity/from>to 都在出网前被挡下', () => {
  assert.equal(validateAuditLogFilters({}).ok, true);

  const noZone = validateAuditLogFilters({ from: '2026-10-23 00:00:00' });
  assert.equal(noZone.ok, false);
  assert.equal(noZone.errors[0].field, 'from');
  assert.match(noZone.errors[0].message, /RFC 3339/u);

  const badAction = validateAuditLogFilters({ action: 'post.hide' });
  assert.equal(badAction.ok, false);
  assert.equal(badAction.errors[0].field, 'action');
  assert.equal(badAction.errors[0].code, 'enum');

  const badEntity = validateAuditLogFilters({ entity: 'entity_type' });
  assert.equal(badEntity.ok, false);
  assert.equal(badEntity.errors[0].field, 'entity');

  const reversed = validateAuditLogFilters({ from: '2026-10-24T00:00:00Z', to: '2026-10-23T00:00:00Z' });
  assert.equal(reversed.ok, false);
  assert.equal(reversed.errors[0].code, 'order');

  const good = validateAuditLogFilters({ from: '2026-10-23T00:00:00Z', to: '2026-10-24T00:00:00+08:00', action: 'job.cancel', entity: 'job' });
  assert.equal(good.ok, true);
  assert.deepEqual(good.filters, { from: '2026-10-23T00:00:00Z', to: '2026-10-24T00:00:00+08:00', action: 'job.cancel', entity: 'job' });
});

test('筛选白名单：契约外的字段不进下传形态', () => {
  const checked = validateAuditLogFilters({ action: 'set_flag', entity_type: 'flag', foo: 'bar' });
  assert.equal(checked.ok, true);
  assert.deepEqual(Object.keys(checked.filters).sort(), ['action', 'entity', 'from', 'to']);
  assert.equal('entity_type' in checked.filters, false);
});

test('筛选描述与「是否带筛选」', () => {
  assert.equal(describeAuditLogFilters({}), '无筛选（全部事件）');
  assert.equal(
    describeAuditLogFilters({ action: 'set_flag', entity: 'flag', from: '2026-10-23T00:00:00Z' }),
    'action=set_flag · entity=flag · from=2026-10-23T00:00:00Z',
  );
  assert.equal(hasActiveAuditLogFilters({ action: 'all', entity: 'all' }), false);
  assert.equal(hasActiveAuditLogFilters({ action: 'set_flag' }), true);
});

test('响应读取：2xx 正常页 / 非 JSON / 缺信封 / 形状不符', async () => {
  const ok = await readAuditLogsResponse(jsonResponse(200, page([event()])));
  assert.equal(ok.ok, true);
  assert.equal(ok.page.items.length, 1);
  assert.equal(ok.page.nextCursor, null);

  const notJson = await readAuditLogsResponse({ ok: true, status: 200, json: async () => { throw new Error('boom'); } });
  assert.equal(notJson.kind, 'invalid_response');
  assert.match(notJson.message, /不是合法 JSON/u);

  const noEnvelope = await readAuditLogsResponse(jsonResponse(200, { data: { items: [], next_cursor: null } }));
  assert.equal(noEnvelope.kind, 'invalid_response');
  assert.match(noEnvelope.message, /信封/u);

  const badShape = await readAuditLogsResponse(jsonResponse(200, page([{ id: 'not-a-uuid' }])));
  assert.equal(badShape.kind, 'invalid_response');
  assert.match(badShape.message, /AuditEventPage/u);
});

test('响应读取：403 SCOPE_DENIED ⇒ forbidden（不是空台账）', async () => {
  const result = await readAuditLogsResponse(
    jsonResponse(403, {
      error: { code: 'SCOPE_DENIED', message: '缺少 audit:read' },
      meta: { request_id: UUID_A, contract_version: '1.0.0', execution_mode: 'real' },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'forbidden');
  assert.equal(result.status, 403);
  assert.equal(result.code, 'SCOPE_DENIED');
  assert.equal(result.serverRetryable, false);

  const view = describeAuditLogView({ ...initialAuditLogState(), signedIn: true, phase: 'error', failure: result });
  assert.notEqual(view.tone, 'empty', '403 不得被渲染成空台账');
  assert.match(view.title, /权限不足/u);
  assert.match(view.title, /audit:read/u);
  assert.equal(view.errorCode, 'SCOPE_DENIED（契约内错误码）');
});

test('响应读取：401 / 400 INVALID_CURSOR / 其它 400 / 429 / 503 分类', async () => {
  const signedOut = await readAuditLogsResponse(jsonResponse(401, { error: { code: 'SESSION_REQUIRED' } }));
  assert.equal(signedOut.kind, 'signed_out');

  const expiredCursor = await readAuditLogsResponse(jsonResponse(400, { error: { code: 'INVALID_CURSOR', message: '筛选条件已变化，请从第一页重新开始' } }));
  assert.equal(expiredCursor.kind, 'invalid_cursor');
  assert.match(describeAuditLogView({ ...initialAuditLogState(), signedIn: true, phase: 'error', failure: expiredCursor }).detail, /第一页/u);

  const badRequest = await readAuditLogsResponse(jsonResponse(400, { error: { code: 'INVALID_REQUEST', message: 'action 必须是闭集之一' } }));
  assert.equal(badRequest.kind, 'invalid_request');
  assert.match(badRequest.message, /闭集/u);

  const limited = await readAuditLogsResponse(jsonResponse(429, { error: { code: 'RATE_LIMITED' } }, { 'retry-after': '7' }));
  assert.equal(limited.kind, 'rate_limited');
  assert.equal(limited.retryAfterSeconds, 7);

  const unavailable = await readAuditLogsResponse(
    jsonResponse(503, { error: { code: 'PROVIDER_UNAVAILABLE', message: '审计日志读取尚未接线', retryable: false } }),
  );
  assert.equal(unavailable.kind, 'unavailable');
  assert.equal(unavailable.serverRetryable, false, 'retryable 必须是服务端声明，不能本地猜');
  const unavailableView = describeAuditLogView({ ...initialAuditLogState(), signedIn: true, phase: 'error', failure: unavailable });
  assert.match(unavailableView.detail, /503/u);
  assert.equal(unavailableView.canRetry, false, '服务端声明 retryable:false ⇒ 不给重试按钮');
  assert.doesNotMatch(unavailableView.detail, /稍后重试/u, '不可重试时不得许诺「稍后重试」');

  // 信封缺失（反代吐 HTML 之类）⇒ 服务端没声明 ⇒ 按不可重试处理
  const noEnvelope = await readAuditLogsResponse(jsonResponse(503, null));
  assert.equal(noEnvelope.kind, 'unavailable');
  assert.equal(noEnvelope.serverRetryable, false);
  assert.equal(describeAuditLogView({ ...initialAuditLogState(), signedIn: true, phase: 'error', failure: noEnvelope }).canRetry, false);

  // 只有服务端明说 retryable:true 才给重试
  const retryable = await readAuditLogsResponse(
    jsonResponse(503, { error: { code: 'PROVIDER_UNAVAILABLE', message: '暂时过载', retryable: true } }),
  );
  assert.equal(retryable.serverRetryable, true);
  const retryableView = describeAuditLogView({ ...initialAuditLogState(), signedIn: true, phase: 'error', failure: retryable });
  assert.equal(retryableView.canRetry, true);
  assert.match(retryableView.detail, /稍后重试/u);

  // 网络层失败根本没有响应可读 ⇒ 可重试性由本地闭集决定（network_error 才允许重试）
  const offline = describeAuditLogView({
    ...initialAuditLogState(),
    signedIn: true,
    phase: 'error',
    failure: { ok: false, kind: 'network_error', serverRetryable: null, status: null, message: '' },
  });
  assert.equal(offline.canRetry, true);
});

test('fetchAuditLogsPage：只发 GET、带 Bearer、不带 Idempotency-Key', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(200, page([event()]));
  };
  const result = await fetchAuditLogsPage({ fetchImpl, baseUrl: '/api/v1', token: 'tok-1', limit: 20, filters: { entity: 'job' } });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok-1');
  assert.equal('Idempotency-Key' in calls[0].init.headers, false, '读面不带幂等键');
  assert.match(calls[0].url, /\/admin\/audit-logs\?limit=20&entity=job$/u);
});

test('fetchAuditLogsPage：无令牌 ⇒ signed_out；无 fetch ⇒ network_error；网络异常 ⇒ network_error', async () => {
  assert.equal((await fetchAuditLogsPage({ baseUrl: '/api/v1', token: '', fetchImpl: async () => jsonResponse(200, page([])) })).kind, 'signed_out');

  const boom = await fetchAuditLogsPage({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
    baseUrl: '/api/v1',
    token: 'tok',
  });
  assert.equal(boom.kind, 'network_error');
  assert.match(boom.message, /ECONNREFUSED/u);
});

test('分页：按 id 去重；next_cursor 回到同一游标 ⇒ 判成环并掐断', () => {
  const first = appendAuditLogPage(emptyAuditLogCollection(), { cursor: null, page: { items: [event({ id: UUID_A })], nextCursor: 'c1', warnings: 0 } });
  assert.equal(first.items.length, 1);
  assert.equal(first.nextCursor, 'c1');

  const second = appendAuditLogPage(first, { cursor: 'c1', page: { items: [event({ id: UUID_A }), event({ id: UUID_B })], nextCursor: 'c1', warnings: 0 } });
  assert.equal(second.items.length, 2, '重复 id 不重复入列');
  assert.equal(second.duplicates, 1);
  assert.equal(second.nextCursor, null, '游标原地踏步 ⇒ 掐断分页，不无限翻');
  assert.equal(second.cycle, true);
});

test('reducer：登录 → 读一页 → ready；空数组 → empty；失败保数据 → stale', () => {
  let state = reduceAuditLog(initialAuditLogState(), { type: 'SIGNED_IN', scopes: ['audit:read'] });
  assert.equal(state.signedIn, true);
  assert.equal(state.scopeWarning, false);
  assert.equal(state.phase, 'loading');

  state = reduceAuditLog(state, { type: 'LOAD_START', reset: true });
  assert.equal(state.phase, 'loading');

  state = reduceAuditLog(state, { type: 'LOAD_OK', cursor: null, page: { items: [event()], nextCursor: 'c1', warnings: 0 } });
  assert.equal(state.phase, 'ready');
  assert.equal(state.collection.items.length, 1);
  const ready = describeAuditLogView(state);
  assert.equal(ready.tone, 'ready');
  assert.equal(ready.total, 1);
  assert.match(ready.title, /已读取 1 条/u);
  assert.equal(canLoadMoreAuditLogs(state), true);

  const failed = reduceAuditLog(state, { type: 'LOAD_FAIL', failure: { ok: false, kind: 'unavailable', serverRetryable: true, status: 503, code: 'PROVIDER_UNAVAILABLE', message: '' } });
  assert.equal(failed.phase, 'ready');
  assert.equal(failed.stale, true);
  assert.equal(failed.collection.items.length, 1, '失败不清空已读数据');
  assert.equal(describeAuditLogView(failed).tone, 'stale');

  const empty = reduceAuditLog(reduceAuditLog(initialAuditLogState(), { type: 'SIGNED_IN', scopes: ['audit:read'] }), {
    type: 'LOAD_OK',
    cursor: null,
    page: { items: [], nextCursor: null, warnings: 0 },
  });
  assert.equal(empty.phase, 'empty');
  const emptyView = describeAuditLogView(empty);
  assert.equal(emptyView.tone, 'empty');
  assert.match(emptyView.detail, /空台账/u);
  assert.equal(canLoadMoreAuditLogs(empty), false);
});

test('reducer：缺 scope ⇒ scopeWarning；带筛选的空页说「筛选下没有事件」', () => {
  const warned = reduceAuditLog(initialAuditLogState(), { type: 'SIGNED_IN', scopes: ['flags:read'] });
  assert.equal(warned.scopeWarning, true);

  let state = reduceAuditLog(initialAuditLogState(), { type: 'SIGNED_IN', scopes: ['audit:read'] });
  state = reduceAuditLog(state, { type: 'SET_DRAFT_FILTER', field: 'action', value: 'set_flag' });
  state = reduceAuditLog(state, { type: 'FILTERS_APPLIED' });
  assert.equal(state.applied.action, 'set_flag');
  assert.equal(state.filterFailure, null);
  state = reduceAuditLog(state, { type: 'LOAD_OK', cursor: null, page: { items: [], nextCursor: null, warnings: 0 } });
  const view = describeAuditLogView(state);
  assert.equal(view.tone, 'empty_filtered');
  assert.match(view.detail, /set_flag/u);
  assert.equal(view.filtered, true);
});

test('reducer：筛选不合法 ⇒ FILTERS_APPLIED 不改 applied、给 filterFailure（不出网）', () => {
  let state = reduceAuditLog(initialAuditLogState(), { type: 'SIGNED_IN', scopes: ['audit:read'] });
  state = reduceAuditLog(state, { type: 'SET_DRAFT_FILTER', field: 'from', value: '2026-10-23' });
  state = reduceAuditLog(state, { type: 'FILTERS_APPLIED' });
  assert.notEqual(state.filterFailure, null);
  assert.equal(state.filterFailure.kind, 'invalid_filter');
  assert.match(state.filterFailure.message, /RFC 3339/u);
  assert.equal(state.applied.from, '', '不合法筛选不得被当成生效筛选');
  assert.equal(state.applied.action, 'all', '不合法筛选整批不生效（applied 保持原样）');
});

test('reducer：应用筛选清空已读页（换筛选必须回第一页）', () => {
  let state = reduceAuditLog(initialAuditLogState(), { type: 'SIGNED_IN', scopes: ['audit:read'] });
  state = reduceAuditLog(state, { type: 'LOAD_OK', cursor: null, page: { items: [event()], nextCursor: 'c1', warnings: 0 } });
  state = reduceAuditLog(state, { type: 'SET_DRAFT_FILTER', field: 'entity', value: 'job' });
  state = reduceAuditLog(state, { type: 'FILTERS_APPLIED' });
  assert.equal(state.collection.items.length, 0);
  assert.equal(state.collection.nextCursor, null);
  assert.equal(state.phase, 'loading');
  assert.equal(state.applied.entity, 'job');
});

test('LIMIT 只能落在契约区间；初始状态是「未登录」', () => {
  const state = reduceAuditLog(initialAuditLogState(), { type: 'SET_LIMIT', limit: 999 });
  assert.equal(state.limit, 50);
  assert.equal(reduceAuditLog(initialAuditLogState(), { type: 'SET_LIMIT', limit: 0 }).limit, 1);
  assert.equal(initialAuditLogState().phase, 'signed_out');
  assert.equal(describeAuditLogView(initialAuditLogState()).tone, 'signed_out');
});

test('行视图：时间按 UTC 稳定渲染；target_ref 形如 type:id@revision', () => {
  assert.equal(formatAuditLogTimestamp('2026-10-23T08:12:33.123Z'), '2026-10-23 08:12:33Z');
  assert.equal(formatAuditLogTimestamp('2026-10-23T16:12:33+08:00'), '2026-10-23 08:12:33Z');
  assert.equal(formatAuditLogTimestamp('nope'), 'nope');
  assert.equal(formatAuditLogTimestamp(null), '—');

  assert.equal(describeAuditLogTarget({ type: 'job', id: 'j-1', revision: 4 }), 'job:j-1@r4');
  assert.equal(describeAuditLogTarget(null), '（无目标引用）');

  const row = auditLogRowView(event({ result: 'denied' }));
  assert.equal(row.actionLabel, '改功能开关');
  assert.equal(row.resultLabel, '已拒绝');
  assert.equal(row.targetText, 'job:job-1@r3');
  assert.equal(row.trail.length, 6);
});

test('页面校验复用收件箱那份：items/next_cursor 的形状即 AuditEventPage', () => {
  assert.equal(validateAuditLogPage(page([event()]).data).ok, true);
  assert.equal(validateAuditLogPage({ items: [], next_cursor: 42 }).ok, false);
});
