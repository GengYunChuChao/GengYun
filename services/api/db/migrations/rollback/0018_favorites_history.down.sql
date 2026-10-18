-- 回滚：`0018_favorites_history.sql`（收藏 / 历史 / 两张幂等台账）。
--
-- 纯新增迁移 ⇒ 可直接整表拆除：本迁移**没有**改动任何既有表、既有索引或既有数据，
-- 也没有跨迁移外键，因此回滚后库结构与 0016 之后完全一致。
-- 唯一的数据代价是：收藏行、历史行与幂等台账内容一并丢弃（这是回滚的定义，不是副作用）。
--
-- 顺序：先拆后建依赖方（两张台账与 `history` 没有互相引用，按建表逆序写即可）。
BEGIN;

DROP TABLE IF EXISTS public.history_idempotency;
DROP TABLE IF EXISTS public.favorites_idempotency;
DROP TABLE IF EXISTS public.history;
DROP TABLE IF EXISTS public.favorites;

COMMIT;
