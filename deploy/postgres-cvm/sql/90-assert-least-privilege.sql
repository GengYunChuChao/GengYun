-- ============================================================================
-- 耕云 · CVM PostgreSQL 17：最小权限断言（只读检查，不修改任何对象）
--
-- 状态：技术准备物，未部署、未验收。本文件的 SQL **已由监工在真实 PostgreSQL 17.11 上真跑**：
--   在**未 provisioning 的全新库**上，旧版会跑到一半才因
--   `ERROR: role "gengyun_api_runtime" does not exist` 中止（信息量很低）。
--   返修后本文件在**最前面**加了一道「前置自检」，缺前置时**立即**给出可操作提示。
--
-- 顺序性前提（写清楚）：本文件是 **provisioning 之后的事后断言**，不是建角色/建表的脚本：
--   1) install-postgres.sh 已建好集群与业务库 gengyun；
--   2) `migrate.ts up` 已应用**全部**迁移（本文件读 public.* 与 catalog_read.*）；
--   3) 5 个既有 NOLOGIN 组已由 services/api/db/roles/*.sql 建出；
--   4) sql/20-login-roles.sql 已创建 gengyun_api_runtime 并授予那 5 个组。
--   ⇒ 正确顺序：install-postgres.sh ⇒ migrate.ts up ⇒ provision-db.sh（内部依次执行 20- 与 90-）。
--   前置不满足时**不是“跳过”，而是“失败”**（断言无法求值），但会打印明确的补救指引。
--
-- 执行者：迁移管理员 gengyun_cvm_owner（需要读 pg_authid，只有超级用户可读）。
--         ⚠️ 2026-10-13 更正（按监工批复）：**这才是**本交付需要超级用户的**真实**理由；
--         与 `pgcrypto` **无关** —— `pgcrypto` 是 trusted extension（PG 13+ 起），
--         只要对当前数据库有 `CREATE` 权限即可安装（PG 17 官方文档 F.26），**不需要**超级用户。
--         若不希望依赖"超级用户读 pg_authid"，可改用端到端证明：
--         `verify-cvm-postgres.sh --runtime-password-env …` 的 `runtime_tcp_login`（真实 TCP + scram 登录）。
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

-- --- 前置自检（分两级；全部用 to_regclass / pg_roles，对“对象不存在”天然安全）--
-- (硬) 本文件 15 项断言**真正依赖**的对象：7 个业务关系 + 运行时角色 + 5 个既有 NOLOGIN 组。
--      缺任一项 ⇒ 断言无法求值 ⇒ 立即失败并打印补救指引。
-- (软) public.schema_migrations 台账：**不是** 15 项断言的对象，它只是“迁移由 migrate.ts 应用”
--      的凭据。台账缺失时**只告警、不失败**，以便在“用 psql -f 应用了迁移、但没有 migrate.ts”
--      的等价复跑环境（例如只有 Unix 套接字、node-postgres 不可用的本机复现）里仍能验证这 15 项。
--      ⚠️ 在目标 CVM 上台账缺失属异常：provision-db.sh 的迁移门禁会拦下，verify 的
--         migrations_applied 也会判 FAIL —— 那里才是台账的权威判定点。
-- 说明：本文件 15 项断言**没有任何一项读取 schema_migrations**；把它列为硬前置属于过度约束，
--       会妨碍“CVM 之外等价环境”的复核。此处按依赖关系收窄，不改变任何断言语义。
SELECT (
         to_regclass('public.users')                        IS NOT NULL
     AND to_regclass('public.sessions')                     IS NOT NULL
     AND to_regclass('public.admin_accounts')               IS NOT NULL
     AND to_regclass('public.admin_scopes')                 IS NOT NULL
     AND to_regclass('public.idempotency_keys')             IS NOT NULL
     AND to_regclass('catalog_read.home_species')           IS NOT NULL
     AND to_regclass('catalog_read.current_knowledge')      IS NOT NULL
     AND (SELECT count(*) FROM pg_roles
           WHERE rolname = 'gengyun_api_runtime') = 1
     AND (SELECT count(*) FROM pg_roles
           WHERE rolname IN ('gengyun_auth_privacy','gengyun_preview_reader',
                             'gengyun_consent_granter','gengyun_profile_runtime',
                             'gengyun_knowledge_runtime')) = 5
       ) AS prereq_ok \gset
\if :prereq_ok
\else
  \echo '错误：90-assert-least-privilege.sql 的硬前置未满足——本文件是 provisioning 之后的事后断言。'
  \echo '      需要：7 个业务关系（users / sessions / admin_accounts / admin_scopes /'
  \echo '            idempotency_keys / catalog_read.home_species / catalog_read.current_knowledge）'
  \echo '            + 角色 gengyun_api_runtime + 5 个既有 NOLOGIN 组。'
  \echo '      请按顺序确认：'
  \echo '        1) sudo deploy/postgres-cvm/install-postgres.sh'
  \echo '        2) DATABASE_URL=… node services/api/src/db/migrate.ts up     # 全部迁移'
  \echo '        3) sudo deploy/postgres-cvm/provision-db.sh                  # 建组 ⇒ 20- ⇒ 本文件(90-)'
  \echo '      本文件不会自己建角色或建表。'
  SELECT 1/0;
\endif

-- 软前置：台账缺失只告警（见上）。该告警在 \if 之外、且在最终 SELECT 之前，
-- 因此调用方按“最后一行”取判定结果时不受影响。
SELECT (to_regclass('public.schema_migrations') IS NOT NULL) AS ledger_ok \gset
\if :ledger_ok
\else
  \echo '警告：未找到 public.schema_migrations 台账。'
  \echo '      本文件 15 项断言不依赖它，故继续执行；但“迁移由 migrate.ts 应用”在本库无法证明。'
  \echo '      若这是目标 CVM，属异常：请用 DATABASE_URL=… node services/api/src/db/migrate.ts up 后重跑。'
  \echo '      （等价复跑环境：用 psql -f 应用迁移时不会有该台账，此告警属预期。）'
\endif

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
         AND NOT has_column_privilege('gengyun_api_runtime', 'public.admin_scopes', 'scope', 'UPDATE')
         -- GY-I19 追加（只**增强**本断言：不删除、不弱化上面任何既有条件）。
         -- 注销请求表的写侧列权限同样不得直授运行时角色：它只能经
         -- public.request_account_deletion(...) 在同一事务内写入（见下方 deletion_function_* 断言）。
         AND NOT has_any_column_privilege('gengyun_api_runtime', 'public.deletion_requests', 'INSERT,UPDATE,REFERENCES'),
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

  -- ---------------------------------------------------------------------------
  -- GY-I19（#19）追加：注销受理**唯一写路径**的函数级契约断言（裁定 §3.3 允许的唯一一类新增）。
  -- 背景：运行时角色对 public.users 的 state/auth_epoch/revision 与 public.deletion_requests
  -- **没有**任何直接列权限（见上面 protected_columns），注销只能经窄口径 SECURITY DEFINER 函数完成；
  -- 因此必须把「函数确实存在、确实是 SECURITY DEFINER、search_path 确实固定、属主确实是能写这些
  -- 列的运营方角色且运行时无法 SET ROLE 成为它、EXECUTE 确实只授予运行时角色」全部钉死。
  -- ⛔ 这五条**不**放松任何既有断言，也**不**给运行时角色补任何列权限。
  -- ---------------------------------------------------------------------------
  UNION ALL
  -- 16. 唯一写路径必须恰存在一个（名字 + 精确签名）
  SELECT 'deletion_function_exists',
         to_regprocedure(
           'public.request_account_deletion(uuid,uuid,text,integer,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz)'
         ) IS NOT NULL
         AND (SELECT count(*) FROM pg_proc
               WHERE proname = 'request_account_deletion'
                 AND pronamespace = 'public'::regnamespace) = 1,
         '注销受理唯一写路径必须恰为 public.request_account_deletion(uuid,uuid,text,integer,timestamptz×5)'

  UNION ALL
  -- 17. 必须真的是 SECURITY DEFINER（整个方案的前提；否则函数以调用者身份执行，写入必然被拒）
  SELECT 'deletion_function_security_definer',
         (SELECT p.prosecdef
            FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname = 'request_account_deletion'),
         '注销受理函数必须声明 SECURITY DEFINER'

  UNION ALL
  -- 18. search_path 必须固定为 pg_catalog（不做 search_path 劫持的入口），且时区固定为 UTC
  SELECT 'deletion_function_search_path',
         (SELECT p.proconfig @> ARRAY['search_path=pg_catalog', 'TimeZone=UTC']
            FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname = 'request_account_deletion'),
         '注销受理函数必须设 SET search_path = pg_catalog 与 SET TimeZone = UTC'

  UNION ALL
  -- 19. 属主正确：必须是能改 users.state/auth_epoch/revision 且能写 deletion_requests 的角色，
  --     且运行时角色既不是它、也不能 SET ROLE 成为它（否则可绕过列授权）
  SELECT 'deletion_function_owner',
         (SELECT pg_get_userbyid(p.proowner) <> 'gengyun_api_runtime'
                 AND NOT pg_has_role('gengyun_api_runtime', p.proowner, 'MEMBER')
                 AND has_column_privilege(pg_get_userbyid(p.proowner), 'public.users', 'state', 'UPDATE')
                 AND has_column_privilege(pg_get_userbyid(p.proowner), 'public.users', 'auth_epoch', 'UPDATE')
                 AND has_column_privilege(pg_get_userbyid(p.proowner), 'public.users', 'revision', 'UPDATE')
                 AND has_table_privilege(pg_get_userbyid(p.proowner), 'public.deletion_requests', 'INSERT')
            FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname = 'request_account_deletion'),
         '函数属主必须是能改 users.state/auth_epoch/revision 并写 deletion_requests 的运营方角色，且运行时角色无法成为它'

  UNION ALL
  -- 20. EXECUTE 只授予运行时角色：PUBLIC（grantee=0）与任何其它角色一律不得执行
  SELECT 'deletion_function_execute',
         has_function_privilege(
           'gengyun_api_runtime',
           'public.request_account_deletion(uuid,uuid,text,integer,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz)',
           'EXECUTE'
         )
         AND NOT EXISTS (
           SELECT 1
             FROM pg_proc p, aclexplode(p.proacl) a
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname = 'request_account_deletion'
              AND a.privilege_type = 'EXECUTE'
              AND a.grantee NOT IN (0, 'gengyun_api_runtime'::regrole, p.proowner)
         )
         AND NOT EXISTS (
           SELECT 1
             FROM pg_proc p, aclexplode(p.proacl) a
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname = 'request_account_deletion'
              AND a.privilege_type = 'EXECUTE'
              AND a.grantee = 0
         ),
         '注销受理函数的 EXECUTE 只应授予 gengyun_api_runtime（PUBLIC 与其它角色一律不得执行）'

         '运行时应能连接业务库'
)

SELECT CASE
         WHEN count(*) FILTER (WHERE ok IS NOT TRUE) = 0 THEN 'ok'
         ELSE 'FAIL: ' || string_agg(label || ' (' || detail || ')', '; ' ORDER BY label)
                             FILTER (WHERE ok IS NOT TRUE)
       END AS verdict
  FROM checks;
