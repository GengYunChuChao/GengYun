/**
 * 管理员账号「停用／恢复」写面 HTTP 客户端（R67-A05）。
 *
 * 契约（`packages/contracts/openapi.json`）：
 *  - `POST /admin/administrators/{id}/disable` — `operationId: disableAdministratorAccount`
 *  - `POST /admin/administrators/{id}/enable`  — `operationId: enableAdministratorAccount`
 *  两者都要求 `If-Match`（比对 `admin_accounts.revision`）、`Idempotency-Key` 与
 *  `ReasonInput { reason }`，门沿用 `scopes:write`，200 返回 `AdminAccountStateViewEnvelope`。
 *
 * ⛔ 这不是终端用户停用：那条是 `PATCH /admin/accounts/{id}/suspend`（`account-suspend-api.mjs`，
 * 对象是 `public.accounts`，路径与 scope 都不同）。两套 id 空间不同，⛔ 不可互相拼路径。
 *
 * 纯函数 + 可注入 `fetchImpl`，返回 `{ok:true,...}` / `{ok:false, kind, ...}`，**不抛异常**。
 * 与 `account-suspend-api.mjs` 同口径复用：`reasonProblem`／`etagForRevision`／`isRetriable`／
 * `IF_MATCH_RE`／幂等键长度边界都从这里 import，不复制第二份常量。
 */
import { normalizeBaseUrl } from './admin-api.mjs';
import { isPlainObject, readErrorEnvelope } from './admin-contract.mjs';
import {
  ADMINISTRATORS_PATH,
  ADMIN_STATES,
  isAdministratorId,
} from './admin-administrators.mjs';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IF_MATCH_RE,
  etagForRevision,
  isRetriable,
  reasonProblem,
} from './account-suspend-api.mjs';

/** 契约里只有这两个 mode：`disable` 停用、`enable` 恢复。 */
export const ADMINISTRATOR_STATE_MODES = Object.freeze(['disable', 'enable']);

/** 两条写面在 `operations.json` 里挂的 scope（读面是 `scopes:read`，别混）。 */
export const ADMINISTRATOR_STATE_SCOPE = 'scopes:write';

export const ADMINISTRATOR_STATE_LABELS = Object.freeze({ disable: '停用', enable: '恢复' });

/** `AdminAccountStateView` 的字段集（`additionalProperties: false`）。 */
const STATE_VIEW_KEYS = Object.freeze(['id', 'revision', 'state', 'auth_epoch', 'revoked_sessions', 'changed']);

const SESSION_CODES = Object.freeze(['SESSION_REQUIRED', 'SESSION_EXPIRED', 'ACCOUNT_INACTIVE']);
const PROVIDER_CODES = Object.freeze([
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
  'PROVIDER_OUTCOME_UNKNOWN',
  'PROVIDER_QUOTA_EXCEEDED',
  'OBJECT_UNAVAILABLE',
]);

function pushIssue(list, path, message) {
  list.push(`${path}：${message}`);
}

/**
 * 失败对象（与 `account-suspend-api.mjs` 同形状：`kind` 决定本地 `retriable`）。
 *
 * `serverRetryable` 是**服务端自己的声明**（契约 `ErrorBody.retryable` 必填 boolean）：
 * 有响应时是 `true`/`false`，一个字节都没发出去（本地拦下 / 网络失败）时是 `null`。
 * 用户可见的「能不能重试」以它为准（见 `describeAdministratorStateFailure` 的 `canRetry`），
 * 与 `admin-api.mjs` 的 `serverAllowsRetry` 同序：服务端说 `false` 就是 `false`。
 * `retriable` 保留为「按 kind 的本地闭集判断」，不掺服务端声明。
 * @returns {{ok:false, kind:string, retriable:boolean, serverRetryable:boolean|null, status:number|null, code:string|null}}
 */
function failure(kind, extra = {}) {
  return {
    ok: false,
    kind,
    retriable: isRetriable(kind),
    serverRetryable: null,
    status: null,
    code: null,
    inContract: false,
    message: '',
    ...extra,
  };
}

