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
 *
 * 跨线规则版本（GY-I08 issue #8 验收：「所有消费端使用同一规则版本」）：
 * 本层的规则版本**取自域库单一事实来源**（`packages/reference`，直接 import，不另抄一份），
 * 与 GY-I08 适用过滤层之间的差异登记为闭集 —— 见 `DOSE_GATE_RULE_VERSION` /
 * `DOSE_GATE_RULE_VERSION_DIFFERENCES`（在 `DoseGateDecision` 之后）。
 */

import { APPLICABILITY_RULE_VERSION, BLOCK_CODES } from '../../../../packages/reference/index.mjs';

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
/**
 * DoseCard.content_hash 契约 pattern。
 *
 * **用途判定（已查契约原文与仓库既有口径；结论：本片不重算，理由如下）**：
 * - 契约（`packages/contracts/openapi.json`）对该字段**只给了 `pattern: ^[a-f0-9]{64}$`**；
 *   `DoseCard` 与 `SourceVersion` 两处都**没有 `description`**，契约里没有任何地方
 *   定义这个哈希的"原文（preimage）"是什么；
 * - 仓库存在**两种互不相同**的既有含义：`packages/reference/records.mjs` 的 `recordContentHash`
 *   是"该记录自身若干字段的 JSON 摘要 sha256"；而 `db/samples/field-mapping.md` 把
 *   `sources[].issues[].attachment_sha256` 映射到 `source_versions.content_hash`，
 *   即**来源附件（原始文件）的 SHA-256**；
 * - 因此若用 `original_text` 之类自行挑选的原文重算比对，等于**发明一个契约未定义的约定**，
 *   会把"哈希绑定来源附件"的合法卡片整片误拒 —— 而本域**并不持有**来源附件字节。
 * - 故本片只做**契约可判定**的校验：存在 + 类型 + 符合 pattern（顺带 `format: uuid` 那类主动收紧见各 id 校验）。
 *   该字段在证据文档与 PR 正文里**如实登记为未校验字段**；阶段 2 接入真实用量来源后，
 *   正确做法是与**来源版本**的 `content_hash` 比对，而不是与本卡片文本比对。
 */
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

/**
 * 比较用文本规范化 —— **全片唯一的归一化口径**（集中一处，可单独单测）。
 *
 * 只消除**排版性**差异，不消除任何**实质**差异：
 *   1) `NFKC` 统一全角/半角与兼容字符（`Ａ`→`A`、`％`→`%`、全角空格 U+3000→半角空格）；
 *   2) 去掉首尾空白；
 *   3) 内部连续空白折叠为**单个半角空格**（**不删除**，因此 `41 %` 与 `41%` 仍视为不同）；
 *   4) 大小写无关。
 *
 * 明确**不允许**的等价：改动数字/含量、改动名称用字、增删成分、改变单位。
 */
export function normalizeComparableText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** 归一化文本用于比较（**委托** `normalizeComparableText`，保证全片同一口径）。 */
function normalizeForCompare(value: string): string {
  return normalizeComparableText(value);
}

/** 制剂交叉核对结果：不一致时带出**可单独指出**的字段名。 */
export interface FormulationCompareResult {
  ok: boolean;
  field: 'formulation.id' | 'registration_number' | 'producer' | 'dosage_form' | 'ingredients' | null;
}

/**
 * 交叉核对「卡片载荷里的制剂」与「登记库命中的制剂」——
 * 把项目口径「**原文用量必须是绑定登记制剂**」落到可判定的代码上。
 *
 * 依据契约 `Formulation`（`packages/contracts/openapi.json`）**按"契约可判定性"分层**：
 *   - `id`：`format: uuid`（严格说是注解；本片按主动收紧处理，且 **UUID 定义上大小写无关**）⇒ 规范化后相等；
 *   - `registration_number`(1..80)：自由文本，但它是**业务主键** ⇒ 规范化后相等；
 *   - `producer`(1..200) / `dosage_form`(1..80)：自由文本 ⇒ 规范化后相等（口径见 `normalizeComparableText`）；
 *   - `ingredients`：**结构化**（`Ingredient[]`，`minItems 1 / maxItems 20`，每项
 *     `name`/`content_text`/`unit_text` 三个自由文本）⇒ 先比长度，再按**多重集**逐项比对；
 *   - **成分顺序**：契约**未约束排序**（无 `uniqueItems`、无顺序语义）⇒ 允许重排，
 *     但不允许增删、改名、改含量、改单位。
 *
 * 任一不一致即视为"该卡并非绑定本次命中的制剂"，由调用方 fail-closed 拒绝。
 */
