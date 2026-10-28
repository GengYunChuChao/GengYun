/**
 * 渲染级用例：`ModerationQueueView.vue`（社区审核队列）的**真实 SFC 呈现路径**。
 *
 * 为什么必须渲染级：`admin-ui-moderation-queue.test.mjs` 只覆盖 `lib/admin-moderation-queue.mjs` 的纯函数，
 * 覆盖不到「到底渲染出几行」「403 到底有没有上屏」「空数组到底有没有空态」「approve 之后那一行长什么样」
 * —— 而这四条正是本片要证明的东西。
 *
 * `apps/admin` 没有 vitest / @vue/test-utils / jsdom（仓内前端测试一律纯函数），
 * 所以沿用 `tests/unit/admin-ui-audit-logs-render.test.mjs` 的最小渲染环境，**不新增依赖、不联网**：
 *   1. `@vue/compiler-sfc` 把 `.vue` 编成 ESM（`inlineTemplate: true`，关静态提升与事件缓存），
 *      把裸模块说明符换成 `file:` / `data:` 绝对 URL；
 *   2. `../auth/session`（.ts）换成一个只读桩模块，通过 `globalThis.__GY_TEST_SESSION__` 注入会话；
 *   3. `vue` 的 `createRenderer()` 造内存宿主，挂**真实组件**，网络层用 `globalThis.fetch` 桩。
 *
 * 断言口径：有数据就得有 N 行；403 必须是 `role="alert"` 的明确提示且**不得**同时出现表格或空态；
 * 空数组必须是空态而不是错误；approve 成功后那一行的审核态必须真的变；动作失败（403/409）必须有可见提示。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { compileScript, parse } from '@vue/compiler-sfc';
import { createRenderer, nextTick } from 'vue';

if (globalThis.document === undefined) globalThis.document = { activeElement: null };
if (globalThis.Document === undefined) globalThis.Document = class Document {};
if (globalThis.ShadowRoot === undefined) globalThis.ShadowRoot = class ShadowRoot {};

const VIEW_URL = new URL('../../apps/admin/src/views/ModerationQueueView.vue', import.meta.url);
const LIB_URL = new URL('../../apps/admin/src/lib/admin-moderation-queue.mjs', import.meta.url);
const VUE_URL = import.meta.resolve('vue');

const SESSION = {
  accessToken: 'synthetic-admin-token',
  expiresAt: '2099-01-01T00:00:00.000Z',
  scopes: ['sources:read', 'sources:write'],
};
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const POST_ID = '3f1d2c9a-1111-4222-8333-444455556666';
const OTHER_ID = '3f1d2c9a-1111-4222-8333-444455557777';

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
}

/**
 * `apps/admin/src/auth/session.ts` 的桩：只提供本页用到的四个导出。
 * 真实模块要用 `import.meta.env` 与 `sessionStorage`，node 里跑不了，也不该在本用例里跑。
 */
const SESSION_STUB_URL = moduleUrl(`
export const ADMIN_AUTH_API_IMPLEMENTED = true;
export const API_BASE_URL = '/api/v1';
export function loadAdminSession() {
  return Promise.resolve(globalThis.__GY_TEST_SESSION__ ?? null);
}
export function signInAdmin() {
  const session = globalThis.__GY_TEST_SESSION__ ?? null;
  return session === null ? Promise.reject(new Error('后台登录失败：SESSION_REQUIRED')) : Promise.resolve(session);
}
export function signOutAdmin() {
  globalThis.__GY_TEST_SESSION__ = null;
  return Promise.resolve();
}
`);

let componentPromise = null;

