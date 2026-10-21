-- Operator-only bootstrap after 0010; never an API owner or per-user SQL role.
-- Compose with unchanged gengyun_auth_privacy on a separately provisioned
-- restricted LOGIN. No private base table or publication privilege is granted.
BEGIN;
-- R28-S48：裸 CREATE ROLE 不可重跑（第二次 42710 会把整文件事务打回），改为「pg_roles 存在性守卫
-- + EXECUTE」；紧随的 ALTER ROLE … WITH <同属性> 再把「已存在但属性漂移」的角色收敛回出厂属性。
DO $role_guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gengyun_knowledge_runtime') THEN
    EXECUTE 'CREATE ROLE gengyun_knowledge_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
  END IF;
END;
$role_guard$;
ALTER ROLE gengyun_knowledge_runtime WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA catalog_read TO gengyun_knowledge_runtime;
GRANT SELECT ON catalog_read.current_knowledge TO gengyun_knowledge_runtime;
COMMIT;
