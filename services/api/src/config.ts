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
   * 文字问答（`/conversations` 的回答生成侧）**唯一**的真实模型配置（GY-R28 W7 / #12）。
   *
   * `null` = 未配置 ⇒ 装配层**不构造**真实适配器，问答沿用基线的确定性回答器（版本串仍带
   * `unimplemented:no-real-` 前缀），行为与 main 逐字节一致。
   *
   * 密钥**只从进程环境读取、只存内存**：不写文件、不进日志、不进任何响应；本模块只保证
   * 「要么整套齐备、要么 `null`」，不做任何网络探测（探测发生在真正外发的那一刻）。
   */
  aiProviders: {
    /**
     * 问答聊天模型。四要素（endpoint / model / apiKey / 上限）**要么全配、要么全空**。
     * 半配置一律作为配置错误（`INVALID_VALUE`/`MISSING`）在启动时报出，绝不静默退回确定性回答器
     * ——否则「配错了」会被误读成「没有接模型」。
     */
    chat: ChatProviderConfig | null;
  };
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
    aiProviders: { chat: chatProvider },
  };
}
