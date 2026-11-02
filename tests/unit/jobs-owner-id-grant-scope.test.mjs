/**
 * GY-R72 · `public.jobs` 的 `owner_id` 列级 SELECT：**授权面 / 断言面 / 读面**三处对齐。
 *
 * ## 这条用例在守什么
 * 注销清理的删除语句是 `DELETE FROM public.jobs WHERE owner_id = $1::uuid`
 * （`services/api/src/jobs/ledger.ts::JOB_LEDGER_PURGE_SQL`）。PostgreSQL 对 `DELETE` 的
 * **WHERE 里出现的列**另要 SELECT 权；表级 `DELETE` 已有（`gy-r71-jobs-ledger-purge-grant`），
 * 但 `gy-r71-jobs-ledger-grant` 的列级 SELECT 当时只给了 upsert 需要的 6 列、**没有 owner_id**
 * ⇒ 真库上这条清理必然 `42501 permission denied for table jobs`。反证：同角色
 * `DELETE FROM public.jobs WHERE false` 反而成功（谓词里没有列，不需要列权）——这也正是
 * 90-assert 的零行探针 `:159` 一直绿着、缺陷却漏过去的原因。
 *
 * ## 四条判据都是**形状**判据（钉集合/结构，不钉会被他人合法改动带漂的绝对数）
 *   T1 授权面：`20-login-roles.sql` 的 `gy-r71-jobs-ledger-grant` 区里**恰好一条**
 *      `GRANT SELECT (…) ON public.jobs TO gengyun_api_runtime`，列集合 == 7 列（6 列 upsert 面 +
 *      owner_id）；本区**无表级** `GRANT … ON public.jobs`、**无** DELETE / TRUNCATE。
 *   T2 断言面：`90-assert-least-privilege.sql` 的 `expected('jobs', …)` 的 `sel` 数组与 T1 的授权
 *      列**逐列同值**（同一事实的两次写法，任一处漂移即红）；`del` 仍是 `true`（表级 DELETE 已授）。
 *   T3 读面：`services/api/src/**` 里**没有任何** SELECT 语句读 `public.jobs`（唯一出现形态是
 *      purge 的 DELETE）；`owner_id` 与 `public.jobs` 同现的地方只有「删除谓词」与
 *      `online-purge-port.ts` 的 `has_column_privilege(…,'owner_id','SELECT')` 探测（探测必须留着）。
 *   T4 语句面：`JOB_LEDGER_PURGE_SQL` 仍是 `DELETE FROM public.jobs WHERE owner_id = $1::uuid`
 *      （不许悄悄改成整表删、改成别的谓词，或加 `RETURNING`）。
 *
 * ## 诚实边界
 * 本文件只读文本：证明**三处文本对齐**，不证明真库权限面。真库由 CI 的
 * `consent-grant-postgres-17.11` 臂（`tests/integration/egress-ledger-pg.mjs` 真跑 upsert 与列权读数）
 * 与 `tests/integration/online-purge-pg.mjs`（真跑那条 DELETE）判定。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { JOB_LEDGER_PURGE_SQL } from '../../services/api/src/jobs/ledger.ts';

const ROLES_SQL = new URL('../../deploy/postgres-cvm/sql/20-login-roles.sql', import.meta.url);
const ASSERT_SQL = new URL('../../deploy/postgres-cvm/sql/90-assert-least-privilege.sql', import.meta.url);
const API_SRC = new URL('../../services/api/src/', import.meta.url);
const PURGE_PORT = new URL('../../services/api/src/privacy/online-purge-port.ts', import.meta.url);

/** 出厂 SELECT 面的期望列：6 列 upsert 面 + 注销清理谓词列 `owner_id`。 */
const EXPECTED_SELECT = ['id', 'state', 'revision', 'error_code', 'result_ref', 'updated_at', 'owner_id'];

const sorted = (list) => [...list].sort();

/** 取 `-- #region <name>` … `-- #endregion <name>` 之间的原文（含首尾标记）。 */
function readRegion(text, name) {
  const start = text.indexOf(`-- #region ${name}`);
  const end = text.indexOf(`-- #endregion ${name}`, start);
  assert.ok(start >= 0, `20-login-roles.sql 里找不到区 ${name}`);
  assert.ok(end > start, `20-login-roles.sql 的区 ${name} 没有 #endregion`);
  return text.slice(start, end);
}

