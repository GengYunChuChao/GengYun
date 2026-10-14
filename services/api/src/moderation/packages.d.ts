/**
 * GY-I14（#14）审核 HTTP 装配片 · `packages/moderation` **模型层**的只读类型声明。
 *
 * 用途：`services/api` 是 TypeScript（`strict` + `noUncheckedIndexedAccess`），而 GY-I14 的
 * 两片组件（规则层 + 模型层）都是纯 ESM `.mjs`。与 `services/api/src/community/moderation.d.ts`、
 * `services/api/src/media/packages.d.ts` 的做法一致，这里就地声明形状，
 * **不修改 `packages/moderation/**`**（只读导入）。
 *
 * 这里**只声明规则层那份声明（`community/moderation.d.ts`）没覆盖到的模型层子模块**：
 * 规则层符号（`evaluateHardRules` / `evaluateReReview` / `isPublishable` / `RULES` / `RULE_VERSION` …）
 * 仍从 `*packages/moderation/index.mjs` 取（该 ambient 通配声明已存在，本文件不重复声明以免合并冲突）。
 *
 * 声明依据（逐条对照实现，不猜字段）：
 *   - `mergeModeration` / `MERGE_EXECUTION_MODES` / `checkMergedContractShape`：merge.mjs
 *   - `evaluateBoundHardRules` / `moderationInputDigest` / `verifyInputBinding` / `readInputBinding`：input-binding.mjs
 *   - `evaluateModelReReview` / `isModelLayerPublishable`：model-review.mjs
 *   - `validateModelPort` / `classifyModelFailure` / `MODEL_PORT_SEAMS`：model-ports.mjs
 *   - `PROMPT_DEFINITIONS` / `promptIdForPortKind` / `promptDefinition`：prompts.mjs
 *   - `MODEL_FAILURE_REASON_CODES` / `isModelFailureReasonCode`：model-reason-codes.mjs
 */
declare module '*packages/moderation/merge.mjs' {
  export const MERGE_EXECUTION_MODES: readonly string[];

  /** 合流层每类内容（tms/ims）的执行证据条目。 */
  export interface MergedKindEntry {
    kind: string;
    status: 'not_invoked' | 'failed' | 'blocked' | 'pass';
    label: string | null;
    reason_codes: string[];
    reported: Record<string, unknown> | null;
    synthetic: boolean;
    failure_class?: string;
  }

  export interface MergedModelLayer {
    execution_mode: string | null;
    status: 'attempted' | 'not_attempted';
    reason_codes: string[];
    kinds: Record<string, MergedKindEntry>;
    synthetic_ports: string[];
    unused_port_kinds: string[];
    declaration: {
      pending_model_layer_fields: string[] | null;
      declaration_ok: boolean;
      spoofed_fields: string[];
    };
    details: Array<{ field: string | null; code: string }>;
    re_review?: unknown;
    publishable?: unknown;
  }

  export interface MergedInputBinding {
    schema: string;
    digest: string | null;
    expected_digest: string | null;
    media_count: number | null;
    text_length: number | null;
    verified: boolean;
  }

  /** `mergeModeration` 的返回形状（`buildMerged`；键集合逐项对照 merge.mjs）。 */
  export interface MergedModeration {
    target_ref: { type: string; id: string; revision: number } | null;
    decision: 'pending' | 'approved' | 'rejected' | 'quarantined';
    reason_codes: string[];
    hard_rule_passed: boolean;
    rule_version: string | null;
    model_version: string | null;
    prompt_version: string | null;
    reason_codes_full: string[];
    input_binding: MergedInputBinding | null;
    contract_value: Record<string, unknown> | null;
    moderation_result: { kind: 'moderation'; value: Record<string, unknown> } | null;
    missing_contract_fields: string[];
    remaining_contract_fields: string[];
    model_layer: MergedModelLayer | null;
    rule_layer: {
      decision: string | null;
      hard_rule_passed: boolean;
      rule_version: string | null;
      counts: Record<string, unknown> | null;
      rule_statuses: Array<[string | null, string | null]> | null;
    };
    wired_to_http: boolean;
    component: string;
  }

  export interface MergeOptions {
    content?: { target_ref: unknown; text: string; media: unknown[] };
    ports?: { tms?: unknown; ims?: unknown };
    execution_mode?: string;
    deadline_ms?: number;
    rules?: unknown[];
  }

  export function mergeModeration(ruleResult: unknown, options?: MergeOptions): Promise<MergedModeration>;
  export function checkMergedContractShape(merged: unknown): {
    ok: boolean;
    problems: string[];
    missing_contract_fields: string[];
    remaining_contract_fields: string[];
  };
}

declare module '*packages/moderation/input-binding.mjs' {
  export const INPUT_BINDING_SCHEMA: string;
  export const INPUT_BINDING_FIELD: string;
  export const INPUT_BINDING_DIGEST_LENGTH: number;

  export function canonicalModerationInput(input: unknown): {
    text: string | null;
    media_count: number | null;
  };
  export function moderationInputDigest(input: unknown): string;
  export function isDerivedInputDigest(value: unknown): boolean;

