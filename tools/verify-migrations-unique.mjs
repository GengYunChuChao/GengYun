#!/usr/bin/env node
/**
 * R30 · 迁移编号唯一门禁 —— **纯静态**：⛔ 不连库、不写任何文件、不联网、无第三方依赖。
 *
 * 为什么要它（两个真实案例）：
 *   ① `main` 当前最大号是 `0027_admin_audit_observability.sql`；`#434` 带着
 *      `0028_governance_audit_log.sql`；更早一次未完成的 i18 工作树上还躺着一个**未提交**的
 *      `0028_admin_scope_authority.sql`（抢救件：`.pg17/tmp/cleanup-r30-evidence/i18-batch3/migrations/`，
 *      含同名 `.down.sql`）。两条 `0028_*` 一旦落进同一个 `services/api/db/migrations/`：
 *        · 文件路径不同 ⇒ git **无文本冲突**，GitHub 判 `MERGEABLE`；
 *        · `services/api/src/db/migrate.ts:44` 的 `MIGRATION_PATTERN` 会把两条都发现出来，
 *          `:72` 确定性抛「迁移版本号重复：0028 同时出现在 <a> 与 <b>」；
 *        · 而 `schema_migrations.version` 是 `PRIMARY KEY`（`migrate.ts:108`）⇒ 真库一跑就红。
 *      ⇒ 「红」发生在**运行时**：起真库之前，任何静态门禁的绿都说明不了这件事。本脚本把这层
 *      静态判据补上，由 `.github/workflows/migrations-guard.yml` 在每个 PR 上执行。
 *   ② `tests/unit/migrations-rollback-pairing.test.mjs` 按**前缀分组**做配对，因此
 *      「同号两条正向文件、各自带一份 down」在它那里是**一个桶里的两份 down**，与
 *      「同一条迁移写了两遍」不可区分；`release-materials-index` 那条数量不变量更是看不出来。
 *
 * 判据与严重度（退出码：0 = 通过，1 = 有硬错，2 = 用法错误）：
 *
 *   ── 硬错：任何模式都判红 ───────────────────────────────────────────────────
 *   [surface]  扫描面：`<dir>` 顶层 `.sql` 必须合 `^\d{4}_.*\.sql$`，且**至少 1 条**
 *              （扫到 0 条按红处理 ——「什么都没扫到」也是一种绿，不能放行）；顶层不得出现
 *              `.down.sql`（它既不是正向迁移，也永远不会被当回滚执行）。后缀大小写不是小写
 *              `.sql` 的条目同样判红：运行器只认小写 ⇒ 那些文件会被静默跳过。
 *   [runner]   守卫与**产品发现器**必须看到同一批文件。口径逐字抄自
 *              `services/api/src/db/migrate.ts:44` 的 `/^(\d{4,})_([a-z0-9_]+)\.sql$/`（见
 *              `RUNNER_PATTERN_SOURCE`）。两个集合不等 ⇒ 红并点名差集：
 *              守卫数与运行器数不一致时，「守卫绿」是没有意义的。
 *   [dup]      同一 4 位号不得被两个及以上**正向**文件占用。这正是案例①的形态：git 看不出冲突，
 *              运行器会抛「迁移版本号重复」，`schema_migrations.version` 主键再补一刀。
 *
 *   ── 默认只 warn：`--strict` 才升为退出码 1 ────────────────────────────────
 *   [coexist]  同一号只能在顶层出现一次（[dup] 已覆盖「两份正向」）；`rollback/` **只收**
 *              `<NNNN>_<name>.down.sql` —— 往 `rollback/` 放正向形态的 `.sql`、或给同一号补
 *              第二份 `.down.sql`，都判红。这是把第二条同号迁移「藏起来」的两种典型形态：
 *              放进去的文件既不会被当回滚执行，也不会被运行器发现，两份同号就此共存而无人察觉。
 *   [rollback] 每个正向编号要么有 `rollback/<同名>.down.sql`，要么在 `NO_ROLLBACK` 里显式登记
 *              「允许缺省」（理由 ≥ 20 字）。孤儿回滚、同号 down 与正向名不一致、登记过期
 *              （已有 down / 迁移已不存在 / 理由占位）都报 warn。
 *   [gap]      **首尾之间**的缺号（`min+1..max-1`）默认只 warn，但每个缺号都要在迁移目录下的
 *              `*.md`（README/说明）里找到「故意跳过」的依据（同一行同时出现该号与
 *              ／跳过｜预留｜skip｜未使用…／字样）。找不到依据 ⇒ `WARN[gap]` 点名，`--strict` 才红。
 *              低于首号的前缀**不算缺口**（目录从 `0100` 起只是编号空间还没走到那里；把它算成
 *              100 个缺口只会把真缺口埋掉），只打一行读数。
 *
 * 为什么分两档（2026-10-22 收窄口径）：`dup` 是真事故形态（两条 `0028_*` 在 git 里不冲突、
 *   运行时才炸），必须硬红；而 `rollback/` 目前**不是**全仓普遍约定、缺号在跨 PR 乱序合并时
 *   （0028 在 #434、0029 在别的片）也是常态 —— 这两档当硬错会让既有 27 条迁移与无关 PR 每次
 *   全红，红到没人看门禁就等于没有门禁。所以：默认只 warn 并逐条点名，需要收紧的场合加
 *   `--strict`（CI 里刻意不传，见 `.github/workflows/migrations-guard.yml`）。
 *
 * 软档 findings 的**可见性**（2026-10-26 补，R68-D12）：默认只 warn 的代价是它们容易沉在日志里，
 *   于是 `--annotations` 会把每条软档项额外打成 GitHub 注解（`::warning title=…::…`），
 *   **只加注解、不改退出码**。CI 的判决步就带这个开关 —— 于是「不判错」与「看得见」同时成立。
 *   `--json` 时注解被刻意吞掉（机读契约优先，stdout 必须是纯 JSON）。
 *   ⚠ 也别改成嗅 `GITHUB_ACTIONS` 自动开注解：那变量注入整个 job，夹具产出的软档项会混进
 *   单测 stdout。实测口径（2026-10-28 复核）：**只在同时去掉 `!json` 门时**才真的破坏 `--json`
 *   契约（去掉后 `tests/unit/ci-migrations-guard-annotations.test.mjs` 变 27 pass / 4 fail；
 *   保留 `!json` 门时 30 pass / 1 fail，红的那条是自证「不加开关就该 0 条 `::`」）。也就是说
 *   「`--json` 优先」这条门是必需件，光靠「不嗅环境变量」并不足够 —— 两件都要。
 *
 * 刻意**不做**（不冒充能力）：
 *   · 不执行任何 `.sql`、不判断迁移内容能否跑通（真执行由 `tests/integration/*-pg.mjs` 覆盖）；
 *   · 不判断 down 与 up 语义互逆（配对口径见 `tests/unit/migrations-rollback-pairing.test.mjs`）；
 *   · 不查**跨分支的预留号**：`#434` 的 `0028` 不在本分支目录里，静态扫不到。本门禁的价值是
 *     「两条同号一旦进了**同一个目录**就立刻红」，而不是「查谁能占下一个号」；
 *   · 不查「缺号到底该不该存在」：只要求缺号在迁移目录下的 `*.md` 里有**一行**可核证的
 *     「故意跳过」依据，不判断那依据是否合理（那是 review 的事）。
 *
 * 用法：
 *   node tools/verify-migrations-unique.mjs                # 扫仓内默认目录（套用 NO_ROLLBACK）
 *   node tools/verify-migrations-unique.mjs --dir <目录>    # 扫指定目录（负控制/夹具用；不套用本仓登记）
 *   node tools/verify-migrations-unique.mjs --json          # 机读：duplicates[] / gaps[] /
 *                                                           #   rollbackIssues[] / counts{}（退出码同上）
 *   node tools/verify-migrations-unique.mjs --strict        # 缺号与回滚问题一并升为退出码 1
 *   node tools/verify-migrations-unique.mjs --annotations   # 软档项另打 ::warning:: 注解（不改退出码）
 *   node tools/verify-migrations-unique.mjs --help
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本脚本自身位置推出（`tools/` 的上一级），⛔ 不用 `process.cwd()`。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 默认扫描目录：与产物 `services/api/src/db/migrate.ts:42` 的 `DEFAULT_MIGRATIONS_DIR` 同一处。 */
export const DEFAULT_MIGRATIONS_DIR = join(REPO_ROOT, 'services', 'api', 'db', 'migrations');

