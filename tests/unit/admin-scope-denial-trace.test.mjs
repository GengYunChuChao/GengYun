/**
 * 迁移 0046「拒绝留痕」的**静态**守卫（纯文本：不连库、不跑迁移、不 import `services/**`）。
 *
 * 为什么需要这个文件（不是"多一层保险"，而是三件**只能静态判**的事）：
 *   ① **闭集两处同源**：`0046` 函数里的 13 项后台权限闭集 与 `0041` 的
 *      `admin_scopes_scope_closed_set` CHECK 必须逐字一致。真库臂只能证明"闭集外的值被拒"，
 *      证明不了"两份清单是否同源" —— 少写一项（例如漏 `sources:write`）两处都能各自自洽，
 *      结果是"库允许写、留痕函数却把它判成非法"（拒绝面比写入面窄，专挑最该留痕的那些拒）。
 *   ② **写死的列真的写死了**：`action` / `result` / `target_ref` 是字面量，不是入参拼的。
 *   ③ **不重核验**：函数体里不得出现 `public.admin_scopes`（不查持有）与 `state`（不查 active）。
 *      这一条是裁定 B 的核心，但它**只会**因为"多写了一句 SELECT"而失效 —— 真库臂跑的是
 *      "被拒的场景"，重核验加上去之后那些行会直接报错、真库臂**变红**，可是"红在哪"要靠人读
 *      函数体；本文件把"多写的那一句"直接点名。
 *
 * 复核方式（可复现）：`node --test tests/unit/admin-scope-denial-trace.test.mjs`
 * 本文件**不写任何 `文件:行号`**（行号由运行时算出，避免 `tests/unit/test-line-anchors-guard.test.mjs` 判红）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MIGRATION = 'services/api/db/migrations/0046_admin_scope_denial_trace.sql';
const ROLLBACK = 'services/api/db/migrations/rollback/0046_admin_scope_denial_trace.down.sql';
const WRITE_AUTHORITY = 'services/api/db/migrations/0041_admin_scope_write_authority.sql';
const ASSERT_SQL = 'deploy/postgres-cvm/sql/90-assert-least-privilege.sql';
const ROLES_SQL = 'deploy/postgres-cvm/sql/20-login-roles.sql';
const DENIAL_GRANT_REGION = 'gy-r64-pr4a-denial-trace-grant';
/** 函数签名（RETURNS uuid 之前那一段）；DROP / REVOKE / GRANT / 清单四处都必须逐字用它。 */
const SIGNATURE = 'uuid, uuid, text, text, uuid, uuid';
const SIGNATURE_TIGHT = 'uuid,uuid,text,text,uuid,uuid';

/** 后台权限闭集（13 项）：`0041` 与 `0046` 必须都恰好是这一份。 */
const CLOSED_SCOPES = [
  'accounts:read',
  'accounts:suspend',
  'audit:read',
  'flags:read',
  'flags:write',
  'jobs:cancel',
  'jobs:read',
  'scopes:read',
  'scopes:write',
  'session:logout',
  'session:read',
  'sources:read',
  'sources:write',
];
/** 拒绝理由闭集（四值）：与 `0041` 的 G0008/G0009/G0010/G0011 一一对应。 */
const CLOSED_REASONS = ['self_scope_grant_denied', 'last_scope_manager', 'scope_denied', 'scope_not_held'];

const read = (relativePath) => readFileSync(join(REPO_ROOT, relativePath), 'utf8');

/** 取 `ARRAY[ … ]::text[]` 里的字符串字面量（按出现顺序）。 */
function arrayLiterals(sql, variableName) {
  const block = new RegExp(`${variableName}\\s+text\\[\\]\\s*:=\\s*ARRAY\\[([\\s\\S]*?)\\]::text\\[\\]`).exec(sql);
  assert.notEqual(block, null, `找不到 ${variableName} 的 ARRAY[…]::text[] 声明 —— 声明形状变了，本文件的解析器要跟着改`);
  return [...block[1].matchAll(/'([^']*)'/g)].map((hit) => hit[1]);
}

