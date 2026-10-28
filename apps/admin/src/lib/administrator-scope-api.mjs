/**
 * R68 · 管理员 scope「授权／撤销」写面 HTTP 客户端。
 *
 * 契约（`packages/contracts/openapi.json`）：
 *  - `POST   /admin/administrators/{id}/scopes`         — `operationId: grantAdministratorScope`
 *  - `DELETE /admin/administrators/{id}/scopes/{scope}` — `operationId: revokeAdministratorScope`
 *  两者都要求 `If-Match`（比对 `admin_accounts.revision`）、`Idempotency-Key` 与理由，
 *  门沿用 `scopes:write`，200 返回 `AdminScopeWriteViewEnvelope {id, revision, scopes, changed}`。
 *
 * ⛔ 与「停用／恢复」（`administrator-state-api.mjs`）是两条不同的写面：那条改账号状态并撤销会话，
 * 这条改**权限**。停用 ≠ 撤销 scope，恢复也不会把 scope 还回来（裁定④：自助撤销允许，
 * 但会受 `LAST_SCOPE_MANAGER` 自锁门保护）。
 *
 * 纯函数 + 可注入 `fetchImpl`，返回 `{ok:true,...}` / `{ok:false, kind, ...}`，**不抛异常**。
 * scope 闭集来自 `admin-scope-catalog.mjs`（从契约 `AdminScope.enum` 派生），
 * 不在本文件、也不在视图里手抄第二份清单。
 */
import { normalizeBaseUrl } from './admin-api.mjs';
import { isPlainObject, readErrorEnvelope } from './admin-contract.mjs';
import { ADMINISTRATORS_PATH, isAdministratorId } from './admin-administrators.mjs';
import { ADMIN_SCOPES, isKnownAdminScope, scopeProblem } from './admin-scope-catalog.mjs';
import { newIdempotencyKey } from './administrator-state-api.mjs';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IF_MATCH_RE,
  etagForRevision,
  isRetriable,
  reasonProblem,
} from './account-suspend-api.mjs';

/** 两条写面在 `operations.json` 里挂的 scope（与停用／恢复同一道门）。 */
export const ADMINISTRATOR_SCOPE_WRITE_SCOPE = 'scopes:write';

/** 契约里只有两个方向：`grant` 授权、`revoke` 撤销。 */
export const ADMINISTRATOR_SCOPE_MODES = Object.freeze(['grant', 'revoke']);

export const ADMINISTRATOR_SCOPE_MODE_LABELS = Object.freeze({ grant: '授权', revoke: '撤销' });

/** `AdminScopeWriteView` 的字段集（`additionalProperties: false`；⛔ 没有 granted_by / granted_at）。 */
const SCOPE_WRITE_VIEW_KEYS = Object.freeze(['id', 'revision', 'scopes', 'changed']);

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

/** 失败对象（与 `administrator-state-api.mjs` 同形状：`kind` 决定本地 `retriable`）。 */
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
    details: [],
    ...extra,
  };
}

/**
 * 拼授权 URL：`{base}/admin/administrators/{id}/scopes`。
 * 非法 id 返回 `null`（与停用／恢复同一条约定：可算错的输入不抛异常，交给调用方落 `invalid_request`）。
 * @param {string} baseUrl
 * @param {string} administratorId 管理员 id（`admin_accounts.id`，uuid）
 * @returns {string|null}
 */
export function buildAdministratorScopeGrantUrl(baseUrl, administratorId) {
  if (!isAdministratorId(administratorId)) return null;
  return `${normalizeBaseUrl(baseUrl)}${ADMINISTRATORS_PATH}/${encodeURIComponent(administratorId)}/scopes`;
}

/**
 * 拼撤销 URL：`{base}/admin/administrators/{id}/scopes/{scope}`。
 * scope 必须在契约闭集内（闭集外的值拼进路径只会换来 400 INVALID_REQUEST，⛔ 不要发）。
 * @param {string} baseUrl
 * @param {string} administratorId
 * @param {string} scope 契约 `AdminScope` 成员
 * @returns {string|null}
 */
export function buildAdministratorScopeRevokeUrl(baseUrl, administratorId, scope) {
  if (!isAdministratorId(administratorId)) return null;
  if (!isKnownAdminScope(scope)) return null;
  return `${normalizeBaseUrl(baseUrl)}${ADMINISTRATORS_PATH}/${encodeURIComponent(administratorId)}/scopes/${encodeURIComponent(scope)}`;
}

