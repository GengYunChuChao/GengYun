-- 回滚：`0022_community_persistence.sql`（社区域六张表）。
--
-- 纯新增迁移 ⇒ 可直接整表拆除：本迁移**没有**改动 0001 起的任何既有表、索引、枚举或数据，
-- 也没有从既有表向本域方向的外键（本域只有指向 `users` 的外键），因此回滚后库结构与
-- 「应用 0022 之前」完全一致。`users` 是本域外键的**被引用方**，回滚不触碰它。
--
-- 数据代价：帖子、评论、点赞、举报、审核结论台账与本域幂等台账内容一并丢弃
-- （这是回滚的定义，不是副作用）。
--
-- 顺序：先拆引用方（评论 → 点赞/举报/结论 → 帖子），按建表逆序写即可；索引随表一起消失。
BEGIN;

DROP TABLE IF EXISTS public.community_idempotency;
DROP TABLE IF EXISTS public.community_moderation_decisions;
DROP TABLE IF EXISTS public.community_reports;
DROP TABLE IF EXISTS public.community_likes;
DROP TABLE IF EXISTS public.community_comments;
DROP TABLE IF EXISTS public.community_posts;

COMMIT;
