/**
 * `--symbol=count`：引用位置 → 声明块（符号）的关联统计。
 *
 * 钉住的性质（对应裁定 r37 ④ 与派单 B）：
 *   1. **每个引用的位置分别关联**——同一行里两条引用就是两条，不许退化成「一行一条」；
 *   2. 关联唯一才算「可核／命中」；关联不唯一或根本没有块时**明确输出「无法判定」，不猜、不算通过**；
 *   3. 统计**不改退出码**：`--strict` 的结构性判据（BROKEN／OUT_OF_RANGE／SUSPECT ＋ 基线）一切照旧；
 *   4. 参数不被静默忽略：未知参数、`--symbol` 的非白名单取值、`--symbol` 与基线生成同用都 exit 2；
 *   5. 兜底回退的块体必须**可见**（不许静默把错块当对块）；
 *   6. JSON/SQL 这类目标不硬套函数符号（裁定 ④：「不强制所有 JSON/SQL/历史读数都套函数符号」）。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { countSymbolAssociations, main } from '../../tools/verify-doc-anchors.mjs';

const APP_TS = [
  "import { helper } from './helper.ts';", //           1 —— 不在任何声明块内
  '', //                                                 2
  'export function buildApp({ config }: Options): FastifyInstance {', // 3
  '  const store = createStore();', //                   4
  '  const inner = () => {', //                          5
  '    return store.get();', //                          6
  '  };', //                                             7
  '  return inner;', //                                  8
  '}', //                                                9
  '', //                                                 10
  'const rows = query<{ id: string }>([1]);', //         11 —— 块体判定要走兜底回退（泛型里的类型字面量）
  '', //                                                 12
  'export const CONFIG = 1;', //                         13 —— 声明但没有块体
  '',
].join('\n');

const DOC_PATH = 'docs/architecture/symbol-count.md';

/** 文档夹具（一行一条引用，最后一行故意放两条）。断言里的位置一律按这些行现算，不写死线号。 */
const DOC_LINES = [
  '# 符号关联统计夹具',
  '',
  '- 命中（解构参数函数体）：services/api/src/app.ts:8',
  '- 命中（内层箭头函数）：services/api/src/app.ts:6-7',
  '- 越块尾（可核不命中）：services/api/src/app.ts:4-30',
  '- 无法判定（import 行不在任何声明块内）：services/api/src/app.ts:1',
  '- 无法判定（声明但没有块体）：services/api/src/app.ts:13',
  '- 不适用（JSON 不套函数符号）：packages/schema.json:1-2',
  '- 无法判定（同名多文件、路径不唯一）：src/route.ts:1',
  '- 同一行两条引用：services/api/src/app.ts:4 services/api/src/app.ts:8',
  '',
];

const FIXTURE = {
  'services/api/src/app.ts': APP_TS,
  'services/api/src/route.ts': 'export const a = 1;\n',
  'apps/admin/src/route.ts': 'export const b = 2;\n',
  'packages/schema.json': '{\n  "a": 1\n}\n',
  'tools/doc-anchors-baseline.json': `${JSON.stringify({ schema_version: 1, entries: [] }, null, 2)}\n`,
  [DOC_PATH]: DOC_LINES.join('\n'),
};

/**
 * 夹具文档里含 `needle` 的那一行（1-based）。
 * 断言里**不写死**任何 `文件:行号`：位置一律按夹具内容现算，夹具增删一行不会假红
 * （`tests/unit/test-line-anchors-guard.test.mjs` 的判据：行号必须算出来）。
 */
function docLineOf(needle) {
  const index = DOC_LINES.findIndex(line => line.includes(needle));
  assert.notEqual(index, -1, `夹具文档里没有「${needle}」这一行`);
  return index + 1;
}

/** 夹具源码 `APP_TS` 里含 `needle` 的那一行（1-based）。 */
function appLineOf(needle) {
  const index = APP_TS.split('\n').findIndex(line => line.includes(needle));
  assert.notEqual(index, -1, `夹具源码里没有「${needle}」这一行`);
  return index + 1;
}

/** 工具打印的引用位置形状：`services/api/src/app.ts:<起>[-<止>]`，行号现算。 */
function appAnchor(fromNeedle, toNeedle) {
  const from = appLineOf(fromNeedle);
  const to = toNeedle === undefined ? from : appLineOf(toNeedle);
  return `services/api/src/app.ts:${from}${to === from ? '' : `-${to}`}`;
}

function makeFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'gy-symbol-count-'));
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

