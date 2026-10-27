/**
 * 无障碍语义口径（审查 R67-B05／B06／B07）：
 *
 *  - **B05**：`WriteReceipt.vue` 是「这一次写操作真的发生了什么」的唯一播报面。它的容器必须
 *    是活区——进行中／成功用 `role="status"` + `aria-live="polite"`，失败改成 `role="alert"`
 *    + `aria-live="assertive"`，否则屏幕阅读器对「已提交／失败」一个字都不播。
 *  - **B06**：`AccountsView.vue` 的停用确认框是**真对话框**（有输入框、有两个按钮，打开后
 *    后面的页面不该再被 Tab 到），所以必须有 `role="dialog"` + `aria-modal="true"` +
 *    `aria-labelledby`（指向框内标题的 id），并做焦点搬运（打开进框／关闭回触发按钮）与
 *    焦点陷阱（Tab／Shift+Tab 在框内循环）。
 *  - **B07**：页面级状态容器（`class="status" :class="view.tone"`）复用于加载／空态／失败，
 *    原来一律 `role="status"`（礼貌播报，失败也随大流）。现在改成随 tone 走：`error ⇒ alert`，
 *    其余仍是 `status`（加载中／空态／已读取是进度，不该抢话）。
 *
 * 为什么 B05 用渲染级、B06 用源码级：`WriteReceipt.vue` 只依赖纯逻辑 `.mjs`，可以直接挂在
 * `tests/unit/admin-ui-sfc-harness.mjs` 的内存宿主上断言真实 DOM props；`AccountsView.vue`
 * 除了 vue 还 `import '../auth/session'`（`src/auth/session.ts`，依赖 Vite 的 `import.meta.env`
 * 与 `sessionStorage`），内存宿主编不出这个模块，且确认框要经过 `SUSPEND_BEGIN` 状态迁移才会出现。
 * 所以 B06 按任务约定退到「对 `.vue` 源文件做结构化断言」：按代码片段（不写死行号）定位开标签、
 * 取属性值、再回头校验 `aria-labelledby` 指向的 `id` 真的存在。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';

import { FOCUSABLE_SELECTOR, nextFocusIndex } from '../../apps/admin/src/lib/dialog-focus.mjs';
import { changedVerdict, describeFamily, describeFamilyView } from '../../apps/admin/src/lib/admin-content-view-model.mjs';
import { describe as describeAccounts, initialState } from '../../apps/admin/src/lib/view-model.mjs';
import { findBy, loadComponent, mountComponent, textOf } from './admin-ui-sfc-harness.mjs';

const REQUEST_ID = '00000000-0000-4000-9000-0000000000aa';

function sourceOf(file) {
  return readFileSync(new URL(`../../apps/admin/src/views/${file}`, import.meta.url), 'utf8');
}

/** 取「含 needle 的那个开标签」的原文（左扩到最后一个 `<`，右扩到第一个 `>`）。 */
function openingTagOf(source, needle) {
  const at = source.indexOf(needle);
  assert.notEqual(at, -1, `源码里找不到片段：${needle}`);
  const start = source.lastIndexOf('<', at);
  const end = source.indexOf('>', at);
  assert.ok(start !== -1 && end > at, `片段 ${needle} 必须落在一个开标签里`);
  return source.slice(start, end + 1);
}

/** 一次已结算的回执（字段与各页 `runWrite()` 落的 receipt 同构）。 */
function receipt(extra = {}) {
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
    changed: true,
    ...extra,
  };
}

function receiptPanel(container) {
  const panel = findBy(container, (node) => node.kind === 'section' && String(node.props.class ?? '').split(/\s+/).includes('receipt'));
  assert.ok(panel !== null, '回执面板必须渲染（write 非 null）');
  return panel;
}

async function mountReceipt(write) {
  const component = await loadComponent('../../apps/admin/src/views/WriteReceipt.vue');
  return mountComponent(component, { write, changed: changedVerdict(write.changed) });
}

// ── B05：回执容器的活区角色 ────────────────────────────────────────────────

test('B05 渲染：失败回执 ⇒ role="alert" + aria-live="assertive"（并断言不再是 status）', async () => {
  const write = receipt({ ok: false, status: 409, code: 'REVISION_CONFLICT', etag: 'W/"2"', message: 'revision 不匹配' });
  const { app, container } = await mountReceipt(write);
  try {
    const panel = receiptPanel(container);
    assert.equal(panel.props.role, 'alert', '失败回执必须用 role="alert"（status 是礼貌播报，对失败不够）');
    assert.equal(panel.props['aria-live'], 'assertive', '失败回执的活区必须是 assertive');
    assert.notEqual(panel.props.role, 'status', '失败态不得再用 role="status"');
    assert.match(textOf(panel), /REVISION_CONFLICT/, '前置：失败回执确实渲染了错误码（否则这条断言没意义）');
  } finally {
    app.unmount();
  }
});

