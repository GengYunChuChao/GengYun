-- GY-I22（#22）· `0017_account_suspend_authority.sql` 的回滚
--
-- 与既有回滚脚本同风格（见 `services/api/db/migrations/rollback/0016_account_deletion_persistence.down.sql`）：
-- 先删本迁移**新增**的对象，绝不触碰 0001/0016 建立的表/列/枚举/索引/约束。
--
-- 回滚后的期望读数（真 PG 实测，见交接「迁移三连」）：
--   - `to_regprocedure('public.suspend_account(uuid,uuid,uuid,integer,uuid)')` ⇒ NULL；
--   - `to_regprocedure('public.restore_account(uuid,uuid,uuid,integer,uuid)')` ⇒ NULL；
--   - `to_regprocedure('public.admin_account_display_name(text,uuid)')` ⇒ NULL；
--   - `to_regprocedure('public.admin_audit_events_reject_mutation()')` ⇒ NULL；
--   - `to_regclass('public.admin_audit_events')` ⇒ NULL（表与两个索引随 DROP TABLE 消失）；
--   - `public.users` / `public.sessions` 及其 0001 既有列、约束、索引 ⇒ **仍在**（本回滚不触碰它们）。
--
-- 注意：审计台账一旦有数据，本回滚会**丢弃历史审计行**（DROP TABLE 语义）。
-- 生产回滚必须在停机窗口内、先导出 `admin_audit_events` 再执行；本脚本不代做备份。

BEGIN;

-- 触发器随表 DROP，但先显式删掉以免依赖"表级联"的隐含语义。
DROP TRIGGER IF EXISTS admin_audit_events_append_only ON public.admin_audit_events;
DROP FUNCTION IF EXISTS public.admin_audit_events_reject_mutation();

DROP FUNCTION IF EXISTS public.restore_account(uuid, uuid, uuid, integer, uuid);
DROP FUNCTION IF EXISTS public.suspend_account(uuid, uuid, uuid, integer, uuid);
DROP FUNCTION IF EXISTS public.admin_account_display_name(text, uuid);

DROP TABLE IF EXISTS public.admin_audit_events;

COMMIT;
