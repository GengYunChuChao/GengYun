/**
 * `packages/reference/**` 子模块（纯 ESM `.mjs`）的**只读**类型声明 —— 识别域自用。
 *
 * 为什么不复用 `services/api/src/knowledge/reference.d.ts`：
 *   那份声明只覆盖 `*packages/reference/index.mjs`，且属 GY-I07 已合并文件；本片按
 *   「只改自己目录、不改他人已合并实现」的纪律，**不修改**它。这里改为**逐子模块**声明
 *   （`constants.mjs` / `deterministic.mjs` / `labels.mjs` / `query.mjs` / `records.mjs`），
 *   与域库实际导出一一对应；域库改形状时 `npm run lint`（tsc --noEmit）会失败。
 *
 * 声明依据（逐条对照域库实际导出，不猜字段）：
 *   - `APPLICABILITY_RULE_VERSION`：constants.mjs（GY-I08 规则版本，唯一事实来源）
 *   - `BLOCK_CODES`：deterministic.mjs（阻断类别闭集）
 *   - `doseCardDescriptor`：labels.mjs（唯一许可的用量卡描述符）
 *   - `evaluateEligibility` / `evaluateApplicability` / `isSimulatedSource`：query.mjs
 *   - `loadHerbicideRecords`：records.mjs（真实公告附表记录装载）
 *
 * **不导入任何写操作**：本域对资料层是纯只读消费。
 */

declare module '*packages/reference/catalog.mjs' {
  /** 目录（作物 / 杂草品种 / 地区）。品种条目含 group_name / canonical_name / aliases。 */
  export function loadCatalog(): {
    crops: readonly unknown[];
    species: readonly unknown[];
    regions: readonly unknown[];
    catalogVersions?: Record<string, string>;
  };
}

declare module '*packages/reference/constants.mjs' {  /** GY-I08 规则版本（所有消费端必须同一版本）。 */
  export const APPLICABILITY_RULE_VERSION: string;
  export const CONTRACT_VERSION: string;
  export const SOURCE_KINDS: readonly string[];
  export const EVIDENCE_KINDS: readonly string[];
  export const REVIEW_STATUSES: readonly string[];
  export const VISIBILITIES: readonly string[];
  export const SOURCE_VALIDITIES: readonly string[];
  export const QUERYABLE_VALIDITIES: readonly string[];
  export const QUERYABLE_VISIBILITIES: readonly string[];
  export const SIMULATION_REGISTRATION_PREFIX: string;
  export const REGION_CODE_PATTERN: RegExp;
  export const REGISTRATION_NUMBER_PATTERN: RegExp;
}

declare module '*packages/reference/deterministic.mjs' {
  /** GY-I08 阻断类别闭集（键为类别名、值为类别码）。 */
  export const BLOCK_CODES: Readonly<{
    NO_SOURCE: string;
    SIMULATED_SOURCE: string;
    INVALID_SOURCE: string;
    AMBIGUOUS_MATCH: string;
    FIELD_CONFLICT: string;
    NO_MATCH: string;
    UNREVIEWED: string;
    BANNED: string;
    RESTRICTED: string;
    RESTRICTION_UNKNOWN: string;
    NOT_APPLICABLE: string;
    MISSING_CONDITION: string;
    NO_DOSE_SOURCE: string;
    FEATURE_CLOSED: string;
  }>;
  export const BLOCK_CODE_LIST: readonly string[];

  export function sourceBlockCode(item: unknown): string | null;
  export function restrictionBlockCode(item: unknown, context?: Record<string, unknown>): string | null;
  export function doseBlockCode(card: unknown): string | null;
  export function evaluateApplicability(
    item: unknown,
    context?: Record<string, unknown>,
    opts?: { ruleVersion?: string },
  ): { applicable: boolean; blocked: readonly string[]; reasons: readonly string[]; rule_version: string };
  export function evaluateExecutableAdvice(
    item: unknown,
    context?: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ): {
    executable: boolean;
    block_codes: readonly string[];
    reasons: readonly string[];
    rule_version: string;
  };
  export function evaluateDoseBoundary(
    item: unknown,
    context?: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ): {
    executable: boolean;
    renderable: boolean;
    dose_count: number;
    block_codes: readonly string[];
    reasons: readonly string[];
    rule_version: string;
    dose_card: unknown;
  };
  export function ruleVersionSpec(): Record<string, unknown>;
  export function ruleVersionDigest(): string;
}

declare module '*packages/reference/labels.mjs' {
  /**
   * 标签原文用量卡片描述符（**唯一**产出用量卡的入口）。
   * `rule_version` 为产出该判定的 GY-I08 规则版本。
   */
  export function doseCardDescriptor(
    item: unknown,
    opts?: { doseCardEnabled?: boolean; context?: Record<string, unknown> },
  ): { renderable: boolean; reason: string | null; rule_version: string };
  export function assertNoForbiddenLabel(text: string): string;
  export function referenceStateLabel(state: string): string;
  export function matchStateLabel(state: string): string;
}

declare module '*packages/reference/query.mjs' {
  /** 单条记录可见性/有效性判定（列表与详情共用）。 */
  export function evaluateEligibility(
    item: unknown,
    opts?: { includeSimulated?: boolean },
  ): { queryable: boolean; reason: string | null };
  /** 是否模拟来源（实名判定：标志位 / 来源类型 / `SIM-` 前缀任一成立）。 */
  export function isSimulatedSource(item: unknown): boolean;
  /** GY-I08 适用性判定（8 维度，fail-closed）。 */
  export function evaluateApplicability(
    item: unknown,
    context?: Record<string, unknown>,
    opts?: { ruleVersion?: string },
  ): { applicable: boolean; blocked: readonly string[]; reasons: readonly string[]; rule_version: string };
  export function matchConditions(item: unknown, query: Record<string, unknown>): {
    matched: boolean;
    reasons: readonly string[];
  };
  export function readRestrictionStatus(item: unknown): string;
}

declare module '*packages/reference/records.mjs' {
  /** 装载全部除草剂记录并投影；`skipped` 为投影前被 fail-closed 排除的记录。 */
  export function loadHerbicideRecords(): {
    docMeta: Record<string, unknown>;
    items: readonly unknown[];
    skipped: readonly unknown[];
  };
  export function deterministicUuid(seed: string): string;
  export function buildConditions(record: unknown): Record<string, unknown> | null;
  export function parseIngredients(text: unknown): readonly unknown[];
}
