/**
 * 注销账号：客户端入口的可执行判据（GY-R73 / issue #19 的用户可见部分）
 * ------------------------------------------------------------
 * 这一组用例只测**客户端**：申请要走两次确认、回执要用回执 bearer 而不是登录会话、
 * 取消成功回到未申请态、失败一律保留原状态。服务端行为由 `tests/privacy/*` 那些用例覆盖，
 * 这里把 `wx.request` 当替身，按契约封套回答。
 *
 * 三条负控制锚点（改坏就会红，报告里引用的就是这三条）：
 *   · 「取消失败保留回执原状态」/「网络失败保留原状态」← 把 `deletion.js` 的 `settleFailure`
 *     里 `hasReceipt ? 'ready' : ...` 改成固定 `'error'`；
 *   · 「二次确认的任一环说不都不发请求」← 删掉 `requestDeletion` 里的两次 `wx.showModal`；
 *   · 「回执 401 只表示凭据失效」← 把 `deletion-api.js` 的 `receiptError` 换成 `sessionError`
 *     （401 会走 `auth.failureFor` → `clearSession()`，用户被登出）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const flush = () => new Promise((r) => setImmediate(r));

const RECEIPT_KEY = 'gengyun.deletion.receipt';
const RECEIPT_ID = '3f1a9d0e-5b2c-4c7f-9c1d-7a8b9c0d1e2f';
const REQUEST_ID = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const TOKEN = 'rcpt-opaque-token-A';
const EXPIRES_AT = '2026-11-10T02:00:00.000Z';
const SESSION = 'synthetic-session-a';

const meta = (mode = 'real') => ({ request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: mode });
const deletion = (state = 'requested', revision = 1) => ({
  id: RECEIPT_ID,
  state,
  revision,
  requested_at: '2026-11-03T02:00:00.000Z',
  online_due_at: EXPIRES_AT,
  backup_due_at: '2026-12-03T02:00:00.000Z',
  handlers: [
    { module: 'profile', online_state: 'pending', backup_state: 'pending', third_party_state: null, error_code: null },
    { module: 'community', online_state: 'running', backup_state: 'pending', third_party_state: 'requested', error_code: null }
  ]
});
const accepted = (record = deletion()) => ({ receipt_token: TOKEN, receipt_expires_at: EXPIRES_AT, deletion: record });

/**
 * 与 `tests/unit/miniprogram-profile.test.mjs` 同一套夹具形状：vm 沙箱里跑真实页面源码，
 * `wx` 是替身，`runtime.js` 换成本地地址，`Page` 捕获页面对象。
 * 多出来的两处：`showModal` 按 `answers` 队列回答（默认同意），`answerJson` 能回任意封套。
 */
