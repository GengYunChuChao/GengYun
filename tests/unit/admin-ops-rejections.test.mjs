/**
 * GY-I18 阶段 1b · 独立反例（每条可单独指出，均带正控制对照）。
 *
 * 覆盖派单要求的类别：
 *  1 非 admin 操作；2 admin 但缺对应 scope；3 未知/非法 flag key；
 *  4 flag 试图关闭硬规则/放宽 fail-closed ⇒ 拒 + denied 审计；
 *  5 注入"放宽语义"的 flag 语义表 ⇒ 拒绝构造（fail-closed at wiring time）；
 *  6 未知分类/账号/作业（越权与不存在对外同形）；7 注销在途账号不可停用；
 *  8 作业端口未接线 ⇒ 503 且不伪造；9 端口返回不合契约记录 ⇒ 拒绝投影；
 * 10 hidePost 不得复活已删除内容；11 hidePost 对未发布草稿；12 hidePost 未知帖子；
 * 13 同键异体 ⇒ 冲突码；14 分页 limit 超上限；15 多余字段 ⇒ INVALID_REQUEST；
 * 16 路径 id 格式（uuid / 长度）；17 If-Match 缺/非法/不匹配；
 * 18 Idempotency-Key 缺/长度；19 审计不可改删；20 出口嵌套改动动不了存储。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminOpsService } from '../../services/api/src/admin/ops/service.ts';
import { createAdminOpsStore } from '../../services/api/src/admin/ops/store.ts';
import { DEFAULT_FLAG_EFFECTS } from '../../services/api/src/admin/ops/flags.ts';
import {
  ALL_OPS_SCOPES,
  JOB_QUEUED,
  JOB_SUCCEEDED,
  OPS_SIGNING_KEY,
  USER_A,
  createOpsHarness,
  expectApiError,
  idem,
  makeUuid,
  opsContext,
  opsIdentity,
  opsKey,
  publishPost,
} from './admin-ops-fixtures.mjs';

const CATEGORY_ID = 'crop-rice';
const ACCOUNT_ACTIVE = USER_A.userId;
const ACCOUNT_DELETION_PENDING = makeUuid(301);
const UNKNOWN_UUID = '00000000-0000-4000-a000-00000000ffff';

/** 12 个操作的可调用形式（供权限反例参数化）。 */
function opCalls(service, ctx) {
  return [
    ['listAdminCategories', () => service.listAdminCategories(ctx)],
    ['editCategory', () => service.editCategory({ ...ctx, idempotencyKey: opsKey('a'), ifMatch: '"1"' }, CATEGORY_ID, { name: 'n', description: 'd', active: true })],
    ['listAdminUsers', () => service.listAdminUsers(ctx)],
    ['suspendUser', () => service.suspendUser({ ...ctx, idempotencyKey: opsKey('b'), ifMatch: '"1"' }, ACCOUNT_ACTIVE, { reason: 'r' })],
    ['listAdminJobs', () => service.listAdminJobs(ctx)],
    ['cancelAdminJob', () => service.cancelAdminJob({ ...ctx, idempotencyKey: opsKey('c'), ifMatch: '"1"' }, JOB_QUEUED, { reason: 'r' })],
    ['listFlags', () => service.listFlags(ctx)],
    ['setFlag', () => service.setFlag({ ...ctx, idempotencyKey: opsKey('d'), ifMatch: '"1"' }, 'ai_enabled', { enabled: true, reason: 'r' })],
    ['hidePost', () => service.hidePost({ ...ctx, idempotencyKey: opsKey('e'), ifMatch: '"1"' }, UNKNOWN_UUID, { reason: 'r' })],
    // R37 #18 S2 读面：门也是 scope，所以先过鉴权、再看读面是否接线（顺序不可颠倒）。
    ['listAdministrators', () => service.listAdministrators(ctx)],
    ['listAdministratorScopes', () => service.listAdministratorScopes(ctx, UNKNOWN_UUID)],
  ];
}

/** 每个 operationId 真正需要的 scope。 */
const REQUIRED_SCOPE = {
  listAdminCategories: 'sources:read',
  editCategory: 'sources:write',
  listAdminUsers: 'accounts:read',
  suspendUser: 'accounts:suspend',
  listAdminJobs: 'jobs:read',
  cancelAdminJob: 'jobs:cancel',
  listFlags: 'flags:read',
  setFlag: 'flags:write',
  hidePost: 'sources:write',
  listAdministrators: 'scopes:read',
  listAdministratorScopes: 'scopes:read',
};

