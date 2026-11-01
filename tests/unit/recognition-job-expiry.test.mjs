/**
 * GY-R72（W35）：作业读面超时裁定（识别域）单测。
 *
 * 缺陷：`GET /jobs/{id}` 在「执行器缺席 / 进程重启 / 提供者卡死」时**永远**回报
 * `queued` / `running`，用户界面的「处理中」永不结束。口径与合成域／OCR 域同形
 * （`services/api/src/tts/service.ts:45-47`、`services/api/src/ocr/service.ts:1153-1213`），
 * 宽限与「过期」判定收在 `services/api/src/jobs/expiry.ts` 这一处真源。
 *
 * 判据（派单 `.pg17/tmp/r72-w35-brief.md` §2）：
 *   T1  `queued` 过期 ⇒ `timed_out` + `PROVIDER_TIMEOUT`，`revision` **恰好 +1**，`result === null`
 *       （且**不产生**识别记录）；
 *   T1b 越权读**别人的**过期任务 ⇒ `NOT_FOUND`，一次写都没有，别人那一行 state/revision 不动；
 *   T2  `running` 过期 ⇒ 同上；
 *   T3  五个终态即使过期也**一个字都不动**（`succeeded` / `uncertain` 仍读得出识别结果）；
 *   T4  未过期（`deadline + grace - 1ms`）⇒ 原样 `queued` / `running`，且**一次写都没有**；
 *   T5  宽限边界**含等号**：`deadline + grace` 整点即裁定，`-1ms` 不裁定；
 *   T6a 连读两次只自增一次；
 *   T6b CAS 抢不到（并发方已落 `cancelled`）⇒ 返回 store 现值，**绝不**谎报自己写成的 `timed_out`；
 *   T6c 抢不到后重读**只试一次**：重读抛错 ⇒ 退回首读行、不冒泡；首读抛错 ⇒ 照旧冒泡；
 *   T7  `JOB_EXPIRY_GRACE_MS` **全仓单一真源**（只有 `services/api/src/jobs/expiry.ts` 定义它）；
 *   T8  读面裁定**不**通知历史端口、不 `insertJob`、不 `commitTerminal`；执行路径仍照常通知一次
 *       （对照组，证明计数口有效）。
 *
 * 断言一律先判 `typeof` / 具体键，再判值；不使用「只要不抛错就算通过」的写法。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STUB_IDEMPOTENCY_HMAC_KEY } from '../../services/api/src/auth/service.ts';
import { JOB_EXPIRY_GRACE_MS, isDeadlineExpired } from '../../services/api/src/jobs/expiry.ts';
import { createSubstituteMediaPort } from '../../services/api/src/recognitions/media.ts';
import { createRecognitionService } from '../../services/api/src/recognitions/service.ts';
import { TERMINAL_JOB_STATES } from '../../services/api/src/recognitions/state.ts';
import { createMemoryRecognitionStore } from '../../services/api/src/recognitions/store.ts';

// ---------------------------------------------------------------- 辅助

const HMAC_KEY = STUB_IDEMPOTENCY_HMAC_KEY ?? 'gengyun-stub-idempotency-hmac-key';
const USER = 'user-owner-0001';
const OTHER_USER = 'user-other-0002';
/** 受理时刻（固定，不读真实时钟：宽限与时序都要可复算）。 */
const T0 = new Date('2026-11-01T08:00:00.000Z');
/** 作业默认截止时间（与 `DEFAULT_JOB_DEADLINE_MS` 同值，但断言不依赖那个常量）。 */
const DEADLINE_MS = 30 * 1000;
/** 契约 JobProjection 的键集合（本片**不得**因新增裁定而多出字段）。 */
const JOB_PROJECTION_KEYS = ['created_at', 'deadline_at', 'error_code', 'id', 'kind', 'result', 'revision', 'state', 'target_ref'];

let keyCounter = 0;
function nextKey() {
  keyCounter += 1;
  return `recog-expiry-key-${String(keyCounter).padStart(6, '0')}`;
}

