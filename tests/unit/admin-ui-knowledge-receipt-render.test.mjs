/**
 * 页面级渲染用例：`KnowledgeAdminView.vue` 的写回执必须区分「真变更」与「服务端幂等短路」。
 *
 * 与 `admin-ui-sources-receipt-render.test.mjs` 同一口径，覆盖知识条目族：
 *  - publish 回执 `changed:false`（`KnowledgePublicationOutcome` 的必填布尔）⇒ 「本次未产生变更」，整块不含「成功」；
 *  - edit 的 revision 前进 ⇒ 「写操作成功回执」；revision 没前进（重放）⇒ 「本次未产生变更」。
 *
 * 编辑表单由 `knowledgeFormFromDetail()` 从详情整份回填，所以本文件不需要打字。
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
const KNOWLEDGE_ID = '00000000-0000-4000-8000-0000000000bb';
const SOURCE_ID = '00000000-0000-4000-8000-0000000000aa';

/** 一份通过 `validateKnowledgeDraft` 的条目夹具（`revision` 决定 edit 回执的三值走向）。 */
function knowledgeDraft(overrides = {}) {
  return {
    id: KNOWLEDGE_ID,
    revision: 4,
    visibility: 'private',
    review_status: 'unverified',
    content: {
      type: 'herbicide',
      title: '稗草抗性用药要点',
      body: '以标签推荐剂量为准，不生成处方混配换算。',
      source_id: SOURCE_ID,
      source_version: '2026.1',
      conditions: null,
      formulation_id: null,
    },
    ...overrides,
  };
}

function classify(url, method) {
  const path = String(url).split('?')[0];
  if (/\/admin\/knowledge\/[^/]+\/publish$/.test(path)) return 'publish';
  if (/\/admin\/knowledge\/[^/]+\/withdraw$/.test(path)) return 'withdraw';
  if (/\/admin\/knowledge\/[^/]+$/.test(path)) return method === 'PATCH' ? 'edit' : 'detail';
  if (/\/admin\/knowledge$/.test(path)) return method === 'POST' ? 'create' : 'list';
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
  const component = await loadComponent('../../apps/admin/src/views/KnowledgeAdminView.vue');
  return mountComponent(component, { baseUrl: BASE_URL, token: 'synthetic-admin-token', scopes: ['sources:read', 'sources:write'] });
}

function pageFetch(detail, onWrite) {
  return fakeFetch(({ url, init }) => {
    const method = init?.method ?? 'GET';
    const kind = classify(url, method);
    if (kind === 'list') return jsonResponse(200, envelope({ items: [detail], next_cursor: null }));
    if (kind === 'detail') return jsonResponse(200, envelope(detail), { etag: `"${detail.revision}"` });
    return onWrite(kind, { url, init, method });
  });
}

async function openDetailAnd(container, buttonText) {
  const row = firstRow(container);
  assert.ok(row !== null, '列表必须渲染出可点的行');
  clickNode(row);
  await settle();
  clickNode(buttonByText(container, buttonText));
  await settle();
}

test('知识条目发布幂等短路（changed:false）⇒ 回执写「本次未产生变更」，整块不含「成功」', async () => {
  const detail = knowledgeDraft();
  const fetchImpl = pageFetch(detail, () =>
    jsonResponse(200, envelope({ ...detail, visibility: 'published', changed: false }), { etag: '"4"' }),
  );
  const restore = withFetch(fetchImpl);
  const { app, container } = await mountView();
  try {
    await openDetailAnd(container, '发布');
    typeInto(container, 'field-evidenceRef', 'https://example.org/evidence#2');
    typeInto(container, 'field-reason', '首次发布');
    submitOnlyForm(container);
    await settle();

    const publishCalls = callsOf(fetchImpl, 'publish');
    assert.equal(publishCalls.length, 1, '必须真的发出一次 publish 请求');
    assert.equal(publishCalls[0].init.headers['if-match'], '"4"', 'publish 必须带详情 revision 的 If-Match');

    const heading = headingOf(container);
    assert.match(heading, /本次未产生变更/);
    assert.doesNotMatch(heading, /成功/);
    assert.match(panelText(container), /结果已受理（HTTP 200 · 本次未产生变更）/);
    assert.doesNotMatch(panelText(container), /成功/);
    assert.doesNotMatch(textOf(container), /写操作成功回执/);
  } finally {
    restore();
    app.unmount();
  }
});

test('知识条目编辑且 revision 前进 ⇒ 回执写「写操作成功回执」', async () => {
  const detail = knowledgeDraft();
  const fetchImpl = pageFetch(detail, (kind) => {
    if (kind !== 'edit') throw new Error(`意外的请求：${kind}`);
    return jsonResponse(200, envelope(knowledgeDraft({ revision: 5, visibility: 'published' })), { etag: '"5"' });
  });
  const restore = withFetch(fetchImpl);
  const { app, container } = await mountView();
  try {
    await openDetailAnd(container, '编辑草稿');
    submitOnlyForm(container);
    await settle();

    const editCalls = callsOf(fetchImpl, 'edit', 'PATCH');
    assert.equal(editCalls.length, 1, '必须真的发出一次 PATCH');
    assert.equal(editCalls[0].init.headers['if-match'], '"4"', 'If-Match 必须是这次编辑所基于的 revision（4）');

    assert.equal(headingOf(container), '写操作成功回执');
    assert.match(panelText(container), /结果成功（HTTP 200）/);
    assert.doesNotMatch(panelText(container), /本次未产生变更/);
  } finally {
    restore();
    app.unmount();
  }
});

test('知识条目编辑但 revision 没前进（重放旧 revision）⇒ 回执写「本次未产生变更」，不写「成功」', async () => {
  const detail = knowledgeDraft();
  const fetchImpl = pageFetch(detail, (kind) => {
    if (kind !== 'edit') throw new Error(`意外的请求：${kind}`);
    return jsonResponse(200, envelope(knowledgeDraft({ revision: 4 })), { etag: '"4"' });
  });
  const restore = withFetch(fetchImpl);
  const { app, container } = await mountView();
  try {
    await openDetailAnd(container, '编辑草稿');
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
