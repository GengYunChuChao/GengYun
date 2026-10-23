/**
 * GY-I22 证据表生成器 · 「不许悄悄改写归档快照」的负控制。
 *
 * 为什么有这个文件：`tools/i22-failmatrix-evidence-table.mjs` 原来默认写
 * `docs/verification/gy-i22-failmatrix-20261022.md`——那是 R29 建页的**归档快照**（表格 168 行 /
 * 负控制 23 条）。`EXPECTED` 校正到 230 / 26 之后，裸跑 `--write` 会**无报错**把那份快照重写成
 * 230 行。拦截必须能被机械证伪，所以这里真跑子进程、真读文件字节，不 mock：
 *
 *   1. 正控制：工件自洽 + 目标页是普通页 ⇒ `--write` 真的写盘、exit 0（证明守卫不是「永远红」）；
 *   2. 负控制（本片核心）：`EXPECTED` 与工件不一致 ⇒ `--write` **不写盘**且 exit 1
 *      （写盘已挪到对账 `problems` 判定之后）；
 *   3. 负控制：真实归档页在「裸 `--write`」「显式 `--page=`」「再加 `--i-know-this-rewrites-archive`」
 *      三种调用下都**不被改写**——最后一种因为页内条数（168）≠ `EXPECTED`（230）同样被拒；
 *   4. 负控制：目标页缺生成器标记 ⇒ 拒绝写入且不写盘。
 *
 * 为什么用临时树：生成器的 `ROOT` 由脚本自身位置推导，`--matrix=` / `--nc=` / `--page=` 都按该
 * `ROOT` 解析相对路径（绝对路径解析不了是既有行为，本测试不碰）。所以夹具树 = 把工具原样复制到
 * `<tmp>/tools/`，工件放 `<tmp>/tests/failmatrix/.artifacts/`，目标页放 `<tmp>/docs/`。
 * 真仓库里只有第 3 组会真的打开归档页——而且只读断言它一个字节都没变。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = path.join(ROOT, 'tools', 'i22-failmatrix-evidence-table.mjs');
/** R29 归档快照页：本测试要求它在任何 `--write` 组合下都不被改写。 */
const ARCHIVE_PAGE = 'docs/verification/gy-i22-failmatrix-20261022.md';

/** 带两对生成器标记的普通目标页（内容故意是占位，写盘后必须被替换掉）。 */
const PAGE_FIXTURE = [
  '# 夹具页（证据表生成器）',
  '',
  '<!-- BEGIN:MATRIX-TABLE -->',
  '（待生成）',
  '<!-- END:MATRIX-TABLE -->',
  '',
  '<!-- BEGIN:NEGATIVE-CONTROL-TABLE -->',
  '（待生成）',
  '<!-- END:NEGATIVE-CONTROL-TABLE -->',
  '',
].join('\n');

/**
 * 从工具源码里读 `EXPECTED` 字面量（不做二次硬编码：常量一改，夹具自动跟上，不会漂成第二份账）。
 * 只做「给裸键补引号 → JSON.parse」，不 eval 任何代码。
 */
function readExpected() {
  const source = readFileSync(TOOL, 'utf8');
  const match = source.match(/const EXPECTED = Object\.freeze\((\{[\s\S]*?\n\})\);/);
  assert.ok(match, '工具里找不到 `const EXPECTED = Object.freeze({…});`：声明被重构了，本测试的夹具需要同步');
  const quoted = match[1]
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":') // 裸键补引号
    .replace(/,\s*([}\]])/g, '$1'); // 去掉 JSON 不接受的尾逗号
  return JSON.parse(quoted);
}

