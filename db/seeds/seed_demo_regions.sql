-- 【演示数据·非生产】小程序「我的档案」支持目录 —— 最小演示集（不是生产行政区划）
--
-- 谁在读这张表（从页面一路读到 SQL）：
--   1. `miniprogram/pages/profile/profile.js:162` 一次并发取 read / crops / regions；
--   2. regions 走 `miniprogram/pages/profile/profile-api.js:43` 的 `GET /catalog/regions?limit=20`（cursor 翻页）；
--   3. 服务端 `services/api/src/profile/service.ts:68` 执行
--        SELECT code,name,parent_code,catalog_version FROM public.regions
--         WHERE supported AND code = ANY($1::varchar[]) ORDER BY code FOR SHARE
--      再按 `packages/knowledge/catalog/regions-zhejiang.json` **逐字段**比对 code/name/parent_code/catalog_version，
--      不一致的行被静默丢掉（页面看到的就是「少了几级」）。
--   ⇒ 表里没有行、或值跟目录 JSON 不一致，页面就只剩省级甚至整块空：
--      `profile.js:166` 在 cities 为空时写「支持目录为空，暂时不能选择档案。」。
--
-- 为什么需要这份种子：`node tools/demo-stack.mjs up --demo` 原先只把三个 feature flag 置为演示档，
-- 目录完全依赖 baseline 种子 `db/seeds/seed_reference.sql`，而 baseline 只在 state 里没记过
-- 「已 seed 过」时才跑。库被重建 / 换了库 / 只跑迁移而 state 仍记 seeded 时，`--demo` 起来的
-- 演示栈就是空目录。这份种子把「演示档必然有目录」变成 `--demo` 自己的显式步骤，不依赖 state。
--
-- 内容：浙江省 1 个 → 杭州 / 宁波 / 温州 3 个市 → 6 个县区；作物 4 类（档案页的作物选择器）。
-- 完整 102 条区划在 `db/seeds/seed_reference.sql`（生成文件，勿手改；改 JSON 后跑 tools/knowledge/build_seeds.py）。
--
-- 幂等：每条 `ON CONFLICT ... DO UPDATE`，重复执行只把值写回同一状态；不 DELETE、不新增行。
-- 自检：末尾 DO 块缺一项就 RAISE；配合 psql `-v ON_ERROR_STOP=1` 整组回滚（不会留下半套目录）。
-- 口径：本文件的值必须与目录 JSON 逐字段一致，改 JSON 就得同步改这里，否则页面会静默少几行。

BEGIN;

-- 【演示数据·非生产】浙江省（唯一的根：profile.js:164 用 parent_code === null 找根）
INSERT INTO regions (code, parent_code, name, catalog_version, supported) VALUES ('330000', NULL, '浙江省', 'mca-xzqh-2023', true) ON CONFLICT (code) DO UPDATE SET parent_code=EXCLUDED.parent_code, name=EXCLUDED.name, catalog_version=EXCLUDED.catalog_version, supported=EXCLUDED.supported; -- 【演示数据·非生产】

-- 【演示数据·非生产】3 个市（档案页「浙江市」picker 的选项）
INSERT INTO regions (code, parent_code, name, catalog_version, supported) VALUES ('330100', '330000', '杭州市', 'mca-xzqh-2023', true) ON CONFLICT (code) DO UPDATE SET parent_code=EXCLUDED.parent_code, name=EXCLUDED.name, catalog_version=EXCLUDED.catalog_version, supported=EXCLUDED.supported; -- 【演示数据·非生产】
INSERT INTO regions (code, parent_code, name, catalog_version, supported) VALUES ('330200', '330000', '宁波市', 'mca-xzqh-2023', true) ON CONFLICT (code) DO UPDATE SET parent_code=EXCLUDED.parent_code, name=EXCLUDED.name, catalog_version=EXCLUDED.catalog_version, supported=EXCLUDED.supported; -- 【演示数据·非生产】
INSERT INTO regions (code, parent_code, name, catalog_version, supported) VALUES ('330300', '330000', '温州市', 'mca-xzqh-2023', true) ON CONFLICT (code) DO UPDATE SET parent_code=EXCLUDED.parent_code, name=EXCLUDED.name, catalog_version=EXCLUDED.catalog_version, supported=EXCLUDED.supported; -- 【演示数据·非生产】

