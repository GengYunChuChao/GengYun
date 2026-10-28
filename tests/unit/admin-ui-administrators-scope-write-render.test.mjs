/**
 * R68 · 渲染级用例：`AdministratorsView.vue` 的**授权／撤销**入口。
 *
 * 为什么必须是渲染级（这是本片最重要的一条）：能力图闸门只证明「视图里有这行代码」，
 * A05 片就是闸门全绿而页面一次请求都不发。所以这里不搞源码正则，而是
 * `@vue/compiler-sfc` 真编译 SFC → 内存宿主挂真组件 → 真点按钮 → 断言 `fetchImpl.calls`
 * 里的 URL / method / headers / body **逐字节**对得上契约。
 *
 * 环境沿用 `tests/unit/admin-ui-administrators-render.test.mjs` 的最小渲染环境（不新增依赖、不联网）。
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
const ACCOUNT_SUSPEND_LIB_URL = new URL('../../apps/admin/src/lib/account-suspend-api.mjs', import.meta.url);
const STATE_LIB_URL = new URL('../../apps/admin/src/lib/administrator-state-api.mjs', import.meta.url);
const SCOPE_LIB_URL = new URL('../../apps/admin/src/lib/administrator-scope-api.mjs', import.meta.url);
const SCOPE_CATALOG_URL = new URL('../../apps/admin/src/lib/admin-scope-catalog.mjs', import.meta.url);
const CONTENT_VM_URL = new URL('../../apps/admin/src/lib/admin-content-view-model.mjs', import.meta.url);
const DIALOG_FOCUS_URL = new URL('../../apps/admin/src/lib/dialog-focus.mjs', import.meta.url);
const VUE_URL = import.meta.resolve('vue');

const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const SESSION = { accessToken: 'synthetic-admin-token', expiresAt: '2099-01-01T00:00:00.000Z', scopes: ['scopes:read'] };
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const LIST_PATH = '/api/v1/admin/administrators';
const SCOPE_PATH = `/api/v1/admin/administrators/${ADMIN_ID}/scopes`;
const REASON = '补授值班权限';

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
    id: 'gy-administrators-scope-write-render',
    inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false, cacheHandlers: false } },
  });
  const escape = (specifier) => specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const replacements = [
    ['../auth/session', SESSION_STUB_URL],
    ['../lib/admin-administrators.mjs', LIB_URL.href],
    ['../lib/administrator-state-api.mjs', STATE_LIB_URL.href],
    ['../lib/administrator-scope-api.mjs', SCOPE_LIB_URL.href],
    ['../lib/admin-scope-catalog.mjs', SCOPE_CATALOG_URL.href],
    ['../lib/account-suspend-api.mjs', ACCOUNT_SUSPEND_LIB_URL.href],
    ['../lib/admin-content-view-model.mjs', CONTENT_VM_URL.href],
    ['../lib/dialog-focus.mjs', DIALOG_FOCUS_URL.href],
    ['./WriteReceipt.vue', WRITE_RECEIPT_STUB_URL],
  ];
  let code = compiled.content.replace(/from\s+["']vue["']/g, `from '${VUE_URL}'`);
  for (const [specifier, url] of replacements) {
    code = code.replace(new RegExp(`from\\s+["']${escape(specifier)}["']`, 'g'), `from '${url}'`);
  }
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

function requireTestId(root, id) {
  const node = findBy(root, byTestId(id));
  assert.notEqual(node, null, `页面上缺少 data-testid="${id}" 的节点`);
  return node;
}

/**
 * 造一个够用的合成事件：`.stop` 修饰符会调 `stopPropagation()`，
 * 焦点回填会读 `currentTarget`，两个都给真值——否则测出来的不是页面行为。
 */
function syntheticEvent(node) {
  return {
    currentTarget: node,
    target: node,
    stopPropagation() {},
    preventDefault() {},
  };
}

async function click(node) {
  assert.equal(typeof node.props.onClick, 'function', '待点击节点必须是绑定了 onClick 的按钮');
  node.props.onClick(syntheticEvent(node));
  await settle();
}

/** 触发 `<select>` 的 change（自定义 renderer 把 `onChange` 存进 props）。 */
async function choose(node, value) {
  assert.equal(typeof node.props.onChange, 'function', '待选节点必须是绑定了 onChange 的 select');
  node.props.onChange({ target: { value } });
  await settle();
}

