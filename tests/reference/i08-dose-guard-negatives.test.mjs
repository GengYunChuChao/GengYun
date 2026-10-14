// GY-I08 · 用量卡守卫负例集（issue #8 验收第 2 条与提交证据「原文数字／单位／条件比对」）。
//
// 验收原文：「未核对／不适用／禁用不能进入可执行建议或问答用量卡片」。
// 本文件把 issue 与需求第 6 节点名的**八类阻断**逐条落成负例，并打印原始输出：
//   未核对 / 不适用 / 禁用 / 无来源 / 模拟 / 失效 / 多匹配 / 关键字段冲突。
//
// 每一例都断言三件事：
//   1) 该例**确实被阻断**（给出闭集阻断类别与可读原因，不是静默返回空）；
//   2) 不产出**可执行建议**（`executable === false`）；
//   3) 不产出**用量卡**（`renderable === false`、`dose_count === 0`，`dose` 不出现）。
// 另设一个**正例对照**（合成夹具、完整绑定）证明守卫不是"恒阻断"。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLICABILITY_RULE_VERSION,
  BLOCK_CODES,
  DOSE_REJECT_REASONS,
  evaluateDoseBoundary,
  evaluateRegistrationMatch,
} from '../../packages/reference/index.mjs';
import { miniReference } from './_fixtures.mjs';

function defaultItem() {
  return {
    record_id: 't-base',
    registration_number: 'PD20210001',
    registered_name: '测试剂',
    crop_ids: ['crop_rice'],
    dosage_form: '水分散粒剂',
    ingredients_text: '唑草酮 40%',
    use_scene: '水稻移栽田',
    growth_stage: '苗后',
    region_codes: ['330100'],
    visibility: 'published',
    simulated: false,
    source: { source_kind: 'verified_seed', evidence_kind: 'research', source_validity: 'valid', review_status: 'verified' },
    source_version: 'sv-base@1',
    verification: { usable_as_dose: false, review_status: 'verified', restriction_status: 'unrestricted' },
  };
}

function deepAssign(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete target[key];
      continue;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && target[key] !== null && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      deepAssign(target[key], value);
      continue;
    }
    target[key] = value;
  }
  return target;
}

function item(patch = {}) {
  return deepAssign(defaultItem(), patch);
}

function boundDose() {
  return {
    number: '40',
    unit: '克/公顷',
    condition: '苗后茎叶喷雾',
    source_version: 'sv-base@1',
    record_id: 't-base',
    formulation: {
      registration_number: 'PD20210001',
      registered_name: '测试剂',
      dosage_form: '水分散粒剂',
      ingredients_text: '唑草酮 40%',
    },
    reference: '测试用合成公告第 1 行',
  };
}

/** 完整绑定的原文用量（合成夹具）：用于「只改一个维度」的隔离负例。 */
function doseItem(patch = {}) {
  const base = defaultItem();
  base.verification = { usable_as_dose: true, review_status: 'verified', restriction_status: 'unrestricted', dose: boundDose() };
  base.source.review_status = 'verified';
  return deepAssign(base, patch);
}

/**
 * 负例表：`{ id, category（issue 点名的类别）, name, item, ctx?, opts?, expectCode }`
 * 另可给 `match: { candidates, query, expectState, expectCode }` 走登记匹配路径。
 */
