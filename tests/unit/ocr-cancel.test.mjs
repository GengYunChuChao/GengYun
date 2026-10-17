/**
 * GY-I10 取消片（#10 标签 OCR 域）：`POST /jobs/{id}/cancel` 的**域内**语义回归。
 *
 * 判据（派单 `.pg17/dispatch/impl-i10-ocr-cancel.md` §2）：
 *   ① queued / running 取消 ⇒ `state === 'cancelled'` 且 `revision` **恰好 +1**；
 *   ② 终态五态再取消 ⇒ `OBJECT_UNAVAILABLE`（不伪造第二次取消，state/revision 不变）；
 *   ③ 取消后迟到回调 / 迟到结果**不复活**（仍 cancelled、revision 不变、不产出可读 OCR 记录）；
 *   ④ 越权与不存在**同形** NOT_FOUND（不泄露存在性）；
 *   ⑤ 只走契约既有迁移边（`packages/contracts/states.json` 已含 queued→cancelled、running→cancelled），
 *      本实现**不新增**任何迁移边。
 *
 * 分工：本文件直接调域内 `service.cancelJob`，钉住状态机、幂等与 CAS；HTTP 头解析
 * （If-Match / Idempotency-Key 透传）与 200/503 分支由
 * `tests/unit/jobs-registry.test.mjs` 的注册表 + 适配层用例钉住，两者互补不重复。
 *
 * 断言一律先判 `typeof` / 具体键，再判值；不使用「只要不抛错就算通过」的写法。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { STUB_IDEMPOTENCY_HMAC_KEY } from '../../services/api/src/auth/service.ts';
import { createOcrService } from '../../services/api/src/ocr/service.ts';
import { createMemoryOcrStore } from '../../services/api/src/ocr/store.ts';
import { createSubstituteMediaPort } from '../../services/api/src/ocr/media.ts';
import {
  createOcrDosePort,
  createOcrReferencePort,
  createSubstituteDosePort,
  createSubstituteReferencePort,
} from '../../services/api/src/ocr/reference.ts';
import {
  JOB_STATES,
  TERMINAL_JOB_STATES,
  canTransitionJob,
  isTerminalJobState,
} from '../../services/api/src/ocr/state.ts';

// ---------------------------------------------------------------- 辅助

const HMAC_KEY = STUB_IDEMPOTENCY_HMAC_KEY ?? 'gengyun-stub-idempotency-hmac-key';
const USER = 'user-owner-0001';
const OTHER_USER = 'user-intruder-0002';

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
  return `ocr-cancel-key-${String(keyCounter).padStart(6, '0')}`;
}

/** 断言抛出指定契约错误码的 ApiError。 */
async function assertApiError(operation, code, label) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.name, 'ApiError', `${label} 应抛 ApiError，实际 ${error.name}: ${error.message}`);
    assert.equal(error.code, code, `${label} 错误码应为 ${code}，实际 ${error.code}`);
    return true;
  });
}

/** 组装一个按执行模式接线的服务（可覆盖端口）。 */
function boot(overrides = {}) {
  const store = createMemoryOcrStore();
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
    idempotencyHmacKey: HMAC_KEY,
  });
  return { store, service };
}

