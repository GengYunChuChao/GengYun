/**
 * 迁移编号体检（保留号台账）的单测。
 *
 * 背景：#428（`feat/gy-r28-admin-audit-observability`）持有 `0027_admin_audit_observability.sql`，
 * 本片（PR #434）带 `0028_moderation_persistence.sql`。两支并行 ⇒ 本分支树上**必然**缺 `0027`。
 * 缺号本身不是问题，「发现器静默漏项」才是问题：迁移发现器只按文件名合规 + 版本不重复扫描，
 * 不校验连续性 ⇒ 真正的漏片（比如 `0019` 写坏了没被识别）会与「有意缺号」长得一模一样。
 *
 * 本片把这件人肉记忆变成机器判据（`services/api/db/migration-reservations.json` +
 * `inspectMigrationNumbering()`），三条不变量：
 *   ① `undeclaredGaps` 必须为空 —— 没登记的缺号照旧判红（发现器漏项仍被抓）；
 *   ② `count + 保留数 === maxVersion` —— 登记不能拿来掩盖漏片（少一个文件就恒不等）；
 *   ③ `reservedButPresent` 必须为空 —— 登记过的号一旦被上游补齐（#428 合入），条目必须立刻删，
 *      否则台账会变成「永远躺着的白名单」（这也是本片对 #428 合流后的强制清理动作）。
 *
 * 负控制（每一条都是「把判据反过来，必须红」）：缺声明必须红、躺平登记必须红、台账形状坏必须抛、
 * 白名单不能被 `discoverMigrations()` 当成迁移文件。
 *
 * **合流后状态（2026-10-22，#434 合流 `origin/main` = `d4d48088`）**：`0027_admin_audit_observability.sql`
 * 已随上游（#428）真实落进 `services/api/db/migrations/`，与 `0028_moderation_persistence.sql` 共存。
 * 按第 ③ 条不变量与 `remove_when`，台账里的 27 号条目**已删除**。
 *
 * **本片状态（2026-10-22，F13 行级作者注销引用 / 迁移 `0030_community_author_ref.sql`）**：
 * 迁移最大号变 0030，而 `0029_media_object_cleanup.sql` 仍只在 #419 分支上（未合入 `origin/main`）
 * ⇒ 树上唯一的缺号是**有意保留的 29**，台账因此不再是空表，而是恰好一条 29 号登记
 * （`owner: #419`，`remove_when: #419 合入即删`）。所以「当前仓库」那条用例的快照读数由
 * 「gaps=[] / reserved=[]」改为「gaps=[29] / reserved=[29]」，判据与负控制**一条未删**：
 * 三条不变量、四组负控制（①未声明缺号 ②躺平登记 ③多登记掩盖漏片 ④台账形状）与「躺平判据回归」全部保留；
 * 原「0027 合流预演」只是把台账来源换成夹具，断言逐字不动。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_MIGRATIONS_DIR,
  DEFAULT_RESERVATIONS_FILE,
  discoverMigrations,
  formatMigrationVersion,
  inspectMigrationNumbering,
  loadMigrationReservations,
} from '../../services/api/src/db/migrate.ts';

/** 造一个临时迁移目录（只有文件名合规才被 `discoverMigrations()` 看见）。 */
function makeMigrationsDir(names) {
  const dir = mkdtempSync(join(tmpdir(), 'gy-r29-reservations-migrations-'));
  for (const name of names) writeFileSync(join(dir, name), '-- fixture\n');
  return dir;
}

/** 造一个临时保留台账。 */
function makeReservationsFile(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'gy-r29-reservations-ledger-'));
  const file = join(dir, 'migration-reservations.json');
  writeFileSync(file, `${JSON.stringify({ reservations: entries }, null, 2)}\n`, 'utf8');
  return file;
}

/** 一条形状合法的保留登记（默认就是 #428 的 0027）。 */
function reservation(overrides = {}) {
  return {
    version: 27,
    filename: '0027_admin_audit_observability.sql',
    owner: 'PR #428（feat/gy-r28-admin-audit-observability）',
    reason: 'fixture',
    remove_when: 'fixture',
    ...overrides,
  };
}

