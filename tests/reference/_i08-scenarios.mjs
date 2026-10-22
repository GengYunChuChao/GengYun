// GY-I08 · 登记／匹配／限制场景用例**数据**（issue #8 验收第 1 条与第 4 条）。
//
// 要求（docs/initial-issues.md · GY-I08；docs/implementation-requirements.md §6.1「登记匹配与冲突」）：
//   「至少100组登记／匹配／限制场景全部通过，含冲突、失效、未知和模拟」；
//   「无来源、模拟、失效、多匹配和关键字段冲突均阻断，所有消费端使用同一规则版本」。
//
// 为什么数据与断言分成两个文件（R29 S2）：
//   - 场景集要能被**多处**消费：断言（`i08-scenarios-100.test.mjs`）、
//     来源标注核对（`i08-scenarios-provenance.test.mjs`）以及将来的装配层回归；
//   - 更要紧的是**来源标注**：派单要求「每条必须标 `synthetic|registry` 与来源；
//     合成数据不许写成真实登记核对通过」。标注必须能机器核对，否则只是一句自述。
//     因此本文件里每条用例都经 `tagScenarios()` / `tagMatchCases()` 打上：
//       `provenance = { kind, source, fixtures, note }`
//     `kind` 是闭集 `PROVENANCE_KINDS`（`synthetic` | `registry`）；
//     `source` 指向**可核对的构造来源**（合成：本文件里的夹具构造器名；
//     登记：仓内数据文件的记录 id），由 `i08-scenarios-provenance.test.mjs` 逐条回查；
//     `note` 明写「合成夹具，非真实登记核对」，且禁止出现 `REGISTRY_CLAIM_WORDS`。
//
// 本文件**不含** `test()`：只有数据、标注与标注校验的纯函数。
// 本文件也**不含**任何依赖真实用量正例的断言：首批真实资料没有用量列，
// 凡需要真实用量正例的场景一律标为**缺项/未取得**（见 `i08-scenarios-100.test.mjs` 文末）。

import { BLOCK_CODES } from '../../packages/reference/index.mjs';

// ---------------------------------------------------------------------------
// 来源标注：闭集、可核对的来源、禁用自述
// ---------------------------------------------------------------------------

/** 来源类别的**闭集**（派单：`synthetic|registry`，不设第三类，不设默认值）。 */
export const PROVENANCE_KINDS = Object.freeze(['synthetic', 'registry']);

/** 标注 `source` 里允许引用的夹具构造器（必须是本文件真实存在的函数名）。 */
export const FIXTURE_BUILDERS = Object.freeze([
  'defaultItem',
  'item',
  'boundDose',
  'doseItem',
  'candidateItem',
  'conflictPair',
]);

/**
 * 合成用例的 `note` 里**禁止**出现的自述。
 *
 * 这些词一旦出现在合成用例上，等于把「我们自己写的内存对象」冒充成
 * 「登记资料已核对通过」——派单明令禁止，也不符合证据分层（AC14／需求红线）。
 * 注意：本清单只约束**合成用例的自述**，不约束产业原文（原文里的
 * 「无风险」之类属于来源原文，见 `docs/verification/gy-i08-r29s2-*.md` 的说明）。
 */
export const REGISTRY_CLAIM_WORDS = Object.freeze([
  '真实登记核对通过',
  '登记核对通过',
  '真实核对通过',
  '已核对通过',
  '核对通过',
  '权威认证',
  '专家已审',
]);

/** 派单点名的四类必覆盖场景（每类都要断言到**具体阻断类别**，且各至少 3 组）。 */
export const MANDATED_CLASSES = Object.freeze([
  { klass: '冲突', code: BLOCK_CODES.FIELD_CONFLICT, min: 3 },
  { klass: '失效', code: BLOCK_CODES.INVALID_SOURCE, min: 3 },
  { klass: '未知', code: BLOCK_CODES.RESTRICTION_UNKNOWN, min: 3 },
  { klass: '模拟', code: BLOCK_CODES.SIMULATED_SOURCE, min: 3 },
]);

const SYNTHETIC_NOTE = '合成夹具（内存对象），非真实登记核对；期望值由规则引擎裁决，未经登记机关核对';

/** 场景用例的合成来源：**逐例按实际夹具形状**推导，而不是手写一遍（手写会漂移）。 */
function scenarioFixtures(row) {
  return row?.item?.verification?.dose ? ['defaultItem', 'doseItem', 'boundDose'] : ['defaultItem'];
}

function provenanceFor(fixtures, kind) {
  return Object.freeze({
    kind,
    source: `fixture:${fixtures.join(' + ')}`,
    fixtures: Object.freeze([...fixtures]),
    note: SYNTHETIC_NOTE,
  });
}

/** 给 `限制`／`匹配`／`登记` 族场景打来源标注。 */
export function tagScenarios(rows) {
  return rows.map((row) => ({ ...row, provenance: provenanceFor(scenarioFixtures(row), 'synthetic') }));
}

/** 给登记匹配用例打来源标注（候选一律由 `candidateItem()`（= `defaultItem()` 补丁）构造）。 */
export function tagMatchCases(rows) {
  return rows.map((row) => ({ ...row, provenance: provenanceFor(['defaultItem', 'candidateItem'], 'synthetic') }));
}

/** 一条用例声明期望的阻断类别（用于「四类必覆盖」计数）。 */
export function expectedCodes(row) {
  if (Array.isArray(row?.codes)) return [...row.codes];
  const codes = row?.expect?.codes;
  return Array.isArray(codes) ? [...codes] : [];
}

// ---------------------------------------------------------------------------
// 基准记录与补丁工具
// ---------------------------------------------------------------------------

/** 全维度「合格」的基准记录（published + valid + verified + 非禁限用 + 已采集作物/地区/生育期）。 */
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
    source: {
      source_kind: 'verified_seed',
      evidence_kind: 'research',
      source_validity: 'valid',
      review_status: 'verified',
    },
    source_version: 'sv-base@1',
    verification: {
      usable_as_dose: false,
      // 记录级与来源级审核状态均为已核对：这是「全维度合格」基准的前提
      // （未核对本身即阻断可执行建议，见 LIM-027 起的用例）。
      review_status: 'verified',
      restriction_status: 'unrestricted',
    },
  };
}

/**
 * 深合并补丁：**对象递归合并，`undefined` 表示删除该键**（用于「缺字段」负例）。
 * 用真实字段名而非短别名，使每条用例可以逐字复核、不依赖隐式约定。
 */
