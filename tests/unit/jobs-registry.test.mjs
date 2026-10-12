/**
 * GY-I01 跨 kind 作业读面/取消面 · 注册表与契约形状守卫的单元回归（Refs #9 #10 #11 #13）。
 *
 * 覆盖（逐条可单独指出）：
 * - 契约一致性：本模块的 kind/state/target_ref.type/Job 键集合与 `packages/contracts/openapi.json` 逐项一致；
 * - `assertContractJob` 的 fail-closed 面：多余/缺失键、未知 kind/state、非法 uuid/revision/时间戳/error_code、
 *   `result` 判别子不一致、终态不得带 result、succeeded 不得带 error_code、failed/timed_out 必须带 error_code；
 * - 出口重建：返回的是**新对象**（不共享输入引用，`result.value` 亦为深拷贝）；
 * - 注册表分派：按 kind 命中；不存在/越权/未接线 kind 一律**同形** `NOT_FOUND`；kind 重复装配 ⇒ 装配期抛错；
 * - 取消：有能力的源被复用；**域内无取消能力但作业存在 ⇒ `OBJECT_UNAVAILABLE`**（不假装取消、不伪造状态）；
 *   域内的冲突码（如 `REVISION_CONFLICT`）**原样透出**，本层不重写状态机；
 * - 适配层：域内 `NOT_FOUND` ⇒ `null`（⇒ 同形）；其它错误原样抛。
 *
 * 断言一律先判 `typeof`/`Array.isArray` 再判值。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApiError } from '../../services/api/src/errors.ts';
import {
  JOB_KEYS,
  JOB_KINDS,
  JOB_RESULT_KEYS,
  JOB_STATES,
  TARGET_REF_TYPES,
  assertContractJob,
  createJobRegistry,
  isTerminalJobState,
} from '../../services/api/src/jobs/registry.ts';
import { createRecognitionJobSource, createTranscriptionJobSource } from '../../services/api/src/jobs/sources.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const openapi = JSON.parse(readFileSync(resolve(root, 'packages/contracts/openapi.json'), 'utf8'));

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';

/** 合法契约 Job（recognition，succeeded 带 result）。 */
function validJob(overrides = {}) {
  return {
    id: JOB_ID,
    revision: 3,
    kind: 'recognition',
    target_ref: { type: 'recognition', id: TARGET_ID, revision: 2 },
    state: 'succeeded',
    deadline_at: '2026-10-12T00:00:30.000Z',
    created_at: '2026-10-12T00:00:00.000Z',
    error_code: null,
    result: { kind: 'recognition', value: { candidates: [], uncertainty_reasons: [] } },
    ...overrides,
  };
}

/** 断言 `assertContractJob` 抛错（内部契约违规用普通 Error，不伪装成契约错误码）。 */
function assertViolation(job, label) {
  assert.throws(
    () => assertContractJob(job, 'unit'),
    (error) => {
      assert.equal(error instanceof Error, true, `${label} 应抛 Error`);
      assert.equal(error.name, 'Error', `${label} 不应伪装成 ApiError，实际 ${error.name}`);
      assert.equal(typeof error.message, 'string');
      assert.ok(error.message.includes('不合契约'), `${label} 的 message 应说明违规，实际：${error.message}`);
      return true;
    },
  );
}

// ---------------------------------------------------------------- 契约一致性

test('契约一致性·本模块闭集与 openapi 逐项一致（kind/state/target_ref.type/Job 键）', () => {
  const job = openapi.components.schemas.Job;
  assert.equal(job.additionalProperties, false);
  assert.deepEqual([...job.properties.kind.enum].sort(), [...JOB_KINDS].sort());
  assert.deepEqual([...openapi.components.schemas.JobState.enum].sort(), [...JOB_STATES].sort());
  assert.deepEqual([...openapi.components.schemas.TargetRef.properties.type.enum].sort(), [...TARGET_REF_TYPES].sort());
  assert.deepEqual([...job.required].sort(), [...JOB_KEYS].sort());
  assert.deepEqual([...openapi.components.schemas.TranscriptionResult.required].sort(), [...JOB_RESULT_KEYS].sort());
  assert.equal(JOB_KINDS.length, 6);
  assert.equal(JOB_STATES.length, 7);
  // JobResult 是 discriminator: kind 的 oneOf
  assert.equal(openapi.components.schemas.JobResult.discriminator.propertyName, 'kind');
  for (const state of ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled']) {
    assert.equal(isTerminalJobState(state), true, `${state} 应为终态`);
  }
  for (const state of ['queued', 'running']) {
    assert.equal(isTerminalJobState(state), false, `${state} 不应为终态`);
  }
});

