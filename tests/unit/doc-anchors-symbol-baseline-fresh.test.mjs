/**
 * 符号基线（`tools/doc-anchors-symbol-baseline.json`）的**新鲜度闸门**：把「陈旧条目只提示」变成「必须清理」。
 *
 * 为什么需要这一条：`tools/verify-doc-anchors.mjs` 的 `--symbol=strict` 只把**基线之外新增**的注释锚点判红
 * （exit 1）；基线条目一旦不再命中，工具只打一行 `STALE-SYMBOL` 提示，退出码不动。于是「锚点被重锚到代码
 * 行」或「文档改写了」之后没人删的那条登记会一直躺在文件里，符号基线慢慢变成免罚名单——下一条真正落不到
 * 代码行的锚点可以借它的名额静默通过。这一条用例把差集钉死：**陈旧必须为 0**，零容忍、且必须点名是哪一条。
 *
 * 钉住四件事（解析／判定一律调 `tools/verify-doc-anchors.mjs` 的导出，不在这里抄第二份口径）：
 *   ① 每条基线仍可解析：`doc` 与 `target` 指向的文件都在仓库里（`resolveTarget`，同名后缀档也走它）、行区间
 *      合法、`path` 字段与 `reference` 解析出的文件是同一个、文档里那条引用还在（显式写法走 `extractReferences`，
 *      裸锚点继承档走 `attributeBareAnchors`——登记的坐标是「同块最近显式锚点的路径 ＋ 裸锚点行号」规范化后的形态，
 *      文档里只写 `` `:N` ``，字面量比不出来）、键 `doc|reference` 不重复（`commentAnchorKey`）；
 *   ② 每条基线仍「值得登记」：工具当下的判定里它仍是 `comment-detached` / `comment-cited`——即
 *      `collectFindings().commentAnchors` 的 `bucket`（判据本体是 `judgeSymbolLine` → `symbolLineVerdict`，
 *      一处口径两处用）。已经落到代码行、或那一行已不存在 ⇒ 该条不再是注释锚点 ⇒ 红并点名；
 *   ③ 基线整体无陈旧：`partitionSymbolByBaseline` 的 `stale` 为空（等价 CLI 读数「陈旧 0 条」），且 `fresh`
 *      也为空（不许靠把新问题追加进基线来换绿）；同时对齐 CLI 自己那行 `SYMBOL-STRICT-BASELINE:` 读数；
 *   ④ 磁盘文件本身：JSON 可解析、字段齐全（缺 `doc` / 引用坐标 / `path` 任一项即红并点名）、条目按稳定顺序
 *      （文档按字典序成块、块内 `docLine` 不降——插入行不会打乱这个相对顺序，diff 才读得出来）。
 *
 * 负控制（本文件的第五条用例）：`fs.mkdtemp` 里造一份基线**副本**，注入一条不可能命中的条目 ⇒ ①②③ 三类
 * 断言必须逐条红并点名那一条；删掉临时目录后复绿。真基线一个字节都不碰（末了比对注入前后的字节）。
 *
 * 字段名以文件里的**真实 schema** 为准，不是 `doc/line/target` 三件套：坐标由 `reference = "路径:行[-行]"`
 * 承载，`path` 是同一个引用的根相对路径（供人读、`owner` 与它成对），`docLine` 是文档侧行号——工具口径明确
 * 不让 `docLine` 进 key（正文插一行不该让整条基线失效），所以这里只校它在文档行数内、不校它精确落在引用行上。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  COMMENT_ANCHOR,
  DEFAULT_SYMBOL_BASELINE,
  SYMBOL_LINE_SCOPE,
  TOOL_ROOT,
  buildFileNameIndex,
  attributeBareAnchors,
  collectFindings,
  commentAnchorKey,
  extractReferences,
  loadSymbolBaseline,
  main,
  ownerOf,
  partitionSymbolByBaseline,
  resolveTarget,
  splitLines,
} from '../../tools/verify-doc-anchors.mjs';

/** 被钉的树：工具自己认的仓库根（`tools/verify-doc-anchors.mjs` 的上一级），不按 `process.cwd()` 猜。 */
const ROOT = TOOL_ROOT;
/** 符号判据只作用于 `docs/architecture/**`，所以扫描面取 `SYMBOL_LINE_SCOPE`（`docs` 与它同解，见工具注释）。 */
const SCAN = Object.freeze([SYMBOL_LINE_SCOPE.replace(/\/+$/u, '')]);
/** 反空转下限：当前 29 条，掉到 20 条以下要么读错文件、要么基线被清空。 */
const MIN_ENTRIES = 20;
/** 符号基线只承接这两档（`comment-attached` 归 `NOT_SYMBOL_LINE` ＋结构基线，两套互不干扰）。 */
const COMMENT_ANCHOR_BUCKETS = Object.freeze(['comment-detached', 'comment-cited']);
/** 磁盘条目的必备字段：`doc`＋`reference` 是 key 的两半，`path`／`owner`／`docLine`／`kind`／`note` 是人读的坐标与裁决理由。 */
const REQUIRED_FIELDS = Object.freeze(['doc', 'docLine', 'path', 'reference', 'reason', 'kind', 'owner', 'note']);
/** `路径:行` 或 `路径:起-止`。只为取「文件存不存在／区间合不合法」的字段，判定本身全部走工具导出。 */
const COORDINATE = /^(?<target>.+):(?<from>\d+)(?:-(?<to>\d+))?$/u;