function loadViewComponent() {
  if (componentPromise !== null) return componentPromise;
  const source = readFileSync(VIEW_URL, 'utf8');
  const { descriptor, errors } = parse(source, { filename: fileURLToPath(VIEW_URL) });
  assert.deepEqual(errors, [], 'ModerationQueueView.vue 必须能被 @vue/compiler-sfc 解析');
  const compiled = compileScript(descriptor, {
    id: 'gy-moderation-queue-render',
    inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false, cacheHandlers: false } },
  });
  const escape = (specifier) => specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const code = compiled.content
    .replace(/from\s+["']vue["']/g, `from '${VUE_URL}'`)
    .replace(new RegExp(`from\\s+["']${escape('../auth/session')}["']`, 'g'), `from '${SESSION_STUB_URL}'`)
    .replace(new RegExp(`from\\s+["']${escape('../lib/admin-moderation-queue.mjs')}["']`, 'g'), `from '${LIB_URL.href}'`);
  assert.deepEqual(
    [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]).filter((spec) => !/^(data:|file:)/.test(spec)),
    [],
    '编译产物里不得残留裸模块说明符（data: 模块无法解析它们）',
  );
  componentPromise = import(moduleUrl(code)).then((namespace) => namespace.default);
  return componentPromise;
}

/** 内存宿主：节点足够支撑 Vue 的元素/文本/注释与事件 prop。 */
function createHost() {
  const make = (kind) => ({
    kind,
    children: [],
    parent: null,
    props: {},
    text: '',
    listeners: new Map(),
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    },
    removeEventListener(type) {
      this.listeners.delete(type);
    },
    getRootNode() {
      return globalThis.document;
    },
    dispatch(type, event = {}) {
      const handler = this.listeners.get(type);
      return handler === undefined ? undefined : handler({ target: this, ...event });
    },
  });

  const insert = (child, parent, anchor = null) => {
    const previous = child.parent;
    if (previous !== null) {
      const index = previous.children.indexOf(child);
      if (index !== -1) previous.children.splice(index, 1);
    }
    child.parent = parent;
    if (anchor === null) {
      parent.children.push(child);
      return;
    }
    const index = parent.children.indexOf(anchor);
    if (index === -1) parent.children.push(child);
    else parent.children.splice(index, 0, child);
  };

  const nodeOps = {
    insert,
    remove(node) {
      const parent = node.parent;
      if (parent === null) return;
      const index = parent.children.indexOf(node);
      if (index !== -1) parent.children.splice(index, 1);
      node.parent = null;
    },
    createElement: (type) => make(String(type)),
    createText: (text) => {
      const node = make('#text');
      node.text = text;
      return node;
    },
    createComment: (text) => {
      const node = make('#comment');
      node.text = text;
      return node;
    },
    setText(node, text) {
      node.text = text;
    },
    setElementText(el, text) {
      el.children = [];
      if (text !== '') insert(nodeOps.createText(text), el);
    },
    parentNode: (node) => node.parent,
    nextSibling(node) {
      const parent = node.parent;
      if (parent === null) return null;
      const index = parent.children.indexOf(node);
      return index === -1 || index + 1 >= parent.children.length ? null : parent.children[index + 1];
    },
    querySelector: () => null,
    setScopeId: () => {},
  };

  return { make, nodeOps, patchProp: (el, key, previous, next) => { el.props[key] = next; } };
}

async function settle() {
  await nextTick();
  await new Promise((resolve) => setImmediate(resolve));
  await nextTick();
}

function findAll(root, predicate, hits = []) {
  if (predicate(root)) hits.push(root);
  for (const child of root.children) findAll(child, predicate, hits);
  return hits;
}

function findBy(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children) {
    const hit = findBy(child, predicate);
    if (hit !== null) return hit;
  }
  return null;
}

function textOf(node) {
  if (node.kind === '#text') return node.text;
  return node.children.map(textOf).join('');
}

const byTestId = (id) => (node) => node.props['data-testid'] === id;
const countOf = (root, id) => findAll(root, byTestId(id)).length;

function jsonResponse(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body };
}

function meta() {
  return { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'real' };
}

function page(items, nextCursor = null) {
  return { data: { items, next_cursor: nextCursor }, meta: meta() };
}

