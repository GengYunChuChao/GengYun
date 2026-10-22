/**
 * GY-R31 · F13 后续切片：**迁移 0030 的结构契约**（`author_id` 可空 + 行内注销引用）。
 *
 * 两臂分工，刻意分开：
 *   A. **DDL / 约束 / 回滚语义**：用内存 PostgreSQL 内核（PGlite 0.5.8，基于 PostgreSQL 18.x）
 *      真跑 `0001 → 0022 → 0030`，再跑 `rollback/0030_*.down.sql`。⚠️ 这证明的是 **SQL 语义**，
 *      ⛔ **不构成**目标 PostgreSQL 17.11 的真库验收（真库臂见 `tests/integration/community-pg.mjs`，
 *      未设 `COMMUNITY_PG_TEST_URL` 时 EXITCODE=77 = 未取得）。
 *   B. **授权面成对性（纯静态）**：`20-login-roles.sql` 的列级 GRANT 与
 *      `90-assert-least-privilege.sql` 的 sel/upd 数组是"同一事实的两次写法"，
 *      这里逐列比对，并带一个负控制（把列删掉必须判红）。
 *
 * 为什么不用"真 PG 才能测"当借口跳过 A：这两条 CHECK 是本片唯一的**结构性**保证
 * （`num_nonnulls(...) = 1` + 引用形状）。没有它，"两列同空/同非空"就只是代码里的约定，
 * 任何一个旁路写入都能把一行变成"无主"或"双重作者"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const BASE = ['services/api/db/migrations/0001_initial_schema.sql', 'services/api/db/migrations/0022_community_persistence.sql'];
const FORWARD = 'services/api/db/migrations/0030_community_author_ref.sql';
const ROLLBACK = 'services/api/db/migrations/rollback/0030_community_author_ref.down.sql';

const REF = 'gy-anon-0123456789abcdef';

/** 起一个只跑 0001+0022 的库（0030 由各用例自己决定要不要跑）。 */
async function makeDb({ forward = true } = {}) {
  const db = new PGlite();
  for (const path of BASE) await db.exec(read(path));
  if (forward) await db.exec(read(FORWARD));
  return db;
}

/** 造一个用户 + 一条帖子（老形态：author_id 非空、匿名列为 NULL）。 */
async function seedPost(db, { authorId, id = '00000000-0000-4000-8000-00000000aa01' } = {}) {
  await db.query('INSERT INTO users (id) VALUES ($1)', [authorId]);
  await db.query(
    `INSERT INTO community_posts
       (id, author_id, revision, title, body, visibility, audit_state, created_at, updated_at)
     VALUES ($1, $2, 1, '标题', '正文', 'published', 'approved', '2026-10-22T00:00:00Z', '2026-10-22T00:00:00Z')`,
    [id, authorId],
  );
  return id;
}

/** 老形态插入的最小列集（`id`/`created_at`/`updated_at` 都没有默认值，必须显式给）。 */
const POST_STAMP = `'2026-10-22T00:00:00Z', '2026-10-22T00:00:00Z'`;

