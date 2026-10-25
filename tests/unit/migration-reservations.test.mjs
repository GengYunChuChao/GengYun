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
 * 落 0030 时 `0029_media_object_cleanup.sql` 仍只在 #419 分支上 ⇒ 台账登记过一条 29 号
 * （`owner: #419`，`remove_when: #419 合入即删`），「当前仓库」用例的快照读数当时是 `gaps=[29] / reserved=[29]`。
 *
 * **合流后状态（2026-10-22 最后一轮，`origin/main` = `056cf424`，#419／#484／#485／#486 入 main）**：
 * `0029_media_object_cleanup.sql` 已真实落盘、`0030` 在其后 ⇒ `0001..0030` **连续无缺号**；
 * 29 号条目按它自己的 `remove_when` **删除**，台账回到 `reservations: []`，
 * 快照读数恢复为 `gaps=[] / reserved=[]`。判据与负控制**一条未删**：
 * 三条不变量、四组负控制（①未声明缺号 ②躺平登记 ③多登记掩盖漏片 ④台账形状）与「躺平判据回归」全部保留
 * （后者仍用夹具台账把 27 号喂进去，断言逐字不动）。
 *
 * **R32（2026-10-23，#15 在 #483 之后的去身份残留 / 迁移 `0032_community_report_reporter_ref.sql`）**：
 * 裁定 `.pg17/ruling-r32-migration-0031-allocation.md` 把 **31 锁给 #19**，本片只许用 32
 * ⇒ **本片单独在树上时**出现过「有依据的缺号」：`gaps=[31] / reserved=[31]`、`maxVersion=32`、
 * 31 个文件 + 1 保留 === 32（三条不变量当时全部成立）。这也是本台账存在的原始用途
 * （跨 PR 缺号），⛔ 不是为了让判据放行而新加的白名单：缺 31 但**没登记**，`undeclaredGaps`
 * 仍然会判红 —— 负控制①逐字不动地证明了这一点。
 *
 * **合流后状态（2026-10-23，先合 #494 的 `0031_online_purge_evidence.sql`、再合本片）**：
 * `0001..0032` **连续无缺号**、`gaps=[] / reserved=[]`、`maxVersion=0032`、32 个文件 + 0 保留 === 32
 * （R34/#525 的 `0033_admin_audit_log_read.sql` 落盘后，同一判据的当前读数推进为
 * `0001..0033`／`maxVersion=0033`／33 个文件 + 0 保留 === 33；判据本身与下面三条不变量一字未改）；
 * 31 号条目按它自己的 `remove_when` **删除**（0031 已真实落盘，留着会让 `reservedButPresent` 判红）。
 * 「当前仓库」用例同时把真实 0031 文件的存在性期望**翻成 `true`** —— 那条断言原来期望 `false`，
 * 0031 一落盘它就该变红；继续写 `false` 就是假通过，方向必须与「已落盘」的事实一致。
 *
 * **R34-I19（2026-10-23，本片撞号后让号：0033 → `0034_r34_owner_content_purge.sql`）**：
 * 本片原取 0033，与并行分支 #525（`feat/gy-admin-audit-query`）的 `0033_admin_audit_log_read.sql`
 * 撞号。裁定**保留 #525 的 0033**（更早成形、且不动本片这套跨文件 canary）⇒ 本片整体改 0034，
 * 树上因此出现「有依据的缺号」：`gaps=[33] / reserved=[33]`、`maxVersion=0034`、
 * 33 个文件 + 1 保留 === 34（三条不变量全部成立）。0033 的台账条目 `owner: #525`，
 * `remove_when: #525 合入即删` —— #525 一落盘 `reservedButPresent` 就会把它判红。
 * 这与 R32 那次（`gaps=[31] / reserved=[31]`）是同一种形态：本台账存在的原始用途就是跨 PR 缺号，
 * ⛔ 不是为了让判据放行而加的白名单；负控制①仍逐字证明「缺 33 但不登记 ⇒ 判红」。
 *
 * **合流后状态（2026-10-24，#525 已合入 `origin/main` = `4b87e1d9`）**：
 * `0033_admin_audit_log_read.sql` 真实落盘 ⇒ 33 号条目按它自己的 `remove_when` **删除**，台账回到
 * `reservations: []`；`0001..0034` **连续无缺号** ⇒ 快照读数为 `gaps=[] / reserved=[]`、
 * `maxVersion=0034`、`34 个文件 + 0 保留 === 34`，三条不变量自然成立（`reservedButPresent` 也回到空）。
 * 上面 R34-I19 段的 `gaps=[33]` 是**让号当时**的事实，⛔ 不是可以长期躺着的白名单：保留项一落盘就必须删，
 * 本次合流正是它自己的 `remove_when` 到期 —— 判据与负控制①~④一条未动。
 *
 * **合流后状态（2026-10-25，#538 解冲突合流 `upstream/main` = `1d65b7ee`）**：
 * 本片（#538）的 `0036_r34_admin_content_persistence.sql` 已真实落盘 ⇒ 36 号条目按它自己的
 * `remove_when` **删除**；缺口只剩 `0037`（#14 已裁定分配、尚无文件）。
 * 快照读数推进为 `gaps=[37] / reserved=[37]`、`maxVersion=0039`、**38 个文件 + 1 保留 === 39**
 * （正向 38 = `0001..0035` 连续 + `0036` + `0038` + `0039`，`rollback/` 37）。
 * 「当前仓库」用例同时把「不得出现 `0036_` 前缀文件」的期望**翻成存在** —— 0036 一落盘那条断言
 * 就该变红；继续写「不存在」就是假通过。上面 R34-I19 段与 0036 让号段的历史读数只作叙述保留，
 * ⛔ 不是可以长期躺着的白名单。
 *
 * **合流后状态（2026-10-25，GY-R35 · `#568` 重定基到 `6dbe83a3`：`#538` 已合入 main）**：
 * GY-R35 的 `0040_export_object_key_contract_backfill.sql` 落在 `0039` 之后 ⇒ 正向 **39** 个
 * （`0001..0035` 连续 + `0036` + `0038` + `0039` + `0040`）、`rollback/` **38** 个；
 * 缺号仍只有 `0037`，保留台账仍是那一行 ⇒ `39 个文件 + 1 保留 === max 40`，
 * 三条不变量自然成立（**台账不因 0040 新增任何条目**：它是本片自己落盘的文件，不是"有意缺号"）。
 *
 * **此前状态（2026-10-25，`#18` S2 片1 · 迁移 `0041` 落盘）**：
 * 裁定 `.pg17/ruling-r37-issue18-s2-scope-admin-20261025.md` 把 S2 的行内库层迁移定在 `0041`
 * （`0040` 已被 `#568` 占用、`0037` 留给 `#14`、当时 ⛔ 不占 `0042`）。该片落
 * `0041_admin_scope_write_authority.sql` 后：正向 **40** 个（`0001..0035` 连续 + `0036` + `0038`
 * + `0039` + `0040` + `0041`）、`rollback/` **39** 个；缺号仍只有 `0037`，保留台账仍是那一行 ⇒
 * `40 个文件 + 1 保留 === max 41`。**台账不因 0041 新增条目**，也**不得**残留 40 号条目
 * （0040 已落盘 ⇒ `reservedButPresent` 会立刻判红）；「当前仓库」用例把 0040/0041 两条
 * 都断言为**必须出现**，方向与落盘事实一致。
 *
 * **当前树状态（2026-10-25，`#18` R18 片的 `0043` 落盘 —— 上面 `0041`/`0042` 段的号位叙述
 * 只描述各自那一片的分配，已被本片取代）**：
 * `0043_admin_job_cancel_audit.sql` 落在 `0042` 之后 ⇒ 正向 **42** 个
 * （`0001..0035` 连续 + `0036` + `0038` + `0039` + `0040` + `0041` + `0042` + `0043`）、`rollback/` **41** 个；
 * 缺号仍只有 `0037`，保留台账仍只有那一条 ⇒ `42 个文件 + 1 保留 === max 43`。
 * **台账不因 0043 新增条目**（它是本片自己落盘的文件，不是"有意缺号"），也**不得**残留
 * 42 号条目（0042 已落盘 ⇒ `reservedButPresent` 立刻判红）；「当前仓库」用例把
 * 0040/0041/0042/0043 四条都断言为**必须出现**，`0037_` 前缀仍断言为**必须不存在**。
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