const NEGATIVES = [
  // —— 未核对 ——
  { id: 'NEG-UNREVIEWED-01', category: '未核对', name: '记录级审核状态 unverified', item: doseItem({ verification: { review_status: 'unverified' } }), expectCode: BLOCK_CODES.UNREVIEWED },
  { id: 'NEG-UNREVIEWED-02', category: '未核对', name: '记录级审核状态 rejected', item: doseItem({ verification: { review_status: 'rejected' } }), expectCode: BLOCK_CODES.UNREVIEWED },
  { id: 'NEG-UNREVIEWED-03', category: '未核对', name: '记录级审核状态缺失', item: doseItem({ verification: { review_status: undefined } }), expectCode: BLOCK_CODES.UNREVIEWED },
  { id: 'NEG-UNREVIEWED-04', category: '未核对', name: '来源级审核状态缺失（不取较宽松状态）', item: doseItem({ source: { review_status: undefined } }), expectCode: BLOCK_CODES.UNREVIEWED },
  { id: 'NEG-UNREVIEWED-05', category: '未核对', name: '来源级审核状态 unverified', item: doseItem({ source: { review_status: 'unverified' } }), expectCode: BLOCK_CODES.UNREVIEWED },

  // —— 不适用 ——
  { id: 'NEG-NAPPLICABLE-01', category: '不适用', name: '作物不符', item: doseItem(), ctx: { crop_id: 'crop_wheat' }, expectCode: BLOCK_CODES.NOT_APPLICABLE },
  { id: 'NEG-NAPPLICABLE-02', category: '不适用', name: '地区未标注而上下文要求', item: doseItem({ region_codes: [] }), ctx: { region_code: '330100' }, expectCode: BLOCK_CODES.NOT_APPLICABLE },
  { id: 'NEG-NAPPLICABLE-03', category: '不适用', name: '生育期未采集而上下文要求', item: doseItem({ growth_stage: '' }), ctx: { growth_stage: '苗后' }, expectCode: BLOCK_CODES.NOT_APPLICABLE },
  { id: 'NEG-NAPPLICABLE-04', category: '不适用', name: '剂型不符', item: doseItem(), ctx: { dosage_form: '乳油' }, expectCode: BLOCK_CODES.NOT_APPLICABLE },
  { id: 'NEG-NAPPLICABLE-05', category: '不适用', name: '成分名称子串不得命中（磺草酮 ≠ 硝磺草酮）', item: doseItem({ ingredients_text: '硝磺草酮 40%', verification: { dose: { formulation: { ingredients_text: '硝磺草酮 40%' } } } }), ctx: { ingredient_content: '磺草酮' }, expectCode: BLOCK_CODES.NOT_APPLICABLE },
  { id: 'NEG-NAPPLICABLE-06', category: '不适用', name: '使用场景不符', item: doseItem(), ctx: { use_scene: '茶园' }, expectCode: BLOCK_CODES.NOT_APPLICABLE },

  // —— 禁用 ——
  { id: 'NEG-BANNED-01', category: '禁用', name: '禁用状态（记录级）', item: doseItem({ verification: { restriction_status: 'banned' } }), expectCode: BLOCK_CODES.BANNED },
  { id: 'NEG-BANNED-02', category: '禁用', name: '禁用状态（来源级）', item: doseItem({ source: { restriction_status: 'banned' }, verification: { restriction_status: undefined } }), expectCode: BLOCK_CODES.BANNED },
  { id: 'NEG-BANNED-03', category: '禁用', name: '禁用 + 显式 allow_restricted 也不放行', item: doseItem({ verification: { restriction_status: 'banned' } }), ctx: { allow_restricted: true }, expectCode: BLOCK_CODES.BANNED },
  { id: 'NEG-BANNED-04', category: '禁用', name: '限用（未显式确认）', item: doseItem({ verification: { restriction_status: 'restricted' } }), expectCode: BLOCK_CODES.RESTRICTED },
  { id: 'NEG-BANNED-05', category: '禁用', name: '禁限用状态未采集（未知不等于安全）', item: doseItem({ verification: { restriction_status: undefined } }), expectCode: BLOCK_CODES.RESTRICTION_UNKNOWN },

  // —— 无来源 ——
  { id: 'NEG-NOSOURCE-01', category: '无来源', name: '缺少来源类型（不编造）', item: doseItem({ source: { source_kind: undefined } }), expectCode: BLOCK_CODES.NO_SOURCE },
  { id: 'NEG-NOSOURCE-02', category: '无来源', name: '缺少证据类型（不编造）', item: doseItem({ source: { evidence_kind: undefined } }), expectCode: BLOCK_CODES.NO_SOURCE },
  { id: 'NEG-NOSOURCE-03', category: '无来源', name: '缺少登记证号', item: doseItem({ registration_number: '' }), expectCode: BLOCK_CODES.NO_SOURCE },
  { id: 'NEG-NOSOURCE-04', category: '无来源', name: '来源对象整体缺失', item: doseItem({ source: undefined }), expectCode: BLOCK_CODES.NO_SOURCE },
  { id: 'NEG-NOSOURCE-05', category: '无来源', name: '登记制剂信息不完整（缺成分含量）', item: doseItem({ ingredients_text: '' }), expectCode: BLOCK_CODES.NO_SOURCE },

  // —— 模拟 ——
  { id: 'NEG-SIM-01', category: '模拟', name: 'simulated 标志为真', item: doseItem({ simulated: true }), expectCode: BLOCK_CODES.SIMULATED_SOURCE },
  { id: 'NEG-SIM-02', category: '模拟', name: '来源类型 simulation（实名判定）', item: doseItem({ source: { source_kind: 'simulation' } }), expectCode: BLOCK_CODES.SIMULATED_SOURCE },
  { id: 'NEG-SIM-03', category: '模拟', name: '登记号 SIM- 前缀（实名判定）', item: doseItem({ registration_number: 'SIM-0001' }), expectCode: BLOCK_CODES.SIMULATED_SOURCE },

  // —— 失效 ——
  { id: 'NEG-INVALID-01', category: '失效', name: '来源已过期', item: doseItem({ source: { source_validity: 'expired' } }), expectCode: BLOCK_CODES.INVALID_SOURCE },
  { id: 'NEG-INVALID-02', category: '失效', name: '来源已撤回', item: doseItem({ source: { source_validity: 'withdrawn' } }), expectCode: BLOCK_CODES.INVALID_SOURCE },
  { id: 'NEG-INVALID-03', category: '失效', name: '来源相互冲突', item: doseItem({ source: { source_validity: 'conflicting' } }), expectCode: BLOCK_CODES.INVALID_SOURCE },
  { id: 'NEG-INVALID-04', category: '失效', name: '来源有效期未知', item: doseItem({ source: { source_validity: 'unknown' } }), expectCode: BLOCK_CODES.INVALID_SOURCE },
  { id: 'NEG-INVALID-05', category: '失效', name: '记录已下架', item: doseItem({ visibility: 'hidden' }), expectCode: BLOCK_CODES.INVALID_SOURCE },
  { id: 'NEG-INVALID-06', category: '失效', name: '记录未发布（private）', item: doseItem({ visibility: 'private' }), expectCode: BLOCK_CODES.INVALID_SOURCE },
  { id: 'NEG-INVALID-07', category: '失效', name: '用量未绑定当前来源版本（陈旧用量）', item: doseItem({ verification: { dose: { source_version: 'sv-old@0' } } }), expectCode: BLOCK_CODES.INVALID_SOURCE },

  // —— 多匹配 ——
  {
    id: 'NEG-AMBIG-01',
    category: '多匹配',
    name: '同登记号同制剂身份两条候选（无法唯一确定）',
    match: {
      candidates: [item(), item({ record_id: 'b' })],
      query: { registration_number: 'PD20210001' },
      expectState: 'ambiguous',
      expectCode: BLOCK_CODES.AMBIGUOUS_MATCH,
    },
  },
  {
    id: 'NEG-AMBIG-02',
    category: '多匹配',
    name: '多候选且未给出识别条件（条件不足，不静默选一）',
    match: {
      candidates: [item(), item({ record_id: 'b', registration_number: 'PD20210002' })],
      query: {},
      expectState: 'insufficient',
      expectCode: BLOCK_CODES.MISSING_CONDITION,
    },
  },

  // —— 关键字段冲突 ——
  { id: 'NEG-CONFLICT-01', category: '关键字段冲突', name: '用量绑定到其他制剂（剂型不一致）', item: doseItem({ verification: { dose: { formulation: { dosage_form: '乳油' } } } }), expectCode: BLOCK_CODES.FIELD_CONFLICT },
  { id: 'NEG-CONFLICT-02', category: '关键字段冲突', name: '用量绑定到其他制剂（成分含量不一致）', item: doseItem({ verification: { dose: { formulation: { ingredients_text: '唑草酮 30%' } } } }), expectCode: BLOCK_CODES.FIELD_CONFLICT },
  { id: 'NEG-CONFLICT-03', category: '关键字段冲突', name: '用量绑定到其他登记号', item: doseItem({ verification: { dose: { formulation: { registration_number: 'PD99999999' } } } }), expectCode: BLOCK_CODES.FIELD_CONFLICT },
  { id: 'NEG-CONFLICT-04', category: '关键字段冲突', name: '用量未绑定当前登记记录（record_id 不符）', item: doseItem({ verification: { dose: { record_id: 't-other' } } }), expectCode: BLOCK_CODES.NO_MATCH },
  {
    id: 'NEG-CONFLICT-05',
    category: '关键字段冲突',
    name: '同登记号下不同剂型/含量（不合并不同制剂）',
    match: {
      candidates: [
        item({ registered_name: 'X', dosage_form: '可湿性粉剂', ingredients_text: '莠去津 38%' }),
        item({ record_id: 'b', registered_name: 'X', dosage_form: '悬乳剂', ingredients_text: '莠去津 50%' }),
      ],
      query: { registration_number: 'PD20210001' },
      expectState: 'conflict',
      expectCode: BLOCK_CODES.FIELD_CONFLICT,
    },
  },

  // —— 缺条件（原文条件/引用未采集） ——
  { id: 'NEG-NOCOND-01', category: '无来源', name: '缺原文条件（不补写条件）', item: doseItem({ verification: { dose: { condition: '' } } }), expectCode: BLOCK_CODES.MISSING_CONDITION },
  { id: 'NEG-NOCOND-02', category: '无来源', name: '缺可绑定数字（不补造数字）', item: doseItem({ verification: { dose: { number: '' } } }), expectCode: BLOCK_CODES.NO_DOSE_SOURCE },
  { id: 'NEG-NOCOND-03', category: '无来源', name: '缺可绑定单位（不补造单位）', item: doseItem({ verification: { dose: { unit: '' } } }), expectCode: BLOCK_CODES.NO_DOSE_SOURCE },
  { id: 'NEG-NOCOND-04', category: '无来源', name: '未采集用量字段（usable_as_dose=false）', item: item(), expectCode: BLOCK_CODES.NO_DOSE_SOURCE },

  // —— 功能关闭（附加条件，不能代替资格验证） ——
  { id: 'NEG-CLOSED-01', category: '不适用', name: '功能开关关闭 → 不产出可执行建议与用量卡', item: doseItem(), opts: { executableEnabled: false }, expectCode: BLOCK_CODES.FEATURE_CLOSED },
];

