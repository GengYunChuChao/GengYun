/**
 * GY-R72（W30）：作业读面超时裁定（OCR 域）单测。
 *
 * 缺陷：`GET /jobs/{id}` 在「执行器缺席 / 进程重启 / 提供者卡死」时**永远**回报
 * `queued` / `running`，用户界面的「处理中」永不结束。口径照抄合成域先例
 * （`services/api/src/tts/service.ts:45-47`、`:428-442`），宽限与「过期」判定收在
 * `services/api/src/jobs/expiry.ts` 这一处真源。
 *
 * 判据（派单 `.pg17/tmp/r72-w30-brief.md` §1.3 / §2）：
 *   T1 `queued` 过期 ⇒ `timed_out` + `PROVIDER_TIMEOUT`，`result === null`，`revision` **恰好 +1**；
 *   T2 `running` 过期 ⇒ 同上；
 *   T3 终态（五态）即使过期也**一个字都不动**（state / revision 不变，成功作业仍读得出结果）；
 *   T4 未过期（`deadline + grace - 1ms`）⇒ 原样 `queued` / `running`，且**一次写都没有**；
 *   T5 宽限边界**含等号**：`deadline + grace` 整点即裁定，`-1ms` 不裁定；
 *   T6 幂等/并发：连读两次只自增一次；CAS 抢不到 ⇒ 返回当前投影，不谎报、不重试循环；
 *   T7 宽限**只有一处定义**：`jobs/expiry.ts` 与 `tts/service.ts` 的导出是同一个值（防将来只改一处）；
 *   T8 读面裁定**不**通知历史端口（同域先例：取消也不写历史）；执行路径仍照常通知（对照，防止
 *     上面那条「0 次」其实是因为端口根本接不上）。
 *
 * 断言一律先判 `typeof` / 具体键，再判值；不使用「只要不抛错就算通过」的写法。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { STUB_IDEMPOTENCY_HMAC_KEY } from '../../services/api/src/auth/service.ts';
import { JOB_EXPIRY_GRACE_MS, isDeadlineExpired } from '../../services/api/src/jobs/expiry.ts';
import { createOcrService } from '../../services/api/src/ocr/service.ts';
import { createMemoryOcrStore } from '../../services/api/src/ocr/store.ts';
import { createSubstituteMediaPort } from '../../services/api/src/ocr/media.ts';
import {
  createSubstituteDosePort,
  createSubstituteReferencePort,
} from '../../services/api/src/ocr/reference.ts';
import { TERMINAL_JOB_STATES } from '../../services/api/src/ocr/state.ts';
import { JOB_EXPIRY_GRACE_MS as TTS_JOB_EXPIRY_GRACE_MS } from '../../services/api/src/tts/service.ts';

// ---------------------------------------------------------------- 辅助

const HMAC_KEY = STUB_IDEMPOTENCY_HMAC_KEY ?? 'gengyun-stub-idempotency-hmac-key';
const USER = 'user-owner-0001';
/** 受理时刻（固定，不读真实时钟：宽限与时序都要可复算）。 */
const T0 = new Date('2026-10-17T08:00:00.000Z');
/** 作业默认截止时间（与 `DEFAULT_JOB_DEADLINE_MS` 同值，但断言不依赖那个常量）。 */
const DEADLINE_MS = 30 * 1000;

/** 契约 LabelFields（四字段全必填，数组可为空但不缺失）。 */
const LABEL_FIELDS = Object.freeze({
  registration_number: 'PD20210001',
  name: '草甘膦异丙胺盐',
  ingredients: Object.freeze([{ name: '草甘膦', content_text: '41%', unit_text: '%' }]),
  dosage_form: '水剂',
});

