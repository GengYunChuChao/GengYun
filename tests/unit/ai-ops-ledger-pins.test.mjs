/**
 * GY-S5 · 「AI / 作业账本」的**结构现状**钉子（纯静态：只读文件文本，不 import 任何运行时）。
 *
 * ## 为什么存在
 * 账本三处形态今天是**结构事实**，不是行为约定：`public.jobs`（建表 `0001_initial_schema.sql:203`）
 * 全仓**没有写入者**；`provider_invocations` 只活在数据字典（`docs/architecture/data-dictionary.md:48`）
 * 里、**没有迁移**；审计 `action` 是四值闭集（`services/api/src/admin/audit/catalog.ts:41-46`）。
 * 它们漂移时读面**静默分叉**而不报错：自建一套 `INSERT INTO jobs` 会让作业账本与 `/admin/jobs` 各说各话
 * （「零写入者」是 `0013_conversations.sql:19` 写下的裁定）；给 `AUDIT_ACTIONS` 再加第 5 个值会让
 * 审计查询面 / 契约枚举 / 文档三处不同步。⚠ `tests/unit/admin-audit-logs.test.mjs:130` 只钉
 * 「契约 enum === 运行时 AUDIT_ACTIONS」，**两边同时加值它照样绿** ⇒ 这里必须单独钉死字面四值。
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
 *   ② `provider_invocations` 无迁移、源码零引用，只有文档里有形状。
 *   ③ 正向迁移末项 = `0046`，且 `rollback/` 下有同名回滚件（**本断言随末项推进同步**：新迁移合并进
 *      main 时改 `LAST_MIGRATION` / `LAST_MIGRATION_NUMBER`；`0037` 是历史缺号，本断言不钉连续性）。
 *   ④ `AUDIT_ACTIONS` 恰为 `['account.suspend','account.restore','set_flag','job.cancel']`，**顺序也钉住**：
 *      第 4 项 `job.cancel` 的来历见上（GY-R59 修闭集漂移）；新增 action 仍必须同步 admin-ops-job-integrity
 *      相关断言与文档。
 *   ⑤ 真库臂跳过面：`tests/integration/**` 里 14 个脚本以 `process.env.GY_PG_BIN` 为门，缺它就打印
 *      SKIP 并以 77 退出（POSIX「未取得」≠ 通过），这份清单是冻结的。
 *
 * ## 为什么全用 fs + 文本
 * 判据是「源码 / 迁移的形状」而不是运行结果：`catalog.ts` 是 TS（本仓 `node --test` 不保证 strip-types
 * 可用），迁移是 SQL。读文本让本文件在**没有 node_modules 的树**里也真跑，不会因依赖缺失被静默跳过
 * ——那正是"假的绿"。少数 `assert.match` / `existsSync` 的判据**本质**就是「文件里有没有这种行形状」，
 * 已在原位注明；其余全部 `assert.deepEqual` / `assert.equal`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
// 钉子②：provider_invocations 没有迁移
// ---------------------------------------------------------------------------
test('钉子②：provider_invocations 无迁移、源码零引用，只有数据字典里有形状', () => {
  const sqlFiles = walk(MIGRATIONS_DIR).filter((relPath) => relPath.endsWith('.sql'));
  assert.deepEqual(
    sqlFiles.filter((relPath) => /provider_invocations/i.test(read(relPath))),
    [],
    '有迁移（正向或 rollback）提到 provider_invocations：这张表今天**尚未建**，任何 DDL 都说明'
      + '「先有字典、后建表」的现状被打破；建表时请把本断言连同 docs/architecture/data-dictionary.md 一起改口径',
  );
  assert.deepEqual(
    walk('services/api/src').filter((relPath) => /provider_invocations/i.test(read(relPath))),
    [],
    '源码里出现 provider_invocations：表还不存在，此刻写它就是写在空气上（真要建表请先落迁移并同步钉子②）',
  );
  // 本质是子串/行形状检查：字典那一行是它在仓里唯一的「形状来源」，故用 match 并写死行首字符。
  assert.match(
    read('docs/architecture/data-dictionary.md'),
    /^\| provider_invocations \/ 受限 \|/m,
    '数据字典里 provider_invocations 那一行不见了：它是这张表唯一的字段口径来源，删掉等于连口径一起丢',
  );
});

// ---------------------------------------------------------------------------
// 钉子③：正向迁移末项 + 同名回滚件
// ---------------------------------------------------------------------------
const FORWARD_MIGRATION = /^\d{4}_[a-z0-9_]+\.sql$/;
/** 当前末项（**本断言随末项推进同步**：新迁移合并后改这两个常量，别让它们停在旧编号上）。 */
const LAST_MIGRATION = '0046_admin_scope_denial_trace.sql';
const LAST_MIGRATION_NUMBER = 46;

