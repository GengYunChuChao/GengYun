/**
 * GY-I10 标签 OCR 提供者适配层（接口 + 执行模式实现）。
 *
 * 硬约束（派单 §4.4）：
 * - `stub` / `preset_demo`：确定性的**明确标注替身**，绝不冒充真实 OCR；
 *   `model_version` 带 `stub` / `preset-demo` 标记，响应 `meta.execution_mode` 如实为对应模式。
 * - `real`：缺凭据**一律 fail-closed**（`PROVIDER_UNAVAILABLE`），**严禁静默回退替身**；
 *   即使凭据齐备，本片也没有已审真实 OCR 供应商适配器，同样 fail-closed，不伪造成功。
 * - 提供者错误按契约映射：超时 → `PROVIDER_TIMEOUT`，配额 → `PROVIDER_QUOTA_EXCEEDED`，
 *   结果未知/协议违规 → `PROVIDER_OUTCOME_UNKNOWN`，不可用 → `PROVIDER_UNAVAILABLE`。
 *   **不得**把提供者失败写成 `succeeded`。
 *
 * 提供者只负责「产出原始标签字段」，**不决定** MatchState、**不产出**用量卡：
 * 状态由 state.ts 的 `decideMatchState` 判定，用量由 reference.ts 的候选 + gate 决定，
 * 因此提供者无法把缺项/低质输出写成 matched，也无法凭空生成剂量。
 */
import { createHash } from 'node:crypto';
import type { ExecutionMode } from '../contract.ts';
import { createLiveOcrProviderFromConfig, createUnwiredImageSource } from '../ai/ocr-live-adapter.ts';
import { PRODUCT_GATE_AUTHORIZATION } from '../ai/live-gate.ts';
import type { OcrProviderConfig } from '../config.ts';

/** 提供者失败码：必须是契约 ErrorCode 闭集成员。 */
export const PROVIDER_FAILURE_CODES = [
  'PROVIDER_TIMEOUT',
  'PROVIDER_QUOTA_EXCEEDED',
  'PROVIDER_OUTCOME_UNKNOWN',
  'PROVIDER_UNAVAILABLE',
] as const;
export type ProviderFailureCode = (typeof PROVIDER_FAILURE_CODES)[number];

export type ProviderOutcome =
  /** 提供者给出原始标签字段（未校验；由 service 用 normalizeLabelFields 校验）。 */
  | { kind: 'completed'; fields: unknown }
  /** 提供者失败：由 service 映射为 failed / timed_out，绝不落 succeeded。 */
  | { kind: 'failed'; code: ProviderFailureCode };

export interface OcrProvider {
  readonly executionMode: ExecutionMode;
  /** 写入 OCR.model_version；替身必须带明确标注。 */
  readonly modelVersion: string;
  /** false 表示「现在就不该受理」：real 缺凭据时 POST 直接 503，不排队、不回退替身。 */
  readonly available: boolean;
  /** 不可用原因（不含凭据原文）。 */
  readonly unavailableReason: string | null;
  extract(input: { jobId: string; mediaId: string; mediaRevision: number }): Promise<ProviderOutcome>;
}

/**
 * 替身脚本使用的合成登记号（**与真实登记号命名空间刻意不同源**，避免被误读为真实登记资料）。
 * 其中 `PD20210001` / `PD20210002` / `PD20210003` / `PD20210004` 在替身登记库中存在；
 * `PD20210005` 刻意**不存在**于替身登记库（用于构造 ambiguous：靠名称命中多条）。 `PD99999999` 不存在。
 */
export const STUB_REGISTRATION_NUMBERS = {
  matched: 'PD20210001',
  second: 'PD20210002',
  ambiguousByName: 'PD20210005',
  absent: 'PD99999999',
} as const;

/** 替身脚本使用的合成产品名。 */
export const STUB_PRODUCT_NAMES = {
  matched: '替身示例草甘膦水剂',
  ambiguous: '替身示例复配歧义剂',
  absent: '替身示例未收录剂',
} as const;

/** 确定性分桶：同一 media_id 永远得到同一替身脚本（便于复现，不引入随机）。 */
function bucketOf(seed: string, modulo: number): number {
  const digest = createHash('sha256').update(seed).digest();
  return (digest[0] ?? 0) % modulo;
}

/**
 * 替身提供者（`stub` / `preset_demo`）。
 *
 * 脚本按 `mediaId` 的 sha256 分 6 桶，**确定性**、可离线复现，逐桶对应一类可观测结论：
 *   0 → 字段齐全且与替身登记库一致（可判 matched）
 *   1 → 登记号缺失（必要条件未采集 → 必须判 insufficient）
 *   2 → 登记号命中但剂型与登记库不一致（必须判 conflict）
 *   3 → 登记号不在库、名称命中多条（必须判 ambiguous）
 *   4 → 登记号与名称均不在库（必须判 no_match）
 *   5 → 登记号与名称都缺失（必须判 insufficient）
 * 以上均为替身脚本，**不构成任何准确率证据**（标签类真实样本 0，见 docs/evaluation/sample-gap-register.md）。
 */
