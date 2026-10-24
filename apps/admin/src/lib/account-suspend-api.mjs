/**
 * 后台账号「停用」写面 HTTP 客户端——纯 ESM，无 Vue／DOM 依赖，可用假 fetch 注入测试。
 *
 * 只调用契约里存在的写接口（`packages/contracts/openapi.json`）：
 * - POST `{base}/admin/accounts/{id}/suspend`  operationId `suspendUser`，scope `accounts:suspend`
 *
 * 逐条可核的契约事实：
 * - 请求体是 `ReasonInput`（`{ reason }`，1..500，`required: true`）⇒ 停用**必须**带理由。
 * - 停用必带 `Idempotency-Key`（8..128）与 `If-Match`（强 ETag，形如 `"3"`，pattern
 *   `^"[1-9][0-9]*"$`、不允许 `*`；缺失 428 `REVISION_REQUIRED`，不匹配 409 `REVISION_CONFLICT`）。
 * - 200 返回 `AdminAccountViewEnvelope`（`{ data: AdminAccountView, meta }`），并回 `ETag` 头。
 * - 列表响应没有 ETag 头 ⇒ `If-Match` 只能由已加载那一行的 `revision` 按服务端
 *   `etagOf(revision)` 口径推出（`"<revision>"`），本模块不猜、也不把列表当版本来源。
 *
 * 不记录、不回传 access token；请求头只带 `authorization`／`accept`／`content-type`／
 * `if-match`／`idempotency-key`，不写日志、不落 localStorage。
 */
import { normalizeBaseUrl } from './admin-api.mjs';
import { ACCOUNTS_PATH, isPlainObject, readErrorEnvelope, validateAccountView } from './admin-contract.mjs';

/** 契约 `x-scope`：停用写面 scope（读面是 `accounts:read`，见 admin-contract.mjs）。 */
export const ACCOUNTS_SUSPEND_SCOPE = 'accounts:suspend';

/** 契约 `ReasonInput.reason` 长度边界。 */
export const REASON_MIN_LENGTH = 1;
export const REASON_MAX_LENGTH = 500;

/** 契约参数 `IdempotencyKey` 长度边界。 */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** 契约参数 `IfMatch` 的 pattern：`"<正整数>"`，不含 `*`。 */
export const IF_MATCH_RE = /^"[1-9][0-9]*"$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** 单账号停用 URL：`{base}/admin/accounts/{id}/suspend`；id 必须是 uuid（路径参数契约）。 */
export function buildSuspendUrl(baseUrl, id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new TypeError('id 必须是契约 uuid');
  return `${normalizeBaseUrl(baseUrl)}${ACCOUNTS_PATH}/${encodeURIComponent(id)}/suspend`;
}

/** 行级强 ETag，口径同服务端 `etagOf(revision)`；revision 非法时返回 null（不猜）。 */
export function etagForRevision(revision) {
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return null;
  return `"${revision}"`;
}

/**
 * 幂等键（`account-` + 32 hex = 40 字符，满足契约 8..128）；不含身份信息。
 * 同一次逻辑停用的**重试必须复用同一个键**，否则服务端会把重试当成第二次停用。
 */
export function newIdempotencyKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `account-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** 本地校验：`reason` 必须满足契约 `ReasonInput.reason`（1..500）。返回错误文案或 null。 */
export function reasonProblem(reason) {
  if (typeof reason !== 'string') return '理由必须是字符串';
  const length = [...reason].length;
  if (length < REASON_MIN_LENGTH) return '理由不能为空（契约 ReasonInput.reason 必填）';
  if (length > REASON_MAX_LENGTH) return `理由最长 ${REASON_MAX_LENGTH} 字符，当前 ${length}`;
  return null;
}

/** 该行是否**值得**发停用：state 必须是 `active`，且 id／revision 可推出 If-Match。 */
export function canSuspendAccount(row) {
  if (!isPlainObject(row)) return false;
  if (row.state !== 'active') return false;
  if (typeof row.id !== 'string' || !UUID_RE.test(row.id)) return false;
  return etagForRevision(row.revision) !== null;
}

/** 单资源信封 `{ data: AdminAccountView, meta }`：缺 `meta`／`data` 返回 null。 */
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
  if (status === 404 || code === 'NOT_FOUND') return 'not_found';
  if (code === 'OBJECT_UNAVAILABLE') return 'unavailable';
  if (status === 429 || code === 'RATE_LIMITED' || code === 'PROVIDER_QUOTA_EXCEEDED') return 'rate_limited';
  if (
    status === 503 ||
    status === 504 ||
    status >= 500 ||
    code === 'PROVIDER_UNAVAILABLE' ||
    code === 'PROVIDER_TIMEOUT' ||
    code === 'PROVIDER_OUTCOME_UNKNOWN'
  ) {
    return 'unavailable';
  }
  if (status === 400 || code === 'INVALID_REQUEST') return 'invalid_request';
  return 'http_error';
}

/**
 * 停用一个账号（POST）。
 *
 * `revision` 必须是**已加载那一行**的 revision（本模块按 `etagOf(revision)` 推出 `If-Match`，不猜）；
 * `idempotencyKey` 由调用方持有并**在重试时复用**；`reason` 是契约必填的 `ReasonInput.reason`。
 *
 * 返回 `{ok: true, status, requestUrl, account, etag}` 或失败对象（`kind` 见 `classify`）。
 */
export async function suspendAccount({
  fetchImpl,
  baseUrl,
  token,
  id,
  revision,
  reason,
  idempotencyKey,
  signal,
} = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return failure('network_error', { message: '当前环境没有可用的 fetch' });
  if (typeof token !== 'string' || token.length === 0) return failure('signed_out', { message: '没有后台会话令牌' });
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    return failure('invalid_request', { message: `id 必须是契约 uuid，实际 ${String(id)}` });
  }
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
  if (!IF_MATCH_RE.test(ifMatch)) {
    // 结构性兜底：本模块只产出 `"<正整数>"`，命中即说明上游改坏了口径。
    return failure('invalid_request', { message: `If-Match 形状非法：${ifMatch}` });
  }

  const requestUrl = buildSuspendUrl(baseUrl, id);
  let response;
  try {
    response = await doFetch(requestUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'if-match': ifMatch,
        'idempotency-key': idempotencyKey,
      },
      credentials: 'omit',
      body: JSON.stringify({ reason }),
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
    const account = validateAccountView(data);
    if (!account.ok) {
      return failure('invalid_response', {
        status,
        requestUrl,
        message: `响应形状不符合 AdminAccountView：${account.errors.map((e) => `${e.path} ${e.problem}`).join('；')}`,
      });
    }
    // 服务端同时回强 ETag；缺失时按 revision 推出（与 listAdminUsers 同口径），仍不猜。
    const responseEtag = typeof response.headers?.get === 'function' ? response.headers.get('etag') : null;
    const etag =
      typeof responseEtag === 'string' && IF_MATCH_RE.test(responseEtag) ? responseEtag : etagForRevision(data.revision);
    return { ok: true, status, requestUrl, account: data, etag };
  }

  const envelope = parsed.ok ? readErrorEnvelope(parsed.value) : null;
  const code = envelope?.code ?? null;
  const retryAfter = Number(response.headers?.get?.('retry-after'));
  return failure(classify(status, code), {
    status,
    code,
    inContract: envelope?.inContract ?? false,
    requestUrl,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    message: envelope?.message || `请求失败（HTTP ${status}）`,
  });
}
