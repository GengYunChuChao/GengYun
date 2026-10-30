/**
 * GY-R70 · 撤回确认的**跨账号 / 跨可见周期**隔离（监工复查：写操作会跨账号生效）。
 *
 * 缺陷（监工原话，逐字）：
 * > `consent.js:112-113` onHide/onUnload 只调用 `pageGate.cancel`，不递增本页 `_epoch`；
 * > `onWithdraw:312-325` 的旧确认因此仍通过。撤回客户端随后按**当前**会话重取 revision 并 DELETE
 * > （`consent-api.js` `currentRecordOf`/`withdraw`），会把旧账号的确认变成对新账号的撤回。
 *
 * 本文件就是那份最小隔离检查的可跑版本：**真实**页面源码 + **真实** `consent-api` 源码 +
 * **真实** `page-gate` 源码，跑在 `vm` 沙箱里，只替身 `wx.request`（只入队，由用例显式回放或
 * 断言"根本没入队"）、`wx.showModal`（手动回放，让用例决定 success 什么时候回来）与
 * 会话读面（`getSession` / `sessionEpoch`，切账号 = 换令牌 + 递增世代，与 `auth.setSession`
 * 在令牌变化时递增 `generation` 同形）。无真实网络、无用户数据、无供应商、无 PG。
 *
 * ## 先红后绿（读数见 `docs/verification/gy-r70-consent-client-20261030.md` 第 10 节）
 *
 * 在**修改前**的 HEAD（916aa99e）上跑本文件：C1 / C2 / C4 / C5 / C7 红，红点都是同一件事 ——
 * 过期的确认仍然进了写链路，`wx.request` 真的收到了 `GET /me/consents?limit=50` 与
 * `DELETE /me/consents/recording`。修好后 7/7 绿。
 *
 * ## 钉住的口径
 *
 * 1. **确认绑发起时的可见周期**：`onHide` / `onUnload` / 重进 / 门禁关闭都递增本页世代，
 *    旧确认随之作废（C2 / C4 / C6）。
 * 2. **确认绑会话身份**：页面世代没变、账号换了 ⇒ 同样作废（C5）。客户端拿不到 `userId`
 *    （契约禁止客户端声明身份），所以身份是「访问令牌 + 会话世代」这一对可观测事实，
 *    两者任一变化都算换了账号。
 * 3. **过期确认不得发 GET/DELETE**：断言的是"确认之后一条请求都没入队"，不是"发了但失败了"。
 * 4. **⛔ 不静默**：丢弃必须给出可见原因（`actionText` + 行内 `errorText` + 客户端码），
 *    不得假装成功、不得静默刷新。
 *
 * ## 不能证明什么（如实登记）
 *
 * 微信编译器与真机未跑；`wx.showModal` 是替身，所以**不证明**真机上"弹窗还在时切账号"的时序
 * 一定是这样发生的。它证明的是：**只要**旧确认在切账号/离页之后回来，本页不会用新会话的令牌
 * 去读或去写。也不证明服务端的授权隔离（那是 `services/api/src/**` 的范围，本片一行未动）。
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
const PURPOSE = 'recording';
const ALL_PURPOSES = ['recording', 'media_processing', 'external_inference', 'public_posting'];
const TOKEN_A = 'token-A-account-a';
const TOKEN_B = 'token-B-account-b';

function meta(mode) {
  return { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: mode || 'real' };
}
function envelope(data, mode) {
  return { data: data, meta: meta(mode) };
}
function pageEnvelope(items, nextCursor) {
  return { data: { items: items, next_cursor: nextCursor === undefined ? null : nextCursor }, meta: meta('real') };
}
let recordSeq = 0;
function record(overrides) {
  recordSeq += 1;
  return Object.assign({
    id: '3f6c9b8e-1d2a-4c7b-9e51-8a0b2c4d6e' + String(recordSeq).padStart(2, '0'),
    purpose: PURPOSE,
    policy_version: POLICY_VERSION,
    recipient_ids: [],
    state: 'granted',
    epoch: 1,
    revision: 7,
    granted_at: '2026-10-20T08:00:00Z',
    withdrawn_at: null,
  }, overrides || {});
}
const withdrawnRecord = (revision) => record({
  purpose: PURPOSE, state: 'withdrawn', revision: revision, withdrawn_at: '2026-10-30T01:00:00Z',
});

function plain(value) { return JSON.parse(JSON.stringify(value)); }
const flush = () => new Promise(resolve => setImmediate(resolve));
async function settle() { await flush(); await flush(); }

/** 载入真实源文件到独立 realm，注入 `wx` 替身与依赖表（未登记依赖直接抛错，不悄悄换成 mock）。 */
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

