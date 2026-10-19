/**
 * 后台账号读面（GY-I18）HTTP 客户端——纯 ESM，无 Vue／DOM 依赖，可用假 fetch 注入测试。
 *
 * 只用契约里**存在**的接口：GET `{base}/admin/accounts`（operationId `listAdminUsers`）。
 * 契约没有单账号只读详情接口（`/admin/accounts/{id}` 只有 POST suspend），
 * 因此本模块**不造** `GET /admin/accounts/{id}`，详情摘要只能由列表行字段组成。
 *
 * 不记录、不回传 access token；请求头只带 `authorization: Bearer <token>` 与 `accept`。
 */
import {
  ACCOUNTS_PATH,
  CURSOR_MAX_LENGTH,
  LIMIT_DEFAULT,
  LIMIT_MAX,
  LIMIT_MIN,
  readErrorEnvelope,
  readPageEnvelope,
  validateAccountPage,
} from './admin-contract.mjs';

/** 去掉尾部斜杠；空串按契约默认相对基地址处理。 */
export function normalizeBaseUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return '';
  return value.replace(/\/+$/, '');
}

/** 把 limit 收进契约边界 1..50；非整数（含 undefined／NaN）回落到默认 20。 */
export function clampLimit(limit) {
  const parsed = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return LIMIT_DEFAULT;
  if (parsed < LIMIT_MIN) return LIMIT_MIN;
  if (parsed > LIMIT_MAX) return LIMIT_MAX;
  return parsed;
}

/**
 * 拼账号目录 URL。`limit` 总是显式带上（便于证据页复现），`cursor` 仅在续页时带。
 * 游标超过契约上限 2048 时抛 RangeError —— 宁可不发请求，也不发一个必然 400 的请求。
 */
export function buildAccountsUrl(baseUrl, options = {}) {
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
  return `${base}${ACCOUNTS_PATH}?${params.toString()}`;
}

/** 空集合：`items` 与游标都由服务端给，本地只负责去重与续页记账。 */
export function emptyCollection() {
  return { items: [], nextCursor: null, seenIds: [], pages: 0, duplicates: 0, cycle: false };
}

/**
 * 应用一页结果（纯函数，返回新集合）。
 *
 * - 按 `id` 去重：续页重复投递同一行时不重复计数（`duplicates` 记账）。
 * - **游标死循环保护**：服务端把本次请求的 cursor 原样当 `next_cursor` 返回时置 `cycle: true`
 *   且不再续页，避免前端无限翻页。
 */
export function appendPage(collection, { cursor = null, page }) {
  const previous = collection ?? emptyCollection();
  const seen = new Set(previous.seenIds);
  const items = previous.items.slice();
  const added = [];
  let duplicates = previous.duplicates;

  for (const row of page.items) {
    if (seen.has(row.id)) {
      duplicates += 1;
      continue;
    }
    seen.add(row.id);
    items.push(row);
    added.push(row);
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
      cycle,
    },
    added,
  };
}

/** 失败类型 → 是否值得重试（429 等冷却、5xx、网络错误可重试；鉴权/游标/形状不可重试）。 */
export function isRetriable(kind) {
  return kind === 'rate_limited' || kind === 'unavailable' || kind === 'network_error';
}

async function readJson(response) {
  try {
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: false, value: null };
  }
}

function failure(kind, extra = {}) {
  return { ok: false, kind, retriable: isRetriable(kind), status: null, code: null, message: '', ...extra };
}

/**
 * 请求一页账号目录。
 *
 * 返回 `{ok: true, status, page: {items, nextCursor, warnings}, requestUrl}` 或
 * `{ok: false, kind, retriable, status, code, message, ...}`。
 * 失败分支按契约错误码分类，未知 code 原样放在 `code` 并标 `inContract: false`。
 */
export async function fetchAccountsPage({ fetchImpl, baseUrl, token, cursor = null, limit = LIMIT_DEFAULT, signal } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return failure('network_error', { message: '当前环境没有可用的 fetch' });
  if (typeof token !== 'string' || token.length === 0) {
    return failure('signed_out', { message: '没有后台会话令牌' });
  }

  let requestUrl;
  try {
    requestUrl = buildAccountsUrl(baseUrl, { cursor, limit });
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
    if (!parsed.ok) return failure('invalid_response', { status, message: '响应不是合法 JSON' });
    const data = readPageEnvelope(parsed.value);
    if (data === null) {
      return failure('invalid_response', { status, message: '响应信封缺少 data 或 meta' });
    }
    const page = validateAccountPage(data);
    if (!page.ok) {
      return failure('invalid_response', {
        status,
        message: `响应形状不符合 AdminAccountViewPage：${page.errors.map((e) => `${e.path} ${e.problem}`).join('；')}`,
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
    return failure('forbidden', { ...base, message: serverMessage || '当前后台会话没有 accounts:read' });
  }
  if (status === 400 && code === 'INVALID_CURSOR') {
    return failure('invalid_cursor', { ...base, message: serverMessage || '游标无效，需从第一页重新读取' });
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

/** 失败对象 → 页面文案（标题/说明/是否可重试/可执行动作）。不伪造成功。 */
export function describeFailure(result) {
  if (!result || result.ok !== false) return null;
  const suffix = result.status === null || result.status === undefined ? '' : `（HTTP ${result.status}）`;
  switch (result.kind) {
    case 'signed_out':
      return { title: '未登录或会话已过期', detail: `请重新登录后台${suffix}`, retriable: false, action: 'sign_in' };
    case 'forbidden':
      return {
        title: '权限不足（缺少 accounts:read）',
        detail: `后台会话有效，但本接口要求 scope accounts:read${suffix}`,
        retriable: false,
        action: 'none',
      };
    case 'invalid_cursor':
      return { title: '游标无效', detail: '服务端拒绝该游标，需从第一页重新读取', retriable: false, action: 'restart' };
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
      // 与 isRetriable 闭集一致：重试同一次请求不会改变响应形状，不给「必然失败」的重试入口。
      return { title: '响应不符合契约', detail: result.message || '未渲染任何行（不猜测缺字段）', retriable: false, action: 'none' };
    default:
      return { title: '请求失败', detail: result.message || '未知错误', retriable: false, action: 'none' };
  }
}
