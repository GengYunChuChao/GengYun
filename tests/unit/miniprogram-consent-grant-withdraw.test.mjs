/**
 * GY-R70 · 用途授权**写面**（授予 / 撤回）与授权页四态的钉住测试。
 *
 * 本文件钉的是契约与安全口径，不是"页面长得对"：
 *   1. **幂等键复用**：同一次用户动作的所有重试必须带**同一个** `Idempotency-Key`（页面级钉住，
 *      因为键的生命周期属于"一次动作"）；两次不同动作必须换新键。
 *   2. **428 处理**：`DELETE` 先取当前 `revision` 再带 `If-Match`；收到 **428 `REVISION_REQUIRED`**
 *      ⇒ 自动补取**一次**再重试；补取也失败 ⇒ 如实报**补取自己的码**，⛔ 不无限重试。
 *   3. **403 无可用政策**：界面**置灰 + 原因**，且**没有第二次请求**（不重试、不假装修好）。
 *   4. **非乐观**：服务端确认之前界面不改状态；失败后状态原样，原因写在行内。
 *   5. **服务端 `error.code` 原样到界面**（`REVISION_CONFLICT` / `CONSENT_REQUIRED` / `NETWORK_UNCERTAIN`），
 *      ⛔ 不折叠成 `FAILED` 一类通用串。
 *   6. **空清单 / 读面失败**两种形态可区分（失败不得渲染成"没授权"）。
 *
 * 载入方式与 `tests/unit/consent-page-read.test.mjs` 同一套：`vm.runInNewContext` 读**真实**适配层与
 * 页面源码，注入 `wx` 替身（`request` 只入队，由用例显式回放 success／fail）与 `require` 依赖表
 * （未登记依赖直接抛错，避免悄悄换成 mock）。只有 `utils/auth.js` 的归因函数用真实模块。
 *
 * 不能证明什么（如实登记）：微信编译器与真机未跑；假 `wx.request` 下没有真实政策行，因此**不**
 * 证明"真能授予成功"，也不证明服务端的撤回依赖判定（那是 `tests/unit/consent-withdraw-dependency.test.mjs`
 * 与真库臂的范围）。本文件证的是"客户端按契约调用 + 失败路径如实呈现"。
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
const POLICY_VERSION = '2026-10-21';
const ALL_PURPOSES = ['recording', 'media_processing', 'external_inference', 'public_posting'];

function meta(mode) {
  return { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: mode || 'real' };
}
function envelope(data, mode) {
  return { data: data, meta: meta(mode) };
}
function pageEnvelope(items, nextCursor, mode) {
  return { data: { items: items, next_cursor: nextCursor === undefined ? null : nextCursor }, meta: meta(mode) };
}
function policyEnvelope(overrides, mode) {
  return envelope(Object.assign({
    version: POLICY_VERSION,
    purposes: ['recording', 'media_processing', 'public_posting'],
    recipients: [],
    training_enabled: false,
  }, overrides || {}), mode);
}
function errorEnvelope(code, retryable) {
  return { error: { code: code, message: 'synthetic', retryable: retryable === true, details: [] }, meta: meta('real') };
}
let recordSeq = 0;
function record(overrides) {
  recordSeq += 1;
  const n = String(recordSeq).padStart(2, '0');
  return Object.assign({
    id: '3f6c9b8e-1d2a-4c7b-9e51-8a0b2c4d6e' + n,
    purpose: 'recording',
    policy_version: POLICY_VERSION,
    recipient_ids: [],
    state: 'granted',
    epoch: 1,
    revision: 7,
    granted_at: '2026-10-20T08:00:00Z',
    withdrawn_at: null,
  }, overrides || {});
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }
const flush = () => new Promise(resolve => setImmediate(resolve));
async function settle() { await flush(); await flush(); }

/** 载入真实源文件到独立 realm，注入 `wx` 替身与依赖表。 */
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
  const modals = [];
  const cleared = { count: 0 };
  let session = { accessToken: 'token-1' };
  const auth = {
    getSession: () => session,
    isLoggedIn: () => !!session,
    sessionEpoch: () => 'generation:1',
    networkEnabled: () => settings.networkEnabled !== false,
    clearSession: () => { cleared.count += 1; session = null; },
    attribution: realAuth.attribution,
    failureFor: (...args) => realAuth.failureFor(...args),
    isSessionLossCode: realAuth.isSessionLossCode,
    isForbiddenCode: realAuth.isForbiddenCode,
    requireLogin: () => {},
  };
  const wx = {
    request: request => { requests.push(request); },
    showModal: modal => {
      modals.push(modal);
      if (settings.confirm === false) { if (modal.success) modal.success({ confirm: false, cancel: true }); return; }
      if (modal.success) modal.success({ confirm: true, cancel: false });
    },
  };
  const api = loadModule('miniprogram/utils/consent-api.js', {
    './auth': auth,
    '../config/runtime': { apiBaseUrl: 'http://127.0.0.1:4318/api/v1' },
  }, wx);
  const harness = { api, auth, wx, requests, modals, cleared };
  harness.page = createPage(harness);
  return harness;
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

