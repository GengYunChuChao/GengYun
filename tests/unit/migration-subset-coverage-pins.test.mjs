/**
 * R60 · 「新增迁移写新列 ⇒ 真库 integration 脚本的自定义迁移子集必须跟着加」静态守卫（只读）。
 *
 * 缺口（本文件要钉的那条规则，此前仓内**一枚钉子都没有**）：
 *
 *   `tests/integration/` 里有一批脚本**不跑全链**，而是手工列举它真正依赖的迁移号，
 *   例如 `community-pg.mjs:141` 的
 *   `all.filter((m) => ['0001', '0019', '0022', '0028', '0030', '0032'].includes(m.version))`。
 *   这类「自定义子集」脚本一旦遇到「新迁移给某张表 ADD COLUMN、且脚本/被测代码开始读写这一列」，
 *   就会在干净库上抛
 *   `column "<col>" of relation "<table>" does not exist`（SQLSTATE 42703），而**仓内没有任何
 *   test 会在不进真库、不跑 CI 集成臂的情况下提前红**：漏加的那一版迁移号只是让脚本少 apply 一条，
 *   语法上完全合法，unit 全绿、lint 全绿、契约全绿。历史上同类事故（#630 的形状：新迁移给
 *   `community_moderation_decisions` 加 `decided_by`，脚本子集没跟着加）就是靠人记、靠 CI 红了才补。
 *
 *   本文件把这条规则变成**按符号判、不按行号判**的静态钉子：从迁移目录通用收集
 *   `ALTER TABLE … ADD COLUMN` 的 (版本, 表, 列)，再看每个子集脚本**自己或它直接 import 的模块**
 *   是否同时提到「表」与「列」，是则它声明的子集里必须有该版本。行号只用来定位，不参与判定
 *   （`migrations-rollback-pairing.test.mjs` 已经钉住「迁移 ↔ 回滚按前缀配对」，本文件不重复那条，
 *   只在「脚本真的引用了某份 down」处薄薄补一刀）。
 *
 *   为什么要扩到「直接 import 的模块」：真事故 #630 的形状**不是**脚本自己写 `decided_by`，
 *   而是脚本 import `services/api/src/community/store-pg.ts`（以及 `app.ts`），由 store 的
 *   INSERT/SELECT 读写新列；只判脚本自身文本的话，那条事故在修复前的树上会**全绿**（实测过：
 *   9/9 绿，见下方边界段的说明）。所以需求侧必须接上「脚本真正会执行的代码」。
 *
 * 五条臂（全部只读：读文件、读目录，不连库、不执行 SQL、不起进程）：
 *
 *   1. 扫描面自证：真正识别出的「子集脚本」必须**恰好**是 `SUBSET_SCRIPTS` 这 12 个（today 实测
 *      12/66）；另外把「朴素扫描命中但不是真子集」的差集钉成**恰好** `NAIVE_ONLY_SCRIPTS`
 *      （today 实测就 `moderation-ledger-pg.mjs` 一个，原因见那里的注释）。正则一旦失配成「零命中」，
 *      这两条立刻红 —— 防「零命中即全绿」。
 *   2. 核心判定：子集脚本（或它直接 import 的模块）提到 (表, 列)，且这张表**由该脚本自己的子集
 *      建得出来** ⇒ 子集必须含该列所属迁移号。需求清单按「`0045` 在不在本树」二选一、
 *      两边都写成**精确清单**：不在树 17 条（today 实测，0 违规；其中 15 条
 *      `anonymized_author_ref` 需求）、在树 22 条（+5 条 `decided_by`）。见「过渡期适配」段。
 *   3. rollback 重放面：脚本回滚了 `rollback/NNNN`，且它用到了「被 NNNN 建出来的表」上由后续迁移
 *      ADD COLUMN 的列 ⇒ 该版本必须在**回滚点之后**再被 apply 一次。today 实测需求恰为
 *      `community-pg.mjs` 的 0030、0032，各出现 **2 次**（子集一次 + 重放一次）。
 *   4. 脚本引用的回滚件真实存在（up/down 两件都在盘上），防「删回滚件」。
 *   5. 反向（孤儿列）：每条 ADD COLUMN 的 (表, 列) 必须在**迁移目录之外**至少一处代码里被提到，
 *      防「迁移里的列名拼错/与代码脱节」——这条也是本文件唯一能抓住「改迁移里的列名」的那一臂。
 *
 * 过渡期适配（看这条，别看错）：需求清单的条数取决于「`0045` 在不在本树」——
 *   **不在**是 17 条（今天的 main `740ed332`），**在**是 22 条（多出五个 community 脚本各一条
 *   `→ 0045 community_moderation_decisions.decided_by`，实测 `de695979` 树）。本文件用
 *   `HAS_MIGRATION_0045` 二选一，两块都是**精确清单**（没有 `>=`、没有 `includes` 兜底、没有
 *   「有 0045 就跳过」）：这样 `#630`（B 档，还开着）合入 main 的那一刻这条钉子在主干上**直接绿**，
 *   不会用一个 A 档 PR 给主干埋雷；同时两条分支都仍然逐条比对，`#630` 那种「新列没进子集」照样红。
 *   `#630` 合入之后请做一次收尾（届时条件分支就是纯噪音）：把 `EXPECTED_DEMANDS_WITH_0045` 那 5 条
 *   并进 `EXPECTED_DEMANDS`（保持字典序）、删掉 `EXPECTED_DEMANDS_WITH_0045` 常量与
 *   `expectedDemands` 的三元条件（改成 `const expectedDemands = [...EXPECTED_DEMANDS];`）、
 *   并删掉本段与 `EXPECTED_DEMANDS` 注释里所有「过渡期」字样。
 *
 * 边界（说清「没证明什么」）：
 *   - 判定是**文本共现**，不是 AST，也不解析 SQL 语义：脚本里同时出现 `community_reports` 与
 *     `anonymized_author_ref` 就算「用到」。共现判宽了只会多出一条**真实需求**（不会漏判），
 *     因为需求侧的 (表, 列) 来自迁移原文。
 *   - 「直接 import」只跟**一层**（脚本自己 `import … from '../..../x.ts'` 的文件），不跟传递闭包。
 *     实测传递闭包会假红两条：`catalog-pg.mjs` / `source-lifecycle-pg.mjs` 的闭包里能翻到
 *     `knowledge_versions.created_at`（0012），但这两个脚本今天在 CI 是绿的 —— 用到表 ≠ 会执行到
 *     读那一列的代码路径。于是加了一道闸：**表必须由该脚本自己的子集建得出来**（`createdBy`
 *     ∩ `subset` 非空），否则连表都不在它的干净库里，那颗「需求」不成立。
 *   - 只覆盖「显式列举子集」的脚本。走 `discoverMigrations()` 全链的脚本天然含新迁移，无漏列风险，
 *     不在扫描面内（`findCoverageViolations` 的调用方只喂子集脚本）。
 *   - 不覆盖「按位置切片」的取迁移形态（`discoverMigrations().slice(0, 22)` 之类）：今天没有这种写法，
 *     真出现时靠 `SUBSET_SCRIPTS` / `NAIVE_ONLY_SCRIPTS` 的精确集合在评审里暴露。
 *   - 不判断子集里的版本号是否真的存在（那是 `migrations-rollback-pairing.test.mjs` 与
 *     `migrations-negative-pg.mjs` 的事），也不判断 apply 顺序（那是各脚本自己的自证臂）。
 *   - 不解析「按需加载 / 动态拼路径」的 import：只认静态 `import … from '<相对路径>'` 与
 *     `import('<相对路径>')`；今天 12 个子集脚本用的都是显式 `.ts` 后缀的静态相对 import。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS_DIR = 'services/api/db/migrations';
const INTEGRATION_DIR = 'tests/integration';
/** 本文件自身：反向臂（孤儿列）扫描代码时要排除，否则本文件里的夹具字符串会「自证」。 */
const PIN_FILE = 'tests/unit/migration-subset-coverage-pins.test.mjs';

