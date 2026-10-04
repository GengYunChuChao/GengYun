#!/usr/bin/env node
// PGlite 实测：0001 → 0002 → 种子 → 幂等 → 回滚 → 混合批次保留 → 重复回滚 → FK 用例
// 依赖：@electric-sql/pglite（已安装在 /tmp/pgtest，见启动命令）。
// 用法：在已安装 pglite 的目录下以 node 执行，或通过 NODE_PATH 指向 /tmp/pgtest/node_modules。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const ROOT = process.env.GY_ROOT || "E:/worktrees/gengyun-i03-data";
const HERE = dirname(fileURLToPath(import.meta.url));
// 0001 由 GY-I02 分支拥有，不在本仓库；通过环境变量 GY_M0001 或复制 0001.sql 到脚本同目录提供。
const M0001 = process.env.GY_M0001 || join(HERE, "0001.sql");
const read = (p) => readFileSync(p, "utf8");

const db = new PGlite();
let failures = 0;

function ok(name, detail = "") {
  console.log(`PASS ${name}${detail ? " :: " + detail : ""}`);
}
function fail(name, detail) {
  failures += 1;
  console.error(`FAIL ${name} :: ${detail}`);
}
async function assert(name, cond, detail = "") {
  cond ? ok(name, detail) : fail(name, detail);
}
async function run(name, sql) {
  try {
    await db.exec(sql);
    ok("exec " + name);
  } catch (e) {
    fail("exec " + name, String(e.message).split("\n")[0]);
    throw e;
  }
}
async function count(table) {
  const r = await db.query(`SELECT count(*)::int AS c FROM ${table}`);
  return r.rows[0].c;
}
async function tblCount() {
  const r = await db.query(
    "SELECT count(*)::int AS c FROM pg_tables WHERE schemaname='public'"
  );
  return r.rows[0].c;
}
async function fkExists(child, parent) {
  const r = await db.query(
    `SELECT count(*)::int AS c FROM pg_constraint
     WHERE contype='f'
       AND conrelid = $1::regclass
       AND confrelid = $2::regclass`,
    [child, parent]
  );
  return r.rows[0].c > 0;
}

// ---------- 1. 0001 → 0002 ----------
await run("0001_initial_schema", read(M0001));
await run("0002_knowledge_catalog", read(ROOT + "/db/migrations/0002_knowledge_catalog.sql"));

await assert("表数量 = 30（0001 20 + 0002 业务/适配 10）", (await tblCount()) === 30, "实际 " + (await tblCount()));

// 关键 FK 断言
await assert("registrations.source_version_id → source_versions", await fkExists("registrations", "source_versions"));
await assert("registrations.formulation_id → formulations", await fkExists("registrations", "formulations"));
await assert("applicability.source_version_id → source_versions", await fkExists("applicability", "source_versions"));
await assert("applicability.crop_id → crops", await fkExists("applicability", "crops"));
await assert("catalog_source_update_events.source_id → sources", await fkExists("catalog_source_update_events", "sources"));
await assert("source_versions.source_id → sources (0001)", await fkExists("source_versions", "sources"));

