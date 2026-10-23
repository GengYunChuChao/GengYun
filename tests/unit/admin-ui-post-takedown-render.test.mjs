/**
 * 渲染级用例：`PostTakedownView.vue` 的**真实 SFC 呈现路径**（不是纯函数复述）。
 *
 * 为什么需要渲染级：`admin-ui-post-takedown.test.mjs` 只覆盖 `post-takedown-{api,form}.mjs`，
 * 覆盖不到「按钮到底有没有被禁用」「503 到底有没有上屏」「成功后表单有没有清空」这几条**模板**结论。
 *
 * `apps/admin` 没有 vitest／@vue/test-utils／jsdom（仓内前端测试一律纯函数），
 * 所以沿用 `tests/unit/admin-jobs-signin-form.test.mjs` 的最小渲染环境，**不新增依赖、不联网**：
 *   1. `@vue/compiler-sfc` 把 `PostTakedownView.vue` 编成 ESM 组件（`inlineTemplate: true`，
 *      关掉静态提升与事件缓存），并把裸模块说明符换成绝对 URL（data: 模块解析不了裸说明符）；
 *   2. `vue` 的 `createRenderer()` 造内存宿主，挂**真实组件**、派发真实事件；
 *   3. 网络层用 `globalThis.fetch` 桩（与本页生产路径同一条 `hidePost` → `fetch`）。
 *
 * 断言口径：`If-Match` 是 `"7"` 而不是 `*`；503 必须以失败上屏且**只发一次请求**（不自动重试）；
 * 200 之后表单清空且文案里没有「已下架成功」。
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

const VIEW_URL = new URL('../../apps/admin/src/views/PostTakedownView.vue', import.meta.url);
const VUE_URL = import.meta.resolve('vue');
const API_URL = import.meta.resolve('../../apps/admin/src/lib/post-takedown-api.mjs');
const FORM_URL = import.meta.resolve('../../apps/admin/src/lib/post-takedown-form.mjs');

const BASE_URL = '/api/v1';
const TOKEN = 'synthetic-admin-token';
const POST_ID = '00000000-0000-4000-8000-000000000001';
const REASON = '社区举报核实为不实用药建议，紧急下架';
const SCOPES = ['sources:read', 'sources:write'];

const ACK_BODY = {
  data: { accepted: true },
  meta: { request_id: '11111111-1111-4111-8111-111111111111', contract_version: '1.0.0', execution_mode: 'stub' },
};

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
}

let componentPromise = null;

function loadViewComponent() {
  if (componentPromise !== null) return componentPromise;
  const source = readFileSync(VIEW_URL, 'utf8');
  const { descriptor, errors } = parse(source, { filename: fileURLToPath(VIEW_URL) });
  assert.deepEqual(errors, [], 'PostTakedownView.vue 必须能被 @vue/compiler-sfc 解析');
  const compiled = compileScript(descriptor, {
    id: 'gy-post-takedown-render',
    inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false, cacheHandlers: false } },
  });
  const code = compiled.content
    .replace(/from\s+["']vue["']/g, `from '${VUE_URL}'`)
    .replace(/from\s+["']\.\.\/lib\/post-takedown-api\.mjs["']/g, `from '${API_URL}'`)
    .replace(/from\s+["']\.\.\/lib\/post-takedown-form\.mjs["']/g, `from '${FORM_URL}'`);
  assert.deepEqual(
    [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]).filter((id) => !/^(data:|file:)/.test(id)),
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

async function mountView({ scopes = SCOPES } = {}) {
  const host = createHost();
  const container = host.make('root');
  const { createApp } = createRenderer({ ...host.nodeOps, patchProp: host.patchProp });
  const app = createApp(await loadViewComponent(), { baseUrl: BASE_URL, token: TOKEN, scopes });
  app.mount(container);
  await settle();
  return { app, container };
}

/** 填表单：文本字段走 `onInput`（本页用 `:value` + `@input`，与生产编译产物一致）。 */
function type(container, testId, value) {
  const input = findBy(container, byTestId(testId));
  assert.ok(input !== null, `找不到 ${testId} 输入框`);
  assert.equal(typeof input.props.onInput, 'function', `${testId} 必须挂着 input 处理器`);
  input.props.onInput({ target: { value } });
}

