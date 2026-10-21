--- ============================================================================
-- file    :  deploy/postgres-cvm/evidence/probe-runtime-grants.sql
-- purpose :  R28-S24 运行时授权取证探针（只读探针：真执行语句、零行写入）
--
-- 背景：CVM 部署以 `gengyun_api_runtime`（LOGIN）连库。`services/api/src/
--        {messages,community,ocr}/store-pg.ts` 对这些域的真实语句，如果运行时
--        没有对应授权，会在**执行器启动时**抛 42501（本探针抓的就是这一行）。
--
-- 设计（三条纪律）：
--   1) 真执行，不靠 `has_table_privilege` 推论：`SET ROLE gengyun_api_runtime`
--      之后直接跑 store-pg.ts 的真实语句形状。列级授权在
--      `has_table_privilege(...)` 下恒为 false（列级不抬升为表级），所以
--      权限查询**不能**当判据，只有真跑才算数。
--   2) 零行写入：写语句一律写成 `INSERT ... SELECT ... WHERE false` /
--      `UPDATE ... WHERE false` / `DELETE ... WHERE false`。执行器启动时的
--      权限检查照旧发生（缺权必 42501），但零行 ⇒ 不产生数据、不触发外键或
--      CHECK 约束、不改任何计数 ⇒ 探针可反复跑、可对同一库做前后对比。
--   3) 零假设：不写死"应该有权限"，只打印每一条的原始结果；判定留给读者。
--
-- 用法（部署顺序下，provision-db.sh 之后跑）：
--   psql -X -q -h 127.0.0.1 -p 55630 -U postgres -d gengyun \
--        -v ON_ERROR_STOP=0 -f deploy/postgres-cvm/evidence/probe-runtime-grants.sql
--   注意 `-v ON_ERROR_STOP=0`：本探针**故意**让缺权语句报错后继续跑，才能一次
--   拿到整张读数表。`exit` 码因此恒为 0，判定看输出而不看 exit。
--   （provision-db.sh 只硬编码执行 sql/20-login-roles.sql 与
--     sql/90-assert-least-privilege.sql，不会扫到本文件，也不读 evidence/。）
--
-- 期望读数：
--   改前 → messages / community_* / ocr_* 全部 `ERROR: 42501: permission denied`，
--          而对照臂 public.user_backup_copies 成功（证明"连得上、角色在、只是没授权"）。
--   改后 → 同上全部成功（写语句打印 `INSERT 0 0` / `UPDATE 0` / `DELETE 0`）。
--- ============================================================================

\set ON_ERROR_STOP 0
\pset pager off
\set VERBOSITY verbose
\echo ''
\echo '### 0) 环境（镜像/角色属性/组成员）'
SELECT current_setting('server_version') AS pg_version;
SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls,
       rolreplication
  FROM pg_roles
 WHERE rolname IN ('gengyun_api_runtime', 'gengyun_cvm_owner')
 ORDER BY rolname;
SELECT r.rolname AS member_of
  FROM pg_auth_members m
  JOIN pg_roles r ON r.oid = m.roleid
  JOIN pg_roles u ON u.oid = m.member
 WHERE u.rolname = 'gengyun_api_runtime'
 ORDER BY 1;

\echo ''
\echo '### 1) 改前现状：运行时对三域的表级权限矩阵（全 f 属预期，列级授权在这里看不见）'
SELECT t AS relation,
       has_table_privilege('gengyun_api_runtime', t, 'SELECT')          AS sel,
       has_table_privilege('gengyun_api_runtime', t, 'INSERT')          AS ins,
       has_table_privilege('gengyun_api_runtime', t, 'UPDATE')          AS upd,
       has_table_privilege('gengyun_api_runtime', t, 'DELETE')          AS del,
       has_table_privilege('gengyun_api_runtime', t, 'TRUNCATE')        AS trunc
  FROM unnest(ARRAY[
         'public.messages',
         'public.community_posts',
         'public.community_comments',
         'public.community_likes',
         'public.community_reports',
         'public.community_moderation_decisions',
         'public.community_idempotency',
         'public.ocr_jobs',
         'public.ocr_records',
         'public.ocr_idempotency'
       ]) AS t;

\echo ''
\echo '### 2) 真执行探针：SET ROLE 后跑 store-pg.ts 的真实语句形状（零行）'
SET ROLE gengyun_api_runtime;

\echo '-- [messages] SELECT 列表页：store-pg 的 COLUMNS 全 8 列'
SELECT id, revision, owner_id, type, target_ref, read_at, created_at, event_key
  FROM public.messages
 WHERE owner_id = '00000000-0000-4000-8000-000000000000'
 ORDER BY created_at DESC, id DESC
 LIMIT 1;

\echo '-- [messages] INSERT（store-pg.ts:141 的 8 列 + ON CONFLICT DO NOTHING）'
INSERT INTO public.messages
       (id, owner_id, type, target_ref, read_at, created_at, revision, event_key)
SELECT gen_random_uuid(), NULL, NULL, NULL, NULL, now(), 1, NULL
 WHERE false
