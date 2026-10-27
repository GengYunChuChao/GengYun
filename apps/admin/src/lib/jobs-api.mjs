/**
 * 后台「AI 作业台」读＋取消面 HTTP 客户端——纯 ESM，无 Vue／DOM 依赖，可用假 fetch 注入测试。
 *
 * 只调用契约里**存在**的两个接口（`packages/contracts/openapi.json`）：
 * - GET  `{base}/admin/jobs`              operationId `listAdminJobs`，scope `jobs:read`（:10043-10130）
 * - POST `{base}/admin/jobs/{id}/cancel`  operationId `cancelAdminJob`，scope `jobs:cancel`（:10131-10237）
 *
 * 逐条可核的契约事实：
 * - `AdminJob` = `{ id, revision, kind, target_ref, state, deadline_at, created_at, error_code, result }`，
 *   九个字段全 required、`additionalProperties: false`；后台视图里 `result` 是 `type: "null"`
 *   ⇒ 本模块不造 result 列，页面只展示最小状态／错误元数据。
 * - `JobState` = queued／running／succeeded／uncertain／failed／timed_out／cancelled
 *   （:11004-11015；**契约里没有 `completed`**，别把 succeeded 写成 completed）。
 *   终态 = succeeded／uncertain／failed／timed_out／cancelled；只有 queued／running 值得发取消。
 * - 取消请求体是 `ReasonInput`（`{ reason }`，1..500，`required: true`）⇒ 取消**必须**带理由；
 *   缺理由的请求服务端只会回 400，前端没必要先发一个必然失败的请求。
 * - 取消必带 `Idempotency-Key`（8..128，:10963-10973）与 `If-Match`（强 ETag，形如 `"3"`，
 *   pattern `^"[1-9][0-9]*"$`、不允许 `*`；缺失 428 `REVISION_REQUIRED`，不匹配 409 `REVISION_CONFLICT`）。
 * - 列表响应**没有** ETag 头（契约 200 的 ETag 描述「资源revision强ETag；列表无此头」）
 *   ⇒ `If-Match` 只能由已加载那一行的 `revision` 按服务端 `etagOf(revision)` 口径推出（`"<revision>"`），
 *   本模块不猜、也不把列表当版本来源。
 *
 * 不记录、不回传 access token；请求头只带 `authorization`／`accept`／`content-type`／
 * `if-match`／`idempotency-key`，不写日志、不落 localStorage。
 *
 * 本片只允许新增这一个 lib 文件，故「页面状态机」的纯函数（`initialJobsState`／`reduceJobs`／
 * `describeJobs`／`jobRowViews`）也放在这里：与 `view-model.mjs`／`flags-view-model.mjs` 同构，
 * 同样是无 DOM、无全局副作用的纯函数，组件只负责把状态接到 DOM。
 */
import { clampLimit, normalizeBaseUrl, serverAllowsRetry } from './admin-api.mjs';
import { CURSOR_MAX_LENGTH, LIMIT_DEFAULT, LIMIT_MAX, isPlainObject, readErrorEnvelope } from './admin-contract.mjs';

/** 作业台路径（相对 API 基地址）。 */
export const JOBS_PATH = '/admin/jobs';

/** 契约 `x-scope`：读面与取消面分别是两个 scope。 */
export const JOBS_READ_SCOPE = 'jobs:read';
export const JOBS_CANCEL_SCOPE = 'jobs:cancel';

/** 契约 `AdminJob.kind` 闭集枚举。 */
export const JOB_KINDS = Object.freeze([
  'recognition',
  'ocr',
  'transcription',
  'answer',
  'synthesis',
  'moderation',
]);

/** 契约 `JobState` 闭集枚举（顺序同 openapi.json）。 */
export const JOB_STATES = Object.freeze([
  'queued',
  'running',
  'succeeded',
  'uncertain',
  'failed',
  'timed_out',
  'cancelled',
]);

/** 终态：这些状态的行不再有「取消」语义，行内按钮必须禁用。 */
export const TERMINAL_JOB_STATES = Object.freeze(['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled']);

/** 未终态但仍在跑／排队的两个状态才值得发取消。 */
export const CANCELABLE_JOB_STATES = Object.freeze(['queued', 'running']);

/** 状态 → 徽标色调（页面 `.pill` 的既有 class 闭集：ok／pending／warn／danger／off）。 */
export const JOB_STATE_TONES = Object.freeze({
  queued: 'off',
  running: 'pending',
  succeeded: 'ok',
  uncertain: 'warn',
  failed: 'danger',
  timed_out: 'danger',
  cancelled: 'off',
});

