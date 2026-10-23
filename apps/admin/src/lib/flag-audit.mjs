/**
 * 「开关变更留痕」只读查询面（GY-R33 · #18 最小片 1）——
 * 纯 ESM，无 Vue／DOM 依赖，可用假 fetch 注入测试。
 *
 * ## 事实来源（逐条在 `upstream/main` 上核过，不自行发明字段与参数）
 * - **路由**：`services/api/src/routes/admin.ts:353` 注册 `GET ${API_PREFIX}/admin/flag-audit-events`
 *   （`API_PREFIX` = `/api/v1`），守卫为 `requireAdmin` + `requireScope(OPS_SCOPES.listFlagAuditEvents)`。
 * - **契约**：`packages/contracts/openapi.json` 的 `/admin/flag-audit-events` GET，
 *   operationId `listFlagAuditEvents`，`x-scope` = `flags:read`
 *   （与 `services/api/src/admin/ops/service.ts` 的 `OPS_SCOPES.listFlagAuditEvents` 同值）。
 *   参数**只有** `Cursor` / `Limit`（1..50，缺省 20）——**没有**按 key、操作者或时间范围的过滤参数；
 *   200 返回 `AuditEventPageEnvelope`（`data.items` + `data.next_cursor` + `meta`），
 *   响应头 `Cache-Control: no-store`；**列表响应没有 ETag 头**（契约已写明「列表无此头」）。
 * - **行形状**：`AuditEvent`（`additionalProperties: false`）= 8 个必填
 *   `id / action / scope / target_ref / reason_code / request_id / result / created_at`
 *   ＋ 4 个**可选且可空** `actor / target_hint / before_value / after_value`。
 *   开关行由 `services/api/src/admin/ops/flags-pg.ts:478` 的 `listAudit` 投影出后 4 项：
 *   `target_hint` 形如 `flag:<key>`（`TargetRef.type` 闭集里**没有** flag 成员，故 `target_ref` 常为 null），
 *   前后值都是 `FlagReading` = `{ enabled, revision }`。
 * - **分页是键集游标**：`(created_at DESC, id DESC)`，游标内位置串为 `created_at|id`，
 *   服务端**不**返回 `COUNT(*)`（快照统计会让翻页结果与总数互相打脸）；
 *   游标有效期 **15 分钟**，过期／换了家族／换了主体 ⇒ `400 INVALID_CURSOR`
 *   （见 `services/api/src/admin/ops/service.ts:822` 起的 `listFlagAuditEvents`）。
 *   ⇒ 页面只能「下一页」+「从第一页重读」，**不提供**页码跳转。续页必须原样回传 `next_cursor`。
 * - **未接线**：服务层抛 `PROVIDER_UNAVAILABLE` ⇒ 503。空页**只**可能是「真的读到 0 条」，
 *   因此本模块把 503 当失败态，绝不把未接线渲染成空台账。
 *
 * ## 与 `audit-events.mjs` 的关系（复用，不复制）
 * 两条接口返回同一契约 schema `AuditEvent`／`AuditEventPageEnvelope`，所以：
 * **行/页校验**直接复用 `validateAuditEventPage`，**前后值人读文本**直接复用
 * `describeFlagChange`／`describeFlagChangeTone`，错误码口径复用 `errorCodeText`。
 * 本模块只承担「**这条路径、这个 scope**」的差异：
 * 路径常量、URL 拼接、失败分类文案（`flags:read` 而非 `audit:read`）、
 * 键集游标语义文案、以及本页自己的集合与状态机。
 *
 * 两处的失败文案**有意分开写**：文案里出现的 scope 必须是本接口真实要求的 scope，
 * 复用一份带 `audit:read` 字样的说明会直接误导操作者。
 *
 * 不记录、不回传 access token；请求头只带 `authorization`／`accept`，
 * 不写日志、不落 localStorage。
 */
import { CURSOR_MAX_LENGTH, LIMIT_DEFAULT, isPlainObject, readErrorEnvelope, readPageEnvelope } from './admin-contract.mjs';
import { clampLimit, isRetriable, normalizeBaseUrl } from './admin-api.mjs';
import {
  AUDIT_RESULT_LABELS,
  AUDIT_RESULT_TONES,
  describeFlagChange,
  describeFlagChangeTone,
  errorCodeText,
  validateAuditEventPage,
} from './audit-events.mjs';