test('钉子③：正向迁移末项就是 0046，且 rollback/ 下有同名回滚件', () => {
  const forward = readdirSync(join(ROOT, MIGRATIONS_DIR))
    .filter((name) => FORWARD_MIGRATION.test(name))
    .sort();
  const last = forward[forward.length - 1] ?? '';
  assert.equal(
    last,
    LAST_MIGRATION,
    `正向迁移末项变了：现在是「${last}」而钉子写的是「${LAST_MIGRATION}」。新迁移落地就同步这两个常量`
      + '（「本断言随末项推进同步」由你来兑现），否则末项推进时本片会静默失守',
  );
  assert.equal(
    Number(last.slice(0, 4)),
    LAST_MIGRATION_NUMBER,
    `末项编号不是 ${LAST_MIGRATION_NUMBER}：迁移按数字前缀排序执行，编号跳变意味着目录里有未预期的插入`,
  );
  const downFile = `${last.slice(0, -'.sql'.length)}.down.sql`;
  assert.equal(
    existsSync(join(ROOT, MIGRATIONS_DIR, 'rollback', downFile)),
    true,
    `rollback/ 缺同名回滚件 ${downFile}：迁移没有配套回滚，真出问题只能手工改库`,
  );
});

// ---------------------------------------------------------------------------
// 钉子④：AUDIT_ACTIONS 闭集（含顺序）
// ---------------------------------------------------------------------------
const AUDIT_CATALOG = 'services/api/src/admin/audit/catalog.ts';

test('钉子④：AUDIT_ACTIONS 恰为四值闭集，顺序也钉住（account.suspend → account.restore → set_flag → job.cancel）', () => {
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
  assert.deepEqual(
    order,
    ['AUDIT_ACTION_ACCOUNT_SUSPEND', 'AUDIT_ACTION_ACCOUNT_RESTORE', 'AUDIT_ACTION_SET_FLAG', 'AUDIT_ACTION_JOB_CANCEL'],
    'AUDIT_ACTIONS 的成员变了（增、删、换顺序都算）：这四个值是 `GET /admin/audit-logs?action=` 的'
      + '合法输入，必须与 `admin_audit_events` 的写入点一一对应。第 4 项 `job.cancel` 由 GY-R59 追加：'
      + '0043_admin_job_cancel_audit.sql:168-175 早已写 `action=\'job.cancel\'` / `scope=\'jobs:cancel\'`，'
      + '闭集漏登记导致 `?action=job.cancel` 恒 400 —— 加它就是为了让审计读面能按 action 筛。'
      + '多一个成员就必须同时有库内写入点、契约枚举与文档；新增 action 必须同步 admin-ops-job-integrity 相关断言与文档',
  );
  assert.deepEqual(
    order.map((id) => declared.get(id) ?? `<未声明的常量 ${id}>`),
    ['account.suspend', 'account.restore', 'set_flag', 'job.cancel'],
    'AUDIT_ACTIONS 的**取值**变了：这四个字符串就是 `GET /admin/audit-logs?action=` 的合法输入，'
      + '改名等于让历史审计行的 action 列与查询参数对不上。末位 `job.cancel` 来自 0043 的库内写入点'
      + '（`record_admin_job_cancel_audit`，迁移 `0043_admin_job_cancel_audit.sql:174`）；它排在第 4 位而不是'
      + '插进中间，是为了不打乱前三项的历史顺序',
  );
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