function errorEnvelope(code, message, retryable = false) {
  return { error: { code, message, retryable, details: [] }, meta: meta() };
}

function adminPost(overrides = {}) {
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

function reviewOutcome(overrides = {}) {
  return {
    id: POST_ID,
    revision: 4,
    audit_state: 'approved',
    // 服务端真实可达形态（`admin/ops/community-posts.ts:327-328`）：private 帖通过后就是 published。
    visibility: 'published',
    decision: 'approved',
    changed: true,
    notified: false,
    reason_codes: [],
    ...overrides,
  };
}

/**
 * 路由式 fetch 桩：按 method + URL 分派列表 / 详情 / 动作，并记下每次调用。
 * 详情用可变 `current`，这样动作成功后页面再读一次详情能看到新 revision。
 */
function routedFetch({ list, current, action }) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, init, method });
    if (method === 'POST') return action({ url, init });
    if (/^\/api\/v1\/admin\/posts\?/.test(url)) return list({ url, init });
    if (/^\/api\/v1\/admin\/posts\/[0-9a-f-]{36}$/.test(url)) {
      return { json: async () => ({ data: current.post, meta: meta() }), ok: true, status: 200, headers: new Headers({ etag: current.etag }) };
    }
    throw new Error(`未预期的请求：${method} ${url}`);
  };
  impl.calls = calls;
  return impl;
}

async function mountView({ fetchImpl } = {}) {
  const host = createHost();
  const container = host.make('root');
  const { createApp } = createRenderer({ ...host.nodeOps, patchProp: host.patchProp });
  const originalFetch = globalThis.fetch;
  if (fetchImpl !== undefined) globalThis.fetch = fetchImpl;
  globalThis.__GY_TEST_SESSION__ = SESSION;
  const app = createApp(await loadViewComponent());
  app.mount(container);
  await settle();
  return {
    container,
    unmount() {
      app.unmount();
      globalThis.fetch = originalFetch;
      globalThis.__GY_TEST_SESSION__ = null;
    },
  };
}

const passThrough = ({ url, init }) => {
  void url;
  void init;
  throw new Error('本用例不该发起动作请求');
};

test('3 条帖子 ⇒ 渲染 3 行（不是 0 行、也不是错误态）', async () => {
  const fetchImpl = routedFetch({
    list: () =>
      jsonResponse(
        200,
        page([
          adminPost({ id: POST_ID }),
          adminPost({ id: OTHER_ID, title: '大棚番茄灰霉病用药', audit_state: 'rejected', visibility: 'hidden' }),
          adminPost({ id: '3f1d2c9a-1111-4222-8333-444455558888', title: '水稻二化螟', audit_state: 'approved', visibility: 'published' }),
        ]),
      ),
    current: { post: adminPost(), etag: '"3"' },
    action: passThrough,
  });
  const mounted = await mountView({ fetchImpl });
  try {
    assert.equal(countOf(mounted.container, 'moderation-row'), 3, '3 条帖子必须渲染 3 行');
    const status = findBy(mounted.container, byTestId('moderation-status'));
    assert.ok(status !== null, '必须渲染状态条');
    assert.equal(status.props.role, 'status');
    assert.match(textOf(status), /已读取 3 条/);
    assert.equal(findBy(mounted.container, byTestId('moderation-empty')), null, '有数据时不得同时显示空态');
    const pageText = textOf(mounted.container);
    assert.match(pageText, /社区审核队列/, '标题');
    assert.match(pageText, /GET \/admin\/posts/);
    assert.match(pageText, /listAdminPosts/);
    assert.match(pageText, /sources:read/);
    assert.match(pageText, /2026-10-23 08:12:33Z/, '时间按 UTC 稳定渲染');
    assert.match(pageText, /pending（待审）/, '审核态用中文标签');
    assert.match(pageText, /rejected（已驳回）/, '不同审核态分别渲染');
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, '/api/v1/admin/posts?limit=20');
    assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer synthetic-admin-token');
  } finally {
    mounted.unmount();
  }
});

