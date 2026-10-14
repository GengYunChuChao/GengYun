/**
 * GY-I09 **选择后关联科普与条件**（issue #9 范围第 3 条）与 **GY-I08 守卫接线**。
 *
 * 派单口径（逐条落实，不得放宽）：
 *   1. 「只取**有效、可访问、非模拟**的资料」——复用 GY-I08 域库的
 *      `evaluateEligibility(item, { includeSimulated: false })` + `isSimulatedSource(item)`
 *      作为唯一判据（**不在此处另写一套可见性/有效性规则**）。
 *   2. 「**条件完整后才可查询**」——条件按契约 `DoseConditions` 的 6 个必填字段判定
 *      （`crop_id` / `region_code` / `species_id` / `growth_stage` / `planting_method` / `use_scene`）；
 *      不完整即 `CONDITIONS_INCOMPLETE`（契约 422 闭集成员），**不静默放宽、不补默认值**。
 *   3. 「**不得跳过 GY-I08 的规则与用量卡守卫**」——具体用量只能经域库的
 *      `doseCardDescriptor()`，且规则版本必须等于 `APPLICABILITY_RULE_VERSION`；
 *      本模块导出 `LINKAGE_RULE_VERSION` 并在每次判定时断言一致（漂移即抛错）。
 *   4. 「**禁止经问答或识别绕过**」——识别/选择这条路径**恒不产出用量卡**：
 *      `dose.renderable === false`、`dose.card === null`，
 *      即便条件完整也一样（用量必须走 GY-I08 授权的资料/OCR 消费面）。
 *      该硬约束由 `DOSE_PATH_BLOCK_CODE` 显式带出，**不是**「恰好没数据」。
 *
 * 契约边界（本片硬约束）：
 *   - **不新增契约路径、不新增契约字段**：本模块的输出是**域内**结构，只用于落库的
 *     选择记录与页面展示，绝不塞进冻结的 `Recognition` / `Job` 封套
 *     （两者都是 `additionalProperties: false`）。
 *   - 不生成个人处方、不做剂量换算（`dose.card` 恒 null）。
 */

import { APPLICABILITY_RULE_VERSION } from '../../../../packages/reference/constants.mjs';
import { BLOCK_CODES } from '../../../../packages/reference/deterministic.mjs';
import { doseCardDescriptor } from '../../../../packages/reference/labels.mjs';
import { evaluateEligibility, evaluateApplicability, isSimulatedSource } from '../../../../packages/reference/query.mjs';
import { loadCatalog } from '../../../../packages/reference/catalog.mjs';
import { loadHerbicideRecords } from '../../../../packages/reference/records.mjs';
import type { ErrorCode } from '../contract.ts';
import { ApiError } from '../errors.ts';

/**
 * 本模块消费的规则版本。
 *
 * **唯一事实来源**是域库的 `APPLICABILITY_RULE_VERSION`；这里只是显式别名，
 * 便于测试断言「选择后关联」与 GY-I08 消费端**同版本**。
 */
export const LINKAGE_RULE_VERSION: string = APPLICABILITY_RULE_VERSION;

/** 测试用于断言规则版本未静默跟随：人工复核时的字面量（漂移即失败）。 */
export const LINKAGE_RULE_VERSION_REVIEWED_AGAINST = 'gy-i08/1.2.0';

/** 选择后关联的**资料条目**内部投影（契约外；不下发、不进封套）。 */
export interface LinkageItem {
  record_id: string;
  title: string;
  registration_number: string;
  dosage_form: string;
  use_scene: string | null;
  /** 真实来源种类（只读自域库；模拟来源在进入本列表前已被排除）。 */
  source_kind: string;
  /** 契约 `ReferenceState` 取值。 */
  reference_state: 'available' | 'unavailable';
  review_status: string;
  /** 依据当前条件判定该条目是否适用（GY-I08 判定，不在此重写规则）。 */
  applicable: boolean;
  /** 不适用的 GY-I08 阻断类别（闭集；适用时为空数组）。 */
  blocked_codes: string[];
  /** 不适用的**可读原因**（逐维度，AC02「缺项有原因」；适用时为空数组）。 */
  reasons: string[];
}

/** 被排除的资料（**如实带出原因**，不静默丢弃）。 */
export interface LinkageExcluded {
  record_id: string;
  /** 域库给出的可读原因（缺项/失效/模拟/下界等）。 */
  reason: string;
}

