/**
 * 读数页闸门（`tools/verify-reading-pages.mjs`）的守卫：六条判据各一条红用例 + 三条「不误伤」。
 *
 * 缺口（为什么需要这个文件）：`docs/verification/**` 的举证页把 failmatrix 读数写成
 * `total=180 same=162 …` 或表格，**没有任何机械校验**——把 `same 180` 改成 `179`，
 * `verify-doc-anchors --symbol=strict`、`--strict`、`npm run test:docs` 全都照样 exit 0。
 * 本文件钉住新闸门本身：每条判据都要有「改一个数字就红」的负控制，否则闸门退化成「扫了个寂寞」；
 * 同时要有「纯日志页 / 只有族分布没有总量的页不许红」的正控制，否则它会变成永远红的噪音源。
 *
 * 判据 ↔ 用例：
 *   ① 总量恒等      → T2
 *   ② same 分解     → T3（sameWithNeither）、T4（sameWithEither）
 *   ③ 对照组不重复  → T5（both）
 *   ④ 族列加总      → T6
 *   ⑤ Δ 列 / 基线冲突 → T7、T8
 *   ⑥ 跨页逐字      → T9（数字不符）、T10（文件读不到）
 *   不误伤          → T11（纯日志页）、T12（只有族读数没有总量）
 *
 * 全部用临时目录夹具 + 直接调 `main()`，⛔ 不 spawn 子进程、不联网、不写仓库内文件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REASONS, main } from '../../tools/verify-reading-pages.mjs';

/** 一页一页写进临时仓：`{ 'x.md': '# …' }` ⇒ `<root>/docs/verification/x.md`。 */
function fixture(pages) {
  const root = mkdtempSync(join(tmpdir(), 'gy-reading-pages-'));
  const dir = join(root, 'docs', 'verification');
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(pages)) writeFileSync(join(dir, name), text);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function run(root, extra = []) {
  const stdout = [];
  const stderr = [];
  const code = main(['--root', root, ...extra], { log: line => stdout.push(line), error: line => stderr.push(line) });
  return { code, stdout, stderr, text: [...stdout, ...stderr].join('\n') };
}

/** 自洽的六键读数页（r82:27 的形状）。 */
const SOUND = [
  '# 真库臂读数',
  '',
  '```',
  'total=180 same=162 sameWithCheck=19 sameWithShape=27 different=5 notRunnable=13',
  '```',
  '',
  '- 一句话结论：**180 条 = same 162 / different 5 / not runnable 13**。',
  '',
].join('\n');

/** 换位对照表：本轮 / 旧基线（带 ref）/ 差。 */
function transposed(rows) {
  return [
    '# 对照表',
    '',
    '| 项 | 本轮 | 旧基线（`docs/verification/base.md:1`，基线 `3561b1fc`） | 差 |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

const BASE = 'total=180 same=162 sameWithCheck=19 sameWithShape=27 different=5 notRunnable=13\n';

test('T1 绿：自洽的读数页 exit 0，并打印识别/跳过页数', () => {
  const { root, cleanup } = fixture({ 'sound.md': SOUND });
  try {
    const result = run(root);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /PASS: 识别 1 页 \/ 跳过 0 页/);
  } finally {
    cleanup();
  }
});

test('T2 ①总量恒等：same 180 → 179 咬住，算式点名 180 ≠ 24+30+126', () => {
  const page = [
    '# 真库臂读数',
    '',
    '```',
    'total=180 same=179 sameWithCheck=24 sameWithShape=30 sameWithNeither=126 different=0 notRunnable=0',
    '```',
    '',
  ].join('\n');
  const { root, cleanup } = fixture({ 'bad.md': page });
  try {
    const result = run(root);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, new RegExp(REASONS.TOTAL_IDENTITY));
    assert.match(result.text, /bad\.md:4 TOTAL_IDENTITY 总量不守恒：total 180 ≠ same 179 \+ different 0 \+ notRunnable 0/);
  } finally {
    cleanup();
  }
});

test('T3 ②same 分解：sameWithNeither 少 1 ⇒ 180 ≠ 24+30+125', () => {
  const page = [
    '# 真库臂读数',
    '',
    '```',
    'total=180 same=180 sameWithCheck=24 sameWithShape=30 sameWithNeither=125 different=0 notRunnable=0',
    '```',
    '',
  ].join('\n');
  const { root, cleanup } = fixture({ 'bad.md': page });
  try {
    const result = run(root);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, new RegExp(REASONS.SAME_BREAKDOWN));
    assert.match(result.text, /same 180 ≠ sameWithCheck 24 \+ sameWithShape 30 \+ sameWithNeither 125/);
  } finally {
    cleanup();
  }
});

test('T4 ②sameWithEither：54 → 53 咬住「≠ check + shape」', () => {
  const page = [
    '# 真库臂读数',
    '',
    '```',
    'total=180 same=180 sameWithCheck=24 sameWithShape=30 sameWithNeither=126 sameWithEither=53 different=0 notRunnable=0',
    '```',
    '',
  ].join('\n');
  const { root, cleanup } = fixture({ 'bad.md': page });
  try {
    const result = run(root);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, new RegExp(REASONS.EITHER_BREAKDOWN));
    assert.match(result.text, /sameWithEither 53 ≠ sameWithCheck 24 \+ sameWithShape 30（合计 54，差 -1）/);
  } finally {
    cleanup();
  }
});

