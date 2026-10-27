/**
 * A 档回归钉 · 「后台下架（`post.hide`）的审计**不落库**」这个缺口（基线 `31291afb`）。
 *
 * ## 翻钉进度（GY-R64，2026-10）
 *
 * - 钉③（库内写入点）**已翻**：#656 的迁移 `0047_admin_post_hide_audit.sql` 让下架审计真的落库，
 *   钉③ 因此反向成「有且只有一处窄口径写入点」。
 * - 钉④（读面闭集）**已翻**（本片）：`AUDIT_ACTIONS` 登记 `post.hide` 作第 8 项、`post` 作第 5 个
 *   entity 键，并给 `entity=post` 加动作护栏；`?action=post.hide` 不再是 400。
 * - 钉⑥ **仍未翻**：它断言的是**内存端口**的台账（`persistent: false`），PG 端口的行为在
 *   `tests/integration/admin-post-hide-audit-pg.mjs` 里断言，所以这里反过来要保住「内存台账仍是
 *   进程内」这个事实，否则两份口径混成一份。
 *
 * ⇒ 下面这段「缺口原貌」是**基线 `31291afb` 的历史记录**，用于解释本文件为什么存在；
 *    它不再代表当前行为，当前行为以钉③④⑥ 的断言与 `FLIP_GUIDE` 的翻钉进度为准。
 *
 * ## 本文件钉的是**缺口**，不是功能
 *
 * 今天（2026-10，基线 `31291afb`）后台下架一条社区帖时会写一条 `action = 'post.hide'` 的审计行
 * （`services/api/src/admin/ops/service.ts:1152-1160`），但它落在**进程内内存台账**里：
 *
 * - 台账实现是 `createAuditLog()`（`services/api/src/admin/audit.ts:81`，同文件 `:80` 自述
 *   「内存审计日志。进程内实现，**非**真实 PG 接线」）；
 * - 运维 store 是 `createAdminOpsStore()`（`services/api/src/admin/ops/store.ts:95`），
 *   实现体里 `persistent: false`（同文件 `:139`，接口在 `:43`）；
 * - `public.admin_audit_events` 对运行时角色是**零表级权限**，全仓 `services/api/src` 里
 *   **没有任何一条** `INSERT INTO … admin_audit_events` —— 库内写入只发生在迁移里的窄口径函数
 *   （`services/api/src/admin/audit/catalog.ts:6-13` 列了 4 处：`account.suspend`、
 *   `account.restore`、`set_flag`、`job.cancel`），其中**没有** `post.hide`；
 * - 装配层自己也是这么登记的：`services/api/src/app.ts:1416-1417`「⛔ **库内审计未取得**：
 *   `appendAudit` 仍落内存 ops store（`persistent: false`），重启即丢」。
 *
 * 也就是说：**下架是真的（帖子被隐藏、作者收到 `community:takedown:` 通知），审计是假的（落内存、
 * 重启即丢、`real` 模式下连读面都没有）**。本文件把这个「假的」钉成红灯：哪天有人补上落库通路，
 * 这里的断言就会失败，而失败信息直接给出**翻钉指引**（怎么把它从「缺口钉」改成「正例钉」）。
 *
 * ## 为什么不写成「跳过 / todo」
 *
 * 缺口一旦被 `skip` 就没人看。这里选择**显式断言当前为假**：现状为假 ⇒ 绿；现状被修复 ⇒ 红，
 * 红的时候由人把它翻成正例。这是「防漂移」，不是「批准缺口」。
 *
 * ## 正控（防止「扫描器扫了个空」）
 *
 * 每逢「断言命中为零」，都配一条**正控**：同样的扫描面必须能读到真实内容 ——
 * 迁移里 `0022_community_persistence.sql` 的 `CREATE TABLE community_posts`、审计表确实有
 * `INSERT INTO public.admin_audit_events` 写入点、`services/api/src` 下确实存在别的 PG 后台 store。
 * 扫描器坏掉时先红的是正控，而不是让「零命中」冒充通过。
 *
 * ## 透传钉（钉⑦，R64 新增）
 *
 * R64 把库层写做出来之后，真库臂 `tests/integration/admin-post-hide-audit-pg.mjs` 曾经全红在
 * 一个**不是 SQL** 的地方：下架返回 200、`community_posts` 确实变 `hidden`/`revision=2`，而
 * `admin_audit_events` **0 行**。根因是第 5 个参数 `audit` 被**两处静默丢掉**——`TypeScript`
 * 允许实现方法的形参比接口少，所以既不报类型错、也不报红：
 *
 *   ① `services/api/src/community/takedown.ts` 的 `withTakedownObserver` 只声明/转发 4 个形参；
 *   ② `services/api/src/community/store-pg.ts` 的 `commitPostIfCurrent` 只有 4 个形参，
 *      没把第 5 个往后传给 `commitPost`（那是唯一执行 `POST_HIDE_AUDIT_SQL` 的地方）。
 *
 * 钉⑦ 因此用**假 store 捕获实参**来钉：任何一处再退回 4 个形参，`audit` 就到不了库层，
 * 而「下架 200 + 帖子变 hidden」的其它读数**全都还是绿的**——这正是当初没人发现的原因。
 *
 * ## 声明
 *
 * 行为层（钉⑥）走**真实 `buildApp` + 真实后台路由**（`POST /api/v1/admin/posts/:id/hide`），
 * 但模型端口是合成替身（`passingPort`），不发起任何真实模型/付费调用，也不连数据库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import { AUDIT_ACTIONS } from '../../services/api/src/admin/audit/catalog.ts';
import { OPS_SCOPES } from '../../services/api/src/admin/ops/service.ts';
import { createAdminOpsStore } from '../../services/api/src/admin/ops/store.ts';
import { withTakedownObserver } from '../../services/api/src/community/takedown.ts';
import {
  API,
  USER_A,
  idem,
  makeWiredHarness,
  passingPort,
  postInput,
} from './community-moderation-fixtures.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MIGRATIONS_DIR = join(REPO_ROOT, 'services', 'api', 'db', 'migrations');
const SRC_DIR = join(REPO_ROOT, 'services', 'api', 'src');
const CATALOG_PATH = join(SRC_DIR, 'admin', 'audit', 'catalog.ts');

/** 翻钉指引：这里写全，失败时读者不需要再去翻文档。 */
const FLIP_GUIDE =
  '翻钉指引（下架审计真的落库了就该这么翻）：\n' +
  '  1) 断言方向反过来：删掉「命中为零」，改成断言那条新迁移/新函数的**存在** —— ' +
  "例如 `services/api/db/migrations/00XX_post_hide_audit.sql` 里有窄口径函数，且它写出的行 `action = 'post.hide'`；\n" +
  '  2) 同步登记读面闭集：`services/api/src/admin/audit/catalog.ts` 的 `AUDIT_ACTIONS` 是「谁在写这张表」的单一来源，' +
  '新增写入点必须同时进闭集，否则 `GET /admin/audit-logs?action=post.hide` 会 400（能看见、不能筛）；\n' +
  '  3) 把钉⑥ 的行为层从「内存台账」改成「库内台账」：真 PG 用例放 `tests/integration/`，' +
  '断言同一行在**新进程**里仍可读出（今天这里断言的是「换一个进程就是零」）；\n' +
  '  4) 更新 `services/api/src/app.ts:1416-1417` 那段「库内审计未取得」的登记注释，否则代码与注释互相打脸。\n' +
  '  ⚠ R64（2026-10）已经翻了**第 1 条**：迁移 `0047_admin_post_hide_audit.sql` 让下架审计真的落库，' +
  '钉③ 因此反向成「有且只有一处窄口径写入点」。同轮**读面闭集片**翻了**第 2 条**：' +
  '`catalog.ts` 的 `AUDIT_ACTIONS` 追加 `post.hide`、`AUDIT_ENTITY_SCOPES` 追加 `post`，' +
  '并给 `entity=post` 加动作护栏（`AUDIT_ENTITY_ACTION_GUARDS`）——钉④ 因此反向成' +
  '「闭集含 `post.hide`，且库内恰有一处写入点」。仍**未**翻的是钉⑥（它测的是**内存端口**的台账，' +
  'PG 端口的行为在 `tests/integration/admin-post-hide-audit-pg.mjs` 里断言）。';

