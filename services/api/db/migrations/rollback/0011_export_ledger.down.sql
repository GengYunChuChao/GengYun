-- ============================================================================
-- 0011_export_ledger 回滚（运维脚本；不在迁移运行器的正向发现集内）
-- 仅撤销本迁移新增的对象；不触碰 0003 的既有列与约束。
-- ============================================================================
BEGIN;

DROP INDEX IF EXISTS public.export_writebacks_user_idx;
DROP TABLE IF EXISTS public.export_writebacks;

DROP INDEX IF EXISTS public.exports_cancelled_object_idx;
DROP INDEX IF EXISTS public.exports_job_idx;
ALTER TABLE public.exports DROP CONSTRAINT IF EXISTS exports_cancelled_pair;

ALTER TABLE public.exports
  DROP COLUMN IF EXISTS cancellation_reason,
  DROP COLUMN IF EXISTS cancelled_at,
  DROP COLUMN IF EXISTS job_id,
  DROP COLUMN IF EXISTS error_code,
  DROP COLUMN IF EXISTS revision;

COMMIT;
