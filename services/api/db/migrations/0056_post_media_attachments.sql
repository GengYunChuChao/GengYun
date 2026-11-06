-- GY-R83（#1030）· 帖子级媒体挂载表：把「每帖 ≤3 张图」从计数近似改成**结构约束**。
--
-- 依赖：`0022_community_persistence.sql` 的 `public.community_posts`（本迁移**只建一张新表**，
-- 不改既有列、不改既有 CHECK、不写数据、不改 `community_posts.media_ids` 的既有语义）。
--
-- 为什么加（逐条对齐真实缺口）：
--   - real 模式的「每帖 ≤3 张」今天只能靠上传端的**计数**近似，而唯一可用的计数口径是
--     「同一 owner 名下存活的 `community_image` 记录数」——那是**生命周期累计**口径：
--     用户传满 3 张后即使一张都没发帖也会被永久挡住（清理器 `expireInitiated`／`cleanupOrphans`
--     与权威每帖计数都没有生产调用者），且「先数后写」之间还有 TOCTOU（并发可超发）。
--     见 `services/api/src/media/service.ts` 的端口注释（`unwired` 段）与
--     `.pg17/ruling-i06-d1-substitute-rework-20261017.md` 方案 A。
--   - 本表把「哪个帖子挂了哪张图、占第几号位」写成**行**：上限由
--     `UNIQUE (post_id, ordinal)` + `CHECK (ordinal BETWEEN 1 AND 3)` 裁决，
--     `PRIMARY KEY (post_id, media_id)` 裁决「同一张图不许在同一帖占两个号位」。
--     ⇒ 每帖上限不再依赖任何计数，也不需要任何后台清理器才能解锁。
--   - 认领点在发帖/改稿的**同一事务**里（`services/api/src/community/store-pg.ts` 的
--     `insertPost`／`commitPost`）：`INSERT … SELECT … ordinal = row_number()`，
--     冲突即整笔 ROLLBACK ⇒ 服务层映射成既有 400 `post_image_limit`（不新造错误码）。
--
-- 悬空引用语义（**故意不加外键**，两侧都不加）：
--   - `media_id` **不** REFERENCES `public.media (id)`：`0022` 第 84-88 行明写
--     `community_posts.media_ids` 里存的是**引用串**、媒体域才是 uuid 的权威，既有集成夹具
--     （`tests/integration/community-pg.mjs` 的 `postRecord()`）一直用随机 uuid 当 `media_ids`。
--     加 FK 会让「先发帖、媒体域后补」以及所有既有夹具整片判红，且跨域外键会把媒体域的
--     物理删除顺序（`purgeOwnedMedia` 会真删 `media` 行）绑到社区域上。
--   - `post_id` 同样**不** REFERENCES `public.community_posts (id)`：与 media 侧保持**同一种**
--     悬空引用语义（引用串不是外键），删帖由社区域自己的状态机（`visibility = 'deleted'`）表达，
--     行本身留在表里；「删帖即释放」的读法按 `community_posts.visibility` 过滤实现，不靠级联。
--     ⇒ 两侧都不加 FK 是**对称**决定，不是漏写。
--
-- 权限：本迁移**零 GRANT**（与 0024/0026/0051/0054 同一纪律：迁移只建结构，授权一律在部署侧）。
--   运行角色 `gengyun_api_runtime` 的最小权限写在 `deploy/postgres-cvm/sql/20-login-roles.sql`
--   的社区域段：列级 `SELECT`／`INSERT` + **表级** `DELETE`（PG 没有列级 DELETE；改稿要先
--   `DELETE … WHERE post_id = $1` 再重认领），**不授** `UPDATE`（挂载行一旦写入就不该原地改，
--   改号位等于换挂载 ⇒ 删了重认领）。
--
-- 并发：与会话内其他 DDL 同事务（`BEGIN … COMMIT`）。表是空的、只建索引不建 CONCURRENTLY，
--   部署窗口内无长锁风险。运行期并发由唯一约束/主键裁决（不需要 `pg_advisory_xact_lock`：
--   认领是单条 `INSERT … SELECT`，冲突由 PG 直接报 23505/23514）。
--
-- 号位：合流树正向最大号是 `0054`；`0055` 已被**在飞**的 `provider_call_ledger` 占用
--   （`feat/gy-r83-provider-call-ledger` 分支的 `0055_provider_call_ledger.sql`）⇒ 本片取 **`0056`**，
--   不改 `0055` 相关的任何文件。
--
-- 回滚：`services/api/db/migrations/rollback/0056_post_media_attachments.down.sql`
--   （只 `DROP TABLE IF EXISTS`；丢的是「谁挂了哪张图」的索引性事实，`community_posts.media_ids`
--   里的引用串仍在，回滚不会让帖子丢图）。
BEGIN;

CREATE TABLE public.post_media_attachments (
  post_id uuid NOT NULL,
  media_id uuid NOT NULL,
  ordinal smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT post_media_attachments_pkey PRIMARY KEY (post_id, media_id),
  CONSTRAINT post_media_attachments_post_ordinal_key UNIQUE (post_id, ordinal),
  CONSTRAINT post_media_attachments_ordinal_range CHECK (ordinal BETWEEN 1 AND 3)
);

-- 「删帖释放」的反查键：`purgeOwnedMedia` / 待用池口径都要按 `media_id` 找挂载行。
-- `(post_id)` 侧**不另建索引**：`post_media_attachments_pkey` 的前缀已经是 `(post_id)`。
CREATE INDEX post_media_attachments_media_idx
  ON public.post_media_attachments (media_id);

COMMIT;
