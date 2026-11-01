/**
 * GY-I11 普通话录音与转写域 · 提供者适配层（接口 + 执行模式实现）。
 *
 * 硬约束（派单 §2.4）：
 * - `stub` / `preset_demo`：确定性的**明确标注替身**，绝不冒充真实 ASR；
 *   `model_version` 带 `stub` / `preset-demo` 标记，`note` 明写「替身」。
 * - `real`：缺凭据**一律 fail-closed**（`PROVIDER_UNAVAILABLE`），**严禁静默回退替身**；
 *   凭据齐备且注入被校验快照时**装的是真实适配器**；本文件下方的 `createRealSpeechProvider` 只是端口装配失败时的 fail-closed 兜底。
 * - 提供者错误按契约映射：超时 → `PROVIDER_TIMEOUT`，配额 → `PROVIDER_QUOTA_EXCEEDED`，
 *   结果未知/协议违规 → `PROVIDER_OUTCOME_UNKNOWN`，不可用 → `PROVIDER_UNAVAILABLE`。
 *   **不得**把提供者失败写成 `succeeded`。
 *
 * **证据口径（不得越界声称）**：真实 ASR 样本为 **0**（`docs/evaluation/sample-gap-register.md`
 * 的 `asr_utterances`、`asr_speakers` 均为 0），因此本文件与全域**不产生、不声称任何准确率
 * 或转写质量结论**。替身脚本只是离线联调夹具，逐桶构造的是**可观测的契约行为**
 * （正常 / 空 / 上限 / 超限 / 畸形），不是识别效果。
 *
 * 提供者只负责「产出原始文本 + 如实上报不确定区间」，**不决定**任务终态、
 * **不裁剪也不补造** `uncertain_spans`：形状与区间校验在 state.ts，
 * 终态判定在 service.ts，因此提供者无法把自己的畸形输出写成 succeeded。
 */
import { createHash } from 'node:crypto';
import type { ExecutionMode } from '../contract.ts';
import { createLiveSpeechProviderFromConfig } from '../ai/asr-live-adapter.ts';
import { createObjectStoreAudioSource, type ObjectStoreAudioSourceOptions } from '../ai/asr-audio-source.ts';
import { PRODUCT_GATE_AUTHORIZATION } from '../ai/live-gate.ts';
import type { AsrProviderConfig } from '../config.ts';

/**
 * `failed` 结局可携带的错误码闭集：**必须是契约 `ErrorCode` 闭集成员**（不新造码）。
 *
 * 口径（GY-R72-I11 起）：这里收的不再是「供应商故障」一种，而是适配器**能如实上报的
 * 失败结局**，因此分两类：
 * - `PROVIDER_*` 四条：真打了供应商或真打不了供应商；
 * - `MEDIA_TYPE_UNSUPPORTED`：**没发包**的本地判定——拿到的字节是另一种音频容器（如 MP3），
 *   而本域只有 WAV 一个载体（不裁剪、不转码）。它是客户端可修复的格式问题（415），
 *   不是「供应商不可用」，因此不得再伪装成 `PROVIDER_UNAVAILABLE`。
 */
export const PROVIDER_FAILURE_CODES = [
  'PROVIDER_TIMEOUT',
  'PROVIDER_QUOTA_EXCEEDED',
  'PROVIDER_OUTCOME_UNKNOWN',
  'PROVIDER_UNAVAILABLE',
  'MEDIA_TYPE_UNSUPPORTED',
] as const;
export type ProviderFailureCode = (typeof PROVIDER_FAILURE_CODES)[number];

export type ProviderOutcome =
  /**
   * 提供者给出转写载荷（**未校验**；由 service 用 `requireTranscriptText` +
   * `normalizeUncertainSpans` 校验）。载荷形状（适配层约定，非契约字段）：
   * `{ text: unknown; uncertain_spans: unknown }` —— 两键都必须**显式出现**，
   * 缺 `uncertain_spans` 会被判协议违规而不是被默认成空数组（不得补造）。
   */
  | { kind: 'completed'; transcript: unknown }
  /**
   * 提供者明确表示**无法判定**文本（如无有效语音、置信不足）。
   * 由 service 落 `uncertain` 终态并**不产生**转写记录：不编造文本。
   */
  | { kind: 'uncertain'; reason: string }
  /** 提供者失败：由 service 映射为 failed / timed_out，绝不落 succeeded。 */
  | { kind: 'failed'; code: ProviderFailureCode };

export interface SpeechProvider {
  readonly executionMode: ExecutionMode;
  /** 写入 `Transcription.model_version`；替身必须带明确标注。 */
  readonly modelVersion: string;
  /** 供证据/诊断引用的如实标注（替身说明，或真实适配器缺失说明）；不含任何凭据原文。 */
  readonly note: string;
  /** false 表示「现在就不该受理」：real 缺凭据时受理直接 503，不排队、不回退替身。 */
  readonly available: boolean;
  /** 不可用原因（不含凭据原文）。 */
  readonly unavailableReason: string | null;
  transcribe(input: { jobId: string; mediaId: string; mediaRevision: number }): Promise<ProviderOutcome>;
}

