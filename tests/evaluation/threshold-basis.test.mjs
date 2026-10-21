// GY-I20（issue #20）门槛可解释性回归：
//   ① 17 个样本量目标 + 14 条指标门槛，每条都必须有依据（`requirement` 给到需求原文行号 / `provisional` 明标暂定）；
//   ② 「为什么是这个数」的说明文档由代码生成，逐字节绑定——改阈值不改说明即测试红；
//   ③ 改阈值 ⇒ 门禁判定翻转（真红），证明门槛不是摆设。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  METRIC_GATES,
  PROVISIONAL_MARKER,
  REQUIREMENTS_REF,
  SAMPLE_TARGETS,
  THRESHOLD_BASIS_DOC,
  buildGates,
} from '../../packages/evaluation/index.mjs';
import { BEGIN_MARKER, END_MARKER, renderThresholdTables, spliceIntoDoc } from '../../tools/evaluation/render-threshold-tables.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const requirementsLines = readFileSync(`${ROOT}${REQUIREMENTS_REF}`, 'utf8').split(/\r?\n/);
const basisDoc = readFileSync(`${ROOT}${THRESHOLD_BASIS_DOC}`, 'utf8');

/** 取 `docs/implementation-requirements.md:460` 指向的那一行（1 基行号）。 */
const lineOf = (ref) => {
  const m = /^docs\/implementation-requirements\.md:(\d+)$/.exec(ref);
  assert.ok(m, `依据位置必须形如 docs/implementation-requirements.md:<行号>，实际：${ref}`);
  const lineNo = Number(m[1]);
  assert.ok(lineNo >= 1 && lineNo <= requirementsLines.length, `行号越界：${lineNo}`);
  return requirementsLines[lineNo - 1];
};

test('样本数量目标与指标门槛的条数固定（17 桶 / 14 条），改动需同步本测试与文档', () => {
  assert.equal(SAMPLE_TARGETS.length, 17);
  assert.equal(METRIC_GATES.length, 14);
  // 桶与 metric 不重复。
  assert.equal(new Set(SAMPLE_TARGETS.map((t) => t.bucket)).size, 17);
  assert.equal(new Set(METRIC_GATES.map((g) => g.metric)).size, 14);
});

test('每条目标/门槛都带依据：kind 二值、text 非空、ref 可定位', () => {
  for (const entry of [...SAMPLE_TARGETS, ...METRIC_GATES]) {
    const key = entry.bucket ?? entry.metric;
    assert.ok(entry.basis && typeof entry.basis === 'object', `${key} 缺 basis（依据）：不许有"拍脑袋"的门槛`);
    assert.ok(['requirement', 'provisional'].includes(entry.basis.kind), `${key} 的 basis.kind 越界：${entry.basis.kind}`);
    assert.equal(typeof entry.basis.text, 'string');
    assert.ok(entry.basis.text.trim().length >= 8, `${key} 的 basis.text 太短，写不清"为什么是这个数"`);
    lineOf(entry.basis.ref); // ref 必须是可定位的行号
  }
});

test('requirement 依据：需求原文该行确实给定这个数值（不是"有依据"三个字了事）', () => {
  for (const target of SAMPLE_TARGETS) {
    if (target.basis.kind !== 'requirement') continue;
    const line = lineOf(target.basis.ref);
    assert.ok(
      line.includes(String(target.required)),
      `bucket ${target.bucket} 的 required=${target.required} 在依据行里找不到：${target.basis.ref}`,
    );
  }
  for (const gate of METRIC_GATES) {
    if (gate.basis.kind !== 'requirement') continue;
    const line = lineOf(gate.basis.ref);
    // 比例型阈值：需求原文写成百分比（85% / 5% / 15%）；"全部通过"型：target=1。
    const expected = gate.target === 1 ? null : `${Number((gate.target * 100).toFixed(10))}%`;
    assert.ok(
      expected === null ? line.includes('全部') : line.includes(expected),
      `metric ${gate.metric} 的 target=${gate.target} 在依据行里找不到（期望 ${expected ?? '«全部»'}）：${gate.basis.ref}`,
    );
  }
});