/**
 * 拼停用／恢复的写面 URL。
 *
 * ⚠ 与 `buildSuspendUrl` 的**有意偏离**：非法 `mode`／非法 `id` 返回 `null`，不抛异常。
 * 原因：这里的 `mode` 来自按钮/状态机的推导值，属"可能算错"的输入，而不是硬编码常量；
 * 抛异常会让视图 composer 里的 `try/catch` 变成必需项，返回 null 让调用方直接落 `invalid_request`。
 *
 * @param {string} baseUrl
 * @param {string} id 管理员 id（`admin_accounts.id`，uuid）
 * @param {'disable'|'enable'} mode
 * @returns {string|null}
 */
export function buildAdministratorStateUrl(baseUrl, id, mode) {
  if (!ADMINISTRATOR_STATE_MODES.includes(mode)) return null;
  if (!isAdministratorId(id)) return null;
  return `${normalizeBaseUrl(baseUrl)}${ADMINISTRATORS_PATH}/${encodeURIComponent(id)}/${mode}`;
}

/**
 * 这一行在这一模式下**能不能**发请求：状态匹配 + id 是 uuid + revision 是正整数。
 *
 * 三件缺一不可：`revision` 缺失就没有 `If-Match` 的来源（目录不发 `ETag`），
 * 硬发只会换来 400/428；`state` 不匹配则这一行本来就不该出现这个按钮。
 *
 * @param {{id?:unknown, revision?:unknown, state?:unknown}|null|undefined} row 行视图（`administratorRowView`）
 * @param {'disable'|'enable'} mode
 * @returns {boolean}
 */
export function canChangeAdministratorState(row, mode) {
  if (!isPlainObject(row)) return false;
  if (!ADMINISTRATOR_STATE_MODES.includes(mode)) return false;
  const expected = mode === 'disable' ? 'active' : 'suspended';
  if (row.state !== expected) return false;
  if (!isAdministratorId(row.id)) return false;
  return typeof row.revision === 'number' && Number.isSafeInteger(row.revision) && row.revision >= 1;
}

/** 幂等键：形状 `administrator-<32 hex>`（46 字符，落在契约 8..128 内），每次新生成。 */
export function newIdempotencyKey() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto !== undefined && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `administrator-${hex}`;
}

/** 响应头读取（`Headers` 或普通对象都认）。 */
function readHeader(response, name) {
  const headers = response === null || response === undefined ? null : response.headers;
  if (headers === null || headers === undefined) return null;
  const value = typeof headers.get === 'function' ? headers.get(name) : headers[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** `meta.request_id`（审计关联键；契约响应里没有 audit event id）。 */
function readRequestId(body) {
  const meta = isPlainObject(body) ? body.meta : null;
  if (!isPlainObject(meta)) return null;
  return typeof meta.request_id === 'string' && meta.request_id !== '' ? meta.request_id : null;
}

/** 响应信封 `{ data, meta }`：契约 required 两项，缺一即畸形（不猜）。 */
function readStateEnvelope(body) {
  if (!isPlainObject(body)) return null;
  if (!isPlainObject(body.meta)) return null; // 契约 required: data + meta
  if (!isPlainObject(body.data)) return null;
  return { data: body.data, meta: body.meta };
}

async function readJson(response) {
  if (response === null || response === undefined || typeof response.json !== 'function') return { ok: false, value: null };
  try {
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: false, value: null };
  }
}

/**
 * 校验一个 `AdminAccountStateView`（`additionalProperties: false`）。
 *
 * ⚠ `auth_epoch` 契约是 `minimum: 1`（不是 0）：0 只可能来自"没读过这行"的假数据。
 *
 * @returns {{ok:boolean, errors:Array<string>, warnings:Array<string>, item:object|null}}
 */
export function validateAdministratorStateView(value) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ['$：状态视图必须是对象'], warnings, item: null };
  }
  if (!isAdministratorId(value.id)) pushIssue(errors, '$.id', '必须是 uuid（admin_accounts.id）');
  if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    pushIssue(errors, '$.revision', '必须是正整数（admin_accounts.revision）');
  }
  if (!ADMIN_STATES.includes(value.state)) pushIssue(errors, '$.state', `必须是 ${ADMIN_STATES.join(' / ')} 之一`);
  if (typeof value.auth_epoch !== 'number' || !Number.isSafeInteger(value.auth_epoch) || value.auth_epoch < 1) {
    pushIssue(errors, '$.auth_epoch', '必须是正整数（admin_accounts.auth_epoch，契约 minimum 1）');
  }
  if (typeof value.revoked_sessions !== 'number' || !Number.isSafeInteger(value.revoked_sessions) || value.revoked_sessions < 0) {
    pushIssue(errors, '$.revoked_sessions', '必须是 ≥0 的整数');
  }
  if (typeof value.changed !== 'boolean') pushIssue(errors, '$.changed', '必须是布尔值');
  for (const key of Object.keys(value)) {
    if (!STATE_VIEW_KEYS.includes(key)) warnings.push(`$.${key}：契约外字段（additionalProperties: false）`);
  }
  if (errors.length > 0) return { ok: false, errors, warnings, item: null };
  return { ok: true, errors, warnings, item: value };
}