/** 递归列出目录下所有匹配的文件（绝对路径，按字典序），子目录（如 `rollback/`）不放过。 */
function walk(dir, accept) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, accept));
    else if (entry.isFile() && accept(entry.name)) found.push(full);
  }
  return found.sort();
}

/** 仓库相对路径，统一 `/` 分隔（失败信息里可以直接抄去 grep）。 */
function repoPath(absolute) {
  return relative(REPO_ROOT, absolute).split(sep).join('/');
}

/** **浅读一层**目录里的 `.sql`（不递归）—— 用来和 `walk()` 的递归读数互校。目录不存在 ⇒ 返回空。 */
function listSqlFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => join(dir, entry.name))
    .sort();
}

/**
 * 从 `services/api/src/admin/audit/catalog.ts` 的**源文本**解析出 `AUDIT_ACTIONS` 的成员取值
 * （按数组字面量的书写顺序；成员是 `AUDIT_ACTION_*` 常量名，取值从同文件的 `export const` 读）。
 *
 * 为什么解析源文件而不是「把常量数组抄进测试」：抄出来的静态快照会与源文件各自漂移 ——
 * 源文件改了、快照没改，这条钉就变成在断言一份**过期副本**上「没有 post.hide」。
 * 这里改成「导入值 == 源文本解析值」的显式比对，源文件一旦换装配方式（二次组装、别名、
 * 条件导出）就当场红灯，而不是悄悄绿。
 *
 * 返回 `null` = 源文件形状变了（找不到 `AUDIT_ACTIONS` 的 `Object.freeze([...] as const)` 字面量），
 * 由调用方断言成红并提示跟着改本函数。
 */