/** 迁移文件名（up）：`NNNN_name.sql`。 */
const UP_FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * 扫描面基线：今天真实「显式列举迁移子集」的脚本，逐个点名。
 *
 * 为什么钉**精确集合**而不是「≥ 12」：`≥` 只在扫描塌成 0 时有牙，正则换了个写法把某个脚本
 * 漏出去时仍然绿。精确集合让「新加一个子集脚本 / 某个脚本改了声明形态」都必须过这一关
 * （写法沿用 `tests/unit/ci-real-pg-wiring.test.mjs` 的 `FROZEN_MANAGED_SCRIPTS`）。
 * 新增脚本时：把文件名加进本表，并在 PR 里说明它的子集为什么完整。
 */
const SUBSET_SCRIPTS = Object.freeze([
  'admin-community-posts-pg.mjs',
  'admin-posts-read-pg.mjs',
  'catalog-pg.mjs',
  'community-filter-pg.mjs',
  'community-pg.mjs',
  'conversations-pg.mjs',
  'favorites-history-pg.mjs',
  'moderation-full-chain-pg.mjs',
  'qa-citations-pg.mjs',
  'recognition-chain-e2e.mjs',
  'source-lifecycle-pg.mjs',
  'staging-intake-pg.mjs',
]);

/**
 * 「朴素扫描命中、但不是迁移子集」的差集，today 实测恰好这一个。
 *
 * `moderation-ledger-pg.mjs:301` 是
 * `assert.deepEqual(numbering.reservedButPresent.map(formatMigrationVersion), ['0027'], …)`：
 * 那个 `['0027']` 是**断言期望值**（保留台账里「躺平」的号），不是 apply 子集。
 * 朴素扫描（任何四位数版本串数组）把它当子集，会凭空造出
 * `exports.revision/error_code/job_id ← 0011`、`exports.object_key ← 0014` 四条**假违规**。
 * ⇒ 精确识别必须带语境（见 `collectSubsetDeclarations` 的三条形态）；这份差集钉住「带语境的
 * 识别没有把真子集也一起丢出去」。
 */
const NAIVE_ONLY_SCRIPTS = Object.freeze([
  {
    file: 'moderation-ledger-pg.mjs',
    why: ':301 的 [\'0027\'] 是 assert.deepEqual 的期望值（保留台账躺平项），不是迁移子集',
  },
]);

/** ADD COLUMN 收集面的下限（today 实测 18 条）：防止 ALTER 正则写坏后「零条目即全绿」。 */
const COLUMN_ENTRY_FLOOR = 18;

/** 反向臂扫描的代码文件下限（today 实测 1020 个）：防止 walk 走空后「零代码即全绿」。 */
const CODE_FILE_FLOOR = 900;

/**
 * 今天真实的 17 条需求（精确清单）= **0045 不在本树时**的全部需求。
 *
 * 0030/0032/0012 是既成事实：这些迁移已经在树上、相关脚本已经补齐，需求**只会增不会减**。
 * 谁把某一版从某个脚本的子集里删掉，这里逐条报 `文件 → 版本 表.列`。
 * `0045` 落树后多出的那 5 条在 `EXPECTED_DEMANDS_WITH_0045`，由 `expectedDemands` 按
 * `HAS_MIGRATION_0045` 二选一（过渡期适配，见文件头）。
 *
 * 为什么 `anonymized_author_ref` 是 15 条而不是 8 条：需求侧接了「直接 import 的模块」之后，
 * 五个 community 真库脚本 import 的 `store-pg.ts` / `app.ts` 同时提到 community_posts /
 * community_comments / community_reports 与这一列，于是每个脚本都对该表的 0030/0032 提出需求
 * —— 这是**真实需求**（那些表由它们在子集里 apply 的 0022 建出来，store 的 SQL 就会读到这一列）。
 */
const EXPECTED_DEMANDS = Object.freeze([
  'admin-community-posts-pg.mjs → 0030 community_comments.anonymized_author_ref',
  'admin-community-posts-pg.mjs → 0030 community_posts.anonymized_author_ref',
  'admin-community-posts-pg.mjs → 0032 community_reports.anonymized_author_ref',
  'admin-posts-read-pg.mjs → 0030 community_comments.anonymized_author_ref',
  'admin-posts-read-pg.mjs → 0030 community_posts.anonymized_author_ref',
  'admin-posts-read-pg.mjs → 0032 community_reports.anonymized_author_ref',
  'community-filter-pg.mjs → 0030 community_comments.anonymized_author_ref',
  'community-filter-pg.mjs → 0030 community_posts.anonymized_author_ref',
  'community-filter-pg.mjs → 0032 community_reports.anonymized_author_ref',
  'community-pg.mjs → 0030 community_comments.anonymized_author_ref',
  'community-pg.mjs → 0030 community_posts.anonymized_author_ref',
  'community-pg.mjs → 0032 community_reports.anonymized_author_ref',
  'conversations-pg.mjs → 0012 knowledge_versions.created_at',
  'moderation-full-chain-pg.mjs → 0030 community_comments.anonymized_author_ref',
  'moderation-full-chain-pg.mjs → 0030 community_posts.anonymized_author_ref',
  'moderation-full-chain-pg.mjs → 0032 community_reports.anonymized_author_ref',
  'qa-citations-pg.mjs → 0012 knowledge_versions.created_at',
]);

/**
 * `0045`（#630）在树上时**额外**多出的 5 条需求（过渡期适配的另一半，见文件头）。
 *
 * 为什么是 5 条：五个 community 真库脚本的子集里都有建出 `community_moderation_decisions` 的
 * `0022`，而它们（或它们直接 import 的 `store-pg.ts` / `app.ts`）都会读写 `decided_by`，于是每个脚本
 * 各自提出一条需求。实测 `de695979` 树（#630 的修复提交）上正是这 5 条、需求总数 22。
 * 与 `EXPECTED_DEMANDS` 一样是**精确清单**：`expectedDemands` 按 `HAS_MIGRATION_0045` 二选一，
 * 不做并集、不跳过；`#630` 合入后把这 5 行并进上面那张表并删掉本常量。
 */
const EXPECTED_DEMANDS_WITH_0045 = Object.freeze([
  'admin-community-posts-pg.mjs → 0045 community_moderation_decisions.decided_by',
  'admin-posts-read-pg.mjs → 0045 community_moderation_decisions.decided_by',
  'community-filter-pg.mjs → 0045 community_moderation_decisions.decided_by',
  'community-pg.mjs → 0045 community_moderation_decisions.decided_by',
  'moderation-full-chain-pg.mjs → 0045 community_moderation_decisions.decided_by',
]);