/** 回放：2xx 成功封套（`data` 是裸 DTO／Page）。 */
function ok(request, data, statusCode, mode) {
  assert.ok(request, '期望有一条在途请求可以回放，实际没有（夹具失配必须显式失败）');
  request.success({ statusCode: statusCode || 200, data: envelope(data, mode) });
}
function okPage(request, items, nextCursor) {
  assert.ok(request, '期望有一条在途清单请求可以回放，实际没有');
  request.success({ statusCode: 200, data: pageEnvelope(items, nextCursor) });
}
function failRequest(request, statusCode, body) {
  assert.ok(request, '期望有一条在途请求可以回放，实际没有');
  request.success({ statusCode: statusCode, data: body });
}
function networkFail(request) {
  assert.ok(request, '期望有一条在途请求可以回放，实际没有');
  request.fail({ errMsg: 'request:fail' });
}

/** 进入页面并喂两份读面（清单 + 政策）。返回 `{ listRequest, policyRequest }`。 */
function openPage(harness, listItems, policy) {
  harness.page.onShow();
  assert.equal(harness.requests.length, 2, '进入页面应同时发起「读清单」与「读政策」两条请求');
  const listRequest = harness.requests[0];
  const policyRequest = harness.requests[1];
  assert.match(listRequest.url, /\/me\/consents\?limit=20$/, '读清单只带契约查询参数');
  assert.match(policyRequest.url, /\/me\/privacy-policy$/, '政策读面就是契约里那一条');
  if (policy === 'fail') {
    failRequest(policyRequest, 503, errorEnvelope('PROVIDER_UNAVAILABLE'));
  } else if (policy === 'unpublished') {
    ok(policyRequest, { version: 'unpublished', purposes: [], recipients: [], training_enabled: false });
  } else {
    ok(policyRequest, (policy || {}).body || { version: POLICY_VERSION, purposes: ['recording', 'media_processing', 'public_posting'], recipients: [], training_enabled: false });
  }
  if (listItems !== 'fail') okPage(listRequest, listItems || []);
  return { listRequest, policyRequest };
}

function rowOf(page, purpose) {
  return plain(page.data.rows).filter(row => row.purpose === purpose)[0];
}
function tap(page, purpose) {
  page.onRowAction({ currentTarget: { dataset: { purpose: purpose } } });
}

