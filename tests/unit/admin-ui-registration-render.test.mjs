/**
 * 渲染级用例：`RegistrationAdminView.vue` 的**真实 SFC 呈现路径**（不是纯函数复述）。
 *
 * 为什么需要渲染级：`admin-ui-registration-api.test.mjs` 只覆盖 `.mjs` 层，
 * 覆盖不到「按钮到底有没有被禁用」「503 到底有没有上屏而不是渲染成空列表」这几条**模板**结论。
 *
 * 夹具见 `tests/unit/admin-ui-sfc-harness.mjs`（`@vue/compiler-sfc` 编真实 SFC + 内存宿主 +
 * `globalThis.fetch` 桩），与 `admin-ui-post-takedown-render.test.mjs` 的内联版本同源。
 *
 * 断言口径：
 *  - 空页必须是「接口返回 0 行」，**不是**空白；
 *  - 503 `PROVIDER_UNAVAILABLE`（real 未接线）必须是「服务端未接线」横幅，**不得**显示成空列表，
 *    且**不自动重试**（只发一次请求）；
 *  - 缺 scope 只禁用按钮 + 提示，不向前端放行；
 *  - 写操作带 `Idempotency-Key`，PATCH／publish／withdraw 带 `If-Match: "<revision>"`，
 *    成功后文案写「已受理」，**不写「发布成功」**。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  byTestId,
  clickNode,
  envelope,
  errorEnvelope,
  fakeFetch,
  findAll,
  findBy,
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
const ID = '00000000-0000-4000-8000-0000000000aa';
const SOURCE_ID = '00000000-0000-4000-8000-000000000001';
const SCOPES = ['sources:read', 'sources:write'];

const REGISTRATION = {
  id: ID,
  revision: 2,
  review_status: 'unverified',
  content: {
    formulation: {
      registration_number: 'PD20260001',
      producer: '示例农药有限公司',
      dosage_form: '乳油',
      ingredients: [{ name: '稻瘟灵', content_text: '40', unit_text: '%' }],
    },
    source_id: SOURCE_ID,
    source_version: '2026.1',
    registered_name: '40% 稻瘟灵乳油',
    valid_from: '2026-01-02T03:04:05.000Z',
    valid_to: null,
  },
};

const viewComponent = () => loadComponent('../../apps/admin/src/views/RegistrationAdminView.vue');

async function mountView({ scopes = SCOPES } = {}) {
  const component = await viewComponent();
  return mountComponent(component, { baseUrl: BASE_URL, token: TOKEN, scopes });
}

/** 页面上唯一的 `<tr>`（列表行）——用 `onClick` 认，避免依赖 class。 */
function findRow(container) {
  return findBy(container, (node) => node.kind === 'tr' && typeof node.props.onClick === 'function');
}

test('渲染：页头写明 6 个 operationId 与 scope；空页说「接口返回 0 行」而不是空白', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, envelope({ items: [], next_cursor: null })));
  const restore = withFetch(fetchImpl);
  const { app, container } = await mountView();
  try {
    assert.equal(fetchImpl.calls.length, 1, 'onMounted 必须读一次列表');
    assert.equal(fetchImpl.calls[0].url, `${BASE_URL}/admin/registrations?limit=20`);
    assert.equal(fetchImpl.calls[0].init.method, 'GET');

    const pageText = textOf(container);
    for (const operationId of [
      'listAdminRegistration',
      'createRegistrationDraft',
      'editRegistrationDraft',
      'publishRegistration',
      'withdrawRegistration',
    ]) {
      assert.match(pageText, new RegExp(operationId), `页头必须写出 ${operationId}`);
    }
    assert.match(pageText, /sources:read/);
    assert.match(pageText, /sources:write/);
    assert.match(pageText, /Idempotency-Key/);
    assert.match(pageText, /If-Match/);
    // 契约里没有 visibility：页面必须自己写清楚，而不是留个空状态列。
    assert.match(pageText, /没有 visibility/);

    const status = requireTestId(container, 'family-status');
    assert.match(textOf(status), /接口返回 0 行/);
    assert.equal(requireTestId(container, 'create').props.disabled, false, '有写 scope 时新建可用');
    assert.equal(findBy(container, byTestId('rows')), null, '空页不渲染表格');
    assert.equal(findBy(container, byTestId('failure-banner')), null, '空页不是失败态');
  } finally {
    restore();
    app.unmount();
  }
});

