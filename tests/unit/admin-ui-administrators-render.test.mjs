/**
 * 渲染级用例：`AdministratorsView.vue`（管理员权限读面）的**真实 SFC 呈现路径**。
 *
 * 为什么必须渲染级：`admin-ui-administrators.test.mjs` 只覆盖 `lib/admin-administrators.mjs`
 * 的纯函数；覆盖不到「列表到底渲染出几行」「点开某人后 scopes 面板到底有没有那几条」
 * 「403 到底有没有上屏」「空数组到底有没有空态」——而这四条正是本片要证明的东西。
 *
 * 沿用 `tests/unit/admin-ui-post-takedown-render.test.mjs` 的最小渲染环境（不新增依赖、不联网）：
 * `@vue/compiler-sfc` 编译 SFC → 说明符换成 `file:`/`data:` URL → `createRenderer()` 内存宿主挂真组件，
 * 网络层用 `globalThis.fetch` 桩。本页没有 props，会话从 `../auth/session` 的桩模块注入。
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

const VIEW_URL = new URL('../../apps/admin/src/views/AdministratorsView.vue', import.meta.url);
const LIB_URL = new URL('../../apps/admin/src/lib/admin-administrators.mjs', import.meta.url);
const VUE_URL = import.meta.resolve('vue');

const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID_2 = '33333333-3333-4333-8333-333333333333';
const SESSION = { accessToken: 'synthetic-admin-token', expiresAt: '2099-01-01T00:00:00.000Z', scopes: ['scopes:read'] };
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
}

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
  assert.deepEqual(errors, [], 'AdministratorsView.vue 必须能被 @vue/compiler-sfc 解析');
  const compiled = compileScript(descriptor, {
    id: 'gy-administrators-render',
    inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false, cacheHandlers: false } },
  });
  const escape = (specifier) => specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const code = compiled.content
    .replace(/from\s+["']vue["']/g, `from '${VUE_URL}'`)
    .replace(new RegExp(`from\\s+["']${escape('../auth/session')}["']`, 'g'), `from '${SESSION_STUB_URL}'`)
    .replace(new RegExp(`from\\s+["']${escape('../lib/admin-administrators.mjs')}["']`, 'g'), `from '${LIB_URL.href}'`);
  assert.deepEqual(
    [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]).filter((spec) => !/^(data:|file:)/.test(spec)),
    [],
    '编译产物里不得残留裸模块说明符（data: 模块无法解析它们）',
  );
  componentPromise = import(moduleUrl(code)).then((namespace) => namespace.default);
  return componentPromise;
}

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

/** 触发一次按钮点击：自定义 renderer 把 `onClick` 存进 props。 */
async function click(node) {
  assert.equal(typeof node.props.onClick, 'function', '待点击节点必须是绑定了 onClick 的按钮');
  node.props.onClick();
  await settle();
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body };
}

const meta = { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'real' };

function administratorPage(items, nextCursor = null) {
  return { data: { items, next_cursor: nextCursor }, meta };
}

function scopesEnvelope(scopes) {
  return { data: { scopes }, meta };
}

function errorEnvelope(code, message, retryable = false) {
  return { error: { code, message, retryable, details: [] }, meta };
}

function administrator(overrides = {}) {
  return {
    id: ADMIN_ID,
    login_name: 'chen_yun',
    state: 'active',
    scopes: ['audit:read', 'scopes:read'],
    ...overrides,
  };
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, method: init === undefined ? undefined : init.method });
    return handler({ url, init });
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