/** 记录终态通知的历史端口（默认 `wired`：调用即记账，不模拟未接线）。 */
function createSpyHistoryPort() {
  const calls = [];
  return {
    calls,
    port: {
      kind: 'wired',
      note: '读面超时裁定单测用历史端口（只记账）',
      async recordTerminal(input) {
        calls.push(input);
      },
    },
  };
}

/**
 * 计数用的 store 包装：`insertJob` / `updateJob` / `commitTerminal` 的**调用次数**。
 * 读面裁定必须「恰好写一次」且「不碰 insertJob / commitTerminal」，
 * 只看 revision 无法区分「写一次」与「写两次但值相同」。
 */
function instrumentStore(store) {
  const counter = {
    insertJob: 0,
    updateJob: 0,
    commitTerminal: 0,
    // 落种子行本身也会走 insertJob；需要「只看被测路径」的用例先清零。
    reset() {
      counter.insertJob = 0;
      counter.updateJob = 0;
      counter.commitTerminal = 0;
    },
  };
  const insertJob = store.insertJob.bind(store);
  const updateJob = store.updateJob.bind(store);
  const commitTerminal = store.commitTerminal.bind(store);
  store.insertJob = async (...args) => {
    counter.insertJob += 1;
    return insertJob(...args);
  };
  store.updateJob = async (...args) => {
    counter.updateJob += 1;
    return updateJob(...args);
  };
  store.commitTerminal = async (...args) => {
    counter.commitTerminal += 1;
    return commitTerminal(...args);
  };
  return counter;
}

/** 确定性提供者（不按 mediaId 分桶：本片只关心读面，不关心执行分支）。 */
function createFixedProvider() {
  return {
    executionMode: 'stub',
    modelVersion: 'stub-v1',
    available: true,
    unavailableReason: null,
    async recognize() {
      return {
        kind: 'completed',
        candidates: [{ species_id: 'synthetic_weed_a', rank: 1, model_score: 0.81 }],
        uncertainty_reasons: [],
      };
    },
  };
}

/** 组装服务：内存 store + 注入时钟 + 确定性假提供者（永不真的做识别）。 */
function boot(overrides = {}) {
  const store = createMemoryRecognitionStore();
  // 先取原始方法（供「并发放手」用例直接落终态，不计入读面裁定的计数）。
  const raw = {
    getJob: store.getJob.bind(store),
    commitTerminal: store.commitTerminal.bind(store),
  };
  const counter = instrumentStore(store);
  const clock = { at: overrides.at ?? T0 };
  const history = overrides.history ?? createSpyHistoryPort();
  const service = createRecognitionService({
    store,
    provider: overrides.provider ?? createFixedProvider(),
    media: createSubstituteMediaPort(),
    history: history.port,
    idempotencyHmacKey: HMAC_KEY,
    now: () => new Date(clock.at.getTime()),
  });
  return { store, raw, service, clock, counter, history };
}

/** 直接向内存 store 落一条作业行（精确构造 queued / running / 终态现场）。 */
async function seedJob(store, overrides = {}) {
  const row = {
    id: randomUUID(),
    revision: 1,
    kind: 'recognition',
    ownerUserId: USER,
    recognitionId: randomUUID(),
    mediaId: randomUUID(),
    mediaRevision: 1,
    state: 'queued',
    deadlineAt: new Date(T0.getTime() + DEADLINE_MS),
    createdAt: T0,
    updatedAt: T0,
    errorCode: null,
    ...overrides,
  };
  await store.insertJob(row);
  return row;
}

/** 契约识别记录的最小合法形状（T3 用：证明成功作业仍读得出结果）。 */
async function seedRecognitionRow(store, { id, ownerUserId = USER }) {
  return store.insertRecognition({
    id,
    revision: 1,
    ownerUserId,
    mediaId: randomUUID(),
    mediaRevision: 1,
    candidates: [{ species_id: 'synthetic_weed_a', rank: 1, model_score: 0.81 }],
    uncertaintyReasons: [],
    selectedSpeciesId: null,
    modelVersion: 'stub-v1',
    createdAt: T0,
    updatedAt: T0,
    deleted: false,
  });
}

