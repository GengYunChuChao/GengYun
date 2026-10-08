-- Once, fresh dedicated local database, as migration administrator.
BEGIN;
CREATE ROLE gengyun_staging_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE gengyun_staging_importer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $$ BEGIN EXECUTE format('REVOKE CREATE,TEMPORARY ON DATABASE %I FROM PUBLIC',current_database()); END $$;
GRANT USAGE ON SCHEMA staging_intake,knowledge_staging TO gengyun_staging_executor;
GRANT SELECT,INSERT ON knowledge_staging.workbook_batches,knowledge_staging.workbook_rows TO gengyun_staging_executor;
GRANT DELETE ON knowledge_staging.workbook_batches TO gengyun_staging_executor;
-- SELECT FOR UPDATE needs UPDATE, but no operator membership or direct table grants.
GRANT UPDATE(id) ON knowledge_staging.workbook_batches TO gengyun_staging_executor;
GRANT UPDATE(excel_row) ON knowledge_staging.workbook_rows TO gengyun_staging_executor;
GRANT SELECT,INSERT ON staging_intake.batches,staging_intake.operations TO gengyun_staging_executor;
GRANT UPDATE(generation,import_id,state) ON staging_intake.batches TO gengyun_staging_executor;
GRANT EXECUTE ON FUNCTION staging_intake.digest(bytea,text),staging_intake.python_json(jsonb) TO gengyun_staging_executor;
GRANT CREATE ON SCHEMA staging_intake TO gengyun_staging_executor;
ALTER FUNCTION staging_intake.apply_import(uuid,jsonb,uuid) OWNER TO gengyun_staging_executor;
ALTER FUNCTION staging_intake.rollback_import(uuid,uuid,uuid,text) OWNER TO gengyun_staging_executor;
REVOKE CREATE ON SCHEMA staging_intake FROM gengyun_staging_executor;
GRANT USAGE ON SCHEMA staging_intake TO gengyun_staging_importer;
GRANT EXECUTE ON FUNCTION staging_intake.apply_import(uuid,jsonb,uuid),staging_intake.rollback_import(uuid,uuid,uuid,text) TO gengyun_staging_importer;
-- Importer: no raw reads, no DML, no executor membership, no extension helpers.
COMMIT;
