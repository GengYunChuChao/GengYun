/**
 * GY-S5 · 「AI / 作业账本」的**结构现状**钉子（纯静态：只读文件文本，不 import 任何运行时）。
 *
 * ## 为什么存在
 * 账本三处形态今天是**结构事实**，不是行为约定：`public.jobs`（建表 `0001_initial_schema.sql:203`）
 * 全仓**没有写入者**；`provider_invocations` 的字典口径在 `docs/architecture/data-dictionary.md:48`，
 * 迁移与**唯一**写点各只有一处（`0050_provider_invocations.sql` 建表；`privacy/ledger-pg.ts` 的
 * `recordInvocation` 写、`privacy/task-egress.ts` 的 `ChatEgress.send` 调）；审计 `action` 是四值闭集
 * （`services/api/src/admin/audit/catalog.ts:41-46`）。
 * 它们漂移时读面**静默分叉**而不报错：自建一套 `INSERT INTO jobs` 会让作业账本与 `/admin/jobs` 各说各话
 * （「零写入者」是 `0013_conversations.sql:19` 写下的裁定）；给 `AUDIT_ACTIONS` 扩值会让
 * 审计查询面 / 契约枚举 / 文档三处不同步。`tests/unit/admin-audit-logs.test.mjs:130` 只钉
 * 「契约 enum === 运行时 AUDIT_ACTIONS」一个方向，本钉子钉**两层**：
 * ① 双向等式（抓单边改动）；② **字面四值锚**（抓"契约与运行时同时扩值"）。缺了 ② 本文件就只能
 * 证明"两边一致"，证明不了"没有未授权扩值" —— 审查实测：只留 ① 时双边同时加第 5 个值，本文件 5/5 绿。
 * ⚠ 第 4 个值（`job.cancel`）是**带理由翻过去的**，不是幂等放宽：`0043_admin_job_cancel_audit.sql:168-175`
 * 早已由 `SECURITY DEFINER` 函数写入 `action='job.cancel'` / `scope='jobs:cancel'`，而闭集此前只有三值，
 * 读面因此「能看见（全量翻页）、不能筛（`?action=job.cancel` 一律 400）」。GY-R59 把闭集合法扩到四值
 * （`job.cancel` 固定在**末位**，历史三值顺序不动）就是为了把那个 400 变成 200。所以本钉子从三值翻到
 * 四值：**翻值现场必须留下"为什么"，否则下一个人只看见数字变了，看不见它曾经是一条 bug 的边界**。
 *
 * ## 判据形态（白名单式，不是「至少 N 次」）
 *   ① jobs 零 INSERT：**语句级**命中必须为空；**注释级**命中按 `文件:行` **逐条白名单登记**（今天 2 条，
 *      都是迁移头注释在引用「grep `INSERT INTO jobs` 为空」这句判据本身）。⛔ 不退化成一概不看注释：
 *      将来哪怕只在注释里多提一句也要红，逼人回来改口径。
 *   ② `provider_invocations`：**恰好一份**正向迁移 + **一份**同名回滚件（表名逐字一致），源码里提到它的
 *      文件必须**逐条落在一份写死的清单**里（今天 2 个：账本原语 + 外发写点）；数据字典那一行必须还在。
 *      ⛔ 不是「至少 N 次」：清单外的任何一处（哪怕只是注释里多提一句）都要红，逼人回来登记。
 *   ③ 正向迁移末项**从编号目录派生**（不写死编号 / 文件名：`services/api/src/db/migrate.ts` 的
 *      `discoverMigrations` / `inspectMigrationNumbering` / `formatMigrationVersion` 是唯一真源），
 *      并断言派生值 == 目录里的最大编号、该文件确实存在、`rollback/` 下有同名回滚件；
 *      另有一条变异用例：临时目录里多一个「最大编号 + 1」的假迁移，派生末项必须随之前移
 *      （证明派生不是靠猜；`0037` 是历史缺号，本断言不钉连续性）。
 *   ④ `AUDIT_ACTIONS` 与契约 `?action=` 的 enum **双向相等**（同值、同序、无重复），**并且**钉住字面
 *      四值（4 个常量名 + 4 个取值 + 顺序）：双向等式只抓单边改动，双边同时扩值只有字面锚会红。
 *      第 4 项 `job.cancel` 的来历见上（GY-R59 修闭集漂移）；**扩值必须同 PR 改三件套**（契约 enum／
 *      运行时数组／本钉子），并同步 `admin-audit-action-jobs-cancel.test.mjs` 的「恰四项」与文档 ——
 *      两个文件各留一份字面锚是刻意的冗余：任一处被删/被放宽，另一处仍会红。
 *   ⑤ 真库臂跳过面：`tests/integration/**` 里 14 个脚本以 `process.env.GY_PG_BIN` 为门，缺它就打印
 *      SKIP 并以 77 退出（POSIX「未取得」≠ 通过），这份清单是冻结的。
 *
 * ## 为什么全是 fs + 文本（唯一的 import 是「编号」工具）
 * 判据是「源码 / 迁移的形状」而不是运行结果：`catalog.ts` 是 TS（本仓 `node --test` 不保证 strip-types
 * 可用），迁移是 SQL。读文本让本文件在**没有 node_modules 的树**里也真跑，不会因依赖缺失被静默跳过
 * ——那正是"假的绿"。少数 `assert.match` / `existsSync` 的判据**本质**就是「文件里有没有这种行形状」，
 * 已在原位注明；其余全部 `assert.deepEqual` / `assert.equal`。
 *
 * 例外是**迁移编号**：它只有一个真源（编号目录）和一条现成的读法
 * （`services/api/src/db/migrate.ts` 的 `discoverMigrations` / `inspectMigrationNumbering` /
 * `formatMigrationVersion`，只用 node 内置模块，不碰 `node_modules`）。本文件此前把末项写成
 * `'0048_…'` + `48` 两个字面量 —— 与真源脱钩，每加一条迁移就要手改一次，且改错了也只在"末项推进"
 * 那一刻才发现。现在改为**派生**：目录里有什么就说什么，再用变异用例（临时目录里造一条假迁移）
 * 证明派生值真的跟着目录走，而不是换个地方写死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_MIGRATIONS_DIR,
  discoverMigrations,
  formatMigrationVersion,
  inspectMigrationNumbering,
} from '../../services/api/src/db/migrate.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (relPath) => readFileSync(join(ROOT, relPath), 'utf8');
const MIGRATIONS_DIR = 'services/api/db/migrations';

/** 仓库相对路径（正斜杠）递归清单；目录不存在即抛（⛔ 不吃掉：目录改名必须红，不能变成空清单）。 */
function walk(relDir) {
  const out = [];
  for (const entry of readdirSync(join(ROOT, relDir), { withFileTypes: true })) {
    const relPath = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(relPath));
    else out.push(relPath);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 钉子①：public.jobs 全仓零 INSERT
// ---------------------------------------------------------------------------
const JOBS_SCAN_ROOTS = ['services/api/src', MIGRATIONS_DIR];
/** `INSERT INTO [public.]jobs`；`\s+` 容忍被排版成多行的语句（只认单行会漏掉换行写法）。 */
const JOBS_INSERT = /insert\s+into\s+(?:public\.)?jobs\b/gi;
/**
 * 注释级命中的白名单（`文件:行`）。两条都是迁移头注释在引用上面那句 grep 判据本身，不是写入代码。
 * **新增或消失都要同步这里**：白名单不许被随手加宽，也不许留着过期条目。
 */
const JOBS_INSERT_COMMENT_WHITELIST = Object.freeze([
  'services/api/db/migrations/0013_conversations.sql:19',
  'services/api/db/migrations/0035_r34_media_row_purge.sql:67',
]);

/** 收集所有命中，分出「语句级」与「注释级」（看命中点所在行、命中点之前的前缀里有无注释符）。 */
function scanJobsInsert() {
  const hits = [];
  for (const relPath of JOBS_SCAN_ROOTS.flatMap((dir) => walk(dir))) {
    const text = read(relPath);
    for (const match of text.matchAll(JOBS_INSERT)) {
      const before = text.slice(0, match.index);
      const prefix = before.slice(before.lastIndexOf('\n') + 1);
      hits.push({ loc: `${relPath}:${before.split('\n').length}`, comment: /--|\/\/|^\s*\*/.test(prefix) });
    }
  }
  return hits;
}

test('钉子①：public.jobs 语句级零 INSERT（注释级命中走逐条白名单）', () => {
  const hits = scanJobsInsert();
  assert.deepEqual(
    hits.filter((hit) => !hit.comment).map((hit) => hit.loc),
    [],
    '出现对 public.jobs 的**真实写入**：这张表今天只读（裁定见 0013_conversations.sql:19），'
      + '自建插入点会让作业账本与 /admin/jobs 的读面口径分叉；确要新增写入者，先改口径再同步本断言与数据字典',
  );
  assert.deepEqual(
    hits.filter((hit) => hit.comment).map((hit) => hit.loc).sort(),
    [...JOBS_INSERT_COMMENT_WHITELIST].sort(),
    '注释级命中集合变了（多一句、少一句都算红）：白名单是逐条登记的，改完口径请同步这条清单',
  );
  // 本质是行形状检查（建表语句只有一种写法），故用 match 而不是把整段 DDL 抄进来。
  assert.match(
    read(`${MIGRATIONS_DIR}/0001_initial_schema.sql`),
    /^CREATE TABLE jobs \($/m,
    '`jobs` 表本体的建表语句在 0001 里不见了：表都没了，「零 INSERT」就换了含义（可能改成了视图或换了表名）',
  );
});

// ---------------------------------------------------------------------------
// 钉子②：provider_invocations 的迁移**恰好两件**（正向 + 回滚），源码引用面白名单
// ---------------------------------------------------------------------------
/**
 * 允许在 `services/api/src/**` 里出现 `provider_invocations` 的文件（**逐条登记**，今天 2 个）。
 *
 * ⛔ 这份清单是白名单，不是「至少 N 次」：新增一处写面/读面必须在同一次改动里登记到这里，
 * 否则本钉子会红 —— 目的是让「谁在写这张表」永远是一份能一眼读完的短清单。
 */
const PROVIDER_INVOCATIONS_SOURCE_SURFACES = Object.freeze([
  // 唯一写原语 `recordInvocation` + 唯一读面 `listInvocations` + 词表常量 `INVOCATION_STATE(S)`。
  'services/api/src/privacy/ledger-pg.ts',
  // 唯一写点 `ChatEgress.send`（只调用原语，**不**持有任何 SQL）。
  'services/api/src/privacy/task-egress.ts',
]);

test('钉子②：provider_invocations 恰好一份正向迁移 + 一份回滚件，表名逐字一致', () => {
  const sqlFiles = walk(MIGRATIONS_DIR).filter((relPath) => relPath.endsWith('.sql'));
  const hits = sqlFiles.filter((relPath) => /provider_invocations/i.test(read(relPath)));
  const forward = hits.filter((relPath) => !relPath.startsWith(`${MIGRATIONS_DIR}/rollback/`));
  const rollback = hits.filter((relPath) => relPath.startsWith(`${MIGRATIONS_DIR}/rollback/`));
  assert.equal(
    forward.length,
    1,
    `provider_invocations 的正向迁移必须恰好一份（今天 = 0050_provider_invocations.sql），实际 ${forward.length} 份：`
      + `${JSON.stringify(forward)}。多一份说明有人另开了一支建表/改表迁移；少一份说明建表件被删了`,
  );
  assert.equal(
    rollback.length,
    1,
    `provider_invocations 的回滚件必须恰好一份（且与正向同名），实际 ${rollback.length} 份：${JSON.stringify(rollback)}`,
  );
  // 表名逐字一致：正向建的表名 == 回滚删的表名（拼写漂开 ⇒ 回滚删不掉真正要删的东西）。
  const created = /CREATE TABLE IF NOT EXISTS public\.([a-z0-9_]+) \(/.exec(read(forward[0]));
  assert.ok(created, '正向迁移里找不到 `CREATE TABLE IF NOT EXISTS public.<表> (`：建表件形状变了');
  const dropped = /DROP TABLE public\.([a-z0-9_]+);/.exec(read(rollback[0]));
  assert.ok(dropped, '回滚件里找不到 `DROP TABLE public.<表>;`：回滚件形状变了');
  assert.equal(created[1], 'provider_invocations', '正向迁移建的表名不是 provider_invocations');
  assert.equal(dropped[1], created[1], '回滚件删的表名与正向建的表名不一致（拼写漂移）');
  // 回滚件必须与正向同名配对（`rollback/<stem>.down.sql`），⛔ 不许改名躲过钉子③。
  assert.equal(
    rollback[0],
    `${MIGRATIONS_DIR}/rollback/${forward[0].slice(forward[0].lastIndexOf('/') + 1).replace(/\.sql$/, '')}.down.sql`,
    '回滚件名与正向迁移不同名：钉子③的配对判据会被改名绕过',
  );
});

test('钉子②：源码里提到 provider_invocations 的文件必须落在写死的白名单内', () => {
  const hits = walk('services/api/src').filter((relPath) => /provider_invocations/i.test(read(relPath)));
  assert.deepEqual(
    [...hits].sort(),
    [...PROVIDER_INVOCATIONS_SOURCE_SURFACES].sort(),
    '源码里出现 provider_invocations 的文件集合变了：新增位置必须登记到 PROVIDER_INVOCATIONS_SOURCE_SURFACES'
      + '（白名单式判据，多一处就红 —— 这是「谁在写这张表」的唯一凭据）',
  );
  // 只有账本原语可以持有 SQL；其它白名单文件（外发写点）只许调用原语。
  for (const relPath of PROVIDER_INVOCATIONS_SOURCE_SURFACES) {
    if (relPath === 'services/api/src/privacy/ledger-pg.ts') continue;
    assert.doesNotMatch(
      read(relPath),
      /(INSERT\s+INTO|FROM|UPDATE|DELETE\s+FROM)\s+public\.provider_invocations/i,
      `${relPath} 里出现了直接操作 provider_invocations 的 SQL：SQL 只许待在 ledger-pg.ts 的`
        + ' recordInvocation / listInvocations 里，外发写点只许调用原语',
    );
  }
  // 本质是子串/行形状检查：字典那一行是它在仓里唯一的「形状来源」，故用 match 并写死行首字符。
  assert.match(
    read('docs/architecture/data-dictionary.md'),
    /^\| provider_invocations \/ 受限 \|/m,
    '数据字典里 provider_invocations 那一行不见了：它是这张表唯一的字段口径来源，删掉等于连口径一起丢',
  );
});

// ---------------------------------------------------------------------------
// 钉子③：正向迁移末项（**从编号目录派生**，不写死编号）+ 同名回滚件
// ---------------------------------------------------------------------------
/**
 * 派生某个目录的正向迁移编号 —— ⛔ 这里**没有**任何 `'0048_…'` / `48` 字面量。
 *
 * 读法用仓库现成的编号工具（`services/api/src/db/migrate.ts`）：`discoverMigrations` 会拒收
 * 不合规文件名与重复版本号，`inspectMigrationNumbering` 给出 `maxVersion`，`formatMigrationVersion`
 * 给出 `0` 补齐口径。因此 `last` 是**目录里真实存在的那一条**，不是从数字拼出来的猜测。
 */
function forwardNumbering(dir) {
  const migrations = discoverMigrations(dir);
  const numbering = inspectMigrationNumbering(migrations);
  return { migrations, numbering, last: migrations[migrations.length - 1], maxVersion: numbering.maxVersion };
}

/** 回滚件名：同目录 `rollback/` 下的 `<stem>.down.sql`。 */
function rollbackName(filename) {
  return `${filename.slice(0, -'.sql'.length)}.down.sql`;
}

test('钉子③：正向迁移末项由编号目录派生，且 rollback/ 下有同名回滚件', () => {
  const real = forwardNumbering(DEFAULT_MIGRATIONS_DIR);
  assert.ok(real.last !== undefined, '迁移目录里一个合规迁移都没有：编号真源已失效');
  // ① 派生值 == 目录里的最大编号（排序末项 vs `maxVersion`，两条独立读法必须同答案）。
  assert.equal(
    Number(real.last.version),
    real.maxVersion,
    `派生末项编号 ${real.last.version} ≠ 目录最大编号 ${real.maxVersion}：编号目录是唯一真源，`
      + '两者不一致说明某一条读法被改坏了',
  );
  // ② 文件名 == `formatMigrationVersion(maxVersion)` 前缀 + 真名（命名口径也与工具同源）。
  assert.equal(
    real.last.filename,
    `${formatMigrationVersion(real.maxVersion)}_${real.last.name}.sql`,
    '末项文件名与「0 补齐的编号 + 名字」不一致：`formatMigrationVersion` 与目录命名口径已分叉',
  );
  // ③ 该文件**确实存在**：⛔ 不只断言"拼出来的字符串好看"，派生值必须指到一条真实文件。
  assert.equal(
    existsSync(join(DEFAULT_MIGRATIONS_DIR, real.last.filename)),
    true,
    `派生出的末项 ${real.last.filename} 在 ${MIGRATIONS_DIR}/ 里不存在：派生值与磁盘脱钩`,
  );
  assert.equal(
    real.migrations.filter((migration) => migration.version === real.last.version).length,
    1,
    `末项编号 ${real.last.version} 在目录里不唯一：迁移按数字前缀排序执行，重复编号会让顺序不确定`,
  );
  // ④ 配套回滚件（文件名从派生值来，不再手写）。
  const downFile = rollbackName(real.last.filename);
  assert.equal(
    existsSync(join(DEFAULT_MIGRATIONS_DIR, 'rollback', downFile)),
    true,
    `rollback/ 缺同名回滚件 ${downFile}：迁移没有配套回滚，真出问题只能手工改库`,
  );
});

test('钉子③b 变异：临时目录里多一条假迁移，派生末项随之前移（派生不是写死）', () => {
  const real = forwardNumbering(DEFAULT_MIGRATIONS_DIR);
  const dir = mkdtempSync(join(tmpdir(), 'gy-migration-numbering-'));
  try {
    // 夹具：把真末项复制进临时目录（编号不动），先确认派生读到的就是它 —— 否则后面的读数不算数。
    copyFileSync(join(DEFAULT_MIGRATIONS_DIR, real.last.filename), join(dir, real.last.filename));
    const before = forwardNumbering(dir);
    assert.equal(before.last.filename, real.last.filename, '临时目录夹具没被派生读到：变异用例本身失效');
    assert.equal(before.maxVersion, real.maxVersion);
    // 变异：造一条「最大编号 + 1」的假迁移（编号由派生值算，⛔ 不写 `0049` 这种字面量）。
    const probe = `${formatMigrationVersion(real.maxVersion + 1)}_mutation_probe.sql`;
    writeFileSync(join(dir, probe), '-- 变异探针：只为证明派生末项跟着目录走\n', 'utf8');
    const after = forwardNumbering(dir);
    assert.equal(
      after.last.filename,
      probe,
      `多一条 ${probe} 之后派生末项仍是 ${after.last.filename}：派生值是写死的，不是从目录算的`,
    );
    assert.equal(after.maxVersion, real.maxVersion + 1);
    assert.equal(Number(after.last.version), after.maxVersion);
    // 反向读数：假迁移**没有**配套回滚件 ⇒ ③ 的 ④ 那种断言在同一条派生值上会红（它不是恒真）。
    assert.equal(
      existsSync(join(dir, 'rollback', rollbackName(after.last.filename))),
      false,
      '临时目录里不该有 rollback/：这条反向断言恒真的话，③ 的回滚件断言就没有判别力',
    );
    // 不污染仓库：真目录的派生末项仍然原样。
    assert.equal(
      forwardNumbering(DEFAULT_MIGRATIONS_DIR).last.filename,
      real.last.filename,
      '变异用例写到了真目录上：临时夹具必须只落在 mkdtemp 出来的目录里',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 钉子④：AUDIT_ACTIONS 闭集（含顺序）
// ---------------------------------------------------------------------------
const AUDIT_CATALOG = 'services/api/src/admin/audit/catalog.ts';

test('钉子④：AUDIT_ACTIONS 与契约 enum 双向相等（同值、同序、无重复），扩值必须同 PR 改三件套', () => {
  const catalog = read(AUDIT_CATALOG);
  const declared = new Map(
    [...catalog.matchAll(/export const (AUDIT_ACTION_[A-Z_]+) = '([^']+)';/g)].map((m) => [m[1], m[2]]),
  );
  const list = catalog.match(/export const AUDIT_ACTIONS = Object\.freeze\(\[([\s\S]*?)\] as const\);/);
  if (list === null) {
    assert.fail(
      'AUDIT_ACTIONS 的声明形状不再是 `Object.freeze([...] as const)`：本钉子靠解析那个数组字面量取顺序，'
        + '形状换了就请改成显式逐值断言，别让闭集失去守卫',
    );
  }
  const order = [...list[1].matchAll(/[A-Z][A-Z0-9_]+/g)].map((m) => m[0]);
  const runtime = order.map((id) => declared.get(id) ?? `<未声明的常量 ${id}>`);
  const contractEnum = JSON.parse(read('packages/contracts/openapi.json')).paths['/admin/audit-logs'].get
    .parameters.find((parameter) => parameter.name === 'action').schema.enum;
  // 两层判据（S3b 审查后修复轮，2026-10-26）：
  //   ① **双向等式**（下面两句）：只保证"契约 enum 与运行时数组一致" ⇒ 抓**单边**改动；
  //   ② **字面锚**（再下面两句）：钉住每个常量名与每个取值（含顺序）⇒ 抓**双边同时**改动。
  // 为什么必须补 ②：审查实测（本轮变异 M3）同时给契约 enum 与运行时常量追加同一个新值，
  // 只有 ① 时本用例 **5/5 全绿**（唯一变红的是 `admin-audit-action-jobs-cancel.test.mjs` 的
  // `AUDIT_ACTIONS.length === 4`）。也就是说：只留 ① 的本文件**不能**阻止未授权扩值，
  // 那时它只配叫"一致性检查"。②补回后，"扩值"必须**显式**改这里 —— 仍然允许扩值（GY-R59 扩到四值、
  // GY-R64 扩到七值、同轮的读面闭集片扩到八值、R68 扩到十值、R68-A01 扩到十一值就是这么做的），但扩值变成一次有联动的动作，
  // 而不是悄悄从两个文件之间溜过去。
  assert.deepEqual(runtime, contractEnum,
    '运行时 AUDIT_ACTIONS ≠ 契约 `?action=` 的 enum：值或顺序不一致，读面会「能看见但不能筛」');
  assert.deepEqual(contractEnum, runtime,
    '契约 `?action=` 的 enum ≠ 运行时 AUDIT_ACTIONS：反向同理，任何一侧单边改动都必须红');
  assert.deepEqual(order,
    [
      'AUDIT_ACTION_ACCOUNT_SUSPEND',
      'AUDIT_ACTION_ACCOUNT_RESTORE',
      'AUDIT_ACTION_SET_FLAG',
      'AUDIT_ACTION_JOB_CANCEL',
      'AUDIT_ACTION_ADMIN_SCOPE_GRANT',
      'AUDIT_ACTION_ADMIN_SCOPE_REVOKE',
      'AUDIT_ACTION_ADMIN_SCOPE_DENY',
      'AUDIT_ACTION_POST_HIDE',
      'AUDIT_ACTION_ADMIN_ACCOUNT_DISABLE',
      'AUDIT_ACTION_ADMIN_ACCOUNT_ENABLE',
      'AUDIT_ACTION_CATEGORY_UPDATE',
    ],
    'AUDIT_ACTIONS 的成员变了（增、删、换顺序都算）：这些值是 `GET /admin/audit-logs?action=` 的合法输入，'
      + '必须与 `admin_audit_events` 的写入点一一对应。第 4 项 `job.cancel` 由 GY-R59 追加：'
      + '0043_admin_job_cancel_audit.sql:168-175 早已写 `action=\'job.cancel\'` / `scope=\'jobs:cancel\'`，'
      + '闭集漏登记导致 `?action=job.cancel` 恒 400。第 5-7 项由 GY-R64（#18 S2 收尾片 PR-4）追加：'
      + '0041 早已写 `admin_scope.grant` / `admin_scope.revoke`（`:319-326` / `:472-479`），闭集漏登记'
      + '导致 `?action=admin_scope.grant` 恒 400；`admin_scope.deny` 来自 0046 的'
      + '`record_admin_scope_denial`。第 8 项 `post.hide` 由 GY-R64 读面闭集片追加：'
      + '0047_admin_post_hide_audit.sql:185-198 已在事务内写这一行，闭集漏登记'
      + '导致 `?action=post.hide` 与 `?entity=post` 恒 400（写进去了却查不出来）。'
      + '第 9-10 项 `admin_account.disable` / `admin_account.enable` 由 R68（迁移 0048）追加：'
      + '0048_admin_account_disable.sql 在事务内写这两个 action，闭集漏登记同样会让'
      + '`?action=admin_account.disable` 与 `?entity=admin_account` 恒 400。'
      + '第 11 项 `category.update` 由 GY-R68-A01（迁移 0049 的 `record_admin_category_update`）追加：'
      + '多一个成员就必须同 PR 改契约 enum、库内写入点与文档');
  assert.deepEqual(runtime,
    ['account.suspend', 'account.restore', 'set_flag', 'job.cancel',
      'admin_scope.grant', 'admin_scope.revoke', 'admin_scope.deny', 'post.hide',
      'admin_account.disable', 'admin_account.enable', 'category.update'],
    'AUDIT_ACTIONS 的**取值**变了：这些字符串就是 `GET /admin/audit-logs?action=` 的合法输入，'
      + '改名等于让历史审计行的 action 列与查询参数对不上。`job.cancel` 来自 0043 的库内写入点'
      + '（`record_admin_job_cancel_audit`，迁移 `0043_admin_job_cancel_audit.sql:174`）；'
      + '`admin_scope.*` 三项来自 0041（grant/revoke）与 0046（deny）；'
      + '`post.hide` 来自 0047（`record_admin_post_hide_audit`，迁移 `0047_admin_post_hide_audit.sql:192`）；'
      + '`admin_account.disable` / `admin_account.enable` 来自 0048（`disable_admin_account` /'
      + '`enable_admin_account`，迁移 `0048_admin_account_disable.sql`）；`category.update` 来自 0049'
      + '（`record_admin_category_update`，迁移 `0049_admin_categories.sql`）');
  // 无重复：重复值会让 `?action=` 的合法性判断与顺序断言同时失真。
  assert.equal(new Set(runtime).size, runtime.length, `AUDIT_ACTIONS 有重复值：${runtime.join(', ')}`);
  // 历史锚点：`job.cancel` 必须仍在闭集内 —— 0043 的 `record_admin_job_cancel_audit` 在写它，
  // 摘掉它 = 那条 200 的筛选项重新变 400（GY-R59 的现场）。
  assert.ok(runtime.includes('job.cancel'), '`job.cancel` 必须留在闭集内：0043 的 SECURITY DEFINER 函数在写它');
  // 扩值纪律：扩值必须**同一个 PR**改三件套 —— ① 契约 `?action=` 的 enum；② `catalog.ts` 的
  // AUDIT_ACTIONS；③ 本钉子（含上面两句字面锚）。新值**追加在末位**，并同步
  // `admin-audit-action-jobs-cancel.test.mjs` 的「恰四项」与相关文档。  // 两个文件各自都能阻止"双边同时扩值"：删掉任何一个的字面锚，另一处仍会红 —— 刻意保留这层冗余。
});

// ---------------------------------------------------------------------------
// 钉子⑤：真库臂缺 GY_PG_BIN 时跳过（冻结清单）
// ---------------------------------------------------------------------------
const INTEGRATION_DIR = 'tests/integration';
/** 真库臂的闸门：读 `GY_PG_BIN`。 */
const GY_PG_GATE = /process\.env\.GY_PG_BIN\b/;
/** 缺闸门时的出口：`process.exit(77)`，或 `user-chain-e2e.mjs` 的 `return 77`（同一 POSIX 惯例）。 */
const SKIP_EXIT_77 = /process\.exit\(\s*77\s*\)|return\s+77\b/;
/** 冻结清单：缺 `GY_PG_BIN` 时打印 SKIP 并用 77 退出的真库脚本（15 个）。 */
const GY_PG_SKIPPERS = Object.freeze([
  'admin-audit-logs-pg.mjs', 'admin-content-pg.mjs', 'admin-scopes-authority-pg.mjs',
  'admin-scopes-read-pg.mjs', 'backup-copies-purge-pg.mjs', 'backup-purge-pg.mjs',
  'media-row-purge-pg.mjs', 'messages-purge-pg.mjs', 'moderation-full-chain-pg.mjs',
  'online-purge-pg.mjs', 'recognitions-speech-purge-pg.mjs', 'retention-clock-drill-pg.mjs',
  'retention-purge-pg.mjs', 'third-party-deletion-sql-pg.mjs', 'user-chain-e2e.mjs',
]);

test('钉子⑤：15 个真库脚本以 GY_PG_BIN 为门，缺它就 SKIP + 77（未取得 ≠ 通过）', () => {
  const skippers = readdirSync(join(ROOT, INTEGRATION_DIR))
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => ({ name, text: read(`${INTEGRATION_DIR}/${name}`) }))
    .filter(({ text }) => GY_PG_GATE.test(text) && SKIP_EXIT_77.test(text) && /\bSKIP\b/.test(text))
    .map(({ name }) => name)
    .sort();
  assert.equal(
    skippers.length,
    GY_PG_SKIPPERS.length,
    `真库臂数量变成了 ${skippers.length}（冻结清单是 ${GY_PG_SKIPPERS.length}）：新增/删除带 GY_PG_BIN 闸门的`
      + '脚本都要回来同步这份清单；⚠ 少了任何一个都可能意味着有人把「缺真库」悄悄改成了通过',
  );
  assert.deepEqual(
    skippers,
    [...GY_PG_SKIPPERS],
    '真库臂跳过清单逐项变了：请对照本钉子确认变的是「新加了一条真库臂」还是「闸门 / 77 出口被改动」',
  );
});
