/**
 * GY-R34（#29 P1 前端腿）· 授权清单读取层与页面的钉住测试。
 *
 * 本文件钉的是**读面**的四条口径（不是"页面长得对"）：
 *   1. **封套不对就报错，不吞**：`{data, meta}` 缺一件、实体形状不合契约 ⇒ `INVALID_RESPONSE`，
 *      且**不得**退化成"空列表"（空列表是"服务端确实 0 条"的专用结论，两者混在一起用户会以为
 *      自己的授权丢了）。
 *   2. **401 归因到登录态**：委托 `utils/auth.js` 的 `attribution()`／`failureFor()`（本文件用**真实**
 *      auth 模块），断言 `SESSION_REQUIRED` + 清会话一次 —— 客户端不自己判角色/状态。
 *   3. **403 契约码原样透出**：`CONSENT_REQUIRED` 不得被折叠成"登录失效"，也不得清会话
 *      （清了连授权入口都回不去）。
 *   4. **失败不渲染成空列表**：页面层断言 `items` 被清空的同时 `errorText`／`errorCode` 必须给出，
 *      渲染判定落到 `error` 而不是 `empty`。
 *
 * 载入方式与 `tests/unit/miniprogram-community-api.test.mjs` 同一套：`vm.runInNewContext` 读**真实**
 * 适配层与页面源码，注入 `wx` 替身与 `require` 依赖表（未登记依赖直接抛错，避免悄悄换成 mock）。
 * 只有 `utils/auth.js` 的判定函数直接用真实模块（`createRequire`），所以"归因"这条不受替身影响。
 *
 * 不能证明什么：微信编译器与真机未跑；本文件不证明服务端 `GET /me/consents` 的行为（那是
 * `tests/unit/consent-pagination*.test.mjs` 的范围），也不证明 `real` 模式下的 PG 装配。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const realAuth = require('../../miniprogram/utils/auth.js');

const REQUEST_ID = '00000000-0000-4000-8000-000000000000';
const RECORD_ID = '3f6c9b8e-1d2a-4c7b-9e51-8a0b2c4d6e70';

function record(overrides) {
  return Object.assign({
    id: RECORD_ID,
    purpose: 'recording',
    policy_version: '2026-10-21',
    recipient_ids: ['tts-primary'],
    state: 'granted',
    epoch: 1,
    revision: 2,
    granted_at: '2026-10-20T08:00:00Z',
    withdrawn_at: null,
  }, overrides || {});
}

function meta(mode) {
  return { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: mode || 'real' };
}

function envelope(items, nextCursor, mode) {
  return { data: { items, next_cursor: nextCursor === undefined ? null : nextCursor }, meta: meta(mode) };
}

function errorEnvelope(code, details) {
  return {
    error: { code, message: 'synthetic', retryable: false, details: details || [] },
    meta: meta('real'),
  };
}

/** 跨 realm 深比较（vm 里造的对象原型不同，直接 deepEqual 会挂在原型上）。 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

/** 载入一个真实源文件到独立 realm，注入 `wx` 替身与依赖表。 */
function loadModule(sourcePath, deps, wx, extraGlobals) {
  const sandbox = {
    module: { exports: {} },
    require(specifier) {
      if (!Object.prototype.hasOwnProperty.call(deps, specifier)) {
        throw new Error(`未登记的依赖：${specifier}（${sourcePath}）`);
      }
      return deps[specifier];
    },
    wx,
    console,
    ...(extraGlobals || {}),
  };
  sandbox.exports = sandbox.module.exports;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(ROOT, sourcePath), 'utf8'), sandbox, { filename: sourcePath });
  return sandbox.module.exports;
}

function createHarness(options) {
  const settings = options || {};
  const requests = [];
  const cleared = { count: 0 };
  // 委托计数：适配层必须**调用** auth.js 的归因，而不是自己判角色/状态码。
  const delegated = { attribution: 0, failureFor: 0 };
  let session = settings.loggedIn === false ? null : { accessToken: 'token-1' };
  const auth = {
    getSession: () => session,
    isLoggedIn: () => !!session,
    sessionEpoch: () => 'generation:1',
    networkEnabled: () => settings.networkEnabled !== false,
    // 适配层自己**不许**直接清会话（那是 auth.failureFor 的事）；命中这里就是错。
    clearSession: () => { cleared.count += 1; session = null; },
    // 归因相关的四个导出委托真实模块：客户端判错角色/状态时这里就会红。
    attribution: (...args) => { delegated.attribution += 1; return realAuth.attribution(...args); },
    failureFor: (...args) => { delegated.failureFor += 1; return realAuth.failureFor(...args); },
    isSessionLossCode: realAuth.isSessionLossCode,
    isForbiddenCode: realAuth.isForbiddenCode,
    requireLogin: () => {},
  };
  const wx = { request: request => { requests.push(request); } };
  const api = loadModule('miniprogram/utils/consent-api.js', {
    './auth': auth,
    '../config/runtime': { apiBaseUrl: 'http://127.0.0.1:4318/api/v1' },
  }, wx);
  return { auth, api, requests, cleared, delegated, wx };
}

