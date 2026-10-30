/**
 * `packages/reference/**`（GY-I07 查询展示域库，纯 ESM `.mjs`）的只读类型声明。
 *
 * 用途：`services/api` 是 TypeScript（`strict` + `noUncheckedIndexedAccess`），而域库是
 * 纯 ESM `.mjs`。与 `services/api/src/media/packages.d.ts`、
 * `services/api/src/community/moderation.d.ts`、`services/api/src/privacy/reference.d.ts`
 * 的做法一致：就地声明其形状，**只读导入**，不修改 `packages/reference/**` 的实现。
 *
 * 声明依据（逐条对照域库实际导出，不猜字段）：
 *   - `createReferenceService` / `buildMeta`：service.mjs
 *   - `loadZhejiangKnowledge` / `queryZhejiangKnowledge` / `zhejiangState` /
 *     `loadZhejiangMaterials` / `zhejiangKnowledgeRecords` /
 *     `ZHEJIANG_SOURCE_URL_NOT_PUBLISHED` / `ZHEJIANG_REVIEW_STATUS` /
 *     `ZHEJIANG_VISIBILITY` / `ZHEJIANG_PROVINCE_CODE` / `ZHEJIANG_DOSE_ABSENT_NOTE`：zhejiang.mjs
 *   - `doseCardDescriptor` / `describeRecord` / `assertNoForbiddenLabel`：labels.mjs
 *   - `ReferenceError`（域库自有错误类型，**与全局 ReferenceError 同名但不同类**）：errors.mjs
 *   - `APPLICABILITY_RULE_VERSION`：constants.mjs（GY-I08 规则版本，唯一事实来源）
 *   - `BLOCK_CODES`：deterministic.mjs（GY-I08 阻断类别闭集）
 *
 * 若域库改变导出形状，`npm run lint`（tsc --noEmit）会失败 —— 这正是本声明的作用：
 * 让漂移在静态检查阶段暴露，而不是在运行期静默错判。
 */

declare module '*packages/reference/index.mjs' {
  /** 域库错误（code 属于契约 ErrorCode 子集）。 */
  export class ReferenceError extends Error {
    constructor(code: string, message: string, options?: { retryable?: boolean; details?: Array<{ field: string; reason: string }> });
    readonly name: 'ReferenceError';
    readonly code: string;
    readonly retryable: boolean;
    readonly details: Array<{ field: string; reason: string }>;
    readonly status: number;
  }

  /** 单字段错误（契约 FieldError：field / reason）。 */
  export class FieldError {
    constructor(field: string, reason: string);
    readonly field: string;
    readonly reason: string;
  }

  /** 契约形状的查询响应（`body` 为可直接返回的封套；`headers` 为缓存头）。 */
  export interface DomainResponse {
    body: Record<string, unknown>;
    headers: Record<string, string>;
    query_state?: Record<string, unknown>;
    detail_state?: Record<string, unknown>;
  }

  /** GY-I08 规则版本常量（`constants.mjs` 唯一定义；所有消费端同一版本）。 */
  export const APPLICABILITY_RULE_VERSION: string;

  /** GY-I08 阻断类别闭集（`deterministic.mjs`；键为类别名、值为类别码）。 */
  /**
   * GY-I08 阻断类别闭集（`deterministic.mjs` 的 `BLOCK_CODES`）：键为类别名、值为类别码。
   *
   * **逐键列举**（不用 `Record<string, string>` 索引签名）：tsconfig 的 `noUncheckedIndexedAccess`
   * 会把索引签名读成 `string | undefined`，而这些值是**常量成员**、永远存在。
   * 键集合与域库逐项一致；域库删改成员时 `tests/reference/i08-rule-version.test.mjs` 的
   * 闭集成员断言会失败。
   */
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
  export function createReferenceService(options?: { executionMode?: string }): {
    executionMode: string;
    listKnowledge(input?: Record<string, unknown>, requestId?: string): DomainResponse;
    getKnowledge(id: string, input?: Record<string, unknown>, requestId?: string): DomainResponse;
    listHerbicides(input?: Record<string, unknown>, requestId?: string): DomainResponse;
    getHerbicide(id: string, input?: Record<string, unknown>, requestId?: string): DomainResponse;
    snapshot(): Record<string, unknown>;
  };

