/**
 * 锚点位移恒等闸门：`docs/**` 里手写的 `<路径>:<行号>`（以及同一行里跟在路径后面的裸 `:<行号>`）
 * 在「文件本身没被改」时，行号**一个都不许变**；在「文件被改了」时，行号必须落在这个文件自己的
 * `git diff -U0` 端点映射算出来的位置上，且**旧行原文 === 新行原文**。
 *
 * 为什么需要这条闸门：`tools/verify-doc-anchors.mjs` 只判「路径在不在 / 行号在不在文件范围内 /
 * 区间里有没有实质内容」。它**不知道**这条锚点在 base 上指向什么，所以「旧号仍然正确、新号被
 * 平移到一个指向别处（空行、`);`、另一段散文）的行上」这种纯回归在它眼里是全绿的 ——
 * GY-R67-A03 就出过这类反例（目标文件本提交一个字都没改，锚点却被按别的文件的插入量 +3／+4／+6
 * 平移了）。本用例把「重定位必须与目标文件自己的位移一致」写成可机械判定的断言。
 *
 * 判据（全部现场重算，**零硬编码**：本文件不写任何期望条数／期望行号／提交 sha）：
 *   1) base = `git merge-base HEAD origin/main`（拿不到再退 `upstream/main`，再退 `HEAD~1`）；
 *   2) 扫描面 = `git diff -U0 <base>..HEAD -- docs/` 里被**改写**的那批行（旧行文本→新行文本配对）；
 *      每个 hunk 先按 `@@ -<oldCount> +<newCount> @@` 分成三类：`pairedHunks`（旧侧、新侧都非空，
 *      真能配出「旧行→新行」）、`pureAddHunks`（旧侧 0 行 ⇒ 一行都配不出来）、`pureDeleteHunks`
 *      （新侧 0 行 ⇒ 旧行整行消失，锚点走 `removed` 桶）。本次文档改动面**全部**是纯新增 hunk 时，
 *      这条提交没有任何位移面可言，显式 SKIP 并报出纯新增 hunk 数（见「已知限制之三」）；
 *   3) 每对行里按仓库既有写法抽锚点：`<路径>:<起>[-<止>]` 与紧跟在某个路径锚点之后的裸 `:<起>[-<止>]`；
 *      裸锚点解析不出归属（同行没有前置路径 / 前置路径装不下这个行号）时退回**当前文档自身**；
 *   4) 目标文件本提交未改动 ⇒ 断言 `new === old`（起止都断言）；
 *      目标文件本提交改动 ⇒ 用该文件自己的 `git diff -U0` 建端点映射，断言 `new === map(old)`；
 *   5) 两种情形都断言「`git show <base>:<目标>` 的旧行原文 === `git show HEAD:<目标>` 的新行原文」
 *      （目标行落在该文件被改写/删除的区内时无法做内容同一性判定，如实计入「不可解析」）。
 *
 * 位移的**合法例外**有两类，都必须写进审查可见的登记表 `tests/unit/doc-anchor-relocations.json`
 * （字段 `doc` / `line` / `target` / `from` / `to` / `reason`，区间锚点再加 `fromEnd` / `toEnd`，
 * 可选 `kind` / `symbol`，仿 `tools/doc-anchors-baseline.json`）：
 *
 * Ａ) **陈旧锚点重锚**（`kind` 缺省）：目标文件**一个字没动**，只是文档里那个旧行号指错了，本提交把它
 *     改到正确行号。
 *   - 目标文件未改 + 行号变了 ⇒ **默认红**；
 *   - 只有登记表里**逐字匹配**（doc / line / target / from / to 全等；区间锚点连两端都等）的一条能把它
 *     降级为「已登记」，diagnostic 里会列出条数与逐条摘要；
 *   - **登记条目是「历史事实登记」，判它的是「HEAD 上是否仍成立」，不是「本次 diff 里有没有」**。
 *     一条登记只由引入它的那次提交举证一次（那次提交的文档改动面里必须有这条位移，否则它根本登记不
 *     进来）；之后每个改过 `docs/**` 的提交都会把它重新验一遍，但**不再要求它在本提交里复现** ——
 *     那条位移早已落在 base 里，`base..HEAD` 的文档改动面里当然没有它。历史实现要求「本次提交的文档
 *     改动面里必须能找到这条位移」，等于：谁修掉一个跨提交漂移的旧锚点，下一个**无关**的 docs 提交就
 *     会因为它而判红（`upstream/main` 上真实发生过）。现在的两档判定：
 *       ① **陈旧**（HEAD 上已经站不住）：`from == to`、`doc` 或该行在 HEAD 上不存在、
 *          该行已不再含 `⟨target :to⟩`、目标文件缺失或行号越界、`base[from]` 与 `HEAD[to]` 原文相同
 *          （旧锚点本来就指对了）、形状不合法 —— **判红并点名**；
 *       ② **冗余**（这条位移本提交自己就能用端点映射判出来，或本次改动面里已有另一条登记接住它）——
 *          **判红并点名**；
 *       ③ 其余（HEAD 上仍成立、本次提交的文档改动面没涉及它）= **历史保留**，逐条进 `carried` 并在
 *          diagnostic 里点名读数，**不判红**。
 *
 * Ｂ) **陈旧锚点纠正**（`kind: "correction"` + 必填 `symbol`）：目标文件**本提交被改了**，而旧锚点在
 *     base 上**本来就是错的** —— 它指到 `Error413`／参数 `{`／`schema` 这类与引用语义无关的行。此时端点
 *     映射只会把错误机械平移到另一个错行，改成真正正确的行号又撞「必须等于端点映射」，作者无路可走
 *     （GY-R68 的 A05 片就是受害者）。这一类补的正是这条**整改通道**：把 from→to 连同「应该落到哪个
 *     符号上」一起登记出来，闸门改为验真「新行确实含该符号」。
 *   - 它**不是白名单**，验真三件事缺一即红：
 *       ① HEAD 版 target 的 `to`（区间则整段连起来看）必须含 `symbol`；
 *       ② base 版 target 的 `from`（区间则逐行看）必须**不含** `symbol` —— 含了就说明旧锚点本来就指对了，
 *          那是真回归而不是纠正，这条登记必须删（文案直说「这不是纠正」）；
 *       ③ `from !== to`；
 *     另外文档侧 `doc:line` 必须真的含 ⟨target :to⟩（与Ａ类共用同一条陈旧判据）。
 *   - 它可以出现在「目标文件本提交有改动」那一支：接住后计入 `registered` 并**跳过端点映射判定**；
 *     也可以出现在「目标文件未改」那一支（与Ａ类行为一致）。同一行多个 token 复用一条登记的行为不变。
 *   - 生效时逐条打印 `kind=correction` 与 `symbol`，同时计入 `stats.corrected`（`summarize()` 的
 *     `corrected=N`、`judgmentBuckets().corrected`），便于人工复核；`corrected` **只在验真通过后 +1**。
 *   - 缺省 `kind` 的条目在「目标文件有改动」那一支**仍然没有逃生口**（那一支只认 `kind: "correction"`）；
 *     反过来，correction 也放行不了「新行仍然是旧行那一段文本」（②：那样 base 的 `from` 窗口也含
 *     `symbol`），也放行不了 `from === to`（③）。但它**不判断语义**：旧行原文若已落在新树别处、而
 *     文档被人工指到另一条恰好含 `symbol` 的行，这条通道会放行 —— 这是代价，兜底靠「登记条目随 diff
 *     进 review」+「生效时逐条打印 `kind=correction` 与 `symbol`」。
 *
 * 登记表不是白名单垃圾桶：HEAD 上站不住的一条都留不下来，本次真用得上却没登记的位移照样红；
 *   - 空登记表（`[]`）是合法状态，本片（GY-R67-A03）就是零条目：11 处回退之后目标文件未改且行号恒等。
 *
 * 已知限制（**不是正确语义**，见本文件末尾的常驻用例）：整条锚点被删掉时，扫描面里只剩「旧锚点」，
 * 没有新锚点可比对，判不了「该不该删」—— 判红会误伤正常删除，所以只**计数并逐条列进 diagnostic**
 * （`removed` 桶），不判红。删锚点这件事因此是「可观测但放行」。相应地，这类提交的 `judged` 可能是 0，
 * 「扫描面非空」的自证落在「每个抽到的 token 都进了某个桶（判定／已删／未判）」上；只有「配出了行对、
 * 但那些行里一个锚点都没抽到」（纯散文改动、整行没有行号引用）才显式 SKIP 为「无判定面」，绝不静默
 * 记成 PASS。
 *
 * 已知限制之三（**纯新增 docs 提交**，GY-R68 追加；每一条都**只记录、不擅自扩判定面**）：
 *   ① `git diff -U0` 对「只新增行、不改旧行」的文档提交给出 `@@ -N,0 +M,K @@`（旧侧 0 行），
 *      `pairHunkLines()` 一行都配不出来，`removed` 桶也接不住它（没有任何旧行），于是这种提交曾经落到
 *      「扫描面为空」的硬红上 —— 那是**假红**：这种提交根本没有位移面可言。现在的口径是「本次文档改动面
 *      **全部**是纯新增 hunk ⇒ 显式 SKIP（文案带纯新增 hunk 数）」；只要掺进一个配得上行的 hunk 或一个
 *      纯删除 hunk，就不许 SKIP（末尾 A1／A4 两条常驻用例钉住，A2／A3 钉住「没有变松」）。
 *   ② 整份文档被删（`+++ /dev/null`）⇒ `parseDocDiffSinglePass()` 把该文件整体过滤掉；若它是本次唯一的
 *      文档改动，`docFiles === 0` ⇒ `judge()` 退 `reason: '没有改动 docs/**'` ⇒ 主用例仍 SKIP。既有形状，
 *      本片不动它（删整份文档不会产生任何「需要重锚」的行）。
 *   ③ 纯改名（`--no-renames` 下是「删 + 增」）⇒ 旧文件侧是纯删除 hunk、新文件侧是纯新增 hunk ⇒
 *      `appendOnly` 判据不成立，落到「`docLines 0` 且 `removed 0`」的硬红上，文案会报出纯新增 hunk 数。
 *      若被改名的那份文件里本来没有锚点，这仍是一条「没有位移面却被判红」的形状 —— 已知、未在本片处理
 *      （至少它是可读的硬红，不是静默通过）。
 *   ④ SKIP 只证明「本次没有位移面」，**不证明**新增行里的锚点写对了：新增行没有「旧行」可比，一旦
 *      纯新增 hunk 被 SKIP，那些新增行号是否正确就只由 `tools/verify-doc-anchors.mjs --strict` 那套
 *      「行号在不在文件范围内」兜底。这条闸门对此确实**没有**判别力。
 *   ⑤ `tokens === 0` 只在「没有任何桶接过东西」时才 SKIP（「配出了行对，但一个锚点都没抽到」= 纯散文
 *      改动，A5 钉住）：本片**没有**把它改成硬红 —— 改判方向会让「随手修一个 typo 的 docs 提交」直接
 *      变红，而这条闸门的既有语义（上一段）就是「无判定面 ⇒ SKIP，绝不静默 PASS」。要改成红必须单独
 *      开片并同步改文案。
 *   ⑥ `tokens === 0` 但 `removed > 0`（纯删除型：整行删掉带锚点的行；或「纯删除 hunk + 纯新增 hunk」
 *      混排且没有配对 hunk）现在走 **ok/PASS**，旧实现是 SKIP —— 这是本片唯一一处判定方向变化，来源是
 *      「纯删除型只观测不判红、但扫描面确实非空」这条既有语义（上一段），A3 钉住它。它仍然判红 0 条：
 *      被删掉的锚点去哪了**没人判**，只是计数进 `removed` 并逐条列进 diagnostic。
 *
 * 已知限制之二（`kind: "correction"` 那一类）：三件验真验的是**文本**，不是语义 —— ② 只说明 base 的
 * `from` 窗口不含 `symbol`，它不扫描新树别处；③ 只判 `from !== to`。所以「新行含 `symbol`、旧行不含」
 * 这两条成立时，闸门分辨不出「这个片段是不是该锚点真正该指的 API」。`symbol` 还是**纯子串匹配**（见
 * `REGISTRY_ENTRY_SHAPE` 上方说明）：极短符号（`"e"`、`"id"`）几乎任何代码行都能命中，判别力实际落在
 * `reason` 与「登记条目随 diff 进 review」上，不落在闸门自己的判断里。
 *
 * CI 历史可用性：`actions/checkout` 默认 `fetch-depth: 1`，浅克隆下 `git merge-base` 拿不到 base，
 * 这条闸门的默认结局就是 exit 0 + SKIP —— 也就是「假绿」。现在是**双层**保障：
 *   - 第一层：`.github/workflows/engineering-shell.yml` 的 `unit` job 显式 `fetch-depth: 0`
 *     （`docs` job 不跑本用例，仍不带；`local-wechat.yml` 另有自己的 `fetch-depth: 0`）；
 *   - 第二层（纵深）：即便拿不到历史也不放任自己空转 —— CI 环境（`CI` 或
 *     `GITHUB_ACTIONS==='true'`）且取不到 base ⇒ **机会性自愈**：
 *     `git fetch --depth=50 origin +refs/heads/main:refs/remotes/origin/main`（公开仓匿名可 fetch；
 *     30 秒超时；失败不抛到用例外面），仍取不到再退一步 `git fetch --deepen=500 origin`
 *     （Action 的浅克隆会把 HEAD 的历史也截断，只加深 main 一侧往往仍无共同祖先）；
 *     自愈成功后**重新取 base 并真跑判定**，不许再 SKIP。
 *   - 只有 fetch **每一招都失败**（断网、DNS 不通、**超时**、remote 不存在、仓库不可达）才允许 SKIP，
 *     文案必须写「网络取 base 失败，本用例未执行」；若有任一招 fetch 跑通、只是 merge-base 仍失败，
 *     文案必须换成「自愈 fetch 成功但取不到共同祖先」—— 第二轮审查抓到的毛病正是这里**说谎**：
 *     第一版只拿 `NETWORK_ERROR` 正则去判 `firstLine(stderr)`，而超时的 `stderr` 是**空**（`code` 是
 *     `ETIMEDOUT`、`signal` 是 `SIGTERM`），于是超时被归进 `no-base`、SKIP 文案还写「fetch 成功」。
 *     现在分类先看 `code`/`signal`、文案按 `anyFetchSucceeded` 分支，两种都把每招的实际错误
 *     （`code`/`signal`/`stderr` 摘要）放进 `t.diagnostic`。`couldn't find remote ref` 这类
 *     「远端没有那个 ref」不算网络故障，会继续试下一招（`--deepen=500`）。非「无历史」类错误
 *     （权限、仓库损坏）一律 rethrow。
 *   - 非 CI 的浅克隆不做自愈，显式 `t.skip` 并打印原因（沿用 `tests/ui-adaptive.test.mjs:303-324`
 *     的既有约定：绝不静默 return 让 node:test 记成 PASS）。
 *   - 下面那批「变异夹具」用例不依赖本仓库历史，任何环境下都会真跑 —— 即使主用例因浅克隆 SKIP，
 *     这条闸门的判别逻辑仍然被现场验证过。
 *   - 自愈链路本身有一条**永久用例**钉住（文件末尾「CI 自愈：真浅克隆 + CI=true ⇒ 真的判了（不是 SKIP）」）：
 *     现场用 `git clone --depth=1 file:///…` 造一个真浅克隆，其中三个 fallback 全断（= CI 假绿的
 *     形状），断言「关掉自愈就必须 SKIP、开着自愈就必须判出红」—— 否则这条自愈随时可能悄悄烂掉。
 *   - 失败分类与 SKIP 文案另有**永久用例**（「fetch 超时必须归 network（不是 no-base），且 SKIP 文案
 *     不许谎称「fetch 成功」」）：注入伪 `ETIMEDOUT`／伪「远端没有该 ref」／伪「跑通但无共同祖先」，
 *     钉住「超时算网络」「文案按实际结果分支」「半失败两句都说」，**不必真等 30 秒超时**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REGISTRY_RELATIVE = 'tests/unit/doc-anchor-relocations.json';
const MAX_BUFFER = 512 * 1024 * 1024;
/** 自愈 fetch 的超时：CI 里卡住的网络不该把整个 unit job 拖死（两次 fetch 各 30 秒是上限）。 */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * 只读 git（夹具场景下也会用来建提交），默认在仓库根跑。
 * stderr 收进 error.stderr 而不是直接漏到测试输出里（`git show <rev>:<不存在路径>` 会打 fatal）。
 */
function git(args, options = {}) {
  const { cwd = ROOT, timeout } = options;
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(timeout === undefined ? {} : { timeout }),
  });
}

function firstLine(value) {
  return String(value).trim().split('\n')[0];
}

/** 与 `tools/verify-doc-anchors.mjs` 同一套扩展名口径：`10.20.0.0:16` 这类 IP／端口不会被当锚点。 */
const ANCHOR_EXTENSIONS = Object.freeze([
  'mjs', 'cjs', 'js', 'jsx', 'ts', 'tsx', 'json', 'jsonc', 'sql',
  'md', 'yml', 'yaml', 'css', 'html', 'py', 'sh', 'ps1', 'toml',
]);
const PATH_ANCHOR = new RegExp(
  `(?<![\\w.\\-/])((?:[\\w.\\-]+/)*[\\w.\\-]+\\.(?:${ANCHOR_EXTENSIONS.join('|')})):(\\d+)(?:-(\\d+))?(?!\\d)`,
  'g',
);
/** 裸锚点：必须是独立的 `:N`／`:N-M`，前面紧跟文件名字符的不算（那是路径锚点的尾巴）。 */
const BARE_ANCHOR = /(?<![\w.\-/]):(\d+)(?:-(\d+))?(?!\d)/g;

/** 从一行 Markdown 里按出现顺序抽出锚点 token，并把裸锚点归属到同行最近的**前置**路径锚点。 */
function anchorTokens(line) {
  // `matchAll` 会按正则当前的 `lastIndex` 起扫，而这两个正则带 `g`；先归零，
  // 免得上一次 `.test()`／`matchAll()` 留下的 `lastIndex` 把这一行前半截的锚点吃掉。
  PATH_ANCHOR.lastIndex = 0;
  BARE_ANCHOR.lastIndex = 0;
  const pathHits = [...line.matchAll(PATH_ANCHOR)].map((match) => ({
    kind: 'path',
    index: match.index,
    target: match[1],
    start: Number(match[2]),
    end: match[3] === undefined ? Number(match[2]) : Number(match[3]),
  }));
  const bareHits = [...line.matchAll(BARE_ANCHOR)].map((match) => ({
    kind: 'bare',
    index: match.index,
    target: null,
    start: Number(match[1]),
    end: match[2] === undefined ? Number(match[1]) : Number(match[2]),
  }));
  const ordered = [...pathHits, ...bareHits].sort((left, right) => left.index - right.index);
  let previousPath = null;
  for (const token of ordered) {
    if (token.kind === 'path') previousPath = token.target;
    else token.target = previousPath;
  }
  return ordered;
}

/** `git diff -U0` 的 hunk 头：`@@ -a,b +c,d @@`（`-U0` 下 hunk 体只含 `-`/`+` 行）。 */
function parseHunks(diffText) {
  const hunks = [];
  let current = null;
  for (const line of diffText.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header !== null) {
      current = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        oldLines: [],
        newLines: [],
      };
      hunks.push(current);
      continue;
    }
    if (current === null) continue;
    if (line.startsWith('-')) current.oldLines.push(line.slice(1));
    else if (line.startsWith('+')) current.newLines.push(line.slice(1));
  }
  return hunks;
}

