-- =============================================================================
-- 演示资料种子：让本机演示首页有卡片（**非生产数据**）
-- =============================================================================
-- 为什么需要这份文件
--   `real` 模式的首页读的是 `catalog_read.home_species` 视图，它只收「来源版本
--   review_status = verified、reviewed_by / reviewed_at 非空、且该版本是来源的
--   current_version」的 `published` 物种知识。仓库里现有的种子
--   （`seed_reference.sql` / `seed_zhejiang_materials.sql`）所有来源版本都是
--   `unverified`（开发侧不是法定审核责任人），于是视图 0 行、接口 200 但
--   `previews: []`。本文件补的正是这一层**资料缺项**，不是绕过闸门的捷径。
--
-- 这是什么，不是什么
--   * 卡片文字**只**来自 `db/seeds/seed_reference.sql` 写入的 `public.species` 行
--     （中文名 / 学名 / 别名），不新增任何识别结论、防治建议或用药指引；
--   * 正文（`knowledge_versions.body`）**不写**实现细节：演示里这段会被当成知识正文
--     念给观众听，所以只写「这是演示占位说明」+ 非生产数据声明，不写本文件名、
--     `db/seeds/*.sql` 路径、表名或派生过程；
--   * `reviewed_by` 指向**演示侧占位账号**：login_name 里写明「演示占位，非真人」，
--     credential_hash 是不可用的占位串（登不进来）。它**不是**真人审核，
--     **不是**第三方审核，也不代表任何机构背书；
--   * 幂等：全部写入都是 `ON CONFLICT ... DO UPDATE` / `DO NOTHING`；整份可重复
--     执行，重复执行不新增行、不改 `knowledge_versions.created_at`；
--   * 第 6 节另加**一张**「语音播报演示短卡」：真实 TTS 把 `title + '\n' + body`
--     整段送去合成，提供者侧上限 100 码点，而上面 8 张卡的正文都远超这个数。
--     该卡正文压到 20 字级，**不改动**上面 8 条资料卡的内容。
--
-- 谁在什么时候跑它
--   只有 `node tools/demo-stack.mjs up --mode real --seed-demo` 这一条路会执行
--   本文件，**默认不执行**。回滚与恢复见文件末尾的注释块。
-- =============================================================================

\encoding UTF8

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. 演示侧占位「审核账号」
--    只作为 source_versions.reviewed_by 的外键落点存在；不是可登录账号。
-- ---------------------------------------------------------------------------
INSERT INTO public.admin_accounts (id, login_name, credential_hash, state)
VALUES (
    'd0000000-0000-4000-8000-00000000a001'::uuid,
    'demo-seed-placeholder（演示占位，非真人）',
    '!demo-seed-placeholder-not-a-credential',
    'active'
)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. 来源：把「演示资料」本身登记成一个来源，而不是冒用农药登记公告
--    source_kind = verified_seed：`real` 模式接受这一类（0002 的
--    knowledge_dataset_modes 里 real 只收 database / verified_seed）。
-- ---------------------------------------------------------------------------
INSERT INTO public.sources (id, title, canonical_url, publisher, source_kind, evidence_kind)
VALUES (
    'd0000000-0000-4000-8000-00000000b001'::uuid,
    '【演示】耕云本机演示资料种子（非生产数据，不代表第三方审核）',
    'https://example.invalid/gengyun/demo-seed-not-for-production',
    '耕云项目开发侧（演示种子）',
    'verified_seed',
    'mixed'
)
ON CONFLICT (id) DO UPDATE
    SET title = EXCLUDED.title,
        canonical_url = EXCLUDED.canonical_url,
        publisher = EXCLUDED.publisher,
        source_kind = EXCLUDED.source_kind,
        evidence_kind = EXCLUDED.evidence_kind;

-- ---------------------------------------------------------------------------
-- 3. 来源版本：review_status = verified（这正是首页视图要求的字段）
--    content_hash 用 sha256('标签') 现场算，避免手写假摘要。
-- ---------------------------------------------------------------------------
INSERT INTO public.source_versions (
    id, source_id, version, content_hash, locator,
    retrieved_at, valid_from, valid_to, validity,
    review_status, reviewed_by, reviewed_at
)
VALUES (
    'd0000000-0000-4000-8000-00000000b002'::uuid,
    'd0000000-0000-4000-8000-00000000b001'::uuid,
    'demo-seed-20261109',
    encode(sha256(convert_to('gengyun demo catalog seed v1 / 非生产数据 / 2026-11-09', 'UTF8')), 'hex'),
    'db/seeds/demo_catalog_verified.sql',
    '2026-11-09T00:00:00+08:00'::timestamptz,
    '2026-11-09T00:00:00+08:00'::timestamptz,
    NULL,
    'valid',
    'verified',
    'd0000000-0000-4000-8000-00000000a001'::uuid,
    '2026-11-09T00:00:00+08:00'::timestamptz
)
ON CONFLICT (source_id, version) DO UPDATE
    SET content_hash = EXCLUDED.content_hash,
        locator = EXCLUDED.locator,
        valid_from = EXCLUDED.valid_from,
        valid_to = EXCLUDED.valid_to,
        validity = EXCLUDED.validity,
        review_status = EXCLUDED.review_status,
        reviewed_by = EXCLUDED.reviewed_by,
        reviewed_at = EXCLUDED.reviewed_at;

