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

  export function loadHerbicideRecords(): { items: readonly Record<string, unknown>[] };

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
