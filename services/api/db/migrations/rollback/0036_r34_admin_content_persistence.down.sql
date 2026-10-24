-- 回滚：`0036_r34_admin_content_persistence.sql`（后台内容/资料域 PostgreSQL 落点）。
--
-- 顺序：本迁移只**新增**三张表与三条索引，回滚就是把它们删掉，倒序执行：
--   ① `admin_content_idempotency`（幂等台账，无外键依赖）；
--   ② `admin_content_revisions`（版本行，`entity_id` 外键指向实体行）；
--   ③ `admin_content_entities`（实体行，被 ② 引用 ⇒ 必须最后删）。
-- 索引随表 `DROP`（`DROP TABLE` 连带它的索引），所以不单列 `DROP INDEX`：重复 `DROP INDEX`
-- 只会制造一次「不存在」的噪音。`IF EXISTS` 让回滚对「从未跑过本迁移」的库也是幂等的。
-- 数据代价：**本域内容行全部消失**。这是回滚一个「新域落库」迁移的固有代价，不是隐藏副作用：
--   接线随之退回 `PROVIDER_UNAVAILABLE`（503）而不是伪造空页 —— 与接线前逐字相同。
--   既有域的表（sources / knowledge_versions / registrations / restriction_rules / 审计）一律不碰。
BEGIN;

DROP TABLE IF EXISTS public.admin_content_idempotency;
DROP TABLE IF EXISTS public.admin_content_revisions;
DROP TABLE IF EXISTS public.admin_content_entities;

COMMIT;