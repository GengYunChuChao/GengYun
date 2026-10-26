/**
 * 页面级渲染用例：`CategoriesView.vue` 的写回执必须区分「真变更」与「服务端幂等短路」。
 *
 * 为什么本文件只有 edit 两条：分类族的契约里**只有** `GET /admin/categories` 与
 * `PATCH /admin/categories/{id}`（`apps/admin/src/views/CategoriesView.vue:5-10` 列的就是全部六个操作
 * 里的这两个），没有 create／publish／withdraw，所以「发布 no-op」这一条在分类页不存在，
 * 也不能造一个不存在的 API 来凑用例。三值只剩 edit 的 revision 比较这一条路：
 *  - revision 前进（3 → 4）⇒「写操作成功回执」＋「成功（HTTP 200）」；
 *  - revision 没前进（重放旧 revision）⇒「本次未产生变更」，整块不含「成功」。
 *
 * 另一条边界：`Category` 没有 `changed` 字段，若两侧 revision 缺一，`deriveChanged()` 只会给
 * `null`（「已受理」）；但 `validateCategory` 强制 `revision` 是 ≥1 的整数、页面又只在列表行
 * 有 revision 时才进编辑态，所以页面上到不了 `'unknown'`——这条由 `deriveChanged` 的纯函数用例覆盖。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clickNode,
  envelope,
  fakeFetch,
  findBy,
  findAll,
  jsonResponse,
  loadComponent,
  mountComponent,
  settle,
  textOf,
  withFetch,
} from './admin-ui-sfc-harness.mjs';

const BASE_URL = '/api/v1';
const CATEGORY_ID = 'crop-rice';

/** 一份通过 `validateCategory` 的分类行夹具（列表与 PATCH 出参同构）。 */
function category(overrides = {}) {
  return {
    id: CATEGORY_ID,
    revision: 3,
    type: 'crop',
    name: '水稻',
    description: '禾本科稻属，用于条件匹配。',
    active: true,
    ...overrides,
  };
}

function classify(url, method) {
  const path = String(url).split('?')[0];
  if (/\/admin\/categories\/[^/]+$/.test(path)) return method === 'PATCH' ? 'edit' : 'detail';
  if (/\/admin\/categories$/.test(path)) return 'list';
  return 'unknown';
}

function receiptPanel(container) {
  return findBy(container, (node) => node.kind === 'section' && String(node.props.class ?? '').split(/\s+/).includes('receipt'));
}

function panelText(container) {
  const panel = receiptPanel(container);
  assert.ok(panel !== null, '回执面板必须渲染（写操作已结算）');
  return textOf(panel);
}

function headingOf(container) {
  const panel = receiptPanel(container);
  assert.ok(panel !== null, '回执面板必须渲染');
  const heading = findBy(panel, (node) => node.kind === 'h4');
  assert.ok(heading !== null, '回执面板必须有标题 h4');
  return textOf(heading);
}

function submitOnlyForm(container) {
  const forms = findAll(container, (node) => node.kind === 'form' && typeof node.props.onSubmit === 'function');
  assert.equal(forms.length, 1, '此刻应当只有一张可提交的表单');
  forms[0].props.onSubmit({ preventDefault() {} });
}

function callsOf(fetchImpl, kind, method) {
  return fetchImpl.calls.filter((call) => classify(call.url, call.init?.method ?? 'GET') === kind && (method === undefined || call.init?.method === method));
}

async function mountView() {
  const component = await loadComponent('../../apps/admin/src/views/CategoriesView.vue');
  return mountComponent(component, { baseUrl: BASE_URL, token: 'synthetic-admin-token', scopes: ['sources:read', 'sources:write'] });
}

/** 列表返回一行；写操作交给 `onWrite`。契约没有 `GET /admin/categories/{id}`，详情来自列表行。 */
function listFetch(onWrite) {
  return fakeFetch(({ url, init }) => {
    const method = init?.method ?? 'GET';
    const kind = classify(url, method);
    if (kind === 'list') return jsonResponse(200, envelope({ items: [category()], next_cursor: null }));
    return onWrite(kind, { url, init, method });
  });
}

/** 点列表行即进入编辑态（`select()`）；表单由 `categoryFormFromDetail()` 整份回填。 */
async function openEdit(container) {
  const row = findBy(container, (node) => node.kind === 'tr' && typeof node.props.onClick === 'function');
  assert.ok(row !== null, '列表必须渲染出可点的行');
  clickNode(row);
  await settle();
}

test('分类编辑且 revision 前进 ⇒ 回执写「写操作成功回执」＋「成功（HTTP 200）」', async () => {
  const fetchImpl = listFetch((kind) => {
    if (kind !== 'edit') throw new Error(`意外的请求：${kind}`);
    return jsonResponse(200, envelope(category({ revision: 4, name: '水稻（含粳稻）' })), { etag: '"4"' });
  });
  const restore = withFetch(fetchImpl);
  const { app, container } = await mountView();
  try {
    await openEdit(container);
    submitOnlyForm(container);
    await settle();

    const editCalls = callsOf(fetchImpl, 'edit', 'PATCH');
    assert.equal(editCalls.length, 1, '必须真的发出一次 PATCH');
    assert.equal(
      editCalls[0].init.headers['if-match'],
      '"3"',
      'If-Match 必须是这次编辑**所基于**的 revision（列表行读到的 3），不是响应回传的 4',
    );

    assert.equal(headingOf(container), '写操作成功回执');
    assert.match(panelText(container), /结果成功（HTTP 200）/);
    assert.doesNotMatch(panelText(container), /本次未产生变更/);
  } finally {
    restore();
    app.unmount();
  }
});

test('分类编辑但 revision 没前进（重放旧 revision）⇒ 回执写「本次未产生变更」，不写「成功」', async () => {
  const fetchImpl = listFetch((kind) => {
    if (kind !== 'edit') throw new Error(`意外的请求：${kind}`);
    return jsonResponse(200, envelope(category({ revision: 3 })), { etag: '"3"' });
  });
  const restore = withFetch(fetchImpl);
  const { app, container } = await mountView();
  try {
    await openEdit(container);
    submitOnlyForm(container);
    await settle();

    assert.equal(callsOf(fetchImpl, 'edit', 'PATCH').length, 1, '必须真的发出一次 PATCH');
    const heading = headingOf(container);
    assert.match(heading, /本次未产生变更/);
    assert.doesNotMatch(heading, /成功/);
    assert.match(panelText(container), /结果已受理（HTTP 200 · 本次未产生变更）/);
    assert.doesNotMatch(textOf(container), /写操作成功回执/);
  } finally {
    restore();
    app.unmount();
  }
});