function fixture() {
  const storage = new Map();
  const requests = [];
  const routes = [];
  const modals = [];
  const answers = [];
  const cache = new Map();
  let page;
  const wx = {
    getStorageSync: (k) => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: (k) => storage.delete(k),
    request: (o) => requests.push(o),
    showModal: (o) => {
      modals.push(o);
      const confirm = answers.length ? answers.shift() : true;
      o.success({ confirm: confirm, cancel: !confirm });
    },
    reLaunch: (o) => routes.push(o.url),
    navigateTo: (o) => routes.push(o.url),
    showToast: () => {}
  };
  function load(path) {
    path = resolve(path);
    if (path.endsWith('runtime.js')) return { mode: 'local', apiBaseUrl: 'http://127.0.0.1:1234/api/v1' };
    if (cache.has(path)) return cache.get(path).exports;
    const m = { exports: {} };
    cache.set(path, m);
    vm.runInNewContext(
      '(function(require,module){' + readFileSync(path, 'utf8') + '\n})',
      {
        wx,
        Page: (d) => {
          page = {
            ...d,
            data: structuredClone(d.data),
            route: 'pages/deletion/deletion',
            options: {},
            setData(p) { Object.assign(this.data, p) }
          };
        },
        getCurrentPages: () => [page]
      }
    )((id) => load(resolve(dirname(path), /\.js$/.test(id) ? id : id + '.js')), m);
    return m.exports;
  }
  const auth = load(root + '/miniprogram/utils/auth.js');
  const api = load(root + '/miniprogram/utils/deletion-api.js');
  load(root + '/miniprogram/pages/deletion/deletion.js');
  page.onLoad();

  function answer(req, data) { req.success({ statusCode: 200, data: { data: data } }); }
  function answerJson(req, body, statusCode = 200) { req.success({ statusCode: statusCode, data: body }); }
  function fail(req) { req.fail({ errMsg: 'request:fail synthetic' }); }
  function last(path) { return requests.filter((r) => new URL(r.url).pathname.endsWith(path)).at(-1); }
  function count(method, path) {
    return requests.filter((r) => r.method === method && new URL(r.url).pathname.endsWith(path)).length;
  }
  function receiptReads() {
    return requests.filter((r) => new URL(r.url).pathname.includes('/account/deletions/')).length;
  }
  async function login(token = SESSION) {
    auth.setSession({
      accessToken: token,
      audience: 'user',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      executionMode: 'stub'
    });
    auth.verifySession(() => {});
    answer(last('/auth/session'), { audience: 'user', expires_at: new Date(Date.now() + 3600000).toISOString() });
    await flush();
    assert.equal(auth.isLoggedIn(), true, '夹具前置：会话必须已经服务端核实，否则后续断言测的是别的东西');
  }
  function storeReceipt(overrides) {
    return api.saveReceipt(Object.assign({
      id: RECEIPT_ID,
      token: TOKEN,
      expiresAt: EXPIRES_AT,
      deletion: deletion()
    }, overrides));
  }
  return { page, auth, api, wx, storage, requests, routes, modals, answers, answer, answerJson, fail, last, count, receiptReads, login, storeReceipt };
}

test('申请成功：两次确认后才发一次 POST，回执与本机凭据都取自服务端封套', async () => {
  const f = fixture();
  await f.login();
  f.page.onShow();
  assert.equal(f.page.data.status, 'empty', '已登录且本机没有在途回执 ⇒ empty');
  assert.equal(f.page.data.guest, false);

  f.page.onApply();
  assert.equal(f.modals.length, 2, '申请必须弹两次确认');
  assert.match(f.modals[0].content, /不可恢复/, '第一次确认必须说清后果');
  assert.match(f.modals[0].content, /以服务端返回的 deletion 字段为准/, '冷静期口径必须指向服务端字段，不能自己编天数');
  assert.match(f.modals[1].content, /确认申请注销|确认向服务端提交注销申请/);

  const post = f.last('/me/account/deletion');
  assert.equal(post.method, 'POST');
  assert.equal(post.data.confirmation, 'delete_account');
  assert.equal(post.header.authorization, 'Bearer ' + SESSION, '申请吃登录会话');
  assert.ok(post.header['Idempotency-Key'].length >= 8, '幂等键是契约要求的头');
  assert.equal('If-Match' in post.header, false, '这三个 operation 没有 If-Match，不该自发送');
  assert.equal(f.count('POST', '/me/account/deletion'), 1, '两次确认只对应一次提交');

  f.answerJson(post, { data: accepted(), meta: meta() }, 202);
  await flush();
  assert.equal(f.page.data.status, 'ready');
  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.receipt.id, RECEIPT_ID);
  assert.equal(f.page.data.receipt.stateLabel, '已提交，等待处理');
  assert.equal(f.page.data.receipt.revision, 1);
  assert.equal(f.page.data.receipt.rows.length, 2, 'handlers 原样投影成模块行');
  assert.ok(f.page.data.receiptExpiresAt.length > 0, '回执到期时间来自 receipt_expires_at');
  assert.equal(f.page.data.hasCredential, true);
  assert.equal(f.page.data.stubNotice, false);

  const stored = f.storage.get(RECEIPT_KEY);
  assert.equal(stored.id, RECEIPT_ID);
  assert.equal(stored.token, TOKEN, '回执 bearer 只落在本机存储，不进页面展示字段');
  assert.equal(JSON.stringify(f.page.data).includes(TOKEN), false, '回执 bearer 不得进入页面 data');
});