  export function doseCardDescriptor(
    item: unknown,
    opts?: { doseCardEnabled?: boolean; context?: Record<string, unknown> },
  ): { renderable: boolean; reason: string | null; rule_version: string };

  export function assertNoForbiddenLabel(text: string): string;

  export interface ZhejiangSourceRef {
    id: string;
    version: string;
    title: string;
    url: string;
    publisher: string;
    source_kind: string;
    evidence_kind: string;
    validity: string;
    review_status: string;
    updated_at: string;
  }

  export interface ZhejiangKnowledgeContract {
    id: string;
    revision: number;
    type: string;
    title: string;
    body: string;
    source: ZhejiangSourceRef;
    conditions: null;
    reference_state: string;
    dose_cards: readonly unknown[];
  }

  export interface ZhejiangKnowledgeItem {
    item_id: string;
    kind: 'weed' | 'control_timing' | 'herbicide_applicability';
    type: 'species' | 'scheme' | 'herbicide';
    title: string;
    body: string;
    source: ZhejiangSourceRef;
    source_version: string;
    content_hash: string;
    crop_ids: string[];
    species_ids: string[];
    region_codes: string[];
    visibility: string;
    review_status: string;
    validity: string;
    reference_state: string;
    dose_text: null;
    usable_as_dose: false;
    card_ready: false;
    knowledge: ZhejiangKnowledgeContract;
    verification: Record<string, unknown>;
  }

  export interface ZhejiangKnowledge {
    doc: Record<string, unknown>;
    items: readonly ZhejiangKnowledgeItem[];
    state: Record<string, unknown>;
  }

  /** GY-I08 阻断类别码列表（`deterministic.mjs` 的 `BLOCK_CODE_LIST`，顺序与域库一致）。 */
  export const BLOCK_CODE_LIST: readonly string[];

  /**
   * `labels.mjs` 的展示文案表（`DISPLAY_LABELS`）。
   *
   * 只声明**被服务端消费**的一节 `dose_reject_reason`：它是「哪道门没过」的**唯一**权威文案来源，
   * `knowledge/dose-cards.ts` 用它把域库的拒绝原因映射回门 id。逐键列举而非索引签名
   * （`noUncheckedIndexedAccess` 会把索引签名读成 `string | undefined`，而这些是常量成员）。
   * 域库新增/改名任一文案时，本声明的 `Object.values` 消费点会跟着漂移，
   * 由 `tests/unit/knowledge-dose-cards-http.test.mjs` 的映射总覆盖断言判红。
   */
  export const DISPLAY_LABELS: Readonly<{
    dose_reject_reason: Readonly<{
      not_usable: string;
      missing_condition: string;
      not_applicable: string;
      banned: string;
      restricted: string;
      restriction_unknown: string;
      invalid_source: string;
      closed: string;
      not_reviewed: string;
      stale_dose: string;
      incomplete_formulation: string;
      simulated_source: string;
      no_confirmed_context: string;
      dose_formulation_mismatch: string;
      dose_record_mismatch: string;
      dose_reference_missing: string;
    }>;
  }>;

  /** GY-I08 规则规格的内容摘要（`deterministic.mjs`；形如 `gy-i08-spec+sha256:<64hex>`）。 */
  export function ruleVersionDigest(): string;

  /** GY-I08 匹配终态闭集（`deterministic.mjs` 的 `MATCH_STATES`，与契约 MatchState 同集）。 */
  export const MATCH_STATES: readonly string[];

  /** `evaluateExecutableAdvice` 的返回形状（`deterministic.mjs`）。 */
  export interface ExecutableAdvice {
    executable: boolean;
    applicable: boolean;
    blocked: readonly string[];
    block_codes: readonly string[];
    reasons: readonly string[];
    rule_version: string;
    feature_switch: Record<string, unknown>;
  }

