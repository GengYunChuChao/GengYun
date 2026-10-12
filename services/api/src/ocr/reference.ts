/**
 * GY-I10 登记核对与用量卡来源端口（登记库 / 适用性资料）。
 *
 * 契约对齐（packages/contracts/openapi.json，未新增字段）：
 *   Herbicide   = { id, revision, formulation, source, risk_text, reference_state }
 *   Formulation = { id, registration_number, producer, dosage_form, ingredients (1..20) }
 *   DoseCard    = { id, revision, formulation, conditions(DoseConditions, 六项全必填),
 *                   original_text, unit_text, method_text, precautions_text, source(DoseSource),
 *                   locator, content_hash }
 *   DoseSource  = source_kind ∈ {database, verified_seed}（**不含 simulation**）、
 *                 validity const "valid"、review_status const "verified"
 *
 * 现状（如实记录，须写入证据文档与 PR 正文）：
 * - 真实登记库接入属后续任务；本片**不接数据库**，因此 `real` 模式下登记来源未接线 →
 *   **fail-closed**：`lookup` 一律 unavailable（→ MatchState `unavailable`），
 *   **绝不**用 `no_match` 掩盖「不可用」，也**绝不**回退替身登记资料。
 * - `stub` / `preset_demo` 模式使用**明确标注的替身合成登记资料**：合成登记号、合成产品名、
 *   合成生产企业，并在每条资料的 title/publisher/文本中显式带「替身合成示例（非真实登记资料）」标记。
 *   替身**只用于核对链路**（MatchState 的构造与观测），**不提供任何用量**。
 *
 * 用量卡（`dose_cards`）的生产口径见本文件末节：
 * **替身与未接线一律恒返回空** —— 严格执行 GY-I07 验收第 3 条
 * 「不授 AI／用户经验专家认证标签，**不对模拟记录显示真实用量**」。
 * 因此「用量原文必须绑定登记制剂 + 条件」这条约束在本片由两处共同保证：
 * `DoseCardCandidate` 同时携带 `formulation_registration_number` 与六项 `conditions`（结构约束），
 * 以及 `state.ts` 的 `decideDoseCard` 逐项比对后才可能进入 `dose_cards`（判定约束）。
 */
import {
  type DoseCardCandidate,
  type RegistryHerbicide,
  type RegistryLookup,
} from './state.ts';

/** 替身合成资料的显式标记（出现在 title / publisher / 文本中，便于在任何界面识别）。 */
export const SUBSTITUTE_MARK = '替身合成示例（非真实登记资料）';

const SUBSTITUTE_SOURCE = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  version: 'substitute-1',
  title: `${SUBSTITUTE_MARK}·登记资料`,
  url: 'https://example.invalid/substitute/registration',
  publisher: `${SUBSTITUTE_MARK}·本地替身登记库`,
  source_kind: 'database',
  evidence_kind: 'mixed',
  validity: 'valid',
  review_status: 'unverified',
  updated_at: '2026-01-01T00:00:00.000Z',
} as const;

function substituteHerbicide(input: {
  id: string;
  registrationNumber: string;
  dosageForm: string;
  ingredient: { name: string; contentText: string; unitText: string };
}): RegistryHerbicide {
  return {
    id: input.id,
    revision: 1,
    formulation: {
      id: input.id,
      registration_number: input.registrationNumber,
      producer: `${SUBSTITUTE_MARK}·合成生产企业`,
      dosage_form: input.dosageForm,
      ingredients: [
        { name: input.ingredient.name, content_text: input.ingredient.contentText, unit_text: input.ingredient.unitText },
      ],
    },
    source: { ...SUBSTITUTE_SOURCE },
    risk_text: `${SUBSTITUTE_MARK}·合成风险说明，仅用于离线链路回归，不构成任何真实风险或安全结论。`,
    reference_state: 'available',
  };
}

