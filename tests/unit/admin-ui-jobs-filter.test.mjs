/**
 * P08 · 作业台筛选（`state` / `error_code`）——**渲染级**用例（真实 SFC 呈现路径）。
 *
 * 缺口：服务端 `listAdminJobs` 早已把 `state` / `error_code` 下推到 SQL
 * （`services/api/src/admin/ops/jobs-pg.ts` 的 `listWhereFor()`，契约
 * `packages/contracts/openapi.json` 的 `GET /admin/jobs` 参数 `state` → `JobState`、
 * `error_code` → `ErrorCode`），但 `JobsView.vue` 只发 `limit` / `cursor`，库侧过滤在页面上没有入口。
 *
 * 本文件钉住的是「页面到底发了什么」和「URL 里到底有什么」：
 *   ① 合法 `state` 选中后，请求 URL 带 `state=<值>`（逐字编码，不夹带别的参数）；
 *   ② 合法 `error_code` 同理；
 *   ③ 闭集外的值 ⇒ **一个请求都不发** + 可读提示（不是静默失败、也不是发出去换 400）；
 *   ④ 换筛选 ⇒ `cursor` 归零（服务端的游标 watermark 绑筛选组合，
 *      `tests/unit/admin-jobs-list-filter.test.mjs` 的「换一组筛选 ⇒ 400 INVALID_CURSOR」是同一事实）；
 *   ⑤ 清空筛选 ⇒ 请求 URL 回到默认列表、URL 查询串里的该参数被删掉；
 *   ⑥ 刷新保持：带 `?state=failed` 挂载 ⇒ 第一次请求就带该参数，控件也回显该值。
 *
 * 合法取值**不许手抄**：控件选项与校验闭集都从代码派生（契约 enum 的既有镜像
 * `apps/admin/src/lib/admin-contract.mjs` 的 `ERROR_CODES`、`apps/admin/src/lib/jobs-api.mjs` 的 `JOB_STATES`），
 * 用例里再拿 `openapi.json` 的 enum 逐值对账一次，防止「UI 自己抄了一份字符串数组」。
 *
 * 基础设施：`apps/admin` 没有 vitest／@vue/test-utils／jsdom（仓内前端测试一律纯 Node），
 * 沿用 `tests/unit/admin-ui-sfc-harness.mjs` 的内存宿主 + `@vue/compiler-sfc` 编译，
 * **不新增依赖、不联网**；`../auth/session` 用只读桩模块替换（真实模块要 `import.meta.env` 与
 * `sessionStorage`，node 里跑不了）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { compileScript, parse } from '@vue/compiler-sfc';
import { createRenderer } from 'vue';

import {
  byTestId,
  createHost,
  fakeFetch,
  findAll,
  findBy,
  jsonResponse,
  requireTestId,
  settle,
  textOf,
} from './admin-ui-sfc-harness.mjs';

const VIEW_URL = new URL('../../apps/admin/src/views/JobsView.vue', import.meta.url);
const LIB_URL = new URL('../../apps/admin/src/lib/jobs-api.mjs', import.meta.url);
const VUE_URL = import.meta.resolve('vue');

const CONTRACT = JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'));
const LIST_JOBS = CONTRACT.paths['/admin/jobs'].get;
const JOB_STATE_ENUM = CONTRACT.components.schemas.JobState.enum;
const ERROR_CODE_ENUM = CONTRACT.components.schemas.ErrorCode.enum;

const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const SESSION = { accessToken: 'synthetic-admin-token', expiresAt: '2099-01-01T00:00:00.000Z', scopes: ['jobs:read', 'jobs:cancel'] };

const JOBS_URL_PREFIX = '/api/v1/admin/jobs';

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
}

/** `apps/admin/src/auth/session.ts` 的桩：只提供本页用到的导出（登录态由全局注入）。 */
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
    id: 'gy-jobs-filter',
    inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false, cacheHandlers: false } },
  });
  const code = compiled.content
    .replace(/from\s+["']vue["']/g, `from '${VUE_URL}'`)
    .replace(/from\s+["']\.\.\/auth\/session["']/g, `from '${SESSION_STUB_URL}'`)
    .replace(/from\s+["']\.\.\/lib\/jobs-api\.mjs["']/g, `from '${LIB_URL.href}'`);
  assert.deepEqual(
    [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]).filter((spec) => !/^(data:|file:)/.test(spec)),
    [],
    '编译产物里不得残留裸模块说明符（data: 模块无法解析它们）',
  );
  componentPromise = import(moduleUrl(code)).then((namespace) => namespace.default);
  return componentPromise;
}

function page(items, nextCursor = null) {
  return { data: { items, next_cursor: nextCursor }, meta: { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'real' } };
}

function errorEnvelope(code, message, retryable = false) {
  return { error: { code, message, retryable, details: [] }, meta: { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'real' } };
}

/** 契约 `AdminJob` 的九个字段（additionalProperties:false）：只出这些，不臆造。 */
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

/**
 * 挂载真实组件。`search` 是「刷新页面时地址栏里的查询串」——页面必须在第一次请求前就把它读进筛选，
 * 这样「刷新后筛选保持」才是可观测的；`history.replaceState` 的调用原样记在 `replaceCalls` 里。
 */
async function mountView({ fetchImpl, search = '', pathname = '/admin', hash = '' } = {}) {
  const host = createHost();
  const container = host.make('root');
  const { createApp } = createRenderer({ ...host.nodeOps, patchProp: host.patchProp });
  const originalFetch = globalThis.fetch;
  if (fetchImpl !== undefined) globalThis.fetch = fetchImpl;
  const replaceCalls = [];
  globalThis.window = {
    location: { search, pathname, hash },
    history: {
      state: null,
      replaceState(_state, _title, url) {
        replaceCalls.push(url);
      },
    },
  };
  globalThis.__GY_TEST_SESSION__ = SESSION;
  const app = createApp(await loadViewComponent());
  app.mount(container);
  await settle();
  return {
    container,
    replaceCalls,
    unmount() {
      app.unmount();
      globalThis.fetch = originalFetch;
      globalThis.window = undefined;
      globalThis.__GY_TEST_SESSION__ = null;
    },
  };
}

const optionValues = (container, testId) => {
  const select = requireTestId(container, testId);
  return findAll(select, (node) => node.kind === 'option').map((node) => node.props.value);
};

const loadMoreButton = (container) =>
  findBy(container, (node) => node.kind === 'button' && /加载下一页/.test(textOf(node)));

const urls = (fetchImpl) => fetchImpl.calls.map((call) => call.url);

// ---------------------------------------------------------------------------
// 闭集派生（不许 UI 手抄一份字符串数组）
// ---------------------------------------------------------------------------

test('筛选控件的选项与契约闭集逐值相等：state = JobState 七值，error_code = ErrorCode 全值（另加一个「全部」空选项）', async () => {
  // 契约事实先钉住：这两个参数确实是 get /admin/jobs 的查询参数。
  assert.deepEqual(
    LIST_JOBS.parameters.map((parameter) => parameter.name ?? parameter.$ref).filter((name) => typeof name === 'string' && !String(name).startsWith('#')),
    ['state', 'error_code'],
    '契约 GET /admin/jobs 的具名查询参数必须恰是 state 与 error_code（其余是 Cursor／Limit 的 $ref）',
  );
  assert.equal(LIST_JOBS.parameters.find((parameter) => parameter.name === 'state').schema.$ref, '#/components/schemas/JobState');
  assert.equal(LIST_JOBS.parameters.find((parameter) => parameter.name === 'error_code').schema.$ref, '#/components/schemas/ErrorCode');

  const fetchImpl = fakeFetch(() => jsonResponse(200, page([job()])));
  const mounted = await mountView({ fetchImpl });
  try {
    const stateValues = optionValues(mounted.container, 'jobs-filter-state');
    assert.equal(stateValues[0], '', '第一个选项必须是空值（＝不筛选、不发该参数）');
    assert.deepEqual(stateValues.slice(1), JOB_STATE_ENUM, 'state 选项必须逐值等于契约 JobState enum');

    const errorValues = optionValues(mounted.container, 'jobs-filter-error-code');
    assert.equal(errorValues[0], '', '第一个选项必须是空值（＝不筛选）');
    assert.deepEqual(
      [...errorValues.slice(1)].sort(),
      [...ERROR_CODE_ENUM].sort(),
      'error_code 选项必须与契约 ErrorCode enum 同集（UI 不得自己抄一份）',
    );
    assert.equal(errorValues.length, ERROR_CODE_ENUM.length + 1, `error_code 必须给全部 ${ERROR_CODE_ENUM.length} 个契约错误码`);
  } finally {
    mounted.unmount();
  }
});

// ---------------------------------------------------------------------------
// ①③ 合法 state / 非法值
// ---------------------------------------------------------------------------

test('① 选中合法 state=failed ⇒ 请求 URL 逐字带上 state=failed，且 cursor 归零（换筛选不接着上一页翻、「加载更多」随之失效）', async () => {
  // 前两页有下一页，换筛选后那一页没有 ⇒ 用来钉用户可见后果：
  // 旧游标不得把「加载更多」顶回来（否则一按就拿上一组筛选的游标接着翻）。
  let served = 0;
  const fetchImpl = fakeFetch(() => {
    served += 1;
    return jsonResponse(200, page([job({ state: 'running' })], served <= 2 ? 'cursor-2' : null));
  });
  const mounted = await mountView({ fetchImpl });
  try {
    assert.equal(fetchImpl.calls[0].url, `${JOBS_URL_PREFIX}?limit=20`, '未筛选时只带 limit（既有行为不变）');

    // 先翻到第二页，让 cursor 真的有值 —— 否则「cursor 归零」是同义反复。
    const more = loadMoreButton(mounted.container);
    assert.ok(more !== null, '有 next_cursor 时必须渲染「加载下一页」');
    more.props.onClick({});
    await settle();
    assert.equal(fetchImpl.calls[1].url, `${JOBS_URL_PREFIX}?limit=20&cursor=cursor-2`, '续页必须带上游标');

    requireTestId(mounted.container, 'jobs-filter-state').props.onChange({ target: { value: 'failed' } });
    await settle();

    assert.equal(fetchImpl.calls.length, 3, '换筛选只应发一次请求（不做多余的重载）');
    assert.equal(
      fetchImpl.calls[2].url,
      `${JOBS_URL_PREFIX}?limit=20&state=failed`,
      '换筛选后的请求必须带 state=failed，且**不得**再带上一页的 cursor',
    );
    assert.doesNotMatch(fetchImpl.calls[2].url, /cursor=/, '换筛选 ⇒ cursor 必须复位为 null');
    // 页面层对这一点的嗅觉就这一条：换筛选后服务端那一页**不再给** next_cursor ⇒
    // 「加载下一页」必须消失（内部残留游标在任何可达 UI 状态下不可观测，故这里不声称钉残留）。
    assert.equal(
      loadMoreButton(mounted.container),
      null,
      '换筛选后（服务端不再给 cursor）「加载更多」必须不可用，不得拿上一组筛选的游标接着翻',
    );
  } finally {
    mounted.unmount();
  }
});

test('② 选中合法 error_code=MEDIA_TOO_LARGE ⇒ 请求 URL 带 error_code=MEDIA_TOO_LARGE（参数名逐字用契约的 error_code）', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, page([job()])));
  const mounted = await mountView({ fetchImpl });
  try {
    requireTestId(mounted.container, 'jobs-filter-error-code').props.onChange({ target: { value: 'MEDIA_TOO_LARGE' } });
    await settle();
    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(fetchImpl.calls[1].url, `${JOBS_URL_PREFIX}?limit=20&error_code=MEDIA_TOO_LARGE`);
  } finally {
    mounted.unmount();
  }
});

test('①+② 两个筛选同时选中 ⇒ 两个参数都在 URL 里（state 在前、error_code 在后），值逐字编码', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, page([job()])));
  const mounted = await mountView({ fetchImpl });
  try {
    requireTestId(mounted.container, 'jobs-filter-state').props.onChange({ target: { value: 'timed_out' } });
    await settle();
    requireTestId(mounted.container, 'jobs-filter-error-code').props.onChange({ target: { value: 'PROVIDER_TIMEOUT' } });
    await settle();

    assert.equal(fetchImpl.calls.length, 3);
    assert.equal(
      fetchImpl.calls[2].url,
      `${JOBS_URL_PREFIX}?limit=20&state=timed_out&error_code=PROVIDER_TIMEOUT`,
      '两个筛选必须同时出现在请求里；timed_out 的下划线不得被二次编码',
    );
    assert.equal(fetchImpl.calls[2].init.method, 'GET');
    assert.equal(fetchImpl.calls[2].init.headers.authorization, 'Bearer synthetic-admin-token');
  } finally {
    mounted.unmount();
  }
});

