/**
 * GY-I15（#15）阶段 1 · `packages/moderation` 的只读类型声明。
 *
 * 用途：`services/api` 用 TypeScript（`strict` + `noUncheckedIndexedAccess`），而
 * GY-I14 的规则层是 `.mjs`。与 `services/api/src/privacy/reference.d.ts` 的做法一致，
 * 这里就地声明该模块的形状，**不修改 packages/moderation/**（只读导入）。
 *
 * 声明依据（逐条对照 packages/moderation 的实现，不猜字段）：
 *   - `evaluateHardRules` / `evaluateTarget`：engine.mjs
 *   - `evaluateReReview` / `isPublishable`：review.mjs
 *   - `deriveRuleVersion` / `RULE_VERSION`：rule-version.mjs
 *   - `RULES` / `MATCHERS` / `MATCHER_REVISIONS`：rules.mjs / matchers.mjs
 *   - `checkDecisionInvariant`：engine.mjs
 *
 * 若 packages/moderation 改变导出形状，`npm run lint`（tsc --noEmit）会失败——
 * 这正是本声明的作用：让漂移在静态检查阶段暴露，而不是在运行期静默错判。
 */
declare module '*packages/moderation/index.mjs' {
  export type ModerationDecision = 'pending' | 'approved' | 'rejected' | 'quarantined';

  export interface ModerationRuleDescriptor {
    id: string;
    category: string;
    reason_code: string;
    title: string;
    description: string;
    severity: string;
    matcher: string;
    patterns: RegExp[];
    [extra: string]: unknown;
  }

  export interface RuleEvaluationEntry {
    id: string;
    category: string;
    reason_code: string;
    status: 'evaluated' | 'hit' | 'error' | 'timeout' | 'not_evaluated' | 'truncated';
    matched: boolean;
    evidence: Record<string, unknown> | null;
    error: { type: string; code: string; rule_id?: string } | null;
  }

  export interface RuleLayerOutcome {
    target_ref: { type: string; id: string; revision: number } | null;
    decision: ModerationDecision;
    reason_codes: string[];
    hard_rule_passed: boolean;
    rule_version: string | null;
    rule_layer_only: boolean;
    wired_to_http: boolean;
    reason_codes_full: string[];
    rules: RuleEvaluationEntry[];
    counts: {
      total: number;
      evaluated: number;
      hits: number;
      errors: number;
      timeouts: number;
      truncated: number;
      not_evaluated: number;
    };
    engine_error: string | null;
    option_errors: string[];
    invariant_violations: string[];
    contract_shape_ok: boolean;
  }

  export interface HardRuleOptions {
    rules?: ModerationRuleDescriptor[];
    matchers?: Record<string, unknown>;
    matcher_revisions?: Record<string, number>;
    clock?: () => number;
    budget_ms?: number;
    max_text_length?: number;
  }

  export interface ReReviewOutcome {
    rule_version_current: string;
    stale: boolean;
    action: 'reuse' | 're_review';
    landing: 'pending' | 'quarantined' | null;
    publishable: boolean;
    reason_codes: string[];
    details: Array<{ field: string | null; code: string }>;
  }

  export const RULES: ReadonlyArray<ModerationRuleDescriptor>;
  export const MATCHERS: Readonly<Record<string, unknown>>;
  export const MATCHER_REVISIONS: Readonly<Record<string, number>>;
  export const RULE_VERSION: string;

  export function deriveRuleVersion(
    rules?: ReadonlyArray<ModerationRuleDescriptor>,
    matchers?: Record<string, unknown>,
    revisions?: Record<string, number>,
  ): string;

  export function evaluateHardRules(input: unknown, options?: HardRuleOptions): RuleLayerOutcome;
  export const evaluateTarget: typeof evaluateHardRules;

  export function evaluateReReview(
    existing: unknown,
    options?: { rule_version?: string; target_ref?: { type: string; id: string; revision: number } },
  ): ReReviewOutcome;

  export function isPublishable(
    result: unknown,
    ruleVersionCurrent?: string,
  ): { publishable: boolean; reason_codes: string[] };

  export function checkDecisionInvariant(result: unknown): { ok: boolean; violations: string[] };
  export function missingContractFields(): string[];
  export function makeQuarantineResult(
    reasonCodes?: string[],
    options?: HardRuleOptions & { engine_error?: string | null },
  ): RuleLayerOutcome;
}
