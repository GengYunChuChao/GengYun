/**
 * 内容域授权**三方一致**（静态、不连库）：`20-login-roles.sql` 的真实授权 ↔
 * `90-assert-least-privilege.sql` 的 `domain_manifest` / `expected` 列清单 / `allow_table_dml`。
 *
 * 为什么单独立一个文件（而不是并进 `least-privilege-expected-parity.test.mjs`）：
 * 那个文件只核对 **DELETE 位**（它的四向判据是围绕"禁止面"设计的）。本片新增的三张表
 * 恰恰**一条表级/列级 DELETE 都没有**（撤回是 lifecycle 状态位、幂等台账的释放与清理都走
 * UPDATE），所以那份护栏对它们是**空覆盖** —— 少授一列、多授一列、或把列清单照抄错，
 * 它都不会红。本文件补的正是这个缝：
 *
 * ① `20-login-roles.sql` 的列级授权 与 `expected` 的 `sel/ins/upd` 三个数组**逐列相等**
 *    （双向；任一方向多一列或少一列都点名）；
 * ② 三张表的 `del` 位必须 `false`，且全文不允许出现针对它们的
 *    `GRANT DELETE/TRUNCATE/REFERENCES/TRIGGER`；
 * ③ 三张表必须各有一条 `REVOKE ALL ON TABLE … FROM PUBLIC`；
 * ④ `domain_manifest` 三方都在且 `required = true`；`allow_table_dml` 里**一条都没有**
 *    （内容域没有任何表级 DML）；`external_manifest` 里也**一条都没有**（这三张表是
 *    20-login-roles 直授面，不经 5 个 NOLOGIN 组继承，不属于 external_manifest 的范畴）；
 * ⑤ `\echo` 摘要里的「N/N/N 列」读数必须等于 ① 实际解析出来的列数（摘要不许谎报）。
 *
 * 反向控制（读数会变红，不是"恒真"）：删掉任一条 GRANT ⇒ ① 双向差异非空；
 * 迁移或授权里出现 `GRANT DELETE` ⇒ ②；把列清单里多写一列 ⇒ ①＋② 同时点名。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ROLES_SQL = readFileSync(new URL('../../deploy/postgres-cvm/sql/20-login-roles.sql', import.meta.url), 'utf8');
const ASSERT_SQL = readFileSync(new URL('../../deploy/postgres-cvm/sql/90-assert-least-privilege.sql', import.meta.url), 'utf8');

/** 三张表的**期望列集**（本片契约；与迁移 0036 的列一一对应）。 */
const EXPECTED_COLUMNS = {
  admin_content_entities: {
    sel: [
      'id', 'family', 'steward_id', 'lifecycle', 'published_revision', 'published_at', 'published_by_id',
      'published_evidence_ref', 'published_reason', 'withdrawn_at', 'withdrawn_by_id', 'withdrawn_reason',
      'created_at',
    ],
    ins: ['id', 'family', 'steward_id', 'lifecycle', 'created_at'],
    upd: [
      'lifecycle', 'published_revision', 'published_at', 'published_by_id', 'published_evidence_ref',
      'published_reason', 'withdrawn_at', 'withdrawn_by_id', 'withdrawn_reason',
    ],
  },
  admin_content_revisions: {
    sel: ['entity_id', 'revision', 'content', 'author_id', 'derived_from_revision', 'created_at'],
    ins: ['entity_id', 'revision', 'content', 'author_id', 'derived_from_revision', 'created_at'],
    upd: [],
  },
  admin_content_idempotency: {
    sel: ['scope', 'key_hash', 'request_hash', 'response_status', 'outcome', 'expires_at'],
    ins: ['scope', 'key_hash', 'request_hash', 'response_status', 'outcome', 'expires_at'],
    upd: ['request_hash', 'response_status', 'outcome', 'expires_at'],
  },
};

const TABLES = Object.keys(EXPECTED_COLUMNS);

/** 去掉注释行与 psql 元命令行：两者都参与「肉眼像授权、实际不执行」的误读。 */
function stripNoise(sql) {
  return sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .filter((line) => !/^\s*\\/.test(line))
    .join('\n');
}