/** `DoseConditions` 的 6 个必填字段（顺序即契约字段顺序，便于逐项核对缺项）。 */
export const DOSE_CONDITION_FIELDS = [
  'crop_id',
  'region_code',
  'species_id',
  'growth_stage',
  'planting_method',
  'use_scene',
] as const;
export type DoseConditionField = (typeof DOSE_CONDITION_FIELDS)[number];

/** 适用/用量判定的条件输入（契约 `Conditions` 的超集；缺项一律如实判定为缺）。 */
export interface SelectionConditions {
  crop_id?: string | null;
  region_code?: string | null;
  species_id?: string | null;
  growth_stage?: string | null;
  planting_method?: string | null;
  use_scene?: string | null;
}

/**
 * 识别/选择路径的**恒定**用量阻断类别。
 *
 * 取闭集成员 `no_dose_source`：识别这条路径**没有**经 GY-I08 授权的用量来源，
 * 因此**任何**条件下都不得产出用量卡。这不是「恰好没数据」，而是路径本身的硬边界。
 */
export const DOSE_PATH_BLOCK_CODE: string = BLOCK_CODES.NO_DOSE_SOURCE;

/** `region_code` 的契约形状（浙江 33xxxx）。 */
const REGION_CODE_PATTERN = /^33[0-9]{4}$/;

/** 非空字符串归一（去空白；非字符串即空）。 */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 缺项清单（**逐项如实**，不补默认值）。
 * `region_code` 另需满足契约 `^33[0-9]{4}$`，形状不符同样计入缺项。
 */
export function missingDoseConditions(conditions: SelectionConditions | null | undefined): DoseConditionField[] {
  const source = conditions ?? {};
  const missing: DoseConditionField[] = [];
  for (const field of DOSE_CONDITION_FIELDS) {
    const value = text(source[field]);
    if (value === '') {
      missing.push(field);
      continue;
    }
    if (field === 'region_code' && !REGION_CODE_PATTERN.test(value)) missing.push(field);
  }
  return missing;
}

/** 条件是否完整（契约 `DoseConditions` 口径）。 */
export function isConditionsComplete(conditions: SelectionConditions | null | undefined): boolean {
  return missingDoseConditions(conditions).length === 0;
}

/**
 * 条件不全即**阻断**（契约 422 `CONDITIONS_INCOMPLETE`）。
 *
 * 供「条件完整后才可查询」的**强制**入口使用；识别/选择写面本身**不**调用它
 * （用户可以先只选品种，再补条件），因此本函数是被显式消费的守卫，而不是隐形副作用。
 */
export function requiresCompleteConditions(conditions: SelectionConditions | null | undefined): void {
  const missing = missingDoseConditions(conditions);
  if (missing.length === 0) return;
  const code: ErrorCode = 'CONDITIONS_INCOMPLETE';
  throw new ApiError(code, `条件不完整，暂不可查询用量：缺少 ${missing.join('、')}`, {
    details: missing.map((field) => ({ field, code: 'missing' })),
  });
}

/** 域库条目里被本模块读取的字段（结构子集，避免依赖域库内部类型）。 */
interface ReferenceRecordLike {
  record_id?: unknown;
  registration_number?: unknown;
  registered_name?: unknown;
  dosage_form?: unknown;
  use_scene?: unknown;
  target_original?: unknown;
  visibility?: unknown;
  reference_state?: unknown;
  simulated?: unknown;
  source?: { source_kind?: unknown; evidence_kind?: unknown; validity?: unknown; source_validity?: unknown } | null;
  verification?: { review_status?: unknown } | null;
  knowledge?: { title?: unknown } | null;
  crop_ids?: unknown;
}

/** 条件 → 域库判定上下文（只带**非空**字段；空/缺失一律不传，避免被当成"已采集"）。 */
function conditionContext(conditions: SelectionConditions): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  for (const field of DOSE_CONDITION_FIELDS) {
    const value = text(conditions[field]);
    if (value !== '') context[field] = value;
  }
  return context;
}

