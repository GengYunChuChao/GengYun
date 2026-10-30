/**
 * GY-R71 · 「标签原文用量 / 可执行建议」的**只读出口**（issue #8 的核心缺口）。
 *
 * 职责边界（与 `services/api/src/knowledge/applicability-screen.ts` 同层同级，**不重写判定**）：
 *   1. **判定不在这里**：九道门的判据在 `packages/reference/labels.mjs` 的
 *      `doseCardDescriptor`，外层 `executable === true` 的与门在
 *      `packages/reference/deterministic.mjs` 的 `evaluateDoseBoundary`
 *      （`cardAllowed = advice.executable === true && card.renderable === true`）。
 *      本文件**只消费**这两个出口的结论（`executable` / `renderable` / `dose_count` /
 *      `dose_card.renderable` / `dose_card.reason` / `block_codes`），不另立第二套闸门。
 *   2. **只有全过才出现**：条目录入 `dose_cards` 的必要条件是 `isEmittable(...)` 为真 ——
 *      外层可执行门与九道门的四个信号**同时**成立。任一不成立即进 `rejections`，
 *      并给出**可判定原因**（哪一道门没过 + 域库原话）。
 *   3. **不过门不许静默**：`dose_cards` 为空时，`empty` 为真且 `empty_reason` **必须**是
 *      非空字符串。空数组永远伴随逐条拒绝记录与逐门计数，绝不把「没有任何合规数据」
 *      表达成「看起来没有用量」。
 *   4. **不编造、不换算**：卡片里的 `number` / `unit` / `condition` / `reference` 逐字取自
 *      域库判定通过的原文；本文件**没有**任何乘除、配比、亩/公顷折算或混配组合逻辑
 *      （仓规：原文用量绑定登记制剂和条件，不生成处方混配换算）。
 *   5. **零外呼**：数据只来自仓内 `packages/knowledge/herbicides/records-2026.json`
 *      （经 `loadHerbicideRecords()` 投影），无网络、无数据库、无模型调用。
 *
 * 为什么不改 `GET /knowledge` 的 `dose_cards` / `conditions`：那两个字段在冻结契约
 * （`packages/contracts/openapi.json` 的 `Knowledge`）里已经是 `DoseCard[]` / `Conditions|null`，
 * 语义与下发时点都被既有消费者与证据页钉住。本片**新增**一条只读路由承载这份数据，
 * 影响面最小：既有两条读面的行为逐字节不变。
 */

import {
  APPLICABILITY_RULE_VERSION,
  DISPLAY_LABELS,
  evaluateDoseBoundary,
  loadHerbicideRecords,
  ruleVersionDigest,
} from '../../../../packages/reference/index.mjs';

/**
 * 九道门 + 外层可执行门的**稳定 id**。
 *
 * 编号（`index`）逐条对应 `packages/reference/labels.mjs` 的 `doseCardDescriptor` 文档注释
 * 第 1–9 条；外层门不是第 10 条判据，而是 `evaluateDoseBoundary` 的与门，故 `index` 记 0。
 */
export const DOSE_GATE_ID = Object.freeze({
  /** 门 1：功能开关 `doseCardEnabled=false` ⇒ 一律不渲染。 */
  FEATURE_SWITCH: 'feature_switch',
  /** 门 2：`verification.usable_as_dose !== true` ⇒ 未采集可用作依据的用量字段。 */
  USABLE_AS_DOSE: 'dose_usable_as_dose',
  /** 门 3：缺原文可绑定条件 `dose.condition` ⇒ 拒绝。 */
  ORIGINAL_CONDITION: 'dose_original_condition',
  /** 门 4：缺可绑定数字用量 `dose.number` / `dose.unit` ⇒ 拒绝。 */
  NUMBER_UNIT: 'dose_number_unit',
  /** 门 5：`evaluateApplicability` 当前适用判定不通过 ⇒ 拒绝。 */
  APPLICABILITY: 'applicability',
  /** 门 6：记录级与来源级 `review_status` 都必须是 `verified`。 */
  REVIEW_VERIFIED: 'review_verified',
  /** 门 7：`dose.source_version` 必须等于记录当前 `source_version`。 */
  SOURCE_VERSION: 'dose_source_version',
  /** 门 8：登记制剂身份完整且与用量绑定一致。 */
  FORMULATION_BINDING: 'formulation_binding',
  /** 门 9：非模拟来源（标志位 / 来源类型 / `SIM-` 前缀任一成立即拒绝）。 */
  NOT_SIMULATED: 'not_simulated',
  /** 外层门：`evaluateExecutableAdvice(...).executable === true`。 */
  EXECUTABLE_ADVICE: 'executable_advice',
  /** 兜底：域库给了拒绝结论却没给出可映射的原因码（**永不**应当出现；出现即暴露口径漂移）。 */
  UNATTRIBUTED: 'unattributed_dose_gate',
} as const);

