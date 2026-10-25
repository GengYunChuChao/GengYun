/**
 * 「资料管理」登录成功后必须**立刻**拿到 scopes（R18 回归防线）。
 *
 * 为什么必须是渲染级用例：缺陷的现象整条都长在 `ContentAdminView.vue` 的 SFC 呈现路径上 ——
 * `signInAdmin` 的登录响应不带 scope（`apps/admin/src/auth/session.ts:17`），旧版 `submitLogin()`
 * 只把响应直接塞进 `session`，于是来源 / 知识库 / 分类 / 下架 4 个子页收到的 `scopes` 恒为 `[]`，
 * `canWrite` / `canAudit` 全 false，用户登录完必须手点「重读会话」或刷新才恢复。
 * 这段退化对 `tsc --noEmit` 与 `vite build` 都是绿的，纯函数测试也碰不到 `submitLogin()`，
 * 所以要靠真实组件渲染来钉。
 *
 * `apps/admin` 没有 vitest／@vue/test-utils／jsdom（仓内前端测试一律是纯函数测试），本文件沿用
 * `tests/unit/admin-jobs-signin-form.test.mjs` 的最小渲染环境，**不新增依赖、不联网**：
 *   1. `@vue/compiler-sfc`（apps/admin 的 devDependency，随 workspace 装到 node_modules）
 *      把 `ContentAdminView.vue` 编成 ESM 组件（`inlineTemplate: true`，关掉静态提升与事件缓存）；
 *   2. 用 `vue` 自带的 `createRenderer()` 造内存宿主（element／text／comment，元素带
 *      `addEventListener` 以满足 `v-model` 指令），挂载**真实组件**并派发真实事件；
 *   3. `../auth/session` 与 4 个子页换成 data: URL 桩模块：会话桩精确制造「登录成功但再读会话失败」
 *      与「登录成功且再读会话可用」两条路径，子页桩只记录父组件真正传下来的 `baseUrl` / `token` /
 *      `scopes`，并用**真实常量**（`admin-content-contract.mjs` 的 `SOURCES_WRITE_SCOPE` /
 *      `AUDIT_READ_SCOPE`）算出子页自己的 `canWrite` / `canAudit` 口径；
 *   4. 组件模块本身也走 data: URL，但 `vue` 与上述 .mjs 改写成绝对 file: URL，
 *      保证与测试进程共用**同一个** vue 实例（否则 runtime-core 与 vnode 的 Symbol 不匹配）。
 *
 * 断言口径：4 个子页 tab 逐个切过去都必须收到 3 项 scope 且 `canWrite` / `canAudit` 为 true；
 * 读不到会话时必须停在登录表单、给出可执行的中文失败态（而不是静默进内容页 + 空 scope）；
 * 顶部 scope 提示行必须显示真实 scope 列表。
 *
 * 负控制（改代码时请复跑）：把 `submitLogin()` 里「登录后再读一次会话」那两段删回旧写法，
 * 本文件的用例 1 / 3 必须立刻变红 —— 只覆盖「跑得通」的用例不算防线。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { compileScript, parse } from '@vue/compiler-sfc';
import { createRenderer, nextTick } from 'vue';

import { AUDIT_READ_SCOPE, SOURCES_READ_SCOPE, SOURCES_WRITE_SCOPE } from '../../apps/admin/src/lib/admin-content-contract.mjs';

// `vModelText` 指令在 beforeUpdate 里做 `el.getRootNode() instanceof Document/ShadowRoot` 的
// 焦点判断；Node 既没有 `document` 也没有这两个构造器，这里只补这几个标识（不引 jsdom；
// `node --test` 默认按文件隔离进程，不会影响其它用例）。
if (globalThis.document === undefined) globalThis.document = { activeElement: null };
if (globalThis.Document === undefined) globalThis.Document = class Document {};
if (globalThis.ShadowRoot === undefined) globalThis.ShadowRoot = class ShadowRoot {};

const VIEW_URL = new URL('../../apps/admin/src/views/ContentAdminView.vue', import.meta.url);
const VUE_URL = import.meta.resolve('vue');
const CONTRACT_URL = import.meta.resolve('../../apps/admin/src/lib/admin-content-contract.mjs');
const HOOK_KEY = '__gyContentSigninScopesTest';
const CHILD_KEY = '__gyContentSigninScopesChildren';

/** 子页 tab 顺序来自 `ContentAdminView.vue` 的 `FAMILIES`（DOM 顺序即此顺序）。 */
const FAMILIES = [
  ['sources', 'SourcesView'],
  ['knowledge', 'KnowledgeAdminView'],
  ['categories', 'CategoriesView'],
  ['posts', 'PostTakedownView'],
];

