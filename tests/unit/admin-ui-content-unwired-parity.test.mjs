/**
 * 渲染级用例：**五族内容页**共用同一个「503 fail-closed ⇒ 服务端未接线」口径（R67-B03）。
 *
 * 审计缺陷（R67-B03）：`describeFamilyView` 只在注册／限制两页用，其余三族（资料来源／科普内容／
 * 分类）走裸 `describeFamily`。real 装配、无库池时服务端 fail-closed 回
 * `503 PROVIDER_UNAVAILABLE`，后三页显示「读取失败」+ 原始码 + 一个**必然失败**的「重试」，
 * 前两页显示「服务端未接线（HTTP 503 · fail-closed）」并明确「这不是没有数据」。
 * 同一个服务端状态在五族里有两种说法，且后三族把「未接线」误报成「读取失败」。
 *
 * 断言口径（逐条对应派单要求）：
 *  - `503` + 服务端 `retryable:false` ⇒ 五族都写「服务端未接线（HTTP 503 · fail-closed）」；
 *  - 必须明确「这不是没有数据」（不得说成「接口返回 0 行」，也不得说成「读取失败」）；
 *  - `canRetry` 必须为 false（重试必然还是 503）⇒ status 区里**没有**「重试」按钮；
 *  - 非空对照：同一个 503 若服务端写 `retryable:true`，五族都必须**有**「重试」按钮
 *    （证明上面的「没有按钮」不是空断言，而是由 `canRetry` 驱动）。
 *
 * 夹具见 `tests/unit/admin-ui-sfc-harness.mjs`；范式同 `admin-ui-registration-render.test.mjs:115`。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  errorEnvelope,
  fakeFetch,
  findBy,
  jsonResponse,
  loadComponent,
  mountComponent,
  textOf,
  withFetch,
} from './admin-ui-sfc-harness.mjs';

const BASE_URL = '/api/v1';
const TOKEN = 'synthetic-admin-token';
const SCOPES = ['sources:read', 'sources:write', 'audit:read'];

/** 五族内容页：`file` 用于挂载，`source` 用于结构性钉子（同一路径，分开写便于阅读）。 */
const FAMILIES = [
  { label: '资料来源', file: '../../apps/admin/src/views/SourcesView.vue' },
  { label: '科普内容', file: '../../apps/admin/src/views/KnowledgeAdminView.vue' },
  { label: '分类', file: '../../apps/admin/src/views/CategoriesView.vue' },
  { label: '注册登记', file: '../../apps/admin/src/views/RegistrationAdminView.vue' },
  { label: '使用限制', file: '../../apps/admin/src/views/RestrictionAdminView.vue' },
];

/** 503 fail-closed 的真实响应（`real` 装配、无库池）。 */
const unwiredResponse = (retryable) =>
  jsonResponse(
    503,
    errorEnvelope('PROVIDER_UNAVAILABLE', 'real 模式未接真实持久后端：后台业务不可用', retryable, 'real'),
  );

/**
 * 列表状态区：五族都渲染**恰好一个**静态 `class="status"` 的列表区块。
 *
 * 为什么不再用 `role="status"` 去找它：#673（`9cdfcbf4`）把这五页同一个 `.status` 容器改成了
 * `:role="view.tone === 'error' ? 'alert' : 'status'"` ⇒ 503 错误态下该容器的 role 是 **`alert`**，
 * 旧选择器 `node.props.role === 'status'` 取到 `null`（不是「页面没有状态区」，是选择器过时）。
 * 现在按**静态类**定位（夹具的 `patchProp` 把 Vue 归一化后的 class 落在 `node.props.class`，形如
 * `status error`），再**由 tone 推 role**：`tone === 'error'` ⇒ `role="alert"`，其余 ⇒ `role="status"`。
 * 刻意不拿 role 反推 role —— 那是循环论证，改坏模板也会跟着一起绿。
 * （注册／限制另有 `role="alert"` 的失败横幅，是 `view.phase !== 'unwired'` 时的另一支，不是本用例的对象。）
 */
function classTokens(node) {
  const value = node.props.class;
  if (typeof value !== 'string') return [];
  return value.split(/\s+/).filter((token) => token !== '');
}

