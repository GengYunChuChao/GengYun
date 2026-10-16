-- ============================================================================
-- 0012_knowledge_created_at 回滚（运维脚本；不在迁移运行器的正向发现集内）
-- 仅撤销本迁移新增的对象：created_at 列、排序索引，并把 `catalog_read.current_knowledge`
-- 还原为 0010 的列集合（逐条照抄 0010 的 SELECT/FROM/WHERE，即去掉 created_at）。
-- 不触碰 0002/0010 的表、视图准入条件与任何业务行。
-- 回滚无法用 CREATE OR REPLACE（PostgreSQL 不允许从视图里删列），只能 DROP + CREATE；
-- 这会让视图 ACL 一并丢失，因此本脚本在末尾把 0010 之后由
-- `db/roles/knowledge_runtime.sql` 建立的运行期只读授权**补回**（角色不存在则跳过），
-- 保证回滚后运行期角色照旧只读这一个视图、不因回滚而读不到资料。
-- ============================================================================
BEGIN;

DROP VIEW IF EXISTS catalog_read.current_knowledge;
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

-- DROP + CREATE 丢掉的运行期只读授权在这里补回（幂等；角色不存在时静默跳过）。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gengyun_knowledge_runtime') THEN
    EXECUTE 'GRANT SELECT ON catalog_read.current_knowledge TO gengyun_knowledge_runtime';
  END IF;
END $$;

DROP INDEX IF EXISTS public.knowledge_versions_created_idx;

ALTER TABLE public.knowledge_versions DROP COLUMN IF EXISTS created_at;

COMMIT;