/** 域库条目 → 本模块的**内部**资料条目（不产出契约投影）。 */
function toLinkageItem(record: ReferenceRecordLike, context: Record<string, unknown>): LinkageItem {
  const applicability = evaluateApplicability(record, context);
  const title = text(record.knowledge?.title) || text(record.registered_name);
  const reviewStatus = text(record.verification?.review_status);
  return {
    record_id: text(record.record_id),
    title,
    registration_number: text(record.registration_number),
    dosage_form: text(record.dosage_form),
    use_scene: text(record.use_scene) === '' ? null : text(record.use_scene),
    source_kind: text(record.source?.source_kind),
    reference_state: record.reference_state === 'unavailable' ? 'unavailable' : 'available',
    review_status: reviewStatus === '' ? 'unknown' : reviewStatus,
    applicable: applicability.applicable === true,
    blocked_codes: Array.isArray(applicability.blocked) ? [...applicability.blocked] : [],
    reasons: Array.isArray(applicability.reasons) ? [...applicability.reasons] : [],
  };
}

/** 逐条候选资料的用量判定（用于证明「同规则版本」与「识别路径恒不渲染」）。 */
export interface LinkageDoseItemVerdict {
  record_id: string;
  renderable: boolean;
  reason: string | null;
  rule_version: string;
  /** 该条目不可渲染时的 GY-I08 阻断类别（可渲染时为 null）。 */
  block_code: string | null;
}

/** 选择后的**用量**段：识别路径恒不可用（硬边界，非缺数据）。 */
export interface LinkageDoseSection {
  /** **恒 false**：禁止经识别/选择绕过 GY-I08 守卫取得用量。 */
  renderable: false;
  /** **恒 null**：不下发任何剂量载荷。 */
  card: null;
  /** 恒定阻断类别（闭集成员）。 */
  block_code: string;
  /** 阻断的路径依据（便于证据页与页面文案定位）。 */
  blocked_by_path: 'recognition_selection';
  /** 条件缺项（空数组 = 条件完整；即使完整也仍被路径硬边界阻断）。 */
  missing_conditions: DoseConditionField[];
  /** 条件完整且经 GY-I08 判定「本可渲染」的条目数（**用于如实说明**，不是放行）。 */
  conditionally_renderable_count: number;
  /** 逐条候选资料的 `doseCardDescriptor` 判定。 */
  per_item: LinkageDoseItemVerdict[];
  /** 与 GY-I08 一致的规则版本。 */
  rule_version: string;
}

/** 选择后关联的完整结果（域内结构；落库到选择记录，不进契约封套）。 */
export interface SelectionLinkage {
  species_id: string;
  /** 与 GY-I08 消费端同一规则版本。 */
  rule_version: string;
  /** 有条件匹配结果时 available；无有效资料时 unavailable（不假装有资料）。 */
  reference_state: 'available' | 'unavailable';
  /** 只含**有效、可访问、非模拟**的资料。 */
  items: LinkageItem[];
  /** 被排除的资料及**如实原因**。 */
  excluded: LinkageExcluded[];
  /** 适用的条目数（= items 中 applicable 的数量）。 */
  applicable_count: number;
  /** 条件是否完整。 */
  conditions_complete: boolean;
  missing_conditions: DoseConditionField[];
  /** 全量 GY-I08 阻断类别（条目级 ∪ 路径级），闭集成员，去重有序。 */
  blocked_codes: string[];
  dose: LinkageDoseSection;
  /** 面向用户的如实说明（不作绝对承诺）。 */
  note: string;
}

/** 逐条资料取用端口（**只读**；域库或测试替身）。 */
export interface ReferenceLinkagePort {
  readonly kind: string;
  readonly note: string;
  /** 按已选品种取候选资料条目（**内部**形状；可为同步或异步）。 */
  itemsForSpecies(speciesId: string): Promise<readonly ReferenceRecordLike[]> | readonly ReferenceRecordLike[];
}

export interface ResolveSelectionLinkageInput {
  speciesId: string;
  conditions?: SelectionConditions | null;
  records: readonly ReferenceRecordLike[];
  /** 是否启用用量卡功能开关（关闭时条目级判定也如实为「功能关闭」）。 */
  doseCardEnabled?: boolean;
}

