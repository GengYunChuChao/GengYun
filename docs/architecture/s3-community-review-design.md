# S3 · 社区帖人工「通过 / 驳回」——设计口径（服务端）

本页只钉**口径**，不重复契约字段表（字段以 `packages/contracts/openapi.json` 里
`approvePost` / `rejectPost` 两条 operation 为唯一来源，服务端实现见
`services/api/src/admin/ops/community-posts.ts` 与 `services/api/src/admin/ops/service.ts`）。

## 1. v1 的「通过」动作**同时**承担发布语义

**v1 的通过动作同时承担发布语义（`private → published` + `audit_state='approved'`）；
作者自助发布口是 S4 的独立能力，届时若上线，通过动作是否仍翻 `visibility` 需重新裁定。**

为什么 v1 必须这样（三条，缺一不可）：

1. 待审帖在库里就是 `visibility='private'` + `audit_state='pending'`（发帖时
   `awaitingPublish || mediaReview` 决定可见性，见 `services/api/src/community/service.ts`）。
2. 公开读面要求「对外可见 ⟺ `published` 且 `approved`」。
3. 契约里**没有**作者自助发布口（没有 `POST /posts/{id}/publish` 之类的 operation）。

⇒ 若通过时只翻 `audit_state`，人工审核队列就是黑洞：运营点了「通过」，帖子永远不可见。

配套约束（同一段代码里刻意保留的不对称）：

- `hidden` / `deleted` **不为它们翻案**：下架与删除是单向门，审核动作不撤销它们，也不返回错误码，
  而是**幂等**返回当前状态（`changed:false`），不写第二条结论、不重复通知作者。
- 幂等判据是「结论已是 `approved` **且** 目标可见性与当前可见性一致」。
- 该不对称的代价：审计上一行 `post.approve` 无法区分「放行一件已发布帖」与「发布一件待审帖」；
  要区分只能看结论行的 `decided_by` 与帖子 `created_at`。S3b 若把审核动作落 `admin_audit_events`，
  建议在 `target_ref` 里带 `previous_visibility`。

## 2. 驳回 = `audit_state='rejected'` + `visibility='hidden'`

驳回落 `hidden` 而不是保持 `private`：驳回的语义是「不可公开」，只写 `audit_state` 等于让每个读面
各自去推「rejected ⇒ 不可见」，多一个读面就多一处可能忘。

**副作用（必须知道）**：`hidden` 会触发 `withTakedownObserver`（`app.ts` 装配）再发一条 `takedown`
事件 ⇒ 一篇被驳回的帖子会给作者发**两条**消息（`moderation` + 下架类事件）。这是既有观察器的行为，
S3 不去重；去重需要改观察器，属 S4 范围。

## 3. `decided_by`：故意不建外键

结论行上的「谁批的」落在 `public.community_moderation_decisions.decided_by`（迁移
`services/api/db/migrations/0045_community_post_review_actor.sql`，可空列，`NULL` = 机器结论）。

**故意不建外键：注销后仍保留审核人溯源；账号是否存在由应用层解释。**

理由：该列是**溯源**不是关联键。`ON DELETE` 无论级联还是 `RESTRICT` 都会把这件事做错——
级联会在账号注销时抹掉「曾有一个人批过它」，`RESTRICT` 会让注销链卡在一条历史审核结论上。
写入侧的来源由认证上下文保证（`AdminCallContext.identity` 已由认证层校验），读取侧不 JOIN 该列。

## 4. 通知作者

复用社区既有事件形状，不新造 `post_approved` / `post_rejected`：

- 事件 `moderation_result`（投影成契约 `Message.type='moderation'`，`target_ref` 指向帖子修订号，
  `event_key` 含结论 ⇒ 同一版同一结论只发一条）；
- 投递失败**不回滚**审核结论：响应如实给 `notified:false`（回滚会让运营看到 500 但状态已变，更糟）；
- 匿名帖（`author_id IS NULL`）没有可通知的人 ⇒ 不发，也不算失败。

## 5. 本页不管的两件事

- **审计读面**：本片不写 `public.admin_audit_events`（`AUDIT_ACTIONS` 四值闭集不动），
  `GET /admin/audit-logs` 查不到审核动作——这是有意的路线选择，「谁批的」落在结论行上、与帖子状态同事务。
  要进审计读面留给 S3b（新迁移号 0046）。
- **后台 UI**：S3-c 另做；`apps/admin` 的人审占位页在本片仍不发请求。
