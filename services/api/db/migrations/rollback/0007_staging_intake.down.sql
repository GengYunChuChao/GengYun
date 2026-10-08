BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM staging_intake.operations) OR EXISTS(SELECT 1 FROM staging_intake.batches)
  THEN RAISE EXCEPTION USING ERRCODE='G0004',MESSAGE='AUDIT_ARCHIVE_REQUIRED'; END IF;
END $$;
DROP FUNCTION staging_intake.rollback_import(uuid,uuid,uuid,text);
DROP FUNCTION staging_intake.apply_import(uuid,jsonb,uuid);
DROP FUNCTION staging_intake.python_json(jsonb);
DROP TABLE staging_intake.operations;
DROP TABLE staging_intake.batches;
-- Created by 0007 in this schema; no IF EXISTS/adoption, no CASCADE.
DROP EXTENSION pgcrypto;
DROP SCHEMA staging_intake;
DELETE FROM public.schema_migrations WHERE version='0007';
COMMIT;
