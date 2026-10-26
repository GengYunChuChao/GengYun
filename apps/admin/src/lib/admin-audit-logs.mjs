/**
 * R60 · 审计总台账（`GET /admin/audit-logs`，operationId `listAuditLogs`）读面。
 *
 * 只读：本模块只构造 GET、校验响应、把结果收敛成一个可测的状态机。
 * ⛔ 不签发任何写操作（grant / revoke / approve / reject / hide 全部不在本片范围），
 * 也不新增后端 operation 或改契约。
 *
 * 参数照抄契约（`packages/contracts/openapi.json` `:10680` 起）：
 *   cursor / limit(1..50，缺省 20) / from / to / action / entity
 * ⛔ 契约里没有 `entity_type`，别再造一个；`action`、`entity` 的闭集与
 * `services/api/src/admin/audit/catalog.ts` 的 `AUDIT_ACTIONS` / `AUDIT_ENTITIES` 逐字一致
 * （后端 `parseActionParam` / `parseEntityParam` 对闭集外的值是 400 INVALID_REQUEST，不是空页）。
 *
 * 与 `audit-events.mjs`（`/admin/audit-events` 收件箱）共用契约校验与错误码文案，
 * 但分页游标绑定不同：审计总台账的游标 watermark 绑定 `[from,to,action,entity]`，
 * **换筛选必须回第一页**，否则后端回 INVALID_CURSOR「筛选条件已变化，请从第一页重新开始」。
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
import { clampLimit, isRetriable, normalizeBaseUrl } from './admin-api.mjs';
import { AUDIT_RESULT_LABELS, AUDIT_RESULT_TONES, errorCodeText, validateAuditEventPage } from './audit-events.mjs';

/** 契约路径（逐字，不拼 query）。 */
export const AUDIT_LOGS_PATH = '/admin/audit-logs';
/** 该 operation 的 x-scope。 */
export const AUDIT_LOGS_SCOPE = 'audit:read';
/** operationId（与 catalog 的 `AUDIT_LOG_OPERATION_ID` 一致）。 */
export const AUDIT_LOGS_OPERATION_ID = 'listAuditLogs';

/** `action` 闭集：与 `services/api/src/admin/audit/catalog.ts` 的 `AUDIT_ACTIONS` 逐字同序。 */
export const AUDIT_LOG_ACTIONS = Object.freeze(['account.suspend', 'account.restore', 'set_flag', 'job.cancel']);

export const AUDIT_LOG_ACTION_LABELS = Object.freeze({
  'account.suspend': '暂停账号',
  'account.restore': '恢复账号',
  set_flag: '改功能开关',
  'job.cancel': '取消作业',
});

/** `entity` 闭集：与 `catalog.ts` 的 `AUDIT_ENTITIES` 逐字同序（⛔ 不是 `entity_type`）。 */
export const AUDIT_LOG_ENTITIES = Object.freeze(['account', 'flag', 'job']);

export const AUDIT_LOG_ENTITY_LABELS = Object.freeze({
  account: '账号',
  flag: '功能开关',
  job: '作业',
});

/** entity → 事件落库时的 scope（`AUDIT_ENTITY_SCOPES`）。仅用于说明文案。 */
export const AUDIT_LOG_ENTITY_SCOPES = Object.freeze({
  account: 'accounts:suspend',
  flag: 'flags:write',
  job: 'jobs:cancel',
});

export const AUDIT_LOG_LIMIT_OPTIONS = Object.freeze([LIMIT_DEFAULT, LIMIT_MAX].filter((value, index, list) => list.indexOf(value) === index));

/** 只读筛选字段白名单：白名单外的一律不下传（后端不认的参数名不自己造）。 */
export const AUDIT_LOG_FILTER_FIELDS = Object.freeze(['from', 'to', 'action', 'entity']);

/** 后端 `parseTimestampParam` 的同一正则：必须是带时区的 RFC 3339。 */
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** 「全部」在下拉里用 `all` 表示，下传时换成「不带这个参数」。 */
export const AUDIT_LOG_FILTER_ANY = 'all';