/**
 * 这一行能不能发授／撤请求：id 是 uuid + revision 是正整数（`If-Match` 的唯一来源）+ 目标 active。
 *
 * 为什么要求 active：契约对非 active 目标一律 409 `OBJECT_UNAVAILABLE`（`retryable:false`）——
 * 停用账号先恢复再去改权限，按钮不该在这一行上出现。
 * scope 的选择在视图侧另判（`scopeProblem`）——它来自选择器，不属于行属性。
 * @param {{id?:unknown, revision?:unknown, state?:unknown}|null|undefined} row
 * @param {'grant'|'revoke'} mode
 * @returns {boolean}
 */
export function canWriteAdministratorScope(row, mode) {
  if (!isPlainObject(row)) return false;
  if (!ADMINISTRATOR_SCOPE_MODES.includes(mode)) return false;
  if (row.state !== 'active') return false;
  if (!isAdministratorId(row.id)) return false;
  return typeof row.revision === 'number' && Number.isSafeInteger(row.revision) && row.revision >= 1;
}

/** 响应头读取（`Headers` 或普通对象都认）。 */
function readHeader(response, name) {
  const headers = response === null || response === undefined ? null : response.headers;
  if (headers === null || headers === undefined) return null;
  const value = typeof headers.get === 'function' ? headers.get(name) : headers[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** `meta.request_id`（审计关联键）。 */
function readRequestId(body) {
  const meta = isPlainObject(body) ? body.meta : null;
  if (!isPlainObject(meta)) return null;
  return typeof meta.request_id === 'string' && meta.request_id !== '' ? meta.request_id : null;
}

/**
 * `ErrorBody.details`（契约 `[{path, problem}]`）：⛔ 不吞。
 * `400 INVALID_REQUEST` 的可读性全在这些条目里（`readErrorEnvelope` 只带 code/message）。
 * @returns {Array<string>}
 */
function readErrorDetails(body) {
  const error = isPlainObject(body) ? body.error : null;
  if (!isPlainObject(error) || !Array.isArray(error.details)) return [];
  const out = [];
  for (const item of error.details) {
    if (!isPlainObject(item)) continue;
    const path = typeof item.path === 'string' && item.path !== '' ? item.path : '$';
    const problem = typeof item.problem === 'string' ? item.problem : '';
    if (problem !== '') out.push(`${path}：${problem}`);
  }
  return out;
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
 * 校验一个 `AdminScopeWriteView`（`additionalProperties: false`）。
 * `revision` 是**改动后**的 revision，可直接当下一发 `If-Match`；`scopes` 必须逐项落在契约闭集内。
 * @returns {{ok:boolean, errors:Array<string>, warnings:Array<string>, item:object|null}}
 */
export function validateAdministratorScopeWriteView(value) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ['$：权限写入视图必须是对象'], warnings, item: null };
  }
  if (!isAdministratorId(value.id)) pushIssue(errors, '$.id', '必须是 uuid（admin_accounts.id）');
  if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    pushIssue(errors, '$.revision', '必须是正整数（改动后的 admin_accounts.revision）');
  }
  if (!Array.isArray(value.scopes)) {
    pushIssue(errors, '$.scopes', '必须是数组');
  } else {
    if (value.scopes.length > 20) pushIssue(errors, '$.scopes', '最多 20 项');
    value.scopes.forEach((scope, index) => {
      if (typeof scope !== 'string') pushIssue(errors, `$.scopes[${index}]`, '必须是字符串');
      else if (!isKnownAdminScope(scope)) pushIssue(errors, `$.scopes[${index}]`, `${scope} 不在 AdminScope 闭集里`);
    });
  }
  if (typeof value.changed !== 'boolean') pushIssue(errors, '$.changed', '必须是布尔值');
  for (const key of Object.keys(value)) {
    if (!SCOPE_WRITE_VIEW_KEYS.includes(key)) warnings.push(`$.${key}：契约外字段（additionalProperties: false）`);
  }
  if (errors.length > 0) return { ok: false, errors, warnings, item: null };
  return { ok: true, errors, warnings, item: value };
}

/**
 * HTTP 状态＋错误码 → 前端分支（`kind`）。
 *
 * 顺序有讲究：两条**门**先判 —— `SELF_SCOPE_GRANT_DENIED`（不能给自己授，403）与
 * `LAST_SCOPE_MANAGER`（撤了会让 `scopes:write` 有效持有人归零，409）。后者若落到通用
 * 修订冲突分支，会把「自锁门拒绝」说成「被人改过」，用户会去点重试而不是去找人授权。
 *
 * @param {number|null} status
 * @param {string|null} code
 * @returns {string}
 */
