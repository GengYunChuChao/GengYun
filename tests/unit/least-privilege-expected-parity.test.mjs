// 授权两侧必须成对：`deploy/postgres-cvm/sql/20-login-roles.sql` 的实际授权
// 与 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的清单逐项一致。
//
// 为什么需要这条护栏（GY-R34-I19 的真实教训，两次都栽在同一个缝里）：
//   · `tests/unit/sql-column-coverage.test.mjs` 只读 `20-login-roles.sql` 的**文本**去核对
//     store 里的 DELETE 语句，它看不见 `90-assert` 里的 `expected` 清单；
//   · 反过来，`90-assert` 的 `has_table_privilege(...) = e.del` 只认自己的 `expected`；
//   · 于是「改了授权、没改断言清单」（或反之）不会有任何单测变红 —— 直到 deploy-sql-gate
//     在 PR 上整段红掉。两侧是同一事实的两次写法，必须双向核对。
//
// 本片（GY-R34 #19 片2）的口径是**函数面**，不是表面：
//   · 识别域/语音域五张正文表（recognition_jobs / recognition_records / recognition_selections /
//     speech_jobs / transcriptions）对运行时角色**一条 DELETE 都没有**，这是刻意的禁止面
//     （`deploy/postgres-cvm/evidence/probe-runtime-grants.sql` 逐条探针要求「直接 DELETE 必须
//     恰好 42501」，deploy-sql-gate 钉死 18 条 / 9 个对象）；
//   · 内容清理走迁移 0034 的两条窄口径 SECURITY DEFINER 函数，授权只有
//     `GRANT EXECUTE ON FUNCTION public.purge_owner_*(uuid) TO gengyun_api_runtime`。
//   所以护栏两个方向都要管：① 表面 DELETE 两侧一致（含"这五张表必须是 false/无授权"）；
//   ② 函数面 EXECUTE 授权与 `function_surface_manifest` 一致。
//
// 判据（四向）：
//   ① `20-login-roles.sql` 里 `GRANT DELETE ON public.<tbl>` 的每张表 ⇒ `expected` 必须为 true；
//   ② `expected` 里 `del = true` 的每张表 ⇒ 必须真有 `GRANT DELETE`；
//   ③ 五张正文表 ⇒ 两侧都必须是「没有」：无 `GRANT DELETE`、`expected.del = false`；
//   ④ `GRANT EXECUTE ... TO gengyun_api_runtime` 的每个函数 ⇒ `function_surface_manifest`
//      必须有一行 `kind = 'runtime'`（且本片两条清理函数必须两侧都在）。
// 任一侧漂移都判红，并逐项点名（只说“不一致”无法定位）。
//
// R34 片 3（2026-10-24，#19 / #10 · OCR 注销闭集）加了**第三个**核对面：
// `allow_table_dml(sch, tbl, priv)` 三元组清单。理由：`90-assert` 的断言 7 判的是「运行时在
// `pg_class` 上实际持有的表级写权限 ⊆ 白名单」，而 `expected.del` 判的是「授权文本与清单一致」——
// 两者是**两条独立判据**，漏一条就有第三种漂移形态：
//   · 授了表级 DELETE、`expected.del = true`，但**忘了进** `allow_table_dml` ⇒ 断言 7 在真库上红，
//     单测却全绿（这正是本片必须给 `ocr_jobs` / `ocr_records` 补三元组的原因）；
//   · 白名单里写了三元组、但没有任何对应 GRANT ⇒ 白名单在描述一个不存在的权限（谎言式宽松）。
// 本片的口径是**例外**：OCR 三表统一走表级 DELETE（用户 2026-10-24 批准，唯一例外）；
// 识别/语音五张正文表的禁止面（0034 函数路线）**一字不动** —— 见上面那条禁止面测试。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ROLES_SQL_URL = new URL('../../deploy/postgres-cvm/sql/20-login-roles.sql', import.meta.url);
const ASSERT_SQL_URL = new URL('../../deploy/postgres-cvm/sql/90-assert-least-privilege.sql', import.meta.url);

// 五张正文表：账号注销要清空它们，但**不许**给运行时表级 DELETE（清理只能走 0034 的函数）。
const OWNER_PURGE_DENY_DELETE_TABLES = [
  'recognition_jobs',
  'recognition_records',
  'recognition_selections',
  'speech_jobs',
  'transcriptions',
];