/**
 * 文档侧解析：单遍扫描，hunk 体直接落到对应的 hunk 上。
 * 返回 `[{path, hunks:[{oldStart, oldCount, newStart, newCount, oldLines, newLines}]}]`。
 */
function parseDocDiffSinglePass(diffText) {
  const files = [];
  let file = null;
  let hunk = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = { path: null, hunks: [] };
      hunk = null;
      files.push(file);
      continue;
    }
    if (file === null) continue;
    if (line.startsWith('+++ ') && hunk === null) {
      const raw = line.slice(4).trim();
      file.path = raw === '/dev/null' ? null : raw.replace(/^b\//, '');
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header !== null) {
      hunk = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        oldLines: [],
        newLines: [],
      };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk === null) continue;
    if (line.startsWith('-') && !line.startsWith('--- ')) hunk.oldLines.push(line.slice(1));
    else if (line.startsWith('+') && !line.startsWith('+++ ')) hunk.newLines.push(line.slice(1));
  }
  return files.filter((entry) => entry.path !== null);
}

/**
 * 在一个 hunk 内把旧行与新行配对，返回 `{ pairs, unpairedOld }`（配对用**数组下标**，
 * 行号由调用方按 `hunk.oldStart + oldIndex` / `hunk.newStart + newIndex` 现算，不再假设两侧偏移相同）。
 * - 行数相同 ⇒ 按下标一一配（文档改写绝大多数是 n→n，例如 1→1、2→2）；
 * - 行数不同 ⇒ 先按逐字相同的行做最长公共子序列配对，再把剩下的**等量**残块按下标配
 *   （「整段重写」的常见形态）；残块数量不等时如实留空：旧行进 `unpairedOld`（被删掉的旧行，
 *   其锚点在新侧彻底消失），新行不参与判定（新增行没有「旧行原文」可核）。
 */
function pairHunkLines(hunk) {
  const { oldLines, newLines } = hunk;
  if (oldLines.length === newLines.length) {
    return {
      pairs: oldLines.map((_, index) => ({ oldIndex: index, newIndex: index })),
      unpairedOld: [],
    };
  }
  const table = Array.from({ length: oldLines.length + 1 }, () => new Array(newLines.length + 1).fill(0));
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i][j] = oldLines[i] === newLines[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs = [];
  const usedOld = new Set();
  const usedNew = new Set();
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      pairs.push({ oldIndex: i, newIndex: j });
      usedOld.add(i);
      usedNew.add(j);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  const restOld = oldLines.map((_, index) => index).filter((index) => !usedOld.has(index));
  const restNew = newLines.map((_, index) => index).filter((index) => !usedNew.has(index));
  if (restOld.length === restNew.length) {
    restOld.forEach((oldIndex, offset) => {
      pairs.push({ oldIndex, newIndex: restNew[offset] });
    });
  }
  pairs.sort((left, right) => left.oldIndex - right.oldIndex);
  return {
    pairs,
    unpairedOld: restOld.length === restNew.length ? [] : restOld,
  };
}

/** `git show <rev>:<path>` 的行数组；文件不存在返回 null。 */
function readLines(root, rev, path, cache) {
  const key = `${rev}\u0000${path}`;
  if (cache.has(key)) return cache.get(key);
  let lines = null;
  try {
    lines = git(['show', `${rev}:${path}`], { cwd: root }).split('\n');
  } catch {
    lines = null;
  }
  cache.set(key, lines);
  return lines;
}

/** 目标文件自己的位移映射：旧行号 → 新行号；落在被改写/删除区内的旧行返回 `undefined`。 */
function relocationMap(hunks, oldLine) {
  let delta = 0;
  for (const hunk of hunks) {
    if (hunk.oldCount === 0) {
      // 纯插入：插在旧行 `oldStart` 之后，故 `oldStart` 自身不移位。
      if (oldLine > hunk.oldStart) delta += hunk.newCount;
      continue;
    }
    if (oldLine >= hunk.oldStart && oldLine < hunk.oldStart + hunk.oldCount) return undefined;
    if (oldLine >= hunk.oldStart + hunk.oldCount) delta += hunk.newCount - hunk.oldCount;
  }
  return oldLine + delta;
}

const HISTORY_ERROR = /unknown revision|bad revision|ambiguous argument|Needed a single revision|no merge base|Not a valid object name|does not have any commits yet/i;
/**
 * 只把「真的够不到远端」当网络故障：`couldn't find remote ref` 这类是**远端没有那个 ref**，
 * 不是网络问题，必须继续试下一招，不能拿它当 SKIP 的理由。
 */
const NETWORK_ERROR = /could not resolve host|unable to access|failed to connect|connection refused|connection timed out|operation timed out|timed out|network is unreachable|the remote end hung up|rpc failed|early eof|ssl|tls|proxy|authentication failed|could not read from remote repository|repository .* does not exist|does not appear to be a git repository|repository not found/i;

/** base 解析：`origin/main` → `upstream/main` → `HEAD~1`。全部失败时返回 null + 尝试记录。 */
function resolveBase(root) {
  const attempts = [];
  for (const ref of ['origin/main', 'upstream/main']) {
    try {
      const sha = git(['merge-base', 'HEAD', ref], { cwd: root }).trim();
      if (sha !== '') return { sha, label: `git merge-base HEAD ${ref}`, attempts };
      attempts.push(`merge-base HEAD ${ref} → 空`);
    } catch (error) {
      attempts.push(`merge-base HEAD ${ref} → ${firstLine(error.stderr ?? error.message)}`);
    }
  }
  try {
    const sha = git(['rev-parse', 'HEAD~1'], { cwd: root }).trim();
    if (sha !== '') return { sha, label: 'git rev-parse HEAD~1', attempts };
    attempts.push('rev-parse HEAD~1 → 空');
  } catch (error) {
    attempts.push(`rev-parse HEAD~1 → ${firstLine(error.stderr ?? error.message)}`);
  }
  return { sha: null, label: null, attempts };
}

function isCi() {
  return Boolean(process.env.CI) || process.env.GITHUB_ACTIONS === 'true';
}

