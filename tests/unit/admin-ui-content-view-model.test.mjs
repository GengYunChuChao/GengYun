/**
 * 后台「资料管理」展示状态机单测：`apps/admin/src/lib/admin-content-view-model.mjs`。
 *
 * 钉住四条不下假的规则：行只能来自服务端、刷新失败标 stale、写回执必带 request_id/写头/错误码、
 * 审计查不到时不许说成「没有审计记录」。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUDIT_SCOPE_NOTE,
  canLoadMoreFamily,
  categoryDetailView,
  categoryRow,
  changedVerdict,
  describeAuditLookup,
  describeFamily,
  formatDateTime,
  initialFamilyState,
  knowledgeDetailView,
  knowledgeRow,
  receiptHeading,
  receiptLines,
  reduceFamily,
  selfCheckLabelCoverage,
  sourceDetailView,
  sourceRow,
} from '../../apps/admin/src/lib/admin-content-view-model.mjs';

const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';

function sourceDraft(id, revision, overrides = {}) {
  return {
    id,
    revision,
    visibility: 'private',
    source: {
      id,
      version: '2026.1',
      title: `来源 ${id.slice(-1)}`,
      url: 'https://example.org/source',
      publisher: '示例出版社',
      source_kind: 'verified_seed',
      evidence_kind: 'mixed',
      validity: 'valid',
      review_status: 'unverified',
      updated_at: '2026-01-02T03:04:05.000Z',
    },
    ...overrides,
  };
}

function loadOk(state, cursor, items, nextCursor) {
  return reduceFamily(state, { type: 'LOAD_OK', cursor, page: { items, nextCursor } });
}

test('LOAD_OK：按 id 去重、累计页数；服务端回传同游标时停止续页（防死循环）', () => {
  let state = reduceFamily(initialFamilyState(), { type: 'LOAD_START', reset: true });
  state = loadOk(state, null, [sourceDraft(ID_A, 1)], 'c1');
  assert.equal(state.phase, 'ready');
  assert.equal(state.collection.items.length, 1);
  assert.equal(canLoadMoreFamily(state), true);

  // 续页重复投递同一行 ⇒ 去重，不重复计数
  state = loadOk(state, 'c1', [sourceDraft(ID_A, 1), sourceDraft(ID_B, 2)], 'c2');
  assert.equal(state.collection.items.length, 2);
  assert.equal(state.collection.duplicates, 1);
  assert.equal(state.collection.pages, 2);

  // 游标原地打转 ⇒ nextCursor 置 null 且标记 cycle
  state = loadOk(state, 'c2', [], 'c2');
  assert.equal(state.collection.cycle, true);
  assert.equal(state.collection.nextCursor, null);
  assert.equal(canLoadMoreFamily(state), false);
});

test('空列表与失败是两件事：0 行不显示成「接口坏了」，有旧行时失败标 stale', () => {
  const empty = loadOk(reduceFamily(initialFamilyState(), { type: 'LOAD_START', reset: true }), null, [], null);
  const emptyView = describeFamily(empty, { label: '资料来源' });
  assert.equal(empty.phase, 'empty');
  assert.equal(emptyView.tone, 'empty');
  assert.equal(emptyView.title, '接口返回 0 行');
  assert.equal(emptyView.canRetry, false);

  let state = loadOk(initialFamilyState(), null, [sourceDraft(ID_A, 1)], null);
  state = reduceFamily(state, { type: 'LOAD_FAIL', failure: { ok: false, kind: 'unavailable', status: 503, code: 'PROVIDER_UNAVAILABLE' } });
  assert.equal(state.phase, 'ready');
  assert.equal(state.stale, true);
  const staleView = describeFamily(state);
  assert.equal(staleView.tone, 'stale');
  assert.equal(staleView.detail.includes('PROVIDER_UNAVAILABLE'), true);
  assert.equal(state.collection.items.length, 1); // 旧行保留但标 stale

  const hardFail = reduceFamily(initialFamilyState(), { type: 'LOAD_FAIL', failure: { ok: false, kind: 'forbidden', status: 403, code: 'SCOPE_DENIED' } });
  assert.equal(hardFail.phase, 'error');
  assert.equal(describeFamily(hardFail).detail.includes('SCOPE_DENIED'), true);
  assert.equal(describeFamily(hardFail).canRetry, true);
});

test('SELECT / DETAIL：选中即清空上一条详情与审计查找结果；空 id 等于取消选中', () => {
  let state = loadOk(initialFamilyState(), null, [sourceDraft(ID_A, 3)], null);
  state = reduceFamily(state, { type: 'SELECT', id: ID_A });
  state = reduceFamily(state, { type: 'DETAIL_OK', item: sourceDraft(ID_A, 3) });
  state = reduceFamily(state, { type: 'AUDIT_OK', events: [], scanned: 1, truncated: false });
  assert.equal(state.detailPhase, 'ready');
  assert.notEqual(state.auditLookup, null);

  state = reduceFamily(state, { type: 'SELECT', id: null });
  assert.equal(state.selectedId, null);
  assert.equal(state.detail, null);
  assert.equal(state.auditLookup, null);

  const failed = reduceFamily(state, { type: 'DETAIL_FAIL', failure: { ok: false, kind: 'not_found', status: 404, code: 'NOT_FOUND' } });
  assert.equal(failed.detailPhase, 'error');
  assert.equal(failed.detail, null);
});

test('行视图：状态列用 visibility 的中文标签，知识行如实写「契约未提供」时间', () => {
  const row = sourceRow(sourceDraft(ID_A, 7, { visibility: 'hidden' }));
  assert.equal(row.statusLabel, '已下架');
  assert.equal(row.statusTone, 'warn');
  assert.equal(row.revisionLabel, '"7"');
  assert.equal(row.updatedLabel, '2026-01-02 11:04'.length > 0 ? row.updatedLabel : '');
  assert.match(row.updatedLabel, /^2026-01-02 \d{2}:\d{2}$/);
  assert.equal(row.kindLabel, '人工核验种子');
  assert.equal(row.evidenceLabel, '混合');

  const knowledge = knowledgeRow({
    id: ID_A,
    revision: 1,
    visibility: 'published',
    review_status: 'verified',
    content: { type: 'scheme', title: '方案', body: 'x', source_id: ID_B, source_version: '2026.1', conditions: null, formulation_id: null },
  });
  assert.equal(knowledge.statusLabel, '已发布');
  assert.equal(knowledge.statusTone, 'ok');
  assert.equal(knowledge.typeLabel, '方案');
  assert.equal(knowledge.updatedLabel, '契约未提供');

  const category = categoryRow({ id: 'crop-rice', revision: 2, type: 'crop', name: '水稻', description: '示例', active: false });
  assert.equal(category.statusLabel, '停用');
  assert.equal(category.versionLabel, '作物');
});

test('详情视图：列出读面真有的字段，并点明读面缺失项（不伪造）', () => {
  const source = sourceDetailView(sourceDraft(ID_A, 4));
  assert.equal(source.etag, '"4"');
  assert.equal(source.fields.some((f) => f.label === '当前修订（If-Match）' && f.value === '"4"'), true);
  assert.equal(source.missing.includes('content_hash'), true);
  assert.equal(source.missing.includes('操作者'), true);

  const knowledge = knowledgeDetailView({
    id: ID_A,
    revision: 2,
    visibility: 'private',
    review_status: 'unverified',
    content: { type: 'species', title: '稗草', body: '正文', source_id: ID_B, source_version: '2026.1', conditions: null, formulation_id: null },
  });
  assert.equal(knowledge.fields.some((f) => f.label === '条件' && f.value === '无（null）'), true);

  const category = categoryDetailView({ id: 'crop-rice', revision: 1, type: 'crop', name: '水稻', description: '示例', active: true });
  assert.equal(category.note.includes('类型不可改'), true);
});

test('写回执：成功/失败都带 request_id 与真实发出的写头；失败额外带错误码', () => {
  const success = receiptLines({
    label: '发布资料来源',
    ok: true,
    status: 200,
    requestUrl: '/api/v1/admin/sources/x/publish',
    requestId: '00000000-0000-4000-9000-000000000009',
    etag: '"5"',
    sentHeaders: { 'idempotency-key': 'key-1', 'if-match': '"4"' },
    // 显式判定「确实改动了」：成功文案只在这个前提下出现（缺省是 unknown ⇒ 只写「已受理」）。
    changed: true,
  });
  const asMap = Object.fromEntries(success.map((line) => [line.label, line.value]));
  assert.equal(asMap['结果'], '成功（HTTP 200）');
  assert.equal(asMap['request_id（审计关联键）'], '00000000-0000-4000-9000-000000000009');
  assert.equal(asMap['发出的 If-Match'], '"4"');
  assert.equal(asMap['发出的 Idempotency-Key'], 'key-1');
  assert.equal(asMap['响应 ETag'], '"5"');

  const failure = receiptLines({
    label: '编辑资料来源',
    ok: false,
    status: 409,
    code: 'REVISION_CONFLICT',
    inContract: true,
    message: '服务端说明',
    requestUrl: '/api/v1/admin/sources/x',
    requestId: null,
    sentHeaders: { 'idempotency-key': 'key-2', 'if-match': '"3"' },
  });
  const failMap = Object.fromEntries(failure.map((line) => [line.label, line.value]));
  assert.equal(failMap['结果'], '失败（HTTP 409）');
  assert.equal(failMap['错误码'], 'REVISION_CONFLICT');
  assert.equal(failMap['服务端说明'], '服务端说明');
  assert.equal(failMap['request_id（审计关联键）'], '服务端未返回');
  assert.equal(failMap['发出的 If-Match'], '"3"');

  // 契约没有 audit event id：回执里不得出现「审计事件 ID」这种不存在的字段
  assert.equal(success.some((line) => line.label.includes('audit') || line.label.includes('审计事件')), false);
  assert.equal(AUDIT_SCOPE_NOTE.includes('没有 audit event id'), true);
});

test('写回执的判定是三值、缺省一律 unknown：回执没带布尔 changed 时只写「已受理」', () => {
  // 映射：只有真 `true` / 真 `false` 才给出确定判定，其余（含 undefined）都是 unknown。
  assert.equal(changedVerdict(true), 'changed');
  assert.equal(changedVerdict(false), 'unchanged');
  assert.equal(changedVerdict(null), 'unknown');
  assert.equal(changedVerdict(undefined), 'unknown');
  assert.equal(changedVerdict('true'), 'unknown', '字符串不得被当成 true（不做隐式推断）');

  const settled = {
    phase: 'settled',
    label: '发布注册资料（POST /admin/registrations/{id}/publish）',
    ok: true,
    status: 200,
    requestUrl: '/api/v1/admin/registrations/x/publish',
    requestId: '00000000-0000-4000-9000-00000000000a',
    sentHeaders: { 'idempotency-key': 'key-1', 'if-match': '"2"' },
    changed: null,
  };
  const unknownLines = Object.fromEntries(receiptLines(settled).map((line) => [line.label, line.value]));
  assert.equal(unknownLines['结果'], '已受理（HTTP 200 · 是否生效未确认）', 'changed 未知时不得写「成功」');
  assert.equal(receiptHeading(settled, 'unknown'), '写操作已受理回执');
  assert.doesNotMatch(JSON.stringify(receiptLines(settled)), /成功/, '未知判定下整份回执都不得出现「成功」二字');

  // 显式判定优先于 write.changed（调用方给什么就写什么，本函数不自己猜）。
  assert.equal(receiptHeading(settled, 'changed'), '写操作成功回执');
  assert.equal(Object.fromEntries(receiptLines(settled, { verdict: 'changed' }).map((line) => [line.label, line.value]))['结果'], '成功（HTTP 200）');

  // unchanged（编辑回传同一 revision，多为同一幂等键重放）：请求**确实被受理**，但 revision 没动
  // ⇒ 不得带入「成功」字样，否则与 outcome 的「未追加新修订…不记为本次成功」同一屏互相打脸。
  assert.equal(receiptHeading(settled, 'unchanged'), '写操作已受理回执（本次未产生变更）', 'unchanged 不得写「成功回执」');
  assert.doesNotMatch(receiptHeading(settled, 'unchanged'), /成功/);
  const unchangedLines = Object.fromEntries(receiptLines(settled, { verdict: 'unchanged' }).map((line) => [line.label, line.value]));
  assert.equal(unchangedLines['结果'], '已受理（HTTP 200 · 本次未产生变更）', 'unchanged 的结果行不得写「成功（HTTP 200）」');
  assert.match(unchangedLines['结果'], /已受理/);
  assert.match(unchangedLines['结果'], /本次未产生变更/);
  assert.doesNotMatch(JSON.stringify(receiptLines(settled, { verdict: 'unchanged' })), /成功/, 'unchanged 下整份回执都不得出现「成功」二字');
  // 本片只改 unchanged 一档：unknown 档的措辞必须原样保留。
  assert.equal(Object.fromEntries(receiptLines(settled, { verdict: 'unknown' }).map((line) => [line.label, line.value]))['结果'], '已受理（HTTP 200 · 是否生效未确认）');

  // 失败优先于三值：非 2xx 一律失败文案（不因为 changed 未知而写成「已受理」）。
  const failedWrite = { phase: 'settled', label: '撤回注册资料', ok: false, status: 409, changed: null };
  assert.equal(receiptHeading(failedWrite, 'unknown'), '写操作失败回执');
  assert.equal(Object.fromEntries(receiptLines(failedWrite).map((line) => [line.label, line.value]))['结果'], '失败（HTTP 409）');

  // 三态之外的两态：进行中 / 无回执。
  assert.equal(receiptHeading({ phase: 'pending', label: '' }, 'unknown'), '写操作进行中…');
  assert.equal(receiptHeading(null, 'unknown'), '');
});

test('审计查找：找不到时只说扫了多少条，明说「不等于没有审计记录」', () => {
  assert.equal(describeAuditLookup(null), null);
  const loading = describeAuditLookup({ phase: 'loading' });
  assert.equal(loading.title, '正在读取审计台账…');

  const notFound = describeAuditLookup({ phase: 'ready', events: [], scanned: 250, truncated: true });
  assert.equal(notFound.tone, 'stale');
  assert.equal(notFound.title.includes('没有匹配'), true);
  assert.equal(notFound.detail.includes('这不等于「没有审计记录」'), true);
  assert.equal(notFound.detail.includes('扫描上限'), true);

  const found = describeAuditLookup({
    phase: 'ready',
    events: [{ id: ID_A, action: 'source.edit', scope: 'sources:write', target_ref: null, reason_code: 'revision_appended', request_id: ID_B, result: 'accepted', created_at: '2026-01-02T03:04:05Z' }],
    scanned: 3,
    truncated: false,
  });
  assert.equal(found.tone, 'ready');
  assert.equal(found.title, '找到 1 条审计事件');

  const error = describeAuditLookup({ phase: 'error', failure: { code: 'SCOPE_DENIED', status: 403, message: 'x' } });
  assert.equal(error.tone, 'error');
  assert.equal(error.detail.includes('SCOPE_DENIED'), true);
});

test('selectors：时间格式化不猜、标签表覆盖契约全部枚举', () => {
  assert.equal(formatDateTime('2026-01-02T03:04:05.000Z').length, 16);
  assert.equal(formatDateTime('not-a-date'), 'not-a-date');
  assert.equal(formatDateTime(''), '—');
  assert.equal(formatDateTime(null), '—');
  assert.deepEqual(selfCheckLabelCoverage(), []);
});
