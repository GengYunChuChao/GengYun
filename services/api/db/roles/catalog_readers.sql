-- Operator-only bootstrap for a fresh dedicated database, NOT a migration.
-- NOLOGIN groups: provision environment-specific LOGIN identities separately,
-- with credentials in private configuration. Never use the migration owner in API.
BEGIN;
-- R28-S48：裸 CREATE ROLE 不可重跑（第二次 42710 会把整文件事务打回），改为「pg_roles 存在性守卫
-- + EXECUTE」；紧随的 ALTER ROLE … WITH <同属性> 再把「已存在但属性漂移」的角色收敛回出厂属性。
DO $role_guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gengyun_preview_reader') THEN
    EXECUTE 'CREATE ROLE gengyun_preview_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
  END IF;
END;
$role_guard$;
ALTER ROLE gengyun_preview_reader WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
DO $role_guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gengyun_evidence_reader') THEN
    EXECUTE 'CREATE ROLE gengyun_evidence_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
  END IF;
END;
$role_guard$;
ALTER ROLE gengyun_evidence_reader WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
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
