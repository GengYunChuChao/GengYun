-- Refs #3/#27. No data promotion, role creation, private access or dose approval.
-- Runner owns this migration's transaction. Depends only on 0001/0002.
CREATE SCHEMA catalog_read;
REVOKE ALL ON SCHEMA catalog_read FROM PUBLIC;

CREATE VIEW catalog_read.current_verified_sources WITH (security_barrier = true) AS
SELECT sv.id, sv.source_id, sv.version, sv.content_hash, sv.locator,
       sv.valid_from, sv.valid_to, s.source_kind, s.canonical_url
FROM public.source_versions sv
JOIN public.sources s ON s.id = sv.source_id AND s.current_version_id = sv.id
JOIN public.knowledge_dataset_modes mode ON mode.mode = 'real'
JOIN public.knowledge_dataset_config active ON active.key = 'active_mode'
  AND active.value = 'real' AND active.mode = 'real'
JOIN public.knowledge_dataset_config connected ON connected.key = 'database_connected'
  AND connected.value = 'true' AND connected.mode = 'real'
WHERE sv.validity = 'valid' AND sv.review_status = 'verified'
  AND sv.reviewed_by IS NOT NULL AND sv.reviewed_at IS NOT NULL
  AND sv.valid_from <= CURRENT_TIMESTAMP
  AND (sv.valid_to IS NULL OR sv.valid_to > CURRENT_TIMESTAMP)
  AND ((s.source_kind = 'database' AND mode.accepts_database)
    OR (s.source_kind = 'verified_seed' AND mode.accepts_verified_seed));

CREATE VIEW catalog_read.home_species WITH (security_barrier = true) AS
SELECT k.knowledge_id AS id, k.title, left(k.body, 500) AS summary,
       'knowledge'::text AS content_type, s.source_kind
FROM public.knowledge_versions k
JOIN catalog_read.current_verified_sources s ON s.id = k.source_version_id
WHERE k.type = 'species' AND k.visibility = 'published'
  AND length(btrim(k.title)) > 0 AND length(btrim(k.body)) > 0
  AND NOT EXISTS (
    SELECT 1 FROM public.knowledge_versions newer
    WHERE newer.knowledge_id = k.knowledge_id AND newer.revision > k.revision
  );

-- Internal registration evidence projection; explicitly not a DoseCard.
-- A second identity or unresolved import conflict blocks the registration number.
CREATE VIEW catalog_read.registration_evidence WITH (security_barrier = true) AS
SELECT r.id AS registration_id, f.id AS formulation_id, f.registration_number,
       f.producer, f.dosage_form, f.ingredients, f.identity_hash,
       r.registered_name, r.registration_valid_from, r.registration_valid_to,
       s.source_id, s.id AS source_version_id, s.version AS source_version,
       s.content_hash, s.locator, s.source_kind, s.canonical_url
FROM public.registrations r
JOIN public.formulations f ON f.id = r.formulation_id
JOIN catalog_read.current_verified_sources s ON s.id = r.source_version_id
WHERE r.status = 'valid'
  AND r.registration_valid_from IS NOT NULL AND r.registration_valid_to IS NOT NULL
  AND r.registration_valid_from <= CURRENT_DATE
  AND r.registration_valid_to >= CURRENT_DATE
  AND NOT EXISTS (
    SELECT 1 FROM public.formulations other
    WHERE other.registration_number = f.registration_number AND other.identity_hash <> f.identity_hash
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.catalog_import_conflicts c
    WHERE c.entity = 'formulations' AND c.business_key = f.registration_number
      AND c.resolution IN ('rejected', 'deferred')
  );
REVOKE ALL ON ALL TABLES IN SCHEMA catalog_read FROM PUBLIC;