// ===========================================================================
// A. 适配层：契约形状与幂等键
// ===========================================================================
test('A1 授予：POST /me/consents，body 恰好三字段，带 8..128 的 Idempotency-Key，不带 If-Match', async () => {
  const h = createHarness();
  const pending = h.api.grant({ purpose: 'recording', policyVersion: POLICY_VERSION });
  const request = h.requests.at(-1);
  assert.equal(request.method, 'POST');
  assert.equal(request.url, 'http://127.0.0.1:4318/api/v1/me/consents');
  assert.deepEqual(plain(request.data), {
    purpose: 'recording', policy_version: POLICY_VERSION, recipient_ids: [],
  }, '授予体只含契约要求的三个字段（additionalProperties: false）');
  const key = request.header['Idempotency-Key'];
  assert.equal(typeof key, 'string');
  assert.ok(key.length >= 8 && key.length <= 128, `幂等键长度必须落在契约 8..128（实测 ${key.length}）`);
  assert.equal(request.header['If-Match'], undefined, '授予不是版本前置条件，不带 If-Match');
  assert.equal(request.header['content-type'], 'application/json');
  ok(request, record(), 201);
  const result = await pending;
  assert.equal(result.consent.purpose, 'recording');
  assert.equal(result.revision, 7);
  assert.equal(result.idempotencyKey, key, '返回体里要如实带回这次用的键');
});

test('A2 授予：调用方传回的同一个键必须被复用；不传的两次调用是两次动作，键必须不同', async () => {
  const h = createHarness();
  const first = h.api.grant({ purpose: 'recording', policyVersion: POLICY_VERSION, idempotencyKey: 'consent-action-1' });
  const firstRequest = h.requests.at(-1);
  assert.equal(firstRequest.header['Idempotency-Key'], 'consent-action-1');
  networkFail(firstRequest);
  await assert.rejects(first, error => error.code === 'NETWORK_UNCERTAIN');

  const retry = h.api.grant({ purpose: 'recording', policyVersion: POLICY_VERSION, idempotencyKey: 'consent-action-1' });
  assert.equal(h.requests.at(-1).header['Idempotency-Key'], 'consent-action-1', '同一次动作的重试必须是同一个键');
  ok(h.requests.at(-1), record(), 201);
  await retry;

  const another = h.api.grant({ purpose: 'recording', policyVersion: POLICY_VERSION });
  const anotherKey = h.requests.at(-1).header['Idempotency-Key'];
  assert.notEqual(anotherKey, 'consent-action-1', '不传键时由本层生成新键（另一次动作）');
  ok(h.requests.at(-1), record(), 201);
  await another;

  const short = h.api.grant({ purpose: 'recording', policyVersion: POLICY_VERSION, idempotencyKey: 'abc' });
  await assert.rejects(short, error => error.code === 'INVALID_INPUT');
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 3, '不合规的键不发请求（换键=换意图，不许悄悄替换）');
});

test('A3 撤回：先取当前 revision 再带 If-Match；清单里没有该用途 ⇒ NOT_GRANTED 且不发 DELETE', async () => {
  const h = createHarness();
  const pending = h.api.withdraw({ purpose: 'media_processing' });
  const listRequest = h.requests.at(-1);
  assert.equal(listRequest.method, 'GET');
  assert.match(listRequest.url, /\/me\/consents\?limit=50$/, '取 revision 用最大页长读清单');
  okPage(listRequest, [record({ purpose: 'media_processing', revision: 11 })]);
  await settle();

  const deleteRequest = h.requests.at(-1);
  assert.equal(deleteRequest.method, 'DELETE');
  assert.equal(deleteRequest.url, 'http://127.0.0.1:4318/api/v1/me/consents/media_processing');
  assert.equal(deleteRequest.header['If-Match'], '"11"', 'If-Match 必须是当前 revision 的强 ETag 形式');
  assert.equal(typeof deleteRequest.header['Idempotency-Key'], 'string', '撤回同样要幂等键');
  ok(deleteRequest, record({ purpose: 'media_processing', state: 'withdrawn', revision: 12, withdrawn_at: '2026-10-30T01:00:00Z' }));
  const result = await pending;
  assert.equal(result.consent.state, 'withdrawn');
  assert.equal(result.refetches, 0, '正常路径不该补取');

  const h2 = createHarness();
  const missing = h2.api.withdraw({ purpose: 'public_posting' });
  okPage(h2.requests.at(-1), [record({ purpose: 'recording' })]);
  await assert.rejects(missing, error => error.code === 'NOT_GRANTED');
  assert.equal(h2.requests.filter(request => request.method === 'DELETE').length, 0, '没有当前记录就不发注定 404 的 DELETE');
});

