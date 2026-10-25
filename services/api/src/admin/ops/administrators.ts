/**
 * `#18` S2 PR-2 · 后台**管理员目录与权限读面**（`GET /admin/administrators`、
 * `GET /admin/administrators/{id}/scopes`）的真实投影。
 *
 * ## 为什么复用认证存储而不是新写 SQL
 * 读「某个后台账号当前持有哪些 scope」这件事，认证侧**已经在做**了：每次后台请求的鉴权都会
 * 加载操作者自己的 scope 集合（`services/api/src/auth/store.ts` 的 `listAdminScopes()`）。
 * 本片新增的只是"能不能对**别人**做同一件事"，不该为它再造一条查询路径：
 *
 *   - `listAdmins()` ⇒ `SELECT id, login_name, state, auth_epoch, revision FROM admin_accounts ORDER BY id ASC`
 *     （`store.ts`）；五列**全部**落在运行时角色的既有列授权内
 *     （`services/api/db/roles/auth_privacy.sql:27`，快照见 `90-assert-least-privilege.sql:1537-1539`）；
 *   - `getAdmin(adminId)` ⇒ `... WHERE id = $1::uuid`（`store.ts`）——只用来判**存在性**；
 *   - `listAdminScopes(adminId)` ⇒ `SELECT scope FROM admin_scopes WHERE admin_id = $1::uuid AND revoked_at IS NULL ORDER BY scope`
 *     （`store.ts`）——**只 SELECT `scope` 一列**，不读 `granted_by` / `granted_at` / `revoked_at`。
 *
 * ⛔ **不新增表级/列级授权**：运行时角色经 `gengyun_auth_privacy` 早已拿到
 * `admin_accounts` 的 `SELECT (id, login_name, state, auth_epoch, revision, credential_hash)` 与
 * `admin_scopes` 的 `SELECT (admin_id, scope, revoked_at)`
 * （`services/api/db/roles/auth_privacy.sql:27-28` + `deploy/postgres-cvm/sql/20-login-roles.sql:221`
 * 的角色继承），这两条 SQL 的组合已被会话路径使用。
 * 若将来需要新授权，那属部署 SQL 另一片，⛔ 不在本文件里绕过。
 *
 * ## 为什么 `id` 必须是 `admin_accounts.id`
 * 全仓另一个"账号目录"是 `GET /admin/accounts`（`accounts-pg.ts`），它读的是 `public.users`
 * （迁移 0021 的 `public.list_admin_accounts()`），返回的是**终端用户**的 id。
 * 权限挂在 `admin_scopes.admin_id → admin_accounts.id` 上（迁移 0001/0017），两个 id 空间
 * **没有任何映射**。裁定③因此明令写面不得复用 `/admin/accounts` 名下的 id，读面同理：
 * 本文件的 `id` 只来自 `admin_accounts`，路径也另起 `/admin/administrators`。
 * 单测用"两个 id 不同的行"直接证明这一点（见 `tests/unit/admin-scopes-read.test.mjs`）。
 *
 * ## 为什么返回体里没有 `granted_by` / `granted_at`
 * 不是"暂时没做"，是**授权面不允许**：
 *   1. 列权限只有三列（`admin_id` / `scope` / `revoked_at`）——`granted_by`、`granted_at` 运行时角色
 *      **根本读不到**，硬取必然 `42501`；
 *   2. 就算读到也不该吐：读面回答的是"这台管理员现在能做什么"，`granted_by` 是**授权链**
 *      （谁给的），属审计面（`/admin/audit-logs`）的职责。混进权限读面等于在两个面上各泄露一半。
 *
 * ## 残余限制（如实声明）
 * `list()` 是 **1 + N** 条窄查询（先列账号，再逐个取 scope），不是一次 JOIN。
 * 理由：复用认证存储已有的两条 SQL（连同它们的错误/形状口径），不在这里新造一条跨表 SQL；
 * 后台管理员是受控初始化的少量账号（非批量注册），N 很小。若将来管理员规模变大，
 * 应改成一条 `LEFT JOIN admin_scopes` 的 keyset 分页查询（本片不做，也不假装已做）。
 *
 * ## 错误码：不新增契约错误码
 * 与 `admin/ops/accounts-pg.ts` 的 `mapAccountsReadError()` 同口径：
 *   - `57014` / `55P03`（语句超时/锁超时）⇒ `PROVIDER_TIMEOUT`(504, `retryable: true`)；
 *   - `ApiError` 原样上抛（服务层自己的 403/404/503 不被折成本层错误）；
 *   - 其余（含 `42501` / `42883` / data_exception）⇒ `PROVIDER_UNAVAILABLE`(503, `retryable: false`)：
 *     ⛔ 不降级成空数组/空页（那会被读成"没有管理员"或"这个人没有任何权限"，同样是伪造结论）。
 */
