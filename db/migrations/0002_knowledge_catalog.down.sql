-- ============================================================================
-- GY-I03 / #3  迁移 0002 回滚
-- ----------------------------------------------------------------------------
-- 只回滚 GY-I03 适配层专属对象（模式/导入审计/冲突/来源更新）与只读视图。
--
-- 共享字典表（crops/species/regions/sources/source_versions/formulations/
-- registrations/applicability/restriction_rules/knowledge_versions）与 0001
-- 共源：若 0001 已创建，逐一下 DROP 会连带删除 0001 的对象，属破坏性操作。
-- 因此本回滚**不删除**这些共享表；其数据回滚见 db/seeds/rollback_seed.sql。
-- 仅当确认 0002 是这些表的唯一创建者（例如只跑过 0002 的临时库）时，才可显式
-- 手工 DROP，并自行承担后果。
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

COMMIT;
