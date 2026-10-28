/**
 * R68 · 后台「停用 / 恢复管理员账号」的**五条互指钉子**（迁移 `0048` + 应用层接线）。
 *
 * ## 为什么是「互指」而不是五组独立断言
 * 这条路径的失效方式不是「某一处写错」，而是**只落了一半**：
 *   · 迁移写了但部署侧没授权 ⇒ 真库上恒 `42501`，测试库里却全绿（部署链才是生产形状）；
 *   · 部署侧授了但 `accounts-only.ts` 放行表漏第 8 条 ⇒ 真实装配（`GY_ADMIN_OPS_MODE=real`）
 *     把每条请求都判 503，而假服务层的单测照样绿（界面照旧显示按钮）；
 *   · 服务层接了但路由没挂 `requireScope` ⇒ 任何登录着的管理员都能停用别人（**权限门失效**）；
 *   · 路由挂了但 `service.ts` 的 `requireWired*` 缺失 ⇒ 未接线时抛 500 而不是 503，值班读不懂。
 * 每一条都能**单独**让本片失效，而其中三条在「只跑单测」的视角下完全看不见。所以下面的用例
 * 刻意跨文件互补：谁把某一半摘掉，就红在那一半的**正确判据**上。
 *
 * ## 对应派单
 *   (a) `deploy/postgres-cvm/sql/20-login-roles.sql` 真的授了 EXECUTE（且是**硬前置 + 先 REVOKE**）；
 *   (b) `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的函数面清单真的登记了这两条函数；
 *   (c) `services/api/src/routes/admin.ts` 有两条路由，且都挂 `requireScope(OPS_SCOPES.…)`；
 *   (d) `services/api/src/admin/ops/service.ts` 有 `requireWiredAdminAccountAuthority`（503 契约）；
 *   (e) `services/api/src/admin/ops/accounts-only.ts` 有放行表第 8 条（`adminAccountWriteWired ? …`）。
 *
 * 后面再补三组**库层/闭集**的钉子（迁移正文的形状、审计闭集 10 值、契约 enum 双向相等），
 * 因为它们与上面五条是同一件事的三层：没有它们，(a)~(e) 全绿也可以是一个「停用了但没生效」的实现。
 *
 * ⛔ 本文件不写任何 `文件:行号` 断语（行号会漂；`tests/unit/test-line-anchors-guard.test.mjs`
 * 专门判红那种写法）。要引用证据一律用**语句文本 / 函数名**。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DISABLE_ADMIN_ACCOUNT_FUNCTION,
  ENABLE_ADMIN_ACCOUNT_FUNCTION,
  mapAdminAccountAuthorityError,
} from '../../services/api/src/admin/ops/admin-account-authority-pg.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const MIGRATION = 'services/api/db/migrations/0048_admin_account_disable.sql';
const DOWN = 'services/api/db/migrations/rollback/0048_admin_account_disable.down.sql';
const LOGIN_ROLES = 'deploy/postgres-cvm/sql/20-login-roles.sql';
const LEAST_PRIVILEGE = 'deploy/postgres-cvm/sql/90-assert-least-privilege.sql';
const ROUTES = 'services/api/src/routes/admin.ts';
const SERVICE = 'services/api/src/admin/ops/service.ts';
const ACCOUNTS_ONLY = 'services/api/src/admin/ops/accounts-only.ts';
const AUTHORITY = 'services/api/src/admin/ops/admin-account-authority-pg.ts';
const CATALOG = 'services/api/src/admin/audit/catalog.ts';
const OPENAPI = 'packages/contracts/openapi.json';
/** `0041` 的 grant/revoke —— 本片必须与它**同一把** advisory 锁（同一串、同一个 key）。 */
const MIGRATION_0041 = 'services/api/db/migrations/0041_admin_scope_write_authority.sql';

const read = (relative) => readFileSync(join(REPO_ROOT, relative), 'utf8');

/** `public.f(...)` 里参数表的两种写法：`REVOKE/GRANT` 用带空格版，`to_regprocedure`/清单用紧凑版。 */
const SIGNATURE = '(uuid, uuid, uuid, integer, uuid, text)';
const SIGNATURE_TIGHT = '(uuid,uuid,uuid,integer,uuid,text)';
/**
 * `0041` 取锁用的是**参数化**写法（`'admin_scope:' || p_scope`），`0048` 是同一个 scope 的
 * **字面量**写法。两者必须落在同一把锁上 —— 判据是「拼出来是同一串」，不是「文本相同」。
 */