// ---------------------------------------------------------------- 形状守卫

test('守卫·合法 Job 通过，且**出口为重建的新对象**（不共享输入引用，result.value 深拷贝）', () => {
  const input = validJob();
  const out = assertContractJob(input, 'unit');
  assert.notEqual(out, input, '必须返回新对象');
  assert.notEqual(out.target_ref, input.target_ref, 'target_ref 不得共享引用');
  assert.notEqual(out.result, input.result, 'result 不得共享引用');
  assert.notEqual(out.result.value, input.result.value, 'result.value 必须深拷贝');
  assert.deepEqual(out, input, '内容与输入一致');
  assert.deepEqual(Object.keys(out).sort(), [...JOB_KEYS].sort());
});

test('反例·Job 多余字段 / 缺字段一律被拒（additionalProperties:false + 九字段全必填）', () => {
  assertViolation(validJob({ extra: 1 }), '多余字段');
  const missing = validJob();
  delete missing.error_code;
  assertViolation(missing, '缺 error_code');
  const missingResult = validJob();
  delete missingResult.result;
  assertViolation(missingResult, '缺 result');
  assertViolation({ ...validJob(), target_ref: { type: 'recognition', id: TARGET_ID, revision: 2, extra: true } }, 'target_ref 多余字段');
  assertViolation({ ...validJob(), result: { kind: 'recognition', value: {}, extra: 1 } }, 'result 多余字段');
});

test('反例·未知 kind / 未知 state / 非法 id 与 revision 一律被拒（不放宽 schema）', () => {
  assertViolation(validJob({ kind: 'definitely_not_a_kind' }), '未知 kind');
  assertViolation(validJob({ kind: 'job' }), 'target_ref 的 type 不是 kind');
  assertViolation(validJob({ state: 'done' }), '未知 state');
  assertViolation(validJob({ id: 'not-a-uuid' }), '非法 uuid');
  assertViolation(validJob({ revision: 0 }), 'revision=0');
  assertViolation(validJob({ revision: 1.5 }), 'revision 非整数');
  assertViolation(validJob({ target_ref: { type: 'not_a_type', id: TARGET_ID, revision: 1 } }), '未知 target_ref.type');
  assertViolation(validJob({ target_ref: { type: 'recognition', id: '', revision: 1 } }), 'target_ref.id 空');
  assertViolation(validJob({ target_ref: { type: 'recognition', id: TARGET_ID, revision: 0 } }), 'target_ref.revision=0');
  assertViolation(validJob({ deadline_at: 'not-a-date' }), '非法 deadline_at');
  assertViolation(validJob({ created_at: 123 }), 'created_at 非字符串');
  assertViolation(validJob({ error_code: 'NOT_A_CONTRACT_CODE' }), '非契约 error_code');
});

test('反例·result 判别子必须与 kind 一致；终态不得带 result；succeeded/failed 的 error_code 必须配平', () => {
  assertViolation(validJob({ result: { kind: 'transcription', value: {} } }), 'result.kind 与 Job.kind 不一致');
  assertViolation(validJob({ state: 'queued', result: { kind: 'recognition', value: {} } }), 'queued 带 result');
  assertViolation(validJob({ state: 'running', result: { kind: 'recognition', value: {} } }), 'running 带 result');
  assertViolation(
    validJob({ state: 'failed', error_code: 'PROVIDER_TIMEOUT', result: { kind: 'recognition', value: {} } }),
    'failed 带 result',
  );
  assertViolation(validJob({ state: 'cancelled', error_code: null, result: { kind: 'recognition', value: {} } }), 'cancelled 带 result');
  assertViolation(validJob({ state: 'succeeded', error_code: 'PROVIDER_TIMEOUT' }), 'succeeded 带 error_code');
  assertViolation(validJob({ state: 'failed', error_code: null, result: null }), 'failed 无 error_code');
  assertViolation(validJob({ state: 'timed_out', error_code: null, result: null }), 'timed_out 无 error_code');
  // 允许面：uncertain 带 result（已合并识别域与 speech 域的既有口径）；succeeded/uncertain 也可不带 result。
  const uncertain = assertContractJob(
    validJob({ state: 'uncertain', error_code: 'INPUT_UNCERTAIN', result: { kind: 'recognition', value: { candidates: [] } } }),
    'unit',
  );
  assert.equal(uncertain.state, 'uncertain');
  assert.notEqual(uncertain.result, null);
  assert.equal(assertContractJob(validJob({ result: null }), 'unit').result, null);
});

