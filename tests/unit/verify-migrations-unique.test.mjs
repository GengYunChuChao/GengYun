/**
 * R30 · `tools/verify-migrations-unique.mjs` 的单测 —— 用**临时目录**造样例。
 *
 * 为什么用临时目录造样例：本守卫的价值全在「真目录的形态」上（顶层有哪些 `.sql`、`rollback/`
 * 里放了什么）。§2 的夹具各造一棵目录树，用**真 CLI**（`spawnSync`）跑，因此断言的是
 * **退出码**与**关键输出** —— 门禁在 CI 里被判的就是这两样，而不是某个内部函数的返回值。
 *
 * ⚠ 夹具编号一律用 `0100` 起（真实仓的 `0001..0027` 之外），理由：
 *   `NO_ROLLBACK` 登记了 `0001`，若夹具给 `0001` 配一份 down，「登记过期」这条判据会**正确地**
 *   判红，于是每个夹具都会多出一条与被测判据无关的红项。`0001` 只出现在 §4 那三条专门测
 *   允许缺省清单的用例里。
 *
 * 夹具目录一律建在 `os.tmpdir()`，`after()` 里删掉；⛔ 任何用例都不写
 * `services/api/db/migrations/`。真实目录只在 §3 里**只读**跑一次。
 *
 * 分层：
 *   §1 CLI 用法与退出码约定（0 / 1 / 2）；
 *   §2 六类形态夹具：正常 / 重复号 / rollback 形态错（两种）/ 发现器集合不等 / 空目录，
 *      外加「顶层 .down.sql」「缺回滚」「不合规命名」「目录不存在」「rollback/ 缺失」；
 *   §3 真实仓：守卫绿，且与 `services/api/src/db/migrate.ts` **口径同源**（正则逐字一致、
 *      默认目录同一处）—— 防的是「守卫与运行器悄悄看向两个不同口径」；
 *   §4 允许缺省清单（`NO_ROLLBACK`）的双向断言：登记生效、登记过期必红。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MIGRATIONS_DIR,
  NO_ROLLBACK,
  RUNNER_PATTERN_SOURCE,
  verifyMigrations,
} from '../../tools/verify-migrations-unique.mjs';
import { DEFAULT_MIGRATIONS_DIR as RUNNER_DEFAULT_MIGRATIONS_DIR } from '../../services/api/src/db/migrate.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = join(REPO_ROOT, 'tools', 'verify-migrations-unique.mjs');
const MIGRATE_TS = join(REPO_ROOT, 'services', 'api', 'src', 'db', 'migrate.ts');

/** 本文件造过的临时目录，`after()` 统一清理。 */
const FIXTURES = [];

after(() => {
  for (const dir of FIXTURES) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不该改变判据结论（临时目录由 OS 兜底回收）。
    }
  }
});

/**
 * 造一棵夹具目录树：顶层 `forward` 里的文件 + `rollback/` 里的 `rollback` 文件。
 * 文件内容一律是注释，守卫只读文件名。
 *
 * @param {{ forward?: string[], rollback?: string[], noRollbackDir?: boolean }} spec
 * @returns {string} 夹具根目录
 */
function makeFixture(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'gy-r30-mig-guard-'));
  FIXTURES.push(dir);
  if (spec.noRollbackDir === true) {
    for (const name of spec.forward ?? []) writeFileSync(join(dir, name), '-- fixture\n', 'utf8');
    return dir;
  }
  mkdirSync(join(dir, 'rollback'));
  for (const name of spec.forward ?? []) writeFileSync(join(dir, name), '-- fixture\n', 'utf8');
  for (const name of spec.rollback ?? []) {
    writeFileSync(join(dir, 'rollback', name), '-- fixture\n', 'utf8');
  }
  return dir;
}

