-- Operator-only bootstrap after 0010; never an API owner or per-user SQL role.
-- Compose with unchanged gengyun_auth_privacy on a separately provisioned
-- restricted LOGIN. No private base table or publication privilege is granted.
BEGIN;
CREATE ROLE gengyun_knowledge_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA catalog_read TO gengyun_knowledge_runtime;
GRANT SELECT ON catalog_read.current_knowledge TO gengyun_knowledge_runtime;
COMMIT;