export function classifyAdministratorScopeFailure(status, code = null) {
  if (code === 'SELF_SCOPE_GRANT_DENIED') return 'self_scope_grant_denied';
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
 * 本地前置拦截（一个字节都不发出去）：token / 理由 / If-Match / 幂等键。
 * `fetchImpl` 的注入点**留在每个公开函数体内**（`doFetch(...)` 必须就写在发请求的那个函数里：
 * 能力图工具按「函数自己的 fetch 调用点」判 UI 入口，藏进 helper 就会判成无入口）。
 * @returns {{problem:null, ifMatch:string, reason:string, sentHeaders:object}|{problem:object}}
 */
function preflight({ token, reason, revision, idempotencyKey, requestUrl }) {
  if (typeof token !== 'string' || token.trim() === '') {
    return { problem: failure('signed_out', { message: '没有后台会话令牌' }) };
  }
  // 理由先 trim 再判：全空白（`"   "`）在契约 `minLength: 1` 下「合法」，但它只会往审计里塞一条
  // 读不出意思的记录 —— 本地就拦掉，别等服务端或审计事后发现。
  const trimmedReason = typeof reason === 'string' ? reason.trim() : reason;
  const reasonIssue = reasonProblem(trimmedReason);
  if (reasonIssue !== null) return { problem: failure('invalid_request', { message: reasonIssue, requestUrl }) };
  const ifMatch = etagForRevision(revision);
  if (ifMatch === null || !IF_MATCH_RE.test(ifMatch)) {
    return {
      problem: failure('invalid_request', {
        message: 'If-Match 必须是正整数 revision（页面是否读了目录项的 revision？）',
        requestUrl,
      }),
    };
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < IDEMPOTENCY_KEY_MIN_LENGTH) {
    return {
      problem: failure('idempotency_key_required', {
        message: `缺少幂等键（契约 IdempotencyKey 最短 ${IDEMPOTENCY_KEY_MIN_LENGTH} 字符）`,
        requestUrl,
      }),
    };
  }
  if (idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return {
      problem: failure('invalid_request', {
        message: `幂等键超出契约上限 ${IDEMPOTENCY_KEY_MAX_LENGTH} 字符`,
        requestUrl,
      }),
    };
  }
  return {
    problem: null,
    ifMatch,
    reason: trimmedReason,
    sentHeaders: { 'if-match': ifMatch, 'idempotency-key': idempotencyKey },
  };
}

/**
 * 把一次响应收成 `{ok:true,...}` / `{ok:false, kind, ...}`（成功与失败共用，不抛异常）。
 * @param {{response:unknown, parsed:object, status:number, succeeded:boolean, requestUrl:string, sentHeaders:object, mode:string, scope:string}} input
 */
function readScopeWriteOutcome({ response, parsed, status, succeeded, requestUrl, sentHeaders, mode, scope }) {
  const requestId = readRequestId(parsed.value);
  if (succeeded) {
    if (!parsed.ok) {
      return failure('invalid_response', { status, requestUrl, sentHeaders, message: '响应不是合法 JSON' });
    }
    const envelope = isPlainObject(parsed.value) && isPlainObject(parsed.value.data) && isPlainObject(parsed.value.meta)
      ? parsed.value.data
      : null;
    if (envelope === null) {
      return failure('invalid_response', { status, requestUrl, sentHeaders, message: '响应信封缺少 data 或 meta' });
    }
    const checked = validateAdministratorScopeWriteView(envelope);
    if (!checked.ok) {
      return failure('invalid_response', {
        status,
        requestUrl,
        sentHeaders,
        message: `响应不符合 AdminScopeWriteView：${checked.errors.join('；')}`,
      });
    }
    const data = checked.item;
    const headerEtag = readHeader(response, 'etag');
    return {
      ok: true,
      status,
      requestUrl,
      mode,
      scope,
      id: data.id,
      revision: data.revision,
      scopes: [...data.scopes],
      changed: data.changed,
      etag: headerEtag !== null && IF_MATCH_RE.test(headerEtag) ? headerEtag : etagForRevision(data.revision),
      requestId,
      sentHeaders,
      warnings: checked.warnings,
    };
  }

  const errorEnvelope = readErrorEnvelope(parsed.ok ? parsed.value : null);
  const declaredRetryable = parsed.ok && typeof parsed.value?.error?.retryable === 'boolean'
    ? parsed.value.error.retryable
    : null;
  const retryAfter = readHeader(response, 'retry-after');
  const retryAfterSeconds = retryAfter === null ? null : Number(retryAfter);
  const details = readErrorDetails(parsed.ok ? parsed.value : null);
  return failure(classifyAdministratorScopeFailure(status, errorEnvelope?.code ?? null), {
    status,
    code: errorEnvelope?.code ?? null,
    inContract: errorEnvelope?.inContract ?? false,
    requestUrl,
    requestId,
    sentHeaders,
    retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
    serverRetryable: declaredRetryable,
    details,
    message: errorEnvelope?.message || `请求失败（HTTP ${status}）`,
  });
}

/**
 * 授一条 scope：`POST /admin/administrators/{id}/scopes`，body `{scope, reason}`。
 *
 * scope **先**过契约闭集校验：闭集外直接 `invalid_request` 且一个字节都不发
 * （发出去只会换来 400 INVALID_REQUEST，还要白占一次幂等键）。
 *
 * 成功：`{ok:true, status, requestUrl, mode:'grant', scope, id, revision, scopes, changed, etag, requestId, sentHeaders}`
 * 失败：`{ok:false, kind, retriable, status, code, inContract, message, details, requestUrl, ...}`
 *
 * `changed:false` 同样是成功（服务端幂等短路：同键同体重放、或该 scope 本来就在），视图据此显示
 * 「已受理（未产生变更）」而不是报错。
 *
 * @param {{fetchImpl?:Function, baseUrl?:string, token?:string, administratorId?:string, scope?:string,
 *   revision?:number, reason?:string, idempotencyKey?:string, signal?:AbortSignal}} input
 */
export async function grantAdministratorScope({
  fetchImpl = undefined,
  baseUrl = '',
  token = '',
  administratorId = '',
  scope = '',
  revision = 0,
  reason = '',
  idempotencyKey = '',
  signal = undefined,
} = {}) {
  // ---- 本地前置拦截（一个字节都不发出去）
  const scopeIssue = scopeProblem(scope);
  if (scopeIssue !== null) return failure('invalid_request', { message: scopeIssue });
  const requestUrl = buildAdministratorScopeGrantUrl(baseUrl, administratorId);
  if (requestUrl === null) {
    return failure('invalid_request', { message: '管理员 id 必须是 uuid（admin_accounts.id）' });
  }
  // fetch 注入点：没传 `fetchImpl` 就回落到 `globalThis.fetch`（视图从来不传 `fetchImpl`）。
  // **两者都没有**才是「这个环境没有 fetch」——只认 `fetchImpl` 会让整片写面在页面上永远不可达。
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return failure('network_error', { message: '当前环境没有可用的 fetch' });
  }
  const ready = preflight({ token, reason, revision, idempotencyKey, requestUrl });
  if (ready.problem !== null) return ready.problem;

  const init = {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
      ...ready.sentHeaders,
    },
    credentials: 'omit',
    body: JSON.stringify({ scope, reason: ready.reason }),
  };
  if (signal !== undefined) init.signal = signal;

  let response;
  try {
    response = await doFetch(requestUrl, init);
  } catch {
    return failure('network_error', {
      requestUrl,
      sentHeaders: ready.sentHeaders,
      message: '网络异常：请求是否到达服务端未知（重试请复用同一幂等键）',
    });
  }
  const status = response !== null && response !== undefined && typeof response.status === 'number' ? response.status : 0;
  const parsed = await readJson(response);
  return readScopeWriteOutcome({
    response,
    parsed,
    status,
    succeeded: response?.ok === true || (status >= 200 && status < 300),
    requestUrl,
    sentHeaders: ready.sentHeaders,
    mode: 'grant',
    scope,
  });
}

