/**
 * R68 · 渲染级**回归钉子**：`AccountsView.vue` 的会话边界不得把焦点还回上一页面的旧按钮。
 *
 * 先说清这条用例的性质（不许含糊）：
 *   它**不是**缺陷修复，在提交时的源码上它本来就是绿的。它钉的是一条已经成立、
 *   但此前没有任何测试看守的约定——「关闭停用框时要回焦，但**只在触发按钮还连着的时候**」。
 *   判别力由提交信息里记录的变异自证给出：删掉 `AccountsView.vue:167` 那半句
 *   `trigger.isConnected !== false`，本文件第 1 条用例立刻变红（对已断连节点调用 `focus()`）。
 *
 * 为什么这个钉子值得钉（这是 R68 那次误判的根因）：
 *   仓内多数 admin-ui 渲染用例的内存宿主**不实现 `isConnected`**，对那种宿主来说，
 *   「已卸载的按钮」和「还挂着的按钮」长得一模一样，于是任何继承那种口径的用例都会把
 *   「对已卸载按钮调了一次 `focus()`」记成「焦点回流到已切走页面」。真浏览器里对断连节点
 *   调 `focus()` 本身是 no-op，用户看不到任何回流——误判就是这么来的。
 *   所以这里的宿主**忠实实现 `isConnected`**（沿 parent 链判定，只有挂在容器上的子树才算连着），
 *   并给每个节点装一个会记账的 `focus()`。
 *
 * 环境：沿用 `tests/unit/admin-ui-administrators-scope-write-render.test.mjs` 的最小渲染环境
 * （`@vue/compiler-sfc` 真编译 + `createRenderer` 内存宿主，不联网、不装依赖、不用 jsdom）。
 *
 * 本片真正新增的观测量：①（会话切换后不得对任何断连节点调用 `focus()`）与 ③（作控制，
 * 证明记录器确实看得见那一次回焦）——这两件事此前仓内没有任何用例能观测。
 * ② 是功能正对照（不是新观测量）；④ 钉的是「组件没另存 suspend 状态」，
 * reducer 复位已由 `admin-ui-view-model.test.mjs` 直接钉（见 ④ 的注释）。
 *
 * 已知不对称（本片不处理，留给后续片与 `focus()` 夹具一起做）：`focusSuspendTitle()`（:153）
 * 与 `focusNext()`（:203）**没有** `isConnected` 守卫，只有 :167 的回焦有。
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

const VIEW_URL = new URL('../../apps/admin/src/views/AccountsView.vue', import.meta.url);
const ADMIN_API_URL = new URL('../../apps/admin/src/lib/admin-api.mjs', import.meta.url);
const SUSPEND_API_URL = new URL('../../apps/admin/src/lib/account-suspend-api.mjs', import.meta.url);
const DIALOG_FOCUS_URL = new URL('../../apps/admin/src/lib/dialog-focus.mjs', import.meta.url);
const VIEW_MODEL_URL = new URL('../../apps/admin/src/lib/view-model.mjs', import.meta.url);
const VUE_URL = import.meta.resolve('vue');

const SCOPES = ['accounts:read', 'accounts:suspend'];
const SESSION_A = { accessToken: 'synthetic-token-a', expiresAt: '2099-01-01T00:00:00.000Z', scopes: SCOPES };
const SESSION_B = { accessToken: 'synthetic-token-b', expiresAt: '2099-01-01T00:00:00.000Z', scopes: SCOPES };
const ACCOUNTS_PATH = '/api/v1/admin/accounts';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_A = { id: '33333333-3333-4333-8333-333333333333', displayName: '陈云' };
const ACCOUNT_B = { id: '44444444-4444-4444-8444-444444444444', displayName: '赵敏' };
const REASON_A = 'A 会话里写的停用理由';
const REASON_B = 'B 会话里写的停用理由';

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
  assert.deepEqual(errors, [], 'AccountsView.vue 必须能被 @vue/compiler-sfc 解析');
  const compiled = compileScript(descriptor, {
    id: 'gy-accounts-session-focus-render',
    inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false, cacheHandlers: false } },
  });
  const escape = (specifier) => specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const replacements = [
    ['../auth/session', SESSION_STUB_URL],
    ['../lib/admin-api.mjs', ADMIN_API_URL.href],
    ['../lib/account-suspend-api.mjs', SUSPEND_API_URL.href],
    ['../lib/dialog-focus.mjs', DIALOG_FOCUS_URL.href],
    ['../lib/view-model.mjs', VIEW_MODEL_URL.href],
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

/** 每次 `focus()` 都记一笔——这是本文件唯一可信的「焦点有没有动过」的证据。 */
const focusCalls = [];