let scanCache = null;
let baselineCache = null;

/** 进程内只扫一次：`collectFindings` 全量扫 `docs/architecture/**` 约 0.6s，五个用例共用同一份读数。 */
function liveScan() {
  if (scanCache === null) {
    const { commentAnchors, stats } = collectFindings({ root: ROOT, targets: SCAN });
    scanCache = { anchors: commentAnchors, stats, fileIndex: buildFileNameIndex(ROOT) };
  }
  return scanCache;
}

/** 真基线（走工具的 loader：坏 JSON、缺字段、空 note 都会在这里抛）。 */
function liveBaseline() {
  if (baselineCache === null) {
    const baseline = loadSymbolBaseline(ROOT);
    assert.equal(
      baseline.missing,
      false,
      `符号基线 ${DEFAULT_SYMBOL_BASELINE} 不存在：空基线等于所有注释锚点都算新增，这条闸门不能显示为绿`,
    );
    baselineCache = baseline.entries;
  }
  return baselineCache;
}

function parseCoordinate(reference) {
  const match = COORDINATE.exec(String(reference));
  if (match === null) return null;
  const from = Number(match.groups.from);
  return {
    target: match.groups.target,
    from,
    to: match.groups.to === undefined ? from : Number(match.groups.to),
  };
}

/** 点名用的坐标串：文档:行 → 引用（owner）。与工具 `describeCommentAnchor` 的取向一致。 */
function describeEntry(entry) {
  return `${entry.doc}:${entry.docLine ?? '?'} → ${entry.reference}（owner=${entry.owner ?? '未标'}）`;
}

function formatProblems(problems) {
  return `\n${problems.map(problem => `  · ${problem}`).join('\n')}`;
}

/** 断言「这条清单为空」；非空时把每条都打出来，红的那一次就知道该删／该改哪一条。 */
function assertClean(problems, label) {
  assert.equal(problems.length, 0, `${label}：${problems.length} 条未通过${formatProblems(problems)}`);
}

/** 键重复：同一对 `doc|reference` 登记两次，等于白送一个免罚名额（partition 会先把第一份消费成命中）。 */
function duplicateKeys(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const key = commentAnchorKey(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 1).map(([key, count]) => `${key}（${count} 条）`);
}

function auditFields(entries) {
  const problems = [];
  for (const entry of entries) {
    const where = describeEntry(entry);
    const missing = REQUIRED_FIELDS.filter(field => (
      entry[field] === undefined
      || entry[field] === null
      || (typeof entry[field] === 'string' && entry[field].trim() === '')
    ));
    if (missing.length > 0) problems.push(`${where} 缺字段：${missing.join(' / ')}`);
    if (!Number.isInteger(entry.docLine) || entry.docLine < 1) {
      problems.push(`${where}：docLine 不是正整数（${JSON.stringify(entry.docLine)}）`);
    }
    if (entry.reason !== COMMENT_ANCHOR) {
      problems.push(`${where}：reason 不是 ${COMMENT_ANCHOR}（${JSON.stringify(entry.reason)}）——符号基线只认这一种`);
    }
  }
  return problems;
}