/**
 * 扫描面形态（派单口径 `^\d{4}_.*\.sql$`）。取分组是为了拿到基名 —— 「回滚脚本必须与正向迁移
 * 同名」那条判据要用它拼期望的文件名。
 */
export const SCAN_PATTERN = /^(\d{4})_(.+)\.sql$/;

/**
 * 产品发现器正则的**源码**：逐字抄自 `services/api/src/db/migrate.ts:44`
 * （`const MIGRATION_PATTERN = /^(\d{4,})_([a-z0-9_]+)\.sql$/;`）。
 *
 * 刻意不 `import` 那个 `.ts`：本脚本要在裸 `node` 上直接跑（不依赖 TS 转译/构建产物）。
 * 口径漂移由 `tests/unit/verify-migrations-unique.test.mjs` 承担：它读 `migrate.ts` 原文，
 * 把 `MIGRATION_PATTERN` 的正则体与这个常量**逐字**比对 —— 改了那边没改这边，测试先红。
 */
export const RUNNER_PATTERN_SOURCE = String.raw`^(\d{4,})_([a-z0-9_]+)\.sql$`;

/** 产品发现器的等价正则（由上面的源码构造，两者不可能不一致）。 */
export const RUNNER_PATTERN = new RegExp(RUNNER_PATTERN_SOURCE);

/** 回滚文件名形态：`<NNNN>_<name>.down.sql`。 */
export const ROLLBACK_PATTERN = /^(\d{4})_(.+)\.down\.sql$/;

/** 登记理由的最短长度：占位符（「无」「待补」「TODO」）一律过不了这条。 */
const MIN_REASON_LENGTH = 20;

/**
 * 显式登记为「允许缺省回滚」的编号 —— 编号 → 一句可核证的理由。
 *
 * `0001` 与 `tests/unit/migrations-rollback-pairing.test.mjs:57-65` 的 `EXEMPT` 是同一条，
 * 理由也来自同一处可核证判定（`docs/verification/gy-r28-migration-rollback-pairing-20261021.md` §4）：
 * 0001 是全库地板（15 个枚举 / 20 张表），0002..0027 全部建在它之上，既有 down 一律**显式保留**
 * 其对象；它的 down 只等于清库（连 `db/seeds` 字典数据），故作为「回滚一步」不可执行。
 * ⛔ 新增条目必须同时给出可核证理由并更新证据页，不允许悄悄长出来（登记过期也会判红）。
 */
export const NO_ROLLBACK = new Map([
  [
    '0001',
    '全库地板：建 15 个枚举 / 20 张表，0002..0027 全部建在其上且既有 down 一律显式保留其对象；'
      + '它的 down 只等于清库（连 db/seeds 字典数据），故作为「回滚一步」不可执行；'
      + '可逆性判定见 docs/verification/gy-r28-migration-rollback-pairing-20261021.md §4',
  ],
]);

/** 判据编号（也是报告里 `FAIL[<id>]` / `WARN[<id>]` 的前缀与证据页判据表的键）。 */
export const CRITERIA = ['surface', 'runner', 'dup', 'coexist', 'rollback'];

/** 硬错：任何模式下都判红（扫描面自身坏了 / 守卫与运行器口径不一致 / 同号两份正向文件）。 */
export const HARD_CRITERIA = new Set(['surface', 'runner', 'dup']);

/** 默认只 warn：`--strict` 才升为退出码 1（回滚配对与 rollback/ 形态，见文件头「为什么分两档」）。 */
export const SOFT_CRITERIA = new Set(['coexist', 'rollback']);

/**
 * 「故意跳过」依据的判定词：缺号那一行必须同时出现该号与其中任一词。
 *
 * 要求「同一行同时命中」而不是「全文提到该号」：后者太松 —— 一份 README 里列了一长串
 * `0001..0027` 的目录，任何缺号都会「看起来有依据」。宁可让人多写一行，也不要一个恒真的判据。
 */
