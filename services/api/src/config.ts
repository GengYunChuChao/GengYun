/**
 * 配置加载与校验。
 *
 * 规则：
 * - 缺少必填配置时抛出 ConfigError，并一次性列出所有缺失/非法的字段名（不静默用默认值顶替）。
 * - 真实模式（real）必须提供数据库与密钥配置；替身/演示模式不要求真实凭据。
 * - 只读取进程环境，不写入任何文件，不回显敏感值。
 */
import { EXECUTION_MODES, type ExecutionMode } from './contract.ts';

export interface AppConfig {
  /** 执行模式，契约 ExecutionMode。响应 meta.execution_mode 必填。 */
  executionMode: ExecutionMode;
  /** 监听地址，默认 127.0.0.1（不默认绑定 0.0.0.0）。 */
  host: string;
  /** 监听端口，默认 3000。 */
  port: number;
  /** 日志级别。 */
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  /** 真实数据库连接串；替身/演示模式可为 null（健康检查如实报告未配置）。 */
  databaseUrl: string | null;
  /** 数据库健康检查超时（毫秒）。 */
  databaseHealthTimeoutMs: number;
  /** 是否为真实模式（真实模式要求全部凭据齐备）。 */
  requiresRealCredentials: boolean;
  /** 微信小程序 AppID；仅服务端读取，绝不进仓库、不下发客户端。real 模式必填。 */
  wechatAppId: string | null;
  /** 微信 AppSecret；仅服务端读取。real 模式必填，绝不回显、不记日志。 */
  wechatAppSecret: string | null;
  /** 会话签名密钥；real 模式必填。用作微信身份摘要（HMAC）的密钥。 */
  sessionSigningKey: string | null;
  /** 首次启动的管理员初始化凭据（可选；仅从环境变量读取，出库为 scrypt 摘要）。 */
  adminBootstrap: { loginName: string; password: string } | null;
  /**
   * `AccessGrant.url` 的访问网关原点（`https://<host>[:port]`，来自 `MEDIA_ACCESS_GRANT_ORIGIN`）。
   *
   * `null` = 未配置 ⇒ 媒体域沿用**占位、不可解析**的默认域（RFC 6761 `.invalid`，句柄由部署期
   * 访问网关解析，本仓库不提供该数据面）；非 `null` 时装配层须显式注入
   * `createAppMediaService({ accessGrantOrigin })`（媒体域文件**不读** ambient env，见其选项注释）。
   */
  mediaAccessGrantOrigin: string | null;
  /**
   * AI 真实提供者（TTS / OCR / ASR）的结构化配置（GY-R28-W1 接线）。
   *
   * **不是** real 模式的启动必填项：缺凭据时对应能力为 `null`，域内仍走接线前的 fail-closed
   * （逐字节不变）。只有 `executionMode==='real'` 且**该能力凭据齐备**时才非 null；
   * 其它模式恒为三域 `null`（替身/演示不得携带真实供应商凭据）。
   *
   * 口径唯一事实源：`tools/ai-config.mjs` 的 `AI_ENDPOINTS` 与 `configurationIssues()`
   * （端点/动作/版本/地域/音色/编码/采样率/文本上限/图片上限/音频剖面/超时区间/零重试）。
   * 本模块不 import `tools/**`（`services/api` 的 tsconfig `rootDir: src`），
   * 同口径由 `tests/unit/ai-provider-config.test.mjs` 反向核对（把本结构映射成
   * `configurationIssues()` 的输入并断言零 issue）。
   *
   * **密钥只在内存**：`credentials` 只从 `process.env`（或其显式传入的等价 env 对象）读取，
   * 不落文件、不进日志、不进响应；其 `toJSON()` 被显式改写为脱敏串，避免整份 config 被序列化时泄露。
   */
  aiProviders: AiProvidersConfig;
}