/** 空筛选。 */
export function emptyAuditLogFilters() {
  return { from: '', to: '', action: AUDIT_LOG_FILTER_ANY, entity: AUDIT_LOG_FILTER_ANY };
}

/**
 * 把 UI 形态的筛选（`all` / 前后带空白的输入）收敛成下传形态（`''` 表示不带）。
 * 未知字段直接丢弃——白名单之外的东西不进 URL。
 */
export function normalizeAuditLogFilters(filters) {
  const source = isPlainObject(filters) ? filters : {};
  const read = (field) => (typeof source[field] === 'string' ? source[field].trim() : '');
  const pick = (field, allowed) => {
    const value = read(field);
    if (value === '' || value === AUDIT_LOG_FILTER_ANY) return '';
    return allowed.includes(value) ? value : value;
  };
  return {
    from: read('from'),
    to: read('to'),
    action: pick('action', AUDIT_LOG_ACTIONS),
    entity: pick('entity', AUDIT_LOG_ENTITIES),
  };
}

/**
 * 校验一份筛选。**不下网络**：与后端同样 fail-closed，把后端会 400 的输入挡在请求之前。
 * @returns {{ok:boolean, filters:{from:string,to:string,action:string,entity:string}, errors:Array<{field:string,code:string,message:string}>}}
 */
export function validateAuditLogFilters(filters) {
  const normalized = normalizeAuditLogFilters(filters);
  const errors = [];

  for (const field of ['from', 'to']) {
    const raw = normalized[field];
    if (raw === '') continue;
    if (!RFC3339_RE.test(raw) || !Number.isFinite(Date.parse(raw))) {
      errors.push({
        field,
        code: 'format',
        message: `${field} 必须是带时区的 RFC 3339 时间串（例：2026-10-23T00:00:00Z）`,
      });
    }
  }

  if (normalized.action !== '' && !AUDIT_LOG_ACTIONS.includes(normalized.action)) {
    errors.push({
      field: 'action',
      code: 'enum',
      message: `action 必须是闭集之一：${AUDIT_LOG_ACTIONS.join(' / ')}`,
    });
  }

  if (normalized.entity !== '' && !AUDIT_LOG_ENTITIES.includes(normalized.entity)) {
    errors.push({
      field: 'entity',
      code: 'enum',
      message: `entity 必须是闭集之一：${AUDIT_LOG_ENTITIES.join(' / ')}`,
    });
  }

  if (errors.length === 0 && normalized.from !== '' && normalized.to !== '') {
    if (Date.parse(normalized.from) > Date.parse(normalized.to)) {
      errors.push({ field: 'from', code: 'order', message: 'from 必须早于或等于 to（闭区间）' });
    }
  }

  return { ok: errors.length === 0, filters: normalized, errors };
}

/** 是否带了任何筛选（决定空态说「台账为空」还是「当前筛选下没有事件」）。 */
export function hasActiveAuditLogFilters(filters) {
  const normalized = normalizeAuditLogFilters(filters);
  return (normalized.from !== '' || normalized.to !== '' || normalized.action !== '' || normalized.entity !== '');
}

/** 人话描述当前筛选，用于状态条与页脚。 */
export function describeAuditLogFilters(filters) {
  const normalized = normalizeAuditLogFilters(filters);
  const parts = [];
  if (normalized.action !== '') parts.push(`action=${normalized.action}`);
  if (normalized.entity !== '') parts.push(`entity=${normalized.entity}`);
  if (normalized.from !== '') parts.push(`from=${normalized.from}`);
  if (normalized.to !== '') parts.push(`to=${normalized.to}`);
  return parts.length === 0 ? '无筛选（全部事件）' : parts.join(' · ');
}

/**
 * 构造请求 URL：`limit` 总是带，`cursor` / 筛选按需带。
 * @throws {RangeError} 游标超长（>2048）时抛错，由调用方转成 invalid_cursor 失败态。
 */