/** 浅克隆（`actions/checkout` 默认 `fetch-depth: 1`）是「取不到 base」的唯一正当理由。 */
function isShallowRepository(root) {
  try {
    return git(['rev-parse', '--is-shallow-repository'], { cwd: root }).trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * 一次 fetch 失败的分类。**超时也是「没取到」，不许被当成 `no-base`**：
 * `execFileSync` 超时抛的是 `code: 'ETIMEDOUT'` / `signal: 'SIGTERM'`，而且 `stderr === ''` ——
 * 错误文本里根本没有 `timed out` 这几个字。第一版只拿 `NETWORK_ERROR` 正则去判 `firstLine(stderr)`
 * 于是超时落进 `no-base`，SKIP 文案还写成「fetch 成功」，把真实原因整个丢了（审查方实测复现）。
 * 所以：先看 `code`/`signal`，再看文本；`stderr` 为空时退回 `error.message`（`spawnSync git ETIMEDOUT`）。
 */
function classifyFetchFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const signal = typeof error?.signal === 'string' ? error.signal : '';
  const stderr = String(error?.stderr ?? '');
  const fallback = String(error?.message ?? '');
  const source = stderr.trim() === '' ? fallback : stderr;
  const detail = firstLine(source) || '(stderr 与 message 皆空)';
  const timedOut = code === 'ETIMEDOUT' || signal !== '';
  return {
    code,
    signal,
    detail,
    stderrSummary: summarizeStderr(stderr, fallback),
    timedOut,
    network: timedOut || NETWORK_ERROR.test(source),
  };
}

/** stderr 摘要：多行压成一行、截到 240 字；**空 stderr 要显式写「空」**，不能留一个洞。 */
function summarizeStderr(stderr, fallback) {
  const text = String(stderr ?? '').trim();
  if (text === '') return `(空；error.message=${firstLine(String(fallback ?? '')) || '—'})`;
  const flat = text.split('\n').map((line) => line.trim()).filter((line) => line !== '').join(' / ');
  return flat.length > 240 ? `${flat.slice(0, 240)}…` : flat;
}

/**
 * 机会性自愈：浅克隆里把 base 拉回来。
 * 先按审查方指定的 refspec 补 `origin/main`（`--depth=50`：`fetch-depth: 1` 的克隆里连 feature 侧
 * 也只有 1 个提交，50 足够覆盖绝大多数 PR 的 base）；这一招失败（例如远端根本没有 `refs/heads/main`）
 * 不当作网络故障，继续下一招 `--deepen=500`（Actions 的 `fetch-depth: 1` 把 HEAD 的历史也截断了，
 * 只补 main 一侧两端仍不相连，加深才能让共同祖先恢复）。
 *
 * 返回 `{ resolved, failure, failures, anyFetchSucceeded, timedOut }`：
 *   · `failure === 'network'`：**至少一招** fetch 因为网络/认证/超时失败；
 *   · `failure === 'no-base'`：每一招 fetch 都跑通了，但仍无共同祖先；
 *   · `failures`：每一招的**实际**错误（`code`/`signal`/`stderr` 摘要），供 `t.diagnostic` 原样带出；
 *   · `anyFetchSucceeded`：是否有某一招 fetch 真的 exit 0 —— SKIP 文案按它分支，**不许再说谎**。
 *
 * `run` / `resolve` 只为永久用例注入伪错误对象（否则验一条超时分支要真等 30 秒）；
 * 生产路径不传，走 `git` 与 `resolveBase`。
 */
function selfHealBase(root, attempts, { run = git, resolve = resolveBase } = {}) {
  const steps = [
    {
      label: 'git fetch --depth=50 origin +refs/heads/main:refs/remotes/origin/main',
      args: ['fetch', '--depth=50', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
    },
    { label: 'git fetch --deepen=500 origin', args: ['fetch', '--deepen=500', 'origin'] },
  ];
  const failures = [];
  let networkError = null;
  let anyFetchSucceeded = false;
  for (const step of steps) {
    try {
      run(step.args, { cwd: root, timeout: FETCH_TIMEOUT_MS });
      anyFetchSucceeded = true;
    } catch (error) {
      const failure = classifyFetchFailure(error);
      const kind = failure.timedOut ? '超时' : (failure.network ? '网络失败' : '失败');
      const text = `${step.label} → ${kind}（code=${failure.code || '—'} signal=${failure.signal || '—'}，`
        + `超时上限 ${FETCH_TIMEOUT_MS}ms）：${failure.detail}`;
      failures.push({ step: step.label, ...failure, text });
      attempts.push(text);
      if (failure.network && networkError === null) networkError = text;
      continue;
    }
    const retried = resolve(root);
    attempts.push(...retried.attempts);
    if (retried.sha !== null) {
      attempts.push(`${step.label} → 成功，base = ${retried.sha.slice(0, 12)}（${retried.label}）`);
      return { resolved: retried, failure: null, failures, anyFetchSucceeded, timedOut: false };
    }
    attempts.push(`${step.label} → 成功，但 merge-base 仍取不到`);
  }
  return {
    resolved: null,
    failure: networkError === null ? 'no-base' : 'network',
    networkError,
    failures,
    anyFetchSucceeded,
    timedOut: failures.some((failure) => failure.timedOut),
  };
}

/**
 * 自愈失败后的**裁决**（`{ action: 'skip' | 'throw', message }`）。
 *
 * 文案必须按**实际结果**分支（第一版在这里说谎：fetch 超时／全失败也照样写「fetch 成功」）：
 *   · 每一招 fetch 都失败 ⇒ 「网络取 base 失败」（拿不到 origin/main，不是判定通过）；
 *   · 有 fetch 跑通、但 merge-base 仍失败 ⇒ 「自愈 fetch 成功但取不到共同祖先」；
 *     浅克隆（边界没连通）可以 SKIP，完整仓库却是逻辑坏了 ⇒ 硬失败。
 * 抽成函数是为了让永久用例直接钉文案：超时**不许**走到「fetch 成功」那一支。
 */
function selfHealDeadEnd(heal, shallow) {
  const tail = '每一招的实际错误见 t.diagnostic';
  if (!heal.anyFetchSucceeded) {
    const kinds = heal.failures.map((failure) => (failure.timedOut ? '超时' : (failure.network ? '网络' : '其它')));
    return {
      action: 'skip',
      message: 'SKIP: 网络取 base 失败，本用例未执行 —— CI 里 '
        + `${heal.failures.length} 招 git fetch 全部失败（${kinds.join('/') || '未知'}；`
        + '失败即拿不到 origin/main），这不是判定通过。'
        + tail,
    };
  }
  const partial = heal.failure === 'network'
    ? `${heal.failures.length} 招 fetch 报错、另有一招跑通，浅克隆边界仍未连通`
    : '浅克隆边界未连通（fetch 跑通了，但 merge-base 仍取不到共同祖先）';
  if (shallow) {
    return {
      action: 'skip',
      message: `SKIP: 自愈 fetch 成功但取不到共同祖先，本用例未执行 —— ${partial}。${tail}`,
    };
  }
  return {
    action: 'throw',
    message: '取不到 base，且仓库**不是**浅克隆（完整仓库却没有 origin/main、upstream/main、HEAD~1）—— '
      + `自愈 fetch 成功但取不到共同祖先，本用例无法判定，也不允许静默通过（${partial}）。${tail}`,
  };
}

/** 自愈失败的诊断载荷：每一招的 `code`/`signal`/`stderr` 摘要 ＋ 全部尝试记录，一行都不许丢。 */
function fetchDiagnosticOf(heal, attempts, shallow) {
  const lines = [
    `CI 自愈 fetch 明细：failure=${heal.failure ?? '—'} anyFetchSucceeded=${heal.anyFetchSucceeded}`
      + ` timedOut=${heal.timedOut} shallow=${shallow} 超时上限=${FETCH_TIMEOUT_MS}ms`,
  ];
  if (heal.failures.length === 0) {
    lines.push('  · （没有任何一招 fetch 报错：全部 exit 0，只是 merge-base 仍取不到）');
  }
  for (const failure of heal.failures) {
    lines.push(`  · ${failure.step}`);
    lines.push(`      分类=${failure.timedOut ? '超时' : (failure.network ? '网络失败' : '失败')}`
      + ` code=${failure.code || '—'} signal=${failure.signal || '—'}`);
    lines.push(`      error=${failure.detail}`);
    lines.push(`      stderr=${failure.stderrSummary}`);
  }
  lines.push(`尝试记录（${attempts.length} 条）：`);
  for (const attempt of attempts) lines.push(`  · ${attempt}`);
  return lines.join('\n');
}

/** 登记表：`tests/unit/doc-anchor-relocations.json`，缺失/非数组时给出问题而不是静默当空表。 */
function loadRegistry(root) {
  const absolute = join(root, REGISTRY_RELATIVE);
  let raw;
  try {
    raw = readFileSync(absolute, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { entries: [], problems: [`登记表缺失：${REGISTRY_RELATIVE}（应为 JSON 数组，可为空 []）`] };
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { entries: [], problems: [`登记表不是合法 JSON：${firstLine(error.message)}`] };
  }
  if (!Array.isArray(parsed)) return { entries: [], problems: [`登记表必须是 JSON 数组，实际是 ${typeof parsed}`] };
  return { entries: parsed, problems: [] };
}

/** `symbol` 的长度上限：够写下一个函数名／导出名／字段名，又不至于把整段代码塞进登记表。 */
const SYMBOL_MAX_LENGTH = 200;

/**
 * 登记条目 schema（`tests/unit/doc-anchor-relocations.json` 的每一元素）：
 * - `doc` / `line` / `target` / `from` / `to` / `reason` 必填；区间锚点再加 `fromEnd` / `toEnd`；
 * - `kind` 可选，只有两个取值：缺省（＝陈旧锚点重锚，目标文件本提交未改动那一支）或 `"correction"`
 *   （＝纠正本来指错的锚点，两支都可用）；写别的值一律形状错误；
 * - `symbol` 只在 `kind: "correction"` 下必填（1–200 字符、不含换行、非纯空白），缺省 `kind` 时
 *   **必须不出现** —— 半成品登记（想写纠正却漏了 kind）在这里就判红，不许滑到判定阶段再猜。
 *   它是**纯子串匹配**（`String.prototype.includes`，区分大小写、不校验标识符边界）：极短符号
 *   （如 `"e"`）几乎任何行都能命中，实际判别力靠 `reason` 写清该锚点应指的 API + 人工 review；
 *   这里**不**加最小长度阈值 —— 那会引入「多短才算符号」的新语义，而本闸门不判语义。
 */
const REGISTRY_ENTRY_SHAPE = (entry) => {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return '条目不是对象';
  if (typeof entry.doc !== 'string' || entry.doc === '') return 'doc 必须是仓库相对路径字符串';
  if (!Number.isInteger(entry.line) || entry.line < 1) return 'line 必须是正整数（文档在 HEAD 上的行号）';
  if (typeof entry.target !== 'string' || entry.target === '') return 'target 必须是非空字符串';
  if (!Number.isInteger(entry.from) || entry.from < 1) return 'from 必须是正整数';
  if (!Number.isInteger(entry.to) || entry.to < 1) return 'to 必须是正整数';
  if (entry.fromEnd !== undefined && (!Number.isInteger(entry.fromEnd) || entry.fromEnd < entry.from)) {
    return 'fromEnd 必须是 ≥ from 的整数';
  }
  if (entry.toEnd !== undefined && (!Number.isInteger(entry.toEnd) || entry.toEnd < entry.to)) {
    return 'toEnd 必须是 ≥ to 的整数';
  }
  if (typeof entry.reason !== 'string' || entry.reason.trim() === '') return 'reason 必须是非空字符串（写明这条位移为什么合法）';
  if (entry.kind !== undefined && entry.kind !== 'correction') {
    return `kind 只允许缺省（陈旧锚点重锚）或 "correction"（纠正本来指错的锚点），实际是 ${JSON.stringify(entry.kind)}`;
  }
  if (entry.kind === 'correction') {
    if (typeof entry.symbol !== 'string' || entry.symbol.trim() === '') {
      return 'kind="correction" 时 symbol 必填（非空字符串：新行里必须出现的那个符号，用来证明纠正指对了）';
    }
    if (entry.symbol.length > SYMBOL_MAX_LENGTH) {
      return `symbol 长度必须在 1–${SYMBOL_MAX_LENGTH} 字符之间，实际 ${entry.symbol.length}`;
    }
    if (/[\r\n]/.test(entry.symbol)) return 'symbol 不能包含换行（它是符号子串，不是一段代码）';
  } else if (entry.symbol !== undefined) {
    return 'symbol 只在 kind="correction" 下允许出现；缺省 kind 却写了 symbol 是半成品登记'
      + '（要么补 kind: "correction"，要么删掉 symbol）';
  }
  return null;
};

/** 1 基闭区间的行窗口（`end` 缺省时退化为单行）。 */
function lineWindow(lines, start, end) {
  return lines.slice(start - 1, end === undefined ? start : end);
}

/**
 * `kind: "correction"` 的三件验真（缺一即红），通过返回 `null`，否则返回可操作的红文案。
 * ① 新行（区间则整段连起来看）必须含 `symbol`；② 旧行（区间则逐行看）必须**不含** `symbol`；
 * ③ `from !== to`。② 是关键：旧行本来就含该符号 ⇒ 旧锚点本来就指对了，把行号改掉是真回归，
 * 不许用「correction」把它洗成「已登记」。
 */
function correctionViolation({ entry, targetPath, root, base, head, textCache }) {
  const symbol = entry.symbol;
  const span = (start, end) => (end === undefined || end === start ? `:${start}` : `:${start}-${end}`);
  const headLines = readLines(root, head, targetPath, textCache);
  const baseLines = readLines(root, base, targetPath, textCache);
  if (headLines === null || baseLines === null) {
    return `目标文件 ${targetPath} 在 base/HEAD 上缺失，correction 无法验真`;
  }
  if (entry.to > headLines.length || (entry.toEnd !== undefined && entry.toEnd > headLines.length)) {
    return `新行号越界：${targetPath} 在 HEAD 上只有 ${headLines.length} 行`
      + `（to${span(entry.to, entry.toEnd)} 不存在）`;
  }
  if (entry.from > baseLines.length || (entry.fromEnd !== undefined && entry.fromEnd > baseLines.length)) {
    return `旧行号越界：${targetPath} 在 base 上只有 ${baseLines.length} 行`
      + `（from${span(entry.from, entry.fromEnd)} 不存在）`;
  }
  if (entry.from === entry.to && (entry.fromEnd ?? entry.from) === (entry.toEnd ?? entry.to)) {
    return 'from 与 to 相同 ⇒ 旧锚点根本没动，谈不上「把错锚点改到正确行号」，这条登记必须删';
  }
  if (!lineWindow(headLines, entry.to, entry.toEnd).join('\n').includes(symbol)) {
    return `新行 ${targetPath}${span(entry.to, entry.toEnd)} 里找不到 symbol ${JSON.stringify(symbol)}`
      + '（把错锚点机械平移到另一条不含该符号的行，不叫纠正）';
  }
  const oldWindow = lineWindow(baseLines, entry.from, entry.fromEnd);
  const oldHit = oldWindow.findIndex((line) => line.includes(symbol));
  if (oldHit !== -1) {
    return `这不是纠正：旧行 ${targetPath}:${entry.from + oldHit} 已经含 symbol ${JSON.stringify(symbol)}`
      + ' —— 旧锚点本来就指对了，把它的行号改掉是真回归；请删掉这条登记（'
      + '`kind: "correction"` 只能用来修「base 上本来就指错」的锚点）';
  }
  return null;
}

/**
 * 判定核心。全部结论现场重算，不做任何缓存跨调用复用（夹具用例拿同一棵树跑多次不同登记表）。
 * 返回 `{ violations, unresolved, removed, registered, carried, pairs, stats, reason }`：
 * `registered` 只装**本次真正生效**的登记条目；`carried` 装「HEAD 上仍成立、但本次提交的文档改动面
 * 没涉及」的历史条目（不判红，只读数）。
 */
function judge({ root = ROOT, base, head, registry = [], registryProblems = [] }) {
  const violations = registryProblems.map((problem) => `[登记表] ${problem}`);
  const unresolved = [];
  const removed = [];
  const registered = [];
  const carried = [];
  const pairs = [];
  const stats = {
    docFiles: 0, docLines: 0, tokens: 0, pairs: 0, judged: 0,
    // `corrected` 与 `registered` 同口径：**按 token 计**，不是按登记条目计 —— 同一条 correction 被同一
    // 文档行的多个 token 复用（`docFile()` 那种一行两锚点的文档）时各 +1，于是 corrected=2。
    // 它是 `registered` 的子集（纠正也走登记分支），`judgmentBuckets()` 里因此要减掉它再报 `registered`。
    identical: 0, relocated: 0, registered: 0, corrected: 0, carried: 0, removed: 0,
    // 文档 hunk 的三分类（只喂给「扫描面」判定，不参与任何逐 token 判定）：
    // `pureAddHunks` 是 `git diff -U0` 里 `@@ -N,0 +M,K @@` 那种「只新增行、旧侧 0 行」的 hunk ——
    // 它一行都配不出「旧行→新行」，也没进 `removed`（没有任何旧行），所以「本次全是纯新增」的提交
    // 在旧实现里会撞上「扫描面为空」的假红。纯删除型（`newCount === 0`）早就有 `removed` 桶兜着。
    pairedHunks: 0, pureAddHunks: 0, pureDeleteHunks: 0,
  };
  const empty = (reason) => ({ violations, unresolved, removed, registered, carried, pairs, stats, reason });

  if (base === head) return empty('base 与 HEAD 同一提交');

  const changedFiles = new Set(
    git(['diff', '--name-only', '--no-renames', base, head], { cwd: root })
      .split('\n').map((line) => line.trim()).filter(Boolean),
  );
  const docDiff = git(
    ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', `${base}..${head}`, '--', 'docs/'],
    { cwd: root },
  );
  const docFiles = parseDocDiffSinglePass(docDiff);
  stats.docFiles = docFiles.length;
  if (docFiles.length === 0) return empty('没有改动 docs/**');

  // 同名文件索引：文档里经常只写 basename（`openapi.json:1663`）或半截路径
  // （`routes/account-deletion.ts:197`），只认「仓库内唯一命中」才解析，绝不猜。
  const tree = git(['ls-tree', '-r', '--name-only', '-z', head], { cwd: root }).split('\u0000').filter(Boolean);
  const treeSet = new Set(tree);
  const basenameIndex = new Map();
  for (const path of tree) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (!basenameIndex.has(name)) basenameIndex.set(name, []);
    basenameIndex.get(name).push(path);
  }
  const suffixCache = new Map();
  const resolveTargetPath = (raw) => {
    if (raw === null) return null;
    if (treeSet.has(raw)) return raw; // 已是仓库相对路径
    if (!suffixCache.has(raw)) {
      const hits = raw.includes('/')
        ? tree.filter((path) => path.endsWith(`/${raw}`)) // 半截路径：只认唯一后缀
        : basenameIndex.get(raw) ?? []; // 裸文件名：只认唯一同名
      suffixCache.set(raw, hits);
    }
    const hits = suffixCache.get(raw);
    return hits.length === 1 ? hits[0] : null;
  };

  const textCache = new Map();
  const targetHunksCache = new Map();
  const targetHunks = (path) => {
    if (targetHunksCache.has(path)) return targetHunksCache.get(path);
    const hunks = parseHunks(
      git(['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', `${base}..${head}`, '--', path], { cwd: root }),
    );
    targetHunksCache.set(path, hunks);
    return hunks;
  };

  const usedEntries = new Set();
  /** 验真失败的 correction 条目：已经由 token 判定逐条判红过，登记表自验循环不再重复刷屏。 */
  const failedCorrections = new Set();
  /**
   * 登记条目按「一次位移」登记，而不是按「一个 token」登记：同一行里 `path:20` 与紧随其后的裸 `:20`
   * 是同一段位移的两种写法（裸锚点会继承前置路径作为 target），因此**同一条登记可以被同一行的多个
   * token 复用**；`usedEntries` 只用来判「这条登记本次提交是否被用上了」—— 只有**同时**出现在本次
   * `pairs` 里的条目才谈得上冗余（见下面登记表自验真循环），「本次没提它」本身不是判据。
   * 区间锚点 `path:166-168 → path:177`：登记必须带 `fromEnd`/`toEnd`，按两端逐字比对，不接受只对起点。
   * `kinds` 用来把分支收窄：目标文件**有改动**那一支只认 `kind: "correction"`，别的一律不匹配
   * （缺省 kind 的登记在那一支没有逃生口）。
   */
  const matchRegistry = (context, { kinds = null } = {}) => {
    const matchesEndpoint = (token, entryStart, entryEnd) => (
      entryStart === token.start && (token.end === token.start ? entryEnd === undefined : entryEnd === token.end)
    );
    return registry.findIndex((entry) => {
      if (entry === null || typeof entry !== 'object') return false;
      // 形状不合法的条目一律不参与匹配：它会在下面的验真循环里逐条判红，
      // 绝不能靠「匹配上了」把 token 从判定面里搬走（那样形状错误就变成一条静默放行）。
      if (REGISTRY_ENTRY_SHAPE(entry) !== null) return false;
      if (kinds !== null && !kinds.includes(entry.kind)) return false;
      return entry.doc === context.doc
        && entry.line === context.newLineNo
        && (entry.target === context.target || entry.target === context.rawTarget)
        && matchesEndpoint(context.oldToken, entry.from, entry.fromEnd)
        && matchesEndpoint(context.newToken, entry.to, entry.toEnd);
    });
  };

  /**
   * 把命中的登记接住。`kind: "correction"` 先跑三件验真，**不通过就判红且 `corrected` 不加一**
   * （「登记了就算纠正」等于白名单）。返回 `true` 表示这条位移已经被这条登记接住。
   */
  const applyRegistration = ({ registryIndex, label, targetPath }) => {
    const entry = registry[registryIndex];
    if (entry.kind === 'correction') {
      const problem = correctionViolation({ entry, targetPath, root, base, head, textCache });
      if (problem !== null) {
        const firstReport = !failedCorrections.has(registryIndex);
        failedCorrections.add(registryIndex);
        if (firstReport) {
          violations.push(
            `${label} 登记为 kind=correction（symbol ${JSON.stringify(entry.symbol)}），但验真不通过：${problem}`,
          );
        }
        return false;
      }
      stats.corrected += 1;
    }
    usedEntries.add(registryIndex);
    registered.push(
      `${label} — 已登记（${entry.kind === 'correction'
        ? `kind=correction，symbol=${JSON.stringify(entry.symbol)}，${entry.reason}`
        : entry.reason}）`,
    );
    stats.registered += 1;
    return true;
  };

  for (const file of docFiles) {
    for (const hunk of file.hunks) {
      // 先给 hunk 分类（真·扫描面统计，不改判定）：纯新增的 hunk 既配不出行对、也产不出 `removed`，
      // 完全「隐形」—— 正是「纯新增 docs 提交被判扫描面为空」那个假红的根。分类口径按 hunk 头里的
      // 计数走，不按 `oldLines`/`newLines` 数组长度走（`-U0` 下两者本应一致，但以头为准更稳）。
      if (hunk.oldCount === 0 && hunk.newCount > 0) stats.pureAddHunks += 1;
      else if (hunk.newCount === 0) stats.pureDeleteHunks += 1;
      else stats.pairedHunks += 1;
      const { pairs: linePairs, unpairedOld } = pairHunkLines(hunk);
      // 整行被删掉的旧行：它的锚点在新侧彻底消失，既配不上对、也进不了任何判定桶。
      // 这类锚点直接进 `removed`（只观测不判红：正常删文档不该判红，但也不许静默隐身）。
      for (const oldIndex of unpairedOld) {
        for (const oldToken of anchorTokens(hunk.oldLines[oldIndex])) {
          removed.push(
            `${file.path}:${hunk.oldStart + oldIndex} ⟨${oldToken.target ?? '(裸锚点)'} :${oldToken.start}`
            + `${oldToken.end === oldToken.start ? '' : `-${oldToken.end}`}⟩ 整行被删（含锚点）—— `
            + '已删（已知限制：只观测不判红）',
          );
        }
      }
      for (const { oldIndex, newIndex } of linePairs) {
        const oldText = hunk.oldLines[oldIndex];
        const newText = hunk.newLines[newIndex];
        stats.docLines += 1;
        const oldLineNo = hunk.oldStart + oldIndex;
        const newLineNo = hunk.newStart + newIndex;
        const oldTokens = anchorTokens(oldText);
        const newTokens = anchorTokens(newText);
        stats.tokens += oldTokens.length;
        // 按「归属相同 + 出现顺序」配对：同一行里同一个目标文件的第 k 个锚点对第 k 个。
        const usedNew = new Set();
        for (const oldToken of oldTokens) {
          const matchIndex = newTokens.findIndex(
            (newToken, index) => !usedNew.has(index) && newToken.target === oldToken.target,
          );
          if (matchIndex === -1) {
            removed.push(
              `${file.path}:${newLineNo} ⟨${oldToken.target ?? '(裸锚点)'} :${oldToken.start}`
              + `${oldToken.end === oldToken.start ? '' : `-${oldToken.end}`}⟩ 新行里已经没有这个锚点`
              + '（锚点被删／整行被删／换了目标）—— 已知限制：只观测不判红',
            );
            continue;
          }
          usedNew.add(matchIndex);
          const newToken = newTokens[matchIndex];
          stats.pairs += 1;

          let target = resolveTargetPath(oldToken.target);
          let targetLabel = oldToken.target ?? '(裸锚点)';
          // 裸锚点/解析不出/旧行号超出该目标 ⇒ 退回当前文档自身（「全 docs/** 里只命中 :N」这类自指读数）
          if (target === null) {
            target = file.path;
            targetLabel = `${targetLabel} → 退回本文件`;
          } else {
            const targetLines = readLines(root, base, target, textCache);
            if (targetLines === null) {
              unresolved.push(`${file.path}:${newLineNo} ⟨${target}:${oldToken.start}⟩ 目标文件在 base 上不存在，未判`);
              continue;
            }
            if (oldToken.start > targetLines.length) {
              target = file.path;
              targetLabel = `${targetLabel} → 旧行号越界，退回本文件`;
            }
          }

          const oldLines = readLines(root, base, target, textCache);
          const newLines = readLines(root, head, target, textCache);
          if (oldLines === null || newLines === null) {
            unresolved.push(`${file.path}:${newLineNo} ⟨${target}:${oldToken.start}⟩ 目标文件缺失，未判`);
            continue;
          }
          if (oldToken.start > oldLines.length || newToken.start > newLines.length) {
            unresolved.push(
              `${file.path}:${newLineNo} ⟨${target}⟩ 行号越界（旧 ${oldToken.start}/${oldLines.length}、`
              + `新 ${newToken.start}/${newLines.length}），未判`,
            );
            continue;
          }

          const changed = changedFiles.has(target);
          const label = `${file.path}:${newLineNo} ⟨${targetLabel} :${oldToken.start}`
            + `${oldToken.end === oldToken.start ? '' : `-${oldToken.end}`} → :${newToken.start}`
            + `${newToken.end === newToken.start ? '' : `-${newToken.end}`}⟩`;
          const oldTextAtAnchor = oldLines[oldToken.start - 1];
          const newTextAtAnchor = newLines[newToken.start - 1];
          pairs.push({
            doc: file.path,
            line: newLineNo,
            oldLine: oldLineNo,
            target,
            rawTarget: oldToken.target,
            from: oldToken.start,
            to: newToken.start,
          });

          if (!changed) {
            if (newToken.start !== oldToken.start || newToken.end !== oldToken.end) {
              const context = {
                doc: file.path, newLineNo, target, rawTarget: oldToken.target, oldToken, newToken,
              };
              const registryIndex = matchRegistry(context, { kinds: [undefined, 'correction'] });
              if (registryIndex !== -1
                && applyRegistration({ registryIndex, label, targetPath: target })) {
                continue;
              }
              violations.push(
                `${label} 目标文件本提交未改动 ⇒ 行号必须恒等，但被改成 :${newToken.start}`
                + `${newToken.end === newToken.start ? '' : `-${newToken.end}`}`
                + '（真要把陈旧锚点改到正确行号，必须在 '
                + `${REGISTRY_RELATIVE} 里登记 doc/line/target/from/to/reason）\n`
                + `        旧行原文（${target}:${oldToken.start}）：${JSON.stringify(oldTextAtAnchor)}\n`
                + `        新行实际（${target}:${newToken.start}）：${JSON.stringify(newTextAtAnchor)}`,
              );
              continue;
            }
            stats.identical += 1;
          } else {
            // 目标文件本提交有改动：先看有没有 `kind: "correction"` 登记接住它。旧锚点在 base 上本来就
            // 指错时，端点映射只会把错误原样搬到新行号 —— 这一支必须留一条「改到正确行号」的整改通道。
            const correctionIndex = matchRegistry(
              { doc: file.path, newLineNo, target, rawTarget: oldToken.target, oldToken, newToken },
              { kinds: ['correction'] },
            );
            if (correctionIndex !== -1) {
              // 命中即由这条登记负责到底：验真通过 ⇒ 计入 registered/corrected 并跳过端点映射；
              // 验真不过 ⇒ applyRegistration 已经判红，这里不再叠一条端点映射文案（同一处只报一次）。
              applyRegistration({ registryIndex: correctionIndex, label, targetPath: target });
              continue;
            }
            const hunks = targetHunks(target);
            const mappedStart = relocationMap(hunks, oldToken.start);
            const mappedEnd = relocationMap(hunks, oldToken.end);
            if (mappedStart === undefined || (oldToken.end !== oldToken.start && mappedEnd === undefined)) {
              unresolved.push(`${label} 旧行落在该文件被改写的区内，无法判定位移，未判`);
              continue;
            }
            if (newToken.start !== mappedStart || (oldToken.end !== oldToken.start && newToken.end !== mappedEnd)) {
              violations.push(
                `${label} 目标文件本提交有改动 ⇒ 行号必须落在这个文件自己的端点映射上：`
                + `起 ${oldToken.start}→${mappedStart}（文档写 ${newToken.start}）`
                + (oldToken.end === oldToken.start ? '' : `；止 ${oldToken.end}→${mappedEnd}（文档写 ${newToken.end}）`),
              );
              continue;
            }
            if (oldTextAtAnchor !== newTextAtAnchor) {
              violations.push(
                `${label} 位移量对得上，但行原文不同（锚点指的已经不是同一段内容）\n`
                + `        旧行原文（${target}:${oldToken.start}）：${JSON.stringify(oldTextAtAnchor)}\n`
                + `        新行实际（${target}:${newToken.start}）：${JSON.stringify(newTextAtAnchor)}`,
              );
              continue;
            }
            stats.relocated += 1;
          }

          if (oldTextAtAnchor !== newTextAtAnchor) {
            violations.push(
              `${label} 旧行原文 !== 新行原文\n`
              + `        旧行原文（${target}:${oldToken.start}）：${JSON.stringify(oldTextAtAnchor)}\n`
              + `        新行实际（${target}:${newToken.start}）：${JSON.stringify(newTextAtAnchor)}`,
            );
            continue;
          }
          stats.judged += 1;
        }
      }
    }
  }

  // 登记表自身验真：判的是「HEAD 上是否仍成立」（历史事实登记），**不是**「本次 diff 里有没有这条位移」。
  // 陈旧条目（HEAD 上站不住）与冗余条目（本次自己就能判出这条位移）判红并点名；其余 HEAD 上仍成立、
  // 本次没涉及的条目进 `carried`（历史保留，只读数不判红）。登记表仍不许变成白名单垃圾桶。
  for (let index = 0; index < registry.length; index += 1) {
    const entry = registry[index];
    const shapeError = REGISTRY_ENTRY_SHAPE(entry);
    if (shapeError !== null) {
      violations.push(`[登记表] 第 ${index + 1} 条形状错误：${shapeError}`);
      continue;
    }
    const label = `[登记表] 第 ${index + 1} 条 ⟨${entry.doc}:${entry.line} ${entry.target} :${entry.from} → :${entry.to}⟩`;
    if (entry.from === entry.to) {
      violations.push(`${label} 陈旧：from 与 to 相同，不可能对应任何位移，必须删`);
      continue;
    }
    const docLines = readLines(root, head, entry.doc, textCache);
    if (docLines === null) {
      violations.push(`${label} 陈旧：${entry.doc} 在 HEAD 上不存在`);
      continue;
    }
    if (entry.line > docLines.length) {
      violations.push(`${label} 陈旧：${entry.doc} 在 HEAD 上只有 ${docLines.length} 行`);
      continue;
    }
    const resolvedEntryTarget = resolveTargetPath(entry.target) ?? entry.target;
    const hitNewAnchor = anchorTokens(docLines[entry.line - 1]).some(
      (token) => token.start === entry.to && token.end === (entry.toEnd ?? entry.to)
        && (token.target === null
          || token.target === entry.target
          || resolveTargetPath(token.target) === resolvedEntryTarget),
    );
    if (!hitNewAnchor) {
      violations.push(
        `${label} 陈旧：${entry.doc}:${entry.line} 里已经没有 ⟨${entry.target} :${entry.to}⟩ 这个锚点（新行号不命中）`,
      );
      continue;
    }
    const headTargetLines = readLines(root, head, resolvedEntryTarget, textCache);
    const baseTargetLines = readLines(root, base, resolvedEntryTarget, textCache);
    if (headTargetLines === null || baseTargetLines === null) {
      violations.push(`${label} 陈旧：目标文件 ${resolvedEntryTarget} 在 base/HEAD 上缺失`);
      continue;
    }
    if (entry.to > headTargetLines.length) {
      violations.push(
        `${label} 陈旧：${resolvedEntryTarget} 在 HEAD 上只有 ${headTargetLines.length} 行（新行号不命中）`,
      );
      continue;
    }
    if (entry.from > baseTargetLines.length) {
      violations.push(`${label} 陈旧：${resolvedEntryTarget} 在 base 上只有 ${baseTargetLines.length} 行`);
      continue;
    }
    if (entry.fromEnd !== undefined && entry.fromEnd > baseTargetLines.length) {
      violations.push(`${label} 陈旧：${resolvedEntryTarget} 在 base 上只有 ${baseTargetLines.length} 行（fromEnd 越界）`);
      continue;
    }
    if (entry.toEnd !== undefined && entry.toEnd > headTargetLines.length) {
      violations.push(`${label} 陈旧：${resolvedEntryTarget} 在 HEAD 上只有 ${headTargetLines.length} 行（toEnd 越界）`);
      continue;
    }
    if (baseTargetLines[entry.from - 1] === headTargetLines[entry.to - 1]
      && (entry.fromEnd === undefined || entry.toEnd === undefined
        || baseTargetLines[entry.fromEnd - 1] === headTargetLines[entry.toEnd - 1])) {
      violations.push(
        `${label} 陈旧：${resolvedEntryTarget}:${entry.from} 与 :${entry.to} 的原文相同`
        + '（旧锚点本来就指对了），这条登记没有意义，必须删',
      );
      continue;
    }
    // 「本次提交的文档改动面里有没有这条位移」**不是**登记条目合法性的依据：登记条目是历史事实登记，
    // 只在引入它的那次提交被举证一次；之后每个改过 docs 的提交都会重新验一遍，而那条位移早已落在 base
    // 里、当然不在 `base..HEAD` 的文档改动面里。拿 `pairs` 当硬要求（历史实现）等于：谁修掉一个跨提交
    // 漂移的旧锚点，下一个**无关**的 docs 提交就会因为它判红 —— `upstream/main` 上真实发生过。
    // 现在只有两种结局：① 冗余（本次改动面里确实出现了这条位移，且登记没被用上 ⇒ 多余/重复，必须删）；
    // ② 历史保留（HEAD 上仍成立、本次没涉及 ⇒ 进 `carried` 读数，不判红）。
    // 本次真正生效的条目（`usedEntries`）已经在 `registered` 里逐条点名了，不再进任何别的桶。
    // `kind: "correction"` 在这里再跑一遍三件验真：它是整改通道而不是白名单 —— 通不过就判红，
    // `corrected` 只在通过后 +1（见 `applyRegistration`）。已经被 token 判定判过红的条目不重复刷屏。
    if (entry.kind === 'correction') {
      if (failedCorrections.has(index)) continue;
      const correctionProblem = correctionViolation({
        entry, targetPath: resolvedEntryTarget, root, base, head, textCache,
      });
      if (correctionProblem !== null) {
        failedCorrections.add(index);
        violations.push(`${label} correction 验真不通过：${correctionProblem}`);
        continue;
      }
    }
    if (usedEntries.has(index)) continue;
    const sameRelocation = pairs.find(
      (pair) => pair.doc === entry.doc && pair.line === entry.line
        && pair.from === entry.from && pair.to === entry.to
        && (pair.target === resolvedEntryTarget || pair.rawTarget === entry.target),
    );
    if (sameRelocation !== undefined) {
      const hunks = targetHunks(resolvedEntryTarget);
      const mappedStart = relocationMap(hunks, entry.from);
      const mappedEnd = entry.fromEnd === undefined ? mappedStart : relocationMap(hunks, entry.fromEnd);
      const mappingJudgesIt = changedFiles.has(resolvedEntryTarget)
        && mappedStart !== undefined && mappedEnd !== undefined;
      violations.push(
        mappingJudgesIt
          ? `${label} 冗余：目标文件本提交有改动，端点映射已经能判这条位移`
            + `（:${entry.from}→:${mappedStart}），不需要登记，必须删`
          : `${label} 冗余：这条位移本次提交的文档改动面里已经有了，而这条登记没被用上`
            + '（重复登记，或已被另一条登记接住），必须删',
      );
      continue;
    }
    carried.push(
      `${label} — 历史保留（HEAD 上仍成立，本次提交的文档改动面没有涉及它）`
      + `${entry.kind === 'correction' ? `（kind=correction，symbol=${JSON.stringify(entry.symbol)}）` : ''}`
      + `：${entry.reason}`,
    );
  }

  stats.registered = registered.length;
  stats.carried = carried.length;
  stats.removed = removed.length;
  return { violations, unresolved, removed, registered, carried, pairs, stats, reason: null };
}

/** 判定摘要：绿的时候也要把扫描面、判定量、已登记、历史保留、已删都打出来，避免「判了 0 条」冒充「全对」。 */
function summarize(result, baseLabel) {
  const { stats } = result;
  return `base=${baseLabel} documented files=${stats.docFiles} docLines=${stats.docLines} `
    + `tokens=${stats.tokens} pairs=${stats.pairs} judged=${stats.judged} `
    + `identical=${stats.identical} relocated=${stats.relocated} registered=${stats.registered} `
    + `corrected=${stats.corrected} `
    + `carried=${stats.carried} removed=${stats.removed} unresolved=${result.unresolved.length} `
    // hunk 三分类：`add` 是纯新增（旧侧 0 行）、`del` 是纯删除（新侧 0 行）、`pair` 是两侧都非空。
    // 「全是纯新增」⇒ 本次没有位移面，主用例会显式 SKIP（读数里能一眼看出是哪种 SKIP）。
    + `hunks(pair=${stats.pairedHunks} add=${stats.pureAddHunks} del=${stats.pureDeleteHunks})`;
}

/**
 * 主判据「零违规」抽成 helper，唯一理由是让它自己也被钉住。
 * 先前这条断言直接写在主用例里：把那一行换成 `assert.ok(true)` 就能让整条闸门永久变绿，
 * 而没有任何用例会红（审查方把这种口子记为「一键关闸」）。夹具里有一条用例断言它会抛。
 */
function assertNoViolations(result, summary = '') {
  assert.deepEqual(
    result.violations,
    [],
    `锚点位移恒等失败 ${result.violations.length} 条${summary === '' ? '' : `（${summary}）`}：\n`
    + result.violations.map((item, index) => `  ${index + 1}. ${item}`).join('\n'),
  );
}

/**
 * 判空自证用的五个桶，抽成 helper 的唯一理由同样是让它自己也被钉住。
 * **`registered` 必须算进来**：登记命中走的也是 `continue`（登记分支），不进 `judged`；
 * 漏算它会让「目标文件本提交未改 + 只把文档行号重锚到正确新值 + 逐字登记一条」这种
 * **最小修复提交**撞上「扫描面为空」的假红——而那恰好是本闸门存在的理由（B1，审查实测：
 * `扫描面为空：抽到 1 个锚点，却没有任何一个进入判定桶（判定 0／已删 0／未判 0／判红 0）`）。
 * **`corrected` 同理会漏**（`kind: "correction"` 走的也是登记分支）：只靠 correction 落地的提交
 * 必须照样算进 `total`，否则同一个 B1 假红会在新的整改通道上重演一遍。
 */
function judgmentBuckets(result) {
  const { stats } = result;
  const buckets = {
    judged: stats.judged,
    removed: stats.removed,
    unresolved: result.unresolved.length,
    violations: result.violations.length,
    // `corrected` 是 `registered` 的子集（纠正也走登记分支），这里拆开单列，避免同一处位移被数两遍。
    registered: result.registered.length - stats.corrected,
    corrected: stats.corrected,
  };
  buckets.total = buckets.judged + buckets.removed + buckets.unresolved
    + buckets.violations + buckets.registered + buckets.corrected;
  return buckets;
}

/**
 * 「本次文档改动面全是纯新增」判据（本片修的那个假红的核心）：三个条件缺一不可 ——
 * 有纯新增 hunk、没有任何配得上「旧行→新行」的 hunk、也没有任何纯删除 hunk。
 * 只要掺进另外两类中的任意一个，本次提交就确实有「旧行」可比，必须走正常判定（A4 钉住这一点）。
 */
function appendOnlyDocDiff(stats) {
  return stats.pureAddHunks > 0 && stats.pairedHunks === 0 && stats.pureDeleteHunks === 0;
}

/**
 * 扫描面裁决，纯函数，返回 `{ kind: 'ok' | 'skip' | 'fail', message }` —— 主用例与末尾 A1–A5 常驻夹具
 * 共用同一份判断（否则夹具只能钉住「我以为的」判定，而不是主用例真跑的那份）。
 * - `skip`：本次提交**没有**位移面可言，显式 SKIP 并带可区分的读数，绝不静默记成 PASS。两种形状：
 *   ① 全是纯新增 hunk（`@@ -N,0 +M,K @@`，一行都配不出来，也没有旧行进 `removed`）；
 *   ② 配出了行对但一个锚点都没抽到（纯散文改动）。② 的「SKIP 而不是硬红」是既有约定
 *   （本文件「已知限制之三 ⑤」），本片**没有**改它的方向。
 * - `fail`：diff 非空却既配不出行对、也没有 `removed`（硬红文案里带上纯新增 hunk 数，便于与 ① 区分），
 *   或者抽到了锚点却一条都没进桶 —— 这两种都是「判了 0 条却全绿」的静默漏洞。
 * - `ok`：有真实判定面，交给后续 `assertNoViolations` 判红绿。
 */
function scanSurfaceDecision(result) {
  const { stats } = result;
  const buckets = judgmentBuckets(result);
  if (stats.docFiles === 0) {
    return { kind: 'fail', message: '扫描面为空：没有任何被改写的文档' };
  }
  if (appendOnlyDocDiff(stats)) {
    return {
      kind: 'skip',
      message: `本次文档提交只有新增行，没有锚点位移面（${stats.pureAddHunks} 个纯新增 hunk）`,
    };
  }
  if (stats.docLines === 0 && buckets.total === 0) {
    return {
      kind: 'fail',
      // `buckets.total` 里已经算上 `removed`/`unresolved`/`violations`/`registered`：纯删除型文档提交
      // 配不出任何行对，但它的锚点落在 `removed` 桶里（`total > 0`）⇒ 有扫描面、不许红。
      // 只有「一行都对不上、也没有任何桶接过任何东西」才是真的什么都没解析出来 ⇒ 硬红。
      message: '扫描面为空：既没有配对出任何「旧行→新行」的文档行对，也没有任何被整行删掉/'
        + `换锚点的旧行（docLines ${stats.docLines}／removed ${result.removed.length}／`
        + `其中有 ${stats.pureAddHunks} 个纯新增 hunk）`,
    };
  }
  if (stats.tokens === 0 && buckets.total === 0) {
    return {
      kind: 'skip',
      message: '被改写的文档行里没有任何锚点（tokens=0），本次改动不含任何行号引用，本用例无判定面',
    };
  }
  if (buckets.total === 0) {
    return {
      kind: 'fail',
      message: `扫描面为空：抽到 ${stats.tokens} 个锚点，却没有任何一个进入判定桶（判定 ${buckets.judged}／`
        + `已删 ${buckets.removed}／未判 ${buckets.unresolved}／判红 ${buckets.violations}／`
        + `已登记 ${buckets.registered}／纠正 ${buckets.corrected}）`,
    };
  }
  return { kind: 'ok', message: '' };
}

/** 「已登记」明细块：主用例读数与 B1 回归夹具共用，保证两边看到的是同一句话。 */function registeredDetail(result) {
  return result.registered.length === 0
    ? ''
    : `；已登记：\n${result.registered.map((item) => `    - ${item}`).join('\n')}`;
}

test('文档锚点位移恒等：目标文件没改 ⇒ 行号恒等（陈旧锚点必须走登记表）；改了 ⇒ 必须落在这个文件自己的端点映射上，且旧行原文 === 新行原文', (t) => {
  let head;
  try {
    head = git(['rev-parse', 'HEAD']).trim();
  } catch (error) {
    const detail = String(error.stderr ?? error.message);
    if (HISTORY_ERROR.test(detail)) {
      t.skip(`SKIP: 无 base 历史，本用例未执行 —— 连 HEAD 都读不到：${firstLine(detail)}`);
      return;
    }
    throw error;
  }

  const attempts = [];
  let resolved = resolveBase(ROOT);
  attempts.push(...resolved.attempts);
  let baseLabel = resolved.label;
  if (resolved.sha === null) {
    if (!isCi()) {
      t.skip(
        'SKIP: 无 base 历史，本用例未执行 —— 非 CI 环境不做自愈 fetch；'
        + `本地浅克隆请 git fetch --unshallow 后重跑。尝试记录：${attempts.join('；')}`,
      );
      return;
    }
    const heal = selfHealBase(ROOT, attempts);
    if (heal.resolved !== null) {
      resolved = heal.resolved;
      baseLabel = `${resolved.label}（CI 自愈 fetch 后取到 base）`;
    } else {
      const shallow = isShallowRepository(ROOT);
      // 文案与「SKIP 还是硬失败」都交给 `selfHealDeadEnd()`：只有 fetch **全部失败**才说
      // 「网络取 base 失败」；有任何一招 fetch 跑通就只说「fetch 成功但取不到共同祖先」——
      // 第一版在这里说反过（超时被当 no-base，文案却写「fetch 成功」），见 `classifyFetchFailure` 注释。
      const deadEnd = selfHealDeadEnd(heal, shallow);
      t.diagnostic(fetchDiagnosticOf(heal, attempts, shallow));
      if (deadEnd.action === 'skip') {
        t.skip(deadEnd.message);
        return;
      }
      throw new Error(deadEnd.message);
    }
  }

  const base = resolved.sha;
  if (base === head) {
    // base 与 HEAD 同一提交 ⇒ 没有任何位移面可判。CI 里这可能是浅克隆退化的结果（显式 SKIP 并打印原因）；
    // 非 CI 下拿到这种 base 说明取 base 的逻辑坏了（例如被强行改成 HEAD），**必须硬失败**，
    // 否则「把 resolveBase 改成 return HEAD」就足以让整条闸门永久变绿。
    if (isCi()) {
      t.skip(`SKIP: base 与 HEAD 同一提交（${baseLabel} → ${base.slice(0, 12)}），没有可判定的位移面`);
      return;
    }
    assert.notEqual(
      base,
      head,
      `base 与 HEAD 同一提交（${baseLabel}），本用例没有判定面却也不是 CI 浅克隆 —— `
      + '取 base 的逻辑有问题，不允许静默通过',
    );
  }

  const registry = loadRegistry(ROOT);
  const result = judge({ root: ROOT, base, head, registry: registry.entries, registryProblems: registry.problems });
  if (result.reason !== null) {
    t.skip(`SKIP: ${base.slice(0, 12)}..${head.slice(0, 12)} ${result.reason}，本用例无判定面`);
    return;
  }

  // 扫描面自证：防「扫到 0 条 ⇒ 全绿」。裁决抽进 `scanSurfaceDecision()`，让末尾 A1–A5 常驻夹具
  // 钉住的就是主用例**真跑的那一份**判断，而不是另写一份「我以为的」判定：
  // - 全是纯新增 hunk ⇒ 本次提交根本没有位移面（新增行没有「旧行号」可比），显式 SKIP 并报出数量；
  // - 配出了行对、但一个锚点都没抽到（纯散文改动）⇒ 显式 SKIP（既有约定，见「已知限制之三 ⑤」）；
  // - 其余「diff 非空却连一个桶都没进」的形状 ⇒ 硬红，文案里带纯新增 hunk 数以便与上面区分。
  // 判红/已登记也必须算进桶：判红与登记分支在 `continue` 之前不进 `judged`，漏算会让「确有违规」
  // 反而先撞上自证断言，把真正的违规清单埋在一条误导性信息后面（B1 的教训）。
  const shortRange = `${base.slice(0, 12)}..${head.slice(0, 12)}`;
  const decision = scanSurfaceDecision(result);
  if (decision.kind === 'skip') {
    t.skip(`SKIP: ${shortRange} ${decision.message}`);
    return;
  }
  // `fail` 与「有判定面、可能判红」都往下走：`fail` 在下一行直接红，文案原样带出扫描面读数。
  assert.equal(decision.kind, 'ok', `${shortRange} ${decision.message}`);

  const summary = summarize(result, `${base.slice(0, 12)}（${baseLabel}）`);
  const detail = [
    `；登记表 ${registry.entries.length} 条：本次生效 ${result.registered.length} 个 token`
    + `（其中 kind=correction ${result.stats.corrected} 个）、`
    + `历史保留 ${result.carried.length} 条（历史条目只要求「HEAD 上仍成立」，不要求本提交再举证一次）`,
    result.registered.length === 0 ? '' : registeredDetail(result),
    result.carried.length === 0 ? '' : `；历史保留（不判红，逐条可审）：\n${result.carried.map((item) => `    - ${item}`).join('\n')}`,
    `；未判（不可解析，不冒充通过）${result.unresolved.length} 条`,
    result.unresolved.length === 0 ? '' : `：\n${result.unresolved.map((item) => `    - ${item}`).join('\n')}`,
    `；已删/换目标（已知限制：只观测不判红）${result.removed.length} 条`,
    result.removed.length === 0 ? '' : `：\n${result.removed.map((item) => `    - ${item}`).join('\n')}`,
  ].join('');
  t.diagnostic(`${summary}${detail}`);
  assertNoViolations(result, summary);
});

// ───────────────────────── 变异夹具：判别力自证 ─────────────────────────
// 下面这批用例不依赖本仓库历史（自己建临时仓库），所以任何环境都会真跑。
// 形态刻意做成**真实位移**：同一个提交里既改目标文件的行数（上方插 n 行），又平移文档锚点。

const FIXTURE_TARGET = 'src/service.mjs';
const FIXTURE_DOC = 'docs/notes.md';
/** 夹具数据（不是判定阈值）：夹具目标文件里「被锚定的那一行」的原始行号。 */
const FIXTURE_ANCHOR_LINE = 20;
const FIXTURE_MARKER = "export const MARKER = '锚点目标行';";

function serviceFile({ insertAbove = 0 } = {}) {
  const top = Array.from({ length: insertAbove }, (_, index) => `// 顶部新增占位行 ${index + 1}`);
  const body = Array.from({ length: 40 }, (_, index) => (
    index + 1 === FIXTURE_ANCHOR_LINE ? FIXTURE_MARKER : `export const value${index + 1} = ${index + 1};`
  ));
  return `${[...top, ...body].join('\n')}\n`;
}

function docFile({ anchor, note = '' }) {
  return `# 夹具\n\n- 落点：\`${FIXTURE_TARGET}:${anchor}\`（裸锚点 :${anchor}）${note}\n`;
}

/**
 * C 组（`kind: "correction"`）夹具用的目标文件：与 `serviceFile()` 同构的 40 行正文，
 * 但允许按 **base 的 1 基行号** 覆盖任意行内容 —— 纠正夹具需要「旧行/新行各自含不含某个符号」
 * 这种精确形状，用 `serviceFile()` 的固定标记行拼不出来。
 */
function targetFile({ insertAbove = 0, overrides = {} } = {}) {
  const top = Array.from({ length: insertAbove }, (_, index) => `// 顶部新增占位行 ${index + 1}`);
  const body = Array.from({ length: 40 }, (_, index) => (
    overrides[index + 1] ?? `export const value${index + 1} = ${index + 1};`
  ));
  return `${[...top, ...body].join('\n')}\n`;
}

/** 夹具文档里带锚点的那一行在 HEAD 上的行号（登记表要写它）。 */
function anchorDocLine(text) {
  return text.split('\n').findIndex((line) => anchorTokens(line).length > 0) + 1;
}

/**
 * 「历史保留」夹具用的第二份文档：本提交一个字都不改它，但它的锚点在 HEAD 上仍然成立。
 * 形态对齐真实登记表里那种「引入它的提交早就举证过、之后每提交都会重新看到」的条目。
 */
const FIXTURE_LEGACY_DOC = 'docs/legacy-status.md';

function legacyDocFile({ anchor }) {
  return `# 历史台账（本提交不涉及）\n\n- 旧台账：\`${FIXTURE_TARGET}:${anchor}\`\n`;
}

/**
 * 建一个临时 git 仓库：`base` 提交冻结基线，`head` 提交放变异，再补上 `refs/remotes/origin/main`
 * 让 `git merge-base HEAD origin/main` 能落到 base 上。
 * 目录是 `mkdtempSync` 现建的唯一路径（不含联接/重解析点），`t.after` 只按这个绝对路径删自己建的东西。
 */
function fixtureRepo(t, { baseFiles, headFiles, message = 'head' }) {
  const root = mkdtempSync(join(tmpdir(), 'doc-anchor-fixture-'));
  t.after(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不影响判定结论
    }
  });
  const run = (args) => git(args, { cwd: root });
  run(['init', '-q', '-b', 'main']);
  const commit = (snapshot, commitMessage) => {
    for (const [relative, content] of Object.entries(snapshot)) {
      const absolute = join(root, relative);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content, 'utf8');
    }
    run(['add', '-A']);
    run(['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-q', '-m', commitMessage]);
    return run(['rev-parse', 'HEAD']).trim();
  };
  const base = commit(baseFiles, 'base');
  run(['update-ref', 'refs/remotes/origin/main', base]);
  const head = commit(headFiles, message);
  return { root, base, head };
}

