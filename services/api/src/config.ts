/**
 * 配置加载与校验。
 *
 * 规则：
 * - 缺少必填配置时抛出 ConfigError，并一次性列出所有缺失/非法的字段名（不静默用默认值顶替）。
 * - 真实模式（real）必须提供数据库与密钥配置；替身/演示模式不要求真实凭据。
 * - 只读取进程环境，不写入任何文件，不回显敏感值。
 */
import { EXECUTION_MODES, type ExecutionMode } from './contract.ts';
import { readObjectStorageConfig, type ObjectStorageConfig } from './media/object-store.ts';
import { createObjectRefCipher } from './media/object-ref-cipher.ts';

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
   * **可选字段**（`?`）而不是必填：手工构造的 `AppConfig` 字面量（健康检查等既有单测、
   * 嵌入式调用方）本来就不带它 ⇒ 缺省视为「未配置」，三域一律走接线前的 fail-closed，
   * 与接线前**逐字节相同**。`loadConfig()` 永远会给出该字段（三域各自可 `null`）。
   */
  aiProviders?: AiProvidersConfig;
  /**
   * 真实对象存储配置（`OBJECT_STORAGE_*` 四键齐备且合法时非 null；解析校验在
   * `media/object-store.ts` 的 `readObjectStorageConfig`，此处不重写判据）。
   *
   * ⚠️ **拿到本字段 ≠ 真实媒体端口已接线**：媒体域在 `real` 下还要求一个显式批准能力
   * （`media/service.ts` 的 `approveRealMediaWiring`，唯一铸造点在**生产入口**、且只在显式
   * 运维动作下调用）。本字段只表示「配置齐备且合法」，不构成任何接线许可。
   */
  objectStorage: ObjectStorageConfig | null;
  /**
   * `object_ref_cipher` 的加密键材料（`MEDIA_OBJECT_REF_KEY`）：64 位 hex / 32 字节 base64 / 32 字节原串。
   *
   * 媒体四表把对象键存成 `object_ref_cipher text NOT NULL`（`0001_initial_schema.sql:171-200`），
   * 因此**落库必须有键**；本字段为 `null` 时装配层不接 PG 持久化（`real` + 有库 ⇒ 媒体域 503），
   * 绝不退回进程内 `Map` 去声称持久化成功，也绝不把对象键明文写进库。
   *
   * 非法键材料在这里就报 `INVALID_VALUE`（判据在 `media/object-ref-cipher.ts`，此处不重写）。
   */
  mediaObjectRefKey: string | null;
  /**
   * 文字问答（`/conversations` 的回答生成侧）**唯一**的真实模型配置（GY-R28 W7 / #12）。
   *
   * `null` = 未配置 ⇒ 装配层**不构造**真实适配器，问答沿用基线的确定性回答器（版本串仍带
   * `unimplemented:no-real-` 前缀），行为与 main 逐字节一致。
   *
   * 密钥**只从进程环境读取、只存内存**：不写文件、不进日志、不进任何响应；本模块只保证
   * 「要么整套齐备、要么 `null`」，不做任何网络探测（探测发生在真正外发的那一刻）。
   *
   * 问答聊天模型。四要素（endpoint / model / apiKey / 上限）**要么全配、要么全空**。
   * 半配置一律作为配置错误（`INVALID_VALUE`/`MISSING`）在启动时报出，绝不静默退回确定性回答器
   * ——否则「配错了」会被误读成「没有接模型」。
   *
   * ⚠️ 为什么是**独立字段**而不是塞进上面的 `aiProviders`（合流 main 后记录）：`aiProviders`
   * 是 GY-R28 W1 的三域（TTS/OCR/ASR）配置，带腾讯云 TC3 专用字段与六键凭据结构；问答模型是
   * 独立的 OpenAI 兼容端点（扁平 `apiKey`、自己的超时/重试口径）。两片在各自分支上都取名
   * `aiProviders`，合并时同名不同义。按「保留 main 侧 W1 口径逐字不动」处理：W1 的字段与
   * `asAiProviders` 不变，W7 的问答配置扁平成这个独立字段。
   *
   * 可选字段（`?`）：手工构造的精简 `AppConfig`（如健康检查等既有单测）不带它 ⇒ 视为「未配置」，
   * 行为与接线前逐字节一致；`loadConfig()` 永远会给出该字段（可为 `null`）。
   */
  chatProvider?: ChatProviderConfig | null;
}

