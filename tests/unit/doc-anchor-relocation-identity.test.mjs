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
 *   3) 每对行里按仓库既有写法抽锚点：`<路径>:<起>[-<止>]` 与紧跟在某个路径锚点之后的裸 `:<起>[-<止>]`；
 *      裸锚点解析不出归属（同行没有前置路径 / 前置路径装不下这个行号）时退回**当前文档自身**；
 *   4) 目标文件本提交未改动 ⇒ 断言 `new === old`（起止都断言）；
 *      目标文件本提交改动 ⇒ 用该文件自己的 `git diff -U0` 建端点映射，断言 `new === map(old)`；
 *   5) 两种情形都断言「`git show <base>:<目标>` 的旧行原文 === `git show HEAD:<目标>` 的新行原文」
 *      （目标行落在该文件被改写/删除的区内时无法做内容同一性判定，如实计入「不可解析」）。
 *
 * 位移的**唯一合法例外**是「旧锚点本来就指错，本提交把它改到正确行号」（目标文件一个字没动）——
 * 这种位移交给审查可见的登记表 `tests/unit/doc-anchor-relocations.json` 表达（字段
 * `doc` / `line` / `target` / `from` / `to` / `reason`，区间锚点再加 `fromEnd` / `toEnd`，
 * 仿 `tools/doc-anchors-baseline.json`）：
 *   - 目标文件未改 + 行号变了 ⇒ **默认红**；
 *   - 只有登记表里**逐字匹配**（doc / line / target / from / to 全等；区间锚点连两端都等）的一条能把它
 *     降级为「已登记」，diagnostic 里会列出条数与逐条摘要；
 *   - **登记表自身要被验真**：每条必须满足「新行号确实命中」「旧行号不再命中同一段原文」
 *     「本次提交的文档改动面里确实有这条位移」；陈旧条目（from == to、新行号不命中、原文相同、
 *     没有对应位移）与冗余条目（目标文件有改动、端点映射已能判）一律**判红并点名** —— 登记表不是
 *     白名单垃圾桶，用不上的一条就得删；
 *   - 空登记表（`[]`）是合法状态，本片（GY-R67-A03）就是零条目：11 处回退之后目标文件未改且行号恒等。
 *
 * 已知限制（**不是正确语义**，见本文件末尾的常驻用例）：整条锚点被删掉时，扫描面里只剩「旧锚点」，
 * 没有新锚点可比对，判不了「该不该删」—— 判红会误伤正常删除，所以只**计数并逐条列进 diagnostic**
 * （`removed` 桶），不判红。删锚点这件事因此是「可观测但放行」。相应地，这类提交的 `judged` 可能是 0，
 * 「扫描面非空」的自证落在「每个抽到的 token 都进了某个桶（判定／已删／未判）」上；只有「抽到 0 个
 * token」（纯散文改动、整行没有锚点）才显式 SKIP 为「无判定面」，绝不静默记成 PASS。
 *
 * CI 历史可用性：`actions/checkout` 默认 `fetch-depth: 1`，`.github/workflows/engineering-shell.yml`
 * 的 `unit` job 与 `docs` job 都**没有**带 `fetch-depth`（全仓只有 `local-wechat.yml` 带
 * `fetch-depth: 0`），浅克隆下 `git merge-base` 拿不到 base。本用例不放任自己在 CI 上变成空转：
 *   - CI 环境（`CI` 或 `GITHUB_ACTIONS==='true'`）且取不到 base ⇒ **机会性自愈**：
 *     `git fetch --depth=1 origin +refs/heads/main:refs/remotes/origin/main`（公开仓匿名可 fetch；
 *     25 秒超时；失败不抛到用例外面），仍取不到再退一步 `git fetch --deepen=100 origin`
 *     （Action 的浅克隆会把 HEAD 的历史也截断，只加深 main 一侧往往仍无共同祖先）；
 *     自愈成功后**重新取 base 并真跑判定**，不许再 SKIP。
 *   - 只有 fetch 本身因为**网络/认证**失败（断网、DNS 不通、remote 不存在、仓库不可达）才允许 SKIP，
 *     并且文案必须写「网络取 base 失败，本用例未执行」+ 每招的尝试记录；`couldn't find remote ref`
 *     这类「远端没有那个 ref」不算网络故障，会继续试下一招（`--deepen=100`）。非「无历史」类错误
 *     （权限、仓库损坏）一律 rethrow。
 *   - 非 CI 的浅克隆不做自愈，显式 `t.skip` 并打印原因（沿用 `tests/ui-adaptive.test.mjs:303-324`
 *     的既有约定：绝不静默 return 让 node:test 记成 PASS）。
 *   - 下面那批「变异夹具」用例不依赖本仓库历史，任何环境下都会真跑 —— 即使主用例因浅克隆 SKIP，
 *     这条闸门的判别逻辑仍然被现场验证过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REGISTRY_RELATIVE = 'tests/unit/doc-anchor-relocations.json';
