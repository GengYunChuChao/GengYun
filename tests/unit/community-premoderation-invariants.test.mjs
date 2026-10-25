/**
 * R59 · 社区「先审后发」**现状口径**的机读钉子（六条）。
 *
 * ## 这个文件是什么
 *
 * 它不验证「社区能不能用」（那要真库、真审核域、真小程序），它验证**登记过的现状没有悄悄变**：
 * 把「先审后发现在是两步、人审通过/驳回根本不存在、后台是结构性零、收藏不覆盖社区」写成
 * **可机读的结构事实**。于是
 *   · 谁**悄悄补上**人审动作（新增 `/admin/posts/{id}/approve`、让占位页开始发请求）⇒ 本文件红
 *     （只读读面已随 #621 落地，本条仍只管**审核动作**；见钉 1）；
 *   · 谁**悄悄回退**先审后发（把 `private/pending` 改成 `published/approved`、绕过 `awaitingPublish`）⇒ 本文件红；
 *   · 谁**只搬运**代码（行号漂移）⇒ 本文件红，但失败提示会明说「只是漂移，改常数即可」。
 *
 * 红的时候**多数不是**「你写错了」，而是：**现状口径变了，请把这个钉子一起翻转**（见每条里的
 * 「👉 什么改动会让它红」与 `FLIP_HINT`）。这是刻意的 —— 六个事实都是**登记过的现状**，
 * 不能靠一次顺手改动让登记失效；反过来，登记失效而不红，比红更糟。
 *
 * ## 基线
 *
 * 立文件时的基线：`origin/main = f6c5866dd06683329ecfe96d9c489cd9a226502d`
 * （2026-10-26 02:36:34 +0800，「test(s4): 修正数据面缺口钉的过期口径与行号（零行为改动）」）。
 * 每条常数都由**实测逐条核对**过，不是抄文档；证据页见
 * `docs/verification/r59-community-premoderation-20261026.md`。
 *
 * ## 六条钉子（判据位置 / 断言什么 / 什么改动会让它红）
 *
 * | # | 判据位置 | 断言什么 | 什么改动会让它红 |
 * | - | --- | --- | --- |
 * | 1 | `packages/contracts/openapi.json`：数 `paths` 键（不是 grep 关键词） | 含 `/admin/posts` 的 path **恰好三条**：两条**只读读面** `GET /admin/posts`（`listAdminPosts`）+ `GET /admin/posts/{id}`（`getAdminPost`，各自只允许 `get`、`x-scope` 恰为 `sources:read`）+ 下架 `POST /admin/posts/{id}/hide`（`hidePost`，仍只允许 `post`）；全家方法全集恰为 `get`×2 + `post`×1 | 契约新增任何 `/admin/posts/...` 的**审核动作** path（approve/reject/…）、给这三条换 method/改名、或让读面带写 scope。③/③b 的 operationId 命名式负向扫描还能抓到「审核动作挂到别的 path 下」 |
 * | 2 | `services/api/src/community/service.ts`：`createPost`（:1052/:1066-1067）**与** `editPost`（:1188/:1197-1198）两处 | 每处三行都**逐字**钉住：`visibility` 三元组落 `'private' : 'published'`、`audit_state` 落 `'pending' : 'approved'`，`awaitingPublish` 定义为 `!mediaReview && screen !== null && link !== null`；且两处都是「先落库（`insertPost` / `commitPostIfCurrent`）→ 再 `link.publish` → 再回读」 | 初始写入被改回 `published/approved`（先审后发被拆掉）；把 `awaitingPublish` 恒置 `false`（三元组文本不变却永远不走待审）；两步顺序颠倒；或**只改一处**（发帖待审、改帖直接发） |
 * | 3 | `services/api/src/favorites/**`（`types.ts:24` 为闭集定义、`:74-76` 为唯一判定函数） | `FAVORITE_TARGET_TYPES` **逐字** `['species','herbicide','scheme']`；`isFavoriteTargetType` 仍由该常量派生；`favorites/**` 里**没有任何** `'post'` / `'comment'` 字面量 | 把社区帖子/评论加进收藏闭集（无论加在常量、判定函数还是别处的字面量） |
 * | 4 | `apps/admin/src/views/ReviewPlaceholderView.vue` 全文 | 该页**没有任何真网络调用形态**（`fetch(`/`axios`/`XMLHttpRequest`/`*Api.<method>`/`$fetch`/网络模块 import 等），数据仍只来自 `../lib/review-state.mjs` | **预期会红**：一旦人审后台真的实现（哪怕只是开始拉队列），这一页必须改成读真实数据 —— 届时先加契约读面，再翻转本钉子。⛔ 不要为了让本钉子变绿把模式改窄 |
 * | 5 | 小程序三页的**具体行** | `community.js:192`、`communitydetail.js:176`、`communitycreate.js:106` 仍写 `'待审／未公开'`（全角斜杠）；`communitydetail.js:173` 仍写 `'未公开／待审'`＋`'已通过先行审核'`；且三页**都没有**「已驳回」态 | 新增/改写作者侧状态文案（尤其**补上**「已驳回」态、或把「待审」改成「审核中」）；行号漂移同样红 |
 * | 6 | `services/api/src` 全树扫字面量 `gateCommunityService`；`app.ts` 单独断；`tests/` 扫调用点 | 除定义文件 `admin/ops/flag-gate.ts` 外**零引用**，`app.ts` **零出现** ⇒ **未装配**；测试侧唯一调用点是 `tests/unit/admin-flag-gate.test.mjs`；装饰器本体仍是 `return Object.freeze(wrapped) as T` | 任何装配（`app.ts` import/调用、新 bootstrap 模块、路由注入）；或反过来把装饰器掏空成空壳（那会让「未装配」变成「装了也没用」，同样要红）。⚠ 文本扫描有盲区，见该条注释 |
 *
 * ## 硬约束（改本文件时不许破）
 *
 * - **只读**：不建临时目录、不写仓内任何文件、不起子进程、不连库。
 * - **零外部依赖**：只 `node:fs` / `node:path` / `node:url` + `node:test` / `node:assert`，
 *   不 import 被测模块（**故意**：import 会让「文件还在、内容被换掉」这类漂移测不出来 ——
 *   第 4 条尤其如此，占位页一旦接线，import 式断言只会跟着新实现一起绿）。
 * - **断言只用严格相等**（`assert.equal` / `assert.deepEqual`）：⛔ 不用 `assert.ok(x.length >= 1)`、
 *   ⛔ 不用 `assert.match` 兜模糊匹配 —— 现状钉子一旦放宽判据就退化成橡皮图章。
 * - 用例数固定 6；⛔ 无 `skip` / `only` / `todo`。
 *
 * 单跑：`node --test tests/unit/community-premoderation-invariants.test.mjs`
 * （`npm run test:unit` 的 glob 是 `tests/unit/*.test.mjs`，本文件自动被收。）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（`tests/unit/` 的上两级），⛔ 不用 `process.cwd()`。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 立文件时的基线 SHA（留档追溯；证据页与失败提示里的「基线」都指它）。 */
const BASELINE_SHA = 'f6c5866dd06683329ecfe96d9c489cd9a226502d';

