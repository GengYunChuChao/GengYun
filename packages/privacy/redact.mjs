/**
 * GY-I27 隐私模块 · 日志脱敏。
 *
 * 硬红线：日志严禁落私有正文、图片、音频、精确坐标、凭据。
 * 本模块对写入日志前的任意值做递归脱敏，供审计/日志/错误封套复用。
 *
 * 脱敏策略（键名 + 值形态双层）：
 *   - 键名命中敏感键（凭据/身份/私有正文/媒体/坐标）→ 整值替换为 [REDACTED]。
 *   - 值形态命中：data: URI、长 base64、Bearer token、高精度坐标对 → 替换为 [REDACTED]。
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