test('变异夹具：同一提交里目标文件上方插行 + 锚点按位移量正确平移 ⇒ 绿', (t) => {
  const insertAbove = 4;
  const shifted = FIXTURE_ANCHOR_LINE + insertAbove;
  const repo = fixtureRepo(t, {
    baseFiles: {
      [FIXTURE_TARGET]: serviceFile(),
      [FIXTURE_DOC]: docFile({ anchor: FIXTURE_ANCHOR_LINE }),
    },
    headFiles: {
      [FIXTURE_TARGET]: serviceFile({ insertAbove }),
      [FIXTURE_DOC]: docFile({ anchor: shifted }),
    },
  });
  const result = judge({ root: repo.root, base: repo.base, head: repo.head });
  assert.deepEqual(result.violations, []);
  assert.ok(result.stats.judged > 0, '夹具没有判定任何锚点，判别力不成立');
  assert.ok(result.stats.relocated > 0, '夹具里没有发生「目标文件改动后的重定位」，判别力不成立');
  assert.equal(result.registered.length, 0, '这条位移不需要登记表');
  t.diagnostic(`夹具（正确平移）${summarize(result, 'fixture')}`);
});

test('变异夹具：目标文件插行后锚点漏平移 ⇒ 红（点名仍指向旧行号）', (t) => {
  const insertAbove = 4;
  const repo = fixtureRepo(t, {
    baseFiles: {
      [FIXTURE_TARGET]: serviceFile(),
      [FIXTURE_DOC]: docFile({ anchor: FIXTURE_ANCHOR_LINE }),
    },
    headFiles: {
      [FIXTURE_TARGET]: serviceFile({ insertAbove }),
      // 文档行被改写（更新了说明文字），但锚点原地不动 —— 正是「漏平移」的真实形态。
      [FIXTURE_DOC]: docFile({ anchor: FIXTURE_ANCHOR_LINE, note: '（本提交只更新了说明文字）' }),
    },
  });
  const result = judge({ root: repo.root, base: repo.base, head: repo.head });
  assert.ok(result.violations.length > 0, '漏平移竟然判绿：判别力不成立');
  assert.match(result.violations.join('\n'), /端点映射/);
  t.diagnostic(`夹具（漏平移）判红 ${result.violations.length} 条`);
});