ON CONFLICT DO NOTHING;

\echo '-- [messages] UPDATE 读标记（store-pg.ts:189 的 SET read_at, revision）'
UPDATE public.messages
   SET read_at = now(), revision = revision + 1
 WHERE false;

\echo '-- [community_posts] SELECT 15 列'
SELECT id, revision, author_id, title, body, crop_id, region_code, media_ids,
       linked_knowledge_type, linked_knowledge_id, linked_knowledge_revision,
       visibility, audit_state, created_at, updated_at
  FROM public.community_posts
 WHERE author_id = '00000000-0000-4000-8000-000000000000';

\echo '-- [community_posts] INSERT 15 列（store-pg.ts:330 起）'
INSERT INTO public.community_posts
       (id, author_id, revision, title, body, crop_id, region_code, media_ids,
        linked_knowledge_type, linked_knowledge_id, linked_knowledge_revision,
        visibility, audit_state, created_at, updated_at)
SELECT gen_random_uuid(), NULL, 1, NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, NULL, now(), now()
 WHERE false
ON CONFLICT (id) DO NOTHING;

\echo '-- [community_posts] UPDATE 12 列（store-pg.ts:399）'
UPDATE public.community_posts
   SET revision = revision + 1, title = NULL, body = NULL, crop_id = NULL,
       region_code = NULL, media_ids = NULL, linked_knowledge_type = NULL,
       linked_knowledge_id = NULL, linked_knowledge_revision = NULL,
       visibility = NULL, audit_state = NULL, updated_at = now()
 WHERE false;

\echo '-- [community_comments] SELECT 8 列'
SELECT id, revision, post_id, author_id, body, visibility, audit_state, created_at
  FROM public.community_comments
 WHERE post_id = '00000000-0000-4000-8000-000000000000';

\echo '-- [community_comments] INSERT 8 列（store-pg.ts:531）'
INSERT INTO public.community_comments
       (id, revision, post_id, author_id, body, visibility, audit_state, created_at)
SELECT gen_random_uuid(), 1, NULL, NULL, NULL, NULL, NULL, now()
 WHERE false
ON CONFLICT (id) DO NOTHING;

\echo '-- [community_comments] UPDATE 4 列（store-pg.ts:452）'
UPDATE public.community_comments
   SET revision = revision + 1, body = NULL, visibility = NULL, audit_state = NULL
 WHERE false;

\echo '-- [community_likes] INSERT 3 列（store-pg.ts:575 点赞）'
INSERT INTO public.community_likes (target_type, target_id, user_id)
SELECT NULL, NULL, NULL
 WHERE false
ON CONFLICT DO NOTHING;

\echo '-- [community_likes] DELETE 取消点赞（store-pg.ts:587；PG 无列级 DELETE ⇒ 只能表级）'
DELETE FROM public.community_likes WHERE false;

\echo '-- [community_likes] SELECT 计数（store-pg.ts:598）'
SELECT count(*) FROM public.community_likes
 WHERE target_type = NULL AND target_id = NULL;

\echo '-- [community_reports] INSERT 10 列 + ON CONFLICT (id) DO UPDATE（store-pg.ts:662）'
INSERT INTO public.community_reports
       (id, revision, reporter_id, target_type, target_id, target_revision,
        state, reason_code, detail, created_at)
SELECT gen_random_uuid(), 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now()
 WHERE false
ON CONFLICT (id) DO UPDATE
   SET revision = community_reports.revision + 1,
       reporter_id = EXCLUDED.reporter_id,
       target_type = EXCLUDED.target_type,
       target_id = EXCLUDED.target_id,
       target_revision = EXCLUDED.target_revision,
       state = EXCLUDED.state,
       reason_code = EXCLUDED.reason_code,
       detail = EXCLUDED.detail,
       created_at = EXCLUDED.created_at;

\echo '-- [community_reports] SELECT 10 列'
SELECT id, revision, reporter_id, target_type, target_id, target_revision,
       state, reason_code, detail, created_at
  FROM public.community_reports
 WHERE reporter_id = '00000000-0000-4000-8000-000000000000';

\echo '-- [community_moderation_decisions] INSERT 12 列 + ON CONFLICT DO UPDATE（store-pg.ts:274）'
INSERT INTO public.community_moderation_decisions
       (target_type, target_id, target_revision, id, decision, reason_codes,
        hard_rule_passed, rule_version, text_digest, contract_complete,
        missing_contract_fields, created_at)
SELECT NULL, NULL, NULL, gen_random_uuid(), NULL, NULL,
       NULL, NULL, NULL, NULL,
       NULL, now()
 WHERE false
ON CONFLICT (target_type, target_id, target_revision) DO UPDATE
   SET id = EXCLUDED.id,
       decision = EXCLUDED.decision,
       reason_codes = EXCLUDED.reason_codes,
       hard_rule_passed = EXCLUDED.hard_rule_passed,
       rule_version = EXCLUDED.rule_version,
       text_digest = EXCLUDED.text_digest,
       contract_complete = EXCLUDED.contract_complete,
       missing_contract_fields = EXCLUDED.missing_contract_fields,
       created_at = EXCLUDED.created_at;