// 类型断言：source_versions.source_id 为 uuid（与 sources.id 一致）
{
  const r = await db.query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_name='source_versions' AND column_name='source_id'`
  );
  await assert("source_versions.source_id 类型 = uuid", r.rows[0].data_type === "uuid", r.rows[0].data_type);
}

// ---------- 2. 种子导入 ----------
await run("seed_reference", read(ROOT + "/db/seeds/seed_reference.sql"));
await run("seed_herbicides_verified", read(ROOT + "/db/seeds/seed_herbicides_verified.sql"));
await run("seed_simulation", read(ROOT + "/db/seeds/seed_simulation.sql"));

const expected = {
  sources: 3,
  source_versions: 5,
  crops: 4,
  species: 8,
  regions: 102,
  formulations: 22,
  registrations: 22,
  applicability: 22,
  knowledge_dataset_modes: 3,
  knowledge_dataset_config: 2,
};
for (const [t, n] of Object.entries(expected)) {
  await assert(`种子后 ${t} = ${n}`, (await count(t)) === n, "实际 " + (await count(t)));
}

// ---------- 3. 幂等（再执行一次，行数不变）----------
await run("seed_reference(幂等)", read(ROOT + "/db/seeds/seed_reference.sql"));
await run("seed_herbicides_verified(幂等)", read(ROOT + "/db/seeds/seed_herbicides_verified.sql"));
await run("seed_simulation(幂等)", read(ROOT + "/db/seeds/seed_simulation.sql"));
for (const [t, n] of Object.entries(expected)) {
  await assert(`幂等后 ${t} 仍 = ${n}`, (await count(t)) === n, "实际 " + (await count(t)));
}

// ---------- 4. 混合批次保留：插入无关来源/版本/制剂/登记 ----------
const UNRELATED = {
  src: "11111111-1111-1111-1111-111111111111",
  sv: "22222222-2222-2222-2222-222222222222",
  f: "33333333-3333-3333-3333-333333333333",
  r: "44444444-4444-4444-4444-444444444444",
};
await run("插入无关批次", `
  INSERT INTO sources (id, title, canonical_url, publisher, source_kind, evidence_kind)
    VALUES ('${UNRELATED.src}'::uuid, '无关来源', 'https://example.invalid/other', '其他', 'verified_seed', 'research');
  INSERT INTO source_versions (id, source_id, version, content_hash, locator, retrieved_at, valid_from, validity, review_status)
    VALUES ('${UNRELATED.sv}'::uuid, '${UNRELATED.src}'::uuid, 'other-1', '${"a".repeat(64)}', 'https://example.invalid/other', now(), now(), 'valid', 'unverified');
  INSERT INTO formulations (id, registration_number, producer, dosage_form, ingredients, identity_hash)
    VALUES ('${UNRELATED.f}'::uuid, 'OTHER-999', '其他生产者', '乳油', '[{"name":"其他成分","content_text":"1%","unit_text":"%"}]'::jsonb, '${"b".repeat(64)}');
  INSERT INTO registrations (id, formulation_id, source_version_id, registered_name, status)
    VALUES ('${UNRELATED.r}'::uuid, '${UNRELATED.f}'::uuid, '${UNRELATED.sv}'::uuid, '其他制剂', 'unknown');
`);

// ---------- 5. 回滚（只删本次种子写入，保留无关批次）----------
await run("rollback_seed", read(ROOT + "/db/seeds/rollback_seed.sql"));

await assert("回滚后 formulations = 1（仅无关）", (await count("formulations")) === 1, "实际 " + (await count("formulations")));
await assert("回滚后 registrations = 1（仅无关）", (await count("registrations")) === 1, "实际 " + (await count("registrations")));
await assert("回滚后 applicability = 0", (await count("applicability")) === 0, "实际 " + (await count("applicability")));
await assert("回滚后 source_versions = 1（仅无关）", (await count("source_versions")) === 1, "实际 " + (await count("source_versions")));
await assert("回滚后 sources = 1（仅无关）", (await count("sources")) === 1, "实际 " + (await count("sources")));
{
  const r = await db.query("SELECT registration_number FROM formulations");
  await assert("保留的制剂为无关批次", r.rows.length === 1 && r.rows[0].registration_number === "OTHER-999", r.rows[0].registration_number);
}
// 参考数据（crops/species/regions）不回滚，仍在
await assert("回滚后 crops 仍 = 4", (await count("crops")) === 4, "实际 " + (await count("crops")));
await assert("回滚后 regions 仍 = 102", (await count("regions")) === 102, "实际 " + (await count("regions")));

// ---------- 6. 重复回滚（幂等，第二次无报错且不影响无关批次）----------
await run("rollback_seed(重复)", read(ROOT + "/db/seeds/rollback_seed.sql"));
await assert("重复回滚后无关 formulations 仍 = 1", (await count("formulations")) === 1, "实际 " + (await count("formulations")));

// ---------- 7. FK 约束用例：引用不存在的 source_version 应被拒绝 ----------
{
  let violated = false;
  try {
    await db.exec(`INSERT INTO registrations (id, formulation_id, source_version_id, registered_name, status)
      VALUES ('99999999-9999-9999-9999-999999999999'::uuid, '${UNRELATED.f}'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, '坏引用', 'unknown')`);
  } catch (e) {
    violated = /violates foreign key|23503/i.test(String(e.message));
  }
  await assert("FK 用例：引用不存在 source_version 被拒绝(23503)", violated);
}

console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILURES: ${failures}`));
process.exit(failures === 0 ? 0 : 1);
