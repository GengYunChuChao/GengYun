-- 演示数据种子（非生产）｜社区 3 条已发布帖 + 消息 3 条系统通知
--
-- 用途：本机演示栈里 `pages/community` 与 `pages/messages` 的空态没有可渲染内容。
-- 本种子只补「本机演示库里的行」，不改任何产品代码、不改运行期能力。
--
-- ## 为什么帖子要连审核结论一起写
-- 社区公开列表的可见性判据是 `community/service.ts::effectiveState` + `isPubliclyVisible`：
-- 内容行（visibility='published'、audit_state='approved'）**必须**有一行 revision 匹配的
-- `community_moderation_decisions`（decision='approved'、hard_rule_passed=true、
-- rule_version=当前派生版本、text_digest=sha256(title||'\n'||body)），否则被降级为
-- `hidden/pending`，列表仍然为空。real 模式下没有真实审核供应商、也没有演示端口
-- （`moderation/demo-port.ts`：real 恒拒绝），所以这里不"绕过审核放行未审内容"，而是：
--   1. 这三段文本**先经真实规则引擎** `evaluateHardRules` 评测（结论 approved、无命中码）；
--   2. 种子里的结论行逐字段等于该引擎输出（decision / hard_rule_passed / reason_codes /
--      rule_version），text_digest 由 SQL 用 `sha256(title || E'\n' || body)` 现算，
--      与 `postModerationText` 逐字节一致；
--   3. `tests/unit/demo-pages-seed.test.mjs` 每次 CI 都重新跑引擎，钉住「这些 approved 是
--      引擎真值，不是手写放行」；规则集升级导致结论变化时该用例会先红。
--
-- ## 一条 SQL 认出全部演示行
--   SELECT count(*) FROM public.community_posts WHERE title LIKE '【演示数据·非生产】%';
--   SELECT count(*) FROM public.messages WHERE event_key LIKE 'demo-pages-notice-%';
--   SELECT count(*) FROM public.users WHERE id = 'd0000000-0000-4000-8000-00000000d001';
--
-- ## 删除 / 重置（逆序执行，幂等）
--   DELETE FROM public.community_moderation_decisions
--    WHERE target_type = 'post'
--      AND target_id IN (SELECT id FROM public.community_posts WHERE title LIKE '【演示数据·非生产】%');
--   DELETE FROM public.community_posts WHERE title LIKE '【演示数据·非生产】%';
--   DELETE FROM public.messages WHERE event_key LIKE 'demo-pages-notice-%';
--   DELETE FROM public.users WHERE id = 'd0000000-0000-4000-8000-00000000d001';
--
-- 幂等：固定 uuid + `ON CONFLICT DO NOTHING`；重复执行不新增行、不改动既有行。
\set ON_ERROR_STOP on

BEGIN;

-- 1) 演示作者（固定 uuid；昵称带「演示」标记，避免被当成真人账号）
INSERT INTO public.users (id, state, revision, auth_epoch, deletion_generation, nickname, created_at, updated_at)
VALUES ('d0000000-0000-4000-8000-00000000d001'::uuid, 'active', 1, 1, 0,
        '演示作者（非生产数据）', now(), now())
ON CONFLICT (id) DO NOTHING;

-- 2) 三条已发布帖（标题与正文都以「【演示数据·非生产】」开头）
INSERT INTO public.community_posts
  (id, author_id, revision, title, body, crop_id, region_code, media_ids,
   linked_knowledge_type, linked_knowledge_id, linked_knowledge_revision,
   visibility, audit_state, created_at, updated_at, anonymized_author_ref)
