-- Operator-only fresh-db bootstrap. Runtime LOGIN inherits this AND auth_privacy.
-- No policy/recipient publishing or proof-editing permissions; trusted API, not RLS.
BEGIN;
-- R28-S48：裸 CREATE ROLE 不可重跑（第二次 42710 会把整文件事务打回），改为「pg_roles 存在性守卫
-- + EXECUTE」；紧随的 ALTER ROLE … WITH <同属性> 再把「已存在但属性漂移」的角色收敛回出厂属性。
DO $role_guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gengyun_consent_granter') THEN
    EXECUTE 'CREATE ROLE gengyun_consent_granter NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
  END IF;
END;
$role_guard$;
ALTER ROLE gengyun_consent_granter WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO gengyun_consent_granter;
GRANT SELECT ON consent_policies,recipients TO gengyun_consent_granter;
-- PG requires an UPDATE privilege for SHARE locks. Timestamps do not grant authority.
GRANT UPDATE(updated_at) ON consent_policies,recipients TO gengyun_consent_granter;
GRANT INSERT(user_id,purpose,policy_version,recipient_ids,state,epoch,revision) ON consent_records TO gengyun_consent_granter;
GRANT INSERT(user_id,purpose,current_epoch,state,revision) ON privacy_epochs TO gengyun_consent_granter;
COMMIT;