/** 确定性 id 生成器（PGlite 里 `id` 没有默认值 ⇒ 每条 INSERT 都要自带）。 */
function makeIds(prefix = 'bb') {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${prefix}${String(n).padStart(10, '0')}`;
  };
}

const USER = '00000000-0000-4000-8000-0000000000a1';

// ---------------------------------------------------------------------------
// A. DDL / 约束
// ---------------------------------------------------------------------------
test('A1. 0030 落地后：author_id 可空、anonymized_author_ref 为 varchar(40)，两表同形', async () => {
  const db = await makeDb();
  for (const table of ['community_posts', 'community_comments']) {
    const rows = (await db.query(
      `SELECT column_name, is_nullable, data_type, character_maximum_length
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
          AND column_name IN ('author_id', 'anonymized_author_ref')
        ORDER BY column_name`,
      [table],
    )).rows;
    assert.deepEqual(rows.map((row) => row.column_name), ['anonymized_author_ref', 'author_id'], `${table} 两列必须都在`);
    const ref = rows.find((row) => row.column_name === 'anonymized_author_ref');
    const author = rows.find((row) => row.column_name === 'author_id');
    assert.equal(ref.data_type, 'character varying');
    assert.equal(Number(ref.character_maximum_length), 40, 'varchar(40) 与迁移逐字一致');
    assert.equal(ref.is_nullable, 'YES');
    assert.equal(author.is_nullable, 'YES', '0030 的 DROP NOT NULL 必须生效');
    assert.equal(author.data_type, 'uuid', 'author_id 类型不变（⛔ 不改成 text 塞引用）');
  }
  await db.close();
});

test('A2. 恰好一个作者字段（num_nonnulls = 1）：两列同空 / 同非空都被拒绝', async () => {
  const db = await makeDb();
  await db.query('INSERT INTO users (id) VALUES ($1)', [USER]);

  // 同空 ⇒ 无主行，必须拒绝。
  await assert.rejects(
    () => db.query(
      `INSERT INTO community_posts
         (id, author_id, revision, title, body, visibility, audit_state, created_at, updated_at)
       VALUES ('00000000-0000-4000-8000-00000000bb01', NULL, 1, '标题', '正文', 'published', 'approved', ${POST_STAMP})`,
    ),
    (error) => /community_posts_author_exactly_one|check constraint/i.test(String(error?.message)),
    '两列同空必须被 exactly_one 拒绝',
  );

  // 同非空 ⇒ "活作者 + 注销引用"并存，必须拒绝。
  await assert.rejects(
    () => db.query(
      `INSERT INTO community_posts
         (id, author_id, anonymized_author_ref, revision, title, body, visibility, audit_state, created_at, updated_at)
       VALUES ('00000000-0000-4000-8000-00000000bb02', $1, $2, 1, '标题', '正文', 'published', 'approved', ${POST_STAMP})`,
      [USER, REF],
    ),
    (error) => /community_posts_author_exactly_one|check constraint/i.test(String(error?.message)),
    '两列同非空必须被 exactly_one 拒绝',
  );

  // 更新路径同样受约束：给已有 author_id 的行补引用 ⇒ 拒绝；把 author_id 与引用一起换成"都空" ⇒ 拒绝。
  const postId = await seedPost(db, {
    authorId: '00000000-0000-4000-8000-0000000000a2',
    id: '00000000-0000-4000-8000-00000000aa02',
  });
  await assert.rejects(
    () => db.query('UPDATE community_posts SET anonymized_author_ref = $2 WHERE id = $1', [postId, REF]),
    (error) => /community_posts_author_exactly_one|check constraint/i.test(String(error?.message)),
    '已有 author_id 的行不得再补匿名引用',
  );
  await assert.rejects(
    () => db.query('UPDATE community_posts SET author_id = NULL WHERE id = $1', [postId]),
    (error) => /community_posts_author_exactly_one|check constraint/i.test(String(error?.message)),
    '只置空 author_id 而不写引用必须被拒绝（这正是"存储侧必须兜底生成引用"的原因）',
  );

  // 评论表同形（同一条约束两份实现，必须各自生效）。
  await assert.rejects(
    () => db.query(
      `INSERT INTO community_comments (id, post_id, revision, body, visibility, audit_state, created_at)
       VALUES ('00000000-0000-4000-8000-00000000bb03', $1, 1, '正文', 'published', 'approved', '2026-10-22T00:00:00Z')`,
      [postId],
    ),
    (error) => /community_comments_author_exactly_one|check constraint/i.test(String(error?.message)),
  );
  await db.close();
});

test('A3. 引用形状 CHECK：必须是 gy-anon-<16 小写 hex>，其他形态一律拒绝', async () => {
  const db = await makeDb();
  await db.query('INSERT INTO users (id) VALUES ($1)', [USER]);
  const nextId = makeIds('cc');
  const insert = (ref) => db.query(
    `INSERT INTO community_posts
       (id, author_id, anonymized_author_ref, revision, title, body, visibility, audit_state, created_at, updated_at)
     VALUES ($1, NULL, $2, 1, '标题', '正文', 'published', 'approved', ${POST_STAMP})`,
    [nextId(), ref],
  );

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
      () => insert(bad),
      (error) => /anon_ref_shape|check constraint/i.test(String(error?.message)),
      `形状不合法的引用必须被 CHECK 拒绝：${bad}`,
    );
  }

  // 合法形状可插入（否则上面的负例可能只是"所有插入都失败"的假红）。
  await insert(REF);
  const count = (await db.query('SELECT count(*)::int AS n FROM community_posts')).rows[0].n;
  assert.equal(count, 1);
  await db.close();
});

test('A4. FK 仍指向 users 且保持 ON DELETE CASCADE；匿名行（author_id=NULL）因此不再被级联删', async () => {
  const db = await makeDb();
  const postId = await seedPost(db, { authorId: USER, id: '00000000-0000-4000-8000-00000000aa03' });

  // 外键存在、仍然 CASCADE（0030 没有动它 —— 这是"未注销行语义一行不变"的结构证据）。
  const fk = (await db.query(
    `SELECT c.conname, c.confdeltype
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'community_posts' AND c.contype = 'f'
        AND pg_get_constraintdef(c.oid) LIKE '%users(id)%'`,
  )).rows;
  assert.equal(fk.length, 1, 'author_id 的 users 外键必须保留');
  assert.equal(fk[0].confdeltype, 'c', "confdeltype='c' ⇒ ON DELETE CASCADE 原样保留");

  // 孤儿 author_id 仍被外键挡住（未被注销的行完整性不变）。
  await assert.rejects(
    () => db.query(
      `INSERT INTO community_posts
         (id, author_id, revision, title, body, visibility, audit_state, created_at, updated_at)
       VALUES ('00000000-0000-4000-8000-00000000dd01', '00000000-0000-4000-8000-0000000000ff', 1,
               '标题', '正文', 'published', 'approved', ${POST_STAMP})`,
    ),
    (error) => /foreign key/i.test(String(error?.message)),
    '孤儿 author_id 必须撞外键（不是撞别的 not-null）',
  );

  // 注销形态：author_id 置空 + 引用写入（模拟 purgeOwnerData 的那一条 UPDATE）。
  await db.query('UPDATE community_posts SET author_id = NULL, anonymized_author_ref = $2 WHERE id = $1', [postId, REF]);

  // 物理删 users：已匿名行**不再被级联删除**（F13「删除账号映射」的结构后果）。
  await db.query('DELETE FROM users WHERE id = $1', [USER]);
  const row = (await db.query('SELECT author_id, anonymized_author_ref FROM community_posts WHERE id = $1', [postId])).rows[0];
  assert.ok(row !== undefined, '已匿名行必须在 DELETE FROM users 之后仍然存在');
  assert.equal(row.author_id, null);
  assert.equal(row.anonymized_author_ref, REF);
  await db.close();
});

// ---------------------------------------------------------------------------
// A5. 回滚：没有匿名行时可完整还原；有匿名行时**明确失败**（不伪造 author_id）
// ---------------------------------------------------------------------------
test('A5. rollback（无匿名行）：列/约束删除、author_id 恢复 NOT NULL', async () => {
  const db = await makeDb();
  await seedPost(db, { authorId: USER, id: '00000000-0000-4000-8000-00000000aa04' });

  await db.exec(read(ROLLBACK));

  for (const table of ['community_posts', 'community_comments']) {
    const columns = (await db.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
          AND column_name IN ('author_id', 'anonymized_author_ref')`,
      [table],
    )).rows;
    assert.equal(columns.some((row) => row.column_name === 'anonymized_author_ref'), false, `${table} 匿名列必须被删`);
    assert.equal(columns.find((row) => row.column_name === 'author_id').is_nullable, 'NO', `${table} author_id 必须恢复 NOT NULL`);
  }
  // 还原后老写路径照旧：author_id 必填（id/created_at/updated_at 都给齐，
  // 确保唯一的 not-null 违规就是 author_id —— 否则这条断言会因为别的列而"假绿"）。
  await assert.rejects(
    () => db.query(
      `INSERT INTO community_posts (id, revision, title, body, visibility, audit_state, created_at, updated_at)
       VALUES ('00000000-0000-4000-8000-00000000ee01', 1, '标题', '正文', 'published', 'approved', ${POST_STAMP})`,
    ),
    (error) => /null value in column "author_id"/i.test(String(error?.message)),
  );
  await db.close();
});

