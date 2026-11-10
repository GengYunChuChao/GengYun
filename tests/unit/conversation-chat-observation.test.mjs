// GY-QA 观测 · 问答真实模型的**失败归因三项**（`finishReason` / `completionTokens` / `contentLength`）。
//
// 为什么单独一片：识别侧早有这三项读数（`recognitions/openai-vision-content.ts` 产出、
// `recognitions/observation-log.ts` 落日志），问答侧只落了 `prompt_tokens` / `completion_tokens` ——
// 于是「200 但正文为空」这种最需要归因的失败，日志里看不出是**预算被吃光**（`finish_reason=length`）
// 还是**供应商改了响应形状**（`stop` + 正文读不出）。本片把这三项补齐到同一套归因语言。
//
// 锁住四件事（每条都能静默做错）：
//   ① 三项都从 `choices[0]` / `usage` 取，**不**回传正文（只回长度）；
//   ② `contentLength = 0`（键在、值为空）与 `null`（形状读不出）**必须可区分** ——
//      前者是预算类，后者是结构类；混成一个值等于把两类故障归成同一类；
//   ③ 200 但正文为空时，**warn 日志**里必须有这三项（否则失败仍不可观测）；
//   ④ 成功路径同样落这三项，且日志里不出现正文/提问/密钥。
//
// 全部使用合成替身：没有真实模型调用、没有真实资料、没有真实外发。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrievalItem, retrievalSet } from './conversation-fixtures.mjs';
import { chatReadingsOf, createLiveChatComposer } from '../../services/api/src/ai/chat-live-adapter.ts';

const QUESTION = '稻田里的稗草怎么识别？';
const MODEL = 'synthetic-chat-model-observability';
/** 合成密钥：故意长得像真密钥，用来断言它不会出现在日志里（它不是任何真实凭据）。 */
const FAKE_KEY = 'sk-synthetic-obs-not-a-real-key-000000';
/** 合成正文：既用来算长度，也用来断言"日志里不出现正文"。 */
const TEXT = '稗草叶片光滑无毛[1]。';

const ITEM_A = retrievalItem({
  id: '2c0d4a30-6d9b-4f5b-9d70-5c1b2b0a7f11',
  title: '合成资料甲：稗草的识别（测试替身）',
  body: '稗草的识别要点：合成正文，仅用于回归，不含真实用量建议。',
});

const EGRESS_CONTEXT = {
  userId: 'user-1',
  authEpoch: 1,
  objectId: '5b0f4f4a-0000-4000-8000-000000000001',
  objectRevision: 1,
};

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

