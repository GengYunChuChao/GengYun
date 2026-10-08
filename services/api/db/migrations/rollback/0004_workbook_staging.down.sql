-- Before this destructive structural rollback, archive needed unreviewed intake locally.
-- This removes only 0004 objects; no CASCADE into existing knowledge/privacy tables.
BEGIN;
DROP TABLE knowledge_staging.workbook_rows;
DROP TABLE knowledge_staging.workbook_batches;
DROP SCHEMA knowledge_staging;
COMMIT;