test('变异夹具：目标文件插行后锚点按错的平移量改 ⇒ 红', (t) => {
  const insertAbove = 4;
  const wrong = FIXTURE_ANCHOR_LINE + insertAbove - 2;
  const repo = fixtureRepo(t, {
    baseFiles: {
      [FIXTURE_TARGET]: serviceFile(),
      [FIXTURE_DOC]: docFile({ anchor: FIXTURE_ANCHOR_LINE }),
    },
    headFiles: {
      [FIXTURE_TARGET]: serviceFile({ insertAbove }),
      [FIXTURE_DOC]: docFile({ anchor: wrong }),
    },
  });
  const result = judge({ root: repo.root, base: repo.base, head: repo.head });
  assert.ok(result.violations.length > 0, '错平移竟然判绿：判别力不成立');
  assert.match(result.violations.join('\n'), /端点映射/);
  t.diagnostic(`夹具（错平移）判红 ${result.violations.length} 条`);
});

test('已知限制（不是正确语义）：锚点被整行删掉时不判红，但必须可观测地进 removed 桶并计数', (t) => {
  // 判红会误伤正常删除（删锚点往往正是「这段引用不再需要」），所以这里只要求可观测：
  // removed 桶必须逐条列出被删掉的锚点、stats.removed 必须计数。这条用例钉住当前行为，
  // 以后要改成「删锚点必须登记」时，先改这里。
  const repo = fixtureRepo(t, {
    baseFiles: {
      [FIXTURE_TARGET]: serviceFile(),
      [FIXTURE_DOC]: docFile({ anchor: FIXTURE_ANCHOR_LINE }),
    },
    headFiles: {
      [FIXTURE_TARGET]: serviceFile(),
      [FIXTURE_DOC]: '# 夹具\n\n- 落点：见上一节（本提交把路径锚点与裸锚点都删了）\n',
    },
  });
  const result = judge({ root: repo.root, base: repo.base, head: repo.head });
  assert.deepEqual(result.violations, [], '已知限制：删除锚点当前不判红');
  assert.ok(result.removed.length > 0, '删除锚点必须进 removed 桶并逐条可读，不许静默通过');
  assert.equal(result.stats.removed, result.removed.length);
  assert.ok(result.stats.judged === 0, '夹具里本来就没有可比对的新锚点');
  t.diagnostic(`夹具（删锚点）removed=${result.stats.removed} 条（已知限制，只观测）`);
});

test('登记表：目标文件未改、旧锚点本就指错 ⇒ 逐字登记后降级为「已登记」，不登记则默认红', (t) => {
  // 目标文件 base/HEAD 逐字节相同；文档里那条锚点本来就指错了（指到标记行下面一行），
  // 本提交把它改到正确行 —— 这是「目标没改但行号变了」的唯一合法动机。
  const wrongOldAnchor = FIXTURE_ANCHOR_LINE + 1;
  const headDoc = docFile({ anchor: FIXTURE_ANCHOR_LINE });
  const repo = fixtureRepo(t, {
    baseFiles: {
      [FIXTURE_TARGET]: serviceFile(),
      [FIXTURE_DOC]: docFile({ anchor: wrongOldAnchor }),
    },
    headFiles: { [FIXTURE_TARGET]: serviceFile(), [FIXTURE_DOC]: headDoc },
  });

  const withoutRegistry = judge({ root: repo.root, base: repo.base, head: repo.head });
  assert.ok(withoutRegistry.violations.length > 0, '目标文件未改 + 行号变了，默认必须红');

  const withRegistry = judge({
    root: repo.root,
    base: repo.base,
    head: repo.head,
    registry: [{
      doc: FIXTURE_DOC,
      line: anchorDocLine(headDoc),
      target: FIXTURE_TARGET,
      from: wrongOldAnchor,
      to: FIXTURE_ANCHOR_LINE,
      reason: '夹具：旧锚点本来就指错（指到标记行下面一行），本提交按符号重锚到正确行',
    }],
  });
  assert.deepEqual(withRegistry.violations, []);
  assert.ok(withRegistry.registered.length > 0, '逐字匹配的登记条目必须生效');
  assert.equal(withRegistry.stats.registered, withRegistry.registered.length);
  for (const message of withRegistry.registered) assert.match(message, /已登记/);
  t.diagnostic(`夹具（登记生效 ${withRegistry.registered.length} 个 token / 1 条登记）${withRegistry.registered[0]}`);
});

test('登记表：陈旧条目（旧==新 / 新行号不命中 / 文档行不存在）必须判红并点名；本次没涉及但 HEAD 上仍成立的条目只进「历史保留」读数', (t) => {
  const insertAbove = 4;
  const shifted = FIXTURE_ANCHOR_LINE + insertAbove;
  const headDoc = docFile({ anchor: shifted });
  const legacyDoc = legacyDocFile({ anchor: shifted });
  const repo = fixtureRepo(t, {
    baseFiles: {
      [FIXTURE_TARGET]: serviceFile(),
      [FIXTURE_DOC]: docFile({ anchor: FIXTURE_ANCHOR_LINE }),
      [FIXTURE_LEGACY_DOC]: legacyDoc,
    },
    headFiles: {
      [FIXTURE_TARGET]: serviceFile({ insertAbove }),
      [FIXTURE_DOC]: headDoc,
      [FIXTURE_LEGACY_DOC]: legacyDoc,
    },
  });
  const line = anchorDocLine(headDoc);
  const result = judge({
    root: repo.root,
    base: repo.base,
    head: repo.head,
    registry: [
      { doc: FIXTURE_DOC, line, target: FIXTURE_TARGET, from: FIXTURE_ANCHOR_LINE, to: FIXTURE_ANCHOR_LINE, reason: '陈旧：from 与 to 相同' },
      { doc: FIXTURE_DOC, line, target: FIXTURE_TARGET, from: FIXTURE_ANCHOR_LINE, to: 9999, reason: '陈旧：新行号不存在' },
      { doc: FIXTURE_DOC, line: 9999, target: FIXTURE_TARGET, from: FIXTURE_ANCHOR_LINE, to: shifted, reason: '陈旧：文档行不存在' },
      // **有意的语义变更（GY-R68）**：这一条在历史实现里靠「本次提交的文档改动面里没有这条位移」判红。
      // 那条规则本身就是缺陷 —— 它让「修一个跨提交漂移的旧锚点」之后、任何无关的 docs 提交都判红。
      // 现在它 HEAD 上仍成立（doc 行还在、仍含 ⟨target :to⟩、base[from] 与 HEAD[to] 原文不同），
      // 只是本次没涉及 ⇒ 不判红，但**必须**出现在「历史保留」读数里，不许静默吞掉。
      { doc: FIXTURE_LEGACY_DOC, line: anchorDocLine(legacyDoc), target: FIXTURE_TARGET, from: 30, to: shifted, reason: '历史保留夹具：引入它的提交已经举证过，本次提交没涉及' },
    ],
  });
  assert.equal(
    result.violations.length,
    3,
    `陈旧登记应当逐条判红 3 条，实际 ${result.violations.length} 条：${result.violations.join(' | ')}`,
  );
  for (const message of result.violations) assert.match(message, /^\[登记表\] 第 \d+ 条/);
  assert.ok(
    !result.violations.some((message) => message.includes(FIXTURE_LEGACY_DOC)),
    `历史保留条目不许出现在 violations 里：${result.violations.join(' | ')}`,
  );
  assert.equal(result.carried.length, 1, `历史保留必须逐条读出 1 条，实际 ${result.carried.length} 条`);
  assert.equal(result.stats.carried, result.carried.length);
  assert.match(result.carried[0], /\[登记表\] 第 4 条/);
  assert.match(result.carried[0], /docs\/legacy-status\.md:3/);
  assert.match(result.carried[0], /历史保留/);
  t.diagnostic(
    `夹具（陈旧登记）判红 ${result.violations.length} 条；历史保留 ${result.carried.length} 条：${result.carried[0]}`,
  );
});

test('登记表 U1：继承一条与本提交无关的历史条目（HEAD 上仍成立）⇒ 不得出现在 violations 里，该绿的部分照样绿', (t) => {
  // 真实形态：`upstream/main` 的登记表里已经躺着一条历史条目（引入它的提交早就举证过），此后任何一个
  // 只改**别的**文档的提交，都不该因为它判红。
  const legacyDoc = legacyDocFile({ anchor: FIXTURE_ANCHOR_LINE });
  const headDoc = docFile({ anchor: FIXTURE_ANCHOR_LINE });
  const repo = fixtureRepo(t, {
    baseFiles: {
      [FIXTURE_TARGET]: serviceFile(),
      [FIXTURE_DOC]: docFile({ anchor: FIXTURE_ANCHOR_LINE + 1 }),
      [FIXTURE_LEGACY_DOC]: legacyDoc,
    },
    headFiles: {
      [FIXTURE_TARGET]: serviceFile(),
      [FIXTURE_DOC]: headDoc,
      [FIXTURE_LEGACY_DOC]: legacyDoc,
    },
  });
  const result = judge({
    root: repo.root,
    base: repo.base,
    head: repo.head,
    registry: [
      {
        doc: FIXTURE_DOC,
        line: anchorDocLine(headDoc),
        target: FIXTURE_TARGET,
        from: FIXTURE_ANCHOR_LINE + 1,
        to: FIXTURE_ANCHOR_LINE,
        reason: '夹具：本提交把陈旧锚点改到正确行（目标文件未改）',
      },
      {
        doc: FIXTURE_LEGACY_DOC,
        line: anchorDocLine(legacyDoc),
        target: FIXTURE_TARGET,
        from: 30,
        to: FIXTURE_ANCHOR_LINE,
        reason: '历史保留夹具：与本提交无关，但 HEAD 上仍成立',
      },
    ],
  });
  assert.deepEqual(result.violations, []);
  assert.equal(result.stats.docFiles, 1, '本次提交的文档改动面只该有 docs/notes.md 一个文件');
  assert.equal(result.registered.length, 2, '本提交真正生效的登记：同行路径锚点 + 裸锚点');
  for (const message of result.registered) assert.match(message, /已登记/);
  assert.equal(result.carried.length, 1, '那条历史条目必须进「历史保留」读数');
  assert.match(result.carried[0], /docs\/legacy-status\.md:3/);
  assert.match(result.carried[0], /历史保留/);
  assert.ok(
    result.stats.judged + result.registered.length > 0,
    '判定面自证：本次该绿的部分必须真的判到了（不许靠「判 0 条」冒充通过）',
  );
  t.diagnostic(
    `夹具（U1 继承条目 + 改别的文档）violations=0　生效 ${result.registered.length} 个 token、历史保留 ${result.carried.length} 条`,
  );
});

test('登记表 U2：历史条目的 doc 本提交也被改了、但改的是别的行 ⇒ 不判红，只进「历史保留」', (t) => {
  // 本提交改 docs/notes.md 的两行：第 3 行重锚（21 → 20，走登记），第 4 行只改措辞（锚点逐字恒等）。
  // 登记表里那条历史条目指向**第 4 行**（HEAD 上仍含 ⟨target :to⟩），本次改动面里没有它对应的位移。
  const baseDoc = `# 夹具\n\n- 落点：\`${FIXTURE_TARGET}:${FIXTURE_ANCHOR_LINE + 1}\`（裸锚点 :${FIXTURE_ANCHOR_LINE + 1}）\n`
    + `- 备注：\`${FIXTURE_TARGET}:${FIXTURE_ANCHOR_LINE}\`\n`;
  const headDoc = `# 夹具\n\n- 落点：\`${FIXTURE_TARGET}:${FIXTURE_ANCHOR_LINE}\`（裸锚点 :${FIXTURE_ANCHOR_LINE}）\n`
    + `- 备注（本提交只改了措辞）：\`${FIXTURE_TARGET}:${FIXTURE_ANCHOR_LINE}\`\n`;
  const repo = fixtureRepo(t, {
    baseFiles: { [FIXTURE_TARGET]: serviceFile(), [FIXTURE_DOC]: baseDoc },
    headFiles: { [FIXTURE_TARGET]: serviceFile(), [FIXTURE_DOC]: headDoc },
  });
  const result = judge({
    root: repo.root,
    base: repo.base,
    head: repo.head,
    registry: [
      {
        doc: FIXTURE_DOC,
        line: 3,
        target: FIXTURE_TARGET,
        from: FIXTURE_ANCHOR_LINE + 1,
        to: FIXTURE_ANCHOR_LINE,
        reason: '夹具：本提交把第 3 行的陈旧锚点改到正确行',
      },
      {
        doc: FIXTURE_DOC,
        line: 4,
        target: FIXTURE_TARGET,
        from: 30,
        to: FIXTURE_ANCHOR_LINE,
        reason: '历史保留夹具：同文档、不同行的历史条目',
      },
    ],
  });
  assert.deepEqual(result.violations, []);
  assert.equal(result.registered.length, 2, '第 3 行重锚应当由登记接住');
  assert.ok(result.stats.judged > 0, '第 4 行锚点恒等，必须真的判过（否则是「一条没判」的假绿）');
  assert.equal(result.carried.length, 1, '同文档不同行的历史条目必须进「历史保留」读数');
  assert.match(result.carried[0], /docs\/notes\.md:4/);
  assert.match(result.carried[0], /历史保留/);
  t.diagnostic(
    `夹具（U2 继承条目 + 同文档别的行）violations=0　judged=${result.stats.judged}　历史保留 ${result.carried.length} 条`,
  );
});

test('登记表 U3：条目指到一条本来就不含该锚点的文档行 ⇒ 必须判红并点名（doc 本提交一个字没改也一样）', (t) => {
  // 「HEAD 上仍成立」的反面：doc 行存在，但那一行从来就没有 ⟨target :to⟩。这类登记站不住，必须红。
  const headDoc = docFile({ anchor: FIXTURE_ANCHOR_LINE });
  const repo = fixtureRepo(t, {
    baseFiles: {
      [FIXTURE_TARGET]: serviceFile(),
      [FIXTURE_DOC]: docFile({ anchor: FIXTURE_ANCHOR_LINE + 1 }),
    },
    headFiles: { [FIXTURE_TARGET]: serviceFile(), [FIXTURE_DOC]: headDoc },
  });
  const result = judge({
    root: repo.root,
    base: repo.base,
    head: repo.head,
    registry: [
      {
        doc: FIXTURE_DOC,
        line: anchorDocLine(headDoc),
        target: FIXTURE_TARGET,
        from: FIXTURE_ANCHOR_LINE + 1,
        to: FIXTURE_ANCHOR_LINE,
        reason: '夹具：本提交把陈旧锚点改到正确行（这条是合法的）',
      },
      {
        doc: FIXTURE_DOC,
        line: 1,
        target: FIXTURE_TARGET,
        from: 30,
        to: FIXTURE_ANCHOR_LINE,
        reason: '陈旧夹具：doc 第 1 行是标题，本来就没有锚点',
      },
    ],
  });
  assert.equal(
    result.violations.length,
    1,
    `只有那条站不住的登记该红，实际 ${result.violations.length} 条：${result.violations.join(' | ')}`,
  );
  assert.match(result.violations[0], /^\[登记表\] 第 2 条 ⟨docs\/notes\.md:1 /);
  assert.match(result.violations[0], /陈旧/);
  assert.match(result.violations[0], /里已经没有 ⟨src\/service\.mjs :20⟩ 这个锚点/);
  assert.equal(result.carried.length, 0, '判红的条目不许同时被当成「历史保留」');
  t.diagnostic(`夹具（U3 指到无锚点的行）判红 1 条：${result.violations[0]}`);
});