let rowCounter = 0;
/** 直接向内存 store 落一条作业行（用于精确构造 queued / running / 终态现场）。 */
async function seedJob(store, overrides = {}) {
  rowCounter += 1;
  const at = new Date('2026-10-17T08:00:00.000Z');
  const row = {
    id: randomUUID(),
    revision: 1,
    kind: 'ocr',
    ownerUserId: USER,
    ocrId: randomUUID(),
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

/** 等到作业进入指定状态（自定义提供者被闸门挡住时用于观察 running）。 */
async function waitForState(service, jobId, state) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const job = await service.getJob({ userId: USER, jobId });
    if (job.state === state) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等待作业进入 ${state} 超时`);
}

// ------------------------------------------- ① 能力接线

test('取消能力已接线：OcrService 暴露 cancelJob（不是「没有这个能力」的 503 形态）', () => {
  const { service } = boot();
  assert.equal(typeof service.cancelJob, 'function', 'service.cancelJob 必须是函数');
});

// ------------------------------------------- ② queued / running 取消

test('queued 作业取消 ⇒ cancelled，revision 恰好 +1，result 为 null', async () => {
  const { store, service } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1 });

  const cancelled = await service.cancelJob({
    userId: USER,
    jobId: job.id,
    ifMatch: '"1"',
    idempotencyKey: nextKey(),
  });

  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.revision, 2, 'revision 必须从 1 恰好递增到 2');
  assert.equal(cancelled.kind, 'ocr');
  assert.equal(cancelled.error_code, null, '取消不是错误，不带 error_code');
  assert.equal(cancelled.result, null, 'cancelled 不产出结果');

  const persisted = await store.getJob(job.id);
  assert.notEqual(persisted, null);
  assert.equal(persisted.state, 'cancelled');
  assert.equal(persisted.revision, 2);
});

test('running 作业取消后，迟到的提供者结果不复活作业、不写入 OCR 记录', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { store, service } = boot({
    provider: {
      executionMode: 'stub',
      modelVersion: 'stub-v1',
      available: true,
      unavailableReason: null,
      async extract() {
        await gate;
        return { kind: 'completed', fields: LABEL_FIELDS };
      },
    },
  });

  const { job } = await service.createOcr({
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
  assert.equal(cancelled.revision, 3, 'revision 必须从 2 恰好递增到 3');

  // 迟到结果放行：终态 CAS 用的是 running.revision(2)，此时库内已是 3 ⇒ 写不进去。
  release();
  await service.settle();

  const after = await service.getJob({ userId: USER, jobId: job.id });
  assert.equal(after.state, 'cancelled', '取消后不得被迟到结果改成 succeeded');
  assert.equal(after.revision, 3, '迟到结果不得再自增 revision');
  assert.equal(after.result, null, '取消后不得冒出可读结果');

  const ocr = await store.getOcr(job.ocrId);
  assert.equal(ocr, null, '取消后不得写入 OCR 记录');
});

// ------------------------------------------- ③ 终态再取消

test('五终态再取消 ⇒ OBJECT_UNAVAILABLE，且 state/revision 不变', async () => {
  assert.equal(TERMINAL_JOB_STATES.length, 5, '契约终态必须是五态');
  for (const terminal of TERMINAL_JOB_STATES) {
    const { store, service } = boot();
    const job = await seedJob(store, { state: terminal, revision: 5, errorCode: terminal === 'succeeded' ? null : 'PROVIDER_FAILED' });

    await assertApiError(
      service.cancelJob({ userId: USER, jobId: job.id, ifMatch: '"5"', idempotencyKey: nextKey() }),
      'OBJECT_UNAVAILABLE',
      `终态 ${terminal} 再取消`,
    );

    const persisted = await store.getJob(job.id);
    assert.equal(persisted.state, terminal, `终态 ${terminal} 的状态不得被改写`);
    assert.equal(persisted.revision, 5, `终态 ${terminal} 的 revision 不得自增`);
  }
});

// ------------------------------------------- ④ If-Match 与幂等

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

test('首次成功取消的原样重试回放首次结果（不会被已自增的 revision 判成 409）', async () => {
  const { store, service } = boot();
  const job = await seedJob(store, { state: 'queued', revision: 1 });
  const key = nextKey();
  const request = { userId: USER, jobId: job.id, ifMatch: '"1"', idempotencyKey: key };

  const first = await service.cancelJob(request);
  assert.equal(first.revision, 2);

  const replay = await service.cancelJob(request);
  assert.equal(replay.state, 'cancelled');
  assert.equal(replay.revision, 2, '回放不得再自增 revision（不得伪造第二次取消）');

  const persisted = await store.getJob(job.id);
  assert.equal(persisted.revision, 2);
});

// ------------------------------------------- ⑤ 入参 fail-closed

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

test('越权与不存在同形 NOT_FOUND（同码同文案，不泄露存在性）', async () => {
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
  assert.equal(persisted.state, 'queued', '越权尝试不得改状态');
  assert.equal(persisted.revision, 1);
});

// ------------------------------------------- ⑦ 迁移边口径

test('取消只走契约既有迁移边：queued/running → cancelled 合法，终态出发非法', () => {
  assert.ok(JOB_STATES.includes('cancelled'));
  assert.equal(canTransitionJob('queued', 'cancelled'), true);
  assert.equal(canTransitionJob('running', 'cancelled'), true);
  for (const terminal of TERMINAL_JOB_STATES) {
    assert.equal(isTerminalJobState(terminal), true, `${terminal} 必须是终态`);
    assert.equal(canTransitionJob(terminal, 'cancelled'), false, `终态 ${terminal} 不得再迁出`);
  }
  // 本实现不得借取消片新增任何「取消 → 运行」的回退边。
  assert.equal(canTransitionJob('cancelled', 'queued'), false);
  assert.equal(canTransitionJob('cancelled', 'running'), false);
  assert.equal(canTransitionJob('cancelled', 'succeeded'), false);
});

// 端口常量占位：防止有人把生产装配（未接线）误当测试夹具使用。
void createOcrReferencePort;
void createOcrDosePort;
