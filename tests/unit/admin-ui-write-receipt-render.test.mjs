/**
 * 渲染级用例：`WriteReceipt.vue` 的三值回执（`changed`）在**真实 SFC**下的呈现。
 *
 * 为什么需要渲染级：`admin-ui-content-view-model.test.mjs` 只钉 `receiptHeading()`／
 * `receiptLines()` 这两个纯函数的返回值；它证明不了「组件真的把这个判定用上了」——
 * 一旦模板退化成 `receiptHeading(write)`（丢掉 `props.changed`）或调用方忘传 `:changed`，
 * 纯函数测试仍然全绿，页面却会把幂等 no-op 写成「写操作成功回执」（B1 的成因）。
 *
 * 断言口径（与本仓库既有 `admin-ui-*-render.test.mjs` 一致）：
 *  - `changed:false` ⇒ 标题含「本次未产生变更」、结果行「已受理（HTTP 200 · 本次未产生变更）」，
 *    且**整块不含「成功」**；
 *  - 回执没带布尔 `changed`（create 的 201 就是这种）⇒ 只写「已受理」，同样不含「成功」；
 *  - 只有 `changed:true` 才允许出现「写操作成功回执」＋「成功（HTTP 200）」（正面锚点／负控对照）。
 *
 * 夹具见 `tests/unit/admin-ui-sfc-harness.mjs`。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { changedVerdict } from '../../apps/admin/src/lib/admin-content-view-model.mjs';
import { findBy, loadComponent, mountComponent, textOf } from './admin-ui-sfc-harness.mjs';

const REQUEST_ID = '00000000-0000-4000-9000-0000000000aa';

/** 一次 publish 已结算的回执（字段与各页 `runWrite()` 落的 receipt 同构）。 */
function settledReceipt(extra = {}) {
  return {
    phase: 'settled',
    label: '发布资料来源（POST /admin/sources/{id}/publish）',
    ok: true,
    status: 200,
    code: null,
    inContract: true,
    message: '',
    requestUrl: '/api/v1/admin/sources/00000000-0000-4000-8000-0000000000aa/publish',
    requestId: REQUEST_ID,
    etag: '"3"',
    sentHeaders: { 'idempotency-key': 'admin-content-0000000000000000', 'if-match': '"2"' },
    ...extra,
  };
}

/** 回执面板 = 带 `receipt` class 的那个 `<section>`（组件没有 data-testid，按 class 认）。 */
function receiptPanel(container) {
  return findBy(container, (node) => node.kind === 'section' && String(node.props.class ?? '').split(/\s+/).includes('receipt'));
}

function panelText(container) {
  const panel = receiptPanel(container);
  assert.ok(panel !== null, '回执面板必须渲染（write 非 null）');
  return textOf(panel);
}

function headingOf(container) {
  const panel = receiptPanel(container);
  assert.ok(panel !== null, '回执面板必须渲染');
  const heading = findBy(panel, (node) => node.kind === 'h4');
  assert.ok(heading !== null, '回执面板必须有标题 h4');
  return textOf(heading);
}

/** 挂载回执组件：`changed` 由**真实的** `changedVerdict()` 从回执字段算出，不手写字符串。 */
async function mountReceipt(write) {
  const component = await loadComponent('../../apps/admin/src/views/WriteReceipt.vue');
  return mountComponent(component, { write, changed: changedVerdict(write.changed) });
}

test('渲染：回执 changed:false（服务端幂等短路）⇒ 标题写「本次未产生变更」，整块不含「成功」', async () => {
  const write = settledReceipt({ changed: false });
  assert.equal(changedVerdict(write.changed), 'unchanged', '前置：false 必须判定成 unchanged');
  const { app, container } = await mountReceipt(write);
  try {
    const heading = headingOf(container);
    assert.match(heading, /本次未产生变更/, 'changed:false 的标题必须点明本次没产生变更');
    assert.doesNotMatch(heading, /成功/, 'changed:false 的标题不得写「成功」');

    const text = panelText(container);
    assert.match(text, /结果已受理（HTTP 200 · 本次未产生变更）/, '结果行必须写「已受理…本次未产生变更」');
    assert.doesNotMatch(text, /成功/, 'changed:false 时整块回执不得出现「成功」（同一屏不许两个相反结论）');
  } finally {
    app.unmount();
  }
});

