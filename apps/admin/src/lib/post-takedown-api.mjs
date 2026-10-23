/**
 * 后台「社区帖子下架」（`hidePost`）HTTP 客户端 —— 纯 ESM，无 Vue／DOM 依赖，可用假 fetch 注入测试。
 *
 * 事实来源（逐条可核，均为本仓现行代码）：
 * - 契约 `packages/contracts/openapi.json` 的 `/admin/posts/{id}/hide`：operationId `hidePost`，
 *   `x-scope: sources:write`、`x-version-required: true`；参数 `id`(uuid) + `IdempotencyKey` + `IfMatch`；
 *   请求体 `ReasonInput`（`reason` 1..500、`additionalProperties: false`）；200 `AckEnvelope`
 *   （`data.accepted: boolean`，带 `ETag` 头）。契约里**没有**任何帖子读面（`/admin/posts` 只有这一条 path）。
 * - 路由 `services/api/src/routes/admin.ts`（`POST ${API_PREFIX}/admin/posts/:id/hide`，
 *   `requireAdmin` + `requireScope(OPS_SCOPES.hidePost)`，`params: uuidIdParams`）。
 * - 服务层 `services/api/src/admin/ops/service.ts` 的 `hidePost`：`parseIfMatchHeader` → `assertInput('ReasonInput')`
 *   → `normalizeIdParam` → `runIdempotentWrite`（缺 `Idempotency-Key` 是 400）。
 * - `services/api/src/admin/identity.ts` 的 `parseIfMatchHeader`：**缺 428 `REVISION_REQUIRED`**、
 *   形状不符 400 `INVALID_REQUEST`，注释逐字写着「不允许 `*`」。
 * - `services/api/src/admin/identity.ts` 的 `requireIdempotencyKeyValue`：缺 400 `IDEMPOTENCY_KEY_REQUIRED`、
 *   长度非法 400 `INVALID_REQUEST`（8..128 字符）。
 * - 失败映射（`service.ts` 的 `hideAdapter.hide` 分支）：`NOT_FOUND`→404、`DELETED`／`NOT_PUBLIC`→409
 *   `OBJECT_UNAVAILABLE`、`REVISION_CONFLICT`→409、其余→503 `PROVIDER_UNAVAILABLE`（`retryable: false`）。
 * - `services/api/src/contract.ts` 的 `ERROR_STATUS_MAP`：**`REVISION_CONFLICT` 是 409，不是 412**；
 *   全契约没有 412 这个状态 ⇒ 本模块对 412 只做「契约外，原样失败」的防御性映射，不折叠成 409。
 * - real 模式默认 503：`services/api/src/admin/ops/accounts-only.ts` 的 `hidePostWired` 门（默认 `false`）。
 * - 「已生效但审核域失败仍 503」：`services/api/src/app.ts` 的 `withModerationTakedownLink`
 *   （CAS 成功后调审核域 `withdraw` 失败 ⇒ 503 `PROVIDER_UNAVAILABLE`，`retryable: false`）。
 *
 * 本模块**不伪造任何状态**：`*` 从不作为 If-Match 发出；200 但 `accepted !== true` 判失败；
 * 503 一律是失败，且明确标「处置可能已生效」而不是「失败 = 未生效」。
 */

import { normalizeBaseUrl } from './admin-api.mjs';
import { ERROR_CODES, isPlainObject } from './admin-contract.mjs';

/** 契约路径（相对 API 基地址）；动作段固定 `hide`。 */
export const POSTS_PATH = '/admin/posts';
export const HIDE_ACTION = 'hide';

/** `hidePost` 的契约 scope（复用资料写面 scope，契约 `x-scope` 原文；没有独立的 `posts:write`）。 */
export const SOURCES_WRITE_SCOPE = 'sources:write';

/** 契约 `ReasonInput.reason` 边界（`minLength: 1`、`maxLength: 500`）。 */
export const REASON_MIN_LENGTH = 1;
export const REASON_MAX_LENGTH = 500;

/** 契约 `If-Match` pattern：必须带双引号、正整数，**不允许 `*`**。 */
export const IF_MATCH_PATTERN = /^"[1-9][0-9]*"$/;

/** 契约 `Idempotency-Key` 长度边界。 */
export const IDEMPOTENCY_KEY_MIN = 8;
export const IDEMPOTENCY_KEY_MAX = 128;