/** 状态的中文注释（只做展示提示，不复述成契约外字段）。 */
export const JOB_STATE_NOTES = Object.freeze({
  queued: '已入队，尚未开始',
  running: '执行中',
  succeeded: '成功（契约用 succeeded，不是 completed）',
  uncertain: '结果未定：外部结果未知，需人工判断，不可当作成功',
  failed: '失败',
  timed_out: '超时',
  cancelled: '已取消',
});

/** 契约 `ReasonInput.reason` 长度边界。 */
export const REASON_MIN_LENGTH = 1;
export const REASON_MAX_LENGTH = 500;

/** 契约参数 `IdempotencyKey` 长度边界。 */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** 契约参数 `IfMatch` 的 pattern：`"<正整数>"`，不含 `*`。 */
export const IF_MATCH_RE = /^"[1-9][0-9]*"$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 失败类型 → **本地**闭集猜测；只在拿不到服务端声明时兜底（判据是 `serverAllowsRetry`，别拿它替代）。 */
export function isRetriable(kind) {
  return kind === 'rate_limited' || kind === 'unavailable' || kind === 'network_error' || kind === 'in_progress';
}

function failure(kind, extra = {}) {
  return { ok: false, kind, retriable: isRetriable(kind), serverRetryable: null, status: null, code: null, message: '', ...extra };
}

async function readJson(response) {
  try {
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: false, value: null };
  }
}

/** 状态是否属于契约终态闭集；契约外状态返回 false（不推断含义）。 */
export function isTerminalJobState(state) {
  return typeof state === 'string' && TERMINAL_JOB_STATES.includes(state);
}

/** 该行是否**值得**发取消：state 在 queued／running，且 id／revision 可推出 If-Match。 */
export function canCancelJob(job) {
  if (!isPlainObject(job)) return false;
  if (typeof job.state !== 'string' || !CANCELABLE_JOB_STATES.includes(job.state)) return false;
  if (typeof job.id !== 'string' || !UUID_RE.test(job.id)) return false;
  return etagForRevision(job.revision) !== null;
}

/**
 * 拼作业列表 URL。`limit` 总是显式带上（便于证据页复现），`cursor` 仅在续页时带；
 * 游标超过契约上限 2048 时抛 RangeError——宁可不发请求，也不发一个必然 400 的请求。
 */
export function buildJobsUrl(baseUrl, options = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const params = new URLSearchParams();
  params.set('limit', String(clampLimit(options.limit ?? LIMIT_DEFAULT)));
  const cursor = options.cursor;
  if (cursor !== null && cursor !== undefined) {
    if (typeof cursor !== 'string' || cursor.length === 0) throw new TypeError('cursor 必须是非空字符串');
    if (cursor.length > CURSOR_MAX_LENGTH) throw new RangeError(`cursor 超过契约上限 ${CURSOR_MAX_LENGTH} 字符`);
    params.set('cursor', cursor);
  }
  return `${base}${JOBS_PATH}?${params.toString()}`;
}

/** 单行取消 URL：`{base}/admin/jobs/{id}/cancel`；id 必须是 uuid（路径参数契约）。 */
export function buildCancelUrl(baseUrl, id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new TypeError('id 必须是契约 uuid');
  return `${normalizeBaseUrl(baseUrl)}${JOBS_PATH}/${encodeURIComponent(id)}/cancel`;
}

/** 行级强 ETag，口径同服务端 `etagOf(revision)`；revision 非法时返回 null（不猜）。 */
export function etagForRevision(revision) {
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return null;
  return `"${revision}"`;
}

/**
 * 幂等键（`job-` + 32 hex = 36 字符，满足契约 8..128）；不含身份信息。
 * 同一次逻辑取消的**重试必须复用同一个键**，否则服务端会把重试当成第二次取消。
 */
