/**
 * R28-S55 · 迁移 ↔ 回滚脚本一一对应守卫（静态）。
 *
 * 缺口：`services/api/db/migrations/` 的 26 个迁移与 `rollback/` 的 25 个 `.down.sql`，
 * 此前**没有任何测试断言二者按前缀配对**——新加迁移漏写 down 时 CI 全绿，直到真要回滚
 * 或演练才发现。既有 `tests/unit/release-materials-index.test.mjs:58-60` 只有
 * 「down 数 = 迁移数 − 1」的**数量**不变量：一缺一多（缺 0007 的 down、多一个孤儿 0099）
 * 数量仍相等，它抓不到；本文件按**前缀**逐条配对，并把 `0001` 的例外变成有理由、可过期的登记。
 *
 * 分层（沿用仓库「先纯函数、再读真实目录」的写法）：
 *   1. 纯函数 `checkPairing(migrationFiles, rollbackFiles, exemptions)`：不落盘、不连库；
 *   2. 内存夹具覆盖 6 类 + 「豁免理由为空」；
 *   3. 真实目录跑一次，断言 `ok === true` 且四个桶全空；
 *   4. 负控制：只改**内存里的列表/例外表**，证明守卫真的会红（不动任何真实文件）。
 *
 * 边界：本守卫只证明「文件名层面每个迁移恰有 1 份回滚」，**不执行** down 脚本、
 * 不判断其 SQL 语义能否跑通（0016/0026 的真执行由 `tests/integration/migrations-negative-pg.mjs`
 * 等真库脚本覆盖），也不覆盖 down 脚本内容与 up 是否互逆。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MIGRATIONS_DIR } from '../../services/api/src/db/migrate.ts';

/** 上迁移：`NNNN_name.sql`（与 `services/api/src/db/migrate.ts:44` 的发现模式同形）。 */
const UP_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;
/** 回滚：`NNNN_name.down.sql`，前缀与上迁移同号。 */
const DOWN_PATTERN = /^(\d{4})_[a-z0-9_]+\.down\.sql$/;

/**
 * 0001 的例外登记（本片唯一一条）。
 *
 * **可逆性判定为「结构可逆、语义不可逆」**，实测与依据见
 * `docs/verification/gy-r28-migration-rollback-pairing-20261021.md` §4：
 *
 *   - 0001 建 15 个枚举 + 20 张表（隔离 PG 17.11 实测 `CREATE TYPE` 15 / `CREATE TABLE` 20，
 *     21 条外键），不建 schema、不 `CREATE EXTENSION`（`gen_random_uuid()` 是 PG13+ 内建）；
 *   - 后续 25 条迁移**没有一条** `ALTER` 0001 的表（`grep "ALTER TABLE"` 24 处全落在
 *     0011/0012/0013/0015/0016 自己建的表上；唯一 `ALTER TABLE sources` 就在 0001 内部）；
 *     即 HEAD 上 0001 的对象集合与 0001 文件逐字对应，down 不需要「感知后续迁移」；
 *   - 所以结构上可以写出一份能跑通的 down（探针实测：先 `ALTER TABLE sources DROP CONSTRAINT
 *     sources_current_version_fk` 断开 0001 自身的 sources↔source_versions 引用环，再逆序
 *     `DROP TABLE` 20 张表、`DROP TYPE` 15 个枚举 ⇒ 退出码 0，`public` 表/枚举/外键均归零）；
 *   - 但把它当「回滚一步迁移」在语义上不成立：0001 是全库地板，0002..0026 全部建在它之上；
 *     仓库既有 down 一律**显式保留**这些对象（`rollback/0002_knowledge_catalog.down.sql:7-8`
 *     「共享字典表（crops/species/regions/sources/source_versions）由 0001 拥有，0002 未创建，
 *     本回滚**不删除**它们」；`rollback/0026_speech_persistence.down.sql` 头注「唯一的外键指向
 *     0001 的 users，回滚只删引用方」）。执行 0001 的 down 等于清空整库（连同 `db/seeds`
 *     字典数据与后续全部迁移的数据），字典数据的「回滚」在仓库里走的是数据层
 *     `db/seeds/rollback_seed.sql`（头注「只删本目录 seed 写入的行；共享表结构不动」）。
 *
 * 结论：作为迁移回滚**不可执行**（判定为不可逆，不补 down），本片登记为**永久豁免**；
 * 若将来需要「全清」，应另开片做成显式的 teardown（`DROP SCHEMA public CASCADE`/重建库），
 * 而不是在 0001 里伪装成可回滚的一步。⛔ 本片不新增、不改任何迁移或回滚文件。
 */
