// GY-R70（#12「问答与社区闭环」P1 第一项）·「文字问答 → 来源 → 失败恢复」的**可执行钉子**。
//
// 本文件不改任何产品行为，只把三件此前只能靠"读代码相信"的事变成断言，外加一条零外呼绊线：
//
//   A. **版本串可判定**：`unimplemented:no-real-` 前缀存在 ⇔ 装配结局是确定性摘录回答器。
//      两个方向都断言，并把派单点名的两种禁止情形逐条判零：
//        · 「带前缀但其实是真实模型」 —— 前缀存在时装配结局不得是 live，且本轮外发计数必须 0；
//        · 「不带前缀但其实不是真实模型」 —— 无前缀时本轮**要么**真发了一次模型且交付 `answered`，
//          **要么**一个模型产物都没交付（`insufficient`/`blocked`/`failed`/`timed_out`）。
//      两条**残余**都在 B6 里逐条登记（不是"允许"，是如实记账）：
//        ① **过报**（危险方向）：live 装配 + 本轮零外发 ⇒ 版本串写 `model/…`，但正文不是模型产物。
//           本文件断言它**永远不会伴随 `answered`**（可交付正文的粒度上判零）。
//        ② **欠报**（安全方向）：注入缝把真实适配器塞进 `composer` ⇒ 前缀仍在、正文却真的来自模型。
//           这是 NC2 有意的方向（注入者不得自封"真实模型"），生产装配**不可达**，见 B1b/B6。
//
//   B. **来源不得为空壳**：真实回答的每条引用必须与本次检索集合里那条来源**逐字段相同**
//      （契约 `SourceRef` 十键），且正文里的 `[n]` 编号能回指到它；摘录回答与真实回答在
//      `model_version` / `prompt_version` / 正文标记三处必须**可机器区分**。
//
//   C. **失败恢复矩阵**：超时 / 配额 / 协议违规 / 账本不可用四行，逐行断言作业封套的
//      `state` + `error_code` 与该码在契约里的状态码，并钉住**作业封套不承载 `retryable`**
//      这件事实（客户端只有 `state` + `error_code` 两个可判据字段）；`retryable` 只在
//      `ApiError` 层存在，这里按 `services/api/src/ai/error-map.ts` 的表逐条断言。
//
//   D. **零外呼**：无凭据时整条断言路径对非回环地址的 `globalThis.fetch` 调用计数必须是 0
//      （手法同 `tests/unit/ai-live-provider-wiring.test.mjs` 的 `tripwireFetch`；因为本文件要
//      真起回环 HTTP 夹具，绊线按「只拦非回环」实现，并用一条**正控制**证明它确实会响——
//      否则"计数 0"可能只是绊线没装上）。
//
// 全部离线：没有真实模型调用、没有真实资料、没有真实外发；密钥是合成占位串（故意长得像真的，
// 用来断言它不会出现在任何响应/日志里）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONVERSATIONS,
  JOBS,
  conversationFixture,
  loadSchema,
  retrievalItem,
  retrievalSet,
} from './conversation-fixtures.mjs';
import {
  ANSWER_MODEL_VERSION,
  ANSWER_PROMPT_VERSION,
  createConversationGuard,
  createConversationService,
  createDeterministicAnswerComposer,
} from '../../services/api/src/conversations/service.ts';
import { createWiredRetrievalPort } from '../../services/api/src/conversations/guard.ts';
import { createDeterministicDoseAuthority } from '../../services/api/src/conversations/dose.ts';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';
import { UNIMPLEMENTED_VERSION_PREFIX } from '../../services/api/src/conversations/types.ts';
import { planConversationChat } from '../../services/api/src/ai/chat-wiring.ts';
import {
  CHAT_MODEL_VERSION_PREFIX,
  CHAT_PROMPT_VERSION,
  chatModelVersion,
  createLiveChatComposer,
} from '../../services/api/src/ai/chat-live-adapter.ts';
import {
  CHAT_FAILURE_KINDS,
  chatFailure,
  chatFailureForStatus,
} from '../../services/api/src/ai/error-map.ts';
import { createChatEgress } from '../../services/api/src/privacy/task-egress.ts';
import { ERROR_STATUS_MAP } from '../../services/api/src/contract.ts';

const QUESTION = '稻田里的稗草怎么识别？';
const MODEL = 'synthetic-chat-model-1';
/** 合成密钥：**故意**长得像真密钥，用来断言它不会出现在响应/日志里（它不是任何真实凭据）。 */
const FAKE_KEY = 'sk-synthetic-r70-not-a-real-key-000000';

