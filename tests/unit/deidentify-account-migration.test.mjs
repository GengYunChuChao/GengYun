/**
 * 迁移 `0057_deidentify_account_on_deletion.sql` 的结构性契约（`#19` 片1 · GY-I19）。
 *
 * 为什么单测要逐字咬住这份迁移：它引入的是**仓库里第一条「在注销受理事务内擦人」的写路径**
 * （`public.deidentify_account(uuid)`）。这类函数的危险不在语法，而在「看起来能跑、实际擦少了 /
 * 擦多了 / 悄悄多推进一格 revision」——这些都不会让 CI 变红，只会让证据页上的读数变成谎话。
 * 所以这里把四条硬条件逐条钉成断言：
 *
 * 1. **失败关闭的状态门**：`G0001`/`G0002`/`G0015` 三个守卫必须都在，且 `G0015`（状态不是
 *    `deletion_pending`）必须出现在 users 的 UPDATE **之前** —— 顺序错了就变成「先擦后判」，
 *    一旦状态门不过，擦除已经发生、事务回滚只是运气。
 * 2. **擦除列恰好是那四列 + `deletion_generation`**：多一列就是越权擦除（`auth_epoch`/`state`/
 *    `revision` 都不许动），少一列就是去身份没做完。
 * 3. **`exports` 只清 `provider_request_ref_cipher`**：`recipient_id`（NOT NULL）、
 *    `object_key`/`object_id`（`0015` 的双向 XOR 约束）与 `export_writebacks` 都是对账证据链，
 *    动它们不是「多擦一点」，是**改坏契约**（约束报错或证据缺失）。
 * 4. **函数体内不出现 `revision`**：受理函数（`0016`）已经把 `revision` 推进一次并写进 202 回执，
 *    去身份再推进一次会让 `accountRevision` 掉队一格（回执与库内不一致）。
 *
 * 另外钉住迁移文件自身的卫生：**零 GRANT**（唯一的 EXECUTE 授权在 `20-login-roles.sql`，
 * 因为 `gengyun_api_runtime` 在迁移之后才创建）、只有 `REVOKE ALL ... FROM PUBLIC`、
 * 末尾 `COMMIT;`、表/类型全部 `public.` 限定（`search_path=pg_catalog` 下不限定就是 `42P01`）。
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../services/api/db/migrations/', import.meta.url));
const MIGRATION_NAME = '0057_deidentify_account_on_deletion.sql';
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_NAME);

const source = readFileSync(MIGRATION_PATH, 'utf8');

/** 去掉 `--` 行注释：断言只咬**可执行**文本，避免注释里提到 `revision` 就误判。 */
function executable(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

const body = executable(source);

/** 取 `CREATE FUNCTION ... $$ ... $$;` 之间的函数体（含 DECLARE）。 */
function functionBody(sql) {
  const start = sql.indexOf('AS $$');
  assert.notEqual(start, -1, '迁移里必须有 `AS $$`（plpgsql 函数体起点）');
  const end = sql.indexOf('$$;', start);
  assert.notEqual(end, -1, '函数体必须以 `$$;` 收尾');
  return sql.slice(start, end);
}

const fn = functionBody(body);

test('迁移号：0057 是当前目录里的最大号，且文件名与既有命名体例一致', () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((name) => /^\d{4}_.*\.sql$/.test(name));
  const versions = files.map((name) => Number(name.slice(0, 4)));
  // ⛔ 不用 `.length - 1` / `.at(-1)` 这类「末位形态」：`tests/unit/migration-pin-guard.test.mjs`
  // 会把它判成未登记的末位判据（D1/D2）。这里用 `Math.max` + 显式字面量比较。
  assert.equal(Math.max(...versions), 57, `迁移目录最大号必须是 0057；现场 ${Math.max(...versions)}`);
  assert.ok(files.includes(MIGRATION_NAME), `${MIGRATION_NAME} 必须已落盘`);
  assert.match(
    MIGRATION_NAME,
    /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/,
    '迁移文件名必须是 4 位号 + 小写下划线 + .sql（与既有 57 份同名同形）',
  );
});

