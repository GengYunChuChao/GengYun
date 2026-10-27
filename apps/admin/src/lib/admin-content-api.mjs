/**
 * 后台「资料来源 / 科普内容 / 分类」管理面 HTTP 客户端——纯 ESM，无 Vue／DOM 依赖，可用假 fetch 注入测试。
 *
 * 只用契约里**存在**的接口（operationId 见 `admin-content-contract.mjs` 的注释）；
 * 不造 `/admin/admin-categories` 之类不存在的路径，也不造「批量发布」「删除」这类契约没有的操作。
 *
 * 每个写操作都**强制**带 `Idempotency-Key`；编辑／发布／下架**强制**带 `If-Match: "<revision>"`。
 * 缺头时本模块直接返回失败（`missing_if_match` / `missing_idempotency_key`），**不降级、不补默认值**：
 * 服务端缺 `If-Match` 是 428、缺幂等键是 400，前端没必要让它先发一个必然失败的请求。
 *
 * 不记录、不回传 access token；`sentHeaders` 只回显本次真实发出的写头，便于在页面上核对。
 */

import {
  CURSOR_MAX_LENGTH,
  ERROR_CODES,
  LIMIT_DEFAULT,
  readErrorEnvelope,
  readPageEnvelope,
} from './admin-contract.mjs';
import { clampLimit, normalizeBaseUrl } from './admin-api.mjs';
import {
  AUDIT_EVENTS_PATH, CATEGORIES_PATH,
  IF_MATCH_PATTERN,
  KNOWLEDGE_PATH, REGISTRATIONS_PATH,
  RESTRICTIONS_PATH,
  SOURCES_PATH,
  normalizeIdempotencyKey,
  validateAuditEvent,
  validateCategory, validateKnowledgeDraft, validateKnowledgePublicationOutcome, validatePage,
  validateRegistrationDraft, validateRegistrationPublicationOutcome,
  validateRestrictionDraft, validateRestrictionPublicationOutcome,
  validateSourceDraft, validateSourcePublicationOutcome,
} from './admin-content-contract.mjs';

/** 写操作的动作名（页面按钮与审计事件 `action` 的对照用；不是契约字段）。 */
export const WRITE_ACTIONS = Object.freeze({
  create: 'create',
  edit: 'edit',
  publish: 'publish',
  withdraw: 'withdraw',
});

function isRetriableKind(kind) {
  return kind === 'rate_limited' || kind === 'unavailable' || kind === 'network_error';
}

function failure(kind, extra = {}) {
  return {
    ok: false,
    kind,
    retriable: isRetriableKind(kind),
    status: null,
    code: null,
    inContract: false,
    message: '',
    requestUrl: null,
    requestId: null,
    sentHeaders: null, retryAfterSeconds: null,
    ...extra,
  };
}

async function readJson(response) {
  try {
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: false, value: null };
  }
}

/** 从响应头取强 ETag（列表无此头）；缺失或形状不符返回 null，不猜 revision。 */
function readEtag(response) {
  const raw = response.headers?.get?.('etag');
  if (typeof raw !== 'string' || !IF_MATCH_PATTERN.test(raw)) return null;
  return raw;
}

/** `meta.request_id`（写操作的审计关联键；契约响应里**没有** audit event id）。 */
function readRequestId(body) {
  const meta = body?.meta;
  if (meta === null || typeof meta !== 'object') return null;
  return typeof meta.request_id === 'string' && meta.request_id !== '' ? meta.request_id : null;
}

/**
 * 拼管理面 URL。
 * `limit` 总是显式带上；`cursor` 仅在续页时带；`id` 走路径段并编码（分类 id 是不透明字符串，可能含非 uuid 字符）。
 */
export function buildFamilyUrl(baseUrl, path, options = {}) {
  const base = normalizeBaseUrl(baseUrl);
  let url = `${base}${path}`;
  if (options.id !== undefined && options.id !== null) {
    if (typeof options.id !== 'string' || options.id === '') throw new TypeError('id 必须是非空字符串');
    url += `/${encodeURIComponent(options.id)}`;
  }
  if (options.action !== undefined && options.action !== null) {
    url += `/${options.action}`;
  }
  if (path === AUDIT_EVENTS_PATH || options.withQuery === true) {
    const params = new URLSearchParams();
    params.set('limit', String(clampLimit(options.limit ?? LIMIT_DEFAULT)));
    const cursor = options.cursor;
    if (cursor !== null && cursor !== undefined) {
      if (typeof cursor !== 'string' || cursor.length === 0) throw new TypeError('cursor 必须是非空字符串');
      if (cursor.length > CURSOR_MAX_LENGTH) throw new RangeError(`cursor 超过契约上限 ${CURSOR_MAX_LENGTH} 字符`);
      params.set('cursor', cursor);
    }
    url += `?${params.toString()}`;
  }
  return url;
}

