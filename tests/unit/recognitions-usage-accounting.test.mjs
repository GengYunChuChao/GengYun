/**
 * GY-R83 · `#1003`：识别外发**记账层**的行为单测（`privacy/media-call-accounting.ts`）。零网络、零 IO。
 *
 * 用**假账本对象**（`record` 只往数组里塞）与**假外发账本**（`findReservedByObject` 只回一行假记录）
 * 钉住九件事：
 * 1. 成功 ⇒ 写 `sent` 且**带** `usage`（只留合法键）；
 * 2. 内层抛错 / 内层自报 `kind:'failed'` ⇒ 写 `send_failed` 且 `usage` 恒 `null`（⛔ 不猜、不补零）；
 * 3. ⛔ **记账失败不改判**：`record()` 抛错时识别结果**逐字节不变**，但 `readings.failed` +1、
 *    `lastError` 是契约码、并留下一条安全事件；
 * 4. 拿不到外发预留行 ⇒ **不写行**（没有 `export_id` 就没有归属），只记失败读数；
 * 5. 非 `real` / 无台账 ⇒ **原样返回内层提供者**（同一个对象引用），连一次读都不做；
 * 6. `startedAt` 取在**读账本之后** ⇒ `duration_ms` **不含**本层的读账本，但**含**内层适配器自己的前置
 *    库往返（`linkJob` / `assertExecutable` / `markSent`）；`sent_at` 不含读账本的推迟（P2-1）；
 * 7. 注入会抛的 `log` ⇒ 提供者照调、已成功的识别不被改判（P2-2：日志出口不是业务错误）；
 * 8. 读**永不 settle** ⇒ 预算兜底，作业照发、`failed+1`、账本零写行（P2-4：删掉读侧 `withDeadline` 必红）；
 * 9. 写**永不 settle**（`sink.record` 不 settle）⇒ 预算兜底：已成功的识别照常返回、`failed+1`、账本零写行
 *    （P2-2〔4ecba402〕：删掉**写侧** `withDeadline` ⇒ 这条**红在断言上**，不是红在超时上）。
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

// ---------------------------------------------------------------------------
// P2 跟进（独立审查 442f732b）：口径与注入点
// ---------------------------------------------------------------------------

test('P2-1 读账本 150ms + provider 30ms ⇒ duration_ms 不含本层读账本（含内层前置开销），sent_at 取在读之后', async () => {
  const READ_MS = 150;
  const PROVIDER_MS = 30;
  const ledger = ledgerOf();
  let providerEnteredAt = 0;
  let providerLeftAt = 0;
  const exportLedger = exportLedgerOf(async () => {
    await new Promise((resolve) => setTimeout(resolve, READ_MS));
    return { id: EXPORT_ID, state: 'reserved' };
  });
  // 不注入 `now`：要量的就是真实时钟下两段延迟的分界。
  const wrapped = withProviderCallAccounting(
    providerOf(async () => {
      providerEnteredAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, PROVIDER_MS));
      providerLeftAt = Date.now();
      return { kind: 'completed', candidates: [] };
    }),
    { ledger, exportLedger, capability: 'weed', executionMode: 'real' },
  );

  const enteredAt = Date.now();
  await wrapped.recognize(INPUT);

  const row = ledger.rows[0];
  const providerSpan = providerLeftAt - providerEnteredAt;
  // 口径（±20ms 抖动，⛔ 不写成脆弱的精确值）：**不含**本层读账本的 150ms；**含**内层适配器自己的前置
  // 库往返（`linkJob`/`assertExecutable`/`markSent`）—— 本用例的 provider 是空壳（进去就睡），两段因此近似相等。
  assert.ok(row.durationMs >= providerSpan - 20, `duration_ms=${row.durationMs} 小于 provider 段 ${providerSpan}`);
  assert.ok(row.durationMs <= providerSpan + 20, `duration_ms=${row.durationMs} 超出 provider 段 ${providerSpan}`);
  assert.ok(row.durationMs < READ_MS, `duration_ms=${row.durationMs} 把读账本的 ${READ_MS}ms 也算了进去`);
  // `sent_at` 是「外发**进入**时刻」（0055 :362-363）：读账本之后、调 provider 之前。
  assert.ok(
    row.sentAt.getTime() - enteredAt >= READ_MS - 20,
    `sent_at 比进入适配器只早 ${row.sentAt.getTime() - enteredAt}ms：读账本的推迟被算进了外发时刻`,
  );
  assert.ok(row.sentAt.getTime() <= providerEnteredAt, 'sent_at 必须早于 provider 真正被调用的时刻');
});

test('P2-2 注入会抛的 log（拿不到预留行）⇒ 提供者仍被调用、识别结果照常返回', async () => {
  const ledger = ledgerOf();
  const readings = readingsOf();
  const expected = { kind: 'completed', candidates: [] };
  let providerCalls = 0;
  const wrapped = withProviderCallAccounting(
    providerOf(async () => {
      providerCalls += 1;
      return expected;
    }),
    {
      ledger,
      // 走到 `provider_call_ledger_unresolved` 那条 emit（读账本没拿到预留行）。
      exportLedger: exportLedgerOf(null),
      capability: 'weed',
      executionMode: 'real',
      now: clock([0, 0]),
      readings,
      log: () => {
        throw new Error('log sink exploded');
      },
    },
  );

  // 先把「不许抛」单独钉住：裸 `await` 一旦回归，日志里只剩 `Error: log sink exploded`，
  // 读起来像本用例在要求「日志出口不许抛错」——它真正要守的是「日志出口的异常不许漏到调用方」。
  const pending = wrapped.recognize(INPUT);
  await assert.doesNotReject(() => pending, '⛔ 日志出口抛错不许漏到调用方：识别必须照常 resolve');
  const outcome = await pending;

  assert.equal(providerCalls, 1, '⛔ 日志出口抛错不许把识别挡在**外发之前**（提供者一次都没调到）');
  assert.equal(outcome, expected);
  assert.equal(ledger.rows.length, 0);
  assert.deepEqual(readings, { written: 0, failed: 1, lastError: 'OBJECT_UNAVAILABLE' });
});

test('P2-2 注入会抛的 log（record 抛错）⇒ 已成功的识别不被改判，结果对象仍在', async () => {
  const readings = readingsOf();
  const expected = { kind: 'completed', candidates: [{ species_id: 'species_barnyardgrass', rank: 1, model_score: 0.8 }] };
  const wrapped = withProviderCallAccounting(providerOf(async () => expected), {
    ledger: ledgerOf(new Error('permission denied')),
    exportLedger: exportLedgerOf(),
    capability: 'weed',
    executionMode: 'real',
    now: clock([0, 10]),
    readings,
    log: () => {
      throw new Error('log sink exploded');
    },
  });

  // 同上：先钉「不许抛」，让回归时的失败信息直指「异常漏到了调用方」，而不是只报一句 log sink exploded。
  const pending = wrapped.recognize(INPUT);
  await assert.doesNotReject(() => pending, '⛔ 写失败事件出口抛错不许漏到调用方：识别必须照常 resolve');
  const outcome = await pending;

  assert.equal(outcome, expected, '⛔ 写失败事件出口再抛错，也不许把已成功的识别改判（结果会被整条丢掉）');
  assert.deepEqual(readings, { written: 0, failed: 1, lastError: 'PROVIDER_UNAVAILABLE' });
});

test(
  'P2-4 读永不 settle ⇒ 预算兜底：作业照发、failed+1、账本零写行',
  { timeout: 5000 },
  async () => {
    const ledger = ledgerOf();
    const readings = readingsOf();
    const events = [];
    let providerCalls = 0;
    const expected = { kind: 'completed', candidates: [] };
    const wrapped = withProviderCallAccounting(
      providerOf(async () => {
        providerCalls += 1;
        return expected;
      }),
      {
        ledger,
        // 读预留行永不 settle：没有预算兜底，这个作业会永远挂在外发之前。
        exportLedger: { findReservedByObject: () => new Promise(() => {}) },
        capability: 'weed',
        executionMode: 'real',
        budgetMs: 30,
        readings,
        log: (event) => events.push(event),
      },
    );

    const outcome = await wrapped.recognize(INPUT);

    assert.equal(outcome, expected, '预算耗尽只影响记账，作业照发、结果照回');
    assert.equal(providerCalls, 1);
    assert.equal(ledger.rows.length, 0, '没有 export_id ⇒ 零写行（⛔ 不猜归属）');
    assert.deepEqual(readings, { written: 0, failed: 1, lastError: 'PROVIDER_TIMEOUT' });
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'provider_call_ledger_unresolved');
    assert.equal(events[0].code, 'PROVIDER_TIMEOUT');
  },
);

// ---------------------------------------------------------------------------
// 独立审查 4ecba402（P2-2）：上一条只覆盖**读**侧，写侧 `withDeadline` 一直是零覆盖
// ---------------------------------------------------------------------------

test(
  'P2-2〔4ecba402〕写永不 settle ⇒ 预算兜底：已成功的识别照常返回、failed+1、账本零写行',
  { timeout: 5000 },
  async () => {
    const ledger = ledgerOf();
    // 写永不 settle：没有预算兜底，识别**已经成功**却会永远挂在「结果在手、行还没记上」。
    const stalledSink = { ...ledger, record: () => new Promise(() => {}) };
    const readings = readingsOf();
    const events = [];
    let providerCalls = 0;
    const expected = { kind: 'completed', candidates: [] };
    const wrapped = withProviderCallAccounting(
      providerOf(async () => {
        providerCalls += 1;
        return expected;
      }),
      {
        ledger: stalledSink,
        exportLedger: exportLedgerOf(),
        capability: 'weed',
        executionMode: 'real',
        budgetMs: 30,
        readings,
        log: (event) => events.push(event),
      },
    );

    // ⛔ 不用裸 `await`：那样删掉写侧 `withDeadline` 只会让整条用例挂到 `{ timeout: 5000 }` 上，
    // 变成「超时红」——红是红了，却看不出是哪条不变量破了。改成跟一个有名字的哨兵赛跑，
    // 回归时 2s 内就命中下面那条断言，失败信息直指「记账把识别卡死」。
    const TIMED_OUT = Symbol('write-never-settled');
    const outcome = await Promise.race([
      wrapped.recognize(INPUT),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(TIMED_OUT), 2000);
        timer.unref?.();
      }),
    ]);

    assert.notEqual(
      outcome,
      TIMED_OUT,
      '⛔ 写侧没有预算兜底：识别早已成功，却因为 `sink.record` 不 settle 而永远回不来（记账把识别卡死）',
    );
    assert.equal(outcome, expected, '预算耗尽只影响记账，已成功的识别必须照常返回');
    assert.equal(providerCalls, 1);
    assert.equal(ledger.rows.length, 0, '写侧超时 ⇒ 账本零写行（`record()` 一行都没落）');
    assert.deepEqual(readings, { written: 0, failed: 1, lastError: 'PROVIDER_TIMEOUT' });
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'provider_call_ledger_write_failed');
    assert.equal(events[0].code, 'PROVIDER_TIMEOUT');
    assert.equal(events[0].export_id, EXPORT_ID);
    assert.equal(events[0].invocation_state, 'sent');
  },
);