\echo '-- [community_moderation_decisions] SELECT 12 列'
SELECT id, target_type, target_id, target_revision, decision, reason_codes,
       hard_rule_passed, rule_version, text_digest, contract_complete,
       missing_contract_fields, created_at
  FROM public.community_moderation_decisions
 WHERE id = '00000000-0000-4000-8000-000000000000';

\echo '-- [community_idempotency] DELETE 过期行（store-pg.ts:703/732/761；claim 的第一步）'
DELETE FROM public.community_idempotency WHERE false;

\echo '-- [community_idempotency] SELECT 回执（store-pg.ts:708）'
SELECT request_hash, response_status, outcome, expires_at
  FROM public.community_idempotency
 WHERE scope = NULL AND key_hash = NULL;

\echo '-- [community_idempotency] INSERT 6 列（store-pg.ts:737）'
INSERT INTO public.community_idempotency
       (scope, key_hash, request_hash, response_status, outcome, expires_at)
SELECT NULL, NULL, NULL, NULL, NULL, now()
 WHERE false
ON CONFLICT (scope, key_hash) DO NOTHING;

\echo '-- [community_idempotency] UPDATE 终态（store-pg.ts:749，WHERE outcome IS NULL）'
UPDATE public.community_idempotency
   SET response_status = NULL, outcome = NULL
 WHERE false;

\echo '-- [ocr_jobs] SELECT 12 列'
SELECT id, revision, kind, owner_user_id, ocr_id, media_id, media_revision,
       state, deadline_at, created_at, updated_at, error_code
  FROM public.ocr_jobs
 WHERE owner_user_id = '00000000-0000-4000-8000-000000000000';

\echo '-- [ocr_jobs] INSERT 12 列（store-pg.ts:JOB_COLUMNS）'
INSERT INTO public.ocr_jobs
       (id, revision, kind, owner_user_id, ocr_id, media_id, media_revision,
        state, deadline_at, created_at, updated_at, error_code)
SELECT gen_random_uuid(), 1, NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, now(), now(), NULL
 WHERE false
ON CONFLICT (id) DO NOTHING;

\echo '-- [ocr_jobs] UPDATE 认领（store-pg.ts:520 的 SET revision,state,deadline_at,updated_at,error_code）'
UPDATE public.ocr_jobs
   SET revision = revision + 1, state = NULL, deadline_at = NULL,
       updated_at = now(), error_code = NULL
 WHERE false;

\echo '-- [ocr_jobs] SELECT ... FOR UPDATE（store-pg.ts:540）'
SELECT id FROM public.ocr_jobs WHERE false FOR UPDATE;

\echo '-- [ocr_records] INSERT 12 列（store-pg.ts:RECORD_COLUMNS）'
INSERT INTO public.ocr_records
       (id, revision, owner_user_id, media_id, media_revision, raw_fields,
        corrected_fields, verification, model_version, created_at, updated_at, deleted)
SELECT gen_random_uuid(), 1, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, now(), now(), false
 WHERE false
ON CONFLICT (id) DO NOTHING;

\echo '-- [ocr_records] SELECT 12 列'
SELECT id, revision, owner_user_id, media_id, media_revision, raw_fields,
       corrected_fields, verification, model_version, created_at, updated_at, deleted
  FROM public.ocr_records
 WHERE owner_user_id = '00000000-0000-4000-8000-000000000000';

\echo '-- [ocr_records] UPDATE 7 列（store-pg.ts:598）'
UPDATE public.ocr_records
   SET revision = revision + 1, raw_fields = NULL, corrected_fields = NULL,
       verification = NULL, model_version = NULL, updated_at = now(), deleted = false
 WHERE false;

\echo '-- [ocr_idempotency] SELECT 回执（store-pg.ts:632）'
SELECT request_hash, payload, pending, expires_at
  FROM public.ocr_idempotency
 WHERE scope = NULL AND key_hash = NULL;

\echo '-- [ocr_idempotency] INSERT 6 列 + ON CONFLICT DO UPDATE（store-pg.ts:655）'
INSERT INTO public.ocr_idempotency
       (scope, key_hash, request_hash, payload, pending, expires_at)
SELECT NULL, NULL, NULL, NULL, NULL, now()
 WHERE false
ON CONFLICT (scope, key_hash) DO UPDATE
   SET request_hash = EXCLUDED.request_hash,
       payload = EXCLUDED.payload,
       pending = EXCLUDED.pending,
       expires_at = EXCLUDED.expires_at;

\echo '-- [ocr_idempotency] UPDATE 放行（store-pg.ts:674）'
UPDATE public.ocr_idempotency
   SET payload = NULL, pending = false
 WHERE false;

\echo '-- [ocr_idempotency] DELETE 释放/清理（store-pg.ts:686/693）'
DELETE FROM public.ocr_idempotency WHERE false;

