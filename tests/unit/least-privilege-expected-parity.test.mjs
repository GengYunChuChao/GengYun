// 授权两侧必须成对：`deploy/postgres-cvm/sql/20-login-roles.sql` 的 `GRANT DELETE`
// 与 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的 `expected.del` 逐表一致。
//
// 为什么需要这条护栏（GY-R34-I19 的真实教训）：`tests/unit/sql-column-coverage.test.mjs`
// 只读 `20-login-roles.sql` 的**文本**去核对 store 里的 DELETE 语句，它看不见 `90-assert`
// 里的 `expected` 清单。本片给五张表补了 `GRANT DELETE`，棘轮立刻转绿；但 `expected` 里
// 这五行仍是 `false` ⇒ `90-assert` 的 `has_table_privilege(...) = e.del` 判红 ⇒
// `deploy-sql-gate`（`on: pull_request`）必红。两侧是同一事实的两次写法，必须双向核对。
//
// 判据（双向）：
//   ① `20-login-roles.sql` 里 `GRANT DELETE ON public.<tbl>` 的每张表 ⇒ `expected` 必须为 true；
//   ② `expected` 里 `del = true` 的每张表 ⇒ 必须真有 `GRANT DELETE`。
// 任一侧漂移都判红，并逐表点名（只说“不一致”无法定位）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ROLES_SQL_URL = new URL('../../deploy/postgres-cvm/sql/20-login-roles.sql', import.meta.url);
const ASSERT_SQL_URL = new URL('../../deploy/postgres-cvm/sql/90-assert-least-privilege.sql', import.meta.url);

// 本片新增授权涉及的五张正文表（账号注销按主体清空需要表级 DELETE）。
const OWNER_PURGE_TABLES = [
  'recognition_jobs',
  'recognition_records',
  'recognition_selections',
  'speech_jobs',
  'transcriptions',
];

/** 去掉注释行与 psql 元命令行：两者都参与「肉眼像授权、实际不执行」的误读。 */
function stripNoise(sql) {
  return sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .filter((line) => !/^\s*\\/.test(line))
    .join('\n');
}

/**
 * 从 `90-assert` 的 `expected` 清单取「表名 → del 位」。
 *
 * 形状锚点（逐字来自该文件）：每条记录跨多行，
 *   `     ('<表>',` … `      ARRAY[...],` … `      true),` / `      false),`
 * 因此只在「表名独占一行且行尾是逗号」时开一条记录，在「独占一行的 true/false)」时收尾。
 * 单行形态（`('recognition_jobs', 'granted', true),`、`('public', 'x', 'DELETE'),`）
 * 不会被误收——它们不以逗号结尾。
 */
export function expectedDeleteFlags(rawSql) {
  const flags = new Map();
  let current = null;
  for (const line of stripNoise(rawSql).split('\n')) {
    const start = /^\s*\('([A-Za-z_][A-Za-z0-9_]*)',\s*$/.exec(line);
    if (start !== null) {
      current = start[1];
      continue;
    }
    if (current === null) continue;
    const end = /^\s*(true|false)\),?\s*$/.exec(line);
    if (end !== null) {
      flags.set(current, end[1] === 'true');
      current = null;
    }
  }
  return flags;
}