const EXEMPT = new Map([
  [
    '0001',
    '全库地板：建 20 表/15 枚举，0002..0026 全建其上且既有 down 一律显式保留其对象'
      + '（0002 down 头注「共享字典表由 0001 拥有…本回滚不删除」；0026 down「只删引用 0001 users 的引用方」）；'
      + '其 down 只等于清库（连 seeds 与后续数据），字典数据回滚走 db/seeds/rollback_seed.sql，'
      + '故作为「回滚一步」不可执行；可逆性判定见 docs/verification/gy-r28-migration-rollback-pairing-20261021.md §4',
  ],
]);

/**
 * 按前缀把文件名分组；不合约定的文件名进 `ignored`，由调用方决定是否容忍。
 * @param {string[]} files
 * @param {RegExp} pattern
 * @returns {{ groups: Map<string, string[]>, ignored: string[] }}
 */
function groupByPrefix(files, pattern) {
  const groups = new Map();
  const ignored = [];
  for (const filename of files) {
    const match = pattern.exec(filename);
    if (match === null) {
      ignored.push(filename);
      continue;
    }
    const prefix = match[1];
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(filename);
  }
  return { groups, ignored };
}

/**
 * 纯函数：校验「每个迁移前缀恰有 1 份回滚」，并校验例外表不过期。
 *
 * 规则：
 *   a. 每个迁移前缀恰有 1 个回滚文件（同前缀、以 `.down.sql` 结尾）；
 *   b. 缺回滚 ⇒ `missing`；有回滚无迁移 ⇒ `orphan`；同前缀多份回滚 ⇒ `duplicate`；
 *   c. 例外表里的前缀必须**真的缺回滚**且**有非空理由**，否则 ⇒ `staleExemptions`
 *      （防止「豁免一条已经补上回滚的迁移」或「豁免一条早被删掉的迁移」长期挂着）。
 *
 * 只接受文件名与例外表，不读盘、不连库；`ok` 为四个桶全空。
 *
 * @param {string[]} migrationFiles 上迁移文件名数组
 * @param {string[]} rollbackFiles 回滚文件名数组
 * @param {Map<string, string>} [exemptions] 例外表：前缀 → 一句可核证的理由
 * @returns {{
 *   missing: string[], orphan: string[], duplicate: string[], staleExemptions: string[],
 *   ok: boolean,
 *   details: {
 *     migrations: number, rollbacks: number, exemptions: number,
 *     pairs: Array<{ prefix: string, migration: string, rollback: string }>,
 *     exempted: Array<{ prefix: string, reason: string }>,
 *     duplicate: Array<{ prefix: string, files: string[] }>,
 *     duplicateMigrations: Array<{ prefix: string, files: string[] }>,
 *     ignoredMigrations: string[], ignoredRollbacks: string[],
 *   },
 * }}
 */
