/**
 * GY-R94 · 识别作业的**一次**自动重发（#1181 后残余失败率约 3% 的兜底）。
 *
 * ## 要钉住的四件事（与任务书一一对应）
 * 1. 第一次「200 但内容解析不出 JSON」、第二次成功 ⇒ 作业 `succeeded`、记账**两行**（`attempt` 1、2）、
 *    观测 `sendAttempts` 依次为 1、2；
 * 2. 两次都失败 ⇒ 作业 `failed` + `PROVIDER_OUTCOME_UNKNOWN`、记账**两行**（不合并）；
 * 3. 4xx（`422`）/ 媒体域 5xx（`503`）/ 撤回同意（`CONSENT_REQUIRED`）⇒ **不重发**，只一行；
 * 4. 第一次就成功 ⇒ 只一行、`sendAttempts=1`。
 * 外加两条守卫：作业截止点太近 ⇒ 不重发；两次派发的闸门 `attemptKey` 必须不同（否则第二发被「绝不重发」挡住）。
 *
 * ## 为什么用真三件套
 * `createMediaJobEgress`（真）× `withProviderCallAccounting`（真）× `createOpenAiVisionRecognitionProvider`
 * （真，`fetch` 是假的）× `createRecognitionService`（真，内存账本）——重发的**判据**散在这三层里：
 * 适配器决定「这次算不算可重发」，egress 决定「还发不发第二包」，记账层决定「两包各记一行」。
 * 任何一层换成替身，剩下的断言都证明不了生产装配下的行为。
 *
 * 零网络、零 IO：`fetch` 全部是脚本化假响应，账本是本文件内的假实现（谓词逐字照抄
 * `ledger-pg.ts` 的 `state='reserved' AND cancelled_at IS NULL`）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createMediaJobEgress, REDISPATCH_TOTAL_BUDGET_MS } from '../../services/api/src/privacy/task-egress.ts';
import { withProviderCallAccounting } from '../../services/api/src/privacy/media-call-accounting.ts';
import { createOpenAiVisionRecognitionProvider } from '../../services/api/src/recognitions/openai-vision-adapter.ts';
import { createRecognitionService } from '../../services/api/src/recognitions/service.ts';
import { createMemoryRecognitionStore } from '../../services/api/src/recognitions/store.ts';
import { createSubstituteMediaPort } from '../../services/api/src/recognitions/media.ts';
import { PrivacyError } from '../../packages/privacy/errors.mjs';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEDIA_ID = '33333333-3333-4333-8333-333333333333';
const EXPORT_ID = '00000000-0000-4000-8f00-0000000000d4';
const RECIPIENT_ID = '00000000-0000-4000-8f00-0000000000e5';
const REVISION = 7;
const HMAC = 'synthetic-idempotency-hmac-key-0001';
const ALLOWED = ['species_barnyardgrass', 'species_lambsquarters', 'species_goosegrass'];
const ENDPOINT = 'https://vision.example.invalid/v1/chat/completions';

const DISPATCH = { jobId: 'job-gy-r94', mediaId: MEDIA_ID, mediaRevision: REVISION };

/** 最小合法 PNG 头（IHDR + 非零宽高），与 `requireLiveRecognitionImage` 的判据一致。 */
function pngBytes() {
  const header = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
  return new Uint8Array(header);
}

// ---------------------------------------------------------------------------
// 假的外部世界：脚本化 fetch / 闸门 / 外发账本 / 记账台账
// ---------------------------------------------------------------------------

/** 200 但正文解析不出 JSON —— 就是 #1181 之后仍会撞的那一支（finishReason=stop 照抄实测读数）。 */
function unparseableReply() {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: '这片叶子看着像稗草，但我给不出结构化结果。' } }],
    usage: { completion_tokens: 176 },
  }), { status: 200 });
}

