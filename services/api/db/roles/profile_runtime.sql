-- Operator-only group bootstrap after 0001 and the existing auth/privacy roles.
-- Grant BOTH gengyun_auth_privacy and gengyun_profile_runtime to a separately
-- provisioned non-owner LOGIN. This script never creates a LOGIN or password.
-- Trusted API service group; not per-user RLS or permission to expose SQL to users.
BEGIN;
-- R28-S48：裸 CREATE ROLE 不可重跑（第二次 42710 会把整文件事务打回），改为「pg_roles 存在性守卫
-- + EXECUTE」；紧随的 ALTER ROLE … WITH <同属性> 再把「已存在但属性漂移」的角色收敛回出厂属性。
DO $role_guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gengyun_profile_runtime') THEN
    EXECUTE 'CREATE ROLE gengyun_profile_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
  END IF;
END;
$role_guard$;
ALTER ROLE gengyun_profile_runtime WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO gengyun_profile_runtime;
GRANT SELECT (id,name,active) ON public.crops TO gengyun_profile_runtime;
GRANT SELECT (code,name,parent_code,catalog_version,supported) ON public.regions TO gengyun_profile_runtime;
-- 物种目录（`GET /catalog/species`）只读四个契约字段；别名/组名不发给 API 角色，也不进响应。
GRANT SELECT (id,canonical_name,scientific_name,coverage_state) ON public.species TO gengyun_profile_runtime;
-- PostgreSQL FOR SHARE requires UPDATE on at least one column. Only name is
-- granted for locking: no directory key/version/availability changes or DELETE.
-- The HTTP component has no directory mutation endpoint.
GRANT UPDATE (name) ON public.crops,public.regions TO gengyun_profile_runtime;
-- 物种同理：`speciesDirectory()` 的 `SELECT … FOR SHARE` 需要表上至少一列 UPDATE 权限，
-- 故只授 `canonical_name` 作锁列（PG 17.11 文档口径：行锁取 UPDATE 级别的锁，不要求真正改行）。
-- 别名/组名/覆盖率位一律不可写；撤掉本行会让该读面在真库上直接 42501（不是降级成空列表）。
GRANT UPDATE (canonical_name) ON public.species TO gengyun_profile_runtime;
GRANT SELECT (user_id,crop_id,region_code,region_catalog_version,revision) ON public.single_profiles TO gengyun_profile_runtime;
GRANT INSERT (user_id,crop_id,region_code,region_catalog_version,revision) ON public.single_profiles TO gengyun_profile_runtime;
GRANT UPDATE (crop_id,region_code,region_catalog_version,revision,updated_at) ON public.single_profiles TO gengyun_profile_runtime;
-- Account/session row locks and hashed idempotency receipts come exclusively
-- from the unchanged gengyun_auth_privacy group; no grants on unrelated tables.
COMMIT;