test('反例 1/2：非 admin 一律 SCOPE_DENIED；缺对应 scope 的 admin 逐个被拒', async () => {
  const { service } = createOpsHarness();
  const userCtx = { identity: { userId: USER_A.userId, authEpoch: 1, role: 'user', scopes: ['user'] } };

  // 非 admin（用户会话）⇒ 12 个操作全部 403。
  for (const [name, call] of opCalls(service, userCtx)) {
    const error = await expectApiError(call, 'SCOPE_DENIED');
    assert.equal(error.status, 403, `${name} 应为 403`);
  }

  // 缺 scope：对**每一个**操作，去掉它自己需要的 scope ⇒ 该操作被拒。
  for (const [id, scope] of Object.entries(REQUIRED_SCOPE)) {
    const without = { identity: opsIdentity({ scopes: ALL_OPS_SCOPES.filter((entry) => entry !== scope) }) };
    const call = opCalls(service, without).find(([name]) => name === id);
    assert.notEqual(call, undefined);
    await expectApiError(call[1], 'SCOPE_DENIED');
  }

  // 正控制：完整 scope 的 admin 可以读；scope 全集与各操作需求一致。
  assert.equal((await service.listAdminCategories(opsContext())).status, 200);
  assert.equal((await service.listFlags(opsContext())).status, 200);
  assert.deepStrictEqual([...ALL_OPS_SCOPES].sort(), [...new Set(Object.values(REQUIRED_SCOPE))].sort());
});

test('反例 3：未知 flag key（不在契约闭集）⇒ INVALID_REQUEST，且不写任何 accepted 审计', async () => {
  const { service, store } = createOpsHarness();
  for (const key of ['not_a_flag', 'totally_unknown', 'ENABLED']) {
    const error = await expectApiError(
      () => service.setFlag({ ...opsContext(), idempotencyKey: opsKey('f'), ifMatch: '"1"' }, key, { enabled: true, reason: 'r' }),
      'INVALID_REQUEST',
    );
    assert.equal(error.status, 400);
    assert.equal(Array.isArray(error.details), true);
    assert.ok(error.details.some((detail) => detail.field === 'key'));
  }
  // 未知 key 不落任何审计（它连目标都不是）。
  assert.equal(store.audit.count(), 0);
});

test('反例 4：flag 试图关闭硬规则/放宽 fail-closed ⇒ 拒绝并留 denied 审计', async () => {
  const { service, store } = createOpsHarness();
  const attempts = [
    'hard_rules_enabled',
    'moderation_enabled',
    'fail_closed_enabled',
    'auto_approve',
    'bypass_hard_rules',
    'allow_unverified_publish',
    'disable_moderation',
    'skip_moderation',
  ];
  for (const key of attempts) {
    const error = await expectApiError(
      () => service.setFlag({ ...opsContext(), idempotencyKey: opsKey('f'), ifMatch: '"1"' }, key, { enabled: true, reason: 'r' }),
      'INVALID_REQUEST',
    );
    assert.equal(error.status, 400, `${key} 应为 400`);
    assert.ok(error.details.some((detail) => detail.code === 'SAFETY_CRITICAL_KEY'), `${key} 应给出安全语义标记`);
  }

  const records = store.audit.list();
  assert.equal(records.length, attempts.length, '每一次安全语义拒绝都必须留一条 denied 审计');
  for (const record of records) {
    assert.equal(record.result, 'denied');
    assert.equal(record.action, 'flag.set');
    assert.equal(record.reason_code, 'flag_weakening_denied');
    assert.equal(record.target_ref, null);
    assert.ok(record.target_hint.startsWith('flag:'));
  }
  // 拒绝对状态无副作用：三个契约开关仍是默认 false。
  const flags = await service.listFlags(opsContext());
  for (const flag of flags.body.data.items) assert.equal(flag.enabled, false);
});

