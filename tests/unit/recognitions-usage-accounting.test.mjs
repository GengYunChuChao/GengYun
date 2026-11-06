/**
 * GY-R83 · `#1003`：识别外发**记账层**的行为单测（`privacy/media-call-accounting.ts`）。零网络、零 IO。
 *
 * 用**假账本对象**（`record` 只往数组里塞）与**假外发账本**（`findReservedByObject` 只回一行假记录）
 * 钉住五件事：
 * 1. 成功 ⇒ 写 `sent` 且**带** `usage`（只留合法键）；
 * 2. 内层抛错 / 内层自报 `kind:'failed'` ⇒ 写 `send_failed` 且 `usage` 恒 `null`（⛔ 不猜、不补零）；
 * 3. ⛔ **记账失败不改判**：`record()` 抛错时识别结果**逐字节不变**，但 `readings.failed` +1、
 *    `lastError` 是契约码、并留下一条安全事件；
 * 4. 拿不到外发预留行 ⇒ **不写行**（没有 `export_id` 就没有归属），只记失败读数；
 * 5. 非 `real` / 无台账 ⇒ **原样返回内层提供者**（同一个对象引用），连一次读都不做。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { withProviderCallAccounting } from '../../services/api/src/privacy/media-call-accounting.ts';

const EXPORT_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const MEDIA_ID = '33333333-3333-4333-8333-333333333333';
const INPUT = { jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 7 };
const PROFILE = 'openai-vision-v1';

/** 假外发账本：记下每次查询入参，回一行 `state='reserved'` 的假预留行（或自定义行为）。 */
function exportLedgerOf(answer) {
  const calls = [];
  return {
    calls,
    async findReservedByObject(input) {
      calls.push(input);
      if (typeof answer === 'function') return answer(input);
      return answer === undefined ? { id: EXPORT_ID, state: 'reserved' } : answer;
    },
  };
}

/** 假记账台账：收下整行；`throwWith` 可让 `record()` 抛错（模拟 42501 / 超时 / CHECK 失败）。 */
function ledgerOf(throwWith) {
  const rows = [];
  return {
    rows,
    async record(input) {
      if (throwWith !== undefined) throw throwWith;
      rows.push(input);
    },
  };
}