export function checkPairing(migrationFiles, rollbackFiles, exemptions = new Map()) {
  if (!Array.isArray(migrationFiles) || !Array.isArray(rollbackFiles)) {
    throw new TypeError('checkPairing 需要「迁移文件名数组」与「回滚文件名数组」');
  }
  if (!(exemptions instanceof Map)) {
    throw new TypeError('checkPairing 的例外表必须是 Map<前缀, 理由>');
  }

  const ups = groupByPrefix(migrationFiles, UP_PATTERN);
  const downs = groupByPrefix(rollbackFiles, DOWN_PATTERN);

  const missing = [];
  const duplicate = [];
  const orphan = [];
  const staleExemptions = [];
  const pairs = [];
  const exempted = [];

  // 规则 a/b：逐个迁移前缀数回滚份数。缺回滚时若已登记豁免，先不判红——
  // 豁免本身是否成立由下面的规则 c 单独判（理由为空/前缀已补回滚都算过期）。
  for (const prefix of [...ups.groups.keys()].sort()) {
    const downFiles = downs.groups.get(prefix) ?? [];
    if (downFiles.length === 1) {
      pairs.push({ prefix, migration: ups.groups.get(prefix)[0], rollback: downFiles[0] });
      continue;
    }
    if (downFiles.length > 1) {
      duplicate.push(prefix);
      continue;
    }
    if (!exemptions.has(prefix)) missing.push(prefix);
  }

  // 规则 b：有回滚无迁移。
  for (const prefix of [...downs.groups.keys()].sort()) {
    if (!ups.groups.has(prefix)) orphan.push(prefix);
  }

  // 规则 c：例外表只能覆盖「真的缺回滚」且「理由非空」的前缀。
  for (const [prefix, reason] of exemptions) {
    const downFiles = downs.groups.get(prefix) ?? [];
    const problems = [];
    if (!ups.groups.has(prefix)) problems.push('没有同名迁移（豁免了一条不存在的迁移）');
    if (downFiles.length > 0) problems.push(`回滚已存在（${[...downFiles].sort().join('、')}）`);
    if (typeof reason !== 'string' || reason.trim() === '') problems.push('豁免理由为空');
    if (problems.length > 0) {
      staleExemptions.push(prefix);
      continue;
    }
    exempted.push({ prefix, reason: reason.trim() });
  }
  staleExemptions.sort();

  const duplicateMigrations = [...ups.groups]
    .filter(([, files]) => files.length > 1)
    .map(([prefix, files]) => ({ prefix, files: [...files].sort() }));

  const details = {
    migrations: migrationFiles.length,
    rollbacks: rollbackFiles.length,
    exemptions: exemptions.size,
    pairs,
    exempted,
    duplicate: duplicate.map((prefix) => ({ prefix, files: [...downs.groups.get(prefix)].sort() })),
    duplicateMigrations,
    ignoredMigrations: ups.ignored,
    ignoredRollbacks: downs.ignored,
  };

  return {
    missing,
    orphan,
    duplicate,
    staleExemptions,
    ok: missing.length === 0 && orphan.length === 0 && duplicate.length === 0 && staleExemptions.length === 0,
    details,
  };
}

// ---------------------------------------------------------------------------
// 夹具：全部内存数组，不落盘（`mkdtemp` 都不用）。6 类 + 1 条「理由为空」。
// ---------------------------------------------------------------------------

test('夹具 1·正常配对：每个前缀一份回滚 ⇒ ok，四个桶全空', () => {
  const result = checkPairing(
    ['0001_init.sql', '0002_catalog.sql'],
    ['0001_init.down.sql', '0002_catalog.down.sql'],
    new Map(),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.orphan, []);
  assert.deepEqual(result.duplicate, []);
  assert.deepEqual(result.staleExemptions, []);
  // 0001 在这里有 down，守卫不应把它当「天然豁免」——豁免只来自例外表。
  assert.deepEqual(result.details.pairs.map((pair) => pair.prefix), ['0001', '0002']);
});

test('夹具 2·缺回滚：前缀无 down ⇒ missing 命中，且不误伤其它桶', () => {
  const result = checkPairing(
    ['0001_init.sql', '0002_catalog.sql', '0003_consent.sql'],
    ['0001_init.down.sql', '0003_consent.down.sql'],
    new Map(),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['0002']);
  assert.deepEqual(result.orphan, []);
  assert.deepEqual(result.duplicate, []);
  assert.deepEqual(result.staleExemptions, []);
});

test('夹具 3·孤儿回滚：有 down 无迁移 ⇒ orphan 命中，且不进 missing', () => {
  const result = checkPairing(['0001_init.sql'], ['0001_init.down.sql', '0009_ghost.down.sql'], new Map());
  assert.equal(result.ok, false);
  assert.deepEqual(result.orphan, ['0009']);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.duplicate, []);
  assert.deepEqual(result.staleExemptions, []);
});