export type DoseGateId = (typeof DOSE_GATE_ID)[keyof typeof DOSE_GATE_ID];

/** 门清单的一行（对外下发，供消费方按同一次序展示与核对）。 */
export interface DoseGateLedgerEntry {
  readonly id: DoseGateId;
  readonly index: number;
  readonly label: string;
  readonly rule_ref: string;
}

/**
 * 门清单（**单一来源**：与 `labels.mjs` 的文档注释编号逐条对应）。
 *
 * `rule_ref` 只写 `文件#符号`，不写行号 —— 行号会漂，锚点纪律禁止裸 `:NNN`。
 */
export const DOSE_GATE_LEDGER: readonly DoseGateLedgerEntry[] = Object.freeze([
  Object.freeze({ id: DOSE_GATE_ID.FEATURE_SWITCH, index: 1, label: '功能开关未关闭用量卡', rule_ref: 'packages/reference/labels.mjs#doseCardDescriptor' }),
  Object.freeze({ id: DOSE_GATE_ID.USABLE_AS_DOSE, index: 2, label: '已采集可用作依据的用量字段', rule_ref: 'packages/reference/labels.mjs#doseCardDescriptor' }),
  Object.freeze({ id: DOSE_GATE_ID.ORIGINAL_CONDITION, index: 3, label: '有原文可绑定条件', rule_ref: 'packages/reference/labels.mjs#doseCardDescriptor' }),
  Object.freeze({ id: DOSE_GATE_ID.NUMBER_UNIT, index: 4, label: '有可绑定数字用量与单位', rule_ref: 'packages/reference/labels.mjs#doseCardDescriptor' }),
  Object.freeze({ id: DOSE_GATE_ID.APPLICABILITY, index: 5, label: '当前适用判定通过', rule_ref: 'packages/reference/query.mjs#evaluateApplicability' }),
  Object.freeze({ id: DOSE_GATE_ID.REVIEW_VERIFIED, index: 6, label: '记录级与来源级均已核对', rule_ref: 'packages/reference/labels.mjs#isDoseReviewed' }),
  Object.freeze({ id: DOSE_GATE_ID.SOURCE_VERSION, index: 7, label: '用量绑定当前来源版本', rule_ref: 'packages/reference/labels.mjs#isDoseBoundToCurrentSource' }),
  Object.freeze({ id: DOSE_GATE_ID.FORMULATION_BINDING, index: 8, label: '登记制剂身份完整且与用量绑定一致', rule_ref: 'packages/reference/labels.mjs#hasBoundFormulation' }),
  Object.freeze({ id: DOSE_GATE_ID.NOT_SIMULATED, index: 9, label: '非模拟来源', rule_ref: 'packages/reference/query.mjs#isSimulatedSource' }),
  Object.freeze({ id: DOSE_GATE_ID.EXECUTABLE_ADVICE, index: 0, label: '外层：可执行建议判定为真', rule_ref: 'packages/reference/deterministic.mjs#evaluateDoseBoundary' }),
]);

