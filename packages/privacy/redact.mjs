/**
 * GY-I27 隐私模块 · 日志脱敏。
 *
 * 硬红线：日志严禁落私有正文、图片、音频、精确坐标、凭据。
 * 本模块对写入日志前的任意值做递归脱敏，供审计/日志/错误封套复用。
 *
 * 脱敏策略（键名 + 值形态双层）：
 *   - 键名命中敏感键（凭据/身份/私有正文/媒体/坐标）→ 整值替换为 [REDACTED]。
 *   - 值形态命中：data: URI、长 base64、Bearer token、高精度坐标对 → 替换为 [REDACTED]。另导出 redactLogRecord：同策略但只递归纯对象与数组，类实例（Request/Reply/Error/Date/Map 等）原样透传，供 pino formatters.log 在 serializers 之前使用。
 */
const SENSITIVE_KEYS = new Set([
  // 凭据
  'token', 'access_token', 'refresh_token', 'secret', 'password', 'credential',
  'api_key', 'apikey', 'authorization', 'cookie', 'set-cookie', 'signature',
  'x-signature', 'x-media-access-token', 'access_key', 'secret_key', 'secret_id',
  'private_key', 'client_secret', 'app_secret', 'wechat_app_secret',
  // 身份
  'openid', 'wechat_subject', 'wechat_subject_cipher', 'wechat_subject_lookup',
  'token_hash', 'credential_hash', 'receipt_hash', 'session_ref', 'phone', 'mobile',
  'id_card', 'real_name',
  // 私有正文 / 媒体 / 定位
  'body', 'raw_text', 'confirmed_text', 'input_text', 'text', 'transcription',
  'media', 'image', 'audio', 'photo', 'attachment', 'avatar', 'thumbnail',
  'object_ref', 'object_ref_cipher', 'provider_request_ref_cipher', 'locator',
  'lat', 'lng', 'latitude', 'longitude', 'coordinates', 'coordinate', 'location',
  'position', 'gps',
]);

const VALUE_PATTERNS = [
  /^data:[a-z0-9/+.-]+;base64,[a-z0-9+/=]+$/i, // data URI（图片/音频内联）
  /^[a-z0-9+/]{100,}={0,2}$/i, // 长 base64（图片/音频二进制）
  /^bearer\s+[a-z0-9._~-]+$/i, // Bearer token
  /^[-+]?\d{1,3}\.\d{5,}\s*[,;]\s*[-+]?\d{1,3}\.\d{5,}$/, // 高精度坐标对
];

function toSnakeCase(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2') // camelCase 边界：appSecret -> app_Secret
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2') // 连续大写缩写边界：HTTPServer -> HTTP_Server
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_');
}

function isSensitiveKey(key) {
  if (typeof key !== 'string') return false;
  return SENSITIVE_KEYS.has(toSnakeCase(key));
}

function isCoordinatePair(value) {
  if (typeof value !== 'string') return false;
  return /^[-+]?\d{1,3}\.\d{4,}\s*[,;]\s*[-+]?\d{1,3}\.\d{4,}$/.test(value.trim());
}

function redactValue(value) {
  if (typeof value === 'string') {
    if (VALUE_PATTERNS.some((re) => re.test(value)) || isCoordinatePair(value)) {
      return '[REDACTED]';
    }
  }
  return value;
}

/**
 * 递归脱敏。返回新对象，不修改入参。
 * @param {*} value
 * @param {{ depth?: number }} [options] 递归深度上限，默认 8。
 */
export function redactForLog(value, options = {}) {
  const depth = options.depth ?? 8;
  return walk(value, depth);
}

function walk(value, depth) {
  if (depth <= 0) return '[DEPTH]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactValue(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, depth - 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k)) {
        out[k] = '[REDACTED]';
        continue;
      }
      out[k] = walk(v, depth - 1);
    }
    return out;
  }
  return String(value);
}

/**
 * 断言：对给定对象做脱敏后，必须不含任何给定的敏感原文片段。
 * 供测试与运行期自检使用。
 */
export function assertNoSensitiveLeak(value, forbiddenFragments) {
  const redacted = JSON.stringify(redactForLog(value));
  for (const fragment of forbiddenFragments) {
    if (redacted.includes(fragment)) {
      return { ok: false, leaked: fragment };
    }
  }
  return { ok: true };
}