export function newIdempotencyKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `job-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** 本地校验：`reason` 必须满足契约 `ReasonInput.reason`（1..500）。返回错误文案或 null。 */
export function reasonProblem(reason) {
  if (typeof reason !== 'string') return '理由必须是字符串';
  const length = [...reason].length;
  if (length < REASON_MIN_LENGTH) return '理由不能为空（契约 ReasonInput.reason 必填）';
  if (length > REASON_MAX_LENGTH) return `理由最长 ${REASON_MAX_LENGTH} 字符，当前 ${length}`;
  return null;
}

/**
 * 校验一行 `AdminJob`。
 *
 * - `errors`：违反 required／type／enum ⇒ 该响应不可信，调用方整体判为畸形响应。
 * - `warnings`：uuid 形态、date-time 可解析性、`additionalProperties: false` 的多余字段
 *   ⇒ 行仍可渲染（原样展示，不重排、不猜含义）。
 */
export function validateJob(value) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(value)) {
    errors.push({ path: '$', problem: '不是对象' });
    return { ok: false, errors, warnings };
  }

  if (typeof value.id !== 'string' || value.id.length === 0) {
    errors.push({ path: '$.id', problem: '缺少字符串 id' });
  } else if (!UUID_RE.test(value.id)) {
    warnings.push({ path: '$.id', problem: '不符合契约 uuid 格式' });
  }

  if (typeof value.revision !== 'number' || !Number.isInteger(value.revision)) {
    errors.push({ path: '$.revision', problem: '缺少整数 revision' });
  } else if (value.revision < 1) {
    errors.push({ path: '$.revision', problem: `revision 需 >= 1，实际 ${value.revision}` });
  }

  if (typeof value.kind !== 'string') {
    errors.push({ path: '$.kind', problem: '缺少字符串 kind' });
  } else if (!JOB_KINDS.includes(value.kind)) {
    errors.push({ path: '$.kind', problem: `kind 不在契约 enum：${value.kind}` });
  }

  if (!isPlainObject(value.target_ref)) {
    errors.push({ path: '$.target_ref', problem: '缺少对象 target_ref' });
  } else if (typeof value.target_ref.type !== 'string' || typeof value.target_ref.id !== 'string') {
    errors.push({ path: '$.target_ref', problem: 'target_ref 需要字符串 type 与 id' });
  }

  if (typeof value.state !== 'string') {
    errors.push({ path: '$.state', problem: '缺少字符串 state' });
  } else if (!JOB_STATES.includes(value.state)) {
    errors.push({ path: '$.state', problem: `state 不在契约 enum：${value.state}` });
  }

  for (const field of ['deadline_at', 'created_at']) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      errors.push({ path: `$.${field}`, problem: `缺少字符串 ${field}` });
    } else if (Number.isNaN(Date.parse(value[field]))) {
      warnings.push({ path: `$.${field}`, problem: '不是可解析的 date-time（原样展示，不重排）' });
    }
  }

  if (!('error_code' in value)) {
    errors.push({ path: '$.error_code', problem: '缺少 error_code（无错误须显式为 null）' });
  } else if (value.error_code !== null && typeof value.error_code !== 'string') {
    errors.push({ path: '$.error_code', problem: 'error_code 只能是字符串或 null' });
  }

  if (!('result' in value)) {
    errors.push({ path: '$.result', problem: '缺少 result（后台视图恒为 null，须显式给出）' });
  } else if (value.result !== null) {
    warnings.push({ path: '$.result', problem: '后台视图契约是 type: null；非 null 值不展示' });
  }

  const known = new Set(['id', 'revision', 'kind', 'target_ref', 'state', 'deadline_at', 'created_at', 'error_code', 'result']);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) warnings.push({ path: `$.${key}`, problem: '契约外字段（不展示、不推断含义）' });
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 校验一页 `AdminJobPage`（envelope 内 `data`）。
 *
 * `next_cursor` 为 `null` 表示已到末页；空 `items` + `null` 是**合法的空列表**，
 * 页面必须按空态呈现，不能当成「接口坏了」。
 */
export function validateJobPage(value) {
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
    if (value.items.length > LIMIT_MAX) {
      warnings.push({ path: '$.items', problem: `条目数 ${value.items.length} 超出契约 maxItems ${LIMIT_MAX}` });
    }
    value.items.forEach((item, index) => {
      const result = validateJob(item);
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

/** 单资源信封 `{ data: AdminJob, meta }`：缺 `meta`／`data` 返回 null（由调用方判畸形）。 */
function readSingleEnvelope(body) {
  if (!isPlainObject(body)) return null;
  if (!isPlainObject(body.meta)) return null; // 契约 required: data + meta
  if (!isPlainObject(body.data)) return null;
  return body.data;
}

/** 信封 `meta.request_id`：缺失时不猜，返回 null。 */
function readRequestId(body) {
  if (!isPlainObject(body) || !isPlainObject(body.meta)) return null;
  return typeof body.meta.request_id === 'string' ? body.meta.request_id : null;
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
  if (status === 429 || code === 'RATE_LIMITED' || code === 'PROVIDER_QUOTA_EXCEEDED') return 'rate_limited';
  if (status === 503 || status === 504 || status >= 500 || code === 'PROVIDER_UNAVAILABLE') return 'unavailable';
  if (code === 'PROVIDER_TIMEOUT') return 'unavailable';
  if (code === 'PROVIDER_OUTCOME_UNKNOWN') return 'unavailable';
  if (status === 400 || code === 'INVALID_REQUEST') return 'invalid_request';
  return 'http_error';
}

/**
 * 请求一页作业列表（GET）。
 *
 * 返回 `{ok: true, status, requestUrl, requestId, page: {items, nextCursor}}` 或
 * `{ok: false, kind, retriable, status, code, inContract, message, requestUrl}`。
 */
export async function listJobs({ fetchImpl, baseUrl, token, cursor = null, limit = LIMIT_DEFAULT, signal } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return failure('network_error', { message: '当前环境没有可用的 fetch' });
  if (typeof token !== 'string' || token.length === 0) return failure('signed_out', { message: '没有后台会话令牌' });

  let requestUrl;
  try {
    requestUrl = buildJobsUrl(baseUrl, { cursor, limit });
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
    const page = validateJobPage(data);
    if (!page.ok) {
      return failure('invalid_response', {
        status,
        requestUrl,
        message: `响应形状不符合 AdminJobPage：${page.errors.map((e) => `${e.path} ${e.problem}`).join('；')}`,
      });
    }
    return { ok: true, status, requestUrl, requestId: readRequestId(parsed.value), page: { items: page.items, nextCursor: page.nextCursor } };
  }

  const envelope = parsed.ok ? readErrorEnvelope(parsed.value) : null;
  const code = envelope?.code ?? null;
  const retryAfter = Number(response.headers?.get?.('retry-after'));
  return failure(classify(status, code), {
    status,
    code,
    inContract: envelope?.inContract ?? false, serverRetryable: envelope === null ? false : envelope.retryable === true,
    requestUrl,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    message: envelope?.message || `请求失败（HTTP ${status}）`,
  });
}

/**
 * 取消一个作业（POST）。
 *
 * `revision` 必须是**已加载那一行**的 revision（本模块按 `etagOf(revision)` 推出 `If-Match`，不猜）；
 * `idempotencyKey` 由调用方持有并**在重试时复用**；`reason` 是契约必填的 `ReasonInput.reason`。
 *
 * 返回 `{ok: true, status, requestUrl, requestId, job, etag, sent}` 或失败对象（`kind` 见 `classify`）。
 * `sent` 原样记录本次真正发出的 `if-match`／`idempotency-key`，供页面显示回执（不回传令牌）。
 */
export async function cancelJob({
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

  const requestUrl = buildCancelUrl(baseUrl, id);
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
    const job = validateJob(data);
    if (!job.ok) {
      return failure('invalid_response', {
        status,
        requestUrl,
        message: `响应形状不符合 AdminJob：${job.errors.map((e) => `${e.path} ${e.problem}`).join('；')}`,
      });
    }
    // 服务端同时回强 ETag；缺失时按 revision 推出（与 listJobs 同口径），仍不猜。
    const responseEtag = typeof response.headers?.get === 'function' ? response.headers.get('etag') : null;
    const etag =
      typeof responseEtag === 'string' && IF_MATCH_RE.test(responseEtag) ? responseEtag : etagForRevision(data.revision);
    return {
      ok: true,
      status,
      requestUrl,
      requestId: readRequestId(parsed.value),
      job: data,
      etag,
      sent: { 'if-match': ifMatch, 'idempotency-key': idempotencyKey },
    };
  }

  const envelope = parsed.ok ? readErrorEnvelope(parsed.value) : null;
  const code = envelope?.code ?? null;
  const retryAfter = Number(response.headers?.get?.('retry-after'));
  return failure(classify(status, code), {
    status,
    code,
    inContract: envelope?.inContract ?? false, serverRetryable: envelope === null ? false : envelope.retryable === true,
    requestUrl,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    message: envelope?.message || `请求失败（HTTP ${status}）`,
  });
}

/**
 * 服务端声明优先：`serverRetryable` 是 boolean 就照它，`null`（根本没拿到响应）才回落到本地闭集。
 *
 * R67-B04：判据本体已收敛到 `admin-api.mjs` 的**唯一**一处实现（账号目录／停用写面／审计日志／
 * 管理员面都引同一份），这里只再导出，保持既有 `import { serverAllowsRetry } from './jobs-api.mjs'` 不断。
 * 「重试」按钮和「稍后重试」字样只许出现在服务端确实允许自动重试的时候。
 */
export { serverAllowsRetry };

/** 失败对象 → 页面文案（标题/说明/色调/是否可重试/可执行动作）。不伪造成功。 */
export function describeFailure(result) {
  if (!result || result.ok !== false) return null;
  const suffix = result.status === null || result.status === undefined ? '' : `（HTTP ${result.status}）`;
  // 服务端声明优先：不可自动重试时既不给「重试」按钮，也不出现「稍后重试」字样。
  const retry = serverAllowsRetry(result);
  const wait =
    result.retryAfterSeconds === null || result.retryAfterSeconds === undefined ? '' : `（约 ${result.retryAfterSeconds} 秒后）`;
  switch (result.kind) {
    case 'signed_out':
      return { title: '未登录或会话已过期', detail: `请重新登录后台${suffix}`, tone: 'error', retriable: false, action: 'sign_in' };
    case 'forbidden':
      return {
        title: '权限不足（scope 不足）',
        detail: `后台会话有效，但读面要求 ${JOBS_READ_SCOPE}、取消要求 ${JOBS_CANCEL_SCOPE}${suffix}；需由持有 scopes:write 的管理员补授后重新登录，或先退出登录`,
        tone: 'error',
        retriable: false,
        action: 'none',
      };
    case 'invalid_cursor':
      return { title: '游标无效', detail: '服务端拒绝该游标，需从第一页重新读取', tone: 'error', retriable: false, action: 'restart' };
    case 'revision_required':
      return {
        title: '缺少 If-Match',
        detail: '服务端要求 If-Match: "<revision>"（428 REVISION_REQUIRED），需读取当前 revision 后再取消',
        tone: 'error',
        retriable: false,
        action: 'reload',
      };
    case 'revision_conflict':
      return {
        title: '修订冲突（If-Match 与当前 revision 不一致）',
        detail: '该行已被改动：需重新读取后再取消，别用旧 revision 重试',
        tone: 'stale',
        retriable: false,
        action: 'reload',
      };
    case 'idempotency_conflict':
      return {
        title: '幂等键与请求体不匹配',
        detail: '同一 Idempotency-Key 换了 body（理由/目标）会得到 409 IDEMPOTENCY_CONFLICT；换新键重发或重新读取',
        tone: 'error',
        retriable: false,
        action: 'reload',
      };
    case 'idempotency_key_required':
      return { title: '缺少 Idempotency-Key', detail: '本页每次点击生成新键，重试复用旧键', tone: 'error', retriable: false, action: 'none' };
    case 'in_progress':
      return {
        title: '同一请求仍在处理中',
        detail: retry
          ? '服务端识别到同一幂等键的请求在飞：用同一幂等键重试是安全的'
          : '服务端识别到同一幂等键的请求在飞，且服务端声明不可自动重试（retryable=false）；请先重新读取确认结果',
        tone: 'stale',
        retriable: retry,
        action: retry ? 'retry' : 'reload',
      };
    case 'not_found':
      return { title: '作业不存在', detail: `服务端没有该作业（可能已被清理）${suffix}`, tone: 'stale', retriable: false, action: 'reload' };
    case 'rate_limited':
      return {
        title: '请求过于频繁',
        detail: retry
          ? `后端限流，稍后重试${wait}${suffix}`
          : `后端限流，且服务端声明不可自动重试（retryable=false），请稍后再确认状态${wait}${suffix}`,
        tone: 'stale',
        retriable: retry,
        action: retry ? 'retry' : 'none',
      };
    case 'unavailable':
      return {
        title: '服务暂不可用',
        detail: retry
          ? `稍后重试${suffix}`
          : `服务端声明不可自动重试（retryable=false）${suffix}；本页不伪造空页，请稍后再确认状态`,
        tone: 'stale',
        retriable: retry,
        action: retry ? 'retry' : 'none',
      };
    case 'network_error':
      return {
        title: '网络请求失败',
        detail: result.message || (retry ? '检查 API 基地址与开发代理后重试' : '检查 API 基地址与开发代理后再试'),
        tone: 'error',
        retriable: retry,
        action: retry ? 'retry' : 'none',
      };
    case 'invalid_response':
      // 与 isRetriable 闭集一致：重试同一次请求不会改变响应形状，不给「必然失败」的重试入口。
      return { title: '响应不符合契约', detail: result.message || '未渲染任何行（不猜测缺字段）', tone: 'error', retriable: false, action: 'none' };
    case 'invalid_request':
      return { title: '请求不合法', detail: result.message || '本地校验已拦下，未发出请求', tone: 'error', retriable: false, action: 'none' };
    default:
      return { title: '请求失败', detail: result.message || '未知错误', tone: 'error', retriable: false, action: 'none' };
  }
}

/**
 * 未登录表单上的登录失败提示（PR #439 监工 [P2]）。
 *
 * 登录失败时 `signedIn` 仍是 false，页面停在**未登录表单**里 —— 那是用户此刻唯一能看到的
 * 界面，所以失败结果必须渲染在表单内。文案是**白名单**：只按 `kind` 取固定中文，
 * ⛔ 绝不透传异常 `message` 或服务端 `error.code`（后端细节，且可能夹带内部信息）。
 */
export function describeSignInFailure(failure) {
  if (!failure || failure.ok !== false) return null;
  switch (failure.kind) {
    case 'signin_rejected':
      return {
        title: '登录未通过',
        detail: '服务端拒绝了这次登录（登录名或密码不正确，或该账号没有后台权限）。口令没有保留，修正后可直接再次提交。',
      };
    case 'signin_throttled':
      return {
        title: '登录尝试过于频繁',
        detail: '服务端要求稍后再试；本页不会缓存你的口令。稍等片刻后可直接再次提交。',
      };
    case 'signin_unavailable':
      return {
        title: '登录请求未完成',
        detail: '没有取得可用的登录结果（网络中断或后台服务暂不可用）。检查网络与 API 基地址后可直接再次提交。',
      };
    case 'signin_session_unreadable':
      return {
        title: '登录已提交，但读不到会话详情',
        detail: '服务端已接受这次登录，但随后的会话查询没有返回可用会话，因此本页仍按未登录处理（不伪造登录态）。请重新输入口令后再提交。',
      };
    default:
      return {
        title: '登录未成功',
        detail: '本页仍按未登录处理（不伪造登录态）。检查登录名与口令后可直接再次提交。',
      };
  }
}

/**
 * 把 `signInAdmin()` 抛出的错误归到未登录表单的安全状态。
 *
 * 依据只有 `src/auth/session.ts` 的既定文案 `后台登录失败：<契约错误码|HTTP 状态>`；
 * 不带该前缀的错误（网络中断、被更新的登录请求取代）一律按「请求未完成」呈现。
 * 返回的 failure **不携带**原始 message，避免后端细节进入页面状态被渲染或记录。
 */
export function signInFailureOf(error) {
  const message = error instanceof Error ? error.message : '';
  const match = /^后台登录失败：(.*)$/.exec(message);
  if (match === null) return { ok: false, kind: 'signin_unavailable', status: null, retriable: true };
  const code = match[1].trim();
  const httpStatus = /^HTTP (\d{3})$/.exec(code);
  const status = httpStatus === null ? null : Number(httpStatus[1]);
  if (status === 429 || code === 'RATE_LIMITED') {
    return { ok: false, kind: 'signin_throttled', status: status ?? 429, retriable: true };
  }
  if (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    code === 'SESSION_REQUIRED' ||
    code === 'SCOPE_DENIED' ||
    code === 'ACCOUNT_INACTIVE' ||
    code === 'INVALID_REQUEST'
  ) {
    return { ok: false, kind: 'signin_rejected', status, retriable: false };
  }
  return { ok: false, kind: 'signin_unavailable', status, retriable: true };
}

/** 页面状态初值（登出态；`phase` 取值 signed_out／loading／ready／error）。 */
export function initialJobsState() {
  return {
    signedIn: false,
    hasReadScope: true,
    hasCancelScope: true,
    phase: 'signed_out',
    jobs: [],
    nextCursor: null,
    pages: 0,
    failure: null,
    reason: '',
    selectedId: null,
    cancelingId: null,
    write: null,
    writeStatus: 'idle',
    writeFailure: null,
    receipt: null,
  };
}

/** 会话 scope 列表 → 本页两个开关（未提供 scope 时不预判为「没有」，以服务端返回为准）。 */
function scopeFlags(scopes, scopesProvided) {
  if (scopesProvided !== true || !Array.isArray(scopes)) return { hasReadScope: true, hasCancelScope: true };
  return { hasReadScope: scopes.includes(JOBS_READ_SCOPE), hasCancelScope: scopes.includes(JOBS_CANCEL_SCOPE) };
}

/** 按 id 去重合并续页（保留先到顺序）；返回 {jobs, added}。 */
function mergeJobs(existing, incoming) {
  const seen = new Set(existing.map((job) => job.id));
  const jobs = existing.slice();
  const added = [];
  for (const job of incoming) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    jobs.push(job);
    added.push(job);
  }
  return { jobs, added };
}

/**
 * 状态机：读面（LOAD_*）＋写面（WRITE_*）。**不改**已加载的其他行，
 * `WRITE_OK` 只把服务端回的那一行按 id 替换（局部刷新，不做整表重载）。
 */
export function reduceJobs(state, action) {
  switch (action?.type) {
    case 'SESSION_MISSING':
      return { ...initialJobsState() };
    case 'SIGN_IN_START':
      return { ...state, failure: null, phase: 'signed_out' };
    case 'SIGN_IN_FAILED':
      return { ...state, signedIn: false, phase: 'signed_out', failure: action.failure ?? null };
    case 'SIGNED_IN':
      return {
        ...initialJobsState(),
        signedIn: true,
        ...scopeFlags(action.scopes, action.scopesProvided),
        phase: 'loading',
      };
    case 'SIGN_OUT':
      return { ...initialJobsState() };
    case 'LOAD_START': {
      const reset = action.reset === true;
      return {
        ...state,
        phase: 'loading',
        cancelingId: null,
        failure: reset ? null : state.failure,
        jobs: reset ? [] : state.jobs,
        nextCursor: reset ? null : state.nextCursor,
        pages: reset ? 0 : state.pages,
        selectedId: reset ? null : state.selectedId,
      };
    }
    case 'LOAD_OK': {
      const { jobs, added } = mergeJobs(state.jobs, action.jobs ?? []);
      return {
        ...state,
        phase: 'ready',
        jobs,
        nextCursor: action.nextCursor ?? null,
        pages: state.pages + 1,
        failure: null,
        selectedId:
          state.selectedId !== null && jobs.some((job) => job.id === state.selectedId) ? state.selectedId : null,
        lastAdded: added.length,
      };
    }
    case 'LOAD_FAIL':
      return { ...state, phase: 'error', failure: action.failure ?? null };
    case 'SET_REASON':
      return { ...state, reason: typeof action.value === 'string' ? action.value : '' };
    case 'SELECT':
      return { ...state, selectedId: state.selectedId === action.id ? null : action.id };
    case 'CLOSE_DETAIL':
      return { ...state, selectedId: null };
    case 'WRITE_START':
      return {
        ...state,
        writeStatus: 'writing',
        cancelingId: action.id ?? null,
        write: {
          id: action.id ?? null,
          revision: action.revision ?? null,
          reason: action.reason ?? '',
          idempotencyKey: action.idempotencyKey ?? null,
        },
        writeFailure: null,
        receipt: null,
      };
    case 'WRITE_OK': {
      const job = action.job;
      const jobs = state.jobs.map((row) => (job && row.id === job.id ? job : row));
      return {
        ...state,
        jobs,
        writeStatus: 'saved',
        cancelingId: null,
        write: null,
        writeFailure: null,
        receipt: action.receipt ?? null,
      };
    }
    case 'WRITE_FAIL':
      return { ...state, writeStatus: 'failed', cancelingId: null, writeFailure: action.failure ?? null };
    case 'WRITE_CLEAR':
      return { ...state, writeStatus: 'idle', writeFailure: null, write: null, receipt: null };
    default:
      return state;
  }
}

/** 读面状态 → 文案（`tone` 对齐 `.status.ready/.stale/.empty/.error` 既有 class）。 */
export function describeJobs(state) {
  if (state.signedIn !== true) {
    return { title: '未登录', detail: '登录后可读取作业列表（scope jobs:read）', tone: 'empty', canRetry: false, action: 'sign_in' };
  }
  if (state.phase === 'loading') {
    return { title: '正在读取作业…', detail: 'GET /admin/jobs（游标分页）', tone: 'ready', canRetry: false, action: 'none' };
  }
  if (state.phase === 'error') {
    const described = describeFailure(state.failure);
    // errorCode 只透传服务端信封里的值，供「缺 scope」这类提示点名具体错误码，不做任何推断。
    const errorCode = state.failure?.code ?? '';
    if (described === null) {
      return { title: '读取失败', detail: '未取得服务端响应', tone: 'error', canRetry: true, action: 'reload', errorCode };
    }
    return {
      title: described.title,
      detail: described.detail,
      tone: described.tone,
      canRetry: described.retriable === true,
      action: described.action,
      errorCode,
    };
  }
  const notes = [];
  if (state.hasReadScope === false) notes.push('当前会话 scope 里没有 jobs:read（请求大概率 403）');
  if (state.hasCancelScope === false) notes.push('当前会话没有 jobs:cancel，取消按钮已禁用');
  if (state.phase === 'ready' && state.jobs.length === 0) {
    return {
      title: '暂无作业',
      detail: ['服务端返回空列表（items=[] 且 next_cursor=null）是正常空态，不是错误', ...notes].join('；'),
      tone: 'empty',
      canRetry: true,
      action: 'reload',
    };
  }
  const tail = state.nextCursor === null ? '已到末页' : '还有下一页（按 cursor 续读）';
  return {
    title: `已加载 ${state.jobs.length} 个作业`,
    detail: [tail, ...notes].join('；'),
    tone: 'ready',
    canRetry: true,
    action: 'reload',
  };
}

/** 行视图：只做展示映射（时间字段原样透传，不重排、不本地化时区）。 */
export function jobRowViews(state) {
  return state.jobs.map((job) => {
    const terminal = isTerminalJobState(job.state);
    const cancelable = canCancelJob(job);
    return {
      id: job.id,
      shortId: job.id.slice(0, 8),
      kind: job.kind,
      kindTitle: job.kind,
      state: job.state,
      tone: JOB_STATE_TONES[job.state] ?? 'off',
      stateTitle: JOB_STATE_NOTES[job.state] ?? '契约外状态（原样展示，不推断含义）',
      errorCode: typeof job.error_code === 'string' ? job.error_code : '—',
      createdAt: typeof job.created_at === 'string' ? job.created_at : '—',
      deadlineAt: typeof job.deadline_at === 'string' ? job.deadline_at : '—',
      revisionLabel: String(job.revision),
      etag: etagForRevision(job.revision),
      targetRef: `${job.target_ref.type}:${job.target_ref.id}`,
      terminal,
      cancelable,
      cancelBlockedReason: terminal
        ? `已是终态 ${job.state}（契约终态不含 completed）`
        : cancelable
          ? ''
          : 'state 不在 queued／running，或 id／revision 不合法',
      writing: state.writeStatus === 'writing' && state.cancelingId === job.id,
      selected: state.selectedId === job.id,
    };
  });
}

/**
 * 选中行的详情（`missing` 显式列出**契约读面没有**的字段，页面不猜、不补造）。
 * 纯展示映射，不做二次请求。
 */
export function jobDetailOf(state) {
  const job = state.jobs.find((row) => row.id === state.selectedId);
  if (job === undefined) return null;
  return {
    title: `${job.kind} · ${job.state}`,
    fields: [
      { label: 'id', value: job.id },
      { label: 'kind', value: job.kind },
      { label: 'state', value: `${job.state}（${JOB_STATE_NOTES[job.state] ?? '契约外状态'}）` },
      { label: 'target_ref', value: `${job.target_ref.type}:${job.target_ref.id}` },
      { label: 'revision', value: String(job.revision) },
      { label: 'If-Match', value: etagForRevision(job.revision) ?? '—' },
      { label: 'created_at', value: job.created_at },
      { label: 'deadline_at', value: job.deadline_at },
      { label: 'error_code', value: job.error_code === null ? '（无错误码）' : job.error_code },
      { label: 'result', value: job.result === null ? '（后台视图恒为 null）' : '（非 null，契约外，不展示）' },
    ],
    missing: ['发起人／操作者', '进度百分比', '重试次数', '取消人与取消时间'],
    note:
      '契约 AdminJob 只有 id／revision／kind／target_ref／state／deadline_at／created_at／error_code／result 九个字段' +
      '（additionalProperties: false），后台读面不提供上面列出的字段，本页不猜。',
  };
}

/** 读面是否还有下一页。 */
export function canLoadMoreJobs(state) {
  return state.phase === 'ready' && typeof state.nextCursor === 'string' && state.nextCursor.length > 0;
}

/** 当前状态能否发取消（会话有 scope、理由合法、没有在飞的写）。 */
export function canCancelNow(state) {
  if (state.signedIn !== true) return false;
  if (state.hasCancelScope === false) return false;
  if (state.writeStatus === 'writing') return false;
  return reasonProblem(state.reason) === null;
}