/**
 * 忠实宿主：节点带真 `isConnected`（沿 parent 链走到标了 `connectedRoot` 的容器才算连着）
 * 与会记账的 `focus()`。这两样是上一条注释里说的「判别力」本身，别为了省事删掉。
 */
function createHost() {
  const make = (kind) => {
    const node = {
      kind,
      children: [],
      parent: null,
      props: {},
      text: '',
      listeners: new Map(),
      connectedRoot: false,
      addEventListener(type, handler) {
        this.listeners.set(type, handler);
      },
      removeEventListener(type) {
        this.listeners.delete(type);
      },
      getRootNode() {
        return globalThis.document;
      },
      focus() {
        focusCalls.push(this);
      },
    };
    Object.defineProperty(node, 'isConnected', {
      get() {
        let cursor = this;
        while (cursor !== null) {
          if (cursor.connectedRoot === true) return true;
          cursor = cursor.parent;
        }
        return false;
      },
    });
    return node;
  };

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

const byClass = (className) => (node) => JSON.stringify(node.props?.class) === JSON.stringify(className);
const countClass = (root, className) => findAll(root, byClass(className)).length;
const suspendButtons = (root) => findAll(root, (node) => node.props?.class === 'link danger');
const buttonWithText = (root, label) =>
  findBy(root, (node) => node.kind === 'button' && textOf(node).trim() === label);
const reasonInput = (root) => findBy(root, (node) => node.props?.name === 'suspend_reason');
const namedInput = (root, name) => findBy(root, (node) => node.props?.name === name);

/**
 * 造一个够用的合成事件：`.stop` 修饰符会调 `stopPropagation()`，
 * 焦点回填读 `currentTarget`——两个都给真值，否则测出来的不是页面行为。
 */
function syntheticEvent(node) {
  return {
    currentTarget: node,
    target: node,
    stopPropagation() {},
    preventDefault() {},
  };
}

async function click(node, label) {
  assert.notEqual(node, null, `页面上找不到「${label}」`);
  assert.equal(typeof node.props.onClick, 'function', `「${label}」必须是绑定了 onClick 的按钮`);
  node.props.onClick(syntheticEvent(node));
  await settle();
}

async function typeInto(node, value, label) {
  assert.notEqual(node, null, `页面上找不到「${label}」`);
  if (typeof node.props.onInput === 'function') node.props.onInput({ target: { value } });
  else node.props['onUpdate:modelValue'](value);
  await settle();
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body };
}

const meta = { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'real' };

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, method: init === undefined ? undefined : init.method });
    return handler({ url, init });
  };
  impl.calls = calls;
  return impl;
}

/** 目录按「当前会话」给行；停用按幂等契约返回升了 revision 的单资源信封。 */
function makeState(overrides = {}) {
  return {
    who: 'A',
    bState: 'active',
    accounts: {
      [ACCOUNT_A.id]: { id: ACCOUNT_A.id, revision: 3, state: 'active', display_name: ACCOUNT_A.displayName },
      [ACCOUNT_B.id]: { id: ACCOUNT_B.id, revision: 7, state: 'active', display_name: ACCOUNT_B.displayName },
    },
    ...overrides,
  };
}