function auditResolvable({ entries, root = ROOT }) {
  const problems = [];
  const { fileIndex } = liveScan();
  for (const entry of entries) {
    const where = describeEntry(entry);
    const docAbsolute = join(root, entry.doc);
    if (!existsSync(docAbsolute)) {
      problems.push(`${where}：文档 ${entry.doc} 在仓库里找不到（doc 被删／改名 ⇒ 这条登记该删）`);
      continue;
    }
    if (!entry.doc.startsWith(SYMBOL_LINE_SCOPE)) {
      problems.push(`${where}：doc 不在符号作用域 ${SYMBOL_LINE_SCOPE}** 内，登在这里不会被任何判据消费`);
    }
    const coordinate = parseCoordinate(entry.reference);
    if (coordinate === null) {
      problems.push(`${where}：reference 不是「路径:行[-行]」形态，解析不出目标与区间`);
      continue;
    }
    if (coordinate.from < 1 || coordinate.to < coordinate.from) {
      problems.push(`${where}：行区间非法（${coordinate.from}-${coordinate.to}）`);
    }
    const resolved = resolveTarget({ root, docPath: entry.doc, target: coordinate.target, fileIndex });
    if (resolved.status !== 'resolved') {
      problems.push(`${where}：目标 ${coordinate.target} 解析不了（${resolved.status}）——该条目指向的文件已经不在了`);
    } else if (resolved.relative !== entry.path) {
      problems.push(`${where}：path 字段（${entry.path}）与 reference 指向的（${resolved.relative}）不是同一个文件`);
    } else if (entry.owner !== ownerOf(entry.path)) {
      problems.push(`${where}：owner（${entry.owner}）与该路径的归属（${ownerOf(entry.path)}）不一致`);
    }
    const docText = readFileSync(docAbsolute, 'utf8');
    const lineCount = splitLines(docText).length;
    if (Number.isInteger(entry.docLine) && entry.docLine > lineCount) {
      problems.push(`${where}：docLine 超出文档行数（该文档 ${lineCount} 行）`);
    }
    const documentReferences = extractReferences(docText);
    const present = documentReferences.filter(reference => reference.reference === entry.reference);
    if (present.length === 0) {
      // 裸锚点档：登记的是「同块最近的显式锚点路径 ＋ 裸锚点自己的行号」规范化后的坐标，文档里只写 `` `:N` ``，
      // 字面量当然不在。判活要走同一套归属（`attributeBareAnchors`），否则这条用例会把「继承来的锚点」当成
      // 「文档已改写」全数判红——那等于逼人别登记它们。
      const inherited = attributeBareAnchors({
        text: docText,
        references: documentReferences,
        // 归属口径必须与 `collectFindings` 一致：`resolveIdentity` 返回**解析后的仓内路径**，
        // 否则同块里 `app.ts:2227` 与 `app.ts:2228` 会被当成「两个不同文件」而全判 ambiguous。
        resolveIdentity: reference => {
          const probe = resolveTarget({ root, docPath: entry.doc, target: reference.target, fileIndex });
          return probe.status === 'resolved' ? probe.relative : `?${reference.target}`;
        },
      }).inherited;
      if (!inherited.some(item => item.reference === entry.reference)) {
        problems.push(`${where}：文档里已经没有这条引用了（文档被改写 ⇒ 这条登记该删）`);
      }
    }
  }
  return problems;
}

/** ②：用工具当下的判定复核「这条登记仍然是注释锚点」。 */
function auditCommentAnchors(anchors, entries) {
  const problems = [];
  const byKey = new Map(anchors.map(anchor => [commentAnchorKey(anchor), anchor]));
  for (const entry of entries) {
    const where = describeEntry(entry);
    const anchor = byKey.get(commentAnchorKey(entry));
    if (anchor === undefined) {
      problems.push(`${where}：工具当下不再把它判为注释锚点（已重锚到代码行／那一行已不存在／引用位置变了）——这条登记已不值得留`);
      continue;
    }
    if (!COMMENT_ANCHOR_BUCKETS.includes(anchor.bucket)) {
      problems.push(`${where}：判成了 ${anchor.bucket}，符号基线只承接 ${COMMENT_ANCHOR_BUCKETS.join(' / ')}`);
    }
    if (anchor.target !== entry.path) {
      problems.push(`${where}：命中的目标文件是 ${anchor.target}，与基线的 path（${entry.path}）不一致`);
    }
  }
  return problems;
}