test('反例 5：注入"放宽语义"的 flag 语义表 ⇒ 服务拒绝构造（fail-closed at wiring time）', () => {
  const weakened = {
    ...DEFAULT_FLAG_EFFECTS,
    ai_enabled: { gates: 'ai_capabilities', weakens_fail_closed: true, disables_hard_rules: false, allows_unverified_publish: false },
  };
  assert.throws(
    () => createAdminOpsService({ signingKey: OPS_SIGNING_KEY, flagEffects: weakened }),
    /不得关闭硬规则|放宽安全判定/,
  );
  const disablesRules = {
    ...DEFAULT_FLAG_EFFECTS,
    submissions_enabled: { gates: 'community_submissions', weakens_fail_closed: false, disables_hard_rules: true, allows_unverified_publish: false },
  };
  assert.throws(
    () => createAdminOpsService({ signingKey: OPS_SIGNING_KEY, flagEffects: disablesRules }),
    /不得关闭硬规则|放宽安全判定/,
  );
  const allowsUnverified = {
    ...DEFAULT_FLAG_EFFECTS,
    ai_enabled: { gates: 'ai_capabilities', weakens_fail_closed: false, disables_hard_rules: false, allows_unverified_publish: true },
  };
  assert.throws(
    () => createAdminOpsService({ signingKey: OPS_SIGNING_KEY, flagEffects: allowsUnverified }),
    /不得关闭硬规则|放宽安全判定/,
  );
  // 正控制：合同自带的分类表可以正常构造。
  assert.equal(typeof createAdminOpsService({ signingKey: OPS_SIGNING_KEY }).listFlags, 'function');
});

test('反例 6/7：不存在一律 404 同码；无权限调用方无法靠 403/404 差异探测目标；注销在途不可停用', async () => {
  const { service } = createOpsHarness();
  const ctx = opsContext();

  // 各类目标不存在时：都是 404 + NOT_FOUND（文案按资源名词区分，不构成存在性泄露）。
  for (const call of [
    () => service.editCategory({ ...ctx, idempotencyKey: opsKey('x'), ifMatch: '"1"' }, 'no-such-category', { name: 'n', description: 'd', active: true }),
    () => service.suspendUser({ ...ctx, idempotencyKey: opsKey('x'), ifMatch: '"1"' }, UNKNOWN_UUID, { reason: 'r' }),
    () => service.cancelAdminJob({ ...ctx, idempotencyKey: opsKey('x'), ifMatch: '"1"' }, UNKNOWN_UUID, { reason: 'r' }),
  ]) {
    const error = await expectApiError(call, 'NOT_FOUND');
    assert.equal(error.status, 404);
  }

  // **真正的"同形"**：无权限调用方对「存在」与「不存在」的目标对外完全一致
  // ⇒ 不存在靠 403/404 差异探测目标的通道。
  const noScope = { identity: opsIdentity({ scopes: ['flags:read'] }) };
  const accountShapes = [];
  for (const target of [ACCOUNT_ACTIVE, ACCOUNT_DELETION_PENDING, UNKNOWN_UUID]) {
    const error = await expectApiError(
      () => service.suspendUser({ ...noScope, idempotencyKey: opsKey('ns'), ifMatch: '"1"' }, target, { reason: 'r' }),
      'SCOPE_DENIED',
    );
    accountShapes.push(`${error.status}|${error.code}|${error.message}`);
  }
  assert.equal(new Set(accountShapes).size, 1, `账号目标形状不一致：${JSON.stringify([...new Set(accountShapes)])}`);

  const jobShapes = [];
  for (const target of [JOB_QUEUED, JOB_SUCCEEDED, UNKNOWN_UUID]) {
    const error = await expectApiError(
      () => service.cancelAdminJob({ ...noScope, idempotencyKey: opsKey('ns'), ifMatch: '"1"' }, target, { reason: 'r' }),
      'SCOPE_DENIED',
    );
    jobShapes.push(`${error.status}|${error.code}|${error.message}`);
  }
  assert.equal(new Set(jobShapes).size, 1, `作业目标形状不一致：${JSON.stringify([...new Set(jobShapes)])}`);

  // 注销在途：停用是状态回退 ⇒ 拒绝。
  await expectApiError(
    () => service.suspendUser({ ...ctx, idempotencyKey: opsKey('dp'), ifMatch: '"1"' }, ACCOUNT_DELETION_PENDING, { reason: 'r' }),
    'OBJECT_UNAVAILABLE',
  );
});