/** `deadline + offsetMs` 的时刻（不改 row，只算时钟位置）。 */
function atDeadlinePlus(deadlineAt, offsetMs) {
  return new Date(deadlineAt.getTime() + offsetMs);
}

// ------------------------------------------- T1：queued 过期

test('T1 queued 过期 ⇒ timed_out + PROVIDER_TIMEOUT，revision 恰好 +1，result 为 null，不产生识别记录', async () => {
  const { store, service, clock, counter, history } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1 });
  assert.equal(await store.getRecognition(job.recognitionId), null, '裁定前不得已有识别记录');

  clock.at = atDeadlinePlus(job.deadlineAt, JOB_EXPIRY_GRACE_MS);
  const projection = await service.getJob({ userId: USER, jobId: job.id });

  assert.equal(projection.state, 'timed_out', '过期作业必须显式落 timed_out，不许继续回报 queued');
  assert.equal(projection.error_code, 'PROVIDER_TIMEOUT', '错误码必须是 PROVIDER_TIMEOUT');
  assert.equal(projection.result, null, 'timed_out 不产出识别记录 ⇒ result 恒为 null');
  assert.equal(projection.revision, 2, 'revision 必须从 1 恰好递增到 2（不是 +2、不是 +0）');
  assert.equal(projection.deadline_at, job.deadlineAt.toISOString(), 'deadline_at 不得被裁定改写');
  assert.deepEqual(Object.keys(projection).sort(), JOB_PROJECTION_KEYS, 'JobProjection 形状不得因本片新增字段');

  const persisted = await store.getJob(job.id);
  assert.equal(persisted.state, 'timed_out', '落库状态必须是 timed_out');
  assert.equal(persisted.errorCode, 'PROVIDER_TIMEOUT', '落库错误码必须是 PROVIDER_TIMEOUT');
  assert.equal(persisted.revision, 2, '落库 revision 必须恰好 +1');
  assert.equal(persisted.updatedAt.getTime(), clock.at.getTime(), 'updatedAt 取裁定时刻');
  assert.equal(persisted.deadlineAt.getTime(), job.deadlineAt.getTime(), 'deadline_at 不得被改写');
  assert.equal(persisted.createdAt.getTime(), job.createdAt.getTime(), 'created_at 不得被改写');
  assert.equal(persisted.ownerUserId, USER, '归属者不得被裁定改写');

  assert.equal(await store.getRecognition(job.recognitionId), null, '读面裁定**不得**产生识别记录');
  assert.equal(counter.updateJob, 1, '裁定必须恰好写一次（单次 CAS，不重试）');
  assert.equal(history.calls.length, 0, '读面裁定不得通知历史端口');
});

// ------------------------------------------- T1b：越权读别人的过期任务

test('T1b 越权读别人的过期任务 ⇒ NOT_FOUND，一次写都没有，别人的行原封不动', async () => {
  const { store, service, clock, counter } = boot();
  const others = await seedJob(store, { state: 'queued', revision: 1, ownerUserId: OTHER_USER });
  clock.at = atDeadlinePlus(others.deadlineAt, JOB_EXPIRY_GRACE_MS + 1);

  await assert.rejects(
    () => service.getJob({ userId: USER, jobId: others.id }),
    (error) => {
      assert.equal(error.code, 'NOT_FOUND', '越权读必须先被归属守卫挡下（不泄露存在性）');
      return true;
    },
  );

  assert.equal(counter.updateJob, 0, '越权读不得产生任何写（裁定只在归属校验之后）');
  assert.equal(counter.commitTerminal, 0, '越权读不得走终态提交');
  const untouched = await store.getJob(others.id);
  assert.equal(untouched.state, 'queued', '别人的那一行不得被本用户的 GET 改写成 timed_out');
  assert.equal(untouched.revision, 1, '别人的那一行 revision 不得变化');
  assert.equal(untouched.errorCode, null, '别人的那一行 errorCode 不得被写');
});

// ------------------------------------------- T2：running 过期