/**
 * 会话读面替身：`session` 是当前账号的令牌，`generation` 是会话世代。
 * 切账号 = 换令牌 + 世代 +1（真 `utils/auth.js` 的 `setSession` 在令牌变化时正是这样递增 `generation`）。
 */
function createHarness() {
  const requests = [];
  const modals = [];
  let session = { accessToken: TOKEN_A };
  let generation = 1;
  const auth = {
    getSession: () => session,
    isLoggedIn: () => !!session,
    sessionEpoch: () => 'generation:' + generation,
    networkEnabled: () => true,
    clearSession: () => { session = null; generation += 1; },
    attribution: realAuth.attribution,
    failureFor: (...args) => realAuth.failureFor(...args),
    isSessionLossCode: realAuth.isSessionLossCode,
    isForbiddenCode: realAuth.isForbiddenCode,
    requireLogin: callback => { if (callback) callback(true); },
  };
  const wx = {
    // 只入队，不自动成功：用例要么显式回放，要么断言"根本没入队"。
    request: request => { requests.push(request); },
    // 弹窗手动回放：由用例决定 success 什么时候回来、回来时是确认还是取消。
    showModal: modal => { modals.push(modal); },
  };
  // 真实 `utils/page-gate.js` 的替身。`cancel` **只**把门禁关掉、**不**回调页面：真模块会通过
  // `_gateClose` 让页面再 `invalidate()` 一次，那道兜底会把"onHide 自己有没有递增世代"盖住。
  // 监工的原话是「onHide/onUnload 只调用 pageGate.cancel，不递增本页 `_epoch`」——
  // 这里就按那句话来：`cancel` 不回调，世代只能由 `onHide`/`onUnload` 自己递增。
  const pageGate = {
    start(page, callback) {
      page._gateActive = true;
      page._gateClose = () => callback(false);
      callback(true);
    },
    cancel(page) {
      page._gateActive = false;
      page.setData({ gatePassed: false });
    },
  };
  const api = loadModule('miniprogram/utils/consent-api.js', {
    './auth': auth,
    '../config/runtime': { apiBaseUrl: 'http://127.0.0.1:4318/api/v1' },
  }, wx);

  let definition = null;
  loadModule('miniprogram/pages/consent/consent.js', {
    '../../utils/font-scale': { DEFAULT_FONT_SCALE: 1, applyFontScale() {} },
    '../../utils/auth': auth,
    '../../utils/page-gate': pageGate,
    '../../utils/consent-api': api,
  }, wx, { Page: pageDefinition => { definition = pageDefinition; } });
  assert.ok(definition, '授权清单页必须调用 Page(...)');
  const page = {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch); },
  };
  for (const key of Object.keys(definition)) {
    if (key !== 'data') page[key] = definition[key];
  }

  return {
    api, auth, wx, pageGate, page, requests, modals,
    get generation() { return generation; },
    currentToken: () => (session ? session.accessToken : null),
    switchAccount(token) { session = { accessToken: token }; generation += 1; },
  };
}