// ---------------------------------------------------------------- 注册表分派

/** 合成作业源：只为验证分派规则，不引用任何真实域（也不引用未合并代码）。 */
function fakeSource(kind, jobs = new Map(), options = {}) {
  const calls = { get: 0, cancel: 0 };
  const source = {
    kind,
    async get({ jobId }) {
      calls.get += 1;
      return jobs.get(jobId) ?? null;
    },
    ...(options.withoutCancel === true
      ? {}
      : {
          async cancel({ jobId, ifMatch }) {
            calls.cancel += 1;
            const job = jobs.get(jobId);
            if (job === undefined) return null;
            if (options.rejectWith !== undefined) throw options.rejectWith;
            if (ifMatch !== '"' + job.revision + '"') throw new ApiError('REVISION_CONFLICT', '任务版本与 If-Match 不一致');
            const next = { ...job, revision: job.revision + 1, state: 'cancelled' };
            jobs.set(jobId, next);
            return next;
          },
        }),
  };
  return { source, calls, jobs };
}

test('注册表·按 kind 分派：各源自报家门，命中的源返回的 Job 原样（校验后）下发', async () => {
  const recog = fakeSource('recognition', new Map([[JOB_ID, validJob()]]));
  const trans = fakeSource('transcription', new Map([['33333333-3333-4333-8333-333333333333', validJob({ kind: 'transcription', target_ref: { type: 'transcription', id: TARGET_ID, revision: 1 }, result: { kind: 'transcription', value: { raw_text: 'x' } } })]]));
  const registry = createJobRegistry([recog.source, trans.source]);
  assert.deepEqual(registry.kinds, ['recognition', 'transcription']);
  assert.equal((await registry.get({ userId: 'u', jobId: JOB_ID })).kind, 'recognition');
  assert.equal((await registry.get({ userId: 'u', jobId: '33333333-3333-4333-8333-333333333333' })).kind, 'transcription');
});

test('反例·不存在 / 越权（源返回 null）/ **未接线 kind** 一律同形 NOT_FOUND（fail-closed，不伪造状态）', async () => {
  const recog = fakeSource('recognition', new Map([[JOB_ID, validJob()]]));
  const onlyRecognition = createJobRegistry([recog.source]);
  const bothKinds = createJobRegistry([recog.source, fakeSource('transcription').source]);
  const unknownId = '99999999-9999-4999-8999-999999999999';

  const shapes = [];
  for (const [label, registry, jobId] of [
    ['未知 id', bothKinds, unknownId],
    ['越权（仅识别域已接线时的转写 id）', onlyRecognition, '33333333-3333-4333-8333-333333333333'],
    ['未接线 kind（注册表里没有该 kind 的源）', onlyRecognition, unknownId],
  ]) {
    const error = await registry.get({ userId: 'u', jobId }).then(
      () => null,
      (e) => e,
    );
    assert.equal(error?.name, 'ApiError', `${label} 应抛 ApiError`);
    assert.equal(error?.code, 'NOT_FOUND', `${label} 应为 NOT_FOUND`);
    assert.equal(error?.status, 404);
    shapes.push({ code: error.code, status: error.status, message: error.message, details: JSON.stringify(error.details) });
  }
  for (const shape of shapes) assert.deepEqual(shape, shapes[0], '三类必须逐字段同形');
  // 未接线 kind 的记录：registry.kinds 明确不含它（不是"隐藏的 200"）
  assert.equal(onlyRecognition.kinds.includes('transcription'), false);
});

test('反例·同一 kind 重复装配 ⇒ 装配期立即抛错（不留两处同一作业源）', () => {
  assert.throws(
    () => createJobRegistry([fakeSource('recognition').source, fakeSource('recognition').source]),
    /kind 重复注册/,
  );
});

test('取消·有能力的源被复用；域内冲突码原样透出（本层不重写状态机）', async () => {
  const jobs = new Map([[JOB_ID, validJob({ state: 'running', result: null, error_code: null, revision: 4 })]]);
  const recog = fakeSource('recognition', jobs);
  const registry = createJobRegistry([recog.source]);
  const cancelled = await registry.cancel({ userId: 'u', jobId: JOB_ID, ifMatch: '"4"', idempotencyKey: 'k' });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.revision, 5);
  assert.equal(recog.calls.cancel, 1);
  // 已终态：域内抛 REVISION_CONFLICT ⇒ 本层原样透出（不改写成其它码）
  await assert.rejects(
    () => registry.cancel({ userId: 'u', jobId: JOB_ID, ifMatch: '"4"', idempotencyKey: 'k2' }),
    (error) => error instanceof ApiError && error.code === 'REVISION_CONFLICT',
  );
});

