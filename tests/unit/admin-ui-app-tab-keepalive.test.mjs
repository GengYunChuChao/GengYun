/**
 * 页面级渲染用例：后台控制台「切页就丢回执」（R68-B10）。
 *
 * 缺陷形态：`apps/admin/src/App.vue` 用 `v-if` 链切换 10 个页面、**没有缓存** —— 切走即卸载、
 * 切回即重建。于是「停用某个管理员 / 隐藏某条帖子」拿到的那条 `WriteReceipt`（以及那一步的结果
 * 摘要）随卸载一起消失，页面还会重新拉一次第一页：用户切回来只看得到一个干净的首页，
 * 无法确认刚才那步到底生效没有。
 *
 * 口径：**真**编译真 SFC（`@vue/compiler-sfc`）+ **真** App 模板（10 个真视图全在链上）+
 * **真**状态机 + **真** lib，只换掉两个环境边界：
 *  - `./auth/session`（TypeScript + `import.meta.env` + `sessionStorage`，Node 里根本加载不了）
 *    → 换成同签名的 `data:` 模块桩，会话由 `globalThis.__GY_TEST_SESSION__` 提供；
 *  - `globalThis.fetch` → 记录 `(url, method)` 的桩，与被测页面生产路径是同一条 `fetch`。
 * 被测对象（App.vue 的切页与缓存行为、AdministratorsView 的写回执状态）没有任何 mock。
 *
 * 三条用例：
 *  1. 正例：切走再切回，写回执与结果摘要**仍然可见**，而且还是同一条（同一个 `request_id`）；
 *  2. 硬条件：切回来**不多发**一次读请求（`GET /admin/administrators` 只许不变或更少）；
 *  3. 结构钉子：切页链必须整体包在 `<KeepAlive>` 里、缓存上限钉成标签页数、且不许用 `v-show` 常挂。
 *
 * 负控制（退回修法必须变红）已在本片交付说明里贴过原文：把 `<KeepAlive>` 摘掉后，第 1、2 条
 * 会分别报「切回来之后回执必须仍然可见」与「切回来不得再拉一次第一页」，第 3 条报
 * 「App.vue 的切页链必须被 <KeepAlive> 包住」。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';

import {
  VUE_URL,
  byTestId,
  envelope,
  errorEnvelope,
  fakeFetch,
  findBy,
  jsonResponse,
  mountComponent,
  settle,
  textOf,
  withFetch,
} from './admin-ui-sfc-harness.mjs';

/** 被测入口：真 App.vue。 */
const APP_URL = new URL('../../apps/admin/src/App.vue', import.meta.url);

const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const SESSION = {
  accessToken: 'synthetic-admin-token',
  expiresAt: '2099-01-01T00:00:00.000Z',
  scopes: ['scopes:read', 'scopes:write'],
};

const ADMINISTRATORS_TAB = '管理员权限读面';
const OTHER_TAB = '作业台';

function dataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
}

/** 环境边界桩：`auth/session.ts` 的公开面（键名与真实导出逐一对齐）。 */
const SESSION_STUB_URL = dataUrl(`
export const ADMIN_AUTH_API_IMPLEMENTED = true;
export const API_BASE_URL = '/api/v1';
export function loadAdminSession() {
  return Promise.resolve(globalThis.__GY_TEST_SESSION__ ?? null);
}
export function signInAdmin() {
  return Promise.reject(new Error('后台登录失败：SESSION_REQUIRED'));
}
export function signOutAdmin() {
  globalThis.__GY_TEST_SESSION__ = null;
  return Promise.resolve();
}
`);

const moduleUrlCache = new Map();

