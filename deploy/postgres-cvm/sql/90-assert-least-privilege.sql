-- ============================================================================
-- 耕云 · CVM PostgreSQL 17：最小权限断言（只读检查，不修改任何对象）
--
-- 状态：技术准备物，未部署、未验收、未在任何真实 PG 实例上执行过。
--
-- 执行者：迁移管理员 gengyun_cvm_owner（需要读 pg_authid，只有超级用户可读）。
-- 前置  ：20-login-roles.sql 已执行；全部迁移已应用（本文件会读取表与视图）。
--
-- 输出约定：只打印一行。
--   ok                  —— 全部断言通过
--   FAIL: <标签> (<说明>); ... —— 未通过项明细（顺序即修复顺序）
-- 任何断言为 NULL 也按未通过处理（NULL 视为“无法证明”）。
-- 调用方 provision-db.sh 会把非 ok 视为失败并退出非零。
--
-- 本文件是「只报不改」：发现越权只报告，不自动 REVOKE，
-- 避免脚本静默改变既有角色语义（services/api/db/roles/*.sql 是唯一权威）。
-- ============================================================================

\set ON_ERROR_STOP on
\pset pager off
\pset tuples_only on
\pset format unaligned

WITH checks(label, ok, detail) AS (

  -- 1. 运行时 LOGIN 的属性：可登录、可继承、且无任何特权位
  SELECT 'runtime_login_props',
         EXISTS (
           SELECT 1 FROM pg_roles
            WHERE rolname = 'gengyun_api_runtime'
              AND rolcanlogin AND rolinherit
              AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
         ),
         '要求 LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'

  UNION ALL
  -- 2. 口令必须是 SCRAM（PG17 不应出现 md5/空口令）
  SELECT 'runtime_password_scram',
         EXISTS (
           SELECT 1 FROM pg_authid
            WHERE rolname = 'gengyun_api_runtime'
              AND rolpassword IS NOT NULL
              AND rolpassword LIKE 'SCRAM-SHA-256$%'
         ),
         'pg_authid.rolpassword 必须为 SCRAM-SHA-256 校验值'

  UNION ALL
  -- 3. 必须继承全部 5 个既有 NOLOGIN 组
  SELECT 'required_memberships',
         pg_has_role('gengyun_api_runtime', 'gengyun_auth_privacy', 'MEMBER')
         AND pg_has_role('gengyun_api_runtime', 'gengyun_preview_reader', 'MEMBER')
         AND pg_has_role('gengyun_api_runtime', 'gengyun_consent_granter', 'MEMBER')
         AND pg_has_role('gengyun_api_runtime', 'gengyun_profile_runtime', 'MEMBER')
         AND pg_has_role('gengyun_api_runtime', 'gengyun_knowledge_runtime', 'MEMBER'),
         '缺任一组成员资格，API 的正常读取/写入会缺权限'

  UNION ALL
  -- 4. 成员链上不得出现特权角色或其它可登录身份（对齐 tools/local-dev/profile-bootstrap.mjs）
  SELECT 'chain_least_privilege',
         NOT EXISTS (
           SELECT 1 FROM pg_roles
            WHERE pg_has_role('gengyun_api_runtime', oid, 'MEMBER')
              AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
                   OR (rolname <> 'gengyun_api_runtime' AND rolcanlogin))
         ),
         '成员链只能由 NOLOGIN 组与运行时自身构成'

  UNION ALL
  -- 5. 不得是迁移管理员成员（否则等于拿到超级用户）
  SELECT 'not_owner_member',
         NOT pg_has_role('gengyun_api_runtime', 'gengyun_cvm_owner', 'MEMBER'),
         '运行时绝不能继承或 SET ROLE 到 gengyun_cvm_owner'

  UNION ALL
  -- 6. 不得持有全库读写预定义角色
  SELECT 'no_predefined_read_all',
         NOT pg_has_role('gengyun_api_runtime', 'pg_read_all_data', 'MEMBER')
         AND NOT pg_has_role('gengyun_api_runtime', 'pg_write_all_data', 'MEMBER'),
         '预定义全库角色会绕过按列授权，本阶段不允许'

  UNION ALL
  -- 7. 表级 DML 只允许既有角色文件里明示的那一处（idempotency_keys）
  SELECT 'table_dml_allowlist',
         NOT EXISTS (
           SELECT 1
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r','p','f')
              AND n.nspname NOT IN ('pg_catalog','information_schema')
              AND n.nspname NOT LIKE 'pg_%'
              AND has_table_privilege('gengyun_api_runtime', c.oid,
                    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
              AND NOT (n.nspname = 'public' AND c.relname = 'idempotency_keys')
         ),
         '除 public.idempotency_keys 外不得有表级写入类权限'

  UNION ALL
  -- 8. 允许的表级写权限也必须是角色文件里明示的两种
  SELECT 'idempotency_keys_scope',
         has_table_privilege('gengyun_api_runtime', 'public.idempotency_keys', 'INSERT')
         AND has_table_privilege('gengyun_api_runtime', 'public.idempotency_keys', 'DELETE')
         AND NOT has_table_privilege('gengyun_api_runtime', 'public.idempotency_keys', 'UPDATE')
         AND NOT has_table_privilege('gengyun_api_runtime', 'public.idempotency_keys', 'TRUNCATE'),
         'idempotency_keys 只应有 SELECT/INSERT/DELETE 与列级 UPDATE(outcome,response_status)'

  UNION ALL
  -- 9. 账号状态/世代/修订/凭据等权威字段必须仍是运营方专属
  SELECT 'protected_columns',
         NOT has_column_privilege('gengyun_api_runtime', 'public.users', 'state', 'UPDATE')
         AND NOT has_column_privilege('gengyun_api_runtime', 'public.users', 'auth_epoch', 'UPDATE')
         AND NOT has_column_privilege('gengyun_api_runtime', 'public.users', 'revision', 'UPDATE')
         AND NOT has_column_privilege('gengyun_api_runtime', 'public.users', 'wechat_subject_cipher', 'SELECT')
         AND NOT has_column_privilege('gengyun_api_runtime', 'public.sessions', 'auth_epoch', 'UPDATE')
         AND NOT has_column_privilege('gengyun_api_runtime', 'public.admin_accounts', 'credential_hash', 'UPDATE')
         AND NOT has_column_privilege('gengyun_api_runtime', 'public.admin_scopes', 'scope', 'UPDATE'),
         '注销/撤销/权限字段只能由运营方操作'

  UNION ALL
  -- 10. 不得在任何非系统 schema 上建对象
  SELECT 'no_schema_create',
         NOT EXISTS (
           SELECT 1 FROM pg_namespace
            WHERE nspname NOT IN ('pg_catalog','information_schema')
              AND nspname NOT LIKE 'pg_%'
              AND has_schema_privilege('gengyun_api_runtime', oid, 'CREATE')
         ),
         '运行时不得建表/建 schema'

  UNION ALL
  -- 11. PUBLIC 不得在 public schema 建对象（角色文件已 REVOKE，此处验证确已生效）
  SELECT 'public_no_schema_create',
         EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'public' AND nspacl IS NOT NULL)
         AND NOT EXISTS (
           SELECT 1 FROM pg_namespace n, aclexplode(n.nspacl) a
            WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'CREATE'
         ),
         'public schema 上 PUBLIC 不应有 CREATE'

  UNION ALL
  -- 12. PUBLIC 不得在业务库上有 CREATE/TEMPORARY（角色文件已 REVOKE，验证确已生效）
  SELECT 'public_no_database_create',
         EXISTS (SELECT 1 FROM pg_database WHERE datname = current_database() AND datacl IS NOT NULL)
         AND NOT EXISTS (
           SELECT 1 FROM pg_database d, aclexplode(d.datacl) a
            WHERE d.datname = current_database() AND a.grantee = 0
              AND a.privilege_type IN ('CREATE','TEMPORARY')
         ),
         '业务库上 PUBLIC 不应有 CREATE/TEMPORARY'

  UNION ALL
  -- 13. 公共科普读者只读科普投影，不碰私有原表
  SELECT 'preview_reader_scope',
         has_table_privilege('gengyun_preview_reader', 'catalog_read.home_species', 'SELECT')
         AND NOT has_table_privilege('gengyun_preview_reader', 'public.users', 'SELECT')
         AND NOT has_any_column_privilege('gengyun_preview_reader', 'public.users', 'SELECT'),
         'gengyun_preview_reader 只能读 catalog_read.home_species'

  UNION ALL
  -- 14. 知识运行时只读 0010 的 security_barrier 投影，此外无任何表/列/schema 权限
  SELECT 'knowledge_runtime_scope',
         has_table_privilege('gengyun_knowledge_runtime', 'catalog_read.current_knowledge', 'SELECT')
         AND NOT EXISTS (
           SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r','p','v','m','f')
              AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
              AND ((c.oid <> 'catalog_read.current_knowledge'::regclass
                    AND has_any_column_privilege('gengyun_knowledge_runtime', c.oid,
                          'SELECT,INSERT,UPDATE,REFERENCES'))
                   OR has_table_privilege('gengyun_knowledge_runtime', c.oid,
                          'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
         )
         AND NOT EXISTS (
           SELECT 1 FROM pg_namespace
            WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'
              AND has_schema_privilege('gengyun_knowledge_runtime', oid, 'CREATE')
         ),
         'gengyun_knowledge_runtime 只应能读 catalog_read.current_knowledge'

  UNION ALL
  -- 15. 运行时可连接业务库（否则 API 起不来，属配置缺失而非安全越权）
  SELECT 'runtime_can_connect',
         has_database_privilege('gengyun_api_runtime', current_database(), 'CONNECT'),
         '运行时应能连接业务库'
)

SELECT CASE
         WHEN count(*) FILTER (WHERE ok IS NOT TRUE) = 0 THEN 'ok'
         ELSE 'FAIL: ' || string_agg(label || ' (' || detail || ')', '; ' ORDER BY label)
                             FILTER (WHERE ok IS NOT TRUE)
       END AS verdict
  FROM checks;
