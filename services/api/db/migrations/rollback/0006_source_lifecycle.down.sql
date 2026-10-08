-- Retained audit is not silently erased by schema rollback.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM catalog_ops.operations) THEN
    RAISE EXCEPTION USING ERRCODE='G0004', MESSAGE='AUDIT_ARCHIVE_REQUIRED';
  END IF;
END $$;
DROP FUNCTION catalog_ops.apply_source_operation(uuid,text,uuid,uuid,integer,text,text,uuid);
DROP TABLE catalog_ops.operations;
DROP SCHEMA catalog_ops;
DELETE FROM public.schema_migrations WHERE version='0006';
COMMIT;
