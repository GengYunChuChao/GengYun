/**
 * GY-R27 取消片（#11 语音转写域）：`POST /jobs/{id}/cancel` 的**域内**语义回归。
 *
 * 判据（派单 `.pg17/dispatch/r27-s7-speech-cancel.md` §4）：
 *   ① `queued` / `running` 取消 ⇒ `state === 'cancelled'` 且 `revision` **恰好 +1**（单次 CAS，不得 +2）；
 *   ② 终态五态再取消 ⇒ `OBJECT_UNAVAILABLE`（不伪造第二次取消，state/revision 不变）；
 *   ③ 重复取消（已 `cancelled`）⇒ 不 5xx、不再 +1 revision；
 *   ④ 取消**不产生**转写记录；取消后迟到回调/迟到结果**不复活**作业；
 *   ⑤ 越权与不存在**同形** NOT_FOUND（同码同文案，不泄露存在性）；
 *   ⑥ If-Match 不符 ⇒ `REVISION_CONFLICT`；缺 ⇒ `REVISION_REQUIRED`；非法 ⇒ `INVALID_REQUEST`；
 *   ⑦ 只走契约既有迁移边（`speech/state.ts` 的 `canTransitionJob`），本实现**不新增**任何迁移边；
 *   ⑧ 取消后读回的投影 `state==='cancelled'` 且 `error_code` 清空。
 *
 * 分工：本文件直接调域内 `service.cancelJob`，钉住状态机、CAS、幂等与「不产生记录」；
 * HTTP 头解析（If-Match / Idempotency-Key 透传）与 200/503 分支由
 * `tests/integration/speech-http.mjs`（真实装配 + 回环 HTTP）与
 * `tests/unit/jobs-registry.test.mjs`（注册表 + 适配层）钉住，互补不重复。
 *
 * 断言一律先判 `typeof` / 具体键，再判值；不使用「只要不抛错就算通过」的写法。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { STUB_IDEMPOTENCY_HMAC_KEY } from '../../services/api/src/auth/service.ts';
import { createSubstituteMediaPort } from '../../services/api/src/speech/media.ts';
import { createSpeechService } from '../../services/api/src/speech/service.ts';
import { createMemorySpeechStore } from '../../services/api/src/speech/store.ts';
import {
  JOB_STATES,
  TERMINAL_JOB_STATES,
  canTransitionJob,
  isTerminalJobState,
} from '../../services/api/src/speech/state.ts';

// ---------------------------------------------------------------- 辅助

const HMAC_KEY = STUB_IDEMPOTENCY_HMAC_KEY ?? 'gengyun-stub-idempotency-hmac-key';
const USER = 'user-owner-0001';
const OTHER_USER = 'user-intruder-0002';

/** 替身转写载荷（**非真实录音**，逐字标注，避免被误当真实准确率证据）。 */
const STUB_TRANSCRIPT = Object.freeze({
  text: '替身示例·服务层用例文本（非真实录音）',
  uncertain_spans: Object.freeze([{ start: 0, end: 4, reason: 'stub' }]),
});

let keyCounter = 0;
function nextKey() {
  keyCounter += 1;
  return `speech-cancel-key-${String(keyCounter).padStart(6, '0')}`;
}

/** 断言抛出指定契约错误码的 ApiError。 */
async function assertApiError(operation, code, label) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.name, 'ApiError', `${label} 应抛 ApiError，实际 ${error.name}: ${error.message}`);
    assert.equal(error.code, code, `${label} 错误码应为 ${code}，实际 ${error.code}`);
    return true;
  });
}

/** 组装一个域内服务（默认替身提供者；可覆盖 provider 以造 running 现场）。 */
function boot(overrides = {}) {
  const store = overrides.store ?? createMemorySpeechStore();
  const service = createSpeechService({
    store,
    provider: overrides.provider ?? {
      executionMode: 'stub',
      modelVersion: 'stub-v1',
      note: '替身示例·服务层用例用（非真实 ASR）',
      available: true,
      unavailableReason: null,
      async transcribe() {
        return { kind: 'completed', transcript: STUB_TRANSCRIPT };
      },
    },
    media: overrides.media ?? createSubstituteMediaPort(),
    idempotencyHmacKey: HMAC_KEY,
    idempotencyWaitMs: overrides.idempotencyWaitMs ?? 200,
  });
  return { store, service };
}

