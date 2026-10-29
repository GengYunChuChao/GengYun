/**
 * GY-R70 · 审核域真实接线的**生产入口批准通道**（`--approve-moderation-live-wiring`）fail-closed 回归。
 *
 * 断点（改前代码事实）：`moderation/live-assembly.ts`（#777）已有唯一铸造点
 * `approveModerationLiveWiring()` 与纯决定函数 `resolveModerationLiveWiring()`，`app.ts` 也在装配点接上了
 * `liveApproval`；但 `git grep -n approveModerationLiveWiring -- services/api/src` 除定义处**零命中**
 * ⇒ 今天 `real` 下审核域仍整域 503，批准能力是死码。本片补上那一步：`server.ts` 解析有名启动开关，
 * 由**启动参数**给出的 `policySource` / `bizType` ＋ 共享凭据决定要不要铸造。
 *
 * 参数矩阵（六臂；前五臂**都不铸造**，最后一臂**才**铸造）：
 *
 * | 臂 | 开关 | `--moderation-policy-source=` | `--moderation-biz-type=` | 共享凭据 | 期望 |
 * |---|---|---|---|---|---|
 * | ① | 缺 | — | — | 齐备 | 不铸造、**不发声**（与改前逐字相同的默认路径） |
 * | ② | 给了 | **缺** | 齐备 | 齐备 | 不铸造，warn `reason=missing_approval` 且点名 `--moderation-policy-source` |
 * | ③ | 给了 | 齐备 | **缺** | 齐备 | 不铸造，warn `reason=missing_approval` 且点名 `--moderation-biz-type` |
 * | ④ | 给了 | **非法** | **非法** | 齐备 | 不铸造，warn `reason=invalid_configuration` |
 * | ⑤ | 给了 | 齐备 | 齐备 | **缺** | 不铸造，warn `reason=missing_credentials` |
 * | ⑥ | 给了 | 齐备 | 齐备 | 齐备 | **铸造**，`buildApp` 后审核域 `wired`、零 warn |
 *
 * 另有五条钉子：
 *   ⓐ **零外呼绊线**（手法照 `tests/unit/ai-live-provider-wiring.test.mjs` 的头注）：整条「解析 + 装配」路径
 *     （`loadConfig` + 决定点 + `buildApp` × 六臂）`globalThis.fetch` 计数必须是 **0**；
 *   ⓑ **等价性**：不批准的臂，`buildApp` 之后 `capabilities()` 与「**完全不给开关**」的臂**逐字段相同**
 *     （不是凭印象写死字符串），且送审仍是既有 `PROVIDER_UNAVAILABLE` / `retryable:false`；
 *   ⓒ **输入只认启动参数**：把同样的值塞进 env（`MODERATION_POLICY_SOURCE` / `MODERATION_BIZ_TYPE`）而 argv
 *     不给 ⇒ 仍然不铸造（负控制 ② 就是打这条）；
 *   ⓓ **对象身份**：`WeakSet` 判定的意义在这里——克隆/派生一份合法 approval 传进 `buildApp` 必须**不被接受**
 *     （仍 503），只有铸造点产出的那个对象身份才算数；
 *   ⓔ **不 exit**：本片所有拒绝路径都只是 warn（不批准 ≠ 启动失败），由结构断言钉住模块里没有 `process.exit`。
 *
 * 全部**离线**：不读凭据文件、不联网、不写台账；凭据与 BizType 都是明显合成的占位串。
 * ⛔ 本文件**不**证明审核策略有效、**不**证明真实供应商会接受这份剖面、**不**证明违规样本会被拦——
 * 那需要真实凭据与真实付费调用，本片明确不做（见证据页「没证明什么」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createModerationService } from '../../services/api/src/moderation/service.ts';
import {
  MODERATION_LIVE_REFUSAL_REASONS,
  approveModerationLiveWiring,
  isModerationLiveWiringApproved,
  resolveModerationLiveWiring,
} from '../../services/api/src/moderation/live-assembly.ts';
import { MODERATION_BIZ_TYPE_PATTERN } from '../../services/api/src/moderation/live-ports.ts';
import {
  MODERATION_BIZ_TYPE_PREFIX,
  MODERATION_LIVE_WIRING_FLAG,
  MODERATION_POLICY_SOURCE_PATTERN,
  MODERATION_POLICY_SOURCE_PREFIX,
  moderationStartupAssemblyOptions,
  parseModerationStartupArgs,
  resolveModerationStartupApproval,
} from '../../services/api/src/moderation/startup-approval.ts';

const ROOT = resolve(import.meta.dirname, '../..');

// ---------------------------------------------------------------- 合成夹具

const SECRET_ID = 'AKIDR70FLAGSYNTHETICONLYNOTAREALKEY';
const SECRET_KEY = 'r70-flag-synthetic-secret-key-do-not-log-do-not-commit';
const BIZ_TYPE = 'r70flagsynth';
const POLICY_SOURCE = 'r70-flag-synthetic-policy-source-not-a-real-console-review';

/**
 * `real` 模式的其余必填项（与 `tests/unit/moderation-live-wiring-assembly.test.mjs` 同形的合成占位，
 * **不是**任何真实凭据；`DATABASE_URL` 指向永不可达的合成库，本文件从不连它）。
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
    OBJECT_STORAGE_ACCESS_KEY: 'AKIDR70FLAGSYNTHETICSTORAGEONLY',
    OBJECT_STORAGE_SECRET_KEY: 'r70-flag-synthetic-storage-secret-do-not-log',
    OBJECT_STORAGE_REGION: 'ap-shanghai',
    OBJECT_STORAGE_FORCE_PATH_STYLE: 'true',
    MEDIA_ACCESS_GRANT_ORIGIN: 'https://media.example.test',
    ...overrides,
  };
}

/** 带共享凭据的 `real` 环境（审核与 TTS/OCR 共用 `TENCENTCLOUD_*` 配对）。 */
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