test('403 SCOPE_DENIED ⇒ role="alert" 的明确提示，且既无表格也无空态', async () => {
  const fetchImpl = routedFetch({
    list: () => jsonResponse(403, errorEnvelope('SCOPE_DENIED', '缺少所需权限：sources:read')),
    current: { post: adminPost(), etag: '"3"' },
    action: passThrough,
  });
  const mounted = await mountView({ fetchImpl });
  try {
    const status = findBy(mounted.container, byTestId('moderation-status'));
    assert.ok(status !== null, '403 必须有提示（不得白屏）');
    assert.equal(status.props.role, 'alert', '403 必须是 alert 语义');
    const statusText = textOf(status);
    assert.match(statusText, /权限不足/);
    assert.match(statusText, /sources:read/, '403 文案必须写清缺哪个 scope');
    assert.equal(countOf(mounted.container, 'moderation-row'), 0);
    assert.equal(findBy(mounted.container, byTestId('moderation-empty')), null, '403 不得被渲染成空队列');
    assert.equal(findBy(mounted.container, byTestId('moderation-table')), null, '403 不渲染表格');
    const code = findBy(mounted.container, byTestId('moderation-error-code'));
    assert.ok(code !== null, '必须显示错误码');
    assert.match(textOf(code), /SCOPE_DENIED/);
    assert.equal(countOf(mounted.container, 'moderation-retry'), 0, '403 不给「重试」——重试同一个无权会话没有意义');
    assert.ok(findBy(mounted.container, byTestId('moderation-sign-out')) !== null, '必须给出可走的下一步（退出登录换账号）');
  } finally {
    mounted.unmount();
  }
});

test('空数组 ⇒ 空态（说清「空队列，不是错误」），不是错误态', async () => {
  const fetchImpl = routedFetch({
    list: () => jsonResponse(200, page([], null)),
    current: { post: adminPost(), etag: '"3"' },
    action: passThrough,
  });
  const mounted = await mountView({ fetchImpl });
  try {
    assert.equal(countOf(mounted.container, 'moderation-row'), 0);
    const empty = findBy(mounted.container, byTestId('moderation-empty'));
    assert.ok(empty !== null, '空数组必须渲染空态');
    const emptyText = textOf(empty);
    assert.match(emptyText, /审核队列为空/);
    assert.match(emptyText, /不是错误/);
    const status = findBy(mounted.container, byTestId('moderation-status'));
    assert.equal(status.props.role, 'status', '空态是 status，不是 alert');
    assert.equal(countOf(mounted.container, 'moderation-retry'), 0, '空队列不是错误，不给重试按钮');
  } finally {
    mounted.unmount();
  }
});

test('筛选栏参数名是契约的 state 与 audit_state（⛔ 不出现 entity／entity_type）', async () => {
  const fetchImpl = routedFetch({
    list: () => jsonResponse(200, page([adminPost()])),
    current: { post: adminPost(), etag: '"3"' },
    action: passThrough,
  });
  const mounted = await mountView({ fetchImpl });
  try {
    assert.ok(findBy(mounted.container, byTestId('moderation-filter-state')) !== null, '必须有 state 筛选');
    assert.ok(findBy(mounted.container, byTestId('moderation-filter-audit-state')) !== null, '必须有 audit_state 筛选');
    assert.ok(findBy(mounted.container, byTestId('moderation-filter-limit')) !== null, '必须有每页条数');
    const pageText = textOf(mounted.container);
    assert.doesNotMatch(pageText, /entity/);
    for (const value of ['private', 'published', 'hidden', 'deleted', 'pending', 'quarantined']) {
      assert.match(pageText, new RegExp(value), `筛选闭集必须包含 ${value}`);
    }
    assert.match(pageText, /换筛选必须回第一页/, '必须写明游标与筛选绑定');
  } finally {
    mounted.unmount();
  }
});

