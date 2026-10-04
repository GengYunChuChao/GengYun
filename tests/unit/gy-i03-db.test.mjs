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

async function freshDb() {
  const db = new PGlite();
  await db.exec(M0001);
  await db.exec(M0002);
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
