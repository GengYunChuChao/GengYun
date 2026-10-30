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
--   * `services/api/db/roles/*.sql` 建 8 个角色文件、11 个 NOLOGIN 角色（组）⇒ 需 **CREATEROLE**（非超级用户亦可）；
--     **本文件只授其中 5 个组**（C 段）；`egress_ledger.sql` 当前不被任何部署脚本执行，故 `gengyun_egress_ledger` 不在本文件的授权面内。
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

-- --- D2. 在线清理证据：唯一写/读路径的 EXECUTE（GY-R32 / 迁移 0031）------------
-- 迁移 0031 把「在线清理的成功行证据」从命令报告 stdout 落进
-- `public.deletion_requests.online_purge_evidence`（append-only jsonb 数组），并提供两条**窄口径**
-- `SECURITY DEFINER` 函数（属主＝迁移管理员），两函数都已 `REVOKE ALL ... FROM PUBLIC`：
--   · `record_online_purge_evidence(...)` —— 唯一写路径（受理时的处理器与到期驱动共用）；
--   · `read_online_purge_evidence(...)`   —— 唯一读路径（回执在线态推导，按 user_id 过滤）。
-- 此处把 EXECUTE **只**授予运行时登录角色：运行时对 `public.deletion_requests` **仍然没有**
-- 任何表级/列级权限（`90-assert-least-privilege.sql` 的 protected_columns、domain_manifest 的
-- forbidden 分类与第 48 项逐字不动），因此「写证据」与「读回执」都只能经这两条可断言的路径。
-- 前置：函数必须已存在；顺序是 迁移（migrate.ts up）⇒ 本脚本，缺失即显式失败。
-- #region gy-r32-i19-online-evidence-grant
-- 下面这一段是**可被测试原样抽取执行**的纯 SQL 区域（不含 psql 元命令）。
DO $$
BEGIN
  IF to_regprocedure(
       'public.record_online_purge_evidence(uuid,text,text,integer,integer,timestamptz)'
     ) IS NULL THEN
    RAISE EXCEPTION '缺少 public.record_online_purge_evidence(...)：迁移 0031 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
  IF to_regprocedure('public.read_online_purge_evidence(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '缺少 public.read_online_purge_evidence(...)：迁移 0031 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.record_online_purge_evidence(uuid,text,text,integer,integer,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.read_online_purge_evidence(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_online_purge_evidence(uuid,text,text,integer,integer,timestamptz) TO gengyun_api_runtime;
GRANT EXECUTE ON FUNCTION public.read_online_purge_evidence(uuid,uuid) TO gengyun_api_runtime;
-- #endregion gy-r32-i19-online-evidence-grant
\echo '20-login-roles.sql：已授予 record_online_purge_evidence(...) / read_online_purge_evidence(...) 的 EXECUTE（在线证据唯一写/读路径；未授予任何表/列权限）。'

-- --- D3. 注销内容清理：识别域/语音域按主体清空的 EXECUTE（GY-R34 / 迁移 0034）------
-- 注销闭集从 5 项扩到 7 项（识别域四表 + 语音域三表），内容清理由各域 handler 在在线窗口内
-- 各自执行并各自留证据串。清理写路径**不是**给运行时发表级 DELETE，而是迁移 0034 建的两条
-- **窄口径** `SECURITY DEFINER` 函数（属主＝迁移管理员，`REVOKE ALL ... FROM PUBLIC`）：
--   · `purge_owner_recognitions(uuid)` —— 只删该主体的 recognition_selections / jobs / records
--     与 recognition_idempotency 台账；
--   · `purge_owner_speech(uuid)`       —— 只删该主体的 speech_jobs / transcriptions 与
--     speech_idempotency 台账。
-- 为什么必须这样（而不是表级 GRANT DELETE）：PG 没有列级 DELETE，而运行时对这五张正文表的
-- **整行 DELETE 是刻意的禁止面** —— `deploy/postgres-cvm/evidence/probe-runtime-grants.sql`
-- 逐条探针要求「直接 DELETE 必须恰好 42501」（deploy-sql-gate 的 18 条 / 9 个对象）。
-- 因此这里**只**授 EXECUTE：五张表对运行时**仍然一条 DELETE 都没有**（90-assert 的
-- `domain_manifest` 与表级写授权白名单逐字不动，函数面由 `function_surface_manifest` 登记）。
-- 若把 DELETE 授出去，等于改掉一条安全不变量，那要走安全评审，不是发权限的顺手活。
-- 前置：函数必须已存在。顺序是 迁移（migrate.ts up）⇒ 本脚本，缺失即显式失败
-- （绝不留一个「看似已收敛、实际注销清不动」的运行态）。
-- #region gy-r34-i19-owner-content-purge-grant
-- 下面这一段是**可被测试原样抽取执行**的纯 SQL 区域（不含 psql 元命令）。
DO $$
BEGIN
  IF to_regprocedure('public.purge_owner_recognitions(uuid)') IS NULL THEN
    RAISE EXCEPTION '缺少 public.purge_owner_recognitions(uuid)：迁移 0034 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
  IF to_regprocedure('public.purge_owner_speech(uuid)') IS NULL THEN
    RAISE EXCEPTION '缺少 public.purge_owner_speech(uuid)：迁移 0034 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_owner_recognitions(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_owner_speech(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_owner_recognitions(uuid) TO gengyun_api_runtime;
GRANT EXECUTE ON FUNCTION public.purge_owner_speech(uuid) TO gengyun_api_runtime;
-- #endregion gy-r34-i19-owner-content-purge-grant
\echo '20-login-roles.sql：已授予 purge_owner_recognitions(uuid) / purge_owner_speech(uuid) 的 EXECUTE（注销内容清理的唯一写路径；五张正文表对运行时仍然零 DELETE）。'

-- --- D4. 注销媒体域：媒体行物理删除的 EXECUTE（GY-R34 / #19 片2 / 迁移 0035）---
-- `public.media` 的删除语义原来是**状态机**（deleting → deleted，UPDATE state），运行时的
-- 表级 DELETE 为零；段 M 的 `\echo` 把这条不变量写死了：
--   「media 故意不授 DELETE —— 删除是状态机（deleting→deleted，UPDATE state），
--     媒体行是审计与计费事实，不物理删。」
-- 注销/撤回要真删**行**时，仍然不走表级授权，而是走迁移 0035 的一条**窄口径**
-- `SECURITY DEFINER` 函数（属主＝迁移管理员，`REVOKE ALL ... FROM PUBLIC`）：
--   · `purge_owner_media(uuid)` —— 只删该主体 `state IN ('rejected','deleted')` 的
--     `media` 行及其 `media_derivatives`，且**必须先有** `media_object_cleanup` 的清理意图行
--     （缺则 `G0007` 整批不删），并**跳过**被 `content_media_refs` / `community_media_grants` /
--     `public_authors.avatar_media_id` 引用的行（读数 `skipped_referenced`）。
-- 为什么必须这样（而不是加一条表级 GRANT DELETE）：PG 没有列级 DELETE ⇒ 表级 DELETE 会连
-- 「本人 + 终态 + 未被引用 + 已入队」这四个谓词一起送掉；而这条函数正是那四个谓词的唯一载体。
-- 因此这里**只**授 EXECUTE：`media` / `media_derivatives` 对运行时的授权面**逐字未变**
-- （`90-assert` 的 `domain_manifest` 与表级写授权白名单不动，媒体域只由
-- `function_surface_manifest` 登记函数面）。若把 DELETE 授出去，等于改掉一条安全不变量，
-- 那要走安全评审，不是发权限的顺手活。
-- 前置：函数必须已存在。顺序是 迁移（migrate.ts up）⇒ 本脚本，缺失即显式失败
-- （绝不留一个「看似已收敛、实际注销删不动媒体行」的运行态）。
-- #region gy-r34-i19-media-row-purge-grant
-- 下面这一段是**可被测试原样抽取执行**的纯 SQL 区域（不含 psql 元命令）。
DO $$
BEGIN
  IF to_regprocedure('public.purge_owner_media(uuid)') IS NULL THEN
    RAISE EXCEPTION '缺少 public.purge_owner_media(uuid)：迁移 0035 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_owner_media(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_owner_media(uuid) TO gengyun_api_runtime;
-- #endregion gy-r34-i19-media-row-purge-grant
\echo '20-login-roles.sql：已授予 purge_owner_media(uuid) 的 EXECUTE（注销媒体行物理删除的唯一写路径；public.media / media_derivatives 对运行时仍然零**表级** DELETE 变更，一张表都没加）。'

-- --- D2. 回执 bearer 台账：唯一读/写路径的 EXECUTE（GY-I19 片B / 迁移 0038）--------
-- 迁移 0038 建了三条**窄口径** `SECURITY DEFINER` 函数（属主＝迁移管理员）并
-- `REVOKE ALL ... FROM PUBLIC`：`set_deletion_receipt`（set/clear 回执 bearer 摘要）、
-- `resolve_deletion_receipt`（按摘要反查请求 id）、`count_deletion_receipts`（诊断读数）。
-- 此处把 EXECUTE **只**授予运行时登录角色：运行时对 `public.deletion_requests`
-- **仍然零表级、零列级直接权限**（`90-assert-least-privilege.sql` 的 protected_columns 与
-- 函数级断言逐字不动），回执 bearer 的读/写只有这三条函数这一个面。
-- 前置：函数必须已存在。顺序是 迁移（migrate.ts up）⇒ 本脚本，缺失即显式失败。
-- #region gy-r34-i19-deletion-receipt-grant
-- 下面这一段是**可被测试原样抽取执行**的纯 SQL 区域（不含 psql 元命令）。
DO $$
BEGIN
  IF to_regprocedure('public.set_deletion_receipt(uuid,text,timestamptz,timestamptz)') IS NULL
     OR to_regprocedure('public.resolve_deletion_receipt(text)') IS NULL
     OR to_regprocedure('public.count_deletion_receipts()') IS NULL THEN
    RAISE EXCEPTION '缺少回执台账函数：迁移 0038 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_deletion_receipt(uuid,text,timestamptz,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_deletion_receipt(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.count_deletion_receipts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_deletion_receipt(uuid,text,timestamptz,timestamptz) TO gengyun_api_runtime;
GRANT EXECUTE ON FUNCTION public.resolve_deletion_receipt(text) TO gengyun_api_runtime;
GRANT EXECUTE ON FUNCTION public.count_deletion_receipts() TO gengyun_api_runtime;
-- #endregion gy-r34-i19-deletion-receipt-grant
\echo '20-login-roles.sql：已授予 set_deletion_receipt/resolve_deletion_receipt/count_deletion_receipts 的 EXECUTE（回执 bearer 台账唯一读写路径；运行时对 public.deletion_requests 仍然零表级、零列级直接权限）。'

-- --- D5. 第三方删除持久化：请求与证据的唯一读/写路径（S4 P1 / 迁移 0044）--------
-- `public.third_party_deletions` 在 `90-assert-least-privilege.sql:1131-1134` 是
-- **forbidden**（断言 48 `runtime_domain_forbidden_tables_untouched` 要求运行时对它零表级、
-- 零列级权限），因为它记的是「第三方到底删没删、证据是什么」——那是审计面，不是业务草稿。
-- 迁移 0044 建了两条**窄口径** `SECURITY DEFINER` 函数（属主＝迁移管理员，
-- `REVOKE ALL ... FROM PUBLIC`）：
--   · `record_third_party_deletion(uuid,text,uuid,text,text,text,timestamptz)` —— 唯一写路径
--     （覆盖写 + 状态机单调守卫 + `confirmed` 必须一次带齐证据；两个面同时写同一状态）；
--   · `list_third_party_deletions(uuid)` —— 唯一读路径（只吐八个证据面列，固定排序）。
-- 为什么必须这样（而不是给运行时一条表级 INSERT/UPDATE）：表级写权限会连
-- 「终态不可回退 / confirmed 必须有证据 / 一面写齐」这三条谓词一起送掉 —— 那三条谓词**只**
-- 活在这条函数里；而且一旦有 SELECT，第三方删除的证据面就变成任意读。
-- 因此这里**只**授 EXECUTE：`third_party_deletions` 对运行时的授权面**逐字未变**
-- （`domain_manifest` 的 forbidden 行与断言 48 不动，本域只由 `function_surface_manifest`
-- 登记函数面）。若要把表权限授出去，等于改掉一条安全不变量，那要走安全评审。
-- 前置：函数必须已存在。顺序是 迁移（migrate.ts up）⇒ 本脚本，缺失即显式失败
-- （绝不留一个「看似已收敛、实际第三方删除记不住」的运行态）。
-- #region gy-s4-third-party-deletion-grant
-- 下面这一段是**可被测试原样抽取执行**的纯 SQL 区域（不含 psql 元命令）。
DO $$
BEGIN
  IF to_regprocedure('public.record_third_party_deletion(uuid,text,uuid,text,text,text,timestamptz)') IS NULL THEN
    RAISE EXCEPTION '缺少 public.record_third_party_deletion(uuid,text,uuid,text,text,text,timestamptz)：迁移 0044 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
  IF to_regprocedure('public.list_third_party_deletions(uuid)') IS NULL THEN
    RAISE EXCEPTION '缺少 public.list_third_party_deletions(uuid)：迁移 0044 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.record_third_party_deletion(uuid, text, uuid, text, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_third_party_deletions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_third_party_deletion(uuid, text, uuid, text, text, text, timestamptz) TO gengyun_api_runtime;
GRANT EXECUTE ON FUNCTION public.list_third_party_deletions(uuid) TO gengyun_api_runtime;
-- #endregion gy-s4-third-party-deletion-grant
\echo '20-login-roles.sql：已授予 record_third_party_deletion(...) / list_third_party_deletions(uuid) 的 EXECUTE（第三方删除请求与证据的唯一读/写路径；public.third_party_deletions 对运行时仍然 forbidden，一条表级/列级权限都没加）。'


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

-- --- 开关审计只读面（R29-S5 / 迁移 0027：`list_admin_flag_audit`）-----------
-- 为什么需要（AC 原话「谁在什么时候把开关从 A 改成 B（审计行），可查」）：
-- 迁移 0020 的 `set_feature_flag` 已把 `action='set_flag'` 的审计行写进
-- `admin_audit_events`，但运行时角色对审计表**连 SELECT 都没有**（见本文件
-- 上面 `audit_ledger_append_only` 的零权限断言），所以「可查」在 API 面上原本做不到。
-- 这里**不**给表级 SELECT（会破坏审计表零权限、且会把别人的审计行一起打开），
-- 只给一个 SECURITY DEFINER 函数的 EXECUTE：函数体内 `SET search_path = pg_catalog`，
-- 只返回 `action='set_flag'` 一类行，键集分页（(created_at,id) 严格递减）。
-- 函数级 EXECUTE 的唯一性与表级仍为零权限，由 `tests/integration/admin-jobs-pg.mjs`
-- 以运行时角色实测钉住（表级读被拒、函数读被放行）。
-- 前置：迁移 0027 必须先执行（缺失即显式失败，绝不留「看似收敛、点开 500」的运行态）。
-- #region gy-i18-flag-audit-grant
DO $$
BEGIN
  IF to_regprocedure('public.list_admin_flag_audit(integer,timestamp with time zone,uuid)') IS NULL THEN
    RAISE EXCEPTION '缺少 public.list_admin_flag_audit(...)：迁移 0027 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.list_admin_flag_audit(integer, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_admin_flag_audit(integer, timestamptz, uuid) TO gengyun_api_runtime;
-- #endregion gy-i18-flag-audit-grant

-- --- 后台审计日志只读面（R34 / 迁移 0033：`list_admin_audit_logs`）-----------
-- 上一段只放开了 `action='set_flag'` 一类行；同样落在 `admin_audit_events` 的
-- `account.suspend` / `account.restore` 在库内没有任何读路径（进程内 `audit-events`
-- 只看得见内存 store，real 模式下实测 503）。这里同样**不**给表级 SELECT，
-- 只给一个 SECURITY DEFINER 函数的 EXECUTE：函数体内 `SET search_path = pg_catalog`，
-- 键集分页 `(created_at,id)` 严格递减，`target_ref` 在函数内按允许列表重建。
-- 前置：迁移 0033 必须先执行（缺失即显式失败，绝不留「看似收敛、点开 503」的运行态）。
-- #region gy-r34-audit-logs-grant
DO $$
BEGIN
  IF to_regprocedure('public.list_admin_audit_logs(integer,timestamp with time zone,timestamp with time zone,text[],text[],timestamp with time zone,uuid)') IS NULL THEN
    RAISE EXCEPTION '缺少 public.list_admin_audit_logs(...)：迁移 0033 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.list_admin_audit_logs(integer, timestamptz, timestamptz, text[], text[], timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_admin_audit_logs(integer, timestamptz, timestamptz, text[], text[], timestamptz, uuid) TO gengyun_api_runtime;
-- #endregion gy-r34-audit-logs-grant

-- ---------------------------------------------------------------------------
-- F2. 后台管理员 scope 的授予/撤销（`#18` S2 片1 / 迁移 0041）
--
-- 为什么是「函数 EXECUTE」而不是「表写权限」：`admin_scopes` 对运行时是**零表级写、零列级写**
-- （`90-assert-least-privilege.sql` 的 external_manifest 把表级 S/I/U/D 钉成 false 且列级
-- ins/upd 为空数组；槽 9 的 protected_columns 再钉死 `scope` 列不可 UPDATE）。授权维护只能经
-- 0041 的两条窄口径 SECURITY DEFINER 函数：函数内固定 `search_path = pg_catalog`、不接收任何
-- SQL 片段、并自带「操作者有效且持 scopes:write」「只授自己当前有效持有的 scope」「禁自授、
-- 允许自撤」「最后授权者守卫（事务级 advisory 锁内核验）」四条校验。
--
-- 前置：两条函数必须已存在。顺序是 迁移（migrate.ts up）⇒ 本脚本，缺失即显式失败，
-- 绝不留「看似收敛、点开 503/42501」的运行态。
-- #region gy-r37-s2-scope-grant
DO $$
BEGIN
  IF to_regprocedure('public.grant_admin_scope(uuid,uuid,text,text,uuid,uuid,integer)') IS NULL THEN
    RAISE EXCEPTION '缺少 public.grant_admin_scope(...)：迁移 0041 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
  IF to_regprocedure('public.revoke_admin_scope(uuid,uuid,text,text,uuid,uuid,integer)') IS NULL THEN
    RAISE EXCEPTION '缺少 public.revoke_admin_scope(...)：迁移 0041 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.grant_admin_scope(uuid, uuid, text, text, uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_admin_scope(uuid, uuid, text, text, uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.grant_admin_scope(uuid, uuid, text, text, uuid, uuid, integer) TO gengyun_api_runtime;
GRANT EXECUTE ON FUNCTION public.revoke_admin_scope(uuid, uuid, text, text, uuid, uuid, integer) TO gengyun_api_runtime;
-- #endregion gy-r37-s2-scope-grant

-- --- 后台作业取消审计（R18 / `#18` / 迁移 0043：`record_admin_job_cancel_audit`）----
-- 为什么又是「函数 EXECUTE」而不是「表写权限」：`admin_audit_events` 对运行时是**零表级、
-- 零列级**写权限（`90-assert-least-privilege.sql` 的 external_manifest 把表级 S/I/U/D 钉成 false，
-- 槽 9 的 protected_columns 再钉死关键列），而且表上挂 `admin_audit_events_append_only`
-- 触发器（UPDATE/DELETE 一律 `G0006`）——审计台账**只可追加**。
-- `job.cancel` 的审计行因此只能经 0043 的窄口径 SECURITY DEFINER 函数写入：函数内固定
-- `action='job.cancel'` / `scope='jobs:cancel'` / `result='accepted'`，`target_ref` 由形参
-- 重建，并重核验「操作者存在 + `state='active'` + 当前有效持 `jobs:cancel`」三条 ⇒
-- 调用方拿不到伪造 actor、伪造动作文本或伪造 target 的任何缝隙。
--
-- 前置：函数必须已存在。顺序是 迁移（migrate.ts up）⇒ 本脚本，缺失即显式失败，
-- 绝不留「看似收敛、点开 503」的运行态（回滚 0043 时本段会在下次部署里显式报错 —— 这正是要的效果）。
-- #region gy-r18-job-cancel-audit-grant
DO $$
BEGIN
  IF to_regprocedure('public.record_admin_job_cancel_audit(uuid,uuid,integer,text,uuid)') IS NULL THEN
    RAISE EXCEPTION '缺少 public.record_admin_job_cancel_audit(...)：迁移 0043 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.record_admin_job_cancel_audit(uuid, uuid, integer, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_admin_job_cancel_audit(uuid, uuid, integer, text, uuid) TO gengyun_api_runtime;
-- #endregion gy-r18-job-cancel-audit-grant

-- --- 后台 scope 操作**被拒**的留痕（`#18` S2 收尾片 / 迁移 0046：`record_admin_scope_denial`）----
-- 为什么又是「函数 EXECUTE」而不是「表写权限」：`admin_audit_events` 对运行时是**零表级、
-- 零列级**写权限（`90-assert-least-privilege.sql` 的 external_manifest 把表级 S/I/U/D 钉成 false，
-- 槽 9 的 protected_columns 再钉死关键列），而且表上挂 `admin_audit_events_append_only`
-- 触发器（UPDATE/DELETE 一律 `G0006`）——审计台账**只可追加**。
-- 为什么需要它：`0041` 的两条 scope 函数在**主事务内**抛 G0008/G0009/G0010/G0011 ⇒ 那一笔
-- 整体回滚，被拒的动作**什么都没留下**（`0041` 原话：「拒绝也留痕」需要第二个事务，属写面）。
-- 0046 就是那条第二个事务里的写入口：函数内固定 `action='admin_scope.deny'` / `result='denied'` /
-- `target_ref=NULL`，`target_hint` 由形参重建，`scope` 与 `reason_code` 都走闭集。
-- ⚠ 与上面 `record_admin_job_cancel_audit` 的**唯一差异**（刻意，裁定 B）：本函数**只**核
-- actor 存在，⛔ 不核 `state='active'`、⛔ 不核是否持 `scopes:write` —— 被拒的正是这件事；
-- 重核验会把「因为不持 scopes:write 而被拒」的行再拒一次，留痕函数就成了
-- 「只有没被拒的人才记得下自己曾被拒」。⚠ 也因此本函数记的是**应用层申报**，不是库层证明
-- （主事务已 ROLLBACK、0041 的事务级 advisory 锁已释放，库无从复算）。
--
-- 前置：函数必须已存在。顺序是 迁移（migrate.ts up）⇒ 本脚本，缺失即显式失败，
-- 绝不留「看似收敛、点开 42501」的运行态（回滚 0046 时本段会在下次部署里显式报错 —— 这正是要的效果）。
-- #region gy-r64-pr4a-denial-trace-grant
DO $$
BEGIN
  IF to_regprocedure('public.record_admin_scope_denial(uuid,uuid,text,text,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '缺少 public.record_admin_scope_denial(uuid,uuid,text,text,uuid,uuid)：迁移 0046 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.record_admin_scope_denial(uuid, uuid, text, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_admin_scope_denial(uuid, uuid, text, text, uuid, uuid) TO gengyun_api_runtime;
-- #endregion gy-r64-pr4a-denial-trace-grant
\echo '20-login-roles.sql：已授予 record_admin_scope_denial(...) 的 EXECUTE（后台 scope 操作被拒时的留痕唯一写路径；public.admin_audit_events 对运行时仍然零表级、零列级权限）。'

-- --- 后台「隐藏帖子」审计（R64 / `#18` / 迁移 0047：`record_admin_post_hide_audit`）----
-- 为什么又是「函数 EXECUTE」而不是「表写权限」：`admin_audit_events` 对运行时是**零表级、
-- 零列级**写权限（`90-assert-least-privilege.sql` 的 external_manifest 把表级 S/I/U/D 钉成 false，
-- 槽 9 的 protected_columns 再钉死关键列），而且表上挂 `admin_audit_events_append_only`
-- 触发器（UPDATE/DELETE 一律 `G0006`）——审计台账**只可追加**。
-- `post.hide` 的审计行因此只能经 0047 的窄口径 SECURITY DEFINER 函数写入：函数内固定
-- `action='post.hide'` / `scope='sources:write'` / `result='accepted'`，`target_ref` 由形参重建，
-- `reason_code` 走闭集 {'post_hidden'}，并重核验「操作者存在 + `state='active'` + 当前有效持
-- `sources:write`」三条 ⇒ 调用方拿不到伪造 actor、伪造动作文本或伪造 target 的任何缝隙。
-- ⚠ 与 `record_admin_job_cancel_audit` 的差异只有一处（刻意）：本函数把理由码单独做一道闭集校验
-- （不在闭集即 `G0018 INVALID_REASON_CODE`）——理由码是可伪造的审计**语义**，值得单独一个错误码。
--
-- 前置：函数必须已存在。顺序是 迁移（migrate.ts up）⇒ 本脚本，缺失即显式失败，
-- 绝不留「看似收敛、点开 42501」的运行态（回滚 0047 时本段会在下次部署里显式报错 —— 这正是要的效果）。
-- #region gy-r64-posthide-audit-grant
DO $$
BEGIN
  IF to_regprocedure('public.record_admin_post_hide_audit(uuid,uuid,integer,text,uuid)') IS NULL THEN
    RAISE EXCEPTION '缺少 public.record_admin_post_hide_audit(...)：迁移 0047 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.record_admin_post_hide_audit(uuid, uuid, integer, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_admin_post_hide_audit(uuid, uuid, integer, text, uuid) TO gengyun_api_runtime;
-- #endregion gy-r64-posthide-audit-grant
\echo '20-login-roles.sql：已授予 record_admin_post_hide_audit(...) 的 EXECUTE（后台隐藏帖子的审计唯一写路径；public.admin_audit_events 对运行时仍然零表级、零列级权限）。'

-- --- 后台管理员账号停用/恢复（R68 / 迁移 0048：`disable_admin_account` / `enable_admin_account`）----
-- 为什么还是「函数 EXECUTE」而不是「表写权限」：这两个写入口要动的两张表
-- （`public.admin_accounts` 的 `state`/`auth_epoch`/`revision`、`public.admin_sessions` 的
-- `revoked_at`）对运行时**都没有 UPDATE 列权**（`90-assert-least-privilege.sql` 的
-- external_manifest 把表级 S/I/U/D 钉成 false），而「停用一名管理员」必须**同时**完成
-- 「改状态 + 抬 `auth_epoch` + 踢掉他的全部活会话 + 写一行审计」。逐表授写权限既拿不到这份
-- 原子性，也会把 `credential_hash` 这类列暴露给运行时的任意 UPDATE。
-- 0048 的窄口径 SECURITY DEFINER 函数在体内固定
-- `action='admin_account.disable'|'admin_account.enable'`、`scope='scopes:write'`、
-- `reason_code='admin_account_disabled'|'admin_account_enabled'`、`before_value/after_value = NULL`，
-- 并在同一事务里**先**取 0041 的同一把事务级 advisory 锁
-- （`pg_advisory_xact_lock(hashtextextended('admin_scope:' || 'scopes:write', 18040))`，见 `0041:235`）
-- **再** `SELECT … FOR UPDATE` 目标行（锁序照 `0041:75`：advisory ⇒ 行，绝不反向）⇒ 与 scope
-- 写面串行化在同一把锁上，并发「停用 / 撤销最后一个 scope」不会互相绕过。
--
-- 前置：函数必须已存在。顺序是 迁移（migrate.ts up）⇒ 本脚本，缺失即显式失败，
-- 绝不留「看似收敛、点开 42501」的运行态（回滚 0048 时本段会在下次部署里显式报错 —— 这正是要的效果）。
-- #region gy-r68-admin-account-state-grant
DO $$
BEGIN
  IF to_regprocedure('public.disable_admin_account(uuid,uuid,uuid,integer,uuid,text)') IS NULL THEN
    RAISE EXCEPTION '缺少 public.disable_admin_account(uuid,uuid,uuid,integer,uuid,text)：迁移 0048 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
  IF to_regprocedure('public.enable_admin_account(uuid,uuid,uuid,integer,uuid,text)') IS NULL THEN
    RAISE EXCEPTION '缺少 public.enable_admin_account(uuid,uuid,uuid,integer,uuid,text)：迁移 0048 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.disable_admin_account(uuid, uuid, uuid, integer, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enable_admin_account(uuid, uuid, uuid, integer, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.disable_admin_account(uuid, uuid, uuid, integer, uuid, text) TO gengyun_api_runtime;
GRANT EXECUTE ON FUNCTION public.enable_admin_account(uuid, uuid, uuid, integer, uuid, text) TO gengyun_api_runtime;
-- #endregion gy-r68-admin-account-state-grant
\echo '20-login-roles.sql：已授予 disable_admin_account(...) / enable_admin_account(...) 的 EXECUTE（后台管理员账号停用/恢复的唯一写路径；public.admin_accounts 与 public.admin_sessions 对运行时仍然零 UPDATE 列权、零表级 DML）。'

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
--   * DELETE **无法列级化**（PG 没有列级 DELETE），只给五张表：
--     `community_likes`（取消点赞，`community/store-pg.ts:587`）、
--     `community_idempotency`（幂等台账先删后插，`:703/:732/:761`）、
--     `ocr_idempotency`（`:686/:693`）、
--     `ocr_jobs` / `ocr_records`（R34 片 3 起：注销闭集按主体物理删除，见 OCR 段末条注释）。
--     允许清单由 `90-assert-least-privilege.sql` 的 `table_dml_allowlist` **结构化**钉住 ——
--     其它表的任何表级写权限照样判红；
--   * ⚠️ `ocr_jobs` / `ocr_records` 的表级 DELETE 是本文件**唯一**新增删除面：
--     用户于 2026-10-24 在指挥会话中明确批准：把 `ocr_jobs` / `ocr_records` 的表级 `DELETE`
--     作为本仓**唯一例外**（`public.media` 表级 `DELETE` 仍禁止）。批示记录见
--     `.pg17/ruling-r34-user-decisions-20261024.md` §U-2（指挥侧工作区文件，不入库）；
--     **仓内无第三方书面凭证**。这两张表此前只有列级 SELECT/INSERT/UPDATE ⇒ 运行时**删不掉**
--     任何行，注销闭集只能绕 `SECURITY DEFINER`；批准后 OCR 三表统一走表级 DELETE。
--     ⛔ 例外**仅限**这两张表：`public.media` 仍然不给 DELETE（媒体域走 `0035` 的窄函数）；
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

-- 注销清理（#16/#17 清理链 P0-1）：`services/api/src/messages/store-pg.ts` 的
-- `purgeOwnerRows` 有整行删除 `DELETE FROM public.messages WHERE owner_id = $1::uuid`
-- （返回注销证据用的真实行数）。PostgreSQL 没有列级 DELETE，这条语句只能表级授权；
-- 与收藏/历史/对话/识别/语音域的注销清理同一条理由（见 90-assert-least-privilege.sql 的
-- allow_table_dml 白名单）。运行时仍然只能按 owner 谓词删本域自己的行，写面列授权不变。
GRANT DELETE ON public.messages TO gengyun_api_runtime;

-- 社区帖子（迁移 0022）：:470 的 INSERT、:400 的 UPDATE、:379 的 SELECT … FOR UPDATE。
-- 迁移 0030（F13 行级作者注销引用）新增行内列 `anonymized_author_ref`：读路径要按行投影注销引用
-- ⇒ SELECT 面补该列；注销清理要在**同一事务**里把 `author_id` 置 NULL 并写入匿名引用
-- ⇒ UPDATE 面补 `author_id, anonymized_author_ref`（这是本表 UPDATE 首次包含 `author_id`：
-- 只用于"把作者指针换成 NULL"这一条显式语句，不引入任何改作者归属的入口）。
-- ⛔ INSERT 列表不动（新列创建时恒为 NULL，`author_id` 仍由投稿写入）。
GRANT SELECT (id,author_id,anonymized_author_ref,revision,title,body,crop_id,region_code,media_ids,
              linked_knowledge_type,linked_knowledge_id,linked_knowledge_revision,
              visibility,audit_state,created_at,updated_at)
  ON public.community_posts TO gengyun_api_runtime;
GRANT INSERT (id,author_id,revision,title,body,crop_id,region_code,media_ids,
              linked_knowledge_type,linked_knowledge_id,linked_knowledge_revision,
              visibility,audit_state,created_at,updated_at)
  ON public.community_posts TO gengyun_api_runtime;
-- 删除/重审只改 visibility/audit_state/updated_at；revision 只在补丁显式携带时写；
-- 注销清理另需 author_id/anonymized_author_ref（见上）。
GRANT UPDATE (revision,title,body,crop_id,region_code,media_ids,
              linked_knowledge_type,linked_knowledge_id,linked_knowledge_revision,
              visibility,audit_state,updated_at,author_id,anonymized_author_ref)
  ON public.community_posts TO gengyun_api_runtime;

-- 社区评论（迁移 0022）：:531 的 INSERT、:454 的 UPDATE、:435 的 SELECT … FOR UPDATE。
-- 迁移 0030：与帖子同口径 —— SELECT 补 `anonymized_author_ref`，UPDATE 补
-- `author_id, anonymized_author_ref`（注销清理置 NULL + 写匿名引用）；INSERT 列清单不动。
GRANT SELECT (id,post_id,author_id,anonymized_author_ref,revision,body,visibility,audit_state,created_at)
  ON public.community_comments TO gengyun_api_runtime;
GRANT INSERT (id,post_id,author_id,revision,body,visibility,audit_state,created_at)
  ON public.community_comments TO gengyun_api_runtime;
GRANT UPDATE (revision,body,visibility,audit_state,author_id,anonymized_author_ref)
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

-- 举报（迁移 0022）：:662 的 INSERT、:666 的 ON CONFLICT (id) DO UPDATE、:803 的按 id 读。
-- 迁移 0032（#15 去身份残留 · 举报者行级注销引用）新增行内列 `anonymized_author_ref`：
--   · 读路径（`REPORT_COLUMNS`）要按行投影注销引用 ⇒ SELECT 面补该列；
--   · 注销清理在**同一事务**里 `SET reporter_id = NULL, anonymized_author_ref = $2`
--     ⇒ UPDATE 面补该列（`reporter_id` 本来就在 UPDATE 清单里：ON CONFLICT 重放会改写它）。
-- ⛔ INSERT 列表不动：新举报的举报者恒为活账户，新列创建时恒为 NULL（0032 的 exactly_one 靠它）。
GRANT SELECT (id,revision,reporter_id,anonymized_author_ref,target_type,target_id,target_revision,
              state,reason_code,detail,created_at)
  ON public.community_reports TO gengyun_api_runtime;
GRANT INSERT (id,revision,reporter_id,target_type,target_id,target_revision,
              state,reason_code,detail,created_at)
  ON public.community_reports TO gengyun_api_runtime;
-- 唯一键是 id ⇒ ON CONFLICT 的重放会改写除 id 外的全部列。
GRANT UPDATE (revision,reporter_id,anonymized_author_ref,target_type,target_id,target_revision,
              state,reason_code,detail,created_at)
  ON public.community_reports TO gengyun_api_runtime;

-- 审核决定（迁移 0022；`decided_by` 由迁移 0045 增加）：:274/:609 的 INSERT、:279 的 ON CONFLICT
-- 三列主键 DO UPDATE。**人工审核**（S3）是这条表上唯一的"带人"写入：机器结论恒 NULL。
GRANT SELECT (target_type,target_id,target_revision,id,decision,reason_codes,
              hard_rule_passed,rule_version,text_digest,contract_complete,
              missing_contract_fields,decided_by,created_at)
  ON public.community_moderation_decisions TO gengyun_api_runtime;
GRANT INSERT (target_type,target_id,target_revision,id,decision,reason_codes,
              hard_rule_passed,rule_version,text_digest,contract_complete,
              missing_contract_fields,decided_by,created_at)
  ON public.community_moderation_decisions TO gengyun_api_runtime;
-- 主键三列是冲突目标，不参与 DO UPDATE。
GRANT UPDATE (id,decision,reason_codes,hard_rule_passed,rule_version,text_digest,
              contract_complete,missing_contract_fields,decided_by,created_at)
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
-- R34 片 3（#19 / #10）· **表级 DELETE 的唯一例外**：
--   用户于 2026-10-24 在指挥会话中明确批准：把 `ocr_jobs` / `ocr_records` 的表级 `DELETE` 作为
--   本仓**唯一例外**（`public.media` 表级 `DELETE` 仍禁止）。批示记录见
--   `.pg17/ruling-r34-user-decisions-20261024.md` §U-2（指挥侧工作区文件，不入库）；
--   **仓内无第三方书面凭证**（⛔ 不得描述成一手书面批准或"已过安全评审"）。
-- 注销闭集要按 `owner_user_id` 物理删除任务行与识别结果行（先 `ocr_records` 后 `ocr_jobs`，
-- 见 `services/api/src/ocr/store-pg.ts` 的 `purgeOwnerData`）。PG 没有列级 DELETE，而这两张表
-- 此前只有列级 SELECT/INSERT/UPDATE ⇒ 运行时**删不掉**任何行，闭集只能绕 `SECURITY DEFINER`。
-- 批准后与上面的 `ocr_idempotency` 统一成表级 DELETE（三表一条路线），替换原来的
-- SECURITY DEFINER 路线。允许清单仍由 90-assert 的 `table_dml_allowlist` 结构化钉住。
-- ⛔ 例外**仅限**这两张表：`public.media` 等其它表一律不授 DELETE（媒体域走 0035 的窄函数）。
GRANT DELETE ON public.ocr_jobs TO gengyun_api_runtime;
GRANT DELETE ON public.ocr_records TO gengyun_api_runtime;

-- 统一作业台账 `public.jobs`（建表 0001，R34 曾把本表移出授权面）· GY-R71 首个写入者：
-- `services/api/src/jobs/ledger.ts` 的 `JOB_LEDGER_UPSERT_SQL` **一条**语句 ——
--   INSERT 15 列；`ON CONFLICT (id) DO UPDATE` 改 5 列（state/revision/error_code/result_ref/updated_at）。
-- ⚠ SELECT 面**实测是 6 列，不是 2 列**（本片修正）：`ON CONFLICT (id) DO UPDATE` 会让 PG 读旧行，
--   除冲突目标 `id` 与 `WHERE` 里的 `state` 外，DO UPDATE 的**每个 SET 列**也必须可 SELECT。
--   真 PG 17.11 留一法实测（`consent-grant-postgres-17.11` 的台账写入）：id / state / revision /
--   error_code / result_ref / updated_at **缺任一列**即 `42501 permission denied for table jobs`；
--   而 lease_token / created_at / provider_config_version 等**非 SET 列**并不需要，故仍是**列级**，
--   不必升到表级 SELECT。复核点：`tests/integration/egress-ledger-pg.mjs` 执行本区授权后真跑那条 upsert。
-- ⚠ R34 的裁定 3 是「零**读者**、零入向外键、无外发账本关联」，本片不改这条：`/admin/jobs` 仍只读
--   三张域内表（`services/api/src/admin/ops/jobs-pg.ts:4-9`），`jobs` 至今**没有读面**。
--   变的是**写入面**：表第一次有了写入者，于是按写入者真实列授权（15/5/6 列）。
--   授权面扩大属需追认的事，证据与边界见 docs/verification/gy-r71-jobs-ledger-20261030.md。
-- #region gy-r71-jobs-ledger-grant
-- 本区是 `public.jobs` 授权的**唯一来源**，被两条供给路径共用：
--   ① 生产/部署：本文件每次部署都会执行（理由见下面 I 段开头：`services/api/db/roles/*.sql`
--      只在 `pg_roles` 里还没有该 NOLOGIN 组时才跑，故运行时授权必须落在这里）。
--   ② CI 臂 `consent-grant-postgres-17.11` 的 `tests/integration/egress-ledger-pg.mjs`：该臂**不执行**
--      本文件，它按 `#region` 抽取本区文本、**只**把受权角色替换成自建 LOGIN 后原样执行。
-- 为什么收成一处：GY-R71 首版只改了本文件，而那条臂的运行时角色由 `services/api/db/roles/*.sql`
-- 那 8 份文件供给（其中**没有任何一处**提到 jobs）⇒ `POST /recognitions` 的台账 upsert 直接
-- `42501 permission denied for table jobs`，`consent-grant-postgres-17.11` 变红。抄一份进测试就会再漂。
-- ⛔ 因此本区必须是**纯 SQL**（无 psql 元命令）、且只能含 `public.jobs` 的**列级**授权：
--    无表级 DML、无 DELETE、无 TRUNCATE。抽取方逐条断言这些形状（改宽 ⇒ 两条路径一起红）。
GRANT SELECT (id,state,revision,error_code,result_ref,updated_at) ON public.jobs TO gengyun_api_runtime;
GRANT INSERT (id,owner_id,kind,target_type,target_id,entity_revision,input_hash,
              auth_epoch,state,revision,deadline_at,error_code,result_ref,created_at,updated_at)
  ON public.jobs TO gengyun_api_runtime;
GRANT UPDATE (state,revision,error_code,result_ref,updated_at)
  ON public.jobs TO gengyun_api_runtime;
-- #endregion gy-r71-jobs-ledger-grant
-- 同一张表的**删除面**（GY-R71 补片，账号注销清理）：`public.jobs` 的第一次 DELETE 授权。
-- 为什么需要：台账行里有 `owner_id` / `target_id` / `result_ref` 等私有作业关联，源域表被注销清掉后
-- 这些行若留着，用户的作业身份与产出指针仍在库中而闭集看不见（「台账无读者」不是保留依据）。
-- `services/api/src/jobs/ledger.ts::JOB_LEDGER_PURGE_SQL` 一条 `DELETE … WHERE owner_id = $1::uuid`，
-- 由 `privacy/user-data-deletion.ts` 的 `jobs` 模块驱动（`app.ts` 有池时无条件注入）。
-- PG 没有列级 DELETE ⇒ 只能表级授予，与 messages / favorites / conversations 同一条理由；
-- 白名单由 90-assert 的 `allow_table_dml` 与 `expected(..., del=true)` 两处独立复述。
-- ⛔ 单独成区（不并进上面那个列级区）：`tests/integration/egress-ledger-pg.mjs` 会按 `#region`
--    抽取 `gy-r71-jobs-ledger-grant` 并**逐条断言它只含列级授权**；DELETE 留在该区里会让那条臂判红。
-- #region gy-r71-jobs-ledger-purge-grant
GRANT DELETE ON public.jobs TO gengyun_api_runtime;
-- #endregion gy-r71-jobs-ledger-purge-grant
-- #endregion gy-r28-runtime-domain-grants

\echo '20-login-roles.sql：gengyun_api_runtime 已就位并授予 5 个既有 NOLOGIN 组。'
\echo '20-login-roles.sql：已授予 public.request_account_deletion(...) 的 EXECUTE（唯一写路径；未授予任何列权限）。'
\echo '20-login-roles.sql：已授予 public.suspend_account(...) / public.restore_account(...) 的 EXECUTE（唯一写路径；未授予任何列权限）。'
\echo '20-login-roles.sql：已授予 public.list_admin_accounts() 的 EXECUTE（账号读面唯一读路径；未授予 users 的任何列权限）。'
\echo '20-login-roles.sql：已授予 public.feature_flags 的 SELECT 与 public.set_feature_flag(...) 的 EXECUTE（唯一写路径；未授予任何表级写权限）。'
\echo '20-login-roles.sql：已授予 public.user_backup_copies 的列级 SELECT/INSERT/UPDATE（运行时自写的备份副本清单；无表级 DML、无 DELETE/TRUNCATE）。'
\echo '20-login-roles.sql：已授予 public.messages、public.community_*（六张）、public.ocr_*（三张）的列级 SELECT/INSERT/UPDATE（写面列由 store-pg.ts 真实语句反推；无表级 INSERT/UPDATE/TRUNCATE/REFERENCES/TRIGGER）。'
\echo '20-login-roles.sql：已授予 public.jobs（统一作业台账）的列级 SELECT（6 列：id + DO UPDATE 的 5 个 SET 列）/ INSERT（15 列）/ UPDATE（5 列）——GY-R71 的首个写入者 services/api/src/jobs/ledger.ts；该表至今**零读面**，无表级 INSERT/UPDATE/TRUNCATE。'
\echo '20-login-roles.sql：DELETE 仅**表级**授予 public.community_likes / public.community_idempotency / public.ocr_idempotency / public.ocr_jobs / public.ocr_records / public.jobs（PG 无列级 DELETE；其中 OCR 三表为 R34 片 3 起**由用户批准**的表级例外，jobs 为 GY-R71 补片的注销清理面，其余表的 DELETE 一律未授）。'
\echo '下一步：sql/90-assert-least-privilege.sql 断言最小权限（provision-db.sh 会自动执行）。'
\echo '未授予（按需单独开通）：gengyun_evidence_reader / gengyun_source_operator / gengyun_staging_importer。'

-- --- I. 运行时域（收藏／历史／对话）的列级授权（R28-S26 / 迁移 0013·0018）----------
-- 本段为什么写在这个文件里（与上面 G/H 段同一条理由）：`deploy/postgres-cvm/provision-db.sh`
-- 只在 `pg_roles` 里还没有这些 NOLOGIN 组时才跑 `services/api/db/roles/*.sql`，而
-- `gengyun_api_runtime` 的授权每次部署都会跑本文件 ⇒ 运行时角色的授权必须落在这里；
-- 放在 roles/*.sql 里既不会对新库生效（组已存在即跳过），也无法与迁移顺序解耦。
--
-- 覆盖七张表（两份迁移）：
--   0018_favorites_history.sql：favorites / history / favorites_idempotency / history_idempotency
--   0013_conversations.sql    ：conversations / conversation_turns / conversation_answers
-- 清单不是猜的：每一列都从 store-pg.ts 的真实 SQL 反推（见证据页的逐条对照），
--   收藏：services/api/src/favorites/store-pg.ts:150,167,171,187,211,221,233,248,276,286,295,316,344,356,366
--   历史：services/api/src/history/store-pg.ts:155,159,176,200,207,216,226,237,250,277,287,295,315,342,353,362
--   对话：services/api/src/conversations/store-pg.ts:222,235,246,260,269,282,309,324,342,351,361,376,403,421,432
--
-- 三档粒度，逐条有据：
--   ① 读面按列：SELECT 只给 store 的列清单。DELETE/UPDATE 的 `WHERE` 与 `RETURNING`
--      引用列也必须有 SELECT 权（实测：只有 SELECT(a) 时 `DELETE … WHERE b = …` 报 42501），
--      所以两张幂等台账的 SELECT 是全部 6 列（`ON CONFLICT (scope, key_hash) … RETURNING scope`）。
--   ② 写面按列：INSERT / UPDATE 只给真实语句里出现过的列。
--   ③ DELETE 在 PG 里没有列级形式 ⇒ 六张表只能表级授权：
--      favorites / history / conversations / conversation_turns（物理删除与注销清空）、
--      favorites_idempotency / history_idempotency（过期清理与 claim 释放）。
--      `conversation_answers` **不授 DELETE**：它的行只随 conversation_turns 的
--      `ON DELETE CASCADE` 消失（0013 里 turn_id 的外键；实测见证据页）。
--   `UPDATE (revision)` 只是**行锁载体**：favorites / history / conversations 的 store 里
--   没有任何 UPDATE 语句，但都有 `SELECT … FOR UPDATE`，而 PG 的 FOR UPDATE 要求 UPDATE 权
--   （实测：只有列级 SELECT 时 `SELECT … FOR UPDATE` 报 `42501 permission denied for table
--   favorites`；追加 `GRANT UPDATE (revision)` 后 FOR UPDATE / FOR SHARE 均通过）。
--   它不是业务写权限，也不给其它列。
--   ⛔ 一律不给 TRUNCATE / REFERENCES / TRIGGER，一律不给表级 INSERT/UPDATE。
\echo '--- I. 运行时域（收藏／历史／对话）列级授权（R28-S26，迁移 0013 / 0018）---'

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(t.name, ', ' ORDER BY t.name) INTO missing
    FROM unnest(ARRAY['favorites', 'favorites_idempotency', 'history', 'history_idempotency',
                      'conversations', 'conversation_turns', 'conversation_answers']) AS t(name)
   WHERE to_regclass('public.' || t.name) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '缺少运行时域表：%（迁移 0013 / 0018 未执行；顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。', missing;
  END IF;
END;
$$;

REVOKE ALL ON TABLE public.favorites,
                     public.favorites_idempotency,
                     public.history,
                     public.history_idempotency,
                     public.conversations,
                     public.conversation_turns,
                     public.conversation_answers
  FROM PUBLIC;

-- favorites（0018）：SELECT 7 列 / INSERT 7 列 / UPDATE(revision) 仅行锁 / 表级 DELETE
GRANT SELECT (id, owner_id, target_type, target_id, target_revision, revision, created_at)
  ON public.favorites TO gengyun_api_runtime;
GRANT INSERT (id, owner_id, target_type, target_id, target_revision, revision, created_at)
  ON public.favorites TO gengyun_api_runtime;
GRANT UPDATE (revision) ON public.favorites TO gengyun_api_runtime;
GRANT DELETE ON public.favorites TO gengyun_api_runtime;

-- history（0018）：SELECT 11 列 / INSERT 11 列 / UPDATE(revision) 仅行锁 / 表级 DELETE
GRANT SELECT (id, owner_id, kind, target_type, target_id, target_revision, revision,
              job_id, job_state, event_key, created_at)
  ON public.history TO gengyun_api_runtime;
GRANT INSERT (id, owner_id, kind, target_type, target_id, target_revision, revision,
              job_id, job_state, event_key, created_at)
  ON public.history TO gengyun_api_runtime;
GRANT UPDATE (revision) ON public.history TO gengyun_api_runtime;
GRANT DELETE ON public.history TO gengyun_api_runtime;

-- history_idempotency（0018）：SELECT 6 列（含 WHERE / RETURNING 引用的 scope、key_hash）/
-- INSERT 6 列 / UPDATE 4 列（claim 的冲突覆盖与 complete 的落结果）/ 表级 DELETE（过期与释放）
GRANT SELECT (scope, key_hash, request_hash, response_status, outcome, expires_at)
  ON public.history_idempotency TO gengyun_api_runtime;
GRANT INSERT (scope, key_hash, request_hash, response_status, outcome, expires_at)
  ON public.history_idempotency TO gengyun_api_runtime;
GRANT UPDATE (request_hash, response_status, outcome, expires_at)
  ON public.history_idempotency TO gengyun_api_runtime;
GRANT DELETE ON public.history_idempotency TO gengyun_api_runtime;

-- favorites_idempotency（0018）：同上
GRANT SELECT (scope, key_hash, request_hash, response_status, outcome, expires_at)
  ON public.favorites_idempotency TO gengyun_api_runtime;
GRANT INSERT (scope, key_hash, request_hash, response_status, outcome, expires_at)
  ON public.favorites_idempotency TO gengyun_api_runtime;
GRANT UPDATE (request_hash, response_status, outcome, expires_at)
  ON public.favorites_idempotency TO gengyun_api_runtime;
GRANT DELETE ON public.favorites_idempotency TO gengyun_api_runtime;

-- conversations（0013）：SELECT 6 列 / INSERT 6 列 / UPDATE(revision) 仅行锁 / 表级 DELETE
GRANT SELECT (id, owner_id, revision, conditions, created_at, updated_at)
  ON public.conversations TO gengyun_api_runtime;
GRANT INSERT (id, owner_id, revision, conditions, created_at, updated_at)
  ON public.conversations TO gengyun_api_runtime;
GRANT UPDATE (revision) ON public.conversations TO gengyun_api_runtime;
GRANT DELETE ON public.conversations TO gengyun_api_runtime;

-- conversation_turns（0013）：SELECT 14 列（answer_id 由 RETURNING 读回）/ INSERT 13 列
-- （store 的 INSERT 从不写 answer_id）/ UPDATE 5 列（认领 job 与落结果）/ 表级 DELETE
GRANT SELECT (id, conversation_id, owner_id, revision, input_text, transcription_ref,
              job_id, job_state, job_deadline_at, job_created_at, job_error_code, answer_id,
              created_at, updated_at)
  ON public.conversation_turns TO gengyun_api_runtime;
GRANT INSERT (id, conversation_id, owner_id, revision, input_text, transcription_ref,
              job_id, job_state, job_deadline_at, job_created_at, job_error_code,
              created_at, updated_at)
  ON public.conversation_turns TO gengyun_api_runtime;
GRANT UPDATE (job_state, job_error_code, answer_id, revision, updated_at)
  ON public.conversation_turns TO gengyun_api_runtime;
GRANT DELETE ON public.conversation_turns TO gengyun_api_runtime;

-- conversation_answers（0013）：SELECT 14 列 / INSERT 14 列；无 UPDATE、无 DELETE
-- （行只随 turn 的 ON DELETE CASCADE 消失，级联由外键属主执行，不需要运行时的 DELETE 权）
GRANT SELECT (id, turn_id, owner_id, revision, status, checked_text, check_state, citations,
              dose_cards, model_version, prompt_version, rule_version, created_at, updated_at)
  ON public.conversation_answers TO gengyun_api_runtime;
GRANT INSERT (id, turn_id, owner_id, revision, status, checked_text, check_state, citations,
              dose_cards, model_version, prompt_version, rule_version, created_at, updated_at)
  ON public.conversation_answers TO gengyun_api_runtime;

\echo '20-login-roles.sql：已授予 public.favorites / public.history / public.conversations / public.conversation_turns / public.conversation_answers / public.favorites_idempotency / public.history_idempotency 的列级 SELECT/INSERT/UPDATE（写面列由 store-pg.ts 真实语句反推；无表级 INSERT/UPDATE/TRUNCATE/REFERENCES/TRIGGER）。'
\echo '20-login-roles.sql：DELETE 仅**表级**授予 public.favorites / public.history / public.conversations / public.conversation_turns / public.favorites_idempotency / public.history_idempotency（PG 无列级 DELETE；public.conversation_answers 靠 conversation_turns 的 ON DELETE CASCADE，不授 DELETE）。'
\echo '20-login-roles.sql：public.favorites / public.history / public.conversations 的 UPDATE (revision) 仅是 SELECT … FOR UPDATE 的**行锁载体**（store 里没有 UPDATE 语句），不是业务写权限。'

-- ============================================================================
-- J. 运行时域（识别）的列级授权（R28-S28 / 迁移 0025） -------------------------
--
-- 为什么写在这个文件、而不是 services/api/db/roles/*.sql：
--   运行时域的授权按**部署顺序**生效，不按建组时生效。roles/*.sql 只在建组那一次跑，
--   而本文件每次 provision 都跑；H 段（messages/community/ocr）与 I 段（收藏/历史/对话）
--   都在这里，本段与它们同构：缺表硬守卫 → REVOKE ALL … FROM PUBLIC → 逐列 GRANT → 摘要。
--
-- 覆盖迁移 0025_recognitions_persistence.sql 的四张表（该迁移已随 #333 合入 main，341ad8c）：
--   public.recognition_jobs / public.recognition_records /
--   public.recognition_selections / public.recognition_idempotency
--
-- 列清单不是抄的：逐列从 services/api/src/recognitions/store-pg.ts 的真实语句反推
-- （行号按该文件 node 行号）：
--   * 列常量：JOB_COLUMNS :177-178、RECORD_COLUMNS :179-180、SELECTION_COLUMNS :181-182
--   * 写入：INSERT_JOB :184-186（12 列）、INSERT_RECORD :188-190（12 列）、
--           INSERT_SELECTION :192-194（8 列）
--   * 读回：getJob :576、updateJob 的 SELECT :587、commitTerminal 的 SELECT … FOR UPDATE
--           :612-614、getRecognition :656-658、updateRecognition 的 SELECT :668-670、
--           commitSelection 的 SELECT … FOR UPDATE :707-709、listSelections :762-767
--   * 更新：updateJob :592-601（5 列 SET）、updateRecognition :676-698（7 列 SET）、
--           commitTerminal :632-641（jobs 5 列 SET）、commitSelection :730-751（records 7 列 SET）
--   * 幂等台账：claim :206-214（INSERT … ON CONFLICT DO UPDATE）、select :216-218、
--           complete :221-227、release DELETE :819-823、purge DELETE :829-834
--
-- 四档粒度，逐条有据：
--   ① 读面按列：四表 SELECT 全给 store 会读的列。ON CONFLICT 的 (scope, key_hash) 推断、
--      EXCLUDED / `WHERE expires_at <= $5` / DELETE 的 WHERE 与 RETURNING 都要 SELECT 权，
--      所以 recognition_idempotency 的 SELECT 是全部 6 列。
--   ② 写面按列：jobs INSERT 12 列 + UPDATE 5 列；records INSERT 12 列 + UPDATE 7 列；
--      selections INSERT 8 列、**不授 UPDATE**（选中结果落在 recognition_records.
--      selected_species_id 上，见 commitSelection :730-751）；idempotency INSERT 6 列 +
--      UPDATE 4 列（request_hash / payload / pending / expires_at）。
--   ③ `SELECT … FOR UPDATE` 只在 recognition_jobs :613 与 recognition_records :708 出现，
--      而这两张表本来就有**真实**的 UPDATE 列（业务写权限）⇒ 行锁由它们满足，
--      **不**另授 S26 那种 `UPDATE (revision)` 行锁载体（性质不同，别照抄 I 段那句注释）。
--      recognition_selections 不授 UPDATE，它的 FOR UPDATE 仍然 42501 —— store 从不这么用。
--   ④ PG 没有列级 DELETE ⇒ 表级 DELETE 只授 recognition_idempotency（release / purge 是两条
--      整行 DELETE）。jobs / records / selections **不授 DELETE**：账号注销走
--      public.request_account_deletion()（SECURITY DEFINER，以属主身份级联），四表的
--      owner_user_id 都是 ON DELETE CASCADE，运行时不需要删这三张表的任何行。
--   ⛔ 一律不给 TRUNCATE / REFERENCES / TRIGGER；表级 INSERT / UPDATE 一律不给
--      （idempotency 的 DELETE 是本段唯一的表级写授权）。
\echo '--- J. 运行时域（识别）列级授权（R28-S28，迁移 0025）---'

-- 缺表硬前置（方案 B，S24 证据页 §10 的裁决）：0025 已合入 main，四张表是硬依赖。
-- 顺序错（先跑本文件、后跑 migrate.ts）时这里直接失败，不再像 S24 的软守卫那样只提示。
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(t.name, ', ' ORDER BY t.name) INTO missing
    FROM unnest(ARRAY['recognition_jobs', 'recognition_records',
                      'recognition_idempotency', 'recognition_selections']) AS t(name)
   WHERE to_regclass('public.' || t.name) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '缺少识别域表：%（迁移 0025 未执行；顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。', missing;
  END IF;
END;
$$;

REVOKE ALL ON TABLE public.recognition_jobs,
                     public.recognition_records,
                     public.recognition_selections,
                     public.recognition_idempotency
  FROM PUBLIC;

-- recognition_jobs（0025）：SELECT 12 列 / INSERT 12 列 / UPDATE 5 列；无 DELETE
GRANT SELECT (id, revision, kind, owner_user_id, recognition_id, media_id, media_revision,
              state, deadline_at, created_at, updated_at, error_code)
  ON public.recognition_jobs TO gengyun_api_runtime;
GRANT INSERT (id, revision, kind, owner_user_id, recognition_id, media_id, media_revision,
              state, deadline_at, created_at, updated_at, error_code)
  ON public.recognition_jobs TO gengyun_api_runtime;
GRANT UPDATE (revision, state, deadline_at, updated_at, error_code)
  ON public.recognition_jobs TO gengyun_api_runtime;

-- recognition_records（0025）：SELECT 12 列 / INSERT 12 列 / UPDATE 7 列；无 DELETE
GRANT SELECT (id, revision, owner_user_id, media_id, media_revision, candidates,
              uncertainty_reasons, selected_species_id, model_version, created_at, updated_at,
              deleted)
  ON public.recognition_records TO gengyun_api_runtime;
GRANT INSERT (id, revision, owner_user_id, media_id, media_revision, candidates,
              uncertainty_reasons, selected_species_id, model_version, created_at, updated_at,
              deleted)
  ON public.recognition_records TO gengyun_api_runtime;
GRANT UPDATE (revision, candidates, uncertainty_reasons, selected_species_id, model_version,
              updated_at, deleted)
  ON public.recognition_records TO gengyun_api_runtime;

-- recognition_selections（0025）：SELECT 8 列 / INSERT 8 列；无 UPDATE、无 DELETE
-- （关系只追加：选中结果落在 recognition_records.selected_species_id 上，见 commitSelection）
GRANT SELECT (id, revision, recognition_id, owner_user_id, species_id, provenance, decided_at,
              linkage)
  ON public.recognition_selections TO gengyun_api_runtime;
GRANT INSERT (id, revision, recognition_id, owner_user_id, species_id, provenance, decided_at,
              linkage)
  ON public.recognition_selections TO gengyun_api_runtime;

-- recognition_idempotency（0025）：SELECT 6 列 / INSERT 6 列 / UPDATE 4 列 / 表级 DELETE
-- （PG 无列级 DELETE；release :819-823 与 purge :829-834 都是整行 DELETE，故只能表级授予）
GRANT SELECT (scope, key_hash, request_hash, payload, pending, expires_at)
  ON public.recognition_idempotency TO gengyun_api_runtime;
GRANT INSERT (scope, key_hash, request_hash, payload, pending, expires_at)
  ON public.recognition_idempotency TO gengyun_api_runtime;
GRANT UPDATE (request_hash, payload, pending, expires_at)
  ON public.recognition_idempotency TO gengyun_api_runtime;
GRANT DELETE ON public.recognition_idempotency TO gengyun_api_runtime;

\echo '20-login-roles.sql：已授予 public.recognition_jobs / public.recognition_records / public.recognition_selections / public.recognition_idempotency 的列级 SELECT/INSERT/UPDATE（列清单逐列反推自 recognitions/store-pg.ts；无表级 INSERT/UPDATE/TRUNCATE/REFERENCES/TRIGGER）。'
\echo '20-login-roles.sql：DELETE 仅**表级**授予 public.recognition_idempotency（PG 无列级 DELETE；jobs / records / selections 不授 DELETE —— 账号注销的内容清理只能经迁移 0034 的 SECURITY DEFINER 函数 public.purge_owner_recognitions(uuid) 以属主身份执行，本段只授该函数的 EXECUTE）。'
\echo '20-login-roles.sql：recognition_jobs / recognition_records 的 UPDATE 是业务写权限（认领、终态提交、改选），同时满足各自的 SELECT … FOR UPDATE；recognition_selections 不授 UPDATE。'

-- ----------------------------------------------------------------------------
-- K. 语音域（迁移 0026）的列级授权（R28-S38）
--
-- 为什么写在这个文件、而不是 services/api/db/roles/*.sql：
--   与 H / I / J 段同理——roles/*.sql 只在建组那一次跑，本文件每次 provision 都跑；
--   语音域的授权必须按**部署顺序**生效，所以和运行时域一起写在这里：
--   缺表硬守卫 → REVOKE ALL … FROM PUBLIC → 逐列 GRANT → 摘要。
--
-- 覆盖迁移 0026_speech_persistence.sql 的三张表（该迁移由 R28-S20 语音持久化切片引入；本片基线 fcb42e9 已含）：
--   public.speech_jobs / public.transcriptions / public.speech_idempotency
--
-- 本段是补洞：0026 只建了表，没有任何授段 ⇒ 运行时对这三表**整表零权限**，
-- store 一跑就是 42501（改前读数见 docs/verification/gy-r28-speech-grants-20261021.md）。
-- 列清单不是抄的：逐列从 services/api/src/speech/store-pg.ts 的真实语句反推：
--   * 列常量：JOB_COLUMNS :149-150（12 列）、RECORD_COLUMNS :151-152（13 列）
--   * 写入：INSERT_JOB :154-156、INSERT_RECORD :158-160
--   * 读回：getJob :460、updateJob 的 SELECT :471、commitTerminal 的 SELECT … FOR UPDATE :496-499、
--           getTranscription :541、updateTranscription 的 SELECT :553
--   * 更新：updateJob :477-484（SET revision, state, deadline_at, updated_at, error_code）、
--           commitTerminal :517-523（SET state, error_code, revision, updated_at）、
--           updateTranscription :566-576（SET revision, raw_text, uncertain_spans, confirmed_text,
--           confirmed_at, model_version, updated_at, deleted）
--   * 幂等台账：findIdempotent :601-604、claim :627-631（INSERT … ON CONFLICT (scope, key_hash)
--           DO NOTHING RETURNING scope）、finalize :641-645（SET payload, pending）、
--           release DELETE :654、purge DELETE :660-662（… RETURNING scope）
--
-- 四档粒度，逐条有据：
--   ① 读面按列：三表都没有「多读一列能省一次往返」的场合，SELECT 只给真实语句引用到的列。
--      speech_idempotency 的 SELECT 是**全部 6 列**（不是 4 列）：`WHERE scope = $1 AND key_hash = $2`
--      的过滤列、两条 DELETE 的 WHERE、claim 的 `RETURNING scope`、purge 的 `RETURNING scope`
--      都要 SELECT 权——实测只授 request_hash/payload/pending/expires_at 时，findIdempotent :601
--      与 claim :627 直接 42501（S38 证据页的矩阵实验 A/B），所以按 6 列给。
--   ② 写面按列：INSERT 给满（列常量即 INSERT 的列清单）；UPDATE 只给 SET 子句真实赋值的列。
--   ③ `SELECT … FOR UPDATE` 只在 speech_jobs :497（commitTerminal）出现，而 speech_jobs 本来就有
--      **真实**的 UPDATE 列 ⇒ 行锁由它们满足，**不**另授 I 段那种 `UPDATE (revision)` 行锁载体
--      （性质不同，别照抄 I 段那句注释）。transcriptions 没有 FOR UPDATE。
--   ④ PG 没有列级 DELETE ⇒ 表级 DELETE 只授 speech_idempotency（release / purge 是两条整行 DELETE）。
--      speech_jobs / transcriptions **不授 DELETE**：账号注销走 public.request_account_deletion()
--      （SECURITY DEFINER，以属主身份级联），两表的 owner_user_id 都是 ON DELETE CASCADE。
--   ⛔ 一律不给 TRUNCATE / REFERENCES / TRIGGER；表级 INSERT / UPDATE 一律不给
--      （speech_idempotency 的 DELETE 是本段唯一的表级写授权）。
\echo '--- K. 语音域（迁移 0026）列级授权（R28-S38）---'

-- 缺表硬前置（同 J 段）：0026 由 S20 引入、本片基线 fcb42e9 已含，三张表是硬依赖。顺序错（先跑本文件、后跑 migrate.ts）
-- 时这里直接失败，不静默放过——否则又回到「表建了、运行时零授权」那个坑。
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(t.name, ', ' ORDER BY t.name) INTO missing
    FROM unnest(ARRAY['speech_idempotency', 'speech_jobs', 'transcriptions']) AS t(name)
   WHERE to_regclass('public.' || t.name) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '缺少语音域表：%（迁移 0026 未执行；顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。', missing;
  END IF;
END;
$$;

REVOKE ALL ON TABLE public.speech_jobs,
                     public.transcriptions,
                     public.speech_idempotency
  FROM PUBLIC;

-- speech_jobs（0026）：SELECT 12 列 / INSERT 12 列 / UPDATE 5 列；无 DELETE
GRANT SELECT (id, revision, kind, owner_user_id, transcription_id, media_id, media_revision,
              state, deadline_at, created_at, updated_at, error_code)
  ON public.speech_jobs TO gengyun_api_runtime;
GRANT INSERT (id, revision, kind, owner_user_id, transcription_id, media_id, media_revision,
              state, deadline_at, created_at, updated_at, error_code)
  ON public.speech_jobs TO gengyun_api_runtime;
GRANT UPDATE (revision, state, deadline_at, updated_at, error_code)
  ON public.speech_jobs TO gengyun_api_runtime;

-- transcriptions（0026）：SELECT 13 列 / INSERT 13 列 / UPDATE 8 列；无 DELETE、无 FOR UPDATE
GRANT SELECT (id, revision, owner_user_id, media_id, media_revision, raw_text, uncertain_spans,
              confirmed_text, confirmed_at, model_version, created_at, updated_at, deleted)
  ON public.transcriptions TO gengyun_api_runtime;
GRANT INSERT (id, revision, owner_user_id, media_id, media_revision, raw_text, uncertain_spans,
              confirmed_text, confirmed_at, model_version, created_at, updated_at, deleted)
  ON public.transcriptions TO gengyun_api_runtime;
GRANT UPDATE (revision, raw_text, uncertain_spans, confirmed_text, confirmed_at, model_version,
              updated_at, deleted)
  ON public.transcriptions TO gengyun_api_runtime;

-- speech_idempotency（0026）：SELECT 6 列 / INSERT 6 列 / UPDATE 2 列 / 表级 DELETE
-- （PG 无列级 DELETE；release :654 与 purge :660-662 都是整行 DELETE，故只能表级授予）
GRANT SELECT (scope, key_hash, request_hash, payload, pending, expires_at)
  ON public.speech_idempotency TO gengyun_api_runtime;
GRANT INSERT (scope, key_hash, request_hash, payload, pending, expires_at)
  ON public.speech_idempotency TO gengyun_api_runtime;
GRANT UPDATE (payload, pending)
  ON public.speech_idempotency TO gengyun_api_runtime;
GRANT DELETE ON public.speech_idempotency TO gengyun_api_runtime;

\echo '20-login-roles.sql：已授予 public.speech_jobs / public.transcriptions / public.speech_idempotency 的列级 SELECT/INSERT/UPDATE（列清单逐列反推自 speech/store-pg.ts；无表级 INSERT/UPDATE/TRUNCATE/REFERENCES/TRIGGER）。'
\echo '20-login-roles.sql：DELETE 仅**表级**授予 public.speech_idempotency（PG 无列级 DELETE；speech_jobs / transcriptions 不授 DELETE —— 账号注销的内容清理只能经迁移 0034 的 SECURITY DEFINER 函数 public.purge_owner_speech(uuid) 以属主身份执行，段 D3 只授该函数的 EXECUTE）。'
\echo '20-login-roles.sql：speech_jobs 的 UPDATE 是业务写权限（认领、终态提交），同时满足 commitTerminal 的 SELECT … FOR UPDATE；transcriptions 不授 FOR UPDATE，speech_idempotency 的 SELECT 是全部 6 列（WHERE 与 RETURNING 需要）。'

-- ----------------------------------------------------------------------------
-- L. 触发器函数的 PUBLIC EXECUTE 兜底收回（R28-S51）
--
-- 本段只收一个函数：public.consent_policy_immutable()。它是
-- services/api/db/migrations/0009_consent_policy.sql:39 建在 consent_policies 上的
-- BEFORE UPDATE OR DELETE 触发器函数（prosecdef=false）。
--
-- 为什么必须显式写：PostgreSQL 新建函数时默认把 EXECUTE 授给 PUBLIC，pg_proc.proacl
-- IS NULL 就是"出厂默认"的物化形态；触发器函数不因"只被触发器调用"而自动豁免。
-- 本片接线前实测，它是三个 schema 里唯一仍然 proacl IS NULL（⇒ PUBLIC 可执行）的函数；
-- 对照 public.admin_audit_events_reject_mutation() 在 0017_account_suspend_authority.sql:335
-- 已显式 REVOKE … FROM PUBLIC，本文件此前却从未提及 consent_policy_immutable。
--
-- 为什么收回安全：触发器由 PostgreSQL 在执行 UPDATE/DELETE 时以触发器函数的属主语境
-- 调用，不检查**调用者**对该函数的 EXECUTE 权限；REVOKE 只挡住
-- `SELECT public.consent_policy_immutable()` 这类显式调用，不影响触发器本体。
--
-- 来源：R28-S51 的兜底断言（deploy/postgres-cvm/sql/90-assert-least-privilege.sql 的
-- runtime_function_no_public_execute）在真库上先判红，再由此处修复；改前/改后读数、
-- 变异与未取得见 docs/verification/gy-r28-function-surface-parity-20261021.md。
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.consent_policy_immutable() FROM PUBLIC;

-- ----------------------------------------------------------------------------
-- M. 媒体域（R28-W12）：public.media / public.media_derivatives 的列级授权
--
-- 为什么这两张表此前**一条运行时授权都没有**：媒体域的事实源一直是进程内登记册
-- （services/api/src/media/service.ts 的 records / grants 两个 Map，W2 的
-- docs/verification/gy-r28-w2-media-ports-20261021.md 把它记为「剩余断点：重启即丢」），
-- 从来没有 SQL 语句去过这两张表，所以 deploy 侧也就没有列级授权面。
-- services/api/db/roles/auth_privacy.sql:39 只给组 gengyun_auth_privacy 授过
-- `GRANT SELECT (owner_id) ON media` —— 那是注销/隐私域读「谁是属主」用的单列，
-- 不是媒体域的读写面。
--
-- R28-W12 把登记册换成了 PG 仓储（services/api/src/media/store-pg.ts），列清单不是抄的：
-- 逐列从该文件的真实语句反推（行号按该文件）：
--   * 读投影：MEDIA_PROJECTION :69-84 = id, owner_id, purpose::text, mime, bytes,
--             duration_ms, sha256, state::text, failure_code, object_ref_cipher, revision,
--             expires_at / created_at / updated_at（MS_SELECT 的 epoch 投影）
--   * 写入：createMedia INSERT :196-200（14 列，含 id 与 created_at/updated_at —— 属性名
--           `idempotency_keys` 之外的媒体表都不用 DEFAULT now()，时间戳由应用侧给）
--   * 更新：saveMedia UPDATE :228-232（12 列 SET；WHERE id 需要 SELECT）
--   * 计数：liveCommunityImageCount :274、countMedia :303（WHERE owner_id / purpose / state）
--   * 衍生物：SELECT :154（id, media_id, derivative_kind, object_ref_cipher）、
--           INSERT :175-178（5 列，ON CONFLICT DO UPDATE）、
--           DELETE :171 `DELETE FROM public.media_derivatives WHERE media_id = $1`
--           **实测补充**：这条 INSERT … ON CONFLICT (media_id, derivative_kind, hash) DO UPDATE
--           在 SET LOCAL ROLE gengyun_api_runtime 下最初报 `permission denied for table
--           media_derivatives` —— PostgreSQL 对 ON CONFLICT DO UPDATE 要求「被读到的列」
--           也有 SELECT（EXCLUDED 之外还要读 arbiter/hash 与 SET 的旧值）。故 SELECT 面
--           从 4 列扩到 6 列（+ hash, state）。这不是宽授：`hash` 只在冲突判定里用，
--           `state` 只在 DO UPDATE 的 SET/返回里用，两者都在 store 的写入语义内。
--   * 幂等台账：复用 0008 的 public.idempotency_keys（授权面在 auth_privacy 组，不在本段）；
--           R28-W12 的 settle 走「DELETE 占位行 + INSERT 结果行」，只用该表**已授**的
--           表级 INSERT/DELETE 与列级 (response_status, outcome) UPDATE，没有新增列需求。
--
-- 为什么 media **不授 DELETE**（而 media_derivatives 授表级 DELETE）：媒体行是审计与
-- 计费的事实，删除语义是状态机（deleting → deleted，见 media/service.ts 的 deleteMedia），
-- 由 UPDATE state 表达；对象回收是对象存储侧的事。衍生物则是媒体的从属物，重建/撤销时
-- 整行替换（ON CONFLICT DO UPDATE + 按 media_id 清空重建），因此需要表级 DELETE ——
-- PostgreSQL 没有列级 DELETE，这是唯一能表达「按 media_id 删整行」的授法。
-- ----------------------------------------------------------------------------
GRANT SELECT (id, owner_id, purpose, mime, bytes, duration_ms, sha256, state,
              failure_code, object_ref_cipher, revision, expires_at, created_at, updated_at)
  ON public.media TO gengyun_api_runtime;
GRANT INSERT (id, owner_id, purpose, mime, bytes, duration_ms, sha256, state,
              failure_code, object_ref_cipher, revision, expires_at, created_at, updated_at)
  ON public.media TO gengyun_api_runtime;
GRANT UPDATE (owner_id, purpose, mime, bytes, duration_ms, sha256, state,
              failure_code, object_ref_cipher, revision, expires_at, updated_at)
  ON public.media TO gengyun_api_runtime;

GRANT SELECT (id, media_id, derivative_kind, object_ref_cipher, hash, state)
  ON public.media_derivatives TO gengyun_api_runtime;
GRANT INSERT (media_id, derivative_kind, object_ref_cipher, hash, state)
  ON public.media_derivatives TO gengyun_api_runtime;
GRANT UPDATE (object_ref_cipher, state)
  ON public.media_derivatives TO gengyun_api_runtime;
GRANT DELETE ON public.media_derivatives TO gengyun_api_runtime;

-- M2. 待清理对象台账（迁移 0029，监工 1022-0659 轮 P1）：public.media_object_cleanup
--
-- 为什么要有这张表：媒体域的红线是「桶删除未确认 ⇒ 保留引用以便重试」，而这条红线的唯一
-- 落点原来是**父行**。CAS=0 的迟到 `complete` 一个字节都不写库（条件写 0 行），并发 `delete`
-- 又把真行的 rawRef/derivativeRef 清空 ⇒ 清理器枚举真行时根本看不到那个未确认删除的对象。
-- 台账行**先**写、**再**删桶；只有桶删除被确认成功才删这行，父行被删不级联（不建外键）。
--
-- 列清单同样逐列反推自 services/api/src/media/store-pg.ts 的真实语句：
--   * 登记（saveObjectCleanup）：INSERT :… (media_id, object_ref_cipher, object_ref_digest,
--     reason, attempts, created_at, updated_at) + `ON CONFLICT (object_ref_digest) DO UPDATE`
--     ⇒ 冲突判定列与 SET 读到的旧值列（media_id/reason/attempts）都要 SELECT；
--   * 扫描（listObjectCleanup）：SELECT media_id, object_ref_cipher, reason, attempts
--     ORDER BY created_at, object_ref_digest；
--   * 删行（deleteObjectCleanup）：`DELETE … WHERE object_ref_digest = $1 RETURNING
--     object_ref_digest` —— PG 没有列级 DELETE，只能表级授予（与 media_derivatives 同理）；
--     RETURNING 的那一列也要 SELECT。
-- 与 media 本体不同，这里的行是**可物理删的**：删掉它就是「已确认清完」的唯一表达。
-- 若这里的授权判红，先查是不是有人把「清理台账」当成了又一个只增不删的日志表。
--
-- 前置：表必须已存在（迁移 0029）。顺序是 迁移（migrate.ts up）⇒ 本脚本；缺失即显式失败，
-- 绝不留一个「看似已收敛、实际记不下清理线索」的运行态。
DO $$
BEGIN
  IF to_regclass('public.media_object_cleanup') IS NULL THEN
    RAISE EXCEPTION '缺少 public.media_object_cleanup：迁移 0029 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
END;
$$;
REVOKE ALL ON TABLE public.media_object_cleanup FROM PUBLIC;
GRANT SELECT (media_id, object_ref_cipher, object_ref_digest, reason, attempts, created_at)
  ON public.media_object_cleanup TO gengyun_api_runtime;
GRANT INSERT (media_id, object_ref_cipher, object_ref_digest, reason, attempts, created_at, updated_at)
  ON public.media_object_cleanup TO gengyun_api_runtime;
GRANT UPDATE (media_id, reason, attempts, updated_at)
  ON public.media_object_cleanup TO gengyun_api_runtime;
GRANT DELETE ON public.media_object_cleanup TO gengyun_api_runtime;

\echo '20-login-roles.sql：已授予 public.media 的列级 SELECT/INSERT/UPDATE（14/14/12 列，逐列反推自 media/store-pg.ts；无表级 INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER）。'
\echo '20-login-roles.sql：media 故意不授 DELETE —— 删除是状态机（deleting→deleted，UPDATE state），媒体行是审计与计费事实，不物理删。'
\echo '20-login-roles.sql：已授予 public.media_derivatives 的列级 SELECT/INSERT/UPDATE 与**表级** DELETE（PG 无列级 DELETE；衍生物按 media_id 整行重建，见 store-pg.ts 的 ON CONFLICT 与 delete 语句）。'
\echo '20-login-roles.sql：已授予 public.media_object_cleanup 的列级 SELECT/INSERT/UPDATE 与**表级** DELETE（PG 无列级 DELETE；删行 = 已确认清完，见 media/store-pg.ts 的 deleteObjectCleanup）。'
\echo '20-login-roles.sql：public.idempotency_keys 的媒体幂等台账授权沿用 auth_privacy 组既有面（表级 SELECT/INSERT/DELETE + 列级 response_status/outcome UPDATE），本段未新增。'

-- ----------------------------------------------------------------------------
-- M3. 审核判定台账的列级授权（R29 / 迁移 0028_moderation_persistence.sql）
--
-- 为什么这段必须真存在（监工 2026-10-22-0119 指出的「运行时授权披露缺口」的**代码**答复）：
-- `services/api/src/moderation/ledger-pg.ts` 在真实库上写两张台账表；迁移 0028 本身**只建表、
-- 零 GRANT**，运行时角色 gengyun_api_runtime 对这两张表一列都碰不了。缺本段 ⇒ 部署后写面
-- 全量 42501（fail-closed 的名字有了、库里的路没通），而内存台账/单测完全看不出来。
--
-- 列清单不是抄文档，而是**从 ledger-pg.ts 的四条语句逐列反推**，并由
-- `tests/unit/sql-column-coverage.test.mjs` 的 parseSqlText/collectRequirements 管线交叉
-- 验证（少一列立刻判红）：`:66` SUPERSEDE_SQL 的 UPDATE 2 列 + 4 列 WHERE、`:74` INSERT_SQL
-- 的 26 列 + `ON CONFLICT (job_id)`、`:89` UPDATE_SQL 的 14 列 + `WHERE job_id`、`:97`
-- WITHDRAW_SQL 的 4 列 + `ON CONFLICT (target_type,target_id,target_revision)`。
--
-- SELECT 面**只给被 WHERE / 冲突目标读到的列**（PG 的 UPDATE/DELETE 要求对 WHERE 里出现的列有
-- SELECT 权）：decisions 是 `job_id` + SUPERSEDE 的 `target_type/target_id/target_revision/
-- content_kind/superseded`，withdrawals 是三列主键。台账**只写不读**（`byJobId`/`current`/
-- `forRevision`/`history` 全部读内存 Map，模块里没有一条 SELECT 语句），所以"读台账"的列权限
-- 一列都不给；将来真加读路径，必须同时改本段与 90-assert 的 `expected`。
--
-- ⛔ DELETE / TRUNCATE / REFERENCES / TRIGGER 一律不授：台账是不可变审计面，ledger-pg.ts 里
-- 没有任何物理删除语句（下架/撤销都是 `superseded = TRUE` 的单向门）。
-- 前置：两张表必须已存在 ⇒ 顺序是 迁移（migrate.ts up）⇒ 本脚本；缺表即显式失败。
-- #region gy-r29-moderation-ledger-grant
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(t.name, ', ' ORDER BY t.name) INTO missing
    FROM unnest(ARRAY['moderation_decisions','moderation_withdrawals']) AS t(name)
   WHERE to_regclass('public.'||t.name) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '缺少审核判定台账表：%（迁移 0028_moderation_persistence.sql 未执行；顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。', missing;
  END IF;
END;
$$;
REVOKE ALL ON TABLE public.moderation_decisions, public.moderation_withdrawals FROM PUBLIC;

-- 审核判定台账（迁移 0028）：ledger-pg.ts:74 的 INSERT 26 列；SELECT 只给 WHERE/冲突目标用到的 6 列。
GRANT SELECT (job_id,target_type,target_id,target_revision,content_kind,superseded)
  ON public.moderation_decisions TO gengyun_api_runtime;
GRANT INSERT (job_id,target_type,target_id,target_revision,content_kind,port_kind,prompt_id,
              prompt_version,job_revision,state,lease_token,authorization_epoch,submitted_by,
              deadline_at,error_code,decision,reason_codes,hard_rule_passed,rule_version,
              model_version,contract_value,gate_holder,evidence,superseded,created_at,updated_at)
  ON public.moderation_decisions TO gengyun_api_runtime;
-- 写面状态机：ledger-pg.ts:89 的 UPDATE 14 列；:66 的 supersede 是其中 2 列（superseded/updated_at）。
GRANT UPDATE (state,lease_token,decision,reason_codes,hard_rule_passed,rule_version,
              model_version,prompt_version,contract_value,gate_holder,error_code,evidence,
              superseded,updated_at)
  ON public.moderation_decisions TO gengyun_api_runtime;

-- 下架台账（迁移 0028）：ledger-pg.ts:97 的 INSERT 4 列；三列主键是 ON CONFLICT 冲突目标。
GRANT SELECT (target_type,target_id,target_revision)
  ON public.moderation_withdrawals TO gengyun_api_runtime;
GRANT INSERT (target_type,target_id,target_revision,withdrawn_at)
  ON public.moderation_withdrawals TO gengyun_api_runtime;
-- #endregion gy-r29-moderation-ledger-grant

\echo '20-login-roles.sql：已授予 public.moderation_decisions / public.moderation_withdrawals 的列级 SELECT/INSERT/UPDATE（列清单逐列反推自 moderation/ledger-pg.ts；SELECT 只给 WHERE 与 ON CONFLICT 冲突目标读到的列；无表级写权限）。'
\echo '20-login-roles.sql：审核判定台账不授 DELETE（不可变审计面；ledger-pg.ts 无任何物理删除语句）。'
-- --- 后台内容/资料域（R34 · #18 · 迁移 0036）：列级 SELECT/INSERT/UPDATE ---------
-- 为什么是列级（本文件的一贯口径）：写面逐列反推自 services/api/src/admin/ops/content-pg.ts 的真实语句，
-- 只给"语句真的碰到的那几列"。实体表的 9 个 UPDATE 列全是发布/撤回的状态机字段，revisions 是纯追加
-- （无 UPDATE），幂等台账只改 request_hash/response_status/outcome/expires_at。
-- 为什么没有 DELETE/TRUNCATE/REFERENCES/TRIGGER：撤回 = lifecycle 状态位；幂等台账的 release/purge
-- 用 UPDATE 表达（到期时刻推成 '-infinity' / 把过期结果清回占位），业务上不存在"删一行内容"的操作。
-- PG 也没有列级 DELETE，一旦授出就是整表可删、不可逆 —— 本域宁可不给。
-- 注意：SELECT ... FOR UPDATE（实体快照读取）要 UPDATE 列级权限，上面的 UPDATE 清单已覆盖。
-- 前置：迁移 0036 必须先执行（缺表即显式失败，绝不留"看似收敛、点开 503"的运行态）。
-- #region gy-r34-content-grant
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(t.name, ', ' ORDER BY t.name) INTO missing
    FROM unnest(ARRAY['admin_content_entities','admin_content_revisions','admin_content_idempotency']) AS t(name)
   WHERE to_regclass('public.'||t.name) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '缺少后台内容域表：%（迁移 0036_r34_admin_content_persistence.sql 未执行；顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。', missing;
  END IF;
END;
$$;
REVOKE ALL ON TABLE public.admin_content_entities, public.admin_content_revisions,
                   public.admin_content_idempotency FROM PUBLIC;

-- 实体表（迁移 0036）：content-pg.ts 的 ENTITY_COLUMNS 是 13 列；INSERT 只写 5 列（其余是状态机默认值）。
GRANT SELECT (id,family,steward_id,lifecycle,published_revision,published_at,published_by_id,
              published_evidence_ref,published_reason,withdrawn_at,withdrawn_by_id,withdrawn_reason,created_at)
  ON public.admin_content_entities TO gengyun_api_runtime;
GRANT INSERT (id,family,steward_id,lifecycle,created_at)
  ON public.admin_content_entities TO gengyun_api_runtime;
-- 发布/撤回是唯一的两条 UPDATE（commitLifecycle 的 9 列）。
GRANT UPDATE (lifecycle,published_revision,published_at,published_by_id,published_evidence_ref,
              published_reason,withdrawn_at,withdrawn_by_id,withdrawn_reason)
  ON public.admin_content_entities TO gengyun_api_runtime;

-- 版本表（迁移 0036）：只追加，永不改写（冻结的正文快照）。
GRANT SELECT (entity_id,revision,content,author_id,derived_from_revision,created_at)
  ON public.admin_content_revisions TO gengyun_api_runtime;
GRANT INSERT (entity_id,revision,content,author_id,derived_from_revision,created_at)
  ON public.admin_content_revisions TO gengyun_api_runtime;

-- 幂等台账（迁移 0036）：形状照 favorites_idempotency（0018）；无 DELETE，释放/清理都走 UPDATE。
GRANT SELECT (scope,key_hash,request_hash,response_status,outcome,expires_at)
  ON public.admin_content_idempotency TO gengyun_api_runtime;
GRANT INSERT (scope,key_hash,request_hash,response_status,outcome,expires_at)
  ON public.admin_content_idempotency TO gengyun_api_runtime;
GRANT UPDATE (request_hash,response_status,outcome,expires_at)
  ON public.admin_content_idempotency TO gengyun_api_runtime;
-- #endregion gy-r34-content-grant

\echo '20-login-roles.sql：已授予 public.admin_content_entities（13/5/9 列）、public.admin_content_revisions（6/6/0 列）、public.admin_content_idempotency（6/6/4 列）的列级 SELECT/INSERT/UPDATE（逐列反推自 admin/ops/content-pg.ts；无表级 DML、无 INSERT/UPDATE 的表级授权）。'
\echo '20-login-roles.sql：后台内容域不授 DELETE —— 撤回是 lifecycle 状态位，幂等台账的释放/清理走 UPDATE（PG 无列级 DELETE，授出即整表可删）。'

-- ---------------------------------------------------------------------------
-- 后台分类字典（R68）：public.admin_categories（迁移 0049）
--
-- 为什么是**列级**而不是表级：运行时只需要"读整行目录 + 改 5 列"，表级 GRANT 会顺带
-- 允许它改 `type`（种类闭集，契约明写"新增覆盖/种类必须另行来源与评估，不由编辑名称扩大识别承诺"）
-- 和 `created_at`（审计性的建行时刻）。列级授权把这两列钉死在"运行时改不了"。
--
-- 为什么**没有 INSERT / DELETE**：契约这两个 operation 里没有"新建分类"和"删除分类"——
-- `CategoryInput` 只有 name/description/active，`id` 与 `type` 来自迁移 0049 的**一次性回填**
-- （从 public.crops / public.species 单向搬一遍）。授出 INSERT 等于开一条契约之外的长目录通道；
-- 授出 DELETE 等于让后台能删掉识别键（且 PG 没有列级 DELETE，授出即整表可删）。
--
-- 为什么 UPDATE 里有 `revision` / `updated_at`：CAS 的语义就是"读到的修订号 +1"与"记录本次改动
-- 时刻"，两者都是 `UPDATE … SET name = $3, description = $4, active = $5, revision = revision + 1,
-- updated_at = now() WHERE id = $1 AND revision = $2` 这一条语句的组成部分
-- （见 services/api/src/admin/ops/categories-pg.ts 的 ADMIN_CATEGORY_SQL.commit）。
-- `id` 在 SELECT 清单里：它既是 CAS 的定位列，也是返回给调用方的游标位。
--
-- 审计：运行时对 public.admin_audit_events 仍是**零表级/零列级权限**，唯一写路径是迁移 0049 的
-- 窄口径 SECURITY DEFINER 函数 public.record_admin_category_update(...)，因此下面只授它的 EXECUTE。
--
-- 前置：迁移 0049 必须先执行（缺表/缺函数即显式失败，绝不留"看似收敛、点开 503"的运行态）。
-- #region gy-r68-catalog-grant
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(t.name, ', ' ORDER BY t.name) INTO missing
    FROM unnest(ARRAY['admin_categories']) AS t(name)
   WHERE to_regclass('public.'||t.name) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '缺少后台分类字典表：%（迁移 0049_admin_categories.sql 未执行；顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。', missing;
  END IF;
  IF to_regprocedure('public.record_admin_category_update(uuid,text,integer,uuid)') IS NULL THEN
    RAISE EXCEPTION '缺少 public.record_admin_category_update(uuid,text,integer,uuid)：迁移 0049_admin_categories.sql 未执行（顺序必须是 migrate.ts up ⇒ 20-login-roles.sql）。';
  END IF;
END;
$$;
REVOKE ALL ON TABLE public.admin_categories FROM PUBLIC;

-- 读面：categories-pg.ts 的 ADMIN_CATEGORY_SQL.list 只取这 6 列（契约 Category 的 6 个字段）。
GRANT SELECT (id,revision,type,name,description,active)
  ON public.admin_categories TO gengyun_api_runtime;
-- 写面：只有一条 CAS UPDATE（name/description/active + revision/updated_at）；无 INSERT、无 DELETE。
GRANT UPDATE (name,description,active,revision,updated_at)
  ON public.admin_categories TO gengyun_api_runtime;

-- 审计落库的**唯一**通道：迁移 0049 的 SECURITY DEFINER 窄函数（函数内固定
-- action='category.update' / scope='sources:write' / result='accepted'，并由形参重建 target_hint）。
REVOKE ALL ON FUNCTION public.record_admin_category_update(uuid, text, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_admin_category_update(uuid, text, integer, uuid) TO gengyun_api_runtime;
-- #endregion gy-r68-catalog-grant

\echo '20-login-roles.sql：已授予 public.admin_categories（6/0/5 列）的列级 SELECT/UPDATE 与 public.record_admin_category_update(uuid,text,integer,uuid) 的 EXECUTE（逐列反推自 admin/ops/categories-pg.ts；无表级 DML、无 INSERT/DELETE）。'
\echo '20-login-roles.sql：后台分类字典不授 INSERT/DELETE —— 契约没有"新建/删除分类"，目录由迁移 0049 从 crops/species 一次性回填。'