test('反例 8/9：作业端口未接线 ⇒ 503；端口返回不合契约记录 ⇒ 拒绝投影', async () => {
  const unwired = createOpsHarness({ wireJobs: false });
  await expectApiError(() => unwired.service.listAdminJobs(opsContext()), 'PROVIDER_UNAVAILABLE');

  // 端口返回一条违反契约的记录（`result` 不是 null）⇒ 必须拒绝投影，而不是把脏数据发出去。
  const badPort = {
    wired: true,
    list: () => [{ id: makeUuid(1), revision: 1, kind: 'ocr', target_ref: { type: 'ocr', id: makeUuid(2), revision: 1 }, state: 'queued', deadline_at: '2026-10-12T01:00:00.000Z', created_at: '2026-10-12T00:00:00.000Z', error_code: null, result: '有值' }],
    get: () => null,
    cancel: () => ({ ok: false, reason: 'PORT_UNAVAILABLE' }),
  };
  const bad = createOpsHarness({ jobPort: badPort });
  await expectApiError(() => bad.service.listAdminJobs(opsContext()), 'PROVIDER_UNAVAILABLE');
});

test('反例 10/11/12：hidePost 不得复活已删除内容；未发布草稿不改写；未知帖子 NOT_FOUND', async () => {
  const harness = createOpsHarness({ wireCommunity: true });
  const { service, community, store } = harness;
  const ctx = opsContext();

  // 已删除：不可隐藏、更不可复活。
  const doomed = await publishPost(community.service, USER_A, {}, idem(1));
  await community.service.deletePost(USER_A, doomed.id, { idempotencyKey: idem(2), ifMatch: `"${doomed.revision}"` });
  assert.equal((await community.store.getPost(doomed.id)).visibility, 'deleted');

  await expectApiError(
    () => service.hidePost({ ...ctx, idempotencyKey: opsKey('del'), ifMatch: `"${doomed.revision + 1}"` }, doomed.id, { reason: 'r' }),
    'OBJECT_UNAVAILABLE',
  );
  const stillDeleted = await community.store.getPost(doomed.id);
  assert.equal(stillDeleted.visibility, 'deleted', '已删除内容不得被复活');
  assert.equal(store.audit.count(), 0, '被拒的隐藏不得留下 accepted 审计');

  // 未知帖子 ⇒ NOT_FOUND。
  await expectApiError(
    () => service.hidePost({ ...ctx, idempotencyKey: opsKey('nf'), ifMatch: '"1"' }, UNKNOWN_UUID, { reason: 'r' }),
    'NOT_FOUND',
  );

  // 未发布草稿（作者私有）⇒ 不改写作者状态。
  const draft = await community.service.createPost(USER_A, { title: '草稿标题', body: '草稿正文，尚未发布。', media_ids: [] }, { idempotencyKey: idem(3) });
  const draftStored = await community.store.getPost(draft.id);
  assert.notEqual(draftStored.visibility, 'deleted');
  if (draftStored.visibility !== 'published') {
    await expectApiError(
      () => service.hidePost({ ...ctx, idempotencyKey: opsKey('draft'), ifMatch: `"${draftStored.revision}"` }, draft.id, { reason: 'r' }),
      'OBJECT_UNAVAILABLE',
    );
    assert.equal((await community.store.getPost(draft.id)).visibility, draftStored.visibility, '作者草稿状态不得被 admin 改写');
  }
});

test('反例 13：同键异体 ⇒ IDEMPOTENCY_CONFLICT', async () => {
  const { service } = createOpsHarness();
  const ctx = opsContext();
  const key = opsKey('conflict');
  const first = await service.editCategory(
    { ...ctx, idempotencyKey: key, ifMatch: '"1"' },
    CATEGORY_ID,
    { name: '第一次', description: '第一次改', active: true },
  );
  assert.equal(first.status, 200);
  await expectApiError(
    () => service.editCategory({ ...ctx, idempotencyKey: key, ifMatch: '"1"' }, CATEGORY_ID, { name: '第二次', description: '第二次改', active: false }),
    'IDEMPOTENCY_CONFLICT',
  );
});