/**
 * 本文件自己的仓库相对路径。
 *
 * ⚠ 自指陷阱（同 `tests/unit/s4-data-gap-pins.test.mjs` 实测踩过的那个）：本文件在判据与失败提示里
 * 逐字写了 `gateCommunityService`，于是「全仓扫这个符号」会把钉子文件自己数进去 ⇒ 第 6 条假红。
 * 凡扫到 `tests/` 的判据都必须排掉 `SELF_FILE`；排掉的只是**自己**，不是判据面。
 */
const SELF_FILE = 'tests/unit/community-premoderation-invariants.test.mjs';

/** 每条钉子红的时候都要说的同一句话：现状口径变了，请**翻转钉子**，不是把判据改松。 */
const FLIP_HINT = '\n\n👉 现状口径变了：请把本钉子的期望值**和**证据页 '
  + 'docs/verification/r59-community-premoderation-20261026.md 一起改成新事实。'
  + '\n⛔ 不要为了让本文件变绿而放宽判据（换成 `includes` / `>=` / 模糊正则都算），'
  + '也不要删掉这一条 —— 本文件的全部价值就是「口径一动就红」。';

/**
 * 拼一条「什么改动会让它红」的尾注。
 *
 * @param {string} change 会触发这条断言红的具体改动
 * @returns {string}
 */
function because(change) {
  return `\n\n👉 什么改动会让它红：${change}${FLIP_HINT}`;
}

/** 遍历时跳过的目录名：VCS、依赖、构建产物、本机证据目录。 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.pg17']);

/** Windows 分隔符归一化成 `/`，让「仓库相对路径」在所有平台上都是同一个字符串。 */
const toPosix = (p) => p.split(sep).join('/');

/**
 * 读一个**仓库相对路径**的 UTF-8 文本。
 *
 * @param {string} relPosix 例：`services/api/src/community/service.ts`
 * @returns {string}
 */
function readRepoText(relPosix) {
  const abs = join(REPO_ROOT, ...relPosix.split('/'));
  assert.equal(
    existsSync(abs),
    true,
    `判据位置不存在：${relPosix}\n`
      + '本钉子的扫描面/锚点少了一个文件 ⇒ 若它只是搬家，请先确认新位置再改本文件；'
      + '⛔ 不要靠删断言让它变绿。',
  );
  return readFileSync(abs, 'utf8');
}

/**
 * 读一个仓库相对文件的**行数组**（`\n` 切分，行号 1 起，与 `git grep -n` 口径一致；本仓全为 LF）。
 *
 * @param {string} relPosix
 * @returns {string[]}
 */
function linesOf(relPosix) {
  return readRepoText(relPosix).split('\n');
}

/**
 * 递归列出某个仓库相对目录下的**全部文件**（仓库相对 POSIX 路径，已排序）。
 *
 * @param {string} rootRelPosix 例：`services/api/src`
 * @returns {string[]}
 */
function walkFiles(rootRelPosix) {
  const absRoot = join(REPO_ROOT, ...rootRelPosix.split('/'));
  assert.equal(
    existsSync(absRoot),
    true,
    `扫描根不存在：${rootRelPosix}（目录改名/被删 ⇒ 下面的「零命中」会退化成空转，故先在这里 red）`,
  );
  /** @type {string[]} */
  const out = [];
  const visit = (dirAbs) => {
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      // 软链不跟：可能指回本目录造成环，也可能指到 node_modules。
      if (entry.isSymbolicLink()) continue;
      const childAbs = join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        visit(childAbs);
      } else if (entry.isFile()) {
        out.push(toPosix(relative(REPO_ROOT, childAbs)));
      }
    }
  };
  visit(absRoot);
  return out.sort();
}

/**
 * 子串出现次数（不重叠）。
 *
 * @param {string} text
 * @param {string} needle
 * @returns {number}
 */
const occurrences = (text, needle) => text.split(needle).length - 1;

/**
 * 行级扫描：返回某文件里包含字面量 `needle` 的 `{ line, text }`（`text` 已 `trim()`）。
 *
 * @param {string} relPosix
 * @param {string} needle 字面量（⛔ 不用正则：字面量才不会被元字符悄悄放宽）
 * @returns {Array<{ line: number, text: string }>}
 */
function hitsOf(relPosix, needle) {
  /** @type {Array<{ line: number, text: string }>} */
  const out = [];
  linesOf(relPosix).forEach((line, i) => {
    if (line.includes(needle)) out.push({ line: i + 1, text: line.trim() });
  });
  return out;
}

/**
 * 钉住「某文件里**逐字**等于 X 的那些行，恰好是第 N₁、N₂… 行」。
 *
 * 为什么钉的是一个**列表**而不是单点：同一行代码在社区域里有**两处**同口径落点
 * （发帖 `createPost` 与改帖 `editPost`）。只钉一处就挡不住「发帖待审、改帖直接发」的旁路 ——
 * 那正是这个钉子最该抓的东西。
 *
 * 红法在提示里自述：
 *   · 命中**数**变了 ⇒ 语义变了（某处被改写，或多出/少掉一个落点）；
 *   · 命中数没变、只有行号不同 ⇒ 只是漂移，把常数改成新行号即可。
 *
 * @param {{ file: string, expectLines: number[], expectText: string, why: string }} spec
 */
function pinLines({ file, expectLines, expectText, why }) {
  /** @type {number[]} */
  const at = [];
  linesOf(file).forEach((line, i) => {
    if (line.trim() === expectText) at.push(i + 1);
  });
  const driftOnly = at.length === expectLines.length;
  assert.deepEqual(
    at,
    expectLines,
    `${file} 里「${expectText}」的命中行集合变了（逐字相等，缩进已忽略）：`
      + `\n  实测：${JSON.stringify(at)}`
      + `\n  基线（${BASELINE_SHA.slice(0, 8)}）：${JSON.stringify(expectLines)}`
      + (driftOnly
        ? '\n  ⚠ 命中**数**没变、只是行号不同 ⇒ 这是一次无关编辑把它推走/拉回了：'
          + '把本文件的 expectLines 改成实测值即可，并顺手核对证据页里同一个行号。**语义未变。**'
        : '\n  ⚠ 命中**数**变了 ⇒ 这是语义变化（某处被改写 / 多出或少了同口径落点），不是漂移。')
      + because(why),
  );
}

// ---------------------------------------------------------------------------
// 钉 1 · 契约里 `/admin/posts` = 两条只读读面 + 一条下架（审核动作仍为零）
// ---------------------------------------------------------------------------

/** OpenAPI path item 里算「操作」的键（`parameters`/`summary` 之类不算）。 */
const HTTP_METHODS = ['get', 'put', 'post', 'patch', 'delete', 'head', 'options', 'trace'];

/** 人审动作的**命名式**负向扫描表（见断言 ③ 的自述风险）。 */
const REVIEWY_OPERATION_ID = /^(?:approve|reject|review|publish|moderate)[A-Za-z]*Post$/;