test('A4 撤回 428：自动补取一次 revision 再重试，成功；两次 DELETE 复用同一个幂等键', async () => {
  const h = createHarness();
  const pending = h.api.withdraw({ purpose: 'recording' });
  okPage(h.requests.at(-1), [record({ purpose: 'recording', revision: 7 })]);
  await settle();
  const firstDelete = h.requests.at(-1);
  assert.equal(firstDelete.header['If-Match'], '"7"');
  const key = firstDelete.header['Idempotency-Key'];
  failRequest(firstDelete, 428, errorEnvelope('REVISION_REQUIRED'));
  await settle();

  const refetch = h.requests.at(-1);
  assert.equal(refetch.method, 'GET', '428 之后必须补取一次 revision');
  okPage(refetch, [record({ purpose: 'recording', revision: 9 })]);
  await settle();

  const secondDelete = h.requests.at(-1);
  assert.equal(secondDelete.method, 'DELETE');
  assert.equal(secondDelete.header['If-Match'], '"9"', '重试要用补取到的新 revision');
  assert.equal(secondDelete.header['Idempotency-Key'], key, '428 发生在服务层之前，重试复用同一个键是安全的');
  ok(secondDelete, record({ purpose: 'recording', state: 'withdrawn', revision: 10, withdrawn_at: '2026-10-30T01:00:00Z' }));
  const result = await pending;
  assert.equal(result.consent.state, 'withdrawn');
  assert.equal(result.refetches, 1);
});

test('A5 撤回 428 且补取也失败：如实抛补取自己的码，⛔ 不无限重试', async () => {
  const h = createHarness();
  const pending = h.api.withdraw({ purpose: 'recording' });
  okPage(h.requests.at(-1), [record({ purpose: 'recording', revision: 7 })]);
  await settle();
  failRequest(h.requests.at(-1), 428, errorEnvelope('REVISION_REQUIRED'));
  await settle();
  const refetch = h.requests.at(-1);
  assert.equal(refetch.method, 'GET');
  networkFail(refetch);

  await assert.rejects(pending, error => {
    assert.equal(error.code, 'NETWORK_UNCERTAIN', '补取失败时透出补取自己的码，而不是折叠成通用串');
    assert.equal(error.refetchFailedAfter, 'REVISION_REQUIRED', '原始 428 的证据要留着');
    return true;
  });
  assert.equal(h.requests.filter(request => request.method === 'DELETE').length, 1, '只发过一次 DELETE（补取失败后不再重试）');
  assert.equal(h.requests.length, 3, '总请求数应停在「清单 + DELETE + 补取」三条');
});

test('A6 撤回 409 REVISION_CONFLICT：码与状态原样上抛（不当作 428 去重试）', async () => {
  const h = createHarness();
  const pending = h.api.withdraw({ purpose: 'recording' });
  okPage(h.requests.at(-1), [record({ purpose: 'recording', revision: 7 })]);
  await settle();
  failRequest(h.requests.at(-1), 409, errorEnvelope('REVISION_CONFLICT'));
  await assert.rejects(pending, error => error.code === 'REVISION_CONFLICT' && error.status === 409);
  assert.equal(h.requests.filter(request => request.method === 'DELETE').length, 1, '409 不是 428：不补取、不重试');
});

