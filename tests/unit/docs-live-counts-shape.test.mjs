// 跑的是什么：R72「活文档不许手抄工件总数」这一片（GY-R72／分支 docs/gy-r72-live-count-truth）
// 的四条**形状**判据。它判的不是「数对不对」——数对不对由各自的工具判（
// `node tools/verify-admin-capability-map.mjs --check` 逐字节比能力图 §0 标记块、
// `node tools/verify-contract-status.mjs` 逐字节比台账 §3/§4 生成表、
// `node tools/openapi-route-parity.mjs` 逐字节比对账块），本文件判的是**写法**：
// 一个会随别人合法加路由而变的数，究竟是被抄进了散文，还是留了口子指向能重算的地方。
//
// ── 为什么需要这条闸门（R72 的实测背景）──────────────────────────────────────
// 同一批数字在活文档里被手抄了五六份，各自烂在不同的日子：能力图页首写「36 条 path／45 个
// operation／44 个 x-scope」，实测是 39 条 path／49 个 operation／48 个落在 13 项闭集内（三项
// 全陈旧，不是只错一项）；`docs/ui-contract-binding.md` 写「112 条操作」，`operations.json`
// 现为 127；能力图 §2.1 与台账 §6 也都各抄过一份。这些行的共同点是**抄的时候没有人会红**：
// `verify-doc-anchors` 只认「文件:行号」，`verify-contract-status` 只比生成区，
// `verify-admin-capability-map` 只比 §0 标记块——散文区三不管。于是「块内是闸门保护的实时值，
// 块外散文不受保护」这句话本身成了免责声明：它把责任推给读者，而不是让写错的人红。
//
// ── T1：活文档禁止「<数字> 条|项|个 操作|operation」式复述契约总数 ──────────────
// 扫描面：`docs/*.md` 与 `docs/architecture/**/*.md`（37 个文件）。`docs/verification/**` 是
// 历史快照，按仓规不许改写，**不在扫描面内**（它们记的是「当时读数」，本来就该留住旧数）。
// 跳过：```／~~~ 围栏块（命令输出原样引用）、生成块区间（`<!-- name:begin|start -->` 与
// `<!-- name:end -->` 成对识别的块，那是工具写的，不由人负责）。
// 命中判定（三道串联，缺一不红）：
//   ① 形状：`/(?<![\d.])(\d+)\s*(条|项|个)\s*(操作|operation)(?!Id|Ids)/`——`46 个 operationId`
//      这类带 Id 的写法是 operationId 计数，不是 operation 计数，排除；
//   ② 已声明出处：同一行出现 `以 … 为准`／`标记块`／`机器重算`／`纳入闸门` 任一，视为已经指了
//      能重算的出处，放行（这正是本片给每处数字换上的写法）；
//   ③ 契约上下文：同一行还要出现 `契约|openapi.json|operations.json|校验|validate`。
// 为什么必须有第③条（这条最容易被读成「放水」，所以把实测摆在这里）：2026-11-02 在 37 个活
// 文档上跑只有①②的裸规则，命中 13 处，其中
//   · `docs/architecture/admin-console-capability-map.md` §8 的
//     「~~注册资料与限制资料两页（12 个 operation）~~」是**划掉的历史记录**，§3 明令原样保留；
//   · 同页 §2.2 的「35 处 / 30 个 operation」与「30 个 operation 对应 35 处物理调用点」被
//     `tests/unit/admin-console-capability-op-claims.test.mjs` 钉着（那条闸门逐个 claim 判
//     「这个行号是不是该 op 的调用点」），本片改它们等于改别人正在护着的行。
// 加上第③条之后命中降到 3 处，且三处**全是契约总数**（`ui-contract-binding.md` 的
// 「112 条操作」、`ai-ops-spec-status.md` 的「契约共 118 个 operation」、能力图 §3 表里的
// 「契约只有 2 个 operation」），本片三处全部订正。所以这条闸门判的口径是：**契约侧的总数
// 不许抄**；分区级的手数（§2.2 的 30/35）归各自已有的闸门，不在这里重复判。
// 反空转：`docs/architecture/admin-console-capability-map.md`、`docs/ui-state-inventory.md`、
// `docs/development-progress.md` 必须都在扫描集里——少扫一个文件就让 T1 变成空转。
//
// ── T2：`assets/…` 这类证据路径必须真的解得开 ────────────────────────────────
// `docs/ui-state-inventory.md` 曾写「15 张已入库（`assets/gui-adaptive-250c4d4/`）」，而
// 仓库根**没有** `assets/` 目录：读者照这句去找会扑空，而任何闸门都不管散文里的相对路径。
// 判据：`docs/**` 里出现的 `…assets/…` 路径，`docs/` 开头的按仓库根解析、其余按**该文档所在
// 目录**解析，必须存在且非空（目录至少含一个文件）。
// 形状豁免两条（只放行例子，不放行真路径）：`assets/` 后第一段含点（`assets/b.md` 这种文件名
// 示例），以及路径紧接着 `…`／`·`（`docs/verification/assets/i07-…/x.mjs` 这种截断示例）——
// 这两条实测只在 `docs/verification/**` 的历史页里出现，是举例不是承诺。
// 反空转：至少命中 1 条（现在命中的是 `docs/ui-state-inventory.md` 的截图目录），否则说明
// 正则已经抽不到任何东西了。
//
// ── T3：`以 X 为准` 的 X 必须解得到 ─────────────────────────────────────────
// ①②两种豁免都靠「以 … 为准」这句话成立，所以这句话自己得有判据，否则把 X 写成「某个以后会
// 有的文件」就能换一张免死金牌。全库现有 20 处 `以 `X` 为准`，X 里混着提交号、环境变量
// （`CHAT_LLM_API_KEY`）、代码表达式（`store.getJob(row.id)`）、命令——全库硬判会误伤，所以
// **T3 只扫本片改动过的 7 个文档**，且要求带反引号。X 通过的条件（任一）：
//   · 7–40 位十六进制提交号，且 `git rev-parse --verify --quiet <X>^{commit}` 可解析；
//   · `node`／`npm`／`python`／`git`／`gh` 开头的命令：命令里出现的脚本路径必须存在，
//     `npm run <script>` 的 script 必须真的在 `package.json` 里（`git`／`gh` 只认前缀）；
//   · 存在的仓库路径：仓库根相对、文档同目录相对、或全库唯一同名文件。
// 反空转：至少命中 1 条并把解析结果打出来。
//
// ── T4：生成块只许工具改 ────────────────────────────────────────────────────
// 三处活生成块（能力图 §0、台账 §3/§4 表、对账块）各**恰好一对**有序 begin/start…end 标记、
// 块非空；块首形状必须还是工具写的那一行。这里钉的是「块还在、还是那个形状」——块内容对不对
// 归三个工具（`--check` 逐字节比），本文件不重复实现它们。
// 另外本片触及的 7 个文档里**禁出现「未纳入闸门」**：那句话是这轮要拆掉的免责声明，换上的写法
// 都是可解析的指针（受 T3 判）。这条是形状判据（禁一个短语），不是数量判据。
//
// ── 诚实边界（别把四条绿读成「散文数字都可信了」）─────────────────────────────
// T1 只判「契约总数」这一类写法，且只有两种绕过方式需要评审看见：给数字套上「…」引号剥掉
// （第①步先剥「」内文），或在同一行补一句「以…为准」。T2 只认 `assets/` 这一种相对路径前缀，
// `verification/xxx.png`、`../foo` 之类不在判据内。T3 只覆盖 7 个文档里带反引号的 `以`…`为准`。
// T4 不判块内容。所以四条全绿只等于：本片要拆的四个口子现在是关着的。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// 本片改动过的 7 个活文档（T3、T4 的扫描面）
const TOUCHED_DOCS = [
  'docs/architecture/admin-console-capability-map.md',
  'docs/architecture/contract-implementation-status.md',
  'docs/architecture/validation.md',
  'docs/architecture/ai-ops-spec-status.md',
  'docs/ui-contract-binding.md',
  'docs/ui-state-inventory.md',
  'docs/development-progress.md',
];

