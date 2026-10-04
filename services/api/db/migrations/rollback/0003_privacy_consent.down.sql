-- ============================================================================
-- GY-I27 / #29  迁移 0003 回滚
-- ----------------------------------------------------------------------------
-- 只回滚 0003 创建的「授权、外发及删除」子域对象与枚举，不触碰 0001/0002 的对象。
-- 顺序与 up 相反，先删表后删枚举。
-- ============================================================================
BEGIN;

DROP TABLE IF EXISTS user_training_consents;
DROP TABLE IF EXISTS third_party_deletions;
DROP TABLE IF EXISTS deletion_handlers;
DROP TABLE IF EXISTS deletion_requests;
DROP TABLE IF EXISTS exports;
DROP TABLE IF EXISTS privacy_epochs;
DROP TABLE IF EXISTS consent_records;
DROP TABLE IF EXISTS recipients;

DROP TYPE IF EXISTS handler_state;
DROP TYPE IF EXISTS deletion_state;
DROP TYPE IF EXISTS third_party_state;
DROP TYPE IF EXISTS export_state;
DROP TYPE IF EXISTS consent_state;
DROP TYPE IF EXISTS consent_purpose;

COMMIT;
