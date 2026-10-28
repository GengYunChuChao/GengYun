/**
 * R68 · 渲染级用例：`AdministratorsView.vue` 的**停用／恢复**写面在**会话切换**时的隔离。
 *
 * 这是 #711（授权／撤销）的姊妹片，缺陷同类：写面状态挂在组件上、`signOut()` 不清、
 * 在途写响应的序号不递增，于是
 * ① A 打开过的停用确认框（目标管理员 + 理由）与成功回执会在 B 登录后**重新渲染**；
 * ② A 那条还没回来的停用响应会在 B 的会话里**落地**——往 B 的页面写回执，还替 B 触发一次刷新读。
 *
 * 为什么要渲染级：这条缺陷只在「真渲染 + 真点按钮 + 真切会话」时存在，源码正则看不出
 * 「B 的页面上有没有 A 的框」。所以这里照 `admin-ui-administrators-scope-write-render.test.mjs`
 * 的做法：`@vue/compiler-sfc` 真编译 SFC → 内存宿主挂真组件 → 真点按钮 → `fakeFetch` 记调用。
 *
 * 两条永久用例：
 * - `会话切换：A 的停用/恢复框与回执不得残留到 B`
 * - `在途响应不落地：A 的停用响应在 B 的会话里回来 ⇒ 不许上屏、也不许替 B 触发刷新读`
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { compileScript, parse } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick } from 'vue';

/**
 * 给 `WriteReceipt` 替身用的 `h`：替身是独立 `data:` 模块，拿不到本文件的 import，
 * 所以从这里挂上去（否则只能 `render() { return null }`，回执面板等于没测）。
 */
globalThis.__GY_H__ = h;

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
const LOGIN_A = 'chen_yun';
/** B 会话看到的是**另一个**管理员：A 的目标管理员绝不能借道残留出现在 B 的页面上。 */
const ADMIN_ID_B = '33333333-3333-4333-8333-333333333333';
const LOGIN_B_ADMIN = 'zhou_yu';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const REASON_A = 'A 会话里写的停用理由';

const SESSION_A = { accessToken: 'synthetic-admin-token-a', expiresAt: '2099-01-01T00:00:00.000Z', scopes: ['scopes:read'] };
const SESSION_B = { accessToken: 'synthetic-admin-token-b', expiresAt: '2099-01-01T00:00:00.000Z', scopes: ['scopes:read'] };

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

/**
 * `WriteReceipt` 替身：**真渲染**回执内容（不是 `render() { return null }`）。
 *
 * 为什么要真渲染：停用／恢复的成功回执里恰好装着这一片最敏感的三样东西——
 * 目标管理员的请求 URL（含 `admin_accounts.id`）、本次真实发出的 `If-Match`、`Idempotency-Key`。
 * 替身若返回 null，这些字段一次都不会上树，「B 不得看到 A 的回执」就退化成空断言，
 * `changeReceipt.value = null` 那条清理也就失去判别力。
 *
 * 字段名照真组件的入参：唯一 prop 是 `write`（`receiptLines()` 读 `label`/`requestUrl`/
 * `sentHeaders['if-match']`/`sentHeaders['idempotency-key']`），另加 `changed` 三值。
 */
