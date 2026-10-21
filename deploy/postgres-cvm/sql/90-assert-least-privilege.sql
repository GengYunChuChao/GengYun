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
-- 输出约定：**最后一行**是判决，且判决只可能是两种形态之一。
--   ok                  —— 全部断言通过
--   FAIL: <标签> (<说明>); ... —— 未通过项明细（顺序即修复顺序）
-- 任何断言为 NULL 也按未通过处理（NULL 视为“无法证明”）。
-- R28-S33 起**退出码是主判据**：有断言未通过时，判决行之后（本文件末尾）的 DO 块
-- RAISE EXCEPTION，psql 因 `-v ON_ERROR_STOP=1` 以非零（3）退出；全绿时 DO 块静默，
-- 末行 `ok`、退出码 0。调用方 provision-db.sh 现在同时判退出码与末行文本（文本保留为
-- 可读兜底，也兼容人工 `psql -f`）。R28-S33 之前这里只有文本判决，psql 恒以 0 退出。
-- 判决之前允许出现信息行：本文件自己不以 `\echo` 报读数，但 20-login-roles.sql 段尾的
-- 授权摘要会打印在判决之前，探针段内的 42501 也会被 psql 原样打印（ON_ERROR_STOP=0 是设计的一部分）。
-- R28-S24 更正：旧版这里写「只打印一行」，实际上补授权后新增的 `\echo` 信息行打破了
-- 这个字面说法；语义约定本来就是“最后一行是判决”，这里按真实约定改写。
-- R28-S28 更正：S24 的 recognition_* 软守卫（本文件曾经唯一的一处“信息行”）已随本片
-- 收敛为硬前置（manifest required=true + 20-login-roles.sql 段 J 的缺表硬守卫），
-- 本文件不再有软提示，真实约定只有一句：**最后一行是判决**。
-- R28-S33 补充：末行判决保留，但**不再是唯一判据**（退出码见上）。实现上先把 checks 的
-- 结果存进会话级临时表 `r28_assert_results`（整棵 CTE 只求值一次），判决行与 DO 块都读它；
-- 临时表随会话销毁，不落库、不改任何权限，仍是「只报不改」。
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

-- --- R28-S24 真执行探针（零行、零改动） ---------------------------------------
-- 为什么必须「真跑」而不只是 has_*_privilege：
--   * PostgreSQL **没有列级 DELETE**，所以四张表的 DELETE 只能表级授予。
--     has_table_privilege 能回答“有没有这个权限位”，但回答不了“运行时实际的语句
--     形状能不能跑通”——后者才是部署后真正会发生的事。
--   * 反过来，列级 SELECT 的“能读”也不等价于 has_table_privilege（后者对列级授权
--     返回 false）。所以读面用 `SELECT <列> FROM <表> LIMIT 0` 真执行一次。
--   * 探针语句一律零行（DELETE … WHERE false / SELECT … LIMIT 0）：PG 在**执行器
--     启动时**做权限检查（缺权照样 42501），但零行不触发 NOT NULL/FK/CHECK，
--     也不会改动任何数据。
--   * 每条探针之后立刻用 psql 内建变量 :ERROR 记录“刚才那条是否失败”
--     （false=成功、true=失败），再 ROLLBACK TO SAVEPOINT：某条失败不会把事务拖成
--     25P02，后面的探针仍各自独立求值。整段结束 ROLLBACK ⇒ 库内零改动。
--   * 若这些变量缺失（例如本段被误删），下面引用它们的断言会因 :'var' 未展开而直接
--     语法错误 ⇒ 大声失败，而不是静默放过。
\set ON_ERROR_STOP off
BEGIN;
SET LOCAL ROLE gengyun_api_runtime;
\set r28_probe_role :ERROR

-- 表级 DELETE：只允许四张表（idempotency_keys 为既有豁免，另三张见 20-login-roles.sql 段 H）
SAVEPOINT r28_probe;
DELETE FROM public.idempotency_keys WHERE false;
\set r28_probe_del_idempotency_keys :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
DELETE FROM public.community_likes WHERE false;
\set r28_probe_del_community_likes :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
DELETE FROM public.community_idempotency WHERE false;
\set r28_probe_del_community_idempotency :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
DELETE FROM public.ocr_idempotency WHERE false;
\set r28_probe_del_ocr_idempotency :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

-- 列级读面：逐表跑一次零行 SELECT（列清单 = 授权清单里的 SELECT 列）
SAVEPOINT r28_probe;
SELECT id, revision, owner_id, type, target_ref, read_at, created_at, event_key
  FROM public.messages LIMIT 0;
\set r28_probe_sel_messages :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
SELECT id, author_id, revision, title, body, crop_id, region_code, media_ids,
       linked_knowledge_type, linked_knowledge_id, linked_knowledge_revision,
       visibility, audit_state, created_at, updated_at
  FROM public.community_posts LIMIT 0;
\set r28_probe_sel_community_posts :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
SELECT id, post_id, author_id, revision, body, visibility, audit_state, created_at
  FROM public.community_comments LIMIT 0;
\set r28_probe_sel_community_comments :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
SELECT target_type, target_id, user_id
  FROM public.community_likes LIMIT 0;
\set r28_probe_sel_community_likes :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
SELECT id, revision, reporter_id, target_type, target_id, target_revision,
       state, reason_code, detail, created_at
  FROM public.community_reports LIMIT 0;
\set r28_probe_sel_community_reports :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
SELECT target_type, target_id, target_revision, id, decision, reason_codes,
       hard_rule_passed, rule_version, text_digest, contract_complete,
       missing_contract_fields, created_at
  FROM public.community_moderation_decisions LIMIT 0;
\set r28_probe_sel_community_moderation_decisions :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
SELECT scope, key_hash, request_hash, response_status, outcome, expires_at
  FROM public.community_idempotency LIMIT 0;
\set r28_probe_sel_community_idempotency :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
SELECT id, revision, kind, owner_user_id, ocr_id, media_id, media_revision,
       state, deadline_at, created_at, updated_at, error_code
  FROM public.ocr_jobs LIMIT 0;
\set r28_probe_sel_ocr_jobs :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
SELECT id, revision, owner_user_id, media_id, media_revision, raw_fields,
       corrected_fields, verification, model_version, created_at, updated_at, deleted
  FROM public.ocr_records LIMIT 0;
\set r28_probe_sel_ocr_records :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
SELECT scope, key_hash, request_hash, payload, pending, expires_at
  FROM public.ocr_idempotency LIMIT 0;
\set r28_probe_sel_ocr_idempotency :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

ROLLBACK;
\set ON_ERROR_STOP on
-- --- 探针结束 -----------------------------------------------------------------
-- --- R28-S26 真执行探针（收藏／历史／对话域：迁移 0013 / 0018）--------------------
-- 与上面 S24 段同形：关掉 ON_ERROR_STOP → BEGIN → SET LOCAL ROLE → 逐条
-- SAVEPOINT / 语句 / 记 :ERROR / ROLLBACK TO SAVEPOINT → 最后 ROLLBACK。
-- 每条语句都是零行（WHERE false / LIMIT 0），失败只留 :ERROR = 'true'，不写任何数据。
-- 为什么不能只靠 has_column_privilege：列级授权下它只回答位，不回答「语句真能跑」；
-- FOR UPDATE 的行锁权、ON CONFLICT 的冲突判定、RETURNING 的读权都只有真执行才暴露。
\set ON_ERROR_STOP off
BEGIN;
SET LOCAL ROLE gengyun_api_runtime;
\set r28_probe_fh_role :ERROR

-- favorites（0018）
SAVEPOINT r28_probe;
SELECT id, owner_id, target_type, target_id, target_revision, revision, created_at
  FROM public.favorites LIMIT 0;
\set r28_probe_fav_sel :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
INSERT INTO public.favorites (id, owner_id, target_type, target_id, target_revision, revision, created_at)
SELECT gen_random_uuid(), gen_random_uuid(), 'species', 'probe', 1, 1, now() WHERE false
ON CONFLICT DO NOTHING RETURNING id;
\set r28_probe_fav_ins :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
SELECT id, owner_id, target_type, target_id, target_revision, revision, created_at
  FROM public.favorites WHERE false FOR UPDATE;
\set r28_probe_fav_lock :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
DELETE FROM public.favorites WHERE false RETURNING id;
\set r28_probe_fav_del :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

-- history（0018）
SAVEPOINT r28_probe;
SELECT id, owner_id, kind, target_type, target_id, target_revision, revision,
       job_id, job_state, event_key, created_at
  FROM public.history LIMIT 0;
\set r28_probe_hist_sel :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
INSERT INTO public.history (id, owner_id, kind, target_type, target_id, target_revision, revision,
                            job_id, job_state, event_key, created_at)
SELECT gen_random_uuid(), gen_random_uuid(), 'recognition', 'species', 'probe', 1, 1,
       'probe', 'queued', 'probe', now() WHERE false
ON CONFLICT DO NOTHING RETURNING id;
\set r28_probe_hist_ins :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
SELECT id, owner_id, kind, target_type, target_id, target_revision, revision,
       job_id, job_state, event_key, created_at
  FROM public.history WHERE false FOR UPDATE;
\set r28_probe_hist_lock :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
DELETE FROM public.history WHERE false RETURNING id;
\set r28_probe_hist_del :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

-- favorites_idempotency（0018）
SAVEPOINT r28_probe;
SELECT scope, key_hash, request_hash, response_status, outcome, expires_at
  FROM public.favorites_idempotency LIMIT 0;
\set r28_probe_fidem_sel :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
INSERT INTO public.favorites_idempotency (scope, key_hash, request_hash, response_status, outcome, expires_at)
SELECT 'probe', 'probe', 'probe', 200, NULL, now() WHERE false
ON CONFLICT (scope, key_hash) DO UPDATE
   SET request_hash = EXCLUDED.request_hash,
       response_status = EXCLUDED.response_status,
       outcome = NULL,
       expires_at = EXCLUDED.expires_at
 WHERE public.favorites_idempotency.expires_at <= now()
RETURNING scope;
\set r28_probe_fidem_ins :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
UPDATE public.favorites_idempotency
   SET outcome = '{}'::jsonb, response_status = 200
 WHERE false AND outcome IS NULL
RETURNING scope;
\set r28_probe_fidem_upd :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
DELETE FROM public.favorites_idempotency WHERE false AND expires_at <= now() RETURNING scope;
\set r28_probe_fidem_del :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

-- history_idempotency（0018）
SAVEPOINT r28_probe;
SELECT scope, key_hash, request_hash, response_status, outcome, expires_at
  FROM public.history_idempotency LIMIT 0;
\set r28_probe_hidem_sel :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
INSERT INTO public.history_idempotency (scope, key_hash, request_hash, response_status, outcome, expires_at)
SELECT 'probe', 'probe', 'probe', 200, NULL, now() WHERE false
ON CONFLICT (scope, key_hash) DO UPDATE
   SET request_hash = EXCLUDED.request_hash,
       response_status = EXCLUDED.response_status,
       outcome = NULL,
       expires_at = EXCLUDED.expires_at
 WHERE public.history_idempotency.expires_at <= now()
RETURNING scope;
\set r28_probe_hidem_ins :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
UPDATE public.history_idempotency
   SET outcome = '{}'::jsonb, response_status = 200
 WHERE false AND outcome IS NULL
RETURNING scope;
\set r28_probe_hidem_upd :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
DELETE FROM public.history_idempotency WHERE false AND expires_at <= now() RETURNING scope;
\set r28_probe_hidem_del :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

-- conversations（0013）
SAVEPOINT r28_probe;
SELECT id, owner_id, revision, conditions, created_at, updated_at
  FROM public.conversations LIMIT 0;
\set r28_probe_conv_sel :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
INSERT INTO public.conversations (id, owner_id, revision, conditions, created_at, updated_at)
SELECT gen_random_uuid(), gen_random_uuid(), 1, NULL, now(), now() WHERE false
RETURNING id;
\set r28_probe_conv_ins :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
SELECT id, owner_id, revision, conditions, created_at, updated_at
  FROM public.conversations WHERE false FOR UPDATE;
\set r28_probe_conv_lock :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
DELETE FROM public.conversations WHERE false RETURNING id;
\set r28_probe_conv_del :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

-- conversation_turns（0013）
SAVEPOINT r28_probe;
SELECT id, conversation_id, owner_id, revision, input_text, transcription_ref,
       job_id, job_state, job_deadline_at, job_created_at, job_error_code, answer_id,
       created_at, updated_at
  FROM public.conversation_turns LIMIT 0;
\set r28_probe_turn_sel :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
INSERT INTO public.conversation_turns (id, conversation_id, owner_id, revision, input_text,
                                       transcription_ref, job_id, job_state, job_deadline_at,
                                       job_created_at, job_error_code, created_at, updated_at)
SELECT gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 'probe',
       NULL, gen_random_uuid(), 'queued', now(), now(), NULL, now(), now() WHERE false
