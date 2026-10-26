/**
 * 迁移「末项钉」一致性（纯静态：只读文件文本，不连库）。
 *
 * 为什么需要这个文件：本仓每新增一个迁移，有三条 integration 断言必须同步 bump 右侧字面量，
 * 否则只有真库 job 才会红。#589（0043）、#612（0044）、#630（0045）都为「忘了 bump」红过一轮。
 * 那三条断言要连真库才跑得到，代价是「推上去才发现」。这里把同一件事提前到 unit：
 *   - 三条钉的右值必须 **等于** `services/api/db/migrations` 的当前最大号；
 *   - `tests/unit/migration-reservations.test.mjs` 的登记数字（文件数 / 保留数 / 总数）必须等于目录读数；
 *   - rollback 条数与配对（缺 down 的只有基线地板 `0001`）。
 *
 * 三条钉的真实形态（读盘确认；行号由本文件运行时算出 —— ⛔ 本文件里不写死 `文件:行`，
 * 那会被 `tests/unit/test-line-anchors-guard.test.mjs` 判红）：
 *   1. `tests/integration/moderation-ledger-pg.mjs`
 *      `assert.equal(formatMigrationVersion(numbering.maxVersion), '0045', …)`
 *      左值由 `discoverMigrations()`（迁移目录副本）算出 ⇒ 右侧就是「合流树末项」。
 *   2. `tests/integration/admin-scopes-authority-pg.mjs`
 *      `assert.equal(applied.rows[0].version, '0045', …)`
 *      `applied` = `SELECT version FROM public.schema_migrations ORDER BY version DESC LIMIT 1`
 *      （先跑生产路径 `migrate.ts up`）⇒ 右侧就是「真库末项」= 目录最大号。
 *   3. `tests/integration/admin-audit-logs-pg.mjs`
 *      `assert.equal(applied.rows[0].version, '0045', …)` —— 同上（真库末项）。
 *
 * 候选字面量逐个判过用途，只有上面三处是末项（⛔ 下面这些**不是**，别顺手改）：
 *   - `moderation-ledger-pg.mjs` 的 `MIGRATION = '0028_…sql'`：本臂自己的片子，塞进临时目录副本
 *     验证「0027/0028 共存」；`RESERVED_FILENAME = '0027_…sql'`：验证「保留号一旦出现就判躺平」。
 *     两者都是文件名夹具，与「末项」无关。
 *   - `moderation-ledger-pg.mjs` 的 `deepEqual(…reservedButPresent…, ['0027'])`：期望被判红的保留号。
 *   - `admin-audit-logs-pg.mjs` 的 `item.id.startsWith('0044')`：`'0044'` 是夹具 UUID
 *     `00444444-4444-4444-8444-444444444444` 的前缀（同族还有 `00111111…`／`00222222…`／`00333333…`）。
 *     这是最容易被误当迁移号的一处 —— 它是 UUID 前缀，改它等于改夹具数据，与末项无关。
 *   - `admin-audit-logs-pg.mjs` 注释里的 `'0033'`：演进史（曾钉 0033，迁移推到 0044 后陈旧 11 号），
 *     是教训记录而不是在岗断言。
 *   - `admin-scopes-authority-pg.mjs` 的 `'0041 …'`：CHECK 断言（比较 `n === 1`）的失败文案。
 *
 * `tests/unit/migration-pin-guard.test.mjs` 只扫 `tests/integration/*.mjs`，本文件不受它约束；
 * 但仍刻意避开它判红的形态（不取「目录末项再比」），而是「目录读数 vs 已固化字面量」对撞。
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** 仓库根（本文件在 `tests/unit/` 下，往上两级）。 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MIGRATIONS_DIR = join(REPO_ROOT, 'services', 'api', 'db', 'migrations');
const ROLLBACK_DIR = join(MIGRATIONS_DIR, 'rollback');
const RESERVATIONS_TEST = 'tests/unit/migration-reservations.test.mjs';
const RESERVATIONS_LEDGER = 'services/api/db/migration-reservations.json';
/** 唯一豁免 down 的正向迁移：基线地板迁移（与 `migrations-rollback-pairing.test.mjs` 的 EXEMPT 同源）。 */
const ROLLBACK_EXEMPT = ['0001'];