test('夹具 4·重复回滚：同前缀两份 down ⇒ duplicate 命中，且不进 missing', () => {
  const result = checkPairing(
    ['0001_init.sql', '0002_catalog.sql'],
    ['0001_init.down.sql', '0002_catalog.down.sql', '0002_catalog_again.down.sql'],
    new Map(),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.duplicate, ['0002']);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.orphan, []);
  assert.deepEqual(result.staleExemptions, []);
  assert.deepEqual(result.details.duplicate, [
    { prefix: '0002', files: ['0002_catalog.down.sql', '0002_catalog_again.down.sql'] },
  ]);
});

test('夹具 5·有效豁免：真的缺回滚 + 非空理由 ⇒ 不判红，且记进 details.exempted', () => {
  const result = checkPairing(
    ['0001_init.sql', '0002_catalog.sql'],
    ['0002_catalog.down.sql'],
    new Map([['0001', '基线地板迁移，全库其余迁移都建在它之上']]),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.staleExemptions, []);
  assert.deepEqual(result.details.exempted, [{ prefix: '0001', reason: '基线地板迁移，全库其余迁移都建在它之上' }]);
});

test('夹具 6·过期豁免：迁移已补上回滚却仍登记豁免 ⇒ staleExemptions 命中', () => {
  const result = checkPairing(
    ['0001_init.sql', '0002_catalog.sql'],
    ['0001_init.down.sql', '0002_catalog.down.sql'],
    new Map([['0001', '这条豁免早该删掉：down 已经补上了']]),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.staleExemptions, ['0001']);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.duplicate, []);
  assert.deepEqual(result.orphan, []);
});

test('夹具 7·豁免理由为空（含纯空白）⇒ 判不合格，落 staleExemptions 而不是 missing', () => {
  const result = checkPairing(['0001_init.sql'], [], new Map([['0001', '   ']]));
  assert.equal(result.ok, false);
  assert.deepEqual(result.staleExemptions, ['0001']);
  assert.deepEqual(result.missing, [], '已登记豁免（哪怕理由为空）不应再计入 missing，否则同一问题被记两次');
});

// ---------------------------------------------------------------------------
// 真实目录：只读，用运行器自己的默认迁移目录，避免守卫与运行器看不同的文件夹。
// ---------------------------------------------------------------------------

/** 真实目录读数（只读）：上迁移目录 + 其 rollback/ 子目录。 */
function readRealDirs() {
  const listSql = (dir) => readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith('.sql'));

  const migrationFiles = listSql(DEFAULT_MIGRATIONS_DIR);
  const rollbackFiles = listSql(join(DEFAULT_MIGRATIONS_DIR, 'rollback'));
  return { migrationFiles, rollbackFiles };
}

test('真实目录·每个迁移恰有一份 rollback down，0001 以登记理由豁免 ⇒ ok', (t) => {
  const { migrationFiles, rollbackFiles } = readRealDirs();
  const result = checkPairing(migrationFiles, rollbackFiles, EXEMPT);

  const summary = `迁移 ${migrationFiles.length} 个 / 回滚 ${rollbackFiles.length} 个 / 豁免 ${EXEMPT.size} 个`;
  t.diagnostic(summary);
  console.log(`[pairing] ${summary}`);

  assert.deepEqual(
    result.details.ignoredMigrations,
    [],
    '迁移目录里的 .sql 必须全部合 NNNN_name.sql（不合规者会被守卫静默忽略，等于开了后门）',
  );
  assert.deepEqual(
    result.details.ignoredRollbacks,
    [],
    'rollback/ 里的 .sql 必须全部合 NNNN_name.down.sql（写错名字的 down 不算配对）',
  );
  assert.deepEqual(result.missing, [], `缺回滚的迁移前缀：${result.missing.join(', ') || '(无)'}`);
  assert.deepEqual(result.orphan, [], `没有同名迁移的孤儿回滚：${result.orphan.join(', ') || '(无)'}`);
  assert.deepEqual(result.duplicate, [], `同前缀多份回滚：${result.duplicate.join(', ') || '(无)'}`);
  assert.deepEqual(result.staleExemptions, [], `过期豁免：${result.staleExemptions.join(', ') || '(无)'}`);
  assert.equal(
    result.ok,
    true,
    `迁移与回滚必须一一对应。补救：新增迁移时同时写 rollback/NNNN_name.down.sql；确需例外时在 EXEMPT 登记并写\n`
      + `可核证的理由，同时更新 docs/verification/gy-r28-migration-rollback-pairing-20261021.md。当前读数：${summary}`,
  );

  // 例外表本片只登记 0001 这一条；新增豁免必须是**故意的**（改测试 + 改证据页），不允许悄悄长出来。
  assert.deepEqual([...EXEMPT.keys()], ['0001'], '本片只登记 0001 一条豁免；新增豁免需同时更新证据页');
  assert.ok(EXEMPT.get('0001').trim().length >= 20, '0001 的豁免理由必须是一句可核证的话，不是占位符');
  assert.deepEqual(result.details.exempted.map((entry) => entry.prefix), ['0001']);
});