/** 从 `20-login-roles.sql` 取「真有 GRANT DELETE 的表」（支持一条语句授多表）。 */
export function grantedDeleteTables(rawSql) {
  const tables = new Set();
  const sql = stripNoise(rawSql);
  for (const match of sql.matchAll(/GRANT\s+DELETE\s+ON\s+([\s\S]*?)\s+TO\s+/gi)) {
    for (const part of match[1].split(',')) {
      const name = part
        .trim()
        .replace(/^public\./i, '')
        .replace(/"/g, '');
      // `GRANT DELETE ON ALL TABLES IN SCHEMA …` 这类整体授权不是本护栏的判据对象。
      if (name.length === 0 || /\b(ALL|TABLES|IN|SCHEMA)\b/i.test(name)) continue;
      tables.add(name);
    }
  }
  return tables;
}

/** 双向差异：返回两组表名（都可能为空数组）。 */
export function parityDiff(rawRoles, rawAssert) {
  const granted = grantedDeleteTables(rawRoles);
  const flags = expectedDeleteFlags(rawAssert);
  const expectedTrue = [...flags].filter(([, value]) => value).map(([table]) => table);
  return {
    granted,
    flags,
    // 授了但 expected 说没有 ⇒ deploy-sql-gate 会在 `has_table_privilege(...) = e.del` 判红
    grantedButNotExpected: [...granted].filter((table) => flags.get(table) !== true).sort(),
    // expected 说有但没授 ⇒ 断言同样红，且说明这份清单在描述一个不存在的权限
    expectedButNotGranted: expectedTrue.filter((table) => !granted.has(table)).sort(),
  };
}

test('授权两侧成对：GRANT DELETE 与 90-assert 的 expected.del 逐表一致', () => {
  const rolesSql = readFileSync(ROLES_SQL_URL, 'utf8');
  const assertSql = readFileSync(ASSERT_SQL_URL, 'utf8');
  const diff = parityDiff(rolesSql, assertSql);

  assert.deepEqual(
    diff.grantedButNotExpected,
    [],
    `这些表在 20-login-roles.sql 里授了表级 DELETE，但 90-assert 的 expected 仍写 del=false`
      + `（deploy-sql-gate 会判红）：${diff.grantedButNotExpected.join(' / ')}`,
  );
  assert.deepEqual(
    diff.expectedButNotGranted,
    [],
    `这些表在 90-assert 的 expected 里写 del=true，但 20-login-roles.sql 没有对应 GRANT DELETE：`
      + `${diff.expectedButNotGranted.join(' / ')}`,
  );
});

test('解析器自检：两侧清单都不是空集，且本片五张正文表两侧都在', () => {
  const rolesSql = readFileSync(ROLES_SQL_URL, 'utf8');
  const assertSql = readFileSync(ASSERT_SQL_URL, 'utf8');
  const diff = parityDiff(rolesSql, assertSql);

  // 防「文件改形状 ⇒ 解析器静默返回空集 ⇒ 上面那条断言永远绿」。
  assert.ok(diff.flags.size >= 29, `expected 清单应至少 29 条记录，实际解析到 ${diff.flags.size} 条`);
  assert.ok(diff.granted.size >= 9, `GRANT DELETE 应至少覆盖 9 张表，实际解析到 ${diff.granted.size} 张`);

  for (const table of OWNER_PURGE_TABLES) {
    assert.equal(diff.granted.has(table), true, `${table} 必须有 GRANT DELETE（账号注销按主体清空）`);
    assert.equal(diff.flags.get(table), true, `${table} 在 90-assert 的 expected 里必须是 del=true`);
  }
});

test('反向控制：合成 SQL 两侧任一侧漂移都会点名（不是“永远绿”）', () => {
  const roles = [
    'GRANT DELETE ON public.alpha,',
    '                public.beta',
    '  TO gengyun_api_runtime;',
    'GRANT SELECT ON public.gamma TO gengyun_api_runtime;',
    '',
  ].join('\n');
  const row = (table, flag) => `     ('${table}',\n      ARRAY[]::text[],\n      ARRAY[]::text[],\n      ARRAY[]::text[],\n      ${flag}),`;
  const assertSql = [row('alpha', 'true'), row('beta', 'false'), row('gamma', 'true'), ''].join('\n');

  const diff = parityDiff(roles, assertSql);
  assert.deepEqual(diff.grantedButNotExpected, ['beta'], 'beta 有 GRANT 但 expected=false ⇒ 必须点名');
  assert.deepEqual(diff.expectedButNotGranted, ['gamma'], 'gamma expected=true 但无 GRANT ⇒ 必须点名');
  assert.equal(diff.granted.has('alpha'), true);
  assert.equal(diff.flags.get('alpha'), true);
});
