#!/usr/bin/env node
// GY-I03 数据库回归（内存引擎 PGlite 0.5.8，基于 PostgreSQL 18.x 内核）。
// 注意：内存引擎验证 **不等于** 目标 PostgreSQL 17.11 实库验收。
//
// 覆盖（修复轮 2）：
//   1) 运行器发现：用 services/api/src/db/migrate.ts 的 discoverMigrations(DEFAULT_MIGRATIONS_DIR)
//      断言能发现 0001 与 0002（并打印实际列表）。
//   2) 0001 → 0002（→ 可选 0003，经 GY_M0003 传入，不在本分支）执行，无 42804/23503。
//   3) 种子两次（幂等）。
//   3b) 浙江首批资料种子（#3）：幂等、用量缺项门（无非空 dose_text / usable_as_dose /
//      card_ready）、未核对来源不进 active、region 限定浙江、批次精确回滚两次。
//   4) 整份脱敏样例 db/samples/desensitized-sample.sql 两次（幂等；断言 42703 消失）。
//   5) db/seeds/rollback_seed.sql 两次（幂等；只删本次导入，样例制剂行保留）。
//   6) 0002 down（services/api/db/migrations/rollback/0002_knowledge_catalog.down.sql）执行。
//   7) FK 负例：引用不存在的 source_version 被 23503 拒绝。
//
// 用法：node tools/knowledge/pglite_verify.mjs
//   可选：GY_M0003=/abs/path/0003_privacy_consent.sql  （I27 迁移，保真 0001→0002→0003）
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { discoverMigrations, DEFAULT_MIGRATIONS_DIR } from "../../services/api/src/db/migrate.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SEED_DIR = join(ROOT, "db", "seeds");
const SAMPLE = join(ROOT, "db", "samples", "desensitized-sample.sql");
const DOWN = join(ROOT, "services", "api", "db", "migrations", "rollback", "0002_knowledge_catalog.down.sql");
const M0003 = process.env.GY_M0003 || "";
const read = (p) => readFileSync(p, "utf8");

const db = new PGlite();
let failures = 0;
const ok = (n, d = "") => console.log(`PASS ${n}${d ? " :: " + d : ""}`);
const fail = (n, d) => { failures += 1; console.error(`FAIL ${n} :: ${d}`); };
const assert = async (n, c, d = "") => { c ? ok(n, d) : fail(n, d); };
async function run(name, sql) {
  try { await db.exec(sql); ok("exec " + name); }
  catch (e) { fail("exec " + name, String(e.message).split("\n")[0]); throw e; }
}
const count = async (t) => (await db.query(`SELECT count(*)::int AS c FROM ${t}`)).rows[0].c;
async function fkExists(child, parent) {
  const r = await db.query(
    `SELECT count(*)::int AS c FROM pg_constraint WHERE contype='f' AND conrelid=$1::regclass AND confrelid=$2::regclass`,
    [child, parent]);
  return r.rows[0].c > 0;
}

console.log("=== GY-I03 数据库回归（PGlite 0.5.8 / PostgreSQL 18.x 内核）===\n");

// ---------- 1. 运行器发现 ----------
console.log("DEFAULT_MIGRATIONS_DIR = " + DEFAULT_MIGRATIONS_DIR);
const discovered = discoverMigrations(DEFAULT_MIGRATIONS_DIR);
const versions = discovered.map((m) => m.version);
console.log("运行器发现 = " + discovered.map((m) => `${m.version}:${m.filename}`).join(", "));
await assert("运行器发现 0001", versions.includes("0001"));
await assert("运行器发现 0002（GY-I03）", versions.includes("0002"), versions.join(","));
await assert("0001 排在 0002 之前", versions.indexOf("0001") < versions.indexOf("0002"));
await assert("运行器目录不含 .down.sql（否则文件名不合规）", !discovered.some((m) => m.filename.includes(".down.")));

