/**
 * GY-R72（W33）：作业读面超时裁定（语音转写域）单测。
 *
 * 缺陷：`GET /jobs/{id}` 在「执行器缺席 / 进程重启 / 提供者卡死」时**永远**回报
 * `queued` / `running`，用户界面的「处理中」永不结束。口径照抄合成域先例
 * （`services/api/src/tts/service.ts:45-47`、`:428-442`），实现与 OCR 域同形
 * （`services/api/src/ocr/service.ts` 末尾的 `adjudicateExpiredOcrJob`），而「宽限多长」
 * 「算不算过期」的唯一真源是 `services/api/src/jobs/expiry.ts`——本域只 import，不复制。
 *
 * 判据（派单 `.pg17/tmp/r72-w33-brief.md` §2）：
 *   T1 `queued` 过期 ⇒ `timed_out` + `PROVIDER_TIMEOUT`，`result === null`，`revision` **恰好 +1**；
 *   T2 `running` 过期 ⇒ 同上（revision 从 3 恰好递增到 4）；
 *   T3 终态（五态）即使过期也**一个字都不动**（state / revision / updatedAt 不变，成功作业仍读得出结果）；
 *   T4 未过期（`deadline + grace - 1ms`）⇒ 原样 `queued` / `running`，且**一次写都没有**；
 *   T5 宽限边界**含等号**：`deadline + grace` 整点即裁定，`-1ms` 不裁定；
 *   T6 幂等 / 并发：连读两次只自增一次；CAS 抢不到 ⇒ 返回 store 现值，**不谎报自己写成了**、
 *      不重试循环；重读抛错 ⇒ 退回首读行（GET 不许 500）；首读抛错照旧向上冒泡；
 *   T7 宽限**只有一处定义**：本域不另建常量、不另写比较式，与 `jobs/expiry.ts` 及 TTS re-export 同值；
 *   T8 读面裁定**只动 `speech_jobs` 那一行**：不写转写记录、不走 `commitTerminal`；执行路径仍照常
 *      写记录（对照，防止上面那条「0 次」其实是因为计数口根本接不上）。
 *
 * 断言一律先判 `typeof` / 具体键，再判值；不使用「只要不抛错就算通过」的写法。
 * 时间一律由注入的 `now()` 决定（不 sleep、不读真实时钟），宽限可从 `deadlineAt` 精确复算。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STUB_IDEMPOTENCY_HMAC_KEY } from '../../services/api/src/auth/service.ts';
import { JOB_EXPIRY_GRACE_MS, isDeadlineExpired } from '../../services/api/src/jobs/expiry.ts';
import { createSpeechService } from '../../services/api/src/speech/service.ts';
import { createMemorySpeechStore } from '../../services/api/src/speech/store.ts';
import { createSubstituteMediaPort } from '../../services/api/src/speech/media.ts';
import { TERMINAL_JOB_STATES } from '../../services/api/src/speech/state.ts';
import { JOB_EXPIRY_GRACE_MS as TTS_JOB_EXPIRY_GRACE_MS } from '../../services/api/src/tts/service.ts';

// ---------------------------------------------------------------- 辅助

const HMAC_KEY = STUB_IDEMPOTENCY_HMAC_KEY ?? 'gengyun-stub-idempotency-hmac-key';
const USER = 'user-owner-0001';
const OTHER_USER = 'user-owner-9999';
/** 受理时刻（固定，不读真实时钟：宽限与时序都要可复算）。 */
const T0 = new Date('2026-10-17T08:00:00.000Z');
/** 作业默认截止时间（与 `DEFAULT_JOB_DEADLINE_MS` 同值，但断言不依赖那个常量）。 */
const DEADLINE_MS = 30 * 1000;

let keyCounter = 0;
function nextKey() {
  keyCounter += 1;
  return `speech-expiry-key-${String(keyCounter).padStart(6, '0')}`;
}

/**
 * 计数用的 store 包装：`insertJob` / `insertTranscription` / `updateJob` / `commitTerminal`
 * 的**调用次数**，并保留未被计数的原始方法（`raw`）供「模拟另一位并发调用方」使用
 * （模拟写入不该混进「读面写了几次」的读数）。
 */
