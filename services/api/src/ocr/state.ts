/**
 * GY-I10 标签 OCR · 判定状态与 fail-closed 硬约束（只读消费冻结契约，不新增契约字段）。
 *
 * 契约来源：packages/contracts/openapi.json（1.0.0，已冻结）
 *   MatchState   = matched | no_match | ambiguous | conflict | insufficient | unavailable（闭集 6 值）
 *   LabelFields  = { registration_number|null, name|null, ingredients[] (<=20), dosage_form|null } 四字段全必填
 *   Verification = { match_state, registration|null, conflict_fields[] (<=20), missing_fields[] (<=20),
 *                    dose_cards[] (<=10) } 五字段全必填
 *   Conditions   = { crop_id, region_code } 必填，species_id/growth_stage/planting_method/use_scene 可选
 *   DoseConditions = **6 个字段全部必填**（比 Conditions 严格）
 *   DoseSource   = source_kind ∈ {database, verified_seed}、validity const "valid"、review_status const "verified"
 *
 * 本文件承载「缺项 / 不可用 / 条件不全 ⇒ 一律不得放行」的硬规则
 * （监工 2026-10-11 对 PR #82 的 CHANGES_REQUESTED 口径）：
 *
 *   1. missing_fields 非空 ⇒ match_state **不得**为 matched（落 insufficient）；
 *   2. conflict_fields 非空 ⇒ conflict；多候选无法区分 ⇒ ambiguous；
 *   3. 登记库 / 提供者不可用 ⇒ **unavailable**（**不得**用 no_match 掩盖不可用）；
 *   4. conditions 缺失 / 不全、适用判定为否、来源过期或模拟 ⇒ dose_cards 必须为 []，
 *      **不得凭空补造剂量**；用量原文必须绑定「登记制剂 + 完整 6 字段条件」。
 *
 * 「只记原因、不改状态」在本模块是被禁止的写法；判定与原因在同一次纯函数调用里一起产生。
 *
 * 用量卡的生产口径（**不是**本模块的判定规则，而是装配层的硬约束）：
 * GY-I07 验收第 3 条明令「不授 AI／用户经验专家认证标签，**不对模拟记录显示真实用量**」，
 * 因此 `ocr/reference.ts` 的替身（stub/preset_demo）与未接线（real）用量端口**都恒返回空**，
 * 生产路径的 `dose_cards` 恒为 `[]`。本模块的 gate **通过面**只由测试注入契约合法的
 * 可信来源来证明（见 tests/unit/ocr-*.test.mjs），**绝不**让替身来源扮演「已核对有效」来源。
 */

/** packages/contracts/openapi.json -> components.schemas.MatchState.enum（逐项一致，不得扩展）。 */
export const MATCH_STATES = [
  'matched',
  'no_match',
  'ambiguous',
  'conflict',
  'insufficient',
  'unavailable',
] as const;
export type MatchState = (typeof MATCH_STATES)[number];

/** LabelFields.ingredients.maxItems。 */
export const MAX_INGREDIENTS = 20;
/** Verification.conflict_fields.maxItems。 */
export const MAX_CONFLICT_FIELDS = 20;
/** Verification.missing_fields.maxItems。 */
export const MAX_MISSING_FIELDS = 20;
/** Verification.dose_cards.maxItems。 */
export const MAX_DOSE_CARDS = 10;
/** LabelFields 各文本字段 maxLength。 */
export const MAX_LABEL_TEXT_LENGTH = 80;
/** DoseCard.original_text / method_text / precautions_text maxLength。 */
export const MAX_DOSE_TEXT_LENGTH = 4000;
/** DoseCard.unit_text maxLength。 */
export const MAX_DOSE_UNIT_LENGTH = 80;
/** DoseCard.locator maxLength。 */
export const MAX_LOCATOR_LENGTH = 200;
/** DoseCard.content_hash 契约 pattern。 */
export const DOSE_CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;
/** Conditions.region_code 契约 pattern（浙江 33 开头 6 位）。 */
export const REGION_CODE_PATTERN = /^33[0-9]{4}$/;

/** 契约 Ingredient。 */
export interface Ingredient {
  name: string;
  content_text: string;
  unit_text: string;
}

/** 契约 LabelFields（四字段全必填，数组可为空但不缺失）。 */
export interface LabelFields {
  registration_number: string | null;
  name: string | null;
  ingredients: Ingredient[];
  dosage_form: string | null;
}