// ---------- 2. 迁移执行 0001 → 0002（→ 0003 若在同分支）----------
// 本工具只覆盖 GY-I03 资料子域（0001/0002，含同分支的 0003）。当前 main 已新增
// 0004+ 迁移（暂存 schema、读取视图、来源/暂存函数、鉴权、同意策略），其中 0007 需要
// 内存引擎不提供的 pgcrypto 扩展；这些迁移不在本回归范围，故显式跳过并打印清单，
// 不把“跳过”写成“通过”。它们的运行交接见 docs/verification/database-run-handoff.md。
const APPLY_UP_TO = "0003";
const toApply = discovered.filter((m) => m.version <= APPLY_UP_TO);
const skipped = discovered.filter((m) => !toApply.includes(m));
console.log("本次应用 = " + toApply.map((m) => m.filename).join(", "));
if (skipped.length) {
  console.log("显式跳过（超出本回归范围，未在本工具验证）= " + skipped.map((m) => m.filename).join(", "));
}
await assert("运行器发现 0001", versions.includes("0001"));
await assert("运行器发现 0002（GY-I03）", versions.includes("0002"), versions.join(","));
await assert("0001 排在 0002 之前", versions.indexOf("0001") < versions.indexOf("0002"));
await assert("运行器目录不含 .down.sql（否则文件名不合规）", !discovered.some((m) => m.filename.includes(".down.")));

for (const m of toApply) await run(m.filename, m.sql);
if (!versions.includes("0003")) {
  if (M0003 && existsSync(M0003)) {
    await run("0003_privacy_consent(经 GY_M0003 传入)", read(M0003));
  } else {
    console.log("NOTE 本分支无 0003 且未提供 GY_M0003，跳过 0003（I27 迁移不在本分支）");
  }
}

await assert("registrations.source_version_id → source_versions", await fkExists("registrations", "source_versions"));
await assert("applicability.source_version_id → source_versions", await fkExists("applicability", "source_versions"));
await assert("catalog_source_update_events.source_id → sources", await fkExists("catalog_source_update_events", "sources"));
{
  const r = await db.query(`SELECT data_type FROM information_schema.columns WHERE table_name='source_versions' AND column_name='source_id'`);
  await assert("source_versions.source_id 类型 = uuid", r.rows[0].data_type === "uuid", r.rows[0].data_type);
}

// ---------- 3. 种子两次（幂等）----------
const seedFiles = ["seed_reference.sql", "seed_herbicides_verified.sql", "seed_simulation.sql"];
for (const f of seedFiles) await run(f + "(#1)", read(join(SEED_DIR, f)));
const expected = { sources: 3, source_versions: 5, crops: 4, species: 8, regions: 102, formulations: 22, registrations: 22, applicability: 22 };
for (const [t, n] of Object.entries(expected)) await assert(`种子后 ${t} = ${n}`, (await count(t)) === n, "实际 " + (await count(t)));
for (const f of seedFiles) await run(f + "(#2 幂等)", read(join(SEED_DIR, f)));
for (const [t, n] of Object.entries(expected)) await assert(`幂等后 ${t} 仍 = ${n}`, (await count(t)) === n, "实际 " + (await count(t)));

// ---------- 3b. 浙江首批资料（GY-I03 / #3）：幂等、用量缺项门、批次精确回滚 ----------
// 来源：仓外两份真实工作簿的派生清单（packages/knowledge/zhejiang/），种子由
// tools/knowledge/build_seeds.py 生成；本段只验证数据库侧行为，不验证资料内容真伪。
const ZJ_SEED = "seed_zhejiang_materials.sql";
const ZJ_ROLLBACK = "rollback_zhejiang_materials.sql";
const ZJ_ROWS = 159;
const countBody = async (pattern) => (await db.query(
  `SELECT count(*)::int AS c FROM knowledge_versions WHERE body ~ $1`, [pattern])).rows[0].c;
const countRaw = async (sql) => (await db.query(sql)).rows[0].c;