/** 六臂的参数（每臂只有 argv 与 env 两处差别，见文件头矩阵）。 */
const ARMS = [
  { id: '①', label: '开关缺', argv: [], credentials: true },
  { id: '②', label: 'policySource 缺', argv: [MODERATION_LIVE_WIRING_FLAG, `${MODERATION_BIZ_TYPE_PREFIX}${BIZ_TYPE}`], credentials: true },
  { id: '③', label: 'bizType 缺', argv: [MODERATION_LIVE_WIRING_FLAG, `${MODERATION_POLICY_SOURCE_PREFIX}${POLICY_SOURCE}`], credentials: true },
  {
    id: '④',
    label: '两者非法',
    argv: [MODERATION_LIVE_WIRING_FLAG, `${MODERATION_POLICY_SOURCE_PREFIX}bad policy source`, `${MODERATION_BIZ_TYPE_PREFIX}bad biz*type`],
    credentials: true,
  },
  {
    id: '⑤',
    label: '凭据缺',
    argv: [MODERATION_LIVE_WIRING_FLAG, `${MODERATION_POLICY_SOURCE_PREFIX}${POLICY_SOURCE}`, `${MODERATION_BIZ_TYPE_PREFIX}${BIZ_TYPE}`],
    credentials: false,
  },
  {
    id: '⑥',
    label: '全齐',
    argv: [MODERATION_LIVE_WIRING_FLAG, `${MODERATION_POLICY_SOURCE_PREFIX}${POLICY_SOURCE}`, `${MODERATION_BIZ_TYPE_PREFIX}${BIZ_TYPE}`],
    credentials: true,
  },
];