-- 【演示数据·非生产】6 个县区（选中市之后「县区」picker 才有选项，profile.js:191/199）
INSERT INTO regions (code, parent_code, name, catalog_version, supported) VALUES ('330102', '330100', '上城区', 'mca-xzqh-2023', true) ON CONFLICT (code) DO UPDATE SET parent_code=EXCLUDED.parent_code, name=EXCLUDED.name, catalog_version=EXCLUDED.catalog_version, supported=EXCLUDED.supported; -- 【演示数据·非生产】
INSERT INTO regions (code, parent_code, name, catalog_version, supported) VALUES ('330106', '330100', '西湖区', 'mca-xzqh-2023', true) ON CONFLICT (code) DO UPDATE SET parent_code=EXCLUDED.parent_code, name=EXCLUDED.name, catalog_version=EXCLUDED.catalog_version, supported=EXCLUDED.supported; -- 【演示数据·非生产】
INSERT INTO regions (code, parent_code, name, catalog_version, supported) VALUES ('330203', '330200', '海曙区', 'mca-xzqh-2023', true) ON CONFLICT (code) DO UPDATE SET parent_code=EXCLUDED.parent_code, name=EXCLUDED.name, catalog_version=EXCLUDED.catalog_version, supported=EXCLUDED.supported; -- 【演示数据·非生产】
INSERT INTO regions (code, parent_code, name, catalog_version, supported) VALUES ('330205', '330200', '江北区', 'mca-xzqh-2023', true) ON CONFLICT (code) DO UPDATE SET parent_code=EXCLUDED.parent_code, name=EXCLUDED.name, catalog_version=EXCLUDED.catalog_version, supported=EXCLUDED.supported; -- 【演示数据·非生产】
INSERT INTO regions (code, parent_code, name, catalog_version, supported) VALUES ('330302', '330300', '鹿城区', 'mca-xzqh-2023', true) ON CONFLICT (code) DO UPDATE SET parent_code=EXCLUDED.parent_code, name=EXCLUDED.name, catalog_version=EXCLUDED.catalog_version, supported=EXCLUDED.supported; -- 【演示数据·非生产】
INSERT INTO regions (code, parent_code, name, catalog_version, supported) VALUES ('330304', '330300', '瓯海区', 'mca-xzqh-2023', true) ON CONFLICT (code) DO UPDATE SET parent_code=EXCLUDED.parent_code, name=EXCLUDED.name, catalog_version=EXCLUDED.catalog_version, supported=EXCLUDED.supported; -- 【演示数据·非生产】

-- 【演示数据·非生产】档案页的 4 类作物（`profile.js:162` 的 api.crops()；缺了同样写「支持目录为空」）
INSERT INTO crops (id, name, active) VALUES ('crop_rice', '水稻', true) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, active=EXCLUDED.active; -- 【演示数据·非生产】
INSERT INTO crops (id, name, active) VALUES ('crop_corn', '玉米', true) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, active=EXCLUDED.active; -- 【演示数据·非生产】
INSERT INTO crops (id, name, active) VALUES ('crop_soybean', '大豆', true) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, active=EXCLUDED.active; -- 【演示数据·非生产】
INSERT INTO crops (id, name, active) VALUES ('crop_rapeseed', '油菜', true) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, active=EXCLUDED.active; -- 【演示数据·非生产】

-- 自检：演示路径要的每一级都得在，且都得是 supported 的（缺一项就整组回滚，不留下半套目录）
DO $$
DECLARE
  n_root integer;
  n_city integer;
  n_county integer;
  n_crop integer;
BEGIN
  SELECT count(*) INTO n_root FROM regions WHERE supported AND parent_code IS NULL AND code = '330000';
  SELECT count(*) INTO n_city FROM regions WHERE supported AND parent_code = '330000' AND code IN ('330100', '330200', '330300');
  SELECT count(*) INTO n_county FROM regions WHERE supported AND parent_code IN ('330100', '330200', '330300') AND code IN ('330102', '330106', '330203', '330205', '330302', '330304');
  SELECT count(*) INTO n_crop FROM crops WHERE active AND id IN ('crop_rice', 'crop_corn', 'crop_soybean', 'crop_rapeseed');
  IF n_root < 1 OR n_city < 3 OR n_county < 6 OR n_crop < 4 THEN
    RAISE EXCEPTION '【演示数据·非生产】支持目录未补齐：省=% 市=% 县区=% 作物=%', n_root, n_city, n_county, n_crop;
  END IF;
  RAISE NOTICE '【演示数据·非生产】支持目录就绪：省=% 市=% 县区=% 作物=%', n_root, n_city, n_county, n_crop;
END
$$;

COMMIT;