export interface ConfigIssue {
  /** 环境变量名（字段名）。 */
  field: string;
  /** invalid_missing：未提供；invalid_value：提供了但非法。 */
  code: 'MISSING' | 'INVALID_VALUE';
  /** 人类可读说明，不含敏感值。 */
  reason: string;
}

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    const fields = issues.map((issue) => issue.field).join(', ');
    super(`配置校验失败，缺少或非法字段：${fields}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

type Env = Record<string, string | undefined>;

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** 真实模式必须齐备的服务端配置（字段名即契约 ADR-001“配置值只在服务端安全配置”所列）。 */
export const REQUIRED_WHEN_REAL = [
  'DATABASE_URL',
  'SESSION_SIGNING_KEY',
  'DELETION_LEDGER_KEY',
  'WECHAT_APP_ID',
  'WECHAT_APP_SECRET',
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_BUCKET',
  'OBJECT_STORAGE_ACCESS_KEY',
  'OBJECT_STORAGE_SECRET_KEY',
] as const;

function trimmed(env: Env, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const t = value.trim();
  return t === '' ? undefined : t;
}

/** 后台初始管理员口令最小长度（防止把弱口令写进环境模板）。 */
export const ADMIN_BOOTSTRAP_PASSWORD_MIN_LENGTH = 12;

/** 解析可选的初始管理员配置：两者要么都不设，要么同时设；口令不写进任何输出。 */
function asBootstrap(env: Env, issues: ConfigIssue[]): AppConfig['adminBootstrap'] {
  const loginName = trimmed(env, 'ADMIN_BOOTSTRAP_LOGIN_NAME');
  const password = trimmed(env, 'ADMIN_BOOTSTRAP_PASSWORD');
  if (loginName === undefined && password === undefined) return null;
  if (loginName === undefined) {
    issues.push({
      field: 'ADMIN_BOOTSTRAP_LOGIN_NAME',
      code: 'MISSING',
      reason: '设置 ADMIN_BOOTSTRAP_PASSWORD 时必须同时提供 ADMIN_BOOTSTRAP_LOGIN_NAME',
    });
    return null;
  }
  if (password === undefined) {
    issues.push({
      field: 'ADMIN_BOOTSTRAP_PASSWORD',
      code: 'MISSING',
      reason: '设置 ADMIN_BOOTSTRAP_LOGIN_NAME 时必须同时提供 ADMIN_BOOTSTRAP_PASSWORD',
    });
    return null;
  }
  if (password.length < ADMIN_BOOTSTRAP_PASSWORD_MIN_LENGTH) {
    issues.push({
      field: 'ADMIN_BOOTSTRAP_PASSWORD',
      code: 'INVALID_VALUE',
      reason: `至少 ${ADMIN_BOOTSTRAP_PASSWORD_MIN_LENGTH} 字符`,
    });
    return null;
  }
  if (loginName.length > 80) {
    issues.push({ field: 'ADMIN_BOOTSTRAP_LOGIN_NAME', code: 'INVALID_VALUE', reason: '最长 80 字符' });
    return null;
  }
  return { loginName, password };
}

function isPostgresUrl(value: string): boolean {
  return /^postgres(ql)?:\/\/\S+$/i.test(value);
}

/**
 * 校验访问网关原点：只接受 `https://<host>[:port]`（不带路径/查询/凭据），返回规范化 origin。
 *
 * 与 `services/api/src/media/service.ts` 的 `normalizeMediaAccessGrantOrigin` 判据同形 —— 两处都校验
 * 是**刻意的纵深**：这里挡住「配置读入错」，那里挡住「装配层注入错」；不共用是为了不让配置模块反向
 * 依赖媒体域（媒体域也不读 ambient env）。
 */
function asHttpsOrigin(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') return null;
  if (parsed.hostname === '') return null;
  return parsed.origin;
}

/**
 * 从环境变量加载配置；不合法则抛出 ConfigError，issues 列出全部问题字段。
 */
export function loadConfig(env: Env = process.env): AppConfig {
  const issues: ConfigIssue[] = [];

  const modeRaw = trimmed(env, 'APP_EXECUTION_MODE');
  let executionMode: ExecutionMode;
  if (modeRaw === undefined) {
    issues.push({
      field: 'APP_EXECUTION_MODE',
      code: 'MISSING',
      reason: `必须显式设置，取值为 ${EXECUTION_MODES.join(' | ')}`,
    });
    executionMode = 'stub';
  } else if ((EXECUTION_MODES as readonly string[]).includes(modeRaw)) {
    executionMode = modeRaw as ExecutionMode;
  } else {
    issues.push({
      field: 'APP_EXECUTION_MODE',
      code: 'INVALID_VALUE',
      reason: `必须为 ${EXECUTION_MODES.join(' | ')}，实际不在允许集合内`,
    });
    executionMode = 'stub';
  }

  const host = trimmed(env, 'API_HOST') ?? '127.0.0.1';

  const portRaw = trimmed(env, 'API_PORT');
  let port = 3000;
  if (portRaw !== undefined) {
    const parsed = Number(portRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      issues.push({ field: 'API_PORT', code: 'INVALID_VALUE', reason: '必须是 1..65535 的整数' });
    } else {
      port = parsed;
    }
  }

  const logRaw = trimmed(env, 'LOG_LEVEL');
  let logLevel: AppConfig['logLevel'] = 'info';
  if (logRaw !== undefined) {
    if ((LOG_LEVELS as readonly string[]).includes(logRaw)) {
      logLevel = logRaw as AppConfig['logLevel'];
    } else {
      issues.push({
        field: 'LOG_LEVEL',
        code: 'INVALID_VALUE',
        reason: `必须为 ${LOG_LEVELS.join(' | ')}`,
      });
    }
  }

  const timeoutRaw = trimmed(env, 'DATABASE_HEALTH_TIMEOUT_MS');
  let databaseHealthTimeoutMs = 2000;
  if (timeoutRaw !== undefined) {
    const parsed = Number(timeoutRaw);
    if (!Number.isInteger(parsed) || parsed < 100 || parsed > 60000) {
      issues.push({
        field: 'DATABASE_HEALTH_TIMEOUT_MS',
        code: 'INVALID_VALUE',
        reason: '必须是 100..60000 的整数（毫秒）',
      });
    } else {
      databaseHealthTimeoutMs = parsed;
    }
  }

  const databaseUrlRaw = trimmed(env, 'DATABASE_URL');
  if (databaseUrlRaw !== undefined && !isPostgresUrl(databaseUrlRaw)) {
    issues.push({
      field: 'DATABASE_URL',
      code: 'INVALID_VALUE',
      reason: '必须是 postgres:// 或 postgresql:// 连接串',
    });
  }
  const databaseUrl = databaseUrlRaw !== undefined && isPostgresUrl(databaseUrlRaw) ? databaseUrlRaw : null;

  const wechatAppId = trimmed(env, 'WECHAT_APP_ID') ?? null;
  const wechatAppSecret = trimmed(env, 'WECHAT_APP_SECRET') ?? null;
  const sessionSigningKey = trimmed(env, 'SESSION_SIGNING_KEY') ?? null;
  const adminBootstrap = asBootstrap(env, issues);
  // 访问网关原点：可选。未配置 ⇒ null（媒体域用占位/不可解析默认域，句柄由部署期网关解析）。
  const mediaOriginRaw = trimmed(env, 'MEDIA_ACCESS_GRANT_ORIGIN');
  let mediaAccessGrantOrigin: string | null = null;
  if (mediaOriginRaw !== undefined) {
    const normalized = asHttpsOrigin(mediaOriginRaw);
    if (normalized === null) {
      issues.push({
        field: 'MEDIA_ACCESS_GRANT_ORIGIN',
        code: 'INVALID_VALUE',
        reason: '必须是 https://<host>[:port] 形式的访问网关原点（不带路径/查询/凭据）',
      });
    } else {
      mediaAccessGrantOrigin = normalized;
    }
  }

  // AI 真实提供者（TTS/OCR/ASR）：**只在 real 且凭据齐备**时非 null；缺省与接线前逐字节一致。
  const aiProviders = asAiProviders(env, executionMode);

  if (executionMode === 'real') {
    for (const field of REQUIRED_WHEN_REAL) {
      const value = trimmed(env, field);
      if (value === undefined) {
        // DATABASE_URL 已在上方按连接串校验，避免重复报同一字段。
        if (field === 'DATABASE_URL' && databaseUrlRaw !== undefined) continue;
        issues.push({
          field,
          code: 'MISSING',
          reason: '真实模式（APP_EXECUTION_MODE=real）必须提供该服务端配置',
        });
      }
    }
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return {
    executionMode,
    host,
    port,
    logLevel,
    databaseUrl,
    databaseHealthTimeoutMs,
    requiresRealCredentials: executionMode === 'real',
    wechatAppId,
    wechatAppSecret,
    sessionSigningKey,
    adminBootstrap,
    mediaAccessGrantOrigin,
    aiProviders,
  };
}

// ===========================================================================
// GY-R28-W1 · AI 真实提供者（TTS / OCR / ASR）配置搬运
//
// 为什么放在 `loadConfig` **之后**（按追加而非插入）：`docs/architecture/contract-status.json`
// 把 `loadConfig` 的行号区间当作证据锚点（`dimension execution_modes`：`config.ts:155-283`，
// 锚点 `loadConfig`，容差 ±2 行），而该 JSON 在本片是禁改项。类型与解析函数在 TS 里
// 可以先使用后声明（函数声明提升、接口纯类型），因此追加即可，锚点不动。
//
// 口径唯一事实源＝`tools/ai-config.mjs` 的 `AI_ENDPOINTS` 与 `configurationIssues()`：
//   · 端点/动作/版本/SDK 版本/地域/认证方案逐项冻结在 `AI_PROVIDER_PROFILES`；
//   · 超时只允许 1000..20000 整数（`INVALID_TIMEOUT`），重试恒 0，计划调用上限恒 2；
//   · TTS 音色/编码/采样率/文本上限、OCR 图片上限/内联 base64、ASR 音频剖面逐项冻结。
// ⛔ 本文件**不**自创端点、地域、音色、超时；改口径必须先改 `tools/ai-config.mjs` 与本表。
// ===========================================================================

/** `configurationIssues()` 的 `INVALID_TIMEOUT` 区间（毫秒，整数）。 */
export const AI_PROVIDER_TIMEOUT_MIN_MS = 1000;
export const AI_PROVIDER_TIMEOUT_MAX_MS = 20000;

/**
 * 固定的请求超时（毫秒），落在 `configurationIssues()` 的 `INVALID_TIMEOUT` 区间内。
 *
 * 取值依据（**不是新自创的档位**）：仓库内既有取证装置用的就是这一档 ——
 * `tests/unit/tts-live-adapter.test.mjs` 的 `EXPECTED_PROFILE.timeoutMs = 8000`，
 * `tools/verify-provider-adapter-live.mjs` 则从被校验配置读取同一档。
 *
 * 为什么**不**做成环境变量：`AI_ENDPOINTS`/`configurationIssues()` 没有规定超时值，
 * 多开一个 `*_MS` env 就等于自创一个配置面（还要同步 `deploy/**` 的模板，而 `deploy/**`
 * 在本片是禁改项）。因此这里与端点/地域/音色一样按**冻结常量**处理。
 */
export const AI_PROVIDER_DEFAULT_TIMEOUT_MS = 8000;

/**
 * 冻结的提供者剖面。逐字对齐 `tools/ai-config.mjs`：
 * - `AI_ENDPOINTS.{tts,ocr,asr}` 的 `endpoint/action/version/sdkVersion/auth`；
 * - `configurationIssues()` 对 tc3 类端点的固定要求：`region==='ap-shanghai'`、
 *   `maxRetries===0`、`maxVerificationCalls===2`、`voiceType/codec/sampleRate/maxTextCharacters`（tts）、
 *   `maxImageBytes/mediaTransport`（ocr）、`model/voiceFormat/sampleRate/channels/maxAudioSeconds/maxAudioBase64Bytes`（asr）。
 */
export const AI_PROVIDER_PROFILES = Object.freeze({
  tts: Object.freeze({
    endpoint: 'https://tts.tencentcloudapi.com',
    authentication: 'TC3-HMAC-SHA256' as const,
    action: 'TextToVoice',
    apiVersion: '2019-08-23',
    sdkVersion: '4.1.237',
    region: 'ap-shanghai' as const,
    maxRetries: 0 as const,
    maxVerificationCalls: 2 as const,
    voiceType: 101001 as const,
    codec: 'mp3' as const,
    sampleRate: 16000 as const,
    maxTextCharacters: 100 as const,
    secretIdEnv: 'TENCENTCLOUD_SECRET_ID',
    apiKeyEnv: 'TENCENTCLOUD_SECRET_KEY',
    sessionTokenEnv: 'TENCENTCLOUD_SESSION_TOKEN',
  }),
  ocr: Object.freeze({
    endpoint: 'https://ocr.tencentcloudapi.com',
    authentication: 'TC3-HMAC-SHA256' as const,
    action: 'GeneralAccurateOCR',
    apiVersion: '2018-11-19',
    sdkVersion: '4.1.322',
    region: 'ap-shanghai' as const,
    maxRetries: 0 as const,
    maxVerificationCalls: 2 as const,
    maxImageBytes: 2097152 as const,
    mediaTransport: 'inlineBase64' as const,
    secretIdEnv: 'TENCENTCLOUD_SECRET_ID',
    apiKeyEnv: 'TENCENTCLOUD_SECRET_KEY',
    sessionTokenEnv: 'TENCENTCLOUD_SESSION_TOKEN',
  }),
  asr: Object.freeze({
    endpoint: 'https://asr.tencentcloudapi.com',
    authentication: 'TC3-HMAC-SHA256' as const,
    action: 'SentenceRecognition',
    apiVersion: '2019-06-14',
    sdkVersion: '4.1.315',
    region: 'ap-shanghai' as const,
    maxRetries: 0 as const,
    maxVerificationCalls: 2 as const,
    model: '16k_zh' as const,
    voiceFormat: 'wav' as const,
    sampleRate: 16000 as const,
    channels: 1 as const,
    maxAudioSeconds: 60 as const,
    maxAudioBase64Bytes: 3145728 as const,
    /** ASR 允许专用子账号密钥；两者都在时**优先专用对**（同源配对，不逐字段混配）。 */
    secretIdEnv: 'TENCENTCLOUD_ASR_SECRET_ID',
    apiKeyEnv: 'TENCENTCLOUD_ASR_SECRET_KEY',
    sessionTokenEnv: 'TENCENTCLOUD_ASR_SESSION_TOKEN',
  }),
} as const);

/** ASR 的**回退共享对**（`configurationIssues()` 对 `key==='asr'` 显式允许的另一种合法组合）。 */
const ASR_SHARED_CREDENTIAL_ENVS = Object.freeze({
  secretIdEnv: 'TENCENTCLOUD_SECRET_ID',
  apiKeyEnv: 'TENCENTCLOUD_SECRET_KEY',
  sessionTokenEnv: 'TENCENTCLOUD_SESSION_TOKEN',
});

/**
 * 构造只存内存的凭据三元组。`toJSON()` 被改写成脱敏串且不可枚举：
 * 即便有人把整份 `AppConfig` 序列化/记日志，也不会带出密钥值（红线段①）。
 */
function redactedCredentials(secretId: string, secretKey: string, sessionToken: string): AiProviderCredentials {
  const credentials = { secretId, secretKey, sessionToken };
  Object.defineProperty(credentials, 'toJSON', {
    value: () => ({ secretId: '[REDACTED]', secretKey: '[REDACTED]', sessionToken: '[REDACTED]' }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(credentials);
}

/** 读一对（或三件）凭据；id/key 任一缺失即 `null`（**不逐字段混配**）。 */
function asCredentials(
  env: Env,
  names: { secretIdEnv: string; apiKeyEnv: string; sessionTokenEnv: string },
): AiProviderCredentials | null {
  const secretId = trimmed(env, names.secretIdEnv);
  const secretKey = trimmed(env, names.apiKeyEnv);
  if (secretId === undefined || secretKey === undefined) return null;
  // 长期密钥没有临时令牌时显式空串（不继承其它能力的 token）。
  const sessionToken = trimmed(env, names.sessionTokenEnv) ?? '';
  return redactedCredentials(secretId, secretKey, sessionToken);
}

/**
 * 组装三域真实提供者配置。
 *
 * - **只有 `real` 模式**才可能非 null：`stub`/`preset_demo` 即使环境里有凭据也一律 `null`
 *   （替身/演示不得携带真实供应商凭据，杜绝「悄悄打了个真实电话」）。
 * - 每域独立判定：三个域凭据齐备与否互不影响（缺哪个哪个仍 fail-closed）。
 * - 超时取冻结常量 `AI_PROVIDER_DEFAULT_TIMEOUT_MS`（不自创配置面，见其注释）。
 * - 本函数只读 env、只返回内存对象；不写文件、不打印、不产生任何网络行为。
 */
function asAiProviders(env: Env, executionMode: ExecutionMode): AiProvidersConfig {
  const none: AiProvidersConfig = { tts: null, ocr: null, asr: null };
  if (executionMode !== 'real') return none;
  const timeoutMs = AI_PROVIDER_DEFAULT_TIMEOUT_MS;
  const shared = asCredentials(env, {
    secretIdEnv: 'TENCENTCLOUD_SECRET_ID',
    apiKeyEnv: 'TENCENTCLOUD_SECRET_KEY',
    sessionTokenEnv: 'TENCENTCLOUD_SESSION_TOKEN',
  });
  // ASR：专用子账号对优先；缺专用对时回退共享对（`configurationIssues()` 允许的另一种组合）。
  const asrOwn = asCredentials(env, AI_PROVIDER_PROFILES.asr);
  const asrCredentialNames = asrOwn === null ? ASR_SHARED_CREDENTIAL_ENVS : AI_PROVIDER_PROFILES.asr;
  const asrCredentials = asrOwn ?? shared;

  const ttsProfile = AI_PROVIDER_PROFILES.tts;
  const ocrProfile = AI_PROVIDER_PROFILES.ocr;
  const asrProfile = AI_PROVIDER_PROFILES.asr;

  return {
    tts:
      shared === null
        ? null
        : {
            endpoint: ttsProfile.endpoint,
            authentication: ttsProfile.authentication,
            action: ttsProfile.action,
            apiVersion: ttsProfile.apiVersion,
            sdkVersion: ttsProfile.sdkVersion,
            region: ttsProfile.region,
            timeoutMs,
            maxRetries: ttsProfile.maxRetries,
            maxVerificationCalls: ttsProfile.maxVerificationCalls,
            secretIdEnv: ttsProfile.secretIdEnv,
            apiKeyEnv: ttsProfile.apiKeyEnv,
            voiceType: ttsProfile.voiceType,
            codec: ttsProfile.codec,
            sampleRate: ttsProfile.sampleRate,
            maxTextCharacters: ttsProfile.maxTextCharacters,
            credentials: shared,
          },
    ocr:
      shared === null
        ? null
        : {
            endpoint: ocrProfile.endpoint,
            authentication: ocrProfile.authentication,
            action: ocrProfile.action,
            apiVersion: ocrProfile.apiVersion,
            sdkVersion: ocrProfile.sdkVersion,
            region: ocrProfile.region,
            timeoutMs,
            maxRetries: ocrProfile.maxRetries,
            maxVerificationCalls: ocrProfile.maxVerificationCalls,
            secretIdEnv: ocrProfile.secretIdEnv,
            apiKeyEnv: ocrProfile.apiKeyEnv,
            maxImageBytes: ocrProfile.maxImageBytes,
            mediaTransport: ocrProfile.mediaTransport,
            credentials: shared,
          },
    asr:
      asrCredentials === null
        ? null
        : {
            endpoint: asrProfile.endpoint,
            authentication: asrProfile.authentication,
            action: asrProfile.action,
            apiVersion: asrProfile.apiVersion,
            sdkVersion: asrProfile.sdkVersion,
            region: asrProfile.region,
            timeoutMs,
            maxRetries: asrProfile.maxRetries,
            maxVerificationCalls: asrProfile.maxVerificationCalls,
            secretIdEnv: asrCredentialNames.secretIdEnv,
            apiKeyEnv: asrCredentialNames.apiKeyEnv,
            model: asrProfile.model,
            voiceFormat: asrProfile.voiceFormat,
            sampleRate: asrProfile.sampleRate,
            channels: asrProfile.channels,
            maxAudioSeconds: asrProfile.maxAudioSeconds,
            maxAudioBase64Bytes: asrProfile.maxAudioBase64Bytes,
            credentials: asrCredentials,
          },
  };
}

/** 单个能力的校验参数（口径见 `AI_ENDPOINTS` / `configurationIssues()`）。 */
export interface AiProviderProfileBase {
  readonly endpoint: string;
  readonly authentication: 'TC3-HMAC-SHA256';
  readonly action: string;
  readonly apiVersion: string;
  /** SDK 版本口径（`configurationIssues()` 的 `SDK_VERSION_NOT_PINNED`）。 */
  readonly sdkVersion: string;
  readonly region: 'ap-shanghai';
  /** 1000..20000（`INVALID_TIMEOUT`）；取冻结常量 `AI_PROVIDER_DEFAULT_TIMEOUT_MS`。 */
  readonly timeoutMs: number;
  /** 恒为 0：任何重发都是一次新的预留（`AUTOMATIC_RETRIES_DISABLED_REQUIRED`）。 */
  readonly maxRetries: 0;
  /** 恒为 2（`INVALID_PLANNED_CALL_LIMIT`）；取证工具的每端点上限，产品路径不据此限流。 */
  readonly maxVerificationCalls: 2;
  /** 凭据环境变量名（`TC3_CREDENTIAL_NAMES_REQUIRED`）。 */
  readonly secretIdEnv: string;
  readonly apiKeyEnv: string;
}

/** TC3 凭据三元组：**只在内存**，绝不序列化（`toJSON()` 已脱敏）。 */
export interface AiProviderCredentials {
  readonly secretId: string;
  readonly secretKey: string;
  /** 长期密钥显式空串（不继承任何其它 token）。 */
  readonly sessionToken: string;
}

export interface TtsProviderConfig extends AiProviderProfileBase {
  readonly voiceType: 101001;
  readonly codec: 'mp3';
  readonly sampleRate: 16000;
  readonly maxTextCharacters: 100;
  readonly credentials: AiProviderCredentials;
}

export interface OcrProviderConfig extends AiProviderProfileBase {
  readonly maxImageBytes: 2097152;
  readonly mediaTransport: 'inlineBase64';
  readonly credentials: AiProviderCredentials;
}

export interface AsrProviderConfig extends AiProviderProfileBase {
  readonly model: '16k_zh';
  readonly voiceFormat: 'wav';
  readonly sampleRate: 16000;
  readonly channels: 1;
  readonly maxAudioSeconds: 60;
  readonly maxAudioBase64Bytes: 3145728;
  readonly credentials: AiProviderCredentials;
}

/**
 * 三域真实提供者配置。`null` = 该域**未配置**（= 接线前的行为，域内 fail-closed）。
 *
 * `authorization`：产品路径预算闸门的授权串（**不是密钥**，只用于「闸门被显式接入」这一断言）；
 * 取证工具另有自己的轮次授权串与文件台账。
 */
export interface AiProvidersConfig {
  readonly tts: TtsProviderConfig | null;
  readonly ocr: OcrProviderConfig | null;
  readonly asr: AsrProviderConfig | null;
}
