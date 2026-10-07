-- 0003 is reserved for the independently authored privacy migration (#45).
-- Private reference intake only: no promotion into sources/cards or user data.
BEGIN;
CREATE SCHEMA knowledge_staging;
REVOKE ALL ON SCHEMA knowledge_staging FROM PUBLIC;
CREATE TABLE knowledge_staging.workbook_batches (
  id uuid PRIMARY KEY,
  file_sha256 char(64) NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  filename text NOT NULL CHECK (length(filename) > 0),
  mapping_version text NOT NULL CHECK (length(mapping_version) > 0),
  imported_at timestamptz NOT NULL DEFAULT now(),
  quality jsonb NOT NULL CHECK (jsonb_typeof(quality) = 'object'),
  source_version_id uuid REFERENCES public.source_versions(id),
  UNIQUE (file_sha256, mapping_version)
);
CREATE TABLE knowledge_staging.workbook_rows (
  batch_id uuid NOT NULL REFERENCES knowledge_staging.workbook_batches(id) ON DELETE CASCADE,
  sheet_name text NOT NULL CHECK (length(sheet_name) > 0),
  excel_row integer NOT NULL CHECK (excel_row > 0),
  row_hash char(64) NOT NULL CHECK (row_hash ~ '^[0-9a-f]{64}$'),
  raw jsonb NOT NULL CHECK (jsonb_typeof(raw) = 'object'),
  mapped jsonb NOT NULL CHECK (jsonb_typeof(mapped) = 'object'),
  state text NOT NULL CHECK (state IN ('context','unreviewed','quarantined')),
  issues jsonb NOT NULL CHECK (jsonb_typeof(issues) = 'array'),
  PRIMARY KEY (batch_id,sheet_name,excel_row),
  CHECK (state <> 'quarantined' OR jsonb_array_length(issues) > 0),
  CHECK (state = 'context' OR
    (mapped->>'validity' = 'unknown' AND mapped->>'review_status' = 'unverified'
     AND mapped->'card_ready' = 'false'::jsonb) IS TRUE)
);
REVOKE ALL ON ALL TABLES IN SCHEMA knowledge_staging FROM PUBLIC;
-- No default privileges for the application role: explicit reviewer/import grants only.
COMMIT;