/**
 * 从 `20-login-roles.sql` 取「表名 → { select, insert, update }」列级授权集合。
 *
 * 形状（逐字来自该文件的 `gy-r34-content-grant` 段）：
 *   `GRANT SELECT (id,family,…,\n              created_at)\n  ON public.<tbl> TO gengyun_api_runtime;`
 * 所以列清单允许跨行；`ON` 与表名可以另起一行。
 */
export function parseRoleGrants(rawSql) {
  const sql = stripNoise(rawSql);
  const grants = new Map(TABLES.map((table) => [table, { select: new Set(), insert: new Set(), update: new Set() }]));
  for (const match of sql.matchAll(
    /GRANT\s+(SELECT|INSERT|UPDATE)\s*\(([\s\S]*?)\)\s*ON\s+(?:TABLE\s+)?public\.([a-z_]+)\s+TO\s+gengyun_api_runtime/gi,
  )) {
    const [, privilege, columns, table] = match;
    const bucket = grants.get(table);
    if (bucket === undefined) continue;
    const key = privilege.toLowerCase();
    for (const column of columns.matchAll(/([a-z_][a-z0-9_]*)/gi)) bucket[key].add(column[1].toLowerCase());
  }
  return grants;
}

/**
 * 从 `90-assert` 的 `expected(tbl, sel, ins, upd, del)` 里取三张表的三组列 + `del` 位。
 *
 * 形状：记录以「行首 + `('表名',`」开始，以「行首 + `true)`/`false)`」收尾；
 * 中间是三个（可能为空的）`ARRAY[…]`，注意空数组写作 `ARRAY[]::text[]`。
 */
export function parseExpectedColumns(rawAssert) {
  const sql = stripNoise(rawAssert);
  const start = sql.indexOf('expected(tbl, sel, ins, upd, del)');
  const end = sql.indexOf('allow_table_dml(sch, tbl, priv)');
  assert.ok(start >= 0 && end > start, 'expected(...) 与 allow_table_dml(...) 必须都在 90-assert 里（形状变了就要同步本护栏）');
  const block = sql.slice(start, end);
  const rows = new Map();
  const lines = block.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const open = /^\s*\('([a-z_]+)',\s*$/.exec(lines[index]);
    if (open === null || !TABLES.includes(open[1])) continue;
    const window = [];
    let del = null;
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      window.push(lines[cursor]);
      const close = /^\s*(true|false)\),?\s*$/.exec(lines[cursor]);
      if (close !== null) {
        del = close[1] === 'true';
        break;
      }
    }
    assert.notEqual(del, null, `${open[1]} 的记录没有以 true)/false) 收尾 —— expected 的形状变了`);
    const segments = window.join('\n').split('ARRAY[');
    const arrays = segments.slice(1).map((segment) => {
      const body = segment.slice(0, segment.indexOf(']'));
      return [...body.matchAll(/'([a-z_][a-z0-9_]*)'/gi)].map((column) => column[1].toLowerCase());
    });
    assert.equal(arrays.length, 3, `${open[1]} 必须恰好三个 ARRAY（sel/ins/upd），实际 ${arrays.length}`);
    rows.set(open[1], {
      sel: new Set(arrays[0]),
      ins: new Set(arrays[1]),
      upd: new Set(arrays[2]),
      del,
    });
  }
  return rows;
}

const sorted = (set) => [...set].sort();
const roles = parseRoleGrants(ROLES_SQL);
const expected = parseExpectedColumns(ASSERT_SQL);

test('① 列级授权与 expected 的 sel/ins/upd 逐列相等（双向）', () => {
  for (const table of TABLES) {
    const granted = roles.get(table);
    const declared = expected.get(table);
    assert.ok(declared !== undefined, `${table} 必须在 90-assert 的 expected 里有一行`);
    for (const [privilege, wanted] of [['select', 'sel'], ['insert', 'ins'], ['update', 'upd']]) {
      assert.deepEqual(
        sorted(granted[privilege]),
        [...EXPECTED_COLUMNS[table][wanted]].sort(),
        `20-login-roles.sql 的 ${privilege.toUpperCase()} 列集与契约不一致：${table}`,
      );
      assert.deepEqual(
        sorted(declared[wanted]),
        [...EXPECTED_COLUMNS[table][wanted]].sort(),
        `90-assert 的 expected.${wanted} 列集与契约不一致：${table}`,
      );
    }
  }
});

