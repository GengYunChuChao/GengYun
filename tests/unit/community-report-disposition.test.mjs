/**
 * GY-I15（#15）· R31-S1：举报处置（状态推进 + CAS 幂等）的服务层用例（内存实现）。
 *
 * 补的是侦察 §S1 指出的**缺的那一环**：既有代码只写 `state: 'received'`，没有任何路径能
 * 把举报推进到 `isolated` / `closed`。本用例断言三件事：
 *   1. **只允许合法转移**：非法转移与终态后再处置一律 `409`（契约 409 闭集里没有
 *      `STATE_CONFLICT`，本片用 `REVISION_CONFLICT` 承载，口径见证据页「新口径，待裁」）；
 *   2. **幂等由 CAS 承载**：`expected_revision` 必须等于当前版本，重复处置不会静默成功、
 *      也不会产生第二条记录（同一 `expected_revision` 第二次调用 ⇒ 409）；
 *   3. **处置不越权**：`advanceReport` 是内部操作（无 HTTP 入口），不校验举报者归属，
 *      举报者本人**读得到**自己的举报，但推进它是运营侧的事。
 *
 * 证据边界：内存实现上的确定性回归；真库 CAS 与行级效果见
 * `tests/integration/community-pg.mjs`（本轮新增同名臂）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureError, idem, makeHarness, publishPost, USER_A, USER_B } from './community-fixtures.mjs';

const MISSING_ID = '00000000-0000-4000-8500-00000000dead';

/** 发一条可举报的帖子，并由 `USER_B` 举报它；返回 { post, report }。 */
async function seedReport(h, keySeed = 90) {
  const post = await publishPost(h.service, USER_A, {}, idem(keySeed));
  const report = await h.service.createReport(
    USER_B,
    { target_ref: { type: 'post', id: post.id, revision: post.revision }, reason_code: 'other' },
    { idempotencyKey: idem(keySeed + 1) },
  );
  return { post, report };
}

test('正控制：received --triage--> isolated --resolve--> closed，revision 逐次 +1', async () => {
  const h = makeHarness();
  const { report } = await seedReport(h);
  assert.equal(report.state, 'received');
  assert.equal(report.revision, 1);

  const triaged = await h.service.advanceReport(report.id, { action: 'triage', expected_revision: 1 });
  assert.equal(triaged.id, report.id, '推进不产生新记录');
  assert.equal(triaged.state, 'isolated');
  assert.equal(triaged.revision, 2);

  const resolved = await h.service.advanceReport(report.id, { action: 'resolve', expected_revision: 2 });
  assert.equal(resolved.state, 'closed');
  assert.equal(resolved.revision, 3);

  // 举报者自己的读口跟着变（契约 `GET /reports/{id}` 的同一份投影）。
  const own = await h.service.getOwnReport(USER_B, report.id);
  assert.equal(own.state, 'closed');
  assert.equal(own.revision, 3);
  // 存储里仍然只有一条举报记录（推进是 UPDATE，不是 INSERT）。
  assert.equal(h.store.snapshotCounts().reports, 1);
});

test('驳回路径：received --reject--> closed 一步到终态', async () => {
  const h = makeHarness();
  const { report } = await seedReport(h, 100);
  const rejected = await h.service.advanceReport(report.id, { action: 'reject', expected_revision: 1 });
  assert.equal(rejected.state, 'closed');
  assert.equal(rejected.revision, 2);
});

test('幂等（同一 expected_revision 重复处置）：第二次 409，不静默成功、不产生第二条记录', async () => {
  const h = makeHarness();
  const { report } = await seedReport(h, 110);
  await h.service.advanceReport(report.id, { action: 'triage', expected_revision: 1 });

  const error = await captureError(() =>
    h.service.advanceReport(report.id, { action: 'triage', expected_revision: 1 }),
  );
  assert.equal(error.code, 'REVISION_CONFLICT');
  assert.equal(error.status, 409);
  assert.equal(h.store.snapshotCounts().reports, 1);
  assert.equal((await h.store.getReport(report.id)).revision, 2, '重放不得改动记录');
});

