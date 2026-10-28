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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  attributeBareAnchors,
  collectFindings,
  extractReferences,
  loadBaseline,
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