function checkConfirm(container) {
  const box = findBy(container, byTestId('confirm'));
  assert.ok(box !== null, '找不到确认勾选框');
  assert.equal(typeof box.props.onChange, 'function', '确认勾选框必须挂着 change 处理器');
  box.props.onChange({ target: { checked: true } });
}

function submit(container) {
  const form = findBy(container, byTestId('takedown-form'));
  assert.ok(form !== null, '必须渲染下架表单');
  assert.equal(typeof form.props.onSubmit, 'function', '表单必须挂着 submit 处理器');
  form.props.onSubmit({ preventDefault() {} });
}

function buttonOf(container) {
  const button = findBy(container, byTestId('submit'));
  assert.ok(button !== null, '必须渲染提交按钮');
  return button;
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return handler({ url, init });
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body };
}

test('渲染出帖子 ID／revision／理由／确认勾选与提交按钮；空表单时按钮 disabled 并给出禁用原因', async () => {
  const { app, container } = await mountView();
  try {
    for (const id of ['post-id', 'revision', 'reason', 'confirm', 'submit']) {
      assert.ok(findBy(container, byTestId(id)) !== null, `必须渲染 ${id}`);
    }
    assert.equal(buttonOf(container).props.disabled, true, '空表单不得可提交');
    const blocked = findBy(container, byTestId('blocked'));
    assert.ok(blocked !== null, '禁用时必须给出原因');
    assert.match(textOf(blocked), /帖子 ID/);
    // 页面必须写明「If-Match 不接受 *」与 scope（不能用通配糊过去）。
    const pageText = textOf(container);
    assert.match(pageText, /sources:write/);
    assert.match(pageText, /不接受/);
    assert.match(pageText, /\/admin\/posts\/\{id\}\/hide/);
  } finally {
    app.unmount();
  }
});

test('填好 ID／理由／确认但**缺 revision** ⇒ 按钮仍 disabled，且文案指向 revision', async () => {
  const { app, container } = await mountView();
  try {
    type(container, 'post-id', POST_ID);
    type(container, 'reason', REASON);
    checkConfirm(container);
    await settle();

    assert.equal(buttonOf(container).props.disabled, true, '缺 revision 不得可提交');
    const blocked = findBy(container, byTestId('blocked'));
    assert.match(textOf(blocked), /revision 必填/);
  } finally {
    app.unmount();
  }
});

test('revision 填 * ⇒ 按钮 disabled 且明确拒绝通配，且一个请求都不发', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, ACK_BODY));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const { app, container } = await mountView();
  try {
    type(container, 'post-id', POST_ID);
    type(container, 'revision', '*');
    type(container, 'reason', REASON);
    checkConfirm(container);
    await settle();

    assert.equal(buttonOf(container).props.disabled, true, '* 不得作为 If-Match 提交');
    assert.match(textOf(findBy(container, byTestId('blocked'))), /不允许 \*/);
    // 即使硬提交，本地校验也会拦住，不会发出必然 400 的请求。
    submit(container);
    await settle();
    assert.equal(fetchImpl.calls.length, 0, '不得发出带 * 的请求');
  } finally {
    globalThis.fetch = originalFetch;
    app.unmount();
  }
});

