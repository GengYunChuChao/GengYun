/**
 * 渲染级用例：管理员目录 **「重置型刷新」必须替换第一页**（R67-A05 阻塞 B）。
 *
 * 为什么必须有这一条：停用／恢复成功后，页面做的第一件事是 `refresh()`（重新读第一页）。
 * `revision` 是写面 `If-Match` 的唯一来源（目录不发 `ETag`），所以刷新后的行**必须**是服务端
 * 的新 revision。旧实现在 reducer 的 `LOAD_START{reset:true}` 里不清 `items`，`LOAD_OK` 又走
 * 「按 id 去重追加」，于是：同一 `admin_accounts.id` 被当成重复项跳过 ⇒ 表里仍是旧 revision
 * （服务端已是新值）、`duplicates` 还涨了 1 —— 下一次点「停用」拿旧 revision 发 `If-Match`，
 * 只会换来 409 REVISION_CONFLICT，用户看到「该行已被别处改过」，而他刚改完。
 *
 * 真实路径：`tests/unit/` 既有渲染类用例的同一套基建（不新增依赖、不联网）——
 * `@vue/compiler-sfc` 编译真 SFC → 说明符换成 `file:`/`data:` URL → `createRenderer()` 内存宿主
 * 挂**真视图** + **真 lib** + **真 reducer**，网络层用 `globalThis.fetch` 桩。
 * 与 `admin-ui-administrators-render.test.mjs` 的区别：这里不注入任何 `fetchImpl`
 * （页面上就是没有注入点），所以写面也**只能**走 `globalThis.fetch` 回落——同时钉住阻塞 A。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { compileScript, parse } from '@vue/compiler-sfc';
import { createRenderer, nextTick } from 'vue';

import {
  administratorRowView,
  administratorRows,
  describeAdministratorsView,
  initialAdministratorsState,
  reduceAdministrators,
} from '../../apps/admin/src/lib/admin-administrators.mjs';

if (globalThis.document === undefined) globalThis.document = { activeElement: null };
if (globalThis.Document === undefined) globalThis.Document = class Document {};
if (globalThis.ShadowRoot === undefined) globalThis.ShadowRoot = class ShadowRoot {};

const VIEW_URL = new URL('../../apps/admin/src/views/AdministratorsView.vue', import.meta.url);
const LIB_URL = new URL('../../apps/admin/src/lib/admin-administrators.mjs', import.meta.url);
const ACCOUNT_SUSPEND_LIB_URL = new URL('../../apps/admin/src/lib/account-suspend-api.mjs', import.meta.url);
const STATE_LIB_URL = new URL('../../apps/admin/src/lib/administrator-state-api.mjs', import.meta.url);
const CONTENT_VM_URL = new URL('../../apps/admin/src/lib/admin-content-view-model.mjs', import.meta.url);
const DIALOG_FOCUS_URL = new URL('../../apps/admin/src/lib/dialog-focus.mjs', import.meta.url);
const VUE_URL = import.meta.resolve('vue');

const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
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

/** `WriteReceipt.vue` 是 SFC，Node 不能直接 import：同 `admin-ui-administrators-render.test.mjs` 给同 props 的空壳。 */
const WRITE_RECEIPT_STUB_URL = moduleUrl(`
export default {
  name: 'WriteReceipt',
  props: ['write', 'auditLookup', 'canAudit', 'canReloadDetail', 'changed'],
  emits: ['lookup-audit', 'clear-receipt', 'reload-detail'],
  render() {
    return null;
  },
};
`);

let componentPromise = null;

