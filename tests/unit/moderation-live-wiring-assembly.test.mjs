/**
 * GY-R70 · 审核域真实端口 `liveWiring` 的**生产装配**回归（`services/api/src/app.ts` 的决定点）。
 *
 * 断点（基线 `53354fe7` 的代码事实，逐条可复核）：
 *   - `services/api/src/moderation/service.ts:134` 有 `liveWiring?: ModerationLiveWiring`；
 *     `:453-455` 的注释写着「real：**永不**回退替身。有凭据且显式打开（`liveWiring`）⇒ 用真实端口
 *     走完整服务」，实现是 `deps.liveWiring === undefined ? null : createLiveModerationPortsFromWiring(...)`；
 *   - `git grep -n liveWiring -- services/api/src` 只命中 `moderation/service.ts` 三处 ⇒
 *     **生产装配从不传它** ⇒ `real` 下审核整域恒 503。
 *
 * 本片把它接上（`moderation/live-assembly.ts` 的决定点 + `app.ts` 的一处转发），本文件钉住：
 *
 * | 臂 | 执行模式 | 凭据 | 显式批准 | 期望 |
 * |---|---|---|---|---|
 * | A | `real` | 齐备 | 已铸造 | **传** `liveWiring` ⇒ 审核域 `capabilities()` 两端口 `wired/ready` |
 * | B | `real` | 缺失 | 已铸造 | **不传** ⇒ 整域 503 `PROVIDER_UNAVAILABLE`（`retryable:false`） |
 * | C | `stub` | 环境里有 | 已铸造 | **不传** ⇒ 既有替身端口（`substitute`，绝不 `wired`） |
 * | D | `real` | 齐备 | 缺失/伪造 | **不传** ⇒ 同上 503 |
 *
 * 另外三条钉子：
 *   ⑤ **零外呼绊线**：整条装配路径（`loadConfig` + `buildApp` × 四臂）`globalThis.fetch` 计数必须是 `0`。
 *      手法同 `tests/unit/ai-live-provider-wiring.test.mjs` 的头注：把 `globalThis.fetch` 换成计数器，
 *      任何一次真实外呼都会让计数 > 0 ⇒ 立刻矛盾（构造期就该零发包）。
 *   ⑥ **等价性**：不满足条件时，B/D 的对外错误与**改前逐字段相同**——改前 `app.ts` 调的是
 *      `createModerationService({ executionMode:'real' })`（不传 `liveWiring`），这里直接拿那个调用
 *      做对照，断言 `{code, message, retryable}` 三者相等（不是凭印象写死字符串）。
 *   ⑦ **拒因可判定**：拒绝描述对外仍是既有契约码 `PROVIDER_UNAVAILABLE`（503），原因码留在
 *      `details[].code` 里且仍是既有闭集 `MODEL_NOT_EVALUATED`（⛔ 它不是 HTTP 错误码）。
 *   ⑧ **批准能力不可伪造**：形状相同的字面量、`Object.create` 派生、克隆副本一律无效（对象身份判定）。
 *   ⑨ **判据不得被注释骗过**：⑧ 的「去注释」不是一行惰性正则，而是 `tools/lib/strip-comments.mjs`
 *      的状态机。注释正文里写 `services/api/src/**` 这种 glob，**不得**让判据把它当成注释开头、
 *      一路吃掉其后的真实代码（误红＝合法调用点被吞，假绿＝违规写法被吞）。⑨ 用两棵合成树先红后绿钉住。
 *
 * 全部**离线**：不读凭据文件、不联网、不写台账；凭据与 BizType 都是明显合成的占位串。
 * ⛔ 本文件**不**证明审核策略有效、**不**证明违规样本会被拦、**不**证明真实供应商可接受这份剖面——
 * 那需要真实凭据与真实付费调用，本片明确不做（见证据页「没证明什么」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createModerationService } from '../../services/api/src/moderation/service.ts';
import {
  MODERATION_LIVE_REFUSAL_REASON_CODE,
  MODERATION_LIVE_REFUSAL_REASONS,
  approveModerationLiveWiring,
  isModerationLiveWiringApproved,
  resolveModerationLiveWiring,
} from '../../services/api/src/moderation/live-assembly.ts';
import { createLiveModerationPortsFromWiring } from '../../services/api/src/moderation/live-wiring.ts';
import {
  MODERATION_VENDOR_ACTIONS,
  MODERATION_VENDOR_ENDPOINTS,
} from '../../services/api/src/moderation/live-ports.ts';
import { isModelFailureReasonCode, isModelReasonCode } from '../../packages/moderation/model-reason-codes.mjs';
// 去注释的**唯一**口径：`tools/lib/strip-comments.mjs` 的状态机（保留行号）。
// ⛔ 不要在本文件里重写 `/\/\*[\s\S]*?\*\//` 那种一行正则——见 ⑨ 的回归用例。
import { occurrencesWithLines, stripComments } from '../../tools/lib/strip-comments.mjs';

const ROOT = resolve(import.meta.dirname, '../..');

// ---------------------------------------------------------------- 合成夹具

const SECRET_ID = 'AKIDR70SYNTHETICONLYNOTAREALKEYID';
const SECRET_KEY = 'r70-synthetic-secret-key-do-not-log-do-not-commit';
const BIZ_TYPE = 'r70synth';
const POLICY_SOURCE = 'r70-synthetic-policy-source-not-a-real-console-review';

const SYNTHETIC_CREDENTIALS = Object.freeze({
  secretId: SECRET_ID,
  secretKey: SECRET_KEY,
  sessionToken: '',
});

/**
 * `real` 模式的其余必填项（与 `tests/unit/tts-synthesis-media-wiring.test.mjs` 的 `realEnv()` 同形的
 * 合成占位，**不是**任何真实凭据；`DATABASE_URL` 指向永不可达的合成库，本文件从不连它）。
 */