test('③ 闭集外的 state（completed —— 契约没有这个状态）⇒ 零请求 + role="alert" 可读提示，控件回退到原值', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, page([job()])));
  const mounted = await mountView({ fetchImpl });
  try {
    requireTestId(mounted.container, 'jobs-filter-state').props.onChange({ target: { value: 'completed' } });
    await settle();

    assert.equal(fetchImpl.calls.length, 1, '非法筛选值必须在本地拦下：一条请求都不许发');
    const alert = requireTestId(mounted.container, 'jobs-filter-error');
    assert.equal(alert.props.role, 'alert', '非法筛选是错误语义，必须能被读屏播报');
    const alertText = textOf(alert);
    assert.match(alertText, /completed/, '提示必须点名用户选/传的那个值');
    assert.match(alertText, /JobState/, '提示必须点名它属于哪个契约闭集');
    assert.match(alertText, /queued/, '提示必须列出合法取值（从闭集派生，不是「参数不合法」四个字）');
    assert.equal(requireTestId(mounted.container, 'jobs-filter-state').props.value, '', '本地拒绝后控件必须留在原值（不假装筛选已生效）');
  } finally {
    mounted.unmount();
  }
});

test('③ 闭集外的 error_code ⇒ 同样零请求 + 点名 ErrorCode 闭集', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, page([job()])));
  const mounted = await mountView({ fetchImpl });
  try {
    requireTestId(mounted.container, 'jobs-filter-error-code').props.onChange({ target: { value: 'PROVIDER_UNKNOWN' } });
    await settle();

    assert.equal(fetchImpl.calls.length, 1);
    const alertText = textOf(requireTestId(mounted.container, 'jobs-filter-error'));
    assert.match(alertText, /PROVIDER_UNKNOWN/);
    assert.match(alertText, /ErrorCode/);
    assert.match(alertText, /PROVIDER_UNAVAILABLE/, '提示必须列出合法错误码');
  } finally {
    mounted.unmount();
  }
});

