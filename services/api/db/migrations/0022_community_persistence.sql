-- 0022_community_persistence.sql
-- 耕云 GY-I15（#15）切片 C1 · 社区域 PostgreSQL 持久化。
--
-- 输入：`docs/architecture/data-dictionary.md`（posts / comments / likes / reports /
--       moderation_decisions）＋ `services/api/src/community/store.ts` 的**冻结接口**
--       （本迁移只服务该接口的记录形状，不改接口、不改对外 API 契约）。
-- 归属：#15 切片 C1。本文件只新增本域对象，**不改** 0001 起的任何既有表、索引、枚举与数据。
--
-- ---------------------------------------------------------------------------
-- 为什么是 `community_*` 而不是直接写字典里的 `posts` / `post_versions`
-- ---------------------------------------------------------------------------
-- 0001 已按数据字典建过 `posts` + `post_versions`（行 259 / 270），那是给**公开作者投影**
-- 那套模型用的；本片 store 的记录与它**不可兼容**，四条都是硬冲突（不是风格差异）：
--   (1) `posts.author_ref uuid NOT NULL REFERENCES public_authors (id)`：本片作者来源是
--       `createLocalPseudonymousAuthorDirectory()` 的**内存假名投影**（作者目录切片尚未
--       落库），`PostRecord.author_id` 是 `users.id`；写 `posts` 会直接撞外键。
--   (2) `post_versions.linked_target_id uuid`：本片 `KnowledgeTarget.id` 是**任意字符串**
--       （如 `spc-1`），塞不进 uuid 列（同形问题在收藏域用例里已出现过）。
--   (3) `post_versions` 没有 `media_ids`：媒体引用在 `content_media_refs`，而那里要求
--       `media_id REFERENCES media (id)` + `media_revision`（媒体域切片才有的行）。
--   (4) `post_versions` 是**逐 revision 不可变**的版本表；但本片在**同一 revision** 上会被
--       重审写回 `audit_state`（`service.ts` 的重审分支 CAS 里 patch 不含 revision）。
-- 因此本迁移新建本域自有的六张表；`posts` / `post_versions` 原样留给作者投影与版本化切片，
-- 本迁移不删、不改、不写它们。等作者投影与媒体投影落库后，再决定是否合成一套（那是后续切片）。
--
-- ---------------------------------------------------------------------------
-- 三条读路径的索引（派单 §四.2）
-- ---------------------------------------------------------------------------
--   A. **作物地区筛选**（feed 的第一层过滤）：`community_posts_feed_idx`
--      `(crop_id, region_code, created_at DESC, id DESC)`——与 `listPosts()` 的
--      "按 crop_id / region_code 过滤后按 created_at DESC, id DESC 排序"逐列对应。
--   B. **按对象查可见性**：`community_moderation_decisions` 的主键
--      `(target_type, target_id, target_revision)` 就是 `getModeration()` 的查找键；
--      内容行按主键 `id` 取（`getPost` / `getComment`），不建二级索引也不走全表扫。
--      另有 `community_posts_visibility_created_idx` 支撑"只取某可见性状态"的分页扫描
--      （后台按状态巡查），`community_comments_post_created_idx` 支撑评论列表。
--   C. **未读事件**：事件本体在消息域（`messages.read_at`，见 0019），本域提供事件指向的
--      源行与运营侧"未处理"队列，因此给
--      `community_reports_state_created_idx (state, created_at DESC, id DESC)`（未处理/已隔离
--      队列的稳定分页）与 `community_reports_target_idx (target_type, target_id,
--      target_revision, created_at DESC, id DESC)`（"这个对象被举报了几次、最后一条是谁"）。
--
-- ---------------------------------------------------------------------------
-- 读取时重查可见性（不许缓存复活）
-- ---------------------------------------------------------------------------
-- 本迁移**不建**任何物化视图、不建 visibility 汇总列、不加"已发布"缓存列：可见性判定的
-- 唯一实现是服务层 `effectiveState()`——每次读都现查 `community_moderation_decisions`
-- 并比对 `text_digest`（正文摘要）与 `rule_version`；隐藏、失效、注销（`ON DELETE CASCADE`
-- 连带删除作者内容以外的引用行）都必须**当场**反映。存储层不做跨请求缓存。
--
-- 边界（如实登记）：
--   * `community_posts.media_ids text[]` 只存**引用串**，不含媒体行（媒体投影未接线）。
--   * `community_reports` **不加**字典里的 `unique (reporter_id, target_type, target_id,
--     target_revision)`：本片重复举报的去重由服务层 Idempotency-Key 裁决（`insertReport`
--     在接口上是按 `id` 覆盖的 `void`），加唯一约束会把"换个 Idempotency-Key 再举报一次"
--     从"两行"变成 503（与内存实现**不同语义**）。索引仍按字典列建，只是不唯一。
--   * `community_moderation_decisions.rule_version` 可空：模型层 `model_version` /
--     `prompt_version` 属 LLM 供应商（外部阻塞），本片不伪造占位串。
BEGIN;

