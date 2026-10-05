-- 0001_initial_schema.sql
-- 耕云初始迁移（GY-I02）。输入：docs/architecture/data-dictionary.md。
--
-- 范围：工程壳可运行所需的最小 coherent 子集——身份/后台会话、基础资料、来源版本、
--       私有媒体、任务台账、社区内容与媒体授权（含 ADR-001 修订2 要求的
--       media_revision / author revision / community_media_grants 字段）。
-- 说明：本文件不是数据字典的完整实现。字典中其余表（识别、问答、收藏、消息、
--       删除清单、外发账本等）在后续迁移中按同一契约补齐，见
--       docs/engineering-shell.md“迁移与未完成范围”。
--
-- 约定（来自数据字典）：id UUID；revision positive integer；时间戳 timestamptz(UTC)；
--       hash 为 SHA-256 hex；秘密用密文列（*_cipher），不明文入库。

-- ---------- 枚举 ----------
CREATE TYPE user_state AS ENUM ('active', 'suspended', 'deletion_pending', 'deleted');
CREATE TYPE admin_state AS ENUM ('active', 'suspended');
CREATE TYPE session_audience AS ENUM ('user', 'admin');
CREATE TYPE source_kind AS ENUM ('database', 'verified_seed', 'simulation');
CREATE TYPE evidence_kind AS ENUM ('research', 'experience', 'mixed');
CREATE TYPE source_validity AS ENUM ('valid', 'expired', 'conflicting', 'unknown', 'withdrawn');
CREATE TYPE review_status AS ENUM ('unverified', 'verified', 'rejected');
CREATE TYPE media_purpose AS ENUM ('weed_recognition', 'label_ocr', 'voice_question', 'community_image');
CREATE TYPE media_state AS ENUM ('initiated', 'uploaded', 'processing', 'ready', 'rejected', 'deleting', 'deleted');
CREATE TYPE job_state AS ENUM ('queued', 'running', 'succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled');
CREATE TYPE visibility AS ENUM ('private', 'published', 'hidden', 'deleted');
CREATE TYPE audit_state AS ENUM ('pending', 'approved', 'rejected', 'quarantined');
CREATE TYPE public_author_state AS ENUM ('active', 'anonymized');
CREATE TYPE media_slot AS ENUM ('attachment', 'author_avatar');
CREATE TYPE linked_target_type AS ENUM ('species', 'herbicide', 'scheme');

-- ---------- 身份与权限 ----------
CREATE TABLE users (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wechat_subject_cipher   text,
  wechat_subject_lookup   bytea,
  state                   user_state NOT NULL DEFAULT 'active',
  auth_epoch              bigint NOT NULL DEFAULT 1 CHECK (auth_epoch >= 1),
  revision                integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  nickname                varchar(40),
  avatar_media_id         uuid,
  deletion_generation     integer NOT NULL DEFAULT 0 CHECK (deletion_generation >= 0),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
-- 注销后擦除 lookup；匿名化由应用事务完成，不在数据库强制保留被删身份。
CREATE UNIQUE INDEX users_subject_lookup_key ON users (wechat_subject_lookup);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id),
  token_hash  bytea NOT NULL,
  audience    session_audience NOT NULL DEFAULT 'user',
  auth_epoch  bigint NOT NULL CHECK (auth_epoch >= 1),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_audience_is_user CHECK (audience = 'user'),
  CONSTRAINT sessions_expires_after_creation CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX sessions_user_active_idx ON sessions (user_id, revoked_at);

CREATE TABLE admin_accounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login_name       varchar(80) NOT NULL,
  credential_hash  text NOT NULL,
  state            admin_state NOT NULL DEFAULT 'active',
  auth_epoch       bigint NOT NULL DEFAULT 1 CHECK (auth_epoch >= 1),
  revision         integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX admin_accounts_login_name_key ON admin_accounts (login_name);

CREATE TABLE admin_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    uuid NOT NULL REFERENCES admin_accounts (id),
  token_hash  bytea NOT NULL,
  audience    session_audience NOT NULL DEFAULT 'admin',
  auth_epoch  bigint NOT NULL CHECK (auth_epoch >= 1),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_sessions_audience_is_admin CHECK (audience = 'admin'),
  CONSTRAINT admin_sessions_expires_after_creation CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX admin_sessions_token_hash_key ON admin_sessions (token_hash);

