/**
 * GY-R83 · `#1003` 的**组合臂**：真 `createMediaJobEgress`（`privacy/task-egress.ts`）
 * × 真 `withProviderCallAccounting`（`privacy/media-call-accounting.ts`）× 假 exports 账本。
 *
 * ## 为什么非要有这一支（审查 P1-1）
 * `recognitions-usage-accounting.test.mjs` 的假账本恒回 `{ id, state:'reserved' }` —— 它**不模拟
 * `markSent`**，所以对「记账层从哪儿拿到 `export_id`」完全没有牙：把归属改坏，那一支仍然全绿，
 * 而生产装配下会一行都写不进去。这一支把两层**真装在一起**（GY-R94 起与生产同序：
 * `egress.provider(withProviderCallAccounting(inner, …), 'recognize')` —— 记账在 egress **内层**，
 * 每次派发各一行），假账本的筛选逐字照抄 `ledger-pg.ts:690` 的谓词，并用一个**可变 `state`**
 * 模拟 `markSent` 的 `'reserved' → 'sent'` 迁移 —— 于是「`export_id` 由派发层下传、回查只可能在
 * `markSent` 之前命中」成了可断言的事实。
 *
 * ## 钉住的四件事
 * 1. 成功路径：写 **1 行**，`invocation_state='sent'`，`export_id` 就是那张预留行；
 * 2. 失败路径（内层抛错 / 内层自报 `kind:'failed'`）：写 **1 行** `send_failed`，调用方看到的结果不变；
 * 3. 非 `real`：**零读零写**（连一次 `findReservedByObject` 都不做）；
 * 4. ⛔ 记账失败不改判：`record()` 抛错时识别结果逐字节不变，读数/事件照涨。
 *
 * 零网络、零 IO（不连库）：需要真 PG 的那部分在 `tests/integration/recognitions-provider-call-ledger-pg.mjs`，
 * 而那一支在本机**未执行**（无 PG），见该文件标题。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createMediaJobEgress } from '../../services/api/src/privacy/task-egress.ts';
import { withProviderCallAccounting } from '../../services/api/src/privacy/media-call-accounting.ts';
import { PrivacyError } from '../../packages/privacy/errors.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const USER_ID = '00000000-0000-4000-8f00-0000000000a1';
const MEDIA_ID = '00000000-0000-4000-8f00-0000000000b2';
const JOB_ID = '00000000-0000-4000-8f00-0000000000c3';
const EXPORT_ID = '00000000-0000-4000-8f00-0000000000d4';
const RECIPIENT_ID = '00000000-0000-4000-8f00-0000000000e5';
const REVISION = 7;
const PROFILE = 'openai-vision-v1';
const INPUT = { jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: REVISION };

/** `ledger-pg.ts:690` 的谓词（逐字）。下面的假账本按它筛行，并在末尾的用例里钉住原文没变。 */
const RESERVED_PREDICATE = "state='reserved' AND cancelled_at IS NULL";

/** `provider()` 的返回形状（`available` 决定受理能不能预留，见 `task-egress.ts:116`）。 */
function providerOf(recognize) {
  return { executionMode: 'real', modelVersion: PROFILE, available: true, unavailableReason: null, recognize };
}

