/**
 * S4 · 数据面「缺口 / 已接线」两态的结构钉子（六条）。
 *
 * ## 这个文件是什么
 *
 * 它不验证「功能对不对」（那要真库、真调度、真凭据），它验证**接线状态没有悄悄变**：
 * 把「哪两处还是缺口、哪四处已经接上」写成**可机读的结构事实**，于是
 *   · 谁**悄悄补上**仍是缺口的那两处（装配适配器 / 调媒体删除函数）⇒ 本文件红；
 *   · 谁**悄悄回退**已经接上的那四处（删端口文件 / 删一个 timer / 从必需清单拿掉命令 / 从 CI 摘掉校验）⇒ 本文件同样红。
 *
 * 红的时候**不是**「你写错了」，而是：**接线状态变了，请把这个钉子一起翻转**（见每条断言里的
 * 「👉 接线状态变了」）。这是刻意的 ——— 缺口与接线都是**登记过的事实**，不能靠一次顺手改动让登记失效。
 *
 * ## 基线
 *
 * 本文件曾以 **`81d8e0b9943d7bd3b3d284a965e37caf92234883`** 为基线；正文与期望值已按**翻转后的现状**更新
 * （钉 3/4/5 于 2026-10-26 由「缺口」改为「已接线」；钉 1 于同日随 S4-S3 P2-a 的端口落地由「缺口」改为
 * 「已接线」——端口在库层之外，**尚未装配**，那条结论仍由钉 2 守着），每条常数都由实测读数逐条核对过，不是抄文档。
 *
 * ## 六条钉子（判据位置 / 断言什么 / 什么改动会让它红）
 *
 * | # | 判据位置 | 断言什么 | 什么改动会让它红 |
 * | - | --- | --- | --- |
 * | 1 | `services/api/src`、`packages`、`tools` 三处扫字面量 `third_party_deletions` | 命中**恰好两个文件 / 六行**：`services/api/src/privacy/third-party-deletion-pg.ts:8/:14/:59/:79/:142`（S4-S3 P2-a 的真库端口，只经 0044 的两条 `SECURITY DEFINER` 函数进出，⛔ 文件里没有表级 DML）+ `packages/privacy/retention-policy.mjs:208`（策略表自陈，`table:` 字段，不是查询） | 出现**第四处**读写接缝（新 SQL 文本 / `pool.query` / 仓储）；端口文件里出现直写/直读该表的 SQL；或自陈行被挪/改文本 |
 * | 2 | `services/api/src` 扫 `createThirdPartyDeletionAdapter`；单独断 `app.ts` | 除 `privacy/third-party-deletion-adapter.ts` 自身外**零引用**；`app.ts` 里**零出现** ⇒ 未装配 | 任何装配（`app.ts` import/调用、新工厂、路由注入）；或适配器被移到别处 |
 * | 3 | `deploy/purge-schedule/` 的 `*.service` / `*.timer` 全集 | 全集**恰好六条**（online-data、backup-copies、retention 各一 service + 一 timer），retention 那对**在位** | 删掉现存任何一条（尤其 `gengyun-purge-retention.{service,timer}`）；或新出现 `media-*` 等第四族单元 |
 * | 4 | `tools/verify-purge-schedule.mjs` 的 `REQUIRED_NPM_SCRIPTS` | 唯一定义点 + 数组**恰好三条必需脚本** `['purge:online-data','purge:backup-copies','purge:retention']`，retention **在** | 从数组里拿掉 `purge:retention`；或把该常量挪到别处/复制一份 |
 * | 5 | `.github/workflows/**` 扫 `verify:purge-schedule` / `tools/verify-purge-schedule`、`restore-drill` | 调度门禁**恰一份引用**（= `engineering-shell.yml` 的 `retention-gates`）；`restore-drill` 仍**零命中** | 引用面扩大或消失（多接一份 / 整条摘掉）；或任何 workflow 引用 `deploy/postgres-cvm/restore-drill.*` |
 * | 6 | `services/api/src`、`packages` 扫 `purge_owner_media` | **零命中** ⇒ 媒体行物理删除的唯一入口（0035 的 `SECURITY DEFINER` 函数）至今没人调 | 任何应用侧写 `SELECT public.purge_owner_media($1)`；或迁移 0035 的函数定义消失（后者是恶化，同样要红） |
 *
 * ## 硬约束（改本文件时不许破）
 *
 * - **只读**：不建临时目录、不写仓内任何文件、不起子进程、不连库。
 * - **零外部依赖**：只 `node:fs` / `node:path` / `node:url` + `node:test` / `node:assert`，
 *   不 import 被测模块（**故意**：import 会让「文件还在、内容被换掉」这类漂移测不出来）。
 * - **断言只用严格相等**（`assert.equal` / `assert.deepEqual`）：⛔ 不用 `assert.ok(x.length >= 1)`、
 *   ⛔ 不用 `assert.match` 兜模糊匹配 —— 缺口钉子一旦放宽判据就退化成橡皮图章。
 * - 用例数固定 6；⛔ 无 `skip` / `only` / `todo`。
 *
 * 单跑：`node --test tests/unit/s4-data-gap-pins.test.mjs`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：由本文件位置推出（`tests/unit/` 的上两级），⛔ 不用 `process.cwd()`。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 立文件时的基线 SHA（留档追溯）：仍处缺口态的钉 2/6、以及已翻转为「已接线 1」的钉 1 的失败提示里
 * 写的「基线（81d8e0b9）」，指的都是它。
 * 钉 1/3/4/5 的期望值已于 2026-10-26 按翻转后的现状更新，不再取自这个 SHA。
 */