export function buildAuditLogsUrl(baseUrl, { cursor = null, limit = LIMIT_DEFAULT, filters = null } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const search = new URLSearchParams();
  search.set('limit', String(clampLimit(limit)));
  const normalized = normalizeAuditLogFilters(filters);
  for (const field of AUDIT_LOG_FILTER_FIELDS) {
    const value = normalized[field];
    if (value !== '') search.set(field, value);
  }
  if (cursor !== null && cursor !== undefined) {
    if (typeof cursor !== 'string') throw new RangeError('游标必须是字符串');
    if (cursor.length > CURSOR_MAX_LENGTH) throw new RangeError(`游标超过 ${CURSOR_MAX_LENGTH} 字符`);
    search.set('cursor', cursor);
  }
  return `${base}${AUDIT_LOGS_PATH}?${search.toString()}`;
}

/** 校验一整页：形状与 `AuditEventPage` 一致，逐项过 `AuditEvent`（复用收件箱那份校验）。 */
export function validateAuditLogPage(value) {
  return validateAuditEventPage(value);
}

export function emptyAuditLogCollection() {
  return { items: [], nextCursor: null, seenIds: [], pages: 0, duplicates: 0, warnings: 0, cycle: false };
}

/**
 * 追加一页：按 `id` 去重；`next_cursor` 回到刚用过的游标 ⇒ 判定成环并掐断分页。
 * @returns {{items:Array, nextCursor:string|null, seenIds:Array, pages:number, duplicates:number, warnings:number, cycle:boolean}}
 */
export function appendAuditLogPage(collection, { cursor = null, page } = {}) {
  const base = isPlainObject(collection) ? collection : emptyAuditLogCollection();
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
 * 能不能给用户「重试」：**服务端声明优先**，没有声明才回落到本地闭集。
 *
 * 后端的 503 全都显式 `retryable:false`（`services/api/src/admin/audit/service.ts:33`、
 * `:195`、`:243-244`、`:255-256`、`:275-276`），所以不能再用「5xx 就该重试」的本地猜法：
 * 那会让页面许诺一件服务端明说不会自动好的事。只有**根本没拿到响应**的失败
 * （网络错误）才由本地闭集决定。
 */
function serverAllowsRetry(result) {
  if (typeof result?.serverRetryable === 'boolean') return result.serverRetryable;
  return isRetriable(result?.kind) === true;
}

/** 把校验问题渲染成一句话（`$.items[0].result 不在闭集内`），避免报错里出现 `[object Object]`。 */
function describeIssues(errors) {
  const first = Array.isArray(errors) ? errors[0] : null;
  if (typeof first === 'string' && first !== '') return first;
  if (first === null || typeof first !== 'object') return '未知字段';
  const path = typeof first.path === 'string' ? first.path : '$';
  const problem = typeof first.problem === 'string' ? first.problem : '不符合契约';
  return `${path} ${problem}`;
}

/** 状态码 + 错误码 → 失败种类。⛔ 错误码一律来自契约 ErrorCode，不自造。 */
function classifyAuditLogFailure(status, code) {
  if (code === 'SESSION_REQUIRED' || code === 'SESSION_EXPIRED') return 'signed_out';
  if (code === 'SCOPE_DENIED') return 'forbidden';
  if (code === 'RATE_LIMITED') return 'rate_limited';
  if (status === 401) return 'signed_out';
  if (status === 403) return 'forbidden';
  if (status === 400 && code === 'INVALID_CURSOR') return 'invalid_cursor';
  if (status === 400) return 'invalid_request';
  if (status === 429) return 'rate_limited';
  if (status === 503 || status === 504 || status >= 500) return 'unavailable';
  return 'http_error';
}

/** 把一次错误响应收敛成失败态（纯函数，便于单测直接喂 `{status, code, message}`）。 */
export function auditLogFailureFromResponse(status, body) {
  const error = readErrorEnvelope(body);
  const code = typeof error?.code === 'string' ? error.code : null;
  const kind = classifyAuditLogFailure(status, code);
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

/**
 * 读一份响应（已经拿到 Response 之后）：成功 ⇒ `{ok:true,page}`，失败 ⇒ 失败态。
 * 与 `fetchAuditLogsPage` 拆开是为了让单测能直接喂 2xx/4xx/5xx 各分支。
 */
export async function readAuditLogsResponse(response, { cursor = null } = {}) {
  const status = Number.isInteger(response?.status) ? response.status : 0;
  const ok = response?.ok === true;
  const body = await readJsonBody(response);

  if (ok) {
    if (body === null) return failure('invalid_response', { status, message: '响应不是合法 JSON' });
    const data = readPageEnvelope(body);
    if (data === null) return failure('invalid_response', { status, message: '响应信封缺少 data 或 meta' });
    const checked = validateAuditLogPage(data);
    if (!checked.ok) {
      return failure('invalid_response', {
        status,
        message: `响应形状不符合 AuditEventPage：${describeIssues(checked.errors)}`,
      });
    }
    return {
      ok: true,
      status,
      cursor,
      page: { items: checked.items, nextCursor: checked.nextCursor, warnings: checked.warnings },
    };
  }

  const result = auditLogFailureFromResponse(status, body);
  if (result.kind === 'rate_limited') {
    const retryAfter = readRetryAfter(response?.headers);
    if (retryAfter !== null) result.retryAfterSeconds = retryAfter;
  }
  return result;
}

/**
 * 读一页审计日志。只发 GET；鉴权头与 `audit-events.mjs` 同款。
 * @returns {Promise<{ok:true,status:number,cursor:string|null,page:{items:Array,nextCursor:string|null,warnings:number},requestUrl:string}|{ok:false,kind:string}>}
 */
export async function fetchAuditLogsPage({ fetchImpl, baseUrl, token, cursor = null, limit = LIMIT_DEFAULT, filters = null, signal } = {}) {
  const doFetch =
    typeof fetchImpl === 'function'
      ? fetchImpl
      : typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : null;
  if (doFetch === null) return failure('network_error', { message: '当前环境没有可用的 fetch' });
  if (typeof token !== 'string' || token === '') return failure('signed_out', { message: '没有后台会话令牌' });

  let requestUrl;
  try {
    requestUrl = buildAuditLogsUrl(baseUrl, { cursor, limit, filters });
  } catch (error) {
    return failure('invalid_cursor', { message: error instanceof Error ? error.message : '游标不可用' });
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
      status: null,
      message: error instanceof Error ? error.message : '网络请求失败',
      requestUrl,
    });
  }

  const result = await readAuditLogsResponse(response, { cursor });
  return { ...result, requestUrl };
}

