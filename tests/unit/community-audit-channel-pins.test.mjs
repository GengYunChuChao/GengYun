/**
 * A 档回归钉 · 「后台下架（`post.hide`）的审计**不落库**」这个缺口（基线 `31291afb`）。
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
 * ## 声明
 *
 * 行为层（钉⑥）走**真实 `buildApp` + 真实后台路由**（`POST /api/v1/admin/posts/:id/hide`），
 * 但模型端口是合成替身（`passingPort`），不发起任何真实模型/付费调用，也不连数据库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import { AUDIT_ACTIONS } from '../../services/api/src/admin/audit/catalog.ts';
import { OPS_SCOPES } from '../../services/api/src/admin/ops/service.ts';
import { createAdminOpsStore } from '../../services/api/src/admin/ops/store.ts';
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
  '  在翻钉之前，任何「下架审计已落库」的说法都与本文件冲突。';

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

test('钉③：`db/migrations` 里没有任何 `post.hide` 的 DDL / 函数 —— 下架审计今天没有落库通路', () => {
  // 正控 1：扫描面非空（顶层 43 条 + `rollback/` 42 条 = 85，递归才不漏）。
  assert.ok(
    MIGRATION_FILES.length >= 80,
    `扫描面必须非空：实际只看到 ${MIGRATION_FILES.length} 个 .sql（期望 ≥ 80，含 rollback/）`,
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

  // 钉：迁移里没有 `post.hide` / `post_hidden` / `post-hide` 的任何痕迹。
  const hits = scanLines(MIGRATION_FILES, /post[._-]?hide/i);
  assert.deepEqual(
    hits,
    [],
    `后台下架的审计**没有**任何落库通路：\`services/api/db/migrations\`（${MIGRATION_FILES.length} 个 .sql，含 rollback/）` +
      `里不得出现 \`post.hide\` 的任何 DDL / 函数 / 写入。实际命中 ${hits.length} 处：\n` +
      `${hits.join('\n')}\n\n${FLIP_GUIDE}`,
  );
});

test('钉④：审计读面的 `action` 闭集里没有 `post.hide` —— 读面认不出这个动作', () => {
  // 正控：闭集非空且可枚举（它是「谁在写 admin_audit_events」反推出来的单一来源）。
  assert.ok(
    AUDIT_ACTIONS.length >= 4,
    `正控：\`AUDIT_ACTIONS\` 至少含 4 个库内写入动作，实际 ${JSON.stringify(AUDIT_ACTIONS)}`,
  );

  const postish = AUDIT_ACTIONS.filter((action) => /post/i.test(action));
  assert.deepEqual(
    postish,
    [],
    `下架动作不得出现在审计读面闭集里：\`services/api/src/admin/audit/catalog.ts\` 的 \`AUDIT_ACTIONS\` 是` +
      `「谁在往 \`public.admin_audit_events\` 写」的单一来源（同文件 :6-13 列出 4 处库内窄口径函数），` +
      `今天没有任何一处写 \`post.hide\`。实际多出来 ${postish.length} 个：${JSON.stringify(postish)}。\n` +
      `如果这条红了，说明有人给闭集加了动作却没有配套的库内写入点（或反过来）——先对齐再决定翻钉。\n\n${FLIP_GUIDE}`,
  );
});

test('钉⑤：后台运维 store 是进程内内存实现 —— 全仓没有 PG 版 `createPostgresAdminOpsStore`，src 里没有一条写审计表的 SQL', () => {
  // 钉 1/3：`admin/ops/store.ts` 自己声明非持久（接口 `:43` + 实现 `:139` 各一次）。
  const storePath = join(SRC_DIR, 'admin', 'ops', 'store.ts');
  const storeText = readFileSync(storePath, 'utf8');
  const persistentFalse = storeText.match(/persistent:\s*false/g) ?? [];
  assert.ok(
    persistentFalse.length >= 2,
    '`services/api/src/admin/ops/store.ts` 必须同时在内核接口与实现里声明 `persistent: false`：' +
      `实际命中 ${persistentFalse.length} 处（接口 :43、实现 :139）。` +
      '少一处意味着这份 store 可能已经改成持久实现，本钉必须复核',
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

  // 钉 3/3：全仓没有 PG 版运维 store 的工厂（`createAdminOpsStore` 是唯一实现）。
  const pgOpsStores = srcHits(/createPostgresAdminOpsStore/);
  assert.deepEqual(
    pgOpsStores,
    [],
    `不得存在 PG 版运维 store 工厂 \`createPostgresAdminOpsStore\`：今天唯一实现是内存的 ` +
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
  const nextProcess = createAdminOpsStore();
  assert.equal(
    nextProcess.audit.count(),
    0,
    '钉子：新进程（新建 `createAdminOpsStore()`）里的审计台账必须是**空**的 —— ' +
      '因为下架审计从不落库，`public.admin_audit_events` 里从来没有这一行。' +
      `实际 ${nextProcess.audit.count()} 条`,
  );
  assert.deepEqual(
    nextProcess.audit.list().filter((record) => record.action === 'post.hide'),
    [],
    `钉子：换一个进程就再也读不到那次下架的审计 —— 这是缺口，不是功能。\n\n${FLIP_GUIDE}`,
  );
});