const BASELINE_SHA = '81d8e0b9943d7bd3b3d284a965e37caf92234883';

/**
 * 本文件自己的仓库相对路径。
 *
 * ⚠ 自指陷阱（实测踩过）：本文件在**失败提示里**逐字写了 `export const REQUIRED_NPM_SCRIPTS`，
 * 于是「全仓扫这个声明」会把钉子文件自己数进去 —— 钉 4 因此假红。凡扫到 `tests/` 的判据
 * 都必须把本文件排掉；排掉的只是**自己**，不是判据面。
 */
const SELF_FILE = 'tests/unit/s4-data-gap-pins.test.mjs';

/** 每条钉子红的时候都要说的同一句话：接线状态变了，请**翻转钉子**，不是把判据改松。 */
const FLIP_HINT = '\n\n👉 接线状态变了（缺口**补上**、或已接线被**回退**，都算）：请把本钉子的期望值与标题'
  + '改成新事实（「缺口 N」↔「已接线 N」），并同步它点名的文档/证据页。'
  + `\n⛔ 不要为了让本文件变绿而放宽判据（换成 \`includes\` / \`>=\` / 模糊正则都算），`
  + `也不要删掉这一条 —— 本文件的全部价值就是「接线一动就红」。`;

/**
 * 遍历时跳过的目录名：VCS、依赖、构建产物、本机证据目录。
 * 判据面是**源码树**；这些目录里的东西既不是接口也不是装配。
 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.pg17']);

/** Windows 分隔符归一化成 `/`，让「仓库相对路径」在所有平台上都是同一个字符串。 */
const toPosix = (p) => p.split(sep).join('/');

/**
 * 读一个**仓库相对路径**的 UTF-8 文本。
 *
 * @param {string} relPosix 例：`packages/privacy/retention-policy.mjs`
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
 * 在若干扫描根里按**字面量**找命中，返回 `{ files, hits }`。
 *
 * `hits` 每条带仓库相对文件、**1 起的行号**、以及该行 `trim()` 后的文本 ——
 * 行号用 `split('\n')` 数，和 `git grep -n` / ripgrep 的口径一致（本仓全为 LF）。
 *
 * @param {string[]} roots 仓库相对目录
 * @param {string} needle 字面量（⛔ 不用正则：字面量才不会被元字符悄悄放宽）
 * @returns {{ files: string[], hits: Array<{ file: string, line: number, text: string }> }}
 */
function scanTree(roots, needle) {
  const files = roots.flatMap((root) => walkFiles(root));
  assert.equal(
    new Set(files).size,
    files.length,
    `内部前提：扫描根互相重叠（${roots.join(' / ')}）⇒ 命中会被数两遍。请先修扫描根。`,
  );
  /** @type {Array<{ file: string, line: number, text: string }>} */
  const hits = [];
  for (const file of files) {
    const lines = readRepoText(file).split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes(needle)) hits.push({ file, line: i + 1, text: lines[i].trim() });
    }
  }
  return { files, hits };
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
 * 按**首次出现**去重的文件列表（顺序 = `scanTree` 的命中顺序，即「按根序、根内按路径排序」）。
 *
 * ⚠ 这里**只**给「文件集」那一条断言去重。行号信息**没有**被抹掉 —— 紧随其后的
 * `deepEqual(hits.map((h) => `${h.file}:${h.line}`), …)` 把每条命中的 `文件:行` 逐条钉死；
 * 两条断言各管一层（「哪些文件」与「哪几行」），删掉任何一条都会削弱判据。
 *
 * @param {Array<{ file: string, line: number, text: string }>} hits
 * @returns {string[]}
 */