// ---------------------------------------------------------------------------
// ④⑤⑥ URL 同步 · 清空 · 刷新保持
// ---------------------------------------------------------------------------

test('⑤ 清空筛选 ⇒ 请求 URL 回到默认列表（不再带 state/error_code），URL 查询串里的参数也被删掉', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, page([job()])));
  const mounted = await mountView({ fetchImpl, search: '?state=failed&error_code=PROVIDER_TIMEOUT' });
  try {
    assert.equal(fetchImpl.calls[0].url, `${JOBS_URL_PREFIX}?limit=20&state=failed&error_code=PROVIDER_TIMEOUT`);

    const clear = requireTestId(mounted.container, 'jobs-filter-clear');
    clear.props.onClick({});
    await settle();

    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(fetchImpl.calls[1].url, `${JOBS_URL_PREFIX}?limit=20`, '清空筛选必须回到默认列表 URL');
    assert.equal(mounted.replaceCalls.at(-1), '/admin', '清空后地址栏不得残留 state/error_code');
    assert.equal(requireTestId(mounted.container, 'jobs-filter-state').props.value, '');
    assert.equal(requireTestId(mounted.container, 'jobs-filter-error-code').props.value, '');
  } finally {
    mounted.unmount();
  }
});

test('⑥ 刷新保持：带 ?state=failed 挂载 ⇒ 第一次请求就带 state=failed，控件回显该值；换筛选写回地址栏', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, page([job({ state: 'failed' })])));
  const mounted = await mountView({ fetchImpl, search: '?state=failed' });
  try {
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, `${JOBS_URL_PREFIX}?limit=20&state=failed`, '刷新后第一次请求就必须带上地址栏里的筛选');
    assert.equal(requireTestId(mounted.container, 'jobs-filter-state').props.value, 'failed', '控件必须回显地址栏里的筛选');

    requireTestId(mounted.container, 'jobs-filter-state').props.onChange({ target: { value: 'succeeded' } });
    await settle();
    assert.equal(fetchImpl.calls[1].url, `${JOBS_URL_PREFIX}?limit=20&state=succeeded`);
    assert.equal(mounted.replaceCalls.at(-1), '/admin?state=succeeded', '换筛选必须同步回 URL 查询串（刷新后还能保持）');
  } finally {
    mounted.unmount();
  }
});