function deepAssign(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete target[key];
      continue;
    }
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      target[key] !== null &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      deepAssign(target[key], value);
      continue;
    }
    target[key] = value;
  }
  return target;
}

/** 按补丁构造一条记录（不修改基准）。 */
function item(patch = {}) {
  return deepAssign(structuredClone(defaultItem()), patch);
}

/** 完整绑定当前登记制剂与来源版本的原文用量（**合成测试夹具**，非真实资料）。 */
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

/**
 * 「用量可渲染」的基准：已核对（记录级+来源级）、有完整绑定的原文用量。
 * 直接在基准记录上打补丁（而不是先合并补丁对象），否则 `undefined`（删除字段）
 * 会在中间层被吃掉，导致「缺来源审核状态」这类负例失效。
 */
function doseItem(patch = {}) {
  const base = defaultItem();
  base.verification = {
    usable_as_dose: true,
    review_status: 'verified',
    restriction_status: 'unrestricted',
    dose: boundDose(),
  };
  base.source.review_status = 'verified';
  return deepAssign(base, patch);
}

const EXEC_CLOSED = { executableEnabled: false };

// ---------------------------------------------------------------------------
// 用例表（登记／匹配／限制）
// ---------------------------------------------------------------------------

/**
 * 每条：{ id, group, name, item, ctx?, opts?, expect }
 *   expect.exec  —— 期望是否产出可执行建议
 *   expect.dose  —— 期望用量卡是否可渲染（dose_count）
 *   expect.codes —— 期望出现的阻断类别（子集断言）
 *   expect.reasonHas —— 期望某条原因含该片段（可读性核对）
 */