/** 开关变更留痕路径（相对 API 基地址）。契约 `/admin/flag-audit-events`。 */
export const FLAG_AUDIT_PATH = '/admin/flag-audit-events';

/** 读取开关留痕所需 scope（契约 `x-scope` = 服务层 `OPS_SCOPES.listFlagAuditEvents`）。 */
export const FLAG_AUDIT_SCOPE = 'flags:read';

/** 页面可选的 `limit`（契约边界 1..50，默认 20）。 */
export const FLAG_AUDIT_LIMIT_OPTIONS = Object.freeze([LIMIT_DEFAULT, 50]);

/** 服务端游标有效期（分钟）：过期后 `400 INVALID_CURSOR`，只能从第一页重读。 */
export const FLAG_AUDIT_CURSOR_TTL_MINUTES = 15;

/** 开关行的 `target_hint` 形态（`flag:<key>`）；不匹配时本页不猜 key。 */
const FLAG_HINT_RE = /^flag:([a-z0-9_]+)$/;

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
 * 拼开关留痕 URL。`limit` 总是显式带上（便于证据页复现），`cursor` 仅在续页时带。
 * 游标超过契约上限 2048 时抛 RangeError——宁可不发请求，也不发一个必然 400 的请求。
 */
export function buildFlagAuditUrl(baseUrl, options = {}) {
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
  return `${base}${FLAG_AUDIT_PATH}?${params.toString()}`;
}

/** 空集合：`items` 与游标都由服务端给，本地只负责去重与续页记账。 */
export function emptyFlagAuditCollection() {
  return { items: [], nextCursor: null, seenIds: [], pages: 0, duplicates: 0, warnings: 0, cycle: false };
}

/**
 * 应用一页结果（纯函数，返回新集合），与审计事件页同一套规则：
 * 按 `id` 去重；服务端把请求游标原样返回时置 `cycle: true` 且停止续页。
 */
