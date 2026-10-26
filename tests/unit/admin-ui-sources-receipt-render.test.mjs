/**
 * 页面级渲染用例：`SourcesView.vue` 的写回执必须区分「真变更」与「服务端幂等短路」。
 *
 * 守的是这条已知缺口：publish／edit 的 HTTP 200 **既可能是真迁移，也可能是 no-op**。
 * 页面此前不带 `changed`，组件退回默认值 `'changed'`，于是幂等短路也显示成「写操作成功回执」。
 * 这里用真实 SFC + 真实 fetch 桩跑一遍：点行 → 填表单 → 提交 → 读回执标题与结果行。
 *
 * 断言口径：
 *  - publish 回执 `changed:false` ⇒ 标题含「本次未产生变更」、整块不含「成功」；
 *  - edit 的 revision 前进 ⇒ 「写操作成功回执」＋「成功（HTTP 200）」；revision 没前进（重放）⇒ 「本次未产生变更」；
 *  - create 的 201 没有 `changed` ⇒ 只写「已受理（是否生效未确认）」，不许写「成功」。
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
  typeInto,
  withFetch,
} from './admin-ui-sfc-harness.mjs';

const BASE_URL = '/api/v1';
const SOURCE_ID = '00000000-0000-4000-8000-0000000000aa';

/** 一份通过 `validateSourceDraft` 的草稿／发布结果夹具（`revision` 决定回执的三值走向）。 */
function sourceDraft(overrides = {}) {
  return {
    id: SOURCE_ID,
    revision: 2,
    visibility: 'private',
    source: {
      id: SOURCE_ID,
      version: '2026.1',
      title: '稻田稗草抗性监测',
      url: 'https://example.org/reports/2026-1',
      publisher: '示例农科院',
      source_kind: 'database',
      evidence_kind: 'research',
      validity: 'valid',
      review_status: 'verified',
      updated_at: '2026-01-02T03:04:05.000Z',
    },
    ...overrides,
  };
}