let keyCounter = 0;
function nextKey() {
  keyCounter += 1;
  return `ocr-expiry-key-${String(keyCounter).padStart(6, '0')}`;
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
 * 计数用的 store 包装：`updateJob` / `commitTerminal` 的**调用次数**。
 * 读面裁定必须「恰好写一次」，只看 revision 无法区分「写一次」与「写两次但值相同」。
 */
function instrumentStore(store) {
  const counter = { updateJob: 0, commitTerminal: 0 };
  const updateJob = store.updateJob.bind(store);
  const commitTerminal = store.commitTerminal.bind(store);
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

/** 组装服务：内存 store + 注入时钟 + 假提供者（永不真的做 OCR）。 */
function boot(overrides = {}) {
  const store = createMemoryOcrStore();
  const counter = instrumentStore(store);
  const clock = { at: overrides.at ?? T0 };
  const history = overrides.history ?? createSpyHistoryPort();
  const service = createOcrService({
    store,
    provider: overrides.provider ?? {
      executionMode: 'stub',
      modelVersion: 'stub-v1',
      available: true,
      unavailableReason: null,
      async extract() {
        return { kind: 'completed', fields: LABEL_FIELDS };
      },
    },
    media: overrides.media ?? createSubstituteMediaPort(),
    reference: overrides.reference ?? createSubstituteReferencePort(),
    dose: overrides.dose ?? createSubstituteDosePort(),
    history: history.port,
    idempotencyHmacKey: HMAC_KEY,
    now: () => new Date(clock.at.getTime()),
  });
  return { store, service, clock, counter, history };
}

/** 直接向内存 store 落一条作业行（精确构造 queued / running / 终态现场）。 */
async function seedJob(store, overrides = {}) {
  const row = {
    id: randomUUID(),
    revision: 1,
    kind: 'ocr',
    ownerUserId: USER,
    ocrId: randomUUID(),
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

/** 契约 OCR 记录的最小合法形状（T3 用：证明成功作业仍读得出结果）。 */
function seedOcrRow(store, { id, ownerUserId = USER }) {
  return store.insertOcr({
    id,
    revision: 1,
    ownerUserId,
    mediaId: randomUUID(),
    mediaRevision: 1,
    rawFields: { registration_number: null, name: null, ingredients: [], dosage_form: null },
    correctedFields: { registration_number: null, name: null, ingredients: [], dosage_form: null },
    verification: {
      match_state: 'unmatched',
      registration: null,
      conflict_fields: [],
      missing_fields: [],
      dose_cards: [],
    },
    modelVersion: 'stub-v1',
    createdAt: T0,
    updatedAt: T0,
    deleted: false,
  });
}

/** `deal deadline + offsetMs` 的时刻（不改 row，只算时钟位置）。 */
function atDeadlinePlus(deadlineAt, offsetMs) {
  return new Date(deadlineAt.getTime() + offsetMs);
}

// ------------------------------------------- T1：queued 过期

test('T1 queued 过期 ⇒ timed_out + PROVIDER_TIMEOUT，revision 恰好 +1，result 为 null', async () => {
  const { store, service, clock, counter, history } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1 });
  assert.equal(await store.getOcr(job.ocrId), null, '裁定前不得已有 OCR 记录');

  clock.at = atDeadlinePlus(job.deadlineAt, JOB_EXPIRY_GRACE_MS);
  const projection = await service.getJob({ userId: USER, jobId: job.id });

  assert.equal(projection.state, 'timed_out', '过期作业必须显式落 timed_out，不许继续回报 queued');
  assert.equal(projection.error_code, 'PROVIDER_TIMEOUT', '错误码必须是 PROVIDER_TIMEOUT');
  assert.equal(projection.result, null, 'timed_out 不产出 OCR 记录 ⇒ result 恒为 null');
  assert.equal(projection.revision, 2, 'revision 必须从 1 恰好递增到 2（不是 +2、不是 +0）');
  assert.equal(projection.deadline_at, job.deadlineAt.toISOString(), 'deadline_at 不得被裁定改写');
  assert.deepEqual(
    Object.keys(projection).sort(),
    ['created_at', 'deadline_at', 'error_code', 'id', 'kind', 'result', 'revision', 'state', 'target_ref'],
    'JobProjection 形状不得因本片新增字段',
  );

  const persisted = await store.getJob(job.id);
  assert.equal(persisted.state, 'timed_out', '落库状态必须是 timed_out');
  assert.equal(persisted.errorCode, 'PROVIDER_TIMEOUT', '落库错误码必须是 PROVIDER_TIMEOUT');
  assert.equal(persisted.revision, 2, '落库 revision 必须恰好 +1');
  assert.equal(persisted.updatedAt.getTime(), clock.at.getTime(), 'updatedAt 取裁定时刻');
  assert.equal(persisted.deadlineAt.getTime(), job.deadlineAt.getTime(), 'deadline_at 不得被改写');
  assert.equal(persisted.createdAt.getTime(), job.createdAt.getTime(), 'created_at 不得被改写');

  assert.equal(await store.getOcr(job.ocrId), null, '读面裁定**不得**产生 OCR 记录');
  assert.equal(counter.updateJob, 1, '裁定必须恰好写一次（单次 CAS，不重试）');
  assert.equal(counter.commitTerminal, 0, '读面裁定不走 commitTerminal（那会连带写历史与 OCR 记录）');
  assert.equal(history.calls.length, 0, '读面裁定不得通知历史端口');
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
  assert.equal(await store.getOcr(job.ocrId), null, '不得产生 OCR 记录');
  assert.equal(counter.updateJob, 1, '恰好写一次');
});

// ------------------------------------------- T3：终态永不被读面改写

test('T3 五终态即使过期也不动：state / revision 不变，成功作业仍读得出结果', async () => {
  assert.equal(TERMINAL_JOB_STATES.length, 5, '契约终态必须是五态');

  for (const terminal of TERMINAL_JOB_STATES) {
    const { store, service, clock, counter } = boot();
    // 「人为把 deadline 设到过去」：截止时间远在裁定时刻之前（过期条件必然成立）。
    const deadlineAt = new Date(T0.getTime() - 60 * 60 * 1000);
    const ocrId = randomUUID();
    const job = await seedJob(store, {
      state: terminal,
      revision: 7,
      deadlineAt,
      ocrId,
      errorCode: terminal === 'succeeded' || terminal === 'uncertain' ? null : 'PROVIDER_FAILED',
    });
    const hasOcr = terminal === 'succeeded' || terminal === 'uncertain';
    if (hasOcr) await seedOcrRow(store, { id: ocrId });

    clock.at = atDeadlinePlus(deadlineAt, 24 * 60 * 60 * 1000);
    const projection = await service.getJob({ userId: USER, jobId: job.id });

    assert.equal(projection.state, terminal, `终态 ${terminal} 不得被读面改写成 timed_out`);
    assert.equal(projection.revision, 7, `终态 ${terminal} 的 revision 不得被读面改写`);
    if (hasOcr) {
      assert.notEqual(projection.result, null, `终态 ${terminal} 必须仍读得出 OCR 结果`);
      assert.equal(projection.result.kind, 'ocr', `终态 ${terminal} 的结果种类必须是 ocr`);
    } else {
      assert.equal(projection.result, null, `终态 ${terminal} 的 result 仍为 null`);
    }
    assert.equal(counter.updateJob, 0, `终态 ${terminal} 一次写都不许发生`);
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
  assert.equal(
    isDeadlineExpired(deadlineAt, new Date(deadlineAt.getTime() - 1)),
    false,
    '截止前当然不得判过期',
  );
  assert.equal(
    isDeadlineExpired(deadlineAt, deadlineAt, 0),
    true,
    '显式传 graceMs=0 时到点即过期（等号口径在任意宽限下一致）',
  );

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

test('T6a 连读两次 ⇒ revision 只 +1（第二次不再 +1），不产生 OCR 记录', async () => {
  const { store, service, clock, counter, history } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1 });
  clock.at = atDeadlinePlus(job.deadlineAt, JOB_EXPIRY_GRACE_MS + 5);

  const first = await service.getJob({ userId: USER, jobId: job.id });
  const second = await service.getJob({ userId: USER, jobId: job.id });

  assert.equal(first.state, 'timed_out');
  assert.equal(first.revision, 2, '第一次读面裁定：revision 恰好 +1');
  assert.equal(second.state, 'timed_out', '第二次读到的仍是同一个终态');
  assert.equal(second.revision, 2, '第二次不得再自增 revision');
  assert.equal(counter.updateJob, 1, '两次 GET 只产生一次终态写入');
  assert.equal(await store.getOcr(job.ocrId), null, '两次 GET 都不得产生 OCR 记录');
  assert.equal(history.calls.length, 0, '两次 GET 都不得通知历史端口');
});

test('T6b CAS 抢不到 ⇒ 返回 store 里的当前投影（cancelled），不谎报 timed_out、不重试循环', async () => {
  const { store, service, clock, counter } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1 });
  clock.at = atDeadlinePlus(job.deadlineAt, JOB_EXPIRY_GRACE_MS + 1);

  const realGetJob = store.getJob.bind(store);
  const realCommitTerminal = store.commitTerminal.bind(store);
  let simulated = false;
  // 读面读到「过期且非终态」之后、写之前，另一路（取消）先落了终态 ⇒ 读面的 CAS 必然失败。
  store.getJob = async (jobId) => {
    const snapshot = await realGetJob(jobId);
    if (!simulated && jobId === job.id && snapshot !== null && snapshot.state === 'queued') {
      simulated = true;
      await realCommitTerminal(
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
  assert.equal(counter.updateJob, 1, 'CAS 抢不到不得重试循环（恰好一次尝试）');
  const persisted = await realGetJob(job.id);
  assert.equal(persisted.state, 'cancelled', '落库终态必须保持并发方写的 cancelled');
  assert.equal(persisted.revision, 2, '落库 revision 不得被读面再改');
  assert.equal(await store.getOcr(job.ocrId), null, '不得产生 OCR 记录');
});

test('T6c 重读失败 ⇒ 沿用首读已授权的那一行，绝不把 GET 变 500；首读失败仍照旧向上抛', async () => {
  const { store, service, clock, counter } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1 });
  clock.at = atDeadlinePlus(job.deadlineAt, JOB_EXPIRY_GRACE_MS + 1);

  const realGetJob = store.getJob.bind(store);
  const realCommitTerminal = store.commitTerminal.bind(store);
  let reads = 0;
  store.getJob = async (jobId) => {
    reads += 1;
    if (reads === 1) {
      const snapshot = await realGetJob(jobId);
      // 并发放手（取消）先落终态 ⇒ 读面的 CAS 期望 revision 一定过期；随后重读又赶上存储瞬时失败。
      await realCommitTerminal(
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

  // 首读抛错（越权 / 不存在）必须照旧向上抛：裁定层不吞 GET 原有的错误语义。
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

test('T7 宽限只有一处定义：jobs/expiry.ts 与 tts/service.ts 的导出是同一个值', () => {
  assert.equal(typeof JOB_EXPIRY_GRACE_MS, 'number', 'JOB_EXPIRY_GRACE_MS 必须是数字');
  assert.equal(JOB_EXPIRY_GRACE_MS, 5 * 1000, '宽限口径必须仍是 5 秒');
  assert.equal(
    TTS_JOB_EXPIRY_GRACE_MS,
    JOB_EXPIRY_GRACE_MS,
    '合成域必须复用同一真源（两处各写一个 5*1000 就会有人只改一处）',
  );
});

// ------------------------------------------- T8：历史端口

test('T8 读面裁定不通知历史端口；执行路径照常通知（对照，证明端口真的接上了）', async () => {
  const { store, service, clock, history } = boot();

  // ① 读面裁定：历史端口零调用。
  const job = await seedJob(store, { state: 'queued', revision: 1 });
  clock.at = atDeadlinePlus(job.deadlineAt, JOB_EXPIRY_GRACE_MS + 1);
  const projection = await service.getJob({ userId: USER, jobId: job.id });
  assert.equal(projection.state, 'timed_out', '前提：读面确实裁定了');
  assert.equal(history.calls.length, 0, 'GET 是读请求：不得让识别历史凭空多出一行');

  // ② 对照：走执行路径的终态提交，历史端口必须被调到一次（否则 ① 的 0 次毫无意义）。
  const created = await service.createOcr({
    userId: USER,
    body: { media_id: randomUUID(), media_revision: 1 },
    idempotencyKey: nextKey(),
  });
  await service.settle();
  const done = await service.getJob({ userId: USER, jobId: created.job.id });
  assert.equal(done.state, 'succeeded', '前提：执行路径确实跑到了 succeeded');
  assert.equal(history.calls.length, 1, '执行路径的终态提交必须通知历史端口一次');
  assert.equal(history.calls[0].job_state, 'succeeded', '历史端口拿到的必须是实际落库的终态');
  assert.equal(history.calls[0].job_id, created.job.id, '历史行必须指向同一个作业');
});