-- ---------------- 帖子：一条记录就是一行（含 title/body/media 引用/知识关联） ----------------
CREATE TABLE community_posts (
  id                       uuid PRIMARY KEY,
  author_id                uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  revision                 integer NOT NULL CHECK (revision >= 1),
  title                    varchar(120) NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  body                     text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  crop_id                  varchar(80) CHECK (crop_id IS NULL OR char_length(crop_id) BETWEEN 1 AND 80),
  region_code              varchar(6) CHECK (region_code IS NULL OR region_code ~ '^33[0-9]{4}$'),
  media_ids                text[] NOT NULL DEFAULT '{}'::text[],
  linked_knowledge_type    linked_target_type,
  linked_knowledge_id      text,
  linked_knowledge_revision integer CHECK (linked_knowledge_revision IS NULL OR linked_knowledge_revision >= 1),
  visibility               visibility NOT NULL,
  audit_state              audit_state NOT NULL,
  created_at               timestamptz NOT NULL,
  updated_at               timestamptz NOT NULL,
  -- 知识关联三列同空或同有（与 0001 `post_versions` 的同款约束口径一致）
  CONSTRAINT community_posts_linked_knowledge_complete CHECK (
    (linked_knowledge_type IS NULL AND linked_knowledge_id IS NULL AND linked_knowledge_revision IS NULL)
    OR (linked_knowledge_type IS NOT NULL AND linked_knowledge_id IS NOT NULL
        AND linked_knowledge_revision IS NOT NULL)
  ),
  -- 媒体引用上限与 `validate.ts` 的 `MEDIA_IDS_MAX`（3）一致；不校验 uuid 形态：
  -- 记录里的 `media_ids` 是**引用串**，媒体域才是 uuid 的权威（本片不碰 media）。
  CONSTRAINT community_posts_media_ids_max CHECK (
    media_ids IS NULL OR coalesce(array_length(media_ids, 1), 0) <= 3
  )
);

-- 路径 A：作物地区筛选（feed）
CREATE INDEX community_posts_feed_idx
  ON community_posts (crop_id, region_code, created_at DESC, id DESC);
-- 路径 B：按可见性状态分页（后台巡查 / 只取公开）
CREATE INDEX community_posts_visibility_created_idx
  ON community_posts (visibility, created_at DESC, id DESC);
-- 「我的发布」与作者维度巡查
CREATE INDEX community_posts_author_created_idx
  ON community_posts (author_id, created_at DESC, id DESC);