const zjBase = {
  sources: await count("sources"),
  source_versions: await count("source_versions"),
  queryable: await count("v_queryable_seed_version"),
  registrations: await count("registrations"),
};
await run(ZJ_SEED + "(#1)", read(join(SEED_DIR, ZJ_SEED)));
await assert(`浙江种子后 knowledge_versions = ${ZJ_ROWS}`, (await count("knowledge_versions")) === ZJ_ROWS);
await assert("浙江种子后 sources = 原 +2", (await count("sources")) === zjBase.sources + 2);
await assert("浙江种子后 source_versions = 原 +2", (await count("source_versions")) === zjBase.source_versions + 2);
await assert("catalog_import_runs = 1（本批次导入审计）", (await count("catalog_import_runs")) === 1);
await assert("catalog_source_update_events = 2", (await count("catalog_source_update_events")) === 2);
await assert("v_queryable_seed_version = 原 +2（stub 可见，review_status=unverified）",
  (await count("v_queryable_seed_version")) === zjBase.queryable + 2);
await assert("v_active_source_version 仍为空（未核对不进有效集合）",
  (await count("v_active_source_version")) === 0);
await assert("条目按 region_codes=[330000] 限定浙江",
  (await countRaw(`SELECT count(*)::int AS c FROM knowledge_versions WHERE region_codes <> '["330000"]'::jsonb OR visibility <> 'private'`)) === 0);

await run(ZJ_SEED + "(#2 幂等)", read(join(SEED_DIR, ZJ_SEED)));
for (const [label, n] of [["knowledge_versions", ZJ_ROWS], ["sources", zjBase.sources + 2],
  ["source_versions", zjBase.source_versions + 2], ["catalog_import_runs", 1],
  ["catalog_source_update_events", 2], ["registrations", zjBase.registrations]]) {
  await assert(`幂等后 ${label} 仍 = ${n}`, Number(await count(label)) === n, "实际 " + (await count(label)));
}

// 用量缺项门：源工作簿无「标签原文用量」列，库内不得出现任何非空用量
await assert("无非空 dose_text（用量缺项未被补造）",
  (await countBody('"dose_text"\\s*:\\s*"[^"]')) === 0);
await assert("全部条目显式写入 dose_text null",
  (await countBody('"dose_text":null')) === ZJ_ROWS);
await assert("无 usable_as_dose=true", (await countBody('"usable_as_dose":true')) === 0);
await assert("无 card_ready=true", (await countBody('"card_ready":true')) === 0);

// 负例：外部补造一行用量 → 上述门必须能发现（随后删除，不留痕）
await db.exec(`INSERT INTO knowledge_versions (id, knowledge_id, revision, title, body, type, source_version_id, region_codes, visibility)
  SELECT '00000000-0000-4000-8000-0000000000ff'::uuid, gen_random_uuid(), 1, '坏用量行',
  '{"dose_text":"100克/亩"}', 'species', sv.id, '["330000"]'::jsonb, 'private'
  FROM source_versions sv WHERE sv.version = 'weed-summary-2026.10'`);
await assert("负例：补造用量行被门检出", (await countBody('"dose_text"\\s*:\\s*"[^"]')) === 1);
await db.exec(`DELETE FROM knowledge_versions WHERE id = '00000000-0000-4000-8000-0000000000ff'::uuid`);

// 精确回滚：只删本批次，其他种子/审计不动
await run(ZJ_ROLLBACK + "(#1)", read(join(SEED_DIR, ZJ_ROLLBACK)));
await assert("回滚后 knowledge_versions 清零", (await count("knowledge_versions")) === 0);
await assert("回滚后 sources 复原", (await count("sources")) === zjBase.sources);
await assert("回滚后 source_versions 复原", (await count("source_versions")) === zjBase.source_versions);
await assert("回滚后 catalog_source_update_events 清零", (await count("catalog_source_update_events")) === 0);
await assert("回滚后本批次导入运行标记 reverted",
  (await countRaw(`SELECT count(*)::int AS c FROM catalog_import_runs WHERE status='reverted'`)) === 1);
