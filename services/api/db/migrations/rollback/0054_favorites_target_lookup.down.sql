-- 回滚 0054_favorites_target_lookup.sql（收藏反查索引）。
--
-- 只拆本迁移加的那一个索引：`favorites_target_lookup_idx`。
-- **不碰** 0018 建的表/列/约束/唯一索引，也不改 `0054` 的正文字节（checksum 必须保持）。
--
-- 行为影响（说清楚，别当成副作用）：删掉索引后 `favorites/store-pg.ts` 的
-- `listOwnerIdsByTarget`（按 `(target_type, target_id)` 找收藏者）仍**照常返回正确答案**，
-- 只是从「只扫索引」退化成「整表扫描」。⇒ 回滚不改变任何可见行为与消息去重语义，
-- 只损失一次后台撤回通知计算的性能。这也是为什么本回滚**不需要** 0045/0047/0049 那种
-- `RAISE EXCEPTION` 预检（那些是为了挡住「删掉人工审核的溯源证据」；删索引不构成事实损失）。
--
-- `IF EXISTS`：回滚重跑一次应当无害（与 `rollback/0040`/`0041`/`0042`/`0051`/`0052` 同风格）。
BEGIN;

DROP INDEX IF EXISTS public.favorites_target_lookup_idx;

COMMIT;
