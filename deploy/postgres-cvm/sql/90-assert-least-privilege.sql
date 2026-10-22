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

-- moderation_decisions / moderation_withdrawals（0028 / R29 段 M）：台账只写不读，
-- 所以三条探针全是**写**语句，形状逐字对着 ledger-pg.ts 抄：
--   * :74 的 INSERT_SQL 26 列 + `ON CONFLICT (job_id) DO NOTHING`；
--   * :89 的 UPDATE_SQL 14 列 + `WHERE job_id`（WHERE 里的 job_id 也吃 SELECT 权）；
--   * :66 的 SUPERSEDE_SQL 2 列 + 4 列 WHERE（target_type/target_id/target_revision/content_kind
--     与 superseded 都要读权——这条探针是"只授 INSERT/UPDATE 不授 SELECT 会 42501"的反证）；
--   * :97 的 WITHDRAW_SQL 4 列 + 三列 ON CONFLICT 冲突目标。
-- `WHERE false` ⇒ 零行、随后 SAVEPOINT 回滚，失败只留 :ERROR（不污染台账、不留探针行）。
SAVEPOINT r28_probe;
INSERT INTO public.moderation_decisions (job_id, target_type, target_id, target_revision,
                                         content_kind, port_kind, prompt_id, prompt_version,
                                         job_revision, state, lease_token, authorization_epoch,
                                         submitted_by, deadline_at, error_code, decision,
                                         reason_codes, hard_rule_passed, rule_version,
                                         model_version, contract_value, gate_holder, evidence,
                                         superseded, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000'::uuid, 'post', 'probe', 1, 'text', 'tms',
       'probe', NULL, 1, 'queued'::job_state, NULL, 1,
       '00000000-0000-0000-0000-000000000000'::uuid, NULL, NULL, 'pending',
       '[]'::jsonb, true, NULL, NULL, NULL, NULL, '{}'::jsonb, false, now(), now()
 WHERE false
ON CONFLICT (job_id) DO NOTHING;
\set r28_probe_mod_dec_ins :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
UPDATE public.moderation_decisions
   SET state = 'succeeded'::job_state, lease_token = NULL, decision = 'approved',
       reason_codes = '[]'::jsonb, hard_rule_passed = true, rule_version = NULL,
       model_version = NULL, prompt_version = NULL, contract_value = NULL,
       gate_holder = NULL, error_code = NULL, evidence = '{}'::jsonb,
       superseded = false, updated_at = now()
 WHERE false AND job_id = '00000000-0000-0000-0000-000000000000'::uuid;
\set r28_probe_mod_dec_upd :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
UPDATE public.moderation_decisions
   SET superseded = TRUE, updated_at = now()
 WHERE false
   AND target_type = 'post' AND target_id = 'probe' AND target_revision = 1
   AND content_kind = 'text' AND superseded = FALSE;
\set r28_probe_mod_dec_supersede :ERROR
ROLLBACK TO SAVEPOINT r28_probe;

SAVEPOINT r28_probe;
INSERT INTO public.moderation_withdrawals (target_type, target_id, target_revision, withdrawn_at)
SELECT 'post', 'probe', 1, now() WHERE false
ON CONFLICT (target_type, target_id, target_revision) DO NOTHING;
\set r28_probe_mod_wd_ins :ERROR
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

-- --- R28-S51 函数面执行探针 -----------------------------------------------------
-- 目的：函数面不只看 ACL，还真以运行时身份执行一次。正向 2 条必须成功（00000），
-- 反向 3 条必须恰好 42501。反向函数在权限检查阶段就被拒、函数体不执行，所以全 NULL
-- 实参安全（与 S45 的探针写法一致）。
-- 用 :SQLSTATE 而不是 :ERROR：后者只给文本，前者能精确区分 00000 与 42501。
-- 每条都套 SAVEPOINT：单条失败不污染后续探针；事务末尾统一 ROLLBACK，不留任何写入。
\set ON_ERROR_STOP off
BEGIN;
SET LOCAL ROLE gengyun_api_runtime;

SAVEPOINT r28s51_fn_list_admin_accounts;
SELECT count(*) FROM public.list_admin_accounts();
\set r28s51_fn_list_admin_accounts_state :SQLSTATE
ROLLBACK TO SAVEPOINT r28s51_fn_list_admin_accounts;

SAVEPOINT r28s51_fn_display_name;
SELECT public.admin_account_display_name('探测', gen_random_uuid());
\set r28s51_fn_display_name_state :SQLSTATE
ROLLBACK TO SAVEPOINT r28s51_fn_display_name;

SAVEPOINT r28s51_fn_apply_source_operation;
SELECT catalog_ops.apply_source_operation(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
\set r28s51_fn_apply_source_operation_state :SQLSTATE
ROLLBACK TO SAVEPOINT r28s51_fn_apply_source_operation;

SAVEPOINT r28s51_fn_apply_import;
SELECT staging_intake.apply_import(NULL,NULL,NULL);
\set r28s51_fn_apply_import_state :SQLSTATE
ROLLBACK TO SAVEPOINT r28s51_fn_apply_import;

SAVEPOINT r28s51_fn_rollback_import;
SELECT staging_intake.rollback_import(NULL,NULL,NULL,NULL);
\set r28s51_fn_rollback_import_state :SQLSTATE
ROLLBACK TO SAVEPOINT r28s51_fn_rollback_import;

ROLLBACK;
\set ON_ERROR_STOP on
-- --- R28-S51 函数面执行探针结束 -------------------------------------------------
-- --- R28-S45 真执行探针（users 登录建号路径的列级 INSERT 面；迁移 0001；零残留）------------
-- 为什么这五条必须真跑：S43 把 users 的列级 INSERT 面冻成快照（lookup + cipher 两列，来自
-- services/api/db/roles/auth_privacy.sql:11-12），S43 证据页 §7 却把「运行时能写这两列」
-- 标成待裁定。快照只能证明「清单与库里的列 ACL 一致」，证明不了「运行时真能按登录建号语句的
-- 形状写进去、越界真会被拒」。本段补前向执行面，与 checks 里的 runtime_users_login_insert_path
-- 一一对应：
--   [1] services/api/src/auth/store.ts:249-251 的建号 INSERT（只写 lookup + cipher）必须成功；
--   [2] 同形 INSERT 多写一列 nickname 必须**恰好** 42501；
--   [3] store.ts:235 的建号前查找（`WHERE wechat_subject_lookup = decode($1,'hex')`，列清单 4 列
--       = id/state/auth_epoch/revision；探针按派单 §2.1 第 3 条再带上 lookup 本身＝授权面 5 列）；
--   [4] 读未授权列 nickname 必须**恰好** 42501；
--   [5] 改未授权列 nickname 必须**恰好** 42501（运行时对 users 只有 updated_at 的列级 UPDATE）。
-- 读数记两个变量：:ERROR（失败与否）与 :SQLSTATE（**哪个**错）。:ERROR 分不出 42501 与
-- 42703，而后者说明 schema 漂移、不是权限收敛，两者不能混为一谈，所以断言逐个比对 SQLSTATE。
-- 零残留：每条 SAVEPOINT → 语句 → 记读数 → ROLLBACK TO SAVEPOINT；段末整段 ROLLBACK，
-- [1] 插的行（含 users_subject_lookup_key 唯一索引上的那条）不会留下任何痕迹。
-- 形状说明：[1] 的句形照派单 §2.1 第 1 条（两列都 decode），另加 store.ts:251 的 RETURNING id
-- ——生产语句要回读 id（会话绑定），且 RETURNING 还要这些列的 SELECT 权，所以不算加严以外的改动。
-- cipher 在 store.ts:250 的实参是 NULL；[1] 写一个真 32 字节值，比生产形状更严（text 列收
-- bytea 要走 I/O 转换），不弱于它：NULL 能过而真值不能过的权限缺口不会被漏判。
\set ON_ERROR_STOP off
BEGIN;
SET LOCAL ROLE gengyun_api_runtime;
\set r28_probe_users_role :ERROR

-- [1] 建号 INSERT（store.ts:249-251）：运行时只可能写 lookup + cipher 两列。
SAVEPOINT r28_probe_users;
INSERT INTO public.users (wechat_subject_lookup, wechat_subject_cipher)
VALUES (decode('9f2c4d6e8a0b1c3d5e7f9012a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6', 'hex'),
        decode('0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9', 'hex'))
RETURNING id \gset
\set r28_probe_users_login_insert_ok :ERROR
\set r28_probe_users_login_insert_state :SQLSTATE
ROLLBACK TO SAVEPOINT r28_probe_users;

-- [2] 禁止面：同形 INSERT 多写一列（nickname 未授权）必须恰好 42501。
SAVEPOINT r28_probe_users;
INSERT INTO public.users (wechat_subject_lookup, wechat_subject_cipher, nickname)
VALUES (decode('9f2c4d6e8a0b1c3d5e7f9012a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6', 'hex'),
        decode('0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9', 'hex'),
        'r28-s45-probe');
\set r28_probe_users_insert_extra_ok :ERROR
\set r28_probe_users_insert_extra_state :SQLSTATE
ROLLBACK TO SAVEPOINT r28_probe_users;

-- [3] 建号前查找（store.ts:235）：按 lookup 取 id/state/auth_epoch/revision（store 读 4 列），
--     探针再带上 lookup 本身 ⇒ 覆盖 auth_privacy.sql:11 授的 5 列 SELECT 面。
--     LIMIT 0 不求值任何行，只验列级 SELECT 面（运行时此刻本来就还没有这一行）。
SAVEPOINT r28_probe_users;
SELECT id, state, auth_epoch, revision, wechat_subject_lookup
  FROM public.users
 LIMIT 0;
\set r28_probe_users_select_ok :ERROR
\set r28_probe_users_select_state :SQLSTATE
ROLLBACK TO SAVEPOINT r28_probe_users;

-- [4] 禁止面：读未授权列 nickname 必须恰好 42501。
SAVEPOINT r28_probe_users;
SELECT nickname FROM public.users LIMIT 0;
\set r28_probe_users_select_extra_ok :ERROR
\set r28_probe_users_select_extra_state :SQLSTATE
ROLLBACK TO SAVEPOINT r28_probe_users;

-- [5] 禁止面：改未授权列 nickname 必须恰好 42501（WHERE false 让权限判定先于任何行求值）。
SAVEPOINT r28_probe_users;
UPDATE public.users SET nickname = nickname WHERE false;
\set r28_probe_users_update_extra_ok :ERROR
\set r28_probe_users_update_extra_state :SQLSTATE
ROLLBACK TO SAVEPOINT r28_probe_users;

ROLLBACK;
\set ON_ERROR_STOP on
-- --- R28-S45 探针结束 ----------------------------------------------------------------------

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
    ('speech_idempotency',             'granted',          true),
    -- 迁移 0028 的审核判定台账（R29 段 M）：0028 只建表、零 GRANT ⇒ 原文运行时对这两张表一列都
    -- 碰不了。段 M 补列级授权，同时把两行登记进本清单：第 47 条元断言要求"public 下每个运行时
    -- 可见关系都被分类"，漏登记即判红；required=true 表示缺表（0028 未执行）直接失败。
    ('moderation_decisions',           'granted',          true),
    ('moderation_withdrawals',         'granted',          true)
  ),
-- 授权清单的**独立复述**：下面逐表断言“清单内的列必须有、清单外的列必须没有”。
-- 它与 20-login-roles.sql 段 H 的 GRANT 是同一事实的两次写法：任一处写错/漂移都会被
-- 断言抓住（这是有意的重复，不要把它合并成“从授权结果反推”）。
  expected(tbl, sel, ins, upd, del) AS (VALUES
    -- R28-C1（#16/#17 清理链 P0-1，2026-10-21）：注销清理在 messages 上是**整行硬删**
    -- （services/api/src/messages/store-pg.ts 的 purgeOwnerRows：
    -- `DELETE FROM public.messages WHERE owner_id = $1::uuid`）⇒ del 必须是 true。
    -- 这份清单与 20-login-roles.sql 段 H 是同一事实的两次写法，改动必须成对做：
    -- 只加 GRANT 不改这里，断言 7（runtime_grants_messages）会立刻判红。
    ('messages',
     ARRAY['id','revision','owner_id','type','target_ref','read_at','created_at','event_key'],
     ARRAY['id','owner_id','type','target_ref','read_at','created_at','revision','event_key'],
     ARRAY['read_at','revision'],
     true),
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
     true),
    -- R29（迁移 0028）：审核判定台账两表。列清单与 20-login-roles.sql 段 M 的 GRANT 是同一事实的
    -- 两次写法（少一列/多一列都会被断言 49-58 抓住：清单内必须有、清单外必须没有）。
    -- SELECT 面不是"全列"：台账只写不读（byJobId/current/forRevision/history 全读内存），
    -- 这 6 列纯粹是 PG 对 UPDATE/DELETE 的 WHERE 与 INSERT 的 ON CONFLICT 冲突目标的读权要求；
    -- 名单来源 ledger-pg.ts:66 的 SUPERSEDE_SQL（target_type/target_id/target_revision/
    -- content_kind/superseded）与 :74 的 INSERT_SQL + :89 的 UPDATE_SQL（WHERE job_id）。
    ('moderation_decisions',
     ARRAY['job_id','target_type','target_id','target_revision','content_kind','superseded'],
     ARRAY['job_id','target_type','target_id','target_revision','content_kind','port_kind',
           'prompt_id','prompt_version','job_revision','state','lease_token','authorization_epoch',
           'submitted_by','deadline_at','error_code','decision','reason_codes','hard_rule_passed',
           'rule_version','model_version','contract_value','gate_holder','evidence','superseded',
           'created_at','updated_at'],
     ARRAY['state','lease_token','decision','reason_codes','hard_rule_passed','rule_version',
           'model_version','prompt_version','contract_value','gate_holder','error_code','evidence',
           'superseded','updated_at'],
     false),
    -- 下架台账：只有 INSERT（:97 的 WITHDRAW_SQL 4 列，带 ON CONFLICT DO NOTHING）；
    -- 三列主键是冲突目标（读权），没有任何 UPDATE/DELETE 语句 ⇒ upd 空、del=false。
    ('moderation_withdrawals',
     ARRAY['target_type','target_id','target_revision'],
     ARRAY['target_type','target_id','target_revision','withdrawn_at'],
     ARRAY[]::text[],
     false)
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
    -- R28-C1（#16/#17 清理链 P0-1，2026-10-21）：消息域注销清理
    -- （services/api/src/messages/store-pg.ts 的 purgeOwnerRows）有整行删除
    -- `DELETE FROM public.messages WHERE owner_id = $1::uuid`；PG 没有列级 DELETE，
    -- 只能表级授予（与收藏/历史/对话域同一条理由）。
    ('public', 'messages',               'DELETE'),
    -- R28-S28（迁移 0025）：PG 没有列级 DELETE，而 store 有两条整行删除
    -- （services/api/src/recognitions/store-pg.ts:820 release、:830 purge），只能表级授予。
    -- 本片新增后，表级写授权白名单为 13 个三元组。
    ('public', 'recognition_idempotency', 'DELETE'),
    -- R28-S38（迁移 0026）：PG 没有列级 DELETE，而语音域幂等台账有两条整行删除
    -- （services/api/src/speech/store-pg.ts:654 release、:660-662 purge），只能表级授予。
    -- 本片新增后，表级写授权白名单为 14 个三元组；speech_jobs / transcriptions
    -- 仍然完全不授 DELETE —— 若下面断言判红，先查是不是有人给这两张表加了表级写权。
    ('public', 'speech_idempotency',    'DELETE')
  ),
  -- R28-S43：运行时**经 5 个 NOLOGIN 组继承来的** public 授权面（18 张表，不在 domain_manifest 里）。
  -- 这些权限不是 20-login-roles.sql 里的域段落给的，而是 services/api/db/roles/*.sql 的角色文件
  -- 授给 gengyun_auth_privacy / gengyun_consent_granter / gengyun_profile_runtime 等组、
  -- 再由 20-login-roles.sql 的 GRANT … TO gengyun_api_runtime 带进来的。旧清单只覆盖 20-login-roles
  -- 的域段落，这 18 张表在断言里**完全不可见**——本片把它们冻成快照，让漂移可见。
  --
  -- 快照来源（2026-10-21，PG 17.11，HEAD=4e93d7b 的 26 个迁移 + 8 个角色文件 + 20-login-roles.sql
  -- 全量应用后的干净集群实测，不是抄文档）：表级 has_table_privilege 逐 priv 读；列级取
  -- **pg_attribute.attacl 里的直接条目**（grantee 是 runtime 本体或它所属的组），不是
  -- has_column_privilege 的投影 —— 表级 SELECT/INSERT/DELETE 会让 has_column_privilege 对
  -- 每一列都返回 true，若用投影填数组，「哪些列是单独授的」这条信息就丢了，反向判据也查不出
  -- 「又给某列单独 GRANT 了一条」。所以有表级 SELECT 的 6 张表（consent_policies / consent_records /
  -- feature_flags / idempotency_keys / privacy_epochs / recipients）的 sel 必须为空数组，
  -- 「表级 SELECT 覆盖全部列」这件事由 t_sel = true 表达。
  -- source_group 用五个组的 has_table_privilege / has_any_column_privilege 逐个定位
  -- （两源混授记 `A+B`，全不命中记 direct）。
  -- 本批表级：idempotency_keys 有 SELECT+INSERT+DELETE，另外 5 张（consent_policies / consent_records /
  -- feature_flags / privacy_epochs / recipients）只有 SELECT；其余 12 张表级全无。
  external_manifest(tbl, source_group, t_sel, t_ins, t_upd, t_del, sel, ins, upd) AS (VALUES
    ('admin_accounts',   'auth_privacy', false, false, false, false,
     ARRAY['id','login_name','credential_hash','state','auth_epoch','revision']::text[],
     ARRAY[]::text[], ARRAY[]::text[]),
    ('admin_scopes',     'auth_privacy', false, false, false, false,
     ARRAY['admin_id','scope','revoked_at']::text[],
     ARRAY[]::text[], ARRAY[]::text[]),
    ('admin_sessions',   'auth_privacy', false, false, false, false,
     ARRAY['id','admin_id','token_hash','audience','auth_epoch','expires_at','revoked_at']::text[],
     ARRAY['admin_id','token_hash','audience','auth_epoch','expires_at']::text[],
     ARRAY['token_hash','revoked_at']::text[]),
    ('author_links',     'auth_privacy', false, false, false, false,
     ARRAY['user_id']::text[],
     ARRAY[]::text[], ARRAY[]::text[]),
    ('consent_policies', 'consent_granter', true, false, false, false,
     ARRAY[]::text[],
     ARRAY[]::text[], ARRAY['updated_at']::text[]),
    ('consent_records',  'auth_privacy+consent_granter', true, false, false, false,
     ARRAY[]::text[],
     ARRAY['user_id','purpose','policy_version','recipient_ids','state','epoch','revision']::text[],
     ARRAY['state','withdrawn_at','revision']::text[]),
    ('crops',            'profile_runtime', false, false, false, false,
     ARRAY['id','name','active']::text[],
     ARRAY[]::text[], ARRAY['name']::text[]),
    ('exports',          'auth_privacy', false, false, false, false,
     ARRAY['user_id']::text[],
     ARRAY[]::text[], ARRAY[]::text[]),
    ('feature_flags',    'direct', true, false, false, false,
     ARRAY[]::text[],
     ARRAY[]::text[], ARRAY[]::text[]),
    ('idempotency_keys', 'auth_privacy', true, true, false, true,
     ARRAY[]::text[],
     ARRAY[]::text[],
     ARRAY['response_status','outcome']::text[]),
    ('jobs',             'auth_privacy', false, false, false, false,
     ARRAY['owner_id']::text[],
     ARRAY[]::text[], ARRAY[]::text[]),
    ('media',            'auth_privacy', false, false, false, false,
     ARRAY['owner_id']::text[],
     ARRAY[]::text[], ARRAY[]::text[]),
    ('privacy_epochs',   'auth_privacy+consent_granter', true, false, false, false,
     ARRAY[]::text[],
     ARRAY['user_id','purpose','current_epoch','state','revision']::text[],
     ARRAY['current_epoch','state','revision','updated_at']::text[]),
    ('recipients',       'consent_granter', true, false, false, false,
     ARRAY[]::text[],
     ARRAY[]::text[], ARRAY['updated_at']::text[]),
    ('regions',          'profile_runtime', false, false, false, false,
     ARRAY['code','parent_code','name','catalog_version','supported']::text[],
     ARRAY[]::text[], ARRAY['name']::text[]),
    ('sessions',         'auth_privacy', false, false, false, false,
     ARRAY['id','user_id','token_hash','audience','auth_epoch','expires_at','revoked_at']::text[],
     ARRAY['user_id','token_hash','audience','auth_epoch','expires_at']::text[],
     ARRAY['token_hash','revoked_at']::text[]),
    ('single_profiles',  'profile_runtime', false, false, false, false,
     ARRAY['user_id','crop_id','region_code','region_catalog_version','revision']::text[],
     ARRAY['user_id','crop_id','region_code','region_catalog_version','revision']::text[],
     ARRAY['crop_id','region_code','region_catalog_version','revision','updated_at']::text[]),
    ('users',            'auth_privacy', false, false, false, false,
     ARRAY['id','wechat_subject_lookup','state','auth_epoch','revision']::text[],
     ARRAY['wechat_subject_cipher','wechat_subject_lookup']::text[],
     ARRAY['updated_at']::text[])
  ),
  -- R28-S43：external_manifest 的逐条违规明细。断言 69-86 的 ok 与 detail 共用这一份定义：
  -- 一条违规一行（表名 + 一句人话），detail 里 string_agg 出来就能点名到列。
  -- 语义分界（本片最容易被后人误解的地方）：正向用 has_column_privilege（**有效权限**，含
  -- 表级投影）；反向必须读 pg_attribute.attacl（**直接列级 ACL**）—— 表级 SELECT 会让
  -- has_column_privilege 对每一列都返回 true，拿它做反向判据，「又给某列单独 GRANT 了一条」
  -- 永远查不出来。
  external_violations(tbl, what) AS (
    -- (a) 正向：快照声明过的列必须真有对应列级权（有效权限口径）
    SELECT e.tbl, '缺列级 SELECT：' || c.col
      FROM external_manifest e, LATERAL unnest(e.sel) AS c(col)
     WHERE to_regclass('public.'||e.tbl) IS NOT NULL
       AND NOT has_column_privilege('gengyun_api_runtime', 'public.'||e.tbl, c.col, 'SELECT')
    UNION ALL
    SELECT e.tbl, '缺列级 INSERT：' || c.col
      FROM external_manifest e, LATERAL unnest(e.ins) AS c(col)
     WHERE to_regclass('public.'||e.tbl) IS NOT NULL
       AND NOT has_column_privilege('gengyun_api_runtime', 'public.'||e.tbl, c.col, 'INSERT')
    UNION ALL
    SELECT e.tbl, '缺列级 UPDATE：' || c.col
      FROM external_manifest e, LATERAL unnest(e.upd) AS c(col)
     WHERE to_regclass('public.'||e.tbl) IS NOT NULL
       AND NOT has_column_privilege('gengyun_api_runtime', 'public.'||e.tbl, c.col, 'UPDATE')
    UNION ALL
    -- (b) 反向：快照没声明的列不许有直接列级 ACL（S/I/U 逐权限对数组；REFERENCES 一律不许）。
    --     只统计「能落到 runtime 身上」的 grantee：runtime 本体、它所属的组、PUBLIC。
    --     其他角色（例如 gengyun_egress_ledger 在这些表上的列级 SELECT）不属于 runtime 的
    --     授权面，不能算越界，否则这条断言会把无关角色的授权也判红。
    SELECT e.tbl, '越界列级 ' || x.privilege_type || '：' || a.attname
      FROM external_manifest e
      JOIN pg_attribute a
        ON a.attrelid = to_regclass('public.'||e.tbl)
       AND a.attnum > 0
       AND NOT a.attisdropped
      CROSS JOIN LATERAL aclexplode(a.attacl) AS x
     WHERE (x.grantee = 0 OR pg_has_role('gengyun_api_runtime', x.grantee, 'MEMBER'))
       AND x.privilege_type IN ('SELECT','INSERT','UPDATE','REFERENCES')
       AND (x.privilege_type = 'REFERENCES'
            OR (x.privilege_type = 'SELECT' AND NOT (a.attname::text = ANY (e.sel)))
            OR (x.privilege_type = 'INSERT' AND NOT (a.attname::text = ANY (e.ins)))
            OR (x.privilege_type = 'UPDATE' AND NOT (a.attname::text = ANY (e.upd))))
    UNION ALL
    -- (c) 反向：runtime 本体的**直授**只允许出现在 source_group = 'direct' 的行（feature_flags）。
    --     其余 17 张表的权限必须来自组；给 runtime 加一条直授（哪怕授的是已声明的列）就是漂移。
    SELECT e.tbl, '直授 runtime（表级 ' || x.privilege_type || '）'
      FROM external_manifest e
      JOIN pg_class c ON c.oid = to_regclass('public.'||e.tbl)
      CROSS JOIN LATERAL aclexplode(c.relacl) AS x
     WHERE e.source_group <> 'direct'
       AND x.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'gengyun_api_runtime')
    UNION ALL
    SELECT e.tbl, '直授 runtime（列级 ' || x.privilege_type || '）：' || a.attname
      FROM external_manifest e
      JOIN pg_attribute a
        ON a.attrelid = to_regclass('public.'||e.tbl)
       AND a.attnum > 0
       AND NOT a.attisdropped
      CROSS JOIN LATERAL aclexplode(a.attacl) AS x
     WHERE e.source_group <> 'direct'
       AND x.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'gengyun_api_runtime')
    UNION ALL
    -- (d) 表级位必须与快照逐位相等（有效权限口径）
    SELECT e.tbl,
           '表级 SELECT 位不符：快照 ' || e.t_sel || '，实际 ' ||
           has_table_privilege('gengyun_api_runtime', 'public.'||e.tbl, 'SELECT')
      FROM external_manifest e
     WHERE to_regclass('public.'||e.tbl) IS NOT NULL
       AND has_table_privilege('gengyun_api_runtime', 'public.'||e.tbl, 'SELECT')
           IS DISTINCT FROM e.t_sel
    UNION ALL
    SELECT e.tbl,
           '表级 INSERT 位不符：快照 ' || e.t_ins || '，实际 ' ||
           has_table_privilege('gengyun_api_runtime', 'public.'||e.tbl, 'INSERT')
      FROM external_manifest e
     WHERE to_regclass('public.'||e.tbl) IS NOT NULL
       AND has_table_privilege('gengyun_api_runtime', 'public.'||e.tbl, 'INSERT')
           IS DISTINCT FROM e.t_ins
    UNION ALL
    SELECT e.tbl,
           '表级 UPDATE 位不符：快照 ' || e.t_upd || '，实际 ' ||
           has_table_privilege('gengyun_api_runtime', 'public.'||e.tbl, 'UPDATE')
      FROM external_manifest e
     WHERE to_regclass('public.'||e.tbl) IS NOT NULL
       AND has_table_privilege('gengyun_api_runtime', 'public.'||e.tbl, 'UPDATE')
           IS DISTINCT FROM e.t_upd
    UNION ALL
    SELECT e.tbl,
           '表级 DELETE 位不符：快照 ' || e.t_del || '，实际 ' ||
           has_table_privilege('gengyun_api_runtime', 'public.'||e.tbl, 'DELETE')
      FROM external_manifest e
     WHERE to_regclass('public.'||e.tbl) IS NOT NULL
       AND has_table_privilege('gengyun_api_runtime', 'public.'||e.tbl, 'DELETE')
           IS DISTINCT FROM e.t_del
    UNION ALL
    -- (e) TRUNCATE / REFERENCES / TRIGGER 一律不得有（表级）
    SELECT e.tbl, '越界表级 ' || p.priv
      FROM external_manifest e
      CROSS JOIN (VALUES ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
     WHERE to_regclass('public.'||e.tbl) IS NOT NULL
       AND has_table_privilege('gengyun_api_runtime', 'public.'||e.tbl, p.priv)
    UNION ALL
    -- (f) 快照行必须真实存在（表被改名/删掉时前面的检查会因 to_regclass 为 NULL 而静默跳过）
    SELECT e.tbl, '库中不存在（to_regclass 为 NULL）'
      FROM external_manifest e
     WHERE to_regclass('public.'||e.tbl) IS NULL
  ),
  -- R28-S51：函数面兜底清单（与 S43 的 external_manifest 同构：把"点过名的函数"升级为
  -- "必须分类的函数面"）。为什么需要：PostgreSQL 新建函数默认把 EXECUTE 授给 PUBLIC
  -- （proacl IS NULL），而旧版只有 5 组**点名式**逐函数断言——新增 SECURITY DEFINER 函数
  -- 只要没人记得补断言，就永远不会让任何断言变红（见 §0 的缺口描述）。
  -- kind 语义：
  --   runtime  —— 运行时（gengyun_api_runtime）可执行；allowed_grantees 是除属主外**唯一**
  --               允许的 ACL 项（多一个组、少一个组都判红）。
  --   internal —— 只给运维/导入组用；运行时不可执行（断言 4 的反向探针会证明 42501）。
  --   trigger  —— 触发器函数；除属主外谁都不许有 EXECUTE（PUBLIC 也不行）。
  -- allowed_grantees 写的是**实测非属主 ACL**，不是"函数归属组"：
  --   apply_source_operation 的属主是 gengyun_source_executor、apply_import/rollback_import
  --   的属主是 gengyun_staging_executor（services/api/db/roles/source_operator.sql:16、
  --   staging_importer.sql:17-18 已 ALTER FUNCTION … OWNER TO）。注意 proacl 非 NULL 时
  --   **属主自身会以自授条目出现**（实库实测 `gengyun_source_executor=X/gengyun_source_executor`），
  --   所以断言 3 用 `a.grantee <> p.proowner` 把属主过滤掉；allowed_grantees 只列真正
  --   GRANT 给非属主的组。把属主组也写进 allowed_grantees 会让断言 3 在基线就判红
  --   （"少授 executor"），那是把 ACL 语义写错了，不是把权限收紧。
  function_surface_manifest(schema_name, func_name, kind, allowed_grantees) AS (VALUES
    ('catalog_ops',    'apply_source_operation',             'internal',
     ARRAY['gengyun_source_operator']::text[]),
    ('public',         'list_admin_accounts',                'runtime',
     ARRAY['gengyun_api_runtime']::text[]),
    ('public',         'request_account_deletion',           'runtime',
     ARRAY['gengyun_api_runtime']::text[]),
    ('public',         'restore_account',                    'runtime',
     ARRAY['gengyun_api_runtime']::text[]),
    ('public',         'set_feature_flag',                   'runtime',
     ARRAY['gengyun_api_runtime']::text[]),
    ('public',         'suspend_account',                    'runtime',
     ARRAY['gengyun_api_runtime']::text[]),
    ('public',         'admin_account_display_name',         'runtime',
     ARRAY['gengyun_api_runtime']::text[]),
    ('staging_intake', 'apply_import',                       'internal',
     ARRAY['gengyun_staging_importer']::text[]),
    ('staging_intake', 'rollback_import',                    'internal',
     ARRAY['gengyun_staging_importer']::text[]),
    ('public',         'consent_policy_immutable',           'trigger',
     ARRAY[]::text[]),
    ('public',         'admin_audit_events_reject_mutation', 'trigger',
     ARRAY[]::text[])
  ),
  -- R28-S52：跨 schema 关系面兜底清单（与 S43 的 external_manifest、S51 的
  -- function_surface_manifest 同构：把"点过名的关系"升级为"必须分类的关系面"）。
  -- 为什么需要：domain_manifest（public 表 21 granted + 1 granted_external + 4 forbidden）、
  --   external_manifest（S43 的 18 张 public 表）、function_surface_manifest（S51 的 11 个函数）
  --   三张清单覆盖的**全都只有 public**。非 public 的 4 个 schema（catalog_ops / catalog_read /
  --   knowledge_staging / staging_intake）里还有 9 个关系带组授权，而本切片之前只有
  --   preview_reader_scope（管 catalog_read.home_species）与 knowledge_runtime_scope
  --   （管 catalog_read.current_knowledge）**点名**管了 2 个，其余 7 个任何断言都不看：
  --   往 catalog_ops.operations 多授一个组、或把 catalog_read.registration_evidence 授给
  --   运行时，都不会让任何断言变红。清单把「这 9 个关系必须被分类」变成机制本身。
  -- 行语义（每个关系一行，9 行都不许省）：
  --   grantee/privs —— 该关系**除属主外**唯一允许的 ACL 项（多一个组、少一个权限都判红）；
  --                    写的是实测 relacl，不是"归属组"。
  --   NULL/NULL     —— 除属主外谁都不许有权限。当前只有 catalog_read.current_verified_sources
  --                    一个（0010 的检证投影过滤器视图，属主自读，不对任何组开放）。
  -- 字母表（CASE 映射见 cross_schema_acl，出自 aclexplode.privilege_type）：
  --   a=INSERT r=SELECT w=UPDATE d=DELETE D=TRUNCATE x=REFERENCES t=TRIGGER m=MAINTAIN。
  --   视图被 GRANT 后 relacl 里会出现属主的 arwdDxtm 默认投影，那是 ACL 物化不是授权面，
  --   断言 2 用 `a.grantee <> c.relowner` 过滤掉。
  -- 与「少授」的关系：gengyun_source_executor / gengyun_staging_executor 只在
  --   provision-db.sh 的 --with-cli-groups 形态（WITH_CLI_GROUPS=1）才创建，默认 5 组部署下
  --   这 4 行表的实测 ACL 是空集。所以断言 2 的"少授"必须沿用断言 91 的口径（S51 返修 1）：
  --   只对 pg_roles 里真实存在的角色追究。
  -- 已知盲点（证据页 §7 记录）：列级授权不进 relacl（staging_importer.sql:27/28/30 的
  --   GRANT UPDATE(col) 落在 pg_attribute.attacl），本清单与断言 2 只覆盖**表级** relacl。
  cross_schema_manifest(schema_name, rel_name, relkind, grantee, privs) AS (VALUES
    ('catalog_ops',       'operations',               'r', 'gengyun_source_executor',  'ar'),
    ('catalog_read',      'current_knowledge',        'v', 'gengyun_knowledge_runtime', 'r'),
    ('catalog_read',      'current_verified_sources', 'v', NULL::text,                 NULL::text),
    ('catalog_read',      'home_species',             'v', 'gengyun_preview_reader',   'r'),
    ('catalog_read',      'registration_evidence',    'v', 'gengyun_evidence_reader',  'r'),
    ('knowledge_staging', 'workbook_batches',         'r', 'gengyun_staging_executor', 'ard'),
    ('knowledge_staging', 'workbook_rows',            'r', 'gengyun_staging_executor', 'ar'),
    ('staging_intake',    'batches',                  'r', 'gengyun_staging_executor', 'ar'),
    ('staging_intake',    'operations',               'r', 'gengyun_staging_executor', 'ar')
  ),
  -- 断言 1/2/3 的读数源：非 public 的非系统 schema 下当前真实存在的关系
  -- （基线 = 9 行 = 清单 9 行）。relkind 收 r/p/v/m/f（表/分区表/视图/物化视图/外部表），
  -- 不含索引与序列。schema 过滤写成 `!~ '^pg_'` 而不是 `NOT LIKE 'pg_%'`：LIKE 里 `_` 是
  -- 单字符通配符，`'pg_%'` 会连 `pgx_fake` 这类 schema 一起放过。
  cross_schema_relations(schema_name, rel_name, relkind, rel_oid) AS (
    SELECT n.nspname, c.relname, c.relkind, c.oid
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND n.nspname NOT IN ('public', 'pg_catalog', 'information_schema')
       AND n.nspname !~ '^pg_'
  ),
  -- 断言 1 的差集（双向 + relkind 漂移）：
  --   ① 库里有、清单没有 —— 新关系必须显式分类，否则从"没人看"变成"有断言看"；
  --   ② 清单有、库里没有 —— 防幽灵条目（关系被改名/删掉后清单还在骗人）；
  --   ③ relkind 与清单不符 —— 视图被换成表（或反之）时授权语义会变，必须显式改清单。
  cross_schema_manifest_gaps(rel, what) AS (
    SELECT r.schema_name || '.' || r.rel_name,
           '库中存在，但清单未登记（新关系必须显式分类）'
      FROM cross_schema_relations r
     WHERE NOT EXISTS (SELECT 1
                         FROM cross_schema_manifest m
                        WHERE m.schema_name = r.schema_name
                          AND m.rel_name = r.rel_name)
    UNION ALL
    SELECT m.schema_name || '.' || m.rel_name,
           '清单登记了，但库中不存在该关系'
      FROM cross_schema_manifest m
     WHERE NOT EXISTS (SELECT 1
                         FROM cross_schema_relations r
                        WHERE r.schema_name = m.schema_name
                          AND r.rel_name = m.rel_name)
    UNION ALL
    SELECT m.schema_name || '.' || m.rel_name,
           concat('清单记的 relkind=', m.relkind, '，库里实际是 ', r.relkind)
      FROM cross_schema_manifest m
      JOIN cross_schema_relations r
        ON r.schema_name = m.schema_name
       AND r.rel_name = m.rel_name
     WHERE m.relkind <> r.relkind
  ),
  -- 断言 2 的读数：每个关系的「非属主、非 PUBLIC 的 grantee → 权限字母集合」。
  --   * 属主行（GRANT 之后 relacl 被物化时会带 owner=arwdDxtm 的默认投影）由
  --     `a.grantee <> c.relowner` 过滤；
  --   * PUBLIC（a.grantee = 0）由 `a.grantee <> 0` 过滤——那是断言 4 的面，不在这里重复判；
  --   * 同一 grantee 的多条 GRANT 会拆成多行，先按 grantee 聚合成字母集合再与清单逐格比；
  --   * 未知 privilege_type 映射成 '?'（fail-closed）：未来 PG 新增权限位时集合必然对不上，
  --     判红而不是被 string_agg 静默丢掉。
  cross_schema_acl(schema_name, rel_name, grantee, privs) AS (
    SELECT n.nspname,
           c.relname,
           r2.rolname,
           string_agg(l.letter, '' ORDER BY position(l.letter IN 'arwdDxtm'))
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
      JOIN pg_roles r2 ON r2.oid = a.grantee
      CROSS JOIN LATERAL (SELECT COALESCE(CASE a.privilege_type
                                            WHEN 'INSERT'     THEN 'a'
                                            WHEN 'SELECT'     THEN 'r'
                                            WHEN 'UPDATE'     THEN 'w'
                                            WHEN 'DELETE'     THEN 'd'
                                            WHEN 'TRUNCATE'   THEN 'D'
                                            WHEN 'REFERENCES' THEN 'x'
                                            WHEN 'TRIGGER'    THEN 't'
                                            WHEN 'MAINTAIN'   THEN 'm'
                                          END, '?') AS letter) l
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND n.nspname NOT IN ('public', 'pg_catalog', 'information_schema')
       AND n.nspname !~ '^pg_'
       AND a.grantee <> 0
       AND a.grantee <> c.relowner
     GROUP BY 1, 2, 3
  ),
  -- 断言 2 的差集：多授/少授各算一次，边界与 function_manifest_grantee_violations 一致：
  --   ① 多授（actual 有、清单没有）**永远**红——安全面；
  --   ② 少授只在清单里的角色**真实存在**（pg_roles 查到）时红；'PUBLIC' 是伪角色、恒视为存在；
  --   ③ 关系本身没登记时它的**任何**非属主授权都算多授（断言 1 已先判红，这里是第二道）；
  --   ④ 同一 grantee 的权限串不同也判红，但只点名差的那几个**字母**（不整串重报）：
  --      预期 ard 实测 ad ⇒ 少授 r；预期 r 实测 ar ⇒ 多授 a。比只比角色名更严。
  cross_schema_grantee_violations(rel, detail) AS (
    SELECT r.schema_name || '.' || r.rel_name,
           concat_ws('；',
             CASE WHEN cardinality(d.extra) > 0
                  THEN '多授 ' || array_to_string(d.extra, ' / ') END,
             CASE WHEN cardinality(d.missing) > 0
                  THEN '少授 ' || array_to_string(d.missing, ' / ') END)
      FROM cross_schema_relations r
      CROSS JOIN LATERAL (
        -- (a) 多授：按**权限字母**算差。清单里没这个 grantee ⇒ 它的整串权限都是多授；
        --     有 ⇒ 只把清单没写的字母算多授（同一组被多加一个权限也点名，而不是整串重报）。
        SELECT ARRAY(
                 SELECT a.grantee || '：' || diff.surplus
                   FROM cross_schema_acl a
                   LEFT JOIN cross_schema_manifest m
                     ON m.schema_name = a.schema_name
                    AND m.rel_name = a.rel_name
                    AND m.grantee = a.grantee
                   CROSS JOIN LATERAL (
                     SELECT string_agg(ch, '' ORDER BY position(ch IN 'arwdDxtm')) AS surplus
                       FROM regexp_split_to_table(a.privs, '') ch
                      WHERE position(ch IN COALESCE(m.privs, '')) = 0
                   ) diff
                  WHERE a.schema_name = r.schema_name
                    AND a.rel_name = r.rel_name
                    AND diff.surplus IS NOT NULL
                  ORDER BY 1) AS extra,
        -- (b) 少授：清单里有、库里缺的字母。角色不存在时整条跳过（见上方注释 ②）；
        --     组还在但被撤掉一个权限时只报缺的那个字母（预期 ard 实测 ad ⇒ 少授 r）。
               ARRAY(
                 SELECT m.grantee || '：应有 ' || diff.deficit || ' 实无'
                   FROM cross_schema_manifest m
                   LEFT JOIN cross_schema_acl a
                     ON a.schema_name = m.schema_name
                    AND a.rel_name = m.rel_name
                    AND a.grantee = m.grantee
                   CROSS JOIN LATERAL (
                     SELECT string_agg(ch, '' ORDER BY position(ch IN 'arwdDxtm')) AS deficit
                       FROM regexp_split_to_table(m.privs, '') ch
                      WHERE position(ch IN COALESCE(a.privs, '')) = 0
                   ) diff
                  WHERE m.schema_name = r.schema_name
                    AND m.rel_name = r.rel_name
                    AND m.grantee IS NOT NULL
                    AND (m.grantee = 'PUBLIC'
                         OR EXISTS (SELECT 1
                                      FROM pg_roles rr
                                     WHERE rr.rolname = m.grantee))
                    AND diff.deficit IS NOT NULL
                  ORDER BY 1) AS missing
      ) d
     WHERE cardinality(d.extra) > 0
        OR cardinality(d.missing) > 0
  ),
  -- 断言 3 的读数：运行时（gengyun_api_runtime）在这 9 个关系上的**有效**表级权限。
  -- 为什么不用 relacl：运行时的权限全部来自组继承（20-login-roles.sql:220-224 把 5 个组
  -- 授给运行时），relacl 里永远看不到 runtime 的名字；只有 has_table_privilege 会沿
  -- 成员关系求值。列级授权不抬升为表级，所以这里只问 7 个表级权限（SELECT/INSERT/UPDATE/
  -- DELETE/TRUNCATE/REFERENCES/TRIGGER；MAINTAIN 是 PG 17 的维护位，无表级 GRANT 路径）。
  cross_schema_effective(rel, priv) AS (
    SELECT r.schema_name || '.' || r.rel_name, p.priv
      FROM cross_schema_relations r
      CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
                         ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
     WHERE has_table_privilege('gengyun_api_runtime', r.rel_oid, p.priv)
  ),
  -- 断言 1 的差集：未登记的 SECURITY DEFINER + 清单里的幽灵条目（各一行）。
  function_manifest_gaps(fn, what) AS (
    SELECT n.nspname || '.' || p.proname,
           'pg_proc 中是 SECURITY DEFINER，但清单未登记'
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('public', 'catalog_ops', 'staging_intake')
       AND p.prokind = 'f'
       AND p.prosecdef
       AND NOT EXISTS (
             SELECT 1
               FROM function_surface_manifest m
              WHERE m.schema_name = n.nspname
                AND m.func_name = p.proname)
    UNION ALL
    SELECT m.schema_name || '.' || m.func_name,
           '清单登记了，但 pg_proc 中不存在同名函数'
      FROM function_surface_manifest m
     WHERE NOT EXISTS (
             SELECT 1
               FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = m.schema_name
                AND p.proname = m.func_name
                AND p.prokind = 'f')
  ),
  -- 断言 3 的读数：每条清单函数的「非属主 EXECUTE grantee 集合」。
  -- proacl IS NULL 时 aclexplode 无行 ⇒ 空集合（这正是 PG 默认 PUBLIC 可执行的状态；
  -- 它由断言 2 判红，断言 3 只回答"有没有人绕过清单多授/少授"）。
  function_manifest_grantee_sets(schema_name, func_name,
                                 actual_grantees, allowed_grantees) AS (
    SELECT m.schema_name,
           m.func_name,
           COALESCE(
             ARRAY(SELECT DISTINCT COALESCE(r.rolname, 'PUBLIC')
                     FROM pg_proc p
                     JOIN pg_namespace n ON n.oid = p.pronamespace
                     CROSS JOIN LATERAL aclexplode(p.proacl) a
                     LEFT JOIN pg_roles r ON r.oid = a.grantee
                    WHERE n.nspname = m.schema_name
                      AND p.proname = m.func_name
                      AND p.prokind = 'f'
                      AND a.privilege_type = 'EXECUTE'
                      AND a.grantee <> p.proowner
                    ORDER BY 1),
             ARRAY[]::text[]),
           m.allowed_grantees
      FROM function_surface_manifest m
  ),
  -- 多授/少授各算一次；数组比较前先按名字排序，避免 ACL 顺序造成假红。
  -- 【R28-S51 返修 1】「少授」只对**真实存在的角色**追究。理由：默认部署根本不建
  --   gengyun_source_operator / gengyun_staging_importer —— deploy/postgres-cvm/provision-db.sh:267-279
  --   的 ROLE_GROUP_FILES 基础只有 5 个组，这两个只在 --with-cli-groups（WITH_CLI_GROUPS=1，
  --   见 provision-db.sh:54/86/274-279）时才追加。因此 internal 3 条函数的 allowed_grantees
  --   在这些组缺席时不可能出现在 proacl 里；角色不存在 ⇒ 该能力本来就没被 provision，
  --   不算「少授」。否则默认部署和 CI 的 5 组链条必红，而那不是缺陷。
  --   三者边界要分清楚：① 多授（actual 有、allowed 没有）**永远**红——这是安全面；
  --   ② 少授只在 allowed 里的角色**真实存在**（pg_roles 查到）时红——组存在却被撤权仍红；
  --   ③ 'PUBLIC' 是伪角色，始终视为存在（清单当前不含 PUBLIC，留作防御）。
  function_manifest_grantee_violations(fn, detail) AS (
    SELECT g.schema_name || '.' || g.func_name,
           concat_ws('；',
             CASE WHEN cardinality(d.extra) > 0
                  THEN '多授 ' || array_to_string(d.extra, ', ') END,
             CASE WHEN cardinality(d.missing) > 0
                  THEN '少授 ' || array_to_string(d.missing, ', ') END)
      FROM function_manifest_grantee_sets g
      CROSS JOIN LATERAL (
        SELECT ARRAY(SELECT x FROM unnest(g.actual_grantees) x
                      WHERE NOT (x = ANY (g.allowed_grantees))
                      ORDER BY 1) AS extra,
               ARRAY(SELECT x FROM unnest(g.allowed_grantees) x
                      WHERE NOT (x = ANY (g.actual_grantees))
                        -- 只把「角色确实存在」的缺席算少授（PUBLIC 恒存在）
                        AND (x = 'PUBLIC'
                             OR EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = x))
                      ORDER BY 1) AS missing
      ) d
     WHERE cardinality(d.extra) > 0
        OR cardinality(d.missing) > 0
  ),
  -- R28-S45：users 登录建号路径五条真执行探针的读数（一行一条；ok 与 detail 共用这一份定义）。
  -- 与 external_violations 同一思路：断言只问「有没有失败行」，detail 把失败行拼成人话，所以判红
  -- 时一定逐条点得出是哪一条、期望什么、实际读到什么 SQLSTATE。reading 记 `SQLSTATE <码>`：
  -- 成功是 00000、越界应恰是 42501；写成 42703/42601 之类说明的是 schema 漂移，不算通过。
  users_login_probe(name, want, ok, reading) AS (VALUES
    ('users_login_insert_ok',            '成功',
     :'r28_probe_users_login_insert_ok' = 'false'
     AND :'r28_probe_users_login_insert_state' = '00000',
     'SQLSTATE ' || :'r28_probe_users_login_insert_state'),
    ('users_insert_extra_column_denied', '恰好 42501',
     :'r28_probe_users_insert_extra_ok' = 'true'
     AND :'r28_probe_users_insert_extra_state' = '42501',
     'SQLSTATE ' || :'r28_probe_users_insert_extra_state'),
    ('users_select_granted_ok',          '成功',
     :'r28_probe_users_select_ok' = 'false'
     AND :'r28_probe_users_select_state' = '00000',
     'SQLSTATE ' || :'r28_probe_users_select_state'),
    ('users_select_extra_column_denied', '恰好 42501',
     :'r28_probe_users_select_extra_ok' = 'true'
     AND :'r28_probe_users_select_extra_state' = '42501',
     'SQLSTATE ' || :'r28_probe_users_select_extra_state'),
    ('users_update_extra_column_denied', '恰好 42501',
     :'r28_probe_users_update_extra_ok' = 'true'
     AND :'r28_probe_users_update_extra_state' = '42501',
     'SQLSTATE ' || :'r28_probe_users_update_extra_state')
  ),
  -- R28-S58 身份面：SECURITY DEFINER 函数的 search_path 审计。92 号的 ok 与 detail 共用这一份
  -- 判定，避免「判红却列不出是哪个函数」。判据：proconfig 里必须有一条以 `search_path=` 开头
  -- 的设置项，且它的每个元素（去空格、去双引号后）都落在 {pg_catalog, pg_temp} 之内。
  -- 可写 schema（public / 任何业务 schema / "$user"）一旦出现在 search_path 里，SECURITY
  -- DEFINER 函数就会按调用者可影响的名字解析对象 —— 这是提权最常见的一条路。
  -- 范围：schema 属于 public / catalog_ops / staging_intake 的 prosecdef 函数（本库全部 SECDEF
  -- 落在这三处，由 2011-... 的迁移建立）；一个都查不到也算红（92 号另行判定）。
  secdef_audit(func, proconfig, pinned) AS (
    SELECT p.oid::regprocedure::text,
           COALESCE(array_to_string(p.proconfig, '; '), '(未设置 proconfig)'),
           EXISTS (
                 SELECT 1
                   FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS cfg
                  WHERE left(cfg, 12) = 'search_path='
                    AND btrim(substr(cfg, 13)) <> ''
                    AND NOT EXISTS (
                          SELECT 1
                            FROM unnest(string_to_array(
                                   replace(substr(cfg, 13), ' ', ''), ',')) AS e
                           WHERE btrim(replace(e, '"', '')) NOT IN ('pg_catalog', 'pg_temp')
                        )
           )
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('public', 'catalog_ops', 'staging_intake')
       AND p.prosecdef
  ),
  -- R28-S58 外发账本：就绪态双条件的六项实测。服务端自己怎么判断「账本可用」写在
  -- services/api/src/privacy/ledger-pg.ts:228-233，三个条件同时成立才算就绪：
  --   to_regclass('public.export_writebacks') 非空
  --   AND has_column_privilege(current_user,'public.exports','revision','UPDATE')
  --   AND has_column_privilege(current_user,'public.exports','cancelled_at','UPDATE')
  -- 任一不成立就 PrivacyError('OBJECT_UNAVAILABLE') ⇒ 409 fail-closed。注意这里查的是
  -- **当前连接用户**的权限，而运行时是靠组继承拿到的；所以断言里统一按
  -- 'gengyun_api_runtime' 这个角色名问 has_column_privilege，不依赖本会话是谁。
  -- 追加两项：egress 角色本身在不在、它有没有被授予运行时；以及 export_writebacks
  -- 有没有进过本文件的可见面清单（domain_manifest / external_manifest）。
  -- 部署形态（provision-db.sh 默认只跑 7 个组文件里的 5 个，从不执行
  -- roles/egress_ledger.sql）决定了 gengyun_egress_ledger 不会存在，于是账本在本片
  -- 恒为「未就绪」—— 那是冻结，不是缺陷，93 号对此判绿。
  ledger_readiness_state(revision_upd, cancelled_upd, egress_role, egress_grant,
                          writebacks_present, writebacks_listed) AS (
    SELECT has_column_privilege('gengyun_api_runtime', 'public.exports', 'revision', 'UPDATE'),
           has_column_privilege('gengyun_api_runtime', 'public.exports', 'cancelled_at', 'UPDATE'),
           EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gengyun_egress_ledger'),
           EXISTS (SELECT 1
                     FROM pg_auth_members m
                     JOIN pg_roles r ON r.oid = m.roleid
                     JOIN pg_roles g ON g.oid = m.member
                    WHERE g.rolname = 'gengyun_api_runtime'
                      AND r.rolname = 'gengyun_egress_ledger'),
           to_regclass('public.export_writebacks') IS NOT NULL,
           EXISTS (SELECT 1 FROM domain_manifest WHERE tbl = 'export_writebacks'
                   UNION ALL
                   SELECT 1 FROM external_manifest WHERE tbl = 'export_writebacks')
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
  -- R29 / 迁移 0028：审核判定台账的真实写路径（ledger-pg.ts 的 INSERT→UPDATE→supersede 与
  -- withdrawals 的 INSERT … ON CONFLICT DO NOTHING）。只断言 has_column_privilege 还不够：
  -- UPDATE 的 WHERE 列读权这类**跨权限组合**只有真执行才会 42501，所以这里跑零行真语句。
  SELECT 'runtime_moderation_ledger_dml_exec',
         :'r28_probe_fh_role' = 'false'
         AND :'r28_probe_mod_dec_ins' = 'false'
         AND :'r28_probe_mod_dec_upd' = 'false'
         AND :'r28_probe_mod_dec_supersede' = 'false'
         AND :'r28_probe_mod_wd_ins' = 'false',
         'SET LOCAL ROLE gengyun_api_runtime 后，moderation_decisions 的 INSERT 26 列 / UPDATE 14 列 / supersede 的 4 列 WHERE，以及 moderation_withdrawals 的 INSERT … ON CONFLICT DO NOTHING 零行语句必须全部成功；任一 42501 即失败（说明 20-login-roles.sql 段 M 的列级授权不足）'

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

  UNION ALL
  -- 69-86. R28-S43 逐表范围断言（18 张经 NOLOGIN 组继承来的 public 表）：
  --     与 49-58 同形，差异只在快照来源 —— 这些权限来自 services/api/db/roles/*.sql 的五个组，
  --     不是 20-login-roles.sql 的域段落，所以不在 expected 清单里，49-58 对它们是完全盲的。
  --     判据全部收在 external_violations（一条违规一行明细）：ok 只问「这张表有没有违规」，
  --     detail 把明细拼出来 —— 两者共用同一份定义，不会出现「判红但说不出哪一列」。
  SELECT 'runtime_grants_external_' || e.tbl,
         to_regclass('public.'||e.tbl) IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM external_violations v WHERE v.tbl = e.tbl),
         '来自 services/api/db/roles/*.sql 的组 ' || e.source_group
         || ' 继承的授权面必须与快照逐列一致（正向按有效权限查、反向按直接列级 ACL 查，清单外一列都不行）；'
         || '表级只允许 t_sel/t_ins/t_upd/t_del 声明的位，TRUNCATE/REFERENCES/TRIGGER 一律不得有；'
         || 'runtime 本体的直授只允许出现在 source_group = direct 的行；'
         || '这张表属于 roles 授权面，不是 domain_manifest 域。违规明细：'
         || COALESCE((SELECT string_agg(v.what, '；' ORDER BY v.what)
                       FROM external_violations v WHERE v.tbl = e.tbl), '（无）')
    FROM external_manifest e

  UNION ALL
  -- 87. R28-S43 元断言（本片的泛化兜底）：public 下凡运行时**可见**（表级或列级
  --     SELECT/INSERT/UPDATE/DELETE/REFERENCES）的关系，必须在 domain_manifest 或
  --     external_manifest 里被显式分类；反过来 external_manifest 的每一行也必须真存在。
  --     47 号只认「运行时域前缀」的正则，对 roles/*.sql 新授的任意表名是盲的；这条不再
  --     依赖命名约定：只要有人给 runtime 加了新授权（哪怕表名完全陌生），没进清单就判红。
  SELECT 'runtime_surface_parity',
         NOT EXISTS (
               SELECT 1
                 FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relkind IN ('r','p','f')
                  AND (has_table_privilege('gengyun_api_runtime', c.oid,
                                           'SELECT,INSERT,UPDATE,DELETE,REFERENCES')
                       OR has_any_column_privilege('gengyun_api_runtime', c.oid, 'SELECT')
                       OR has_any_column_privilege('gengyun_api_runtime', c.oid, 'INSERT')
                       OR has_any_column_privilege('gengyun_api_runtime', c.oid, 'UPDATE')
                       OR has_any_column_privilege('gengyun_api_runtime', c.oid, 'REFERENCES'))
                  AND NOT EXISTS (SELECT 1 FROM domain_manifest m   WHERE m.tbl = c.relname)
                  AND NOT EXISTS (SELECT 1 FROM external_manifest e WHERE e.tbl = c.relname)
         )
         AND NOT EXISTS (
               SELECT 1 FROM external_manifest e
                WHERE to_regclass('public.'||e.tbl) IS NULL
         ),
         'public 下的每个运行时可见关系都必须被分类（domain_manifest 或 external_manifest）；未分类、或清单里有而库里没有的：' ||
         COALESCE((
           SELECT string_agg(x.tbl, ' / ' ORDER BY x.tbl)
             FROM (
               SELECT c.relname AS tbl
                 FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relkind IN ('r','p','f')
                  AND (has_table_privilege('gengyun_api_runtime', c.oid,
                                           'SELECT,INSERT,UPDATE,DELETE,REFERENCES')
                       OR has_any_column_privilege('gengyun_api_runtime', c.oid, 'SELECT')
                       OR has_any_column_privilege('gengyun_api_runtime', c.oid, 'INSERT')
                       OR has_any_column_privilege('gengyun_api_runtime', c.oid, 'UPDATE')
                       OR has_any_column_privilege('gengyun_api_runtime', c.oid, 'REFERENCES'))
                  AND NOT EXISTS (SELECT 1 FROM domain_manifest m   WHERE m.tbl = c.relname)
                  AND NOT EXISTS (SELECT 1 FROM external_manifest e WHERE e.tbl = c.relname)
               UNION
               SELECT e.tbl FROM external_manifest e
                WHERE to_regclass('public.'||e.tbl) IS NULL
             ) x
         ), '（无）')

  UNION ALL
  -- 88. R28-S43 反向控制（PUBLIC 面）：external_manifest 的 18 张表在表级 relacl 与列级
  --     attacl 里都不许出现 grantee = 0。66 号只遍历 domain_manifest 的 granted /
  --     granted_external，这 18 张表不在清单里，旧断言覆盖不到它们。
  SELECT 'runtime_surface_no_public_leak',
         NOT EXISTS (
           SELECT 1
             FROM external_manifest e
            WHERE EXISTS (
                    SELECT 1
                      FROM pg_class c
                      CROSS JOIN LATERAL aclexplode(c.relacl) AS a
                     WHERE c.oid = to_regclass('public.'||e.tbl)
                       AND a.grantee = 0
                  )
               OR EXISTS (
                    SELECT 1
                      FROM pg_attribute att
                      CROSS JOIN LATERAL aclexplode(att.attacl) AS a
                     WHERE att.attrelid = to_regclass('public.'||e.tbl)
                       AND att.attnum > 0
                       AND NOT att.attisdropped
                       AND a.grantee = 0
                  )
         ),
         'external_manifest 的 18 张表对 PUBLIC 必须零权限（表级 relacl + 列级 attacl 两处都查）；越界表：' ||
         COALESCE((
           SELECT string_agg(e.tbl, ' / ' ORDER BY e.tbl)
             FROM external_manifest e
            WHERE EXISTS (
                    SELECT 1
                      FROM pg_class c
                      CROSS JOIN LATERAL aclexplode(c.relacl) AS a
                     WHERE c.oid = to_regclass('public.'||e.tbl)
                       AND a.grantee = 0
                  )
               OR EXISTS (
                    SELECT 1
                      FROM pg_attribute att
                      CROSS JOIN LATERAL aclexplode(att.attacl) AS a
                     WHERE att.attrelid = to_regclass('public.'||e.tbl)
                       AND att.attnum > 0
                       AND NOT att.attisdropped
                       AND a.grantee = 0
                  )
         ), '（无）')

  UNION ALL
  -- 89. R28-S45 真执行（users 登录建号路径）：五条探针必须逐条命中期望。
  --     S43 的 runtime_grants_external_users 只证明「快照清单与库里列 ACL 一致」，证明不了
  --     「运行时真能按建号语句写进去、越界真被拒」。这条补的是前向执行面：建号 INSERT 与
  --     建号前查找必须成功；多写一列 / 读未授权列 / 改未授权列必须**恰好** 42501
  --     （42703 之类说明的是 schema 漂移，不是权限收敛，不算通过）。
  SELECT 'runtime_users_login_insert_path',
         :'r28_probe_users_role' = 'false'
         AND NOT EXISTS (SELECT 1 FROM users_login_probe p WHERE p.ok IS NOT TRUE),
         'SET LOCAL ROLE gengyun_api_runtime 后，登录建号路径必须真能跑'
         || '（services/api/src/auth/store.ts:249-251 的 INSERT 两列、:235 的按 lookup 查找），'
         || '越界必须恰好 42501（读、改 nickname 两个方向都查）；'
         || '前置 SET LOCAL ROLE 实测 error=' || :'r28_probe_users_role'
         || '；逐条实测：'
         || COALESCE((SELECT string_agg(p.name || '=' || p.reading, '；' ORDER BY p.name)
                        FROM users_login_probe p), '（无）')
         || '；不满足：'
         || COALESCE((SELECT string_agg(p.name || ' 期望 ' || p.want
                                       || '、实际 ' || p.reading, '；' ORDER BY p.name)
                        FROM users_login_probe p
                       WHERE p.ok IS NOT TRUE), '（无）')
  UNION ALL
  -- 90. R28-S51 函数面清单完整性（双向）：三个 schema 下每个 SECURITY DEFINER 都必须在
  --     function_surface_manifest 里；清单里的每条也都必须真实存在（防幽灵条目）。
  --     这是"下一个 SECURITY DEFINER 函数不会再悄悄漏网"的机制本体。
  SELECT 'runtime_function_manifest_complete',
         NOT EXISTS (SELECT 1 FROM function_manifest_gaps),
         COALESCE((SELECT string_agg(fn || '：' || what, ' / ' ORDER BY fn)
                     FROM function_manifest_gaps), '（无差异）')

  UNION ALL
  -- 91. R28-S51 PUBLIC 面：三个 schema 下任何函数都不得对 PUBLIC 可执行。
  --     PG 默认给新建函数授 PUBLIC EXECUTE（proacl IS NULL），所以这条同时覆盖
  --     "新增函数忘了 REVOKE" 与 "显式 GRANT 给 PUBLIC" 两种漂移。
  SELECT 'runtime_function_no_public_execute',
         NOT EXISTS (
           SELECT 1
             FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname IN ('public', 'catalog_ops', 'staging_intake')
              AND p.prokind = 'f'
              AND has_function_privilege('public', p.oid, 'EXECUTE')
         ),
         COALESCE((
           SELECT 'PUBLIC 可执行：' ||
                  string_agg(n.nspname || '.' || p.proname, ' / '
                             ORDER BY n.nspname, p.proname)
             FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname IN ('public', 'catalog_ops', 'staging_intake')
              AND p.prokind = 'f'
              AND has_function_privilege('public', p.oid, 'EXECUTE')
         ), '（无）')

  UNION ALL
  -- 92. R28-S51 grantee 集合精确匹配：每条清单函数除属主外的 EXECUTE grantee 必须
  --     恰好等于 allowed_grantees（多授、少授都红）。属主条目在 proacl 非 NULL 时会出现，
  --     由 `a.grantee <> p.proowner` 过滤，不计入集合。
  SELECT 'runtime_function_grantee_sets',
         NOT EXISTS (SELECT 1 FROM function_manifest_grantee_violations),
         COALESCE((SELECT string_agg(fn || '（' || detail || '）', ' / ' ORDER BY fn)
                     FROM function_manifest_grantee_violations), '（无差异）')

  UNION ALL
  -- 93. R28-S51 真执行探针：ACL 正确不等于运行时真能用/真不能用，所以在
  --     SET LOCAL ROLE gengyun_api_runtime 下真跑五条（见上方 R28-S51 探针段）。
  --     正向 list_admin_accounts / admin_account_display_name 必须 00000；
  --     反向 apply_source_operation / apply_import / rollback_import 必须恰好 42501。
  SELECT 'runtime_function_exec_probe',
         :'r28s51_fn_list_admin_accounts_state' = '00000'
         AND :'r28s51_fn_display_name_state' = '00000'
         AND :'r28s51_fn_apply_source_operation_state' = '42501'
         AND :'r28s51_fn_apply_import_state' = '42501'
         AND :'r28s51_fn_rollback_import_state' = '42501',
         'list_admin_accounts=' || :'r28s51_fn_list_admin_accounts_state' ||
         '；admin_account_display_name=' || :'r28s51_fn_display_name_state' ||
         '；apply_source_operation=' || :'r28s51_fn_apply_source_operation_state' ||
         '；apply_import=' || :'r28s51_fn_apply_import_state' ||
         '；rollback_import=' || :'r28s51_fn_rollback_import_state'

  UNION ALL
  -- 94. R28-S52 跨 schema 关系面清单完整性（双向 + relkind 漂移）：非 public 的非系统 schema
  --     下每个 r/p/v/m/f 关系都必须在 cross_schema_manifest 里；清单里的每条也必须真实存在
  --     且 relkind 与清单一致（防幽灵条目、防视图被悄悄换成表）。这是"第 10 个关系不会再
  --     悄悄漏网"的机制本体——在它之前，非 public 的 9 个关系里有 7 个任何断言都不看。
  SELECT 'runtime_cross_schema_relations_complete',
         NOT EXISTS (SELECT 1 FROM cross_schema_manifest_gaps),
         COALESCE((SELECT string_agg(rel || '：' || what, ' / ' ORDER BY rel)
                     FROM cross_schema_manifest_gaps), '（无差异）')

  UNION ALL
  -- 95. R28-S52 grantee 集合逐格精确：9 个关系的「非属主、非 PUBLIC」ACL 必须恰好等于
  --     cross_schema_manifest 里的 (grantee, privs) 集合。边界与断言 92（S51 返修 1）一致：
  --       * 多授（库里有、清单没有）**永远**红——这是安全面；
  --       * 少授只在清单里的角色**真实存在**（pg_roles 查到）时红——gengyun_source_executor /
  --         gengyun_staging_executor 只在 provision-db.sh 的 --with-cli-groups 形态才创建，
  --         默认 5 组部署下这 4 行表本来就是空 ACL，撤权无从谈起，判红即误报；
  --       * 组还在但被撤掉一个权限（privs 集合不同）同样判红，比只比角色名更严。
  SELECT 'runtime_cross_schema_grantees_exact',
         NOT EXISTS (SELECT 1 FROM cross_schema_grantee_violations),
         COALESCE((SELECT string_agg(rel || '（' || detail || '）', ' / ' ORDER BY rel)
                     FROM cross_schema_grantee_violations), '（无差异）')

  UNION ALL
  -- 96. R28-S52 运行时**有效**权限面：用 has_table_privilege 沿组成员关系求值（relacl 里永远
  --     看不到 runtime 的名字，它靠 20-login-roles.sql:220-224 继承 5 个组）。9 个关系上允许
  --     为真的集合必须**恰好**是封闭白名单两项：
  --       catalog_read.current_knowledge = SELECT（经 gengyun_knowledge_runtime，20-login:224）
  --       catalog_read.home_species      = SELECT（经 gengyun_preview_reader，20-login:221）
  --     多一项 ⇒ 红（运行时摸到了白名单外的关系或权限）；两项任一读不到 ⇒ 也红（白名单项丢失）。
  --     【偏差 1，已登记】派单 §2③ 原写"恰好 current_knowledge 一项"，但真库实测 home_species
  --     也对 runtime 有效可读：20-login-roles.sql:221 明写「公共科普投影 catalog_read.home_species」，
  --     services/api/db/roles/catalog_readers.sql:31 把 SELECT 授给 gengyun_preview_reader。
  --     照字面只允许一项会在基线就判红，故按实测把白名单钉成两项（语义不变：封闭集合、双向判红）。
  SELECT 'runtime_cross_schema_effective_access',
         NOT EXISTS (
           SELECT 1
             FROM cross_schema_effective e
            WHERE (e.rel, e.priv) NOT IN (VALUES ('catalog_read.current_knowledge', 'SELECT'),
                                                 ('catalog_read.home_species', 'SELECT'))
         )
         AND has_table_privilege('gengyun_api_runtime',
                                 'catalog_read.current_knowledge', 'SELECT')
         AND has_table_privilege('gengyun_api_runtime',
                                 'catalog_read.home_species', 'SELECT'),
         '实际 = ' ||
         COALESCE((SELECT string_agg(e.rel || '=' || e.priv, ' / ' ORDER BY e.rel, e.priv)
                     FROM cross_schema_effective e), '（无）') ||
         COALESCE((SELECT '；越界 ' || string_agg(e.rel || '=' || e.priv, ' / '
                                                   ORDER BY e.rel, e.priv)
                     FROM cross_schema_effective e
                    WHERE (e.rel, e.priv) NOT IN (VALUES ('catalog_read.current_knowledge', 'SELECT'),
                                                         ('catalog_read.home_species', 'SELECT'))), '') ||
         CASE WHEN has_table_privilege('gengyun_api_runtime',
                                       'catalog_read.current_knowledge', 'SELECT')
              THEN '' ELSE '；缺 catalog_read.current_knowledge 的 SELECT' END ||
         CASE WHEN has_table_privilege('gengyun_api_runtime',
                                       'catalog_read.home_species', 'SELECT')
              THEN '' ELSE '；缺 catalog_read.home_species 的 SELECT' END

  UNION ALL
  -- 97. R28-S52 PUBLIC 面三段：
  --     ① 9 个关系上 PUBLIC 零权限——relacl 与 attacl 都查（列级 PUBLIC 授权同样不可接受，
  --        虽然本片断言 94 只覆盖表级 relacl，PUBLIC 面这里不设盲点）；
  --     ② 非 public 的非系统 schema 上 PUBLIC 既无 USAGE 也无 CREATE（迁移里
  --        `REVOKE ALL ON SCHEMA … FROM PUBLIC` 是既定做法，这条把它变成断言）；
  --     ③ public schema 上 PUBLIC **有 USAGE、无 CREATE**——`=U/pg_database_owner` 是 PG 15+
  --        对 public schema 的默认投影，属**已登记例外**：⛔ 不要改写成"零 USAGE"，那会把
  --        正常库判红，也会诱导后来人去收紧它。
  SELECT 'runtime_cross_schema_no_public',
         NOT EXISTS (
           SELECT 1
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             CROSS JOIN LATERAL aclexplode(c.relacl) a
            WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
              AND n.nspname NOT IN ('public', 'pg_catalog', 'information_schema')
              AND n.nspname !~ '^pg_'
              AND a.grantee = 0
         )
         AND NOT EXISTS (
           SELECT 1
             FROM pg_attribute att
             JOIN pg_class c ON c.oid = att.attrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             CROSS JOIN LATERAL aclexplode(att.attacl) a
            WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
              AND n.nspname NOT IN ('public', 'pg_catalog', 'information_schema')
              AND n.nspname !~ '^pg_'
              AND att.attnum > 0
              AND NOT att.attisdropped
              AND a.grantee = 0
         )
         AND NOT EXISTS (
           SELECT 1
             FROM pg_namespace n
            WHERE n.nspname NOT IN ('public', 'pg_catalog', 'information_schema')
              AND n.nspname !~ '^pg_'
              AND (has_schema_privilege('public', n.oid, 'USAGE')
                   OR has_schema_privilege('public', n.oid, 'CREATE'))
         )
         AND has_schema_privilege('public', 'public'::name, 'USAGE')
         AND NOT has_schema_privilege('public', 'public'::name, 'CREATE'),
         '非 public 关系上 PUBLIC 权限行 relacl/attacl=' ||
         (SELECT count(*)
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            CROSS JOIN LATERAL aclexplode(c.relacl) a
           WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
             AND n.nspname NOT IN ('public', 'pg_catalog', 'information_schema')
             AND n.nspname !~ '^pg_'
             AND a.grantee = 0) || '/' ||
         (SELECT count(*)
            FROM pg_attribute att
            JOIN pg_class c ON c.oid = att.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            CROSS JOIN LATERAL aclexplode(att.attacl) a
           WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
             AND n.nspname NOT IN ('public', 'pg_catalog', 'information_schema')
             AND n.nspname !~ '^pg_'
             AND att.attnum > 0
             AND NOT att.attisdropped
             AND a.grantee = 0) ||
         '；非 public schema 上 PUBLIC 有 USAGE/CREATE 的：' ||
         COALESCE((SELECT string_agg(n.nspname, ' / ' ORDER BY n.nspname)
                     FROM pg_namespace n
                    WHERE n.nspname NOT IN ('public', 'pg_catalog', 'information_schema')
                      AND n.nspname !~ '^pg_'
                      AND (has_schema_privilege('public', n.oid, 'USAGE')
                           OR has_schema_privilege('public', n.oid, 'CREATE'))), '（无）') ||
         '；public schema 上 PUBLIC USAGE=' ||
         has_schema_privilege('public', 'public'::name, 'USAGE')::text ||
         '、CREATE=' || has_schema_privilege('public', 'public'::name, 'CREATE')::text ||
         '（USAGE 为 =U/pg_database_owner 默认投影，已登记例外）'

  UNION ALL
  -- 98. R28-S58 身份面收敛（成员资格精确）：运行时在 pg_auth_members 里的成员资格必须
  --     **恰好**是 20-login-roles.sql C 段（L220-224）写死的那 5 条 —— 一条不多、一条不少，
  --     每条 admin_option = false，且被授予的组本身都是 NOLOGIN。
  --     3 号 required_memberships 是单向的「这 5 条都在」，多授一条新组、或给某条补上
  --     ADMIN OPTION，它照样判绿；而「GRANT 一个新组 TO gengyun_api_runtime」正是后来者
  --     给运行时扩权最省事的一条路（组里挂的表/列授权会被立刻继承）。同理，组角色一旦
  --     能 LOGIN，就等于多了一把能直接登进业务库的钥匙。这两面都必须在事后拦住。
  --     ⚠ 唯一的例外是 gengyun_egress_ledger：97 号的就绪臂要求它被授予运行时（外发账本
  --     的写位经这个组继承）。若这里把集合钉死成 5 条，97 号的就绪臂就永远不可能为真 ——
  --     两条断言会互相矛盾。所以白名单 = 5 条基组 + 这个待接通的组，条数 5 或 6；
  --     除它以外多授任何一条都判红。
  SELECT 'runtime_membership_exact',
         (SELECT count(*)
            FROM pg_auth_members m
            JOIN pg_roles g ON g.oid = m.member
           WHERE g.rolname = 'gengyun_api_runtime') BETWEEN 5 AND 6
         AND NOT EXISTS (
               SELECT 1
                 FROM pg_auth_members m
                 JOIN pg_roles r ON r.oid = m.roleid
                 JOIN pg_roles g ON g.oid = m.member
                WHERE g.rolname = 'gengyun_api_runtime'
                  AND (m.admin_option
                       OR r.rolcanlogin
                       OR r.rolname NOT IN ('gengyun_auth_privacy',
                                            'gengyun_preview_reader',
                                            'gengyun_consent_granter',
                                            'gengyun_profile_runtime',
                                            'gengyun_knowledge_runtime',
                                            'gengyun_egress_ledger'))
         ),
         'pg_auth_members 必须为 5 条基组（可多一条待接通的 gengyun_egress_ledger）、全部 NOLOGIN、无 ADMIN OPTION；实测（组→admin_option/可登录）：' ||
         COALESCE((
           SELECT string_agg(r.rolname || '→' || m.admin_option::text
                             || '/login=' || r.rolcanlogin::text,
                             ', ' ORDER BY r.rolname)
             FROM pg_auth_members m
             JOIN pg_roles r ON r.oid = m.roleid
             JOIN pg_roles g ON g.oid = m.member
            WHERE g.rolname = 'gengyun_api_runtime'
         ), '（无）')

  UNION ALL
  -- 99. R28-S58 身份面收敛（默认权限面）：pg_default_acl 必须零行。
  --     ALTER DEFAULT PRIVILEGES 是一条「不碰任何既有表/列、却让**将来**建出来的对象
  --     自动带权限」的旁路：本文件所有逐表/逐列断言（含 87 号 runtime_surface_parity
  --     的清单比对）看的都是「现在有什么」，而这一条改的是「以后有什么」，拦不住。
  --     部署形态（provision-db.sh + 20-login-roles.sql + roles/*.sql）全程不用它，
  --     因此零行就是正确形态；非零行既是越权，也是「有人绕过本文件改权限」的信号。
  SELECT 'no_default_acl_entries',
         (SELECT count(*) FROM pg_default_acl) = 0,
         'pg_default_acl 必须零行；实测前 5 行（角色 @ schema objtype = acl）：' ||
         COALESCE((
           SELECT string_agg(d, ' / ')
             FROM (
               SELECT d.defaclrole::regrole::text
                      || ' @ ' || CASE WHEN d.defaclnamespace = 0 THEN '(全局)'
                                       ELSE d.defaclnamespace::regnamespace::text END
                      || ' ' || d.defaclobjtype::text
                      || ' = ' || d.defaclacl::text AS d
                 FROM pg_default_acl d
                ORDER BY 1
                LIMIT 5
             ) x
         ), '（无）')

  UNION ALL
  -- 100. R28-S58 身份面收敛（角色属性矩阵）：每个 gengyun_* 角色都必须收敛在最小属性面。
  --     gengyun_cvm_owner 是迁移管理员（initdb 的引导超级用户），超级用户位天然蕴含
  --     CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS，故它是唯一整族例外（真实集群实测如此）；
  --     其余角色一个特权位都不许有，全部 INHERIT、连接数不限，且只有运行时可 LOGIN。
  --     1 号只盯 gengyun_api_runtime 一个角色的属性，5 号只查成员链 —— 「顺手 ALTER ROLE
  --     别的 gengyun_* 角色提权」这两条都看不见，这里补齐整个命名空间的横切面。
  SELECT 'role_attribute_matrix',
         (SELECT count(*) FROM pg_roles WHERE rolname LIKE 'gengyun\_%') > 0
         AND NOT EXISTS (
               SELECT 1
                 FROM pg_roles r
                WHERE r.rolname LIKE 'gengyun\_%'
                  AND (   (r.rolsuper AND r.rolname <> 'gengyun_cvm_owner')
                       OR (r.rolname <> 'gengyun_cvm_owner'
                           AND (r.rolcreatedb OR r.rolcreaterole
                                OR r.rolreplication OR r.rolbypassrls))
                       OR NOT r.rolinherit
                       OR r.rolconnlimit <> -1
                       OR (r.rolcanlogin
                           AND r.rolname NOT IN ('gengyun_api_runtime',
                                                 'gengyun_cvm_owner')))
         ),
         'gengyun_* 必须收敛（唯一超管 owner、唯一可登录的 runtime 与 owner、其余 NOLOGIN/INHERIT/connlimit=-1）；越界角色：' ||
         COALESCE((
           SELECT string_agg(r.rolname || '(super=' || r.rolsuper::text
                             || ',login=' || r.rolcanlogin::text
                             || ',db=' || r.rolcreatedb::text
                             || ',role=' || r.rolcreaterole::text
                             || ',repl=' || r.rolreplication::text
                             || ',bypass=' || r.rolbypassrls::text
                             || ',inherit=' || r.rolinherit::text
                             || ',conn=' || r.rolconnlimit::text || ')',
                             ', ' ORDER BY r.rolname)
             FROM pg_roles r
            WHERE r.rolname LIKE 'gengyun\_%'
              AND (   (r.rolsuper AND r.rolname <> 'gengyun_cvm_owner')
                   OR (r.rolname <> 'gengyun_cvm_owner'
                       AND (r.rolcreatedb OR r.rolcreaterole
                            OR r.rolreplication OR r.rolbypassrls))
                   OR NOT r.rolinherit
                   OR r.rolconnlimit <> -1
                   OR (r.rolcanlogin
                       AND r.rolname NOT IN ('gengyun_api_runtime',
                                             'gengyun_cvm_owner')))
         ), '（无）')

  UNION ALL
  -- 101. R28-S58 身份面收敛（SECURITY DEFINER 的 search_path）：三 schema 下每个 prosecdef
  --     函数都必须把 search_path 固定掉。SECURITY DEFINER 函数以属主身份执行，search_path
  --     里只要有一个可写 schema，调用者就能提前建同名对象把内部解析劫走 —— 这是拿「只读
  --     运行时」换「函数属主权限」的经典一步。基线是 8 个函数全部 `search_path=pg_catalog`
  --     （部分另带 TimeZone=UTC）。查不到任何 secdef 函数也算红：那说明审计面本身失效了。
  SELECT 'secdef_search_path_pinned',
         (SELECT count(*) FROM secdef_audit) > 0
         AND NOT EXISTS (SELECT 1 FROM secdef_audit a WHERE NOT a.pinned),
         '每个 SECURITY DEFINER 函数都必须 SET search_path 到 pg_catalog（或 pg_catalog, pg_temp）；实测 '
         || (SELECT count(*)::text FROM secdef_audit)
         || ' 个 secdef 函数（0 个也判红）；未固定的：' ||
         COALESCE((
           SELECT string_agg(a.func || ' → ' || a.proconfig, ' / ' ORDER BY a.func)
             FROM secdef_audit a
            WHERE NOT a.pinned
         ), '（无）')

  UNION ALL
  -- 102. R28-S58 外发账本（就绪态双条件 / 三形态穷尽）：账本必须「整块未就绪」或「整块就绪」。
  --     形态 A（未就绪，本片部署形态）：revision / cancelled_at 两列的 UPDATE 都没授，
  --     egress 角色不存在、也没有被授予运行时。此时服务端 fail-closed 409，是预期行为；
  --        writebacks_present 允许为 true（0011 迁移建了表，但运行时碰不到它）。
  --     形态 B（就绪）：两列 UPDATE 都有 + egress 角色存在且已授予运行时 + export_writebacks
  --     存在且已进本文件可见面清单（否则「就绪」只是权限到位、账本表却没人审）。
  --     其余一切 ⇒ 红。半接通是这条断言的靶心：只授一列、只建角色不授组、全接通但表没进
  --     清单 —— 这三种状态服务端都会继续 fail-closed，而运维看到的却是「已经接了一半」。
  --     之所以不用「两列 AND」直接做未就绪判据：那样 GRANT UPDATE (revision) 单列会落进
  --     未就绪臂判绿，半接通就从判决里消失了。
  SELECT 'runtime_ledger_readiness_biconditional',
         (SELECT (    NOT s.revision_upd AND NOT s.cancelled_upd
                  AND NOT s.egress_role   AND NOT s.egress_grant)
                 OR (    s.revision_upd AND s.cancelled_upd
                     AND s.egress_role   AND s.egress_grant
                     AND s.writebacks_present AND s.writebacks_listed)
            FROM ledger_readiness_state s),
         '外发账本必须整块未就绪或整块就绪（半接通判红）；实测 revision_upd/cancelled_upd/egress_role/egress_grant/writebacks_present/writebacks_listed = ' ||
         (SELECT s.revision_upd::text || '/' || s.cancelled_upd::text || '/'
                 || s.egress_role::text || '/' || s.egress_grant::text || '/'
                 || s.writebacks_present::text || '/' || s.writebacks_listed::text
            FROM ledger_readiness_state s)
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
-- 上限 4000：117 条断言全红时标签合计约 3.6K 字符（2026-10-21 合流后实测：总 117 条、
-- sum(length(label)+2)=3693、最长 label 50 字符），正常不会截断；若未来断言数暴涨到上限，
-- 判决行里仍有**完整**明细可查。
-- R28-S45 更新：本片新增 runtime_users_login_insert_path（第 89 条）。R28-S51 合流后本文件共
-- 108 条（S43 时 103 条 / 3239、S45 后 104 条 / 3272、S51 合流后 108 条 / 3404，均为实测）；
-- R28-S52 又追加四条跨 schema 面（94–97），共 112 条 / 3553 实测；
-- R28-S58 再追加五条身份与账本面（98–102），合流后共 117 条 / 3693。
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
