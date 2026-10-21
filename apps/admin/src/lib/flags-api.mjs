/**
 * 后台「功能开关」读写面 HTTP 客户端——纯 ESM，无 Vue／DOM 依赖，可用假 fetch 注入测试。
 *
 * 只调用契约里**存在**的两个接口（`packages/contracts/openapi.json`）：
 * - GET `{base}/admin/feature-flags`        operationId `listFlags`，scope `flags:read`
 * - PUT `{base}/admin/feature-flags/{key}`  operationId `setFlag`，scope `flags:write`
 *
 * 逐条可核的契约事实：
 * - `Flag` = `{ key, enabled, revision }`，`additionalProperties: false`；**契约里没有 scope 字段**
 *   ⇒ 本模块不造 scope 列，页面只展示 key／enabled／revision，所需 scope 只能当静态说明。
 * - `FlagInput` = `{ enabled, reason }`，两者 required（`reason` 1..500）⇒ 写操作**必须**带 reason。
 * - PUT 必带 `Idempotency-Key`（8..128）与 `If-Match`（强 ETag，形如 `"3"`，不允许 `*`；
 *   缺失 428 `REVISION_REQUIRED`，不匹配 409 `REVISION_CONFLICT`）。
 * - 列表响应**没有** ETag 头：行级 ETag 由服务端 `etagOf(revision)` 口径推出（`"<revision>"`），
 *   所以 `ifMatch` 只能来自已加载行的 revision，不能猜。
 *
 * 不记录、不回传 access token；请求头只带 `authorization`／`accept`／`content-type`／
 * `if-match`／`idempotency-key`，不写日志、不落 localStorage。
 */
import { clampLimit, normalizeBaseUrl } from './admin-api.mjs';
import { CURSOR_MAX_LENGTH, LIMIT_DEFAULT, isPlainObject, readErrorEnvelope } from './admin-contract.mjs';

/** 功能开关路径（相对 API 基地址）。 */
export const FLAGS_PATH = '/admin/feature-flags';

/** 契约 `x-scope`：读面与写面分别是两个 scope。 */
export const FLAGS_READ_SCOPE = 'flags:read';
export const FLAGS_WRITE_SCOPE = 'flags:write';

/** 契约 `Flag.key` 闭集枚举（与 `services/api/src/admin/ops/flags.ts` 的 `CONTRACT_FLAG_KEYS` 同源）。 */
export const FLAG_KEYS = Object.freeze([
  'submissions_enabled',
  'specific_herbicide_output_enabled',
  'ai_enabled',
]);

/** 契约 `FlagInput.reason` 长度边界。 */
export const REASON_MIN_LENGTH = 1;
export const REASON_MAX_LENGTH = 500;

/** 契约参数 `IdempotencyKey` 长度边界。 */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** 契约参数 `IfMatch` 的 pattern：`"<正整数>"`，不含 `*`。 */
export const IF_MATCH_RE = /^"[1-9][0-9]*"$/;

/** 失败类型 → 是否值得原样重试（同一 If-Match + 同一幂等键再发一次不会造成二次写入）。 */
export function isRetriable(kind) {
  return kind === 'rate_limited' || kind === 'unavailable' || kind === 'network_error' || kind === 'in_progress';
}

function failure(kind, extra = {}) {
  return { ok: false, kind, retriable: isRetriable(kind), status: null, code: null, message: '', ...extra };
}

async function readJson(response) {
  try {
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: false, value: null };
  }
}

/**
 * 拼开关列表 URL。`limit` 总是显式带上（便于证据页复现），`cursor` 仅在续页时带；
 * 游标超过契约上限 2048 时抛 RangeError——宁可不发请求，也不发一个必然 400 的请求。
 */
export function buildFlagsUrl(baseUrl, options = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const params = new URLSearchParams();
  params.set('limit', String(clampLimit(options.limit ?? LIMIT_DEFAULT)));
  const cursor = options.cursor;
  if (cursor !== null && cursor !== undefined) {
    if (typeof cursor !== 'string' || cursor.length === 0) throw new TypeError('cursor 必须是非空字符串');
    if (cursor.length > CURSOR_MAX_LENGTH) throw new RangeError(`cursor 超过契约上限 ${CURSOR_MAX_LENGTH} 字符`);
    params.set('cursor', cursor);
  }
  return `${base}${FLAGS_PATH}?${params.toString()}`;
}

