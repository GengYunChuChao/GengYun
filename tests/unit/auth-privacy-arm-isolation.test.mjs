/**
 * 真库臂「同库隔离」静态门禁（GY-R29 第二片）。
 *
 * 为什么需要它：`.github/workflows/auth-privacy-postgres.yml` 的两个 step 曾经都把 URL 指向
 * `gengyun_auth_privacy_test`（同一个库）。两个臂在同一个库上跑，一端崩溃留下的角色/对象会掩住另一端：
 * 实测把 `auth-privacy-pg.mjs` 两个实例并行跑时，第二个实例在 `pg_type_typname_nsp_index` 唯一约束上红
 * （`duplicate key value violates unique constraint`），另一轮在角色数断言上报 `29 !== 0`；把角色换成
 * 「在别的库里拥有对象」时，`DROP OWNED BY` 只清当前库 ⇒ `DROP ROLE` 报
 * `role "…" cannot be dropped because some objects depend on it` / `DETAIL: 1 object in database postgres`。
 *
 * 本文件是**纯静态**检查：只读仓库里的 YAML 与两个 `tests/integration/*pg*.mjs` 源文件。
 * ⛔ 不起服务、不连 PG、不写文件、不加依赖。四条判据 + 四条反向控制（变异必须红）。
 *
 * 判据（对真实文件必须全部无问题）：
 *  1) 两个 step 的库名必须不同，且迁移负例的维护库**不得**是被测臂的库（现指向服务自带 `postgres`）；
 *  2) 不新增第三个 `node tests/integration/…` step：建/删库由脚本自建自删，避免把 step 顺序判据架空
 *     （`real-pg-integration.yml` 的 `REQUIRED_STEP_ORDER` 只管它自己那个 job，本 workflow 没有顺序常量）；
 *  3) `migrations-negative-pg.mjs` 的删库**不得**用 `.catch(() => {})` 吞错，且必须有「本臂库残留 = 0」断言、
 *     专用维护库名与诱饵库负控制；
 *  4) `auth-privacy-pg.mjs` 必须对**每个非模板库**各跑一次 `DROP OWNED BY`（不得写 `… IN DATABASE` 这种
 *     17.11 不存在的语法），并有跨库诱饵负控制与「角色/诱饵库残留 = 0」断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（tests/unit/ → ../..），⛔ 不依赖 process.cwd()。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/auth-privacy-postgres.yml');
const NEGATIVE_PATH = join(REPO_ROOT, 'tests/integration/migrations-negative-pg.mjs');
const AUTH_PATH = join(REPO_ROOT, 'tests/integration/auth-privacy-pg.mjs');

const read = (path) => readFileSync(path, 'utf8');
/** 去掉整行注释，只留可执行代码——注释里会引用错误写法（本文件与两臂脚本都如此），不能当证据。 */
const codeOnly = (text) =>
  text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
/** 从 `postgres://…/dbname` 里取库名（取最后一个 `/` 之后、去掉查询串）。 */
const databaseName = (url) => decodeURIComponent(url.split('?')[0].split('/').pop());

/**
 * 判据 1/2：解析 workflow 文本，取两个 step 的库名与 step 数。
 * 只认 `AUTH_PRIVACY_TEST_URL:` / `MIGRATIONS_NEGATIVE_TEST_URL:` 两行——刻意不做通用 YAML 解析，避免为
 * 一个文件引入依赖；若将来 URL 改成变量/矩阵，这条会因取不到值而红，逼人显式回来改判据（这正是想要的）。
 */
function inspectWorkflow(text) {
  const problems = [];
  const authUrl = /AUTH_PRIVACY_TEST_URL:\s*(\S+)/.exec(text)?.[1];
  const negativeUrl = /MIGRATIONS_NEGATIVE_TEST_URL:\s*(\S+)/.exec(text)?.[1];
  if (!authUrl) problems.push('取不到 AUTH_PRIVACY_TEST_URL（判据 1 无法核对）');
  if (!negativeUrl) problems.push('取不到 MIGRATIONS_NEGATIVE_TEST_URL（判据 1 无法核对）');
  if (authUrl && negativeUrl) {
    const authDb = databaseName(authUrl);
    const negativeDb = databaseName(negativeUrl);
    if (authDb === negativeDb) {
      problems.push(`两个 step 用了同一个库 ${authDb}：一端残留会掩另一端（判据 1）`);
    }
    if (negativeDb !== 'postgres') {
      problems.push(`迁移负例的维护库应指向服务自带 postgres，实测 ${negativeDb}（判据 1）`);
    }
    if (authDb !== 'gengyun_auth_privacy_test') {
      problems.push(`auth-privacy 臂的库应仍是 gengyun_auth_privacy_test，实测 ${authDb}（与脚本 :22 断言同源）`);
    }
  }
  const stepCount = (text.match(/^\s*- run: node tests\/integration\/\S+/gm) ?? []).length;
  if (stepCount !== 2) {
    problems.push(`本 workflow 的集成 step 数应为 2（建/删库由脚本自建自删），实测 ${stepCount}（判据 2）`);
  }
  return problems;
}