/**
 * 三条末项钉的定位规则。
 *
 * `pattern` 必须**带语境**且在本文件里唯一命中（裸 `'00xx'` 形态会撞上别的断言），
 * 并带 `d` flag 以便用 `match.indices` 现算字面量所在行号。
 */
const PIN_SPECS = [
  {
    file: 'tests/integration/moderation-ledger-pg.mjs',
    role: '合流树末项（对侧 = formatMigrationVersion(numbering.maxVersion)）',
    pattern: /assert\.equal\(\s*formatMigrationVersion\(numbering\.maxVersion\)\s*,\s*'(\d{4})'/gd,
  },
  {
    file: 'tests/integration/admin-scopes-authority-pg.mjs',
    role: '真库末项（对侧 = schema_migrations 降序首行 version）',
    pattern: /assert\.equal\(\s*applied\.rows\[0\]\.version\s*,\s*'(\d{4})'/gd,
  },
  {
    file: 'tests/integration/admin-audit-logs-pg.mjs',
    role: '真库末项（对侧 = schema_migrations 降序首行 version）',
    pattern: /assert\.equal\(\s*applied\.rows\[0\]\.version\s*,\s*'(\d{4})'/gd,
  },
];

/**
 * 同文件里「看起来像迁移号、但不是末项钉」的候选字面量登记表。
 *
 * 作用是防止下一个人（或下一次重构）把候选当末项改：本文件逐条断言它们**仍在**、
 * 值仍是登记值、且所在行**不是**该文件的末项钉行 —— 即定位是选择性的，不是「文件里唯一一个 00xx」。
 */
const NON_PIN_SPECS = [
  {
    file: 'tests/integration/moderation-ledger-pg.mjs',
    pattern: /const MIGRATION = '(\d{4})_/gd,
    expected: '0028',
    role: '本臂片子的迁移文件名夹具（0028_moderation_persistence.sql），与末项无关',
  },
  {
    file: 'tests/integration/moderation-ledger-pg.mjs',
    pattern: /const RESERVED_FILENAME = '(\d{4})_/gd,
    expected: '0027',
    role: '保留号文件名夹具（0027_admin_audit_observability.sql，#428 的片子），与末项无关',
  },
  {
    file: 'tests/integration/admin-audit-logs-pg.mjs',
    pattern: /item\.id\.startsWith\('(\d{4})'\)/gd,
    expected: '0044',
    role: "夹具 UUID 前缀（'00444444-4444-4444-8444-444444444444'），⛔ 不是迁移号",
  },
];

/** 4 位字符串形态的版本号。 */
function formatVersion(value) {
  return String(value).padStart(4, '0');
}

/** 目录下的普通文件名（不递归）。 */
function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

/** 把文件名拆成 4 位版本号；不合 `<4 位数字>_` 前缀的文件记进 `unrecognized`，不许静默跳过。 */
function splitVersions(names) {
  const versions = [];
  const unrecognized = [];
  for (const name of [...names].sort()) {
    const match = /^(\d{4})_/.exec(name);
    if (match === null) unrecognized.push(name);
    else versions.push(match[1]);
  }
  return { versions, unrecognized };
}

/** 迁移目录读数的唯一入口（测试与判别力自证共用同一份）。 */
function scanMigrations() {
  const forward = splitVersions(listFiles(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')));
  const rollback = splitVersions(listFiles(ROLLBACK_DIR).filter((name) => name.endsWith('.down.sql')));
  assert.ok(forward.versions.length > 0, '迁移目录里必须至少有一个正向迁移');
  const maxVersion = formatVersion(Math.max(...forward.versions.map(Number)));
  return { forward, rollback, maxVersion };
}

function readRepoFile(relativePath) {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

/** 字面量在文件里的 1-based 行号。 */
function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

/** 定位三条末项钉：每个文件必须**恰好一处**命中，多一处说明断言形态变了，定位正则要跟着改。 */
function locatePins() {
  return PIN_SPECS.map((spec) => {
    const text = readRepoFile(spec.file);
    const hits = [...text.matchAll(spec.pattern)];
    assert.equal(
      hits.length,
      1,
      `${spec.file} 里「${spec.role}」的末项钉必须恰好 1 处（现场 ${hits.length} 处）——多于 1 处说明该文件的断言形态变了，本文件的定位正则要跟着改`,
    );
    const [hit] = hits;
    return { file: spec.file, line: lineAt(text, hit.indices[1][0]), actual: hit[1], role: spec.role };
  });
}

/** 已钉值 vs 给定最大号的差集；返回结构化问题清单，交给 `assert.deepEqual` 精确判定。 */
function pinMismatches(pins, maxVersion) {
  return pins
    .filter((pin) => pin.actual !== maxVersion)
    .map((pin) => ({ file: pin.file, line: pin.line, role: pin.role, expected: maxVersion, actual: pin.actual }));
}

/** 单条问题：`文件:行 + 期望/实际`。文件名与行号都是运行时算出来的（⛔ 不写死）。 */
function formatPinProblem(problem) {
  return `✗ ${problem.file}:${problem.line}（${problem.role}）末项钉 = '${problem.actual}'，期望 '${problem.expected}'（= services/api/db/migrations 当前最大迁移号）——新增迁移后必须同步 bump 这条钉`;
}

function formatPinReport(problems) {
  return `${problems.length} 条末项钉没跟上迁移目录最大号：\n${problems.map(formatPinProblem).join('\n')}`;
}

function readLedger() {
  const ledger = JSON.parse(readRepoFile(RESERVATIONS_LEDGER));
  assert.ok(Array.isArray(ledger.reservations), `${RESERVATIONS_LEDGER} 的 reservations 必须是数组`);
  return ledger;
}

test('三条 integration 末项钉各恰好一处，且形态是 4 位字符串', () => {
  const pins = locatePins();
  assert.deepEqual(
    pins.map((pin) => pin.file),
    PIN_SPECS.map((spec) => spec.file),
    '三条钉必须覆盖 moderation-ledger / admin-scopes-authority / admin-audit-logs 三个文件',
  );
  assert.deepEqual(
    pins.map((pin) => pin.actual.length),
    [4, 4, 4],
    `三条钉的右值必须是 4 位版本号字符串（现场 ${JSON.stringify(pins.map((pin) => pin.actual))}）`,
  );
  assert.deepEqual(
    pins.map((pin) => pin.line > 0),
    [true, true, true],
    '三条钉都必须能算出所在行号（否则失败信息里给不出 文件:行）',
  );
});

test('候选字面量逐个判定：末项钉之外的 00xx 不是末项（防误改）', () => {
  const pins = locatePins();
  const located = NON_PIN_SPECS.map((spec) => {
    const text = readRepoFile(spec.file);
    const hits = [...text.matchAll(spec.pattern)];
    assert.equal(hits.length, 1, `${spec.file} 里候选 ${spec.expected} 必须恰好 1 处（现场 ${hits.length} 处）`);
    const [hit] = hits;
    return { file: spec.file, line: lineAt(text, hit.indices[1][0]), actual: hit[1], spec };
  });

  for (const item of located) {
    assert.deepEqual(
      item.actual,
      item.spec.expected,
      `${item.file}:${item.line} 的候选字面量语义是「${item.spec.role}」，登记值应为 ${item.spec.expected}（现场 ${item.actual}）`,
    );
    const pin = pins.find((candidate) => candidate.file === item.file);
    assert.notEqual(
      item.line,
      pin.line,
      `${item.file}:${item.line} 是「${item.spec.role}」，⛔ 不是末项钉（末项钉在 ${pin.line} 行）——不要把候选当末项改`,
    );
    assert.notEqual(item.actual, pin.actual, `${item.file} 的候选 ${item.actual} 与末项钉 ${pin.actual} 必须是两个不同的字面量`);
  }
});

test('三条末项钉等于 migration 目录的最大号', () => {
  const pins = locatePins();
  const { maxVersion } = scanMigrations();
  const problems = pinMismatches(pins, maxVersion);
  assert.deepEqual(problems, [], formatPinReport(problems));
});

test('判别力自证：目录读数推进一号（模拟加 0046 而不 bump 三条钉）⇒ 三条钉全红且指名 文件:行', () => {
  const pins = locatePins();
  const { maxVersion } = scanMigrations();
  const bumped = formatVersion(Number(maxVersion) + 1);
  const problems = pinMismatches(pins, bumped);
  assert.deepEqual(
    problems,
    pins.map((pin) => ({ file: pin.file, line: pin.line, role: pin.role, expected: bumped, actual: maxVersion })),
    `把目录读数换成 ${bumped} 后，三条钉必须全部判红（现场 ${problems.length} 条）——否则本文件对「忘了 bump」没有判别力`,
  );
  const report = problems.map(formatPinProblem).join('\n');
  assert.deepEqual(report.split('\n').length, 3, `失败报告必须一行一条钉、共 3 行（现场 ${JSON.stringify(report)}）`);
  assert.deepEqual(
    problems.map((item) => item.expected === bumped && item.actual === maxVersion),
    [true, true, true],
    '每条问题都必须同时给出期望值（目录最大号）与实际值（钉上的字面量）',
  );
});

test('migration-reservations 的登记数字（文件数 / 保留数 / 总数）等于目录读数', () => {
  const text = readRepoFile(RESERVATIONS_TEST);
  const hits = [...text.matchAll(/(\d+) 文件 \+ (\d+) 保留 === (\d+)/g)];
  assert.equal(
    hits.length,
    1,
    `${RESERVATIONS_TEST} 里的登记数字必须恰好 1 处（形态「N 文件 + M 保留 === T」；现场 ${hits.length} 处）`,
  );
  const registered = { files: Number(hits[0][1]), reserved: Number(hits[0][2]), total: Number(hits[0][3]) };
  const { forward, maxVersion } = scanMigrations();
  const ledger = readLedger();

  assert.deepEqual(
    registered.files,
    forward.versions.length,
    `登记的正向迁移条数必须等于 ${MIGRATIONS_DIR} 的实际文件数（登记 ${registered.files} / 实际 ${forward.versions.length}）——新增迁移后要 bump 这行登记`,
  );
  assert.deepEqual(
    registered.reserved,
    ledger.reservations.length,
    `登记的保留条数必须等于 ${RESERVATIONS_LEDGER} 的 reservations 长度（登记 ${registered.reserved} / 实际 ${ledger.reservations.length}）`,
  );
  assert.deepEqual(
    registered.total,
    Number(maxVersion),
    `登记的总数必须等于迁移目录最大号（登记 ${registered.total} / 实际 ${Number(maxVersion)}）`,
  );
  assert.deepEqual(
    registered.files + registered.reserved,
    registered.total,
    `登记本身必须自洽：文件数 ${registered.files} + 保留数 ${registered.reserved} 必须 === 总数 ${registered.total}`,
  );
});

test('rollback 条数与配对：缺 down 的只有基线地板 0001', () => {
  const { forward, rollback, maxVersion } = scanMigrations();
  assert.deepEqual(forward.unrecognized, [], 'migrations/ 下的 *.sql 必须全部是 `<4 位数字>_…` 文件名');
  assert.deepEqual(rollback.unrecognized, [], 'rollback/ 下的 *.down.sql 必须全部是 `<4 位数字>_…` 文件名');
  assert.deepEqual(maxVersion.length, 4, `最大号必须是 4 位字符串（现场 ${maxVersion}）`);

  const missingDown = forward.versions.filter((version) => !rollback.versions.includes(version));
  assert.deepEqual(
    missingDown,
    ROLLBACK_EXEMPT,
    `缺 down 的正向迁移必须只有 ${JSON.stringify(ROLLBACK_EXEMPT)}（现场 ${JSON.stringify(missingDown)}）——新迁移要带同名 .down.sql`,
  );
  const orphans = rollback.versions.filter((version) => !forward.versions.includes(version));
  assert.deepEqual(orphans, [], `rollback/ 里不得有正向目录不存在的号（孤儿回滚件，现场 ${JSON.stringify(orphans)}）`);
  assert.deepEqual(
    rollback.versions.length,
    forward.versions.length - ROLLBACK_EXEMPT.length,
    `rollback 条数 ${rollback.versions.length} 必须 = 正向 ${forward.versions.length} − 豁免 ${ROLLBACK_EXEMPT.length}`,
  );
});