test('2 个管理员 ⇒ 渲染 2 行；点「查看权限」后按 admin_accounts.id 读 scopes 并列出 2 条', async () => {
  const fetchImpl = fakeFetch(({ url }) => {
    if (String(url).endsWith(`/admin/administrators/${ADMIN_ID}/scopes`)) {
      return jsonResponse(200, scopesEnvelope(['audit:read', 'scopes:read']));
    }
    return jsonResponse(
      200,
      administratorPage([
        administrator(),
        administrator({ id: ADMIN_ID_2, login_name: 'li_wei', state: 'suspended', scopes: ['flags:read'] }),
      ]),
    );
  });
  const mounted = await mountView({ fetchImpl });
  try {
    assert.equal(countOf(mounted.container, 'administrators-row'), 2, '2 个管理员必须渲染 2 行');
    const status = findBy(mounted.container, byTestId('administrators-status'));
    assert.ok(status !== null, '必须渲染状态条');
    assert.equal(status.props.role, 'status');
    assert.match(textOf(status), /已读取 2 个管理员/);
    assert.equal(findBy(mounted.container, byTestId('administrators-empty')), null, '有数据时不得同时显示空态');

    const pageText = textOf(mounted.container);
    assert.match(pageText, /管理员权限读面/, '标题与 capability map 命名一致');
    assert.match(pageText, /listAdministrators/);
    assert.match(pageText, /listAdministratorScopes/);
    assert.match(pageText, /scopes:read/);
    assert.match(pageText, /admin_accounts\.id/, '必须写明 id 来源，避免与 users.id 混淆');
    assert.match(pageText, /chen_yun/);
    assert.match(pageText, /li_wei/);
    assert.match(pageText, /已暂停/, 'suspended 要显示中文状态，不能只显示裸枚举');

    assert.equal(fetchImpl.calls[0].url, '/api/v1/admin/administrators?limit=20');
    assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer synthetic-admin-token');
    assert.equal(fetchImpl.calls[0].method, 'GET');

    // 点第一行的「查看权限」⇒ 第二条 GET 必须带这个 admin_accounts.id
    const openers = findAll(mounted.container, byTestId('administrator-view-scopes'));
    assert.equal(openers.length, 2, '每一行都要有「查看权限」入口');
    await click(openers[0]);

    assert.equal(fetchImpl.calls.length, 2, '点开某人只该发一次 scopes 请求');
    assert.equal(fetchImpl.calls[1].url, `/api/v1/admin/administrators/${ADMIN_ID}/scopes`);
    assert.equal(fetchImpl.calls[1].init.headers.authorization, 'Bearer synthetic-admin-token');

    const panel = findBy(mounted.container, byTestId('administrator-scopes-panel'));
    assert.ok(panel !== null, '点开后必须出现 scopes 面板');
    assert.match(textOf(panel), /chen_yun/);
    const scopes = findAll(mounted.container, byTestId('administrator-scope')).map(textOf);
    assert.equal(scopes.length, 2, '面板里必须列出该管理员的 2 条 scope');
    assert.match(scopes.join(' '), /audit:read/);
    assert.match(scopes.join(' '), /scopes:read/);
    // 契约里 AdminAdministratorScopesView 只有 {scopes: string[]}：⛔ 不能把 granted_by / granted_at 渲染成字段。
    // （页面说明文字里出现这两个词是**有意**的，所以只钉「权限条目本身」不带它们。）
    for (const scopeText of scopes) {
      assert.doesNotMatch(scopeText, /granted_by|granted_at/, '权限条目不得携带契约外的授予人/授予时间');
    }
    assert.equal(
      findAll(mounted.container, (node) => /granted_by\s*[:：]/.test(textOf(node))).length,
      0,
      '不得以「granted_by: xxx」形式渲染契约外字段',
    );
  } finally {
    mounted.unmount();
  }
});

test('403 SCOPE_DENIED ⇒ role="alert" 的明确提示，且**不是**白屏也不是空态', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(403, errorEnvelope('SCOPE_DENIED', '缺少 scopes:read')));
  const mounted = await mountView({ fetchImpl });
  try {
    const status = findBy(mounted.container, byTestId('administrators-status'));
    assert.ok(status !== null, '403 必须有提示（不得白屏）');
    assert.equal(status.props.role, 'alert', '403 必须是 alert 语义');
    const statusText = textOf(status);
    assert.match(statusText, /权限不足/);
    assert.match(statusText, /scopes:read/);
    assert.equal(countOf(mounted.container, 'administrators-row'), 0);
    assert.equal(findBy(mounted.container, byTestId('administrators-empty')), null, '403 不得被渲染成空目录');
    assert.equal(findBy(mounted.container, byTestId('administrators-table')), null, '403 不渲染表格');
    const code = findBy(mounted.container, byTestId('administrators-error-code'));
    assert.ok(code !== null, '必须显示错误码');
    assert.match(textOf(code), /SCOPE_DENIED/);
    assert.equal(countOf(mounted.container, 'administrators-retry'), 0, '403 不给「重试」——重试同一个无权会话没有意义');
    assert.ok(findBy(mounted.container, byTestId('administrators-sign-out')) !== null, '必须给出可走的下一步（退出登录换账号）');
  } finally {
    mounted.unmount();
  }
});