function requireStatusRegion(container, label) {
  const region = findBy(container, (node) => classTokens(node).includes('status'));
  assert.notEqual(region, null, `${label}：每族都必须有 class="status" 的列表状态区`);
  const tone = classTokens(region).filter((token) => token !== 'status')[0];
  assert.equal(typeof tone, 'string', `${label}：列表状态区必须带 tone（class 里除 status 之外的那一枚）`);
  const expectedRole = tone === 'error' ? 'alert' : 'status';
  assert.equal(
    region.props.role,
    expectedRole,
    `${label}：列表状态区 tone=${tone} 时 role 必须是 ${expectedRole}`,
  );
  if (tone === 'error') {
    // 反向自证：旧选择器（role="status"）在错误态下**取不到**这个容器，所以它必须改。
    assert.equal(
      findBy(container, (node) => node.props.role === 'status'),
      null,
      `${label}：tone=error 时旧选择器 role="status" 应当一无所获（这正是本用例要修的过时选择器）`,
    );
  }
  return region;
}

async function mountView(relativePath) {
  const component = await loadComponent(relativePath);
  return mountComponent(component, { baseUrl: BASE_URL, token: TOKEN, scopes: SCOPES });
}

test('五族内容页：503 + retryable:false ⇒ 统一说「服务端未接线（HTTP 503 · fail-closed）」，且不给重试', async () => {
  for (const family of FAMILIES) {
    const fetchImpl = fakeFetch(() => unwiredResponse(false));
    const restore = withFetch(fetchImpl);
    const { app, container } = await mountView(family.file);
    try {
      assert.equal(fetchImpl.calls.length, 1, `${family.label}：503 之后不得自动重试`);

      const status = requireStatusRegion(container, family.label);
      const statusText = textOf(status);

      assert.match(statusText, /服务端未接线/, `${family.label}：503 fail-closed 必须说「服务端未接线」`);
      assert.match(statusText, /HTTP 503/, `${family.label}：必须写明 HTTP 503`);
      assert.match(statusText, /fail-closed/, `${family.label}：必须写明 fail-closed`);
      assert.match(statusText, /PROVIDER_UNAVAILABLE/, `${family.label}：必须带原始错误码`);
      assert.match(statusText, /这不是「没有数据」/, `${family.label}：必须明确「不是没有数据」`);
      assert.doesNotMatch(statusText, /读取失败/, `${family.label}：未接线不得报成「读取失败」`);
      assert.doesNotMatch(statusText, /接口返回 0 行/, `${family.label}：未接线绝不能被说成「0 行」`);

      assert.equal(
        findBy(status, (node) => node.kind === 'button'),
        null,
        `${family.label}：retryable:false 时不给重试按钮（重试还是 503）`,
      );
    } finally {
      restore();
      app.unmount();
    }
  }
});

test('五族内容页：同一个 503 若服务端写 retryable:true ⇒ 五族都保留「重试」按钮（非空对照）', async () => {
  for (const family of FAMILIES) {
    const fetchImpl = fakeFetch(() => unwiredResponse(true));
    const restore = withFetch(fetchImpl);
    const { app, container } = await mountView(family.file);
    try {
      const status = requireStatusRegion(container, family.label);
      assert.match(textOf(status), /服务端未接线/, `${family.label}：文案口径与 retryable 无关`);
      const retry = findBy(status, (node) => node.kind === 'button');
      assert.notEqual(retry, null, `${family.label}：retryable:true 时必须给重试按钮`);
      assert.match(textOf(retry), /重试/);
    } finally {
      restore();
      app.unmount();
    }
  }
});

test('结构性钉子：五族都走 describeFamilyView，且没有一页再调裸 describeFamily', () => {
  const sources = FAMILIES.map((family) => ({
    label: family.label,
    source: readFileSync(new URL(family.file, import.meta.url), 'utf8'),
  }));

  const importPattern = /import\s*{[^}]*\bdescribeFamilyView\b[^}]*}\s*from\s*'\.\.\/lib\/admin-content-view-model\.mjs';/;
  for (const { label, source } of sources) {
    // 用 `.test()` 而不是 `assert.match()`：失败时不要把整个 SFC 源码倒进输出。
    assert.ok(importPattern.test(source), `${label}：必须从 admin-content-view-model.mjs import describeFamilyView`);
    assert.ok(/\bdescribeFamilyView\(/.test(source), `${label}：必须调用 describeFamilyView(`);
    assert.ok(!/\bdescribeFamily\(/.test(source), `${label}：不得再调裸 describeFamily(`);
  }
});

test('结构性钉子：唯一入口 describeFamilyView 仍导出，「其余三族保持原口径」的分叉注释已删', () => {
  const moduleSource = readFileSync(
    new URL('../../apps/admin/src/lib/admin-content-view-model.mjs', import.meta.url),
    'utf8',
  );
  assert.match(moduleSource, /export function describeFamilyView\(/, 'describeFamilyView 必须仍导出');
  assert.doesNotMatch(
    moduleSource,
    /其余三族保持原口径/,
    '不得再保留「注册／限制两页用这个包装，其余三族保持原口径」这种分叉说法',
  );
});
