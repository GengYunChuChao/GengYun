/**
 * GY-I18 阶段 1 测试夹具（**不是测试文件**：文件名不以 .test.mjs 结尾，
 * 因此不会被 `node --test "tests/unit/*.test.mjs"` 收集执行）。
 *
 * 这里刻意把「四类资料」的差异也收敛成一份表：如果哪天四类资料需要各自一套代码，
 * 这张表会先崩，而不是让四份复制粘贴悄悄分叉。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAdminContentStore } from '../../services/api/src/admin/store.ts';
import { createAdminContentService } from '../../services/api/src/admin/service.ts';
import { createAdminPublicView } from '../../services/api/src/admin/public-view.ts';
import { collectIssues } from '../../services/api/src/admin/fields.ts';
import {
  KNOWLEDGE_FAMILY,
  REGISTRATION_FAMILY,
  RESTRICTION_FAMILY,
  SOURCE_FAMILY,
} from '../../services/api/src/admin/families.ts';

export const SIGNING_KEY = 'gy-i18-phase1-test-signing-key-0123456789';
export const STEWARD = '11111111-1111-4111-8111-111111111111';
export const OTHER_STEWARD = '22222222-2222-4222-8222-222222222222';

let keyCounter = 0;
/** 契约要求 Idempotency-Key 8..128 字符；这里保证每次不同，避免用例之间互相重放。 */
export function idempotencyKey(label = 'k') {
  keyCounter += 1;
  return `gy-i18-${label}-${String(keyCounter).padStart(6, '0')}-${randomUUID().slice(0, 8)}`;
}

/**
 * 自动前进的确定性时钟：每次 `now()` 前进 stepMs。
 * 默认 1 秒 ⇒ 审计事件的 created_at 严格递增，"按时间可读"可以被真正断言；
 * 需要构造「游标已过期」时把 stepMs 开到 15 分钟以上即可。
 */
export function createClock(startIso = '2026-10-12T00:00:00.000Z', stepMs = 1000) {
  let current = Date.parse(startIso);
  return {
    now() {
      const value = new Date(current);
      current += stepMs;
      return value;
    },
    peek: () => new Date(current),
  };
}

export function adminIdentity(overrides = {}) {
  return {
    userId: STEWARD,
    authEpoch: 1,
    role: 'admin',
    scopes: ['sources:read', 'sources:write', 'audit:read'],
    ...overrides,
  };
}

export function userIdentity(overrides = {}) {
  return { userId: STEWARD, authEpoch: 1, role: 'user', scopes: ['user'], ...overrides };
}

export function context(overrides = {}) {
  return { identity: adminIdentity(), ...overrides };
}

/** 建一个自包含的服务 + store + 公开读口径。 */
export function createHarness({ stepMs = 1000, store = createAdminContentStore() } = {}) {
  const clock = createClock('2026-10-12T00:00:00.000Z', stepMs);
  const service = createAdminContentService({ store, now: clock.now, signingKey: SIGNING_KEY });
  return { service, store, clock, view: createAdminPublicView(store) };
}

// ---------------------------------------------------------------------------
// 契约合法的四类入参
// ---------------------------------------------------------------------------

export function validSourceInput(overrides = {}) {
  return {
    title: '浙江省水稻田稗草防治技术指导意见',
    url: 'https://example.invalid/agri/rice-barnyardgrass',
    publisher: '示例出版单位',
    source_kind: 'verified_seed',
    evidence_kind: 'research',
    version: '2026-09',
    content_hash: 'a'.repeat(64),
    locator: 'p.12 §3.2',
    valid_from: '2026-09-01T00:00:00.000Z',
    valid_to: null,
    ...overrides,
  };
}

export function validConditions(overrides = {}) {
  return { crop_id: 'rice', region_code: '330100', ...overrides };
}

export function validKnowledgeInput(overrides = {}) {
  return {
    type: 'herbicide',
    title: '示例除草剂在水稻田的使用要点',
    body: '本文仅为结构性示例正文，不含用量绑定，也不含适用性判定结论。',
    source_id: randomUUID(),
    source_version: '2026-09',
    conditions: validConditions(),
    formulation_id: null,
    ...overrides,
  };
}

export function validRegistrationInput(overrides = {}) {
  return {
    formulation: {
      registration_number: 'PD20260001',
      producer: '示例农药生产企业',
      dosage_form: '乳油',
      ingredients: [{ name: '有效成分A', content_text: '10%', unit_text: '质量分数' }],
    },
    source_id: randomUUID(),
    source_version: '2026-09',
    registered_name: '示例登记制剂',
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_to: null,
    ...overrides,
  };
}