const POSITIVE = { id: 'POS-DOSE-01', name: '非禁限用 + 已核对 + 完整绑定原文用量（合成夹具）', item: doseItem(), ctx: {} };

/**
 * **仅挡用量卡、不挡可执行建议**的负例。
 *
 * 语义区分（必须如实，不得为了让断言好写而混为一谈）：
 *   - 「记录本身不合格」（无来源／未核对／模拟／失效／禁用／不适用）⇒ **可执行建议与用量卡都不产出**；
 *   - 「记录合格，但**原文用量本身**不能绑定」（缺数字/单位/条件/制剂绑定，或陈旧版本、或开关只关用量卡）
 *     ⇒ 可执行建议仍产出（记录可用），**用量卡不产出**。
 *
 * 后者同样满足 issue #8「用量只能由原文卡片渲染并绑定数字／单位／条件」，
 * 只是「资料可用」与「可展示用量」是两件事（与 PR #82 的既有口径一致）。
 */
const CARD_ONLY = new Set([
  'NEG-NOSOURCE-05', // 登记制剂信息不完整 → 卡片不可绑定，但记录来源本身合格
  'NEG-INVALID-07', // 用量未绑定当前来源版本（陈旧用量）→ 记录来源仍有效
  'NEG-CONFLICT-01', // 用量绑定的剂型与当前制剂不一致
  'NEG-CONFLICT-02', // 用量绑定的成分含量与当前制剂不一致
  'NEG-CONFLICT-03', // 用量绑定到其他登记号
  'NEG-CONFLICT-04', // 用量未绑定当前登记记录
  'NEG-NOCOND-01', // 缺原文条件（不补写）
  'NEG-NOCOND-02', // 缺可绑定数字（不补造）
  'NEG-NOCOND-03', // 缺可绑定单位（不补造）
  'NEG-NOCOND-04', // 未采集用量字段
]);