function instrumentStore(store) {
  const counter = { insertJob: 0, insertTranscription: 0, updateJob: 0, commitTerminal: 0 };
  const raw = {
    insertJob: store.insertJob.bind(store),
    insertTranscription: store.insertTranscription.bind(store),
    getJob: store.getJob.bind(store),
    updateJob: store.updateJob.bind(store),
    commitTerminal: store.commitTerminal.bind(store),
  };
  store.insertJob = async (...args) => {
    counter.insertJob += 1;
    return raw.insertJob(...args);
  };
  store.insertTranscription = async (...args) => {
    counter.insertTranscription += 1;
    return raw.insertTranscription(...args);
  };
  store.updateJob = async (...args) => {
    counter.updateJob += 1;
    return raw.updateJob(...args);
  };
  store.commitTerminal = async (...args) => {
    counter.commitTerminal += 1;
    return raw.commitTerminal(...args);
  };
  return { counter, raw };
}

/** 确定性转写提供者（替身：只回一句固定文本，不模拟 ASR 效果）。 */
function createFixedTranscriptProvider(text = '替身示例·读面裁定单测用固定转写（非真实录音）') {
  return {
    executionMode: 'stub',
    modelVersion: 'stub-v1',
    note: '单测用替身提供者（固定合成文本，不构成任何准确率证据）',
    available: true,
    unavailableReason: null,
    async transcribe() {
      return { kind: 'completed', transcript: { text, uncertain_spans: [] } };
    },
  };
}

/** 组装服务：内存 store + 计数代理 + 注入时钟 + 替身提供者/媒体端口（不发包、不读磁盘）。 */
function boot(overrides = {}) {
  const store = createMemorySpeechStore();
  const { counter, raw } = instrumentStore(store);
  const clock = { at: overrides.at ?? T0 };
  const service = createSpeechService({
    store,
    provider: overrides.provider ?? createFixedTranscriptProvider(),
    media: overrides.media ?? createSubstituteMediaPort(),
    idempotencyHmacKey: HMAC_KEY,
    now: () => new Date(clock.at.getTime()),
    idFactory: () => randomUUID(),
  });
  return { store, service, clock, counter, raw };
}

/** 直接向内存 store 落一条作业行（精确构造 queued / running / 终态现场）。 */
async function seedJob(store, overrides = {}) {
  const row = {
    id: randomUUID(),
    revision: 1,
    kind: 'transcription',
    ownerUserId: USER,
    transcriptionId: randomUUID(),
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

/** 转写记录的最小合法形状（T3 用：证明成功作业仍读得出结果）。 */
function seedTranscriptionRow(store, { id, ownerUserId = USER }) {
  return store.insertTranscription({
    id,
    revision: 1,
    ownerUserId,
    mediaId: randomUUID(),
    mediaRevision: 1,
    rawText: '替身示例·已成功的历史转写（非真实录音）',
    uncertainSpans: [],
    confirmedText: null,
    confirmedAt: null,
    modelVersion: 'stub-v1',
    createdAt: T0,
    updatedAt: T0,
    deleted: false,
  });
}

/** `deadlineAt + offsetMs` 的时刻（不改 row，只算时钟位置）。 */
function atDeadlinePlus(deadlineAt, offsetMs) {
  return new Date(deadlineAt.getTime() + offsetMs);
}

// ------------------------------------------- T1：queued 过期

test('T1 queued 过期 ⇒ timed_out + PROVIDER_TIMEOUT，revision 恰好 +1，result 为 null', async () => {
  const { store, service, clock, counter } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1 });
  assert.equal(await store.getTranscription(job.transcriptionId), null, '裁定前不得已有转写记录');

  clock.at = atDeadlinePlus(job.deadlineAt, JOB_EXPIRY_GRACE_MS);
  const projection = await service.getJob({ userId: USER, jobId: job.id });

  assert.equal(projection.state, 'timed_out', '过期作业必须显式落 timed_out，不许继续回报 queued');
  assert.equal(projection.error_code, 'PROVIDER_TIMEOUT', '错误码必须是 PROVIDER_TIMEOUT');
  assert.equal(projection.result, null, 'timed_out 不产出转写记录 ⇒ result 恒为 null');
  assert.equal(projection.revision, 2, 'revision 必须从 1 恰好递增到 2（不是 +2、不是 +0）');
  assert.equal(projection.deadline_at, job.deadlineAt.toISOString(), 'deadline_at 不得被裁定改写');
  assert.equal(projection.created_at, job.createdAt.toISOString(), 'created_at 不得被裁定改写');
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

  assert.equal(await store.getTranscription(job.transcriptionId), null, '读面裁定**不得**产生转写记录');
  assert.equal(counter.updateJob, 1, '裁定必须恰好写一次（单次 CAS，不重试）');
  assert.equal(counter.commitTerminal, 0, '读面裁定不走 commitTerminal（那会连带写记录）');
  assert.equal(counter.insertTranscription, 0, '读面裁定不得写转写记录');
});

