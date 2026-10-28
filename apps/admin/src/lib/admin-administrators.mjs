/**
 * R60 · 管理员权限读面（`GET /admin/administrators` + `GET /admin/administrators/{id}/scopes`）。
 *
 * 只读：两条都是 GET，x-scope 都是 `scopes:read`。
 * 本文件**只做读面**；授权 / 撤销（`scopes:write`）在 `administrator-scope-api.mjs`，
 * scope 闭集在 `admin-scope-catalog.mjs`（从契约派生，本文件转出口，不另存一份）。
 *
 * 契约要点（`packages/contracts/openapi.json` `:10209` / `:10297`）：
 * - 列表项 `AdminAdministratorView` 的 required 恰好是 `{id, login_name, state, scopes}`，
 *   **没有 displayName**；`id` 是 `admin_accounts.id`，不是 `users.id`（两者同名不同源，不得混用）。
 * - scopes 视图**只含 scope 字符串**（去重 + 码元序），⛔ 不含 granted_by / granted_at。
 * - 列表未接线 ⇒ 503 PROVIDER_UNAVAILABLE，**不返回空页**；某人不存在 ⇒ 404 NOT_FOUND。
 */
import {
  CURSOR_MAX_LENGTH,
  LIMIT_DEFAULT,
  LIMIT_MAX,
  LIMIT_MIN,
  isPlainObject,
  readErrorEnvelope,
  readPageEnvelope,
} from './admin-contract.mjs';
import { clampLimit, isRetriable, normalizeBaseUrl, serverAllowsRetry } from './admin-api.mjs';
import { errorCodeText } from './audit-events.mjs';
import { ADMIN_SCOPES, ADMIN_SCOPE_LABELS, isKnownAdminScope } from './admin-scope-catalog.mjs';

export { ADMIN_SCOPES, ADMIN_SCOPE_LABELS, isKnownAdminScope };

export const ADMINISTRATORS_PATH = '/admin/administrators';
export const ADMINISTRATORS_SCOPE = 'scopes:read';
export const ADMINISTRATORS_OPERATION_ID = 'listAdministrators';
export const ADMINISTRATOR_SCOPES_OPERATION_ID = 'listAdministratorScopes';

/** 库层 admin_state 只有两态。 */
export const ADMIN_STATES = Object.freeze(['active', 'suspended']);

export const ADMIN_STATE_LABELS = Object.freeze({ active: '正常', suspended: '已暂停' });

export const ADMINISTRATORS_LIMIT_OPTIONS = Object.freeze(
  [LIMIT_DEFAULT, LIMIT_MAX].filter((value, index, list) => list.indexOf(value) === index),
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 管理员 id 必须是 uuid（契约 path 参数 format: uuid）。 */
export function isAdministratorId(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function pushIssue(list, path, message) {
  list.push(`${path}：${message}`);
}

/**
 * 校验一个 `AdminAdministratorView`。
 * @returns {{ok:boolean, errors:Array<string>, warnings:Array<string>, item:object|null}}
 */
export function validateAdministratorView(value) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ['$：管理员视图必须是对象'], warnings, item: null };
  }
  if (!isAdministratorId(value.id)) pushIssue(errors, '$.id', '必须是 uuid（admin_accounts.id）');
  if (typeof value.login_name !== 'string' || value.login_name.length < 1 || value.login_name.length > 80) {
    pushIssue(errors, '$.login_name', '必须是 1..80 字符的字符串');
  }
  if (!ADMIN_STATES.includes(value.state)) pushIssue(errors, '$.state', `必须是 ${ADMIN_STATES.join(' / ')} 之一`);
  // `revision`（契约 AdminAdministratorView，必填）：它是停用/恢复写面 `If-Match` 的唯一来源
  // ——目录不发 `ETag` 头。缺失/非正整数的行**不能**当成"能操作"：宁可校验失败，
  // 也不要让上层拿 undefined 拼出 `If-Match: "undefined"`（那只会换来 400/428）。
  if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    pushIssue(errors, '$.revision', '必须是正整数（admin_accounts.revision）');
  }
  if (!Array.isArray(value.scopes)) {
    pushIssue(errors, '$.scopes', '必须是数组');
  } else {
    if (value.scopes.length > 20) pushIssue(errors, '$.scopes', '最多 20 项');
    value.scopes.forEach((scope, index) => {
      if (typeof scope !== 'string') pushIssue(errors, `$.scopes[${index}]`, '必须是字符串');
      else if (!isKnownAdminScope(scope)) warnings.push(`$.scopes[${index}]：${scope} 不在 AdminScope 闭集里`);
    });
  }
  for (const key of Object.keys(value)) {
    if (!['id', 'login_name', 'revision', 'state', 'scopes'].includes(key)) warnings.push(`$.${key}：契约外字段（additionalProperties: false）`);
  }
  if (errors.length > 0) return { ok: false, errors, warnings, item: null };
  return { ok: true, errors, warnings, item: value };
}