/** 域库拒绝原因 → 门 id。`not_usable` 的歧义由 `gateOfNotUsable` 用存在性判定收窄（见下）。 */
const REASON_GATE: Readonly<Record<string, DoseGateId>> = Object.freeze({
  [DISPLAY_LABELS.dose_reject_reason.closed]: DOSE_GATE_ID.FEATURE_SWITCH,
  [DISPLAY_LABELS.dose_reject_reason.missing_condition]: DOSE_GATE_ID.ORIGINAL_CONDITION,
  [DISPLAY_LABELS.dose_reject_reason.simulated_source]: DOSE_GATE_ID.NOT_SIMULATED,
  [DISPLAY_LABELS.dose_reject_reason.not_reviewed]: DOSE_GATE_ID.REVIEW_VERIFIED,
  [DISPLAY_LABELS.dose_reject_reason.incomplete_formulation]: DOSE_GATE_ID.FORMULATION_BINDING,
  [DISPLAY_LABELS.dose_reject_reason.dose_record_mismatch]: DOSE_GATE_ID.FORMULATION_BINDING,
  [DISPLAY_LABELS.dose_reject_reason.dose_formulation_mismatch]: DOSE_GATE_ID.FORMULATION_BINDING,
  [DISPLAY_LABELS.dose_reject_reason.dose_reference_missing]: DOSE_GATE_ID.FORMULATION_BINDING,
  [DISPLAY_LABELS.dose_reject_reason.stale_dose]: DOSE_GATE_ID.SOURCE_VERSION,
  [DISPLAY_LABELS.dose_reject_reason.restriction_unknown]: DOSE_GATE_ID.APPLICABILITY,
  [DISPLAY_LABELS.dose_reject_reason.restricted]: DOSE_GATE_ID.APPLICABILITY,
  [DISPLAY_LABELS.dose_reject_reason.banned]: DOSE_GATE_ID.APPLICABILITY,
  [DISPLAY_LABELS.dose_reject_reason.invalid_source]: DOSE_GATE_ID.APPLICABILITY,
  [DISPLAY_LABELS.dose_reject_reason.not_applicable]: DOSE_GATE_ID.APPLICABILITY,
  [DISPLAY_LABELS.dose_reject_reason.no_confirmed_context]: DOSE_GATE_ID.APPLICABILITY,
});

/**
 * 门映射的**总覆盖自检**。
 *
 * `labels.mjs` 可以新增一个拒绝原因，而本文件的映射表不会自动跟上 —— 那时若不报错，
 * 新原因的记录会被静默归到 `unattributed_dose_gate`（口径漂移但没人发现）。本函数由
 * `tests/unit/knowledge-dose-cards-http.test.mjs` 逐值断言，域库新增原因即判红。
 */
export function assertDoseGateMappingComplete(): { covered: number; reasons: readonly string[] } {
  const text = DISPLAY_LABELS.dose_reject_reason;
  const reasons = Object.values(text);
  const missing = reasons.filter((reason) => reason !== text.not_usable && !(reason in REASON_GATE));
  if (missing.length > 0) throw new Error(`拒绝原因缺少门映射：${missing.join(' / ')}`);
  const ledgerMissing = (Object.values(DOSE_GATE_ID) as string[]).filter(
    (id) => !DOSE_GATE_LEDGER.some((entry) => entry.id === id) && id !== DOSE_GATE_ID.UNATTRIBUTED,
  );
  if (ledgerMissing.length > 0) throw new Error(`门 id 未进清单：${ledgerMissing.join(' / ')}`);
  return { covered: reasons.length, reasons };
}

/** 一条用量卡（**只**含九道门已经保证过的字段；没有保证的一律显式 null，不补写）。 */
export interface DoseCardReadout {
  readonly provenance: {
    readonly record_id: string;
    readonly registration_number: string;
    readonly registered_name: string;
    readonly dosage_form: string;
    readonly ingredients_text: string;
    readonly source_version: string;
    readonly source_review_status: string;
    /** 以下五项**不在**九道门的保证范围内：取不到就是 `null`，绝不补造。 */
    readonly source_id: string | null;
    readonly source_url: string | null;
    readonly source_kind: string | null;
    readonly evidence_kind: string | null;
    readonly validity: string | null;
  };
  readonly conditions: {
    readonly original_condition: string;
    readonly crop_ids: readonly string[];
    readonly region_code: string | null;
    readonly species_id: string | null;
    readonly growth_stage: string | null;
    readonly planting_method: string | null;
    readonly use_scene: string | null;
    readonly not_collected: readonly string[];
  };
  readonly dose: {
    readonly number: string;
    readonly unit: string;
    readonly condition: string;
    readonly reference: string;
  };
  readonly rule_version: string;
  readonly executable: true;
  readonly renderable: true;
  readonly dose_count: 1;
}

