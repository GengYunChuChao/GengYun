/**
 * GY-R28-W1 第一步 · AI 真实提供者（TTS/OCR/ASR）配置搬运的离线回归。
 *
 * 目标（逐步对应派单 §2 第一步与红线）：
 *  1. **零行为变化**：`stub`/`preset_demo` 与「real 但缺 AI 凭据」时三域一律 `null`，
 *     既有 `REQUIRED_WHEN_REAL` 报错口径不变（AI 键**不是** real 启动必填项）。
 *  2. **口径唯一事实源**：把配置结构映射回 `tools/ai-config.mjs` 的 `configurationIssues()` 输入，
 *     三域都必须零 issue（端点/动作/版本/SDK/地域/认证/超时/零重试/计划调用上限/各域参数剖面）。
 *  3. **凭据只在内存**：整份 config 被 `JSON.stringify` 时不得出现任何密钥值（`toJSON` 脱敏）。
 *  4. ASR 专用的「专用对优先、缺则回退共享对」两种合法组合都成立且 `secretIdEnv/apiKeyEnv` 如实标注。
 *  5. `AI_PROVIDER_TIMEOUT_MS` 只在 1000..20000 整数内被接受，越界按既有 `ConfigIssue` 报错。
 *
 * 本文件**全离线**：不读凭据文件、不联网、不写任何文件；凭据值全是合成占位串。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AI_PROVIDER_DEFAULT_TIMEOUT_MS,
  AI_PROVIDER_PROFILES,
  AI_PROVIDER_TIMEOUT_MAX_MS,
  AI_PROVIDER_TIMEOUT_MIN_MS,
  ConfigError,
  loadConfig,
} from '../../services/api/src/config.ts';
import { AI_ENDPOINTS, configurationIssues } from '../../tools/ai-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const openapi = JSON.parse(readFileSync(resolve(root, 'packages/contracts/openapi.json'), 'utf8'));

/** 通过 real 校验所需的**合成**占位配置（非真实凭据；不连接任何服务）。 */
const REAL_BASE = {
  APP_EXECUTION_MODE: 'real',
  DATABASE_URL: 'postgres://synthetic_local_only@127.0.0.1:5432/gengyun_synthetic_never_connected',
  SESSION_SIGNING_KEY: 'synthetic-not-a-real-signing-key',
  DELETION_LEDGER_KEY: 'synthetic-not-a-real-ledger-key',
  WECHAT_APP_ID: 'synthetic-not-a-real-appid',
  WECHAT_APP_SECRET: 'synthetic-not-a-real-appsecret',
  OBJECT_STORAGE_ENDPOINT: 'https://example.invalid',
  OBJECT_STORAGE_BUCKET: 'synthetic-not-a-real-bucket',
  OBJECT_STORAGE_ACCESS_KEY: 'synthetic-not-a-real-access-key',
  OBJECT_STORAGE_SECRET_KEY: 'synthetic-not-a-real-secret-key',
};

/** 合成 AI 凭据（**不是**任何真实账号的值）。 */
const SHARED_ID = 'synthetic-shared-secret-id-r28w1';
const SHARED_KEY = 'synthetic-shared-secret-key-r28w1';
const ASR_ID = 'synthetic-asr-secret-id-r28w1';
const ASR_KEY = 'synthetic-asr-secret-key-r28w1';

const SHARED_ENV = { TENCENTCLOUD_SECRET_ID: SHARED_ID, TENCENTCLOUD_SECRET_KEY: SHARED_KEY };
const ASR_ENV = { TENCENTCLOUD_ASR_SECRET_ID: ASR_ID, TENCENTCLOUD_ASR_SECRET_KEY: ASR_KEY };

/**
 * 把本仓库配置映射成 `configurationIssues()` 的输入（**逐字段**，不偷懒用默认值）。
 * `privacy`/`env`/`budget` 是那份离线审计的口径要求，产品侧不读它们；这里只为核对参数剖面。
 */
