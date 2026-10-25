/**
 * `#18` S2 · 后台管理员权限（scope）的**应用层闭集**——本仓 `services/api/src/**` 里唯一的
 * 硬编码出处。
 *
 * ## 为什么要有这个文件
 * 闭集原先只存在于三处**互不引用**的地方：
 *   1. `packages/contracts/openapi.json` 的 `SessionInfo.scopes.items.enum`（机器可读的唯一出处，
 *      但它描述的是**会话声明**，不是"可授予权限"的登记表）；
 *   2. 库层 CHECK 约束（`services/api/db/migrations/0041_admin_scope_write_authority.sql`，
 *      PR-1 已合入 main）——库是最终裁判，却不是应用层能 `import` 的东西；
 *   3. 断言侧 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的第 104 条（从约束定义里
 *      抽字符串字面量比对）。
 * 应用层的"闭集"此前只能靠 `tests/unit/session-scopes-s1.test.mjs` 在**测试期**从
 * `OPS_SCOPES` / `FAMILIES` / `AUDIT_LOG_SCOPE` / `BOOTSTRAP_ADMIN_SCOPES` / 路由字面量
 * **反推**出来。反推适合当"钉子"，但不能当**运行时**的出口守卫：读面要把库里的 scope 串
 * 直接吐给调用方，必须能在**返回之前**判断"这个值是否在闭集内"。
 *
 * 因此本文件把闭集收敛成一处**可 import 的常量**，并用测试把它钉在推导集与契约 enum 上
 * （`tests/unit/session-scopes-s1.test.mjs` 新增 `ADMIN_SCOPES === codeAdminScopes()`）。
 * 收敛理由：新增一个 scope 时，改这一处 + 契约 enum + 库层约束（新迁移）三处即可；
 * 若维持反推，任何"只有库层认识、应用层暂无端点"的 scope（本次的 `scopes:write`）都会
 * 在应用层**无处声明**。
 *
 * ## 口径（逐条与裁定/迁移对齐）
 * - 13 项 = 契约 enum 去掉面向终端用户的 `user`（那是路由访问标记 `x-scope: user`，不是
 *   可授予的后台权限）后，再加 `scopes:read` / `scopes:write` 两个元权限；
 * - 与 `0041:177-194` 的 `admin_scopes_scope_closed_set` CHECK **逐字同源**：容器里比的是
 *   同一批字符串，顺序也按码元序；
 * - `public` / `receipt` 是**路由访问标记**（`services/api/src/auth/middleware.ts` 的
 *   `ACCESS_MARKERS`），不是可授予权限 ⇒ 不在闭集内；
 * - ⛔ 本文件只是**声明**。授权/撤销的唯一写路径是迁移 0041 的两条 `SECURITY DEFINER` 函数
 *   （`public.grant_admin_scope` / `public.revoke_admin_scope`），应用层此前**没有**、本片也
 *   **不加**任何写端点到 `admin_scopes`。
 */
export const ADMIN_SCOPES = Object.freeze([
  'accounts:read',
  'accounts:suspend',
  'audit:read',
  'flags:read',
  'flags:write',
  'jobs:cancel',
  'jobs:read',
  'scopes:read',
  'scopes:write',
  'session:logout',
  'session:read',
  'sources:read',
  'sources:write',
] as const);

/** 闭集里的单个 scope（字面量联合；`ADMIN_SCOPES` 的成员类型）。 */
export type AdminScope = (typeof ADMIN_SCOPES)[number];

/**
 * 读他人权限（`#18` S2 PR-2，本片新增）。命令式地叫 `READ`，避免与"scope 自身是否可读"混淆。
 *
 * 语义：`GET /admin/administrators/{id}/scopes` 的门。**不等于** `accounts:read`——
 * 裁定④明确"持 `accounts:read` 不自动获得查看他人权限的能力"，两者是不同能力。
 */
export const ADMIN_SCOPES_READ_SCOPE = 'scopes:read';

/**
 * 管理授权（授/撤他人 scope）。PR-1 的库层已把它写进 CHECK，PR-3 才落写端点。
 *
 * 本片**只声明、不实现**：`services/api/src/routes/admin.ts` 里不存在任何以
 * `scopes:write` 为门的操作（`tests/unit/session-scopes-s1.test.mjs` 的 `DECLARED_ONLY_SCOPES`
 * 把这条差异钉住）。
 */
export const ADMIN_SCOPES_WRITE_SCOPE = 'scopes:write';

const ADMIN_SCOPE_SET: ReadonlySet<string> = new Set<string>(ADMIN_SCOPES);

/** 值是否落在闭集内（形状守卫用；非字符串一律 `false`，不抛异常）。 */
export function isAdminScope(value: unknown): value is AdminScope {
  return typeof value === 'string' && ADMIN_SCOPE_SET.has(value);
}
