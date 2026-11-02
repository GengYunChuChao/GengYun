/**
 * GY-R72 / `R72-ASSERT-DOMAIN` 的离线钉子（**只读文本，不连库**）。
 *
 * 被钉的对象是 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的 87 号元断言
 * `runtime_surface_parity`。它的**域**在 R72 之前是「运行时**可见**的关系」——用
 * `has_table_privilege` / `has_any_column_privilege` 反查出来的。于是「迁移建了表、运行时代码
 * 真写、却零 GRANT」这类关系对它天然隐形：没有授权 ⇒ 不进域 ⇒ 永远不会被要求分类 ⇒ 这类缺口
 * CI 永远绿。本钉子钉的就是「域已经扩到 `public` 下**所有普通表**、扩不到的地方必须在
 * `unwired_manifest` 里逐行声明」这一环。
 *
 * 四条断言（对应 87 号的 (i)…(v)）：
 *   1) 87 号 ok 表达式里真有「普通表」域（`c.relkind = 'r'` + 排除分区子表 `pg_inherits` +
 *      排除扩展成员表 `pg_depend ... deptype = 'e'`），且旧的可见面检查没被顺手删掉；
 *   2) `unwired_manifest` 清单每行都是「表名 + 理由 + 出处」三列，出处必须带
 *      `docs/` 或 `migrations/` 的 `path:line`，表名唯一且至少含 `provider_invocations`；
 *   3) 清单与 `deploy/postgres-cvm/sql/20-login-roles.sql` 里**已 GRANT** 的表集合不相交
 *      ——「把已接线的表塞进未接线清单把断言弄绿」当场判红；
 *   4) 三张清单（domain 40 + external 17 + unwired 21）加满 78 张 = 迁移建的 77 张 public
 *      普通表 + `schema_migrations`（`services/api/src/db/migrate.ts` 建），且两两不相交。
 *
 * 为什么第 4 条要冻数字：这正是「新建表必须被分类」的**离线**镜像。以后有人加迁移建表却没更新
 * 清单，本文件先红（CI 里 87 号也会红）；此时正确动作是分类（补授权走 `domain_manifest` /
 * `expected`，或按规范写进 `unwired_manifest` 并带出处），不是改这里的数字。
 *
 * 边界（诚实）：本文件只证明**文本形态**变了，不证明 SQL 在真库上跑得过。真正的语义闸门是 CI
 * 的 `deploy-sql-gate.yml`（`deploy-sql-17-11` / `deploy-sql-17-11-cli-groups` 两个 job 都用
 * `psql -f 90-assert-least-privilege.sql` 跑一遍，末行必须 `ok`）。本机没有 PG 实例，所以
 * 谓词的语义只在本片用 WASM PG（`@electric-sql/pglite`）做过 7 个场景的定点自测，结果记在
 * `docs/verification/gy-r72-assert-domain-visibility-20261102.md`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const SOURCE = readFileSync(
  new URL('../../deploy/postgres-cvm/sql/90-assert-least-privilege.sql', import.meta.url),
  'utf8',
);
const LOGIN_ROLES = readFileSync(
  new URL('../../deploy/postgres-cvm/sql/20-login-roles.sql', import.meta.url),
  'utf8',
);
const MIGRATIONS_DIR = new URL('../../services/api/db/migrations/', import.meta.url);
const MIGRATE_TS = readFileSync(new URL('../../services/api/src/db/migrate.ts', import.meta.url), 'utf8');

/** 取 `名字(...) AS (VALUES` 定义块的行（不含首尾行）：收尾按同层缩进的 `  ),` 认。 */
function manifestRows(text, headPattern) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => headPattern.test(line));
  assert.notEqual(start, -1, `找不到清单定义块：${headPattern}`);
  const end = lines.findIndex((line, i) => i > start && /^\s{2}\),\s*$/.test(line));
  assert.notEqual(end, -1, `找不到清单定义块收尾：${headPattern}`);
  return lines.slice(start + 1, end);
}