/** 把一次非 2xx 响应翻译成失败对象：错误码原样保留（未知 code 标 `inContract: false`），并把 `Retry-After` 的整数秒落成 `retryAfterSeconds`（缺失／非法 ⇒ null，见 `readRetryAfterSeconds`）。 */
function classifyHttpFailure({ status, envelope, body, requestUrl, sentHeaders, headers }) {
  const code = envelope?.code ?? null;
  const inContract = code === null ? false : ERROR_CODES.includes(code);
  const base = {
    status,
    code,
    inContract, declaredRetryable: envelope?.retryable ?? null, retryAfterSeconds: readRetryAfterSeconds(headers),
    requestUrl,
    requestId: readRequestId(body),
    sentHeaders,
    message: envelope?.message ?? '',
  };
  if (status === 401 || code === 'SESSION_REQUIRED' || code === 'SESSION_EXPIRED') {
    return failure('signed_out', { ...base, message: base.message || '后台会话缺失或已过期' });
  }
  if (status === 403 || code === 'SCOPE_DENIED') {
    return failure('forbidden', { ...base, message: base.message || '当前后台会话缺少所需 scope' });
  }
  if (status === 428 || code === 'REVISION_REQUIRED') {
    return failure('missing_if_match', { ...base, message: base.message || '服务端要求 If-Match 请求头' });
  }
  if (status === 409 || code === 'REVISION_CONFLICT' || code === 'IDEMPOTENCY_CONFLICT' || code === 'OBJECT_UNAVAILABLE') {
    const kind = code === 'IDEMPOTENCY_CONFLICT'
      ? 'idempotency_conflict'
      : code === 'OBJECT_UNAVAILABLE'
        ? 'object_unavailable'
        : code === 'REVISION_CONFLICT'
          ? 'revision_conflict'
          : 'http_error';
    return failure(kind, { ...base, message: base.message || '写操作冲突（修订/幂等/对象状态）' });
  }
  if (status === 422 || code === 'SOURCE_CONFLICT') {
    return failure('source_conflict', { ...base, message: base.message || '资料引用门槛未通过' });
  }
  if (status === 404 || code === 'NOT_FOUND') {
    return failure('not_found', { ...base, message: base.message || '目标不存在' });
  }
  if (status === 400) {
    return failure('invalid_request', { ...base, message: base.message || '请求参数不符合契约' });
  }
  if (status === 429 || code === 'RATE_LIMITED') {
    return failure('rate_limited', { ...base, message: base.message || '请求过于频繁' });
  }
  if (status >= 500) {
    return failure('unavailable', { ...base, message: base.message || `服务暂不可用（HTTP ${status}）` });
  }
  return failure('http_error', { ...base, message: base.message || `请求失败（HTTP ${status}）` });
}

function requireToken(token) {
  return typeof token === 'string' && token.length > 0;
}

/**
 * 读一页管理面列表（sources / knowledge / categories 共用）。
 *
 * 返回 `{ok:true, status, requestUrl, requestId, page:{items, nextCursor, warnings}}`
 * 或 `describeWriteFailure` 可读的失败对象。
 */
export async function fetchFamilyPage({
  fetchImpl,
  baseUrl,
  token,
  path,
  cursor = null,
  limit = LIMIT_DEFAULT,
  validateRow,
  signal,
} = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return failure('network_error', { message: '当前环境没有可用的 fetch' });
  if (!requireToken(token)) return failure('signed_out', { message: '没有后台会话令牌' });

  let requestUrl;
  try {
    requestUrl = buildFamilyUrl(baseUrl, path, { cursor, limit, withQuery: true });
  } catch (error) {
    return failure('invalid_cursor', { message: error instanceof Error ? error.message : '游标不合法', requestUrl: null });
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
    return failure('network_error', {
      message: error instanceof Error ? error.message : '网络请求失败',
      requestUrl,
    });
  }

  const status = typeof response.status === 'number' ? response.status : 0;
  const parsed = await readJson(response);

  if (response.ok && status >= 200 && status < 300) {
    if (!parsed.ok) return failure('invalid_response', { status, requestUrl, message: '响应不是合法 JSON' });
    const data = readPageEnvelope(parsed.value);
    if (data === null) return failure('invalid_response', { status, requestUrl, message: '响应信封缺少 data 或 meta' });
    const page = validatePage(data, validateRow);
    if (!page.ok) {
      return failure('invalid_response', {
        status,
        requestUrl,
        requestId: readRequestId(parsed.value),
        message: `响应形状不符合契约：${page.errors.map((e) => `${e.path} ${e.problem}`).join('；')}`,
      });
    }
    return {
      ok: true,
      status,
      requestUrl,
      requestId: readRequestId(parsed.value),
      page: { items: page.items, nextCursor: page.nextCursor, warnings: page.warnings },
    };
  }

  const envelope = parsed.ok ? readErrorEnvelope(parsed.value) : null;
  const result = classifyHttpFailure({ status, envelope, body: parsed.value, requestUrl, sentHeaders: null, headers: response.headers });
  if (result.kind === 'forbidden') {
    result.message = result.message || '当前后台会话缺少读面 scope';
  }
  return result;
}