/** 200 且能解析：单候选、闭集内。 */
function goodReply() {
  const content = JSON.stringify({ candidates: [{ species_id: 'species_barnyardgrass', confidence: 0.9 }] });
  return new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content } }],
    usage: { completion_tokens: 40 },
  }), { status: 200 });
}

/** 按调用次序吐脚本项（用尽后一直重复最后一项，便于断言「只打了一次」）。 */
function scriptedFetch(script) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async fetch(_url, init) {
      const entry = script[Math.min(index, script.length - 1)];
      index += 1;
      calls.push(JSON.parse(init.body));
      return typeof entry === 'function' ? entry() : entry;
    },
  };
}

function gateStub() {
  const keys = [];
  return {
    keys,
    async reserve({ attemptKey }) {
      keys.push(attemptKey);
      return { id: `ticket-${keys.length}` };
    },
    async settle() {},
  };
}

/**
 * 假 exports 账本（`public.exports` 的最小可判形态）：`reserved → sent → failed`，
 * 筛选谓词与 `ledger-pg.ts` 逐字一致 —— 于是「第二发不可能再命中回查」这件事由夹具本身保证。
 */
function exportsLedgerOf() {
  const trace = [];
  const reads = [];
  const row = {
    id: EXPORT_ID,
    userId: USER_ID,
    objectType: 'media',
    objectId: MEDIA_ID,
    objectRevision: REVISION,
    state: 'reserved',
    cancelledAt: null,
    errorCode: null,
    revision: 1,
  };
  return {
    row,
    trace,
    reads,
    async findReservedByObject(input) {
      trace.push('findReservedByObject');
      reads.push({ ...input, state: row.state });
      const matches =
        row.objectType === input.objectType &&
        row.objectId === input.objectId &&
        row.objectRevision === input.objectRevision &&
        row.state === 'reserved' &&
        row.cancelledAt === null;
      return matches
        ? { id: row.id, userId: row.userId, objectType: row.objectType, objectId: row.objectId, objectRevision: row.objectRevision, state: row.state, revision: row.revision }
        : null;
    },
    async resolveRecipient() {
      return RECIPIENT_ID;
    },
    async reserve(input) {
      row.objectRevision = input.objectRevision;
      row.revision += 1;
      return { id: row.id };
    },
    async linkJob() {},
    async markSent(id) {
      trace.push('markSent');
      if (row.state !== 'reserved') {
        throw new PrivacyError('OBJECT_UNAVAILABLE', `外发记录非预留态（${row.state}），禁止派发`);
      }
      row.state = 'sent';
      row.revision += 1;
      return { id, userId: row.userId, objectRevision: row.objectRevision };
    },
    async markFailed(id, { errorCode }) {
      trace.push('markFailed');
      assert.equal(id, EXPORT_ID);
      row.state = 'send_failed';
      row.errorCode = errorCode;
      row.revision += 1;
      return { id };
    },
    async cancelForJob() {
      return { cancelled: 0 };
    },
    async cancelVersion() {
      return { cancelled: false, alreadyCancelled: false, cancelledCount: 0 };
    },
  };
}

function inFlightOf(trace) {
  return {
    async assertExecutable() {
      trace.push('assertExecutable');
    },
    async saveResult() {
      trace.push('saveResult');
    },
  };
}

/**
 * 假记账台账：收整行，并按 0055 的同一条算式自己派生 `attempt`
 * （`COALESCE(MAX(attempt),0)+1 WHERE export_id = $1`）。两行同 export_id ⇒ 1、2。
 */
function callLedgerOf() {
  const rows = [];
  const attempts = [];
  return {
    rows,
    attempts,
    async record(input) {
      rows.push(input);
      const attempt = rows.filter((row) => row.exportId === input.exportId).length;
      attempts.push(attempt);
      return { attempt };
    },
  };
}