test('B05 渲染：成功回执 ⇒ role="status" + aria-live="polite"（不是 alert）', async () => {
  const write = receipt({ changed: true });
  const { app, container } = await mountReceipt(write);
  try {
    const panel = receiptPanel(container);
    assert.equal(panel.props.role, 'status', '成功回执用 role="status"（完成通知，不需要打断）');
    assert.equal(panel.props['aria-live'], 'polite', '成功回执必须是礼貌播报');
    assert.equal(panel.props['aria-live'] !== undefined, true, '回执容器必须声明 aria-live（否则读屏不播报「已提交」）');
  } finally {
    app.unmount();
  }
});

test('B05 渲染：进行中（phase=pending）⇒ role="status" + aria-live="polite"（进度用礼貌播报）', async () => {
  const write = receipt({ phase: 'pending', ok: null, status: null, code: null, etag: null, requestId: null, sentHeaders: {} });
  const { app, container } = await mountReceipt(write);
  try {
    const panel = receiptPanel(container);
    assert.equal(panel.props.role, 'status', '进行中也是进度播报（role="status"）');
    assert.equal(panel.props['aria-live'], 'polite', '进行中不得抢话（assertive 会打断用户）');
  } finally {
    app.unmount();
  }
});

// ── B07：页面级状态容器的 role 随 tone 走 ──────────────────────────────────

/** 9 处「复用于加载／空态／失败」的页面级状态容器（审查报告点名的那 9 处）。 */
const TONE_STATUS_VIEWS = [
  'AccountsView.vue',
  'AuditEventsView.vue',
  'CategoriesView.vue',
  'FlagAuditView.vue',
  'FlagsView.vue',
  'KnowledgeAdminView.vue',
  'RegistrationAdminView.vue',
  'RestrictionAdminView.vue',
  'SourcesView.vue',
];

test('B07 源码：9 处页面级状态容器的 role 随 tone 变（error ⇒ alert，其余 ⇒ status）', () => {
  for (const file of TONE_STATUS_VIEWS) {
    const source = sourceOf(file);
    const tag = openingTagOf(source, ':class="view.tone"');
    assert.match(
      tag,
      /:role="view\.tone === 'error' \? 'alert' : 'status'"/,
      `${file} 的状态容器必须按 tone 选 role：失败（tone==='error'）用 alert，其余用 status`,
    );
    assert.doesNotMatch(tag, /\brole="status"/, `${file} 的状态容器不得再写死 role="status"（失败态会一起变成礼貌播报）`);
    assert.doesNotMatch(tag, /\brole="alert"/, `${file} 的状态容器不得写死 role="alert"（加载中／空态不是失败）`);
  }
});

test('B07 行为：tone 判定所依赖的 describe* 在读取失败时确实吐 error（否则模板的分支永不生效）', () => {
  const accountsFailure = describeAccounts({ ...initialState(), phase: 'error', failure: null });
  assert.equal(accountsFailure.tone, 'error', '账号目录：读取失败必须是 tone=error');

  const familyFailure = describeFamily({ phase: 'error', stale: false, failure: null, collection: { items: [], pages: 0, nextCursor: null } });
  assert.equal(familyFailure.tone, 'error', '内容行族：读取失败必须是 tone=error');

  const unwired = describeFamilyView({
    phase: 'error',
    stale: false,
    collection: { items: [], pages: 0, nextCursor: null },
    failure: { ok: false, status: 503, code: 'PROVIDER_UNAVAILABLE', message: 'no pool', declaredRetryable: false },
  });
  assert.equal(unwired.tone, 'error', '注册／限制页的「服务端未接线」也必须是 tone=error（它同样是失败态）');
});

// ── B06：停用确认框的对话框语义（源码级，见文件头的原因说明） ───────────────

test('B06 源码：确认框是 role="dialog" + aria-modal="true"，且 aria-labelledby 指向框内真实存在的 id', () => {
  const source = sourceOf('AccountsView.vue');
  const dialogTag = openingTagOf(source, 'class="suspend-confirm"');

  assert.match(dialogTag, /\brole="dialog"/, '停用确认框必须有 role="dialog"');
  assert.match(dialogTag, /\baria-modal="true"/, '停用确认框必须有 aria-modal="true"（否则读屏仍能 Tab 到背后页面）');

  const labelledby = /aria-labelledby="([^"]+)"/.exec(dialogTag);
  assert.ok(labelledby !== null, '停用确认框必须用 aria-labelledby 指向框内标题（不是只靠 aria-label）');
  const id = labelledby[1];
  const dialogStart = source.indexOf(dialogTag);
  const idAt = source.indexOf(`id="${id}"`);
  assert.notEqual(idAt, -1, `aria-labelledby="${id}" 必须指向源码里真的存在的 id`);
  assert.ok(idAt > dialogStart, `aria-labelledby 指向的 id="${id}" 必须就在这个对话框内部（现在它在对话框之前）`);
});