/** 幂等键前缀（便于运维在服务端幂等记录里分辨来源；不含身份信息）。 */
export const IDEMPOTENCY_KEY_PREFIX = 'admin-post-takedown-';

/** 服务端错误文案上屏的最大长度（超长截断并显式标注，不整段回显）。 */
export const SERVER_MESSAGE_MAX = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 服务端自己声明可重试的错误类（其余一律不可重试：重试同一请求不会改变结论）。 */
const RETRIABLE_KINDS = Object.freeze(['rate_limited', 'request_in_progress', 'network_error']);

function charLength(value) {
  return [...value].length;
}

function truncate(value, max = SERVER_MESSAGE_MAX) {
  if (typeof value !== 'string') return '';
  const chars = [...value];
  return chars.length <= max ? value : `${chars.slice(0, max).join('')}…（已截断）`;
}

// ------------------------------------------------------------------ 输入校验（纯函数）

/**
 * 归一化帖子 ID：trim + 小写；不是 uuid 返回 `null`（由调用方报错，不猜、不补齐）。
 * 服务端 `uuidIdParams` 对非 uuid 直接 400 `INVALID_REQUEST`。
 */
export function normalizePostId(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return UUID_RE.test(value) ? value : null;
}

/**
 * 校验操作员填的 revision（接受 `7`、`"7"`、`'"7"'` 三种输入形状）。
 *
 * **`*` 一律拒绝**：服务端 `parseIfMatchHeader` 明确不接受通配（`*` 会得到 400），
 * 所以这里在发请求之前就拒掉，而不是发一个必然失败的请求。
 */
export function validateRevision(raw) {
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) {
      return { ok: false, code: 'not_integer', problem: 'revision 必须是整数（不接受小数／NaN）' };
    }
    if (raw < 1) return { ok: false, code: 'too_small', problem: 'revision 必须 >= 1（契约 pattern 不接受 0）' };
    return { ok: true, revision: raw };
  }
  if (typeof raw !== 'string') {
    return { ok: false, code: 'type', problem: 'revision 必须是数字或字符串' };
  }
  const value = raw.trim();
  if (value === '') return { ok: false, code: 'empty', problem: 'revision 必填：填帖子当前的 revision（详情里的修订号）' };
  if (value.includes('*')) {
    return {
      ok: false,
      code: 'wildcard',
      problem: 'If-Match 不允许 *（服务端显式拒绝通配）：必须填帖子当前的 revision，如 7',
    };
  }
  const stripped = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  if (!/^[0-9]+$/.test(stripped)) {
    return { ok: false, code: 'not_integer', problem: 'revision 只能是正整数（不接受负号、小数、指数、字母）' };
  }
  const revision = Number(stripped);
  if (!Number.isSafeInteger(revision)) {
    return { ok: false, code: 'not_safe', problem: 'revision 超出安全整数范围' };
  }
  if (revision < 1) return { ok: false, code: 'too_small', problem: 'revision 必须 >= 1（契约 pattern 不接受 0）' };
  return { ok: true, revision };
}

/** 生成 `If-Match` 头值（`"<revision>"`）；非法 revision 直接抛错，绝不返回 `*`。 */
export function buildIfMatch(revision) {
  const checked = validateRevision(revision);
  if (!checked.ok) throw new RangeError(`无法生成 If-Match：${checked.problem}`);
  return `"${checked.revision}"`;
}

/** 校验一个**已存在**的 `If-Match` 头值（防通配与形状漂移；供请求构造与断言共用）。 */
export function checkIfMatchHeader(value) {
  if (typeof value !== 'string' || value === '') {
    return { ok: false, code: 'empty', problem: '缺少 If-Match' };
  }
  if (value.includes('*')) {
    return { ok: false, code: 'wildcard', problem: 'If-Match 不允许 *（服务端显式拒绝通配）' };
  }
  if (!IF_MATCH_PATTERN.test(value)) {
    return { ok: false, code: 'shape', problem: 'If-Match 必须是形如 "12" 的强 ETag' };
  }
  return { ok: true, revision: Number(value.slice(1, -1)) };
}

/** 校验并 trim 下架理由（`ReasonInput.reason`，1..500 字）。 */
export function buildReason(raw) {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  const length = charLength(reason);
  if (length < REASON_MIN_LENGTH) {
    return { ok: false, code: 'empty', problem: '下架理由必填（1..500 字）' };
  }
  if (length > REASON_MAX_LENGTH) {
    return { ok: false, code: 'too_long', problem: `下架理由 ${length} 字，超出契约上限 ${REASON_MAX_LENGTH} 字` };
  }
  return { ok: true, reason, length };
}