/**
 * 替身合成登记资料（**非真实登记库**）。刻意设计为可逐一构造 6 类 MatchState：
 * - `PD20210001`（水剂 / 草甘膦 41%）→ 字段一致时判 matched，剂型不一致时判 conflict
 * - `PD20210002`（乳油 / 乙草胺 50%）→ 第二条独立记录（用于验证按登记号收敛不会误配）
 * - `PD20210003` / `PD20210004` 共享产品名「替身示例复配歧义剂」→ 靠名称命中两条 → ambiguous
 * - 不存在的 `PD20210005` / `PD99999999` → 与名称索引配合用于 ambiguous / no_match
 */
export const SUBSTITUTE_REGISTRY: readonly RegistryHerbicide[] = [
  substituteHerbicide({
    id: '11111111-1111-4111-8111-111111111111',
    registrationNumber: 'PD20210001',
    dosageForm: '水剂',
    ingredient: { name: '草甘膦', contentText: '41', unitText: '%' },
  }),
  substituteHerbicide({
    id: '22222222-2222-4222-8222-222222222222',
    registrationNumber: 'PD20210002',
    dosageForm: '乳油',
    ingredient: { name: '乙草胺', contentText: '50', unitText: '%' },
  }),
  substituteHerbicide({
    id: '33333333-3333-4333-8333-333333333333',
    registrationNumber: 'PD20210003',
    dosageForm: '悬浮剂',
    ingredient: { name: '草甘膦', contentText: '30', unitText: '%' },
  }),
  substituteHerbicide({
    id: '44444444-4444-4444-8444-444444444444',
    registrationNumber: 'PD20210004',
    dosageForm: '水分散粒剂',
    ingredient: { name: '草甘膦', contentText: '30', unitText: '%' },
  }),
];

/**
 * 产品名索引：**替身端口内部的实现细节，不是契约字段**（契约 Herbicide 没有产品名字段，
 * 该缺口在证据文档里如实记录，不做同义猜测）。
 */
export const SUBSTITUTE_NAME_INDEX: Readonly<Record<string, readonly string[]>> = {
  '替身示例草甘膦水剂': ['PD20210001'],
  '替身示例复配歧义剂': ['PD20210003', 'PD20210004'],
};

function substituteLookup(input: { registrationNumber: string | null; name: string | null }): RegistryHerbicide[] {
  const reg = input.registrationNumber;
  if (reg !== null) {
    const byRegistration = SUBSTITUTE_REGISTRY.filter(
      (item) => item.formulation.registration_number.toLowerCase() === reg.trim().toLowerCase(),
    );
    // 登记号命中即以此为准，**不再**用名称扩大候选（避免把精确命中稀释成 ambiguous）。
    if (byRegistration.length > 0) return byRegistration;
  }
  const name = input.name;
  if (name === null) return [];
  const registrationNumbers = SUBSTITUTE_NAME_INDEX[name.trim()];
  if (registrationNumbers === undefined) return [];
  return SUBSTITUTE_REGISTRY.filter((item) => registrationNumbers.includes(item.formulation.registration_number));
}

/** 登记库端口：`kind` 明确区分替身与未接线，避免「未接线」被静默当成「查不到」。 */
export interface OcrReferencePort {
  readonly kind: 'substitute' | 'unwired';
  readonly note: string;
  readonly available: boolean;
  readonly unavailableReason: string | null;
  lookup(input: { registrationNumber: string | null; name: string | null }): Promise<RegistryLookup>;
}

const SUBSTITUTE_REFERENCE_NOTE =
  '替身合成登记资料端口（stub/preset_demo）：按合成登记号精确命中，未命中再按合成产品名索引；不读取任何真实登记库。';

export function createSubstituteReferencePort(): OcrReferencePort {
  return {
    kind: 'substitute',
    note: SUBSTITUTE_REFERENCE_NOTE,
    available: true,
    unavailableReason: null,
    async lookup(input) {
      return { status: 'available', candidates: substituteLookup(input) };
    },
  };
}

/**
 * 未接线登记端口（`real` 模式）。一律 unavailable → MatchState `unavailable`。
 * **不得**改成 `{status:'available', candidates: []}`：那会把「登记库不可用」伪装成「无匹配」。
 */