/**
 * 校验 `AdminAdministratorViewPage`。
 * @returns {{ok:boolean, errors:Array<string>, warnings:Array<string>, items:Array, nextCursor:string|null}}
 */
export function validateAdministratorPage(value) {
  const errors = [];
  const warnings = [];
  const items = [];
  let nextCursor = null;
  if (!isPlainObject(value)) {
    return { ok: false, errors: ['$：分页对象必须是对象'], warnings, items, nextCursor };
  }
  if (!Array.isArray(value.items)) {
    pushIssue(errors, '$.items', '必须是数组');
  } else {
    if (value.items.length > 50) warnings.push('$.items：超过 50 项（契约 maxItems: 50）');
    value.items.forEach((item, index) => {
      const checked = validateAdministratorView(item);
      if (!checked.ok) errors.push(...checked.errors.map((message) => `$.items[${index}]${message.slice(1)}`));
      warnings.push(...checked.warnings.map((message) => `$.items[${index}]${message.slice(1)}`));
      if (checked.ok) items.push(checked.item);
    });
  }
  if (value.next_cursor === null) nextCursor = null;
  else if (typeof value.next_cursor !== 'string' || value.next_cursor === '' || value.next_cursor.length > CURSOR_MAX_LENGTH) {
    pushIssue(errors, '$.next_cursor', `必须是 null 或 1..${CURSOR_MAX_LENGTH} 字符的字符串`);
  } else nextCursor = value.next_cursor;
  return { ok: errors.length === 0, errors, warnings, items, nextCursor };
}

/**
 * 校验 `AdminAdministratorScopesView`。
 * @returns {{ok:boolean, errors:Array<string>, warnings:Array<string>, scopes:Array<string>}}
 */
export function validateAdministratorScopesView(value) {
  const errors = [];
  const warnings = [];
  const scopes = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ['$：scopes 视图必须是对象'], warnings, scopes };
  }
  if (!Array.isArray(value.scopes)) {
    pushIssue(errors, '$.scopes', '必须是数组');
  } else {
    if (value.scopes.length > 20) pushIssue(errors, '$.scopes', '最多 20 项');
    value.scopes.forEach((scope, index) => {
      if (typeof scope !== 'string' || scope === '') {
        pushIssue(errors, `$.scopes[${index}]`, '必须是非空字符串');
        return;
      }
      if (!isKnownAdminScope(scope)) warnings.push(`$.scopes[${index}]：${scope} 不在 AdminScope 闭集里`);
      scopes.push(scope);
    });
  }
  for (const key of Object.keys(value)) {
    if (key !== 'scopes') warnings.push(`$.${key}：契约外字段（additionalProperties: false，且不得含 granted_by / granted_at）`);
  }
  return { ok: errors.length === 0, errors, warnings, scopes };
}

/** 列表 URL：`limit` 总是带，`cursor` 按需带。 */
export function buildAdministratorsUrl(baseUrl, { cursor = null, limit = LIMIT_DEFAULT } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const search = new URLSearchParams();
  search.set('limit', String(clampLimit(limit)));
  if (cursor !== null && cursor !== undefined) {
    if (typeof cursor !== 'string') throw new RangeError('游标必须是字符串');
    if (cursor.length > CURSOR_MAX_LENGTH) throw new RangeError(`游标超过 ${CURSOR_MAX_LENGTH} 字符`);
    search.set('cursor', cursor);
  }
  return `${base}${ADMINISTRATORS_PATH}?${search.toString()}`;
}

/**
 * 某人的 scopes URL。id 不是 uuid 时抛错（契约 path 参数 format: uuid）。
 * @throws {RangeError}
 */
export function buildAdministratorScopesUrl(baseUrl, id) {
  if (!isAdministratorId(id)) throw new RangeError('管理员 id 必须是 uuid（admin_accounts.id），不是 users.id');
  const base = normalizeBaseUrl(baseUrl);
  return `${base}${ADMINISTRATORS_PATH}/${id}/scopes`;
}