test('钉 1 · 契约里 `/admin/posts` = 两条只读读面（list/detail）+ 一条下架，没有审核动作', () => {
  const spec = JSON.parse(readRepoText('packages/contracts/openapi.json'));
  const paths = Object.keys(spec.paths ?? {});
  const methods = Object.keys(spec.paths ?? {}).length;

  // 前提：数的是 `paths` 的**键**，不是关键词命中 —— 先确认文件真的解析出了路径表。
  assert.equal(
    paths.length > 80,
    true,
    `openapi.json 的 paths 只有 ${paths.length} 条（key 数 ${methods}）⇒ 契约文件结构变了，`
      + '本钉子的「数 path 数量」判据失去前提。⛔ 不要改成 grep。',
  );

  // ① 含 `/admin/posts` 的 path 恰好三条：两条**只读读面** + 一条下架。
  //    历史：本钉最初钉的是「恰好一条 hide」（后台结构性零）。#621 把后台**只读**读面落地后翻转成三条，
  //    但**审核动作仍然是零** —— ③ / ③b 的命名式负向扫描、以及 ①b / ①c 的 method·scope 严格断言
  //    一条都没放宽（读面被偷偷扩成写面、或改名换 scope，下面每条都会红）。
  const adminPostPaths = paths.filter((path) => path.includes('/admin/posts'));
  assert.deepEqual(
    adminPostPaths,
    ['/admin/posts', '/admin/posts/{id}', '/admin/posts/{id}/hide'],
    '【钉 1 破了】契约里 `/admin/posts` 的 path 集合变了：'
      + `\n  实测：${JSON.stringify(adminPostPaths)}（全 spec 共 ${paths.length} 条 path）`
      + '\n  现状：**三条** —— `GET /admin/posts`（`listAdminPosts`）、`GET /admin/posts/{id}`（`getAdminPost`）、'
      + '`POST /admin/posts/{id}/hide`（`hidePost`）。后台读面**只读**；审核（通过/驳回）动作在契约里**仍然不存在**。'
      + '\n  若你要加 `/admin/posts` 下的**审核动作**（approve/reject/review/publish/moderate）⇒ 那是**新产品能力**：'
      + '请同步 `packages/contracts/operations.json`、`services/api/src/admin/ops/service.ts` 的 operation 表、'
      + '`apps/admin/src/lib/review-state.mjs` 的「结构性零」，并翻转本钉子和钉 4（走需求评审，别顺手改）。'
      + because('契约新增/删除/改名任何 `/admin/posts` path，或把 hide/读面挪到别的路径下。'),
  );

  // ①b 两条读面逐条钉**死**：只允许 `get`、operationId 恰为期望值、`x-scope` 恰为 `sources:read`
  //    （三处都用 `deepEqual` 写死相等，⛔ 不用 `includes`：读面一旦变写面/换 scope 立刻红）。
  /** 读面的期望形状（path → operationId），顺序即 `paths` 实序。 */
  const ADMIN_POST_READ_PATHS = [
    ['/admin/posts', 'listAdminPosts'],
    ['/admin/posts/{id}', 'getAdminPost'],
  ];
  for (const [path, operationId] of ADMIN_POST_READ_PATHS) {
    const item = spec.paths[path];
    assert.equal(
      typeof item === 'object' && item !== null,
      true,
      `契约里 \`${path}\` 的 path item 不是对象 ⇒ 判据位置失效了。`,
    );
    const readOperations = Object.entries(item).filter(([key]) => HTTP_METHODS.includes(key));
    assert.deepEqual(
      readOperations.map(([method]) => method),
      ['get'],
      `【钉 1 破了】\`${path}\` 的操作集合变了：`
        + `\n  实测：${JSON.stringify(readOperations.map(([method]) => method))}`
        + '\n  现状：后台读面只有 `get` 一个操作（**只读**）。'
        + because('给后台读面加写方法（`post`/`patch`/`delete`），或把读面改成别的 method。'),
    );
    assert.deepEqual(
      readOperations.map(([, operation]) => operation?.operationId),
      [operationId],
      `【钉 1 破了】\`${path}\` 的 operationId 变了：`
        + `\n  实测：${JSON.stringify(readOperations.map(([, operation]) => operation?.operationId))}`
        + `\n  现状：\`${operationId}\`。`
        + because('改掉读面的 operationId，或把它挪到别的 path 下。'),
    );
    assert.deepEqual(
      readOperations.map(([, operation]) => operation?.['x-scope']),
      ['sources:read'],
      `【钉 1 破了】\`${path}\` 的 x-scope 变了：`
        + `\n  实测：${JSON.stringify(readOperations.map(([, operation]) => operation?.['x-scope']))}`
        + '\n  现状：`sources:read`（后台只读面；写能力只属于下架 `hidePost` 的 `sources:write`）。'
        + because('把读面的 scope 改成写 scope、或删掉 `x-scope`。'),
    );
  }

  // ①c 独立断言：`/admin/posts` 家族的**方法全集**恰为 `get`×2 + `post`×1。
  //    与 ①b/② 重叠是刻意的 —— 这一条把「整族多出第三类方法」变成一个不可能的改动。
  const adminPostMethods = adminPostPaths.flatMap((path) => Object.keys(spec.paths[path] ?? {})
    .filter((key) => HTTP_METHODS.includes(key)));
  assert.deepEqual(
    adminPostMethods,
    ['get', 'get', 'post'],
    '【钉 1 破了】`/admin/posts` 家族的方法全集变了：'
      + `\n  实测：${JSON.stringify(adminPostMethods)}`
      + '\n  现状：两条读面各 `get`、下架一条 `post` —— 家族内**不允许**出现非 `get` 的读面方法或额外的写方法。'
      + because('在 `/admin/posts` 家族里新增/挪入任何除「读面 get」「下架 post」以外的方法。'),
  );

  // ② 下架那条 path 的 method 与 operationId（`hidePost` 是下架，不是审核通过）。
  const hideItem = spec.paths['/admin/posts/{id}/hide'];
  assert.equal(
    typeof hideItem === 'object' && hideItem !== null,
    true,
    '契约里 `/admin/posts/{id}/hide` 的 path item 不是对象 ⇒ 判据位置失效了。',
  );
  const hideOperations = Object.entries(hideItem).filter(([key]) => HTTP_METHODS.includes(key));
  assert.deepEqual(
    hideOperations.map(([method]) => method),
    ['post'],
    '【钉 1 破了】`/admin/posts/{id}/hide` 的操作集合变了：'
      + `\n  实测：${JSON.stringify(hideOperations.map(([method]) => method))}`
      + '\n  基线：只有 `post` 一个操作。'
      + because('给这条 path 加 method（例如批量 hide/`put`），或改成别的 method。'),
  );
  assert.deepEqual(
    hideOperations.map(([, operation]) => operation?.operationId),
    ['hidePost'],
    '【钉 1 破了】`/admin/posts/{id}/hide` 的 operationId 变了：'
      + `\n  实测：${JSON.stringify(hideOperations.map(([, operation]) => operation?.operationId))}`
      + '\n  基线：`hidePost`（下架一条已发布内容；`x-scope: sources:write`）。'
      + `\n  ⚠ 若你把它改成 hidePostAndReject 之类 ⇒ 提醒一句：**下架 ≠ 驳回**，`
      + '驳回是审核域在发布前做的（内容行不落库），下架是发布后的可见性 CAS。'
      + because('改掉 hidePost 这个名字（改名的同时记得它在下架语义上的边界）。'),
  );

  // ③ 兜底：人审动作**挂到别的 path 下**时 ①② 都会绿，所以再按 operationId 命名扫一遍全 spec。
  //    ⚠ 自述风险：这是**命名式**判据 —— 换个名字（`admitPost` / `setPostAuditState`）就能绕过；
  //    真正可靠的是 ① 的 path 全集。这条只用来抓「顺手加了个 approvePost」这种最可能的落法。
  /** @type {string[]} */
  const reviewyOperations = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    if (item === null || typeof item !== 'object') continue;
    for (const [key, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(key)) continue;
      const operationId = operation?.operationId;
      if (typeof operationId === 'string' && REVIEWY_OPERATION_ID.test(operationId)) {
        reviewyOperations.push(`${key.toUpperCase()} ${path} → ${operationId}`);
      }
    }
  }
  assert.deepEqual(
    reviewyOperations,
    [],
    '【钉 1 破了】契约里出现了「通过/驳回/审核帖子」形态的 operationId：'
      + `\n  实测：${JSON.stringify(reviewyOperations)}`
      + '\n  基线：全 spec **零命中** —— 人工通过/驳回这个动作在契约里从来不存在'
      + '（内容要么在发布前由审核域自动放行，要么根本不落库）。'
      + '\n  👉 这是**新增能力**，不是修 bug：请按 ① 的提示把三层（契约/服务/后台）一起做，并翻转钉 4。'
      + because('新增任何名为 `approvePost` / `rejectPost` / `reviewPost` 形态的 operation（无论挂在哪个 path 下）。'
        + '\n  （本条是命名式判据：改名即可绕过，别把它当成完备保证。）'),
  );

  // ③b ③ 的**家族内加强版**：判据比 ③ 宽 —— 不要求以 `Post` 结尾，只要挂在 `/admin/posts` 家族下、
  //     operationId 里出现审核动词（approve / reject / review / publish / moderate）就必须红。
  //     这样「把 `postApprove` / `moderatePostById` 挂到读面 path 下」也逃不掉；
  //     ⚠ 仍是命名式判据，完备保证仍旧靠 ① 的 path 全集与 ①b/①c 的 method·scope 严格断言。
  const ADMIN_POST_REVIEWY_OPERATION_ID = /approve|reject|review|publish|moderate/i;
  /** @type {string[]} */
  const familyReviewyOperations = [];
  for (const path of adminPostPaths) {
    for (const [key, operation] of Object.entries(spec.paths[path] ?? {})) {
      if (!HTTP_METHODS.includes(key)) continue;
      const operationId = operation?.operationId;
      if (typeof operationId === 'string' && ADMIN_POST_REVIEWY_OPERATION_ID.test(operationId)) {
        familyReviewyOperations.push(`${key.toUpperCase()} ${path} → ${operationId}`);
      }
    }
  }
  assert.deepEqual(
    familyReviewyOperations,
    [],
    '【钉 1 破了】`/admin/posts` 家族里出现了审核动作形态的 operationId：'
      + `\n  实测：${JSON.stringify(familyReviewyOperations)}`
      + '\n  现状：家族内只有 `listAdminPosts` / `getAdminPost` / `hidePost` —— **零**审核动作。'
      + '\n  👉 这是**新增能力**，不是修 bug：走需求评审，并与 ① 的三层同步一起做（别只加契约）。'
      + because('在 `/admin/posts` 家族下新增任何名字里带 approve/reject/review/publish/moderate 的 operation。'),
  );
});