export function createUnwiredReferencePort(
  reason = '真实登记库尚未接线，无法核对登记资料',
): OcrReferencePort {
  return {
    kind: 'unwired',
    note: `${reason}（fail-closed：一律 unavailable，不伪装成 no_match）`,
    available: false,
    unavailableReason: reason,
    async lookup() {
      return { status: 'unavailable', reason };
    },
  };
}

/** 按执行模式选择登记端口：只有替身模式才允许替身登记资料。 */
export function createOcrReferencePort(executionMode: string): OcrReferencePort {
  return executionMode === 'real' ? createUnwiredReferencePort() : createSubstituteReferencePort();
}

// ------------------------------------------------------------------ 用量卡来源

/**
 * 用量卡端口。
 *
 * **生产口径（严格执行 GY-I07 验收第 3 条「不授专家认证标签，不对模拟记录显示真实用量」）**：
 * 替身（`stub` / `preset_demo`）与未接线（`real`）**一律不产出任何候选** ⇒ `dose_cards` 恒为 `[]`。
 * 只有**已核对的真实用量来源**才可能放行用量卡；本片尚未接入任何真实用量来源，
 * 因此**在任何执行模式下都不会产出用量卡**（如实记录，不假装具备用量能力）。
 *
 * 本文件刻意**不提供任何「替身用量卡」构造器**：若让替身产出契约合法、
 * 来源标为 `validity='valid'` / `review_status='verified'` 的卡片，即使它随后被 gate 拒绝，
 * 也等于「以模拟记录呈现真实用量」，不该出现在生产代码里。
 *
 * `state.ts` 的 `decideDoseCard` / `gateDoseCards` 完整保留且**必须被消费**
 * （适用性判定不得被跳过）；其**通过面**由 `tests/unit/ocr-*.test.mjs`
 * **注入契约合法的可信来源**来证明 —— 靠测试注入，而不是靠让生产替身输出可信卡。
 */
export interface OcrDosePort {
  readonly kind: 'substitute' | 'unwired';
  readonly note: string;
  listCandidates(input: { registrationNumber: string | null }): Promise<DoseCardCandidate[]>;
}

const SUBSTITUTE_DOSE_NOTE =
  '替身用量端口（stub/preset_demo）：**恒返回空** —— 替身不提供用量，绝不以模拟记录呈现真实用量。';

/**
 * 替身用量端口。**恒返回空数组**：替身不产出任何用量卡。
 *
 * 这不是「暂时没实现」的托词，而是验收条要求的行为：
 * 模拟来源不得呈现真实用量（#7 验收第 3 条）。因此即使本片能构造出契约合法的替代数据，
 * 也**不允许**让它成为可放行的用量卡。
 */
export function createSubstituteDosePort(): OcrDosePort {
  return {
    kind: 'substitute',
    note: SUBSTITUTE_DOSE_NOTE,
    async listCandidates() {
      return [];
    },
  };
}

/**
 * 未接线用量端口（`real`）。同样恒返回空数组：**没有已审真实用量来源就不得产出任何剂量**，
 * `dose_cards` 必须是 []，绝不回退替身用量卡。
 */
export function createUnwiredDosePort(reason = '真实用量资料来源尚未接线'): OcrDosePort {
  return {
    kind: 'unwired',
    note: `${reason}（fail-closed：恒返回空，不补造剂量、不回退替身）`,
    async listCandidates() {
      return [];
    },
  };
}

/**
 * 按执行模式选择用量端口：**两种模式都恒返回空**。
 * 也就是说，生产路径在结构上不可能产出用量卡（`dose_cards` 恒为 `[]`）；
 * 一旦接入已审真实用量来源，只需替换本工厂的 `real` 分支，gate 与判定链无需改动。
 */
export function createOcrDosePort(executionMode: string): OcrDosePort {
  return executionMode === 'real' ? createUnwiredDosePort() : createSubstituteDosePort();
}