/** 校验并规范化 `Idempotency-Key`（8..128 字）；不合法返回 `null`。 */
export function normalizeIdempotencyKey(value) {
  if (typeof value !== 'string') return null;
  const length = charLength(value);
  if (length < IDEMPOTENCY_KEY_MIN || length > IDEMPOTENCY_KEY_MAX) return null;
  return value;
}

/** 生成幂等键（>8 字符，不含身份信息）。 */
export function newIdempotencyKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${IDEMPOTENCY_KEY_PREFIX}${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** 请求指纹：同一幂等键只允许对应同一请求（服务端同键异体是 409 `IDEMPOTENCY_CONFLICT`）。 */
export function requestFingerprint({ postId, ifMatch, reason } = {}) {
  return JSON.stringify({ post_id: postId ?? null, if_match: ifMatch ?? null, reason: reason ?? '' });
}

/**
 * 决定本次提交用哪个幂等键。
 *
 * - `previous`（上次提交的 `{key, fingerprint}`）**只在指纹完全一致时复用** —— 用于「结果未知」
 *   （网络错误／503）之后有意的重放：服务端按同一键去重，不会重复处置、也不会重复记审计；
 * - 指纹变了（换了 ID／revision／理由）⇒ 必须换新键，否则会拿到 409 `IDEMPOTENCY_CONFLICT`。
 */
export function planIdempotencyKey({ previous = null, fingerprint, generate = newIdempotencyKey } = {}) {
  const reusable =
    previous !== null &&
    typeof previous === 'object' &&
    previous.fingerprint === fingerprint &&
    normalizeIdempotencyKey(previous.key) !== null;
  if (reusable) return { key: previous.key, fingerprint, reused: true };
  return { key: generate(), fingerprint, reused: false };
}

// ------------------------------------------------------------------ 请求构造（纯函数）

/**
 * 构造一次 `hidePost` 请求。**不发请求**。
 *
 * 返回 `{ok: true, request: {url, method, headers, body, sentHeaders, ifMatch, postId}}`
 * 或 `{ok: false, problems: [{field, message}]}`（逐字段报错，不静默丢弃）。
 * `sentHeaders` 只含可公开复述的两个写头（**不含** token），供页面与证据页核对。
 */
export function buildHidePostRequest({ baseUrl, token, postId, revision, reason, idempotencyKey } = {}) {
  const problems = [];
  const normalizedId = normalizePostId(postId);
  if (normalizedId === null) {
    problems.push({ field: 'post_id', message: '帖子 ID 必须是 uuid（社区帖子 ID；契约路径参数 format: uuid）' });
  }
  const checkedRevision = validateRevision(revision);
  if (!checkedRevision.ok) problems.push({ field: 'revision', message: checkedRevision.problem });
  const checkedReason = buildReason(reason);
  if (!checkedReason.ok) problems.push({ field: 'reason', message: checkedReason.problem });
  const key = normalizeIdempotencyKey(idempotencyKey);
  if (key === null) {
    problems.push({ field: 'idempotency_key', message: `Idempotency-Key 必须是 ${IDEMPOTENCY_KEY_MIN}..${IDEMPOTENCY_KEY_MAX} 字符` });
  }
  if (typeof token !== 'string' || token === '') {
    problems.push({ field: 'token', message: '没有后台会话令牌' });
  }
  if (problems.length > 0) return { ok: false, problems };

  const ifMatch = `"${checkedRevision.revision}"`;
  // 双保险：即使上游（或未来改动）传进 `*`，这里也不会把它发出去。
  const headerCheck = checkIfMatchHeader(ifMatch);
  if (!headerCheck.ok) {
    return { ok: false, problems: [{ field: 'revision', message: headerCheck.problem }] };
  }

  const base = normalizeBaseUrl(baseUrl);
  const url = `${base}${POSTS_PATH}/${normalizedId}/${HIDE_ACTION}`;
  return {
    ok: true,
    request: {
      url,
      method: 'POST',
      postId: normalizedId,
      ifMatch,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'idempotency-key': key,
        'if-match': ifMatch,
      },
      body: { reason: checkedReason.reason },
      sentHeaders: { 'idempotency-key': key, 'if-match': ifMatch },
    },
  };
}