/** 契约 Conditions（crop_id / region_code 必填，其余可选）。 */
export interface Conditions {
  crop_id: string;
  region_code: string;
  species_id?: string;
  growth_stage?: string;
  planting_method?: string;
  use_scene?: string;
}

/** 契约 DoseConditions（**六字段全部必填**）。 */
export interface DoseConditions {
  crop_id: string;
  region_code: string;
  species_id: string;
  growth_stage: string;
  planting_method: string;
  use_scene: string;
}

/**
 * 实现层「核对必要条件」（**不是契约字段**，契约没有该清单）。
 *
 * 登记号是精确核对的主键；名称是第二判定键。二者任一未采集，就无法作出可复核的登记核对，
 * 因此一律落 `insufficient`，**不得**凭剩余字段猜一个 matched。
 * 调整该清单属于核对口径变化，须同步新增负例用例，不得用来把缺项抬成 matched。
 */
export const NECESSARY_LABEL_FIELDS = ['registration_number', 'name'] as const;

/** 契约 DoseConditions.required（全部 6 项）——用量卡的绑定条件必须齐全。 */
export const DOSE_CONDITION_FIELDS = [
  'crop_id',
  'region_code',
  'species_id',
  'growth_stage',
  'planting_method',
  'use_scene',
] as const;

export function isMatchState(value: unknown): value is MatchState {
  return typeof value === 'string' && (MATCH_STATES as readonly string[]).includes(value);
}

/** packages/contracts/openapi.json -> components.schemas.JobState.enum（逐项一致，不得扩展）。 */
export const JOB_STATES = [
  'queued',
  'running',
  'succeeded',
  'uncertain',
  'failed',
  'timed_out',
  'cancelled',
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** 终态：到达后不得再迁移（旧回调不复活）。 */
export const TERMINAL_JOB_STATES = ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'] as const;

export function isJobState(value: unknown): value is JobState {
  return typeof value === 'string' && (JOB_STATES as readonly string[]).includes(value);
}

export function isTerminalJobState(state: JobState): boolean {
  return (TERMINAL_JOB_STATES as readonly string[]).includes(state);
}

/**
 * 允许的状态迁移。终态不可离开；cancelled / timed_out 优先于任何迟到结果。
 * queued → failed / timed_out 覆盖「还没开始就超过截止时间」的情形。
 */
export function canTransitionJob(from: JobState, to: JobState): boolean {
  if (isTerminalJobState(from)) return false;
  if (from === 'queued') return to === 'running' || to === 'cancelled' || to === 'failed' || to === 'timed_out';
  if (from === 'running') return isTerminalJobState(to);
  return false;
}

/** 提供者 / 登记库输出被拒的原因（fail-closed，不透出提供者原文）。 */
export class OcrProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrProtocolError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 校验可空文本字段（先判 typeof 再判值，`undefined` 一律拒绝）。
 * 契约不允许 `undefined`：缺字段与显式 null 是两回事，缺字段是协议违规。
 */
export function normalizeNullableText(raw: unknown, field: string): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string') throw new OcrProtocolError(`${field} 必须是字符串或 null`);
  if (raw.length < 1 || raw.length > MAX_LABEL_TEXT_LENGTH) {
    throw new OcrProtocolError(`${field} 长度必须在 1..${MAX_LABEL_TEXT_LENGTH}`);
  }
  return raw;
}

/** 校验单个成分项（三项全必填，不补造单位或含量）。 */
export function normalizeIngredient(raw: unknown, index: number): Ingredient {
  if (!isPlainObject(raw)) throw new OcrProtocolError(`成分 ${index} 不是对象`);
  const extra = Object.keys(raw).filter((key) => key !== 'name' && key !== 'content_text' && key !== 'unit_text');
  if (extra.length > 0) throw new OcrProtocolError(`成分 ${index} 含未定义字段 ${extra[0]}`);
  if (!('name' in raw) || !('content_text' in raw) || !('unit_text' in raw)) {
    throw new OcrProtocolError(`成分 ${index} 缺少必填字段`);
  }
  const name = raw['name'];
  const contentText = raw['content_text'];
  const unitText = raw['unit_text'];
  for (const [value, label] of [
    [name, `成分 ${index} 的 name`],
    [contentText, `成分 ${index} 的 content_text`],
    [unitText, `成分 ${index} 的 unit_text`],
  ] as const) {
    if (typeof value !== 'string' || value.length < 1 || value.length > MAX_LABEL_TEXT_LENGTH) {
      throw new OcrProtocolError(`${label} 非法`);
    }
  }
  return { name: name as string, content_text: contentText as string, unit_text: unitText as string };
}