const SCENARIO_ROWS = [
  // ===== 限制（禁限用 / 功能开关 / 风险文案） =====
  { id: 'LIM-001', group: '限制', name: '非禁限用 + 无附加条件 → 可进入可执行建议（但不显示用量：真实资料无用量列）', item: item(), expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_DOSE_SOURCE] } },
  { id: 'LIM-002', group: '限制', name: '禁用 → 阻断', item: item({ verification: { restriction_status: 'banned' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.BANNED] } },
  { id: 'LIM-003', group: '限制', name: '限用（未显式确认）→ 阻断', item: item({ verification: { restriction_status: 'restricted' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.RESTRICTED] } },
  { id: 'LIM-004', group: '限制', name: '限用 + 上下文显式 allow_restricted → 放行（不静默放宽，显式确认）', item: item({ verification: { restriction_status: 'restricted' } }), ctx: { allow_restricted: true }, expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_DOSE_SOURCE] } },
  { id: 'LIM-005', group: '限制', name: '禁限用状态 unknown → 阻断（未知不等于安全）', item: item({ verification: { restriction_status: 'unknown' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.RESTRICTION_UNKNOWN] } },
  { id: 'LIM-006', group: '限制', name: '禁限用字段整体缺失 → 阻断（不默认 unrestricted）', item: item({ verification: { restriction_status: undefined } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.RESTRICTION_UNKNOWN] } },
  { id: 'LIM-007', group: '限制', name: '禁限用为空串 → 阻断（空串不算已采集）', item: item({ verification: { restriction_status: '   ' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.RESTRICTION_UNKNOWN] } },
  { id: 'LIM-008', group: '限制', name: '禁限用非枚举取值 → 阻断（不当作非禁用）', item: item({ verification: { restriction_status: 'safe' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.RESTRICTION_UNKNOWN] } },
  { id: 'LIM-009', group: '限制', name: '禁限用在来源侧给出（source.restriction_status=banned）→ 阻断', item: item({ source: { restriction_status: 'banned' }, verification: { restriction_status: undefined } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.BANNED] } },
  { id: 'LIM-010', group: '限制', name: '禁限用在记录顶层给出（restriction_status=restricted）→ 阻断', item: item({ restriction_status: 'restricted', verification: { restriction_status: undefined } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.RESTRICTED] } },
  { id: 'LIM-011', group: '限制', name: '禁用 + 显式 allow_restricted → 仍阻断（allow 不放开禁用）', item: item({ verification: { restriction_status: 'banned' } }), ctx: { allow_restricted: true }, expect: { exec: false, dose: false, codes: [BLOCK_CODES.BANNED] } },
  { id: 'LIM-012', group: '限制', name: 'unknown + 显式 allow_restricted → 仍阻断', item: item({ verification: { restriction_status: 'unknown' } }), ctx: { allow_restricted: true }, expect: { exec: false, dose: false, codes: [BLOCK_CODES.RESTRICTION_UNKNOWN] } },
  { id: 'LIM-013', group: '限制', name: '禁用 + 完整绑定原文用量 → 用量卡仍不得渲染', item: doseItem({ verification: { restriction_status: 'banned' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.BANNED] } },
  { id: 'LIM-014', group: '限制', name: '限用 + 完整绑定原文用量（未确认）→ 用量卡不得渲染', item: doseItem({ verification: { restriction_status: 'restricted' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.RESTRICTED] } },
  { id: 'LIM-015', group: '限制', name: 'unknown + 完整绑定原文用量 → 用量卡不得渲染', item: doseItem({ verification: { restriction_status: 'unknown' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.RESTRICTION_UNKNOWN] } },
  { id: 'LIM-016', group: '限制', name: '非禁限用 + 完整绑定原文用量 → 用量卡渲染（正例对照，合成夹具）', item: doseItem(), expect: { exec: true, dose: true, codes: [] } },
  { id: 'LIM-017', group: '限制', name: '功能开关关闭 → 不产出可执行建议与用量卡', item: doseItem(), opts: EXEC_CLOSED, expect: { exec: false, dose: false, codes: [BLOCK_CODES.FEATURE_CLOSED] } },
  { id: 'LIM-018', group: '限制', name: '功能开关关闭 + 条件完全不适用 → 关闭与不适用同时如实列出', item: item({ crop_ids: ['crop_wheat'] }), ctx: { crop_id: 'crop_rice' }, opts: EXEC_CLOSED, expect: { exec: false, dose: false, codes: [BLOCK_CODES.NOT_APPLICABLE, BLOCK_CODES.FEATURE_CLOSED] } },
  { id: 'LIM-019', group: '限制', name: '用量卡开关单独关闭 → 无用量卡（可执行建议仍按适用判定）', item: doseItem(), opts: { doseCardEnabled: false }, expect: { exec: true, dose: false, codes: [BLOCK_CODES.FEATURE_CLOSED] } },
  { id: 'LIM-020', group: '限制', name: '环境开关未设置 → 默认开启（开箱保持既有行为）', item: doseItem(), opts: { env: {} }, expect: { exec: true, dose: true, codes: [] } },
  { id: 'LIM-021', group: '限制', name: '环境开关拼写不可识别 → 保守关闭（不静默当作开启）', item: doseItem(), opts: { env: { APP_GY_I08_EXECUTABLE_ENABLED: 'maybe' } }, expect: { exec: false, dose: false, codes: [BLOCK_CODES.FEATURE_CLOSED] } },
  { id: 'LIM-022', group: '限制', name: '环境开关显式关闭（0）→ 关闭', item: doseItem(), opts: { env: { APP_GY_I08_EXECUTABLE_ENABLED: '0' } }, expect: { exec: false, dose: false, codes: [BLOCK_CODES.FEATURE_CLOSED] } },
  { id: 'LIM-023', group: '限制', name: '用量卡环境开关关闭（off）→ 无用量卡', item: doseItem(), opts: { env: { APP_GY_I08_DOSE_CARD_ENABLED: 'off' } }, expect: { exec: true, dose: false, codes: [BLOCK_CODES.FEATURE_CLOSED] } },
  { id: 'LIM-024', group: '限制', name: '禁用（banned）原因可读且不含禁用词', item: item({ verification: { restriction_status: 'banned' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.BANNED], reasonHas: '禁用' } },
  { id: 'LIM-025', group: '限制', name: '限用原因须提示需额外确认', item: item({ verification: { restriction_status: 'restricted' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.RESTRICTED], reasonHas: '限用' } },
  { id: 'LIM-026', group: '限制', name: '未采集禁限用原因须明说未采集（不得表述为已通过）', item: item({ verification: { restriction_status: 'unknown' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.RESTRICTION_UNKNOWN], reasonHas: '未采集' } },
  // 未核对：issue #8 明确「未核对不得进入可执行建议或问答用量卡片」。
  { id: 'LIM-027', group: '限制', name: '记录级审核状态未核对 → 阻断可执行建议', item: item({ verification: { review_status: 'unverified' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.UNREVIEWED] } },
  { id: 'LIM-028', group: '限制', name: '记录级审核状态已驳回 → 阻断可执行建议', item: item({ verification: { review_status: 'rejected' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.UNREVIEWED] } },
  { id: 'LIM-029', group: '限制', name: '记录级审核状态缺失 → 阻断可执行建议', item: item({ verification: { review_status: undefined } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.UNREVIEWED] } },
  { id: 'LIM-030', group: '限制', name: '来源级审核状态缺失 → 阻断可执行建议（不取较宽松一侧）', item: item({ source: { review_status: undefined } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.UNREVIEWED] } },
  { id: 'LIM-031', group: '限制', name: '来源级审核状态未核对 → 阻断可执行建议', item: item({ source: { review_status: 'unverified' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.UNREVIEWED] } },
  { id: 'LIM-032', group: '限制', name: '来源已核对但记录级未核对 → 仍阻断（两侧都要已核对）', item: item({ verification: { review_status: 'unverified' }, source: { review_status: 'verified' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.UNREVIEWED] } },

  // ===== 登记（来源有效性 / 可见性 / 模拟 / 无来源） =====
  { id: 'REG-001', group: '登记', name: '来源有效且已发布 → 可进入可执行建议', item: item(), expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_DOSE_SOURCE] } },
  { id: 'REG-002', group: '登记', name: '来源已过期 → 阻断（失效）', item: item({ source: { source_validity: 'expired' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.INVALID_SOURCE] } },
  { id: 'REG-003', group: '登记', name: '来源已撤回 → 阻断（失效）', item: item({ source: { source_validity: 'withdrawn' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.INVALID_SOURCE] } },
  { id: 'REG-004', group: '登记', name: '来源相互冲突 → 阻断（冲突）', item: item({ source: { source_validity: 'conflicting' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.INVALID_SOURCE] } },
  { id: 'REG-005', group: '登记', name: '来源有效期未知 → 阻断（未知）', item: item({ source: { source_validity: 'unknown' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.INVALID_SOURCE] } },
  { id: 'REG-006', group: '登记', name: '来源有效期字段缺失 → 阻断（未知按 fail-closed）', item: item({ source: { source_validity: undefined } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.INVALID_SOURCE] } },
  { id: 'REG-007', group: '登记', name: '记录已下架（hidden）→ 退出有效集合并阻断', item: item({ visibility: 'hidden' }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.INVALID_SOURCE] } },
  { id: 'REG-008', group: '登记', name: '记录已删除（deleted）→ 阻断', item: item({ visibility: 'deleted' }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.INVALID_SOURCE] } },
  { id: 'REG-009', group: '登记', name: '记录未发布（private）→ 阻断', item: item({ visibility: 'private' }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.INVALID_SOURCE] } },
  { id: 'REG-010', group: '登记', name: '可见性字段缺失 → 阻断', item: item({ visibility: undefined }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.INVALID_SOURCE] } },
  { id: 'REG-011', group: '登记', name: '模拟标志位为真 → 阻断（模拟）', item: item({ simulated: true }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.SIMULATED_SOURCE] } },
  { id: 'REG-012', group: '登记', name: '来源类型为 simulation → 阻断（模拟，实名判定）', item: item({ source: { source_kind: 'simulation' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.SIMULATED_SOURCE] } },
  { id: 'REG-013', group: '登记', name: '登记号为 SIM- 前缀 → 阻断（模拟，实名判定）', item: item({ registration_number: 'SIM-0001' }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.SIMULATED_SOURCE] } },
  { id: 'REG-014', group: '登记', name: '模拟来源但标志位为假 → 仍阻断（不看标志位）', item: item({ simulated: false, source: { source_kind: 'simulation' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.SIMULATED_SOURCE] } },
  { id: 'REG-015', group: '登记', name: '来源类型缺失 → 阻断（无来源，不编造来源类型）', item: item({ source: { source_kind: undefined } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.NO_SOURCE] } },
  { id: 'REG-016', group: '登记', name: '证据类型缺失 → 阻断（无来源，不编造证据类型）', item: item({ source: { evidence_kind: undefined } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.NO_SOURCE] } },
  { id: 'REG-017', group: '登记', name: '来源类型非枚举 → 阻断', item: item({ source: { source_kind: 'unknown_kind' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.NO_SOURCE] } },
  { id: 'REG-018', group: '登记', name: '证据类型非枚举 → 阻断', item: item({ source: { evidence_kind: 'hearsay' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.NO_SOURCE] } },
  { id: 'REG-019', group: '登记', name: '登记证号为空串 → 阻断（无来源）', item: item({ registration_number: '' }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.NO_SOURCE] } },
  { id: 'REG-020', group: '登记', name: '登记证号缺失 → 阻断（无来源）', item: item({ registration_number: undefined }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.NO_SOURCE] } },
  { id: 'REG-021', group: '登记', name: '来源对象整体缺失 → 阻断（无来源）', item: item({ source: undefined }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.NO_SOURCE] } },
  { id: 'REG-022', group: '登记', name: '模拟来源 + 完整绑定原文用量 → 用量卡不得渲染', item: doseItem({ source: { source_kind: 'simulation' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.SIMULATED_SOURCE] } },
  { id: 'REG-023', group: '登记', name: '过期来源 + 完整绑定原文用量 → 用量卡不得渲染', item: doseItem({ source: { source_validity: 'expired' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.INVALID_SOURCE] } },
  { id: 'REG-024', group: '登记', name: '来源失效时「有用量字段」也不放行（来源优先于字段）', item: doseItem({ source: { source_validity: 'withdrawn' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.INVALID_SOURCE] } },

  // ===== 匹配（适用上下文维度） =====
  { id: 'MAT-001', group: '匹配', name: '作物相符 → 不阻断', item: item(), ctx: { crop_id: 'crop_rice' }, expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_DOSE_SOURCE] } },
  { id: 'MAT-002', group: '匹配', name: '作物不符 → 阻断', item: item(), ctx: { crop_id: 'crop_wheat' }, expect: { exec: false, dose: false, codes: [BLOCK_CODES.NOT_APPLICABLE] } },
  { id: 'MAT-003', group: '匹配', name: '记录未覆盖任何作物而上下文要求作物 → 阻断', item: item({ crop_ids: [] }), ctx: { crop_id: 'crop_rice' }, expect: { exec: false, dose: false, codes: [BLOCK_CODES.NOT_APPLICABLE] } },
  { id: 'MAT-004', group: '匹配', name: '生育期相符 → 不阻断', item: item(), ctx: { growth_stage: '苗后' }, expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_DOSE_SOURCE] } },
  { id: 'MAT-005', group: '匹配', name: '生育期不符 → 阻断', item: item(), ctx: { growth_stage: '播种前' }, expect: { exec: false, dose: false, codes: [BLOCK_CODES.NOT_APPLICABLE] } },
  { id: 'MAT-006', group: '匹配', name: '生育期未采集而上下文要求 → 阻断（必要条件未知）', item: item({ growth_stage: '' }), ctx: { growth_stage: '苗后' }, expect: { exec: false, dose: false, codes: [BLOCK_CODES.NOT_APPLICABLE] } },
  { id: 'MAT-007', group: '匹配', name: '生育期字段缺失而上下文要求 → 阻断', item: item({ growth_stage: undefined }), ctx: { growth_stage: '苗后' }, expect: { exec: false, dose: false, codes: [BLOCK_CODES.NOT_APPLICABLE] } },
  { id: 'MAT-008', group: '匹配', name: '生育期未采集但上下文未要求 → 不阻断（不静默收紧）', item: item({ growth_stage: '' }), ctx: {}, expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_DOSE_SOURCE] } },
  { id: 'MAT-009', group: '匹配', name: '地区相符 → 不阻断', item: item(), ctx: { region_code: '330100' }, expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_DOSE_SOURCE] } },
  { id: 'MAT-010', group: '匹配', name: '地区不符 → 阻断', item: item(), ctx: { region_code: '330300' }, expect: { exec: false, dose: false, codes: [BLOCK_CODES.NOT_APPLICABLE] } },
  { id: 'MAT-011', group: '匹配', name: '地区未标注（空数组）而上下文要求 → 阻断（必要条件未知）', item: item({ region_codes: [] }), ctx: { region_code: '330100' }, expect: { exec: false, dose: false, codes: [BLOCK_CODES.NOT_APPLICABLE] } },
  { id: 'MAT-012', group: '匹配', name: '地区字段缺失而上下文要求 → 阻断', item: item({ region_codes: undefined }), ctx: { region_code: '330100' }, expect: { exec: false, dose: false, codes: [BLOCK_CODES.NOT_APPLICABLE] } },
  { id: 'MAT-013', group: '匹配', name: '地区以单项字符串给出且相符 → 不阻断', item: item({ region_codes: undefined, region_code: '330100' }), ctx: { region_code: '330100' }, expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_DOSE_SOURCE] } },
  { id: 'MAT-014', group: '匹配', name: '地区以单项字符串给出但不相符 → 阻断', item: item({ region_codes: undefined, region_code: '330200' }), ctx: { region_code: '330100' }, expect: { exec: false, dose: false, codes: [BLOCK_CODES.NOT_APPLICABLE] } },
  { id: 'MAT-015', group: '匹配', name: '剂型相符 → 不阻断', item: item(), ctx: { dosage_form: '水分散粒剂' }, expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_DOSE_SOURCE] } },
  { id: 'MAT-016', group: '匹配', name: '剂型不符 → 阻断', item: item(), ctx: { dosage_form: '乳油' }, expect: { exec: false, dose: false, codes: [BLOCK_CODES.NOT_APPLICABLE] } },
  { id: 'MAT-017', group: '匹配', name: '剂型未采集而上下文指定剂型 → 阻断', item: item({ dosage_form: '' }), ctx: { dosage_form: '水分散粒剂' }, expect: { exec: false, dose: false, codes: [BLOCK_CODES.NOT_APPLICABLE] } },
  { id: 'MAT-018', group: '匹配', name: '有效成分名称相符 → 不阻断', item: item(), ctx: { ingredient_content: '唑草酮' }, expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_DOSE_SOURCE] } },
  { id: 'MAT-019', group: '匹配', name: '有效成分名称+含量完整组合相符 → 不阻断', item: item(), ctx: { ingredient_content: '唑草酮 40%' }, expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_DOSE_SOURCE] } },
  { id: 'MAT-020', group: '匹配', name: '仅含量相符 → 不阻断', item: item(), ctx: { ingredient_content: '40%' }, expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_DOSE_SOURCE] } },
  { id: 'MAT-021', group: '匹配', name: '成分名称子串不得命中（磺草酮 ≠ 硝磺草酮）→ 阻断', item: item({ ingredients_text: '硝磺草酮 40%' }), ctx: { ingredient_content: '磺草酮' }, expect: { exec: false, dose: false, codes: [BLOCK_CODES.NOT_APPLICABLE] } },
  { id: 'MAT-022', group: '匹配', name: '含量子串不得命中（2% ≠ 22%）→ 阻断', item: item({ ingredients_text: '二甲戊灵 22%' }), ctx: { ingredient_content: '2%' }, expect: { exec: false, dose: false, codes: [BLOCK_CODES.NOT_APPLICABLE] } },
  { id: 'MAT-023', group: '匹配', name: '完整组合名称相符但含量不符 → 阻断', item: item(), ctx: { ingredient_content: '唑草酮 30%' }, expect: { exec: false, dose: false, codes: [BLOCK_CODES.NOT_APPLICABLE] } },
  { id: 'MAT-024', group: '匹配', name: '多成分（顿号）全部等分命中 → 不阻断', item: item({ ingredients_text: '吡氟酰草胺 2%、二甲戊灵 22%' }), ctx: { ingredient_content: '吡氟酰草胺 2%、二甲戊灵 22%' }, expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_DOSE_SOURCE] } },
  { id: 'MAT-025', group: '匹配', name: '多成分只命中一部分 → 阻断（AND 语义）', item: item({ ingredients_text: '吡氟酰草胺 2%、二甲戊灵 22%' }), ctx: { ingredient_content: '吡氟酰草胺 2%、乙草胺 50%' }, expect: { exec: false, dose: false, codes: [BLOCK_CODES.NOT_APPLICABLE] } },
  { id: 'MAT-026', group: '匹配', name: '名称内含半角逗号（2,4-滴异辛酯）不得被误切 → 不阻断', item: item({ ingredients_text: '2,4-滴异辛酯 50%' }), ctx: { ingredient_content: '2,4-滴异辛酯' }, expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_DOSE_SOURCE] } },
  { id: 'MAT-027', group: '匹配', name: '有效成分完全不匹配 → 阻断', item: item(), ctx: { ingredient_content: '草甘膦' }, expect: { exec: false, dose: false, codes: [BLOCK_CODES.NOT_APPLICABLE] } },
  { id: 'MAT-028', group: '匹配', name: '使用场景相符（子串）→ 不阻断', item: item(), ctx: { use_scene: '水稻' }, expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_DOSE_SOURCE] } },
  { id: 'MAT-029', group: '匹配', name: '使用场景不符 → 阻断', item: item(), ctx: { use_scene: '茶园' }, expect: { exec: false, dose: false, codes: [BLOCK_CODES.NOT_APPLICABLE] } },
  { id: 'MAT-030', group: '匹配', name: '使用场景字段缺失而上下文要求 → 阻断', item: item({ use_scene: '' }), ctx: { use_scene: '水稻' }, expect: { exec: false, dose: false, codes: [BLOCK_CODES.NOT_APPLICABLE] } },
  { id: 'MAT-031', group: '匹配', name: '多维度同时不符 → 逐项列出阻断原因', item: item(), ctx: { crop_id: 'crop_wheat', use_scene: '茶园', dosage_form: '乳油' }, expect: { exec: false, dose: false, codes: [BLOCK_CODES.NOT_APPLICABLE] } },
  { id: 'MAT-032', group: '匹配', name: '全部维度同时相符 → 放行', item: item(), ctx: { crop_id: 'crop_rice', region_code: '330100', growth_stage: '苗后', dosage_form: '水分散粒剂', ingredient_content: '唑草酮 40%', use_scene: '水稻' }, expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_DOSE_SOURCE] } },
  { id: 'MAT-033', group: '匹配', name: '空上下文不因未采集维度而误阻断（条件优先，不静默收紧）', item: item({ growth_stage: '', region_codes: [] }), ctx: {}, expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_DOSE_SOURCE] } },

  // ===== 匹配（用量卡：原文数字／单位／条件的绑定与校验） =====
  { id: 'DOSE-001', group: '匹配', name: '完整绑定（数字+单位+条件+制剂+版本+引用+已核对）→ 用量卡渲染', item: doseItem(), expect: { exec: true, dose: true, codes: [] } },
  { id: 'DOSE-002', group: '匹配', name: '未采集用量字段（usable_as_dose=false）→ 不渲染', item: item(), expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_DOSE_SOURCE] } },
  { id: 'DOSE-003', group: '匹配', name: 'usable_as_dose 非 true（字符串 "true"）→ 不渲染', item: doseItem({ verification: { usable_as_dose: 'true' } }), expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_DOSE_SOURCE] } },
  { id: 'DOSE-004', group: '匹配', name: '有绑定但缺数字 → 不渲染（不补造数字）', item: doseItem({ verification: { dose: { number: '' } } }), expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_DOSE_SOURCE] } },
  { id: 'DOSE-005', group: '匹配', name: '有绑定但缺单位 → 不渲染（不补造单位）', item: doseItem({ verification: { dose: { unit: '' } } }), expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_DOSE_SOURCE] } },
  { id: 'DOSE-006', group: '匹配', name: '缺原文条件 → 不渲染（条件必须绑定）', item: doseItem({ verification: { dose: { condition: '' } } }), expect: { exec: true, dose: false, codes: [BLOCK_CODES.MISSING_CONDITION] } },
  { id: 'DOSE-007', group: '匹配', name: '原文条件为 null → 不渲染', item: doseItem({ verification: { dose: { condition: null } } }), expect: { exec: true, dose: false, codes: [BLOCK_CODES.MISSING_CONDITION] } },
  { id: 'DOSE-008', group: '匹配', name: '用量未绑定当前来源版本（陈旧用量）→ 不渲染', item: doseItem({ verification: { dose: { source_version: 'sv-old@0' } } }), expect: { exec: true, dose: false, codes: [BLOCK_CODES.INVALID_SOURCE] } },
  { id: 'DOSE-009', group: '匹配', name: '用量未给出来源版本 → 不渲染', item: doseItem({ verification: { dose: { source_version: undefined } } }), expect: { exec: true, dose: false, codes: [BLOCK_CODES.INVALID_SOURCE] } },
  { id: 'DOSE-010', group: '匹配', name: '用量未绑定当前登记记录（record_id 不符）→ 不渲染', item: doseItem({ verification: { dose: { record_id: 't-other' } } }), expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_MATCH] } },
  { id: 'DOSE-011', group: '匹配', name: '用量未绑定当前登记记录（record_id 缺失）→ 不渲染', item: doseItem({ verification: { dose: { record_id: undefined } } }), expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_MATCH] } },
  { id: 'DOSE-012', group: '匹配', name: '用量绑定到其他制剂（登记号不符）→ 不渲染', item: doseItem({ verification: { dose: { formulation: { registration_number: 'PD99999999' } } } }), expect: { exec: true, dose: false, codes: [BLOCK_CODES.FIELD_CONFLICT] } },
  { id: 'DOSE-013', group: '匹配', name: '用量绑定到其他制剂（剂型不符）→ 不渲染', item: doseItem({ verification: { dose: { formulation: { dosage_form: '乳油' } } } }), expect: { exec: true, dose: false, codes: [BLOCK_CODES.FIELD_CONFLICT] } },
  { id: 'DOSE-014', group: '匹配', name: '用量绑定到其他制剂（成分含量不符）→ 不渲染', item: doseItem({ verification: { dose: { formulation: { ingredients_text: '唑草酮 30%' } } } }), expect: { exec: true, dose: false, codes: [BLOCK_CODES.FIELD_CONFLICT] } },
  { id: 'DOSE-015', group: '匹配', name: '用量绑定到其他制剂（名称不符）→ 不渲染', item: doseItem({ verification: { dose: { formulation: { registered_name: '其他剂' } } } }), expect: { exec: true, dose: false, codes: [BLOCK_CODES.FIELD_CONFLICT] } },
  { id: 'DOSE-016', group: '匹配', name: '用量缺少制剂绑定对象 → 不渲染', item: doseItem({ verification: { dose: { formulation: undefined } } }), expect: { exec: true, dose: false, codes: [BLOCK_CODES.FIELD_CONFLICT] } },
  { id: 'DOSE-017', group: '匹配', name: '登记制剂信息不完整（记录缺成分含量）→ 不渲染', item: doseItem({ ingredients_text: '' }), expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_SOURCE] } },
  { id: 'DOSE-018', group: '匹配', name: '登记制剂信息不完整（记录缺剂型）→ 不渲染', item: doseItem({ dosage_form: '' }), expect: { exec: true, dose: false, codes: [BLOCK_CODES.NO_SOURCE] } },
  { id: 'DOSE-019', group: '匹配', name: '用量缺少原文引用/定位依据 → 不渲染', item: doseItem({ verification: { dose: { reference: '' } } }), expect: { exec: true, dose: false, codes: [BLOCK_CODES.MISSING_CONDITION] } },
  { id: 'DOSE-020', group: '匹配', name: '记录级审核状态未核对 → 不渲染', item: doseItem({ verification: { review_status: 'unverified' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.UNREVIEWED] } },
  { id: 'DOSE-021', group: '匹配', name: '记录级审核状态已驳回 → 不渲染', item: doseItem({ verification: { review_status: 'rejected' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.UNREVIEWED] } },
  { id: 'DOSE-022', group: '匹配', name: '记录级审核状态缺失 → 不渲染', item: doseItem({ verification: { review_status: undefined } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.UNREVIEWED] } },
  { id: 'DOSE-023', group: '匹配', name: '来源级审核状态缺失（不取较宽松状态）→ 不渲染', item: doseItem({ source: { review_status: undefined } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.UNREVIEWED] } },
  { id: 'DOSE-024', group: '匹配', name: '来源级审核状态未核对 → 不渲染', item: doseItem({ source: { review_status: 'unverified' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.UNREVIEWED] } },
  { id: 'DOSE-025', group: '匹配', name: '来源级审核已核对而记录级未核对 → 不渲染（两侧都要核对）', item: doseItem({ verification: { review_status: 'unverified' } }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.UNREVIEWED] } },
  { id: 'DOSE-026', group: '匹配', name: '上下文不适用时，即使用量完整绑定 → 不渲染', item: doseItem(), ctx: { crop_id: 'crop_wheat' }, expect: { exec: false, dose: false, codes: [BLOCK_CODES.NOT_APPLICABLE] } },
  { id: 'DOSE-027', group: '匹配', name: '开关关闭时，用量卡与可执行建议一并关闭', item: doseItem(), opts: EXEC_CLOSED, expect: { exec: false, dose: false, codes: [BLOCK_CODES.FEATURE_CLOSED] } },
  { id: 'DOSE-028', group: '匹配', name: '用量卡渲染时 dose_count=1 且绑定数字/单位/条件原样输出', item: doseItem(), expect: { exec: true, dose: true, codes: [] } },
  { id: 'DOSE-029', group: '匹配', name: '内部条目用量完整但记录未发布 → 不渲染', item: doseItem({ visibility: 'private' }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.INVALID_SOURCE] } },
  { id: 'DOSE-030', group: '匹配', name: '内部条目用量完整但登记号为模拟前缀 → 不渲染', item: doseItem({ registration_number: 'SIM-9' }), expect: { exec: false, dose: false, codes: [BLOCK_CODES.SIMULATED_SOURCE] } },
];

