/**
 * 文档手写行号闸门的守卫：`tools/verify-doc-anchors.mjs` 的三条负控制 + 基线陈旧反查。
 *
 * 缺口（为什么需要这个文件）：`docs/**` 里大量引用写成 `services/api/src/app.ts:17-30` 这种
 * **手写行号**，没有任何机械校验——代码一动，行号就漂，文档继续当「实现就在这几行」的证据。
 * `#456` 的 `--reanchor` 只覆盖 `contract-status.json` 里 `source_anchor` 的结构化锚点，
 * 覆盖不到散文里的行号。本文件钉住新闸门本身，防止它退化成「扫了个寂寞」或「永远红」。
 *
 * 三条负控制（缺一条就证明不了闸门真的在判）：
 *   ① 路径不存在   → BROKEN
 *   ② 起止超出文件行数 → OUT_OF_RANGE
 *   ③ 区间全空行／全右括号 → SUSPECT
 * 另外三条正向控制防「永远红」与「误伤」：合法引用不报、引用注释块不报、URL／IP 端口不被当成引用。
 *
 * 基线（`tools/doc-anchors-baseline.json`）是**人工裁决过的历史遗留**，不是免罚名单，故这里要求
 * 双向一致：既有条目必须**仍然命中**（stale 反查），当前扫描也不许有**基线外新增**。
 * 修好一条旧引用 ⇒ 基线那一条就陈旧 ⇒ 本测试点名要求删掉它；把新问题塞进基线 ⇒ 新增为 0 但
 * 「基线外新增」这条不变量仍会由 `--strict`（`npm run verify:anchors`）在 CI 之外的地方咬住。
 *
 * 全部用临时目录夹具 + 直接调 `main()`，⛔ 不 spawn 子进程、不联网、不写仓库内文件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BARE_ORPHAN,
  BROKEN,
  NOT_SYMBOL_LINE,
  OUT_OF_RANGE,
  REASONS,
  SUSPECT,
  anchorCountDocumentsDigest,
  attributeBareAnchors,
  collectFindings,
  extractReferences,
  loadAnchorCountBaseline,
  loadBaseline,
  loadOrphanBaseline,
  main,
  partitionByBaseline,
  renderBaseline,
  segmentDocumentBlocks,
  splitLines,
} from '../../tools/verify-doc-anchors.mjs';

/** 仓库根：由本文件位置推出（tests/unit/ → ../..），⛔ 不用 `process.cwd()`（与仓内其它守卫同口径）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 收集 `main()` 的输出，避免测试刷屏，同时能断言「读数里必须出现哪一类」。 */
function capture(args) {
  const stdout = [];
  const stderr = [];
  const code = main(args, { log: line => stdout.push(line), error: line => stderr.push(line) });
  return { code, stdout, stderr, text: [...stdout, ...stderr].join('\n') };
}

/**
 * 生成模式（`--emit-*-baseline`）把 JSON 直接写 `process.stdout`，不走 `streams.log`——
 * 那是有意的（emit 的输出要能原样重定向成文件），所以这里短暂接管 `process.stdout.write` 把它捞回来。
 */
function captureEmit(args) {
  const original = process.stdout.write;
  let out = '';
  process.stdout.write = chunk => {
    out += String(chunk);
    return true;
  };
  try {
    return { ...capture(args), stdout: out };
  } finally {
    process.stdout.write = original;
  }
}

/** 在临时目录里搭一棵最小仓库：`docs/architecture/*.md` + `src/*.ts` + `tools/`。 */
function makeFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'gy-doc-anchors-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

/**
 * 三条负控制各占一份文档，便于断言「哪一条被点成哪一类」。
 * 夹具路径按仓库真实布局放（`services/api/src/**`）：文档里既写全路径（直连），
 * 也写相对子路径 `src/ok.ts`（走「唯一后缀匹配」那一档），两条解析路径都要覆盖到。
 */
const NEGATIVE_CONTROLS = {
  'services/api/src/ok.ts': ['const a = 1;', 'const b = 2;', 'export { a, b };', '// 收尾注释', 'const c = 3;', ''].join('\n'),
  'services/api/src/blank.ts': ['const header = 1;', '', '', '  })', 'const tail = 2;', ''].join('\n'),
  'docs/architecture/valid.md': '合法引用：见 `services/api/src/ok.ts:1-3`，以及相对写法 `src/ok.ts:1`。\n',
  'docs/architecture/broken.md': '假引用：`src/missing.ts:1-9`（该文件不存在）。\n',
  'docs/architecture/range.md': '越界引用：`src/ok.ts:4-999`（文件只有 5 行）。\n',
  'docs/architecture/suspect.md': '指到空行的引用：`src/blank.ts:2-4`（全是空行与收尾括号）。\n',
  // 正向控制：引用注释块是合法证据形态，不得判 SUSPECT（否则证据页引用 workflow 判据注释全变噪声）。
  'services/api/src/commented.ts': ['export const X = 1;', '// 判据注释：这一行就是被引用的不变量', ''].join('\n'),
  'docs/architecture/comment-only.md': '引用注释：`src/commented.ts:2`。\n',
};