test('登记表 U4（关键回归）：目标文件本提交未改、文档把陈旧行号改到正确新值 ⇒ 登记了就绿并读出「已登记」，不登记必须红', (t) => {
  // 真实使用场景（GY-R68 起因）：`app.ts:2433-2472` 早已漂移到 `:2469-2508`，本提交只改文档行号，
  // 目标文件一个字没动。历史实现在「本次提交的文档改动面里没有这条位移」那一档把这种提交判红 ⇒
  // 等于这条闸门不许人修旧锚点。这个用例同时钉住「加登记 ⇒ 绿」「不加 ⇒ 仍按恒等判红」两侧。
  const stale = 30;
  const correct = FIXTURE_ANCHOR_LINE;
  const legacyDoc = legacyDocFile({ anchor: stale });
  const repo = fixtureRepo(t, {
    baseFiles: {
      [FIXTURE_TARGET]: serviceFile(),
      [FIXTURE_DOC]: docFile({ anchor: stale }),
      [FIXTURE_LEGACY_DOC]: legacyDoc,
    },
    headFiles: {
      [FIXTURE_TARGET]: serviceFile(),
      [FIXTURE_DOC]: docFile({ anchor: correct }),
      [FIXTURE_LEGACY_DOC]: legacyDoc,
    },
  });
  const legacyEntry = {
    doc: FIXTURE_LEGACY_DOC,
    line: anchorDocLine(legacyDoc),
    target: FIXTURE_TARGET,
    from: 35,
    to: stale,
    reason: '历史保留夹具：与本提交无关，HEAD 上仍成立',
  };

  const withoutRegistration = judge({
    root: repo.root, base: repo.base, head: repo.head, registry: [legacyEntry],
  });
  assert.ok(withoutRegistration.violations.length > 0, '目标文件未改 + 行号变了，没有登记必须红');
  assert.match(
    withoutRegistration.violations.join('\n'),
    /目标文件本提交未改动 ⇒ 行号必须恒等/,
    '恒等判定必须还在（不许把闸门放开成万能通行证）',
  );
  assert.ok(
    !withoutRegistration.violations.some((message) => message.includes(FIXTURE_LEGACY_DOC)),
    '历史条目不许掺进这次的红：' + withoutRegistration.violations.join(' | '),
  );
  assert.equal(withoutRegistration.carried.length, 1, '历史条目此时也必须是「历史保留」而不是判红');

  const withRegistration = judge({
    root: repo.root,
    base: repo.base,
    head: repo.head,
    registry: [{
      doc: FIXTURE_DOC,
      line: anchorDocLine(docFile({ anchor: correct })),
      target: FIXTURE_TARGET,
      from: stale,
      to: correct,
      reason: '夹具：旧锚点指到 value30，本提交按符号重锚到标记行（目标文件未改）',
    }, legacyEntry],
  });
  assert.deepEqual(withRegistration.violations, []);
  assert.equal(withRegistration.registered.length, 2, '路径锚点 + 裸锚点都该由这条登记接住');
  for (const message of withRegistration.registered) assert.match(message, /已登记/);
  assert.equal(withRegistration.carried.length, 1);
  assert.match(withRegistration.carried[0], /docs\/legacy-status\.md:3/);
  t.diagnostic(
    `夹具（U4 真场景）不登记 ⇒ 红 ${withoutRegistration.violations.length} 条；登记 ⇒ 绿，已登记 ${withRegistration.registered.length} 个 token：${withRegistration.registered[0]}`,
  );
});

test('登记表 U5：登记的 doc 本提交被改、改后 entry.doc:entry.line 已不再命中 ⟨target :to⟩ ⇒ 必须判红并点名', (t) => {
  // 这是新的「陈旧」定义：不看你本次有没有提到这条位移，只看 HEAD 上那个锚点还在不在那一行。
  // 夹具把锚点行原地换成了散文（锚点挪到下一行），登记表里那条 doc:3 随之失效。
  const baseDoc = docFile({ anchor: FIXTURE_ANCHOR_LINE });
  const headDoc = `# 夹具\n\n- 新增说明行（本提交把锚点行挪到下一行）\n`
    + `- 落点：\`${FIXTURE_TARGET}:${FIXTURE_ANCHOR_LINE}\`（裸锚点 :${FIXTURE_ANCHOR_LINE}）\n`;
  const repo = fixtureRepo(t, {
    baseFiles: { [FIXTURE_TARGET]: serviceFile(), [FIXTURE_DOC]: baseDoc },
    headFiles: { [FIXTURE_TARGET]: serviceFile(), [FIXTURE_DOC]: headDoc },
  });
  const result = judge({
    root: repo.root,
    base: repo.base,
    head: repo.head,
    registry: [{
      doc: FIXTURE_DOC,
      line: 3,
      target: FIXTURE_TARGET,
      from: 30,
      to: FIXTURE_ANCHOR_LINE,
      reason: '陈旧夹具：登记行已被上移，新行号不命中',
    }],
  });
  assert.equal(
    result.violations.length,
    1,
    `登记失效必须且只判 1 条，实际 ${result.violations.length} 条：${result.violations.join(' | ')}`,
  );
  assert.match(result.violations[0], /^\[登记表\] 第 1 条 ⟨docs\/notes\.md:3 /);
  assert.match(result.violations[0], /陈旧/);
  assert.match(result.violations[0], /里已经没有 ⟨src\/service\.mjs :20⟩ 这个锚点/);
  assert.equal(result.carried.length, 0, 'doc 行已经不命中，绝不许退化成「历史保留」');
  t.diagnostic(`夹具（U5 doc 行失效）判红 1 条：${result.violations[0]}`);
});

test('登记表 B1 回归：只靠登记落地的最小修复提交（目标文件未改 + 文档行号重锚 + 逐字条目）⇒ 判空自证必须认「已登记」，读数出现「已登记 2 个 token」', (t) => {
  // 审查实测的假红：目标文件本提交未改、只把文档里的锚点行号改成正确新值、登记一条逐字条目 ——
  // 这正是「按符号重锚一个跨提交漂移的旧锚点」的标准提交。登记命中的 token 走 `continue`、不进
  // `judged`，所以判空自证只要漏算 `registered`，这种提交就会被判
  // 「扫描面为空：抽到 1 个锚点，却没有任何一个进入判定桶（判定 0／已删 0／未判 0／判红 0）」。
  // 本用例把 `judgmentBuckets()` 钉住：谁把 registered 从自证里删掉，这里就红。
  const stale = 30;
  const correct = FIXTURE_ANCHOR_LINE;
  const repo = fixtureRepo(t, {
    baseFiles: { [FIXTURE_TARGET]: serviceFile(), [FIXTURE_DOC]: docFile({ anchor: stale }) },
    headFiles: { [FIXTURE_TARGET]: serviceFile(), [FIXTURE_DOC]: docFile({ anchor: correct }) },
  });
  const result = judge({
    root: repo.root,
    base: repo.base,
    head: repo.head,
    registry: [{
      doc: FIXTURE_DOC,
      line: anchorDocLine(docFile({ anchor: correct })),
      target: FIXTURE_TARGET,
      from: stale,
      to: correct,
      reason: '夹具（B1）：目标文件本提交未改，文档把旧锚点重锚到正确新值',
    }],
  });
  assert.deepEqual(result.violations, [], '这种最小修复提交必须全绿');
  assert.equal(result.stats.judged, 0, '前提：本提交没有任何 token 进入 judged（全靠登记接住）');
  assert.equal(result.registered.length, 2, '路径锚点 + 裸锚点都该由这条登记接住');
  const buckets = judgmentBuckets(result);
  assert.equal(buckets.registered, 2);
  assert.equal(buckets.corrected, 0, 'Ａ类登记（缺省 kind）不该被算成纠正');
  assert.equal(buckets.judged + buckets.removed + buckets.unresolved + buckets.violations, 0);
  assert.ok(
    buckets.total > 0,
    '判空自证必须把「已登记」算进桶里，否则这种提交会假红「扫描面为空」',
  );
  assert.match(summarize(result, 'fixture'), /registered=2/);
  const detail = registeredDetail(result);
  assert.match(detail, /；已登记：/);
  assert.match(detail, /docs\/notes\.md:3 ⟨src\/service\.mjs :30 → :20⟩ — 已登记（/);
  assert.equal(detail.split('\n').length - 1, 2, '两条 token 的「已登记」都要逐条写出');
  t.diagnostic(
    `夹具（B1 只靠登记落地）judged=0 removed=0 unresolved=0 判红=0 已登记=${buckets.registered} `
    + `纠正=${buckets.corrected}，判空自证 total=${buckets.total} 通过`,
  );
});

// ───────────────────── C 组夹具：kind: "correction"（整改通道，不是白名单） ─────────────────────
// 统一场景是「真实现场」的合成版：同一提交里目标文件顶部插 4 行 ⇒ 端点映射把旧行 21 机械平移到 25；
// 但旧锚点在 base 上本来就指错（指到无关的 value21），正确落点是 HEAD 的 24 行（含 FIXED_TARGET）。
// 于是：不登记 ⇒ 红在端点映射（C2）；登记 correction ⇒ 绿（C1）；验真三件事不过 ⇒ 红（C3–C7）。

/** C 组共用的符号：只有「纠正后正确的那一行」才含它。 */
const CORRECTION_SYMBOL = 'FIXED_TARGET';
/** C 组共用的旧锚点（base 上指错的无关行）。 */
const CORRECTION_OLD_ANCHOR = 21;
/** 顶部插 4 行后，端点映射把旧锚点搬到这一行 —— 机械平移只会把错误搬到这里。 */
const CORRECTION_MAPPED_ANCHOR = CORRECTION_OLD_ANCHOR + 4;
/** 真正含符号的正确落点（HEAD 行号）。 */
const CORRECTION_RIGHT_ANCHOR = 24;

function correctionDoc(anchor) {
  return docFile({ anchor });
}

/** C1/C2/C3/C4/C6 共用的仓库：base 指错、HEAD 指对，目标文件本提交有改动。 */
function correctionRepo(t) {
  return fixtureRepo(t, {
    baseFiles: {
      [FIXTURE_TARGET]: targetFile(),
      [FIXTURE_DOC]: correctionDoc(CORRECTION_OLD_ANCHOR),
    },
    headFiles: {
      [FIXTURE_TARGET]: targetFile({
        insertAbove: 4,
        overrides: { 20: `export const ${CORRECTION_SYMBOL} = '纠正后的正确落点';` },
      }),
      [FIXTURE_DOC]: correctionDoc(CORRECTION_RIGHT_ANCHOR),
    },
  });
}

/** 一条形状完整的 correction 登记（路径锚点 + 同行的裸锚点共用这一条）。 */
function correctionEntry(overrides = {}) {
  return {
    doc: FIXTURE_DOC,
    line: anchorDocLine(correctionDoc(CORRECTION_RIGHT_ANCHOR)),
    target: FIXTURE_TARGET,
    from: CORRECTION_OLD_ANCHOR,
    to: CORRECTION_RIGHT_ANCHOR,
    reason: '夹具（C 组）：旧锚点在 base 上本来就指错，纠正到含 FIXED_TARGET 的正确行',
    kind: 'correction',
    symbol: CORRECTION_SYMBOL,
    ...overrides,
  };
}

test('C1 纠正夹具：目标文件有改动 + 旧锚点本就指错 + kind="correction" 登记 ⇒ 绿，registered 打印 kind=correction 与 symbol、stats.corrected ≥ 1', (t) => {
  const repo = correctionRepo(t);
  const result = judge({
    root: repo.root, base: repo.base, head: repo.head, registry: [correctionEntry()],
  });
  assert.deepEqual(
    result.violations,
    [],
    `纠正登记必须放行，实际判红 ${result.violations.length} 条：${result.violations.join(' | ')}`,
  );
  assert.ok(
    result.stats.corrected >= 1,
    `纠正计数没加上：${summarize(result, 'fixture')}`,
  );
  assert.ok(
    result.registered.some((item) => item.includes('kind=correction') && item.includes(CORRECTION_SYMBOL)),
    `registered 必须逐条打印 kind=correction 与 symbol 才能人工复核：${result.registered.join(' | ')}`,
  );
  assert.match(summarize(result, 'fixture'), /corrected=2\b/);
  const buckets = judgmentBuckets(result);
  assert.ok(buckets.corrected >= 1, 'judgmentBuckets 漏了 corrected');
  assert.equal(buckets.registered, 0, '纠正不该同时被算成Ａ类「已登记」（同一处位移只数一遍）');
  assert.ok(
    buckets.total > 0,
    '只靠 correction 落地的提交必须仍是非空扫描面（B1 类「扫描面为空」假红不许在新通道上重演）',
  );
  t.diagnostic(
    `夹具（C1 纠正放行）${summarize(result, 'fixture')}；已登记：${result.registered.join(' | ')}`,
  );
});

test('C2 纠正夹具：同一场景但不登记 ⇒ 必红，且红在「端点映射」那条（证明放行只来自登记）', (t) => {
  const repo = correctionRepo(t);
  const result = judge({ root: repo.root, base: repo.base, head: repo.head });
  assert.ok(result.violations.length > 0, '不登记竟然判绿：整改通道变成了白名单');
  const text = result.violations.join('\n');
  assert.match(text, /目标文件本提交有改动 ⇒ 行号必须落在这个文件自己的端点映射上/);
  assert.match(
    text,
    new RegExp(`起 ${CORRECTION_OLD_ANCHOR}→${CORRECTION_MAPPED_ANCHOR}（文档写 ${CORRECTION_RIGHT_ANCHOR}）`),
  );
  assert.equal(result.stats.corrected, 0, '没有登记就不该有纠正计数');
  t.diagnostic(`夹具（C2 不登记）判红 ${result.violations.length} 条：${result.violations[0]}`);
});

test('C3 纠正夹具：kind="correction" 却缺 symbol ⇒ 形状错误判红（半成品登记不许滑到判定阶段）', (t) => {
  const repo = correctionRepo(t);
  const entry = correctionEntry();
  delete entry.symbol;
  const result = judge({
    root: repo.root, base: repo.base, head: repo.head, registry: [entry],
  });
  const text = result.violations.join('\n');
  assert.ok(result.violations.length > 0, '缺 symbol 的 correction 竟然判绿');
  assert.match(text, /\[登记表\] 第 1 条形状错误/);
  assert.match(text, /symbol 必填/);
  assert.equal(result.stats.corrected, 0, '形状错误一律不许计入 corrected');
  t.diagnostic(`夹具（C3 缺 symbol）判红 ${result.violations.length} 条：${text.split('\n')[0]}`);
});

test('C4 纠正夹具：symbol 在新行里找不到 ⇒ 判红，文案点名找不到的那个符号', (t) => {
  const repo = correctionRepo(t);
  const result = judge({
    root: repo.root,
    base: repo.base,
    head: repo.head,
    registry: [correctionEntry({ symbol: 'NOT_IN_HEAD_LINE' })],
  });
  const text = result.violations.join('\n');
  assert.ok(result.violations.length > 0, 'symbol 找不到竟然判绿');
  assert.match(text, /找不到 symbol "NOT_IN_HEAD_LINE"/);
  assert.match(text, new RegExp(`新行 ${FIXTURE_TARGET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:${CORRECTION_RIGHT_ANCHOR}`));
  assert.equal(result.stats.corrected, 0, '验真不过不许 +1');
  t.diagnostic(`夹具（C4 新行无此符号）判红 ${result.violations.length} 条：${result.violations[0]}`);
});

test('C5 纠正夹具：symbol 在旧行里也有（旧锚点本来就指对）⇒ 判红「这不是纠正」', (t) => {
  // 旧行与新行含同一个符号 ⇒ 把行号从 21 改到 24 是真回归，不是纠正；② 必须拦住。
  const shared = 'SHARED_SYMBOL';
  const sharedLine = `export const ${shared} = '旧锚点本来就指对了';`;
  const repo = fixtureRepo(t, {
    baseFiles: {
      [FIXTURE_TARGET]: targetFile({ overrides: { [CORRECTION_OLD_ANCHOR]: sharedLine } }),
      [FIXTURE_DOC]: correctionDoc(CORRECTION_OLD_ANCHOR),
    },
    headFiles: {
      [FIXTURE_TARGET]: targetFile({ insertAbove: 4, overrides: { 20: sharedLine } }),
      [FIXTURE_DOC]: correctionDoc(CORRECTION_RIGHT_ANCHOR),
    },
  });
  const result = judge({
    root: repo.root,
    base: repo.base,
    head: repo.head,
    registry: [correctionEntry({ symbol: shared })],
  });
  const text = result.violations.join('\n');
  assert.ok(result.violations.length > 0, '旧锚点本来就指对竟然还能「纠正」成功');
  assert.match(text, /这不是纠正/);
  assert.match(text, /旧行/);
  assert.equal(result.stats.corrected, 0, '② 不通过不许 +1');
  t.diagnostic(`夹具（C5 旧行已含符号）判红 ${result.violations.length} 条：${result.violations[0]}`);
});

test('C6 纠正夹具：kind 写成其它值（"fix"）⇒ 形状错误判红', (t) => {
  const repo = correctionRepo(t);
  const result = judge({
    root: repo.root, base: repo.base, head: repo.head,
    registry: [correctionEntry({ kind: 'fix' })],
  });
  const text = result.violations.join('\n');
  assert.ok(result.violations.length > 0, 'kind="fix" 竟然判绿');
  assert.match(text, /\[登记表\] 第 1 条形状错误/);
  assert.match(text, /kind 只允许/);
  assert.match(text, /"fix"/);
  assert.equal(result.stats.corrected, 0);
  t.diagnostic(`夹具（C6 非法 kind）判红 ${result.violations.length} 条：${text.split('\n')[0]}`);
});