function realEnv(overrides = {}) {
  return {
    APP_EXECUTION_MODE: 'real',
    LOG_LEVEL: 'warn',
    DATABASE_URL: 'postgres://synthetic_local_only@127.0.0.1:5432/gengyun_synthetic_never_connected',
    SESSION_SIGNING_KEY: 'synthetic-not-a-real-signing-key',
    DELETION_LEDGER_KEY: 'synthetic-not-a-real-ledger-key',
    WECHAT_APP_ID: 'synthetic-not-a-real-appid',
    WECHAT_APP_SECRET: 'synthetic-not-a-real-appsecret',
    OBJECT_STORAGE_ENDPOINT: 'https://storage.example.test',
    OBJECT_STORAGE_BUCKET: 'gy-media',
    OBJECT_STORAGE_ACCESS_KEY: 'AKIDR70SYNTHETICSTORAGEONLY',
    OBJECT_STORAGE_SECRET_KEY: 'r70-synthetic-storage-secret-do-not-log',
    OBJECT_STORAGE_REGION: 'ap-shanghai',
    OBJECT_STORAGE_FORCE_PATH_STYLE: 'true',
    MEDIA_ACCESS_GRANT_ORIGIN: 'https://media.example.test',
    ...overrides,
  };
}

/** 带凭据的 `real` 环境（审核与 TTS/OCR 共用 `TENCENTCLOUD_*` 共享配对）。 */
function realEnvWithTencentCredentials(overrides = {}) {
  return realEnv({
    TENCENTCLOUD_SECRET_ID: SECRET_ID,
    TENCENTCLOUD_SECRET_KEY: SECRET_KEY,
    ...overrides,
  });
}

/** 自称 `persistent` 的内存 auth 存储（`real` 模式的会话闸门要求；只影响 auth 域）。 */
function persistentAuthStore() {
  const memory = createMemoryAuthStore();
  const store = Object.create(memory);
  Object.defineProperty(store, 'persistent', { value: true, enumerable: true });
  return store;
}

function approved() {
  return approveModerationLiveWiring({
    reason: 'r70-synthetic-approval',
    policySource: POLICY_SOURCE,
    bizType: BIZ_TYPE,
    approvedAt: '2026-10-30T00:00:00.000Z',
  });
}

const SCREENING_INPUT = {
  actor: { userId: 'u-r70', role: 'user', authEpoch: 1 },
  content: { target_ref: { type: 'post', id: 'p-r70', revision: 1 }, text: 'x', media: [] },
};

/**
 * 零外呼绊线：把 `globalThis.fetch` 换成计数器 + 立即拒绝。
 *
 * 绊线的判据不是"抛了什么"，而是**计数**：装配路径只要碰一次网络，`calls` 就不是 0。
 */