/**
 * 撤一条 scope：`DELETE /admin/administrators/{id}/scopes/{scope}`，body `{reason}`。
 *
 * 自撤是允许的（裁定④），但撤掉最后一名 `scopes:write` 有效持有人会被 409 `LAST_SCOPE_MANAGER` 拒；
 * 撤一条本来就没有的 scope 是幂等空操作（`changed:false`，不写审计、不推 revision）。
 *
 * @param {{fetchImpl?:Function, baseUrl?:string, token?:string, administratorId?:string, scope?:string,
 *   revision?:number, reason?:string, idempotencyKey?:string, signal?:AbortSignal}} input
 */
export async function revokeAdministratorScope({
  fetchImpl = undefined,
  baseUrl = '',
  token = '',
  administratorId = '',
  scope = '',
  revision = 0,
  reason = '',
  idempotencyKey = '',
  signal = undefined,
} = {}) {
  const scopeIssue = scopeProblem(scope);
  if (scopeIssue !== null) return failure('invalid_request', { message: scopeIssue });
  const requestUrl = buildAdministratorScopeRevokeUrl(baseUrl, administratorId, scope);
  if (requestUrl === null) {
    return failure('invalid_request', { message: '管理员 id 必须是 uuid（admin_accounts.id）' });
  }
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return failure('network_error', { message: '当前环境没有可用的 fetch' });
  }
  const ready = preflight({ token, reason, revision, idempotencyKey, requestUrl });
  if (ready.problem !== null) return ready.problem;

  const init = {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
      ...ready.sentHeaders,
    },
    credentials: 'omit',
    body: JSON.stringify({ reason: ready.reason }),
  };
  if (signal !== undefined) init.signal = signal;

  let response;
  try {
    response = await doFetch(requestUrl, init);
  } catch {
    return failure('network_error', {
      requestUrl,
      sentHeaders: ready.sentHeaders,
      message: '网络异常：请求是否到达服务端未知（重试请复用同一幂等键）',
    });
  }
  const status = response !== null && response !== undefined && typeof response.status === 'number' ? response.status : 0;
  const parsed = await readJson(response);
  return readScopeWriteOutcome({
    response,
    parsed,
    status,
    succeeded: response?.ok === true || (status >= 200 && status < 300),
    requestUrl,
    sentHeaders: ready.sentHeaders,
    mode: 'revoke',
    scope,
  });
}

