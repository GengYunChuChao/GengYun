-- GY-R31 F13 后续切片 · 社区行级作者注销引用（迁移 0030）
--
-- 回滚：services/api/db/migrations/rollback/0030_community_author_ref.down.sql
-- （**不可逆**：库里一旦存在已匿名行，down 明确失败退出，不伪造 author_id）
--
-- 口径来源（逐条）：
--   · 需求 F13（docs/implementation-requirements.md:279）：内部作者换「不可反查原账户的注销引用」，
--     删除账号映射，不把所有作者主键混为一个账号；:280 保留正文、清除个人信息。
--   · 裁定 .pg17/ruling-r31-f13-author-ref-20261022.md：采用方案 C（最小）——
--     `author_id` 改可空 + 行内新列 `anonymized_author_ref`，不建新表、不做全表回填。
--   · 只读设计 .pg17/tmp/i474-author-id-design.md §2 C / §3。
--
-- ## 为什么是「可空 + 行内引用」而不是新表
--   1. 老行 `author_id` 非空、新列 NULL ⇒ 天然满足下面的 `exactly_one`，**不需要回填**
--      （方案 A 要按 distinct 作者回填每行，且要新开 `public_authors` 的运行时授权面）；
--   2. 注销引用落在**行上** ⇒ 重启、多副本、跨进程读同一行得同一串，消除
--      `author-reference-not-durable`（进程内 Map 从来不是持久化落点）；
--   3. `author_id` 的 users 外键**原样保留**（仅对非空行生效）：未注销行的完整性不变；
--      已匿名行 `author_id = NULL` 不参与 `ON DELETE CASCADE` ⇒ 物理删 users 不再删掉应保留的帖评。
--
-- ## 为什么不做 `ON DELETE SET NULL`
--   那会与 `exactly_one` 冲突：物理删 users 时 `author_id` 被置 NULL、`anonymized_author_ref` 仍为
--   NULL ⇒ 直接撞 CHECK 硬失败。是否改成"顺序错了就硬失败"属跨域语义变更（裁定 §8 留待另裁），
--   本片不做；发布顺序约束写进 runbook（先注销清理、后物理删 users）。
--
-- ## 索引
--   `community_posts_author_created_idx (author_id, created_at DESC, id DESC)` **不动**：
--   已匿名行的 author_id 为 NULL，不参与 `=` 查找 ⇒ `scope='mine'` 的查询计划不变；
--   也没有新增按 `anonymized_author_ref` 的查询需求（读路径是按主键取行后投影）。
--
-- ## 纯 expand
--   两条表各 3 条 ALTER（DROP NOT NULL / ADD COLUMN / 2 条 CHECK），**无数据重写**、
--   不改任何既有列类型、不删任何索引、不碰其他表。
-- ----------------------------------------------------------------------------

BEGIN;

-- ---- 帖子 ----
ALTER TABLE public.community_posts ALTER COLUMN author_id DROP NOT NULL;

ALTER TABLE public.community_posts
  ADD COLUMN anonymized_author_ref varchar(40);

-- 形状：`gy-anon-` + 16 位小写 hex（24 字符；列宽 40 留余量但约束更严）。
ALTER TABLE public.community_posts
  ADD CONSTRAINT community_posts_anon_ref_shape
  CHECK (anonymized_author_ref IS NULL OR anonymized_author_ref ~ '^gy-anon-[0-9a-f]{16}$');

-- 恰好一个作者字段非空：既挡「两个都空」（无主行），也挡「两个都非空」（活作者与注销引用并存，
-- 会让「是否已匿名」变成一段可被误读的状态）。
ALTER TABLE public.community_posts
  ADD CONSTRAINT community_posts_author_exactly_one
  CHECK (num_nonnulls(author_id, anonymized_author_ref) = 1);

-- ---- 评论 ----
ALTER TABLE public.community_comments ALTER COLUMN author_id DROP NOT NULL;

ALTER TABLE public.community_comments
  ADD COLUMN anonymized_author_ref varchar(40);

ALTER TABLE public.community_comments
  ADD CONSTRAINT community_comments_anon_ref_shape
  CHECK (anonymized_author_ref IS NULL OR anonymized_author_ref ~ '^gy-anon-[0-9a-f]{16}$');

ALTER TABLE public.community_comments
  ADD CONSTRAINT community_comments_author_exactly_one
  CHECK (num_nonnulls(author_id, anonymized_author_ref) = 1);

COMMIT;