\echo ''
\echo '### 3) 对照臂（control）：同一角色下【已有授权】的表必须成功 —— 证明缺权是"没授权"而非"连不上"'
\echo '-- [control] public.user_backup_copies：列级授权经 gengyun_auth_privacy 组继承（改前即有）'
SELECT count(*) AS user_backup_copies_rows FROM public.user_backup_copies;
\echo '-- [control] public.feature_flags：表级 SELECT（改前即有）'
SELECT count(*) AS feature_flags_rows FROM public.feature_flags;
\echo '-- [control] public.idempotency_keys：表级 SELECT/INSERT/UPDATE/DELETE（改前即有，且是 90-assert 的唯一豁免）'
SELECT count(*) AS idempotency_keys_rows FROM public.idempotency_keys;

RESET ROLE;

\echo ''
\echo '### 4) 收尾：运行时在【库内全部关系】上的表级 DML 清单（应当只有 90-assert 豁免的那张）'
SELECT n.nspname || '.' || c.relname AS relation_with_table_level_dml,
       has_table_privilege('gengyun_api_runtime', c.oid, 'INSERT')   AS ins,
       has_table_privilege('gengyun_api_runtime', c.oid, 'UPDATE')   AS upd,
       has_table_privilege('gengyun_api_runtime', c.oid, 'DELETE')   AS del
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p', 'f')
   AND n.nspname NOT IN ('pg_catalog', 'information_schema')
   AND n.nspname NOT LIKE 'pg\_%'
   AND (has_table_privilege('gengyun_api_runtime', c.oid, 'INSERT')
     OR has_table_privilege('gengyun_api_runtime', c.oid, 'UPDATE')
     OR has_table_privilege('gengyun_api_runtime', c.oid, 'DELETE'))
 ORDER BY 1;
-- ---------------------------------------------------------------------------
-- 5) R28-S26 收藏／历史／对话域（迁移 0013 / 0018）的零行探针
--    改前（HEAD 7168096）逐条 42501 permission denied for table …；改后必须逐条通过。
--    角色能不能连、能不能读已授权表，由上方的控制臂（3 节）证明；
--    这里只用真实语句形状回答「这些语句在运行时身份下到底能不能跑」。
--    ⛔ 全部零行：SELECT … WHERE false / INSERT … SELECT … WHERE false /
--       UPDATE … WHERE false / DELETE … WHERE false（不写、不改、不删任何真实行）。
-- ---------------------------------------------------------------------------
SET ROLE gengyun_api_runtime;

\echo '-- [5] 收藏／历史／对话域的零行探针（R28-S26，迁移 0013 / 0018）'

\echo '-- [favorites] SELECT 7 列 / INSERT … ON CONFLICT DO NOTHING / FOR UPDATE / DELETE'
SELECT id, owner_id, target_type, target_id, target_revision, revision, created_at
  FROM public.favorites WHERE false;
INSERT INTO public.favorites (id, owner_id, target_type, target_id, target_revision, revision, created_at)
SELECT gen_random_uuid(), gen_random_uuid(), 'species', 'probe', 1, 1, now() WHERE false
ON CONFLICT DO NOTHING RETURNING id;
SELECT id, owner_id, target_type, target_id, target_revision, revision, created_at
  FROM public.favorites WHERE false FOR UPDATE;
DELETE FROM public.favorites WHERE false RETURNING id;

\echo '-- [history] SELECT 11 列 / INSERT … ON CONFLICT DO NOTHING / FOR UPDATE / DELETE'
SELECT id, owner_id, kind, target_type, target_id, target_revision, revision,
       job_id, job_state, event_key, created_at
  FROM public.history WHERE false;
INSERT INTO public.history (id, owner_id, kind, target_type, target_id, target_revision, revision,
                            job_id, job_state, event_key, created_at)
SELECT gen_random_uuid(), gen_random_uuid(), 'recognition', 'species', 'probe', 1, 1,
       'probe', 'queued', 'probe', now() WHERE false
ON CONFLICT DO NOTHING RETURNING id;
SELECT id, owner_id, kind, target_type, target_id, target_revision, revision,
       job_id, job_state, event_key, created_at
  FROM public.history WHERE false FOR UPDATE;
DELETE FROM public.history WHERE false RETURNING id;

\echo '-- [history_idempotency] SELECT 6 列 / 认领（ON CONFLICT DO UPDATE）/ 落结果 / 过期与释放 DELETE'
SELECT scope, key_hash, request_hash, response_status, outcome, expires_at
  FROM public.history_idempotency WHERE false;
INSERT INTO public.history_idempotency (scope, key_hash, request_hash, response_status, outcome, expires_at)
SELECT 'probe', 'probe', 'probe', 200, NULL, now() WHERE false
ON CONFLICT (scope, key_hash) DO UPDATE
   SET request_hash = EXCLUDED.request_hash,
       response_status = EXCLUDED.response_status,
       outcome = NULL,
       expires_at = EXCLUDED.expires_at
 WHERE public.history_idempotency.expires_at <= now()
RETURNING scope;
UPDATE public.history_idempotency
   SET outcome = '{}'::jsonb, response_status = 200
 WHERE false AND outcome IS NULL