function accountsHandler(state) {
  return ({ url, init }) => {
    if (init !== undefined && init.method === 'POST' && url.endsWith('/suspend')) {
      const id = url.split('/').at(-2);
      const current = state.accounts[id];
      const next = { ...current, state: 'suspended', revision: current.revision + 1 };
      state.accounts[id] = next;
      return jsonResponse(200, { data: next, meta });
    }
    const id = state.who === 'A' ? ACCOUNT_A.id : ACCOUNT_B.id;
    const row = state.accounts[id];
    // B 的目录行状态由用例指定（`bState: 'suspended'` 用来把「0 个停用按钮」量成 0）。
    const effective = row.state === 'active' && state.who === 'B' ? { ...row, state: state.bState } : row;
    return jsonResponse(200, { data: { items: [effective], next_cursor: null }, meta });
  };
}

async function mountView({ fetchImpl, session = SESSION_A } = {}) {
  focusCalls.length = 0;
  const host = createHost();
  const container = host.make('root');
  container.connectedRoot = true;
  const { createApp } = createRenderer({ ...host.nodeOps, patchProp: host.patchProp });
  const originalFetch = globalThis.fetch;
  const originalSession = globalThis.__GY_TEST_SESSION__;
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
      globalThis.__GY_TEST_SESSION__ = originalSession;
    },
  };
}

/** 会话边界：点「退出登录」→ 换会话桩 → 用登录表单登入 → 等表格回来。 */
async function switchToSessionB(container, state) {
  await click(buttonWithText(container, '退出登录'), '退出登录');
  state.who = 'B';
  globalThis.__GY_TEST_SESSION__ = SESSION_B;
  await typeInto(namedInput(container, 'login_name'), 'li_yun', '登录名');
  await typeInto(namedInput(container, 'password'), 'pw-b', '密码');
  const form = findBy(container, (node) => node.props?.class === 'signin');
  assert.notEqual(form, null, '登出后必须出现登录表单');
  form.props.onSubmit({ preventDefault() {} });
  await settle();
  await settle();
}

/** 把一次焦点调用压成可读形状，红的时候能直接看出「回焦到了哪个节点」。 */
function describeFocusCall(node) {
  return {
    kind: node.kind,
    text: textOf(node).trim().slice(0, 20),
    isConnected: node.isConnected,
  };
}

// ------------------------------------------------- 1. 会话边界：0 次回焦 / 0 个残留