test('迁移编号/当前仓库：0027 已随 origin/main 落盘；29 因 #419 在途显式保留、0030 落地后三条不变量仍成立', () => {
  const migrations = discoverMigrations();
  const reservations = loadMigrationReservations();
  const numbering = inspectMigrationNumbering(migrations, reservations);

  assert.equal(numbering.count, migrations.length);
  assert.equal(numbering.maxVersion, Math.max(...migrations.map((item) => Number(item.version))));
  assert.deepEqual(
    numbering.gaps,
    [29],
    `#419（0029_media_object_cleanup.sql）未合入 ⇒ 树上唯一的缺号是有意保留的 29（现场 ${JSON.stringify(numbering.gaps)}）`,
  );
  assert.deepEqual(numbering.reserved, [29], '29 号必须由台账显式声明为「有意空缺」，否则就是发现器静默漏项');
  assert.equal(reservations.length, 1, '当前台账必须恰好一条：29（#419 合入后按 remove_when 删除）');
  assert.equal(reservations[0].version, 29);
  assert.equal(reservations[0].filename, '0029_media_object_cleanup.sql');
  assert.deepEqual(numbering.undeclaredGaps, [], '未声明的缺号必须为空（否则就是发现器静默漏项）');
  assert.deepEqual(numbering.reservedButPresent, [], '登记过的号一旦变成真实文件，条目必须立刻删（防躺平）');
  assert.equal(
    numbering.countMatchesMax,
    true,
    `count(${numbering.count}) + 保留(${numbering.reserved.length}) 必须 === max(${numbering.maxVersion})`,
  );
  assert.equal(
    numbering.count,
    numbering.maxVersion - numbering.reserved.length,
    '同一事实的第二种写法：文件数 = 最大版本号 − 保留号数',
  );

  const files = migrations.map((item) => item.filename);
  assert.equal(
    files.includes('0027_admin_audit_observability.sql'),
    true,
    '0027 已随 origin/main（#428）落盘：保留条目按 remove_when 删除，没有留下「已补齐」的登记',
  );
  assert.ok(files.includes('0028_moderation_persistence.sql'), '0028 必须在清单里（迁移号固定，⛔ 不许换号）');
  assert.equal(
    files.includes('0029_media_object_cleanup.sql'),
    false,
    '29 号在本分支必须是**空缺**：#419 未合入前若出现该文件，reservedButPresent 会立刻判红',
  );
  assert.ok(
    files.includes('0030_community_author_ref.sql'),
    '本片（F13 行级作者注销引用）必须落在 0030，⛔ 不许占用 0028/0029',
  );
  assert.ok(
    reservations.every((item) => item.filename.startsWith(`${formatMigrationVersion(item.version)}_`)),
    '台账的 filename 前缀必须与 version 一致（防止「登记 29 却写成 0030_…」这种自欺）',
  );
});

test('迁移编号/台账文件位置：不落在 migrations 目录里（否则会被当成迁移清单的一部分）', () => {
  const inMigrations = readdirSync(DEFAULT_MIGRATIONS_DIR);
  assert.equal(
    inMigrations.includes('migration-reservations.json'),
    false,
    '台账必须放在 services/api/db/ 下，⛔ 不进 migrations/（发现器与发行材料索引都按目录扫）',
  );
  const discovered = discoverMigrations(DEFAULT_MIGRATIONS_DIR).map((item) => item.filename);
  assert.equal(
    discovered.some((name) => name.includes('migration-reservations')),
    false,
    'discoverMigrations() 不得把台账当成迁移文件',
  );
  assert.match(
    DEFAULT_RESERVATIONS_FILE,
    /db[\\/]migration-reservations\.json$/u,
    `台账默认路径必须指向 services/api/db/migration-reservations.json（现场 ${DEFAULT_RESERVATIONS_FILE}）`,
  );
});

