-- ============================================================================
-- GY-I03 / #3  迁移 0002 回滚
-- ----------------------------------------------------------------------------
-- 只回滚 0002 创建的对象：业务表（制剂/登记/适用/限制/知识版本）、GY-I03 适配层
-- 审计表与只读视图。
--
-- 共享字典表（crops/species/regions/sources/source_versions）由 0001 拥有，
-- 0002 未创建，本回滚**不删除**它们；其数据回滚见 db/seeds/rollback_seed.sql。
-- ============================================================================
BEGIN;

DROP VIEW IF EXISTS v_simulation_only;
DROP VIEW IF EXISTS v_knowledge_applicability;
DROP VIEW IF EXISTS v_queryable_seed_version;
DROP VIEW IF EXISTS v_active_source_version;

DROP TABLE IF EXISTS catalog_source_update_events;
DROP TABLE IF EXISTS catalog_import_conflicts;
DROP TABLE IF EXISTS catalog_import_runs;
DROP TABLE IF EXISTS knowledge_dataset_config;
DROP TABLE IF EXISTS knowledge_dataset_modes;

-- 0002 业务表（按依赖顺序：先删引用方，再删被引用方）
DROP TABLE IF EXISTS restriction_rules;
DROP TABLE IF EXISTS applicability;
DROP TABLE IF EXISTS registrations;
DROP TABLE IF EXISTS knowledge_versions;
DROP TABLE IF EXISTS formulations;

COMMIT;