function ok(request, data, statusCode) {
  assert.ok(request, '期望有一条在途请求可以回放，实际没有（夹具失配必须显式失败）');
  request.success({ statusCode: statusCode || 200, data: envelope(data) });
}
function okPage(request, items, nextCursor) {
  assert.ok(request, '期望有一条在途清单请求可以回放，实际没有');
  request.success({ statusCode: 200, data: pageEnvelope(items, nextCursor) });
}
/** 回放一个契约错误封套（服务端 `error.code` 原样）。 */
function errorEnvelope(code) {
  return { error: { code: code, message: 'synthetic', retryable: false, details: [] }, meta: meta('real') };
}
function failRequest(request, statusCode, body) {
  assert.ok(request, '期望有一条在途请求可以回放，实际没有');
  request.success({ statusCode: statusCode, data: body });
}

/** 进入页面并喂两份读面（清单 + 政策）；政策里四个用途都有 ⇒ 行不会因"没政策"置灰。 */
function openPage(harness, items) {
  harness.page.onShow();
  assert.equal(harness.requests.length, 2, '进入页面应同时发起「读清单」与「读政策」两条请求');
  const listRequest = harness.requests[0];
  const policyRequest = harness.requests[1];
  assert.match(listRequest.url, /\/me\/consents\?limit=20$/);
  assert.match(policyRequest.url, /\/me\/privacy-policy$/);
  ok(policyRequest, { version: POLICY_VERSION, purposes: ALL_PURPOSES, recipients: [], training_enabled: false });
  okPage(listRequest, items);
  assert.equal(harness.page.data.gatePassed, true, '门禁通过后才可能有动作');
}

function rowOf(page, purpose) {
  return plain(page.data.rows).filter(row => row.purpose === purpose)[0];
}
function tap(page, purpose) {
  page.onRowAction({ currentTarget: { dataset: { purpose: purpose } } });
}
/**
 * 确认之后"一条请求都没入队"的强断言（不是"发了但失败了"）。
 * 读数里带上每条请求实际用的令牌 —— 缺陷的现场事实正是"用的是**新**账号的令牌"。
 */
function assertNoRequestsAfter(harness, baseline, message) {
  const after = harness.requests.slice(baseline).map(request => request.method + ' ' + request.url +
    ' [' + ((request.header && request.header.authorization) || '无令牌') + ']');
  assert.deepEqual(after, [], message);
}

// ===========================================================================
// C1 · 监工的最小隔离检查（跨账号）
// ===========================================================================
test('C1 复现：A 打开撤回确认 → onHide → 切到 B → 旧 confirm 返回 true ⇒ GET 与 DELETE 都不发', async () => {
  const h = createHarness();
  openPage(h, [record({ purpose: PURPOSE, state: 'granted', revision: 7 })]);
  await settle();

  const baseline = h.requests.length;
  tap(h.page, PURPOSE);
  assert.equal(h.modals.length, 1, '撤回必须先弹二次确认');
  const modal = h.modals[0];
  assert.equal(h.requests.length, baseline, '未确认前不得发任何请求');

  // 监工现场：A 打开弹窗 → onHide（门禁关掉）→ 合成会话切到 B。
  h.page.onHide();
  assert.equal(h.page.data.gatePassed, false, '离页后门禁不再通过');
  h.switchAccount(TOKEN_B);
  assert.equal(h.currentToken(), TOKEN_B, '此后一切请求都会带 B 的令牌');

  modal.success({ confirm: true, cancel: false });
  await settle();

  assertNoRequestsAfter(h, baseline, '过期确认不得发出任何请求：既不许 GET（取 revision），也不许 DELETE');
  assert.equal(h.requests.filter(request => request.method === 'DELETE').length, 0, '不得把旧账号的确认变成对新账号的撤回');
  assert.equal(rowOf(h.page, PURPOSE).state, 'granted', '状态不得被"写成功"改写');
});

