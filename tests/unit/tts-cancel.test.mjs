/**
 * GY-R27 取消片（#13 合成域）：`POST /jobs/{id}/cancel` 的**域内**语义回归。
 *
 * 判据（派单 `.pg17/dispatch/r27-s9-synthesis-cancel.md` §4）：
 *   ① `queued` / `running` 取消 ⇒ `state === 'cancelled'` 且 `revision` **恰好 +1**（单次 CAS，不得 +2）；
 *   ② 终态五态再取消 ⇒ `OBJECT_UNAVAILABLE`（**不是** `PROVIDER_UNAVAILABLE`），state/revision 不变；
 *   ③ 取消**不产生**合成记录；取消后迟到回调/迟到结果**不复活**作业；
 *   ④ 越权与不存在**同形** NOT_FOUND（同码同文案，不泄露存在性）；
 *   ⑤ If-Match 不符 ⇒ `REVISION_CONFLICT`；缺 ⇒ `REVISION_REQUIRED`；非法 ⇒ `INVALID_REQUEST`；
 *   ⑥ 重复取消不得 5xx、不得再 +1 次 revision；
 *   ⑦ 取消后读回的投影 `state==='cancelled'` 且 `error_code` 清空、`result===null`；
 *   ⑧ 只走契约既有迁移边（`tts/state.ts` 的 `canTransitionJob`），本实现**不新增**任何迁移边。
 *
 * 分工：本文件直接调域内 `service.cancelJob`，钉住状态机、CAS、幂等与「不产生记录」；
 * HTTP 头解析（If-Match / Idempotency-Key 透传）与 200/409/404 分支由
 * `tests/unit/tts-jobs-http.test.mjs`（真实装配 + 回环 HTTP）与
 * `tests/unit/jobs-registry.test.mjs`（注册表 + 适配层）钉住，互补不重复。
 *
 * 断言一律先判 `typeof` / 具体键，再判值；不使用「只要不抛错就算通过」的写法。
 * 声明：全部夹具为**合成替身**（替身 TTS + 替身核对源 + 内存 store），**不含**任何真实供应商调用、
 * 凭据，也**不产生任何真实音频**；本文件不构成任何合成质量/听感证据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { STUB_IDEMPOTENCY_HMAC_KEY } from '../../services/api/src/auth/service.ts';
import { ApiError } from '../../services/api/src/errors.ts';
import { createJobRegistry } from '../../services/api/src/jobs/registry.ts';
import { createSynthesisJobSource } from '../../services/api/src/jobs/sources.ts';
import { createCheckedContentPort } from '../../services/api/src/tts/content.ts';
import { createSynthesisMediaPort } from '../../services/api/src/tts/media.ts';
import { createStubTtsProvider } from '../../services/api/src/tts/provider.ts';
import { createSynthesisService } from '../../services/api/src/tts/service.ts';
import {
  JOB_STATES,
  TERMINAL_JOB_STATES,
  canTransitionJob,
  isTerminalJobState,
} from '../../services/api/src/tts/state.ts';
import { createMemorySynthesisStore } from '../../services/api/src/tts/store.ts';

// ---------------------------------------------------------------- 辅助

const HMAC_KEY = STUB_IDEMPOTENCY_HMAC_KEY ?? 'gengyun-stub-idempotency-hmac-key';
const USER = 'user-owner-0001';
const OTHER_USER = 'user-intruder-0002';
const REF = { type: 'answer', id: 'answer-approved', revision: 3 };
const TEXT = '合成取消用例文本：水稻二化螟卵孵盛期，每亩用登记制剂 50 毫升（合成夹具）。';

let keyCounter = 0;
function nextKey() {
  keyCounter += 1;
  return `tts-cancel-key-${String(keyCounter).padStart(6, '0')}`;
}

/** 断言抛出指定契约错误码的 ApiError。 */
async function assertApiError(operation, code, label) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.name, 'ApiError', `${label} 应抛 ApiError，实际 ${error.name}: ${error.message}`);
    assert.equal(error.code, code, `${label} 错误码应为 ${code}，实际 ${error.code}`);
    return true;
  });
}

