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
const QUEUE_URL = import.meta.resolve('../../apps/admin/src/lib/admin-moderation-queue.mjs');
const READ_URL = import.meta.resolve('../../apps/admin/src/lib/post-takedown-read.mjs');

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
    .replace(/from\s+["']\.\.\/lib\/post-takedown-form\.mjs["']/g, `from '${FORM_URL}'`)
    .replace(/from\s+["']\.\.\/lib\/admin-moderation-queue\.mjs["']/g, `from '${QUEUE_URL}'`)
    .replace(/from\s+["']\.\.\/lib\/post-takedown-read\.mjs["']/g, `from '${READ_URL}'`);
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

// ------------------------------------------------------------------ 读面（`getAdminPost`）

const READ_BODY = {
  data: {
    id: POST_ID,
    revision: 7,
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
    updated_at: '2026-11-01T09:00:00.000Z',
    linked_knowledge_ref: null,
  },
  meta: { request_id: '33333333-3333-4333-8333-333333333333', contract_version: '1.0.0', execution_mode: 'real' },
};

function errorBody(code, message) {
  return {
    error: { code, message, retryable: false, details: [] },
    meta: { request_id: '44444444-4444-4444-8444-444444444444', contract_version: '1.0.0', execution_mode: 'real' },
  };
}

/** 路由式 fetch 桩：GET 详情 → 读面返回；POST hide → ACK。 */
function routedFetch({ read }) {
  return fakeFetch(({ url, init }) => {
    if (init?.method === 'POST') return jsonResponse(200, ACK_BODY, { etag: '"8"' });
    return read(url);
  });
}

function clickRead(container) {
  const button = findBy(container, byTestId('read-post'));
  assert.ok(button !== null, '必须渲染「读取帖子确认」按钮');
  assert.equal(typeof button.props.onClick, 'function', '读取按钮必须挂着 click 处理器');
  button.props.onClick({});
}

/** `:readonly="false"` 会被编译成不设置该 prop；这里把两种键名都收口成布尔值。 */
function readOnlyOf(container) {
  const input = findBy(container, byTestId('revision'));
  assert.ok(input !== null, '必须渲染 revision 输入框');
  return input.props.readOnly === true || input.props.readonly === true || input.props.readonly === '';
}

test('读面成功 ⇒ 展示标题／作者／可见性／revision，revision 回填为只读，If-Match 用回填值', async () => {
  const fetchImpl = routedFetch({ read: () => jsonResponse(200, READ_BODY, { etag: '"7"' }) });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const { app, container } = await mountView();
  try {
    type(container, 'post-id', POST_ID);
    await settle();
    clickRead(container);
    await settle();

    const readCall = fetchImpl.calls[0];
    assert.equal(readCall.url, `${BASE_URL}/admin/posts/${POST_ID}`);
    assert.equal(readCall.init.method, 'GET');
    assert.equal(readCall.init.headers.authorization, `Bearer ${TOKEN}`);

    const summary = findBy(container, byTestId('read-summary'));
    assert.ok(summary !== null, '读面成功必须展示摘要');
    const summaryText = textOf(summary);
    assert.match(summaryText, /草地贪夜蛾/);
    assert.match(summaryText, /22222222-2222-4222-8222-222222222222/);
    assert.match(summaryText, /private/);
    assert.match(summaryText, /7/);
    assert.doesNotMatch(summaryText, /private 帖通过后/, '摘要只是回执，不得编造社区侧状态');

    const revisionInput = findBy(container, byTestId('revision'));
    assert.equal(revisionInput.props.value, '7', '读到的 revision 必须回填');
    assert.equal(readOnlyOf(container), true, '回填的 revision 必须是只读值');
    assert.ok(findBy(container, byTestId('revision-locked')) !== null, '只读时必须说明来源与解锁入口');
    assert.equal(findBy(container, byTestId('read-fallback')), null, '读面成功不得显示回落提示');

    type(container, 'reason', REASON);
    checkConfirm(container);
    await settle();
    assert.equal(buttonOf(container).props.disabled, false, '读面回填后应可提交');

    submit(container);
    await settle();
    const hideCall = fetchImpl.calls[1];
    assert.equal(hideCall.url, `${BASE_URL}/admin/posts/${POST_ID}/hide`);
    assert.equal(hideCall.init.headers['if-match'], '"7"', 'If-Match 必须用读回来的 revision');
    assert.notEqual(hideCall.init.headers['if-match'], '*');
    assert.equal(hideCall.init.headers['idempotency-key'].startsWith('admin-post-takedown-'), true);
  } finally {
    globalThis.fetch = originalFetch;
    app.unmount();
  }
});

// 负控制①：读面 403 ⇒ 回落手填、如实说明原因与风险，**提交按钮不得被禁**。
test('读面 403 ⇒ 回落手填 revision + 如实提示，提交按钮仍可用且真的发出请求（负控制①）', async () => {
  const fetchImpl = routedFetch({
    read: () => jsonResponse(403, errorBody('SCOPE_DENIED', '缺少所需权限：sources:read')),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const { app, container } = await mountView();
  try {
    type(container, 'post-id', POST_ID);
    await settle();
    clickRead(container);
    await settle();

    const fallback = findBy(container, byTestId('read-fallback'));
    assert.ok(fallback !== null, '读面失败必须如实提示，不得静默');
    const fallbackText = textOf(fallback);
    assert.match(fallbackText, /sources:read/, '提示必须说明缺哪个 scope');
    assert.match(fallbackText, /403/);
    assert.match(fallbackText, /手填/, '提示必须说明回落成手填');
    assert.match(fallbackText, /409/, '提示必须说明手填 revision 的风险（不匹配 ⇒ 409）');
    assert.equal(findBy(container, byTestId('read-summary')), null, '读不到就不得显示摘要');

    assert.equal(readOnlyOf(container), false, '读面失败时 revision 必须回到手填（不是只读）');
    assert.equal(findBy(container, byTestId('revision-locked')), null, '读面失败不得显示「已锁成只读」');

    // 负控制①的断言本体：读面失败**不许**把提交按钮禁掉。
    type(container, 'revision', '5');
    type(container, 'reason', REASON);
    checkConfirm(container);
    await settle();
    assert.equal(buttonOf(container).props.disabled, false, '读面 403 之后提交按钮仍必须可用（读面不是提交前提）');
    assert.equal(findBy(container, byTestId('blocked')), null, '读面失败不得把表单标记为不可提交');

    submit(container);
    await settle();
    const hideCall = fetchImpl.calls[1];
    assert.equal(hideCall.url, `${BASE_URL}/admin/posts/${POST_ID}/hide`);
    assert.equal(hideCall.init.headers['if-match'], '"5"', '手填值必须原样进 If-Match');
    assert.ok(findBy(container, byTestId('receipt')) !== null, '手填路径必须能走到服务端并拿到回执');
  } finally {
    globalThis.fetch = originalFetch;
    app.unmount();
  }
});

test('读面网络失败 ⇒ 提示写成网络错误、仍回落手填且可提交', async () => {
  let readAttempts = 0;
  const fetchImpl = fakeFetch(({ url, init }) => {
    if (init?.method === 'POST') return jsonResponse(200, ACK_BODY, { etag: '"8"' });
    readAttempts += 1;
    throw new TypeError('connect ECONNREFUSED 127.0.0.1:8787');
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const { app, container } = await mountView();
  try {
    type(container, 'post-id', POST_ID);
    await settle();
    clickRead(container);
    await settle();

    assert.equal(readAttempts, 1, '读面失败不得自动重试');
    const fallback = findBy(container, byTestId('read-fallback'));
    assert.ok(fallback !== null, '网络失败同样必须如实提示');
    assert.match(textOf(fallback), /ECONNREFUSED|网络/);

    type(container, 'revision', '9');
    type(container, 'reason', REASON);
    checkConfirm(container);
    await settle();
    assert.equal(buttonOf(container).props.disabled, false, '网络失败不得禁提交');
  } finally {
    globalThis.fetch = originalFetch;
    app.unmount();
  }
});

test('读面成功后改帖子 ID ⇒ 解锁 revision、摘要消失并提示旧 revision 不再适用', async () => {
  const fetchImpl = routedFetch({ read: () => jsonResponse(200, READ_BODY, { etag: '"7"' }) });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const { app, container } = await mountView();
  try {
    type(container, 'post-id', POST_ID);
    await settle();
    clickRead(container);
    await settle();
    assert.equal(findBy(container, byTestId('revision')).props.value, '7');

    const otherId = '00000000-0000-4000-8000-000000000002';
    type(container, 'post-id', otherId);
    await settle();

    assert.equal(findBy(container, byTestId('read-summary')), null, '换了 ID 之后旧摘要必须撤掉（不得继续显示别的帖子的标题）');
    const stale = findBy(container, byTestId('read-stale'));
    assert.ok(stale !== null, '必须提示旧 revision 已不适用');
    assert.match(textOf(stale), /不再适用/);
    const revisionInput = findBy(container, byTestId('revision'));
    assert.equal(readOnlyOf(container), false, '换 ID 后必须解锁 revision，允许重新读取或手填');
    assert.equal(revisionInput.props.value, '7', '换 ID 不替操作员猜新 revision');
  } finally {
    globalThis.fetch = originalFetch;
    app.unmount();
  }
});

test('会话缺 sources:read ⇒ 读取按钮禁用并说明原因，提交按钮不受影响', async () => {
  const { app, container } = await mountView({ scopes: ['sources:write'] });
  try {
    const readButton = findBy(container, byTestId('read-post'));
    assert.equal(readButton.props.disabled, true, '缺读面 scope 时读取按钮必须禁用');
    assert.match(textOf(findBy(container, byTestId('read-blocked'))), /sources:read/);

    type(container, 'post-id', POST_ID);
    type(container, 'revision', '7');
    type(container, 'reason', REASON);
    checkConfirm(container);
    await settle();
    assert.equal(buttonOf(container).props.disabled, false, '缺 sources:read 不等于不能下架');
  } finally {
    app.unmount();
  }
});