/**
 * 直接 import 了 `services/api/src/community/store-pg.ts` 的子集脚本（today 实测这五个）。
 *
 * 这五个就是「会话/审核/筛选」真库臂：#630 的 42703 正是从 store-pg 的 SQL 里冒出来的。
 * 钉住这份清单 = 钉住「需求侧真的读到了 store 代码」——谁把某个脚本的 store import 换成
 * 别的东西（或改成动态拼路径），这条立刻红，而不是让核心判定悄悄退化成「只看脚本文本」。
 */
const EXPECTED_STORE_IMPORTERS = Object.freeze([
  'admin-community-posts-pg.mjs',
  'admin-posts-read-pg.mjs',
  'community-filter-pg.mjs',
  'community-pg.mjs',
  'moderation-full-chain-pg.mjs',
]);

/** 需求侧要跟的 import 深度：只跟一层（理由见文件头「边界」段）。 */
const DIRECT_IMPORT_DEPTH = 1;

/** 子集脚本里真的引用了 `rollback/NNNN_*.down.sql` 的版本（today 实测这五个）。 */
const EXPECTED_ROLLBACK_VERSIONS = Object.freeze(['0005', '0006', '0007', '0018', '0022']);

// ---------------------------------------------------------------------------
// 纯函数（不触碰真实目录；真实目录只在上面的常量与本文件末尾的 test 里出现）
// ---------------------------------------------------------------------------

/**
 * 在一段文本里定位某个下标所在的行号（1 基）。
 * @param {string} text
 * @param {number} index
 * @returns {number}
 */
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 0x0a) line += 1;
  }
  return line;
}

/**
 * 把 `['0001', '0019']` 的**内部**解析成版本号数组；只要有一个元素不是四位数版本串就返回 `null`。
 * @param {string} inner 不含方括号的内部文本
 * @returns {string[] | null}
 */
function parseVersionArray(inner) {
  const parts = inner
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0) return null;
  const versions = [];
  for (const part of parts) {
    const match = /^['"](\d{4})['"]$/.exec(part);
    if (match === null) return null;
    versions.push(match[1]);
  }
  return versions;
}

/**
 * 识别脚本里**真正的迁移子集声明**，只认三种带语境的形态：
 *
 *   a. `const MIGRATIONS = [...]` / `const MIGRATION_VERSIONS = Object.freeze([...])`
 *      —— 变量名必须含 `MIGRATION`（`EXTRA_MIGRATIONS` 也算）；
 *   b. `discoverMigrations().filter((m) => ['0001', …].includes(m.version))`
 *      —— 认 `.includes(<形参>.version)`，所以 `versions.filter((v) => ['0020','0021'].includes(v))`
 *      这种「自证目录里有这两版」的断言**不算**子集（见 `community-pg.mjs:134-139`）；
 *   c. `applyMigrations(owner, ['0001', …])` —— 直接喂数组。
 *
 * 断言期望值（`assert.deepEqual(applied, ['0001', …])`、`… , ['0027'], …`）天然落在三种形态之外。
 * @param {string} text
 * @returns {{ kind: string, name: string, line: number, versions: string[] }[]}
 */
function collectSubsetDeclarations(text) {
  const found = [];

  for (const match of text.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:Object\.freeze\(\s*)?(\[[^[\]]*\])/g,
  )) {
    const name = match[1];
    if (/MIGRATION/i.test(name) === false) continue;
    const versions = parseVersionArray(match[2].slice(1, -1));
    if (versions === null) continue;
    found.push({ kind: 'const', name, line: lineOf(text, match.index), versions });
  }

  for (const match of text.matchAll(
    /\.filter\(\s*\(?([\w$]+)\)?\s*=>\s*(\[[^[\]]*\])\s*\.includes\(\s*\1\.version\s*\)/g,
  )) {
    const versions = parseVersionArray(match[2].slice(1, -1));
    if (versions === null) continue;
    found.push({ kind: 'filter', name: match[1], line: lineOf(text, match.index), versions });
  }

  for (const match of text.matchAll(/applyMigrations\(\s*[^,()]+,\s*(\[[^[\]]*\])\s*\)/g)) {
    const versions = parseVersionArray(match[1].slice(1, -1));
    if (versions === null) continue;
    found.push({ kind: 'apply', name: '', line: lineOf(text, match.index), versions });
  }

  return found.sort((left, right) => left.line - right.line);
}

/**
 * 朴素扫描：任意「元素全是四位数版本串」的数组，不看语境。只用于扫描面自证的差集比对。
 * @param {string} text
 * @returns {{ line: number, versions: string[] }[]}
 */
function collectNaiveVersionArrays(text) {
  const found = [];
  for (const match of text.matchAll(/\[[^[\]]*\]/g)) {
    const versions = parseVersionArray(match[0].slice(1, -1));
    if (versions === null) continue;
    found.push({ line: lineOf(text, match.index), versions });
  }
  return found;
}

/**
 * 从迁移原文通用收集 `ALTER TABLE <表> ADD COLUMN <列>`：(版本, 表, 列, 文件, 行)。
 *
 * 逐行扫、记住最近的 `ALTER TABLE` 目标，遇 `;` 收口 —— 与仓库迁移的书写形态一致
 * （一条 ALTER 里可能有多条 ADD COLUMN，例如 0011 给 `exports` 一次补 5 列）。
 * @param {{ name: string, text: string }[]} files
 * @returns {{ version: string, table: string, column: string, file: string, line: number }[]}
 */
function collectColumnMigrations(files) {
  const entries = [];
  for (const { name, text } of files) {
    const version = name.slice(0, 4);
    let table = null;
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const code = lines[index].replace(/--.*$/, '');
      const alter = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?(\w+)/i.exec(code);
      if (alter !== null) table = alter[1];
      if (table === null) continue;
      const added = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(code);
      if (added !== null) {
        entries.push({
          version,
          table,
          column: added[1],
          file: `${MIGRATIONS_DIR}/${name}`,
          line: index + 1,
        });
      }
      if (/;\s*$/.test(code)) table = null;
    }
  }
  return entries;
}

/**
 * 从迁移原文收集 `CREATE TABLE <表>` → { 版本 }：用于判定「回滚这一版会连带删掉哪些表」。
 * @param {{ name: string, text: string }[]} files
 * @returns {Map<string, string[]>} 表名 → 建它的迁移版本（通常只有一个）
 */
function collectCreatedTables(files) {
  const createdBy = new Map();
  for (const { name, text } of files) {
    const version = name.slice(0, 4);
    const code = text.replace(/--.*$/gm, '');
    for (const match of code.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)/gi,
    )) {
      const table = match[1];
      const versions = createdBy.get(table) ?? [];
      if (versions.includes(version) === false) versions.push(version);
      createdBy.set(table, versions);
    }
  }
  return createdBy;
}

/**
 * 收集脚本里的 apply 事件与 rollback 引用点（按字符下标排序，下标只用于「谁在前谁在后」）。
 * @param {string} text
 * @returns {{ applies: { version: string, index: number, line: number }[],
 *            rollbacks: { version: string, index: number, line: number }[] }}
 */