test('二次确认的任一环说不都不发请求（负控制锚点：删掉确认这一步会红）', async () => {
  const f = fixture();
  await f.login();
  f.page.onShow();

  f.answers.push(false);
  f.page.onApply();
  assert.equal(f.modals.length, 1, '第一框说不就不再弹第二框');
  assert.equal(f.count('POST', '/me/account/deletion'), 0);
  assert.equal(f.page.data.busy, false);
  assert.match(f.page.data.message, /没有提交/);
  assert.equal(f.page.data.status, 'empty', '取消确认不改变页面状态');

  f.answers.push(true, false);
  f.page.onApply();
  assert.equal(f.modals.length, 3);
  assert.equal(f.count('POST', '/me/account/deletion'), 0, '第二框说不也不许发请求');
  assert.equal(f.page.data.status, 'empty');
});

test('申请失败：落 error 且可重试，不写本机凭据、不假装已受理', async () => {
  const f = fixture();
  await f.login();
  f.page.onShow();
  f.page.onApply();
  f.answerJson(f.last('/me/account/deletion'), { error: { code: 'PROVIDER_UNAVAILABLE' } }, 503);
  await flush();
  assert.equal(f.page.data.status, 'error');
  assert.equal(f.page.data.errorCode, 'PROVIDER_UNAVAILABLE');
  assert.equal(f.page.data.retryable, true, 'fail-closed 是可重试的失败，不是永久拒绝');
  assert.match(f.page.data.errorText, /fail-closed/);
  assert.equal(f.page.data.receipt, null);
  assert.equal(f.storage.has(RECEIPT_KEY), false, '没受理就不许写凭据');
});

test('回执查询用的是回执 bearer，不是登录会话', async () => {
  const f = fixture();
  await f.login();
  f.storeReceipt();
  f.page.onShow();
  const get = f.last('/account/deletions/' + RECEIPT_ID);
  assert.equal(get.method, 'GET');
  assert.equal(get.header.authorization, 'Bearer ' + TOKEN);
  assert.notEqual(get.header.authorization, 'Bearer ' + SESSION, '回执面不许带登录令牌');

  f.answerJson(get, { data: deletion('processing', 3), meta: meta() }, 200);
  await flush();
  assert.equal(f.page.data.status, 'ready');
  assert.equal(f.page.data.receipt.stateLabel, '处理中');
  assert.equal(f.page.data.receipt.revision, 3);
  assert.equal(f.page.data.hasCredential, true);
  assert.equal(f.page.data.snapshotOnly, false);
  assert.equal(f.storage.get(RECEIPT_KEY).deletion.state, 'processing', '快照跟着刷新，下次失败才有东西可显示');
});

test('回执 401 只表示凭据失效：落 invalid 并清本机凭据，绝不把用户登出（负控制锚点）', async () => {
  const f = fixture();
  await f.login();
  f.storeReceipt();
  f.page.onShow();
  f.answerJson(f.last('/account/deletions/' + RECEIPT_ID), { error: { code: 'SESSION_EXPIRED' } }, 401);
  await flush();
  assert.equal(f.page.data.status, 'invalid');
  assert.equal(f.auth.isLoggedIn(), true, '回执面的 401 不得清登录会话');
  assert.equal(f.storage.has(RECEIPT_KEY), false, '凭据确实死了才丢弃');
  assert.equal(f.page.data.receipt, null);
  assert.equal(f.page.data.hasCredential, false);
  assert.match(f.page.data.errorText, /凭据/);
});

