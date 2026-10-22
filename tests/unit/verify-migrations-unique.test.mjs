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
 *   §2b 派单口径的三类夹具（合法连续 / 重复号 / 跳号）+ `--json` 契约与退出码收窄；
 *   §3 真实仓：守卫绿，且与 `services/api/src/db/migrate.ts` **口径同源**（正则逐字一致、
 *      默认目录同一处）—— 防的是「守卫与运行器悄悄看向两个不同口径」；
 *   §4 允许缺省清单（`NO_ROLLBACK`）的双向断言：登记生效、登记过期必红。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MIGRATIONS_DIR,
  NO_ROLLBACK,
  RUNNER_PATTERN,
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

/**
 * 断言输出里出现的判据编号集合（`FAIL[<id>]` 硬错 + `WARN[<id>]` 默认只 warn）恰为 `expected`。
 *
 * 两档都算「被点到了」：门禁的价值不只是退出码，还包括「人能不能在日志里一眼看到是哪条判据」。
 */
function assertIssueIds(stdout, expected) {
  const ids = [...new Set([...stdout.matchAll(/(?:FAIL|WARN)\[([a-z]+)\]/g)].map((match) => match[1]))].sort();
  assert.deepEqual(
    ids,
    [...expected].sort(),
    `被点名的判据应为 ${expected.join('、') || '(无)'}，实际：${ids.join('、') || '(无)'}\n${stdout}`,
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
  assertIssueIds(stdout, ['coexist', 'dup']);
  assert.match(stdout, /0098：0098_admin_scope_authority\.sql、0098_governance_audit_log\.sql/);
  assert.match(stdout, /同一编号出现多份 \.down\.sql（1 个号）/);
  assert.match(stdout, /迁移版本号重复：0098 同时出现在/);
  assert.match(stdout, /schema_migrations\.version 是主键/);
  assert.match(stdout, /当前最大号 0099 ⇒ 空位 0100/);
  assert.match(stdout, /退出码 1。/);
});

test('夹具 3·rollback 形态错（正向形态放进 rollback/）⇒ 默认只 warn（退出码 0），--strict 才 1', () => {
  const dir = makeFixture({
    forward: ['0100_initial_schema.sql', '0101_knowledge_catalog.sql'],
    rollback: [
      '0100_initial_schema.down.sql',
      '0101_knowledge_catalog.down.sql',
      '0101_knowledge_catalog_second.sql',
    ],
  });

  const { status, stdout } = runCli(['--dir', dir]);
  // 2026-10-22 收窄口径：`rollback/` 不是全仓约定 ⇒ 形态错默认只 warn，不拦 PR。
  assert.equal(status, 0, stdout);
  assertIssueIds(stdout, ['coexist']);
  assert.match(stdout, /WARN\[coexist\]/);
  assert.match(stdout, /不合 <NNNN>_<name>\.down\.sql 的 \.sql（1 条）：0101_knowledge_catalog_second\.sql/);
  assert.match(stdout, /开后门/);
  assert.match(stdout, /WARN：1 项默认不判错（coexist）；退出码 0；加 --strict 可升为退出码 1。/);

  const strict = runCli(['--dir', dir, '--strict']);
  assert.equal(strict.status, 1, strict.stdout);
  assert.match(strict.stdout, /FAIL：1 项不满足（coexist）；退出码 1。/);
});

test('夹具 4·rollback 形态错（同一号补第二份 .down.sql）⇒ 默认只 warn，--strict 才红', () => {
  const dir = makeFixture({
    forward: ['0100_initial_schema.sql', '0101_knowledge_catalog.sql'],
    rollback: [
      '0100_initial_schema.down.sql',
      '0101_knowledge_catalog.down.sql',
      '0101_knowledge_catalog_again.down.sql',
    ],
  });

  const { status, stdout } = runCli(['--dir', dir]);
  assert.equal(status, 0, stdout);
  assertIssueIds(stdout, ['coexist']);
  assert.match(stdout, /WARN\[coexist\]/);
  assert.match(stdout, /同一编号出现多份 \.down\.sql（1 个号）/);
  assert.match(stdout, /0101：0101_knowledge_catalog\.down\.sql、0101_knowledge_catalog_again\.down\.sql/);
  assert.match(stdout, /同号多份 1 处/);
  // 正向文件与它同名的 down 仍然是配对的（[rollback] 不该被这条形态连带误伤）。
  assert.doesNotMatch(stdout, /WARN\[rollback\]/);
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
  assertIssueIds(stdout, ['runner']);
  assert.match(stdout, /只有守卫看得见（运行器会抛「迁移文件名不合规」）：0101_Catalog\.sql/);
  assert.match(stdout, /守卫 2 条 ↔ 产品发现器 1 条：差集 1 条/);
  assert.doesNotMatch(stdout, /WARN\[rollback\]/);
});

