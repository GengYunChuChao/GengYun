-- ============================================================================
-- GY-I03 脱敏数据库样例（合成，无真实私有数据）
-- ----------------------------------------------------------------------------
-- 只含：公开行政区划参考行 + 合成模拟记录（source_kind='simulation', SIM- 前缀）。
-- 不含：用户身份、会话、openid、上传媒体、个人定位、任何可反查个体的内容。
-- 需要 0002 迁移已执行。真实登记资料见 seed_herbicides_verified.sql（公开公告数据）。
-- ============================================================================
BEGIN;

-- 公开参考：浙江省级（来源：民政部行政区划代码）
INSERT INTO regions (code, parent_code, name, catalog_version, level, supported)
VALUES ('330000', NULL, '浙江省', 'mca-xzqh-2023', 'province', true)
ON CONFLICT (code) DO NOTHING;

-- 合成模拟来源（明显标记）
INSERT INTO sources (id, title, canonical_url, publisher, source_kind, evidence_kind, license_status, licensed)
VALUES ('src_sim_demo_gyi03', '耕云 GY-I03 明显模拟演示数据（合成）',
        'https://example.invalid/gengyun/simulation', '耕云项目开发侧（合成）',
        'simulation', 'mixed', 'not_applicable', false)
ON CONFLICT (id) DO NOTHING;

-- 合成模拟记录（登记证号 SIM- 占位，非真实登记号）
INSERT INTO formulations (id, registration_number, producer, dosage_form, ingredients, identity_hash) VALUES
  ('00000000-0000-4000-8000-000000000301'::uuid, 'SIM-0001', '模拟生产者（合成）', '可湿性粉剂',
   '[{"name":"模拟成分","content_text":"10%","unit_text":"%"}]'::jsonb,
   repeat('a', 64))
ON CONFLICT (id) DO NOTHING;

-- 说明：卡片与用量一律不可用
-- UPDATE applicability SET card_ready = true WHERE dose_text IS NOT NULL; -- 仅当补齐全部条件后

COMMIT;