test('503（服务端 retryable:false）⇒ alert 且不给重试；retryable:true ⇒ 才给重试', async () => {
  const closed = routedFetch({
    list: () => jsonResponse(503, errorEnvelope('PROVIDER_UNAVAILABLE', '帖子读面尚未接线', false)),
    current: { post: adminPost(), etag: '"3"' },
    action: passThrough,
  });
  const first = await mountView({ fetchImpl: closed });
  try {
    const status = findBy(first.container, byTestId('moderation-status'));
    assert.equal(status.props.role, 'alert');
    assert.match(textOf(status), /服务暂不可用/);
    assert.equal(findBy(first.container, byTestId('moderation-empty')), null, '503 不得被渲染成空队列');
    assert.equal(countOf(first.container, 'moderation-row'), 0);
    assert.equal(countOf(first.container, 'moderation-retry'), 0, '服务端声明不可重试时不得给重试按钮');
    assert.match(textOf(status), /不可自动重试/);
  } finally {
    first.unmount();
  }

  const open = routedFetch({
    list: () => jsonResponse(503, errorEnvelope('PROVIDER_UNAVAILABLE', '暂时过载', true)),
    current: { post: adminPost(), etag: '"3"' },
    action: passThrough,
  });
  const second = await mountView({ fetchImpl: open });
  try {
    assert.equal(countOf(second.container, 'moderation-retry'), 1, '服务端明说可重试时必须有重试按钮');
    assert.match(textOf(findBy(second.container, byTestId('moderation-status'))), /稍后重试/);
  } finally {
    second.unmount();
  }
});

test('点行 ⇒ 调 getAdminPost 并在面板里显示正文与审核态', async () => {
  const fetchImpl = routedFetch({
    list: () => jsonResponse(200, page([adminPost()])),
    current: { post: adminPost(), etag: '"3"' },
    action: passThrough,
  });
  const mounted = await mountView({ fetchImpl });
  try {
    const row = findBy(mounted.container, byTestId('moderation-row'));
    assert.ok(typeof row.props.onClick === 'function', '行必须可点（父行 @click 承担入口）');
    row.props.onClick({});
    await settle();

    const panel = findBy(mounted.container, byTestId('moderation-detail'));
    assert.ok(panel !== null, '点行后必须出现详情面板');
    const panelText = textOf(panel);
    assert.match(panelText, /早上打药比中午好/, '面板必须显示正文');
    assert.match(panelText, /pending/, '面板必须显示审核态');
    assert.match(panelText, /"3"/, '面板必须显示 ETag');
    const detailCalls = fetchImpl.calls.filter((call) => call.method === 'GET' && /\/admin\/posts\/[0-9a-f-]{36}$/.test(call.url));
    assert.equal(detailCalls.length, 1, '点行必须读一次 getAdminPost');
    assert.equal(detailCalls[0].url, `/api/v1/admin/posts/${POST_ID}`);
  } finally {
    mounted.unmount();
  }
});