test('渲染：回执没带布尔 changed（create 的 201）⇒ 只写「已受理」，不写「成功」', async () => {
  const write = settledReceipt({ status: 201, etag: '"1"' });
  assert.equal('changed' in write, false, '前提：这份回执确实没有 changed 字段');
  assert.equal(changedVerdict(write.changed), 'unknown', '前置：缺 changed 必须判定成 unknown（不猜）');
  const { app, container } = await mountReceipt(write);
  try {
    const heading = headingOf(container);
    assert.equal(heading, '写操作已受理回执', '没带 changed 只能写「已受理回执」');
    assert.match(heading, /已受理/);
    assert.doesNotMatch(heading, /成功/, '拿不到契约真值时不得写「成功」');

    const text = panelText(container);
    assert.match(text, /结果已受理（HTTP 201 · 是否生效未确认）/, '结果行必须如实写「是否生效未确认」');
    assert.doesNotMatch(text, /成功/);
  } finally {
    app.unmount();
  }
});

test('渲染：回执 changed:true（真迁移）⇒ 才出现「写操作成功回执」＋「成功（HTTP 200）」', async () => {
  const write = settledReceipt({ changed: true });
  assert.equal(changedVerdict(write.changed), 'changed', '前置：true 必须判定成 changed');
  const { app, container } = await mountReceipt(write);
  try {
    assert.equal(headingOf(container), '写操作成功回执', 'changed:true 才允许写「成功回执」');
    const text = panelText(container);
    assert.match(text, /结果成功（HTTP 200）/);
    assert.doesNotMatch(text, /本次未产生变更/);
  } finally {
    app.unmount();
  }
});

/**
 * 接线钉子（源码级）：五个用 `WriteReceipt` 的视图**都必须**显式喂 `receiptChanged`。
 * 渲染用例只能证明「传了值之后页面是对的」；这一条守的是「将来别把 `:changed` 又删掉/漏传」——
 * 漏传会静默退回组件默认值 `'changed'`，把 no-op 显示成成功回执，且不会有任何测试变红。
 */
test('接线：五个视图都传 :changed="receiptChanged"，且写操作都带 action（create/edit/publish/withdraw）', () => {
  const wiring = {
    RegistrationAdminView: ['create', 'edit', 'publish', 'withdraw'],
    RestrictionAdminView: ['create', 'edit', 'publish', 'withdraw'],
    SourcesView: ['create', 'edit', 'publish', 'withdraw'],
    KnowledgeAdminView: ['create', 'edit', 'publish', 'withdraw'],
    // 分类页契约只有 PATCH /admin/categories/{id}：没有 create／publish／withdraw。
    CategoriesView: ['edit'],
  };
  for (const [view, actions] of Object.entries(wiring)) {
    const source = readFileSync(new URL(`../../apps/admin/src/views/${view}.vue`, import.meta.url), 'utf8');
    assert.match(
      source,
      /const receiptChanged = computed\(\(\) => changedVerdict\(state\.value\.write\?\.changed\)\);/,
      `${view} 必须用 changedVerdict() 从回执算出三值，而不是另立判据`,
    );
    assert.match(source, /:changed="receiptChanged"/, `${view} 必须把 receiptChanged 传给 WriteReceipt（漏传会静默退回默认 'changed'）`);
    assert.match(
      source,
      /changed: deriveChanged\(action, result, \{ previousRevision \}\)/,
      `${view} 的 receipt 必须带 deriveChanged() 算出的 changed`,
    );
    for (const action of actions) {
      assert.match(source, new RegExp(`action: '${action}',`), `${view} 必须把 ${action} 的 action 传进 runWrite()`);
    }
  }
});
