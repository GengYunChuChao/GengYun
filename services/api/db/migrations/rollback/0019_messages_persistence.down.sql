-- 回滚 0019_messages_persistence.sql：**只**撤销本迁移创建的对象。
--
-- 顺序：drop index → drop table（表上的唯一约束索引随表一起消失，
-- 因此不再单独 drop，也不会碰到任何他人对象）。
-- 0008 的 `public.idempotency_keys` 是既有表（本迁移只复用它，未改其结构）⇒ 不清空、不删除。
BEGIN;

DROP INDEX IF EXISTS messages_owner_created_idx;
DROP TABLE IF EXISTS messages;

COMMIT;