// ------------------------------------------- T1b：越权/不存在不裁定

test('T1b 越权读（别人的过期任务）⇒ 同形 NOT_FOUND，且一个字都不写', async () => {
  const { store, service, clock, counter } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1, ownerUserId: OTHER_USER });
  clock.at = atDeadlinePlus(job.deadlineAt, 24 * 60 * 60 * 1000);

  await assert.rejects(
    () => service.getJob({ userId: USER, jobId: job.id }),
    /任务不存在/,
    '越权与不存在必须同形 NOT_FOUND',
  );
  assert.equal(counter.updateJob, 0, '没通过归属校验就绝不许替别人裁定');
  const persisted = await store.getJob(job.id);
  assert.equal(persisted.state, 'queued', '别人的任务状态不得被改写');
  assert.equal(persisted.revision, 1, '别人的任务 revision 不得被改写');

  // 不存在的 id（合法 uuid）同样是 NOT_FOUND，且同样不写。
  await assert.rejects(() => service.getJob({ userId: USER, jobId: randomUUID() }), /任务不存在/);
  assert.equal(counter.updateJob, 0, '不存在的任务不许产生写入');
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
  assert.equal(await store.getTranscription(job.transcriptionId), null, '不得产生转写记录');
  assert.equal(counter.updateJob, 1, '恰好写一次');
  assert.equal(counter.commitTerminal, 0, '不走 commitTerminal');
});

// ------------------------------------------- T3：终态永不被读面改写

test('T3 五终态即使过期也不动：state / revision / updatedAt 不变，成功作业仍读得出结果', async () => {
  assert.equal(TERMINAL_JOB_STATES.length, 5, '契约终态必须是五态');

  for (const terminal of TERMINAL_JOB_STATES) {
    const { store, service, clock, counter } = boot();
    // 「人为把 deadline 设到过去」：截止时间远在裁定时刻之前（过期条件必然成立）。
    const deadlineAt = new Date(T0.getTime() - 60 * 60 * 1000);
    const transcriptionId = randomUUID();
    const errorCode =
      terminal === 'failed'
        ? 'PROVIDER_OUTCOME_UNKNOWN'
        : terminal === 'uncertain'
          ? 'INPUT_UNCERTAIN'
          : terminal === 'timed_out'
            ? 'PROVIDER_TIMEOUT'
            : null;
    const job = await seedJob(store, {
      state: terminal,
      revision: 7,
      deadlineAt,
      transcriptionId,
      errorCode,
    });
    if (terminal === 'succeeded') await seedTranscriptionRow(store, { id: transcriptionId });

    clock.at = atDeadlinePlus(deadlineAt, 24 * 60 * 60 * 1000);
    const projection = await service.getJob({ userId: USER, jobId: job.id });

    assert.equal(projection.state, terminal, `${terminal} 是终态，读面不得改写成 timed_out`);
    assert.equal(projection.revision, 7, `${terminal} 的 revision 必须一字不动`);
    assert.equal(projection.error_code, errorCode, `${terminal} 的 error_code 不得被改写`);

    const persisted = await store.getJob(job.id);
    assert.equal(persisted.state, terminal, `${terminal} 落库状态不得被改写`);
    assert.equal(persisted.revision, 7, `${terminal} 落库 revision 不得被改写`);
    assert.equal(persisted.updatedAt.getTime(), job.updatedAt.getTime(), `${terminal} 的 updatedAt 不得被改写`);
    assert.equal(counter.updateJob, 0, `${terminal} 上一次写都不许有`);
    assert.equal(counter.commitTerminal, 0, `${terminal} 不得走 commitTerminal`);

    if (terminal === 'succeeded') {
      assert.notEqual(projection.result, null, '已成功的历史作业必须仍读得出结果（不许被超时裁决吃掉）');
      assert.equal(projection.result.kind, 'transcription');
      assert.equal(projection.result.value.raw_text, '替身示例·已成功的历史转写（非真实录音）');
    } else {
      assert.equal(projection.result, null, `${terminal} 的 result 恒为 null`);
    }
  }
});