export function appendFlagAuditPage(collection, { cursor = null, page }) {
  const previous = collection ?? emptyFlagAuditCollection();
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

/**
 * 请求一页开关变更留痕（`GET /admin/flag-audit-events`）。
 *
 * 返回 `{ok: true, status, requestUrl, page: {items, nextCursor, warnings}}` 或
 * `{ok: false, kind, retriable, status, code, inContract, message, requestUrl}`。
 * 未知 code 原样放在 `code` 并标 `inContract: false`（不猜含义、不改写成成功）。
 */
export async function fetchFlagAuditPage({ fetchImpl, baseUrl, token, cursor = null, limit = LIMIT_DEFAULT, signal } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return failure('network_error', { message: '当前环境没有可用的 fetch' });
  if (typeof token !== 'string' || token.length === 0) return failure('signed_out', { message: '没有后台会话令牌' });

  let requestUrl;
  try {
    requestUrl = buildFlagAuditUrl(baseUrl, { cursor, limit });
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
  const base = { status, code, inContract: envelope?.inContract ?? false, requestUrl };
  const serverMessage = envelope?.message ?? '';

  if (status === 401 || code === 'SESSION_REQUIRED' || code === 'SESSION_EXPIRED') {
    return failure('signed_out', { ...base, message: serverMessage || '后台会话缺失或已过期' });
  }
  if (status === 403 || code === 'SCOPE_DENIED') {
    return failure('forbidden', { ...base, message: serverMessage || `当前后台会话没有 ${FLAG_AUDIT_SCOPE}` });
  }
  if (status === 400 && code === 'INVALID_CURSOR') {
    return failure('invalid_cursor', {
      ...base,
      message: serverMessage || '游标无效或开关留痕台账已变化，需从第一页重读',
    });
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

/**
 * 失败对象 → 页面文案。标题/说明/是否可重试/可执行动作，全部如实，不伪造成功。
 *
 * 与 `describeAuditFailure` 的差别只在 scope 文案与游标说明（键集游标 + 15 分钟有效期）；
 * 其余分支口径一致，便于操作者跨页比对同一错误码。
 */
export function describeFlagAuditFailure(result) {
  if (!result || result.ok !== false) return null;
  const suffix = result.status === null || result.status === undefined ? '' : `（HTTP ${result.status}）`;
  switch (result.kind) {
    case 'signed_out':
      return { title: '未登录或会话已过期', detail: `请重新登录后台${suffix}`, retriable: false, action: 'sign_in' };
    case 'forbidden':
      return {
        title: `权限不足（缺少 ${FLAG_AUDIT_SCOPE}）`,
        detail: `后台会话有效，但本接口要求 scope ${FLAG_AUDIT_SCOPE}${suffix}`,
        retriable: false,
        action: 'none',
      };
    case 'invalid_cursor':
      return {
        title: '游标已失效',
        detail: `开关留痕台账在分页过程中发生变化，或游标已过期（有效期 ${FLAG_AUDIT_CURSOR_TTL_MINUTES} 分钟）；需从第一页重读`,
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
      return {
        title: '服务暂不可用',
        // 503 在本接口有确定含义：服务端未接线（PROVIDER_UNAVAILABLE）也走这条，不能读成"没有变更"。
        detail: `稍后重试${suffix}；若持续 503，可能是该读面尚未接线（服务端未接线时刻意不返回空页）`,
        retriable: true,
        action: 'retry',
      };
    case 'network_error':
      return { title: '网络请求失败', detail: result.message || '检查 API 基地址与开发代理后重试', retriable: true, action: 'retry' };
    case 'invalid_response':
      // 重试同一次请求不会改变响应形状：不给「必然失败」的重试入口。
      return { title: '响应不符合契约', detail: result.message || '未渲染任何行（不猜测缺字段）', retriable: false, action: 'none' };
    default:
      return { title: '请求失败', detail: result.message || '未知错误', retriable: false, action: 'none' };
  }
}

// ---------------------------------------------------------------------------
// 展示状态机（与审计事件页同构；差异是本页只有「下一页」，没有页码与动作筛选）
// ---------------------------------------------------------------------------

export function initialFlagAuditState() {
  return {
    phase: 'signed_out',
    signedIn: false,
    limit: LIMIT_DEFAULT,
    collection: emptyFlagAuditCollection(),
    loadingMore: false,
    failure: null,
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
export function reduceFlagAudit(state, action) {
  switch (action?.type) {
    case 'SESSION_MISSING':
      return { ...initialFlagAuditState(), failure: action.failure ?? null };

    case 'SIGN_IN_START':
      return { ...initialFlagAuditState(), phase: 'signing_in' };

    case 'SIGN_IN_FAILED':
      return { ...initialFlagAuditState(), failure: action.failure ?? null };

    case 'SIGNED_IN':
      return {
        ...state,
        signedIn: true,
        phase: 'loading',
        failure: null,
        // 只有调用方确实拿到了 scopes 清单时才可能告警；拿不到时保持 false，不猜。
        scopeWarning: Array.isArray(action.scopes) && !arrayContainsScope(action.scopes, FLAG_AUDIT_SCOPE),
      };

    case 'SIGN_OUT':
      return initialFlagAuditState();

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
          failure: null,
          stale: state.collection.items.length > 0,
          expandedId: null,
        };
      }
      return { ...state, loadingMore: true, failure: null };

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
        expandedId: sameExpanded(state, collection),
      };
    }

    case 'LOAD_FAIL': {
      if (!state.signedIn) return state;
      const failure = action.failure;
      if (failure && failure.kind === 'signed_out') return { ...initialFlagAuditState(), failure };
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

/** `target_hint` 形如 `flag:<key>`：只在这一形态下取 key，否则返回 null（不猜）。 */
export function flagKeyOf(targetHint) {
  if (typeof targetHint !== 'string') return null;
  const match = FLAG_HINT_RE.exec(targetHint);
  return match === null ? null : match[1];
}

/**
 * 行视图：只做展示映射，不改字段含义。
 * 前后值文本复用 `describeFlagChange`（与审计事件页同口径），缺失的 actor 一律如实显示「未提供」。
 */
export function flagAuditRowView(row) {
  const target = row.target_ref === null || row.target_ref === undefined ? null : row.target_ref;
  const flagKey = flagKeyOf(row.target_hint);
  return {
    id: row.id,
    shortId: row.id.slice(0, 8),
    createdAt: row.created_at,
    action: row.action,
    scope: row.scope,
    reasonCode: row.reason_code,
    requestId: row.request_id,
    shortRequestId: row.request_id.slice(0, 8),
    result: row.result,
    resultLabel: AUDIT_RESULT_LABELS[row.result] ?? `未知结果(${row.result})`,
    resultTone: AUDIT_RESULT_TONES[row.result] ?? 'warn',
    flagKey,
    flagKeyLabel: flagKey ?? (row.target_hint == null ? '未提供（target_hint = null）' : '非 flag: 形态，未解析'),
    targetHint: row.target_hint ?? null,
    target,
    // 开关行的 TargetRef.type 闭集里没有 flag 成员，target_ref 常为 null：不编造目标。
    targetLabel: target === null ? null : `${target.type}:${target.id} · r${target.revision}`,
    actor: row.actor ?? null,
    actorLabel: row.actor == null ? '未提供（历史行/服务端未记主体）' : row.actor,
    shortActor: typeof row.actor === 'string' ? row.actor.slice(0, 8) : null,
    beforeValue: row.before_value ?? null,
    afterValue: row.after_value ?? null,
    changeLabel: describeFlagChange(row),
    changeTone: describeFlagChangeTone(row),
  };
}

/** 已加载行 → 行视图（顺序即服务端返回顺序：`created_at DESC, id DESC`）。 */
export function flagAuditRows(state) {
  return state.collection.items.map(flagAuditRowView);
}

/** 已加载行的结果分布（只统计已加载的，不做"全量"暗示）。 */
export function flagAuditResultCounts(state) {
  const counts = { accepted: 0, denied: 0, failed: 0 };
  for (const row of state.collection.items) {
    if (Object.prototype.hasOwnProperty.call(counts, row.result)) counts[row.result] += 1;
  }
  return counts;
}

export function canLoadMoreFlagAudit(state) {
  return state.phase === 'ready' && state.collection.nextCursor !== null && !state.loadingMore && !state.collection.cycle;
}

/** 页面级描述：空态／加载／错误／就绪，文案互斥且如实。 */
export function describeFlagAudit(state) {
  if (state.phase === 'signing_in') {
    return { tone: 'loading', title: '正在登录', detail: '提交登录名与密码', canRetry: false, action: 'none', errorCode: '' };
  }
  if (state.phase === 'signed_out') {
    const failure = describeFlagAuditFailure(state.failure);
    return {
      tone: 'signed_out',
      title: '未登录',
      detail: failure ? `${failure.title}：${failure.detail}` : '登录后台后才能读取开关变更留痕',
      canRetry: false,
      action: 'sign_in',
      errorCode: errorCodeText(state.failure),
    };
  }
  if (state.phase === 'loading') {
    return {
      tone: 'loading',
      title: '正在读取开关变更留痕',
      detail: `GET ${FLAG_AUDIT_PATH}（limit=${state.limit}，键集游标 created_at DESC, id DESC）`,
      canRetry: false,
      action: 'none',
      errorCode: '',
    };
  }
  if (state.phase === 'error') {
    const failure = describeFlagAuditFailure(state.failure);
    return {
      tone: 'error',
      title: failure?.title ?? '读取失败',
      detail: failure?.detail ?? '未知错误',
      canRetry: failure?.retriable === true,
      action: failure?.action ?? 'none',
      errorCode: errorCodeText(state.failure),
    };
  }

  const failure = describeFlagAuditFailure(state.failure);
  const total = state.collection.items.length;
  const base = {
    canRetry: failure?.retriable === true,
    action: failure?.action ?? 'none',
    errorCode: errorCodeText(state.failure),
    total,
    visible: total,
    filtered: false,
  };

  if (total === 0) {
    return {
      ...base,
      tone: 'empty',
      title: '开关变更留痕为空',
      detail:
        '接口返回 0 条（items 为空且 next_cursor 为 null）：这是空台账，只表示读到 0 条，' +
        '不等于「平台从未改过开关」；未接线时服务端给的是 503，不会落到这里',
    };
  }
  return {
    ...base,
    tone: state.stale ? 'stale' : 'ready',
    title: state.stale ? '显示的是上次成功读取的数据' : '已读取开关变更留痕',
    detail: state.stale
      ? `共 ${total} 条（已翻 ${state.collection.pages} 页）；最近一次刷新失败，需重试后才算最新`
      : `共 ${total} 条（已翻 ${state.collection.pages} 页）`,
  };
}
