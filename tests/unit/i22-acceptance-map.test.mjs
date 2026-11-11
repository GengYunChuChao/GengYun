/**
 * #22 的 AC ↔ 用例族映射必须完整。
 *
 * ## 这条守卫补的空白
 *
 * 证据表生成器 `tools/i22-failmatrix-evidence-table.mjs` 的 `FAMILY_ACCEPTANCE` 决定矩阵表里
 * `#22 acceptance（自评）` 那一列显示什么。它是手抄的族级映射，于是有两个洞：
 *
 *   1. **新增族没有登记** ⇒ 那一族整列显示 `—`。`E3`（后台内容写的版本/引用门槛）、`C10`（异步 AI
 *      游客面）、`C11`（异步 AI 归属面）此前就是这样：族在用例表里，映射里没有。
 *   2. **验收条目没有落点** ⇒ `AC07`（失败和重试）与 `AC23`（注销删除与保留）在 `tests/` 下没有任何
 *      文件为它们打标签（AC07 唯一"命中"是 `tests/evaluation/fixtures/synthetic-index.json` 里
 *      `ac07d7e9…` 这种哈希串巧合；AC23 只出现在行号登记表 `tests/unit/doc-anchor-relocations.json`
 *      的说明文字里）。能力证据是有的，但没有任何机器可读的 AC↔用例对应关系——这条测试把
 *      「12 条 AC 是否都有族承担」变成可判定的。
 *
 * 口径与证据表一致：族集合来自 `cases.mjs` + `seams.mjs` 普查（`run.mjs` 把 seam 行也当用例），
 * AC 清单来自 `#22` 的验收列表。映射从工具源码里按字面量读取，不 `import` 工具——那个文件末尾是
 * `process.exit(main(...))`，导入即执行 CLI。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CASES } from '../failmatrix/cases.mjs';
import { SEAM_CASES } from '../failmatrix/seams.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = path.join(ROOT, 'tools', 'i22-failmatrix-evidence-table.mjs');

/** `#22` 的验收条目（issue 正文里的验收清单）。 */
const ISSUE_ACS = Object.freeze([
  'AC01',
  'AC02',
  'AC07',
  'AC08',
  'AC09',
  'AC13',
  'AC16',
  'AC19',
  'AC21',
  'AC22',
  'AC23',
  'AC29',
]);

/** 从工具源码读 `FAMILY_ACCEPTANCE` 字面量：逐行取 `族: '值',`，不 eval 任何代码。 */
function readFamilyAcceptance() {
  const source = readFileSync(TOOL, 'utf8');
  const block = source.match(/const FAMILY_ACCEPTANCE = Object\.freeze\((\{[\s\S]*?\n\})\);/);
  assert.ok(
    block,
    '工具里找不到 `const FAMILY_ACCEPTANCE = Object.freeze({…});`：声明被重构了，本测试的读取逻辑需要同步',
  );
  const map = {};
  for (const line of block[1].split('\n')) {
    const hit = line.match(/^\s*([A-Z][A-Z0-9]*):\s*'([^']*)',?\s*$/);
    if (!hit) continue;
    map[hit[1]] = hit[2];
  }
  return map;
}

/** 每个族在用例表里实际有多少条（seam 行也算用例）。 */
function familyCounts() {
  const counts = {};
  for (const one of [...CASES, ...SEAM_CASES]) counts[one.family] = (counts[one.family] ?? 0) + 1;
  return counts;
}

/** 把 `'AC08/AC09/AC23'`、`'AC21（F08 提示注入只作数据）'` 解析成 AC 列表。 */
function acTokens(value) {
  return [...value.matchAll(/AC\d{2}/g)].map((hit) => hit[0]);
}

test('#22 AC 映射：用例表里的每一族都在 FAMILY_ACCEPTANCE 里登记（新增族不许显示 —）', () => {
  const map = readFamilyAcceptance();
  const counts = familyCounts();
  const missing = Object.keys(counts)
    .filter((family) => map[family] === undefined)
    .sort();
  assert.deepEqual(
    missing,
    [],
    `这些族在用例表里有行、但 FAMILY_ACCEPTANCE 没登记，证据表那一列会显示「—」：${missing.join(', ')}`,
  );
  const stale = Object.keys(map)
    .filter((family) => counts[family] === undefined)
    .sort();
  assert.deepEqual(stale, [], `这些族在 FAMILY_ACCEPTANCE 里有映射、但用例表里没有行：${stale.join(', ')}`);
});

test('#22 AC 映射：#22 的 12 条验收每条都有族承担（AC07／AC23 不许悬空）', () => {
  const map = readFamilyAcceptance();
  const covered = new Set(Object.values(map).flatMap(acTokens));
  const uncovered = ISSUE_ACS.filter((ac) => !covered.has(ac));
  assert.deepEqual(
    uncovered,
    [],
    `这些验收条目没有任何用例族承担（矩阵表里查不到它们）：${uncovered.join(', ')}`,
  );
  // 反向：映射里出现 #22 范围外的 AC 也要拦，避免把别的 issue 的验收混进来。
  const outside = [...covered].filter((ac) => !ISSUE_ACS.includes(ac)).sort();
  assert.deepEqual(outside, [], `这些 AC 不在 #22 的验收清单里：${outside.join(', ')}`);
});

test('#22 AC 映射：每个族的 AC token 形状合法且至少一条', () => {
  const map = readFamilyAcceptance();
  const counts = familyCounts();
  const problems = [];
  for (const [family, value] of Object.entries(map)) {
    const tokens = acTokens(value);
    if (tokens.length === 0) problems.push(`族 ${family} 的映射「${value}」里没有 ACxx token`);
    if (family in counts && tokens.length > 0 && new Set(tokens).size !== tokens.length) {
      problems.push(`族 ${family} 的映射「${value}」有重复 AC token`);
    }
  }
  assert.deepEqual(problems, []);
});
