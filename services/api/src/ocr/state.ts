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
/** Herbicide.risk_text maxLength。 */
export const MAX_RISK_TEXT_LENGTH = 4000;
/** SourceRef.title / publisher maxLength。 */
export const MAX_SOURCE_TITLE_LENGTH = 200;

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
 * 把登记库返回物当**不可信载荷**收敛：任何无法逐字段解析的情形一律收敛为 `unavailable`。
 *
 * 为什么不是"丢弃坏候选、保留好候选"：那会让 `ambiguous` **静默退化成 `matched`**
 * （少一条候选就"唯一命中"了），等于把"读不到"伪装成"更确定的结论"。
 * 因此任一候选不可解析 ⇒ 整体 `unavailable`（fail-closed），
 * 且**不抛错**把请求打成 500 —— 调用方据此如实回 `unavailable`。
 *
 * `registration` 会**直接下发**（`Verification.registration`），所以这里逐字段校验并重建对象，
 * 未校验的字段不可能随行。
 */
export function sanitizeRegistryLookup(raw: unknown): RegistryLookup {
  const record = asRecord(raw);
  if (record === null) return { status: 'unavailable', reason: '登记库返回不可解析载荷' };
  const status = record['status'];
  if (status === 'unavailable') {
    const reason = typeof record['reason'] === 'string' && record['reason'].length > 0 ? record['reason'] : '登记库不可用';
    return { status: 'unavailable', reason };
  }
  if (status !== 'available') return { status: 'unavailable', reason: '登记库返回未知状态' };
  const rawCandidates = record['candidates'];
  if (!Array.isArray(rawCandidates)) return { status: 'unavailable', reason: '登记库候选不是数组' };
  const candidates: RegistryHerbicide[] = [];
  for (const item of rawCandidates) {
    const candidate = validateRegistryHerbicide(item);
    if (candidate === null) return { status: 'unavailable', reason: '登记库候选不可解析' };
    candidates.push(candidate);
  }
  return { status: 'available', candidates };
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
 *
 * **实现层口径声明（契约未规定，指挥已接受现状）**：契约只给出 `MatchState` 的 6 个取值，
 * **没有**规定彼此的优先级。下面这条「`unavailable` > `insufficient` > `conflict` >
 * `ambiguous` > `no_match` > `matched`」的判定顺序，以及上文 `NECESSARY_LABEL_FIELDS`
 * 那份「必要条件」清单，都是**本实现的选择**，不是契约条文：
 * - 顺序的可见后果：登记号缺失但同时存在冲突时，本实现报 `insufficient` 而非 `conflict`；
 * - 六类结论都严格非 `matched`，故该顺序不影响 fail-closed 安全性，只影响呈现的可读性；
 * - 若要调整，须同步修改对应负例用例，并同步证据文档。
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

  // 防御性运行时守卫：生产路径的 lookup 已经过 `sanitizeRegistryLookup`，
  // 但本函数是导出的判定入口，载荷畸形时必须如实收敛为 unavailable 而不是抛错。
  const candidates = lookup.candidates;
  if (!Array.isArray(candidates)) {
    return { match_state: 'unavailable', registration: null, conflict_fields: [], missing_fields: missingFields };
  }
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

/** 契约 DoseSource：source_kind ∈ {database, verified_seed}（**不含 simulation**）、validity const "valid"、review_status const "verified"。 */
export interface DoseSourceRef extends SourceRefLike {
  source_kind: 'database' | 'verified_seed';
  validity: 'valid';
  review_status: 'verified';
}

/**
 * 契约 DoseCard 投影。**只能**由 `decideDoseCard` / `gateDoseCards` 逐字段校验并
 * **重新构造**后产出 —— 任何未校验的字段都不可能随它一起下发。
 */
export interface DoseCard {
  id: string;
  revision: number;
  formulation: RegistryFormulation;
  conditions: DoseConditions;
  original_text: string;
  unit_text: string;
  method_text: string;
  precautions_text: string;
  source: DoseSourceRef;
  locator: string;
  content_hash: string;
}

/**
 * 端口返回的**未校验**用量卡载荷。
 *
 * 与契约 `DoseCard` 的唯一结构差别：`source` 取**宽松联合**，`withdrawn` / `rejected` /
 * `simulation` 都能被表达出来 —— 但它们会被 gate 拒绝。**它绝不直接被下发**：
 * 下发对象只能是 gate 校验后重新投影出的 `DoseCard`。
 */
export type DoseCardPayload = Omit<DoseCard, 'source'> & { source: SourceRefLike };

/**
 * 用量卡候选：`card` 是**未校验载荷**，外层字段是实现层（非契约）元数据。
 *
 * **判定对象是 `card`（真正要下发的对象），不是本结构的外层字段。**
 * 外层只用于「与卡片互相印证」：任一侧不一致即视为不可信载荷并拒绝，
 * **不回退成"只信一侧"**（监工 `5487924164` / 行内 `4245800045` 指出的形态）。
 *
 * 生产装配（`ocr/reference.ts`）在**任何**执行模式下都不产出候选
 * （替身不提供用量、真实来源尚未接线），因此生产路径的 `dose_cards` 恒为 `[]`；
 * 本接口的**通过面**只由测试**注入可信来源**来构造，绝不由替身数据扮演。
 */
export interface DoseCardCandidate {
  /** 真正要下发的卡（未校验；由 gate 校验后投影为契约 DoseCard）。 */
  card: DoseCardPayload;
  /** 绑定的登记制剂 registration_number：必须与核对命中的制剂一致。 */
  formulation_registration_number: string;
  /** 该候选声明的适用条件（契约 DoseConditions 六项全必填）。 */
  conditions: DoseConditions;
  /** —— 以下为来源可信度（实现层，非契约字段） —— */
  source_kind: 'database' | 'verified_seed' | 'simulation';
  validity: 'valid' | 'expired' | 'conflicting' | 'unknown' | 'withdrawn';
  review_status: 'unverified' | 'verified' | 'rejected';
  /** true = 模拟/替身来源，**必须**被 gate 丢弃。 */
  simulated: boolean;
}

/**
 * gate 的拒绝原因（可观测、可单独指出）。
 *
 * `CARD_*` 系列**指向实际要下发的载荷 `card`**，与指向外层元数据的 `SOURCE_*` / `CONDITIONS_*`
 * 区分开：定位时能一眼看出是"载荷本身不合格"还是"外层与载荷互相矛盾"。
 */
export type DoseGateReason =
  | 'CONDITIONS_ABSENT'
  | 'CONDITIONS_INCOMPLETE'
  | 'FORMULATION_MISMATCH'
  | 'CONDITIONS_MISMATCH'
  | 'SOURCE_SIMULATED'
  | 'SOURCE_KIND_UNTRUSTED'
  | 'SOURCE_EXPIRED'
  | 'SOURCE_UNVERIFIED'
  | 'CARD_MALFORMED'
  | 'CARD_CONDITIONS_INVALID'
  | 'CARD_CONDITIONS_MISMATCH'
  | 'CARD_SOURCE_INVALID';

/** gate 判定结果：可用时**必须**带出经校验的契约卡片（`card`），不可用时 `card` 为 null。 */
export type DoseGateDecision =
  | { usable: true; reason: null; card: DoseCard }
  | { usable: false; reason: DoseGateReason; card: null };

/** 卡片/制剂/来源 id 的契约 `format: uuid`；与本服务其他入口（media_id、路径 id）同一口径。 */
const UUID_LIKE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 把未知值当「记录」读取；数组与 null 一律不可读。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 1..max 字符的非空字符串，否则 null（不补造、不截断）。 */
function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) return null;
  return value;
}