test('取消成功：两次确认后 DELETE 一次，回执作废、本机凭据清空、回到未申请态', async () => {
  const f = fixture();
  await f.login();
  f.storeReceipt();
  f.page.onShow();
  f.answerJson(f.last('/account/deletions/' + RECEIPT_ID), { data: deletion('requested', 1), meta: meta() }, 200);
  await flush();
  assert.equal(f.page.data.status, 'ready');

  f.page.onCancel();
  assert.equal(f.modals.length, 2, '取消也要两次确认');
  const del = f.requests.filter((r) => r.method === 'DELETE').at(-1);
  assert.equal(del.header.authorization, 'Bearer ' + SESSION);
  assert.ok(del.header['Idempotency-Key'].length >= 8);
  assert.equal('If-Match' in del.header, false);
  assert.equal(f.count('DELETE', '/me/account/deletion'), 1);

  f.answerJson(del, { data: deletion('cancelled', 2), meta: meta() }, 200);
  await flush();
  assert.equal(f.page.data.status, 'cancelled');
  assert.equal(f.page.data.receipt, null);
  assert.equal(f.page.data.hasCredential, false);
  assert.equal(f.storage.has(RECEIPT_KEY), false);
  assert.match(f.page.data.message, /没有被注销/);
});

test('取消失败保留回执原状态：不清屏、不丢凭据、给可见错误（负控制锚点）', async () => {
  const f = fixture();
  await f.login();
  f.storeReceipt();
  f.page.onShow();
  f.answerJson(f.last('/account/deletions/' + RECEIPT_ID), { data: deletion('requested', 1), meta: meta() }, 200);
  await flush();

  f.page.onCancel();
  f.fail(f.requests.filter((r) => r.method === 'DELETE').at(-1));
  await flush();
  assert.equal(f.page.data.status, 'ready', '失败必须保留原状态');
  assert.equal(f.page.data.receipt.id, RECEIPT_ID, '回执不许被抹掉');
  assert.equal(f.page.data.hasCredential, true);
  assert.equal(f.storage.get(RECEIPT_KEY).token, TOKEN, '失败不许丢凭据');
  assert.match(f.page.data.errorText, /结果不确定/);
  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.retryIntent, 'cancel');
});

test('网络失败保留原状态：刷新回执失败时回执照旧在屏，只标「上次读到的」', async () => {
  const f = fixture();
  await f.login();
  f.storeReceipt();
  f.page.onShow();
  f.answerJson(f.last('/account/deletions/' + RECEIPT_ID), { data: deletion('requested', 1), meta: meta() }, 200);
  await flush();

  f.page.onRefresh();
  f.fail(f.last('/account/deletions/' + RECEIPT_ID));
  await flush();
  assert.equal(f.page.data.status, 'ready');
  assert.equal(f.page.data.receipt.stateLabel, '已提交，等待处理');
  assert.equal(f.page.data.snapshotOnly, true, '这是上次读到的，必须标出来');
  assert.match(f.page.data.errorText, /网络没有拿到响应/);
  assert.equal(f.page.data.retryable, true, 'NETWORK_UNCERTAIN 在契约码表外，但这一面必须判可重试');
  assert.equal(f.page.data.retryIntent, 'read');
  assert.equal(f.auth.isLoggedIn(), true);
});

test('已有回执时申请失败（409）也不清屏：留在 ready 并提示可先刷新回执', async () => {
  const f = fixture();
  await f.login();
  f.storeReceipt();
  f.page.onShow();
  f.answerJson(f.last('/account/deletions/' + RECEIPT_ID), { data: deletion('requested', 1), meta: meta() }, 200);
  await flush();

  f.page.onApply();
  f.answerJson(f.last('/me/account/deletion'), { error: { code: 'OBJECT_UNAVAILABLE' } }, 409);
  await flush();
  assert.equal(f.page.data.status, 'ready');
  assert.equal(f.page.data.receipt.id, RECEIPT_ID);
  assert.match(f.page.data.errorText, /不可达/);
});