/**
 * HTTP 状态＋错误码 → 前端分支（`kind`）。
 *
 * 顺序有讲究：两条**自锁门**（`SELF_DISABLE_DENIED` / `LAST_SCOPE_MANAGER`）先判，
 * 它们的 HTTP 状态是 409，若落到通用的修订冲突分支就会把"自锁门拒绝"说成"被人改过"。
 *
 * @param {number|null} status
 * @param {string|null} code
 * @returns {string}
 */
export function classifyAdministratorStateFailure(status, code = null) {
  if (code === 'SELF_DISABLE_DENIED') return 'self_disable_denied';
  if (code === 'LAST_SCOPE_MANAGER') return 'last_scope_manager';
  if (status === 401 || SESSION_CODES.includes(code)) return 'signed_out';
  if (status === 403 || code === 'SCOPE_DENIED') return 'forbidden';
  if (status === 428 || code === 'REVISION_REQUIRED') return 'revision_required';
  if (code === 'REVISION_CONFLICT' || status === 412) return 'revision_conflict';
  if (code === 'IDEMPOTENCY_CONFLICT') return 'idempotency_conflict';
  if (code === 'IDEMPOTENCY_KEY_REQUIRED') return 'idempotency_key_required';
  if (code === 'REQUEST_IN_PROGRESS') return 'in_progress';
  if (status === 404 || code === 'NOT_FOUND') return 'not_found';
  if (PROVIDER_CODES.includes(code)) return 'unavailable';
  if (status === 429 || code === 'RATE_LIMITED') return 'rate_limited';
  if (typeof status === 'number' && status >= 500) return 'unavailable';
  if (status === 400 || code === 'INVALID_REQUEST') return 'invalid_request';
  return 'http_error';
}

/**
 * 发一次「停用／恢复」。
 *
 * 调用方负责：`revision` 取自已加载那一行的目录项（列表不发 `ETag`），幂等键**重试时复用**。
 *
 * 成功：`{ok:true, status, requestUrl, id, state, revision, authEpoch, revokedSessions, changed, etag, requestId, sentHeaders, mode}`
 * 失败：`{ok:false, kind, retriable, status, code, inContract, message, requestUrl, ...}`
 *
 * `changed:false` 同样是**成功**（服务端幂等短路：同键同体重放、或目标本来就在目标状态），
 * 它不写第二条审计、不推 revision —— 视图必须据此显示"已受理（本次未产生变更）"。
 *
 * @param {{fetchImpl?:Function, baseUrl?:string, token?:string, id?:string, revision?:number,
 *   mode?:'disable'|'enable', reason?:string, idempotencyKey?:string, signal?:AbortSignal}} input
 */