test('503 未接线 ⇒ 显示「服务端未接线」横幅，**不得**渲染成空列表，且不自动重试', async () => {
  const fetchImpl = fakeFetch(() =>
    jsonResponse(503, errorEnvelope('PROVIDER_UNAVAILABLE', 'real 模式未接真实持久后端：后台业务不可用', false, 'real')),
  );
  const restore = withFetch(fetchImpl);
  const { app, container } = await mountView();
  try {
    assert.equal(fetchImpl.calls.length, 1, '503 之后不得自动重试');
    const status = requireTestId(container, 'family-status');
    const statusText = textOf(status);
    assert.match(statusText, /服务端未接线/);
    assert.match(statusText, /503/);
    assert.match(statusText, /PROVIDER_UNAVAILABLE/);
    assert.doesNotMatch(statusText, /接口返回 0 行/, '503 绝不能被说成「0 行」');
    assert.equal(findBy(container, byTestId('rows')), null);
    // retryable:false ⇒ 不给「重试」按钮（重试还是 503）。
    assert.equal(findBy(status, (node) => node.kind === 'button'), null, 'retryable:false 时不给重试按钮');
  } finally {
    restore();
    app.unmount();
  }
});

test('缺 scope：无 sources:read ⇒ 不发列表请求 + 顶部提示；只有读 scope ⇒ 新建按钮禁用', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, envelope({ items: [], next_cursor: null })));
  const restore = withFetch(fetchImpl);
  const noRead = await mountView({ scopes: ['audit:read'] });
  try {
    assert.equal(fetchImpl.calls.length, 0, '缺读 scope 时不得发列表请求（服务端会 403）');
    const banner = requireTestId(noRead.container, 'scope-banner');
    assert.match(textOf(banner), /sources:read/);
    assert.match(textOf(banner), /SCOPE_DENIED/);
    assert.equal(requireTestId(noRead.container, 'create').props.disabled, true);
  } finally {
    noRead.app.unmount();
  }

  const readOnly = await mountView({ scopes: ['sources:read'] });
  try {
    const banner = requireTestId(readOnly.container, 'scope-banner');
    assert.match(textOf(banner), /sources:write/);
    assert.equal(requireTestId(readOnly.container, 'create').props.disabled, true, '缺写 scope 时必须禁用');
  } finally {
    restore();
    readOnly.app.unmount();
  }
});

