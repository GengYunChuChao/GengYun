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

function isPostgresUrl(value: string): boolean {
  return /^postgres(ql)?:\/\/\S+$/i.test(value);
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
  };
}
