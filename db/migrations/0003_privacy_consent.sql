-- ============================================================================
-- GY-I27 / #29  前置用途授权、外发账本与隐私撤回接口守卫 — 迁移 0003
-- ----------------------------------------------------------------------------
-- 依赖：0001（GY-I02 初始迁移）拥有 users / sessions / media / jobs 等基础表，
--       0002（GY-I03 资料清单）拥有 crops/species/regions/sources 等资料表。
--      本迁移只处理「授权、外发及删除」子域 + 用户训练开关。
--
-- 合并顺序：0003 必须在 0001 之后执行（FK 引用 users.id）；对 0002 无硬依赖，
--      但建议按 0001 → 0002 → 0003 顺序整体执行。
--
-- 约束来源：docs/architecture/data-dictionary.md「授权、外发及删除」小节，
--      docs/architecture/state-contract.md「授权、撤回及注销」小节。
--      契约枚举只消费，不修改 packages/contracts/*。
--      枚举值与 packages/contracts/states.json 的 ConsentPurpose / DeletionState /
--      ThirdPartyState 逐项一致。
--
-- 关键安全约束：
--   * 首版训练开关关闭：user_training_consents.training_enabled 默认 false，
--     启用必须同时具备独立同意版本(consent_version)与模型谱系验收(model_lineage_ref)，
--     不存在仅靠开关放行训练的路径。
--   * 撤回递增 privacy_epochs.current_epoch，外发账本记录预留时的 consent_epoch /
--     auth_epoch，回写前须重查，取消/撤回/注销后的版本不可被回调复活。
--   * third_party_deletions 的 confirmed 要求 evidence_ref + confirmed_at，
--     requested 绝不等于 confirmed（不把请求当完成）。
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. 枚举（与 packages/contracts/states.json 一致，由 GY-I01 冻结，此处只消费）
-- ---------------------------------------------------------------------------
CREATE TYPE consent_purpose AS ENUM (
  'recording',            -- 录音（主动麦克风）
  'media_processing',     -- 媒体处理（本地去EXIF/压缩/衍生件）
  'external_inference',   -- 服务端推理外发（识别/OCR/ASR/LLM/审核）
  'public_posting'        -- 公开投稿
);

CREATE TYPE consent_state AS ENUM ('granted', 'withdrawn');

CREATE TYPE export_state AS ENUM ('reserved', 'sent', 'failed', 'outcome_unknown');

CREATE TYPE third_party_state AS ENUM (
  'not_requested', 'requested', 'confirmed', 'failed', 'unsupported'
);

CREATE TYPE deletion_state AS ENUM ('requested', 'processing', 'blocked', 'completed');

CREATE TYPE handler_state AS ENUM ('pending', 'running', 'completed', 'blocked');

-- ---------------------------------------------------------------------------
-- 2. 已验证接收方（管理表）。客户端只能选择当前 enabled 且已验证的接收方；
--    GY-I25 验证后置 enabled；版本变化需重新同意与契约/评估影响审查。
-- ---------------------------------------------------------------------------
CREATE TABLE recipients (
  id                     varchar(80) PRIMARY KEY,
  display_name           varchar(200) NOT NULL,
  capability             varchar(20) NOT NULL
      CHECK (capability IN ('weed', 'ocr', 'asr', 'tts', 'llm', 'moderation')),
  policy_version         varchar(80) NOT NULL,
  retention_online_days  integer NOT NULL DEFAULT 0
      CHECK (retention_online_days BETWEEN 0 AND 7),
  retention_backup_days  integer NOT NULL DEFAULT 0
      CHECK (retention_backup_days BETWEEN 0 AND 30),
  no_training_verified   boolean NOT NULL DEFAULT false,
  deletion_verified      boolean NOT NULL DEFAULT false,
  enabled                boolean NOT NULL DEFAULT false,
  config_version         varchar(40) NOT NULL,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 3. 用途授权记录（每个 epoch 一行，历史可追溯；当前 epoch 由 privacy_epochs 指向）
-- ---------------------------------------------------------------------------
CREATE TABLE consent_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id),
  purpose         consent_purpose NOT NULL,
  policy_version  varchar(80) NOT NULL,
  recipient_ids   jsonb NOT NULL DEFAULT '[]'::jsonb
      CHECK (jsonb_typeof(recipient_ids) = 'array'),
  state           consent_state NOT NULL DEFAULT 'granted',
  epoch           bigint NOT NULL CHECK (epoch >= 1),
  granted_at      timestamptz NOT NULL DEFAULT now(),
  withdrawn_at    timestamptz,
  revision        integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  -- granted 时 withdrawn_at 必空；withdrawn 时必填（撤回记录可追溯）
  CONSTRAINT consent_records_state_pair CHECK (
    (state = 'granted' AND withdrawn_at IS NULL)
    OR (state = 'withdrawn' AND withdrawn_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX consent_records_user_purpose_epoch_key
  ON consent_records (user_id, purpose, epoch);
CREATE INDEX consent_records_user_purpose_idx
  ON consent_records (user_id, purpose, epoch DESC);

-- ---------------------------------------------------------------------------
-- 4. 每用户每用途的当前 epoch（撤回事务原子递增；worker 发送与回写均核对）
--    0 表示「从未授权 / 已撤回」。
-- ---------------------------------------------------------------------------
CREATE TABLE privacy_epochs (
  user_id        uuid NOT NULL REFERENCES users (id),
  purpose        consent_purpose NOT NULL,
  current_epoch  bigint NOT NULL DEFAULT 0 CHECK (current_epoch >= 0),
  state          consent_state NOT NULL DEFAULT 'withdrawn',
  revision       integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, purpose)
);

-- ---------------------------------------------------------------------------
-- 5. 外发账本（真实图片/录音/转写/会话/任务的外发登记）
--    预留时锁定 consent_epoch / auth_epoch / recipient_config_version / source_version；
--    reserved 为初始态，sent/failed/outcome_unknown 为终态，回写前重查（守卫层实现）。
-- ---------------------------------------------------------------------------
CREATE TABLE exports (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid NOT NULL REFERENCES users (id),
  object_type               varchar(40) NOT NULL,
  object_id                 uuid NOT NULL,
  object_revision           integer NOT NULL CHECK (object_revision >= 1),
  purpose                   consent_purpose NOT NULL,
  consent_id                uuid,
  consent_epoch             bigint NOT NULL CHECK (consent_epoch >= 1),
  recipient_id              varchar(80) NOT NULL,
  recipient_config_version  varchar(40) NOT NULL,
  source_version            varchar(40),
  state                     export_state NOT NULL DEFAULT 'reserved',
  requested_at              timestamptz NOT NULL DEFAULT now(),
  sent_at                   timestamptz,
  provider_request_ref_cipher text,
  deletion_state            third_party_state NOT NULL DEFAULT 'not_requested',
  auth_epoch                bigint NOT NULL CHECK (auth_epoch >= 1),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX exports_user_created_idx ON exports (user_id, created_at, id);
CREATE INDEX exports_recipient_idx ON exports (recipient_id);
CREATE INDEX exports_state_idx ON exports (state);

-- ---------------------------------------------------------------------------
-- 6. 注销删除回执（独立回执，仅 hash 存储；查询无私有内容）
-- ---------------------------------------------------------------------------
CREATE TABLE deletion_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_hash    char(64) NOT NULL,
  generation      integer NOT NULL CHECK (generation >= 1),
  state           deletion_state NOT NULL DEFAULT 'requested',
  requested_at    timestamptz NOT NULL DEFAULT now(),
  online_due_at   timestamptz NOT NULL,   -- 受理 + 7×24 小时
  backup_due_at   timestamptz NOT NULL,   -- 受理 + 30×24 小时
  revision        integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  completed_at    timestamptz,
  -- completed 时必有 completed_at；截止顺序 online 先于 backup
  CONSTRAINT deletion_requests_complete_pair
    CHECK (state <> 'completed' OR completed_at IS NOT NULL),
  CONSTRAINT deletion_requests_due_order
    CHECK (online_due_at >= requested_at AND backup_due_at >= online_due_at)
);
CREATE UNIQUE INDEX deletion_requests_receipt_hash_key
  ON deletion_requests (receipt_hash);

-- ---------------------------------------------------------------------------
-- 7. 模块删除处理器（每个模块注册一个处理器；所有 handler 证据完成才可完结）
-- ---------------------------------------------------------------------------
CREATE TABLE deletion_handlers (
  request_id        uuid NOT NULL REFERENCES deletion_requests (id) ON DELETE CASCADE,
  module            varchar(80) NOT NULL,
  object_ref_cipher text NOT NULL,
  status            handler_state NOT NULL DEFAULT 'pending',
  online_state      handler_state NOT NULL DEFAULT 'pending',
  backup_state      handler_state NOT NULL DEFAULT 'pending',
  evidence_ref      text,
  error_code        varchar(80),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX deletion_handlers_key
  ON deletion_handlers (request_id, module, object_ref_cipher);

-- ---------------------------------------------------------------------------
-- 8. 第三方删除请求（请求/完成/失败可追溯；confirmed 必须有证据，不把请求当完成）
-- ---------------------------------------------------------------------------
CREATE TABLE third_party_deletions (
  request_id      uuid NOT NULL REFERENCES deletion_requests (id) ON DELETE CASCADE,
  recipient_id    varchar(80) NOT NULL,
  export_ref      uuid REFERENCES exports (id),
  online_status   third_party_state NOT NULL DEFAULT 'not_requested',
  backup_status   third_party_state NOT NULL DEFAULT 'not_requested',
  requested_at    timestamptz,
  confirmed_at    timestamptz,
  evidence_ref    text,
  error_code      varchar(80),
  -- confirmed 要求证据与确认时间（requested 绝不等于 confirmed）
  CONSTRAINT third_party_confirmed_evidence CHECK (
    (online_status <> 'confirmed' OR (confirmed_at IS NOT NULL AND evidence_ref IS NOT NULL))
  ),
  -- 已发请求必有 requested_at
  CONSTRAINT third_party_requested_time CHECK (
    (online_status NOT IN ('requested', 'confirmed', 'failed') OR requested_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX third_party_deletions_key
  ON third_party_deletions (request_id, recipient_id, export_ref);

-- ---------------------------------------------------------------------------
-- 9. 用户训练开关（首版默认关闭；启用前需独立同意 + 模型谱系验收）
--    训练不是首版 ConsentPurpose，本开关不与 consent_purpose 混用。
-- ---------------------------------------------------------------------------
CREATE TABLE user_training_consents (
  user_id             uuid PRIMARY KEY REFERENCES users (id),
  training_enabled    boolean NOT NULL DEFAULT false,
  consent_version     varchar(80),
  model_lineage_ref   varchar(120),
  granted_at          timestamptz,
  withdrawn_at        timestamptz,
  revision            integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- 关闭态：无同意、无谱系；启用态：必须三者齐备（独立同意 + 谱系 + 授予时间）。
  CONSTRAINT user_training_enable_requires_consent_lineage CHECK (
    (training_enabled = false AND consent_version IS NULL AND model_lineage_ref IS NULL AND granted_at IS NULL)
    OR (training_enabled = true AND consent_version IS NOT NULL AND model_lineage_ref IS NOT NULL AND granted_at IS NOT NULL)
  )
);

COMMIT;
