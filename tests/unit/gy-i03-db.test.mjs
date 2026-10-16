import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

/**
 * GY-I03 数据库产物回归：迁移、种子（两次）、整份脱敏样例（含重复执行）、回滚（两次）、down。
 *
 * 内存 PostgreSQL 引擎（PGlite 0.5.8，基于 PostgreSQL 18.x 内核）。
 * 注意：这只证明 SQL 在内存引擎可执行与幂等，**不构成目标 PostgreSQL 17.11 的实库验收**。
 * 关键回归点：脱敏样例必须使用当前共享 schema（regions 无 level、sources 无 license 列、
 * 来源 id 为 uuid），不得出现 42703。
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const M0001 = read('services/api/db/migrations/0001_initial_schema.sql');
const M0002 = read('services/api/db/migrations/0002_knowledge_catalog.sql');
const M0005 = read('services/api/db/migrations/0005_catalog_read_views.sql');
const M0010 = read('services/api/db/migrations/0010_knowledge_read_views.sql');
const M0012 = read('services/api/db/migrations/0012_knowledge_created_at.sql');
const DOWN0002 = read('services/api/db/migrations/rollback/0002_knowledge_catalog.down.sql');
const SEED_REF = read('db/seeds/seed_reference.sql');
const SEED_HB = read('db/seeds/seed_herbicides_verified.sql');
const SEED_SIM = read('db/seeds/seed_simulation.sql');
const ROLLBACK = read('db/seeds/rollback_seed.sql');
const SAMPLE = read('db/samples/desensitized-sample.sql');

async function count(db, table) {
  const r = await db.query(`SELECT count(*)::int AS c FROM ${table}`);
  return r.rows[0].c;
}

async function freshDb(options = {}) {
  const db = new PGlite();
  await db.exec(M0001);
  await db.exec(M0002);
  if (options.readProjections === true) {
    // 浙江种子现在显式写 created_at（由 0012 引入），而 created_at 只在完整迁移阶梯里
    // 存在（0012 的投影一节依赖 0005/0010）。这里按真实顺序加载真实迁移文件，不手搓列定义。
    await db.exec(M0005);
    await db.exec(M0010);
    await db.exec(M0012);
  }
  return db;
}

async function applySeeds(db) {
  await db.exec(SEED_REF);
  await db.exec(SEED_HB);
  await db.exec(SEED_SIM);
}

test('脱敏样例文本相对共享 schema 无越界列/文本来源 ID（静态）', () => {
  // 去掉行注释后检查，避免命中说明文字。
  const code = SAMPLE.replace(/--[^\n]*/g, '');
  assert.ok(!/\blevel\b/.test(code), '样例 SQL 不应出现共享 regions 没有的 level 列');
  assert.ok(!/license_status|licensed/.test(code), '样例 SQL 不应出现共享 sources 没有的 license 列');
  assert.ok(!/'src_sim_demo_gyi03'/.test(code), 'sources.id 不得用文本键，应为 uuid 字面量');
});

test('0001→0002 在内存引擎可整体执行（无 42703/42804）', async () => {
  const db = await freshDb();
  await db.close();
});

test('种子执行两次幂等（行数不变）', async () => {
  const db = await freshDb();
  await applySeeds(db);
  await applySeeds(db);
  assert.equal(await count(db, 'sources'), 3);
  assert.equal(await count(db, 'source_versions'), 5);
  assert.equal(await count(db, 'crops'), 4);
  assert.equal(await count(db, 'species'), 8);
  assert.equal(await count(db, 'regions'), 102);
  assert.equal(await count(db, 'formulations'), 22);
  assert.equal(await count(db, 'registrations'), 22);
  assert.equal(await count(db, 'applicability'), 22);
  await db.close();
});

test('整份脱敏样例相对共享 schema 可执行且重复执行幂等（无 42703）', async () => {
  const db = await freshDb();
  await db.exec(SAMPLE);
  const after1 = {
    sources: await count(db, 'sources'),
    source_versions: await count(db, 'source_versions'),
    formulations: await count(db, 'formulations'),
    registrations: await count(db, 'registrations'),
    applicability: await count(db, 'applicability'),
    regions: await count(db, 'regions'),
  };
  assert.deepEqual(after1, {
    sources: 1, // 合成模拟来源（uuid）
    source_versions: 0, // 样例不含来源版本
    formulations: 1, // 合成模拟制剂
    registrations: 0,
    applicability: 0,
    regions: 1, // 公开区划参考行
  });
  await db.exec(SAMPLE); // 重复执行
  for (const [table, n] of Object.entries(after1)) {
    assert.equal(await count(db, table), n, `${table} 重复执行后行数不应变化`);
  }
  await db.close();
});

test('种子 → 样例 → 回滚两次：删种子行、留样例制剂、幂等', async () => {
  const db = await freshDb();
  await applySeeds(db);
  await db.exec(SAMPLE);
  assert.equal(await count(db, 'formulations'), 23, '22 种子 + 1 样例');

  await db.exec(ROLLBACK);
  // 种子行（含与样例共用的模拟来源 uuid）按 id 删除
  assert.equal(await count(db, 'sources'), 0, '种子来源（含共用模拟来源）已删');
  assert.equal(await count(db, 'source_versions'), 0);
  assert.equal(await count(db, 'registrations'), 0);
  assert.equal(await count(db, 'applicability'), 0);
  // 样例制剂 id 不在种子 id 列表内 → 保留
  assert.equal(await count(db, 'formulations'), 1, '样例制剂保留');
  const kept = await db.query('SELECT id FROM formulations');
  assert.equal(kept.rows[0].id, '00000000-0000-4000-8000-000000000301');
  // 参考数据不回滚
  assert.equal(await count(db, 'regions'), 102);
  assert.equal(await count(db, 'crops'), 4);

  await db.exec(ROLLBACK); // 重复回滚幂等
  assert.equal(await count(db, 'sources'), 0);
  assert.equal(await count(db, 'formulations'), 1);
  await db.close();
});

