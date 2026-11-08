/**
 * GY-R87（#29）· 作业终态原因自证：`CONSENT_WITHDRAWN` 的**判定口径**与**翻译边界**（Refs #29）。
 *
 * 本片把「撤回同意导致的 job 终态」写进 `error_code`（403 档闭集新增 `CONSENT_WITHDRAWN`）。
 * 这条链上有两个**很容易被写歪**的地方，本文件各自钉住：
 *
 *   1. `terminalFailureCodeOf`（`services/api/src/errors.ts`）的判定口径：早先写的是
 *      「取 `error.code` + `isErrorCode`」的**鸭子类型**，实测
 *      `terminalFailureCodeOf({ code: 'CONSENT_REQUIRED' })` 会返回 `CONSENT_WITHDRAWN`
 *      ⇒ 域外异常（第三方 SDK 自带 `code` 字段、或有人 `Object.assign` 一个）照样能冒充撤回。
 *      现口径与 `services/api/src/conversations/service.ts` 的 `settleCodeOf` **同一条**：
 *      只认 `instanceof ApiError` / `instanceof PrivacyError`。下面第 1 条用例就是**负空间**：
 *      若有人把它改回鸭子类型，这条立刻变红。
 *   2. `withdrawalAwareFailure`（`services/api/src/privacy/task-egress.ts`，由媒体三域与合成域
 *      共用）的翻译边界：只有**账本自己写着** `CONSENT_WITHDRAWN` 的那一行才翻。
 *      ⛔ 不把 `OBJECT_UNAVAILABLE` 一律当撤回——取消墓碑（`OBJECT_CANCELLED`）、无预留、
 *      版本不符也用同一个码，那样会把「用户取消」写成「用户撤回同意」，等于造假合规证据。
 *
 * 断言口径：先判 `typeof` / `instanceof` 再判值；不使用「只要不抛错就算过」的写法。
 * 本文件不涉及任何真实外发、不读数据库、不产生任何合规结论——只钉代码里的映射关系。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiError, terminalFailureCodeOf } from '../../services/api/src/errors.ts';
import {
  assertExecutableOrWithdrawn,
  saveResultOrWithdrawn,
  withdrawalAwareFailure,
} from '../../services/api/src/privacy/task-egress.ts';
import { createSynthesisEgress } from '../../services/api/src/privacy/synthesis-egress.ts';
import { PrivacyError } from '../../packages/privacy/errors.mjs';

/** 只实现 `get` 的账本替身（`TerminalReasonReader` 的最小形状）。 */
function ledgerStub(read) {
  return {
    async get(exportId) {
      return read(exportId);
    },
  };
}

/** 账本里那一行已被撤回置终态（`failed` + `CONSENT_WITHDRAWN`）。 */
function withdrawnLedger(exportId = 'exp-withdrawn') {
  return ledgerStub(async (id) => ({ id, state: 'failed', errorCode: 'CONSENT_WITHDRAWN' }));
}

const OBJECT_UNAVAILABLE_MESSAGE = '外发已终态（failed），回写被阻断';

// ---------------------------------------------------------------------------
// 1. 负空间：鸭子类型冒充不了「撤回」
// ---------------------------------------------------------------------------

