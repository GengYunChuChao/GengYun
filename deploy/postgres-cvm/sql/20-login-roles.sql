-- ============================================================================
-- 耕云 · CVM PostgreSQL 17：业务库 LOGIN 身份引导（迁移之后执行）
--
-- 状态：技术准备物，未部署、未验收、未在任何真实 PG 实例上执行过。
--
-- 执行者：迁移管理员 gengyun_cvm_owner（initdb -U 建出的超级用户），
--         经 Unix socket + pg_ident 免口令连接；由 provision-db.sh 调用。
-- 前置  ：1) 集群已由 install-postgres.sh 建好；2) 业务库 gengyun 已创建；
--         3) services/api/src/db/migrate.ts up 已在本库应用全部迁移
--            （本文件只授权，不建表；迁移前执行会因表不存在而失败）。
--
-- 本文件只做两件事：
--   A. 创建/收敛应用运行时 LOGIN 身份 gengyun_api_runtime（最小权限）
--   B. 把既有 NOLOGIN 组授权给它（组本身由既有
--      services/api/db/roles/*.sql 创建，本文件不复制、不改写那些语义）
--
-- 刻意不做：
--   * 不创建 gengyun_cvm_owner（由 initdb 创建为集群超级用户）
--   * 不授予 gengyun_evidence_reader / gengyun_source_operator /
--     gengyun_staging_importer（理由与开通方式见 roles-and-migration.md 第 3 节）
--   * 不 REVOKE 任何既有授权：有越权时由 90-assert-least-privilege.sql 报错，
--     由人决定，脚本不静默回收
--
-- 口令来源：环境变量 GENGYUN_API_RUNTIME_PASSWORD（\getenv 读取），
--           要求 48 位小写十六进制（与 tools/local-dev/start.ps1 的生成口径一致）。
--           口令不进仓库、不进 argv、不打印；私密文件注入方式见 runbook.md 第 2 节。
--
-- 用法（通常不必手工执行）：
--   sudo -u postgres /usr/lib/postgresql/17/bin/psql -h /var/run/postgresql \
--     -U gengyun_cvm_owner -d gengyun -v ON_ERROR_STOP=1 \
--     -f deploy/postgres-cvm/sql/20-login-roles.sql
-- ============================================================================

\set ON_ERROR_STOP on
\pset pager off

-- --- 0. 取口令并做前置判定（不满足即中止，绝不建无口令身份）-----------------
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

-- 迁移管理员必须存在且是超级用户（0007 的 CREATE EXTENSION pgcrypto 需要超级用户，
-- 因此迁移管理员就是 initdb 建出的超级用户；不能被运行身份复用）。
SELECT (count(*) = 1) AS owner_ok
  FROM pg_roles
 WHERE rolname = 'gengyun_cvm_owner' AND rolsuper
\gset
\if :owner_ok
\else
  \echo '错误：未找到超级用户 gengyun_cvm_owner；数据库可能不是本交付的集群。'
  SELECT 1/0;
\endif

-- 应用运行时身份不得与迁移管理员同体。
SELECT (NOT pg_has_role('gengyun_api_runtime', 'gengyun_cvm_owner', 'MEMBER')) AS not_owner_member \gset
\if :not_owner_member
\else
  \echo '错误：gengyun_api_runtime 竟是迁移管理员成员；拒绝继续，请人工排查。'
  SELECT 1/0;
\endif

-- --- A. 创建 / 收敛运行时 LOGIN ---------------------------------------------
-- 属性与 tools/local-dev/database.mjs 建 gengyun_local_runtime 的口径一致：
-- LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS。
SELECT format(
         'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
         'gengyun_api_runtime', :'api_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gengyun_api_runtime')
\gexec

-- 幂等收敛：无论新建还是已存在，都把口令设为私密通道提供的值（轮换即重跑本文件）。
SELECT format('ALTER ROLE %I WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
              'gengyun_api_runtime', :'api_password')
\gexec

-- --- B. 授予既有 NOLOGIN 组 -------------------------------------------------
-- 组由 services/api/db/roles/*.sql 创建（provision-db.sh 在调用本文件之前完成）。
-- GRANT 本身幂等，重复执行不报错。
GRANT gengyun_auth_privacy    TO gengyun_api_runtime;  -- 身份/会话/隐私/撤回/幂等键
GRANT gengyun_preview_reader  TO gengyun_api_runtime;  -- 公共科普投影 catalog_read.home_species
GRANT gengyun_consent_granter TO gengyun_api_runtime;  -- 用途授权与撤回写入
GRANT gengyun_profile_runtime TO gengyun_api_runtime;  -- 作物/地区目录与单作物档案
GRANT gengyun_knowledge_runtime TO gengyun_api_runtime; -- catalog_read.current_knowledge 只读

\echo '20-login-roles.sql：已创建/收敛 gengyun_api_runtime 并授予 5 个既有 NOLOGIN 组。'
\echo '下一步：sql/90-assert-least-privilege.sql 断言最小权限（provision-db.sh 会自动执行）。'
\echo '未授予（按需单独开通）：gengyun_evidence_reader / gengyun_source_operator / gengyun_staging_importer。'
