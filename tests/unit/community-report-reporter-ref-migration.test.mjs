/**
 * GY-R32 · 迁移 `0032` 的结构契约（`community_reports.reporter_id` 可空 + 行内注销引用）。
 *
 * 两臂分工（与 `community-author-ref-migration.test.mjs`（0030）刻意同构）：
 *   A. **DDL / 约束 / 回滚语义**：用内存 PostgreSQL 内核（PGlite 0.5.8，基于 PostgreSQL 18.x）
 *      真跑 `0001 → 0022 → 0032`，再跑 `rollback/0032_*.down.sql`。⚠️ 这证明的是 **SQL 语义**，
 *      ⛔ **不构成**目标 PostgreSQL 17.11 的真库验收（真库臂见 `tests/integration/community-pg.mjs`，
 *      未设 `COMMUNITY_PG_TEST_URL` 时 EXITCODE=77 = 未取得）。
 *   B. **授权面成对性（纯静态）**：`20-login-roles.sql` 的列级 GRANT 与
 *      `90-assert-least-privilege.sql` 的 sel/ins/upd 数组是"同一事实的两次写法"，
 *      这里逐列比对，并带一个负控制（把列删掉必须判红）。
 *
 * 为什么"真库才能测"的借口不成立：`exactly_one` 与形状 CHECK 是本片唯一的**结构性**保证。
 * 没有它们，"两列同空/同非空"就只是代码里的约定，任何旁路写入都能把一条举报变成"无主"或
 * "活账户与注销引用并存"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const BASE = [
  'services/api/db/migrations/0001_initial_schema.sql',
  'services/api/db/migrations/0022_community_persistence.sql',
];
const FORWARD = 'services/api/db/migrations/0032_community_report_reporter_ref.sql';
const ROLLBACK = 'services/api/db/migrations/rollback/0032_community_report_reporter_ref.down.sql';

const REF = 'gy-anon-0123456789abcdef';
const USER = '00000000-0000-4000-8000-0000000000b1';
const TARGET = '00000000-0000-4000-8000-00000000af01';

/** 起一个只跑 0001+0022 的库（0032 由各用例自己决定要不要跑）。 */
async function makeDb({ forward = true } = {}) {
  const db = new PGlite();
  for (const path of BASE) await db.exec(read(path));
  if (forward) await db.exec(read(FORWARD));
  return db;
}