/**
 * 失败 → 视图用的中文说明（`title` 一句话 + `detail` 细节 + 可重试/可重载布尔）。
 * 只做**文案映射**，不改 `kind`：错误码与 `details` 原样上屏（含契约外码）。
 * @param {object|null|undefined} result
 */
export function describeAdministratorScopeFailure(result) {
  const value = isPlainObject(result) ? result : {};
  const kind = typeof value.kind === 'string' ? value.kind : 'http_error';
  const code = typeof value.code === 'string' && value.code !== '' ? value.code : null;
  const status = typeof value.status === 'number' ? value.status : null;
  const codeText = code === null ? '服务端未返回错误码' : `${code}${value.inContract === false ? '（契约外码）' : ''}`;
  const details = Array.isArray(value.details) && value.details.length > 0 ? ` · ${value.details.join('；')}` : '';
  const detail = `${codeText}${status === null ? '' : `（HTTP ${status}）`}${typeof value.message === 'string' && value.message !== '' ? ` · ${value.message}` : ''}${details}`;
  const declaredRetryable = value.serverRetryable ?? value.declaredRetryable;
  const canRetry = typeof declaredRetryable === 'boolean' ? declaredRetryable : value.retriable === true;
  const base = { kind, code, status, detail, canRetry, canReload: false, canSignIn: false };

  switch (kind) {
    case 'self_scope_grant_denied':
      return { ...base, title: '不能给自己授权（自锁门拒绝）', canRetry: false };
    case 'last_scope_manager':
      return { ...base, title: '撤了会让有效持有 scopes:write 的管理员归零，需先给他人授权', canRetry: false };
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
      return { ...base, title: '当前后台会话没有 scopes:write，不能改管理员权限' };
    case 'idempotency_conflict':
      return { ...base, title: '同一幂等键被用于不同的请求体，服务端拒绝了这次重放' };
    case 'idempotency_key_required':
      return { ...base, title: '这次请求缺少幂等键（不应发生，属缺陷）' };
    case 'in_progress':
      return { ...base, title: '同一幂等键的请求还在处理中，稍后用同一幂等键重试' };
    case 'not_found':
      return { ...base, title: '该管理员不存在（可能已被删除），刷新目录后再确认', canReload: true };
    case 'unavailable':
      return { ...base, title: '服务端暂时不可用，本次权限变更是否生效未知' };
    case 'rate_limited':
      return { ...base, title: '请求过于频繁，稍后再试' };
    case 'invalid_request':
      return { ...base, title: '请求不合法（scope 不在契约闭集 / 理由或版本号不合契约）' };
    case 'invalid_response':
      return { ...base, title: '服务端响应不符合契约，无法确认是否生效', canReload: true };
    case 'network_error':
      return { ...base, title: '网络异常，请求是否到达服务端未知' };
    default:
      return { ...base, title: `授权／撤销失败（${codeText}）` };
  }
}

/** 闭集项数（视图说明文字用；⛔ 不要在模板里写死 13）。 */
export const ADMIN_SCOPE_COUNT = ADMIN_SCOPES.length;

/** 复用停用／恢复的幂等键形状，不另造一份。 */
export { newIdempotencyKey };
