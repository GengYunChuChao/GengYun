/**
 * GY-I18 阶段 1b · 返修 1：作业取消「先证成、后副作用」（监工 5492234991 / 行内 4249201458）。
 *
 * 缺陷本质：`ok=true` 后**立即**写 `accepted` 审计与幂等定型，之后才做契约形状校验，
 * 且**不检查**回传的 id / state / revision 是否与"取消这个作业"相符。
 * 于是一个合成端口可以让「取消 A 却返回 B succeeded/rev2」或「A 仍 queued/rev1」
 * 都拿到 200 + `accepted/job_cancelled`；缺 `kind` 的非法结构更是**先写审计再抛错**
 * （留下部分副作用）。
 *
 * 本文件逐条锁死：**外部输入必须先证成，才能产生副作用**；任何矛盾/非法结果
 * 一律 fail-closed，且**不留任何部分副作用**（审计 0 条、幂等台账无已完成行）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  idempotencyKeyHashHex,
  idempotencyScope,
} from '../../services/api/src/auth/idempotency.ts';
import {
  ADMIN_USER_ID,
  JOB_QUEUED,
  OPS_SIGNING_KEY,
  createOpsHarness,
  expectApiError,
  makeUuid,
  opsContext,
  opsKey,
} from './admin-ops-fixtures.mjs';

const OTHER_JOB_ID = makeUuid(102);
const TARGET_REF = { type: 'ocr', id: makeUuid(900), revision: 1 };
const CANCEL_PATH = `/admin/jobs/${JOB_QUEUED}/cancel`;

/** 取消前的合法作业（与夹具 `jobSeed()` 里 queued 那条一致）。 */
function preJob(overrides = {}) {
  return {
    id: JOB_QUEUED,
    revision: 1,
    kind: 'ocr',
    target_ref: { ...TARGET_REF },
    state: 'queued',
    deadline_at: '2026-10-12T01:00:00.000Z',
    created_at: '2026-10-12T00:10:00.000Z',
    error_code: null,
    result: null,
    ...overrides,
  };
}

/** 合成端口：`get` 恒返回取消前状态，`cancel` 返回给定的（可能非法/矛盾的）结果。 */
function syntheticPort(cancelJob) {
  return {
    wired: true,
    list: () => [preJob()],
    get: (id) => (id === JOB_QUEUED ? preJob() : null),
    cancel: () => ({ ok: true, job: cancelJob }),
  };
}

/** 断言：这次拒绝**没有留下任何部分副作用**。 */
function assertNoPartialEffect(harness, key) {
  assert.equal(harness.store.audit.count(), 0, '被拒的取消不得留下任何审计（尤其不得有 accepted）');
  const scope = idempotencyScope(ADMIN_USER_ID, 'POST', CANCEL_PATH);
  const keyHash = idempotencyKeyHashHex(scope, key);
  assert.equal(
    harness.store.runtime.peekIdempotent(scope, keyHash),
    null,
    '被拒的取消不得留下幂等台账行（占位必须已释放）',
  );
}

async function cancelWith(harness, key, ifMatch = '"1"') {
  return harness.service.cancelAdminJob(
    { ...opsContext(), idempotencyKey: key, ifMatch },
    JOB_QUEUED,
    { reason: '示例：作业超时' },
  );
}

test('反例 ①：取消 A 却返回 B（succeeded/rev2）⇒ 拒，且无 accepted 审计、无幂等定型', async () => {
  const key = opsKey('int-1');
  const harness = createOpsHarness({
    // 返回的是**别的作业** B，而且是个终态、revision 也不对。
    jobPort: syntheticPort(preJob({ id: OTHER_JOB_ID, state: 'succeeded', revision: 2 })),
  });

  const error = await expectApiError(() => cancelWith(harness, key), 'PROVIDER_UNAVAILABLE');
  assert.equal(typeof error.status, 'number');
  assert.equal(error.status, 503);
  assertFieldDetailsFree(error);
  assertNoPartialEffect(harness, key);
});

test('反例 ②：返回 A 仍为 queued/rev1（未取消）⇒ 拒，且无 accepted 审计、无幂等定型', async () => {
  const key = opsKey('int-2');
  const harness = createOpsHarness({
    // 同一个作业，但状态没变、修订号没动。
    jobPort: syntheticPort(preJob()),
  });

  const error = await expectApiError(() => cancelWith(harness, key), 'PROVIDER_UNAVAILABLE');
  assert.equal(error.status, 503);
  assertNoPartialEffect(harness, key);
});