/** 跑真 CLI：返回退出码与两路输出。 */
function runCli(args) {
  const result = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** 断言输出里出现的判据红项编号集合（`FAIL[<id>]`）恰为 `expected`。 */
function assertFailureIds(stdout, expected) {
  const ids = [...new Set([...stdout.matchAll(/FAIL\[([a-z]+)\]/g)].map((match) => match[1]))].sort();
  assert.deepEqual(
    ids,
    [...expected].sort(),
    `红项编号应为 ${expected.join('、') || '(无)'}，实际：${ids.join('、') || '(无)'}\n${stdout}`,
  );
}

// ---------------------------------------------------------------------------
// §1 CLI 用法与退出码约定
// ---------------------------------------------------------------------------

test('用法·--help 打印用法并以 0 退出（「帮我看一眼」不是失败）', () => {
  const { status, stdout } = runCli(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /用法/);
  assert.match(stdout, /--dir/);
  assert.match(stdout, /0 = 全部满足/);
});

test('用法·未知参数 ⇒ 退出码 2（用法错误 ≠ 判据不满足）', () => {
  const { status, stderr } = runCli(['--migrations-dir', 'x']);
  assert.equal(status, 2);
  assert.match(stderr, /未知参数：--migrations-dir/);
  assert.match(stderr, /退出码/);
});

test('用法·--dir 缺值 ⇒ 退出码 2，且不会退回去扫默认目录', () => {
  const { status, stderr } = runCli(['--dir']);
  assert.equal(status, 2);
  assert.match(stderr, /需要一个目录参数/);
});

// ---------------------------------------------------------------------------
// §2 六类形态夹具（＋五类边界）
// ---------------------------------------------------------------------------

test('夹具 1·正常：两条迁移各有一份同名 down ⇒ 退出码 0 且 PASS', () => {
  const dir = makeFixture({
    forward: ['0100_initial_schema.sql', '0101_knowledge_catalog.sql'],
    rollback: ['0100_initial_schema.down.sql', '0101_knowledge_catalog.down.sql'],
  });

  const { status, stdout } = runCli(['--dir', dir]);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /\nPASS：5 项判据全部满足/);
  assert.match(stdout, /\[surface\]\s+顶层 \.sql 2 条：合 \^\\d\{4\}_\.\*\\\.sql\$ 的正向迁移 2 条/);
  assert.match(stdout, /\[runner\]\s+守卫 2 条 ↔ 产品发现器 2 条：差集 0 条/);
  assert.match(stdout, /\[dup\]\s+2 条正向迁移占用 2 个编号（0100\.\.0101）：同号多文件 0 处/);
  assert.match(stdout, /已配对 2 条/);
  assert.doesNotMatch(stdout, /FAIL/);
});

test('夹具 2·重复号：同一 0098 被两条正向文件占用 ⇒ 退出码 1，[dup] 点名两个文件', () => {
  // 真实案例的形状：main 的 0027 之后 #434 带 0028_governance_audit_log.sql，
  // i18 那片带 0028_admin_scope_authority.sql。这里用同构的假号，⛔ 不碰真实迁移目录。
  const dir = makeFixture({
    forward: ['0099_other_table.sql', '0098_governance_audit_log.sql', '0098_admin_scope_authority.sql'],
    rollback: [
      '0099_other_table.down.sql',
      '0098_governance_audit_log.down.sql',
      '0098_admin_scope_authority.down.sql',
    ],
  });

  const { status, stdout } = runCli(['--dir', dir]);
  assert.equal(status, 1, stdout);
  // 真实形态会同时踩两条判据，各自说的是不同的事实：顶层有两条 0098 正向文件（[dup]），
  // rollback/ 里因此也有两份 0098 的 down（[coexist]）。两条都不是对方的重述 ——
  // 反过来「有 dup 但只写了一份 down」或「只有两份 down 没有 dup」都各能单独出现。
  assertFailureIds(stdout, ['coexist', 'dup']);
  assert.match(stdout, /0098：0098_admin_scope_authority\.sql、0098_governance_audit_log\.sql/);
  assert.match(stdout, /同一编号出现多份 \.down\.sql（1 个号）/);
  assert.match(stdout, /迁移版本号重复：0098 同时出现在/);
  assert.match(stdout, /schema_migrations\.version 是主键/);
  assert.match(stdout, /当前最大号 0099 ⇒ 空位 0100/);
  assert.match(stdout, /退出码 1。/);
});