// ------------------------------------------------------------------ 响应与错误映射（纯函数）

/** 校验 200 的 `Ack`（`{accepted: boolean}`，`additionalProperties: false`）。 */
export function validateAck(value) {
  if (!isPlainObject(value)) {
    return { ok: false, accepted: null, extras: [], problems: [{ path: '$', problem: '不是对象' }] };
  }
  const problems = [];
  if (typeof value.accepted !== 'boolean') problems.push({ path: '$.accepted', problem: '缺少布尔 accepted' });
  const extras = Object.keys(value).filter((key) => key !== 'accepted');
  return { ok: problems.length === 0, accepted: typeof value.accepted === 'boolean' ? value.accepted : null, extras, problems };
}

/**
 * 读错误信封（`{error: {code, message, retryable, details}, meta}`）。
 *
 * 形状不符返回 `null`（不猜 code）。`retryable` 用**服务端自己的声明**，不用本地猜；
 * `execution_mode` 供页面如实显示（real 下的 503 就是「能力未接线」那一支）。
 */
export function readHideErrorEnvelope(body) {
  if (!isPlainObject(body)) return null;
  const error = body.error;
  if (!isPlainObject(error) || typeof error.code !== 'string' || error.code === '') return null;
  const meta = isPlainObject(body.meta) ? body.meta : null;
  return {
    code: error.code,
    inContract: ERROR_CODES.includes(error.code),
    message: typeof error.message === 'string' ? error.message : '',
    retryable: typeof error.retryable === 'boolean' ? error.retryable : null,
    details: Array.isArray(error.details) ? error.details : [],
    executionMode: meta !== null && typeof meta.execution_mode === 'string' ? meta.execution_mode : null,
    requestId: meta !== null && typeof meta.request_id === 'string' && meta.request_id !== '' ? meta.request_id : null,
  };
}

/** 从响应头取强 ETag（下架成功带**新** revision）；缺失或形状不符返回 `null`，不猜。 */
function readEtag(response) {
  const raw = response?.headers?.get?.('etag');
  if (typeof raw !== 'string' || !IF_MATCH_PATTERN.test(raw)) return null;
  return raw;
}

function failure(kind, extra = {}) {
  return {
    ok: false,
    kind,
    retriable: RETRIABLE_KINDS.includes(kind),
    status: null,
    code: null,
    inContract: null,
    message: '',
    requestUrl: null,
    requestId: null,
    sentHeaders: null,
    executionMode: null,
    maybeEffective: false,
    details: [],
    ...extra,
  };
}

/**
 * HTTP 响应 → 失败对象。
 *
 * 口径（按后端**实际**返回值，不按想象）：
 * - **404 同形**：有信封（`NOT_FOUND`）与无信封（代理/网关裸 404）都归 `not_found`，
 *   同一标题同一说明 —— 页面不因「有没有错误体」给出两种结论；
 * - 404 = 帖子在社区存储里查不到；已删除／非 public 是 **409 `OBJECT_UNAVAILABLE`**（不是 404），
 *   两者不混；
 * - 409 按 `code` 细分为 `revision_conflict` / `object_unavailable` / `idempotency_conflict` /
 *   `request_in_progress`；**没有 code 的 409 不猜**，归 `conflict_unknown`；
 * - **412**：本后端不会返回（`REVISION_CONFLICT` 是 409，见 `services/api/src/contract.ts`），
 *   这里只做防御性映射 `precondition_failed`，原样当失败显示，绝不折叠成 `revision_conflict`；
 * - 503／504：归 `unavailable` 且 `maybeEffective: true`（下架**可能已生效**，见 `app.ts` 的
 *   `withModerationTakedownLink`），`retriable` 取服务端声明（两支都是 `false`）。
 */
