-- GY-I19（#19）· `0057_deidentify_account_on_deletion.sql` 的回滚
--
-- 与既有回滚脚本同风格（见 `services/api/db/migrations/rollback/0016_account_deletion_persistence.down.sql`）：
-- 只删本迁移**新增**的对象，绝不触碰 0001/0003/0015 建立的表、列、索引、约束。
--
-- 回滚后的期望读数（真 PG 实测口径）：
--   - `to_regprocedure('public.deidentify_account(uuid)')` ⇒ NULL；
--   - `pg_proc` 里 `proname = 'deidentify_account'` ⇒ 0 行；
--   - `public.users` / `public.exports` 的列与约束**仍在**（本回滚不删列、不改数据）；
--   - 已擦除的 PII **不会**被回滚恢复（擦除是单向承诺，回滚只撤函数不撤事实）。
BEGIN;

DROP FUNCTION IF EXISTS public.deidentify_account(uuid);

COMMIT;