/** 失败态 → 标题/说明（文案与收件箱保持同一口气，但点明本端点与 scope）。 */
export function describeAuditLogFailure(result) {
  const status = Number.isInteger(result?.status) ? result.status : null;
  const serverMessage = typeof result?.message === 'string' && result.message !== '' ? `后端说明：${result.message}` : '';
  switch (result?.kind) {
    case 'signed_out':
      return {
        tone: 'error',
        title: '未登录或会话已过期',
        detail: status === null ? '请重新登录后台后再读取审计总台账。' : `请重新登录后台（HTTP ${status}）。`,
        canRetry: false,
      };
    case 'forbidden':
      return {
        tone: 'error',
        title: `权限不足（缺少 ${AUDIT_LOGS_SCOPE}）`,
        detail: `后台会话有效，但 GET ${AUDIT_LOGS_PATH} 要求 scope ${AUDIT_LOGS_SCOPE}；请让持有 scopes:write 的管理员补授。`,
        canRetry: false,
      };
    case 'invalid_cursor':
      return {
        tone: 'error',
        title: '游标已失效',
        detail: '筛选条件变化或游标过期，需要从第一页重新读取。',
        // 这里的「重试」是**回第一页重读**（客户端动作，按钮文案会变成「回第一页重读」），
        // 不是重放同一个游标请求，所以不受服务端 retryable 约束。
        canRetry: true,
      };
    case 'invalid_request':
      return {
        tone: 'error',
        title: '请求参数被后端拒绝',
        detail: serverMessage === '' ? '筛选参数不符合契约，请检查 action / entity / from / to。' : serverMessage,
        canRetry: false,
      };
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
          ? '审计日志端口未接线或数据库不可用（后端 503，不伪造空页），稍后重试。'
          : '审计日志端口未接线或数据库不可用（后端 503，不伪造空页）；服务端声明不可自动重试（retryable=false），请稍后再确认状态。',
        canRetry: retry,
      };
    }
    case 'network_error':
      return { tone: 'error', title: '网络请求失败', detail: serverMessage === '' ? '请求没有到达后端，检查网络或代理后重试。' : serverMessage, canRetry: true };
    case 'invalid_response':
      return { tone: 'error', title: '响应不符合契约', detail: serverMessage === '' ? '后端返回的形状不是 AuditEventPage。' : serverMessage, canRetry: false };
    case 'invalid_filter':
      return { tone: 'error', title: '筛选条件不合法', detail: serverMessage === '' ? '请修正筛选后再读取。' : serverMessage, canRetry: false };
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

