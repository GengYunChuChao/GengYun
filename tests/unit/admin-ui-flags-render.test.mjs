/**
 * 渲染级用例：`FlagsView.vue`（功能开关页）的**真实 SFC 呈现路径**。
 *
 * 为什么必须渲染级：`admin-ui-flags-api.test.mjs` 只覆盖 `lib/flags-api.mjs` 的纯函数，
 * 覆盖不到「scope 缺失时按钮到底禁没禁用」「失败横幅到底有没有上屏」「点了切换之后
 * 真正发出去的请求体是不是契约 `FlagInput`」这三条**模板**结论——而这三条正是本片要证明的。
 * （R64 侦察：`listFlags`／`setFlag` 有 UI 入口但此前**零** admin-ui 测试引用。）
 *
 * `apps/admin` 没有 vitest / @vue/test-utils / jsdom（仓内前端测试一律纯函数），
 * 所以沿用 `tests/unit/admin-ui-jobs-render.test.mjs` 的最小渲染环境，**不新增依赖、不联网**：
 *   1. `@vue/compiler-sfc` 把 `.vue` 编成 ESM（`inlineTemplate: true`，关静态提升与事件缓存），
 *      把裸模块说明符换成 `file:` / `data:` 绝对 URL；
 *   2. `../auth/session`（.ts）换成一个只读桩模块，通过 `globalThis.__GY_TEST_SESSION__` 注入会话
 *      ——本页是「页面自登录」，只有这条缝能喂进 token/scopes；⛔ 桩掉的只是鉴权层，
 *      #43/#44（getAdminSession／logoutAdmin）**不在**本文件的覆盖范围内，别把它读成已覆盖；
 *   3. `vue` 的 `createRenderer()` 造内存宿主，挂**真实组件**，网络层用 `globalThis.fetch` 桩。
 *
 * 断言口径：行数必须与 items 相等；缺 `flags:write` 时切换按钮必须 `disabled` 且给出提示；
 * 切换请求必须是 `PUT /admin/feature-flags/{key}` + `If-Match` 来自行内 revision +
 * `Idempotency-Key`，**请求体键集合恰为契约 `FlagInput.properties`**；失败横幅必须是
 * `role="alert"` 且保留 `status`／`code`；可重试失败的重试必须**复用同一幂等键**。
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

const VIEW_URL = new URL('../../apps/admin/src/views/FlagsView.vue', import.meta.url);
const LIB_URL = new URL('../../apps/admin/src/lib/flags-api.mjs', import.meta.url);
const VIEW_MODEL_URL = new URL('../../apps/admin/src/lib/flags-view-model.mjs', import.meta.url);
const VUE_URL = import.meta.resolve('vue');

const CONTRACT = JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'));
const FLAG_INPUT = CONTRACT.components.schemas.FlagInput;

const BASE_URL = '/api/v1';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const REASON = '按运营确认关闭用户投稿';
const SESSION_SCOPES = ['flags:read', 'flags:write'];

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
}

/**
 * `apps/admin/src/auth/session.ts` 的桩：只提供本页用到的四个导出。
 * 真实模块要用 `import.meta.env` 与 `sessionStorage`，node 里跑不了，也不该在本用例里跑。
 */