/** 往 `<input>` 里打值（`onInput` 存进 props）。 */
async function typeInto(node, value) {
  assert.equal(typeof node.props.onInput, 'function', '待输入节点必须绑定了 onInput');
  node.props.onInput({ target: { value } });
  await settle();
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body };
}

const meta = { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'real' };

function administratorPage(items, nextCursor = null) {
  return { data: { items, next_cursor: nextCursor }, meta };
}

function errorEnvelope(code, message, retryable = false) {
  return { error: { code, message, retryable, details: [] }, meta };
}

function scopeWriteEnvelope(overrides = {}) {
  return { data: { id: ADMIN_ID, revision: 2, scopes: ['audit:read', 'scopes:read'], changed: true, ...overrides }, meta };
}

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

/** 目录响应按「当前 revision / scopes」动态给出，用来观察成功后到底有没有刷新。 */
function directoryHandler(state) {
  return ({ url, init }) => {
    if (init !== undefined && init.method === 'POST' && url === SCOPE_PATH) {
      if (state.grantResponse !== undefined) return state.grantResponse;
      state.scopes = [...new Set([...state.scopes, state.grantScope])].sort();
      state.revision += 1;
      return jsonResponse(200, scopeWriteEnvelope({ revision: state.revision, scopes: state.scopes, changed: true }));
    }
    if (init !== undefined && init.method === 'DELETE') {
      if (state.revokeResponse !== undefined) return state.revokeResponse;
      state.scopes = state.scopes.filter((scope) => scope !== state.revokeScope);
      state.revision += 1;
      return jsonResponse(200, scopeWriteEnvelope({ revision: state.revision, scopes: state.scopes, changed: true }));
    }
    if (url === SCOPE_PATH) return jsonResponse(200, { data: { scopes: state.scopes }, meta });
    return jsonResponse(
      200,
      administratorPage([administrator({ revision: state.revision, scopes: state.scopes, state: state.adminState })]),
    );
  };
}

function makeState(overrides = {}) {
  return { revision: 3, scopes: ['audit:read', 'scopes:read'], adminState: 'active', ...overrides };
}

// ---------------------------------------------------------------- 正例：授权

test('点「授权」⇒ 真的只发一次 POST（URL/method/If-Match/幂等键/body 逐字节），成功后行内 scope 出现', async () => {
  const state = makeState({ grantScope: 'flags:write' });
  const impl = fakeFetch(directoryHandler(state));
  const { container, unmount } = await mountView({ fetchImpl: impl });
  try {
    assert.equal(countOf(container, 'administrators-row'), 1, '先得有一行');

    // 没选 scope 时按钮不可用（aria-disabled 也必须是字符串 "true"）
    const grantButton = requireTestId(container, 'administrator-grant');
    assert.equal(grantButton.props.disabled, true);
    assert.equal(grantButton.props['aria-disabled'], 'true');
    assert.equal(typeof grantButton.props['aria-label'], 'string');
    assert.match(grantButton.props['aria-label'], /chen_yun/, 'aria-label 要说清对谁操作');

    const select = requireTestId(container, 'administrator-scope-pick');
    await choose(select, 'flags:write');
    const enabled = requireTestId(container, 'administrator-grant');
    assert.equal(enabled.props.disabled, false);
    assert.equal(enabled.props['aria-disabled'], 'false');

    await click(requireTestId(container, 'administrator-grant'));
    // 二次确认：点按钮不直接发请求
    assert.equal(impl.calls.length, 1, '点「授权」只应打开确认框，不该立刻发请求');
    const dialog = requireTestId(container, 'administrator-scope-dialog');
    assert.equal(dialog.props.role, 'dialog');
    assert.equal(dialog.props['aria-modal'], 'true');

    await typeInto(requireTestId(container, 'administrator-scope-reason'), REASON);
    await click(requireTestId(container, 'administrator-scope-submit'));

    // ① 只发一次授权请求（外加一次刷新目录的 GET）
    const posts = impl.calls.filter((call) => call.init !== undefined && call.init.method === 'POST');
    assert.equal(posts.length, 1, '一次确认只发一次 POST');
    assert.deepEqual(impl.calls.map((call) => call.method ?? 'GET'), ['GET', 'POST', 'GET'], '顺序：列目录 → 授权 → 刷新');

    // ② 请求逐字节对
    const grant = posts[0];
    assert.equal(grant.url, SCOPE_PATH, 'URL 必须是 /admin/administrators/{id}/scopes');
    assert.equal(grant.init.credentials, 'omit');
    assert.equal(grant.init.headers.authorization, `Bearer ${SESSION.accessToken}`);
    assert.equal(grant.init.headers.accept, 'application/json');
    assert.equal(grant.init.headers['content-type'], 'application/json');
    assert.equal(grant.init.headers['if-match'], '"3"', 'If-Match 必须取行内 revision');
    assert.match(grant.init.headers['idempotency-key'], /^administrator-[0-9a-f]{32}$/, '幂等键形状沿用停用／恢复');
    assert.equal(grant.init.body, `{"scope":"flags:write","reason":"${REASON}"}`, 'body 必须逐字节对');

    // ③ 成功后刷新该行：行内 scopes 里出现新值
    assert.match(textOf(requireTestId(container, 'administrator-scopes-text')), /flags:write/, '成功后行内 scopes 必须更新');
    assert.equal(countOf(container, 'administrator-scope-ok'), 1, '成功要有回执');
    assert.equal(requireTestId(container, 'administrator-scope-ok').props.role, 'status');
    assert.equal(countOf(container, 'administrator-scope-dialog'), 0, '成功后确认框要关掉');
  } finally {
    unmount();
  }
});