test('A6. rollback（有匿名行）：明确失败并给出可读原因，且**不改动**任何行（事务回滚）', async () => {
  const db = await makeDb();
  const postId = await seedPost(db, { authorId: USER, id: '00000000-0000-4000-8000-00000000aa05' });
  await db.query('UPDATE community_posts SET author_id = NULL, anonymized_author_ref = $2 WHERE id = $1', [postId, REF]);

  await assert.rejects(
    () => db.exec(read(ROLLBACK)),
    (error) => {
      const message = String(error?.message);
      // 判定的是**原因可读**（讲清楚"已匿名不可还原"），不是精确措辞：
      // 行数读数（1 条已匿名帖子 / 0 条评论）必须出现在报错里，否则运维不知道该处置什么。
      return /不可回滚/.test(message) && /1/.test(message);
    },
    '存在已匿名行时 down 必须明确失败（⛔ 不许伪造 author_id、也不许删行）',
  );
  // PGlite 的 `exec` 不替我们 ROLLBACK：脚本里 BEGIN 之后抛错，连接停在 aborted 事务上。
  // 真库的迁移执行器会回滚（`migrate.ts` 里按语句/事务边界处理），这里显式做同一步。
  await db.exec('ROLLBACK');

  // 失败后结构原样、行原样（down 的第一段 DO 抛异常 ⇒ 后续 ALTER 全未执行）。
  const columns = (await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'community_posts'
        AND column_name = 'anonymized_author_ref'`,
  )).rows;
  assert.equal(columns.length, 1, '失败的回滚不得留下半成品结构');
  const row = (await db.query('SELECT author_id, anonymized_author_ref FROM community_posts WHERE id = $1', [postId])).rows[0];
  assert.equal(row.author_id, null);
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
  // 只看 `expected(tbl, sel, ins, upd, del) AS (VALUES` 之后的段：上面还有一张**分类清单**
  // （`('community_posts', 'granted', true),`），形状相似但语义完全不同 —— 曾把两者搞混。
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

test('B1. 20-login-roles：posts/comments 的 SELECT 含匿名列、UPDATE 含 author_id + 匿名列、INSERT 不动', async () => {
  const sql = read('deploy/postgres-cvm/sql/20-login-roles.sql');
  for (const table of ['community_posts', 'community_comments']) {
    const sel = grantColumns(sql, table, 'SELECT');
    const ins = grantColumns(sql, table, 'INSERT');
    const upd = grantColumns(sql, table, 'UPDATE');
    assert.ok(sel !== null && ins !== null && upd !== null, `${table} 必须有三条列级 GRANT`);
    assert.ok(sel.includes('anonymized_author_ref'), `${table} 的 SELECT 必须授权匿名列（读路径要投影它）`);
    assert.ok(upd.includes('author_id'), `${table} 的 UPDATE 必须授权 author_id（注销要把它置 NULL）`);
    assert.ok(upd.includes('anonymized_author_ref'), `${table} 的 UPDATE 必须授权匿名列（注销要写入引用）`);
    assert.equal(ins.includes('anonymized_author_ref'), false, 'INSERT 列清单不得新增匿名列（新行恒为 NULL）');
    // 其余列面不得被顺手扩大：0030 只允许"SELECT +1（匿名列）、UPDATE +2（author_id + 匿名列）"。
    const expected = table === 'community_posts'
      ? { sel: 16, ins: 15, upd: 14 }
      : { sel: 9, ins: 8, upd: 6 };
    assert.equal(sel.length, expected.sel, `${table} SELECT 列数必须是 ${expected.sel}（0030 前 ${expected.sel - 1}）`);
    assert.equal(ins.length, expected.ins, `${table} INSERT 列数必须原样（${expected.ins}）`);
    assert.equal(upd.length, expected.upd, `${table} UPDATE 列数必须是 ${expected.upd}（0030 前 ${expected.upd - 2}）`);
  }
});

test('B2. 90-assert 的 expected 与 20-login-roles 的 GRANT 逐列一致（同一事实的两次写法）', async () => {
  const grantSql = read('deploy/postgres-cvm/sql/20-login-roles.sql');
  const assertSql = read('deploy/postgres-cvm/sql/90-assert-least-privilege.sql');
  for (const table of ['community_posts', 'community_comments']) {
    const grant = {
      sel: grantColumns(grantSql, table, 'SELECT'),
      ins: grantColumns(grantSql, table, 'INSERT'),
      upd: grantColumns(grantSql, table, 'UPDATE'),
    };
    const expected = expectedArrays(assertSql, table);
    assert.deepEqual(expected.sel, grant.sel, `${table}: 90-assert 的 sel 必须与 GRANT 逐列相同`);
    assert.deepEqual(expected.ins, grant.ins, `${table}: 90-assert 的 ins 必须与 GRANT 逐列相同`);
    assert.deepEqual(expected.upd, grant.upd, `${table}: 90-assert 的 upd 必须与 GRANT 逐列相同`);
  }
});

test('B3. 负控制：把 UPDATE(author_id) 从授权文本里删掉 ⇒ 上面的判据必须判红', async () => {
  const sql = read('deploy/postgres-cvm/sql/20-login-roles.sql');
  // 只改 posts 的 UPDATE 列清单里的 author_id（模拟"只补了匿名列、忘了 author_id"的半片落地）。
  const mutated = sql.replace(/(GRANT UPDATE \([^)]*?),author_id,anonymized_author_ref\)/i, '$1,anonymized_author_ref)');
  assert.notEqual(mutated, sql, '变异必须真的改到文本（否则负控制是空的）');
  const upd = grantColumns(mutated, 'community_posts', 'UPDATE');
  assert.equal(upd.includes('author_id'), false, '变异后 author_id 必须不在 UPDATE 列清单里');
  // 判据本体（与 B1 同一条）：缺它就红。
  assert.throws(
    () => {
      if (!upd.includes('author_id')) throw new Error('community_posts 的 UPDATE 必须授权 author_id');
    },
    /必须授权 author_id/,
  );
});

test('B4. 运行时 SQL 真的会写这两列（静态证据）：SET author_id = NULL 与 anonymized_author_ref 成对出现', () => {
  const storePg = read('services/api/src/community/store-pg.ts');
  const updates = [...storePg.matchAll(
    /UPDATE community_(posts|comments)\s+SET author_id = NULL, anonymized_author_ref = \$2\s+WHERE id = ANY\(\$1::uuid\[\]\)\s+RETURNING id/g,
  )];
  assert.deepEqual(
    updates.map((match) => match[1]).sort(),
    ['comments', 'posts'],
    '两张表各一条"置空作者指针 + 写匿名引用 + RETURNING 统计行数"的 UPDATE',
  );
  // ⛔ 反向：读路径不得再出现把 NULL 变字符串的旧写法（只查赋值形态，注释里提到它不算）。
  assert.equal(
    /author_id:\s*String\(row\.author_id\)/.test(storePg),
    false,
    "`author_id: String(row.author_id)` 会把 NULL 变成 'null'（0030 的坑）",
  );
});