const ITEM = retrievalItem({
  id: '2c0d4a30-6d9b-4f5b-9d70-5c1b2b0a7f11',
  title: '合成资料甲：稗草的识别（测试替身）',
  body: '稗草的识别要点：合成正文，仅用于回归，不含真实用量建议。',
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

/** 外发口替身：只把 `call()` 跑起来（记账顺序由 `conversation-chat-live.test.mjs` §C 单独钉）。 */
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

/** 响应替身：队列消费；元素为 `{status, body}`、`'timeout'`（等 abort）或 `'bad_json'`。 */
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
    const payload = next === 'bad_json' ? '这不是 JSON{{{' : JSON.stringify(next.body ?? {});
    return new Response(payload, {
      status: next === 'bad_json' ? 200 : next.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function completion(content, usage = { prompt_tokens: 120, completion_tokens: 40 }) {
  return { status: 200, body: { choices: [{ message: { content }, finish_reason: 'stop' }], usage } };
}

function silentLog() {
  return { info() {}, warn() {} };
}

/** 带剧本的实时适配器（**真适配器**，只把 `fetch` 与账本换成替身）。 */
function liveComposer(script, { seen = [], egress = fakeEgress(), profileOverrides = {} } = {}) {
  return createLiveChatComposer({
    profile: profile(profileOverrides),
    egress,
    fetchImpl: scriptedFetch(script, seen),
    log: silentLog(),
  });
}

/**
 * 绊线：**只拦非回环**。
 *
 * 与 `tests/unit/ai-live-provider-wiring.test.mjs` 的 `tripwireFetch` 同一个手法，唯一差异是
 * 本文件要真起回环 HTTP 夹具（夹具自己的 `fetch` 也走 `globalThis.fetch`），所以放行
 * `127.0.0.1`/`localhost`/`[::1]`，把其余一切计入 `calls` 并抛错。
 *
 * ⚠ 适配器在**构造期**捕获 `globalThis.fetch`（`chat-live-adapter.ts` 的
 *   `const doFetch = deps.fetchImpl ?? globalThis.fetch`），所以绊线必须先装好再构造回答器。
 */
function tripwireNonLoopback() {
  const state = { calls: 0, urls: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/u.test(url)) return original(input, init);
    state.calls += 1;
    state.urls.push(url);
    throw new Error('TRIPWIRE_NON_LOOPBACK_NETWORK');
  };
  return {
    state,
    restore() {
      globalThis.fetch = original;
    },
  };
}

// ---------------------------------------------------------------------------
// 共用判据
// ---------------------------------------------------------------------------

const SOURCE_REF_REQUIRED = loadSchema('SourceRef').required;
const JOB_REQUIRED = loadSchema('Job').required;

/** 码 → 契约状态码（`ERROR_STATUS_MAP` 是唯一权威，不手抄）。 */
function statusOfCode(code) {
  for (const [status, codes] of Object.entries(ERROR_STATUS_MAP)) {
    if (codes.includes(code)) return Number(status);
  }
  return null;
}

/**
 * **过报**（危险方向）：版本串说"这是真实模型答的"，但本轮一次都没外发，却交付了 `answered`。
 * 这一条在任何装配结局下都必须为 false —— 客户端会据此把摘录当模型结论。
 */
function isOverClaim(answer, modelCalls) {
  if (answer === null) return false;
  return (
    !answer.model_version.startsWith(UNIMPLEMENTED_VERSION_PREFIX) &&
    modelCalls === 0 &&
    answer.status === 'answered'
  );
}

/**
 * **欠报**（安全方向）：前缀还在（说"未接真实模型"），但本轮其实外发了模型。
 * 生产装配不可达（`planConversationChat` 的 `injected` 分支只给 composer、不给 `answerVersions`）；
 * 只在"注入缝"这一条测试/装配专用通道上成立，且方向是安全的（客户端不会把摘录读成模型结果）。
 */
function isUnderClaim(answer, modelCalls) {
  if (answer === null) return false;
  return answer.model_version.startsWith(UNIMPLEMENTED_VERSION_PREFIX) && modelCalls > 0;
}

/** 回答的"出处形状"三分（本文件唯一的分类器；几条断言共用它，避免各写一套口径）。 */
function shapeOf(answer) {
  if (answer === null) return 'no-answer';
  const prefixed = answer.model_version.startsWith(UNIMPLEMENTED_VERSION_PREFIX);
  const bindsCitation = answer.prompt_version === CHAT_PROMPT_VERSION;
  const excerptMarker = answer.checked_text.includes('（未接真实模型·确定性检索结果·规则 ');
  if (prefixed && !bindsCitation && excerptMarker) return 'deterministic-excerpt';
  if (prefixed && !bindsCitation) return 'deterministic-prefix-only';
  if (!prefixed && bindsCitation) return 'live-wired';
  return 'inconsistent';
}

// ---------------------------------------------------------------------------
// A. 版本串可判定：`unimplemented:no-real-` 前缀 ⇔ 确定性摘录（plan 层穷举）
// ---------------------------------------------------------------------------

/** 注入覆盖用的最小回答器（结构合法即可：本例只判装配结局）。 */
const INJECTED = {
  kind: 'deterministic_guard_only',
  note: '负控制替身（注入覆盖）',
  compose: () => ({ text: '替身正文', citations: [], dose_cards: [] }),
};

/**
 * 四与门的**全交叉**：注入覆盖 × 是否配了模型 × 账本 × 在途守卫 × 执行模式 = 32 组。
 *
 * 穷举的理由：四门里有三门是"缺一个就该回落"的 fail-closed 判定，只测"四门全开"与"全关"
 * 两头会漏掉中间那 30 组（也正是历史上真出过事的地方 —— 配了模型却没有账本）。
 */
function gateMatrix() {
  const rows = [];
  for (const injectedComposer of [undefined, INJECTED]) {
    for (const chat of [null, profile()]) {
      for (const ledger of [null, { markSent: async () => ({}) }]) {
        for (const inFlight of [null, {}]) {
          for (const executionMode of ['real', 'stub']) {
            rows.push({
              label: `injected=${injectedComposer !== undefined} chat=${chat !== null} ledger=${ledger !== null} inflight=${inFlight !== null} mode=${executionMode}`,
              injectedComposer,
              chat,
              egressLedger: ledger,
              privacyInFlight: inFlight,
              executionMode,
            });
          }
        }
      }
    }
  }
  return rows;
}

function planOf(row) {
  return planConversationChat({
    ...(row.injectedComposer === undefined ? {} : { injectedComposer: row.injectedComposer }),
    chat: row.chat,
    executionMode: row.executionMode,
    egressLedger: row.egressLedger,
    privacyInFlight: row.privacyInFlight,
    log: silentLog(),
  });
}

test('A1 四与门闭式：live ⇔ 未注入 ∧ 配了模型 ∧ 账本与在途守卫都在 ∧ real（32 组穷举，逐组判）', () => {
  const rows = gateMatrix();
  assert.equal(rows.length, 32, `全交叉应有 32 组，实得 ${rows.length}`);

  for (const row of rows) {
    const plan = planOf(row);
    const expectedLive =
      row.injectedComposer === undefined &&
      row.chat !== null &&
      row.egressLedger !== null &&
      row.privacyInFlight !== null &&
      row.executionMode === 'real';

    assert.equal(plan.mode === 'live', expectedLive, `装配结局与四与门不一致：${row.label}（实得 ${plan.mode}）`);

    if (expectedLive) {
      assert.notEqual(plan.answerVersions, undefined, `live 必须给出版本串：${row.label}`);
      assert.equal(plan.egress?.engaged, true, `live 的外发口必须 engaged：${row.label}`);
      assert.equal(plan.composer.kind, 'live_model', `live 必须接真实模型回答器：${row.label}`);
      assert.deepEqual(plan.warnings, [], `四门全开不得留痕警告：${row.label}`);
    } else {
      assert.equal(plan.answerVersions, undefined, `非 live 不得给版本串覆盖：${row.label}`);
      assert.equal(plan.egress, null, `非 live 不得给外发口：${row.label}`);
      if (row.injectedComposer !== undefined) {
        assert.equal(plan.mode, 'injected', row.label);
        assert.equal(plan.composer, INJECTED, `注入覆盖必须原样使用：${row.label}`);
      } else {
        assert.equal(plan.mode, 'deterministic', row.label);
        assert.equal(plan.composer.kind, 'deterministic_guard_only', `非 live 必须是确定性回答器：${row.label}`);
      }
      // 留痕口径：只有"配了模型却接不上账本（或账本/在途守卫缺一）"那一种要 warn
      // ；非 real 模式是**正常结局**（演示模式本来就不该外发），不该刷警告。
      const expectWarning =
        row.injectedComposer === undefined && row.chat !== null && (row.egressLedger === null || row.privacyInFlight === null);
      assert.equal(plan.warnings.length, expectWarning ? 1 : 0, `警告条数口径：${row.label}`);
      if (expectWarning) assert.match(plan.warnings[0], /外发账本不可用/u, row.label);
    }
  }
});

test('A2 禁止情形判零：装配层既不存在「带前缀的 live」，也不存在「无前缀的非 live」', () => {
  const prefixButLive = [];
  const noPrefixButNotLive = [];

  for (const row of gateMatrix()) {
    const plan = planOf(row);
    // 服务层口径（`answerRowOf`）：只有装配层给了 `answerVersions` 才**不**带前缀。
    const carriesPrefix = plan.answerVersions === undefined;
    if (carriesPrefix && plan.mode === 'live') prefixButLive.push(row.label);
    if (!carriesPrefix && plan.mode !== 'live') noPrefixButNotLive.push(row.label);
    if (!carriesPrefix) {
      assert.equal(
        plan.answerVersions.model.startsWith(UNIMPLEMENTED_VERSION_PREFIX),
        false,
        `live 的 model 版本串不得带未实现前缀：${row.label}`,
      );
      assert.equal(plan.answerVersions.model.startsWith(CHAT_MODEL_VERSION_PREFIX), true, row.label);
      assert.equal(plan.answerVersions.prompt, CHAT_PROMPT_VERSION, row.label);
    }
  }

  assert.deepEqual(prefixButLive, [], '装配层出现「带前缀但其实是真实模型」的组合');
  assert.deepEqual(noPrefixButNotLive, [], '装配层出现「不带前缀但其实不是真实模型」的组合');
});

// ---------------------------------------------------------------------------
// B. 落库面：版本串 ⇔ 本轮是否真的问了模型（服务层，`answerVersions` 的注入缝）
// ---------------------------------------------------------------------------

function identityOf(userId) {
  return {
    userId,
    authEpoch: 1,
    role: 'user',
    sessionId: `synthetic-session-${userId}`,
    expiresAt: new Date(Date.now() + 3600_000),
    revision: 1,
    scopes: ['user'],
  };
}

/**
 * 直接构造服务层（**不经过 fastify**）。
 *
 * 为什么要这一层：`answerVersions` 只由装配层给（`app.ts` 的那一行），而 `live` 结局在 HTTP
 * 夹具里要求「真 PG 账本 + 持久会话 store」——本机没有 PG。版本串是在 `answerRowOf` 这一处
 * 盖进回答行的，所以直接在这一层喂 `answerVersions` 判"这枚章有没有说谎"，判据与生产同一行代码。
 */
function serviceHarness({ composer, answerVersions, items = [ITEM] } = {}) {
  const retrieval = createWiredRetrievalPort({
    note: '测试替身检索端口（不查资料库）',
    read: async (input) => retrievalSet(input.identity.userId, items),
  });
  return createConversationService({
    store: createMemoryConversationStore(),
    retrieval,
    guard: createConversationGuard({ dose: createDeterministicDoseAuthority() }),
    // 缺省就是基线确定性回答器（与 `app.ts` 在非 live 结局下注入的是同一个工厂）。
    composer: composer ?? createDeterministicAnswerComposer(),
    ...(answerVersions === undefined ? {} : { answerVersions }),
    signingKey: 'synthetic-signing-key-not-a-real-key',
  });
}

async function askThroughService(service, identity, tag = '1', text = QUESTION) {
  const created = await service.createConversation(identity, {}, { idempotencyKey: `idem-conv-${tag}` });
  assert.equal(created.status, 201, `建会话应 201：${JSON.stringify(created.data)}`);
  const conversationId = created.data.id;
  const accepted = await service.createTurn(
    { identity, token: 'synthetic-bearer-not-a-real-token' },
    conversationId,
    { input_type: 'text', text },
    { idempotencyKey: `idem-turn-${tag}`, ifMatch: '"1"' },
  );
  assert.equal(accepted.status, 202, `受理应 202：${JSON.stringify(accepted.data)}`);
  await service.drain();
  const found = await service.store.findTurnByJobId(accepted.data.id, identity.userId);
  assert.notEqual(found, null, '受理后的轮次必须能被作业读面反查到');
  return { job: service.jobViewOf(found.turn, found.answer), answer: found.answer };
}

const LIVE_VERSIONS = { model: chatModelVersion(MODEL), prompt: CHAT_PROMPT_VERSION };

test('B1 确定性路径：两串都带前缀、非回环外呼 0 次、正文与确定性回答器逐字相同', async () => {
  const trap = tripwireNonLoopback();
  try {
    const identity = identityOf('user-b1');
    // 服务层默认（不传 composer）= 确定性回答器；这条路线上没有任何外发点。
    const service = serviceHarness({});
    const { answer } = await askThroughService(service, identity, 'b1');

    assert.notEqual(answer, null);
    assert.equal(answer.model_version, ANSWER_MODEL_VERSION);
    assert.equal(answer.prompt_version, ANSWER_PROMPT_VERSION);
    assert.equal(answer.model_version.startsWith(UNIMPLEMENTED_VERSION_PREFIX), true);
    assert.equal(answer.prompt_version.startsWith(UNIMPLEMENTED_VERSION_PREFIX), true);
    // `rule_version` **任何**装配结局都带前缀（它描述的是引用/用量判定规则，永远不含模型成分）。
    assert.equal(answer.rule_version.startsWith(UNIMPLEMENTED_VERSION_PREFIX), true);
    assert.equal(shapeOf(answer), 'deterministic-excerpt');
    assert.equal(answer.status, 'answered');

    const expected = createDeterministicAnswerComposer().compose({
      question: QUESTION,
      conditions: null,
      set: retrievalSet(identity.userId, [ITEM]),
    });
    assert.equal(answer.checked_text, expected.text, '带前缀时正文必须就是确定性摘录的那一份（逐字节）');
    assert.equal(trap.state.calls, 0, `确定性路径不得产生任何非回环外呼：${trap.state.urls.join(',')}`);
    assert.equal(isOverClaim(answer, trap.state.calls), false);
    assert.equal(isUnderClaim(answer, trap.state.calls), false);
  } finally {
    trap.restore();
  }
});

test('B1b 注入缝的**已知欠报**（NC2 有意为之）：注入真实适配器 ⇒ 前缀仍在，但本轮确实外发了', async () => {
  const seen = [];
  const composer = liveComposer([completion('稗草叶片光滑无毛，可据此识别[1]。')], { seen });
  // 这条组合在生产装配里**不可达**（`planConversationChat` 的 `injected` 分支只给 composer、
  // 不给 `answerVersions`）；它是测试/装配注入专用的缝。这里把它钉住，而不是假装它不存在——
  // 假装的结果是：将来有人以为"有前缀就一定没联网"，据此做出错误的容量/成本判断。
  const service = serviceHarness({ composer, answerVersions: undefined });
  const { answer } = await askThroughService(service, identityOf('user-b1b'), 'b1b');

  assert.equal(seen.length, 1, '注入的真实适配器确实外发了');
  assert.equal(answer.checked_text.includes('稗草叶片光滑无毛'), true, '正文确实来自模型');
  assert.equal(answer.model_version, ANSWER_MODEL_VERSION, '但版本串仍写"未接真实模型"');
  assert.equal(answer.model_version.startsWith(UNIMPLEMENTED_VERSION_PREFIX), true);
  // 方向判定：这是**欠报**（把真实模型说成摘录），不是过报。客户端不会把摘录读成模型结果。
  assert.equal(isUnderClaim(answer, seen.length), true, '这条组合正是"带前缀但其实是真实模型"');
  assert.equal(isOverClaim(answer, seen.length), false, '欠报绝不允许变成过报');
});

test('B2 live 路径：版本串不带前缀、`citation-bind` 只在真实模型侧、本轮恰好外发一次', async () => {
  const seen = [];
  const composer = liveComposer([completion('稗草叶片光滑无毛，可据此识别[1]。')], { seen });
  const service = serviceHarness({ composer, answerVersions: LIVE_VERSIONS });
  const { answer } = await askThroughService(service, identityOf('user-b2'), 'b2');

  assert.notEqual(answer, null);
  assert.equal(answer.model_version, `${CHAT_MODEL_VERSION_PREFIX}${MODEL}#live-1`);
  assert.equal(answer.prompt_version, CHAT_PROMPT_VERSION);
  assert.equal(answer.model_version.startsWith(UNIMPLEMENTED_VERSION_PREFIX), false);
  assert.equal(answer.prompt_version.includes('citation-bind'), true, 'prompt 版本号必须点明它绑定的是引用规则');
  assert.equal(
    answer.rule_version.startsWith(UNIMPLEMENTED_VERSION_PREFIX),
    true,
    'rule_version 恒带前缀（不随 live 改变）',
  );
  assert.equal(shapeOf(answer), 'live-wired');
  assert.equal(answer.status, 'answered');
  assert.equal(seen.length, 1, 'live 且交付了模型正文 ⇒ 必须恰好一次外发');
  assert.equal(isOverClaim(answer, seen.length), false);
  assert.equal(isUnderClaim(answer, seen.length), false);
});

test('B3 live 装配但本轮零外发（检索集合为空）⇒ 只允许「非 answered」，过报判零', async () => {
  const seen = [];
  const composer = liveComposer([completion('不该被用到')], { seen });
  const service = serviceHarness({ composer, answerVersions: LIVE_VERSIONS, items: [] });
  const { answer } = await askThroughService(service, identityOf('user-b3'), 'b3');

  // 无依据 ⇒ 适配器**根本不外发**（`chat-live-adapter.ts` 的 no_sources 短路）。
  assert.equal(seen.length, 0, '检索集合为空时不得为了"问一句"而外发');
  assert.equal(answer.status, 'insufficient');
  assert.equal(answer.check_state, 'passed');
  assert.deepEqual(answer.citations, [], '资料不足不得凭空给引用');

  // 这里是"版本串仍写 model/…"的残余：**它不是模型产物**。钉成具名形态，并断言：
  //   · 正文是固定话术（一个模型片段都没有）；
  //   · 它不是 `answered` ⇒ 在"可交付正文"的粒度上，过报仍然判零。
  assert.equal(answer.model_version.startsWith(UNIMPLEMENTED_VERSION_PREFIX), false);
  assert.equal(shapeOf(answer), 'live-wired');
  assert.equal(answer.checked_text.includes('不该被用到'), false, '零外发时正文不得出现任何模型内容');
  assert.match(answer.checked_text, /^资料不足：/u, '零外发的 insufficient 必须是固定话术');
  assert.equal(isOverClaim(answer, seen.length), false, '版本串过报，但正文没过报（不是 answered）');
});

test('B4 出处分类器三形态：确定性摘录 / live 装配，一律不为 inconsistent', async () => {
  const shapes = [];
  for (const [tag, composer, versions, items] of [
    ['b4-det', undefined, undefined, [ITEM]],
    ['b4-live', liveComposer([completion('可据此识别[1]。')]), LIVE_VERSIONS, [ITEM]],
    ['b4-live-empty', liveComposer([completion('不该被用到')]), LIVE_VERSIONS, []],
  ]) {
    const service = serviceHarness({ composer, answerVersions: versions, items });
    const { answer } = await askThroughService(service, identityOf(`user-${tag}`), tag);
    const shape = shapeOf(answer);
    assert.notEqual(shape, 'inconsistent', `${tag} 的回答出处形状自相矛盾：${JSON.stringify(answer)}`);
    shapes.push(shape);
  }
  assert.deepEqual(shapes, ['deterministic-excerpt', 'live-wired', 'live-wired']);
  // 摘录与真实回答必须**可区分**：这一条如果哪天被改成"两边长得一样"，上面 B4/C4 会先红。
  assert.notEqual(shapes[0], shapes[1], '摘录回答与真实回答不得同形');
});

test('B6 汇总台账：过报恒 0；欠报只允许出现在注入缝（生产装配 32 组里一次都不出现）', () => {
  // ① 生产装配侧：`planConversationChat` 的 32 组里，"前缀 + 有外发可能"一次都不成立。
  for (const row of gateMatrix()) {
    const plan = planOf(row);
    const carriesPrefix = plan.answerVersions === undefined;
    // 有外发可能 ⇔ 外发口 engaged。
    const couldEgress = plan.egress !== null && plan.egress.engaged === true;
    assert.equal(
      carriesPrefix && couldEgress,
      false,
      `装配层出现过报：前缀存在却挂了 engaged 外发口（${row.label}）`,
    );
    // 反向：无前缀却没有任何外发口 ⇒ 这条装配在结构上不可能产生模型正文。
    assert.equal(
      !carriesPrefix && !couldEgress,
      false,
      `装配层出现欠报风险：无前缀却没有外发口（${row.label}）`,
    );
  }
  // ② 运行侧：欠报只在"注入真实适配器"这一条不可达组合上成立（B1b 已逐条断言）。
  assert.equal(
    shapeOf({
      model_version: ANSWER_MODEL_VERSION,
      prompt_version: ANSWER_PROMPT_VERSION,
      checked_text: 'x',
    }),
    'deterministic-prefix-only',
    '分类器的兜底形态必须稳定（不能因为正文标记缺失就落到 inconsistent）',
  );
});

// ---------------------------------------------------------------------------
// C. 来源不得为空壳
// ---------------------------------------------------------------------------

test('C1 真实回答的来源：逐字段等于本次检索集合那条来源，且正文的 `[n]` 能回指', async () => {
  const composer = liveComposer([completion('稗草叶片光滑无毛，可据此识别[1]。')]);
  const service = serviceHarness({ composer, answerVersions: LIVE_VERSIONS });
  const { answer } = await askThroughService(service, identityOf('user-c1'), 'c1');

  assert.equal(answer.status, 'answered');
  assert.equal(answer.citations.length, 1, '真实回答必须带至少一条可核验来源（不是空壳）');
  const citation = answer.citations[0];

  // ① 十键齐备且逐键等于**本次检索集合**里那条来源的十个值（不是"看起来像"）。
  assert.deepEqual(Object.keys(citation).sort(), [...SOURCE_REF_REQUIRED].sort(), '引用键集必须恰好是契约十键');
  assert.deepEqual(citation, ITEM.source, '引用必须逐字段等于本次检索集合里那条来源');
  for (const key of SOURCE_REF_REQUIRED) {
    assert.equal(typeof citation[key], 'string', `引用字段 ${key} 必须是字符串`);
    assert.notEqual(citation[key].length, 0, `引用字段 ${key} 不得为空（空壳引用无法核验）`);
  }
  assert.match(citation.url, /^https:\/\//u, '来源指向必须是可打开的 https 链接');
  assert.match(citation.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u, '来源 id 必须是 uuid');

  // ② 正文里的编号必须是**能回指到这条来源**的那个编号（[1] ↔ 集合第 1 条）。
  assert.match(answer.checked_text, /\[1\]/u);
  assert.equal(citation.id, ITEM.id, '正文 [1] 必须回指到集合第 1 条的来源 id');
});

test('C2 摘录回答的来源同样不得为空壳（两条路都逐字段可核验）', async () => {
  const { answer } = await askThroughService(serviceHarness({}), identityOf('user-c2'), 'c2');

  assert.equal(answer.status, 'answered');
  assert.equal(answer.citations.length, 1);
  assert.deepEqual(answer.citations[0], ITEM.source, '摘录回答的引用也必须逐字段等于集合内那条来源');
  for (const key of SOURCE_REF_REQUIRED) {
    assert.notEqual(answer.citations[0][key].length, 0, `摘录回答的引用字段 ${key} 不得为空`);
  }
});

test('C3 负控制：空壳引用进不了 answered（改写一个字段 / 集合外 id / 纯 https:// 空壳 三条）', async () => {
  const shellCases = [
    { name: '改写 url（其余九键照抄）', source: { ...ITEM.source, url: 'https://shell.invalid/not-the-same-source' } },
    { name: '集合外 id', source: { ...ITEM.source, id: '9f0a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b' } },
    { name: 'url 只有协议头（最典型的空壳）', source: { ...ITEM.source, url: 'https://' } },
  ];

  for (const [index, shell] of shellCases.entries()) {
    const composer = {
      kind: 'deterministic_guard_only',
      note: `空壳引用负控制（${shell.name}）`,
      compose: () => ({ text: '看起来像回答的一段话（空壳来源）。', citations: [shell.source], dose_cards: [] }),
    };
    const service = serviceHarness({ composer, items: [ITEM] });
    const { answer } = await askThroughService(service, identityOf('user-c3'), `c3-${index}`);

    assert.equal(answer.status, 'blocked', `空壳来源必须被守卫阻断（${shell.name}）`);
    assert.equal(answer.check_state, 'blocked');
    assert.deepEqual(answer.citations, [], `被拒的空壳来源不得以任何形式出现在引用里（${shell.name}）`);
    assert.equal(
      answer.checked_text.includes('看起来像回答的一段话'),
      false,
      `被拒正文一个片段都不得外露（${shell.name}）`,
    );
  }
});

test('C4 可区分性：同题同集合下，摘录与真实回答在三处判据上都不同（且都不会落在 inconsistent）', async () => {
  const deterministic = await askThroughService(serviceHarness({}), identityOf('user-c4'), 'c4-det');
  const live = await askThroughService(
    serviceHarness({
      composer: liveComposer([completion('稗草叶片光滑无毛，可据此识别[1]。')]),
      answerVersions: LIVE_VERSIONS,
    }),
    identityOf('user-c4-live'),
    'c4-live',
  );

  const extract = (answer) => ({
    modelPrefix: answer.model_version.startsWith(UNIMPLEMENTED_VERSION_PREFIX),
    promptVersion: answer.prompt_version,
    excerptMarker: answer.checked_text.includes('（未接真实模型·确定性检索结果·规则 '),
  });
  const left = extract(deterministic.answer);
  const right = extract(live.answer);

  assert.equal(left.modelPrefix, true);
  assert.equal(right.modelPrefix, false);
  assert.equal(left.excerptMarker, true, '摘录正文必须自带"未接真实模型"字样（客户端只看正文也能分辨）');
  assert.equal(right.excerptMarker, false);
  assert.notEqual(left.promptVersion, right.promptVersion);
  // `citation-bind` 只能出现在真实模型侧：这条把"引用绑定规则版本"绑死在 live 上。
  assert.equal(left.promptVersion.includes('citation-bind'), false);
  assert.equal(right.promptVersion.includes('citation-bind'), true);
});

// ---------------------------------------------------------------------------
// D. 失败恢复矩阵（超时 / 配额 / 协议违规 / 账本不可用）
// ---------------------------------------------------------------------------

test('D0 适配器层矩阵：每一个失败形态的 `error.code` 与 `retryable` 逐行按表断言', () => {
  // ① 传输/协议侧：HTTP 状态 → 失败形态（`chatFailureForStatus`）。
  const byStatus = [
    [401, 'PROVIDER_UNAVAILABLE', false, 'auth'],
    [403, 'PROVIDER_UNAVAILABLE', false, 'auth'],
    [408, 'PROVIDER_TIMEOUT', true, 'timeout'],
    [429, 'PROVIDER_QUOTA_EXCEEDED', true, 'rate_limited'],
    [400, 'PROVIDER_UNAVAILABLE', false, 'bad_request'],
    [404, 'PROVIDER_UNAVAILABLE', false, 'bad_request'],
    [413, 'PROVIDER_UNAVAILABLE', false, 'bad_request'],
    [415, 'PROVIDER_UNAVAILABLE', false, 'bad_request'],
    [422, 'PROVIDER_UNAVAILABLE', false, 'bad_request'],
    [500, 'PROVIDER_UNAVAILABLE', true, 'upstream_unavailable'],
    [502, 'PROVIDER_UNAVAILABLE', true, 'upstream_unavailable'],
    [503, 'PROVIDER_UNAVAILABLE', true, 'upstream_unavailable'],
  ];
  for (const [status, code, retryable, kind] of byStatus) {
    const failure = chatFailureForStatus(status);
    assert.equal(failure.code, code, `HTTP ${status} 的契约码`);
    assert.equal(failure.retryable, retryable, `HTTP ${status} 的 retryable`);
    assert.equal(failure.kind, kind, `HTTP ${status} 的失败形态`);
    assert.notEqual(statusOfCode(code), null, `${code} 必须在契约错误码闭集里`);
  }

  // ② 失败形态闭集（`error-map.ts` 的 FAILURES 表）：每一条都要能被单独说出来。
  const byKind = Object.fromEntries(CHAT_FAILURE_KINDS.map((kind) => [kind, chatFailure(kind)]));
  assert.deepEqual(Object.keys(byKind).sort(), [...CHAT_FAILURE_KINDS].sort());
  assert.deepEqual(
    [byKind.timeout.code, byKind.timeout.retryable],
    ['PROVIDER_TIMEOUT', true],
    '超时：可能已计费 ⇒ retryable true，但**适配器不重试**（见 D1）',
  );
  assert.deepEqual([byKind.rate_limited.code, byKind.rate_limited.retryable], ['PROVIDER_QUOTA_EXCEEDED', true]);
  assert.deepEqual([byKind.bad_response.code, byKind.bad_response.retryable], ['PROVIDER_OUTCOME_UNKNOWN', false]);
  assert.deepEqual([byKind.refused.code, byKind.refused.retryable], ['PROVIDER_UNAVAILABLE', false]);
  assert.deepEqual(
    [byKind.auth.code, byKind.auth.retryable],
    ['PROVIDER_UNAVAILABLE', false],
    '401/403 是配置问题，重试无意义',
  );
  for (const kind of CHAT_FAILURE_KINDS) {
    assert.notEqual(statusOfCode(byKind[kind].code), null, `失败形态 ${kind} 的码必须在闭集里`);
  }
});

test('D1 超时：适配器只发一次（不重试），作业落 timed_out + PROVIDER_TIMEOUT', async (t) => {
  const seen = [];
  const composer = liveComposer(['timeout'], { seen, profileOverrides: { timeoutMs: 20, maxRetries: 2 } });
  const fixture = await conversationFixture(t, { injection: { composer, ...retrievalWith([ITEM]) } });
  const conversationId = (await fixture.createConversation({}, { tag: 'd1' })).body.data.id;
  const job = await ask(fixture, conversationId, 'd1');

  assert.equal(seen.length, 1, `超时不得重试（可能已在供应商侧计费）：实发 ${seen.length} 次`);
  assert.equal(job.status, 200, '失败作业的读面仍是 200（不是 5xx）');
  assert.equal(job.data.state, 'timed_out');
  assert.equal(job.data.error_code, 'PROVIDER_TIMEOUT');
  assert.equal(statusOfCode('PROVIDER_TIMEOUT'), 504, '该码若走同步错误封套则是 504');
  assertJobShape(job.data);
});

test('D2 配额（429）：作业落 failed + PROVIDER_QUOTA_EXCEEDED（不折成"不可用"）', async (t) => {
  const composer = liveComposer([{ status: 429, body: {} }]);
  const fixture = await conversationFixture(t, { injection: { composer, ...retrievalWith([ITEM]) } });
  const conversationId = (await fixture.createConversation({}, { tag: 'd2' })).body.data.id;
  const job = await ask(fixture, conversationId, 'd2');

  assert.equal(job.data.state, 'failed');
  assert.equal(job.data.error_code, 'PROVIDER_QUOTA_EXCEEDED');
  assert.notEqual(job.data.error_code, 'PROVIDER_UNAVAILABLE', '配额不足不得被折成"供应商不可用"');
  assert.equal(statusOfCode('PROVIDER_QUOTA_EXCEEDED'), 429, '该码若走同步错误封套则是 429');
  assertJobShape(job.data);
});

test('D3 协议违规：200 但正文为空 / 200 但不是 JSON ⇒ failed + PROVIDER_OUTCOME_UNKNOWN', async (t) => {
  // 形态①：200 且 JSON 合法，但没有可用正文（供应商改了响应形状）。
  const emptySeen = [];
  const emptyComposer = liveComposer([{ status: 200, body: { choices: [] } }], { seen: emptySeen });
  const fixture = await conversationFixture(t, { injection: { composer: emptyComposer, ...retrievalWith([ITEM]) } });
  const conversationId = (await fixture.createConversation({}, { tag: 'd3' })).body.data.id;
  const job = await ask(fixture, conversationId, 'd3');

  assert.equal(emptySeen.length, 1);
  assert.equal(job.data.state, 'failed');
  assert.equal(job.data.error_code, 'PROVIDER_OUTCOME_UNKNOWN');
  assert.equal(statusOfCode('PROVIDER_OUTCOME_UNKNOWN'), 503, '该码若走同步错误封套则是 503');
  assertJobShape(job.data);

  // 形态②：200 但响应体不是 JSON。适配器把"不可解析"与"空正文"归到同一形态（`bad_response`）。
  const badSeen = [];
  const badComposer = liveComposer(['bad_json'], { seen: badSeen });
  const badFixture = await conversationFixture(t, { injection: { composer: badComposer, ...retrievalWith([ITEM]) } });
  const badConversation = (await badFixture.createConversation({}, { tag: 'd3b' })).body.data.id;
  const badJob = await ask(badFixture, badConversation, 'd3b');
  assert.equal(badSeen.length, 1);
  assert.equal(badJob.data.state, 'failed');
  assert.equal(badJob.data.error_code, 'PROVIDER_OUTCOME_UNKNOWN');
});

test('D4 账本不可用（运行期）：外发口拒绝 ⇒ 零外发 + failed/PROVIDER_UNAVAILABLE', async (t) => {
  // 真外发口 + 非 real 模式：`send` 在**任何账本变更之前**拒绝（fail-closed）。
  const egress = createChatEgress({ ledger: {}, inFlight: {}, executionMode: 'stub' });
  assert.equal(egress.engaged, false);
  const trap = tripwireNonLoopback();
  try {
    const composer = liveComposer([completion('不该被用到')], { egress });
    const fixture = await conversationFixture(t, { injection: { composer, ...retrievalWith([ITEM]) } });
    const conversationId = (await fixture.createConversation({}, { tag: 'd4' })).body.data.id;
    const job = await ask(fixture, conversationId, 'd4');

    assert.equal(trap.state.calls, 0, '账本不可用时一行请求都不许发出去（不得无账外发）');
    assert.equal(job.data.state, 'failed');
    assert.equal(job.data.error_code, 'PROVIDER_UNAVAILABLE');
    assert.equal(statusOfCode('PROVIDER_UNAVAILABLE'), 503);
    assertJobShape(job.data);
  } finally {
    trap.restore();
  }
});

test('D5 账本/凭据不可用（装配期）：没有错误码，只有版本串前缀 —— 这一形态被钉死', async (t) => {
  // 这一行是整个片子的靶心：**缺 CHAT_LLM_*（或配了模型但没账本）不产生任何错误码**，
  // HTTP 照常 202 → 200 succeeded，唯一的机器判据是 `model_version`/`prompt_version` 的前缀。
  const cases = [
    { name: '完全没配 CHAT_LLM_*', options: {} },
    { name: '配了模型但账本不可用', options: { chat: profile() } },
  ];

  for (const [index, entry] of cases.entries()) {
    const fixture = await conversationFixture(t, { ...entry.options, injection: retrievalWith([ITEM]) });
    const conversationId = (await fixture.createConversation({}, { tag: `d5-${index}` })).body.data.id;
    const job = await ask(fixture, conversationId, `d5-${index}`);

    assert.equal(job.status, 200);
    assert.equal(job.data.state, 'succeeded', `${entry.name}：作业必须成功（这不是错误，是降级）`);
    assert.equal(job.data.error_code, null, `${entry.name}：不得给出任何错误码（含 PROVIDER_UNAVAILABLE）`);
    const answer = job.data.result.value;
    assert.equal(answer.model_version, ANSWER_MODEL_VERSION, `${entry.name}：唯一判据就是版本串前缀`);
    assert.equal(answer.model_version.startsWith(UNIMPLEMENTED_VERSION_PREFIX), true);
    assert.equal(answer.prompt_version.startsWith(UNIMPLEMENTED_VERSION_PREFIX), true);
    assert.equal(shapeOf(answer), 'deterministic-excerpt');
  }
});

test('D6 作业封套不承载 `retryable`：客户端只有 `state` + `error_code` 两个可判据字段', async (t) => {
  const composer = liveComposer([{ status: 429, body: {} }]);
  const fixture = await conversationFixture(t, { injection: { composer, ...retrievalWith([ITEM]) } });
  const conversationId = (await fixture.createConversation({}, { tag: 'd6' })).body.data.id;
  const job = await ask(fixture, conversationId, 'd6');

  assert.equal(Object.prototype.hasOwnProperty.call(job.data, 'retryable'), false, 'Job 里没有 retryable 这个键');
  assertJobShape(job.data);
  // 也就是说：`retryable` 只活在 `ApiError` 上（D0 断言的那些值），异步面到不了客户端。
  // 客户端能用来判"要不要重试"的只有 state（timed_out vs failed）+ error_code。
  assert.equal(job.data.state, 'failed');
  assert.equal(job.data.error_code, 'PROVIDER_QUOTA_EXCEEDED');
});

// ---------------------------------------------------------------------------
// D 的共用夹具
// ---------------------------------------------------------------------------

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

/** 受理一轮（202）并读回作业封套（`GET /jobs/{id}` 的 200）——返回 `{status, data}`，与响应同形。 */
async function ask(fixture, conversationId, tag) {
  const read = await fixture.call('GET', `${CONVERSATIONS}/${conversationId}`);
  assert.equal(read.status, 200);
  const accepted = await fixture.createTurn(
    conversationId,
    read.body.data.revision,
    { input_type: 'text', text: QUESTION },
    { tag },
  );
  assert.equal(accepted.status, 202, `受理应 202：${JSON.stringify(accepted.body)}`);
  const job = await fixture.call('GET', `${JOBS}/${accepted.body.data.id}`);
  assert.equal(job.status, 200, `作业读面应 200：${JSON.stringify(job.body)}`);
  return { status: job.status, data: job.body.data };
}

/** 作业封套必须是契约 `Job` 的**恰好**九键（多一个 `retryable` 都算契约外字段）。 */
function assertJobShape(job) {
  assert.deepEqual(Object.keys(job).sort(), [...JOB_REQUIRED].sort(), 'Job 键集必须恰好是契约声明的九键');
}

// ---------------------------------------------------------------------------
// E. 零外呼
// ---------------------------------------------------------------------------

test('E1 零外呼：无凭据（没配 CHAT_LLM_*）时整条问答路径对非回环地址零调用', async (t) => {
  const trap = tripwireNonLoopback();
  try {
    const fixture = await conversationFixture(t, { injection: retrievalWith([ITEM]) });
    const conversationId = (await fixture.createConversation({}, { tag: 'e1' })).body.data.id;
    const job = await ask(fixture, conversationId, 'e1');

    assert.equal(job.data.state, 'succeeded');
    assert.equal(job.data.result.value.model_version, ANSWER_MODEL_VERSION);
    assert.equal(trap.state.calls, 0, `无凭据路径不得产生任何非回环外呼：${trap.state.urls.join(',')}`);
  } finally {
    trap.restore();
  }
});

test('E2 零外呼：配了模型但账本不可用 ⇒ 仍然一次都不发', async (t) => {
  const trap = tripwireNonLoopback();
  try {
    const fixture = await conversationFixture(t, { chat: profile(), injection: retrievalWith([ITEM]) });
    const conversationId = (await fixture.createConversation({}, { tag: 'e2' })).body.data.id;
    const job = await ask(fixture, conversationId, 'e2');

    assert.equal(job.data.state, 'succeeded');
    assert.equal(job.data.result.value.model_version, ANSWER_MODEL_VERSION);
    assert.equal(trap.state.calls, 0, `审计断裂时不得外发：${trap.state.urls.join(',')}`);
  } finally {
    trap.restore();
  }
});

test('E3 正控制：同一条绊线在 live 适配器接入时会响 —— 证明 E1/E2 的 0 不是"绊线没装上"', async (t) => {
  const trap = tripwireNonLoopback();
  try {
    // 这条适配器**不注入 `fetchImpl`** ⇒ 构造期回落到 `globalThis.fetch`（就是绊线装的地方）。
    // 其余用例都注入 `fetchImpl` 做脚本化响应，因此**只有这条**能证明绊线是活的。
    const composer = createLiveChatComposer({ profile: profile(), egress: fakeEgress(), log: silentLog() });
    const fixture = await conversationFixture(t, { injection: { composer, ...retrievalWith([ITEM]) } });
    const conversationId = (await fixture.createConversation({}, { tag: 'e3' })).body.data.id;
    const job = await ask(fixture, conversationId, 'e3');

    assert.equal(trap.state.calls, 1, `绊线必须恰好响一次：实得 ${trap.state.calls}`);
    assert.equal(trap.state.urls[0], profile().endpoint, '绊线抓到的必须是模型端点');
    // 绊线抛的是无 `code` 的普通 Error ⇒ 归到 transport（`PROVIDER_UNAVAILABLE`）。
    assert.equal(job.data.state, 'failed');
    assert.equal(job.data.error_code, 'PROVIDER_UNAVAILABLE');
    assert.equal(job.data.result, null, '被绊线拦下的外发不得产出任何回答');
  } finally {
    trap.restore();
  }
});

test('E4 零外呼：适配器自身"无依据不外发" —— 集合为空时连 live 适配器也不发', async (t) => {
  const trap = tripwireNonLoopback();
  try {
    // 同样**不注入 `fetchImpl`**：这条用例问的是"适配器有没有真的把请求发出去"，
    // 注入脚本化 fetch 会让计数恒 0（那样就测不到"删掉无依据短路"这种改动了）。
    const composer = createLiveChatComposer({ profile: profile(), egress: fakeEgress(), log: silentLog() });
    const fixture = await conversationFixture(t, { injection: { composer, ...retrievalWith([]) } });
    const conversationId = (await fixture.createConversation({}, { tag: 'e4' })).body.data.id;
    const job = await ask(fixture, conversationId, 'e4');

    assert.equal(trap.state.calls, 0, '无依据时不得花钱问模型"知不知道"');
    assert.equal(job.data.state, 'succeeded');
    assert.equal(job.data.result.value.status, 'insufficient');
    assert.deepEqual(job.data.result.value.citations, []);
  } finally {
    trap.restore();
  }
});