const SESSION_STUB_URL = moduleUrl(`
export const ADMIN_AUTH_API_IMPLEMENTED = true;
export const API_BASE_URL = '${BASE_URL}';
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
  assert.deepEqual(errors, [], 'FlagsView.vue 必须能被 @vue/compiler-sfc 解析');
  const compiled = compileScript(descriptor, {
    id: 'gy-flags-render',
    inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false, cacheHandlers: false } },
  });
  const escape = (specifier) => specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const code = compiled.content
    .replace(/from\s+["']vue["']/g, `from '${VUE_URL}'`)
    .replace(new RegExp(`from\\s+["']${escape('../auth/session')}["']`, 'g'), `from '${SESSION_STUB_URL}'`)
    .replace(new RegExp(`from\\s+["']${escape('../lib/flags-api.mjs')}["']`, 'g'), `from '${LIB_URL.href}'`)
    .replace(new RegExp(`from\\s+["']${escape('../lib/flags-view-model.mjs')}["']`, 'g'), `from '${VIEW_MODEL_URL.href}'`);
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

const classesOf = (node) => String(node.props.class ?? '').split(/\s+/).filter(Boolean);
const hasClass = (name) => (node) => classesOf(node).includes(name);

/** 每行一个「切换」按钮（模板里 class="ghost small"）；行数用它数，顺带拿到按钮。 */
const toggleButtons = (container) => findAll(container, (node) => node.kind === 'button' && hasClass('small')(node));
/** 数据行：tbody 里的 tr（表头 tr 没有 class 绑定，`props.class` 是 undefined）。 */
const dataRows = (container) => findAll(container, (node) => node.kind === 'tr' && typeof node.props.class === 'string');
const scopeBanners = (container) => findAll(container, (node) => node.kind === 'p' && hasClass('banner')(node) && hasClass('warn')(node));
const alertBanners = (container) => findAll(container, (node) => node.props.role === 'alert');
const statusPanel = (container) => findBy(container, (node) => node.kind === 'div' && hasClass('status')(node));
const reasonInput = (container) => findBy(container, (node) => node.props.name === 'reason');

function jsonResponse(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body };
}

function flagPage(items, nextCursor = null) {
  return {
    data: { items, next_cursor: nextCursor },
    meta: { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'stub' },
  };
}

function flagEnvelope(data, headers = {}) {
  return jsonResponse(200, { data, meta: { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'stub' } }, headers);
}

function errorEnvelope(code, message, status, headers = {}) {
  return jsonResponse(status, { error: { code, message, retryable: false, details: [] }, meta: { request_id: REQUEST_ID } }, headers);
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return handler({ url, init, index: calls.length - 1 });
  };
  impl.calls = calls;
  return impl;
}