  /** `evaluateDoseBoundary` 的返回形状（`deterministic.mjs`）：用量卡与建议同一次判定产出。 */
  export interface DoseBoundary {
    executable: boolean;
    renderable: boolean;
    dose_count: number;
    block_codes: readonly string[];
    reasons: readonly string[];
    rule_version: string;
    dose_card: Record<string, unknown>;
    advice: ExecutableAdvice;
    feature_switch: Record<string, unknown>;
  }

  /** `evaluateRegistrationMatch` 的返回形状：非 `matched` 时 `matched` 恒为 `null`。 */
  export interface RegistrationMatch {
    state: string;
    matched: Record<string, unknown> | null;
    block_codes: readonly string[];
    reasons: readonly string[];
    rule_version: string;
  }

  export function evaluateExecutableAdvice(
    item: unknown,
    context?: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ): ExecutableAdvice;

  export function evaluateDoseBoundary(
    item: unknown,
    context?: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ): DoseBoundary;

  export function evaluateRegistrationMatch(
    candidates: readonly Record<string, unknown>[],
    query: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ): RegistrationMatch;

  /**
   * 一条已过「契约前提门禁」的仓内登记记录（`packages/reference/records.mjs#projectHerbicideRecords`
   * 的产出项）。只声明**被服务端消费**的字段；运行期对象还有 `index`/`content_hash`/`norm` 等
   * 内部字段（本声明不覆盖它们，也不代表它们可对外下发）。
   *
   * `contract` 是契约 `Herbicide` 投影，但其形状**不在此假定**：消费方必须按不可信载荷处理
   * （`ocr/state.ts#sanitizeRegistryLookup` 逐字段校验并重建）。
   */
  export interface ReferenceHerbicideItem {
    readonly record_id: string;
    readonly registration_number: string;
    readonly registered_name: string;
    readonly producer: string;
    readonly dosage_form: string;
    readonly ingredients_text: string;
    readonly source_version: string;
    /** 可见性（`published` / `hidden` / `deleted` / `private`）：非 published 退出对外核对面。 */
    readonly visibility: string;
    /** 模拟来源标记（`SIM-` 前缀或 `source_kind=simulation`）：不得作为真实登记依据。 */
    readonly simulated: boolean;
    readonly contract: Record<string, unknown>;
    /** 来源元数据原样投影（`record.source`）；字段是否存在**不保证**，消费方必须按不可信载荷处理。 */
    readonly source?: Record<string, unknown>;
    /** 核对元数据原样投影（`record.verification`，含 `usable_as_dose` / `review_status` / `dose`）。 */
    readonly verification?: Record<string, unknown>;
    readonly crop_ids?: readonly string[];
    /** 使用场景原文（可能缺项，故为可选）。 */
    readonly use_scene?: string | null;
  }

  /** 装载全部记录：`items` 为可对外投影的条目，`skipped` 为被 fail-closed 排除的记录（含原因）。 */
  export function loadHerbicideRecords(): {
    items: readonly ReferenceHerbicideItem[];
    skipped: readonly Record<string, unknown>[];
    docMeta: Record<string, unknown>;
  };

  export function loadZhejiangKnowledge(): ZhejiangKnowledge;
  export function queryZhejiangKnowledge(
    items: readonly ZhejiangKnowledgeItem[],
    query?: Record<string, unknown>,
  ): { match_state: string; items: readonly ZhejiangKnowledgeItem[]; reasons: readonly string[] };

  export const ZHEJIANG_SOURCE_URL_NOT_PUBLISHED: string;
  export const ZHEJIANG_REVIEW_STATUS: string;
  export const ZHEJIANG_VISIBILITY: string;
  export const ZHEJIANG_PROVINCE_CODE: string;
  export const ZHEJIANG_DOSE_ABSENT_NOTE: string;
  export const ZHEJIANG_MATERIALS_PATH: string;
}