await assert("回滚未触碰其他种子 registrations",
  (await count("registrations")) === zjBase.registrations);
await run(ZJ_ROLLBACK + "(#2 幂等)", read(join(SEED_DIR, ZJ_ROLLBACK)));
await assert("重复回滚后 sources/knowledge_versions 不变",
  (await count("sources")) === zjBase.sources && (await count("knowledge_versions")) === 0);

// ---------- 4. 脱敏样例两次（幂等；断言 42703 消失）----------
const sampleSql = read(SAMPLE);
await run("desensitized-sample.sql(#1)", sampleSql);
const SAMPLE_F = "00000000-0000-4000-8000-000000000301";
await assert("样例制剂行存在（无 42703 regions.level）", (await db.query(`SELECT count(*)::int AS c FROM formulations WHERE id='${SAMPLE_F}'::uuid`)).rows[0].c === 1);
await assert("样例后 formulations = 23", (await count("formulations")) === 23, "实际 " + (await count("formulations")));
await run("desensitized-sample.sql(#2 幂等)", sampleSql);
await assert("样例幂等：formulations 仍 = 23", (await count("formulations")) === 23, "实际 " + (await count("formulations")));
await assert("样例幂等：制剂行唯一", (await db.query(`SELECT count(*)::int AS c FROM formulations WHERE id='${SAMPLE_F}'::uuid`)).rows[0].c === 1);

// ---------- 5. FK 负例 ----------
{
  let violated = false;
  try {
    await db.exec(`INSERT INTO registrations (id, formulation_id, source_version_id, registered_name, status)
      VALUES ('99999999-9999-9999-9999-999999999999'::uuid, '${SAMPLE_F}'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, '坏引用', 'unknown')`);
  } catch (e) { violated = /violates foreign key|23503/i.test(String(e.message)); }
  await assert("FK 负例：引用不存在 source_version 被拒绝(23503)", violated);
}

// ---------- 6. 种子回滚两次（幂等；只删本次导入，样例制剂保留）----------
await run("rollback_seed.sql(#1)", read(join(SEED_DIR, "rollback_seed.sql")));
await assert("回滚后种子制剂清零（仅剩样例 1 行）", (await count("formulations")) === 1, "实际 " + (await count("formulations")));
await assert("回滚后样例制剂行保留", (await db.query(`SELECT count(*)::int AS c FROM formulations WHERE id='${SAMPLE_F}'::uuid`)).rows[0].c === 1);
await assert("回滚后种子 registrations/源版本/来源清零", (await count("registrations")) === 0 && (await count("source_versions")) === 0 && (await count("sources")) === 0);
await assert("回滚后参考数据 crops/regions 保留", (await count("crops")) === 4 && (await count("regions")) === 102);
await run("rollback_seed.sql(#2 幂等)", read(join(SEED_DIR, "rollback_seed.sql")));
await assert("重复回滚后样例制剂仍保留", (await db.query(`SELECT count(*)::int AS c FROM formulations WHERE id='${SAMPLE_F}'::uuid`)).rows[0].c === 1);

// ---------- 7. 0002 down ----------
await run("0002_knowledge_catalog.down.sql", read(DOWN));
{
  const r = await db.query(`SELECT count(*)::int AS c FROM pg_tables WHERE schemaname='public' AND tablename='formulations'`);
  await assert("down 后 formulations 表已删除", r.rows[0].c === 0);
  const s = await db.query(`SELECT count(*)::int AS c FROM pg_tables WHERE schemaname='public' AND tablename='sources'`);
  await assert("down 后共享表 sources 仍存在（0001 拥有，未误删）", s.rows[0].c === 1);
  await assert("down 后共享表 crops 数据保留", (await count("crops")) === 4);
}

await db.close();
console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILURES: ${failures}`));
process.exit(failures === 0 ? 0 : 1);