// ---------------------------------------------------------------------------
// 登记匹配表（无来源／模拟／失效／多匹配／关键字段冲突）
// ---------------------------------------------------------------------------

function candidateItem(patch = {}) {
  return item(patch);
}

/**
 * P1 探针形候选对（2026-10-14 监工 review 原形）：
 * 两候选**同登记号** `PD20210001`、名称/剂型相同、**成分含量矛盾**（`40%` / `50%`），
 * 均 published + valid + verified —— 不因来源侧问题提前退出，专测「同登记号资料冲突」判定本身。
 *
 * `opts.bName` / `opts.bDosageForm` 用于把冲突字段换成名称或剂型，验证修复不是只对
 * `ingredients_text` 打补丁。
 */
function conflictPair(opts = {}) {
  return [
    candidateItem({ record_id: 'A', registered_name: '测试剂', dosage_form: '水分散粒剂', ingredients_text: '40%' }),
    candidateItem({
      record_id: 'B',
      registered_name: opts.bName ?? '测试剂',
      dosage_form: opts.bDosageForm ?? '水分散粒剂',
      ingredients_text: '50%',
    }),
  ];
}

/**
 * 每条：{ id, name, candidates, query, opts?, state, codes, matchedReg? }
 *   state  —— 期望的契约 MatchState
 *   codes  —— 期望出现的阻断类别（matched 时为空）
 */
