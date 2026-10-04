-- ============================================================================
-- GY-I03 / #3  资料清单与可替换数据库适配 — 迁移 0002
-- ----------------------------------------------------------------------------
-- 依赖：0001（GY-I02 初始迁移）已创建共享字典表与枚举类型。本迁移**不重复创建**
-- 下列共享字典表，而是直接引用 0001 的真实定义（docs/architecture/data-dictionary.md
-- 与 0001 为唯一真相）：
--   * crops(id varchar(40) PK, name varchar(80), active boolean)
--   * species(id varchar(40) PK, canonical_name, scientific_name, aliases jsonb,
--     coverage_state varchar(20) DEFAULT 'unknown')
--   * regions(code varchar(6) PK, parent_code, name varchar(80), catalog_version,
--     supported boolean DEFAULT false)  -- 注意：无 level 列
--   * sources(id uuid PK DEFAULT gen_random_uuid(), title, canonical_url,
--     publisher varchar(120), source_kind source_kind ENUM, evidence_kind
--     evidence_kind ENUM, current_version_id uuid, revision integer,
--     created_at timestamptz)  -- 注意：无 license_status/licensed 列
--   * source_versions(id uuid PK, source_id uuid REFERENCES sources(id),
--     version, content_hash char(64), locator, retrieved_at timestamptz,
--     valid_from/valid_to timestamptz, validity source_validity ENUM,
--     review_status review_status ENUM, reviewed_by uuid REFERENCES
--     admin_accounts(id), reviewed_at, created_at)
--
-- 本迁移只负责：业务表（制剂/登记/适用/限制/知识版本）、GY-I03 适配层审计表、
-- 以及只读投影视图。所有对 sources/source_versions 的引用均使用 0001 的 uuid 类型，
-- 确保 0001 → 0002 顺序执行无 42804/23503。
--
-- 合并顺序：0002 必须在 0001 之后执行。
-- 约束来源：docs/architecture/data-dictionary.md。契约枚举只消费，不修改
-- packages/contracts/*。
--
-- 关键安全约束：
--   * applicability.card_ready 只有全部原文条件与用量字段非空才可为 true，
--     即“缺失/未核对不得标为可用”。
--   * 模拟来源（source_kind='simulation'）不进入 v_active_source_version。
--   * 未接入真实库前，本迁移只建结构，不含任何真实私有数据。
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. 业务表（制剂/登记/适用/限制/知识版本）
--    所有引用共享字典表的列均与 0001 的类型一致：uuid ↔ uuid，varchar(40) ↔ varchar(40)。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS formulations (
    id                   uuid PRIMARY KEY,
    registration_number  varchar(80) NOT NULL,
    producer             varchar(200) NOT NULL,
    dosage_form          varchar(80) NOT NULL,
    ingredients          jsonb NOT NULL,
    identity_hash        char(64) NOT NULL CHECK (identity_hash ~ '^[0-9a-f]{64}$'),
    UNIQUE (registration_number, identity_hash),
    CHECK (jsonb_typeof(ingredients) = 'array' AND jsonb_array_length(ingredients) >= 1)
);

CREATE TABLE IF NOT EXISTS registrations (
    id                       uuid PRIMARY KEY,
    formulation_id           uuid NOT NULL REFERENCES formulations(id),
    source_version_id        uuid NOT NULL REFERENCES source_versions(id),
    registered_name          varchar(120) NOT NULL,
    registration_valid_from  date,
    registration_valid_to    date,
    status                   varchar(20) NOT NULL
        CHECK (status IN ('valid','expired','unknown','conflicting')),
    UNIQUE (formulation_id, source_version_id),
    CHECK (registration_valid_to IS NULL
           OR registration_valid_from IS NULL
           OR registration_valid_to >= registration_valid_from)
);

CREATE TABLE IF NOT EXISTS applicability (
    id                uuid PRIMARY KEY,
    registration_id   uuid NOT NULL REFERENCES registrations(id),
    source_version_id uuid NOT NULL REFERENCES source_versions(id),
    crop_id           varchar(40) REFERENCES crops(id),
    species_id        varchar(40) REFERENCES species(id),
    region_code       varchar(6),
    growth_stage      varchar(80),
    planting_method   varchar(80),
    use_scene         varchar(80),
    method_text       text,
    precautions_text  text,
    dose_text         text,
    unit_text         varchar(80),
    locator           varchar(200),
    content_hash      char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    conditions_hash   char(64) NOT NULL CHECK (conditions_hash ~ '^[0-9a-f]{64}$'),
    card_ready        boolean NOT NULL DEFAULT false,
    UNIQUE (registration_id, source_version_id, conditions_hash),
    -- 缺失/未核对不得标为可用（DoseCard 条件）
    CHECK (
        card_ready IS FALSE
        OR (
            crop_id IS NOT NULL AND species_id IS NOT NULL AND region_code IS NOT NULL
            AND growth_stage IS NOT NULL AND planting_method IS NOT NULL
            AND use_scene IS NOT NULL AND unit_text IS NOT NULL
            AND dose_text IS NOT NULL AND method_text IS NOT NULL
            AND precautions_text IS NOT NULL
        )
    )
);

CREATE TABLE IF NOT EXISTS restriction_rules (
    id                uuid PRIMARY KEY,
    source_version_id uuid NOT NULL REFERENCES source_versions(id),
    rule_version      varchar(40) NOT NULL,
    formulation_id    uuid REFERENCES formulations(id),
    crop_id           varchar(40) REFERENCES crops(id),
    species_id        varchar(40) REFERENCES species(id),
    region_code       varchar(6) NOT NULL,
    growth_stage      varchar(80),
    use_scene         varchar(80),
    effect            varchar(20) NOT NULL
        CHECK (effect IN ('prohibited','restricted','unknown')),
    reason            text NOT NULL,
    valid_from        date NOT NULL,
    valid_to          date,
    CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX IF NOT EXISTS ix_restriction_region_formulation
    ON restriction_rules (region_code, formulation_id, valid_from);

CREATE TABLE IF NOT EXISTS knowledge_versions (
    id                uuid PRIMARY KEY,
    knowledge_id      uuid NOT NULL,
    revision          integer NOT NULL CHECK (revision >= 1),
    title             varchar(200) NOT NULL,
    body              text NOT NULL,
    type              varchar(20) NOT NULL
        CHECK (type IN ('species','herbicide','scheme','static_region')),
    source_version_id uuid NOT NULL REFERENCES source_versions(id),
    crop_ids          jsonb NOT NULL DEFAULT '[]'::jsonb,
    species_ids       jsonb NOT NULL DEFAULT '[]'::jsonb,
    region_codes      jsonb NOT NULL DEFAULT '[]'::jsonb,
    visibility        varchar(20) NOT NULL
        CHECK (visibility IN ('private','published','hidden','deleted')),
    UNIQUE (knowledge_id, revision)
);

-- ---------------------------------------------------------------------------
-- 2. GY-I03 适配层专属表（模式、导入审计、冲突、来源更新/回滚）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_dataset_modes (
    mode                varchar(20) PRIMARY KEY
        CHECK (mode IN ('real','stub','preset_demo')),
    description         text NOT NULL,
    -- 该模式下允许的来源类型；来源与执行模式分开（契约 SourceKind / ExecutionMode）
    accepts_database        boolean NOT NULL DEFAULT false,
    accepts_verified_seed   boolean NOT NULL DEFAULT false,
    accepts_simulation      boolean NOT NULL DEFAULT false,
    requires_clear_label    boolean NOT NULL DEFAULT false,
    -- 真实模式不得直接接受模拟数据
    CHECK (mode <> 'real' OR accepts_simulation = false),
    -- preset_demo 只做演示兜底，必须带明显标记
    CHECK (mode <> 'preset_demo' OR (accepts_simulation = true AND requires_clear_label = true))
);

-- 当前生效模式（服务端配置写入；接口不接受客户端切换，见 ADR-001）
CREATE TABLE IF NOT EXISTS knowledge_dataset_config (
    key         varchar(40) PRIMARY KEY,
    value       text NOT NULL,
    mode        varchar(20) NOT NULL REFERENCES knowledge_dataset_modes(mode),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_import_runs (
    id              uuid PRIMARY KEY,
    mode            varchar(20) NOT NULL REFERENCES knowledge_dataset_modes(mode),
    dataset         varchar(40) NOT NULL,
    started_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz,
    status          varchar(20) NOT NULL
        CHECK (status IN ('running','succeeded','failed','reverted')),
    records_in      integer NOT NULL DEFAULT 0 CHECK (records_in >= 0),
    records_ok      integer NOT NULL DEFAULT 0 CHECK (records_ok >= 0),
    records_conflict integer NOT NULL DEFAULT 0 CHECK (records_conflict >= 0),
    records_skipped integer NOT NULL DEFAULT 0 CHECK (records_skipped >= 0),
    output_hash     char(64),
    note            text
);

CREATE TABLE IF NOT EXISTS catalog_import_conflicts (
    id             uuid PRIMARY KEY,
    run_id         uuid NOT NULL REFERENCES catalog_import_runs(id) ON DELETE CASCADE,
    entity         varchar(40) NOT NULL,
    business_key   varchar(120) NOT NULL,
    field_name     varchar(80),
    existing_value text,
    incoming_value text,
    resolution     varchar(20) NOT NULL
        CHECK (resolution IN ('rejected','kept_existing','accepted_incoming','deferred')),
    detected_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_conflicts_run ON catalog_import_conflicts (run_id);

CREATE TABLE IF NOT EXISTS catalog_source_update_events (
    id                uuid PRIMARY KEY,
    source_id         uuid NOT NULL REFERENCES sources(id),
    source_version_id uuid REFERENCES source_versions(id),
    event             varchar(20) NOT NULL
        CHECK (event IN ('imported','validity_changed','withdrawn','rolled_back')),
    old_validity      varchar(20),
    new_validity      varchar(20),
    occurred_at       timestamptz NOT NULL DEFAULT now(),
    reverted_at       timestamptz,
    reason            text NOT NULL
);

-- ---------------------------------------------------------------------------
-- 3. 读取投影：只有 有效 + 已审阅 + 非模拟 的版本才可用于检索/卡片
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_active_source_version AS
    SELECT sv.*, s.source_kind
    FROM source_versions sv
    JOIN sources s ON s.id = sv.source_id
    WHERE sv.validity = 'valid'
      AND sv.review_status = 'verified'
      AND s.source_kind <> 'simulation';

-- 联调/演示可用集合：只要求来源版本有效且非模拟；**明确暴露 review_status=unverified**，
-- 消费方必须据此标注“未核对”，不得当作已审。严禁在 real 模式当作权威来源。
CREATE OR REPLACE VIEW v_queryable_seed_version AS
    SELECT sv.*, s.source_kind
    FROM source_versions sv
    JOIN sources s ON s.id = sv.source_id
    WHERE sv.validity = 'valid'
      AND s.source_kind IN ('database','verified_seed');

-- 仅条件完整、且其来源版本当前有效的适用项才进入可用集合
CREATE OR REPLACE VIEW v_knowledge_applicability AS
    SELECT a.*
    FROM applicability a
    JOIN v_active_source_version v ON v.id = a.source_version_id
    WHERE a.card_ready IS TRUE;

-- 模拟资料单独视图，供演示/测试显式取用，禁止混入真实查询
CREATE OR REPLACE VIEW v_simulation_only AS
    SELECT f.registration_number, f.producer, r.registered_name, r.status, sv.source_id
    FROM formulations f
    JOIN registrations r ON r.formulation_id = f.id
    JOIN source_versions sv ON sv.id = r.source_version_id
    JOIN sources s ON s.id = sv.source_id
    WHERE s.source_kind = 'simulation';

COMMIT;