test('T2 running 过期 ⇒ 同样落 timed_out，revision 从 3 恰好递增到 4', async () => {
  const { store, service, clock, counter } = boot();
  const job = await seedJob(store, { state: 'running', revision: 3 });

  clock.at = atDeadlinePlus(job.deadlineAt, JOB_EXPIRY_GRACE_MS + 1);
  const projection = await service.getJob({ userId: USER, jobId: job.id });

  assert.equal(projection.state, 'timed_out', 'running 过期同样必须显式化');
  assert.equal(projection.error_code, 'PROVIDER_TIMEOUT', '错误码必须是 PROVIDER_TIMEOUT');
  assert.equal(projection.result, null, 'running / timed_out 的 result 恒为 null');
  assert.equal(projection.revision, 4, 'revision 必须从 3 恰好递增到 4');

  const persisted = await store.getJob(job.id);
  assert.equal(persisted.state, 'timed_out');
  assert.equal(persisted.revision, 4, 'running 现场的 revision 也必须恰好 +1');
  assert.equal(await store.getRecognition(job.recognitionId), null, '不得产生识别记录');
  assert.equal(counter.updateJob, 1, '恰好写一次');
});

// ------------------------------------------- T3：终态永不被读面改写

test('T3 五终态即使过期也不动：state / revision 不变，成功作业仍读得出结果', async () => {
  assert.equal(TERMINAL_JOB_STATES.length, 5, '契约终态必须是五态');

  for (const terminal of TERMINAL_JOB_STATES) {
    const { store, service, clock, counter, history } = boot();
    // 「人为把 deadline 设到过去」：截止时间远在裁定时刻之前（过期条件必然成立）。
    const deadlineAt = new Date(T0.getTime() - 60 * 60 * 1000);
    const recognitionId = randomUUID();
    const job = await seedJob(store, {
      state: terminal,
      revision: 7,
      deadlineAt,
      recognitionId,
      errorCode: terminal === 'succeeded' || terminal === 'uncertain' ? null : 'PROVIDER_FAILED',
    });
    const hasRecognition = terminal === 'succeeded' || terminal === 'uncertain';
    if (hasRecognition) await seedRecognitionRow(store, { id: recognitionId });

    clock.at = atDeadlinePlus(deadlineAt, 24 * 60 * 60 * 1000);
    const projection = await service.getJob({ userId: USER, jobId: job.id });

    assert.equal(projection.state, terminal, `终态 ${terminal} 不得被读面改写成 timed_out`);
    assert.equal(projection.revision, 7, `终态 ${terminal} 的 revision 不得被读面改写`);
    assert.equal(
      projection.error_code,
      terminal === 'succeeded' || terminal === 'uncertain' ? null : 'PROVIDER_FAILED',
      `终态 ${terminal} 的 error_code 不得被改写`,
    );
    if (hasRecognition) {
      assert.notEqual(projection.result, null, `终态 ${terminal} 必须仍读得出识别结果`);
      assert.equal(projection.result.kind, 'recognition', `终态 ${terminal} 的结果种类必须是 recognition`);
      assert.equal(projection.result.value.id, recognitionId, `终态 ${terminal} 必须取到同一条识别记录`);
    } else {
      assert.equal(projection.result, null, `终态 ${terminal} 的 result 仍为 null`);
    }
    assert.equal(counter.updateJob, 0, `终态 ${terminal} 一次写都不许发生`);
    assert.equal(history.calls.length, 0, `终态 ${terminal} 不得通知历史端口`);
    const persisted = await store.getJob(job.id);
    assert.equal(persisted.state, terminal, `落库的终态 ${terminal} 不得被改写`);
    assert.equal(persisted.revision, 7, `落库 revision 不得被改写`);
  }
});

// ------------------------------------------- T4：未过期不裁定