test('未登录游客：guest 态，点申请零请求、零写存储', async () => {
  const f = fixture();
  f.page.onShow();
  assert.equal(f.page.data.status, 'guest');
  assert.equal(f.page.data.guest, true);
  f.page.onApply();
  assert.equal(f.modals.length, 0, '未登录不该先弹确认再报错');
  assert.equal(f.requests.length, 0);
  assert.match(f.page.data.message, /需要先登录/);
  assert.equal(f.storage.size, 0);
});

test('本机凭据到期后本地直接丢弃、不再发注定 401 的请求', async () => {
  const f = fixture();
  await f.login();
  f.storeReceipt({ expiresAt: new Date(Date.now() - 60000).toISOString() });
  assert.equal(f.api.loadReceipt(), null);
  assert.equal(f.storage.has(RECEIPT_KEY), false);
  f.page.onShow();
  assert.equal(f.page.data.status, 'empty', '凭据没了就是没有在途回执，不是 error');
  assert.equal(f.receiptReads(), 0);
});

test('替身执行模式：回执照常展示，但顶部明确标出不是真实流转', async () => {
  const f = fixture();
  await f.login();
  f.storeReceipt();
  f.page.onShow();
  f.answerJson(f.last('/account/deletions/' + RECEIPT_ID), { data: deletion('requested', 1), meta: meta('stub') }, 200);
  await flush();
  assert.equal(f.page.data.status, 'ready');
  assert.equal(f.page.data.stubNotice, true);
  assert.equal(f.page.data.executionMode, 'stub');
});

test('九态闭集：页面的状态分支 ≡ docs/ui-state-inventory.md §2 九态表，且个人中心入口指向这一页', () => {
  const wxml = read('miniprogram/pages/deletion/deletion.wxml');
  const used = new Set(
    [...wxml.matchAll(/status="([a-z]+)"/g), ...wxml.matchAll(/status === '([a-z]+)'/g)].map((m) => m[1])
  );
  const documented = documentedStateKeys(read('docs/ui-state-inventory.md'));
  assert.deepEqual([...used].sort(), [...documented].sort(), '页面九态必须与文档 §2 的九态表集合相等');
  assert.equal(used.size, 9);

  // 每个状态在页面里都得有自己的可见文案出口，不能只写个分支名。
  assert.match(wxml, /status="stub"/);
  assert.match(wxml, /status="guest"/);
  assert.match(wxml, /status="loading"/);
  assert.match(wxml, /status="empty"/);
  assert.match(wxml, /status="cancelled"/);
  assert.match(wxml, /status="invalid"/);
  assert.match(wxml, /status="denied"/);
  assert.match(wxml, /status="error"/);
  assert.match(wxml, /status === 'ready'/);

  assert.match(read('miniprogram/pages/profile/profile.wxml'), /bindtap="openDeletion"/, '个人中心必须有入口');
  assert.match(
    read('miniprogram/pages/profile/profile.js'),
    /openDeletion: function \(\) \{\s*wx\.navigateTo\(\{ url: '\/pages\/deletion\/deletion' \}\)\s*\}/,
    '入口必须真的跳到注销页'
  );
});

/** 从 `docs/ui-state-inventory.md` §2 的状态表里取 key 列（第二列）。 */
function documentedStateKeys(doc) {
  const start = doc.indexOf('## 2 状态清单');
  assert.ok(start >= 0, '文档缺少 §2 状态清单');
  const rest = doc.slice(start + 1);
  const end = rest.indexOf('\n## ');
  const block = end === -1 ? rest : rest.slice(0, end);
  const keys = [];
  for (const line of block.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cell = (line.split('|')[2] || '').trim().replace(/`/g, '');
    if (cell && cell !== 'key' && !/^-+$/.test(cell)) keys.push(cell);
  }
  return keys;
}
