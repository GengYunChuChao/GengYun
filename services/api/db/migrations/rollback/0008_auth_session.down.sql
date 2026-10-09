-- 0008_auth_session.down.sql
-- GY-I04 迁移 0008 回滚：仅删除本迁移新增的幂等键台账及其索引。
-- 不动 0001 的 users / sessions / admin_accounts / admin_sessions / admin_scopes，
-- 也不动 Codex #51–#55 的 0004~0007 对象。
-- 运行器只发现 NNNN_name.sql，本文件放在 rollback/ 子目录，不进入正向发现集。

BEGIN;

DROP INDEX IF EXISTS idempotency_keys_expires_idx;
DROP INDEX IF EXISTS idempotency_keys_scope_key;
DROP TABLE IF EXISTS idempotency_keys;

COMMIT;