test('A7 政策读面：unpublished 是「尚无已发布政策」而不是版本号；形状不符 ⇒ INVALID_RESPONSE', async () => {
  const h = createHarness();
  const pending = h.api.readPolicy();
  ok(h.requests.at(-1), { version: 'unpublished', purposes: [], recipients: [], training_enabled: false });
  const result = await pending;
  assert.equal(result.policy.published, false);
  assert.deepEqual(plain(result.policy.purposes), []);

  const h2 = createHarness();
  const bad = h2.api.readPolicy();
  ok(h2.requests.at(-1), { version: 'v1', purposes: ['not_a_purpose'], recipients: [], training_enabled: false });
  await assert.rejects(bad, error => error.code === 'INVALID_RESPONSE');

  const h3 = createHarness();
  const notFalse = h3.api.readPolicy();
  ok(h3.requests.at(-1), { version: 'v1', purposes: [], recipients: [], training_enabled: true });
  await assert.rejects(notFalse, error => error.code === 'INVALID_RESPONSE', 'training_enabled 契约是 const false');
});

// ===========================================================================
// B. 页面：四态、非乐观、置灰、失败保持原状
// ===========================================================================
test('B1 四态之一二：有政策 ⇒ 「可授予」；清单里已授权 ⇒ 「可撤回」', async () => {
  const h = createHarness();
  openPage(h, [record({ purpose: 'media_processing', state: 'granted', revision: 4 })]);
  await settle();

  const granted = rowOf(h.page, 'media_processing');
  assert.equal(granted.state, 'granted');
  assert.equal(granted.actionKind, 'withdraw');
  assert.equal(granted.actionLabel, '撤回');
  assert.equal(granted.actionDisabled, false, '已授权 + 有政策 ⇒ 可以撤回');

  const fresh = rowOf(h.page, 'recording');
  assert.equal(fresh.state, 'none', '清单里没有该用途的记录 ⇒ 「未授权」，不推断');
  assert.equal(fresh.actionLabel, '授予');
  assert.equal(fresh.actionDisabled, false, '有政策且不是 external_inference ⇒ 可以授予');

  const inference = rowOf(h.page, 'external_inference');
  assert.equal(inference.actionDisabled, true, '政策 purposes 未包含它 ⇒ 置灰');
  assert.match(inference.actionReason, /没有该用途的可用政策/);
});

test('B2 授予：服务端没确认之前不改状态（非乐观）；成功后按服务端清单刷新', async () => {
  const h = createHarness();
  openPage(h, [], { body: { version: POLICY_VERSION, purposes: ALL_PURPOSES, recipients: [], training_enabled: false } });
  await settle();
  assert.equal(rowOf(h.page, 'media_processing').state, 'none');

  const before = h.requests.length;
  tap(h.page, 'media_processing');
  const post = h.requests[before];
  assert.equal(post.method, 'POST');
  // 在飞：busy 但状态**没有**翻过去。
  assert.equal(rowOf(h.page, 'media_processing').busy, true, '在飞时该行显示进行中');
  assert.equal(rowOf(h.page, 'media_processing').state, 'none', '服务端没确认前界面不许把开关翻过去');
  assert.equal(h.requests.length, before + 1, '只有一条在途请求，没有本地"预支"成功');

  ok(post, record({ purpose: 'media_processing', state: 'granted', revision: 2 }), 201);
  await settle();
  assert.equal(h.requests.at(-1).method, 'GET', '写成功后要重新读取服务端清单再刷新');
  okPage(h.requests.at(-1), [record({ purpose: 'media_processing', state: 'granted', revision: 2 })]);
  await settle();
  assert.equal(rowOf(h.page, 'media_processing').state, 'granted', '状态来自服务端重新读取的清单');
  assert.equal(rowOf(h.page, 'media_processing').actionKind, 'withdraw');
  assert.match(h.page.data.actionText, /已授予/);
});