function uuidString(value: unknown): string | null {
  return typeof value === 'string' && UUID_LIKE_PATTERN.test(value) ? value : null;
}

/** 严格校验成分数组（1..20；三项皆 1..80 字符串）。**不修补、不补造**。 */
function validateIngredients(raw: unknown): Ingredient[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_INGREDIENTS) return null;
  const list: Ingredient[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (record === null) return null;
    const name = boundedString(record['name'], MAX_LABEL_TEXT_LENGTH);
    const contentText = boundedString(record['content_text'], MAX_LABEL_TEXT_LENGTH);
    const unitText = boundedString(record['unit_text'], MAX_LABEL_TEXT_LENGTH);
    if (name === null || contentText === null || unitText === null) return null;
    list.push({ name, content_text: contentText, unit_text: unitText });
  }
  return list;
}

/** 校验并投影契约 Formulation（含 1..20 项成分）。 */
function validateFormulation(raw: unknown): RegistryFormulation | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const id = uuidString(record['id']);
  const registrationNumber = boundedString(record['registration_number'], MAX_LABEL_TEXT_LENGTH);
  const producer = boundedString(record['producer'], 200);
  const dosageForm = boundedString(record['dosage_form'], MAX_LABEL_TEXT_LENGTH);
  const ingredients = validateIngredients(record['ingredients']);
  if (id === null || registrationNumber === null || producer === null || dosageForm === null || ingredients === null) {
    return null;
  }
  return { id, registration_number: registrationNumber, producer, dosage_form: dosageForm, ingredients };
}