let reportSeq = 0;
/** 造一条**老形态**举报（`reporter_id` 非空、匿名列为 NULL）；举报者账户先落库以满足外键。 */
async function seedReport(db, { reporterId = USER, id } = {}) {
  reportSeq += 1;
  const reportId = id ?? `00000000-0000-4000-8000-0000000ab${String(reportSeq).padStart(3, '0')}`;
  await db.query('INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [reporterId]);
  await db.query(
    `INSERT INTO community_reports
       (id, revision, reporter_id, target_type, target_id, target_revision, state, reason_code, detail, created_at)
     VALUES ($1, 1, $2, 'post', $3, 1, 'received', 'dangerous', '举报人自述', '2026-10-23T00:00:00Z')`,
    [reportId, reporterId, TARGET],
  );
  return reportId;
}

/** 最小列集的新形态插入（`id`/`created_at` 无默认值 ⇒ 必须显式给）。 */
function insertReportSql({ reporterId, anonRef }) {
  const reporter = reporterId === null ? 'NULL' : `'${reporterId}'::uuid`;
  const ref = anonRef === null ? 'NULL' : `'${anonRef}'`;
  reportSeq += 1;
  const id = `00000000-0000-4000-8000-0000000ac${String(reportSeq).padStart(3, '0')}`;
  return {
    id,
    sql: `INSERT INTO community_reports
            (id, revision, reporter_id, anonymized_author_ref, target_type, target_id, target_revision,
             state, reason_code, detail, created_at)
          VALUES ('${id}'::uuid, 1, ${reporter}, ${ref}, 'post', '${TARGET}'::uuid, 1,
                  'received', 'dangerous', NULL, '2026-10-23T00:00:00Z')`,
  };
}

// ---------------------------------------------------------------------------
// A. DDL / 约束
// ---------------------------------------------------------------------------
test('A1. 0032 落地后：reporter_id 可空、anonymized_author_ref 为 varchar(40)', async () => {
  const db = await makeDb();
  const rows = (await db.query(
    `SELECT column_name, is_nullable, data_type, character_maximum_length
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'community_reports'
        AND column_name IN ('reporter_id', 'anonymized_author_ref')
      ORDER BY column_name`,
  )).rows;
  assert.deepEqual(rows.map((row) => row.column_name), ['anonymized_author_ref', 'reporter_id'], '两列必须都在');
  const ref = rows.find((row) => row.column_name === 'anonymized_author_ref');
  const reporter = rows.find((row) => row.column_name === 'reporter_id');
  assert.equal(ref.data_type, 'character varying');
  assert.equal(Number(ref.character_maximum_length), 40, 'varchar(40) 与 0030 的两张表逐字一致');
  assert.equal(ref.is_nullable, 'YES');
  assert.equal(reporter.is_nullable, 'YES', '0032 的 DROP NOT NULL 必须生效');
  assert.equal(reporter.data_type, 'uuid', 'reporter_id 类型不变（⛔ 不改成 text 塞引用）');
  await db.close();
});

test('A2. 恰好一个举报者字段（num_nonnulls = 1）：两列同空 / 同非空都被拒绝', async () => {
  const db = await makeDb();
  await db.query('INSERT INTO users (id) VALUES ($1)', [USER]);

  // 同空 ⇒ 无主举报（处置轨迹里"有没有人报过"都说不清），必须拒绝。
  await assert.rejects(
    () => db.query(insertReportSql({ reporterId: null, anonRef: null }).sql),
    (error) => /community_reports_reporter_exactly_one|check constraint/i.test(String(error?.message)),
    '两列同空必须被 exactly_one 拒绝',
  );

  // 同非空 ⇒ "活账户 + 注销引用"并存，必须拒绝。
  await assert.rejects(
    () => db.query(insertReportSql({ reporterId: USER, anonRef: REF }).sql),
    (error) => /community_reports_reporter_exactly_one|check constraint/i.test(String(error?.message)),
    '两列同非空必须被 exactly_one 拒绝',
  );

  // 更新路径同样受约束：给已有 reporter_id 的行补引用 ⇒ 拒绝；只置空而不写引用 ⇒ 拒绝。
  const reportId = await seedReport(db);
  await assert.rejects(
    () => db.query('UPDATE community_reports SET anonymized_author_ref = $2 WHERE id = $1', [reportId, REF]),
    (error) => /community_reports_reporter_exactly_one|check constraint/i.test(String(error?.message)),
    '已有 reporter_id 的行不得再补匿名引用',
  );
  await assert.rejects(
    () => db.query('UPDATE community_reports SET reporter_id = NULL WHERE id = $1', [reportId]),
    (error) => /community_reports_reporter_exactly_one|check constraint/i.test(String(error?.message)),
    '只置空 reporter_id 而不写引用必须被拒绝（这正是"存储侧必须先拿到引用再清"的原因）',
  );

  // 正控制：合法形态（置空 + 写引用）必须被接受，否则上面的负例可能只是"所有 UPDATE 都失败"的假红。
  await db.query(
    'UPDATE community_reports SET reporter_id = NULL, anonymized_author_ref = $2 WHERE id = $1',
    [reportId, REF],
  );
  const row = (await db.query(
    'SELECT reporter_id, anonymized_author_ref FROM community_reports WHERE id = $1',
    [reportId],
  )).rows[0];
  assert.equal(row.reporter_id, null);
  assert.equal(row.anonymized_author_ref, REF);
  await db.close();
});

test('A3. 引用形状 CHECK：必须是 gy-anon-<16 小写 hex>，其他形态一律拒绝', async () => {
  const db = await makeDb();
  await db.query('INSERT INTO users (id) VALUES ($1)', [USER]);
  for (const bad of [
    'gy-anon-0123456789ABCDEf', // 大写 hex
    'gy-anon-0123456789abcde', // 15 位
    'gy-anon-0123456789abcdef0', // 17 位
    'gy-anon_' + '0'.repeat(16), // 分隔符错
    'anon-0123456789abcdef',
    'gy-anon-0123456789abcdeg', // 非 hex
    '00123456789abcdef', // 无前缀
  ]) {
    await assert.rejects(
      () => db.query(insertReportSql({ reporterId: null, anonRef: bad }).sql),
      (error) => /anon_ref_shape|check constraint/i.test(String(error?.message)),
      `形状不合法的引用必须被 CHECK 拒绝：${bad}`,
    );
  }
  // 合法形状可插入（否则上面的负例可能是"所有插入都失败"的假红）。
  await db.query(insertReportSql({ reporterId: null, anonRef: REF }).sql);
  const count = (await db.query('SELECT count(*)::int AS n FROM community_reports')).rows[0].n;
  assert.equal(count, 1);
  await db.close();
});

test('A4. FK 仍指向 users 且保持 ON DELETE CASCADE；已匿名举报（reporter_id=NULL）因此不再被级联删', async () => {
  const db = await makeDb();
  const reportId = await seedReport(db, { id: '00000000-0000-4000-8000-00000000af02' });

  // 外键存在、仍然 CASCADE（0032 没有动它 —— 这是"未注销举报语义一行不变"的结构证据）。
  const fk = (await db.query(
    `SELECT c.conname, c.confdeltype
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'community_reports' AND c.contype = 'f'
        AND pg_get_constraintdef(c.oid) LIKE '%users(id)%'`,
  )).rows;
  assert.equal(fk.length, 1, 'reporter_id 的 users 外键必须保留');
  assert.equal(fk[0].confdeltype, 'c', "confdeltype='c' ⇒ ON DELETE CASCADE 原样保留");

  // 孤儿 reporter_id 仍被外键挡住（未被注销的举报完整性不变）。
  await assert.rejects(
    () => db.query(insertReportSql({ reporterId: '00000000-0000-4000-8000-0000000000ff', anonRef: null }).sql),
    (error) => /foreign key/i.test(String(error?.message)),
    '孤儿 reporter_id 必须撞外键（不是撞别的 not-null）',
  );

  // 注销形态：置空 + 写引用（模拟 `purgeOwnerData` 的那一条 UPDATE）。
  await db.query(
    'UPDATE community_reports SET reporter_id = NULL, anonymized_author_ref = $2 WHERE id = $1',
    [reportId, REF],
  );

  // 物理删 users：已匿名举报**不再被级联删除**（F13「删除账号映射」的结构后果）。
  await db.query('DELETE FROM users WHERE id = $1', [USER]);
  const row = (await db.query(
    'SELECT reporter_id, anonymized_author_ref FROM community_reports WHERE id = $1',
    [reportId],
  )).rows[0];
  assert.ok(row !== undefined, '已匿名举报必须在 DELETE FROM users 之后仍然存在');
  assert.equal(row.reporter_id, null);
  assert.equal(row.anonymized_author_ref, REF);
  await db.close();
});

// ---------------------------------------------------------------------------
// A5. 回滚：没有匿名行时可完整还原；有匿名行时**明确失败**（不伪造 reporter_id）
// ---------------------------------------------------------------------------
test('A5. rollback（无匿名行）：列/约束删除、reporter_id 恢复 NOT NULL', async () => {
  const db = await makeDb();
  await seedReport(db, { id: '00000000-0000-4000-8000-00000000af03' });
  // 前置：库里**确实有 1 条普通（未注销）举报行**。
  // down 的 RAISE 判据是「存在**已匿名**行（`anonymized_author_ref IS NOT NULL`）」，⛔ 不是
  // 「存在任何行」—— 所以这个"有行"的库必须能正常回滚。少了这条前置，下面的"回滚成功"可能
  // 只是"空库也能回滚"的假绿，也就证明不了判据不是"任何行"。
  const beforeDown = (await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE anonymized_author_ref IS NOT NULL)::int AS anon
       FROM community_reports`,
  )).rows[0];
  assert.equal(Number(beforeDown.total), 1, '前置：回滚前库里必须有 1 条普通举报行');
  assert.equal(Number(beforeDown.anon), 0, '前置：且 0 条已匿名行 ⇒ 这是「可正常回滚」的库');

  await db.exec(read(ROLLBACK));

  const columns = (await db.query(
    `SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'community_reports'
        AND column_name IN ('reporter_id', 'anonymized_author_ref')`,
  )).rows;
  assert.equal(columns.some((row) => row.column_name === 'anonymized_author_ref'), false, '匿名列必须被删');
  assert.equal(
    columns.find((row) => row.column_name === 'reporter_id').is_nullable,
    'NO',
    'reporter_id 必须恢复 NOT NULL',
  );
  // 还原后老写路径照旧：reporter_id 必填（其余列都给齐，确保唯一的 not-null 违规就是 reporter_id）。
  await assert.rejects(
    () => db.query(
      `INSERT INTO community_reports
         (id, revision, target_type, target_id, target_revision, state, reason_code, detail, created_at)
       VALUES ('00000000-0000-4000-8000-00000000af04', 1, 'post', '${TARGET}', 1, 'received', 'other', NULL,
               '2026-10-23T00:00:00Z')`,
    ),
    (error) => /null value in column "reporter_id"/i.test(String(error?.message)),
  );
  await db.close();
});

test('A6. rollback（有匿名行）：明确失败并给出可读原因，且**不改动**任何行（事务回滚）', async () => {
  const db = await makeDb();
  const reportId = await seedReport(db, { id: '00000000-0000-4000-8000-00000000af05' });
  await db.query(
    'UPDATE community_reports SET reporter_id = NULL, anonymized_author_ref = $2 WHERE id = $1',
    [reportId, REF],
  );

  await assert.rejects(
    () => db.exec(read(ROLLBACK)),
    (error) => {
      const message = String(error?.message);
      // 判定的是**原因可读**（讲清楚"已匿名不可还原"），不是精确措辞：
      // 行数读数（1 条已匿名举报）必须出现在报错里，否则运维不知道该处置什么。
      return /不可回滚/.test(message) && /1/.test(message);
    },
    '存在已匿名举报时 down 必须明确失败（⛔ 不许伪造 reporter_id、也不许删行）',
  );
  // PGlite 的 `exec` 不替我们 ROLLBACK：脚本里 BEGIN 之后抛错，连接停在 aborted 事务上。
  // 真库的迁移执行器会回滚（`migrate.ts` 里按语句/事务边界处理），这里显式做同一步。
  await db.exec('ROLLBACK');

  // 失败后结构原样、行原样（down 的第一段 DO 抛异常 ⇒ 后续 ALTER 全未执行）。
  const columns = (await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'community_reports'
        AND column_name = 'anonymized_author_ref'`,
  )).rows;
  assert.equal(columns.length, 1, '失败的回滚不得留下半成品结构');
  const row = (await db.query(
    'SELECT reporter_id, anonymized_author_ref FROM community_reports WHERE id = $1',
    [reportId],
  )).rows[0];
  assert.equal(row.reporter_id, null);
  assert.equal(row.anonymized_author_ref, REF);
  await db.close();
});