/** 一条未过门的记录（**可判定原因**：哪道门 + 域库原话 + 域库阻断类别）。 */
export interface DoseCardRejection {
  readonly record_id: string | null;
  readonly registration_number: string | null;
  readonly failed_gate: DoseGateId;
  readonly reason: string;
  readonly executable: boolean;
  readonly renderable: false;
  readonly block_codes: readonly string[];
}

export interface DoseGateTally {
  readonly gate: DoseGateId;
  readonly count: number;
}

export interface DoseBlockCodeTally {
  readonly code: string;
  readonly count: number;
}

/** 只读出口的响应主体（契约 `DoseCardReadout`）。 */
export interface DoseCardReadoutPage {
  readonly rule_version: string;
  readonly rule_spec_digest: string;
  readonly evaluated_source: string;
  readonly evaluated: number;
  readonly dose_cards: readonly DoseCardReadout[];
  readonly rejections: readonly DoseCardRejection[];
  readonly first_failed_gates: readonly DoseGateTally[];
  readonly block_codes: readonly DoseBlockCodeTally[];
  readonly gate_ledger: readonly DoseGateLedgerEntry[];
  readonly empty: boolean;
  readonly empty_reason: string | null;
  readonly note: string;
}

/** 判定入参（**开关必须能被显式注入**：运维 kill switch 与测试替身走同一条路）。 */
export interface DoseCardReadoutOptions {
  readonly executableEnabled?: boolean;
  readonly doseCardEnabled?: boolean;
  readonly context?: Record<string, unknown>;
  /** 候选记录来源（默认仓内公开登记公告记录；测试注入同构条目做逐门负例）。 */
  readonly items?: readonly DoseCardCandidate[];
}

/** 判定只读的字段子集（不假定运行期对象的其它内部字段可对外下发）。 */
export interface DoseCardCandidate {
  readonly record_id?: unknown;
  readonly registration_number?: unknown;
  readonly registered_name?: unknown;
  readonly dosage_form?: unknown;
  readonly ingredients_text?: unknown;
  readonly source_version?: unknown;
  readonly source?: Record<string, unknown>;
  readonly verification?: Record<string, unknown>;
  readonly crop_ids?: readonly string[];
  readonly growth_stage?: unknown;
  readonly planting_method?: unknown;
  readonly use_scene?: unknown;
}

/** 只读出口的候选来源（写在响应里，供核对「这些数字是从哪批数据算出来的」）。 */
export const DOSE_CARD_EVALUATED_SOURCE =
  'packages/knowledge/herbicides/records-2026.json（仓内公开登记公告记录投影，经 loadHerbicideRecords()）';

/** 空结果时**必须**给出的原因（非空、可判定，且不暗示「没有用量」）。 */
function emptyReasonOf(page: {
  evaluated: number;
  firstFailedGates: readonly DoseGateTally[];
  blockCodes: readonly DoseBlockCodeTally[];
}): string {
  if (page.evaluated === 0) {
    return '候选集为空：本次没有任何记录进入判定，故不返回任何用量卡（不是「没有用量」，而是没有可判定的候选）。';
  }
  const gates = page.firstFailedGates.map((entry) => `${entry.gate}×${entry.count}`).join('、');
  const codes = page.blockCodes.map((entry) => `${entry.code}×${entry.count}`).join('、');
  return (
    `本次判定 ${page.evaluated} 条候选，0 条同时通过九道用量门与外层可执行门，故 dose_cards 为空。` +
    `第一道未过之门：${gates === '' ? '（无）' : gates}；` +
    `域库阻断类别：${codes === '' ? '（无）' : codes}。` +
    '逐条原因见 rejections —— 空数组不等于「该记录没有用量」，而是「该记录不满足下发条件」。'
  );
}

/** 非空字符串归一（只做 trim，不改写内容）。 */
function textOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : value;
}

/**
 * `not_usable` 的门归属。
 *
 * 域库对**两道不同**的门复用同一个原因码（`labels.mjs` 的步骤 2 与步骤 3+4 都返回
 * `dose_reject_reason.not_usable`），因此仅凭原因串无法分辨是哪一道。这里**只读**域库
 * 同样读的那两个字段做归属，不重做判定：
 *   - `verification.usable_as_dose !== true` ⇒ 门 2；
 *   - 否则即数字/单位缺项 ⇒ 门 4。
 * 是否放行**与本次归属无关**（放行只看 `isEmittable`），归属只影响原因里的门名。
 */