async function withFetchTripwire(body) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (...args) => {
    calls.push(args);
    return Promise.reject(new Error('zero-outbound tripwire: 装配路径不得发起任何外呼'));
  };
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** 建一个 `real`/`stub` 的 app（日志进内存可断言，凭据不外泄）。 */
async function buildWithLogs({ config, moderationInjection }) {
  const chunks = [];
  const app = buildApp({
    config,
    store: persistentAuthStore(),
    logStream: { write: (chunk) => chunks.push(String(chunk)) },
    ...(moderationInjection === undefined ? {} : { moderationInjection }),
  });
  return { app, logText: () => chunks.join('\n') };
}

/** 取一条"被拒绝"的事实（只读三个既有字段：code / message / retryable）。 */
async function rejectionOf(service) {
  try {
    await service.submitScreening(SCREENING_INPUT);
  } catch (error) {
    return { code: error?.code, message: error?.message, retryable: error?.retryable };
  }
  assert.fail('real 且未接线时送审必须被拒绝（fail-closed），不得返回成功封套');
}

// ---------------------------------------------------------------- ①②③④ 装配矩阵

test('① 矩阵 A：real + 凭据齐备 + 显式批准 ⇒ 真的传入 liveWiring（审核域 wired）', async () => {
  await withFetchTripwire(async (calls) => {
    const config = loadConfig(realEnvWithTencentCredentials());
    // 凭据从被校验配置来（不是手搓对象）：real 且共享配对齐备 ⇒ 非 null。
    assert.notEqual(config.moderationLive, null);
    assert.equal(typeof config.moderationLive.credentials.secretId, 'string');

    const { app, logText } = await buildWithLogs({
      config,
      moderationInjection: { liveApproval: approved() },
    });
    try {
      const capabilities = app.moderationService.capabilities();
      assert.equal(capabilities.execution_mode, 'real');
      // 「wired」只可能来自 `liveWiring`：`resolveModerationPorts` 的 real 分支只认 `live`。
      assert.deepEqual(
        { text: capabilities.text.state, textReady: capabilities.text.ready, textOrigin: capabilities.text.origin },
        { text: 'wired', textReady: true, textOrigin: 'injected' },
      );
      assert.deepEqual(
        { image: capabilities.image.state, imageReady: capabilities.image.ready },
        { image: 'wired', imageReady: true },
      );
      // 三条与门全过 ⇒ 不出现拒绝日志（拒绝日志一旦出现就说明闸门判断自相矛盾）。
      assert.equal(logText().includes('审核域真实接线未成立'), false);
    } finally {
      await app.close();
    }
    assert.equal(calls.length, 0, '装配路径必须零外呼（构造期一次都不许发包）');
  });
});