test('GY-I08 用量卡守卫负例：八类阻断均不产出可执行建议与用量卡（原始输出）', () => {
  const lines = [];
  let blocked = 0;
  const byCategory = {};
  let allCodes = [];

  for (const negative of NEGATIVES) {
    if (negative.match) {
      const verdict = evaluateRegistrationMatch(negative.match.candidates, negative.match.query, negative.opts ?? {});
      assert.equal(verdict.state, negative.match.expectState, `${negative.id} state 不符`);
      assert.ok(verdict.block_codes.includes(negative.match.expectCode), `${negative.id} 缺少阻断类别 ${negative.match.expectCode}`);
      assert.equal(verdict.matched, null, `${negative.id} 被阻断却返回了命中记录`);
      assert.ok(verdict.reasons.length > 0 && verdict.reasons.every((r) => r.trim() !== ''), `${negative.id} 必须给出可读原因`);
      assert.equal(verdict.rule_version, APPLICABILITY_RULE_VERSION);
      blocked += 1;
      byCategory[negative.category] = (byCategory[negative.category] ?? 0) + 1;
      allCodes.push(...verdict.block_codes);
      lines.push(`负例 ${negative.id} [${negative.category}] ${negative.name} → 阻断(state=${verdict.state}, code=${verdict.block_codes.join('/')}) | 原因: ${verdict.reasons.join('；')}`);
      continue;
    }

    const boundary = evaluateDoseBoundary(negative.item, negative.ctx ?? {}, negative.opts ?? {});
    const adviceExpected = CARD_ONLY.has(negative.id);
    assert.equal(boundary.executable, adviceExpected, `${negative.id} executable 期望 ${adviceExpected}`);
    assert.equal(boundary.renderable, false, `${negative.id} 不得产出用量卡`);
    assert.equal(boundary.dose_count, 0, `${negative.id} dose_count 必须为 0`);
    assert.equal(boundary.dose_card.dose, undefined, `${negative.id} 不得带出任何用量数字/单位`);
    assert.ok(boundary.block_codes.includes(negative.expectCode), `${negative.id} 缺少阻断类别 ${negative.expectCode}（实际 ${boundary.block_codes.join('/')}）`);
    assert.ok(boundary.reasons.length > 0 && boundary.reasons.every((r) => String(r).trim() !== ''), `${negative.id} 必须给出可读原因（AC02）`);
    assert.equal(boundary.rule_version, APPLICABILITY_RULE_VERSION, `${negative.id} 规则版本须一致`);

    // 跨端一致：小程序镜像不得给出相反结论。
    const mini = miniReference.evaluateDoseBoundary(negative.item, negative.ctx ?? {}, negative.opts ?? {});
    assert.equal(mini.executable, boundary.executable, `${negative.id} 跨端 executable 不一致`);
    assert.equal(mini.renderable, false, `${negative.id} 跨端 renderable 不一致`);
    assert.equal(mini.dose_count, 0, `${negative.id} 跨端 dose_count 不一致`);

    blocked += 1;
    byCategory[negative.category] = (byCategory[negative.category] ?? 0) + 1;
    allCodes.push(...boundary.block_codes);
    const scope = adviceExpected ? '仅阻断用量卡（记录本身可用）' : '阻断可执行建议+用量卡';
    lines.push(`负例 ${negative.id} [${negative.category}] ${negative.name} → ${scope}(code=${boundary.block_codes.join('/')}) | 原因: ${boundary.reasons[0]}`);
  }

  // 正例对照：证明守卫不是恒阻断（否则负例全过也没有意义）。
  const positive = evaluateDoseBoundary(POSITIVE.item, POSITIVE.ctx, {});
  assert.equal(positive.executable, true, '正例应可产出可执行建议');
  assert.equal(positive.renderable, true, '正例应可渲染用量卡');
  assert.equal(positive.dose_count, 1);
  assert.deepEqual(positive.dose_card.dose, { number: '40', unit: '克/公顷', condition: '苗后茎叶喷雾' });
  lines.push(`正例 ${POSITIVE.id} ${POSITIVE.name} → 放行(renderable=true, dose=${positive.dose_card.dose.number}${positive.dose_card.dose.unit}, 条件=${positive.dose_card.dose.condition})`);

  const uniqueCodes = [...new Set(allCodes)];
  const cardOnly = NEGATIVES.filter((n) => !n.match && CARD_ONLY.has(n.id)).length;
  lines.push(`[GY-I08 负例] 负例总数=${NEGATIVES.length} 全部阻断用量卡=${blocked === NEGATIVES.length} 其中阻断可执行建议/登记匹配=${NEGATIVES.length - cardOnly} 仅阻断用量卡=${cardOnly} 正例=1（放行）`);
  lines.push(`[GY-I08 负例] 类别计数: ${Object.entries(byCategory).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  lines.push(`[GY-I08 负例] 覆盖阻断类别: ${uniqueCodes.join(',')}`);
  console.log(lines.join('\n'));

  assert.equal(blocked, NEGATIVES.length, '所有负例都必须被阻断');
  assert.ok(NEGATIVES.length >= 40, `负例应≥40，实际 ${NEGATIVES.length}`);
  // issue 点名的八类必须都有负例。
  const required = ['未核对', '不适用', '禁用', '无来源', '模拟', '失效', '多匹配', '关键字段冲突'];
  for (const category of required) {
    assert.ok((byCategory[category] ?? 0) > 0, `类别「${category}」缺少负例`);
  }
  assert.ok(uniqueCodes.length >= 9, `负面覆盖的阻断类别应≥9，实际 ${uniqueCodes.length}`);
});

test('GY-I08 用量卡守卫负例：拒绝文案逐条来自闭集且不含禁用词', () => {
  const known = new Set(Object.values(DOSE_REJECT_REASONS).map((code) => code));
  assert.ok(known.size >= 13, `拒绝原因闭集应有≥13 项，实际 ${known.size}`);
  const forbidden = ['绝对安全', '零药害', '无药害', '已验证安全', '专家认证', '权威认证'];
  const texts = [];
  for (const negative of NEGATIVES) {
    if (negative.match) continue;
    const boundary = evaluateDoseBoundary(negative.item, negative.ctx ?? {}, negative.opts ?? {});
    texts.push(boundary.dose_card.reason);
  }
  for (const text of texts) {
    assert.ok(typeof text === 'string' && text !== '', '拒绝必须给出可读原因');
    for (const word of forbidden) {
      assert.ok(!text.includes(word), `拒绝文案含禁用词「${word}」：${text}`);
    }
  }
});
