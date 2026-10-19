/**
 * 后台账号读面（GY-I18）契约常量与响应校验——纯 ESM，无 Vue／DOM 依赖。
 *
 * 事实来源（逐条可核）：
 * - `packages/contracts/openapi.json` 的 `/admin/accounts` GET（operationId `listAdminUsers`）
 *   参数 `Cursor`／`Limit`，200 返回 `AdminAccountViewPageEnvelope`，`x-scope: accounts:read`。
 * - `packages/contracts/operations.json` 的 `listAdminUsers`：GET `/admin/accounts`，scope `accounts:read`。
 *
 * 本模块只做**形状校验**，不发请求、不碰存储、不写日志；行数据不落 localStorage。
 */

/** API 基地址默认值（与 `src/auth/session.ts` 的 `API_BASE_URL` 口径一致，本模块不读 `import.meta.env`）。 */
export const ADMIN_API_BASE_DEFAULT = '/api/v1';

/** 账号目录路径（相对 API 基地址）。 */
export const ACCOUNTS_PATH = '/admin/accounts';

/** 读取账号目录所需 scope（契约 `x-scope`）。 */
export const ACCOUNTS_SCOPE = 'accounts:read';

/** 分页参数边界：契约 `Limit` 为 integer 1..50、default 20；`Cursor` 为 string(1..2048)。 */
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 50;
export const LIMIT_DEFAULT = 20;
export const CURSOR_MAX_LENGTH = 2048;

/** `AdminAccountView.state` 取值（契约 enum，顺序同 openapi.json）。 */
export const ACCOUNT_STATES = Object.freeze(['active', 'suspended', 'deletion_pending']);

/** `ErrorCode` 全集（契约 enum；用于把未知 code 与契约内 code 区分开）。 */
export const ERROR_CODES = Object.freeze([
  'INVALID_REQUEST',
  'INVALID_CURSOR',
  'IDEMPOTENCY_KEY_REQUIRED',
  'SESSION_REQUIRED',
  'SESSION_EXPIRED',
  'SCOPE_DENIED',
  'CONSENT_REQUIRED',
  'ACCOUNT_INACTIVE',
  'NOT_FOUND',
  'REVISION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'OBJECT_UNAVAILABLE',
  'REQUEST_IN_PROGRESS',
  'MEDIA_TOO_LARGE',
  'MEDIA_TYPE_UNSUPPORTED',
  'CONDITIONS_INCOMPLETE',
  'SOURCE_CONFLICT',
  'INPUT_UNCERTAIN',
  'REVISION_REQUIRED',
  'RATE_LIMITED',
  'PROVIDER_QUOTA_EXCEEDED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_OUTCOME_UNKNOWN',
  'PROVIDER_TIMEOUT',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 只认真正的对象，排除 null／数组。 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 校验一行 `AdminAccountView`。
 *
 * - `errors`：违反 required／type／enum ⇒ 该响应不可信，调用方应整体判为畸形响应。
 * - `warnings`：仅违反数值范围／格式（uuid 形态、display_name 长度）⇒ 行仍可渲染。
 *   `additionalProperties: false` 也记 warning：多余字段直接丢弃、不猜测含义。
 *   注意：`warnings` 只是校验器的诊断输出（返回值 + 单测断言），**当前 UI 没有任何提示位**，
 *   页面不会因此显示「已忽略 N 个契约外字段」；需要外显时由调用方自行消费，别在文档里写成「已标注」。
 */
export function validateAccountView(value) {
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

  if (typeof value.revision !== 'number' || !Number.isInteger(value.revision)) {
    errors.push({ path: '$.revision', problem: '缺少整数 revision' });
  } else if (value.revision < 1) {
    errors.push({ path: '$.revision', problem: `revision 需 >= 1，实际 ${value.revision}` });
  }

  if (typeof value.state !== 'string') {
    errors.push({ path: '$.state', problem: '缺少字符串 state' });
  } else if (!ACCOUNT_STATES.includes(value.state)) {
    errors.push({ path: '$.state', problem: `state 不在契约 enum：${value.state}` });
  }

  if (!isNonEmptyString(value.display_name)) {
    errors.push({ path: '$.display_name', problem: '缺少非空 display_name' });
  } else if (value.display_name.length > 80) {
    warnings.push({ path: '$.display_name', problem: `长度 ${value.display_name.length} 超出契约上限 80` });
  }

  const known = new Set(['id', 'revision', 'state', 'display_name']);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) warnings.push({ path: `$.${key}`, problem: '契约外字段（不展示、不推断含义）' });
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 校验一页 `AdminAccountViewPage`（envelope 内 `data`）。
 *
 * `next_cursor` 为 `null` 表示已到末页；空 `items` + `null` 是**合法的空列表**，
 * 调用方不得把空列表当成功之外的东西（也不能把它当"接口坏了"）。
 */
export function validateAccountPage(value) {
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
      const result = validateAccountView(item);
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

/** 解析错误信封 `{ error: { code, message? }, meta }`；形状不符返回 null（不猜 code）。 */
export function readErrorEnvelope(body) {
  if (!isPlainObject(body)) return null;
  const error = body.error;
  if (!isPlainObject(error) || !isNonEmptyString(error.code)) return null;
  const code = error.code;
  return {
    code,
    inContract: ERROR_CODES.includes(code),
    message: typeof error.message === 'string' ? error.message : '',
  };
}

/** 从 200 响应体取 `data`；信封缺 `data` 返回 null（由调用方判畸形）。 */
export function readPageEnvelope(body) {
  if (!isPlainObject(body)) return null;
  if (!isPlainObject(body.meta)) return null;  // 契约 required: data + meta
  if (!isPlainObject(body.data)) return null;
  return body.data;
}