test('② 矩阵 B：real + 缺凭据 ⇒ 不传 ⇒ 整域 503，且与改前逐字段相同', async () => {
  await withFetchTripwire(async (calls) => {
    // 有批准能力、有 real，但环境里没有 TENCENTCLOUD_*（凭据缺失）。
    const config = loadConfig(realEnv());
    assert.equal(config.moderationLive, null, '非 real 或凭据不齐 ⇒ 凭据搬运必须为 null');

    const { app, logText } = await buildWithLogs({
      config,
      moderationInjection: { liveApproval: approved() },
    });
    try {
      const capabilities = app.moderationService.capabilities();
      assert.equal(capabilities.text.state, 'none');
      assert.equal(capabilities.text.ready, false);
      assert.equal(capabilities.image.state, 'none');

      const actual = await rejectionOf(app.moderationService);
      // **等价性**：改前 `app.ts` 调的就是 `createModerationService({ executionMode: 'real' })`。
      const before = await rejectionOf(createModerationService({ executionMode: 'real' }));
      assert.deepEqual(actual, before, '不满足条件时必须与改前逐字段相同（同码同 message 同 retryable）');
      assert.equal(actual.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(actual.retryable, false);
      assert.ok(logText().includes('reason=missing_credentials'), '拒绝原因必须可判定（闭集原因进启动日志）');
      assert.ok(logText().includes(MODERATION_LIVE_REFUSAL_REASON_CODE), '既有原因码语义必须留在可读面上');
    } finally {
      await app.close();
    }
    assert.equal(calls.length, 0);
  });
});

test('③ 矩阵 C：非 real（stub）⇒ 不传，即使环境里有凭据与批准能力', async () => {
  await withFetchTripwire(async (calls) => {
    const config = loadConfig(realEnvWithTencentCredentials({ APP_EXECUTION_MODE: 'stub' }));
    // 非 real 一律不带真实凭据（替身/演示不得"悄悄打了个真实电话"）。
    assert.equal(config.moderationLive, null);

    const { app } = await buildWithLogs({
      config,
      moderationInjection: { liveApproval: approved() },
    });
    try {
      const capabilities = app.moderationService.capabilities();
      assert.equal(capabilities.text.state, 'substitute', '非 real 必须仍是明确标注的替身端口');
      assert.equal(capabilities.text.ready, false, '替身永不 ready（不放行任何内容）');
      assert.equal(capabilities.text.origin, 'substitute');
    } finally {
      await app.close();
    }

    // 决定点本身也不认（不依赖 config 的 null）：直接喂凭据 + 批准，非 real 仍必须 null。
    const plan = resolveModerationLiveWiring({
      executionMode: 'stub',
      approval: approved(),
      credentials: SYNTHETIC_CREDENTIALS,
    });
    assert.equal(plan.wiring, null);
    assert.equal(plan.refusal, null, '非 real 不是"失败"（无可拒绝：本来就不接真实端口）');
    assert.equal(calls.length, 0);
  });
});

test('④ 矩阵 D：real + 凭据齐备 + 无批准（或伪造批准）⇒ 不传 ⇒ 同上 503', async () => {
  await withFetchTripwire(async (calls) => {
    const config = loadConfig(realEnvWithTencentCredentials());
    const forged = { reason: 'forged', approvedAt: '2026-10-30T00:00:00.000Z', policySource: POLICY_SOURCE, bizType: BIZ_TYPE };
    assert.equal(isModerationLiveWiringApproved(forged), false, '形状相同的字面量不是批准能力');
    assert.equal(isModerationLiveWiringApproved(Object.create(approved())), false, '派生对象不是批准能力');

    const { app, logText } = await buildWithLogs({ config, moderationInjection: { liveApproval: forged } });
    try {
      assert.equal(app.moderationService.capabilities().text.state, 'none');
      const actual = await rejectionOf(app.moderationService);
      const before = await rejectionOf(createModerationService({ executionMode: 'real' }));
      assert.deepEqual(actual, before);
      assert.ok(logText().includes('reason=missing_approval'));
    } finally {
      await app.close();
    }

    // 连"批准字段都没有"的默认装配（生产今天的样子）也必须 503。
    const { app: plainApp } = await buildWithLogs({ config });
    try {
      assert.equal(plainApp.moderationService.capabilities().image.state, 'none');
      assert.equal((await rejectionOf(plainApp.moderationService)).code, 'PROVIDER_UNAVAILABLE');
    } finally {
      await plainApp.close();
    }
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------- ⑤ 零外呼（四臂一次覆盖）

test('⑤ 零外呼绊线：四臂装配（loadConfig + buildApp）合计 globalThis.fetch 计数恒 0', async () => {
  await withFetchTripwire(async (calls) => {
    const arms = [
      { env: realEnvWithTencentCredentials(), injection: { liveApproval: approved() } },
      { env: realEnv(), injection: { liveApproval: approved() } },
      {
        env: realEnvWithTencentCredentials({ APP_EXECUTION_MODE: 'stub' }),
        injection: { liveApproval: approved() },
      },
      { env: realEnvWithTencentCredentials(), injection: { liveApproval: { reason: 'forged' } } },
    ];
    for (const arm of arms) {
      const config = loadConfig(arm.env);
      const { app } = await buildWithLogs({ config, moderationInjection: arm.injection });
      // 只读能力位（不触发任何端口调用）：装配路径本身必须零外呼。
      app.moderationService.capabilities();
      await app.close();
    }
    assert.equal(calls.length, 0, `装配路径共发起 ${calls.length} 次外呼，必须是 0`);
  });
});

// ---------------------------------------------------------------- ⑥ 假 wiring 被真的用上

test('⑥ 注入的假 wiring 被真的用上：seam 就是它给的 fetchImpl（且零真实外呼）', async () => {
  await withFetchTripwire(async (calls) => {
    const seamCalls = [];
    const seamFetch = (...args) => {
      seamCalls.push(args);
      // 立刻失败：本用例只证"走到即将发送的那一步"，不证任何供应商结论。
      return Promise.reject(new Error('synthetic seam: 不构造真实响应'));
    };
    const fakeWiring = {
      policy: { policySelectionVerified: true, executionAllowed: true, source: POLICY_SOURCE },
      textProfile: {
        endpoint: MODERATION_VENDOR_ENDPOINTS.tms,
        action: MODERATION_VENDOR_ACTIONS.tms.action,
        apiVersion: MODERATION_VENDOR_ACTIONS.tms.apiVersion,
        region: 'ap-shanghai',
        timeoutMs: 8000,
        maxRetries: 0,
        bizType: BIZ_TYPE,
      },
      imageProfile: {
        endpoint: MODERATION_VENDOR_ENDPOINTS.ims,
        action: MODERATION_VENDOR_ACTIONS.ims.action,
        apiVersion: MODERATION_VENDOR_ACTIONS.ims.apiVersion,
        region: 'ap-shanghai',
        timeoutMs: 8000,
        maxRetries: 0,
        bizType: BIZ_TYPE,
        maxImageBytes: 2097152,
        mediaTransport: 'inlineBase64',
      },
      credentials: SYNTHETIC_CREDENTIALS,
      fetchImpl: seamFetch,
    };
    // 端口确实拿的是**这份** wiring 的 seam 与声明（不是 globalThis.fetch、不是替身）。
    const ports = createLiveModerationPortsFromWiring(fakeWiring);
    assert.notEqual(ports, null);
    assert.equal(ports.tms.seams.fetchImpl, seamFetch);
    assert.equal(ports.tms.provider.synthetic, false);
    assert.equal(ports.tms.provider.biz_type, BIZ_TYPE);

    const service = createModerationService({ executionMode: 'real', liveWiring: fakeWiring });
    assert.equal(service.capabilities().text.state, 'wired');
    try {
      await service.submitScreening(SCREENING_INPUT);
    } catch {
      // 结论如何不重要（seam 必然失败 ⇒ 隔离/拒绝），本用例只看"谁被调用了"。
    }
    assert.equal(seamCalls.length, 1, '注入的 fetchImpl 必须恰被调用一次（零重试）');
    assert.equal(calls.length, 0, '真实 globalThis.fetch 必须一次都没被碰');
  });
});

// ---------------------------------------------------------------- ⑦⑧ 判据钉子

test('⑦ 拒因形状：既有契约码 + details[].code 仍是既有闭集 MODEL_NOT_EVALUATED（不是 HTTP 码）', () => {
  // 三个闭集原因各走一次，逐条断言同一个形状（拒绝描述只有这一种形状）。
  const plans = [
    resolveModerationLiveWiring({ executionMode: 'real', approval: undefined, credentials: SYNTHETIC_CREDENTIALS }),
    resolveModerationLiveWiring({ executionMode: 'real', approval: approved(), credentials: null }),
    resolveModerationLiveWiring({
      executionMode: 'real',
      approval: approveModerationLiveWiring({ reason: 'r70-bad-biztype', policySource: POLICY_SOURCE, bizType: 'bad biz*type' }),
      credentials: SYNTHETIC_CREDENTIALS,
    }),
  ];
  assert.deepEqual(
    plans.map((plan) => plan.refusal?.reason),
    [...MODERATION_LIVE_REFUSAL_REASONS],
    '三个闭集原因必须各对应一种真实不满足条件（不是三个同义分支）',
  );
  for (const plan of plans) {
    assert.equal(plan.wiring, null);
    assert.notEqual(plan.refusal, null);
    assert.equal(plan.refusal.errorCode, 'PROVIDER_UNAVAILABLE', '对外只允许既有契约码（HTTP 503）');
    assert.equal(plan.refusal.retryable, false);
    assert.deepEqual(plan.refusal.details, [{ field: 'reason_codes', code: MODERATION_LIVE_REFUSAL_REASON_CODE }]);
  }
  // 既有原因码语义：`MODEL_NOT_EVALUATED` 仍是模型层闭集成员（不是本片新造的字面量）。
  assert.equal(isModelReasonCode(MODERATION_LIVE_REFUSAL_REASON_CODE), true);
  assert.equal(isModelFailureReasonCode(MODERATION_LIVE_REFUSAL_REASON_CODE), true);
  assert.equal(MODERATION_LIVE_REFUSAL_REASON_CODE.startsWith('MODEL_'), true);
  // ⛔ 它不是 HTTP 错误码：拒绝描述里的 `errorCode` 与它必须是两个不同的东西。
  assert.notEqual(MODERATION_LIVE_REFUSAL_REASON_CODE, 'PROVIDER_UNAVAILABLE');
});

test('⑦ 构造失败（BizType 不合法）⇒ 捕获成 invalid_configuration，既不抛错也不回显凭据', async () => {
  await withFetchTripwire(async (calls) => {
    const badApproval = approveModerationLiveWiring({
      reason: 'r70-synthetic-approval-bad-biztype',
      policySource: POLICY_SOURCE,
      // 剖面断言要求 `[A-Za-z0-9_-]{1,32}`；这串带空格与 `*`，构造期必被拒。
      bizType: 'bad biz*type',
    });
    let plan;
    assert.doesNotThrow(() => {
      plan = resolveModerationLiveWiring({
        executionMode: 'real',
        approval: badApproval,
        credentials: SYNTHETIC_CREDENTIALS,
      });
    });
    assert.equal(plan.wiring, null);
    assert.equal(plan.refusal.reason, 'invalid_configuration');
    // 拒绝描述可整体序列化而不泄露凭据（凭据值不在这条路径上）。
    const serialized = JSON.stringify(plan.refusal);
    assert.equal(serialized.includes(SECRET_KEY), false);
    assert.equal(serialized.includes(SECRET_ID), false);

    // 端到端：装配并不因构造失败而抛错，审核域仍是 503（fail-closed）。
    const config = loadConfig(realEnvWithTencentCredentials());
    const { app, logText } = await buildWithLogs({
      config,
      moderationInjection: { liveApproval: badApproval },
    });
    try {
      assert.equal(app.moderationService.capabilities().text.state, 'none');
      assert.equal((await rejectionOf(app.moderationService)).code, 'PROVIDER_UNAVAILABLE');
      assert.ok(logText().includes('reason=invalid_configuration'));
    } finally {
      await app.close();
    }
    // 启动日志里不得出现任何凭据值（真实凭据在 config 里，日志只允许闭集原因）。
    assert.equal(logText().includes(SECRET_KEY), false, '日志不得回显 secretKey');
    assert.equal(logText().includes(SECRET_ID), false, '日志不得回显 secretId');
    assert.equal(calls.length, 0);
  });
});

/** 生产代码里**允许**调用铸造点的唯一文件（GY-R70 · 有名启动开关的批准通道）。 */
const SANCTIONED_CALL_SITE = 'moderation/startup-approval.ts';

/** 铸造点全名（含左括号）。定义处与调用点都靠它数。 */
const MINT_CALL = 'approveModerationLiveWiring(';

/** 定义处的前缀；用来把「定义」从「调用」里减掉，且顺序敏感（必须与源码逐字相同）。 */
const MINT_DEFINITION = 'export function approveModerationLiveWiring(';
const DEFINITION_PREFIX_LENGTH = 'export function '.length;

/**
 * 扫一棵源码树，数铸造点的出现：定义处、调用点、以及**不许铸造**的文件。
 *
 * 判据同既有结构钉子：只看**去注释后**的代码（注释里提到函数名不算铸造）。去注释走
 * `tools/lib/strip-comments.mjs` 的状态机，**不是**一行惰性正则——后者会被注释正文里的
 * `services/api/src/**` 骗过，把其后的真实代码一起吞掉（见 ⑨）。
 *
 * @param {string} sourceRoot 绝对路径。
 * @returns {{ offenders: string[], callSites: Array<{file: string, calls: number}>,
 *            callSiteLines: Array<{file: string, line: number}>, occurrences: number }}
 */
function scanWiringCallSites(sourceRoot) {
  const offenders = [];
  const callSites = [];
  const callSiteLines = [];
  let occurrences = 0;
  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), relative);
        continue;
      }
      if (!relative.endsWith('.ts')) continue;
      const source = stripComments(readFileSync(join(dir, entry.name), 'utf8'));
      const hits = occurrencesWithLines(source, MINT_CALL);
      if (hits.length === 0) continue;
      occurrences += hits.length;
      // 唯一允许出现的**定义**位置：`export function approveModerationLiveWiring(`。
      const definitions = occurrencesWithLines(source, MINT_DEFINITION);
      const definitionIndexes = new Set(
        definitions.map((hit) => hit.index + DEFINITION_PREFIX_LENGTH),
      );
      const callHits = hits.filter((hit) => !definitionIndexes.has(hit.index));
      const calls = hits.length - definitions.length;
      if (definitions.length !== hits.length && relative !== SANCTIONED_CALL_SITE) {
        offenders.push(relative);
      }
      if (calls > 0) {
        callSites.push({ file: relative, calls });
        for (const hit of callHits) callSiteLines.push({ file: relative, line: hit.line });
      }
    }
  };
  walk(sourceRoot);
  return { offenders, callSites, callSiteLines, occurrences };
}

