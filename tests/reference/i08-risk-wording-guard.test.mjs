// GY-I08 · 输出侧风险文字守卫的断言（issue #8 验收：风险文字禁止「绝对安全／零药害」承诺）。
//
// 覆盖三件事：
//   1. **术语闭集不漏**：`FORBIDDEN_LABELS`（8 条，全仓通用）与 `OUTPUT_RISK_COMMITMENTS`
//      （输出侧承诺式说法）里的每个词都必须被守卫生效命中；「绝对 安全」这类空白拆分
//      也不得绕过（归一化去空白）。
//   2. **真实输出干净**：把引擎**现在真的会产出**的文案全量过一遍守卫 ——
//      `DISPLAY_LABELS` 全部值、`dose_reject_reason` 全部值、159 条场景与 179 条真实数据
//      的 `reasons`/`block_codes`/标签 —— 命中 0 条。
//   3. **静态断言**：我们自己的输出通道实现文件里**不得**硬编码任何风险承诺词
//      （术语表只允许出现在 `constants.mjs` 与 `risk-wording.mjs` 两个文件）。
//      社区内容的筛查另有 `packages/moderation/rules.mjs` 的 `safety_claim` 规则，
//      那是**别处**的通道（用户发文），不在本断言范围内 —— 两者互补，不是重复实现。
//
// 本文件不生成任何建议文案：只读仓库文件 + 纯函数调用 + 断言。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DISPLAY_LABELS,
  evaluateDoseBoundary,
  evaluateExecutableAdvice,
  loadHerbicideRecords,
  loadZhejiangKnowledge,
} from '../../packages/reference/index.mjs';
import {
  OUTPUT_CHANNELS,
  OUTPUT_RISK_COMMITMENTS,
  RISK_WORDING_POLICY_VERSION,
  RISK_WORDING_TERMS,
  RiskWordingError,
  assertRiskWordingSafe,
  describeRiskWordingPolicy,
  guardOutputText,
  scanRiskWording,
} from '../../packages/reference/risk-wording.mjs';
import { FORBIDDEN_LABELS } from '../../packages/reference/constants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 收集任意结构里的全部字符串（用于把引擎输出"整棵树"过守卫）。 */
function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, out);
  return out;
}

/** 去掉**整行**注释（不动行内代码，避免把字符串里的 `//` 截断而漏检）。 */
function stripWholeLineComments(text) {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
    })
    .join('\n');
}

/**
 * 词在代码里出现的**未被否定**的位置。
 *
 * 静态断言要抓的是「我们**承诺**了绝对安全」，不是「我们**禁止**绝对安全」——
 * `seed.mjs` 的 `must_not` 里就有「不得授予『专家认证』」「不得声称可追溯权威来源」
 * 这类合规禁令。所以命中点前 12 个字符内若出现否定标记，本条不算承诺。
 * 否定标记只取多字词（不用单个「不」），避免「不仅」这类误豁免。
 */
const NEGATION_MARKERS = ['不得', '禁止', '严禁', '不可', '不应', '切勿', '不允许', '不作'];

function unnegatedHitIndex(code, term) {
  let from = 0;
  for (;;) {
    const index = code.indexOf(term, from);
    if (index < 0) return null;
    const before = code.slice(Math.max(0, index - 12), index);
    if (!NEGATION_MARKERS.some((marker) => before.includes(marker))) return index;
    from = index + term.length;
  }
}

// ---------------------------------------------------------------------------
// 1) 术语闭集：每个词都必须被命中（改前：守卫不存在 ⇒ 本文件 import 即失败）
// ---------------------------------------------------------------------------

