-- 0036_r34_admin_content_persistence.sql
-- 耕云 R34 · #18（后台管理端内容/资料域）· PostgreSQL 落点。
--
-- 输入：`services/api/src/admin/types.ts` 的 `StoredEntity` / `StoredRevision` **冻结形状**，
--       与 `services/api/src/admin/store.ts` 的能力接口（`AdminContentStore`）。
--       本迁移只服务这两个形状：不改接口、不改对外 API 契约、不改任何路由。
-- 归属：#18。本文件只**新增**本域对象，⛔ 不改 0001 起任何既有表、索引、枚举与数据。
--
-- ---------------------------------------------------------------------------
-- 编号 0036 与「合并顺序前提」
-- ---------------------------------------------------------------------------
-- 0035 归「媒体行侧物理删除」切片（分支 `feat/gy-r34-media-purge`，在飞）；0037 预留给 #14。
-- 因此本片的前提是：**0035 先落 main**。若合流时 main 仍无 0035，本片必须整体重取号
-- （改成当时最大号 +1）并同步 `services/api/db/migrations/README.md` 与本文件编号 ——
-- ⛔ 不许靠保留台账或 README 的一行声明把「缺 0035」糊过去（保留项一落盘就会立刻过期）。
-- 提交时实测指针：`upstream/main` 最大号 **0034**；本分支新增 **0036**。
--
-- ---------------------------------------------------------------------------
-- 为什么新建三张表，而不是复用 sources / source_versions / knowledge_versions
-- ---------------------------------------------------------------------------
-- 四条都是硬冲突（不是风格差异）：
--   (1) `sources` / `source_versions` **没有三态生命周期**。后台内容域的状态机是
--       `draft → published → withdrawn`（`types.ts` 的 `Lifecycle`），且撤回后仍要保留
--       已发布版本与撤回证据；`source_versions` 是逐 revision 不可变的版本行，既没有
--       `lifecycle`，也没有 `published_revision/published_at/published_by_id/…` 这组字段。
--   (2) `knowledge_versions.visibility` 是**公开可见性**闭集，不是审核状态机。把后台状态机
--       塞进公开可见性列会让两条语义互相污染（一次后台撤回会顺手改变线上可见性口径）。
--   (3) `registrations` / `restriction_rules` 各带业务专属列与业务专属约束。后台内容域要存的是
--       **四个 family 共用的**「正文 + 元数据」，往专用表塞只能加一堆可空列 —— 那等于没有 schema。
--   (4) 本域需要**自己的幂等台账**（PK `(scope, key_hash)`）。0018 的 `favorites_idempotency`、
--       `history_idempotency` 与 0022 的 `community_idempotency` 各自建了同形台账；跨域共用一个
--       台账会污染 scope 空间与保留期（本域 TTL 由 `ADMIN_IDEMPOTENCY_TTL_SECONDS` 决定）。
--
-- ---------------------------------------------------------------------------
-- 三条读路径的索引（与 `ops/content-pg.ts` 的 SQL 逐列对应）
-- ---------------------------------------------------------------------------
--   A. `listEntities(family, stewardId)` —— 后台列表页：`WHERE family = $1 AND steward_id = $2
--      ORDER BY id ASC`（游标分页、按 id 稳定排序）⇒ `admin_content_entities_family_steward_idx
--      (family, steward_id, id)`。
--   B. `listFamilyEntities(family)` —— 引用完整性跨实体解析（`reference-integrity.ts`
--      `dependenciesOf`）+ 公开视图投影：`WHERE family = $1 ORDER BY id ASC`
--      ⇒ `admin_content_entities_family_idx (family, id)`。
--   C. 版本行：主键 `(entity_id, revision)` 本身就是 `WHERE entity_id = ANY($1)
--      ORDER BY entity_id ASC, revision ASC` 的覆盖索引，不另建二级索引。
--   幂等台账：主键 `(scope, key_hash)` 供 claim/complete/release 的单行读写；
--      `expires_at` 单列索引供过期扫描（`purgeExpiredIdempotent`）。
--
-- ---------------------------------------------------------------------------
-- 生命周期是**标志位**，不是物理删除 —— 与授权口径直连，先说清楚
-- ---------------------------------------------------------------------------
-- 运行时角色 `gengyun_api_runtime` 对本域三张表**只有列级** `SELECT, INSERT, UPDATE`
-- （`deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-r34-content-grant` 段；**表级 DML 一条都没有**，
-- 连 SELECT 都按列给 —— 与 `90-assert-least-privilege.sql` 的 `expected` 逐列成对），
-- ⛔ 没有 `DELETE` / `TRUNCATE` / `REFERENCES` / `TRIGGER`。这不是疏漏，是 0016 / 0031 / 0034
-- 立下的同一条不变量：`deploy/postgres-cvm/evidence/probe-runtime-grants.sql` 把「运行时直接
-- DELETE」钉成必须 42501，`20-login-roles.sql` 与 `90-assert-least-privilege.sql` 成对断言。
-- 于是本域的三条推论：
--   · **撤回 = 状态位**：`lifecycle='withdrawn'` + 撤回字段组，行留在表里；没有 `deleted_at`，
--     也不做「假删除」。正文行只增不改（版本行）或只改状态（实体行）。
--   · **幂等台账的 release / purge 也不能 DELETE**：`services/api/src/admin/ops/content-pg.ts`
--     改用两招达成同一个**可观测**语义 —— ① release 把未定型的占位行到期时刻推到
--     `-infinity`（下一次 claim 的 `expires_at <= now` 判据立刻让它让位，等价于「删掉占位行」；
--     不依赖注入时钟与库时钟一致）；② purge 把**已到期的已定型结果**清成占位，让它们对重放方
--     彻底不可见（等价于「删掉过期行」）。
--   · **边界（如实登记）**：台账行**只增不删**。物理保留期清理需要 DELETE 权限或一个零权限面
--     的窄函数，属独立的保留期清理切片；本迁移不冒充已交付，证据页「未取得」一节登记。
--
-- ---------------------------------------------------------------------------
-- 与既有审计口径的关系（本迁移**不**碰审计表）
-- ---------------------------------------------------------------------------
-- 后台内容域的写操作会写审计（`store.audit.append`）。`public.admin_audit_events`（0017/0020/0027）
-- 对运行时**零权限**、写入只能走独立的窄 SECURITY DEFINER 函数 ⇒ 在真库臂里审计仍落在
-- `createAuditLog()` 的进程内台账上，与 `auditLogPort` 的接线前状态逐字相同。这一条**不**在本迁移
-- 解决，也不假装解决：证据页「未取得」如实写「审计落库未接」。
BEGIN;

