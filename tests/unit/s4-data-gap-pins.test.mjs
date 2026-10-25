/**
 * S4 · 数据面**当前真实缺口**的结构钉子（六条）。
 *
 * ## 这个文件是什么
 *
 * 它不验证「功能对不对」（那要真库、真调度、真凭据），它验证**缺口现在仍然是缺口**：
 * 把「今天还没接线」这件事写成**可机读的结构事实**，于是
 *   · 谁**悄悄补上**（装配一行 / 加一个 timer / 把命令加进必需清单 / 在 CI 里引用校验）⇒ 本文件红；
 *   · 谁**悄悄恶化**（多一处绕过接缝的直写、适配器被别处偷偷 import、单元文件被删）⇒ 本文件同样红。
 *
 * 红的时候**不是**「你写错了」，而是：**缺口状态变了，请把这个钉子一起翻转**（见每条断言里的
 * 「👉 若你刚刚补上了」）。这是刻意的 ——— 缺口是**登记过的欠账**，不能靠一次顺手的接线让登记失效。
 *
 * ## 基线
 *
 * 全部常数都是 **`81d8e0b9943d7bd3b3d284a965e37caf92234883`（远端 main）的实测值**，
 * 由 6 条 `git grep` / `readdir` 读数逐条核对过（不是抄文档）。基线之后任何漂移都要人工过一遍。
 *
 * ## 六条钉子（判据位置 / 断言什么 / 什么改动会让它红）
 *
 * | # | 判据位置 | 断言什么 | 什么改动会让它红 |
 * | - | --- | --- | --- |
 * | 1 | `services/api/src`、`packages`、`tools` 三处扫字面量 `third_party_deletions` | 命中**恰好一处** = `packages/privacy/retention-policy.mjs:208`，且那行是策略表自陈（`table:` 字段），不是查询 | 任何一处真的读写该表的代码（SQL 文本、`pool.query`、仓储/端口/映射器）；或那行被挪/改文本 |
 * | 2 | `services/api/src` 扫 `createThirdPartyDeletionAdapter`；单独断 `app.ts` | 除 `privacy/third-party-deletion-adapter.ts` 自身外**零引用**；`app.ts` 里**零出现** ⇒ 未装配 | 任何装配（`app.ts` import/调用、新工厂、路由注入）；或适配器被移到别处 |
 * | 3 | `deploy/purge-schedule/` 的 `*.service` / `*.timer` 全集 | 全集**恰好四条**（online-data、backup-copies 各一 service + 一 timer），**没有**任何 `*retention*` 单元 | 新增任何一个单元（尤其 `gengyun-purge-retention.{service,timer}`）；或删掉现存单元 |
 * | 4 | `tools/verify-purge-schedule.mjs` 的 `REQUIRED_NPM_SCRIPTS` | 唯一定义点 + 数组**恰好** `['purge:online-data','purge:backup-copies']`，**不含** `purge:retention` | 把 `purge:retention` 加进数组；或把该常量挪到别处/复制一份 |
 * | 5 | `.github/workflows/**` 扫 `verify:purge-schedule`、`restore-drill` | 两条**零命中** ⇒ 调度门禁与恢复演练都还没进 CI | 任何 workflow 里出现 `npm run verify:purge-schedule` 或引用 `deploy/postgres-cvm/restore-drill.*` |
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

/** 常数基线（本文件所有期望值都取自这个 SHA 的实测读数）。 */
const BASELINE_SHA = '81d8e0b9943d7bd3b3d284a965e37caf92234883';

/**
 * 本文件自己的仓库相对路径。
 *
 * ⚠ 自指陷阱（实测踩过）：本文件在**失败提示里**逐字写了 `export const REQUIRED_NPM_SCRIPTS`，
 * 于是「全仓扫这个声明」会把钉子文件自己数进去 —— 缺口 4 因此假红。凡扫到 `tests/` 的判据
 * 都必须把本文件排掉；排掉的只是**自己**，不是判据面。
 */
const SELF_FILE = 'tests/unit/s4-data-gap-pins.test.mjs';

/** 每条钉子红的时候都要说的同一句话：缺口状态变了，请**翻转钉子**，不是把判据改松。 */
const FLIP_HINT = '\n\n👉 若你刚刚**补上**了这个缺口（这是好事，但也改变了已登记的欠账）：请把本钉子的期望值'
  + '改成新事实、把标题里的「缺口 N」改成「已接线」，并同步它点名的文档/证据页。'
  + `\n⛔ 不要为了让本文件变绿而放宽判据（换成 \`includes\` / \`>=\` / 模糊正则都算），`
  + `也不要删掉这一条 —— 本文件的全部价值就是「缺口一动就红」。基线 ${BASELINE_SHA}。`;

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

