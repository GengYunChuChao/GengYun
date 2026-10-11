-- Refs #7: no source approval, publishing, seed promotion or original dose cards.
-- Runner owns the transaction. Owner executes; runtime can only read the view.
CREATE VIEW catalog_read.current_knowledge WITH (security_barrier = true) AS
SELECT k.knowledge_id AS id,k.revision,k.type,k.title,k.body,
       k.crop_ids,k.species_ids,k.region_codes,
       s.id AS source_id,sv.version AS source_version,s.title AS source_title,
       s.canonical_url AS url,s.publisher,s.source_kind,s.evidence_kind,
       sv.retrieved_at AS updated_at,
       -- Internal pagination watermark evidence, never sent to clients.
       s.revision AS source_revision,sv.content_hash,sv.locator,
       sv.reviewed_at,sv.valid_from,sv.valid_to
FROM public.knowledge_versions k
JOIN catalog_read.current_verified_sources allowed ON allowed.id=k.source_version_id
JOIN public.source_versions sv ON sv.id=allowed.id
JOIN public.sources s ON s.id=sv.source_id AND s.current_version_id=sv.id
WHERE k.visibility='published'
  AND NOT EXISTS (SELECT 1 FROM public.knowledge_versions newer
    WHERE newer.knowledge_id=k.knowledge_id AND newer.revision>k.revision)
  AND length(btrim(k.title)) BETWEEN 1 AND 200
  AND length(btrim(k.body))>0 AND length(k.body)<=20000
  AND length(btrim(s.title)) BETWEEN 1 AND 200
  AND length(btrim(s.publisher)) BETWEEN 1 AND 200
  AND s.canonical_url ~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?([/?#][^[:space:]]*)?$'
  AND length(btrim(sv.version)) BETWEEN 1 AND 80
  AND isfinite(sv.retrieved_at)
  AND sv.valid_from<=clock_timestamp()
  AND (sv.valid_to IS NULL OR sv.valid_to>clock_timestamp())
  AND jsonb_typeof(k.crop_ids)='array'
  AND jsonb_typeof(k.species_ids)='array'
  AND jsonb_typeof(k.region_codes)='array';
REVOKE ALL ON catalog_read.current_knowledge FROM PUBLIC;