test('夹具 6·空目录：扫到 0 条 ⇒ 退出码 1（反空转：全空不是全绿）', () => {
  const dir = makeFixture({});

  const { status, stdout } = runCli(['--dir', dir]);
  assert.equal(status, 1, stdout);
  assertIssueIds(stdout, ['surface']);
  assert.match(stdout, /扫描面为空/);
  assert.match(stdout, /按反空转口径直接红/);
  // 空扫描面时不再逐条报「登记过期」：那是同一个根因，只由 [surface] 说话。
  assert.doesNotMatch(stdout, /WARN\[rollback\]/);
});

test('夹具 7·顶层出现 .down.sql ⇒ 退出码 1，[surface] 点名（它永远不会被当回滚执行）', () => {
  const dir = makeFixture({
    forward: ['0100_initial_schema.sql', '0100_initial_schema.down.sql'],
    rollback: ['0100_initial_schema.down.sql'],
  });

  const { status, stdout } = runCli(['--dir', dir]);
  assert.equal(status, 1, stdout);
  assertIssueIds(stdout, ['surface']);
  assert.match(stdout, /顶层出现回滚文件（\.down\.sql 只属于 rollback\/）：0100_initial_schema\.down\.sql/);
  assert.match(stdout, /顶层 \.down\.sql 1 条/);
  assert.doesNotMatch(stdout, /WARN\[rollback\]/);
});

test('夹具 8·缺回滚且未登记 ⇒ 默认只 warn（退出码 0），--strict 才红', () => {
  const dir = makeFixture({ forward: ['0109_brand_new.sql'] });

  const { status, stdout } = runCli(['--dir', dir]);
  assert.equal(status, 0, stdout);
  assertIssueIds(stdout, ['rollback']);
  assert.match(stdout, /WARN\[rollback\]/);
  assert.match(stdout, /缺回滚且未登记为允许缺省（1 条）：0109_brand_new\.sql/);

  const strict = runCli(['--dir', dir, '--strict']);
  assert.equal(strict.status, 1, strict.stdout);
  assert.match(strict.stdout, /FAIL：1 项不满足（rollback）；退出码 1。/);
});

test('夹具 9·不合规命名（29_short_prefix.sql）⇒ 退出码 1；两侧都看不见它，故 [runner] 不红', () => {
  const dir = makeFixture({
    forward: ['0100_initial_schema.sql', '29_short_prefix.sql'],
    rollback: ['0100_initial_schema.down.sql'],
  });

  const { status, stdout } = runCli(['--dir', dir]);
  assert.equal(status, 1, stdout);
  assertIssueIds(stdout, ['surface']);
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
  assertIssueIds(stdout, ['surface']);
  assert.match(stdout, /找不到迁移目录/);
  assert.match(stdout, /假绿形态/);
});

test('夹具 11·rollback/ 缺失 ⇒ 默认只 warn（退出码 0），--strict 才红；不按「全都没有 down」放行', () => {
  const dir = makeFixture({
    forward: ['0100_initial_schema.sql', '0101_knowledge_catalog.sql'],
    noRollbackDir: true,
  });

  const { status, stdout } = runCli(['--dir', dir]);
  assert.equal(status, 0, stdout);
  assertIssueIds(stdout, ['rollback']);
  assert.match(stdout, /WARN\[rollback\]/);
  assert.match(stdout, /找不到回滚目录/);
  assert.match(stdout, /缺回滚且未登记为允许缺省（2 条）：0100_initial_schema\.sql、0101_knowledge_catalog\.sql/);

  const strict = runCli(['--dir', dir, '--strict']);
  assert.equal(strict.status, 1, strict.stdout);
  assert.match(strict.stdout, /FAIL：/);
});

test('夹具 12·孤儿回滚（有 down 无正向迁移）⇒ 默认只 warn，--strict 才红并点名该号', () => {
  const dir = makeFixture({
    forward: ['0100_initial_schema.sql'],
    rollback: ['0100_initial_schema.down.sql', '0199_ghost_table.down.sql'],
  });

  const { status, stdout } = runCli(['--dir', dir]);
  assert.equal(status, 0, stdout);
  assertIssueIds(stdout, ['rollback']);
  assert.match(stdout, /WARN\[rollback\]/);
  assert.match(stdout, /孤儿回滚（有 down 无正向迁移）：0199/);

  const strict = runCli(['--dir', dir, '--strict']);
  assert.equal(strict.status, 1, strict.stdout);
  assert.match(strict.stdout, /孤儿回滚（有 down 无正向迁移）：0199/);
});