let rowCounter = 0;
/** 直接向内存 store 落一条作业行（用于精确构造 queued / running / 终态现场）。 */
async function seedJob(store, overrides = {}) {
  rowCounter += 1;
  const at = new Date('2026-10-20T08:00:00.000Z');
  const row = {
    id: randomUUID(),
    revision: 1,
    kind: 'transcription',
    ownerUserId: USER,
    transcriptionId: randomUUID(),
    mediaId: randomUUID(),
    mediaRevision: 1,
    state: 'queued',
    deadlineAt: new Date(at.getTime() + 10 * 60 * 1000),
    createdAt: at,
    updatedAt: at,
    errorCode: null,
    ...overrides,
  };
  await store.insertJob(row);
  return row;
}

/** 等到作业进入指定状态（提供者被闸门挡住时用于观察 running）。 */
async function waitForState(service, jobId, state) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const job = await service.getJob({ userId: USER, jobId });
    if (job.state === state) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等待作业进入 ${state} 超时`);
}

// ------------------------------------------- ① 能力接线

test('取消能力已接线：SpeechService 暴露 cancelJob（不再是「没有这个能力」的 503 形态）', () => {
  const { service } = boot();
  assert.equal(typeof service.cancelJob, 'function', 'service.cancelJob 必须是函数');
});

// ------------------------------------------- ② queued / running 取消

test('queued 作业取消 ⇒ cancelled，revision 恰好 +1，error_code 清空，result 为 null', async () => {
  const { store, service } = boot();
  // 刻意带上残余错误码：取消不是失败，必须清空（GET 读回 error_code=null）。
  const job = await seedJob(store, { state: 'queued', revision: 1, errorCode: 'PROVIDER_QUOTA_EXCEEDED' });

  const cancelled = await service.cancelJob({
    userId: USER,
    jobId: job.id,
    ifMatch: '"1"',
    idempotencyKey: nextKey(),
  });

  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.revision, 2, 'revision 必须从 1 恰好递增到 2');
  assert.equal(cancelled.kind, 'transcription');
  assert.equal(cancelled.error_code, null, '取消不是错误，必须清空 error_code');
  assert.equal(cancelled.result, null, 'cancelled 不产出结果');

  const persisted = await store.getJob(job.id);
  assert.notEqual(persisted, null);
  assert.equal(persisted.state, 'cancelled');
  assert.equal(persisted.revision, 2);
  assert.equal(persisted.errorCode, null);

  // 取消后 GET /jobs/{id} 的语义（服务层等价物）：cancelled + error_code 清空。
  const readBack = await service.getJob({ userId: USER, jobId: job.id });
  assert.equal(readBack.state, 'cancelled');
  assert.equal(readBack.error_code, null);
  assert.equal(readBack.result, null);
});

test('running 作业取消后，迟到的提供者结果不复活作业、不写入转写记录', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { store, service } = boot({
    provider: {
      executionMode: 'stub',
      modelVersion: 'stub-v1',
      note: '替身示例·闸门用例（非真实 ASR）',
      available: true,
      unavailableReason: null,
      async transcribe() {
        await gate;
        return { kind: 'completed', transcript: STUB_TRANSCRIPT };
      },
    },
  });

  const { job } = await service.createTranscription({
    userId: USER,
    body: { media_id: randomUUID(), media_revision: 1 },
    idempotencyKey: nextKey(),
  });
  const running = await waitForState(service, job.id, 'running');
  assert.equal(running.revision, 2, 'queued→running 已占掉一次 revision 递增');

  const cancelled = await service.cancelJob({
    userId: USER,
    jobId: job.id,
    ifMatch: '"2"',
    idempotencyKey: nextKey(),
  });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.revision, 3, 'revision 必须从 2 恰好递增到 3（单次 CAS，不得 +2）');

  // 迟到结果放行：终态 CAS 用的是 running.revision(2)，此时库内已是 3 ⇒ 写不进去。
  release();
  await service.settle();

  const after = await service.getJob({ userId: USER, jobId: job.id });
  assert.equal(after.state, 'cancelled', '取消后不得被迟到结果改成 succeeded');
  assert.equal(after.revision, 3, '迟到结果不得再自增 revision');
  assert.equal(after.result, null, '取消后不得冒出可读结果');

  const transcription = await store.getTranscription(job.target_ref.id);
  assert.equal(transcription, null, '取消后不得写入转写记录（cancelled 不产生记录）');
});

// ------------------------------------------- ③ 终态再取消

test('五终态再取消 ⇒ OBJECT_UNAVAILABLE（不是 503 未接线），且 state/revision/error_code 不变', async () => {
  assert.equal(TERMINAL_JOB_STATES.length, 5, '契约终态必须是五态');
  for (const terminal of TERMINAL_JOB_STATES) {
    const { store, service } = boot();
    const job = await seedJob(store, {
      state: terminal,
      revision: 5,
      errorCode: terminal === 'succeeded' ? null : 'PROVIDER_QUOTA_EXCEEDED',
    });

    await assertApiError(
      service.cancelJob({ userId: USER, jobId: job.id, ifMatch: '"5"', idempotencyKey: nextKey() }),
      'OBJECT_UNAVAILABLE',
      `终态 ${terminal} 再取消`,
    );

    const persisted = await store.getJob(job.id);
    assert.equal(persisted.state, terminal, `终态 ${terminal} 的状态不得被改写`);
    assert.equal(persisted.revision, 5, `终态 ${terminal} 的 revision 不得自增`);
    assert.equal(
      persisted.errorCode,
      terminal === 'succeeded' ? null : 'PROVIDER_QUOTA_EXCEEDED',
      `终态 ${terminal} 的 error_code 不得被取消逻辑改写`,
    );
  }
});

// ------------------------------------------- ④ 重复取消 / 幂等

test('已 cancelled 再取消（换新键）⇒ OBJECT_UNAVAILABLE，不 5xx、不再 +1 revision', async () => {
  const { store, service } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1 });

  const first = await service.cancelJob({
    userId: USER,
    jobId: job.id,
    ifMatch: '"1"',
    idempotencyKey: nextKey(),
  });
  assert.equal(first.state, 'cancelled');
  assert.equal(first.revision, 2);

  // 客户端拿旧 revision 再取消：先撞版本冲突，不是 5xx。
  await assertApiError(
    service.cancelJob({ userId: USER, jobId: job.id, ifMatch: '"1"', idempotencyKey: nextKey() }),
    'REVISION_CONFLICT',
    '拿旧 revision 重复取消',
  );
  // 客户端拿新 revision 再取消：终态不可取消 ⇒ OBJECT_UNAVAILABLE（409，不是 5xx）。
  await assertApiError(
    service.cancelJob({ userId: USER, jobId: job.id, ifMatch: '"2"', idempotencyKey: nextKey() }),
    'OBJECT_UNAVAILABLE',
    '拿新 revision 重复取消',
  );

  const persisted = await store.getJob(job.id);
  assert.equal(persisted.state, 'cancelled');
  assert.equal(persisted.revision, 2, '重复取消不得再自增 revision');
});

test('首次成功取消的原样重试回放首次结果（不会被已自增的 revision 判成 409）', async () => {
  const { store, service } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1 });
  const request = { userId: USER, jobId: job.id, ifMatch: '"1"', idempotencyKey: nextKey() };

  const first = await service.cancelJob(request);
  assert.equal(first.revision, 2);

  const replay = await service.cancelJob(request);
  assert.equal(replay.state, 'cancelled');
  assert.equal(replay.revision, 2, '回放不得再自增 revision（不得伪造第二次取消）');

  const persisted = await store.getJob(job.id);
  assert.equal(persisted.revision, 2);
});

test('同键并发取消 ⇒ 恰好一次 revision 递增（两个调用方都收敛到同一 cancelled 投影）', async () => {
  const { store, service } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1 });
  const request = { userId: USER, jobId: job.id, ifMatch: '"1"', idempotencyKey: nextKey() };

  const [left, right] = await Promise.all([service.cancelJob(request), service.cancelJob(request)]);

  assert.equal(left.state, 'cancelled');
  assert.equal(right.state, 'cancelled');
  assert.equal(left.revision, 2, '左并发方 revision 应为 2');
  assert.equal(right.revision, 2, '右并发方必须收敛到同一 revision（不得 +2）');

  const persisted = await store.getJob(job.id);
  assert.equal(persisted.revision, 2, '并发取消不得让 revision 变成 3');
});

// ------------------------------------------- ⑤ If-Match 与入参

test('If-Match 不符 ⇒ REVISION_CONFLICT 且状态不变；释放占位后同键可重试成功', async () => {
  const { store, service } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1 });
  const key = nextKey();

  await assertApiError(
    service.cancelJob({ userId: USER, jobId: job.id, ifMatch: '"9"', idempotencyKey: key }),
    'REVISION_CONFLICT',
    '版本不符的取消',
  );

  const untouched = await store.getJob(job.id);
  assert.equal(untouched.state, 'queued', '版本冲突不得改状态');
  assert.equal(untouched.revision, 1, '版本冲突不得自增 revision');

  const retried = await service.cancelJob({ userId: USER, jobId: job.id, ifMatch: '"1"', idempotencyKey: key });
  assert.equal(retried.state, 'cancelled', '同一键在失败后必须可以重试（占位已释放）');
  assert.equal(retried.revision, 2);
});

test('缺 / 非法 Idempotency-Key 与 If-Match ⇒ 契约错误码，且不改状态', async () => {
  const { store, service } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1 });

  await assertApiError(
    service.cancelJob({ userId: USER, jobId: job.id, ifMatch: '"1"', idempotencyKey: undefined }),
    'IDEMPOTENCY_KEY_REQUIRED',
    '缺幂等键',
  );
  await assertApiError(
    service.cancelJob({ userId: USER, jobId: job.id, ifMatch: '"1"', idempotencyKey: 'short' }),
    'IDEMPOTENCY_KEY_REQUIRED',
    '过短的幂等键',
  );
  await assertApiError(
    service.cancelJob({ userId: USER, jobId: job.id, ifMatch: undefined, idempotencyKey: nextKey() }),
    'REVISION_REQUIRED',
    '缺版本头',
  );
  await assertApiError(
    service.cancelJob({ userId: USER, jobId: job.id, ifMatch: 'abc', idempotencyKey: nextKey() }),
    'INVALID_REQUEST',
    '非法版本头',
  );

  const persisted = await store.getJob(job.id);
  assert.equal(persisted.state, 'queued', '入参非法不得改状态');
  assert.equal(persisted.revision, 1, '入参非法不得自增 revision');
});

// ------------------------------------------- ⑥ 越权 / 不存在

test('越权与不存在同形 NOT_FOUND（同码同文案，不泄露存在性，且不改状态）', async () => {
  const { store, service } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1 });

  const messages = [];
  const record = (error, label) => {
    assert.equal(error.name, 'ApiError', `${label} 应抛 ApiError，实际 ${error.name}`);
    assert.equal(error.code, 'NOT_FOUND', `${label} 错误码应为 NOT_FOUND，实际 ${error.code}`);
    messages.push(error.message);
  };

  await assert.rejects(
    service.cancelJob({ userId: OTHER_USER, jobId: job.id, ifMatch: '"1"', idempotencyKey: nextKey() }),
    (error) => {
      record(error, '他人作业');
      return true;
    },
  );
  await assert.rejects(
    service.cancelJob({ userId: USER, jobId: randomUUID(), ifMatch: '"1"', idempotencyKey: nextKey() }),
    (error) => {
      record(error, '不存在的作业');
      return true;
    },
  );
  await assert.rejects(
    service.cancelJob({ userId: USER, jobId: 'not-a-uuid', ifMatch: '"1"', idempotencyKey: nextKey() }),
    (error) => {
      record(error, '非法 id');
      return true;
    },
  );

  assert.equal(messages.length, 3);
  assert.equal(new Set(messages).size, 1, `三种情形必须同文案，实际 ${JSON.stringify(messages)}`);

  const persisted = await store.getJob(job.id);
  assert.equal(persisted.state, 'queued', '越权尝试不得改状态（他人作业仍归原主）');
  assert.equal(persisted.revision, 1);
});

// ------------------------------------------- ⑦ 迁移边口径

test('取消只走契约既有迁移边：queued/running → cancelled 合法，终态出发非法，无回退边', () => {
  assert.ok(JOB_STATES.includes('cancelled'));
  assert.equal(canTransitionJob('queued', 'cancelled'), true);
  assert.equal(canTransitionJob('running', 'cancelled'), true);
  for (const terminal of TERMINAL_JOB_STATES) {
    assert.equal(isTerminalJobState(terminal), true, `${terminal} 必须是终态`);
    assert.equal(canTransitionJob(terminal, 'cancelled'), false, `终态 ${terminal} 不得再迁出`);
  }
  // 本实现不得借取消片新增任何「取消 → 运行/成功」的回退边。
  assert.equal(canTransitionJob('cancelled', 'queued'), false);
  assert.equal(canTransitionJob('cancelled', 'running'), false);
  assert.equal(canTransitionJob('cancelled', 'succeeded'), false);
});