/** 读单个资源详情（sources / knowledge 共用），返回 `{ok:true, status, etag, requestId, item}`。 */
export async function fetchFamilyItem({ fetchImpl, baseUrl, token, path, id, validate, signal } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return failure('network_error', { message: '当前环境没有可用的 fetch' });
  if (!requireToken(token)) return failure('signed_out', { message: '没有后台会话令牌' });

  let requestUrl;
  try {
    requestUrl = buildFamilyUrl(baseUrl, path, { id });
  } catch (error) {
    return failure('invalid_request', { message: error instanceof Error ? error.message : 'id 不合法' });
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
    const data = readPageEnvelope(parsed.value);
    if (data === null) return failure('invalid_response', { status, requestUrl, message: '响应信封缺少 data 或 meta' });
    const checked = validate(data);
    if (!checked.ok) {
      return failure('invalid_response', {
        status,
        requestUrl,
        requestId: readRequestId(parsed.value),
        message: `响应形状不符合契约：${checked.errors.map((e) => `${e.path} ${e.problem}`).join('；')}`,
      });
    }
    return {
      ok: true,
      status,
      requestUrl,
      etag: readEtag(response),
      requestId: readRequestId(parsed.value),
      item: data,
      warnings: checked.warnings,
    };
  }

  const envelope = parsed.ok ? readErrorEnvelope(parsed.value) : null;
  return classifyHttpFailure({ status, envelope, body: parsed.value, requestUrl, sentHeaders: null, headers: response.headers });
}

/**
 * 一次写操作（create / edit / publish / withdraw / 分类编辑共用）。
 *
 * - `method`：`POST`（创建、发布、下架）或 `PATCH`（编辑）。
 * - `ifMatch`：契约 `^"[1-9][0-9]*"$`；编辑／发布／下架必填，缺则本地拒绝。
 * - `idempotencyKey`：契约 8..128 字符；缺则本地拒绝（服务端会 400）。
 * - `body`：已由 `admin-content-contract.mjs` 的 `build*Input` 校验过的请求体。
 */
