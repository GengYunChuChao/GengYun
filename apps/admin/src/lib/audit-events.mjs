/**
 * 审计事件只读页（B5）契约常量、响应形状校验、失败分类与展示状态机——
 * 纯 ESM，无 Vue／DOM 依赖，可用假 fetch 注入测试。
 *
 * ## 事实来源（逐条可核，不自行发明字段）
 * - `packages/contracts/openapi.json:10544-10589`：`GET /admin/audit-events`
 *   （operationId `listAuditEvents`），参数**只有** `Cursor` / `Limit`，
 *   200 返回 `AuditEventPageEnvelope`（`data.items` + `data.next_cursor`）。
 *   ⇒ **没有** `event_type`、`actor`、时间范围之类的过滤参数；筛选只能在已加载行内做。
 * - `packages/contracts/openapi.json:14474-14534`：`AuditEvent` 为
 *   `additionalProperties: false`，8 个必填字段
 *   `id / action / scope / target_ref / reason_code / request_id / result / created_at`。
 * - `packages/contracts/openapi.json:16323-16367`：`AuditEventPage`（maxItems 50）与信封。
 * - `packages/contracts/openapi.json:11165-11205`：`TargetRef` = `{type, id, revision}`，
 *   `type` 为 17 项闭集，`revision` 为 integer >= 1。
 *
 * ## R29-S5 起：主体与前后值不再是缺口
 * `AuditEvent` 原有 8 个必填字段（`AUDIT_EVENT_FIELDS`），本片追加 4 个**可选且可空**字段
 * （`AUDIT_TRAIL_FIELDS`：`actor` / `target_hint` / `before_value` / `after_value`）。
 * 于是页面能直接显示「谁在什么时候把开关从 A 改成 B」；历史行没有 actor 时如实显示
 * 「未提供（历史行/服务端未记主体）」，**不**从 `request_id` 反推责任人。
 *
 * ## 与 `admin-api.mjs` 的关系
 * 失败分类与 `fetchAccountsPage` 同形（同一套 `ErrorCode` 与 HTTP 状态口径），
 * 但 403 的 scope 文案是 `audit:read`、400 `INVALID_CURSOR` 的文案是"审计台账已变化"。
 * 两处映射**有意分开写**：文案里出现的 scope 必须是本接口真实要求的 scope，
 * 复用一份带 `accounts:read` 字样的说明会直接误导操作者。
 */
import { CURSOR_MAX_LENGTH, LIMIT_DEFAULT, isPlainObject, readErrorEnvelope, readPageEnvelope } from './admin-contract.mjs';
import { clampLimit, isRetriable, normalizeBaseUrl } from './admin-api.mjs';

/** 审计事件路径（相对 API 基地址）。 */
export const AUDIT_EVENTS_PATH = '/admin/audit-events';

/** 读取审计台账所需 scope（契约 `x-scope: audit:read`，见 routes/admin.ts:255-259 的守卫）。 */
export const AUDIT_SCOPE = 'audit:read';

/** 页面可选的 `limit`（契约边界 1..50，默认 20）。 */
export const AUDIT_LIMIT_OPTIONS = Object.freeze([LIMIT_DEFAULT, 50]);

/** 契约 `AuditEvent` 的 8 个字段（顺序同 openapi.json）。 */
export const AUDIT_EVENT_FIELDS = Object.freeze([
  'id',
  'action',
  'scope',
  'target_ref',
  'reason_code',
  'request_id',
  'result',
  'created_at',
]);

/** `before_value` / `after_value` 的共同形状（契约 `FlagReading`）。 */
const FLAG_READING_FIELDS = Object.freeze(['before_value', 'after_value']);

/**
 * R29-S5 给 `AuditEvent` 追加的 4 个**可选且可空**字段（`openapi.json` 里都不在 `required`）：
 * - `actor`：谁做的（uuid；历史行的内部 actor 曾被 `projectAuditEvent()` 剥掉，故可能为 null）
 * - `target_hint`：目标的人读标识（开关行是 `flag:<key>`；`TargetRef.type` 没有 flag 成员）
 * - `before_value` / `after_value`：变更前后值（`FlagReading` = `{enabled, revision}`；非开关行为 null）
 *
 * 为什么单列一个常量而不是并进 `AUDIT_EVENT_FIELDS`：后者是**必填**字段的钉子
 * （`admin-ui-audit-contract.test.mjs` 逐项比对 `required`），混进来会让"可选"看起来像"必有"。
 */