test('夹具 3·rollback 形态错（正向形态放进 rollback/）⇒ 退出码 1，[coexist] 点名该文件', () => {
  const dir = makeFixture({
    forward: ['0100_initial_schema.sql', '0101_knowledge_catalog.sql'],
    rollback: [
      '0100_initial_schema.down.sql',
      '0101_knowledge_catalog.down.sql',
      '0101_knowledge_catalog_second.sql',
    ],
  });

  const { status, stdout } = runCli(['--dir', dir]);
  assert.equal(status, 1, stdout);
  assertFailureIds(stdout, ['coexist']);
  assert.match(stdout, /不合 <NNNN>_<name>\.down\.sql 的 \.sql（1 条）：0101_knowledge_catalog_second\.sql/);
  assert.match(stdout, /开后门/);
});

test('夹具 4·rollback 形态错（同一号补第二份 .down.sql）⇒ 退出码 1，[coexist] 报同号多份', () => {
  const dir = makeFixture({
    forward: ['0100_initial_schema.sql', '0101_knowledge_catalog.sql'],
    rollback: [
      '0100_initial_schema.down.sql',
      '0101_knowledge_catalog.down.sql',
      '0101_knowledge_catalog_again.down.sql',
    ],
  });

  const { status, stdout } = runCli(['--dir', dir]);
  assert.equal(status, 1, stdout);
  assertFailureIds(stdout, ['coexist']);
  assert.match(stdout, /同一编号出现多份 \.down\.sql（1 个号）/);
  assert.match(stdout, /0101：0101_knowledge_catalog\.down\.sql、0101_knowledge_catalog_again\.down\.sql/);
  assert.match(stdout, /同号多份 1 处/);
  // 正向文件与它同名的 down 仍然是配对的（[rollback] 不该被这条形态连带误伤）。
  assert.doesNotMatch(stdout, /FAIL\[rollback\]/);
});

test('夹具 5·发现器集合不等：守卫看得见、运行器认不出（大写）⇒ 退出码 1，[runner] 点名差集', () => {
  // `0101_Catalog.sql` 合守卫的 `^\d{4}_.*\.sql$`，但不合运行器的 `[a-z0-9_]+`。
  // 这是「守卫绿、运行器抛」的形态：绿说明不了任何事，所以必须红。
  const dir = makeFixture({
    forward: ['0100_initial_schema.sql', '0101_Catalog.sql'],
    rollback: ['0100_initial_schema.down.sql', '0101_Catalog.down.sql'],
  });

  const { status, stdout } = runCli(['--dir', dir]);
  assert.equal(status, 1, stdout);
  assertFailureIds(stdout, ['runner']);
  assert.match(stdout, /只有守卫看得见（运行器会抛「迁移文件名不合规」）：0101_Catalog\.sql/);
  assert.match(stdout, /守卫 2 条 ↔ 产品发现器 1 条：差集 1 条/);
  assert.doesNotMatch(stdout, /FAIL\[rollback\]/);
});

test('夹具 6·空目录：扫到 0 条 ⇒ 退出码 1（反空转：全空不是全绿）', () => {
  const dir = makeFixture({});

  const { status, stdout } = runCli(['--dir', dir]);
  assert.equal(status, 1, stdout);
  assertFailureIds(stdout, ['surface']);
  assert.match(stdout, /扫描面为空/);
  assert.match(stdout, /按反空转口径直接红/);
  // 空扫描面时不再逐条报「登记过期」：那是同一个根因，只由 [surface] 说话。
  assert.doesNotMatch(stdout, /FAIL\[rollback\]/);
});

test('夹具 7·顶层出现 .down.sql ⇒ 退出码 1，[surface] 点名（它永远不会被当回滚执行）', () => {
  const dir = makeFixture({
    forward: ['0100_initial_schema.sql', '0100_initial_schema.down.sql'],
    rollback: ['0100_initial_schema.down.sql'],
  });

  const { status, stdout } = runCli(['--dir', dir]);
  assert.equal(status, 1, stdout);
  assertFailureIds(stdout, ['surface']);
  assert.match(stdout, /顶层出现回滚文件（\.down\.sql 只属于 rollback\/）：0100_initial_schema\.down\.sql/);
  assert.match(stdout, /顶层 \.down\.sql 1 条/);
  assert.doesNotMatch(stdout, /FAIL\[rollback\]/);
});