/** 取 `0041` 的 CHECK 闭集（`scope IN ( … )`）。 */
function checkClosedSet(sql) {
  const block = /admin_scopes_scope_closed_set CHECK \(\s*scope IN \(([\s\S]*?)\n\s*\)\s*\n\s*\);/.exec(sql);
  assert.notEqual(block, null, '找不到 0041 的 admin_scopes_scope_closed_set CHECK —— 约束被改名/改写，本文件要跟着改');
  return [...block[1].matchAll(/'([^']*)'/g)].map((hit) => hit[1]);
}

/** 函数体（第一个 `AS $$ … $$;`），**去掉 SQL 行注释**后再交给静态判据。 */
function functionBodyCode(sql) {
  const body = /AS \$\$([\s\S]*?)\$\$;/.exec(sql);
  assert.notEqual(body, null, '找不到函数体 AS $$ … $$;');
  return body[1].replace(/--[^\n]*/g, '');
}

/** 两份闭集清单的差异（与测试共用同一份实现，负控制直接喂合成清单）。 */
function setProblems(actual, expected) {
  const problems = [];
  const missing = expected.filter((value) => !actual.includes(value));
  const extra = actual.filter((value) => !expected.includes(value));
  if (missing.length > 0) problems.push(`缺 ${missing.join(',')}`);
  if (extra.length > 0) problems.push(`多 ${extra.join(',')}`);
  if (new Set(actual).size !== actual.length) problems.push('有重复项');
  if (actual.length !== expected.length) problems.push(`条数 ${actual.length} ≠ ${expected.length}`);
  return problems;
}

test('闭集同源：0046 的 13 项 scope 与 0041 的 CHECK 逐字一致', () => {
  const fromDenial = arrayLiterals(read(MIGRATION), 'x_scope_allowed');
  const fromCheck = checkClosedSet(read(WRITE_AUTHORITY));
  assert.deepEqual(
    fromCheck,
    CLOSED_SCOPES,
    `0041 的 admin_scopes_scope_closed_set 与本文件登记值不一致（现场 ${JSON.stringify(fromCheck)}）——`
      + '若这是有意扩/缩闭集，先改本文件的 CLOSED_SCOPES，再同步 0046',
  );
  assert.deepEqual(
    setProblems(fromDenial, CLOSED_SCOPES),
    [],
    `0046 的 x_scope_allowed 与后台权限闭集不一致（现场 ${JSON.stringify(fromDenial)}）：`
      + '拒绝面与写入面不同源时，「库里能写、留痕却说非法」的缝就会出现',
  );
});

test('拒绝理由闭集：0046 恰好四值，且与 0041 的四个 G 码一一对应', () => {
  const fromDenial = arrayLiterals(read(MIGRATION), 'x_reason_allowed');
  assert.deepEqual(
    setProblems(fromDenial, CLOSED_REASONS),
    [],
    `0046 的 x_reason_allowed 必须恰好是四值闭集（现场 ${JSON.stringify(fromDenial)}）`,
  );
  const authority = read(WRITE_AUTHORITY);
  for (const [code, reason] of [
    ['G0008', 'self_scope_grant_denied'],
    ['G0009', 'last_scope_manager'],
    ['G0010', 'scope_denied'],
    ['G0011', 'scope_not_held'],
  ]) {
    assert.ok(
      authority.includes(code),
      `0041 里必须仍能查到 ${code}（拒绝理由码 ${reason} 的依据）—— G 码被改号时本文件的映射要跟着改`,
    );
  }
});

test('写死的列：action/result/target_ref 是字面量，target_hint 由形参重建', () => {
  const sql = read(MIGRATION);
  const body = functionBodyCode(sql);
  assert.match(body, /'admin_scope\.deny'/, 'action 必须是字面量 admin_scope.deny（不能由入参拼）');
  assert.match(body, /'denied'/, "result 必须是字面量 'denied'（不能由入参拼）");
  assert.match(
    body,
    /'admin_account:'\s*\|\|\s*p_target_id::text/,
    'target_hint 必须由 p_target_id 重建为 admin_account:<target>（不接受入参直接塞）',
  );
  // `target_ref` 必须是字面量 NULL：契约 TargetRef 闭集里没有 account（同 0017/0041/0043）。
  const insertBlock = /INSERT INTO public\.admin_audit_events[\s\S]*?VALUES \(([\s\S]*?)\);/.exec(body);
  assert.notEqual(insertBlock, null, '找不到向 public.admin_audit_events 的 INSERT … VALUES (…)');
  const values = insertBlock[1];
  assert.match(values, /\bNULL\b/, 'target_ref 必须是字面量 NULL（account 不在契约 TargetRef 闭集里）');
  // 入参自检必须把 reason_code / scope 都拿闭集挡（`= ANY (x_…_allowed)`）。
  assert.match(body, /NOT \(p_scope = ANY \(x_scope_allowed\)\)/, 'p_scope 必须用闭集判定挡下');
  assert.match(body, /NOT \(p_reason_code = ANY \(x_reason_allowed\)\)/, 'p_reason_code 必须用闭集判定挡下');
  // 非法入参必须是 G0001；actor 不存在必须是 G0002（仓内既有约定，0041/0043 同形）。
  assert.match(body, /ERRCODE = 'G0001', MESSAGE = 'INVALID_REQUEST'/, '非法入参必须以 G0001 INVALID_REQUEST 抛出');
  assert.match(body, /ERRCODE = 'G0002', MESSAGE = 'NOT_FOUND'/, 'actor 不存在必须以 G0002 NOT_FOUND 抛出');
});