const MAX_BUFFER = 512 * 1024 * 1024;
/** 自愈 fetch 的超时：CI 里卡住的网络不该把整个 unit job 拖死。 */
const FETCH_TIMEOUT_MS = 25_000;

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
 * 机会性自愈：浅克隆里把 base 拉回来。
 * 先按审查方指定的 refspec 补 `origin/main`；这一招失败（例如远端根本没有 `refs/heads/main`）不当作
 * 网络故障，继续下一招 `--deepen=100`（Actions 的 `fetch-depth: 1` 把 HEAD 的历史也截断了，
 * 只补 main 一侧两端仍不相连，加深才能让共同祖先恢复）。
 * 返回 `{ resolved, failure }`：`failure === 'network'` 表示**确实**有 fetch 因为网络/认证失败
 * （唯一允许 SKIP 的情形）；`failure === 'no-base'` 表示 fetch 都跑过了但仍无共同祖先。
 */
function selfHealBase(root, attempts) {
  const steps = [
    {
      label: 'git fetch --depth=1 origin +refs/heads/main:refs/remotes/origin/main',
      args: ['fetch', '--depth=1', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
    },
    { label: 'git fetch --deepen=100 origin', args: ['fetch', '--deepen=100', 'origin'] },
  ];
  let networkError = null;
  for (const step of steps) {
    try {
      git(step.args, { cwd: root, timeout: FETCH_TIMEOUT_MS });
    } catch (error) {
      const detail = firstLine(error.stderr ?? error.message);
      attempts.push(`${step.label} → ${detail}`);
      if (NETWORK_ERROR.test(detail) && networkError === null) networkError = `${step.label} → ${detail}`;
      continue;
    }
    const retried = resolveBase(root);
    attempts.push(...retried.attempts);
    if (retried.sha !== null) {
      attempts.push(`${step.label} → 成功，base = ${retried.sha.slice(0, 12)}（${retried.label}）`);
      return { resolved: retried, failure: null };
    }
    attempts.push(`${step.label} → 成功，但 merge-base 仍取不到`);
  }
  return { resolved: null, failure: networkError === null ? 'no-base' : 'network', networkError };
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
  return null;
};

/**
 * 判定核心。全部结论现场重算，不做任何缓存跨调用复用（夹具用例拿同一棵树跑多次不同登记表）。
 * 返回 `{ violations, unresolved, removed, registered, pairs, stats, reason }`。
 */
function judge({ root = ROOT, base, head, registry = [], registryProblems = [] }) {
  const violations = registryProblems.map((problem) => `[登记表] ${problem}`);
  const unresolved = [];
  const removed = [];
  const registered = [];
  const pairs = [];
  const stats = {
    docFiles: 0, docLines: 0, tokens: 0, pairs: 0, judged: 0,
    identical: 0, relocated: 0, registered: 0, removed: 0,
  };
  const empty = (reason) => ({ violations, unresolved, removed, registered, pairs, stats, reason });

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
  /**
   * 登记条目按「一次位移」登记，而不是按「一个 token」登记：同一行里 `path:20` 与紧随其后的裸 `:20`
   * 是同一段位移的两种写法（裸锚点会继承前置路径作为 target），因此**同一条登记可以被同一行的多个
   * token 复用**；`usedEntries` 只用来判「这条登记是否真的用上了」（用不上 ⇒ 冗余 ⇒ 判红）。
   * 区间锚点 `path:166-168 → path:177`：登记必须带 `fromEnd`/`toEnd`，按两端逐字比对，不接受只对起点。
   */
  const matchRegistry = (context) => {
    const matchesEndpoint = (token, entryStart, entryEnd) => (
      entryStart === token.start && (token.end === token.start ? entryEnd === undefined : entryEnd === token.end)
    );
    return registry.findIndex((entry) => {
      if (entry === null || typeof entry !== 'object') return false;
      return entry.doc === context.doc
        && entry.line === context.newLineNo
        && (entry.target === context.target || entry.target === context.rawTarget)
        && matchesEndpoint(context.oldToken, entry.from, entry.fromEnd)
        && matchesEndpoint(context.newToken, entry.to, entry.toEnd);
    });
  };

  for (const file of docFiles) {
    for (const hunk of file.hunks) {
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
              const registryIndex = matchRegistry({
                doc: file.path, newLineNo, target, rawTarget: oldToken.target, oldToken, newToken,
              });
              if (registryIndex !== -1) {
                usedEntries.add(registryIndex);
                registered.push(
                  `${label} — 已登记（${registry[registryIndex].reason}）`,
                );
                stats.registered += 1;
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

  // 登记表自身验真：陈旧 / 冗余条目一律判红并点名（登记表不许变成白名单垃圾桶）。
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
    const pairExists = pairs.some(
      (pair) => pair.doc === entry.doc && pair.line === entry.line
        && pair.from === entry.from && pair.to === entry.to
        && (pair.target === resolvedEntryTarget || pair.rawTarget === entry.target),
    );
    if (!pairExists) {
      violations.push(`${label} 陈旧：本次提交的文档改动面里没有这条位移，必须删`);
      continue;
    }
    if (!usedEntries.has(index)) {
      violations.push(
        `${label} 冗余：目标文件本提交有改动，端点映射已经能判这条位移，不需要登记，必须删`,
      );
    }
  }

  stats.registered = registered.length;
  stats.removed = removed.length;
  return { violations, unresolved, removed, registered, pairs, stats, reason: null };
}

/** 判定摘要：绿的时候也要把扫描面、判定量、已登记、已删都打出来，避免「判了 0 条」冒充「全对」。 */
function summarize(result, baseLabel) {
  const { stats } = result;
  return `base=${baseLabel} documented files=${stats.docFiles} docLines=${stats.docLines} `
    + `tokens=${stats.tokens} pairs=${stats.pairs} judged=${stats.judged} `
    + `identical=${stats.identical} relocated=${stats.relocated} registered=${stats.registered} `
    + `removed=${stats.removed} unresolved=${result.unresolved.length}`;
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
    } else if (heal.failure === 'network') {
      t.skip(
        'SKIP: 网络取 base 失败，本用例未执行 —— CI 里 git fetch 拿不到 origin/main'
        + `（断网或 remote 不可达），不是判定通过。尝试记录：${attempts.join('；')}`,
      );
      return;
    } else if (isShallowRepository(ROOT)) {
      t.skip(
        'SKIP: 无 base 历史，本用例未执行 —— 自愈 fetch 成功但仍取不到共同祖先'
        + `（浅克隆边界未连通）。尝试记录：${attempts.join('；')}`,
      );
      return;
    } else {
      throw new Error(
        '取不到 base，且仓库**不是**浅克隆（完整仓库却没有 origin/main、upstream/main、HEAD~1）—— '
        + `本用例无法判定，也不允许静默通过。尝试记录：${attempts.join('；')}`,
      );
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

  // 自证扫描面非空：防「扫到 0 条 ⇒ 全绿」。
  // `docFiles`/`docLines` 证明扫描面本身有内容；`tokens` 证明确实抽到了锚点（纯散文改动没有锚点，
  // 那是「无判定面」而不是「判定通过」，显式 SKIP 并说明）；最后要求每个 token 都落进了某个桶
  // （判定／已删／未判／判红），否则就是「抽到了却一条没判」的静默漏洞。
  // 判红也必须算进这个桶：判红分支在 `continue` 之前不进 `judged`，漏算会让「确有违规」的场景
  // 反而先撞上这条自证断言，把真正的违规清单埋在一条误导性信息后面。
  const { stats } = result;
  assert.ok(stats.docFiles > 0, `扫描面为空：${base.slice(0, 12)}..${head.slice(0, 12)} 没有任何被改写的文档`);
  // 纯删除型 docs 提交里一行都配不上对（旧行被整行删掉），那种情况由 `removed` 侧承担扫描面：
  // 拿 `docLines > 0` 当唯一门槛会把「合法删除」判成「扫描面为空」的假红。
  assert.ok(
    stats.docLines > 0 || result.removed.length > 0,
    '扫描面为空：既没有配对出任何「旧行→新行」的文档行对，也没有任何被整行删掉/换锚点的旧行'
    + `（docLines ${stats.docLines}／removed ${result.removed.length}）`,
  );
  if (stats.tokens === 0) {
    t.skip(`SKIP: ${base.slice(0, 12)}..${head.slice(0, 12)} 被改写的文档行里没有任何锚点（tokens=0），本用例无判定面`);
    return;
  }
  assert.ok(
    stats.judged + stats.removed + result.unresolved.length + result.violations.length > 0,
    `扫描面为空：抽到 ${stats.tokens} 个锚点，却没有任何一个进入判定桶（判定 ${stats.judged}／`
    + `已删 ${stats.removed}／未判 ${result.unresolved.length}／判红 ${result.violations.length}）`,
  );

  const summary = summarize(result, `${base.slice(0, 12)}（${baseLabel}）`);
  const detail = [
    `；登记表 ${registry.entries.length} 条，其中本次生效 ${result.registered.length} 条`,
    result.registered.length === 0 ? '' : `；已登记：\n${result.registered.map((item) => `    - ${item}`).join('\n')}`,
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

/** 夹具文档里带锚点的那一行在 HEAD 上的行号（登记表要写它）。 */
function anchorDocLine(text) {
  return text.split('\n').findIndex((line) => anchorTokens(line).length > 0) + 1;
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

test('登记表：陈旧条目（旧==新 / 新行号不命中 / 本次没有这条位移）必须判红并点名', (t) => {
  const insertAbove = 4;
  const shifted = FIXTURE_ANCHOR_LINE + insertAbove;
  const headDoc = docFile({ anchor: shifted });
  const repo = fixtureRepo(t, {
    baseFiles: {
      [FIXTURE_TARGET]: serviceFile(),
      [FIXTURE_DOC]: docFile({ anchor: FIXTURE_ANCHOR_LINE }),
    },
    headFiles: { [FIXTURE_TARGET]: serviceFile({ insertAbove }), [FIXTURE_DOC]: headDoc },
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
    ],
  });
  assert.ok(result.violations.length >= 3, `陈旧登记没有逐条判红（只红了 ${result.violations.length} 条）`);
  for (const message of result.violations) assert.match(message, /^\[登记表\] 第 \d+ 条/);
  t.diagnostic(`夹具（陈旧登记）判红 ${result.violations.length} 条`);
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