/**
 * 校验并投影契约 SourceRef（**登记资料的来源**）。
 * 注意：登记资料的 `validity` / `review_status` 取**宽枚举**（未核对、已失效都是合法状态），
 * 它们是**展示**信息而非用量放行依据 —— 用量放行只由 `DoseSource` 的 const 约束决定。
 */
function validateRegistrySource(raw: unknown): SourceRefLike | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const id = uuidString(record['id']);
  const version = boundedString(record['version'], MAX_LABEL_TEXT_LENGTH);
  const title = boundedString(record['title'], MAX_SOURCE_TITLE_LENGTH);
  const url = typeof record['url'] === 'string' && record['url'].startsWith('https://') ? record['url'] : null;
  const publisher = boundedString(record['publisher'], MAX_SOURCE_TITLE_LENGTH);
  const sourceKind = record['source_kind'];
  const evidenceKind = record['evidence_kind'];
  const validity = record['validity'];
  const reviewStatus = record['review_status'];
  const updatedAt = record['updated_at'];
  if (id === null || version === null || title === null || url === null || publisher === null) return null;
  if (sourceKind !== 'database' && sourceKind !== 'verified_seed' && sourceKind !== 'simulation') return null;
  if (evidenceKind !== 'research' && evidenceKind !== 'experience' && evidenceKind !== 'mixed') return null;
  if (validity !== 'valid' && validity !== 'expired' && validity !== 'conflicting' && validity !== 'unknown' && validity !== 'withdrawn') {
    return null;
  }
  if (reviewStatus !== 'unverified' && reviewStatus !== 'verified' && reviewStatus !== 'rejected') return null;
  if (typeof updatedAt !== 'string' || updatedAt.length === 0 || Number.isNaN(Date.parse(updatedAt))) return null;
  return {
    id,
    version,
    title,
    url,
    publisher,
    source_kind: sourceKind,
    evidence_kind: evidenceKind,
    validity,
    review_status: reviewStatus,
    updated_at: updatedAt,
  };
}

/** 校验并投影契约 Herbicide（**会直接下发**，故逐字段校验并重建）。 */
function validateRegistryHerbicide(raw: unknown): RegistryHerbicide | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const id = uuidString(record['id']);
  const revision = record['revision'];
  const formulation = validateFormulation(record['formulation']);
  const source = validateRegistrySource(record['source']);
  const riskText = boundedString(record['risk_text'], MAX_RISK_TEXT_LENGTH);
  const referenceState = record['reference_state'];
  if (
    id === null ||
    typeof revision !== 'number' ||
    !Number.isInteger(revision) ||
    revision < 1 ||
    formulation === null ||
    source === null ||
    riskText === null ||
    (referenceState !== 'available' && referenceState !== 'unavailable')
  ) {
    return null;
  }
  return { id, revision, formulation, source, risk_text: riskText, reference_state: referenceState };
}