CREATE TABLE admin_scopes (
  admin_id    uuid NOT NULL REFERENCES admin_accounts (id),
  scope       varchar(40) NOT NULL,
  granted_by  uuid REFERENCES admin_accounts (id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  PRIMARY KEY (admin_id, scope)
);

CREATE TABLE single_profiles (
  user_id                 uuid PRIMARY KEY REFERENCES users (id),
  crop_id                 varchar(40) NOT NULL,
  region_code             varchar(6) NOT NULL,
  region_catalog_version  varchar(40) NOT NULL,
  revision                integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- ---------- 资料、来源 ----------
CREATE TABLE crops (
  id      varchar(40) PRIMARY KEY,
  name    varchar(80) NOT NULL,
  active  boolean NOT NULL DEFAULT true
);

CREATE TABLE species (
  id              varchar(40) PRIMARY KEY,
  canonical_name  varchar(120) NOT NULL,
  scientific_name varchar(160),
  aliases         jsonb NOT NULL DEFAULT '[]'::jsonb,
  coverage_state  varchar(20) NOT NULL DEFAULT 'unknown'
);
CREATE UNIQUE INDEX species_canonical_name_key ON species (canonical_name);

CREATE TABLE regions (
  code            varchar(6) PRIMARY KEY,
  parent_code     varchar(6),
  name            varchar(80) NOT NULL,
  catalog_version varchar(40) NOT NULL,
  supported       boolean NOT NULL DEFAULT false
);

CREATE TABLE sources (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title              varchar(200) NOT NULL,
  canonical_url      text NOT NULL,
  publisher          varchar(120) NOT NULL,
  source_kind        source_kind NOT NULL,
  evidence_kind      evidence_kind NOT NULL,
  current_version_id uuid,
  revision           integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE source_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id      uuid NOT NULL REFERENCES sources (id),
  version        varchar(40) NOT NULL,
  content_hash   char(64) NOT NULL,
  locator        text NOT NULL,
  retrieved_at   timestamptz NOT NULL,
  valid_from     timestamptz NOT NULL,
  valid_to       timestamptz,
  validity       source_validity NOT NULL DEFAULT 'unknown',
  review_status  review_status NOT NULL DEFAULT 'unverified',
  reviewed_by    uuid REFERENCES admin_accounts (id),
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_versions_valid_range CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT source_versions_review_pair CHECK (
    (review_status = 'unverified' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (review_status <> 'unverified')
  )
);
CREATE UNIQUE INDEX source_versions_source_version_key ON source_versions (source_id, version);
CREATE INDEX source_versions_source_validity_idx ON source_versions (source_id, validity);

ALTER TABLE sources
  ADD CONSTRAINT sources_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES source_versions (id);

-- ---------- 私有媒体 ----------
CREATE TABLE media (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          uuid NOT NULL REFERENCES users (id),
  purpose           media_purpose NOT NULL,
  mime              varchar(120) NOT NULL,
  bytes             bigint NOT NULL CHECK (bytes > 0),
  duration_ms       integer CHECK (duration_ms IS NULL OR (duration_ms > 0 AND duration_ms <= 60000)),
  sha256            char(64) NOT NULL,
  state             media_state NOT NULL DEFAULT 'initiated',
  failure_code      varchar(80),
  object_ref_cipher text NOT NULL,
  revision          integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  consent_epoch     bigint NOT NULL DEFAULT 0 CHECK (consent_epoch >= 0),
  expires_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- 契约 MediaPurpose=voice_question 单次录音最长 60 秒，产品限额见 implementation-requirements F12。
  CONSTRAINT media_voice_has_duration CHECK (purpose <> 'voice_question' OR duration_ms IS NOT NULL)
);
CREATE INDEX media_owner_created_idx ON media (owner_id, created_at, id);

CREATE TABLE media_derivatives (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id          uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
  derivative_kind   varchar(40) NOT NULL,
  object_ref_cipher text NOT NULL,
  hash              char(64) NOT NULL,
  state             media_state NOT NULL DEFAULT 'initiated'
);
CREATE UNIQUE INDEX media_derivatives_kind_hash_key ON media_derivatives (media_id, derivative_kind, hash);

-- ---------- 任务台账 ----------
CREATE TABLE jobs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id                uuid REFERENCES users (id),
  actor_admin_id          uuid REFERENCES admin_accounts (id),
  kind                    varchar(40) NOT NULL,
  target_type             varchar(40) NOT NULL,
  target_id               uuid NOT NULL,
  entity_revision         integer NOT NULL CHECK (entity_revision >= 1),
  state                   job_state NOT NULL DEFAULT 'queued',
  revision                integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  input_hash              char(64) NOT NULL,
  auth_epoch              bigint NOT NULL CHECK (auth_epoch >= 1),
  consent_epoch           bigint NOT NULL DEFAULT 0 CHECK (consent_epoch >= 0),
  deadline_at             timestamptz NOT NULL,
  lease_token             uuid,
  lease_expires_at        timestamptz,
  attempt                 integer NOT NULL DEFAULT 0 CHECK (attempt >= 0 AND attempt <= 3),
  retry_of                uuid REFERENCES jobs (id),
  provider_config_version varchar(40),
  error_code              varchar(80),
  result_ref              uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  -- owner 与 admin 恰一（数据字典：owner/admin恰一）。
  CONSTRAINT jobs_single_actor CHECK ((owner_id IS NOT NULL)::int + (actor_admin_id IS NOT NULL)::int = 1)
);
CREATE INDEX jobs_lease_idx ON jobs (state, deadline_at, lease_expires_at);
CREATE INDEX jobs_owner_created_idx ON jobs (owner_id, created_at, id);

-- ---------- 社区与媒体授权 ----------
CREATE TABLE public_authors (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name           varchar(40) NOT NULL,
  avatar_media_id        uuid,
  avatar_media_revision  integer CHECK (avatar_media_revision IS NULL OR avatar_media_revision >= 1),
  avatar_audit_state     audit_state,
  public_posting_epoch   bigint NOT NULL DEFAULT 1 CHECK (public_posting_epoch >= 1),
  state                  public_author_state NOT NULL DEFAULT 'active',
  revision               integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at             timestamptz NOT NULL DEFAULT now(),
  -- ADR-001 修订2：头像媒体版本与媒体 id 必须成对出现。
  CONSTRAINT public_authors_avatar_pair CHECK (
    (avatar_media_id IS NULL AND avatar_media_revision IS NULL AND avatar_audit_state IS NULL)
    OR (avatar_media_id IS NOT NULL AND avatar_media_revision IS NOT NULL AND avatar_audit_state IS NOT NULL)
  )
);

-- 私有的账号 <-> 公开作者映射；注销时销毁，无逆向 user 引用保留在公开表。
CREATE TABLE author_links (
  user_id           uuid NOT NULL REFERENCES users (id),
  public_author_id  uuid NOT NULL REFERENCES public_authors (id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX author_links_user_key ON author_links (user_id);
CREATE UNIQUE INDEX author_links_public_author_key ON author_links (public_author_id);

CREATE TABLE posts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_ref       uuid NOT NULL REFERENCES public_authors (id),
  current_revision integer NOT NULL CHECK (current_revision >= 1),
  visibility       visibility NOT NULL DEFAULT 'private',
  revision         integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX posts_visibility_created_idx ON posts (visibility, created_at, id);

CREATE TABLE post_versions (
  post_id                 uuid NOT NULL REFERENCES posts (id),
  revision                integer NOT NULL CHECK (revision >= 1),
  title                   varchar(120) NOT NULL,
  body                    text NOT NULL,
  crop_id                 varchar(40),
  region_code             varchar(6),
  linked_target_type      linked_target_type,
  linked_target_id        uuid,
  linked_target_revision  integer,
  audit_state             audit_state NOT NULL DEFAULT 'pending',
  created_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, revision),
  -- linked_knowledge 关联三列同空或同有（ADR-001 修订2）。第二分支显式要求 revision 非空，
  -- 避免 revision IS NULL 时 `revision >= 1` 得到 UNKNOWN 而被 CHECK 放行。
  CONSTRAINT post_versions_link_triple CHECK (
    (linked_target_type IS NULL AND linked_target_id IS NULL AND linked_target_revision IS NULL)
    OR (linked_target_type IS NOT NULL AND linked_target_id IS NOT NULL
        AND linked_target_revision IS NOT NULL AND linked_target_revision >= 1)
  )
);
CREATE INDEX post_versions_linked_idx ON post_versions (linked_target_type, linked_target_id, linked_target_revision);

-- 内容引用的媒体必须带实际审核的 media_revision，不能用 content_revision 代替。
CREATE TABLE content_media_refs (
  target_type       varchar(40) NOT NULL,
  target_id         uuid NOT NULL,
  content_revision  integer NOT NULL CHECK (content_revision >= 1),
  media_id          uuid NOT NULL REFERENCES media (id),
  media_revision    integer NOT NULL CHECK (media_revision >= 1),
  purpose_epoch     bigint NOT NULL DEFAULT 0 CHECK (purpose_epoch >= 0),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX content_media_refs_unique ON content_media_refs (target_type, target_id, content_revision, media_id);

-- 短期受控取图授权；token 只存 hash，到期由在线 handler 清理，注销纳入删除范围。
CREATE TABLE community_media_grants (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id         uuid NOT NULL REFERENCES users (id),
  session_ref          uuid NOT NULL,
  requester_auth_epoch bigint NOT NULL CHECK (requester_auth_epoch >= 1),
  content_type         varchar(40) NOT NULL,
  content_id           uuid NOT NULL,
  content_revision     integer NOT NULL CHECK (content_revision >= 1),
  slot                 media_slot NOT NULL,
  media_id             uuid NOT NULL REFERENCES media (id),
  media_revision       integer NOT NULL CHECK (media_revision >= 1),
  author_ref           uuid REFERENCES public_authors (id),
  author_revision      integer,
  parent_post_id       uuid,
  parent_revision      integer,
  public_posting_epoch bigint NOT NULL CHECK (public_posting_epoch >= 1),
  content_owner_epoch  bigint NOT NULL DEFAULT 0 CHECK (content_owner_epoch >= 0),
  token_hash           bytea NOT NULL,
  expires_at           timestamptz NOT NULL,
  revoked_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT community_media_grants_ttl CHECK (expires_at <= created_at + interval '300 seconds')
);
CREATE UNIQUE INDEX community_media_grants_token_key ON community_media_grants (token_hash);
CREATE INDEX community_media_grants_lookup_idx ON community_media_grants (content_id, media_id, expires_at);
