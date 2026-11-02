-- 回滚 0052_moderation_conclusion_facts.sql（审核台账的结论时刻列 + 读面索引）。
--
-- 只拆本迁移加的两样东西：`moderation_decisions.concluded_at` 列与
-- `moderation_decisions_target_concluded_idx` 索引。**不碰** 0028 建的行/列/约束/索引，
-- 也不改 `0028_moderation_persistence.sql` 的正文字节（checksum 必须保持）。
--
-- 索引随 `DROP COLUMN` 一起消失（PG 删列会连带删掉引用该列的索引），
-- 这里仍显式 `DROP INDEX IF EXISTS` 兜底：回滚是「撤离」路径，不该因为
-- 「索引已不在」而把整个回滚卡死（与 `rollback/0040`/`0041`/`0042`/`0051` 同风格）。
--
-- 数据代价（说清楚，别当成副作用）：`concluded_at` 里现有的时刻值会一并丢弃。
-- 这一点**可以接受**，因为它不是原始证据、而是可重算的派生值：
--   · 存量已审行的值 = 回填时的 `updated_at`（回滚后照旧能从那列读回来）；
--   · 迁移后新判定的行本来就靠读面 `COALESCE(concluded_at, updated_at)` 的右半边兜底，
--     回滚后行为不变。
-- 所以这里**不需要** 0045/0047/0049 那种 `RAISE EXCEPTION` 预检（那些是为了拦住
-- 「删掉人工审核的溯源证据」）；删掉一列可重算的派生时刻不构成证据损失。
--
-- 行为影响（回滚会改变判定，不只是改结构）：列与索引消失后，W54 的读面
-- （`ledger-pg.ts` 的 `CONCLUSION_FACTS_SQL`）会因为缺列而返回空数组并记一次 warn
-- （fail-closed：拿不到事实 ⇒ 少判 `RESCREEN_REQUIRED`，不会误放行、也不会 500）。
-- ⇒ 正确顺序是「先回滚到不装该端口的应用版本，再回滚本迁移」。
BEGIN;

-- ---------------------------------------------------------------------------
-- ① 读面索引
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.moderation_decisions_target_concluded_idx;

-- ---------------------------------------------------------------------------
-- ② 结论时刻列（`IF EXISTS`：回滚重跑一次应当无害）
-- ---------------------------------------------------------------------------
ALTER TABLE public.moderation_decisions
  DROP COLUMN IF EXISTS concluded_at;

COMMIT;