export function classifyHideFailure({ status, code = null, message = '', retryable = null, executionMode = null, details = [], requestUrl = null, requestId = null, sentHeaders = null } = {}) {
  const normalizedStatus = typeof status === 'number' && status > 0 ? status : 0;
  const inContract = code === null ? false : ERROR_CODES.includes(code);
  const base = {
    status: normalizedStatus,
    code,
    inContract,
    message: truncate(message),
    requestUrl,
    requestId,
    sentHeaders,
    executionMode,
    details: Array.isArray(details) ? details : [],
  };
  const mark = (kind, extra = {}) => {
    const result = failure(kind, { ...base, ...extra });
    // 服务端自己给了 retryable 就照它；没给才用本地闭集（429／处理中／网络错误）。
    if (typeof retryable === 'boolean') result.retriable = retryable;
    return result;
  };

  if (normalizedStatus === 401 || code === 'SESSION_REQUIRED' || code === 'SESSION_EXPIRED') return mark('signed_out');
  if (normalizedStatus === 403 || code === 'SCOPE_DENIED') return mark('forbidden');
  if (normalizedStatus === 428 || code === 'REVISION_REQUIRED') return mark('revision_required');
  if (normalizedStatus === 400 || code === 'INVALID_REQUEST' || code === 'IDEMPOTENCY_KEY_REQUIRED') {
    return mark('invalid_request');
  }
  if (normalizedStatus === 404 || code === 'NOT_FOUND') return mark('not_found');
  if (code === 'OBJECT_UNAVAILABLE') return mark('object_unavailable');
  if (code === 'REVISION_CONFLICT') return mark('revision_conflict');
  if (code === 'IDEMPOTENCY_CONFLICT') return mark('idempotency_conflict');
  if (code === 'REQUEST_IN_PROGRESS') return mark('request_in_progress');
  if (normalizedStatus === 409) return mark('conflict_unknown');
  if (normalizedStatus === 412) return mark('precondition_failed');
  if (normalizedStatus === 429 || code === 'RATE_LIMITED' || code === 'PROVIDER_QUOTA_EXCEEDED') return mark('rate_limited');
  if (normalizedStatus === 503 || normalizedStatus === 504 || normalizedStatus >= 500) {
    return mark('unavailable', { maybeEffective: true });
  }
  return mark('http_error');
}

// ------------------------------------------------------------------ 发请求

async function readJson(response) {
  try {
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: false, value: null };
  }
}

/** 从 200 响应体取 `data`（信封缺 `data`／`meta` 返回 `null`，由调用方判畸形）。 */
function readEnvelopeData(body) {
  if (!isPlainObject(body)) return null;
  if (!isPlainObject(body.meta) || !isPlainObject(body.data)) return null;
  return body.data;
}

/**
 * 执行一次下架。`fetchImpl` 可注入（测试与页面共用同一条路径），默认 `globalThis.fetch`。
 *
 * 返回 `{ok: true, status, accepted: true, etag, requestId, requestUrl, sentHeaders}` 或失败对象
 * （`classifyHideFailure` 的形状）。
 * **本函数不做任何重试**：503／网络错误都原样返回，由操作员决定是否用同一幂等键重放。
 */
export async function hidePost({ fetchImpl, baseUrl, token, postId, revision, reason, idempotencyKey, signal } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return failure('network_error', { message: '当前环境没有可用的 fetch' });

  const built = buildHidePostRequest({ baseUrl, token, postId, revision, reason, idempotencyKey });
  if (!built.ok) {
    return failure('invalid_request', {
      message: built.problems.map((problem) => problem.message).join('；'),
      problems: built.problems,
    });
  }
  const { request } = built;

  let response;
  try {
    response = await doFetch(request.url, {
      method: request.method,
      headers: request.headers,
      credentials: 'omit',
      body: JSON.stringify(request.body),
      signal,
    });
  } catch (error) {
    return failure('network_error', {
      message: `网络请求失败（结果未知，勿盲目重发）：${truncate(error instanceof Error ? error.message : String(error), 120)}`,
      requestUrl: request.url,
      sentHeaders: request.sentHeaders,
      maybeEffective: true,
    });
  }

  const status = typeof response.status === 'number' ? response.status : 0;
  const parsed = await readJson(response);

  if (response.ok === true && status >= 200 && status < 300) {
    if (!parsed.ok) {
      return failure('invalid_response', {
        status,
        requestUrl: request.url,
        sentHeaders: request.sentHeaders,
        message: '响应不是合法 JSON',
      });
    }
    const data = readEnvelopeData(parsed.value);
    if (data === null) {
      return failure('invalid_response', {
        status,
        requestUrl: request.url,
        sentHeaders: request.sentHeaders,
        requestId: typedRequestId(parsed.value),
        message: '响应信封缺少 data 或 meta',
      });
    }
    const ack = validateAck(data);
    if (!ack.ok) {
      return failure('invalid_response', {
        status,
        requestUrl: request.url,
        sentHeaders: request.sentHeaders,
        requestId: typedRequestId(parsed.value),
        message: `响应形状不符合契约 Ack：${ack.problems.map((problem) => `${problem.path} ${problem.problem}`).join('；')}`,
      });
    }
    if (ack.accepted !== true) {
      // 契约只允许 `accepted: boolean`，但「false」不构成受理 ⇒ 不当作成功。
      return failure('invalid_response', {
        status,
        requestUrl: request.url,
        sentHeaders: request.sentHeaders,
        requestId: typedRequestId(parsed.value),
        message: '服务端未确认受理（accepted 不是 true），本页不当作成功',
      });
    }
    return {
      ok: true,
      status,
      accepted: true,
      etag: readEtag(response),
      requestId: typedRequestId(parsed.value) ?? readHideErrorEnvelope(parsed.value)?.requestId ?? null,
      requestUrl: request.url,
      sentHeaders: request.sentHeaders,
      extras: ack.extras,
    };
  }

  const envelope = parsed.ok ? readHideErrorEnvelope(parsed.value) : null;
  return classifyHideFailure({
    status,
    code: envelope?.code ?? null,
    message: envelope?.message ?? '',
    retryable: envelope?.retryable ?? null,
    executionMode: envelope?.executionMode ?? null,
    details: envelope?.details ?? [],
    requestUrl: request.url,
    requestId: envelope?.requestId ?? null,
    sentHeaders: request.sentHeaders,
  });
}