// ===========================================================================
// C2 · 只离页（不重进、不换账号）：可见周期已变
// ===========================================================================
test('C2 同账号离页未重进：onHide 必须递增本页世代，旧 confirm 同样不发请求', async () => {
  const h = createHarness();
  openPage(h, [record({ purpose: PURPOSE, state: 'granted', revision: 7 })]);
  await settle();

  const baseline = h.requests.length;
  const epochBefore = h.page._epoch;
  tap(h.page, PURPOSE);
  const modal = h.modals[0];

  h.page.onHide();
  assert.ok(
    h.page._epoch > epochBefore,
    `onHide 必须递增本页可见周期世代（改前 ${epochBefore}、改后 ${h.page._epoch}；监工读数：_epoch 仍为 1）`,
  );

  // 会话没变（同账号、同令牌、同世代）：这一条只能靠"可见周期已变"拦住。
  modal.success({ confirm: true, cancel: false });
  await settle();

  assertNoRequestsAfter(h, baseline, '离页后的旧确认不得发 GET/DELETE（可见周期已变）');
  assert.equal(rowOf(h.page, PURPOSE).errorCode, 'PAGE_CYCLE_CHANGED', '丢弃要给出明确原因码，不是静默');
  assert.match(rowOf(h.page, PURPOSE).errorText, /可见周期|离开/, '行内要写清为什么没撤回');
});

// ===========================================================================
// C3 · 正常路径：同账号、同周期、确认 ⇒ GET+DELETE 各一次
// ===========================================================================
test('C3 正常路径：同账号同周期确认 ⇒ GET 与 DELETE 各一次，If-Match 取到当前 revision，写后重读清单', async () => {
  const h = createHarness();
  openPage(h, [record({ purpose: PURPOSE, state: 'granted', revision: 7 })]);
  await settle();

  const baseline = h.requests.length;
  tap(h.page, PURPOSE);
  h.modals[0].success({ confirm: true, cancel: false });

  const getRequest = h.requests[baseline];
  assert.equal(getRequest.method, 'GET', '撤回先取当前 revision');
  assert.match(getRequest.url, /\/me\/consents\?limit=50$/, '取 revision 用最大页长读清单');
  assert.equal(getRequest.header.authorization, 'Bearer ' + TOKEN_A, '用发起确认时那个账号的令牌');
  okPage(getRequest, [record({ purpose: PURPOSE, state: 'granted', revision: 9 })]);
  await settle();

  const deleteRequest = h.requests.at(-1);
  assert.equal(deleteRequest.method, 'DELETE');
  assert.equal(deleteRequest.url, 'http://127.0.0.1:4318/api/v1/me/consents/' + PURPOSE);
  assert.equal(deleteRequest.header['If-Match'], '"9"', 'If-Match 必须是这次读到的当前 revision');
  assert.equal(deleteRequest.header.authorization, 'Bearer ' + TOKEN_A);
  ok(deleteRequest, withdrawnRecord(10));
  await settle();

  const reread = h.requests.at(-1);
  assert.equal(reread.method, 'GET', '写成功后按服务端记录重新读取清单');
  okPage(reread, [withdrawnRecord(10)]);
  await settle();

  assert.equal(h.requests.length, baseline + 3, '恰好三条：取 revision 的 GET + DELETE + 重读清单的 GET');
  assert.equal(rowOf(h.page, PURPOSE).state, 'withdrawn', '状态来自服务端重新读取');
  assert.match(h.page.data.actionText, /已撤回/);
  assert.equal(rowOf(h.page, PURPOSE).errorText, '', '正常路径不写失败原因');
});

// ===========================================================================
// C4 · onUnload
// ===========================================================================
test('C4 onUnload：页面销毁后旧 confirm 返回 true ⇒ 不发请求，也不往已销毁的页面写"成功"', async () => {
  const h = createHarness();
  openPage(h, [record({ purpose: PURPOSE, state: 'granted', revision: 7 })]);
  await settle();

  const baseline = h.requests.length;
  const epochBefore = h.page._epoch;
  tap(h.page, PURPOSE);
  const modal = h.modals[0];

  h.page.onUnload();
  assert.ok(h.page._epoch > epochBefore, 'onUnload 同样必须递增本页可见周期世代');

  modal.success({ confirm: true, cancel: false });
  await settle();

  assertNoRequestsAfter(h, baseline, '销毁后的旧确认不得发 GET/DELETE');
  assert.equal(h.page.data.actionText, '', '已销毁的页面没有界面可写：不得留下"已撤回"这类成功文案');
});