// ------------------------------------------- T4：未过期不裁定

test('T4 未过期（deadline + grace - 1ms）⇒ 原样 queued / running，一次写都没有', async () => {
  for (const state of ['queued', 'running']) {
    const { store, service, clock, counter } = boot();
    const job = await seedJob(store, { state, revision: 2 });

    clock.at = atDeadlinePlus(job.deadlineAt, JOB_EXPIRY_GRACE_MS - 1);
    const projection = await service.getJob({ userId: USER, jobId: job.id });

    assert.equal(projection.state, state, `${state} 未过期时不得被裁定`);
    assert.equal(projection.revision, 2, `${state} 未过期时 revision 不得变`);
    assert.equal(projection.error_code, null, `${state} 未过期时不得凭空写错误码`);
    assert.equal(counter.updateJob, 0, `${state} 未过期时一次写都不许有`);
    assert.equal(await store.getTranscription(job.transcriptionId), null, '未裁定不得产生记录');
  }
});

// ------------------------------------------- T5：宽限边界含等号

test('T5 宽限边界含等号：deadline + grace 整点即裁定，早 1ms 不裁定', async () => {
  assert.equal(JOB_EXPIRY_GRACE_MS, 5 * 1000, '共享宽限必须是 5 秒（唯一真源在 jobs/expiry.ts）');
  assert.equal(
    isDeadlineExpired(T0, atDeadlinePlus(T0, JOB_EXPIRY_GRACE_MS)),
    true,
    '共享判据在整点就必须判过期（含等号）',
  );
  assert.equal(
    isDeadlineExpired(T0, atDeadlinePlus(T0, JOB_EXPIRY_GRACE_MS - 1)),
    false,
    '共享判据在早 1ms 时不得判过期',
  );

  // 边界之内：不裁定。
  {
    const { store, service, clock, counter } = boot();
    const job = await seedJob(store, { state: 'queued', revision: 1 });
    clock.at = atDeadlinePlus(job.deadlineAt, JOB_EXPIRY_GRACE_MS - 1);
    const projection = await service.getJob({ userId: USER, jobId: job.id });
    assert.equal(projection.state, 'queued', '早 1ms 时读面不得抢先裁定（让给执行器）');
    assert.equal(projection.revision, 1, '早 1ms 时 revision 不得变');
    assert.equal(counter.updateJob, 0, '早 1ms 时一次写都不许有');
  }

  // 整点：裁定（这正是「含等号」的可观测后果）。
  {
    const { store, service, clock, counter } = boot();
    const job = await seedJob(store, { state: 'queued', revision: 1 });
    clock.at = atDeadlinePlus(job.deadlineAt, JOB_EXPIRY_GRACE_MS);
    const projection = await service.getJob({ userId: USER, jobId: job.id });
    assert.equal(projection.state, 'timed_out', '整点（== deadline + grace）必须裁定');
    assert.equal(projection.revision, 2, '整点裁定的 revision 必须恰好 +1');
    assert.equal(counter.updateJob, 1, '整点裁定恰好写一次');
  }
});

// ------------------------------------------- T6a：连读两次只自增一次

test('T6a 过期作业连读两次：revision 只 +1，第二次读不再写', async () => {
  const { store, service, clock, counter } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1 });
  clock.at = atDeadlinePlus(job.deadlineAt, JOB_EXPIRY_GRACE_MS + 1000);

  const first = await service.getJob({ userId: USER, jobId: job.id });
  const afterFirst = counter.updateJob;
  const second = await service.getJob({ userId: USER, jobId: job.id });

  assert.equal(first.state, 'timed_out', '第一次读即裁定');
  assert.equal(first.revision, 2);
  assert.equal(second.state, 'timed_out', '第二次读仍是 timed_out（终态稳定）');
  assert.equal(second.revision, 2, '第二次读不得再 +1（终态永不动）');
  assert.equal(afterFirst, 1, '第一次读恰好写一次');
  assert.equal(counter.updateJob, 1, '第二次读发现已是终态 ⇒ 一次写都不许有');
  assert.equal(
    (await store.getJob(job.id)).updatedAt.getTime(),
    clock.at.getTime(),
    'updatedAt 仍是第一次裁定时刻（第二次读没再写）',
  );
});

