/**
 * GY-I18 阶段 1b · 正控制 + 复用证据。
 *
 * 断言的是派单的硬性语义要求：写操作各留审计、`hidePost` 复用社区可见性语义并退出列表、
 * `cancelAdminJob` 走端口且终态不复活、`setFlag` 不得放宽 fail-closed、出口不可变。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditLogSurface } from '../../services/api/src/admin/audit.ts';
import { createAdminOpsService } from '../../services/api/src/admin/ops/service.ts';
import { createMemoryAdminJobPort, createUnwiredAdminJobPort } from '../../services/api/src/admin/ops/jobs.ts';
import { DEFAULT_FLAG_EFFECTS, CONTRACT_FLAG_KEYS } from '../../services/api/src/admin/ops/flags.ts';
import {
  JOB_CANCELLED,
  JOB_QUEUED,
  JOB_RUNNING,
  JOB_SUCCEEDED,
  OPS_SIGNING_KEY,
  USER_A,
  USER_B,
  assertNoFrozenNodes,
  createOpsHarness,
  expectApiError,
  idem,
  opsContext,
  opsKey,
  publishPost,
} from './admin-ops-fixtures.mjs';

const CATEGORY_ID = 'crop-rice';
const ACCOUNT_ACTIVE = USER_A.userId;
const ACCOUNT_ALREADY_SUSPENDED = USER_B.userId;

test('正控制：编辑分类生效、revision 递增、审计可读（只可追加）', async () => {
  const { service, store } = createOpsHarness();
  const ctx = opsContext();

  const before = await service.listAdminCategories(ctx);
  assert.equal(typeof before.status, 'number');
  assert.equal(before.status, 200);
  assert.equal(before.body.data.items.length, 2);
  const target = before.body.data.items.find((item) => item.id === CATEGORY_ID);
  assert.equal(target.revision, 1);
  assert.equal(target.type, 'crop');

  const edited = await service.editCategory(
    { ...ctx, idempotencyKey: opsKey('cat'), ifMatch: '"1"' },
    CATEGORY_ID,
    { name: '水稻（改）', description: '示例分类：水稻（改）', active: false },
  );
  assert.equal(edited.status, 200);
  assert.equal(edited.body.data.revision, 2);
  assert.equal(edited.body.data.name, '水稻（改）');
  assert.equal(edited.body.data.active, false);
  // `type` 不在 `CategoryInput` 里 ⇒ 不可编辑，且不得被改写。
  assert.equal(edited.body.data.type, 'crop');
  assert.equal(edited.headers['ETag'], '"2"');

  // 契约无创建/删除 ⇒ 本层也**不提供**这两个动作（不越界造 API）。
  assert.equal(service.createCategory, undefined);
  assert.equal(service.deleteCategory, undefined);

  const records = store.audit.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].action, 'category.update');
  assert.equal(records[0].scope, 'sources:write');
  assert.equal(records[0].result, 'accepted');
  assert.equal(records[0].actor_id, ctx.identity.userId);
  // 契约 `TargetRef.type` 无 category 成员 ⇒ 合同口径为 null，标识落在内部字段。
  assert.equal(records[0].target_ref, null);
  assert.equal(records[0].target_hint, `category:${CATEGORY_ID}`);
});

test('正控制：停用账号幂等（不重复迁移、不重复审计）且暴露 isSuspended 只读端口', async () => {
  const { service, store } = createOpsHarness();
  const ctx = opsContext();

  const listed = await service.listAdminUsers(ctx);
  assert.equal(listed.body.data.items.length, 3);
  const active = listed.body.data.items.find((item) => item.id === ACCOUNT_ACTIVE);
  assert.equal(active.state, 'active');
  assert.equal(typeof active.display_name, 'string');
  // 只投影契约允许的 4 个字段（不泄露任何私有数据）。
  assert.deepStrictEqual(Object.keys(active).sort(), ['display_name', 'id', 'revision', 'state']);

  assert.equal(store.isSuspended(ACCOUNT_ACTIVE), false);

  const suspended = await service.suspendUser(
    { ...ctx, idempotencyKey: opsKey('acc'), ifMatch: '"1"' },
    ACCOUNT_ACTIVE,
    { reason: '示例：多次发布违规内容' },
  );
  assert.equal(suspended.body.data.state, 'suspended');
  assert.equal(suspended.body.data.revision, 2);
  assert.equal(store.isSuspended(ACCOUNT_ACTIVE), true);

  // 重复停用（换幂等键）：幂等空操作，不再迁移、不再审计。
  const again = await service.suspendUser(
    { ...ctx, idempotencyKey: opsKey('acc2'), ifMatch: '"2"' },
    ACCOUNT_ACTIVE,
    { reason: '示例：再次停用' },
  );
  assert.equal(again.body.data.state, 'suspended');
  assert.equal(again.body.data.revision, 2, '重复停用不得再迁移');
  assert.equal(store.audit.list().length, 1, '重复停用不得产生第二条审计');

  // 已停用的账号：同样幂等。
  const already = await service.listAdminUsers(ctx);
  assert.equal(already.body.data.items.find((item) => item.id === ACCOUNT_ALREADY_SUSPENDED).state, 'suspended');
});

test('正控制：作业列表走端口；可取消 queued/running；终态与已取消各自处理', async () => {
  const { service, jobPort } = createOpsHarness();
  const ctx = opsContext();

  const listed = await service.listAdminJobs(ctx);
  assert.equal(listed.body.data.items.length, 4);
  assert.equal(jobPort.wired, true);

  const cancelled = await service.cancelAdminJob(
    { ...ctx, idempotencyKey: opsKey('job'), ifMatch: '"1"' },
    JOB_QUEUED,
    { reason: '示例：作业超时' },
  );
  assert.equal(cancelled.body.data.state, 'cancelled');
  assert.equal(cancelled.body.data.revision, 2);
  assert.equal(cancelled.body.data.result, null, '契约 result 恒为 null');

  const fromRunning = await service.cancelAdminJob(
    { ...ctx, idempotencyKey: opsKey('job2'), ifMatch: '"1"' },
    JOB_RUNNING,
    { reason: '示例：运行中取消' },
  );
  assert.equal(fromRunning.body.data.state, 'cancelled');

  // 已取消：幂等空操作（不报错、不再审计）。
  const repeat = await service.cancelAdminJob(
    { ...ctx, idempotencyKey: opsKey('job3'), ifMatch: '"2"' },
    JOB_QUEUED,
    { reason: '示例：重复取消' },
  );
  assert.equal(repeat.body.data.state, 'cancelled');
  assert.equal(repeat.body.data.revision, 2, '重复取消不得再迁移');

  // 终态（succeeded）不可取消 —— 不复活。
  await expectApiError(
    () => service.cancelAdminJob({ ...ctx, idempotencyKey: opsKey('job4'), ifMatch: '"1"' }, JOB_SUCCEEDED, { reason: '示例：试图取消已完成' }),
    'OBJECT_UNAVAILABLE',
  );
  const after = await jobPort.get(JOB_SUCCEEDED);
  assert.equal(after.state, 'succeeded', '终态作业不得被改动');

  // 端口里的 cancelled 作业：幂等成功。
  const alreadyCancelled = await service.cancelAdminJob(
    { ...ctx, idempotencyKey: opsKey('job5'), ifMatch: '"1"' },
    JOB_CANCELLED,
    { reason: '示例：已取消' },
  );
  assert.equal(alreadyCancelled.body.data.state, 'cancelled');
});

test('正控制：开关默认全 false（最严格一侧）、设置后读回一致、审计落账', async () => {
  const { service, store } = createOpsHarness();
  const ctx = opsContext();

  const initial = await service.listFlags(ctx);
  assert.equal(initial.body.data.items.length, 3);
  for (const flag of initial.body.data.items) {
    assert.equal(flag.enabled, false, '开关默认必须是 false（关闭态 = 最严格一侧）');
    assert.equal(flag.revision, 1);
  }
  assert.deepStrictEqual(
    initial.body.data.items.map((flag) => flag.key).sort(),
    [...CONTRACT_FLAG_KEYS].sort(),
  );

  const set = await service.setFlag(
    { ...ctx, idempotencyKey: opsKey('flag'), ifMatch: '"1"' },
    'specific_herbicide_output_enabled',
    { enabled: true, reason: '示例：比赛演示需要展示药剂输出' },
  );
  assert.equal(set.body.data.enabled, true);
  assert.equal(set.body.data.revision, 2);
  assert.equal(set.headers['ETag'], '"2"');

  const readBack = await service.listFlags(ctx);
  assert.equal(readBack.body.data.items.find((flag) => flag.key === 'specific_herbicide_output_enabled').enabled, true);

  const records = store.audit.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].action, 'flag.set');
  assert.equal(records[0].scope, 'flags:write');
  assert.equal(records[0].target_ref, null);
  assert.equal(records[0].target_hint, 'flag:specific_herbicide_output_enabled');

  // 同值重复设置（换键）：幂等空操作，不再审计。
  const same = await service.setFlag(
    { ...ctx, idempotencyKey: opsKey('flag2'), ifMatch: '"2"' },
    'specific_herbicide_output_enabled',
    { enabled: true, reason: '示例：重复设置同值' },
  );
  assert.equal(same.body.data.revision, 2, '同值重复设置不得再迁移');
  assert.equal(store.audit.list().length, 1, '同值重复设置不得产生第二条审计');
});

test('正控制：hidePost 复用社区可见性语义 —— 隐藏后退出公开列表与详情，审计保留', async () => {
  const harness = createOpsHarness({ wireCommunity: true });
  const { service, store, community } = harness;
  const ctx = opsContext();

  const post = await publishPost(community.service, USER_A);
  assert.equal(typeof post.id, 'string');
  assert.equal(post.visibility, 'published');
  assert.equal(post.audit_state, 'approved');

  // 隐藏前：另一个用户能在列表与详情里看到。
  const beforeList = await community.service.listPosts(USER_B, {});
  assert.ok(beforeList.items.some((item) => item.id === post.id), '隐藏前应出现在公开列表');
  assert.equal((await community.service.getPost(USER_B, post.id)).id, post.id);

  const hidden = await service.hidePost(
    { ...ctx, idempotencyKey: opsKey('hide'), ifMatch: `"${post.revision}"` },
    post.id,
    { reason: '示例：管理员隐藏违规帖子' },
  );
  assert.equal(hidden.status, 200);
  assert.equal(hidden.body.data.accepted, true);

  // 隐藏后：退出公开列表、公开详情 NOT_FOUND（用社区自己的读口径断言，不是 admin 自证）。
  const afterList = await community.service.listPosts(USER_B, {});
  assert.equal(afterList.items.some((item) => item.id === post.id), false, '隐藏后必须退出公开列表');
  await expectApiError(() => community.service.getPost(USER_B, post.id), 'NOT_FOUND');

  // 存储侧：visibility=hidden、revision+1，且审计保留。
  const stored = await community.store.getPost(post.id);
  assert.equal(stored.visibility, 'hidden');
  assert.equal(stored.revision, post.revision + 1);
  const records = store.audit.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].action, 'post.hide');
  assert.equal(records[0].scope, 'sources:write');
  assert.equal(records[0].result, 'accepted');
  // 契约 `TargetRef.type` 闭集**有** post 成员 ⇒ 用合同口径，带被隐藏的 revision。
  assert.equal(typeof records[0].target_ref.type, 'string');
  assert.equal(records[0].target_ref.type, 'post');
  assert.equal(records[0].target_ref.id, post.id);
  assert.equal(records[0].target_ref.revision, post.revision);

  // 幂等：已隐藏 ⇒ 空操作，不再迁移、不再审计。
  const repeat = await service.hidePost(
    { ...ctx, idempotencyKey: opsKey('hide2'), ifMatch: `"${post.revision + 1}"` },
    post.id,
    { reason: '示例：重复隐藏' },
  );
  assert.equal(repeat.body.data.accepted, true);
  assert.equal((await community.store.getPost(post.id)).revision, post.revision + 1);
  assert.equal(store.audit.list().length, 1, '重复隐藏不得产生第二条审计');
});

test('每次后台写操作都追加审计；审计只可追加、不可改删', async () => {
  const harness = createOpsHarness({ wireCommunity: true });
  const { service, store, community } = harness;
  const ctx = opsContext();

  const post = await publishPost(community.service, USER_A);
  await service.editCategory({ ...ctx, idempotencyKey: opsKey('a'), ifMatch: '"1"' }, CATEGORY_ID, {
    name: '水稻（改）',
    description: '示例分类：水稻（改）',
    active: true,
  });
  await service.suspendUser({ ...ctx, idempotencyKey: opsKey('b'), ifMatch: '"1"' }, ACCOUNT_ACTIVE, { reason: '示例' });
  await service.cancelAdminJob({ ...ctx, idempotencyKey: opsKey('c'), ifMatch: '"1"' }, JOB_QUEUED, { reason: '示例' });
  await service.setFlag({ ...ctx, idempotencyKey: opsKey('d'), ifMatch: '"1"' }, 'ai_enabled', { enabled: true, reason: '示例' });
  await service.hidePost({ ...ctx, idempotencyKey: opsKey('e'), ifMatch: `"${post.revision}"` }, post.id, { reason: '示例' });

  const records = store.audit.list();
  assert.equal(records.length, 5, '五个写操作各恰好一条审计');
  assert.deepStrictEqual(
    records.map((record) => record.action),
    ['category.update', 'account.suspend', 'job.cancel', 'flag.set', 'post.hide'],
  );
  for (const record of records) {
    assert.equal(record.result, 'accepted');
    assert.equal(record.actor_id, ctx.identity.userId);
    assert.equal(typeof record.request_id, 'string');
    assert.equal(typeof record.created_at, 'string');
  }

  // 只可追加：表面极小、记录深冻结、返回副本。
  assert.deepStrictEqual(Object.keys(store.audit).sort(), [...auditLogSurface].sort());
  for (const forbidden of ['update', 'delete', 'remove', 'clear', 'truncate']) {
    assert.equal(store.audit[forbidden], undefined, `审计台账不得暴露 ${forbidden}`);
  }
  const first = store.audit.list()[0];
  assert.equal(Object.isFrozen(first), true);
  assert.throws(() => {
    first.action = 'tampered';
  }, TypeError);
  assert.throws(() => {
    store.audit.list().push({});
  }, TypeError);
  assert.equal(store.audit.count(), 5);
});

test('出口不可变：9 个操作的响应对象图中不得出现冻结对象（= 不含存储引用）', async () => {
  const harness = createOpsHarness({ wireCommunity: true });
  const { service, community } = harness;
  const ctx = opsContext();
  const post = await publishPost(community.service, USER_A);
  const seen = [];

  const record = (label, response) => {
    assert.equal(typeof response.status, 'number');
    assertNoFrozenNodes(response.headers, `${label}.headers`);
    assertNoFrozenNodes(response.body, `${label}.body`);
    seen.push(label);
  };

  record('listAdminCategories', await service.listAdminCategories(ctx));
  record(
    'editCategory',
    await service.editCategory({ ...ctx, idempotencyKey: opsKey('c'), ifMatch: '"1"' }, CATEGORY_ID, {
      name: '水稻（改）',
      description: '示例分类：水稻（改）',
      active: true,
    }),
  );
  record('listAdminUsers', await service.listAdminUsers(ctx));
  record(
    'suspendUser',
    await service.suspendUser({ ...ctx, idempotencyKey: opsKey('u'), ifMatch: '"1"' }, ACCOUNT_ACTIVE, { reason: '示例' }),
  );
  record('listAdminJobs', await service.listAdminJobs(ctx));
  record(
    'cancelAdminJob',
    await service.cancelAdminJob({ ...ctx, idempotencyKey: opsKey('j'), ifMatch: '"1"' }, JOB_QUEUED, { reason: '示例' }),
  );
  record('listFlags', await service.listFlags(ctx));
  record('setFlag', await service.setFlag({ ...ctx, idempotencyKey: opsKey('f'), ifMatch: '"1"' }, 'ai_enabled', { enabled: true, reason: '示例' }));
  record(
    'hidePost',
    await service.hidePost({ ...ctx, idempotencyKey: opsKey('h'), ifMatch: `"${post.revision}"` }, post.id, { reason: '示例' }),
  );

  assert.equal(seen.length, 9, `只覆盖了 ${seen.length} 个响应`);
});

test('出口深拷贝：即使上游 store 返回**冻结/共享**对象，响应仍是自有副本', async () => {
  const base = createOpsHarness().store;
  const sharedCategory = Object.freeze({
    id: 'crop-rice',
    revision: 1,
    type: 'crop',
    name: '水稻',
    description: '示例分类：水稻',
    active: true,
  });
  const sharedFlag = Object.freeze({ key: 'ai_enabled', enabled: false, revision: 1 });
  const stub = {
    ...base,
    listCategories: () => Object.freeze([sharedCategory]),
    listFlags: () => Object.freeze([sharedFlag]),
  };
  const service = createAdminOpsService({
    store: stub,
    signingKey: OPS_SIGNING_KEY,
    now: () => new Date('2026-10-12T00:00:00.000Z'),
  });
  const ctx = opsContext();

  const categories = await service.listAdminCategories(ctx);
  assertNoFrozenNodes(categories.body, 'stub.listCategories');
  const flags = await service.listFlags(ctx);
  assertNoFrozenNodes(flags.body, 'stub.listFlags');

  // 改响应（含嵌套层）不得动上游对象。
  categories.body.data.items[0].name = 'MUTATED';
  assert.equal(sharedCategory.name, '水稻', '上游共享对象被响应改写了');
  flags.body.data.items[0].enabled = true;
  assert.equal(sharedFlag.enabled, false, '上游共享对象被响应改写了');
  // 再次读：上游对象一个字没变。
  const again = await service.listAdminCategories(ctx);
  assert.equal(again.body.data.items[0].name, '水稻');
});

test('flag 语义分类表：合同 3 键全部是能力门，无任何放宽语义', () => {
  assert.deepStrictEqual(Object.keys(DEFAULT_FLAG_EFFECTS).sort(), [...CONTRACT_FLAG_KEYS].sort());
  for (const [key, effect] of Object.entries(DEFAULT_FLAG_EFFECTS)) {
    assert.equal(effect.weakens_fail_closed, false, `${key} 不得削弱 fail-closed`);
    assert.equal(effect.disables_hard_rules, false, `${key} 不得关闭硬规则`);
    assert.equal(effect.allows_unverified_publish, false, `${key} 不得让未核对内容可发布`);
    assert.equal(typeof effect.gates, 'string');
  }
});

test('作业端口未接线时：读与写都 fail-closed，绝不伪造作业状态', async () => {
  const { service, jobPort } = createOpsHarness({ wireJobs: false });
  const ctx = opsContext();
  assert.equal(jobPort.wired, false);
  assert.equal(typeof createUnwiredAdminJobPort().cancel, 'function');
  assert.equal(typeof createMemoryAdminJobPort([]).wired, 'boolean');

  // 读：返回 503 而不是"空页"——空页会被读成"平台当前没有作业"，那是无法确认的结论。
  await expectApiError(() => service.listAdminJobs(ctx), 'PROVIDER_UNAVAILABLE');
  // 写：同样 503，绝不谎报取消成功。
  await expectApiError(
    () => service.cancelAdminJob({ ...ctx, idempotencyKey: opsKey('n'), ifMatch: '"1"' }, JOB_QUEUED, { reason: '示例' }),
    'PROVIDER_UNAVAILABLE',
  );
});

test('社区存储未接线时：hidePost fail-closed（503），不谎报成功', async () => {
  const { service } = createOpsHarness({ wireCommunity: false });
  await expectApiError(
    () => service.hidePost({ ...opsContext(), idempotencyKey: opsKey('x'), ifMatch: '"1"' }, '00000000-0000-4000-a000-000000000999', { reason: '示例' }),
    'PROVIDER_UNAVAILABLE',
  );
});