/** 行级强 ETag，口径同服务端 `etagOf(revision)`；revision 非法时返回 null（不猜）。 */
export function etagForRevision(revision) {
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return null;
  return `"${revision}"`;
}

/**
 * 幂等键（`flag-` + 32 hex = 37 字符，满足契约 8..128）；不含身份信息。
 * 同一次逻辑写入的**重试必须复用同一个键**，否则服务端会把重试当成第二次写。
 */
export function newIdempotencyKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `flag-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** 本地校验：`reason` 必须满足契约 `FlagInput.reason`（1..500）。返回错误文案或 null。 */
export function reasonProblem(reason) {
  if (typeof reason !== 'string') return '理由必须是字符串';
  const length = [...reason].length;
  if (length < REASON_MIN_LENGTH) return '理由不能为空（契约 FlagInput.reason 必填）';
  if (length > REASON_MAX_LENGTH) return `理由最长 ${REASON_MAX_LENGTH} 字符，当前 ${length}`;
  return null;
}

/**
 * 校验一行 `Flag`。
 *
 * - `errors`：违反 required／type／enum ⇒ 该响应不可信，调用方整体判为畸形响应。
 * - `warnings`：`additionalProperties: false` 的多余字段 ⇒ 直接丢弃、不猜含义。
 */
export function validateFlag(value) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(value)) {
    errors.push({ path: '$', problem: '不是对象' });
    return { ok: false, errors, warnings };
  }

  if (typeof value.key !== 'string' || value.key.length === 0) {
    errors.push({ path: '$.key', problem: '缺少非空字符串 key' });
  } else if (!FLAG_KEYS.includes(value.key)) {
    errors.push({ path: '$.key', problem: `key 不在契约闭集 enum：${value.key}` });
  }

  if (typeof value.enabled !== 'boolean') {
    errors.push({ path: '$.enabled', problem: '缺少布尔 enabled' });
  }

  if (typeof value.revision !== 'number' || !Number.isInteger(value.revision)) {
    errors.push({ path: '$.revision', problem: '缺少整数 revision' });
  } else if (value.revision < 1) {
    errors.push({ path: '$.revision', problem: `revision 需 >= 1，实际 ${value.revision}` });
  }

  const known = new Set(['key', 'enabled', 'revision']);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) warnings.push({ path: `$.${key}`, problem: '契约外字段（不展示、不推断含义）' });
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 校验一页 `FlagPage`（envelope 内 `data`）：`next_cursor` 为 null 表示末页。 */
export function validateFlagPage(value) {
  const errors = [];
  const warnings = [];
  const items = [];
  let nextCursor = null;

  if (!isPlainObject(value)) {
    errors.push({ path: '$', problem: '不是对象' });
    return { ok: false, errors, warnings, items, nextCursor };
  }

  if (!Array.isArray(value.items)) {
    errors.push({ path: '$.items', problem: '缺少数组 items' });
  } else {
    value.items.forEach((item, index) => {
      const result = validateFlag(item);
      for (const error of result.errors) errors.push({ path: `$.items[${index}]${error.path.slice(1)}`, problem: error.problem });
      for (const warning of result.warnings) warnings.push({ path: `$.items[${index}]${warning.path.slice(1)}`, problem: warning.problem });
      items.push(item);
    });
  }

  if (!('next_cursor' in value)) {
    errors.push({ path: '$.next_cursor', problem: '缺少 next_cursor（末页须显式为 null）' });
  } else if (value.next_cursor === null) {
    nextCursor = null;
  } else if (typeof value.next_cursor !== 'string') {
    errors.push({ path: '$.next_cursor', problem: 'next_cursor 只能是字符串或 null' });
  } else if (value.next_cursor.length === 0) {
    errors.push({ path: '$.next_cursor', problem: 'next_cursor 为空串（契约 minLength 1）' });
  } else if (value.next_cursor.length > CURSOR_MAX_LENGTH) {
    errors.push({ path: '$.next_cursor', problem: `next_cursor 长度 ${value.next_cursor.length} 超出 ${CURSOR_MAX_LENGTH}` });
  } else {
    nextCursor = value.next_cursor;
  }

  for (const key of Object.keys(value)) {
    if (key !== 'items' && key !== 'next_cursor') warnings.push({ path: `$.${key}`, problem: '契约外字段' });
  }

  return { ok: errors.length === 0, errors, warnings, items, nextCursor };
}

/** 单资源信封 `{ data: Flag, meta }`：缺 `meta`／`data` 返回 null（由调用方判畸形）。 */
function readSingleEnvelope(body) {
  if (!isPlainObject(body)) return null;
  if (!isPlainObject(body.meta)) return null; // 契约 required: data + meta
  if (!isPlainObject(body.data)) return null;
  return body.data;
}

/** HTTP 状态 + 契约错误码 → 本模块的失败类型（未知 code 保留在 `code` 并标 `inContract: false`）。 */
function classify(status, code) {
  if (status === 401 || code === 'SESSION_REQUIRED' || code === 'SESSION_EXPIRED' || code === 'ACCOUNT_INACTIVE') {
    return 'signed_out';
  }
  if (status === 403 || code === 'SCOPE_DENIED') return 'forbidden';
  if (status === 428 || code === 'REVISION_REQUIRED') return 'revision_required';
  // 契约/服务端用 409 REVISION_CONFLICT；412 不是本服务产出，但同属「前置条件失败」，一并按修订冲突呈现。
  if (code === 'REVISION_CONFLICT' || status === 412) return 'revision_conflict';
  if (code === 'IDEMPOTENCY_CONFLICT') return 'idempotency_conflict';
  if (code === 'IDEMPOTENCY_KEY_REQUIRED') return 'idempotency_key_required';
  if (code === 'REQUEST_IN_PROGRESS') return 'in_progress';
  if (code === 'OBJECT_UNAVAILABLE') return 'unavailable';
  if (status === 404 || code === 'NOT_FOUND') return 'not_found';
  if (code === 'INVALID_CURSOR') return 'invalid_cursor';
  if (status === 429 || code === 'RATE_LIMITED') return 'rate_limited';
  if (status === 503 || status === 504 || status >= 500 || code === 'PROVIDER_UNAVAILABLE') return 'unavailable';
  if (status === 400 || code === 'INVALID_REQUEST') return 'invalid_request';
  return 'http_error';
}

/**
 * 请求一页开关列表。
 *
 * 返回 `{ok: true, status, requestUrl, page: {items, nextCursor}}` 或
 * `{ok: false, kind, retriable, status, code, inContract, message, requestUrl}`。
 */
export async function fetchFlagsPage({ fetchImpl, baseUrl, token, cursor = null, limit = LIMIT_DEFAULT, signal } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return failure('network_error', { message: '当前环境没有可用的 fetch' });
  if (typeof token !== 'string' || token.length === 0) return failure('signed_out', { message: '没有后台会话令牌' });

  let requestUrl;
  try {
    requestUrl = buildFlagsUrl(baseUrl, { cursor, limit });
  } catch (error) {
    return failure('invalid_cursor', { message: error instanceof Error ? error.message : '游标不合法' });
  }

  let response;
  try {
    response = await doFetch(requestUrl, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      credentials: 'omit',
      signal,
    });
  } catch (error) {
    return failure('network_error', { message: error instanceof Error ? error.message : '网络请求失败', requestUrl });
  }

  const status = typeof response.status === 'number' ? response.status : 0;
  const parsed = await readJson(response);

  if (response.ok && status >= 200 && status < 300) {
    if (!parsed.ok) return failure('invalid_response', { status, requestUrl, message: '响应不是合法 JSON' });
    const data = isPlainObject(parsed.value) ? parsed.value.data : null;
    if (!isPlainObject(parsed.value) || !isPlainObject(parsed.value.meta) || !isPlainObject(data)) {
      return failure('invalid_response', { status, requestUrl, message: '响应信封缺少 data 或 meta' });
    }
    const page = validateFlagPage(data);
    if (!page.ok) {
      return failure('invalid_response', {
        status,
        requestUrl,
        message: `响应形状不符合 FlagPage：${page.errors.map((e) => `${e.path} ${e.problem}`).join('；')}`,
      });
    }
    return { ok: true, status, requestUrl, page: { items: page.items, nextCursor: page.nextCursor } };
  }

  const envelope = parsed.ok ? readErrorEnvelope(parsed.value) : null;
  const code = envelope?.code ?? null;
  const kind = classify(status, code);
  return failure(kind, {
    status,
    code,
    inContract: envelope?.inContract ?? false,
    requestUrl,
    message: envelope?.message || `请求失败（HTTP ${status}）`,
  });
}

/**
 * 切换一个开关（PUT）。
 *
 * `ifMatch` 必须是**已加载那一行**的 revision 推出的强 ETag（本模块不替你猜）；
 * `idempotencyKey` 由调用方持有并**在重试时复用**。
 *
 * 返回 `{ok: true, status, requestUrl, flag, etag}` 或失败对象（`kind` 见 `classify`）。
 */
export async function putFlag({
  fetchImpl,
  baseUrl,
  token,
  key,
  enabled,
  reason,
  revision,
  idempotencyKey,
  signal,
} = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return failure('network_error', { message: '当前环境没有可用的 fetch' });
  if (typeof token !== 'string' || token.length === 0) return failure('signed_out', { message: '没有后台会话令牌' });
  if (typeof key !== 'string' || !FLAG_KEYS.includes(key)) {
    return failure('invalid_request', { message: `key 不在契约闭集内：${String(key)}` });
  }
  if (typeof enabled !== 'boolean') return failure('invalid_request', { message: 'enabled 必须是布尔值' });
  const problem = reasonProblem(reason);
  if (problem !== null) return failure('invalid_request', { message: problem });
  const ifMatch = etagForRevision(revision);
  if (ifMatch === null) {
    return failure('invalid_request', { message: `ifMatch 需要正整数 revision，实际 ${String(revision)}` });
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < IDEMPOTENCY_KEY_MIN_LENGTH) {
    return failure('idempotency_key_required', { message: '缺少可用的 Idempotency-Key（本模块应先 newIdempotencyKey()）' });
  }
  if (idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return failure('invalid_request', { message: `Idempotency-Key 超过契约上限 ${IDEMPOTENCY_KEY_MAX_LENGTH} 字符` });
  }

  const requestUrl = `${normalizeBaseUrl(baseUrl)}${FLAGS_PATH}/${encodeURIComponent(key)}`;
  let response;
  try {
    response = await doFetch(requestUrl, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'if-match': ifMatch,
        'idempotency-key': idempotencyKey,
      },
      credentials: 'omit',
      body: JSON.stringify({ enabled, reason }),
      signal,
    });
  } catch (error) {
    return failure('network_error', { message: error instanceof Error ? error.message : '网络请求失败', requestUrl });
  }

  const status = typeof response.status === 'number' ? response.status : 0;
  const parsed = await readJson(response);

  if (response.ok && status >= 200 && status < 300) {
    if (!parsed.ok) return failure('invalid_response', { status, requestUrl, message: '响应不是合法 JSON' });
    const data = readSingleEnvelope(parsed.value);
    if (data === null) return failure('invalid_response', { status, requestUrl, message: '响应信封缺少 data 或 meta' });
    const flag = validateFlag(data);
    if (!flag.ok) {
      return failure('invalid_response', {
        status,
        requestUrl,
        message: `响应形状不符合 Flag：${flag.errors.map((e) => `${e.path} ${e.problem}`).join('；')}`,
      });
    }
    // 服务端同时回强 ETag；缺失时按 revision 推出（与 listFlags 同口径），仍不猜。
    const responseEtag = typeof response.headers?.get === 'function' ? response.headers.get('etag') : null;
    const etag =
      typeof responseEtag === 'string' && IF_MATCH_RE.test(responseEtag) ? responseEtag : etagForRevision(data.revision);
    return { ok: true, status, requestUrl, flag: data, etag };
  }

  const envelope = parsed.ok ? readErrorEnvelope(parsed.value) : null;
  const code = envelope?.code ?? null;
  const kind = classify(status, code);
  const retryAfter = Number(response.headers?.get?.('retry-after'));
  return failure(kind, {
    status,
    code,
    inContract: envelope?.inContract ?? false,
    requestUrl,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    message: envelope?.message || `请求失败（HTTP ${status}）`,
  });
}