-- ---------------- 实体行（三态生命周期 + 已发布/已撤回字段组） ----------------
-- `id` 由服务层生成（`randomUUID`，可注入以便测试）——实体 id 是**领域身份**，不是代理键，
-- 因此不设 DEFAULT。`created_at` 同理由注入时钟给出（测试要能钉死时间）。
CREATE TABLE IF NOT EXISTS public.admin_content_entities (
  id                     uuid NOT NULL,
  -- 四个 family 的闭集：与 `types.ts` 的 `ADMIN_FAMILIES` 逐字一致。
  family                 varchar(16) NOT NULL CHECK (family IN ('sources', 'knowledge', 'registrations', 'restrictions')),
  -- 归属账号（`ResolvedContext.accountId`）：本域按「谁的资料」做所有权判定与列表过滤。
  steward_id             text NOT NULL CHECK (char_length(steward_id) BETWEEN 1 AND 200),
  -- 三态：draft（草稿）→ published（已发布）→ withdrawn（已撤回）。
  lifecycle              varchar(16) NOT NULL CHECK (lifecycle IN ('draft', 'published', 'withdrawn')),
  published_revision     integer CHECK (published_revision IS NULL OR published_revision >= 1),
  published_at           timestamptz,
  published_by_id        text,
  -- 发布证据引用（后台要求「发布必须有据可查」）：不存正文，只存引用串。
  published_evidence_ref text,
  published_reason       text,
  withdrawn_at           timestamptz,
  withdrawn_by_id        text,
  withdrawn_reason       text,
  created_at             timestamptz NOT NULL,
  CONSTRAINT admin_content_entities_pkey PRIMARY KEY (id),
  -- 发布字段是**同一个事实的五个投影**：要么全空（未发布过），要么全有（发布过）。
  -- 半组字段只可能来自写路径 bug，让它在写的那一刻就红，而不是等到读的时候猜。
  CONSTRAINT admin_content_entities_published_group CHECK (
    (published_revision IS NULL AND published_at IS NULL AND published_by_id IS NULL)
    OR (published_revision IS NOT NULL AND published_at IS NOT NULL AND published_by_id IS NOT NULL)
  ),
  -- 撤回态的撤回字段组同理（`published_*` 保持不动：撤回不抹掉「曾经发布过」）。
  CONSTRAINT admin_content_entities_withdrawn_group CHECK (
    lifecycle <> 'withdrawn'
    OR (withdrawn_at IS NOT NULL AND withdrawn_by_id IS NOT NULL)
  )
);