/** 按路径/方法分辨请求种类（`buildFamilyUrl()` 会归一化 baseUrl，所以只看路径尾段）。 */
function classify(url, method) {
  const path = String(url).split('?')[0];
  if (/\/admin\/sources\/[^/]+\/publish$/.test(path)) return 'publish';
  if (/\/admin\/sources\/[^/]+\/withdraw$/.test(path)) return 'withdraw';
  if (/\/admin\/sources\/[^/]+$/.test(path)) return method === 'PATCH' ? 'edit' : 'detail';
  if (/\/admin\/sources$/.test(path)) return method === 'POST' ? 'create' : 'list';
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

function buttonByText(container, text) {
  const node = findBy(container, (candidate) => candidate.kind === 'button' && textOf(candidate) === text);
  assert.ok(node !== null, `找不到文本为「${text}」的按钮`);
  return node;
}

/** 提交页面上唯一打开的那张表单（编辑/发布/下架表单互斥）。 */
function submitOnlyForm(container) {
  const forms = findAll(container, (node) => node.kind === 'form' && typeof node.props.onSubmit === 'function');
  assert.equal(forms.length, 1, '此刻应当只有一张可提交的表单');
  forms[0].props.onSubmit({ preventDefault() {} });
}

function firstRow(container) {
  return findBy(container, (node) => node.kind === 'tr' && typeof node.props.onClick === 'function');
}

function callsOf(fetchImpl, kind, method) {
  return fetchImpl.calls.filter((call) => classify(call.url, call.init?.method ?? 'GET') === kind && (method === undefined || call.init?.method === method));
}

async function mountView() {
  const component = await loadComponent('../../apps/admin/src/views/SourcesView.vue');
  return mountComponent(component, { baseUrl: BASE_URL, token: 'synthetic-admin-token', scopes: ['sources:read', 'sources:write'] });
}

/** 列表 + 详情都返回同一份草稿；写操作交给 `onWrite`。 */
function pageFetch(detail, onWrite) {
  return fakeFetch(({ url, init }) => {
    const method = init?.method ?? 'GET';
    const kind = classify(url, method);
    if (kind === 'list') return jsonResponse(200, envelope({ items: [detail], next_cursor: null }));
    if (kind === 'detail') return jsonResponse(200, envelope(detail), { etag: `"${detail.revision}"` });
    return onWrite(kind, { url, init, method });
  });
}

/** 打开详情并点开某个操作（发布/编辑/下架）。 */
async function openDetailAnd(container, buttonText) {
  const row = firstRow(container);
  assert.ok(row !== null, '列表必须渲染出可点的行');
  clickNode(row);
  await settle();
  clickNode(buttonByText(container, buttonText));
  await settle();
}

test('发布幂等短路（changed:false）⇒ 回执写「本次未产生变更」，整块不含「成功」', async () => {
  const detail = sourceDraft();
  const fetchImpl = pageFetch(detail, () =>
    // `SourcePublicationOutcome`：200 + 必填布尔 changed；false 表示服务端判定本次没有产生变更。
    jsonResponse(200, envelope({ ...detail, visibility: 'published', changed: false }), { etag: '"2"' }),
  );
  const restore = withFetch(fetchImpl);
  const { app, container } = await mountView();
  try {
    await openDetailAnd(container, '发布');
    typeInto(container, 'field-evidenceRef', 'https://example.org/evidence#1');
    typeInto(container, 'field-reason', '首次发布');
    submitOnlyForm(container);
    await settle();

    const publishCalls = callsOf(fetchImpl, 'publish');
    assert.equal(publishCalls.length, 1, '必须真的发出一次 publish 请求（否则下面的断言是空的）');
    assert.equal(publishCalls[0].init.headers['if-match'], '"2"', 'publish 必须带详情 revision 的 If-Match');

    const heading = headingOf(container);
    assert.match(heading, /本次未产生变更/, 'changed:false 的标题必须点明本次没产生变更');
    assert.doesNotMatch(heading, /成功/, 'changed:false 不许写「成功回执」');
    assert.match(panelText(container), /结果已受理（HTTP 200 · 本次未产生变更）/, '结果行必须写「已受理…本次未产生变更」');
    assert.doesNotMatch(panelText(container), /成功/, '回执整块不得出现「成功」');
    assert.doesNotMatch(textOf(container), /写操作成功回执/);
  } finally {
    restore();
    app.unmount();
  }
});

test('编辑且 revision 前进 ⇒ 回执写「写操作成功回执」＋「成功（HTTP 200）」', async () => {
  const detail = sourceDraft();
  const fetchImpl = pageFetch(detail, (kind) => {
    if (kind !== 'edit') throw new Error(`意外的请求：${kind}`);
    return jsonResponse(200, envelope(sourceDraft({ revision: 3, visibility: 'published' })), { etag: '"3"' });
  });
  const restore = withFetch(fetchImpl);
  const { app, container } = await mountView();
  try {
    await openDetailAnd(container, '编辑草稿');
    // 读面 `SourceRef` 不返回 content_hash／locator／valid_from，编辑时必须重填。
    typeInto(container, 'field-content_hash', 'b'.repeat(64));
    typeInto(container, 'field-locator', 'p12-l34');
    typeInto(container, 'field-valid_from', '2026-01-02T03:04');
    submitOnlyForm(container);
    await settle();

    const editCalls = callsOf(fetchImpl, 'edit', 'PATCH');
    assert.equal(editCalls.length, 1, '必须真的发出一次 PATCH');
    assert.equal(
      editCalls[0].init.headers['if-match'],
      '"2"',
      'If-Match 必须是这次编辑**所基于**的 revision（2），不是响应回传的新 revision',
    );

    assert.equal(headingOf(container), '写操作成功回执', 'revision 从 2 前进到 3 ⇒ 真变更');
    assert.match(panelText(container), /结果成功（HTTP 200）/);
    assert.match(panelText(container), /响应 ETag/);
    assert.match(panelText(container), /"3"/, '回执要显示服务端回的新 ETag');
    assert.doesNotMatch(panelText(container), /本次未产生变更/);
  } finally {
    restore();
    app.unmount();
  }
});

test('编辑但 revision 没前进（重放旧 revision）⇒ 回执写「本次未产生变更」，不写「成功」', async () => {
  const detail = sourceDraft();
  const fetchImpl = pageFetch(detail, (kind) => {
    if (kind !== 'edit') throw new Error(`意外的请求：${kind}`);
    return jsonResponse(200, envelope(sourceDraft({ revision: 2 })), { etag: '"2"' });
  });
  const restore = withFetch(fetchImpl);
  const { app, container } = await mountView();
  try {
    await openDetailAnd(container, '编辑草稿');
    typeInto(container, 'field-content_hash', 'c'.repeat(64));
    typeInto(container, 'field-locator', 'p56-l78');
    typeInto(container, 'field-valid_from', '2026-01-02T03:04');
    submitOnlyForm(container);
    await settle();

    assert.equal(callsOf(fetchImpl, 'edit', 'PATCH').length, 1, '必须真的发出一次 PATCH');
    const heading = headingOf(container);
    assert.match(heading, /本次未产生变更/, '回执 revision 与 If-Match 相同 ⇒ 本次没有产生变更');
    assert.doesNotMatch(heading, /成功/);
    assert.match(panelText(container), /结果已受理（HTTP 200 · 本次未产生变更）/);
    assert.doesNotMatch(textOf(container), /写操作成功回执/);
  } finally {
    restore();
    app.unmount();
  }
});

test('新建草稿的 201 没有 changed ⇒ 回执只写「已受理（是否生效未确认）」，不写「成功」', async () => {
  const fetchImpl = fakeFetch(({ url, init }) => {
    const method = init?.method ?? 'GET';
    const kind = classify(url, method);
    if (kind === 'list') return jsonResponse(200, envelope({ items: [], next_cursor: null }));
    if (kind === 'create') return jsonResponse(201, envelope(sourceDraft({ revision: 1 })), { etag: '"1"' });
    throw new Error(`意外的请求：${kind}`);
  });
  const restore = withFetch(fetchImpl);
  const { app, container } = await mountView();
  try {
    clickNode(buttonByText(container, '新建草稿'));
    await settle();
    typeInto(container, 'field-title', '稻田稗草抗性监测（草稿）');
    typeInto(container, 'field-url', 'https://example.org/reports/2026-1');
    typeInto(container, 'field-publisher', '示例农科院');
    typeInto(container, 'field-version', '2026.1');
    typeInto(container, 'field-content_hash', 'a'.repeat(64));
    typeInto(container, 'field-locator', 'p1-l2');
    typeInto(container, 'field-valid_from', '2026-01-02T03:04');
    submitOnlyForm(container);
    await settle();

    const createCalls = callsOf(fetchImpl, 'create', 'POST');
    assert.equal(createCalls.length, 1, '必须真的发出一次 create');
    const heading = headingOf(container);
    assert.equal(heading, '写操作已受理回执', 'create 的 201 拿不到 changed ⇒ 只能写「已受理回执」');
    assert.doesNotMatch(heading, /成功/);
    assert.match(panelText(container), /结果已受理（HTTP 201 · 是否生效未确认）/);
    assert.doesNotMatch(textOf(container), /写操作成功回执/);
  } finally {
    restore();
    app.unmount();
  }
});