/** 问答聊天模型的已校验配置（不含任何需要回显的凭据）。 */
export interface ChatProviderConfig {
  /** 供应商聊天补全端点（`https://<host>/<path>`；不接受明文 http、URL 内凭据、查询串、片段）。 */
  endpoint: string;
  /** 模型名（1..80，无空白/控制字符；只用于请求体与版本串，不含供应商私密信息）。 */
  model: string;
  /** 单次外发超时（毫秒，1000..30000）。 */
  timeoutMs: number;
  /** 传输层重试次数（0..2；只在**未派发**的失败上重试，见适配器注释）。 */
  maxRetries: number;
  /** API 密钥：只存内存，绝不回显/记日志；`ChatProviderConfig` 自身不导出它到任何响应。 */
  apiKey: string;
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
 * 校验聊天模型端点：只接受 `https://<host>[:port][/path]`（不带查询串/片段/URL 内凭据）。
 *
 * 与 `asHttpsOrigin` 的判据同源（同一套「配置读入错」防线），额外允许**非空路径**——聊天补全
 * 端点通常带 `/chat/completions` 之类的路径；但仍拒绝查询串与片段：那两类是「调用参数混进
 * 配置」的典型形状，会把密钥或用户数据写进配置文件。
 */
function asHttpsChatEndpoint(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.search !== '' || parsed.hash !== '') return null;
  if (parsed.hostname === '') return null;
  // 规范化：去掉默认端口与尾斜杠，避免同一端点出现两种字符串形态（幂等比较/证据可复现）。
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${path}`;
}

/** 问答聊天模型的环境变量名（字段名即 ConfigIssue.field；密钥只在内存）。 */
export const CHAT_PROVIDER_ENV = {
  endpoint: 'CHAT_LLM_ENDPOINT',
  model: 'CHAT_LLM_MODEL',
  apiKey: 'CHAT_LLM_API_KEY',
  /** 兼容既有取证口径：`DEEPSEEK_API_KEY` 作为 `CHAT_LLM_API_KEY` 的**同名替代**（二选一）。 */
  apiKeyFallback: 'DEEPSEEK_API_KEY',
  timeoutMs: 'CHAT_LLM_TIMEOUT_MS',
  maxRetries: 'CHAT_LLM_MAX_RETRIES',
} as const;

export const CHAT_TIMEOUT_MS_RANGE = [1000, 30000] as const;
export const CHAT_MAX_RETRIES_RANGE = [0, 2] as const;

/**
 * 解析问答聊天模型配置。
 *
 * 语义（fail-closed）：
 *   - 三个必填项（endpoint / model / 密钥）**全空** ⇒ `null`（未配置，装配层不构造真实适配器）；
 *   - 任一必填项缺失、或任一项非法 ⇒ 各记一条 issue（启动即报错，**不**静默降级）；
 *   - 可选项（超时/重试）只在提供了值的时候校验。
 */
function asChatProvider(env: Env, issues: ConfigIssue[]): ChatProviderConfig | null {
  const endpointRaw = trimmed(env, CHAT_PROVIDER_ENV.endpoint);
  const modelRaw = trimmed(env, CHAT_PROVIDER_ENV.model);
  const apiKeyRaw = trimmed(env, CHAT_PROVIDER_ENV.apiKey) ?? trimmed(env, CHAT_PROVIDER_ENV.apiKeyFallback);

  if (endpointRaw === undefined && modelRaw === undefined && apiKeyRaw === undefined) return null;

  let endpoint: string | null = null;
  if (endpointRaw === undefined) {
    issues.push({
      field: CHAT_PROVIDER_ENV.endpoint,
      code: 'MISSING',
      reason: '配置问答聊天模型时必须同时提供端点（https://<host>[/path]）',
    });
  } else {
    endpoint = asHttpsChatEndpoint(endpointRaw);
    if (endpoint === null) {
      issues.push({
        field: CHAT_PROVIDER_ENV.endpoint,
        code: 'INVALID_VALUE',
        reason: '必须是 https://<host>[:port][/path]（不带查询串/片段/URL 内凭据）',
      });
    }
  }

  let model: string | null = null;
  if (modelRaw === undefined) {
    issues.push({
      field: CHAT_PROVIDER_ENV.model,
      code: 'MISSING',
      reason: '配置问答聊天模型时必须同时提供模型名',
    });
  } else if (modelRaw.length > 80 || /[\s\u0000-\u001f\u007f]/.test(modelRaw)) {
    issues.push({
      field: CHAT_PROVIDER_ENV.model,
      code: 'INVALID_VALUE',
      reason: '模型名 1..80 字符，且不含空白/控制字符',
    });
  } else {
    model = modelRaw;
  }

  let apiKey: string | null = null;
  if (apiKeyRaw === undefined) {
    issues.push({
      field: CHAT_PROVIDER_ENV.apiKey,
      code: 'MISSING',
      reason: `配置问答聊天模型时必须同时提供密钥（${CHAT_PROVIDER_ENV.apiKey} 或 ${CHAT_PROVIDER_ENV.apiKeyFallback}）`,
    });
  } else if (apiKeyRaw.length < 8 || apiKeyRaw.length > 200 || /[\s\u0000-\u001f\u007f]/.test(apiKeyRaw)) {
    issues.push({
      field: CHAT_PROVIDER_ENV.apiKey,
      // 说明里**不含**任何密钥片段（连长度以外的形态也不描述具体值）。
      code: 'INVALID_VALUE',
      reason: '密钥 8..200 字符，且不含空白/控制字符',
    });
  } else {
    apiKey = apiKeyRaw;
  }

  let timeoutMs = 20000;
  const timeoutRaw = trimmed(env, CHAT_PROVIDER_ENV.timeoutMs);
  if (timeoutRaw !== undefined) {
    const parsed = Number(timeoutRaw);
    if (!Number.isInteger(parsed) || parsed < CHAT_TIMEOUT_MS_RANGE[0] || parsed > CHAT_TIMEOUT_MS_RANGE[1]) {
      issues.push({
        field: CHAT_PROVIDER_ENV.timeoutMs,
        code: 'INVALID_VALUE',
        reason: `必须是 ${CHAT_TIMEOUT_MS_RANGE[0]}..${CHAT_TIMEOUT_MS_RANGE[1]} 的整数（毫秒）`,
      });
    } else {
      timeoutMs = parsed;
    }
  }

  let maxRetries = 1;
  const retriesRaw = trimmed(env, CHAT_PROVIDER_ENV.maxRetries);
  if (retriesRaw !== undefined) {
    const parsed = Number(retriesRaw);
    if (!Number.isInteger(parsed) || parsed < CHAT_MAX_RETRIES_RANGE[0] || parsed > CHAT_MAX_RETRIES_RANGE[1]) {
      issues.push({
        field: CHAT_PROVIDER_ENV.maxRetries,
        code: 'INVALID_VALUE',
        reason: `必须是 ${CHAT_MAX_RETRIES_RANGE[0]}..${CHAT_MAX_RETRIES_RANGE[1]} 的整数`,
      });
    } else {
      maxRetries = parsed;
    }
  }

  if (endpoint === null || model === null || apiKey === null) return null;
  return { endpoint, model, timeoutMs, maxRetries, apiKey };
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
  // 合成模式固定测试身份（GY-R68）：判据集中在 `readStubSubject`（**只在非 real 且值非空**时非 null；
  // real 恒 null、未设/空白恒 null ⇒ 默认行为逐字不变）。⛔ 值只从服务端进程环境读取。
  const wechatStubSubject = readStubSubject(env, executionMode, issues);
  // GY-R68 返修（可观测性）：原始环境值存在但**只含空白** ⇒ 归一化成「未设」之后仍留痕，供启动日志把
  // 「设了但被忽略」与「未设」区分开。⛔ 不改变身份派生：`wechatStubSubject` 仍然恒为 `null`。
  const wechatStubSubjectIgnored = wechatStubSubject === null && hasWhitespaceOnlyStubSubject(env, executionMode);
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

  // 问答真实模型（#12）：未配置 ⇒ null（装配层不构造适配器，行为与 main 逐字节一致）；
  // 半配置/非法 ⇒ 记 issue，由下方统一抛 ConfigError（不静默降级）。
  const chatProvider = asChatProvider(env, issues);

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

  // 真实对象存储配置：四键齐备时折算成结构化字段（缺键已由上面的 REQUIRED_WHEN_REAL 一次性列出）。
  // 解析与校验**复用媒体域的 `readObjectStorageConfig`**，不在此处重写一份判据（避免两处漂移）；
  // 四键都非空时才可能产生 INVALID_VALUE（例如明文 http 的 endpoint），字段名与上面同集合。
  // 注意：解析成功**不构成接线许可**——接线许可只来自生产入口铸造的显式批准能力。
  let objectStorage: ObjectStorageConfig | null = null;
  if (executionMode === 'real') {
    const storageKeys = REQUIRED_WHEN_REAL.filter((field) => field.startsWith('OBJECT_STORAGE_'));
    const storageComplete = storageKeys.every((field) => trimmed(env, field) !== undefined);
    if (storageComplete) {
      const parsed = readObjectStorageConfig(env);
      if (parsed.config === null) {
        for (const issue of parsed.issues) {
          issues.push({ field: issue.field, code: issue.code, reason: issue.reason });
        }
      } else {
        objectStorage = parsed.config;
      }
    }
  }

  // 媒体对象键的加密键（可选）：缺失不算配置错误（stub/演示无需落库），但 `real` + 有数据库时
  // 装配层会因缺键把媒体域整域 fail-closed —— 详见 `AppConfig.mediaObjectRefKey` 的说明。
  // 给了就必须能用：键材料非法 ⇒ INVALID_VALUE（判据复用媒体域，不在此处重写一份）。
  let mediaObjectRefKey: string | null = null;
  const mediaObjectRefKeyRaw = trimmed(env, 'MEDIA_OBJECT_REF_KEY');
  if (mediaObjectRefKeyRaw !== undefined) {
    try {
      createObjectRefCipher(mediaObjectRefKeyRaw);
      mediaObjectRefKey = mediaObjectRefKeyRaw;
    } catch (error) {
      issues.push({
        field: 'MEDIA_OBJECT_REF_KEY',
        code: 'INVALID_VALUE',
        reason: error instanceof Error ? error.message : '键材料非法',
      });
    }
  }

  // 限流配置（GY-R34 切片）：缺省值即默认策略；给了就必须能用——非法值并入 issues，
  // 与其它字段在同一处一次性抛出（⛔ 不在装配层静默退回默认值）。
  const rateLimit = readRateLimitConfig(env, issues);
  // 反代信任度（GY-R34 返修）：决定 `request.ip` 是「真实客户端」还是「网关地址」，
  // 而认证端点的限流键就是它（见 `rate-limit/limiter.ts`）。同样并入 issues 一次性抛出。
  const trustProxy = readTrustProxyConfig(env, issues);

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
    wechatStubSubject,
    // 原始值「设了但只含空白」的留痕（只供启动日志读数；不参与身份派生）
    wechatStubSubjectIgnored,
    sessionSigningKey,
    adminBootstrap,
    mediaAccessGrantOrigin,
    aiProviders,
    objectStorage,
    mediaObjectRefKey,
    chatProvider,
    rateLimit,
    trustProxy,
  };
}

// ===========================================================================
// GY-R68 · 合成模式固定测试身份（`WECHAT_STUB_SUBJECT`）
//
// 缺口：合成分支把 `wx.login` 的 code 派生为 subject，而每次登录 code 都不同 ⇒ 开发者工具里
// 点一次登录就是一个新账号，资料/收藏在两次登录之间不互通，「退出 → 用同一身份重登 → 数据仍在」
// 这条 P0 恢复链路在 stub 下**证不了**（real 模式需要真凭据，本机没有）。
//
// 判据（与 `docs/reference/configuration.md`、`.env.example` 同口径）：
//   · `APP_EXECUTION_MODE === 'real'`          ⇒ 恒 `null`（**设了也不生效**，不报错、不透出）；
//   · 非 real 且该变量未设/空白             ⇒ `null` ⇒ 合成身份仍按 code 派生，**默认行为逐字不变**；
//   · 非 real 且该变量非空                    ⇒ 原样透出（装配层把它交给合成身份派生，见 `auth/wechat.ts`）。
//
// ⛔ 安全边界：subject 只能由**服务端环境**决定。本函数只读进程环境（或其显式传入的等价 env），
// 绝不读请求体/查询参数/header；请求侧唯一输入仍是 `code`，schema 为 `additionalProperties:false`。
// ===========================================================================

/** 固定测试身份的最大长度（防止把整段记事贴进环境变量；不含敏感语义，只防手滑）。 */
export const WECHAT_STUB_SUBJECT_MAX_LENGTH = 128;

/**
 * 读取合成模式的固定测试身份。见上方口径：real 恒 `null`；未设/空白恒 `null`；非空才透出。
 * 非法值（超长/含控制字符）并入 `issues` 一次性抛出，⛔ 不静默退回「按 code 派生」
 * ——那会让「我明明设了固定身份」被读成「设了没用」。
 */
function readStubSubject(env: Env, executionMode: ExecutionMode, issues: ConfigIssue[]): string | null {
  // real 模式：该变量**完全不生效**（哪怕设了也不用，也不因此报错——它不是 real 的配置面）。
  if (executionMode === 'real') return null;
  const raw = trimmed(env, 'WECHAT_STUB_SUBJECT');
  if (raw === undefined) return null;
  if (raw.length > WECHAT_STUB_SUBJECT_MAX_LENGTH) {
    issues.push({
      field: 'WECHAT_STUB_SUBJECT',
      code: 'INVALID_VALUE',
      reason: `最长 ${WECHAT_STUB_SUBJECT_MAX_LENGTH} 字符`,
    });
    return null;
  }
  // 控制字符（含换行）会把 subject 拆成两行：既不便于核对，也可能被下游当作两个身份。
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    issues.push({ field: 'WECHAT_STUB_SUBJECT', code: 'INVALID_VALUE', reason: '不得含控制字符（含换行）' });
    return null;
  }
  return raw;
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

// ===========================================================================
// GY-R34 · API 层限流配置（认证端点按 IP、写接口按用户）
//
// 为什么放在 `loadConfig` **之后**（按追加而非插入）：`docs/architecture/contract-status.json`
// 把 `loadConfig` 的行号区间当作证据锚点（容差 ±2 行），理由与上方 AI 真实提供者区块一致；
// 类型与解析函数在 TS 里可以先使用后声明（函数声明提升、接口纯类型），因此追加即可，锚点不动。
//
// 口径唯一事实源＝本区块的 `RATE_LIMIT_DEFAULTS`：`services/api/src/rate-limit/limiter.ts`
// 的规则表与 `docs/architecture/rate-limit-policy.md` 的表格都照它抄写，⛔ 不在别处另立数值。
// ===========================================================================

/**
 * `AppConfig.rateLimit` 用**接口声明合并**追加，而不是插进上方 `AppConfig` 本体：
 * 本文件的行号是 `docs/**` 里手写锚点的指向对象（如 `config.ts:237` 的 `asHttpsChatEndpoint`），
 * 在接口里加字段会把它们整片推走。合并后与「直接在原接口里写一行字段」类型等价，
 * 手工构造的精简 `AppConfig` 字面量（健康检查等既有单测）仍可省略它。
 */
export interface AppConfig {
  /**
   * API 层限流（认证端点按客户端 IP、写接口按用户）。
   *
   * 可省略 ⇒ 视为「按默认策略限流」（`RATE_LIMIT_DEFAULTS`）；`loadConfig()` 永远给出该字段。
   * **不是** real 模式的启动必填项：默认值即可上线，调参只走 `RATE_LIMIT_*` 环境变量。
   */
  readonly rateLimit?: RateLimitConfig;