-- 视图要求「来源的 current_version_id 就是这条版本」；只在真的变了时才写，
-- 反复执行不会无限抬高 revision。
UPDATE public.sources
   SET current_version_id = 'd0000000-0000-4000-8000-00000000b002'::uuid,
       revision = revision + 1
 WHERE id = 'd0000000-0000-4000-8000-00000000b001'::uuid
   AND current_version_id IS DISTINCT FROM 'd0000000-0000-4000-8000-00000000b002'::uuid;

-- ---------------------------------------------------------------------------
-- 4. 数据集配置切到 real（否则 current_verified_sources 的两个 JOIN 不成立）
--    这一步只改**本机演示库**的配置行，不改任何环境变量或产品默认值。
-- ---------------------------------------------------------------------------
INSERT INTO public.knowledge_dataset_config (key, value, mode)
VALUES ('active_mode', 'real', 'real')
ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        mode = EXCLUDED.mode,
        updated_at = now();

INSERT INTO public.knowledge_dataset_config (key, value, mode)
VALUES ('database_connected', 'true', 'real')
ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        mode = EXCLUDED.mode,
        updated_at = now();

-- ---------------------------------------------------------------------------
-- 5. 物种卡片：固定的 knowledge_id ↔ species_id 映射，正文由 species 行拼出
--    映射刻意写死（而不是全表扫），谁上了首页一眼可查。
-- ---------------------------------------------------------------------------
WITH mapping (knowledge_id, species_id) AS (
    VALUES
        ('d0000000-0000-4000-8000-00000000c001'::uuid, 'species_barnyardgrass'),
        ('d0000000-0000-4000-8000-00000000c002'::uuid, 'species_foxtail'),
        ('d0000000-0000-4000-8000-00000000c003'::uuid, 'species_nettle_group'),
        ('d0000000-0000-4000-8000-00000000c004'::uuid, 'species_crabgrass'),
        ('d0000000-0000-4000-8000-00000000c005'::uuid, 'species_goosegrass'),
        ('d0000000-0000-4000-8000-00000000c006'::uuid, 'species_shortawn_foxtail'),
        ('d0000000-0000-4000-8000-00000000c007'::uuid, 'species_lambsquarters'),
        ('d0000000-0000-4000-8000-00000000c008'::uuid, 'species_alligatorweed')
)
INSERT INTO public.knowledge_versions (
    id, knowledge_id, revision, title, body, type, source_version_id,
    crop_ids, species_ids, region_codes, visibility
)
SELECT m.knowledge_id,
       m.knowledge_id,
       1,
       s.canonical_name,
       '【演示资料·非生产数据】' || s.canonical_name
         || coalesce('（学名 ' || nullif(btrim(s.scientific_name), '') || '）', '')
         || coalesce('；别名：' || nullif(array_to_string(ARRAY(SELECT jsonb_array_elements_text(s.aliases)), '、'), ''), '')
         || '。本条为演示用占位说明，用于展示「资料卡 → 检索 → 带引用回答」的链路；'
         || '不含识别结论、防治建议与用药指引，也不代表任何第三方审核。',
       'species',
       'd0000000-0000-4000-8000-00000000b002'::uuid,
       '[]'::jsonb,
       jsonb_build_array(s.id),
       '[]'::jsonb,
       'published'
FROM mapping m
JOIN public.species s ON s.id = m.species_id
ON CONFLICT (knowledge_id, revision) DO UPDATE
    SET title = EXCLUDED.title,
        body = EXCLUDED.body,
        type = EXCLUDED.type,
        source_version_id = EXCLUDED.source_version_id,
        species_ids = EXCLUDED.species_ids,
        region_codes = EXCLUDED.region_codes,
        visibility = EXCLUDED.visibility;