test('夹具 8·缺回滚且未登记 ⇒ 退出码 1，[rollback] 点名该迁移', () => {
  const dir = makeFixture({ forward: ['0109_brand_new.sql'] });

  const { status, stdout } = runCli(['--dir', dir]);
  assert.equal(status, 1, stdout);
  assertFailureIds(stdout, ['rollback']);
  assert.match(stdout, /缺回滚且未登记为允许缺省（1 条）：0109_brand_new\.sql/);
});

test('夹具 9·不合规命名（29_short_prefix.sql）⇒ 退出码 1；两侧都看不见它，故 [runner] 不红', () => {
  const dir = makeFixture({
    forward: ['0100_initial_schema.sql', '29_short_prefix.sql'],
    rollback: ['0100_initial_schema.down.sql'],
  });

  const { status, stdout } = runCli(['--dir', dir]);
  assert.equal(status, 1, stdout);
  assertFailureIds(stdout, ['surface']);
  assert.match(stdout, /顶层文件名不合 \^\\d\{4\}_\.\*\\\.sql\$：29_short_prefix\.sql/);
  assert.match(stdout, /它永远不会被执行/);
  // 守卫与运行器**都**认不出它 ⇒ 两个集合仍相等，[runner] 沉默是对的。
  assert.doesNotMatch(stdout, /FAIL\[runner\]/);
  assert.match(stdout, /守卫 1 条 ↔ 产品发现器 1 条：差集 0 条/);
});

test('夹具 10·目录不存在 ⇒ 退出码 1（不是 2：这是判据不满足，不是用法错）', () => {
  const root = mkdtempSync(join(tmpdir(), 'gy-r30-mig-guard-'));
  FIXTURES.push(root);
  const missing = join(root, 'not-a-directory');

  const { status, stdout } = runCli(['--dir', missing]);
  assert.equal(status, 1, stdout);
  assertFailureIds(stdout, ['surface']);
  assert.match(stdout, /找不到迁移目录/);
  assert.match(stdout, /假绿形态/);
});

test('夹具 11·rollback/ 缺失 ⇒ 退出码 1，[rollback] 不按「全都没有 down」放行', () => {
  const dir = makeFixture({
    forward: ['0100_initial_schema.sql', '0101_knowledge_catalog.sql'],
    noRollbackDir: true,
  });

  const { status, stdout } = runCli(['--dir', dir]);
  assert.equal(status, 1, stdout);
  assertFailureIds(stdout, ['rollback']);
  assert.match(stdout, /找不到回滚目录/);
  assert.match(stdout, /缺回滚且未登记为允许缺省（2 条）：0100_initial_schema\.sql、0101_knowledge_catalog\.sql/);
});

test('夹具 12·孤儿回滚（有 down 无正向迁移）⇒ 退出码 1，[rollback] 点名该号', () => {
  const dir = makeFixture({
    forward: ['0100_initial_schema.sql'],
    rollback: ['0100_initial_schema.down.sql', '0199_ghost_table.down.sql'],
  });

  const { status, stdout } = runCli(['--dir', dir]);
  assert.equal(status, 1, stdout);
  assertFailureIds(stdout, ['rollback']);
  assert.match(stdout, /孤儿回滚（有 down 无正向迁移）：0199/);
});

// ---------------------------------------------------------------------------
// §3 真实仓：守卫绿，且口径与运行器同源
// ---------------------------------------------------------------------------

test('真实仓·守卫对 services/api/db/migrations/ 判绿，且每条正向迁移要么配对、要么登记允许缺省', () => {
  const result = verifyMigrations();
  assert.equal(
    result.ok,
    true,
    `真实目录必须判绿；不满足项：${
      result.failures.map((failure) => `[${failure.id}] ${failure.message}`).join('\n') || '(无)'
    }`,
  );
  assert.deepEqual(result.details.duplicated, []);
  assert.deepEqual(result.details.missing, []);
  assert.deepEqual(result.details.orphan, []);
  assert.deepEqual(result.details.duplicatedRollback, []);
  assert.ok(result.details.forwardFiles.length > 0, '扫描面不能为空');
  assert.equal(
    result.details.paired.length + result.details.exempted.length,
    result.details.forwardFiles.length,
    '每条正向迁移只能有两种去处：配对 down，或登记允许缺省',
  );
});