export function emptyAdministratorCollection() {
  return { items: [], nextCursor: null, seenIds: [], pages: 0, duplicates: 0, warnings: 0, cycle: false };
}

/** 追加一页：按 id 去重；`next_cursor` 回到刚用过的游标 ⇒ 判成环并掐断。 */
export function appendAdministratorPage(collection, { cursor = null, page } = {}) {
  const base = isPlainObject(collection) ? collection : emptyAdministratorCollection();
  const items = Array.isArray(base.items) ? [...base.items] : [];
  const seen = Array.isArray(base.seenIds) ? [...base.seenIds] : [];
  const seenSet = new Set(seen);
  let duplicates = 0;
  let warnings = Number.isInteger(base.warnings) ? base.warnings : 0;

  const incoming = Array.isArray(page?.items) ? page.items : [];
  for (const item of incoming) {
    const id = typeof item?.id === 'string' ? item.id : null;
    if (id !== null) {
      if (seenSet.has(id)) {
        duplicates += 1;
        continue;
      }
      seenSet.add(id);
      seen.push(id);
    }
    items.push(item);
  }

  warnings += Number.isInteger(page?.warnings) ? page.warnings : 0;

  const nextCursorRaw = page?.nextCursor ?? null;
  const nextCursor = typeof nextCursorRaw === 'string' && nextCursorRaw !== '' ? nextCursorRaw : null;
  const cycle = nextCursor !== null && cursor !== null && nextCursor === cursor;

  return {
    items,
    nextCursor: cycle ? null : nextCursor,
    seenIds: seen,
    pages: (Number.isInteger(base.pages) ? base.pages : 0) + 1,
    duplicates,
    warnings,
    cycle,
  };
}

// ---------------------------------------------------------------- 失败态

function failure(kind, extra = {}) {
  return {
    ok: false,
    kind,
    // 服务端声明（契约 `ErrorBody.retryable`）：null = 没有服务端响应可读（网络层失败）。
    // ⛔ 不再保留本地「5xx 即可重试」的猜测字段，避免与 `canRetry` 互相矛盾。
    serverRetryable: null,
    status: null,
    code: null,
    inContract: false,
    retryAfterSeconds: null,
    message: '',
    ...extra,
  };
}

/**
 * 能不能给用户「重试」的判据是 `admin-api.mjs` 的 `serverAllowsRetry`（R67-B04 收敛为唯一一处实现）：
 * 服务端声明优先，没有声明才回落到本地闭集——本文件只 import，不再自带同体副本。
 *
 * 后端 503（管理员目录未接线等）显式 `retryable:false`（`services/api/src/admin/ops/service.ts:583`
 * 一路的 fail-closed 分支），所以不再用「5xx 就该重试」的本地猜法。
 *
 * 口径逐条：显式 `retryable:false` ⇒ 不给重试；显式 `true` ⇒ 给；没写（`serverRetryable === null`）
 * ⇒ 回落 `isRetriable(kind)`，保持既有页面行为不变；副本是三处口径漂移的根因（R67-B04）。
 */

/** 把校验问题渲染成一句话（`$.items[0].state 缺少 state`），避免报错里出现 `[object Object]`。 */
function describeIssues(errors) {
  const first = Array.isArray(errors) ? errors[0] : null;
  if (typeof first === 'string' && first !== '') return first;
  if (first === null || typeof first !== 'object') return '未知字段';
  const path = typeof first.path === 'string' ? first.path : '$';
  const problem = typeof first.problem === 'string' ? first.problem : '不符合契约';
  return `${path} ${problem}`;
}

function classifyAdministratorFailure(status, code) {
  if (code === 'SESSION_REQUIRED' || code === 'SESSION_EXPIRED') return 'signed_out';
  if (code === 'SCOPE_DENIED') return 'forbidden';
  if (code === 'NOT_FOUND') return 'not_found';
  if (code === 'RATE_LIMITED') return 'rate_limited';
  if (status === 401) return 'signed_out';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 400) return 'invalid_request';
  if (status === 429) return 'rate_limited';
  if (status === 503 || status === 504 || status >= 500) return 'unavailable';
  return 'http_error';
}