export function validRestrictionInput(overrides = {}) {
  return {
    source_id: randomUUID(),
    source_version: '2026-09',
    formulation_id: null,
    conditions: validConditions(),
    effect: 'restricted',
    reason: '示例限制条件说明（结构性文本，不代表真实监管结论）。',
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_to: null,
    ...overrides,
  };
}

export function validPublishBody(overrides = {}) {
  return { evidence_ref: 'EVID-2026-09-001', reason: '核验通过，登记结构性门槛满足', ...overrides };
}

export function validWithdrawBody(overrides = {}) {
  return { reason: '来源版本已更新，撤回当前已发布修订', ...overrides };
}

// ---------------------------------------------------------------------------
// 四类资料的统一调用表（测试对它做参数化，避免四份复制）
// ---------------------------------------------------------------------------

/**
 * 每个条目把「四类资料」的调用面统一成同一组函数。
 * `contentInput()` 返回契约合法入参；`editedInput()` 返回**改过正文**的合法入参。
 */
export const FAMILY_CASES = [
  {
    name: 'sources',
    descriptor: SOURCE_FAMILY,
    inputSchema: 'SourceDraftInput',
    noun: 'source',
    subjectKey: 'source',
    contentInput: validSourceInput,
    editedInput: () => validSourceInput({ title: '浙江省水稻田稗草防治技术指导意见（第二稿）' }),
    ops: (service) => ({
      list: (ctx, query) => service.listAdminSources(ctx, query),
      create: (ctx, body) => service.createSourceDraft(ctx, body),
      get: (ctx, id) => service.getAdminSource(ctx, id),
      edit: (ctx, id, body) => service.editSourceDraft(ctx, id, body),
      publish: (ctx, id, body) => service.publishSource(ctx, id, body),
      withdraw: (ctx, id, body) => service.withdrawSource(ctx, id, body),
    }),
    operationIds: ['listAdminSources', 'createSourceDraft', 'getAdminSource', 'editSourceDraft', 'publishSource', 'withdrawSource'],
    contractPaths: [
      'GET /admin/sources',
      'POST /admin/sources',
      'GET /admin/sources/{id}',
      'PATCH /admin/sources/{id}',
      'POST /admin/sources/{id}/publish',
      'POST /admin/sources/{id}/withdraw',
    ],
  },
  {
    name: 'knowledge',
    descriptor: KNOWLEDGE_FAMILY,
    inputSchema: 'KnowledgeDraftInput',
    noun: 'knowledge',
    subjectKey: 'knowledge',
    contentInput: validKnowledgeInput,
    editedInput: () => validKnowledgeInput({ body: '第二稿正文：仍不含用量绑定与适用性判定。' }),
    ops: (service) => ({
      list: (ctx, query) => service.listAdminKnowledge(ctx, query),
      create: (ctx, body) => service.createKnowledgeDraft(ctx, body),
      get: (ctx, id) => service.getAdminKnowledge(ctx, id),
      edit: (ctx, id, body) => service.editKnowledgeDraft(ctx, id, body),
      publish: (ctx, id, body) => service.publishKnowledge(ctx, id, body),
      withdraw: (ctx, id, body) => service.withdrawKnowledge(ctx, id, body),
    }),
    operationIds: ['listAdminKnowledge', 'createKnowledgeDraft', 'getAdminKnowledge', 'editKnowledgeDraft', 'publishKnowledge', 'withdrawKnowledge'],
    contractPaths: [
      'GET /admin/knowledge',
      'POST /admin/knowledge',
      'GET /admin/knowledge/{id}',
      'PATCH /admin/knowledge/{id}',
      'POST /admin/knowledge/{id}/publish',
      'POST /admin/knowledge/{id}/withdraw',
    ],
  },
  {
    name: 'registrations',
    descriptor: REGISTRATION_FAMILY,
    inputSchema: 'RegistrationDraftInput',
    noun: 'registration',
    subjectKey: 'registration',
    contentInput: validRegistrationInput,
    editedInput: () => validRegistrationInput({ registered_name: '示例登记制剂（第二稿）' }),
    ops: (service) => ({
      list: (ctx, query) => service.listAdminRegistration(ctx, query),
      create: (ctx, body) => service.createRegistrationDraft(ctx, body),
      get: (ctx, id) => service.getAdminRegistration(ctx, id),
      edit: (ctx, id, body) => service.editRegistrationDraft(ctx, id, body),
      publish: (ctx, id, body) => service.publishRegistration(ctx, id, body),
      withdraw: (ctx, id, body) => service.withdrawRegistration(ctx, id, body),
    }),
    operationIds: ['listAdminRegistration', 'createRegistrationDraft', 'getAdminRegistration', 'editRegistrationDraft', 'publishRegistration', 'withdrawRegistration'],
    contractPaths: [
      'GET /admin/registrations',
      'POST /admin/registrations',
      'GET /admin/registrations/{id}',
      'PATCH /admin/registrations/{id}',
      'POST /admin/registrations/{id}/publish',
      'POST /admin/registrations/{id}/withdraw',
    ],
  },
  {
    name: 'restrictions',
    descriptor: RESTRICTION_FAMILY,
    inputSchema: 'RestrictionInput',
    noun: 'restriction',
    subjectKey: 'restriction',
    contentInput: validRestrictionInput,
    editedInput: () => validRestrictionInput({ reason: '第二稿限制条件说明（结构性文本）。' }),
    ops: (service) => ({
      list: (ctx, query) => service.listAdminRestriction(ctx, query),
      create: (ctx, body) => service.createRestrictionDraft(ctx, body),
      get: (ctx, id) => service.getAdminRestriction(ctx, id),
      edit: (ctx, id, body) => service.editRestrictionDraft(ctx, id, body),
      publish: (ctx, id, body) => service.publishRestriction(ctx, id, body),
      withdraw: (ctx, id, body) => service.withdrawRestriction(ctx, id, body),
    }),
    operationIds: ['listAdminRestriction', 'createRestrictionDraft', 'getAdminRestriction', 'editRestrictionDraft', 'publishRestriction', 'withdrawRestriction'],
    contractPaths: [
      'GET /admin/restrictions',
      'POST /admin/restrictions',
      'GET /admin/restrictions/{id}',
      'PATCH /admin/restrictions/{id}',
      'POST /admin/restrictions/{id}/publish',
      'POST /admin/restrictions/{id}/withdraw',
    ],
  },
];

