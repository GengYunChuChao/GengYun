// 注释锚点闸门：位移配对（RELOCATED）与真新增（NEW）的边界控制。
//
// 这组用例把「文档插删行」与「新增注释锚点」分开钉住，每条都在**隔离的临时根目录**里跑：
// 只复制基线里那一页文档 + 它引用的目标文件，再用过滤后的基线开闸门，所以既不会碰到
// 真仓的 1422 条基线，也不会和 `verification-comment-anchor-gate-on-repo.test.mjs`
// 里「本次命中 == 基线 entries」的断言抢同一棵树。
//
// 三条承重用例（派单 R1/R2/R3）：
//   R1 位移不红：真页 `gy-r28-contract-line-anchors-20261021.md` 的 45 条锚点上方插一行散文
//                ⇒ EXIT 0、RELOCATED 45、基线外新增 0；
//   R2 真新增仍红：往同一页加一条指向注释行的锚点 ⇒ EXIT 1，且 FAIL-ENTRY 逐条点名；
//   R3 多重集不串号：两行文档引用同一目标行，删一条只消一条（另一条仍是 SAME，不变成
//                位移、也不被整组吞掉）；再插一行时两条一起变成 RELOCATED。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const UNIT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(UNIT_DIR, '..', '..');
const TOOL = join(ROOT, 'tools', 'verify-verification-comment-anchors.mjs');
const REAL_BASELINE = join(ROOT, 'tools', 'verification-comment-anchor-baseline.json');
const WITNESS_PAGE = 'docs/verification/gy-r28-contract-line-anchors-20261021.md';
const WITNESS_ANCHORS = 45;
const GATE_TIMEOUT_MS = 60_000;

function runGate(root, extra = []) {
  const result = spawnSync(
    process.execPath,
    [TOOL, '--root', root, '--baseline', 'tools/test-baseline.json', ...extra],
    { cwd: root, encoding: 'utf8', timeout: GATE_TIMEOUT_MS },
  );
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.ok(
    result.status === 0 || result.status === 1,
    `闸门异常退出：status=${result.status} signal=${result.signal}\n${out}`,
  );
  return { code: result.status, out };
}

function readNumbers(out) {
  const match = out.match(/VERIFICATION-COMMENT-ANCHOR-GATE: 本次命中 (\d+)、基线 (\d+)、基线外新增 (\d+)、可收紧 (\d+)/);
  assert.ok(match, `没读到 -GATE 读数行：\n${out}`);
  return { hit: Number(match[1]), base: Number(match[2]), added: Number(match[3]), stale: Number(match[4]) };
}

function readRelocated(out) {
  const match = out.match(/VERIFICATION-COMMENT-ANCHOR-RELOCATED: RELOCATED (\d+) 条/);
  assert.ok(match, `没读到 -RELOCATED 读数行：\n${out}`);
  return Number(match[1]);
}

function linesOf(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'gy-comment-anchor-reloc-'));
  t.after(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows 偶尔还握着句柄：临时目录留给系统清理，不因此判用例失败。
    }
  });
  return root;
}

/** 把真页 + 它引用的 19 个目标文件 + 该页的 45 条基线条目复制到临时根目录。 */
function stageWitnessRoot(t) {
  const baseline = JSON.parse(readFileSync(REAL_BASELINE, 'utf8'));
  const entries = baseline.entries.filter((entry) => entry.doc === WITNESS_PAGE);
  assert.equal(entries.length, WITNESS_ANCHORS, `${WITNESS_PAGE} 在基线里应是 ${WITNESS_ANCHORS} 条锚点`);
  const root = temporaryRoot(t);
  const pageCopy = join(root, WITNESS_PAGE);
  mkdirSync(dirname(pageCopy), { recursive: true });
  for (const target of new Set(entries.map((entry) => entry.target))) {
    mkdirSync(dirname(join(root, target)), { recursive: true });
    cpSync(join(ROOT, target), join(root, target));
  }
  mkdirSync(join(root, 'tools'), { recursive: true });
  writeFileSync(
    join(root, 'tools/test-baseline.json'),
    JSON.stringify({ version: 1, scope: baseline.scope, accepted: 'unit-test', why: '位移配对用例', entries }, null, 2),
  );
  writeFileSync(pageCopy, readFileSync(join(ROOT, WITNESS_PAGE), 'utf8'));
  return { root, pageCopy, entries };
}