test('approve 成功 ⇒ 该行审核态变成 approved（回执 changed:true，并重读详情）', async () => {
  const current = { post: adminPost(), etag: '"3"' };
  const fetchImpl = routedFetch({
    list: () => jsonResponse(200, page([adminPost(), adminPost({ id: OTHER_ID, title: '另一条待审帖' })])),
    current,
    action: () => {
      // 服务端通过动作会把 private 帖推到 published（`admin/ops/community-posts.ts:327-328`），
      // 所以重读出来的详情必须是 published——旧夹具留 'private' 是服务端不会返回的状态。
      current.post = adminPost({ revision: 4, audit_state: 'approved', visibility: 'published' });
      current.etag = '"4"';
      return jsonResponse(200, { data: reviewOutcome(), meta: meta() }, { etag: '"4"' });
    },
  });
  const mounted = await mountView({ fetchImpl });
  try {
    findBy(mounted.container, byTestId('moderation-row')).props.onClick({});
    await settle();
    findBy(mounted.container, byTestId('moderation-approve')).props.onClick({});
    await settle();

    const rows = findAll(mounted.container, byTestId('moderation-row'));
    assert.equal(rows.length, 2, '仍应是两行');
    assert.match(textOf(rows[0]), /approved（已通过）/, '第一行的审核态必须真的变了');
    assert.doesNotMatch(textOf(rows[0]), /pending（待审）/, '旧状态不得残留在同一行里');
    assert.match(textOf(rows[1]), /pending（待审）/, '别的行不动');

    const notice = findBy(mounted.container, byTestId('moderation-action-notice'));
    assert.ok(notice !== null, '成功后必须有回执条');
    assert.equal(notice.props.role, 'status');
    assert.match(textOf(notice), /已写入审核结论：通过/);
    // 新文案语义（钉住）：private 帖通过后回执必须说「已公开」，且**不得**再出现与服务端相反的那句。
    assert.match(textOf(notice), /published（已公开）/, '通过后回执必须显示服务端返回的 published');
    assert.match(textOf(notice), /private ⇒ published/, '回执必须说清 private 帖通过后会变 published');
    assert.doesNotMatch(textOf(notice), /不改可见性/, '旧句「通过不改可见性」与服务端事实相反，不得复活');
    assert.match(textOf(findBy(mounted.container, byTestId('moderation-detail'))), /published（已公开）/, '详情面板的可见性也要跟着回执走');

    const actionCalls = fetchImpl.calls.filter((call) => call.method === 'POST');
    assert.equal(actionCalls.length, 1);
    assert.equal(actionCalls[0].url, `/api/v1/admin/posts/${POST_ID}/approve`);
    assert.equal(actionCalls[0].init.body, undefined, 'approve 契约里没有请求体');
    assert.equal(actionCalls[0].init.headers['if-match'], '"3"', 'If-Match 取操作前的 revision');
    assert.match(actionCalls[0].init.headers['idempotency-key'], /^admin-moderation-/);
    assert.equal(
      fetchImpl.calls.filter((call) => /\/admin\/posts\/[0-9a-f-]{36}$/.test(call.url)).length,
      2,
      '成功后应重读一次详情（拿真实 ETag）',
    );
    assert.match(textOf(findBy(mounted.container, byTestId('moderation-detail'))), /"4"/);
  } finally {
    mounted.unmount();
  }
});

test('详情脚注：通过会把 private 推到 published（不得再写「不改可见性」）', async () => {
  const fetchImpl = routedFetch({
    list: () => jsonResponse(200, page([adminPost()])),
    current: { post: adminPost(), etag: '"3"' },
    action: passThrough,
  });
  const mounted = await mountView({ fetchImpl });
  try {
    findBy(mounted.container, byTestId('moderation-row')).props.onClick({});
    await settle();
    const footText = textOf(findBy(mounted.container, byTestId('moderation-detail')));
    assert.match(footText, /approve 写 audit_state=approved/, '脚注必须说 approve 写 audit_state=approved');
    assert.match(footText, /从 private 推到 published/, '脚注必须说清通过会把 private 推到 published');
    assert.doesNotMatch(footText, /不改可见性/, '旧句「通过不改可见性」与服务端事实相反，不得复活');
    assert.match(footText, /reject 同时把 visibility 置为 hidden/, '驳回置 hidden 的说法要保留（服务端确实如此）');
  } finally {
    mounted.unmount();
  }
});