// ---------------------------------------------------------------------------
// 缺口 1 · 第三方删除：应用侧零读写
// ---------------------------------------------------------------------------

test('缺口 1 · public.third_party_deletions 在应用侧零读写，唯一命中是保留策略的自陈', () => {
  const ROOTS = ['services/api/src', 'packages', 'tools'];
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

  // ① 文件集：只有保留策略那一处（多一个文件 ⇒ 有人真的接上了读写）。
  assert.deepEqual(
    hits.map((h) => h.file),
    ['packages/privacy/retention-policy.mjs'],
    '【缺口 1 破了】应用侧出现了对 `third_party_deletions` 的**读写接缝**：'
      + `\n  实测命中：${JSON.stringify(hits.map((h) => `${h.file}:${h.line}`))}`
      + '\n  基线（81d8e0b9）只有保留策略里的一行**自陈**：'
      + '`packages/privacy/retention-policy.mjs:208`（`table:` 字段里点名该表「不并入日历策略」）。'
      + '\n  若你刚补的是一条合成读写路径（SQL / 仓储 / 端口 / 映射器）——这正是 #19 缺的那一段，'
      + '  请同时翻转本钉子、并更新 docs/architecture/data-dictionary.md:91 与 '
      + 'docs/verification/gy-i29-closure-20261018.md:99-100（后者的读数是「services/api/src 生产代码 0 行」）。'
      + FLIP_HINT,
  );

  // ② 命中数：恰好 1 行（同一文件里多一行同样是「读写接缝」）。
  assert.equal(
    hits.length,
    1,
    '【缺口 1 破了】`third_party_deletions` 的命中数不再是 1。'
      + `\n  实测：${JSON.stringify(hits.map((h) => `${h.file}:${h.line}: ${h.text}`))}`
      + '\n  基线只有 `packages/privacy/retention-policy.mjs:208` 那一行策略自陈。'
      + FLIP_HINT,
  );

  // ③ 那一行是「策略表自陈」，不是查询/写库 —— 这条把「白名单条目」和「真的接线」区分开。
  assert.equal(
    hits[0].text,
    "table: 'public.deletion_requests / public.deletion_handlers / public.third_party_deletions',",
    '【缺口 1 破了】白名单那一行的**内容**变了。'
      + `\n  实测：${JSON.stringify(hits[0].text)}`
      + '\n  基线：`    table: \'public.deletion_requests / public.deletion_handlers / public.third_party_deletions\',`'
      + '\n  若只是策略表改口径 ⇒ 同步改本常数；若这行不再是 `table:` 自陈 ⇒ 白名单不再是「自陈」，重新核定。'
      + FLIP_HINT,
  );

  // ④ 行号：与 ①②③ 分开断言，好让「只是行号漂移」和「语义变了」红得不一样。
  assert.equal(
    hits[0].line,
    208,
    `【缺口 1 · 行号漂移】\`third_party_deletions\` 的自陈行从 :208 挪到了 :${hits[0].line}。`
      + '\n  若文本没变（上一条仍然绿）⇒ 这只是一次无关编辑把它推下去/拉上来了，把常数改成新行号即可，'
      + '**语义未变**。'
      + '\n  若文本也变了 ⇒ 那才是缺口被动了，按上一条的提示处理。'
      + FLIP_HINT,
  );
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
      + '  若你刚做了这件事 ⇒ 请翻转本钉子，并同步 #19 的接线登记（docs/architecture/gy-r34-retention-policy.md）。'
      + FLIP_HINT,
  );

  // ② app.ts 单独钉：它是本仓唯一的装配点，缺口的判据就在这里。
  const appSource = readRepoText('services/api/src/app.ts');
  assert.equal(
    occurrences(appSource, 'createThirdPartyDeletionAdapter'),
    0,
    '【缺口 2 破了】`services/api/src/app.ts` 里出现了 `createThirdPartyDeletionAdapter` —— 装配发生了。'
      + '\n  基线（81d8e0b9）：app.ts 1766 行里零出现（第三方删除只有**投影** '
      + '`privacy/third-party-deletion-projection.ts` 的只读消费，没有出站适配器）。'
      + '\n  ⇒ 请翻转本钉子，并把 docs/architecture/gy-r34-retention-policy.md 的「接线方式」一栏从'
      + '  「未做」改成新事实。'
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
// 缺口 3 · 保留策略：没有调度单元
// ---------------------------------------------------------------------------

test('缺口 3 · deploy/purge-schedule/ 没有任何 retention 调度单元（只有 online-data 与 backup-copies）', () => {
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

  // ① 全集恰好四条：这条同时挡住「新增」与「删掉」（两侧都是缺口状态的改动）。
  assert.deepEqual(
    units,
    [
      'gengyun-purge-backup-copies.service',
      'gengyun-purge-backup-copies.timer',
      'gengyun-purge-online-data.service',
      'gengyun-purge-online-data.timer',
    ],
    '【缺口 3 破了】`deploy/purge-schedule/` 的调度单元全集变了：'
      + `\n  实测：${JSON.stringify(units)}`
      + '\n  基线（81d8e0b9）：只有 online-data（在线 7 日）与 backup-copies（备份 30 日）各一对 service/timer；'
      + '**没有任何 retention 单元** ⇒ 保留策略（`tools/purge-retention-expired.mjs`）至今只能手工执行。'
      + '\n  若你刚加了 `gengyun-purge-retention.{service,timer}` ⇒ 请翻转本钉子，并把 '
      + 'docs/architecture/gy-r34-retention-policy.md:121 与 docs/verification/gy-r34-retention-20261023.md:122 '
      + '的「未做 / 未加」改掉。'
      + FLIP_HINT,
  );

  // ② 单独一条 retention 判据：红的时候点得比 ① 更准。
  assert.deepEqual(
    units.filter((name) => /retention/i.test(name)),
    [],
    '【缺口 3 破了】出现了 retention 调度单元：'
      + `\n  实测：${JSON.stringify(units.filter((name) => /retention/i.test(name)))}`
      + '\n  基线（81d8e0b9）：零个。保留策略的到期清除**没有**宿主机时钟，只有手工 `npm run purge:retention`。'
      + '\n  ⚠ 接线前要先解决 `[calendar]` 判据的冲突：`tools/verify-purge-schedule.mjs` 要求 '
      + '`OnCalendar=` 展开后的最大间隔 ≤ 60 分钟，而保留任务是**日级**的 —— 见 '
      + 'docs/verification/gy-r34-retention-20261023.md:122。'
      + FLIP_HINT,
  );

  // ③ 派发单里的对照项经核对**不成立**，如实钉住：media 也没有自己的调度单元。
  //    （媒体行的物理删除走 0035 的函数面，不是日历任务 —— 见缺口 6。）
  assert.deepEqual(
    units.filter((name) => /media/i.test(name)),
    [],
    '【缺口 3 · 事实更正】出现了 media 调度单元：'
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
    ['purge:backup-copies', 'purge:online-data'],
    '【缺口 3 · 自陈变了】`GY-SCHEDULE: npm-script=` 指向的命令集合变了：'
      + `\n  实测：${JSON.stringify(declared)}`
      + '\n  基线（81d8e0b9）：backup-copies.service ⇒ `purge:backup-copies`；'
      + 'online-data.service ⇒ `purge:online-data`；**没有** `purge:retention`。'
      + '\n  （缺标记会得到 `null`，同样让这条红 —— 那是判据标记被删，不是缺口的进展。）'
      + FLIP_HINT,
  );
});

// ---------------------------------------------------------------------------
// 缺口 4 · purge:retention 不在必需脚本清单
// ---------------------------------------------------------------------------

test('缺口 4 · REQUIRED_NPM_SCRIPTS 不含 purge:retention（该常量只在 tools/verify-purge-schedule.mjs 定义一次）', () => {
  const DECL = 'tools/verify-purge-schedule.mjs';

  // ① 唯一定义点：常量被挪走/复制一份都会红（否则「不含」这句话可以对着空气说）。
  //    ⚠ 排掉 `SELF_FILE`：本文件在失败提示里逐字写了这个声明，不排会自己数自己（见 SELF_FILE 注释）。
  const defining = ['tools', 'packages', 'services/api/src', 'tests']
    .flatMap((root) => walkFiles(root))
    .filter((file) => file !== SELF_FILE)
    .filter((file) => /export\s+const\s+REQUIRED_NPM_SCRIPTS\b/.test(readRepoText(file)));
  assert.deepEqual(
    defining,
    [DECL],
    '【缺口 4 · 判据位置变了】`REQUIRED_NPM_SCRIPTS` 的定义点集合变了：'
      + `\n  实测：${JSON.stringify(defining)}`
      + `\n  基线（81d8e0b9）：只在 ${DECL} 定义一次（其余地方都是 import）。`
      + '\n  若你把门禁搬家了 ⇒ 请把本钉子的 DECL 与新位置对齐，并确认「不含 purge:retention」在新位置仍然成立。'
      + FLIP_HINT,
  );

  // ② 形状：抓不到声明就是判据位置失效（不是「不含」）。
  const declaration = /export const REQUIRED_NPM_SCRIPTS = Object\.freeze\(\[([^\]]*)\]\)/.exec(readRepoText(DECL));
  assert.equal(
    declaration === null,
    false,
    `【缺口 4 · 形状变了】在 ${DECL} 里抓不到 \`export const REQUIRED_NPM_SCRIPTS = Object.freeze([…])\`。`
      + '\n  基线（81d8e0b9）在第 109 行，单行字面量数组。'
      + '\n  若改成了多行/`new Set`/从别处汇总 ⇒ 请同步改本钉子的解析方式（⛔ 别直接删掉这条判据）。'
      + FLIP_HINT,
  );

  // ③ 清单内容恰好两条（顺序也钉住：它同时决定报告里 joined 文案的顺序）。
  const names = [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(
    names,
    ['purge:online-data', 'purge:backup-copies'],
    '【缺口 4 破了】`REQUIRED_NPM_SCRIPTS` 的内容变了：'
      + `\n  实测：${JSON.stringify(names)}`
      + '\n  基线（81d8e0b9）：`[\'purge:online-data\', \'purge:backup-copies\']` —— 只覆盖两条日历级命令。'
      + '\n  若你刚把 `purge:retention` 加进去 ⇒ 那是收紧门禁，**必须先有对应的 `.service`**（否则 '
      + '`[coverage]` 判据会连带红，见 tools/verify-purge-schedule.mjs:767 起）。'
      + FLIP_HINT,
  );

  // ④ 单独一条 retention 判据（红的时候点得更准）。
  assert.equal(
    names.includes('purge:retention'),
    false,
    '【缺口 4 破了】`purge:retention` 进了 `REQUIRED_NPM_SCRIPTS`：'
      + `\n  实测：${JSON.stringify(names)}`
      + '\n  基线（81d8e0b9）：**不在**。命令本体早在 package.json 里'
      + '（`node tools/purge-retention-expired.mjs`），缺的是「必需覆盖」这条登记 —— '
      + 'docs/architecture/gy-r34-retention-policy.md:121 原文：「（**当前没加**：还没有对应 `.service`，'
      + '加了会直接红）」。'
      + '\n  ⇒ 请翻转本钉子并同步该文档，同时补齐 `deploy/purge-schedule/` 的 retention 单元。'
      + FLIP_HINT,
  );

  // ⑤ 缺口是「未进清单 + 无单元」，**不是**「命令没写」——把这条钉住，免得被误诊成「缺脚本」。
  const pkg = JSON.parse(readRepoText('package.json'));
  assert.equal(
    pkg.scripts['purge:retention'],
    'node tools/purge-retention-expired.mjs',
    '【缺口 4 · 前提变了】`package.json` 的 `purge:retention` 不再是 '
      + '`node tools/purge-retention-expired.mjs`：'
      + `\n  实测：${JSON.stringify(pkg.scripts['purge:retention'])}`
      + '\n  基线（81d8e0b9）：命令**在**，只是没被门禁的必需清单覆盖、也没有调度单元。'
      + '\n  若命令改名/挪走 ⇒ 同步这一行，并重核缺口 4 的结论。'
      + FLIP_HINT,
  );
});

// ---------------------------------------------------------------------------
// 缺口 5 · CI 未引用两条校验
// ---------------------------------------------------------------------------

test('缺口 5 · .github/workflows/ 里 grep 不到 verify:purge-schedule 与 restore-drill', () => {
  const WF_DIR = '.github/workflows';
  const names = readdirSync(join(REPO_ROOT, ...WF_DIR.split('/')), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const files = names.map((name) => `${WF_DIR}/${name}`);

  // 扫描面前提：三个已知 workflow 必须在位（否则「零命中」是空转）。
  for (const anchor of ['engineering-shell.yml', 'migrations-guard.yml', 'real-pg-integration.yml']) {
    assert.equal(
      names.includes(anchor),
      true,
      `扫描面里没有 ${WF_DIR}/${anchor} ⇒ workflow 目录搬家/改名了，本钉子的「零命中」不可信。`,
    );
  }

  // ① 调度门禁没进 CI。
  assert.deepEqual(
    files.filter((file) => readRepoText(file).includes('verify:purge-schedule')),
    [],
    '【缺口 5 破了】CI 引用了 `verify:purge-schedule`：'
      + `\n  实测命中：${JSON.stringify(files.filter((file) => readRepoText(file).includes('verify:purge-schedule')))}`
      + '\n  基线（81d8e0b9）：`.github/workflows/**` 零命中 ⇒ 调度层的门禁（'
      + '`tools/verify-purge-schedule.mjs`，10 项判据）只在本地/单测里跑，不在 CI 里跑。'
      + '\n  若你刚把它接进 CI ⇒ 请翻转本钉子。'
      + FLIP_HINT,
  );

  // ② 恢复演练没进 CI（脚本在 `deploy/postgres-cvm/restore-drill.{sh,ps1}`，但没人按点叫它）。
  assert.deepEqual(
    files.filter((file) => readRepoText(file).includes('restore-drill')),
    [],
    '【缺口 5 破了】CI 引用了 `restore-drill`：'
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