const READY_SESSION = Object.freeze({
  accessToken: 'synthetic-token',
  expiresAt: '2099-01-01T00:00:00Z',
  // 登录响应本身不带 scope（session.ts:17）；这 3 项只能来自「登录后再读一次会话」。
  scopes: Object.freeze([SOURCES_READ_SCOPE, SOURCES_WRITE_SCOPE, AUDIT_READ_SCOPE]),
});

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
}

/** `src/auth/session.ts` 的桩：只做转发，行为完全由用例注入。 */
function sessionStubUrl() {
  return moduleUrl(
    [
      "export const API_BASE_URL = '/api/v1';",
      `const hooks = () => globalThis.${HOOK_KEY};`,
      'export const signInAdmin = (credentials) => hooks().signInAdmin(credentials);',
      'export const loadAdminSession = () => hooks().loadAdminSession();',
      'export const signOutAdmin = async () => {};',
    ].join('\n'),
  );
}

/**
 * 子页的桩：不渲染真实子页（那会连带发请求），只记录父组件真正传下来的 props，
 * 并用真实 scope 常量按子页自己的口径算出 canWrite / canAudit。
 */
function childStubUrl(name) {
  return moduleUrl(
    [
      `import { h } from '${VUE_URL}';`,
      `import { AUDIT_READ_SCOPE, SOURCES_WRITE_SCOPE } from '${CONTRACT_URL}';`,
      'export default {',
      `  name: '${name}',`,
      "  props: ['baseUrl', 'token', 'scopes'],",
      '  setup(props) {',
      '    return () => {',
      `      globalThis.${CHILD_KEY}.push({`,
      `        name: '${name}',`,
      '        baseUrl: props.baseUrl,',
      '        token: props.token,',
      '        scopes: [...props.scopes],',
      '        canWrite: props.scopes.includes(SOURCES_WRITE_SCOPE),',
      '        canAudit: props.scopes.includes(AUDIT_READ_SCOPE),',
      '      });',
      `      return h('div', { class: 'child' }, '${name}');`,
      '    };',
      '  },',
      '};',
    ].join('\n'),
  );
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

const isClassed = (token) => (node) => typeof node.props.class === 'string' && node.props.class.split(/\s+/).includes(token);

function makeHooks({ signIn, loadSession }) {
  const calls = { signIn: [], loadSession: 0 };
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
    },
  };
}

let componentPromise = null;

