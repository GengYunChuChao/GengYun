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
-- 执行者：迁移管理员 gengyun_cvm_owner（本交付用 `initdb -U` 建为集群超级用户；但**本文件真正要求的
--         是"能力"而非"超级用户"**，见下方"权限前提（按真实 DDL）"）。经 Unix socket + pg_ident 免口令连接；
--         由 provision-db.sh 调用。
-- 前置  ：1) 集群已由 install-postgres.sh 建好；2) 业务库 gengyun 已创建；
--         3) services/api/src/db/migrate.ts up 已在本库应用全部迁移（本文件只授权，不建表）；
--         4) 5 个既有 NOLOGIN 组已由 services/api/db/roles/*.sql 建出
--            （provision-db.sh 在本文件之前完成；本文件只校验存在，不代建）。
--
-- 权限前提（**按真实 DDL 逐条说明**；2026-10-13 按监工批复更正）：
--   * ⚠️ **更正**：**`pgcrypto` 是 trusted extension**（PostgreSQL 13+ 起；PG 17 官方文档 F.26 原文：
--     "This module is considered “trusted”, that is, it can be installed by non-superusers who have
--      CREATE privilege on the current database."）⇒ `CREATE EXTENSION pgcrypto` **不需要超级用户**，
--     只要对**当前数据库**有 `CREATE` 权限。故原先"迁移管理员必须是超级用户，因为 0007 要建 pgcrypto"
--     这一**理由是错的**，已删除。
--   * 迁移 `0001–0010` 实际需要的权限（据真实 DDL：`CREATE SCHEMA`、在自有 schema 内建表/视图/策略、
--     `CREATE EXTENSION pgcrypto WITH SCHEMA staging_intake`）⇒ **数据库属主（非超级用户）即可**。
--   * `services/api/db/roles/*.sql` 建 7 个 NOLOGIN 组 ⇒ 需 **CREATEROLE**（非超级用户亦可）。
--   * **本文件**：A/B 段的 `CREATE ROLE` / `ALTER ROLE` ⇒ 需 **CREATEROLE**（或超级用户）；
--     C 段的 `GRANT <组> TO <运行时角色>` ⇒ 需对所授组有 **ADMIN OPTION**（PG 16+）**或**超级用户。
--     下面把这些写成**前置能力断言**（不再是"必须超级用户"）。
--   * 本交付**唯一**真正需要超级用户的地方是 `90-assert-least-privilege.sql`（以及 `verify-cvm-postgres.sh`
--     的 `runtime_password_scram`）：它们要读 **`pg_authid`**，而该目录**仅超级用户可读**。
--     若不希望依赖超级用户，可用**端到端**证明替代：`verify-cvm-postgres.sh --runtime-password-env …`
--     的 `runtime_tcp_login`（真实 TCP + scram 登录），无需读 `pg_authid`。
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

-- 迁移管理员必须存在（**存在性**检查：确认这是本交付的集群；不要求超级用户）。
-- 【2026-10-13 按监工批复更正】原先这里要求 `rolsuper`，理由是"0007 的 `CREATE EXTENSION pgcrypto`
--   需要超级用户"——**该理由错误**：`pgcrypto` 是 trusted extension（PG 13+），只要对当前数据库有
--   `CREATE` 权限即可安装（PG 17 官方文档 F.26）。改为按**实际所需能力**断言（见下方两条）。
SELECT (count(*) = 1) AS owner_ok
  FROM pg_roles
 WHERE rolname = 'gengyun_cvm_owner'
\gset
\if :owner_ok
\else
  \echo '错误：未找到 gengyun_cvm_owner；数据库可能不是本交付的集群。'
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

-- 【2026-10-13 新增 · 按监工批复"补受影响说明/断言检查"】
-- 能力 1：能创建/收敛角色（A/B 段的 `CREATE ROLE` / `ALTER ROLE` 需 **CREATEROLE** 或超级用户）。
--        只查 pg_roles，对"角色不存在"天然安全（COALESCE 兜底 false）。
SELECT COALESCE((SELECT (rolsuper OR rolcreaterole)
                   FROM pg_roles
                  WHERE rolname = current_user), false) AS can_create_role
\gset
\if :can_create_role
\else
  \echo '错误：当前执行角色既不是超级用户、也没有 CREATEROLE，无法创建/收敛运行时 LOGIN。'
  \echo '      处置：以 gengyun_cvm_owner 执行（本交付由 initdb -U 建为超级用户），或授予'
  \echo '            CREATEROLE 后重跑。注意：pgcrypto 是 trusted extension，**不是**需要超级用户的理由。'
  SELECT 1/0;
\endif

-- 能力 2：能把 5 个既有组授予运行时角色（C 段的 `GRANT <组> TO <运行时角色>` 需对所授组有
--        **ADMIN OPTION**（PG 16+ 起；`pg_auth_members.admin_option`）或本身是超级用户）。
--        `bool_and()` 在 0 行时返回 NULL ⇒ COALESCE 兜底 false，不会误判为"有权限"。
--        （这些组由 roles/*.sql 以**同一迁移管理员**身份创建，PG 16+ 下创建者自动获得其 ADMIN OPTION。）
SELECT (COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false)
        OR COALESCE((SELECT bool_and(m.admin_option)
                       FROM pg_auth_members m
                       JOIN pg_roles g ON g.oid = m.roleid
                       JOIN pg_roles u ON u.oid = m.member
                      WHERE u.rolname = current_user
                        AND g.rolname IN ('gengyun_auth_privacy',
                                          'gengyun_preview_reader',
                                          'gengyun_consent_granter',
                                          'gengyun_profile_runtime',
                                          'gengyun_knowledge_runtime')), false)) AS can_grant_groups
\gset
\if :can_grant_groups
\else
  \echo '错误：当前执行角色对 5 个既有 NOLOGIN 组没有 ADMIN OPTION，也没有超级用户权限，'
  \echo '      无法完成 C 段的 GRANT。处置：以建组时的角色（或超级用户）执行，'
  \echo '      或先 `GRANT <组> TO <当前角色> WITH ADMIN OPTION` 后重跑。'
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

-- --- D. 注销受理：唯一写路径的 EXECUTE（GY-I19 / 迁移 0016）------------------
-- 迁移 0016 建了**窄口径** `SECURITY DEFINER` 函数（属主＝迁移管理员）并
-- `REVOKE ALL ... FROM PUBLIC`。此处把 EXECUTE **只**授予运行时登录角色：
-- 运行时角色对 `public.users` 的 `state`/`auth_epoch`/`revision` 以及
-- `public.deletion_requests` **仍然没有任何直接列权限**（`sql/90-assert-least-privilege.sql`
-- 的 `protected_columns` 与新增的函数级断言同时钉死这条），
-- 只能经此函数在**同一事务**内完成：状态迁移 + `auth_epoch` 递增 + 全会话撤销 + 注销请求落库。
-- 前置：函数必须已存在。顺序是 迁移（migrate.ts up）⇒ 本脚本，缺失即说明迁移没跑完，
-- 必须在此显式失败（而不是留一个「看似已收敛、实际无法注销」的运行态）。
-- #region gy-i19-deletion-grant
-- 下面这一段是**可被测试原样抽取执行**的纯 SQL 区域（不含 psql 元命令）：
-- `tests/integration/account-deletion-pg.mjs` 抽取本区域并原样执行，以证明出厂的授权语句本身可用。
DO $$
BEGIN
  IF to_regprocedure(
       'public.request_account_deletion(uuid,uuid,text,integer,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz)'
     ) IS NULL THEN
    RAISE EXCEPTION '缺少 public.request_account_deletion(...)：迁移 0016 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.request_account_deletion(uuid,uuid,text,integer,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_account_deletion(uuid,uuid,text,integer,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz) TO gengyun_api_runtime;
-- #endregion gy-i19-deletion-grant

-- --- E. 账号停用/恢复：唯一写路径的 EXECUTE（GY-I22 / 迁移 0017）--------------
-- 迁移 0017 建了**窄口径** `SECURITY DEFINER` 函数（属主＝迁移管理员）并
-- `REVOKE ALL ... FROM PUBLIC`。此处把 EXECUTE **只**授予运行时登录角色：
-- 运行时角色对 `public.users` 的 `state`/`auth_epoch`/`revision` 与
-- `public.admin_audit_events` **仍然没有任何直接权限**（`90-assert-least-privilege.sql`
-- 的 `protected_columns` 与新增的函数级/表级断言同时钉死这条）。`public.sessions` 自 0001
-- 起本就有 `UPDATE (token_hash,revoked_at)`，撤会话这一步运行时能单独做，但单靠它无法在
-- **同一事务**里改状态、推进纪元、落审计，所以停用/恢复仍然只能经这两个函数完成：
-- 状态迁移 + `auth_epoch` 递增 + 全会话撤销 + 审计事件落库。
-- 前置：函数必须已存在。顺序是 迁移（migrate.ts up）⇒ 本脚本，缺失即显式失败
-- （绝不留一个「看似已收敛、实际无法停用」的运行态）。
-- #region gy-i22-suspend-grant
-- 下面这一段是**可被测试原样抽取执行**的纯 SQL 区域（不含 psql 元命令）。
DO $$
BEGIN
  IF to_regprocedure('public.suspend_account(uuid,uuid,uuid,integer,uuid)') IS NULL THEN
    RAISE EXCEPTION '缺少 public.suspend_account(...)：迁移 0017 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
  IF to_regprocedure('public.restore_account(uuid,uuid,uuid,integer,uuid)') IS NULL THEN
    RAISE EXCEPTION '缺少 public.restore_account(...)：迁移 0017 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
  IF to_regprocedure('public.admin_account_display_name(text,uuid)') IS NULL THEN
    RAISE EXCEPTION '缺少 public.admin_account_display_name(...)：迁移 0017 未执行。';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.suspend_account(uuid,uuid,uuid,integer,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.restore_account(uuid,uuid,uuid,integer,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_account_display_name(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.suspend_account(uuid,uuid,uuid,integer,uuid) TO gengyun_api_runtime;
GRANT EXECUTE ON FUNCTION public.restore_account(uuid,uuid,uuid,integer,uuid) TO gengyun_api_runtime;
GRANT EXECUTE ON FUNCTION public.admin_account_display_name(text,uuid) TO gengyun_api_runtime;
-- 审计台账：运行时只需"函数内部可写"，直接 DML 一律不给（连 SELECT 都不给，读面未接线）。
REVOKE ALL ON TABLE public.admin_audit_events FROM PUBLIC;
-- #endregion gy-i22-suspend-grant

-- --- F. 账号读面：唯一读路径的 EXECUTE（GY-I18 / 迁移 0021）--------------------
-- 迁移 0021 建了**窄口径** `SECURITY DEFINER` 读函数（属主＝迁移管理员，输出列被签名钉死为
-- `id / revision / state / display_name` 四列）并 `REVOKE ALL ... FROM PUBLIC`。此处把 EXECUTE
-- **只**授予运行时登录角色：运行时对 `public.users` 的 `nickname` / `created_at` / `wechat_*` /
-- `avatar_media_id` / `deletion_generation` **仍然没有任何列权限**（90 号断言 32–37 钉死这条，
-- 集成脚本 `[P]` 手臂还以真实连接做反向控制）。⛔ 不得改成为读面补 `users` 列授权。
-- 前置：函数必须已存在。顺序是 迁移（migrate.ts up）⇒ 本脚本，缺失即显式失败。
-- #region gy-i18-accounts-read-grant
-- 下面这一段是**可被测试原样抽取执行**的纯 SQL 区域（不含 psql 元命令）。
DO $$
BEGIN
  IF to_regprocedure('public.list_admin_accounts()') IS NULL THEN
    RAISE EXCEPTION '缺少 public.list_admin_accounts()：迁移 0021 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.list_admin_accounts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_admin_accounts() TO gengyun_api_runtime;
-- #endregion gy-i18-accounts-read-grant

-- --- F2. 功能开关：读表 + 唯一写路径的 EXECUTE（GY-I18 / 迁移 0020）-------------
-- 迁移 0020 把写面收进 `SECURITY DEFINER` 函数 `public.set_feature_flag(...)`，并对
-- `public.feature_flags` 与函数都 `REVOKE ALL ... FROM PUBLIC`。此处只授予运行时角色：
--   1. `public.feature_flags` 的 **SELECT**（读面与开关门按库判定，单表三行只读）；
--   2. `public.set_feature_flag(...)` 的 **EXECUTE**（写面唯一路径：行锁 + CAS + 同事务审计）。
-- 运行时仍然：⛔ 无 `feature_flags` 的 INSERT/UPDATE/DELETE（表级写一律不给）；
-- ⛔ 对 `admin_audit_events` 连 SELECT 都没有（0017 固化；反向控制见
-- `tests/integration/account-suspend-pg.mjs` 的 `[P]` 组）。
-- `90-assert-least-privilege.sql` 的表级 DML 清单只约束**写**权限 ⇒ 上面的 SELECT 不触发
-- `table_dml_allowlist` 守卫（`audit_ledger_append_only` 仍逐条断言审计表零权限）。
-- 本片不改 90-assert（不在裁定允许的改动面内）；函数级 EXECUTE 的唯一性与表级零写入
-- 由 `tests/integration/admin-flags-pg.mjs` 以运行时角色实测钉住。
-- 前置：迁移 0020 必须先执行（缺失即显式失败，绝不留「看似收敛、实际改不了开关」的运行态）。
-- #region gy-i18-flags-grant
DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION '缺少 public.feature_flags：迁移 0020 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
  IF to_regprocedure('public.set_feature_flag(text,integer,boolean,uuid,uuid,uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION '缺少 public.set_feature_flag(...)：迁移 0020 未执行。';
  END IF;
END;
$$;

REVOKE ALL ON TABLE public.feature_flags FROM PUBLIC;
GRANT SELECT ON TABLE public.feature_flags TO gengyun_api_runtime;

REVOKE ALL ON FUNCTION public.set_feature_flag(text, integer, boolean, uuid, uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_feature_flag(text, integer, boolean, uuid, uuid, uuid, text, text) TO gengyun_api_runtime;
-- #endregion gy-i18-flags-grant

-- --- G. 逐用户备份副本清单：运行时**列级** DML（GY-I19 / 迁移 0023）-----------
-- ---------------------------------------------------------------------------
-- GY-I19（#19）· 逐用户备份副本清单（迁移 0023）的运行时**列级**授权
--
-- 为什么这里也有一份（`services/api/db/roles/auth_privacy.sql` 里已有同一组 GRANT）：
-- `provision-db.sh` 只在组**不存在**时才执行 `roles/*.sql`（见该脚本的逐组循环），
-- 已存在的部署升级到 0023 时不会重跑它 ⇒ 授权必须在**每次都会执行**的本文件里再收敛一次，
-- 否则运行时在受理事务里写清单行会 42501，202 变成 500。
--
-- 口径（与本文件其它区域一致，**不是**放宽「唯一写路径」）：
--   * 注销请求/账号状态仍然只能经 `public.request_account_deletion(...)` 写；
--     本表不是状态机表，是运行时要自己写、自己读、自己落证据的**清单**；
--   * 一律按**列**授予，⛔ 不给表级 DML —— `90-assert-least-privilege.sql` 的
--     `table_dml_allowlist` 只允许 `idempotency_keys` 有表级写入；
--   * ⛔ 不给 DELETE/TRUNCATE：清单行是「清过」的唯一证据（设计 §5.3）。
--
-- 前置：表必须已存在。顺序是 迁移（migrate.ts up）⇒ 本脚本；缺失即显式失败，
-- 绝不留一个「看似已收敛、实际写不进清单」的运行态。
-- #region gy-i19-backup-copies-grant
-- 下面这一段是**可被测试原样抽取执行**的纯 SQL 区域（不含 psql 元命令）。
DO $$
BEGIN
  IF to_regclass('public.user_backup_copies') IS NULL THEN
    RAISE EXCEPTION '缺少 public.user_backup_copies：迁移 0023 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
END;
$$;

REVOKE ALL ON TABLE public.user_backup_copies FROM PUBLIC;
-- SELECT 必须含 `request_id,user_id,module,state,retention_until`：UPDATE 的 WHERE 要读它们；
-- 还必须含 `purge_attempts`：失败留痕是 `purge_attempts = purge_attempts + 1`，读右边也要 SELECT 权。
GRANT SELECT (id,user_id,request_id,module,scope,state,retention_until,payload_digest,evidence_ref,purge_attempts)
  ON public.user_backup_copies TO gengyun_auth_privacy;
GRANT INSERT (id,user_id,request_id,module,scope,delete_generation,lineage,covered_through,
              payload,payload_digest,state,retention_until,purge_attempts,created_at,updated_at)
  ON public.user_backup_copies TO gengyun_auth_privacy;
-- 清除路径只改这几列：payload 置 null、state→purged/failed、证据、尝试次数、时间。
GRANT UPDATE (payload,state,purged_at,evidence_ref,last_error_code,purge_attempts,updated_at)
  ON public.user_backup_copies TO gengyun_auth_privacy;
-- #endregion gy-i19-backup-copies-grant

-- --- H. 运行时域（消息/社区/OCR）的列级授权（R28-S24 / 迁移 0019·0022·0024）------
-- ---------------------------------------------------------------------------
-- 背景：这三域的表**由运行时自己写**（`services/api/src/{messages,community,ocr}/store-pg.ts`），
-- 但本文件此前从未给过它们任何权限 ⇒ 最小权限运行时在这些表上的每条语句都
-- `42501 permission denied for table …`。改前取证：`deploy/postgres-cvm/evidence/probe-runtime-grants.sql`。
--
-- 为什么写在本文件（而不是 roles/*.sql）：`provision-db.sh` 只在组**不存在**时才执行
-- `roles/*.sql`，已存在的部署升级到 0019/0022/0024 时不会重跑它 ⇒ 授权必须在**每次都会执行**
-- 的本文件里再收敛一次（与上面 G 段同理）。
--
-- 给谁：**直授 `gengyun_api_runtime`**，不新建 NOLOGIN 组。理由：
--   * 这三域的唯一消费者就是运行时自身；`roles/*.sql` 是「组」口径的权威，本片不改它们，
--     直授不会让组文件变成谎话；
--   * 本文件 F2 段已有直授先例（`public.feature_flags` 的 SELECT）。
--
-- 粒度：**写面按列、读面按列、DELETE 只能表级**（逐条依据见下，不按「整表全授」）：
--   * INSERT/UPDATE 的列 = `store-pg.ts` 里**真实语句**列出的列；多授一列由
--     `90-assert-least-privilege.sql` 的 `runtime_grants_<表>` 反向断言判红；
--   * SELECT 的列 = 上述语句**读或返回**的列。PG 要求 DELETE/UPDATE 的 `WHERE` 与
--     `RETURNING` 引用列也有 SELECT 权（实测：`DELETE … WHERE b=…` 在只有 `SELECT(a)` 时
--     `42501 permission denied for table`），所以读面列清单不是「可选的」；
--   * DELETE **无法列级化**（PG 没有列级 DELETE），只给三张表：
--     `community_likes`（取消点赞，`community/store-pg.ts:587`）、
--     `community_idempotency`（幂等台账先删后插，`:703/:732/:761`）、
--     `ocr_idempotency`（`:686/:693`）。允许清单由 `90-assert-least-privilege.sql` 的
--     `table_dml_allowlist` **结构化**钉住 —— 其它表的任何表级写权限照样判红；
--   * ⛔ TRUNCATE / REFERENCES / TRIGGER 一律不给；⛔ 消息/帖子/评论/举报/审核决定**没有 DELETE**
--     （删除是 `visibility='deleted'` 的单向门，store-pg.ts 里没有任何物理 DELETE）。
--
-- 前置：10 张表必须已存在。顺序是 迁移（migrate.ts up）⇒ 本脚本；缺失即显式失败，
-- 绝不留一个「看似已收敛、实际写不进」的运行态。
-- #region gy-r28-runtime-domain-grants
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(t.name, ', ' ORDER BY t.name) INTO missing
    FROM unnest(ARRAY[
           'messages',
           'community_posts','community_comments','community_likes','community_reports',
           'community_moderation_decisions','community_idempotency',
           'ocr_jobs','ocr_records','ocr_idempotency'
         ]) AS t(name)
   WHERE to_regclass('public.'||t.name) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '缺少运行时域表：%（迁移 0019/0022/0024 未执行；顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。', missing;
  END IF;
END;
$$;

REVOKE ALL ON TABLE public.messages, public.community_posts, public.community_comments,
                    public.community_likes, public.community_reports,
                    public.community_moderation_decisions, public.community_idempotency,
                    public.ocr_jobs, public.ocr_records, public.ocr_idempotency
  FROM PUBLIC;

-- 消息（迁移 0019）：store-pg.ts:62 的 COLUMNS、:141 的 INSERT、:189 的 UPDATE。
GRANT SELECT (id,revision,owner_id,type,target_ref,read_at,created_at,event_key)
  ON public.messages TO gengyun_api_runtime;
GRANT INSERT (id,owner_id,type,target_ref,read_at,created_at,revision,event_key)
  ON public.messages TO gengyun_api_runtime;
-- 已读回执只改 read_at，并按 revision = revision + 1 做 CAS。
GRANT UPDATE (read_at,revision)
  ON public.messages TO gengyun_api_runtime;

-- 社区帖子（迁移 0022）：:470 的 INSERT、:400 的 UPDATE、:379 的 SELECT … FOR UPDATE。
GRANT SELECT (id,author_id,revision,title,body,crop_id,region_code,media_ids,
              linked_knowledge_type,linked_knowledge_id,linked_knowledge_revision,
              visibility,audit_state,created_at,updated_at)
  ON public.community_posts TO gengyun_api_runtime;
GRANT INSERT (id,author_id,revision,title,body,crop_id,region_code,media_ids,
              linked_knowledge_type,linked_knowledge_id,linked_knowledge_revision,
              visibility,audit_state,created_at,updated_at)
  ON public.community_posts TO gengyun_api_runtime;
-- 删除/重审只改 visibility/audit_state/updated_at；revision 只在补丁显式携带时写。
GRANT UPDATE (revision,title,body,crop_id,region_code,media_ids,
              linked_knowledge_type,linked_knowledge_id,linked_knowledge_revision,
              visibility,audit_state,updated_at)
  ON public.community_posts TO gengyun_api_runtime;

-- 社区评论（迁移 0022）：:531 的 INSERT、:454 的 UPDATE、:435 的 SELECT … FOR UPDATE。
GRANT SELECT (id,post_id,author_id,revision,body,visibility,audit_state,created_at)
  ON public.community_comments TO gengyun_api_runtime;
GRANT INSERT (id,post_id,author_id,revision,body,visibility,audit_state,created_at)
  ON public.community_comments TO gengyun_api_runtime;
GRANT UPDATE (revision,body,visibility,audit_state)
  ON public.community_comments TO gengyun_api_runtime;

-- 点赞（迁移 0022）：:575 的 INSERT、:587 的 DELETE（WHERE 读 target_type/target_id/user_id，
-- RETURNING 读 target_id）、:598 的 count(*)（WHERE 读 target_type/target_id）。
-- created_at 只由列默认值写，运行时既不写也不读 ⇒ 不授。
GRANT SELECT (target_type,target_id,user_id)
  ON public.community_likes TO gengyun_api_runtime;
GRANT INSERT (target_type,target_id,user_id)
  ON public.community_likes TO gengyun_api_runtime;
-- 取消点赞必须物理删除：唯一键 (user_id,target_type,target_id) 是集合语义的载体。
GRANT DELETE ON public.community_likes TO gengyun_api_runtime;

-- 举报（迁移 0022）：:662 的 INSERT、:666 的 ON CONFLICT (id) DO UPDATE。
GRANT SELECT (id,revision,reporter_id,target_type,target_id,target_revision,
              state,reason_code,detail,created_at)
  ON public.community_reports TO gengyun_api_runtime;
GRANT INSERT (id,revision,reporter_id,target_type,target_id,target_revision,
              state,reason_code,detail,created_at)
  ON public.community_reports TO gengyun_api_runtime;
-- 唯一键是 id ⇒ ON CONFLICT 的重放会改写除 id 外的全部列。
GRANT UPDATE (revision,reporter_id,target_type,target_id,target_revision,
              state,reason_code,detail,created_at)
  ON public.community_reports TO gengyun_api_runtime;

-- 审核决定（迁移 0022）：:274/:609 的 INSERT、:279 的 ON CONFLICT 三列主键 DO UPDATE。
GRANT SELECT (target_type,target_id,target_revision,id,decision,reason_codes,
              hard_rule_passed,rule_version,text_digest,contract_complete,
              missing_contract_fields,created_at)
  ON public.community_moderation_decisions TO gengyun_api_runtime;
GRANT INSERT (target_type,target_id,target_revision,id,decision,reason_codes,
              hard_rule_passed,rule_version,text_digest,contract_complete,
              missing_contract_fields,created_at)
  ON public.community_moderation_decisions TO gengyun_api_runtime;
-- 主键三列是冲突目标，不参与 DO UPDATE。
GRANT UPDATE (id,decision,reason_codes,hard_rule_passed,rule_version,text_digest,
              contract_complete,missing_contract_fields,created_at)
  ON public.community_moderation_decisions TO gengyun_api_runtime;

-- 社区幂等台账（迁移 0022）：:737 的 INSERT、:703/:732/:761 的 DELETE。
-- response_status/outcome 是唯一的「回填结果」写面（:749 的 UPDATE）。
GRANT SELECT (scope,key_hash,request_hash,response_status,outcome,expires_at)
  ON public.community_idempotency TO gengyun_api_runtime;
GRANT INSERT (scope,key_hash,request_hash,response_status,outcome,expires_at)
  ON public.community_idempotency TO gengyun_api_runtime;
GRANT UPDATE (response_status,outcome)
  ON public.community_idempotency TO gengyun_api_runtime;
-- 过期占位与「放弃认领」都要物理删除（见 :703/:732/:761）。
GRANT DELETE ON public.community_idempotency TO gengyun_api_runtime;

-- OCR 任务（迁移 0024）：:167 的 INSERT_JOB、:521/:560 的 UPDATE、:540 的 SELECT … FOR UPDATE。
GRANT SELECT (id,revision,kind,owner_user_id,ocr_id,media_id,media_revision,
              state,deadline_at,created_at,updated_at,error_code)
  ON public.ocr_jobs TO gengyun_api_runtime;
GRANT INSERT (id,revision,kind,owner_user_id,ocr_id,media_id,media_revision,
              state,deadline_at,created_at,updated_at,error_code)
  ON public.ocr_jobs TO gengyun_api_runtime;
GRANT UPDATE (revision,state,deadline_at,updated_at,error_code)
  ON public.ocr_jobs TO gengyun_api_runtime;

-- OCR 记录（迁移 0024）：:171 的 INSERT_RECORD、:599 的 UPDATE。
GRANT SELECT (id,revision,owner_user_id,media_id,media_revision,raw_fields,
              corrected_fields,verification,model_version,created_at,updated_at,deleted)
  ON public.ocr_records TO gengyun_api_runtime;
GRANT INSERT (id,revision,owner_user_id,media_id,media_revision,raw_fields,
              corrected_fields,verification,model_version,created_at,updated_at,deleted)
  ON public.ocr_records TO gengyun_api_runtime;
GRANT UPDATE (revision,raw_fields,corrected_fields,verification,model_version,
              updated_at,deleted)
  ON public.ocr_records TO gengyun_api_runtime;

-- OCR 幂等台账（迁移 0024）：:655 的 INSERT … ON CONFLICT DO UPDATE（改 request_hash/
-- payload/pending/expires_at）、:674 的 UPDATE（payload/pending）、:686/:693 的 DELETE。
GRANT SELECT (scope,key_hash,request_hash,payload,pending,expires_at)
  ON public.ocr_idempotency TO gengyun_api_runtime;
GRANT INSERT (scope,key_hash,request_hash,payload,pending,expires_at)
  ON public.ocr_idempotency TO gengyun_api_runtime;
GRANT UPDATE (request_hash,payload,pending,expires_at)
  ON public.ocr_idempotency TO gengyun_api_runtime;
GRANT DELETE ON public.ocr_idempotency TO gengyun_api_runtime;
-- #endregion gy-r28-runtime-domain-grants

\echo '20-login-roles.sql：gengyun_api_runtime 已就位并授予 5 个既有 NOLOGIN 组。'
\echo '20-login-roles.sql：已授予 public.request_account_deletion(...) 的 EXECUTE（唯一写路径；未授予任何列权限）。'
\echo '20-login-roles.sql：已授予 public.suspend_account(...) / public.restore_account(...) 的 EXECUTE（唯一写路径；未授予任何列权限）。'
\echo '20-login-roles.sql：已授予 public.list_admin_accounts() 的 EXECUTE（账号读面唯一读路径；未授予 users 的任何列权限）。'
\echo '20-login-roles.sql：已授予 public.feature_flags 的 SELECT 与 public.set_feature_flag(...) 的 EXECUTE（唯一写路径；未授予任何表级写权限）。'
\echo '20-login-roles.sql：已授予 public.user_backup_copies 的列级 SELECT/INSERT/UPDATE（运行时自写的备份副本清单；无表级 DML、无 DELETE/TRUNCATE）。'
\echo '20-login-roles.sql：已授予 public.messages、public.community_*（六张）、public.ocr_*（三张）的列级 SELECT/INSERT/UPDATE（写面列由 store-pg.ts 真实语句反推；无表级 INSERT/UPDATE/TRUNCATE/REFERENCES/TRIGGER）。'
\echo '20-login-roles.sql：DELETE 仅**表级**授予 public.community_likes / public.community_idempotency / public.ocr_idempotency（PG 无列级 DELETE；其余表的 DELETE 一律未授）。'
\echo '下一步：sql/90-assert-least-privilege.sql 断言最小权限（provision-db.sh 会自动执行）。'
\echo '未授予（按需单独开通）：gengyun_evidence_reader / gengyun_source_operator / gengyun_staging_importer。'