function auditActionsFromCatalogSource() {
  const text = readFileSync(CATALOG_PATH, 'utf8');
  const declared = new Map();
  for (const match of text.matchAll(/^export const (AUDIT_ACTION_[A-Z0-9_]+) = '([^']*)';$/gm)) {
    declared.set(match[1], match[2]);
  }
  const block = text.match(/export const AUDIT_ACTIONS = Object\.freeze\(\[([\s\S]*?)\] as const\);/);
  if (block === null) return null;
  return [...block[1].matchAll(/AUDIT_ACTION_[A-Z0-9_]+/g)].map((match) =>
    declared.has(match[0]) ? declared.get(match[0]) : `<未在当前源文件声明:${match[0]}>`,
  );
}

/** 逐行扫描，返回 `path:line: 文本` 形式的命中清单（空数组 = 零命中）。 */
function scanLines(files, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  const hits = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      matcher.lastIndex = 0;
      if (matcher.test(line)) hits.push(`${repoPath(file)}:${index + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

const MIGRATION_FILES = walk(MIGRATIONS_DIR, (name) => name.endsWith('.sql'));
const SRC_FILES = walk(SRC_DIR, (name) => name.endsWith('.ts'));

test('钉③（R64 已翻转）：下架审计在库里有**唯一的**窄口径写入点 —— 迁移 0047 的函数把 action/scope/result 写死', () => {
  // 正控 1：扫描面非空**且真的递归进了 `rollback/`**（递归到底才不漏，只读顶层会漏掉整个子目录）。
  //
  // 这里刻意**不把总数写成魔法数字**（曾写 `>= 80`，而注释说 85 —— 断言与注释各说一套）：
  // 迁移会持续新增，锁死一个总数只会让「无关地多了一条迁移」把这条钉变红，那不是本钉要防的漂移。
  // 改为两条**独立读数互校**：`walk()` 的递归总数必须等于「顶层直读 + `rollback/` 直读」之和 ——
  // 总数随迁移数自由浮动，但「递归没漏层」这个性质被真正钉住了。
  // 基线读数（2026-10，`ad869d75`）：顶层 43 条 + `rollback/` 42 条 = 85，两侧均为纯 `.sql`，无其它子目录。
  const topLevelMigrations = listSqlFiles(MIGRATIONS_DIR);
  const rollbackMigrations = listSqlFiles(join(MIGRATIONS_DIR, 'rollback'));
  assert.ok(
    topLevelMigrations.length > 0 && rollbackMigrations.length > 0,
    `扫描面必须两侧都非空：顶层 ${topLevelMigrations.length} 个 .sql、rollback/ ${rollbackMigrations.length} 个 .sql`,
  );
  assert.equal(
    MIGRATION_FILES.length,
    topLevelMigrations.length + rollbackMigrations.length,
    `walk() 必须递归读到全部迁移（子目录不放过）：实际 ${MIGRATION_FILES.length} 个，` +
      `顶层 ${topLevelMigrations.length} + rollback/ ${rollbackMigrations.length}。` +
      '两者不等 ⇒ walk() 漏了某一层，或 `migrations/` 下多了别的子目录（新子目录要同时登记进本正控）',
  );

  // 正控 2：扫描器确实读到了内容 —— 社区内容本身是落库的。
  const communityMigration = MIGRATION_FILES.filter((file) => repoPath(file).endsWith('0022_community_persistence.sql'));
  assert.equal(communityMigration.length, 1, '正控：迁移 0022（社区持久化）必须唯一命中，否则扫描路径错了');
  assert.match(
    readFileSync(communityMigration[0], 'utf8'),
    /CREATE TABLE community_posts \(/,
    '正控：迁移 0022 里必须能读到 `CREATE TABLE community_posts (` —— 证明扫描器读的是真实迁移文本',
  );

  // 正控 3：审计表确实有库内写入点（否则「零命中」毫无意义：那只是这张表没人写）。
  const auditInsertPoints = scanLines(MIGRATION_FILES, /INSERT\s+INTO\s+public\.admin_audit_events/i);
  assert.ok(
    auditInsertPoints.length >= 1,
    '正控：`public.admin_audit_events` 必须至少有一处库内写入（账号停用/开关变更/作业取消），' +
      `实际 ${auditInsertPoints.length} 处。零处说明审计表根本没在写，本钉的前提不成立`,
  );

  // ---------------------------------------------------------------------------
  // 钉（R64 翻转）：这条钉原来断言「零命中」—— 后台下架的审计**没有**落库通路。
  // R64 把库层写做出来了（迁移 0047 的窄口径函数），于是断言方向整体反过来：
  // 从「仓库里找不到 post.hide」变成「有且只有一处能干这件事，且动作/面/结果是写死的字面量」。
  // 判别力没有下降 —— 原来防的是「有人偷偷落库了」，现在防的是「有人开了第二条写入通路、
  // 或把 action/scope 改成调用方传参」（后者会让审计行可以被伪造成任意动作）。
  // ---------------------------------------------------------------------------
  const pinFile = 'services/api/db/migrations/0047_admin_post_hide_audit.sql';
  const fnFiles = MIGRATION_FILES.filter((file) =>
    /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.record_admin_post_hide_audit\s*\(/i.test(readFileSync(file, 'utf8')),
  );
  assert.deepEqual(
    fnFiles.map(repoPath),
    [pinFile],
    '下架审计的库内写入点必须**唯一**，且落在 `0047_admin_post_hide_audit.sql`：' +
      `实际 ${fnFiles.length} 个文件定义 \`public.record_admin_post_hide_audit(...)\`：${fnFiles.map(repoPath).join(', ') || '（无）'}。` +
      '零个 ⇒ 库层写没了；多个 ⇒ 出现第二条写入通路（本钉只允许一处窄口径函数）',
  );
  const pinText = readFileSync(fnFiles[0], 'utf8');
  // 动作文本 / scope / result 必须是**函数内**的字面量，不能由参数决定。
  for (const [label, pattern] of [
    ["action = 'post.hide'", /'post\.hide'/],
    ["scope = 'sources:write'", /'sources:write'/],
    ["result = 'accepted'", /'accepted'/],
    ['actor 只来自参数 p_actor_id', /\bp_actor_id\b/],
  ]) {
    assert.match(pinText, pattern, `0047 的函数必须写死 ${label}（动作/面/结果由函数定，不由调用方传）`);
  }
  // 写入点恰好一行：函数体里只准出现一条 `INSERT INTO public.admin_audit_events`。
  const pinInserts = scanLines([fnFiles[0]], /INSERT\s+INTO\s+public\.admin_audit_events/i);
  assert.equal(pinInserts.length, 1, `0047 的函数体必须恰好一条审计写入，实际 ${pinInserts.length} 条：\n${pinInserts.join('\n')}`);
  // 反控：这个函数不改业务表（下架本身是 `community_posts` 的 CAS，不归审计函数管）。
  assert.deepEqual(
    scanLines([fnFiles[0]], /UPDATE\s+(public\.)?community_posts|DELETE\s+FROM\s+(public\.)?community_posts/i),
    [],
    '审计函数不得改业务表：下架的可见性变更由 `commitPostIfCurrent` 的 CAS 负责，函数只写审计行',
  );
  // 配套回滚必须在，且**只删函数**（有行就中止，不能留下「有行、无出处」的审计）。
  const downPath = 'services/api/db/migrations/rollback/0047_admin_post_hide_audit.down.sql';
  const downFile = MIGRATION_FILES.find((file) => repoPath(file) === downPath);
  assert.ok(downFile !== undefined, `配套回滚必须存在：${downPath}（rollback 不能缺）`);
  const downText = readFileSync(downFile, 'utf8');
  assert.match(downText, /DROP\s+FUNCTION\s+(IF\s+EXISTS\s+)?public\.record_admin_post_hide_audit\s*\(/i,
    '回滚只删函数');
  assert.match(downText, /RAISE\s+EXCEPTION/i,
    "回滚必须先数 `action='post.hide'` 的审计行，`>0` 即 `RAISE EXCEPTION` 中止");
  assert.deepEqual(
    scanLines([downFile], /DROP\s+TABLE|TRUNCATE|DELETE\s+FROM\s+public\.admin_audit_events/i),
    [],
    '回滚不得删表/清行：审计行是证据，只能**拒绝**回滚，不能顺手抹掉',
  );
});

test('钉④：审计读面的 `action` 闭集含 `post.hide`，且库内恰有一处写入点（读面「能看见也能筛」）', () => {
  // 正控 0：闭集必须**真的来自源文件**（不是把常量数组抄进测试的静态快照）。
  const sourceActions = auditActionsFromCatalogSource();
  assert.ok(
    sourceActions !== null,
    '正控：`services/api/src/admin/audit/catalog.ts` 里必须能读到 `AUDIT_ACTIONS` 的 ' +
      '`Object.freeze([...] as const)` 数组字面量 —— 读不到说明源文件换了装配方式，' +
      '`auditActionsFromCatalogSource()` 要跟着改（本钉不允许退回静态快照）',
  );
  assert.deepEqual(
    AUDIT_ACTIONS,
    sourceActions,
    '读面闭集必须**逐项等于源文件里的数组字面量**（这里真读了一份 `catalog.ts` 文本，不是抄快照）：' +
      `导入值 ${JSON.stringify(AUDIT_ACTIONS)}、源文本解析值 ${JSON.stringify(sourceActions)}。` +
      '两者不等 ⇒ 闭集被二次装配/别名/条件导出改写，本钉的「闭集」已经不是源文件那一份',
  );

  // 正控 1：闭集非空、无重复且可枚举（它是「谁在写 admin_audit_events」反推出来的单一来源）。
  assert.equal(
    new Set(AUDIT_ACTIONS).size,
    AUDIT_ACTIONS.length,
    `读面闭集不得有重复项：实际 ${JSON.stringify(AUDIT_ACTIONS)}`,
  );
  assert.ok(
    AUDIT_ACTIONS.length >= 4,
    `正控：\`AUDIT_ACTIONS\` 至少含 4 个库内写入动作，实际 ${JSON.stringify(AUDIT_ACTIONS)}`,
  );

  // 翻转后的判据（原判据是「闭集里不许有 post 域动作」）：post 域动作**恰好一个**且就是
  // `post.hide` —— 多一个（例如有人把 `post.approve` 也塞进来而不写库内写入点）同样要红。
  const postish = AUDIT_ACTIONS.filter((action) => /post/i.test(action));
  assert.deepEqual(
    postish,
    ['post.hide'],
    `审计读面闭集里的 post 域动作必须**恰好一个** \`post.hide\`（0047 的 \`record_admin_post_hide_audit\` 写它）。` +
      `实际 ${postish.length} 个：${JSON.stringify(postish)}。\n` +
      `如果这条红了：多出来的动作要么还没有库内写入点（先写迁移再进闭集），要么是拼写漂移。\n\n${FLIP_GUIDE}`,
  );

  // 反向核：闭集里能筛的 post 域动作，必须真有一处迁移在写（否则就是「能筛但没人写」的假面）。
  const inDbWriters = listSqlFiles(MIGRATIONS_DIR).filter((file) => {
    const text = readFileSync(file, 'utf8');
    return /INSERT INTO public\.admin_audit_events/i.test(text) && text.includes("'post.hide'");
  });
  assert.deepEqual(
    inDbWriters.map(repoPath),
    ['services/api/db/migrations/0047_admin_post_hide_audit.sql'],
    '闭集里的 `post.hide` 必须**恰好**由一处迁移写入（读面与写入点一比一）：' +
      `实际命中 ${JSON.stringify(inDbWriters.map(repoPath))}`,
  );
});

test('钉⑤：后台运维 store 是进程内内存实现 —— `services/api/src` 里没有 PG 版 `createPostgresAdminOpsStore`，也没有一条写审计表的 SQL', () => {
  // 钉 1/3：`admin/ops/store.ts` 自己声明非持久 —— **恰好两处**：内核接口
  // `readonly persistent: false;`（`:43`）与实现体 `persistent: false,`（`:139`）。
  //
  // 为什么用精确相等而不是 `>= 2`：`>= 2` 只要求「这段文本里出现两次」，实现体改成
  // `persistent: true` 之后若有别处凑巧再出现一次，`>= 2` 仍然是绿的 —— 那个口子让这条钉
  // 可以被「无关改动」意外满足。精确相等把它关掉。
  // 漂移风险评估：这份 200 行出头的 store 里 `persistent:` 只有这两处声明；真多出第三处，本身就说明
  // 持久化口径变了，失败信息直接指到该看的那两处，不会让复核者猜。
  const storePath = join(SRC_DIR, 'admin', 'ops', 'store.ts');
  const storeText = readFileSync(storePath, 'utf8');
  const persistentFalse = storeText.match(/persistent:\s*false/g) ?? [];
  assert.equal(
    persistentFalse.length,
    2,
    '`services/api/src/admin/ops/store.ts` 必须**恰好两处**声明 `persistent: false`：' +
      '内核接口（`:43` 的 `readonly persistent: false;`）与实现体（`:139` 的 `persistent: false,`）各一处；' +
      `实际命中 ${persistentFalse.length} 处。少一处/多一处都意味着这份 store 的持久化口径变了 —— ` +
      '实现改持久 ⇒ 本钉翻成正例；多出第三处声明 ⇒ 先看是不是新接口被加进来',
  );

  // 钉 2/3：这份 store 里没有任何 PG 痕迹（`store.ts` 只有内存 Map）。
  const storePg = scanLines([storePath], /createPostgres|new\s+Pool\b|\.query\(|from\s+'pg'/);
  assert.deepEqual(
    storePg,
    [],
    `后台运维 store 今天的实现是**内存**（分类/账号/开关三张表都活在进程里的 Map 上）：` +
      `${repoPath(storePath)} 不得出现 PG 接线。实际命中 ${storePg.length} 处：\n${storePg.join('\n')}\n\n${FLIP_GUIDE}`,
  );

  // 正控：`services/api/src` 下确实有别的 PG 后台 store —— 证明本钉说的不是「全仓没有 PG」。
  const srcHits = (pattern) => scanLines(SRC_FILES, pattern);
  assert.equal(
    srcHits(/createPostgresAdminContentStore/).length >= 1,
    true,
    '正控：`services/api/src` 下必须存在 PG 后台 store（`admin/ops/content-pg.ts` 的 `createPostgresAdminContentStore`），' +
      '否则扫描面/正则错了，「零命中」不能算证据',
  );
  assert.equal(
    srcHits(/createPostgresAdminAuditLogPort/).length >= 1,
    true,
    '正控：审计**读**面的 PG 端口必须存在（`admin/audit/pg.ts` 的 `createPostgresAdminAuditLogPort`，' +
      '走迁移 0033 的 `public.list_admin_audit_logs()`）—— 本钉说的是**写**面没落库，不是「审计完全没有 PG 触点」',
  );

  // 钉 3/3：`services/api/src` 里没有 PG 版运维 store 的工厂（`createAdminOpsStore` 是唯一实现）。
  // 扫描面说明：本条只扫 `services/api/src`（`SRC_FILES`），不是「全仓」—— `tests/**` 里
  // 本文件的断言文本会命中这个标识符，`docs/**` 也会引用它，所以标题与措辞一律写扫描面。
  const pgOpsStores = srcHits(/createPostgresAdminOpsStore/);
  assert.deepEqual(
    pgOpsStores,
    [],
    `\`services/api/src\` 里不得存在 PG 版运维 store 工厂 \`createPostgresAdminOpsStore\`：今天唯一实现是内存的 ` +
      `\`createAdminOpsStore()\`（services/api/src/admin/ops/store.ts:95）。实际命中 ${pgOpsStores.length} 处：\n` +
      `${pgOpsStores.join('\n')}\n\n${FLIP_GUIDE}`,
  );

  // 钉 4/4：`services/api/src` 里没有任何一条写审计表的 SQL —— 写面全在迁移的窄口径函数里。
  const auditWritesInSrc = srcHits(/INSERT\s+INTO.*admin_audit_events/i);
  assert.deepEqual(
    auditWritesInSrc,
    [],
    `运行时不得直接写 \`public.admin_audit_events\`（0017/0020/0027 固化的最小权限：对运行时角色零表级权限），` +
      `审计写入只能走迁移里的窄口径函数。实际命中 ${auditWritesInSrc.length} 处：\n${auditWritesInSrc.join('\n')}\n\n${FLIP_GUIDE}`,
  );
});

test('钉⑥：真下架一次 ⇒ `post.hide` 审计只在内存台账里；换一个进程就是零（重启即丢）', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(11) });
  const admin = await h.adminSession();

  const response = await h.inject('POST', `${API}/admin/posts/${post.id}/hide`, {
    token: admin.token,
    headers: { 'idempotency-key': 'gy-r59-audit-pins-hide-0001', 'if-match': '"1"' },
    payload: { reason: '内容不符合社区规范' },
  });
  assert.equal(response.status, 200, `下架本身必须成功（本钉钉的是它的审计落点）：${JSON.stringify(response.body)}`);

  const store = h.app.adminOpsService.store;
  assert.equal(
    store.persistent,
    false,
    '钉子：后台运维 store 必须仍是 `persistent: false`（services/api/src/admin/ops/store.ts:139）。' +
      '如果它变成 true，说明审计台账已经换成持久实现 —— 本钉必须翻成正例',
  );

  const written = store.audit.list().filter((record) => record.action === 'post.hide');
  assert.equal(
    written.length,
    1,
    `一次下架必须写恰好一条 \`post.hide\` 审计行（多了/少了都说明台账口径变了）：实际 ${written.length} 条`,
  );
  const [record] = written;
  assert.equal(record.scope, OPS_SCOPES.hidePost, '`scope` 取自契约 operations.json 的同名能力');
  assert.equal(record.reason_code, 'post_hidden');
  assert.equal(record.result, 'accepted');
  assert.deepEqual(
    record.target_ref,
    { type: 'post', id: post.id, revision: 1 },
    '审计行必须落到被下架的那一版（revision 1）',
  );

  // 缺口本体：「换一个进程就是零」—— 新建一份 store 等于新进程冷启动（内存台账没有回填来源）。
  //
  // 这一段不能写成光秃秃一句 `audit.count() === 0`：一份刚 new 出来的台账当然是空的 —— 那是
  // 结构性近恒真（哪怕 `createAdminOpsStore()` 变成返回**单例**、哪怕 `audit` 是进程级全局表，
  // 「刚建出来是空的」依然成立）。所以这里补齐三个**能判别**的读数：
  //   ① 两份 store 与两份 audit 台账必须是**不同实例**（不是单例、不共享台账）；
  //   ② 同一时刻两份台账的 `post.hide` 命中数必须是 **1 与 0** —— 台账被共享/单例化时两边会相等；
  //   ③ 新那一份的空读数必须与前一份的**非空读数成对**出现（单看 `=== 0` 没有判别力，作为一对才有）。
  const hitsOf = (auditLog) => auditLog.list().filter((record) => record.action === 'post.hide').length;
  const nextProcess = createAdminOpsStore();
  assert.notEqual(
    nextProcess,
    store,
    '钉子前提：每次 `createAdminOpsStore()` 必须是一份**新实例**（不是单例）。' +
      '若它变成单例，下面「换一个进程就是零」的论证整条失效（新的一份就是旧的那一份）',
  );
  assert.notEqual(
    nextProcess.audit,
    store.audit,
    '钉子前提：审计台账也必须是**新实例** —— 两份 store 不得共享同一个 `audit` 对象' +
      '（共享即等于跨进程共享台账，「重启即丢」就不成立）',
  );
  assert.equal(
    hitsOf(store.audit),
    1,
    `对照读数：当前进程的台账里必须有那次下架留下的 1 条 \`post.hide\`（实际 ${hitsOf(store.audit)} 条）`,
  );
  assert.equal(
    hitsOf(nextProcess.audit),
    0,
    '钉子：新进程（新建 `createAdminOpsStore()`）里读不到那次下架 —— 本臂走的是**内存端口**' +
      '（`HidePostAdapter.persistent === false`），台账只活在进程里；PG 实现（`persistent: true`）自 R64 起' +
      '走迁移 0047 的落库写，那一条由 `tests/integration/admin-post-hide-audit-pg.mjs` 断言。' +
      `实际 ${hitsOf(nextProcess.audit)} 条`,
  );
  assert.notEqual(
    hitsOf(store.audit),
    hitsOf(nextProcess.audit),
    '钉子：两份台账的 `post.hide` 读数必须**不同**（1 与 0）—— 相等说明台账被共享/单例化，' +
      '「换一个进程就是零」的判别力随之消失',
  );
  assert.equal(
    nextProcess.audit.count(),
    0,
    '钉子：新进程（新建 `createAdminOpsStore()`）里的审计台账必须是**空**的 —— ' +
      '内存端口的台账没有回填来源（R64 的库层写只挂在 PG 端口上，本臂没接）。' +
      `实际 ${nextProcess.audit.count()} 条（同刻当前进程为 ${store.audit.count()} 条 —— 两者成对才有判别力）`,
  );
  assert.deepEqual(
    nextProcess.audit.list().filter((record) => record.action === 'post.hide'),
    [],
    `钉子：换一个进程就再也读不到那次下架的审计 —— 这是**内存端口**的性质（真库端口已落库，见 0047）。\n\n${FLIP_GUIDE}`,
  );
});