/** 校验并投影契约 DoseConditions（**六项全必填**；region_code 遵契约 pattern）。 */
export function validateDoseConditions(raw: unknown): DoseConditions | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const regionCode = record['region_code'];
  if (typeof regionCode !== 'string' || !REGION_CODE_PATTERN.test(regionCode)) return null;
  const cropId = boundedString(record['crop_id'], MAX_LABEL_TEXT_LENGTH);
  const speciesId = boundedString(record['species_id'], MAX_LABEL_TEXT_LENGTH);
  const growthStage = boundedString(record['growth_stage'], MAX_LABEL_TEXT_LENGTH);
  const plantingMethod = boundedString(record['planting_method'], MAX_LABEL_TEXT_LENGTH);
  const useScene = boundedString(record['use_scene'], MAX_LABEL_TEXT_LENGTH);
  if (cropId === null || speciesId === null || growthStage === null || plantingMethod === null || useScene === null) {
    return null;
  }
  return {
    crop_id: cropId,
    region_code: regionCode,
    species_id: speciesId,
    growth_stage: growthStage,
    planting_method: plantingMethod,
    use_scene: useScene,
  };
}

/** 校验并投影契约 DoseSource（调用方已判定 source_kind 属可信集合）。 */
function validateDoseSource(record: Record<string, unknown>, kind: 'database' | 'verified_seed'): DoseSourceRef | null {
  const id = uuidString(record['id']);
  const version = boundedString(record['version'], MAX_LABEL_TEXT_LENGTH);
  const title = boundedString(record['title'], 200);
  const url = typeof record['url'] === 'string' && record['url'].startsWith('https://') ? record['url'] : null;
  const publisher = boundedString(record['publisher'], 200);
  const evidenceKind = record['evidence_kind'];
  const updatedAt = record['updated_at'];
  if (id === null || version === null || title === null || url === null || publisher === null) return null;
  if (evidenceKind !== 'research' && evidenceKind !== 'experience' && evidenceKind !== 'mixed') return null;
  if (typeof updatedAt !== 'string' || updatedAt.length === 0 || Number.isNaN(Date.parse(updatedAt))) return null;
  return {
    id,
    version,
    title,
    url,
    publisher,
    source_kind: kind,
    evidence_kind: evidenceKind,
    validity: 'valid',
    review_status: 'verified',
    updated_at: updatedAt,
  };
}

function doseConditionsEqual(a: DoseConditions, b: DoseConditions): boolean {
  for (const field of DOSE_CONDITION_FIELDS) {
    if (normalizeForCompare(a[field]) !== normalizeForCompare(b[field])) return false;
  }
  return true;
}

/** 宽松记录（外层候选声明）与已校验条件比对。 */
function recordConditionsEqual(record: Record<string, unknown>, conditions: DoseConditions): boolean {
  for (const field of DOSE_CONDITION_FIELDS) {
    const value = record[field];
    if (typeof value !== 'string') return false;
    if (normalizeForCompare(value) !== normalizeForCompare(conditions[field])) return false;
  }
  return true;
}

/**
 * 校验并**重新构造**契约 DoseCard —— 本片修 P1 的核心。
 *
 * 判定对象是**实际要下发的载荷**，不是外层候选：
 * - 条件取自 `card.conditions`：六项缺一或不合契约（如 `region_code` 不匹配 `^33[0-9]{4}$`）
 *   即 `CARD_CONDITIONS_INVALID`；
 * - 来源取自 `card.source`：`source_kind` / `validity` / `review_status` 取**卡片内**的值，
 *   `simulation` / `withdrawn` / `rejected` 一律拒绝；
 * - 任一字段缺失、类型异常、越界 ⇒ 拒绝（**读不到就不放行**），绝不回退成"只信外层"；
 * - 通过时**逐字段新建对象**，未校验的字段不可能随它一起下发。
 */
