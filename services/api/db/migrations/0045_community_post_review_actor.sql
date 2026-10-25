-- 迁移 0045：`community_moderation_decisions` 增加「谁做的结论」——`decided_by`
-- =============================================================================
--
-- 为什么需要这一列
-- ---------------------------------------------------------------
-- · 本片（S3）新增了两个**人工**审核动作：`POST /admin/posts/{id}/approve` 与
--   `POST /admin/posts/{id}/reject`。它们把运营结论写进社区侧唯一的事实表
--   `community_moderation_decisions`（与帖子行**同一事务**，见
--   `services/api/src/community/store-pg.ts` 的 `writeModeration`）。
-- · 但该表此前的 12 列里**没有 actor**（`0028_moderation_persistence.sql:56-88`）：
--   它诞生时只服务"机器结论"，机器结论的"谁"是规则版本 + 引擎，不需要人。
--   人工结论进来后，"**谁**批的"就成了一条无法用日志替代的审计事实
--   （`admin/ops/content-pg.ts:25-27` 自述的"hidePost 审计只落内存"正是缺这一列的后果）。
-- · 因此本片只加**一个可空列**，不新建表、不改既有列、不动任何既有行。
--
-- 为什么**不**写 `public.admin_audit_events`（本片的路线选择）
-- ---------------------------------------------------------------
-- · 路线 β 是复用 0043 的 `record_*` 范式，在 `commitPostIfCurrent` 的同一事务里调
--   `public.record_admin_post_review_audit(...)`。代价是：`AUDIT_ACTIONS` 闭集 +2
--   ⇒ 连带 `admin/audit/catalog.ts` 头部登记表、`GET /admin/audit-logs?action=` 的
--   契约 enum、以及三处把该闭集钉死的用例（`ai-ops-ledger-pins` /
--   `admin-audit-action-jobs-cancel` / `admin-audit-logs`）一起改。
-- · 本片的目标是"人工通过/驳回能不能用"，不是"运营审计读面完不完整"。
--   ⇒ 取路线 α（本迁移），把路线 β 留给 S3b；届时 `decided_by` 正好是它的数据源。
--
-- 语义
-- ---------------------------------------------------------------
--   · `decided_by IS NULL`  ⇒ **机器结论**（规则层/审核域产出），口径与 0045 之前逐字一致；
--   · `decided_by IS NOT NULL` ⇒ **人工结论**，值是做出该结论的运营者 `users.id`。
--   ⇒ 「这条结论里有没有人的判断」在 SQL 与导出里**一眼可辨**，不需要新表/新枚举。
--   ⇒ 机器写入路径（`community/service.ts` 的 `buildVerdict`）不传该字段，落 `NULL`，
--      **零行为变化**（`ModerationRecord.decided_by` 是可选字段，缺省即无）。
--
-- 为什么不加外键
-- ---------------------------------------------------------------
--   **故意不建外键：注销后仍保留审核人溯源；账号是否存在由应用层解释。**
--   · 本列是**溯源**，不是关联键：运营账号被删除/停用之后，历史结论仍然必须能追溯到
--     "曾有一个人批过它"，而不是被 ON DELETE 级联清空或反过来阻塞 `users` 的删除流程（注销
--     7 日链路已有既定语义，见 `0044_third_party_deletion_persistence.sql`）。
--   · 因此**故意**只存裸 uuid：写入侧由应用保证来自认证上下文（`AdminCallContext` 的
--     `identity.adminId` 已由认证层校验），读取侧不 JOIN 该列。
--
-- 不碰什么
-- ---------------------------------------------------------------
--   ⛔ 不动 `0028_moderation_persistence.sql` 的正文字节（checksum 会拦既有库升级）；
--   ⛔ 不动 `moderation_decisions`（机器审核台账，另一条链路）；
--   ⛔ 不加索引：该列不被查询条件使用，加索引只会增加写放大；
--   ⛔ 不改任何既有行的 `decided_by`（新列一律 `NULL`）。
--
-- 回滚：`rollback/0045_community_post_review_actor.down.sql`
--   删列前**先预检**：库里若已有 `decided_by IS NOT NULL` 的行即中止（`G0017`）——
--   删列等于删掉人工审核的溯源证据，那种情况下正确的动作是回滚**应用版本**，不是回滚列。
--
BEGIN;

-- ---------------------------------------------------------------------------
-- ① 加列（可空；既有行保持 NULL ⇒ 一律读作"机器结论"）
-- ---------------------------------------------------------------------------
ALTER TABLE public.community_moderation_decisions
  ADD COLUMN IF NOT EXISTS decided_by uuid NULL;

COMMENT ON COLUMN public.community_moderation_decisions.decided_by IS
  '做出该结论的运营者 users.id；NULL = 机器结论（规则层/审核域产出）。'
  ' 人工通过/驳回（POST /admin/posts/{id}/approve|reject）写非空；'
  ' 该列只作溯源，不加外键、不参与可见性判定。';

COMMIT;
