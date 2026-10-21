// GY-I08 · **八维度适用性规则引擎**的逐维单测（issue #8 scope 的八个检查面）。
//
// scope 原文：检查「禁限用、作物、生育期、地区、制剂、含量剂型、使用场景及**有效来源**」。
// 这八条在域库里对应 `packages/reference/query.mjs` 的 `evaluateApplicability`（1..8 段），
// 本文件把每个维度**单独扰动**一次，断言四件事：
//   1. 该维度的 `blocked` 标记**精确出现且只出现一次**（隔离断言：不能靠别的维度顺带拦住）；
//   2. 该维度的原因文案里说得出是哪条不符（不静默放宽、不笼统失败）；
//   3. 可执行建议与用量卡同时关闭（`executable=false`、`renderable=false`、`dose_count=0`）；
//   4. 维度闭集：119 条场景跑完，`blocked` 里出现的维度名**不得超出**这八个（新增维度必须同时补本文件，
//      否则本断言转红——防止有人悄悄加一条阻断而不写用例）。
//
// 合成夹具：`doseItem()` 是**合成**记录（40 克/公顷 · 苗后茎叶喷雾 · 水稻 · 330100），
// 仅用于验证规则分派，不代表任何真实登记已通过核对。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateApplicability } from '../../packages/reference/query.mjs';
import {
  BLOCK_CODE_LIST,
  evaluateDoseBoundary,
  evaluateExecutableAdvice,
} from '../../packages/reference/index.mjs';
import { scanRiskWording } from '../../packages/reference/risk-wording.mjs';
import { SCENARIOS, doseItem } from './_i08-scenarios.mjs';

/**
 * 八个维度。`blocked` 是域库写进 `evaluateApplicability().blocked` 的维度名，
 * `code` 是它在可执行建议层收敛成的阻断类别码，`reasonHas` 是必须能读出来的原因片段。
 */
const DIMENSIONS = [
  {
    key: 'valid_source',
    label: '有效来源',
    patch: { source: { source_validity: 'expired' } },
    ctx: {},
    code: 'invalid_source',
    reasonHas: '来源不可用',
  },
  {
    key: 'banned_restricted',
    label: '禁限用',
    patch: { verification: { restriction_status: 'banned' } },
    ctx: {},
    code: 'banned',
    reasonHas: '禁用',
  },
  { key: 'crop', label: '作物', patch: {}, ctx: { crop_id: 'crop_wheat' }, code: 'not_applicable', reasonHas: '作物不符' },
  { key: 'growth_stage', label: '生育期', patch: {}, ctx: { growth_stage: '花期' }, code: 'not_applicable', reasonHas: '生育期不符' },
  { key: 'region', label: '地区', patch: {}, ctx: { region_code: '330200' }, code: 'not_applicable', reasonHas: '适用地区不符' },
  { key: 'dosage_form', label: '制剂', patch: {}, ctx: { dosage_form: '悬浮剂' }, code: 'not_applicable', reasonHas: '制剂' },
  { key: 'ingredient_content', label: '含量剂型', patch: {}, ctx: { ingredient_content: '唑草酮 50%' }, code: 'not_applicable', reasonHas: '有效成分/含量' },
  { key: 'use_scene', label: '使用场景', patch: {}, ctx: { use_scene: '旱直播田' }, code: 'not_applicable', reasonHas: '使用场景不符' },
];

const DIMENSION_KEYS = new Set(DIMENSIONS.map((d) => d.key));

test('GY-I08 八维度：每个维度单独不符 → 只有该维度被标记（隔离，不靠别的维度顺带拦住）', () => {
  const baseline = evaluateApplicability(doseItem(), {});
  assert.deepEqual([...baseline.blocked], [], '基准记录在无条件下应适用');
  assert.equal(baseline.applicable, true);

  const problems = [];
  for (const dim of DIMENSIONS) {
    const verdict = evaluateApplicability(doseItem(dim.patch), dim.ctx);
    if (verdict.applicable !== false) problems.push(`${dim.label}：单独不符却仍判 applicable`);
    const blocked = [...verdict.blocked];
    if (blocked.length !== 1) problems.push(`${dim.label}：期望只标记 1 个维度，实际 ${JSON.stringify(blocked)}`);
    if (blocked[0] !== dim.key) problems.push(`${dim.label}：期望维度 ${dim.key}，实际 ${JSON.stringify(blocked)}`);
    const hit = verdict.reasons.some((r) => String(r).includes(dim.reasonHas));
    if (!hit) problems.push(`${dim.label}：原因里读不出「${dim.reasonHas}」（实际 ${JSON.stringify(verdict.reasons)}）`);
  }
  assert.deepEqual(problems, [], `八维度隔离问题：\n${problems.join('\n')}`);
  console.log(`[GY-I08 八维度] 逐维隔离：${DIMENSIONS.map((d) => `${d.label}→${d.key}`).join('、')}（各只标记自身 1 个）`);
});