test('会话切换（登出 → 登录 B）：不得对已切走页面的旧「停用」按钮回焦，也不得残留停用框', async () => {
  // B 的那一行是「已停用」态：这样「0 个停用按钮」是字面可量的 0，而不是「B 恰好没有按钮」。
  const state = makeState({ bState: 'suspended' });
  const impl = fakeFetch(accountsHandler(state));
  const { container, unmount } = await mountView({ fetchImpl: impl });
  try {
    assert.equal(suspendButtons(container).length, 1, 'A 的列表要先有一行可停用的账号');
    const oldTrigger = suspendButtons(container)[0];
    await click(oldTrigger, '停用（A）');
    assert.equal(countClass(container, 'suspend-confirm'), 1, '点「停用」必须打开确认框');

    await typeInto(reasonInput(container), REASON_A, '停用理由（A）');
    assert.equal(reasonInput(container).props.value, REASON_A, '理由要真的进状态（否则下面的「B 看不到」没有意义）');

    // 最恶劣的时序：框还开着就切会话。
    const focusBefore = focusCalls.length;
    await switchToSessionB(container, state);

    // ① 焦点：0 次回落到旧按钮，也 0 次打到任何已断连的节点。
    const duringSwitch = focusCalls.slice(focusBefore);
    assert.deepEqual(
      duringSwitch.filter((node) => node === oldTrigger).map(describeFocusCall),
      [],
      '会话切换后不得把焦点还回已切走页面的旧「停用」按钮',
    );
    assert.deepEqual(
      duringSwitch.filter((node) => node.isConnected === false).map(describeFocusCall),
      [],
      '不得对任何已断连的节点调用 focus()（守卫的意义就在这里）',
    );
    assert.equal(oldTrigger.isConnected, false, '旧按钮此时必须已断连，否则这条用例量不到真实语义');

    // ② 树上：0 个停用框、0 个「停用」按钮（旧行已随 <template v-else> 整块卸载）。
    assert.equal(countClass(container, 'suspend-confirm'), 0, '切会话后不得残留停用确认框');
    assert.equal(suspendButtons(container).length, 0, '切会话后不得残留上一页面的「停用」按钮');
    assert.equal(
      findAll(container, (node) => node === oldTrigger).length,
      0,
      'A 页面那个「停用」按钮节点本身必须已经不在树上（按对象同一性判，不按文案判）',
    );

    // ③ A 的理由不许跨会话出现（回执面另有 ④ 专门伺候：本条用例里 A 从未停用成功，恒无回执）。
    const pageText = textOf(container);
    assert.equal(pageText.includes(REASON_A), false, 'B 的页面上不得出现 A 写的停用理由');
    assert.match(pageText, new RegExp(ACCOUNT_B.displayName), 'B 必须看到自己的那一行');
    assert.equal(pageText.includes(ACCOUNT_A.displayName), false, 'B 不得看到 A 的行');
  } finally {
    unmount();
  }
});

// ------------------------------------------------- 2. 正对照：B 自己的停用框照样能用

test('正对照：切到 B 之后，B 自己的停用框仍能打开、理由为空、能按契约提交并拿到回执', async () => {
  const state = makeState();
  const impl = fakeFetch(accountsHandler(state));
  const { container, unmount } = await mountView({ fetchImpl: impl });
  try {
    // 先在 A 里开框、写理由，再切走——确保清理没有被「顺手」写成禁用功能。
    await click(suspendButtons(container)[0], '停用（A）');
    await typeInto(reasonInput(container), REASON_A, '停用理由（A）');
    await switchToSessionB(container, state);

    const bTrigger = suspendButtons(container)[0];
    assert.notEqual(bTrigger, null, 'B 自己的行必须有「停用」按钮');
    await click(bTrigger, '停用（B）');
    assert.equal(countClass(container, 'suspend-confirm'), 1, 'B 的停用框必须能打开');
    const reason = reasonInput(container);
    assert.equal(reason.props.value, '', 'B 的理由框必须是空的（A 的理由不许带过来）');

    await typeInto(reason, REASON_B, '停用理由（B）');
    const confirm = buttonWithText(container, '确认停用');
    assert.equal(confirm.props.disabled, false, '理由合法时「确认停用」必须可点');
    await click(confirm, '确认停用');

    const posts = impl.calls.filter((call) => call.init !== undefined && call.init.method === 'POST');
    assert.equal(posts.length, 1, '一次确认只发一次停用 POST');
    assert.equal(posts[0].url, `${ACCOUNTS_PATH}/${ACCOUNT_B.id}/suspend`, 'URL 必须指向 B 的那一行');
    assert.equal(posts[0].init.credentials, 'omit');
    assert.equal(posts[0].init.headers.authorization, `Bearer ${SESSION_B.accessToken}`, '必须带 B 的令牌，不能是 A 的');
    assert.equal(posts[0].init.headers['if-match'], `"${7}"`, 'If-Match 必须取 B 那一行的 revision');
    assert.match(posts[0].init.headers['idempotency-key'], /^account-[0-9a-f]{32}$/, '幂等键形状沿用停用／恢复');
    assert.equal(posts[0].init.body, JSON.stringify({ reason: REASON_B }), 'body 只带 B 的理由，逐字节对');

    assert.equal(countClass(container, 'suspend-confirm'), 0, '提交成功后确认框要关掉');
    assert.equal(countClass(container, 'banner ok'), 1, '成功要有回执');
    assert.match(textOf(container), /停用已生效/, '回执文案要对得上');
  } finally {
    unmount();
  }
});