function createPage(harness) {
  let definition = null;
  loadModule('miniprogram/pages/consent/consent.js', {
    '../../utils/font-scale': { DEFAULT_FONT_SCALE: 1, applyFontScale() {} },
    '../../utils/auth': harness.auth,
    '../../utils/page-gate': { start(page, callback) { callback(true); }, cancel() {} },
    '../../utils/consent-api': harness.api,
  }, harness.wx, { Page: pageDefinition => { definition = pageDefinition; } });
  assert.ok(definition, '授权清单页必须调用 Page(...)');
  const page = {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch); },
  };
  for (const key of Object.keys(definition)) {
    if (key !== 'data') page[key] = definition[key];
  }
  return page;
}

/** 与 consent.wxml 的分支链同序：loading → error → empty → list（失败必须落在 error）。 */
function renderedState(page) {
  if (page.data.busy && !page.data.items.length) return 'loading';
  if (page.data.errorText) return 'error';
  if (!page.data.items.length) return 'empty';
  return 'list';
}

test('读取：成功封套 ⇒ 只用契约查询参数，cursor 为空时不拼出来（服务端会把空游标判非法）', async () => {
  const h = createHarness();
  const pending = h.api.listConsents({ cursor: '', limit: 20 });
  const request = h.requests.at(-1);
  assert.equal(request.method, 'GET');
  assert.equal(request.url, 'http://127.0.0.1:4318/api/v1/me/consents?limit=20');
  assert.equal(request.header.authorization, 'Bearer token-1');
  assert.equal(request.header['Cache-Control'], 'no-cache', '读面必须显式不缓存');
  request.success({ statusCode: 200, data: envelope([record()], null, 'real') });
  const result = await pending;
  assert.deepEqual(plain(result.items), [record()]);
  assert.equal(result.nextCursor, null);
  assert.equal(result.mode, 'real');
  assert.deepEqual(plain(h.api.consentView(record())).purposeLabel, '录音', '用途名只来自契约枚举短名');
});

test('读取：封套少 meta ⇒ INVALID_RESPONSE，且不得退化成空列表', async () => {
  const h = createHarness();
  const pending = h.api.listConsents({});
  h.requests.at(-1).success({ statusCode: 200, data: { data: { items: [], next_cursor: null } } });
  await assert.rejects(pending, error => error.code === 'INVALID_RESPONSE');
});

test('读取：401 ⇒ 委托 auth 归因到登录态（SESSION_REQUIRED，且适配层不自己清会话）', async () => {
  const h = createHarness();
  const pending = h.api.listConsents({});
  h.requests.at(-1).success({ statusCode: 401, data: errorEnvelope('SESSION_REQUIRED') });
  await assert.rejects(pending, error => error.code === 'SESSION_REQUIRED' && error.status === 401);
  assert.equal(h.delegated.failureFor, 1, '401 必须交给 auth.failureFor 归因（单一事实源）');
  assert.equal(h.cleared.count, 0, '清会话由 auth 负责，适配层不得自己调 clearSession');
  // 真实归因对 401 的判定就是「会话丢失且要清」——这条钉住"登录态"语义本身。
  assert.equal(realAuth.attribution(401, errorEnvelope('SESSION_REQUIRED')).clearsSession, true);
});