function validateDoseCardPayload(raw: unknown): { ok: true; card: DoseCard } | { ok: false; reason: DoseGateReason } {
  const record = asRecord(raw);
  if (record === null) return { ok: false, reason: 'CARD_MALFORMED' };

  const conditions = validateDoseConditions(record['conditions']);
  if (conditions === null) return { ok: false, reason: 'CARD_CONDITIONS_INVALID' };

  const sourceRecord = asRecord(record['source']);
  if (sourceRecord === null) return { ok: false, reason: 'CARD_SOURCE_INVALID' };
  const sourceKind = sourceRecord['source_kind'];
  if (sourceKind === 'simulation') return { ok: false, reason: 'SOURCE_SIMULATED' };
  if (sourceKind !== 'database' && sourceKind !== 'verified_seed') return { ok: false, reason: 'SOURCE_KIND_UNTRUSTED' };
  if (sourceRecord['validity'] !== 'valid') return { ok: false, reason: 'SOURCE_EXPIRED' };
  if (sourceRecord['review_status'] !== 'verified') return { ok: false, reason: 'SOURCE_UNVERIFIED' };
  const source = validateDoseSource(sourceRecord, sourceKind);
  if (source === null) return { ok: false, reason: 'CARD_SOURCE_INVALID' };

  const id = uuidString(record['id']);
  const revision = record['revision'];
  const formulation = validateFormulation(record['formulation']);
  const originalText = boundedString(record['original_text'], MAX_DOSE_TEXT_LENGTH);
  const unitText = boundedString(record['unit_text'], MAX_DOSE_UNIT_LENGTH);
  const methodText = boundedString(record['method_text'], MAX_DOSE_TEXT_LENGTH);
  const precautionsText = boundedString(record['precautions_text'], MAX_DOSE_TEXT_LENGTH);
  const locator = boundedString(record['locator'], MAX_LOCATOR_LENGTH);
  const contentHash =
    typeof record['content_hash'] === 'string' && DOSE_CONTENT_HASH_PATTERN.test(record['content_hash'])
      ? record['content_hash']
      : null;
  if (
    id === null ||
    typeof revision !== 'number' ||
    !Number.isInteger(revision) ||
    revision < 1 ||
    formulation === null ||
    originalText === null ||
    unitText === null ||
    methodText === null ||
    precautionsText === null ||
    locator === null ||
    contentHash === null
  ) {
    return { ok: false, reason: 'CARD_MALFORMED' };
  }

  return {
    ok: true,
    card: {
      id,
      revision,
      formulation,
      conditions,
      original_text: originalText,
      unit_text: unitText,
      method_text: methodText,
      precautions_text: precautionsText,
      source,
      locator,
      content_hash: contentHash,
    },
  };
}

/**
 * 单卡适用性判定（**这是 PR #82 被判 P1、并被监工 `5487924164` 指出只信外层的那个 gate**）。
 *
 * 判定链（逐条即回归用例），**判定对象是 `candidate.card`（实际要下发的载荷）**：
 *   1. 请求侧条件必须齐全（契约 DoseConditions 六项）；
 *   2. 载荷 `card` 必须可读且结构合法（缺字段/类型异常/越界 ⇒ 拒绝，**读不到就不放行**）；
 *   3. **`card.conditions` 六项必须与请求逐项一致**（否则 `CARD_CONDITIONS_MISMATCH`）；
 *   4. `card.formulation.registration_number` 必须等于本次命中的登记制剂；
 *   5. 外层候选必须与载荷**互相印证**（条件与制剂任一侧不一致 ⇒ 拒绝，不回退只信一侧）；
 *   6. 外层来源标记也必须合格（`simulated` / `simulation` 等任一不合格 ⇒ 拒绝）。
 *
 * 单独看 `usable_as_dose === true`（或外层 `source_kind` 可信）**远不足以**放行。
 * 通过时返回的是**重新构造**的契约卡片，调用方只能下发它，不能下发原始载荷。
 */