const SKIP_EVIDENCE_PATTERN = /跳过|预留|预占|未使用|不使用|留空|不占用|空缺|skip|reserved|unused/i;

/** 目录判定：不抛异常，不存在/不是目录都返回 false。 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 两个路径是否指向同一个目录（`realpath` 归一化；Windows 下大小写不敏感）。 */
function isSameDirectory(left, right) {
  const normalize = (path) => {
    let resolved;
    try {
      resolved = realpathSync(path);
    } catch {
      resolved = resolve(path);
    }
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

/**
 * 列目录下的 `.sql` 条目。
 *
 * 后缀**区分大小写**：`0001_X.SQL` 与 `0001_x.sql` 在 Linux/CI 上是两个不同文件，而运行器只认
 * 小写 `\.sql$` ⇒ 大写后缀的迁移对运行器**完全隐形**、静默不执行。所以这里把它单独挑出来判红，
 * 而不是当「不是 .sql」忽略掉。
 *
 * @param {string} dir
 * @returns {{ files: string[], notRegular: string[], wrongCase: string[] }} 三个数组都按名升序
 */
function listSqlEntries(dir) {
  const files = [];
  const notRegular = [];
  const wrongCase = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.endsWith('.sql')) {
      if (entry.isFile()) files.push(entry.name);
      else notRegular.push(entry.name);
      continue;
    }
    if (entry.name.toLowerCase().endsWith('.sql')) wrongCase.push(entry.name);
  }
  files.sort();
  notRegular.sort();
  wrongCase.sort();
  return { files, notRegular, wrongCase };
}

/**
 * 列迁移目录下的说明文件（`*.md`）——「缺号有依据」这条判据只认这里。
 *
 * 刻意只扫 `<migrationsDir>/*.md`（不递归、不读仓外）：判据的效力来自「依据和迁移放在一起」，
 * 一份藏在别处、谁也不会顺路看见的说明等于没有依据。目前仓里一条 `.md` 都没有 ⇒ 缺号会一律
 * 落在「未登记」，这是对的（现在确实没有任何缺号登记）。
 *
 * @param {string} dir
 * @returns {string[]} 文件名（不含目录），按名升序
 */