test('函数头逐字：签名 `(p_user_id uuid)`、jsonb、plpgsql、SECURITY DEFINER、固定 search_path / TimeZone', () => {
  assert.ok(
    body.includes('CREATE FUNCTION public.deidentify_account(p_user_id uuid)'),
    '函数必须是 public.deidentify_account(p_user_id uuid) —— schema 与参数名都全限定/点名，'
      + '90-assert 的 deidentify_function_exists 会按 `pg_get_function_identity_arguments` 逐字比对',
  );
  // 七行连写的形式最容易在读代码时被「看起来一样」骗过，故按邻接块咬。
  assert.ok(
    body.includes(
      'RETURNS jsonb\n'
        + 'LANGUAGE plpgsql\n'
        + 'SECURITY DEFINER\n'
        + "SET search_path = pg_catalog\n"
        + "SET TimeZone = 'UTC'",
    ),
    '函数头必须是 jsonb / plpgsql / SECURITY DEFINER / search_path = pg_catalog / TimeZone = \'UTC\' 五件套'
      + '（search_path 固定成 pg_catalog 是「函数内一切对象都必须全限定」的前提）',
  );
  assert.equal(/SET search_path\s*=\s*public/i.test(body), false, '⛔ search_path 不许写 public/`$user`');
});

test('三件套守卫：NULL ⇒ G0001、查不到 ⇒ G0002、状态不符 ⇒ G0015', () => {
  assert.match(
    fn,
    /IF p_user_id IS NULL THEN\s*\n\s*RAISE EXCEPTION USING ERRCODE = 'G0001'/,
    '入参 NULL 必须是 G0001（调用方 bug，不是「查不到」）',
  );
  assert.match(
    fn,
    /IF NOT FOUND THEN\s*\n\s*RAISE EXCEPTION USING ERRCODE = 'G0002'/,
    '主体不存在必须是 G0002（`SELECT ... FOR UPDATE` 之后立刻判 NOT FOUND）',
  );
  assert.match(
    fn,
    /IF x_state <> 'deletion_pending' THEN\s*\n\s*RAISE EXCEPTION USING ERRCODE = 'G0015'/,
    '状态门必须是 G0015（非 deletion_pending ⇒ 去身份没有合法依据，确定性失败）',
  );
  // 行锁必须在状态门之前：先锁行再读 state，读到的才是「本事务内不会被别人改」的值。
  assert.ok(
    fn.indexOf('FOR UPDATE') < fn.indexOf("IF x_state <> 'deletion_pending'"),
    '`SELECT ... FOR UPDATE` 必须出现在状态门之前（否则读到的是未加锁的旧快照）',
  );
});

test('G0015 守卫出现在 users 的 UPDATE 之前（顺序错了就是「先擦后判」）', () => {
  const guardAt = body.indexOf("IF x_state <> 'deletion_pending' THEN");
  const usersUpdateAt = body.indexOf('UPDATE public.users');
  assert.notEqual(guardAt, -1, 'G0015 守卫必须在迁移里');
  assert.notEqual(usersUpdateAt, -1, '必须有对 public.users 的 UPDATE');
  assert.ok(
    guardAt < usersUpdateAt,
    `G0015 守卫（偏移 ${guardAt}）必须在 users UPDATE（偏移 ${usersUpdateAt}）之前`,
  );
});