const LOCK_IN_0041 = "pg_advisory_xact_lock(hashtextextended('admin_scope:' || p_scope, 18040))";
const LOCK_PREFIX = 'admin_scope:';
const LOCK_SCOPE = 'scopes:write';
const LOCK_IN_0048 = `pg_advisory_xact_lock(hashtextextended('${LOCK_PREFIX}${LOCK_SCOPE}', 18040))`;
/** 0048 里真正**取锁**的语句（带 `PERFORM`）；文件头注释里引用同一串不算。 */
const LOCK_STATEMENT_IN_0048 = `PERFORM ${LOCK_IN_0048};`;

/** 出现次数（判「两条函数都有」而非「文件里提了一次」）。 */
function countOf(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/**
 * 去掉整行注释后的正文。
 *
 * 迁移的头注里会把关键语句**引用**一遍（例如「⑪ 撤会话：`UPDATE public.admin_sessions SET revoked_at =
 * now()`」），直接数原文会把「注释里提到」当成「代码里有」。判「语句出现几次」必须数正文。
 */
function codeOf(sql) {
  return sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
}

// ---------------------------------------------------------------------------
// (a) 部署：`20-login-roles.sql` 授了 EXECUTE
// ---------------------------------------------------------------------------
test('钉子(a)：20-login-roles.sql 对两条函数「硬前置 + REVOKE ALL + GRANT EXECUTE 给运行时」', () => {
  const sql = read(LOGIN_ROLES);
  for (const name of ['disable_admin_account', 'enable_admin_account']) {
    const fq = `public.${name}${SIGNATURE}`;
    const fqTight = `public.${name}${SIGNATURE_TIGHT}`;
    // ① `to_regprocedure` 硬前置：函数缺失即显式失败，不留「部署看起来成功、运行时 42501」。
    const guardAt = sql.indexOf(`to_regprocedure('${fqTight}') IS NULL`);
    assert.notEqual(
      guardAt,
      -1,
      `20-login-roles.sql 缺 \`to_regprocedure('${fqTight}') IS NULL\` 硬前置：迁移没跑时部署会「成功」但运行时每次都 42501`,
    );
    // ② 先 REVOKE PUBLIC，再 GRANT 给运行时 —— 顺序写死在文件里，这里连顺序一起钉。
    const revokeAt = sql.indexOf(`REVOKE ALL ON FUNCTION ${fq} FROM PUBLIC`);
    const grantAt = sql.indexOf(`GRANT EXECUTE ON FUNCTION ${fq} TO gengyun_api_runtime`);
    assert.notEqual(revokeAt, -1, `20-login-roles.sql 缺 \`REVOKE ALL ON FUNCTION ${fq} FROM PUBLIC\``);
    assert.notEqual(grantAt, -1, `20-login-roles.sql 缺 \`GRANT EXECUTE ON FUNCTION ${fq} TO gengyun_api_runtime\``);
    assert.ok(
      guardAt < revokeAt && revokeAt < grantAt,
      `20-login-roles.sql 里 ${name} 的「硬前置 ⇒ REVOKE ⇒ GRANT」顺序被打乱（部署脚本是顺序执行的，`
        + '先 GRANT 后 REVOKE 等于最后什么都没授）',
    );
  }
});

// ---------------------------------------------------------------------------
// (b) 部署：最小权限清单登记了两行
// ---------------------------------------------------------------------------
test('钉子(b)：90-assert 的函数面清单登记了两条函数（漏了断言 90 必红）', () => {
  const sql = read(LEAST_PRIVILEGE);
  for (const name of ['disable_admin_account', 'enable_admin_account']) {
    assert.ok(
      sql.includes(`'${name}',`),
      `90-assert 的 function_surface_manifest 里没有 '${name}' 那一行：清单是「库里每个函数都必须登记」`
        + '的闭集，漏一行断言 90 就会红（部署链在 CI 上是阻断的）',
    );
  }
  // 两条函数各自的「存在 + SECURITY DEFINER + PUBLIC 无 EXECUTE + grantee 精确相等」断言。
  for (const name of ['disable_admin_account', 'enable_admin_account']) {
    const fqTight = `public.${name}${SIGNATURE_TIGHT}`;
    assert.ok(
      countOf(sql, `'${fqTight}'`) >= 2,
      `90-assert 里 \`'${fqTight}'\` 出现少于 2 次：一条函数应既有清单行、又有「存在/SECURITY DEFINER/grantee」断言`,
    );
  }
});

// ---------------------------------------------------------------------------
// (c) 路由：两条 + 权限门
// ---------------------------------------------------------------------------
test('钉子(c)：routes/admin.ts 有两条路由且都挂 requireScope(OPS_SCOPES.…)', () => {
  const source = read(ROUTES);
  for (const [path, operationId] of [
    ['/admin/administrators/:id/disable', 'disableAdministratorAccount'],
    ['/admin/administrators/:id/enable', 'enableAdministratorAccount'],
  ]) {
    const routeAt = source.indexOf(`\${API_PREFIX}${path}\``);
    assert.notEqual(routeAt, -1, `routes/admin.ts 缺路由 \`\${API_PREFIX}${path}\``);
    // 权限门必须落在**同一条路由注册**的 preHandler 里（48 行窗口足够覆盖到 preHandler + 处理体）。
    const window = source.slice(routeAt, routeAt + 1200);
    assert.ok(
      window.includes(`requireScope(OPS_SCOPES.${operationId})`),
      `路由 ${path} 的 preHandler 里没有 \`guards.requireScope(OPS_SCOPES.${operationId})\`：`
        + '没有权限门 ⇒ 任何登录着的管理员都能停用别人（这条路径最危险的失效方式）',
    );
    assert.ok(
      window.includes(`guards.requireAdmin`),
      `路由 ${path} 少了 \`guards.requireAdmin\`：requireScope 只判 scope，不判会话是不是后台会话`,
    );
    assert.ok(
      source.includes(`'${operationId}'`),
      `ADMIN_HTTP_OPERATION_IDS 里没有 '${operationId}'：契约/路由一致性门禁会红`,
    );
  }
});

// ---------------------------------------------------------------------------
// (d) 服务层：未接线 ⇒ 503（不是 500、不是假成功）
// ---------------------------------------------------------------------------
test('钉子(d)：ops/service.ts 的 requireWiredAdminAccountAuthority 是 503 PROVIDER_UNAVAILABLE', () => {
  const source = read(SERVICE);
  const fnAt = source.indexOf('function requireWiredAdminAccountAuthority(');
  assert.notEqual(fnAt, -1, 'ops/service.ts 缺 `requireWiredAdminAccountAuthority()`：未接线时应 503 而不是崩');
  const body = source.slice(fnAt, fnAt + 900);
  assert.ok(
    body.includes("'PROVIDER_UNAVAILABLE'"),
    '`requireWiredAdminAccountAuthority` 没有抛 PROVIDER_UNAVAILABLE：未接线会让客户端看到 500',
  );
  assert.ok(
    body.includes('retryable: false'),
    '`requireWiredAdminAccountAuthority` 的 503 必须是 `retryable: false`（重试改变不了「没接线」）',
  );
  // 两个 operation 的门都必须沿用既有 `scopes:write`，⛔ 不许新造 scope 值。
  for (const key of ['disableAdministratorAccount', 'enableAdministratorAccount']) {
    assert.ok(
      new RegExp(`^  ${key}: 'scopes:write',$`, 'mu').test(source),
      `OPS_SCOPES.${key} 不是 'scopes:write'：本片明令沿用既有权限门，⛔ 不新增 scope 值`,
    );
  }
});

// ---------------------------------------------------------------------------
// (e) 放行表第 8 条
// ---------------------------------------------------------------------------
test('钉子(e)：accounts-only.ts 放行表第 8 条（漏了 ⇒ real 模式全 503 而界面照旧显示按钮）', () => {
  const source = read(ACCOUNTS_ONLY);
  assert.ok(
    source.includes('readonly adminAccountWriteWired?: boolean;'),
    'accounts-only.ts 缺 `adminAccountWriteWired?: boolean` 开关：放行表要靠它决定放不放',
  );
  for (const key of ['disableAdministratorAccount', 'enableAdministratorAccount']) {
    assert.ok(
      source.includes(`${key}: adminAccountWriteWired ? inner.${key} : reject,`),
      `accounts-only.ts 的返回对象里没有 \`${key}: adminAccountWriteWired ? inner.${key} : reject,\`：`
        + '`GY_ADMIN_OPS_MODE=real` 下真实权威会被「只允许账号面」的壳整段挡掉，每条请求 503',
    );
  }
});

// ---------------------------------------------------------------------------
// 库层：迁移正文的形状（停用必须真的生效）
// ---------------------------------------------------------------------------
test('迁移 0048：两条 SECURITY DEFINER 函数、同一把 advisory 锁、CAS、撤会话、审计 NULL', () => {
  const sql = read(MIGRATION);
  const code = codeOf(sql);
  const shared = read(MIGRATION_0041);

  // ① `0041` 取锁用的是 `'admin_scope:' || p_scope`；`0048` 写的是同一个 scope 的字面量。
  //    判据是「拼出来同一串」—— 只比文本会漏掉「锁串看起来一样但实际不同名」的漂移。
  assert.equal(
    countOf(shared, LOCK_IN_0041),
    2,
    '0041 里找不到那两句 `pg_advisory_xact_lock(hashtextextended(\'admin_scope:\' || p_scope, 18040))`：'
      + '本钉子的对照物变了，请先确认 0041 的锁还能不能指',
  );
  assert.equal(
    `${LOCK_PREFIX}${LOCK_SCOPE}`,
    'admin_scope:scopes:write',
    '本片取的锁名必须正好是 0041 里 `\'admin_scope:\' || \'scopes:write\'` 拼出来的那一串',
  );
  assert.equal(
    countOf(code, LOCK_STATEMENT_IN_0048),
    2,
    `0048 里 \`${LOCK_STATEMENT_IN_0048}\` 应恰出现 2 次（disable / enable 各取一次锁）：`
      + '锁串与 0041 拼出来的不一致或漏了一条函数，都会让「停用最后一个管理者」与「撤掉最后一个管理者」交错通过',
  );

  for (const name of ['disable_admin_account', 'enable_admin_account']) {
    const head = `CREATE OR REPLACE FUNCTION public.${name}(`;
    assert.ok(sql.includes(head), `0048 缺 \`${head}…\``);
    const window = sql.slice(sql.indexOf(head), sql.indexOf(head) + 1200);
    for (const must of ["SECURITY DEFINER", "SET search_path = pg_catalog", "SET TimeZone = 'UTC'"]) {
      assert.ok(window.includes(must), `public.${name} 的函数头缺 \`${must}\``);
    }
    // CAS：拿 `revision` 与 `p_expected_revision` 比，不等即 G0003。
    assert.ok(window.includes('p_expected_revision'), `public.${name} 没有 CAS（缺 p_expected_revision 比较）`);
  }
  // ② 锁序：advisory 在前、行锁在后（`FOR UPDATE` 必须晚于 advisory 调用）。
  const lockAt = sql.indexOf(LOCK_IN_0048);
  assert.ok(
    lockAt < sql.indexOf('FOR UPDATE'),
    '0048 的 `FOR UPDATE` 出现在 advisory 锁之前：锁序必须照 0041（advisory ⇒ admin_accounts 行，绝不反向）',
  );
  // ③ 停用真的写 `state='suspended'`（负控制③ 正是打这一行）。
  assert.ok(
    /SET state = 'suspended'/.test(code),
    "0048 里没有 `SET state = 'suspended'`：停用没生效却仍然 200 —— 这正是负控制③ 要抓的假绿",
  );
  // ④ 两个 action 的审计必须写 NULL 的 before/after（写成别的形状会让读面 503，而 append-only 删不掉）。
  assert.equal(
    countOf(code, "'accepted', NULL, NULL"),
    2,
    "0048 的审计 INSERT 应恰有两处 `'accepted', NULL, NULL`（before_value/after_value 必须 NULL）",
  );
  // ⑤ 两个守卫码。
  assert.ok(code.includes('G0009'), '0048 缺 G0009（停用唯一 scopes:write 持有者，与 0041 同一个码）');
  assert.ok(code.includes('G0020'), '0048 缺 G0020（自停用）');
  // ⑥ 会话撤销：disable 撤、enable 再撤一遍（第二道保险）⇒ 正文里两条 UPDATE + 两处赋值。
  assert.equal(
    countOf(code, 'UPDATE public.admin_sessions'),
    2,
    '0048 正文应有两处 `UPDATE public.admin_sessions`（停用撤会话；恢复再撤一遍作第二道保险）',
  );
  assert.equal(
    countOf(code, 'SET revoked_at = now()'),
    2,
    '0048 正文应恰有两处 `SET revoked_at = now()`',
  );
  // ⑦ 权限收口。REVOKE 语句在注释之外，用正文数。
  for (const name of ['disable_admin_account', 'enable_admin_account']) {
    assert.ok(
      code.includes(`REVOKE ALL ON FUNCTION public.${name}${SIGNATURE}`),
      `0048 缺 \`REVOKE ALL ON FUNCTION public.${name}… FROM PUBLIC\``,
    );
  }
});

test('回滚件 0048：只 DROP FUNCTION，⛔ 不删审计行', () => {
  const sql = read(DOWN);
  for (const name of ['disable_admin_account', 'enable_admin_account']) {
    assert.ok(sql.includes(`DROP FUNCTION IF EXISTS public.${name}${SIGNATURE}`), `回滚件缺 DROP ${name}`);
  }
  assert.ok(
    !/DELETE\s+FROM\s+public\.admin_audit_events/i.test(sql),
    '回滚件里出现了 DELETE FROM admin_audit_events：审计台账 append-only，删函数不删行',
  );
  assert.ok(
    !/DELETE\s+FROM\s+public\.admin_accounts/i.test(sql),
    '回滚件里出现了 DELETE FROM admin_accounts：本片明令不做删除',
  );
});

// ---------------------------------------------------------------------------
// 闭集：catalog 10 值 + `admin_account` 实体 + 动作护栏
// ---------------------------------------------------------------------------
test('审计闭集：AUDIT_ACTIONS 十一值、admin_account 实体自带动作护栏', () => {
  const catalog = read(CATALOG);
  const list = catalog.match(/export const AUDIT_ACTIONS = Object\.freeze\(\[([\s\S]*?)\] as const\);/);
  assert.ok(list !== null, 'AUDIT_ACTIONS 的声明形状变了（本钉子靠解析数组字面量取顺序）');
  const order = [...list[1].matchAll(/[A-Z][A-Z0-9_]+/g)].map((m) => m[0]);
  assert.deepEqual(order, [
    'AUDIT_ACTION_ACCOUNT_SUSPEND',
    'AUDIT_ACTION_ACCOUNT_RESTORE',
    'AUDIT_ACTION_SET_FLAG',
    'AUDIT_ACTION_JOB_CANCEL',
    'AUDIT_ACTION_ADMIN_SCOPE_GRANT',
    'AUDIT_ACTION_ADMIN_SCOPE_REVOKE',
    'AUDIT_ACTION_ADMIN_SCOPE_DENY',
    'AUDIT_ACTION_POST_HIDE',
    'AUDIT_ACTION_ADMIN_ACCOUNT_DISABLE',
    'AUDIT_ACTION_ADMIN_ACCOUNT_ENABLE',
    'AUDIT_ACTION_CATEGORY_UPDATE',
  ]);
  // 实体名是 `admin_account`（⛔ 不是 `account`：那一个指 0017 的普通用户停用）。
  assert.ok(
    /admin_account: 'scopes:write',/.test(catalog),
    'AUDIT_ENTITY_SCOPES 缺 `admin_account: \'scopes:write\'`',
  );
  assert.ok(
    // `as const` 是必需的（`Readonly<Record<AdminAuditAction, …>>` 要字面量元组，否则 tsc 报 TS2322），
    // 所以这里允许它出现或不出现在 `Object.freeze(...)` 里。
    /admin_account: Object\.freeze\(\[AUDIT_ACTION_ADMIN_ACCOUNT_DISABLE, AUDIT_ACTION_ADMIN_ACCOUNT_ENABLE\](?: as const)?\),/.test(
      catalog,
    ),
    'AUDIT_ENTITY_ACTION_GUARDS 缺 admin_account 的两值护栏：没有它 `?entity=admin_account` 会把'
      + 'scope 授予/撤销/被拒行（scope 列同为 `scopes:write` 命名空间）一起混进来',
  );
});

test('契约：`?action=` / `?entity=` enum 与运行时逐字同序，且两个新 operation 在册', () => {
  const openapi = JSON.parse(read(OPENAPI));
  const params = openapi.paths['/admin/audit-logs'].get.parameters;
  const actionEnum = params.find((p) => p.name === 'action').schema.enum;
  const entityEnum = params.find((p) => p.name === 'entity').schema.enum;
  // R68-A01 起 `category.update` 是第 11 值（迁移 0049 的落库写入点），故 0048 的两个值不再是末两项。
  assert.deepEqual(actionEnum.slice(-3, -1), ['admin_account.disable', 'admin_account.enable']);
  assert.equal(actionEnum[actionEnum.length - 1], 'category.update', '`category.update` 必须是末位（扩值只能追加）');
  assert.equal(actionEnum.length, 11, '契约 action 枚举必须与 AUDIT_ACTIONS 同长（十一项）');
  assert.ok(entityEnum.includes('admin_account'), '`?entity=` 的 enum 缺 `admin_account`');

  for (const path of ['/admin/administrators/{id}/disable', '/admin/administrators/{id}/enable']) {
    const operation = openapi.paths[path]?.post;
    assert.ok(operation, `openapi 缺 path \`${path}\` 的 post`);
    assert.equal(operation['x-scope'], 'scopes:write', `${path} 的 x-scope 必须是既有的 scopes:write`);
    assert.equal(operation['x-version-required'], true, `${path} 必须声明 x-version-required`);
    const refs = operation.parameters.map((p) => p.$ref ?? '').join(' ');
    assert.ok(refs.includes('#/components/parameters/IdempotencyKey'), `${path} 缺 Idempotency-Key`);
    assert.ok(refs.includes('#/components/parameters/IfMatch'), `${path} 缺 If-Match`);
  }
});

// ---------------------------------------------------------------------------
// 应用层错误映射：G 码 → 契约码（业务规则不被降级成「不可用」）
// ---------------------------------------------------------------------------
test('错误映射：G0009 → LAST_SCOPE_MANAGER(409)、G0020 → SELF_DISABLE_DENIED(409)、未知 → 503', () => {
  const codeOf = (thunk) => {
    try {
      thunk();
    } catch (error) {
      return error;
    }
    assert.fail('mapAdminAccountAuthorityError 没有抛错');
  };
  const last = codeOf(() => mapAdminAccountAuthorityError({ code: 'G0009' }));
  assert.equal(last.code, 'LAST_SCOPE_MANAGER', 'G0009 必须映射成与 0041 同一个契约码 LAST_SCOPE_MANAGER');
  assert.equal(last.retryable, false);
  const self = codeOf(() => mapAdminAccountAuthorityError({ code: 'G0020' }));
  assert.equal(self.code, 'SELF_DISABLE_DENIED', 'G0020 必须映射成 SELF_DISABLE_DENIED（⛔ 不是 SCOPE_DENIED）');
  assert.equal(self.retryable, false);
  const conflict = codeOf(() => mapAdminAccountAuthorityError({ code: 'G0003' }));
  assert.equal(conflict.code, 'REVISION_CONFLICT');
  const timeout = codeOf(() => mapAdminAccountAuthorityError({ code: '57014' }));
  assert.equal(timeout.code, 'PROVIDER_TIMEOUT');
  assert.equal(timeout.retryable, true);
  const unknown = codeOf(() => mapAdminAccountAuthorityError({ code: '42501' }));
  assert.equal(unknown.code, 'PROVIDER_UNAVAILABLE', '权限/缺函数必须如实「不可用」，⛔ 不降级成 403');
  // 常量与迁移里的函数名一致（应用层拼错名字在真库上只会得到 42883 ⇒ 503，很难定位）。
  assert.equal(DISABLE_ADMIN_ACCOUNT_FUNCTION, 'public.disable_admin_account');
  assert.equal(ENABLE_ADMIN_ACCOUNT_FUNCTION, 'public.enable_admin_account');
  assert.ok(
    read(AUTHORITY).includes('SELECT public.disable_admin_account(') &&
      read(AUTHORITY).includes('SELECT public.enable_admin_account('),
    '应用层调用的函数名与迁移不一致：拼错只会在真库上得到 42883 ⇒ 503，很难定位',
  );
});