test('GY-I08 风险文字守卫：术语表覆盖全仓禁用词 + 输出侧承诺词，逐词命中', () => {
  assert.equal(RISK_WORDING_POLICY_VERSION.startsWith('gy-i08-risk/'), true, '策略版本必须带 gy-i08-risk 前缀');
  assert.deepEqual(OUTPUT_CHANNELS.length, 5, '输出通道必须显式列举 5 条');

  const missing = [];
  for (const term of FORBIDDEN_LABELS) {
    if (!RISK_WORDING_TERMS.includes(term)) missing.push(`全仓禁用词未纳入守卫：${term}`);
    const scanned = scanRiskWording(`按标签使用即可，${term}。`);
    if (scanned.ok) missing.push(`未命中禁用词：${term}`);
  }
  for (const term of OUTPUT_RISK_COMMITMENTS) {
    if (!RISK_WORDING_TERMS.includes(term)) missing.push(`输出侧承诺词未纳入守卫：${term}`);
    const scanned = scanRiskWording(`本方案${term}，可放心使用。`);
    if (scanned.ok) missing.push(`未命中承诺词：${term}`);
  }
  assert.deepEqual(missing, [], `术语表问题：\n${missing.join('\n')}`);
  console.log(`[GY-I08 风险文字] 策略版本=${RISK_WORDING_POLICY_VERSION}、术语=${RISK_WORDING_TERMS.length}（继承 ${FORBIDDEN_LABELS.length} + 新增 ${OUTPUT_RISK_COMMITMENTS.length}）、通道=${OUTPUT_CHANNELS.join('/')}`);
});

test('GY-I08 风险文字守卫：空白拆分/全角空格不得绕过，干净文案必须放行', () => {
  const bypass = ['绝对 安全', '绝对　安全', '无 风 险', '零　药害', '百分百 安全'];
  for (const text of bypass) {
    assert.equal(scanRiskWording(text).ok, false, `「${text}」必须被拦下（空白拆分不得绕过）`);
  }

  const clean = [
    '本记录未采集可用作依据的用量字段，不提供用量信息',
    '未采集禁限用状态，无法确认非禁用，不展示用量',
    '当前条件不适用（或必要条件未采集），不展示用量',
    '该药剂为限用状态，需额外确认后方可展示用量',
    '按标签原文用量施用，注意安全间隔期；未见药害不等于不会发生药害',
  ];
  for (const text of clean) {
    assert.equal(scanRiskWording(text).ok, true, `干净文案被误拦：${text}`);
  }
  console.log(`[GY-I08 风险文字] 绕过探针 ${bypass.length} 条全部拦下；干净文案 ${clean.length} 条全部放行`);
});

test('GY-I08 风险文字守卫：命中即抛机器可读错误码，守卫不返回可继续拼接的文案', () => {
  let caught = null;
  try {
    assertRiskWordingSafe('本品绝对安全，零药害。', { channel: 'qa_answer' });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof RiskWordingError, '必须抛 RiskWordingError');
  assert.equal(caught.code, 'RISK_WORDING_FORBIDDEN', '错误码必须机器可读');
  assert.equal(caught.channel, 'qa_answer', '错误必须带输出通道');
  assert.deepEqual([...caught.terms].sort(), ['零药害', '绝对安全'].sort(), '命中词必须逐条给出');

  const guarded = guardOutputText('本品无风险，可放心使用。', { channel: 'executable_advice' });
  assert.equal(guarded.ok, false);
  assert.equal(guarded.text, null, '命中时不得返回可继续拼接的文案');
  assert.equal(guarded.code, 'RISK_WORDING_FORBIDDEN');
  assert.equal(guarded.policy_version, RISK_WORDING_POLICY_VERSION);

  const passed = guardOutputText('按标签原文用量施用，注意安全间隔期。', { channel: 'executable_advice' });
  assert.equal(passed.ok, true);
  assert.equal(passed.text, '按标签原文用量施用，注意安全间隔期。', '未命中时原样返回，不改写文案');
  console.log(`[GY-I08 风险文字] 负例命中 ${caught.terms.join('、')}（code=${caught.code}）；正例放行且文案零改写`);
});

