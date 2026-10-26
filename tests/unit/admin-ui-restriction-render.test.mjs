/**
 * 渲染级用例：`RestrictionAdminView.vue` 的**真实 SFC 呈现路径**。
 *
 * 与 `admin-ui-registration-render.test.mjs` 同一套夹具（`tests/unit/admin-ui-sfc-harness.mjs`），
 * 本文件额外钉住限制资料族**独有**的模板结论：
 *  - `conditions` 在契约里不可为 null ⇒ 表单上 `crop_id`／`region_code` 是必填，`region_code` 必须是 `^33[0-9]{4}$`；
 *  - `effect` 是**下拉闭集**（prohibited／restricted／unknown），页面不提供闭集外的选项；
 *  - `formulation_id` 留空 ⇒ 请求体里是 `null` 而不是空串。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  byTestId,
  chooseOption,
  clickNode,
  envelope,
  errorEnvelope,
  fakeFetch,
  findBy,
  findAll,
  jsonResponse,
  loadComponent,
  mountComponent,
  requireTestId,
  settle,
  submitForm,
  textOf,
  typeInto,
  withFetch,
} from './admin-ui-sfc-harness.mjs';

const BASE_URL = '/api/v1';
const TOKEN = 'synthetic-admin-token';
const ID = '00000000-0000-4000-8000-0000000000bb';
const SOURCE_ID = '00000000-0000-4000-8000-000000000002';
const SCOPES = ['sources:read', 'sources:write'];

const RESTRICTION = {
  id: ID,
  revision: 3,
  review_status: 'verified',
  content: {
    source_id: SOURCE_ID,
    source_version: '2026.1',
    formulation_id: null,
    conditions: { crop_id: 'rice', region_code: '330100' },
    effect: 'restricted',
    reason: '水稻田抽穗期禁用，避免药害',
    valid_from: '2026-01-02T03:04:05.000Z',
    valid_to: null,
  },
};

const viewComponent = () => loadComponent('../../apps/admin/src/views/RestrictionAdminView.vue');

async function mountView({ scopes = SCOPES } = {}) {
  const component = await viewComponent();
  return mountComponent(component, { baseUrl: BASE_URL, token: TOKEN, scopes });
}

function findRow(container) {
  return findBy(container, (node) => node.kind === 'tr' && typeof node.props.onClick === 'function');
}

test('渲染：页头写明 6 个 operationId 与 scope；空页说「接口返回 0 行」；effect 下拉只有契约闭集三值', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, envelope({ items: [], next_cursor: null })));
  const restore = withFetch(fetchImpl);
  const { app, container } = await mountView();
  try {
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, `${BASE_URL}/admin/restrictions?limit=20`);
    assert.equal(fetchImpl.calls[0].init.method, 'GET');

    const pageText = textOf(container);
    for (const operationId of [
      'listAdminRestriction',
      'createRestrictionDraft',
      'editRestrictionDraft',
      'publishRestriction',
      'withdrawRestriction',
      'getAdminRestriction',
    ]) {
      assert.match(pageText, new RegExp(operationId), `页头必须写出 ${operationId}`);
    }
    assert.match(pageText, /sources:read/);
    assert.match(pageText, /sources:write/);
    assert.match(pageText, /conditions 不可为 null/);

    assert.match(textOf(requireTestId(container, 'family-status')), /接口返回 0 行/);
    assert.equal(findBy(container, byTestId('rows')), null);

    // 打开新建表单后：effect 必须是三值闭集，且 region_code 有必填标记。
    clickNode(requireTestId(container, 'create'));
    await settle();
    const select = requireTestId(container, 'field-effect');
    assert.equal(select.kind, 'select', 'effect 必须是下拉（闭集）');
    const optionValues = findAll(select, (node) => node.kind === 'option').map((node) => node.props.value);
    assert.deepEqual(optionValues, ['prohibited', 'restricted', 'unknown'], '不得出现契约闭集外的选项');
    assert.match(textOf(container), /Conditions 的 required/);
    assert.match(textOf(container), /\^33\[0-9\]\{4\}\$/);
  } finally {
    restore();
    app.unmount();
  }
});

test('503 未接线 ⇒ 「服务端未接线」横幅，绝不渲染成空列表，且不自动重试', async () => {
  const fetchImpl = fakeFetch(() =>
    jsonResponse(503, errorEnvelope('PROVIDER_UNAVAILABLE', 'real 模式未接真实持久后端：后台业务不可用', false, 'real')),
  );
  const restore = withFetch(fetchImpl);
  const { app, container } = await mountView();
  try {
    assert.equal(fetchImpl.calls.length, 1, '503 之后不得自动重试');
    const statusText = textOf(requireTestId(container, 'family-status'));
    assert.match(statusText, /服务端未接线/);
    assert.match(statusText, /503/);
    assert.match(statusText, /PROVIDER_UNAVAILABLE/);
    assert.doesNotMatch(statusText, /接口返回 0 行/);
    assert.equal(findBy(container, byTestId('rows')), null);
  } finally {
    restore();
    app.unmount();
  }
});

test('缺 scope：无 sources:read ⇒ 不发请求；只有读 scope ⇒ 新建按钮禁用且提示缺 sources:write', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, envelope({ items: [], next_cursor: null })));
  const restore = withFetch(fetchImpl);
  const noRead = await mountView({ scopes: [] });
  try {
    assert.equal(fetchImpl.calls.length, 0);
    assert.match(textOf(requireTestId(noRead.container, 'scope-banner')), /sources:read/);
    assert.equal(requireTestId(noRead.container, 'create').props.disabled, true);
  } finally {
    noRead.app.unmount();
  }

  const readOnly = await mountView({ scopes: ['sources:read'] });
  try {
    assert.match(textOf(requireTestId(readOnly.container, 'scope-banner')), /sources:write/);
    assert.equal(requireTestId(readOnly.container, 'create').props.disabled, true);
  } finally {
    restore();
    readOnly.app.unmount();
  }
});

test('新建草稿：POST /admin/restrictions，conditions 嵌成对象、formulation_id 留空转 null、带 Idempotency-Key', async () => {
  const fetchImpl = fakeFetch(({ init }) => {
    if (init.method === 'POST') return jsonResponse(201, envelope({ ...RESTRICTION, revision: 1 }), { etag: '"1"' });
    return jsonResponse(200, envelope({ items: [], next_cursor: null }));
  });
  const restore = withFetch(fetchImpl);
  const { app, container } = await mountView();
  try {
    clickNode(requireTestId(container, 'create'));
    await settle();

    typeInto(container, 'field-source_id', SOURCE_ID);
    typeInto(container, 'field-source_version', '2026.1');
    chooseOption(container, 'field-effect', 'prohibited');
    typeInto(container, 'field-reason', '水稻田抽穗期禁用，避免药害');
    typeInto(container, 'field-valid_from', '2026-01-02T03:04');
    typeInto(container, 'field-crop_id', 'rice');
    typeInto(container, 'field-region_code', '330100');
    typeInto(container, 'field-species_id', 'barnyardgrass');
    await settle();

    submitForm(container, 'restriction-form');
    await settle();

    const posts = fetchImpl.calls.filter((call) => call.init.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, `${BASE_URL}/admin/restrictions`);
    assert.match(posts[0].init.headers['idempotency-key'], /^admin-content-/);
    assert.equal('if-match' in posts[0].init.headers, false);
    assert.deepEqual(JSON.parse(posts[0].init.body), {
      source_id: SOURCE_ID,
      source_version: '2026.1',
      formulation_id: null,
      conditions: { crop_id: 'rice', region_code: '330100', species_id: 'barnyardgrass' },
      effect: 'prohibited',
      reason: '水稻田抽穗期禁用，避免药害',
      valid_from: new Date('2026-01-02T03:04').toISOString(),
      valid_to: null,
    });
    assert.match(textOf(requireTestId(container, 'outcome')), /服务端已创建并返回限制资料草稿/);

    // R1（本族同样要钉）：新建成功后必须**同时选中**新对象，详情面板与选中态一致。
    assert.ok(findBy(container, byTestId('start-edit')) !== null, '新建成功后详情面板必须显示（含「编辑草稿」入口）');
    const selectedRows = findAll(
      container,
      (node) => node.kind === 'tr' && typeof node.props.onClick === 'function' && String(node.props.class ?? '').split(/\s+/).includes('selected'),
    );
    assert.equal(selectedRows.length, 1, '新建成功后新对象必须是唯一被选中的行');
    assert.ok(textOf(container).includes(ID), '详情面板必须显示新对象的 id');
    assert.equal(String(selectedRows[0].props.class ?? '').includes('selected'), true, '列表行与详情面板的选中态必须一致');

    // 守卫钉子：`startEdit` 必须**同时**要求 selectedId 与 detail（新建即选中后该非法路径已不可达，
    // 故按源码级钉住，防止守卫被退回「只看 detail !== null」）。
    const sfc = readFileSync(new URL('../../apps/admin/src/views/RestrictionAdminView.vue', import.meta.url), 'utf8');
    assert.match(
      sfc,
      /function startEdit\(\)\s*\{[\s\S]{0,600}?state\.value\.selectedId === null \|\| state\.value\.detail === null/,
      'startEdit 必须拒绝编辑「未被选中」的对象（只判 detail 不足以说明 If-Match 来自哪一行）',
    );
  } finally {
    restore();
    app.unmount();
  }
});

test('详情 → 撤回：POST …/{id}/withdraw 带 If-Match "3"；200 带 changed:false（内存幂等短路）⇒ 整页写「未改动」不写「撤回成功」', async () => {
  const fetchImpl = fakeFetch(({ url, init }) => {
    if (init.method === 'POST' && url.endsWith('/withdraw')) return jsonResponse(200, envelope({ ...RESTRICTION, changed: false }), { etag: '"3"' });
    if (url === `${BASE_URL}/admin/restrictions/${ID}`) return jsonResponse(200, envelope(RESTRICTION), { etag: '"3"' });
    return jsonResponse(200, envelope({ items: [RESTRICTION], next_cursor: null }));
  });
  const restore = withFetch(fetchImpl);
  const { app, container } = await mountView();
  try {
    const row = findRow(container);
    assert.ok(row !== null);
    assert.match(textOf(row), /限用/);
    assert.match(textOf(row), /rice \/ 330100/);
    clickNode(row);
    await settle();

    // R3：详情读取（getAdminRestriction）直接钉 URL + method，不只靠详情文本间接覆盖。
    const detailCall = fetchImpl.calls.find((call) => call.url === `${BASE_URL}/admin/restrictions/${ID}`);
    assert.ok(detailCall !== undefined, '选行必须真的发 GET /admin/restrictions/{id}');
    assert.equal(detailCall.init.method, 'GET', '详情读取必须是 GET');
    assert.equal(detailCall.url.includes(ID), true, '详情 URL 必须带被选中的 id');

    const detailText = textOf(container);
    assert.match(detailText, /conditions/);
    assert.match(detailText, /crop_id=rice/);
    assert.match(detailText, /读面未提供：可见性 visibility/);

    clickNode(requireTestId(container, 'open-withdraw'));
    await settle();
    typeInto(container, 'field-reason', '限制已解除');
    await settle();
    submitForm(container, 'withdraw-form');
    await settle();

    const withdrawCall = fetchImpl.calls.find((call) => call.url.endsWith('/withdraw'));
    assert.ok(withdrawCall !== undefined);
    assert.equal(withdrawCall.url, `${BASE_URL}/admin/restrictions/${ID}/withdraw`);
    assert.equal(withdrawCall.init.headers['if-match'], '"3"');
    assert.deepEqual(JSON.parse(withdrawCall.init.body), { reason: '限制已解除' });

    // 契约真值 changed:false ⇒ outcome 写「未改动」，不写「撤回成功」。
    const outcomeText = textOf(requireTestId(container, 'outcome'));
    assert.match(outcomeText, /服务端未改动状态/);
    assert.match(outcomeText, /未改动（changed:false/);
    assert.match(outcomeText, /已是该状态/);
    assert.doesNotMatch(outcomeText, /撤回成功|已成功/);

    // B1（整页级）：changed:false 时写回执面板与 outcome 必须同一结论，整页不得出现「成功回执／结果 成功」。
    const pageText = textOf(container);
    assert.doesNotMatch(pageText, /成功回执|结果\s*成功/, 'changed:false ⇒ 整页都不得出现「成功回执／结果 成功」');
    assert.match(pageText, /写操作已受理回执（本次未产生变更）/, '写回执面板标题必须点明本次未产生变更');
    assert.match(pageText, /已受理（HTTP 200 · 本次未产生变更）/, '写回执的结果行必须写「已受理…本次未产生变更」');
  } finally {
    restore();
    app.unmount();
  }
});

test('详情 → 撤回：回执 changed:true（真迁移）⇒ 文案写「已撤回／已改动」，此时才出现「成功回执」', async () => {
  const fetchImpl = fakeFetch(({ url, init }) => {
    if (init.method === 'POST' && url.endsWith('/withdraw')) return jsonResponse(200, envelope({ ...RESTRICTION, changed: true }), { etag: '"3"' });
    if (url === `${BASE_URL}/admin/restrictions/${ID}`) return jsonResponse(200, envelope(RESTRICTION), { etag: '"3"' });
    return jsonResponse(200, envelope({ items: [RESTRICTION], next_cursor: null }));
  });
  const restore = withFetch(fetchImpl);
  const { app, container } = await mountView();
  try {
    clickNode(findRow(container));
    await settle();
    clickNode(requireTestId(container, 'open-withdraw'));
    await settle();
    typeInto(container, 'field-reason', '限制已解除');
    await settle();
    submitForm(container, 'withdraw-form');
    await settle();

    const outcomeText = textOf(requireTestId(container, 'outcome'));
    assert.match(outcomeText, /服务端已撤回/);
    assert.match(outcomeText, /已改动（changed:true/);

    const pageText = textOf(container);
    assert.match(pageText, /写操作成功回执/, 'changed:true 才允许写「成功回执」');
  } finally {
    restore();
    app.unmount();
  }
});

test('本地校验：region_code 不是 33 开头 ⇒ 页面报错且**一个写请求都不发**（不先发必然 400 的请求）', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, envelope({ items: [], next_cursor: null })));
  const restore = withFetch(fetchImpl);
  const { app, container } = await mountView();
  try {
    clickNode(requireTestId(container, 'create'));
    await settle();
    typeInto(container, 'field-source_id', SOURCE_ID);
    typeInto(container, 'field-source_version', '2026.1');
    typeInto(container, 'field-reason', '理由');
    typeInto(container, 'field-valid_from', '2026-01-02T03:04');
    typeInto(container, 'field-crop_id', 'rice');
    typeInto(container, 'field-region_code', '110100');
    await settle();
    submitForm(container, 'restriction-form');
    await settle();

    assert.equal(fetchImpl.calls.filter((call) => call.init.method === 'POST').length, 0);
    assert.match(textOf(container), /地区码必须是 33 开头的 6 位数字/);
  } finally {
    restore();
    app.unmount();
  }
});