test('⑧ 结构钉子：铸造点唯一（定义处 ＋ 恰好一处生产调用点＝生产入口批准通道）', () => {
  const { offenders, callSites, occurrences } = scanWiringCallSites(join(ROOT, 'services/api/src'));
  assert.deepEqual(offenders, [], `除定义处与批准通道外不得铸造批准能力（装配层自我批准＝没批准）：${offenders.join(', ')}`);
  // ⚠ 2026-10-30（GY-R70 · 批准通道）**有据变更，不是放宽**：`#777` 把「生产代码里恰好一处（定义处）」钉成
  // 「装配层从不铸造」，但铸造点**必须**能被生产入口用一次，否则 `real` 下审核域永远开不了、批准能力等于死码。
  // 因此本钉子由「恰好 1 处（定义处）」改为「恰好 2 处：定义处 ＋ 唯一获准的调用点」，并把调用点**逐名登记**
  // （新增调用点仍判红）。`app.ts` 依然不得铸造（装配层不许自己批准自己），`server.ts` 只做转发、连名字都不碰。
  assert.deepEqual(
    callSites,
    [{ file: SANCTIONED_CALL_SITE, calls: 1 }],
    `铸造点只允许被 ${SANCTIONED_CALL_SITE} 调用一次（新增调用点＝有人在自己批准自己）`,
  );
  assert.equal(occurrences, 2, '生产代码里必须恰好两处：定义处 ＋ 唯一获准的调用点');
  for (const relative of ['services/api/src/app.ts', 'services/api/src/server.ts']) {
    const code = stripComments(readFileSync(join(ROOT, relative), 'utf8'));
    assert.equal(code.includes('approveModerationLiveWiring('), false, `${relative} 不得调用铸造点（只许转发）`);
  }

  // 真实的适配器符号仍不得进入 app.ts / server.ts（既有结构钉子照旧成立）。
  for (const relative of ['services/api/src/app.ts', 'services/api/src/server.ts']) {
    const code = stripComments(readFileSync(join(ROOT, relative), 'utf8'));
    assert.equal(code.includes('createLiveModerationTextPort'), false);
    assert.equal(code.includes('createLiveModerationImagePort'), false);
    assert.equal(code.includes('tms-live-adapter'), false);
    assert.equal(code.includes('ims-live-adapter'), false);
  }
});

