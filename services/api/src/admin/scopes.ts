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
 * 若维持反推，任何"只有库层认识、应用层暂无端点"的 scope（PR-1 当时的 `scopes:write` 就是
 * 这一例）都会在应用层**无处声明**。
 *
 * ## 口径（逐条与裁定/迁移对齐）
 * - 13 项 = 契约 enum 去掉面向终端用户的 `user`（那是路由访问标记 `x-scope: user`，不是
 *   可授予的后台权限）后，再加 `scopes:read` / `scopes:write` 两个元权限；
 * - 与 `0041:177-194` 的 `admin_scopes_scope_closed_set` CHECK **逐字同源**：容器里比的是
 *   同一批字符串，顺序也按码元序；
 * - `public` / `receipt` 是**路由访问标记**（`services/api/src/auth/middleware.ts` 的
 *   `ACCESS_MARKERS`），不是可授予权限 ⇒ 不在闭集内；
 * - ⛔ 本文件只是**声明**（不承载实现）。授权/撤销的**唯一写路径**是迁移 0041 的两条
 *   `SECURITY DEFINER` 函数（`public.grant_admin_scope` / `public.revoke_admin_scope`）：
 *   PR-3 落的两条写端点（`grantAdministratorScope` / `revokeAdministratorScope`）只是这两条
 *   函数的搬运层，**授/撤路径**不直写 `admin_scopes`（限定在这里：`services/api/src/auth/store.ts`
 *   的 `createPgAuthStore().createAdmin` 建管理员账号时会 `INSERT INTO admin_scopes` 写初始 scope，
 *   那属账号创建侧，不属授/撤路径——⛔ 别把这句话写成不带限定的绝对句）。
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
 * 管理授权（授/撤他人 scope）。PR-1 的库层已把它写进 CHECK，PR-3 落了写端点。
 *
 * **已实现**（写面对照表；早前这里写的是"只声明、不实现"——那句是谎话，⛔ 别再写回去）：
 * `services/api/src/routes/admin.ts` 里以 `scopes:write` 为门的操作共 4 个 operationId
 * （门值来自 `services/api/src/admin/ops/service.ts` 的 `OPS_SCOPES`，四条都是 `scopes:write`）：
 *   1. `grantAdministratorScope` —— `POST /admin/administrators/{id}/scopes`
 *      （写路径＝迁移 0041 的 `grant_admin_scope`）
 *   2. `revokeAdministratorScope` —— `DELETE /admin/administrators/{id}/scopes/{scope}`
 *      （写路径＝迁移 0041 的 `revoke_admin_scope`）
 *   3. `disableAdministratorAccount` —— `POST /admin/administrators/{id}/disable`
 *      （写路径＝迁移 0048）
 *   4. `enableAdministratorAccount` —— `POST /admin/administrators/{id}/enable`（同上）
 * 前两条授/撤 scope；后两条只改管理员**账号状态**（⛔ 不撤 scope、⛔ 不新增 scope 值）。
 * 判别力在 `tests/unit/session-scopes-s1.test.mjs` 的 ③，三层夹住（B1 前只有前两层，四处写面门
 * 摘掉一处仍全绿，那句话当时是假的）：
 *   1. 门集合：`operations.json` 引用了哪个 scope，routes 层就必须真有一处以它为实参的 `requireScope`；
 *   2. 计数：以 `scopes:write` 为实参的 `requireScope` 调用条数，必须等于 `operations.json` 里
 *      声称实现它的 operation 条数（期望值从 manifest 派生，不写死 4）；
 *   3. 逐个 operationId：源码里仍须有 `requireScope(OPS_SCOPES.<operationId>)` —— 上面两条管
 *      "有没有、够不够数"，这条管"是哪一条"，防两处门互相抵消。
 * 即：本 scope 的**任一**写面门被改值或摘掉，③ 都会红（实测记录见该用例的注释）。
 */
export const ADMIN_SCOPES_WRITE_SCOPE = 'scopes:write';

const ADMIN_SCOPE_SET: ReadonlySet<string> = new Set<string>(ADMIN_SCOPES);

/** 值是否落在闭集内（形状守卫用；非字符串一律 `false`，不抛异常）。 */
export function isAdminScope(value: unknown): value is AdminScope {
  return typeof value === 'string' && ADMIN_SCOPE_SET.has(value);
}