test('B06 源码：焦点搬进框、Tab 在框内循环、Esc 关闭、关闭后回触发按钮', () => {
  const source = sourceOf('AccountsView.vue');

  const dialogTag = openingTagOf(source, 'class="suspend-confirm"');
  assert.match(dialogTag, /@keydown="onSuspendKeydown"/, '确认框必须挂 keydown 处理器（焦点陷阱与 Esc 都在这里）');

  assert.match(
    source,
    /import \{[^}]*FOCUSABLE_SELECTOR[^}]*nextFocusIndex[^}]*\} from '\.\.\/lib\/dialog-focus\.mjs';/s,
    '确认框必须复用 lib/dialog-focus.mjs 的可聚焦选择器与循环下标纯函数（不另造一份）',
  );
  assert.match(source, /function onSuspendKeydown\(event\)/, '必须有 onSuspendKeydown 处理器');
  assert.match(source, /event\.key === 'Escape'/, 'Esc 必须能关闭确认框');
  assert.match(source, /dialog\.querySelectorAll\(FOCUSABLE_SELECTOR\)/, '焦点陷阱必须在框内枚举可聚焦元素');
  assert.match(source, /watch\(suspendTarget/, '打开／关闭确认框必须触发焦点搬运（watch suspendTarget）');
  assert.match(source, /focusSuspendTitle\(\)/, '打开后焦点必须落到标题（读屏会先播报对话框名字）');
  assert.match(
    source,
    /const trigger = suspendTrigger;[\s\S]*?trigger\.focus\(\)/,
    '关闭后焦点必须回到触发按钮（先把 suspendTrigger 取出来，再 focus）',
  );
  assert.match(source, /beginSuspend\(row, \$event\)/, '触发按钮必须把事件传进来，才能记住「关闭后回哪个按钮」');
});

test('B06 纯函数：Tab／Shift+Tab 在框内首尾循环', () => {
  assert.match(FOCUSABLE_SELECTOR, /button:not\(\[disabled\]\)/, '可聚焦选择器必须排除 disabled 按钮（保存中全部禁用时不该有焦点目标）');
  assert.match(FOCUSABLE_SELECTOR, /\[tabindex\]:not\(\[tabindex="-1"\]\)/, 'tabindex="-1" 是程序化焦点位，不算 Tab 目标');

  // 3 个可聚焦项：input(0) → 确认(1) → 取消(2)
  assert.equal(nextFocusIndex({ count: 3, index: 0, shift: false }), 1, 'Tab 从第一个前进到第二个');
  assert.equal(nextFocusIndex({ count: 3, index: 2, shift: false }), 0, 'Tab 在最后一项必须回到第一项（循环，不跑出框）');
  assert.equal(nextFocusIndex({ count: 3, index: 0, shift: true }), 2, 'Shift+Tab 在第一项必须跳到最后一个（循环）');
  assert.equal(nextFocusIndex({ count: 3, index: 1, shift: true }), 0, 'Shift+Tab 正常后退');

  // 焦点不在列表里（在标题上）⇒ 进框的第一个／最后一个
  assert.equal(nextFocusIndex({ count: 3, index: -1, shift: false }), 0, '焦点在标题上时 Tab 进第一个可操作项');
  assert.equal(nextFocusIndex({ count: 3, index: -1, shift: true }), 2, '焦点在标题上时 Shift+Tab 进最后一个可操作项');

  // 没有可聚焦项（保存中全禁用）⇒ -1，调用方把焦点交回标题
  assert.equal(nextFocusIndex({ count: 0, index: -1, shift: false }), -1, '空列表返回 -1（焦点回标题，不留在框外）');
});

test('B06／B05 门：两个被改的 SFC 都能被 @vue/compiler-sfc 编译（模板语法不被本改动打破）', () => {
  for (const file of ['WriteReceipt.vue', 'AccountsView.vue']) {
    const source = sourceOf(file);
    const filename = `apps/admin/src/views/${file}`;
    const { descriptor, errors } = parse(source, { filename });
    assert.deepEqual(errors, [], `${file} 必须能被 @vue/compiler-sfc 解析`);
    assert.ok(descriptor.template !== null, `${file} 必须有模板`);
    const compiled = compileTemplate({ source: descriptor.template.content, filename, id: `gy-a11y-${file}` });
    assert.deepEqual(compiled.errors, [], `${file} 的模板必须能编译`);
    const script = compileScript(descriptor, { id: `gy-a11y-script-${file}` });
    assert.ok(script.content.length > 0, `${file} 的 <script setup> 必须能编译`);
  }
});