// ---------------------------------------------------------------------------
// 钉 2 · 社区发帖的两步状态：先落 private/pending，同请求内再 publish
// ---------------------------------------------------------------------------

const COMMUNITY_SERVICE = 'services/api/src/community/service.ts';

/** `createPost` 体内决定「落库时是什么状态」的那一行（逐字）。 */
const CREATE_POST_VISIBILITY_LINE = "visibility: awaitingPublish || mediaReview ? 'private' : 'published',";

/** 同上，审核态那一行（逐字）。 */
const CREATE_POST_AUDIT_LINE = "audit_state: awaitingPublish || mediaReview ? 'pending' : 'approved',";

/** 「这一步要不要停在待审」的判据（逐字）—— 只钉三元的文本挡不住「把它恒置 false」。 */
const AWAITING_PUBLISH_LINE = 'const awaitingPublish = !mediaReview && screen !== null && link !== null;';

test('钉 2 · 发帖先落 `private`/`pending`，同请求内再由审核域 publish 改 `published`', () => {
  // ① 三行锚点：文本（语义）＋ 行号（漂移）分开断言。
  //    ⚠ 每一条都钉**两处**：发帖（`createPost`）与改帖（`editPost`，新 revision 必须重送审）。
  //    只钉发帖那一处就漏掉了「发帖待审、改帖直接发」的旁路 —— 那正是最该抓的东西。
  pinLines({
    file: COMMUNITY_SERVICE,
    expectLines: [1066, 1197],
    expectText: CREATE_POST_VISIBILITY_LINE,
    why: '把初始可见性改回 `published`（例如退化成 `visibility: \'published\'`）、'
      + '改掉三元组的分支条件（`awaitingPublish` → 别的谓词），'
      + '或**只改一处**（发帖待审 / 改帖直接发，或反过来）',
  });
  pinLines({
    file: COMMUNITY_SERVICE,
    expectLines: [1067, 1198],
    expectText: CREATE_POST_AUDIT_LINE,
    why: '把初始审核态改回 `approved`、让 `private` 与 `pending` 不再成对出现'
      + '（`private` + `approved` 是自相矛盾的状态组合），或只改一处',
  });
  pinLines({
    file: COMMUNITY_SERVICE,
    expectLines: [1052, 1188],
    expectText: AWAITING_PUBLISH_LINE,
    why: '**只改这一行就能悄悄关掉先审后发**：`const awaitingPublish = false` 会让上面两行的三元组'
      + '永远走 `published`/`approved` 分支，而文本一个字都不用动 —— 所以这一行必须单独钉住。',
  });

  // ② 三步必须在**同一个函数体内**、且顺序是「先落库 → 再 publish」。
  const lines = linesOf(COMMUNITY_SERVICE);
  const createPostAt = lines.findIndex((line) => line.includes('async createPost('));
  const nextMethodAt = lines.findIndex((line) => line.includes('async getPost('));
  assert.equal(
    createPostAt > -1 && nextMethodAt > createPostAt,
    true,
    `${COMMUNITY_SERVICE} 里切不出 \`createPost\` 的函数体`
      + `（createPost@${createPostAt + 1}、getPost@${nextMethodAt + 1}）⇒ 本钉子的切片判据失效，`
      + '请先确认这两个方法还是相邻的公开方法。',
  );
  // ③ 落库调用**恰好一处**、publish 调用**恰好一处**：多一处就说明有第二条写路径。
  const insertHits = hitsOf(COMMUNITY_SERVICE, 'store.insertPost').filter(
    (hit) => hit.line > createPostAt && hit.line <= nextMethodAt,
  );
  const publishHits = hitsOf(COMMUNITY_SERVICE, 'link.publish(').filter(
    (hit) => hit.line > createPostAt && hit.line <= nextMethodAt,
  );
  assert.deepEqual(
    insertHits.map((hit) => hit.line),
    [1073],
    '【钉 2 破了】`createPost` 里 `store.insertPost` 的调用点不再是恰好一处（:1073）：'
      + `\n  实测：${JSON.stringify(insertHits)}`
      + '\n  基线：先 `store.insertPost`（落 `private`/`pending`），随后 `link.publish` 把它改成 `published`/`approved`。'
      + because('在 createPost 里新增/挪走写库调用（例如改成先请求审核域、拿到放行才落库 —— '
        + '那是**另一种**产品语义，要同步改证据页的「两步」表述）'),
  );
  assert.deepEqual(
    publishHits.map((hit) => hit.line),
    [1084],
    '【钉 2 破了】`createPost` 里 `link.publish(` 的调用点不再是恰好一处（:1084）：'
      + `\n  实测：${JSON.stringify(publishHits)}`
      + '\n  基线：审核域放行就是这一个函数（`community/moderation-link.ts` 的 `publish`）。'
      + because('删掉 publish（贴子会永远停在 pending，先审后发变成「只审不发」），'
        + '或新增第二条放行路径（绕过审核域的直接改状态）'),
  );

  // ④ 顺序：先 insert、后 publish。颠倒 = 先对不存在的行 publish。
  assert.equal(
    insertHits[0].line < publishHits[0].line,
    true,
    '【钉 2 破了】**两步顺序反了**：`link.publish` 现在排在 `store.insertPost` 之前'
      + `（insert@:${insertHits[0].line}、publish@:${publishHits[0].line}）。`
      + '\n  基线的语义是「先以 private/pending 落库，再在同一请求内请求审核域放行」；'
      + '顺序颠倒会让 publish 指向一行还没写入的内容。'
      + because('把 publish 提到 insert 之前。'),
  );

  // ⑤ 「拒绝即停在待审」的自陈 + publish 之后**回读**内容行：
  //    只有这两件都在，「两步」才是真的两步（第二步写完再读回来当作返回值），
  //    而不是「publish 一下、返回值仍用第一步的旧记录」。
  const bodyLines = lines.slice(createPostAt, nextMethodAt);
  const refusHoldsPendingAt = bodyLines.findIndex((line) => line.includes('行保留为 pending_review'));
  assert.equal(
    refusHoldsPendingAt > -1,
    true,
    '【钉 2 · 自陈没了】`createPost` 里找不到「闸门拒绝 ⇒ 行保留为 pending_review」那段自陈：'
      + `\n  基线（:1082-1083）：\`// 第二步：交审核域发布。闸门拒绝 ⇒ **行保留为 pending_review**（私有 / 待审，\``
      + ' / `// 不静默丢弃、也不留 published），错误原样上抛（fail-closed）。`'
      + because('删掉/改掉这段注释（它登记的是「publish 失败时内容行怎么处置」的语义，'
        + '容易被顺手改成「失败就删行」而不被任何测试发现）。'),
  );
  const readBackAt = bodyLines.findIndex((line) => line.trim() === 'const published = await store.getPost(id);');
  assert.equal(
    readBackAt > -1 && readBackAt > publishHits[0].line - createPostAt,
    true,
    '【钉 2 破了】`link.publish(...)` 之后不再回读内容行（找不到 `const published = await store.getPost(id);`）：'
      + `\n  实测行内偏移：${readBackAt}（publish 在偏移 ${publishHits[0].line - createPostAt}）`
      + '\n  基线（:1088-1092）：publish 之后 `store.getPost(id)` 读回**已提交**的行，读不到就报内部不变式违反，'
      + '然后 `committedRecord = published` —— 接口返回的是第二步之后的状态，不是第一步的快照。'
      + because('改成 publish 之后不复读（返回值退回第一步的 `record`，于是接口会把 `private`/`pending` 回给作者，'
        + '或者反过来悄悄把期望当成事实回给作者）。'),
  );

  // ⑥ 改帖（`editPost`）必须走**同一套**两步：先 `commitPostIfCurrent` 落 private/pending，
  //    再 `link.publish` 把这**个新 revision** 改成 published/approved。
  //    ⛔ 只钉 createPost 会漏掉「改帖直接发」这条旁路 —— 它比发帖更隐蔽（改一次就把已发布内容重发了）。
  const editPostAt = lines.findIndex((line) => line.includes('async editPost('));
  const deletePostAt = lines.findIndex((line) => line.includes('async deletePost('));
  assert.equal(
    editPostAt > -1 && deletePostAt > editPostAt,
    true,
    `${COMMUNITY_SERVICE} 里切不出 \`editPost\` 的函数体`
      + `（editPost@${editPostAt + 1}、deletePost@${deletePostAt + 1}）⇒ 本钉子的切片判据失效，`
      + '请先确认这两个方法还是相邻的公开方法。',
  );
  const editCommitHits = hitsOf(COMMUNITY_SERVICE, 'store.commitPostIfCurrent').filter(
    (hit) => hit.line > editPostAt && hit.line <= deletePostAt,
  );
  const editPublishHits = hitsOf(COMMUNITY_SERVICE, 'link.publish(').filter(
    (hit) => hit.line > editPostAt && hit.line <= deletePostAt,
  );
  assert.deepEqual(
    editCommitHits.map((hit) => hit.line),
    [1203],
    '【钉 2 破了】`editPost` 里 `store.commitPostIfCurrent` 的调用点不再是恰好一处（:1203）：'
      + `\n  实测：${JSON.stringify(editCommitHits)}`
      + '\n  基线：改写与审核结论在**同一次 CAS 提交**内写入（`revision`/归属/未删除一起校验），'
      + 'patch 里带的是 `private`/`pending`。'
      + because('新增/挪走改帖的写库调用（例如把「先落待审」改成「先 publish 再落库」）。'),
  );
  assert.deepEqual(
    editPublishHits.map((hit) => hit.line),
    [1214],
    '【钉 2 破了】`editPost` 里 `link.publish(` 的调用点不再是恰好一处（:1214）：'
      + `\n  实测：${JSON.stringify(editPublishHits)}`
      + '\n  基线：改帖同样走审核域的 `publish`（新版本级任务 + 新输入绑定，旧结论不得套到新版本上）。'
      + because('删掉改帖的 publish（新 revision 永远停在 pending，等于「改了就不再可见」），'
        + '或新增绕过审核域的放行路径'),
  );
  assert.equal(
    editCommitHits[0].line < editPublishHits[0].line,
    true,
    '【钉 2 破了】**改帖的两步顺序反了**：`link.publish` 排在 `store.commitPostIfCurrent` 之前'
      + `（commit@:${editCommitHits[0].line}、publish@:${editPublishHits[0].line}）。`
      + because('把 publish 提到 CAS 提交之前（会对着旧 revision 发布新内容）。'),
  );
  assert.equal(
    occurrences(
      lines.slice(editPostAt, deletePostAt).join('\n'),
      'const published = await store.getPost(postId);',
    ),
    1,
    '【钉 2 破了】`editPost` 在 publish 之后不再回读内容行（找不到 '
      + '`const published = await store.getPost(postId);` 恰好一处）：'
      + '\n  基线（:1218-1222）：publish 之后读回**已提交**的新 revision，读不到就报内部不变式违反，'
      + '然后 `committedRecord = published`。'
      + because('改成 publish 之后不复读（接口会把改动前的旧快照回给作者）。'),
  );
});