/**
 * 解析「选择后关联科普与条件」。
 *
 * 步骤（顺序即安全性，不得重排）：
 *   1. 条件完整性与缺项**先**算出来（缺项要如实带出，不能被后面的过滤吃掉）；
 *   2. 逐条按域库 `evaluateEligibility(item, {includeSimulated:false})` 过滤：
 *      **有效 + 可访问 + 非模拟**，不合格者进 `excluded` 并**带原因**；
 *   3. 合格条目做 GY-I08 适用判定（`evaluateApplicability`），带出阻断类别；
 *   4. 用量段恒不可用：逐条跑 `doseCardDescriptor()` 并**断言规则版本一致**，
 *      但整段 `renderable` 恒为 false、`card` 恒为 null（禁止经识别绕过）。
 *
 * 任何一步都不产出候选、分数或剂量数字。
 */
export function resolveSelectionLinkage(input: ResolveSelectionLinkageInput): SelectionLinkage {
  const speciesId = text(input.speciesId);
  const conditions: SelectionConditions = { species_id: speciesId, ...(input.conditions ?? {}) };
  const context = conditionContext(conditions);
  const missing = missingDoseConditions(conditions);
  const conditionsComplete = missing.length === 0;

  const items: LinkageItem[] = [];
  const excluded: LinkageExcluded[] = [];
  const perItem: LinkageDoseItemVerdict[] = [];
  const blockedCodes = new Set<string>();
  let conditionallyRenderable = 0;

  for (const record of input.records) {
    const recordId = text(record.record_id);
    // 1) 有效 / 可访问 / 非模拟：判据取自 GY-I08 域库，不在此重写。
    const eligible = evaluateEligibility(record, { includeSimulated: false }) as {
      queryable: boolean;
      reason: string | null;
    };
    if (!eligible.queryable) {
      excluded.push({ record_id: recordId, reason: eligible.reason ?? '不可访问' });
      continue;
    }
    if (isSimulatedSource(record)) {
      // 双保险：域库判定已含模拟来源；此处显式再判一次，避免上游放松后静默放行。
      excluded.push({ record_id: recordId, reason: '模拟来源（非真实资料）' });
      continue;
    }

    const item = toLinkageItem(record, context);
    items.push(item);
    for (const code of item.blocked_codes) blockedCodes.add(code);

    // 2) 用量段：必须经 GY-I08 的 `doseCardDescriptor()`，且规则版本必须一致。
    const descriptor = doseCardDescriptor(record, {
      doseCardEnabled: input.doseCardEnabled !== false,
      context,
    }) as { renderable: boolean; reason: string | null; rule_version: string };
    if (descriptor.rule_version !== LINKAGE_RULE_VERSION) {
      // 规则版本漂移：**立即**失败，绝不静默按旧/新规则之一继续。
      throw new Error(
        `GY-I08 规则版本漂移：资料层 ${descriptor.rule_version} ≠ 本层 ${LINKAGE_RULE_VERSION}`,
      );
    }
    if (descriptor.renderable) conditionallyRenderable += 1;
    perItem.push({
      record_id: item.record_id,
      renderable: descriptor.renderable,
      reason: descriptor.reason ?? null,
      rule_version: descriptor.rule_version,
      block_code: descriptor.renderable ? null : DOSE_PATH_BLOCK_CODE,
    });
  }

  // 路径级恒定阻断：识别/选择面本身没有经授权的用量来源。
  blockedCodes.add(DOSE_PATH_BLOCK_CODE);
  if (!conditionsComplete) blockedCodes.add(BLOCK_CODES.MISSING_CONDITION);

  const dose: LinkageDoseSection = {
    renderable: false,
    card: null,
    block_code: DOSE_PATH_BLOCK_CODE,
    blocked_by_path: 'recognition_selection',
    missing_conditions: missing,
    conditionally_renderable_count: conditionallyRenderable,
    per_item: perItem,
    rule_version: LINKAGE_RULE_VERSION,
  };

  return {
    species_id: speciesId,
    rule_version: LINKAGE_RULE_VERSION,
    reference_state: items.length === 0 ? 'unavailable' : 'available',
    items,
    excluded,
    applicable_count: items.filter((item) => item.applicable).length,
    conditions_complete: conditionsComplete,
    missing_conditions: missing,
    blocked_codes: [...blockedCodes].sort(),
    dose,
    note:
      '资料仅取有效、可访问、非模拟来源；具体用量必须经 GY-I08 授权消费面，' +
      '识别/选择这条路径不提供任何用量。条件不完整时不得查询用量。',
  };
}