test('擦除列恰好四列 + `deletion_generation`：每列各一次 `= NULL`，且不碰 state/auth_epoch/revision', () => {
  const usersUpdate = body.slice(body.indexOf('UPDATE public.users'), body.indexOf('GET DIAGNOSTICS'));
  for (const column of ['nickname', 'avatar_media_id', 'wechat_subject_cipher', 'wechat_subject_lookup']) {
    const matches = usersUpdate.match(new RegExp(`\\b${column} = NULL`, 'g')) ?? [];
    assert.equal(matches.length, 1, `SET 子句里 \`${column} = NULL\` 必须恰好一次；现场 ${matches.length}`);
  }
  assert.ok(
    /deletion_generation = deletion_generation \+ 1/.test(usersUpdate),
    '擦除成功时 `deletion_generation` 必须 +1（计数器只为「真擦过」前进）',
  );
  assert.ok(/updated_at = now\(\)/.test(usersUpdate), '擦除必须带 `updated_at = now()`（不然 updated_at 骗人）');
  // ⛔ 擦除不能顺手改状态机：state / auth_epoch / revision 都只由受理函数（0016）推进。
  for (const forbidden of ['SET state', 'auth_epoch', 'revision']) {
    assert.equal(
      usersUpdate.includes(forbidden),
      false,
      `users 的 SET 子句不得出现 \`${forbidden}\`（只由 0016 的受理函数推进）`,
    );
  }
  // 幂等依据：WHERE 必须靠「任一 PII 列 IS NOT NULL」而不是无条件匹配。
  assert.ok(
    /AND \(nickname IS NOT NULL/.test(usersUpdate),
    'WHERE 必须带 `AND (nickname IS NOT NULL ...)` —— 这是「重复调用 identity=0 且 generation 不再自增」的唯一依据',
  );
});

test('函数体内不出现 `revision`（否则 202 的 accountRevision 掉队一格）', () => {
  assert.equal(
    /revision/.test(fn),
    false,
    '`public.deidentify_account` 的函数体不得出现 `revision`：'
      + '0016 的受理函数已把 revision 推进一次并写进回执，这里再推就是回执与库内差一格',
  );
});

test('恰两条 `GET DIAGNOSTICS ... ROW_COUNT`，且分别绑到 identity / exports 两个读数', () => {
  const matches = fn.match(/GET DIAGNOSTICS\s+x_\w+\s*=\s*ROW_COUNT/g) ?? [];
  assert.deepEqual(
    matches,
    ['GET DIAGNOSTICS x_identity = ROW_COUNT', 'GET DIAGNOSTICS x_exports = ROW_COUNT'],
    '必须恰两条 GET DIAGNOSTICS：① users 擦除行数 ② exports 擦除行数（顺序亦然）',
  );
  assert.match(
    fn,
    /RETURN jsonb_build_object\(\s*\n\s*'userId', p_user_id,\s*\n\s*'state', x_state,\s*\n\s*'identity', x_identity,\s*\n\s*'exports', x_exports,\s*\n\s*'generation', x_generation\s*\n\s*\);/,
    '返回值必须是 {userId, state, identity, exports, generation} 五键（键名定了，调用点 toDeidentified() 才咬得住）',
  );
});

test('exports 的 SET 子句只有 `provider_request_ref_cipher` / `updated_at`（recipient_id 等一律不动）', () => {
  const start = body.indexOf('UPDATE public.exports');
  assert.notEqual(start, -1, '必须有对 public.exports 的 UPDATE');
  const setClause = body.slice(body.indexOf('SET', start), body.indexOf('WHERE', start));
  const assigned = [...setClause.matchAll(/(\w+) = (?:NULL|now\(\))/g)].map((match) => match[1]);
  assert.deepEqual(
    assigned,
    ['provider_request_ref_cipher', 'updated_at'],
    '⛔ exports 只清第三方请求引用密文与 updated_at：recipient_id（NOT NULL）、object_key/object_id'
      + '（0015 双向 XOR）、state/deletion_state/auth_epoch 都是对账证据链，动了就是改坏契约',
  );
  assert.ok(
    /WHERE user_id = p_user_id\s*\n\s*AND provider_request_ref_cipher IS NOT NULL/.test(body),
    'exports 的 WHERE 必须是 `user_id = p_user_id AND provider_request_ref_cipher IS NOT NULL`'
      + '（后者保证重复调用不改 updated_at，不制造假的「最近有外发」时间戳）',
  );
  assert.equal(
    /export_writebacks/.test(fn),
    false,
    '⛔ 函数体不得出现 export_writebacks（回写台账无 PII 列，不需要也不允许在此改动）',
  );
});

test('迁移卫生：零 GRANT、只 REVOKE ALL FROM PUBLIC、末尾 COMMIT;、表/类型全 `public.` 限定', () => {
  assert.equal(
    /\bGRANT\b/i.test(body),
    false,
    '迁移内必须零 GRANT：`gengyun_api_runtime` 在迁移之后才创建，'
      + 'EXECUTE 授权只能放 `deploy/postgres-cvm/sql/20-login-roles.sql`',
  );
  assert.ok(
    body.includes('REVOKE ALL ON FUNCTION public.deidentify_account(uuid) FROM PUBLIC;'),
    '必须 `REVOKE ALL ON FUNCTION public.deidentify_account(uuid) FROM PUBLIC;`（硬条件 2 前半）',
  );
  assert.ok(/COMMIT;\s*$/.test(body.trimEnd() + '\n'), '迁移文件必须以 `COMMIT;` 收尾');
  assert.ok(body.trimStart().startsWith('BEGIN;') || body.includes('\nBEGIN;'), '迁移必须自带 `BEGIN;`（单文件事务）');

  // `search_path=pg_catalog` ⇒ 表名/类型名漏掉 `public.` 就是 42P01；这里把所有 DML/类型引用逐个咬一遍。
  assert.equal(
    /\bFROM\s+users\b|\bUPDATE\s+users\b|\bFROM\s+exports\b|\bUPDATE\s+exports\b/i.test(body),
    false,
    '表名必须写 `public.users` / `public.exports`，不许裸写（search_path 里没有 public）',
  );
  assert.ok(body.includes('x_state public.user_state;'), '自定义类型必须写 `public.user_state`（裸写 user_state 会 42P01）');
});

test('回滚件同号：`rollback/0057_….down.sql` 存在且只 DROP 函数（不恢复已擦除的事实）', () => {
  const downPath = join(MIGRATIONS_DIR, 'rollback', '0057_deidentify_account_on_deletion.down.sql');
  const down = readFileSync(downPath, 'utf8');
  assert.ok(
    down.includes('DROP FUNCTION IF EXISTS public.deidentify_account(uuid);'),
    '回滚件必须 `DROP FUNCTION IF EXISTS public.deidentify_account(uuid)`',
  );
  assert.equal(/\bUPDATE\b/i.test(down.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n')), false,
    '回滚件不得写数据：已擦除的 PII **不恢复**（回滚只撤函数，不撤事实）');
  assert.ok(/COMMIT;\s*$/.test(down.trimEnd() + '\n'), '回滚件同样以 `COMMIT;` 收尾');
});

test('本片不改既有迁移：0016 / 0021 的 checksum 不得因本片漂移', () => {
  // 本片只新增 0057，绝不修改已合入并登记过 checksum 的迁移文件；这里做一次「台账外自证」：
  // 目录里 0057 之外的文件名不含本片新增内容，且 0016 仍只有一份函数定义（未被本片重写）。
  const files = readdirSync(MIGRATIONS_DIR).filter((name) => /^\d{4}_.*\.sql$/.test(name));
  assert.equal(files.includes('0016_account_deletion_persistence.sql'), true, '0016 必须原样在册');
  assert.equal(
    files.filter((name) => name.startsWith('0021_')).length,
    1,
    '0021 必须原样在册（本片不动它：已合入并登记过 checksum 的迁移一改就漂）',
  );
  const filesWithDeidentify = files.filter((name) => name.includes('deidentify'));
  assert.deepEqual(
    filesWithDeidentify,
    [MIGRATION_NAME],
    '去身份只许有 0057 这一份迁移（拆成两片会让「受理事务内一次擦完」变成两次独立提交）',
  );
});