test('不重核验：函数体里不许出现 admin_scopes（查持有）或 state（查 active）', () => {
  const body = functionBodyCode(read(MIGRATION));
  assert.equal(
    /\badmin_scopes\b/.test(body),
    false,
    '函数体不得读 public.admin_scopes —— 被拒的正是「不持 scopes:write / 会归零」，重核验会把要记的行全拒掉（裁定 B）',
  );
  assert.equal(
    /\bstate\b/.test(body),
    false,
    "函数体不得判 state（admin 是否 'active'）—— 停用的管理员被拒也要留痕（裁定 B：只核 actor 存在）",
  );
  // 正控制：函数体**真的**读了 admin_accounts（否则上面两条会因为"函数体是空的"而恒真）。
  assert.match(
    body,
    /FROM public\.admin_accounts WHERE id = p_actor_id/,
    '函数体必须只核 actor 存在（SELECT 1 … FROM public.admin_accounts WHERE id = p_actor_id）',
  );
});

test('函数头：SECURITY DEFINER + 固定 search_path/TimeZone + REVOKE ALL FROM PUBLIC', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /SECURITY DEFINER/, '必须是 SECURITY DEFINER（属主写审计行，运行时零表级权限）');
  assert.match(sql, /SET search_path = pg_catalog/, '必须固定 search_path = pg_catalog');
  assert.match(sql, /SET TimeZone = 'UTC'/, "必须固定 TimeZone = 'UTC'（审计时刻 UTC 同形）");
  assert.ok(
    sql.includes(`REVOKE ALL ON FUNCTION public.record_admin_scope_denial(${SIGNATURE})`),
    '必须以完整签名 REVOKE ALL … FROM PUBLIC（PG 新建函数默认授 PUBLIC EXECUTE）',
  );
  // 「应用层申报 ≠ 库层证明」必须写在函数体旁，而不是只写在 PR 里。
  assert.ok(
    sql.includes('应用层申报') && sql.includes('库层证明'),
    '函数头/COMMENT 必须如实写明「这是应用层申报，不是库层证明」（第二事务里 advisory 锁已释放，库无从复算）',
  );
  assert.ok(
    sql.includes('advisory') && sql.includes('释放'),
    '必须写明 advisory 锁已随主事务释放这一事实（这是"库无从复算"的唯一依据）',
  );
});