/** 错误响应 → 失败态（纯函数）。 */
export function administratorFailureFromResponse(status, body) {
  const error = readErrorEnvelope(body);
  const code = typeof error?.code === 'string' ? error.code : null;
  const kind = classifyAdministratorFailure(status, code);
  return failure(kind, {
    status: Number.isInteger(status) ? status : null,
    code,
    inContract: error?.inContract === true,
    message: typeof error?.message === 'string' ? error.message : '',
    // 信封缺失（例如反代吐 HTML）⇒ 服务端没声明可重试 ⇒ 按不可重试处理。
    serverRetryable: error === null ? false : error.retryable === true,
  });
}

async function readJsonBody(response) {
  if (typeof response?.json !== 'function') return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function readRetryAfter(headers) {
  if (typeof headers?.get !== 'function') return null;
  const raw = headers.get('retry-after');
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const seconds = Number.parseInt(raw, 10);
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : null;
}

function withRetryAfter(result, response) {
  if (result.kind !== 'rate_limited') return result;
  const retryAfter = readRetryAfter(response?.headers);
  if (retryAfter !== null) result.retryAfterSeconds = retryAfter;
  return result;
}

/** 读一份「列表」响应。 */
export async function readAdministratorsResponse(response, { cursor = null } = {}) {
  const status = Number.isInteger(response?.status) ? response.status : 0;
  const ok = response?.ok === true;
  const body = await readJsonBody(response);
  if (ok) {
    if (body === null) return failure('invalid_response', { status, message: '响应不是合法 JSON' });
    const data = readPageEnvelope(body);
    if (data === null) return failure('invalid_response', { status, message: '响应信封缺少 data 或 meta' });
    const checked = validateAdministratorPage(data);
    if (!checked.ok) {
      return failure('invalid_response', {
        status,
        message: `响应形状不符合 AdminAdministratorViewPage：${describeIssues(checked.errors)}`,
      });
    }
    return { ok: true, status, cursor, page: { items: checked.items, nextCursor: checked.nextCursor, warnings: checked.warnings } };
  }
  return withRetryAfter(administratorFailureFromResponse(status, body), response);
}

/** 读一份「某人 scopes」响应。 */
export async function readAdministratorScopesResponse(response) {
  const status = Number.isInteger(response?.status) ? response.status : 0;
  const ok = response?.ok === true;
  const body = await readJsonBody(response);
  if (ok) {
    if (body === null) return failure('invalid_response', { status, message: '响应不是合法 JSON' });
    const data = readPageEnvelope(body);
    if (data === null) return failure('invalid_response', { status, message: '响应信封缺少 data 或 meta' });
    const checked = validateAdministratorScopesView(data);
    if (!checked.ok) {
      return failure('invalid_response', {
        status,
        message: `响应形状不符合 AdminAdministratorScopesView：${describeIssues(checked.errors)}`,
      });
    }
    return { ok: true, status, scopes: checked.scopes, warnings: checked.warnings };
  }
  return withRetryAfter(administratorFailureFromResponse(status, body), response);
}

function resolveFetch(fetchImpl) {
  if (typeof fetchImpl === 'function') return fetchImpl;
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
  return null;
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}`, accept: 'application/json' };
}

/** 读一页管理员列表（GET，只读）。 */
export async function fetchAdministratorsPage({ fetchImpl, baseUrl, token, cursor = null, limit = LIMIT_DEFAULT, signal } = {}) {
  const doFetch = resolveFetch(fetchImpl);
  if (doFetch === null) return failure('network_error', { message: '当前环境没有可用的 fetch' });
  if (typeof token !== 'string' || token === '') return failure('signed_out', { message: '没有后台会话令牌' });

  let requestUrl;
  try {
    requestUrl = buildAdministratorsUrl(baseUrl, { cursor, limit });
  } catch (error) {
    return failure('invalid_cursor', { message: error instanceof Error ? error.message : '游标不可用' });
  }

  let response;
  try {
    response = await doFetch(requestUrl, { method: 'GET', headers: authHeaders(token), credentials: 'omit', signal });
  } catch (error) {
    return failure('network_error', {
      status: null,
      message: error instanceof Error ? error.message : '网络请求失败',
      requestUrl,
    });
  }

  const result = await readAdministratorsResponse(response, { cursor });
  return { ...result, requestUrl };
}

/** 读某人的 scopes（GET，只读）。 */
export async function fetchAdministratorScopes({ fetchImpl, baseUrl, token, id, signal } = {}) {
  const doFetch = resolveFetch(fetchImpl);
  if (doFetch === null) return failure('network_error', { message: '当前环境没有可用的 fetch' });
  if (typeof token !== 'string' || token === '') return failure('signed_out', { message: '没有后台会话令牌' });

  let requestUrl;
  try {
    requestUrl = buildAdministratorScopesUrl(baseUrl, id);
  } catch (error) {
    return failure('invalid_request', { message: error instanceof Error ? error.message : '管理员 id 不可用' });
  }

  let response;
  try {
    response = await doFetch(requestUrl, { method: 'GET', headers: authHeaders(token), credentials: 'omit', signal });
  } catch (error) {
    return failure('network_error', {
      status: null,
      message: error instanceof Error ? error.message : '网络请求失败',
      requestUrl,
    });
  }

  const result = await readAdministratorScopesResponse(response);
  return { ...result, requestUrl };
}

/** 失败态 → 标题/说明。 */
/**
 * 失败态 → 标题/说明。
 *
 * `context` 区分**列表**（`GET /admin/administrators`）与**详情**
 * （`GET /admin/administrators/{id}/scopes`）：列表整体回 404 只可能是路由/装配问题，
 * ⛔ 不能据此断言「某个 `admin_accounts.id` 不存在」——那是详情才有的语义。
 */
export function describeAdministratorFailure(result, { context = 'detail' } = {}) {
  const status = Number.isInteger(result?.status) ? result.status : null;
  const serverMessage = typeof result?.message === 'string' && result.message !== '' ? `后端说明：${result.message}` : '';
  const listView = context === 'list';
  switch (result?.kind) {
    case 'signed_out':
      return {
        tone: 'error',
        title: '未登录或会话已过期',
        detail: status === null ? '请重新登录后台后再读取管理员权限。' : `请重新登录后台（HTTP ${status}）。`,
        canRetry: false,
      };
    case 'forbidden':
      return {
        tone: 'error',
        title: `权限不足（缺少 ${ADMINISTRATORS_SCOPE}）`,
        detail: `后台会话有效，但这两条读面都要求 scope ${ADMINISTRATORS_SCOPE}（scopes:write 不顶替读面）。`,
        canRetry: false,
      };
    case 'not_found':
      return listView
        ? {
            tone: 'error',
            title: '调用失败（HTTP 404）',
            detail: `列表接口 GET ${ADMINISTRATORS_PATH} 回 404：请确认后端路由与权限装配（这不代表某个 admin_accounts.id 不存在）。`,
            canRetry: false,
          }
        : { tone: 'error', title: '管理员不存在', detail: '后端回 404 NOT_FOUND：该 admin_accounts.id 已不存在。', canRetry: false };
    case 'invalid_request':
      return { tone: 'error', title: '请求参数被后端拒绝', detail: serverMessage === '' ? '管理员 id 或分页参数不符合契约。' : serverMessage, canRetry: false };
    case 'rate_limited': {
      const wait = Number.isInteger(result?.retryAfterSeconds) ? `（建议等待 ${result.retryAfterSeconds} 秒）` : '';
      const retry = serverAllowsRetry(result);
      return {
        tone: 'error',
        title: '请求过于频繁',
        detail: retry ? `后端限流，稍后重试${wait}。` : `后端限流，且服务端声明不可自动重试（retryable=false），请稍后再确认状态${wait}。`,
        canRetry: retry,
      };
    }
    case 'unavailable': {
      const retry = serverAllowsRetry(result);
      return {
        tone: 'error',
        title: '服务暂不可用',
        detail: retry
          ? '管理员目录未接线到认证权威或数据库不可用（后端 503，不返回空页），稍后重试。'
          : '管理员目录未接线到认证权威或数据库不可用（后端 503，不返回空页）；服务端声明不可自动重试（retryable=false），请稍后再确认状态。',
        canRetry: retry,
      };
    }
    case 'network_error':
      return { tone: 'error', title: '网络请求失败', detail: serverMessage === '' ? '请求没有到达后端，检查网络或代理后重试。' : serverMessage, canRetry: true };
    case 'invalid_response':
      return { tone: 'error', title: '响应不符合契约', detail: serverMessage === '' ? '后端返回的形状不是 AdminAdministratorViewPage。' : serverMessage, canRetry: false };
    default: {
      const retry = serverAllowsRetry(result);
      return {
        tone: 'error',
        title: '请求失败',
        detail: status === null ? serverMessage || '未知错误。' : `HTTP ${status}${serverMessage === '' ? '' : `：${serverMessage}`}`,
        canRetry: retry,
      };
    }
  }
}

// ---------------------------------------------------------------- 状态机

export function initialAdministratorsState() {
  return {
    phase: 'signed_out',
    signedIn: false,
    limit: LIMIT_DEFAULT,
    collection: emptyAdministratorCollection(),
    loadingMore: false,
    failure: null,
    stale: false,
    // 「重置型刷新」（`LOAD_START{reset:true}`，即停用/恢复成功后的 `refresh()`）待替换第一页。
    // 不能在 `LOAD_START` 里就地清 `items`：那样刷新期间表格会闪空；改成在这里记一笔，
    // 由 `LOAD_OK` 消费——见 `LOAD_OK` 里对 `appendAdministratorPage` 基线的选择。
    pendingReset: false,
    scopeWarning: false,
    selectedId: null,
    selectedLoginName: '',
    scopesPhase: 'idle',
    scopes: null,
    scopesFailure: null,
  };
}

function clearScopes(state) {
  return { ...state, selectedId: null, selectedLoginName: '', scopesPhase: 'idle', scopes: null, scopesFailure: null };
}

/**
 * 纯 reducer。事件：SESSION_MISSING / SIGN_IN_START / SIGN_IN_FAILED / SIGNED_IN / SIGN_OUT /
 * SET_LIMIT / LOAD_START / LOAD_OK / LOAD_FAIL / SELECT_ADMIN / SCOPES_LOAD_START / SCOPES_OK /
 * SCOPES_FAIL / CLOSE_SCOPES
 */
export function reduceAdministrators(state, action) {
  const current = isPlainObject(state) ? state : initialAdministratorsState();
  switch (action?.type) {
    case 'SESSION_MISSING':
      return initialAdministratorsState();

    case 'SIGN_IN_START':
      return { ...current, phase: 'signing_in', failure: null };

    case 'SIGN_IN_FAILED':
      return {
        ...current,
        phase: 'signed_out',
        signedIn: false,
        failure: { ...failure('signed_out'), message: typeof action.message === 'string' ? action.message : '' },
      };

    case 'SIGNED_IN': {
      const scopes = Array.isArray(action.scopes) ? action.scopes : [];
      return {
        ...clearScopes(current),
        signedIn: true,
        phase: 'loading',
        scopeWarning: !scopes.includes(ADMINISTRATORS_SCOPE),
        failure: null,
        stale: false,
        collection: emptyAdministratorCollection(),
      };
    }

    case 'SIGN_OUT':
      return initialAdministratorsState();

    case 'SET_LIMIT':
      return { ...current, limit: clampLimit(action.limit) };

    case 'LOAD_START': {
      const reset = action.reset === true;
      const hasRows = current.collection.items.length > 0;
      return {
        ...current,
        failure: reset ? null : current.failure,
        loadingMore: reset ? false : true,
        stale: reset ? hasRows : current.stale,
        phase: reset ? (hasRows ? 'ready' : 'loading') : current.phase,
        pendingReset: reset,
      };
    }

    case 'LOAD_OK': {
      // 重置型刷新读的是**同一页**（`cursor === null`）：服务端这一页已整体取代旧数据，
      // 所以基线必须是空集合，不能接着旧的 `items` 往后「按 id 去重追加」——那会把同一个
      // `admin_accounts.id` 当重复项跳过（`duplicates += 1`），表里留着旧 `revision`，
      // 下一次点「停用」拿旧 revision 发 `If-Match` 只会换来 409 REVISION_CONFLICT。
      // 追加型（读取下一页）保持原样：接着当前集合往后追加。
      const base = current.pendingReset === true ? emptyAdministratorCollection() : current.collection;
      const collection = appendAdministratorPage(base, { cursor: action.cursor ?? null, page: action.page });
      return {
        ...current,
        collection,
        phase: collection.items.length > 0 ? 'ready' : 'empty',
        loadingMore: false,
        failure: null,
        stale: false,
        pendingReset: false,
      };
    }

    case 'LOAD_FAIL': {
      const result = isPlainObject(action.failure) ? action.failure : failure('http_error');
      if (result.kind === 'signed_out') {
        return {
          ...initialAdministratorsState(),
          phase: 'signed_out',
          signedIn: false,
          failure: result,
        };
      }
      const hasRows = current.collection.items.length > 0;
      return { ...current, failure: result, loadingMore: false, stale: hasRows, phase: hasRows ? 'ready' : 'error' };
    }

    case 'SELECT_ADMIN': {
      const id = isAdministratorId(action.id) ? action.id : null;
      if (id === null) return { ...current, scopesPhase: 'error', scopesFailure: failure('invalid_request', { message: '管理员 id 必须是 uuid' }) };
      return {
        ...current,
        selectedId: id,
        selectedLoginName: typeof action.loginName === 'string' ? action.loginName : '',
        scopesPhase: 'loading',
        scopes: null,
        scopesFailure: null,
      };
    }

    case 'SCOPES_LOAD_START': {
      const id = isAdministratorId(action.id) ? action.id : current.selectedId;
      return {
        ...current,
        selectedId: id,
        selectedLoginName: typeof action.loginName === 'string' ? action.loginName : current.selectedLoginName,
        scopesPhase: 'loading',
        scopes: null,
        scopesFailure: null,
      };
    }

    case 'SCOPES_OK':
      return {
        ...current,
        scopesPhase: 'ready',
        scopes: Array.isArray(action.scopes) ? action.scopes : [],
        scopesFailure: null,
      };

    case 'SCOPES_FAIL':
      return {
        ...current,
        scopesPhase: 'error',
        scopes: null,
        scopesFailure: isPlainObject(action.failure) ? action.failure : failure('http_error'),
      };

    case 'CLOSE_SCOPES':
      return clearScopes(current);

    default:
      return current;
  }
}

export function canLoadMoreAdministrators(state) {
  if (!state?.signedIn) return false;
  if (state.loadingMore) return false;
  if (state.failure !== null && state.failure !== undefined) return false;
  return typeof state.collection?.nextCursor === 'string' && state.collection.nextCursor !== '';
}

/** 列表状态条视图模型。 */
export function describeAdministratorsView(state) {
  const current = isPlainObject(state) ? state : initialAdministratorsState();
  const items = Array.isArray(current.collection.items) ? current.collection.items : [];
  const base = {
    tone: 'loading',
    title: '',
    detail: '',
    canRetry: false,
    canLoadMore: canLoadMoreAdministrators(current),
    errorCode: '',
    total: items.length,
    nextCursor: current.collection.nextCursor ?? null,
    duplicates: current.collection.duplicates ?? 0,
  };

  if (current.phase === 'signing_in') {
    return { ...base, tone: 'loading', title: '正在登录后台', detail: '登录成功后会自动读取管理员目录。' };
  }
  if (current.phase === 'signed_out') {
    return {
      ...base,
      tone: 'signed_out',
      title: '尚未登录后台',
      detail: `登录后可读取管理员目录（GET ${ADMINISTRATORS_PATH}，需要 scope ${ADMINISTRATORS_SCOPE}）。`,
    };
  }
  if (current.failure != null) {
    const described = describeAdministratorFailure(current.failure, { context: 'list' });
    const stale = current.failure.kind !== 'signed_out' && items.length > 0;
    return {
      ...base,
      tone: stale ? 'stale' : 'error',
      title: stale ? `${described.title}（已保留 ${items.length} 条已读数据）` : described.title,
      detail: described.detail,
      canRetry: described.canRetry,
      errorCode: errorCodeText(current.failure),
    };
  }
  if (current.phase === 'loading') {
    return { ...base, tone: 'loading', title: '正在读取管理员目录', detail: `GET ${ADMINISTRATORS_PATH}（limit=${current.limit}）` };
  }
  if (current.phase === 'empty' || items.length === 0) {
    return {
      ...base,
      tone: 'empty',
      title: '管理员目录为空',
      detail: '接口返回 0 个管理员（items 为空且 next_cursor 为 null）：这是空目录，不是权限问题。',
    };
  }
  return {
    ...base,
    tone: current.loadingMore ? 'loading' : 'ready',
    title: `已读取 ${items.length} 个管理员`,
    detail: `${base.nextCursor === null ? '已到最后一页' : '还有下一页'} · 每项都可点开看当前有效 scopes`,
  };
}

/** 某人 scopes 面板的视图模型。 */
export function describeAdministratorScopesView(state) {
  const current = isPlainObject(state) ? state : initialAdministratorsState();
  const who = current.selectedLoginName === '' ? current.selectedId ?? '' : current.selectedLoginName;
  if (current.scopesPhase === 'idle') {
    return { tone: 'idle', title: '未选择管理员', detail: '点某一行的「查看权限」读取 GET /admin/administrators/{id}/scopes。', canRetry: false, errorCode: '', who, scopes: [] };
  }
  if (current.scopesPhase === 'loading') {
    return {
      tone: 'loading',
      title: `正在读取 ${who} 的 scopes`,
      detail: `GET ${ADMINISTRATORS_PATH}/{id}/scopes（scope ${ADMINISTRATORS_SCOPE}）`,
      canRetry: false,
      errorCode: '',
      who,
      scopes: [],
    };
  }
  if (current.scopesPhase === 'error') {
    const described = describeAdministratorFailure(current.scopesFailure, { context: 'detail' });
    return {
      tone: described.tone,
      title: described.title,
      detail: described.detail,
      canRetry: described.canRetry,
      errorCode: errorCodeText(current.scopesFailure),
      who,
      scopes: [],
    };
  }
  const scopes = Array.isArray(current.scopes) ? current.scopes : [];
  if (scopes.length === 0) {
    return {
      tone: 'empty',
      title: `${who} 当前没有任何有效权限`,
      detail: '接口返回空数组：该管理员没有未撤销的 scope（不是「读不到」）。',
      canRetry: false,
      errorCode: '',
      who,
      scopes: [],
    };
  }
  return {
    tone: 'ready',
    title: `${who} 的当前有效权限（${scopes.length} 项）`,
    detail: `GET ${ADMINISTRATORS_PATH}/{id}/scopes · 只含 scope 字符串（去重 + 码元序），不含 granted_by / granted_at`,
    canRetry: false,
    errorCode: '',
    who,
    scopes,
  };
}

// ---------------------------------------------------------------- 行视图

/**
 * 列表一行：管理员 + 该行内联展示的 scopes（列表项自带 scopes 字段）。
 *
 * `revision` 是停用/恢复写面 `If-Match` 的**唯一**来源（目录不发 ETag）。拿不到合法的正整数
 * revision 就直接返回 `null`（不产出该行），不再用「revision 0 + revisionLabel '—'」兜一个
 * 看起来正常、实则点不动的行：那行既不能操作，又会让人以为「这行就是没版本号」，比不显示更含糊。
 */
export function administratorRowView(item) {
  const value = isPlainObject(item) ? item : {};
  const revision = typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision >= 1
    ? value.revision
    : null;
  if (revision === null) return null;
  const scopes = Array.isArray(value.scopes) ? value.scopes.filter((scope) => typeof scope === 'string') : [];
  const state = typeof value.state === 'string' ? value.state : '';
  return {
    id: typeof value.id === 'string' ? value.id : '',
    loginName: typeof value.login_name === 'string' ? value.login_name : '',
    revision,
    revisionLabel: String(revision),
    state,
    stateLabel: ADMIN_STATE_LABELS[state] ?? state,
    stateTone: state === 'suspended' ? 'warn' : 'ok',
    scopes,
    scopeCount: scopes.length,
    scopesText: scopes.length === 0 ? '（无）' : scopes.join('、'),
  };
}

export function administratorRows(state) {
  const items = Array.isArray(state?.collection?.items) ? state.collection.items : [];
  // `administratorRowView` 对拿不到合法 revision 的项返回 null：过滤掉，不留半截行。
  return items.map((item) => administratorRowView(item)).filter((row) => row !== null);
}

/** scope 视图：给每条 scope 一个中文说明；闭集外的值如实标出来。 */
export function administratorScopesView(scopes) {
  const list = Array.isArray(scopes) ? scopes.filter((scope) => typeof scope === 'string') : [];
  return list.map((scope) => ({
    scope,
    label: ADMIN_SCOPE_LABELS[scope] ?? '（契约外 scope）',
    known: isKnownAdminScope(scope),
  }));
}

export function administratorLimitOptions(currentLimit = LIMIT_DEFAULT) {
  const clamped = clampLimit(currentLimit);
  return ADMINISTRATORS_LIMIT_OPTIONS.includes(clamped)
    ? ADMINISTRATORS_LIMIT_OPTIONS
    : Object.freeze([...ADMINISTRATORS_LIMIT_OPTIONS, clamped].sort((a, b) => a - b));
}

export function isValidAdministratorsLimit(limit) {
  return Number.isInteger(limit) && limit >= LIMIT_MIN && limit <= LIMIT_MAX;
}

export { errorCodeText };