test('反例 14/15：分页 limit 超上限、请求体多余字段一律 INVALID_REQUEST', async () => {
  const { service } = createOpsHarness();
  const ctx = opsContext();
  for (const limit of [0, 51, -1, 1.5, 'abc', [20]]) {
    await expectApiError(() => service.listAdminCategories({ ...ctx }, { limit }), 'INVALID_REQUEST');
    await expectApiError(() => service.listAdminUsers({ ...ctx }, { limit }), 'INVALID_REQUEST');
    await expectApiError(() => service.listFlags({ ...ctx }, { limit }), 'INVALID_REQUEST');
  }
  // 正控制：1 与字符串数字合法。
  assert.equal((await service.listAdminCategories(ctx, { limit: 1 })).body.data.items.length, 1);
  assert.equal((await service.listAdminCategories(ctx, { limit: '1' })).body.data.items.length, 1);

  await expectApiError(
    () => service.editCategory({ ...ctx, idempotencyKey: opsKey('x'), ifMatch: '"1"' }, CATEGORY_ID, { name: 'n', description: 'd', active: true, extra: 1 }),
    'INVALID_REQUEST',
  );
  // 契约 `CategoryInput` 没有 `type` ⇒ 不能借编辑改类型。
  await expectApiError(
    () => service.editCategory({ ...ctx, idempotencyKey: opsKey('x'), ifMatch: '"1"' }, CATEGORY_ID, { name: 'n', description: 'd', active: true, type: 'species' }),
    'INVALID_REQUEST',
  );
  await expectApiError(
    () => service.setFlag({ ...ctx, idempotencyKey: opsKey('x'), ifMatch: '"1"' }, 'ai_enabled', { enabled: true, reason: 'r', extra: 1 }),
    'INVALID_REQUEST',
  );
  await expectApiError(
    () => service.setFlag({ ...ctx, idempotencyKey: opsKey('x'), ifMatch: '"1"' }, 'ai_enabled', { enabled: 'true', reason: 'r' }),
    'INVALID_REQUEST',
  );
  await expectApiError(
    () => service.suspendUser({ ...ctx, idempotencyKey: opsKey('x'), ifMatch: '"1"' }, ACCOUNT_ACTIVE, { reason: '' }),
    'INVALID_REQUEST',
  );
});

test('反例 16：路径 id 格式（uuid 型与非 uuid 型分别照契约判定）', async () => {
  const { service } = createOpsHarness();
  const ctx = opsContext();
  // uuid 型路径参数：非法 ⇒ 400（而不是 404）。
  for (const bad of ['abc', '123', `${UNKNOWN_UUID}x`]) {
    await expectApiError(() => service.suspendUser({ ...ctx, idempotencyKey: opsKey('x'), ifMatch: '"1"' }, bad, { reason: 'r' }), 'INVALID_REQUEST');
    await expectApiError(() => service.cancelAdminJob({ ...ctx, idempotencyKey: opsKey('x'), ifMatch: '"1"' }, bad, { reason: 'r' }), 'INVALID_REQUEST');
    await expectApiError(() => service.hidePost({ ...ctx, idempotencyKey: opsKey('x'), ifMatch: '"1"' }, bad, { reason: 'r' }), 'INVALID_REQUEST');
  }
  // 分类 id 是 1..80 不透明字符串：空串与超长 ⇒ 400。
  await expectApiError(
    () => service.editCategory({ ...ctx, idempotencyKey: opsKey('x'), ifMatch: '"1"' }, '', { name: 'n', description: 'd', active: true }),
    'INVALID_REQUEST',
  );
  await expectApiError(
    () => service.editCategory({ ...ctx, idempotencyKey: opsKey('x'), ifMatch: '"1"' }, 'x'.repeat(81), { name: 'n', description: 'd', active: true }),
    'INVALID_REQUEST',
  );
  // 正控制：合法但不存在 ⇒ NOT_FOUND（不是 400）。
  await expectApiError(
    () => service.editCategory({ ...ctx, idempotencyKey: opsKey('x'), ifMatch: '"1"' }, 'no-such', { name: 'n', description: 'd', active: true }),
    'NOT_FOUND',
  );
});