/**
 * 生产同序装配（`app.ts` 的 `provider:` 那一行）：
 * `egress.provider(withProviderCallAccounting(inner, …), 'recognize')`。
 *
 * `inner` 默认是真适配器（假 fetch）；传 `recognize` 可换成脚本化内层（用于「内层抛错」的负例）。
 */
function compose({ fetchImpl, onObservation, recognize } = {}) {
  const exports = exportsLedgerOf();
  const egress = createMediaJobEgress({
    ledger: exports,
    inFlight: inFlightOf(exports.trace),
    executionMode: 'real',
    dataType: 'image',
    capability: 'weed',
  });
  const gate = gateStub();
  const inner = recognize === undefined
    ? createOpenAiVisionRecognitionProvider({
      endpoint: ENDPOINT,
      apiKey: 'k-test',
      model: 'vision-model-test',
      speciesIds: ALLOWED,
      imageSource: { async read() { return pngBytes(); } },
      liveGate: gate,
      now: () => 1_000,
      ...(onObservation === undefined ? {} : { onObservation }),
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    })
    : { executionMode: 'real', modelVersion: 'scripted-inner-v1', available: true, unavailableReason: null, recognize };
  const ledger = callLedgerOf();
  const readings = { written: 0, failed: 0, lastError: null };
  const provider = egress.provider(
    withProviderCallAccounting(inner, {
      ledger,
      exportLedger: exports,
      capability: 'weed',
      executionMode: 'real',
      readings,
    }),
    'recognize',
  );
  return { exports, egress, provider, ledger, readings, gate };
}

/** 受理一个识别任务并等到终态（与 `recognitions-candidates-selection.test.mjs` 的 `runJob` 同形）。 */
async function runJob(provider) {
  const service = createRecognitionService({
    store: createMemoryRecognitionStore(),
    provider,
    media: createSubstituteMediaPort(),
    idempotencyHmacKey: HMAC,
  });
  const created = await service.createRecognition({
    userId: USER_ID,
    body: { media_id: MEDIA_ID, media_revision: REVISION },
    idempotencyKey: 'idem-gy-r94-0000000000',
  });
  await service.settle();
  return service.getJob({ userId: USER_ID, jobId: created.job.id });
}

// ---------------------------------------------------------------------------
// ① 第一次解析失败、第二次成功
// ---------------------------------------------------------------------------

test('① 第一次「200 但解析不出」、第二次成功 ⇒ 作业 succeeded、账本两行 attempt 1/2、sendAttempts=1,2', async () => {
  const observations = [];
  const fetch = scriptedFetch([unparseableReply, goodReply]);
  const { provider, ledger, readings, exports } = compose({
    fetchImpl: fetch.fetch,
    onObservation: (observation) => observations.push(observation),
  });

  const job = await runJob(provider);

  // 作业面：公开契约没变，就是普通的 succeeded（不带任何「重试过」字段）。
  assert.equal(job.state, 'succeeded');
  assert.equal(job.error_code ?? null, null);

  // 真的打了两包，且同一张图没重传（两次请求体逐字节一致）。
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[0].max_tokens, 1024);
  assert.deepEqual(fetch.calls[0], fetch.calls[1]);

  // 观测：两次都留下了读数，第二次的 sendAttempts 必须是 2。
  assert.deepEqual(observations.map((observation) => observation.sendAttempts), [1, 2]);
  assert.deepEqual(observations.map((observation) => observation.state), ['RESPONSE_EVIDENCE_INCOMPLETE', 'BUSINESS_RESPONSE']);
  assert.equal(observations[0].finishReason, 'stop');
  assert.equal(observations[0].completionTokens, 176);

  // 记账：同一张预留上两行，state 分别是失败/成功；attempt 由账本按 export_id 派生 1、2。
  assert.equal(ledger.rows.length, 2);
  assert.deepEqual(ledger.rows.map((row) => row.exportId), [EXPORT_ID, EXPORT_ID]);
  assert.deepEqual(ledger.rows.map((row) => row.invocationState), ['send_failed', 'sent']);
  assert.deepEqual(ledger.attempts, [1, 2], '两行必须是 attempt 1、2（不合并、不重复 1）');

  // 归属靠下传的 exportId ⇒ 记账层一次账本都不用回查，零 unresolved。
  assert.equal(exports.reads.length, 1);
  assert.deepEqual(exports.reads.map((read) => read.state), ['reserved']);
  assert.equal(readings.failed, 0);
  assert.equal(readings.written, 2);

  // 成功路径不写终态失败：那一行仍是 sent（结果由 in-flight 守卫落库）。
  assert.equal(exports.row.state, 'sent');
  assert.equal(exports.row.errorCode, null);
});