test('新建草稿：POST /admin/registrations，带 Idempotency-Key、不带 If-Match，请求体逐字段对齐契约', async () => {
  const fetchImpl = fakeFetch(({ url, init }) => {
    if (init.method === 'POST') return jsonResponse(201, envelope({ ...REGISTRATION, revision: 1 }), { etag: '"1"' });
    return jsonResponse(200, envelope({ items: [], next_cursor: null }));
  });
  const restore = withFetch(fetchImpl);
  const { app, container } = await mountView();
  try {
    clickNode(requireTestId(container, 'create'));
    await settle();

    typeInto(container, 'field-registered_name', '40% 稻瘟灵乳油');
    typeInto(container, 'field-source_id', SOURCE_ID);
    typeInto(container, 'field-source_version', '2026.1');
    typeInto(container, 'field-registration_number', 'PD20260001');
    typeInto(container, 'field-producer', '示例农药有限公司');
    typeInto(container, 'field-dosage_form', '乳油');
    typeInto(container, 'field-valid_from', '2026-01-02T03:04');
    typeInto(container, 'ingredient-0-name', '稻瘟灵');
    typeInto(container, 'ingredient-0-content_text', '40');
    typeInto(container, 'ingredient-0-unit_text', '%');
    await settle();

    // 契约 minItems:1 ⇒ 只有一条时「删除」按钮必须禁用。
    const deleteButtons = (node) => node.kind === 'button' && textOf(node).includes('删除第 1 条');
    assert.equal(findBy(container, deleteButtons).props.disabled, true, '最后一条有效成分不许删');

    submitForm(container, 'registration-form');
    await settle();

    const posts = fetchImpl.calls.filter((call) => call.init.method === 'POST');
    assert.equal(posts.length, 1, '一次提交只发一个写请求');
    assert.equal(posts[0].url, `${BASE_URL}/admin/registrations`);
    assert.match(posts[0].init.headers['idempotency-key'], /^admin-content-/, '必须带本项目生成的幂等键');
    assert.equal('if-match' in posts[0].init.headers, false, '创建不需要 If-Match');
    assert.deepEqual(JSON.parse(posts[0].init.body), {
      formulation: {
        registration_number: 'PD20260001',
        producer: '示例农药有限公司',
        dosage_form: '乳油',
        ingredients: [{ name: '稻瘟灵', content_text: '40', unit_text: '%' }],
      },
      source_id: SOURCE_ID,
      source_version: '2026.1',
      registered_name: '40% 稻瘟灵乳油',
      valid_from: new Date('2026-01-02T03:04').toISOString(),
      valid_to: null,
    });

    const outcome = requireTestId(container, 'outcome');
    assert.match(textOf(outcome), /服务端已创建并返回注册资料草稿/);
    assert.match(textOf(outcome), /不判定/);
    assert.equal(findBy(container, byTestId('registration-form')), null, '成功后关闭表单');

    // R1：新建成功后必须**同时选中**新对象（否则 `detail` 有值但 `selectedId` 仍为 null：
    // 详情面板不显示、If-Match 预览却已有值，还能对一个「未被选中」的对象点「编辑草稿」）。
    assert.ok(findBy(container, byTestId('start-edit')) !== null, '新建成功后详情面板必须显示（含「编辑草稿」入口）');
    const selectedRows = findAll(
      container,
      (node) => node.kind === 'tr' && typeof node.props.onClick === 'function' && String(node.props.class ?? '').split(/\s+/).includes('selected'),
    );
    assert.equal(selectedRows.length, 1, '新建成功后新对象必须是唯一被选中的行');
    assert.ok(textOf(container).includes(ID), '详情面板必须显示新对象的 id（不是一条没有出处的详情）');
    assert.equal(String(selectedRows[0].props.class ?? '').includes('selected'), true, '列表行与 details 的选中态必须一致');

    // 守卫钉子：`startEdit` 必须**同时**要求 selectedId 与 detail。改后「详情有值但未选中」这条路径
    // 已不可达（新建即选中），故按源码级钉住，防止有人把守卫退回「只看 detail !== null」。
    const sfc = readFileSync(new URL('../../apps/admin/src/views/RegistrationAdminView.vue', import.meta.url), 'utf8');
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

test('详情 → 发布：POST …/{id}/publish 带 If-Match "2"；200 同 revision 回放显示「已受理」而不是「发布成功」', async () => {
  const fetchImpl = fakeFetch(({ url, init }) => {
    if (init.method === 'POST' && url.endsWith('/publish')) return jsonResponse(200, envelope(REGISTRATION), { etag: '"2"' });
    if (url === `${BASE_URL}/admin/registrations/${ID}`) return jsonResponse(200, envelope(REGISTRATION), { etag: '"2"' });
    return jsonResponse(200, envelope({ items: [REGISTRATION], next_cursor: null }));
  });
  const restore = withFetch(fetchImpl);
  const { app, container } = await mountView();
  try {
    const row = findRow(container);
    assert.ok(row !== null, '有数据时必须渲染列表行');
    assert.match(textOf(row), /40% 稻瘟灵乳油/);
    clickNode(row);
    await settle();

    // R3：详情读取本身就是一条契约操作（getAdminRegistration）——直接钉 URL + method，
    // 不只靠详情文本间接覆盖。
    const detailCall = fetchImpl.calls.find((call) => call.url === `${BASE_URL}/admin/registrations/${ID}`);
    assert.ok(detailCall !== undefined, '选行必须真的发 GET /admin/registrations/{id}');
    assert.equal(detailCall.init.method, 'GET', '详情读取必须是 GET');
    assert.equal(detailCall.url.includes(ID), true, '详情 URL 必须带被选中的 id');

    const detailText = textOf(container);
    assert.match(detailText, /读面未提供：可见性 visibility/);
    assert.match(detailText, /当前修订（If-Match）/);

    clickNode(requireTestId(container, 'open-publish'));
    await settle();
    typeInto(container, 'field-evidenceRef', 'ev-reg-1');
    typeInto(container, 'field-reason', '登记证已核验');
    await settle();
    submitForm(container, 'publish-form');
    await settle();

    const publishCall = fetchImpl.calls.find((call) => call.url.endsWith('/publish'));
    assert.ok(publishCall !== undefined, '必须发出 publish 请求');
    assert.equal(publishCall.url, `${BASE_URL}/admin/registrations/${ID}/publish`);
    assert.equal(publishCall.init.method, 'POST');
    assert.equal(publishCall.init.headers['if-match'], '"2"');
    assert.notEqual(publishCall.init.headers['if-match'], '*');
    assert.match(publishCall.init.headers['idempotency-key'], /^admin-content-/);
    assert.deepEqual(JSON.parse(publishCall.init.body), { evidence_ref: 'ev-reg-1', reason: '登记证已核验' });

    const outcome = requireTestId(container, 'outcome');
    const outcomeText = textOf(outcome);
    assert.match(outcomeText, /服务端已受理/);
    assert.match(outcomeText, /未知：本族契约没有 visibility／changed 字段/);
    assert.match(outcomeText, /已是该状态/);
    assert.doesNotMatch(outcomeText, /发布成功|撤回成功/);

    // B1（整页级，不只是 outcome 节点）：changed 未知时**同一屏**不得再出现相反结论。
    // 写回执面板（WriteReceipt）此前标题写「写操作成功回执」、结果行写「结果 成功（HTTP 200）」
    // ⇒ 与这里的「已受理／changed 未知」互相打脸。断言对象是整页文本，覆盖所有子面板。
    const pageText = textOf(container);
    assert.doesNotMatch(pageText, /成功回执|结果\s*成功/, 'publish 的 changed 未知：整页都不得出现「成功回执／结果 成功」');
    assert.match(pageText, /写操作已受理回执/, '写回执面板标题必须是「写操作已受理回执」');
    assert.match(pageText, /已受理（HTTP 200 · 是否生效未确认）/, '写回执的结果行必须写「已受理…是否生效未确认」');
    assert.match(pageText, /服务端已受理/, '负面断言之外保留「已受理」正面断言');
  } finally {
    restore();
    app.unmount();
  }
});

test('编辑用同一幂等键重复提交（PATCH 回传同一 revision ⇒ changed===false）⇒ 整页不写「成功回执／结果 成功」', async () => {
  // 固定幂等键：两次「保存编辑」发**同一个** Idempotency-Key（服务端原样重放，不追加新修订）。
  const originalCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', {
    value: { getRandomValues: (bytes) => bytes.fill(0x2a) },
    configurable: true,
    writable: true,
  });
  const fetchImpl = fakeFetch(({ url, init }) => {
    if (init.method === 'PATCH') return jsonResponse(200, envelope(REGISTRATION), { etag: '"2"' });
    if (url === `${BASE_URL}/admin/registrations/${ID}`) return jsonResponse(200, envelope(REGISTRATION), { etag: '"2"' });
    return jsonResponse(200, envelope({ items: [REGISTRATION], next_cursor: null }));
  });
  const restore = withFetch(fetchImpl);
  const { app, container } = await mountView();
  try {
    clickNode(findRow(container));
    await settle();

    for (let round = 0; round < 2; round += 1) {
      clickNode(requireTestId(container, 'start-edit'));
      await settle();
      submitForm(container, 'registration-form');
      await settle();
    }

    const patches = fetchImpl.calls.filter((call) => call.init.method === 'PATCH');
    assert.equal(patches.length, 2, '两次提交各发一次 PATCH');
    assert.equal(new Set(patches.map((call) => call.init.headers['idempotency-key'])).size, 1, '两次提交必须用同一个幂等键（重放场景）');
    assert.equal(patches[1].url, `${BASE_URL}/admin/registrations/${ID}`);
    assert.equal(patches[1].init.headers['if-match'], '"2"', '两次都基于同一 revision 发 If-Match');

    // outcome 侧口径（上一轮已定，本片不动）：未追加新修订、不记为本次成功。
    const outcome = requireTestId(container, 'outcome');
    assert.match(textOf(outcome), /服务端未追加新修订/);
    assert.match(textOf(outcome), /不记为本次成功/);

    // B1（unchanged 档，整页级）：写回执此前标题写「写操作成功回执」、结果行写「结果 成功（HTTP 200）」
    // ⇒ 与上面 outcome 的「不记为本次成功」在同一屏给出两个相反结论。断言对象是**整页文本**。
    const pageText = textOf(container);
    assert.doesNotMatch(pageText, /成功回执|结果\s*成功/, 'changed===false 时整页都不得出现「成功回执／结果 成功」');
    assert.match(pageText, /写操作已受理回执（本次未产生变更）/, '写回执标题必须写「已受理」并点明本次未产生变更');
    assert.match(pageText, /已受理（HTTP 200 · 本次未产生变更）/, '写回执结果行必须写「已受理…本次未产生变更」');
    assert.match(pageText, /已受理/, '负面断言之外保留「已受理」正面断言');
    assert.match(pageText, /本次未产生变更/, '必须点明「本次未产生变更」（不宣称改了东西）');
  } finally {
    restore();
    app.unmount();
    Object.defineProperty(globalThis, 'crypto', { value: originalCrypto, configurable: true, writable: true });
  }
});

test('本地校验失败：必填没填 ⇒ 在页面列出字段错误且**一个写请求都不发**', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, envelope({ items: [], next_cursor: null })));
  const restore = withFetch(fetchImpl);
  const { app, container } = await mountView();
  try {
    clickNode(requireTestId(container, 'create'));
    await settle();
    assert.equal(requireTestId(container, 'submit').props.disabled, false, '有写 scope 时提交按钮可用（校验在提交时做）');
    submitForm(container, 'registration-form');
    await settle();

    assert.equal(fetchImpl.calls.filter((call) => call.init.method === 'POST').length, 0);
    const pageText = textOf(container);
    assert.match(pageText, /登记名称必填/);
    assert.match(pageText, /来源 ID 必须是 uuid/);
    assert.match(pageText, /有效成分/);
  } finally {
    restore();
    app.unmount();
  }
});