function collectApplyEvents(text) {
  const applies = [];
  const rollbacks = [];
  for (const match of text.matchAll(/['"`]migrations\/(\d{4})_[a-z0-9_]*\.sql['"`]/g)) {
    applies.push({ version: match[1], index: match.index, line: lineOf(text, match.index) });
  }
  for (const match of text.matchAll(/rollback\/(\d{4})_[a-z0-9_]*\.down\.sql/g)) {
    rollbacks.push({ version: match[1], index: match.index, line: lineOf(text, match.index) });
  }
  return {
    applies: applies.sort((left, right) => left.index - right.index),
    rollbacks: rollbacks.sort((left, right) => left.index - right.index),
  };
}

/** 列名/表名在文本里是否作为独立标识符出现（不区分大小写）。 */
function mentions(text, symbol) {
  return new RegExp(`\\b${symbol}\\b`, 'i').test(text);
}

/**
 * 在一组「脚本 + 它直接 import 的模块」里定位某个符号首次出现的位置。
 * @param {{ file: string, text: string }[]} sources 顺序敏感：脚本自身在前
 * @param {string} symbol
 * @returns {{ file: string, line: number } | null}
 */
function locateMention(sources, symbol) {
  for (const source of sources) {
    if (mentions(source.text, symbol) === false) continue;
    const match = new RegExp(`\\b${symbol}\\b`, 'i').exec(source.text);
    return { file: source.file, line: lineOf(source.text, match.index) };
  }
  return null;
}

/**
 * 把脚本里静态相对 import 的说明符解析成仓库内真实文件（只读探测，不执行）。
 *
 * 今天 12 个子集脚本写的都是显式后缀（`'../../services/api/src/community/store-pg.ts'`），
 * 这里额外容忍 `.js → .ts`、`.mjs → .mts`、省略后缀与 `index.ts`，免得换个写法就静悄悄零命中。
 * @param {string} fromFile 仓库相对路径
 * @param {string} specifier `import … from '<specifier>'` 里的原文
 * @returns {string | null} 仓库相对路径（`/` 分隔），解析不到返回 null
 */
function resolveRelativeImport(fromFile, specifier) {
  if (specifier.startsWith('.') === false) return null;
  const base = normalize(join(dirname(fromFile), specifier)).split('\\').join('/');
  const candidates = [base];
  if (base.endsWith('.js')) candidates.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.mts`);
  if (base.endsWith('.mjs')) candidates.push(`${base.slice(0, -4)}.mts`, `${base.slice(0, -4)}.ts`);
  candidates.push(`${base}.ts`, `${base}.mts`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.mjs`);
  return candidates.find((candidate) => existsSync(join(REPO_ROOT, candidate))) ?? null;
}

/**
 * 脚本的**直接**相对 import 模块（一层，不跟传递闭包）。
 * @param {string} scriptFile 仓库相对路径
 * @param {string} text
 * @returns {{ file: string, text: string }[]}
 */
function collectDirectImports(scriptFile, text) {
  if (DIRECT_IMPORT_DEPTH !== 1) throw new Error(`只支持一层 import（当前 ${DIRECT_IMPORT_DEPTH}）`);
  const files = [];
  for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.[^'"]+)['"]/g)) {
    const resolved = resolveRelativeImport(scriptFile, match[1]);
    if (resolved === null || files.some((entry) => entry.file === resolved)) continue;
    files.push({ file: resolved, text: readFileSync(join(REPO_ROOT, resolved), 'utf8') });
  }
  return files.sort((left, right) => left.file.localeCompare(right.file));
}

/**
 * 需求侧的「证据源」：脚本自身 + 它直接 import 的模块（脚本自身排在最前，报行号时优先它）。
 * @param {{ file: string, text: string, imports?: { file: string, text: string }[] }} script
 * @returns {{ file: string, text: string }[]}
 */
function demandSources(script) {
  return [{ file: script.file, text: script.text }, ...(script.imports ?? [])];
}

/**
 * 核心判定：子集脚本（或它直接 import 的模块）提到 (表, 列)，且这张表由该脚本自己的子集建得出来
 * ⇒ 子集必须含该列所属迁移版本。
 *
 * 「表由自己的子集建得出来」是防假红的那道闸：表都不在干净库里时，读到它的代码路径根本不会跑
 * （否则今天的 CI 早就红了），不该为它索要迁移。
 *
 * 只接受「显式子集」脚本（`subset` 是 `Set<string>`）；全链脚本不入扫描面。
 * @param {{ file: string, text: string, subset: Set<string>,
 *           imports?: { file: string, text: string }[] }[]} scripts
 * @param {{ version: string, table: string, column: string, file: string, line: number }[]} entries
 * @param {Map<string, string[]>} createdBy 表 → 建它的迁移版本
 * @returns {{ script: string, version: string, table: string, column: string,
 *             usageFile: string, usageLine: number, via: 'script' | 'import',
 *             migrationFile: string, migrationLine: number }[]}
 */
function findCoverageViolations(scripts, entries, createdBy) {
  return collectDemands(scripts, entries, createdBy).filter((demand) => demand.satisfied === false);
}

/**
 * 核心判定用的「需求清单」（含已被满足的）：失败信息与精确清单都比对这份。
 * 判定口径与 `findCoverageViolations` 完全一致（后者就是本函数过滤掉 satisfied 的那些）。
 * @param {{ file: string, text: string, subset: Set<string>,
 *           imports?: { file: string, text: string }[] }[]} scripts
 * @param {{ version: string, table: string, column: string, file: string, line: number }[]} entries
 * @param {Map<string, string[]>} createdBy
 * @returns {{ script: string, version: string, table: string, column: string,
 *             usageFile: string, usageLine: number, via: 'script' | 'import',
 *             migrationFile: string, migrationLine: number, satisfied: boolean }[]}
 */
function collectDemands(scripts, entries, createdBy) {
  const demands = [];
  for (const script of scripts) {
    const sources = demandSources(script);
    const evidence = sources.map((source) => source.text).join('\n');
    for (const entry of entries) {
      const builtBySubset = (createdBy.get(entry.table) ?? []).some((version) => script.subset.has(version));
      if (builtBySubset === false) continue;
      if (mentions(evidence, entry.table) === false) continue;
      const usage = locateMention(sources, entry.column);
      if (usage === null) continue;
      demands.push({
        script: script.file,
        version: entry.version,
        table: entry.table,
        column: entry.column,
        usageFile: usage.file,
        usageLine: usage.line,
        via: usage.file === script.file ? 'script' : 'import',
        migrationFile: entry.file,
        migrationLine: entry.line,
        satisfied: script.subset.has(entry.version),
      });
    }
  }
  return demands;
}

/**
 * 重放面：脚本回滚了 `rollback/NNNN`（会连带 DROP 掉 NNNN 建的表），
 * 而它（或它直接 import 的模块）用到了这些表上由**后续迁移** ADD COLUMN 的列
 * ⇒ 该版本必须在回滚点之后重新 apply。
 * @param {{ file: string, text: string, subset: Set<string>,
 *           imports?: { file: string, text: string }[] }[]} scripts
 * @param {{ version: string, table: string, column: string, file: string, line: number }[]} entries
 * @param {Map<string, string[]>} createdBy
 * @returns {{ script: string, version: string, table: string, column: string,
 *             rollbackVersion: string, rollbackLine: number, migrationFile: string,
 *             usageFile: string, usageLine: number }[]}
 */
function findReplayViolations(scripts, entries, createdBy) {
  const violations = [];
  for (const script of scripts) {
    const { applies, rollbacks } = collectApplyEvents(script.text);
    if (rollbacks.length === 0) continue;
    const sources = demandSources(script);
    const evidence = sources.map((source) => source.text).join('\n');
    for (const rollback of rollbacks) {
      for (const entry of entries) {
        const owners = createdBy.get(entry.table) ?? [];
        if (owners.includes(rollback.version) === false) continue;
        if (mentions(evidence, entry.table) === false) continue;
        const usage = locateMention(sources, entry.column);
        if (usage === null) continue;
        const replayed = applies.some(
          (apply) => apply.version === entry.version && apply.index > rollback.index,
        );
        if (replayed) continue;
        violations.push({
          script: script.file,
          version: entry.version,
          table: entry.table,
          column: entry.column,
          rollbackVersion: rollback.version,
          rollbackLine: rollback.line,
          migrationFile: entry.file,
          usageFile: usage.file,
          usageLine: usage.line,
        });
      }
    }
  }
  return violations;
}

/**
 * 反向臂（孤儿列）：每条 ADD COLUMN 的 (表, 列) 必须在迁移目录之外至少一处代码里被提到。
 * 抓的是「迁移里的列名与代码脱节」——拼错列名、改名、或列加了却没人用。
 * @param {{ version: string, table: string, column: string, file: string, line: number }[]} entries
 * @param {{ file: string, text: string }[]} codeFiles
 * @returns {string[]} 形如 `0045 community_moderation_decisions.decided_by`
 */
function findOrphanColumns(entries, codeFiles) {
  const orphans = [];
  for (const entry of entries) {
    const consumers = codeFiles.filter(
      (code) => mentions(code.text, entry.table) && mentions(code.text, entry.column),
    );
    if (consumers.length === 0) {
      orphans.push(`${entry.version} ${entry.table}.${entry.column}`);
    }
  }
  return orphans;
}

// ---------------------------------------------------------------------------
// 真实目录读数（只读一次，五个 test 共用）
// ---------------------------------------------------------------------------

const migrationFiles = readdirSync(join(REPO_ROOT, MIGRATIONS_DIR))
  .filter((name) => UP_FILE_PATTERN.test(name))
  .sort()
  .map((name) => ({ name, text: readFileSync(join(REPO_ROOT, MIGRATIONS_DIR, name), 'utf8') }));

const integrationFiles = readdirSync(join(REPO_ROOT, INTEGRATION_DIR))
  .filter((name) => name.endsWith('.mjs'))
  .sort()
  .map((name) => ({ name, text: readFileSync(join(REPO_ROOT, INTEGRATION_DIR, name), 'utf8') }));

const columnEntries = collectColumnMigrations(migrationFiles);
const createdBy = collectCreatedTables(migrationFiles);

/**
 * 过渡期适配的开关：`0045`（#630）是否已经在本树。
 *
 * 刻意按**文件名前缀**判，而不是按「收集到了 0045 的 ADD COLUMN」判：这条分支问的是
 * 「那一版迁移在不在树上」。若 0045 落树却没带 ADD COLUMN（改成 RENAME 之类），
 * `expectedDemands` 会走 22 条那条分支而收集不到 decided_by，于是本条红 —— 那正是要的信号。
 */
const HAS_MIGRATION_0045 = migrationFiles.some((file) => file.name.startsWith('0045_'));

const subsetScriptTexts = integrationFiles
  .map(({ name, text }) => ({ name, text, declarations: collectSubsetDeclarations(text) }))
  .filter((script) => script.declarations.length > 0);

const subsetScripts = subsetScriptTexts.map((script) => ({
  file: script.name,
  text: script.text,
  subset: new Set(script.declarations.flatMap((declaration) => declaration.versions)),
  imports: collectDirectImports(`${INTEGRATION_DIR}/${script.name}`, script.text),
}));

const naiveOnlyNames = integrationFiles
  .filter(({ text }) => collectNaiveVersionArrays(text).length > 0)
  .map(({ name }) => name)
  .filter((name) => subsetScriptTexts.some((script) => script.name === name) === false);

const coverageDemands = collectDemands(subsetScripts, columnEntries, createdBy);
const coverageViolations = coverageDemands.filter((demand) => demand.satisfied === false);
/**
 * 过渡期适配：需求清单按「`0045` 在不在本树」二选一 —— 两边都是精确清单，没有并集兜底、没有跳过。
 * `#630` 合入后改成 `const expectedDemands = [...EXPECTED_DEMANDS];`（见文件头收尾清单）。
 */
const expectedDemands = HAS_MIGRATION_0045
  ? [...EXPECTED_DEMANDS, ...EXPECTED_DEMANDS_WITH_0045].sort()
  : [...EXPECTED_DEMANDS];
/** 需求侧真的读到了 community store 的脚本（`EXPECTED_STORE_IMPORTERS` 的自证读数）。 */
const storeImporters = subsetScripts
  .filter((script) => script.imports.some((module) => module.file === 'services/api/src/community/store-pg.ts'))
  .map((script) => script.file);
const formatDemand = (demand) => `${demand.script} → ${demand.version} ${demand.table}.${demand.column}`;
const formatViolation = (violation) =>
  `${violation.script} 用到 ${violation.table}.${violation.column}`
  + `（证据 ${violation.usageFile}:${violation.usageLine}，${violation.via === 'script' ? '脚本文本' : '直接 import 的模块'}）`
  + `，但子集缺 ${violation.version}（该列由 ${violation.migrationFile}:${violation.migrationLine} 添加）`;

/**
 * 反向臂要扫的代码文件：迁移目录之外、`.ts/.mjs/…` 全都要看（apps/、miniprogram/、
 * services/、tests/、tools/、packages/ 都算「认识这一列的代码」）。
 * 跳过依赖与构建产物；额外跳过本文件自身（见 `PIN_FILE` 的注释）。
 */
function listCodeFiles() {
  const skipped = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out', 'tmp']);
  const pattern = /\.(?:ts|mts|cts|tsx|mjs|cjs|js|jsx)$/;
  const files = [];
  const walk = (relativeDir) => {
    for (const entry of readdirSync(join(REPO_ROOT, relativeDir), { withFileTypes: true })) {
      if (skipped.has(entry.name)) continue;
      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(relativePath);
        continue;
      }
      if (pattern.test(entry.name) === false) continue;
      if (relativePath === PIN_FILE) continue;
      if (relativePath.startsWith(`${MIGRATIONS_DIR}/`)) continue;
      files.push({ file: relativePath, text: readFileSync(join(REPO_ROOT, relativePath), 'utf8') });
    }
  };
  walk('');
  return files;
}