test('approve 一条已 hidden 的帖 ⇒ 回执仍是 hidden（不为通过翻案），且不得出现「已公开」', async () => {
  // 服务端单向门：`hidden`／`deleted` 不被通过动作翻案（`admin/ops/community-posts.ts` 的 `review()`）。
  const current = { post: adminPost({ visibility: 'hidden' }), etag: '"3"' };
  const fetchImpl = routedFetch({
    list: () => jsonResponse(200, page([adminPost({ visibility: 'hidden' })])),
    current,
    action: () => {
      current.post = adminPost({ revision: 4, audit_state: 'approved', visibility: 'hidden' });
      current.etag = '"4"';
      return jsonResponse(200, { data: reviewOutcome({ visibility: 'hidden', notified: true }), meta: meta() }, { etag: '"4"' });
    },
  });
  const mounted = await mountView({ fetchImpl });
  try {
    findBy(mounted.container, byTestId('moderation-row')).props.onClick({});
    await settle();
    findBy(mounted.container, byTestId('moderation-approve')).props.onClick({});
    await settle();

    const notice = findBy(mounted.container, byTestId('moderation-action-notice'));
    assert.ok(notice !== null, '成功后必须有回执条');
    const noticeText = textOf(notice);
    assert.match(noticeText, /visibility=hidden（已隐藏）/, 'hidden 帖通过后必须仍是 hidden');
    assert.doesNotMatch(noticeText, /已公开/, 'hidden 帖通过后不得出现「已公开」');
    assert.doesNotMatch(noticeText, /不改可见性/, '旧句「通过不改可见性」与服务端事实相反，不得复活');
  } finally {
    mounted.unmount();
  }
});

test('approve 回 changed:false ⇒ 如实说「已是该状态」，行与详情都不动', async () => {
  const current = { post: adminPost({ audit_state: 'approved', revision: 4 }), etag: '"4"' };
  const fetchImpl = routedFetch({
    list: () => jsonResponse(200, page([adminPost({ audit_state: 'approved', revision: 4 })])),
    current,
    action: () => jsonResponse(200, { data: reviewOutcome({ changed: false, revision: 4 }), meta: meta() }),
  });
  const mounted = await mountView({ fetchImpl });
  try {
    findBy(mounted.container, byTestId('moderation-row')).props.onClick({});
    await settle();
    findBy(mounted.container, byTestId('moderation-approve')).props.onClick({});
    await settle();

    const notice = findBy(mounted.container, byTestId('moderation-action-notice'));
    assert.ok(notice !== null, 'changed:false 仍要给回执');
    const noticeText = textOf(notice);
    assert.match(noticeText, /changed:false/);
    assert.match(noticeText, /已是/);
    assert.doesNotMatch(noticeText, /已写入审核结论/, '不得把 changed:false 显示成刚刚成功');
    assert.equal(
      fetchImpl.calls.filter((call) => /\/admin\/posts\/[0-9a-f-]{36}$/.test(call.url)).length,
      1,
      'changed:false 不该再重读详情（没有新 ETag）',
    );
    assert.equal(current.post.revision, 4, '本地也没有被改成别的 revision');
  } finally {
    mounted.unmount();
  }
});