/**
 * 默认端口：读**已合入**的 `packages/reference` 真实记录集（公告附表），
 * 按已选品种经**品种目录**（`group_name` / `canonical_name` / `aliases`）匹配记录的
 * `target_original`（防治对象）—— 这是域库真实存在的关联依据，**不猜、不模糊扩展**。
 *
 * 匹配口径（双向包含，逐条可复现）：
 *   品种名（组名/学名/别名，任一个）与 `target_original` 互相包含即命中。
 *   例如品种 `species_barnyardgrass`（组名「稗草」）命中 `target_original="稗草"` 的记录。
 * 未命中的品种**如实返回空集合**（`reference_state` 随后为 `unavailable`），不伪造资料。
 *
 * 装载失败时**抛错**（由调用方如实降级为「未取得」），**不**静默返回空集合冒充「无资料」。
 */
export function createReferenceLinkagePort(options: { requireVerified?: boolean } = {}): ReferenceLinkagePort {
  // `real` 执行模式沿用仓库既有口径：只把**已核对**条目并入查询面
  // （`catalog_read.current_knowledge` 即「已核对 + 已发布」）。
  // 非 real（本地联调/演示）可并入**已发布但未核对**的真实公告附表记录，
  // 且逐条如实带出 `review_status`，页面必须据此标注「待核实」。
  const requireVerified = options.requireVerified === true;
  let records: readonly ReferenceRecordLike[] | null = null;
  let speciesNames: ReadonlyMap<string, readonly string[]> | null = null;

  function load(): readonly ReferenceRecordLike[] {
    if (records === null) {
      records = (loadHerbicideRecords() as { items: readonly ReferenceRecordLike[] }).items;
    }
    return records;
  }

  /** 品种 id → 可用于匹配的**全部**名称（组名 / 学名 / 别名；去空、去重、小写）。 */
  function namesFor(speciesId: string): readonly string[] {
    if (speciesNames === null) {
      const catalog = loadCatalog() as {
        species: readonly { id?: unknown; group_name?: unknown; canonical_name?: unknown; aliases?: unknown }[];
      };
      const index = new Map<string, readonly string[]>();
      for (const entry of catalog.species) {
        const id = text(entry.id);
        if (id === '') continue;
        const names = new Set<string>();
        for (const candidate of [entry.group_name, entry.canonical_name, ...(Array.isArray(entry.aliases) ? entry.aliases : [])]) {
          const name = text(candidate).toLowerCase();
          if (name !== '') names.add(name);
        }
        index.set(id, [...names]);
      }
      speciesNames = index;
    }
    return speciesNames.get(speciesId) ?? [];
  }

  return {
    kind: requireVerified ? 'reference_package_verified_only' : 'reference_package',
    note: requireVerified
      ? 'packages/reference 已合入记录中**已核对**的公开条目（real 模式口径）'
      : 'packages/reference 已合入的真实公告附表记录（已发布；未核对条目逐条标注；未采集用量，恒无用量卡）',
    itemsForSpecies(speciesId) {
      const names = namesFor(text(speciesId));
      if (names.length === 0) return [];
      return load().filter((record) => {
        if (requireVerified && text(record.verification?.review_status) !== 'verified') return false;
        const target = text(record.target_original).toLowerCase();
        if (target === '') return false;
        return names.some((name) => name.includes(target) || target.includes(name));
      });
    },
  };
}

/**
 * 关联**未取得**时的如实结果（域库装载失败、或端口未装配）。
 *
 * 用法纪律：用户的选择本身**不因关联失败而失败**（选择已写入、可重试），
 * 但记录里必须带上「关联未取得 + 原因」，**不得**用空资料冒充「查过但没有」，
 * 也**不得**因此产出任何用量。
 */
export function unavailableLinkage(speciesId: string, reason: string): SelectionLinkage {
  const base = resolveSelectionLinkage({ speciesId, conditions: null, records: [] });
  return { ...base, note: `${base.note}（关联未取得：${reason}）` };
}

/**
 * 无资料端口（`real` 模式或未装配时的**如实**兜底）：
 * 恒返回空集合且 `kind` 明确标为未装配 —— 调用方据此得到 `reference_state='unavailable'`，
 * **不会**因为「没接线」而假装查到了资料。
 */
export function createUnavailableLinkagePort(reason: string): ReferenceLinkagePort {
  return {
    kind: 'unavailable',
    note: reason,
    itemsForSpecies: () => [],
  };
}