// 本片新增的两条窄函数：EXECUTE 只授运行时，五个正文表的清零经它们完成。
const OWNER_PURGE_FUNCTIONS = ['purge_owner_recognitions', 'purge_owner_speech'];

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

/**
 * 从 `20-login-roles.sql` 取「EXECUTE 授给运行时的**函数名**集合」。
 *
 * 形状：`GRANT EXECUTE ON FUNCTION public.<name>(<签名>) TO gengyun_api_runtime;`
 * （同一句可以授多条函数，逗号分隔），因此先按语句切，再在 ON 段落里逐个抓 `public.<name>(`。
 * 只看 TO 里真的写了 `gengyun_api_runtime` 的语句——授给其它组的不算运行时可执行。
 */
export function grantedRuntimeExecuteFunctions(rawSql) {
  const functions = new Set();
  const sql = stripNoise(rawSql);
  for (const statement of sql.matchAll(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+([\s\S]*?)\s+TO\s+([^;]+);/gi)) {
    const onClause = statement[1];
    const toClause = statement[2];
    if (!/\bgengyun_api_runtime\b/.test(toClause)) continue;
    for (const call of onClause.matchAll(/(?:public\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      functions.add(call[1]);
    }
  }
  return functions;
}

/**
 * 从 `90-assert` 的 `function_surface_manifest` 取 `函数名 → kind`。
 *
 * 形状：`('public', 'request_account_deletion', 'runtime', ARRAY['gengyun_api_runtime']::text[]),`
 * —— 每行一条，可以跨行折行，所以用「括号 + 三个字符串 + ARRAY」的非贪婪匹配。
 */
export function functionManifestKinds(rawAssert) {
  const block = /function_surface_manifest[\s\S]*?::text\[\]\)\s*\n\s*\),/i.exec(stripNoise(rawAssert));
  const kinds = new Map();
  if (block === null) return kinds;
  for (const row of block[0].matchAll(
    /\(\s*'(?:public|catalog_ops|staging_intake)'\s*,\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*,\s*'(runtime|internal|trigger)'\s*,/g,
  )) {
    kinds.set(row[1], row[2]);
  }
  return kinds;
}

test('表面成对：GRANT DELETE 与 90-assert 的 expected.del 逐表一致', () => {
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

test('禁止面守住：五张正文表对运行时既无 GRANT DELETE、expected 也是 false', () => {
  const rolesSql = readFileSync(ROLES_SQL_URL, 'utf8');
  const assertSql = readFileSync(ASSERT_SQL_URL, 'utf8');
  const granted = grantedDeleteTables(rolesSql);
  const flags = expectedDeleteFlags(assertSql);

  for (const table of OWNER_PURGE_DENY_DELETE_TABLES) {
    assert.equal(
      granted.has(table),
      false,
      `${table} 不允许有表级 GRANT DELETE：它是 probe-runtime-grants.sql 锁定的禁止面`
        + `（直接 DELETE 必须恰好 42501），清理只能经迁移 0034 的函数`,
    );
    assert.equal(
      flags.get(table),
      false,
      `${table} 在 90-assert 的 expected 里必须是 del=false（与「无 GRANT DELETE」成对）`,
    );
  }
});

test('函数面成对：EXECUTE 授给运行时的函数必须都在 function_surface_manifest 里登记为 runtime', () => {
  const rolesSql = readFileSync(ROLES_SQL_URL, 'utf8');
  const assertSql = readFileSync(ASSERT_SQL_URL, 'utf8');
  const granted = grantedRuntimeExecuteFunctions(rolesSql);
  const kinds = functionManifestKinds(assertSql);

  const unclassified = [...granted].filter((name) => kinds.get(name) !== 'runtime').sort();
  assert.deepEqual(
    unclassified,
    [],
    `这些函数在 20-login-roles.sql 里把 EXECUTE 授给了运行时，但 90-assert 的`
      + ` function_surface_manifest 没有登记为 runtime（断言 92 会因 grantee 集合不符判红）：`
      + `${unclassified.join(' / ')}`,
  );

  // 本片两条清理函数必须两侧都在（否则上面那条会在"两边都没有"时静默为真）。
  for (const name of OWNER_PURGE_FUNCTIONS) {
    assert.equal(granted.has(name), true, `${name} 必须有 GRANT EXECUTE … TO gengyun_api_runtime`);
    assert.equal(kinds.get(name), 'runtime', `${name} 必须在 function_surface_manifest 里登记为 runtime`);
  }
});

test('解析器自检：两侧清单都不为空，且本片两条函数与五张表都被解析到', () => {
  const rolesSql = readFileSync(ROLES_SQL_URL, 'utf8');
  const assertSql = readFileSync(ASSERT_SQL_URL, 'utf8');

  // 防「文件改形状 ⇒ 解析器静默返回空集 ⇒ 上面几条永远绿」。
  const flags = expectedDeleteFlags(assertSql);
  const granted = grantedDeleteTables(rolesSql);
  const runtimeFunctions = grantedRuntimeExecuteFunctions(rolesSql);
  const kinds = functionManifestKinds(assertSql);

  assert.ok(flags.size >= 29, `expected 清单应至少 29 条记录，实际解析到 ${flags.size} 条`);
  assert.ok(granted.size >= 9, `GRANT DELETE 应至少覆盖 9 张表，实际解析到 ${granted.size} 张`);
  assert.ok(runtimeFunctions.size >= 8, `EXECUTE 授给运行时的函数应至少 8 条，实际 ${runtimeFunctions.size}`);
  assert.ok(kinds.size >= 13, `function_surface_manifest 应至少 13 行，实际 ${kinds.size} 行`);

  for (const table of OWNER_PURGE_DENY_DELETE_TABLES) {
    assert.equal(flags.has(table), true, `${table} 必须出现在 90-assert 的 expected 清单里`);
  }
  for (const name of OWNER_PURGE_FUNCTIONS) {
    assert.equal(kinds.has(name), true, `${name} 必须出现在 function_surface_manifest 里`);
  }
});

test('反向控制：合成 SQL 任一侧漂移都会被点名（不是“永远绿”）', () => {
  const roles = [
    'GRANT DELETE ON public.alpha,',
    '                public.beta',
    '  TO gengyun_api_runtime;',
    'GRANT SELECT ON public.gamma TO gengyun_api_runtime;',
    '',
  ].join('\n');
  const row = (table, flag) => `     ('${table}',\n      ARRAY[]::text[],\n      ARRAY[]::text[],\n      ARRAY[]::text[],\n      ${flag}),`;
  const assertSql = [
    'function_surface_manifest(schema_name, func_name, kind, allowed_grantees) AS (VALUES',
    "    ('public',         'delta',                       'runtime',",
    "     ARRAY['gengyun_api_runtime']::text[]),",
    "    ('public',         'epsilon',                     'internal',",
    "     ARRAY['gengyun_source_operator']::text[])",
    '  ),',
    row('alpha', 'true'),
    row('beta', 'false'),
    row('gamma', 'true'),
    '',
  ].join('\n');

  const diff = parityDiff(roles, assertSql);
  assert.deepEqual(diff.grantedButNotExpected, ['beta'], 'beta 有 GRANT 但 expected=false ⇒ 必须点名');
  assert.deepEqual(diff.expectedButNotGranted, ['gamma'], 'gamma expected=true 但无 GRANT ⇒ 必须点名');
  assert.equal(diff.granted.has('alpha'), true);
  assert.equal(diff.flags.get('alpha'), true);

  // 函数面：`delta` 授了 EXECUTE 且登记 runtime ⇒ 一致；`zeta` 授了但没登记 ⇒ 必须点名。
  const rolesWithFunctions = [
    'GRANT EXECUTE ON FUNCTION public.delta(uuid) TO gengyun_api_runtime;',
    'GRANT EXECUTE ON FUNCTION public.zeta(uuid),',
    '                             public.epsilon(uuid) TO gengyun_api_runtime;',
    'GRANT EXECUTE ON FUNCTION public.eta(uuid) TO gengyun_source_operator;',
    '',
  ].join('\n');
  const grantedFunctions = grantedRuntimeExecuteFunctions(rolesWithFunctions);
  assert.deepEqual(
    [...grantedFunctions].sort(),
    ['delta', 'epsilon', 'zeta'],
    '只认 TO 里真的写了 runtime 的语句：授给 source_operator 的 eta 不算运行时可执行',
  );
  const kinds = functionManifestKinds(assertSql);
  assert.equal(kinds.get('delta'), 'runtime');
  assert.equal(kinds.get('epsilon'), 'internal', 'epsilon 登记成 internal ⇒ 与「授给运行时」冲突');
  assert.equal(kinds.get('zeta'), undefined, 'zeta 没有登记 ⇒ 必须被 unclassified 抓住');
});

/**
 * 从 `90-assert` 的 `allow_table_dml(sch, tbl, priv) AS (VALUES …)` 取三元组。
 *
 * 形状：`    ('public', 'ocr_jobs',              'DELETE'),` —— 一行一条。
 * 块边界 = 「起点」到其后第一处行首两个空格的 `),`（白名单内没有更深层的括号），
 * 因此不会把 `expected` 里跨多行的记录或 `domain_manifest` 的单行三元组误收进来。
 */
export function allowTableDmlTriples(rawAssert) {
  const sql = stripNoise(rawAssert);
  const start = sql.indexOf('allow_table_dml(sch, tbl, priv) AS (VALUES');
  if (start < 0) return [];
  const end = sql.indexOf('\n  ),', start);
  const block = end < 0 ? sql.slice(start) : sql.slice(start, end);
  return [...block.matchAll(
    /\(\s*'(public|catalog_ops|staging_intake)'\s*,\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*,\s*'(INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)'\s*\)/g,
  )].map((match) => ({ schema: match[1], table: match[2], privilege: match[3] }));
}

/** OCR 三表：R34 片 3 起统一走**表级** DELETE（用户 2026-10-24 批准的例外，唯一一处新增删除面）。 */
export const OCR_DELETE_TABLES = ['ocr_idempotency', 'ocr_jobs', 'ocr_records'];

/**
 * 三方核对面：授权文本（`GRANT DELETE`）/ `expected.del` / `allow_table_dml` 三元组。
 * 三个方向各自返回**被点名的表名**，空数组才是绿。
 */
export function ocrDeleteParity(rawRoles, rawAssert) {
  const granted = grantedDeleteTables(rawRoles);
  const flags = expectedDeleteFlags(rawAssert);
  const allowDelete = new Set(
    allowTableDmlTriples(rawAssert)
      .filter((row) => row.privilege === 'DELETE')
      .map((row) => row.table),
  );
  return {
    granted,
    flags,
    allowDelete,
    /** 有授权/有登记但缺 `GRANT DELETE` 行。 */
    missingGrant: OCR_DELETE_TABLES.filter((table) => !granted.has(table)),
    /** 有 `GRANT DELETE` 但没进白名单 ⇒ 断言 7 会在真库上判红。 */
    missingAllow: OCR_DELETE_TABLES.filter((table) => !allowDelete.has(table)),
    /** 有 `GRANT DELETE` 但 `expected.del` 不是 true。 */
    flagNotTrue: OCR_DELETE_TABLES.filter((table) => flags.get(table) !== true),
  };
}

test('OCR 三表：GRANT DELETE ↔ expected.del ↔ allow_table_dml 三方一致（R34 片 3）', () => {
  const rolesSql = readFileSync(ROLES_SQL_URL, 'utf8');
  const assertSql = readFileSync(ASSERT_SQL_URL, 'utf8');
  const parity = ocrDeleteParity(rolesSql, assertSql);

  assert.deepEqual(parity.missingGrant, [],
    `这些表在 expected / 白名单里登记了 DELETE，却没有 GRANT DELETE 行：${parity.missingGrant.join(' / ')}`);
  assert.deepEqual(parity.missingAllow, [],
    `这些表有表级 GRANT DELETE，却没进 allow_table_dml 白名单（断言 7 会在真库上判红）：`
      + `${parity.missingAllow.join(' / ')}`);
  assert.deepEqual(parity.flagNotTrue, [],
    `这些表有表级 GRANT DELETE，90-assert 的 expected.del 却不是 true：${parity.flagNotTrue.join(' / ')}`);

  // 覆盖方向**不止** OCR 三表：任何表级 DELETE 授权都不许漏登记。
  assert.deepEqual([...parity.granted].filter((table) => !parity.allowDelete.has(table)).sort(), [],
    '有表级 DELETE 却不在 allow_table_dml 白名单里 ⇒ 断言 7 必然在真库上红，单测必须先生红');

  // 反向的「谎言式宽松」钉成读数：白名单里的 DELETE 只允许多出 `idempotency_keys`
  // （它由 services/api/db/roles/auth_privacy.sql 授给运行时，不在 20-login-roles.sql 里）。
  assert.deepEqual([...parity.allowDelete].filter((table) => !parity.granted.has(table)).sort(), ['idempotency_keys'],
    '白名单里出现了没有任何 GRANT 支撑的 DELETE 三元组（白名单在描述一个不存在的权限）');
});

/** 合成变异用：把某张表 `expected` 记录里的 `del` 位（独占一行的 `true),`）改成 `false),`。 */
function flipExpectedDelFlag(sql, table) {
  // ⚠️ 必须锚在 `expected` 的记录头（表名独占一行、行尾逗号）—— `domain_manifest` 里也有
  // `('ocr_records', 'granted', true),` 这种**单行**三元组，按子串找会锚错记录。
  const startPattern = new RegExp(`\\n(\\s*)\\('${table}',\\s*\\n`);
  const startMatch = startPattern.exec(sql);
  assert.ok(startMatch !== null, `合成变异：${table} 必须出现在 expected 清单里（表名独占一行的记录头）`);
  const flagPattern = /\n(\s+)true\),/g;
  flagPattern.lastIndex = startMatch.index + startMatch[0].length;
  const match = flagPattern.exec(sql);
  assert.ok(match !== null, `合成变异：${table} 这条记录的 del 位必须是独占一行的 \`true),\``);
  return `${sql.slice(0, match.index)}\n${match[1]}false),${sql.slice(match.index + match[0].length)}`;
}

test('反向变异自证：删 GRANT 行 / 把 del 改回 false / 抹掉白名单三元组 ⇒ 每一处都被点名', () => {
  const rolesSql = readFileSync(ROLES_SQL_URL, 'utf8');
  const assertSql = readFileSync(ASSERT_SQL_URL, 'utf8');

  // 先证明基线确实是绿的（否则下面的"变异后变红"没有参照物）。
  const baseline = ocrDeleteParity(rolesSql, assertSql);
  assert.deepEqual([baseline.missingGrant, baseline.missingAllow, baseline.flagNotTrue], [[], [], []]);

  // 变异 ①：删掉 `ocr_jobs` 的那一条表级 GRANT DELETE。
  const droppedGrant = rolesSql.split('\n')
    .filter((line) => !/^GRANT DELETE ON public\.ocr_jobs TO gengyun_api_runtime;$/.test(line.trim()))
    .join('\n');
  assert.notEqual(droppedGrant, rolesSql, '变异 ① 必须真的删掉了一行');
  const afterDrop = ocrDeleteParity(droppedGrant, assertSql);
  assert.deepEqual(afterDrop.missingGrant, ['ocr_jobs'], '删掉 GRANT 行后必须点名 ocr_jobs');
  assert.deepEqual(afterDrop.missingAllow, [], '变异 ① 只该动"授权文本"这一面（白名单仍齐全）');

  // 变异 ②：把 `ocr_records` 的 expected.del 改回 false（本片改动前就是这个值）。
  const flipped = flipExpectedDelFlag(assertSql, 'ocr_records');
  assert.notEqual(flipped, assertSql, '变异 ② 必须真的改了 del 位');
  const afterFlip = ocrDeleteParity(rolesSql, flipped);
  assert.deepEqual(afterFlip.flagNotTrue, ['ocr_records'], '把 del 改回 false 后必须点名 ocr_records');
  assert.deepEqual(afterFlip.missingGrant, [], '变异 ② 只该动"expected 清单"这一面');

  // 变异 ③：抹掉 allow_table_dml 里的 `('public','ocr_jobs','DELETE')` 三元组。
  const droppedAllow = assertSql.split('\n')
    .filter((line) => !/^\s*\('public', 'ocr_jobs',\s*'DELETE'\),?$/.test(line))
    .join('\n');
  assert.notEqual(droppedAllow, assertSql, '变异 ③ 必须真的删掉了一行');
  const afterAllow = ocrDeleteParity(rolesSql, droppedAllow);
  assert.deepEqual(afterAllow.missingAllow, ['ocr_jobs'], '抹掉三元组后必须点名 ocr_jobs（断言 7 会红）');
  assert.deepEqual(afterAllow.missingGrant, [], '变异 ③ 只该动"白名单"这一面');

  // 解析器自检：白名单块必须真被解析到（防「形状变了 ⇒ 返回空集 ⇒ missingAllow 恒为空」）。
  const triples = allowTableDmlTriples(assertSql);
  assert.ok(triples.length >= 18, `allow_table_dml 应至少 18 个三元组，实际解析到 ${triples.length} 个`);
  assert.deepEqual(
    triples.filter((row) => row.table.startsWith('ocr')).map((row) => `${row.table}:${row.privilege}`),
    ['ocr_idempotency:DELETE', 'ocr_jobs:DELETE', 'ocr_records:DELETE'],
    'OCR 三表在当前白名单里各恰好一条 DELETE 三元组',
  );
});