// ---------------------------------------------------------------------------
// §2b 派单口径的三类夹具（合法连续 / 重复号 / 跳号）· JSON 契约与退出码
// ---------------------------------------------------------------------------

/**
 * 跑 `--json` 并解析。
 *
 * 断言「stdout 是**纯** JSON」本身就是判据：下游（别的门禁/看板）会直接 `JSON.parse`，
 * 一旦有人在 JSON 前后混一行读数，这份输出就废了，而退出码仍是 0 —— 那种坏法最难发现。
 */
function runJson(args) {
  const { status, stdout, stderr } = runCli(['--json', ...args]);
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    assert.fail(`--json 的 stdout 不是合法 JSON（退出码 ${status}）：\n${stdout}\n${stderr}`);
  }
  return { status, report, stdout };
}

test('JSON 夹具 A·合法连续：0100/0101/0102 各配同名 down ⇒ 退出码 0，duplicates=[]、gaps=[]', () => {
  const dir = makeFixture({
    forward: ['0100_a.sql', '0101_b.sql', '0102_c.sql'],
    rollback: ['0100_a.down.sql', '0101_b.down.sql', '0102_c.down.sql'],
  });

  const { status, report } = runJson(['--dir', dir]);
  assert.equal(status, 0);
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, 0);
  assert.equal(report.strict, false);
  assert.deepEqual(report.numbers, ['0100', '0101', '0102']);
  assert.deepEqual(report.duplicates, []);
  assert.deepEqual(report.gaps, []);
  assert.deepEqual(report.undocumentedGaps, []);
  assert.deepEqual(report.rollbackIssues, []);
  assert.deepEqual(report.errors, []);
  assert.equal(report.counts.forward, 3);
  assert.equal(report.counts.numbers, 3);
  assert.equal(report.counts.duplicates, 0);
  assert.equal(report.counts.gaps, 0);
  assert.equal(report.counts.paired, 3);
  assert.equal(report.counts.errors, 0);
});

test('JSON 夹具 B·重复号：0102 被两条正向文件占用（0028_* 事故的同构形态）⇒ 退出码 1', () => {
  const dir = makeFixture({
    forward: ['0101_x.sql', '0102_moderation_persistence.sql', '0102_governance_audit_log.sql'],
    rollback: [
      '0101_x.down.sql',
      '0102_moderation_persistence.down.sql',
      '0102_governance_audit_log.down.sql',
    ],
  });

  const { status, report } = runJson(['--dir', dir]);
  assert.equal(status, 1);
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 1);
  assert.equal(report.duplicates.length, 1, 'duplicates[] 必须逐号列出');
  assert.equal(report.duplicates[0].number, '0102');
  assert.deepEqual(report.duplicates[0].files, [
    '0102_governance_audit_log.sql',
    '0102_moderation_persistence.sql',
  ]);
  assert.equal(report.counts.duplicates, 1);
  assert.equal(report.counts.duplicateFiles, 2);
  assert.deepEqual(report.errors.map((failure) => failure.id), ['dup']);
  // 撞号的两份 down 同时踩 [coexist]，但它只 warn：硬红只由 [dup] 造成。
  assert.deepEqual(report.rollbackIssues.map((failure) => failure.id), ['coexist']);
  assert.match(report.rollbackIssues[0].message, /同一编号出现多份 \.down\.sql/);
});

test('JSON 夹具 C·跳号：0100/0101/0103 缺 0102 ⇒ 退出码 0（只 warn），gaps[] 标未登记', () => {
  const dir = makeFixture({
    forward: ['0100_a.sql', '0101_b.sql', '0103_d.sql'],
    rollback: ['0100_a.down.sql', '0101_b.down.sql', '0103_d.down.sql'],
  });

  const { status, report } = runJson(['--dir', dir]);
  assert.equal(status, 0, '缺号默认不判错');
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.gaps.map((gap) => gap.number), ['0102']);
  assert.equal(report.gaps[0].documented, false);
  assert.equal(report.gaps[0].evidence, null);
  assert.deepEqual(report.undocumentedGaps, ['0102']);
  assert.equal(report.counts.gaps, 1);
  assert.equal(report.counts.undocumentedGaps, 1);
  assert.deepEqual(report.docSources, []);
  assert.deepEqual(report.errors, []);

  // 同一棵树上加 --strict：同一条缺号升为退出码 1。
  const strict = runJson(['--dir', dir, '--strict']);
  assert.equal(strict.status, 1);
  assert.equal(strict.report.ok, false);
  assert.equal(strict.report.exitCode, 1);
  assert.equal(strict.report.strict, true);
});