RETURNING id;
\set r28_probe_turn_ins :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
UPDATE public.conversation_turns
   SET job_state = 'running', revision = revision + 1, updated_at = now()
 WHERE false AND job_state = 'queued'
RETURNING id;
\set r28_probe_turn_upd :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
UPDATE public.conversation_turns
   SET job_state = 'succeeded', job_error_code = NULL, answer_id = COALESCE(NULL::uuid, answer_id),
       revision = revision + 1, updated_at = now()
 WHERE false AND job_state IN ('queued', 'running')
RETURNING id;
\set r28_probe_turn_settle :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
SELECT id FROM public.conversation_turns WHERE false FOR UPDATE;
\set r28_probe_turn_lock :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
DELETE FROM public.conversation_turns WHERE false RETURNING id;
\set r28_probe_turn_del :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

-- conversation_answers（0013）：只探读与写；不改不删（行只随 turn 级联消失）
SAVEPOINT r28_probe;
SELECT id, turn_id, owner_id, revision, status, checked_text, check_state, citations,
       dose_cards, model_version, prompt_version, rule_version, created_at, updated_at
  FROM public.conversation_answers LIMIT 0;
\set r28_probe_ans_sel :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
INSERT INTO public.conversation_answers (id, turn_id, owner_id, revision, status, checked_text,
                                         check_state, citations, dose_cards, model_version,
                                         prompt_version, rule_version, created_at, updated_at)
SELECT gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 'answered', 'probe',
       'passed', '[]'::jsonb, '[]'::jsonb, 'probe', 'probe', 'probe', now(), now() WHERE false
RETURNING id;
\set r28_probe_ans_ins :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

ROLLBACK;
\set ON_ERROR_STOP on
-- --- R28-S26 探针结束 ----------------------------------------------------------

-- --- R28-S28 真执行探针（识别域四表：迁移 0025；真行、零残留）------------------
-- 与上面两段同一范式（BEGIN → SET LOCAL ROLE → 每条 SAVEPOINT → 最后 ROLLBACK），
-- 差异只有一处：**读之外还写真行**。0025 的 CHECK 与外键只有真行才会被求值
-- （kind='recognition'、candidates/uncertainty_reasons 必须是 jsonb 数组、
-- selected_species_id/species_id 长度 1..80、provenance ∈ human|manual_override|preset_demo、
-- linkage 必须是 jsonb 对象、owner_user_id 与 recognition_id 两个外键），而
-- `ON CONFLICT … DO UPDATE` 也只有在**真冲突**时才走 UPDATE 分支。所以：
--   * INSERT 插真行，证明 CHECK / 外键 / 冲突分支与运行时权限同时成立；
--   * UPDATE 打真行（`WHERE id = … AND revision = 1`，与 store 的 CAS 形状一致）；
--   * `SELECT … FOR UPDATE` 锁真行（jobs 见 store-pg.ts:613 认领、records 见 :708 终态提交）；
--   * 两条 DELETE 真删探针行（release 删 pending 行、purge 删过期行）；
--   * 最后整体 ROLLBACK：探针属主与四个探针行都不会留下。
-- 行 id 用固定的探针 UUID（28a28a28-…，本片专用前缀），不靠 `\gset` 回读：这样即使某条
-- INSERT 失败，后面的 UPDATE / FOR UPDATE / DELETE 仍是**合法 SQL**，失败只记在各自的
-- 探针变量上，不会退化成语法错误掩盖真实读数。（实测：失败语句后的 `\gset` 会被跳过、
-- 脚本继续；零行结果 `\gset` 反而会记一次 psql 错误 ⇒ 这里只在必然返回一行处用 `\gset` 去噪。）
\set ON_ERROR_STOP off
BEGIN;

-- 探针属主：以属主身份插（运行时对 users 只有列级 SELECT/INSERT，不在识别域授权面内）。
-- ON CONFLICT 只为重复执行/上次异常中断后仍能跑；正常路径不会命中。
INSERT INTO public.users (id)
VALUES ('28a28a28-0000-4000-8000-000000000000'::uuid)
ON CONFLICT (id) DO NOTHING;

SET LOCAL ROLE gengyun_api_runtime;
\set r28_probe_rec_role :ERROR

-- [1] recognition_jobs SELECT 12 列（store-pg.ts:576 getJob / :587 updateJob 读回）
SAVEPOINT r28_probe_rec;
SELECT id, revision, kind, owner_user_id, recognition_id, media_id, media_revision,
       state, deadline_at, created_at, updated_at, error_code
  FROM public.recognition_jobs
 WHERE id = '28a28a28-0001-4000-8000-000000000001'::uuid;
\set r28_probe_rec_job_sel :ERROR
ROLLBACK TO SAVEPOINT r28_probe_rec;

-- [2] recognition_jobs INSERT 12 列 + RETURNING id（store-pg.ts:184-186）：真行，保留到段末
SAVEPOINT r28_probe_rec;
INSERT INTO public.recognition_jobs
       (id, revision, kind, owner_user_id, recognition_id, media_id, media_revision,
        state, deadline_at, created_at, updated_at, error_code)
VALUES ('28a28a28-0001-4000-8000-000000000001'::uuid, 1, 'recognition',
        '28a28a28-0000-4000-8000-000000000000'::uuid,
        '28a28a28-0002-4000-8000-000000000002'::uuid,
        '28a28a28-0011-4000-8000-000000000011'::uuid, 1, 'queued',
        now() + interval '10 minutes', now(), now(), NULL)
RETURNING id \gset
\set r28_probe_rec_job_ins :ERROR
\if :r28_probe_rec_job_ins
ROLLBACK TO SAVEPOINT r28_probe_rec;
\else
RELEASE SAVEPOINT r28_probe_rec;
\endif

-- [3] recognition_jobs UPDATE 真行（store-pg.ts:592-601：SET 5 列，WHERE id + revision）
SAVEPOINT r28_probe_rec;
UPDATE public.recognition_jobs
   SET revision = revision + 1, state = 'succeeded', deadline_at = deadline_at,
       updated_at = now(), error_code = NULL
 WHERE id = '28a28a28-0001-4000-8000-000000000001'::uuid
   AND revision = 1
RETURNING id \gset
\set r28_probe_rec_job_upd :ERROR
ROLLBACK TO SAVEPOINT r28_probe_rec;

-- [4] recognition_jobs SELECT … FOR UPDATE 真行（store-pg.ts:613）
SAVEPOINT r28_probe_rec;
SELECT id FROM public.recognition_jobs
 WHERE id = '28a28a28-0001-4000-8000-000000000001'::uuid
   FOR UPDATE \gset
\set r28_probe_rec_job_lock :ERROR
ROLLBACK TO SAVEPOINT r28_probe_rec;

-- [5] recognition_records SELECT 12 列（store-pg.ts:656-658 getRecognition / :668 读回）
SAVEPOINT r28_probe_rec;
SELECT id, revision, owner_user_id, media_id, media_revision, candidates,
       uncertainty_reasons, selected_species_id, model_version, created_at, updated_at, deleted
  FROM public.recognition_records
 WHERE id = '28a28a28-0002-4000-8000-000000000002'::uuid;
\set r28_probe_rec_rec_sel :ERROR
ROLLBACK TO SAVEPOINT r28_probe_rec;

-- [6] recognition_records INSERT 12 列 + RETURNING id（store-pg.ts:188-190）：真行
SAVEPOINT r28_probe_rec;
INSERT INTO public.recognition_records
       (id, revision, owner_user_id, media_id, media_revision, candidates,
        uncertainty_reasons, selected_species_id, model_version, created_at, updated_at, deleted)
VALUES ('28a28a28-0002-4000-8000-000000000002'::uuid, 1,
        '28a28a28-0000-4000-8000-000000000000'::uuid,
        '28a28a28-0011-4000-8000-000000000011'::uuid, 1,
        '[]'::jsonb, '[]'::jsonb, NULL, 'r28-s28-probe', now(), now(), false)
RETURNING id \gset
\set r28_probe_rec_rec_ins :ERROR
\if :r28_probe_rec_rec_ins
ROLLBACK TO SAVEPOINT r28_probe_rec;
\else
RELEASE SAVEPOINT r28_probe_rec;
\endif

-- [7] recognition_records UPDATE 真行（store-pg.ts:676-698：SET 7 列，WHERE id + revision）
SAVEPOINT r28_probe_rec;
UPDATE public.recognition_records
   SET revision = revision + 1, candidates = candidates,
       uncertainty_reasons = uncertainty_reasons, selected_species_id = NULL,
       model_version = model_version, updated_at = now(), deleted = false
 WHERE id = '28a28a28-0002-4000-8000-000000000002'::uuid
   AND revision = 1
RETURNING id \gset
\set r28_probe_rec_rec_upd :ERROR
ROLLBACK TO SAVEPOINT r28_probe_rec;

-- [8] recognition_records SELECT … FOR UPDATE 真行（store-pg.ts:708）
SAVEPOINT r28_probe_rec;
SELECT id FROM public.recognition_records
 WHERE id = '28a28a28-0002-4000-8000-000000000002'::uuid
   FOR UPDATE \gset
\set r28_probe_rec_rec_lock :ERROR
ROLLBACK TO SAVEPOINT r28_probe_rec;

-- [9] recognition_selections SELECT 8 列（store-pg.ts:762-767 listSelections）
SAVEPOINT r28_probe_rec;
SELECT id, revision, recognition_id, owner_user_id, species_id, provenance, decided_at, linkage
  FROM public.recognition_selections
 WHERE recognition_id = '28a28a28-0002-4000-8000-000000000002'::uuid
   AND owner_user_id = '28a28a28-0000-4000-8000-000000000000'::uuid
 ORDER BY decided_at, id;
\set r28_probe_rec_sel_sel :ERROR
ROLLBACK TO SAVEPOINT r28_probe_rec;

-- [10] recognition_selections INSERT 8 列 + RETURNING 8 列（store-pg.ts:192-194）：真行
SAVEPOINT r28_probe_rec;
INSERT INTO public.recognition_selections
       (id, revision, recognition_id, owner_user_id, species_id, provenance, decided_at, linkage)
VALUES ('28a28a28-0003-4000-8000-000000000003'::uuid, 1,
        '28a28a28-0002-4000-8000-000000000002'::uuid,
        '28a28a28-0000-4000-8000-000000000000'::uuid,
        'probe-species', 'human', now(), '{}'::jsonb)
RETURNING id \gset
\set r28_probe_rec_sel_ins :ERROR
\if :r28_probe_rec_sel_ins
ROLLBACK TO SAVEPOINT r28_probe_rec;
\else
RELEASE SAVEPOINT r28_probe_rec;
\endif

-- [11] recognition_idempotency SELECT 4 列（store-pg.ts:216-218 SELECT_IDEMPOTENT）
SAVEPOINT r28_probe_rec;
SELECT request_hash, payload, pending, expires_at
  FROM public.recognition_idempotency
 WHERE scope = 'r28-s28-probe:claim' AND key_hash = 'claim';
\set r28_probe_rec_idem_sel :ERROR
ROLLBACK TO SAVEPOINT r28_probe_rec;

-- [12] purge：种子过期行 + DELETE … WHERE expires_at <= now() RETURNING（store-pg.ts:829-834）
--      先跑 purge、后种 claim 的过期行，是为了让这条 DELETE 只命中本探针那一行：
--      `RETURNING scope` 配 `\gset` 需要恰好一行（多行会记一次 psql 错误，污染读数）。
SAVEPOINT r28_probe_rec;
INSERT INTO public.recognition_idempotency
       (scope, key_hash, request_hash, payload, pending, expires_at)
VALUES ('r28-s28-probe:purge', 'purge', 'seed', '{}'::jsonb, false,
        now() - interval '1 hour');
DELETE FROM public.recognition_idempotency
 WHERE expires_at <= now()
RETURNING scope \gset
\set r28_probe_rec_idem_purge :ERROR
ROLLBACK TO SAVEPOINT r28_probe_rec;

-- [13] claim：先种一行过期占位（保留），再走真冲突的 ON CONFLICT DO UPDATE
--      （store-pg.ts:206-214；WHERE public.recognition_idempotency.expires_at <= $5 读旧值）
SAVEPOINT r28_probe_rec;
INSERT INTO public.recognition_idempotency
       (scope, key_hash, request_hash, payload, pending, expires_at)
VALUES ('r28-s28-probe:claim', 'claim', 'seed', '{}'::jsonb, true,
        now() - interval '2 hours');
\set r28_probe_rec_idem_seed :ERROR
\if :r28_probe_rec_idem_seed
ROLLBACK TO SAVEPOINT r28_probe_rec;
\else
RELEASE SAVEPOINT r28_probe_rec;
\endif

SAVEPOINT r28_probe_rec;
INSERT INTO public.recognition_idempotency
       (scope, key_hash, request_hash, payload, pending, expires_at)
VALUES ('r28-s28-probe:claim', 'claim', 'claim-2', '{"probe":true}'::jsonb, true,
        now() + interval '1 hour')
    ON CONFLICT (scope, key_hash) DO UPDATE
       SET request_hash = EXCLUDED.request_hash,
           payload = EXCLUDED.payload,
           pending = EXCLUDED.pending,
           expires_at = EXCLUDED.expires_at
     WHERE public.recognition_idempotency.expires_at <= now()
