-- 回滚：`0024_user_backup_copies.sql`（逐用户备份副本域）。
--
-- 纯新增迁移 ⇒ 可安全整表拆除：本迁移**没有**改动任何既有表、既有索引或既有数据，
-- 也没有跨迁移外键（`request_id` 只指向既有 `deletion_requests`，本迁移不反向改它）。
-- 因此回滚后库结构与 0018 之后完全一致。
--
-- 唯一的数据代价：这一域的副本清单行（含清除证据）一并丢弃——这是回滚的定义，不是副作用。
-- 注意：`request_id` 上的 `ON DELETE RESTRICT` 只约束「删 `deletion_requests` 行」，
-- 不约束拆表本身；反过来，先 DROP 本表再删请求行是允许的（回滚场景正常）。
BEGIN;

DROP TABLE IF EXISTS public.user_backup_copies;

COMMIT;