test('T4 未过期（deadline+grace-1ms）⇒ 仍 queued / running，revision 不变且一次写都没有', async () => {
  for (const state of ['queued', 'running']) {
    const { store, service, clock, counter } = boot();
    const job = await seedJob(store, { state, revision: 2 });

    clock.at = atDeadlinePlus(job.deadlineAt, JOB_EXPIRY_GRACE_MS - 1);
    const projection = await service.getJob({ userId: USER, jobId: job.id });

    assert.equal(projection.state, state, `${state} 未过期时必须原样回报，不许提前裁定`);
    assert.equal(projection.revision, 2, `${state} 未过期时 revision 不得变化`);
    assert.equal(projection.error_code, null, `${state} 未过期时 error_code 不得被写`);
    assert.equal(counter.updateJob, 0, `${state} 未过期时不得发生任何写`);
    const persisted = await store.getJob(job.id);
    assert.equal(persisted.state, state, `落库状态必须仍是 ${state}`);
    assert.equal(persisted.revision, 2, '落库 revision 不得变化');
    assert.equal(persisted.updatedAt.getTime(), T0.getTime(), 'updatedAt 不得变化');
  }
});

// ------------------------------------------- T5：宽限边界（含等号）

test('T5 宽限边界含等号：deadline+grace 整点即裁定，-1ms 不裁定', async () => {
  // 纯函数层：等号即过期，且默认宽限取自唯一真源。
  const deadlineAt = new Date(T0.getTime() + DEADLINE_MS);
  assert.equal(typeof JOB_EXPIRY_GRACE_MS, 'number', 'JOB_EXPIRY_GRACE_MS 必须是数字');
  assert.equal(JOB_EXPIRY_GRACE_MS, 5 * 1000, '宽限口径必须仍是 5 秒');
  assert.equal(
    isDeadlineExpired(deadlineAt, atDeadlinePlus(deadlineAt, JOB_EXPIRY_GRACE_MS)),
    true,
    '等于 deadline+grace 必须判过期（含等号）',
  );
  assert.equal(
    isDeadlineExpired(deadlineAt, atDeadlinePlus(deadlineAt, JOB_EXPIRY_GRACE_MS - 1)),
    false,
    'deadline+grace-1ms 不得判过期',
  );
  assert.equal(isDeadlineExpired(deadlineAt, new Date(deadlineAt.getTime())), false, '到点但未过宽限不得判过期');
  assert.equal(isDeadlineExpired(deadlineAt, new Date(deadlineAt.getTime() - 1)), false, '截止前当然不得判过期');
  assert.equal(isDeadlineExpired(deadlineAt, deadlineAt, 0), true, '显式传 graceMs=0 时到点即过期（等号口径一致）');

  // 服务层：边界整点裁定。
  const exact = boot();
  const exactJob = await seedJob(exact.store, { state: 'queued', revision: 1 });
  exact.clock.at = atDeadlinePlus(exactJob.deadlineAt, JOB_EXPIRY_GRACE_MS);
  const adjudicated = await exact.service.getJob({ userId: USER, jobId: exactJob.id });
  assert.equal(adjudicated.state, 'timed_out', '边界整点必须裁定（含等号）');
  assert.equal(adjudicated.revision, 2, '边界整点裁定的 revision 恰好 +1');

  // 服务层：边界前 1ms 不裁定。
  const before = boot();
  const beforeJob = await seedJob(before.store, { state: 'queued', revision: 1 });
  before.clock.at = atDeadlinePlus(beforeJob.deadlineAt, JOB_EXPIRY_GRACE_MS - 1);
  const untouched = await before.service.getJob({ userId: USER, jobId: beforeJob.id });
  assert.equal(untouched.state, 'queued', '边界前 1ms 不得裁定');
  assert.equal(untouched.revision, 1, '边界前 1ms 的 revision 不得变化');
  assert.equal(before.counter.updateJob, 0, '边界前 1ms 不得发生任何写');
});

// ------------------------------------------- T6：幂等 / 并发

