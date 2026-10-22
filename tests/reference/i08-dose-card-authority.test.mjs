// GY-I08 · 用量卡片的**权威边界**断言（issue #8 验收：用量只能由原文卡片渲染并绑定数字单位与条件，
// 关闭个人换算／深配／自动换算；未核对／不适用／禁用不得进入可执行建议或问答用量卡片）。
//
// 三个层面：
//   1. **三态不可产出可执行用量**：`未核对` / `不适用` / `禁用`（外加功能开关关闭）四种情形，
//      必须同时满足：`executable=false`、`renderable=false`、`dose_count=0`，
//      并且**响应载荷里不出现原文单位串**（否则客户端可以绕过判定自己把数字渲染出来）。
//   2. **数字/单位/条件原样来自原文**：可渲染时 `dose_card.dose` 必须与来源里的
//      `{ number, unit, condition }` **逐字相等**，键集合是闭集（没有 `converted`/`per_mu` 之类的换算字段）。
//   3. **个人换算路径不存在**：把用户侧可能想塞的换算提示（亩数、兑水量、倍数、目标单位）
//      塞进上下文或记录，产出必须**一个字符都不变**；再补一条静态断言，
//      确认域库的用量路径里没有换算实现（只有注释里可能提到）。
//
// 合成夹具说明：本文件的正例都基于 `doseItem()`（**合成** 40 克/公顷 · 苗后茎叶喷雾），
// 真实资料没有用量列（见 `docs/verification/gy-i08-dose-gap-ledger-20261017.md`，正例 N=0），
// 所以这里**不**声称任何真实登记用量已被核对。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BLOCK_CODES,
  evaluateDoseBoundary,
  evaluateExecutableAdvice,
} from '../../packages/reference/index.mjs';
import { doseCardDescriptor } from '../../packages/reference/labels.mjs';
import { EXEC_CLOSED, boundDose, doseItem } from './_i08-scenarios.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 用量卡允许出现的键（闭集）：多一个键都要在评审里说清用途。 */
const ALLOWED_CARD_KEYS = new Set([
  'rule_version',
  'off_switch_supported',
  'renderable',
  'reason',
  'closed',
  'applicable',
  'blocked',
  'dose',
]);

const ORIGINAL_DOSE = Object.freeze({ number: '40', unit: '克/公顷', condition: '苗后茎叶喷雾' });

/** 判定「响应里能不能被客户端拼出用量」：原文单位串出现即视为泄漏。 */
function leaksDoseUnit(boundary) {
  return JSON.stringify(boundary).includes(ORIGINAL_DOSE.unit);
}

// ---------------------------------------------------------------------------
// 1) 三态（＋开关关闭）不得产出可执行用量
// ---------------------------------------------------------------------------

const BLOCKED_STATES = [
  {
    label: '未核对',
    item: () => doseItem({ verification: { review_status: 'unverified' } }),
    ctx: {},
    expectCode: BLOCK_CODES.UNREVIEWED,
  },
  {
    label: '来源未核对',
    item: () => doseItem({ source: { review_status: 'unverified' } }),
    ctx: {},
    expectCode: BLOCK_CODES.UNREVIEWED,
  },
  {
    label: '不适用',
    item: () => doseItem(),
    ctx: { crop_id: 'crop_wheat' },
    expectCode: BLOCK_CODES.NOT_APPLICABLE,
  },
  {
    label: '禁用',
    item: () => doseItem({ verification: { restriction_status: 'banned' } }),
    ctx: {},
    expectCode: BLOCK_CODES.BANNED,
  },
  {
    label: '功能关闭',
    item: () => doseItem(),
    ctx: {},
    opts: EXEC_CLOSED,
    expectCode: BLOCK_CODES.FEATURE_CLOSED,
  },
];