test('R1 锚点上方插一行散文：45 条配对成 RELOCATED，EXIT 0 且基线外新增 0', (t) => {
  const { root, pageCopy } = stageWitnessRoot(t);

  const before = runGate(root);
  assert.equal(before.code, 0, `插行前就该是绿的：\n${before.out}`);
  assert.deepEqual(readNumbers(before.out), { hit: WITNESS_ANCHORS, base: WITNESS_ANCHORS, added: 0, stale: 0 });
  assert.equal(readRelocated(before.out), 0, '没位移时不该报 RELOCATED');

  const lines = linesOf(readFileSync(pageCopy, 'utf8'));
  assert.ok(lines.length > 200, '目标页短得不像真的');
  lines.splice(9, 0, '本节先交代背景，下面逐条列证据；这一行与任何锚点语义无关。');
  writeFileSync(pageCopy, `${lines.join('\n')}\n`);

  const after = runGate(root);
  assert.equal(after.code, 0, `纯位移不该判红：\n${after.out}`);
  assert.deepEqual(readNumbers(after.out), { hit: WITNESS_ANCHORS, base: WITNESS_ANCHORS, added: 0, stale: 0 });
  assert.equal(readRelocated(after.out), WITNESS_ANCHORS, '45 条应全部配对成 RELOCATED');
  const relocatedLines = after.out.split(/\r?\n/).filter((line) => line.startsWith('RELOCATED '));
  assert.equal(relocatedLines.length, WITNESS_ANCHORS, `RELOCATED 行应逐条打印：\n${after.out}`);
  const moved = relocatedLines[0].match(/（位移：基线文档行 (\d+) → (\d+)）/);
  assert.ok(moved, `RELOCATED 行要写清从哪一行挪到哪一行：\n${relocatedLines[0]}`);
  assert.equal(Number(moved[2]), Number(moved[1]) + 1, '插一行整体下移 1 行');
  assert.ok(!/^NEW /m.test(after.out), `位移不该产生 NEW：\n${after.out}`);
  assert.ok(!/^STALE /m.test(after.out), `位移不该产生 STALE：\n${after.out}`);
});

test('R2 新增一条指向注释行的锚点：仍然 EXIT 1，并逐条点名', (t) => {
  const { root, pageCopy } = stageWitnessRoot(t);
  const target = 'tools/verify-verification-comment-anchors.mjs';
  cpSync(join(ROOT, target), join(root, target));
  const commented = linesOf(readFileSync(join(root, target), 'utf8'))
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => line.trim().startsWith('// ') && !line.includes('VERIFICATION-COMMENT-ANCHOR'));
  assert.ok(commented.length > 0, '探针目标里应有行注释');
  const probe = commented[commented.length - 1];

  const lines = linesOf(readFileSync(pageCopy, 'utf8'));
  lines.push('', `- 新增探针（负控制）：\`${target}:${probe.number}\``);
  writeFileSync(pageCopy, `${lines.join('\n')}\n`);
  const docLine = lines.length;

  const result = runGate(root);
  assert.equal(result.code, 1, `真新增必须判红：\n${result.out}`);
  assert.deepEqual(readNumbers(result.out), { hit: WITNESS_ANCHORS + 1, base: WITNESS_ANCHORS, added: 1, stale: 0 });
  assert.equal(readRelocated(result.out), 0, '新增一条不该被当成位移');
  assert.match(result.out, /^NEW\s+\S+\.md:\d+ -> tools\/verify-verification-comment-anchors\.mjs:\d+/m);
  assert.match(
    result.out,
    new RegExp(`FAIL-ENTRY: ${WITNESS_PAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:${docLine}`
      + ` -> tools/verify-verification-comment-anchors\\.mjs:${probe.number}`),
    `FAIL 文案必须能指名是哪一条：\n${result.out}`,
  );
  assert.match(result.out, /FAIL: 基线外新增 1 条/);
});