const MATCH_CASE_ROWS = [
  { id: 'MRG-001', name: '候选为空 → unavailable（无来源）', candidates: [], query: {}, state: 'unavailable', codes: [BLOCK_CODES.NO_SOURCE] },
  { id: 'MRG-002', name: '候选缺少来源类型 → unavailable（无来源，不编造）', candidates: [candidateItem({ source: { source_kind: undefined } })], query: {}, state: 'unavailable', codes: [BLOCK_CODES.NO_SOURCE] },
  { id: 'MRG-003', name: '候选缺少证据类型 → unavailable（无来源）', candidates: [candidateItem({ source: { evidence_kind: undefined } })], query: {}, state: 'unavailable', codes: [BLOCK_CODES.NO_SOURCE] },
  { id: 'MRG-004', name: '候选缺少登记证号 → unavailable（无来源）', candidates: [candidateItem({ registration_number: '' })], query: {}, state: 'unavailable', codes: [BLOCK_CODES.NO_SOURCE] },
  { id: 'MRG-005', name: '候选为模拟来源 → unavailable（模拟）', candidates: [candidateItem({ source: { source_kind: 'simulation' } })], query: {}, state: 'unavailable', codes: [BLOCK_CODES.SIMULATED_SOURCE] },
  { id: 'MRG-006', name: '候选登记号为 SIM- 前缀 → unavailable（模拟）', candidates: [candidateItem({ registration_number: 'SIM-0007' })], query: {}, state: 'unavailable', codes: [BLOCK_CODES.SIMULATED_SOURCE] },
  { id: 'MRG-007', name: '候选来源已过期 → unavailable（失效）', candidates: [candidateItem({ source: { source_validity: 'expired' } })], query: {}, state: 'unavailable', codes: [BLOCK_CODES.INVALID_SOURCE] },
  { id: 'MRG-008', name: '候选来源已撤回 → unavailable（失效）', candidates: [candidateItem({ source: { source_validity: 'withdrawn' } })], query: {}, state: 'unavailable', codes: [BLOCK_CODES.INVALID_SOURCE] },
  { id: 'MRG-009', name: '候选来源有效期未知 → unavailable（未知）', candidates: [candidateItem({ source: { source_validity: 'unknown' } })], query: {}, state: 'unavailable', codes: [BLOCK_CODES.INVALID_SOURCE] },
  { id: 'MRG-010', name: '候选已下架 → unavailable（失效）', candidates: [candidateItem({ visibility: 'hidden' })], query: {}, state: 'unavailable', codes: [BLOCK_CODES.INVALID_SOURCE] },
  { id: 'MRG-011', name: '候选混合（模拟+失效+无来源）→ 三类原因同时如实列出', candidates: [candidateItem({ source: { source_kind: 'simulation' } }), candidateItem({ record_id: 'x2', source: { source_validity: 'expired' } }), candidateItem({ record_id: 'x3', source: { source_kind: undefined } })], query: {}, state: 'unavailable', codes: [BLOCK_CODES.NO_SOURCE, BLOCK_CODES.SIMULATED_SOURCE, BLOCK_CODES.INVALID_SOURCE] },
  { id: 'MRG-012', name: '唯一候选唯一命中（无查询条件）→ matched', candidates: [candidateItem()], query: {}, state: 'matched', codes: [] },
  { id: 'MRG-013', name: '按登记号精确命中 → matched', candidates: [candidateItem()], query: { registration_number: 'PD20210001' }, state: 'matched', codes: [] },
  { id: 'MRG-014', name: '登记号大小写/空白归一后命中 → matched', candidates: [candidateItem()], query: { registration_number: ' pd20210001 ' }, state: 'matched', codes: [] },
  { id: 'MRG-015', name: '合法格式但无记录 → no_match', candidates: [candidateItem()], query: { registration_number: 'PD20999999' }, state: 'no_match', codes: [BLOCK_CODES.NO_MATCH] },
  { id: 'MRG-016', name: '错误证号（与候选不同）→ no_match', candidates: [candidateItem()], query: { registration_number: 'PD20161371' }, state: 'no_match', codes: [BLOCK_CODES.NO_MATCH] },
  { id: 'MRG-017', name: '多候选且未给出识别条件 → insufficient（条件不足，不静默选一）', candidates: [candidateItem(), candidateItem({ record_id: 'b', registration_number: 'PD20210002' })], query: {}, state: 'insufficient', codes: [BLOCK_CODES.MISSING_CONDITION] },
  { id: 'MRG-018', name: '同登记号下关键字段冲突（不同剂型/含量）→ conflict（不合并）', candidates: [candidateItem({ registered_name: 'X', dosage_form: '可湿性粉剂', ingredients_text: '莠去津 38%' }), candidateItem({ record_id: 'b', registered_name: 'X', dosage_form: '悬乳剂', ingredients_text: '莠去津 50%' })], query: { registration_number: 'PD20210001' }, state: 'conflict', codes: [BLOCK_CODES.FIELD_CONFLICT] },
  { id: 'MRG-019', name: '同登记号同名同剂型但成分含量冲突 → conflict', candidates: [candidateItem({ ingredients_text: '莠去津 38%' }), candidateItem({ record_id: 'b', ingredients_text: '莠去津 50%' })], query: { registration_number: 'PD20210001' }, state: 'conflict', codes: [BLOCK_CODES.FIELD_CONFLICT] },
  { id: 'MRG-020', name: '同登记号同制剂身份但重复两条 → ambiguous（不静默选一）', candidates: [candidateItem(), candidateItem({ record_id: 'b' })], query: { registration_number: 'PD20210001' }, state: 'ambiguous', codes: [BLOCK_CODES.AMBIGUOUS_MATCH] },
  { id: 'MRG-021', name: '两个不同登记号且给出剂型条件可收敛到唯一 → matched', candidates: [candidateItem(), candidateItem({ record_id: 'b', registration_number: 'PD20210002', dosage_form: '乳油' })], query: { dosage_form: '乳油' }, state: 'matched', codes: [] },
  { id: 'MRG-022', name: '两个不同登记号且条件无法收敛（剂型都不符）→ no_match', candidates: [candidateItem(), candidateItem({ record_id: 'b', registration_number: 'PD20210002', dosage_form: '乳油' })], query: { dosage_form: '悬浮剂' }, state: 'no_match', codes: [BLOCK_CODES.NO_MATCH] },
  { id: 'MRG-023', name: '多个候选且给出登记号收敛到唯一 → matched', candidates: [candidateItem(), candidateItem({ record_id: 'b', registration_number: 'PD20210002' })], query: { registration_number: 'PD20210002' }, state: 'matched', codes: [] },
  { id: 'MRG-024', name: '模拟候选与有效候选混合 → 命中有效候选（模拟只计数不放行）', candidates: [candidateItem({ source: { source_kind: 'simulation' } }), candidateItem({ record_id: 'b', registration_number: 'PD20210002' })], query: { registration_number: 'PD20210002' }, state: 'matched', codes: [] },
  { id: 'MRG-025', name: '失效候选与有效候选混合 → 命中有效候选并如实计数失效', candidates: [candidateItem({ source: { source_validity: 'expired' } }), candidateItem({ record_id: 'b', registration_number: 'PD20210002' })], query: { registration_number: 'PD20210002' }, state: 'matched', codes: [] },
  { id: 'MRG-026', name: '多候选按成分含量收敛到唯一 → matched', candidates: [candidateItem({ ingredients_text: '唑草酮 40%' }), candidateItem({ record_id: 'b', registration_number: 'PD20210002', ingredients_text: '唑草酮 30%' })], query: { ingredients_text: '唑草酮 30%' }, state: 'matched', codes: [] },
  { id: 'MRG-027', name: '多候选按名称收敛到唯一 → matched', candidates: [candidateItem({ registered_name: '甲剂' }), candidateItem({ record_id: 'b', registration_number: 'PD20210002', registered_name: '乙剂' })], query: { registered_name: '乙剂' }, state: 'matched', codes: [] },
  { id: 'MRG-028', name: '给出的条件组合无任何候选匹配 → no_match（不合并相近制剂）', candidates: [candidateItem()], query: { dosage_form: '乳油' }, state: 'no_match', codes: [BLOCK_CODES.NO_MATCH] },
  { id: 'MRG-029', name: '候选数组非数组（畸形输入）→ unavailable（fail-closed）', candidates: null, query: {}, state: 'unavailable', codes: [BLOCK_CODES.NO_SOURCE] },
  { id: 'MRG-030', name: '状态取值必须命中契约 MatchState 闭集', candidates: [candidateItem()], query: {}, state: 'matched', codes: [] },

  // ===== P1 返修（2026-10-14 监工）：**同登记号资料冲突不得被输入收窄消除** =====
  // 缺陷原形：两候选同登记号、成分含量矛盾；只查登记号 ⇒ conflict，
  // 但**加 ingredients_text=40%（选其中一侧）⇒ 修复前返回 matched 并返回 A**（冲突被输入消掉）。
  // 修复：冲突判定在**输入收窄之前**的全候选范围上完成（仅登记号可限定范围，见引擎 JSDoc 步骤 3）。
  { id: 'MRG-031', name: 'P1 探针原形：同登记号含量矛盾 + 只查登记号 ⇒ conflict/field_conflict', candidates: conflictPair(), query: { registration_number: 'PD20210001' }, state: 'conflict', codes: [BLOCK_CODES.FIELD_CONFLICT] },
  { id: 'MRG-032', name: 'P1 探针：同登记号含量矛盾 + ingredients_text=40%（选 A 一侧）⇒ 仍 conflict，不得 matched、不得返回 A', candidates: conflictPair(), query: { registration_number: 'PD20210001', ingredients_text: '40%' }, state: 'conflict', codes: [BLOCK_CODES.FIELD_CONFLICT] },
  { id: 'MRG-033', name: 'P1 探针（另一侧）：+ ingredients_text=50% ⇒ 仍 conflict', candidates: conflictPair(), query: { registration_number: 'PD20210001', ingredients_text: '50%' }, state: 'conflict', codes: [BLOCK_CODES.FIELD_CONFLICT] },
  { id: 'MRG-034', name: '非补丁证明：用矛盾字段之一「剂型」单边收窄 ⇒ 仍 conflict', candidates: conflictPair({ bDosageForm: '悬乳剂' }), query: { registration_number: 'PD20210001', dosage_form: '水分散粒剂' }, state: 'conflict', codes: [BLOCK_CODES.FIELD_CONFLICT] },
  { id: 'MRG-035', name: '非补丁证明：用矛盾字段之一「名称」单边收窄 ⇒ 仍 conflict', candidates: conflictPair({ bName: '乙剂' }), query: { registration_number: 'PD20210001', registered_name: '测试剂' }, state: 'conflict', codes: [BLOCK_CODES.FIELD_CONFLICT] },
  { id: 'MRG-036', name: '无任何识别条件 + 同登记号冲突 ⇒ conflict（比「条件不足」更具体，仍阻断）', candidates: conflictPair(), query: {}, state: 'conflict', codes: [BLOCK_CODES.FIELD_CONFLICT] },
  { id: 'MRG-037', name: '不越界：冲突组存在但显式查不到的登记号 ⇒ no_match（不误判为冲突）', candidates: conflictPair().concat([candidateItem({ record_id: 'c', registration_number: 'PD20210002' })]), query: { registration_number: 'PD20219999' }, state: 'no_match', codes: [BLOCK_CODES.NO_MATCH] },
  { id: 'MRG-038', name: '不越界：显式查询另一个**无冲突**登记号 ⇒ matched（冲突组在范围外，不误伤）', candidates: conflictPair().concat([candidateItem({ record_id: 'c', registration_number: 'PD20210002' })]), query: { registration_number: 'PD20210002' }, state: 'matched', codes: [] },
  { id: 'MRG-039', name: '回归：同登记号**同身份**两条重复 ⇒ ambiguous（冲突预检不得把一致重复判成冲突）', candidates: [candidateItem(), candidateItem({ record_id: 'b' })], query: { registration_number: 'PD20210001' }, state: 'ambiguous', codes: [BLOCK_CODES.AMBIGUOUS_MATCH] },
  { id: 'MRG-040', name: '回归：不同登记号各自单条 + 含量收窄 ⇒ matched（跨登记号不互相冲突）', candidates: [candidateItem({ ingredients_text: '40%' }), candidateItem({ record_id: 'b', registration_number: 'PD20210002', ingredients_text: '30%' })], query: { ingredients_text: '30%' }, state: 'matched', codes: [] },
];

// ---------------------------------------------------------------------------
// 导出（运行器与来源标注核对共用同一份数据）
// ---------------------------------------------------------------------------

export const SCENARIOS = tagScenarios(SCENARIO_ROWS);
export const MATCH_CASES = tagMatchCases(MATCH_CASE_ROWS);

export { defaultItem, item, boundDose, doseItem, candidateItem, conflictPair, EXEC_CLOSED };