/** 200 响应体里的 `meta.request_id`（审计关联键；契约响应里没有 audit event id）。 */
function typedRequestId(body) {
  const meta = isPlainObject(body) ? body.meta : null;
  if (!isPlainObject(meta)) return null;
  return typeof meta.request_id === 'string' && meta.request_id !== '' ? meta.request_id : null;
}

// ------------------------------------------------------------------ 成功 → 页面文案

/**
 * 200 受理回执 → 页面文案。
 *
 * 措辞纪律（照 `#18` 监工口径）：只说「服务端受理了 200 + accepted:true」，
 * **不说「已下架成功」** —— 本页没有社区读面，无法自证可见性；重复提交同键时服务端也会返回
 * `accepted:true`（幂等重放，`changed:false` 不再记审计），两种情形在本页看来完全一样。
 */
export function describeTakedownSuccess(result) {
  if (!result || result.ok !== true) return null;
  const etag = typeof result.etag === 'string' ? result.etag : null;
  const parts = [];
  parts.push(etag === null ? '响应未带 ETag（无法核对新 revision）' : `服务端回传新 revision ${etag}`);
  if (typeof result.requestId === 'string' && result.requestId !== '') parts.push(`request_id ${result.requestId}`);
  return {
    tone: 'ready',
    title: '服务端已受理（HTTP 200 · accepted:true）',
    detail: parts.join(' · '),
    advice:
      '本页只显示服务端回执：社区侧可见性、审计落库与 real 模式能力均未在本页验证。若该帖子此前已下架，服务端按幂等语义不重复处置，返回的仍是 accepted:true。',
  };
}

// ------------------------------------------------------------------ 失败 → 页面文案

/**
 * 失败对象 → 页面文案。**错误码与 HTTP 状态原样保留**，服务端信封 message 原样（截断后）上屏：
 * 下架面 503 的两支只能靠该文案区分（「尚未接线」vs「下架已生效但审核域未完成」）⇒ 不许吞。
 */