test('读取：403 CONSENT_REQUIRED ⇒ 码原样透出、按 403 归因而非登录失效', async () => {
  const h = createHarness();
  const pending = h.api.listConsents({});
  h.requests.at(-1).success({ statusCode: 403, data: errorEnvelope('CONSENT_REQUIRED') });
  await assert.rejects(pending, error => error.code === 'CONSENT_REQUIRED' && error.status === 403);
  assert.equal(h.delegated.failureFor, 1);
  assert.equal(h.cleared.count, 0, '403 用途授权缺失不得清会话（适配层不许自己清）');
  assert.equal(realAuth.attribution(403, errorEnvelope('CONSENT_REQUIRED')).clearsSession, false);
  assert.equal(realAuth.isForbiddenCode('CONSENT_REQUIRED'), true, '403 闭集判定同样来自 auth.js');
  assert.match(h.api.message({ code: 'CONSENT_REQUIRED' }), /CONSENT_REQUIRED/, '文案要把契约码原样说给用户');
});

test('读取：403 但码不在闭集内 ⇒ 由 auth.js 归为 SCOPE_DENIED（适配层不自己编码）', async () => {
  const h = createHarness();
  const pending = h.api.listConsents({});
  h.requests.at(-1).success({ statusCode: 403, data: errorEnvelope('SOMETHING_NEW') });
  await assert.rejects(pending, error => error.code === 'SCOPE_DENIED' && error.status === 403);
});

test('读取：状态与时间打架的记录 ⇒ INVALID_RESPONSE（不渲染成一张看不出问题的卡片）', async () => {
  const h = createHarness();
  const pending = h.api.listConsents({});
  h.requests.at(-1).success({
    statusCode: 200,
    data: envelope([record({ state: 'granted', withdrawn_at: '2026-10-21T00:00:00Z' })], null, 'real'),
  });
  await assert.rejects(pending, error => error.code === 'INVALID_RESPONSE');

  const h2 = createHarness();
  const other = h2.api.listConsents({});
  h2.requests.at(-1).success({
    statusCode: 200,
    data: envelope([record({ purpose: 'not_in_contract' })], null, 'real'),
  });
  await assert.rejects(other, error => error.code === 'INVALID_RESPONSE', '闭集外的用途码不得照单全收');
});

test('页面：空 data ⇒ 诚实空态（不是错误，也不是"读取中"）', async () => {
  const h = createHarness();
  const page = createPage(h);
  page.load('');
  h.requests.at(-1).success({ statusCode: 200, data: envelope([], null, 'real') });
  await flush();
  assert.deepEqual(plain(page.data.items), []);
  assert.equal(page.data.errorText, '');
  assert.equal(page.data.errorCode, '');
  assert.equal(page.data.nextCursor, null);
  assert.equal(renderedState(page), 'empty', '服务端确实 0 条才落到 empty');
});

test('页面：读取失败 ⇒ 清空列表的同时必须给出错误，绝不渲染成空列表', async () => {
  const h = createHarness();
  const page = createPage(h);
  page.load('');
  h.requests.at(-1).success({ statusCode: 409, data: errorEnvelope('INVALID_CURSOR') });
  await flush();
  assert.deepEqual(plain(page.data.items), [], '失败必须清空（不保留旧列表冒充最新）');
  assert.equal(page.data.errorCode, 'INVALID_CURSOR', '契约码原样带出');
  assert.notEqual(page.data.errorText, '', '失败必须给出可见原因');
  assert.equal(renderedState(page), 'error', '有失败原因时绝不能落到 empty');
  assert.equal(
    page.data.errorText === '' && page.data.items.length === 0,
    false,
    '「没读到」与「没授权」必须是两件可区分的事',
  );
});

test('页面：403 CONSENT_REQUIRED ⇒ 页面给 denied 语义与错误码，且不是空态', async () => {
  const h = createHarness();
  const page = createPage(h);
  page.load('');
  h.requests.at(-1).success({ statusCode: 403, data: errorEnvelope('CONSENT_REQUIRED') });
  await flush();
  assert.equal(page.data.errorCode, 'CONSENT_REQUIRED');
  assert.match(page.data.errorText, /CONSENT_REQUIRED/);
  assert.equal(renderedState(page), 'error');
  assert.equal(h.cleared.count, 0);
});

test('页面：401 ⇒ 页面拿到 SESSION_REQUIRED（门禁语义），不是一句笼统的读取失败', async () => {
  const h = createHarness();
  const page = createPage(h);
  page.load('');
  h.requests.at(-1).success({ statusCode: 401, data: errorEnvelope('SESSION_REQUIRED') });
  await flush();
  assert.equal(page.data.errorCode, 'SESSION_REQUIRED');
  assert.equal(renderedState(page), 'error');
  assert.equal(h.delegated.failureFor, 1);
  assert.equal(h.cleared.count, 0);
});