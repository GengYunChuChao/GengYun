/**
 * `tools/verify-verification-comment-anchors.mjs` 的守卫：影子闸门的四条边。
 *
 * 缺口（为什么需要这个文件）：`docs/verification/**` 的锚点可以落在注释行上（例如
 * `// PASS 9 · 24h 自衰减…` 这样的块首注释），主工具 `tools/verify-doc-anchors.mjs` 的符号行判据
 * 只覆盖 `docs/architecture/**`，这类锚点因此既不进 `commentAnchors` 也不进 `findings`，
 * 「拿注释当行为证据」可以长期全绿。本文件钉住新加的**独立只读**影子闸门，防止它退化成
 * 「扫了个寂寞」「永远红」或「把既有的 1427 条基线一次判死」（回归基准：去掉 `tools/verify-verification-comment-anchors.mjs:99` 的「整行以 `/*` 开头才开块状态」、换回「行内出现 `/*` 就开状态」，同一棵 `6497031` 树上会虚报 1683 条 / 基线外新增 256 条，多出来的全是对 `packages/contracts/openapi.json` 的误判）。
 *
 * 四条边（与任务要求一一对应）：
 *   ① 基线内命中 ⇒ EXIT 0，逐条 WARN；
 *   ② 基线外新增一条 ⇒ EXIT 1，并点名 `doc:line -> target:NNN`；
 *   ③ 基线里有、实际已不是注释行 ⇒ 不许静默：EXIT 0 但打印 STALE「可收紧基线」；
 *      加 `--require-no-stale` 则 EXIT 1（行为在 T3 里双向钉死）；
 *   ④ 目标文件不存在 / 行号越界 ⇒ 单独分类（`unresolved` / `out-of-range`），不混进注释锚点计数。
 *
 * 全部用临时目录夹具 + 直接调 `main()`，⛔ 不 spawn 子进程、不写仓库内文件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectCommentAnchors,
  main,
  renderBaseline,
} from '../../tools/verify-verification-comment-anchors.mjs';

const BASELINE = 'tools/verification-comment-anchor-baseline.json';
const SAMPLE_DOC = [
  '# 夹具',
  '',
  '评论锚点：src/a.mjs:1',
  '',
  '代码锚点：src/a.mjs:2',
  '',
  '块内锚点：src/a.mjs:4',
  '',
  '空行锚点：src/a.mjs:7',
  '',
  '缺失锚点：src/nope.mjs:1',
  '',
  '越界锚点：src/a.mjs:99',
  '',
  '```text',
  '围栏锚点：src/a.mjs:1',
  '```',
  '',
  '裸锚点：src/a.mjs:2',
  ':8',
].join('\n') + '\n';
const A_JS = [
  '// header comment',
  'export const X = 1;',
  '/*',
  'plain interior text',
  '*/',
  'export const Y = 2;',
  '',
  'export const Z = 3;',
].join('\n') + '\n';

/** 夹具树：`docs/verification/sample.md` + `src/a.mjs`，扫描面只有这一份文档。 */
function makeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gy-comment-anchor-'));
  mkdirSync(join(root, 'docs/verification'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'tools'), { recursive: true });
  writeFileSync(join(root, 'docs/verification/sample.md'), SAMPLE_DOC);
  writeFileSync(join(root, 'src/a.mjs'), A_JS);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function capture(root, extra = []) {
  const stdout = [];
  const stderr = [];
  const code = main(['--root', root, '--baseline', BASELINE, ...extra], {
    log: line => stdout.push(line),
    error: line => stderr.push(line),
  });
  return { code, stdout, stderr, text: [...stdout, ...stderr].join('\n') };
}

function writeBaseline(root) {
  const collected = collectCommentAnchors({ root, scan: 'docs/verification' });
  mkdirSync(join(root, 'tools'), { recursive: true });
  writeFileSync(join(root, BASELINE), renderBaseline({ anchors: collected.anchors }));
}

test('① 基线内命中：EXIT 0，逐条 WARN，不点名 NEW', t => {
  const root = makeFixture(t);

  const first = capture(root, ['--write-baseline']);
  assert.equal(first.code, 0);
  assert.match(first.text, /写入了 2 条/);
  const book = JSON.parse(readFileSync(join(root, BASELINE), 'utf8'));
  assert.equal(book.entries.length, 2);
  assert.deepEqual(Object.keys(book.entries[0]).sort(), ['doc', 'from', 'kind', 'line', 'target', 'to']);
  assert.equal(book.entries.every(entry => entry.doc === 'docs/verification/sample.md'), true);

  const pass = capture(root);
  assert.equal(pass.code, 0, pass.text);
  assert.match(pass.text, /VERIFICATION-COMMENT-ANCHOR-PASS: 基线内 2 条/);
  assert.equal((pass.text.match(/^WARN /gm) ?? []).length, 2);
  assert.doesNotMatch(pass.text, /^NEW /m);
  assert.match(pass.text, /comment=2 code=3 blank=1 out-of-range=1 unresolved=1 fenced=1/);
});