export function createStubOcrProvider(options: { executionMode?: 'stub' | 'preset_demo' } = {}): OcrProvider {
  const executionMode = options.executionMode ?? 'stub';
  const isDemo = executionMode === 'preset_demo';
  const modelVersion = isDemo ? 'preset-demo-v1' : 'stub-v1';

  const matchedFields = (): Record<string, unknown> => ({
    registration_number: STUB_REGISTRATION_NUMBERS.matched,
    name: STUB_PRODUCT_NAMES.matched,
    ingredients: [{ name: '草甘膦', content_text: '41', unit_text: '%' }],
    dosage_form: '水剂',
  });

  return {
    executionMode,
    modelVersion,
    available: true,
    unavailableReason: null,
    async extract({ mediaId }) {
      if (isDemo) {
        // 预设演示：固定一份字段齐全的标签，明示演示，不走分桶。
        return { kind: 'completed', fields: matchedFields() };
      }
      const bucket = bucketOf(mediaId, 6);
      if (bucket === 1) {
        return {
          kind: 'completed',
          fields: {
            registration_number: null,
            name: STUB_PRODUCT_NAMES.matched,
            ingredients: [{ name: '草甘膦', content_text: '41', unit_text: '%' }],
            dosage_form: '水剂',
          },
        };
      }
      if (bucket === 2) {
        return {
          kind: 'completed',
          fields: {
            registration_number: STUB_REGISTRATION_NUMBERS.matched,
            name: STUB_PRODUCT_NAMES.matched,
            // 与替身登记库的 dosage_form='水剂' 不一致：必须判 conflict，不得 matched。
            dosage_form: '乳油',
            ingredients: [{ name: '草甘膦', content_text: '41', unit_text: '%' }],
          },
        };
      }
      if (bucket === 3) {
        return {
          kind: 'completed',
          fields: {
            registration_number: STUB_REGISTRATION_NUMBERS.ambiguousByName,
            name: STUB_PRODUCT_NAMES.ambiguous,
            ingredients: [{ name: '草甘膦', content_text: '30', unit_text: '%' }],
            dosage_form: '悬浮剂',
          },
        };
      }
      if (bucket === 4) {
        return {
          kind: 'completed',
          fields: {
            registration_number: STUB_REGISTRATION_NUMBERS.absent,
            name: STUB_PRODUCT_NAMES.absent,
            ingredients: [],
            dosage_form: '可溶液剂',
          },
        };
      }
      if (bucket === 5) {
        return {
          kind: 'completed',
          fields: { registration_number: null, name: null, ingredients: [], dosage_form: null },
        };
      }
      return { kind: 'completed', fields: matchedFields() };
    },
  };
}

/**
 * 真实提供者（`real`）。**fail-closed**：
 * - 缺 endpoint/apiKey → `available=false`，POST 直接 503 `PROVIDER_UNAVAILABLE`；
 * - 即使凭据齐备，本片也没有已审真实 OCR 供应商适配器，`extract` 仍返回 `PROVIDER_UNAVAILABLE`；
 * - 任何路径都**不会**回退到 stub/preset_demo 替身。
 */
export function createRealOcrProvider(
  credentials: { endpoint?: string | null; apiKey?: string | null } = {},
  /** 装配层用来如实播报「为什么没有装上真实适配器」；缺省用既有文案（行为不变）。 */
  unavailableReason?: string,
): OcrProvider {
  const endpoint = typeof credentials.endpoint === 'string' && credentials.endpoint.trim() !== '' ? credentials.endpoint.trim() : null;
  const apiKey = typeof credentials.apiKey === 'string' && credentials.apiKey.trim() !== '' ? credentials.apiKey.trim() : null;
  const missing = endpoint === null || apiKey === null;
  return {
    executionMode: 'real',
    modelVersion: 'real-unconfigured',
    available: !missing,
    unavailableReason: missing ? (unavailableReason ?? '缺少真实 OCR 供应商凭据（fail-closed，不回退替身）') : null,
    async extract() {
      // 无已审真实适配器：不伪造结果，也不回退替身。
      return { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' };
    },
  };
}

/**
 * 按执行模式选择提供者。
 *
 * `aiProviders`（GY-R28-W1）：`loadConfig()` 搬来的**被校验快照**（`config.aiProviders.ocr`）。
 * - 不传 / `null` ⇒ 与接线前**逐字节相同**（`real` 走 fail-closed 实现）；
 * - 传了 ⇒ `real` 装上真实适配器（`createLiveOcrProviderFromConfig`）；端口装配失败则回落成
 *   接线前的 fail-closed（**绝不**回退替身）。图片字节由端口提供，产品装配注入的是**未接线**来源
 *   （对象存储属媒体域），因此真实发送是否可达仍由媒体端口把关。
 */
export function createOcrProvider(input: {
  executionMode: ExecutionMode;
  endpoint?: string | null;
  apiKey?: string | null;
  aiProviders?: OcrProviderConfig | null;
}): OcrProvider {
  if (input.executionMode === 'real') {
    const live = input.aiProviders ?? null;
    if (live !== null) {
      try {
        return createLiveOcrProviderFromConfig(live, {
          authorization: PRODUCT_GATE_AUTHORIZATION,
          imageSource: createUnwiredImageSource('真实对象存储未接线：取不到待识别的私有图片字节'),
        });
      } catch {
        return createRealOcrProvider({}, '真实 OCR 端口装配失败（配置不合法；fail-closed，未发包，不回退替身）');
      }
    }
    return createRealOcrProvider({ endpoint: input.endpoint ?? null, apiKey: input.apiKey ?? null });
  }
  return createStubOcrProvider({ executionMode: input.executionMode });
}