export function initialAuditLogState() {
  return {
    phase: 'signed_out',
    signedIn: false,
    limit: LIMIT_DEFAULT,
    draft: emptyAuditLogFilters(),
    applied: emptyAuditLogFilters(),
    collection: emptyAuditLogCollection(),
    loadingMore: false,
    failure: null,
    filterFailure: null,
    expandedId: null,
    stale: false,
    scopeWarning: false,
  };
}

function resetCollection(state) {
  return { ...state, collection: emptyAuditLogCollection() };
}

/**
 * 纯 reducer。事件：
 * SESSION_MISSING / SIGN_IN_START / SIGN_IN_FAILED / SIGNED_IN / SIGN_OUT / SET_LIMIT /
 * SET_DRAFT_FILTER / FILTERS_APPLIED / LOAD_START / LOAD_OK / LOAD_FAIL / TOGGLE_ROW / CLOSE_ROW
 */
export function reduceAuditLog(state, action) {
  const current = isPlainObject(state) ? state : initialAuditLogState();
  switch (action?.type) {
    case 'SESSION_MISSING':
      return { ...initialAuditLogState() };

    case 'SIGN_IN_START':
      return { ...current, phase: 'signing_in', failure: null, filterFailure: null };

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
        ...current,
        signedIn: true,
        phase: 'loading',
        scopeWarning: !scopes.includes(AUDIT_LOGS_SCOPE),
        failure: null,
        filterFailure: null,
        stale: false,
        collection: emptyAuditLogCollection(),
      };
    }

    case 'SIGN_OUT':
      return { ...initialAuditLogState() };

    case 'SET_LIMIT':
      return { ...current, limit: clampLimit(action.limit) };

    case 'SET_DRAFT_FILTER': {
      const field = typeof action.field === 'string' ? action.field : '';
      if (!AUDIT_LOG_FILTER_FIELDS.includes(field)) return current;
      const value = typeof action.value === 'string' ? action.value : '';
      return { ...current, draft: { ...current.draft, [field]: value } };
    }

    case 'FILTERS_APPLIED': {
      const checked = validateAuditLogFilters(current.draft);
      if (!checked.ok) {
        const first = checked.errors[0];
        return {
          ...current,
          filterFailure: {
            ...failure('invalid_filter'),
            errors: checked.errors,
            message: first === undefined ? '' : first.message,
          },
        };
      }
      return {
        ...resetCollection(current),
        applied: checked.filters,
        expandedId: null,
        failure: null,
        filterFailure: null,
        stale: false,
        phase: 'loading',
      };
    }

    case 'LOAD_START': {
      const reset = action.reset === true;
      const hasRows = current.collection.items.length > 0;
      return {
        ...current,
        failure: reset ? null : current.failure,
        loadingMore: reset ? false : true,
        stale: reset ? hasRows : current.stale,
        phase: reset ? (hasRows ? 'ready' : 'loading') : current.phase,
      };
    }

    case 'LOAD_OK': {
      const collection = appendAuditLogPage(current.collection, { cursor: action.cursor ?? null, page: action.page });
      return {
        ...current,
        collection,
        phase: collection.items.length > 0 ? 'ready' : 'empty',
        loadingMore: false,
        failure: null,
        stale: false,
      };
    }

    case 'LOAD_FAIL': {
      const result = isPlainObject(action.failure) ? action.failure : failure('http_error');
      if (result.kind === 'signed_out') {
        return { ...resetCollection(current), phase: 'signed_out', signedIn: false, failure: result, loadingMore: false, stale: false };
      }
      const hasRows = current.collection.items.length > 0;
      return {
        ...current,
        failure: result,
        loadingMore: false,
        stale: hasRows,
        phase: hasRows ? 'ready' : 'error',
      };
    }

    case 'TOGGLE_ROW': {
      const id = typeof action.id === 'string' ? action.id : null;
      if (id === null) return current;
      return { ...current, expandedId: current.expandedId === id ? null : id };
    }

    case 'CLOSE_ROW':
      return { ...current, expandedId: null };

    default:
      return current;
  }
}

