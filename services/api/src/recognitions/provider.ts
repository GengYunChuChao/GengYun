/**
 * GY-I09 识别提供者适配层（接口 + 三种执行模式实现）。
 *
 * 硬约束（派单 §4.1-5）：
 * - `stub` / `preset_demo`：确定性的**明确标注替身**，绝不冒充真实识别；
 *   `model_version` 带 `stub` / `preset-demo` 标记，响应 `meta.execution_mode` 如实为对应模式。
 * - `real`：缺凭据**一律 fail-closed**（`PROVIDER_UNAVAILABLE`），**严禁静默回退替身**；
 *   即使提供凭据，本片也没有已审真实供应商适配器，同样 fail-closed，不伪造成功。
 * - 提供者错误按契约映射：超时 → `PROVIDER_TIMEOUT`，配额 → `PROVIDER_QUOTA_EXCEEDED`，
 *   结果未知/协议违规 → `PROVIDER_OUTCOME_UNKNOWN`，不可用 → `PROVIDER_UNAVAILABLE`。
 *   **不得**把提供者失败写成 `succeeded`。
 *
 * 提供者只负责「产出候选与原因」，**不决定** JobState：状态由 state.ts 的
 * `decideOutcome` 判定，因此无分数候选不可能被提供者写成成功。
 */
import { createHash } from 'node:crypto';
import type { ExecutionMode } from '../contract.ts';

/** 提供者失败码：必须是契约 ErrorCode 闭集成员。 */
export const PROVIDER_FAILURE_CODES = [
  'PROVIDER_TIMEOUT',
  'PROVIDER_QUOTA_EXCEEDED',
  'PROVIDER_OUTCOME_UNKNOWN',
  'PROVIDER_UNAVAILABLE',
] as const;
export type ProviderFailureCode = (typeof PROVIDER_FAILURE_CODES)[number];

export type ProviderOutcome =
  /** 提供者给出原始候选（未校验；由 decideOutcome 校验并判定状态）。 */
  | { kind: 'completed'; candidates: unknown; uncertainty_reasons?: unknown }
  /** 提供者失败：由 service 映射为 failed / timed_out，绝不落 succeeded。 */
  | { kind: 'failed'; code: ProviderFailureCode };

export interface RecognitionProvider {
  readonly executionMode: ExecutionMode;
  /** 写入 Recognition.model_version；替身必须带明确标注。 */
  readonly modelVersion: string;
  /** false 表示「现在就不该受理」：real 缺凭据时 POST 直接 503，不排队、不回退替身。 */
  readonly available: boolean;
  /** 不可用原因（不含凭据原文）。 */
  readonly unavailableReason: string | null;
  recognize(input: { jobId: string; mediaId: string; mediaRevision: number }): Promise<ProviderOutcome>;
}

/** stub 替身使用的合成物种 id（与真实目录 id 命名空间隔离，避免被误读为真实识别）。 */
export const STUB_SPECIES_IDS = ['synthetic_weed_a', 'synthetic_weed_b', 'synthetic_weed_c'] as const;

/** preset_demo 替身使用的演示物种 id（取自本地参考目录，仅演示链路，不代表真实识别）。 */
export const PRESET_DEMO_SPECIES_IDS = ['species_barnyardgrass', 'species_foxtail', 'species_crabgrass'] as const;

/** 确定性分桶：同一 media_id 永远得到同一替身脚本（便于复现，不引入随机）。 */
function bucketOf(seed: string, modulo: number): number {
  const digest = createHash('sha256').update(seed).digest();
  return (digest[0] ?? 0) % modulo;
}

/**
 * 替身提供者（`stub` / `preset_demo`）。
 *
 * 脚本按 `mediaId` 的 sha256 分 4 桶，**确定性**、可离线复现：
 *   0 → 3 条有分数候选（可判 succeeded）
 *   1 → 2 条有分数候选（证明「少于 3 条不补造」）
 *   2 → 2 条 model_score=null 候选 + 1 条原因（必须判 uncertain）
 *   3 → 无候选 + 1 条原因（必须判 uncertain）
 * 以上均为替身脚本，**不构成任何准确率证据**（真实样本 0，见 docs/evaluation/sample-gap-register.md）。
 */