function loadViewComponent() {
  if (componentPromise !== null) return componentPromise;
  const source = readFileSync(VIEW_URL, 'utf8');
  const { descriptor, errors } = parse(source, { filename: fileURLToPath(VIEW_URL) });
  assert.deepEqual(errors, [], 'AdministratorsView.vue 必须能被 @vue/compiler-sfc 解析');
  const compiled = compileScript(descriptor, {
    id: 'gy-administrators-refresh-render',
    inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false, cacheHandlers: false } },
  });
  const escape = (specifier) => specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const code = compiled.content
    .replace(/from\s+["']vue["']/g, `from '${VUE_URL}'`)
    .replace(new RegExp(`from\\s+["']${escape('../auth/session')}["']`, 'g'), `from '${SESSION_STUB_URL}'`)
    .replace(new RegExp(`from\\s+["']${escape('../lib/admin-administrators.mjs')}["']`, 'g'), `from '${LIB_URL.href}'`)
    .replace(new RegExp(`from\\s+["']${escape('../lib/administrator-state-api.mjs')}["']`, 'g'), `from '${STATE_LIB_URL.href}'`)
    .replace(new RegExp(`from\\s+["']${escape('../lib/account-suspend-api.mjs')}["']`, 'g'), `from '${ACCOUNT_SUSPEND_LIB_URL.href}'`)
    .replace(new RegExp(`from\\s+["']${escape('../lib/admin-content-view-model.mjs')}["']`, 'g'), `from '${CONTENT_VM_URL.href}'`)
    .replace(new RegExp(`from\\s+["']${escape('../lib/dialog-focus.mjs')}["']`, 'g'), `from '${DIALOG_FOCUS_URL.href}'`)
    .replace(new RegExp(`from\\s+["']${escape('./WriteReceipt.vue')}["']`, 'g'), `from '${WRITE_RECEIPT_STUB_URL}'`);
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
  if (node === null || node === undefined) return '';
  if (node.kind === '#text') return node.text;
  return node.children.map(textOf).join('');
}

const byTestId = (id) => (node) => node.props['data-testid'] === id;
const countOf = (root, id) => findAll(root, byTestId(id)).length;

/**
 * 点一下按钮。
 * `@click.stop` 会被编译成 `withModifiers(..., ['stop'])`，它先对事件对象调 `stopPropagation()`，
 * 所以必须给一个事件形状的入参（否则测的是我们自己的 TypeError，不是生产行为）。
 */
async function click(node) {
  assert.equal(typeof node.props.onClick, 'function', '待点击节点必须是绑定了 onClick 的按钮');
  node.props.onClick({ stopPropagation() {}, preventDefault() {}, currentTarget: null });
  await settle();
}

/**
 * 往 `<input>` 里打字。`v-model` 在原生元素上走 `vModelText` 指令（`addEventListener('input')`），
 * 而且它读的是 **DOM 的 `el.value`**：所以既要写 `node.value`，也要把事件形状带上。
 * （不是 `props.onInput`——但也兼容，免得测的是我们自己的宿主缺陷。）
 */
function typeInto(root, testId, value) {
  const node = findBy(root, byTestId(testId));
  assert.ok(node !== null, `找不到 data-testid="${testId}" 的输入框`);
  node.value = value;
  const event = { target: { value, composing: false } };
  if (typeof node.props.onInput === 'function') node.props.onInput(event);
  else if (node.listeners.has('input')) node.dispatch('input', event);
  else assert.fail(`${testId} 必须接受输入（v-model 或 @input）`);
}

function jsonResponse(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body };
}

const meta = { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'real' };

function administratorPage(items, nextCursor = null) {
  return { data: { items, next_cursor: nextCursor }, meta };
}

/** 目录行（`AdminAdministratorView`：id / login_name / revision / state / scopes）。 */
function administrator(overrides = {}) {
  return {
    id: ADMIN_ID,
    login_name: 'chen_yun',
    revision: 3,
    state: 'active',
    scopes: ['audit:read', 'scopes:read'],
    ...overrides,
  };
}