test('0002 down 可执行：删除 0002 对象，保留 0001 对象', async () => {
  const db = await freshDb();
  await db.exec(DOWN0002);

  const gone = async (name) => {
    const r = await db.query(
      `SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
      [name],
    );
    return r.rows[0].c === 0;
  };
  assert.equal(await gone('formulations'), true, 'down 后 formulations 应不存在');
  assert.equal(await gone('registrations'), true, 'down 后 registrations 应不存在');
  assert.equal(await gone('knowledge_dataset_modes'), true, 'down 后适配层表应不存在');
  // 0001 共享表仍在（可查询）
  assert.equal(await count(db, 'sources'), 0, 'sources 表仍可查询（0001 对象保留）');
  assert.equal(await count(db, 'regions'), 0, 'regions 表仍可查询（0001 对象保留）');
  await db.close();
});

test('浙江首批资料种子：幂等、用量缺项门、批次精确回滚', async () => {
  const SEED_ZJ = read('db/seeds/seed_zhejiang_materials.sql');
  const ROLLBACK_ZJ = read('db/seeds/rollback_zhejiang_materials.sql');
  const db = await freshDb({ readProjections: true });
  await applySeeds(db);
  const base = {
    sources: await count(db, 'sources'),
    source_versions: await count(db, 'source_versions'),
    formulations: await count(db, 'formulations'),
    registrations: await count(db, 'registrations'),
    queryable: await count(db, 'v_queryable_seed_version'),
  };

  await db.exec(SEED_ZJ);
  await db.exec(SEED_ZJ); // 幂等：确定性 uuid + ON CONFLICT DO NOTHING
  assert.equal(await count(db, 'knowledge_versions'), 159, '119 杂草 + 5 防除时期 + 35 药剂适用');
  assert.equal(await count(db, 'sources'), base.sources + 2);
  assert.equal(await count(db, 'source_versions'), base.source_versions + 2);
  assert.equal(await count(db, 'catalog_import_runs'), 1);
  assert.equal(await count(db, 'catalog_source_update_events'), 2);
  assert.equal(await count(db, 'v_active_source_version'), 0, '未核对来源不得进有效集合');
  assert.equal(await count(db, 'v_queryable_seed_version'), base.queryable + 2, 'stub 可见且标注未核对');
  assert.equal(
    (await db.query(
      `SELECT count(*)::int AS c FROM knowledge_versions WHERE region_codes <> '["330000"]'::jsonb OR visibility <> 'private'`,
    )).rows[0].c,
    0, '条目限于浙江且未发布',
  );

  // 创建时点（列表排序键 created_at DESC,id DESC 的第一列）必须是可复现的批次常量：
  // 取数据集 release，不是种子导入时刻、不是迁移执行时刻。
  const createdAt = (await db.query(
    `SELECT count(*)::int AS total,
            count(DISTINCT created_at)::int AS distinct_at,
            count(*) FILTER (WHERE created_at = timestamptz '2026-10-14T00:00:00Z')::int AS frozen
     FROM knowledge_versions`,
  )).rows[0];
  assert.equal(createdAt.total, 159);
  assert.equal(createdAt.distinct_at, 1, '批次内创建时点只能有一个值（冻结常量）');
  assert.equal(
    createdAt.frozen,
    159,
    '创建时点必须逐行等于数据集 release 2026-10-14（可复现），与导入/迁移时刻无关',
  );

  const bodyCount = async (re) => (await db.query(
    'SELECT count(*)::int AS c FROM knowledge_versions WHERE body ~ $1', [re])).rows[0].c;
  assert.equal(await bodyCount('"dose_text"\\s*:\\s*"[^"]'), 0, '源表无用量列，不得出现非空用量');
  assert.equal(await bodyCount('"dose_text":null'), 159, '用量缺项应显式写 null');
  assert.equal(await bodyCount('"usable_as_dose":true'), 0);
  assert.equal(await bodyCount('"card_ready":true'), 0);

  // 负例：外部补造一行用量必须能被上述门检出
  await db.exec(`INSERT INTO knowledge_versions (id, knowledge_id, revision, title, body, type, source_version_id, region_codes, visibility)
    SELECT '00000000-0000-4000-8000-0000000000fe'::uuid, gen_random_uuid(), 1, 'bad-dose',
    '{"dose_text":"1"}', 'species', id, '["330000"]'::jsonb, 'private'
    FROM source_versions WHERE version='weed-summary-2026.10'`);
  assert.equal(await bodyCount('"dose_text"\\s*:\\s*"[^"]'), 1, '补造用量应被检出');
  await db.exec(`DELETE FROM knowledge_versions WHERE id='00000000-0000-4000-8000-0000000000fe'::uuid`);

  await db.exec(ROLLBACK_ZJ);
  await db.exec(ROLLBACK_ZJ); // 重复回滚幂等
  assert.equal(await count(db, 'knowledge_versions'), 0);
  assert.equal(await count(db, 'sources'), base.sources, '其他种子来源保留');
  assert.equal(await count(db, 'source_versions'), base.source_versions);
  assert.equal(await count(db, 'formulations'), base.formulations, '其他种子制剂保留');
  assert.equal(await count(db, 'registrations'), base.registrations);
  assert.equal(await count(db, 'catalog_source_update_events'), 0);
  assert.equal(
    (await db.query(`SELECT count(*)::int AS c FROM catalog_import_runs WHERE status='reverted'`)).rows[0].c,
    1, '本批次导入运行应标记 reverted',
  );
  await db.close();
});