test('② 三张表：expected 的 del 位为 false，且全文没有任何 DELETE/TRUNCATE/REFERENCES/TRIGGER 授权', () => {
  for (const table of TABLES) {
    assert.equal(expected.get(table).del, false, `${table} 的 expected.del 必须是 false（本域没有整行删除）`);
  }
  for (const [label, sql] of [['20-login-roles.sql', ROLES_SQL], ['90-assert', ASSERT_SQL]]) {
    for (const table of TABLES) {
      const grant = new RegExp(
        `GRANT\\s+(DELETE|TRUNCATE|REFERENCES|TRIGGER)\\s+[^;]*\\b${table}\\b`,
        'i',
      );
      assert.equal(grant.test(sql), false, `${label} 里不允许出现针对 ${table} 的禁止面授权（命中：${grant.exec(sql)?.[0] ?? ''}）`);
    }
  }
});

test('③ 三张表必须各有一条 REVOKE ALL ON TABLE … FROM PUBLIC', () => {
  const revoked = new Set();
  for (const match of stripNoise(ROLES_SQL).matchAll(/REVOKE\s+ALL\s+ON\s+TABLE\s+([\s\S]*?)FROM\s+PUBLIC/gi)) {
    for (const name of match[1].matchAll(/([a-z_][a-z0-9_]*)/gi)) revoked.add(name[1].toLowerCase());
  }
  for (const table of TABLES) {
    assert.equal(revoked.has(table), true, `${table} 缺少 REVOKE ALL ON TABLE … FROM PUBLIC`);
  }
});

test('④ domain_manifest 三行 required=true；allow_table_dml 与 external_manifest 里都不得出现', () => {
  const sql = stripNoise(ASSERT_SQL);
  for (const table of TABLES) {
    assert.match(
      sql,
      new RegExp(`\\('${table}',\\s*'granted',\\s*true\\)`),
      `${table} 必须在 domain_manifest 里登记为 ('granted', true)`,
    );
  }
  const allowBlock = sql.slice(sql.indexOf('allow_table_dml(sch, tbl, priv)'), sql.indexOf('function_surface_manifest'));
  for (const table of TABLES) {
    assert.equal(allowBlock.includes(table), false, `${table} 不得出现在 allow_table_dml（内容域没有任何表级 DML）`);
  }
  const externalBlock = sql.slice(sql.indexOf('external_manifest('), sql.indexOf('external_violations'));
  for (const table of TABLES) {
    assert.equal(externalBlock.includes(table), false, `${table} 属于 20-login-roles 直授面，不得进 external_manifest`);
  }
});

test('⑤ \\echo 摘要里的「N/N/N 列」读数等于实际解析出的列数（摘要不许谎报）', () => {
  const summary = /public\.admin_content_entities（(\d+)\/(\d+)\/(\d+) 列）[\s\S]*?public\.admin_content_revisions（(\d+)\/(\d+)\/(\d+) 列）[\s\S]*?public\.admin_content_idempotency（(\d+)\/(\d+)\/(\d+) 列）/.exec(ROLES_SQL);
  assert.ok(summary !== null, '\\echo 摘要的形状变了（本护栏与它成对，必须同步）');
  const numbers = summary.slice(1, 10).map(Number);
  const measured = [
    roles.get('admin_content_entities').select.size, roles.get('admin_content_entities').insert.size, roles.get('admin_content_entities').update.size,
    roles.get('admin_content_revisions').select.size, roles.get('admin_content_revisions').insert.size, roles.get('admin_content_revisions').update.size,
    roles.get('admin_content_idempotency').select.size, roles.get('admin_content_idempotency').insert.size, roles.get('admin_content_idempotency').update.size,
  ];
  assert.deepEqual(numbers, measured, `\\echo 摘要读数 [${numbers.join('/')}] 与实际授权列数 [${measured.join('/')}] 不一致`);
});