const codeFiles = listCodeFiles();
const orphanColumns = findOrphanColumns(columnEntries, codeFiles);

// ---------------------------------------------------------------------------
// 1. 扫描面自证
// ---------------------------------------------------------------------------

test('扫描面自证：真正识别的子集脚本恰是这 12 个（today 12/66），防正则失配后零命中即全绿', () => {
  const actual = subsetScripts.map((script) => script.file);
  assert.deepEqual(
    actual,
    [...SUBSET_SCRIPTS],
    `子集脚本清单变了。实际 ${actual.length} 个：\n  ${actual.join('\n  ')}\n`
      + `基线 ${SUBSET_SCRIPTS.length} 个：\n  ${SUBSET_SCRIPTS.join('\n  ')}\n`
      + '若确实是新脚本/新写法：把文件名加进 SUBSET_SCRIPTS 并在 PR 里说明子集为何完整；'
      + `若该脚本其实不该被识别成子集（例如命中的是断言期望值），把它记进 NAIVE_ONLY_SCRIPTS 并写原因。`
      + `（本次共扫到 ${integrationFiles.length} 个 tests/integration/*.mjs）`,
  );
});

test('扫描面自证：「朴素命中但不是子集」的差集恰是 moderation-ledger-pg.mjs（语境识别没丢真子集）', () => {
  assert.deepEqual(
    naiveOnlyNames,
    NAIVE_ONLY_SCRIPTS.map((script) => script.file),
    `语境识别与朴素扫描的差集变了：实际 ${JSON.stringify(naiveOnlyNames)}，`
      + `基线 ${JSON.stringify(NAIVE_ONLY_SCRIPTS.map((script) => script.file))}。`
      + '变大 ⇒ 有真子集被语境识别漏掉（漏掉就等于少判一个脚本，必须修识别或登记原因）；'
      + '变小 ⇒ 登记表里的那条已经不再朴素命中，删掉它。',
  );
  for (const script of NAIVE_ONLY_SCRIPTS) {
    const text = integrationFiles.find((file) => file.name === script.file)?.text ?? '';
    assert.equal(
      collectNaiveVersionArrays(text).length > 0,
      true,
      `${script.file} 已不再有「朴素四位数数组」⇒ 这条登记过期，删掉。原登记原因：${script.why}`,
    );
  }
});

