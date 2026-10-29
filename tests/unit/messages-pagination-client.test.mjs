import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { runInNewContext } from 'node:vm';

// #28/#17 消息页分页与刷新并发：装载**真实页面** `miniprogram/pages/messages/messages.js`
// + 真实 `utils/messages-api.js` / `utils/auth.js` / `utils/page-gate.js`，请求由合成 wx 记录、
// 由用例逐条决定成功/失败与先后次序（可控 Promise），不外发。
// 合成 wx 只证明客户端状态机行为，不是微信工具或真机证据。
const root = resolve(import.meta.dirname, '../..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const expires = () => new Date(Date.now() + 3600_000).toISOString();

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const STALE = '33333333-3333-4333-8333-333333333333';
const MESSAGE_META = { request_id: '99999999-9999-4999-8999-999999999999', contract_version: '1.0.0', execution_mode: 'stub' };
const envelope = (data) => ({ data, meta: MESSAGE_META });
const errorEnvelope = (code) => ({ error: { code, message: 'm', retryable: false, details: [] }, meta: MESSAGE_META });
const message = (over = {}) => ({
  id: FIRST, revision: 1, type: 'moderation', target_ref: { type: 'post', id: 'post-1', revision: 2 },
  reference_state: 'unavailable', read_at: null, created_at: '2026-10-16T04:00:00.000Z', ...over,
});
const flush = async (times = 8) => { for (let i = 0; i < times; i += 1) await Promise.resolve(); };
const pathOf = (request) => request.url.replace('https://synthetic.invalid/api/v1', '');

function harness() {
  const storage = new Map();
  const requests = [];
  const toasts = [];
  const cache = new Map();
  const wx = {
    getStorageSync: (key) => storage.get(key) || '',
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    login: (options) => options.success({ code: 'synthetic-code' }),
    request: (options) => requests.push(options),
    reLaunch: () => {},
    switchTab: () => {},
    navigateTo: () => {},
    showModal: (options) => options.success({ confirm: true }),
    showToast: (options) => toasts.push(options.title),
    getAppBaseInfo: () => ({ fontSizeSetting: 16 }),
    getSystemInfoSync: () => ({ fontSizeSetting: 16 }),
  };
  const app = { globalData: { fontScale: 1 } };
  const context = { wx, console: { warn: () => {}, log: () => {}, info: () => {}, error: () => {} }, getApp: () => app };
  function load(path) {
    path = resolve(path);
    if (path.endsWith('config\\runtime.js') || path.endsWith('config/runtime.js')) {
      return { mode: 'local', apiBaseUrl: 'https://synthetic.invalid/api/v1' };
    }
    if (cache.has(path)) return cache.get(path).exports;
    const module = { exports: {} };
    cache.set(path, module);
    const wrapper = runInNewContext('(function(require,module,exports){' + readFileSync(path, 'utf8') + '\n})', context, { filename: path });
    wrapper((relative) => load(resolve(dirname(path), relative + '.js')), module, module.exports);
    return module.exports;
  }
  const auth = load(resolve(root, 'miniprogram/utils/auth.js'));
  function page(name) {
    let definition;
    context.Page = (value) => { definition = value; };
    load(resolve(root, `miniprogram/pages/${name}/${name}.js`));
    const instance = { ...definition, data: { ...definition.data } };
    instance.setData = (patch) => Object.assign(instance.data, patch);
    return instance;
  }
  function login() {
    auth.login((error) => assert.equal(error, null));
    requests.at(-1).success({ statusCode: 200, data: envelope({ access_token: 'synthetic-token', audience: 'user', expires_at: expires() }) });
    assert.equal(auth.isLoggedIn(), true);
    requests.length = 0;
  }
  return { auth, page, login, requests, toasts };
}

/** 门禁核实通过后，页面已发出「列表」与「未读数」两条读取请求。 */
async function openedMessagesPage(h) {
  const page = h.page('messages');
  page.onLoad();
  page.onShow();
  assert.equal(h.requests.length, 1, '门禁之前只允许会话核实请求');
  h.requests[0].success({ statusCode: 200, data: envelope({ audience: 'user', expires_at: expires() }) });
  await flush();
  return page;
}

/** 第一页就绪、带 `cursor-1`，此时可以翻页。 */
async function readyPage(h) {
  const page = await openedMessagesPage(h);
  h.requests[1].success({ statusCode: 200, data: envelope({ items: [message()], next_cursor: 'cursor-1' }) });
  h.requests[2].success({ statusCode: 200, data: envelope({ count: 1 }) });
  await flush();
  assert.equal(page.data.status, 'ready');
  assert.equal(page.data.nextCursor, 'cursor-1');
  return page;
}

test('旧分页在飞 → 刷新成功：旧成功晚到不得污染新列表/游标，且新分页能用新游标发出', async () => {
  const h = harness();
  h.login();
  const page = await readyPage(h);

  page.onLoadMore();
  const stale = h.requests.at(-1);
  assert.equal(pathOf(stale), '/messages?cursor=cursor-1');
  assert.equal(page.data.loadingMore, true, '翻页在飞时必须置忙锁');

  page.reload();
  const refreshed = h.requests.at(-1);
  assert.equal(pathOf(refreshed), '/messages', '刷新必须从第一页重新读取');
  refreshed.success({ statusCode: 200, data: envelope({ items: [message({ id: SECOND })], next_cursor: 'cursor-2' }) });
  await flush();

  assert.equal(page.data.status, 'ready');
  assert.deepEqual(page.data.items.map((item) => item.id), [SECOND]);
  assert.equal(page.data.loadingMore, false, '刷新成功后必须解除旧分页留下的忙锁，否则用户永远点不动「加载更多」');

  // 旧分页成功晚到：epoch 不符 ⇒ 丢弃，不追加行、不改游标、不改忙锁。
  stale.success({ statusCode: 200, data: envelope({ items: [message({ id: STALE })], next_cursor: 'stale-cursor' }) });
  await flush();
  assert.deepEqual(page.data.items.map((item) => item.id), [SECOND], '旧分页行不得追加到新列表');
  assert.equal(page.data.nextCursor, 'cursor-2', '旧分页游标不得覆盖新游标');
  assert.equal(page.data.loadingMore, false);
  assert.equal(h.toasts.length, 0, '晚到的旧分页成功不提示');

  // 新分页：忙锁已解除，必须发出，且带刷新后的新游标。
  page.onLoadMore();
  const next = h.requests.at(-1);
  assert.equal(pathOf(next), '/messages?cursor=cursor-2', '新一轮翻页必须使用刷新后的新游标');
  next.success({ statusCode: 200, data: envelope({ items: [message({ id: STALE })], next_cursor: null }) });
  await flush();
  assert.deepEqual(page.data.items.map((item) => item.id), [SECOND, STALE]);
  assert.equal(page.data.nextCursor, null);
  assert.equal(page.data.loadingMore, false);
});

test('旧分页在飞 → 刷新成功：旧失败晚到不得弹提示、不得清游标或重载，忙锁保持解除', async () => {
  const h = harness();
  h.login();
  const page = await readyPage(h);

  page.onLoadMore();
  const stale = h.requests.at(-1);
  page.reload();
  const refreshed = h.requests.at(-1);
  refreshed.success({ statusCode: 200, data: envelope({ items: [message({ id: SECOND })], next_cursor: 'cursor-2' }) });
  await flush();
  assert.equal(page.data.loadingMore, false, '刷新成功后旧分页忙锁必须解除');

  const before = h.requests.length;
  stale.success({ statusCode: 503, data: errorEnvelope('PROVIDER_UNAVAILABLE') });
  await flush();

  assert.equal(h.toasts.length, 0, '旧 epoch 的失败不得弹误导提示');
  assert.equal(page.data.nextCursor, 'cursor-2', '旧分页失败不得清掉新列表的游标');
  assert.equal(page.data.items.length, 1, '旧分页失败不得改新列表');
  assert.equal(page.data.status, 'ready', '旧分页失败不得把新列表打成错误态');
  assert.equal(page.data.loadingMore, false, '旧分页失败不得把忙锁重新置忙');
  assert.equal(h.requests.length, before, '旧分页失败不得触发额外读取');
});

test('旧分页在飞 → 刷新成功：旧 INVALID_CURSOR 晚到不得重载新列表或弹「列表已过期」', async () => {
  const h = harness();
  h.login();
  const page = await readyPage(h);

  page.onLoadMore();
  const stale = h.requests.at(-1);
  page.reload();
  const refreshed = h.requests.at(-1);
  refreshed.success({ statusCode: 200, data: envelope({ items: [message({ id: SECOND })], next_cursor: 'cursor-2' }) });
  await flush();

  const before = h.requests.length;
  stale.success({ statusCode: 400, data: errorEnvelope('INVALID_CURSOR') });
  await flush();

  assert.equal(h.requests.length, before, '旧游标失效不得再触发一次第一页重载（新列表已经读好了）');
  assert.equal(page.data.nextCursor, 'cursor-2', '旧游标失效不得清掉新游标');
  assert.equal(h.toasts.length, 0, '旧 epoch 的失效不得弹「列表已过期，已重新载入」');
  assert.equal(page.data.status, 'ready');
  assert.equal(page.data.loadingMore, false);

  page.onLoadMore();
  assert.equal(pathOf(h.requests.at(-1)), '/messages?cursor=cursor-2', '新游标仍可继续翻页');
});

test('刷新后新分页自身 INVALID_CURSOR 的原语义保留：清死游标、重载第一页、如实提示', async () => {
  const h = harness();
  h.login();
  const page = await readyPage(h);

  page.onLoadMore();
  h.requests.at(-1).success({ statusCode: 400, data: errorEnvelope('INVALID_CURSOR') });
  await flush();

  assert.equal(page.data.nextCursor, null, '失效游标必须被清掉');
  assert.equal(pathOf(h.requests.at(-1)), '/messages', '失效后必须从第一页重载');
  assert.deepEqual(h.toasts, ['列表已过期，已重新载入']);
  h.requests.at(-1).success({ statusCode: 200, data: envelope({ items: [message({ id: SECOND })], next_cursor: 'cursor-2' }) });
  await flush();
  assert.equal(page.data.status, 'ready');
  assert.equal(page.data.loadingMore, false);
});