test('provisional 依据：必须字面含「暂定，待 #21 用真实读数校准」，且只用于需求原文交给验证集的两条', () => {
  const provisional = [...SAMPLE_TARGETS, ...METRIC_GATES].filter((e) => e.basis.kind === 'provisional');
  assert.deepEqual(
    provisional.map((e) => e.bucket ?? e.metric).sort(),
    ['lowQualityUncertainRate', 'outOfCoverageHighConfidenceRate'],
    '暂定条目应恰为第6.1节"覆盖外与低质量"行交给验证集确定的两条阈值',
  );
  for (const entry of provisional) {
    assert.ok(
      entry.basis.text.includes(PROVISIONAL_MARKER),
      `${entry.metric} 的 basis.text 必须字面包含「${PROVISIONAL_MARKER}」`,
    );
    // 原文确实把取值交给验证集（否则不该标暂定）。
    assert.ok(lineOf(entry.basis.ref).includes('阈值用验证集确定'));
  }
  // 其余 12 条不得被标成暂定（否则"暂定"会退化成免责话术）。
  assert.equal(METRIC_GATES.filter((g) => g.basis.kind === 'requirement').length, 12);
});

test('说明文档与代码逐字节一致（改阈值不改说明 ⇒ 测试红）', () => {
  assert.ok(basisDoc.includes(BEGIN_MARKER), '文档缺少生成块起始标记');
  assert.ok(basisDoc.includes(END_MARKER), '文档缺少生成块结束标记');
  assert.equal(
    spliceIntoDoc(basisDoc),
    basisDoc,
    `文档生成块与 targets.mjs 不一致：请运行 node tools/evaluation/render-threshold-tables.mjs --write（文档：${THRESHOLD_BASIS_DOC}）`,
  );
  // 渲染函数本身可复现：渲染结果逐字出现在文档的生成块里。
  assert.ok(basisDoc.includes(renderThresholdTables()), 'renderThresholdTables() 的输出未逐字出现在文档中');
});

test('文档开头写明"当前没有测量结果"这一诚实前提，并给出未取得清单', () => {
  assert.ok(basisDoc.includes('docs/implementation-requirements.md:439'), '必须引用第439行（授权开发侧制定标准、当前没有测量结果）');
  assert.ok(basisDoc.includes('当前没有测量结果'));
  assert.ok(basisDoc.includes('不是行业实证结论'));
  assert.ok(basisDoc.includes('## 未取得'), '未取得项必须单列，不许混进"已取得"');
  assert.ok(basisDoc.includes(PROVISIONAL_MARKER));
  // 每个 bucket / metric 都必须在文档表格里出现（文档不许漏项）。
  for (const key of [...SAMPLE_TARGETS.map((t) => t.bucket), ...METRIC_GATES.map((g) => g.metric)]) {
    assert.ok(basisDoc.includes(`\`${key}\``), `文档缺少条目：${key}`);
  }
});

test('门禁输出携带依据；改阈值 ⇒ 同一观测值从 pass 翻成 fail（真红）', () => {
  const metrics = { top1: { p: 0.9 } };
  const pass = buildGates('weed_photo', metrics, METRIC_GATES, true).find((g) => g.metric === 'top1');
  assert.equal(pass.status, 'pass');
  assert.equal(pass.target, 0.85);
  assert.ok(pass.basis && pass.basis.kind === 'requirement', '门禁输出必须带 basis，便于报告自证"为什么是这个数"');

  // 真改阈值：同一 90% 观测值，target 抬到 0.95 后必须判 fail。
  const stricter = METRIC_GATES.map((g) => (g.metric === 'top1' ? { ...g, target: 0.95 } : g));
  const fail = buildGates('weed_photo', metrics, stricter, true).find((g) => g.metric === 'top1');
  assert.equal(fail.status, 'fail');
  assert.equal(fail.observed, 0.9);
  assert.equal(fail.target, 0.95);

  // 反向阈值（lte）同理：观测值不变，阈值收紧即翻转。
  const lte = { outOfCoverageHighConfidenceRate: { p: 0.07 } };
  const ok = buildGates('weed_photo', lte, METRIC_GATES, true).find((g) => g.metric === 'outOfCoverageHighConfidenceRate');
  assert.equal(ok.status, 'fail'); // 0.07 > 0.05
  const looser = METRIC_GATES.map((g) => (g.metric === 'outOfCoverageHighConfidenceRate' ? { ...g, target: 0.1 } : g));
  const flipped = buildGates('weed_photo', lte, looser, true).find((g) => g.metric === 'outOfCoverageHighConfidenceRate');
  assert.equal(flipped.status, 'pass');
});

test('claimable=false 时改阈值也不得把门禁写成通过（门槛可解释 ≠ 可主张）', () => {
  const gates = buildGates('weed_photo', { top1: { p: 1 } }, METRIC_GATES, false);
  for (const g of gates) {
    assert.equal(g.status, 'not_evaluated');
    assert.equal(g.claimable, false);
  }
});
