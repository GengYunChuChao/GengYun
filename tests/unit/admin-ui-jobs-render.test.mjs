/**
 * 渲染级用例：`JobsView.vue`（作业台）的**真实 SFC 呈现路径**。
 *
 * 为什么必须渲染级：`admin-jobs-api.test.mjs` 只覆盖 `lib/jobs-api.mjs` 的纯函数；
 * 覆盖不到「到底渲染出几行」「403 到底是不是 role="alert"」「空数组到底有没有空态」这三条**模板**结论
 * ——而这三条正是本片要证明的东西。
 *
 * `apps/admin` 没有 vitest / @vue/test-utils / jsdom（仓内前端测试一律纯函数），
 * 所以沿用 `tests/unit/admin-ui-audit-logs-render.test.mjs` 的最小渲染环境，**不新增依赖、不联网**：
 *   1. `@vue/compiler-sfc` 把 `.vue` 编成 ESM（`inlineTemplate: true`，关静态提升与事件缓存），
 *      把裸模块说明符换成 `file:` / `data:` 绝对 URL；
 *   2. `../auth/session`（.ts）换成一个只读桩模块，通过 `globalThis.__GY_TEST_SESSION__` 注入会话
 *      ——本页是「页面自登录」，只有这条缝能喂进 token/scopes；
 *   3. `vue` 的 `createRenderer()` 造内存宿主，挂**真实组件**，网络层用 `globalThis.fetch` 桩。
 *
 * 断言口径：有数据就得有行；403 必须是 `role="alert"` 的明确提示、**不给重试**、保留「退出登录」，
 * 且**不得**同时出现空态；空数组必须是 `role="status"` 的空态而不是错误；
 * 服务端声明 `retryable:false` 时既不给重试按钮、也不出现「稍后重试」字样。
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

const VIEW_URL = new URL('../../apps/admin/src/views/JobsView.vue', import.meta.url);
const LIB_URL = new URL('../../apps/admin/src/lib/jobs-api.mjs', import.meta.url);
const VUE_URL = import.meta.resolve('vue');

/**
 * R64 追加：取消动作的契约事实（`cancelAdminJob`）。
 * 请求体是 `ReasonInput`（`{reason}`，`additionalProperties:false`），参数是 `IdempotencyKey` + `IfMatch`。
 */
const CONTRACT = JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'));
const CANCEL_JOB = CONTRACT.paths['/admin/jobs/{id}/cancel'].post;
const REASON_INPUT = CONTRACT.components.schemas.ReasonInput;

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const SESSION = { accessToken: 'synthetic-admin-token', expiresAt: '2099-01-01T00:00:00.000Z', scopes: ['jobs:read', 'jobs:cancel'] };

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
  assert.deepEqual(errors, [], 'JobsView.vue 必须能被 @vue/compiler-sfc 解析');
  const compiled = compileScript(descriptor, {
    id: 'gy-jobs-render',
    inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false, cacheHandlers: false } },
  });
  const escape = (specifier) => specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const code = compiled.content
    .replace(/from\s+["']vue["']/g, `from '${VUE_URL}'`)
    .replace(new RegExp(`from\\s+["']${escape('../auth/session')}["']`, 'g'), `from '${SESSION_STUB_URL}'`)
    .replace(new RegExp(`from\\s+["']${escape('../lib/jobs-api.mjs')}["']`, 'g'), `from '${LIB_URL.href}'`);
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

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body };
}

function page(items, nextCursor = null) {
  return { data: { items, next_cursor: nextCursor }, meta: { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'real' } };
}

function errorEnvelope(code, message, retryable = false) {
  return { error: { code, message, retryable, details: [] }, meta: { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'real' } };
}