export function createStubRecognitionProvider(options: {
  executionMode?: 'stub' | 'preset_demo';
} = {}): RecognitionProvider {
  const executionMode = options.executionMode ?? 'stub';
  const isDemo = executionMode === 'preset_demo';
  const ids = isDemo ? PRESET_DEMO_SPECIES_IDS : STUB_SPECIES_IDS;
  const modelVersion = isDemo ? 'preset-demo-v1' : 'stub-v1';
  return {
    executionMode,
    modelVersion,
    available: true,
    unavailableReason: null,
    async recognize({ mediaId }) {
      if (isDemo) {
        // 预设演示：固定 Top3 明示演示，不走分桶。
        return {
          kind: 'completed',
          candidates: [
            { species_id: ids[0], rank: 1, model_score: 0.82 },
            { species_id: ids[1], rank: 2, model_score: 0.54 },
            { species_id: ids[2], rank: 3, model_score: 0.31 },
          ],
          uncertainty_reasons: [],
        };
      }
      const bucket = bucketOf(mediaId, 4);
      if (bucket === 1) {
        return {
          kind: 'completed',
          candidates: [
            { species_id: ids[0], rank: 1, model_score: 0.64 },
            { species_id: ids[1], rank: 2, model_score: 0.28 },
          ],
          uncertainty_reasons: [],
        };
      }
      if (bucket === 2) {
        return {
          kind: 'completed',
          candidates: [
            { species_id: ids[0], rank: 1, model_score: null },
            { species_id: ids[1], rank: 2, model_score: null },
          ],
          uncertainty_reasons: ['替身未给出可信分数，需重拍或人工核对'],
        };
      }
      if (bucket === 3) {
        return { kind: 'completed', candidates: [], uncertainty_reasons: ['替身在该媒体上未产出候选'] };
      }
      return {
        kind: 'completed',
        candidates: [
          { species_id: ids[0], rank: 1, model_score: 0.77 },
          { species_id: ids[1], rank: 2, model_score: 0.42 },
          { species_id: ids[2], rank: 3, model_score: 0.19 },
        ],
        uncertainty_reasons: [],
      };
    },
  };
}

/**
 * 真实提供者（`real`）。**fail-closed**：
 * - 缺 endpoint/apiKey → `available=false`，POST 直接 503 `PROVIDER_UNAVAILABLE`；
 * - 即使凭据齐备，本片也没有已审供应商适配器，`recognize` 仍返回 `PROVIDER_UNAVAILABLE`；
 * - 任何路径都**不会**回退到 stub/preset_demo 替身。
 */
export function createRealRecognitionProvider(credentials: {
  endpoint?: string | null;
  apiKey?: string | null;
} = {}): RecognitionProvider {
  const endpoint = typeof credentials.endpoint === 'string' && credentials.endpoint.trim() !== '' ? credentials.endpoint.trim() : null;
  const apiKey = typeof credentials.apiKey === 'string' && credentials.apiKey.trim() !== '' ? credentials.apiKey.trim() : null;
  const missing = endpoint === null || apiKey === null;
  return {
    executionMode: 'real',
    modelVersion: 'real-unconfigured',
    available: !missing,
    unavailableReason: missing ? '缺少真实识别供应商凭据（fail-closed，不回退替身）' : null,
    async recognize() {
      // 无已审真实适配器：不伪造结果，也不回退替身。
      return { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' };
    },
  };
}

/** 按执行模式选择提供者；`real` 永远走 fail-closed 实现。 */
export function createRecognitionProvider(input: {
  executionMode: ExecutionMode;
  endpoint?: string | null;
  apiKey?: string | null;
}): RecognitionProvider {
  if (input.executionMode === 'real') {
    return createRealRecognitionProvider({ endpoint: input.endpoint ?? null, apiKey: input.apiKey ?? null });
  }
  return createStubRecognitionProvider({ executionMode: input.executionMode });
}