// ---------------------------------------------------------------------------
// 钉 3 · 收藏闭集不含社区
// ---------------------------------------------------------------------------

const FAVORITES_TYPES = 'services/api/src/favorites/types.ts';

test('钉 3 · `FAVORITE_TARGET_TYPES` 仍是不含 post/comment 的三元闭集', () => {
  const source = readRepoText(FAVORITES_TYPES);

  // ① 闭集逐字（顺序也钉住：它同时是 `FavoriteTargetType` 联合类型的定义源）。
  const declaration = /export const FAVORITE_TARGET_TYPES = \[([^\]]*)\] as const/.exec(source);
  assert.equal(
    declaration === null,
    false,
    `${FAVORITES_TYPES} 里抓不到 \`export const FAVORITE_TARGET_TYPES = [...] as const\`。`
      + '\n  基线（:24）：单行数组，三条字符串字面量。'
      + because('改写成多行、`new Set`、从别处汇总 —— 请同步改本钉子的解析方式（⛔ 别删这条判据）。'),
  );
  const names = [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(
    names,
    ['species', 'herbicide', 'scheme'],
    '【钉 3 破了】收藏闭集 `FAVORITE_TARGET_TYPES` 不再是 `species/herbicide/scheme`：'
      + `\n  实测：${JSON.stringify(names)}`
      + '\n  基线（:24）：`[\'species\', \'herbicide\', \'scheme\'] as const` —— '
      + '**收藏不覆盖社区**：帖子与评论既不可收藏，也不能借收藏入口绕过先审后发。'
      + because('把 `post` / `comment` 加进收藏闭集（这是产品能力扩张，不是 bug 修复：'
        + '要同时改契约 `FavoriteTarget.type`、17 项 `TargetRef`、消息 `reference_state` 的不可用语义）'),
  );

  // ② 判定函数仍**派生**自该常量（防止「常量没变、校验另写一份」的分叉）。
  assert.equal(
    occurrences(source, 'export function isFavoriteTargetType('),
    1,
    `${FAVORITES_TYPES} 里 \`isFavoriteTargetType\` 的定义点不再是恰好一处：`
      + `\n  实测次数：${occurrences(source, 'export function isFavoriteTargetType(')}`
      + because('新增第二份「什么算可收藏目标」的判定实现。'),
  );
  assert.equal(
    occurrences(source, '(FAVORITE_TARGET_TYPES as readonly string[]).includes(value)'),
    1,
    '【钉 3 破了】`isFavoriteTargetType` 不再由 `FAVORITE_TARGET_TYPES` 派生：'
      + `\n  实测次数：${occurrences(source, '(FAVORITE_TARGET_TYPES as readonly string[]).includes(value)')}`
      + '\n  基线（:74-76）：`return typeof value === \'string\' && (FAVORITE_TARGET_TYPES as readonly string[]).includes(value);`'
      + because('把校验改成另一份硬编码清单（那样常量与校验可以各自漂移）。'),
  );

  // ③ 负向：`favorites/**` 全部文件里**没有任何** `'post'` / `'comment'` 字面量。
  //    用「带引号的字面量」而不是裸词 `post`：注释里提一句「帖子不可收藏」不该让钉子红。
  const favoritesFiles = walkFiles('services/api/src/favorites');
  assert.equal(
    favoritesFiles.includes(FAVORITES_TYPES) && favoritesFiles.includes('services/api/src/favorites/validate.ts'),
    true,
    '扫描面没覆盖 favorites 的两个关键文件（types.ts / validate.ts）⇒ 下面的负向断言不可信。',
  );
  /** @type {string[]} */
  const communityLiterals = [];
  for (const file of favoritesFiles) {
    const text = readRepoText(file);
    for (const needle of ["'post'", '"post"', "'comment'", '"comment"']) {
      const hits = hitsOf(file, needle);
      for (const hit of hits) communityLiterals.push(`${file}:${hit.line}: ${hit.text}`);
      void text;
    }
  }
  assert.deepEqual(
    communityLiterals,
    [],
    '【钉 3 破了】`services/api/src/favorites/**` 里出现了 `\'post\'` / `\'comment\'` 字面量：'
      + `\n  实测：${JSON.stringify(communityLiterals)}`
      + '\n  基线：收藏面**完全不认识**社区目标（`targetref/visibility.ts` 也没有 post/comment 分支）。'
      + '\n  ⚠ 这条是语义负向：若你只是**有意**接上社区收藏 ⇒ 那是产品决策，按 ① 的提示整链条改；'
      + '若你只是要写一句注释，请别把字面量带引号写进去（会把这条钉成假红）。'
      + because('在收藏子域任何文件里写带引号的 `\'post\'` / `\'comment\'`（哪怕只是注释）。'),
  );
});