test('JSON 夹具 C2·跳号有 README 依据：documented=true 且带文件名/行号，--strict 下仍绿', () => {
  const dir = makeFixture({
    forward: ['0100_a.sql', '0101_b.sql', '0103_d.sql', '0105_e.sql'],
    rollback: ['0100_a.down.sql', '0101_b.down.sql', '0103_d.down.sql', '0105_e.down.sql'],
  });
  writeFileSync(
    join(dir, 'README.md'),
    [
      '# 迁移编号守则',
      '',
      '- 0102 故意跳过：预留给 #434 的审计日志迁移（它自带 0028，不得在此重复占号）。',
      '- 0104 故意跳过：由备份片 r30-b 占用，本片不写。',
      '',
    ].join('\n'),
    'utf8',
  );

  const { status, report } = runJson(['--dir', dir, '--strict']);
  assert.equal(status, 0, '有依据的缺号即便 --strict 也不该红');
  assert.deepEqual(report.gaps.map((gap) => gap.number), ['0102', '0104']);
  assert.deepEqual(report.gaps.map((gap) => gap.documented), [true, true]);
  assert.deepEqual(report.undocumentedGaps, []);
  assert.equal(report.gaps[0].evidence.file, 'README.md');
  assert.equal(report.gaps[0].evidence.line, 3);
  assert.match(report.gaps[1].evidence.text, /0104 故意跳过/);
  assert.deepEqual(report.docSources, ['README.md']);
});

test('JSON 夹具 C3·「提到该号但没有跳过字样」不算依据（判据不能恒真）', () => {
  const dir = makeFixture({
    forward: ['0100_a.sql', '0102_c.sql'],
    rollback: ['0100_a.down.sql', '0102_c.down.sql'],
  });
  // 只是把它列在目录里、没说「跳过」—— 这正是最容易被误当依据的形态。
  writeFileSync(join(dir, 'README.md'), '# 迁移目录\n\n- 0100_a.sql 建初始表\n- 0102_c.sql 建目录表\n', 'utf8');

  const { report } = runJson(['--dir', dir]);
  assert.deepEqual(report.gaps.map((gap) => gap.number), ['0101']);
  assert.equal(report.gaps[0].documented, false);
  assert.deepEqual(report.undocumentedGaps, ['0101']);
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

test('真实仓·`--json` 的 duplicates[] 为空（这就是「当前无重复号」的机器判据）', () => {
  const { status, report } = runJson([]);
  assert.equal(status, 0);
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.duplicates, [], '当前仓不该有同号多文件');
  assert.deepEqual(report.errors, []);
  assert.equal(report.counts.duplicates, 0);
  assert.equal(report.counts.duplicateFiles, 0);
  // 编号清单必须与磁盘上的正向文件一一对应 —— 防「只扫到一部分还判绿」。
  const onDisk = readdirSync(DEFAULT_MIGRATIONS_DIR)
    .filter((name) => RUNNER_PATTERN.test(name))
    .sort();
  assert.ok(onDisk.length > 0, '扫描面不能为空');
  assert.equal(report.counts.forward, onDisk.length);
  assert.deepEqual(
    report.numbers,
    onDisk.map((name) => name.slice(0, 4)),
    'JSON 里的编号清单必须与磁盘上的正向文件逐个对齐',
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

test('清单·登记过期（该号已经有 down 还登记着）⇒ --strict 判红并点名；默认只 warn', () => {
  const dir = makeFixture({
    forward: ['0001_initial_schema.sql'],
    rollback: ['0001_initial_schema.down.sql'],
  });
  // 非 strict：回滚判据只 warn ⇒ 退出码仍是 0（2026-10-22 收窄口径）。
  const loose = verifyMigrations({ migrationsDir: dir, noRollback: NO_ROLLBACK });
  assert.equal(loose.ok, true);
  assert.deepEqual(loose.rollbackIssues.map((failure) => failure.id), ['rollback']);

  const result = verifyMigrations({ migrationsDir: dir, noRollback: NO_ROLLBACK, strict: true });
  assert.equal(result.ok, false);
  const rollbackFailures = result.failures.filter((failure) => failure.id === 'rollback');
  assert.equal(rollbackFailures.length, 1);
  assert.match(rollbackFailures[0].message, /NO_ROLLBACK 登记过期（1 条）/);
  assert.match(rollbackFailures[0].message, /0001：该号已有回滚/);
});

test('清单·登记理由过短（占位符）⇒ --strict 判红', () => {
  const dir = makeFixture({ forward: ['0001_initial_schema.sql'] });
  const result = verifyMigrations({
    migrationsDir: dir,
    noRollback: new Map([['0001', '无']]),
    strict: true,
  });
  assert.equal(result.ok, false);
  assert.match(
    result.failures.map((failure) => failure.message).join('\n'),
    /理由不足 20 字或为空（占位符不算登记）/,
  );
});