/**
 * 假的外发账本：只实现 `MediaJobEgress` 用得到的方法，并记录**每一次** `findReservedByObject`
 * 看到的 `state`（这就是「取 id 时点」的证据）与整体调用顺序 `trace`。
 *
 * 筛选逐字对应 `ledger-pg.ts:686-691`：
 *   `WHERE object_type=… AND object_revision=… AND object_id=…（媒体维走 uuid 列）
 *      AND state='reserved' AND cancelled_at IS NULL ORDER BY created_at DESC LIMIT 1`
 * 这里只有一行，`ORDER BY … LIMIT 1` 的语义就是「取这一行」。
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
    jobId: null,
    revision: 1,
    errorCode: null,
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
        // ↓ 谓词的两个条件（逐字见 RESERVED_PREDICATE）
        row.state === 'reserved' &&
        row.cancelledAt === null;
      return matches
        ? { id: row.id, userId: row.userId, objectType: row.objectType, objectId: row.objectId, objectRevision: row.objectRevision, state: row.state, revision: row.revision }
        : null;
    },
    async resolveRecipient() {
      trace.push('resolveRecipient');
      return RECIPIENT_ID;
    },
    async reserve(input) {
      trace.push('reserve');
      row.objectRevision = input.objectRevision;
      row.revision += 1;
      return { id: row.id };
    },
    async linkJob({ exportId, jobId }) {
      trace.push('linkJob');
      assert.equal(exportId, EXPORT_ID);
      row.jobId = jobId;
    },
    async markSent(id) {
      trace.push('markSent');
      // 与 `ledger-pg.ts:717-738` 同一条规矩：非预留态 ⇒ OBJECT_UNAVAILABLE，⛔ 不许二次派发。
      if (row.state !== 'reserved') {
        throw new PrivacyError('OBJECT_UNAVAILABLE', `外发记录非预留态（${row.state}），禁止派发`);
      }
      row.state = 'sent';
      row.revision += 1;
      return { id: row.id, userId: row.userId, objectRevision: row.objectRevision };
    },
    async markFailed(id, { errorCode }) {
      trace.push('markFailed');
      assert.equal(id, EXPORT_ID);
      row.state = 'send_failed';
      row.errorCode = errorCode;
      row.revision += 1;
      return { id: row.id };
    },
    async cancelForJob() {
      return { cancelled: 0 };
    },
    async cancelVersion() {
      return { cancelled: false, alreadyCancelled: false, cancelledCount: 0 };
    },
  };
}

/** 在途守卫替身（`assertExecutable` / `saveResult`）：只记录顺序，不做判定。 */
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

/** 假记账台账：收下整行（`throwWith` 可让 `record()` 抛错，模拟 42501 / 超时 / CHECK 失败）。 */
function callLedgerOf(throwWith) {
  const rows = [];
  return {
    rows,
    async record(input) {
      if (throwWith !== undefined) throw throwWith;
      rows.push(input);
      return { attempt: rows.length };
    },
  };
}

function readingsOf() {
  return { written: 0, failed: 0, lastError: null };
}

/**
 * 按**生产同序**装配（GY-R94 起）：`withProviderCallAccounting(inner, …)` 先包一层，
 * 再由 `egress.provider(accounted, 'recognize')` 包在最外 —— 记账在 egress **内层**，于是同一张
 * 预留行内的两次派发各写一行（`attempt` 1、2 由 0055 的 SQL 派生）。装配点见 `app.ts` 的 `provider:`。
 */
function compose({ executionMode = 'real', recognize, callLedger, readings, log } = {}) {
  const exports = exportsLedgerOf();
  const egress = createMediaJobEgress({
    ledger: exports,
    inFlight: inFlightOf(exports.trace),
    executionMode,
    dataType: 'image',
    capability: 'weed',
  });
  const inner = providerOf(recognize);
  const dispatch = egress.provider(
    withProviderCallAccounting(inner, {
      ledger: callLedger ?? callLedgerOf(),
      exportLedger: exports,
      capability: 'weed',
      executionMode,
      readings,
      log,
    }),
    'recognize',
  );
  return { exports, egress, inner, accounted: dispatch, callLedger };
}

const COMPLETED = {
  kind: 'completed',
  candidates: [{ species_id: 'species_barnyardgrass', rank: 1, model_score: 0.91 }],
  usage: { prompt_tokens: 1000, completion_tokens: 40, total_tokens: 1040 },
  providerConfigVersion: `${PROFILE}#vision-model-test@1a2b3c4d`,
};

// ---------------------------------------------------------------------------
// 一、成功路径：1 行 sent，且取 id 早于 markSent
// ---------------------------------------------------------------------------

