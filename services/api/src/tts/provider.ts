/**
 * GY-I13 普通话 TTS 合成域 · 提供者适配层（接口 + 执行模式实现）。
 *
 * 硬约束（派单 §2.5、§2.7）：
 * - `stub` / `preset_demo`：确定性的**明确标注替身**，**绝不冒充真实 TTS**；
 *   产物 `contentType` 是非音频的标注类型，`substitute=true`，正文是明文的「不可播放」标注，
 *   **不产生任何音频字节**，也不声称任何合成质量／音色／自然度结论。
 * - `real`：缺凭据一律 **fail-closed**（`available=false` ⇒ 受理前 503 `PROVIDER_UNAVAILABLE`）；
 *   即使凭据齐备，本片也没有已审真实 TTS 供应商适配器，`synthesize` 仍返回
 *   `PROVIDER_UNAVAILABLE`（任务落 `failed`），**严禁静默回退替身**。
 * - 提供者错误按契约映射：超时 → `PROVIDER_TIMEOUT`（任务 `timed_out`），
 *   配额 → `PROVIDER_QUOTA_EXCEEDED`，结果未知 → `PROVIDER_OUTCOME_UNKNOWN`，
 *   不可用 → `PROVIDER_UNAVAILABLE`。**不得**把提供者失败写成 `succeeded`。
 *
 * **证据口径（不得越界声称）**：真实 TTS 样本为 **0**
 * （`docs/evaluation/sample-gap-register.md` 的 `tts` 要求 30 段、实际 0），
 * 因此本文件与全域**不产生、不声称任何合成质量、音色、自然度或听感结论**；
 * 替身产物不是音频，不能播放，也不能当作任何语音证据。
 */
import type { ExecutionMode } from '../contract.ts';

/** 提供者失败码：必须是契约 ErrorCode 闭集成员。 */
export const PROVIDER_FAILURE_CODES = [
  'PROVIDER_TIMEOUT',
  'PROVIDER_QUOTA_EXCEEDED',
  'PROVIDER_OUTCOME_UNKNOWN',
  'PROVIDER_UNAVAILABLE',
] as const;
export type ProviderFailureCode = (typeof PROVIDER_FAILURE_CODES)[number];

export type TtsProviderOutcome =
  /**
   * 提供者给出产物（**未校验**；由 service 用 `requireSynthesisArtifact` 校验形状与
   * 「替身不得伪装成真实音频」）。形状为适配层约定，不是契约字段。
   */
  | { kind: 'completed'; artifact: unknown }
  /** 提供者失败：由 service 映射为 `failed` / `timed_out`，绝不落 `succeeded`。 */
  | { kind: 'failed'; code: ProviderFailureCode };

export interface TtsProvider {
  readonly executionMode: ExecutionMode;
  /** 提供者／音色版本标识，只写入内部记录与诊断，**不进**契约 `Synthesis`（契约没有该字段）。 */
  readonly providerVersion: string;
  /** 供证据／诊断引用的如实标注（替身说明，或真实适配器缺失说明）；不含任何凭据原文。 */
  readonly note: string;
  /** false 表示「现在就不该受理」：real 缺凭据时受理直接 503，不排队、不回退替身。 */
  readonly available: boolean;
  /** 不可用原因（不含凭据原文）。 */
  readonly unavailableReason: string | null;
  synthesize(input: {
    jobId: string;
    /** **服务端**从已核对内容读出的正文；提供者不得接受任何客户端文本。 */
    text: string;
    locale: string;
    targetRef: { type: string; id: string; revision: number };
  }): Promise<TtsProviderOutcome>;
}

/** 替身产物的 MIME 类型：明确标注的**非音频**类型（不得伪装成 audio/*）。 */
export const SUBSTITUTE_ARTIFACT_CONTENT_TYPE = 'application/x-gengyun-tts-substitute';