async function mountView({ fetchImpl, scopes = SESSION_SCOPES, session = true } = {}) {
  const host = createHost();
  const container = host.make('root');
  const { createApp } = createRenderer({ ...host.nodeOps, patchProp: host.patchProp });
  const originalFetch = globalThis.fetch;
  if (fetchImpl !== undefined) globalThis.fetch = fetchImpl;
  globalThis.__GY_TEST_SESSION__ = session
    ? { accessToken: 'synthetic-admin-token', expiresAt: '2099-01-01T00:00:00.000Z', scopes }
    : null;
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

function typeReason(container, value) {
  const input = reasonInput(container);
  assert.ok(input !== null, '必须渲染变更理由输入框（contract FlagInput.reason 必填）');
  assert.equal(typeof input.props.onInput, 'function', '理由输入框必须挂着 input 处理器');
  input.props.onInput({ target: { value } });
}

/** 点击第 index 行的切换按钮：`@click.stop` 编译成带 stop 修饰的处理器，事件要给 stopPropagation。 */
function clickToggle(container, index = 0) {
  const buttons = toggleButtons(container);
  assert.ok(buttons.length > index, `找不到第 ${index} 行的切换按钮（共 ${buttons.length} 个）`);
  const button = buttons[index];
  assert.equal(typeof button.props.onClick, 'function', '切换按钮必须挂着 click 处理器');
  button.props.onClick({ stopPropagation() {} });
  return button;
}

/**
 * 请求体形状断言：键集合逐字等于契约 `FlagInput.properties`（`additionalProperties: false`），
 * required 两条都在，类型／长度按契约。⛔ 「发了个 PUT」不构成对 setFlag 的覆盖。
 */
function assertFlagInputBody(bodyText, expected) {
  assert.equal(typeof bodyText, 'string', '切换开关必须带 JSON 请求体');
  const body = JSON.parse(bodyText);
  assert.equal(FLAG_INPUT.additionalProperties, false, '契约 FlagInput 必须是 additionalProperties:false');
  assert.deepEqual(Object.keys(body).sort(), Object.keys(FLAG_INPUT.properties).sort(),
    `请求体键集合必须恰为契约 FlagInput.properties，实测 ${JSON.stringify(Object.keys(body))}`);
  for (const forbidden of ['key', 'revision', 'scope']) {
    assert.equal(forbidden in body, false, `请求体不得出现契约外字段 ${forbidden}`);
  }
  assert.equal(typeof body.enabled, 'boolean');
  assert.equal(typeof body.reason, 'string');
  const length = [...body.reason].length;
  assert.ok(length >= FLAG_INPUT.properties.reason.minLength && length <= FLAG_INPUT.properties.reason.maxLength);
  assert.equal(body.enabled, expected.enabled);
  assert.equal(body.reason, expected.reason);
}

test('3 个开关 ⇒ 渲染 3 行，key／revision／If-Match 原样上屏，请求只有一次 GET', async () => {
  const fetchImpl = fakeFetch(() =>
    jsonResponse(200, flagPage([
      { key: 'submissions_enabled', enabled: true, revision: 5 },
      { key: 'specific_herbicide_output_enabled', enabled: false, revision: 2 },
      { key: 'ai_enabled', enabled: false, revision: 7 },
    ])),
  );
  const mounted = await mountView({ fetchImpl });
  try {
    assert.equal(toggleButtons(mounted.container).length, 3, '3 个开关必须渲染 3 个切换按钮');
    assert.equal(dataRows(mounted.container).length, 3, '3 个开关必须渲染 3 行');
    const pageText = textOf(mounted.container);
    assert.match(pageText, /功能开关/);
    assert.match(pageText, /listFlags/);
    assert.match(pageText, /flags:read/);
    assert.match(pageText, /flags:write/);
    assert.match(pageText, /r5/);
    assert.match(pageText, /r7/);
    assert.match(pageText, /"5"/, 'If-Match 由 revision 推出并上屏（形如 "5"）');
    assert.match(pageText, /"7"/);
    const status = statusPanel(mounted.container);
    assert.ok(status !== null, '必须渲染状态条');
    assert.equal(status.props.role, 'status', '正常读数是 status 语义');
    assert.match(textOf(status), /已读取功能开关/);

    assert.equal(fetchImpl.calls.length, 1, '进页面只读一次列表');
    assert.equal(fetchImpl.calls[0].url, `${BASE_URL}/admin/feature-flags?limit=20`);
    assert.equal(fetchImpl.calls[0].init.method, 'GET');
    assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer synthetic-admin-token');
  } finally {
    mounted.unmount();
  }
});

test('缺 flags:write ⇒ 切换按钮全部 disabled + 顶部提示说明原因，且一个写请求都不发', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, flagPage([{ key: 'ai_enabled', enabled: false, revision: 3 }])));
  const mounted = await mountView({ fetchImpl, scopes: ['flags:read'] });
  try {
    typeReason(mounted.container, REASON);
    await settle();

    const buttons = toggleButtons(mounted.container);
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].props.disabled, true, '缺 flags:write 时切换按钮必须禁用（不能只靠服务端 403）');
    assert.match(String(buttons[0].props.title), /需要 flags:write 与合法的变更理由/, '禁用必须给出原因，不能只是灰掉');
    const banners = scopeBanners(mounted.container);
    assert.equal(banners.length, 1, '只缺写 scope ⇒ 只有一条提示');
    const bannerText = textOf(banners[0]);
    assert.match(bannerText, /flags:write/);
    assert.match(bannerText, /SCOPE_DENIED/);
    assert.match(textOf(mounted.container), /无 flags:write/, '行内「本会话写权限」列必须显示无权限');

    // 本页的权限闸门就是按钮的 `disabled`（浏览器不会把 click 派发给 disabled 按钮）；
    // 因此这里断言「进页面 + 填理由之后仍只有那一次 GET」，而不是去硬调 disabled 按钮的处理器
    // ——硬调等于绕过 DOM 语义，测的就不是页面了。
    assert.equal(fetchImpl.calls.length, 1, '缺 scope 时不得发出必败的 PUT');
  } finally {
    mounted.unmount();
  }
});

test('读写 scope 都缺 ⇒ 两条提示都在；理由为空时切换按钮也禁用并给出理由文案', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, flagPage([{ key: 'ai_enabled', enabled: true, revision: 2 }])));
  const mounted = await mountView({ fetchImpl, scopes: [] });
  try {
    const banners = scopeBanners(mounted.container);
    assert.equal(banners.length, 2, '缺读 scope 与缺写 scope 是两条不同的提示');
    assert.match(textOf(banners[0]), /flags:read/);
    assert.match(textOf(banners[1]), /flags:write/);
    assert.equal(toggleButtons(mounted.container)[0].props.disabled, true);
    assert.match(textOf(mounted.container), /理由不可用/);
  } finally {
    mounted.unmount();
  }
});