/** 把 `.vue` 递归编译成 `data:` 模块 URL；`auth/session` 换成桩，`.mjs` 给 `file:` URL。 */
async function compileVue(url) {
  const cached = moduleUrlCache.get(url.href);
  if (cached !== undefined) return cached;
  const promise = (async () => {
    const filename = fileURLToPath(url);
    const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename });
    assert.deepEqual(errors, [], `${url.pathname} 必须能被 @vue/compiler-sfc 解析`);
    const compiled = compileScript(descriptor, {
      id: `gy-app-tab-${url.pathname.replace(/[^a-z0-9]/gi, '-')}`,
      inlineTemplate: true,
      templateOptions: { compilerOptions: { hoistStatic: false, cacheHandlers: false } },
    });
    // App.vue 是 `<script setup lang="ts">`：`compileScript` 不剥类型，而 `data:` 模块不走 Node 的
    // 类型剥离，所以先用仓里已声明的 `typescript` 做一次纯语法降级（不打包、不改语义）。
    const lang = descriptor.scriptSetup?.lang ?? descriptor.script?.lang ?? 'js';
    const code = lang === 'ts'
      ? ts.transpileModule(compiled.content, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        fileName: `${filename}.ts`,
      }).outputText
      : compiled.content;
    const specs = [...new Set([...code.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]))];
    const mapping = new Map();
    for (const spec of specs) mapping.set(spec, await resolveSpecifier(spec, url));
    const rewritten = code.replace(/from\s+(["'])([^"']+)\1/g, (_match, _quote, spec) => `from '${mapping.get(spec) ?? spec}'`);
    assert.deepEqual(
      [...rewritten.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]).filter((id) => !/^(data:|file:)/.test(id)),
      [],
      '编译产物里不得残留裸模块说明符（data: 模块无法解析它们）',
    );
    return dataUrl(rewritten);
  })();
  moduleUrlCache.set(url.href, promise);
  return promise;
}