// ------------------------------------------- T6b：CAS 抢不到 ⇒ 不谎报

test('T6b CAS 抢不到（并发方已落 cancelled）⇒ 返回 store 现值，不谎报、不重试循环', async () => {
  const { store, service, clock, counter, raw } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1 });
  clock.at = atDeadlinePlus(job.deadlineAt, JOB_EXPIRY_GRACE_MS + 1000);

  // 模拟并发方：首读返回快照后、读面 CAS 之前，另一路（如 cancelJob）已落终态。
  let reads = 0;
  store.getJob = async (jobId) => {
    reads += 1;
    if (reads === 1) {
      const snapshot = await raw.getJob(jobId);
      await raw.commitTerminal(
        jobId,
        snapshot.revision,
        { state: 'cancelled', errorCode: null },
        null,
        new Date(clock.at.getTime()),
      );
      return snapshot;
    }
    return raw.getJob(jobId);
  };

  const projection = await service.getJob({ userId: USER, jobId: job.id });

  assert.equal(projection.state, 'cancelled', 'CAS 落空时必须如实回报 store 现值，不许谎报成自己写成的 timed_out');
  assert.equal(projection.revision, 2, '现值 revision 来自并发方那一次写（+1）');
  assert.equal(reads, 2, 'CAS 落空后只许重读一次（不循环重试）');
  assert.equal(counter.updateJob, 1, 'CAS 尝试恰好一次');
  assert.equal(counter.commitTerminal, 0, '读面自己绝不调用 commitTerminal（那一次是模拟并发方走 raw）');

  const persisted = await store.getJob(job.id);
  assert.equal(persisted.state, 'cancelled', 'CAS 落空后不得覆盖并发方已落的终态');
  assert.equal(persisted.revision, 2);
});

// ------------------------------------------- T6c：重读抛错 ⇒ 退回首读行