test('处置后不可再处置：closed 之后任何动作一律 409（终态单向门）', async () => {
  const h = makeHarness();
  const { report } = await seedReport(h, 120);
  await h.service.advanceReport(report.id, { action: 'resolve', expected_revision: 1 });
  for (const action of ['triage', 'resolve', 'reject']) {
    const error = await captureError(() => h.service.advanceReport(report.id, { action, expected_revision: 2 }));
    assert.equal(error.code, 'REVISION_CONFLICT', `closed 之后 ${action} 必须是 409`);
    assert.equal(error.status, 409);
  }
  assert.equal((await h.store.getReport(report.id)).state, 'closed');
});

test('非法转移：已隔离的举报不接受 reject（409），且不改动记录', async () => {
  const h = makeHarness();
  const { report } = await seedReport(h, 130);
  await h.service.advanceReport(report.id, { action: 'triage', expected_revision: 1 });

  const error = await captureError(() =>
    h.service.advanceReport(report.id, { action: 'reject', expected_revision: 2 }),
  );
  assert.equal(error.code, 'REVISION_CONFLICT');
  assert.equal(error.status, 409);
  const stored = await h.store.getReport(report.id);
  assert.equal(stored.state, 'isolated');
  assert.equal(stored.revision, 2);
});

test('入参校验：未知动作/多余字段/非法 expected_revision ⇒ 400 INVALID_REQUEST（不写库）', async () => {
  const h = makeHarness();
  const { report } = await seedReport(h, 140);
  const bad = [
    { action: 'approve', expected_revision: 1 },
    { action: '', expected_revision: 1 },
    { action: 'triage', expected_revision: 1, note: '多余字段' },
    { action: 'triage', expected_revision: 0 },
    { action: 'triage', expected_revision: '1' },
    { action: 'triage', expected_revision: 1.5 },
    { expected_revision: 1 },
  ];
  for (const input of bad) {
    const error = await captureError(() => h.service.advanceReport(report.id, input));
    assert.equal(error.code, 'INVALID_REQUEST', `入参 ${JSON.stringify(input)} 必须 400`);
    assert.equal(error.status, 400);
  }
  const stored = await h.store.getReport(report.id);
  assert.equal(stored.state, 'received');
  assert.equal(stored.revision, 1);
});

test('不存在/非法 id：uuid 不存在 ⇒ 404；非 uuid ⇒ 400', async () => {
  const h = makeHarness();
  const missing = await captureError(() =>
    h.service.advanceReport(MISSING_ID, { action: 'triage', expected_revision: 1 }),
  );
  assert.equal(missing.code, 'NOT_FOUND');
  assert.equal(missing.status, 404);

  const malformed = await captureError(() =>
    h.service.advanceReport('not-a-uuid', { action: 'triage', expected_revision: 1 }),
  );
  assert.equal(malformed.code, 'INVALID_REQUEST');
  assert.equal(malformed.status, 400);
});

test('既有幂等语义如实保留：同一 Idempotency-Key 重放返回同一举报 id；换 key 则另起一条', async () => {
  // 这一条**不是**新行为，而是把「重复提交」的既有口径钉住，避免本片顺手改动它：
  // 幂等键只绑定 (主体, 方法, 路径)，**不**按 (主体, 举报对象) 去重。
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(150));
  const body = { target_ref: { type: 'post', id: post.id, revision: post.revision }, reason_code: 'other' };
  const first = await h.service.createReport(USER_B, body, { idempotencyKey: idem(151) });
  const replay = await h.service.createReport(USER_B, body, { idempotencyKey: idem(151) });
  assert.equal(replay.id, first.id, '同一幂等键必须返回同一举报 id');
  assert.equal(h.store.snapshotCounts().reports, 1);

  const second = await h.service.createReport(USER_B, body, { idempotencyKey: idem(152) });
  assert.notEqual(second.id, first.id, '换幂等键 = 另一次提交（既有语义：不按对象去重）');
  assert.equal(h.store.snapshotCounts().reports, 2);
});