RETURNING scope \gset
\set r28_probe_rec_idem_claim :ERROR
ROLLBACK TO SAVEPOINT r28_probe_rec;

-- [14] complete：同键再走一次 DO UPDATE，SET 4 列 + pending=false（store-pg.ts:221-227）
SAVEPOINT r28_probe_rec;
INSERT INTO public.recognition_idempotency
       (scope, key_hash, request_hash, payload, pending, expires_at)
VALUES ('r28-s28-probe:claim', 'claim', 'claim-3', '{"probe":"done"}'::jsonb, false,
        now() + interval '1 hour')
    ON CONFLICT (scope, key_hash) DO UPDATE
       SET request_hash = EXCLUDED.request_hash,
           payload = EXCLUDED.payload,
           pending = EXCLUDED.pending,
           expires_at = EXCLUDED.expires_at
     WHERE public.recognition_idempotency.expires_at <= now();
\set r28_probe_rec_idem_complete :ERROR
ROLLBACK TO SAVEPOINT r28_probe_rec;

-- [15] release：种子 pending=true + 整行 DELETE（store-pg.ts:819-823）
SAVEPOINT r28_probe_rec;
INSERT INTO public.recognition_idempotency
       (scope, key_hash, request_hash, payload, pending, expires_at)
VALUES ('r28-s28-probe:release', 'release', 'seed', '{}'::jsonb, true,
        now() + interval '1 hour');
DELETE FROM public.recognition_idempotency
 WHERE scope = 'r28-s28-probe:release' AND key_hash = 'release' AND pending;
\set r28_probe_rec_idem_release :ERROR
ROLLBACK TO SAVEPOINT r28_probe_rec;

-- --- 禁止面：这些语句必须**恰好** 42501（R28-S28 不授予）------------------------
-- selections 不授 UPDATE ⇒ FOR UPDATE（行锁载体）也拿不到；DELETE 四表一个都不授，
-- 注销清理由 request_account_deletion() 以属主身份级联完成（owner_user_id ON DELETE CASCADE）。
SAVEPOINT r28_probe_rec;
SELECT id FROM public.recognition_selections
 WHERE id = '28a28a28-0003-4000-8000-000000000003'::uuid
   FOR UPDATE;
\set r28_probe_rec_sel_lock_forbidden :ERROR
ROLLBACK TO SAVEPOINT r28_probe_rec;

SAVEPOINT r28_probe_rec;
DELETE FROM public.recognition_jobs
 WHERE id = '28a28a28-0001-4000-8000-000000000001'::uuid;
\set r28_probe_rec_job_del_forbidden :ERROR
ROLLBACK TO SAVEPOINT r28_probe_rec;

SAVEPOINT r28_probe_rec;
DELETE FROM public.recognition_records
 WHERE id = '28a28a28-0002-4000-8000-000000000002'::uuid;
\set r28_probe_rec_rec_del_forbidden :ERROR
ROLLBACK TO SAVEPOINT r28_probe_rec;

SAVEPOINT r28_probe_rec;
DELETE FROM public.recognition_selections
 WHERE id = '28a28a28-0003-4000-8000-000000000003'::uuid;
\set r28_probe_rec_sel_del_forbidden :ERROR
ROLLBACK TO SAVEPOINT r28_probe_rec;

ROLLBACK;
\set ON_ERROR_STOP on
-- --- R28-S28 探针结束 ----------------------------------------------------------

-- --- R28-S38 真执行探针（语音域三表：迁移 0026；真行、零残留）------------------
-- 与 S28 段同一范式（BEGIN → SET LOCAL ROLE → 每条 SAVEPOINT → 最后 ROLLBACK），
-- 差异只在表：0026 的 speech_jobs / transcriptions / speech_idempotency。
-- 为什么必须真行：0026 的 CHECK 与外键只有真行才会被求值（kind='transcription'、
-- raw_text ≤ 8000 码点、uncertain_spans 必须是 jsonb 数组、payload 必须是 jsonb 对象、
-- state 是 0001 的 job_state 枚举、owner_user_id 外键），而
-- `ON CONFLICT (scope, key_hash) DO NOTHING` 也只有在**真冲突**时才走冲突分支——
-- claim 的 `RETURNING scope` 还会在冲突分支上要求 SELECT 权，这是 4 列 vs 6 列的要害。
--   * INSERT 插真行，证明 CHECK / 外键 / 冲突分支与运行时权限同时成立；
--   * UPDATE 打真行（`WHERE id = … AND revision = 1`，与 store 的 CAS 形状一致）；
--   * `SELECT … FOR UPDATE` 锁真行（speech_jobs 的终态提交）；
--   * DELETE 真删探针行（release 按 (scope, key_hash)、purge 按过期）；
--   * 最后整体 ROLLBACK：探针属主与全部探针行都不会留下。
-- 行 id 用固定的探针 UUID（38a38a38-…，S38 专用前缀），不靠 `\gset` 回读；`\gset` 只用在
-- 必然返回一行处（失败语句后的 `\gset` 会被跳过；**零行**结果反而会记一次 psql 错误，
-- 所以真冲突的 claim 与所有 SELECT 一律不用 `\gset`）。
\set ON_ERROR_STOP off
BEGIN;

-- 探针属主：以属主身份插（运行时对 users 只有列级 SELECT/INSERT，不在语音域授权面内）。
INSERT INTO public.users (id)
VALUES ('38a38a38-0000-4000-8000-000000000000'::uuid)
ON CONFLICT (id) DO NOTHING;

SET LOCAL ROLE gengyun_api_runtime;
\set r28_probe_sp_role :ERROR

-- [1] speech_jobs SELECT 12 列（store-pg.ts:460 getJob / :471 updateJob 读回）
SAVEPOINT r28_probe_sp;
SELECT id, revision, kind, owner_user_id, transcription_id, media_id, media_revision,
       state, deadline_at, created_at, updated_at, error_code
  FROM public.speech_jobs
 WHERE id = '38a38a38-0001-4000-8000-000000000001'::uuid;
\set r28_probe_sp_job_sel :ERROR
ROLLBACK TO SAVEPOINT r28_probe_sp;

-- [2] speech_jobs INSERT 12 列 + RETURNING id（store-pg.ts:154-156）：真行，保留到段末
SAVEPOINT r28_probe_sp;
INSERT INTO public.speech_jobs
       (id, revision, kind, owner_user_id, transcription_id, media_id, media_revision,
        state, deadline_at, created_at, updated_at, error_code)
VALUES ('38a38a38-0001-4000-8000-000000000001'::uuid, 1, 'transcription',
        '38a38a38-0000-4000-8000-000000000000'::uuid,
        '38a38a38-0002-4000-8000-000000000002'::uuid,
        '38a38a38-0011-4000-8000-000000000011'::uuid, 1, 'queued',
        now() + interval '10 minutes', now(), now(), NULL)
RETURNING id \gset
\set r28_probe_sp_job_ins :ERROR
\if :r28_probe_sp_job_ins
ROLLBACK TO SAVEPOINT r28_probe_sp;
\else
RELEASE SAVEPOINT r28_probe_sp;
\endif

-- [3] speech_jobs UPDATE 真行（store-pg.ts:477-484：SET 5 列，WHERE id + revision）
SAVEPOINT r28_probe_sp;
UPDATE public.speech_jobs
   SET revision = revision + 1, state = 'running', deadline_at = now() + interval '10 minutes',
       updated_at = now(), error_code = NULL
 WHERE id = '38a38a38-0001-4000-8000-000000000001'::uuid
   AND revision = 1
RETURNING id \gset
\set r28_probe_sp_job_upd :ERROR
ROLLBACK TO SAVEPOINT r28_probe_sp;

-- [4] speech_jobs SELECT … FOR UPDATE 真行（store-pg.ts:496-499 commitTerminal）
SAVEPOINT r28_probe_sp;
SELECT id FROM public.speech_jobs
 WHERE id = '38a38a38-0001-4000-8000-000000000001'::uuid
   FOR UPDATE \gset
\set r28_probe_sp_job_lock :ERROR
ROLLBACK TO SAVEPOINT r28_probe_sp;

-- [5] speech_jobs 终态提交 UPDATE（store-pg.ts:517-523：SET 4 列 + revision+1，WHERE id + revision）
SAVEPOINT r28_probe_sp;
UPDATE public.speech_jobs
   SET state = 'succeeded', error_code = NULL, revision = revision + 1, updated_at = now()
 WHERE id = '38a38a38-0001-4000-8000-000000000001'::uuid
   AND revision = 1
RETURNING id \gset
\set r28_probe_sp_job_commit :ERROR
ROLLBACK TO SAVEPOINT r28_probe_sp;

-- [6] transcriptions SELECT 13 列（store-pg.ts:541 getTranscription / :553 读回）
SAVEPOINT r28_probe_sp;
SELECT id, revision, owner_user_id, media_id, media_revision, raw_text, uncertain_spans,
       confirmed_text, confirmed_at, model_version, created_at, updated_at, deleted
  FROM public.transcriptions
 WHERE id = '38a38a38-0002-4000-8000-000000000002'::uuid;
\set r28_probe_sp_rc_sel :ERROR
ROLLBACK TO SAVEPOINT r28_probe_sp;

-- [7] transcriptions INSERT 13 列 + RETURNING id（store-pg.ts:158-160）：真行
SAVEPOINT r28_probe_sp;
INSERT INTO public.transcriptions
       (id, revision, owner_user_id, media_id, media_revision, raw_text, uncertain_spans,
        confirmed_text, confirmed_at, model_version, created_at, updated_at, deleted)
VALUES ('38a38a38-0002-4000-8000-000000000002'::uuid, 1,
        '38a38a38-0000-4000-8000-000000000000'::uuid,
        '38a38a38-0011-4000-8000-000000000011'::uuid, 1,
        'r28-s38-probe', '[]'::jsonb, NULL, NULL, 'r28-s38-probe', now(), now(), false)
RETURNING id \gset
\set r28_probe_sp_rc_ins :ERROR
\if :r28_probe_sp_rc_ins
ROLLBACK TO SAVEPOINT r28_probe_sp;
\else
RELEASE SAVEPOINT r28_probe_sp;
\endif

-- [8] transcriptions UPDATE 真行（store-pg.ts:566-576：SET 8 列，WHERE id + revision）
SAVEPOINT r28_probe_sp;
UPDATE public.transcriptions
   SET revision = revision + 1, raw_text = raw_text,
       uncertain_spans = uncertain_spans, confirmed_text = 'r28-s38-probe-confirmed',
       confirmed_at = now(), model_version = model_version, updated_at = now(), deleted = false
 WHERE id = '38a38a38-0002-4000-8000-000000000002'::uuid
   AND revision = 1
RETURNING id \gset
\set r28_probe_sp_rc_upd :ERROR
ROLLBACK TO SAVEPOINT r28_probe_sp;

-- [9] speech_idempotency SELECT 6 列（store-pg.ts:601-604 findIdempotent）
SAVEPOINT r28_probe_sp;
SELECT request_hash, payload, pending, expires_at
  FROM public.speech_idempotency
 WHERE scope = 'r28-s38-probe:POST:/speech/jobs'
   AND key_hash = 'r28-s38-probe-key';
\set r28_probe_sp_idem_sel :ERROR
ROLLBACK TO SAVEPOINT r28_probe_sp;

-- [10] speech_idempotency 占位 INSERT 6 列（store-pg.ts:627-631）：真行，保留到段末
SAVEPOINT r28_probe_sp;
INSERT INTO public.speech_idempotency
       (scope, key_hash, request_hash, payload, pending, expires_at)
VALUES ('r28-s38-probe:POST:/speech/jobs', 'r28-s38-probe-key', 'r28-s38-probe-request',
        '{"job_id":"38a38a38-0001-4000-8000-000000000001"}'::jsonb, true,
        now() + interval '1 hour')
ON CONFLICT (scope, key_hash) DO NOTHING
RETURNING scope \gset
\set r28_probe_sp_idem_seed :ERROR
\if :r28_probe_sp_idem_seed
ROLLBACK TO SAVEPOINT r28_probe_sp;
\else
RELEASE SAVEPOINT r28_probe_sp;
\endif

-- [11] speech_idempotency 真冲突 claim（store-pg.ts:627-631：同键再插一次 ⇒ 真冲突分支）
--      `RETURNING scope` 在冲突分支上仍要 SELECT 权；本语句零行返回，故**不加** `\gset`。
SAVEPOINT r28_probe_sp;
INSERT INTO public.speech_idempotency
       (scope, key_hash, request_hash, payload, pending, expires_at)
VALUES ('r28-s38-probe:POST:/speech/jobs', 'r28-s38-probe-key', 'r28-s38-probe-request-2',
        '{"job_id":"38a38a38-0001-4000-8000-000000000001"}'::jsonb, true,
        now() + interval '1 hour')
