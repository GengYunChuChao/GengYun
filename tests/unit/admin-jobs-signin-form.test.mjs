/**
 * 未登录 + 登录失败 ⇒ **表单内可见的安全错误文案**，且仍可再次提交（PR #439 监工 [P2]）。
 *
 * 为什么必须是渲染级用例：`admin-jobs-api.test.mjs` 的 33 项只覆盖 `jobs-api.mjs` 的纯函数，
 * 覆盖不到「登录失败后 `signedIn` 仍为 false、模板停在 `v-if="!signedIn"` 的登录表单里」
 * 这条**实际 SFC 呈现路径** —— 监工 [P2] 指出的正是这一点（失败结果此前只 dispatch，不上屏）。
 *
 * `apps/admin` 没有 vitest／@vue/test-utils／jsdom（仓内前端测试一律是纯函数测试），
 * 所以本文件自带一个最小渲染环境，**不新增依赖、不联网**：
 *   1. `@vue/compiler-sfc`（apps/admin 的 devDependency，随 workspace 装到 node_modules）
 *      把 `JobsView.vue` 编成 ESM 组件（`inlineTemplate: true`，关掉静态提升与事件缓存）；
 *   2. 用 `vue` 自带的 `createRenderer()` 造一个内存宿主（element／text／comment，
 *      元素带 `addEventListener` 以满足 `v-model` 指令），挂载**真实组件**并派发真实 DOM 事件；
 *   3. `../auth/session` 换成 data: URL 桩模块（转发到本文件的钩子），从而能精确制造
 *      「凭据被拒」「会话详情读不到」「登录成功」三条路径；
 *   4. 组件模块本身也走 data: URL，但 `vue` 与 `jobs-api.mjs` 改写成绝对 file: URL，
 *      保证与测试进程共用**同一个** vue 实例（否则 runtime-core 与 vnode 的 Symbol 不匹配）。
 *
 * 断言口径：错误文案必须落在 `<form>` 内部（不是整页某处）、原始异常 message 与服务端
 * error.code 一律不得上屏、输入框与提交按钮保留且能真的再发一次登录请求。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { compileScript, parse } from '@vue/compiler-sfc';
import { createRenderer, nextTick } from 'vue';

import { describeSignInFailure, signInFailureOf } from '../../apps/admin/src/lib/jobs-api.mjs';

// `vModelText` 指令在 beforeUpdate 里做 `el.getRootNode() instanceof Document/ShadowRoot` 的
// 焦点判断；Node 既没有 `document` 也没有这两个构造器，这里只补这几个标识（不引 jsdom；
// `node --test` 默认按文件隔离进程，不会影响其它用例）。
if (globalThis.document === undefined) globalThis.document = { activeElement: null };
if (globalThis.Document === undefined) globalThis.Document = class Document {};
if (globalThis.ShadowRoot === undefined) globalThis.ShadowRoot = class ShadowRoot {};

const VIEW_URL = new URL('../../apps/admin/src/views/JobsView.vue', import.meta.url);
const VUE_URL = import.meta.resolve('vue');
const JOBS_API_URL = import.meta.resolve('../../apps/admin/src/lib/jobs-api.mjs');
const SESSION_HOOK_KEY = '__gyJobsSigninFormTest';

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
}

/** `src/auth/session.ts` 的桩：只做转发，行为完全由用例注入。 */
function sessionStubUrl() {
  return moduleUrl(
    [
      "export const API_BASE_URL = '/api/v1';",
      `const hooks = () => globalThis.${SESSION_HOOK_KEY};`,
      'export const signInAdmin = (credentials) => hooks().signInAdmin(credentials);',
      'export const loadAdminSession = () => hooks().loadAdminSession();',
      'export const signOutAdmin = () => hooks().signOutAdmin();',
    ].join('\n'),
  );
}

let componentPromise = null;