export function decideDoseCard(
  candidate: unknown,
  input: { conditions: Conditions | null | undefined; registrationNumber: string | null },
): DoseGateDecision {
  const fail = (reason: DoseGateReason): DoseGateDecision => ({ usable: false, reason, card: null });

  const requestConditions = input.conditions;
  if (requestConditions === null || requestConditions === undefined) return fail('CONDITIONS_ABSENT');
  if (!isDoseConditionsComplete(requestConditions)) return fail('CONDITIONS_INCOMPLETE');
  if (input.registrationNumber === null) return fail('FORMULATION_MISMATCH');

  const candidateRecord = asRecord(candidate);
  if (candidateRecord === null) return fail('CARD_MALFORMED');

  // 2) 载荷自身必须可读且合法 —— 这是原实现缺失的一步。
  const validated = validateDoseCardPayload(candidateRecord['card']);
  if (!validated.ok) return fail(validated.reason);
  const card = validated.card;

  // 3) **卡片**六项条件必须与请求逐项一致（防止放行"错误作物"的用量原文）。
  if (!doseConditionsEqual(card.conditions, requestConditions)) return fail('CARD_CONDITIONS_MISMATCH');

  // 4) **卡片**绑定的登记制剂必须与本次命中一致。
  if (normalizeForCompare(card.formulation.registration_number) !== normalizeForCompare(input.registrationNumber)) {
    return fail('FORMULATION_MISMATCH');
  }

  // 5) 外层与载荷互相印证：不一致即视为不可信载荷，拒绝。
  const envelopeConditions = asRecord(candidateRecord['conditions']);
  if (envelopeConditions === null || !recordConditionsEqual(envelopeConditions, card.conditions)) {
    return fail('CONDITIONS_MISMATCH');
  }
  const envelopeFormulation = candidateRecord['formulation_registration_number'];
  if (
    typeof envelopeFormulation !== 'string' ||
    normalizeForCompare(envelopeFormulation) !== normalizeForCompare(card.formulation.registration_number)
  ) {
    return fail('FORMULATION_MISMATCH');
  }

  // 6) 外层来源标记也必须合格（任一说不合格即拒绝；载荷侧的判定已在步骤 2 完成）。
  if (candidateRecord['simulated'] === true) return fail('SOURCE_SIMULATED');
  const envelopeKind = candidateRecord['source_kind'];
  if (envelopeKind === 'simulation') return fail('SOURCE_SIMULATED');
  if (envelopeKind !== 'database' && envelopeKind !== 'verified_seed') return fail('SOURCE_KIND_UNTRUSTED');
  if (candidateRecord['validity'] !== 'valid') return fail('SOURCE_EXPIRED');
  if (candidateRecord['review_status'] !== 'verified') return fail('SOURCE_UNVERIFIED');

  return { usable: true, reason: null, card };
}

/**
 * 批量 gate：只有 `decideDoseCard` 判可用的卡才进入结果，顺序稳定，最多 10 张。
 * 下发的是 gate **重新构造**的契约卡片，不是端口给的原始载荷。
 *
 * 入参 `candidates` 按**不可信数据**处理：非数组视同没有可信候选（fail-closed：不放行，
 * 也不抛错把请求打成 500）；单个元素畸形由 `decideDoseCard` 给 `CARD_MALFORMED`。
 *
 * **绝不补造**：候选为空（替身 / 真实来源未接线的生产装配）就返回空数组。
 * 生产替身**不提供**任何候选，因此本函数在 stub/preset_demo 下必然返回空
 * —— 这正是 #7 验收第 3 条要求的形态，不是"暂时没有数据"。
 */
export function gateDoseCards(input: {
  candidates: unknown;
  conditions: Conditions | null | undefined;
  registrationNumber: string | null;
}): { dose_cards: DoseCard[]; rejections: Array<{ card_id: string; reason: DoseGateReason }> } {
  const doseCards: DoseCard[] = [];
  const rejections: Array<{ card_id: string; reason: DoseGateReason }> = [];
  const list = Array.isArray(input.candidates) ? input.candidates : [];
  for (const candidate of list) {
    const decision = decideDoseCard(candidate, {
      conditions: input.conditions,
      registrationNumber: input.registrationNumber,
    });
    if (decision.usable) {
      if (doseCards.length < MAX_DOSE_CARDS) doseCards.push(decision.card);
      continue;
    }
    const cardRecord = asRecord(asRecord(candidate)?.['card']);
    const rawId = cardRecord === null ? null : cardRecord['id'];
    rejections.push({ card_id: typeof rawId === 'string' ? rawId : 'unknown', reason: decision.reason });
  }
  return { dose_cards: doseCards, rejections };
}
