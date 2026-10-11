-- Operator-only group bootstrap after 0001 and the existing auth/privacy roles.
-- Grant BOTH gengyun_auth_privacy and gengyun_profile_runtime to a separately
-- provisioned non-owner LOGIN. This script never creates a LOGIN or password.
-- Trusted API service group; not per-user RLS or permission to expose SQL to users.
BEGIN;
CREATE ROLE gengyun_profile_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO gengyun_profile_runtime;
GRANT SELECT (id,name,active) ON public.crops TO gengyun_profile_runtime;
GRANT SELECT (code,name,parent_code,catalog_version,supported) ON public.regions TO gengyun_profile_runtime;
-- PostgreSQL FOR SHARE requires UPDATE on at least one column. Only name is
-- granted for locking: no directory key/version/availability changes or DELETE.
-- The HTTP component has no directory mutation endpoint.
GRANT UPDATE (name) ON public.crops,public.regions TO gengyun_profile_runtime;
GRANT SELECT (user_id,crop_id,region_code,region_catalog_version,revision) ON public.single_profiles TO gengyun_profile_runtime;
GRANT INSERT (user_id,crop_id,region_code,region_catalog_version,revision) ON public.single_profiles TO gengyun_profile_runtime;
GRANT UPDATE (crop_id,region_code,region_catalog_version,revision,updated_at) ON public.single_profiles TO gengyun_profile_runtime;
-- Account/session row locks and hashed idempotency receipts come exclusively
-- from the unchanged gengyun_auth_privacy group; no grants on unrelated tables.
COMMIT;