function listDocSources(dir) {
  if (!isDirectory(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

/**
 * 在说明文件里找某个缺号的「故意跳过」依据。
 *
 * @param {string} dir 迁移目录
 * @param {string} number 四位号
 * @param {string[]} sources `listDocSources()` 的结果
 * @returns {{ file: string, line: number, text: string } | null} 命中的第一行
 */
function findGapEvidence(dir, number, sources) {
  // 边界用「前后不是数字」而不是 `\b`：`0001` 在 `10001`/`00010` 里不该算命中。
  const token = new RegExp(`(^|[^0-9])${number}([^0-9]|$)`);
  for (const source of sources) {
    let text;
    try {
      text = readFileSync(join(dir, source), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (token.test(line) && SKIP_EVIDENCE_PATTERN.test(line)) {
        return { file: source, line: index + 1, text: line.trim() };
      }
    }
  }
  return null;
}

/**
 * 跑全部判据。只读文件系统，不改任何东西。
 *
 * @param {{ migrationsDir?: string, noRollback?: Map<string, string> }} [options]
 *   `noRollback` 只给夹具/负控制用：默认取 `NO_ROLLBACK`，且**只在扫描默认目录时**套用
 *   （扫 `--dir` 指到的别的目录时按空清单判，否则本仓的登记会在那边的树上变成假红）。
 * @returns {{
 *   ok: boolean,
 *   strict: boolean,
 *   failures: Array<{ id: string, message: string }>,
 *   errors: Array<{ id: string, message: string }>,
 *   rollbackIssues: Array<{ id: string, message: string }>,
 *   undocumentedGaps: string[],
 *   readings: string[],
 *   details: {
 *     migrationsDir: string, rollbackDir: string,
 *     forwardFiles: string[], rollbackFiles: string[],
 *     paired: Array<{ number: string, name: string, rollback: string }>,
 *     exempted: Array<{ number: string, name: string }>,
 *     missing: string[], orphan: string[], mismatched: string[],
 *     duplicated: Array<{ number: string, files: string[] }>,
 *     duplicatedRollback: Array<{ number: string, files: string[] }>,
 *     unregistered: string[], numbers: string[],
 *     gaps: string[],
 *     docSources: string[],
 *     gapDocumentation: Array<{
 *       number: string, documented: boolean,
 *       evidence: { file: string, line: number, text: string } | null,
 *     }>,
 *   },
 * }}
 */
export function verifyMigrations(options = {}) {
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  /**
   * 允许缺省清单的作用域：`NO_ROLLBACK` 是对**本仓** `services/api/db/migrations/` 的登记
   * （`0001` 是全库地板），对 `--dir` 指到的**别的**目录没有意义 —— 那边的 `0001` 可能是另一条
   * 迁移，甚至根本没有。所以：调用方显式传 `noRollback` 就照传的判（夹具/负控制用）；否则只有扫
   * 默认目录时才套用 `NO_ROLLBACK`，扫别的目录按空清单判 —— 否则每个夹具都会被本仓的登记牵连出
   * 一条「登记过期」假红。清单没被套用时打一行读数说明，不让人误以为它失效了。
   */
  const builtinAllowlistApplies = isSameDirectory(migrationsDir, DEFAULT_MIGRATIONS_DIR);
  const noRollback = options.noRollback ?? (builtinAllowlistApplies ? NO_ROLLBACK : new Map());
  /**
   * `--strict`：把「默认只 warn」的三类（[coexist] / [rollback] / 无依据的 [gap]）计入判决。
   * ⛔ 不要把它设成默认值 —— 既有 27 条迁移里 0001 靠 NO_ROLLBACK 豁免、`rollback/` 也不是
   * 全仓约定，默认 strict 会让每个无关 PR 都红（见文件头「为什么分两档」）。
   */
  const strict = options.strict === true;

  /** @type {Array<{ id: string, message: string }>} */
  const failures = [];
  /** @type {string[]} */
  const readings = [];
  const fail = (id, message) => failures.push({ id, message });
  const read = (text) => readings.push(text);

  const rollbackDir = join(migrationsDir, 'rollback');

  /** @type {ReturnType<typeof verifyMigrations>['details']} */
  const details = {
    migrationsDir,
    rollbackDir,
    forwardFiles: [],
    rollbackFiles: [],
    paired: [],
    exempted: [],
    missing: [],
    orphan: [],
    mismatched: [],
    duplicated: [],
    duplicatedRollback: [],
    unregistered: [],
    numbers: [],
    gaps: [],
    docSources: [],
    gapDocumentation: [],
  };
  /**
   * 判决：`failures` 按严重度拆成两档（[surface]/[runner]/[dup] 硬红；[coexist]/[rollback] 只 warn），
   * 再叠上「缺号但没依据」这一档（缺号从不进 `failures` —— 它不是形态错误，只是「必须有依据」）。
   *
   * 非 strict：`ok` 只看硬错 ⇒ 回滚问题与缺号默认不影响退出码。
   * strict：软错与无依据缺号一并算进来 ⇒ 等价于「五条判据 + 缺号依据全部满足」。
   */
  const done = () => {
    const errors = failures.filter((failure) => HARD_CRITERIA.has(failure.id));
    const rollbackIssues = failures.filter((failure) => SOFT_CRITERIA.has(failure.id));
    const undocumentedGaps = details.gapDocumentation
      .filter((gap) => !gap.documented)
      .map((gap) => gap.number);
    const ok = errors.length === 0
      && (!strict || (rollbackIssues.length === 0 && undocumentedGaps.length === 0));
    return {
      ok, strict, failures, errors, rollbackIssues, undocumentedGaps, readings, details,
    };
  };

  // ── [surface] 前置：目录本身 ─────────────────────────────────────────────────
  if (!isDirectory(migrationsDir)) {
    fail(
      'surface',
      `找不到迁移目录：${migrationsDir}\n`
        + '  ⇒ 守着一个不存在的目录只会「扫到 0 条 ⇒ 全绿」，这是门禁最常见的假绿形态，故直接红。',
    );
    return done();
  }

  const top = listSqlEntries(migrationsDir);
  const rollbackDirExists = isDirectory(rollbackDir);
  const rollbackEntries = rollbackDirExists
    ? listSqlEntries(rollbackDir)
    : { files: [], notRegular: [], wrongCase: [] };

  details.rollbackFiles = rollbackEntries.files;

  if (!rollbackDirExists) {
    fail(
      'rollback',
      `找不到回滚目录：${rollbackDir}\n`
        + '  ⇒「每个正向编号要么有 rollback/<同名>.down.sql、要么在允许缺省清单里」这条判据'
        + '没有目录就无法成立，故直接红（不按「全都没有 down」放行）。',
    );
  }

  // ── [surface] 扫描面 ────────────────────────────────────────────────────────
  if (top.notRegular.length > 0) {
    fail(
      'surface',
      `顶层有 ${top.notRegular.length} 个不是常规文件的 .sql 条目（目录/符号链接等）：`
        + `${top.notRegular.join('、')}\n`
        + '  ⇒ 运行器按 `entry.isFile()` 过滤，这些条目它看不见；留一个「人能看见、迁移不执行」的条目等于埋雷。',
    );
  }
  if (top.wrongCase.length > 0) {
    fail(
      'surface',
      `顶层有 ${top.wrongCase.length} 个后缀大小写不是小写 .sql 的条目：${top.wrongCase.join('、')}\n`
        + '  ⇒ 运行器只认 `.endsWith(\'.sql\')` ⇒ 这些文件会被**静默跳过**（CI 上 Linux 大小写敏感，'
        + '本机 Windows 上却是同一个文件，最容易在本地全绿、CI 全不执行）。',
    );
  }

  /** @type {Array<{ name: string, number: string, base: string }>} */
  const forward = [];
  const topDown = [];
  const illNamed = [];
  for (const name of top.files) {
    // `.down.sql` 也合 `^\d{4}_.*\.sql$`（`.*` 覆盖 `.down`），所以必须先单独拦掉它。
    if (name.endsWith('.down.sql')) {
      topDown.push(name);
      continue;
    }
    const match = SCAN_PATTERN.exec(name);
    if (match === null) {
      illNamed.push(name);
      continue;
    }
    forward.push({ name, number: match[1], base: match[2] });
  }
  details.forwardFiles = forward.map((entry) => entry.name);

  if (topDown.length > 0) {
    fail(
      'surface',
      `顶层出现回滚文件（.down.sql 只属于 rollback/）：${topDown.join('、')}\n`
        + '  ⇒ 它既不是正向迁移、也永远不会被当回滚执行；放在顶层只会让「同号有两个文件」'
        + '看起来像已经有一条迁移。',
    );
  }
  if (illNamed.length > 0) {
    fail(
      'surface',
      `顶层文件名不合 ^\\d{4}_.*\\.sql$：${illNamed.join('、')}\n`
        + '  ⇒ 运行器的 ^(\\d{4,})_([a-z0-9_]+)\\.sql$ 同样认不出它 ⇒ 它永远不会被执行，'
        + '却让人以为这条迁移已经在仓里了。',
    );
  }
  if (forward.length === 0) {
    fail(
      'surface',
      `扫描面为空：${migrationsDir} 下没有任何合 ^\\d{4}_.*\\.sql$ 的正向迁移\n`
        + '  ⇒ 扫到 0 条时后面四条判据会全部「通过」——那是假绿；按反空转口径直接红。',
    );
  }

  read(
    `[surface]  顶层 .sql ${top.files.length} 条：合 ^\\d{4}_.*\\.sql$ 的正向迁移 ${forward.length} 条`
      + ` / 不合规 ${illNamed.length} 条 / 顶层 .down.sql ${topDown.length} 条`,
  );

  // ── [runner] 守卫扫描面必须等于产品发现器 ───────────────────────────────────
  const guardSet = new Set(forward.map((entry) => entry.name));
  const runnerSet = new Set(top.files.filter((name) => RUNNER_PATTERN.test(name)));
  const onlyGuard = [...guardSet].filter((name) => !runnerSet.has(name)).sort();
  const onlyRunner = [...runnerSet].filter((name) => !guardSet.has(name)).sort();

  if (onlyGuard.length > 0 || onlyRunner.length > 0) {
    fail(
      'runner',
      '守卫与产品发现器（services/api/src/db/migrate.ts:44 的 ^(\\d{4,})_([a-z0-9_]+)\\.sql$）'
        + '看到的不是同一批文件：\n'
        + onlyGuard
          .map((name) => `  · 只有守卫看得见（运行器会抛「迁移文件名不合规」）：${name}`)
          .join('\n')
        + (onlyGuard.length > 0 ? '\n' : '')
        + onlyRunner
          .map((name) => `  · 只有运行器看得见（守卫放过、不判唯一）：${name}`)
          .join('\n')
        + (onlyRunner.length > 0 ? '\n' : '')
        + '  ⇒ 差集非空时，「守卫绿」不代表「迁移会按你数的那批执行」。',
    );
  }
  read(
    `[runner]   守卫 ${guardSet.size} 条 ↔ 产品发现器 ${runnerSet.size} 条：`
      + `差集 ${onlyGuard.length + onlyRunner.length} 条`,
  );

  // ── [dup] 同一 4 位号不得被两个及以上正向文件占用 ────────────────────────────
  /** @type {Map<string, string[]>} */
  const byNumber = new Map();
  for (const entry of forward) {
    const bucket = byNumber.get(entry.number) ?? [];
    bucket.push(entry.name);
    byNumber.set(entry.number, bucket);
  }
  const numbers = [...byNumber.keys()].sort();
  details.numbers = numbers;
  const duplicatedNumbers = numbers.filter((number) => byNumber.get(number).length > 1);
  details.duplicated = duplicatedNumbers.map((number) => ({
    number,
    files: [...byNumber.get(number)].sort(),
  }));

  if (duplicatedNumbers.length > 0) {
    const maxNumber = numbers[numbers.length - 1];
    const nextFree = String(Math.max(...numbers.map(Number)) + 1).padStart(4, '0');
    fail(
      'dup',
      `同一 4 位号被两个及以上正向文件占用（${duplicatedNumbers.length} 个号）：\n`
        + duplicatedNumbers
          .map((number) => {
            const files = [...byNumber.get(number)].sort();
            return `  · ${number}：${files.join('、')}\n`
              + '    ⇒ services/api/src/db/migrate.ts:72 会确定性抛'
              + `「迁移版本号重复：${number} 同时出现在 ${files[0]} 与 ${files[1]}」；`
              + '两条分支的文件路径不同 ⇒ git 无文本冲突、GitHub 判 MERGEABLE，'
              + '而 schema_migrations.version 是主键（migrate.ts:108）⇒ 只有真库会红。\n'
              + `    补救：后合的一方改号为下一个可用号（当前最大号 ${maxNumber} ⇒ 空位 ${nextFree}），`
              + '并同步改 rollback/ 与证据页；⛔ 不要靠「合入顺序」当方案。';
          })
          .join('\n'),
    );
  }
  read(
    `[dup]      ${forward.length} 条正向迁移占用 ${numbers.length} 个编号`
      + `（${numbers.length === 0 ? '(无)' : `${numbers[0]}..${numbers[numbers.length - 1]}`}）：`
      + `同号多文件 ${duplicatedNumbers.length} 处`,
  );

  // ── [coexist] same-number coexistence：rollback/ 只收 .down.sql ─────────────
  if (rollbackEntries.notRegular.length > 0 || rollbackEntries.wrongCase.length > 0) {
    fail(
      'coexist',
      `rollback/ 里有非常规文件或后缀大小写异常的 .sql 条目：`
        + `${[...rollbackEntries.notRegular, ...rollbackEntries.wrongCase].sort().join('、')}\n`
        + '  ⇒ 「回滚只收 <NNNN>_<name>.down.sql」这条判据要求这里每一条都能被逐字配对，'
        + '认不出形态的条目会让配对结果不可信。',
    );
  }

  /** @type {Map<string, string[]>} */
  const rollbackByNumber = new Map();
  const notDownForm = [];
  for (const name of rollbackEntries.files) {
    const match = ROLLBACK_PATTERN.exec(name);
    if (match === null) {
      notDownForm.push(name);
      continue;
    }
    const bucket = rollbackByNumber.get(match[1]) ?? [];
    bucket.push(name);
    rollbackByNumber.set(match[1], bucket);
  }
  const duplicatedRollbackNumbers = [...rollbackByNumber.keys()]
    .filter((number) => rollbackByNumber.get(number).length > 1)
    .sort();
  details.duplicatedRollback = duplicatedRollbackNumbers.map((number) => ({
    number,
    files: [...rollbackByNumber.get(number)].sort(),
  }));

  if (notDownForm.length > 0) {
    fail(
      'coexist',
      `rollback/ 里出现不合 <NNNN>_<name>.down.sql 的 .sql（${notDownForm.length} 条）：`
        + `${notDownForm.sort().join('、')}\n`
        + '  ⇒ 正向形态（或缺 .down 后缀）的文件放进 rollback/，等于给「同号两条迁移」开后门：'
        + '它既不会被当回滚执行，也不会被运行器当正向迁移发现，两份同号就此共存而无人察觉。',
    );
  }
  if (duplicatedRollbackNumbers.length > 0) {
    fail(
      'coexist',
      `同一编号出现多份 .down.sql（${duplicatedRollbackNumbers.length} 个号）：\n`
        + duplicatedRollbackNumbers
          .map((number) => `  · ${number}：${[...rollbackByNumber.get(number)].sort().join('、')}`)
          .join('\n')
        + '\n  ⇒ 正常形态是「一条正向迁移 ↔ 一份同名 down」。同号两份 down 通常意味着'
        + '同一条迁移被写了两遍，或有人把第二条同号迁移的回滚混了进来'
        + '（那第二条正向文件正是 [dup] 要抓的形态）。',
    );
  }
  read(
    `[coexist]  rollback/ .sql ${rollbackEntries.files.length} 条：合 <NNNN>_<name>.down.sql `
      + `${rollbackEntries.files.length - notDownForm.length} 条 / 同号多份 ${duplicatedRollbackNumbers.length} 处`,
  );

  // ── [rollback] 正向编号 ↔ 同名 down（或显式登记允许缺省） ────────────────────
  const rollbackNames = new Set(rollbackEntries.files);
  const mismatched = [];
  for (const entry of forward) {
    const expected = `${entry.number}_${entry.base}.down.sql`;
    if (rollbackNames.has(expected)) {
      details.paired.push({ number: entry.number, name: entry.name, rollback: expected });
      continue;
    }
    const siblings = rollbackByNumber.get(entry.number) ?? [];
    if (siblings.length > 0) {
      mismatched.push(`${entry.name} ↔ ${[...siblings].sort().join('、')}（同号的 down 应叫 ${expected}）`);
      continue;
    }
    if (noRollback.has(entry.number)) {
      details.exempted.push({ number: entry.number, name: entry.name });
      continue;
    }
    details.missing.push(entry.name);
  }
  details.mismatched = mismatched;

  if (mismatched.length > 0) {
    fail(
      'rollback',
      `回滚文件名与正向迁移成对但不同名（${mismatched.length} 处）：\n`
        + mismatched.map((line) => `  · ${line}`).join('\n')
        + '\n  ⇒ 回滚脚本必须与被回滚的那条迁移同名（只多一个 .down），否则「有回滚」是假象：'
        + '演练时会拿另一条迁移的 down 去跑。',
    );
  }
  if (details.missing.length > 0) {
    fail(
      'rollback',
      `缺回滚且未登记为允许缺省（${details.missing.length} 条）：${details.missing.join('、')}\n`
        + '  ⇒ 补救：同时新增 rollback/<同名>.down.sql；确属不可回滚的（如全库地板）才在 NO_ROLLBACK'
        + ` 登记，理由 ≥ ${MIN_REASON_LENGTH} 字并更新证据页。`,
    );
  }

  details.orphan = [...rollbackByNumber.keys()].filter((number) => !byNumber.has(number)).sort();
  if (details.orphan.length > 0) {
    fail(
      'rollback',
      `孤儿回滚（有 down 无正向迁移）：${details.orphan.join('、')}\n`
        + '  ⇒ 正向迁移被删/改名而 down 留着，回滚目录会指向一个不存在的步骤。',
    );
  }

  // 扫描面为空时，**每一条**登记都会显得「过期」（正向迁移一条都没有）——那是与 [surface]
  // 同一个根因；再报 N 次只会把「目录是空的」这条真因埋掉，故此时只由 [surface] 说话。
  const staleRegistrations = [];
  const registrationsToCheck = forward.length === 0 ? new Map() : noRollback;
  for (const [number, reason] of registrationsToCheck) {
    const problems = [];
    if (!byNumber.has(number)) {
      problems.push('已不是任何正向迁移的编号（迁移被删或改了号）');
    } else if ((rollbackByNumber.get(number) ?? []).length > 0) {
      problems.push(`该号已有回滚 ${[...rollbackByNumber.get(number)].sort().join('、')}，登记必须删掉`);
    }
    if (typeof reason !== 'string' || reason.trim().length < MIN_REASON_LENGTH) {
      problems.push(`理由不足 ${MIN_REASON_LENGTH} 字或为空（占位符不算登记）`);
    }
    if (problems.length > 0) staleRegistrations.push(`  · ${number}：${problems.join('；')}`);
  }
  details.unregistered = staleRegistrations;
  if (staleRegistrations.length > 0) {
    fail(
      'rollback',
      `NO_ROLLBACK 登记过期（${staleRegistrations.length} 条）：\n${staleRegistrations.join('\n')}\n`
        + '  ⇒ 过期登记会变成一张永久通行证：它先盖住一份真实的 down，再在迁移消失后继续放行。',
    );
  }

  read(
    `[rollback] 已配对 ${details.paired.length} 条 / 允许缺省 ${details.exempted.length} 条`
      + `${details.exempted.length === 0 ? '' : `（${details.exempted.map((item) => item.number).join('、')}）`}`
      + ` / 缺回滚 ${details.missing.length} 条 / 孤儿回滚 ${details.orphan.length} 条`,
  );
  if (options.noRollback === undefined && !builtinAllowlistApplies && NO_ROLLBACK.size > 0) {
    read(
      `[读数]     允许缺省清单：本仓登记 ${NO_ROLLBACK.size} 条（${[...NO_ROLLBACK.keys()].sort().join('、')}），`
        + '但扫描目录不是默认目录 ⇒ 不套用（本仓的登记在别的树上没有意义；需要时请显式传 noRollback）',
    );
  }

  // ── [gap] 编号连续性：默认只 warn，但每个缺号都要有「故意跳过」的依据 ──────────
  // 口径：只算**首尾之间**的空位（min+1..max-1）。低于首号的前缀不算缺口 —— 目录从 0100 起
  // 只是编号空间还没走到那里（夹具即如此），把它算成 99 个缺口只会把真缺口埋掉。
  const sortedValues = numbers.map(Number).sort((left, right) => left - right);
  const minValue = sortedValues.length === 0 ? 0 : sortedValues[0];
  const maxValue = sortedValues.length === 0 ? 0 : sortedValues[sortedValues.length - 1];
  const present = new Set(sortedValues);
  for (let value = minValue + 1; value < maxValue; value += 1) {
    if (!present.has(value)) details.gaps.push(String(value).padStart(4, '0'));
  }

  details.docSources = listDocSources(migrationsDir);
  details.gapDocumentation = details.gaps.map((number) => {
    const evidence = findGapEvidence(migrationsDir, number, details.docSources);
    return { number, documented: evidence !== null, evidence };
  });
  const undocumentedGaps = details.gapDocumentation.filter((gap) => !gap.documented);

  const gapsText = numbers.length === 0
    ? '(无)'
    : details.gaps.length === 0
      ? `${numbers[0]}..${numbers[numbers.length - 1]} 连续（首尾之间无缺口）`
      : `${numbers[0]}..${numbers[numbers.length - 1]} 缺 ${details.gaps.length} 个：`
        + `${details.gaps.slice(0, 8).join('、')}${details.gaps.length > 8 ? ' …' : ''}`
        + `（已登记依据 ${details.gaps.length - undocumentedGaps.length} / 未登记 ${undocumentedGaps.length}）`;
  read(
    `[gap]      编号连续性：${gapsText}`
      + '（缺号默认只 warn；依据 = 迁移目录下 *.md 里同行的「跳过/预留」说明）',
  );
  read(
    `[gap]      「故意跳过」依据扫描面：${details.docSources.length === 0
      ? '迁移目录下没有任何 .md（README/说明）⇒ 任何缺号都算未登记'
      : details.docSources.join('、')}`,
  );
  if (numbers.length > 0 && minValue !== 1) {
    read(`[gap]      起始号 ${numbers[0]}（不是 0001）：前缀不计入缺口，只作读数`);
  }

  return done();
}

/** 把一次校验渲染成可贴进证据页的文本（读数 + 逐条配对 + 判决）。 */
export function renderReport(result) {
  const lines = [`迁移编号唯一门禁（R30 · 纯静态）· 目录 ${result.details.migrationsDir}`];
  if (result.strict) lines.push('[模式]     --strict：回滚问题与无依据缺号一并计入判决');
  lines.push(...result.readings);

  const rows = [];
  for (const pair of result.details.paired) {
    rows.push(`  ${pair.number}  ${pair.name}  ← rollback/${pair.rollback}`);
  }
  for (const exempt of result.details.exempted) {
    rows.push(`  ${exempt.number}  ${exempt.name}  （登记为允许缺省，见 NO_ROLLBACK）`);
  }
  for (const name of result.details.missing) rows.push(`  ${name}  ✗ 缺回滚`);
  if (rows.length > 0) {
    lines.push('[逐条] 正向迁移 ↔ 回滚');
    lines.push(...rows.sort());
  }

  const documented = result.details.gapDocumentation.filter((gap) => gap.documented);
  const undocumented = result.details.gapDocumentation.filter((gap) => !gap.documented);
  if (documented.length > 0) {
    lines.push(
      `[gap] 缺号有「故意跳过」依据（${documented.length} 个）：`
        + documented.map((gap) => `${gap.number} → ${gap.evidence.file}:${gap.evidence.line}`).join('、'),
    );
  }
  if (undocumented.length > 0) {
    lines.push(
      `WARN[gap] 缺号但迁移目录下没有「故意跳过」依据（${undocumented.length} 个）：`
        + `${undocumented.map((gap) => gap.number).join('、')}\n`
        + '  ⇒ 依据写法：在 services/api/db/migrations/README.md 里写一行，让该缺号与'
        + '「跳过/预留」字样**出现在同一行**（例：`- 0102 故意跳过：预留给 #434 的审计日志迁移`）。\n'
        + '    缺号本身不判错（跨 PR 乱序合并时是常态），但没有依据的缺号无法与「删错了一条迁移」'
        + '区分；`--strict` 下这条会升为退出码 1。',
    );
  }

  for (const failure of result.errors) lines.push(`FAIL[${failure.id}] ${failure.message}`);
  for (const failure of result.rollbackIssues) lines.push(`WARN[${failure.id}] ${failure.message}`);

  if (result.ok && result.failures.length === 0 && undocumented.length === 0) {
    lines.push(
      `PASS：${CRITERIA.length} 项判据全部满足（${CRITERIA.join(' / ')}）；`
        + `${result.details.paired.length} 条配对 + ${result.details.exempted.length} 条登记允许缺省`
        + ` = ${result.details.forwardFiles.length} 条正向迁移逐条有交代。`,
    );
    return lines.join('\n');
  }

  const softIds = [
    ...new Set([
      ...result.rollbackIssues.map((failure) => failure.id),
      ...(undocumented.length > 0 ? ['gap'] : []),
    ]),
  ];
  const softCount = result.rollbackIssues.length + undocumented.length;
  const strictFailure = result.strict && !result.ok;
  if (result.errors.length > 0 || strictFailure) {
    const ids = [...new Set([...result.errors.map((failure) => failure.id), ...(strictFailure ? softIds : [])])];
    const count = result.errors.length + (strictFailure ? softCount : 0);
    lines.push(`FAIL：${count} 项不满足（${ids.join('、')}）；退出码 1。`);
  }
  if (softCount > 0 && !result.strict) {
    lines.push(
      `WARN：${softCount} 项默认不判错（${softIds.join('、')}）；退出码 0；加 --strict 可升为退出码 1。`,
    );
  }
  return lines.join('\n');
}

/**
 * 把一次校验渲染成机读 JSON（`--json`）。
 *
 * 下游（别的门禁、看板、issue 机器人）只认这份形状：`duplicates[]` / `gaps[]` /
 * `rollbackIssues[]` / `counts{}` 是**稳定契约**，改名要同步改证据页与 workflow。
 * `readings` 一起带上是为了让人在一条命令里同时拿到「机器读的」和「人读的」。
 */
export function buildJsonReport(result) {
  const { details } = result;
  const documentedGaps = details.gapDocumentation.filter((gap) => gap.documented);
  return {
    tool: 'verify-migrations-unique',
    schemaVersion: 1,
    ok: result.ok,
    exitCode: result.ok ? 0 : 1,
    strict: result.strict === true,
    migrationsDir: details.migrationsDir,
    rollbackDir: details.rollbackDir,
    criteria: CRITERIA,
    severity: {
      hard: [...HARD_CRITERIA],
      soft: [...SOFT_CRITERIA],
      gap: 'soft',
    },
    counts: {
      forward: details.forwardFiles.length,
      rollback: details.rollbackFiles.length,
      numbers: details.numbers.length,
      duplicates: details.duplicated.length,
      duplicateFiles: details.duplicated.reduce((total, item) => total + item.files.length, 0),
      duplicateRollback: details.duplicatedRollback.length,
      gaps: details.gaps.length,
      documentedGaps: documentedGaps.length,
      undocumentedGaps: result.undocumentedGaps.length,
      paired: details.paired.length,
      exempted: details.exempted.length,
      missingRollback: details.missing.length,
      orphanRollback: details.orphan.length,
      rollbackIssues: result.rollbackIssues.length,
      errors: result.errors.length,
    },
    numbers: details.numbers,
    duplicates: details.duplicated,
    gaps: details.gapDocumentation,
    undocumentedGaps: result.undocumentedGaps,
    rollbackIssues: result.rollbackIssues,
    errors: result.errors,
    paired: details.paired,
    exempted: details.exempted,
    missingRollback: details.missing,
    orphanRollback: details.orphan,
    docSources: details.docSources,
    readings: result.readings,
  };
}

/**
 * 把一次校验的**默认只 warn** 的项渲染成 GitHub Actions 注解（`::warning …`）。
 *
 * 为什么需要这一层（R68-D12）：`renderReport()` 里的 `WARN[...]` 只是 stdout 里的一行文本 ——
 * 在 GitHub UI 上它既不会失败，也不会出现在 PR 的 Annotations 面板，`paths` 之外的读者
 * 根本看不见。把同一批 finding 用 workflow command 再打一遍，就让「不判错」与「看得见」
 * 这两件事同时成立：退出码仍是 0（`--strict` 才升 1），但每条软档 findings 都会变成
 * 一个可聚类的注解。
 *
 * 只覆盖**软档**（`rollbackIssues` + 无「故意跳过」依据的缺号）；硬错本来就以退出码 1
 * 失败，再叠注解只会重复。
 *
 * 注解里的 `file=` / `line=` 一律不写：软档 findings 不是「某一行代码有问题」，它们描述的是
 * 整个迁移目录的形态，硬塞一个文件行号反而误导。
 *
 * @param {ReturnType<typeof verifyMigrations>} result
 * @returns {string[]} 每行一个 workflow command（GitHub 按 stdout 逐行解析）
 */
export function renderAnnotations(result) {
  const annotations = [];
  const undocumented = result.details.gapDocumentation.filter((gap) => !gap.documented);

  for (const failure of result.rollbackIssues) {
    annotations.push(
      `::warning title=${escapeAnnotationProperty(`迁移编号门禁 · ${failure.id}`)}::`
        + escapeAnnotationData(failure.message),
    );
  }
  if (undocumented.length > 0) {
    const numbers = undocumented.map((gap) => gap.number).join('、');
    annotations.push(
      `::warning title=${escapeAnnotationProperty('迁移编号门禁 · gap')}::`
        + escapeAnnotationData(
          `缺号 ${numbers} 在迁移目录下没有「故意跳过」依据：无法与「删错了一条迁移」区分。`
            + '依据写法 = 在 services/api/db/migrations/README.md 里让该缺号与「跳过/预留」出现在同一行'
            + '（例：`- 0102 故意跳过：预留给 #434 的审计日志迁移`）。',
        ),
    );
  }
  return annotations;
}

/**
 * workflow command 的数据段转义（`%` / CR / LF）。
 * 见 GitHub 文档「Workflow commands for GitHub Actions」的 escaping 一节：不转义会让
 * 换行截断注解、`%` 被当成转义序列的开头。
 */
function escapeAnnotationData(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/** workflow command 的属性段转义：在数据段之上再加 `:` 与 `,`（属性以 `key=value` 逗号分隔）。 */
function escapeAnnotationProperty(value) {
  return escapeAnnotationData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

const USAGE = [
  '用法：',
  '  node tools/verify-migrations-unique.mjs               # 扫 services/api/db/migrations/',
  '  node tools/verify-migrations-unique.mjs --dir <目录>  # 扫指定目录（负控制/夹具用）',
  '  node tools/verify-migrations-unique.mjs --json        # 机读：duplicates[]/gaps[]/rollbackIssues[]/counts{}',
  '  node tools/verify-migrations-unique.mjs --strict      # 回滚问题与无依据的缺号也判红',
  '  node tools/verify-migrations-unique.mjs --annotations # 软档项另打 ::warning:: 注解（不改退出码）',
  '',
  '判据：surface / runner / dup（硬错）+ coexist / rollback / gap（默认只 warn）—— 详见文件头注释。',
  '退出码：0 = 全部满足（非 --strict 下只看硬错）；1 = 有硬错（--strict 下含 warn 项）；2 = 用法错误。',
].join('\n');

/** 命令行入口：返回退出码，方便单测直接调用。 */
export function main(argv = process.argv) {
  const args = argv.slice(2);
  let migrationsDir = DEFAULT_MIGRATIONS_DIR;
  let json = false;
  let strict = false;
  let annotations = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      return 0;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--strict') {
      strict = true;
      continue;
    }
    if (arg === '--annotations') {
      annotations = true;
      continue;
    }
    if (arg === '--dir') {
      const value = args[index + 1];
      if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
        console.error(`--dir 需要一个目录参数\n\n${USAGE}`);
        return 2;
      }
      migrationsDir = resolve(value);
      index += 1;
      continue;
    }
    console.error(`未知参数：${arg}\n\n${USAGE}`);
    return 2;
  }

  const result = verifyMigrations({ migrationsDir, strict });
  // `--json` 时 stdout 必须是**纯 JSON**（不混读数），下游才敢直接 `JSON.parse`。
  console.log(json ? JSON.stringify(buildJsonReport(result), null, 2) : renderReport(result));
  // `--annotations` 只加注解、**不改退出码**：非 strict 下软档仍然只 warn。
  // `--json` 与 `--annotations` 同时给时以 `--json` 为准（JSON 契约优先，注解会被静默吞掉，
  // 免得「想要机读」的人拿到一份 PARSE 不了的东西）；要注解就不要带 --json。
  if (annotations && !json) {
    for (const line of renderAnnotations(result)) console.log(line);
  }
  return result.ok ? 0 : 1;
}

/** 是否被直接执行（`node tools/...mjs`）——被 import 时不得有任何副作用。 */
function isDirectExecution() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  const invoked = resolve(entry);
  const self = resolve(fileURLToPath(import.meta.url));
  return process.platform === 'win32'
    ? invoked.toLowerCase() === self.toLowerCase()
    : invoked === self;
}

if (isDirectExecution()) {
  process.exitCode = main();
}