  /**
   * 反代信任度（Fastify `trustProxy` 的取值面），来自 `API_TRUST_PROXY`。
   *
   * 决定 `request.ip` 取的是 socket 对端地址还是 `X-Forwarded-For` 里的客户端地址：
   * - `false`（默认）：不信任任何代理 ⇒ `request.ip` = socket 地址。直连/本地开发口径。
   * - `true`：信任整条链 ⇒ `request.ip` = `X-Forwarded-For` **最左**一项。
   * - 非负整数 `n`：只信任最近 `n` 跳（`0` 与 `false` 等价；`1` = 恰好一层网关）。
   *
   * 为什么是 `API_*` 前缀而不是 `RATE_LIMIT_*`：它是**服务器级**的代理语义（与 `API_HOST`/
   * `API_PORT` 同类），`request.ip` 除限流键外还进请求日志的 `remoteAddress`
   * （`app.ts` 的 `requestLogFields`）。当前**唯一**的业务消费者是限流器的 IP 键。
   *
   * 可省略 ⇒ 视为 `false`（直连）；`loadConfig()` 永远给出该字段。
   */
  readonly trustProxy?: TrustProxyConfig;
}

/** 一个限流窗口：`windowMs` 内最多放行 `limit` 次。 */
export interface RateLimitWindowConfig {
  readonly limit: number;
  readonly windowMs: number;
}

/** API 层限流配置（全部来自 `RATE_LIMIT_*`，缺省值见 `RATE_LIMIT_DEFAULTS`）。 */
export interface RateLimitConfig {
  /** 总开关；`false` ⇒ 中间件直通（不计数、不写头、不产生 429）。 */
  readonly enabled: boolean;
  /** `POST /api/v1/auth/*`、`POST /api/v1/admin/auth/*`：按客户端 IP 计数。 */
  readonly authIp: RateLimitWindowConfig;
  /** 其余写方法（POST/PUT/PATCH/DELETE）：按服务端解析出的用户 id 计数。 */
  readonly writeUser: RateLimitWindowConfig;
  /** 豁免路径前缀（默认只豁免 `/health`：健康检查不应因同机其它流量被判超限）。 */
  readonly exemptPaths: readonly string[];
  /** 豁免 IP（精确匹配；给运维探针/压测机留口子，默认空）。 */
  readonly allowlistIps: readonly string[];
  /** 进程内计数器的 key 上限（超出后淘汰最久未用的 key，见 `rate-limit/store.ts`）。 */
  readonly maxKeys: number;
}

/** 各数值字段的允许区间：超出即 `INVALID_VALUE`（⛔ 不静默夹取）。 */
export const RATE_LIMIT_LIMIT_RANGE = [1, 100_000] as const;
export const RATE_LIMIT_WINDOW_MS_RANGE = [100, 3_600_000] as const;
export const RATE_LIMIT_MAX_KEYS_RANGE = [1, 1_000_000] as const;

/**
 * 默认策略（规则表与文档都从它派生）。
 *
 * 取值依据（完整推导与调参见 `docs/architecture/rate-limit-policy.md`）：
 * - `POST /auth/wechat` 一次调用对应一次小程序登录，正常人一分钟远到不了 20 次；
 *   20 次/分钟足以挡住换 code 刷会话与撞库，又不会卡住弱网重试。
 * - 写接口 120 次/分钟 ≈ 2 次/秒，是本仓界面操作节奏（一次点按＝一次写）的上限带余量，
 *   同时把「脚本狂刷社区/留言」压到人工量级。
 * - 两侧窗口都取 60 秒：与 `Retry-After` 的整数秒粒度一致，运维只需记一个数。
 */
export const RATE_LIMIT_DEFAULTS: RateLimitConfig = Object.freeze({
  enabled: true,
  authIp: Object.freeze({ limit: 20, windowMs: 60_000 }),
  writeUser: Object.freeze({ limit: 120, windowMs: 60_000 }),
  exemptPaths: Object.freeze(['/health']),
  allowlistIps: Object.freeze([]),
  maxKeys: 5_000,
});

/** 环境变量名（本区块唯一读取面）。 */
export const RATE_LIMIT_ENV = Object.freeze({
  enabled: 'RATE_LIMIT_ENABLED',
  authLimit: 'RATE_LIMIT_AUTH_LIMIT',
  authWindowMs: 'RATE_LIMIT_AUTH_WINDOW_MS',
  writeLimit: 'RATE_LIMIT_WRITE_LIMIT',
  writeWindowMs: 'RATE_LIMIT_WRITE_WINDOW_MS',
  exemptPaths: 'RATE_LIMIT_EXEMPT_PATHS',
  allowlistIps: 'RATE_LIMIT_ALLOWLIST_IPS',
  maxKeys: 'RATE_LIMIT_MAX_KEYS',
});

function readRateLimitBoolean(env: Env, field: string, fallback: boolean, issues: ConfigIssue[]): boolean {
  const raw = trimmed(env, field);
  if (raw === undefined) return fallback;
  const lowered = raw.toLowerCase();
  if (lowered === 'true' || lowered === '1') return true;
  if (lowered === 'false' || lowered === '0') return false;
  issues.push({ field, code: 'INVALID_VALUE', reason: '必须是 true/false（或 1/0）' });
  return fallback;
}

function readRateLimitInteger(
  env: Env,
  field: string,
  fallback: number,
  range: readonly [number, number],
  unit: string,
  issues: ConfigIssue[],
): number {
  const raw = trimmed(env, field);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < range[0] || parsed > range[1]) {
    issues.push({ field, code: 'INVALID_VALUE', reason: `必须是 ${range[0]}..${range[1]} 的整数${unit}` });
    return fallback;
  }
  return parsed;
}

