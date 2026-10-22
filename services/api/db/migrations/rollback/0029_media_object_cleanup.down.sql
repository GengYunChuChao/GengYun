-- 回滚 0029_media_object_cleanup.sql。
--
-- 纯新增迁移 ⇒ 整表 DROP。本表**不**被任何既有表引用（刻意不建外键：待清理台账的生命周期
-- 必须独立于 media 行，见正向迁移头注），故回滚不触及任何既有对象或数据。
--
-- ⚠️ 回滚会把「未确认删除的对象」的可重试清理依据一并删掉（这正是该表的语义）。
-- 生产上执行本回滚前，应先跑一次 `cleanupOrphans()` 收敛，或接受这些对象重新变成孤儿。
BEGIN;

DROP TABLE IF EXISTS public.media_object_cleanup;

COMMIT;