test('填全后可提交：请求为 POST /admin/posts/{id}/hide，If-Match 是 "7" 不是 *，成功后表单清空', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, ACK_BODY, { etag: '"8"' }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const { app, container } = await mountView();
  try {
    type(container, 'post-id', POST_ID);
    type(container, 'revision', '7');
    type(container, 'reason', REASON);
    checkConfirm(container);
    await settle();
    assert.equal(buttonOf(container).props.disabled, false, '填全且勾选后必须可提交');

    submit(container);
    await settle();

    assert.equal(fetchImpl.calls.length, 1, '一次提交只发一个请求');
    const { url, init } = fetchImpl.calls[0];
    assert.equal(url, `${BASE_URL}/admin/posts/${POST_ID}/hide`);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['if-match'], '"7"');
    assert.notEqual(init.headers['if-match'], '*');
    assert.deepEqual(JSON.parse(init.body), { reason: REASON });
    assert.equal(init.headers['idempotency-key'].startsWith('admin-post-takedown-'), true);

    const receipt = findBy(container, byTestId('receipt'));
    assert.ok(receipt !== null, '成功必须有回执');
    const receiptText = textOf(receipt);
    assert.match(receiptText, /服务端已受理/);
    assert.match(receiptText, /accepted:true/);
    assert.doesNotMatch(receiptText, /已下架成功|成功下架/);

    // 成功后清空（避免操作员误以为「还能再点一次同样的请求」）。
    for (const id of ['post-id', 'revision', 'reason']) {
      assert.equal(findBy(container, byTestId(id)).props.value, '', `${id} 成功后必须清空`);
    }
    assert.equal(buttonOf(container).props.disabled, true, '清空后按钮回到禁用');
  } finally {
    globalThis.fetch = originalFetch;
    app.unmount();
  }
});

test('real 模式 503 ⇒ 失败文案上屏（含 503／尚未接线／处置可能已生效），表单保留且**不自动重试**', async () => {
  const errorBody = {
    error: { code: 'PROVIDER_UNAVAILABLE', message: '社区帖子存储尚未接线', retryable: false, details: [] },
    meta: { request_id: '22222222-2222-4222-8222-222222222222', contract_version: '1.0.0', execution_mode: 'real' },
  };
  const fetchImpl = fakeFetch(() => jsonResponse(503, errorBody));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const { app, container } = await mountView();
  try {
    type(container, 'post-id', POST_ID);
    type(container, 'revision', '7');
    type(container, 'reason', REASON);
    checkConfirm(container);
    await settle();

    submit(container);
    await settle();

    assert.equal(fetchImpl.calls.length, 1, '503 之后不得自动重试');
    const receipt = findBy(container, byTestId('receipt'));
    assert.ok(receipt !== null, '503 必须显示为失败（不得静默）');
    assert.equal(receipt.props.role, 'alert');
    const receiptText = textOf(receipt);
    assert.match(receiptText, /503/);
    assert.match(receiptText, /尚未接线/);
    assert.match(receiptText, /PROVIDER_UNAVAILABLE/);
    assert.match(receiptText, /execution_mode=real/);
    assert.match(receiptText, /处置可能已生效/);
    assert.doesNotMatch(receiptText, /服务端已受理|已下架成功/);

    // 失败不清空表单：操作员可核对后再决定（重发会复用同一幂等键）。
    assert.equal(findBy(container, byTestId('post-id')).props.value, POST_ID);
    assert.equal(findBy(container, byTestId('revision')).props.value, '7');
  } finally {
    globalThis.fetch = originalFetch;
    app.unmount();
  }
});

test('会话缺 sources:write ⇒ 按钮 disabled + 顶部提示（只提示不禁用之外不做前端放行）', async () => {
  const { app, container } = await mountView({ scopes: ['sources:read'] });
  try {
    type(container, 'post-id', POST_ID);
    type(container, 'revision', '7');
    type(container, 'reason', REASON);
    checkConfirm(container);
    await settle();

    assert.equal(buttonOf(container).props.disabled, true, '缺 scope 时按钮必须禁用');
    const banner = findBy(container, byTestId('scope-banner'));
    assert.ok(banner !== null, '缺 scope 必须有提示');
    assert.match(textOf(banner), /sources:write/);
    assert.match(textOf(banner), /SCOPE_DENIED/);
  } finally {
    app.unmount();
  }
});