import { ApiError } from '../../errors.ts';
import type { AuthStore } from '../../auth/store.ts';
import type { AdminState } from '../../auth/types.ts';

/**
 * 单个管理员的权限快照：**只有 scope 字符串**。
 *
 * 刻意不带 `revision` / `state`：契约的响应体只有 `scopes`（见
 * `packages/contracts/openapi.json` 的 `AdminAdministratorScopesView`），带着它们只会诱导上层
 * 顺手拼出契约里没有的字段；而 `revision` 属于 `admin_accounts`（账号行自身的修订号），
 * **不是**权限集合的修订号，拿它当权限集合的 `ETag` 会暗示"集合没变"——详见服务层注释。
 */
export interface AdministratorScopesSnapshot {
  readonly scopes: readonly string[];
}

/**
 * 目录项：**契约形状**（`AdminAdministratorView`，snake_case 同 `AdminAccountView` 的既有口径）。
 *
 * `id` = `public.admin_accounts.id`（⛔ 不是 `public.users.id`，见文件头）。
 * `login_name` 是 `admin_accounts` 上**唯一**的人读标签（表里没有 display_name 列），
 * 它本来就在运行时角色的既有列授权内（登录路径必须读它）。
 */
export interface AdministratorView {
  readonly id: string;
  readonly login_name: string;
  readonly state: AdminState;
  readonly scopes: readonly string[];
}

/**
 * 管理员目录 + 权限读面的能力形状（服务层唯一依赖）。
 * `read()` 返回 `null` 表示**该账号不存在**（⇒ 服务层 404），不表示"没有权限"（那是 `{ scopes: [] }`）。
 */
export interface AdminAdministratorsDirectory {
  read(administratorId: string): Promise<AdministratorScopesSnapshot | null>;
  list(): Promise<AdministratorView[]>;
}

/** 存储失败 → 既有契约错误码（不透出驱动原文）。 */
function mapAdministratorsReadError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const code = (error as { code?: unknown })?.code;
  const sqlState = typeof code === 'string' ? code : '';
  if (sqlState === '57014' || sqlState === '55P03') {
    throw new ApiError('PROVIDER_TIMEOUT', '管理员读面查询超时', { retryable: true });
  }
  throw new ApiError('PROVIDER_UNAVAILABLE', '管理员读面暂不可用', { retryable: false });
}

/**
 * 用**认证存储**做管理员目录与权限读面。
 *
 * 构造期**不**探测表/列权限（探测会把"迁移/授权没跑"变成启动期崩溃）；只做形状守卫：
 * 注入对象缺能力 ⇒ 调用期如实 `PROVIDER_UNAVAILABLE`，读面不会伪造成功。
 *
 * 谁可以被读：本函数**不按 `state` 过滤**——`suspended` 的账号也出现在目录里、也能读权限。
 * 理由：读面回答的是"库里登记了什么"，"停用是否等价于权限作废"是写面/停用路径的职责
 * （裁定⑤的最后授权者守卫在那边）。⛔ 本层不替停用路径做结论，也不因此返回 404 ——
 * 悄悄少一行会让运维以为"这台账号不存在"，比如实报 `suspended` 更糟。
 */
export function createAuthStoreAdministratorsDirectory({
  store,
}: {
  store: AuthStore;
}): AdminAdministratorsDirectory {
  function assertUsable(): void {
    if (
      !store
      || typeof store.getAdmin !== 'function'
      || typeof store.listAdminScopes !== 'function'
      || typeof store.listAdmins !== 'function'
    ) {
      throw new ApiError('PROVIDER_UNAVAILABLE', '管理员读面暂不可用', { retryable: false });
    }
  }

  return {
    async read(administratorId: string): Promise<AdministratorScopesSnapshot | null> {
      assertUsable();
      try {
        // 先判存在性：内存 store 的 `listAdminScopes` 对未知 id 返回 `[]`（与 PG 的零行同形），
        // 直接拿它回答会把"不存在"说成"没有任何权限"。
        const admin = await store.getAdmin(administratorId);
        if (admin === null) return null;
        const scopes = await store.listAdminScopes(administratorId);
        return { scopes };
      } catch (error) {
        throw mapAdministratorsReadError(error);
      }
    },

    async list(): Promise<AdministratorView[]> {
      assertUsable();
      try {
        const admins = await store.listAdmins();
        const items: AdministratorView[] = [];
        for (const admin of admins) {
          items.push({
            id: admin.id,
            login_name: admin.loginName,
            state: admin.state,
            scopes: await store.listAdminScopes(admin.id),
          });
        }
        return items;
      } catch (error) {
        throw mapAdministratorsReadError(error);
      }
    },
  };
}