export async function setAdministratorState({
  fetchImpl = undefined,
  baseUrl = '',
  token = '',
  id = '',
  revision = 0,
  mode = '',
  reason = '',
  idempotencyKey = '',
  signal = undefined,
} = {}) {
  // ---- 本地前置拦截（一个字节都不发出去）
  const requestUrl = buildAdministratorStateUrl(baseUrl, id, mode);
  if (requestUrl === null) {
    if (!ADMINISTRATOR_STATE_MODES.includes(mode)) {
      return failure('invalid_request', { message: `mode 只能是 ${ADMINISTRATOR_STATE_MODES.join(' / ')}` });
    }
    return failure('invalid_request', { message: '管理员 id 必须是 uuid（admin_accounts.id）' });
  }
  // fetch 注入点：照 `account-suspend-api.mjs` 的既有写法，没传 `fetchImpl` 就回落到
  // `globalThis.fetch`（视图从来不传 `fetchImpl`）。**两者都没有**才是「这个环境没有 fetch」——
  // 首版在这里只认 `fetchImpl`，于是页面上点「停用／恢复」永远只显示这句话，整片不可达。
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return failure('network_error', { message: '当前环境没有可用的 fetch' });
  }
  if (typeof token !== 'string' || token.trim() === '') {
    return failure('signed_out', { message: '没有后台会话令牌' });
  }
  const problem = reasonProblem(reason);
  if (problem !== null) return failure('invalid_request', { message: problem, requestUrl });
  const ifMatch = etagForRevision(revision);
  if (ifMatch === null || !IF_MATCH_RE.test(ifMatch)) {
    return failure('invalid_request', {
      message: 'If-Match 必须是正整数 revision（页面是否读了目录项的 revision？）',
      requestUrl,
    });
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < IDEMPOTENCY_KEY_MIN_LENGTH) {
    return failure('idempotency_key_required', {
      message: `缺少幂等键（契约 IdempotencyKey 最短 ${IDEMPOTENCY_KEY_MIN_LENGTH} 字符）`,
      requestUrl,
    });
  }
  if (idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return failure('invalid_request', {
      message: `幂等键超出契约上限 ${IDEMPOTENCY_KEY_MAX_LENGTH} 字符`,
      requestUrl,
    });
  }

  const sentHeaders = { 'if-match': ifMatch, 'idempotency-key': idempotencyKey };
  const init = {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
      ...sentHeaders,
    },
    credentials: 'omit',
    body: JSON.stringify({ reason }),
  };
  if (signal !== undefined) init.signal = signal;

  let response;
  try {
    response = await doFetch(requestUrl, init);
  } catch {
    // 请求可能已经到达服务端：不谎称"没生效"，但也不谎称"已生效"。重试请复用同一幂等键。
    return failure('network_error', {
      requestUrl,
      sentHeaders,
      message: '网络异常：请求是否到达服务端未知（重试请复用同一幂等键）',
    });
  }

  const status = response !== null && response !== undefined && typeof response.status === 'number' ? response.status : 0;
  const succeeded = response?.ok === true || (status >= 200 && status < 300);
  const parsed = await readJson(response);
  const requestId = readRequestId(parsed.value);

  if (succeeded) {
    if (!parsed.ok) {
      return failure('invalid_response', { status, requestUrl, sentHeaders, message: '响应不是合法 JSON' });
    }
    const envelope = readStateEnvelope(parsed.value);
    if (envelope === null) {
      return failure('invalid_response', { status, requestUrl, sentHeaders, message: '响应信封缺少 data 或 meta' });
    }
    const checked = validateAdministratorStateView(envelope.data);
    if (!checked.ok) {
      return failure('invalid_response', {
        status,
        requestUrl,
        sentHeaders,
        message: `响应不符合 AdminAccountStateView：${checked.errors.join('；')}`,
      });
    }
    const data = checked.item;
    const headerEtag = readHeader(response, 'etag');
    return {
      ok: true,
      status,
      requestUrl,
      mode,
      id: data.id,
      state: data.state,
      revision: data.revision,
      authEpoch: data.auth_epoch,
      revokedSessions: data.revoked_sessions,
      changed: data.changed,
      etag: headerEtag !== null && IF_MATCH_RE.test(headerEtag) ? headerEtag : etagForRevision(data.revision),
      requestId,
      sentHeaders,
      warnings: checked.warnings,
    };
  }

  const envelope = readErrorEnvelope(parsed.ok ? parsed.value : null);
  // 只认服务端**字面**声明的 boolean：`ErrorBody.retryable` 是契约必填项，
  // 缺字段（或信封不成形）说明不是契约响应，这时留 null 交给本地闭集判断，别替服务端表态。
  const declaredRetryable = parsed.ok && typeof parsed.value?.error?.retryable === 'boolean'
    ? parsed.value.error.retryable
    : null;
  const retryAfter = readHeader(response, 'retry-after');
  const retryAfterSeconds = retryAfter === null ? null : Number(retryAfter);
  return failure(classifyAdministratorStateFailure(status, envelope?.code ?? null), {
    status,
    code: envelope?.code ?? null,
    inContract: envelope?.inContract ?? false,
    requestUrl,
    requestId,
    sentHeaders,
    retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
    // 服务端自己的 `retryable` 声明：原样带出来，页面据此决定给不给「重试」。
    // 后端每条 503 都显式 `retryable:false`，此时再给重试按钮就是必然无效的一次点击。
    serverRetryable: declaredRetryable,
    message: envelope?.message || `请求失败（HTTP ${status}）`,
  });
}

