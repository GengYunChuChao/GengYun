-- ============================================================================
-- 耕云 · CVM PostgreSQL 17：业务库 LOGIN 身份引导（迁移之后执行）
--
-- 状态：技术准备物，未部署、未验收。本文件的 SQL **已由监工在真实 PostgreSQL 17.11 上真跑**，
--   并据此返修：旧版在**全新库上必然失败**（详见下方「返修记录」）。
--   返修后的「全新库首跑成功」与「重复执行幂等」两条回归由监工回传原始输出后写入
--   evidence/local-self-check.md §4；**在其回传前，这两条仍属待验证（不得记通过）**。
--
-- 返修记录（2026-10-13 · 依据监工真实 PG 17.11 首跑原始输出）：
--   旧版 L74 先执行 `pg_has_role('gengyun_api_runtime','gengyun_cvm_owner','MEMBER')` 断言，
--   而建角色在 L85 ⇒ 全新库上 `pg_has_role(name, …)` 直接
--   `ERROR: role "gengyun_api_runtime" does not exist`（exit=3）。若本机历史遗留过该角色，
--   这个缺陷会被掩盖。
--   本版：① 把该断言改为「角色不存在也安全」的写法（子查询 0 行 ⇒ NULL ⇒ COALESCE 成 true）；
--         ② 新增 5 个 NOLOGIN 组的**存在性前置**，避免 GRANT 阶段报含糊的 role does not exist；
--         ③ 两处前置都**早于任何写操作**；
--         ④ 口令默认不再每次重写 ⇒ 重复执行严格幂等（判读见下）。
--
-- 执行者：迁移管理员 gengyun_cvm_owner（initdb -U 建出的超级用户），
--         经 Unix socket + pg_ident 免口令连接；由 provision-db.sh 调用。
-- 前置  ：1) 集群已由 install-postgres.sh 建好；2) 业务库 gengyun 已创建；
--         3) services/api/src/db/migrate.ts up 已在本库应用全部迁移（本文件只授权，不建表）；
--         4) 5 个既有 NOLOGIN 组已由 services/api/db/roles/*.sql 建出
--            （provision-db.sh 在本文件之前完成；本文件只校验存在，不代建）。
--
-- 本文件做三件事：
--   A. 创建（仅缺失时）应用运行时 LOGIN gengyun_api_runtime
--   B. 收敛其属性（幂等；**不含 PASSWORD**）
--   C. 授予既有 NOLOGIN 组（GRANT 幂等）
--
-- 口令语义（重要，供回归判读）：
--   * 来自环境变量 GENGYUN_API_RUNTIME_PASSWORD（\getenv），要求 48 位小写十六进制；
--     未设置或格式不符 ⇒ **明确失败，绝不创建无口令 LOGIN**。
--   * **仅首次创建**写入口令；**重复执行默认不改口令** ⇒ `pg_authid.rolpassword` 保持不变，
--     因此「幂等」可以严格判定。
--   * 轮换需显式设置 `GENGYUN_ROTATE_RUNTIME_PASSWORD=1` 重跑（或 provision-db.sh
--     加 `--rotate-runtime-password`）。注意：即使明文相同，PostgreSQL 每次
--     `ALTER ROLE … PASSWORD` 都会用**新的随机 salt** 重算 SCRAM 校验值 ⇒
--     「轮换后 `rolpassword` 字符串必然变化」是固有行为，不是缺陷。
--   * 口令不进仓库、不进 argv、不打印；私密文件注入方式见 runbook.md §2。
--
-- 刻意不做：
--   * 不创建 gengyun_cvm_owner（由 initdb 创建为集群超级用户）
--   * 不创建 5 个 NOLOGIN 组（只校验；建组是 services/api/db/roles/*.sql 的职责）
--   * 不授予 gengyun_evidence_reader / gengyun_source_operator / gengyun_staging_importer
--     （理由与开通方式见 roles-and-migration.md §3.4）
--   * 不 REVOKE 任何既有授权：有越权时由 90-assert-least-privilege.sql 报错，由人决定
--
-- 用法（通常不必手工执行）：
--   sudo -u postgres /usr/lib/postgresql/17/bin/psql -h /var/run/postgresql \
--     -U gengyun_cvm_owner -d gengyun -v ON_ERROR_STOP=1 \
--     -f deploy/postgres-cvm/sql/20-login-roles.sql
-- ============================================================================

\set ON_ERROR_STOP on
\pset pager off

-- --- 0. 前置判定（全部早于任何写操作；不满足即中止）-------------------------
\getenv api_password GENGYUN_API_RUNTIME_PASSWORD

\if :{?api_password}
\else
  \echo '错误：环境变量 GENGYUN_API_RUNTIME_PASSWORD 未设置；拒绝创建无口令 LOGIN。'
  SELECT 1/0;
\endif

SELECT (:'api_password' ~ '^[a-f0-9]{48}$') AS pw_shape_ok \gset
\if :pw_shape_ok
\else
  \echo '错误：GENGYUN_API_RUNTIME_PASSWORD 格式不符，要求 48 位小写十六进制（openssl rand -hex 24）。'
  SELECT 1/0;
\endif

-- 当前库必须是我们管理的业务库，避免在测试库/别人的库上误建身份。
SELECT (current_database() = 'gengyun') AS db_ok \gset
\if :db_ok
\else
  \echo '错误：当前数据库不是 gengyun；请用 install-postgres.sh 建出的业务库。'
  SELECT 1/0;
\endif

-- 迁移管理员必须存在且是超级用户（0007 的 CREATE EXTENSION pgcrypto 需要超级用户）。
-- 只查 pg_roles，对"角色不存在"天然安全。
SELECT (count(*) = 1) AS owner_ok
  FROM pg_roles
 WHERE rolname = 'gengyun_cvm_owner' AND rolsuper
\gset
\if :owner_ok
\else
  \echo '错误：未找到超级用户 gengyun_cvm_owner；数据库可能不是本交付的集群。'
  SELECT 1/0;
\endif

-- 【返修新增】5 个既有 NOLOGIN 组必须已存在，否则 GRANT 会以含糊的
-- `role "…" does not exist` 失败。只查 pg_roles，对"角色不存在"天然安全。
SELECT (count(*) = 5) AS groups_ok
  FROM pg_roles
 WHERE rolname IN ('gengyun_auth_privacy',
                   'gengyun_preview_reader',
                   'gengyun_consent_granter',
                   'gengyun_profile_runtime',
                   'gengyun_knowledge_runtime')
\gset
\if :groups_ok
\else
  \echo '错误：5 个既有 NOLOGIN 组未全部存在。请先让 provision-db.sh 执行'
  \echo '      services/api/db/roles/*.sql 建组（auth_privacy / catalog_readers /'
  \echo '      consent_granter / profile_runtime / knowledge_runtime）；本文件不代建。'
  SELECT 1/0;
\endif

-- 【返修修正】运行时身份不得与迁移管理员同体。
-- 关键：角色**不存在**时子查询返回 0 行 ⇒ 标量子查询为 NULL ⇒ COALESCE 成 true（视为安全）；
-- `pg_has_role` 只在子查询真正产生行时才被求值 ⇒ 全新库上不再报 role does not exist。
-- 该断言仍然**早于任何写操作**（下面的 CREATE/ALTER 都还没执行）。
SELECT COALESCE(
         (SELECT NOT pg_has_role('gengyun_api_runtime', 'gengyun_cvm_owner', 'MEMBER')
            FROM pg_roles
           WHERE rolname = 'gengyun_api_runtime'),
         true
       ) AS not_owner_member \gset
\if :not_owner_member
\else
  \echo '错误：gengyun_api_runtime 竟是迁移管理员 gengyun_cvm_owner 的成员；拒绝继续，请人工排查。'
  SELECT 1/0;
\endif

-- --- A. 创建运行时 LOGIN（仅在缺失时）--------------------------------------
-- 属性与 tools/local-dev/database.mjs 建 gengyun_local_runtime 的口径一致：
-- LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS。
SELECT format(
         'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
         'gengyun_api_runtime', :'api_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gengyun_api_runtime')
\gexec

-- --- B. 属性收敛（幂等；**不含 PASSWORD** ⇒ 默认不改口令）-------------------
SELECT format('ALTER ROLE %I WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
              'gengyun_api_runtime')
\gexec

-- --- B2. 口令轮换：只有显式要求才动，保证「重复执行 = 幂等、口令不变」---------
\getenv rotate_password GENGYUN_ROTATE_RUNTIME_PASSWORD
\if :{?rotate_password}
  SELECT (lower(:'rotate_password') IN ('1','true','yes','on')) AS rotate_ok \gset
  \if :rotate_ok
    SELECT format('ALTER ROLE %I WITH PASSWORD %L', 'gengyun_api_runtime', :'api_password')
    \gexec
    \echo '20-login-roles.sql：已按 GENGYUN_ROTATE_RUNTIME_PASSWORD 轮换运行时口令（rolpassword 必然变化，属固有行为）。'
  \else
    \echo '20-login-roles.sql：未轮换口令（GENGYUN_ROTATE_RUNTIME_PASSWORD 非真值，见下一行）。'
    \echo '      GENGYUN_ROTATE_RUNTIME_PASSWORD=' :rotate_password
  \endif
\else
  \echo '20-login-roles.sql：未轮换口令（未设置 GENGYUN_ROTATE_RUNTIME_PASSWORD；重复执行不改口令）。'
\endif

-- --- C. 授予既有 NOLOGIN 组 -------------------------------------------------
-- 上面的 groups_ok 前置已校验 5 个组存在。GRANT 幂等：重复执行不报错，
-- 也不会产生重复授权行（pg_auth_members 有唯一约束）。
GRANT gengyun_auth_privacy    TO gengyun_api_runtime;  -- 身份/会话/隐私/撤回/幂等键
GRANT gengyun_preview_reader  TO gengyun_api_runtime;  -- 公共科普投影 catalog_read.home_species
GRANT gengyun_consent_granter TO gengyun_api_runtime;  -- 用途授权与撤回写入
GRANT gengyun_profile_runtime TO gengyun_api_runtime;  -- 作物/地区目录与单作物档案
GRANT gengyun_knowledge_runtime TO gengyun_api_runtime; -- catalog_read.current_knowledge 只读

\echo '20-login-roles.sql：gengyun_api_runtime 已就位并授予 5 个既有 NOLOGIN 组。'
\echo '下一步：sql/90-assert-least-privilege.sql 断言最小权限（provision-db.sh 会自动执行）。'
\echo '未授予（按需单独开通）：gengyun_evidence_reader / gengyun_source_operator / gengyun_staging_importer。'