test('GY-I08 八维度：任一维度不符 → 可执行建议与用量卡同时关闭', () => {
  const problems = [];
  for (const dim of DIMENSIONS) {
    const item = doseItem(dim.patch);
    const advice = evaluateExecutableAdvice(item, dim.ctx);
    const boundary = evaluateDoseBoundary(item, dim.ctx);
    if (advice.executable !== false) problems.push(`${dim.label}：可执行建议未关闭`);
    if (!advice.block_codes.includes(dim.code)) {
      problems.push(`${dim.label}：缺少阻断类别 ${dim.code}（实际 ${advice.block_codes.join(',')}）`);
    }
    if (boundary.renderable !== false) problems.push(`${dim.label}：用量卡仍可渲染`);
    if (boundary.dose_count !== 0) problems.push(`${dim.label}：dose_count=${boundary.dose_count}`);
    if (boundary.dose_card?.dose !== undefined) problems.push(`${dim.label}：被阻断仍带 dose 字段`);
    for (const code of advice.block_codes) {
      if (!BLOCK_CODE_LIST.includes(code)) problems.push(`${dim.label}：阻断类别 ${code} 不在闭集`);
    }
    for (const reason of [...advice.reasons, ...boundary.reasons]) {
      const scan = scanRiskWording(reason);
      if (!scan.ok) problems.push(`${dim.label}：原因含风险承诺词 ${scan.hits.map((h) => h.term).join(',')}`);
    }
  }
  assert.deepEqual(problems, [], `八维度阻断问题：\n${problems.join('\n')}`);
  console.log(`[GY-I08 八维度] 逐维阻断：8/8 维度 executable=false、renderable=false、dose_count=0、阻断码在闭集内`);
});

test('GY-I08 八维度：维度名闭集 —— 场景集出现的 blocked 维度不得超出这八个', () => {
  const seen = new Set();
  for (const scenario of SCENARIOS) {
    for (const dim of evaluateApplicability(scenario.item, scenario.ctx ?? {}).blocked) seen.add(dim);
  }
  const extra = [...seen].filter((dim) => !DIMENSION_KEYS.has(dim));
  assert.deepEqual(extra, [], `出现未登记的阻断维度（新增维度必须同时补测试）：${extra.join(',')}`);
  const uncovered = [...DIMENSION_KEYS].filter((dim) => !seen.has(dim));
  assert.deepEqual(uncovered, [], `这八个维度里有维度从未被场景集触发：${uncovered.join(',')}`);
  console.log(`[GY-I08 八维度] 闭集核对：场景集共触发 ${seen.size} 个维度，与登记表 8 个完全一致（多余 0、未覆盖 0）`);
});

test('GY-I08 八维度：必要条件"未采集"也阻断（未知不当作符合，fail-closed）', () => {
  // 生育期／地区两条是**必要条件**：记录没写就要拒，而不是「没写就算通过」。
  const noStage = doseItem({ growth_stage: undefined });
  const stageVerdict = evaluateApplicability(noStage, { growth_stage: '苗后' });
  assert.deepEqual([...stageVerdict.blocked], ['growth_stage']);
  assert.equal(evaluateExecutableAdvice(noStage, { growth_stage: '苗后' }).executable, false);

  const noRegion = doseItem({ region_codes: undefined });
  const regionVerdict = evaluateApplicability(noRegion, { region_code: '330100' });
  assert.deepEqual([...regionVerdict.blocked], ['region']);
  assert.equal(evaluateExecutableAdvice(noRegion, { region_code: '330100' }).executable, false);

  // 禁限用未知：不得确认为非禁用。
  const unknownRestriction = doseItem({ verification: { restriction_status: 'unknown' } });
  const restrictionVerdict = evaluateApplicability(unknownRestriction, {});
  assert.deepEqual([...restrictionVerdict.blocked], ['banned_restricted']);
  assert.equal(evaluateExecutableAdvice(unknownRestriction, {}).executable, false);

  console.log('[GY-I08 八维度] 必要条件缺采集：生育期/地区各只标记自身维度并阻断；禁限用 unknown 同样阻断');
});

test('GY-I08 八维度：限用状态必须"显式确认"才放行（不得静默放宽）', () => {
  const restricted = doseItem({ verification: { restriction_status: 'restricted' } });
  const withoutConfirm = evaluateApplicability(restricted, {});
  assert.deepEqual([...withoutConfirm.blocked], ['banned_restricted']);
  assert.equal(evaluateExecutableAdvice(restricted, {}).executable, false);

  const withConfirm = evaluateApplicability(restricted, { allow_restricted: true });
  assert.deepEqual([...withConfirm.blocked], [], '上下文显式确认后可放行');
  assert.equal(
    withConfirm.reasons.some((r) => String(r).includes('显式确认')),
    true,
    '放行时也必须留下"已按上下文显式确认"的记录，不能悄悄变成普通记录',
  );
  console.log('[GY-I08 八维度] 限用：无确认→blocked(banned_restricted)；显式 allow_restricted→放行且原因保留确认痕迹');
});