/** 按 EXPECTED 造一份**自洽**的矩阵机读结果（每条一行、全 PASS）。 */
function buildMatrix(expected) {
  const rows = [];
  for (const [family, count] of Object.entries(expected.families)) {
    for (let index = 1; index <= count; index += 1) {
      rows.push({
        id: `${family}-${String(index).padStart(2, '0')}`,
        family,
        expected: { status: 200, code: `${family}_OK` },
        actual: { status: 200, code: `${family}_OK` },
        verdict: 'PASS',
      });
    }
  }
  return {
    generated_at: 'fixture',
    node: 'fixture',
    base_commit: '0'.repeat(40),
    transport: 'fixture',
    totals: { total: rows.length, pass: rows.length, fail: 0 },
    families: Object.fromEntries(Object.entries(expected.families).map(([family, total]) => [family, { total, fail: 0 }])),
    batches: Object.entries(expected.batches).map(([id, total]) => ({ id, total })),
    rows,
  };
}

/** 按 EXPECTED 造一份**自洽**的负控制机读结果（全 PASS）。 */
function buildNegativeControls(expected) {
  const entries = Array.from({ length: expected.negativeControls }, (_, index) => ({
    id: `NC-${String(index + 1).padStart(2, '0')}`,
    title: '夹具',
    file: 'tools/fixture.mjs',
    watch: ['C1-01'],
    evidence: { sha256_before: { 'tools/fixture.mjs': 'a'.repeat(64) } },
    verdict: 'PASS',
  }));
  return { generated_at: 'fixture', node: 'fixture', total: entries.length, pass: entries.length, fail: 0, entries };
}

/** 建一棵夹具树：工具目录 + 工件目录 + docs 目标页。 */
function makeTree(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'gy-i22-evidence-table-'));
  mkdirSync(path.join(root, 'tools'), { recursive: true });
  mkdirSync(path.join(root, 'tests', 'failmatrix', '.artifacts'), { recursive: true });
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  copyFileSync(TOOL, path.join(root, 'tools', 'i22-failmatrix-evidence-table.mjs'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    tool: path.join(root, 'tools', 'i22-failmatrix-evidence-table.mjs'),
    page: path.join(root, 'docs', 'page.md'),
    writeArtifacts(matrix, nc) {
      writeFileSync(
        path.join(root, 'tests', 'failmatrix', '.artifacts', 'matrix.json'),
        `${JSON.stringify(matrix, null, 2)}\n`,
        'utf8',
      );
      writeFileSync(
        path.join(root, 'tests', 'failmatrix', '.artifacts', 'negative-control.json'),
        `${JSON.stringify(nc, null, 2)}\n`,
        'utf8',
      );
    },
  };
}

