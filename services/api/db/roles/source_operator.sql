-- Once, as migration administrator in a fresh dedicated database.
-- The NOLOGIN function owner has only the columns used by the audited function.
BEGIN;
-- R28-S48：裸 CREATE ROLE 不可重跑（第二次 42710 会把整文件事务打回），改为「pg_roles 存在性守卫
-- + EXECUTE」；紧随的 ALTER ROLE … WITH <同属性> 再把「已存在但属性漂移」的角色收敛回出厂属性。
DO $role_guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gengyun_source_executor') THEN
    EXECUTE 'CREATE ROLE gengyun_source_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
  END IF;
END;
$role_guard$;
ALTER ROLE gengyun_source_executor WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
DO $role_guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gengyun_source_operator') THEN
    EXECUTE 'CREATE ROLE gengyun_source_operator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
  END IF;
END;
$role_guard$;
ALTER ROLE gengyun_source_operator WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $$ BEGIN EXECUTE format('REVOKE CREATE,TEMPORARY ON DATABASE %I FROM PUBLIC',current_database()); END $$;
GRANT USAGE ON SCHEMA public,catalog_ops TO gengyun_source_executor;
GRANT SELECT ON public.sources,public.source_versions,catalog_ops.operations TO gengyun_source_executor;
GRANT UPDATE(revision) ON public.sources TO gengyun_source_executor;
GRANT UPDATE(validity) ON public.source_versions TO gengyun_source_executor;
GRANT INSERT,SELECT ON public.catalog_source_update_events TO gengyun_source_executor;
GRANT UPDATE(reverted_at) ON public.catalog_source_update_events TO gengyun_source_executor;
GRANT INSERT ON catalog_ops.operations TO gengyun_source_executor;
GRANT CREATE ON SCHEMA catalog_ops TO gengyun_source_executor;
ALTER FUNCTION catalog_ops.apply_source_operation(uuid,text,uuid,uuid,integer,text,text,uuid) OWNER TO gengyun_source_executor;
REVOKE CREATE ON SCHEMA catalog_ops FROM gengyun_source_executor;
REVOKE ALL ON SCHEMA catalog_ops FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA catalog_ops FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog_ops.apply_source_operation(uuid,text,uuid,uuid,integer,text,text,uuid) FROM PUBLIC;
GRANT USAGE ON SCHEMA catalog_ops TO gengyun_source_operator;
GRANT EXECUTE ON FUNCTION catalog_ops.apply_source_operation(uuid,text,uuid,uuid,integer,text,text,uuid) TO gengyun_source_operator;
-- No membership in executor, no table rights, no arbitrary direct restoration.
COMMIT;