/** 确定性分桶：同一 `media_id` 永远得到同一替身脚本（可离线复现，不引入随机）。 */
function bucketOf(seed: string, modulo: number): number {
  const digest = createHash('sha256').update(seed).digest();
  return (digest[0] ?? 0) % modulo;
}

/** 替身文案前缀：所有替身文本与原因都带此前缀，避免被误读为真实转写内容。 */
export const STUB_TRANSCRIPT_PREFIX = '替身示例·合成转写（非真实录音）';

/** 替身脚本的桶位常量（供测试按同一口径构造输入）。 */
export const STUB_BUCKETS = {
  /** 正常：有文本 + 2 个不确定区间。 */
  normal: 0,
  /** 全置信：有文本 + 0 个不确定区间。 */
  confident: 1,
  /** 静默/空转写：空文本（service 必须落 uncertain 且不写记录）。 */
  silent: 2,
  /** 上限：恰好 100 个不确定区间（= 契约 maxItems）。 */
  spansAtLimit: 3,
  /** 超限：8001 码点文本（service 必须 fail-closed，不得截断）。 */
  tooLong: 4,
  /** 畸形：`start >= end` 的区间（service 必须 fail-closed，不得自动交换两端）。 */
  malformedSpan: 5,
} as const;

/** 契约 `uncertain_spans` 上限用例使用的不确定区间条数（= maxItems）。 */
export const STUB_SPAN_LIMIT = 100;

/** 超长用例的文本码点数（= maxLength + 1，刻意只超 1 个码点以证明边界被卡住）。 */
export const STUB_TOO_LONG_CODE_POINTS = 8001;

function normalTranscript(): unknown {
  return {
    text: `${STUB_TRANSCRIPT_PREFIX}：稻田稗草三到五叶期，请问题应该用什么药。`,
    uncertain_spans: [
      { start: 0, end: 8, reason: '替身示例·开头为合成前缀，非真实语音内容' },
      { start: 24, end: 26, reason: '替身示例·生育期表述可能识别偏差' },
    ],
  };
}

function spansAtLimitTranscript(): unknown {
  const spans: Array<{ start: number; end: number; reason: string }> = [];
  for (let index = 0; index < STUB_SPAN_LIMIT; index += 1) {
    spans.push({ start: index * 4, end: index * 4 + 2, reason: `替身示例·上限用例第 ${index + 1} 段` });
  }
  return {
    text: `${STUB_TRANSCRIPT_PREFIX}·上限用例`.repeat(4) + '。'.repeat(400),
    uncertain_spans: spans,
  };
}

/**
 * 替身提供者（`stub` / `preset_demo`）。
 *
 * 脚本按 `mediaId` 的 sha256 分 6 桶（见 `STUB_BUCKETS`），**确定性**、可离线复现，
 * 逐桶对应一类**可观测的契约行为**（不是识别效果，也不构成任何准确率证据）。
 */
export function createStubSpeechProvider(options: { executionMode?: 'stub' | 'preset_demo' } = {}): SpeechProvider {
  const executionMode = options.executionMode ?? 'stub';
  const isDemo = executionMode === 'preset_demo';
  const modelVersion = isDemo ? 'preset-demo-v1' : 'stub-v1';
  const note = isDemo
    ? '预设演示替身 ASR（合成文本，非真实录音、非真实供应商，不构成任何准确率证据）'
    : '替身 ASR（合成文本，非真实录音、非真实供应商，不构成任何准确率证据）';

  return {
    executionMode,
    modelVersion,
    note,
    available: true,
    unavailableReason: null,
    async transcribe({ mediaId }) {
      if (isDemo) {
        // 预设演示：固定一份「有文本 + 1 个不确定区间」的转写，明示演示，不走分桶。
        return {
          kind: 'completed',
          transcript: {
            text: `${STUB_TRANSCRIPT_PREFIX}：这是预设演示用的一句话。`,
            uncertain_spans: [{ start: 0, end: 8, reason: '替身示例·开头为合成前缀，非真实语音内容' }],
          },
        };
      }
      const bucket = bucketOf(mediaId, 6);
      if (bucket === STUB_BUCKETS.confident) {
        return {
          kind: 'completed',
          transcript: { text: `${STUB_TRANSCRIPT_PREFIX}：全置信用例文本。`, uncertain_spans: [] },
        };
      }
      if (bucket === STUB_BUCKETS.silent) {
        // 空文本：service 必须判「无可用转写」⇒ uncertain 终态，且不写记录、不编造文本。
        return { kind: 'completed', transcript: { text: '', uncertain_spans: [] } };
      }
      if (bucket === STUB_BUCKETS.spansAtLimit) {
        return { kind: 'completed', transcript: spansAtLimitTranscript() };
      }
      if (bucket === STUB_BUCKETS.tooLong) {
        // 8001 码点：service 必须 fail-closed（不得截断成 8000 后当成功）。
        return {
          kind: 'completed',
          transcript: { text: '替'.repeat(STUB_TOO_LONG_CODE_POINTS), uncertain_spans: [] },
        };
      }
      if (bucket === STUB_BUCKETS.malformedSpan) {
        // start >= end：service 必须 fail-closed（不得交换两端、不得丢弃该区间）。
        return {
          kind: 'completed',
          transcript: {
            text: `${STUB_TRANSCRIPT_PREFIX}：畸形区间用例文本。`,
            uncertain_spans: [{ start: 9, end: 4, reason: '替身示例·故意倒置的区间' }],
          },
        };
      }
      return { kind: 'completed', transcript: normalTranscript() };
    },
  };
}