// 三处活生成块：文件 → 标记名
const GENERATED_BLOCKS = [
  { file: 'docs/architecture/admin-console-capability-map.md', name: 'admin-capability-map', open: 'begin' },
  { file: 'docs/architecture/contract-implementation-status.md', name: 'contract-status-tables', open: 'start' },
  { file: 'docs/architecture/openapi-route-parity.md', name: 'openapi-route-parity', open: 'start' },
];

const CLAIM_RE = /(?<![\d.])(\d+)\s*(条|项|个)\s*(操作|operation)(?!Id|Ids)/;
const POINTER_RE = /以[^。；\n]{0,60}?为准|标记块|机器重算|纳入闸门/;
const CONTRACT_RE = /契约|openapi\.json|operations\.json|校验|validate/i;
const ASSET_RE = /(?:^|[\s(（`"'|])((?:docs\/)?(?:[A-Za-z0-9_.-]+\/)*assets\/[A-Za-z0-9_.\/-]+)/g;

function abs(rel) {
  return path.join(ROOT, rel);
}

function readLines(rel) {
  return readFileSync(abs(rel), 'utf8').split('\n');
}

function walkMarkdown(dirRel) {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(abs(rel)).sort()) {
      const childRel = `${rel}/${entry}`;
      const st = statSync(abs(childRel));
      if (st.isDirectory()) walk(childRel);
      else if (entry.endsWith('.md')) out.push(childRel);
    }
  };
  walk(dirRel);
  return out;
}

// 活文档：docs/*.md 与 docs/architecture/**/*.md，排除 docs/verification/**
function liveDocs() {
  const topLevel = readdirSync(abs('docs'))
    .filter((e) => e.endsWith('.md') && statSync(abs(`docs/${e}`)).isFile())
    .map((e) => `docs/${e}`);
  return [...topLevel, ...walkMarkdown('docs/architecture')].sort();
}

const FENCE_RE = /^\s*(```|~~~)/;

function generatedRanges(lines) {
  const ranges = [];
  const open = new Map();
  lines.forEach((line, i) => {
    const begin = line.match(/<!--\s*([A-Za-z0-9_.:-]+?):(begin|start)\s*-->/);
    if (begin) {
      open.set(begin[1], i);
      return;
    }
    const end = line.match(/<!--\s*([A-Za-z0-9_.:-]+?):end\s*-->/);
    if (end && open.has(end[1])) {
      ranges.push([open.get(end[1]), i]);
      open.delete(end[1]);
    }
  });
  return ranges;
}

// 返回 [{no, text, skipped}]；skipped=围栏块内或生成块区间内
function scannableLines(lines) {
  const ranges = generatedRanges(lines);
  let fence = null;
  return lines.map((text, i) => {
    const fenceHit = text.match(FENCE_RE);
    let skipped = false;
    if (fenceHit) {
      const mark = fenceHit[1];
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
      skipped = true;
    } else if (fence !== null) {
      skipped = true;
    }
    if (ranges.some(([a, b]) => i >= a && i <= b)) skipped = true;
    return { no: i + 1, text, skipped };
  });
}

function stripQuoted(text) {
  return text.replace(/「[^」]*」/g, '「」');
}

function uniqueBasenames() {
  const SKIP = new Set(['.git', 'node_modules', 'dist', 'coverage', '.pg17']);
  const seen = new Map();
  const walk = (rel) => {
    for (const entry of readdirSync(abs(rel)).sort()) {
      if (SKIP.has(entry)) continue;
      const childRel = `${rel}/${entry}`;
      if (statSync(abs(childRel)).isDirectory()) walk(childRel);
      else seen.set(entry, (seen.get(entry) ?? 0) + 1);
    }
  };
  walk('.');
  return seen;
}

function commitResolves(x) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${x}^{commit}`], {
      cwd: ROOT,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

function pathResolves(x) {
  const rel = x.replace(/\/+$/, '');
  if (rel === '') return false;
  return existsSync(abs(rel));
}

function npmScriptExists(name) {
  const pkg = JSON.parse(readFileSync(abs('package.json'), 'utf8'));
  return Object.prototype.hasOwnProperty.call(pkg.scripts ?? {}, name);
}

// 「以 `X` 为准」里 X 的三种合法形态：提交号 / 命令 / 存在的路径
function pointerResolves(x, docRel) {
  if (/^[0-9a-f]{7,40}$/i.test(x)) return commitResolves(x);

  const cmd = x.match(/^(node|npm|python3?|gh|git)\s+(.+)$/);
  if (cmd) {
    const [tool, rest] = [cmd[1], cmd[2]];
    if (tool === 'git' || tool === 'gh') return true;
    if (tool === 'npm') {
      const m = rest.match(/^run\s+([A-Za-z0-9:_.-]+)/);
      return m ? npmScriptExists(m[1]) : false;
    }
    const args = rest.split(/\s+/).filter((a) => a !== '' && !a.startsWith('-'));
    return args.some((a) => pathResolves(a));
  }

  if (/\s/.test(x)) return false;
  const candidates = [x];
  if (!x.startsWith('docs/')) candidates.push(path.posix.join(path.posix.dirname(docRel), x));
  if (candidates.some((c) => pathResolves(c))) return true;
  // 全库唯一同名文件（例：`project.config.json`）
  const basenames = uniqueBasenames();
  return basenames.get(path.posix.basename(x)) === 1;
}

test('T1 活文档不得手抄契约总数（§docs/architecture 与 docs/*.md，排除 docs/verification）', () => {
  const files = liveDocs();
  // 反空转：这三个文件必须被扫到，否则这条闸门等于没开
  for (const required of [
    'docs/architecture/admin-console-capability-map.md',
    'docs/ui-state-inventory.md',
    'docs/development-progress.md',
  ]) {
    assert.ok(files.includes(required), `扫描集缺了 ${required}`);
  }
  assert.ok(!files.some((f) => f.startsWith('docs/verification/')), 'docs/verification 是历史快照，不该进扫描面');

  const violations = [];
  for (const rel of files) {
    for (const line of scannableLines(readLines(rel))) {
      if (line.skipped) continue;
      const text = stripQuoted(line.text);
      if (!CLAIM_RE.test(text)) continue;
      if (POINTER_RE.test(text)) continue;
      if (!CONTRACT_RE.test(text)) continue;
      violations.push(`${rel}:${line.no} ${line.text.trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(violations, [], `活文档又抄了一份契约总数（要留着数字就换成「以 X 为准」的指针）：\n${violations.join('\n')}`);
});

test('T2 docs 里的 assets/… 证据路径必须存在且非空', () => {
  const files = [...walkMarkdown('docs')];
  const violations = [];
  let hits = 0;
  for (const rel of files) {
    for (const line of scannableLines(readLines(rel))) {
      if (line.skipped) continue;
      for (const match of line.text.matchAll(ASSET_RE)) {
        const raw = match[1];
        const segment = raw.split('assets/')[1] ?? '';
        const head = segment.split('/')[0];
        // 形状豁免：文件名示例（含点）与截断示例（后接 … 或 ·）
        if (head.includes('.')) continue;
        const after = line.text.slice(match.index + match[0].length);
        if (/^[）)]?\s*(…|·)/.test(after)) continue;
        hits += 1;
        const target = raw.startsWith('docs/') ? raw : path.posix.join(path.posix.dirname(rel), raw);
        const rel2 = target.replace(/\/+$/, '');
        const full = abs(rel2);
        if (!existsSync(full)) {
          violations.push(`${rel}:${line.no} ${raw} → 解析成 ${rel2}，不存在`);
          continue;
        }
        const st = statSync(full);
        if (st.isDirectory()) {
          const entries = readdirSync(full).filter((e) => statSync(path.join(full, e)).isFile());
          if (entries.length === 0) violations.push(`${rel}:${line.no} ${raw} → 解析成 ${rel2}，目录里没有文件`);
        } else if (st.size === 0) {
          violations.push(`${rel}:${line.no} ${raw} → 解析成 ${rel2}，文件是空的`);
        }
      }
    }
  }
  assert.ok(hits >= 1, '一条 assets/ 路径都没抽到，正则已经空转');
  assert.deepEqual(violations, [], `证据路径找不到：\n${violations.join('\n')}`);
});