/** 校验成分数组：上限 20，超限即协议违规（**不截断**）。 */
export function normalizeIngredients(raw: unknown): Ingredient[] {
  if (!Array.isArray(raw)) throw new OcrProtocolError('ingredients 必须是数组');
  if (raw.length > MAX_INGREDIENTS) throw new OcrProtocolError(`成分超过契约上限 ${MAX_INGREDIENTS} 条`);
  return raw.map((item, index) => normalizeIngredient(item, index));
}

/**
 * 校验并归一化 LabelFields（additionalProperties:false，四字段全必填）。
 * **fail-closed**：缺字段 / 多余字段 / 类型不符一律抛错，绝不补造空值或占位文本。
 */
export function normalizeLabelFields(raw: unknown, where = 'fields'): LabelFields {
  if (!isPlainObject(raw)) throw new OcrProtocolError(`${where} 必须是对象`);
  const allowed = ['registration_number', 'name', 'ingredients', 'dosage_form'];
  const extra = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new OcrProtocolError(`${where} 含未定义字段 ${extra[0]}`);
  for (const key of allowed) {
    if (!(key in raw)) throw new OcrProtocolError(`${where} 缺少必填字段 ${key}`);
  }
  return {
    registration_number: normalizeNullableText(raw['registration_number'], `${where}.registration_number`),
    name: normalizeNullableText(raw['name'], `${where}.name`),
    ingredients: normalizeIngredients(raw['ingredients']),
    dosage_form: normalizeNullableText(raw['dosage_form'], `${where}.dosage_form`),
  };
}

function normalizeOptionalConditionText(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > MAX_LABEL_TEXT_LENGTH) {
    throw new OcrProtocolError(`${field} 非法`);
  }
  return raw;
}

/**
 * 校验并归一化 Conditions（crop_id / region_code 必填，其余可选；additionalProperties:false）。
 * 注意：契约允许只给 crop_id + region_code —— 这种「合法的**不全**」正是 dose_cards 必须为 [] 的场景。
 */