-- 路径 A：后台列表页（按 family + 归属账号过滤，按 id 稳定分页）。
CREATE INDEX IF NOT EXISTS admin_content_entities_family_steward_idx
  ON public.admin_content_entities (family, steward_id, id);
-- 路径 B：引用完整性跨实体解析 + 公开视图投影（整个 family 的当前状态）。
CREATE INDEX IF NOT EXISTS admin_content_entities_family_idx
  ON public.admin_content_entities (family, id);

-- ---------------- 版本行（逐 revision 不可变） ----------------
-- 主键 `(entity_id, revision)`：既是身份，也是「按实体取全部版本」的覆盖索引。
-- `content` 存的是 `StoredRevision.content` 的 JSON 快照（正文 + 元数据都在里面），
-- 因此**不**把它拆成业务列：四个 family 的 content 形状本就不同，拆列等于把四个 schema 揉成一张表。
CREATE TABLE IF NOT EXISTS public.admin_content_revisions (
  entity_id             uuid NOT NULL,
  revision              integer NOT NULL CHECK (revision >= 1),
  content               jsonb NOT NULL,
  author_id             text NOT NULL CHECK (char_length(author_id) BETWEEN 1 AND 200),
  -- 派生来源：本次修订基于同实体的哪个 revision（首版为 NULL）。
  derived_from_revision integer CHECK (derived_from_revision IS NULL OR derived_from_revision >= 1),
  created_at            timestamptz NOT NULL,
  CONSTRAINT admin_content_revisions_pkey PRIMARY KEY (entity_id, revision),
  -- 派生来源必须**早于**本次修订：自引用或未来引用只可能是写路径 bug。
  CONSTRAINT admin_content_revisions_derived_before_self CHECK (
    derived_from_revision IS NULL OR derived_from_revision < revision
  ),
  -- 实体没了，它的版本行就没有意义：注销清理（属主身份执行的独立切片）删实体时一并带走。
  CONSTRAINT admin_content_revisions_entity_fk
    FOREIGN KEY (entity_id) REFERENCES public.admin_content_entities (id) ON DELETE CASCADE
);

-- ---------------- 本域幂等台账 ----------------
-- 与 0018 的 `favorites_idempotency` / `history_idempotency` 逐列同形（claim / complete /
-- release 各是一条带条件的单语句；`outcome IS NULL` = 已认领未完成）。
-- `key_hash` 存 `idempotencyKeyHashHex()` 的 sha256 十六进制串（128 字符上限给未来换算法留余量）。
CREATE TABLE IF NOT EXISTS public.admin_content_idempotency (
  scope           varchar(200) NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 200),
  key_hash        varchar(128) NOT NULL CHECK (char_length(key_hash) BETWEEN 1 AND 128),
  request_hash    varchar(128) NOT NULL CHECK (char_length(request_hash) BETWEEN 1 AND 128),
  response_status smallint NOT NULL CHECK (response_status BETWEEN 100 AND 599),
  outcome         jsonb CHECK (outcome IS NULL OR jsonb_typeof(outcome) = 'object'),
  expires_at      timestamptz NOT NULL,
  CONSTRAINT admin_content_idempotency_pkey PRIMARY KEY (scope, key_hash)
);

-- 过期扫描（`purgeExpiredIdempotent`）：`WHERE expires_at <= $1`。
CREATE INDEX IF NOT EXISTS admin_content_idempotency_expires_idx
  ON public.admin_content_idempotency (expires_at);

COMMIT;