/** 判据 3：迁移负例的删库不得吞错，且必须有维护库/残留断言/诱饵负控制。 */
function inspectNegative(text) {
  const problems = [];
  const code = text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    });
  const swallow = code.filter((line) => /(DROP DATABASE|dropDatabase\()/.test(line) && /\.catch\(/.test(line));
  if (swallow.length > 0) problems.push(`删库仍在吞错（判据 3）：${swallow.map((l) => l.trim()).join(' | ')}`);
  if (!/gengyun_migrations_negative_maint/.test(text)) problems.push('缺专用维护库 gengyun_migrations_negative_maint（判据 3）');
  if (!/gengyun_migrations_negative_decoy/.test(text)) problems.push('缺诱饵库负控制 gengyun_migrations_negative_decoy（判据 3）');
  if (!/FROM pg_database WHERE datname LIKE/.test(text)) problems.push('缺「本臂库残留 = 0」的 pg_database 断言（判据 3）');
  if (!/leftoverDatabases/.test(text)) problems.push('缺遗留库探测器 leftoverDatabases（判据 3）');
  if (/DROP OWNED BY[\s\S]{0,80}?IN DATABASE/.test(codeOnly(text))) problems.push('出现了 17.11 不存在的语法 DROP OWNED BY … IN DATABASE（判据 4）');
  return problems;
}

/** 判据 4：auth-privacy 必须逐库清理，并有跨库诱饵负控制与归零断言。 */
function inspectAuth(text) {
  const problems = [];
  if (!/datistemplate = false/.test(text)) problems.push('缺「遍历非模板库」的清理入口（判据 4）');
  if (!/async function dropRolesEverywhere/.test(text)) problems.push('缺 dropRolesEverywhere（逐库 DROP OWNED 后再 DROP ROLE，判据 4）');
  if (!/gengyun_auth_privacy_decoy/.test(text)) problems.push('缺跨库诱饵角色负控制（判据 4）');
  if (!/cannot be dropped because some objects depend on it/.test(text)) problems.push('负控制缺 dependent objects 断言（判据 4）');
  if (!/FROM pg_database WHERE datname LIKE/.test(text)) problems.push('缺「诱饵库残留 = 0」断言（判据 4）');
  if (/DROP OWNED BY[\s\S]{0,80}?IN DATABASE/.test(codeOnly(text))) problems.push('出现了 17.11 不存在的语法 DROP OWNED BY … IN DATABASE（判据 4）');
  return problems;
}

test('workflow：两个 step 不同库，迁移负例走自带 postgres，且不新增集成 step', () => {
  assert.deepEqual(inspectWorkflow(read(WORKFLOW_PATH)), []);
});

test('migrations-negative-pg：删库不吞错、专用维护库、残留归零断言、诱饵负控制', () => {
  assert.deepEqual(inspectNegative(read(NEGATIVE_PATH)), []);
});

test('auth-privacy-pg：逐库 DROP OWNED、跨库诱饵负控制、角色/诱饵库归零断言', () => {
  assert.deepEqual(inspectAuth(read(AUTH_PATH)), []);
});

// ---------------------------------------------------------------------------
// 反向控制：把真实文本按「后人可能写回去的错法」变异，检查器必须报问题。
// 没有这一组，上面三条断言在判据被悄悄删掉时仍会绿（同义反复）。
// ---------------------------------------------------------------------------
test('反向控制①：把迁移负例的 URL 改回 auth-privacy 的库 ⇒ 必须红', () => {
  const mutated = read(WORKFLOW_PATH).replace(
    'MIGRATIONS_NEGATIVE_TEST_URL: postgres://gengyun_ci_owner:synthetic-ci-owner-only@127.0.0.1:5432/postgres',
    'MIGRATIONS_NEGATIVE_TEST_URL: postgres://gengyun_ci_owner:synthetic-ci-owner-only@127.0.0.1:5432/gengyun_auth_privacy_test',
  );
  const problems = inspectWorkflow(mutated);
  assert.ok(problems.some((p) => p.includes('同一个库')), `应报同库，实测 ${JSON.stringify(problems)}`);
});

test('反向控制②：多接一个集成 step ⇒ 必须红（不得靠新增 step 建库）', () => {
  const mutated = `${read(WORKFLOW_PATH)}\n      - run: node tests/integration/extra-pg.mjs\n`;
  assert.ok(inspectWorkflow(mutated).some((p) => p.includes('集成 step 数应为 2')));
});

test('反向控制③：给删库行加回 .catch(() => {}) ⇒ 必须红（假绿通道）', () => {
  const mutated = read(NEGATIVE_PATH).replace(
    'await dropDatabase(name);',
    'await dropDatabase(name).catch(() => {});',
  );
  assert.ok(inspectNegative(mutated).some((p) => p.includes('吞错')), '删库吞错必须被抓到');
});

test('反向控制④：删掉诱饵库负控制 ⇒ 必须红（收尾断言不得空转）', () => {
  const mutated = read(NEGATIVE_PATH).replaceAll('gengyun_migrations_negative_decoy', 'removed_decoy');
  assert.ok(inspectNegative(mutated).some((p) => p.includes('诱饵库负控制')));
});

test('反向控制⑤：auth-privacy 的逐库清理退回「只清当前库」⇒ 必须红', () => {
  const mutated = read(AUTH_PATH)
    .replace('datistemplate = false', 'datname = current_database()')
    .replaceAll('dropRolesEverywhere', 'dropRolesHere');
  assert.ok(inspectAuth(mutated).some((p) => p.includes('遍历非模板库') || p.includes('dropRolesEverywhere')));
});