test('负控制①：路径不存在 ⇒ BROKEN（且只点这一条，合法引用不陪绑）', () => {
  const root = makeFixture(NEGATIVE_CONTROLS);
  try {
    const { findings, stats } = collectFindings({ root, targets: ['docs/architecture'] });
    const broken = findings.filter(finding => finding.reason === BROKEN).map(finding => finding.reference);
    assert.deepEqual(broken, ['src/missing.ts:1-9'], '路径不存在必须且只能判出一条 BROKEN');
    assert.equal(stats.counts[BROKEN], 1);

    // 合法引用不陪绑：全路径与相对子路径两种写法都不该有 finding（后缀唯一匹配 + 区间有内容）。
    const validReferences = ['services/api/src/ok.ts:1-3', 'src/ok.ts:1'];
    const flagged = findings
      .map(finding => `${finding.reason} ${finding.reference}`)
      .filter(line => validReferences.some(reference => line.endsWith(` ${reference}`)));
    assert.deepEqual(flagged, [], '合法引用被误判，说明判据在误伤');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('负控制②：起止超出文件行数 ⇒ OUT_OF_RANGE（附真实行数）', () => {
  const root = makeFixture(NEGATIVE_CONTROLS);
  try {
    const { findings } = collectFindings({ root, targets: ['docs/architecture'] });
    const outOfRange = findings.filter(finding => finding.reason === OUT_OF_RANGE);
    assert.deepEqual(outOfRange.map(finding => finding.reference), ['src/ok.ts:4-999']);
    assert.match(outOfRange[0].detail, /5 行/, '读数必须带上该文件真实行数，否则维护者没法判断差多少');
    assert.equal(outOfRange[0].doc, 'docs/architecture/range.md');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('负控制③：区间全空行／全右括号 ⇒ SUSPECT；纯注释区间不判红（不误伤合法证据）', () => {
  const root = makeFixture(NEGATIVE_CONTROLS);
  try {
    const { findings, stats } = collectFindings({ root, targets: ['docs/architecture'] });
    const suspect = findings.filter(finding => finding.reason === SUSPECT).map(finding => finding.reference);
    assert.deepEqual(suspect, ['src/blank.ts:2-4'], '区间无实质内容必须且只能判出一条 SUSPECT');
    assert.equal(stats.commentOnly, 1, '纯注释区间应当只计数（stats.commentOnly=1），不得进 findings');
    assert.deepEqual(
      findings.map(finding => finding.reason).filter(reason => reason === SUSPECT).length,
      1,
      '引用注释块被误判成 SUSPECT，会让证据页里几百条合法引用变噪声',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('三类齐全时 dry-run 只打印不减分，--strict 才 exit 1（基线之外新增＝红）', () => {
  const root = makeFixture(NEGATIVE_CONTROLS);
  try {
    const base = ['--root', root, '--scan', 'docs/architecture', '--baseline', 'tools/doc-anchors-baseline.json'];

    const dry = capture(base);
    assert.equal(dry.code, 0, 'dry-run 只打印清单，不判退出码');
    for (const reason of [BROKEN, OUT_OF_RANGE, SUSPECT]) {
      assert.match(dry.text, new RegExp(`^${reason} `, 'm'), `dry-run 清单必须出现 ${reason} 那一类`);
    }

    // 空基线＝所有问题都算新增 ⇒ 必须有非零退出码，否则闸门等于没有。
    const strictWithoutBaseline = capture([...base, '--strict']);
    assert.equal(strictWithoutBaseline.code, 1, '--strict 在基线外有新增时必须 exit 1');
    assert.match(strictWithoutBaseline.text, /FAIL: 文档行号闸门未通过/);
    assert.match(strictWithoutBaseline.text, /src\/missing\.ts:1-9/, '失败信息必须点名具体引用');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('基线把已知问题降噪成「只计数」，但不做成免罚名单：新问题仍然红', () => {
  const root = makeFixture(NEGATIVE_CONTROLS);
  try {
    const base = ['--root', root, '--scan', 'docs/architecture', '--baseline', 'tools/doc-anchors-baseline.json'];
    const { findings } = collectFindings({ root, targets: ['docs/architecture'] });
    assert.equal(findings.length, 3, '夹具应当恰好有 3 条问题（BROKEN／OUT_OF_RANGE／SUSPECT 各一）');
    mkdirSync(join(root, 'tools'), { recursive: true });
    writeFileSync(join(root, 'tools', 'doc-anchors-baseline.json'), renderBaseline(findings));

    // 基线内条目：--strict 必须 exit 0（历史遗留不该把门禁钉成永红）。
    const known = capture([...base, '--strict']);
    assert.equal(known.code, 0, `基线内条目必须放行，实际 exit ${known.code}：${known.text}`);
    assert.match(known.text, /登记 3 条/);

    // 追加第 4 条新问题：基线不得把新问题一起放行。
    writeFileSync(join(root, 'docs/architecture/fresh.md'), '新问题：`src/ok.ts:1-999`。\n');
    const fresh = capture([...base, '--strict']);
    assert.equal(fresh.code, 1, '基线外新增必须 exit 1，否则基线就成了免罚名单');
    assert.match(fresh.text, /基线之外新增 1 条/);
    assert.match(fresh.text, /src\/ok\.ts:1-999/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('正向控制：干净文档集在空基线下也 exit 0（闸门不是「永远红」）', () => {
  const root = makeFixture({
    'services/api/src/ok.ts': 'const a = 1;\nexport default a;\n',
    'docs/architecture/clean.md': '见 `services/api/src/ok.ts:1-2`。\n',
  });
  try {
    const result = capture(['--root', root, '--scan', 'docs/architecture', '--strict']);
    assert.equal(result.code, 0, `没有问题时必须 exit 0，实际：${result.text}`);
    assert.match(result.text, /COUNT: BROKEN 0 \/ OUT_OF_RANGE 0 \/ SUSPECT 0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('抽取口径：URL 与 IP:端口不是仓内引用，`路径:单行` 与 `路径:起-止` 都要抽到', () => {
  const references = extractReferences([
    '见 `services/api/src/app.ts:17-30` 与 `docs/a.md:5`。',
    '链接：https://example.com/foo.ts:12 不该被当成引用。',
    'CIDR：`10.20.0.0:16`（IP:端口，不是路径:行号）。',
    '反引号外也认：miniprogram/utils/session.js:9',
  ].join('\n'));
  assert.deepEqual(references.map(reference => reference.reference), [
    'services/api/src/app.ts:17-30',
    'docs/a.md:5',
    'miniprogram/utils/session.js:9',
  ]);
  assert.deepEqual(references.map(reference => [reference.from, reference.to]), [[17, 30], [5, 5], [9, 9]]);

  // 行数口径：末尾换行不算「多一行」，否则每个文件都白送一条可越界的行号。
  assert.equal(splitLines('a\nb\n').length, 2);
  assert.equal(splitLines('a\nb').length, 2);
  assert.equal(splitLines('a\r\nb\r\n').length, 2);
  assert.deepEqual(splitLines('a\r\nb\r\n'), ['a', 'b']);
});

test('基线 stale 反查：`tools/doc-anchors-baseline.json` 每条都必须仍然命中（修好一条就要求删一行）', () => {
  const baseline = loadBaseline(REPO_ROOT);
  assert.equal(baseline.missing, false, `${baseline.path} 必须受版本控制存在（它是门禁的一部分，不是本地产物）`);
  // 数量下限只防"把基线清空"。它不能当作"历史遗留条数不许下降"的守卫：
  // 清空基线的真实后果是这些遗留全部变成「基线外新增」⇒ --strict 立刻红，并不会被静默吃掉；
  // 因此把下限钉在固定数字，只会惩罚"真的把遗留修好"的 PR（2026-10-25 锚点批 A/B 修好 79 条后
  // 从 92 条降到 13 条，撞到这个固定数字）。这里只要求基线非空，且下面仍逐条反查 stale。
  assert.ok(baseline.entries.length >= 1, `基线被清空了（${baseline.entries.length} 条）：清空会让所有遗留变成「新增」而整片红，不是修好它们`);

  const { findings, stats } = collectFindings({ root: REPO_ROOT });
  assert.ok(stats.documents >= 100, `只扫到 ${stats.documents} 份文档，扫描面可能被改坏了`);
  assert.ok(stats.resolved >= 1000, `只解析成功 ${stats.resolved} 条引用，路径解析可能退化了`);

  const { fresh, covered, stale } = partitionByBaseline(findings, baseline.entries);
  assert.deepEqual(
    stale.map(entry => `${entry.reference}（${entry.reason}）`),
    [],
    [
      '以下基线条目已经不再命中（引用被修好，或路径／行号被改过）：',
      ...stale.map(entry => `  · ${entry.reference}（${entry.reason}，owner=${entry.owner ?? '未标'}）`),
      '',
      '请从 tools/doc-anchors-baseline.json 删掉这些行——陈旧条目会把基线慢慢变成免罚名单。',
    ].join('\n'),
  );
  assert.equal(covered.length, baseline.entries.length, '基线命中数与条目数必须一一对应（同一条目不得靠重复命中凑数）');
  assert.deepEqual(
    fresh.map(finding => `${finding.reason} ${finding.doc}:${finding.docLine} → ${finding.reference}`),
    [],
    [
      '有基线之外新增的文档假引用（本测试与 `npm run verify:anchors` 同口径）：',
      ...fresh.map(finding => `  · ${finding.reason} ${finding.doc}:${finding.docLine} → ${finding.reference}`),
      '',
      '改文档的行号区间就改；确属历史遗留、本片不修的，才登记进 tools/doc-anchors-baseline.json（并写明 owner）。',
    ].join('\n'),
  );

  // 三类都要真的出现：只留一类说明判据或扫描面坏了（否则「基线全绿」可能只是扫了个寂寞）。
  for (const reason of [BROKEN, OUT_OF_RANGE, SUSPECT]) {
    assert.ok(
      baseline.entries.some(entry => entry.reason === reason),
      `基线里没有 ${reason} 这一类：判据或扫描面可能已失效`,
    );
  }
});

test('基线条目必须带 path／reason／owner／reference，且 reason 只能是工具认的四类之一', () => {
  const baseline = loadBaseline(REPO_ROOT);
  for (const entry of baseline.entries) {
    assert.equal(typeof entry.path, 'string', `基线条目缺 path：${JSON.stringify(entry)}`);
    assert.ok(entry.path.length > 0);
    assert.equal(typeof entry.reference, 'string', `基线条目缺 reference：${JSON.stringify(entry)}`);
    // 文档里常写相对子路径（`src/app.ts:12`）或裸文件名（`verify-cvm-postgres.sh:186`），
    // 而 `path` 记的是解析后的仓库相对路径，两者只需「同一条尾」，不要求字符串前缀相同。
    const stem = entry.reference.replace(/:\d+(?:-\d+)?$/, '');
    assert.ok(
      entry.path === stem || entry.path.endsWith(`/${stem}`) || stem.endsWith(`/${entry.path}`),
      `reference 与 path 不一致：${JSON.stringify(entry)}`,
    );
    // 四类都得收：`NOT_SYMBOL_LINE` 是「符号引脚落进文档注释」，它只能由结构基线兜（符号基线专管
    // `COMMENT_ANCHOR`），不收它就等于把这一类问题挤回散文改写——正是审查 B2 指出的那条退路。
    assert.ok(REASONS.includes(entry.reason), `reason 不合法（只认 ${REASONS.join(' / ')}）：${JSON.stringify(entry)}`);
    assert.equal(typeof entry.owner, 'string', `基线条目缺 owner（谁去修）：${JSON.stringify(entry)}`);
    assert.ok(entry.owner.length > 0);
  }
});

test('清册与孤儿册受版本控制存在，真实仓上不报「计数下降／孤儿新增」', () => {
  // 这两份册子本身是「判据面的账本」：删掉文件就等于把整面清零，所以它们必须在仓里，
  // 而且必须与当前文档对得上——手改数字由 loader 的算术不变量抓，删文件由这条抓。
  const orphan = loadOrphanBaseline(REPO_ROOT);
  assert.equal(orphan.missing, false, `${orphan.path} 必须受版本控制存在（缺文件等于把所有孤儿清零）`);
  assert.ok(
    orphan.orphans.length > 0 || orphan.outsideRed.length > 0,
    '孤儿册被写成空册：空册会让所有孤儿变成「基线外新增」而整片红，不是把它们修好了',
  );
  const count = loadAnchorCountBaseline(REPO_ROOT);
  assert.equal(count.missing, false, `${count.path} 必须受版本控制存在（缺文件等于把每页的判据面清零）`);
  assert.ok(count.total >= 1000, `清册只登记了 ${count.total} 条进判据锚点，判据面可能被改坏了`);

  const result = capture(['--root', REPO_ROOT, '--strict']);
  assert.equal(result.code, 0, `真实仓在 --strict 下必须绿：\n${result.text}`);
  assert.match(result.text, /ANCHOR-COUNT: .*本次计数下降的文档 0 份/u);
  assert.match(result.text, /BARE-ORPHAN: .*基线外新增 0 条、本次扫描面内陈旧 0 条/u);
  // 钉子：默认面（`--scan docs/architecture` + `--scan docs/verification`，即 `npm run verify:anchors`）
  // 比清册记的 `docs` 窄，所以**正常运行时**就有一批「清册面内、本次面外」的键被合法跳过；
  // 这些跳过必须打印出来（可见），而「面内却扫不到」与「永远扫不到」都必须是 0——
  // 三个数不许对调或合并。`'docs/**\/*.md'` 下也一样：运行面认 glob，换面参数关不掉这两道。
  assert.match(result.text, /面内本次未扫 \d+ 个（清册面内、本次面外：合法跳过）/u);
  assert.match(result.text, /面内却扫不到的键 0 个（按本次面本该扫到却没扫到：判红）/u);
  assert.match(result.text, /永远扫不到的键 0 个（键根本不是可扫的文档：判红）/u);
  // 清册的 documents 摘要：loadAnchorCountBaseline 上面已经跑过，说明摘要字段在且算得准
  // （缺字段或对不上都会在此之前 throw）。
  assert.equal(typeof count.documents_digest, 'string', '清册必须带 documents_digest（手改必炸的那一道）');
});

test('判据是结构性的：不得引入内容哈希（sha256 全等会把任何合法改代码都判红）', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(join(REPO_ROOT, 'tools/verify-doc-anchors.mjs'), 'utf8');
  // 只查**代码**：工具头部注释里专门解释了「为什么不用 sha256」，把那段算进来就是拿说明当违规。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /createHash|node:crypto|sha256sum/i, '闸门判据退化成内容哈希：任何合法改代码都会红，等于制造新的机械红');
  // 判据的核心必须是这三件事（防止有人把它改成「只看路径在不在」而假装三类都判）。
  assert.match(code, /OUT_OF_RANGE/);
  assert.match(code, /SUSPECT/);
  assert.match(code, /BROKEN/);
});

// —— 裸锚点（只写 `:N`／`:N-M`）的同块继承 ————————————————————————————————
//
// 缺口：`ANCHOR_PATTERN` 要求「文件名.扩展名」，于是把 `path:130` 改写成 `:130` 就能让这条锚点
// 彻底离开扫描面——不参与行号越界、不参与 `--symbol=strict`、也不进任何桶（通用后门）。
// 这一组用例钉住「删路径前缀」这条路：**能继承的必须与显式锚点同权判红**，继承不到的必须留在
// `BARE_ORPHAN` 里计数并逐条打印（文档、行号、原文片段、归属失败原因），不许静默消失。
//
// T2 的口径说明（重要）：任务书写的「同段无其它显式锚点 ⇒ 仍必红」与「无法归属的裸锚点今天不判红」
// 在逻辑上互斥——一个块里再没有任何路径可继承时，工具没有任何依据知道 `:20` 指的是哪个文件，
// 判红只能是瞎猜。故 T2 钉的是**可满足的最强性质**：① 同块还有兄弟锚点时，把路径删掉照样红；
// ② 整块一个显式锚点都不剩时，它必须落进 BARE_ORPHAN 且被打印出来（可见，而非静默放行）。

const BARE_CODE = Array.from({ length: 30 }, (_, index) => `export const v${index + 1} = ${index + 1};`);
const BARE_BLANK = ['export const head = 1;', '', '', '  })', 'export const tail = 2;'];
const BARE_OTHER = ['export const p = 1;', 'export const q = 2;', 'export const r = 3;', 'export const s = 4;', 'export const t = 5;'];

/** 裸锚点用例的最小仓：目标源码按行数造（越界档要好算），需要几个就几个。 */
function makeBareFixture(extra) {
  return makeFixture({
    'src/x.mjs': `${BARE_CODE.join('\n')}\n`,
    'src/y.mjs': `${BARE_OTHER.join('\n')}\n`,
    'src/blank.mjs': `${BARE_BLANK.join('\n')}\n`,
    ...extra,
  });
}

const bareScanArgs = root => ['--root', root, '--scan', 'docs/architecture', '--baseline', 'tools/doc-anchors-baseline.json'];

test('T1 裸锚点继承同块显式锚点后与显式同权：行号越界照样判 OUT_OF_RANGE', () => {
  const root = makeBareFixture({
    'docs/architecture/bare-inherit-range.md': '# 标题\n\n同段：`src/x.mjs:3` 与 `:999`（继承后仍要越界判红）。\n',
  });
  try {
    const { findings, stats } = collectFindings({ root, targets: ['docs/architecture'] });
    const outOfRange = findings.filter(finding => finding.reason === OUT_OF_RANGE);
    assert.deepEqual(
      outOfRange.map(finding => finding.reference),
      ['src/x.mjs:999'],
      `继承来的裸锚点必须进同一套越界判据，实际：${JSON.stringify(findings.map(f => `${f.reason} ${f.reference}`))}`,
    );
    assert.equal(outOfRange[0].bare, true, 'finding 要标出它是裸锚点，否则维护者以为文档里写的是全路径');
    assert.deepEqual(outOfRange[0].inheritedFrom, { reference: 'src/x.mjs:3', docLine: 3 }, '要能追溯它继承自哪一条显式锚点');
    assert.match(outOfRange[0].detail, /30 行/, '读数必须带目标文件真实行数');
    assert.equal(stats.bare.inherited, 1);
    assert.equal(stats.bare.judged, 1, '作用域内的裸锚点必须进判据，不能只计数');
    assert.equal(stats.candidates, 1, '裸锚点不混进「抽出引用」条数（candidates 只数显式锚点）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T2 回归钉子：把 `src/x.mjs:20` 改写成裸 `:999` 不能洗白（有兄弟锚点必红，没兄弟锚点必须可见）', () => {
  const root = makeBareFixture({
    // ① 同一段里还有兄弟显式锚点：把自己那条的路径删掉，仍然被继承抓住。
    'docs/architecture/bare-washout.md': '# 标题\n\n见 `src/x.mjs:20`；把这条改写成 `:999` 也要红。\n',
    // ② 整段一个显式锚点都不剩：今天不判红，但必须落进 BARE_ORPHAN 并被打印。
    'docs/architecture/bare-orphan-nail.md': '见 `:5`（路径前缀被删干净）。\n',
  });
  try {
    const { findings, bareOrphans } = collectFindings({ root, targets: ['docs/architecture'] });
    assert.deepEqual(
      findings.map(finding => `${finding.reason} ${finding.reference}`),
      ['OUT_OF_RANGE src/x.mjs:999'],
      '删掉路径前缀必须仍然判红，否则这就是一条「洗白」后门',
    );
    assert.equal(bareOrphans.length, 1, '整块无显式锚点的裸锚点应当且只能有一条进 BARE_ORPHAN');
    assert.equal(bareOrphans[0].doc, 'docs/architecture/bare-orphan-nail.md');
    assert.equal(bareOrphans[0].docLine, 1);
    assert.equal(bareOrphans[0].raw, ':5');
    assert.equal(bareOrphans[0].reason, 'no-explicit-in-block');

    const dry = capture(bareScanArgs(root));
    assert.match(dry.text, new RegExp(`^${BARE_ORPHAN}: 1 条`, 'm'), '孤儿裸锚点必须在报告里点名条数');
    assert.match(dry.text, /· docs\/architecture\/bare-orphan-nail\.md:1 :5（no-explicit-in-block）｜/, '要逐条打印文档:行、原文与原因');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T3 空行后的裸锚点 ⇒ BARE_ORPHAN：不判红，但计数 +1 且逐条打印', () => {
  const root = makeBareFixture({
    'docs/architecture/bare-orphan.md': ['# 标题', '', '见 `src/x.mjs:3`。', '', '这一行前面没有显式锚点：:20。', ''].join('\n'),
  });
  try {
    const { findings, bareOrphans, stats } = collectFindings({ root, targets: ['docs/architecture'] });
    assert.deepEqual(findings, [], '孤儿裸锚点今天不判红（策略见 BARE_ORPHAN 注释），判红就是瞎猜');
    assert.equal(bareOrphans.length, 1);
    assert.equal(bareOrphans[0].docLine, 5, '空行断开后它不在上文的块里');
    assert.equal(bareOrphans[0].reason, 'no-explicit-in-block');
    assert.equal(bareOrphans[0].inScope, true, 'docs/architecture/** 属于判红作用域，孤儿也要标 inScope 便于分派');
    assert.equal(stats.bare.total, 1);
    assert.equal(stats.bare.orphan, 1);
    assert.equal(stats.bare.orphanInScope, 1);
    assert.equal(stats.bare.judged, 0);

    const dry = capture(bareScanArgs(root));
    assert.equal(dry.code, 0, '孤儿裸锚点不影响退出码');
    assert.match(dry.text, new RegExp(`^${BARE_ORPHAN}: 1 条`, 'm'));
    assert.match(dry.text, /bare-orphan\.md:5 :20（no-explicit-in-block）/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T4 同块两个不同路径的显式锚点 + 裸锚点 ⇒ 归 BARE_ORPHAN（不猜路径）', () => {
  const root = makeBareFixture({
    'docs/architecture/bare-ambiguous.md': 'A `src/x.mjs:3`、B `src/y.mjs:4`，然后 `:7` 不知道该算谁。\n',
  });
  try {
    const { findings, bareOrphans } = collectFindings({ root, targets: ['docs/architecture'] });
    assert.deepEqual(findings, [], '路径不唯一时不许猜，更不许拿最近那条当答案');
    assert.equal(bareOrphans.length, 1);
    assert.equal(bareOrphans[0].reason, 'ambiguous-block');
    assert.equal(bareOrphans[0].raw, ':7');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T5 裸区间 `:N-M` 同样继承，并参与 SUSPECT 判定', () => {
  const root = makeBareFixture({
    'docs/architecture/bare-range.md': '见 `src/blank.mjs:1`，区间 `:2-4` 全是空行与收尾括号。\n',
  });
  try {
    const { findings } = collectFindings({ root, targets: ['docs/architecture'] });
    const suspect = findings.filter(finding => finding.reason === SUSPECT);
    assert.deepEqual(suspect.map(finding => finding.reference), ['src/blank.mjs:2-4'], '裸区间继承后必须与显式区间同权判 SUSPECT');
    assert.equal(suspect[0].bare, true);
    assert.deepEqual(suspect[0].inheritedFrom, { reference: 'src/blank.mjs:1', docLine: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T6 围栏代码块（```）内的裸锚点同样继承（块内空行不切断，围栏不逃逸判据）', () => {
  const root = makeBareFixture({
    'docs/architecture/bare-fence.md': ['# 标题', '', '```js', '见 `src/x.mjs:3` 与 `:999`', '```', ''].join('\n'),
  });
  try {
    const { findings, stats } = collectFindings({ root, targets: ['docs/architecture'] });
    assert.deepEqual(
      findings.map(finding => `${finding.reason} ${finding.reference}`),
      ['OUT_OF_RANGE src/x.mjs:999'],
      '代码块里的裸锚点不能成为免检区',
    );
    assert.equal(stats.bare.inherited, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T7 反空转：块切分与扫描面有下界断言（否则「全部孤儿」也能让上面几条看起来绿）', () => {
  const lines = ['# 标题', '', '段落一', '段落一的续行', '', '- 列表项一', '- 列表项二', '', '| a | b |', '', '```', 'code', '```', ''];
  const { blocks } = segmentDocumentBlocks(lines);
  assert.ok(blocks.length >= 6, `合成的文档至少切出 6 块（标题/段落/两个列表项/表格行/代码块），实际 ${blocks.length} 块`);

  const text = lines.join('\n');
  const attribution = attributeBareAnchors({ text, references: extractReferences(text) });
  assert.equal(attribution.blocks, blocks.length, '两处块切分必须同源，否则归属与下界断言各说各话');
  assert.deepEqual(attribution.inherited, [], '这份文档没有裸锚点，继承数必须是 0（不是「什么都没算」）');

  // 空行必须真的断块：紧邻段落里的裸锚点可继承，隔一个空行就不行。
  const adjacent = '见 `src/x.mjs:3` 与 `:9`。\n';
  const separated = '见 `src/x.mjs:3`。\n\n:9\n';
  assert.equal(attributeBareAnchors({ text: adjacent, references: extractReferences(adjacent) }).inherited.length, 1);
  assert.equal(attributeBareAnchors({ text: separated, references: extractReferences(separated) }).orphans.length, 1);
});

test('T8 表格必须按单元格断块：同格可继承，跨格不许继承（跨格继承＝拿另一列的证据冒充这一列的行号）', () => {
  const root = makeBareFixture({
    // 同一格：显式锚点与裸锚点都在第 2 个单元格里 ⇒ 继承成立，`:999` 越界照红。
    'docs/architecture/bare-table-same-cell.md': '# 标题\n\n| 命令 | `src/x.mjs:3` 与 `:999` | note |\n',
    // 跨格：显式锚点在第 2 格、裸锚点在第 3 格 ⇒ 不猜，落孤儿。
    'docs/architecture/bare-table-cross-cell.md': '# 标题\n\n| 命令 | `src/y.mjs:2` | 另见 `:999` |\n',
  });
  try {
    const { findings, bareOrphans } = collectFindings({ root, targets: ['docs/architecture'] });
    assert.deepEqual(
      findings.map(finding => `${finding.reason} ${finding.reference} ← ${finding.doc}`),
      ['OUT_OF_RANGE src/x.mjs:999 ← docs/architecture/bare-table-same-cell.md'],
      `单元格内的裸锚点必须继承并照红；跨单元格那条必须留成孤儿、不许算到 src/y.mjs 头上，实际：${JSON.stringify(findings.map(f => `${f.reason} ${f.reference} ← ${f.doc}`))}`,
    );
    assert.deepEqual(
      bareOrphans.map(item => `${item.doc}:${item.docLine} ${item.raw}（${item.reason}）`),
      ['docs/architecture/bare-table-cross-cell.md:3 :999（no-explicit-in-block）'],
      '跨单元格的裸锚点归不到路径，必须进 BARE_ORPHAN 而不是被同行的另一列吃掉',
    );

    // 对照组：把「同格」这条删掉，剩下那一行必须仍是孤儿——证明上面那条红来自同格继承而不是行内碰巧。
    const direct = '见 `src/y.mjs:2` 与 `:999` 同格。\n';
    assert.equal(attributeBareAnchors({ text: direct, references: extractReferences(direct) }).inherited.length, 1);
    const tableRow = '| a | `src/y.mjs:2` | `:999` |\n';
    assert.equal(
      attributeBareAnchors({ text: tableRow, references: extractReferences(tableRow) }).inherited.length,
      0,
      '表格行里跨单元格的裸锚点一条都不许继承（去掉单元格判据就会变成 1，此断言即反空转钉子）',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// —— 锚点清册与孤儿册（第二轮审查的阻塞 1／阻塞 2）————————————————————
// 这两道判据管的不是「锚点写错了」，而是「锚点**不见了**」：结构四判据只审已经出现的锚点，
// 把 `src/x.mjs:3` 整条改写成「见第 3 行」，它就从判据面上干净消失、四类判据全绿。清册与孤儿册
// 把「该出现的还在不在」「放弃判据的那一条登记过没有」也变成判据，而且改册子必须留名（--accept + --why）。

/** 在夹具里补写一份文件（基线 JSON 也要落进临时仓，`--root` 才会读到它）。 */
function writeIn(root, relativePath, content) {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

const COUNT_BASELINE = 'tools/doc-anchors-anchor-count-baseline.json';
const ORPHAN_BASELINE = 'tools/doc-anchors-orphan-baseline.json';
const COUNT_DOC = 'docs/architecture/bare-count-drop.md';

/**
 * 造一本**摘要自洽**的清册（夹具用）：键集、条数、judged_total、`documents_digest` 彼此对得上。
 *
 * 真手改不会重算摘要——那正是 T10③／T16 要抓的；这里给的是「文件没被动过」的那一半，
 * 让每条用例只在它要钉的那一处变异，别的闸不陪绑。
 */
function countBook({ documents, judgedTotal = null, accept = [], scan = ['docs/architecture'] }) {
  const total = judgedTotal ?? Object.values(documents).reduce((sum, value) => sum + value, 0);
  return `${JSON.stringify({
    schema_version: 1,
    note: '测试夹具',
    generated_by: 'test',
    scan,
    judged_total: total,
    documents_digest: anchorCountDocumentsDigest(documents, total),
    accept,
    documents,
  }, null, 2)}\n`;
}

test('T9 散文逃逸必红：把唯一那条锚点整句改写成散文 ⇒ 锚点清册点出「少了一条」', () => {
  const root = makeBareFixture({
    [COUNT_DOC]: '读数：见 `src/x.mjs:3`。\n',
    [COUNT_BASELINE]: countBook({ documents: { [COUNT_DOC]: 1 } }),
  });
  try {
    const before = capture([...bareScanArgs(root), '--strict']);
    assert.equal(before.code, 0, `锚点还在时不该红：${before.text}`);
    assert.match(before.text, /ANCHOR-COUNT: 进判据锚点 1 条/u);

    // 把锚点整条改写成散文：源文件没动、行号没越界、结构四判据都无从判——只有清册能看出少了一条。
    writeIn(root, COUNT_DOC, '读数：见第 3 行。\n');
    const after = capture([...bareScanArgs(root), '--strict']);
    assert.equal(after.code, 1, `锚点被改写成散文必须判红，实际：${after.text}`);
    assert.match(after.text, /FAIL: 锚点清册未通过/u);
    assert.match(after.text, /docs\/architecture\/bare-count-drop\.md：清册 1 条 → 本次 0 条（少 1 条）/u, '报错必须点名文档、给出旧计数／新计数');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T10 清册不能自助下调：只改一处数字被算术抓住，三处改齐被摘要抓住（手改与走工具是两回事）', () => {
  const root = makeBareFixture({
    [COUNT_DOC]: '读数：见第 3 行。\n', // 锚点已经不在了（等价于「刚被人改写成散文」）
    [COUNT_BASELINE]: countBook({ documents: { [COUNT_DOC]: 1 } }),
  });
  try {
    // ① 只把该文档的条数下调 1（judged_total 不动）⇒ 逐项相加对不上总数，当场报错。
    writeIn(root, COUNT_BASELINE, countBook({ documents: { [COUNT_DOC]: 0 }, judgedTotal: 1 }));
    const onlyDocLowered = capture([...bareScanArgs(root), '--strict']);
    assert.notEqual(onlyDocLowered.code, 0, `只改文档条数、不改总数必须报错，实际：${onlyDocLowered.text}`);
    assert.match(onlyDocLowered.text, /自相矛盾：judged_total=1，但 documents 逐项相加是 0/u);

    // ② 连 judged_total 一起下调 ⇒ 与 accept 账本对不上（账本是「谁放行的」那一栏）。
    writeIn(root, COUNT_BASELINE, countBook({
      documents: { [COUNT_DOC]: 0 },
      judgedTotal: 0,
      accept: [{ why: '首次落地', accept: 1, judged_total: 1 }],
    }));
    const bothLowered = capture([...bareScanArgs(root), '--strict']);
    assert.notEqual(bothLowered.code, 0, `改数字不改账本必须报错，实际：${bothLowered.text}`);
    assert.match(bothLowered.text, /与 accept 账本对不上/u);

    // ③ 三处一起改齐（条数 + judged_total + 账本末条）：求和与账本都自洽了，第五轮复审实测这样能 exit 0。
    //    现在由 documents_digest 兜住——手改的人不会重算摘要，摘要仍按**旧表**算 ⇒ exit 2 并点名「不许手改」。
    writeIn(root, COUNT_BASELINE, `${JSON.stringify({
      schema_version: 1, note: '测试夹具', generated_by: 'test', scan: ['docs/architecture'],
      judged_total: 0,
      documents_digest: anchorCountDocumentsDigest({ [COUNT_DOC]: 1 }, 1), // ← 手改前的旧表算出来的
      accept: [{ why: '该锚点指的历史行已不存在，主动放弃判据', accept: -1, judged_total: 0 }],
      documents: { [COUNT_DOC]: 0 },
    }, null, 2)}\n`);
    const allThree = capture([...bareScanArgs(root), '--strict']);
    assert.equal(allThree.code, 2, `三处改齐也必须被摘要抓住，实际：${allThree.text}`);
    assert.match(allThree.text, /documents 摘要不符（或缺失）/u);
    assert.match(allThree.text, /不许手改/u);
    assert.doesNotMatch(allThree.text, /PASS:/u, '手改过的清册不许打印 PASS');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T11 孤儿册的键不带行号：页首插一行空行不造成成批「新增 + 陈旧」噪声', () => {
  const doc = 'docs/architecture/bare-orphan-blank.md';
  const body = ['# 标题', '', '段落一：:5', '', '段落二：:7', ''].join('\n');
  const root = makeBareFixture({ [doc]: body });
  try {
    const emitted = captureEmit([...bareScanArgs(root), '--emit-orphan-baseline']);
    assert.equal(emitted.code, 0);
    const snapshot = JSON.parse(emitted.stdout);
    assert.equal(snapshot.orphans.length, 2, `两段各一条孤儿，实际：${JSON.stringify(snapshot.orphans)}`);
    writeIn(root, ORPHAN_BASELINE, emitted.stdout);

    const before = capture([...bareScanArgs(root), '--strict']);
    assert.equal(before.code, 0, `册子刚生成，不该红：${before.text}`);

    // 页首插一行空行：文档行号整体 +1（下面用 findings 的 docLine 证明它真的位移了）。
    writeIn(root, doc, `\n${body}`);
    const orphanLines = collectFindings({ root, targets: ['docs/architecture'] }).bareOrphans.map(item => item.docLine);
    assert.deepEqual(orphanLines, [4, 6], '插一行之后孤儿所在文档行确实从 3／5 漂到 4／6（这是行号漂移的实证）');

    const after = capture([...bareScanArgs(root), '--strict']);
    assert.equal(after.code, 0, `键里没有行号 ⇒ 插行不该刷出成批增删，实际：${after.text}`);
    assert.match(after.text, /BARE-ORPHAN: BARE_ORPHAN 2 条归不到路径的裸锚点——册 tools\/doc-anchors-orphan-baseline\.json 登记 2 条；本次命中 2 条、基线外新增 0 条、本次扫描面内陈旧 0 条/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T12 孤儿册三件：陈旧判红、写模式在 CI 里被拒、--accept 与实际增量不符即报错', () => {
  const doc = 'docs/architecture/bare-orphan-stale.md';
  const root = makeBareFixture({ [doc]: '# 标题\n\n段落一：:5\n' });
  const writeArgs = [...bareScanArgs(root), '--orphan-baseline', ORPHAN_BASELINE];
  try {
    const emitted = captureEmit([...writeArgs, '--emit-orphan-baseline']);
    writeIn(root, ORPHAN_BASELINE, emitted.stdout);
    assert.equal(capture([...writeArgs, '--strict']).code, 0, '册子与文档一致时不该红');

    // ① 陈旧判红：把那条裸锚点补回路径，册子里的条目就「不再命中」——删册子换绿不成立。
    writeIn(root, doc, '# 标题\n\n段落一：`src/x.mjs:5`。\n');
    const stale = capture([...writeArgs, '--strict']);
    assert.equal(stale.code, 1, `册上条目不再命中必须判红，实际：${stale.text}`);
    assert.match(stale.text, /FAIL: 裸锚点孤儿册未通过/u);
    assert.match(stale.text, /册上陈旧 1 条/u);
    assert.match(stale.text, /陈旧 docs\/architecture\/bare-orphan-stale\.md\|:5\|no-explicit-in-block/u);

    // ② CI 里拒绝写模式：门禁不能自己改基线。
    const hadCi = process.env.CI;
    process.env.CI = '1';
    try {
      const refused = capture([...writeArgs, '--write-orphan-baseline', '--accept', '0', '--why', '测试：CI 里应当被拒']);
      assert.equal(refused.code, 2, `CI 里写模式必须被拒，实际：${refused.text}`);
      assert.match(refused.text, /在 CI 环境（检测到 CI）里被拒绝执行/u);
    } finally {
      if (hadCi === undefined) delete process.env.CI;
      else process.env.CI = hadCi;
    }

    // ③ --accept 必须等于实际增量：数字对不上就是没复核。
    const wrongAccept = capture([...writeArgs, '--write-orphan-baseline', '--accept', '99', '--why', '测试：故意给错条数']);
    assert.equal(wrongAccept.code, 2, `--accept 与实际不符必须报错，实际：${wrongAccept.text}`);
    assert.match(wrongAccept.text, /--accept=99 与实际增量 0 不符/u);

    // ④ 试运行不许带「放行」参数（否则会让人以为已经登记过了）。
    const acceptWithoutWrite = capture([...writeArgs, '--strict', '--accept', '0']);
    assert.equal(acceptWithoutWrite.code, 2);
    assert.match(acceptWithoutWrite.text, /--accept 与 --why 只跟 --write-\*-baseline 一起用/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T13 清册的两条静默通道：键改成面外文档必红、键写 `./` 直接拒收、写模式漏 --scan 不许静默丢键', () => {
  const doc = 'docs/architecture/bare-count-face.md';
  const source = '读数：见 `src/x.mjs:3`。\n';
  const countOf = (documents, scan = ['docs/architecture']) => countBook({ documents, scan });
  // 夹具里 README.md 是「磁盘上真实存在、但不在扫描面内」的文档——正是审查给的 E27 形状。
  const root = makeBareFixture({
    [doc]: source,
    'README.md': '# 夹具根说明\n',
    [COUNT_BASELINE]: countOf({ [doc]: 1 }),
  });
  try {
    assert.equal(capture([...bareScanArgs(root), '--strict']).code, 0, '清册与文档一致时不该红');

    // ① 把键改名成面外的 README.md：求和、账本、总数全都不变，只有「这份文档本次根本没被扫到」能抓住它。
    writeIn(root, COUNT_BASELINE, countOf({ 'README.md': 1 }));
    const renamed = capture([...bareScanArgs(root), '--strict']);
    assert.equal(renamed.code, 1, `键改成面外文档必须判红，实际：${renamed.text}`);
    assert.match(renamed.text, /FAIL: 锚点清册未通过/u);
    assert.match(renamed.text, /1 个键本次没扫到/u);
    assert.match(renamed.text, /README\.md：清册 1 条，但本次根本没扫到它/u);
    assert.match(renamed.text, /键不在清册记下的生成扫描面内/u);
    // 面外的键要单独计数：它既不是「合法跳过」，也不许混进「面内却扫不到」。
    assert.match(renamed.text, /面外未扫的键 1 个、面内本次未扫 0 个/u);
    assert.match(renamed.text, /面内却扫不到的键 0 个/u);

    // ② 同一个文档换个字面写法（`./`）：直接拒收，不做静默 normalize（否则「扫没扫到」就查不中了）。
    writeIn(root, COUNT_BASELINE, countOf({ 'docs/architecture/./bare-count-face.md': 1 }));
    const dotSlash = capture([...bareScanArgs(root), '--strict']);
    assert.equal(dotSlash.code, 2, `非规范化的键必须拒收，实际：${dotSlash.text}`);
    assert.match(dotSlash.text, /键不是规范化的仓库相对路径/u);
    assert.match(dotSlash.text, /docs\/architecture\/\.\/bare-count-face\.md/u);
    assert.match(dotSlash.text, /不做静默 normalize/u);

    // ③ 清册记下的面比本次宽时，面内的键是**合法**跳过（默认面跑 218 份、CI 面跑 226 份的日常）。
    writeIn(root, 'docs/verification/absent.md', '引用：`src/x.mjs:3`。\n引用：`src/y.mjs:2`。\n');
    writeIn(root, COUNT_BASELINE, countOf({ [doc]: 1, 'docs/verification/absent.md': 2 }, ['docs']));
    const wider = capture([...bareScanArgs(root), '--strict']);
    assert.equal(wider.code, 0, `清册面内的键在更窄的面上运行应当只计数、不判红：${wider.text}`);
    assert.match(wider.text, /面外未扫的键 0 个、面内本次未扫 1 个/u);

    // ④ 写模式漏 `--scan`：`parseArgs` 会补上默认面（比清册记的宽面窄），照它重写会静默丢键。
    //    真正拦住它的不是「必须显式给 --scan」那种形状检查（那种检查在这里是死代码：面永远非空），
    //    而是写模式里的 `lostKeys` 闸——「新键集 ⊇ 旧键集」，比要求显式传参更硬。
    const before = readFileSync(join(root, COUNT_BASELINE), 'utf8');
    const lostScan = capture([...bareScanArgs(root), '--write-anchor-count-baseline', '--accept', '-2', '--why', '变异：漏 --scan']);
    assert.equal(lostScan.code, 2, `漏 --scan 的写模式必须报错，实际：${lostScan.text}`);
    assert.match(lostScan.text, /本次扫描面里没有这 1 份文档，重写会把它们从清册里静默删掉/u);
    assert.equal(readFileSync(join(root, COUNT_BASELINE), 'utf8'), before, '写模式失败时不许留下半截册子');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * T14：把「扫不到」这条洞钉死在两种最省事的写法上。
 *
 * 洞的形状（r4 对抗审查的阻塞项）：清册的键只要落在 **清册记下的扫描面** 里、而本次没扫到，
 * 就被当成「合法跳过」计了数。于是把键换成 `docs/**` 下**不是 .md 的文件**或**目录名**，
 * 这份文档就永远扫不到、却一直 PASS——`进判据 6216 / 清册登记 6217` 少 1 条也不红。
 *
 * 判据（四桶，只有最后一桶合法跳到）：①键不是可扫的 `.md`（非 `.md` 路径／目录名／跳过目录）
 * ②键在**本次运行面**内却扫不到 ③两张面都不在（改名成 `README.md` 这类面外文档）——①②③判红；
 * ④可扫的文档、在清册面内、不在本次面内（默认面 vs `--scan docs` 的日常）才只计数。
 * 这两个用例都用「磁盘上真实存在、但不是 .md」的键——正是审查复现的那两步。
 */
test('T14 面内扫不到也算红：键指向面内非 .md 文件、键指向目录名，都必须 exit 1 且点名', () => {
  const doc = 'docs/architecture/bare-count-nonmd.md';
  const source = '读数：见 `src/x.mjs:3`。\n';
  const countOf = documents => countBook({ documents });

  // ① 键换成面内的**非 .md 文件**：文件真实存在（docExists 为真）、锚点总数与账本都不变，
  //    唯一的破绽是「这次没扫到它」——必须判红，而不是记一笔「合法跳过」。
  const nonMd = makeBareFixture({
    [doc]: source,
    'docs/architecture/contract-status.json': '{"note":"面内的非 .md 文件，walkMarkdown 不会收它"}\n',
  });
  try {
    writeIn(nonMd, COUNT_BASELINE, countOf({ 'docs/architecture/contract-status.json': 1 }));
    const renamed = capture([...bareScanArgs(nonMd), '--strict']);
    assert.equal(renamed.code, 1, `键换成面内非 .md 文件必须判红，实际：${renamed.text}`);
    assert.match(renamed.text, /1 个键本次没扫到/u);
    assert.match(renamed.text, /永远扫不到的键 1 个/u);
    assert.match(renamed.text, /· docs\/architecture\/contract-status\.json：清册 1 条，但本次根本没扫到它/u);
    assert.match(renamed.text, /键不是一份可扫的 Markdown 文档/u);
    assert.doesNotMatch(renamed.text, /面内本次未扫 1 个/u, '面内扫不到的键不许被记成「合法跳过」');
  } finally {
    rmSync(nonMd, { recursive: true, force: true });
  }

  // ② 键换成面内的**目录名**：`docs/architecture` 自己就在扫描面内、也确实存在于磁盘，
  //    但它永远不可能是一条「被扫描的文档」，同样必须判红点名。
  const asDir = makeBareFixture({ [doc]: source });
  try {
    writeIn(asDir, COUNT_BASELINE, countOf({ 'docs/architecture': 1 }));
    const directory = capture([...bareScanArgs(asDir), '--strict']);
    assert.equal(directory.code, 1, `键换成目录名必须判红，实际：${directory.text}`);
    assert.match(directory.text, /· docs\/architecture：清册 1 条，但本次根本没扫到它/u);
    assert.match(directory.text, /键根本不是可扫的文档，等于让这份文档永久退出判据面/u);
    assert.match(directory.text, /永远扫不到的键 1 个/u);
  } finally {
    rmSync(asDir, { recursive: true, force: true });
  }
});

/**
 * T15：`--scan` 给**glob 面**时，T14 那条洞不许复活。
 *
 * 第五轮复审的 B1：`isInsideFace` 原来只做前缀比较，`--scan 'docs/**\/*.md'` 下任何键都匹配不上
 * 「本次运行面」⇒「面内却扫不到」变成不可达代码：改 CI 那一行参数就能关掉清册判据，而七条门禁
 * 与全部单测**仍然全绿**。glob 又是工具自己文档化的用法（USAGE 与文件头都有示例），覆盖面与
 * `--scan docs` 逐字相同。
 *
 * 现在「面」与「扫」共用同一个 `globToRegExp`；并且「键不是可扫的 .md」这一桶与扫描面无关，
 * 任何面下都判红。所以换面参数关不掉这一闸。
 */
test('T15 glob 面不许成为后门：`--scan docs/**/*.md` 下同一坏键仍 exit 1，真文档照旧不红', () => {
  const doc = 'docs/architecture/bare-count-glob.md';
  const source = '读数：见 `src/x.mjs:3`。\n';
  const root = makeBareFixture({
    [doc]: source,
    'docs/architecture/contract-status.json': '{"note":"面内的非 .md 文件，walkMarkdown 不会收它"}\n',
  });
  const globArgs = ['--root', root, '--scan', 'docs/**/*.md', '--baseline', 'tools/doc-anchors-baseline.json'];
  try {
    // ① 键指向面内非 .md 文件：glob 面下仍必须判红（修前这里 EXIT=0 PASS）。
    writeIn(root, COUNT_BASELINE, countBook({ documents: { 'docs/architecture/contract-status.json': 1 } }));
    const bad = capture([...globArgs, '--strict']);
    assert.equal(bad.code, 1, `glob 面下坏键仍必须判红，实际：${bad.text}`);
    assert.match(bad.text, /FAIL: 锚点清册未通过/u);
    assert.match(bad.text, /· docs\/architecture\/contract-status\.json：清册 1 条，但本次根本没扫到它/u);
    assert.match(bad.text, /永远扫不到的键 1 个/u);
    assert.doesNotMatch(bad.text, /面内本次未扫 1 个/u, 'glob 面下也不许把它记成「合法跳过」');

    // ② 反空转：同一 glob 面、键指向**真文档**时不许红（闸不是「用了 glob 就红」）。
    writeIn(root, COUNT_BASELINE, countBook({ documents: { [doc]: 1 } }));
    const good = capture([...globArgs, '--strict']);
    assert.equal(good.code, 0, `同一 glob 面下真文档不该红：${good.text}`);
    assert.match(good.text, /ANCHOR-COUNT: 进判据锚点 1 条 \/ 1 份文档/u);
    assert.match(good.text, /面内本次未扫 0 个/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * T16：清册只能由写模式重生成——手改（整键删除、干脆删掉摘要字段）必 exit 2。
 *
 * 第五轮复审的 B2：把某文档条数、judged_total、账本末条三处一起改齐（或者干脆整键删掉），
 * 求和与账本都自洽 ⇒ 修前 exit 0，读数变成「登记 6215 条 / 226 份」甚至「5771 条 / 225 份」，
 * 唯一痕迹是一句「上升 1 份」。documents_digest 就是为这一步准备的：它只由写模式重算。
 *
 * 注意摘要的强度：FNV-1a 64 位，拦的是「手改数字却没重算摘要」，不是签名——愿意读源码重算的人
 * 仍然能改（和「整本册子重生成」一样，这道闸给的是留痕，不是不可伪造）。
 */
test('T16 清册手改必炸：整键删除、删掉摘要字段都 exit 2；同一份册子走写模式才 exit 0 并留名', () => {
  const doc = 'docs/architecture/bare-count-digest.md';
  const source = '读数：见 `src/x.mjs:3`。\n';
  const root = makeBareFixture({ [doc]: source, [COUNT_BASELINE]: countBook({ documents: { [doc]: 1 } }) });
  try {
    assert.equal(capture([...bareScanArgs(root), '--strict']).code, 0, '摘要自洽的清册不该红');

    // ① 整键删除：documents 空、judged_total 0、账本末条也改成 0——账面完全自洽，
    //    只有摘要仍按**旧表**算 ⇒ exit 2（修前：exit 0，登记数从 6217 掉到 6216 也不红）。
    writeIn(root, COUNT_BASELINE, `${JSON.stringify({
      schema_version: 1, note: '测试夹具', generated_by: 'test', scan: ['docs/architecture'],
      judged_total: 0,
      documents_digest: anchorCountDocumentsDigest({ [doc]: 1 }, 1), // ← 手改前的旧表
      accept: [{ why: '整键删除，账面自洽', accept: -1, judged_total: 0 }],
      documents: {},
    }, null, 2)}\n`);
    const deleted = capture([...bareScanArgs(root), '--strict']);
    assert.equal(deleted.code, 2, `整键删除必须被摘要抓住，实际：${deleted.text}`);
    assert.match(deleted.text, /documents 摘要不符（或缺失）/u);
    assert.match(deleted.text, /不许手改/u);

    // ② 直接把摘要字段删掉（「反正工具会重算」）⇒ 一样 exit 2；只有写模式允许缺摘要做引导。
    const book = JSON.parse(countBook({ documents: { [doc]: 1 } }));
    delete book.documents_digest;
    writeIn(root, COUNT_BASELINE, `${JSON.stringify(book, null, 2)}\n`);
    const noDigest = capture([...bareScanArgs(root), '--strict']);
    assert.equal(noDigest.code, 2, `缺摘要必须 exit 2，实际：${noDigest.text}`);
    assert.match(noDigest.text, /不许手改/u);

    // ③ 正控制：同一份册子走写模式 ⇒ exit 0，账本留一行、落盘文件里的摘要算准。
    //    没有这一步，「手改必炸」也可能只是把路彻底堵死。
    const hadCi = process.env.CI;
    delete process.env.CI;
    try {
      const written = capture([
        ...bareScanArgs(root), '--write-anchor-count-baseline', '--accept', '0', '--why', '用例：清册重生成，留一条名',
      ]);
      assert.equal(written.code, 0, `写模式应当成功，实际：${written.text}`);
      assert.match(written.text, /WRITE: 已写 tools\/doc-anchors-anchor-count-baseline\.json/u);
      const saved = JSON.parse(readFileSync(join(root, COUNT_BASELINE), 'utf8'));
      assert.equal(saved.judged_total, 1);
      assert.equal(
        saved.documents_digest,
        anchorCountDocumentsDigest(saved.documents, saved.judged_total),
        '写模式必须把摘要算准（否则下一次校验自己就红）',
      );
      assert.equal(saved.accept.at(-1).why, '用例：清册重生成，留一条名');
    } finally {
      if (hadCi === undefined) delete process.env.CI;
      else process.env.CI = hadCi;
    }
    const after = capture([...bareScanArgs(root), '--strict']);
    assert.equal(after.code, 0, `写模式重生成后应当绿：${after.text}`);
    assert.match(after.text, /ANCHOR-COUNT-ACCEPT: 最近一次放行 用例：清册重生成，留一条名/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