/** 编译真实的 ContentAdminView.vue：把裸模块说明符全换成绝对 URL（data: 模块不能再解析裸说明符）。 */
function loadViewComponent() {
  if (componentPromise !== null) return componentPromise;
  const source = readFileSync(VIEW_URL, 'utf8');
  const { descriptor, errors } = parse(source, { filename: fileURLToPath(VIEW_URL) });
  assert.deepEqual(errors, [], 'ContentAdminView.vue 必须能被 @vue/compiler-sfc 解析');
  const compiled = compileScript(descriptor, {
    id: 'gy-content-signin-scopes',
    inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false, cacheHandlers: false } },
  });
  let code = compiled.content
    .replace(/from\s+["']vue["']/g, `from '${VUE_URL}'`)
    .replace(/from\s+["']\.\.\/auth\/session["']/g, `from '${sessionStubUrl()}'`);
  for (const [, component] of FAMILIES) {
    code = code.replace(new RegExp(`from\\s+["']\\./${component}\\.vue["']`, 'g'), `from '${childStubUrl(component)}'`);
  }
  assert.deepEqual(
    [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]).filter((id) => !/^(data:|file:)/.test(id)),
    [],
    '编译产物里不得残留裸模块说明符（data: 模块无法解析它们）',
  );
  componentPromise = import(moduleUrl(code)).then((namespace) => namespace.default);
  return componentPromise;
}

async function mountView(hooks) {
  globalThis[HOOK_KEY] = hooks;
  globalThis[CHILD_KEY] = [];
  const host = createHost();
  const container = host.make('root');
  const { createApp } = createRenderer({ ...host.nodeOps, patchProp: host.patchProp });
  const app = createApp(await loadViewComponent());
  app.mount(container);
  await settle();
  return { app, container };
}

function requireForm(container) {
  const form = findBy(container, (node) => node.kind === 'form');
  assert.ok(form !== null, '未登录时应渲染登录表单');
  return form;
}

function inputByTestId(root, testId) {
  return findBy(root, (node) => node.kind === 'input' && node.props['data-testid'] === testId);
}

/** 真实 DOM 事件：写值 + 派发 input（v-model 的监听器由指令挂上）。 */
function type(input, value) {
  assert.ok(input !== null, '找不到输入框');
  input.value = value;
  input.dispatch('input');
}

function submit(form) {
  assert.equal(typeof form.props.onSubmit, 'function', '登录表单必须挂着 submit 处理器');
  form.props.onSubmit({ preventDefault() {} });
}

/**
 * 顶部 scope 提示行的会话读数（`当前会话 scope：<code>…</code>`）；未读取时显示「（未读取）」。
 * 只认那一条 `<p class="note">`：登录表单里也有 `<code>`（sessionStorage 键名等），不能取全页最后一个。
 */
function scopeHintText(container) {
  const notes = findAll(
    container,
    (node) => node.kind === 'p' && typeof node.props.class === 'string' && node.props.class.split(/\s+/).includes('note') && textOf(node).includes('当前会话 scope'),
  );
  assert.equal(notes.length, 1, '顶部 scope 提示行必须唯一且始终在页面上');
  const codes = [];
  const walk = (node) => {
    if (node.kind === 'code') codes.push(textOf(node));
    for (const child of node.children) walk(child);
  };
  walk(notes[0]);
  return codes[codes.length - 1];
}

function subTabs(container) {
  return findAll(container, (node) => node.kind === 'button' && typeof node.props.class === 'string' && node.props.class.split(/\s+/).includes('sub-tab'));
}

function lastChildRender() {
  const renders = globalThis[CHILD_KEY];
  return renders.length === 0 ? null : renders[renders.length - 1];
}

async function signIn(container) {
  const form = requireForm(container);
  type(inputByTestId(form, 'login-name'), 'synthetic-admin');
  type(inputByTestId(form, 'login-password'), 'synthetic-only');
  await settle();
  submit(requireForm(container));
  await settle();
}

test('登录成功后 4 个子页立刻拿到 3 项 scopes：canWrite / canAudit 不再恒 false', async () => {
  const { hooks, calls } = makeHooks({
    // 登录响应本来就只带 token：scopes 为空（见 session.ts:17），真正的 scope 只能来自再读一次会话。
    signIn: async () => ({ accessToken: 'synthetic-token', expiresAt: '2099-01-01T00:00:00Z', scopes: [] }),
    // 第 1 次是挂载时的首屏读会话（未登录），第 2 次是登录后的那次。
    loadSession: async (nth) => (nth === 1 ? null : READY_SESSION),
  });
  const { app, container } = await mountView(hooks);
  try {
    assert.equal(requireForm(container) !== null, true, '首屏未登录时应停在登录表单');

    await signIn(container);

    assert.equal(calls.signIn.length, 1, '登录只发 1 次');
    assert.equal(calls.loadSession, 2, '登录成功后必须用同一 token 再读一次会话（登录前 1 次 + 登录后 1 次）');
    assert.equal(findBy(container, (node) => node.kind === 'form'), null, '读到会话后登录表单必须消失');

    const tabs = subTabs(container);
    assert.equal(tabs.length, FAMILIES.length, '4 个子页 tab 必须都在');
    for (const [index, [key, component]] of FAMILIES.entries()) {
      tabs[index].props.onClick();
      await settle();
      const view = lastChildRender();
      assert.ok(view !== null, `切到 ${key} 后必须渲染 ${component}`);
      assert.equal(view.name, component, `第 ${index + 1} 个 tab 必须是 ${component}`);
      assert.deepEqual(
        view.scopes,
        [SOURCES_READ_SCOPE, SOURCES_WRITE_SCOPE, AUDIT_READ_SCOPE],
        `${component} 收到的 scopes 必须是从会话读回来的 3 项，而不是登录响应里的空数组`,
      );
      assert.equal(view.canWrite, true, `${component} 的 canWrite 必须为 true（改前恒为 false）`);
      assert.equal(view.canAudit, true, `${component} 的 canAudit 必须为 true（改前恒为 false）`);
      assert.equal(view.token, 'synthetic-token', `${component} 必须拿到同一个 token`);
    }
  } finally {
    app.unmount();
  }
});

test('登录后读不到会话（网络 / 401）：停在登录表单、失败态可执行，且能从「重读会话」恢复', async () => {
  const { hooks, calls } = makeHooks({
    signIn: async () => ({ accessToken: 'synthetic-token', expiresAt: '2099-01-01T00:00:00Z', scopes: [] }),
    // 第 1 次首屏 → null；第 2 次（登录后）→ null（模拟网络失败 / 401）；第 3 次（重读会话）→ 有会话。
    loadSession: async (nth) => (nth <= 2 ? null : READY_SESSION),
  });
  const { app, container } = await mountView(hooks);
  try {
    await signIn(container);

    assert.equal(calls.loadSession, 2, '登录成功后必须真的再读一次会话');
    assert.equal(lastChildRender(), null, '读不到 scope 时不得静默把用户放进内容页');
    assert.equal(findBy(container, (node) => node.kind === 'form') !== null, true, '必须停在登录表单');

    const pageText = textOf(container);
    assert.match(pageText, /登录后读取会话失败/, '失败态必须在页面上可见');
    assert.match(pageText, /重读会话/, '文案要给出下一步：点「重读会话」重试或重新登录');
    const alert = findBy(container, isClassed('error'));
    assert.ok(alert !== null, '失败态必须落在 role="alert" 的告警块里');
    assert.equal(alert.props.role, 'alert');

    // 表单与提交入口仍在（可以被恢复，不是死胡同）。
    const form = requireForm(container);
    assert.ok(inputByTestId(form, 'login-name') !== null, '登录名输入框必须保留');
    assert.ok(inputByTestId(form, 'login-password') !== null, '口令输入框必须保留');
    assert.ok(findBy(form, (node) => node.kind === 'button' && node.props.type === 'submit') !== null, '提交按钮必须保留');

    // 点「重读会话」→ 真的再读一次会话并恢复出 4 个子页。
    const reread = findBy(container, (node) => node.kind === 'button' && node.props.type === 'button' && textOf(node).includes('重读会话'));
    assert.ok(reread !== null, '登录表单里必须有「重读会话」入口');
    reread.props.onClick();
    await settle();

    assert.equal(calls.loadSession, 3, '「重读会话」必须真的再发一次 GET /admin/auth/session');
    const view = lastChildRender();
    assert.ok(view !== null, '读回会话后必须进入内容页');
    assert.deepEqual(view.scopes, [SOURCES_READ_SCOPE, SOURCES_WRITE_SCOPE, AUDIT_READ_SCOPE]);
    assert.equal(findBy(container, (node) => node.kind === 'form'), null, '恢复后登录表单必须消失');
  } finally {
    app.unmount();
  }
});

test('顶部 scope 提示行：未读取时显示「（未读取）」，登录后显示真实 scope 列表', async () => {
  const { hooks } = makeHooks({
    signIn: async () => ({ accessToken: 'synthetic-token', expiresAt: '2099-01-01T00:00:00Z', scopes: [] }),
    loadSession: async (nth) => (nth === 1 ? null : READY_SESSION),
  });
  const { app, container } = await mountView(hooks);
  try {
    assert.equal(scopeHintText(container), '（未读取）', '未登录时提示行必须明说没读到 scope');

    await signIn(container);

    assert.equal(
      scopeHintText(container),
      [SOURCES_READ_SCOPE, SOURCES_WRITE_SCOPE, AUDIT_READ_SCOPE].join('、'),
      '登录后提示行必须显示真实 scope 列表（改前一直是「（未读取）」）',
    );
  } finally {
    app.unmount();
  }
});

test('4 个真实子页的 canWrite / canAudit 就是 props.scopes.includes(...)：口径被改动必须同步改本用例', () => {
  // 子页桩按真实常量复算了 canWrite / canAudit；这里再钉住真实子页用的也是同一口径，
  // 避免「父页传对了、子页却换了判定方式」这种两侧各对一半的假绿。
  const rules = [
    ['SourcesView.vue', true],
    ['KnowledgeAdminView.vue', true],
    ['CategoriesView.vue', true],
    // 下架页只有写权限判定，没有 canAudit。
    ['PostTakedownView.vue', false],
  ];
  for (const [file, hasAudit] of rules) {
    const source = readFileSync(new URL(`../../apps/admin/src/views/${file}`, import.meta.url), 'utf8');
    assert.match(source, /props\.scopes\.includes\(SOURCES_WRITE_SCOPE\)/, `${file} 的 canWrite 必须仍由 props.scopes.includes(SOURCES_WRITE_SCOPE) 决定`);
    assert.match(source, /scopes: \{ type: Array, required: true \}/, `${file} 必须把 scopes 声明为必填 prop（不传就报错而不是静默空数组）`);
    if (hasAudit) {
      assert.match(source, /props\.scopes\.includes\(AUDIT_READ_SCOPE\)/, `${file} 的 canAudit 必须仍由 props.scopes.includes(AUDIT_READ_SCOPE) 决定`);
    }
  }
});