// ===========================================================================
// C5 · 账号变化（页面仍可见、世代未变）
// ===========================================================================
test('C5 账号变化（页面仍可见、世代未变）⇒ 丢弃 + 明确的界面原因（⛔ 不静默）', async () => {
  const h = createHarness();
  openPage(h, [record({ purpose: PURPOSE, state: 'granted', revision: 7 })]);
  await settle();

  const baseline = h.requests.length;
  const epochBefore = h.page._epoch;
  tap(h.page, PURPOSE);
  const modal = h.modals[0];

  // 只换账号：不离页、不重进 ⇒ 世代不变。这一条只能靠会话身份拦。
  h.switchAccount(TOKEN_B);
  assert.equal(h.page._epoch, epochBefore, '账号切换本身不改变本页世代（所以必须另外绑会话身份）');

  modal.success({ confirm: true, cancel: false });
  await settle();

  assertNoRequestsAfter(h, baseline, '账号变了 ⇒ 连取 revision 的 GET 都不发');
  assert.equal(h.page.data.actionCode, 'SESSION_CHANGED', '页面级要给出客户端原因码');
  assert.match(h.page.data.actionText, /账号|会话/, '界面必须说清是账号/会话变了');
  assert.match(h.page.data.actionText, /没有发出/, '界面必须说明没有发出请求');
  assert.match(h.page.data.actionText, /未撤回/, '界面必须说清这件事没做成');

  const row = rowOf(h.page, PURPOSE);
  assert.equal(row.errorCode, 'SESSION_CHANGED', '行内也带原因码');
  assert.match(row.errorText, /账号|会话/, '行内也写清原因');
  assert.equal(row.busy, false, '丢弃后不许把行留在"进行中"');
  assert.equal(row.state, 'granted', '状态不变（没有任何写发生）');
});

// ===========================================================================
// C6 · 同账号、离页后重新可见
// ===========================================================================
test('C6 同账号 onHide → 重新可见：旧 confirm 不得发请求（可见周期已变）', async () => {
  const h = createHarness();
  openPage(h, [record({ purpose: PURPOSE, state: 'granted', revision: 7 })]);
  await settle();

  const baseline = h.requests.length;
  tap(h.page, PURPOSE);
  const modal = h.modals[0];

  h.page.onHide();
  h.page.onShow();
  // 重进会重新读两份读面：回放掉，别让它们悬着干扰后续断言。
  assert.equal(h.requests.length - baseline, 2, '重进会重新读「清单 + 政策」');
  okPage(h.requests[baseline], [record({ purpose: PURPOSE, state: 'granted', revision: 7 })]);
  ok(h.requests[baseline + 1], { version: POLICY_VERSION, purposes: ALL_PURPOSES, recipients: [], training_enabled: false });
  await settle();
  const reopened = h.requests.length;

  modal.success({ confirm: true, cancel: false });
  await settle();

  assertNoRequestsAfter(h, reopened, '重新可见之后的旧确认同样不得发 GET/DELETE');
});

