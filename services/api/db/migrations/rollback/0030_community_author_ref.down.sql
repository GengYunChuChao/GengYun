-- GY-R31 F13 后续切片 · 回滚 0030_community_author_ref.sql
--
-- ## 本迁移**部分不可逆**，且这里如实失败而不是伪造
--
-- 0030 把 `author_id` 改成可空并允许 `anonymized_author_ref` 承接作者身份。注销一旦落过库，
-- `author_id` 已是 NULL、原账户 id **在该行上已不存在**（引用是 crypto 随机、不由 userId 派生，
-- 按 F13「不可反查」不能反推）。因此：
--   · 只要**任一**帖/评行是已匿名状态（`anonymized_author_ref IS NOT NULL`），
--     本 down **必须明确失败退出**（RAISE EXCEPTION），把「你要回滚的东西已经不可还原」讲清楚；
--   · ⛔ 绝不用「随便造一个 author_id」或「删掉已匿名的行」来假装回滚 ——
--     前者是伪造账号映射（F13 明令禁止），后者是静默删内容（与「保留正文」相反）。
--   · 库里还没有任何已匿名行（典型：迁移刚跑完就回滚）⇒ 结构可完整还原。
--
-- 人工处置顺序（确实需要回滚时）：先在应用层确认没有已匿名的保留内容，
-- 或接受「已匿名行继续保留在 0030 形态」并在回滚后按 0030 之前的读法处理——两者都需要评审，
-- 不属于自动化 down 的职责。
--
-- 残留：`visibility='deleted'` 等**未注销**行不受影响（author_id 仍非空），回滚时无需数据修复。

BEGIN;

DO $$
DECLARE
  post_rows   bigint;
  comment_rows bigint;
BEGIN
  SELECT count(*) INTO post_rows
    FROM public.community_posts
   WHERE anonymized_author_ref IS NOT NULL;
  SELECT count(*) INTO comment_rows
    FROM public.community_comments
   WHERE anonymized_author_ref IS NOT NULL;

  IF post_rows > 0 OR comment_rows > 0 THEN
    RAISE EXCEPTION
      '0030 不可回滚：已存在 % 条已匿名帖子、% 条已匿名评论（anonymized_author_ref 非空）。'
      ' 注销引用是 crypto 随机、不可反查原账户（F13），author_id 已置 NULL 且无法还原；'
      ' 伪造 author_id 或删除这些行都属禁止动作。请先由评审裁定处置口径。',
      post_rows, comment_rows;
  END IF;
END
$$;

-- ---- 评论 ----
ALTER TABLE public.community_comments
  DROP CONSTRAINT IF EXISTS community_comments_author_exactly_one;
ALTER TABLE public.community_comments
  DROP CONSTRAINT IF EXISTS community_comments_anon_ref_shape;
ALTER TABLE public.community_comments
  DROP COLUMN IF EXISTS anonymized_author_ref;
ALTER TABLE public.community_comments ALTER COLUMN author_id SET NOT NULL;

-- ---- 帖子 ----
ALTER TABLE public.community_posts
  DROP CONSTRAINT IF EXISTS community_posts_author_exactly_one;
ALTER TABLE public.community_posts
  DROP CONSTRAINT IF EXISTS community_posts_anon_ref_shape;
ALTER TABLE public.community_posts
  DROP COLUMN IF EXISTS anonymized_author_ref;
ALTER TABLE public.community_posts ALTER COLUMN author_id SET NOT NULL;

COMMIT;