// —— ⑨ 回归：判据不得被注释正文里的 `/**` 骗过 ————————————————————————————————
//
// 缺陷（`#781` 登记为「已知判据缺陷」）：⑧ 原先用一行惰性正则去注释
//     source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
// 它**不知道自己在注释里**。只要 `/**` 出现在块注释**之外**——`//` 注释正文里（最典型的就是把仓内
// 路径写成 `services/api/src/**` 这种 glob），或者字符串字面量里——正则就把那里的开注释二字符
// 当成注释开头，一路吃到**下一个**闭合二字符，把中间的真实代码整段删掉。两个方向都会坏：
//   - **误红**：获准调用点被吞 ⇒ `occurrences` 少一个 ⇒ ⑧ 判红，而代码其实是对的；
//   - **假绿**：违规调用被吞 ⇒ 判据看不见它 ⇒ ⑧ 判绿，而代码其实是错的。
// 同一个根因：**正则没有状态**。⑧ 现在改走 `tools/lib/strip-comments.mjs` 的状态机（保留行号）。
//
// 本用例用两棵**合成树**把两个方向钉住（不依赖产品源码今天的写法），先红后绿：
//   - 合规树 ⇒ 必须绿；违规树 ⇒ 必须红（违规调用放在触发注释**之后**）。
// 两棵树都刻意让注释正文含 `services/api/src/**`，并刻意在真实代码**后面**再放一个块注释：
// 旧正则正是靠那个闭合二字符把中间代码吞掉的（形状与逐字读数见证据页 §2）。