test('迁移编号/负控制①：缺号未声明 ⇒ undeclaredGaps 非空且 count 对不上 max（必须红）', () => {
  const dir = makeMigrationsDir(['0001_a.sql', '0002_b.sql', '0004_c.sql']);
  try {
    const numbering = inspectMigrationNumbering(discoverMigrations(dir), []);
    assert.deepEqual(numbering.gaps, [3], '003 是缺号');
    assert.deepEqual(numbering.undeclaredGaps, [3], '没登记过的缺号必须判红（这就是发现器漏项的样子）');
    assert.deepEqual(numbering.reserved, []);
    assert.equal(numbering.countMatchesMax, false, '3 个文件 + 0 保留 ≠ max 4 ⇒ 必须判红');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('迁移编号/负控制②：登记过的号已经有了文件 ⇒ reservedButPresent 非空（必须红，#428 合流后强制清理）', () => {
  const dir = makeMigrationsDir(['0001_a.sql', '0002_b.sql', '0003_c.sql']);
  try {
    const file = makeReservationsFile([reservation({ version: 3, filename: '0003_c.sql' })]);
    try {
      const numbering = inspectMigrationNumbering(discoverMigrations(dir), loadMigrationReservations(file));
      assert.deepEqual(numbering.gaps, []);
      assert.deepEqual(numbering.reservedButPresent, [3], '台账声明 003 但文件已在 ⇒ 条目该删了（防躺平）');
      assert.equal(numbering.countMatchesMax, false, '3 + 1 ≠ 3 ⇒ count 判据同时变红');
    } finally {
      rmSync(join(file, '..'), { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('迁移编号/负控制③：声明了不存在的「保留号」但总数对不上 ⇒ 不能靠多登记掩盖漏片', () => {
  const dir = makeMigrationsDir(['0001_a.sql', '0002_b.sql', '0004_c.sql']);
  try {
    // 004 存在、003 缺；把 003 登记成保留号（合法）同时多登记一个 009（不存在也无文件）
    const file = makeReservationsFile([
      reservation({ version: 3, filename: '0003_c.sql' }),
      reservation({ version: 9, filename: '0009_d.sql' }),
    ]);
    try {
      const numbering = inspectMigrationNumbering(discoverMigrations(dir), loadMigrationReservations(file));
      assert.deepEqual(numbering.undeclaredGaps, [], '003 已登记 ⇒ 不算未声明缺号');
      assert.deepEqual(numbering.reserved, [3, 9]);
      assert.equal(numbering.count, 3);
      assert.equal(numbering.maxVersion, 4, 'maxVersion 只看真实文件，⛔ 不被台账抬高');
      assert.equal(numbering.countMatchesMax, false, '3 + 2 ≠ 4 ⇒ 多登记的保留号会立刻把总数判据弄红');
    } finally {
      rmSync(join(file, '..'), { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('迁移编号/负控制④：台账形状坏了必须抛错（⛔ 不静默当成空表）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gy-r29-reservations-bad-'));
  const write = (name, payload) => {
    const file = join(dir, name);
    writeFileSync(file, payload, 'utf8');
    return file;
  };
  try {
    const noArray = write('no-array.json', JSON.stringify({ reservations: 'nope' }));
    assert.throws(() => loadMigrationReservations(noArray), /缺少 reservations 数组/u);

    const badVersion = write('bad-version.json', JSON.stringify({ reservations: [reservation({ version: 0 })] }));
    assert.throws(() => loadMigrationReservations(badVersion), /version 必须是正整数/u);

    const notInteger = write('float-version.json', JSON.stringify({ reservations: [reservation({ version: 27.5 })] }));
    assert.throws(() => loadMigrationReservations(notInteger), /version 必须是正整数/u);

    const missingField = write(
      'missing-field.json',
      JSON.stringify({ reservations: [{ version: 27, filename: '0027_x.sql', owner: 'o', reason: 'r' }] }),
    );
    assert.throws(() => loadMigrationReservations(missingField), /缺 remove_when/u);

    const emptyField = write('empty-field.json', JSON.stringify({ reservations: [reservation({ owner: '' })] }));
    assert.throws(() => loadMigrationReservations(emptyField), /缺 owner/u);

    const duplicated = write(
      'duplicated.json',
      JSON.stringify({ reservations: [reservation(), reservation({ filename: '0027_other.sql' })] }),
    );
    assert.throws(() => loadMigrationReservations(duplicated), /重复登记版本号/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('迁移编号/躺平判据回归：0027 已在真实目录里 + 台账仍登记 27 ⇒ 立即判红并点名 0027', () => {
  // 本用例模拟 **#434 合流那一时刻**的目录（0028 为末项、1..28 连续）。
  // 后续片（0030 / F13 行级作者引用）刻意不纳入：它会让 29 成为「有意缺号」，
  // 而这条用例判的是「补齐后仍登记 ⇒ 判红」的机制，不是当前树的缺号快照
  // （当前树用 29 号保留台账，由上面「当前仓库」那条守护）。
  const realNames = readdirSync(DEFAULT_MIGRATIONS_DIR)
    .filter((name) => /^\d{4,}_[a-z0-9_]+\.sql$/.test(name))
    .filter((name) => Number(name.slice(0, 4)) <= 28);
  const dir = makeMigrationsDir([...realNames, '0027_admin_audit_observability.sql']);
  // 真实台账按 #419 在途登记的 29 与这条负控制无关：判的是**机制还咬不咬人**，
  // 不是当前台账内容（台账内容由上面「当前仓库」那条守护）。
  const ledger = makeReservationsFile([reservation()]);
  try {
    const numbering = inspectMigrationNumbering(discoverMigrations(dir), loadMigrationReservations(ledger));
    assert.deepEqual(numbering.gaps, [], '0027 补齐后不应再有缺号');
    assert.deepEqual(numbering.reservedButPresent, [27], '0027 补齐后保留登记必须被判「躺平」并点名');
    assert.equal(numbering.countMatchesMax, false, `${numbering.count} + 1 ≠ ${numbering.maxVersion} ⇒ 必须红`);
    assert.equal(
      discoverMigrations(dir).map((item) => Number(item.version)).includes(27),
      true,
      '合流预演里 0027 必须被真正发现（否则这条负控制就是空的）',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(ledger, '..'), { recursive: true, force: true });
  }
});

test('迁移编号/formatMigrationVersion：补齐 4 位，且与清单文件名前缀一致', () => {
  assert.equal(formatMigrationVersion(1), '0001');
  assert.equal(formatMigrationVersion(7), '0007');
  assert.equal(formatMigrationVersion(27), '0027');
  assert.equal(formatMigrationVersion(28), '0028');
  const migrations = discoverMigrations();
  for (const migration of migrations) {
    assert.ok(
      migration.filename.startsWith(`${formatMigrationVersion(Number(migration.version))}_`),
      `${migration.filename} 的版本号与 formatMigrationVersion 不一致`,
    );
  }
});