// ---------------------------------------------------------------- 正例：撤销

test('点「撤销」⇒ DELETE /scopes/{scope}（scope 进路径且编码），成功后行内 scope 消失', async () => {
  const state = makeState({ revokeScope: 'audit:read' });
  const impl = fakeFetch(directoryHandler(state));
  const { container, unmount } = await mountView({ fetchImpl: impl });
  try {
    await choose(requireTestId(container, 'administrator-scope-pick'), 'audit:read');
    await click(requireTestId(container, 'administrator-revoke'));
    assert.equal(impl.calls.length, 1, '点「撤销」不该立刻发请求');
    await typeInto(requireTestId(container, 'administrator-scope-reason'), '按排班收回权限');
    await click(requireTestId(container, 'administrator-scope-submit'));

    const deletes = impl.calls.filter((call) => call.init !== undefined && call.init.method === 'DELETE');
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].url, `${SCOPE_PATH}/audit%3Aread`, 'scope 必须在路径里且按 encodeURIComponent 编码');
    assert.equal(deletes[0].init.headers['if-match'], '"3"');
    assert.equal(deletes[0].init.body, '{"reason":"按排班收回权限"}', '撤销的 body 只有 reason');
    assert.doesNotMatch(textOf(requireTestId(container, 'administrator-scopes-text')), /audit:read/, '成功后行内 scope 必须消失');
  } finally {
    unmount();
  }
});

// ---------------------------------------------------------------- 负例

test('非法 scope ⇒ 零请求、不开确认框、role=alert 说清收到了什么', async () => {
  const impl = fakeFetch(directoryHandler(makeState({ grantScope: 'flags:write' })));
  const { container, unmount } = await mountView({ fetchImpl: impl });
  try {
    await choose(requireTestId(container, 'administrator-scope-pick'), 'user:root');
    await click(requireTestId(container, 'administrator-grant'));
    assert.equal(impl.calls.length, 1, '闭集外的 scope 一个字节都不该发出去');
    assert.equal(countOf(container, 'administrator-scope-dialog'), 0, '不该打开确认框');
    const alert = requireTestId(container, 'administrator-scope-error');
    assert.equal(alert.props.role, 'alert');
    assert.match(textOf(alert), /AdminScope/, '要指认契约闭集');
    assert.match(textOf(alert), /user:root/, '要带上收到的值');
  } finally {
    unmount();
  }
});

test('401 ⇒ 上屏 SESSION_REQUIRED 文案且不自动重发第二次请求', async () => {
  const state = makeState({ grantScope: 'flags:write' });
  state.grantResponse = jsonResponse(401, errorEnvelope('SESSION_REQUIRED', '后台会话已失效', false));
  const impl = fakeFetch(directoryHandler(state));
  const { container, unmount } = await mountView({ fetchImpl: impl });
  try {
    await choose(requireTestId(container, 'administrator-scope-pick'), 'flags:write');
    await click(requireTestId(container, 'administrator-grant'));
    await typeInto(requireTestId(container, 'administrator-scope-reason'), REASON);
    await click(requireTestId(container, 'administrator-scope-submit'));

    assert.equal(impl.calls.length, 2, '401 之后不许自动重发');
    const failure = requireTestId(container, 'administrator-scope-failure');
    assert.equal(failure.props.role, 'alert');
    const text = textOf(failure);
    assert.match(text, /SESSION_REQUIRED/, '具体错误码要上屏');
    assert.match(text, /重新登录/, '要说清下一步做什么');
    assert.equal(countOf(container, 'administrator-scope-dialog'), 1, '失败后确认框留在原地，幂等键与输入不丢');
    assert.equal(countOf(container, 'administrator-scope-ok'), 0, '失败不许出现成功回执');
  } finally {
    unmount();
  }
});