test('取消·**域内无取消能力但作业存在 ⇒ 503 PROVIDER_UNAVAILABLE**（能力未接线，不谎称对象状态、不伪造 cancelled）；未知 id 仍 404', async () => {
  const jobs = new Map([[JOB_ID, validJob({ kind: 'transcription', state: 'running', result: null, error_code: null, target_ref: { type: 'transcription', id: TARGET_ID, revision: 1 } })]]);
  const noCancel = fakeSource('transcription', jobs, { withoutCancel: true });
  const registry = createJobRegistry([noCancel.source]);
  assert.equal(registry.kinds.includes('transcription'), true);
  const error = await registry.cancel({ userId: 'u', jobId: JOB_ID, ifMatch: '"3"', idempotencyKey: 'k' }).then(
    () => null,
    (e) => e,
  );
  // 契约 `cancelJob` 的响应闭集含 503（`x-error-status-map["503"] = [PROVIDER_UNAVAILABLE, PROVIDER_OUTCOME_UNKNOWN]`）：
  // "该域根本没有取消能力"（能力未接线）不得用 409 OBJECT_UNAVAILABLE 冒充"对象当前不可用"。
  assert.equal(error?.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(error?.status, 503);
  assert.equal(error?.retryable, true, '未接线属可重试（接线后同一请求即可成功）');
  // 作业状态**未被改动**（没有伪造 cancelled），仅多了一次确认存在性的读取
  assert.equal(jobs.get(JOB_ID).state, 'running');
  assert.equal(jobs.get(JOB_ID).revision, 3);
  await assert.rejects(
    () => registry.cancel({ userId: 'u', jobId: '99999999-9999-4999-8999-999999999999', ifMatch: '"1"', idempotencyKey: 'k' }),
    (e) => e instanceof ApiError && e.code === 'NOT_FOUND',
  );
});

// ---------------------------------------------------------------- 适配层（只读复用各域服务）

test('适配层·域内 NOT_FOUND ⇒ null（同形）；域内其它错误原样抛；无取消能力的域不暴露 cancel', async () => {
  const job = validJob();
  const calls = { get: 0, cancel: 0 };
  const fakeSpeech = {
    async getJob({ jobId }) {
      calls.get += 1;
      if (jobId !== JOB_ID) throw new ApiError('NOT_FOUND', '任务不存在');
      return job;
    },
  };
  const transcription = createTranscriptionJobSource(fakeSpeech);
  assert.equal(transcription.kind, 'transcription');
  assert.equal(transcription.cancel, undefined, '转写域本基线无取消能力 ⇒ 不暴露 cancel');
  assert.equal(await transcription.get({ userId: 'u', jobId: 'missing' }), null);
  assert.equal((await transcription.get({ userId: 'u', jobId: JOB_ID })).id, JOB_ID);
  assert.equal(calls.get, 2);

  const recognitionService = {
    async getJob({ jobId }) {
      if (jobId !== JOB_ID) throw new ApiError('NOT_FOUND', '任务不存在');
      return job;
    },
    async cancelJob({ jobId, ifMatch }) {
      calls.cancel += 1;
      if (jobId !== JOB_ID) throw new ApiError('NOT_FOUND', '任务不存在');
      if (ifMatch === '"boom"') throw new ApiError('REQUEST_IN_PROGRESS', '同一 Idempotency-Key 的请求正在处理中');
      return { ...job, state: 'cancelled', revision: job.revision + 1, result: null };
    },
  };
  const recognition = createRecognitionJobSource(recognitionService);
  assert.equal(typeof recognition.cancel, 'function');
  assert.equal(await recognition.cancel({ userId: 'u', jobId: 'missing', ifMatch: '"1"', idempotencyKey: 'k' }), null);
  await assert.rejects(
    () => recognition.cancel({ userId: 'u', jobId: JOB_ID, ifMatch: '"boom"', idempotencyKey: 'k' }),
    (e) => e instanceof ApiError && e.code === 'REQUEST_IN_PROGRESS',
  );
  assert.equal((await recognition.cancel({ userId: 'u', jobId: JOB_ID, ifMatch: '"3"', idempotencyKey: 'k' })).state, 'cancelled');
});