/** 契约 `AdminJob` 的字段（additionalProperties:false）：只出这些，不臆造。 */
function job(overrides = {}) {
  return {
    id: '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    revision: 3,
    kind: 'recognition',
    target_ref: { type: 'media', id: 'media-1' },
    state: 'running',
    deadline_at: '2026-10-20T12:00:00.000Z',
    created_at: '2026-10-20T11:58:00.000Z',
    error_code: null,
    result: null,
    ...overrides,
  };
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

async function mountView({ fetchImpl, scopes } = {}) {
  const host = createHost();
  const container = host.make('root');
  const { createApp } = createRenderer({ ...host.nodeOps, patchProp: host.patchProp });
  const originalFetch = globalThis.fetch;
  if (fetchImpl !== undefined) globalThis.fetch = fetchImpl;
  // `scopes` 是追加参数（缺省＝原 SESSION 的 ['jobs:read','jobs:cancel']），既有用例行为不变。
  globalThis.__GY_TEST_SESSION__ = scopes === undefined ? SESSION : { ...SESSION, scopes };
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

test('3 个作业 ⇒ 渲染 3 行（不是 0 行、也不是错误态）', async () => {
  const fetchImpl = fakeFetch(() =>
    jsonResponse(
      200,
      page([
        job({ id: '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5a', kind: 'recognition', state: 'running' }),
        job({ id: '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5b', kind: 'ocr', state: 'succeeded', error_code: null }),
        job({ id: '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5c', kind: 'moderation', state: 'failed', error_code: 'PROVIDER_UNAVAILABLE' }),
      ]),
    ),
  );
  const mounted = await mountView({ fetchImpl });
  try {
    assert.equal(countOf(mounted.container, 'jobs-row'), 3, '3 个作业必须渲染 3 行');
    const status = findBy(mounted.container, byTestId('jobs-status'));
    assert.ok(status !== null, '必须渲染状态条');
    assert.equal(status.props.role, 'status', '正常读数是 status 语义，不是 alert');
    assert.match(textOf(status), /已加载 3 个作业/);
    assert.equal(findBy(mounted.container, byTestId('jobs-empty')), null, '有数据时不得同时显示空态');
    assert.ok(findBy(mounted.container, byTestId('jobs-table')) !== null, '有数据必须渲染表格');
    const pageText = textOf(mounted.container);
    assert.match(pageText, /作业台/);
    assert.match(pageText, /GET \/api\/v1\/admin\/jobs/);
    assert.match(pageText, /listAdminJobs/);
    assert.match(pageText, /jobs:read/);
    assert.match(pageText, /2026-10-20T11:58:00\.000Z/, 'created_at 原样透传，不做本地时区重排');
    assert.equal(fetchImpl.calls.length, 1);
    assert.match(fetchImpl.calls[0].url, /^\/api\/v1\/admin\/jobs\?limit=20$/);
    assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer synthetic-admin-token');
  } finally {
    mounted.unmount();
  }
});

test('403 SCOPE_DENIED ⇒ role="alert" 的明确提示：不给重试、保留退出登录、不是空态', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(403, errorEnvelope('SCOPE_DENIED', '缺少 jobs:read')));
  const mounted = await mountView({ fetchImpl });
  try {
    const status = findBy(mounted.container, byTestId('jobs-status'));
    assert.ok(status !== null, '403 必须有提示（不得白屏）');
    assert.equal(status.props.role, 'alert', '403 必须是 alert 语义');
    const statusText = textOf(status);
    assert.match(statusText, /权限不足/);
    assert.match(statusText, /jobs:read/);
    assert.match(statusText, /jobs:cancel/);
    assert.match(statusText, /后台会话有效/);
    assert.equal(countOf(mounted.container, 'jobs-row'), 0);
    assert.equal(findBy(mounted.container, byTestId('jobs-empty')), null, '403 不得被渲染成「暂无作业」');
    assert.equal(findBy(mounted.container, byTestId('jobs-table')), null, '403 不渲染表格');
    const code = findBy(mounted.container, byTestId('jobs-error-code'));
    assert.ok(code !== null, '必须显示错误码');
    assert.match(textOf(code), /SCOPE_DENIED/);
    assert.equal(countOf(mounted.container, 'jobs-retry'), 0, '403 不给「重试」——重试同一个无权会话没有意义');
    assert.doesNotMatch(textOf(mounted.container), /稍后重试/);
    assert.ok(findBy(mounted.container, byTestId('jobs-sign-out')) !== null, '必须给出可走的下一步（退出登录换账号）');
  } finally {
    mounted.unmount();
  }
});

