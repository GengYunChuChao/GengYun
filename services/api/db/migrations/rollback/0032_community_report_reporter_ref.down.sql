-- GY-R32 · 回滚 0032_community_report_reporter_ref.sql
--
-- ## 本迁移**部分不可逆**，且这里如实失败而不是伪造
--
-- 0032 把 `community_reports.reporter_id` 改成可空并允许 `anonymized_author_ref` 承接举报者
-- 身份。注销一旦落过库，`reporter_id` 已是 NULL、原账户 id **在该行上已不存在**（引用是 crypto
-- 随机、不由 userId 派生，按 F13「不可反查」不能反推）。因此：
--   · 判据是 **`WHERE anonymized_author_ref IS NOT NULL` 的行数 > 0** —— 即「存在**已匿名**行」。
--     ⛔ **不是**「存在任何行」：库里只有普通举报行（`reporter_id` 非空、未注销）时，本 down
--     **必须能正常回滚**（结构可完整还原），拦掉这种库就是把可逆的场景误判成不可逆。
--   · 只要**任一**举报行是已匿名状态（`anonymized_author_ref IS NOT NULL`），本 down **必须
--     明确失败退出**（RAISE EXCEPTION），把「你要回滚的东西已经不可还原」讲清楚；
--   · ⛔ 绝不用「随便造一个 reporter_id」或「删掉已匿名的举报行」来假装回滚 ——
--     前者是伪造账号映射（F13 明令禁止），后者是静默删除处置轨迹（举报是审核域留痕）。
--   · 库里还没有任何已匿名举报行（典型：迁移刚跑完就回滚）⇒ 结构可完整还原。
--     这条由 `tests/unit/community-report-reporter-ref-migration.test.mjs` 的 A5 机器证明：
--     A5 在**确实存在 1 条普通举报行**的库上跑 down 并断言成功（判据不是"任何行"）。
--
-- 与 `rollback/0030_community_author_ref.down.sql` 同一套纪律：0032 是 0030 在举报表上的
-- 同构扩展，回滚的可逆性边界也就必须同构。
--
-- 人工处置顺序（确实需要回滚时）：先在应用层确认没有已匿名的举报行，或接受「已匿名行继续保留
-- 在 0032 形态」并在回滚后按 0032 之前的读法处理 —— 两者都需要评审，不属于自动化 down 的职责。

BEGIN;

DO $$
DECLARE
  report_rows bigint;
BEGIN
  SELECT count(*) INTO report_rows
    FROM public.community_reports
   WHERE anonymized_author_ref IS NOT NULL;

  IF report_rows > 0 THEN
    RAISE EXCEPTION
      '0032 不可回滚：已存在 % 条已匿名举报（anonymized_author_ref 非空）。'
      ' 注销引用是 crypto 随机、不可反查原账户（F13），reporter_id 已置 NULL 且无法还原；'
      ' 伪造 reporter_id 或删除这些行都属禁止动作。请先由评审裁定处置口径。',
      report_rows;
  END IF;
END
$$;

ALTER TABLE public.community_reports
  DROP CONSTRAINT IF EXISTS community_reports_reporter_exactly_one;
ALTER TABLE public.community_reports
  DROP CONSTRAINT IF EXISTS community_reports_anon_ref_shape;
ALTER TABLE public.community_reports
  DROP COLUMN IF EXISTS anonymized_author_ref;
ALTER TABLE public.community_reports ALTER COLUMN reporter_id SET NOT NULL;

COMMIT;