ON CONFLICT (scope, key_hash) DO NOTHING
RETURNING scope;
\set r28_probe_sp_idem_claim :ERROR
ROLLBACK TO SAVEPOINT r28_probe_sp;

-- [12] speech_idempotency finalize（store-pg.ts:641-645：SET payload, pending）
SAVEPOINT r28_probe_sp;
UPDATE public.speech_idempotency
   SET payload = '{"job_id":"38a38a38-0001-4000-8000-000000000001","state":"succeeded"}'::jsonb,
       pending = false
 WHERE scope = 'r28-s38-probe:POST:/speech/jobs'
   AND key_hash = 'r28-s38-probe-key';
\set r28_probe_sp_idem_final :ERROR
ROLLBACK TO SAVEPOINT r28_probe_sp;

-- [13] speech_idempotency release（store-pg.ts:654：按 (scope, key_hash) 整行 DELETE）
--      先种一条独立键的行，再真删它（不碰 [10] 的行，那是 [12] 的对象）。
SAVEPOINT r28_probe_sp;
INSERT INTO public.speech_idempotency
       (scope, key_hash, request_hash, payload, pending, expires_at)
VALUES ('r28-s38-probe:POST:/speech/jobs', 'r28-s38-probe-release', 'r28-s38-probe-request-3',
        '{}'::jsonb, true, now() + interval '1 hour')
ON CONFLICT (scope, key_hash) DO NOTHING;
\set r28_probe_sp_idem_seed_release :ERROR
\if :r28_probe_sp_idem_seed_release
ROLLBACK TO SAVEPOINT r28_probe_sp;
\else
RELEASE SAVEPOINT r28_probe_sp;
\endif

SAVEPOINT r28_probe_sp;
DELETE FROM public.speech_idempotency
 WHERE scope = 'r28-s38-probe:POST:/speech/jobs'
   AND key_hash = 'r28-s38-probe-release';
\set r28_probe_sp_idem_release :ERROR
ROLLBACK TO SAVEPOINT r28_probe_sp;

-- [14] speech_idempotency purge（store-pg.ts:660-662：按过期批量删 + RETURNING scope）
--      种一条已过期的行 ⇒ 本事务里恰好删到一行，`\gset` 去噪。
SAVEPOINT r28_probe_sp;
INSERT INTO public.speech_idempotency
       (scope, key_hash, request_hash, payload, pending, expires_at)
VALUES ('r28-s38-probe:POST:/speech/jobs', 'r28-s38-probe-expired', 'r28-s38-probe-request-4',
        '{}'::jsonb, false, now() - interval '1 hour')
ON CONFLICT (scope, key_hash) DO NOTHING;
\set r28_probe_sp_idem_seed_expired :ERROR
\if :r28_probe_sp_idem_seed_expired
ROLLBACK TO SAVEPOINT r28_probe_sp;
\else
RELEASE SAVEPOINT r28_probe_sp;
\endif

SAVEPOINT r28_probe_sp;
DELETE FROM public.speech_idempotency
 WHERE expires_at <= now()
RETURNING scope \gset
\set r28_probe_sp_idem_purge :ERROR
ROLLBACK TO SAVEPOINT r28_probe_sp;

-- [15] 禁止面：speech_jobs / transcriptions 的整行 DELETE 必须 42501（真行、真 WHERE）。
SAVEPOINT r28_probe_sp;
DELETE FROM public.speech_jobs
 WHERE id = '38a38a38-0001-4000-8000-000000000001'::uuid;
\set r28_probe_sp_job_del :ERROR
ROLLBACK TO SAVEPOINT r28_probe_sp;

SAVEPOINT r28_probe_sp;
DELETE FROM public.transcriptions
 WHERE id = '38a38a38-0002-4000-8000-000000000002'::uuid;
\set r28_probe_sp_rc_del :ERROR
ROLLBACK TO SAVEPOINT r28_probe_sp;

ROLLBACK;
\set ON_ERROR_STOP on
-- --- R28-S38 探针结束 ----------------------------------------------------------

-- --- R28-S24 元清单：运行时域的表必须被**显式分类**（granted / granted_external / forbidden）
-- 这是本片真正防「下一个域又被漏」的机制：迁移新增一张运行时域的表，却没有在
-- 20-login-roles.sql 里授权、也没有在这里声明为 forbidden ⇒ 下面的
-- runtime_domain_tables_classified 判红，而不是像 2026-10 之前那样一路 ok。
-- R28-S33：整棵 checks 只求值**一次**，结果落进会话级临时表；判决行与 DO 块都从这张表读，
-- 不重跑全量断言，也不复制 checks 的定义。临时表随会话销毁，不建持久对象、不改任何权限。
-- 同一会话里重复执行（人工 `\i` 两次）时先清掉上一次的临时表，否则 CREATE 会因重名报错、
-- 被误读成断言判红；只在它确实存在时 DROP（pg_temp 限定），因此全绿读数不多出任何 NOTICE。
DO $$
BEGIN
  IF to_regclass('pg_temp.r28_assert_results') IS NOT NULL THEN
    DROP TABLE pg_temp.r28_assert_results;
  END IF;
END
$$;
CREATE TEMP TABLE r28_assert_results AS
WITH domain_manifest(tbl, classification, required) AS (VALUES
    ('messages',                       'granted',          true),
    ('community_posts',                'granted',          true),
    ('community_comments',             'granted',          true),
    ('community_likes',                'granted',          true),
    ('community_reports',              'granted',          true),
    ('community_moderation_decisions', 'granted',          true),
    ('community_idempotency',          'granted',          true),
    ('ocr_jobs',                       'granted',          true),
    ('ocr_records',                    'granted',          true),
    ('ocr_idempotency',                'granted',          true),
    -- 备份副本由 GY-I19 段（另一次交付）授权给 gengyun_auth_privacy 组；
    -- 本文件只声明“已分类”，列级形状由 tests/integration/backup-purge-pg.mjs 覆盖。
    ('user_backup_copies',             'granted_external', true),
    -- 运行时明确**不得**访问的运行时域表（零表级、零列级权限）
    ('community_media_grants',         'forbidden',        true),
    ('deletion_requests',              'forbidden',        true),
    ('deletion_handlers',              'forbidden',        true),
    ('third_party_deletions',          'forbidden',        true),
    -- 迁移 0025 已随 #333 合入 main（341ad8c）：本片按 S24 证据页 §10 的方案 B 硬前置，
    -- 四张识别域表由 20-login-roles.sql 段 J 列级授权，故 required=true（缺表即判红）。
    ('recognition_jobs',               'granted',          true),
    ('recognition_records',            'granted',          true),
    ('recognition_idempotency',        'granted',          true),
    -- 迁移 0013 / 0018 的收藏／历史／对话域（R28-S26）：七张表由 20-login-roles.sql 的 I 段
    -- 列级授权给 gengyun_api_runtime；授权清单与下面 expected 的独立复述必须一致。
    ('favorites',                      'granted',          true),
    ('favorites_idempotency',          'granted',          true),
    ('history',                        'granted',          true),
    ('history_idempotency',            'granted',          true),
    ('conversations',                  'granted',          true),
    ('conversation_turns',             'granted',          true),
    ('conversation_answers',           'granted',          true),
    -- 迁移 0025 的 recognition_selections：与上面三行同一片授权（R28-S28 段 J），
    -- 不再标 forbidden —— 它是运行时真实写入的「选中结果」台账（store-pg.ts:192-194）。
    ('recognition_selections',         'granted',          true),
    -- 迁移 0026 的语音域三表（R28-S38 段 K）：0026 只建表、原先没有任何授段 ⇒ 运行时零权限、
    -- 而 90-assert 也看不见（清单里没有它们）。这一片把授权与分类同时补上：三行一起进清单，
    -- 第 47 条元断言才可能要求“每个 public 关系都必须被分类”。
    -- transcriptions 不带 speech_ 前缀，所以第 47 条的正则要同时加 speech_ 与 transcriptions$。
    ('speech_jobs',                    'granted',          true),
    ('transcriptions',                 'granted',          true),
    ('speech_idempotency',             'granted',          true)
  ),
