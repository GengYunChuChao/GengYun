/**
 * 渲染级用例：`AuditLogsView.vue`（审计总台账）的**真实 SFC 呈现路径**。
 *
 * 为什么必须渲染级：`admin-ui-audit-logs.test.mjs` 只覆盖 `lib/admin-audit-logs.mjs` 的纯函数；
 * 覆盖不到「到底渲染出几行」「403 到底有没有上屏」「空数组到底有没有空态」这三条**模板**结论
 * ——而这三条正是本片要证明的东西。
 *
 * `apps/admin` 没有 vitest / @vue/test-utils / jsdom（仓内前端测试一律纯函数），
 * 所以沿用 `tests/unit/admin-ui-post-takedown-render.test.mjs` 的最小渲染环境，**不新增依赖、不联网**：
 *   1. `@vue/compiler-sfc` 把 `.vue` 编成 ESM（`inlineTemplate: true`，关静态提升与事件缓存），
 *      把裸模块说明符换成 `file:` / `data:` 绝对 URL；
 *   2. `../auth/session`（.ts）换成一个只读桩模块，通过 `globalThis.__GY_TEST_SESSION__` 注入会话
 *      ——本页是「页面自登录」，只有这条缝能喂进 token/scopes；
 *   3. `vue` 的 `createRenderer()` 造内存宿主，挂**真实组件**，网络层用 `globalThis.fetch` 桩。
 *
 * 断言口径：有数据就得有行；403 必须是 `role="alert"` 的明确提示且**不得**同时出现空态；
 * 空数组必须是空态而不是错误。
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

const VIEW_URL = new URL('../../apps/admin/src/views/AuditLogsView.vue', import.meta.url);
const LIB_URL = new URL('../../apps/admin/src/lib/admin-audit-logs.mjs', import.meta.url);
const VUE_URL = import.meta.resolve('vue');

const SESSION = { accessToken: 'synthetic-admin-token', expiresAt: '2099-01-01T00:00:00.000Z', scopes: ['audit:read'] };
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

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
  assert.deepEqual(errors, [], 'AuditLogsView.vue 必须能被 @vue/compiler-sfc 解析');
  const compiled = compileScript(descriptor, {
    id: 'gy-audit-logs-render',
    inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false, cacheHandlers: false } },
  });
  const escape = (specifier) => specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const code = compiled.content
    .replace(/from\s+["']vue["']/g, `from '${VUE_URL}'`)
    .replace(new RegExp(`from\\s+["']${escape('../auth/session')}["']`, 'g'), `from '${SESSION_STUB_URL}'`)
    .replace(new RegExp(`from\\s+["']${escape('../lib/admin-audit-logs.mjs')}["']`, 'g'), `from '${LIB_URL.href}'`);
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

function auditEvent(overrides = {}) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    action: 'set_flag',
    scope: 'flags:write',
    target_ref: { type: 'flag', id: 'answer.public', revision: 4 },
    reason_code: 'manual',
    request_id: REQUEST_ID,
    result: 'accepted',
    created_at: '2026-10-23T08:12:33.000Z',
    actor: null,
    target_hint: null,
    before_value: null,
    after_value: null,
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

test('3 条事件 ⇒ 渲染 3 行（不是 0 行、也不是错误态）', async () => {
  const fetchImpl = fakeFetch(() =>
    jsonResponse(
      200,
      page([
        auditEvent({ id: '44444444-4444-4444-8444-444444444441', action: 'account.suspend', scope: 'accounts:suspend', result: 'accepted' }),
        auditEvent({ id: '44444444-4444-4444-8444-444444444442', action: 'set_flag', result: 'denied' }),
        auditEvent({ id: '44444444-4444-4444-8444-444444444443', action: 'job.cancel', scope: 'jobs:cancel', result: 'failed', target_ref: { type: 'job', id: 'job-9', revision: 2 } }),
      ]),
    ),
  );
  const mounted = await mountView({ fetchImpl });
  try {
    assert.equal(countOf(mounted.container, 'audit-log-row'), 3, '3 条事件必须渲染 3 行');
    const status = findBy(mounted.container, byTestId('audit-log-status'));
    assert.ok(status !== null, '必须渲染状态条');
    assert.equal(status.props.role, 'status');
    assert.match(textOf(status), /已读取 3 条/);
    assert.equal(findBy(mounted.container, byTestId('audit-log-empty')), null, '有数据时不得同时显示空态');
    const pageText = textOf(mounted.container);
    assert.match(pageText, /审计总台账（只读）/, '标题与 capability map 命名一致');
    assert.match(pageText, /GET \/admin\/audit-logs/);
    assert.match(pageText, /listAuditLogs/);
    assert.match(pageText, /audit:read/);
    assert.match(pageText, /2026-10-23 08:12:33Z/, '时间按 UTC 稳定渲染');
    assert.equal(fetchImpl.calls.length, 1);
    assert.match(fetchImpl.calls[0].url, /^\/api\/v1\/admin\/audit-logs\?limit=20$/);
    assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer synthetic-admin-token');
  } finally {
    mounted.unmount();
  }
});

test('403 SCOPE_DENIED ⇒ role="alert" 的明确提示，且**不是**白屏也不是空态', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(403, errorEnvelope('SCOPE_DENIED', '缺少 audit:read')));
  const mounted = await mountView({ fetchImpl });
  try {
    const status = findBy(mounted.container, byTestId('audit-log-status'));
    assert.ok(status !== null, '403 必须有提示（不得白屏）');
    assert.equal(status.props.role, 'alert', '403 必须是 alert 语义');
    const statusText = textOf(status);
    assert.match(statusText, /权限不足/);
    assert.match(statusText, /audit:read/);
    assert.match(statusText, /后台会话有效/);
    assert.equal(countOf(mounted.container, 'audit-log-row'), 0);
    assert.equal(findBy(mounted.container, byTestId('audit-log-empty')), null, '403 不得被渲染成空台账');
    assert.equal(findBy(mounted.container, byTestId('audit-log-table')), null, '403 不渲染表格');
    const code = findBy(mounted.container, byTestId('audit-log-error-code'));
    assert.ok(code !== null, '必须显示错误码');
    assert.match(textOf(code), /SCOPE_DENIED/);
    assert.equal(countOf(mounted.container, 'audit-log-retry'), 0, '403 不给「重试」——重试同一个无权会话没有意义');
    assert.ok(findBy(mounted.container, byTestId('audit-log-sign-out')) !== null, '必须给出可走的下一步（退出登录换账号）');
  } finally {
    mounted.unmount();
  }
});

test('空数组 ⇒ 空态（说清「空台账，不是错误」）', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, page([], null)));
  const mounted = await mountView({ fetchImpl });
  try {
    assert.equal(countOf(mounted.container, 'audit-log-row'), 0);
    const empty = findBy(mounted.container, byTestId('audit-log-empty'));
    assert.ok(empty !== null, '空数组必须渲染空态');
    const emptyText = textOf(empty);
    assert.match(emptyText, /审计总台账为空/);
    assert.match(emptyText, /空台账，不是错误/);
    const status = findBy(mounted.container, byTestId('audit-log-status'));
    assert.equal(status.props.role, 'status');
    assert.equal(countOf(mounted.container, 'audit-log-retry'), 0, '空台账不是错误，不给重试按钮');
  } finally {
    mounted.unmount();
  }
});

test('筛选栏是契约的 entity（⛔ 不出现 entity_type），action 只有闭集四项', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, page([auditEvent()])));
  const mounted = await mountView({ fetchImpl });
  try {
    assert.ok(findBy(mounted.container, byTestId('audit-log-filter-entity')) !== null, '必须有 entity 筛选');
    assert.ok(findBy(mounted.container, byTestId('audit-log-filter-action')) !== null, '必须有 action 筛选');
    assert.ok(findBy(mounted.container, byTestId('audit-log-filter-from')) !== null, '必须有 from');
    assert.ok(findBy(mounted.container, byTestId('audit-log-filter-to')) !== null, '必须有 to');
    assert.doesNotMatch(textOf(mounted.container), /entity_type/);
    const pageText = textOf(mounted.container);
    for (const action of ['account.suspend', 'account.restore', 'set_flag', 'job.cancel']) {
      assert.match(pageText, new RegExp(action.replace('.', '\\.')), `action 闭集必须包含 ${action}`);
    }
    assert.match(pageText, /换筛选/, '必须写明换筛选会回第一页');
  } finally {
    mounted.unmount();
  }
});

test('503（服务端 retryable:false）⇒ alert + 「服务暂不可用」，且**不得**伪装成空台账', async () => {
  const fetchImpl = fakeFetch(() =>
    jsonResponse(503, errorEnvelope('PROVIDER_UNAVAILABLE', '审计日志读取尚未接线', false)),
  );
  const mounted = await mountView({ fetchImpl });
  try {
    const status = findBy(mounted.container, byTestId('audit-log-status'));
    assert.ok(status !== null, '503 必须有提示（不得白屏）');
    assert.equal(status.props.role, 'alert', '503 必须是 alert 语义');
    const statusText = textOf(status);
    assert.match(statusText, /服务暂不可用/);
    assert.match(statusText, /503/);
    assert.match(statusText, /不伪造空页/);
    // 这条是注入 9 的反面：后端 503 不许被渲染成「0 条事件」的空台账
    assert.equal(findBy(mounted.container, byTestId('audit-log-empty')), null, '503 不得被渲染成空台账');
    assert.doesNotMatch(textOf(mounted.container), /审计总台账为空/);
    assert.equal(countOf(mounted.container, 'audit-log-row'), 0, '503 不得伪造数据行');
    const code = findBy(mounted.container, byTestId('audit-log-error-code'));
    assert.match(textOf(code), /PROVIDER_UNAVAILABLE/);
    // 服务端声明 retryable:false ⇒ 不给「稍后重试」按钮，也不说「稍后重试」
    assert.equal(countOf(mounted.container, 'audit-log-retry'), 0, '服务端声明不可重试时不得给重试按钮');
    assert.doesNotMatch(textOf(status), /稍后重试/);
    assert.match(textOf(status), /不可自动重试/);
  } finally {
    mounted.unmount();
  }
});

test('503 但服务端声明 retryable:true ⇒ 才给「重试」按钮', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(503, errorEnvelope('PROVIDER_UNAVAILABLE', '暂时过载', true)));
  const mounted = await mountView({ fetchImpl });
  try {
    const status = findBy(mounted.container, byTestId('audit-log-status'));
    assert.equal(status.props.role, 'alert');
    assert.equal(countOf(mounted.container, 'audit-log-retry'), 1, '服务端明说可重试时必须有重试按钮');
    assert.match(textOf(status), /稍后重试/);
    assert.equal(countOf(mounted.container, 'audit-log-row'), 0);
  } finally {
    mounted.unmount();
  }
});