/** 固定步进时钟：每次调用取下一个值（`recognize` 正好用两次：入口/出口）。 */
function clock(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function providerOf(recognize, modelVersion = PROFILE) {
  return { executionMode: 'real', modelVersion, available: true, unavailableReason: null, recognize };
}

function readingsOf() {
  return { written: 0, failed: 0, lastError: null };
}

test('成功 ⇒ 写 sent，带 usage/export_id/耗时，识别结果原样返回', async () => {
  const ledger = ledgerOf();
  const exportLedger = exportLedgerOf();
  const readings = readingsOf();
  const inner = providerOf(async () => ({
    kind: 'completed',
    candidates: [{ species_id: 'species_barnyardgrass', rank: 1, model_score: 0.9 }],
    // 非法键值（负数）应被 `readCallMetadata` 收口掉，⛔ 不整行拒写。
    usage: { prompt_tokens: 100, completion_tokens: 20, bad: -5 },
    providerConfigVersion: `${PROFILE}#vision-model-test@1a2b3c4d`,
  }));
  const wrapped = withProviderCallAccounting(inner, {
    ledger,
    exportLedger,
    capability: 'weed',
    executionMode: 'real',
    now: clock([1000, 1250]),
    readings,
  });

  const outcome = await wrapped.recognize(INPUT);

  assert.equal(outcome.kind, 'completed');
  assert.deepEqual(outcome.candidates, [{ species_id: 'species_barnyardgrass', rank: 1, model_score: 0.9 }]);
  assert.equal(ledger.rows.length, 1);
  const row = ledger.rows[0];
  assert.equal(row.domain, 'recognition');
  assert.equal(row.exportId, EXPORT_ID);
  assert.equal(row.jobId, JOB_ID);
  assert.equal(row.capability, 'weed');
  assert.equal(row.invocationState, 'sent');
  assert.deepEqual(row.usage, { prompt_tokens: 100, completion_tokens: 20 });
  // 版本串优先取提供者返回的那一个；`model_version` 单独写剖面串。
  assert.equal(row.providerConfigVersion, `${PROFILE}#vision-model-test@1a2b3c4d`);
  assert.equal(row.modelVersion, PROFILE);
  assert.equal(row.durationMs, 250);
  assert.ok(row.sentAt instanceof Date);
  assert.equal(row.attempt, undefined, '⛔ attempt 由 SQL 派生，装配层不传');
  // 归属判定用的是**既有**谓词（media + revision），不是新建的一套。
  assert.deepEqual(exportLedger.calls, [{ objectType: 'media', objectId: MEDIA_ID, objectRevision: 7 }]);
  assert.deepEqual(readings, { written: 1, failed: 0, lastError: null });
});

test('内层抛错 ⇒ send_failed（usage 恒 null）+ 错误对象原样重抛', async () => {
  const ledger = ledgerOf();
  const readings = readingsOf();
  const failure = Object.assign(new Error('upstream timeout'), { code: 'PROVIDER_TIMEOUT' });
  const inner = providerOf(async () => {
    throw failure;
  });
  const wrapped = withProviderCallAccounting(inner, {
    ledger,
    exportLedger: exportLedgerOf(),
    capability: 'weed',
    executionMode: 'real',
    now: clock([5, 5]),
    readings,
  });

  await assert.rejects(wrapped.recognize(INPUT), (error) => error === failure, '必须抛回同一个错误对象');
  assert.equal(ledger.rows.length, 1);
  assert.equal(ledger.rows[0].invocationState, 'send_failed');
  assert.equal(ledger.rows[0].usage, null);
  assert.deepEqual(readings, { written: 1, failed: 0, lastError: null });
});

test('内层自报 kind=failed ⇒ 不抛错，但写 send_failed（usage 恒 null）', async () => {
  const ledger = ledgerOf();
  const failed = { kind: 'failed', code: 'PROVIDER_QUOTA_EXCEEDED' };
  const wrapped = withProviderCallAccounting(providerOf(async () => failed), {
    ledger,
    exportLedger: exportLedgerOf(),
    capability: 'weed',
    executionMode: 'real',
    now: clock([0, 0]),
  });
  assert.equal(await wrapped.recognize(INPUT), failed);
  assert.equal(ledger.rows[0].invocationState, 'send_failed');
  assert.equal(ledger.rows[0].usage, null);
});

test('⛔ 记账失败不改判：record() 抛错时识别结果不变，只涨 readings.failed + 留事件', async () => {
  const ledger = ledgerOf(Object.assign(new Error('permission denied'), { code: 'PROVIDER_UNAVAILABLE' }));
  const readings = readingsOf();
  const events = [];
  const expected = { kind: 'completed', candidates: [{ species_id: 'species_goosegrass', rank: 1, model_score: 0.5 }], usage: { total_tokens: 12 } };
  const wrapped = withProviderCallAccounting(providerOf(async () => expected), {
    ledger,
    exportLedger: exportLedgerOf(),
    capability: 'weed',
    executionMode: 'real',
    now: clock([10, 20]),
    readings,
    log: (event) => events.push(event),
  });

  const outcome = await wrapped.recognize(INPUT);

  assert.equal(outcome, expected, '识别结果必须是**同一个**对象（记账失败不重造、不改写）');
  assert.deepEqual(readings, { written: 0, failed: 1, lastError: 'PROVIDER_UNAVAILABLE' });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'provider_call_ledger_write_failed');
  assert.equal(events[0].code, 'PROVIDER_UNAVAILABLE');
  assert.equal(events[0].export_id, EXPORT_ID);
  assert.equal(events[0].invocation_state, 'sent');
  // 事件里不许出现正文/候选/凭据（只允许安全 token）。
  const serialized = JSON.stringify(events[0]);
  for (const forbidden of ['species_goosegrass', 'total_tokens', 'permission denied']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('记账抛非 ApiError 的裸错 ⇒ lastError 落 PROVIDER_UNAVAILABLE（⛔ 不采信驱动原文）', async () => {
  const readings = readingsOf();
  const wrapped = withProviderCallAccounting(providerOf(async () => ({ kind: 'completed', candidates: [] })), {
    ledger: ledgerOf(new Error('57014 statement timeout')),
    exportLedger: exportLedgerOf(),
    capability: 'weed',
    executionMode: 'real',
    now: clock([0, 0]),
    readings,
  });
  await wrapped.recognize(INPUT);
  assert.equal(readings.failed, 1);
  assert.equal(readings.lastError, 'PROVIDER_UNAVAILABLE');
});

test('拿不到外发预留行 ⇒ 不写行（无 export_id 即无归属），只涨 failed', async () => {
  const ledger = ledgerOf();
  const readings = readingsOf();
  const events = [];
  const wrapped = withProviderCallAccounting(providerOf(async () => ({ kind: 'completed', candidates: [] })), {
    ledger,
    exportLedger: exportLedgerOf(null),
    capability: 'weed',
    executionMode: 'real',
    now: clock([0, 0]),
    readings,
    log: (event) => events.push(event),
  });

  const outcome = await wrapped.recognize(INPUT);
  assert.equal(outcome.kind, 'completed');
  assert.equal(ledger.rows.length, 0, '⛔ 没有 export_id 就不许写行');
  assert.deepEqual(readings, { written: 0, failed: 1, lastError: 'OBJECT_UNAVAILABLE' });
  assert.equal(events[0].event, 'provider_call_ledger_unresolved');
  assert.equal(events[0].media_revision, 7);
});

test('查预留行抛错 ⇒ 同样不写行、不改判（code 取契约码）', async () => {
  const ledger = ledgerOf();
  const readings = readingsOf();
  const wrapped = withProviderCallAccounting(providerOf(async () => ({ kind: 'completed', candidates: [] })), {
    ledger,
    exportLedger: exportLedgerOf(() => {
      throw Object.assign(new Error('db down'), { code: 'PROVIDER_UNAVAILABLE' });
    }),
    capability: 'weed',
    executionMode: 'real',
    now: clock([0, 0]),
    readings,
  });
  await wrapped.recognize(INPUT);
  assert.equal(ledger.rows.length, 0);
  assert.deepEqual(readings, { written: 0, failed: 1, lastError: 'PROVIDER_UNAVAILABLE' });
});

test('非 real / 无台账 ⇒ 原样返回同一个内层对象，零读零写', async () => {
  for (const overrides of [
    { executionMode: 'stub' },
    { executionMode: 'preset_demo' },
    { executionMode: 'real', ledger: null },
    { executionMode: 'real', exportLedger: null },
  ]) {
    const ledger = ledgerOf();
    const exportLedger = exportLedgerOf();
    const inner = providerOf(async () => ({ kind: 'completed', candidates: [] }));
    const wrapped = withProviderCallAccounting(inner, {
      ledger,
      exportLedger,
      capability: 'weed',
      executionMode: 'real',
      ...overrides,
    });
    assert.equal(wrapped, inner, JSON.stringify(overrides));
    await wrapped.recognize(INPUT);
    assert.equal(ledger.rows.length, 0);
    assert.equal(exportLedger.calls.length, 0, '连一次读都不做');
  }
});

test('版本串收口：提供者没给 ⇒ 用 modelVersion；都不合法 ⇒ unknown / model_version 写 null', async () => {
  const ledger = ledgerOf();
  const wrapped = withProviderCallAccounting(
    providerOf(async () => ({ kind: 'completed', candidates: [] }), 'bad profile'),
    { ledger, exportLedger: exportLedgerOf(), capability: 'weed', executionMode: 'real', now: clock([0, 0]) },
  );
  await wrapped.recognize(INPUT);
  assert.equal(ledger.rows[0].providerConfigVersion, 'unknown');
  assert.equal(ledger.rows[0].modelVersion, null);
});

test('jobId 空串 ⇒ 落 null（列可空、无外键；⛔ 不写空串冒充 id）', async () => {
  const ledger = ledgerOf();
  const wrapped = withProviderCallAccounting(providerOf(async () => ({ kind: 'completed', candidates: [] })), {
    ledger,
    exportLedger: exportLedgerOf(),
    capability: 'weed',
    executionMode: 'real',
    now: clock([0, 0]),
  });
  await wrapped.recognize({ jobId: '', mediaId: MEDIA_ID, mediaRevision: 7 });
  assert.equal(ledger.rows[0].jobId, null);
});