// ---------------------------------------------------------------------------
// ② 两次都失败
// ---------------------------------------------------------------------------

test('② 两次都解析不出 ⇒ 作业 failed + PROVIDER_OUTCOME_UNKNOWN、账本两行（不合并）', async () => {
  const observations = [];
  const fetch = scriptedFetch([unparseableReply, unparseableReply]);
  const { provider, ledger, readings, exports } = compose({
    fetchImpl: fetch.fetch,
    onObservation: (observation) => observations.push(observation),
  });

  const job = await runJob(provider);

  assert.equal(job.state, 'failed');
  assert.equal(job.error_code, 'PROVIDER_OUTCOME_UNKNOWN');
  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(observations.map((observation) => observation.sendAttempts), [1, 2]);

  // 两行都是 send_failed，且都挂在同一张预留行上 —— ⛔ 不许折成一行。
  assert.equal(ledger.rows.length, 2);
  assert.deepEqual(ledger.rows.map((row) => row.invocationState), ['send_failed', 'send_failed']);
  assert.deepEqual(ledger.rows.map((row) => row.exportId), [EXPORT_ID, EXPORT_ID]);
  assert.deepEqual(ledger.attempts, [1, 2]);
  assert.equal(readings.written, 2);
  assert.equal(readings.failed, 0);

  // 终态只写一次，错误码是契约闭集里的那个。
  assert.equal(exports.row.state, 'send_failed');
  assert.equal(exports.row.errorCode, 'PROVIDER_OUTCOME_UNKNOWN');
});

// ---------------------------------------------------------------------------
// ③ 不重发的三支（4xx / 媒体域 503 / 撤回同意）
// ---------------------------------------------------------------------------

test('③ 不重发：422（4xx）⇒ 只打一包、只记一行', async () => {
  const fetch = scriptedFetch([() => new Response('{}', { status: 422 })]);
  const { provider, ledger, exports } = compose({ fetchImpl: fetch.fetch });

  const job = await runJob(provider);

  assert.equal(job.state, 'failed');
  assert.equal(job.error_code, 'PROVIDER_OUTCOME_UNKNOWN');
  assert.equal(fetch.calls.length, 1, '4xx 不得重发');
  assert.equal(ledger.rows.length, 1);
  assert.deepEqual(ledger.rows.map((row) => row.invocationState), ['send_failed']);
  assert.deepEqual(ledger.attempts, [1]);
  assert.equal(exports.row.errorCode, 'PROVIDER_OUTCOME_UNKNOWN');
});

test('③ 不重发：媒体域 503 ⇒ 只打一包、只记一行（PROVIDER_UNAVAILABLE）', async () => {
  const fetch = scriptedFetch([() => new Response('{}', { status: 503 })]);
  const { provider, ledger, exports } = compose({ fetchImpl: fetch.fetch });

  const job = await runJob(provider);

  assert.equal(job.state, 'failed');
  assert.equal(job.error_code, 'PROVIDER_UNAVAILABLE');
  assert.equal(fetch.calls.length, 1, '503 不得重发');
  assert.equal(ledger.rows.length, 1);
  assert.equal(exports.row.errorCode, 'PROVIDER_UNAVAILABLE');
});

