/**
 * 「我的档案」支持目录种子（`db/seeds/seed_demo_regions.sql`）与 `--demo` 接线的回归。
 *
 * 为什么值得一条单测：这两张表的值必须与 `packages/knowledge/catalog/regions-zhejiang.json`
 * **逐字段一致**，否则 `services/api/src/profile/service.ts:68` 会把行**静默丢掉** —— 页面又回到
 * 「支持目录为空，暂时不能选择档案。」，而 psql 与 API 都不会报错。这里把「值一致」「幂等」
 * 「带演示标记」「只在 `--demo` 且 real 时跑」四条钉住，避免以后改目录 JSON 或改接线时静默回退。
 *
 * ⛔ 本文件不起 PG、不起 API、不发 HTTP、不写文件：只读仓库里的种子/目录 JSON 与纯函数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEMO_REGION_SEED_FILE,
  buildDemoCatalogCountSql,
  demoRegionSeedPlan,
  nextStepsLines,
  parseDemoCatalogCounts,
} from '../../tools/lib/demo-stack.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative) => readFileSync(join(REPO_ROOT, relative), 'utf8');

const SEED = read(DEMO_REGION_SEED_FILE);
const DEMO_MARKER = '【演示数据·非生产】';

/** 演示路径要的 10 条区划：浙江省 → 杭州/宁波/温州 → 每市 2 个县区。 */
const DEMO_REGION_CODES = Object.freeze([
  '330000',
  '330100',
  '330200',
  '330300',
  '330102',
  '330106',
  '330203',
  '330205',
  '330302',
  '330304',
]);

/** 档案页作物选择器的 4 类（`crops.json` 的 active 行）。 */
const DEMO_CROP_IDS = Object.freeze(['crop_rice', 'crop_corn', 'crop_soybean', 'crop_rapeseed']);

