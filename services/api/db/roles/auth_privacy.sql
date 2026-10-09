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
COMMIT;