export const AUDIT_TRAIL_FIELDS = Object.freeze(['actor', 'target_hint', 'before_value', 'after_value']);

/** 契约 `AuditEvent.result` 闭集。 */
export const AUDIT_RESULTS = Object.freeze(['accepted', 'denied', 'failed']);

/** 结果 → 中文标签（只翻译，不改变含义）。 */
export const AUDIT_RESULT_LABELS = Object.freeze({
  accepted: '已接受',
  denied: '已拒绝',
  failed: '失败',
});

/** 结果 → 视觉语气（只影响样式）。 */
export const AUDIT_RESULT_TONES = Object.freeze({
  accepted: 'ok',
  denied: 'warn',
  failed: 'danger',
});

/** 契约 `TargetRef.type` 闭集（`audit.ts` 已注明它**不含** category/account/flag，故 target_ref 常为 null）。 */
export const TARGET_REF_TYPES = Object.freeze([
  'species',
  'herbicide',
  'scheme',
  'static_region',
  'recognition',
  'ocr',
  'transcription',
  'answer',
  'post',
  'comment',
  'conversation', 'conversation_turn',
  'dose_card',
  'media',
  'synthesis',
  'job',
  'source',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isPlainString(value) {
  return typeof value === 'string';
}

/**
 * 校验一行 `AuditEvent`。
 *
 * - `errors`：违反 required／type／enum ⇒ 整个响应不可信（调用方判畸形，不渲染半行）。
 * - `warnings`：只违反数值范围／格式（uuid 形态、长度、`target_ref.type` 闭集之外的值）
 *   ⇒ 行仍可渲染；`additionalProperties: false` 的多余字段同样只记 warning 并丢弃。
 */
export function validateAuditEvent(value) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(value)) {
    errors.push({ path: '$', problem: '不是对象' });
    return { ok: false, errors, warnings };
  }

  if (!isNonEmptyString(value.id)) {
    errors.push({ path: '$.id', problem: '缺少字符串 id' });
  } else if (!UUID_RE.test(value.id)) {
    warnings.push({ path: '$.id', problem: '不符合契约 uuid 格式' });
  }

  if (!isNonEmptyString(value.action)) {
    errors.push({ path: '$.action', problem: '缺少非空 action（事件类型）' });
  } else if (value.action.length > 80) {
    warnings.push({ path: '$.action', problem: `长度 ${value.action.length} 超出契约上限 80` });
  }

  if (!isNonEmptyString(value.scope)) {
    errors.push({ path: '$.scope', problem: '缺少非空 scope' });
  } else if (value.scope.length > 80) {
    warnings.push({ path: '$.scope', problem: `长度 ${value.scope.length} 超出契约上限 80` });
  }

  if (value.target_ref === null) {
    // 契约允许 null（TargetRef.type 闭集里没有 category/account/flag，见 audit.ts 缺口说明）。
  } else if (!isPlainObject(value.target_ref)) {
    errors.push({ path: '$.target_ref', problem: '只能是对象或 null' });
  } else {
    const target = value.target_ref;
    if (!isNonEmptyString(target.type)) {
      errors.push({ path: '$.target_ref.type', problem: '缺少非空 type' });
    } else if (!TARGET_REF_TYPES.includes(target.type)) {
      warnings.push({ path: '$.target_ref.type', problem: `type 不在契约闭集：${target.type}` });
    }
    if (!isNonEmptyString(target.id)) {
      errors.push({ path: '$.target_ref.id', problem: '缺少非空 id' });
    }
    if (typeof target.revision !== 'number' || !Number.isInteger(target.revision)) {
      errors.push({ path: '$.target_ref.revision', problem: '缺少整数 revision' });
    } else if (target.revision < 1) {
      errors.push({ path: '$.target_ref.revision', problem: `revision 需 >= 1，实际 ${target.revision}` });
    }
    for (const key of Object.keys(target)) {
      if (key !== 'type' && key !== 'id' && key !== 'revision') {
        warnings.push({ path: `$.target_ref.${key}`, problem: '契约外字段（不展示、不推断含义）' });
      }
    }
  }

  if (!isNonEmptyString(value.reason_code)) {
    errors.push({ path: '$.reason_code', problem: '缺少非空 reason_code' });
  }

  if (!isNonEmptyString(value.request_id)) {
    errors.push({ path: '$.request_id', problem: '缺少非空 request_id' });
  } else if (!UUID_RE.test(value.request_id)) {
    warnings.push({ path: '$.request_id', problem: '不符合契约 uuid 格式' });
  }

  if (!isPlainString(value.result)) {
    errors.push({ path: '$.result', problem: '缺少字符串 result' });
  } else if (!AUDIT_RESULTS.includes(value.result)) {
    errors.push({ path: '$.result', problem: `result 不在契约 enum：${value.result}` });
  }

  if (!isPlainString(value.created_at)) {
    errors.push({ path: '$.created_at', problem: '缺少字符串 created_at' });
  } else if (Number.isNaN(Date.parse(value.created_at))) {
    warnings.push({ path: '$.created_at', problem: '不是可解析的 date-time（原样展示，不重排）' });
  }

  if (value.actor !== undefined && value.actor !== null) {
    if (!isPlainString(value.actor)) errors.push({ path: '$.actor', problem: 'actor 必须是字符串或 null' });
    else if (!UUID_RE.test(value.actor)) warnings.push({ path: '$.actor', problem: '不符合契约 uuid 格式' });
  }

  if (value.target_hint !== undefined && value.target_hint !== null) {
    if (!isNonEmptyString(value.target_hint)) {
      errors.push({ path: '$.target_hint', problem: 'target_hint 必须是非空字符串或 null' });
    } else if (value.target_hint.length > 200) {
      warnings.push({ path: '$.target_hint', problem: '超过契约 maxLength 200（原样展示）' });
    }
  }

  for (const field of FLAG_READING_FIELDS) {
    const reading = value[field];
    if (reading === undefined || reading === null) continue;
    if (!isPlainObject(reading)) {
      errors.push({ path: `$.${field}`, problem: `${field} 必须是对象或 null` });
      continue;
    }
    if (typeof reading.enabled !== 'boolean') {
      errors.push({ path: `$.${field}.enabled`, problem: '缺少布尔 enabled' });
    }
    if (!Number.isInteger(reading.revision) || reading.revision < 1) {
      errors.push({ path: `$.${field}.revision`, problem: '缺少整数 revision（>= 1）' });
    }
  }

  const known = new Set([...AUDIT_EVENT_FIELDS, ...AUDIT_TRAIL_FIELDS]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) warnings.push({ path: `$.${key}`, problem: '契约外字段（不展示、不推断含义）' });
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 校验一页 `AuditEventPage`（信封内 `data`）。
 *
 * 空 `items` + `null` 是**合法的空台账**：调用方不得把它当错误，
 * 也不得把它读成"审核通过/未通过"之类结论。
 */
export function validateAuditEventPage(value) {
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
    if (value.items.length > 50) {
      warnings.push({ path: '$.items', problem: `条目数 ${value.items.length} 超出契约 maxItems 50` });
    }
    value.items.forEach((item, index) => {
      const result = validateAuditEvent(item);
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

/**
 * 拼审计事件 URL。`limit` 总是显式带上（便于证据页复现），`cursor` 仅在续页时带。
 * 游标超过契约上限 2048 时抛 RangeError —— 宁可不发请求，也不发一个必然 400 的请求。
 */
export function buildAuditEventsUrl(baseUrl, options = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const limit = clampLimit(options.limit ?? LIMIT_DEFAULT);
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  const cursor = options.cursor;
  if (cursor !== null && cursor !== undefined) {
    if (typeof cursor !== 'string' || cursor.length === 0) throw new TypeError('cursor 必须是非空字符串');
    if (cursor.length > CURSOR_MAX_LENGTH) throw new RangeError(`cursor 超过契约上限 ${CURSOR_MAX_LENGTH} 字符`);
    params.set('cursor', cursor);
  }
  return `${base}${AUDIT_EVENTS_PATH}?${params.toString()}`;
}

/** 空集合：`items` 与游标都由服务端给，本地只负责去重与续页记账。 */
export function emptyAuditCollection() {
  return { items: [], nextCursor: null, seenIds: [], pages: 0, duplicates: 0, warnings: 0, cycle: false };
}

/**
 * 应用一页结果（纯函数，返回新集合），与账号目录同一套规则：
 * 按 `id` 去重；服务端把请求游标原样返回时置 `cycle: true` 且停止续页。
 */
export function appendAuditPage(collection, { cursor = null, page }) {
  const previous = collection ?? emptyAuditCollection();
  const seen = new Set(previous.seenIds);
  const items = previous.items.slice();
  let duplicates = previous.duplicates;

  for (const row of page.items) {
    if (seen.has(row.id)) {
      duplicates += 1;
      continue;
    }
    seen.add(row.id);
    items.push(row);
  }

  const nextCursor = page.nextCursor ?? null;
  const cycle = nextCursor !== null && cursor !== null && nextCursor === cursor;
  return {
    collection: {
      items,
      nextCursor: cycle ? null : nextCursor,
      seenIds: Array.from(seen),
      pages: previous.pages + 1,
      duplicates,
      // 只计数：契约外字段被丢弃而**不展示**，但要让操作者知道"响应里有多余字段"。
      warnings: (previous.warnings ?? 0) + (Array.isArray(page.warnings) ? page.warnings.length : 0),
      cycle,
    },
  };
}

function failure(kind, extra = {}) {
  return { ok: false, kind, retriable: isRetriable(kind), status: null, code: null, inContract: false, message: '', ...extra };
}

async function readJson(response) {
  try {
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: false, value: null };
  }
}

/**
 * 请求一页审计事件。
 *
 * 返回 `{ok: true, status, page: {items, nextCursor, warnings}, requestUrl}` 或
 * `{ok: false, kind, retriable, status, code, inContract, message, ...}`。
 * 未知 code 原样放在 `code` 并标 `inContract: false`（不猜含义、不改写成成功）。
 */
export async function fetchAuditEventsPage({ fetchImpl, baseUrl, token, cursor = null, limit = LIMIT_DEFAULT, signal } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return failure('network_error', { message: '当前环境没有可用的 fetch' });
  if (typeof token !== 'string' || token.length === 0) return failure('signed_out', { message: '没有后台会话令牌' });

  let requestUrl;
  try {
    requestUrl = buildAuditEventsUrl(baseUrl, { cursor, limit });
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
    return failure('network_error', { message: error instanceof Error ? error.message : '网络请求失败' });
  }

  const status = typeof response.status === 'number' ? response.status : 0;
  const parsed = await readJson(response);

  if (response.ok && status >= 200 && status < 300) {
    if (!parsed.ok) return failure('invalid_response', { status, requestUrl, message: '响应不是合法 JSON' });
    const data = readPageEnvelope(parsed.value);
    if (data === null) {
      return failure('invalid_response', { status, requestUrl, message: '响应信封缺少 data 或 meta' });
    }
    const page = validateAuditEventPage(data);
    if (!page.ok) {
      return failure('invalid_response', {
        status,
        requestUrl,
        message: `响应形状不符合 AuditEventPage：${page.errors.map((e) => `${e.path} ${e.problem}`).join('；')}`,
      });
    }
    return {
      ok: true,
      status,
      requestUrl,
      page: { items: page.items, nextCursor: page.nextCursor, warnings: page.warnings },
    };
  }

  const envelope = parsed.ok ? readErrorEnvelope(parsed.value) : null;
  const code = envelope?.code ?? null;
  const inContract = envelope?.inContract ?? false;
  const base = { status, code, inContract, requestUrl };
  const serverMessage = envelope?.message ?? '';

  if (status === 401 || code === 'SESSION_REQUIRED' || code === 'SESSION_EXPIRED') {
    return failure('signed_out', { ...base, message: serverMessage || '后台会话缺失或已过期' });
  }
  if (status === 403 || code === 'SCOPE_DENIED') {
    return failure('forbidden', { ...base, message: serverMessage || `当前后台会话没有 ${AUDIT_SCOPE}` });
  }
  if (status === 400 && code === 'INVALID_CURSOR') {
    return failure('invalid_cursor', { ...base, message: serverMessage || '游标无效或审计台账已变化，需从第一页重读' });
  }
  if (status === 429 || code === 'RATE_LIMITED') {
    const retryAfter = Number(response.headers?.get?.('retry-after'));
    return failure('rate_limited', {
      ...base,
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      message: serverMessage || '请求过于频繁',
    });
  }
  if (status === 503 || status === 504 || status >= 500) {
    return failure('unavailable', { ...base, message: serverMessage || `服务暂不可用（HTTP ${status}）` });
  }
  return failure('http_error', { ...base, message: serverMessage || `请求失败（HTTP ${status}）` });
}

/** 失败对象 → 页面文案。标题/说明/是否可重试/可执行动作，全部如实，不伪造成功。 */
export function describeAuditFailure(result) {
  if (!result || result.ok !== false) return null;
  const suffix = result.status === null || result.status === undefined ? '' : `（HTTP ${result.status}）`;
  switch (result.kind) {
    case 'signed_out':
      return { title: '未登录或会话已过期', detail: `请重新登录后台${suffix}`, retriable: false, action: 'sign_in' };
    case 'forbidden':
      return {
        title: `权限不足（缺少 ${AUDIT_SCOPE}）`,
        detail: `后台会话有效，但本接口要求 scope ${AUDIT_SCOPE}${suffix}`,
        retriable: false,
        action: 'none',
      };
    case 'invalid_cursor':
      return {
        title: '游标已失效',
        detail: '审计台账在分页过程中发生变化，或游标已过期（有效期 15 分钟）；需从第一页重读',
        retriable: false,
        action: 'restart',
      };
    case 'rate_limited':
      return {
        title: '请求过于频繁',
        detail: result.retryAfterSeconds === null ? '稍后重试' : `约 ${result.retryAfterSeconds} 秒后重试`,
        retriable: true,
        action: 'retry',
      };
    case 'unavailable':
      return { title: '服务暂不可用', detail: `稍后重试${suffix}`, retriable: true, action: 'retry' };
    case 'network_error':
      return { title: '网络请求失败', detail: result.message || '检查 API 基地址与开发代理后重试', retriable: true, action: 'retry' };
    case 'invalid_response':
      // 重试同一次请求不会改变响应形状：不给「必然失败」的重试入口。
      return { title: '响应不符合契约', detail: result.message || '未渲染任何行（不猜测缺字段）', retriable: false, action: 'none' };
    default:
      return { title: '请求失败', detail: result.message || '未知错误', retriable: false, action: 'none' };
  }
}

/** 错误码展示文本：契约内/契约外分开口径，便于按码查日志。 */
export function errorCodeText(failure) {
  if (!failure || failure.ok !== false) return '';
  if (typeof failure.code !== 'string' || failure.code === '') {
    return failure.status === null || failure.status === undefined ? '' : `无错误码（HTTP ${failure.status}）`;
  }
  return `${failure.code}（${failure.inContract === true ? '契约内' : '契约外'}错误码）`;
}

// ---------------------------------------------------------------------------
// 展示状态机（与账号目录同构，但筛选维度是 action、且多一个 limit）
// ---------------------------------------------------------------------------

export function initialAuditState() {
  return {
    phase: 'signed_out',
    signedIn: false,
    limit: LIMIT_DEFAULT,
    collection: emptyAuditCollection(),
    requestCursor: null,
    loadingMore: false,
    failure: null,
    actionFilter: 'all',
    expandedId: null,
    stale: false,
    scopeWarning: false,
  };
}

function sameExpanded(state, collection) {
  if (state.expandedId === null) return null;
  return collection.items.some((row) => row.id === state.expandedId) ? state.expandedId : null;
}

function arrayContainsScope(scopes, scope) {
  return Array.isArray(scopes) && scopes.includes(scope);
}

/** 纯 reducer：不合法的事件（例如未登录态下的成功回调）原样返回旧状态。 */
export function reduceAudit(state, action) {
  switch (action?.type) {
    case 'SESSION_MISSING':
      return { ...initialAuditState(), failure: action.failure ?? null };

    case 'SIGN_IN_START':
      return { ...initialAuditState(), phase: 'signing_in' };

    case 'SIGN_IN_FAILED':
      return { ...initialAuditState(), failure: action.failure ?? null };

    case 'SIGNED_IN':
      return {
        ...state,
        signedIn: true,
        phase: 'loading',
        failure: null,
        // 只有在调用方确实拿到了 scopes 清单时才可能告警；拿不到（登录响应不含 scope）时保持 false，不猜。
        scopeWarning: Array.isArray(action.scopes) && !arrayContainsScope(action.scopes, AUDIT_SCOPE),
      };

    case 'SIGN_OUT':
      return initialAuditState();

    case 'SET_LIMIT': {
      const limit = clampLimit(action.limit);
      return { ...state, limit };
    }

    case 'LOAD_START':
      if (!state.signedIn) return state;
      if (action.reset === true) {
        return {
          ...state,
          phase: state.collection.items.length > 0 ? 'ready' : 'loading',
          requestCursor: null,
          failure: null,
          stale: state.collection.items.length > 0,
          expandedId: null,
        };
      }
      return { ...state, loadingMore: true, failure: null, requestCursor: state.collection.nextCursor };

    case 'LOAD_OK': {
      if (!state.signedIn) return state; // 未登录却收到成功回调：丢弃（不显示任何行）
      const collection = action.collection;
      return {
        ...state,
        phase: 'ready',
        collection,
        loadingMore: false,
        failure: null,
        stale: false,
        requestCursor: collection.nextCursor ?? null,
        expandedId: sameExpanded(state, collection),
      };
    }

    case 'LOAD_FAIL': {
      if (!state.signedIn) return state;
      const failure = action.failure;
      if (failure && failure.kind === 'signed_out') return { ...initialAuditState(), failure };
      const hasRows = state.collection.items.length > 0;
      return {
        ...state,
        phase: hasRows ? 'ready' : 'error',
        loadingMore: false,
        failure,
        // 有旧行时保留并显式标注「未刷新」，不把旧数据当成本次结果。
        stale: hasRows,
      };
    }

    case 'SET_ACTION_FILTER':
      return { ...state, actionFilter: typeof action.value === 'string' && action.value !== '' ? action.value : 'all' };

    case 'TOGGLE_ROW': {
      const id = action.id;
      if (typeof id !== 'string') return state;
      if (!state.collection.items.some((row) => row.id === id)) return state;
      return { ...state, expandedId: state.expandedId === id ? null : id };
    }

    case 'CLOSE_ROW':
      return { ...state, expandedId: null };

    default:
      return state;
  }
}

/** 已加载行的 action 去重清单（下拉选项；附带出现次数，便于看出台账构成）。 */
export function actionOptions(state) {
  const counts = new Map();
  for (const row of state.collection.items) {
    const action = typeof row.action === 'string' && row.action !== '' ? row.action : '(空 action)';
    counts.set(action, (counts.get(action) ?? 0) + 1);
  }
  const options = [
    { value: 'all', label: `全部动作（${state.collection.items.length}）` },
    ...Array.from(counts.entries())
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([action, count]) => ({ value: action, label: `${action}（${count}）` })),
  ];
  return options;
}

/**
 * 按 `action` 筛选：**只在已加载行内**过滤。
 * 后端 `listAuditEvents` 只有 `cursor`／`limit` 两个参数，没有 event_type 之类的过滤参数，
 * 因此这是客户端筛选，文案必须写明作用域，不能让人误以为筛了全台账。
 */
export function visibleAuditRows(state) {
  const filter = state.actionFilter;
  const rows = filter === 'all' ? state.collection.items : state.collection.items.filter((row) => row.action === filter);
  return rows.map(auditRowView);
}

/** 行视图：只做展示映射，不改变字段含义（缺失的角色类字段一律不出现在这里）。 */
export function auditRowView(event) {
  const target = event.target_ref === null || event.target_ref === undefined ? null : event.target_ref;
  return {
    id: event.id,
    shortId: event.id.slice(0, 8),
    action: event.action,
    scope: event.scope,
    reasonCode: event.reason_code,
    requestId: event.request_id,
    shortRequestId: event.request_id.slice(0, 8),
    result: event.result,
    resultLabel: AUDIT_RESULT_LABELS[event.result] ?? `未知结果(${event.result})`,
    resultTone: AUDIT_RESULT_TONES[event.result] ?? 'warn',
    createdAt: event.created_at,
    target,
    targetLabel:
      target === null ? '无目标（target_ref = null）' : `${target.type}:${target.id} · r${target.revision}`,
    actor: event.actor ?? null,
    actorLabel: event.actor == null ? '未提供（历史行/服务端未记主体）' : event.actor,
    shortActor: typeof event.actor === 'string' ? event.actor.slice(0, 8) : null,
    shortActor: typeof event.actor === 'string' ? event.actor.slice(0, 8) : null,
    targetHint: event.target_hint ?? null,
    changeLabel: describeFlagChange(event),
    changeTone: describeFlagChangeTone(event),
  };
}

/** 开关前后值 → 「true → false」这类一次性人读文本；非开关行返回 null（不编造）。 */
export function describeFlagChange(event) {
  const before = event.before_value ?? null;
  const after = event.after_value ?? null;
  if (before === null && after === null) return null;
  const render = (reading) => (reading === null ? '∅（无行）' : reading.enabled ? '开' : '关');
  const revision = after?.revision ?? before?.revision;
  const tail = Number.isInteger(revision) ? `（r${revision}）` : '';
  return `${render(before)} → ${render(after)}${tail}`;
}

/** 变更的语气：开启危险操作=warn、关闭=danger? 反过来——关掉业务开关是"更安全"，开是"放宽"。 */
export function describeFlagChangeTone(event) {
  const after = event.after_value ?? null;
  if (after === null) return 'muted';
  return after.enabled ? 'warn' : 'ok';
}

/** 已加载行的结果分布（只统计已加载的，不做"全量"暗示）。 */
export function resultCounts(state) {
  const counts = { accepted: 0, denied: 0, failed: 0 };
  for (const row of state.collection.items) {
    if (Object.prototype.hasOwnProperty.call(counts, row.result)) counts[row.result] += 1;
  }
  return counts;
}

export function canLoadMoreAudit(state) {
  return state.phase === 'ready' && state.collection.nextCursor !== null && !state.loadingMore && !state.collection.cycle;
}

/** 页面级描述：空态／筛选空／加载／错误／就绪，文案互斥且如实。 */
export function describeAudit(state) {
  if (state.phase === 'signing_in') {
    return { tone: 'loading', title: '正在登录', detail: '提交登录名与密码', canRetry: false, action: 'none', errorCode: '' };
  }
  if (state.phase === 'signed_out') {
    const failure = describeAuditFailure(state.failure);
    return {
      tone: 'signed_out',
      title: '未登录',
      detail: failure ? `${failure.title}：${failure.detail}` : '登录后台后才能读取审计事件',
      canRetry: false,
      action: 'sign_in',
      errorCode: errorCodeText(state.failure),
    };
  }
  if (state.phase === 'loading') {
    return {
      tone: 'loading',
      title: '正在读取审计事件',
      detail: `GET ${AUDIT_EVENTS_PATH}（limit=${state.limit}）`,
      canRetry: false,
      action: 'none',
      errorCode: '',
    };
  }
  if (state.phase === 'error') {
    const failure = describeAuditFailure(state.failure);
    return {
      tone: 'error',
      title: failure?.title ?? '读取失败',
      detail: failure?.detail ?? '未知错误',
      canRetry: failure?.retriable === true,
      action: failure?.action ?? 'none',
      errorCode: errorCodeText(state.failure),
    };
  }

  const failure = describeAuditFailure(state.failure);
  const total = state.collection.items.length;
  const visible = visibleAuditRows(state).length;
  const filtered = state.actionFilter !== 'all';
  const base = {
    canRetry: failure?.retriable === true,
    action: failure?.action ?? 'none',
    errorCode: errorCodeText(state.failure),
    total,
    visible,
    filtered,
  };

  if (total === 0) {
    return {
      ...base,
      tone: 'empty',
      title: '审计台账为空',
      detail: '接口返回 0 条事件（items 为空且 next_cursor 为 null）：这是空台账，不是错误',
    };
  }
  if (visible === 0) {
    return {
      ...base,
      tone: 'empty_filtered',
      title: '没有该动作的事件',
      detail: `动作「${state.actionFilter}」只在已加载的 ${total} 条内匹配（后端无该过滤参数）`,
    };
  }
  return {
    ...base,
    tone: state.stale ? 'stale' : 'ready',
    title: state.stale ? '显示的是上次成功读取的数据' : '已读取审计事件',
    detail: state.stale
      ? `共 ${visible} 条（已加载 ${total} 条）；最近一次刷新失败，需重试后才算最新`
      : `共 ${visible} 条（已加载 ${total} 条，已翻 ${state.collection.pages} 页）`,
  };
}