test('B3 授予 403 CONSENT_REQUIRED（无可用已核验政策）：置灰 + 原因 + 码原样，且没有第二次请求', async () => {
  const h = createHarness();
  openPage(h, [], { body: { version: POLICY_VERSION, purposes: ALL_PURPOSES, recipients: [], training_enabled: false } });
  await settle();
  const before = h.requests.length;
  tap(h.page, 'public_posting');
  const post = h.requests[before];
  failRequest(post, 403, errorEnvelope('CONSENT_REQUIRED'));
  await settle();

  const row = rowOf(h.page, 'public_posting');
  assert.equal(row.actionDisabled, true, '服务端说没有可用政策 ⇒ 置灰');
  assert.match(row.actionReason, /CONSENT_REQUIRED/, '置灰原因必须带服务端码');
  assert.match(row.actionReason, /没有可用的已核验用途政策/, '原因要说清是什么不可用');
  assert.equal(row.errorCode, 'CONSENT_REQUIRED', '服务端码原样到达界面');
  assert.equal(row.state, 'none', '失败后状态不变');
  assert.equal(h.requests.length, before + 1, '403 之后不得再发任何请求（不重试、不自动重读）');

  // 置灰之后点击不再发请求。
  tap(h.page, 'public_posting');
  assert.equal(h.requests.length, before + 1, '置灰的行点击不得发请求');
});

test('B4 授予网络不确定：状态不变 + 真实原因；同一动作重试复用同一个幂等键（页面级）', async () => {
  const h = createHarness();
  openPage(h, [], { body: { version: POLICY_VERSION, purposes: ALL_PURPOSES, recipients: [], training_enabled: false } });
  await settle();

  let before = h.requests.length;
  tap(h.page, 'recording');
  const firstPost = h.requests[before];
  const firstKey = firstPost.header['Idempotency-Key'];
  networkFail(firstPost);
  await settle();

  const row = rowOf(h.page, 'recording');
  assert.equal(row.state, 'none', '失败后状态不变（非乐观）');
  assert.equal(row.errorCode, 'NETWORK_UNCERTAIN', '服务端/客户端码原样');
  assert.match(row.errorText, /网络未能确认/, '失败必须给出可见原因');
  assert.equal(row.actionDisabled, false, '网络类失败可重试，不置灰');

  before = h.requests.length;
  tap(h.page, 'recording');
  const retryPost = h.requests[before];
  assert.equal(retryPost.header['Idempotency-Key'], firstKey, '同一次动作的重试必须是同一个幂等键');

  ok(retryPost, record({ purpose: 'recording', state: 'granted', revision: 3 }), 201);
  await settle();
  okPage(h.requests.at(-1), [record({ purpose: 'recording', state: 'granted', revision: 3 })]);
  await settle();

  // 成功之后 = 动作结束：再次授予（新动作）必须是新键。
  before = h.requests.length;
  h.page.onGrant('recording');
  const nextPost = h.requests[before];
  assert.notEqual(nextPost.header['Idempotency-Key'], firstKey, '新的动作不得复用上一次的键');
  ok(nextPost, record({ purpose: 'recording', state: 'granted', revision: 4 }), 201);
  await settle();
  okPage(h.requests.at(-1), [record({ purpose: 'recording', state: 'granted', revision: 4 })]);
  await settle();
});