test('动作失败 403 ⇒ 可见的 alert 写清缺 sources:write；409 ⇒ 可见的修订冲突提示', async () => {
  const forbidden = routedFetch({
    list: () => jsonResponse(200, page([adminPost()])),
    current: { post: adminPost(), etag: '"3"' },
    action: () => jsonResponse(403, errorEnvelope('SCOPE_DENIED', '缺少所需权限：sources:write')),
  });
  const first = await mountView({ fetchImpl: forbidden });
  try {
    findBy(first.container, byTestId('moderation-row')).props.onClick({});
    await settle();
    findBy(first.container, byTestId('moderation-approve')).props.onClick({});
    await settle();
    const alert = findBy(first.container, byTestId('moderation-action-error'));
    assert.ok(alert !== null, '动作失败必须有可见提示');
    assert.equal(alert.props.role, 'alert');
    assert.match(textOf(alert), /sources:write/);
    assert.equal(findBy(first.container, byTestId('moderation-action-notice')), null, '失败时不得同时显示成功回执');
    assert.match(textOf(findAll(first.container, byTestId('moderation-row'))[0]), /pending（待审）/, '失败不改本地行');
  } finally {
    first.unmount();
  }

  const conflict = routedFetch({
    list: () => jsonResponse(200, page([adminPost()])),
    current: { post: adminPost(), etag: '"3"' },
    action: () => jsonResponse(409, errorEnvelope('REVISION_CONFLICT', '帖子修订已变化，If-Match 与当前 ETag 不匹配')),
  });
  const second = await mountView({ fetchImpl: conflict });
  try {
    findBy(second.container, byTestId('moderation-row')).props.onClick({});
    await settle();
    // reject 必须先选闭集内的理由，否则本地就拦下了，走不到服务端 409
    findBy(second.container, byTestId('moderation-reason')).props.onChange({ target: { value: 'spam' } });
    await settle();
    findBy(second.container, byTestId('moderation-reject')).props.onClick({});
    await settle();
    const alert = findBy(second.container, byTestId('moderation-action-error'));
    assert.ok(alert !== null);
    assert.equal(alert.props.role, 'alert');
    assert.match(textOf(alert), /REVISION_CONFLICT/);
    assert.match(textOf(alert), /重新读取详情/);
    const sent = conflict.calls.filter((call) => call.method === 'POST');
    assert.equal(sent.length, 1, '选了理由就必须真的发出去');
    assert.equal(sent[0].init.body, '{"reason_code":"spam"}', 'reject 必须把闭集内的理由作为请求体发出去');
  } finally {
    second.unmount();
  }
});

test('reject 未选理由 ⇒ 本地就拦下（不发请求、不假装成功）', async () => {
  const fetchImpl = routedFetch({
    list: () => jsonResponse(200, page([adminPost()])),
    current: { post: adminPost(), etag: '"3"' },
    action: passThrough,
  });
  const mounted = await mountView({ fetchImpl });
  try {
    findBy(mounted.container, byTestId('moderation-row')).props.onClick({});
    await settle();
    findBy(mounted.container, byTestId('moderation-reject')).props.onClick({});
    await settle();
    const alert = findBy(mounted.container, byTestId('moderation-action-error'));
    assert.ok(alert !== null, '缺理由必须有可见提示');
    assert.match(textOf(alert), /reason_code/);
    assert.equal(fetchImpl.calls.filter((call) => call.method === 'POST').length, 0, '本地已拦下，不得发请求');
    assert.equal(findBy(mounted.container, byTestId('moderation-action-notice')), null);
  } finally {
    mounted.unmount();
  }
});

test('应用筛选 ⇒ URL 带 state 与 audit_state，且无条件回第一页（无 cursor）', async () => {
  const fetchImpl = routedFetch({
    list: () => jsonResponse(200, page([adminPost()], 'cursor-from-server')),
    current: { post: adminPost(), etag: '"3"' },
    action: passThrough,
  });
  const mounted = await mountView({ fetchImpl });
  try {
    // 先续一页，制造「当前不在第一页」的状态
    findBy(mounted.container, byTestId('moderation-load-more')).props.onClick({});
    await settle();
    assert.match(fetchImpl.calls.at(-1).url, /cursor=cursor-from-server/);

    findBy(mounted.container, byTestId('moderation-filter-state')).props.onChange({ target: { value: 'hidden' } });
    findBy(mounted.container, byTestId('moderation-filter-audit-state')).props.onChange({ target: { value: 'pending' } });
    await settle();
    // 应用筛选是 form 的 submit（`@submit.prevent`），按钮本身没有 click handler
    findBy(mounted.container, byTestId('moderation-filters')).props.onSubmit({ preventDefault() {} });
    await settle();

    const last = fetchImpl.calls.at(-1).url;
    assert.equal(last, '/api/v1/admin/posts?limit=20&state=hidden&audit_state=pending', '换筛选必须回第一页');
    assert.doesNotMatch(last, /cursor=/, '不得把旧游标带进新筛选');
  } finally {
    mounted.unmount();
  }
});