function gateOfNotUsable(item: DoseCardCandidate): DoseGateId {
  const verification = item.verification ?? {};
  if (verification['usable_as_dose'] !== true) return DOSE_GATE_ID.USABLE_AS_DOSE;
  return DOSE_GATE_ID.NUMBER_UNIT;
}

/** 由域库拒绝原因判定「哪道门没过」。 */
function gateOfReason(item: DoseCardCandidate, reason: string): DoseGateId {
  if (reason === DISPLAY_LABELS.dose_reject_reason.not_usable) return gateOfNotUsable(item);
  return REASON_GATE[reason] ?? DOSE_GATE_ID.UNATTRIBUTED;
}

/**
 * **放行的唯一判据**：外层可执行门与九道门的四个信号同时成立。
 *
 * 这四项在 `evaluateDoseBoundary` 内部是同一个 `cardAllowed`
 * （`deterministic.mjs`：`cardAllowed = advice.executable === true && card.renderable === true`，
 * `renderable` 与 `dose_count` 都由它派生），这里**逐项列出**而不是只读一个布尔，
 * 是因为本出口对外的承诺是「九道门 **且** executable===true」，任何一项被单独拿掉
 * 都属于越门放行；`tests/unit/knowledge-dose-cards-http.test.mjs` 的负控制 ①④ 就打在
 * 这两个位置上。
 */
export function isEmittable(boundary: {
  executable: boolean;
  renderable: boolean;
  dose_count: number;
  dose_card: Record<string, unknown>;
  advice: { executable: boolean };
}): boolean {
  const card = boundary.dose_card;
  return (
    boundary.executable === true
    && boundary.advice.executable === true
    && boundary.renderable === true
    && card['renderable'] === true
    && boundary.dose_count === 1
  );
}

/** 组装一张卡（字段逐字取自域库判定通过的原文；缺什么就显式 null，不补写）。 */
function buildCard(item: DoseCardCandidate, ruleVersion: string): DoseCardReadout {
  const verification = item.verification ?? {};
  const source = item.source ?? {};
  const dose = (verification['dose'] ?? {}) as Record<string, unknown>;
  const cropIds = Array.isArray(item.crop_ids) ? item.crop_ids.filter((id): id is string => typeof id === 'string') : [];
  const regionCode = textOf(source['region_code']);
  const speciesId = textOf(source['species_id']);
  const growthStage = textOf(item.growth_stage);
  const plantingMethod = textOf(item.planting_method);
  const useScene = textOf(item.use_scene);
  const notCollected: string[] = [];
  if (regionCode === null) notCollected.push('region_code');
  if (speciesId === null) notCollected.push('species_id');
  if (growthStage === null) notCollected.push('growth_stage');
  if (plantingMethod === null) notCollected.push('planting_method');
  if (useScene === null) notCollected.push('use_scene');
  return {
    provenance: {
      record_id: String(item.record_id ?? ''),
      registration_number: String(item.registration_number ?? ''),
      registered_name: String(item.registered_name ?? ''),
      dosage_form: String(item.dosage_form ?? ''),
      ingredients_text: String(item.ingredients_text ?? ''),
      source_version: String(item.source_version ?? ''),
      source_review_status: String(source['review_status'] ?? ''),
      source_id: textOf(source['source_id']),
      source_url: textOf(source['url'] ?? source['original_url']),
      source_kind: textOf(source['source_kind']),
      evidence_kind: textOf(source['evidence_kind']),
      validity: textOf(source['source_validity'] ?? source['validity']),
    },
    conditions: {
      original_condition: String(dose['condition'] ?? ''),
      crop_ids: cropIds,
      region_code: regionCode,
      species_id: speciesId,
      growth_stage: growthStage,
      planting_method: plantingMethod,
      use_scene: useScene,
      not_collected: notCollected,
    },
    dose: {
      number: String(dose['number'] ?? ''),
      unit: String(dose['unit'] ?? ''),
      condition: String(dose['condition'] ?? ''),
      reference: String(dose['reference'] ?? ''),
    },
    rule_version: ruleVersion,
    executable: true,
    renderable: true,
    dose_count: 1,
  };
}