/** 去掉 `--` 行注释，只留可执行 SQL（区说明里会写「无 DELETE」，那不是语句）。 */
function codeOnly(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

function readColumnList(listText) {
  return listText
    .split(',')
    .map((col) => col.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
}

/** 递归收集 `services/api/src` 下的 TS 源文件。 */
function collectApiSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
    if (entry.isDirectory()) out.push(...collectApiSources(full));
    else if (/\.(?:ts|mts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('T1 授权面：gy-r71-jobs-ledger-grant 的 SELECT 列集合含 owner_id，且仍是列级、无 DELETE', () => {
  const region = readRegion(readFileSync(ROLES_SQL, 'utf8'), 'gy-r71-jobs-ledger-grant');
  const code = codeOnly(region);

  // 恰好一条 SELECT 授权，且目标是 public.jobs 的运行时角色。
  const selectGrants = [
    ...code.matchAll(/GRANT\s+SELECT\s*\(([\s\S]*?)\)\s+ON\s+public\.jobs\s+TO\s+([A-Za-z0-9_]+)/gi),
  ];
  assert.equal(selectGrants.length, 1, `本区必须恰好一条 GRANT SELECT (…) ON public.jobs TO <role>（实际 ${selectGrants.length} 条）`);
  const grantedColumns = readColumnList(selectGrants[0][1]);
  assert.equal(selectGrants[0][2], 'gengyun_api_runtime', `SELECT 授权必须落在运行时角色上（实际 ${selectGrants[0][2]}）`);

  // 7 列 == 6 列 upsert 面 + owner_id：多一列（放宽）或少一列（缺谓词列 ⇒ 42501）都必须红。
  assert.deepEqual(
    sorted(grantedColumns),
    sorted(EXPECTED_SELECT),
    `本区的 SELECT 列集合必须正好是 ${EXPECTED_SELECT.join('/')}（实际 ${grantedColumns.join('/')}）`,
  );

  // 表级授权一律不许出现在这个列级区：SELECT/INSERT/UPDATE/DELETE/TRUNCATE/ALL 都不行。
  assert.doesNotMatch(
    code,
    /GRANT\s+(?:ALL(?:\s+PRIVILEGES)?|SELECT|INSERT|UPDATE|DELETE|TRUNCATE)\s+ON\s+public\.jobs\b/i,
    '本区只许列级授权：出现表级 GRANT … ON public.jobs 即等于把最小面放大',
  );
  // DELETE / TRUNCATE 归另一个区（gy-r71-jobs-ledger-purge-grant），不许混进来。
  assert.doesNotMatch(code, /\b(?:DELETE|TRUNCATE)\b/i, '本区不许出现 DELETE/TRUNCATE（表级删除面在 gy-r71-jobs-ledger-purge-grant 区）');

  // 三条语句的形状：SELECT/INSERT/UPDATE 各一条，且都整段落在同一个角色上。
  const statements = code.split(';').map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, 3, `本区必须正好三条 GRANT 语句（实际 ${statements.length} 条）`);
  assert.match(statements[0], /^GRANT\s+SELECT\s*\(/i, `第一条应是 SELECT：${statements[0]}`);
  assert.match(statements[1], /^GRANT\s+INSERT\s*\(/i, `第二条应是 INSERT：${statements[1]}`);
  assert.match(statements[2], /^GRANT\s+UPDATE\s*\(/i, `第三条应是 UPDATE：${statements[2]}`);

  // INSERT/UPDATE 的列清单不受本片影响（同一个区里被读，顺手钉住形状：owner_id 在 INSERT 面）。
  const insertColumns = readColumnList(statements[1].slice(statements[1].indexOf('(') + 1, statements[1].indexOf(')')));
  assert.ok(insertColumns.includes('owner_id'), `INSERT 面必须含 owner_id（实际 ${insertColumns.join('/')}）`);
  const updateColumns = readColumnList(statements[2].slice(statements[2].indexOf('(') + 1, statements[2].indexOf(')')));
  assert.deepEqual(
    sorted(updateColumns),
    sorted(['state', 'revision', 'error_code', 'result_ref', 'updated_at']),
    `UPDATE 面必须仍是那 5 个随状态迁移变的列（实际 ${updateColumns.join('/')}）`,
  );
});

test('T2 断言面：90-assert 的 expected(jobs) 的 sel 与部署授权逐列同值，del 仍为 true', () => {
  const assertSql = readFileSync(ASSERT_SQL, 'utf8');
  const expectedStart = assertSql.indexOf('expected(tbl, sel, ins, upd, del) AS (VALUES');
  assert.ok(expectedStart >= 0, '90-assert 里找不到 expected(tbl, sel, ins, upd, del) 这个 CTE');

  const jobsTuple = assertSql.slice(expectedStart).match(
    /\('jobs',\s*ARRAY\[([\s\S]*?)\],\s*ARRAY\[([\s\S]*?)\],\s*ARRAY\[([\s\S]*?)\],\s*(true|false)\)/,
  );
  assert.ok(jobsTuple, 'expected(…) 里找不到 (jobs, ARRAY[sel], ARRAY[ins], ARRAY[upd], del) 这一行');

  const [, sel, ins, upd, del] = jobsTuple;
  const expectedSel = readColumnList(sel);
  assert.ok(
    expectedSel.includes('owner_id'),
    `90-assert 的 jobs 期望 SELECT 清单必须含 owner_id（否则断言面与授权面漂移）：${expectedSel.join('/')}`,
  );
  assert.deepEqual(
    sorted(expectedSel),
    sorted(EXPECTED_SELECT),
    `90-assert 的 sel 必须与 20-login-roles 的授权列逐列同值（实际 ${expectedSel.join('/')}）`,
  );
  // del 必须是 true：表级 DELETE 已由 gy-r71-jobs-ledger-purge-grant 授予，翻回 false 会让
  // 「断言说不许删、部署却授了删」这种反向漂移也变绿。
  assert.equal(del, 'true', 'expected(jobs) 的 del 必须是 true（表级 DELETE 已授；翻回 false 即与原意相反）');
  // INSERT / UPDATE 两面不受本片影响，但同一行里被读，顺手钉住形状。
  assert.ok(readColumnList(ins).includes('owner_id'), 'expected(jobs) 的 INSERT 面必须仍含 owner_id');
  assert.deepEqual(
    sorted(readColumnList(upd)),
    sorted(['state', 'revision', 'error_code', 'result_ref', 'updated_at']),
    'expected(jobs) 的 UPDATE 面必须仍是那 5 列',
  );
});

test('T3 读面：services/api/src 里没有 SELECT 读 public.jobs，owner_id 只用于删除谓词与权限探测', () => {
  const offenders = [];
  let deleteClauses = 0;

  for (const file of collectApiSources(API_SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/FROM\s+public\.jobs\b/gi)) {
      // 只回看当前语句片段（语句边界：分号、引号、反引号）。行内注释里的引文也算，
      // 因为那条引文是「DELETE FROM public.jobs WHERE owner_id = …」的复述。
      const before = text.slice(Math.max(0, match.index - 240), match.index);
      const clause = before.split(/[;`'"]/).pop() ?? '';
      if (/\bDELETE\b/i.test(clause) && !/\bSELECT\b/i.test(clause)) {
        deleteClauses += 1;
        continue;
      }
      offenders.push(`${fileURLToPath(file)}: …${clause.trim().slice(-80)} FROM public.jobs`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `public.jobs 是「零读面」的台账：出现 SELECT/其它语句读它即等于偷偷扩大读面：\n${offenders.join('\n')}`,
  );
  assert.ok(deleteClauses > 0, '扫不到任何 `FROM public.jobs` 说明扫描器失效了（本仓至少有一条 DELETE）');

  // 探测必须留着：它是「当前库缺不缺 owner_id 列权」的唯一运行时判据，删掉就只剩 42501 糊在清理里。
  const port = readFileSync(PURGE_PORT, 'utf8');
  assert.match(
    port,
    /has_column_privilege\(current_user,\s*'public\.jobs',\s*'owner_id',\s*'SELECT'\)/,
    "online-purge-port.ts 必须保留 has_column_privilege(…'public.jobs','owner_id','SELECT') 这条探测",
  );
  // 探测本身不是读面：它只查目录，不 FROM public.jobs。
  assert.doesNotMatch(
    port,
    /SELECT[\s\S]{0,200}?FROM\s+public\.jobs\b/i,
    'online-purge-port.ts 的探测不许退化成真读 public.jobs（探测只查 has_*_privilege 目录函数）',
  );
});

test('T4 语句面：JOB_LEDGER_PURGE_SQL 仍是按 owner_id 收窄的 DELETE', () => {
  assert.equal(
    JOB_LEDGER_PURGE_SQL,
    'DELETE FROM public.jobs WHERE owner_id = $1::uuid',
    '注销清理的删除语句形状变了：授权面（owner_id 列级 SELECT）与 90-assert 都按这条语句推导',
  );
  assert.match(
    JOB_LEDGER_PURGE_SQL,
    /^DELETE\s+FROM\s+public\.jobs\s+WHERE\s+owner_id\s*=\s*\$1::uuid$/,
    'DELETE 必须带 `WHERE owner_id = $1::uuid` 谓词（⛔ 不许退化成删整表）',
  );
  assert.doesNotMatch(JOB_LEDGER_PURGE_SQL, /\bRETURNING\b/i, '不加 RETURNING：行数由 rowCount 取，RETURNING 会额外要求列权');
});
