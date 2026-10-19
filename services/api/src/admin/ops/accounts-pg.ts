/**
 * GY-I18（#18）· 后台账号读面 `GET /admin/accounts` 的**真实投影**（PG 适配层）。
 *
 * ## 为什么需要这一层
 * `admin/ops/service.ts` 的 `listAdminUsers` 此前只认内存种子（`store.accountsWired`），
 * `real` 装配下由 `accounts-only.ts` 整条读面 503：能按 id 停用，却**列不出任何真实账号**。
 * 本文件把「真实账号目录」做成一个可注入的能力对象，服务层只按“能力是否存在”判定，
 * ⛔ 不读任何自述持久化布尔标志（与 `mediaObjectStore`／`accountAuthority` 同一口径）。
 *
 * ## 为什么读的是函数而不是表（裁定 A，迁移 0021）
 * 运行时角色 `gengyun_api_runtime` 对 `public.users` 的列权限只有
 * `SELECT (id,state,auth_epoch,revision,wechat_subject_lookup)`，**没有** `nickname` / `created_at`：
 * 派单原文的 `SELECT id, revision, state, nickname FROM public.users ORDER BY created_at ASC, id ASC`
 * 在运行时角色下必然 `permission denied for table users`（42501，已实测）。
 * 因此真实读路径收敛到窄口径 `SECURITY DEFINER` 函数 `public.list_admin_accounts()`：
 * 输出列被函数签名钉死为 `id / revision / state / display_name` 四项，
 * 运行时角色只有 EXECUTE、**没有任何** `users` 列授权（`90-assert-least-privilege.sql` 断言 32–37）。
 * ⛔ 不 `SELECT *`；⛔ 不读也不返回 `wechat_subject_cipher`／`wechat_subject_lookup`／
 * `avatar_media_id`／`deletion_generation`／`auth_epoch`。
 *
 * ## display_name 的来源
 * 函数内复用 0017 的 `public.admin_account_display_name(nickname, id)`：`users.nickname` 可空而
 * 契约 `AdminAccountView.display_name` 是 `required / minLength:1`，返回 `''` 会**违反契约**。
 * 派单 §2.1 原文的 `nickname ?? ''` 映射已由指挥裁定换成本函数（差异记在交接）。
 *
 * ## 残余限制（如实声明，不得声称「已分页到 SQL」）
 * `list()` 是**一次全表读**：`ORDER BY created_at ASC, id ASC` 在**函数内**定序（`created_at`
 * 不在输出白名单，调用方无法二次排序），分页/游标由服务层 `pageOf()` 对内存数组切片。
 * 万级以上的账号规模需要 SQL 侧 keyset 分页（后续片）。
 *
 * ## 错误码：不新增契约错误码
 * 与 `admin/ops/account-authority-pg.ts` 的 `mapAccountAuthorityError()` 同口径：
 *   - `42501`（权限不足）/`42883`（函数缺失）⇒ `PROVIDER_UNAVAILABLE`(503)，**不降级、不改走内存**；
 *   - `57014`/`55P03`（语句超时/锁超时）⇒ `PROVIDER_TIMEOUT`(504, `retryable: true`)；
 *   - 其余（含函数内 `LIST_ADMIN_ACCOUNTS_*` 的 data_exception）⇒ `PROVIDER_UNAVAILABLE`(503, `retryable: false`)。
 * 行形状不符（缺列、state 越契约闭集）同样**失败关闭**：绝不静默折叠成 `active`／空页。
 */
import { ApiError } from '../../errors.ts';
import type { PgPool } from '../../db/pool.ts';
import { ACCOUNT_STATES, type AccountState, type AccountView } from './types.ts';

/**
 * 读面 SQL（逐字固定，改动必须同步 `tests/integration/admin-accounts-read-pg.mjs` 的字段白名单断言）。
 * 四列全部来自函数签名；⛔ 不得改回 `FROM public.users`。
 */
const LIST_ACCOUNTS_SQL = 'SELECT id, revision, state, display_name FROM public.list_admin_accounts()';

const ACCOUNT_STATES_SET: readonly string[] = ACCOUNT_STATES;

/** 真实账号目录：服务层唯一依赖的能力形状。 */
export interface AdminAccountsDirectory {
  /** 一次全表读、函数内定序；分页由服务层 `pageOf()` 负责。 */
  list(): Promise<AccountView[]>;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError('PROVIDER_UNAVAILABLE', `账号读面返回缺少字段 ${field}`, { retryable: false });
  }
  return value;
}

function asInteger(value: unknown, field: string): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) {
    throw new ApiError('PROVIDER_UNAVAILABLE', `账号读面返回字段 ${field} 不是正整数`, { retryable: false });
  }
  return n;
}

/**
 * 数据库枚举 `user_state` 有 4 个值（`0001_initial_schema.sql` 含 `deleted`），
 * 契约 `AdminAccountView.state` 只有 3 个。越界值一律**抛**：静默折叠成 `active`
 * 会把「已删除/未知」说成「正常账号」，正是本片要避免的伪造结论。
 */
function toState(value: unknown): AccountState {
  const state = asNonEmptyString(value, 'state');
  if (!ACCOUNT_STATES_SET.includes(state)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', `账号读面返回的 state 不在契约闭集内：${state}`, { retryable: false });
  }
  return state as AccountState;
}

/** 单行映射；只读白名单里的四列，其余列即使被驱动带出来也不透出。 */
function toAccountView(raw: unknown): AccountView {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '账号读面返回的行不是对象', { retryable: false });
  }
  const row = raw as Record<string, unknown>;
  return {
    id: asNonEmptyString(row['id'], 'id'),
    revision: asInteger(row['revision'], 'revision'),
    state: toState(row['state']),
    // 契约 `minLength:1`：函数保证非空，这里再守一道，⛔ 不许退回 `''`。
    display_name: asNonEmptyString(row['display_name'], 'display_name'),
  };
}

/** PostgreSQL 错误 → 既有契约错误码（不透出驱动原文）。 */
function mapAccountsReadError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const code = (error as { code?: unknown })?.code;
  const sqlState = typeof code === 'string' ? code : '';
  if (sqlState === '57014' || sqlState === '55P03') {
    throw new ApiError('PROVIDER_TIMEOUT', '账号读面查询超时', { retryable: true });
  }
  // `42501`（列/函数权限不足）、`42883`（函数缺失）、函数内 `data_exception` 与其它失败同走
  // 「不可用」：⛔ 不降级成内存种子、⛔ 不返回空页（空页会被读成「平台没有账号」）。
  throw new ApiError('PROVIDER_UNAVAILABLE', '账号读面暂不可用', { retryable: false });
}

/**
 * 建真实账号目录。
 *
 * 构造期**不**探测表/函数权限（探测会把「迁移/授权没跑」变成启动期崩溃），只做形状守卫：
 * 调用期缺 `query` 能力 ⇒ 如实 `PROVIDER_UNAVAILABLE`，读面不会伪造成功。
 */
export function createPostgresAccountsDirectory({ pool }: { pool: PgPool }): AdminAccountsDirectory {
  return {
    async list(): Promise<AccountView[]> {
      if (!pool || typeof pool.query !== 'function') {
        throw new ApiError('PROVIDER_UNAVAILABLE', '账号读面暂不可用', { retryable: false });
      }
      let rows: readonly unknown[];
      try {
        const result = await pool.query(LIST_ACCOUNTS_SQL);
        rows = result.rows as readonly unknown[];
      } catch (error) {
        throw mapAccountsReadError(error);
      }
      return rows.map(toAccountView);
    },
  };
}