// ---------------------------------------------------------------------------
// B. 授权面（纯静态 + 负控制）
// ---------------------------------------------------------------------------

/**
 * 从 `20-login-roles.sql` 里抽 `GRANT <PRIV> (cols) ON public.<table> TO …;` 的列集合。
 * 极简解析：本仓这类语句是一条 GRANT 一张表、列清单在括号里，跨行。
 */
function grantColumns(sql, table, privilege) {
  const pattern = new RegExp(
    `GRANT\\s+${privilege}\\s*\\(([^)]*)\\)\\s*ON\\s+public\\.${table}\\s+TO\\s+gengyun_api_runtime`,
    'gi',
  );
  const match = pattern.exec(sql);
  if (match === null) return null;
  return match[1].split(',').map((item) => item.trim()).filter(Boolean).sort();
}

/** 从 `90-assert-least-privilege.sql` 的 expected(...) 行里抽某表的 sel/ins/upd 数组。 */
function expectedArrays(sql, table) {
  const valuesAt = sql.indexOf('expected(tbl, sel, ins, upd, del) AS (VALUES');
  assert.notEqual(valuesAt, -1, '90-assert 里必须存在 expected(...) AS (VALUES 段');
  const valuesSql = sql.slice(valuesAt);
  const start = valuesSql.indexOf(`('${table}',`);
  assert.notEqual(start, -1, `90-assert 的 expected 段里必须能找到 ${table}`);
  const rest = valuesSql.slice(start);
  const end = /\n\s*(?:true|false)\),/.exec(rest);
  assert.ok(end !== null, `${table} 的 expected 行必须以 true/false 结尾`);
  const blockText = rest.slice(0, end.index);
  const arrays = [...blockText.matchAll(/ARRAY\[([^\]]*)\]/g)].map((match) => match[1]
    .split(',')
    .map((item) => item.trim().replace(/^'|'$/g, ''))
    .filter(Boolean)
    .sort());
  assert.equal(arrays.length, 3, `${table} 的 expected 行必须含 sel/ins/upd 三个数组（实际 ${arrays.length}）`);
  return { sel: arrays[0], ins: arrays[1], upd: arrays[2] };
}