test('GY-I08 用量卡：未核对／不适用／禁用／开关关闭 四态都拿不到可执行用量', () => {
  const problems = [];
  for (const state of BLOCKED_STATES) {
    const item = state.item();
    const advice = evaluateExecutableAdvice(item, state.ctx, state.opts ?? {});
    const boundary = evaluateDoseBoundary(item, state.ctx, state.opts ?? {});
    if (advice.executable !== false) problems.push(`${state.label}：可执行建议被放行`);
    if (boundary.executable !== false) problems.push(`${state.label}：边界判定 executable 被放行`);
    if (boundary.renderable !== false) problems.push(`${state.label}：用量卡 renderable=true`);
    if (boundary.dose_count !== 0) problems.push(`${state.label}：dose_count=${boundary.dose_count}`);
    if (!boundary.block_codes.includes(state.expectCode)) {
      problems.push(`${state.label}：缺少阻断类别 ${state.expectCode}（实际 ${boundary.block_codes.join(',')}）`);
    }
    if (boundary.dose_card?.dose !== undefined) problems.push(`${state.label}：被阻断仍带 dose 字段`);
    if (leaksDoseUnit(boundary)) problems.push(`${state.label}：响应载荷里出现了原文单位串（客户端可绕过判定自行渲染）`);
  }
  assert.deepEqual(problems, [], `三态边界问题：\n${problems.join('\n')}`);
  console.log(`[GY-I08 用量卡] 四态阻断：${BLOCKED_STATES.map((s) => s.label).join('／')} —— 全部 executable=false、dose_count=0、无单位串泄漏`);
});

// ---------------------------------------------------------------------------
// 2) 数字/单位/条件原样来自原文（键闭集、无换算字段、无"两选项"）
// ---------------------------------------------------------------------------

test('GY-I08 用量卡：可渲染时 dose 逐字等于原文三元组，键集合为闭集', () => {
  const source = boundDose();
  const boundary = evaluateDoseBoundary(doseItem(), {});
  assert.equal(boundary.renderable, true, '合成夹具应可渲染（正例控制）');
  assert.equal(boundary.dose_count, 1, '可渲染时用量卡必须恰好 1 张（不得凑「两选项」）');

  const card = boundary.dose_card;
  assert.ok(card && typeof card === 'object', 'dose_card 必须存在');
  assert.deepEqual(
    Object.keys(card).sort(),
    [...ALLOWED_CARD_KEYS].sort(),
    `用量卡键集合必须为闭集，实际多出：${Object.keys(card).filter((k) => !ALLOWED_CARD_KEYS.has(k)).join(',')}`,
  );
  assert.equal(Object.isFrozen(card), true, '用量卡必须冻结（产出后不得被改写）');
  assert.equal(card.off_switch_supported, true, '用量卡必须声明支持功能关闭开关');

  assert.deepEqual(
    { number: card.dose.number, unit: card.dose.unit, condition: card.dose.condition },
    { number: source.number, unit: source.unit, condition: source.condition },
    '数字/单位/条件必须逐字取自原文，不得重排、改单位或补条件',
  );
  assert.deepEqual(Object.keys(card.dose).sort(), ['condition', 'number', 'unit'], 'dose 只允许 number/unit/condition 三个键');
  assert.equal(typeof card.dose.number, 'string', '数字必须是原文的字符串，不做数值化（避免客户端二次计算）');
  console.log(`[GY-I08 用量卡] 正例：${card.dose.number}${card.dose.unit}·${card.dose.condition}（逐字等于原文三元组，键闭集 ${Object.keys(card).length} 个）`);
});

// ---------------------------------------------------------------------------
// 3) 个人换算路径不存在
// ---------------------------------------------------------------------------