test('空数组 ⇒ role="status" 的空态（说清「正常空态，不是错误」），且不是 alert', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, page([], null)));
  const mounted = await mountView({ fetchImpl });
  try {
    assert.equal(countOf(mounted.container, 'jobs-row'), 0);
    assert.equal(findBy(mounted.container, byTestId('jobs-table')), null, '空数组不渲染空表格');
    const empty = findBy(mounted.container, byTestId('jobs-empty'));
    assert.ok(empty !== null, '空数组必须渲染空态');
    assert.equal(empty.props.role, 'status', '空态是 status 语义，不是 alert');
    const emptyText = textOf(empty);
    assert.match(emptyText, /暂无作业/);
    assert.match(emptyText, /正常空态，不是错误/);
    assert.equal(findBy(mounted.container, byTestId('jobs-status')), null, '空态与错误提示是两个互斥元素');
    assert.equal(countOf(mounted.container, 'jobs-retry'), 0, '空台账不是错误，不给重试按钮');
    assert.ok(findBy(mounted.container, byTestId('jobs-empty-reload')) !== null, '空态自带「重新读取」');
  } finally {
    mounted.unmount();
  }
});

test('503（服务端 retryable:false）⇒ alert + 「服务暂不可用」，不给重试、不说「稍后重试」、不伪装成空态', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(503, errorEnvelope('PROVIDER_UNAVAILABLE', '作业队列读取尚未接线', false)));
  const mounted = await mountView({ fetchImpl });
  try {
    const status = findBy(mounted.container, byTestId('jobs-status'));
    assert.ok(status !== null, '503 必须有提示（不得白屏）');
    assert.equal(status.props.role, 'alert', '503 是失败态，必须 alert 语义');
    const statusText = textOf(status);
    assert.match(statusText, /服务暂不可用/);
    assert.match(statusText, /503/);
    assert.match(statusText, /不可自动重试/);
    assert.doesNotMatch(statusText, /稍后重试/);
    assert.equal(findBy(mounted.container, byTestId('jobs-empty')), null, '503 不得被渲染成「暂无作业」');
    assert.doesNotMatch(textOf(mounted.container), /暂无作业/);
    assert.equal(countOf(mounted.container, 'jobs-row'), 0, '503 不得伪造数据行');
    const code = findBy(mounted.container, byTestId('jobs-error-code'));
    assert.match(textOf(code), /PROVIDER_UNAVAILABLE/);
    assert.equal(countOf(mounted.container, 'jobs-retry'), 0, '服务端声明不可重试时不得给重试按钮');
  } finally {
    mounted.unmount();
  }
});

test('503 但服务端声明 retryable:true ⇒ 才给「重试」按钮', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(503, errorEnvelope('PROVIDER_UNAVAILABLE', '暂时过载', true)));
  const mounted = await mountView({ fetchImpl });
  try {
    const status = findBy(mounted.container, byTestId('jobs-status'));
    assert.equal(status.props.role, 'alert');
    assert.equal(countOf(mounted.container, 'jobs-retry'), 1, '服务端明说可重试时必须有重试按钮');
    assert.match(textOf(status), /稍后重试/);
    assert.equal(countOf(mounted.container, 'jobs-row'), 0);
    assert.equal(findBy(mounted.container, byTestId('jobs-empty')), null);
  } finally {
    mounted.unmount();
  }
});

