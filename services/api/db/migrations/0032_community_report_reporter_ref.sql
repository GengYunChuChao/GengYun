-- GY-R32 · #15 去身份残留（#483 之后）：举报者的行级注销引用（迁移 0032）
--
-- 回滚：services/api/db/migrations/rollback/0032_community_report_reporter_ref.down.sql
-- （**不可逆**：库里一旦存在已匿名举报行，down 明确失败退出，不伪造 reporter_id）
--
-- ## 为什么需要这一片（残留是什么）
--
--   `#483`（迁移 0030）只把 `community_posts`/`community_comments` 的行级作者引用改成
--   「`author_id` 可空 OR `anonymized_author_ref` 恰好一个非空」。举报表没跟着走：
--   `community_reports.reporter_id` 仍是 `uuid NOT NULL REFERENCES users ON DELETE CASCADE`
--   （0022:137），注销清理只 `SET detail = NULL`（`store-pg.ts::purgeOwnerData` 的举报段）
--   ⇒ **已注销账户与「谁举报了什么」之间仍有一条直接关联面**。
--
--   同一件事还有第二半：完成判据 `authorRefsRemaining` 原本只数帖 + 评
--   （`store-pg.ts` 的剩余引用 UNION 只有两个分支）⇒ 这条残留**读数看不见**，
--   端口会报 completed。本片把两侧一起收口：行内落引用 + 读数把举报计入。
--
-- ## 为什么与 0030 完全同构（而不是"只 DROP NOT NULL、清理时置空"）
--
--   1. 只置空会丢掉「这条举报来自一个真实用户（后被注销）」这一事实，与「无举报者」不可区分；
--      举报是审核域留痕（`state`/`reason_code`/`target_ref` 必须保留），处置轨迹要保持"有人报过"。
--   2. `exactly_one` 与帖/评同一条不变量：既挡「两个都空」（无主举报），也挡「活账户与注销引用
--      并存」（会让"是否已匿名"变成一段可被误读的状态）。
--   3. 引用由注销端口按**主体**生成（`authors.anonymize`，`^gy-anon-[0-9a-f]{16}$`）⇒ 同一主体
--      在帖、评、举报三张表上共用**同一串**，不分裂成多个"注销身份"。
--
-- ## 为什么不改成 `ON DELETE SET NULL`
--
--   与 0030 同一条理由：那会与 `exactly_one` 冲突（物理删 users 时 `reporter_id` 被置 NULL、
--   `anonymized_author_ref` 仍为 NULL ⇒ 直接撞 CHECK 硬失败）。`reporter_id` 的 users 外键
--   **原样保留**（仅对非空行生效）：未注销举报的完整性不变；已匿名行（`reporter_id = NULL`）
--   不参与 `ON DELETE CASCADE`。"先注销清理、后物理删 users"的发布顺序约束写进 runbook，
--   本片不改跨域语义。
--
-- ## 索引
--
--   既有 `community_reports_state_created_idx (state, created_at DESC, id DESC)` 与
--   `community_reports_target_idx` **不动**：读路径是按主键/状态扫、再从行内投影注销引用，
--   没有新增按 `anonymized_author_ref` 的查询需求。
--
-- ## 纯 expand
--
--   一张表 4 条 ALTER（DROP NOT NULL / ADD COLUMN / 2 条 CHECK），**无数据重写**、
--   不改任何既有列类型、不删任何索引、不碰其他表。既有行 `reporter_id` 非空、新列 NULL ⇒
--   天然满足 `exactly_one`，**不需要回填**。
-- ----------------------------------------------------------------------------

BEGIN;

ALTER TABLE public.community_reports ALTER COLUMN reporter_id DROP NOT NULL;

ALTER TABLE public.community_reports
  ADD COLUMN anonymized_author_ref varchar(40);

-- 形状：`gy-anon-` + 16 位小写 hex（24 字符；列宽 40 留余量但约束更严，与 0030 两张表逐字同一条）。
ALTER TABLE public.community_reports
  ADD CONSTRAINT community_reports_anon_ref_shape
  CHECK (anonymized_author_ref IS NULL OR anonymized_author_ref ~ '^gy-anon-[0-9a-f]{16}$');

-- 恰好一个举报者字段非空（同 0030 的 exactly_one 口径）。
ALTER TABLE public.community_reports
  ADD CONSTRAINT community_reports_reporter_exactly_one
  CHECK (num_nonnulls(reporter_id, anonymized_author_ref) = 1);

COMMIT;
