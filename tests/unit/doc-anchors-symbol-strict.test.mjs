/**
 * `--symbol=strict`：注释锚点（`COMMENT_ANCHOR`）的「基线／新增／陈旧」三态。
 *
 * 钉住的性质（对应 D09）：
 *   1. **基线内命中只计数不判红**：exit 0，读数给出登记数、命中数、分档条数；
 *   2. **基线之外新增在 `--strict` 下 exit 1 并逐条点名**：文档 file:line → 引用（目标文件那一行的
 *      实际内容），作者不用回目标文件里自己找「到底指到了什么」；
 *   3. **条目不再命中报 `STALE-SYMBOL` 点名要求删**——陈旧只提示，不单独把 exit code 拉红（与结构基线同口径）；
 *   4. **白名单只认 `count|strict`**：未知取值 exit 2，不许「未知即放行」（这是本判据最不能出的错）；
 *   5. **`--symbol=count` 一字未变**：读数行与文案照旧，且不打印严格档任何一种读数；
 *   6. **`落在文档注释里`（comment-attached）仍走 `NOT_SYMBOL_LINE` ＋结构基线**：两份基线互不干扰。
 *
 * 全部用临时目录夹具 ＋ 直接调导出的函数，无网络、不依赖真实 git 历史。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  COMMENT_ANCHOR,
  DEFAULT_SYMBOL_BASELINE,
  commentAnchorKey,
  loadSymbolBaseline,
  main,
  partitionSymbolByBaseline,
} from '../../tools/verify-doc-anchors.mjs';

const TARGET = 'services/api/src/widget.ts';

/**
 * 目标源码夹具，四种落点各一条（行号一律现算，不写死）：
 *   1-3 文件头自述块（块后是 `import` ⇒ 没有声明行 ⇒ comment-detached）
 *   8   `//` 行注释（块后是接口成员 `label: string;` ⇒ 不是声明行 ⇒ comment-detached）
 *   12  真代码行（`export const WIDGET_ID = ...` ⇒ code）
 *   14  文档注释，文档**逐字引**了它的原文（⇒ comment-cited）
 *   17  文档注释，文档没引原文（⇒ comment-attached，仍归结构判据）
 */
const WIDGET_TS = [
  '/**', //                                                          1
  ' * 组件夹具：展示层只读，不碰数据。', //                          2
  ' */', //                                                          3
  "import type { Item } from './item.ts';", //                        4
  '', //                                                             5
  'export interface WidgetOptions {', //                             6
  '  id: string;', //                                                 7
  '  // 行注释：只解释下面的成员语义，成员本身不是声明。', //        8
  '  label: string;', //                                             9
  '}', //                                                            10
  '', //                                                             11
  "export const WIDGET_ID = 'w-1';", //                              12
  '', //                                                             13
  '/** 选择器默认按 id 升序。 */', //                                14
  "export const SELECTOR = 'id';", //                                15
  '', //                                                             16
  '/** 超时毫秒数。 */', //                                          17
  'export const TIMEOUT_MS = 1000;', //                              18
  '',
].join('\n');

const WIDGET_LINES = WIDGET_TS.split('\n');

/** 夹具源码里含 `needle` 的行号（1-based）；断言里不写死行号，夹具增删一行不会假红。 */
function lineOf(needle) {
  const index = WIDGET_LINES.findIndex(line => line.includes(needle));
  assert.notEqual(index, -1, `夹具源码里没有「${needle}」这一行`);
  return index + 1;
}

const DOC_PATH = 'docs/architecture/symbol-strict.md';
const HEADER_SPAN_LINE = lineOf(' * 组件夹具');
const LINE_COMMENT = lineOf('行注释：只解释');
const CODE_LINE = lineOf('export const WIDGET_ID');
const CITED_LINE = lineOf('/** 选择器默认按 id 升序。 */');
const ATTACHED_LINE = lineOf('/** 超时毫秒数。 */');
const anchor = line => `${TARGET}:${line}`;

/** 夹具文档：一行一条引用（`--symbol=strict` 只判 `docs/architecture/**` × 源码后缀）。 */
const DOC_LINES = [
  '# 符号落点严格档夹具',
  '',
  `- 文件头自述：${anchor(HEADER_SPAN_LINE)}`,
  `- 行注释：${anchor(LINE_COMMENT)}`,
  `- 代码行：${anchor(CODE_LINE)}`,
  `- 逐字引用注释原文：${anchor(CITED_LINE)}（「选择器默认按 id 升序」）`,
  `- 落在文档注释里：${anchor(ATTACHED_LINE)}`,
  '',
];

/** 符号基线：三条「没落代码行」的引用各一条，`note` 必须写明为什么（loader 拒收空 note）。 */
function symbolEntry(line, note) {
  return {
    path: TARGET,
    reason: COMMENT_ANCHOR,
    owner: 'api-server',
    reference: anchor(line),
    doc: DOC_PATH,
    docLine: DOC_LINES.findIndex(text => text.includes(anchor(line))) + 1,
    note,
  };
}