/** 组装一个域内服务（默认替身提供者；可覆盖 provider 以造「卡在 running」的现场）。 */
function boot(overrides = {}) {
  const executionMode = overrides.executionMode ?? 'stub';
  const store = overrides.store ?? createMemorySynthesisStore();
  const service = createSynthesisService({
    store,
    provider: overrides.provider ?? createStubTtsProvider(),
    media: overrides.media ?? createSynthesisMediaPort(executionMode),
    content:
      overrides.content ??
      createCheckedContentPort(executionMode, [
        { type: REF.type, id: REF.id, revision: REF.revision, auditState: 'approved', text: TEXT, ownerUserId: null },
      ]),
    idempotencyHmacKey: HMAC_KEY,
    jobDeadlineMs: overrides.jobDeadlineMs ?? 10 * 60 * 1000,
    idempotencyWaitMs: overrides.idempotencyWaitMs ?? 200,
  });
  return { store, service };
}

/** 直接向内存 store 落一条作业行（用于精确构造 queued / running / 终态现场）。 */
async function seedJob(store, overrides = {}) {
  const at = new Date('2026-10-20T08:00:00.000Z');
  const row = {
    id: randomUUID(),
    revision: 1,
    kind: 'synthesis',
    ownerUserId: USER,
    executionMode: 'stub',
    synthesisId: randomUUID(),
    checkedContentRef: { ...REF },
    locale: 'zh-CN',
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
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const job = await service.inspectJob({ userId: USER, jobId });
    if (job.state === state) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等待作业进入 ${state} 超时`);
}

// ------------------------------------------- ① 能力接线

test('取消能力已接线：SynthesisService 暴露 cancelJob（不再是「没有这个能力」的 503 形态）', () => {
  const { service } = boot();
  assert.equal(typeof service.cancelJob, 'function', 'service.cancelJob 必须是函数');
  // 既有入口不得因本片消失或改名（纯追加）。
  for (const name of ['createSynthesis', 'inspectJob', 'verifyUsable', 'settle', 'describe']) {
    assert.equal(typeof service[name], 'function', `既有入口 ${name} 不得因取消片改变`);
  }
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
  assert.equal(cancelled.kind, 'synthesis');
  assert.equal(cancelled.error_code, null, '取消不是错误，必须清空 error_code');
  assert.equal(cancelled.result, null, 'cancelled 不产出合成记录 ⇒ result 恒为 null');
  assert.deepEqual(cancelled.target_ref, { ...REF }, 'target_ref 不得被取消改写');

  const persisted = await store.getJob(job.id);
  assert.notEqual(persisted, null);
  assert.equal(persisted.state, 'cancelled');
  assert.equal(persisted.revision, 2);
  assert.equal(persisted.errorCode, null);

  // 取消后 `GET /jobs/{id}` 的语义（服务层等价物）：cancelled + error_code 清空 + result null。
  const readBack = await service.inspectJob({ userId: USER, jobId: job.id });
  assert.equal(readBack.state, 'cancelled');
  assert.equal(readBack.error_code, null);
  assert.equal(readBack.result, null);
});

test('running 作业取消后，迟到的提供者结果不复活作业、不写入合成记录', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const stub = createStubTtsProvider();
  const { store, service } = boot({
    provider: {
      ...stub,
      async synthesize(input) {
        await gate;
        return stub.synthesize(input);
      },
    },
  });

  const accepted = await service.createSynthesis({
    userId: USER,
    body: { checked_content_ref: { ...REF }, locale: 'zh-CN' },
    idempotencyKey: nextKey(),
  });
  assert.equal(accepted.status, 202, '前置：受理应 202');
  const jobId = accepted.job.id;
  const running = await waitForState(service, jobId, 'running');
  assert.equal(running.revision, 2, 'queued→running 已占掉一次 revision 递增');

  // 闸门**必须**无条件放行（否则变异/断言失败会把在途执行永远挂在事件循环上，表现为挂死而非红）。
  let cancelled;
  try {
    cancelled = await service.cancelJob({
      userId: USER,
      jobId,
      ifMatch: '"2"',
      idempotencyKey: nextKey(),
    });
  } finally {
    // 迟到结果放行：终态 CAS 用的是 running.revision(2)，此时库内已是取消后的 revision ⇒ 写不进去。
    release();
  }
  await service.settle();

  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.revision, 3, 'revision 必须从 2 恰好递增到 3（单次 CAS，不得 +2）');

  const after = await service.inspectJob({ userId: USER, jobId });
  assert.equal(after.state, 'cancelled', '取消后不得被迟到结果改成 succeeded');
  assert.equal(after.revision, 3, '迟到结果不得再自增 revision');
  assert.equal(after.result, null, '取消后不得冒出可读结果');
  assert.equal(after.error_code, null, '取消不是失败，迟到结果也不得给它写错误码');

  // 取消不产出合成记录（合成记录 id 在受理时就已确定，必须仍然查不到）。
  const row = await store.getJob(jobId);
  const record = await store.getSynthesis(row.synthesisId);
  assert.equal(record, null, '取消后不得写入合成记录（cancelled 不产生产物）');
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

test('终态再取消**不是** 503 PROVIDER_UNAVAILABLE：错误码与 HTTP 状态码都不是「能力未接线」形态', async () => {
  const { store, service } = boot();
  const job = await seedJob(store, { state: 'succeeded', revision: 3, errorCode: null });
  const error = await service
    .cancelJob({ userId: USER, jobId: job.id, ifMatch: '"3"', idempotencyKey: nextKey() })
    .then(() => null, (thrown) => thrown);
  assert.notEqual(error, null, '终态取消必须抛错');
  assert.equal(error.code, 'OBJECT_UNAVAILABLE');
  assert.equal(error.status, 409, 'OBJECT_UNAVAILABLE 必须是 409（对象当前不支持），不是 503');
  assert.equal(error.retryable, false);
});

// ------------------------------------------- ④ 重复取消 / 幂等

test('已 cancelled 再取消（换新键）⇒ 不 5xx、不再 +1 revision', async () => {
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

  // 客户端拿旧 revision 再取消：先撞版本冲突（409），不是 5xx。
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
  assert.equal(replay.result, null);

  const persisted = await store.getJob(job.id);
  assert.equal(persisted.revision, 2);
});

test('同键异体（换 If-Match）⇒ IDEMPOTENCY_CONFLICT，且不改状态', async () => {
  const { store, service } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1 });
  const key = nextKey();

  const first = await service.cancelJob({ userId: USER, jobId: job.id, ifMatch: '"1"', idempotencyKey: key });
  assert.equal(first.state, 'cancelled');

  await assertApiError(
    service.cancelJob({ userId: USER, jobId: job.id, ifMatch: '"2"', idempotencyKey: key }),
    'IDEMPOTENCY_CONFLICT',
    '同键异体取消',
  );
  const persisted = await store.getJob(job.id);
  assert.equal(persisted.revision, 2, '同键异体不得再自增 revision');
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
  for (const illegal of ['abc', '2', '"0"', '"1"x', '*', '"01"']) {
    await assertApiError(
      service.cancelJob({ userId: USER, jobId: job.id, ifMatch: illegal, idempotencyKey: nextKey() }),
      'INVALID_REQUEST',
      `非法版本头 ${illegal}`,
    );
  }

  const persisted = await store.getJob(job.id);
  assert.equal(persisted.state, 'queued', '入参非法不得改状态');
  assert.equal(persisted.revision, 1, '入参非法不得自增 revision');
});

test('缺 If-Match 的 HTTP 状态是 428、非法是 400（与识别/OCR/转写域同一口径）', async () => {
  const { store, service } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1 });
  const missing = await service
    .cancelJob({ userId: USER, jobId: job.id, ifMatch: undefined, idempotencyKey: nextKey() })
    .then(() => null, (error) => error);
  assert.equal(missing.status, 428);
  assert.equal(missing.code, 'REVISION_REQUIRED');
  const illegal = await service
    .cancelJob({ userId: USER, jobId: job.id, ifMatch: 'abc', idempotencyKey: nextKey() })
    .then(() => null, (error) => error);
  assert.equal(illegal.status, 400);
  assert.equal(illegal.code, 'INVALID_REQUEST');
});

// ------------------------------------------- ⑥ 越权 / 不存在

test('越权与不存在同形 NOT_FOUND（同码同文案，不泄露存在性，且不改状态）', async () => {
  const { store, service } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1 });

  const messages = [];
  const record = (error, label) => {
    assert.equal(error.name, 'ApiError', `${label} 应抛 ApiError，实际 ${error.name}`);
    assert.equal(error.code, 'NOT_FOUND', `${label} 错误码应为 NOT_FOUND，实际 ${error.code}`);
    assert.equal(error.status, 404, `${label} 必须是 404`);
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

test('越权请求不消耗 Idempotency-Key：属主随后用同一键可以正常取消', async () => {
  const { store, service } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1 });
  const sharedKey = nextKey();

  await assertApiError(
    service.cancelJob({ userId: OTHER_USER, jobId: job.id, ifMatch: '"1"', idempotencyKey: sharedKey }),
    'NOT_FOUND',
    '越权取消',
  );
  const owner = await service.cancelJob({ userId: USER, jobId: job.id, ifMatch: '"1"', idempotencyKey: sharedKey });
  assert.equal(owner.state, 'cancelled', '越权请求不得占用属主的幂等键');
  assert.equal(owner.revision, 2);
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
  // 本片也不得放宽 queued → succeeded 这类跳步（读写面都不制造）。
  assert.equal(canTransitionJob('queued', 'succeeded'), false);
});

// ------------------------------------------- ⑧ 作业源适配层与注册表（jobs/sources.ts / jobs/registry.ts）

test('作业源适配层·合成源**提供 cancel**：NOT_FOUND（不存在/越权）⇒ null（同形 404），其余错误**原样透出**', async () => {
  const calls = [];
  const source = createSynthesisJobSource({
    async inspectJob() {
      throw new ApiError('NOT_FOUND', '任务不存在');
    },
    async cancelJob(input) {
      calls.push(input);
      // 域内口径：不存在/越权一律 NOT_FOUND；终态 ⇒ OBJECT_UNAVAILABLE。
      if (input.jobId === 'missing') throw new ApiError('NOT_FOUND', '任务不存在');
      throw new ApiError('OBJECT_UNAVAILABLE', '作业已处于终态 succeeded，不可取消');
    },
  });

  assert.equal(typeof source.cancel, 'function', '合成源必须暴露 cancel（本片接线的核心）');
  assert.equal(source.kind, 'synthesis');

  // 域内 NOT_FOUND ⇒ null（注册表据此回同形 404）
  assert.equal(await source.cancel({ userId: 'u', jobId: 'missing', ifMatch: '"1"', idempotencyKey: 'k' }), null);
  assert.equal(await source.get({ userId: 'u', jobId: 'missing' }), null);

  // 域内其它错误 ⇒ 原样透出（**不得**被改写成 503 PROVIDER_UNAVAILABLE）
  const error = await source
    .cancel({ userId: 'u', jobId: 'job-1', ifMatch: '"7"', idempotencyKey: 'k-2' })
    .then(() => null, (thrown) => thrown);
  assert.notEqual(error, null);
  assert.equal(error.code, 'OBJECT_UNAVAILABLE');
  assert.equal(error.status, 409);

  // 入参**原样下传**（适配层不解释版本、不重造 Key）
  assert.equal(calls.length, 2);
  assert.equal(calls[1].ifMatch, '"7"');
  assert.equal(calls[1].idempotencyKey, 'k-2');
  assert.equal(calls[1].userId, 'u');
  assert.equal(calls[1].jobId, 'job-1');
});

test('注册表级·合成作业取消经 createJobRegistry ⇒ 200 形契约 Job（cancelled/恰好 +1）；终态 ⇒ 409 透出；不存在 ⇒ 同形 404', async () => {
  const { store, service } = boot();
  const registry = createJobRegistry([createSynthesisJobSource(service)]);
  assert.deepEqual(registry.kinds, ['synthesis']);

  const job = await seedJob(store, { state: 'running', revision: 2 });
  const cancelled = await registry.cancel({ userId: USER, jobId: job.id, ifMatch: '"2"', idempotencyKey: nextKey() });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.revision, 3, 'revision 必须恰好 +1');
  assert.equal(cancelled.kind, 'synthesis');
  assert.equal(cancelled.error_code, null);
  assert.equal(cancelled.result, null, '取消不产出合成记录 ⇒ result 恒为 null');
  assert.deepEqual(
    Object.keys(cancelled).sort(),
    ['id', 'revision', 'kind', 'target_ref', 'state', 'deadline_at', 'created_at', 'error_code', 'result'].sort(),
    '出口必须仍是九键契约 Job（注册表 assertContractJob 重建）',
  );

  // 终态再取消：域内 OBJECT_UNAVAILABLE 经适配层**原样透出**（不是 503 未接线）
  await assertApiError(
    registry.cancel({ userId: USER, jobId: job.id, ifMatch: '"3"', idempotencyKey: nextKey() }),
    'OBJECT_UNAVAILABLE',
    '注册表级终态再取消',
  );

  // 不存在 / 越权：同形 404
  await assertApiError(
    registry.cancel({ userId: USER, jobId: randomUUID(), ifMatch: '"1"', idempotencyKey: nextKey() }),
    'NOT_FOUND',
    '注册表级不存在取消',
  );
  await assertApiError(
    registry.cancel({ userId: OTHER_USER, jobId: job.id, ifMatch: '"1"', idempotencyKey: nextKey() }),
    'NOT_FOUND',
    '注册表级越权取消',
  );
});