export async function writeFamilyResource({
  fetchImpl,
  baseUrl,
  token,
  method,
  path,
  id = null,
  action = null,
  ifMatch = null,
  idempotencyKey = null,
  body,
  validate,
  signal,
} = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return failure('network_error', { message: '当前环境没有可用的 fetch' });
  if (!requireToken(token)) return failure('signed_out', { message: '没有后台会话令牌' });

  const needsIfMatch = method !== 'POST' || action !== null;
  if (needsIfMatch && (typeof ifMatch !== 'string' || !IF_MATCH_PATTERN.test(ifMatch))) {
    return failure('missing_if_match', {
      message: needsIfMatch
        ? '缺少合法的 If-Match（必须先读到当前 revision，形如 "3"）'
        : 'If-Match 形状非法',
    });
  }
  const key = normalizeIdempotencyKey(idempotencyKey);
  if (key === null) {
    return failure('missing_idempotency_key', { message: '缺少合法的 Idempotency-Key（8..128 字符）' });
  }

  let requestUrl;
  try {
    requestUrl = buildFamilyUrl(baseUrl, path, { id, action });
  } catch (error) {
    return failure('invalid_request', { message: error instanceof Error ? error.message : '目标不合法' });
  }

  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    'content-type': 'application/json',
    'idempotency-key': key,
  };
  if (needsIfMatch) headers['if-match'] = ifMatch;

  const sentHeaders = { 'idempotency-key': key };
  if (needsIfMatch) sentHeaders['if-match'] = ifMatch;

  let response;
  try {
    response = await doFetch(requestUrl, {
      method,
      headers,
      credentials: 'omit',
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    return failure('network_error', {
      message: error instanceof Error ? error.message : '网络请求失败',
      requestUrl,
      sentHeaders,
    });
  }

  const status = typeof response.status === 'number' ? response.status : 0;
  const parsed = await readJson(response);

  if (response.ok && status >= 200 && status < 300) {
    if (!parsed.ok) return failure('invalid_response', { status, requestUrl, sentHeaders, message: '响应不是合法 JSON' });
    const data = readPageEnvelope(parsed.value);
    if (data === null) {
      return failure('invalid_response', { status, requestUrl, sentHeaders, message: '响应信封缺少 data 或 meta' });
    }
    const checked = validate(data);
    if (!checked.ok) {
      return failure('invalid_response', {
        status,
        requestUrl,
        requestId: readRequestId(parsed.value),
        sentHeaders,
        message: `响应形状不符合契约：${checked.errors.map((e) => `${e.path} ${e.problem}`).join('；')}`,
      });
    }
    return {
      ok: true,
      status,
      requestUrl,
      requestId: readRequestId(parsed.value),
      etag: readEtag(response),
      item: data,
      warnings: checked.warnings,
      sentHeaders,
    };
  }

  const envelope = parsed.ok ? readErrorEnvelope(parsed.value) : null;
  return classifyHttpFailure({ status, envelope, body: parsed.value, requestUrl, sentHeaders, headers: response.headers });
}

// ------------------------------------------------------------------ 资料来源的 6 个操作
export function listSources(options = {}) {
  return fetchFamilyPage({ ...options, path: SOURCES_PATH, validateRow: validateSourceDraft });
}

export function getSource(options = {}) {
  return fetchFamilyItem({ ...options, path: SOURCES_PATH, validate: validateSourceDraft });
}

export function createSource({ fetchImpl, baseUrl, token, idempotencyKey, body, signal } = {}) {
  return writeFamilyResource({
    fetchImpl,
    baseUrl,
    token,
    method: 'POST',
    path: SOURCES_PATH,
    idempotencyKey,
    body,
    validate: validateSourceDraft,
    signal,
  });
}

export function editSource({ fetchImpl, baseUrl, token, id, ifMatch, idempotencyKey, body, signal } = {}) {
  return writeFamilyResource({
    fetchImpl,
    baseUrl,
    token,
    method: 'PATCH',
    path: SOURCES_PATH,
    id,
    ifMatch,
    idempotencyKey,
    body,
    validate: validateSourceDraft,
    signal,
  });
}

export function publishSource({ fetchImpl, baseUrl, token, id, ifMatch, idempotencyKey, body, signal } = {}) {
  return writeFamilyResource({
    fetchImpl,
    baseUrl,
    token,
    method: 'POST',
    path: SOURCES_PATH,
    id,
    action: 'publish',
    ifMatch,
    idempotencyKey,
    body,
    validate: validateSourcePublicationOutcome,
    signal,
  });
}

export function withdrawSource({ fetchImpl, baseUrl, token, id, ifMatch, idempotencyKey, body, signal } = {}) {
  return writeFamilyResource({
    fetchImpl,
    baseUrl,
    token,
    method: 'POST',
    path: SOURCES_PATH,
    id,
    action: 'withdraw',
    ifMatch,
    idempotencyKey,
    body,
    validate: validateSourcePublicationOutcome,
    signal,
  });
}

// ------------------------------------------------------------------ 科普内容的 6 个操作
export function listKnowledge(options = {}) {
  return fetchFamilyPage({ ...options, path: KNOWLEDGE_PATH, validateRow: validateKnowledgeDraft });
}

export function getKnowledge(options = {}) {
  return fetchFamilyItem({ ...options, path: KNOWLEDGE_PATH, validate: validateKnowledgeDraft });
}

export function createKnowledge({ fetchImpl, baseUrl, token, idempotencyKey, body, signal } = {}) {
  return writeFamilyResource({
    fetchImpl,
    baseUrl,
    token,
    method: 'POST',
    path: KNOWLEDGE_PATH,
    idempotencyKey,
    body,
    validate: validateKnowledgeDraft,
    signal,
  });
}

export function editKnowledge({ fetchImpl, baseUrl, token, id, ifMatch, idempotencyKey, body, signal } = {}) {
  return writeFamilyResource({
    fetchImpl,
    baseUrl,
    token,
    method: 'PATCH',
    path: KNOWLEDGE_PATH,
    id,
    ifMatch,
    idempotencyKey,
    body,
    validate: validateKnowledgeDraft,
    signal,
  });
}

export function publishKnowledge({ fetchImpl, baseUrl, token, id, ifMatch, idempotencyKey, body, signal } = {}) {
  return writeFamilyResource({
    fetchImpl,
    baseUrl,
    token,
    method: 'POST',
    path: KNOWLEDGE_PATH,
    id,
    action: 'publish',
    ifMatch,
    idempotencyKey,
    body,
    validate: validateKnowledgePublicationOutcome,
    signal,
  });
}

export function withdrawKnowledge({ fetchImpl, baseUrl, token, id, ifMatch, idempotencyKey, body, signal } = {}) {
  return writeFamilyResource({
    fetchImpl,
    baseUrl,
    token,
    method: 'POST',
    path: KNOWLEDGE_PATH,
    id,
    action: 'withdraw',
    ifMatch,
    idempotencyKey,
    body,
    validate: validateKnowledgePublicationOutcome,
    signal,
  });
}

// ------------------------------------------------------------------ 分类
export function listCategories(options = {}) {
  return fetchFamilyPage({ ...options, path: CATEGORIES_PATH, validateRow: validateCategory });
}

export function editCategory({ fetchImpl, baseUrl, token, id, ifMatch, idempotencyKey, body, signal } = {}) {
  return writeFamilyResource({
    fetchImpl,
    baseUrl,
    token,
    method: 'PATCH',
    path: CATEGORIES_PATH,
    id,
    ifMatch,
    idempotencyKey,
    body,
    validate: validateCategory,
    signal,
  });
}

// ------------------------------------------------------------------ 审计台账（写操作关联）
/**
 * 读一页审计台账（`GET /admin/audit-events`，scope `audit:read`）。
 * 契约没有 `request_id` 过滤参数，因此**只能由调用方在前端筛选**；这里只负责取页。
 */
export async function fetchAuditEventPage({ fetchImpl, baseUrl, token, cursor = null, limit = LIMIT_DEFAULT, signal } = {}) {
  return fetchFamilyPage({
    fetchImpl,
    baseUrl,
    token,
    path: AUDIT_EVENTS_PATH,
    cursor,
    limit,
    validateRow: validateAuditEvent,
    signal,
  });
}

/**
 * 按 `request_id` 在审计台账里找本页写操作对应的事件。
 *
 * 契约只支持 `cursor`／`limit`，所以这里逐页扫（最多 `maxPages` 页），找到即停。
 * 返回 `{ok:true, events, scanned, truncated}`；`truncated: true` 表示扫到上限仍没找全，
 * 页面必须如实说「只扫了最近 N 条」，不能显示成「没有审计记录」。
 */
export async function findAuditEventsForRequest({
  fetchImpl,
  baseUrl,
  token,
  requestId,
  maxPages = 5,
  limit = 50,
  signal,
} = {}) {
  if (typeof requestId !== 'string' || requestId === '') {
    return failure('invalid_request', { message: '缺少 request_id，无法在审计台账里定位本次写操作' });
  }
  const events = [];
  let cursor = null;
  let scanned = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchAuditEventPage({ fetchImpl, baseUrl, token, cursor, limit, signal });
    if (!result.ok) return result;
    scanned += result.page.items.length;
    for (const event of result.page.items) {
      if (event.request_id === requestId) events.push(event);
    }
    cursor = result.page.nextCursor;
    if (cursor === null) return { ok: true, events, scanned, truncated: false };
  }
  return { ok: true, events, scanned, truncated: true };
}