-- 授权清单的**独立复述**：下面逐表断言“清单内的列必须有、清单外的列必须没有”。
-- 它与 20-login-roles.sql 段 H 的 GRANT 是同一事实的两次写法：任一处写错/漂移都会被
-- 断言抓住（这是有意的重复，不要把它合并成“从授权结果反推”）。
  expected(tbl, sel, ins, upd, del) AS (VALUES
    ('messages',
     ARRAY['id','revision','owner_id','type','target_ref','read_at','created_at','event_key'],
     ARRAY['id','owner_id','type','target_ref','read_at','created_at','revision','event_key'],
     ARRAY['read_at','revision'],
     false),
    ('community_posts',
     ARRAY['id','author_id','revision','title','body','crop_id','region_code','media_ids',
           'linked_knowledge_type','linked_knowledge_id','linked_knowledge_revision',
           'visibility','audit_state','created_at','updated_at'],
     ARRAY['id','author_id','revision','title','body','crop_id','region_code','media_ids',
           'linked_knowledge_type','linked_knowledge_id','linked_knowledge_revision',
           'visibility','audit_state','created_at','updated_at'],
     ARRAY['revision','title','body','crop_id','region_code','media_ids',
           'linked_knowledge_type','linked_knowledge_id','linked_knowledge_revision',
           'visibility','audit_state','updated_at'],
     false),
    ('community_comments',
     ARRAY['id','post_id','author_id','revision','body','visibility','audit_state','created_at'],
     ARRAY['id','post_id','author_id','revision','body','visibility','audit_state','created_at'],
     ARRAY['revision','body','visibility','audit_state'],
     false),
    ('community_likes',
     ARRAY['target_type','target_id','user_id'],
     ARRAY['target_type','target_id','user_id'],
     ARRAY[]::text[],
     true),
    ('community_reports',
     ARRAY['id','revision','reporter_id','target_type','target_id','target_revision',
           'state','reason_code','detail','created_at'],
     ARRAY['id','revision','reporter_id','target_type','target_id','target_revision',
           'state','reason_code','detail','created_at'],
     ARRAY['revision','reporter_id','target_type','target_id','target_revision',
           'state','reason_code','detail','created_at'],
     false),
    ('community_moderation_decisions',
     ARRAY['target_type','target_id','target_revision','id','decision','reason_codes',
           'hard_rule_passed','rule_version','text_digest','contract_complete',
           'missing_contract_fields','created_at'],
     ARRAY['target_type','target_id','target_revision','id','decision','reason_codes',
           'hard_rule_passed','rule_version','text_digest','contract_complete',
           'missing_contract_fields','created_at'],
     ARRAY['id','decision','reason_codes','hard_rule_passed','rule_version','text_digest',
           'contract_complete','missing_contract_fields','created_at'],
     false),
    ('community_idempotency',
     ARRAY['scope','key_hash','request_hash','response_status','outcome','expires_at'],
     ARRAY['scope','key_hash','request_hash','response_status','outcome','expires_at'],
     ARRAY['response_status','outcome'],
     true),
    ('ocr_jobs',
     ARRAY['id','revision','kind','owner_user_id','ocr_id','media_id','media_revision',
           'state','deadline_at','created_at','updated_at','error_code'],
     ARRAY['id','revision','kind','owner_user_id','ocr_id','media_id','media_revision',
           'state','deadline_at','created_at','updated_at','error_code'],
     ARRAY['revision','state','deadline_at','updated_at','error_code'],
     false),
    ('ocr_records',
     ARRAY['id','revision','owner_user_id','media_id','media_revision','raw_fields',
           'corrected_fields','verification','model_version','created_at','updated_at','deleted'],
     ARRAY['id','revision','owner_user_id','media_id','media_revision','raw_fields',
           'corrected_fields','verification','model_version','created_at','updated_at','deleted'],
     ARRAY['revision','raw_fields','corrected_fields','verification','model_version',
           'updated_at','deleted'],
     false),
    ('ocr_idempotency',
     ARRAY['scope','key_hash','request_hash','payload','pending','expires_at'],
     ARRAY['scope','key_hash','request_hash','payload','pending','expires_at'],
     ARRAY['request_hash','payload','pending','expires_at'],
     true),
    -- R28-S26 收藏／历史／对话域（迁移 0013 / 0018）：列清单由 store-pg.ts 真实语句反推。
    -- favorites / history / conversations 三张表的 UPDATE 只有 revision 一列，且**只为**
    -- SELECT … FOR UPDATE 的行锁权（store 里没有任何 UPDATE 语句）——不是业务写权限。
    ('favorites',
     ARRAY['id','owner_id','target_type','target_id','target_revision','revision','created_at'],
     ARRAY['id','owner_id','target_type','target_id','target_revision','revision','created_at'],
     ARRAY['revision'],
     true),
    ('favorites_idempotency',
     ARRAY['scope','key_hash','request_hash','response_status','outcome','expires_at'],
     ARRAY['scope','key_hash','request_hash','response_status','outcome','expires_at'],
     ARRAY['request_hash','response_status','outcome','expires_at'],
     true),
    ('history',
     ARRAY['id','owner_id','kind','target_type','target_id','target_revision','revision',
           'job_id','job_state','event_key','created_at'],
     ARRAY['id','owner_id','kind','target_type','target_id','target_revision','revision',
           'job_id','job_state','event_key','created_at'],
     ARRAY['revision'],
     true),
    ('history_idempotency',
     ARRAY['scope','key_hash','request_hash','response_status','outcome','expires_at'],
     ARRAY['scope','key_hash','request_hash','response_status','outcome','expires_at'],
     ARRAY['request_hash','response_status','outcome','expires_at'],
     true),
    ('conversations',
     ARRAY['id','owner_id','revision','conditions','created_at','updated_at'],
     ARRAY['id','owner_id','revision','conditions','created_at','updated_at'],
     ARRAY['revision'],
     true),
    ('conversation_turns',
     ARRAY['id','conversation_id','owner_id','revision','input_text','transcription_ref',
           'job_id','job_state','job_deadline_at','job_created_at','job_error_code','answer_id',
           'created_at','updated_at'],
     ARRAY['id','conversation_id','owner_id','revision','input_text','transcription_ref',
           'job_id','job_state','job_deadline_at','job_created_at','job_error_code',
           'created_at','updated_at'],
     ARRAY['job_state','job_error_code','answer_id','revision','updated_at'],
     true),
    ('conversation_answers',
     ARRAY['id','turn_id','owner_id','revision','status','checked_text','check_state','citations',
           'dose_cards','model_version','prompt_version','rule_version','created_at','updated_at'],
     ARRAY['id','turn_id','owner_id','revision','status','checked_text','check_state','citations',
           'dose_cards','model_version','prompt_version','rule_version','created_at','updated_at'],
     ARRAY[]::text[],
     false),
    -- R28-S28（迁移 0025）：识别域四表。列清单与 20-login-roles.sql 段 J 逐列一致，
    -- 但这里是**独立复述**（同一事实的第二次写法），任一处漂移都会被下面的逐表断言抓住。
    -- recognition_selections 的 upd 是空数组：store 只 INSERT / SELECT，不 UPDATE；
    -- recognition_idempotency 的 del 是 true：PG 无列级 DELETE，两条整行删除见 store:820/:830。
    ('recognition_jobs',
     ARRAY['id','revision','kind','owner_user_id','recognition_id','media_id','media_revision',
           'state','deadline_at','created_at','updated_at','error_code'],
     ARRAY['id','revision','kind','owner_user_id','recognition_id','media_id','media_revision',
           'state','deadline_at','created_at','updated_at','error_code'],
     ARRAY['revision','state','deadline_at','updated_at','error_code'],
     false),
    ('recognition_records',
     ARRAY['id','revision','owner_user_id','media_id','media_revision','candidates',
           'uncertainty_reasons','selected_species_id','model_version','created_at','updated_at',
           'deleted'],
     ARRAY['id','revision','owner_user_id','media_id','media_revision','candidates',
           'uncertainty_reasons','selected_species_id','model_version','created_at','updated_at',
           'deleted'],
     ARRAY['revision','candidates','uncertainty_reasons','selected_species_id','model_version',
           'updated_at','deleted'],
     false),
    ('recognition_selections',
     ARRAY['id','revision','recognition_id','owner_user_id','species_id','provenance','decided_at',
           'linkage'],
     ARRAY['id','revision','recognition_id','owner_user_id','species_id','provenance','decided_at',
           'linkage'],
     ARRAY[]::text[],
     false),
    ('recognition_idempotency',
     ARRAY['scope','key_hash','request_hash','payload','pending','expires_at'],
     ARRAY['scope','key_hash','request_hash','payload','pending','expires_at'],
     ARRAY['request_hash','payload','pending','expires_at'],
     true),
    -- R28-S38（迁移 0026）：语音域三表，列清单与 20-login-roles.sql 段 K 的 GRANT 是同一事实的
    -- 两次写法（任一处漂移都会被下面的逐表断言抓住）。
    -- speech_idempotency 的 SELECT 是**6 列**而不是 4 列：`WHERE scope/key_hash`、
    -- claim 与 purge 的 `RETURNING scope` 都要 SELECT 权——实测只授 4 列时，
    -- findIdempotent :601 与 claim :627 都 42501（S38 证据页的矩阵实验 A/B）。
    ('speech_jobs',
     ARRAY['id','revision','kind','owner_user_id','transcription_id','media_id','media_revision',
           'state','deadline_at','created_at','updated_at','error_code'],
     ARRAY['id','revision','kind','owner_user_id','transcription_id','media_id','media_revision',
           'state','deadline_at','created_at','updated_at','error_code'],
     ARRAY['revision','state','deadline_at','updated_at','error_code'],
     false),
    ('transcriptions',
     ARRAY['id','revision','owner_user_id','media_id','media_revision','raw_text','uncertain_spans',
           'confirmed_text','confirmed_at','model_version','created_at','updated_at','deleted'],
     ARRAY['id','revision','owner_user_id','media_id','media_revision','raw_text','uncertain_spans',
           'confirmed_text','confirmed_at','model_version','created_at','updated_at','deleted'],
     ARRAY['revision','raw_text','uncertain_spans','confirmed_text','confirmed_at','model_version',
           'updated_at','deleted'],
     false),
    ('speech_idempotency',
     ARRAY['scope','key_hash','request_hash','payload','pending','expires_at'],
     ARRAY['scope','key_hash','request_hash','payload','pending','expires_at'],
     ARRAY['payload','pending'],
     true)
  ),
  -- 表级写权限白名单：本文件内的**唯一事实来源**。断言 7 的判定与失败提示都由它生成，
  -- 这样以后再加表只需改这一处，不会再出现「清单扩了、提示文本还只列旧表」的谎报
  -- （S24 独立复核的遗留点：detail 是手写字符串，容易与判定口径漂移）。
  allow_table_dml(sch, tbl, priv) AS (VALUES
    ('public', 'idempotency_keys',       'INSERT'),
    ('public', 'idempotency_keys',       'DELETE'),
    ('public', 'community_likes',        'DELETE'),
    ('public', 'community_idempotency',  'DELETE'),
    ('public', 'ocr_idempotency',        'DELETE'),
    -- R28-S26（2026-10-20）：收藏／历史／对话域的物理删除与幂等台账清理。
    -- PG 没有列级 DELETE，store 里的 DELETE FROM 只能表级授权；逐条代码出处见证据页。
    ('public', 'favorites',              'DELETE'),
    ('public', 'history',                'DELETE'),
    ('public', 'conversations',          'DELETE'),
    ('public', 'conversation_turns',     'DELETE'),
    ('public', 'favorites_idempotency',  'DELETE'),
    ('public', 'history_idempotency',    'DELETE'),
    -- R28-S28（迁移 0025）：PG 没有列级 DELETE，而 store 有两条整行删除
    -- （services/api/src/recognitions/store-pg.ts:820 release、:830 purge），只能表级授予。
    -- 这是本片唯一新增的表级写授权（白名单 11 → 12 个三元组）。
    ('public', 'recognition_idempotency', 'DELETE'),
    -- R28-S38（迁移 0026）：PG 没有列级 DELETE，而语音域幂等台账有两条整行删除
    -- （services/api/src/speech/store-pg.ts:654 release、:660-662 purge），只能表级授予。
    -- 这是本片唯一新增的表级写授权（白名单 12 → 13 个三元组）；speech_jobs / transcriptions
    -- 仍然完全不授 DELETE —— 若下面断言判红，先查是不是有人给这两张表加了表级写权。
    ('public', 'speech_idempotency',    'DELETE')
  ),
  checks(label, ok, detail) AS (

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
  -- 7. 表级写权限只允许「结构化允许清单」里逐表逐权限类型点名的二元组。
  --
  -- R28-S24 收紧（原断言只按表名豁免：`NOT (relname = 'idempotency_keys')`，
  -- 等于对 idempotency_keys 整表放开 INSERT/UPDATE/DELETE/TRUNCATE/... 所有类型）：
  -- PostgreSQL 没有列级 DELETE，取消点赞（community_likes）与幂等清理
  -- （community_idempotency / ocr_idempotency）只能表级 DELETE。所以这里把豁免
  -- 从「一张表、全部类型」改成「(schema, 表, 权限类型) 三元组白名单」：
  --   表在清单里但类型不在 ⇒ 仍然失败（例：GRANT UPDATE ON community_likes ⇒ 红）。
  -- 表级 INSERT/UPDATE 仍处处禁止（它们都有列级替代；GREATEST 语义不适用）。
  -- 注：PG17 的 MAINTAIN 属于维护类而非写入类，且 PG16 无此记号（写死会
  -- 让旧版本 psql 直接报错），故不纳入本断言。
  SELECT 'table_dml_allowlist',
         NOT EXISTS (
           SELECT 1
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'),
                                ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
            WHERE c.relkind IN ('r','p','f')
              AND n.nspname NOT IN ('pg_catalog','information_schema')
              AND n.nspname NOT LIKE 'pg_%'
              AND has_table_privilege('gengyun_api_runtime', c.oid, p.priv)
              AND NOT EXISTS (
                    SELECT 1
                      FROM allow_table_dml allow
                     WHERE allow.sch = n.nspname
                       AND allow.tbl = c.relname
                       AND allow.priv = p.priv
                  )
         ),
         '表级写权限只允许 ' ||
         (SELECT string_agg(format('%s{%s}', a.tbl, a.priv), '、' ORDER BY a.tbl, a.priv)
            FROM allow_table_dml a
           WHERE a.sch = 'public') ||
         '；清单外的表或类型一律失败（其余全部按列授予）'

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

  -- ---------------------------------------------------------------------------
  -- GY-I22（#22）追加：账号停用/恢复**唯一写路径**与审计台账的函数级/表级契约断言。
  -- 背景：运行时角色对 public.users 的 state/auth_epoch/revision 与 public.admin_audit_events
  -- **没有任何直接权限**（见上面 protected_columns——它钉的是 sessions.auth_epoch，该断言逐字未动）；
  -- public.sessions 的 (token_hash,revoked_at) 自 0001 起本就授予运行时 UPDATE（auth_privacy.sql），
  -- 撤会话单独做得到，但单靠它做不到「同事务内改状态 + 推进纪元 + 落审计」，
  -- 所以停用只能经窄口径 SECURITY DEFINER 函数完成；因此把「函数确实存在、确实是 SECURITY DEFINER、
  -- search_path 确实固定、属主确实能写这些列、EXECUTE 确实只授予运行时角色、审计台账确实只可追加」
  -- 全部钉死。⛔ 这十条**不**放松任何既有断言，也**不**给运行时角色补任何列权限。
  -- 反向控制（不在此文件断言，见交接证据）：以 gengyun_api_runtime 直接
  -- `UPDATE public.users SET auth_epoch = auth_epoch + 1` 仍必须 permission denied。
  -- ---------------------------------------------------------------------------
  UNION ALL
  -- 21. 停用唯一写路径必须恰存在一个（名字 + 精确签名）
  SELECT 'suspend_function_exists',
         to_regprocedure('public.suspend_account(uuid,uuid,uuid,integer,uuid)') IS NOT NULL
         AND (SELECT count(*) FROM pg_proc
               WHERE proname = 'suspend_account'
                 AND pronamespace = 'public'::regnamespace) = 1,
         '账号停用唯一写路径必须恰为 public.suspend_account(uuid,uuid,uuid,integer,uuid)'

  UNION ALL
  -- 22. 必须真的是 SECURITY DEFINER（否则函数以调用者身份执行，写 users 必然被拒）
  SELECT 'suspend_function_security_definer',
         (SELECT p.prosecdef
            FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname = 'suspend_account'),
         '账号停用函数必须声明 SECURITY DEFINER'

  UNION ALL
  -- 23. search_path 必须固定为 pg_catalog，且时区固定为 UTC
  SELECT 'suspend_function_search_path',
         (SELECT p.proconfig @> ARRAY['search_path=pg_catalog', 'TimeZone=UTC']
            FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname = 'suspend_account'),
         '账号停用函数必须设 SET search_path = pg_catalog 与 SET TimeZone = UTC'

  UNION ALL
  -- 24. 属主正确：必须能改 users.state/auth_epoch/revision、能撤 sessions、能写审计台账，
  --     且运行时角色既不是它、也不能 SET ROLE 成为它（否则可绕过列授权）
  SELECT 'suspend_function_owner',
         (SELECT pg_get_userbyid(p.proowner) <> 'gengyun_api_runtime'
                 AND NOT pg_has_role('gengyun_api_runtime', p.proowner, 'MEMBER')
                 AND has_column_privilege(pg_get_userbyid(p.proowner), 'public.users', 'state', 'UPDATE')
                 AND has_column_privilege(pg_get_userbyid(p.proowner), 'public.users', 'auth_epoch', 'UPDATE')
                 AND has_column_privilege(pg_get_userbyid(p.proowner), 'public.users', 'revision', 'UPDATE')
                 AND has_column_privilege(pg_get_userbyid(p.proowner), 'public.sessions', 'revoked_at', 'UPDATE')
                 AND has_table_privilege(pg_get_userbyid(p.proowner), 'public.admin_audit_events', 'INSERT')
            FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname = 'suspend_account'),
         '函数属主必须能改 users.state/auth_epoch/revision、撤 sessions.revoked_at 并写 admin_audit_events，且运行时角色无法成为它'

  UNION ALL
  -- 25. EXECUTE 只授予运行时角色：PUBLIC（grantee=0）与任何其它角色一律不得执行
  SELECT 'suspend_function_execute',
         has_function_privilege(
           'gengyun_api_runtime',
           'public.suspend_account(uuid,uuid,uuid,integer,uuid)',
           'EXECUTE'
         )
         AND NOT EXISTS (
           SELECT 1
             FROM pg_proc p, aclexplode(p.proacl) a
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname = 'suspend_account'
              AND a.privilege_type = 'EXECUTE'
              AND a.grantee NOT IN (0, 'gengyun_api_runtime'::regrole, p.proowner)
         )
         AND NOT EXISTS (
           SELECT 1
             FROM pg_proc p, aclexplode(p.proacl) a
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname = 'suspend_account'
              AND a.privilege_type = 'EXECUTE'
              AND a.grantee = 0
         ),
         '账号停用函数的 EXECUTE 只应授予 gengyun_api_runtime（PUBLIC 与其它角色一律不得执行）'

  UNION ALL
  -- 26. 恢复唯一写路径必须恰存在一个（名字 + 精确签名）
  SELECT 'restore_function_exists',
         to_regprocedure('public.restore_account(uuid,uuid,uuid,integer,uuid)') IS NOT NULL
         AND (SELECT count(*) FROM pg_proc
               WHERE proname = 'restore_account'
                 AND pronamespace = 'public'::regnamespace) = 1,
         '账号恢复唯一写路径必须恰为 public.restore_account(uuid,uuid,uuid,integer,uuid)'

  UNION ALL
  -- 27. 恢复也必须真的是 SECURITY DEFINER
  SELECT 'restore_function_security_definer',
         (SELECT p.prosecdef
            FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname = 'restore_account'),
         '账号恢复函数必须声明 SECURITY DEFINER'

  UNION ALL
  -- 28. 恢复函数的 search_path / 时区同样固定
  SELECT 'restore_function_search_path',
         (SELECT p.proconfig @> ARRAY['search_path=pg_catalog', 'TimeZone=UTC']
            FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname = 'restore_account'),
         '账号恢复函数必须设 SET search_path = pg_catalog 与 SET TimeZone = UTC'

  UNION ALL
  -- 29. 恢复函数据属主与 EXECUTE 口径与停用完全一致（同一套最小权限）
  SELECT 'restore_function_owner',
         (SELECT pg_get_userbyid(p.proowner) <> 'gengyun_api_runtime'
                 AND NOT pg_has_role('gengyun_api_runtime', p.proowner, 'MEMBER')
                 AND has_column_privilege(pg_get_userbyid(p.proowner), 'public.users', 'state', 'UPDATE')
                 AND has_column_privilege(pg_get_userbyid(p.proowner), 'public.users', 'auth_epoch', 'UPDATE')
                 AND has_column_privilege(pg_get_userbyid(p.proowner), 'public.users', 'revision', 'UPDATE')
                 AND has_column_privilege(pg_get_userbyid(p.proowner), 'public.sessions', 'revoked_at', 'UPDATE')
                 AND has_table_privilege(pg_get_userbyid(p.proowner), 'public.admin_audit_events', 'INSERT')
            FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname = 'restore_account'),
         '恢复函数属主必须能改 users.state/auth_epoch/revision、撤 sessions.revoked_at 并写 admin_audit_events，且运行时角色无法成为它'

  UNION ALL
  SELECT 'restore_function_execute',
         has_function_privilege(
           'gengyun_api_runtime',
           'public.restore_account(uuid,uuid,uuid,integer,uuid)',
           'EXECUTE'
         )
         AND NOT EXISTS (
           SELECT 1
             FROM pg_proc p, aclexplode(p.proacl) a
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname = 'restore_account'
              AND a.privilege_type = 'EXECUTE'
              AND a.grantee NOT IN (0, 'gengyun_api_runtime'::regrole, p.proowner)
         )
         AND NOT EXISTS (
           SELECT 1
             FROM pg_proc p, aclexplode(p.proacl) a
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname = 'restore_account'
              AND a.privilege_type = 'EXECUTE'
              AND a.grantee = 0
         ),
         '账号恢复函数的 EXECUTE 只应授予 gengyun_api_runtime（PUBLIC 与其它角色一律不得执行）'

  UNION ALL
  -- 30. 审计台账：只可追加（触发器在岗）+ 运行时角色零直接权限（连 SELECT 都不给）
  SELECT 'audit_ledger_append_only',
         to_regclass('public.admin_audit_events') IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM pg_trigger t
            WHERE t.tgrelid = to_regclass('public.admin_audit_events')
              AND t.tgname = 'admin_audit_events_append_only'
              AND t.tgenabled <> 'D'
         )
         AND to_regprocedure('public.admin_audit_events_reject_mutation()') IS NOT NULL
         AND NOT has_table_privilege('gengyun_api_runtime', 'public.admin_audit_events', 'INSERT')
         AND NOT has_table_privilege('gengyun_api_runtime', 'public.admin_audit_events', 'UPDATE')
         AND NOT has_table_privilege('gengyun_api_runtime', 'public.admin_audit_events', 'DELETE')
         AND NOT has_table_privilege('gengyun_api_runtime', 'public.admin_audit_events', 'TRUNCATE')
         AND NOT has_table_privilege('gengyun_api_runtime', 'public.admin_audit_events', 'SELECT'),
         '审计台账必须只可追加（append-only 触发器在岗），且运行时角色对其没有任何直接权限（插入只发生在 SECURITY DEFINER 函数内）'

  UNION ALL
  -- 31. 展示名投影函数：纯投影（非 SECURITY DEFINER，不可借它提权），search_path 固定
  SELECT 'account_display_name_projection',
         to_regprocedure('public.admin_account_display_name(text,uuid)') IS NOT NULL
         AND (SELECT NOT p.prosecdef
                     AND p.proconfig @> ARRAY['search_path=pg_catalog']
                FROM pg_proc p
               WHERE p.pronamespace = 'public'::regnamespace
                 AND p.proname = 'admin_account_display_name'),
         'admin_account_display_name(text,uuid) 必须是固定 search_path 的纯投影函数（非 SECURITY DEFINER）'

  UNION ALL
  -- 32. 账号读面（GY-I18 / 迁移 0021）唯一读路径必须恰存在一个（名字 + 精确签名）
  SELECT 'accounts_read_function_exists',
         to_regprocedure('public.list_admin_accounts()') IS NOT NULL
         AND (SELECT count(*) FROM pg_proc
               WHERE proname = 'list_admin_accounts'
                 AND pronamespace = 'public'::regnamespace) = 1,
         '账号读面唯一读路径必须恰为 public.list_admin_accounts()'

  UNION ALL
  -- 33. 必须真的是 SECURITY DEFINER（否则以调用者身份读 nickname/created_at 必然 42501）
  SELECT 'accounts_read_function_security_definer',
         (SELECT p.prosecdef
            FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname = 'list_admin_accounts'
             AND p.pronargs = 0),
         '账号读面函数必须声明 SECURITY DEFINER'

  UNION ALL
  -- 34. search_path 必须固定为 pg_catalog（不做 search_path 劫持的入口）
  SELECT 'accounts_read_function_search_path',
         (SELECT p.proconfig @> ARRAY['search_path=pg_catalog']
            FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname = 'list_admin_accounts'
             AND p.pronargs = 0),
         '账号读面函数必须设 SET search_path = pg_catalog'

  UNION ALL
  -- 35. 属主正确：必须是能读 users 全列的角色，且运行时既不是它、也不能 SET ROLE 成为它
  SELECT 'accounts_read_function_owner',
         (SELECT pg_get_userbyid(p.proowner) <> 'gengyun_api_runtime'
                 AND NOT pg_has_role('gengyun_api_runtime', p.proowner, 'MEMBER')
                 AND has_column_privilege(pg_get_userbyid(p.proowner), 'public.users', 'nickname', 'SELECT')
                 AND has_column_privilege(pg_get_userbyid(p.proowner), 'public.users', 'created_at', 'SELECT')
            FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname = 'list_admin_accounts'
             AND p.pronargs = 0),
         '账号读面函数属主必须能读 users 全列，且运行时角色无法成为它'

  UNION ALL
  -- 36. EXECUTE 只授予运行时角色：PUBLIC（grantee=0）与任何其它角色一律不得执行
  SELECT 'accounts_read_function_execute',
         has_function_privilege('gengyun_api_runtime', 'public.list_admin_accounts()', 'EXECUTE')
         AND NOT EXISTS (
           SELECT 1
             FROM pg_proc p, aclexplode(p.proacl) a
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname = 'list_admin_accounts'
              AND a.privilege_type = 'EXECUTE'
              AND a.grantee NOT IN (0, 'gengyun_api_runtime'::regrole, p.proowner)
         )
         AND NOT EXISTS (
           SELECT 1
             FROM pg_proc p, aclexplode(p.proacl) a
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname = 'list_admin_accounts'
              AND a.privilege_type = 'EXECUTE'
              AND a.grantee = 0
         ),
         '账号读面函数的 EXECUTE 只应授予 gengyun_api_runtime（PUBLIC 与其它角色一律不得执行）'

  UNION ALL
  -- 37. 反向控制：读面放行**只**经函数；运行时对 users 的 nickname/created_at 仍无 SELECT
  --     （这条断言的意义就是防止"为了让读面跑通而偷偷补列权限"）
  SELECT 'accounts_read_no_column_grant',
         NOT has_column_privilege('gengyun_api_runtime', 'public.users', 'nickname', 'SELECT')
         AND NOT has_column_privilege('gengyun_api_runtime', 'public.users', 'created_at', 'SELECT')
         AND NOT has_column_privilege('gengyun_api_runtime', 'public.users', 'deletion_generation', 'SELECT'),
         '账号读面不得以补列授权实现：运行时对 users.nickname/created_at/deletion_generation 必须仍无 SELECT'

  -- --- GY-I18：功能开关唯一写路径（SECURITY DEFINER 提权函数）的看守 -------------------
  -- 编号 38–44 顺延（32–37 由 0021 账号读面片实占，⛔ 不复用）。
  -- set_feature_flag 会在函数内写 public.admin_audit_events（运行时对该表零权限），
  -- ⇒ 它是提权面；缺了这组断言，红线就只剩「没人改它」的自觉。
  UNION ALL
  -- 38. 开关唯一写路径必须恰存在一个（名字 + 精确签名）
  SELECT 'feature_flag_function_exists',
         to_regprocedure('public.set_feature_flag(text,integer,boolean,uuid,uuid,uuid,text,text)') IS NOT NULL
         AND (SELECT count(*) FROM pg_proc
               WHERE proname = 'set_feature_flag'
                 AND pronamespace = 'public'::regnamespace) = 1,
         '开关唯一写路径必须恰为 public.set_feature_flag(text,integer,boolean,uuid,uuid,uuid,text,text)'

  UNION ALL
  -- 39. 必须真的是 SECURITY DEFINER（否则函数内对审计表的 INSERT 会以调用者身份失败）
  SELECT 'feature_flag_function_security_definer',
         (SELECT p.prosecdef
            FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname = 'set_feature_flag'),
         '开关写路径必须声明 SECURITY DEFINER（唯一写审计的提权入口）'

  UNION ALL
  -- 40. search_path 只允许 pg_catalog（不接受再带 public 等可被注入的 schema），时区固定 UTC
  SELECT 'feature_flag_function_search_path',
         (SELECT p.proconfig @> ARRAY['search_path=pg_catalog', 'TimeZone=UTC']
                 AND NOT EXISTS (
                   SELECT 1
                     FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS cfg
                    WHERE cfg LIKE 'search_path=%'
                      AND cfg <> 'search_path=pg_catalog'
                 )
            FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname = 'set_feature_flag'),
         '开关写路径必须设 SET search_path = pg_catalog（不得追加其它 schema）与 SET TimeZone = UTC'

  UNION ALL
  -- 41. 属主不得是运行时角色，且运行时不得通过成员链继承它
  SELECT 'feature_flag_function_owner',
         (SELECT pg_get_userbyid(p.proowner) <> 'gengyun_api_runtime'
                 AND NOT pg_has_role('gengyun_api_runtime', p.proowner, 'MEMBER')
            FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname = 'set_feature_flag'),
         '开关写路径的属主不得是 gengyun_api_runtime，运行时也不得继承/成为它'

  UNION ALL
  -- 42. EXECUTE 只授予运行时（PUBLIC 与其他角色一律不得执行）
  --     ⚠️ 用 regprocedure/oid 重载求值：函数被删时返回 NULL 而不是抛错，
  --        这样证伪时仍能打印出标签（而不是让整个文件 exit=3）。
  SELECT 'feature_flag_function_execute',
         has_function_privilege(
           'gengyun_api_runtime',
           to_regprocedure('public.set_feature_flag(text,integer,boolean,uuid,uuid,uuid,text,text)'),
           'EXECUTE'
         ) IS TRUE
         AND NOT EXISTS (
           SELECT 1
             FROM pg_proc p, aclexplode(p.proacl) a
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname = 'set_feature_flag'
              AND a.privilege_type = 'EXECUTE'
              AND a.grantee NOT IN (0, 'gengyun_api_runtime'::regrole, p.proowner)
         )
         AND NOT EXISTS (
           SELECT 1
             FROM pg_proc p, aclexplode(p.proacl) a
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname = 'set_feature_flag'
              AND a.privilege_type = 'EXECUTE'
              AND a.grantee = 0
         ),
         '开关写路径的 EXECUTE 只应授予 gengyun_api_runtime（PUBLIC 与其它角色一律不得执行）'

  UNION ALL
  -- 43. 运行时对开关表仍只有 SELECT（写只发生在 SECURITY DEFINER 函数内）
  SELECT 'feature_flag_table_select_only',
         to_regclass('public.feature_flags') IS NOT NULL
         AND has_table_privilege('gengyun_api_runtime', to_regclass('public.feature_flags'), 'SELECT') IS TRUE
         AND NOT has_table_privilege('gengyun_api_runtime', to_regclass('public.feature_flags'), 'INSERT')
         AND NOT has_table_privilege('gengyun_api_runtime', to_regclass('public.feature_flags'), 'UPDATE')
         AND NOT has_table_privilege('gengyun_api_runtime', to_regclass('public.feature_flags'), 'DELETE')
         AND NOT has_table_privilege('gengyun_api_runtime', to_regclass('public.feature_flags'), 'TRUNCATE')
         AND NOT has_table_privilege('gengyun_api_runtime', to_regclass('public.feature_flags'), 'REFERENCES')
         AND NOT has_table_privilege('gengyun_api_runtime', to_regclass('public.feature_flags'), 'TRIGGER')
         AND NOT has_any_column_privilege('gengyun_api_runtime', to_regclass('public.feature_flags'), 'UPDATE'),
         '运行时对 public.feature_flags 只能有 SELECT：写入必须走 public.set_feature_flag(...)'

  UNION ALL
  -- 44. 审计台账对运行时仍零直接权限（写入只发生在 SECURITY DEFINER 函数内）
  SELECT 'feature_flag_audit_ledger_untouched',
         NOT has_table_privilege('gengyun_api_runtime', to_regclass('public.admin_audit_events'), 'INSERT')
         AND NOT has_table_privilege('gengyun_api_runtime', to_regclass('public.admin_audit_events'), 'UPDATE')
         AND NOT has_table_privilege('gengyun_api_runtime', to_regclass('public.admin_audit_events'), 'DELETE')
         AND NOT has_table_privilege('gengyun_api_runtime', to_regclass('public.admin_audit_events'), 'TRUNCATE')
         AND NOT has_table_privilege('gengyun_api_runtime', to_regclass('public.admin_audit_events'), 'SELECT'),
         '运行时对 public.admin_audit_events 必须仍无任何直接权限（开关审计只经唯一写路径写入）'

  UNION ALL
  -- 45. R28-S24 真执行探针（表级 DELETE）：四张白名单表必须在运行时身份下真能删（零行）
  --     为什么不用 has_table_privilege 就够：它只回答权限位；这里回答“语句真能跑通”。
  --     变量来自上方探针段（成功=false、失败=true，故断言写成 = 'false'）。
  SELECT 'runtime_domain_delete_exec',
         :'r28_probe_role' = 'false'
         AND :'r28_probe_del_idempotency_keys' = 'false'
         AND :'r28_probe_del_community_likes' = 'false'
         AND :'r28_probe_del_community_idempotency' = 'false'
         AND :'r28_probe_del_ocr_idempotency' = 'false',
         'SET LOCAL ROLE gengyun_api_runtime 后，四张白名单表的 DELETE … WHERE false 必须成功；任一 42501 即失败'

  UNION ALL
  -- 46. R28-S24 真执行探针（列级读面）：十张表按授权列 SELECT … LIMIT 0 必须成功。
  --     列级授权下 has_table_privilege 恒为 false，所以“能读”只能靠真执行证明。
  SELECT 'runtime_domain_select_exec',
         :'r28_probe_sel_messages' = 'false'
         AND :'r28_probe_sel_community_posts' = 'false'
         AND :'r28_probe_sel_community_comments' = 'false'
         AND :'r28_probe_sel_community_likes' = 'false'
         AND :'r28_probe_sel_community_reports' = 'false'
         AND :'r28_probe_sel_community_moderation_decisions' = 'false'
         AND :'r28_probe_sel_community_idempotency' = 'false'
         AND :'r28_probe_sel_ocr_jobs' = 'false'
         AND :'r28_probe_sel_ocr_records' = 'false'
         AND :'r28_probe_sel_ocr_idempotency' = 'false',
         '十张表按授权列清单 SELECT … LIMIT 0 必须成功（列级授权下 has_table_privilege 恒为 false，不能当判据）'

  UNION ALL
  -- 47. R28-S24 元断言（本片真正的价值）：运行时域的表必须被**显式分类**。
  --     (a) required 的行必须存在；(b) 任何匹配运行时域命名的关系都必须在清单里；
  --     (c) 分类值只能是三种枚举之一（防拼写漂移）。
  --     新增一个域/一张表却既不授权、也不在清单里声明 forbidden ⇒ 这里判红。
  --     R28-S38：正则补 `speech_` 与 `transcriptions$`——0026 的三张表必须被点名分类，
  --     否则「建表不授权、断言也看不见」的旧坑会原样复发（transcriptions 不带 speech_ 前缀）。
  SELECT 'runtime_domain_tables_classified',
         NOT EXISTS (
           SELECT 1 FROM domain_manifest m
            WHERE m.required AND to_regclass('public.'||m.tbl) IS NULL
         )
         AND NOT EXISTS (
           SELECT 1
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relkind IN ('r','p','f')
              AND c.relname ~ '^(messages$|community_|ocr_|recognition_|speech_|transcriptions$|user_backup_copies$|deletion_|third_party_deletions$)'
              AND NOT EXISTS (SELECT 1 FROM domain_manifest m WHERE m.tbl = c.relname)
         )
         AND NOT EXISTS (
           SELECT 1 FROM domain_manifest m
            WHERE m.classification NOT IN ('granted','granted_external','forbidden')
         ),
         '运行时域的每张表必须进分类清单（granted/granted_external/forbidden）；新增表既不授权也不声明 forbidden ⇒ 失败'

  UNION ALL
  -- 48. R28-S24 反向控制：forbidden 分类的表，运行时必须零表级、零列级权限。
  SELECT 'runtime_domain_forbidden_tables_untouched',
         NOT EXISTS (
           SELECT 1
             FROM domain_manifest m
            WHERE m.classification = 'forbidden'
              AND to_regclass('public.'||m.tbl) IS NOT NULL
              AND (has_table_privilege('gengyun_api_runtime', to_regclass('public.'||m.tbl),
                                       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                   OR has_any_column_privilege('gengyun_api_runtime', to_regclass('public.'||m.tbl), 'SELECT')
                   OR has_any_column_privilege('gengyun_api_runtime', to_regclass('public.'||m.tbl), 'INSERT')
                   OR has_any_column_privilege('gengyun_api_runtime', to_regclass('public.'||m.tbl), 'UPDATE')
                   OR has_any_column_privilege('gengyun_api_runtime', to_regclass('public.'||m.tbl), 'REFERENCES'))
         ),
         -- detail 由清单生成（R28-S28）：forbidden 集合会随分类变化，手写表名必然漂移。
         'forbidden 分类（' ||
         (SELECT string_agg(m.tbl, ' / ' ORDER BY m.tbl)
            FROM domain_manifest m
           WHERE m.classification = 'forbidden') ||
         '）运行时不得有任何表级或列级权限'

  UNION ALL
  -- 49-58. R28-S24 逐表范围断言（十张表起，数据驱动 expected 清单全量）：
  --   正向：清单里的列，SELECT/INSERT/UPDATE 必须都在；
  --   反向：清单外的列，任何列级权限（含 REFERENCES）都不许有；
  --   表级：INSERT/UPDATE/TRUNCATE/REFERENCES/TRIGGER 一律不得有，
  --         DELETE 必须**恰好**等于 del 列声明（del=true 的表见各行声明；本片起含
  --         recognition_idempotency，它与 S24/S26 的三张幂等台账同性质）。
  SELECT 'runtime_grants_' || e.tbl,
         to_regclass('public.'||e.tbl) IS NOT NULL
         AND NOT EXISTS (
               SELECT 1 FROM unnest(e.sel) c
                WHERE NOT has_column_privilege('gengyun_api_runtime', 'public.'||e.tbl, c, 'SELECT'))
         AND NOT EXISTS (
               SELECT 1 FROM unnest(e.ins) c
                WHERE NOT has_column_privilege('gengyun_api_runtime', 'public.'||e.tbl, c, 'INSERT'))
         AND NOT EXISTS (
               SELECT 1 FROM unnest(e.upd) c
                WHERE NOT has_column_privilege('gengyun_api_runtime', 'public.'||e.tbl, c, 'UPDATE'))
         AND NOT EXISTS (
               SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = to_regclass('public.'||e.tbl)
                  AND a.attnum > 0 AND NOT a.attisdropped
                  AND NOT (a.attname::text = ANY (e.sel))
                  AND has_column_privilege('gengyun_api_runtime', a.attrelid, a.attname, 'SELECT'))
         AND NOT EXISTS (
               SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = to_regclass('public.'||e.tbl)
                  AND a.attnum > 0 AND NOT a.attisdropped
                  AND NOT (a.attname::text = ANY (e.ins))
                  AND has_column_privilege('gengyun_api_runtime', a.attrelid, a.attname, 'INSERT'))
         AND NOT EXISTS (
               SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = to_regclass('public.'||e.tbl)
                  AND a.attnum > 0 AND NOT a.attisdropped
                  AND NOT (a.attname::text = ANY (e.upd))
                  AND has_column_privilege('gengyun_api_runtime', a.attrelid, a.attname, 'UPDATE'))
         AND NOT EXISTS (
               SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = to_regclass('public.'||e.tbl)
                  AND a.attnum > 0 AND NOT a.attisdropped
                  AND has_column_privilege('gengyun_api_runtime', a.attrelid, a.attname, 'REFERENCES'))
         AND NOT has_table_privilege('gengyun_api_runtime', 'public.'||e.tbl, 'INSERT')
         AND NOT has_table_privilege('gengyun_api_runtime', 'public.'||e.tbl, 'UPDATE')
         AND NOT has_table_privilege('gengyun_api_runtime', 'public.'||e.tbl, 'TRUNCATE')
         AND NOT has_table_privilege('gengyun_api_runtime', 'public.'||e.tbl, 'REFERENCES')
         AND NOT has_table_privilege('gengyun_api_runtime', 'public.'||e.tbl, 'TRIGGER')
         AND has_table_privilege('gengyun_api_runtime', 'public.'||e.tbl, 'DELETE') = e.del,
         '列级 SELECT/INSERT/UPDATE 必须与清单逐列一致（清单外一列都不行）；表级只允许 del=true 的表有 DELETE，其它表级写权限一律不得有'
    FROM expected e
  UNION ALL
  -- 59-61. R28-S26 真执行探针（收藏／历史／对话域）：读、写、行锁、删都必须真能跑通。
  --     变量来自上方 R28-S26 探针段（成功 = 'false'、失败 = 'true'）。
  SELECT 'runtime_favorites_dml_exec',
         :'r28_probe_fh_role' = 'false'
         AND :'r28_probe_fav_sel' = 'false'
         AND :'r28_probe_fav_ins' = 'false'
         AND :'r28_probe_fav_lock' = 'false'
         AND :'r28_probe_fav_del' = 'false'
         AND :'r28_probe_fidem_sel' = 'false'
         AND :'r28_probe_fidem_ins' = 'false'
         AND :'r28_probe_fidem_upd' = 'false'
         AND :'r28_probe_fidem_del' = 'false',
         'SET LOCAL ROLE gengyun_api_runtime 后，favorites / favorites_idempotency 的 SELECT、INSERT … ON CONFLICT、FOR UPDATE、DELETE 零行语句必须全部成功；任一 42501 即失败'

  UNION ALL
  SELECT 'runtime_history_dml_exec',
         :'r28_probe_fh_role' = 'false'
         AND :'r28_probe_hist_sel' = 'false'
         AND :'r28_probe_hist_ins' = 'false'
         AND :'r28_probe_hist_lock' = 'false'
         AND :'r28_probe_hist_del' = 'false'
         AND :'r28_probe_hidem_sel' = 'false'
         AND :'r28_probe_hidem_ins' = 'false'
         AND :'r28_probe_hidem_upd' = 'false'
         AND :'r28_probe_hidem_del' = 'false',
         'SET LOCAL ROLE gengyun_api_runtime 后，history / history_idempotency 的 SELECT、INSERT … ON CONFLICT、FOR UPDATE、DELETE 零行语句必须全部成功；任一 42501 即失败'

  UNION ALL
  SELECT 'runtime_conversations_dml_exec',
         :'r28_probe_fh_role' = 'false'
         AND :'r28_probe_conv_sel' = 'false'
         AND :'r28_probe_conv_ins' = 'false'
         AND :'r28_probe_conv_lock' = 'false'
         AND :'r28_probe_conv_del' = 'false'
         AND :'r28_probe_turn_sel' = 'false'
         AND :'r28_probe_turn_ins' = 'false'
         AND :'r28_probe_turn_upd' = 'false'
         AND :'r28_probe_turn_settle' = 'false'
         AND :'r28_probe_turn_lock' = 'false'
         AND :'r28_probe_turn_del' = 'false'
         AND :'r28_probe_ans_sel' = 'false'
         AND :'r28_probe_ans_ins' = 'false',
         'SET LOCAL ROLE gengyun_api_runtime 后，conversations / conversation_turns / conversation_answers 的十二种真实语句形状（含两次 UPDATE 与 FOR UPDATE）必须全部成功；任一 42501 即失败'

  UNION ALL
  -- 62. R28-S26 反向控制（PUBLIC 面）：七张表的表级与列级 ACL 里都不许出现 grantee = 0。
  --     为什么不能只看 has_table_privilege：列级授权在 relacl 里根本看不见（S24 复核的遗留点①）。
  SELECT 'public_no_privilege_favorites_history',
         NOT EXISTS (
           SELECT 1
             FROM unnest(ARRAY['favorites', 'favorites_idempotency', 'history', 'history_idempotency',
                               'conversations', 'conversation_turns', 'conversation_answers']) AS t(name)
            WHERE to_regclass('public.' || t.name) IS NULL
               OR EXISTS (
                    SELECT 1
                      FROM pg_class c
                      CROSS JOIN LATERAL aclexplode(c.relacl) AS a
                     WHERE c.oid = to_regclass('public.' || t.name)
                       AND a.grantee = 0
                  )
               OR EXISTS (
                    SELECT 1
                      FROM pg_attribute att
                      CROSS JOIN LATERAL aclexplode(att.attacl) AS a
                     WHERE att.attrelid = to_regclass('public.' || t.name)
                       AND att.attnum > 0
                       AND NOT att.attisdropped
                       AND a.grantee = 0
                  )
         ),
         'PUBLIC 对收藏／历史／对话七表不得有任何表级或列级权限（20-login-roles.sql 已 REVOKE ALL … FROM PUBLIC）；表级 relacl 与列级 attacl 两处都查'

  UNION ALL
  -- 63. R28-S26 元断言（补 47 号的正则盲区）：用 favorites/history/conversation 前缀
  --     新增的关系必须进分类清单；granted 的还必须同时进 expected（否则等于「授权了但
  --     没有独立复述的列清单可复核」）。47 号的正则没有这三个前缀，故单列一条，不改它。
  SELECT 'runtime_domain_tables_classified_favorites_history',
         NOT EXISTS (
           SELECT 1
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relkind IN ('r','p','f')
              AND c.relname ~ '^(favorites|history|conversation)'
              AND NOT EXISTS (SELECT 1 FROM domain_manifest m WHERE m.tbl = c.relname)
         )
         AND NOT EXISTS (
           SELECT 1
             FROM domain_manifest m
            WHERE m.classification = 'granted'
              AND m.tbl ~ '^(favorites|history|conversation)'
              AND NOT EXISTS (SELECT 1 FROM expected e WHERE e.tbl = m.tbl)
         ),
         'favorites/history/conversation 前缀的新表必须进 domain_manifest（granted/granted_external/forbidden），且 granted 的必须在 expected 里有独立列清单'

  UNION ALL
  -- 64. R28-S28 真执行（识别域四表）：正向语句必须全部成功（成功 ⇒ 该条的 :ERROR 为 false）。
  --     与 59/60/61 同构，差别是这里插/改/删的是**真行**：CHECK、外键与 ON CONFLICT 的
  --     DO UPDATE 分支都被真正求值，零行语句是证明不了这些的。
  SELECT 'runtime_recognition_dml_exec',
         :'r28_probe_rec_role' = 'false'
         AND :'r28_probe_rec_job_sel' = 'false'
         AND :'r28_probe_rec_job_ins' = 'false'
         AND :'r28_probe_rec_job_upd' = 'false'
         AND :'r28_probe_rec_job_lock' = 'false'
         AND :'r28_probe_rec_rec_sel' = 'false'
         AND :'r28_probe_rec_rec_ins' = 'false'
         AND :'r28_probe_rec_rec_upd' = 'false'
         AND :'r28_probe_rec_rec_lock' = 'false'
         AND :'r28_probe_rec_sel_sel' = 'false'
         AND :'r28_probe_rec_sel_ins' = 'false'
         AND :'r28_probe_rec_idem_sel' = 'false'
         AND :'r28_probe_rec_idem_seed' = 'false'
         AND :'r28_probe_rec_idem_claim' = 'false'
         AND :'r28_probe_rec_idem_complete' = 'false'
         AND :'r28_probe_rec_idem_release' = 'false'
         AND :'r28_probe_rec_idem_purge' = 'false',
         'SET LOCAL ROLE gengyun_api_runtime 后，识别域四表的十七种真实语句形状必须全部成功：jobs 与 records 各 SELECT 12 列 / INSERT 12 列 / UPDATE（5 列、7 列）/ SELECT … FOR UPDATE 真行，selections SELECT 8 列 / INSERT 8 列，idempotency SELECT 4 列 / 真冲突 claim 与 complete（ON CONFLICT DO UPDATE）/ release 与 purge 两条整行 DELETE；任一 42501 即失败'

  UNION ALL
  -- 65. R28-S28 禁止面：这四条语句必须**恰好** 42501（运行时拿不到 UPDATE/DELETE）。
  --     selections 不授 UPDATE ⇒ FOR UPDATE 也拿不到（与 S26 三表的性质不同，别照抄那句
  --     「UPDATE (revision) 行锁载体」的注释）；DELETE 四表一个都不授，注销清理走
  --     request_account_deletion() 的属主级联（owner_user_id ON DELETE CASCADE）。
  SELECT 'runtime_recognition_forbidden_surface',
         :'r28_probe_rec_sel_lock_forbidden' = 'true'
         AND :'r28_probe_rec_job_del_forbidden' = 'true'
         AND :'r28_probe_rec_rec_del_forbidden' = 'true'
         AND :'r28_probe_rec_sel_del_forbidden' = 'true',
         'recognition_selections 的 SELECT … FOR UPDATE 与 jobs / records / selections 的整行 DELETE 必须全部 42501；任一成功即越权'

  UNION ALL
  -- 66. R28-S28 泛化反向控制（PUBLIC 面）：manifest 里所有 granted / granted_external 的表
  --     都不许在 relacl 或 attacl 里出现 grantee = 0。62 号是七表硬编码，本片不再加一份
  --     硬编码，而是遍历清单：S24 十表、S26 七表、S28 四表与 S38 三表一并覆盖，
  --     以后新增域自动纳入（新表只要进了清单，这条就替它查 PUBLIC 面）。
  SELECT 'public_no_privilege_domain_granted',
         NOT EXISTS (
           SELECT 1
             FROM domain_manifest m
            WHERE m.classification IN ('granted', 'granted_external')
              AND EXISTS (
                   SELECT 1
                     FROM pg_class c
                     CROSS JOIN LATERAL aclexplode(c.relacl) AS a
                    WHERE c.oid = to_regclass('public.' || m.tbl)
                      AND a.grantee = 0
                  )
               OR EXISTS (
                   SELECT 1
                     FROM pg_attribute att
                     CROSS JOIN LATERAL aclexplode(att.attacl) AS a
                    WHERE att.attrelid = to_regclass('public.' || m.tbl)
                      AND att.attnum > 0
                      AND NOT att.attisdropped
                      AND a.grantee = 0
                  )
         ),
         'manifest 里 granted / granted_external 的表对 PUBLIC 必须零权限；表级 relacl 与列级 attacl 两处都查（各授权段都 REVOKE ALL … FROM PUBLIC）'

  UNION ALL
  -- 67. R28-S38 真执行探针（写面）：语音域三表的十七种真实语句形状必须全部成功。
  --     与 64 号同形（S28 识别域），差异只在列清单来自 speech/store-pg.ts。
  --     要害在 speech_idempotency 的 SELECT 是**6 列**：`WHERE scope/key_hash` 与
  --     claim / purge 的 `RETURNING scope` 都要 SELECT 权；只授 4 列时
  --     findIdempotent :601 与 claim :627 会 42501。
  SELECT 'runtime_speech_dml_exec',
         :'r28_probe_sp_role' = 'false'
         AND :'r28_probe_sp_job_sel' = 'false'
         AND :'r28_probe_sp_job_ins' = 'false'
         AND :'r28_probe_sp_job_upd' = 'false'
         AND :'r28_probe_sp_job_lock' = 'false'
         AND :'r28_probe_sp_job_commit' = 'false'
         AND :'r28_probe_sp_rc_sel' = 'false'
         AND :'r28_probe_sp_rc_ins' = 'false'
         AND :'r28_probe_sp_rc_upd' = 'false'
         AND :'r28_probe_sp_idem_sel' = 'false'
         AND :'r28_probe_sp_idem_seed' = 'false'
         AND :'r28_probe_sp_idem_claim' = 'false'
         AND :'r28_probe_sp_idem_final' = 'false'
         AND :'r28_probe_sp_idem_seed_release' = 'false'
         AND :'r28_probe_sp_idem_release' = 'false'
         AND :'r28_probe_sp_idem_seed_expired' = 'false'
         AND :'r28_probe_sp_idem_purge' = 'false',
         'SET LOCAL ROLE gengyun_api_runtime 后，语音域三表的十七种真实语句形状必须全部成功：speech_jobs SELECT 12 列 / INSERT 12 列 / UPDATE 5 列 / SELECT … FOR UPDATE 真行 / 终态提交 UPDATE，transcriptions SELECT 13 列 / INSERT 13 列 / UPDATE 8 列，speech_idempotency SELECT 6 列 / 占位 INSERT / 真冲突 claim（ON CONFLICT DO NOTHING RETURNING scope）/ finalize 2 列 / release 与 purge 两条整行 DELETE；任一 42501 即失败'

  UNION ALL
  -- 68. R28-S38 禁止面：speech_jobs / transcriptions 的整行 DELETE 必须恰好 42501。
  --     这两表不授 DELETE（注销清理走 request_account_deletion() 的属主级联，
  --     owner_user_id 都是 ON DELETE CASCADE）；表级 INSERT/UPDATE 不授这件事由
  --     49-58 的 runtime_grants_* 逐表断言兜住（has_table_privilege 逐个 priv 比对）。
  SELECT 'runtime_speech_forbidden_surface',
         :'r28_probe_sp_job_del' = 'true'
         AND :'r28_probe_sp_rc_del' = 'true',
         'speech_jobs / transcriptions 的整行 DELETE 必须全部 42501（DELETE 只授 speech_idempotency）；任一成功即越权'
)

