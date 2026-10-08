-- Operator-only bootstrap for a fresh dedicated database, NOT a migration.
-- NOLOGIN groups: provision environment-specific LOGIN identities separately,
-- with credentials in private configuration. Never use the migration owner in API.
BEGIN;
CREATE ROLE gengyun_preview_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE gengyun_evidence_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
-- PostgreSQL 17 fresh databases deny PUBLIC CREATE already; enforce this boundary.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $$ BEGIN
  EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END $$;
REVOKE ALL ON SCHEMA catalog_read FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA catalog_read FROM PUBLIC;
GRANT USAGE ON SCHEMA catalog_read TO gengyun_preview_reader, gengyun_evidence_reader;
GRANT SELECT ON catalog_read.home_species TO gengyun_preview_reader;
GRANT SELECT ON catalog_read.registration_evidence TO gengyun_evidence_reader;
COMMIT;