test('真实仓·默认目录与运行器的 DEFAULT_MIGRATIONS_DIR 是同一个目录（不是两份口径）', () => {
  assert.equal(
    realpathSync(DEFAULT_MIGRATIONS_DIR).toLowerCase(),
    realpathSync(RUNNER_DEFAULT_MIGRATIONS_DIR).toLowerCase(),
    '守卫的默认目录必须与 services/api/src/db/migrate.ts:42 指向同一处',
  );
});

test('真实仓·RUNNER_PATTERN_SOURCE 与 migrate.ts:44 的 MIGRATION_PATTERN 逐字一致（口径漂移即红）', () => {
  const source = readFileSync(MIGRATE_TS, 'utf8');
  const match = /const MIGRATION_PATTERN = \/(.+)\/;/.exec(source);
  assert.ok(match, 'migrate.ts 里应当仍有一行 `const MIGRATION_PATTERN = /…/;`');
  assert.equal(
    match[1],
    RUNNER_PATTERN_SOURCE,
    '守卫抄的那条正则与产品发现器不一致：守卫与运行器看到的就是两批文件，绿没有意义',
  );
  assert.match(source, /迁移版本号重复/, 'migrate.ts 里应当仍有「迁移版本号重复」这条运行时失败');
});

// ---------------------------------------------------------------------------
// §4 允许缺省清单（NO_ROLLBACK）：登记生效 + 登记过期必红
// ---------------------------------------------------------------------------

test('清单·当前只登记 0001 一条，且理由是一句可核证的话（不是占位符）', () => {
  assert.deepEqual([...NO_ROLLBACK.keys()], ['0001'], '新增豁免必须同时改证据页，不允许悄悄长出来');
  const reason = NO_ROLLBACK.get('0001');
  assert.equal(typeof reason, 'string');
  assert.ok(reason.trim().length >= 20, '豁免理由 ≥ 20 字');
  assert.match(reason, /gy-r28-migration-rollback-pairing-20261021\.md §4/, '理由必须指向可核证的判定出处');
});

test('清单·登记生效：0001 无 down 也判绿（豁免真的能放行）', () => {
  const dir = makeFixture({
    forward: ['0001_initial_schema.sql', '0100_knowledge_catalog.sql'],
    rollback: ['0100_knowledge_catalog.down.sql'],
  });
  // 夹具是**别的**目录 ⇒ 内置清单不套用（见守卫里 builtinAllowlistApplies 的注释），故这里显式传入，
  // 验的是「登记本身能不能放行」。真实目录套用内置清单的情形由 §3 那条用例覆盖。
  const result = verifyMigrations({ migrationsDir: dir, noRollback: NO_ROLLBACK });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.deepEqual(result.details.exempted.map((item) => item.number), ['0001']);
  assert.equal(result.details.paired.length, 1);
});

test('清单·登记过期（该号已经有 down 还登记着）⇒ 判红并点名', () => {
  const dir = makeFixture({
    forward: ['0001_initial_schema.sql'],
    rollback: ['0001_initial_schema.down.sql'],
  });
  const result = verifyMigrations({ migrationsDir: dir, noRollback: NO_ROLLBACK });
  assert.equal(result.ok, false);
  const rollbackFailures = result.failures.filter((failure) => failure.id === 'rollback');
  assert.equal(rollbackFailures.length, 1);
  assert.match(rollbackFailures[0].message, /NO_ROLLBACK 登记过期（1 条）/);
  assert.match(rollbackFailures[0].message, /0001：该号已有回滚/);
});

test('清单·登记理由过短（占位符）⇒ 判红', () => {
  const dir = makeFixture({ forward: ['0001_initial_schema.sql'] });
  const result = verifyMigrations({ migrationsDir: dir, noRollback: new Map([['0001', '无']]) });
  assert.equal(result.ok, false);
  assert.match(
    result.failures.map((failure) => failure.message).join('\n'),
    /理由不足 20 字或为空（占位符不算登记）/,
  );
});