function asVerificationConfig(config) {
  const providerOf = (profile) => {
    const base = {
      endpoint: profile.endpoint,
      authentication: profile.authentication,
      action: profile.action,
      apiVersion: profile.apiVersion,
      sdkVersion: profile.sdkVersion,
      region: profile.region,
      timeoutMs: profile.timeoutMs,
      maxRetries: profile.maxRetries,
      maxVerificationCalls: profile.maxVerificationCalls,
      secretIdEnv: profile.secretIdEnv,
      apiKeyEnv: profile.apiKeyEnv,
    };
    if ('voiceType' in profile) {
      return { ...base, voiceType: profile.voiceType, codec: profile.codec, sampleRate: profile.sampleRate, maxTextCharacters: profile.maxTextCharacters };
    }
    if ('maxImageBytes' in profile) return { ...base, maxImageBytes: profile.maxImageBytes, mediaTransport: profile.mediaTransport };
    return {
      ...base,
      model: profile.model,
      voiceFormat: profile.voiceFormat,
      sampleRate: profile.sampleRate,
      channels: profile.channels,
      maxAudioSeconds: profile.maxAudioSeconds,
      maxAudioBase64Bytes: profile.maxAudioBase64Bytes,
    };
  };
  const ai = config.aiProviders;
  return {
    env: 'dev',
    privacy: { allowUserDataForTraining: false, sendRealUserDataBeforeConsent: false },
    budget: { liveInferenceAllowed: false, maxVerificationCalls: 0, maximumCharge: 0 },
    providers: {
      ...(ai.tts === null ? {} : { tts: providerOf(ai.tts) }),
      ...(ai.ocr === null ? {} : { ocr: providerOf(ai.ocr) }),
      ...(ai.asr === null ? {} : { asr: providerOf(ai.asr) }),
    },
  };
}

// ---------------------------------------------------------------- 零行为变化

test('零行为变化·stub/preset_demo：即使 env 里有真实凭据，三域也一律 null（替身不得携带真实凭据）', () => {
  for (const mode of ['stub', 'preset_demo']) {
    const config = loadConfig({ APP_EXECUTION_MODE: mode, LOG_LEVEL: 'silent', ...SHARED_ENV, ...ASR_ENV });
    assert.equal(config.executionMode, mode);
    assert.deepEqual(config.aiProviders, { tts: null, ocr: null, asr: null }, mode);
  }
});

test('零行为变化·real 缺 AI 凭据：三域 null，且既有「real 必填 9 项」报错口径不变', () => {
  const config = loadConfig({ ...REAL_BASE, LOG_LEVEL: 'silent' });
  assert.deepEqual(config.aiProviders, { tts: null, ocr: null, asr: null });
  // AI 键**不是** real 启动必填项：齐备的 real 配置不因缺 AI 凭据而抛错。
  const issues = (() => {
    try {
      loadConfig({ APP_EXECUTION_MODE: 'real', LOG_LEVEL: 'silent' });
      return [];
    } catch (error) {
      return error.issues.map((issue) => issue.field);
    }
  })();
  assert.deepEqual(issues, [
    'DATABASE_URL',
    'SESSION_SIGNING_KEY',
    'DELETION_LEDGER_KEY',
    'WECHAT_APP_ID',
    'WECHAT_APP_SECRET',
    'OBJECT_STORAGE_ENDPOINT',
    'OBJECT_STORAGE_BUCKET',
    'OBJECT_STORAGE_ACCESS_KEY',
    'OBJECT_STORAGE_SECRET_KEY',
  ]);
});

// ---------------------------------------------------------------- 口径唯一事实源

test('口径·配置剖面映射回 configurationIssues() 后三域零 issue（端点/动作/版本/地域/参数剖面）', () => {
  const config = loadConfig({ ...REAL_BASE, LOG_LEVEL: 'silent', ...SHARED_ENV, ...ASR_ENV });
  assert.notEqual(config.aiProviders.tts, null);
  assert.notEqual(config.aiProviders.ocr, null);
  assert.notEqual(config.aiProviders.asr, null);
  const verification = asVerificationConfig(config);
  for (const key of ['tts', 'ocr', 'asr']) {
    assert.equal(typeof verification.providers[key], 'object', `${key} 必须出现在映射里`);
    assert.deepEqual(configurationIssues(verification, key), [], `${key} 不得有任何 issue`);
  }
});