test('B1. 20-login-roles：community_reports 的 SELECT/UPDATE 含匿名列，INSERT 不动', () => {
  const sql = read('deploy/postgres-cvm/sql/20-login-roles.sql');
  const sel = grantColumns(sql, 'community_reports', 'SELECT');
  const ins = grantColumns(sql, 'community_reports', 'INSERT');
  const upd = grantColumns(sql, 'community_reports', 'UPDATE');
  assert.ok(sel !== null && ins !== null && upd !== null, 'community_reports 必须有三条列级 GRANT');
  assert.ok(sel.includes('anonymized_author_ref'), 'SELECT 必须授权匿名列（`REPORT_COLUMNS` 要读它）');
  assert.ok(upd.includes('anonymized_author_ref'), 'UPDATE 必须授权匿名列（注销要写入引用）');
  assert.ok(upd.includes('reporter_id'), 'UPDATE 必须授权 reporter_id（注销要把它置 NULL）');
  assert.equal(ins.includes('anonymized_author_ref'), false, 'INSERT 列清单不得新增匿名列（新行恒为 NULL）');
  // 其余列面不得被顺手扩大：0032 只允许"SELECT +1（匿名列）、UPDATE +1（匿名列）"。
  assert.equal(sel.length, 11, `SELECT 列数必须是 11（0032 前 10），实际 ${sel.length}`);
  assert.equal(ins.length, 10, `INSERT 列数必须原样 10，实际 ${ins.length}`);
  assert.equal(upd.length, 10, `UPDATE 列数必须是 10（0032 前 9），实际 ${upd.length}`);
});