export function describeTakedownFailure(result) {
  if (!result || result.ok !== false) return null;
  const statusPart = result.status === null || result.status === undefined || result.status === 0 ? '' : `HTTP ${result.status}`;
  const codePart = result.code === null || result.code === undefined ? '' : `错误码 ${result.code}${result.inContract ? '' : '（契约外码）'}`;
  const modePart = typeof result.executionMode === 'string' ? `execution_mode=${result.executionMode}` : '';
  const tail = [result.message ?? '', codePart, statusPart, modePart].filter((part) => part !== '').join(' · ');

  switch (result.kind) {
    case 'signed_out':
      return { tone: 'error', title: '未登录或会话已过期', detail: tail || '请重新登录后台', advice: '重新登录后再操作；本次请求未生效。' };
    case 'forbidden':
      return {
        tone: 'error',
        title: `权限不足（服务端拒绝了 scope ${SOURCES_WRITE_SCOPE}）`,
        detail: tail || '当前后台会话缺少该接口要求的 scope',
        advice: 'scope 由服务端判定；页面只做提示，不放行。',
      };
    case 'revision_required':
      return {
        tone: 'error',
        title: '服务端要求 If-Match（HTTP 428）',
        detail: tail,
        advice: '本页总会带 If-Match；若出现 428，说明请求头在链路上被剥掉了，先排查代理再重发。',
      };
    case 'invalid_request':
      return {
        tone: 'error',
        title: '请求不符合契约（HTTP 400）',
        detail: tail,
        advice: '常见原因：帖子 ID 不是 uuid、revision 不是正整数、理由越界、幂等键长度不对。',
      };
    case 'not_found':
      // **404 同形**：有无错误信封走同一分支、同一文案（页面不因响应体形状给出两种结论）。
      return {
        tone: 'error',
        title: '目标不存在（HTTP 404）',
        detail: tail,
        advice: '服务端在社区存储里查不到这个帖子 ID。404 与「已删除」不是同一个结论：已删除是 409 OBJECT_UNAVAILABLE。',
      };
    case 'object_unavailable':
      return {
        tone: 'error',
        title: '对象状态不允许该操作（HTTP 409 OBJECT_UNAVAILABLE）',
        detail: tail,
        advice: '服务端原文说明具体是哪一支（已删除不可复活／当前不是已发布状态）。本页不把它当成成功。',
      };
    case 'revision_conflict':
      return {
        tone: 'error',
        title: '修订冲突（HTTP 409 REVISION_CONFLICT）',
        detail: tail,
        advice: '帖子修订已变化：重新取当前 revision 后再决定是否下架。',
      };
    case 'idempotency_conflict':
      return {
        tone: 'error',
        title: '幂等键冲突（HTTP 409 IDEMPOTENCY_CONFLICT）',
        detail: tail,
        advice: '同一幂等键已用于不同请求体：本页会在请求内容变化时自动换新键，仍出现则先核对表单内容。',
      };
    case 'request_in_progress':
      return {
        tone: 'warn',
        title: '同一幂等键的请求正在处理中（HTTP 409 REQUEST_IN_PROGRESS）',
        detail: tail,
        advice: '稍后用**同一**幂等键重放是安全的（服务端会重放已定型结果）。',
      };
    case 'conflict_unknown':
      return {
        tone: 'error',
        title: '服务端返回 409，但响应里没有可解析的错误码',
        detail: tail || '响应体不是契约错误信封',
        advice: '不猜是哪一支冲突（修订／幂等／对象状态）；按失败处理。',
      };
    case 'precondition_failed':
      return {
        tone: 'error',
        title: '服务端返回 HTTP 412（契约未定义该状态）',
        detail: tail || '响应体不是契约错误信封',
        advice: '本后端把修订冲突映射成 409（不是 412）；412 多半来自中间层。原样按失败显示，不折叠成 409。',
      };
    case 'rate_limited':
      return { tone: 'warn', title: '请求过于频繁（HTTP 429）', detail: tail, advice: '按服务端 Retry-After 冷却后再试。' };
    case 'unavailable':
      return {
        tone: 'error',
        title: result.status === 504 ? '服务端超时（HTTP 504）' : '服务端不可用（HTTP 503）',
        detail: tail || '服务端未返回可解析的错误信封',
        advice: result.maybeEffective
          ? '⚠ 处置可能已生效：real 模式下 503 可能是「能力未接线（未生效）」，也可能是「下架已生效但审核域缓存失效未完成」。以服务端原文与审计事件 post.hide 核对；本页不会自动重试，勿盲目重发。'
          : '稍后重试；若持续出现，先排查该环境是否已接上社区帖子存储。',
      };
    case 'network_error':
      return {
        tone: 'error',
        title: '网络请求失败（结果未知）',
        detail: tail || '请求未送达或回执丢失',
        advice: '结果未知：用**同一**幂等键重放是安全的（服务端去重），换新键则可能重复处置。',
      };
    case 'invalid_response':
      return {
        tone: 'error',
        title: '响应不符合契约',
        detail: tail || '未渲染任何状态（不猜测缺字段）',
        advice: '不当作成功；按需核对服务端版本与契约。',
      };
    default:
      return { tone: 'error', title: '请求失败', detail: tail || '未知错误', advice: '服务端未给出可识别的结论；按失败处理。' };
  }
}