/** 编译真实的 JobsView.vue：把裸模块说明符全换成绝对 URL（data: 模块不能再解析裸说明符）。 */
function loadJobsViewComponent() {
  if (componentPromise !== null) return componentPromise;
  const source = readFileSync(VIEW_URL, 'utf8');
  const { descriptor, errors } = parse(source, { filename: fileURLToPath(VIEW_URL) });
  assert.deepEqual(errors, [], 'JobsView.vue 必须能被 @vue/compiler-sfc 解析');
  const compiled = compileScript(descriptor, {
    id: 'gy-jobs-signin-form',
    inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false, cacheHandlers: false } },
  });
  const code = compiled.content
    .replace(/from\s+["']vue["']/g, `from '${VUE_URL}'`)
    .replace(/from\s+["']\.\.\/lib\/jobs-api\.mjs["']/g, `from '${JOBS_API_URL}'`)
    .replace(/from\s+["']\.\.\/auth\/session["']/g, `from '${sessionStubUrl()}'`);
  assert.deepEqual(
    [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]).filter((id) => !/^(data:|file:)/.test(id)),
    [],
    '编译产物里不得残留裸模块说明符（data: 模块无法解析它们）',
  );
  componentPromise = import(moduleUrl(code)).then((namespace) => namespace.default);
  return componentPromise;
}

/** 内存宿主：节点足够支撑 Vue 的元素/文本/注释与 v-model 指令。 */
function createHost() {
  const make = (kind) => ({
    kind,
    children: [],
    parent: null,
    props: {},
    text: '',
    value: '',
    listeners: new Map(),
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    },
    removeEventListener(type) {
      this.listeners.delete(type);
    },
    // v-model 只在“元素是否持有焦点”时用到根节点；内存宿主永远返回「没有焦点」。
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

function findBy(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children) {
    const hit = findBy(child, predicate);
    if (hit !== null) return hit;
  }
  return null;
}

function findAll(root, predicate, found = []) {
  if (predicate(root)) found.push(root);
  for (const child of root.children) findAll(child, predicate, found);
  return found;
}

function textOf(node) {
  if (node.kind === '#text') return node.text;
  return node.children.map(textOf).join('');
}

function makeHooks({ signIn, loadSession }) {
  const calls = { signIn: [], loadSession: 0, signOut: 0 };
  return {
    calls,
    hooks: {
      signInAdmin: async (credentials) => {
        calls.signIn.push(credentials);
        return signIn(credentials);
      },
      loadAdminSession: async () => {
        calls.loadSession += 1;
        return loadSession(calls.loadSession);
      },
      signOutAdmin: async () => {
        calls.signOut += 1;
      },
    },
  };
}

async function mountView(hooks) {
  globalThis[SESSION_HOOK_KEY] = hooks;
  const host = createHost();
  const container = host.make('root');
  const { createApp } = createRenderer({ ...host.nodeOps, patchProp: host.patchProp });
  const app = createApp(await loadJobsViewComponent());
  app.mount(container);
  await settle();
  return { app, container };
}

const isClassed = (token) => (node) => typeof node.props.class === 'string' && node.props.class.split(/\s+/).includes(token);

function inputByName(root, name) {
  return findBy(root, (node) => node.kind === 'input' && node.props.name === name);
}

/** 真实 DOM 事件：写值 + 派发 input（v-model 的监听器由指令挂上）。 */
function type(input, value) {
  assert.ok(input !== null, '找不到输入框');
  input.value = value;
  input.dispatch('input');
}

function requireForm(container) {
  const form = findBy(container, (node) => node.kind === 'form');
  assert.ok(form !== null, '未登录时应渲染登录表单');
  return form;
}

function submit(form) {
  assert.equal(typeof form.props.onSubmit, 'function', '登录表单必须挂着 submit 处理器');
  form.props.onSubmit({ preventDefault() {} });
}

function submitButtonOf(form) {
  const button = findBy(form, (node) => node.kind === 'button' && node.props.type === 'submit');
  assert.ok(button !== null, '登录表单必须保留提交入口');
  return button;
}

const EMPTY_PAGE = () => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => ({ data: { items: [], next_cursor: null }, meta: { request_id: 'req-jobs-test' } }),
});

test('describeSignInFailure 只输出白名单文案：message／error.code 永远不上屏', () => {
  const hostile = {
    ok: false,
    kind: 'signin_rejected',
    status: 401,
    code: 'SECRET_BACKEND_CODE',
    message: '后台登录失败：INTERNAL_STACK_42 at db.ts:88',
  };
  const rejected = describeSignInFailure(hostile);
  assert.match(rejected.title, /登录未通过/);
  assert.match(rejected.detail, /登录名或密码不正确/);
  assert.doesNotMatch(`${rejected.title}${rejected.detail}`, /SECRET_BACKEND_CODE|INTERNAL_STACK_42|后台登录失败/);

  assert.match(describeSignInFailure({ ok: false, kind: 'signin_session_unreadable' }).title, /读不到会话详情/);
  assert.match(describeSignInFailure({ ok: false, kind: 'signin_throttled' }).title, /过于频繁/);
  assert.match(describeSignInFailure({ ok: false, kind: 'signin_unavailable' }).title, /未完成/);
  assert.match(describeSignInFailure({ ok: false, kind: '契约外' }).title, /登录未成功/);
  assert.equal(describeSignInFailure(null), null);
  assert.equal(describeSignInFailure({ ok: true }), null);
});

test('signInFailureOf 区分凭据拒绝／限流／服务不可用，且不把原始 message 带进状态', () => {
  const cases = [
    [new Error('后台登录失败：SESSION_REQUIRED'), 'signin_rejected'],
    [new Error('后台登录失败：HTTP 401'), 'signin_rejected'],
    [new Error('后台登录失败：SCOPE_DENIED'), 'signin_rejected'],
    [new Error('后台登录失败：ACCOUNT_INACTIVE'), 'signin_rejected'],
    [new Error('后台登录失败：HTTP 429'), 'signin_throttled'],
    [new Error('后台登录失败：HTTP 500'), 'signin_unavailable'],
    [new Error('后台登录失败：HTTP 200'), 'signin_unavailable'],
    [new TypeError('fetch failed'), 'signin_unavailable'],
    [new Error('后台登录请求已失效'), 'signin_unavailable'],
    ['not an error', 'signin_unavailable'],
  ];
  for (const [error, kind] of cases) {
    const failure = signInFailureOf(error);
    assert.equal(failure.ok, false);
    assert.equal(failure.kind, kind, `${String(error)} 应归到 ${kind}`);
    assert.equal('message' in failure, false, 'failure 不得携带原始异常 message');
  }
});

for (const [label, thrown, copy] of [
  ['凭据被拒', () => { throw new Error('后台登录失败：SESSION_REQUIRED'); }, /登录未通过/],
  ['会话详情读不到', null, /读不到会话详情/],
]) {
  test(`未登录 + 登录失败（${label}）⇒ 表单内可见安全错误文案，且仍可再次提交`, async () => {
    const { hooks, calls } = makeHooks({
      signIn: thrown ?? (async () => ({ accessToken: 'synthetic-token', expiresAt: '2099-01-01T00:00:00Z', scopes: [] })),
      loadSession: async () => null,
    });
    const { app, container } = await mountView(hooks);
    try {
      let form = requireForm(container);
      type(inputByName(form, 'login_name'), 'synthetic-admin');
      type(inputByName(form, 'password'), 'synthetic-wrong');
      await settle();

      submit(form);
      await settle();

      // 1) 失败结果必须在**未登录表单内部**可见（监工 [P2] 的核心）。
      form = requireForm(container);
      const notice = findAll(form, isClassed('banner'));
      assert.equal(notice.length, 1, '失败后未登录表单内必须有且只有一条错误提示');
      assert.match(textOf(notice[0]), copy);
      assert.match(textOf(notice[0]), /再次提交|重新输入口令/);

      // 2) 不泄露后端细节：服务端错误码与原始异常文案不得上屏。
      const pageText = textOf(container);
      assert.doesNotMatch(pageText, /SESSION_REQUIRED|后台登录失败|synthetic-wrong/);

      // 3) 输入与提交入口保留（未登录态没有被伪造掉）。
      assert.ok(inputByName(form, 'login_name') !== null, '登录名输入框必须保留');
      assert.ok(inputByName(form, 'password') !== null, '密码输入框必须保留');
      assert.ok(findBy(container, isClassed('signin')) !== null, '未登录登录表单必须仍在');
      const submitButton = submitButtonOf(form);
      const passwordInput = inputByName(form, 'password');

      if (label === '会话详情读不到') {
        // 登录响应成功后本页立刻丢弃明文口令 ⇒ 按钮先禁用，这正是“重新输入口令后再提交”的文案所指。
        assert.equal(passwordInput.value, '', '登录成功后不保留明文口令');
        assert.equal(submitButton.props.disabled, true, '口令已清空时不得允许空口令提交');
        type(passwordInput, 'synthetic-second');
        await settle();
      }
      assert.equal(submitButton.props.disabled, false, '失败后必须能再次提交');
      assert.equal(calls.signIn.length, 1);

      // 4) 再提交一次：真的又发了一次登录请求（入口不是摆设）。
      submit(form);
      await settle();
      assert.equal(calls.signIn.length, 2, '再次提交必须真的重发登录请求');
      assert.ok(findBy(container, (node) => node.kind === 'form') !== null, '再次失败后仍停在登录表单');
    } finally {
      app.unmount();
    }
  });
}

test('登录成功后进入已登录分支：登录表单与失败提示一起消失（已登录行为不变）', async () => {
  let reads = 0;
  const { hooks } = makeHooks({
    signIn: async () => ({ accessToken: 'synthetic-token', expiresAt: '2099-01-01T00:00:00Z', scopes: [] }),
    loadSession: async () => {
      reads += 1;
      // 首次（挂载时）没有会话；登录后的那次查询返回带 scope 的会话。
      return reads === 1
        ? null
        : { accessToken: 'synthetic-token', expiresAt: '2099-01-01T00:00:00Z', scopes: ['jobs:read', 'jobs:cancel'] };
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => EMPTY_PAGE();
  const { app, container } = await mountView(hooks);
  try {
    const form = requireForm(container);
    type(inputByName(form, 'login_name'), 'synthetic-admin');
    type(inputByName(form, 'password'), 'synthetic-only');
    await settle();
    submit(form);
    await settle();

    assert.equal(findBy(container, (node) => node.kind === 'form'), null, '已登录后登录表单必须消失');
    assert.equal(findAll(container, isClassed('banner')).length, 0, '已登录分支不该出现登录失败提示');
    assert.match(textOf(container), /暂无作业/, '已登录分支沿用原有读面状态文案');
  } finally {
    globalThis.fetch = originalFetch;
    app.unmount();
  }
});