test('迁移编号/当前仓库：0036/#538、0038/#553、0039/#22、0040/#568、0041/#18 S2、0042/#37、0043/#18 R18 已落盘 ⇒ 42 文件 + 1 保留 === 43、三条不变量成立', () => {
  const migrations = discoverMigrations();
  const reservations = loadMigrationReservations();
  const numbering = inspectMigrationNumbering(migrations, reservations);

  assert.equal(numbering.count, migrations.length);
  assert.equal(numbering.maxVersion, Math.max(...migrations.map((item) => Number(item.version))));
  assert.deepEqual(
    numbering.gaps,
    [37],
    `0040（#568）、0041（#18 S2 片1）、0042（GY-R37 片）与 0043（#18 R18：作业取消审计落库）都已落盘 ⇒ 合流树的缺号必须仍只有 [37]（#14 保留；现场 ${JSON.stringify(numbering.gaps)}）`,
  );
  assert.deepEqual(
    numbering.reserved,
    [37],
    '0037 缺号必须在台账登记（否则 undeclaredGaps 会把它判成发现器静默漏项）；0040 已落盘 ⇒ ⛔ 不得再登记 40',
  );
  assert.equal(reservations.length, 1, '台账眼下必须恰有一条保留项（0037 #14；0027/0029/0031/0033/0036/0038/0040 七条都已按各自 remove_when 删除）');
  assert.deepEqual(numbering.undeclaredGaps, [], '未声明的缺号必须为空（0037 已登记）');
  assert.deepEqual(numbering.reservedButPresent, [], '登记过的号一旦变成真实文件，条目必须立刻删（防躺平）');
  assert.equal(
    numbering.countMatchesMax,
    true,
    `count(${numbering.count}) + 保留(${numbering.reserved.length}) 必须 === max(${numbering.maxVersion})`,
  );
  assert.equal(
    numbering.count,
    numbering.maxVersion - numbering.reserved.length,
    '同一事实的第二种写法：文件数 = 最大版本号 − 保留号数（42 = 43 − 1）',
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
    true,
    '0029 已随 #419 合入 origin/main（056cf424）⇒ 真实文件必须在清单里，且台账不得再登记它',
  );
  assert.ok(
    files.includes('0030_community_author_ref.sql'),
    'F13（#483）落在 0030，⛔ 不许占用 0028/0029',
  );
  assert.ok(
    files.includes('0032_community_report_reporter_ref.sql'),
    'R32（#15 去身份残留）必须落在 0032（31 由裁定锁给 #19），⛔ 不许占用 0030/0031',
  );
  // ⚠️ 这里的文件名必须是 **#494 真实落盘的那一支**（`0031_online_purge_evidence.sql`）。
  // 本断言曾把文件名多写一段 `i19_` 前缀 ⇒ 0031 真落盘后名字对不上、断言恒为 false 而「通过」，
  // 防线形同虚设（假通过）。真名已订正；0031 随 #494 落盘后**期望方向也必须从「不存在」翻成「存在」**
  // —— 若仍写 false，这条会重新退化成假通过（落盘了也看不见）。
  assert.equal(
    files.includes('0031_online_purge_evidence.sql'),
    true,
    '#19 的 0031 已随 #494 落盘 ⇒ 真实文件必须在清单里，且台账里的 31 条目必须已删'
      + '（否则 reservedButPresent 会先把这条判红）',
  );
  // R34-I19：本片撞号后让号 0033 → 0034（0033 归 #525 的审计读表）。方向必须与事实一致：
  // 0034 在清单里、0033 前缀属于 #525（它已随 origin/main `4b87e1d9` 落盘，故台账里那条 33 保留项已删）。
  assert.equal(
    files.includes('0034_r34_owner_content_purge.sql'),
    true,
    '本片清理迁移已让号到 0034 ⇒ 真实文件必须在清单里',
  );
  assert.equal(
    files.includes('0033_r34_owner_content_purge.sql'),
    false,
    '0033 已让给 #525（0033_admin_audit_log_read.sql）⇒ 本片不得再出现 0033 前缀的文件',
  );
  assert.equal(
    files.includes('0033_admin_audit_log_read.sql'),
    true,
    '#525 的 0033 已随 origin/main（4b87e1d9）落盘 ⇒ 真实文件必须在清单里，且台账不得再登记 33'
      + '（否则 reservedButPresent 会先把这条判红）',
  );
  // R34（#19 片2）0035 已落盘（媒体行物理删除窄函数）⇒ 真实文件必须在清单里。
  assert.equal(
    files.includes('0035_r34_media_row_purge.sql'),
    true,
    '#19 片2 的 0035 已落盘 ⇒ 真实文件必须在清单里',
  );
  // R34（#19 片B）本片（上游 #553）落 0038（回执 bearer 台账持久化）⇒ 真实文件必须在清单里。
  assert.equal(
    files.includes('0038_r34_deletion_receipt_persistence.sql'),
    true,
    '#19 片B 的 0038 已随 #553 落盘 ⇒ 真实文件必须在清单里，且台账不得登记 38',
  );
  // #538：0036 已随本片落盘（保留台账里的 36 号条目按 remove_when 删除）；
  // 0037 仍是 #14 的保留号（不得出现真实文件，否则 reservedButPresent 判红）。
  assert.equal(
    files.includes('0039_r34_deletion_state_cancelled.sql'),
    true,
    '#22 片C 的 0039 必须已落盘（deletion_state 增 cancelled）',
  );
  assert.equal(
    files.includes('0036_r34_admin_content_persistence.sql'),
    true,
    '#538 的 0036 已落盘 ⇒ 真实文件必须在清单里，且台账不得再登记 36'
      + '（方向必须与「已落盘」的事实一致：继续断言「不存在」就是假通过）',
  );
  // GY-R35（#568）：0040 已随上游落盘 ⇒ 台账里的 40 号条目按它自己的 remove_when 删除，
  // 断言方向同步翻成「必须出现」（若仍写 false，就是上面那句「落盘了也看不见」的假通过）。
  assert.equal(
    files.includes('0040_export_object_key_contract_backfill.sql'),
    true,
    '#568 的 0040 已随上游落盘 ⇒ 真实文件必须在清单里，且台账不得再登记 40',
  );
  // #18 S2 片1（R37）：裁定把 S2 的库层迁移定在 0041（0040 已归 #568，当时不占 0042）。
  assert.equal(
    files.includes('0041_admin_scope_write_authority.sql'),
    true,
    '#18 S2 片1 的 0041 已落盘 ⇒ 真实文件必须在清单里，且台账不得登记 41',
  );
  // GY-R37 片（#37）：0042 补 `favorites`/`history` 的 `target_type` 第 17 值，落在 0041 之后。
  assert.equal(
    files.includes('0042_favorites_history_target_type_conversation_turn.sql'),
    true,
    'GY-R37 片的 0042 已落盘 ⇒ 真实文件必须在清单里，且台账不得登记 42',
  );
  // #18 R18 片：0043 把后台「作业取消」的审计从进程内存落到库（窄口径 SECURITY DEFINER 函数），落在 0042 之后。
  assert.equal(
    files.includes('0043_admin_job_cancel_audit.sql'),
    true,
    '#18 R18 片的 0043 已落盘 ⇒ 真实文件必须在清单里（号位是分配好的 0043，⛔ 不许换号），且台账不得登记 43',
  );
  assert.equal(
    files.some((name) => /^0037_/.test(name)),
    false,
    '0037 属 #14（号空出）⇒ 合流树上不得出现 0037 前缀的文件',
  );
  assert.ok(
    reservations.every((item) => item.filename.startsWith(`${formatMigrationVersion(item.version)}_`)),
    '台账的 filename 前缀必须与 version 一致（防止「登记 29 却写成 0030_…」这种自欺）',
  );
  // 台账非空时上面那条对每条保留项都真实咬住；这条把同一条不变量对**真实迁移清单**
  // 再判一次，让「文件名前缀与解析出的版本号一致」在迁移清单上依然成立。
  assert.ok(
    migrations.every((item) => item.filename.startsWith(`${formatMigrationVersion(item.version)}_`)),
    '真实清单的 filename 前缀必须与解析出的 version 一致（防止「0031_… 却被解析成 30」这种自欺）',
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
  // （当前树的真实台账读数 —— 合流后为空数组 —— 由上面「当前仓库」那条守护）。
  const realNames = readdirSync(DEFAULT_MIGRATIONS_DIR)
    .filter((name) => /^\d{4,}_[a-z0-9_]+\.sql$/.test(name))
    .filter((name) => Number(name.slice(0, 4)) <= 28);
  const dir = makeMigrationsDir([...realNames, '0027_admin_audit_observability.sql']);
  // 真实台账的内容与这条负控制无关：判的是**机制还咬不咬人**，
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