test('R3 两行引用同一目标行：删一条只消一条，不吞另一条', (t) => {
  const root = temporaryRoot(t);
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'tools'), { recursive: true });
  writeFileSync(join(root, 'src/multi.mjs'), [
    '// 头注释',
    '',
    'export const A = 1;',
    '',
    '// 目标行：下面两行文档锚点都指向这里',
    '',
  ].join('\n'));
  const docPath = 'docs/verification/reloc-multiplicity.md';
  mkdirSync(dirname(join(root, docPath)), { recursive: true });
  const twoAnchors = ['# 多重集配对负控制', '', '- 甲：`src/multi.mjs:5`', '- 乙：`src/multi.mjs:5`'];
  writeFileSync(join(root, docPath), `${twoAnchors.join('\n')}\n`);

  const written = spawnSync(
    process.execPath,
    [TOOL, '--root', root, '--baseline', 'tools/test-baseline.json', '--write-baseline'],
    { cwd: root, encoding: 'utf8', timeout: GATE_TIMEOUT_MS },
  );
  assert.equal(written.status, 0, `--write-baseline 应成功：\n${written.stdout}\n${written.stderr}`);
  const entries = JSON.parse(readFileSync(join(root, 'tools/test-baseline.json'), 'utf8')).entries;
  assert.equal(entries.length, 2);
  assert.equal(new Set(entries.map((entry) => entry.target)).size, 1, '两条基线条目应指向同一目标文件');
  assert.equal(new Set(entries.map((entry) => entry.from)).size, 1, '两条基线条目应指向同一目标行');

  // 删掉「乙」：甲仍是 SAME，乙变 STALE，不能把甲一起吞掉。
  writeFileSync(join(root, docPath), `${['# 多重集配对负控制', '', '- 甲：`src/multi.mjs:5`'].join('\n')}\n`);
  const dropped = runGate(root);
  assert.equal(dropped.code, 0, `默认口径下 STALE 只告警：\n${dropped.out}`);
  assert.deepEqual(readNumbers(dropped.out), { hit: 1, base: 2, added: 0, stale: 1 });
  assert.equal(readRelocated(dropped.out), 0, '同组只剩一条时不该算位移');
  assert.match(dropped.out, /^WARN docs\/verification\/reloc-multiplicity\.md:3 -> src\/multi\.mjs:5/m);
  assert.match(dropped.out, /^STALE docs\/verification\/reloc-multiplicity\.md:4 -> src\/multi\.mjs:5/m);
  assert.ok(!/^NEW /m.test(dropped.out), `删锚点不该产生 NEW：\n${dropped.out}`);

  const strict = runGate(root, ['--require-no-stale']);
  assert.equal(strict.code, 1, `--require-no-stale 语义不变：\n${strict.out}`);

  // 两条都在、整体下移一行：两条一起变 RELOCATED，不该一配一漏。
  writeFileSync(join(root, docPath), `${['# 多重集配对负控制', '', '一句无关散文。', '', ...twoAnchors.slice(2)].join('\n')}\n`);
  const shifted = runGate(root, ['--require-no-stale']);
  assert.equal(shifted.code, 0, `两条都位移时应全绿：\n${shifted.out}`);
  assert.deepEqual(readNumbers(shifted.out), { hit: 2, base: 2, added: 0, stale: 0 });
  assert.equal(readRelocated(shifted.out), 2, '同一身份的两条应按重数各配一条');
});
