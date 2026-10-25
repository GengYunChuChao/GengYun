// `#18` S2 PR-2 · 后台 scope 闭集的应用层常量 ⇄ 库层 CHECK 契约镜像（CI 可跑的双向钉）。
//
// 为什么需要这一条：闭集在仓内有三处「同源」副本 ——
//   ① 应用层唯一出口守卫常量 `ADMIN_SCOPES`（`services/api/src/admin/scopes.ts:19`）；
//   ② 库层强约束 `admin_scopes_scope_closed_set`（迁移
//      `services/api/db/migrations/0041_admin_scope_write_authority.sql:177-194`）；
//   ③ 契约 `AdminScope.enum` 与 `SessionInfo.scopes.items.enum`（`packages/contracts/openapi.json`）。
// ③ ⇄ ① 已由 `tests/unit/session-scopes-s1.test.mjs` 的 ③（契约 enum / operations 清单 /
// `codeAdminScopes()` 三方对拍）覆盖；② ⇄ ① 此前**只有**真库臂覆盖
// （`tests/integration/admin-scopes-read-pg.mjs` 的 `[M]` 段：读 `pg_get_constraintdef()` 与
// `ADMIN_SCOPES` 逐项比），而那条臂在本机与默认 CI 都跑不到（缺 `GY_PG_BIN` ⇒ exit 77）。
// 于是「迁移里改了 CHECK、忘了改 `admin/scopes.ts`」（或反过来）只会在真库环境才红。
// 本条把同一件事搬到纯文本解析上，让漂移在无库环境当场红。
//
// ⛔ 这里不新增任何口径：13 项集合与顺序的唯一权威仍是 `ADMIN_SCOPES`，
//    迁移第 116-130 行的预检数组与第 178-194 行的 CHECK 必须与它逐字同源
//    （迁移自己的注释第 114-115 行就这么要求：「这一份与下面 ② 的 CHECK 必须逐字同源」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADMIN_SCOPES } from '../../services/api/src/admin/scopes.ts';

const MIGRATION_PATH = 'services/api/db/migrations/0041_admin_scope_write_authority.sql';
const MIGRATION = readFileSync(new URL('../../' + MIGRATION_PATH, import.meta.url), 'utf8');

/** 迁移里单引号字面量（scope 都是 `a:b` 形态，不含需要转义的单引号）。 */
const literals = (block) => [...block.matchAll(/'([^']+)'/gu)].map((m) => m[1]);

/**
 * 从迁移文本里取两组闭集字面量：库层 CHECK（第 178-194 行）与预检数组（第 116-130 行）。
 * 抽成函数是为了能对「被改坏的迁移副本」做反向控制（见最后一个用例）。
 */
function extractClosedSet(text) {
  const check = text.match(/ADD CONSTRAINT admin_scopes_scope_closed_set CHECK \(([\s\S]*?)\);/u);
  const preflight = text.match(/x_allowed text\[\] := ARRAY\[([\s\S]*?)\]::text\[\];/u);
  assert.ok(check, `迁移里找不到 admin_scopes_scope_closed_set 的 CHECK 定义（${MIGRATION_PATH}）`);
  assert.ok(preflight, `迁移里找不到 x_allowed 预检数组（${MIGRATION_PATH}）`);
  return { check: literals(check[1]), preflight: literals(preflight[1]) };
}

const { check: CHECK_SCOPES, preflight: PREFLIGHT_SCOPES } = extractClosedSet(MIGRATION);

test('① 迁移 CHECK 的取值集合与 ADMIN_SCOPES 双向相等（多一个、少一个、改名都红）', () => {
  const fromConstant = [...ADMIN_SCOPES];
  assert.equal(
    fromConstant.length,
    new Set(fromConstant).size,
    'ADMIN_SCOPES 自身不得有重复项（闭集是集合语义）',
  );
  assert.equal(fromConstant.length, 13, '后台 scope 闭集应为 13 项（11 + scopes:read + scopes:write）');

  // 正向：常量里每一项迁移都必须允许，否则应用层会写出「库层判 23514」的取值。
  for (const scope of fromConstant) {
    assert.ok(
      CHECK_SCOPES.includes(scope),
      `${MIGRATION_PATH} 的 CHECK 缺少 ADMIN_SCOPES 成员：${scope}（写这条路会撞 23514）`,
    );
  }

  // 反向：迁移允许的每一项常量都必须在闭集里，否则应用层出口守卫会把合法权限判成越界。
  for (const scope of CHECK_SCOPES) {
    assert.ok(
      fromConstant.includes(scope),
      `ADMIN_SCOPES 缺少迁移 CHECK 允许的取值：${scope}（合法授权会被出口守卫判成闭集外）`,
    );
  }

  // 集合相等 + 逐项同序：两边都按码元序书写，重排本身不该发生，发生即说明有人手改了其中一侧。
  assert.deepEqual(
    [...CHECK_SCOPES].sort(),
    [...fromConstant].sort(),
    '迁移 CHECK 与 ADMIN_SCOPES 的取值集合必须完全相等',
  );
  assert.deepEqual([...CHECK_SCOPES], fromConstant, '迁移 CHECK 与 ADMIN_SCOPES 必须逐字同序（两侧都按码元序）');
  assert.ok(Object.isFrozen(ADMIN_SCOPES), 'ADMIN_SCOPES 必须冻结，防止运行期被塞进第 14 个值');
});

test('② 迁移内部两处副本同源：预检数组 x_allowed 与 CHECK 逐字相等', () => {
  // 迁移第 114-115 行的注释把这件事写成硬要求；预检漏掉一项就等于「历史坏行放行」。
  assert.deepEqual(PREFLIGHT_SCOPES, CHECK_SCOPES, '预检数组与 CHECK 必须逐字同源（迁移自己的注释要求）');
  assert.equal(PREFLIGHT_SCOPES.length, 13);
});

test('③ 本片两个新 scope 在迁移里各出现一次（⛔ 不是被复制粘贴成两行）', () => {
  for (const scope of ['scopes:read', 'scopes:write']) {
    assert.ok(ADMIN_SCOPES.includes(scope), `${scope} 必须在应用层闭集里`);
    assert.equal(
      CHECK_SCOPES.filter((item) => item === scope).length,
      1,
      `CHECK 里 ${scope} 必须恰好出现一次`,
    );
    assert.equal(
      PREFLIGHT_SCOPES.filter((item) => item === scope).length,
      1,
      `预检数组里 ${scope} 必须恰好出现一次`,
    );
  }
});

test('④ 反向控制：被改坏的迁移副本必须被同一套比对判红（证明上面不是空断言）', () => {
  const broken = MIGRATION.replace(
    "      'sources:write'\n    )",
    "      'sources:write',\n      'sources:archive'\n    )",
  );
  assert.notEqual(broken, MIGRATION, '反向控制的替换必须真的改到迁移文本，否则用例本身失效');

  const bad = extractClosedSet(broken);
  assert.equal(bad.check.length, 14, '改坏后 CHECK 应为 14 项');
  assert.deepEqual(
    bad.check.filter((scope) => !ADMIN_SCOPES.includes(scope)),
    ['sources:archive'],
    '多出来的取值必须能被「反向比较」当场指出来',
  );
  assert.throws(
    () => assert.deepEqual([...bad.check], [...ADMIN_SCOPES]),
    /must be|Expected|Values have different length/u,
    '逐字同序比较必须对多一项的闭集抛错',
  );
});