const SCREENING_INPUT = {
  actor: { userId: 'u-r70-flag', role: 'user', authEpoch: 1 },
  content: { target_ref: { type: 'post', id: 'p-r70-flag', revision: 1 }, text: 'x', media: [] },
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
    return Promise.reject(new Error('zero-outbound tripwire: 批准通道不得发起任何外呼'));
  };
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * 走**与 `server.ts` 完全同一条**路径：`loadConfig` → `moderationStartupAssemblyOptions`（含 warn 出口）
 * → `buildApp({ config, store, logStream, ...assembly })`。
 */
async function assemble({ env, argv }) {
  const config = loadConfig(env);
  const warnings = [];
  const assembly = moderationStartupAssemblyOptions({ config, argv, warn: (line) => warnings.push(line) });
  const chunks = [];
  const app = buildApp({
    config,
    store: persistentAuthStore(),
    logStream: { write: (chunk) => chunks.push(String(chunk)) },
    ...assembly,
  });
  return { config, assembly, warnings, app, logText: () => chunks.join('\n') };
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

// ---------------------------------------------------------------- ① 参数矩阵

test('矩阵：六臂逐条实测（前五臂不铸造，第六臂才铸造）', async () => {
  await withFetchTripwire(async (calls) => {
    const readouts = [];
    for (const arm of ARMS) {
      const env = arm.credentials ? realEnvWithTencentCredentials() : realEnv();
      const config = loadConfig(env);
      const plan = resolveModerationStartupApproval({ config, argv: arm.argv });
      readouts.push({
        id: arm.id,
        label: arm.label,
        minted: plan.minted,
        hasApproval: plan.liveApproval !== null,
        reason: plan.reason,
        warningLines: plan.warning === null ? 0 : plan.warning.split('\n').length,
      });
    }

    assert.deepEqual(
      readouts,
      [
        { id: '①', label: '开关缺', minted: false, hasApproval: false, reason: null, warningLines: 0 },
        { id: '②', label: 'policySource 缺', minted: false, hasApproval: false, reason: 'missing_approval', warningLines: 1 },
        { id: '③', label: 'bizType 缺', minted: false, hasApproval: false, reason: 'missing_approval', warningLines: 1 },
        { id: '④', label: '两者非法', minted: false, hasApproval: false, reason: 'invalid_configuration', warningLines: 1 },
        { id: '⑤', label: '凭据缺', minted: false, hasApproval: false, reason: 'missing_credentials', warningLines: 1 },
        { id: '⑥', label: '全齐', minted: true, hasApproval: true, reason: null, warningLines: 0 },
      ],
      '参数矩阵必须逐臂对上（前五臂都不铸造，第六臂才铸造）',
    );
    assert.equal(calls.length, 0, '决定点（解析 + 判定 + 铸造）必须零外呼');
  });
});

test('矩阵：拒绝原因只用 #777 的闭集，warn 恰好一行且点名缺哪一条', async () => {
  await withFetchTripwire(async (calls) => {
    const cases = [
      // 缺输入 ⇒ 没有批准能力可言 ⇒ 闭集里的 missing_approval（warn 里点名缺的是哪个参数）。
      { id: '②', env: realEnvWithTencentCredentials(), argv: ARMS[1].argv, reason: 'missing_approval', detail: MODERATION_POLICY_SOURCE_PREFIX },
      { id: '③', env: realEnvWithTencentCredentials(), argv: ARMS[2].argv, reason: 'missing_approval', detail: MODERATION_BIZ_TYPE_PREFIX },
      // 给了但值非法 ⇒ invalid_configuration。
      { id: '④', env: realEnvWithTencentCredentials(), argv: ARMS[3].argv, reason: 'invalid_configuration', detail: MODERATION_POLICY_SOURCE_PREFIX },
      // 输入齐备但共享凭据缺 ⇒ missing_credentials。
      { id: '⑤', env: realEnv(), argv: ARMS[4].argv, reason: 'missing_credentials', detail: 'TENCENTCLOUD_SECRET_ID' },
    ];
    for (const item of cases) {
      const plan = resolveModerationStartupApproval({ config: loadConfig(item.env), argv: item.argv });
      assert.equal(plan.reason, item.reason, `${item.id} 缺的是哪一条必须可判定（${item.detail}）`);
      // 原因串必须**逐字**是闭集成员：本片不新造原因。
      assert.equal(MODERATION_LIVE_REFUSAL_REASONS.includes(plan.reason), true, `${plan.reason} 必须是闭集成员`);
      assert.notEqual(plan.warning, null);
      assert.equal(plan.warning.includes('\n'), false, 'warn 必须恰好一行');
      assert.equal(plan.warning.includes(`reason=${item.reason}`), true, 'warn 必须带闭集原因');
      assert.equal(plan.warning.includes(item.detail), true, `warn 必须点名缺哪一条（${item.detail}）`);
      // 不回显任何值（尤其凭据）：凭据值永远不在这条路径上。
      assert.equal(plan.warning.includes(SECRET_KEY), false, 'warn 不得回显 secretKey');
      assert.equal(plan.warning.includes(SECRET_ID), false, 'warn 不得回显 secretId');
    }
    // 六臂全扫一遍，确认没有任何一条 warn 里出现非闭集原因串（含 real 下模式不成立那一支）。
    const real = loadConfig(realEnvWithTencentCredentials());
    const stub = loadConfig(realEnvWithTencentCredentials({ APP_EXECUTION_MODE: 'stub' }));
    for (const [config, arm] of [...ARMS.map((arm) => [real, arm]), [stub, ARMS[5]]]) {
      const plan = resolveModerationStartupApproval({ config, argv: arm.argv });
      if (plan.warning === null) continue;
      const matched = /reason=([a-z_]+)/.exec(plan.warning);
      assert.notEqual(matched, null, 'warn 必须写 reason=');
      assert.equal(MODERATION_LIVE_REFUSAL_REASONS.includes(matched[1]), true, `非闭集原因：${matched[1]}`);
    }
    assert.equal(calls.length, 0);
  });
});

test('矩阵：非 real 模式给了开关也不铸造（闭集里按 invalid_configuration 上报，不 exit）', async () => {
  await withFetchTripwire(async (calls) => {
    const config = loadConfig(realEnvWithTencentCredentials({ APP_EXECUTION_MODE: 'stub' }));
    assert.equal(config.executionMode, 'stub');
    // 非 real 下凭据本身就该是 null（替身不得"悄悄打了个真实电话"）。
    assert.equal(config.moderationLive, null);
    const plan = resolveModerationStartupApproval({ config, argv: ARMS[5].argv });
    assert.equal(plan.minted, false);
    assert.equal(plan.liveApproval, null);
    assert.equal(plan.reason, 'invalid_configuration');
    assert.equal(plan.warning.includes('real'), true);
    assert.equal(calls.length, 0);
  });
});

test('参数解析：整串精确匹配；空串/裸参数名/异值重复一律 fail-closed', () => {
  assert.deepEqual(parseModerationStartupArgs(['node', 'server.ts']), {
    flagPresent: false,
    policySource: { state: 'absent', value: null },
    bizType: { state: 'absent', value: null },
  });
  // 换个写法不算给了（不做前缀/模糊匹配）。
  assert.equal(parseModerationStartupArgs([`${MODERATION_LIVE_WIRING_FLAG}=true`]).flagPresent, false);
  assert.equal(parseModerationStartupArgs([MODERATION_LIVE_WIRING_FLAG]).flagPresent, true);
  // 空串 / 裸参数名 / 异值重复 ⇒ invalid（不是 absent：运维显然想给，只是写法错了）。
  assert.deepEqual(parseModerationStartupArgs([`${MODERATION_POLICY_SOURCE_PREFIX}`]).policySource, { state: 'invalid', value: null });
  assert.deepEqual(parseModerationStartupArgs(['--moderation-policy-source']).policySource, { state: 'invalid', value: null });
  assert.deepEqual(
    parseModerationStartupArgs([`${MODERATION_POLICY_SOURCE_PREFIX}a-b`, `${MODERATION_POLICY_SOURCE_PREFIX}c-d`]).policySource,
    { state: 'invalid', value: null },
  );
  // 同值重复出现视为一次（不因运维手抖重复粘贴就判红）。
  assert.deepEqual(
    parseModerationStartupArgs([`${MODERATION_POLICY_SOURCE_PREFIX}${POLICY_SOURCE}`, `${MODERATION_POLICY_SOURCE_PREFIX}${POLICY_SOURCE}`]).policySource,
    { state: 'value', value: POLICY_SOURCE },
  );
  // 形状判据本身：策略标识 vs BizType（BizType 直接复用 `live-ports.ts` 的那一个，避免第二套真理）。
  assert.equal(MODERATION_POLICY_SOURCE_PATTERN.test(POLICY_SOURCE), true);
  assert.equal(MODERATION_POLICY_SOURCE_PATTERN.test('bad policy source'), false);
  assert.equal(MODERATION_POLICY_SOURCE_PATTERN.test(''), false);
  assert.equal(MODERATION_POLICY_SOURCE_PATTERN.test('x'.repeat(121)), false);
  assert.equal(MODERATION_BIZ_TYPE_PATTERN.test(BIZ_TYPE), true);
  assert.equal(MODERATION_BIZ_TYPE_PATTERN.test('bad biz*type'), false);
});

// ---------------------------------------------------------------- ② 零外呼（六臂一次覆盖）

test('零外呼绊线：六臂「解析 + 装配」（loadConfig + 决定点 + buildApp）合计 globalThis.fetch 计数恒 0', async () => {
  await withFetchTripwire(async (calls) => {
    for (const arm of ARMS) {
      const env = arm.credentials ? realEnvWithTencentCredentials() : realEnv();
      const { app } = await assemble({ env, argv: arm.argv });
      // 只读能力位（不触发任何端口调用）：装配路径本身必须零外呼。
      app.moderationService.capabilities();
      await app.close();
    }
    assert.equal(calls.length, 0, `装配路径共发起 ${calls.length} 次外呼，必须是 0`);
  });
});

// ---------------------------------------------------------------- ③ 等价性（不批准 == 没给开关）

test('等价性：不批准的臂，capabilities() 与「完全不给开关」逐字段相同，且送审仍 503 fail-closed', async () => {
  await withFetchTripwire(async (calls) => {
    // 基准臂 = 完全不提这个开关（= 改前的生产行为）。
    const baseline = await assemble({ env: realEnvWithTencentCredentials(), argv: [] });
    let baselineCapabilities;
    let baselineRejection;
    try {
      baselineCapabilities = baseline.app.moderationService.capabilities();
      baselineRejection = await rejectionOf(baseline.app.moderationService);
      // 基准臂就是今天的样子：审核域整域 503（模型层"没有结论"≠"通过"）。
      assert.deepEqual(baselineCapabilities.text, {
        content_kind: 'text',
        port_kind: 'tms',
        state: 'none',
        ready: false,
        origin: 'none',
      });
      assert.equal(baselineRejection.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(baselineRejection.retryable, false);
      assert.deepEqual(baseline.warnings, [], '没给开关时不该多出一行 warn（默认路径不发声）');
      assert.deepEqual(baseline.assembly, {}, '没给开关时一个装配字段都不传');
    } finally {
      await baseline.app.close();
    }

    for (const arm of ARMS.slice(1, 5)) {
      const env = arm.credentials ? realEnvWithTencentCredentials() : realEnv();
      const { app, warnings, assembly } = await assemble({ env, argv: arm.argv });
      try {
        // 逐字段等价：多给一个**不成立**的开关，必须与完全不给逐字相同。
        assert.deepEqual(app.moderationService.capabilities(), baselineCapabilities, `${arm.id} ${arm.label}: 能力位必须与改前逐字段相同`);
        assert.deepEqual(await rejectionOf(app.moderationService), baselineRejection, `${arm.id} ${arm.label}: 拒绝必须逐字段相同`);
        assert.deepEqual(assembly, {}, `${arm.id} ${arm.label}: 不铸造就一个装配字段都不许传`);
        assert.equal(warnings.length, 1, `${arm.id} ${arm.label}: 恰好一行 warn（点名缺哪一条）`);
      } finally {
        await app.close();
      }
    }
    assert.equal(calls.length, 0);
  });
});

test('等价性·正控制：四条全过 ⇒ 审核域真的 wired（不是"永远 503"的假绿）', async () => {
  await withFetchTripwire(async (calls) => {
    const { app, assembly, warnings } = await assemble({ env: realEnvWithTencentCredentials(), argv: ARMS[5].argv });
    try {
      const capabilities = app.moderationService.capabilities();
      assert.deepEqual(
        { text: capabilities.text.state, ready: capabilities.text.ready, origin: capabilities.text.origin },
        { text: 'wired', ready: true, origin: 'injected' },
        '`wired` 只可能来自 `liveWiring`：`resolveModerationPorts` 的 real 分支只认 `live`',
      );
      assert.deepEqual({ image: capabilities.image.state, imageReady: capabilities.image.ready }, { image: 'wired', imageReady: true });
      assert.deepEqual(warnings, [], '四条全过时不该有拒绝 warn');
      assert.deepEqual(Object.keys(assembly), ['moderationInjection'], '只产出 moderationInjection 一个装配键');
      assert.deepEqual(Object.keys(assembly.moderationInjection), ['liveApproval'], '只传 liveApproval 一个键');
    } finally {
      await app.close();
    }
    // 本臂**不**送审：真实端口一旦被调用就会碰网络，本文件明确不发起任何真实外呼。
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------- ④ 对象身份（WeakSet 的意义）

test('对象身份：克隆/派生一份合法 approval 传进 buildApp 必须不被接受（仍 503）', async () => {
  await withFetchTripwire(async (calls) => {
    const config = loadConfig(realEnvWithTencentCredentials());
    const plan = resolveModerationStartupApproval({ config, argv: ARMS[5].argv });
    assert.equal(isModerationLiveWiringApproved(plan.liveApproval), true, '铸造产物必须是批准能力');

    // 三种"看起来一模一样"的伪造：浅克隆、原型派生、结构化克隆。
    const forged = [
      { label: '浅克隆', value: { ...plan.liveApproval } },
      { label: '原型派生', value: Object.create(plan.liveApproval) },
      { label: '结构化克隆', value: structuredClone(plan.liveApproval) },
      {
        label: '同形状字面量',
        value: { reason: 'forged', approvedAt: '2026-10-30T00:00:00.000Z', policySource: POLICY_SOURCE, bizType: BIZ_TYPE },
      },
    ];
    for (const item of forged) {
      assert.equal(isModerationLiveWiringApproved(item.value), false, `${item.label} 不是铸造产物（对象身份判定）`);
      const forgedApp = buildApp({
        config,
        store: persistentAuthStore(),
        moderationInjection: { liveApproval: item.value },
      });
      try {
        assert.equal(forgedApp.moderationService.capabilities().text.state, 'none', `${item.label} 必须不被接受`);
        const rejection = await rejectionOf(forgedApp.moderationService);
        assert.equal(rejection.code, 'PROVIDER_UNAVAILABLE');
        assert.equal(rejection.retryable, false);
      } finally {
        await forgedApp.close();
      }
    }
    assert.equal(calls.length, 0, '伪造臂同样必须零外呼');
  });
});

// ---------------------------------------------------------------- ⑤ 输入只认启动参数（不从 env 取）

test('输入只认启动参数：同名值塞进 env 而不进 argv ⇒ 仍然不铸造', async () => {
  await withFetchTripwire(async (calls) => {
    // env 里有"看起来齐备"的值（甚至用的是同名概念），但 argv 不给开关 ⇒ 不铸造。
    const env = realEnvWithTencentCredentials({
      MODERATION_POLICY_SOURCE: POLICY_SOURCE,
      MODERATION_BIZ_TYPE: BIZ_TYPE,
      MODERATION_LIVE_WIRING_APPROVED: 'true',
    });
    const config = loadConfig(env);
    const plan = resolveModerationStartupApproval({ config, argv: [] });
    assert.equal(plan.minted, false, '环境变量不得成为门（配置即门控已被两轮对抗复审否掉）');
    assert.equal(plan.liveApproval, null);
    assert.equal(plan.reason, null);

    // 给了开关但仍不读 env：argv 里只有开关、没有两个值 ⇒ 不铸造（若实现偷偷读 env，这一臂会变绿）。
    const envOnly = resolveModerationStartupApproval({ config, argv: [MODERATION_LIVE_WIRING_FLAG] });
    assert.equal(envOnly.minted, false);
    assert.equal(envOnly.reason, 'missing_approval');

    // 结构面：本模块一次都不许读 ambient env，也不许自己退出进程（**去注释后**判定：注释里说明
    // 「不读 process.env」不算读取——与 `tests/unit/moderation-live-wiring-assembly.test.mjs` 同口径）。
    const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const source = stripComments(readFileSync(join(ROOT, 'services/api/src/moderation/startup-approval.ts'), 'utf8'));
    for (const forbidden of ['process.env', 'process.exit', 'fetch(', 'node:http', 'node:https']) {
      assert.equal(source.includes(forbidden), false, `startup-approval.ts（去注释）不得出现 ${forbidden}`);
    }
    // 生产入口只转发：解析/判定/铸造/文案都不在 server.ts 里。
    const server = readFileSync(join(ROOT, 'services/api/src/server.ts'), 'utf8');
    assert.equal(server.includes('approveModerationLiveWiring('), false, 'server.ts 不得调用铸造点（只转发）');
    assert.equal(server.match(/moderationStartupAssemblyOptions\(/g)?.length, 1, '入口只允许一处转发');
    assert.equal(server.match(/console\.warn\(/g)?.length, 1, '入口只允许一处 warn 出口（恰好一行）');
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------- ⑥ 凭据判据与 #777 的决定点同口径

test('凭据判据与 #777 的 resolve 同口径（前置镜像不得与决定点漂移）', async () => {
  await withFetchTripwire(async (calls) => {
    const weakCredentialSets = [
      { secretId: '', secretKey: SECRET_KEY, sessionToken: '' },
      { secretId: SECRET_ID, secretKey: '', sessionToken: '' },
      { secretId: '   ', secretKey: SECRET_KEY, sessionToken: '' },
      { secretId: SECRET_ID, secretKey: SECRET_KEY, sessionToken: undefined },
      null,
    ];
    const approval = approveModerationLiveWiring({ reason: 'r70-parity', policySource: POLICY_SOURCE, bizType: BIZ_TYPE });
    for (const credentials of weakCredentialSets) {
      // ① `#777` 的纯决定函数：批准能力已铸造，但凭据不齐 ⇒ missing_credentials。
      const decision = resolveModerationLiveWiring({ executionMode: 'real', approval, credentials });
      assert.equal(decision.wiring, null);
      assert.equal(decision.refusal?.reason, 'missing_credentials');
      // ② 本片的前置镜像：同一个"不齐"必须得出同一个原因（不是各判一套）。
      const plan = resolveModerationStartupApproval({
        config: { executionMode: 'real', moderationLive: credentials === null ? null : { credentials } },
        argv: ARMS[5].argv,
      });
      assert.equal(plan.minted, false, '凭据不齐时绝不铸造');
      assert.equal(plan.reason, decision.refusal.reason, '前置镜像与决定点必须给出同一个原因');
    }
    assert.equal(calls.length, 0);
  });
});