test('读取 403 SCOPE_DENIED ⇒ 错误态上屏（含 403／错误码），不渲染表格、不伪造数据行', async () => {
  const fetchImpl = fakeFetch(() => errorEnvelope('SCOPE_DENIED', '缺少 flags:read', 403));
  const mounted = await mountView({ fetchImpl });
  try {
    const status = statusPanel(mounted.container);
    assert.ok(status !== null, '403 必须有提示（不得白屏）');
    assert.equal(hasClass('error')(status), true, '失败态必须带 error 色调');
    const statusText = textOf(status);
    assert.match(statusText, /权限不足/);
    assert.match(statusText, /403/);
    assert.match(statusText, /SCOPE_DENIED/);
    assert.equal(dataRows(mounted.container).length, 0, '403 不得渲染数据行');
    assert.equal(toggleButtons(mounted.container).length, 0);
  } finally {
    mounted.unmount();
  }
});

test('读取 503 ⇒ 错误态写明「服务暂不可用」与错误码，且不出现假的开关行', async () => {
  const fetchImpl = fakeFetch(() => errorEnvelope('PROVIDER_UNAVAILABLE', '开关端口尚未接线', 503));
  const mounted = await mountView({ fetchImpl });
  try {
    const status = statusPanel(mounted.container);
    assert.equal(hasClass('error')(status), true);
    const statusText = textOf(status);
    assert.match(statusText, /服务暂不可用/);
    assert.match(statusText, /503/);
    assert.match(statusText, /PROVIDER_UNAVAILABLE/);
    assert.equal(dataRows(mounted.container).length, 0);
    assert.match(textOf(mounted.container), /重新读取|重试/);
  } finally {
    mounted.unmount();
  }
});

test('切换成功：PUT + If-Match "3" + Idempotency-Key，请求体恰为契约 FlagInput，成功横幅与行内新 revision 上屏', async () => {
  const fetchImpl = fakeFetch(({ url, init }) => {
    if (init.method === 'GET') return jsonResponse(200, flagPage([{ key: 'ai_enabled', enabled: false, revision: 3 }]));
    assert.equal(url, `${BASE_URL}/admin/feature-flags/ai_enabled`);
    return flagEnvelope({ key: 'ai_enabled', enabled: true, revision: 4 }, { etag: '"4"' });
  });
  const mounted = await mountView({ fetchImpl });
  try {
    typeReason(mounted.container, REASON);
    await settle();
    const button = toggleButtons(mounted.container)[0];
    assert.equal(button.props.disabled, false, '有写 scope + 合法理由时必须可点');
    assert.match(textOf(button), /切换为启用/);

    clickToggle(mounted.container, 0);
    await settle();

    assert.equal(fetchImpl.calls.length, 2, '读一次 + 写一次');
    const { url, init } = fetchImpl.calls[1];
    assert.equal(url, `${BASE_URL}/admin/feature-flags/ai_enabled`, '路径必须是契约 /admin/feature-flags/{key}');
    assert.equal(init.method, 'PUT', 'setFlag 是 PUT');
    assert.equal(init.headers['if-match'], '"3"', 'If-Match 必须来自已加载行的 revision');
    assert.notEqual(init.headers['if-match'], '*');
    assert.match(init.headers['idempotency-key'], /^flag-[0-9a-f]{32}$/, 'Idempotency-Key 必须是本模块生成的 8..128 字符键');
    assert.equal(init.headers.authorization, 'Bearer synthetic-admin-token');
    assertFlagInputBody(init.body, { enabled: true, reason: REASON });

    const okBanner = findBy(mounted.container, (node) => node.kind === 'div' && hasClass('banner')(node) && hasClass('ok')(node));
    assert.ok(okBanner !== null, '成功必须有可见回执');
    assert.match(textOf(okBanner), /写入已生效/);
    assert.match(textOf(okBanner), /revision/);
    const pageText = textOf(mounted.container);
    assert.match(pageText, /r4/, '行内 revision 必须用服务端响应值更新');
    assert.match(pageText, /"4"/);
    assert.match(textOf(mounted.container), /切换为关闭/, 'enabled=true 之后按钮文案必须翻转');
  } finally {
    mounted.unmount();
  }
});