/**
 * 失败 → 视图用的中文说明（`title` 一句话 + `detail` 细节 + 可重试/可重载布尔）。
 *
 * 只做**文案映射**，不改 `kind`：错误码仍由 `WriteReceipt` 原样显示（含契约外码）。
 * ⓘ 恢复**不会**复活被撤销的会话、也不会恢复被撤销的 scope —— 这里的文案不得暗示相反。
 */
export function describeAdministratorStateFailure(result) {
  const value = isPlainObject(result) ? result : {};
  const kind = typeof value.kind === 'string' ? value.kind : 'http_error';
  const code = typeof value.code === 'string' && value.code !== '' ? value.code : null;
  const status = typeof value.status === 'number' ? value.status : null;
  const codeText = code === null ? '服务端未返回错误码' : `${code}${value.inContract === false ? '（契约外码）' : ''}`;
  const detail = `${codeText}${status === null ? '' : `（HTTP ${status}）`}${typeof value.message === 'string' && value.message !== '' ? ` · ${value.message}` : ''}`;
  // 可重试性：**服务端声明优先**，与 `admin-api.mjs` 的 `serverAllowsRetry` 同序
  // （`true` 就是 `true`、`false` 就是 `false`）；只有一个字节都没发出去 / 网络失败（没有响应，
  // `serverRetryable` 为 null 或缺失）才回落到按 `kind` 的本地闭集 `retriable`。
  // 差别只在本地闭集含 `in_progress`：写面带幂等键，同一幂等键重放不会二次生效，重试是安全的。
  const declaredRetryable = value.serverRetryable ?? value.declaredRetryable;
  const canRetry = typeof declaredRetryable === 'boolean' ? declaredRetryable : value.retriable === true;
  const base = { kind, code, status, detail, canRetry, canReload: false, canSignIn: false };

  switch (kind) {
    case 'self_disable_denied':
      return { ...base, title: '不能停用自己（自锁门拒绝）' };
    case 'last_scope_manager':
      return { ...base, title: '会使有效持有 scopes:write 的管理员归零，需先给他人授权' };
    case 'revision_conflict':
      return { ...base, title: '该行已被别处改过，重新加载后再试', canReload: true };
    case 'revision_required':
      return {
        ...base,
        title: '这次请求缺少版本号（不应发生，属缺陷）',
        detail: `${detail} · 页面没有读到该行 revision 就发了请求：这是前端缺陷，不是重试能解决的`,
        canReload: true,
      };
    case 'signed_out':
      return { ...base, title: '后台会话已失效，需要重新登录', canSignIn: true };
    case 'forbidden':
      return { ...base, title: '当前后台会话没有 scopes:write，不能改管理员状态' };
    case 'idempotency_conflict':
      return { ...base, title: '同一幂等键被用于不同的请求体，服务端拒绝了这次重放' };
    case 'idempotency_key_required':
      return { ...base, title: '这次请求缺少幂等键（不应发生，属缺陷）' };
    case 'in_progress':
      return { ...base, title: '同一幂等键的请求还在处理中，稍后用同一幂等键重试' };
    case 'not_found':
      return { ...base, title: '该管理员不存在（可能已被删除），刷新目录后再确认', canReload: true };
    case 'unavailable':
      return { ...base, title: '服务端暂时不可用，本次状态未知' };
    case 'rate_limited':
      return { ...base, title: '请求过于频繁，稍后再试' };
    case 'invalid_request':
      return { ...base, title: '请求不合法（理由或版本号不合契约）' };
    case 'invalid_response':
      return { ...base, title: '服务端响应不符合契约，无法确认是否生效', canReload: true };
    case 'network_error':
      return { ...base, title: '网络异常，请求是否到达服务端未知' };
    default:
      return { ...base, title: `停用／恢复失败（${codeText}）` };
  }
}