test('② 基线外新增一条：EXIT 1，点名 doc:line -> target:NNN，且不自动改基线', t => {
  const root = makeFixture(t);
  writeBaseline(root);
  appendFileSync(join(root, 'docs/verification/sample.md'), '\n新增锚点：src/a.mjs:1\n');

  const red = capture(root);
  assert.equal(red.code, 1, red.text);
  assert.match(red.text, /^NEW .*docs\/verification\/sample\.md:\d+ -> src\/a\.mjs:1/m);
  assert.match(red.text, /VERIFICATION-COMMENT-ANCHOR-FAIL: 基线外新增 1 条/);
  assert.equal(JSON.parse(readFileSync(join(root, BASELINE), 'utf8')).entries.length, 2);

  const relaxed = capture(root, ['--no-require-no-new']);
  assert.equal(relaxed.code, 0, relaxed.text);
  assert.match(relaxed.text, /^NEW .*docs\/verification\/sample\.md:\d+ -> src\/a\.mjs:1/m);
  assert.match(relaxed.text, /基线外新增 1/);
});

test('③ 已修掉的基线条目：EXIT 0 但打印可收紧基线；--require-no-stale 改判红', t => {
  const root = makeFixture(t);
  writeBaseline(root);
  // 把目标第 1 行从注释改成代码：文档与基线都不动，模拟「锚点已修、基线未收册」。
  writeFileSync(join(root, 'src/a.mjs'), A_JS.replace('// header comment', 'export const HEADER = 0;'));

  const warn = capture(root);
  assert.equal(warn.code, 0, warn.text);
  assert.match(warn.text, /^STALE docs\/verification\/sample\.md:3 -> src\/a\.mjs:1/m);
  assert.match(warn.text, /可收紧基线：目标行已不是注释行（疑似已修）/);
  assert.match(warn.text, /VERIFICATION-COMMENT-ANCHOR-WARN: 基线有 1 条已不再命中/);

  const strict = capture(root, ['--require-no-stale']);
  assert.equal(strict.code, 1, strict.text);
  assert.match(strict.text, /VERIFICATION-COMMENT-ANCHOR-FAIL: 基线有 1 条已不再命中/);
});

test('④ 目标缺失 / 行号越界：单独分类，不混进注释锚点计数', t => {
  const root = makeFixture(t);
  const collected = collectCommentAnchors({ root, scan: 'docs/verification' });
  assert.deepEqual(collected.counts, {
    documents: 1,
    candidates: 9,
    comment: 2,
    code: 3,
    blank: 1,
    outOfRange: 1,
    unresolved: 1,
    ambiguous: 0,
    fenced: 1,
    duplicate: 0,
  });
  assert.equal(collected.anchors.length, 2);
  assert.equal(collected.unresolved.length, 1);
  assert.equal(collected.unresolved[0].reason, 'missing');
  assert.equal(collected.outOfRange.length, 1);
  assert.equal(collected.outOfRange[0].from, 99);

  writeBaseline(root);
  const pass = capture(root);
  assert.equal(pass.code, 0, pass.text);
  assert.match(pass.text, /out-of-range=1 unresolved=1/);
  assert.doesNotMatch(pass.text, /^NEW .*nope/m);
});

test('⑤ 基线缺失：按 0 条处理，所有命中都算新增并 EXIT 1', t => {
  const root = makeFixture(t);
  const red = capture(root);
  assert.equal(red.code, 1, red.text);
  assert.match(red.text, /entries=0（缺失/);
  assert.match(red.text, /VERIFICATION-COMMENT-ANCHOR-FAIL: 基线外新增 2 条/);
});

test('⑥ 字符串里的 /* 不会把 JSON 后续行误判成注释', t => {
  const root = makeFixture(t);
  writeFileSync(join(root, 'src/c.json'), [
    '{',
    '  "description": "audio/*",',
    '  "code": 1',
    '}',
  ].join('\n') + '\n');
  appendFileSync(join(root, 'docs/verification/sample.md'), '\nJSON 锚点：src/c.json:3\n');

  const collected = collectCommentAnchors({ root, scan: 'docs/verification' });
  assert.equal(collected.counts.comment, 2);
  assert.equal(collected.anchors.some(anchor => anchor.target === 'src/c.json'), false);
  assert.equal(collected.counts.code, 4);
});
