// GY-R28 W7（#12）· 文字问答「接真实模型」的回归与**负控制**。
//
// 本文件锁住五件事（每一条都是"能静默做错"的方向）：
//   1) **四与门**：配置 / 外发账本 / 执行模式 / 注入覆盖 —— 任一不满足都必须落回基线确定性回答器，
//      且版本串仍是 `unimplemented:no-real-`（fail-closed 与 main 逐字节一致）；
//   2) **NC2 不破**：版本串由**装配层**填，回答器（可被任意注入）结构上拿不到这条通路 ——
//      注入的"真实模型"回答器也不能把自己标成真实模型；
//   3) **适配器的外发行为**：请求形状、引用只按 `[n]` 回填、无依据不外发、缺记账上下文拒绝外发、
//      失败映射到契约既有错误码、超时**不**重试（可能已计费）；正文里的越界编号/未检索链接
//      **整条不交付**（只丢结构化引用、正文照发 = 监工 1021-1806 [P1] 的那条泄漏路）；
//   4) **reserve-then-send 顺序**：预留 → 执行前重查 → `markSent` → 外发 → 保存前重查，失败只置终态；
//   5) **端到端**：注入一个异步真实模型回答器后，`composer.compose` 的 `await` 生效、引用由守卫复核，
//      越界（结构化或正文层面）一律阻断（守卫仍是唯一降级点）。
//
// 全部使用合成替身：**没有**真实模型调用、**没有**真实资料、**没有**真实外发。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONVERSATIONS, JOBS, conversationFixture, retrievalItem, retrievalSet } from './conversation-fixtures.mjs';
import { createWiredRetrievalPort } from '../../services/api/src/conversations/guard.ts';
import {
  ANSWER_MODEL_VERSION,
  ANSWER_PROMPT_VERSION,
  createDeterministicAnswerComposer,
} from '../../services/api/src/conversations/service.ts';
import { UNIMPLEMENTED_VERSION_PREFIX } from '../../services/api/src/conversations/types.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { buildApp } from '../../services/api/src/app.ts';
import { planConversationChat } from '../../services/api/src/ai/chat-wiring.ts';
import {
  CHAT_MODEL_VERSION_PREFIX,
  CHAT_PROMPT_VERSION,
  chatModelVersion,
  createLiveChatComposer,
} from '../../services/api/src/ai/chat-live-adapter.ts';
import { createChatEgress } from '../../services/api/src/privacy/task-egress.ts';

const QUESTION = '稻田里的稗草怎么识别？';
const MODEL = 'synthetic-chat-model-1';
/** 合成密钥：**故意**长得像真密钥，用来断言它不会出现在日志/错误里（它不是任何真实凭据）。 */
const FAKE_KEY = 'sk-synthetic-w7-not-a-real-key-000000';

const ITEM_A = retrievalItem({
  id: '2c0d4a30-6d9b-4f5b-9d70-5c1b2b0a7f11',
  title: '合成资料甲：稗草的识别（测试替身）',
  body: '稗草的识别要点：合成正文，仅用于回归，不含真实用量建议。',
});
const ITEM_B = retrievalItem({
  id: '7b3f0c11-8a1d-4e6f-9c22-6d4e8f0a1b33',
  title: '合成资料乙：千金子的防除（测试替身）',
  body: '千金子的防除要点：合成正文，仅用于回归，不含真实用量建议。',
});

function profile(overrides = {}) {
  return {
    endpoint: 'https://chat.invalid/v1/chat/completions',
    model: MODEL,
    timeoutMs: 2000,
    maxRetries: 0,
    apiKey: FAKE_KEY,
    ...overrides,
  };
}

/** 外发口替身：只把 `call()` 跑起来（真正的记账顺序由 §C 单独验证）。 */
function fakeEgress(overrides = {}) {
  const calls = [];
  return {
    engaged: true,
    note: '测试替身外发口（只执行 call，不记账）',
    dataType: 'checked_content',
    calls,
    async send(input) {
      calls.push(input);
      return input.call();
    },
    ...overrides,
  };
}

