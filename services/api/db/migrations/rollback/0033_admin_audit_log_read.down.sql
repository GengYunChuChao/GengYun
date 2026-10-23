-- 回滚：`0033_admin_audit_log_read.sql`（管理端审计日志只读函数）。
--
-- 顺序：本迁移只新增了**一个函数**，回滚就是把它删掉。
--   ① 删只读函数 `public.list_admin_audit_logs(...)`（连同它的 EXECUTE 授权）；
--   ② 不动表、不动索引、不动既有读函数 `list_admin_flag_audit`、不动任何审计行。
-- 数据代价：无。审计行本身（id/actor_id/action/…/created_at）**不删、不改**，与 `0017` 的
--   「只可追加」口径一致；回滚只是让这条读路径消失（HTTP 面随之 503 `PROVIDER_UNAVAILABLE`，
--   与接线前逐字相同，不会伪造空页）。
BEGIN;

DROP FUNCTION IF EXISTS public.list_admin_audit_logs(
  integer, timestamptz, timestamptz, text[], text[], timestamptz, uuid
);

COMMIT;