/** 还能不能再翻下一页：有游标、不在加载中、且当前没有未解决的失败。 */
export function canLoadMoreAuditLogs(state) {
  if (!state?.signedIn) return false;
  if (state.loadingMore) return false;
  if (state.failure !== null && state.failure !== undefined) return false;
  return typeof state.collection?.nextCursor === 'string' && state.collection.nextCursor !== '';
}

/** 失败是否需要「回第一页重读」（游标失效或筛选刚变）。 */
export function needsAuditLogRestart(state) {
  return state?.failure?.kind === 'invalid_cursor';
}

/** 视图模型：状态条 + 计数 + 是否可以重试 / 是否可以翻页。 */
export function describeAuditLogView(state) {
  const current = isPlainObject(state) ? state : initialAuditLogState();
  const items = Array.isArray(current.collection.items) ? current.collection.items : [];
  const filtered = hasActiveAuditLogFilters(current.applied);
  const filterText = describeAuditLogFilters(current.applied);
  const base = {
    tone: 'loading',
    title: '',
    detail: '',
    canRetry: false,
    canLoadMore: canLoadMoreAuditLogs(current),
    restartNeeded: needsAuditLogRestart(current),
    errorCode: '',
    total: items.length,
    shown: items.length,
    filtered,
    filterText,
    nextCursor: current.collection.nextCursor ?? null,
    duplicates: current.collection.duplicates ?? 0,
  };

  if (current.phase === 'signing_in') {
    return { ...base, tone: 'loading', title: '正在登录后台', detail: '登录成功后会自动读取审计总台账。' };
  }

  if (current.phase === 'signed_out') {
    return {
      ...base,
      tone: 'signed_out',
      title: '尚未登录后台',
      detail: `登录后可读取审计总台账（GET ${AUDIT_LOGS_PATH}，需要 scope ${AUDIT_LOGS_SCOPE}）。`,
    };
  }

  if (current.failure != null) {
    const described = describeAuditLogFailure(current.failure);
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
    return {
      ...base,
      tone: 'loading',
      title: '正在读取审计总台账',
      detail: `GET ${AUDIT_LOGS_PATH}（limit=${current.limit} · ${filterText}）`,
    };
  }

  if (current.phase === 'empty' || items.length === 0) {
    return filtered
      ? {
          ...base,
          tone: 'empty_filtered',
          title: '当前筛选下没有事件',
          detail: `筛选：${filterText}。换一个 action / entity 或放宽时间范围再试（⛔ 这不是权限问题）。`,
        }
      : {
          ...base,
          tone: 'empty',
          title: '审计总台账为空',
          detail: '接口返回 0 条事件（items 为空且 next_cursor 为 null）：这是空台账，不是错误。',
        };
  }

  const more = base.nextCursor === null ? '已到最后一页' : '还有下一页';
  return {
    ...base,
    tone: current.loadingMore ? 'loading' : 'ready',
    title: `已读取 ${items.length} 条事件`,
    detail: `${filterText} · ${more}${current.collection.pages > 1 ? ` · 已读 ${current.collection.pages} 页` : ''}`,
  };
}

