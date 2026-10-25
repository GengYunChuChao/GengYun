-- 回滚 0041_admin_scope_write_authority.sql
--
-- 逆序撤销：先删两个写路径函数（它们是唯一写入方），再删闭集约束；约束先在则删约束不会失败，
-- 但先删函数更贴近「先摘掉写入口，再放开取值面」的运维直觉。与正向逐项互逆。
--
-- 注意：本回滚**不**回填任何数据、不删除 `admin_scopes` 行、不触碰审计台账（属主无法改审计，
-- 见 `0017` 的 append-only 触发器）；也不动 `20-login-roles.sql` 里的 `EXECUTE` 授权 ——
-- 函数不在时该授权语句会因 `to_regprocedure(...) IS NULL` 的硬前置直接报错，这是设计好的
-- 显式失败（顺序：先回滚部署 SQL 的该区域，再回滚本迁移；生产回滚顺序由 runbook 约束）。
BEGIN;

DROP FUNCTION IF EXISTS public.revoke_admin_scope(uuid, uuid, text, text, uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.grant_admin_scope(uuid, uuid, text, text, uuid, uuid, integer);

ALTER TABLE public.admin_scopes
  DROP CONSTRAINT IF EXISTS admin_scopes_scope_closed_set;

COMMIT;