/**
 * 真实提供者（`real`）。**fail-closed**：
 * - 缺 endpoint/apiKey → `available=false`，受理直接 503 `PROVIDER_UNAVAILABLE`；
 * - 本函数**不持有**真实适配器（它是端口装配失败/无快照时的兜底），`transcribe` 仍返回
 *   `PROVIDER_UNAVAILABLE`，任务落 `failed`；
 * - 任何路径都**不会**回退到 stub/preset_demo 替身（回退会让证据口径被污染）。
 */
export function createRealSpeechProvider(
  credentials: { endpoint?: string | null; apiKey?: string | null } = {},
  /** 装配层用来如实播报「为什么没有装上真实适配器」；缺省用既有文案（行为不变）。 */
  unavailableReason?: string,
): SpeechProvider {
  const endpoint =
    typeof credentials.endpoint === 'string' && credentials.endpoint.trim() !== '' ? credentials.endpoint.trim() : null;
  const apiKey = typeof credentials.apiKey === 'string' && credentials.apiKey.trim() !== '' ? credentials.apiKey.trim() : null;
  const missing = endpoint === null || apiKey === null;
  return {
    executionMode: 'real',
    modelVersion: 'real-unconfigured',
    note: '真实 ASR 适配器尚未接入（无已审供应商适配器；缺凭据即受理前 fail-closed，不回退替身）',
    available: !missing,
    unavailableReason: missing ? (unavailableReason ?? '缺少真实 ASR 供应商凭据（fail-closed，不回退替身）') : null,
    async transcribe() {
      // 无已审真实适配器：不伪造结果，也不回退替身。
      return { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' };
    },
  };
}

/**
 * 按执行模式选择提供者。
 *
 * `aiProviders`（GY-R28-W1）：`loadConfig()` 搬来的**被校验快照**（`config.aiProviders.asr`）。
 * - 不传 / `null` ⇒ 与接线前**逐字节相同**（`real` 走 fail-closed 实现）；
 * - 传了 ⇒ `real` 装上真实适配器（`createLiveSpeechProviderFromConfig`）；端口装配失败则回落成
 *   接线前的 fail-closed（**绝不**回退替身）。
 *
 * **录音字节来源（GY-I11 本片）**：`audioSource` 一律由
 * `createObjectStoreAudioSource({@link audioMedia})` 构造 —— 注入端口齐备时它按
 * `jobId → 任务归属 → media_id+revision → 媒体登记册 → 对象存储` 取字节（含归属校验与
 * 字节身份校验）；端口未配置时它**仍是同一个实现**的 `unwired` 形态，恒返回 `null`
 * ⇒ 适配器按既有口径落 `failed PROVIDER_UNAVAILABLE`（未发包、不占预算）。
 * ⛔ 任何情况下都不读 ambient env、不回退磁盘默认路径、不返回"猜的"字节。
 */
export function createSpeechProvider(input: {
  executionMode: ExecutionMode;
  endpoint?: string | null;
  apiKey?: string | null;
  aiProviders?: AsrProviderConfig | null;
  /**
   * 录音字节来源的三个注入端口（`speech/store.ts` 的 store、`media/store.ts` 的登记册、
   * `media/object-store.ts` 的对象存储）。**未给 / 给不全 ⇒ 端口未配置 ⇒ fail-closed**
   * （`PROVIDER_UNAVAILABLE`），绝不用替身或空字节顶上。
   */
  audioMedia?: ObjectStoreAudioSourceOptions;
}): SpeechProvider {
  if (input.executionMode === 'real') {
    const live = input.aiProviders ?? null;
    if (live !== null) {
      try {
        return createLiveSpeechProviderFromConfig(live, {
          authorization: PRODUCT_GATE_AUTHORIZATION,
          audioSource: createObjectStoreAudioSource(input.audioMedia),
        });
      } catch {
        return createRealSpeechProvider({}, '真实 ASR 端口装配失败（配置不合法；fail-closed，未发包，不回退替身）');
      }
    }
    return createRealSpeechProvider({ endpoint: input.endpoint ?? null, apiKey: input.apiKey ?? null });
  }
  return createStubSpeechProvider({ executionMode: input.executionMode });
}