async function resolveSpecifier(spec, baseUrl) {
  if (spec === 'vue') return VUE_URL;
  assert.match(spec, /^\.\.?\//, `编译产物里出现了未处理的裸模块说明符：${spec}`);
  if (/(^|\/)auth\/session$/.test(spec)) return SESSION_STUB_URL;
  const target = new URL(spec, baseUrl);
  return target.pathname.endsWith('.vue') ? compileVue(target) : target.href;
}

/** 管理员目录的一行（`AdminAdministratorView`：id 是 `admin_accounts.id`，`revision` 是 `If-Match` 来源）。 */
function administratorRow() {
  return { id: ADMIN_ID, login_name: 'ops-root', revision: 4, state: 'active', scopes: ['scopes:read', 'scopes:write'] };
}

/**
 * 读面桩：只接桩本用例真正会走到的三个页面（账号目录 / 管理员目录 / 作业台）。
 * `POST …/disable` 返回 `changed:true` 的真迁移回执 —— 页面据此渲染「写操作成功回执」。
 */
function consoleFetch() {
  return fakeFetch(({ url, init }) => {
    const method = init?.method ?? 'GET';
    const path = String(url).split('?')[0];
    if (path === '/api/v1/admin/administrators' && method === 'GET') {
      return jsonResponse(200, envelope({ items: [administratorRow()], next_cursor: null }, REQUEST_ID));
    }
    if (path === `/api/v1/admin/administrators/${ADMIN_ID}/disable` && method === 'POST') {
      return jsonResponse(
        200,
        envelope({ id: ADMIN_ID, revision: 5, state: 'suspended', auth_epoch: 2, revoked_sessions: 1, changed: true }, REQUEST_ID),
        { etag: '"5"' },
      );
    }
    if (/^\/api\/v1\/admin\/(accounts|jobs)$/.test(path) && method === 'GET') {
      return jsonResponse(200, envelope({ items: [], next_cursor: null }, REQUEST_ID));
    }
    return jsonResponse(503, errorEnvelope('PROVIDER_UNAVAILABLE', '本用例只接桩了账号目录 / 管理员目录 / 作业台三个读面'));
  });
}

/** 点一下：`@click.stop` 会被 runtime-dom 包成 `_withModifiers(handler, ['stop'])`，事件对象要能响应。 */
function click(node) {
  assert.equal(typeof node.props.onClick, 'function', '目标节点必须挂着 click 处理器');
  node.props.onClick({
    currentTarget: node,
    target: node,
    stopPropagation() {},
    preventDefault() {},
    key: '',
    shiftKey: false,
  });
}

/** 往 `v-model` 的原生 `<input>` 里打字：`vModelText` 读的是 `el.value`，所以写真值再派发 `input`。 */
function typeIntoModel(container, testId, value) {
  const node = findBy(container, byTestId(testId));
  assert.ok(node !== null, `找不到 data-testid="${testId}" 的输入框`);
  assert.equal(typeof node.dispatch, 'function', `${testId} 必须是能派发事件的宿主节点`);
  node.value = value;
  node.dispatch('input');
}

function normalize(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/** 标签页按钮：文本以 `label` 开头（button 里是 `<span>label</span><small>note</small>`）。 */
function switchTab(container, label) {
  const tab = findBy(container, (node) => node.kind === 'button' && textOf(node).startsWith(label));
  assert.ok(tab !== null, `找不到标签页按钮：${label}`);
  click(tab);
}

/** 回执面板 = `WriteReceipt.vue` 里带 `receipt` class 的那个 `<section>`（组件没有 data-testid，按 class 认）。 */
function receiptPanel(container) {
  return findBy(container, (node) => node.kind === 'section' && String(node.props.class ?? '').split(/\s+/).includes('receipt'));
}

/** 写成功后的结果摘要横幅。 */
function outcomeBanner(container) {
  return findBy(container, byTestId('administrator-state-ok'));
}

/** 管理员目录列表的读请求次数（`GET /admin/administrators`）。 */
function administratorsReads(fetchImpl) {
  return fetchImpl.calls.filter((call) => {
    const path = String(call.url).split('?')[0];
    return path === '/api/v1/admin/administrators' && (call.init?.method ?? 'GET') === 'GET';
  }).length;
}

/** 挂真 App：`__GY_TEST_SESSION__` 供桩用，`fetch` 换成记录桩。 */
async function mountConsole() {
  globalThis.__GY_TEST_SESSION__ = SESSION;
  const fetchImpl = consoleFetch();
  const restoreFetch = withFetch(fetchImpl);
  const component = (await import(await compileVue(APP_URL))).default;
  const { app, container } = await mountComponent(component);
  return {
    app,
    container,
    fetchImpl,
    close() {
      app.unmount();
      restoreFetch();
      delete globalThis.__GY_TEST_SESSION__;
    },
  };
}

/** 走到管理员页 → 停用 ops-root → 拿到回执（返回本页的读请求次数，供「不多发请求」对比）。 */
async function disableFirstAdministrator(container) {
  switchTab(container, ADMINISTRATORS_TAB);
  await settle();
  const disable = findBy(container, byTestId('administrator-disable'));
  assert.ok(disable !== null, '前置：管理员页必须渲染出「停用」入口（列表已读到一行 active）');
  click(disable);
  await settle();
  typeIntoModel(container, 'administrator-state-reason', '违反管理员操作规范');
  const submit = findBy(container, byTestId('administrator-state-submit'));
  assert.ok(submit !== null, '前置：确认框必须渲染出提交按钮');
  click(submit);
  await settle();
  assert.ok(receiptPanel(container) !== null, '前置：写完之后本页必须已经渲染回执');
  assert.ok(outcomeBanner(container) !== null, '前置：写成功必须同时给出结果摘要');
}

test('渲染：管理员页拿到写回执后切走再切回，回执与结果摘要仍在，且还是同一条', async () => {
  const mounted = await mountConsole();
  try {
    const { container } = mounted;
    await disableFirstAdministrator(container);
    const before = normalize(textOf(receiptPanel(container)));
    assert.match(before, /写操作成功回执/, '前置：changed:true 的写必须写成「成功回执」');
    assert.match(before, new RegExp(REQUEST_ID), '前置：回执里必须带这次写的 request_id（审计关联键）');

    // 切走：当前页换成作业台，管理员页应当离场（缓存起来，但不在树上）
    switchTab(container, OTHER_TAB);
    await settle();
    assert.equal(receiptPanel(container), null, '切走之后管理员页不在树上，回执不应该还挂在当前文档里');

    // 切回：同一个页面实例回来，回执必须还在
    switchTab(container, ADMINISTRATORS_TAB);
    await settle();
    const after = receiptPanel(container);
    assert.ok(after !== null, '切走再切回之后，最近一条写回执必须仍然可见（R68-B10 的缺陷形态：回执随卸载消失）');
    assert.equal(
      normalize(textOf(after)),
      before,
      '切回来看到的必须还是刚才那一条回执（同一个 request_id / 同一个 HTTP 结果），不是重挂载后重写出来的',
    );
    const banner = outcomeBanner(container);
    assert.ok(banner !== null, '结果摘要（改成了什么、revision 从几到几）也必须跟着回执一起留在页面上');
    assert.match(normalize(textOf(banner)), /已停用 ops-root/, '结果摘要必须还是刚才那次停用的结论');
  } finally {
    mounted.close();
  }
});

test('硬条件：切走再切回不得多发一次读请求（GET /admin/administrators 只许不变或更少）', async () => {
  const mounted = await mountConsole();
  try {
    const { container, fetchImpl } = mounted;
    await disableFirstAdministrator(container);
    const readsAfterWrite = administratorsReads(fetchImpl);
    assert.ok(readsAfterWrite >= 1, '前置：写成功后页面会刷新一次目录，至少有一次读');

    switchTab(container, OTHER_TAB);
    await settle();
    switchTab(container, ADMINISTRATORS_TAB);
    await settle();
    const readsAfterRoundTrip = administratorsReads(fetchImpl);
    assert.ok(
      readsAfterRoundTrip <= readsAfterWrite,
      `切回管理员页不得再拉一次第一页：写后是 ${readsAfterWrite} 次读，切走再切回变成了 ${readsAfterRoundTrip} 次`
        + '（页面实例被缓存后不该重跑 onMounted）',
    );
  } finally {
    mounted.close();
  }
});

/** 切页链上的 10 个页面（顺序同 App.vue，改页面就该改这里）。 */
const PAGE_VIEWS = [
  'AccountsView',
  'ContentAdminView',
  'FlagsView',
  'FlagAuditView',
  'AuditEventsView',
  'AuditLogsView',
  'AdministratorsView',
  'JobsView',
  'ModerationQueueView',
  'ReviewPlaceholderView',
];

/**
 * 剥掉 HTML 注释再扫模板。
 * 原来这条钉子是 `source.indexOf('<KeepAlive')` 的子串命中 —— 命中的其实是解释性注释里的
 * `<KeepAlive>`，于是「注释里写 `<KeepAlive :max="tabs.length">`、真实标签写成别的」能骗过它。
 */
function stripHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/** 开标签：`<KeepAlive …>` 与 kebab 写法 `<keep-alive …>` 等价；属性值里允许出现 `>`，整体允许跨行。 */
const KEEP_ALIVE_OPEN = /<(keep-alive|KeepAlive)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/;

/** 粗解析开标签属性表：容忍任意属性顺序、额外属性、单双引号与跨行。 */
function parseAttributes(text) {
  const attrs = new Map();
  for (const match of text.matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    attrs.set(match[1].toLowerCase(), (match[2] ?? match[3] ?? match[4] ?? '').trim());
  }
  return attrs;
}

/** `max` 的等价写法：`:max`、`v-bind:max`（值必须是 `tabs.length`，即「一页一份」）。 */
function hasTabCountMax(attrs) {
  return ['max', ':max', 'v-bind:max'].some((key) => attrs.get(key) === 'tabs.length');
}

/** 在（已剥注释的）模板里找真实 `<KeepAlive>` 开标签与配对结束标签。 */
function findKeepAlive(html) {
  const match = KEEP_ALIVE_OPEN.exec(html);
  if (match === null) return null;
  const innerStart = match.index + match[0].length;
  const close = /<\/(?:keep-alive|KeepAlive)\s*>/i.exec(html.slice(innerStart));
  return {
    name: match[1],
    attrs: parseAttributes(match[2]),
    raw: match[0],
    inner: close === null ? null : html.slice(innerStart, innerStart + close.index),
  };
}

test('结构钉子：App.vue 的切页链必须整体包在 <KeepAlive> 里，且不许用 v-show 常挂', () => {
  // 0) 钉子自查：解析器必须认得四种等价写法（`:max` / `v-bind:max` / kebab / 多属性跨行），
  //    且注释里的 `<KeepAlive>` 不算真实标签 —— 否则这颗钉子自己就会假绿／误红。
  for (const spelling of [
    '<KeepAlive :max="tabs.length">',
    '<keep-alive :max="tabs.length">',
    '<KeepAlive v-bind:max="tabs.length" include="AccountsView">',
    "<keep-alive\n  include=\"AccountsView,JobsView\"\n  v-bind:max='tabs.length'\n>",
  ]) {
    const parsed = findKeepAlive(`${spelling}<AccountsView /></keep-alive>`);
    assert.ok(parsed !== null, `钉子自查：认不出这种写法 ${JSON.stringify(spelling)}`);
    assert.ok(hasTabCountMax(parsed.attrs), `钉子自查：${JSON.stringify(spelling)} 的 max 绑定没认出来`);
    assert.match(parsed.inner, /<AccountsView[\s/>]/, `钉子自查：${JSON.stringify(spelling)} 的内容区间没框住子组件`);
  }
  assert.equal(
    findKeepAlive(stripHtmlComments('<!-- <KeepAlive :max="tabs.length"> -->')),
    null,
    '钉子自查：注释里的 <KeepAlive> 不算真实标签',
  );

  // 1) 真实模板（剥注释后）必须有一个 `<KeepAlive>`，`:max` 绑到 `tabs.length`，且有配对结束标签
  const source = readFileSync(fileURLToPath(APP_URL), 'utf8');
  const templateStart = source.indexOf('<template>');
  const templateEnd = source.indexOf('</template>');
  assert.ok(templateStart !== -1 && templateEnd > templateStart, 'App.vue 必须有 <template> 块');
  const template = stripHtmlComments(source.slice(templateStart, templateEnd));

  const keepAlive = findKeepAlive(template);
  assert.ok(keepAlive !== null, 'App.vue 的切页链必须被 <KeepAlive> 包住（否则切页就卸载，写回执必丢）');
  assert.ok(keepAlive.inner !== null, '<KeepAlive> 必须有配对的结束标签');
  assert.ok(
    hasTabCountMax(keepAlive.attrs),
    `缓存上限必须钉成标签页数量（:max="tabs.length"），实际开标签是 ${JSON.stringify(keepAlive.raw)}`,
  );

  // 2) 10 个页面一个都不许露在缓存外
  for (const view of PAGE_VIEWS) {
    assert.match(keepAlive.inner, new RegExp(`<${view}[\\s/>]`), `${view} 必须留在 <KeepAlive> 里面：切页链不许有一支露在缓存外`);
  }

  // 3) `tabs` 必须还是 const 数组字面量：`:max` 绑的是它的长度，将来按角色过滤 tabs 时长度会变，
  //    那时这条钉子会先红，缺陷不会悄悄挪到边缘。
  assert.match(source, /const tabs\b[^\n]*=\s*\[/, '`tabs` 必须是 const 数组字面量（`:max` 绑它的长度）');

  // 4) 不许用 v-show 常挂（容忍 `v-show = "x"` 这种带空白的写法）
  assert.doesNotMatch(template, /\bv-show\s*=/, '⛔ 不许用 v-show 常挂：那会让 10 个页面同时存在、同时拉数据');
});