function runTool(toolPath, args, cwd) {
  const result = spawnSync(process.execPath, [toolPath, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** 页内某对生成器标记之间的表格行数（与工具判据一致：以 `| \`` 开头的数据行）。 */
function countRowsBetweenMarkers(page, marker) {
  const begin = `<!-- BEGIN:${marker} -->`;
  const end = `<!-- END:${marker} -->`;
  const start = page.indexOf(begin);
  const stop = page.indexOf(end);
  assert.ok(start >= 0 && stop > start, `页里缺标记 ${begin} … ${end}`);
  return page
    .slice(start + begin.length, stop)
    .split('\n')
    .filter((line) => line.startsWith('| `')).length;
}

test('证据表生成器：工件自洽时 --write 真的写盘（守卫不是永远红）', (t) => {
  const tree = makeTree(t);
  const expected = readExpected();
  tree.writeArtifacts(buildMatrix(expected), buildNegativeControls(expected));
  writeFileSync(tree.page, PAGE_FIXTURE, 'utf8');

  const result = runTool(tree.tool, ['--write', '--page=docs/page.md'], tree.root);
  assert.equal(result.status, 0, `应有 0 退出，实际 ${result.status}：\n${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stdout,
    new RegExp(`自洽：矩阵 ${expected.total} 条全 PASS`),
    `末行自洽读数不对：\n${result.stdout}`,
  );

  const page = readFileSync(tree.page, 'utf8');
  assert.ok(!page.includes('（待生成）'), '占位内容没有被替换：标记之间的内容没写进去');
  assert.equal(
    countRowsBetweenMarkers(page, 'MATRIX-TABLE'),
    expected.total,
    `写进页里的矩阵表行数不是 ${expected.total}`,
  );
  assert.equal(
    countRowsBetweenMarkers(page, 'NEGATIVE-CONTROL-TABLE'),
    expected.negativeControls,
    `写进页里的负控制表行数不是 ${expected.negativeControls}`,
  );
});

test('证据表生成器：EXPECTED 与工件不一致时 --write 不写盘且 exit 1', (t) => {
  const tree = makeTree(t);
  const expected = readExpected();
  const matrix = buildMatrix(expected);
  // 两处人为不一致：总条数 −1、C1 族 −1（真跑少一条用例的形态）。
  matrix.totals.total = expected.total - 1;
  matrix.families.C1.total = expected.families.C1 - 1;
  tree.writeArtifacts(matrix, buildNegativeControls(expected));
  writeFileSync(tree.page, PAGE_FIXTURE, 'utf8');

  const result = runTool(tree.tool, ['--write', '--page=docs/page.md'], tree.root);
  assert.equal(result.status, 1, `对账不一致应 exit 1，实际 ${result.status}：\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, new RegExp(`总条数 期望 ${expected.total} 条，实际 ${expected.total - 1} 条`));
  assert.match(result.stderr, /拒绝写入 docs\/page\.md：对账不通过/);
  assert.equal(readFileSync(tree.page, 'utf8'), PAGE_FIXTURE, '对账不通过却写盘了：写盘必须在对账之后');
});

test('证据表生成器：真实归档快照页在三种 --write 调用下都不被改写', (t) => {
  const archivePath = path.join(ROOT, ARCHIVE_PAGE);
  const before = readFileSync(archivePath, 'utf8');
  // 归档页里矩阵表的行数就是它的基线读数（168），EXPECTED 是 230：两者必须能区分开。
  const archiveRows = countRowsBetweenMarkers(before, 'MATRIX-TABLE');
  const expected = readExpected();
  assert.notEqual(archiveRows, expected.total, '归档页条数与 EXPECTED 相等了：这条负控制的前提变了，需人工复核');

  const cases = [
    { args: ['--write'], note: '裸 --write（没有隐式默认页）' },
    { args: ['--write', `--page=${ARCHIVE_PAGE}`], note: '显式点名归档页' },
    { args: ['--write', `--page=${ARCHIVE_PAGE}`, '--i-know-this-rewrites-archive'], note: '双钥匙都给了' },
  ];
  for (const one of cases) {
    const result = runTool(TOOL, one.args, ROOT);
    assert.equal(result.status, 1, `${one.note} 应 exit 1，实际 ${result.status}：\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /拒绝写入/, `${one.note} 没有打印拒绝原因：\n${result.stderr}`);
    assert.equal(readFileSync(archivePath, 'utf8'), before, `${one.note} 改写了归档快照`);
  }
  // 双钥匙那条必须点明「条数不一致」，否则等于只剩一把钥匙。
  const forced = runTool(TOOL, cases[2].args, ROOT);
  assert.match(forced.stderr, new RegExp(`条数 ${archiveRows} 与 EXPECTED ${expected.total} 不一致`));
});

test('证据表生成器：目标页缺生成器标记时拒绝写入（不写盘）', (t) => {
  const tree = makeTree(t);
  const expected = readExpected();
  tree.writeArtifacts(buildMatrix(expected), buildNegativeControls(expected));
  const markerless = '# 没有标记的页\n\n随便写点东西。\n';
  writeFileSync(tree.page, markerless, 'utf8');

  const result = runTool(tree.tool, ['--write', '--page=docs/page.md'], tree.root);
  assert.equal(result.status, 1, `缺标记应 exit 1，实际 ${result.status}：\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /缺少标记 <!-- BEGIN:MATRIX-TABLE -->/);
  assert.equal(readFileSync(tree.page, 'utf8'), markerless, '缺标记却写盘了');
});
