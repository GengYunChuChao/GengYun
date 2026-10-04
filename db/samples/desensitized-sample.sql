-- ============================================================================
-- GY-I03 脱敏数据库样例（合成，无真实私有数据）
-- ----------------------------------------------------------------------------
-- 只含：公开行政区划参考行 + 合成模拟来源/制剂（source_kind='simulation', SIM- 前缀）。
-- 不含：用户身份、会话、openid、上传媒体、个人定位、任何可反查个体的内容。
--
-- schema 真相：docs/architecture/data-dictionary.md + services/api/db/migrations/
--   0001_initial_schema.sql（共享字典表 crops/species/regions/sources/source_versions）
--   + 0002_knowledge_catalog.sql（业务表 formulations/registrations/applicability 等）。
-- 关键：
--   * 共享 regions **无 level 列**（层级由 parent_code/资料层表达）。
--   * 共享 sources **无 license_status/licensed 列**：许可结论只存在于资料/报告层
--     （packages/knowledge/catalog/sources.json 的 license 字段与验证报告）。
--   * sources.id 为 uuid：文本 ID `src_sim_demo_gyi03` → uuid5("source:src_sim_demo_gyi03")
--     = e3b756bf-b047-51b8-9607-e6f898f96743（与 tools/knowledge/build_seeds.py 的 src_db_id 一致）。
--
-- 需 0001、0002 已执行。真实登记资料见 db/seeds/seed_herbicides_verified.sql（公开公告数据）。
-- 本样例可重复执行（全部 ON CONFLICT DO NOTHING，幂等）；其模拟来源行的 uuid 与
-- db/seeds/seed_simulation.sql 的同一模拟来源一致（都来自 src_sim_demo_gyi03 的 uuid5），
-- 故本样例的制剂行独立于种子批次（不被 rollback_seed 删除），但该来源行会随种子回滚一并移除。
-- ============================================================================
BEGIN;

-- 公开参考：浙江省级（来源：民政部行政区划代码）。共享 regions 无 level 列。
INSERT INTO regions (code, parent_code, name, catalog_version, supported)
VALUES ('330000', NULL, '浙江省', 'mca-xzqh-2023', true)
ON CONFLICT (code) DO NOTHING;

-- 合成模拟来源（明显标记）。文本 ID → 共享 sources.id 的 uuid；不写 license_status/licensed。
INSERT INTO sources (id, title, canonical_url, publisher, source_kind, evidence_kind)
VALUES ('e3b756bf-b047-51b8-9607-e6f898f96743'::uuid,
        '耕云 GY-I03 明显模拟演示数据（合成）',
        'https://example.invalid/gengyun/simulation',
        '耕云项目开发侧（合成）',
        'simulation', 'mixed')
ON CONFLICT (id) DO NOTHING;

-- 合成模拟制剂（登记证号 SIM- 占位，非真实登记号；card_ready 语义不适用于制剂行）。
INSERT INTO formulations (id, registration_number, producer, dosage_form, ingredients, identity_hash)
VALUES ('00000000-0000-4000-8000-000000000301'::uuid, 'SIM-0001', '模拟生产者（合成）', '可湿性粉剂',
        '[{"name":"模拟成分","content_text":"10%","unit_text":"%"}]'::jsonb,
        repeat('a', 64))
ON CONFLICT (id) DO NOTHING;

-- 说明：卡片与用量一律不可用；模拟记录不得进入真实用量依据或实际评估答案。
-- （source_kind='simulation' 不进 v_active_source_version；缺用量/方法/注意时 card_ready 恒 false。）
-- UPDATE applicability SET card_ready = true WHERE dose_text IS NOT NULL; -- 仅当补齐全部条件后

COMMIT;