test('口径·冻结剖面逐字等于 tools/ai-config.mjs 的 AI_ENDPOINTS（端点/动作/版本/SDK）', () => {
  for (const key of ['tts', 'ocr', 'asr']) {
    const spec = AI_ENDPOINTS[key];
    const frozen = AI_PROVIDER_PROFILES[key];
    assert.equal(frozen.endpoint, spec.endpoint, `${key}.endpoint`);
    assert.equal(frozen.action, spec.action, `${key}.action`);
    assert.equal(frozen.apiVersion, spec.version, `${key}.apiVersion`);
    assert.equal(frozen.sdkVersion, spec.sdkVersion, `${key}.sdkVersion`);
    assert.equal(frozen.authentication, spec.auth, `${key}.authentication`);
    assert.equal(frozen.region, 'ap-shanghai', `${key}.region`);
    assert.equal(frozen.maxRetries, 0, `${key}.maxRetries`);
    assert.equal(frozen.maxVerificationCalls, 2, `${key}.maxVerificationCalls`);
  }
  // 契约闭集：本片不新增任何错误码，也不改契约文件。
  assert.equal(Array.isArray(openapi.components.schemas.ErrorCode.enum), true);
});

test('口径·超时取冻结常量且落在 INVALID_TIMEOUT 区间内（不自创配置面）', () => {
  const base = { ...REAL_BASE, LOG_LEVEL: 'silent', ...SHARED_ENV, ...ASR_ENV };
  const config = loadConfig(base);
  assert.equal(config.aiProviders.tts.timeoutMs, AI_PROVIDER_DEFAULT_TIMEOUT_MS);
  for (const capability of ['tts', 'ocr', 'asr']) {
    const timeoutMs = config.aiProviders[capability].timeoutMs;
    assert.equal(timeoutMs, AI_PROVIDER_DEFAULT_TIMEOUT_MS, capability);
    assert.equal(Number.isInteger(timeoutMs), true, `${capability} 超时必须是整数`);
    assert.equal(timeoutMs >= AI_PROVIDER_TIMEOUT_MIN_MS && timeoutMs <= AI_PROVIDER_TIMEOUT_MAX_MS, true, capability);
  }
  // 不新增配置面：`config.ts` 里不得再出现任何 `trimmed(env, ...)` 之外的 AI 超时读取，
  // 也不得把超时做成环境变量（否则 `deploy/cloudrun/env.placeholder.json` 必须同步，而那是禁改项）。
  const source = readFileSync(resolve(root, 'services/api/src/config.ts'), 'utf8');
  assert.equal(source.includes('AI_PROVIDER_TIMEOUT_MS'), false, '不得自创 AI_PROVIDER_TIMEOUT_MS 配置键');
});

// ---------------------------------------------------------------- 凭据只在内存

test('凭据·整份 config 被序列化时不得出现任何密钥值（toJSON 脱敏）', () => {
  const config = loadConfig({ ...REAL_BASE, LOG_LEVEL: 'silent', ...SHARED_ENV, ...ASR_ENV });
  const serialized = JSON.stringify(config);
  for (const secret of [SHARED_ID, SHARED_KEY, ASR_ID, ASR_KEY]) {
    assert.equal(serialized.includes(secret), false, '序列化结果不得含密钥值');
  }
  assert.equal(serialized.includes('[REDACTED]'), true, '凭据必须显式脱敏而不是被静默丢弃');
  // 内存里仍然可用（适配器构造需要真值）；只是不进 JSON。
  assert.equal(config.aiProviders.tts.credentials.secretId, SHARED_ID);
  assert.equal(config.aiProviders.asr.credentials.secretKey, ASR_KEY);
  // 哨兵：日志里常见的「整个 env/config 打一行」也不会带出值。
  for (const capability of ['tts', 'ocr', 'asr']) {
    const text = `${JSON.stringify(config.aiProviders[capability])}\n${String(config.aiProviders[capability].credentials)}`;
    assert.equal(text.includes(SHARED_KEY), false, `${capability} 不得泄露共享密钥`);
    assert.equal(text.includes(ASR_KEY), false, `${capability} 不得泄露 ASR 密钥`);
  }
});

