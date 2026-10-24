-- 回滚 0038_r34_deletion_receipt_persistence.sql
--
-- 逆序撤销：先删函数（依赖列/索引）、再删索引、再删列。与正向逐项互逆。
BEGIN;

DROP FUNCTION IF EXISTS public.count_deletion_receipts();
DROP FUNCTION IF EXISTS public.resolve_deletion_receipt(text);
DROP FUNCTION IF EXISTS public.set_deletion_receipt(uuid,text,timestamptz,timestamptz);

DROP INDEX IF EXISTS deletion_requests_receipt_bearer_hash_key;

ALTER TABLE public.deletion_requests DROP COLUMN IF EXISTS receipt_bearer_hash;

COMMIT;