// ---------------------------------------------------------------------------
// 断言帮手
// ---------------------------------------------------------------------------

/** 先判 typeof，再判值：契约错误必须是 ApiError 形状（code 字符串 + status 数字）。 */
export async function expectApiError(thunk, code) {
  try {
    await thunk();
  } catch (error) {
    assert.equal(typeof error?.code, 'string', `期望 ApiError.code 是字符串，实际 ${typeof error?.code}`);
    assert.equal(error.code, code);
    assert.equal(typeof error?.status, 'number', '期望 ApiError.status 是数字');
    assert.equal(typeof error?.message, 'string');
    return error;
  }
  assert.fail(`期望抛出 ${code}，但调用成功了`);
}

/** 用契约镜像表校验响应体：返回问题列表（空数组 = 与契约同形）。 */
export function contractIssues(specName, value) {
  return collectIssues(specName, value);
}

export function assertMatchesContract(specName, value, label = specName) {
  const issues = contractIssues(specName, value);
  assert.deepEqual(issues, [], `${label} 与契约 ${specName} 不同形：${JSON.stringify(issues)}`);
}

/** 建草稿：自动带上合法的 Idempotency-Key。 */
export async function createDraft(caseEntry, service, ctx = context(), body) {
  const ops = caseEntry.ops(service);
  return ops.create({ ...ctx, idempotencyKey: idempotencyKey(`${caseEntry.name}-create`) }, body ?? caseEntry.contentInput());
}

/** 发布指定修订：自动带上合法的 Idempotency-Key 与 If-Match。 */
export async function publishRevision(caseEntry, service, id, revision, ctx = context(), body = validPublishBody()) {
  const ops = caseEntry.ops(service);
  return ops.publish({ ...ctx, idempotencyKey: idempotencyKey(`${caseEntry.name}-publish`), ifMatch: `"${revision}"` }, id, body);
}

/** 撤回指定修订：自动带上合法的 Idempotency-Key 与 If-Match。 */
export async function withdrawRevision(caseEntry, service, id, revision, ctx = context(), body = validWithdrawBody()) {
  const ops = caseEntry.ops(service);
  return ops.withdraw({ ...ctx, idempotencyKey: idempotencyKey(`${caseEntry.name}-withdraw`), ifMatch: `"${revision}"` }, id, body);
}

/** 编辑指定修订：自动带上合法的 Idempotency-Key 与 If-Match。 */
export async function editRevision(caseEntry, service, id, revision, body, ctx = context()) {
  const ops = caseEntry.ops(service);
  return ops.edit({ ...ctx, idempotencyKey: idempotencyKey(`${caseEntry.name}-edit`), ifMatch: `"${revision}"` }, id, body);
}