test('扫描面自证：每个子集脚本至少有一处声明，且声明都带文件:行（可定位）', () => {
  const manifest = subsetScriptTexts.map(
    (script) =>
      `${script.name}: ` + script.declarations.map((d) => `:${d.line} ${d.kind} [${d.versions.join(',')}]`).join(' + '),
  );
  assert.deepEqual(
    subsetScriptTexts.filter((script) => script.declarations.length === 0).map((script) => script.name),
    [],
    `有子集脚本一条声明都没识别出来：\n  ${manifest.join('\n  ')}`,
  );
  assert.deepEqual(
    subsetScriptTexts
      .filter((script) => script.declarations.some((d) => Number.isInteger(d.line) === false || d.line < 1))
      .map((script) => script.name),
    [],
    `声明的行号不合法（定位会失效）：\n  ${manifest.join('\n  ')}`,
  );
});

// ---------------------------------------------------------------------------
// 2. 核心判定（按符号）
// ---------------------------------------------------------------------------

test('ADD COLUMN 收集面：18 条下限 + 0030/0032 的 community 三列必须在册', () => {
  const manifest = columnEntries.map(
    (entry) => `${entry.version} ${entry.table}.${entry.column} (${entry.file}:${entry.line})`,
  );
  assert.equal(
    columnEntries.length >= COLUMN_ENTRY_FLOOR,
    true,
    `收集到的 ADD COLUMN 只有 ${columnEntries.length} 条，低于基线 ${COLUMN_ENTRY_FLOOR} 条`
      + '（ALTER 正则或迁移书写形态变了）——实际清单：\n  '
      + manifest.join('\n  '),
  );
  const anchors = columnEntries
    .filter((entry) => entry.table.startsWith('community_'))
    .map((entry) => `${entry.version} ${entry.table}.${entry.column}`);
  const requiredAnchors = [
    '0030 community_comments.anonymized_author_ref',
    '0030 community_posts.anonymized_author_ref',
    '0032 community_reports.anonymized_author_ref',
  ];
  assert.deepEqual(
    requiredAnchors.filter((anchor) => anchors.includes(anchor) === false),
    [],
    `community_* 表上这三条 ADD COLUMN 必须在册（#630 的 0045 community_moderation_decisions.decided_by`
      + ` 落树后会自动成为第 4 条，无需改本断言）。实际收集到：\n  `
      + manifest.join('\n  '),
  );
});

test('扫描面自证：需求侧真的读到了 community store（直接 import store-pg.ts 的恰是这 5 个脚本）', () => {
  assert.deepEqual(
    storeImporters,
    [...EXPECTED_STORE_IMPORTERS],
    `直接 import services/api/src/community/store-pg.ts 的子集脚本变了：实际 ${JSON.stringify(storeImporters)}，`
      + `基线 ${JSON.stringify([...EXPECTED_STORE_IMPORTERS])}。`
      + '这条是「需求侧接得到 store 代码」的自证：#630 的 42703 就是从 store-pg 的 SQL 里冒出来的，'
      + '一旦某个脚本改成动态拼路径/换封装，核心判定会静悄悄退化成「只看脚本文本」——那就抓不到真事故了。',
  );
  const noImports = subsetScripts.filter((script) => (script.imports ?? []).length === 0);
  assert.deepEqual(
    noImports.map((script) => script.file),
    [],
    `这些子集脚本一个相对 import 都没解析出来（import 解析器坏了？）：${noImports.map((script) => script.file).join(', ')}`,
  );
});

test('核心判定：子集脚本或其直接 import 的代码提到 (表, 列) ⇒ 子集必须含该列所属迁移（需求清单精确：无 0045 = 17 条 / 有 0045 = 22 条；today 0 违规）', () => {
  assert.deepEqual(
    coverageViolations.map(formatViolation),
    [],
    '自定义迁移子集漏了新列所属的迁移 ⇒ 干净库会抛 '
      + '`column "<col>" of relation "<table>" does not exist`（42703）。'
      + `\n今天全部需求（${coverageDemands.length} 条）：\n  `
      + coverageDemands.map(formatDemand).join('\n  '),
  );
  assert.deepEqual(
    coverageDemands.map(formatDemand).sort(),
    [...expectedDemands],
    `需求清单变了（分支：${HAS_MIGRATION_0045 ? '0045 在本树 ⇒ 应为 22 条' : '0045 不在本树 ⇒ 应为 17 条'}；`
      + '0030/0032/0012 已经落在树上，需求只会增不会减）：\n  '
      + coverageDemands.map(formatDemand).sort().join('\n  '),
  );
  // 需求侧的证据源必须真的读到了 store 代码（今天 15 条 author-ref 需求都由脚本自己写列名满足，
  // `via: 'import'` 是 0 条；所以这里钉的是「连得上」，不是「今天必须靠 import 才成立」）。
  // #630 落树后，store-pg.ts 里出现 `decided_by`，需求会自动多出 import 证据的那条。
  const storeModule = subsetScripts
    .flatMap((script) => script.imports ?? [])
    .find((module) => module.file === 'services/api/src/community/store-pg.ts');
  assert.deepEqual(
    [mentions(storeModule.text, 'community_moderation_decisions'), storeModule.text.length > 1000],
    [true, true],
    '必须真的读到 services/api/src/community/store-pg.ts 的内容（且它已经在读写 community_moderation_decisions）：'
      + `实际读取 ${storeModule.text.length} 字符，社区审核表共现=${mentions(storeModule.text, 'community_moderation_decisions')}。`
      + '读不到内容 ⇒ 需求侧永远只能看脚本文本 ⇒ #630 那种「脚本不写列名」的事故会被漏判。',
  );
});

