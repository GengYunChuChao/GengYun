-- ============================================================================
-- GY-R34 / #22 片C · 「在途取消」：deletion_state 枚举增「cancelled」
-- ----------------------------------------------------------------------------
-- 依赖：0003（GY-I27 建 deletion_state 枚举 requested/processing/blocked/completed）。
--      本迁移只追加一个枚举值，不改表、不改列、不加约束、不搬数据、不加任何权限。
--
-- 语义：cancelled = 用户在「在途」阶段（requested / processing / blocked）主动取消注销；
--       与 completed 同属终态 —— 不可再取消、不可被迟到回调复活。
--
-- 应用层闭集同步（本片一并改，缺一即漂）：
--   · packages/contracts/states.json            DeletionState
--   · packages/contracts/openapi.json           DeletionState enum + cancel-deletion 操作
--   · packages/privacy/constants.mjs            DELETION_STATES
--   · services/api/src/privacy/account-deletion.ts  DELETION_STATES 白名单
--   · packages/privacy/deletion.mjs             completionStatus 状态机
--
-- 可回滚性：PG 的 ALTER TYPE ... ADD VALUE **不可回滚** —— 全版本均无 DROP VALUE，
--       删除单个枚举值只能重建整个类型（并连带重建引用它的表列与约束），不满足
--       「回滚一步迁移」语义。rollback 文件如实标注「不可回滚」，⛔ 不伪装可回滚。
--
-- 事务：PG 12+ 允许在事务块内执行 ADD VALUE（新值在提交前不可用于本事务），
--      本机/CI 为 PG 17.11，故与既有迁移同风格写 BEGIN/COMMIT。
-- ============================================================================
BEGIN;

ALTER TYPE deletion_state ADD VALUE 'cancelled';

COMMIT;