test('T5 ③对照组重复计数：both 1 ≠ 24 + 30 − 54 = 0', () => {
  const page = [
    '# 真库臂读数',
    '',
    '```',
    'total=180 same=180 sameWithCheck=24 sameWithShape=30 sameWithNeither=126 sameWithEither=54 both=1 different=0 notRunnable=0',
    '```',
    '',
  ].join('\n');
  const { root, cleanup } = fixture({ 'bad.md': page });
  try {
    const result = run(root);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, new RegExp(REASONS.BOTH_MISMATCH));
    assert.match(result.text, /both 1 ≠ sameWithCheck 24 \+ sameWithShape 30 − sameWithEither 54 = 0/);
  } finally {
    cleanup();
  }
});

test('T6 ④族加总：C2 的 total 24 → 23，族列之和 ≠ 合计行', () => {
  const page = [
    '# 族分布',
    '',
    '| 族 | total | same | different | not_runnable |',
    '| --- | --- | --- | --- | --- |',
    '| C1 | 37 | 37 | 0 | 0 |',
    '| C2 | 23 | 18 | 0 | 6 |',
    '| 合计 | 61 | 55 | 0 | 6 |',
    '',
  ].join('\n');
  const { root, cleanup } = fixture({ 'bad.md': page });
  try {
    const result = run(root);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, new RegExp(REASONS.FAMILY_SUM));
    assert.match(result.text, /total 列族值之和 60 ≠ 总量 61/);
  } finally {
    cleanup();
  }
});

test('T7 ⑤Δ 列：same 的差写 +19，应为 180 − 162 = 18', () => {
  const page = transposed([
    '| `total` | 180 | 180 | 0 |',
    '| `same` | 180 | 162 | +19 |',
  ]);
  const { root, cleanup } = fixture({ 'base.md': BASE, 'bad.md': page });
  try {
    const result = run(root, ['--verbose']);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, new RegExp(REASONS.DELTA_MISMATCH));
    assert.match(result.text, /差列不自洽：same Δ 19 ≠ 新 180 − 旧 162（= 18，差 1）/);
  } finally {
    cleanup();
  }
});

test('T8 ⑤基线冲突：两张表引同一基线，旧 same 一个说 162 一个说 163', () => {
  const first = transposed(['| `same` | 180 | 162 | +18 |']);
  const second = transposed(['| `same` | 180 | 163 | +17 |']);
  const { root, cleanup } = fixture({ 'base.md': BASE, 'a.md': first, 'b.md': second });
  try {
    const result = run(root, ['--verbose']);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, new RegExp(REASONS.BASELINE_CONFLICT));
  } finally {
    cleanup();
  }
});

test('T9 ⑥跨页逐字：本页引 163，被引行记 162 ⇒ 咬住', () => {
  const page = [
    '# 对照',
    '',
    '- 旧页 `docs/verification/base.md:1` 记的是 180 = same 163 / different 5 / not runnable 13（旧读数）。',
    '',
  ].join('\n');
  const { root, cleanup } = fixture({ 'base.md': BASE, 'bad.md': page });
  try {
    const result = run(root);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, new RegExp(REASONS.CROSS_PAGE_MISMATCH));
    assert.match(result.text, /base\.md:1 same 被引行记 162，本页引用 163/);
  } finally {
    cleanup();
  }
});

test('T10 ⑥跨页读不到 ⇒ FAIL（不是 WARN）', () => {
  const page = [
    '# 对照',
    '',
    '- 旧页 `docs/verification/missing.md:1` 记的是 180 = same 162 / different 5 / not runnable 13（旧读数）。',
    '',
  ].join('\n');
  const { root, cleanup } = fixture({ 'bad.md': page });
  try {
    const result = run(root);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, new RegExp(REASONS.CROSS_PAGE_UNREADABLE));
    assert.match(result.text, /旧基线文件读不到：docs\/verification\/missing\.md/);
  } finally {
    cleanup();
  }
});

test('T11 不误伤：纯日志页没有任何读数 ⇒ 跳过、exit 0', () => {
  const page = [
    '# 施工日志',
    '',
    '- 09:10 起了 PG 簇；09:12 跑完 3 个臂；10:00 收工。',
    '- 结论：本页只是流水，没有读数。',
    '',
  ].join('\n');
  const { root, cleanup } = fixture({ 'log.md': page });
  try {
    const result = run(root);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /PASS: 识别 0 页 \/ 跳过 1 页/);
  } finally {
    cleanup();
  }
});

test('T12 不误伤：只有族三元组、没有总量的页 ⇒ 跳过、exit 0', () => {
  const page = [
    '# 族分布片段',
    '',
    '族三元组口径：total（same/different/nr）：C1 37（37/0/0）、C2 24（18/0/6）。',
    '',
  ].join('\n');
  const { root, cleanup } = fixture({ 'partial.md': page });
  try {
    const result = run(root, ['--verbose']);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /PASS: 识别 0 页 \/ 跳过 1 页/);
    assert.match(result.text, /有 2 条族读数但没有总量，按跳过处理/);
  } finally {
    cleanup();
  }
});