test('核心判定 · 反例优先：脚本自己不写列名、只由直接 import 的 store 读写 ⇒ 缺 0045 必须被判「不覆盖」', () => {
  // 夹具完全在内存里：迁移原文、脚本内容、被 import 的模块内容都是构造的，
  // 不碰仓库里的任何文件，也不依赖 0045 是否已经落树（这正是 #630 的真实形状）。
  const fixtureMigrations = [
    {
      name: '0022_community_persistence.sql',
      text: 'CREATE TABLE public.community_moderation_decisions (\n  id uuid PRIMARY KEY\n);\n',
    },
    {
      name: '0045_community_post_review_actor.sql',
      text: 'ALTER TABLE community_moderation_decisions\n  ADD COLUMN decided_by text;\n',
    },
  ];
  const fixtureCreatedBy = collectCreatedTables(fixtureMigrations);
  const fixtureEntries = collectColumnMigrations(fixtureMigrations);
  assert.deepEqual(
    fixtureEntries.map((entry) => `${entry.version} ${entry.table}.${entry.column}@${entry.line}`),
    ['0045 community_moderation_decisions.decided_by@2'],
    '夹具自证：构造的 0045 必须被收成一条 (0045, community_moderation_decisions, decided_by)',
  );

  /** 脚本子集 + 一条 import；脚本自身**不提** decided_by（#630 里那四个脚本就是这样）。 */
  const makeScript = (versions, storeText) => {
    const text =
      `const migrations = all.filter((m) => [${versions.map((v) => `'${v}'`).join(', ')}].includes(m.version));\n`
      + "import { createPostgresCommunityStore } from '../../services/api/src/community/store-pg.ts';\n"
      + 'await createPostgresCommunityStore(pool).insertModerationDecision(row);\n';
    return {
      file: 'community-pg.mjs',
      text,
      subset: new Set(collectSubsetDeclarations(text).flatMap((declaration) => declaration.versions)),
      imports: [{ file: 'services/api/src/community/store-pg.ts', text: storeText }],
    };
  };
  const storeText =
    'INSERT INTO community_moderation_decisions (id, decided_by)\n  VALUES ($1, $2);\n';

  const broken = findCoverageViolations([makeScript(['0001', '0022'], storeText)], fixtureEntries, fixtureCreatedBy);
  assert.equal(
    broken.length === 1,
    true,
    `「脚本不写列名、store 写」这种形态必须恰好判出 1 条违规，实际 ${broken.length} 条：${JSON.stringify(broken)}`,
  );
  // 期望行号由夹具内容现算，不写死（`tests/unit/test-line-anchors-guard.test.mjs` 的口径：
  // 判据里的锚点必须算出来，否则夹具挪一行就假红）。
  const usageLine = storeText.split('\n').findIndex((line) => line.includes('decided_by')) + 1;
  assert.deepEqual(
    `${broken[0].via} ${broken[0].usageFile}:${broken[0].usageLine} `
      + `${broken[0].version} ${broken[0].table}.${broken[0].column}`,
    `import services/api/src/community/store-pg.ts:${usageLine} `
      + '0045 community_moderation_decisions.decided_by',
    '违规条目必须点名「证据在哪个文件:行、经由哪条路径（脚本 or import）、缺哪一版」',
  );

  assert.deepEqual(
    findCoverageViolations([makeScript(['0001', '0022', '0045'], storeText)], fixtureEntries, fixtureCreatedBy),
    [],
    '把 0045 补进子集后必须转绿（否则这条钉只有牙、无法被正确实现满足）',
  );

  // 边界对照：store 里根本没读写这一列时，不该平白索要 0045（否则等于要求全链）。
  assert.deepEqual(
    findCoverageViolations(
      [makeScript(['0001', '0022'], 'INSERT INTO community_moderation_decisions (id) VALUES ($1);\n')],
      fixtureEntries,
      fixtureCreatedBy,
    ),
    [],
    'store 代码没提到这一列时不得判违规（需求侧是共现，不是「有表就要」）',
  );

  // 边界对照 2：表压根不在该脚本的子集里（连建都没建）⇒ 不索要（这是防假红的那道闸）。
  assert.deepEqual(
    findCoverageViolations([makeScript(['0001'], storeText)], fixtureEntries, fixtureCreatedBy),
    [],
    '脚本子集建不出这张表时，不能为它索要列迁移（否则 catalog-pg / source-lifecycle-pg 会假红）',
  );

  // 判定不受行号影响：把子集数组与前导空行一起挪走、把 SQL 换个写法，结论不变。
  const shiftedText =
    '\n\n\n'
    + "import { createPostgresCommunityStore } from '../../services/api/src/community/store-pg.ts';\n"
    + "const migrations = all.filter((m) => ['0001', '0022'].includes(m.version));\n"
    + 'await store.record(row);\n';
  const shifted = [{
    file: 'community-pg.mjs',
    text: shiftedText,
    subset: new Set(collectSubsetDeclarations(shiftedText).flatMap((declaration) => declaration.versions)),
    imports: [{
      file: 'services/api/src/community/store-pg.ts',
      text: 'UPDATE community_moderation_decisions\n  SET decided_by = $2\n  WHERE id = $1;\n',
    }],
  }];
  assert.equal(
    findCoverageViolations(shifted, fixtureEntries, fixtureCreatedBy).length,
    1,
    '换了行位移、SQL 关键字与调用形态后仍要判出 1 条违规（判定按符号，不按行号）',
  );
});

// ---------------------------------------------------------------------------
// 3. rollback 重放面
// ---------------------------------------------------------------------------