// ---------------------------------------------------------------------------
// R64 追加：**取消作业**（`cancelAdminJob`）的动作断言
//
// 为什么补：上面 6 条只覆盖「列表面板」——列表、403、空态、503。取消是写面，
// 但渲染层此前**一条断言都没有**（`tests/unit/admin-jobs-api.test.mjs` 只测 lib 的 `cancelJob`），
// 「按钮什么时候禁用」「点了到底发出什么请求」「失败会不会伪装成功」都没被模板层证明过。
// 契约事实（`packages/contracts/openapi.json` 的 `POST /admin/jobs/{id}/cancel`）：
// 参数 `IdempotencyKey`（8..128）+ `IfMatch`（`^"[1-9][0-9]*"$`），请求体 `ReasonInput = { reason }`。
// ---------------------------------------------------------------------------

const single = (data) => ({
  data,
  meta: { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'stub' },
});

const jobRows = (container) => findAll(container, byTestId('jobs-row'));

function cancelButtonOf(row) {
  const button = findBy(row, (node) => node.kind === 'button');
  assert.ok(button !== null, '每个作业行都必须渲染取消按钮（终态时也渲染，只是禁用）');
  return button;
}

const findReasonInput = (container) => findBy(container, (node) => node.props.name === 'reason');

/** 填取消理由：模板用 `:value` + `@input`，与生产编译产物一致。 */
function typeReason(container, value) {
  const input = findReasonInput(container);
  assert.ok(input !== null, '必须渲染取消理由输入框（契约 ReasonInput.reason 必填）');
  assert.equal(typeof input.props.onInput, 'function', '理由输入框必须挂着 input 处理器');
  input.props.onInput({ target: { value } });
}

/** 点第 index 行的取消按钮：`@click.stop` 编译成带 stop 修饰的处理器，事件要给 stopPropagation。 */
function clickCancel(container, index = 0) {
  const rows = jobRows(container);
  assert.ok(rows.length > index, `找不到第 ${index} 行作业（共 ${rows.length} 行）`);
  const button = cancelButtonOf(rows[index]);
  assert.equal(typeof button.props.onClick, 'function', '取消按钮必须挂着 click 处理器');
  button.props.onClick({ stopPropagation() {} });
  return button;
}

/** 请求体形状：键集合逐字等于契约 `ReasonInput.properties`（`additionalProperties:false`）。 */
function assertReasonBody(bodyText, reason) {
  assert.equal(typeof bodyText, 'string', '取消必须带 JSON 请求体');
  const body = JSON.parse(bodyText);
  assert.equal(REASON_INPUT.additionalProperties, false, '契约 ReasonInput 必须是 additionalProperties:false');
  assert.deepEqual(
    Object.keys(body).sort(),
    Object.keys(REASON_INPUT.properties).sort(),
    `请求体键集合必须恰为契约 ReasonInput.properties，实测 ${JSON.stringify(Object.keys(body))}`,
  );
  assert.deepEqual(Object.keys(body), ['reason'], '取消只允许 reason 一个字段（契约外字段会被 400）');
  assert.equal(body.reason, reason);
  const length = [...body.reason].length;
  assert.ok(length >= REASON_INPUT.properties.reason.minLength && length <= REASON_INPUT.properties.reason.maxLength);
}