test('B5 撤回：二次确认按 purpose 分别写清代价；不确认就不发请求；在飞时状态不变', async () => {
  const h = createHarness({ confirm: false });
  const granted = ALL_PURPOSES.map(purpose => record({ purpose: purpose, state: 'granted', revision: 5 }));
  openPage(h, granted, { body: { version: POLICY_VERSION, purposes: ALL_PURPOSES, recipients: [], training_enabled: false } });
  await settle();

  // ① 四种用途的确认文案必须各不相同，且各自说到该项撤回后立刻不可用的能力。
  const expectations = {
    recording: /语音提问/,
    media_processing: /拍草识别|标签识别/,
    external_inference: /OCR|识别/,
    public_posting: /发帖/,
  };
  const contents = {};
  for (const purpose of ALL_PURPOSES) {
    h.modals.length = 0;
    const before = h.requests.length;
    tap(h.page, purpose);
    assert.equal(h.modals.length, 1, `${purpose}：撤回必须先弹二次确认`);
    contents[purpose] = h.modals[0].content;
    assert.match(h.modals[0].title, new RegExp(plain(h.page.data.rows).filter(row => row.purpose === purpose)[0].label));
    assert.match(contents[purpose], expectations[purpose], `${purpose}：确认文案要说清撤回后哪项能力立刻不可用`);
    assert.equal(h.modals[0].confirmText, '确认撤回');
    assert.equal(h.requests.length, before, `${purpose}：未确认前不得发任何请求`);
    assert.equal(rowOf(h.page, purpose).state, 'granted', `${purpose}：未确认前状态不变`);
  }
  const distinct = new Set(ALL_PURPOSES.map(purpose => contents[purpose]));
  assert.equal(distinct.size, 4, '四个用途的代价文案必须分别写，不能一句通用话糊过去');

  // ② 确认后才发 DELETE；在飞时状态仍是 granted。
  h.wx.showModal = modal => { h.modals.push(modal); modal.success({ confirm: true }); };
  const before = h.requests.length;
  tap(h.page, 'public_posting');
  const listRequest = h.requests[before];
  assert.equal(listRequest.method, 'GET', '撤回先取当前 revision');
  assert.equal(rowOf(h.page, 'public_posting').busy, true);
  assert.equal(rowOf(h.page, 'public_posting').state, 'granted', '在飞时不许先把状态翻成已撤回');
  okPage(listRequest, granted);
  await settle();
  const deleteRequest = h.requests.at(-1);
  assert.equal(deleteRequest.method, 'DELETE');
  ok(deleteRequest, record({ purpose: 'public_posting', state: 'withdrawn', revision: 6, withdrawn_at: '2026-10-30T01:00:00Z' }));
  await settle();
  okPage(h.requests.at(-1), granted.map(item => item.purpose === 'public_posting'
    ? record({ purpose: 'public_posting', state: 'withdrawn', revision: 6, withdrawn_at: '2026-10-30T01:00:00Z' })
    : item));
  await settle();
  assert.equal(rowOf(h.page, 'public_posting').state, 'withdrawn', '撤回后状态来自服务端重新读取');
  assert.match(h.page.data.actionText, /已撤回/);
});

test('B6 撤回失败（409 OBJECT_UNAVAILABLE）：置灰 + 原因，状态不变，码原样', async () => {
  const h = createHarness();
  openPage(h, [record({ purpose: 'external_inference', state: 'granted', revision: 3 })],
    { body: { version: POLICY_VERSION, purposes: ALL_PURPOSES, recipients: [], training_enabled: false } });
  await settle();
  tap(h.page, 'external_inference');
  assert.equal(h.requests.at(-1).method, 'GET');
  okPage(h.requests.at(-1), [record({ purpose: 'external_inference', state: 'granted', revision: 3 })]);
  await settle();
  const deleteRequest = h.requests.at(-1);
  assert.equal(deleteRequest.method, 'DELETE');
  failRequest(deleteRequest, 409, errorEnvelope('OBJECT_UNAVAILABLE'));
  await settle();

  const row = rowOf(h.page, 'external_inference');
  assert.equal(row.state, 'granted', '失败后状态不变');
  assert.equal(row.errorCode, 'OBJECT_UNAVAILABLE', '码原样到界面');
  assert.match(row.errorText, /OBJECT_UNAVAILABLE/);
  assert.equal(row.actionDisabled, true, '撤回消费者未接线 ⇒ 如实置灰');
  assert.match(row.actionReason, /只撤一半/);
});