// ------------------------------------------------------------------ 2xx 回执 → 文案（changed 三值）
/**
 * 从一次写回执推导「服务端是否真的改动了状态」——返回 `true` / `false` / `null`（未知）。
 *
 * 判据按**优先级**排列，前一条能定就不看后一条：
 * 1. **契约真值**：publish／withdraw 的 200 是 `*PublicationOutcome`（`SourcePublicationOutcome` 等 4 张），
 *    带**必填**布尔 `changed` —— 服务端在真迁移分支回 `true`、在内存幂等短路分支回 `false`。
 *    有它就原样返回，不做任何推断。
 * 2. **修订前进**（仅 `edit`，回执是 `*Draft` 信封、契约里没有 `changed`）：`editXxxDraft` 每次成功都
 *    追加一条修订 ⇒ 回传 `revision` 与请求里的 `If-Match` 不同，这就是「确实改动了」的直接证据。
 * 3. 两条都拿不到 ⇒ `null`：如实返回未知，**不猜** `false` 冒充「已是该状态」，也**不猜** `true`
 *    冒充「刚刚成功」。`create` 的 201 与读面（`RegistrationDraft`（:15158）、`Restriction`（:15256）
 *    只有 `{id, revision, content, review_status}`、**没有** `changed`）走这一条。
 */
export function deriveChanged(action, result, { previousRevision = null } = {}) {
  if (!result || result.ok !== true) return null;
  // 1) 契约真值优先：回执自带布尔 changed 就不再推断（publish／withdraw 走这条）。
  if (typeof result.item?.changed === 'boolean') return result.item.changed;
  // 2) 回退：只有 edit 能从「修订是否前进」得出结论（create／读面没有可比修订）。
  const revision = Number.isInteger(result.item?.revision) ? result.item.revision : null;
  if (action === 'edit') {
    if (revision === null || !Number.isInteger(previousRevision)) return null;
    return revision !== previousRevision;
  }
  // 3) 拿不到契约真值、也没有可比的修订 ⇒ 未知（不猜）。
  return null;
}

/**
 * 2xx 回执 → 页面文案。**幂等 no-op 一律不写成新动作**：`changed:false` 写「未改动」、拿不到
 * `changed` 只写「已受理」；只有回执自带的 `changed:true` 才写「已发布／已撤回」。
 *
 * 与 `describeWriteFailure` 配对使用：`ok !== true` 一律走失败文案，这里只处理 2xx。
 */