test('取消 running 作业：POST /admin/jobs/{id}/cancel，If-Match 取自行内 revision "3"，幂等键 job-*，请求体恰为契约 ReasonInput', async () => {
  const jobId = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  const running = job({ id: jobId, state: 'running', revision: 3 });
  const fetchImpl = fakeFetch(({ init }) => {
    if (init.method === 'GET') return jsonResponse(200, page([running]));
    return jsonResponse(200, single(job({ id: jobId, state: 'cancelled', revision: 4 })));
  });
  const mounted = await mountView({ fetchImpl });
  try {
    assert.equal(countOf(mounted.container, 'jobs-row'), 1);
    assert.match(textOf(cancelButtonOf(jobRows(mounted.container)[0])), /取消/);
    // 理由为空 ⇒ 不可取消（契约 ReasonInput.reason 必填，本地先拦）。
    assert.equal(cancelButtonOf(jobRows(mounted.container)[0]).props.disabled, true);
    assert.equal(fetchImpl.calls.length, 1, '理由为空时不得发取消请求');

    typeReason(mounted.container, '作业卡在排队，按运维确认取消');
    await settle();
    const button = cancelButtonOf(jobRows(mounted.container)[0]);
    assert.equal(button.props.disabled, false, '有 jobs:cancel + 合法理由时必须可取消');

    clickCancel(mounted.container, 0);
    await settle();

    assert.equal(fetchImpl.calls.length, 2, '读一次列表 + 一次取消（不做整表重载）');
    const { url, init } = fetchImpl.calls[1];
    assert.equal(url, `/api/v1/admin/jobs/${jobId}/cancel`, '路径必须逐字等于契约 POST /admin/jobs/{id}/cancel');
    assert.equal(init.method, 'POST');
    assert.equal(CANCEL_JOB.operationId, 'cancelAdminJob');
    assert.equal(init.headers['if-match'], '"3"', 'If-Match 必须来自该行已加载的 revision');
    assert.notEqual(init.headers['if-match'], '*', '契约 IfMatch 不允许通配');
    assert.match(init.headers['idempotency-key'], /^job-[0-9a-f]{32}$/, 'Idempotency-Key 必须是本模块生成的 8..128 字符键');
    assert.equal(init.headers.authorization, 'Bearer synthetic-admin-token');
    assertReasonBody(init.body, '作业卡在排队，按运维确认取消');

    const notice = findBy(mounted.container, (node) => node.kind === 'div' && /取消已生效/.test(textOf(node)));
    assert.ok(notice !== null, '成功必须有可见回执（不得静默）');
    assert.match(textOf(notice), /etag="4"/, '回执必须写真实 ETag');
    assert.match(textOf(notice), new RegExp(`request_id=${REQUEST_ID}`));
    const rowText = textOf(jobRows(mounted.container)[0]);
    assert.match(rowText, /cancelled/, '行内 state 必须用服务端响应值更新（不是本地推断）');
    assert.match(rowText, /"4"/, '行内 If-Match 必须跟着新 revision 走');
    assert.match(textOf(cancelButtonOf(jobRows(mounted.container)[0])), /已终态/, '取消后该行按钮必须显示终态');
    assert.equal(cancelButtonOf(jobRows(mounted.container)[0]).props.disabled, true, '终态行不得再可取消');
  } finally {
    mounted.unmount();
  }
});

test('终态作业（succeeded）⇒ 取消按钮 disabled 且 title 说明终态，一个请求都不发', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, page([job({ state: 'succeeded', error_code: null })])));
  const mounted = await mountView({ fetchImpl });
  try {
    typeReason(mounted.container, '想取消一个已经成功的作业');
    await settle();
    const button = cancelButtonOf(jobRows(mounted.container)[0]);
    assert.equal(button.props.disabled, true, '终态作业不得可取消（契约终态闭集不含 completed）');
    assert.match(textOf(button), /已终态/);
    assert.match(String(button.props.title), /终态/, '禁用必须给出原因，不能只是灰掉');
    assert.equal(fetchImpl.calls.length, 1, '终态行点不动 ⇒ 不得发请求');
  } finally {
    mounted.unmount();
  }
});

test('会话缺 jobs:cancel ⇒ 取消按钮全部 disabled + 提示点名 jobs:cancel，且只有一次 GET', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, page([job({ state: 'running', revision: 3 })])));
  const mounted = await mountView({ fetchImpl, scopes: ['jobs:read'] });
  try {
    typeReason(mounted.container, '作业卡在排队，按运维确认取消');
    await settle();
    const button = cancelButtonOf(jobRows(mounted.container)[0]);
    assert.equal(button.props.disabled, true, '缺 jobs:cancel 时按钮必须禁用（不能只靠服务端 403）');
    assert.match(String(button.props.title), /jobs:cancel/, '禁用原因必须点名缺失的 scope');
    const banner = findBy(mounted.container, (node) => node.kind === 'p' && String(node.props.class ?? '').includes('banner'));
    assert.ok(banner !== null, '缺写 scope 必须有顶部提示');
    assert.match(textOf(banner), /jobs:cancel/);
    assert.match(textOf(banner), /SCOPE_DENIED/);
    assert.equal(fetchImpl.calls.length, 1, '缺 scope 时不得发出必败的取消请求');
  } finally {
    mounted.unmount();
  }
});