// ---------------------------------------------------------------------------
// 负控制：只改**内存里的副本**，证明守卫对真实列表也会红。⛔ 不动任何真实文件。
// ---------------------------------------------------------------------------

test('负控制 1a·从真实**回滚**列表里删掉一个元素（内存）⇒ missing 命中该前缀（新增迁移忘写 down 的等价形态）', () => {
  const { migrationFiles, rollbackFiles } = readRealDirs();
  const victim = rollbackFiles.find((name) => !name.startsWith('0001_'));
  assert.ok(victim, '真实回滚列表里应有非 0001 的回滚');
  const dropped = rollbackFiles.filter((name) => name !== victim);

  const result = checkPairing(migrationFiles, dropped, EXEMPT);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, [victim.slice(0, 4)], `删掉 ${victim} 后该前缀应判缺回滚`);
  assert.deepEqual(result.orphan, []);
  assert.deepEqual(result.staleExemptions, []);
});

test('负控制 1b·从真实**迁移**列表里删掉一个元素（内存）⇒ 按规则 b 命中 orphan（不是 missing）', () => {
  // 派单 §2.3.5 原文写「删掉一个迁移元素 ⇒ missing 命中」，与 §2.1 规则 b
  //（缺回滚 ⇒ missing；有回滚无迁移 ⇒ orphan）互斥；这里按规则 b 实现并两向都测。
  const { migrationFiles, rollbackFiles } = readRealDirs();
  const victim = migrationFiles.find((name) => !name.startsWith('0001_'));
  assert.ok(victim, '真实迁移列表里应有非 0001 的迁移');
  const dropped = migrationFiles.filter((name) => name !== victim);

  const result = checkPairing(dropped, rollbackFiles, EXEMPT);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, [], '删的是「迁移」而不是「回滚」，missing 不该动');
  assert.deepEqual(result.orphan, [victim.slice(0, 4)], `删掉 ${victim} 后其 down 应变孤儿`);
});

test('负控制 2·把例外表换成空 Map（内存）⇒ missing 命中 0001', () => {
  const { migrationFiles, rollbackFiles } = readRealDirs();
  const result = checkPairing(migrationFiles, rollbackFiles, new Map());
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['0001'], '0001 确实是唯一缺 down 的迁移（豁免撤掉就该红）');
  assert.deepEqual(result.staleExemptions, []);
});

test('负控制 3·给 0001 在内存里补一个假回滚名 ⇒ staleExemptions 命中 0001', () => {
  const { migrationFiles, rollbackFiles } = readRealDirs();
  const invented = [...rollbackFiles, '0001_initial_schema.down.sql'];
  const result = checkPairing(migrationFiles, invented, EXEMPT);
  assert.equal(result.ok, false);
  assert.deepEqual(result.staleExemptions, ['0001'], '0001 一旦有了 down，豁免必须立刻过期');
  assert.deepEqual(result.missing, []);
  assert.equal(result.details.pairs.length, migrationFiles.length, '每个迁移（含 0001）此时都配上了');
});