/** 响应替身：队列消费；元素为 `{status, body}` 或 `'timeout'`（永不结算，等 abort）。 */
function scriptedFetch(script, seen = []) {
  const queue = [...script];
  return async function fetchImpl(url, init) {
    seen.push({ url, init });
    const next = queue.shift();
    if (next === undefined) throw new Error('替身 fetch 被调用次数超出脚本（用例应显式给出每次响应）');
    if (next === 'timeout') {
      return await new Promise((resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('替身：超时中止');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function completion(content, usage = { prompt_tokens: 120, completion_tokens: 40 }) {
  return { status: 200, body: { choices: [{ message: { content }, finish_reason: 'stop' }], usage } };
}

function logs() {
  const payloads = [];
  return {
    payloads,
    info(payload, message) {
      payloads.push({ level: 'info', message, payload });
    },
    warn(payload, message) {
      payloads.push({ level: 'warn', message, payload });
    },
  };
}

const EGRESS_CONTEXT = { userId: 'user-1', authEpoch: 1, objectId: '5b0f4f4a-0000-4000-8000-000000000001', objectRevision: 1 };

// ---------------------------------------------------------------------------
// A. 四与门（装配决策，纯函数）
// ---------------------------------------------------------------------------

test('与门①：未配置问答模型 ⇒ 确定性回答器，不给版本串覆盖、无警告', () => {
  const plan = planConversationChat({
    chat: null,
    executionMode: 'real',
    egressLedger: {},
    privacyInFlight: {},
  });
  assert.equal(plan.mode, 'deterministic');
  assert.equal(plan.composer.kind, 'deterministic_guard_only');
  assert.equal(plan.answerVersions, undefined, '未配置不得给出模型版本串');
  assert.equal(plan.egress, null);
  assert.deepEqual(plan.warnings, []);
});

test('与门②：配了模型但没有外发账本 ⇒ 确定性回答器 + 一条留痕警告（审计断裂时不得外发）', () => {
  const plan = planConversationChat({
    chat: profile(),
    executionMode: 'real',
    egressLedger: null,
    privacyInFlight: {},
  });
  assert.equal(plan.mode, 'deterministic');
  assert.equal(plan.answerVersions, undefined);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /外发账本不可用/u);
});

test('与门③：配置与账本齐备但执行模式非 real ⇒ 确定性回答器（演示模式不产生真实外发）', () => {
  const plan = planConversationChat({
    chat: profile(),
    executionMode: 'stub',
    egressLedger: {},
    privacyInFlight: {},
  });
  assert.equal(plan.mode, 'deterministic');
  assert.equal(plan.answerVersions, undefined);
  assert.deepEqual(plan.warnings, []);
});

test('与门④：注入覆盖优先（即使四门全开也不接真实模型；注入者拿不到版本串 → NC2）', () => {
  const injected = {
    kind: 'deterministic_guard_only',
    note: '负控制替身',
    compose: () => ({ text: '替身正文', citations: [], dose_cards: [] }),
  };
  const plan = planConversationChat({
    injectedComposer: injected,
    chat: profile(),
    executionMode: 'real',
    egressLedger: {},
    privacyInFlight: {},
  });
  assert.equal(plan.mode, 'injected');
  assert.equal(plan.composer, injected);
  assert.equal(plan.answerVersions, undefined, '注入的回答器不得把自己标成真实模型');
  assert.equal(plan.egress, null);
});

test('四门全开：mode=live，外发口 engaged，版本串由装配层给出（model/… + prompt/citation-bind/1）', () => {
  const plan = planConversationChat({
    chat: profile(),
    executionMode: 'real',
    egressLedger: { markSent: async () => ({}) },
    privacyInFlight: {},
  });
  assert.equal(plan.mode, 'live');
  assert.equal(plan.composer.kind, 'live_model');
  assert.equal(plan.egress?.engaged, true);
  assert.equal(plan.answerVersions.model, `${CHAT_MODEL_VERSION_PREFIX}${MODEL}#live-1`);
  assert.equal(plan.answerVersions.prompt, CHAT_PROMPT_VERSION);
  // 契约上限 80：真实模型名再长也不得越界。
  const long = planConversationChat({
    chat: profile({ model: 'm'.repeat(200) }),
    executionMode: 'real',
    egressLedger: { markSent: async () => ({}) },
    privacyInFlight: {},
  });
  assert.ok(long.answerVersions.model.length <= 80, `版本串必须 ≤80：${long.answerVersions.model.length}`);
  assert.equal(long.answerVersions.model.startsWith(UNIMPLEMENTED_VERSION_PREFIX), false);
});

test('四门全开 + 假账本：模型名被喂进外发口 ⇒ provider_invocations.model_version 写 chatModelVersion(model)（不再恒 NULL）', async () => {
  // 缺陷原状（R72 recon #12 候选 A）：装配层明明知道模型名（同一个 `planConversationChat` 里
  // `answerVersions.model` 就在用 `input.chat.model`），却没把它传给 `createChatEgress`
  // ⇒ `task-egress.ts:331-332` 拿不到 `model` ⇒ `provider_invocations.model_version` 恒 `NULL`。
  // 本用例的唯一判据不是"参数看着传了"，而是**真外发一次**后，账本 `recordInvocation` 收到的那一行
  // 里 `modelVersion` 必须等于 `chatModelVersion(本次配置的模型名)`（真源
  // `chat-live-adapter.ts:61-63`，不抄字符串；`#live-1` 后缀也由它给出）。
  const invocations = [];
  const events = [];
  const ledger = {
    resolveRecipient: async () => 'recipient-llm-1',
    reserve: async (input) => {
      events.push('reserve');
      return { id: 'export-w26-1', userId: input.userId, objectRevision: input.objectRevision, jobId: null };
    },
    markSent: async (id) => {
      events.push('markSent');
      return { id, userId: 'user-1', objectRevision: 1, jobId: 'job-w26-1' };
    },
    markFailed: async () => {
      events.push('markFailed');
    },
    recordInvocation: async (input) => {
      events.push('recordInvocation');
      invocations.push(input);
      return { ...input, attempt: invocations.length };
    },
  };
  const inFlight = {
    assertExecutable: async () => {
      events.push('assertExecutable');
    },
    saveResult: async () => {
      events.push('saveResult');
    },
  };

  const plan = planConversationChat({
    chat: profile(),
    executionMode: 'real',
    egressLedger: ledger,
    privacyInFlight: inFlight,
    fetchImpl: scriptedFetch([completion('稗草叶片光滑无毛[1]。')]),
  });

  assert.equal(plan.mode, 'live', '四与门全开必须落 live');
  assert.equal(plan.answerVersions.model, chatModelVersion(MODEL), '回答行版本串取 chatModelVersion(模型名)');
  assert.equal(plan.egress?.engaged, true);

  // 走生产回答器（而不是直接调 egress）：证明真实外发链路喂到账本的也是同一个模型名。
  const candidate = await plan.composer.compose({
    question: QUESTION,
    conditions: null,
    set: retrievalSet('user-1', [ITEM_A, ITEM_B]),
    egress: EGRESS_CONTEXT,
  });
  assert.deepEqual(candidate.citations.map((citation) => citation.id), [ITEM_A.id]);

  assert.deepEqual(events, ['reserve', 'assertExecutable', 'markSent', 'recordInvocation', 'saveResult']);
  assert.equal(invocations.length, 1, '一次外发只许一行调用记录');
  const row = invocations[0];
  assert.equal(row.capability, 'llm');
  assert.equal(row.promptVersion, CHAT_PROMPT_VERSION, 'prompt_version 取 live 适配器常量（不经装配层）');
  // 这一行就是缺陷本身：装配层不喂 `model` 时它是 `null`（反向控制 NC1 的可判据读数）。
  assert.equal(row.modelVersion, chatModelVersion(MODEL), 'model_version 必须是 chatModelVersion(模型名)，不是 NULL');
  assert.equal(row.modelVersion, `${CHAT_MODEL_VERSION_PREFIX}${MODEL}#live-1`, '形状：model/<model>#live-1');
  assert.deepEqual(plan.egress.invocationReadings(), { written: 1, failed: 0, lastError: null });
});

// ---------------------------------------------------------------------------
// B. 适配器：外发行为
// ---------------------------------------------------------------------------

test('适配器：请求形状正确（POST + Bearer + 温度 0 + 非流式），日志不回显密钥/正文', async () => {
  const seen = [];
  const log = logs();
  const composer = createLiveChatComposer({
    profile: profile(),
    egress: fakeEgress(),
    fetchImpl: scriptedFetch([completion('稗草叶片光滑无毛[1]。')], seen),
    log,
  });
  const candidate = await composer.compose({
    question: QUESTION,
    conditions: null,
    set: retrievalSet('user-1', [ITEM_A, ITEM_B]),
    egress: EGRESS_CONTEXT,
  });

  assert.equal(seen.length, 1, '一次回答只发一次请求');
  const request = seen[0];
  assert.equal(request.url, profile().endpoint);
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.authorization, `Bearer ${FAKE_KEY}`, '密钥只能走请求头，不进 URL/正文');
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, MODEL);
  assert.equal(body.temperature, 0, '问答必须确定性优先');
  assert.equal(body.stream, false, '一次一结算，便于 reserve-then-send');
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[1].content, /\[1\]/u, '提示里必须给条目编号（引用只能按编号回填）');
  assert.match(body.messages[1].content, new RegExp(QUESTION, 'u'));
  assert.equal(body.messages.length, 2, '无追问上下文时不应塞历史');

  assert.deepEqual(candidate.citations.map((citation) => citation.id), [ITEM_A.id]);
  assert.deepEqual(candidate.dose_cards, [], '用量卡只能来自确定性权威路径，模型不得产出');

  const dumped = JSON.stringify(log.payloads);
  assert.equal(dumped.includes(FAKE_KEY), false, '日志不得回显密钥');
  assert.equal(dumped.includes('Bearer'), false, '日志不得出现授权头');
  assert.equal(dumped.includes('稗草叶片光滑无毛'), false, '日志不得回显模型正文');
  assert.equal(dumped.includes(QUESTION), false, '日志不得回显用户提问正文');
  assert.match(dumped, /prompt_tokens/u, '日志必须留下可核对的 token 读数');
});

test('适配器：引用只认本次送出的编号；正文越界（[9]/[0]）⇒ 正文不交付、越界项可判据', async () => {
  const log = logs();
  const composer = createLiveChatComposer({
    profile: profile(),
    egress: fakeEgress(),
    fetchImpl: scriptedFetch([completion('先看[1]，再看[2]，重复[1]，越界[9]，还有[0]。')]),
    log,
  });
  const candidate = await composer.compose({
    question: QUESTION,
    conditions: null,
    set: retrievalSet('user-1', [ITEM_A, ITEM_B]),
    egress: EGRESS_CONTEXT,
  });
  // 结构侧：合法编号仍按 [n] 回填、重复去重（这一条是既有契约，不因返修改动）。
  assert.deepEqual(candidate.citations.map((citation) => citation.id), [ITEM_A.id, ITEM_B.id]);
  // 正文侧：越界编号 ⇒ **整条正文不交付**（只把结构丢掉、正文照发 = 把集合外引用展示给用户）。
  assert.equal(candidate.text, '', '正文含越界编号时不得交付正文');
  assert.deepEqual(
    candidate.text_violations,
    ['citation_marker_out_of_range:[9]', 'citation_marker_out_of_range:[0]'],
    '越界项必须可判据地报出来（不是静默 continue）',
  );
  const dumped = JSON.stringify(log.payloads);
  assert.equal(dumped.includes('越界[9]'), false, '日志不得回显模型正文');
  assert.equal(dumped.includes('先看'), false, '日志不得回显模型正文');
  assert.equal(
    log.payloads.some((entry) => entry.payload.text_violations === 2),
    true,
    '日志必须留下越界条数读数',
  );
});

test('适配器：检索集合为空 ⇒ 根本不外发（不让模型去说"不知道"），读数记为 no_sources', async () => {
  const seen = [];
  const composer = createLiveChatComposer({
    profile: profile(),
    egress: fakeEgress(),
    fetchImpl: scriptedFetch([], seen),
  });
  const candidate = await composer.compose({
    question: QUESTION,
    conditions: null,
    set: retrievalSet('user-1', []),
    egress: EGRESS_CONTEXT,
  });
  assert.equal(seen.length, 0, '无依据时不得产生任何外发');
  assert.equal(candidate.text, '');
  assert.deepEqual(candidate.citations, []);
  assert.equal(composer.lastReading().outcome, 'no_sources');
});

test('适配器：缺外发记账上下文 ⇒ 拒绝外发（错误码在契约闭集内）', async () => {
  const seen = [];
  const composer = createLiveChatComposer({
    profile: profile(),
    egress: fakeEgress(),
    fetchImpl: scriptedFetch([completion('不该到这里')], seen),
  });
  await assert.rejects(
    () => composer.compose({ question: QUESTION, conditions: null, set: retrievalSet('user-1', [ITEM_A]) }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.equal(seen.length, 0, '缺记账上下文时一行请求都不许发出去');
});

test('适配器：供应商失败映射到契约既有错误码（401/403/429/500/503/400/413），且不回显响应正文', async () => {
  const cases = [
    [401, 'PROVIDER_UNAVAILABLE', false],
    [403, 'PROVIDER_UNAVAILABLE', false],
    [429, 'PROVIDER_QUOTA_EXCEEDED', true],
    [500, 'PROVIDER_UNAVAILABLE', true],
    [503, 'PROVIDER_UNAVAILABLE', true],
    [400, 'PROVIDER_UNAVAILABLE', false],
    [413, 'PROVIDER_UNAVAILABLE', false],
  ];
  for (const [status, code, retryable] of cases) {
    const composer = createLiveChatComposer({
      profile: profile(),
      egress: fakeEgress(),
      fetchImpl: scriptedFetch([{ status, body: { error: { message: '供应商内部细节，不得外泄' } } }]),
    });
    await assert.rejects(
      () => composer.compose({ question: QUESTION, conditions: null, set: retrievalSet('user-1', [ITEM_A]), egress: EGRESS_CONTEXT }),
      (error) => {
        assert.equal(error.code, code, `HTTP ${status} 应映射为 ${code}，实得 ${error.code}`);
        assert.equal(error.retryable, retryable, `HTTP ${status} 的 retryable 口径`);
        assert.equal(error.message.includes('供应商内部细节'), false, '错误消息不得回显供应商正文');
        return true;
      },
    );
  }
});

test('适配器：429 按 maxRetries 重试一次即成功；读数记 attempts=2', async () => {
  const seen = [];
  const composer = createLiveChatComposer({
    profile: profile({ maxRetries: 1 }),
    egress: fakeEgress(),
    fetchImpl: scriptedFetch([{ status: 429, body: {} }, completion('重试后成功[1]。')], seen),
  });
  const candidate = await composer.compose({
    question: QUESTION,
    conditions: null,
    set: retrievalSet('user-1', [ITEM_A]),
    egress: EGRESS_CONTEXT,
  });
  assert.equal(seen.length, 2, '429 属于"明确拒绝且未产出 token"，允许重试一次');
  assert.equal(candidate.text, '重试后成功[1]。');
  assert.equal(composer.lastReading().attempts, 2);
});

test('适配器：超时 ⇒ PROVIDER_TIMEOUT 且**不**重试（可能已计费，重试等于重复外发）', async () => {
  const seen = [];
  const composer = createLiveChatComposer({
    profile: profile({ timeoutMs: 20, maxRetries: 2 }),
    egress: fakeEgress(),
    fetchImpl: scriptedFetch(['timeout', completion('不该被用到')], seen),
  });
  await assert.rejects(
    () => composer.compose({ question: QUESTION, conditions: null, set: retrievalSet('user-1', [ITEM_A]), egress: EGRESS_CONTEXT }),
    (error) => error.code === 'PROVIDER_TIMEOUT',
  );
  assert.equal(seen.length, 1, `超时不得重试：实发 ${seen.length} 次`);
});

test('适配器：5xx 重试耗尽后仍失败（attempts 用尽即停，不无限重试）', async () => {
  const seen = [];
  const composer = createLiveChatComposer({
    profile: profile({ maxRetries: 2 }),
    egress: fakeEgress(),
    fetchImpl: scriptedFetch(
      [{ status: 500, body: {} }, { status: 500, body: {} }, { status: 502, body: {} }],
      seen,
    ),
  });
  await assert.rejects(
    () => composer.compose({ question: QUESTION, conditions: null, set: retrievalSet('user-1', [ITEM_A]), egress: EGRESS_CONTEXT }),
    (error) => error.code === 'PROVIDER_UNAVAILABLE',
  );
  assert.equal(seen.length, 3, '1 次首发 + maxRetries=2');
});

// ---------------------------------------------------------------------------
// C. 外发口：reserve-then-send 顺序与失败处置
// ---------------------------------------------------------------------------

function ledgerSpy(events = []) {
  return {
    resolveRecipient: async () => 'recipient-llm-1',
    reserve: async (input) => {
      events.push({ step: 'reserve', input });
      return { id: 'export-1', userId: input.userId, objectRevision: input.objectRevision };
    },
    markSent: async (id) => {
      events.push({ step: 'markSent', id });
      return { id, userId: 'user-1', objectRevision: 1 };
    },
    markFailed: async (id, extra) => {
      events.push({ step: 'markFailed', id, ...extra });
    },
    guardWriteback: async () => ({}),
  };
}

function inFlightSpy(events = []) {
  return {
    assertExecutable: async (input) => {
      events.push({ step: 'assertExecutable', input });
    },
    saveResult: async (input) => {
      events.push({ step: 'saveResult', input });
    },
  };
}

test('外发口：非 real 模式在**任何**账本变更之前拒绝（零预留、零外发）', async () => {
  const events = [];
  const egress = createChatEgress({
    ledger: ledgerSpy(events),
    inFlight: inFlightSpy(events),
    executionMode: 'stub',
  });
  assert.equal(egress.engaged, false);
  await assert.rejects(
    () =>
      egress.send({
        userId: 'user-1',
        authEpoch: 1,
        objectId: 'abc',
        objectRevision: 1,
        call: async () => 'x',
        outcomeOf: () => ({ kind: 'answered' }),
      }),
    (error) => error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === false,
  );
  assert.deepEqual(events, [], '替身/演示模式下不得留下任何账本痕迹');
});

test('外发口：成功路径严格按 reserve → assertExecutable → markSent → call → saveResult 顺序', async () => {
  const events = [];
  const egress = createChatEgress({
    ledger: ledgerSpy(events),
    inFlight: inFlightSpy(events),
    executionMode: 'real',
  });
  assert.equal(egress.engaged, true);
  const result = await egress.send({
    userId: 'user-1',
    authEpoch: 1,
    objectId: '5B0F4F4A-0000-4000-8000-000000000008',
    objectRevision: 3,
    call: async () => {
      events.push({ step: 'call' });
      return { status: 'answered' };
    },
    outcomeOf: () => ({ kind: 'answered' }),
  });
  assert.deepEqual(result, { status: 'answered' });
  assert.deepEqual(events.map((event) => event.step), ['reserve', 'assertExecutable', 'markSent', 'call', 'saveResult']);
  const reserved = events[0].input;
  // GY-R35 二轮（监工 R1）：外发对象**保真轮次身份** —— 一次问答外发记的是轮次，
  // 类型 `conversation_turn` 已作为契约 `TargetRef.type` 成员（16 → 17 值），
  // id 是裸轮次 uuid（不带 `turn:` 前缀，`object_key` 就是 `object_ref.id`，上限 80），
  // revision 是轮次 revision ⇒ 类型/标识/版本三者指向同一实体。
  assert.equal(reserved.objectType, 'conversation_turn');
  assert.equal(reserved.objectKey, '5b0f4f4a-0000-4000-8000-000000000008');
  assert.equal(reserved.dataType, 'checked_content');
  assert.equal(reserved.purpose, 'external_inference');
  assert.equal(reserved.recipientId, 'recipient-llm-1');
  assert.equal(reserved.objectRevision, 3);
  // 账本只收结构分类 token（不含正文/用量明细）。
  assert.deepEqual(events.at(-1).input.result, { kind: 'answered' });
  assert.equal(events.at(-1).input.objectVersion, 1);
});

test('外发口：外发失败 ⇒ markFailed（不写回写表）并原样重抛', async () => {
  const events = [];
  const egress = createChatEgress({ ledger: ledgerSpy(events), inFlight: inFlightSpy(events), executionMode: 'real' });
  await assert.rejects(
    () =>
      egress.send({
        userId: 'user-1',
        authEpoch: 1,
        objectId: '5b0f4f4a-0000-4000-8000-000000000009',
        objectRevision: 1,
        call: async () => {
          const error = new Error('上游超时');
          error.code = 'PROVIDER_TIMEOUT';
          throw error;
        },
        outcomeOf: () => ({ kind: 'answered' }),
      }),
    (error) => error.code === 'PROVIDER_TIMEOUT',
  );
  assert.deepEqual(events.map((event) => event.step), ['reserve', 'assertExecutable', 'markSent', 'markFailed']);
  assert.equal(events.at(-1).errorCode, 'PROVIDER_TIMEOUT', '账本要记真实失败码，不能一律落 PROVIDER_UNAVAILABLE');
  assert.equal(events.some((event) => event.step === 'saveResult'), false, '失败不得写回写表');
});

// ---------------------------------------------------------------------------
// D. 配置搬运：密钥只从 env 读、缺省 null、半配置即启动失败
// ---------------------------------------------------------------------------

test('配置：未配置 ⇒ chatProvider === null（不猜端点、不猜模型）', () => {
  // 用 `stub` 模式：本用例只关心 `chatProvider` 的解析，不重复验证 `real` 模式的必需凭据清单
  // （那由 config 既有套件覆盖）；问答配置的解析与执行模式无关。
  const config = loadConfig({ APP_EXECUTION_MODE: 'stub' });
  assert.equal(config.chatProvider, null);
});

test('配置：齐备 ⇒ 解析出 chat；端点规范化去尾斜杠；密钥只在内存字段里', () => {
  const config = loadConfig({
    APP_EXECUTION_MODE: 'stub',
    CHAT_LLM_ENDPOINT: 'https://chat.invalid/v1/chat/completions/',
    CHAT_LLM_MODEL: MODEL,
    CHAT_LLM_API_KEY: FAKE_KEY,
    CHAT_LLM_TIMEOUT_MS: '15000',
    CHAT_LLM_MAX_RETRIES: '1',
  });
  assert.equal(config.chatProvider.endpoint, 'https://chat.invalid/v1/chat/completions');
  assert.equal(config.chatProvider.model, MODEL);
  assert.equal(config.chatProvider.timeoutMs, 15000);
  assert.equal(config.chatProvider.maxRetries, 1);
  assert.equal(config.chatProvider.apiKey, FAKE_KEY);
});

test('配置：`DEEPSEEK_API_KEY` 作为密钥替代口径（与既有取证脚本一致）', () => {
  const config = loadConfig({
    APP_EXECUTION_MODE: 'stub',
    CHAT_LLM_ENDPOINT: 'https://chat.invalid/v1/chat/completions',
    CHAT_LLM_MODEL: MODEL,
    DEEPSEEK_API_KEY: FAKE_KEY,
  });
  assert.equal(config.chatProvider.apiKey, FAKE_KEY);
});

test('配置：半配置 / 非法端点 / 越界数值 ⇒ 启动即失败（不静默降级到无模型）', () => {
  const base = { APP_EXECUTION_MODE: 'stub' };
  const half = [
    { ...base, CHAT_LLM_ENDPOINT: 'https://chat.invalid/v1/chat/completions' }, // 缺模型与密钥
    { ...base, CHAT_LLM_ENDPOINT: 'https://chat.invalid/v1/chat/completions', CHAT_LLM_MODEL: MODEL }, // 缺密钥
    { ...base, CHAT_LLM_ENDPOINT: 'https://chat.invalid/v1/chat/completions', CHAT_LLM_API_KEY: FAKE_KEY }, // 缺模型
    { ...base, CHAT_LLM_ENDPOINT: 'http://chat.invalid/v1', CHAT_LLM_MODEL: MODEL, CHAT_LLM_API_KEY: FAKE_KEY }, // 非 https
    {
      ...base,
      CHAT_LLM_ENDPOINT: 'https://chat.invalid/v1',
      CHAT_LLM_MODEL: MODEL,
      CHAT_LLM_API_KEY: FAKE_KEY,
      CHAT_LLM_TIMEOUT_MS: '10',
    },
    {
      ...base,
      CHAT_LLM_ENDPOINT: 'https://chat.invalid/v1',
      CHAT_LLM_MODEL: MODEL,
      CHAT_LLM_API_KEY: FAKE_KEY,
      CHAT_LLM_MAX_RETRIES: '9',
    },
  ];
  for (const env of half) {
    assert.throws(() => loadConfig(env), `这组配置必须启动失败：${JSON.stringify(Object.keys(env))}`);
  }
});

// ---------------------------------------------------------------------------
// E. 端到端（回环 HTTP）：负控制 + await 生效 + 守卫仍是唯一降级点
// ---------------------------------------------------------------------------

/** 检索替身：固定来源，记录检索入参（不查资料库）。 */
function retrievalWith(items, seen = []) {
  return {
    retrieval: createWiredRetrievalPort({
      note: '测试替身检索端口（不查资料库）',
      read: async (input) => {
        seen.push(input);
        return retrievalSet(input.identity.userId, items);
      },
    }),
  };
}

async function askAndReadAnswer(fixture, tag) {
  const created = await fixture.createConversation({}, { tag });
  const conversationId = created.body.data.id;
  const read = await fixture.call('GET', `${CONVERSATIONS}/${conversationId}`);
  const accepted = await fixture.createTurn(
    conversationId,
    read.body.data.revision,
    { input_type: 'text', text: QUESTION },
    { tag },
  );
  assert.equal(accepted.status, 202, `受理应 202：${JSON.stringify(accepted.body)}`);
  const job = await fixture.call('GET', `${JOBS}/${accepted.body.data.id}`);
  assert.equal(job.status, 200, `读取任务应 200：${JSON.stringify(job.body)}`);
  return job.body.data.result.value;
}

test('负控制（未配置）：回答版本串与 main 一致，正文与确定性回答器逐字相同', async (t) => {
  const fixture = await conversationFixture(t, { injection: retrievalWith([ITEM_A]) });
  const answer = await askAndReadAnswer(fixture, 'w7-off');

  assert.equal(answer.model_version, ANSWER_MODEL_VERSION);
  assert.equal(answer.prompt_version, ANSWER_PROMPT_VERSION);
  for (const value of [answer.model_version, answer.prompt_version, answer.rule_version]) {
    assert.ok(value.startsWith(UNIMPLEMENTED_VERSION_PREFIX), `版本串必须带未接真实模型前缀：${value}`);
  }
  // 与"直接调用确定性回答器"逐字比对：未配置时 HTTP 面的正文必须就是它产出的那一份。
  const expected = createDeterministicAnswerComposer().compose({
    question: QUESTION,
    conditions: null,
    set: retrievalSet(fixture.a.user.id, [ITEM_A]),
  });
  assert.equal(answer.checked_text, expected.text, '未配置时回答正文必须与基线确定性回答器逐字一致');
  assert.deepEqual(answer.citations.map((citation) => citation.id), [ITEM_A.id]);
});

test('负控制（配了模型但账本不可用）：仍走确定性回答器并留痕警告，不外发', async (t) => {
  const chunks = [];
  const fixture = await conversationFixture(t, {
    chat: profile(),
    logLevel: 'warn',
    logStream: {
      write(chunk) {
        chunks.push(String(chunk));
      },
    },
    injection: retrievalWith([ITEM_A]),
  });
  const answer = await askAndReadAnswer(fixture, 'w7-noledger');
  assert.equal(answer.model_version, ANSWER_MODEL_VERSION);
  assert.equal(answer.prompt_version, ANSWER_PROMPT_VERSION);
  assert.match(chunks.join(''), /外发账本不可用/u, '配置了模型却接不上账本必须有留痕');
});

test('注入真实模型回答器（异步）：await 生效，引用按 [n] 绑定，版本串仍由装配层缺省（NC2）', async (t) => {
  const seen = [];
  const composer = createLiveChatComposer({
    profile: profile(),
    egress: fakeEgress(),
    fetchImpl: scriptedFetch([completion('稗草叶片光滑无毛，可据此识别[1]。')], seen),
  });
  const fixture = await conversationFixture(t, { injection: { composer, ...retrievalWith([ITEM_A, ITEM_B]) } });
  const answer = await askAndReadAnswer(fixture, 'w7-live');

  assert.equal(seen.length, 1, '异步回答器必须真的被调用一次');
  assert.equal(answer.status, 'answered');
  assert.match(answer.checked_text, /稗草叶片光滑无毛/u, '回答正文必须来自模型候选（经守卫复核后落库）');
  assert.deepEqual(answer.citations.map((citation) => citation.id), [ITEM_A.id]);
  // 注入路径下版本串由装配层缺省 ⇒ 仍是未接真实模型口径（注入者不得自封真实模型）。
  assert.equal(answer.model_version, ANSWER_MODEL_VERSION);
  assert.equal(answer.prompt_version, ANSWER_PROMPT_VERSION);
});

test('适配器：正文里的链接必须能在本次检索集合里找到出处（虚构链接 ⇒ 不交付）', async () => {
  const composeWith = (content, items) => {
    const composer = createLiveChatComposer({
      profile: profile(),
      egress: fakeEgress(),
      fetchImpl: scriptedFetch([completion(content)]),
    });
    return composer.compose({
      question: QUESTION,
      conditions: null,
      set: retrievalSet('user-1', items),
      egress: EGRESS_CONTEXT,
    });
  };

  // ① 集合外链接（监工复现里的 fabricated.invalid）⇒ 正文不交付，违规项可判据。
  const fabricated = await composeWith('来源[1] https://fabricated.invalid/not-in-retrieval；另见[1]。', [ITEM_A]);
  assert.equal(fabricated.text, '', '正文含未检索链接时不得交付正文');
  assert.deepEqual(fabricated.text_violations, ['unattributed_url:https://fabricated.invalid/not-in-retrieval']);

  // ② 正控制：链接就是本次来源自带的 url ⇒ 不算违规（不得为堵漏而误杀合法引用）。
  const grounded = await composeWith('依据[1]，来源页 https://example.invalid/gengyun/synthetic-source 。', [ITEM_A]);
  assert.equal(grounded.text_violations, undefined, '有出处的链接不得被当成越界');
  assert.match(grounded.text, /https:\/\/example\.invalid\/gengyun\/synthetic-source/u);

  // ③ 正控制：链接逐字出现在某条来源**正文**里 ⇒ 同样算有出处（确定性回答器会原样搬资料原文）。
  const ITEM_C = retrievalItem({
    id: '9f0a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b',
    title: '合成资料丙：带链接的识别要点（测试替身）',
    body: '识别要点：合成正文见 https://docs.invalid/synthetic-note 。',
  });
  const fromBody = await composeWith('识别要点见 https://docs.invalid/synthetic-note [1]。', [ITEM_C]);
  assert.equal(fromBody.text_violations, undefined, '资料原文里出现过的链接有出处');
});

test('注入真实模型回答器：只引越界编号 ⇒ 正文不展示、回答阻断（守卫仍是唯一降级点）', async (t) => {
  // 期望从 `insufficient` 收紧为 `blocked`：返修后"只有越界编号"不再只是"没有引用 ⇒ 资料不足"，
  // 而是**越界即阻断**——这正是监工 [P1] 要求的方向（越界内容一律不得到达用户）。
  const composer = createLiveChatComposer({
    profile: profile(),
    egress: fakeEgress(),
    fetchImpl: scriptedFetch([completion('据资料[9]，可直接混配。')]),
  });
  const fixture = await conversationFixture(t, { injection: { composer, ...retrievalWith([ITEM_A]) } });
  const answer = await askAndReadAnswer(fixture, 'w7-oob');

  assert.deepEqual(answer.citations, [], '越界编号不得变成引用');
  assert.equal(answer.status, 'blocked', '越界正文必须整条阻断，不得把模型正文当成回答展示');
  assert.equal(answer.check_state, 'blocked');
  assert.equal(answer.checked_text.includes('[9]'), false, '用户可见正文不得含越界编号');
  assert.equal(answer.checked_text.includes('混配'), false, '模型正文（含危险措辞）一个片段都不得外露');
  assert.match(answer.checked_text, /输出守卫阻断/u);
});

test('监工 1021-1806 [P1]：正文里的集合外编号 + 虚构链接 ⇒ 整条阻断（不洗白、不原样展示）', async (t) => {
  // 监工复现场景逐字复刻：检索集合只有 1 条合法合成来源，模型正文同时含 [99]（不存在编号）、
  // 集合外 URL 与一个合法 [1]。返修前的行为：只把 [1] 回填成 citations，正文（含 [99] 与
  // fabricated.invalid）原样落 `answered/passed`。
  const composer = createLiveChatComposer({
    profile: profile(),
    egress: fakeEgress(),
    fetchImpl: scriptedFetch([completion('来源[99] https://fabricated.invalid/not-in-retrieval；另见[1]。')]),
  });
  const fixture = await conversationFixture(t, { injection: { composer, ...retrievalWith([ITEM_A]) } });
  const answer = await askAndReadAnswer(fixture, 'w7-oob-99');

  assert.equal(answer.status, 'blocked', `越界正文必须被阻断，不得 answered：${JSON.stringify(answer)}`);
  assert.equal(answer.check_state, 'blocked');
  assert.deepEqual(answer.citations, [], '被拒正文不得再挂一份"看起来合法"的引用（否则等于洗白）');
  assert.deepEqual(answer.dose_cards, [], '被拒正文不得带用量卡');
  assert.equal(answer.checked_text.includes('[99]'), false, '用户可见正文不得含集合外编号');
  assert.equal(answer.checked_text.includes('fabricated.invalid'), false, '用户可见正文不得含虚构链接');
  assert.equal(answer.checked_text.includes('另见'), false, '被拒正文一个片段都不得泄漏');
  assert.match(answer.checked_text, /输出守卫阻断/u);
  // 持久层同样不得留下越界正文/虚构链接（"展示层过滤"不算修好）。
  const stored = JSON.stringify(fixture.conversationStore.snapshot().answers[0]);
  assert.equal(stored.includes('fabricated.invalid'), false, '持久层不得留下虚构链接');
  assert.equal(stored.includes('[99]'), false, '持久层不得留下集合外编号');
});

test('正控制：正文链接有出处时照常交付（不因返修而误杀合法回答）', async (t) => {
  const composer = createLiveChatComposer({
    profile: profile(),
    egress: fakeEgress(),
    fetchImpl: scriptedFetch([completion('稗草叶片光滑无毛，识别要点见[1] https://example.invalid/gengyun/synthetic-source 。')]),
  });
  const fixture = await conversationFixture(t, { injection: { composer, ...retrievalWith([ITEM_A]) } });
  const answer = await askAndReadAnswer(fixture, 'w7-grounded-url');

  assert.equal(answer.status, 'answered', `有出处的链接不得被阻断：${JSON.stringify(answer)}`);
  assert.match(answer.checked_text, /https:\/\/example\.invalid\/gengyun\/synthetic-source/u);
  assert.deepEqual(answer.citations.map((citation) => citation.id), [ITEM_A.id]);
});

test('适配器：正文里的登记证号必须能在本次检索集合里找到出处（编造的证号 ⇒ 不交付正文）', async () => {
  const composeWith = (content, items) => {
    const composer = createLiveChatComposer({
      profile: profile(),
      egress: fakeEgress(),
      fetchImpl: scriptedFetch([completion(content)]),
    });
    return composer.compose({
      question: QUESTION,
      conditions: null,
      set: retrievalSet('user-1', items),
      egress: EGRESS_CONTEXT,
    });
  };

  // 带登记证号的来源：号码写在 body 首行（真实资料同一形态，见 records.mjs 的 buildKnowledgeBody）。
  const ITEM_NUMBERED = retrievalItem({
    id: '3d2c1b0a-9f8e-4d7c-8b6a-5f4e3d2c1b0a',
    title: '合成资料戊：带登记证号的识别要点（测试替身）',
    body: '登记证号：PD20161371\n识别要点：合成正文，仅用于回归，不含真实用量建议。',
  });

  // T1 集合内号码 ⇒ 不算违规（不得为堵漏误杀"照搬资料原文"的正文）。
  const grounded = await composeWith('登记证号 PD20161371，识别要点见[1]。', [ITEM_NUMBERED]);
  assert.equal(grounded.text_violations, undefined, '有出处的登记证号不得被当成越界');
  assert.match(grounded.text, /PD20161371/u);

  // T2 集合外号码（模型编的）⇒ 正文不交付，违规项可判据（与 `unattributed_url:…` 同型）。
  const fabricated = await composeWith('登记证号 PD20991234 可湿性粉剂，识别要点见[1]。', [ITEM_NUMBERED]);
  assert.equal(fabricated.text, '', '正文含未背书登记证号时不得交付正文');
  assert.deepEqual(fabricated.text_violations, ['unattributed_registration_number:PD20991234']);

  // T3 张冠李戴：号码真实存在，但属于不在本次送出的条目 ⇒ 同样未背书。
  const borrowed = await composeWith('登记证号 PD20211218 适用[1]。', [ITEM_NUMBERED]);
  assert.equal(borrowed.text, '');
  assert.deepEqual(borrowed.text_violations, ['unattributed_registration_number:PD20211218']);

  // T4 边界：`XPD20161371` / `PD201613710` 都不算号码 ⇒ 不算违规。
  const boundary = await composeWith('XPD20161371 与 PD201613710 都不是证号形态[1]。', [ITEM_NUMBERED]);
  assert.equal(boundary.text_violations, undefined, '粘连字母/多一位数字的串不得被误判成证号');
});

test('注入真实模型回答器：编造登记证号 ⇒ 整条阻断（用户可见正文与持久层都不得留下该号码）', async (t) => {
  const composer = createLiveChatComposer({
    profile: profile(),
    egress: fakeEgress(),
    fetchImpl: scriptedFetch([completion('登记证号 PD20991234 可湿性粉剂，可直接混用[1]。')]),
  });
  const fixture = await conversationFixture(t, { injection: { composer, ...retrievalWith([ITEM_A]) } });
  const answer = await askAndReadAnswer(fixture, 'w28-regnum');

  assert.equal(answer.status, 'blocked', `未背书证号必须整条阻断：${JSON.stringify(answer)}`);
  assert.equal(answer.check_state, 'blocked');
  assert.deepEqual(answer.citations, [], '被拒正文不得再挂引用');
  assert.deepEqual(answer.dose_cards, []);
  assert.equal(answer.checked_text.includes('PD20991234'), false, '用户可见正文不得含编造的证号');
  assert.equal(answer.checked_text.includes('混用'), false, '被拒正文一个片段都不得外露');
  // 阻断话术点名了"登记证号"（与 URL/引用同一句，不加任何可机器判别的细分原因）。
  assert.match(answer.checked_text, /输出守卫阻断/u);
  assert.match(answer.checked_text, /登记证号/u);
  // 持久层同样不得留下编造的证号（"展示层过滤"不算修好）。
  const stored = JSON.stringify(fixture.conversationStore.snapshot().answers[0]);
  assert.equal(stored.includes('PD20991234'), false, '持久层不得留下编造的登记证号');
});

test('注入真实模型回答器：本次检索集合为 null ⇒ 仍是"资料不足"，不被新判据改道成 blocked', async (t) => {
  const seen = [];
  const composer = createLiveChatComposer({
    profile: profile(),
    egress: fakeEgress(),
    fetchImpl: scriptedFetch([completion('登记证号 PD20991234 可以直接用。')], seen),
  });
  const fixture = await conversationFixture(t, {
    injection: {
      composer,
      retrieval: createWiredRetrievalPort({
        note: '测试替身检索端口（返回 null = 本次没有检索到任何资料）',
        read: async () => null,
      }),
    },
  });
  const answer = await askAndReadAnswer(fixture, 'w28-regnum-noset');

  assert.equal(answer.status, 'insufficient', `set=null 仍须是资料不足：${JSON.stringify(answer)}`);
  assert.equal(answer.check_state, 'passed');
  assert.match(answer.checked_text, /资料不足/u);
  assert.equal(seen.length, 0, 'set=null 时根本不得外发（省掉一次无意义付费调用）');
});

test('回归：既有精简 config（未走 loadConfig、缺 chatProvider）⇒ 按未配置处理，装配不崩', async () => {
  // 既有测试（如 tests/unit/api-health.test.mjs）直接构造精简 config 对象，缺 `chatProvider`。
  // 问答接线不得因此抛错：缺它必须等价于「未配置」⇒ 不接真实模型、不崩溃。
  const { chatProvider: _ignored, ...lean } = loadConfig({ APP_EXECUTION_MODE: 'stub' });
  const app = buildApp({ config: { ...lean, executionMode: 'real', databaseUrl: null } });
  try {
    // 装配不崩即为本测试的主判据；再用一条问答路由证明路由表已建好（未登录 ⇒ 401）。
    const res = await app.inject({ method: 'GET', url: `${CONVERSATIONS}?limit=1` });
    assert.equal(res.statusCode, 401, '问答路由必须已注册（未登录 ⇒ 401 SESSION_REQUIRED）');
    assert.equal(res.json().error.code, 'SESSION_REQUIRED');
  } finally {
    await app.close();
  }
});