test('T6a 连读两次 ⇒ revision 只 +1（第二次不再 +1），不产生识别记录', async () => {
  const { store, service, clock, counter, history } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1 });
  clock.at = atDeadlinePlus(job.deadlineAt, JOB_EXPIRY_GRACE_MS + 5);

  const first = await service.getJob({ userId: USER, jobId: job.id });
  const second = await service.getJob({ userId: USER, jobId: job.id });

  assert.equal(first.state, 'timed_out');
  assert.equal(first.revision, 2, '第一次读面裁定：revision 恰好 +1');
  assert.equal(second.state, 'timed_out', '第二次读到的仍是同一个终态');
  assert.equal(second.revision, 2, '第二次不得再自增 revision（终态短路）');
  assert.equal(counter.updateJob, 1, '两次 GET 只产生一次终态写入');
  assert.equal(await store.getRecognition(job.recognitionId), null, '两次 GET 都不得产生识别记录');
  assert.equal(history.calls.length, 0, '两次 GET 都不得通知历史端口');
});

test('T6b CAS 抢不到 ⇒ 返回 store 里的当前投影（cancelled），不谎报 timed_out、不重试循环', async () => {
  const { store, raw, service, clock, counter } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1 });
  clock.at = atDeadlinePlus(job.deadlineAt, JOB_EXPIRY_GRACE_MS + 1);

  let simulated = false;
  // 读面读到「过期且非终态」之后、写之前，另一路（取消）先落了终态 ⇒ 读面的 CAS 必然失败。
  store.getJob = async (jobId) => {
    const snapshot = await raw.getJob(jobId);
    if (!simulated && jobId === job.id && snapshot !== null && snapshot.state === 'queued') {
      simulated = true;
      await raw.commitTerminal(
        jobId,
        snapshot.revision,
        { state: 'cancelled', errorCode: null },
        null,
        new Date(clock.at.getTime()),
      );
    }
    return snapshot;
  };

  const projection = await service.getJob({ userId: USER, jobId: job.id });

  assert.equal(simulated, true, '并发现场必须真的构造出来（否则本用例无效）');
  assert.equal(projection.state, 'cancelled', '抢不到 CAS 时必须如实返回当前终态，绝不谎报自己没写成的 timed_out');
  assert.equal(projection.revision, 2, '投影的 revision 取 store 现值（并发方那次 +1）');
  assert.equal(projection.error_code, null, '投影的 error_code 也取 store 现值（cancelled 无错误码）');
  assert.equal(counter.updateJob, 1, 'CAS 抢不到不得重试循环（恰好一次尝试）');
  const persisted = await raw.getJob(job.id);
  assert.equal(persisted.state, 'cancelled', '落库终态必须保持并发方写的 cancelled');
  assert.equal(persisted.revision, 2, '落库 revision 不得被读面再改');
  assert.equal(await store.getRecognition(job.recognitionId), null, '不得产生识别记录');
});

test('T6c 重读失败 ⇒ 沿用首读已授权的那一行，绝不把 GET 变 500；首读失败仍照旧向上抛', async () => {
  const { store, raw, service, clock, counter } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1 });
  clock.at = atDeadlinePlus(job.deadlineAt, JOB_EXPIRY_GRACE_MS + 1);

  let reads = 0;
  store.getJob = async (jobId) => {
    reads += 1;
    if (reads === 1) {
      const snapshot = await raw.getJob(jobId);
      // 并发放手（取消）先落终态 ⇒ 读面的 CAS 期望 revision 一定过期；随后重读又赶上存储瞬时失败。
      await raw.commitTerminal(
        jobId,
        snapshot.revision,
        { state: 'cancelled', errorCode: null },
        null,
        new Date(clock.at.getTime()),
      );
      return snapshot;
    }
    throw new Error('模拟存储瞬时失败');
  };

  const projection = await service.getJob({ userId: USER, jobId: job.id });

  assert.equal(reads, 2, 'CAS 抢不到必须重读恰好一次（不重试循环）');
  assert.equal(counter.updateJob, 1, 'CAS 只尝试一次，读面不会为了成功而反复写');
  assert.equal(projection.state, 'queued', '重读失败时投影取首读那一行原样，不伪造自己没写成的 timed_out');
  assert.equal(projection.revision, 1, '不得凭重读失败改写 revision');

  // 首读抛错（越权 / 不存在 / 存储故障）必须照旧向上抛：裁定层不吞 GET 原有的错误语义。
  const second = boot();
  const otherJob = await seedJob(second.store, { state: 'queued', revision: 1 });
  second.store.getJob = async () => {
    throw new Error('首读就失败');
  };
  await assert.rejects(
    () => second.service.getJob({ userId: USER, jobId: otherJob.id }),
    /首读就失败/,
    '首读异常必须原样冒泡（GET 的 404 语义不变）',
  );
});