RETURNING scope;
DELETE FROM public.history_idempotency
 WHERE false AND expires_at <= now()
RETURNING scope;

\echo '-- [favorites_idempotency] 同上'
SELECT scope, key_hash, request_hash, response_status, outcome, expires_at
  FROM public.favorites_idempotency WHERE false;
INSERT INTO public.favorites_idempotency (scope, key_hash, request_hash, response_status, outcome, expires_at)
SELECT 'probe', 'probe', 'probe', 200, NULL, now() WHERE false
ON CONFLICT (scope, key_hash) DO UPDATE
   SET request_hash = EXCLUDED.request_hash,
       response_status = EXCLUDED.response_status,
       outcome = NULL,
       expires_at = EXCLUDED.expires_at
 WHERE public.favorites_idempotency.expires_at <= now()
RETURNING scope;
UPDATE public.favorites_idempotency
   SET outcome = '{}'::jsonb, response_status = 200
 WHERE false AND outcome IS NULL
RETURNING scope;
DELETE FROM public.favorites_idempotency
 WHERE false AND expires_at <= now()
RETURNING scope;

\echo '-- [conversations] SELECT 6 列 / INSERT 6 列 / FOR UPDATE / DELETE'
SELECT id, owner_id, revision, conditions, created_at, updated_at
  FROM public.conversations WHERE false;
INSERT INTO public.conversations (id, owner_id, revision, conditions, created_at, updated_at)
SELECT gen_random_uuid(), gen_random_uuid(), 1, NULL, now(), now() WHERE false
RETURNING id, owner_id, revision, conditions, created_at, updated_at;
SELECT id, owner_id, revision, conditions, created_at, updated_at
  FROM public.conversations WHERE false FOR UPDATE;
DELETE FROM public.conversations WHERE false RETURNING id;

\echo '-- [conversation_turns] SELECT 14 列 / INSERT 13 列 / 认领与落结果 UPDATE / FOR UPDATE / DELETE'
SELECT id, conversation_id, owner_id, revision, input_text, transcription_ref,
       job_id, job_state, job_deadline_at, job_created_at, job_error_code, answer_id,
       created_at, updated_at
  FROM public.conversation_turns WHERE false;
INSERT INTO public.conversation_turns (id, conversation_id, owner_id, revision, input_text,
                                       transcription_ref, job_id, job_state, job_deadline_at,
                                       job_created_at, job_error_code, created_at, updated_at)
SELECT gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 'probe',
       NULL, gen_random_uuid(), 'queued', now(), now(), NULL, now(), now() WHERE false
RETURNING id, conversation_id, owner_id, revision, input_text, transcription_ref,
          job_id, job_state, job_deadline_at, job_created_at, job_error_code, answer_id,
          created_at, updated_at;
UPDATE public.conversation_turns
   SET job_state = 'running', revision = revision + 1, updated_at = now()
 WHERE false AND job_state = 'queued'
RETURNING id;
UPDATE public.conversation_turns
   SET job_state = 'succeeded', job_error_code = NULL, answer_id = COALESCE(NULL::uuid, answer_id),
       revision = revision + 1, updated_at = now()
 WHERE false AND job_state IN ('queued', 'running')
RETURNING id;
SELECT id FROM public.conversation_turns WHERE false FOR UPDATE;
DELETE FROM public.conversation_turns WHERE false RETURNING id;

\echo '-- [conversation_answers] SELECT 14 列 / INSERT 14 列（无 UPDATE、无 DELETE：行只随 turn 级联）'
SELECT id, turn_id, owner_id, revision, status, checked_text, check_state, citations,
       dose_cards, model_version, prompt_version, rule_version, created_at, updated_at
  FROM public.conversation_answers WHERE false;
INSERT INTO public.conversation_answers (id, turn_id, owner_id, revision, status, checked_text,
                                         check_state, citations, dose_cards, model_version,
                                         prompt_version, rule_version, created_at, updated_at)
SELECT gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 'answered', 'probe',
       'passed', '[]'::jsonb, '[]'::jsonb, 'probe', 'probe', 'probe', now(), now() WHERE false
RETURNING id;

RESET ROLE;

\echo '-- [5] 收藏／历史／对话域探针结束（失败行会以 ERROR: 42501 … 出现，成功行无输出）'

-- ---------------------------------------------------------------------------
-- 6) R28-S28 识别域（迁移 0025）四表的零行探针
--    改前（c06d232）：运行时对这四表整表零权限，下面每条正向语句都会 42501；
--    改后（段 J）：正向语句必须逐条通过，末尾「禁止面」四条必须仍然 42501。
--    ⛔ 正向语句全部零行：SELECT … WHERE false / INSERT … SELECT … WHERE false /
--       UPDATE … WHERE false / DELETE … WHERE false。
--       真行探针（CHECK、外键、真冲突的 ON CONFLICT）在 90-assert 的 R28-S28 段里，
--       这里只回答「运行时身份下这些形状能不能跑」，不往库里写任何一行。
-- ---------------------------------------------------------------------------
SET ROLE gengyun_api_runtime;