test('T6c CAS 落空且重读抛错 ⇒ 退回首读行（GET 不许 500）；首读抛错照旧冒泡', async () => {
  {
    const { store, service, clock, counter, raw } = boot();
    const job = await seedJob(store, { state: 'queued', revision: 1 });
    clock.at = atDeadlinePlus(job.deadlineAt, JOB_EXPIRY_GRACE_MS + 1000);

    let reads = 0;
    store.getJob = async (jobId) => {
      reads += 1;
      if (reads === 1) {
        const snapshot = await raw.getJob(jobId);
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

    assert.equal(projection.state, 'queued', '重读失败时退回第一次已授权读到的那一行（真实、已过归属校验）');
    assert.equal(projection.revision, 1, '退回的是首读快照，revision 不得编造');
    assert.equal(reads, 2, '重读只尝试一次，失败就不再试');
    assert.equal(counter.updateJob, 1, 'CAS 尝试恰好一次');
  }

  {
    const { store, service, clock } = boot();
    const job = await seedJob(store, { state: 'queued', revision: 1 });
    clock.at = atDeadlinePlus(job.deadlineAt, JOB_EXPIRY_GRACE_MS + 1000);
    store.getJob = async () => {
      throw new Error('首读就失败');
    };
    await assert.rejects(
      () => service.getJob({ userId: USER, jobId: job.id }),
      /首读就失败/,
      '首读失败必须照旧向上抛（与裁定前的 GET 语义一致）',
    );
  }
});

// ------------------------------------------- T7：宽限只有一处定义

test('T7 宽限同源：本域不另建常量 / 不另写比较式，与 jobs/expiry.ts、TTS re-export 同值', () => {
  assert.equal(JOB_EXPIRY_GRACE_MS, 5 * 1000, 'jobs/expiry.ts 是唯一真源，值必须是 5 秒');
  assert.equal(TTS_JOB_EXPIRY_GRACE_MS, JOB_EXPIRY_GRACE_MS, 'TTS 域是原样 re-export，值必须一致');

  const speechDir = fileURLToPath(new URL('../../services/api/src/speech/', import.meta.url));
  const servicePath = path.join(speechDir, 'service.ts');
  const source = readFileSync(servicePath, 'utf8');

  // 本域**不得**有第二份宽限定义（读源码文本，不靠运行时值碰运气）。
  const definitionPattern = /const\s+JOB_EXPIRY_GRACE_MS\s*=/;
  for (const name of readdirSync(speechDir).filter((entry) => entry.endsWith('.ts'))) {
    const text = readFileSync(path.join(speechDir, name), 'utf8');
    assert.equal(definitionPattern.test(text), false, `services/api/src/speech/${name} 不得另建宽限常量`);
  }

  // 判据只 import 一次、调用一次；本文件里不得出现第二个毫秒字面量版本。
  const importPattern = /import\s*\{[^}]*isDeadlineExpired[^}]*\}\s*from\s*'\.\.\/jobs\/expiry\.ts';/g;
  assert.equal((source.match(importPattern) ?? []).length, 1, '必须从共享判据 import 一次（且只一处）');
  assert.equal((source.match(/isDeadlineExpired\(/g) ?? []).length, 1, '过期判定只许调用共享判据一次');
  assert.equal(/\b5000\b/.test(source), false, '本文件不得出现 5000 字面量（宽限不在本域定义）');
  assert.equal(/5 \* 1000/.test(source), false, '本文件不得出现 5 * 1000 字面量（不得复制宽限）');
});

// ------------------------------------------- T8：裁定只动作业行

test('T8 读面裁定只动 speech_jobs 那一行：不写转写记录、不走 commitTerminal（执行路径仍照常写）', async () => {
  // 前半：读面裁定。
  const { store, service, clock, counter } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1 });
  clock.at = atDeadlinePlus(job.deadlineAt, JOB_EXPIRY_GRACE_MS + 1000);
  const before = { ...counter };

  const projection = await service.getJob({ userId: USER, jobId: job.id });

  assert.equal(projection.state, 'timed_out');
  assert.equal(counter.insertJob - before.insertJob, 0, '读面裁定不得新建任务行');
  assert.equal(counter.commitTerminal - before.commitTerminal, 0, '读面裁定不得走 commitTerminal');
  assert.equal(counter.updateJob - before.updateJob, 1, '读面裁定只许恰好更新一次作业行');
  // 注意：本域 store 的 `commitTerminal` 在临界区内**直接**写记录（内存实现 `store.ts:232-233`），
  // 不经 `insertTranscription` 端口，因此该端口的计数在两条路径上都恒为 0、不能当证据；
  // 「有没有产生转写记录」由下面的 `getTranscription` 判定（记录若存在这里必然读得到）。
  assert.equal(await store.getTranscription(job.transcriptionId), null, '裁定后仍不得有转写记录');
  await assert.rejects(
    () => service.getTranscription({ userId: USER, transcriptionId: job.transcriptionId }),
    /转写记录不存在/,
    '读面裁定不得让转写记录凭空出现（getTranscription 仍判 NOT_FOUND）',
  );

  // 后半（对照）：执行路径**照常**写记录 —— 否则上面那串「0 次」可能只是计数口接不上。
  {
    const run = boot();
    const mediaId = randomUUID();
    const { job: created } = await run.service.createTranscription({
      userId: USER,
      body: { media_id: mediaId, media_revision: 1 },
      idempotencyKey: nextKey(),
    });
    await run.service.settle();
    const settled = await run.service.getJob({ userId: USER, jobId: created.id });

    assert.equal(settled.state, 'succeeded', '对照组的执行路径必须真的跑到 succeeded');
    assert.notEqual(settled.result, null, '对照组必须真的产出转写记录（证明计数口有效）');
    assert.equal(settled.result.kind, 'transcription');
    assert.equal(run.counter.insertJob, 1, '执行路径确实落了任务行（insertJob 计数口有效）');
    assert.equal(run.counter.updateJob, 1, '执行路径确实做了一次 queued→running CAS（updateJob 计数口有效）');
    assert.equal(run.counter.commitTerminal, 1, '执行路径确实走了一次 commitTerminal（该计数口有效）');
    assert.notEqual(
      await run.store.getTranscription(created.target_ref.id),
      null,
      '执行路径确实把转写记录落进了 store（与读面裁定的 null 形成对照）',
    );
  }
});