SELECT label, ok, detail
  FROM checks;

SELECT CASE
         WHEN count(*) FILTER (WHERE ok IS NOT TRUE) = 0 THEN 'ok'
         ELSE 'FAIL: ' || string_agg(label || ' (' || detail || ')', '; ' ORDER BY label)
                             FILTER (WHERE ok IS NOT TRUE)
       END AS verdict
  FROM r28_assert_results;

-- R28-S33：判决行之后把「有失败」变成真正的 psql 错误。全绿时 DO 块静默（末行仍是 ok、
-- 退出码 0）；有失败时 RAISE EXCEPTION ⇒ psql 以非零（3）退出，异常文本带 `FAIL` 与
-- 失败的断言名。这是本片唯一改变退出码的语句；文本判决保持不变（给人看、给旧调用方兜底）。
-- 上限 4000：83 条断言全红时标签合计约 2.5K 字符（2026-10-21 实测：总 83 条、
-- sum(length(label)+2)=2523、最长 label 50 字符），正常不会截断；若未来断言数暴涨到上限，
-- 判决行里仍有**完整**明细可查。
DO $$
DECLARE
  v_failed integer;
  v_names  text;
BEGIN
  SELECT count(*) FILTER (WHERE ok IS NOT TRUE),
         string_agg(label, ', ' ORDER BY label) FILTER (WHERE ok IS NOT TRUE)
    INTO v_failed, v_names
    FROM r28_assert_results;

  IF v_failed > 0 THEN
    RAISE EXCEPTION '90-assert-least-privilege FAIL: % 条断言未通过：%',
                    v_failed, left(v_names, 4000);
  END IF;
END
$$;
