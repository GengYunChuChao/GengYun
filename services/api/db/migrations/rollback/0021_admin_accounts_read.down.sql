-- GY-I18（#18）· `0021_admin_accounts_read.sql` 的回滚
--
-- 与既有回滚脚本同风格（见 `0017_account_suspend_authority.down.sql`）：
-- 只删本迁移**新增**的对象，⛔ 不触碰 0001/0016/0017 建立的表、列、枚举、索引、函数。
--
-- 回滚后的期望读数（真 PG 实测，见交接「迁移三连」）：
--   - `to_regprocedure('public.list_admin_accounts()')` ⇒ NULL；
--   - `to_regprocedure('public.admin_account_display_name(text,uuid)')` ⇒ **仍在**（0017 的对象）；
--   - `public.users` 及 0001 既有列 ⇒ **仍在**（本回滚不触碰它们）。

BEGIN;

DROP FUNCTION IF EXISTS public.list_admin_accounts();

COMMIT;