\echo '-- [6] 识别域的零行探针（R28-S28，迁移 0025）'

\echo '-- [recognition_jobs] SELECT 12 列 / INSERT 12 列 / UPDATE 5 列 / FOR UPDATE（无 DELETE：只由注销级联）'
SELECT id, revision, kind, owner_user_id, recognition_id, media_id, media_revision,
       state, deadline_at, created_at, updated_at, error_code
  FROM public.recognition_jobs WHERE false;
INSERT INTO public.recognition_jobs (id, revision, kind, owner_user_id, recognition_id,
                                     media_id, media_revision, state, deadline_at,
                                     created_at, updated_at, error_code)
SELECT gen_random_uuid(), 1, 'recognition', gen_random_uuid(), gen_random_uuid(),
       gen_random_uuid(), 1, 'queued', now(), now(), now(), NULL WHERE false
RETURNING id;
UPDATE public.recognition_jobs
   SET revision = revision + 1, state = 'succeeded', deadline_at = deadline_at,
       updated_at = now(), error_code = NULL
 WHERE false AND revision = 1
RETURNING id;
SELECT id FROM public.recognition_jobs WHERE false FOR UPDATE;

\echo '-- [recognition_records] SELECT 12 列 / INSERT 12 列 / UPDATE 7 列 / FOR UPDATE（无 DELETE）'
SELECT id, revision, owner_user_id, media_id, media_revision, candidates,
       uncertainty_reasons, selected_species_id, model_version, created_at, updated_at, deleted
  FROM public.recognition_records WHERE false;
INSERT INTO public.recognition_records (id, revision, owner_user_id, media_id, media_revision,
                                        candidates, uncertainty_reasons, selected_species_id,
                                        model_version, created_at, updated_at, deleted)
SELECT gen_random_uuid(), 1, gen_random_uuid(), gen_random_uuid(), 1,
       '[]'::jsonb, '[]'::jsonb, NULL, 'probe', now(), now(), false WHERE false
RETURNING id;
UPDATE public.recognition_records
   SET revision = revision + 1, candidates = candidates,
       uncertainty_reasons = uncertainty_reasons, selected_species_id = NULL,
       model_version = model_version, updated_at = now(), deleted = false
 WHERE false AND revision = 1
RETURNING id;
SELECT id FROM public.recognition_records WHERE false FOR UPDATE;

\echo '-- [recognition_selections] SELECT 8 列 / INSERT 8 列（追加型、无 UPDATE；故 FOR UPDATE 属于禁止面）'
SELECT id, revision, recognition_id, owner_user_id, species_id, provenance, decided_at, linkage
  FROM public.recognition_selections WHERE false;
INSERT INTO public.recognition_selections (id, revision, recognition_id, owner_user_id,
                                           species_id, provenance, decided_at, linkage)
SELECT gen_random_uuid(), 1, gen_random_uuid(), gen_random_uuid(),
       'probe', 'human', now(), '{}'::jsonb WHERE false
RETURNING id;

\echo '-- [recognition_idempotency] SELECT 4 列 / claim 与 complete 的 ON CONFLICT DO UPDATE / release 与 purge 两条 DELETE'
SELECT request_hash, payload, pending, expires_at
  FROM public.recognition_idempotency WHERE false;
INSERT INTO public.recognition_idempotency (scope, key_hash, request_hash, payload, pending, expires_at)
SELECT 'probe', 'probe', 'probe', '{}'::jsonb, true, now() WHERE false
ON CONFLICT (scope, key_hash) DO UPDATE
   SET request_hash = EXCLUDED.request_hash,
       payload = EXCLUDED.payload,
       pending = EXCLUDED.pending,
       expires_at = EXCLUDED.expires_at
 WHERE public.recognition_idempotency.expires_at <= now()
RETURNING scope;
INSERT INTO public.recognition_idempotency (scope, key_hash, request_hash, payload, pending, expires_at)
SELECT 'probe', 'probe', 'probe', '{}'::jsonb, false, now() WHERE false
ON CONFLICT (scope, key_hash) DO UPDATE
   SET request_hash = EXCLUDED.request_hash,
       payload = EXCLUDED.payload,
       pending = EXCLUDED.pending,
       expires_at = EXCLUDED.expires_at;
DELETE FROM public.recognition_idempotency
 WHERE false AND pending
RETURNING scope;
DELETE FROM public.recognition_idempotency
 WHERE false AND expires_at <= now()
RETURNING scope;

\echo '-- 以下是禁止面：四表 DELETE 与 selections 的 FOR UPDATE 必须全部 42501'
\echo '--   （DELETE 只由 request_account_deletion() 以属主身份级联；selections 不授 UPDATE）'
DELETE FROM public.recognition_jobs WHERE false RETURNING id;
DELETE FROM public.recognition_records WHERE false RETURNING id;
DELETE FROM public.recognition_selections WHERE false RETURNING id;
SELECT id FROM public.recognition_selections WHERE false FOR UPDATE;