test('每个引用位置分别关联：一行里两条引用算两条，不退化成一 行一条', () => {
  const root = makeFixture(FIXTURE);
  try {
    const { references, hit } = countSymbolAssociations({ root, targets: ['docs/architecture'] }).stats;
    // 夹具 7 行引用 + 最后一行 2 条 = 9 条；若退化成「一行一条」只会是 8 条。
    assert.equal(references, 9);
    assert.equal(hit, 4, 'app.ts:8 / app.ts:6-7 / 同行两条各一次 = 4 条命中');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('命中：解构参数函数的块体覆盖函数体内部的行（不是参数那一行）', () => {
  const root = makeFixture(FIXTURE);
  try {
    const { undecidable } = countSymbolAssociations({ root, targets: ['docs/architecture'] });
    const importItem = undecidable.find(item => item.docLine === docLineOf('import 行不在任何声明块内'));
    assert.ok(importItem !== undefined, 'import 那一行必须报「无法判定」，不许猜、不许算通过');
    assert.equal(importItem.target, appAnchor('import { helper }'), '点名要给出引用位置');
    assert.equal(importItem.reason, '该行不在任何声明块内');
    // 函数体那一行命中，意味着它被关联到了 buildApp 的块，而不是被算成单行的解构参数块。
    assert.equal(undecidable.some(item => item.docLine === docLineOf('命中（解构参数函数体）')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('最内层优先：嵌套声明里关联到内层符号，外层只覆盖不被内层覆盖的行', () => {
  const root = makeFixture(FIXTURE);
  try {
    const { undecidable } = countSymbolAssociations({ root, targets: ['docs/architecture'] });
    // 内层箭头函数那一段落在 inner 块里 → 命中；若错关联到外层就会越界成「可核不命中」。
    assert.equal(undecidable.some(item => item.docLine === docLineOf('命中（内层箭头函数）')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('越块尾：符号可核但区间没全落在块内 → 计入可核、不计入命中', () => {
  const root = makeFixture(FIXTURE);
  try {
    const { stats } = countSymbolAssociations({ root, targets: ['docs/architecture'] });
    assert.equal(stats.checkable, 5, '命中 4 条 + 越块尾 1 条');
    assert.equal(stats.hit, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('无法判定：没有块体 / 路径不唯一都进「无法判定」，且逐条带原因，不猜', () => {
  const root = makeFixture(FIXTURE);
  try {
    const { stats, reasons, undecidable } = countSymbolAssociations({ root, targets: ['docs/architecture'] });
    assert.equal(stats.undecidable, 3, 'import 行 + 无块体声明 + 同名多文件');
    assert.equal(reasons.get('该行不在任何声明块内'), 2);
    assert.equal(reasons.get('引用路径不唯一'), 1);
    for (const item of undecidable) {
      assert.ok(item.doc.endsWith('symbol-count.md'));
      assert.ok(item.docLine >= 1);
      assert.ok(item.reason.length > 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('不适用：JSON 目标不硬套函数符号，也不计入三档', () => {
  const root = makeFixture(FIXTURE);
  try {
    const { stats } = countSymbolAssociations({ root, targets: ['docs/architecture'] });
    assert.equal(stats.notApplicable, 1);
    assert.equal(stats.references, stats.checkable + stats.undecidable + stats.notApplicable);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('兜底回退可见：泛型类型字面量当块体时打标记，不静默当对块', () => {
  const root = makeFixture(FIXTURE);
  try {
    const { stats } = countSymbolAssociations({ root, targets: ['docs/architecture'] });
    assert.equal(stats.fallback, 0, '夹具里 app.ts:11 没有被文档引用');
    const withRef = makeFixture({
      ...FIXTURE,
      'docs/architecture/all.md': '- services/api/src/app.ts:11\n',
    });
    try {
      const only = countSymbolAssociations({ root: withRef, targets: ['docs/architecture'] });
      const file = countSymbolAssociations({
        root: withRef,
        targets: ['docs/architecture'],
        documents: ['docs/architecture/all.md'],
      });
      assert.equal(only.stats.references, 10);
      assert.equal(file.stats.fallback, 1, 'app.ts:11 的 const 声明块走了兜底回退');
      assert.equal(file.stats.checkable, 1);
    } finally {
      rmSync(withRef, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI：--symbol=count 打印三档计数与逐条「无法判定」，退出码仍为 0', () => {
  const root = makeFixture(FIXTURE);
  try {
    const result = runMain([...scanArgs(root), '--symbol=count']);
    assert.equal(result.code, 0, '统计不改退出码');
    assert.match(result.text, /SYMBOL-COUNT: 引用 9 条/u);
    assert.match(result.text, /可核 5 条（其中命中 4 条）\/ 无法判定 3 条 \/ 不适用 1 条/u);
    assert.match(result.text, /SYMBOL-UNDECIDABLE: 3 条逐条列出/u);
    // 逐条点名必须是「文档:行 → 引用位置（原因）」，位置按夹具现算，不写死线号。
    const printed = result.text.split('\n')
      .find(line => line.includes(`${DOC_PATH}:${docLineOf('import 行不在任何声明块内')} → `));
    assert.ok(printed !== undefined, `无法判定必须逐条点名 文档:行 → 引用位置，实际输出：\n${result.text}`);
    assert.ok(printed.includes(appAnchor('import { helper }')), `点名要带引用位置，实际：${printed}`);
    assert.ok(printed.includes('该行不在任何声明块内'), `点名要带原因，实际：${printed}`);
    assert.match(result.text, /SYMBOL: --symbol=count 只统计不判红/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI：--symbol=count 不改 --strict 口径（新 BROKEN 照样 exit 1）', () => {
  const root = makeFixture({
    ...FIXTURE,
    'docs/architecture/broken.md': '- 缺失文件：services/api/src/no-such-file.ts:1\n',
  });
  try {
    assert.equal(runMain([...scanArgs(root), '--strict']).code, 1);
    assert.equal(runMain([...scanArgs(root), '--strict', '--symbol=count']).code, 1, '统计不改 --strict 判据');
    assert.equal(runMain([...scanArgs(root), '--symbol=count']).code, 0, '不加 --strict 时统计不判红');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI：参数不被静默忽略——未知参数／非白名单取值／缺取值／与基线生成同用都 exit 2', () => {
  const root = makeFixture(FIXTURE);
  try {
    const cases = [
      ['--bogus-arg'],
      ['--symbol=bogus'],
      ['--symbol'],
      [...scanArgs(root), '--symbol=count', '--emit-baseline'],
    ];
    for (const argv of cases) {
      const result = runMain(argv);
      assert.equal(result.code, 2, `应报错退出：${argv.join(' ')}`);
      assert.ok(result.error.length > 0, `应有错误信息：${argv.join(' ')}`);
    }
    assert.match(runMain(['--symbol=bogus']).error.join('\n'), /--symbol 只支持 count（收到：bogus）/u);
    assert.match(runMain(['--bogus-arg']).error.join('\n'), /未知参数：--bogus-arg/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