test('重放面：回滚 0022 之后必须重新 apply 0030/0032（community-pg 各 2 次：子集 + 重放；0045 落树后同规）', () => {
  assert.deepEqual(
    findReplayViolations(subsetScripts, columnEntries, createdBy).map(
      (violation) =>
        `${violation.script}: rollback ${violation.rollbackVersion}（:${violation.rollbackLine}）`
        + ` DROP 了 ${violation.table}，之后却没有重新 apply ${violation.version}`
        + `（该列由 ${violation.migrationFile} 添加）`,
    ),
    [],
    'rollback 重放面缺迁移：`rollback/0022` 会 DROP 掉 0022 建的 community_* 表，'
      + '重放后必须补 apply 0030/0032（#630 之后是 0045）；缺了就是 42703。',
  );

  const communityPg = subsetScripts.find((script) => script.file === 'community-pg.mjs');
  assert.equal(communityPg !== undefined, true, '必须找到 community-pg.mjs');
  const { applies, rollbacks } = collectApplyEvents(communityPg.text);
  const replayApplies = applies.filter(
    (apply) => rollbacks.length > 0 && apply.index > rollbacks[rollbacks.length - 1].index,
  );
  const countOf = (version) =>
    (communityPg.subset.has(version) ? 1 : 0) + replayApplies.filter((apply) => apply.version === version).length;

  assert.deepEqual(
    ['0030', '0032'].map((version) => `${version}:${countOf(version)}`),
    ['0030:2', '0032:2'],
    'community-pg.mjs 里 0030/0032 必须**各出现 2 次**（子集声明一次 + rollback 0022 之后重放一次），'
      + `实际 ${['0030', '0032'].map((version) => `${version}:${countOf(version)}`).join(' ')}；`
      + `重放段（rollback :${rollbacks.map((rollback) => rollback.line).join(',')} 之后）：`
      + JSON.stringify(replayApplies.map((apply) => `${apply.version}@:${apply.line}`)),
  );

  // 0045 落树后是同一条规则的自然延伸：0045 的列挂在 0022 建的表上 ⇒ 需求自动出现，
  // 这里用内存夹具把那一形态固定下来（不依赖 0045 是否已在树上）。
  const fixtureMigrations = [
    { name: '0022_community_persistence.sql', text: 'CREATE TABLE public.community_moderation_decisions (id uuid);\n' },
    { name: '0045_community_post_review_actor.sql', text: 'ALTER TABLE community_moderation_decisions ADD COLUMN decided_by text;\n' },
  ];
  const fixtureScript = {
    file: 'community-pg.mjs',
    text:
      "const migrations = all.filter((m) => ['0001', '0022'].includes(m.version));\n"
      + "await owner.query(sqlFile('migrations/rollback/0022_community_persistence.down.sql'));\n"
      + "await owner.query(sqlFile('migrations/0022_community_persistence.sql'));\n"
      + "await owner.query('SELECT decided_by FROM community_moderation_decisions');\n",
  };
  fixtureScript.subset = new Set(collectSubsetDeclarations(fixtureScript.text).flatMap((d) => d.versions));
  const replayBroken = findReplayViolations(
    [fixtureScript],
    collectColumnMigrations(fixtureMigrations),
    collectCreatedTables(fixtureMigrations),
  );
  assert.equal(
    replayBroken.length,
    1,
    `「回滚 0022 → 重放 0022 → 用到 decided_by」这种形态必须恰好判出 1 条：${JSON.stringify(replayBroken)}`,
  );
  assert.deepEqual(
    `${replayBroken[0].rollbackVersion}→${replayBroken[0].version} ${replayBroken[0].table}.${replayBroken[0].column}`,
    '0022→0045 community_moderation_decisions.decided_by',
    '重放面必须点名「回滚哪一版、之后缺哪一版」',
  );

  // #630 的真实形状：脚本自己既不写列名、也不写「用到这一列」的 SQL —— 列在它直接 import 的
  // store 里。删掉重放行也必须红（否则这条臂只能抓住自己手写 SQL 的脚本）。
  const storeOnlyText =
    "import { createPostgresCommunityStore } from '../../services/api/src/community/store-pg.ts';\n"
    + "const migrations = all.filter((m) => ['0001', '0022'].includes(m.version));\n"
    + "await owner.query(sqlFile('migrations/rollback/0022_community_persistence.down.sql'));\n"
    + "await owner.query(sqlFile('migrations/0022_community_persistence.sql'));\n"
    + 'await createPostgresCommunityStore(pool).insertModerationDecision(row);\n';
  const storeOnlyScript = {
    file: 'community-pg.mjs',
    text: storeOnlyText,
    subset: new Set(collectSubsetDeclarations(storeOnlyText).flatMap((declaration) => declaration.versions)),
    imports: [{
      file: 'services/api/src/community/store-pg.ts',
      text: 'INSERT INTO community_moderation_decisions (id, decided_by) VALUES ($1, $2);\n',
    }],
  };
  const replayFixtureEntries = collectColumnMigrations(fixtureMigrations);
  const replayFixtureCreatedBy = collectCreatedTables(fixtureMigrations);
  assert.deepEqual(
    findReplayViolations([storeOnlyScript], replayFixtureEntries, replayFixtureCreatedBy).map(
      (violation) => `${violation.rollbackVersion}→${violation.version} ${violation.table}.${violation.column}`,
    ),
    ['0022→0045 community_moderation_decisions.decided_by'],
    '脚本自己没写列名、列在 import 的 store 里时，删掉重放行同样必须被判为「没重放」',
  );
  const replayedText =
    storeOnlyText + "await owner.query(sqlFile('migrations/0045_community_post_review_actor.sql'));\n";
  assert.deepEqual(
    findReplayViolations(
      [{
        ...storeOnlyScript,
        text: replayedText,
        subset: new Set(collectSubsetDeclarations(replayedText).flatMap((declaration) => declaration.versions)),
      }],
      replayFixtureEntries,
      replayFixtureCreatedBy,
    ),
    [],
    '在回滚点之后补上 0045 的 apply 后必须转绿（否则这条臂只有牙、无法被正确实现满足）',
  );
});

// ---------------------------------------------------------------------------
// 4. 脚本引用的回滚件真实存在
// ---------------------------------------------------------------------------

test('回滚件存在：子集脚本引用的 rollback/ 版本恰是这五个，且 up/down 两件都在盘上', () => {
  const referenced = new Map();
  for (const script of subsetScripts) {
    for (const rollback of collectApplyEvents(script.text).rollbacks) {
      const known = referenced.get(rollback.version) ?? new Set();
      known.add(script.file);
      referenced.set(rollback.version, known);
    }
  }
  const versions = [...referenced.keys()].sort();
  assert.deepEqual(
    versions,
    [...EXPECTED_ROLLBACK_VERSIONS],
    '子集脚本引用的 rollback 版本集合变了：实际 '
      + `${JSON.stringify(versions)}（${[...referenced].map(([v, files]) => `${v}←${[...files].join('/')}`).join(', ')}）`
      + `，基线 ${JSON.stringify([...EXPECTED_ROLLBACK_VERSIONS])}`,
  );

  const rollbackFiles = readdirSync(join(REPO_ROOT, MIGRATIONS_DIR, 'rollback'));
  const missing = [];
  for (const version of versions) {
    const down = rollbackFiles.filter((name) => name.startsWith(`${version}_`) && name.endsWith('.down.sql'));
    const up = migrationFiles.filter((file) => file.name.startsWith(`${version}_`));
    if (down.length !== 1) missing.push(`rollback/${version}_*.down.sql 命中 ${down.length} 个（应为 1）`);
    if (up.length !== 1) missing.push(`${MIGRATIONS_DIR}/${version}_*.sql 命中 ${up.length} 个（应为 1）`);
  }
  assert.deepEqual(
    missing,
    [],
    '被 integration 脚本引用的迁移/回滚件必须各恰好 1 份：\n  ' + missing.join('\n  '),
  );
});

// ---------------------------------------------------------------------------
// 5. 反向：孤儿列
// ---------------------------------------------------------------------------

test('反向臂：每条 ADD COLUMN 的列都必须被迁移目录之外的代码认识（today 0 条孤儿列）', () => {
  assert.equal(
    codeFiles.length >= CODE_FILE_FLOOR,
    true,
    `反向臂只扫到 ${codeFiles.length} 个代码文件，低于基线 ${CODE_FILE_FLOOR}（walk 走空了？）`,
  );
  assert.deepEqual(
    orphanColumns,
    [],
    '迁移加了列，但迁移目录之外没有任何代码同时提到这张表与这个列名 '
      + '（多半是列名拼错/改名没跟上，或列加了没人用）：\n  '
      + orphanColumns.join('\n  '),
  );

  // 反例优先：把 0045 的列名改掉，孤儿臂必须红。
  const brokenMigrations = [
    { name: '0022_community_persistence.sql', text: 'CREATE TABLE public.community_moderation_decisions (id uuid);\n' },
    { name: '0045_community_post_review_actor.sql', text: 'ALTER TABLE community_moderation_decisions ADD COLUMN decided_by_v2 text;\n' },
  ];
  const brokenEntries = collectColumnMigrations(brokenMigrations);
  const consumers = [
    {
      file: 'services/api/src/community/store-pg.ts',
      text: 'SELECT decided_by FROM community_moderation_decisions',
    },
  ];
  assert.deepEqual(
    findOrphanColumns(brokenEntries, consumers),
    ['0045 community_moderation_decisions.decided_by_v2'],
    '迁移里的列名与代码里的列名不一致时必须被孤儿臂抓到（这条臂就是「改迁移里的列名」的反例控制）',
  );
});