test('部署侧两处同步：函数面清单登记 runtime + 具名 #region 的守卫/收回/授予', () => {
  const assertSql = read(ASSERT_SQL);
  assert.match(
    assertSql,
    /\(\s*'public'\s*,\s*'record_admin_scope_denial'\s*,\s*'runtime'\s*,\s*ARRAY\['gengyun_api_runtime'\]::text\[\]\)/,
    '90-assert 的 function_surface_manifest 必须把 record_admin_scope_denial 登记为 runtime'
      + '（断言 90 会因"未登记的 SECURITY DEFINER"判红，断言 92 会因 grantee 集合不符判红）',
  );

  const rolesSql = read(ROLES_SQL);
  const region = new RegExp(
    `-- #region ${DENIAL_GRANT_REGION}\\r?\\n([\\s\\S]*?)\\r?\\n\\s*-- #endregion ${DENIAL_GRANT_REGION}`,
  ).exec(rolesSql);
  assert.notEqual(region, null, `20-login-roles.sql 必须有 -- #region ${DENIAL_GRANT_REGION} 区域`);
  const block = region[1];
  assert.ok(
    block.includes(`to_regprocedure('public.record_admin_scope_denial(${SIGNATURE_TIGHT})') IS NULL`),
    '区域必须有 to_regprocedure 硬前置守卫（缺函数即显式失败，不留"看似收敛、点开 42501"的运行态）',
  );
  assert.ok(
    block.includes(`REVOKE ALL ON FUNCTION public.record_admin_scope_denial(${SIGNATURE}) FROM PUBLIC;`),
    '区域必须显式 REVOKE ALL … FROM PUBLIC',
  );
  assert.ok(
    block.includes(
      `GRANT EXECUTE ON FUNCTION public.record_admin_scope_denial(${SIGNATURE}) TO gengyun_api_runtime;`,
    ),
    '区域必须把 EXECUTE 授给 gengyun_api_runtime（断言 92 要求 grantee 集合精确等于该角色）',
  );
  // 区域里不得夹带表级授权（审计表对运行时仍是零表级、零列级写）。
  assert.equal(
    /GRANT\s+(?:INSERT|UPDATE|DELETE|ALL)\s+ON\s+TABLE/i.test(block),
    false,
    '该区域不得夹带任何表级写授权（admin_audit_events 必须保持"运行时零表级权限"）',
  );
});

test('回滚件：同名 .down.sql 以完整签名 DROP FUNCTION IF EXISTS，且不碰 0041 的两条函数', () => {
  const sql = read(ROLLBACK);
  assert.ok(
    sql.includes(`DROP FUNCTION IF EXISTS public.record_admin_scope_denial(${SIGNATURE});`),
    '回滚件必须 DROP FUNCTION IF EXISTS public.record_admin_scope_denial(uuid, uuid, text, text, uuid, uuid);',
  );
  for (const other of ['grant_admin_scope', 'revoke_admin_scope']) {
    assert.equal(
      sql.includes(`DROP FUNCTION ${other}`) || sql.includes(`DROP FUNCTION IF EXISTS public.${other}`),
      false,
      `回滚件的职责只有 0046 一条函数，⛔ 不得顺手 DROP 0041 的 ${other}`,
    );
  }
  assert.equal(
    /DROP\s+TABLE|TRUNCATE|DELETE\s+FROM/i.test(sql),
    false,
    '回滚件不得删表/删行（审计台账 append-only；正确动作是回滚应用版本，见文件头）',
  );
});

test('负控制：闭集对拍真会红 —— 各少一项 / 各多一项 / 有重复必须被点名', () => {
  const cases = [
    { list: CLOSED_SCOPES.filter((value) => value !== 'sources:write'), why: '少 sources:write' },
    { list: [...CLOSED_SCOPES, 'user'], why: '多 user（用户端 scope，不该进后台闭集）' },
    { list: [...CLOSED_SCOPES, 'scopes:read'], why: '重复 scopes:read' },
  ];
  for (const item of cases) {
    const problems = setProblems(item.list, CLOSED_SCOPES);
    assert.notEqual(problems, [], `${item.why}：闭集对拍必须判红，否则本文件的 ① 只是恒真的装饰`);
  }
  // 正控制：清醒的清单必须 0 问题（否则上面的"能红"可能来自一个恒红的实现）。
  assert.deepEqual(setProblems([...CLOSED_SCOPES], CLOSED_SCOPES), [], '同源清单必须 0 问题');

  const reasonProblems = setProblems(CLOSED_REASONS.filter((value) => value !== 'scope_not_held'), CLOSED_REASONS);
  assert.notEqual(reasonProblems, [], '理由闭集少一项必须判红');

  // 解析器自检：两个 ARRAY 都真的解析出了内容（防"文件改形状 ⇒ 解析器返回空数组 ⇒ 恒绿"）。
  const sql = read(MIGRATION);
  assert.equal(arrayLiterals(sql, 'x_scope_allowed').length, 13, 'x_scope_allowed 必须解析出 13 项');
  assert.equal(arrayLiterals(sql, 'x_reason_allowed').length, 4, 'x_reason_allowed 必须解析出 4 项');
  assert.equal(checkClosedSet(read(WRITE_AUTHORITY)).length, 13, '0041 的 CHECK 必须解析出 13 项');
});