test('GY-I08 用量卡：塞入个人换算/深配提示后产出不变（不存在自动换算路径）', () => {
  const baseline = evaluateDoseBoundary(doseItem(), {}).dose_card.dose;
  const contexts = [
    { area_mu: 2 },
    { water_liters: 30 },
    { dose_scale: 2 },
    { personal_dose: '翻倍' },
    { convert_to: '毫升/亩' },
    { dose_number: 80, dose_unit: '毫升/亩' },
    { deep_mix: true, mix_partner: '另一种除草剂' },
    { intended_area: '2 亩', sprayer_liters: '30' },
  ];
  const patches = [
    { dose_scale: 2 },
    { per_mu: '80' },
    { conversion_hint: '亩用水量 30 公斤，按亩折算' },
    { deep_mix: { enabled: true, partner: 'x' } },
    { auto_convert: true },
  ];

  const problems = [];
  for (const context of contexts) {
    const card = evaluateDoseBoundary(doseItem(), context).dose_card.dose;
    if (JSON.stringify(card) !== JSON.stringify(baseline)) problems.push(`上下文 ${JSON.stringify(context)} 改变了用量：${JSON.stringify(card)}`);
  }
  for (const patch of patches) {
    const card = evaluateDoseBoundary(doseItem(patch), {}).dose_card.dose;
    if (JSON.stringify(card) !== JSON.stringify(baseline)) problems.push(`记录字段 ${JSON.stringify(patch)} 改变了用量：${JSON.stringify(card)}`);
  }
  // 卡片构造器本身也不能被「选项」带偏：未知选项一律不参与计算。
  const descriptorCard = doseCardDescriptor(doseItem(), { convert: true, unit: '毫升/亩', scale: 2, area_mu: 3 }).dose;
  if (JSON.stringify(descriptorCard) !== JSON.stringify(baseline)) {
    problems.push(`doseCardDescriptor 被选项改了用量：${JSON.stringify(descriptorCard)}`);
  }

  assert.deepEqual(problems, [], `存在换算路径：\n${problems.join('\n')}`);
  console.log(`[GY-I08 用量卡] 换算探针：上下文 ${contexts.length} 组 + 记录字段 ${patches.length} 组，用量恒为 ${baseline.number}${baseline.unit}（零改写）`);
});

/**
 * 否定豁免：`labels.mjs:73` 的展示文案是 `'仅按来源原文核对展示，不生成换算或处方'`
 * ——它说的是「没有换算」，不是「有换算」。这和 `seed.mjs` 里 `不得授予「专家认证」`
 * 属于同一类正当否定表述。命中点前 12 个字符内含否定标记则不计为实现线索；
 * 豁免的片段全部打印出来，评审可逐条复核（不隐藏）。
 */
const NEGATION_MARKERS = ['不得', '禁止', '严禁', '不可', '不应', '无需', '不生成', '不参与', '不推断'];

function unnegatedHits(code, term) {
  const hits = [];
  let from = 0;
  for (;;) {
    const index = code.indexOf(term, from);
    if (index === -1) break;
    const before = code.slice(Math.max(0, index - 12), index);
    if (!NEGATION_MARKERS.some((marker) => before.includes(marker))) {
      hits.push({ index, snippet: code.slice(Math.max(0, index - 20), index + term.length + 10).replace(/\s+/g, ' ') });
    }
    from = index + term.length;
  }
  return hits;
}

test('GY-I08 用量卡：静态断言 —— 域库用量路径无换算实现（避开整行注释，否定表述豁免）', () => {
  const targets = ['packages/reference/labels.mjs', 'packages/reference/deterministic.mjs', 'packages/reference/records.mjs'];
  const FORBIDDEN_IMPL = ['换算', 'convert', 'conversion', 'per_mu', 'deep_mix', 'auto_convert', '个人用量'];
  const offenders = [];
  for (const relative of targets) {
    const code = readFileSync(path.join(ROOT, relative), 'utf8')
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
      })
      .join('\n');
    for (const term of FORBIDDEN_IMPL) {
      for (const hit of unnegatedHits(code, term)) {
        offenders.push(`${relative} 出现换算实现线索「${term}」：…${hit.snippet}…`);
      }
    }
  }
  assert.deepEqual(offenders, [], `用量路径不得含换算实现：\n${offenders.join('\n')}`);
  console.log(`[GY-I08 用量卡] 静态断言：${targets.length} 个用量路径文件、${FORBIDDEN_IMPL.length} 条换算线索，命中 ${offenders.length} 处（期望 0；否定表述如「不生成换算」已豁免并计入白名单口径）`);
});