/** 替身产物正文前缀：所有替身字节都带此前缀，避免被误读成真实音频。 */
export const SUBSTITUTE_ARTIFACT_PREFIX = '替身占位产物（非真实音频、不可播放、非真实供应商）';

/** 替身产物的固定标注正文（**不是**音频字节，没有任何 MP3/ID3 头）。 */
export function substituteArtifactBody(targetRef: { type: string; id: string; revision: number }, text: string): Uint8Array {
  const marker = [
    SUBSTITUTE_ARTIFACT_PREFIX,
    `目标：${targetRef.type}/${targetRef.id}#${targetRef.revision}`,
    `将要朗读的正文码点数：${[...text].length}`,
    '如需真实音频，必须先接线已审真实 TTS 适配器；本文件不生成音频。',
  ].join('\n');
  return new TextEncoder().encode(marker);
}

/**
 * 替身提供者（`stub` / `preset_demo`）：**确定性**地返回同一份标注产物形状，
 * 不引入随机、不读取任何真实音频、不伪造时长或音色。
 */
export function createStubTtsProvider(options: { executionMode?: 'stub' | 'preset_demo' } = {}): TtsProvider {
  const executionMode = options.executionMode ?? 'stub';
  const isDemo = executionMode === 'preset_demo';
  const providerVersion = isDemo ? 'preset-demo-tts-v1' : 'stub-tts-v1';
  const note = isDemo
    ? '预设演示替身 TTS（**非真实音频**、非真实供应商；不构成任何合成质量或听感证据）'
    : '替身 TTS（**非真实音频**、非真实供应商；不构成任何合成质量或听感证据）';

  return {
    executionMode,
    providerVersion,
    note,
    available: true,
    unavailableReason: null,
    async synthesize({ text, targetRef }) {
      return {
        kind: 'completed',
        artifact: {
          contentType: SUBSTITUTE_ARTIFACT_CONTENT_TYPE,
          body: substituteArtifactBody(targetRef, text),
          substitute: true,
        },
      };
    },
  };
}

/**
 * 真实提供者（`real`）。**fail-closed**：
 * - 缺 endpoint/apiKey → `available=false`，受理直接 503 `PROVIDER_UNAVAILABLE`；
 * - 即使凭据齐备，本片也没有已审真实 TTS 供应商适配器，`synthesize` 仍返回
 *   `PROVIDER_UNAVAILABLE`，任务落 `failed`；
 * - 任何路径都**不会**回退到 stub/preset_demo 替身（回退会让证据口径被污染）。
 */
export function createRealTtsProvider(credentials: { endpoint?: string | null; apiKey?: string | null } = {}): TtsProvider {
  const endpoint =
    typeof credentials.endpoint === 'string' && credentials.endpoint.trim() !== '' ? credentials.endpoint.trim() : null;
  const apiKey = typeof credentials.apiKey === 'string' && credentials.apiKey.trim() !== '' ? credentials.apiKey.trim() : null;
  const missing = endpoint === null || apiKey === null;
  return {
    executionMode: 'real',
    providerVersion: 'real-unconfigured',
    note: '真实 TTS 适配器尚未接入（无已审供应商适配器；缺凭据即受理前 fail-closed，不回退替身）',
    available: !missing,
    unavailableReason: missing ? '缺少真实 TTS 供应商凭据（fail-closed，不回退替身）' : null,
    async synthesize() {
      // 无已审真实适配器：不伪造音频，也不回退替身。
      return { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' };
    },
  };
}

/** 按执行模式选择提供者；`real` 永远走 fail-closed 实现。 */
export function createTtsProvider(input: {
  executionMode: ExecutionMode;
  endpoint?: string | null;
  apiKey?: string | null;
}): TtsProvider {
  if (input.executionMode === 'real') {
    return createRealTtsProvider({ endpoint: input.endpoint ?? null, apiKey: input.apiKey ?? null });
  }
  return createStubTtsProvider({ executionMode: input.executionMode });
}