/** ③：三态差集（命中／新增／陈旧）；`problems` 空 ⇔ 陈旧 0 且新增 0。 */
function auditFreshness({ anchors, entries }) {
  const { fresh, covered, stale } = partitionSymbolByBaseline(anchors, entries);
  const problems = [];
  for (const entry of stale) {
    problems.push(`STALE-SYMBOL ${describeEntry(entry)}：登记了但已不再命中——删掉这条，否则符号基线会退化成免罚名单`);
  }
  for (const anchor of fresh) {
    problems.push(`新增注释锚点 ${anchor.doc}:${anchor.docLine} → ${anchor.reference}（目标 ${anchor.target}，${anchor.bucket}）：要么重锚到代码行，要么人工裁决后登记并写明 note`);
  }
  return { problems, fresh, covered, stale };
}

function runMain(argv) {
  const log = [];
  const error = [];
  const code = main(argv, { log: line => log.push(String(line)), error: line => error.push(String(line)) });
  return { code, log, error, text: [...log, ...error].join('\n') };
}

/** 注入用的假条目：文档不存在、目标行也补不上，任何判据都不可能命中它。 */
const INJECTED = Object.freeze({
  path: 'services/api/src/contract.ts',
  reason: COMMENT_ANCHOR,
  owner: 'api-server',
  reference: 'services/api/src/contract.ts:1',
  doc: 'docs/architecture/不存在.md',
  docLine: 1,
  kind: 'inline',
  note: '【负控制】只活在临时副本里：文档不存在，任何判据都不该命中它，用来验证新鲜度闸门会红并点名。',
});

test('① 每条基线都还能解析：字段齐全、doc 与 target 都在仓库里、键不重复', () => {
  const entries = liveBaseline();
  assert.ok(
    entries.length >= MIN_ENTRIES,
    `符号基线只有 ${entries.length} 条，少于下限 ${MIN_ENTRIES} 条：要么读错了文件、要么基线被清空，本闸门会变成空转`,
  );
  const duplicates = duplicateKeys(entries);
  assert.equal(
    duplicates.length,
    0,
    `基线的键（doc|reference）必须唯一，重复登记等于白送免罚名额：${formatProblems(duplicates)}`,
  );
  assertClean(auditFields(entries), '基线条目字段');
  assertClean(auditResolvable({ entries }), '基线可解析性');
  console.log(`[symbol-baseline-fresh] 基线 ${entries.length} 条：字段齐全、doc/target 都在仓库里、键无重复`);
});

test('② 每条基线仍「值得登记」：工具当下仍判它是注释锚点（没落到代码行）', () => {
  const entries = liveBaseline();
  const { anchors, stats } = liveScan();
  assert.ok(
    anchors.length >= MIN_ENTRIES,
    `作用域 ${SYMBOL_LINE_SCOPE}** 里只判出 ${anchors.length} 条注释锚点，少于下限 ${MIN_ENTRIES} 条：读到的树不对，断言会空转`,
  );
  assertClean(auditCommentAnchors(anchors, entries), '基线条目已不再对应注释锚点');
  console.log(
    `[symbol-baseline-fresh] 作用域内注释锚点 ${anchors.length} 条（去重前：注释但非文档注释 ${stats.symbol.detached}、逐字引用注释文案 ${stats.symbol.cited}），${entries.length} 条登记全部仍在其中`,
  );
});