test('C7 反空转：correction 把 to 指到任意不含 symbol 的行 ⇒ 必红，且 corrected 只在验真通过后 +1', (t) => {
  // 「指到别处也算纠正」是这条整改通道最容易退化的形状：把 to 挪到一条与符号无关的行，
  // 验真①就必须拦住；同时钉住「corrected 只在通过后 +1」—— 失败时计数必须纹丝不动。
  const wrongTo = CORRECTION_MAPPED_ANCHOR + 5;
  const wrongRepo = fixtureRepo(t, {
    baseFiles: {
      [FIXTURE_TARGET]: targetFile(),
      [FIXTURE_DOC]: correctionDoc(CORRECTION_OLD_ANCHOR),
    },
    headFiles: {
      [FIXTURE_TARGET]: targetFile({
        insertAbove: 4,
        overrides: { 20: `export const ${CORRECTION_SYMBOL} = '纠正后的正确落点';` },
      }),
      [FIXTURE_DOC]: correctionDoc(wrongTo),
    },
  });
  const wrongEntry = correctionEntry({ to: wrongTo });
  const failed = judge({
    root: wrongRepo.root, base: wrongRepo.base, head: wrongRepo.head, registry: [wrongEntry],
  });
  const text = failed.violations.join('\n');
  assert.ok(failed.violations.length > 0, `把 to 指到不含 symbol 的行竟然判绿（to=${wrongTo}）`);
  assert.match(text, /找不到 symbol/);
  assert.equal(failed.stats.corrected, 0, 'corrected 只在验真通过后才 +1，失败必须纹丝不动');

  // 同一场景把 to 指回真正含符号的行 ⇒ 才允许 +1（对照，证明上面那条红不是「整条通道恒红」）。
  const rightRepo = correctionRepo(t);
  const passed = judge({
    root: rightRepo.root, base: rightRepo.base, head: rightRepo.head, registry: [correctionEntry()],
  });
  assert.deepEqual(
    passed.violations,
    [],
    `指回正确行后仍判红：${passed.violations.join(' | ')}`,
  );
  assert.ok(passed.stats.corrected >= 1, '验真通过后 corrected 必须 +1');
  t.diagnostic(
    `夹具（C7 反空转）to=${wrongTo} 判红 ${failed.violations.length} 条 corrected=${failed.stats.corrected}；`
    + `指回 :${CORRECTION_RIGHT_ANCHOR} 后 corrected=${passed.stats.corrected} 且 0 判红`,
  );
});

test('C8 纠正夹具：kind="correction" 且 from === to（锚点根本没动）⇒ 判红并点名（③ 与登记表「陈旧」双保险）', (t) => {
  // 对抗审查 ADV-V3c 的永久化：目标文件确实改了（顶部插 4 行），但文档被「只改措辞、不动锚点」地过一遍。
  // 这种形状谈不上「把错锚点改到正确行号」，③ 必须拦住；登记表自验真的「陈旧」是第二道独立保险。
  const repo = fixtureRepo(t, {
    baseFiles: {
      [FIXTURE_TARGET]: targetFile(),
      [FIXTURE_DOC]: docFile({ anchor: CORRECTION_OLD_ANCHOR }),
    },
    headFiles: {
      [FIXTURE_TARGET]: targetFile({
        insertAbove: 4,
        overrides: { 20: `export const ${CORRECTION_SYMBOL} = '纠正后的正确落点';` },
      }),
      // 关键：HEAD 的锚点数值仍是 21，只在同一行补了措辞 ⇒ 这一行真的进了 diff，但位移量为 0。
      [FIXTURE_DOC]: docFile({ anchor: CORRECTION_OLD_ANCHOR, note: '（本提交只改了措辞，锚点没动）' }),
    },
  });
  const result = judge({
    root: repo.root,
    base: repo.base,
    head: repo.head,
    registry: [correctionEntry({ from: CORRECTION_OLD_ANCHOR, to: CORRECTION_OLD_ANCHOR })],
  });
  const text = result.violations.join('\n');
  assert.ok(result.violations.length > 0, 'from === to 的 correction 竟然判绿');
  assert.match(text, /登记为 kind=correction.*验真不通过：from 与 to 相同 ⇒ 旧锚点根本没动/);
  assert.match(text, /陈旧：from 与 to 相同，不可能对应任何位移，必须删/);
  assert.equal(result.stats.corrected, 0, '③ 不通过不许 +1');
  assert.equal(result.carried.length, 0, '不合格的 correction 不许退化成「历史保留」');
  t.diagnostic(`夹具（C8 from===to）判红 ${result.violations.length} 条：${result.violations[0]}`);
});

test('C9 纠正夹具：symbol 是纯空白串 ⇒ 形状错误判红（空白符号会把缩进行当成「命中」）', (t) => {
  // 对抗审查 ADV-S2 的永久化：`symbol: "   "` 必须被形状校验按「空」拦下，不许滑到验真阶段
  // —— 否则 `includes("   ")` 会把一条缩进行当成符号命中，纠正就退化成任意改行号。
  const repo = correctionRepo(t);
  const result = judge({
    root: repo.root,
    base: repo.base,
    head: repo.head,
    registry: [correctionEntry({ symbol: '   ' })],
  });
  const text = result.violations.join('\n');
  assert.ok(result.violations.length > 0, '纯空白 symbol 竟然判绿');
  assert.match(text, /\[登记表\] 第 1 条形状错误/);
  assert.match(text, /symbol 必填（非空字符串/);
  assert.equal(result.stats.corrected, 0, '形状错误一律不许计入 corrected');
  // 形状不合法的条目不参与匹配 ⇒ 两个 token 仍要落回端点映射判红，不许被「登记过」静默搬走。
  assert.match(text, /行号必须落在这个文件自己的端点映射上/);
  const shapeLine = result.violations.find((item) => /形状错误/.test(item));
  t.diagnostic(`夹具（C9 纯空白 symbol）判红 ${result.violations.length} 条：${shapeLine}`);
});

test('变异夹具：整行删掉带锚点的文档行（另改一行散文）⇒ 不判红，但锚点必须进 removed，不许隐身', (t) => {
  // 审查方的变异 D3：删掉整行 + 另一行改几个字 ⇒ 旧实现里被删那行的锚点既没进 removed 也没被判，
  // `tokens=2 judged=2 removed=0`，等于「删掉错锚点就变绿」的绕过口。现在未配对的旧行会被吐出来。
  const baseDoc = `# 夹具\n\n- 前置说明\n- 落点：\`${FIXTURE_TARGET}:${FIXTURE_ANCHOR_LINE}\`（裸锚点 :${FIXTURE_ANCHOR_LINE}）\n`;
  const headDoc = '# 夹具（本提交改了标题）\n\n- 前置说明\n';
  const repo = fixtureRepo(t, {
    baseFiles: { [FIXTURE_TARGET]: serviceFile(), [FIXTURE_DOC]: baseDoc },
    headFiles: { [FIXTURE_TARGET]: serviceFile(), [FIXTURE_DOC]: headDoc },
  });
  const result = judge({ root: repo.root, base: repo.base, head: repo.head });
  assert.deepEqual(result.violations, [], '删除整行锚点是合法改动，不该判红');
  assert.ok(
    result.removed.length > 0,
    '整行删掉的锚点必须进 removed 桶（否则「删掉错锚点」就是一条静默绕过口）',
  );
  assert.ok(
    result.removed.some((item) => /整行被删/.test(item)),
    `removed 里没有「整行被删」条目：${result.removed.join(' | ')}`,
  );
  assert.equal(result.stats.removed, result.removed.length);
  t.diagnostic(`夹具（整行删锚点）removed=${result.stats.removed} 条：${result.removed[0]}`);
});

test('变异夹具：纯删除型文档提交（旧行全部被删）⇒ 不许假红「扫描面为空」', (t) => {
  // 审查方的变异 D2：只删不改的 docs 提交以前会撞 `扫描面为空：没有配对出任何「旧行→新行」的文档行对`
  // 被判红。合法的删除必须能过；扫描面由 removed 侧承担。
  const baseDoc = `# 夹具\n\n- 落点：\`${FIXTURE_TARGET}:${FIXTURE_ANCHOR_LINE}\`\n`;
  const headDoc = '# 夹具\n';
  const repo = fixtureRepo(t, {
    baseFiles: { [FIXTURE_TARGET]: serviceFile(), [FIXTURE_DOC]: baseDoc },
    headFiles: { [FIXTURE_TARGET]: serviceFile(), [FIXTURE_DOC]: headDoc },
  });
  const result = judge({ root: repo.root, base: repo.base, head: repo.head });
  assert.deepEqual(result.violations, [], '纯删除不许判红');
  assert.equal(result.stats.docLines, 0, '夹具应当一行都配不上对（整段被删）');
  assert.ok(result.removed.length > 0, '纯删除也必须让锚点进 removed（不许零判定静默通过）');
  t.diagnostic(`夹具（纯删除）docLines=0 removed=${result.stats.removed} 条，未假红`);
});

// ──────────── 纯新增 docs 提交（GY-R68）：假红修复与相邻盲区的常驻夹具 ────────────
// 这一组钉的是「扫描面裁决」`scanSurfaceDecision()` 本身，用的是主用例真跑的那份判断：
//   A1 本次修掉的假红：纯新增 hunk ⇒ 显式 SKIP（既不是 PASS 也不是 fail）；
//   A2/A3 钉住它没把既有判定改松（未登记位移仍红／整行删锚点仍走 removed，且都不许变成 SKIP）；
//   A4 钉住 SKIP 只在「**全部**纯新增」时生效（掺进一个配得上行的 hunk 就必须红）；
//   A5 钉住「配出了行对但一个锚点都没抽到」的既有方向（SKIP），本片没有改它 —— 见文件头「已知限制之三 ⑤」。

/** A4 用的填充行：把「改旧行」与「末尾新增」隔成两个独立 hunk（`-U0` 下只要中间有未改行就会分开）。 */
const DOC_FILLER_LINES = Array.from({ length: 12 }, (_, index) => `- 填充行 ${index + 1}`);

test('A1 纯新增 docs 提交（旧侧 0 行）⇒ 显式 SKIP 并报出纯新增 hunk 数，不再是「扫描面为空」的假红', (t) => {
  const baseDoc = docFile({ anchor: FIXTURE_ANCHOR_LINE });
  const headDoc = `${baseDoc}\n## 追加附录（本节只新增，不改任何既有行）\n\n- 追加的一行说明\n`;
  const repo = fixtureRepo(t, {
    baseFiles: { [FIXTURE_TARGET]: serviceFile(), [FIXTURE_DOC]: baseDoc },
    headFiles: { [FIXTURE_TARGET]: serviceFile(), [FIXTURE_DOC]: headDoc },
  });
  const result = judge({ root: repo.root, base: repo.base, head: repo.head });

  // 先钉住夹具**就是**旧假红的形状：一行都配不上对，也没有任何旧行进 removed ⇒ 旧断言必红。
  assert.equal(result.stats.pairedHunks, 0, '夹具不该有「旧行→新行」配得上对的 hunk');
  assert.equal(result.stats.pureAddHunks, 1, '夹具应当恰好一个纯新增 hunk');
  assert.equal(result.stats.pureDeleteHunks, 0, '夹具不该有纯删除 hunk');
  assert.equal(result.stats.docLines, 0, '纯新增 hunk 一行也配不出「旧行→新行」');
  assert.deepEqual(result.removed, [], '纯新增没有任何旧行，removed 桶必须为空（旧实现正是在这里撞红）');
  assert.deepEqual(result.violations, [], '纯新增没有任何待判锚点，违规清单必须为空');

  const decision = scanSurfaceDecision(result);
  assert.equal(decision.kind, 'skip', `纯新增文档提交必须显式 SKIP，实际 ${decision.kind}：${decision.message}`);
  assert.match(decision.message, /只有新增行，没有锚点位移面（1 个纯新增 hunk）/);
  t.diagnostic(`夹具 A1（纯新增）${decision.kind}：${decision.message}｜${summarize(result, 'fixture')}`);
});

test('A2 目标文件本提交未改、文档行号被改动却没登记 ⇒ 仍硬红（新增的 SKIP 没把这条改松）', (t) => {
  const repo = fixtureRepo(t, {
    baseFiles: {
      [FIXTURE_TARGET]: serviceFile(),
      // 旧锚点指错一行；本提交把它「改对了」，但目标文件一个字没改 ⇒ 必须走登记表，否则红。
      [FIXTURE_DOC]: docFile({ anchor: FIXTURE_ANCHOR_LINE + 1 }),
    },
    headFiles: { [FIXTURE_TARGET]: serviceFile(), [FIXTURE_DOC]: docFile({ anchor: FIXTURE_ANCHOR_LINE }) },
  });
  const result = judge({ root: repo.root, base: repo.base, head: repo.head });
  const decision = scanSurfaceDecision(result);
  assert.equal(decision.kind, 'ok', `本次确有位移面，裁决不该是 ${decision.kind}：${decision.message}`);
  assert.equal(result.stats.pairedHunks, 1, '夹具应当恰好一个配得上行的 hunk');
  assert.equal(result.stats.pureAddHunks, 0, '夹具不该掺纯新增 hunk');
  assert.ok(result.violations.length > 0, '未登记的行号位移竟然判绿：判别力不成立');
  assert.match(result.violations.join('\n'), /行号必须恒等/);
  assert.throws(() => assertNoViolations(result), /锚点位移恒等失败/);
  t.diagnostic(`夹具 A2（未登记位移）裁决 ok，判红 ${result.violations.length} 条｜${summarize(result, 'fixture')}`);
});

test('A3 整行删掉带锚点的文档行 ⇒ 进 removed 且裁决是 ok，不许被判成 SKIP', (t) => {
  const baseDoc = `# 夹具\n\n- 前置说明\n- 落点：\`${FIXTURE_TARGET}:${FIXTURE_ANCHOR_LINE}\``
    + `（裸锚点 :${FIXTURE_ANCHOR_LINE}）\n`;
  const headDoc = '# 夹具\n\n- 前置说明\n';
  const repo = fixtureRepo(t, {
    baseFiles: { [FIXTURE_TARGET]: serviceFile(), [FIXTURE_DOC]: baseDoc },
    headFiles: { [FIXTURE_TARGET]: serviceFile(), [FIXTURE_DOC]: headDoc },
  });
  const result = judge({ root: repo.root, base: repo.base, head: repo.head });
  assert.equal(result.stats.pureDeleteHunks, 1, '夹具应当恰好一个纯删除 hunk');
  assert.equal(result.stats.pureAddHunks, 0, '整行删除不该附带纯新增 hunk');
  assert.equal(result.stats.pairedHunks, 0, '整行删除配不出「旧行→新行」');
  assert.equal(result.stats.docLines, 0, '夹具应当一行都配不上对');
  assert.ok(result.removed.length > 0, '整行删掉的锚点必须进 removed 桶');
  assert.deepEqual(result.violations, [], '删锚点是已知限制：只观测不判红');

  const decision = scanSurfaceDecision(result);
  assert.equal(decision.kind, 'ok', `纯删除型不许被 SKIP 吃掉，实际 ${decision.kind}：${decision.message}`);
  assert.doesNotMatch(decision.message, /纯新增/);
  t.diagnostic(`夹具 A3（整行删锚点）裁决 ok，removed=${result.stats.removed} 条｜${summarize(result, 'fixture')}`);
});

test('A4 混合：一个纯新增 hunk + 一个改了旧行却没登记行号位移的 hunk ⇒ 必须硬红（SKIP 只在「全部纯新增」时生效）', (t) => {
  const baseDoc = [
    '# 夹具',
    '',
    `- 落点：\`${FIXTURE_TARGET}:${FIXTURE_ANCHOR_LINE}\`（裸锚点 :${FIXTURE_ANCHOR_LINE}）`,
    '',
    ...DOC_FILLER_LINES,
  ].join('\n') + '\n';
  const headDoc = [
    '# 夹具',
    '',
    // 改旧行：目标文件本提交一个字没改，锚点却被改了 ⇒ 未登记的位移，必须红。
    `- 落点：\`${FIXTURE_TARGET}:${FIXTURE_ANCHOR_LINE - 1}\`（裸锚点 :${FIXTURE_ANCHOR_LINE - 1}）`,
    '',
    ...DOC_FILLER_LINES,
    '',
    '## 追加附录（这一段是纯新增 hunk）',
    '',
    '- 追加的一行说明',
  ].join('\n') + '\n';
  const repo = fixtureRepo(t, {
    baseFiles: { [FIXTURE_TARGET]: serviceFile(), [FIXTURE_DOC]: baseDoc },
    headFiles: { [FIXTURE_TARGET]: serviceFile(), [FIXTURE_DOC]: headDoc },
  });
  const result = judge({ root: repo.root, base: repo.base, head: repo.head });
  assert.equal(result.stats.pairedHunks, 1, '夹具应当有一个「改旧行」的 hunk');
  assert.equal(result.stats.pureAddHunks, 1, '夹具应当同时有一个纯新增 hunk');
  assert.equal(result.stats.pureDeleteHunks, 0, '夹具不该有纯删除 hunk');

  const decision = scanSurfaceDecision(result);
  assert.equal(decision.kind, 'ok', `掺了配得上行的 hunk 就不许 SKIP，实际 ${decision.kind}：${decision.message}`);
  assert.ok(result.violations.length > 0, '混合形状竟然判绿：SKIP 被放宽到了「有纯新增 hunk」而不是「全是纯新增」');
  assert.match(result.violations.join('\n'), /行号必须恒等/);
  assert.throws(() => assertNoViolations(result), /锚点位移恒等失败/);
  t.diagnostic(`夹具 A4（纯新增 + 改旧行）裁决 ok，判红 ${result.violations.length} 条｜${summarize(result, 'fixture')}`);
});

test('A5 只改一句不含行号引用的散文 ⇒ 现状：配得出行对但 tokens=0，显式 SKIP（本片不改判定方向，钉子钉住现状）', (t) => {
  // 用户的第 5 条要求「如实测出这条现状」。实测结果不是红、也不是 pass，而是既有约定的显式 SKIP
  // （见文件头「已知限制之三 ⑤」）：改动面里连一个锚点都没有，闸门没有任何东西可判。
  // 这条用例**故意**钉住「SKIP」而不是把它改成红：改判方向会让「随手修一个 typo 的 docs 提交」直接变红。
  const baseDoc = `# 夹具\n\n- 落点：\`${FIXTURE_TARGET}:${FIXTURE_ANCHOR_LINE}\`\n\n- 旧措辞的一句散文\n`;
  const headDoc = `# 夹具\n\n- 落点：\`${FIXTURE_TARGET}:${FIXTURE_ANCHOR_LINE}\`\n\n`
    + '- 新措辞的一句散文（只改了几个字，没有任何行号引用）\n';
  const repo = fixtureRepo(t, {
    baseFiles: { [FIXTURE_TARGET]: serviceFile(), [FIXTURE_DOC]: baseDoc },
    headFiles: { [FIXTURE_TARGET]: serviceFile(), [FIXTURE_DOC]: headDoc },
  });
  const result = judge({ root: repo.root, base: repo.base, head: repo.head });
  assert.equal(result.stats.docLines, 1, '夹具应当恰好配出一对行');
  assert.equal(result.stats.tokens, 0, '这句散文里不该有任何锚点 token');
  assert.deepEqual(result.removed, [], '夹具不该有整行删除');
  assert.deepEqual(result.violations, [], '夹具不该有违规（否则这条钉子钉的就不是「现状」）');
  assert.equal(judgmentBuckets(result).total, 0, '夹具必须真的没有任何判定面');

  const decision = scanSurfaceDecision(result);
  assert.equal(decision.kind, 'skip', `现状是 SKIP（既不是 PASS 也不是红），实际 ${decision.kind}：${decision.message}`);
  assert.match(decision.message, /不含任何行号引用/);
  t.diagnostic(`夹具 A5（纯散文改动）${decision.kind}：${decision.message}｜${summarize(result, 'fixture')}`);
});

