/**
 * GY-I09 识别提供者适配层（接口 + 三种执行模式实现）。
 *
 * 硬约束（派单 §4.1-5）：
 * - `stub` / `preset_demo`：确定性的**明确标注替身**，绝不冒充真实识别；
 *   `model_version` 带 `stub` / `preset-demo` 标记，响应 `meta.execution_mode` 如实为对应模式。
 * - `real`：缺凭据**一律 fail-closed**（`PROVIDER_UNAVAILABLE`），**严禁静默回退替身**；
 *   凭据齐备且真实适配器装配成功时才走 `recognitions/live-adapter.ts`（GY-R70 起），
 *   装配失败/配置不合法同样 fail-closed（`createRealRecognitionProvider` 的既有语义），不伪造成功。
 * - 提供者错误按契约映射：超时 → `PROVIDER_TIMEOUT`，配额 → `PROVIDER_QUOTA_EXCEEDED`，
 *   结果未知/协议违规 → `PROVIDER_OUTCOME_UNKNOWN`，不可用 → `PROVIDER_UNAVAILABLE`。
 *   **不得**把提供者失败写成 `succeeded`。
 *
 * 提供者只负责「产出候选与原因」，**不决定** JobState：状态由 state.ts 的
 * `decideOutcome` 判定，因此无分数候选不可能被提供者写成成功。
 */
import { createHash } from 'node:crypto';
import type { ExecutionMode } from '../contract.ts';
import { FAILURE_BRANCHES, type FailureBranch } from './branches.ts';
import { createUnwiredRecognitionImageSource, createLiveRecognitionProviderFromCredentials } from './live-adapter.ts';
import type { RealRecognitionPorts, RecognitionImageSource } from './live-ports.ts';

/** 提供者失败码：必须是契约 ErrorCode 闭集成员。 */
export const PROVIDER_FAILURE_CODES = [
  'PROVIDER_TIMEOUT',
  'PROVIDER_QUOTA_EXCEEDED',
  'PROVIDER_OUTCOME_UNKNOWN',
  'PROVIDER_UNAVAILABLE',
] as const;
export type ProviderFailureCode = (typeof PROVIDER_FAILURE_CODES)[number];