const SYMBOL_ENTRIES = [
  symbolEntry(HEADER_SPAN_LINE, '【夹具·文件头自述块】引用的是文件头对整份文件的说明，块后是 import，没有声明行可指。'),
  symbolEntry(LINE_COMMENT, '【夹具·行内单行注释】引用的是接口成员上方的 `//` 注释，成员签名不是声明行。'),
  symbolEntry(CITED_LINE, '【夹具·逐字引用注释原文】文档引的是注释原文，注释紧贴声明行但引的不是声明。'),
];

/** 结构基线：只承接「落在文档注释里」那一条（`--symbol=strict` 不管它）。 */
const STRUCTURAL_ENTRIES = [
  { path: TARGET, reason: 'NOT_SYMBOL_LINE', owner: 'api-server', reference: anchor(ATTACHED_LINE) },
];

function makeFixture({ docLines = DOC_LINES, symbolEntries = SYMBOL_ENTRIES, structuralEntries = STRUCTURAL_ENTRIES, extra = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gy-symbol-strict-'));
  const files = {
    [TARGET]: WIDGET_TS,
    [DOC_PATH]: docLines.join('\n'),
    'tools/doc-anchors-baseline.json': `${JSON.stringify({ schema_version: 1, entries: structuralEntries }, null, 2)}\n`,
    'tools/doc-anchors-symbol-baseline.json': `${JSON.stringify({ schema_version: 1, entries: symbolEntries }, null, 2)}\n`,
    ...extra,
  };
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

function runMain(argv) {
  const log = [];
  const error = [];
  const code = main(argv, { log: line => log.push(String(line)), error: line => error.push(String(line)) });
  return { code, log, error, text: [...log, ...error].join('\n') };
}

const scanArgs = root => ['--root', root, '--scan', 'docs/architecture', '--baseline', 'tools/doc-anchors-baseline.json'];
const strictArgs = root => [...scanArgs(root), '--strict', '--symbol=strict'];

/** 每次跑完都要收掉临时目录（无网络、无全局状态，跑慢了也不留垃圾）。 */
function withFixture(options, body) {
  const root = makeFixture(options);
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('基线内命中：只计数不判红，读数给出登记／命中／分档', () => {
  withFixture({}, root => {
    const result = runMain(strictArgs(root));
    assert.equal(result.code, 0, `基线内命中必须 exit 0，实际输出：\n${result.text}`);
    assert.match(result.text, /SYMBOL-STRICT: 作用域 docs\/architecture\/\*\* × 源码后缀——可判 5 条：落代码行 1 条通过、未落代码行 3 条进基线（注释但非文档注释 2、逐字引用注释文案 1）/u);
    assert.match(result.text, new RegExp(`SYMBOL-STRICT-BASELINE: ${DEFAULT_SYMBOL_BASELINE} 登记 3 条；本次命中 3 条、基线外新增 0 条、陈旧 0 条`, 'u'));
    assert.match(result.text, /SYMBOL-STRICT-COVERED: 基线内 3 条只计数不判红（注释但非文档注释 2 条、逐字引用注释文案 1 条）/u);
    assert.match(result.text, /PASS: --strict 下没有基线之外的新增（结构四判据、ANCHOR_DRIFT、BARE_ORPHAN 与 COMMENT_ANCHOR/u);
    // 「落在文档注释里」那条仍归结构判据，没被符号基线吞掉。
    assert.match(result.text, /落在文档注释里 1 条仍按 NOT_SYMBOL_LINE ＋结构基线判/u);
    assert.match(result.text, /BASELINE: tools\/doc-anchors-baseline\.json 登记 1 条；本次命中 1 条、基线外新增 0 条、陈旧 0 条/u);
  });
});

test('基线外新增：--strict 下 exit 1，并逐条点名（文档:行 → 引用 → 该行实际内容）', () => {
  const extraLine = `- 新增注释锚点：${anchor(HEADER_SPAN_LINE + 1)}`;
  withFixture({
    extra: { 'docs/architecture/extra.md': `${extraLine}\n` },
  }, root => {
    const result = runMain(strictArgs(root));
    assert.equal(result.code, 1, `基线外新增必须 exit 1，实际输出：\n${result.text}`);
    assert.match(result.error.join('\n'), /FAIL: 符号落点闸门未通过（--symbol=strict 的 COMMENT_ANCHOR 基线之外新增 1 条；判据只管 docs\/architecture\/\*\* × 源码后缀）/u);
    const printed = result.error.find(line => line.includes('docs/architecture/extra.md:1 → '));
    assert.ok(printed !== undefined, `点名必须给出 文档:行 → 引用，实际：\n${result.error.join('\n')}`);
    assert.ok(printed.includes(anchor(HEADER_SPAN_LINE + 1)), `点名要带引用位置，实际：${printed}`);
    // 目标文件那一行的**实际内容**要打出来：`*/`（文件头自述块的第 3 行）。
    assert.ok(printed.includes('实际内容「*/」'), `点名要带目标行实际内容，实际：${printed}`);
    assert.ok(printed.includes('锚点落在注释上'), `点名要说明为什么没落代码行，实际：${printed}`);
    // 同一份夹具换 count 档：只统计、不判红 —— 两档分工不许被这条新引用弄混。
    const counted = runMain([...scanArgs(root), '--symbol=count']);
    assert.equal(counted.code, 0, `--symbol=count 不该判红，实际输出：\n${counted.text}`);
    assert.doesNotMatch(counted.text, /SYMBOL-STRICT/u);
  });
});

test('不加 --strict 时不判红：严格档照旧只是读数（与其它闸门的 dry-run 口径一致）', () => {
  const extraLine = `- 新增注释锚点：${anchor(HEADER_SPAN_LINE + 1)}`;
  withFixture({ extra: { 'docs/architecture/extra.md': `${extraLine}\n` } }, root => {
    const result = runMain([...scanArgs(root), '--symbol=strict']);
    assert.equal(result.code, 0, `dry-run 不该 exit 1，实际输出：\n${result.text}`);
    assert.match(result.text, /基线外新增 1 条/u);
    assert.match(result.text, /MODE: dry-run/u);
  });
});

test('基线陈旧：报 STALE-SYMBOL 并点名，要求删（陈旧不单独把 exit code 拉红）', () => {
  const staleLine = CODE_LINE + 100;
  const staleEntry = {
    path: TARGET,
    reason: COMMENT_ANCHOR,
    owner: 'api-server',
    reference: anchor(staleLine),
    doc: DOC_PATH,
    docLine: 99,
    note: '【夹具·陈旧】故意登记一条已不存在的锚点，验证陈旧条目会被点名要求删除。',
  };
  withFixture({ symbolEntries: [...SYMBOL_ENTRIES, staleEntry] }, root => {
    const result = runMain(strictArgs(root));
    assert.equal(result.code, 0, `陈旧只提示、不判红，实际输出：\n${result.text}`);
    assert.match(result.text, /STALE-SYMBOL: 1 条符号基线条目已不再命中/u);
    const printed = result.log.find(line => line.includes(`→ ${anchor(staleLine)}`));
    assert.ok(printed !== undefined, `陈旧条目必须点名，实际：\n${result.text}`);
    assert.ok(printed.includes(COMMENT_ANCHOR) && printed.includes('owner=api-server'), `点名要带 reason 与 owner，实际：${printed}`);
    assert.match(result.text, /本次命中 3 条、基线外新增 0 条、陈旧 1 条/u);
  });
});

test('基线条目被改成不命中的值：该条报陈旧，同时真锚点变成新增（两个方向都要报）', () => {
  const broken = SYMBOL_ENTRIES.map(entry => (
    entry.reference === anchor(LINE_COMMENT) ? { ...entry, reference: anchor(LINE_COMMENT + 1) } : entry
  ));
  withFixture({ symbolEntries: broken }, root => {
    const result = runMain(strictArgs(root));
    assert.equal(result.code, 1, `基线被改坏后真锚点成了新增，必须 exit 1，实际输出：\n${result.text}`);
    assert.match(result.text, /STALE-SYMBOL: 1 条符号基线条目已不再命中/u);
    assert.match(result.text, new RegExp(`· ${DOC_PATH} → ${anchor(LINE_COMMENT + 1)}（${COMMENT_ANCHOR}`, 'u'));
    assert.match(result.error.join('\n'), /FAIL: 符号落点闸门未通过（--symbol=strict 的 COMMENT_ANCHOR 基线之外新增 1 条/u);
    assert.ok(result.error.some(line => line.includes(`${DOC_PATH}:${DOC_LINES.findIndex(text => text.includes(anchor(LINE_COMMENT))) + 1} → ${anchor(LINE_COMMENT)}`)), `真锚点必须被点名，实际：\n${result.error.join('\n')}`);
  });
});

test('白名单只认 count|strict：未知取值 exit 2，报出支持的取值（不许未知即放行）', () => {
  for (const value of ['bogus', 'strict2', 'COUNT', 'strict ']) {
    const result = runMain([`--symbol=${value}`]);
    assert.equal(result.code, 2, `--symbol=${value} 应报错退出，实际：${result.text}`);
    assert.match(result.error.join('\n'), /--symbol 只支持 count\|strict（收到：/u);
  }
  assert.match(runMain(['--symbol=bogus']).error.join('\n'), /--symbol 只支持 count\|strict（收到：bogus）/u);
  // 少给取值也不算白名单内：不静默当成 count。
  assert.equal(runMain(['--symbol']).code, 2);
});

test('--symbol=count 行为与文案未变：不打印严格档读数，且不因注释锚点判红', () => {
  withFixture({}, root => {
    const base = runMain([...scanArgs(root), '--symbol=count']);
    assert.equal(base.code, 0, `count 档不判红，实际输出：\n${base.text}`);
    assert.match(base.text, /SYMBOL: --symbol=count 只统计不判红/u);
    assert.match(base.text, /SYMBOL-COUNT: 引用 5 条/u);
    // 严格档的三种读数一个都不许出现（两档分工：count 只统计）。
    assert.doesNotMatch(base.text, /SYMBOL-STRICT/u);
    assert.doesNotMatch(base.text, /STALE-SYMBOL/u);
    // 新增注释锚点也不改 count 档的退出码。
    const withExtra = root;
    writeFileSync(join(withExtra, 'docs/architecture/extra.md'), `- 新增注释锚点：${anchor(HEADER_SPAN_LINE + 1)}\n`);
    assert.equal(runMain([...scanArgs(root), '--symbol=count']).code, 0);
    assert.equal(runMain([...scanArgs(root), '--symbol=count', '--strict']).code, 0);
  });
});

test('两份基线互不干扰：「落在文档注释里」去掉结构基线条目后归结构闸门判红，不是符号闸门', () => {
  withFixture({ structuralEntries: [] }, root => {
    const result = runMain(strictArgs(root));
    assert.equal(result.code, 1);
    assert.match(result.error.join('\n'), /FAIL: 文档行号闸门未通过（基线之外新增 1 条）/u);
    assert.doesNotMatch(result.error.join('\n'), /FAIL: 符号落点闸门未通过/u);
    assert.match(result.text, /本次命中 3 条、基线外新增 0 条、陈旧 0 条/u);
  });
});

test('分区函数：命中／新增／陈旧三态与重复条目的重数法', () => {
  const first = { doc: 'a.md', reference: 'x.ts:1', docLine: 1 };
  const second = { doc: 'a.md', reference: 'x.ts:2', docLine: 2 };
  const entries = [
    { doc: 'a.md', reference: 'x.ts:1', reason: COMMENT_ANCHOR, note: 'x' },
    { doc: 'a.md', reference: 'x.ts:2', reason: COMMENT_ANCHOR, note: 'x' },
    { doc: 'a.md', reference: 'x.ts:2', reason: COMMENT_ANCHOR, note: '重复登记' },
  ];
  const { covered, fresh, stale } = partitionSymbolByBaseline([first, second], entries);
  assert.deepEqual(covered.map(item => item.reference), ['x.ts:1', 'x.ts:2']);
  assert.equal(fresh.length, 0);
  assert.equal(stale.length, 1, '重复登记的那条要算陈旧，不许静默吃掉');
  // 同 key 重复时先被「命中」区消费，剩下的那条进陈旧名单（只报一条，不重复刷屏）。
  assert.equal(stale[0].reference, 'x.ts:2');
  // 文档行号不进 key：正文插行不该让整条基线失效。
  assert.equal(commentAnchorKey({ doc: 'a.md', reference: 'x.ts:1', docLine: 4321 }), 'a.md|x.ts:1');
});

test('符号基线 loader：缺 note／reason 不是 COMMENT_ANCHOR 都拒收（基线必须逐条带原因）', () => {
  const root = mkdtempSync(join(tmpdir(), 'gy-symbol-strict-loader-'));
  try {
    mkdirSync(join(root, 'tools'), { recursive: true });
    const write = entries => writeFileSync(join(root, DEFAULT_SYMBOL_BASELINE), `${JSON.stringify({ schema_version: 1, entries }, null, 2)}\n`);
    assert.equal(loadSymbolBaseline(root).missing, true, '文件不存在按空基线处理');
    write([{ doc: 'a.md', reference: 'x.ts:1', reason: COMMENT_ANCHOR, note: '  ' }]);
    assert.throws(() => loadSymbolBaseline(root), /缺原因（note 不得为空/u);
    write([{ doc: 'a.md', reference: 'x.ts:1', reason: 'BROKEN', note: 'reason 写错' }]);
    assert.throws(() => loadSymbolBaseline(root), /reason 不是 COMMENT_ANCHOR/u);
    write([{ reference: 'x.ts:1', reason: COMMENT_ANCHOR, note: '缺 doc' }]);
    assert.throws(() => loadSymbolBaseline(root), /缺字段/u);
    write([{ doc: 'a.md', reference: 'x.ts:1', reason: COMMENT_ANCHOR, note: '带原因' }]);
    assert.equal(loadSymbolBaseline(root).entries.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