test('⑥ 地址栏里的非法值不静默：?state=completed 挂载 ⇒ 请求只带 limit、控件空值，横幅点名被忽略的值', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, page([job()])));
  const mounted = await mountView({ fetchImpl, search: '?state=completed' });
  try {
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, `${JOBS_URL_PREFIX}?limit=20`, '地址栏里的闭集外值不得被转发给服务端（那只会换来 400）');
    assert.equal(requireTestId(mounted.container, 'jobs-filter-state').props.value, '');

    // 关键：不能像「没筛选」那样静默 —— 用户看到的是全量列表，却被留在看起来在筛选的地址栏上。
    const alert = requireTestId(mounted.container, 'jobs-filter-error');
    assert.equal(alert.props.role, 'alert', '地址栏里的非法筛选是错误语义，必须能被读屏播报');
    const alertText = textOf(alert);
    assert.match(alertText, /completed/, '提示必须点名地址栏里被忽略的那个值');
    assert.match(alertText, /JobState/, '提示必须点名它属于哪个契约闭集');
    assert.match(alertText, /已忽略/, '必须说清「这个值没生效」，不能让人以为筛选生效了');
    assert.match(alertText, /queued/, '提示必须列出合法取值（与页面内选错值同一套文案）');
  } finally {
    mounted.unmount();
  }
});

