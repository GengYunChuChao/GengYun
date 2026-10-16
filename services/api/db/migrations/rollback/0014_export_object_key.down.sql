-- 迁移 0014 回滚：撤销「文本型对象标识列」（与 migrations/rollback/0011_export_ledger.down.sql 同形）。
--
-- 顺序与 0014 上行相反：先删索引，再删约束，最后删列。
-- 注意：一旦有非媒体维行写入（object_key 非空），回滚会**丢弃这些行的对象标识**
--   —— 这正是回滚的语义（该维度由 0014 引入）；回滚后账本回到「只支持 uuid 对象标识」的状态。
BEGIN;

DROP INDEX IF EXISTS public.exports_object_key_idx;

ALTER TABLE public.exports
  DROP CONSTRAINT IF EXISTS exports_object_ident_xor;

ALTER TABLE public.exports
  DROP COLUMN IF EXISTS object_key;

COMMIT;