RESET ROLE;

\echo '-- [6] 识别域探针结束（正向行成功即无输出；上面四条禁止面各应有一行 ERROR: 42501 …）'

-- ---------------------------------------------------------------------------
-- 7) R28-S38 语音域（迁移 0026）三表的零行探针
--    改前（fcb42e9）：0026 只建了表、没有任何授段，运行时对这三表整表零权限，
--    下面每条正向语句都会 42501；改后（段 K）：正向语句必须逐条通过，末尾「禁止面」两条必须仍然 42501。
--    ⛔ 正向语句全部零行：SELECT … WHERE false / INSERT … SELECT … WHERE false /
--       UPDATE … WHERE false / DELETE … WHERE false。
--       真行探针（0026 的 CHECK、owner_user_id 外键、真冲突的 ON CONFLICT DO NOTHING）在
--       90-assert 的 R28-S38 段里，这里只回答「运行时身份下这些形状能不能跑」，不往库里写任何一行。
--    注：speech_idempotency 的 SELECT 是全部 6 列——`WHERE scope/key_hash` 与 `RETURNING scope`
--       都要 SELECT 权，实测只授 4 列会在 findIdempotent 与 claim 上 42501。
-- ---------------------------------------------------------------------------
SET ROLE gengyun_api_runtime;

\echo '-- [7] 语音域的零行探针（R28-S38，迁移 0026）'

\echo '-- [speech_jobs] SELECT 12 列 / INSERT 12 列 / UPDATE 5 列 / FOR UPDATE（无 DELETE：只由注销级联）'
SELECT id, revision, kind, owner_user_id, transcription_id, media_id, media_revision,
       state, deadline_at, created_at, updated_at, error_code
  FROM public.speech_jobs WHERE false;
INSERT INTO public.speech_jobs (id, revision, kind, owner_user_id, transcription_id,
                                media_id, media_revision, state, deadline_at,
                                created_at, updated_at, error_code)
SELECT gen_random_uuid(), 1, 'transcription', gen_random_uuid(), gen_random_uuid(),
       gen_random_uuid(), 1, 'queued', now(), now(), now(), NULL WHERE false
RETURNING id;
UPDATE public.speech_jobs
   SET revision = revision + 1, state = 'succeeded', deadline_at = deadline_at,
       updated_at = now(), error_code = NULL
 WHERE false AND revision = 1
RETURNING id;
SELECT id FROM public.speech_jobs WHERE false FOR UPDATE;

\echo '-- [transcriptions] SELECT 13 列 / INSERT 13 列 / UPDATE 8 列（无 DELETE、无 FOR UPDATE）'
SELECT id, revision, owner_user_id, media_id, media_revision, raw_text, uncertain_spans,
       confirmed_text, confirmed_at, model_version, created_at, updated_at, deleted
  FROM public.transcriptions WHERE false;
INSERT INTO public.transcriptions (id, revision, owner_user_id, media_id, media_revision,
                                   raw_text, uncertain_spans, confirmed_text, confirmed_at,
                                   model_version, created_at, updated_at, deleted)
SELECT gen_random_uuid(), 1, gen_random_uuid(), gen_random_uuid(), 1,
       'probe', '[]'::jsonb, NULL, NULL, 'probe', now(), now(), false WHERE false
RETURNING id;
UPDATE public.transcriptions
   SET revision = revision + 1, raw_text = raw_text, uncertain_spans = uncertain_spans,
       confirmed_text = NULL, confirmed_at = NULL, model_version = model_version,
       updated_at = now(), deleted = false
 WHERE false AND revision = 1
RETURNING id;

\echo '-- [speech_idempotency] SELECT 6 列 / 占位 INSERT 6 列 / ON CONFLICT DO NOTHING / finalize UPDATE 2 列 / release 与 purge 两条 DELETE'
SELECT scope, key_hash, request_hash, payload, pending, expires_at
  FROM public.speech_idempotency WHERE false;
INSERT INTO public.speech_idempotency (scope, key_hash, request_hash, payload, pending, expires_at)
SELECT 'probe', 'probe', 'probe', '{}'::jsonb, true, now() WHERE false
ON CONFLICT (scope, key_hash) DO NOTHING
RETURNING scope;
UPDATE public.speech_idempotency
   SET payload = payload, pending = false
 WHERE false AND pending
RETURNING scope;
DELETE FROM public.speech_idempotency
 WHERE false AND scope = 'probe' AND key_hash = 'probe';
DELETE FROM public.speech_idempotency
 WHERE false AND expires_at <= now()
RETURNING scope;

\echo '-- 以下是禁止面：speech_jobs 与 transcriptions 的 DELETE 必须 42501'
\echo '--   （DELETE 只授 speech_idempotency；这两表只由 request_account_deletion() 以属主身份级联）'
DELETE FROM public.speech_jobs WHERE false RETURNING id;
DELETE FROM public.transcriptions WHERE false RETURNING id;

RESET ROLE;

