-- GY-R72 W54 · 审核台账的**结论时刻**（`public.moderation_decisions.concluded_at`）。
--
-- ## 谁写它
-- 只有本迁移末尾那一条**一次性回填**（`UPDATE … WHERE decision = 'approved' AND concluded_at IS NULL`）。
-- 运行时的 INSERT / UPDATE 都**不写**这一列 —— `deploy/postgres-cvm/sql/20-login-roles.sql` 段 M3
-- 本片只增加了 SELECT 列，没有给它 UPDATE 授权（见下面「为什么本片不写它」）。
--
-- ## 谁读它
-- `services/api/src/moderation/ledger-pg.ts` 的 `createPostgresConclusionFacts()`
-- （常量 `MODERATION_CONCLUDED_ASSESSMENTS_SQL`，一条**只读** SELECT），
-- 经 `services/api/src/moderation/conclusion-facts.ts` 的 `ModerationConclusionFactsPort`
-- 接到 `service.ts` 的结论新鲜度判定上。**这条读面只回答「已发布结论该不该重评」，
-- 不回答「能不能看」** —— 可见性判定（`present` / `effectiveState`）一行未动。
--
-- ## 为什么需要（不是「顺手加一列」）
-- 结论新鲜度（`RESCREEN_REQUIRED`）此前**只**从内存台账派生：`service.ts:1094-1104` 拿
-- `ledger.forRevision(target)`，而 PG 台账的 `forRevision` 只答本进程写过的行
-- （`ledger-pg.ts:48-51` 关于「存量任务行不回填」的决策针对的是**可见性**，本片不改它）。
-- 结果是：进程一重启，内存空 ⇒ `staleReasons` 恒空 ⇒ 规则/模型/prompt 版本前进之后，
-- 已发布内容**再也不会**被判 `RESCREEN_REQUIRED`。本迁移给出跨进程可读的「结论事实」，
-- 让重评判定不再依赖本进程是否还记得那次结论。
--
-- ## 为什么本片不写它（写面留白，读面先成立）
-- 写 `concluded_at` 需要 UPDATE 列级授权；本片按派单 §1.2 **只加 SELECT**（授权面越小越好，
-- 且写面改动要连带改 `ledger-pg.ts` 的 UPDATE_SQL 与三处授权复述，属于另一片）。
-- 因此读面用 `COALESCE(concluded_at, updated_at)` 取时刻：
--   · 存量已审行 ⇒ 回填值（= 回填那一刻的 `updated_at`）；
--   · 迁移之后新判定的行 ⇒ `updated_at` 兜底（终态行的最后一次写就是那次判定）。
-- 即：**本列缺席不会造成盲区**；将来写面补上精确值之后，读面无需再改即可自动用上。
-- ⚠ 口径要说清：`updated_at` 是「该行最后一次写」的近似，不是严格意义的判定瞬间；
--    `concluded_at` 一旦由写面落值就以它为准（`COALESCE` 的左侧）。
--
-- ## 形制
-- 1. `concluded_at timestamptz`，**可空、无默认值**：存量行与「还没有结论」的行必须留 NULL ——
--    NULL 的语义是「不知道/还没有结论」，绝不能用 `NOT NULL DEFAULT now()` 伪造成「刚刚结论」。
-- 2. 索引 `moderation_decisions_target_concluded_idx (target_type, target_id, target_revision,
--    concluded_at DESC)`：读面恒按 `(target_type, target_id, target_revision)` 取该目标该版本的
--    结论，前三列是等值前缀，`concluded_at DESC` 让「最近结论」排在最前（读面 `LIMIT 30`）。
--    派单 §1.1 原写 `conclusion_revision DESC` —— 本表**没有** `conclusion_revision` 列
--    （`0028_moderation_persistence.sql` 的列清单里只有 `target_revision` 与 `job_revision`），
--    按派单自己的「若列名不同按实际列名」条款取现成的 `concluded_at`。
-- 3. 回填只认 `decision = 'approved'`：`rejected` / `quarantined` / `pending` / NULL 都不是
--    「已发布结论」，给它们填时间等于凭空造出一条可被误读的事实。
--
-- ## 权限（本迁移零 GRANT）
-- 与 0028/0051 同一条纪律：迁移**只改结构 + 回填**，授权一律在部署侧。
-- 运行时的列级授权在 `deploy/postgres-cvm/sql/20-login-roles.sql` 的
-- `gy-r29-moderation-ledger-grant` 区；最小权限断言（分类 / 零行探针 / expected 三处复述）
-- 在 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql`。
--
-- ## 回滚
-- `services/api/db/migrations/rollback/0052_moderation_conclusion_facts.down.sql`
-- （只删本迁移加的一列与一条索引；索引随 `DROP COLUMN` 消失后仍显式 `DROP INDEX IF EXISTS` 兜底）。
--
-- ## 号位
-- 正向最大号为 `0051`（R72-W41 的审核域持久幂等台账）⇒ 本片取 `0052`（连续编号，无缺号）。
BEGIN;

-- ---------------------------------------------------------------------------
-- ① 结论时刻列
--
-- 可空是**语义**要求，不只是兼容存量：NULL = 「没有结论 / 结论时刻未知」。
-- ---------------------------------------------------------------------------
ALTER TABLE public.moderation_decisions
  ADD COLUMN IF NOT EXISTS concluded_at timestamptz;

COMMENT ON COLUMN public.moderation_decisions.concluded_at IS
  '该审核结论落定的时刻（timestamptz）。NULL = 尚无结论或结论时刻未知。W54 只由回填写入；读面（moderation/conclusion-facts-pg.ts 的 CONCLUSION_FACTS_SQL）按 COALESCE(concluded_at, updated_at) 取值。';

-- ---------------------------------------------------------------------------
-- ② 读面索引：按目标取「该版本最近结论」
--
-- 前三列是读面的等值前缀（target_type / target_id / target_revision），
-- 第四列 DESC 让最近结论排最前（读面 `ORDER BY … LIMIT 30` 直接吃这个序）。
-- 不复用 0028 的 `moderation_decisions_target_idx`：那条不带 revision 与时间序，
-- 读面会退化成扫全部历史版本再排序。
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS moderation_decisions_target_concluded_idx
  ON public.moderation_decisions (target_type, target_id, target_revision, concluded_at DESC);

-- ---------------------------------------------------------------------------
-- ③ 存量回填：只填「已判定通过」的行，只填还没填过的行
--
--   · `decision = 'approved'`：只有通过的行才是「已发布的可复用结论」；
--     rejected / quarantined / pending / NULL 一律留空（不臆造事实）。
--   · `concluded_at IS NULL`：可重跑（迁移器本身只跑一次，这里再兜一层幂等）。
--   · `updated_at`：终态行最后一次写就是那次判定 —— 这是**近似**，已在头注释写明口径。
--   · 不写 `updated_at` 自身：本迁移不制造「看起来刚更新过」的假象（否则任何按
--     updated_at 的清理/审计扫描都会把存量通过行当成本次迁移刚写过的行）。
-- ---------------------------------------------------------------------------
UPDATE public.moderation_decisions
   SET concluded_at = updated_at
 WHERE decision = 'approved'
   AND concluded_at IS NULL;

COMMIT;