const REGION_ROW = /^INSERT INTO regions \(code, parent_code, name, catalog_version, supported\) VALUES \('(\d{6})', (NULL|'\d{6}'), '([^']+)', '([^']+)', (true|false)\)/u;
const CROP_ROW = /^INSERT INTO crops \(id, name, active\) VALUES \('([^']+)', '([^']+)', (true|false)\)/u;

function seedStatements() {
  return SEED.split(/\r?\n/u).filter((line) => /^INSERT INTO (?:regions|crops) \(/u.test(line));
}

function seedRegionRows() {
  return seedStatements()
    .map((line) => REGION_ROW.exec(line))
    .filter(Boolean)
    .map((match) => ({
      code: match[1],
      parentCode: match[2] === 'NULL' ? null : match[2].slice(1, -1),
      name: match[3],
      catalogVersion: match[4],
      supported: match[5] === 'true',
    }));
}

function seedCropRows() {
  return seedStatements()
    .map((line) => CROP_ROW.exec(line))
    .filter(Boolean)
    .map((match) => ({ id: match[1], name: match[2], active: match[3] === 'true' }));
}

test('种子：恰好 14 条 UPSERT（10 区划 + 4 作物），每条都带演示标记且幂等', () => {
  const statements = seedStatements();
  assert.equal(statements.length, 14, `期望 10 条区划 + 4 条作物，实际 ${statements.length} 条 INSERT`);
  for (const line of statements) {
    assert.ok(line.includes(DEMO_MARKER), `这条没带「${DEMO_MARKER}」标记：${line.slice(0, 90)}`);
    assert.match(line, /ON CONFLICT \((?:code|id)\) DO UPDATE SET/u, `这条不是 UPSERT（重复跑会报错）：${line.slice(0, 90)}`);
    // 行尾的 `-- 【演示数据·非生产】` 是 SQL 注释，不参与语句结束判定。
    assert.match(line.replace(/\s*--.*$/u, ''), /;$/u, '每条必须以分号结束（psql -f 逐条执行）');
  }
});

test('种子：只做 UPSERT，不出现 DELETE / TRUNCATE / DROP（跑在别人也灌过的库上）', () => {
  const executable = SEED.split(/\r?\n/u)
    .map((line) => line.replace(/--.*$/u, ''))
    .join('\n');
  assert.doesNotMatch(executable, /\bDELETE\b|\bTRUNCATE\b|\bDROP\b/iu);
  assert.match(SEED, /^BEGIN;$/mu);
  assert.match(SEED, /^COMMIT;$/mu);
});

test('种子：10 条区划与 regions-zhejiang.json 逐字段一致（不一致会被服务端静默丢行）', () => {
  const catalog = JSON.parse(read('packages/knowledge/catalog/regions-zhejiang.json'));
  const byCode = new Map(catalog.regions.map((row) => [row.code, row]));
  const rows = seedRegionRows();

  assert.equal(rows.length, 10);
  assert.deepEqual(rows.map((row) => row.code).sort(), [...DEMO_REGION_CODES].sort());

  for (const row of rows) {
    const expected = byCode.get(row.code);
    assert.ok(expected, `${row.code} 不在目录 JSON 里：API 会把这一行丢掉`);
    assert.equal(row.name, expected.name, `${row.code} 的 name 与目录 JSON 不一致`);
    assert.equal(row.parentCode, expected.parent_code, `${row.code} 的 parent_code 与目录 JSON 不一致`);
    assert.equal(row.catalogVersion, expected.catalog_version, `${row.code} 的 catalog_version 与目录 JSON 不一致`);
    assert.equal(row.supported, true, `${row.code} 必须 supported=true，否则 API 的 WHERE supported 就过滤掉它`);
  }

  const root = rows.filter((row) => row.parentCode === null);
  assert.deepEqual(root.map((row) => row.code), ['330000'], '目录树必须恰好一个根（profile.js 用 parent_code === null 找根）');
});

test('种子：3 个市 + 6 个县区挂成两棵树（profile.js 的 roots/cities/counties 三段过滤都非空）', () => {
  const rows = seedRegionRows();
  const cities = rows.filter((row) => row.parentCode === '330000');
  assert.deepEqual(cities.map((row) => row.code).sort(), ['330100', '330200', '330300']);

  const counties = rows.filter((row) => row.parentCode !== null && row.parentCode !== '330000');
  assert.equal(counties.length, 6);
  for (const county of counties) {
    assert.ok(cities.some((city) => city.code === county.parentCode), `${county.code} 的父级 ${county.parentCode} 不在演示市里`);
  }
  for (const city of cities) {
    assert.ok(counties.some((county) => county.parentCode === city.code), `${city.code} 下面没有县区：选中它以后县区 picker 仍然是空的`);
  }
});

test('种子：4 类作物与 crops.json 一致且 active（crops 为空同样会写「支持目录为空」）', () => {
  const catalog = JSON.parse(read('packages/knowledge/catalog/crops.json'));
  const byId = new Map(catalog.crops.map((row) => [row.id, row]));
  const rows = seedCropRows();

  assert.deepEqual(rows.map((row) => row.id).sort(), [...DEMO_CROP_IDS].sort());
  for (const row of rows) {
    const expected = byId.get(row.id);
    assert.ok(expected, `${row.id} 不在 crops.json 里`);
    assert.equal(row.name, expected.name, `${row.id} 的 name 与 crops.json 不一致`);
    assert.equal(row.active, true);
  }
});

test('种子：末尾自检块缺一级就 RAISE（配合 psql ON_ERROR_STOP 整组回滚）', () => {
  assert.match(SEED, /^DO \$\$$/mu);
  assert.match(SEED, /RAISE EXCEPTION '[^']*支持目录未补齐/u);
  for (const marker of ["parent_code IS NULL AND code = '330000'", "code IN ('330100', '330200', '330300')", "'crop_rice', 'crop_corn', 'crop_soybean', 'crop_rapeseed'"]) {
    assert.ok(SEED.includes(marker), `自检块缺判据：${marker}`);
  }
});

test('demoRegionSeedPlan：只有 --demo + real 才补目录（stub 不写业务资料）', () => {
  assert.deepEqual(demoRegionSeedPlan({ demo: true, mode: 'real' }), { run: true, reason: 'demo' });
  assert.deepEqual(demoRegionSeedPlan({ demo: true, mode: 'stub' }), { run: false, reason: 'stub' });
  assert.deepEqual(demoRegionSeedPlan({}), { run: false, reason: 'no-demo' });
  assert.deepEqual(demoRegionSeedPlan({ demo: false, mode: 'real' }), { run: false, reason: 'no-demo' });
  assert.deepEqual(demoRegionSeedPlan(), { run: false, reason: 'no-demo' });
});

test('buildDemoCatalogCountSql / parseDemoCatalogCounts：一条 `省|市|县区|作物` 读数', () => {
  const sql = buildDemoCatalogCountSql();
  for (const fragment of ["'330000'", "'330100', '330200', '330300'", ...DEMO_CROP_IDS.map((id) => `'${id}'`)]) {
    assert.ok(sql.includes(fragment), `读数 SQL 缺片段：${fragment}`);
  }
  assert.equal((sql.match(/\(SELECT count\(\*\)/gu) ?? []).length, 4, '四个子查询：省 / 市 / 县区 / 作物');

  assert.deepEqual(parseDemoCatalogCounts('1|3|6|4\n'), { province: 1, city: 3, county: 6, crop: 4 });
  assert.deepEqual(parseDemoCatalogCounts('0|0|0|0'), { province: 0, city: 0, county: 0, crop: 0 });
  assert.equal(parseDemoCatalogCounts('1|3|6'), null);
  assert.equal(parseDemoCatalogCounts('a|b|c|d'), null);
  assert.equal(parseDemoCatalogCounts(''), null);
  assert.equal(parseDemoCatalogCounts(null), null);
});

test('接线：`up --demo` 先补目录再开开关，且用的是同一个种子路径常量', () => {
  const source = read('tools/demo-stack.mjs');
  assert.match(source, /function applyDemoCatalog\(\{ options, pgBin \}\)/u, '缺 applyDemoCatalog');
  assert.match(source, /const file = join\(REPO_ROOT, DEMO_REGION_SEED_FILE\);/u, '没走 DEMO_REGION_SEED_FILE 常量');
  const demoBranch = /^  if \(options\.demo\) \{\n([\s\S]*?)\n  \} else \{/mu.exec(source);
  assert.ok(demoBranch, '找不到 --demo 分支');
  assert.match(demoBranch[1], /applyDemoCatalog\(\{ options, pgBin \}\)/u, '--demo 分支没调用 applyDemoCatalog');
  assert.match(demoBranch[1], /applyDemoProfile\(\{ options, pgBin \}\)/u, '--demo 分支丢了原有的三个开关（不能破坏它）');
  assert.ok(
    demoBranch[1].indexOf('applyDemoCatalog') < demoBranch[1].indexOf('applyDemoProfile'),
    '先补目录、再开开关：开关失败时目录已经就绪，更好排查',
  );
  assert.match(source, /buildPsqlFileArgs\(\{ port: options\.pgPort, database: DATABASE_NAME, file \}\)/u, '没按 --seed-demo 的方式用 psql -f');

  // 栈已经在跑（`up` 的短路分支）时也得补目录：否则「--demo 保证有目录」只在新栈成立。
  const shortCircuit = /API 是本工具上一次起的实例[\s\S]*?return EXIT\.OK;/u.exec(source);
  assert.ok(shortCircuit, '找不到「栈已就绪 ⇒ 不重复启动」的短路分支');
  assert.match(
    shortCircuit[0],
    /if \(options\.demo\) \{\s*const catalogCode = applyDemoCatalog\(\{ options, pgBin \}\);[\s\S]*?return EXIT\.OK;/u,
    '栈已就绪时 --demo 没补目录（幂等种子本来就该重复跑）',
  );
});

test('用法与下一步：--help 写清 --demo 会灌演示目录，且只在 real', () => {
  const usageText = read('tools/lib/demo-stack.mjs');
  assert.match(usageText, /db\/seeds\/seed_demo_regions\.sql/u);
  assert.match(usageText, /补齐「我的档案」的支持目录/u);

  const withDemo = nextStepsLines({ mode: 'real', apiPort: 38110, demo: true }).join('\n');
  assert.match(withDemo, /手选作物与市县/u);
  const withoutDemo = nextStepsLines({ mode: 'real', apiPort: 38110 }).join('\n');
  assert.ok(!/手选作物与市县/u.test(withoutDemo), '不带 --demo 不该冒出演示目录的提示');
});