// ---------------------------------------------------------------------------
// 钉 4 · 后台人审占位页仍是「结构性零」
// ---------------------------------------------------------------------------

const REVIEW_PLACEHOLDER = 'apps/admin/src/views/ReviewPlaceholderView.vue';

/**
 * 「真网络调用」的形态表。
 *
 * ⚠ **为什么不用关键词 `api.`**：这一页正文里三次提到 `packages/contracts/openapi.json`，
 * 裸测 `api.` 会立刻假红。所以判据写成**调用形态**（括号、方法名、模块 import），
 * 而不是关键词 —— 放宽成关键词等于把钉子变成橡皮图章。
 */
const NETWORK_CALL_PATTERNS = [
  { label: 'fetch(...)', re: /\bfetch\s*\(/ },
  { label: 'axios', re: /\baxios\b/ },
  { label: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
  { label: 'EventSource', re: /\bEventSource\b/ },
  { label: 'WebSocket', re: /\bWebSocket\b/ },
  { label: '$fetch', re: /\$fetch\b/ },
  { label: '<x>Api.<method>', re: /\b[A-Za-z_$][\w$]*[Aa]pi\s*\.\s*(?:get|post|put|patch|delete|request)\b/ },
  { label: 'api.<method>', re: /\b(?:api|http|client|request)\s*\.\s*(?:get|post|put|patch|delete|request)\b/ },
  { label: 'import 网络模块', re: /\bimport\s[^\n]*from\s+['"][^'"]*(?:\/api\b|api\.|client|http)[^'"]*['"]/ },
];

test('钉 4 · `ReviewPlaceholderView.vue` 仍是结构性的「零」（不发起任何网络请求）', () => {
  const source = readRepoText(REVIEW_PLACEHOLDER);

  // ① 前提：这一页**仍然是那个占位页**（数据只来自 `review-state.mjs` 的冻结常量）。
  assert.equal(
    source.includes("from '../lib/review-state.mjs'"),
    true,
    `${REVIEW_PLACEHOLDER} 不再从 \`../lib/review-state.mjs\` 取数 ⇒ 这一页已经不是「结构性零」占位页，`
      + '请重新核定钉 4（它现在钉的到底是什么）。',
  );
  assert.equal(
    source.includes('openapi.json'),
    true,
    '前提变了：文件里已经没有 `openapi.json` 那句自陈 —— 本钉子用「调用形态」而非 `api.` 关键词的原因'
      + '正来自这条前提（裸测 `api.` 会假红）。若那句自陈被删，请先确认这一页现在怎么解释它的「0」。',
  );

  // ② 零网络调用（逐行扫，命中就带上行号，方便直接定位）。
  /** @type {string[]} */
  const callHits = [];
  linesOf(REVIEW_PLACEHOLDER).forEach((line, i) => {
    for (const { label, re } of NETWORK_CALL_PATTERNS) {
      if (re.test(line)) callHits.push(`:${i + 1} [${label}] ${line.trim()}`);
    }
  });
  assert.deepEqual(
    callHits,
    [],
    '【钉 4 破了】**这是预期内会红的一条** —— 占位页开始发网络请求了：'
      + `\n  实测命中：${JSON.stringify(callHits)}`
      + '\n  基线：`apps/admin/src/views/ReviewPlaceholderView.vue` **一个请求都不发** —— '
      + '契约里没有审核队列读面（`packages/contracts/openapi.json` 里 path 含 `review` 的数量为 0），'
      + '`services/api/src/routes/` 也没有 review 路由，所以这一页选择「不伪造队列、不伪造待审计数」。'
      + '\n  👉 若你正在实现人审后台：**先**给契约加读面（`GET /admin/posts?audit_state=pending` 之类）'
      + '**并**接上服务层队列，**然后**把本钉子改成「读真实队列」的断言 —— '
      + '同时翻转 `apps/admin/src/lib/review-state.mjs` 的 `REVIEW_COUNT` 与 `tests/unit/admin-ui-review-state.test.mjs`。'
      + '\n  ⛔ 不要为了让本文件变绿而收窄 `NETWORK_CALL_PATTERNS`：那会让「后台偷偷开始拉数据」从此测不出来。'
      + because('这一页（或它新引入的 lib）出现任何真调用：`fetch(`、`axios`、`xApi.get(...)`、'
        + '`import ... from \'../lib/xxx-api.mjs\'` 等。'),
  );

  // ③ 自陈在位：这条让「结构性零」的**理由**也受钉（否则 ② 绿着、页面却可能换个说法吹牛）。
  assert.equal(
    source.includes('不发起任何网络请求'),
    true,
    `${REVIEW_PLACEHOLDER} 里那句「不发起任何网络请求」的自陈没了：`
      + '\n  基线（:5-6 与 :92-96）：两处都明写本页不发起网络请求，并把理由指到契约与路由。'
      + because('删掉/改写这段自陈（那通常意味着这一页的定位变了，不只是文案）。'),
  );
});

// ---------------------------------------------------------------------------
// 钉 5 · 小程序三处「待审／未公开」文案（且没有「已驳回」态）
// ---------------------------------------------------------------------------

/** 三处文案锚点：文件 / 行号 / 该行必须包含的字面量（全角斜杠 U+FF0F，逐字）。 */
const MINIPROGRAM_COPY_PINS = [
  {
    file: 'miniprogram/pages/community/community.js',
    line: 192,
    mustInclude: "'待审／未公开'",
    note: '列表页作者侧 stateLabel 的兜底分支',
  },
  {
    file: 'miniprogram/pages/communitydetail/communitydetail.js',
    line: 176,
    mustInclude: "'待审／未公开'",
    note: '详情页作者侧 stateLabel 的兜底分支',
  },
  {
    file: 'miniprogram/pages/communitycreate/communitycreate.js',
    line: 106,
    mustInclude: "'待审／未公开'",
    note: '发帖成功后的 toast 文案（按服务端返回的 visibility/audit_state 取）',
  },
];

/** 详情页另有一处**语序不同**的公开侧标签（`未公开／待审`），单独钉。 */
const DETAIL_PUBLIC_LABEL = {
  file: 'miniprogram/pages/communitydetail/communitydetail.js',
  line: 173,
  mustInclude: "'未公开／待审'",
};

test('钉 5 · 小程序三页仍写着「待审／未公开」，且都没有「已驳回」态', () => {
  for (const pin of MINIPROGRAM_COPY_PINS) {
    const lines = linesOf(pin.file);
    assert.equal(
      pin.line <= lines.length,
      true,
      `${pin.file} 只剩 ${lines.length} 行（锚点 :${pin.line} 越界）⇒ 页面被大改，请重新定位。`,
    );
    assert.equal(
      lines[pin.line - 1].includes(pin.mustInclude),
      true,
      `【钉 5 破了】${pin.file}:${pin.line}（${pin.note}）不再包含 ${pin.mustInclude}：`
        + `\n  实测该行：${JSON.stringify(lines[pin.line - 1].trim())}`
        + '\n  基线的三页文案是**同一套**：通过 ⇒ 空串（列表/详情）或 `已通过先行审核`（详情公开侧/发帖 toast）；'
        + '下架 ⇒ `已下架（仅本人可见）`；其余（含 `audit_state === \'pending\'` 与 `\'rejected\'`）⇒ `待审／未公开`。'
        + '\n  ⚠ 文案改动可能是**有意**的（例如给「已驳回」独立态）—— 那就是本切片点名的 S5 切片，'
        + '请把三页 + 本钉子 + 证据页一起改。'
        + because('改写/删除这一行的 `\'待审／未公开\'` 字面量，或把状态判定挪到别的行（行号漂移同样红）。'),
    );
  }

  // 详情页公开侧：语序是 `未公开／待审`（不是 `待审／未公开`），别被上面的三处掩盖掉。
  const detailLines = linesOf(DETAIL_PUBLIC_LABEL.file);
  assert.equal(
    detailLines[DETAIL_PUBLIC_LABEL.line - 1].includes(DETAIL_PUBLIC_LABEL.mustInclude)
      && detailLines[DETAIL_PUBLIC_LABEL.line - 1].includes("'已通过先行审核'"),
    true,
    `【钉 5 破了】${DETAIL_PUBLIC_LABEL.file}:${DETAIL_PUBLIC_LABEL.line} 的公开侧标签变了：`
      + `\n  实测该行：${JSON.stringify(detailLines[DETAIL_PUBLIC_LABEL.line - 1].trim())}`
      + `\n  基线：三元组 \`… ? '已通过先行审核' : '未公开／待审'\`（**注意语序与作者侧相反**）。`
      + because('改这一行的两个字面量之一（这一行是「他人视角」的标签，与作者侧不是同一套措辞）。'),
  );

  // 负向：「已驳回」态**不存在**。audit_state 四值里 `rejected` 没有自己的 UI 分支，
  // 只会落进「待审／未公开」的兜底 —— 这正是本切片要钉住的现状（S5 才补它）。
  const pageFiles = [
    ...MINIPROGRAM_COPY_PINS.map((pin) => pin.file),
    DETAIL_PUBLIC_LABEL.file,
  ];
  const uniquePages = [...new Set(pageFiles)];
  /** @type {string[]} */
  const rejectedCopyHits = [];
  for (const file of uniquePages) {
    for (const hit of hitsOf(file, '已驳回')) rejectedCopyHits.push(`${file}:${hit.line}: ${hit.text}`);
    for (const hit of hitsOf(file, "'rejected'")) rejectedCopyHits.push(`${file}:${hit.line}: ${hit.text}`);
  }
  assert.deepEqual(
    rejectedCopyHits,
    [],
    '【钉 5 破了】小程序出现了「已驳回」态（文案或 `audit_state === \'rejected\'` 判定）：'
      + `\n  实测：${JSON.stringify(rejectedCopyHits)}`
      + '\n  基线（' + BASELINE_SHA.slice(0, 8) + '）：**三页都没有「已驳回」态** —— '
      + '`audit_state` 虽是四值枚举（`pending/approved/rejected/quarantined`），但小程序只区分'
      + '「通过 / 下架 / 其余」，被驳回的内容对作者也只显示「待审／未公开」，不会告诉他被驳回了。'
      + '\n  👉 若你刚补上这个态：那是**新产品语义**（作者可见的驳回告知），'
      + '请同时确认后端有没有把结论告诉作者（基线：驳回时内容行根本不落库、也不发通知），'
      + '并把本钉子改成「有已驳回态」的正向断言。'
      + because('在这三页里写出 `已驳回` 文案，或加上 `audit_state === \'rejected\'` 的分支。'),
  );
});

// ---------------------------------------------------------------------------
// 钉 6 · 服务层兜底门 `gateCommunityService` 仍未装配
// ---------------------------------------------------------------------------

const FLAG_GATE = 'services/api/src/admin/ops/flag-gate.ts';

test('钉 6 · `gateCommunityService` 未装配：除定义文件外零引用，`app.ts` 零出现', () => {
  const srcFiles = walkFiles('services/api/src');

  // 前提：扫描面必须覆盖装配点与定义点（否则「零引用」可能只是没扫到）。
  assert.equal(
    srcFiles.includes('services/api/src/app.ts'),
    true,
    '扫描面没覆盖 `services/api/src/app.ts`（唯一装配点）⇒ 本钉子的「未装配」不可信。',
  );
  assert.equal(
    srcFiles.includes(FLAG_GATE),
    true,
    `扫描面没覆盖定义文件 ${FLAG_GATE} ⇒ 下一条「只有它自己」可能是空转。`,
  );

  // ① `services/api/src` 内：引用它的文件集合**恰好**是定义文件自己。
  const referencing = srcFiles.filter((file) => readRepoText(file).includes('gateCommunityService'));
  assert.deepEqual(
    referencing,
    [FLAG_GATE],
    '【钉 6 破了】服务层兜底门 `gateCommunityService` 在 `services/api/src` 里**被引用了**，不再只有它自己：'
      + `\n  实测：${JSON.stringify(referencing)}`
      + `\n  基线（${BASELINE_SHA.slice(0, 8)}）：只有 ${FLAG_GATE} 自身（:31 注释、:672 定义、:690 注释）。`
      + '\n  ⇒ 若你刚把它接进装配（把 `communityService` 包一层投稿面副本）：'
      + '请翻转本钉子，并把 `flag-gate.ts:669-670` 那段「应用装配当前未调用它」的自陈改成新事实。'
      + because('在 `services/api/src` 任何**非** flag-gate.ts 的文件里出现该符号（import / 调用 / 再导出）。'),
  );

  // ② `app.ts` 单独钉：它是本仓唯一装配点，缺口的判据就在这里。
  assert.equal(
    occurrences(readRepoText('services/api/src/app.ts'), 'gateCommunityService'),
    0,
    '【钉 6 破了】`services/api/src/app.ts` 里出现了 `gateCommunityService` —— 装配发生了：'
      + '\n  基线：app.ts 里只有 `registerCommunityRoutes(...)`（:2361）与 `createCommunityService(...)`（:1257），'
      + '**没有**任何装饰器包裹；投稿面只有**路由级**门（`routes/community.ts` 的 `postingPreHandlers`）。'
      + because('在 app.ts 里 import 或调用该装饰器（哪怕只是 import 也算接线开始）。'),
  );

  // ③ 装饰器本体不是空壳：它必须仍然返回**冻结的副本**，否则「未装配」会退化成「装了也没用」。
  //    ⚠ 必须**限定在它自己的函数体内**再数：`flag-gate.ts` 里有第二个同形状的装饰器
  //    （:697 起，另一个服务面），全文件数会得到 2 —— 那是假红，不是发现。
  const gateLines = linesOf(FLAG_GATE);
  const gateDefAt = gateLines.findIndex((line) => line.startsWith('export function gateCommunityService<'));
  const gateNextExportAt = gateLines.findIndex(
    (line, i) => i > gateDefAt && /^export (?:function|const|type|interface|class) /.test(line),
  );
  assert.equal(
    gateDefAt > -1 && gateNextExportAt > gateDefAt,
    true,
    `${FLAG_GATE} 里切不出 \`gateCommunityService\` 的函数体`
      + `（定义@${gateDefAt + 1}、下一个 export@${gateNextExportAt + 1}）⇒ 判据位置失效。`,
  );
  const gateBody = gateLines.slice(gateDefAt, gateNextExportAt).join('\n');
  assert.equal(
    occurrences(gateBody, 'return Object.freeze(wrapped) as T;'),
    1,
    '【钉 6 · 恶化】`gateCommunityService` 的本体不再是「返回冻结副本」：'
      + `\n  实测（限定在它自己的函数体内）：${occurrences(gateBody, 'return Object.freeze(wrapped) as T;')} 次`
      + '\n  基线（:684）：`return Object.freeze(wrapped) as T;`（`Object.freeze` 是它「不能被顺手改回去」的保证）。'
      + because('把装饰器掏空（直接 `return service`）—— 那会让「未装配」变成「装配了也不生效」，'
        + '是比缺口更糟的状态。'),
  );

  // ④ 测试侧调用点照样登记（不改「未装配」的结论，但让「零调用」这句话保持准确）。
  //    ⚠ 排掉 `SELF_FILE`：本文件逐字写了这个符号，不排会自己数自己。
  const testReferencing = walkFiles('tests')
    .filter((file) => file !== SELF_FILE)
    .filter((file) => readRepoText(file).includes('gateCommunityService'));
  assert.deepEqual(
    testReferencing,
    ['tests/unit/admin-flag-gate.test.mjs'],
    '【钉 6 · 登记失真】`tests/` 下引用 `gateCommunityService` 的文件集合变了：'
      + `\n  实测：${JSON.stringify(testReferencing)}`
      + '\n  基线：只有 `tests/unit/admin-flag-gate.test.mjs`（import + 两处调用，测装饰器**自身**语义）。'
      + '\n  ⚠ 这些调用**不构成装配**，本钉子的结论不变；但若你新增了测试文件，请同步这一行，'
      + '否则「除定义文件外无调用点」这句话就不再准确。'
      + because('在 `tests/` 下新增/删除引用该符号的文件（本文件自己已排除）。'),
  );

  // ⑤ 白名单式断言的**盲区自陈**（不判红，只是把风险写在判据旁边）：
  //    a. 只扫 `services/api/src` —— 从 `tools/`、`scripts/`、`apps/`、`deploy/` 侧装配会漏；
  //    b. 只把 `app.ts` 当唯一装配点 —— 新建 bootstrap 模块会漏；
  //    c. 符号改名即假红（`gateCommunityService` → `withSubmissionGate`）；
  //    d. 拼字符串动态取用（`gate['gateCommunity' + 'Service']`）绕过文本扫描。
  //    因此本钉子证明的是「**这个符号**在**这个目录**里没有被引用」，不是「投稿面无兜底门」。
  assert.equal(
    readRepoText(FLAG_GATE).includes('export function gateCommunityService<T extends object>'),
    true,
    '【钉 6 · 判据位置变了】定义行不再是 `export function gateCommunityService<T extends object>(`：'
      + '\n  基线（:672）：`export function gateCommunityService<T extends object>(service: T, gate: FeatureFlagGate): T {`'
      + '\n  ⚠ 若只是改了签名（多一个参数 / 改成 class），本钉子其余判据仍成立，改这一行即可；'
      + '\n  若是**改名**，那不是漂移而是「符号没了」—— 请重新核定整条钉 6（含 ①②③④ 的扫描字面量）。'
      + because('改写定义行（改签名算漂移；改名等于判据符号消失）。'),
  );
});