-- ---------------- 评论 ----------------
-- `post_id` 外键到本域帖子：父帖只做软删除（`visibility = 'deleted'`），所以不会级联丢评论；
-- 物理删除只发生在整域清空/回滚时，此时评论一并走（ON DELETE CASCADE）。
CREATE TABLE community_comments (
  id          uuid PRIMARY KEY,
  post_id     uuid NOT NULL REFERENCES community_posts (id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  revision    integer NOT NULL CHECK (revision >= 1),
  body        text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  visibility  visibility NOT NULL,
  audit_state audit_state NOT NULL,
  created_at  timestamptz NOT NULL
);

-- `listComments(postId)` 的排序是 created_at ASC, id ASC（与被读的契约顺序一致）
CREATE INDEX community_comments_post_created_idx
  ON community_comments (post_id, created_at ASC, id ASC);

-- ---------------- 点赞（集合语义：同主体同目标至多 1 条） ----------------
CREATE TABLE community_likes (
  target_type varchar(8) NOT NULL CHECK (target_type IN ('post', 'comment')),
  target_id   uuid NOT NULL,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- 幂等唯一键：重复 PUT 由数据库裁决为 no-op（计数由集合大小派生，没有计数器列）
  CONSTRAINT community_likes_target_user_key UNIQUE (user_id, target_type, target_id)
);

-- 计数读路径（`countLikes`）不经过上面的唯一键（其首列是 user_id）
CREATE INDEX community_likes_target_idx
  ON community_likes (target_type, target_id, user_id);

-- ---------------- 举报（含处理状态） ----------------
CREATE TABLE community_reports (
  id              uuid PRIMARY KEY,
  revision        integer NOT NULL CHECK (revision >= 1),
  reporter_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  target_type     varchar(8) NOT NULL CHECK (target_type IN ('post', 'comment')),
  target_id       uuid NOT NULL,
  target_revision integer NOT NULL CHECK (target_revision >= 1),
  state           varchar(16) NOT NULL CHECK (state IN ('received', 'isolated', 'closed')),
  reason_code     varchar(32) NOT NULL
                  CHECK (reason_code IN ('dangerous', 'privacy', 'advertising', 'misleading', 'other')),
  detail          text,
  created_at      timestamptz NOT NULL
);

-- 路径 C：运营侧未处理队列（state 稳定分页）
CREATE INDEX community_reports_state_created_idx
  ON community_reports (state, created_at DESC, id DESC);
-- 路径 C：按对象回溯（"这个对象被举报过几次"），并支撑"重复举报不丢"的读取
CREATE INDEX community_reports_target_idx
  ON community_reports (target_type, target_id, target_revision, created_at DESC, id DESC);

-- ---------------- 审核结论台账 ----------------
-- 主键 `(target_type, target_id, target_revision)` = `getModeration()` 的查找键（路径 B）。
-- `contract_complete = false` 的行是**如实的**：模型层版本字段未取得，不填占位串。
CREATE TABLE community_moderation_decisions (
  target_type             varchar(8) NOT NULL CHECK (target_type IN ('post', 'comment')),
  target_id               uuid NOT NULL,
  target_revision         integer NOT NULL CHECK (target_revision >= 1),
  id                      uuid NOT NULL,
  decision                audit_state NOT NULL,
  reason_codes            jsonb NOT NULL CHECK (jsonb_typeof(reason_codes) = 'array'),
  hard_rule_passed        boolean NOT NULL,
  rule_version            text,
  -- 送审正文的 SHA-256（帖子 = title+LF+body；评论 = body）：结论绑定**正文**而不只是 revision
  text_digest             varchar(64) NOT NULL CHECK (text_digest ~ '^[0-9a-f]{64}$'),
  contract_complete       boolean NOT NULL,
  missing_contract_fields jsonb NOT NULL CHECK (jsonb_typeof(missing_contract_fields) = 'array'),
  created_at              timestamptz NOT NULL,
  CONSTRAINT community_moderation_decisions_pkey PRIMARY KEY (target_type, target_id, target_revision)
);

-- ---------------- 本域幂等台账 ----------------
-- 与 0018 的 `favorites_idempotency` / `history_idempotency` 逐列同形（claim/complete/release
-- 各是一条带条件的单语句）：`outcome IS NULL` = 已认领未完成。
CREATE TABLE community_idempotency (
  scope           varchar(200) NOT NULL,
  key_hash        bytea NOT NULL,
  request_hash    varchar(128) NOT NULL,
  response_status smallint NOT NULL CHECK (response_status BETWEEN 100 AND 599),
  outcome         jsonb CHECK (outcome IS NULL OR jsonb_typeof(outcome) = 'object'),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (scope, key_hash)
);

CREATE INDEX community_idempotency_expires_idx ON community_idempotency (expires_at);

COMMIT;
