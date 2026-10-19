-- Operator-only, fresh dedicated database bootstrap; not a schema migration.
-- Provision a private LOGIN separately. Never run the API as migration owner.
-- This is a trusted API service group, NOT per-user RLS or a client SQL login.
BEGIN;
CREATE ROLE gengyun_auth_privacy NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $$ BEGIN
  EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO gengyun_auth_privacy;
GRANT SELECT (id,state,auth_epoch,revision,wechat_subject_lookup) ON users TO gengyun_auth_privacy;
GRANT INSERT (wechat_subject_lookup,wechat_subject_cipher) ON users TO gengyun_auth_privacy;
-- PG row locks require UPDATE on at least one column; account state/epoch remain operator-only.
GRANT UPDATE (updated_at) ON users TO gengyun_auth_privacy;
GRANT SELECT (id,user_id,token_hash,audience,auth_epoch,expires_at,revoked_at) ON sessions TO gengyun_auth_privacy;
GRANT INSERT (user_id,token_hash,audience,auth_epoch,expires_at) ON sessions TO gengyun_auth_privacy;
GRANT UPDATE (token_hash,revoked_at) ON sessions TO gengyun_auth_privacy;
GRANT SELECT (id,login_name,state,auth_epoch,revision,credential_hash) ON admin_accounts TO gengyun_auth_privacy;
GRANT SELECT (admin_id,scope,revoked_at) ON admin_scopes TO gengyun_auth_privacy;
GRANT SELECT (id,admin_id,token_hash,audience,auth_epoch,expires_at,revoked_at) ON admin_sessions TO gengyun_auth_privacy;
GRANT INSERT (admin_id,token_hash,audience,auth_epoch,expires_at) ON admin_sessions TO gengyun_auth_privacy;
GRANT UPDATE (token_hash,revoked_at) ON admin_sessions TO gengyun_auth_privacy;
-- Admin bootstrap remains a separate privileged operation, never this runtime role.
GRANT SELECT,INSERT,DELETE ON idempotency_keys TO gengyun_auth_privacy;
GRANT UPDATE (outcome,response_status) ON idempotency_keys TO gengyun_auth_privacy;
GRANT SELECT ON consent_records,privacy_epochs TO gengyun_auth_privacy;
GRANT UPDATE (state,withdrawn_at,revision) ON consent_records TO gengyun_auth_privacy;
GRANT UPDATE (current_epoch,state,revision,updated_at) ON privacy_epochs TO gengyun_auth_privacy;
-- Only existence checks for conservative withdrawal refusal. No content access or mutation.
GRANT SELECT (owner_id) ON jobs,media TO gengyun_auth_privacy;
GRANT SELECT (user_id) ON exports,author_links TO gengyun_auth_privacy;
-- GY-I19（#19）· 逐用户备份副本清单（迁移 0023，设计 §4/§7.2）。
-- 受理事务里要写清单行、清除时要重读状态并落证据，所以运行时角色需要这三类权限；
-- 但一律按**列**授予，⛔ 不给表级 DML（`90-assert-least-privilege.sql` 的
-- `table_dml_allowlist` 只允许 idempotency_keys 有表级写入；列级授权不影响该断言）。
-- SELECT 必须含 `request_id,user_id,module,state,retention_until`：UPDATE 的 WHERE 要读它们；
-- 还必须含 `purge_attempts`：失败留痕是 `purge_attempts = purge_attempts + 1`，读右边也要 SELECT 权。
-- ⛔ 不给 DELETE/TRUNCATE：清单行是「清过」的唯一证据，运行时不得删行（设计 §5.3）。
--
-- 条件化：本文件同时被若干只建 schema **子集**的单测夹具执行（不含 0023），裸 `GRANT` 会在
-- 那些夹具里 42P01 直接炸掉。表不存在时跳过授权，保持本文件对子集夹具的兼容性。
-- ⛔ 这不是「缺表也能上线」的让步：部署路径 `deploy/postgres-cvm/sql/20-login-roles.sql` 的
-- `gy-i19-backup-copies-grant` 区域在缺表时 `RAISE EXCEPTION`（迁移 0023 未执行即失败），
-- 前置校验由那里把关；本文件只负责把权限收敛给运行时组。
DO $gy_i19_copies$
BEGIN
  IF to_regclass('public.user_backup_copies') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE $gy$GRANT SELECT (id,user_id,request_id,module,scope,state,retention_until,payload_digest,evidence_ref,purge_attempts)
    ON user_backup_copies TO gengyun_auth_privacy$gy$;
  EXECUTE $gy$GRANT INSERT (id,user_id,request_id,module,scope,delete_generation,lineage,covered_through,
              payload,payload_digest,state,retention_until,purge_attempts,created_at,updated_at)
    ON user_backup_copies TO gengyun_auth_privacy$gy$;
  -- 清除路径只改这几列：payload 置 null、state→purged/failed、证据、尝试次数、时间。
  EXECUTE $gy$GRANT UPDATE (payload,state,purged_at,evidence_ref,last_error_code,purge_attempts,updated_at)
    ON user_backup_copies TO gengyun_auth_privacy$gy$;
END;
$gy_i19_copies$;
COMMIT;