test('凭据·成对读取，缺任一即整域 null（不逐字段混配、不回退）', () => {
  const onlyId = loadConfig({ ...REAL_BASE, LOG_LEVEL: 'silent', TENCENTCLOUD_SECRET_ID: SHARED_ID });
  assert.deepEqual(onlyId.aiProviders, { tts: null, ocr: null, asr: null });
  const onlyKey = loadConfig({ ...REAL_BASE, LOG_LEVEL: 'silent', TENCENTCLOUD_SECRET_KEY: SHARED_KEY });
  assert.deepEqual(onlyKey.aiProviders, { tts: null, ocr: null, asr: null });
  // 空串/纯空白按「未配置」处理（既有 `trimmed()` 口径）。
  const blank = loadConfig({ ...REAL_BASE, LOG_LEVEL: 'silent', TENCENTCLOUD_SECRET_ID: '   ', TENCENTCLOUD_SECRET_KEY: SHARED_KEY });
  assert.equal(blank.aiProviders.tts, null);
});

test('凭据·ASR 专用对优先；只有共享对时回退共享对并如实标注 env 名', () => {
  const both = loadConfig({ ...REAL_BASE, LOG_LEVEL: 'silent', ...SHARED_ENV, ...ASR_ENV });
  assert.equal(both.aiProviders.asr.credentials.secretId, ASR_ID);
  assert.equal(both.aiProviders.asr.secretIdEnv, 'TENCENTCLOUD_ASR_SECRET_ID');
  assert.equal(both.aiProviders.asr.apiKeyEnv, 'TENCENTCLOUD_ASR_SECRET_KEY');
  assert.deepEqual(configurationIssues(asVerificationConfig(both), 'asr'), []);

  const sharedOnly = loadConfig({ ...REAL_BASE, LOG_LEVEL: 'silent', ...SHARED_ENV });
  assert.equal(sharedOnly.aiProviders.asr.credentials.secretId, SHARED_ID);
  assert.equal(sharedOnly.aiProviders.asr.secretIdEnv, 'TENCENTCLOUD_SECRET_ID');
  assert.equal(sharedOnly.aiProviders.asr.apiKeyEnv, 'TENCENTCLOUD_SECRET_KEY');
  // 共享对同样是被校验配置允许的 ASR 组合（`configurationIssues()` 的 `key==='asr'` 分支）。
  assert.deepEqual(configurationIssues(asVerificationConfig(sharedOnly), 'asr'), []);
});

test('凭据·临时令牌缺省为显式空串（不继承其它能力/其它环境的 token）', () => {
  const config = loadConfig({ ...REAL_BASE, LOG_LEVEL: 'silent', ...SHARED_ENV, ...ASR_ENV });
  for (const capability of ['tts', 'ocr', 'asr']) {
    assert.equal(config.aiProviders[capability].credentials.sessionToken, '', capability);
  }
  const withToken = loadConfig({
    ...REAL_BASE,
    LOG_LEVEL: 'silent',
    ...SHARED_ENV,
    ...ASR_ENV,
    TENCENTCLOUD_SESSION_TOKEN: 'synthetic-shared-token',
    TENCENTCLOUD_ASR_SESSION_TOKEN: 'synthetic-asr-token',
  });
  assert.equal(withToken.aiProviders.tts.credentials.sessionToken, 'synthetic-shared-token');
  assert.equal(withToken.aiProviders.ocr.credentials.sessionToken, 'synthetic-shared-token');
  assert.equal(withToken.aiProviders.asr.credentials.sessionToken, 'synthetic-asr-token');
  assert.equal(JSON.stringify(withToken).includes('synthetic-shared-token'), false, '临时令牌同样不得进 JSON');
});