function dedupeByFirstSeen(hits) {
  /** @type {string[]} */
  const seen = [];
  for (const hit of hits) if (!seen.includes(hit.file)) seen.push(hit.file);
  return seen;
}

// ---------------------------------------------------------------------------
// 已接线 1 · 第三方删除：应用侧由真库端口接线（端口层，未装配进 app.ts）
// ---------------------------------------------------------------------------

test('已接线 1 · public.third_party_deletions 应用侧恰一处接线（端口层，只经函数）+ 保留策略自陈一处', () => {
  const ROOTS = ['services/api/src', 'packages', 'tools'];
  const PORT = 'services/api/src/privacy/third-party-deletion-pg.ts';
  const POLICY = 'packages/privacy/retention-policy.mjs';
  const { files, hits } = scanTree(ROOTS, 'third_party_deletions');

  // 扫描面前提：三个根都走到了该走的文件（否则下面的 deepEqual 可能只是「没扫到」）。
  assert.equal(
    files.includes('services/api/src/app.ts'),
    true,
    '扫描面没覆盖 services/api/src/app.ts ⇒ 本钉子的「零读写」不可信。',
  );
  assert.equal(
    files.includes('packages/privacy/retention-policy.mjs'),
    true,
    '扫描面没覆盖 packages/privacy/retention-policy.mjs ⇒ 白名单那条断言不可信。',
  );
  assert.equal(
    files.includes('tools/verify-purge-schedule.mjs'),
    true,
    '扫描面没覆盖 tools/verify-purge-schedule.mjs ⇒ 三个根里有一个没走全。',
  );

  // ① 文件集（**去重**：同一文件多行命中只算一次；顺序取首次出现 =「按根序、根内按路径排序」）：
  //    恰两个文件 = 端口 + 保留策略自陈。冒出第三个文件 ⇒ 又出现了新的读写接缝。
  assert.deepEqual(
    dedupeByFirstSeen(hits),
    [PORT, POLICY],
    '【已接线 1 破了】应用侧对 `third_party_deletions` 的**文件集**又变了：'
      + `\n  实测（去重后）：${JSON.stringify(dedupeByFirstSeen(hits))}`
      + `\n  实测（逐条）：${JSON.stringify(hits.map((h) => `${h.file}:${h.line}`))}`
      + `\n  基线（81d8e0b9）：只有保留策略里的一行**自陈**（\`${POLICY}:208\` 的 \`table:\` 字段）；`
      + `\n  2026-10-26 起（S4-S3 P2-a）多了端口 \`${PORT}\`：只调 0044 的两条 SECURITY DEFINER 函数，未装配进 app.ts。`
      + '\n  若这一处被**回退**（文件删了/改名/搬走）⇒ 请翻回「缺口 1」，把期望值改回只剩自陈那一条；'
      + '  若又冒出**第四处**读写接缝（新 SQL / 仓储 / 映射器）⇒ 先确认它该不该存在，再改本常数。'
      + '\n  两种翻转都要同步它点名的文档：docs/architecture/data-dictionary.md:91 与 '
      + 'docs/verification/gy-i29-closure-20261018.md:99-100。'
      + FLIP_HINT,
  );

  // ② 逐条「文件:行」：**不去重、不归并** —— 六条命中逐条钉死。
  //    行号本身就是判据：同一文件里多出一行仍是新接缝，而「文件集」那条看不出来。
  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.line}`),
    [
      `${PORT}:8`, `${PORT}:14`, `${PORT}:59`, `${PORT}:79`, `${PORT}:142`,
      `${POLICY}:208`,
    ],
    '【已接线 1 破了】`third_party_deletions` 的逐条命中（文件:行）与登记的不一致。'
      + `\n  实测：${JSON.stringify(hits.map((h) => `${h.file}:${h.line}: ${h.text}`))}`
      + '\n  登记：端口 5 行（:8 / :14 / :59 / :79 / :142）+ 保留策略自陈 1 行（:208）。'
      + '\n  ① 若只是端口文件里**上下挪动**（文本与语义都没变）⇒ 把常数改成新行号，语义未变；'
      + '\n  ② 若**多出/少掉**一条 ⇒ 那才是接线状态变了，按①的命令翻钉子。'
      + FLIP_HINT,
  );

  // ③ 保留策略那一行是「策略表自陈」，不是查询/写库 —— 这条把「白名单条目」和「真的接线」区分开。
  //    按 file 定位（⛔ 不靠 hits[0]：端口落地后第一处命中已经不是它了）。
  const policyHit = hits.find((h) => h.file === POLICY);
  assert.equal(
    policyHit?.text,
    "table: 'public.deletion_requests / public.deletion_handlers / public.third_party_deletions',",
    '【已接线 1 破了】白名单那一行的**内容**变了。'
      + `\n  实测：${JSON.stringify(policyHit?.text)}`
      + '\n  基线：`    table: \'public.deletion_requests / public.deletion_handlers / public.third_party_deletions\',`'
      + '\n  若只是策略表改口径 ⇒ 同步改本常数；若这行不再是 `table:` 自陈 ⇒ 白名单不再是「自陈」，重新核定。'
      + FLIP_HINT,
  );

  // ④ 保留策略那一行的行号：与 ①②③ 分开断言，好让「只是行号漂移」和「语义变了」红得不一样。
  assert.equal(
    policyHit?.line,
    208,
    `【已接线 1 · 行号漂移】保留策略的自陈行从 :208 挪到了 :${policyHit?.line}。`
      + '\n  若文本没变（上一条仍然绿）⇒ 这只是一次无关编辑把它推下去/拉上来了，把常数改成新行号即可，'
      + '**语义未变**。'
      + '\n  若文本也变了 ⇒ 那才是口径被动了，按上一条的提示处理。'
      + FLIP_HINT,
  );

  // ⑤ 接线只能**经函数**（0044 的裁定：运行时对该表零 DML、零 SELECT，唯一入口是两条
  //    SECURITY DEFINER 函数）。端口里一旦出现直写/直读该表的 SQL ⇒ 绕过授权面的接缝；
  //    这条比「文件集」更硬：它管的是「怎么进出」，不只是「谁进来了」。
  const portSource = readRepoText(PORT);
  for (const needle of [
    'INSERT INTO',
    'UPDATE public.third_party_deletions',
    'FROM public.third_party_deletions',
    'DELETE FROM',
  ]) {
    assert.equal(
      occurrences(portSource, needle),
      0,
      `【已接线 1 破了】端口 \`${PORT}\` 里出现了直写/直读该表的 SQL 片段：\`${needle}\`。`
        + '\n  0044 的裁定是「该表对运行时零表级、零列级权限，只能经两条 SECURITY DEFINER 函数进出」，'
        + '  端口里出现表级 DML ⇒ 不是接线问题，是权限面被绕过。'
        + FLIP_HINT,
    );
  }
});