/**
 * 日志记录级脱敏：与 redactForLog 同策略（键名 + 值形态双层），
 * 但**只递归纯对象与数组**；类实例（Request / Reply / Error / Date / Map 等）原样透传。
 *
 * 为什么需要它：pino 的 `formatters.log` 在 `serializers` **之前**运行，
 * 而 Fastify 的请求日志把原始 `Request`/`Reply` 实例塞进日志对象，
 * 它们的 method/url/ip/statusCode 都是 prototype getter —— 一旦被重建就会丢，
 * 序列化器随后只能拿到空对象。透传类实例，让 `serializers` 照常取安全字段。
 *
 * @param {*} value
 * @param {{ depth?: number }} [options] 递归深度上限，默认 8。
 */
export function redactLogRecord(value, options = {}) {
  const depth = options.depth ?? 8;
  return walkLogRecord(value, depth);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walkLogRecord(value, depth) {
  if (depth <= 0) return '[DEPTH]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubInlineText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.map((item) => walkLogRecord(item, depth - 1));
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k)) {
        out[k] = '[REDACTED]';
        continue;
      }
      out[k] = walkLogRecord(v, depth - 1);
    }
    return out;
  }
  // 类实例、函数、symbol、bigint 等一律原样返回同一个引用。
  return value;
}

/**
 * URL 内嵌凭据（`scheme://user:password@host`）。
 * 捕获组只含 `scheme://`，替换时把 `user:password@` 换成 `[REDACTED]@`，
 * 保留 scheme 与 host 便于排障。
 */
export const USERINFO_URL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi;

// VALUE_PATTERNS 的行内版本：同一批值形态，但不要求整值匹配，命中片段就地替换。
const INLINE_VALUE_PATTERNS = [
  /data:[a-z0-9/+.-]+;base64,[a-z0-9+/=]+/gi, // data URI（图片/音频内联）
  /[a-z0-9+/]{100,}={0,2}/gi, // 长 base64（图片/音频二进制）
  /bearer\s+[a-z0-9._~-]+/gi, // Bearer token
  /[-+]?\d{1,3}\.\d{5,}\s*[,;]\s*[-+]?\d{1,3}\.\d{5,}/g, // 高精度坐标对
];

/**
 * 行内擦除：把字符串**里面**出现的敏感形态替换为 [REDACTED]，返回新串；非字符串原样返回。
 * 与 `redactValue` 的区别是「整值匹配」换成「就地 replace」，用于 URL、错误消息、堆栈等
 * 敏感内容嵌在长文本里的场景。
 */
export function scrubInlineText(text) {
  if (typeof text !== 'string') return text;
  // 先擦 URL 内嵌凭据：只替换 userinfo，保留 scheme://host 便于排障。
  let out = text.replace(USERINFO_URL_PATTERN, '$1[REDACTED]@');
  for (const pattern of INLINE_VALUE_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

/** Error.cause 递归上限：顶层 + 两层 cause，再深写 `[DEPTH]`。 */
const ERROR_CAUSE_DEPTH = 3;

function serializedError(error) {
  return {
    type: typeof error.name === 'string' && error.name !== '' ? error.name : 'Error',
    message: scrubInlineText(typeof error.message === 'string' ? error.message : ''),
    stack: scrubInlineText(typeof error.stack === 'string' ? error.stack : ''),
  };
}

/** 非 Error 对象：只擦一层自有可枚举字段，不递归、不抛错。 */
function scrubObjectShallow(value) {
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      out[key] = '[REDACTED]';
      continue;
    }
    out[key] = typeof item === 'string' ? scrubInlineText(item) : item;
  }
  return out;
}

function serializeErrorForLog(value, depth) {
  if (depth <= 0) return '[DEPTH]';
  if (value instanceof Error) {
    const out = serializedError(value);
    if (typeof value.code === 'string') out.code = scrubInlineText(value.code);
    if (value.cause !== undefined) out.cause = serializeErrorForLog(value.cause, depth - 1);
    return out;
  }
  if (typeof value === 'string') {
    return { type: 'Error', message: scrubInlineText(value), stack: '' };
  }
  if (value !== null && typeof value === 'object') {
    return scrubObjectShallow(value);
  }
  return { type: 'Error', message: scrubInlineText(String(value)), stack: '' };
}

/**
 * pino `serializers.err`：把 Error 的 message / stack（以及字符串 code、cause 链）过
 * `scrubInlineText`，保证 `Error` 实例里的内嵌凭据不会随默认 err 序列化写出。
 * `cause` 最多递归 3 层，超限写 `'[DEPTH]'`；非 Error 入参安全降级，不抛错。
 */
export function redactErrorForLog(error) {
  return serializeErrorForLog(error, ERROR_CAUSE_DEPTH);
}
