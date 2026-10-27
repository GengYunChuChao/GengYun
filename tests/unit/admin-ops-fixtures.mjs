/**
 * GY-I18 阶段 1b · 后台运营与开关测试夹具（**不是测试文件**）。
 *
 * 刻意**复用** #15 的社区夹具（`tests/unit/community-fixtures.mjs`）来造"已发布+已审核"的帖子：
 * `hidePost` 的验收必须在社区自己的读口径上断言，而不是在 admin 里自证。
 */
import assert from 'node:assert/strict';
import { createAdminOpsService, OPS_SCOPES, OPS_OPERATION_IDS } from '../../services/api/src/admin/ops/service.ts';
import { createAdminOpsStore } from '../../services/api/src/admin/ops/store.ts';
import { createMemoryAdminJobPort, createUnwiredAdminJobPort } from '../../services/api/src/admin/ops/jobs.ts';
import { opsValidator, OPS_ALL_SPECS } from '../../services/api/src/admin/ops/fields.ts';
import {
  ADMIN as COMMUNITY_ADMIN,
  USER_A,
  USER_B,
  idem,
  makeHarness as makeCommunityHarness,
  publishPost,
} from './community-fixtures.mjs';

export { USER_A, USER_B, idem, makeCommunityHarness, publishPost, COMMUNITY_ADMIN, OPS_SCOPES, OPS_OPERATION_IDS };

export const OPS_SIGNING_KEY = 'gy-i18-phase1b-test-signing-key-0123456789';

/** 本片全部 10 个操作所需的 scope 全集（R37 `#18` S2 读面加了 `scopes:read`，PR-3 写面加了 `scopes:write`）。 */
export const ALL_OPS_SCOPES = Object.freeze([
  'sources:read',
  'sources:write',
  'accounts:read',
  'accounts:suspend',
  'jobs:read',
  'jobs:cancel',
  'flags:read',
  'flags:write',
  'scopes:read',
  'scopes:write',
]);

/**
 * 本片 18 个 operationId（10 个既有 + R37 `#18` S2 读面 2 个 + S3 人工通过/驳回 2 个
 * + `#18` S2 PR-3 管理员 scope 写面 2 个 + R68 账号停用/恢复 2 个）。
 */
export const OPS_IDS = Object.freeze([
  'listAdminCategories',
  'editCategory',
  'listAdminUsers',
  'suspendUser',
  'listAdminJobs',
  'cancelAdminJob',
  'listFlags',
  'setFlag',
  'listFlagAuditEvents',
  'hidePost',
  'listAdministrators',
  'listAdministratorScopes',
  'approvePost',
  'rejectPost',
  'grantAdministratorScope',
  'revokeAdministratorScope',
  'disableAdministratorAccount',
  'enableAdministratorAccount',
]);

/** 派单显式不做的 operationId（不得在本片出现）。 */
export const OPS_OUT_OF_SCOPE_IDS = Object.freeze([
  'loginAdmin', 'getAdminSession', 'logoutAdmin',
  'listKnowledge', 'getKnowledge',
  'grantCommunityMediaAccess', 'readCommunityMediaContent',
]);

export const ADMIN_USER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export function opsIdentity(overrides = {}) {
  return {
    userId: ADMIN_USER_ID,
    authEpoch: 1,
    role: 'admin',
    scopes: [...ALL_OPS_SCOPES],
    ...overrides,
  };
}

export function opsContext(overrides = {}) {
  return { identity: opsIdentity(), ...overrides };
}

/** 确定性 uuid（与社区夹具的 id 工厂用不同前缀，避免混淆）。 */
export function makeUuid(n) {
  return `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`;
}

let keyCounter = 0;
export function opsKey(label = 'k') {
  keyCounter += 1;
  return `gy-i18b-${label}-${String(keyCounter).padStart(6, '0')}-${makeUuid(keyCounter).slice(-8)}`;
}

/** 分类种子（`type` 不在 `CategoryInput` 里 ⇒ 不可编辑；契约无创建/删除）。 */
export function categorySeed() {
  return [
    { id: 'crop-rice', revision: 1, type: 'crop', name: '水稻', description: '示例分类：水稻', active: true },
    { id: 'species-barnyardgrass', revision: 1, type: 'species', name: '稗草', description: '示例分类：稗草', active: true },
  ];
}

