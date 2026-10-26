/**
 * R60 · 「管理员权限读面」前端读面的**单元测试**（纯逻辑，不渲染）。
 *
 * 钉住的事：
 * 1. 两个 operation 都是 `scopes:read`，路径/参数照抄契约（列表只有 `cursor` / `limit`）；
 * 2. `id` 是 `admin_accounts.id`（uuid），⛔ 不是 `users.id`、也**没有** `displayName` 字段；
 * 3. scopes 视图只有 scope 字符串，⛔ 不含 `granted_by` / `granted_at`（多出来就是契约外字段）；
 * 4. 403 / 404 / 空目录三种状态互不冒充——无权不得渲染成 0 个管理员。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ADMINISTRATOR_SCOPES_OPERATION_ID,
  ADMINISTRATORS_OPERATION_ID,
  ADMINISTRATORS_PATH,
  ADMINISTRATORS_SCOPE,
  ADMIN_SCOPES,
  administratorRows,
  administratorRowView,
  administratorScopesView,
  buildAdministratorsUrl,
  buildAdministratorScopesUrl,
  canLoadMoreAdministrators,
  describeAdministratorsView,
  describeAdministratorScopesView,
  emptyAdministratorCollection,
  fetchAdministratorScopes,
  fetchAdministratorsPage,
  initialAdministratorsState,
  readAdministratorsResponse,
  readAdministratorScopesResponse,
  reduceAdministrators,
  validateAdministratorPage,
  validateAdministratorScopesView,
  validateAdministratorView,
} from '../../apps/admin/src/lib/admin-administrators.mjs';

const ADMIN_ID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
const ADMIN_ID_2 = '2c5f39cb-3fb2-22e3-9940-1127e4ddb538';
const USER_ID = '3d6a4adc-4ac3-33f4-8a51-2238f5eec649';
const REQUEST_ID = '4e7b5bed-5bd4-4405-9b62-334906ffd75a';

function jsonResponse(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body };
}

function meta() {
  return { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'real' };
}

function page(items, nextCursor = null) {
  return { data: { items, next_cursor: nextCursor }, meta: meta() };
}

function administrator(overrides = {}) {
  return { id: ADMIN_ID, login_name: 'root', state: 'active', scopes: ['audit:read', 'scopes:read'], ...overrides };
}

test('契约形状：两条读面都是 scopes:read；闭集 13 项', () => {
  assert.equal(ADMINISTRATORS_PATH, '/admin/administrators');
  assert.equal(ADMINISTRATORS_SCOPE, 'scopes:read');
  assert.equal(ADMINISTRATORS_OPERATION_ID, 'listAdministrators');
  assert.equal(ADMINISTRATOR_SCOPES_OPERATION_ID, 'listAdministratorScopes');
  assert.deepEqual(
    [...ADMIN_SCOPES],
    [
      'accounts:read',
      'accounts:suspend',
      'audit:read',
      'flags:read',
      'flags:write',
      'jobs:cancel',
      'jobs:read',
      'scopes:read',
      'scopes:write',
      'session:logout',
      'session:read',
      'sources:read',
      'sources:write',
    ],
  );
  assert.equal(ADMIN_SCOPES.includes('user'), false, 'user/public/receipt 都不是可授予权限');
  assert.equal(ADMIN_SCOPES.includes('receipt'), false);
});

test('校验一项管理员：id 必须是 uuid、login_name 1..80、state 闭集、scopes 数组', () => {
  const ok = validateAdministratorView(administrator());
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.item.login_name, 'root');

  assert.equal(validateAdministratorView(administrator({ id: USER_ID.replace('3d6a', 'zz') })).ok, false);
  assert.equal(validateAdministratorView(administrator({ id: 'users-1' })).ok, false, 'id 必须是 uuid（admin_accounts.id）');
  assert.equal(validateAdministratorView(administrator({ login_name: '' })).ok, false);
  assert.equal(validateAdministratorView(administrator({ login_name: 'x'.repeat(81) })).ok, false);
  assert.equal(validateAdministratorView(administrator({ state: 'deleted' })).ok, false);
  assert.equal(validateAdministratorView(administrator({ scopes: 'audit:read' })).ok, false);
  assert.equal(validateAdministratorView(null).ok, false);
});

test('契约里没有 displayName：多出来只记警告，不当成必需字段', () => {
  const checked = validateAdministratorView(administrator({ displayName: '超级管理员' }));
  assert.equal(checked.ok, true, 'displayName 不是必需字段，缺了不报错、多了只警告');
  assert.match(checked.warnings.join('\n'), /displayName/u);
  assert.match(checked.warnings.join('\n'), /契约外字段/u);
  // 缺 displayName 的「标准形状」必须干净通过
  assert.deepEqual(validateAdministratorView(administrator()).warnings, []);
});

test('闭集外 scope 只警告（如实展示），不当作形状错误', () => {
  const checked = validateAdministratorView(administrator({ scopes: ['audit:read', 'root:everything'] }));
  assert.equal(checked.ok, true);
  assert.match(checked.warnings.join('\n'), /root:everything/u);
  assert.match(checked.warnings.join('\n'), /不在 AdminScope 闭集/u);
});

test('校验分页：items 数组 + next_cursor 为 null 或 1..2048 字符串', () => {
  const ok = validateAdministratorPage({ items: [administrator()], next_cursor: 'c1' });
  assert.equal(ok.ok, true);
  assert.equal(ok.items.length, 1);
  assert.equal(ok.nextCursor, 'c1');

  assert.equal(validateAdministratorPage({ items: [administrator()], next_cursor: 42 }).ok, false);
  assert.equal(validateAdministratorPage({ items: 'nope', next_cursor: null }).ok, false);
  assert.equal(validateAdministratorPage({ items: [administrator()], next_cursor: 'x'.repeat(2049) }).ok, false);

  const many = Array.from({ length: 51 }, (_, index) => administrator({ id: ADMIN_ID, login_name: `admin-${index}` }));
  const warned = validateAdministratorPage({ items: many, next_cursor: null });
  assert.equal(warned.ok, true);
  assert.match(warned.warnings.join('\n'), /50/u);

  const bad = validateAdministratorPage({ items: [administrator({ state: 'gone' }), administrator({ id: ADMIN_ID_2 })], next_cursor: null });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /^\$\.items\[0\]/u);
  assert.equal(bad.items.length, 1, '坏行的好邻居仍然入列');
});

test('scopes 视图：只含 scope 字符串，granted_by/granted_at 是契约外字段', () => {
  const ok = validateAdministratorScopesView({ scopes: ['audit:read', 'scopes:read'] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.scopes, ['audit:read', 'scopes:read']);
  assert.deepEqual(ok.warnings, []);

  const extra = validateAdministratorScopesView({ scopes: ['audit:read'], granted_by: ADMIN_ID_2, granted_at: '2026-10-23T00:00:00Z' });
  assert.equal(extra.ok, true);
  assert.match(extra.warnings.join('\n'), /granted_by/u);
  assert.match(extra.warnings.join('\n'), /granted_at/u);
  assert.match(extra.warnings.join('\n'), /契约外字段/u);

  assert.equal(validateAdministratorScopesView({ scopes: ['audit:read', 42] }).ok, false);
  assert.equal(validateAdministratorScopesView({}).ok, false);
});

test('URL：列表 limit 总是带、cursor 按需；scopes 走 {id}/scopes 且 id 必须 uuid', () => {
  assert.equal(buildAdministratorsUrl('/api/v1', { limit: 20 }), '/api/v1/admin/administrators?limit=20');
  assert.equal(buildAdministratorsUrl('/api/v1/', { limit: 50, cursor: 'c1' }), '/api/v1/admin/administrators?limit=50&cursor=c1');
  assert.match(buildAdministratorsUrl('/api/v1', { limit: 999 }), /limit=50/u);
  assert.match(buildAdministratorsUrl('/api/v1', { limit: -1 }), /limit=1/u);

  assert.equal(buildAdministratorScopesUrl('/api/v1', ADMIN_ID), `/api/v1/admin/administrators/${ADMIN_ID}/scopes`);
  assert.throws(() => buildAdministratorScopesUrl('/api/v1', 'root'), /admin_accounts\.id/u);
  assert.throws(() => buildAdministratorScopesUrl('/api/v1', ''), RangeError);
});

test('响应读取：2xx 正常页 / 非 JSON / 缺信封 / 形状不符', async () => {
  const ok = await readAdministratorsResponse(jsonResponse(200, page([administrator()])));
  assert.equal(ok.ok, true);
  assert.equal(ok.page.items.length, 1);
  assert.equal(ok.page.nextCursor, null);

  const notJson = await readAdministratorsResponse({ ok: true, status: 200, json: async () => { throw new Error('boom'); } });
  assert.equal(notJson.kind, 'invalid_response');
  assert.match(notJson.message, /不是合法 JSON/u);

  const noEnvelope = await readAdministratorsResponse(jsonResponse(200, { data: { items: [], next_cursor: null } }));
  assert.equal(noEnvelope.kind, 'invalid_response');
  assert.match(noEnvelope.message, /信封/u);

  const badShape = await readAdministratorsResponse(jsonResponse(200, page([{ id: 'root' }])));
  assert.equal(badShape.kind, 'invalid_response');
  assert.match(badShape.message, /AdminAdministratorViewPage/u);
  assert.match(badShape.message, /\$\.items\[0\]/u, '报错要指到具体字段，不吐 [object Object]');
});

test('403 SCOPE_DENIED ⇒ forbidden（不是空目录）；视图标题写清缺 scopes:read', async () => {
  const forbidden = await readAdministratorsResponse(jsonResponse(403, { error: { code: 'SCOPE_DENIED', message: '缺少 scopes:read' } }));
  assert.equal(forbidden.kind, 'forbidden');
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.code, 'SCOPE_DENIED');

  const view = describeAdministratorsView({ ...initialAdministratorsState(), signedIn: true, phase: 'error', failure: forbidden });
  assert.notEqual(view.tone, 'empty');
  assert.match(view.title, /权限不足/u);
  assert.match(view.title, /scopes:read/u);
  assert.equal(view.errorCode, 'SCOPE_DENIED（契约内错误码）');
  assert.equal(view.total, 0);
});

test('404 ⇒ not_found（管理员不存在）；503 ⇒ unavailable；401 ⇒ signed_out', async () => {
  const missing = await readAdministratorScopesResponse(jsonResponse(404, { error: { code: 'NOT_FOUND', message: '管理员不存在' } }));
  assert.equal(missing.kind, 'not_found');
  assert.match(describeAdministratorScopesView({ ...initialAdministratorsState(), scopesPhase: 'error', scopesFailure: missing }).title, /管理员不存在/u);

  const down = await readAdministratorsResponse(jsonResponse(503, { error: { code: 'PROVIDER_UNAVAILABLE', message: '管理员目录尚未接线到认证权威' } }));
  assert.equal(down.kind, 'unavailable');
  assert.equal(down.retriable, true);
  assert.match(describeAdministratorsView({ ...initialAdministratorsState(), signedIn: true, phase: 'error', failure: down }).detail, /503/u);

  const out = await readAdministratorsResponse(jsonResponse(401, { error: { code: 'SESSION_REQUIRED' } }));
  assert.equal(out.kind, 'signed_out');

  const limited = await readAdministratorsResponse(jsonResponse(429, { error: { code: 'RATE_LIMITED' } }, { 'retry-after': '9' }));
  assert.equal(limited.kind, 'rate_limited');
  assert.equal(limited.retryAfterSeconds, 9);
});

test('fetchAdministratorsPage：GET + Bearer、不带幂等键；scopes 请求打到 {id}/scopes', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(200, page([administrator()]));
  };
  const listed = await fetchAdministratorsPage({ fetchImpl, baseUrl: '/api/v1', token: 'tok-1', limit: 20 });
  assert.equal(listed.ok, true);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok-1');
  assert.equal('Idempotency-Key' in calls[0].init.headers, false, '读面不带幂等键');
  assert.match(calls[0].url, /\/admin\/administrators\?limit=20$/u);

  calls.length = 0;
  const scopesFetch = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(200, { data: { scopes: ['scopes:read'] }, meta: meta() });
  };
  const scopes = await fetchAdministratorScopes({ fetchImpl: scopesFetch, baseUrl: '/api/v1', token: 'tok-1', id: ADMIN_ID });
  assert.equal(scopes.ok, true);
  assert.deepEqual(scopes.scopes, ['scopes:read']);
  assert.equal(calls[0].url, `/api/v1/admin/administrators/${ADMIN_ID}/scopes`);

  const badId = await fetchAdministratorScopes({ fetchImpl: scopesFetch, baseUrl: '/api/v1', token: 'tok-1', id: 'root' });
  assert.equal(badId.kind, 'invalid_request');
  assert.match(badId.message, /admin_accounts\.id/u);
});

test('fetch：无令牌 ⇒ signed_out；网络异常 ⇒ network_error', async () => {
  assert.equal((await fetchAdministratorsPage({ baseUrl: '/api/v1', token: '', fetchImpl: async () => jsonResponse(200, page([])) })).kind, 'signed_out');

  const boom = await fetchAdministratorsPage({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
    baseUrl: '/api/v1',
    token: 'tok',
  });
  assert.equal(boom.kind, 'network_error');
});

test('reducer：登录 → 列表 ready；空目录 ⇒ empty；失败保数据 ⇒ stale', () => {
  let state = reduceAdministrators(initialAdministratorsState(), { type: 'SIGNED_IN', scopes: ['scopes:read'] });
  assert.equal(state.signedIn, true);
  assert.equal(state.scopeWarning, false);
  assert.equal(state.phase, 'loading');

  state = reduceAdministrators(state, { type: 'LOAD_OK', cursor: null, page: { items: [administrator()], nextCursor: 'c1', warnings: 0 } });
  assert.equal(state.phase, 'ready');
  assert.equal(administratorRows(state).length, 1);
  const ready = describeAdministratorsView(state);
  assert.equal(ready.tone, 'ready');
  assert.match(ready.title, /已读取 1 个管理员/u);
  assert.equal(canLoadMoreAdministrators(state), true);

  const stale = reduceAdministrators(state, { type: 'LOAD_FAIL', failure: { ok: false, kind: 'unavailable', retriable: true, status: 503, code: 'PROVIDER_UNAVAILABLE', message: '' } });
  assert.equal(stale.phase, 'ready');
  assert.equal(stale.collection.items.length, 1, '失败不清空已读数据');
  assert.equal(describeAdministratorsView(stale).tone, 'stale');

  const empty = reduceAdministrators(reduceAdministrators(initialAdministratorsState(), { type: 'SIGNED_IN', scopes: ['scopes:read'] }), {
    type: 'LOAD_OK',
    cursor: null,
    page: { items: [], nextCursor: null, warnings: 0 },
  });
  assert.equal(empty.phase, 'empty');
  assert.equal(describeAdministratorsView(empty).tone, 'empty');
  assert.match(describeAdministratorsView(empty).detail, /空目录/u);
  assert.equal(canLoadMoreAdministrators(empty), false);
});

test('缺 scope ⇒ scopeWarning；登出清空', () => {
  const warned = reduceAdministrators(initialAdministratorsState(), { type: 'SIGNED_IN', scopes: ['flags:read'] });
  assert.equal(warned.scopeWarning, true);
  assert.equal(reduceAdministrators(warned, { type: 'SIGN_OUT' }).phase, 'signed_out');
});

test('点开某人：SELECT_ADMIN → SCOPES_OK 渲染 scopes；404 落到面板错误态', () => {
  let state = reduceAdministrators(initialAdministratorsState(), { type: 'SIGNED_IN', scopes: ['scopes:read'] });
  state = reduceAdministrators(state, { type: 'LOAD_OK', cursor: null, page: { items: [administrator()], nextCursor: null, warnings: 0 } });

  assert.equal(describeAdministratorScopesView(state).tone, 'idle');

  state = reduceAdministrators(state, { type: 'SELECT_ADMIN', id: ADMIN_ID, loginName: 'root' });
  assert.equal(state.scopesPhase, 'loading');
  assert.match(describeAdministratorScopesView(state).title, /正在读取 root 的 scopes/u);

  state = reduceAdministrators(state, { type: 'SCOPES_OK', scopes: ['audit:read', 'scopes:read'] });
  const panel = describeAdministratorScopesView(state);
  assert.equal(panel.tone, 'ready');
  assert.equal(panel.scopes.length, 2);
  assert.match(panel.title, /root 的当前有效权限（2 项）/u);
  assert.match(panel.detail, /不含 granted_by \/ granted_at/u);

  const missing = reduceAdministrators(state, {
    type: 'SCOPES_FAIL',
    failure: { ok: false, kind: 'not_found', retriable: false, status: 404, code: 'NOT_FOUND', message: '管理员不存在' },
  });
  assert.equal(describeAdministratorScopesView(missing).tone, 'error');
  assert.match(describeAdministratorScopesView(missing).title, /管理员不存在/u);

  assert.equal(describeAdministratorScopesView(reduceAdministrators(state, { type: 'CLOSE_SCOPES' })).tone, 'idle');
});

test('点开某人：空 scopes 是「没有任何有效权限」，不是「读不到」；id 非 uuid 直接拒', () => {
  let state = reduceAdministrators(initialAdministratorsState(), { type: 'SIGNED_IN', scopes: ['scopes:read'] });
  state = reduceAdministrators(state, { type: 'SELECT_ADMIN', id: ADMIN_ID, loginName: 'root' });
  state = reduceAdministrators(state, { type: 'SCOPES_OK', scopes: [] });
  const panel = describeAdministratorScopesView(state);
  assert.equal(panel.tone, 'empty');
  assert.match(panel.title, /当前没有任何有效权限/u);

  const bad = reduceAdministrators(initialAdministratorsState(), { type: 'SELECT_ADMIN', id: 'root', loginName: 'root' });
  assert.equal(bad.scopesPhase, 'error');
  assert.match(describeAdministratorScopesView(bad).detail, /uuid/u);
});

test('行视图：state 有中文标签；scopes 内联但可点开读权威值', () => {
  const active = administratorRowView(administrator());
  assert.equal(active.loginName, 'root');
  assert.equal(active.stateLabel, '正常');
  assert.equal(active.stateTone, 'ok');
  assert.equal(active.scopeCount, 2);
  assert.equal(active.scopesText, 'audit:read、scopes:read');

  const suspended = administratorRowView(administrator({ state: 'suspended', scopes: [] }));
  assert.equal(suspended.stateLabel, '已暂停');
  assert.equal(suspended.stateTone, 'warn');
  assert.equal(suspended.scopesText, '（无）');

  const scopes = administratorScopesView(['audit:read', 'root:everything']);
  assert.equal(scopes[0].label.length > 0, true);
  assert.equal(scopes[0].known, true);
  assert.equal(scopes[1].known, false);
  assert.match(scopes[1].label, /契约外/u);
});

test('初始状态：未登录、limit=20、未选人', () => {
  const state = initialAdministratorsState();
  assert.equal(state.phase, 'signed_out');
  assert.equal(state.limit, 20);
  assert.equal(state.selectedId, null);
  assert.equal(state.scopesPhase, 'idle');
  assert.equal(emptyAdministratorCollection().items.length, 0);
  assert.equal(describeAdministratorsView(initialAdministratorsState()).tone, 'signed_out');
});