test('B7 409 REVISION_CONFLICT 不置灰（可重试）+ 码原样到界面', async () => {
  const h = createHarness();
  openPage(h, [record({ purpose: 'recording', state: 'granted', revision: 3 })],
    { body: { version: POLICY_VERSION, purposes: ALL_PURPOSES, recipients: [], training_enabled: false } });
  await settle();
  tap(h.page, 'recording');
  okPage(h.requests.at(-1), [record({ purpose: 'recording', state: 'granted', revision: 4 })]);
  await settle();
  failRequest(h.requests.at(-1), 409, errorEnvelope('REVISION_CONFLICT'));
  await settle();
  const row = rowOf(h.page, 'recording');
  assert.equal(row.errorCode, 'REVISION_CONFLICT');
  assert.match(row.errorText, /409 REVISION_CONFLICT/);
  assert.equal(row.actionDisabled, false, '版本冲突是"再读一次就能重试"的情形，不置灰');
  assert.equal(row.state, 'granted');
});

test('B8 空清单：服务端确实 0 条 ⇒ 四行都是「未授权」，不是错误', async () => {
  const h = createHarness();
  openPage(h, []);
  await settle();
  assert.deepEqual(plain(h.page.data.items), []);
  assert.equal(h.page.data.errorText, '', '空清单不是错误');
  assert.equal(h.page.data.errorCode, '');
  for (const purpose of ALL_PURPOSES) {
    const row = rowOf(h.page, purpose);
    assert.equal(row.state, 'none');
    assert.equal(row.stateLabel, '未授权');
  }
});

test('B9 读面失败：清单清空 + 错误码，四行全部置灰并说明"没读到"，不冒充"没授权"', async () => {
  const h = createHarness();
  h.page.onShow();
  const listRequest = h.requests[0];
  ok(h.requests[1], { version: POLICY_VERSION, purposes: ALL_PURPOSES, recipients: [], training_enabled: false });
  failRequest(listRequest, 503, errorEnvelope('PROVIDER_UNAVAILABLE'));
  await settle();

  assert.deepEqual(plain(h.page.data.items), [], '读失败必须清空');
  assert.equal(h.page.data.errorCode, 'PROVIDER_UNAVAILABLE', '契约码原样带出');
  assert.notEqual(h.page.data.errorText, '', '读失败必须有可见原因');
  for (const purpose of ALL_PURPOSES) {
    const row = rowOf(h.page, purpose);
    assert.equal(row.actionDisabled, true, `${purpose}：连当前状态都不知道，不许给动作`);
    // `external_inference` 本来就有自己的置灰理由（必须选已核验接收方），它不会被"清单没读到"覆盖；
    // 其余三个用途的置灰理由必须点名"清单没读到"并带上服务端码。
    if (purpose === 'external_inference') continue;
    assert.match(row.actionReason, /PROVIDER_UNAVAILABLE/, `${purpose}：置灰原因带码`);
  }
  const before = h.requests.length;
  tap(h.page, 'recording');
  assert.equal(h.requests.length, before, '读面失败后点击不得发请求');
});

test('B10 政策读面失败（503）：四行全部置灰并说明是"政策没读到"，且不发写请求', async () => {
  const h = createHarness();
  openPage(h, [], 'fail');
  await settle();
  assert.match(h.page.data.policyError, /PROVIDER_UNAVAILABLE/, '政策读失败必须如实给出码');
  for (const purpose of ALL_PURPOSES) {
    const row = rowOf(h.page, purpose);
    assert.equal(row.actionDisabled, true);
    assert.match(row.actionReason, /政策尚未读取成功/);
  }
  const before = h.requests.length;
  tap(h.page, 'recording');
  assert.equal(h.requests.length, before, '没有政策版本就不发 POST');
});

test('B11 unpublished：服务端尚无已发布政策 ⇒ 全部置灰，原因写清是"尚无已发布政策"', async () => {
  const h = createHarness();
  openPage(h, [], 'unpublished');
  await settle();
  assert.equal(h.page.data.policyVersion, 'unpublished');
  for (const purpose of ALL_PURPOSES) {
    const row = rowOf(h.page, purpose);
    assert.equal(row.actionDisabled, true);
    assert.match(row.actionReason, /尚无已发布/);
  }
});