/** 账号种子：一个可停用、一个已停用、一个注销在途。 */
export function accountSeed() {
  return [
    { id: USER_A.userId, revision: 1, state: 'active', display_name: '示例用户A' },
    { id: USER_B.userId, revision: 1, state: 'suspended', display_name: '示例用户B' },
    { id: makeUuid(301), revision: 1, state: 'deletion_pending', display_name: '示例用户C' },
  ];
}

function job(overrides) {
  return {
    revision: 1,
    kind: 'ocr',
    target_ref: { type: 'ocr', id: makeUuid(900), revision: 1 },
    state: 'queued',
    deadline_at: '2026-10-12T01:00:00.000Z',
    created_at: '2026-10-12T00:10:00.000Z',
    error_code: null,
    result: null,
    ...overrides,
  };
}

/** 作业种子：queued（可取消）/ running（可取消）/ succeeded（终态）/ cancelled（幂等）。 */
export function jobSeed() {
  return [
    job({ id: makeUuid(101), state: 'queued' }),
    job({ id: makeUuid(102), state: 'running' }),
    job({ id: makeUuid(103), state: 'succeeded' }),
    job({ id: makeUuid(104), state: 'cancelled' }),
  ];
}

export const JOB_QUEUED = makeUuid(101);
export const JOB_RUNNING = makeUuid(102);
export const JOB_SUCCEEDED = makeUuid(103);
export const JOB_CANCELLED = makeUuid(104);

/**
 * 建一套后台运营服务。
 * `wireCommunity` 为真时同时建社区 harness（用于 `hidePost` 的端到端可见性断言）。
 */
export function createOpsHarness(options = {}) {
  let tick = 0;
  const base = Date.UTC(2026, 9, 12, 0, 0, 0);
  const now = options.now ?? (() => new Date(base + (tick += 1) * 1000));

  const community = options.community ?? (options.wireCommunity ? makeCommunityHarness() : null);
  const jobPort = options.jobPort ?? (
    options.wireJobs === false ? createUnwiredAdminJobPort() : createMemoryAdminJobPort(jobSeed())
  );

  const store = options.store ?? createAdminOpsStore({
    categorySeed: options.categorySeed ?? categorySeed(),
    accountSeed: options.accountSeed ?? accountSeed(),
  });

  const service = createAdminOpsService({
    store,
    now,
    signingKey: OPS_SIGNING_KEY,
    jobPort,
    community: options.wireCommunity ? community.store : options.communityStore,
    // S3：人工通过/驳回端口（不传 ⇒ 适配层缺省未接线 ⇒ 503，与本片其它能力位同口径）。
    ...(options.postReview === undefined ? {} : { postReview: options.postReview }),
    flagEffects: options.flagEffects,
    idempotencyTtlSeconds: options.idempotencyTtlSeconds,
  });

  return { service, store, jobPort, community, now };
}

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

/** 用本片的契约镜像注册表校验形状。 */
export function opsIssues(specName, value) {
  return opsValidator.collectIssues(specName, value);
}

export function assertOpsContract(specName, value, label = specName) {
  const issues = opsIssues(specName, value);
  assert.deepEqual(issues, [], `${label} 与契约 ${specName} 不同形：${JSON.stringify(issues)}`);
}

export { opsValidator, OPS_ALL_SPECS };

/** 递归断言：响应对象图里不得出现冻结对象（存储侧对象全部已冻结 ⇒ 出现即引用泄漏）。 */
export function assertNoFrozenNodes(value, path, seen = new Set()) {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), false, `${path} 是冻结对象，说明响应里混进了存储引用（应为深拷贝）`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoFrozenNodes(item, `${path}[${index}]`, seen));
    return;
  }
  for (const [key, child] of Object.entries(value)) assertNoFrozenNodes(child, `${path}.${key}`, seen);
}

/** 读内部审计记录（含内部专用字段），用于断言主体/目标提示。 */
export function auditRecords(store) {
  return store.audit.list();
}