test('切换 409 REVISION_CONFLICT ⇒ role="alert" 横幅保留 status/code，只给「重新读取」不给原样重试，行不变', async () => {
  const fetchImpl = fakeFetch(({ init }) => {
    if (init.method === 'GET') return jsonResponse(200, flagPage([{ key: 'ai_enabled', enabled: false, revision: 3 }]));
    return errorEnvelope('REVISION_CONFLICT', '开关已被他人改动', 409);
  });
  const mounted = await mountView({ fetchImpl });
  try {
    typeReason(mounted.container, REASON);
    await settle();
    clickToggle(mounted.container, 0);
    await settle();

    const alerts = alertBanners(mounted.container);
    assert.equal(alerts.length, 1, '写失败必须有且只有一条 alert');
    const alertText = textOf(alerts[0]);
    assert.match(alertText, /修订冲突/);
    assert.match(alertText, /status=409/);
    assert.match(alertText, /code=REVISION_CONFLICT/);
    assert.match(alertText, /重新读取后再试/, '409 只能重新读取，不能原样重发');
    assert.equal(/用同一幂等键重试/.test(alertText), false, '409 不得给「用同一幂等键重试」');
    assert.match(textOf(mounted.container), /r3/, '失败时行内容不得被本地改写');
    assert.doesNotMatch(textOf(mounted.container), /写入已生效/);
  } finally {
    mounted.unmount();
  }
});

test('切换 503（可重试）⇒ 横幅给「用同一幂等键重试」，重试真的复用同一个 Idempotency-Key 与 If-Match', async () => {
  const fetchImpl = fakeFetch(({ init }) => {
    if (init.method === 'GET') return jsonResponse(200, flagPage([{ key: 'ai_enabled', enabled: false, revision: 3 }]));
    return errorEnvelope('PROVIDER_UNAVAILABLE', '开关端口暂时不可用', 503);
  });
  const mounted = await mountView({ fetchImpl });
  try {
    typeReason(mounted.container, REASON);
    await settle();
    clickToggle(mounted.container, 0);
    await settle();

    const alerts = alertBanners(mounted.container);
    assert.equal(alerts.length, 1);
    assert.match(textOf(alerts[0]), /服务暂不可用/);
    assert.match(textOf(alerts[0]), /status=503/);
    const retry = findBy(alerts[0], (node) => node.kind === 'button' && /同一幂等键/.test(textOf(node)));
    assert.ok(retry !== null, '可重试失败必须给「用同一幂等键重试」');

    retry.props.onClick({ stopPropagation() {} });
    await settle();
    assert.equal(fetchImpl.calls.length, 3, '读一次 + 写两次');
    const first = fetchImpl.calls[1].init;
    const second = fetchImpl.calls[2].init;
    assert.equal(second.headers['idempotency-key'], first.headers['idempotency-key'], '重试必须复用同一幂等键');
    assert.equal(second.headers['if-match'], first.headers['if-match'], '重试必须复用同一 If-Match');
    assert.equal(second.body, first.body, '重试不得改请求体（改体+旧键会 409 IDEMPOTENCY_CONFLICT）');
  } finally {
    mounted.unmount();
  }
});

test('理由为空 ⇒ 切换按钮禁用（本地就不发必败请求），理由提示文案上屏', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, flagPage([{ key: 'ai_enabled', enabled: false, revision: 3 }])));
  const mounted = await mountView({ fetchImpl });
  try {
    assert.equal(toggleButtons(mounted.container)[0].props.disabled, true, '契约 FlagInput.reason 必填 ⇒ 空理由不得可点');
    assert.match(textOf(mounted.container), /理由不可用/);
    assert.equal(fetchImpl.calls.length, 1, '空理由不得发出 PUT');
    // 填上合法理由后同一个按钮必须解除禁用 —— 证明 disabled 来自理由校验，而不是恒禁用。
    typeReason(mounted.container, REASON);
    await settle();
    assert.equal(toggleButtons(mounted.container)[0].props.disabled, false);
  } finally {
    mounted.unmount();
  }
});