\echo '-- [7] 语音域探针结束（正向行成功即无输出；上面两条禁止面各应有一行 ERROR: 42501 …）'

-- ---------------------------------------------------------------------------
-- 8) R28-S51 函数面（函数级 EXECUTE 的零假设探针）
--    为什么单列一节：表级授权有 [1]-[7] 的矩阵，函数级 EXECUTE 是另一套 ACL。PostgreSQL
--    给**新建函数**默认 `GRANT EXECUTE … TO PUBLIC`（表现为 proacl IS NULL），所以
--    「表 REVOKE 干净」不等于「函数面干净」：运行时只要能 EXECUTE 一个 SECURITY DEFINER
--    函数，就能以属主身份绕过前面所有表级限制。本节回答三件事：
--      a) 三个 schema 下函数的 EXECUTE 面（属主是谁、proacl 是否为空、PUBLIC 是否可执行、
--         除属主外被 GRANT 的组），以及清单里 11 条的分类；
--      b) 清单里的 6 条 runtime 函数，运行时身份真跑是否成功；
--      c) 清单里的 3 条 internal + 2 条 trigger 函数，运行时真跑是否 42501。
--    判定以 90-assert 的 runtime_function_* 四条为准；本节只打印原始读数，判定留给读者。
--    注：本节只读——函数调用要么零行、要么纯计算，不写任何表。
-- ---------------------------------------------------------------------------
\echo ''
\echo '### 8) R28-S51 函数面：每个函数的 EXECUTE 面（proacl IS NULL ⇒ PG 默认 PUBLIC 可执行）'
SELECT n.nspname || '.' || p.proname                                  AS function,
       p.prosecdef                                                    AS secdef,
       pg_get_userbyid(p.proowner)                                    AS owner,
       p.proacl IS NULL                                               AS acl_is_null,
       has_function_privilege('public', p.oid, 'EXECUTE')             AS public_exec,
       COALESCE((
         SELECT string_agg(DISTINCT COALESCE(r.rolname, 'PUBLIC'), ', '
                           ORDER BY COALESCE(r.rolname, 'PUBLIC'))
           FROM aclexplode(p.proacl) a
           LEFT JOIN pg_roles r ON r.oid = a.grantee
          WHERE a.privilege_type = 'EXECUTE'
            AND a.grantee <> p.proowner
       ), '(none)')                                                   AS non_owner_grantees
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname IN ('public', 'catalog_ops', 'staging_intake')
   AND p.prokind = 'f'
   AND (p.prosecdef
        OR (n.nspname = 'public'
            AND p.proname IN ('admin_account_display_name',
                              'consent_policy_immutable',
                              'admin_audit_events_reject_mutation')))
 ORDER BY 1;

\echo '-- 每个 schema 的函数总数 / 其中 PUBLIC 可执行的条数（改后期望：public_executable = 0）'
SELECT n.nspname AS schema,
       count(*)                                                    AS functions,
       count(*) FILTER (WHERE has_function_privilege('public', p.oid, 'EXECUTE'))
                                                                   AS public_executable
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname IN ('public', 'catalog_ops', 'staging_intake')
   AND p.prokind = 'f'
 GROUP BY 1
 ORDER BY 1;

\echo ''
\echo '### 8a) 清单 runtime 函数：运行时身份真跑，两条都必须成功'
SET ROLE gengyun_api_runtime;

\echo '-- [8a-1] public.list_admin_accounts()：期望 1 行计数、值为 0（空表），不是 42501'
SELECT count(*) AS admin_accounts_rows FROM public.list_admin_accounts();

\echo '-- [8a-2] public.admin_account_display_name(text, uuid)：纯计算，期望返回一行昵称'
SELECT public.admin_account_display_name('探测', gen_random_uuid()) AS display_name;

\echo '-- [8b] 清单 internal 函数：运行时不得可执行，三条都必须恰好 42501'
\echo '--    （函数级拒权发生在函数体之前，全 NULL 实参不会被求值，安全）'
SELECT catalog_ops.apply_source_operation(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
SELECT staging_intake.apply_import(NULL,NULL,NULL);
SELECT staging_intake.rollback_import(NULL,NULL,NULL,NULL);

\echo '-- [8c] trigger 函数：运行时不得可执行'
\echo '--    改前 consent_policy_immutable() 是 proacl IS NULL ⇒ PUBLIC 可执行，直接调用会走到'
\echo '--    0A000「trigger functions can only be called as triggers」；改后（段 L REVOKE）'
\echo '--    必须先是 42501。admin_audit_events_reject_mutation() 在 0017:335 已收回，同期望 42501。'
SELECT public.consent_policy_immutable();
SELECT public.admin_audit_events_reject_mutation();

RESET ROLE;

\echo '-- [8] 函数面探针结束（[8a] 两行是正常结果；[8b]/[8c] 五条各应有一行 ERROR: 42501 …）'
\echo '--     零行/拒权都在预期内：本探针不写任何表，也不要求运行时能调用运维函数。'

\echo '### 探针结束（exit 码无意义：ON_ERROR_STOP=0 是设计的一部分）'