/**
 * 只读出口的唯一入口：把候选逐条过「九道门 + 外层 executable 门」，只留下全过的条目。
 *
 * @remarks 该函数是**纯函数**：不读环境、不读盘（除默认候选来源一次装载）、不联网、不写库。
 */
export function readDoseCards(options: DoseCardReadoutOptions = {}): DoseCardReadoutPage {
  const items: readonly DoseCardCandidate[] = options.items ?? loadHerbicideRecords().items;
  const context = options.context ?? {};
  // 开关**显式向下传**：不传时域库自行读环境变量（同一组 `APP_GY_I08_*`），
  // 显式传时运维 kill switch 与测试替身走同一条路。⛔ 不要在这里丢掉这两个字段 ——
  // 丢掉等于把外层可执行门短路（见负控制 ①）。
  const domainOptions: Record<string, unknown> = {
    executableEnabled: options.executableEnabled,
    doseCardEnabled: options.doseCardEnabled,
  };

  const cards: DoseCardReadout[] = [];
  const rejections: DoseCardRejection[] = [];
  const gateTally = new Map<DoseGateId, number>();
  const codeTally = new Map<string, number>();
  let ruleVersion = APPLICABILITY_RULE_VERSION;

  for (const item of items) {
    const boundary = evaluateDoseBoundary(item, context, domainOptions);
    ruleVersion = boundary.rule_version === '' ? ruleVersion : boundary.rule_version;
    if (isEmittable(boundary)) {
      cards.push(buildCard(item, boundary.rule_version));
      continue;
    }
    const card = boundary.dose_card;
    const rawReason = typeof card['reason'] === 'string' ? card['reason'] : '';
    const gate = rawReason === '' ? DOSE_GATE_ID.UNATTRIBUTED : gateOfReason(item, rawReason);
    gateTally.set(gate, (gateTally.get(gate) ?? 0) + 1);
    for (const code of boundary.block_codes) {
      codeTally.set(code, (codeTally.get(code) ?? 0) + 1);
    }
    rejections.push({
      record_id: textOf(item.record_id),
      registration_number: textOf(item.registration_number),
      failed_gate: gate,
      reason: rawReason === '' ? '域库未给出拒绝原因（已按不可用处理）' : rawReason,
      executable: boundary.executable === true,
      renderable: false,
      block_codes: [...boundary.block_codes],
    });
  }

  const firstFailedGates: DoseGateTally[] = DOSE_GATE_LEDGER
    .filter((entry) => gateTally.has(entry.id))
    .map((entry) => ({ gate: entry.id, count: gateTally.get(entry.id) ?? 0 }));
  // 兜底门（不在清单里）也要如实计数，不许丢。
  if (gateTally.has(DOSE_GATE_ID.UNATTRIBUTED)) {
    firstFailedGates.push({ gate: DOSE_GATE_ID.UNATTRIBUTED, count: gateTally.get(DOSE_GATE_ID.UNATTRIBUTED) ?? 0 });
  }
  const blockCodes = [...codeTally.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  const empty = cards.length === 0;
  return {
    rule_version: ruleVersion,
    rule_spec_digest: ruleVersionDigest(),
    evaluated_source: options.items === undefined ? DOSE_CARD_EVALUATED_SOURCE : '调用方注入的候选集（仅测试替身）',
    evaluated: items.length,
    dose_cards: cards,
    rejections,
    first_failed_gates: firstFailedGates,
    block_codes: blockCodes,
    gate_ledger: DOSE_GATE_LEDGER,
    empty,
    // ⛔ 空结果必须带原因：这里恒给出非空字符串（负控制 ③ 打的就是这个位置）。
    empty_reason: empty
      ? emptyReasonOf({ evaluated: items.length, firstFailedGates, blockCodes })
      : null,
    note:
      'dose_cards 每一条都同时通过了 packages/reference/labels.mjs#doseCardDescriptor 的九道门与'
      + ' evaluateDoseBoundary 的外层 executable 门；number/unit/condition/reference 逐字来自原文，'
      + '本出口不做任何处方混配或用量换算。conditions 里为 null 的维度是「未采集」，不是「不适用」。',
  };
}