// ---------------------------------------------------------------------------
// 2) 引擎真实输出全量过守卫（命中 0 条）
// ---------------------------------------------------------------------------

test('GY-I08 风险文字守卫：引擎现有输出（标签/原因/159 场景/179 真实数据）命中 0 条', () => {
  const texts = [];
  collectStrings(DISPLAY_LABELS, texts);
  for (const row of [...buildScenarioInputs()]) collectStrings(row, texts);

  const hits = [];
  for (const text of texts) {
    const scanned = scanRiskWording(text);
    if (!scanned.ok) hits.push(`${scanned.hits.map((hit) => hit.term).join('、')} ← ${text}`);
  }
  assert.deepEqual(hits, [], `引擎输出含风险承诺词：\n${hits.join('\n')}`);
  console.log(`[GY-I08 风险文字] 引擎输出文案 ${texts.length} 条全部干净（命中 0）`);
});

function buildScenarioInputs() {
  const out = [];
  for (const item of loadHerbicideRecords().items) {
    out.push(evaluateExecutableAdvice(item, {}), evaluateDoseBoundary(item, {}));
  }
  for (const item of loadZhejiangKnowledge().items) {
    out.push(evaluateExecutableAdvice(item, {}), evaluateDoseBoundary(item, {}));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3) 静态断言：输出通道实现里不得硬编码风险承诺词
// ---------------------------------------------------------------------------

test('GY-I08 风险文字守卫：静态断言 —— 输出通道实现文件不含任何风险承诺词', () => {
  const SKIP = new Set(['constants.mjs', 'risk-wording.mjs']);
  const targets = [];
  for (const name of readdirSync(path.join(ROOT, 'packages/reference'))) {
    if (!name.endsWith('.mjs') || SKIP.has(name)) continue;
    targets.push(path.join('packages/reference', name));
  }
  for (const dir of ['services/api/src/knowledge', 'services/api/src/recognitions', 'services/api/src/conversations']) {
    for (const name of readdirSync(path.join(ROOT, dir))) {
      if (!name.endsWith('.ts') && !name.endsWith('.mjs')) continue;
      targets.push(path.join(dir, name));
    }
  }

  const offenders = [];
  let scannedLines = 0;
  for (const relative of targets) {
    const code = stripWholeLineComments(readFileSync(path.join(ROOT, relative), 'utf8'));
    for (const term of RISK_WORDING_TERMS) {
      const index = unnegatedHitIndex(code, term);
      if (index === null) continue;
      scannedLines += 1;
      offenders.push(`${relative} 硬编码了风险承诺词「${term}」：…${code.slice(Math.max(0, index - 24), index + term.length + 24).replace(/\n/g, '⏎')}…`);
    }
  }

  assert.deepEqual(offenders, [], `输出通道实现不得硬编码承诺词（术语表只允许在 constants.mjs 与 risk-wording.mjs）：\n${offenders.join('\n')}`);
  console.log(`[GY-I08 风险文字] 静态扫描 ${targets.length} 个输出通道实现文件（去整行注释），承诺词硬编码 ${offenders.length} 处（期望 0；命中行计数 ${scannedLines}）`);
});

test('GY-I08 风险文字守卫：策略摘要须自述「不作用于来源原文引用」', () => {
  const policy = describeRiskWordingPolicy();
  assert.equal(policy.policy_version, RISK_WORDING_POLICY_VERSION);
  assert.deepEqual([...policy.channels], [...OUTPUT_CHANNELS]);
  assert.equal(policy.normalization, 'strip-whitespace');
  assert.match(policy.applies_to, /来源原文引用/, '必须写明守卫不作用于来源原文（原文里的「无风险」是来源说的，不是我们承诺的）');
  assert.ok(policy.terms.length === RISK_WORDING_TERMS.length, '摘要术语数必须与生效术语表一致');
  console.log(`[GY-I08 风险文字] 策略摘要口径：${policy.applies_to}`);
});