const WRITE_RECEIPT_STUB_URL = moduleUrl(`
export default {
  name: 'WriteReceipt',
  props: ['write', 'auditLookup', 'canAudit', 'canReloadDetail', 'changed'],
  emits: ['lookup-audit', 'clear-receipt', 'reload-detail'],
  render() {
    const h = globalThis.__GY_H__;
    const w = this.write;
    if (w === null || w === undefined) return null;
    const sent = w.sentHeaders === null || w.sentHeaders === undefined ? {} : w.sentHeaders;
    const url = w.requestUrl ?? '';
    const ifMatch = sent['if-match'] ?? '';
    const idempotencyKey = sent['idempotency-key'] ?? '';
    return h('section', {
      'data-testid': 'write-receipt',
      'data-url': url,
      'data-if-match': ifMatch,
      'data-idempotency-key': idempotencyKey,
      'data-verdict': this.changed ?? '',
    }, [
      h('p', null, [w.label ?? '']),
      h('p', null, ['请求 URL ', url]),
      h('p', null, ['发出的 If-Match ', ifMatch]),
      h('p', null, ['发出的 Idempotency-Key ', idempotencyKey]),
    ]);
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
    id: 'gy-administrators-state-write-session-render',
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

/** `.stop` 修饰符会调 `stopPropagation()`，焦点回填会读 `currentTarget`：两个都给真值。 */
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

/**
 * 往 `<input>` 里打值。停用／恢复的理由框用 `v-model`（编译成 vModelText 指令 → `addEventListener('input')`），
 * 授权／撤销的框用显式 `@input`（`onInput` 进 props）——两边都要支持，否则测不到真页面行为。
 */
async function typeInto(node, value) {
  node.value = value;
  const event = { target: { value, composing: false } };
  if (typeof node.props.onInput === 'function') node.props.onInput(event);
  else if (node.listeners.has('input')) node.dispatch('input', event);
  else assert.fail('理由输入框必须接受输入（v-model 或 @input）');
  await settle();
}

/** 提交表单（`@submit.prevent` 会先调 preventDefault 再进 handler）。 */
async function submitForm(container, testId) {
  const form = requireTestId(container, testId);
  assert.equal(typeof form.props.onSubmit, 'function', `${testId} 必须绑定了 onSubmit`);
  form.props.onSubmit({ preventDefault() {} });
  await settle();
  await settle();
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body };
}

const meta = { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'real' };

function administratorPage(items, nextCursor = null) {
  return { data: { items, next_cursor: nextCursor }, meta };
}

/** 目录行（`AdminAdministratorView`：id / login_name / revision / state / scopes）。 */
function administrator(overrides = {}) {
  return {
    id: ADMIN_ID,
    login_name: LOGIN_A,
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

async function mountView({ fetchImpl, session = SESSION_A } = {}) {
  const host = createHost();
  const container = host.make('root');
  const { createApp } = createRenderer({ ...host.nodeOps, patchProp: host.patchProp });
  const originalFetch = globalThis.fetch;
  if (fetchImpl !== undefined) globalThis.fetch = fetchImpl;
  globalThis.__GY_TEST_SESSION__ = session;
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

/**
 * 目录 + 停用／恢复端点。
 * 目录按**令牌**分人：A 看到 `chen_yun`（ADMIN_ID），B 看到 `zhou_yu`（ADMIN_ID_B）——
 * 这样「B 的页面上还有没有 A 的目标」才是一条真断言，而不是两边恰好同一个 id。
 */
function stateHandler(state) {
  return ({ url, init }) => {
    if (init !== undefined && init.method === 'POST') {
      const target = String(url);
      if (state.writeResponse !== undefined) return state.writeResponse;
      state.adminState = target.endsWith('/disable') ? 'suspended' : 'active';
      state.revision += 1;
      return jsonResponse(200, stateView({ revision: state.revision, state: state.adminState }));
    }
    const token = init === undefined || init.headers === undefined ? null : init.headers.authorization;
    if (token === `Bearer ${SESSION_B.accessToken}`) {
      return jsonResponse(200, administratorPage([
        administrator({ id: ADMIN_ID_B, login_name: LOGIN_B_ADMIN, revision: 5 }),
      ]));
    }
    return jsonResponse(200, administratorPage([
      administrator({ id: ADMIN_ID, login_name: LOGIN_A, revision: state.revision, state: state.adminState }),
    ]));
  };
}

function makeState(overrides = {}) {
  return { revision: 3, adminState: 'active', ...overrides };
}

/** A 退出 → B 登录（B 的目录是另一个管理员，revision 5）。 */
async function signOutThenSignInAsB(container) {
  await click(requireTestId(container, 'administrators-sign-out'));
  globalThis.__GY_TEST_SESSION__ = SESSION_B;
  await submitForm(container, 'administrators-signin');
  assert.equal(countOf(container, 'administrators-table'), 1, 'B 登录后应当读到目录（新会话建立）');
}

// ---------------------------------------------------------------- S1：残留

test('会话切换：A 的停用/恢复框与回执不得残留到 B', async () => {
  // ① A 打开停用确认框并写好理由 → 退出 → B 登录：框／目标／理由都不许留下
  const openState = makeState();
  const openImpl = fakeFetch(stateHandler(openState));
  const opened = await mountView({ fetchImpl: openImpl });
  try {
    await click(requireTestId(opened.container, 'administrator-disable'));
    assert.equal(countOf(opened.container, 'administrator-state-dialog'), 1, 'A 的停用确认框应当是开着的');
    assert.match(textOf(opened.container), /确认停用管理员账号/, 'A 的对话框标题应当在');
    await typeInto(requireTestId(opened.container, 'administrator-state-reason'), REASON_A);
    assert.equal(countOf(opened.container, 'administrator-state-reason'), 1, 'A 的理由输入框应当是渲染出来的（自检）');

    await signOutThenSignInAsB(opened.container);

    // ①-a 框关掉：目标管理员（标题 + 请求行）不再上屏
    assert.equal(countOf(opened.container, 'administrator-state-dialog'), 0, 'B 不得看到 A 的停用确认框（确认框必须已关）');
    assert.equal(
      findAll(opened.container, (node) => node.props.id === 'administrator-state-title').length,
      0,
      'B 不得看到 A 的停用框标题',
    );
    assert.doesNotMatch(textOf(opened.container), /确认停用管理员账号/, 'B 的页面上不许再出现 A 的确认框文案');
    // ①-b 理由不残留
    assert.equal(countOf(opened.container, 'administrator-state-reason'), 0, 'B 不得看到 A 的理由输入框');
    assert.doesNotMatch(textOf(opened.container), new RegExp(REASON_A), 'B 不得看到 A 填的停用理由');
    // ①-c 目标管理员不残留（B 的目录里是另一个 id / 登录名）
    assert.doesNotMatch(textOf(opened.container), new RegExp(ADMIN_ID), 'B 不得看到 A 的停用目标 id');
    assert.doesNotMatch(textOf(opened.container), new RegExp(LOGIN_A), 'B 不得看到 A 的停用目标登录名');
    assert.match(textOf(opened.container), new RegExp(ADMIN_ID_B), 'B 应当看到自己会话里的管理员（自检）');
    // ①-d 回执 / 失败提示都不许跨会话留下
    assert.equal(countOf(opened.container, 'administrator-state-ok'), 0, 'B 不得看到 A 的成功回执');
    assert.equal(countOf(opened.container, 'administrator-state-failure'), 0, 'B 不得看到 A 的失败提示');
    // ①-e 新会话真的建立了（最近一次读用的是 B 的令牌）
    const lastRead = openImpl.calls[openImpl.calls.length - 1];
    assert.equal(lastRead.init.headers.authorization, `Bearer ${SESSION_B.accessToken}`, 'B 建立会话后应当用 B 的令牌重读');
  } finally {
    opened.unmount();
  }

  // ② A 拿到停用成功回执 → 退出 → B 登录：回执不许留在 B 的页面上
  const doneState = makeState();
  const doneImpl = fakeFetch(stateHandler(doneState));
  const done = await mountView({ fetchImpl: doneImpl });
  try {
    await click(requireTestId(done.container, 'administrator-disable'));
    await typeInto(requireTestId(done.container, 'administrator-state-reason'), REASON_A);
    await click(requireTestId(done.container, 'administrator-state-submit'));
    await settle();
    const okA = requireTestId(done.container, 'administrator-state-ok');
    assert.equal(okA.props.role, 'status', 'A 的成功回执应当是 role=status（自检）');
    assert.match(textOf(okA), new RegExp(LOGIN_A), 'A 的回执里写着 A 的目标（自检）');

    await signOutThenSignInAsB(done.container);

    assert.equal(countOf(done.container, 'administrator-state-ok'), 0, 'B 不得看到 A 的停用成功回执');
    assert.doesNotMatch(textOf(done.container), /已停用/, 'B 的页面上不许再出现 A 的回执文案');
    assert.equal(countOf(done.container, 'administrator-state-dialog'), 0, 'B 不得看到 A 的确认框');
    assert.equal(countOf(done.container, 'administrator-state-failure'), 0, 'B 不得看到 A 的失败提示');
    assert.doesNotMatch(textOf(done.container), new RegExp(LOGIN_A), 'B 不得看到 A 的停用目标登录名');
  } finally {
    done.unmount();
  }
});

// ---------------------------------------------------------------- S2：在途

test('在途响应不落地：A 的停用响应在 B 的会话里回来 ⇒ 不许上屏、也不许替 B 触发刷新读', async () => {
  const state = makeState();
  const impl = fakeFetch(stateHandler(state));
  const { container, unmount } = await mountView({ fetchImpl: impl });
  try {
    // A 发起停用，响应**不 resolve**
    let release = null;
    state.writeResponse = new Promise((resolve) => {
      release = resolve;
    });
    await click(requireTestId(container, 'administrator-disable'));
    await typeInto(requireTestId(container, 'administrator-state-reason'), REASON_A);
    await click(requireTestId(container, 'administrator-state-submit'));
    assert.equal(countOf(container, 'administrator-state-progress'), 1, 'A 的停用请求应当在途（saving）');

    await signOutThenSignInAsB(container);
    const callsAfterSwitch = impl.calls.length;
    const postsBefore = impl.calls.filter((call) => call.method === 'POST').length;
    assert.equal(postsBefore, 1, 'A 那条停用 POST 应当只有一条');

    // A 的响应迟到：在 B 的会话期间 resolve
    release(jsonResponse(200, stateView({ revision: 9, state: 'suspended' })));
    await settle();
    await settle();
    await settle();

    assert.equal(countOf(container, 'administrator-state-ok'), 0, 'A 的在途停用响应不得跨会话落地（不许出现 A 的成功回执）');
    assert.equal(countOf(container, 'administrator-state-failure'), 0, 'A 的在途停用响应不得跨会话落地（不许出现失败提示）');
    assert.equal(countOf(container, 'administrator-state-progress'), 0, '在途标记要复位，不许卡住 B 的页面');
    assert.deepEqual(
      findAll(container, byTestId('administrator-revision')).map(textOf),
      ['5'],
      'B 的行 revision 不许被 A 的响应改动',
    );
    assert.equal(impl.calls.length, callsAfterSwitch, 'A 的迟到响应不得替 B 触发刷新读（不许新增请求）');
  } finally {
    unmount();
  }
});

// ---------------------------------------------------------------- S3：回执面板（WriteReceipt）残留

/**
 * 回执面板是这一片里**最敏感**的一份残渣：`WriteReceipt` 显示的是「这一次请求真的发生了什么」——
 * 目标管理员 id 拼在 `requestUrl` 里、还有本次真实发出的 `If-Match` 与 `Idempotency-Key`。
 * 它由 `changeReceipt` 单独驱动（不在确认框里，`changeTarget` 清了也照样渲染），
 * 所以必须单独断言，不能靠「框关了」顺带覆盖。
 */
test('A 的停用回执（目标 URL / If-Match / 幂等键）不得残留到 B', async () => {
  const state = makeState();
  const impl = fakeFetch(stateHandler(state));
  const { container, unmount } = await mountView({ fetchImpl: impl });
  try {
    await click(requireTestId(container, 'administrator-disable'));
    await typeInto(requireTestId(container, 'administrator-state-reason'), REASON_A);
    await click(requireTestId(container, 'administrator-state-submit'));
    await settle();

    // 自检：A 的成功回执真的渲染出来了，而且带着三样敏感字段（否则下面的断言是空的）
    const receiptA = requireTestId(container, 'write-receipt');
    const urlA = receiptA.props['data-url'] ?? '';
    const ifMatchA = receiptA.props['data-if-match'] ?? '';
    const keyA = receiptA.props['data-idempotency-key'] ?? '';
    assert.ok(urlA.includes(ADMIN_ID), `A 的回执 URL 里应当有 A 的停用目标 id（自检），实际 ${urlA}`);
    assert.equal(ifMatchA, '"3"', 'A 的回执里应当有本次真实发出的 If-Match（自检）');
    assert.ok(keyA.startsWith('administrator-'), `A 的回执里应当有幂等键（自检），实际 ${keyA}`);
    assert.equal(receiptA.props['data-verdict'], 'changed', '成功且 changed:true ⇒ 回执判定是 changed（自检）');
    assert.ok(textOf(receiptA).includes(urlA), '回执面板应当把请求 URL 显示成文本（自检）');

    await signOutThenSignInAsB(container);

    assert.equal(countOf(container, 'write-receipt'), 0, 'B 的页面上不得出现 A 的写回执面板');
    assert.equal(
      findAll(container, (node) => typeof node.props['data-url'] === 'string' && node.props['data-url'].includes(ADMIN_ID)).length,
      0,
      'B 的树上不得有指向 A 的停用目标的回执节点',
    );
    assert.equal(
      findAll(container, (node) => node.props['data-idempotency-key'] === keyA).length,
      0,
      'A 那一次的幂等键不得跨会话留在 B 的树上',
    );
    assert.equal(textOf(container).includes(ADMIN_ID), false, 'B 的页面上不得出现 A 的停用目标 id（回执文本也不行）');
    assert.equal(textOf(container).includes(keyA), false, 'B 的页面上不得出现 A 那一次的幂等键');
    assert.equal(textOf(container).includes(LOGIN_A), false, 'B 的页面上不得出现 A 的停用目标登录名');
    assert.equal(textOf(container).includes(LOGIN_B_ADMIN), true, 'B 应当看到自己会话里的管理员（自检）');
  } finally {
    unmount();
  }
});

// ---------------------------------------------------------------- S4：B 自己的停用框还能用

/**
 * 清理不能把 B 自己的界面清坏：
 *  - `changeSaving` 没复位 ⇒ B 行上的「停用／恢复」按钮永久 `disabled`（模板里逐行绑着它）；
 *  - `changeReason` 没清 ⇒ B 打开自己的确认框时，理由输入框里是 A 写的理由，
 *    一路点下去就会把 A 的措辞写进 B 的审计。
 */
test('切到 B 后 B 自己的停用确认框仍能打开，且理由框不带 A 的理由', async () => {
  const state = makeState();
  const impl = fakeFetch(stateHandler(state));
  const { container, unmount } = await mountView({ fetchImpl: impl });
  try {
    // A 发起停用，响应**不 resolve**：切会话时 changeSaving 还是 true
    let release = null;
    state.writeResponse = new Promise((resolve) => {
      release = resolve;
    });
    await click(requireTestId(container, 'administrator-disable'));
    await typeInto(requireTestId(container, 'administrator-state-reason'), REASON_A);
    await click(requireTestId(container, 'administrator-state-submit'));
    assert.equal(countOf(container, 'administrator-state-progress'), 1, 'A 的停用请求应当在途（自检）');

    await signOutThenSignInAsB(container);

    // ① B 自己的按钮必须可用（A 的在途状态不许把 B 的行禁掉）
    const disableB = requireTestId(container, 'administrator-disable');
    assert.equal(disableB.props.disabled, false, 'B 行上的「停用」按钮必须可用（A 的在途状态不得跨会话禁用它）');

    // ② B 能正常打开自己的确认框
    await click(disableB);
    assert.equal(countOf(container, 'administrator-state-dialog'), 1, 'B 应当能打开自己的停用确认框');
    assert.equal(countOf(container, 'administrator-state-progress'), 0, 'B 的确认框里不许显示 A 在途的「提交中…」');

    // ③ 理由框是空的：A 写的理由不许跟到 B 的会话里。
    //    宿主的节点是内存对象，`v-model` 写进去的 DOM `value` 不保证可读，所以这里**用行为断言**：
    //    理由为空时提交必须被本地拦下（一个字节都不发），并弹出「理由不能为空」——
    //    若 A 的理由还留在 `changeReason` 里，这一次点击就会把 A 的措辞真发出去（请求体里就能看见）。
    const callsBefore = impl.calls.length;
    const postsBefore = impl.calls.filter((call) => call.method === 'POST').length;
    await click(requireTestId(container, 'administrator-state-submit'));
    const freshCalls = impl.calls.slice(callsBefore);
    const freshPosts = freshCalls.filter((call) => call.method === 'POST');
    assert.equal(
      impl.calls.filter((call) => call.method === 'POST').length,
      postsBefore,
      'B 的理由框必须是空的：空理由提交应当被本地拦下（不发请求）',
    );
    assert.equal(
      freshCalls.map((call) => String(call.init?.body ?? '')).join('\n').includes(REASON_A),
      false,
      'B 新发出的请求体里不得出现 A 填的停用理由',
    );
    assert.equal(freshPosts.length, 0, '空理由提交不许发出任何 POST');
    assert.match(
      textOf(requireTestId(container, 'administrator-state-problem')),
      /理由不能为空/,
      'B 的理由框为空 ⇒ 应当提示「理由不能为空」',
    );
    assert.equal(textOf(container).includes(REASON_A), false, 'B 的页面上不得出现 A 填的停用理由');

    // ④ 取消仍然可用（提交中不许关框的守卫不该被 A 的在途状态继承过来）
    await click(requireTestId(container, 'administrator-state-cancel'));
    assert.equal(countOf(container, 'administrator-state-dialog'), 0, 'B 点「取消」应当能关掉自己的确认框');

    // ⑤ A 的迟到响应回来也不许改变 B 的页面
    release(jsonResponse(200, stateView({ revision: 9, state: 'suspended' })));
    await settle();
    await settle();
    await settle();
    assert.equal(countOf(container, 'administrator-state-ok'), 0, 'A 的迟到响应不得在 B 的会话里上屏');
    assert.equal(countOf(container, 'write-receipt'), 0, 'A 的迟到响应不得在 B 的会话里生成回执面板');
    assert.deepEqual(
      findAll(container, byTestId('administrator-revision')).map(textOf),
      ['5'],
      'B 的行 revision 不许被 A 的响应改动',
    );
  } finally {
    unmount();
  }
});
