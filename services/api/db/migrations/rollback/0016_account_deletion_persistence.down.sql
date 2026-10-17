-- GY-I19（#19）· `0016_account_deletion_persistence.sql` 的回滚
--
-- 与既有回滚脚本同风格（见 `services/api/db/migrations/rollback/0003_privacy_consent.down.sql`）：
-- 先删本迁移**新增**的对象，绝不触碰 0003 建立的表/列/索引/约束。
--
-- 回滚后的期望读数（真 PG 实测，见交接「迁移三连」）：
--   - `to_regprocedure('public.request_account_deletion(uuid,uuid,text,integer,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz)')` ⇒ NULL；
--   - `information_schema.columns` 中 `deletion_requests` 的 `user_id`/`receipt_issued_at`/`receipt_expires_at` ⇒ 0 行；
--   - `pg_indexes` 中 `deletion_requests_user_requested_idx` ⇒ 0 行；
--   - `pg_constraint` 中 `deletion_requests_receipt_validity` ⇒ 0 行；
--   - `deletion_requests` 表本身及其 0003 既有列/唯一索引 ⇒ **仍在**（本回滚不删表）。
-- 说明：`user_id` 列被 `DROP COLUMN` 时其外键约束随之消失（PG 语义），故无需单独 DROP CONSTRAINT。
BEGIN;

DROP FUNCTION IF EXISTS public.request_account_deletion(uuid,uuid,text,integer,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz);

ALTER TABLE public.deletion_requests
  DROP CONSTRAINT IF EXISTS deletion_requests_receipt_validity;

DROP INDEX IF EXISTS public.deletion_requests_user_requested_idx;

ALTER TABLE public.deletion_requests
  DROP COLUMN IF EXISTS receipt_expires_at,
  DROP COLUMN IF EXISTS receipt_issued_at,
  DROP COLUMN IF EXISTS user_id;

COMMIT;