export type ProviderOutcome =
  /**
   * 提供者给出原始候选（未校验；由 decideOutcome 校验并判定状态）。
   *
   * `branch`（可选）：提供者上报的**六类失败/边界分支**（见 `branches.ts`）。
   * 一旦上报，`decideOutcome` **一律**判 `uncertain` ——
   * 「覆盖外/低质量/需重拍」不得因为同时返回了高分候选而被当成可信成功。
   * 非闭集成员会被判为协议违规（`failed` / `PROVIDER_OUTCOME_UNKNOWN`）。
   */
  | { kind: 'completed'; candidates: unknown; uncertainty_reasons?: unknown; branch?: FailureBranch }
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
          // 分支：不确定（无分数即不可信）。
          branch: 'uncertain',
        };
      }
      if (bucket === 3) {
        return {
          kind: 'completed',
          candidates: [],
          uncertainty_reasons: ['替身在该媒体上未产出候选'],
          // 分支：无结果（正常调用但无候选）。
          branch: 'no_result',
        };
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
 * - 凭据齐备但真实适配器**装配失败/配置不合法**（`createRecognitionProvider` 的 `catch` 分支）
 *   也走这里：`available=false` ＋ 点名「装配失败」的如实原因（不伪装成凭据缺失）；
 * - 任何路径都**不会**回退到 stub/preset_demo 替身。
 *
 * ⚠ GY-R70 起「凭据齐备且字节端口在场」的真实分支**不再**是这里：它由
 * `recognitions/live-adapter.ts` 的 `createLiveRecognitionProvider()` 承担（见下方
 * `createRecognitionProvider`）。本函数保留为**装配失败/缺凭据**时的唯一 fail-closed 落点。
 */
export function createRealRecognitionProvider(credentials: {
  endpoint?: string | null;
  apiKey?: string | null;
} = {}, unavailableReasonOverride?: string): RecognitionProvider {
  const endpoint = typeof credentials.endpoint === 'string' && credentials.endpoint.trim() !== '' ? credentials.endpoint.trim() : null;
  const apiKey = typeof credentials.apiKey === 'string' && credentials.apiKey.trim() !== '' ? credentials.apiKey.trim() : null;
  const missing = endpoint === null || apiKey === null || typeof unavailableReasonOverride === 'string';
  return {
    executionMode: 'real',
    modelVersion: 'real-unconfigured',
    available: !missing,
    unavailableReason: unavailableReasonOverride ?? (missing ? '缺少真实识别供应商凭据（fail-closed，不回退替身）' : null),
    async recognize() {
      // 没有可用的真实适配器：不伪造结果，也不回退替身。
      return { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' };
    },
  };
}

/**
 * 按执行模式选择提供者；`real` **永远** fail-closed 或真实适配器，**永**不回退替身。
 *
 * GY-R70 起 `real` 的解析顺序（每一步都可被测试逐条断言）：
 * 1. 缺 endpoint/apiKey ⇒ `createRealRecognitionProvider(…)`（`available=false` ⇒ POST 503，零发包）；
 * 2. 两者齐备 ⇒ 尝试装配真实适配器 `createLiveRecognitionProviderFromCredentials(…)`；
 *    装配失败/配置不合法（端点非 https、超时越界、缺授权串、缺字节端口…）⇒ **回落第 1 步**的
 *    fail-closed 形态，并把原因如实点名（⛔ 绝不回退 `stub` / `preset_demo` 替身）；
 * 3. 装配成功 ⇒ 真实适配器（`available=true`）：字节只从注入端口来，零字节即零发包。
 *
 * `imageSource` 缺省时用**未接线**的字节来源（恒 `null`，不是替身）：即使装配成功，识别也会在
 * 第一步落 `failed PROVIDER_UNAVAILABLE`（与接线前同一结局）。
 */
export function createRecognitionProvider(input: {
  executionMode: ExecutionMode;
  endpoint?: string | null;
  apiKey?: string | null;
  /** GY-R70：真实字节来源（产品路径＝`recognitions/image-source.ts`）。缺省 ⇒ 未接线来源。 */
  imageSource?: RecognitionImageSource | null;
  liveGate?: RealRecognitionPorts['liveGate'];
  fetchImpl?: typeof fetch;
  now?: () => number;
  onObservation?: RealRecognitionPorts['onObservation'];
}): RecognitionProvider {
  if (input.executionMode === 'real') {
    const endpoint = typeof input.endpoint === 'string' && input.endpoint.trim() !== '' ? input.endpoint.trim() : null;
    const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() !== '' ? input.apiKey.trim() : null;
    if (endpoint !== null && apiKey !== null) {
      try {
        return createLiveRecognitionProviderFromCredentials({
          endpoint,
          apiKey,
          imageSource: input.imageSource ?? createUnwiredRecognitionImageSource('真实对象存储未接线：取不到待识别的私有照片字节'),
          ...(input.liveGate === undefined ? {} : { liveGate: input.liveGate }),
          ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
          ...(input.now === undefined ? {} : { now: input.now }),
          ...(input.onObservation === undefined ? {} : { onObservation: input.onObservation }),
        });
      } catch {
        // 装配失败/配置不合法：回落 fail-closed（既有语义），并如实点名，⛔ 不回退替身。
        return createRealRecognitionProvider(
          { endpoint, apiKey },
          '真实识别端口装配失败（配置不合法；fail-closed，未发包，不回退替身）',
        );
      }
    }
    return createRealRecognitionProvider({ endpoint, apiKey });
  }
  return createStubRecognitionProvider({ executionMode: input.executionMode });
}

/**
 * 把「六类失败/边界分支」映射为提供者输出（**唯一**的规范化入口）。
 *
 * 用途：任何提供者实现（含未来的真实适配器）都通过本函数上报分支，
 * 从而保证「分支 → 候选/原因」的映射只有一份，且 `model_version` 由调用方提供
 * （替身必须带明确标注）。
 *
 * 注意：`permission_denied` **不**是提供者输出 —— 它在受理前由用途授权中间件拦截
 * （见 `branches.ts` 的说明）；本函数对它返回 `failed`/`PROVIDER_UNAVAILABLE` 以防止
 * 任何调用方把「权限拒绝」当成一次已执行的任务结果。
 */
export function branchOutcome(branch: FailureBranch): ProviderOutcome {
  if (branch === 'permission_denied') {
    return { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' };
  }
  if (branch === 'timeout') {
    return { kind: 'failed', code: 'PROVIDER_TIMEOUT' };
  }
  return { kind: 'completed', candidates: [], uncertainty_reasons: [], branch };
}

/**
 * **分支演示替身**（`stub`/`preset_demo`，明确标注）。
 *
 * 给定一个分支即恒定上报它 —— 用于本机联调、Demo 走查与证据页逐分支取证。
 * `model_version` 带 `stub-branch` 标记，**不构成任何准确率证据**；
 * 真实模型调用未授权，`real` 模式永不回退到本替身。
 */
export function createBranchRecognitionProvider(options: {
  branch: FailureBranch;
  executionMode?: 'stub' | 'preset_demo';
}): RecognitionProvider {
  const executionMode = options.executionMode ?? 'stub';
  const branch = options.branch;
  return {
    executionMode,
    modelVersion: `${executionMode === 'preset_demo' ? 'preset-demo' : 'stub'}-branch-${branch}-v1`,
    available: true,
    unavailableReason: null,
    async recognize() {
      return branchOutcome(branch);
    },
  };
}

/** 分支闭集（供装配层与测试断言，避免两处各写一份清单）。 */
export const PROVIDER_BRANCHES: readonly FailureBranch[] = FAILURE_BRANCHES;