test('③ 不重发：撤回同意（内层抛 CONSENT_REQUIRED）⇒ 只记一行、原样上抛', async () => {
  const { provider, ledger, exports } = compose({
    // 内层在触达前判定同意已撤回：抛 PrivacyError，而不是「已发出但没结果」的返回值。
    recognize: async () => {
      throw new PrivacyError('CONSENT_REQUIRED', '授权已撤回，放弃本次外发');
    },
  });

  const outcome = await provider.recognize(DISPATCH).catch((error) => error);

  assert.ok(outcome instanceof PrivacyError);
  assert.equal(outcome.code, 'CONSENT_REQUIRED');
  assert.equal(ledger.rows.length, 1, '撤回同意不得重发');
  assert.deepEqual(ledger.rows.map((row) => row.invocationState), ['send_failed']);
  // 账本终态仍是「已发但失败」；`error_code` 用的是抛错路径的既有兜底码
  // （`failureCodeOf` 只认**返回值**，抛错一律 `PROVIDER_UNAVAILABLE` —— 与本改动无关的既有口径，
  //  撤回的对外读数由 `withdrawalAwareFailure` 在域层翻成 `CONSENT_WITHDRAWN`）。
  assert.equal(exports.row.state, 'send_failed');
  assert.equal(exports.row.errorCode, 'PROVIDER_UNAVAILABLE');
});

// ---------------------------------------------------------------------------
// ④ 第一次就成功
// ---------------------------------------------------------------------------

test('④ 第一次就成功 ⇒ 只打一包、只记一行、sendAttempts=1', async () => {
  const observations = [];
  const fetch = scriptedFetch([goodReply]);
  const { provider, ledger, readings, exports } = compose({
    fetchImpl: fetch.fetch,
    onObservation: (observation) => observations.push(observation),
  });

  const job = await runJob(provider);

  assert.equal(job.state, 'succeeded');
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(observations.map((observation) => observation.sendAttempts), [1]);
  assert.equal(ledger.rows.length, 1);
  assert.deepEqual(ledger.rows.map((row) => row.invocationState), ['sent']);
  assert.deepEqual(ledger.attempts, [1]);
  assert.equal(readings.written, 1);
  assert.equal(exports.row.state, 'sent');
});

// ---------------------------------------------------------------------------
// 两条守卫：闸门 key 与作业截止点
// ---------------------------------------------------------------------------

test('重发不被「绝不重发」挡住：两次派发的 attemptKey 不同（第二包带 #2）', async () => {
  const fetch = scriptedFetch([unparseableReply, goodReply]);
  const { provider, gate } = compose({ fetchImpl: fetch.fetch });

  const outcome = await provider.recognize(DISPATCH);

  assert.equal(outcome.kind, 'completed');
  assert.deepEqual(gate.keys, [
    `${DISPATCH.jobId}:${MEDIA_ID}#${REVISION}`,
    `${DISPATCH.jobId}:${MEDIA_ID}#${REVISION}#2`,
  ]);
});

test('作业截止点太近 ⇒ 不再重发，直接落失败（只一行）', async () => {
  const fetch = scriptedFetch([unparseableReply, goodReply]);
  const { provider, ledger } = compose({ fetchImpl: fetch.fetch });

  // 距截止只剩 100ms < 500ms 余量 ⇒ 连一次新连接都不值得建。
  const outcome = await provider.recognize({ ...DISPATCH, deadlineAt: Date.now() + 100 });

  assert.equal(outcome.kind, 'failed');
  assert.equal(outcome.code, 'PROVIDER_OUTCOME_UNKNOWN');
  assert.equal(fetch.calls.length, 1, '预算不足不得重发');
  assert.equal(ledger.rows.length, 1);
  assert.ok(REDISPATCH_TOTAL_BUDGET_MS > 30_000 && REDISPATCH_TOTAL_BUDGET_MS <= 35_000);
});