test('反例 ③：返回缺 kind 的非法结构 ⇒ 拒，且**先拒、后无副作用**（原实现会先写审计再抛错）', async () => {
  const key = opsKey('int-3');
  const illegal = preJob({ state: 'cancelled', revision: 2 });
  delete illegal.kind;
  const harness = createOpsHarness({ jobPort: syntheticPort(illegal) });

  await expectApiError(() => cancelWith(harness, key), 'PROVIDER_UNAVAILABLE');
  // 关键：拒绝时**不得**已经写下 accepted 审计，也不得定型幂等结果。
  assertNoPartialEffect(harness, key);

  // 修正端口后，用**同一个幂等键**重试必须能成功 ⇒ 证明失败没有留下占位或半成品。
  const fixed = createOpsHarness({
    store: harness.store,
    jobPort: syntheticPort(preJob({ state: 'cancelled', revision: 2 })),
  });
  const ok = await cancelWith(fixed, key);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.state, 'cancelled');
  assert.equal(harness.store.audit.count(), 1, '修正后只应有一条 accepted 审计');
  assert.equal(harness.store.audit.list()[0].result, 'accepted');
});

test('反例 ③b：修订号未正确递增（revision 不变 / 跳增 / 倒退）⇒ 一律拒，无副作用', async () => {
  for (const [label, revision] of [['未递增', 1], ['跳增', 3], ['倒退', 0]]) {
    const key = opsKey('int-rev');
    const harness = createOpsHarness({
      jobPort: syntheticPort(preJob({ state: 'cancelled', revision })),
    });
    const error = await expectApiError(() => cancelWith(harness, key), 'PROVIDER_UNAVAILABLE');
    assert.equal(error.status, 503, `${label} 应为 fail-closed`);
    assertNoPartialEffect(harness, key);
  }

  // 目标描述被偷换（target_ref 变了）同样拒。
  const key = opsKey('int-target');
  const harness = createOpsHarness({
    jobPort: syntheticPort(preJob({ state: 'cancelled', revision: 2, target_ref: { type: 'job', id: makeUuid(901), revision: 1 } })),
  });
  await expectApiError(() => cancelWith(harness, key), 'PROVIDER_UNAVAILABLE');
  assertNoPartialEffect(harness, key);
});

test('正控制 ④：合法取消（同一 id、进入已取消态、修订号 +1、形状合法）⇒ 200 + 恰好一条 accepted 审计 + 幂等定型', async () => {
  const key = opsKey('int-ok');
  const harness = createOpsHarness(); // 出厂 memory 端口（真实实现）
  const ok = await cancelWith(harness, key);

  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.id, JOB_QUEUED, '返回的必须是被取消的那一个作业');
  assert.equal(ok.body.data.state, 'cancelled');
  assert.equal(ok.body.data.revision, 2);
  assert.equal(ok.body.data.result, null);

  const records = harness.store.audit.list();
  assert.equal(records.length, 1, '恰好一条审计');
  assert.equal(records[0].action, 'job.cancel');
  assert.equal(records[0].result, 'accepted');
  assert.equal(records[0].target_ref.type, 'job');
  assert.equal(records[0].target_ref.id, JOB_QUEUED, '审计目标必须是被取消的作业');
  assert.equal(records[0].target_ref.revision, 1, '审计带的是被取消的那一版 revision');

  // 幂等定型：台账里恰好一条已完成行。
  const scope = idempotencyScope(ADMIN_USER_ID, 'POST', CANCEL_PATH);
  const keyHash = idempotencyKeyHashHex(scope, key);
  const row = harness.store.runtime.peekIdempotent(scope, keyHash);
  assert.notEqual(row, null);
  assert.equal(typeof row.requestHash, 'string');
  assert.notEqual(row.outcome, null, '占位必须已定型为结果引用');
  assert.equal(row.outcome.status, 200);
});

test('正控制 ⑤：幂等重放不再产生第二条审计；换键重复取消（已取消）是空操作', async () => {
  const key = opsKey('int-replay');
  const harness = createOpsHarness();
  const first = await cancelWith(harness, key);
  assert.equal(first.status, 200);

  // 同键同体重放：逐字相同响应，审计仍 1 条。
  const replay = await cancelWith(harness, key);
  assert.deepStrictEqual(replay.body, first.body);
  assert.deepStrictEqual(replay.headers, first.headers);
  assert.equal(harness.store.audit.count(), 1, '重放不得产生第二条审计');

  // 换键 + 新 ETag：作业已是 cancelled ⇒ 幂等空操作，不再迁移、不再审计。
  const second = await cancelWith(harness, opsKey('int-replay2'), '"2"');
  assert.equal(second.status, 200);
  assert.equal(second.body.data.state, 'cancelled');
  assert.equal(second.body.data.revision, 2, '不得再迁移');
  assert.equal(harness.store.audit.count(), 1, '已取消后重复取消不得再审计');
});

/** `PROVIDER_UNAVAILABLE` 属 503 组，`details` 允许为空；这里只锁形状，不锁文案。 */
function assertFieldDetailsFree(error) {
  assert.equal(Array.isArray(error.details), true, 'details 必须是数组');
  assert.equal(typeof error.retryable, 'boolean');
}
