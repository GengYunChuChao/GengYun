/**
 * 后台审计日志查询面（`GET /admin/audit-logs`）的枚举**单一来源**（R34 切片 · Refs #18）。
 *
 * ## 为什么枚举不写死在路由/契约两处
 * 查询参数 `action` / `entity` 的闭集**不是**从契约里编出来的，而是从「谁在写这张表」反推的。
 * 今天往 `public.admin_audit_events` 落库写审计的地方只有三处（全部在 `services/api/db/migrations/`）：
 *
 * | 写入点（库内函数） | `action` | `scope`（查询参数 `entity` 的取值来源） | 迁移 |
 * | --- | --- | --- | --- |
 * | `public.suspend_account(...)`  | `account.suspend` | `accounts:suspend` | 0017 |
 * | `public.restore_account(...)`  | `account.restore` | `accounts:suspend` | 0017 |
 * | `public.set_feature_flag(...)` | `set_flag`        | `flags:write`      | 0020 / 0027 |
 *
 * `account.suspend` 与 `account.restore` 共用同一个 `scope`，因此 `entity=account` 一次取回
 * 「停用 + 恢复」两类行；`entity=flag` 只取开关变更。**未知取值一律 400**（fail-closed）：
 * ⛔ 不静默返回空页 —— 空页会被读成「平台从未发生过这类操作」，那是一条无法确认的结论。
 *
 * 本文件同时是「枚举与契约/台账保持一致」的锚点：`tests/unit/admin-audit-logs-contract.test.mjs`
 * 逐项核对这里的三张表与 `packages/contracts/openapi.json` 的 `parameters` 枚举、
 * `operations.json` 的 `scope`，以及迁移里的写入语句。
 */

/** 账号停用（迁移 0017 `public.suspend_account`）。 */
export const AUDIT_ACTION_ACCOUNT_SUSPEND = 'account.suspend';
/** 账号恢复（迁移 0017 `public.restore_account`）。 */
export const AUDIT_ACTION_ACCOUNT_RESTORE = 'account.restore';
/** 功能开关变更（迁移 0020，0027 同签名替换）。 */
export const AUDIT_ACTION_SET_FLAG = 'set_flag';

/** `GET /admin/audit-logs` 的 `action` 闭集（= 库内写入点的 `action` 列取值）。 */
export const AUDIT_ACTIONS = Object.freeze([
  AUDIT_ACTION_ACCOUNT_SUSPEND,
  AUDIT_ACTION_ACCOUNT_RESTORE,
  AUDIT_ACTION_SET_FLAG,
] as const);

export type AdminAuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * `entity` → 审计表 `scope` 列。
 *
 * 用「域名词」而不是直接暴露 `scope` 字符串，是因为 `scope` 是**权限命名空间**的形状
 * （`accounts:suspend` 里的 `:suspend` 是动作），而审计日志的使用者关心的是「哪一类对象」。
 * 映射关系只在这里写一遍：路由层与服务层都不许再抄一份。
 */
export const AUDIT_ENTITY_SCOPES = Object.freeze({
  account: 'accounts:suspend',
  flag: 'flags:write',
} as const);

export type AdminAuditEntity = keyof typeof AUDIT_ENTITY_SCOPES;

/** `GET /admin/audit-logs` 的 `entity` 闭集（= `AUDIT_ENTITY_SCOPES` 的键）。 */
export const AUDIT_ENTITIES: readonly AdminAuditEntity[] = Object.freeze(
  Object.keys(AUDIT_ENTITY_SCOPES) as AdminAuditEntity[],
);

/** `entity` → 库内 `scope` 列取值；调用方必须先判 `entity` 属于闭集。 */
export function scopeOfAuditEntity(entity: AdminAuditEntity): string {
  return AUDIT_ENTITY_SCOPES[entity];
}

/**
 * 游标里记的 `family`。
 *
 * 与 `flag_audit` 分开是必要的：两类审计读面各有自己的筛选维度，共用 `family` 会让
 * 「用开关留痕的游标去翻通用审计」这种串用悄悄通过。
 */
export const AUDIT_LOG_CURSOR_FAMILY = 'audit_logs';

/** 权限 scope（复用既有后台 scope，不新造一套鉴权）。 */
export const AUDIT_LOG_SCOPE = 'audit:read';

/** 本片对外的唯一 operationId。 */
export const AUDIT_LOG_OPERATION_ID = 'listAuditLogs';