test('空数组 ⇒ 空态（说清「空目录，不是权限问题」）', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, administratorPage([], null)));
  const mounted = await mountView({ fetchImpl });
  try {
    assert.equal(countOf(mounted.container, 'administrators-row'), 0);
    const empty = findBy(mounted.container, byTestId('administrators-empty'));
    assert.ok(empty !== null, '空数组必须渲染空态');
    const emptyText = textOf(empty);
    assert.match(emptyText, /管理员目录为空/);
    assert.match(emptyText, /空目录，不是权限问题/);
    const status = findBy(mounted.container, byTestId('administrators-status'));
    assert.equal(status.props.role, 'status', '空目录不是错误，不得用 alert');
    assert.equal(countOf(mounted.container, 'administrators-retry'), 0, '空目录不是错误，不给重试按钮');
  } finally {
    mounted.unmount();
  }
});

test('列表 404 ⇒ 「调用失败（HTTP 404）」，⛔ 不得断言某个 id 不存在', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(404, errorEnvelope('NOT_FOUND', '管理员不存在')));
  const mounted = await mountView({ fetchImpl });
  try {
    const status = findBy(mounted.container, byTestId('administrators-status'));
    assert.ok(status !== null, '404 必须有提示（不得白屏）');
    assert.equal(status.props.role, 'alert');
    const statusText = textOf(status);
    assert.match(statusText, /404/, '必须点明 HTTP 404');
    assert.match(statusText, /后端路由/, '列表 404 只能指向路由/装配');
    // 这条是审查指出的语义混淆：列表整体 404 不代表「某个 admin_accounts.id 已不存在」
    assert.doesNotMatch(statusText, /已不存在/, '列表 404 不得断言某个 id 不存在');
    assert.doesNotMatch(textOf(mounted.container), /管理员不存在/, '列表页不得出现「管理员不存在」');
    assert.equal(countOf(mounted.container, 'administrators-row'), 0);
    assert.equal(countOf(mounted.container, 'administrators-retry'), 0, '404 不给重试');
  } finally {
    mounted.unmount();
  }
});

test('详情 404 才说「管理员不存在」；503 的 retryable 决定有没有重试按钮', async () => {
  // 1) 详情 404：点开某人后 404 ⇒ 保留「管理员不存在」原文案
  const detailMissing = fakeFetch(({ url }) =>
    url.endsWith('/scopes')
      ? jsonResponse(404, errorEnvelope('NOT_FOUND', '管理员不存在'))
      : jsonResponse(200, administratorPage([administrator()], null)),
  );
  const first = await mountView({ fetchImpl: detailMissing });
  try {
    const button = findBy(first.container, byTestId('administrator-view-scopes'));
    assert.ok(button !== null, '必须有「查看权限」入口');
    await click(button);
    const panel = findBy(first.container, byTestId('administrator-scopes-panel'));
    assert.ok(panel !== null, '点开后必须有 scopes 面板');
    assert.match(textOf(panel), /管理员不存在/);
    assert.match(textOf(panel), /admin_accounts\.id/);
    assert.equal(countOf(first.container, 'administrator-scopes-retry'), 0, '404 不给重试');
  } finally {
    first.unmount();
  }

  // 2) 列表 503 + retryable:true ⇒ 给重试；retryable:false ⇒ 不给
  const retryableFalse = fakeFetch(() => jsonResponse(503, errorEnvelope('PROVIDER_UNAVAILABLE', '管理员目录尚未接线到认证权威', false)));
  const second = await mountView({ fetchImpl: retryableFalse });
  try {
    const status = findBy(second.container, byTestId('administrators-status'));
    assert.equal(status.props.role, 'alert');
    assert.match(textOf(status), /服务暂不可用/);
    assert.equal(countOf(second.container, 'administrators-retry'), 0, '服务端声明不可重试时不得给重试按钮');
    assert.doesNotMatch(textOf(status), /稍后重试/);
    assert.equal(findBy(second.container, byTestId('administrators-empty')), null, '503 不得被渲染成空目录');
  } finally {
    second.unmount();
  }

  const retryableTrue = fakeFetch(() => jsonResponse(503, errorEnvelope('PROVIDER_UNAVAILABLE', '暂时过载', true)));
  const third = await mountView({ fetchImpl: retryableTrue });
  try {
    assert.equal(countOf(third.container, 'administrators-retry'), 1, '服务端明说可重试时必须有重试按钮');
  } finally {
    third.unmount();
  }
});