/** 一份合法的 `PostHideAudit`（字段口径见 `services/api/src/community/store.ts` 的同名接口）。 */
function sampleAudit(overrides = {}) {
  return Object.freeze({
    actorId: 'admin-account-1',
    postId: 'post-pin-7',
    postRevision: 1,
    reasonCode: 'post_hidden',
    requestId: 'req-pin-7',
    ...overrides,
  });
}

test('钉⑦（R64 · 透传钉）：`audit` 必须原样穿过下架观察器 —— 少一个形参就是静默丢参（审计 0 行、下架照样 200）', async () => {
  // 前提：接口的第 5 个参数**真的存在**。若 `CommunityStore.commitPostIfCurrent` 的签名变了
  // （比如把审计并进 `patch`），本钉与 `store-pg.ts` 的转发一起失效，必须先改这一条。
  const hiddenRecord = { id: 'post-pin-7', visibility: 'hidden', author_id: 'user-a', revision: 2 };

  // ---------- ① 运行时：观察器必须把第 5 个实参原样（同一引用）转发给真实 store ----------
  const seen = [];
  const published = [];
  const wrapped = withTakedownObserver(
    {
      // 能力位取 `true`：`persistent` 必须原样转发（real 下架能不能放行由下游判定，不由观察器吞掉）。
      persistent: true,
      getPost: async () => null,
      commitPostIfCurrent: async (...args) => {
        seen.push(args);
        return { ok: true, record: hiddenRecord };
      },
    },
    { events: { publish: async (payload) => (published.push(payload), { delivered: true }) } },
  );
  assert.equal(wrapped.persistent, true, '观察器必须原样转发能力位 `persistent`（吞掉它会让 real 下架永远停在 fail-closed）');

  const audit = sampleAudit();
  const expected = { revision: 1 };
  const result = await wrapped.commitPostIfCurrent('post-pin-7', expected, { visibility: 'hidden' }, null, audit);

  assert.equal(result.ok, true, '观察器必须原样返回 CAS 结果');
  assert.equal(seen.length, 1, '观察器必须**恰好**调用一次真实 store（不重试、不复制调用）');
  assert.equal(
    seen[0].length,
    5,
    '`withTakedownObserver().commitPostIfCurrent` 必须向下转发**全部 5 个实参**（第 5 个是迁移 0047 的 `audit`）：' +
      `实际只转发 ${seen[0].length} 个。少转发 ⇒ \`store-pg.ts\` 的 \`POST_HIDE_AUDIT_SQL\` 永远不执行 ⇒ ` +
      '下架 200、帖子变 hidden、审计 0 行（R64 红点原样复现）',
  );
  assert.equal(
    seen[0][4],
    audit,
    '第 5 个实参必须是**同一个对象引用**原样抵达下游 store（不是复制、不是重建、不是丢弃）',
  );
  assert.equal(seen[0][3], null, '第 4 个实参 `moderation` 也必须原样转发（位置不能串）');
  assert.equal(published.length, 1, '下架事件仍必须恰好投递一次（透传修正不得改变通知语义）');
  assert.deepEqual(
    published[0].target,
    { type: 'post', id: 'post-pin-7', revision: 1 },
    '事件版本取**处置前**的 `expected.revision`（见 `takedown.ts` 的口径注释）',
  );

  // ---------- ② 正向对照：`audit` 缺省（省略 / 显式 `undefined`）不得抛，且落成 `null` ----------
  // 反向风险：如果修透传时把 `audit` 写成必填、或在观察器里解构它，内存端口与老调用点会当场炸。
  seen.length = 0;
  published.length = 0;
  const omitted = await wrapped.commitPostIfCurrent('post-pin-7', expected, { visibility: 'hidden' }, null);
  const explicitUndefined = await wrapped.commitPostIfCurrent(
    'post-pin-7',
    expected,
    { visibility: 'hidden' },
    null,
    undefined,
  );
  assert.equal(omitted.ok, true, '省略第 5 个实参时下架必须照常成功（审计是可选能力，不是前置条件）');
  assert.equal(explicitUndefined.ok, true, '显式传 `undefined` 时下架必须照常成功（不得因审计缺省抛错）');
  assert.deepEqual(
    seen.map((args) => args.length),
    [5, 5],
    '缺省 `audit` 时观察器仍然必须转发 5 个实参（第 5 个是默认值 `null`，不是「少一个」）',
  );
  assert.deepEqual(
    seen.map((args) => args[4]),
    [null, null],
    '缺省 `audit` 必须落成 `null`（与 `store-pg.ts` 的 `audit: PostHideAudit | null = null` 对齐）',
  );
  assert.equal(published.length, 2, '缺省 `audit` 不改变通知语义：两次下架各投递一次事件');

  // ---------- ③ 源码钉：`store-pg.ts` 的 `commitPostIfCurrent` 必须真的把 `audit` 传下去 ----------
  // 运行时桩测不到这一处（真 store 需要 PG），所以按本文件的既有体例做**有正控的源码扫描**。
  const pgStorePath = join(SRC_DIR, 'community', 'store-pg.ts');
  const pgStoreText = readFileSync(pgStorePath, 'utf8');
  // 正控 0：`commitPost` 的第 5 个形参确实叫 `audit`（否则下面「转发 audit」就是在转发一个不存在的位置）。
  assert.equal(
    (pgStoreText.match(/^\s*audit: PostHideAudit \| null = null,$/gm) ?? []).length,
    1,
    '正控：`store-pg.ts` 的 `commitPost(...)` 必须有且只有一处第 5 形参 `audit: PostHideAudit | null = null` —— ' +
      '零处说明签名变了（本钉与 `POST_HIDE_AUDIT_SQL` 的调用点要一起改），多处说明多了第二条审计入口',
  );
  const pgCommitIfCurrent = pgStoreText.match(
    /async commitPostIfCurrent\(([^)]*)\)\s*\{([\s\S]*?)\n {4}\},/,
  );
  assert.ok(
    pgCommitIfCurrent !== null,
    '正控：`store-pg.ts` 里必须能读到 `async commitPostIfCurrent(...) { ... },` 的实现体 —— 读不到说明实现换了形状，' +
      '本钉的源码扫描要跟着改（不允许默默变绿）',
  );
  const pgParams = pgCommitIfCurrent[1].split(',').map((part) => part.trim());
  assert.equal(
    pgParams.length,
    5,
    '`store-pg.ts` 的 `commitPostIfCurrent` 必须声明 **5 个形参**（第 5 个是 `audit`）：' +
      `实际 ${pgParams.length} 个 [${pgParams.join(' | ')}]。TS 不会因为少写形参报错，只有这条能钉住`,
  );
  assert.match(
    pgParams[4],
    /^audit\b/,
    `\`store-pg.ts\` 的第 5 个形参必须是 \`audit\`（位置不能串、名字不能换成别的载荷）：实际 \`${pgParams[4]}\``,
  );
  assert.match(
    pgCommitIfCurrent[2],
    /return\s+commitPost\(\s*id\s*,\s*expected\s*,\s*patch\s*,\s*moderation\s*,\s*audit\s*\)\s*;/,
    '`store-pg.ts` 的 `commitPostIfCurrent` 必须把 `audit` **作为第 5 个实参**转给 `commitPost`：' +
      `实际实现体为 \`${pgCommitIfCurrent[2].trim()}\`。少了这一个实参 ⇒ 审计永不落库（R64 红点）`,
  );

  // ---------- ④ 内存实现：**接收但明确忽略**，且必须保持 `persistent: false` ----------
  // 「库层写」与「内存台账」二选一：内存端口必须继续靠服务层的 `appendAudit` 记账，
  // ⛔ 不允许它在 `commitPostIfCurrent` 里再私自记一遍（那会变成一条动作两条审计）。
  const memoryStorePath = join(SRC_DIR, 'community', 'store.ts');
  const memoryStoreText = readFileSync(memoryStorePath, 'utf8');
  assert.match(
    memoryStoreText,
    /async commitPostIfCurrent\(id, expected, patch, moderationRecord, _audit = null\)/,
    '内存实现的 `commitPostIfCurrent` 必须**显式接收**第 5 个参数（名字带 `_` 前缀表示明确忽略）：' +
      '省掉形参虽然 TS 不报错，但会让「谁在丢参」在签名上彻底看不出来',
  );
  assert.doesNotMatch(
    memoryStoreText,
    /commitPost\(id, expected, patch, moderationRecord, _audit\)/,
    '内存实现不得把 `audit` 往后传（内存 `commitPost` 没有审计通路）——⛔ 也不得在内存里自己记一条，' +
      '那会与 `admin/ops/service.ts` 的 `appendAudit` 形成**双记**',
  );

  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(21) });
  assert.equal(h.store.persistent, false, '内存 store 的 `persistent` 必须仍是 `false`（服务层据此走内存台账）');
  const memoryResult = await h.store.commitPostIfCurrent(
    post.id,
    { revision: 1 },
    { visibility: 'hidden' },
    null,
    sampleAudit({ postId: post.id }),
  );
  assert.equal(memoryResult.ok, true, '内存实现**接收**第 5 个实参后必须照常完成 CAS（不抛、不因审计入参拒绝下架）');
  assert.equal(memoryResult.record.visibility, 'hidden', '内存实现的下架语义不因审计入参改变');
});