VALUES
  ('d0000000-0000-4000-8000-00000000b001'::uuid, 'd0000000-0000-4000-8000-00000000d001'::uuid, 1,
   $demo$【演示数据·非生产】玉米田除草剂药害怎么排查？$demo$,
   $demo$【演示数据·非生产】上周喷过烟嘧磺隆，玉米三叶期出现心叶发黄、植株矮化。想先确认是不是漂移或重喷造成的，再看土壤有机质和 pH。这条是演示内容，不构成用药建议。$demo$,
   NULL, NULL, '{}'::text[], NULL, NULL, NULL,
   'published'::public.visibility, 'approved'::public.audit_state,
   now() - interval '3 hours', now() - interval '3 hours', NULL),
  ('d0000000-0000-4000-8000-00000000b002'::uuid, 'd0000000-0000-4000-8000-00000000d001'::uuid, 1,
   $demo$【演示数据·非生产】稻田稗草抗性变强，怎么轮换？$demo$,
   $demo$【演示数据·非生产】同一块田连续两年用五氟磺草胺，稗草防效明显下降。想请教轮换思路和施药窗口怎么安排。演示内容，非生产数据。$demo$,
   NULL, NULL, '{}'::text[], NULL, NULL, NULL,
   'published'::public.visibility, 'approved'::public.audit_state,
   now() - interval '26 hours', now() - interval '26 hours', NULL),
  ('d0000000-0000-4000-8000-00000000b003'::uuid, 'd0000000-0000-4000-8000-00000000d001'::uuid, 1,
   $demo$【演示数据·非生产】果园行间生草，除草剂怎么选？$demo$,
   $demo$【演示数据·非生产】苹果园行间想留草保墒，又担心除草剂伤树。想听听大家在行间除草上的取舍。演示内容，仅用于界面演示。$demo$,
   NULL, NULL, '{}'::text[], NULL, NULL, NULL,
   'published'::public.visibility, 'approved'::public.audit_state,
   now() - interval '50 hours', now() - interval '50 hours', NULL)
ON CONFLICT (id) DO NOTHING;

-- 3) 与上面三条帖子匹配的审核结论行（值 = `evaluateHardRules` 对同一文本的输出）
--    rule_version 由 `deriveRuleVersion()` 派生（packages/moderation/rule-version.mjs）；
--    规则集一变这个字面量就该跟着变，`tests/unit/demo-pages-seed.test.mjs` 会先报红。
INSERT INTO public.community_moderation_decisions
  (id, target_type, target_id, target_revision, decision, reason_codes, hard_rule_passed,
   rule_version, text_digest, contract_complete, missing_contract_fields, created_at, decided_by)
SELECT md5('demo-pages-decision:' || p.id::text)::uuid, 'post', p.id, p.revision,
       'approved'::public.audit_state, '[]'::jsonb, true,
       'mr1+sha256:511e7f2cf65626bbde5c5f38be950a13',
       encode(sha256(convert_to(p.title || E'\n' || p.body, 'UTF8')), 'hex'),
       false, '[]'::jsonb, p.created_at, NULL
  FROM public.community_posts p
 WHERE p.id IN ('d0000000-0000-4000-8000-00000000b001'::uuid,
                'd0000000-0000-4000-8000-00000000b002'::uuid,
                'd0000000-0000-4000-8000-00000000b003'::uuid)
ON CONFLICT (target_type, target_id, target_revision) DO NOTHING;

-- 4) 消息：给当前所有 active 用户各 3 条系统通知（type='system'，无 target_ref）
--    固定 event_key 前缀 `demo-pages-notice-` 让这些行一条 SQL 就能认出来；
--    (owner_id, event_key) 唯一 ⇒ 重复执行不新增。
INSERT INTO public.messages (id, owner_id, type, target_ref, read_at, created_at, revision, event_key)
SELECT gen_random_uuid(), u.id, 'system', NULL, NULL,
       now() - (n.n * interval '1 hour'), 1, 'demo-pages-notice-' || n.n::text
  FROM public.users u
  CROSS JOIN generate_series(1, 3) AS n(n)
 WHERE u.state = 'active'
ON CONFLICT (owner_id, event_key) DO NOTHING;

COMMIT;