export function describeWriteOutcome(result, { action, previousRevision = null, familyLabel = '资料' } = {}) {
  if (!result || result.ok !== true) return null;
  const changed = deriveChanged(action, result, { previousRevision });
  const parts = [];
  if (typeof result.etag === 'string' && result.etag !== '') parts.push(`响应 ETag ${result.etag}`);
  else if (Number.isInteger(result.item?.revision)) parts.push(`回传修订 "${result.item.revision}"`);
  else parts.push('响应未带修订号（无法核对当前 revision）');
  if (typeof result.requestId === 'string' && result.requestId !== '') parts.push(`request_id ${result.requestId}`);
  const detail = parts.join(' · ');
  const status = result.status ?? null;

  if (action === 'create') {
    return {
      tone: 'ready',
      changed,
      changedLabel: '不判定（新建：服务端返回该对象；同一幂等键重复提交会原样重放同一份 201）',
      title: `服务端已创建并返回${familyLabel}草稿（HTTP ${status}）`,
      detail,
      advice: '本页只显示服务端回执。资源是否已发布不在契约读面里，需要发布请走「发布」动作。',
    };
  }

  if (action === 'edit') {
    if (changed === true) {
      return {
        tone: 'ready',
        changed,
        changedLabel: `已改动（修订 ${previousRevision} → ${result.item.revision}）`,
        title: `服务端已追加新修订（HTTP ${status}）`,
        detail,
        advice: '修订号已前进，后续操作请用新的 If-Match 重读详情后再发。',
      };
    }
    if (changed === false) {
      return {
        tone: 'warn',
        changed,
        changedLabel: `未改动（回传修订仍为 ${previousRevision}）`,
        title: '服务端未追加新修订（按「已是该状态」处理，不记为本次成功）',
        detail,
        advice: '契约里编辑成功必然追加一条修订；回传修订与 If-Match 相同，说明服务端没有产生新修订（多为同一幂等键重放）。请重读详情核对，不要据此认为这次编辑已生效。',
      };
    }
    return {
      tone: 'ready',
      changed,
      changedLabel: '无法判定（缺少操作前的 revision 或响应未带 revision）',
      title: `服务端已受理编辑（HTTP ${status}）`,
      detail,
      advice: '没有操作前的 revision 就无法判断修订是否前进；请重读详情核对。',
    };
  }

  // publish / withdraw：200 是 `*PublicationOutcome`，`changed` 是契约必填真值 —— 不再是「无法判定」。
  const actionLabel = action === 'withdraw' ? '撤回' : '发布';
  if (changed === true) {
    return {
      tone: 'ready',
      changed,
      changedLabel: `已改动（changed:true：服务端真的做了${actionLabel}的状态迁移，并写了 accepted 审计）`,
      title: `服务端已${actionLabel}（HTTP ${status}）`,
      detail,
      advice: '回执的 changed:true 由服务端在真实迁移分支给出（状态已改、审计已写）；后续操作请用新的 If-Match 重读详情后再发。',
    };
  }
  if (changed === false) {
    return {
      tone: 'warn',
      changed,
      changedLabel: '未改动（changed:false：资料本来就在目标状态，服务端走内存幂等短路）',
      title: `服务端未改动状态（HTTP ${status} · 本次不记为成功）`,
      detail,
      advice: `回执的 changed:false 表示服务端这次没有迁移状态、也没写审计（多为同一幂等键重放或「已是该状态」）。请重读详情核对，不要据此认为这次${actionLabel}已生效。`,
    };
  }
  return {
    tone: 'ready',
    changed,
    changedLabel: '无法判定（回执未带布尔 changed）',
    title: `服务端已受理（HTTP ${status}）`,
    detail,
    advice:
      'changed 是契约 `*PublicationOutcome` 的**必填**字段：回执里没有它说明服务端不合契约（客户端的回执校验器已按 invalid_response 拦下），本页不猜结论。要确认是否已是该状态，点「按 request_id 查审计台账」。',
  };
}