test('⑥ 地址栏里合法项与被忽略项并存 ⇒ 合法项照常生效（不被提示吞掉），只有非法项上屏', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, page([job({ state: 'failed' })])));
  const mounted = await mountView({ fetchImpl, search: '?error_code=NOPE&state=failed' });
  try {
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(
      fetchImpl.calls[0].url,
      `${JOBS_URL_PREFIX}?limit=20&state=failed`,
      '合法筛选必须照常下发（limit → state 顺序不变），非法项一个字节都不许进 URL',
    );
    assert.equal(requireTestId(mounted.container, 'jobs-filter-state').props.value, 'failed', '合法项照常回显');
    assert.equal(requireTestId(mounted.container, 'jobs-filter-error-code').props.value, '');

    const alertText = textOf(requireTestId(mounted.container, 'jobs-filter-error'));
    assert.match(alertText, /NOPE/, '提示只讲被忽略的那一项');
    assert.match(alertText, /ErrorCode/);
    assert.doesNotMatch(alertText, /state 取值不在契约闭集/, '生效中的合法筛选不得被说成被忽略');

    // 取舍钉死：被忽略的值**保留在地址栏**（不静默抹掉用户手改的原值），解释交给横幅。
    // 若哪天改成挂载时顺手把地址栏清干净，这条必须红 —— 那是产品行为变化，不能无声发生。
    assert.deepEqual(mounted.replaceCalls, [], '被忽略的地址栏原值不得被静默改写（replaceState 一次都不该发）');
  } finally {
    mounted.unmount();
  }
});

test('筛选生效时状态条说清当前筛选（不是「已加载 N 个作业」却让人以为看的是全量）', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, page([job({ state: 'failed', error_code: 'PROVIDER_TIMEOUT' })])));
  const mounted = await mountView({ fetchImpl, search: '?state=failed&error_code=PROVIDER_TIMEOUT' });
  try {
    const status = requireTestId(mounted.container, 'jobs-status');
    const statusText = textOf(status);
    assert.match(statusText, /筛选/);
    assert.match(statusText, /state=failed/);
    assert.match(statusText, /error_code=PROVIDER_TIMEOUT/);
  } finally {
    mounted.unmount();
  }
});

test('筛选值不写第二条存储通道：页面不读 localStorage，URL 同步不新增历史记录', async () => {
  // 反向钉住：本页不得为了「记住筛选」引入第二条存储通道（否则筛选会跨会话泄漏）。
  // 「真的调用了 history.replaceState」由行为用例断言（⑤ / ⑥ 的 `replaceCalls` 读数），
  // 这里只做源码级负向检查 —— 不再用「注释里出现 replaceState 就算过」的弱匹配。
  const source = readFileSync(VIEW_URL, 'utf8');
  assert.doesNotMatch(source, /localStorage/, '作业台页面不得使用 localStorage 存筛选');
  assert.doesNotMatch(source, /pushState/, '筛选同步不得用 pushState（否则每次换筛选都会多一条历史记录）');
});
