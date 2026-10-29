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
 *
 * 全部**离线**：不读凭据文件、不联网、不写台账；凭据与 BizType 都是明显合成的占位串。
 * ⛔ 本文件**不**证明审核策略有效、**不**证明违规样本会被拦、**不**证明真实供应商可接受这份剖面——
 * 那需要真实凭据与真实付费调用，本片明确不做（见证据页「没证明什么」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

test('⑧ 结构钉子：装配层从不铸造批准能力（唯一铸造点＝live-assembly.ts 的定义处）', () => {
  const sourceRoot = join(ROOT, 'services/api/src');
  const offenders = [];
  let occurrences = 0;
  // 判据同既有结构钉子：**去注释后**的产品源码（注释里提到函数名不算铸造）。
  const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /** 动态枚举 `services/api/src/**`：不写死文件清单，将来新增的文件同样进扫描面。 */
  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), relative);
        continue;
      }
      if (!relative.endsWith('.ts')) continue;
      const source = strip(readFileSync(join(dir, entry.name), 'utf8'));
      const matches = source.match(/approveModerationLiveWiring\(/g) ?? [];
      if (matches.length === 0) continue;
      occurrences += matches.length;
      // 唯一允许出现的位置：本模块的**函数定义**行（`export function approveModerationLiveWiring(`）。
      const definitions = source.match(/export function approveModerationLiveWiring\(/g) ?? [];
      if (definitions.length !== matches.length) offenders.push(relative);
    }
  };
  walk(sourceRoot);
  assert.deepEqual(offenders, [], `除定义处外不得铸造批准能力（装配层自我批准＝没批准）：${offenders.join(', ')}`);
  assert.equal(occurrences, 1, '生产代码里必须恰好一处（定义处）；多一处就是有人在自己批准自己');

  // 真实的适配器符号仍不得进入 app.ts / server.ts（既有结构钉子照旧成立）。
  for (const relative of ['services/api/src/app.ts', 'services/api/src/server.ts']) {
    const code = strip(readFileSync(join(ROOT, relative), 'utf8'));
    assert.equal(code.includes('createLiveModerationTextPort'), false);
    assert.equal(code.includes('createLiveModerationImagePort'), false);
    assert.equal(code.includes('tms-live-adapter'), false);
    assert.equal(code.includes('ims-live-adapter'), false);
  }
});