export function normalizeConditions(raw: unknown, where = 'conditions'): Conditions {
  if (!isPlainObject(raw)) throw new OcrProtocolError(`${where} 必须是对象`);
  const allowed = ['crop_id', 'region_code', 'species_id', 'growth_stage', 'planting_method', 'use_scene'];
  const extra = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new OcrProtocolError(`${where} 含未定义字段 ${extra[0]}`);
  const cropId = raw['crop_id'];
  if (typeof cropId !== 'string' || cropId.length < 1 || cropId.length > MAX_LABEL_TEXT_LENGTH) {
    throw new OcrProtocolError(`${where}.crop_id 非法`);
  }
  const regionCode = raw['region_code'];
  if (typeof regionCode !== 'string' || !REGION_CODE_PATTERN.test(regionCode)) {
    throw new OcrProtocolError(`${where}.region_code 非法（应为 ^33[0-9]{4}$）`);
  }
  const result: Conditions = { crop_id: cropId, region_code: regionCode };
  for (const key of ['species_id', 'growth_stage', 'planting_method', 'use_scene'] as const) {
    const value = normalizeOptionalConditionText(raw[key], `${where}.${key}`);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** DoseConditions 缺失项清单。**空数组才代表条件齐全**。 */
export function missingDoseConditionFields(conditions: Conditions | null | undefined): string[] {
  if (conditions === null || conditions === undefined) return [...DOSE_CONDITION_FIELDS];
  const missing: string[] = [];
  for (const field of DOSE_CONDITION_FIELDS) {
    const value = (conditions as unknown as Record<string, unknown>)[field];
    if (typeof value !== 'string' || value.length === 0) missing.push(field);
  }
  return missing;
}

/** 条件是否齐到可绑定用量卡（契约 DoseConditions 的 6 项全覆盖）。 */
export function isDoseConditionsComplete(conditions: Conditions | null | undefined): conditions is DoseConditions {
  return missingDoseConditionFields(conditions).length === 0;
}

/** 登记库记录（契约 Herbicide 投影，`packages/reference` 与本域共用形状）。 */
export interface SourceRefLike {
  id: string;
  version: string;
  title: string;
  url: string;
  publisher: string;
  source_kind: 'database' | 'verified_seed' | 'simulation';
  evidence_kind: 'research' | 'experience' | 'mixed';
  validity: 'valid' | 'expired' | 'conflicting' | 'unknown' | 'withdrawn';
  review_status: 'unverified' | 'verified' | 'rejected';
  updated_at: string;
}

export interface RegistryFormulation {
  id: string;
  registration_number: string;
  producer: string;
  dosage_form: string;
  ingredients: Ingredient[];
}

export interface RegistryHerbicide {
  id: string;
  revision: number;
  formulation: RegistryFormulation;
  source: SourceRefLike;
  risk_text: string;
  reference_state: 'available' | 'unavailable';
}

/** 登记库查询结果：可用性与候选在同一个联合里，避免「不可用」被当成「无结果」。 */
export type RegistryLookup =
  | { status: 'unavailable'; reason: string }
  | { status: 'available'; candidates: RegistryHerbicide[] };

export interface MatchDecision {
  match_state: MatchState;
  registration: RegistryHerbicide | null;
  conflict_fields: string[];
  missing_fields: string[];
}

/** 归一化文本用于比较：去首尾空白 + 全角空白归一 + 大小写无关。 */
function normalizeForCompare(value: string): string {
  return value.trim().replace(/[\s\u3000]+/g, '').toLowerCase();
}

/** 必要条件（登记号 / 名称）未采集清单。 */
export function missingNecessaryFields(fields: LabelFields): string[] {
  const missing: string[] = [];
  for (const field of NECESSARY_LABEL_FIELDS) {
    if (fields[field] === null) missing.push(field);
  }
  return missing.slice(0, MAX_MISSING_FIELDS);
}

/**
 * 比对标签字段与命中的登记制剂，返回冲突字段清单。
 * 只比对**双方都已知**的字段；标签缺失不算冲突（缺失走 missing_fields，不混用）。
 * `name` 不参与比对：契约 Herbicide 没有产品名字段（如实记录的契约缺口，不做同义猜测）。
 */
export function conflictFields(fields: LabelFields, registration: RegistryHerbicide): string[] {
  const conflicts: string[] = [];
  const labelReg = fields.registration_number;
  if (labelReg !== null && normalizeForCompare(labelReg) !== normalizeForCompare(registration.formulation.registration_number)) {
    conflicts.push('registration_number');
  }
  const labelForm = fields.dosage_form;
  if (labelForm !== null && normalizeForCompare(labelForm) !== normalizeForCompare(registration.formulation.dosage_form)) {
    conflicts.push('dosage_form');
  }
  if (fields.ingredients.length > 0 && registration.formulation.ingredients.length > 0) {
    const labelSet = fields.ingredients
      .map((item) => `${normalizeForCompare(item.name)}|${normalizeForCompare(item.content_text)}|${normalizeForCompare(item.unit_text)}`)
      .sort();
    const regSet = registration.formulation.ingredients
      .map((item) => `${normalizeForCompare(item.name)}|${normalizeForCompare(item.content_text)}|${normalizeForCompare(item.unit_text)}`)
      .sort();
    if (labelSet.join('\u0000') !== regSet.join('\u0000')) conflicts.push('ingredients');
  }
  return conflicts.slice(0, MAX_CONFLICT_FIELDS);
}

/**
 * 由「标签字段 + 登记库查询结果」判定 MatchState。规则（逐条即回归用例）：
 *
 * 1. 登记库不可用 → `unavailable`（**先于**任何 no_match/insufficient 判定：
 *    不可用绝不能被 `no_match` 掩盖）；
 * 2. 必要条件（登记号 / 名称）未采集 → `insufficient`（missing_fields 非空，**绝不** matched）；
 * 3. 候选为 0 → `no_match`；
 * 4. 候选 >1 且无法用登记号收敛到唯一一条 → `ambiguous`；
 * 5. 唯一命中且字段冲突 → `conflict`（conflict_fields 非空，registration 如实带出以便复核）；
 * 6. 仅当以上都不成立 → `matched`（此时 missing_fields 与 conflict_fields 必为空）。
 *
 * 该函数是纯函数，不读时钟、不做 I/O —— 便于逐条构造 6 类状态。
 */
export function decideMatchState(fields: LabelFields, lookup: RegistryLookup): MatchDecision {
  const missingFields = missingNecessaryFields(fields);

  if (lookup.status === 'unavailable') {
    return { match_state: 'unavailable', registration: null, conflict_fields: [], missing_fields: missingFields };
  }

  if (missingFields.length > 0) {
    // 必要条件未知/未采集：**不得**放行，也不猜候选。
    return { match_state: 'insufficient', registration: null, conflict_fields: [], missing_fields: missingFields };
  }

  const candidates = lookup.candidates;
  if (candidates.length === 0) {
    return { match_state: 'no_match', registration: null, conflict_fields: [], missing_fields: [] };
  }

  const labelReg = fields.registration_number;
  const exact = labelReg === null
    ? []
    : candidates.filter((item) => normalizeForCompare(item.formulation.registration_number) === normalizeForCompare(labelReg));

  if (candidates.length > 1 && exact.length !== 1) {
    // 多候选且登记号无法收敛到唯一一条：**不猜**，落 ambiguous。
    return { match_state: 'ambiguous', registration: null, conflict_fields: [], missing_fields: [] };
  }

  const chosen = exact.length === 1 ? exact[0] : candidates[0];
  if (chosen === undefined) {
    // 防御性分支：候选数组非空却取不到元素，属内部不变量被破坏，按不可用如实处理。
    return { match_state: 'unavailable', registration: null, conflict_fields: [], missing_fields: [] };
  }

  const conflicts = conflictFields(fields, chosen);
  if (conflicts.length > 0) {
    return {
      match_state: 'conflict',
      registration: chosen,
      conflict_fields: conflicts,
      missing_fields: [],
    };
  }

  return { match_state: 'matched', registration: chosen, conflict_fields: [], missing_fields: [] };
}

/** 契约 DoseCard 投影。 */
export interface DoseCard {
  id: string;
  revision: number;
  formulation: RegistryFormulation;
  conditions: DoseConditions;
  original_text: string;
  unit_text: string;
  method_text: string;
  precautions_text: string;
  source: SourceRefLike & { source_kind: 'database' | 'verified_seed'; validity: 'valid'; review_status: 'verified' };
  locator: string;
  content_hash: string;
}

/**
 * 用量卡候选：**来源可信度字段是实现层（非契约）判定依据，绝不下发**。
 * `card` 是契约投影；gate 只有在全部可信度条件成立时才允许它进入 `dose_cards`。
 *
 * 生产装配（`ocr/reference.ts`）在**任何**执行模式下都不产出候选
 * （替身不提供用量、真实来源尚未接线），因此生产路径的 `dose_cards` 恒为 `[]`；
 * 本接口的**通过面**只由测试**注入可信来源**来构造，绝不由替身数据扮演。
 */
export interface DoseCardCandidate {
  card: DoseCard;
  /** 绑定的登记制剂 registration_number：必须与核对命中的制剂一致。 */
  formulation_registration_number: string;
  /** 该卡声明的适用条件（契约 DoseConditions 六项全必填）。 */
  conditions: DoseConditions;
  /** —— 以下为来源可信度（实现层，非契约字段） —— */
  source_kind: 'database' | 'verified_seed' | 'simulation';
  validity: 'valid' | 'expired' | 'conflicting' | 'unknown' | 'withdrawn';
  review_status: 'unverified' | 'verified' | 'rejected';
  /** true = 模拟/替身来源，**必须**被 gate 丢弃。 */
  simulated: boolean;
}

/** gate 的拒绝原因（可观测、可单独指出）。 */
export type DoseGateReason =
  | 'CONDITIONS_ABSENT'
  | 'CONDITIONS_INCOMPLETE'
  | 'FORMULATION_MISMATCH'
  | 'CONDITIONS_MISMATCH'
  | 'SOURCE_SIMULATED'
  | 'SOURCE_KIND_UNTRUSTED'
  | 'SOURCE_EXPIRED'
  | 'SOURCE_UNVERIFIED'
  | 'CARD_MALFORMED';

export interface DoseGateDecision {
  usable: boolean;
  reason: DoseGateReason | null;
}

function doseConditionsMatch(card: DoseConditions, conditions: DoseConditions): boolean {
  for (const field of DOSE_CONDITION_FIELDS) {
    if (normalizeForCompare(card[field]) !== normalizeForCompare(conditions[field])) return false;
  }
  return true;
}

/** 契约形状校验：不合法就丢弃（**不修补、不补造文本**）。 */
function isContractShapeValid(card: DoseCard): boolean {
  const texts: Array<[unknown, number]> = [
    [card.original_text, MAX_DOSE_TEXT_LENGTH],
    [card.method_text, MAX_DOSE_TEXT_LENGTH],
    [card.precautions_text, MAX_DOSE_TEXT_LENGTH],
    [card.unit_text, MAX_DOSE_UNIT_LENGTH],
    [card.locator, MAX_LOCATOR_LENGTH],
  ];
  for (const [value, max] of texts) {
    if (typeof value !== 'string' || value.length < 1 || value.length > max) return false;
  }
  if (typeof card.id !== 'string' || card.id.length === 0) return false;
  if (typeof card.revision !== 'number' || !Number.isInteger(card.revision) || card.revision < 1) return false;
  if (typeof card.content_hash !== 'string' || !DOSE_CONTENT_HASH_PATTERN.test(card.content_hash)) return false;
  return true;
}

/**
 * 单卡适用性判定（**这是 PR #82 被判 P1 的那个 gate**）：
 * 单独看 `usable_as_dose === true`（等价于本层的 source_kind 可信）**不足以**放行，
 * 必须同时满足：条件齐全 → 绑定同一登记制剂 → 六项条件逐项一致 → 来源非模拟 →
 * 来源类型可信 → 未过期 → 已核对 → 卡片形状合法。
 *
 * 生产装配不产出任何候选，因此本函数的**通过面**只可能由测试注入可信来源触发；
 * 任何一项不成立都会给出可单独指出的拒绝原因（`DoseGateReason`），不做静默降级。
 */
export function decideDoseCard(
  candidate: DoseCardCandidate,
  input: { conditions: Conditions | null | undefined; registrationNumber: string | null },
): DoseGateDecision {
  const conditions = input.conditions;
  if (conditions === null || conditions === undefined) return { usable: false, reason: 'CONDITIONS_ABSENT' };
  if (!isDoseConditionsComplete(conditions)) return { usable: false, reason: 'CONDITIONS_INCOMPLETE' };
  if (input.registrationNumber === null) return { usable: false, reason: 'FORMULATION_MISMATCH' };
  if (
    normalizeForCompare(candidate.formulation_registration_number) !== normalizeForCompare(input.registrationNumber) ||
    normalizeForCompare(candidate.card.formulation.registration_number) !== normalizeForCompare(input.registrationNumber)
  ) {
    return { usable: false, reason: 'FORMULATION_MISMATCH' };
  }
  if (!doseConditionsMatch(candidate.conditions, conditions)) return { usable: false, reason: 'CONDITIONS_MISMATCH' };
  if (candidate.simulated || candidate.source_kind === 'simulation') return { usable: false, reason: 'SOURCE_SIMULATED' };
  if (candidate.source_kind !== 'database' && candidate.source_kind !== 'verified_seed') {
    return { usable: false, reason: 'SOURCE_KIND_UNTRUSTED' };
  }
  if (candidate.validity !== 'valid') return { usable: false, reason: 'SOURCE_EXPIRED' };
  if (candidate.review_status !== 'verified') return { usable: false, reason: 'SOURCE_UNVERIFIED' };
  if (!isContractShapeValid(candidate.card)) return { usable: false, reason: 'CARD_MALFORMED' };
  return { usable: true, reason: null };
}

/**
 * 批量 gate：只有 `decideDoseCard` 判可用的卡才进入结果，顺序稳定，最多 10 张。
 * **绝不补造**：候选为空（替身 / 真实来源未接线的生产装配）就返回空数组。
 * 生产替身**不提供**任何候选，因此本函数在 stub/preset_demo 下必然返回空
 * —— 这正是 #7 验收第 3 条要求的形态，不是"暂时没有数据"。
 */
export function gateDoseCards(input: {
  candidates: DoseCardCandidate[];
  conditions: Conditions | null | undefined;
  registrationNumber: string | null;
}): { dose_cards: DoseCard[]; rejections: Array<{ card_id: string; reason: DoseGateReason }> } {
  const doseCards: DoseCard[] = [];
  const rejections: Array<{ card_id: string; reason: DoseGateReason }> = [];
  for (const candidate of input.candidates) {
    const decision = decideDoseCard(candidate, { conditions: input.conditions, registrationNumber: input.registrationNumber });
    if (decision.usable && decision.reason === null) {
      if (doseCards.length < MAX_DOSE_CARDS) doseCards.push(candidate.card);
      continue;
    }
    rejections.push({
      card_id: typeof candidate.card.id === 'string' ? candidate.card.id : 'unknown',
      reason: decision.reason ?? 'CARD_MALFORMED',
    });
  }
  return { dose_cards: doseCards, rejections };
}