test('组合臂：成功路径写 1 行 sent（export_id 取自调用前读到的预留行）', async () => {
  const callLedger = callLedgerOf();
  const readings = readingsOf();
  const events = [];
  const { exports, egress, accounted } = compose({
    recognize: async () => COMPLETED,
    callLedger,
    readings,
    log: (event) => events.push(event),
  });

  const reserved = await egress.reserveForAcceptance({
    userId: USER_ID,
    authEpoch: 1,
    objectId: MEDIA_ID,
    objectRevision: REVISION,
  });
  assert.deepEqual(reserved, { exportId: EXPORT_ID });

  const outcome = await accounted.recognize(INPUT);

  assert.equal(outcome, COMPLETED, '识别结果必须原样返回');
  assert.equal(exports.row.state, 'sent', 'egress 侧照常 markSent');
  // 记账层真写进去了：这正是修复前恒 0 行的那一行。
  assert.equal(callLedger.rows.length, 1, '记账行数：修复前是 0');
  const row = callLedger.rows[0];
  assert.equal(row.exportId, EXPORT_ID);
  assert.equal(row.invocationState, 'sent');
  assert.equal(row.jobId, JOB_ID);
  assert.equal(row.capability, 'weed');
  assert.equal(row.domain, 'recognition');
  assert.deepEqual(row.usage, { prompt_tokens: 1000, completion_tokens: 40, total_tokens: 1040 });
  assert.equal(row.providerConfigVersion, `${PROFILE}#vision-model-test@1a2b3c4d`);
  assert.equal(row.modelVersion, PROFILE);
  // ★ 归属来源（GY-R94 起）：`export_id` 由派发层下传，记账层**不**再回查预留行 ——
  //   预留行只被 egress 读到一次，且那次必须在 `markSent` 之前（回查一旦挪到 markSent 之后，
  //   `state='reserved'` 谓词恒不命中 ⇒ 0 行、读数 failed=1）。
  assert.deepEqual(exports.reads.map((read) => read.state), ['reserved']);
  assert.ok(
    exports.trace.lastIndexOf('markSent') > exports.trace.lastIndexOf('findReservedByObject'),
    `取 id 必须早于 markSent（实际顺序：${exports.trace.join(' → ')}）`,
  );
  assert.deepEqual(readings, { written: 1, failed: 0, lastError: null });
  assert.deepEqual(events, [], '成功路径不许发失败事件');
});

// ---------------------------------------------------------------------------
// 二、失败路径：1 行 send_failed（抛错 / 自报 kind:'failed' 两种）
// ---------------------------------------------------------------------------

test('组合臂：内层抛错 ⇒ 写 1 行 send_failed，调用方仍看到同一个错误对象', async () => {
  const failure = new PrivacyError('PROVIDER_UNAVAILABLE', '真实外发传输未接入：real 模式 fail-closed', {
    retryable: false,
  });
  const callLedger = callLedgerOf();
  const readings = readingsOf();
  const { exports, egress, accounted } = compose({
    recognize: async () => {
      throw failure;
    },
    callLedger,
    readings,
  });
  await egress.reserveForAcceptance({ userId: USER_ID, authEpoch: 1, objectId: MEDIA_ID, objectRevision: REVISION });

  await assert.rejects(accounted.recognize(INPUT), (error) => error === failure, '错误对象必须原样重抛');
  assert.equal(exports.row.state, 'send_failed', 'egress 侧 markFailed 照常执行');
  assert.equal(exports.row.errorCode, 'PROVIDER_UNAVAILABLE');
  assert.equal(callLedger.rows.length, 1, '失败也要记 1 行（失败的那次外发是事实）');
  assert.equal(callLedger.rows[0].invocationState, 'send_failed');
  assert.equal(callLedger.rows[0].usage, null, '⛔ 失败那次没有可采信的回包，不许补零');
  assert.deepEqual(readings, { written: 1, failed: 0, lastError: null });
});

test('组合臂：内层自报 kind=failed ⇒ 写 1 行 send_failed，调用方拿到原样的结果对象', async () => {
  const failed = { kind: 'failed', code: 'PROVIDER_QUOTA_EXCEEDED' };
  const callLedger = callLedgerOf();
  const { exports, egress, accounted } = compose({ recognize: async () => failed, callLedger });
  await egress.reserveForAcceptance({ userId: USER_ID, authEpoch: 1, objectId: MEDIA_ID, objectRevision: REVISION });

  assert.equal(await accounted.recognize(INPUT), failed);
  assert.equal(exports.row.state, 'send_failed');
  assert.equal(callLedger.rows.length, 1);
  assert.equal(callLedger.rows[0].invocationState, 'send_failed');
  assert.equal(callLedger.rows[0].usage, null);
});