test('负空间·形状像契约错误的对象一律 PROVIDER_OUTCOME_UNKNOWN（鸭子类型冒充不了撤回）', () => {
  const impostors = [
    ['普通对象带 CONSENT_REQUIRED', { code: 'CONSENT_REQUIRED' }],
    ['普通对象带 CONSENT_WITHDRAWN', { code: 'CONSENT_WITHDRAWN' }],
    [
      'Error 上挂 code（第三方 SDK 常见形状）',
      Object.assign(new Error('第三方 SDK 错误（测试替身）'), { code: 'CONSENT_REQUIRED' }),
    ],
    [
      'Error 连 name 一起改',
      Object.assign(new Error('伪装成隐私错误的域外异常（测试替身）'), {
        name: 'PrivacyError',
        code: 'CONSENT_WITHDRAWN',
      }),
    ],
  ];

  for (const [label, error] of impostors) {
    assert.equal(
      terminalFailureCodeOf(error),
      'PROVIDER_OUTCOME_UNKNOWN',
      `${label}：不是 ApiError/PrivacyError 实例 ⇒ 不得翻译成撤回（改回鸭子类型这条就会红）`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. 正控制 + 反例：只有「契约实例 + 闭集内的撤回码」才翻
// ---------------------------------------------------------------------------

test('正控制·契约实例且码为 CONSENT_REQUIRED/CONSENT_WITHDRAWN 才落 CONSENT_WITHDRAWN', () => {
  const withdrawnSources = [
    ['ApiError(CONSENT_REQUIRED)：执行前重查发现授权已撤回', new ApiError('CONSENT_REQUIRED', '执行前重查：授权已撤回（测试替身）')],
    ['ApiError(CONSENT_WITHDRAWN)：账本终态原因已翻译', new ApiError('CONSENT_WITHDRAWN', '外发因撤回同意而终止（测试替身）')],
    [
      'PrivacyError(CONSENT_WITHDRAWN)：媒体/合成域的守卫翻译结果',
      new PrivacyError('CONSENT_WITHDRAWN', '外发因撤回同意而终止，结果不予写入'),
    ],
    ['PrivacyError(CONSENT_REQUIRED)：守卫直接抛同意缺失', new PrivacyError('CONSENT_REQUIRED', '同意缺失（测试替身）')],
  ];

  for (const [label, error] of withdrawnSources) {
    assert.equal(terminalFailureCodeOf(error), 'CONSENT_WITHDRAWN', `${label} 必须落 CONSENT_WITHDRAWN`);
  }
});

test('反例·同码族但语义不同的码不得被写成撤回（否则就是假合规证据）', () => {
  // 这些码都用 `OBJECT_UNAVAILABLE` 或 403 档的其它分支收场，**不是**撤回：
  // 写成 CONSENT_WITHDRAWN 会把「取消」「越权」「账号停用」「供应商超时」冒充成「用户撤回同意」。
  const notWithdrawn = [
    'OBJECT_UNAVAILABLE',
    'OBJECT_CANCELLED',
    'SCOPE_DENIED',
    'SELF_SCOPE_GRANT_DENIED',
    'ACCOUNT_INACTIVE',
    'PROVIDER_TIMEOUT',
    'PROVIDER_UNAVAILABLE',
    'PROVIDER_OUTCOME_UNKNOWN',
    'INPUT_UNCERTAIN',
  ];

  for (const code of notWithdrawn) {
    assert.equal(
      terminalFailureCodeOf(new ApiError(code, '非撤回（测试替身）')),
      'PROVIDER_OUTCOME_UNKNOWN',
      `ApiError(${code}) 不得被翻译成撤回`,
    );
  }

  // `PrivacyError` 的 code 是字符串（不受 `ErrorCode` 类型约束）⇒ `isErrorCode` 守卫必须仍在：
  // 闭集外的码若被写进作业终态，`GET /jobs/{id}` 的契约投影会 503（等于把「读不到」当失败原因）。
  assert.equal(
    terminalFailureCodeOf(new PrivacyError('NOT_A_CONTRACT_CODE', '闭集外的码（测试替身）')),
    'PROVIDER_OUTCOME_UNKNOWN',
    '闭集外的码不得进作业终态',
  );

  for (const value of [null, undefined, 'CONSENT_WITHDRAWN', 403, new Error('域外异常（测试替身）')]) {
    assert.equal(terminalFailureCodeOf(value), 'PROVIDER_OUTCOME_UNKNOWN', `非错误值 ${String(value)} 一律结果未知`);
  }
});

// ---------------------------------------------------------------------------
// 3. 翻译边界：只有账本自己写着撤回才翻
// ---------------------------------------------------------------------------

test('负控制·只有账本终态原因写着 CONSENT_WITHDRAWN 才把 OBJECT_UNAVAILABLE 翻成撤回（其余原样）', async () => {
  const objectUnavailable = new PrivacyError('OBJECT_UNAVAILABLE', OBJECT_UNAVAILABLE_MESSAGE);

  // ① 正控制：账本终态原因 = CONSENT_WITHDRAWN ⇒ 翻译（且翻译结果仍能被 `terminalFailureCodeOf` 认出来）
  const translated = await withdrawalAwareFailure(withdrawnLedger('exp-1'), 'exp-1', objectUnavailable);
  assert.equal(translated instanceof PrivacyError, true, '翻译结果必须仍是 PrivacyError（域层按 instanceof 判定）');
  assert.equal(translated.code, 'CONSENT_WITHDRAWN', '账本写着撤回 ⇒ 必须翻译成撤回');
  assert.notEqual(translated, objectUnavailable, '必须是新对象，不得就地改写守卫抛出的错误');
  assert.equal(terminalFailureCodeOf(translated), 'CONSENT_WITHDRAWN', '翻译结果必须一路走到作业终态码');

  // ② 取消墓碑：同一个 `OBJECT_UNAVAILABLE`，账本原因是 `OBJECT_CANCELLED` ⇒ 原样返回
  const cancelled = await withdrawalAwareFailure(
    ledgerStub(async (id) => ({ id, state: 'failed', errorCode: 'OBJECT_CANCELLED' })),
    'exp-2',
    objectUnavailable,
  );
  assert.equal(cancelled, objectUnavailable, '取消墓碑必须原样返回（把「取消」写成「撤回」＝假证据）');
  assert.equal(terminalFailureCodeOf(cancelled), 'PROVIDER_OUTCOME_UNKNOWN');

  // ③ 账本读不出来（库抖 / 被替身换掉）⇒ 不猜原因，保持原错误
  const unreadable = await withdrawalAwareFailure(
    ledgerStub(async () => {
      throw new Error('库抖（测试替身）');
    }),
    'exp-3',
    objectUnavailable,
  );
  assert.equal(unreadable, objectUnavailable, '账本读不出来时不得猜原因');

  // ④ 非 OBJECT_UNAVAILABLE 的错误：哪怕账本写着撤回也原样（撤回只解释守卫那一个码）
  const unrelated = new PrivacyError('PROVIDER_UNAVAILABLE', '凭据缺失（测试替身）');
  const untouched = await withdrawalAwareFailure(withdrawnLedger('exp-4'), 'exp-4', unrelated);
  assert.equal(untouched, unrelated, '其它错误一律原样返回（域层照旧折成 503）');

  // ⑤ 守卫直接抛 CONSENT_REQUIRED（执行前重查发现授权已撤回）⇒ 也翻，不必读账本
  const consentRequired = await withdrawalAwareFailure(
    ledgerStub(async () => {
      throw new Error('这条用例不该读账本');
    }),
    'exp-5',
    new PrivacyError('CONSENT_REQUIRED', '同意缺失（测试替身）'),
  );
  assert.equal(consentRequired.code, 'CONSENT_WITHDRAWN', 'CONSENT_REQUIRED 必须翻译成 CONSENT_WITHDRAWN');
});

// ---------------------------------------------------------------------------
// 4. 合成域接缝：`synthesis-egress` 的两个守卫调用点（:312 / :328）也必须走撤回感知
// ---------------------------------------------------------------------------

/** 合成域接缝的最小替身：只实现包装器真正会碰到的那几个账本方法。 */
function synthesisEgressHarness(options) {
  const row = {
    id: 'exp-synth-1',
    userId: 'user-1',
    state: 'reserved',
    errorCode: options.terminalReason ?? null,
    objectRevision: 3,
    objectType: 'answer',
    objectKey: 'answer-approved',
    requestedAt: new Date().toISOString(),
  };
  const calls = { linkJob: 0, markSent: 0, assertExecutable: 0, saveResult: 0, providerCalls: 0 };
  const ledger = {
    async findReservedByObject() {
      return { ...row };
    },
    async linkJob() {
      calls.linkJob += 1;
    },
    async markSent() {
      calls.markSent += 1;
      return { ...row, state: 'sent' };
    },
    async markFailed() {
      throw new PrivacyError('OBJECT_UNAVAILABLE', '外发已终态（failed），回写被阻断');
    },
    async get(exportId) {
      // 撤回把这一行置了终态：`state='failed'` + 终态原因（这正是翻译的唯一依据）。
      return { ...row, id: exportId, state: 'failed', errorCode: options.terminalReason ?? null };
    },
  };
  const inFlight = {
    async assertExecutable() {
      calls.assertExecutable += 1;
      if (options.assertExecutableError !== undefined) throw options.assertExecutableError;
    },
    async saveResult() {
      calls.saveResult += 1;
      if (options.saveResultError !== undefined) throw options.saveResultError;
    },
  };
  const content = {
    kind: 'substitute',
    note: '测试替身核对源（合成内容，非真实资料库）',
    async read(input) {
      return { type: input.type, id: input.id, revision: row.objectRevision };
    },
  };
  const egress = createSynthesisEgress({
    ledger,
    inFlight,
    executionMode: 'real',
    content,
    capability: 'tts',
    purpose: 'checked_content_tts',
  });
  egress.bindJobOwner({ jobId: 'job-synth-1', userId: 'user-1' });
  const inner = {
    available: true,
    unavailableReason: null,
    async synthesize() {
      calls.providerCalls += 1;
      return { kind: 'completed', artifact: { contentType: 'audio/mpeg', body: new Uint8Array([1]), substitute: false } };
    },
  };
  const wrapped = egress.provider(inner);
  return { calls, wrapped, row };
}

const targetRef = { type: 'answer', id: 'answer-approved', revision: 3 };
const guardBlocked = new PrivacyError('OBJECT_UNAVAILABLE', OBJECT_UNAVAILABLE_MESSAGE);

test('接缝·执行前重查被撤回拒绝 ⇒ 合成派发抛 CONSENT_WITHDRAWN，且 markSent 未发生（零派发）', async () => {
  const harness = synthesisEgressHarness({
    terminalReason: 'CONSENT_WITHDRAWN',
    assertExecutableError: guardBlocked,
  });
  await assert.rejects(
    () => harness.wrapped.synthesize({ jobId: 'job-synth-1', text: '合成用例文本。', locale: 'zh-CN', targetRef }),
    (error) => {
      assert.equal(error.code, 'CONSENT_WITHDRAWN', '守卫的 OBJECT_UNAVAILABLE 必须按账本终态原因翻译成撤回');
      return true;
    },
  );
  assert.equal(harness.calls.markSent, 0, '撤回后不到授权边界（零 sent）');
  assert.equal(harness.calls.providerCalls, 0, '撤回后不得真正派发');
});

test('接缝·保存前重查被撤回拒绝 ⇒ 合成派发抛 CONSENT_WITHDRAWN（域服务据此落 failed/CONSENT_WITHDRAWN）', async () => {
  const harness = synthesisEgressHarness({
    terminalReason: 'CONSENT_WITHDRAWN',
    saveResultError: guardBlocked,
  });
  await assert.rejects(
    () => harness.wrapped.synthesize({ jobId: 'job-synth-1', text: '合成用例文本。', locale: 'zh-CN', targetRef }),
    (error) => {
      assert.equal(error.code, 'CONSENT_WITHDRAWN', '保存前重查被撤回拒绝 ⇒ 必须是撤回原因（否则 TTS 终态又被折成 503）');
      return true;
    },
  );
  assert.equal(harness.calls.providerCalls, 1, '撤回发生在保存前：传输已发生，但结果零写入');
  assert.equal(harness.calls.markSent, 1, '此前已经过授权边界（sent 行存在）');
});

test('接缝·负控制：取消墓碑（同码不同因）经同一接缝仍是 OBJECT_UNAVAILABLE（不得改写成撤回）', async () => {
  const harness = synthesisEgressHarness({
    terminalReason: 'OBJECT_CANCELLED',
    assertExecutableError: guardBlocked,
  });
  await assert.rejects(
    () => harness.wrapped.synthesize({ jobId: 'job-synth-1', text: '合成用例文本。', locale: 'zh-CN', targetRef }),
    (error) => {
      assert.equal(error.code, 'OBJECT_UNAVAILABLE', '取消不得被写成撤回');
      return true;
    },
  );
});

test('包装器·assertExecutable / saveResult 两个时刻的守卫错误都接得住（媒体域与合成域共用）', async () => {
  const rejectingInFlight = {
    async assertExecutable() {
      throw new PrivacyError('OBJECT_UNAVAILABLE', OBJECT_UNAVAILABLE_MESSAGE);
    },
    async saveResult() {
      throw new PrivacyError('OBJECT_UNAVAILABLE', OBJECT_UNAVAILABLE_MESSAGE);
    },
  };

  await assert.rejects(
    () => assertExecutableOrWithdrawn(rejectingInFlight, withdrawnLedger('exp-a'), { id: 'exp-a', userId: 'user-1' }),
    (error) => {
      assert.equal(error.code, 'CONSENT_WITHDRAWN', '执行前重查被撤回拒绝 ⇒ CONSENT_WITHDRAWN');
      return true;
    },
  );

  await assert.rejects(
    () =>
      saveResultOrWithdrawn(rejectingInFlight, withdrawnLedger('exp-b'), {
        exportId: 'exp-b',
        userId: 'user-1',
        objectVersion: 1,
        result: { outcome: 'late' },
      }),
    (error) => {
      assert.equal(error.code, 'CONSENT_WITHDRAWN', '保存前重查被撤回拒绝 ⇒ CONSENT_WITHDRAWN');
      return true;
    },
  );

  // 负控制：同一个包装器，账本原因是取消 ⇒ 仍是 `OBJECT_UNAVAILABLE`（包装没放宽）
  await assert.rejects(
    () =>
      assertExecutableOrWithdrawn(
        rejectingInFlight,
        ledgerStub(async (id) => ({ id, state: 'failed', errorCode: 'OBJECT_CANCELLED' })),
        { id: 'exp-c', userId: 'user-1' },
      ),
    (error) => {
      assert.equal(error.code, 'OBJECT_UNAVAILABLE', '取消不得被包装器改写成撤回');
      return true;
    },
  );
});
