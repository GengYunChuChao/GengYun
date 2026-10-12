/**
 * GY-I18 阶段 1b · 幂等并发（复用阶段 1 的占位/重放语义）。
 *
 * 断言：同键同体并发 ⇒ **恰好 1 次生效 + 恰好 1 条审计**；
 * 同键异体 ⇒ 契约冲突码；同键同体重放 ⇒ 逐字相同响应；
 * 异键并发 ⇒ 第二次幂等空操作；失败释放占位；占位未定型 ⇒ `REQUEST_IN_PROGRESS`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JOB_QUEUED,
  USER_A,
  createOpsHarness,
  expectApiError,
  makeUuid,
  opsContext,
  opsKey,
  publishPost,
} from './admin-ops-fixtures.mjs';

const CATEGORY_ID = 'crop-rice';
const ACCOUNT_ACTIVE = USER_A.userId;

/** 每个写操作的"调用一次"和一个"状态校验"。 */
function writeCases(harness, ctx, key) {
  const { service } = harness;
  return [
    {
      name: 'editCategory',
      invoke: () => service.editCategory({ ...ctx, idempotencyKey: key, ifMatch: '"1"' }, CATEGORY_ID, { name: '改后', description: '改后说明', active: false }),
      assertEffect: async () => {
        assert.equal(harness.store.getCategory(CATEGORY_ID).revision, 2);
        assert.equal(harness.store.getCategory(CATEGORY_ID).name, '改后');
      },
    },
    {
      name: 'suspendUser',
      invoke: () => service.suspendUser({ ...ctx, idempotencyKey: key, ifMatch: '"1"' }, ACCOUNT_ACTIVE, { reason: '示例' }),
      assertEffect: async () => {
        assert.equal(harness.store.getAccount(ACCOUNT_ACTIVE).revision, 2);
        assert.equal(harness.store.isSuspended(ACCOUNT_ACTIVE), true);
      },
    },
    {
      name: 'cancelAdminJob',
      invoke: () => service.cancelAdminJob({ ...ctx, idempotencyKey: key, ifMatch: '"1"' }, JOB_QUEUED, { reason: '示例' }),
      assertEffect: async () => {
        const job = await harness.jobPort.get(JOB_QUEUED);
        assert.equal(job.state, 'cancelled');
        assert.equal(job.revision, 2);
      },
    },
    {
      name: 'setFlag',
      invoke: () => service.setFlag({ ...ctx, idempotencyKey: key, ifMatch: '"1"' }, 'ai_enabled', { enabled: true, reason: '示例' }),
      assertEffect: async () => {
        assert.equal(harness.store.getFlag('ai_enabled').enabled, true);
        assert.equal(harness.store.getFlag('ai_enabled').revision, 2);
      },
    },
  ];
}

test('同键同体并发：恰好 1 次生效 + 恰好 1 条审计（4 个本地写操作）', async () => {
  for (const label of ['editCategory', 'suspendUser', 'cancelAdminJob', 'setFlag']) {
    const harness = createOpsHarness();
    const ctx = opsContext();
    const key = opsKey('race');
    const entry = writeCases(harness, ctx, key).find((item) => item.name === label);
    assert.notEqual(entry, undefined);

    const results = await Promise.all([entry.invoke(), entry.invoke(), entry.invoke()]);
    for (const result of results) {
      assert.equal(typeof result.status, 'number');
      assert.equal(result.status, 200);
      assert.deepStrictEqual(result.body, results[0].body, `${label} 同键同体并发必须收敛到同一结果`);
    }
    await entry.assertEffect();
    assert.equal(harness.store.audit.count(), 1, `${label} 并发后审计必须恰好一条`);
    assert.equal(harness.store.audit.list()[0].result, 'accepted');
  }
});

test('同键同体并发：hidePost（异步 produce）同样恰好 1 次生效 + 1 条审计', async () => {
  const harness = createOpsHarness({ wireCommunity: true });
  const { service, community, store } = harness;
  const ctx = opsContext();
  const post = await publishPost(community.service, USER_A);
  const key = opsKey('race-hide');
  const invoke = () =>
    service.hidePost({ ...ctx, idempotencyKey: key, ifMatch: `"${post.revision}"` }, post.id, { reason: '示例' });

  const results = await Promise.all([invoke(), invoke(), invoke()]);
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.deepStrictEqual(result.body, results[0].body);
  }
  const stored = await community.store.getPost(post.id);
  assert.equal(stored.visibility, 'hidden');
  assert.equal(stored.revision, post.revision + 1, '不得产生第二次修订');
  assert.equal(store.audit.count(), 1, '并发隐藏必须恰好一条审计');
});