test('③ 基线整体无陈旧：命中＝登记、陈旧 0、新增 0（等价 CLI 读数「陈旧 0 条」）', () => {
  const entries = liveBaseline();
  const { anchors, stats } = liveScan();
  const { problems, fresh, covered, stale } = auditFreshness({ anchors, entries });
  // 先打读数再断言：绿的时候这行也可见，谁都能一眼核对规模。
  console.log(
    `[symbol-baseline-fresh] 基线 ${entries.length} 条、命中 ${covered.length} 条、陈旧 ${stale.length} 条、新增 ${fresh.length} 条（扫描 ${SCAN[0]} 下 ${stats.documents} 份文档、抽出 ${stats.candidates} 条「路径:行号」引用）`,
  );
  assertClean(problems, '符号基线与当前树不一致');
  assert.equal(
    covered.length,
    entries.length,
    `命中 ${covered.length} 条 ≠ 登记 ${entries.length} 条：既没有陈旧也没有新增却对不上，说明基线里有重复键（见上一条用例）`,
  );

  // 与 CLI 自己的读数对齐：这条行的口径就是 CI 门禁 `--strict --symbol=strict --scan docs` 打印的那一行。
  // 退出码不在这里断言——它同时受结构四判据与 ANCHOR_DRIFT 影响，那是另一条门禁的职责。
  const result = runMain(['--strict', '--symbol=strict', '--scan', SCAN[0]]);
  const readout = result.log.find(line => line.startsWith('SYMBOL-STRICT-BASELINE:'));
  assert.ok(readout !== undefined, `--symbol=strict 必须打印符号基线读数行，实际输出：\n${result.text}`);
  assert.equal(
    readout,
    `SYMBOL-STRICT-BASELINE: ${DEFAULT_SYMBOL_BASELINE} 登记 ${entries.length} 条；本次命中 ${entries.length} 条、基线外新增 0 条、陈旧 0 条`,
    'CLI 读数必须与进程内分区一致：陈旧的唯一合法取值是 0',
  );
});

test('④ 磁盘上的基线文件：JSON 可解析、字段齐全、条目按稳定顺序', () => {
  const absolute = resolve(ROOT, DEFAULT_SYMBOL_BASELINE);
  assert.ok(existsSync(absolute), `找不到 ${DEFAULT_SYMBOL_BASELINE}（期望在 ${absolute}）`);
  const text = readFileSync(absolute, 'utf8');
  assert.ok(!text.startsWith('\uFEFF'), `${DEFAULT_SYMBOL_BASELINE} 带 BOM：JSON.parse 会直接炸，提交前必须存成无 BOM UTF-8`);
  assert.ok(!text.includes('\r'), `${DEFAULT_SYMBOL_BASELINE} 混进了 CR：仓库已用 .gitattributes 声明 *.json eol=lf`);

  let document = null;
  try {
    document = JSON.parse(text);
  } catch (error) {
    assert.fail(`${DEFAULT_SYMBOL_BASELINE} 不是合法 JSON：${error.message}`);
  }
  assert.equal(document.schema_version, 1, `${DEFAULT_SYMBOL_BASELINE} 的 schema_version 必须是 1`);
  assert.ok(Array.isArray(document.entries), `${DEFAULT_SYMBOL_BASELINE} 必须有 entries 数组`);
  const entries = document.entries;
  assert.ok(entries.length >= MIN_ENTRIES, `${DEFAULT_SYMBOL_BASELINE} 只有 ${entries.length} 条，少于下限 ${MIN_ENTRIES} 条`);
  // 缺 doc／引用坐标／path 任一项都要红并点名（这里点名到具体条目，不止报「格式不对」）。
  assertClean(auditFields(entries), '磁盘基线字段');

  // 稳定顺序：文档按字典序成块，块内 docLine 不降。插行只会整体平移，不会打乱这个相对顺序。
  const docs = [...new Set(entries.map(entry => entry.doc))];
  const sortedDocs = [...docs].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  assert.deepEqual(
    docs,
    sortedDocs,
    `条目必须按文档名成块（同一文档的条目连续、块按字典序排）：\n实际：${docs.join('\n      ')}\n期望：${sortedDocs.join('\n      ')}`,
  );
  const misordered = [];
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (previous.doc !== current.doc) continue;
    if ((current.docLine ?? 0) < (previous.docLine ?? 0)) {
      misordered.push(`${describeEntry(current)}：排在同一文档上一行（docLine ${previous.docLine}）之后`);
    }
  }
  assert.equal(
    misordered.length,
    0,
    `同一文档内的条目必须按 docLine 升序（否则 diff 看不出「按源码位置加了哪一条」）：${formatProblems(misordered)}`,
  );
  console.log(
    `[symbol-baseline-fresh] ${DEFAULT_SYMBOL_BASELINE}：${entries.length} 条、${docs.length} 份文档、顺序稳定、字段齐全`,
  );
});