/** 造一棵合成源码树（返回绝对根目录；调用方负责删除）。 */
function makeWiringTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'gy-r71-strip-'));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

/** 唯一铸造点（定义处）。定义行本身不算调用点。 */
const MINT_SOURCE = [
  '/* 唯一的铸造点。 */',
  'export function approveModerationLiveWiring(input) {',
  "  return Object.freeze({ kind: 'moderation-live-wiring', ...input });",
  '}',
  '',
].join('\n');

/**
 * 获准的调用点。**第 3 行是缺陷的触发器**：`//` 注释正文里写了 `services/api/src/**`；
 * 第 4 行是**真实调用**（旧正则会被第 3 行骗走，把第 4 行一起吞掉 ⇒ 误红）；
 * 第 4 行里还有一个带双斜杠的 URL 字面量（负控制③的判别式）；
 * 第 5 行的块注释提供旧正则要吃的闭合二字符。
 */
const SANCTIONED_SOURCE = [
  "import { approveModerationLiveWiring } from './live-assembly.ts';",
  '',
  '// 动态枚举 services/api/src/** 下的所有 .ts（不写死文件清单）',
  "const REGISTRY = { doc: 'https://api.example.test/v1/moderation', mint: approveModerationLiveWiring({ policySource: 'synthetic' }) };",
  '/* 装配层只转发，绝不自行铸造。 */',
  'export function forward(approval) {',
  '  return approval;',
  '}',
  '',
].join('\n');