  /** 规则层结论 + 它实际检查过的输入摘要（**生产接线应使用这个入口**）。 */
  export function evaluateBoundHardRules(input: unknown, options?: unknown): unknown;

  export function verifyInputBinding(
    holder: unknown,
    input: unknown,
  ): { ok: boolean; reason_codes: string[]; actual_digest: string | null; expected_digest: string | null } | null;
  export function readInputBinding(holder: unknown): {
    present: boolean;
    digest: string | null;
    value: unknown;
  };
}

declare module '*packages/moderation/model-review.mjs' {
  export const MODEL_BINDING_FIELDS: readonly string[];

  export function evaluateModelReReview(
    existing: unknown,
    options?: {
      rule_version?: string;
      model_version?: string;
      prompt_version?: string;
      target_ref?: unknown;
      input?: unknown;
    },
  ): {
    rule_version_current: string;
    model_version_current: string | null;
    prompt_version_current: string | null;
    binding_fields: string[];
    stale: boolean;
    action: 'reuse' | 're_review';
    landing: 'pending' | 'quarantined' | null;
    publishable: boolean;
    reason_codes: string[];
    details: Array<{ field: string | null; code: string }>;
    content_binding_verified: boolean;
  };

  export function isModelLayerPublishable(
    result: unknown,
    options?: {
      rule_version?: string;
      model_version?: string;
      prompt_version?: string;
      input?: unknown;
    },
  ): {
    publishable: boolean;
    reason_codes: string[];
    binding: Record<string, unknown>;
    merged_legality: { ok: boolean; reason_codes: string[]; content_binding_verified: boolean };
    content_binding_verified: boolean;
    decision_is_audit_state: boolean;
  };
}

declare module '*packages/moderation/model-ports.mjs' {
  export const MODEL_PORT_KINDS: readonly string[];
  export const MODEL_PORT_SEAMS: readonly string[];
  export const MODEL_PORT_SEAM_DEFAULTS: Readonly<Record<string, null>>;
  export const MEDIA_REF_FIELDS: readonly string[];

  export function validateModelPort(
    port: unknown,
    expectedKind: 'tms' | 'ims',
  ): {
    valid: boolean;
    reason_codes: string[];
    details: Array<{ field: string | null; code: string }>;
    model_version: string | null;
    synthetic: boolean | null;
    timeout_ms: number | null;
  };

  export function classifyModelFailure(error: unknown): string;
  export function modelFailureReasonCode(failureClass: unknown): string;
}

declare module '*packages/moderation/prompts.mjs' {
  export const PROMPT_IDS: readonly string[];
  export const PROMPT_ID_BY_PORT_KIND: Readonly<Record<string, string>>;
  export const PROMPT_DEFINITIONS: Readonly<
    Record<
      string,
      {
        id: string;
        purpose: string;
        system: string;
        user_template: string;
        placeholders: readonly string[];
        required_output_fields: readonly string[];
        verdict_labels: readonly string[];
        policy_notes: readonly string[];
      }
    >
  >;

  export function promptIdForPortKind(kind: unknown): string | null;
  export function promptDefinition(id: unknown): Record<string, unknown> | null;
}

declare module '*packages/moderation/model-reason-codes.mjs' {
  export const MODEL_REASON_CODES: readonly string[];
  export const MODEL_FAILURE_REASON_CODES: readonly string[];
  export function isModelReasonCode(value: unknown): boolean;
  export function isModelFailureReasonCode(value: unknown): boolean;
}

declare module '*packages/moderation/model-verdict.mjs' {
  export const MODEL_VERDICT_LABELS: readonly string[];
  export const MODEL_VERDICT_MEANINGS: Readonly<Record<string, string>>;
  export const MODEL_REPORTED_FIELDS: readonly string[];
  export function normalizeModelVerdict(
    raw: unknown,
    context?: { required_output_fields?: readonly string[]; declared_model_version?: string | null },
  ): {
    ok: boolean;
    label: string | null;
    model_version: string | null;
    reported: Record<string, unknown>;
    reason_codes: string[];
    details: Array<{ field: string | null; code: string }>;
  };
}

declare module '*packages/moderation/engine.mjs' {
  /** 按规则集声明序排原因码（fail-closed 码在前）。 */
  export function orderReasonCodes(codes: unknown, rules?: unknown): string[];
  /** 截断到契约上限（置顶 `REASON_CODES_TRUNCATED`）。 */
  export function truncateReasonCodes(codes: readonly string[], max?: number): string[];
}

declare module '*packages/moderation/prompt-version.mjs' {
  export function derivePromptVersionForIds(promptIds: readonly string[]): string;
  export function derivePromptVersion(prompts?: unknown): string;
}

declare module '*packages/moderation/merged-invariant.mjs' {
  export const MERGED_FAILURE_REASON_CODES: readonly string[];
  export function requiredModelPortKinds(content: unknown): string[];
  export function mergedFailureCodes(holder: unknown): string[];
  export function checkMergedInvariant(
    merged: unknown,
    options?: { input?: unknown },
  ): { ok: boolean; violations: string[]; evidence: unknown };
}