/** 写面成功信封（`AdminAccountStateView`）。 */
function stateView(overrides = {}) {
  return {
    data: {
      id: ADMIN_ID,
      revision: 4,
      state: 'suspended',
      auth_epoch: 2,
      revoked_sessions: 1,
      changed: true,
      ...overrides,
    },
    meta,
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

// ---------------------------------------------------------------- reducer 级（同一条缺陷的纯函数面）

test('reducer：重置型刷新（LOAD_START reset:true → LOAD_OK）替换第一页，不留旧 revision、不记重复', () => {
  let state = reduceAdministrators(initialAdministratorsState(), { type: 'SIGNED_IN', scopes: ['scopes:read'] });
  state = reduceAdministrators(state, { type: 'LOAD_START', reset: true });
  state = reduceAdministrators(state, {
    type: 'LOAD_OK',
    cursor: null,
    page: { items: [administrator({ revision: 3, state: 'active' })], nextCursor: null, warnings: 0 },
  });
  assert.equal(administratorRows(state).length, 1, '首屏 1 行');
  assert.equal(administratorRows(state)[0].revision, 3, '首屏 revision 来自服务端');

  // 停用成功后视图做的事：同一页（cursor=null）+ reset ⇒ 服务端这时已经是 revision 4 / suspended
  state = reduceAdministrators(state, { type: 'LOAD_START', reset: true });
  state = reduceAdministrators(state, {
    type: 'LOAD_OK',
    cursor: null,
    page: { items: [administrator({ revision: 4, state: 'suspended' })], nextCursor: null, warnings: 0 },
  });

  const rows = administratorRows(state);
  assert.equal(rows.length, 1, '重置刷新后同一 admin_accounts.id 不得变成两行');
  assert.equal(rows[0].revision, 4, '重置刷新后行 revision 必须是服务端的新值（If-Match 的来源）');
  assert.equal(rows[0].stateLabel, '已暂停');
  assert.equal(state.collection.duplicates, 0, '重置刷新不是「去重跳过同一行」，不得计 duplicate');
  assert.equal(state.collection.pages, 1, '重置后页数从 1 起算（旧页已被替换）');
  assert.equal(state.collection.seenIds.length, 1);
  const view = describeAdministratorsView(state);
  assert.equal(view.total, 1);
  assert.equal(view.duplicates, 0);
  assert.equal(view.tone, 'ready');
});

test('reducer：非重置的「读取下一页」仍是追加，不清空已读数据（其它分支不得回归）', () => {
  const other = '33333333-3333-4333-8333-333333333333';
  let state = reduceAdministrators(initialAdministratorsState(), { type: 'SIGNED_IN', scopes: ['scopes:read'] });
  state = reduceAdministrators(state, { type: 'LOAD_START', reset: true });
  state = reduceAdministrators(state, {
    type: 'LOAD_OK',
    cursor: null,
    page: { items: [administrator({ revision: 3 })], nextCursor: 'c1', warnings: 0 },
  });
  state = reduceAdministrators(state, { type: 'LOAD_START', reset: false });
  state = reduceAdministrators(state, {
    type: 'LOAD_OK',
    cursor: 'c1',
    page: { items: [administrator({ id: other, login_name: 'li_wei', revision: 1 })], nextCursor: null, warnings: 0 },
  });

  const rows = administratorRows(state);
  assert.equal(rows.length, 2, '第二页是追加，第一页必须还在');
  assert.deepEqual(rows.map((row) => row.loginName), ['chen_yun', 'li_wei']);
  assert.equal(state.collection.pages, 2);
});

// ---------------------------------------------------------------- 行视图：拿不到合法 revision 就不产出该行

test('行视图：revision 缺失/非法 ⇒ 不产出该行（不再用 revision 0 + 「—」兜底）', () => {
  assert.equal(administratorRowView(administrator({ revision: undefined })), null, '没有 revision 就没有 If-Match 来源');
  assert.equal(administratorRowView(administrator({ revision: 0 })), null);
  assert.equal(administratorRowView(administrator({ revision: -1 })), null);
  assert.equal(administratorRowView(administrator({ revision: 1.5 })), null);
  assert.equal(administratorRowView(administrator({ revision: '4' })), null, '字符串不是契约类型');
  assert.equal(administratorRowView(administrator({ revision: Number.NaN })), null);
  assert.equal(administratorRowView(null), null);

  const good = administratorRowView(administrator({ revision: 7 }));
  assert.equal(good.revision, 7);
  assert.equal(good.revisionLabel, '7');

  let state = reduceAdministrators(initialAdministratorsState(), { type: 'SIGNED_IN', scopes: ['scopes:read'] });
  state = reduceAdministrators(state, {
    type: 'LOAD_OK',
    cursor: null,
    page: { items: [administrator({ revision: 2 }), administrator({ id: '44444444-4444-4444-8444-444444444444', revision: undefined })], nextCursor: null, warnings: 0 },
  });
  const rows = administratorRows(state);
  assert.equal(rows.length, 1, '坏 revision 的行不得进表（渲染成一个「—」的不可操作行只会误导）');
  assert.equal(rows[0].revision, 2);
});

// ---------------------------------------------------------------- 渲染级：停用成功 → 刷新 → 新 revision、无重复行

test('渲染级：停用成功 → 触发刷新 → 行 revision 变为服务端新值、无重复行（真 SFC + 真 reducer，写面只走 globalThis.fetch）', async () => {
  let listCalls = 0;
  const fetchImpl = fakeFetch(({ url }) => {
    const target = String(url);
    if (target === `/api/v1/admin/administrators/${ADMIN_ID}/disable`) {
      // 服务端：revision 3 → 4，state active → suspended
      return jsonResponse(200, stateView(), { etag: '"4"' });
    }
    listCalls += 1;
    // 首屏：revision 3 / active；刷新：revision 4 / suspended（服务端已前进）
    return jsonResponse(
      200,
      listCalls === 1
        ? administratorPage([administrator({ revision: 3, state: 'active' })])
        : administratorPage([administrator({ revision: 4, state: 'suspended' })], null),
    );
  });

  const mounted = await mountView({ fetchImpl });
  try {
    // ---- 首屏
    assert.equal(countOf(mounted.container, 'administrators-row'), 1, '首屏 1 行');
    assert.deepEqual(
      findAll(mounted.container, byTestId('administrator-revision')).map(textOf),
      ['3'],
      '首屏 revision cell 是服务端值 3',
    );
    assert.equal(findBy(mounted.container, byTestId('administrator-state-failure')), null);

    // ---- 点「停用」→ 填理由 → 提交（页面不注入 fetchImpl，写面只能回落到 globalThis.fetch）
    const disable = findBy(mounted.container, byTestId('administrator-disable'));
    assert.ok(disable !== null, 'active 行必须有「停用」按钮');
    await click(disable);
    const dialog = findBy(mounted.container, byTestId('administrator-state-dialog'));
    assert.ok(dialog !== null, '点「停用」必须打开确认框');
    typeInto(mounted.container, 'administrator-state-reason', '违反管理员操作规范');
    await settle();
    await click(findBy(mounted.container, byTestId('administrator-state-submit')));
    await settle();
    await settle();

    // ---- 写请求真的打到了停用端点（阻塞 A：不再出现「当前环境没有可用的 fetch」）
    const posts = fetchImpl.calls.filter((call) => call.method === 'POST');
    assert.equal(posts.length, 1, `必须真的发出一次停用请求（写面不得因缺 fetchImpl 就地失败）；页面文本=${JSON.stringify(textOf(mounted.container))}`);
    assert.equal(posts[0].url, `/api/v1/admin/administrators/${ADMIN_ID}/disable`);
    assert.equal(posts[0].init.headers['if-match'], '"3"', 'If-Match 取自已加载那一行的 revision');
    assert.ok(posts[0].init.headers['idempotency-key'].length >= 8, '必须带契约范围内的 Idempotency-Key');
    assert.doesNotMatch(textOf(mounted.container), /当前环境没有可用的 fetch/);
    assert.equal(findBy(mounted.container, byTestId('administrator-state-failure')), null, '写成功不得留下失败说明');
    assert.ok(findBy(mounted.container, byTestId('administrator-state-ok')) !== null, '成功回执必须上屏');

    // ---- 写成功后必须重新读第一页（重置型刷新）
    assert.equal(listCalls, 2, '停用成功后必须触发一次刷新（revision 已前进，旧行不能再用）');
    assert.deepEqual(
      fetchImpl.calls.map((call) => call.url),
      [
        '/api/v1/admin/administrators?limit=20',
        `/api/v1/admin/administrators/${ADMIN_ID}/disable`,
        '/api/v1/admin/administrators?limit=20',
      ],
      '调用顺序：首屏 GET → 停用 POST → 刷新 GET',
    );

    // ---- 刷新后：同一行是服务端新 revision，且没有重复行
    assert.equal(countOf(mounted.container, 'administrators-row'), 1, '同一 admin_accounts.id 不得渲染成两行');
    assert.deepEqual(
      findAll(mounted.container, byTestId('administrator-revision')).map(textOf),
      ['4'],
      '刷新后 revision cell 必须是服务端新值 4（写面的 If-Match 就此前进）',
    );
    const pageText = textOf(mounted.container);
    assert.doesNotMatch(pageText, /去重 \d+ 个/, '重置刷新不得报「去重 N 个」');
    assert.match(pageText, /已读取 1 个管理员/);
    assert.match(pageText, /已暂停/, '刷新后 state cell 是服务端的新状态');

    // ---- 新 revision 立刻可用于下一次写：不做别的操作，只确认按钮仍可点（revision 4 合法）
    const nextDisable = findBy(mounted.container, byTestId('administrator-disable'));
    assert.equal(nextDisable, null, '已暂停的行不再给「停用」按钮');
    assert.ok(findBy(mounted.container, byTestId('administrator-enable')) !== null, '已暂停的行给「恢复」按钮');
  } finally {
    mounted.unmount();
  }
});