test('取消 403 SCOPE_DENIED ⇒ role="alert" 横幅（含 scope 与 403），行不变、无成功回执', async () => {
  const fetchImpl = fakeFetch(({ init }) => {
    if (init.method === 'GET') return jsonResponse(200, page([job({ state: 'running', revision: 3 })]));
    return jsonResponse(403, errorEnvelope('SCOPE_DENIED', '缺少 jobs:cancel'));
  });
  const mounted = await mountView({ fetchImpl });
  try {
    typeReason(mounted.container, '作业卡在排队，按运维确认取消');
    await settle();
    clickCancel(mounted.container, 0);
    await settle();

    const alert = findBy(mounted.container, (node) => node.props.role === 'alert');
    assert.ok(alert !== null, '403 必须可见（不得静默失败）');
    const alertText = textOf(alert);
    assert.match(alertText, /权限不足/);
    assert.match(alertText, /jobs:cancel/);
    // ⚠ 源码缺陷（只报告、不修）：`JobsView.vue` 的写失败横幅写 `v-if="writeView.status !== null"`，
    // 而 `jobs-api.mjs` 的 `describeFailure()` 根本不带 `status` 字段 ⇒ 每次写失败都会渲染一个
    // 空的 `status=`。HTTP 状态只能从 detail 的 `（HTTP 403）` 后缀读到，所以这里断后缀。
    assert.match(alertText, /HTTP 403/);
    assert.doesNotMatch(textOf(mounted.container), /取消已生效/, '403 不得伪装成成功');
    const rowText = textOf(jobRows(mounted.container)[0]);
    assert.match(rowText, /running/, '失败时行内容不得被本地改写');
    assert.match(rowText, /"3"/);
  } finally {
    mounted.unmount();
  }
});

test('取消 409 REVISION_CONFLICT ⇒ alert 标题点名 If-Match 冲突，只给「重新读取后再试」，不给原样重试', async () => {
  const fetchImpl = fakeFetch(({ init }) => {
    if (init.method === 'GET') return jsonResponse(200, page([job({ state: 'running', revision: 3 })]));
    return jsonResponse(409, errorEnvelope('REVISION_CONFLICT', '该行已被改动'));
  });
  const mounted = await mountView({ fetchImpl });
  try {
    typeReason(mounted.container, '作业卡在排队，按运维确认取消');
    await settle();
    clickCancel(mounted.container, 0);
    await settle();

    const alert = findBy(mounted.container, (node) => node.props.role === 'alert');
    assert.ok(alert !== null, '409 必须可见（不得静默失败）');
    const alertText = textOf(alert);
    assert.match(alertText, /修订冲突/);
    // ⚠ 源码缺陷（只报告、不修）：`describeFailure()` 的 `revision_conflict` 分支既没有 `status` 字段、
    // detail 也不拼 `（HTTP 409）` 后缀 ⇒ 409 这个状态在横幅上**完全不可见**（只有中文标题）。
    // 因此这里断言的是标题语义（If-Match 与当前 revision 不一致），不是 HTTP 状态。
    assert.match(alertText, /If-Match 与当前 revision 不一致/);
    assert.ok(/重新读取后再试/.test(alertText), '409 只能重新读取');
    assert.equal(/用同一幂等键重试/.test(alertText), false, '409 不得给原样重试（旧 If-Match 重发只会再 409）');
    assert.match(textOf(jobRows(mounted.container)[0]), /"3"/, '失败时行内 revision 不变');
    assert.doesNotMatch(textOf(mounted.container), /取消已生效/);
  } finally {
    mounted.unmount();
  }
});