/** 清单行首的三元组表名（无引号、无 schema 限定）。注释行不参与。 */
function manifestNames(rows) {
  return rows
    .map((line) => line.match(/^\s*\('([a-z0-9_]+)'/))
    .filter(Boolean)
    .map((match) => match[1]);
}

/**
 * 87 号元断言那段 SELECT：从 `'runtime_surface_parity',` 标签起，到下一段 `UNION ALL` 止。
 * 用**独有字符串**定位，不写行号（行号会随插入漂移）。
 */
function metaAssertionBranch(text) {
  const start = text.indexOf("'runtime_surface_parity',");
  assert.notEqual(start, -1, '找不到 87 号元断言 runtime_surface_parity 的 SELECT 标签');
  const end = text.indexOf('\n\n  UNION ALL', start);
  assert.notEqual(end, -1, '找不到 87 号元断言的结束位置（下一段 UNION ALL）');
  return text.slice(start, end);
}

const BRANCH = metaAssertionBranch(SOURCE);
const UNWIRED_HEAD = /^  unwired_manifest\(tbl, why, source\) AS \(VALUES$/;
const UNWIRED_ROWS = manifestRows(SOURCE, UNWIRED_HEAD);
const UNWIRED_NAMES = manifestNames(UNWIRED_ROWS);

/** R72 落定的未接线清单（21 张，按字母序冻结）。改它必须同时改 87 号的计数口径与证据页。 */
const UNWIRED_MANIFEST_TABLES = [
  'admin_audit_events',
  'applicability',
  'catalog_import_conflicts',
  'catalog_import_runs',
  'catalog_source_update_events',
  'content_media_refs',
  'export_writebacks',
  'formulations',
  'knowledge_dataset_config',
  'knowledge_dataset_modes',
  'knowledge_versions',
  'post_versions',
  'posts',
  'provider_invocations',
  'public_authors',
  'registrations',
  'restriction_rules',
  'schema_migrations',
  'source_versions',
  'sources',
  'user_training_consents',
];

/** `20-login-roles.sql` 里被 GRANT 过权限的表名（函数 EXECUTE 不算表登录面）。 */
function grantedTables(text) {
  const withoutComments = text
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  const tables = new Set();
  for (const statement of withoutComments.split(';')) {
    if (!/\bGRANT\b/i.test(statement)) continue;
    // `GRANT EXECUTE ON FUNCTION public.f(...)` 是函数面，不是表授权；漏掉这条过滤会把
    // request_account_deletion 之类的函数名当成「已授权的表」。
    if (/\bON\s+FUNCTION\b/i.test(statement)) continue;
    for (const match of statement.matchAll(/public\.([a-z0-9_]+)/g)) tables.add(match[1]);
  }
  return tables;
}

/** 迁移 SQL + `migrate.ts` 里建的 public 表名（非 public schema 的建表不算）。 */
function createdPublicTables() {
  const tables = new Set();
  const nonPublic = [];
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    const text = readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8');
    const pattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."]+)/gi;
    let match;
    while ((match = pattern.exec(text))) {
      const raw = match[1].replace(/"/g, '').replace(/^public\./, '');
      // 少数建表语句里 `CREATE TABLE` 与 `IF NOT EXISTS` 之间夹了换行 / 注释，可选组没吃到，
      // 于是把 `IF` 当成表名；这里直接丢掉这个噪声，别让它污染「78 张」的口径。
      if (raw === 'IF') continue;
      if (raw.includes('.')) {
        nonPublic.push(`${file}:${raw}`);
        continue;
      }
      tables.add(raw);
    }
  }
  for (const match of MIGRATE_TS.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z0-9_]+)\s*\(/gi)) {
    tables.add(match[1]);
  }
  return { tables, nonPublic };
}

