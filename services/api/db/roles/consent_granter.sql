-- Operator-only fresh-db bootstrap. Runtime LOGIN inherits this AND auth_privacy.
-- No policy/recipient publishing or proof-editing permissions; trusted API, not RLS.
BEGIN;
CREATE ROLE gengyun_consent_granter NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO gengyun_consent_granter;
GRANT SELECT ON consent_policies,recipients TO gengyun_consent_granter;
-- PG requires an UPDATE privilege for SHARE locks. Timestamps do not grant authority.
GRANT UPDATE(updated_at) ON consent_policies,recipients TO gengyun_consent_granter;
GRANT INSERT(user_id,purpose,policy_version,recipient_ids,state,epoch,revision) ON consent_records TO gengyun_consent_granter;
GRANT INSERT(user_id,purpose,current_epoch,state,revision) ON privacy_epochs TO gengyun_consent_granter;
COMMIT;
