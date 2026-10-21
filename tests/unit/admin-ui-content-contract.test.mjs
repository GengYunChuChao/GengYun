/**
 * 后台「资料管理」契约层单测：`apps/admin/src/lib/admin-content-contract.mjs`。
 *
 * 只测纯函数（表单 → 请求体、响应形状校验、If-Match／幂等键的口径）。
 * 每一条断言都对得上 `packages/contracts/openapi.json` 里的具体约束，改契约时这里会先坏。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  IF_MATCH_PATTERN,
  buildCategoryInput,
  buildKnowledgeInput,
  buildPublishInput,
  buildSourceInput,
  buildWithdrawInput,
  dateTimeFromLocal,
  dateTimeToLocal,
  emptyKnowledgeForm,
  emptySourceForm,
  etagFor,
  isDateTime,
  knowledgeFormFromDetail,
  newIdempotencyKey,
  normalizeIdempotencyKey,
  sourceFormFromRef,
  validateAuditEvent,
  validateCategory,
  validateKnowledgeDraft,
  validatePage,
  validateSourceDraft,
} from '../../apps/admin/src/lib/admin-content-contract.mjs';

const UUID = '00000000-0000-4000-8000-000000000001';
const HASH = 'a'.repeat(64);

function validSourceDraft(overrides = {}) {
  return {
    id: UUID,
    revision: 3,
    visibility: 'private',
    source: {
      id: UUID,
      version: '2026.1',
      title: '水稻田稗草防治技术要点',
      url: 'https://example.org/source',
      publisher: '示例出版社',
      source_kind: 'database',
      evidence_kind: 'research',
      validity: 'valid',
      review_status: 'unverified',
      updated_at: '2026-01-02T03:04:05.000Z',
    },
    ...overrides,
  };
}

test('etagFor：强 ETag 带双引号，非法 revision 直接抛错（不发必败请求）', () => {
  assert.equal(etagFor(1), '"1"');
  assert.equal(etagFor(42), '"42"');
  assert.equal(IF_MATCH_PATTERN.test(etagFor(42)), true);
  for (const bad of [0, -1, 1.5, Number.NaN, '3', null, undefined]) {
    assert.throws(() => etagFor(bad), RangeError, `revision=${String(bad)} 应被拒绝`);
  }
  // 契约 pattern 不允许 * 与无引号形态
  assert.equal(IF_MATCH_PATTERN.test('*'), false);
  assert.equal(IF_MATCH_PATTERN.test('3'), false);
  assert.equal(IF_MATCH_PATTERN.test('"0"'), false);
});

test('Idempotency-Key：8..128 字符边界；生成的键长度合规且每次不同', () => {
  assert.equal(normalizeIdempotencyKey('short7!'), null);
  assert.equal(normalizeIdempotencyKey('12345678'), '12345678');
  assert.equal(normalizeIdempotencyKey('x'.repeat(128)), 'x'.repeat(128));
  assert.equal(normalizeIdempotencyKey('x'.repeat(129)), null);
  assert.equal(normalizeIdempotencyKey(null), null);

  const a = newIdempotencyKey();
  const b = newIdempotencyKey();
  assert.notEqual(a, b);
  assert.equal(a.length >= 8 && a.length <= 128, true);
  assert.match(a, /^admin-content-[0-9a-f]{32}$/);
});

test('date-time：RFC 3339 带时区才算合法；datetime-local 双向转换可回到原值', () => {
  assert.equal(isDateTime('2026-01-02T03:04:05.000Z'), true);
  assert.equal(isDateTime('2026-01-02T03:04:05+08:00'), true);
  assert.equal(isDateTime('2026-01-02T03:04'), false); // 无秒、无时区
  assert.equal(isDateTime('2026-01-02'), false);
  assert.equal(isDateTime(''), false);

  assert.equal(dateTimeFromLocal(''), null);
  assert.equal(dateTimeFromLocal('not-a-time'), null);
  const local = '2026-03-04T05:06';
  const iso = dateTimeFromLocal(local);
  assert.equal(isDateTime(iso), true);
  assert.equal(dateTimeToLocal(iso), local);
  assert.equal(dateTimeToLocal(''), '');
  assert.equal(dateTimeToLocal('2026-13-99'), '');
});

test('buildSourceInput：10 个必填字段逐项校验（含 64 位小写指纹与 https 链接）', () => {
  const form = {
    ...emptySourceForm(),
    title: '  水稻田稗草防治技术要点  ',
    url: 'https://example.org/source',
    publisher: '示例出版社',
    source_kind: 'database',
    evidence_kind: 'research',
    version: '2026.1',
    content_hash: HASH,
    locator: 'p12-l34',
    valid_from: '2026-01-02T03:04',
    valid_to: '',
  };
  const ok = buildSourceInput(form);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.value.title, '水稻田稗草防治技术要点'); // 去首尾空白
  assert.equal(ok.value.content_hash, HASH);
  assert.equal(ok.value.valid_to, null); // 空 = 显式 null（契约 anyOf null）

  const uppercaseHash = buildSourceInput({ ...form, content_hash: HASH.toUpperCase() });
  assert.equal(uppercaseHash.ok, false);
  assert.deepEqual(uppercaseHash.errors.map((e) => e.field), ['content_hash']);

  const httpUrl = buildSourceInput({ ...form, url: 'http://example.org/source' });
  assert.equal(httpUrl.ok, false);
  assert.deepEqual(httpUrl.errors.map((e) => e.field), ['url']);

  const inverted = buildSourceInput({ ...form, valid_to: '2025-01-01T00:00' });
  assert.equal(inverted.ok, false);
  assert.deepEqual(inverted.errors.map((e) => e.field), ['valid_to']);

  const missingFrom = buildSourceInput({ ...form, valid_from: '' });
  assert.equal(missingFrom.ok, false);
  assert.deepEqual(missingFrom.errors.map((e) => e.field), ['valid_from']);

  const tooLong = buildSourceInput({ ...form, title: 'x'.repeat(201) });
  assert.equal(tooLong.ok, false);
  assert.deepEqual(tooLong.errors.map((e) => e.field), ['title']);
});

test('sourceFormFromRef：只回填读面真有的字段，不替用户猜指纹/定位/有效期', () => {
  const form = sourceFormFromRef(validSourceDraft().source);
  assert.equal(form.title, '水稻田稗草防治技术要点');
  assert.equal(form.version, '2026.1');
  assert.equal(form.content_hash, '');
  assert.equal(form.locator, '');
  assert.equal(form.valid_from, '');
  assert.equal(form.valid_to, '');
  assert.equal(sourceFormFromRef(null).title, '');
});

test('buildKnowledgeInput：未勾选条件时 conditions 显式为 null；勾选时 crop_id/region_code 必填', () => {
  const base = {
    ...emptyKnowledgeForm(),
    type: 'species',
    title: '稗草识别',
    body: '正文',
    source_id: UUID,
    source_version: '2026.1',
  };
  const plain = buildKnowledgeInput(base);
  assert.equal(plain.ok, true, JSON.stringify(plain.errors));
  assert.equal(plain.value.conditions, null);
  assert.equal(plain.value.formulation_id, null);

  const withConditions = buildKnowledgeInput({ ...base, with_conditions: true, crop_id: 'crop-rice', region_code: '330100', growth_stage: '' });
  assert.equal(withConditions.ok, true, JSON.stringify(withConditions.errors));
  assert.deepEqual(withConditions.value.conditions, { crop_id: 'crop-rice', region_code: '330100' });

  const badRegion = buildKnowledgeInput({ ...base, with_conditions: true, crop_id: 'crop-rice', region_code: '440100' });
  assert.equal(badRegion.ok, false);
  assert.deepEqual(badRegion.errors.map((e) => e.field), ['region_code']);

  const noCrop = buildKnowledgeInput({ ...base, with_conditions: true, region_code: '330100' });
  assert.equal(noCrop.ok, false);
  assert.deepEqual(noCrop.errors.map((e) => e.field), ['crop_id']);

  const badSource = buildKnowledgeInput({ ...base, source_id: 'not-a-uuid' });
  assert.equal(badSource.ok, false);
  assert.deepEqual(badSource.errors.map((e) => e.field), ['source_id']);
});

test('knowledgeFormFromDetail：能完整回填（KnowledgeDraft.content 是完整输入体）', () => {
  const draft = {
    id: UUID,
    revision: 2,
    visibility: 'published',
    review_status: 'unverified',
    content: {
      type: 'scheme',
      title: '方案',
      body: '正文',
      source_id: UUID,
      source_version: '2026.1',
      conditions: { crop_id: 'crop-rice', region_code: '330100' },
      formulation_id: null,
    },
  };
  const form = knowledgeFormFromDetail(draft);
  assert.equal(form.type, 'scheme');
  assert.equal(form.with_conditions, true);
  assert.equal(form.crop_id, 'crop-rice');
  assert.equal(form.region_code, '330100');
  assert.equal(form.formulation_id, '');
  assert.equal(knowledgeFormFromDetail(null).type, 'species');
});

test('buildCategoryInput / buildPublishInput / buildWithdrawInput：必填与长度边界', () => {
  assert.equal(buildCategoryInput({ name: '水稻', description: '示例', active: true }).ok, true);
  assert.deepEqual(buildCategoryInput({ name: '', description: '示例', active: true }).errors.map((e) => e.field), ['name']);
  assert.deepEqual(buildCategoryInput({ name: '水稻', description: '', active: true }).errors.map((e) => e.field), ['description']);
  assert.deepEqual(buildCategoryInput({ name: '水稻', description: '示例', active: 'yes' }).errors.map((e) => e.field), ['active']);

  assert.equal(buildPublishInput({ evidenceRef: 'ev-1', reason: '资料已核验' }).ok, true);
  assert.deepEqual(buildPublishInput({ evidenceRef: '', reason: 'x' }).errors.map((e) => e.field), ['evidence_ref']);
  assert.deepEqual(buildPublishInput({ evidenceRef: 'ev-1', reason: 'x'.repeat(501) }).errors.map((e) => e.field), ['reason']);

  assert.equal(buildWithdrawInput({ reason: '来源过期' }).ok, true);
  assert.deepEqual(buildWithdrawInput({ reason: '   ' }).errors.map((e) => e.field), ['reason']);
});

test('validateSourceDraft：缺字段/枚举越界即判畸形响应；契约外字段只记 warning', () => {
  assert.equal(validateSourceDraft(validSourceDraft()).ok, true);

  const badRevision = validateSourceDraft(validSourceDraft({ revision: 0 }));
  assert.equal(badRevision.ok, false);
  assert.equal(badRevision.errors.some((e) => e.path === '$.revision'), true);

  const badVisibility = validateSourceDraft(validSourceDraft({ visibility: 'draft' }));
  assert.equal(badVisibility.ok, false);
  assert.equal(badVisibility.errors.some((e) => e.path === '$.visibility'), true);

  const badUrl = validateSourceDraft({ ...validSourceDraft(), source: { ...validSourceDraft().source, url: 'http://x.org/a' } });
  assert.equal(badUrl.ok, false);

  const extra = validateSourceDraft({ ...validSourceDraft(), lifecycle: 'draft' });
  assert.equal(extra.ok, true);
  assert.equal(extra.warnings.some((w) => w.path === '$.lifecycle'), true);
});

test('validateKnowledgeDraft / validateCategory / validateAuditEvent：读面形状与 target_ref 可空', () => {
  const knowledge = {
    id: UUID,
    revision: 1,
    visibility: 'private',
    review_status: 'unverified',
    content: {
      type: 'species',
      title: '稗草',
      body: '正文',
      source_id: UUID,
      source_version: '2026.1',
      conditions: null,
      formulation_id: null,
    },
  };
  assert.equal(validateKnowledgeDraft(knowledge).ok, true);
  assert.equal(validateKnowledgeDraft({ ...knowledge, content: { ...knowledge.content, type: 'video' } }).ok, false);

  assert.equal(validateCategory({ id: 'crop-rice', revision: 1, type: 'crop', name: '水稻', description: '示例', active: true }).ok, true);
  assert.equal(validateCategory({ id: 'crop-rice', revision: 1, type: 'pest', name: '水稻', description: '示例', active: true }).ok, false);

  const audit = {
    id: UUID,
    action: 'source.edit',
    scope: 'sources:write',
    target_ref: null,
    reason_code: 'revision_appended',
    request_id: UUID,
    result: 'accepted',
    created_at: '2026-01-02T03:04:05Z',
  };
  assert.equal(validateAuditEvent(audit).ok, true);
  assert.equal(validateAuditEvent({ ...audit, target_ref: 'source:x' }).ok, false);
  assert.equal(validateAuditEvent({ ...audit, result: 'ok' }).ok, false);
});

test('validatePage：next_cursor 必须显式出现（null 才是末页）', () => {
  const row = validSourceDraft();
  assert.equal(validatePage({ items: [row], next_cursor: null }, validateSourceDraft).ok, true);
  assert.equal(validatePage({ items: [row], next_cursor: 'abc' }, validateSourceDraft).nextCursor, 'abc');

  const missing = validatePage({ items: [row] }, validateSourceDraft);
  assert.equal(missing.ok, false);
  assert.equal(missing.errors.some((e) => e.path === '$.next_cursor'), true);

  const tooLong = validatePage({ items: [row], next_cursor: 'x'.repeat(2049) }, validateSourceDraft);
  assert.equal(tooLong.ok, false);

  const badRow = validatePage({ items: [validSourceDraft({ revision: 0 })], next_cursor: null }, validateSourceDraft);
  assert.equal(badRow.ok, false);
  assert.equal(badRow.errors[0].path, '$.items[0].revision');
});