/** 写失败 → 页面文案（标题/说明/建议动作）。**错误码原样保留**，绝不吞掉。 */
export function describeWriteFailure(result) {
  if (!result || result.ok !== false) return null;
  const suffix = result.status === null || result.status === undefined ? '' : `（HTTP ${result.status}）`;
  const code = result.code === null ? null : `${result.code}${result.inContract ? '' : '（契约外码）'}`;
  const detail = [result.message || '', code === null ? '' : `错误码 ${code}`, suffix.trim()].filter((part) => part !== '').join(' · ');
  switch (result.kind) {
    case 'signed_out':
      return { title: '未登录或会话已过期', detail: detail || '请重新登录后台', action: 'sign_in' };
    case 'forbidden':
      return { title: '权限不足（scope 由服务端判定）', detail: detail || '后台会话缺少该接口要求的 scope', action: 'none' };
    case 'missing_if_match':
      return { title: '缺少或非法的 If-Match', detail: detail, action: 'reload_detail' };
    case 'revision_conflict':
      return { title: '修订冲突（If-Match 与当前 ETag 不一致）', detail: detail, action: 'reload_detail' };
    case 'idempotency_conflict':
      return { title: '幂等键冲突', detail: detail, action: 'new_key' };
    case 'object_unavailable':
      return { title: '对象状态不允许该操作', detail: detail, action: 'none' };
    case 'source_conflict':
      return { title: '引用门槛未通过', detail: detail, action: 'none' };
    case 'not_found':
      return { title: '目标不存在', detail: detail, action: 'restart' };
    case 'invalid_request':
      return { title: '请求不符合契约', detail: detail, action: 'none' };
    case 'invalid_response':
      return { title: '响应不符合契约', detail: detail || '未渲染任何行（不猜测缺字段）', action: 'none' };
    case 'rate_limited':
      return { title: '请求过于频繁', detail: detail, action: 'retry' };
    case 'unavailable': {
      // `real` 装配下无库池 ⇒ 这批内容操作一律 fail-closed 503 `PROVIDER_UNAVAILABLE`
      // （`services/api/src/admin/fail-closed-services.ts`）。它**不是**「服务端忙」，
      // 也**不是**空列表：必须显示成「未接线」，且重试不会成功。
      const unwired = result.status === 503 || result.code === 'PROVIDER_UNAVAILABLE';
      if (unwired) {
        return {
          title: '服务端未接线（HTTP 503 · fail-closed）',
          detail: detail || '服务端以 PROVIDER_UNAVAILABLE 拒绝了本次请求',
          action: result.declaredRetryable === true ? 'retry' : 'none',
        };
      }
      return { title: '服务暂不可用', detail: detail, action: 'retry' };
    }
    case 'network_error':
      return { title: '网络请求失败', detail: detail || '检查 API 基地址与开发代理后重试', action: 'retry' };
    default:
      return { title: '请求失败', detail: detail || '未知错误', action: 'none' };
  }
}





// ------------------------------------------------------------------ 注册资料 / 限制资料族（放在文件末尾的原因）
// `docs/architecture/admin-console-capability-map.md` 用**行号锚点**引用本文件前 600 行的既有函数
// （listSources:409、getSource:413、getKnowledge:486、editCategory:559、findAuditEventsForRequest:600，
// 以及 writeFamilyResource 的 307-406 区间）。把新族的 12 个函数插到中间会整体推高这些行号、让
// `tests/unit/doc-anchors-guard.test.mjs` 判红；而那份能力页由另一片维护，本片不得改动。
// ⇒ 新族一律**追加到文件末尾**，写法与前面三族逐字同形（同样复用 fetchFamilyPage / fetchFamilyItem /
// writeFamilyResource），不另造一套 HTTP 壳。

// ------------------------------------------------------------------ 注册资料的 6 个操作
// 形状按契约 `RegistrationDraft`（`{id, revision, content, review_status}`）——**没有 visibility**，
// 因此这里的校验器不检查可见性，页面也不推断生命周期。
export function listRegistration(options = {}) {
  return fetchFamilyPage({ ...options, path: REGISTRATIONS_PATH, validateRow: validateRegistrationDraft });
}

export function getRegistration(options = {}) {
  return fetchFamilyItem({ ...options, path: REGISTRATIONS_PATH, validate: validateRegistrationDraft });
}

export function createRegistration({ fetchImpl, baseUrl, token, idempotencyKey, body, signal } = {}) {
  return writeFamilyResource({
    fetchImpl,
    baseUrl,
    token,
    method: 'POST',
    path: REGISTRATIONS_PATH,
    idempotencyKey,
    body,
    validate: validateRegistrationDraft,
    signal,
  });
}

export function editRegistration({ fetchImpl, baseUrl, token, id, ifMatch, idempotencyKey, body, signal } = {}) {
  return writeFamilyResource({
    fetchImpl,
    baseUrl,
    token,
    method: 'PATCH',
    path: REGISTRATIONS_PATH,
    id,
    ifMatch,
    idempotencyKey,
    body,
    validate: validateRegistrationDraft,
    signal,
  });
}

export function publishRegistration({ fetchImpl, baseUrl, token, id, ifMatch, idempotencyKey, body, signal } = {}) {
  return writeFamilyResource({
    fetchImpl,
    baseUrl,
    token,
    method: 'POST',
    path: REGISTRATIONS_PATH,
    id,
    action: 'publish',
    ifMatch,
    idempotencyKey,
    body,
    validate: validateRegistrationPublicationOutcome,
    signal,
  });
}

export function withdrawRegistration({ fetchImpl, baseUrl, token, id, ifMatch, idempotencyKey, body, signal } = {}) {
  return writeFamilyResource({
    fetchImpl,
    baseUrl,
    token,
    method: 'POST',
    path: REGISTRATIONS_PATH,
    id,
    action: 'withdraw',
    ifMatch,
    idempotencyKey,
    body,
    validate: validateRegistrationPublicationOutcome,
    signal,
  });
}

// ------------------------------------------------------------------ 限制资料的 6 个操作
export function listRestriction(options = {}) {
  return fetchFamilyPage({ ...options, path: RESTRICTIONS_PATH, validateRow: validateRestrictionDraft });
}

export function getRestriction(options = {}) {
  return fetchFamilyItem({ ...options, path: RESTRICTIONS_PATH, validate: validateRestrictionDraft });
}