/** 外发口替身：只把 `call()` 跑起来（记账顺序由 `conversation-chat-live.test.mjs` §C 单独验证）。 */
function fakeEgress() {
  return {
    engaged: true,
    note: '测试替身外发口（只执行 call，不记账）',
    dataType: 'checked_content',
    async send(input) {
      return input.call();
    },
  };
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

/** 单次响应替身（`{status, body}`）；一次用例只发一次请求，所以不需要队列。 */
function singleFetch(response) {
  return async function fetchImpl() {
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

// ---------------------------------------------------------------------------
// ① 纯函数：三项读数
// ---------------------------------------------------------------------------

test('读数：正常响应 ⇒ 三项齐备，且只回长度、不回正文', () => {
  const readings = chatReadingsOf({
    choices: [{ message: { content: TEXT }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 40 },
  });
  assert.deepEqual(readings, { finishReason: 'stop', completionTokens: 40, contentLength: TEXT.length });
  // 12 = 8 个汉字 + `[1]` 三个字符 + 句号（UTF-16 码元数，与识别侧同口径）
  assert.equal(readings.contentLength, 12, 'UTF-16 码元数（与识别侧同口径）：整段正文 12 个字符');
  const dumped = JSON.stringify(readings);
  assert.equal(dumped.includes('稗草'), false, '读数不得携带正文，只许长度');
  assert.equal(dumped.includes('叶片'), false, '读数不得携带正文片段');
});

test('读数：200 但正文为空 ⇒ contentLength 为 0（键在、值为空），不是 null', () => {
  const readings = chatReadingsOf({ choices: [{ message: { content: '' }, finish_reason: 'length' }] });
  assert.equal(readings.finishReason, 'length', '预算被吃光的唯一指纹必须留下');
  assert.equal(
    readings.contentLength,
    0,
    '0 与 null 必须可区分：0 ＝ 键在但值为空（预算类），null ＝ 形状读不出（结构类）',
  );
  assert.equal(readings.completionTokens, null, '供应商没给 usage 就如实 null，不填 0 冒充');
});

test('读数：形状不认识 ⇒ 三项全 null，不猜、不抛', () => {
  const shapes = [
    null,
    undefined,
    {},
    { choices: [] },
    { choices: 'not-an-array' },
    { choices: [{ message: { content: 42 } }] },
    { choices: [{ message: { content: null }, finish_reason: 7 }] },
    { usage: { completion_tokens: 'many' } },
    'not-json',
  ];
  for (const shape of shapes) {
    assert.deepEqual(
      chatReadingsOf(shape),
      { finishReason: null, completionTokens: null, contentLength: null },
      `形状 ${JSON.stringify(shape)} 必须落成三项 null（不猜语义）`,
    );
  }
});

// ---------------------------------------------------------------------------
// ② 适配器：失败可观测（这一条就是"把判据改坏就红"的负控制）
// ---------------------------------------------------------------------------

test('适配器：200 但正文为空 ⇒ 契约既有码 PROVIDER_OUTCOME_UNKNOWN，warn 日志带三项归因', async () => {
  const log = logs();
  const composer = createLiveChatComposer({
    profile: profile(),
    egress: fakeEgress(),
    // 供应商给了 `finish_reason=length`，正文只剩空白（trim 后为空）—— 真实的"预算被吃光"形态。
    fetchImpl: singleFetch({
      status: 200,
      body: { choices: [{ message: { content: '   ' }, finish_reason: 'length' }], usage: { completion_tokens: 800 } },
    }),
    log,
  });

  await assert.rejects(
    () =>
      composer.compose({
        question: QUESTION,
        conditions: null,
        set: retrievalSet('user-1', [ITEM_A]),
        egress: EGRESS_CONTEXT,
      }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_OUTCOME_UNKNOWN', '200 不可解析沿用既有错误码族，不新造码');
      return true;
    },
  );

  const warns = log.payloads.filter((entry) => entry.level === 'warn');
  assert.equal(warns.length, 1, '失败必须留且只留一条 warn（静默失败等于不可观测）');
  assert.equal(warns[0].payload.finish_reason, 'length', 'warn 必须带 finishReason（这次是预算类）');
  assert.equal(warns[0].payload.content_length, 3, 'warn 必须带 contentLength：空白 3 字符 ⇒ 形状没问题、预算被吃光');
  assert.equal(warns[0].payload.completion_tokens, 800, 'warn 必须带 completionTokens');
  assert.equal(warns[0].payload.status, 200, 'warn 必须带状态码（200 也要留）');

  const reading = composer.lastReading();
  assert.equal(reading.outcome, 'failed');
  assert.equal(reading.finish_reason, 'length');
  assert.equal(reading.content_length, 3);

  const dumped = JSON.stringify(log.payloads);
  assert.equal(dumped.includes(FAKE_KEY), false, '日志不得回显密钥');
  assert.equal(dumped.includes(QUESTION), false, '日志不得回显提问正文');
});

// ---------------------------------------------------------------------------
// ③ 成功路径同样落三项，且不回显
// ---------------------------------------------------------------------------

test('适配器：成功外发 ⇒ info 日志与 lastReading 都带三项归因，且不含正文/密钥', async () => {
  const log = logs();
  const composer = createLiveChatComposer({
    profile: profile(),
    egress: fakeEgress(),
    fetchImpl: singleFetch({
      status: 200,
      body: {
        choices: [{ message: { content: TEXT }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 40 },
      },
    }),
    log,
  });

  const candidate = await composer.compose({
    question: QUESTION,
    conditions: null,
    set: retrievalSet('user-1', [ITEM_A]),
    egress: EGRESS_CONTEXT,
  });
  assert.match(candidate.text, /\[1\]/u, '正文必须保留引用编号');

  const info = log.payloads.find((entry) => entry.level === 'info');
  assert.ok(info, '成功路径必须留一条 info');
  assert.equal(info.payload.finish_reason, 'stop');
  assert.equal(info.payload.content_length, TEXT.length);
  assert.equal(info.payload.completion_tokens, 40);
  assert.equal(info.payload.prompt_tokens, 120);

  const reading = composer.lastReading();
  assert.equal(reading.outcome, 'answered');
  assert.equal(reading.finish_reason, 'stop');
  assert.equal(reading.content_length, TEXT.length);

  const dumped = JSON.stringify(log.payloads);
  assert.equal(dumped.includes('稗草'), false, '日志不得回显模型正文');
  assert.equal(dumped.includes(QUESTION), false, '日志不得回显用户提问正文');
  assert.equal(dumped.includes(FAKE_KEY), false, '日志不得回显密钥');
  assert.equal(dumped.includes('Bearer'), false, '日志不得出现授权头');
});

// ---------------------------------------------------------------------------
// ④ 无依据不外发时，三项如实为 null（不是 0 —— 从未外发过，没有 finish_reason）
// ---------------------------------------------------------------------------

test('适配器：无检索条目 ⇒ 不外发，三项归因如实 null（不是 0）', async () => {
  const log = logs();
  let called = 0;
  const composer = createLiveChatComposer({
    profile: profile(),
    egress: fakeEgress(),
    fetchImpl: async () => {
      called += 1;
      throw new Error('无依据时不得外发');
    },
    log,
  });

  const candidate = await composer.compose({
    question: QUESTION,
    conditions: null,
    set: retrievalSet('user-1', []),
    egress: EGRESS_CONTEXT,
  });

  assert.deepEqual(candidate, { text: '', citations: [], dose_cards: [] });
  assert.equal(called, 0, '无依据不得产生付费外发');
  const reading = composer.lastReading();
  assert.equal(reading.outcome, 'no_sources');
  assert.equal(reading.finish_reason, null, '从未外发 ⇒ null，不是任何 finish_reason');
  assert.equal(reading.content_length, null, '从未外发 ⇒ null，不是 0（0 会被读成"预算吃光的空正文"）');
  assert.deepEqual(log.payloads, [], '不外发就不该有外发读数');
});

// ---------------------------------------------------------------------------
// ⑤ 非 2xx 失败：状态码与失败类别都要进日志（否则"401 还是 429"永远查不出）
// ---------------------------------------------------------------------------

test('适配器：401 ⇒ 失败读数带真实状态码与既有错误码，且不重试（auth 不可重试）', async () => {
  const log = logs();
  let calls = 0;
  const composer = createLiveChatComposer({
    profile: profile({ maxRetries: 2 }),
    egress: fakeEgress(),
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    },
    log,
  });

  await assert.rejects(
    () =>
      composer.compose({
        question: QUESTION,
        conditions: null,
        set: retrievalSet('user-1', [ITEM_A]),
        egress: EGRESS_CONTEXT,
      }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE', '401/403 沿用既有码族：PROVIDER_UNAVAILABLE');
      assert.equal(error.retryable, false, '鉴权失败重试没有意义，必须如实不可重试');
      return true;
    },
  );

  assert.equal(calls, 1, 'auth 失败不得重试（maxRetries=2 也只打一次）');
  const warns = log.payloads.filter((entry) => entry.level === 'warn');
  assert.equal(warns.length, 1, '失败必须留且只留一条 warn');
  assert.equal(warns[0].payload.status, 401, '失败读数必须带真实状态码（不是 null）');
  assert.equal(warns[0].payload.code, 'PROVIDER_UNAVAILABLE', '失败读数必须带契约错误码，便于区分类别');
  assert.equal(warns[0].payload.attempts, 1);
  assert.equal(warns[0].payload.finish_reason, null, '没拿到 200 正文 ⇒ 三项如实 null，不猜');

  const reading = composer.lastReading();
  assert.equal(reading.outcome, 'failed');
  assert.equal(reading.status, 401);
  assert.equal(reading.finish_reason, null);
  assert.equal(reading.content_length, null);

  const dumped = JSON.stringify(log.payloads);
  assert.equal(dumped.includes(FAKE_KEY), false, '日志不得回显密钥');
  assert.equal(dumped.includes('invalid api key'), false, '日志不得把供应商错误正文带进来');
});