test('自证：扫描面裁决的 fail 分支不许退化成 SKIP ——「diff 非空却什么都没解析出来」仍硬红且带纯新增 hunk 数', (t) => {
  const zeroStats = {
    docFiles: 1, docLines: 0, tokens: 0, pairs: 0, judged: 0, identical: 0, relocated: 0,
    registered: 0, corrected: 0, carried: 0, removed: 0,
    pairedHunks: 1, pureAddHunks: 2, pureDeleteHunks: 0,
  };
  const emptyBuckets = { violations: [], unresolved: [], removed: [], registered: [], carried: [], pairs: [] };

  // ① 有配对 hunk、也掺了纯新增 hunk，却一行都没配对出来、也没有 removed ⇒ 硬红，且不许落进「纯新增 SKIP」文案。
  const burned = scanSurfaceDecision({ ...emptyBuckets, stats: zeroStats });
  assert.equal(burned.kind, 'fail', `这种形状必须硬红，实际 ${burned.kind}：${burned.message}`);
  assert.match(burned.message, /其中有 2 个纯新增 hunk/);
  assert.doesNotMatch(burned.message, /只有新增行/);

  // ② 抽到了锚点却一条都没进桶 ⇒ 硬红（文案报出 tokens，别让人以为「没锚点」）。
  const stranded = scanSurfaceDecision({
    ...emptyBuckets,
    stats: { ...zeroStats, docLines: 1, tokens: 3 },
  });
  assert.equal(stranded.kind, 'fail', `抽到锚点却没进桶必须硬红，实际 ${stranded.kind}：${stranded.message}`);
  assert.match(stranded.message, /抽到 3 个锚点/);

  // ③ 只有「一个配得上行的 hunk 都没有」时才是 SKIP。
  const appendOnly = scanSurfaceDecision({
    ...emptyBuckets,
    stats: { ...zeroStats, pairedHunks: 0, pureAddHunks: 3 },
  });
  assert.equal(appendOnly.kind, 'skip', `全是纯新增才是 SKIP，实际 ${appendOnly.kind}：${appendOnly.message}`);
  assert.match(appendOnly.message, /3 个纯新增 hunk/);
  t.diagnostic(`夹具（裁决自证）fail/fail/skip 三分支都按预期：${burned.message}｜${stranded.message}｜${appendOnly.message}`);
});

test('自证：判据 helper「零违规」对非空 violations 必须抛（防一键把闸门改成恒绿）', (t) => {
  assertNoViolations({ violations: [] });
  assert.throws(
    () => assertNoViolations({ violations: ['夹具伪造的第 1 条违规'] }),
    /锚点位移恒等失败 1 条/,
  );
  assert.throws(
    () => assertNoViolations({ violations: ['a', 'b'] }, 'summary-x'),
    /锚点位移恒等失败 2 条（summary-x）/,
  );
  t.diagnostic('夹具（零违规 helper）对 1 条 / 2 条违规都抛，带 summary 时也抛');
});

/**
 * 永久用例：**真浅克隆里的 CI 自愈**（本片新增 —— 钉住「CI 上不许假绿」这条承诺本身）。
 *
 * 现场造一个带真 `.git/shallow` 的克隆：`git clone --depth=1 --branch feature file:///…`。三个 fallback
 * （`merge-base HEAD origin/main` / `merge-base HEAD upstream/main` / `rev-parse HEAD~1`）在里面**全断**，
 * 正是 CI 上 `actions/checkout` 默认 `fetch-depth: 1` 的形状 —— 也就是这条闸门假绿的来源。然后：
 *   ① 不自愈时 `resolveBase()` 必须返回 null（= 老行为一定 SKIP，这就是假绿）；
 *   ② 用 `CI=true` 跑一次**真用例本体**（子进程 `node --test` 只筛主用例）：必须 exit 1 且判出违规
 *      （判了才有 exit 1；SKIP 只会 exit 0）；
 *   ③ 事后回读克隆：`rev-list --count` 长出来、`merge-base HEAD origin/main` 落回 main tip、
 *      `--is-shallow-repository` 变 false ⇒ base 是**自愈 fetch** 给的，不是别的原因碰巧。
 *
 * 上游为什么是合成的、而不是直接 `git clone file:///<本仓路径>`：
 *   - 本仓在 CI 上是 detached HEAD（PR 检查）⇒ 从本仓 clone 拿不到默认分支，克隆出来可能没有工作区；
 *   - 本仓自己的对象库也带 `.git/shallow`（多个 graft 点），且 `refs/heads/main` 与 `origin/main` 并不
 *     指向同一个提交 ⇒ base 会落进无关历史，判定结果随分支内容漂移，做成永久用例必然 flaky；
 *   - 在「深度 1 克隆里再造一个提交」会让 `HEAD~1` 重新可用（父提交本来就在克隆里）⇒ 走的是 fallback 3，
 *     自愈根本没被走到，测了等于没测。
 *   合成上游只有 3 个提交，而 `HEAD~1` 不可解 / `origin/main` 缺失 / graft 边界不透明这三条与 CI 完全一致，
 *   所以浅克隆的**行为**是真的，只有仓库来源是合成的。
 */
test('CI 自愈：真浅克隆 + CI=true ⇒ 真的判了（不是 SKIP）', (t) => {
  if (process.env.DOC_ANCHOR_SHALLOW_CHILD === '1') {
    t.skip('子进程里不递归再造克隆：本用例在外层已经真跑过一次');
    return;
  }
  const upstreamRoot = mkdtempSync(join(tmpdir(), 'doc-anchor-upstream-'));
  const holderRoot = mkdtempSync(join(tmpdir(), 'doc-anchor-shallow-'));
  t.after(() => {
    for (const root of [upstreamRoot, holderRoot]) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // 临时目录清理失败不影响判定结论
      }
    }
  });

  const up = (args) => git(args, { cwd: upstreamRoot });
  up(['init', '-q', '-b', 'main']);
  const commit = (snapshot, message) => {
    for (const [relative, content] of Object.entries(snapshot)) {
      const absolute = join(upstreamRoot, relative);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content, 'utf8');
    }
    up(['add', '-A']);
    up(['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-q', '-m', message]);
    return up(['rev-parse', 'HEAD']).trim();
  };
  // 上游 main 必须有两个提交：`--deepen` 得真有更深的祖先可加深（只有 1 个提交时自愈必然无解）。
  commit({
    [FIXTURE_TARGET]: serviceFile(),
    [FIXTURE_DOC]: docFile({ anchor: FIXTURE_ANCHOR_LINE }),
    [REGISTRY_RELATIVE]: '[]\n',
    'tests/unit/doc-anchor-relocation-identity.test.mjs': readFileSync(fileURLToPath(import.meta.url), 'utf8'),
  }, 'main: 基线（锚点 :20 成立，登记表为空）');
  const mainTip = commit({ 'README.md': '# 上游夹具\n' }, 'main: 与锚点无关的一步');
  up(['checkout', '-q', '-b', 'feature']);
  // feature 只改 docs：目标文件一个字没动，却把锚点从 :20 改成 :21（且不登记）⇒ 必须判红。
  const docsOnly = commit({
    [FIXTURE_DOC]: docFile({ anchor: FIXTURE_ANCHOR_LINE + 1 }),
  }, 'feature: 只改 docs 的锚点行号（故意漏登记）');

  const work = join(holderRoot, 'work');
  git(['clone', '--depth=1', '--branch', 'feature', pathToFileURL(upstreamRoot).href, work], {
    cwd: holderRoot,
    timeout: 120_000,
  });
  const inWork = (args) => git(args, { cwd: work });

  // ① 假绿的形状：真浅克隆 + 三个 fallback 全断。
  assert.equal(inWork(['rev-parse', '--is-shallow-repository']).trim(), 'true', '克隆必须是真浅克隆');
  assert.equal(inWork(['rev-list', '--count', 'HEAD']).trim(), '1', '深度必须是 1（= fetch-depth: 1）');
  assert.throws(() => inWork(['rev-parse', 'HEAD~1']), /ambiguous argument|unknown revision/);
  assert.throws(() => inWork(['rev-parse', 'origin/main']), /ambiguous argument|unknown revision/);
  const cold = resolveBase(work);
  assert.equal(cold.sha, null, `浅克隆里三个 fallback 必须全断（这才是 CI 假绿的形状），实际取到 ${cold.sha}`);
  assert.match(cold.attempts.join('\n'), /merge-base HEAD origin\/main/);
  assert.match(cold.attempts.join('\n'), /merge-base HEAD upstream\/main/);
  assert.match(cold.attempts.join('\n'), /rev-parse HEAD~1/);

  // ② CI=true 跑真用例本体：判了才有 exit 1，SKIP 只会 exit 0。
  const childEnv = { ...process.env, CI: 'true', DOC_ANCHOR_SHALLOW_CHILD: '1' };
  // 只留 `CI`：证明单靠 `CI` 就够（`GITHUB_ACTIONS` 不必参与）。
  delete childEnv.GITHUB_ACTIONS;
  // 必须摘掉：本进程自己在 node:test 里跑，`NODE_TEST_CONTEXT` 会让子进程以为自己是「测试 runner 的
  // 子 worker」，结果全走 fd3 的 V8 序列化协议 —— stdout 一片空白、exit 0，看起来像「跑过了」。
  delete childEnv.NODE_TEST_CONTEXT;
  let childStatus = 0;
  let childOut = '';
  try {
    childOut = execFileSync(process.execPath, [
      '--test',
      '--test-name-pattern=文档锚点位移恒等',
      'tests/unit/doc-anchor-relocation-identity.test.mjs',
    ], {
      cwd: work,
      env: childEnv,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
    });
  } catch (error) {
    childStatus = typeof error.status === 'number' ? error.status : -1;
    childOut = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  assert.equal(
    childStatus,
    1,
    `浅克隆 + CI=true 必须因为「判出违规」而红（只 SKIP 不会 exit 1）；实际 status=${childStatus}：\n${childOut}`,
  );
  assert.match(childOut, /锚点位移恒等失败 \d+ 条/, '子进程没报出违规条数 ⇒ 判定压根没跑');
  assert.match(childOut, /行号必须恒等/, '子进程报的不是「目标文件没改 ⇒ 行号必须恒等」这条违规');
  assert.doesNotMatch(childOut, /SKIP: 无 base 历史/, '浅克隆 + CI 下不许再退化成「无 base 历史」SKIP（假绿）');
  assert.doesNotMatch(childOut, /网络取 base 失败/, '本夹具的 fetch 是本机 file:// 克隆，不该走网络故障 SKIP');

  // ③ 回读克隆：base 是自愈 fetch 拉回来的。
  const healedCount = Number(inWork(['rev-list', '--count', 'HEAD']).trim());
  assert.ok(healedCount > 1, `自愈后 HEAD 的历史必须长出来，实际 rev-list --count HEAD = ${healedCount}`);
  assert.equal(inWork(['rev-parse', 'origin/main']).trim(), mainTip, '自愈第一步必须真的建出 origin/main');
  assert.equal(inWork(['merge-base', 'HEAD', 'origin/main']).trim(), mainTip, '自愈后 merge-base 必须落回 main tip');
  assert.equal(
    inWork(['rev-parse', '--is-shallow-repository']).trim(),
    'false',
    '--deepen 必须把 graft 边界撤掉，否则 base 依然靠碰运气',
  );

  const bucketLine = (childOut.split('\n').find((line) => line.includes('锚点位移恒等失败')) ?? '').trim();
  t.diagnostic(
    `自愈夹具：clone 深度 1（rev-list 1 → ${healedCount}，is-shallow true → false），`
      + `origin/main 由 fetch 建出（${mainTip.slice(0, 12)}），merge-base 落回 ${mainTip.slice(0, 12)}；`
      + `子进程（CI=true）status=${childStatus}，feature=${docsOnly.slice(0, 12)}｜${bucketLine}`,
  );
});

/**
 * 永久守卫：fetch **超时**必须归 `network`（不是 `no-base`），且 SKIP 文案不许说「fetch 成功」。
 *
 * 背景（本轮审查方实测复现，本片第二轮修掉的正是这条说谎）：`execFileSync` 超时抛出来的错误
 * `stderr === ''`、`code === 'ETIMEDOUT'`、`signal === 'SIGTERM'`，错误文本里根本没有 `timed out`
 * 这几个字 —— 第一版只拿 `NETWORK_ERROR` 正则去判 `firstLine(stderr)`，于是超时被归进 `no-base`，
 * SKIP 文案照样写「自愈 fetch 成功但仍取不到共同祖先」，真实原因（超时）被丢空。这条用例用
 * **注入的伪错误对象**钉住四件事（不真跑 git fetch、**不真等 30 秒**）：
 *   ① `classifyFetchFailure`：`ETIMEDOUT` / `signal` ⇒ `timedOut && network`；而
 *      `couldn't find remote ref` 这类「远端没有那个 ref」仍必须**不**算网络故障（口径不能被改松）；
 *   ② 两招都超时 ⇒ `failure === 'network'`、`anyFetchSucceeded === false`、`timedOut === true`、
 *      `stderr` 摘要明写「空」；裁决 SKIP，文案含「网络取 base 失败」且**不含**「fetch 成功」；
 *   ③ 两招都跑通、但 merge-base 仍空 ⇒ 文案必须换成「自愈 fetch 成功但取不到共同祖先」，
 *      且**不含**「网络取 base 失败」（证明文案按实际结果分支，不是写死一句话）；
 *   ④ 半失败（一招超时、一招跑通）⇒ 两句都说、且不许说「全部失败」（第一版在这里只报一半）。
 */
test('CI 自愈：fetch 超时必须归 network（不是 no-base），且 SKIP 文案不许谎称「fetch 成功」', () => {
  const timeoutError = () => {
    const error = new Error('spawnSync git ETIMEDOUT');
    error.code = 'ETIMEDOUT';
    error.signal = 'SIGTERM';
    error.stderr = '';
    return error;
  };
  const missingRefError = () => {
    const error = new Error("Command failed: git fetch --depth=50 origin +refs/heads/main:refs/remotes/origin/main\n"
      + "fatal: couldn't find remote ref refs/heads/main\n");
    error.status = 128;
    error.stderr = "fatal: couldn't find remote ref refs/heads/main\n";
    return error;
  };

  // ① 分类：超时算网络；远端没有该 ref 不算（这条口径是 SKIP 文案与「继续试下一招」的分界）。
  const timedOut = classifyFetchFailure(timeoutError());
  assert.equal(timedOut.timedOut, true, '`code: ETIMEDOUT` / `signal` 必须被判成超时');
  assert.equal(timedOut.network, true, '超时是「没取到 base」，必须归 network 而不是 no-base');
  assert.equal(timedOut.code, 'ETIMEDOUT');
  assert.equal(timedOut.signal, 'SIGTERM');
  assert.match(timedOut.stderrSummary, /空/, '`stderr` 为空时必须显式写「空」，不能留一个洞');
  const missingRef = classifyFetchFailure(missingRefError());
  assert.equal(missingRef.network, false, "`couldn't find remote ref` 不是网络故障（远端没有那个 ref 而已）");
  assert.equal(missingRef.timedOut, false);

  // ② 两招都超时：failure 必须是 network（第一版这里是 no-base），文案必须是「网络取 base 失败」。
  const timeoutAttempts = [];
  const timeoutCalls = [];
  const healed = selfHealBase('/不存在的夹具根：run 已注入，不会碰文件系统', timeoutAttempts, {
    run: (args) => {
      timeoutCalls.push(args.join(' '));
      throw timeoutError();
    },
    resolve: () => {
      throw new Error('两招 fetch 都失败时不该再调 resolveBase（那会把失败咽成「没有共同祖先」）');
    },
  });
  assert.equal(timeoutCalls.length, 2, '两招都必须真的试过：第一招超时不许提前收工');
  assert.match(timeoutCalls[0], /--depth=50/);
  assert.match(timeoutCalls[1], /--deepen=500/);
  assert.equal(healed.resolved, null);
  assert.equal(healed.failure, 'network', '超时被归成 no-base 就是本用例存在的理由');
  assert.equal(healed.anyFetchSucceeded, false);
  assert.equal(healed.timedOut, true);
  assert.equal(healed.failures.length, 2);
  assert.match(timeoutAttempts.join('\n'), /超时/, '尝试记录里必须点名「超时」，不能只写一句 fatal');
  assert.match(timeoutAttempts.join('\n'), /code=ETIMEDOUT/);
  const timeoutDeadEnd = selfHealDeadEnd(healed, true);
  assert.equal(timeoutDeadEnd.action, 'skip', 'fetch 全部失败 ⇒ 允许 SKIP');
  assert.equal(selfHealDeadEnd(healed, false).action, 'skip', '完整仓库 + fetch 全失败也只允许 SKIP（不是逻辑坏了）');
  assert.match(timeoutDeadEnd.message, /网络取 base 失败，本用例未执行/, '文案必须写清「网络取 base 失败」');
  assert.doesNotMatch(timeoutDeadEnd.message, /fetch 成功/, 'fetch 全失败却写「fetch 成功」＝第一条被审查抓到的说谎');
  const timeoutDiagnostic = fetchDiagnosticOf(healed, timeoutAttempts, true);
  assert.match(timeoutDiagnostic, /code=ETIMEDOUT/, '`t.diagnostic` 必须带出 code');
  assert.match(timeoutDiagnostic, /signal=SIGTERM/, '`t.diagnostic` 必须带出 signal');
  assert.match(timeoutDiagnostic, /stderr=\(空/, '`t.diagnostic` 必须把「空 stderr」写出来');
  assert.match(timeoutDiagnostic, /尝试记录（\d+ 条）/, '`t.diagnostic` 必须带出全部尝试记录');

  // ③ 两招都跑通、但仍取不到共同祖先：文案必须换一支（且不许再说「网络取 base 失败」）。
  const noBase = selfHealBase('/同 ②', [], {
    run: () => {},
    resolve: () => ({
      sha: null,
      label: null,
      attempts: ['merge-base HEAD origin/main → fatal: Not a valid object name origin/main'],
    }),
  });
  assert.equal(noBase.failure, 'no-base');
  assert.equal(noBase.anyFetchSucceeded, true);
  assert.equal(noBase.failures.length, 0);
  const noBaseDeadEnd = selfHealDeadEnd(noBase, true);
  assert.equal(noBaseDeadEnd.action, 'skip');
  assert.match(noBaseDeadEnd.message, /自愈 fetch 成功但取不到共同祖先/);
  assert.doesNotMatch(noBaseDeadEnd.message, /网络取 base 失败/, 'fetch 明明没失败，不许写「网络取 base 失败」');
  assert.equal(selfHealDeadEnd(noBase, false).action, 'throw', '完整仓库无 base ⇒ 必须硬失败，不许 SKIP');

  // ④ 半失败：一招超时 + 一招跑通，但仍无共同祖先 ⇒ 两句都要说，且不许说「全部失败」。
  let mixedCalls = 0;
  const mixed = selfHealBase('/同 ②', [], {
    run: () => {
      mixedCalls += 1;
      if (mixedCalls === 1) throw timeoutError();
    },
    resolve: () => ({ sha: null, label: null, attempts: [] }),
  });
  assert.equal(mixed.failure, 'network', '有一招超时 ⇒ failure 记 network（但 anyFetchSucceeded 也真）');
  assert.equal(mixed.anyFetchSucceeded, true);
  assert.equal(mixed.timedOut, true);
  const mixedDeadEnd = selfHealDeadEnd(mixed, true);
  assert.equal(mixedDeadEnd.action, 'skip');
  assert.match(mixedDeadEnd.message, /fetch 成功但取不到共同祖先/, '有 fetch 跑通 ⇒ 必须说「fetch 成功…」');
  assert.match(mixedDeadEnd.message, /1 招 fetch 报错/, '必须点名「有 1 招报错」，别只报一半');
  assert.doesNotMatch(mixedDeadEnd.message, /全部失败/, '有一招跑通了，不许说「全部失败」');
});