// ---------------------------------------------------------------------------
// 缺口 2 · 第三方删除适配器：未装配
// ---------------------------------------------------------------------------

test('缺口 2 · createThirdPartyDeletionAdapter 未装配：除自身文件外零引用，app.ts 零出现', () => {
  const SELF = 'services/api/src/privacy/third-party-deletion-adapter.ts';
  const srcFiles = walkFiles('services/api/src');

  assert.equal(
    srcFiles.includes(SELF),
    true,
    `扫描面里没有适配器自身文件（${SELF}）⇒ 下一条「只有它自己」可能是空转。`,
  );
  assert.equal(
    srcFiles.includes('services/api/src/app.ts'),
    true,
    '扫描面里没有 services/api/src/app.ts ⇒ 装配面没被扫到，本钉子不可信。',
  );

  // ① services/api/src 内：除自身文件外零引用（import / 调用 / 再导出都算）。
  const referencing = srcFiles.filter((file) => readRepoText(file).includes('createThirdPartyDeletionAdapter'));
  assert.deepEqual(
    referencing,
    [SELF],
    '【缺口 2 破了】第三方删除适配器在 `services/api/src` 里**被引用了**，不再只有它自己：'
      + `\n  实测：${JSON.stringify(referencing)}`
      + `\n  基线（81d8e0b9）：只有 ${SELF} 自身（定义 + 文件头示例注释），app.ts 里零出现 ⇒ **未装配**。`
      + '\n  适配器文件头「接线方式」写着装配方要做的事（`const adapter = createThirdPartyDeletionAdapter({…})`），'
      + '  若你刚做了这件事 ⇒ 请翻转本钉子，并把适配器文件头「## 接线方式」一节（services/api/src/privacy/third-party-deletion-adapter.ts:22）同步成新事实。'
      + FLIP_HINT,
  );

  // ② app.ts 单独钉：它是本仓唯一的装配点，缺口的判据就在这里。
  const appSource = readRepoText('services/api/src/app.ts');
  assert.equal(
    occurrences(appSource, 'createThirdPartyDeletionAdapter'),
    0,
    '【缺口 2 破了】`services/api/src/app.ts` 里出现了 `createThirdPartyDeletionAdapter` —— 装配发生了。'
      + '\n  基线（81d8e0b9）：app.ts 2491 行里零出现（第三方删除只有**投影** '
      + '`privacy/third-party-deletion-projection.ts` 的只读消费，没有出站适配器）。'
      + '\n  ⇒ 请翻转本钉子，并把**适配器文件头**的「接线方式」一节（'
      + 'services/api/src/privacy/third-party-deletion-adapter.ts:22）从'
      + '  「装配方按此（尚未接线）」改成新事实 —— 适配器接线目前没有别的登记处，'
      + '  `docs/**` 里对它零命中，⛔ 不要去改 gy-r34-retention-policy.md:121（那讲的是**调度**接线）。'
      + FLIP_HINT,
  );

  // ③ 如实登记：唯一的调用点在**单测**里（正臂/负控制），那是测适配器本身，不是装配。
  //    这条不改「未装配」的结论，但让「零调用」这句话保持准确 —— 免得后来人以为全仓 0 次。
  const testReferencing = walkFiles('tests/privacy').filter((file) =>
    readRepoText(file).includes('createThirdPartyDeletionAdapter'),
  );
  assert.deepEqual(
    testReferencing,
    ['tests/privacy/third-party-deletion-adapter.test.mjs'],
    '【缺口 2 · 登记失真】`tests/privacy/` 下引用适配器的文件集合变了：'
      + `\n  实测：${JSON.stringify(testReferencing)}`
      + '\n  基线：只有 `tests/privacy/third-party-deletion-adapter.test.mjs`（8 处调用，测适配器自身语义）。'
      + '\n  ⚠ 这些调用**不构成装配**，本钉子的「未装配」结论不变；但若你新增了测试文件，请同步这一行，'
      + '否则「除自身文件外无调用点」这句话就不再准确。'
      + FLIP_HINT,
  );
});

