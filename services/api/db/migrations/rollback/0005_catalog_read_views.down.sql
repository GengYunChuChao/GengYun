-- Run as migration owner, only after rolling back consumers of these views.
BEGIN;
DROP VIEW catalog_read.registration_evidence;
DROP VIEW catalog_read.home_species;
DROP VIEW catalog_read.current_verified_sources;
DROP SCHEMA catalog_read;
DELETE FROM public.schema_migrations WHERE version = '0005';
COMMIT;