test('20 路同键同体并发：恰好 1 次生效 + 1 条审计', async () => {
  const harness = createOpsHarness();
  const ctx = opsContext();
  const key = opsKey('storm');
  const invoke = () =>
    harness.service.editCategory({ ...ctx, idempotencyKey: key, ifMatch: '"1"' }, CATEGORY_ID, { name: '暴雨', description: '暴雨说明', active: true });

  const results = await Promise.all(Array.from({ length: 20 }, invoke));
  assert.equal(results.length, 20);
  for (const result of results) assert.equal(result.status, 200);
  assert.equal(harness.store.audit.count(), 1);
  assert.equal(harness.store.getCategory(CATEGORY_ID).revision, 2);
});

test('同键异体：并发不同请求体 ⇒ IDEMPOTENCY_CONFLICT（恰好 1 次生效）', async () => {
  const harness = createOpsHarness();
  const ctx = opsContext();
  const key = opsKey('mix');
  const settled = await Promise.allSettled([
    harness.service.editCategory({ ...ctx, idempotencyKey: key, ifMatch: '"1"' }, CATEGORY_ID, { name: '甲', description: '甲说明', active: true }),
    harness.service.editCategory({ ...ctx, idempotencyKey: key, ifMatch: '"1"' }, CATEGORY_ID, { name: '乙', description: '乙说明', active: false }),
  ]);
  const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
  const rejected = settled.filter((entry) => entry.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(typeof rejected[0].reason.code, 'string');
  assert.equal(rejected[0].reason.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(rejected[0].reason.status, 409);
  assert.equal(harness.store.audit.count(), 1);
  assert.equal(harness.store.getCategory(CATEGORY_ID).revision, 2);
});

test('同键同体重放：逐字相同的响应，且不产生第二次状态迁移或第二条审计', async () => {
  const harness = createOpsHarness();
  const ctx = opsContext();
  const key = opsKey('replay');
  const body = { enabled: true, reason: '示例：开启' };
  const options = { ...ctx, idempotencyKey: key, ifMatch: '"1"' };

  const first = await harness.service.setFlag(options, 'ai_enabled', body);
  const replay = await harness.service.setFlag(options, 'ai_enabled', body);
  assert.deepStrictEqual(replay.body, first.body);
  assert.deepStrictEqual(replay.headers, first.headers);
  assert.equal(replay.status, first.status);
  assert.equal(harness.store.audit.count(), 1);
  assert.equal(harness.store.getFlag('ai_enabled').revision, 2);
});

test('异键并发 + 同一 If-Match：恰好 1 次生效，另一个 REVISION_CONFLICT（乐观并发），仍只 1 条审计', async () => {
  const harness = createOpsHarness();
  const ctx = opsContext();
  const settled = await Promise.allSettled([
    harness.service.setFlag({ ...ctx, idempotencyKey: opsKey('a'), ifMatch: '"1"' }, 'ai_enabled', { enabled: true, reason: '甲' }),
    harness.service.setFlag({ ...ctx, idempotencyKey: opsKey('b'), ifMatch: '"1"' }, 'ai_enabled', { enabled: true, reason: '乙' }),
  ]);
  const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
  const rejected = settled.filter((entry) => entry.status === 'rejected');
  assert.equal(fulfilled.length, 1, '只允许一次状态迁移');
  assert.equal(rejected.length, 1);
  assert.equal(typeof rejected[0].reason.code, 'string');
  assert.equal(rejected[0].reason.code, 'REVISION_CONFLICT', '另一条应因 If-Match 陈旧被拒（不是静默成功）');
  assert.equal(harness.store.getFlag('ai_enabled').revision, 2);
  assert.equal(harness.store.audit.count(), 1, '只允许一条审计');
});

test('异键顺序设置同值：幂等空操作，不产生第二次迁移或第二条审计', async () => {
  const harness = createOpsHarness();
  const ctx = opsContext();
  const first = await harness.service.setFlag(
    { ...ctx, idempotencyKey: opsKey('a'), ifMatch: '"1"' },
    'ai_enabled',
    { enabled: true, reason: '甲' },
  );
  assert.equal(first.body.data.revision, 2);
  // 第二条携带**新的** ETag（客户端重试/重复点击的真实形态）：值未变 ⇒ 空操作。
  const second = await harness.service.setFlag(
    { ...ctx, idempotencyKey: opsKey('b'), ifMatch: '"2"' },
    'ai_enabled',
    { enabled: true, reason: '乙' },
  );
  assert.equal(second.status, 200);
  assert.equal(second.body.data.revision, 2, '同值设置不得再迁移');
  assert.equal(harness.store.audit.count(), 1, '同值设置不得再审计');
});

test('失败释放占位：失败后可以用同一个键重试成功', async () => {
  const harness = createOpsHarness();
  const ctx = opsContext();
  const key = opsKey('release');

  // 第一条：If-Match 不匹配 ⇒ 409，占位必须释放。
  await expectApiError(
    () => harness.service.editCategory({ ...ctx, idempotencyKey: key, ifMatch: '"9"' }, CATEGORY_ID, { name: '甲', description: '甲说明', active: true }),
    'REVISION_CONFLICT',
  );
  assert.equal(harness.store.audit.count(), 0);

  // 第二条：同一个键 + 正确的 If-Match ⇒ 成功（证明占位确实释放）。
  const retried = await harness.service.editCategory(
    { ...ctx, idempotencyKey: key, ifMatch: '"1"' },
    CATEGORY_ID,
    { name: '甲', description: '甲说明', active: true },
  );
  assert.equal(retried.status, 200);
  assert.equal(harness.store.audit.count(), 1);

  // 安全语义 key 被拒也不消耗键：紧接着用同键做一次真实写入仍然成功。
  const key2 = opsKey('release2');
  await expectApiError(
    () => harness.service.setFlag({ ...ctx, idempotencyKey: key2, ifMatch: '"1"' }, 'hard_rules_enabled', { enabled: false, reason: 'x' }),
    'INVALID_REQUEST',
  );
  const afterDenied = await harness.service.setFlag(
    { ...ctx, idempotencyKey: key2, ifMatch: '"1"' },
    'ai_enabled',
    { enabled: true, reason: '示例' },
  );
  assert.equal(afterDenied.status, 200);
});

test('占位未定型 ⇒ REQUEST_IN_PROGRESS（可重试）；同键异体 ⇒ IDEMPOTENCY_CONFLICT', async () => {
  const harness = createOpsHarness();
  const ctx = opsContext();
  const key = opsKey('inflight');
  const path = `/admin/feature-flags/ai_enabled`;
  const { idempotencyScope, idempotencyKeyHashHex, idempotencyRequestHash } = await import(
    '../../services/api/src/auth/idempotency.ts'
  );
  const { OPS_SIGNING_KEY } = await import('./admin-ops-fixtures.mjs');

  const body = { enabled: true, reason: '示例' };
  const scope = idempotencyScope(ctx.identity.userId, 'PUT', path);
  const keyHash = idempotencyKeyHashHex(scope, key);
  const claimed = harness.store.runtime.claimIdempotent(scope, keyHash, {
    requestHash: idempotencyRequestHash(body, '"1"', OPS_SIGNING_KEY),
    responseStatus: 200,
    expiresAt: new Date(harness.now().getTime() + 60_000),
    now: harness.now(),
  });
  assert.equal(claimed, true);

  const inflight = await expectApiError(
    () => harness.service.setFlag({ ...ctx, idempotencyKey: key, ifMatch: '"1"' }, 'ai_enabled', body),
    'REQUEST_IN_PROGRESS',
  );
  assert.equal(inflight.status, 409);
  assert.equal(inflight.retryable, true);
  assert.equal(harness.store.getFlag('ai_enabled').enabled, false, '占位中不得发生状态迁移');
  assert.equal(harness.store.audit.count(), 0);

  const conflicting = await expectApiError(
    () => harness.service.setFlag({ ...ctx, idempotencyKey: key, ifMatch: '"1"' }, 'ai_enabled', { enabled: false, reason: '另一种请求体' }),
    'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(conflicting.status, 409);
});

test('幂等台账可清理到期条目（复用阶段 1 的 runtime）', async () => {
  const harness = createOpsHarness();
  const ctx = opsContext();
  await harness.service.setFlag({ ...ctx, idempotencyKey: opsKey('ttl'), ifMatch: '"1"' }, 'ai_enabled', { enabled: true, reason: '示例' });
  assert.equal(harness.store.runtime.idempotentCount(), 1);
  const removed = harness.store.runtime.purgeExpiredIdempotent(new Date(harness.now().getTime() + 10 * 60 * 1000));
  assert.equal(removed, 1);
  assert.equal(harness.store.runtime.idempotentCount(), 0);
});

test('审计在并发写之下仍只可追加（拒绝任何改删尝试）', async () => {
  const harness = createOpsHarness();
  const ctx = opsContext();
  const key = opsKey('audit-race');
  await Promise.all([
    harness.service.setFlag({ ...ctx, idempotencyKey: key, ifMatch: '"1"' }, 'ai_enabled', { enabled: true, reason: '示例' }),
    harness.service.setFlag({ ...ctx, idempotencyKey: key, ifMatch: '"1"' }, 'ai_enabled', { enabled: true, reason: '示例' }),
  ]);
  const records = harness.store.audit.list();
  assert.equal(records.length, 1);
  assert.equal(Object.isFrozen(records[0]), true);
  assert.throws(() => {
    records[0].reason_code = 'tampered';
  }, TypeError);
  // 未知目标 id 也不能绕过审计（用不存在的分类）。
  await expectApiError(
    () => harness.service.editCategory({ ...ctx, idempotencyKey: opsKey('na'), ifMatch: '"1"' }, makeUuid(777), { name: 'n', description: 'd', active: true }),
    'NOT_FOUND',
  );
  assert.equal(harness.store.audit.count(), 1, '被拒的写不得留下审计，也不得抹掉既有审计');
});