// ------------------------------------------- T7：宽限全仓单一真源

test('T7 JOB_EXPIRY_GRACE_MS 全仓单一真源：只有 services/api/src/jobs/expiry.ts 定义它', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.local', '.supervisor', 'coverage']);
  const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.jsx'];
  // 「定义」= `const JOB_EXPIRY_GRACE_MS = …` 声明；re-export（`export { JOB_EXPIRY_GRACE_MS }`）
  // 与 import 都不算定义——真源只许有一处，别处只能是引用。
  const DECLARATION = /^[ \t]*(?:export[ \t]+)?const[ \t]+JOB_EXPIRY_GRACE_MS[ \t]*[:=]/m;

  function walk(dir, found) {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        walk(full, found);
        continue;
      }
      if (!CODE_EXTENSIONS.some((ext) => entry.endsWith(ext))) continue;
      if (DECLARATION.test(readFileSync(full, 'utf8'))) found.push(relative(root, full).split('\\').join('/'));
    }
    return found;
  }

  const declarers = walk(root, []).sort();
  assert.deepEqual(
    declarers,
    ['services/api/src/jobs/expiry.ts'],
    `宽限常量必须只有一处定义（两处各写一个 5*1000 就会有人只改一处）：实际命中 ${JSON.stringify(declarers)}`,
  );
});

// ------------------------------------------- T8：历史端口 / 写入口

test('T8 读面裁定不写历史、不 insertJob、不 commitTerminal；执行路径照常通知（对照，证明计数口有效）', async () => {
  const { store, service, clock, counter, history } = boot();

  // ① 读面裁定：历史端口零调用，且不碰任务的创建/终态提交口。
  const job = await seedJob(store, { state: 'queued', revision: 1 });
  counter.reset();
  clock.at = atDeadlinePlus(job.deadlineAt, JOB_EXPIRY_GRACE_MS + 1);
  const projection = await service.getJob({ userId: USER, jobId: job.id });
  assert.equal(projection.state, 'timed_out', '前提：读面确实裁定了');
  assert.equal(history.calls.length, 0, 'GET 是读请求：不得让识别历史凭空多出一行');
  assert.equal(counter.updateJob, 1, '前提：裁定只走一次 store.updateJob');
  assert.equal(counter.insertJob, 0, '裁定不得 insertJob');
  assert.equal(counter.commitTerminal, 0, '裁定不得 commitTerminal（那会连带写历史与识别记录）');

  // ② 对照：走执行路径的终态提交，历史端口必须被调到一次（否则 ① 的 0 次毫无意义）。
  const created = await service.createRecognition({
    userId: USER,
    body: { media_id: randomUUID(), media_revision: 1 },
    idempotencyKey: nextKey(),
  });
  await service.settle();
  const done = await service.getJob({ userId: USER, jobId: created.job.id });
  assert.equal(done.state, 'succeeded', '前提：执行路径确实跑到了 succeeded');
  assert.equal(counter.insertJob, 1, '执行路径必须 insertJob 一次（对照）');
  assert.equal(counter.commitTerminal, 1, '执行路径必须 commitTerminal 一次（对照）');
  assert.equal(history.calls.length, 1, '执行路径的终态提交必须通知历史端口一次');
  assert.equal(history.calls[0].job_state, 'succeeded', '历史端口拿到的必须是实际落库的终态');
  assert.equal(history.calls[0].job_id, created.job.id, '历史行必须指向同一个作业');
  assert.equal(history.calls[0].owner_id, USER, '历史行的归属者是服务端解析的本人');
});