// ---------------------------------------------------------------------------
// 已接线 3 · 保留策略：有 retention 调度单元（#604 / `34d40de1`）
// ---------------------------------------------------------------------------

test('已接线 3 · deploy/purge-schedule/ 含 retention 调度单元（2026-10-26 #604 落地；原缺口 3 已补）', () => {
  const DIR = 'deploy/purge-schedule';
  assert.equal(
    existsSync(join(REPO_ROOT, ...`${DIR}/README.md`.split('/'))),
    true,
    `判据位置不存在：${DIR}/README.md ⇒ 调度目录搬家了，本钉子要重新核定。`,
  );

  const entries = readdirSync(join(REPO_ROOT, ...DIR.split('/')), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const units = entries.filter((name) => name.endsWith('.service') || name.endsWith('.timer'));

  // ① 全集恰好六条：这条同时挡住「新增」与「删掉」（两侧都是状态改动）。
  assert.deepEqual(
    units,
    [
      'gengyun-purge-backup-copies.service',
      'gengyun-purge-backup-copies.timer',
      'gengyun-purge-online-data.service',
      'gengyun-purge-online-data.timer',
      'gengyun-purge-retention.service',
      'gengyun-purge-retention.timer',
    ],
    '【已接线 3 破了】`deploy/purge-schedule/` 的调度单元全集又变了：'
      + `\n  实测：${JSON.stringify(units)}`
      + '\n  当前事实（#604 落地后）：online-data/backup-copies/retention 各一对 service+timer，共六条；'
      + 'retention 单元以 `OnCalendar=*-*-* 03:20:00` 日级触发 `purge:retention`。'
      + '\n  若你**又**加了/删了单元 ⇒ 同步本钉子的期望值与标题；若只是改名 ⇒ 同样要同步。'
      + FLIP_HINT,
  );

  // ② retention 单元必须在位：红的时候点得比 ① 更准。
  assert.deepEqual(
    units.filter((name) => /retention/i.test(name)),
    ['gengyun-purge-retention.service', 'gengyun-purge-retention.timer'],
    '【已接线 3 破了】retention 调度单元消失了（回退成缺口状态）：'
      + `\n  实测：${JSON.stringify(units.filter((name) => /retention/i.test(name)))}`
      + '\n  期望：`gengyun-purge-retention.service` + `gengyun-purge-retention.timer`（#604 落地）。'
      + '\n  删掉它们等于把保留策略退回「只能手工执行」——那要同时改回本钉子与它点名的文档。'
      + '\n  ⚠ `[calendar]` 判据的日级例外已按入口文件分档解决：`tools/verify-purge-schedule.mjs:152-156`'
      + '（`INTERVAL_BUDGET_MINUTES`：retention ⇒ 1440 分钟，其余仍 60 分钟），口径与接线事实记在 '
      + 'docs/architecture/gy-r34-retention-policy.md:173。'
      + FLIP_HINT,
  );

  // ③ 派发单里的对照项经核对**不成立**，如实钉住：media 也没有自己的调度单元。
  //    （媒体行的物理删除走 0035 的函数面，不是日历任务 —— 见缺口 6。）
  assert.deepEqual(
    units.filter((name) => /media/i.test(name)),
    [],
    '【已接线 3 · 事实更正】出现了 media 调度单元：'
      + `\n  实测：${JSON.stringify(units.filter((name) => /media/i.test(name)))}`
      + '\n  基线（81d8e0b9）：`deploy/purge-schedule/` 里**没有** `media-*` 单元（这条与派发时的假设不符，'
      + '已按实测登记）。若你新增了它 ⇒ 同步这一行；若只是改名 ⇒ 也同步这一行。'
      + FLIP_HINT,
  );

  // ④ 两条单元的 `GY-SCHEDULE: npm-script=` 自陈：跨文件核对「计划里挂的是哪两条命令」。
  const services = units.filter((name) => name.endsWith('.service'));
  const declared = services.map((name) => {
    const marker = /^# GY-SCHEDULE: npm-script=(\S+)$/m.exec(readRepoText(`${DIR}/${name}`));
    return { name, script: marker === null ? null : marker[1] };
  });
  assert.deepEqual(
    declared.map((item) => item.script),
    ['purge:backup-copies', 'purge:online-data', 'purge:retention'],
    '【已接线 3 · 自陈变了】`GY-SCHEDULE: npm-script=` 指向的命令集合变了：'
      + `\n  实测：${JSON.stringify(declared)}`
      + '\n  当前事实（#604 落地后）：backup-copies ⇒ `purge:backup-copies`；'
      + 'online-data ⇒ `purge:online-data`；retention ⇒ `purge:retention`。'
      + '\n  （缺标记会得到 `null`，同样让这条红 —— 那是判据标记被删，不是缺口的进展。）'
      + FLIP_HINT,
  );
});

// ---------------------------------------------------------------------------
// 已接线 4 · purge:retention 在必需脚本清单（#604 / `34d40de1`）
// ---------------------------------------------------------------------------

test('已接线 4 · REQUIRED_NPM_SCRIPTS 含 purge:retention（2026-10-26 #604 落地；原缺口 4 已补）', () => {
  const DECL = 'tools/verify-purge-schedule.mjs';

  // ① 唯一定义点：常量被挪走/复制一份都会红（否则「恰好三条」这句话可以对着空气说）。
  //    ⚠ 排掉 `SELF_FILE`：本文件在失败提示里逐字写了这个声明，不排会自己数自己（见 SELF_FILE 注释）。
  const defining = ['tools', 'packages', 'services/api/src', 'tests']
    .flatMap((root) => walkFiles(root))
    .filter((file) => file !== SELF_FILE)
    .filter((file) => /export\s+const\s+REQUIRED_NPM_SCRIPTS\b/.test(readRepoText(file)));
  assert.deepEqual(
    defining,
    [DECL],
    '【已接线 4 · 判据位置变了】`REQUIRED_NPM_SCRIPTS` 的定义点集合变了：'
      + `\n  实测：${JSON.stringify(defining)}`
      + `\n  现状：只在 ${DECL}:117 定义一次（其余地方都是 import）。`
      + '\n  若你把门禁搬家了 ⇒ 请把本钉子的 DECL 与新位置对齐，并确认「三条必需脚本（含 purge:retention）仍在新位置被冻结」。'
      + FLIP_HINT,
  );

  // ② 形状：抓不到声明就是判据位置失效（而不是清单内容变了）。
  const declaration = /export const REQUIRED_NPM_SCRIPTS = Object\.freeze\(\[([^\]]*)\]\)/.exec(readRepoText(DECL));
  assert.equal(
    declaration === null,
    false,
    `【已接线 4 · 形状变了】在 ${DECL} 里抓不到 \`export const REQUIRED_NPM_SCRIPTS = Object.freeze([…])\`。`
      + '\n  现状：`tools/verify-purge-schedule.mjs:117-121`，数组每条一行。'
      + '\n  若改成了多行/`new Set`/从别处汇总 ⇒ 请同步改本钉子的解析方式（⛔ 别直接删掉这条判据）。'
      + FLIP_HINT,
  );

  // ③ 清单内容恰好三条（顺序也钉住：它同时决定报告里 joined 文案的顺序）。
  const names = [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(
    names,
    ['purge:online-data', 'purge:backup-copies', 'purge:retention'],
    '【已接线 4 破了】`REQUIRED_NPM_SCRIPTS` 的内容又变了：'
      + `\n  实测：${JSON.stringify(names)}`
      + '\n  当前事实（#604 落地后）：`[\'purge:online-data\', \'purge:backup-copies\', \'purge:retention\']` —— '
      + '三条日历级命令全覆盖，且 retention 已有对应 `.service`（否则 `[coverage]` 会连带红）。'
      + '\n  若你删掉 `purge:retention` ⇒ 那是把缺口放回来，必须同时改回本钉子与文档。'
      + FLIP_HINT,
  );

  // ④ 单独一条 retention 判据（红的时候点得更准）。
  assert.equal(
    names.includes('purge:retention'),
    true,
    '【已接线 4 破了】`purge:retention` 从 `REQUIRED_NPM_SCRIPTS` 里消失了（回退成缺口状态）：'
      + `\n  实测：${JSON.stringify(names)}`
      + '\n  期望：**在**（#604 把 retention 日级调度接进必需覆盖清单）。'
      + '\n  ⇒ 删掉它等于让保留策略重新失去必需覆盖；要改就连同本钉子与 '
      + 'docs/architecture/gy-r34-retention-policy.md 一起改回。'
      + FLIP_HINT,
  );

  // ⑤ 缺口补上的是「进清单 + 有单元」那一层，**不是**「命令没写」——把这条钉住，免得被误诊成「缺脚本」。
  const pkg = JSON.parse(readRepoText('package.json'));
  assert.equal(
    pkg.scripts['purge:retention'],
    'node tools/purge-retention-expired.mjs',
    '【已接线 4 · 前提变了】`package.json` 的 `purge:retention` 不再是 '
      + '`node tools/purge-retention-expired.mjs`：'
      + `\n  实测：${JSON.stringify(pkg.scripts['purge:retention'])}`
      + '\n  现状：命令**在** `package.json` 里，且 `REQUIRED_NPM_SCRIPTS` 覆盖它、`gengyun-purge-retention.service` 驱动它。'
      + '\n  若命令改名/挪走 ⇒ 同步这一行，并重核「已接线 4」的结论。'
      + FLIP_HINT,
  );
});

// ---------------------------------------------------------------------------
// 已接线 5 · CI 引用调度校验恰一份（#607 / `0bc8bfaa`）；恢复演练仍未进 CI
// ---------------------------------------------------------------------------

test('已接线 5 · .github/workflows/ 里能 grep 到 verify:purge-schedule（2026-10-26 #607（`0bc8bfaa`）落地；原缺口 5 部分已补）', () => {
  const WF_DIR = '.github/workflows';
  const names = readdirSync(join(REPO_ROOT, ...WF_DIR.split('/')), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const files = names.map((name) => `${WF_DIR}/${name}`);

  // 扫描面前提：三个已知 workflow 必须在位（否则「恰一份引用」是空转）。
  for (const anchor of ['engineering-shell.yml', 'migrations-guard.yml', 'real-pg-integration.yml']) {
    assert.equal(
      names.includes(anchor),
      true,
      `扫描面里没有 ${WF_DIR}/${anchor} ⇒ workflow 目录搬家/改名了，本钉子的「恰一份引用」期望不可信。`,
    );
  }

  // ① 调度门禁已进 CI（恰一份引用）。
  //    两条**同义针脚**都扫：npm 脚本名（`run: npm run verify:purge-schedule`）与入口路径
  //    （`node tools/verify-purge-schedule.mjs`）。只扫前者会漏掉「绕过 npm script 直接调工具」——
  //    那同样是把这条校验接进了 CI、缺口同样被补上；本钉子判的是「校验有没有进 CI」，
  //    不是「这个 npm 名字有没有出现」。
  const SCHEDULE_NEEDLES = ['verify:purge-schedule', 'tools/verify-purge-schedule'];
  const scheduleCiHits = files.filter((file) =>
    SCHEDULE_NEEDLES.some((needle) => readRepoText(file).includes(needle)),
  );
  assert.deepEqual(
    scheduleCiHits,
    ['.github/workflows/engineering-shell.yml'],
    '【已接线 5 破了】CI 对调度门禁的引用面又变了：'
      + `\n  实测命中：${JSON.stringify(scheduleCiHits)}`
      + '\n  当前事实（#607 / `0bc8bfaa` 落地后）：仅 `engineering-shell.yml` 一处引用，形态是 `retention-gates` job 里的 '
      + '`- run: npm run verify:purge-schedule`（`:153`）；该步**没有** step 级超时，靠 job 级 '
      + '`timeout-minutes: 15`（`:143`）兜底 ⇒ 失败单列、能单独判读。'
      + '\n  若命中数变化 ⇒ CI 接线被动过：同步本钉子；若整条摘回本地 ⇒ 那是回退，必须同时改回文档。'
      + FLIP_HINT,
  );

  // ② 恢复演练没进 CI（脚本在 `deploy/postgres-cvm/restore-drill.{sh,ps1}`，但没人按点叫它）。
  assert.deepEqual(
    files.filter((file) => readRepoText(file).includes('restore-drill')),
    [],
    '【已接线 5 · 恢复演练仍是缺口】CI 引用了 `restore-drill`：'
      + `\n  实测命中：${JSON.stringify(files.filter((file) => readRepoText(file).includes('restore-drill')))}`
      + '\n  基线（81d8e0b9）：`.github/workflows/**` 零命中 ⇒ 恢复演练脚本'
      + '（`deploy/postgres-cvm/restore-drill.sh` / `.ps1`）在 CI 里从未被调用。'
      + '（`[calendar]` 之外，恢复清单保留期的义务正压在这条演练上。）'
      + '\n  若你刚把它接进 CI ⇒ 请翻转本钉子。'
      + FLIP_HINT,
  );
});

// ---------------------------------------------------------------------------
// 缺口 6 · 媒体本体删除：零调用
// ---------------------------------------------------------------------------

test('缺口 6 · purge_owner_media 在应用侧零调用（0035 定义了函数，但没人调它）', () => {
  const { files, hits } = scanTree(['services/api/src', 'packages'], 'purge_owner_media');

  assert.equal(
    files.includes('services/api/src/app.ts'),
    true,
    '扫描面没覆盖 services/api/src/app.ts ⇒ 本钉子的「零调用」不可信。',
  );
  assert.equal(
    files.includes('packages/privacy/retention-policy.mjs'),
    true,
    '扫描面没覆盖 packages/privacy/retention-policy.mjs ⇒ 扫描根走全了吗？',
  );

  // ① 零命中：应用侧（services/api/src + packages）没有任何调用点。
  assert.deepEqual(
    hits.map((hit) => `${hit.file}:${hit.line}`),
    [],
    '【缺口 6 破了】`purge_owner_media` 在应用侧出现了：'
      + `\n  实测命中：${JSON.stringify(hits.map((hit) => `${hit.file}:${hit.line}: ${hit.text}`))}`
      + '\n  基线（81d8e0b9）：`services/api/src` 与 `packages` **零调用** —— '
      + '媒体行的物理删除只有函数面（0035 的 `SECURITY DEFINER`），没有任何一段代码去 `SELECT` 它，'
      + '所以注销时媒体本体不会被真删（迁移 rollback 的注释自陈：「唯一的引用点将是应用侧 SQL 文本'
      + '（`SELECT public.purge_owner_media($1)`）——本片尚未接线」）。'
      + '\n  ⇒ 若你刚接上这条写路径，请翻转本钉子，并更新 '
      + 'docs/verification/gy-r34-i19-media-row-purge-20261024.md。'
      + FLIP_HINT,
  );

  // ② 对照：函数本体确实在迁移里（缺口是「定义了但没人调」，不是「函数不存在」）。
  //    这条也顺手把「删了迁移却让本文件变绿」这种**恶化**挡住。
  assert.equal(
    readRepoText('services/api/db/migrations/0035_r34_media_row_purge.sql').includes(
      'CREATE FUNCTION public.purge_owner_media(p_owner uuid) RETURNS jsonb',
    ),
    true,
    '【缺口 6 · 对照项变了】迁移 0035 里没有 '
      + '`CREATE FUNCTION public.purge_owner_media(p_owner uuid) RETURNS jsonb`：'
      + '\n  基线（81d8e0b9）：第 121 行就是这个定义。'
      + '\n  若 0035 被改/被删 ⇒ 那不是缺口进展，是**恶化**：函数没了，「零调用」就退化成「连入口都没有」。'
      + '\n  ⇒ 先查清 0035 的改名/迁移顺序，再改本钉子。'
      + FLIP_HINT,
  );
});