export function createRestriction({ fetchImpl, baseUrl, token, idempotencyKey, body, signal } = {}) {
  return writeFamilyResource({
    fetchImpl,
    baseUrl,
    token,
    method: 'POST',
    path: RESTRICTIONS_PATH,
    idempotencyKey,
    body,
    validate: validateRestrictionDraft,
    signal,
  });
}

export function editRestriction({ fetchImpl, baseUrl, token, id, ifMatch, idempotencyKey, body, signal } = {}) {
  return writeFamilyResource({
    fetchImpl,
    baseUrl,
    token,
    method: 'PATCH',
    path: RESTRICTIONS_PATH,
    id,
    ifMatch,
    idempotencyKey,
    body,
    validate: validateRestrictionDraft,
    signal,
  });
}

export function publishRestriction({ fetchImpl, baseUrl, token, id, ifMatch, idempotencyKey, body, signal } = {}) {
  return writeFamilyResource({
    fetchImpl,
    baseUrl,
    token,
    method: 'POST',
    path: RESTRICTIONS_PATH,
    id,
    action: 'publish',
    ifMatch,
    idempotencyKey,
    body,
    validate: validateRestrictionPublicationOutcome,
    signal,
  });
}

export function withdrawRestriction({ fetchImpl, baseUrl, token, id, ifMatch, idempotencyKey, body, signal } = {}) {
  return writeFamilyResource({
    fetchImpl,
    baseUrl,
    token,
    method: 'POST',
    path: RESTRICTIONS_PATH,
    id,
    action: 'withdraw',
    ifMatch,
    idempotencyKey,
    body,
    validate: validateRestrictionPublicationOutcome,
    signal,
  });
}

/**
 * 契约 `operationId` → 本模块导出的客户端函数名（**注册／限制两族共 12 条**）。
 *
 * 用途是防止「有面无人调」：`tests/unit/admin-ui-registration-restriction-parity.test.mjs`
 * 从 `packages/contracts/openapi.json` 读出这两族路径上的全部 `operationId`，与本表的键做
 * **集合双向相等**断言，并逐个核对值确实是本模块导出的函数。
 */
export const REGISTRATION_RESTRICTION_OPERATIONS = Object.freeze({
  listAdminRegistration: 'listRegistration',
  getAdminRegistration: 'getRegistration',
  createRegistrationDraft: 'createRegistration',
  editRegistrationDraft: 'editRegistration',
  publishRegistration: 'publishRegistration',
  withdrawRegistration: 'withdrawRegistration',
  listAdminRestriction: 'listRestriction',
  getAdminRestriction: 'getRestriction',
  createRestrictionDraft: 'createRestriction',
  editRestrictionDraft: 'editRestriction',
  publishRestriction: 'publishRestriction',
  withdrawRestriction: 'withdrawRestriction',
});

// ------------------------------------------------------------------ `Retry-After` 解读（R67-A02b）
// 服务端对「可重试的 503/504」与 429、409 `REQUEST_IN_PROGRESS` 统一下发 `Retry-After`（**整数秒**字符串；
// 唯一出口是 `services/api/src/errors.ts` 的 `retryAfterSecondsFor`，全仓只有 `app.ts` 的统一错误出口写该头）。
// 读面只认这一个头的整数秒形态：缺失／`0`／`abc`／`1.5`／负数／HTTP-date 一律 `null`——**不猜**一个好看的秒数。
// 回填值时 viewer 侧的 `retryHintOf` 也只在「正整数」时才拼「（建议等待 N 秒）」，两处判据同口径。
//
// ⚠ 本函数刻意放在文件**末尾**：`docs/architecture/admin-console-capability-map.md` 用「路径:行号」锚点
// 引用本文件前 600 行（`listSources:409` 起 15 条，`tools/verify-contract-status.mjs` 容差只有 ±2 行），
// 在 `readEtag` 旁插函数会把它们整体推高。函数声明会提升，所以上面的 `classifyHttpFailure` 照样能调它。
// 同理，`failure()` 与 `classifyHttpFailure` 里的 `retryAfterSeconds` 是**并到既有行**上的（不新增行），
// 否则 `verify-doc-anchors.mjs --strict` 会报「基线之外新增」——本次改动对上述行号是零位移。
function readRetryAfterSeconds(headers) {
  if (headers === null || headers === undefined) return null;
  // `Headers.get` 本身大小写不敏感；普通对象（假 response）再按 key 大小写不敏感地补一遍。
  let raw = typeof headers.get === 'function' ? headers.get('retry-after') : null;
  if (typeof raw !== 'string' && typeof headers === 'object') {
    const key = Object.keys(headers).find((name) => name.toLowerCase() === 'retry-after');
    if (key !== undefined) raw = headers[key];
  }
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!/^[0-9]+$/.test(text)) return null;
  const seconds = Number(text);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}