// ---------------------------------------------------------------- 行视图

/** ISO 时间 → 稳定的 `YYYY-MM-DD HH:MM:SSZ`（按 UTC 渲染，跨时区不走样）。 */
export function formatAuditLogTimestamp(raw) {
  if (typeof raw !== 'string' || raw === '') return '—';
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return raw;
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}Z`;
}

/** `TargetRef` → `type:id@revision`。 */
export function describeAuditLogTarget(targetRef) {
  if (!isPlainObject(targetRef)) return '（无目标引用）';
  const type = typeof targetRef.type === 'string' && targetRef.type !== '' ? targetRef.type : '未知类型';
  const id = typeof targetRef.id === 'string' && targetRef.id !== '' ? targetRef.id : '未知 id';
  const revision = Number.isInteger(targetRef.revision) ? `r${targetRef.revision}` : 'r?';
  return `${type}:${id}@${revision}`;
}

/** `FlagReading | null` → 一行说明。 */
export function describeFlagReading(reading) {
  if (!isPlainObject(reading)) return '（无）';
  const enabled = reading.enabled === true ? 'true' : reading.enabled === false ? 'false' : '?';
  const revision = Number.isInteger(reading.revision) ? reading.revision : '?';
  return `enabled=${enabled} · revision=${revision}`;
}

/** 表格一行的展示字段（视图不直接读契约字段，避免模板里散落字段名）。 */
export function auditLogRowView(item) {
  const value = isPlainObject(item) ? item : {};
  const action = typeof value.action === 'string' ? value.action : '';
  const result = typeof value.result === 'string' ? value.result : '';
  return {
    id: typeof value.id === 'string' ? value.id : '',
    createdAt: typeof value.created_at === 'string' ? value.created_at : '',
    createdAtText: formatAuditLogTimestamp(value.created_at),
    action,
    actionLabel: AUDIT_LOG_ACTION_LABELS[action] ?? action,
    scope: typeof value.scope === 'string' ? value.scope : '',
    result,
    resultLabel: AUDIT_RESULT_LABELS[result] ?? result,
    resultTone: AUDIT_RESULT_TONES[result] ?? 'warn',
    reasonCode: typeof value.reason_code === 'string' ? value.reason_code : '',
    requestId: typeof value.request_id === 'string' ? value.request_id : '',
    actor: typeof value.actor === 'string' ? value.actor : '',
    targetHint: typeof value.target_hint === 'string' ? value.target_hint : '',
    targetText: describeAuditLogTarget(value.target_ref),
    trail: [
      { label: 'actor（admin_accounts.id）', value: typeof value.actor === 'string' ? value.actor : '（无）' },
      { label: 'target_hint', value: typeof value.target_hint === 'string' ? value.target_hint : '（无）' },
      { label: 'target_ref', value: describeAuditLogTarget(value.target_ref) },
      { label: 'before_value', value: describeFlagReading(value.before_value) },
      { label: 'after_value', value: describeFlagReading(value.after_value) },
      { label: 'request_id', value: typeof value.request_id === 'string' ? value.request_id : '（无）' },
    ],
  };
}

/** 一页 → 行视图数组。 */
export function auditLogRows(state) {
  const items = Array.isArray(state?.collection?.items) ? state.collection.items : [];
  return items.map((item) => auditLogRowView(item));
}

/** 供模板直接用的 limit 选项（带当前值，防止后端只认 20/50 而 UI 给别的）。 */
export function auditLogLimitOptions(currentLimit = LIMIT_DEFAULT) {
  const clamped = clampLimit(currentLimit);
  return AUDIT_LOG_LIMIT_OPTIONS.includes(clamped) ? AUDIT_LOG_LIMIT_OPTIONS : Object.freeze([...AUDIT_LOG_LIMIT_OPTIONS, clamped].sort((a, b) => a - b));
}

/** limit 是否在契约区间内（1..50）。 */
export function isValidAuditLogLimit(limit) {
  return Number.isInteger(limit) && limit >= LIMIT_MIN && limit <= LIMIT_MAX;
}

export { errorCodeText };