test('403 SELF_SCOPE_GRANT_DENIED ⇒ 自锁门文案（不被说成「权限不足」）且不重发', async () => {
  const state = makeState({ grantScope: 'flags:write' });
  state.grantResponse = jsonResponse(
    403,
    errorEnvelope('SELF_SCOPE_GRANT_DENIED', '不能给自己授权', false),
  );
  const impl = fakeFetch(directoryHandler(state));
  const { container, unmount } = await mountView({ fetchImpl: impl });
  try {
    await choose(requireTestId(container, 'administrator-scope-pick'), 'flags:write');
    await click(requireTestId(container, 'administrator-grant'));
    await typeInto(requireTestId(container, 'administrator-scope-reason'), REASON);
    await click(requireTestId(container, 'administrator-scope-submit'));

    assert.equal(impl.calls.length, 2, '自锁门拒绝不重发');
    const text = textOf(requireTestId(container, 'administrator-scope-failure'));
    assert.match(text, /SELF_SCOPE_GRANT_DENIED/);
    assert.match(text, /不能给自己授权/, '自锁门要单独说，不能落到通用「没有 scopes:write」');
    assert.doesNotMatch(text, /没有 scopes:write，不能改管理员权限/);
  } finally {
    unmount();
  }
});

test('409 LAST_SCOPE_MANAGER ⇒ 说清「先给他人授权」，且不提供无脑重试', async () => {
  const state = makeState({ revokeScope: 'scopes:write', scopes: ['audit:read', 'scopes:read', 'scopes:write'] });
  state.revokeResponse = jsonResponse(409, errorEnvelope('LAST_SCOPE_MANAGER', '会归零', false));
  const impl = fakeFetch(directoryHandler(state));
  const { container, unmount } = await mountView({ fetchImpl: impl });
  try {
    await choose(requireTestId(container, 'administrator-scope-pick'), 'scopes:write');
    await click(requireTestId(container, 'administrator-revoke'));
    await typeInto(requireTestId(container, 'administrator-scope-reason'), '收回');
    await click(requireTestId(container, 'administrator-scope-submit'));

    const text = textOf(requireTestId(container, 'administrator-scope-failure'));
    assert.match(text, /LAST_SCOPE_MANAGER/);
    assert.match(text, /先给他人授权/);
  } finally {
    unmount();
  }
});

// ---------------------------------------------------------------- 行级闸门与 a11y

test('非 active 行不给授／撤按钮（契约对非 active 目标是 409），停用／恢复入口仍在', async () => {
  const state = makeState({ adminState: 'suspended' });
  const { container, unmount } = await mountView({ fetchImpl: fakeFetch(directoryHandler(state)) });
  try {
    assert.equal(countOf(container, 'administrators-row'), 1);
    assert.equal(countOf(container, 'administrator-grant'), 0, '停用行不该出现授权按钮');
    assert.equal(countOf(container, 'administrator-revoke'), 0, '停用行不该出现撤销按钮');
    assert.equal(countOf(container, 'administrator-scope-pick'), 0, '停用行不该出现 scope 选择器');
    assert.equal(countOf(container, 'administrator-enable'), 1, '停用行的「恢复」入口不能丢');
  } finally {
    unmount();
  }
});

test('a11y：两个按钮都有 aria-label、禁用态带 aria-disabled、样式保留焦点环', async () => {
  const { container, unmount } = await mountView({ fetchImpl: fakeFetch(directoryHandler(makeState())) });
  try {
    for (const id of ['administrator-grant', 'administrator-revoke']) {
      const button = requireTestId(container, id);
      assert.equal(typeof button.props['aria-label'], 'string', `${id} 必须有 aria-label`);
      assert.notEqual(button.props['aria-label'].trim(), '');
      assert.equal(button.props['aria-disabled'], 'true', `${id} 未选 scope 时 aria-disabled=true`);
    }
    const source = readFileSync(VIEW_URL, 'utf8');
    assert.match(source, /:focus-visible/, '焦点环必须留着（:focus-visible 规则）');
    assert.match(source, /aria-disabled/, '模板里要显式绑 aria-disabled');
  } finally {
    unmount();
  }
});