test('负控制：临时副本里注入一条不可能命中的条目 ⇒ 必须红并点名；删掉后复绿', () => {
  const realPath = resolve(ROOT, DEFAULT_SYMBOL_BASELINE);
  const realBytes = readFileSync(realPath);
  const entries = liveBaseline();
  const { anchors } = liveScan();

  // 注入前先确认是绿的：这就是门禁要的那份读数（三条断言各自独立，注入后要逐条验红）。
  assertClean(auditFields(entries), '注入前的字段');
  assertClean(auditResolvable({ entries }), '注入前的可解析性');
  assertClean(auditCommentAnchors(anchors, entries), '注入前的注释锚点');
  assertClean(auditFreshness({ anchors, entries }).problems, '注入前的三态差集');

  const root = mkdtempSync(join(tmpdir(), 'gy-symbol-baseline-fresh-'));
  try {
    // 只动副本：真文件按字节读进来、改副本、绝对路径交给 loader（`resolve(root, 绝对路径)` 原样返回）。
    const fakePath = join(root, 'doc-anchors-symbol-baseline.json');
    const document = JSON.parse(realBytes.toString('utf8'));
    document.entries = [...document.entries, INJECTED];
    writeFileSync(fakePath, `${JSON.stringify(document, null, 2)}\n`);
    const fakeEntries = loadSymbolBaseline(ROOT, fakePath).entries;
    assert.equal(fakeEntries.length, entries.length + 1, '副本必须比真基线多一条（注入没生效就谈不上负控制）');

    // ③ 差集：陈旧必须精确多出这一条，且点名到 文档:行 → 引用。
    const freshness = auditFreshness({ anchors, entries: fakeEntries });
    assert.equal(freshness.stale.length, 1, `陈旧必须恰好 1 条（注入的那条），实际 ${freshness.stale.length} 条`);
    assert.equal(freshness.stale[0].doc, INJECTED.doc, '陈旧条目必须是被注入的那一条');
    assert.equal(freshness.problems.length, 1, `差集断言必须恰好红 1 条：${formatProblems(freshness.problems)}`);
    assert.match(freshness.problems[0], /不存在\.md/u, '红的正文必须点名注入的那条');

    // ① 可解析性：doc 不存在 ⇒ 必须红并点名（不是「整体格式不对」这种糊话）。
    const resolvable = auditResolvable({ entries: fakeEntries });
    assert.equal(resolvable.length, 1, `可解析性必须恰好红 1 条（注入的那条），实际 ${resolvable.length} 条：${formatProblems(resolvable)}`);
    assert.match(resolvable[0], /不存在\.md/u, '红的正文必须点名注入的那条');
    assert.throws(
      () => assertClean(resolvable, '注入后的可解析性'),
      /不存在\.md/u,
      '注入了不可能命中的条目，可解析性断言必须抛出（这条断言就是负控制本身）',
    );

    // ② 注释锚点：它不在 `commentAnchors` 里 ⇒ 必须红并点名。
    const anchorsProblems = auditCommentAnchors(anchors, fakeEntries);
    assert.equal(anchorsProblems.length, 1, `注释锚点断言必须恰好红 1 条，实际 ${anchorsProblems.length} 条：${formatProblems(anchorsProblems)}`);
    assert.match(anchorsProblems[0], /不存在\.md/u, '红的正文必须点名注入的那条');

    // 把三次红逐条打出来：绿的那次运行里也看得见「注入 ⇒ 红」长什么样。
    for (const line of [...freshness.problems, ...resolvable, ...anchorsProblems]) {
      console.log(`[symbol-baseline-fresh] 负控制命中：${line}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // 复绿：临时目录已收掉，真基线按字节还是原来那份（本用例从头到尾没写过它）。
  assert.deepEqual(readFileSync(realPath), realBytes, `${DEFAULT_SYMBOL_BASELINE} 被改动了：负控制只许碰临时副本`);
  assertClean(auditFreshness({ anchors, entries: liveBaseline() }).problems, '删掉临时副本后的三态差集');
  console.log('[symbol-baseline-fresh] 负控制：注入时三条断言逐条红并点名，删掉临时副本后复绿');
});