/** 合规的装配层：注释正文里提到铸造点名，但**没有**任何真实调用。 */
const APP_COMPLIANT = [
  '/*',
  ' * 动态枚举 `services/api/src/**`：不写死文件清单，将来新增的文件同样进扫描面。',
  ' * ⛔ 装配层不得调用 approveModerationLiveWiring( —— 装配层不许自批。',
  ' */',
  'export function buildApp() {',
  '  return {};',
  '}',
  '',
].join('\n');

/**
 * 违规的装配层：第 3 行**真的**铸造了一次。旧正则会被第 1 行的 `/**` 骗到第 5 行，
 * 把第 3 行的违规调用整段吞掉 ⇒ 假绿。
 */
const APP_VIOLATING = [
  '// 动态枚举 services/api/src/** 下的所有 .ts',
  'export function buildApproval(input) {',
  '  return approveModerationLiveWiring({ policySource: input.source });',
  '}',
  '/* 装配层只转发，绝不自行铸造。 */',
  'export function buildApp() {',
  '  return {};',
  '}',
  '',
].join('\n');

test('⑨ 回归：注释里的 `services/api/src/**` 不得让判据吞掉其后的真实代码', () => {
  const shared = {
    'moderation/live-assembly.ts': MINT_SOURCE,
    'moderation/startup-approval.ts': SANCTIONED_SOURCE,
  };
  const compliantRoot = makeWiringTree({ ...shared, 'app.ts': APP_COMPLIANT });
  const violatingRoot = makeWiringTree({ ...shared, 'app.ts': APP_VIOLATING });
  try {
    // —— 去注释自身的两条不变量：行数不变、`//` 注释正文（含 `/**` 那段）不残留 ——
    const stripped = stripComments(SANCTIONED_SOURCE);
    assert.equal(
      stripped.split('\n').length,
      SANCTIONED_SOURCE.split('\n').length,
      '去注释必须**保留行号**（空行占位）：输出行数 ≠ 输入行数 ⇒ 报错里的行号不可读',
    );
    assert.equal(
      stripped.includes('services/api/src'),
      false,
      '`//` 注释正文必须整体抹掉（含里面的 `/**`）：注释里的路径不许混进「代码」',
    );

    // —— 合规树：必须绿 ——
    const clean = scanWiringCallSites(compliantRoot);
    assert.deepEqual(
      clean.offenders,
      [],
      `合规树被误红（注释里提到铸造点名被当成铸造）：${clean.offenders.join(', ')}`,
    );
    assert.deepEqual(
      clean.callSites,
      [{ file: SANCTIONED_CALL_SITE, calls: 1 }],
      '合规树里的获准调用点必须被看见——旧正则会被注释里的 `/**` 吞掉它（误红）',
    );
    assert.equal(clean.occurrences, 2, '合规树必须恰好两处：定义处 ＋ 获准调用点');
    assert.deepEqual(
      clean.callSiteLines,
      [{ file: SANCTIONED_CALL_SITE, line: 4 }],
      '调用点行号必须是**原文件**的行号（去注释丢了行号，这里就会指到第 1 行）',
    );

    // —— 违规树：必须红 ——
    const dirty = scanWiringCallSites(violatingRoot);
    assert.deepEqual(
      dirty.offenders,
      ['app.ts'],
      '违规树必须被点名——旧正则会把它吞进「注释」里（假绿：判据看不见违规写法）',
    );
    assert.equal(dirty.occurrences, 3, '违规树必须三处：定义处 ＋ 获准调用点 ＋ 违规调用');
  } finally {
    rmSync(compliantRoot, { recursive: true, force: true });
    rmSync(violatingRoot, { recursive: true, force: true });
  }
});