export function compareFormulation(
  cardFormulation: RegistryFormulation,
  authoritativeFormulation: RegistryFormulation,
): FormulationCompareResult {
  if (normalizeComparableText(cardFormulation.id) !== normalizeComparableText(authoritativeFormulation.id)) {
    return { ok: false, field: 'formulation.id' };
  }
  if (
    normalizeComparableText(cardFormulation.registration_number) !==
    normalizeComparableText(authoritativeFormulation.registration_number)
  ) {
    return { ok: false, field: 'registration_number' };
  }
  if (normalizeComparableText(cardFormulation.producer) !== normalizeComparableText(authoritativeFormulation.producer)) {
    return { ok: false, field: 'producer' };
  }
  if (
    normalizeComparableText(cardFormulation.dosage_form) !== normalizeComparableText(authoritativeFormulation.dosage_form)
  ) {
    return { ok: false, field: 'dosage_form' };
  }
  if (cardFormulation.ingredients.length !== authoritativeFormulation.ingredients.length) {
    return { ok: false, field: 'ingredients' };
  }
  const triplet = (item: Ingredient): string =>
    [
      normalizeComparableText(item.name),
      normalizeComparableText(item.content_text),
      normalizeComparableText(item.unit_text),
    ].join('\u0000');
  const cardTriplets = cardFormulation.ingredients.map(triplet).sort();
  const authoritativeTriplets = authoritativeFormulation.ingredients.map(triplet).sort();
  for (let index = 0; index < cardTriplets.length; index += 1) {
    if (cardTriplets[index] !== authoritativeTriplets[index]) return { ok: false, field: 'ingredients' };
  }
  return { ok: true, field: null };
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
 * 冲突字段 token：登记记录**自身状态**不构成「可核对」前提（不是标签字段冲突）。
 * 取值刻意写成 `source.<字段>` —— 与 `conflictFields()` 的标签字段名区分开，
 * 调用方/页面据此知道「不是某一格读错，而是这条登记记录本身不能用」。
 */
export const CONFLICT_FIELD_SOURCE_VALIDITY = 'source.validity';
export const CONFLICT_FIELD_SOURCE_REVIEW = 'source.review_status';

/**
 * 登记记录自身状态是否允许给出「核对通过」（`matched`）结论。
 *
 * 契约允许登记资料来源取宽枚举（`validity` ∈ valid/expired/withdrawn/conflicting/unknown，
 * `review_status` ∈ unverified/verified/rejected），它们表达的是这条记录**还能不能用**：
 * - `validity !== 'valid'` → `source.validity`（已过期/已撤销/来源冲突/状态未知）；
 * - `review_status === 'rejected'` → `source.review_status`（记录已被明确拒绝）。
 *
 * 为什么不是放行：文字识别成功 ≠ 药剂已核实（#10）。把失效/被拒记录算成 `matched`
 * 会让「核对通过」这一结论失去意义，故落 `conflict` 并**如实带出该记录**（供人工复核）。
 *
 * 边界：`unverified`（未核对来源，生产替身恒为此值）**不**在此拦截 —— 替身来源本就不是
 * 「已核对有效」来源，其用量放行由 `DoseSource` 的 const 约束在 `gateDoseCards` 单独把关。
 */
export function registrationStateConflicts(registration: RegistryHerbicide): string[] {
  const conflicts: string[] = [];
  if (registration.source.validity !== 'valid') conflicts.push(CONFLICT_FIELD_SOURCE_VALIDITY);
  if (registration.source.review_status === 'rejected') conflicts.push(CONFLICT_FIELD_SOURCE_REVIEW);
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
 * 6. 唯一命中但登记记录**自身已失效/被拒**（`validity !== 'valid'` 或 `review_status === 'rejected'`）
 *    → `conflict`（conflict_fields 带 `source.validity` / `source.review_status`，registration 照样带出）；
 *    即「文字识别成功 ≠ 药剂已核实」：失效登记不得给出「核对通过」结论；
 * 7. 仅当以上都不成立 → `matched`（此时 missing_fields 与 conflict_fields 必为空）。
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
  // 字段冲突 + 登记记录自身状态（失效/被拒）合并：任一非空都**不得** matched。
  // 顺序：先标签字段冲突（用户在页面上可直接对照的那几格），再来源状态。
  const allConflicts = [...conflicts, ...registrationStateConflicts(chosen)].slice(0, MAX_CONFLICT_FIELDS);
  if (allConflicts.length > 0) {
    return {
      match_state: 'conflict',
      registration: chosen,
      conflict_fields: allConflicts,
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
  | 'CARD_FORMULATION_MISMATCH'
  | 'CARD_SOURCE_INVALID';

/** gate 判定结果：可用时**必须**带出经校验的契约卡片（`card`），不可用时 `card` 为 null。 */
export type DoseGateDecision =
  | { usable: true; reason: null; card: DoseCard }
  | { usable: false; reason: DoseGateReason; card: null };


/**
 * —— 跨线规则版本（GY-I08 issue #8）——
 *
 * 本层闸门（GY-I10 线）与 `packages/reference`（GY-I08 线）是**两个不同层**的用量闸门：
 *   - GY-I08 闸门判定**内部记录**的适用性（8 维度：来源／禁限用／作物／生育期／地区／制剂／
 *     含量剂型／使用场景）与「原文用量是否绑定当前登记制剂」；
 *   - 本层闸门判定**冻结契约载荷**的完整性与绑定（`card` ↔ 请求条件 ↔ 登记制剂）
 *     + 来源可信度（`source_kind` / `validity` / `review_status` / `simulated`）。
 *
 * 因此本轮**不把 GY-I08 的判定搬进本层**：那会改变 I10 已合并的行为（见
 * `not_enforced_block_codes` —— 冻结契约 `DoseSource` **没有任何禁限用字段**，
 * 本层数据形状**无法表达**禁用／限用／未采集禁限用）。本轮只做**最小、可回退**的统一：
 * 版本号取自域库单一事实来源，两层之间的差异登记成闭集并由测试断言（漂移即失败）。
 *
 * 回退方式：删除本文件顶部的 import 与下列三个导出即可还原为「未声明版本」。
 */
export const DOSE_GATE_RULE_VERSION: string = APPLICABILITY_RULE_VERSION;

/**
 * 本层拒绝原因 → GY-I08 阻断类别（闭集）。
 *
 * 映射值取域库 `BLOCK_CODES` 的**枚举成员本身**（不抄字符串字面量）；
 * `Record<DoseGateReason, string>` 使**穷尽性由 tsc 保证** —— 新增一个 `DoseGateReason`
 * 而不给出映射，`npm run lint`（tsc --noEmit）直接失败。
 */
export const DOSE_GATE_REASON_BLOCK_CODES: Record<DoseGateReason, string> = {
  CONDITIONS_ABSENT: BLOCK_CODES.MISSING_CONDITION,
  CONDITIONS_INCOMPLETE: BLOCK_CODES.MISSING_CONDITION,
  FORMULATION_MISMATCH: BLOCK_CODES.NO_MATCH,
  CONDITIONS_MISMATCH: BLOCK_CODES.NOT_APPLICABLE,
  SOURCE_SIMULATED: BLOCK_CODES.SIMULATED_SOURCE,
  SOURCE_KIND_UNTRUSTED: BLOCK_CODES.NO_SOURCE,
  SOURCE_EXPIRED: BLOCK_CODES.INVALID_SOURCE,
  SOURCE_UNVERIFIED: BLOCK_CODES.UNREVIEWED,
  CARD_MALFORMED: BLOCK_CODES.NO_SOURCE,
  CARD_CONDITIONS_INVALID: BLOCK_CODES.MISSING_CONDITION,
  CARD_CONDITIONS_MISMATCH: BLOCK_CODES.NOT_APPLICABLE,
  CARD_FORMULATION_MISMATCH: BLOCK_CODES.FIELD_CONFLICT,
  CARD_SOURCE_INVALID: BLOCK_CODES.INVALID_SOURCE,
};

/** 本层拒绝原因闭集（由映射表键导出，避免与 `DoseGateReason` 联合出现第二份清单）。 */
export const DOSE_GATE_REASONS: readonly DoseGateReason[] = Object.freeze(
  Object.keys(DOSE_GATE_REASON_BLOCK_CODES) as DoseGateReason[],
);

/**
 * 差异登记（跨线统一的**可断言对象**）。
 *
 * `reviewed_against` 是人工复核本映射表时的规则版本**字面量**：域库版本一旦变更
 * （`1.2.0` → 更高），它与 `APPLICABILITY_RULE_VERSION` 不再相等，漂移检测测试立即失败，
 * 要求人工重新复核本表 —— 而不是让本层静默声称已对齐新规则。
 */
export const DOSE_GATE_RULE_VERSION_DIFFERENCES = Object.freeze({
  reviewed_against: 'gy-i08/1.2.0',
  reason_to_block_code: DOSE_GATE_REASON_BLOCK_CODES,
  /**
   * GY-I08 会阻断、而**本层数据形状无法表达**的阻断类别（**如实登记，不声称已统一**）：
   * 冻结契约 `DoseSource` 只有 `source_kind` / `validity` / `review_status`，
   * **没有任何禁限用字段**，故本层无法判定禁用／限用／未采集禁限用 ——
   * 禁限用筛选在 GY-I08 适用过滤层完成。真实统一需契约侧新增字段（超出本轮范围）。
   */
  not_enforced_block_codes: Object.freeze([
    BLOCK_CODES.BANNED,
    BLOCK_CODES.RESTRICTED,
    BLOCK_CODES.RESTRICTION_UNKNOWN,
  ] as readonly string[]),
});

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
 * 单卡适用性判定（**这是 PR #82 被判 P1、监工 `5487924164` 指出只信外层、
 * 指挥 `74599e2` 要求收口"登记制剂绑定"的那个 gate**）。
 *
 * 判定链（逐条即回归用例），**判定对象是 `candidate.card`（实际要下发的载荷）**：
 *   1. 请求侧条件必须齐全（契约 DoseConditions 六项）；
 *   2. 载荷 `card` 必须可读且结构合法（缺字段/类型异常/越界 ⇒ 拒绝，**读不到就不放行**）；
 *   3. **`card.conditions` 六项必须与请求逐项一致**（否则 `CARD_CONDITIONS_MISMATCH`）；
 *   4. `card.formulation.registration_number` 必须等于本次命中的登记制剂；
 *   5. **`card.formulation` 必须与登记库命中的 `registration.formulation` 逐字段交叉核对**
 *      （`id`/`registration_number`/`producer`/`dosage_form`/`ingredients`，口径见 `compareFormulation`；
 *      任一不一致 ⇒ `CARD_FORMULATION_MISMATCH`）—— 落地「原文用量必须绑定登记制剂」；
 *   6. 外层候选必须与载荷**互相印证**（条件与制剂任一侧不一致 ⇒ 拒绝，不回退只信一侧）；
 *   7. 外层来源标记也必须合格（`simulated` / `simulation` 等任一不合格 ⇒ 拒绝）。
 *
 * 单独看 `usable_as_dose === true`（或外层 `source_kind` 可信）**远不足以**放行。
 * 通过时返回的是**重新构造**的契约卡片，调用方只能下发它，不能下发原始载荷。
 */
export function decideDoseCard(
  candidate: unknown,
  input: { conditions: Conditions | null | undefined; registration: RegistryHerbicide | null },
): DoseGateDecision {
  const fail = (reason: DoseGateReason): DoseGateDecision => ({ usable: false, reason, card: null });

  const requestConditions = input.conditions;
  if (requestConditions === null || requestConditions === undefined) return fail('CONDITIONS_ABSENT');
  if (!isDoseConditionsComplete(requestConditions)) return fail('CONDITIONS_INCOMPLETE');
  // 没有权威登记制剂就无从绑定 ⇒ 不得放行。
  if (input.registration === null) return fail('FORMULATION_MISMATCH');
  const authoritative = input.registration.formulation;

  const candidateRecord = asRecord(candidate);
  if (candidateRecord === null) return fail('CARD_MALFORMED');

  // 2) 载荷自身必须可读且合法 —— 这是原始实现缺失的一步。
  const validated = validateDoseCardPayload(candidateRecord['card']);
  if (!validated.ok) return fail(validated.reason);
  const card = validated.card;

  // 3) **卡片**六项条件必须与请求逐项一致（防止放行"错误作物"的用量原文）。
  if (!doseConditionsEqual(card.conditions, requestConditions)) return fail('CARD_CONDITIONS_MISMATCH');

  // 4) **卡片**绑定的登记号必须等于本次命中的登记制剂。
  if (normalizeForCompare(card.formulation.registration_number) !== normalizeForCompare(authoritative.registration_number)) {
    return fail('FORMULATION_MISMATCH');
  }

  // 5) **卡片制剂**与**登记库制剂**逐字段交叉核对（收口"登记制剂绑定"）。
  const formulationCheck = compareFormulation(card.formulation, authoritative);
  if (!formulationCheck.ok) return fail('CARD_FORMULATION_MISMATCH');

  // 6) 外层与载荷互相印证：不一致即视为不可信载荷，拒绝。
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

  // 7) 外层来源标记也必须合格（任一说不合格即拒绝；载荷侧的判定已在步骤 2 完成）。
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
 * `registration` 是**本次核对命中的权威登记记录**，制剂交叉核对以它为准。
 *
 * **绝不补造**：候选为空（替身 / 真实来源未接线的生产装配）就返回空数组。
 * 生产替身**不提供**任何候选，因此本函数在 stub/preset_demo 下必然返回空
 * —— 这正是 #7 验收第 3 条要求的形态，不是"暂时没有数据"。
 */
export function gateDoseCards(input: {
  candidates: unknown;
  conditions: Conditions | null | undefined;
  registration: RegistryHerbicide | null;
}): { dose_cards: DoseCard[]; rejections: Array<{ card_id: string; reason: DoseGateReason }> } {
  const doseCards: DoseCard[] = [];
  const rejections: Array<{ card_id: string; reason: DoseGateReason }> = [];
  const list = Array.isArray(input.candidates) ? input.candidates : [];
  for (const candidate of list) {
    const decision = decideDoseCard(candidate, {
      conditions: input.conditions,
      registration: input.registration,
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

// ---------------------------------------------------------------------------
// GY-I10（#10）· 用户校正台账（原 `ocr/correction.ts`，为不新增 OCR 域运行时装载边而并入本模块）
// ---------------------------------------------------------------------------
/**
 * 用户校正台账：**append-only** 的「谁改的、改了什么、改前原文」。
 *
 * 契约（openapi `correctOCR`）只规定三件事：`raw_fields` 必须保留、校正写进 `corrected_fields`、
 * `revision` 递增。它**没有**规定「谁改的 / 改了什么」落在哪里。本模块补这条审计面，
 * 并把三条硬约束写成可执行断言：
 *
 *   1) **不可覆盖**：台账只追加，任何 entry 的 `raw_fields` 都是校正时点的模型原始输出快照，
 *      `assertRawPreserved` 要求它与 `OcrRow.rawFields` 逐字段相等 —— 校正不得回写原文。
 *   2) **不计准确率**：`correctedFields !== rawFields` 的行是**人工改写**样本，
 *      `ocrAccuracyDenominator` 把它们从分母里剔除并单列（`human_edited_rows`），
 *      且返回前由 `assertAccuracySample` 断言「分母 = 纳入行数」「纳入 ∩ 剔除 = ∅」。
 *   3) **不新增列**：台账挂在 `ocr_records.verification` 这个**已获列级授权**的 jsonb 文档的
 *      `correction_log` 键上（见 `services/api/db/migrations/0024_ocr_persistence.sql:68` 与
 *      `deploy/postgres-cvm/sql/20-login-roles.sql` 对 `ocr_records.verification` 的 UPDATE 面）。
 *      读路径 `store-pg.readVerification` 与契约投影 `service.toOcr` 都把台账键剥掉，
 *      对外契约面仍严格是五字段 `Verification`。为什么不建新表/新列：runtime 的列级授权只落在
 *      `deploy/postgres-cvm/sql/20-login-roles.sql`（本片硬规则禁改），另加一张表或一列却没有
 *      对应列级授权，会让 least-privilege 断言变成假绿（表级 GRANT 会吞掉列级面）。
 */

/** 台账版本：形状一变就改这里，读路径按版本 fail-closed。 */
export const CORRECTION_LEDGER_VERSION = 'gy-i10-correction/1.0.0';

/** 单条记录的校正次数上限：超过即拒绝（不静默截断历史）。 */
export const MAX_CORRECTION_ENTRIES = 200;

/** 参与「改了什么」比对的可校正字段（顺序即展示顺序）。 */
export const CORRECTED_FIELD_NAMES = ['registration_number', 'name', 'ingredients', 'dosage_form'] as const;
export type CorrectedFieldName = (typeof CORRECTED_FIELD_NAMES)[number];

/** 一个字段的一次改写：改前 / 改后都保留（`null` = 该字段原本/改后为空）。 */
export interface CorrectionChange {
  field: CorrectedFieldName;
  before: string | null;
  after: string | null;
}

/** 一版校正：**谁**（actor_user_id）在**哪一版**（revision）改了**什么**（changes）。 */
export interface CorrectionEntry {
  /** 台账内递增版本号（1..N），与 `revision` 分开：revision 是记录版本，version 是校正序号。 */
  version: number;
  /** 本次校正落库后的 `OcrRow.revision`。 */
  revision: number;
  /** 谁改的（契约主体 id；不落手机号/姓名等任何 PII）。 */
  actor_user_id: string;
  /** 改的时间（ISO 8601，服务端时钟）。 */
  corrected_at: string;
  /** 逐字段 diff（空 diff 不允许入库）。 */
  changes: CorrectionChange[];
  /** 校正时点的模型原始输出快照 —— **不可覆盖**证据。 */
  raw_fields: LabelFields;
  /** 校正后另存的这一版字段。 */
  corrected_fields: LabelFields;
}

export interface CorrectionLedger {
  version: string;
  entries: CorrectionEntry[];
}

/** 台账相关的硬失败（形状非法 / 次数超限 / 断言被违反）。 */
export class CorrectionLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorrectionLedgerError';
  }
}

/** 深拷贝字段（台账与调用方之间不共享可变结构）。 */
export function cloneLabelFields(fields: LabelFields): LabelFields {
  return {
    registration_number: fields.registration_number,
    name: fields.name,
    ingredients: fields.ingredients.map((item) => ({ ...item })),
    dosage_form: fields.dosage_form,
  };
}

/**
 * 字段的可比较渲染串（用于 diff 与「是否人工改写过」）。
 * 成分按 `name|content_text|unit_text` 三元组**排序**后拼接：单纯顺序变化不算改写。
 */
export function renderFieldValue(fields: LabelFields, field: CorrectedFieldName): string | null {
  if (field === 'ingredients') {
    if (fields.ingredients.length === 0) return null;
    return fields.ingredients
      .map((item) => `${item.name}|${item.content_text}|${item.unit_text}`)
      .slice()
      .sort()
      .join(' ; ');
  }
  return fields[field];
}

/** 逐字段 diff（只返回真的变了的字段，顺序由 `CORRECTED_FIELD_NAMES` 决定）。 */
export function diffLabelFields(before: LabelFields, after: LabelFields): CorrectionChange[] {
  const changes: CorrectionChange[] = [];
  for (const field of CORRECTED_FIELD_NAMES) {
    const from = renderFieldValue(before, field);
    const to = renderFieldValue(after, field);
    if (from !== to) changes.push({ field, before: from, after: to });
  }
  return changes;
}

/** 该记录是否被**人工改写**过（任一字段变化即算）。 */
export function isHumanEdited(row: { rawFields: LabelFields; correctedFields: LabelFields }): boolean {
  return diffLabelFields(row.rawFields, row.correctedFields).length > 0;
}

function ledgerRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function singleLineOrNull(value: unknown, where: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000) {
    throw new CorrectionLedgerError(`校正台账字段非法：${where}`);
  }
  return value;
}

function readLabelFields(value: unknown, where: string): LabelFields {
  const record = ledgerRecord(value);
  if (record === null) throw new CorrectionLedgerError(`校正台账字段非法：${where}`);
  const ingredientsValue = record['ingredients'];
  if (!Array.isArray(ingredientsValue)) throw new CorrectionLedgerError(`校正台账字段非法：${where}.ingredients`);
  const ingredients = ingredientsValue.map((item, index) => {
    const row = ledgerRecord(item);
    if (row === null) throw new CorrectionLedgerError(`校正台账字段非法：${where}.ingredients[${index}]`);
    const name = row['name'];
    const contentText = row['content_text'];
    const unitText = row['unit_text'];
    if (typeof name !== 'string' || typeof contentText !== 'string' || typeof unitText !== 'string') {
      throw new CorrectionLedgerError(`校正台账字段非法：${where}.ingredients[${index}]`);
    }
    return { name, content_text: contentText, unit_text: unitText };
  });
  return {
    registration_number: singleLineOrNull(record['registration_number'], `${where}.registration_number`),
    name: singleLineOrNull(record['name'], `${where}.name`),
    ingredients,
    dosage_form: singleLineOrNull(record['dosage_form'], `${where}.dosage_form`),
  };
}

/**
 * 从 jsonb 里读回台账（形状不合法 ⇒ 抛错，绝不「尽力解析」出半个台账）。
 * 键不存在（`undefined`/`null`）⇒ `undefined`：老记录没有台账是合法状态。
 */
export function parseCorrectionLedger(value: unknown): CorrectionLedger | undefined {
  if (value === undefined || value === null) return undefined;
  const record = ledgerRecord(value);
  if (record === null) throw new CorrectionLedgerError('校正台账形状非法');
  if (record['version'] !== CORRECTION_LEDGER_VERSION) {
    throw new CorrectionLedgerError(`校正台账版本不受支持：${String(record['version'])}`);
  }
  const rawEntries = record['entries'];
  if (!Array.isArray(rawEntries)) throw new CorrectionLedgerError('校正台账 entries 非法');
  if (rawEntries.length > MAX_CORRECTION_ENTRIES) throw new CorrectionLedgerError('校正台账条目超过上限');
  const entries: CorrectionEntry[] = rawEntries.map((item, index) => {
    const row = ledgerRecord(item);
    if (row === null) throw new CorrectionLedgerError(`校正台账第 ${index + 1} 条非法`);
    const version = row['version'];
    const revision = row['revision'];
    const actor = row['actor_user_id'];
    const correctedAt = row['corrected_at'];
    if (version !== index + 1) throw new CorrectionLedgerError(`校正台账第 ${index + 1} 条版本号不连续`);
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
      throw new CorrectionLedgerError(`校正台账第 ${index + 1} 条 revision 非法`);
    }
    if (typeof actor !== 'string' || actor.length === 0 || actor.length > 120) {
      throw new CorrectionLedgerError(`校正台账第 ${index + 1} 条 actor 非法`);
    }
    if (typeof correctedAt !== 'string' || Number.isNaN(Date.parse(correctedAt))) {
      throw new CorrectionLedgerError(`校正台账第 ${index + 1} 条时间非法`);
    }
    const rawChanges = row['changes'];
    if (!Array.isArray(rawChanges) || rawChanges.length === 0) {
      throw new CorrectionLedgerError(`校正台账第 ${index + 1} 条 changes 非法`);
    }
    const changes: CorrectionChange[] = rawChanges.map((change, changeIndex) => {
      const changeRow = ledgerRecord(change);
      if (changeRow === null) throw new CorrectionLedgerError(`校正台账第 ${index + 1} 条 changes[${changeIndex}] 非法`);
      const field = changeRow['field'];
      if (typeof field !== 'string' || !(CORRECTED_FIELD_NAMES as readonly string[]).includes(field)) {
        throw new CorrectionLedgerError(`校正台账第 ${index + 1} 条 changes[${changeIndex}].field 非法`);
      }
      return {
        field: field as CorrectedFieldName,
        before: singleLineOrNull(changeRow['before'], `changes[${changeIndex}].before`),
        after: singleLineOrNull(changeRow['after'], `changes[${changeIndex}].after`),
      };
    });
    return {
      version,
      revision,
      actor_user_id: actor,
      corrected_at: correctedAt,
      changes,
      raw_fields: readLabelFields(row['raw_fields'], `entries[${index}].raw_fields`),
      corrected_fields: readLabelFields(row['corrected_fields'], `entries[${index}].corrected_fields`),
    };
  });
  return { version: CORRECTION_LEDGER_VERSION, entries };
}

/**
 * 追加一版校正，返回**新**台账（不就地改入参）。
 * 空 diff（用户提交了与当前完全相同的字段）不产生版本 —— 那不是一个「改写」。
 */
export function appendCorrection(
  ledger: CorrectionLedger | undefined,
  input: {
    actorUserId: string;
    at: Date;
    revision: number;
    /** 本次校正前的生效字段（上一版 corrected_fields，首版即 raw_fields）。 */
    before: LabelFields;
    after: LabelFields;
    /** 模型原始输出（校正时点快照；永不覆盖）。 */
    raw: LabelFields;
  },
): CorrectionLedger {
  const previous = ledger?.entries ?? [];
  if (previous.length >= MAX_CORRECTION_ENTRIES) {
    throw new CorrectionLedgerError(`单条记录最多 ${MAX_CORRECTION_ENTRIES} 次校正，已拒绝新的改写`);
  }
  const changes = diffLabelFields(input.before, input.after);
  if (changes.length === 0) throw new CorrectionLedgerError('校正未改变任何字段，不产生新版本');
  const entry: CorrectionEntry = {
    version: previous.length + 1,
    revision: input.revision,
    actor_user_id: input.actorUserId,
    corrected_at: input.at.toISOString(),
    changes,
    raw_fields: cloneLabelFields(input.raw),
    corrected_fields: cloneLabelFields(input.after),
  };
  return { version: CORRECTION_LEDGER_VERSION, entries: [...previous, entry] };
}

/**
 * 断言：台账里每一版的 `raw_fields` 都等于该记录当前的 `rawFields`。
 * 任何人把校正写回原文（或反过来把原文当校正留档）都会在这里被抓住。
 */
export function assertRawPreserved(ledger: CorrectionLedger, raw: LabelFields): void {
  const expected = JSON.stringify(readLabelFields(raw, 'raw'));
  for (const entry of ledger.entries) {
    const actual = JSON.stringify(entry.raw_fields);
    if (actual !== expected) {
      throw new CorrectionLedgerError(`第 ${entry.version} 版校正的 raw_fields 与模型原始输出不一致（原文被覆盖）`);
    }
  }
}

/** 台账摘要（对外只给计数与最后改写时间，不给 PII）。 */
export function summarizeCorrections(ledger: CorrectionLedger | undefined): {
  version: string | null;
  count: number;
  last_corrected_at: string | null;
} {
  const entries = ledger?.entries ?? [];
  const last = entries.length === 0 ? null : (entries.at(-1) ?? null);
  return {
    version: ledger === undefined ? null : ledger.version,
    count: entries.length,
    last_corrected_at: last === null ? null : last.corrected_at,
  };
}

/** 准确率统计口径（手工改写**不计入**分母）。 */
export interface OcrAccuracySample {
  /** 参与统计的记录总数（含被剔除项）。 */
  rows: number;
  /** 被剔除的人工改写行数。 */
  human_edited_rows: number;
  /** 真正进分母的模型输出样本数。 */
  denominator: number;
  included: string[];
  excluded: string[];
}

/**
 * 口径断言：分母只能等于「纳入行数」，且纳入集合与剔除集合不得有交集。
 * 任何把人工改写样本算进模型准确率的改动都会在这里抛错。
 */
export function assertAccuracySample(sample: OcrAccuracySample): void {
  const overlap = sample.included.filter((id) => sample.excluded.includes(id));
  if (overlap.length > 0) throw new CorrectionLedgerError(`人工改写样本混入准确率分母：${overlap.join(',')}`);
  if (sample.denominator !== sample.included.length) {
    throw new CorrectionLedgerError('准确率分母与纳入行数不一致');
  }
  if (sample.denominator + sample.human_edited_rows !== sample.rows) {
    throw new CorrectionLedgerError('准确率分母 + 剔除行数必须等于记录总数');
  }
}

/**
 * 计算 OCR 准确率分母：`correctedFields !== rawFields` 的行（人工改写）一律剔除并单列。
 * 调用方拿到的 `denominator` 就是「模型原始输出」的样本数，不允许再自己加回去。
 */
export function ocrAccuracyDenominator(
  rows: ReadonlyArray<{ id: string; rawFields: LabelFields; correctedFields: LabelFields }>,
): OcrAccuracySample {
  const included: string[] = [];
  const excluded: string[] = [];
  for (const row of rows) {
    if (isHumanEdited(row)) excluded.push(row.id);
    else included.push(row.id);
  }
  const sample: OcrAccuracySample = {
    rows: rows.length,
    human_edited_rows: excluded.length,
    denominator: included.length,
    included,
    excluded,
  };
  assertAccuracySample(sample);
  return sample;
}

// ---------------------------------------------------------------------------
// GY-I10（#10）· 登记核对的稳定状态码（原 `ocr/verdict.ts`，同上为装载边而并入）
// ---------------------------------------------------------------------------
/**
 * 登记核对的**稳定状态码**与「冲突必须阻断用量」的守卫。
 *
 * 契约 `Verification.match_state` 是 7 值闭集（`matched|no_match|ambiguous|conflict|insufficient|unavailable`），
 * 但产品验收要的是**四类明确状态**：冲突 / 无匹配 / 多结果 / 已失效。其中「已失效」在契约里
 * 没有独立值——`state.ts` 把它表达成 `match_state='conflict'` + `conflict_fields` 含
 * `source.validity`（登记资料过期/撤消/冲突）。本模块把那层表达映射成**稳定码**，
 * 客户端/测试只需要认码，不必再解析 `conflict_fields` 的字符串约定：
 *
 *   REGISTRATION_MATCHED     唯一精确命中且逐字段无冲突 → 允许产出用量
 *   REGISTRATION_NOT_FOUND   登记库里没有这个证号 → 阻断用量
 *   REGISTRATION_AMBIGUOUS   同名多结果且无法按证号收敛 → 阻断用量（同名不同制剂不得静默匹配）
 *   REGISTRATION_CONFLICT    命中但字段/来源状态冲突 → 阻断用量
 *   REGISTRATION_EXPIRED     conflict 的子类：来源已失效/撤消/未知 → 阻断用量
 *   LABEL_FIELDS_INSUFFICIENT 必要条件（证号/名称）未采集 → 阻断用量
 *   REGISTRY_UNAVAILABLE     登记库不可用 → 阻断用量（不得降级成无匹配）
 *
 * `deriveOcrVerdict` 是纯函数；`assertDoseNotProduced` 是守卫生效点：任何「已阻断却仍带出
 * 用量卡」的组合都会抛错，供服务层与测试双向钉死。
 */

export const OCR_VERDICT_CODES = {
  matched: 'REGISTRATION_MATCHED',
  no_match: 'REGISTRATION_NOT_FOUND',
  ambiguous: 'REGISTRATION_AMBIGUOUS',
  conflict: 'REGISTRATION_CONFLICT',
  expired: 'REGISTRATION_EXPIRED',
  insufficient: 'LABEL_FIELDS_INSUFFICIENT',
  unavailable: 'REGISTRY_UNAVAILABLE',
} as const;

export type OcrVerdictCode = (typeof OCR_VERDICT_CODES)[keyof typeof OCR_VERDICT_CODES];

/** 阻断理由（稳定码；客户端可直接映射文案，不必解析中文）。 */
export const DOSE_BLOCK_REASONS = {
  REGISTRATION_MATCHED: null,
  REGISTRATION_NOT_FOUND: 'REGISTRATION_NOT_FOUND',
  REGISTRATION_AMBIGUOUS: 'SAME_NAME_MULTIPLE_REGISTRATIONS',
  REGISTRATION_CONFLICT: 'REGISTRATION_FIELD_CONFLICT',
  REGISTRATION_EXPIRED: 'REGISTRATION_EXPIRED',
  LABEL_FIELDS_INSUFFICIENT: 'NECESSARY_FIELDS_MISSING',
  REGISTRY_UNAVAILABLE: 'REGISTRY_UNAVAILABLE',
} as const satisfies Record<OcrVerdictCode, string | null>;

export interface OcrVerdict {
  /** 稳定状态码（四类明确状态在此收敛）。 */
  code: OcrVerdictCode;
  /** 原始契约 match_state（保留，不得改写）。 */
  match_state: MatchState;
  /** true = **禁止**产出用量卡片；false = 仅「精确命中且无冲突」时。 */
  dose_blocked: boolean;
  /** 阻断理由稳定码（`dose_blocked=false` 时为 null）。 */
  block_reason: string | null;
  /** 造成冲突的字段（`conflict_fields` 原样带出，便于 UI 逐字段提示）。 */
  conflict_fields: string[];
}

/** 该 match_state 是否**必须**阻断用量（除 matched 外全阻断）。 */
export function doseBlockedForMatchState(matchState: MatchState): boolean {
  return matchState !== 'matched';
}

/**
 * 由（match_state + conflict_fields）推导稳定状态码。
 * 「已失效」判定复用 `state.ts` 的字段约定常量，避免两处字符串字面量漂移。
 */
export function deriveOcrVerdict(input: {
  match_state: MatchState;
  conflict_fields: readonly string[];
}): OcrVerdict {
  const conflictFields = [...input.conflict_fields];
  const isExpired = input.match_state === 'conflict' && conflictFields.includes(CONFLICT_FIELD_SOURCE_VALIDITY);
  let code: OcrVerdictCode;
  if (input.match_state === 'conflict') {
    code = isExpired ? OCR_VERDICT_CODES.expired : OCR_VERDICT_CODES.conflict;
  } else {
    code = OCR_VERDICT_CODES[input.match_state];
  }
  const doseBlocked = doseBlockedForMatchState(input.match_state);
  return {
    code,
    match_state: input.match_state,
    dose_blocked: doseBlocked,
    block_reason: doseBlocked ? DOSE_BLOCK_REASONS[code] : null,
    conflict_fields: conflictFields,
  };
}

/**
 * 守卫生效点：已阻断却带出用量卡 ⇒ 抛错（不是「顺手清空」——静默清空会掩盖上游门的丢失）。
 * 返回值仍是同一份卡片数组，便于在服务层直接 `const cards = assertDoseNotProduced(verdict, cards)`。
 */
export function assertDoseNotProduced<T>(verdict: OcrVerdict, doseCards: readonly T[]): readonly T[] {
  if (verdict.dose_blocked && doseCards.length > 0) {
    throw new Error(`违反用量阻断：${verdict.code} 不得带出 ${doseCards.length} 张用量卡片`);
  }
  return doseCards;
}

// ---------------------------------------------------------------------------
// GY-I10（#10）· 契约 Verification 投影（原 `ocr/store.ts`，同因装载边而并入）
// ---------------------------------------------------------------------------

/** 契约 Verification 投影（五字段全必填）。 */
export interface OcrVerification {
  match_state: MatchState;
  registration: RegistryHerbicide | null;
  conflict_fields: string[];
  missing_fields: string[];
  dose_cards: DoseCard[];
}

/**
 * 落在 `ocr_records.verification` 这个 jsonb 文档里的**存储形状**：
 * 契约五字段 + 可选的用户校正台账（`correction_log`）。
 *
 * 为什么台账挂在这里而不是新表/新列：runtime 的列级授权只落在
 * `deploy/postgres-cvm/sql/20-login-roles.sql`（本片硬规则禁改），新增表/列会让
 * least-privilege 断言变假绿。台账键在**读路径**（`store-pg.readVerification`）与
 * **契约投影**（`toVerificationProjection`）两处都被剥掉，对外 HTTP 面仍是五字段。
 */
export interface OcrVerificationDocument extends OcrVerification {
  /** 用户校正台账（append-only；从未校正过的老记录没有这个键）。 */
  correction_log?: CorrectionLedger;
}

/**
 * 存储形状 → 契约 `Verification` 投影（五字段全必填）。
 * 台账键在这里被剥掉：HTTP 200 的 `VerificationEnvelope` 不能多一个字段
 * （契约 `Verification` 是 `additionalProperties:false`）。
 */
export function toVerificationProjection(verification: OcrVerificationDocument): OcrVerification {
  return {
    match_state: verification.match_state,
    registration: verification.registration === null ? null : structuredClone(verification.registration),
    conflict_fields: [...verification.conflict_fields],
    missing_fields: [...verification.missing_fields],
    dose_cards: verification.dose_cards.map((card) => structuredClone(card)),
  };
}