test('B2. 90-assert 的 expected 与 20-login-roles 的 GRANT 逐列一致（同一事实的两次写法）', () => {
  const grantSql = read('deploy/postgres-cvm/sql/20-login-roles.sql');
  const assertSql = read('deploy/postgres-cvm/sql/90-assert-least-privilege.sql');
  const grant = {
    sel: grantColumns(grantSql, 'community_reports', 'SELECT'),
    ins: grantColumns(grantSql, 'community_reports', 'INSERT'),
    upd: grantColumns(grantSql, 'community_reports', 'UPDATE'),
  };
  const expected = expectedArrays(assertSql, 'community_reports');
  assert.deepEqual(expected.sel, grant.sel, 'community_reports: 90-assert 的 sel 必须与 GRANT 逐列相同');
  assert.deepEqual(expected.ins, grant.ins, 'community_reports: 90-assert 的 ins 必须与 GRANT 逐列相同');
  assert.deepEqual(expected.upd, grant.upd, 'community_reports: 90-assert 的 upd 必须与 GRANT 逐列相同');
});

test('B3. 负控制：把 UPDATE(anonymized_author_ref) 从授权文本里删掉 ⇒ 上面的判据必须判红', () => {
  const sql = read('deploy/postgres-cvm/sql/20-login-roles.sql');
  // 只改举报表那条 UPDATE（模拟"改了 store、忘了补授权"的半片落地）。
  const mutated = sql.replace(
    /GRANT UPDATE \(revision,reporter_id,anonymized_author_ref,/i,
    'GRANT UPDATE (revision,reporter_id,',
  );
  assert.notEqual(mutated, sql, '变异必须真的改到文本（否则负控制是空的）');
  const upd = grantColumns(mutated, 'community_reports', 'UPDATE');
  assert.equal(upd.includes('anonymized_author_ref'), false, '变异后匿名列必须不在 UPDATE 列清单里');
  assert.throws(
    () => {
      if (!upd.includes('anonymized_author_ref')) throw new Error('community_reports 的 UPDATE 必须授权匿名列');
    },
    /必须授权匿名列/,
  );
});

test('B4. 运行时 SQL 真的会写这两列（静态证据）：SET reporter_id = NULL 与 anonymized_author_ref 成对出现', () => {
  const storePg = read('services/api/src/community/store-pg.ts');
  const updates = [...storePg.matchAll(
    /UPDATE community_reports\s+SET reporter_id = NULL, anonymized_author_ref = \$2\s+WHERE reporter_id = \$1::uuid\s+RETURNING id/g,
  )];
  assert.equal(updates.length, 1, '举报表必须恰好一条"置空举报者指针 + 写匿名引用 + RETURNING 统计行数"的 UPDATE');
  // ⛔ 反向：读路径不得再出现把 NULL 变字符串的旧写法（只查赋值形态，注释里提到它不算）。
  assert.equal(
    /reporter_id:\s*String\(row\.reporter_id\)/.test(storePg),
    false,
    "`reporter_id: String(row.reporter_id)` 会把 NULL 变成 'null'（0030 在 author_id 上踩过的同一个坑）",
  );
  // 剩余读数必须把举报计入（否则"只剩举报"的主体读数恒为 0 ⇒ 端口谎报 completed）。
  assert.equal(
    /FROM community_reports\s+WHERE reporter_id = \$1::uuid/.test(storePg),
    true,
    '剩余读数必须包含 community_reports 分支',
  );
});