// ===========================================================================
// C7 · 一次性令牌
// ===========================================================================
test('C7 一次性确认令牌：同一弹窗回调重复触发只发一次；令牌只在本页内存里，不随请求发出', async () => {
  const h = createHarness();
  openPage(h, [record({ purpose: PURPOSE, state: 'granted', revision: 7 })]);
  await settle();

  const baseline = h.requests.length;
  tap(h.page, PURPOSE);
  const pending = h.page._pendingConfirm;
  assert.ok(pending, '点「撤回」时必须生成一次性的 `_pendingConfirm`（确认令牌）');
  assert.equal(typeof pending.token, 'string');
  assert.ok(pending.token.length >= 8, '令牌要够长，不至于撞车');
  assert.equal(pending.purpose, PURPOSE, '令牌绑用途');
  assert.equal(pending.epoch, h.page._epoch, '令牌绑发起时的页面可见周期');
  const confirmToken = pending.token;

  const modal = h.modals[0];
  modal.success({ confirm: true, cancel: false });
  modal.success({ confirm: true, cancel: false }); // 重复回调（框架/用户侧重复投递）

  okPage(h.requests[baseline], [record({ purpose: PURPOSE, state: 'granted', revision: 5 })]);
  await settle();
  ok(h.requests.at(-1), withdrawnRecord(6));
  await settle();
  okPage(h.requests.at(-1), [withdrawnRecord(6)]);
  await settle();

  assert.equal(h.requests.filter(request => request.method === 'DELETE').length, 1, '重复回调不得变成第二次撤回');
  assert.equal(h.requests.length, baseline + 3, '重复回调只多出"取 revision + DELETE + 重读"三条，不许多');
  assert.equal(
    h.requests.some(request => JSON.stringify(request.header || {}).includes(confirmToken)),
    false,
    '确认令牌只在本页内存里区分"这一次确认"，不得随任何请求发出',
  );
  assert.equal(
    h.requests.some(request => String(request.url).includes(confirmToken)),
    false,
    '确认令牌也不得出现在 URL 里',
  );
});

// ===========================================================================
// C8 / C9 · 适配层的 `guard`：链路每一步都复验（页面只判一次是不够的）
// ===========================================================================
test('C8 适配层：guard 判定不成立 ⇒ 连「取 revision」的 GET 都不发（链路入口就停）', { timeout: 10000 }, async () => {
  const h = createHarness();
  const pending = h.api.withdraw({
    purpose: PURPOSE,
    guard: () => ({ code: 'SESSION_CHANGED', text: '会话已变（用例指定）' }),
  });
  // 先看**同步的入口**：判定不成立时这条 GET 一条都不许入队（把它放在 await 之前，缺陷会立刻
  // 以"请求数 1"暴露，而不是让用例挂在一条没人回放的请求上）。
  assert.deepEqual(
    h.requests.map(request => request.method + ' ' + request.url),
    [],
    '入口判定不成立 ⇒ 一条请求都不许发（过期确认不得发出取 revision 的 GET）',
  );
  await assert.rejects(pending, error => {
    assert.equal(error.code, 'CONFIRM_STALE', '过期确认走客户端前置码，不冒充服务端码');
    assert.equal(error.reason.code, 'SESSION_CHANGED', '调用方给的原因原样带出（页面据此说清为什么）');
    return true;
  });
  assert.equal(h.requests.length, 0, '入口判定不成立 ⇒ 一条请求都不许发');
});

test('C9 适配层：428 之后「补取」那一步同样复验 ⇒ 补取的 GET 不发，抛 CONFIRM_STALE', { timeout: 10000 }, async () => {
  const h = createHarness();
  let calls = 0;
  const pending = h.api.withdraw({
    purpose: PURPOSE,
    // 入口 + DELETE 前两次都还是有效的；补取那一步之前过期。
    guard: () => { calls += 1; return calls <= 2 ? '' : { code: 'PAGE_CYCLE_CHANGED', text: '可见周期已变（用例指定）' }; },
  });
  okPage(h.requests.at(-1), [record({ purpose: PURPOSE, state: 'granted', revision: 7 })]);
  await settle();
  const deleteRequest = h.requests.at(-1);
  assert.equal(deleteRequest.method, 'DELETE');
  failRequest(deleteRequest, 428, errorEnvelope('REVISION_REQUIRED'));
  // 先挂上结论断言（不留一个"没人接"的拒绝），再让微任务跑完、检查补充请求有没有入队：
  // 缺陷会以请求数暴露，而不是把用例挂住或炸成未处理的拒绝。
  const outcome = assert.rejects(pending, error => error.code === 'CONFIRM_STALE', '补取那一步过期必须丢弃，不重试');
  await settle();
  assert.equal(h.requests.filter(request => request.method === 'GET').length, 1, '补取那条 GET 不得发出（只有一开始取 revision 的那一条）');
  assert.equal(h.requests.filter(request => request.method === 'DELETE').length, 1, '428 的 DELETE 只发过一次');
  await outcome;
});