test('反例 17/18：If-Match 缺 428 / 非法 400 / 不匹配 409；Idempotency-Key 缺失与长度', async () => {
  const { service } = createOpsHarness();
  const ctx = opsContext();
  const edit = (options, body = { name: 'n', description: 'd', active: true }) => service.editCategory(options, CATEGORY_ID, body);

  const missing = await expectApiError(() => edit({ ...ctx, idempotencyKey: opsKey('x') }), 'REVISION_REQUIRED');
  assert.equal(missing.status, 428);

  for (const ifMatch of ['*', 'W/"1"', '"0"', '1', '"1', '01', '"99999999999999999999999"']) {
    const error = await expectApiError(() => edit({ ...ctx, idempotencyKey: opsKey('x'), ifMatch }), 'INVALID_REQUEST');
    assert.equal(error.status, 400);
  }

  const stale = await expectApiError(() => edit({ ...ctx, idempotencyKey: opsKey('x'), ifMatch: '"9"' }), 'REVISION_CONFLICT');
  assert.equal(stale.status, 409);

  await expectApiError(() => edit({ ...ctx, ifMatch: '"1"' }), 'IDEMPOTENCY_KEY_REQUIRED');
  await expectApiError(() => edit({ ...ctx, idempotencyKey: 'short', ifMatch: '"1"' }), 'INVALID_REQUEST');
  await expectApiError(() => edit({ ...ctx, idempotencyKey: 'x'.repeat(129), ifMatch: '"1"' }), 'INVALID_REQUEST');

  // 正控制：8 与 128 字符边界可用。
  assert.equal((await edit({ ...ctx, idempotencyKey: '12345678', ifMatch: '"1"' })).status, 200);
  assert.equal((await edit({ ...ctx, idempotencyKey: 'y'.repeat(128), ifMatch: '"2"' })).status, 200);
});

test('反例 19/20：审计不可改删；出口嵌套改动动不了存储', async () => {
  const { service, store } = createOpsHarness();
  const ctx = opsContext();
  await service.setFlag({ ...ctx, idempotencyKey: opsKey('a'), ifMatch: '"1"' }, 'ai_enabled', { enabled: true, reason: '示例' });

  // 审计不可改删。
  const record = store.audit.list()[0];
  assert.equal(Object.isFrozen(record), true);
  assert.throws(() => {
    record.action = 'tampered';
  }, TypeError);
  assert.throws(() => {
    record.result = 'failed';
  }, TypeError);
  assert.throws(() => {
    store.audit.list().push({});
  }, TypeError);
  for (const forbidden of ['update', 'delete', 'remove', 'clear']) {
    assert.equal(store.audit[forbidden], undefined);
  }
  assert.equal(store.audit.count(), 1);

  // 出口嵌套改动动不了存储。
  const listed = await service.listFlags(ctx);
  const baseline = JSON.stringify(listed.body.data.items);
  listed.body.data.items[0].enabled = !listed.body.data.items[0].enabled;
  listed.body.data.items[0].revision = 999;
  const again = await service.listFlags(ctx);
  assert.equal(JSON.stringify(again.body.data.items), baseline, '响应被改写后读回必须一致');
  assert.equal(store.getFlag('ai_enabled').revision, 2, '存储侧的开关修订不得被响应改写');
});

test('反例：flag 语义表缺失契约键时仍需 fail-safe（缺键不改变结论）', async () => {
  // 只给一个键的分类表：构造本身不因"少键"而放宽；服务照常拒绝放宽语义。
  const partial = { ai_enabled: DEFAULT_FLAG_EFFECTS.ai_enabled };
  const service = createAdminOpsService({ signingKey: OPS_SIGNING_KEY, flagEffects: partial });
  await expectApiError(
    () => service.setFlag({ ...opsContext(), idempotencyKey: opsKey('p'), ifMatch: '"1"' }, 'hard_rules_enabled', { enabled: true, reason: 'r' }),
    'INVALID_REQUEST',
  );
});

test('反例：存储种子必须契约合法（接线期 fail-closed）', () => {
  assert.throws(
    () => createAdminOpsStore({ categorySeed: [{ id: 'x', revision: 1, type: 'crop', name: 'n', description: 'd' }] }),
    /接线期种子不符合契约/,
  );
  assert.throws(
    () => createAdminOpsStore({ accountSeed: [{ id: 'x', revision: 1, state: 'active' }] }),
    /接线期种子不符合契约/,
  );
  assert.throws(
    () => createAdminOpsStore({ categorySeed: [{ id: 'x', revision: 1, type: 'crop', name: 'n', description: 'd', active: true, extra: 1 }] }),
    /接线期种子不符合契约/,
  );
});