test('87 号元断言的域是「public 下所有普通表」，不再只覆盖运行时可见的关系', () => {
  assert.match(BRANCH, /public 下(所有|每张)普通表/, '87 号的注释里没有写明扩展后的域');

  // ok 表达式 = detail 文案之前的部分。detail 明细里也聚合了 relkind = 'r' 的关系，
  // 所以断言必须收紧到 ok 表达式本身，否则「把域改回只查已授权表」会因为明细还在而漏判。
  const detailAt = BRANCH.indexOf("'public 下的每个运行时可见关系都必须被分类");
  assert.notEqual(detailAt, -1, '找不到 87 号 detail 文案的起点');
  const ok = BRANCH.slice(0, detailAt);

  assert.ok(ok.includes('unwired_manifest'), '87 号 ok 表达式没有引用 unwired_manifest');
  assert.ok(ok.includes("c.relkind = 'r'"), "87 号 ok 表达式没有「普通表」域（c.relkind = 'r'）");

  const inheritAt = ok.indexOf('pg_inherits');
  assert.notEqual(inheritAt, -1, '87 号 ok 表达式没有排除分区 / 继承子表（pg_inherits）');
  const window = ok.slice(Math.max(0, inheritAt - 1500), inheritAt + 1500);
  assert.ok(window.includes("c.relkind = 'r'"), 'pg_inherits 附近没有普通表口径，普通表域可能已被抽掉');
  assert.ok(window.includes("d.deptype = 'e'"), 'pg_inherits 附近没有扩展成员表排除（d.deptype = e）');
  assert.ok(window.includes('unwired_manifest'), 'pg_inherits 附近没有第三类归属清单，扩域不完整');

  assert.match(BRANCH, /R72-ASSERT-DOMAIN/, '87 号缺少 R72-ASSERT-DOMAIN 标记注释');

  // 旧的那一半（运行时可见面必须分类）不许被顺手删掉：一处查已可见关系，一处查清单反向越界。
  const visibleChecks = ok.match(/has_table_privilege\('gengyun_api_runtime'/g) ?? [];
  assert.ok(
    visibleChecks.length >= 2,
    `87 号 ok 表达式里 has_table_privilege 出现 ${visibleChecks.length} 次，应至少 2 次（可见面检查 + 清单零权限反向控制）`,
  );
});

test('unwired_manifest 每行都是「表名 + 理由 + docs/migrations 出处」，且含 provider_invocations', () => {
  const nameRows = UNWIRED_ROWS.filter((line) => /^\s*\('/.test(line));
  assert.equal(nameRows.length, 21, `未接线清单应为 21 行，实际 ${nameRows.length} 行`);
  assert.deepEqual(
    [...UNWIRED_NAMES].sort(),
    UNWIRED_MANIFEST_TABLES,
    '未接线清单的表集合与冻结的 21 张不一致',
  );
  assert.equal(new Set(UNWIRED_NAMES).size, UNWIRED_NAMES.length, '未接线清单里出现重复表名');
  assert.ok(UNWIRED_NAMES.includes('provider_invocations'), '未接线清单必须含 provider_invocations');

  for (const line of nameRows) {
    const parsed = line.match(/^ {4}\('([a-z0-9_]+)', '(.+)', '(.+)'\),?$/);
    assert.ok(parsed, `清单行的形态不对（应为 4 空格缩进的 ('表名', '理由', '出处'),）：${line.trim()}`);
    const [, table, why, source] = parsed;
    assert.ok(why.trim().length >= 12, `${table} 的理由太短，写不出「为什么运行时不接线」`);
    assert.match(source, /(docs\/|migrations\/)/, `${table} 的出处没有 docs/ 或 migrations/ 引用`);
    assert.match(
      source,
      /[A-Za-z0-9_./@-]+\.(sql|md|ts|mjs):\d+/,
      `${table} 的出处没有 path:line 形态的锚点（本片约定逐行可复核）`,
    );
  }
});

test('未接线清单与 20-login-roles.sql 已 GRANT 的表集合不相交', () => {
  const granted = grantedTables(LOGIN_ROLES);
  // 解析自检：真解析不到东西时下面的「交集为空」会假绿。
  assert.ok(granted.size >= 30, `20-login-roles.sql 只解析到 ${granted.size} 张已授权表，解析器可能失效`);

  const overlap = UNWIRED_NAMES.filter((table) => granted.has(table));
  assert.deepEqual(
    overlap,
    [],
    `未接线清单里混进了已授权的表（会被 87 号 (iv-b) 判红，这里先拦）：${overlap.join(', ')}`,
  );
});

test('三张清单 78 张 = 迁移建的 77 张 + schema_migrations，且两两不相交', () => {
  const domain = manifestNames(
    manifestRows(SOURCE, /^\s*(?:WITH\s+)?domain_manifest\(tbl, classification, required\) AS \(VALUES$/),
  );
  const external = manifestNames(manifestRows(SOURCE, /^  external_manifest\(tbl, source_group/));

  assert.equal(domain.length, 40, `domain_manifest 应为 40 行，实际 ${domain.length} 行`);
  assert.equal(external.length, 17, `external_manifest 应为 17 行，实际 ${external.length} 行`);
  assert.equal(
    domain.length + external.length + UNWIRED_NAMES.length,
    78,
    '三张清单合计应为 78 张（57 已分类 + 21 未接线）',
  );

  const union = new Set([...domain, ...external, ...UNWIRED_NAMES]);
  assert.equal(union.size, 78, '三张清单之间出现了重复表名（87 号 (v) 会判红）');

  const { tables: created, nonPublic } = createdPublicTables();
  assert.equal(nonPublic.length, 5, `非 public 建表应为 5 处，实际 ${nonPublic.length} 处：${nonPublic.join(', ')}`);
  assert.equal(created.size, 78, `migrations + migrate.ts 建了 ${created.size} 张 public 表，应为 78 张`);

  const unclassified = [...created].filter((table) => !union.has(table));
  assert.deepEqual(unclassified, [], `有 public 表没被三张清单之一分类（87 号 (iii) 会判红）：${unclassified.join(', ')}`);

  const ghosts = [...union].filter((table) => !created.has(table));
  assert.deepEqual(ghosts, [], `清单里有表在 migrations / migrate.ts 里找不到建表语句：${ghosts.join(', ')}`);
});