// ---------------------------------------------------------------------------
// 三、非 real：零读零写（替身不外发 ⇒ 账本里不得出现任何一行）
// ---------------------------------------------------------------------------

test('组合臂：非 real（stub / preset_demo）⇒ 零读零写，提供者原样返回', async () => {
  for (const executionMode of ['stub', 'preset_demo']) {
    const callLedger = callLedgerOf();
    const { exports, egress, inner, accounted } = compose({
      executionMode,
      recognize: async () => ({ kind: 'completed', candidates: [] }),
      callLedger,
    });
    assert.equal(accounted, inner, `${executionMode}：两层都不接管，必须原样返回同一个对象`);
    assert.equal(
      await egress.reserveForAcceptance({ userId: USER_ID, authEpoch: 1, objectId: MEDIA_ID, objectRevision: REVISION }),
      null,
      `${executionMode}：不预留`,
    );
    await accounted.recognize(INPUT);
    assert.equal(exports.reads.length, 0, `${executionMode}：连一次 findReservedByObject 都不许发`);
    assert.equal(callLedger.rows.length, 0, `${executionMode}：零写`);
  }
});

// ---------------------------------------------------------------------------
// 四、记账失败不改判（观测经事件走既有日志出口）
// ---------------------------------------------------------------------------

test('组合臂：record() 抛错 ⇒ 识别结果不变、外发仍 sent，只涨读数并发 1 条事件', async () => {
  const denied = Object.assign(new Error('permission denied for table provider_call_ledger'), { code: '42501' });
  const callLedger = callLedgerOf(denied);
  const readings = readingsOf();
  const events = [];
  const { exports, egress, accounted } = compose({
    recognize: async () => COMPLETED,
    callLedger,
    readings,
    log: (event) => events.push(event),
  });
  await egress.reserveForAcceptance({ userId: USER_ID, authEpoch: 1, objectId: MEDIA_ID, objectRevision: REVISION });

  const outcome = await accounted.recognize(INPUT);

  assert.equal(outcome, COMPLETED, '记账失败⛔ 不许重造/改写识别结果');
  assert.equal(exports.row.state, 'sent', '外发已经发生，账本状态不受记账失败影响');
  assert.equal(callLedger.rows.length, 0, '写不进去就是写不进去（⛔ 不假装写过）');
  assert.deepEqual(readings, { written: 0, failed: 1, lastError: 'PROVIDER_UNAVAILABLE' });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'provider_call_ledger_write_failed');
  assert.equal(events[0].export_id, EXPORT_ID);
  assert.equal(events[0].invocation_state, 'sent');
  // 读数随事件走既有日志出口（生产装配把 `log` 接到 `app.log.warn`）：计数在事件里可见。
  assert.equal(events[0].readings_failed, 1);
  assert.equal(events[0].readings_written, 0);
  // 事件里不许出现正文/候选/凭据/驱动原文。
  const serialized = JSON.stringify(events[0]);
  for (const forbidden of ['species_barnyardgrass', 'total_tokens', 'permission denied']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

// ---------------------------------------------------------------------------
// 五、假账本与真谓词同源（谓词变了这支就要重看）
// ---------------------------------------------------------------------------

test('假账本的筛选是 ledger-pg.ts 预留行谓词的逐字复制（谓词一变本支必须同步）', () => {
  const source = readFileSync(join(ROOT, 'services/api/src/privacy/ledger-pg.ts'), 'utf8');
  assert.ok(
    source.includes(RESERVED_PREDICATE),
    `ledger-pg.ts 里找不到谓词原文「${RESERVED_PREDICATE}」：假账本的筛选已经与真谓词漂开`,
  );
  assert.ok(source.includes('ORDER BY created_at DESC LIMIT 1'), '取最新一行的排序变了：本支的「只有一行」前提要重看');
});