-- ---------------------------------------------------------------------------
-- 6. 语音播报演示短卡（真实 TTS 的 ≤100 码点可核对目标）
--
--    为什么单独一张：`POST /api/v1/speech/synthesis` 的已核对文本是
--    `title + '\n' + body` 整段，真实提供者的上限是 100 码点；上面 8 张卡的
--    正文都远超这个数，拿去合成必然失败。这张卡只演示「资料卡 → 语音播报」
--    链路，正文压到 20 字级，**不改动**那 8 条。
--
--    knowledge_id 固定 ...c009：它就是请求体里 checked_content_ref.id。
--    species 参考行按 canonical_name 关联而不写死 id 字面量 —— 参考行缺失时
--    本语句会静默插 0 行，由下面的自检兜住（自检同时校验码点上限）。
-- ---------------------------------------------------------------------------
INSERT INTO public.knowledge_versions (
    id, knowledge_id, revision, title, body, type, source_version_id,
    crop_ids, species_ids, region_codes, visibility
)
SELECT 'd0000000-0000-4000-8000-00000000c009'::uuid,
       'd0000000-0000-4000-8000-00000000c009'::uuid,
       1,
       '稗草（短播报）',
       '【演示资料·非生产数据】稗草短播报演示句，用于演示语音播报链路，不含识别结论、防治建议与用药指引。',
       'species',
       'd0000000-0000-4000-8000-00000000b002'::uuid,
       '[]'::jsonb,
       jsonb_build_array(s.id),
       '[]'::jsonb,
       'published'
FROM public.species s
WHERE s.canonical_name = '稗'
ON CONFLICT (knowledge_id, revision) DO UPDATE
    SET title = EXCLUDED.title,
        body = EXCLUDED.body,
        type = EXCLUDED.type,
        source_version_id = EXCLUDED.source_version_id,
        species_ids = EXCLUDED.species_ids,
        region_codes = EXCLUDED.region_codes,
        visibility = EXCLUDED.visibility;

-- 自检：species 参考行缺失时，上面的 INSERT ... SELECT 会静默插入 0 行，
-- 首页仍然空 —— 那种「看起来灌了、其实没灌」最难排查。宁可在这里失败。
DO $$
DECLARE
    cards integer;
    short_cards integer;
    short_len integer;
BEGIN
    SELECT count(*) INTO cards FROM catalog_read.home_species;
    IF cards = 0 THEN
        RAISE EXCEPTION '演示资料种子没有产生任何首页卡片：请先导入 db/seeds/seed_reference.sql（public.species 参考行缺失）';
    END IF;
    -- 语音播报演示短卡：必须真的出现在读视图里，且「title + 换行 + body」≤ 100 码点
    -- （真实 TTS 提供者的硬上限；char_length 在 UTF-8 下按码点计，与 JS 的 Array.from 同口径）。
    SELECT count(*), min(char_length(k.title || E'\n' || k.body))
      INTO short_cards, short_len
      FROM catalog_read.current_knowledge k
     WHERE k.id = 'd0000000-0000-4000-8000-00000000c009'::uuid;
    IF short_cards = 0 THEN
        RAISE EXCEPTION '语音播报演示短卡不在 catalog_read.current_knowledge 里：请确认 public.species 有 canonical_name = 稗 的参考行，且本文件的来源版本已审核通过';
    END IF;
    IF short_len > 100 THEN
        RAISE EXCEPTION '语音播报演示短卡的 title + body 超过 100 码点（当前 %），真实 TTS 会拒收', short_len;
    END IF;
END
$$;

COMMIT;

-- =============================================================================
-- 回滚（本文件不执行，留给审查者照抄）
-- =============================================================================
-- 只删本文件写进去的行，不动 seed_reference.sql 的参考数据：
--
-- BEGIN;
-- DELETE FROM public.knowledge_versions
--  WHERE source_version_id = 'd0000000-0000-4000-8000-00000000b002'::uuid;
-- UPDATE public.sources SET current_version_id = NULL
--  WHERE id = 'd0000000-0000-4000-8000-00000000b001'::uuid;
-- DELETE FROM public.source_versions
--  WHERE id = 'd0000000-0000-4000-8000-00000000b002'::uuid;
-- DELETE FROM public.sources
--  WHERE id = 'd0000000-0000-4000-8000-00000000b001'::uuid;
-- DELETE FROM public.admin_accounts
--  WHERE id = 'd0000000-0000-4000-8000-00000000a001'::uuid;
-- INSERT INTO public.knowledge_dataset_config (key, value, mode)
-- VALUES ('active_mode', 'stub', 'stub')
-- ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, mode = EXCLUDED.mode, updated_at = now();
-- INSERT INTO public.knowledge_dataset_config (key, value, mode)
-- VALUES ('database_connected', 'false', 'stub')
-- ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, mode = EXCLUDED.mode, updated_at = now();
-- COMMIT;
--
-- 更省事的回滚：`node tools/demo-stack.mjs reset --yes`（删掉整个状态目录，
-- 下次 up 重新 initdb；会丢本机全部演示数据）。
-- =============================================================================