test('T3 本片文档里的「以 `X` 为准」必须解得到（文件/命令/提交号）', () => {
  const violations = [];
  const resolved = [];
  const seen = new Set();
  for (const rel of TOUCHED_DOCS) {
    for (const line of scannableLines(readLines(rel))) {
      for (const match of line.text.matchAll(/以\s*`([^`]+)`[^。；\n]{0,60}?为准/g)) {
        const x = match[1].trim();
        seen.add(x);
        if (pointerResolves(x, rel)) {
          resolved.push(`${rel}:${line.no} ${x}`);
        } else {
          violations.push(`${rel}:${line.no} 「以 \`${x}\` 为准」解不到（不是存在的路径/命令/提交号）`);
        }
      }
    }
  }
  assert.ok(seen.size >= 1, `本片 7 个文档里一处「以 \`X\` 为准」都没有，指针判据空转（曾解析成功：${resolved.join('；')}）`);
  assert.deepEqual(violations, [], `指针指向了不存在的东西：\n${violations.join('\n')}`);
});

test('T4 生成块形状受钉，且本片文档里不再出现「未纳入闸门」式自认', () => {
  for (const block of GENERATED_BLOCKS) {
    const lines = readLines(block.file);
    const opens = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.includes(`<!-- ${block.name}:${block.open} -->`));
    const ends = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.includes(`<!-- ${block.name}:end -->`));
    assert.equal(opens.length, 1, `${block.file} 的 ${block.name} 起始标记应当恰好一个`);
    assert.equal(ends.length, 1, `${block.file} 的 ${block.name} 结束标记应当恰好一个`);
    const start = opens[0].i;
    const end = ends[0].i;
    assert.ok(end - start >= 3, `${block.file} 的 ${block.name} 块空了（${start + 1}→${end + 1}）`);
    const body = lines.slice(start, end + 1);

    if (block.name === 'admin-capability-map') {
      assert.ok(
        body[1].startsWith('> 本块由 `node tools/verify-admin-capability-map.mjs --update`'),
        `${block.file}:${start + 2} 块首行不再是工具自述（生成器改了就同步抬这条）`,
      );
      assert.ok(body.includes('| 读数 | 值 |'), `${block.file} 读数表头不见了`);
      for (const key of [
        'totalOps',
        'families',
        'withUiEntry',
        'noUiEntry',
        'deadButtons',
        'operationsWithEvidence',
        'uiEntryViews',
        'uiRefFiles',
        'unreachableViews',
      ]) {
        assert.ok(body.some((l) => l.startsWith(`| ${key} |`)), `${block.file} 读数表少了 ${key} 行`);
      }
    }

    if (block.name === 'contract-status-tables') {
      const header = '| 操作 id | 方法与路径 | 状态 | 证据 | 缺口 / 条件 |';
      for (const [heading, pattern] of [
        ['## 3 已装配操作（', /^## 3 已装配操作（\d+ 条）$/],
        ['## 4 未装配操作（', /^## 4 未装配操作（\d+ 条）$/],
      ]) {
        const idx = body.findIndex((l) => l.startsWith(heading));
        assert.ok(idx >= 0, `${block.file} 少了「${heading}…条）」标题行`);
        // 标题行只允许「（<n> 条）」这一处变化，形状本身受钉
        assert.match(body[idx], pattern, `${block.file} 的第 ${idx + start + 1} 行标题形状变了`);
        const nextTableLine = body.slice(idx + 1).find((l) => l.trim().startsWith('|'));
        assert.equal(nextTableLine, header, `${block.file} 的「${heading}」那节第一张表的表头形状变了`);
      }
    }

    if (block.name === 'openapi-route-parity') {
      const firstContent = body.slice(1).find((l) => l.trim() !== '');
      assert.match(
        firstContent,
        /^契约版本：`[^`]+`；生成命令：`node tools\/openapi-route-parity\.mjs --write-doc`/,
        `${block.file}:${start + 2} 块首内容行不再是生成器写的版本/命令行`,
      );
      assert.ok(body.includes('| 指标 | 读数 |'), `${block.file} 指标表头不见了`);
    }
  }

  const confessions = [];
  for (const rel of TOUCHED_DOCS) {
    readLines(rel).forEach((text, i) => {
      if (text.includes('未纳入闸门')) confessions.push(`${rel}:${i + 1} ${text.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(
    confessions,
    [],
    `这轮要拆的就是这句免责声明：换成可解析的指针（受 T3 判），不要只说「不在闸门内」：\n${confessions.join('\n')}`,
  );
});