/**
 * 列表型变量用逗号分隔。
 *
 * 与 `trimmed()` 的差别：这里看**原始值**，因此显式空串（`RATE_LIMIT_EXEMPT_PATHS=`）
 * 表示「清空默认豁免」，能与「未配置」区分开；未配置才回落到 `fallback`。
 */
function readRateLimitList(env: Env, field: string, fallback: readonly string[]): string[] {
  const raw = env[field];
  if (raw === undefined) return [...fallback];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** 读 `RATE_LIMIT_*`：缺省即默认策略；非法值只记 issue，由 `loadConfig` 统一抛 `ConfigError`。 */
export function readRateLimitConfig(env: Env, issues: ConfigIssue[]): RateLimitConfig {
  const enabled = readRateLimitBoolean(env, RATE_LIMIT_ENV.enabled, RATE_LIMIT_DEFAULTS.enabled, issues);

  const authIp = {
    limit: readRateLimitInteger(env, RATE_LIMIT_ENV.authLimit, RATE_LIMIT_DEFAULTS.authIp.limit, RATE_LIMIT_LIMIT_RANGE, '', issues),
    windowMs: readRateLimitInteger(
      env,
      RATE_LIMIT_ENV.authWindowMs,
      RATE_LIMIT_DEFAULTS.authIp.windowMs,
      RATE_LIMIT_WINDOW_MS_RANGE,
      '（毫秒）',
      issues,
    ),
  };

  const writeUser = {
    limit: readRateLimitInteger(env, RATE_LIMIT_ENV.writeLimit, RATE_LIMIT_DEFAULTS.writeUser.limit, RATE_LIMIT_LIMIT_RANGE, '', issues),
    windowMs: readRateLimitInteger(
      env,
      RATE_LIMIT_ENV.writeWindowMs,
      RATE_LIMIT_DEFAULTS.writeUser.windowMs,
      RATE_LIMIT_WINDOW_MS_RANGE,
      '（毫秒）',
      issues,
    ),
  };

  const exemptPaths: string[] = [];
  for (const candidate of readRateLimitList(env, RATE_LIMIT_ENV.exemptPaths, RATE_LIMIT_DEFAULTS.exemptPaths)) {
    // 只接受以 `/` 开头的纯路径：带查询串/空格的写法在 `onRequest` 里永远匹配不上，属配置错误。
    if (!candidate.startsWith('/') || /[\s?#]/.test(candidate)) {
      issues.push({ field: RATE_LIMIT_ENV.exemptPaths, code: 'INVALID_VALUE', reason: `「${candidate}」不是以 / 开头的纯路径` });
      continue;
    }
    exemptPaths.push(candidate);
  }

  const allowlistIps: string[] = [];
  for (const candidate of readRateLimitList(env, RATE_LIMIT_ENV.allowlistIps, RATE_LIMIT_DEFAULTS.allowlistIps)) {
    // 只做形状校验（IPv4 / IPv6 字面量），不做网段解析：本字段是精确匹配的运维口子。
    if (!/^[0-9a-fA-F:.]+$/.test(candidate)) {
      issues.push({ field: RATE_LIMIT_ENV.allowlistIps, code: 'INVALID_VALUE', reason: `「${candidate}」不是 IP 字面量` });
      continue;
    }
    allowlistIps.push(candidate);
  }

  const maxKeys = readRateLimitInteger(env, RATE_LIMIT_ENV.maxKeys, RATE_LIMIT_DEFAULTS.maxKeys, RATE_LIMIT_MAX_KEYS_RANGE, '', issues);

  return { enabled, authIp, writeUser, exemptPaths, allowlistIps, maxKeys };
}

// ===========================================================================
// GY-R34（返修）· 代理与客户端 IP 语义：`API_TRUST_PROXY`
//
// 为什么必须有它：部署目标是微信云托管（容器在平台网关后）。不声明信任代理时，Fastify 的
// `request.ip` 是**网关地址**，于是 `auth-ip` 规则（20 次/分钟）的键对全站所有用户都是同一个
// ⇒ 变成「全站共享的登录额度」，一波流量就能让所有人登录 429。反过来，开了 `trustProxy`
// 却没有可信网关，客户端可以自带 `X-Forwarded-For` 伪造 IP ⇒ 换一个头就换一份额度（限流被绕过）。
// 两种错法的取舍写在 `docs/architecture/rate-limit-policy.md` 的「代理与 IP 语义」段。
//
// 为什么放在这里（`loadConfig` 之后追加）：与上方 R34 限流区块同一理由——`docs/**` 的手写
// 行号锚点指向 `config.ts` 前部，追加式实现不动既有锚点。合并 `AppConfig` 的字段见上方接口。
// ===========================================================================

/**
 * `trustProxy` 的取值面：`false` / `true` / 非负整数跳数。
 *
 * 类型与 Fastify `FastifyServerOptions.trustProxy` 的可赋值子集一致（字符串/CIDR/谓词形态
 * 本仓不暴露：它们需要运维手写网段，属外置网关的职责，且容易被读成「any」）。
 */
export type TrustProxyConfig = boolean | number;

/** 跳数上限：比 32 更深的代理链属配置错误（每家网关最多几跳），⛔ 不静默夹取。 */
export const TRUST_PROXY_HOPS_RANGE = [0, 32] as const;

/** `API_TRUST_PROXY`（本区块唯一读取面）。 */
export const TRUST_PROXY_ENV = 'API_TRUST_PROXY';

/**
 * 读 `API_TRUST_PROXY`。
 *
 * 取值：`true` / `false`（大小写不敏感）、或 `0..32` 的非负整数（跳数）。
 * **`1`/`0` 按跳数解释，不按布尔解释**——与 `RATE_LIMIT_ENABLED` 等布尔变量不同：这里是
 * 三态量，`1` = 「只信任最近一跳」，`0` = 「一跳也不信任」（等价于 `false`）。想表达
 * 「信任整条链」必须写 `true`。
 *
 * 非法值（`yes`、`-1`、`2.5`、`>32` 的跳数）⇒ 记 `INVALID_VALUE` 并**保持默认 `false`**，
 * 由 `loadConfig` 统一抛 `ConfigError`（⛔ 不夹取成合法值、不静默降级）。
 * 未配置与空串（`API_TRUST_PROXY=`，平台模板的常见形态）都等同于未配置 ⇒ `false`。
 */
export function readTrustProxyConfig(env: Env, issues: ConfigIssue[]): TrustProxyConfig {
  const raw = trimmed(env, TRUST_PROXY_ENV);
  if (raw === undefined) return false;

  const lowered = raw.toLowerCase();
  if (lowered === 'true') return true;
  if (lowered === 'false') return false;

  // 非负整数跳数。`Number.isInteger` 会放过 `1e3`/`0x10` 之类写法，因此先按十进制字面量卡形状。
  if (/^\d+$/.test(lowered)) {
    const hops = Number(lowered);
    if (hops >= TRUST_PROXY_HOPS_RANGE[0] && hops <= TRUST_PROXY_HOPS_RANGE[1]) return hops;
    issues.push({
      field: TRUST_PROXY_ENV,
      code: 'INVALID_VALUE',
      reason: `跳数必须是 ${TRUST_PROXY_HOPS_RANGE[0]}..${TRUST_PROXY_HOPS_RANGE[1]} 的整数`,
    });
    return false;
  }

  issues.push({
    field: TRUST_PROXY_ENV,
    code: 'INVALID_VALUE',
    reason: '必须是 true/false 或非负整数跳数（例如 true、false、1、2）',
  });
  return false;
}

// ===========================================================================
// GY-R68 · `WECHAT_STUB_SUBJECT`（合成模式固定测试身份）的类型声明
//
// 为什么在文件末尾再声明一次**同名**接口，而不是把字段插进上面的 `AppConfig`：本仓 `docs/**`
// 与 `docs/architecture/contract-status.json` 把 `config.ts` 的行号当证据锚点（如
// `docs/verification/gy-r34-private-env-mapping-20261023.md` 的 `config.ts:278`），在接口里
// 插字段会把 `loadConfig` 及其后的行整体下移、把锚点推到空行上（实测会红）。TS 的**接口声明
// 合并**允许同名接口分多处声明，合并后 `AppConfig` 仍是同一个类型；口径同本文件既有的
// 「按追加而非插入」（见 GY-R28-W1 段落）。
// ===========================================================================

export interface AppConfig {
  /**
   * 合成模式的**固定测试身份**（`WECHAT_STUB_SUBJECT`，GY-R68）；`null` ＝未设／空白／real 模式。
   *
   * 为什么需要它：合成分支原本把 `wx.login` 的 code 派生为 subject，而每次登录 code 都不同
   * ⇒ 开发者工具里点一次登录就是一个新账号，资料与收藏在两次登录之间不互通，
   * 「退出 → 用同一身份重登 → 数据仍在」这条 P0 恢复链路在 stub 下**证不了**（real 要真凭据）。
   * 设了非空值后 subject 由**固定串**派生 ⇒ **该服务端进程的所有 stub 客户端共用一个账号**
   * （⛔ 因此不要在多人共用的 stub 服务上开这个开关：所有人会共用一个账号、彼此看得到对方的数据）。
   *
   * 安全边界（硬约束）：
   * - 值**只**来自服务端进程环境（`loadConfig` 是唯一读取点），请求体／查询参数／header
   *   **一律无法**影响它 —— 否则就成了「客户端自称身份」，那是伪造身份；
   * - **real 模式恒为 `null`**：哪怕运维设了这个变量也不生效（real 分支从不读取它）；
   * - 未设／空白 ⇒ `null` ⇒ 合成行为与接线前**逐字一致**（仍按 code 派生），默认不被改变。
   */
  wechatStubSubject?: string | null;
  /**
   * `WECHAT_STUB_SUBJECT` **设了、但只含空白字符**（半角/全角/制表等）⇒ 被 `trimmed()` 归一化成
   * 「未设」时为 `true`；未设、有值、real 模式都恒为 `false`。
   *
   * 用途**只有一个**：让启动日志把「被忽略」与「未设」区分开（`wechat_stub_subject_ignored`）。
   * ⛔ 它不参与身份派生，也不改变 real 边界 —— 派生仍只看 `wechatStubSubject`。
   * 在 `loadConfig` 里算好随配置交出去，是为了让**生产入口 `server.ts` 不读 ambient env**
   * （入口读 `process.env` 的后门由 `tests/unit/tts-synthesis-media-wiring.test.mjs` 判据 ④ 钉住）。
   */
  wechatStubSubjectIgnored?: boolean;
}

// ===========================================================================
// GY-R68 返修 · 启动日志的「固定身份是否生效」读数（本片只加**可观测性**，不改行为）
//
// 独立审查的两条非阻塞之一：启动日志原本只有 `execution_mode` / `database_configured`，
// 开发者无从判断「我设的固定身份到底生效了没有」；而 `WECHAT_STUB_SUBJECT='   '`（纯半角空白／
// 全角空白）在语义上等价于「未设」，过去**静默**回落 code 派生 —— 开发者会以为身份已固定、
// 其实没固定。
//
// 本函数把三态压成启动日志里的布尔（⛔ **只打布尔，绝不打变量的值**：那是身份标识）：
//   · `wechat_stub_subject_fixed: true`   ⇒ 固定身份确实生效（等价于 `config.wechatStubSubject !== null`）；
//   · `wechat_stub_subject_fixed: false`  ⇒ 未生效（未设／只含空白／real 模式三种情形）；
//   · `wechat_stub_subject_ignored: true` ⇒ **单独出现**时表示「设了、但只含空白 ⇒ 被忽略」，
//                                           与「未设」可区分（这正是审查要的可观测差异）。
//
// 判据不复写第二份：`fixed` 取的是 `config.wechatStubSubject`（`loadConfig` 的产物），空白判据取的是
// `config.wechatStubSubjectIgnored`（同样在 `loadConfig` 里算好），因此不会与真实行为漂移、也不需要在
// 入口层再读一次环境。本函数**不改变**身份派生、real 边界与 `INVALID_VALUE` 规则。
// ===========================================================================

/** 启动日志里 `WECHAT_STUB_SUBJECT` 的可观测读数（⛔ 只有布尔，没有值）。 */
export interface WechatStubSubjectStartupFields {
  /** 固定身份是否生效（＝ `config.wechatStubSubject !== null`）。 */
  wechat_stub_subject_fixed: boolean;
  /** 变量设了但只含空白字符（被 `trimmed()` 归一化成「未设」）时为 `true`；其它情形**不出现**该键。 */
  wechat_stub_subject_ignored?: true;
}

/**
 * 「原始值存在、但去掉空白后为空」判定（供 `loadConfig` 计算 `wechatStubSubjectIgnored`）。
 *
 * 与 `trimmed()` 同口径（`String.prototype.trim()`，含全角空格 `U+3000`）：非空串且 trim 后为空
 * ⇒ 会被归一化成「未设」。real 模式不算「被忽略」（该变量在 real 下本就不生效，不是设错）。
 */
function hasWhitespaceOnlyStubSubject(env: Env, executionMode: AppConfig['executionMode']): boolean {
  if (executionMode === 'real') return false;
  const raw = env['WECHAT_STUB_SUBJECT'];
  return typeof raw === 'string' && raw.length > 0 && raw.trim() === '';
}

/**
 * 计算启动日志要追加的字段。见上方口径。
 *
 * ⛔ **入参只有已解析的 `config`**：生产入口 `server.ts` 不许读 ambient env（`process.env` 出现次数必须为 0，
 * 由 `tests/unit/tts-synthesis-media-wiring.test.mjs` 判据 ④ 钉住）。空白判据已在 `loadConfig` 里算好
 * （`config.wechatStubSubjectIgnored`），本函数不再碰 env。
 */
export function wechatStubSubjectStartupFields(
  config: Pick<AppConfig, 'executionMode' | 'wechatStubSubject' | 'wechatStubSubjectIgnored'>,
): WechatStubSubjectStartupFields {
  // 与 `loadConfig` 同源：`wechatStubSubject` 只在「非 real 且非空」时非 null。
  const fixed = (config.wechatStubSubject ?? null) !== null;
  if (fixed) return { wechat_stub_subject_fixed: true };
  // real 模式：该变量本就不生效（不是「设错了」）⇒ 只报 false，不额外标「被忽略」，
  // 免得运维被引导去改一个在 real 下没有意义的变量。
  if (config.executionMode === 'real') return { wechat_stub_subject_fixed: false };
  // 「设了但只含空白」≠「未设」：`trimmed()` 会把前者归一化成未设，必须单独标出来。
  return config.wechatStubSubjectIgnored === true
    ? { wechat_stub_subject_fixed: false, wechat_stub_subject_ignored: true }
    : { wechat_stub_subject_fixed: false };
}