// ------------------------------------------------- 3. 记录器自检：关框确实会回焦

test('记录器自检：不切会话只关框时，焦点确实回到触发按钮（否则上面对 0 的断言全是空转）', async () => {
  const state = makeState();
  const { container, unmount } = await mountView({ fetchImpl: fakeFetch(accountsHandler(state)) });
  try {
    const trigger = suspendButtons(container)[0];
    await click(trigger, '停用（A）');
    assert.equal(trigger.isConnected, true, '开框时触发按钮必须还连着');

    const focusBefore = focusCalls.length;
    await click(buttonWithText(container, '取消'), '取消');
    assert.equal(countClass(container, 'suspend-confirm'), 0, '取消要关框');
    assert.deepEqual(
      focusCalls.slice(focusBefore).map((node) => node === trigger),
      [true],
      '关框这一次必须把焦点还给触发按钮——这是同一条 watch 的另一半，也是本文件记录器的判别力来源',
    );
  } finally {
    unmount();
  }
});

// ------------------------------------------------- 4. 回执面：A 真拿到过回执，也不能带过去

/**
 * 这条钉的是**组件没有另存一份 suspend 状态**：回执会不会跟到下一个会话，取决于视图只读 reducer。
 *
 * 别把它当成 reducer 的看门人：`SIGN_OUT` 复位本身已经由
 * `tests/unit/admin-ui-view-model.test.mjs` 的「SIGN_OUT 复位到初始态」直接钉死
 * （测试在 :176，断言在 :178，`assert.deepEqual(reduce(loaded, { type: 'SIGN_OUT' }), initialState())`
 * 比的是整状态，覆盖 suspendTargetId / suspendReason / suspendStatus / suspendWrite）。
 * 所以「只让 SIGN_OUT 不复位」这种**单点变异在本片的视图层宿主里不可观测**——
 * 登录必经 `SIGN_IN_START`（view-model.mjs:70 也 return initialState()），
 * 且停用框要 `suspendTargetView` 在当页行里查得到才渲染。本用例只声称：
 * 视图没有绕过 reducer 自己留一份状态。
 */
test('会话切换：A 的停用成功回执不得残留到 B 的页面（钉组件未另存 suspend 状态）', async () => {
  const state = makeState();
  const impl = fakeFetch(accountsHandler(state));
  const { container, unmount } = await mountView({ fetchImpl: impl });
  try {
    // 先让 A 真的走完一次停用，页面上因此有一个成功回执。
    await click(suspendButtons(container)[0], '停用（A）');
    await typeInto(reasonInput(container), REASON_A, '停用理由（A）');
    await click(buttonWithText(container, '确认停用'), '确认停用');
    await settle();

    assert.equal(countClass(container, 'banner ok'), 1, 'A 必须先真的拿到回执，否则这条用例量不到「残留」');
    assert.match(textOf(container), /停用已生效/, 'A 的回执文案要先出现');

    await switchToSessionB(container, state);

    assert.equal(countClass(container, 'banner ok'), 0, 'B 的页面上不得出现 A 的停用成功回执');
    assert.equal(textOf(container).includes('停用已生效'), false, '回执文案同样不许跨会话残留');
    assert.equal(countClass(container, 'suspend-confirm'), 0, 'B 的页面上不得残留停用框');
    assert.match(textOf(container), new RegExp(ACCOUNT_B.displayName), 'B 必须看到自己的那一行');
    assert.equal(textOf(container).includes(REASON_A), false, 'A 的理由也不许跟过来');
  } finally {
    unmount();
  }
});
