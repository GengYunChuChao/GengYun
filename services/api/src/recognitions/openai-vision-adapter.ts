/**
 * GY-R79 · 第二个识别供应商剖面：`openai-vision-v1`（ADR-002 选项 A 的骨架）。
 *
 * 与 `live-adapter.ts` 的 `gy-recognition-live-v1` **并列而非替换**：两者都实现
 * `RecognitionProvider`，由 `recognitions/provider.ts` 按 `RECOGNITION_PROVIDER_PROFILE`
 * 选择，未配置即走既有剖面（行为不变）。
 *
 * ## 与既有剖面的区别
 * - 请求体是 OpenAI 兼容的 `chat/completions`：`messages[0].content` 里带
 *   `{"type":"image_url","image_url":{"url":"data:<mime>;base64,..."}}`；
 * - 回包是 `choices[0].message.content` 里的一段 JSON（`response_format: json_object`），
 *   本适配器负责把它解析成 `candidates`；
 * - **不依赖 `request_id`**：只认 `choices[0].message.content` 里的 JSON；HTTP 200 且可解析即 `completed`，
 *   解析不出来才判「结果未知」（`RESPONSE_EVIDENCE_INCOMPLETE` + `PROVIDER_OUTCOME_UNKNOWN`）。
 *
 * ## 三条硬约束（与既有剖面一致，逐条保留）
 * 1. **字节只来自注入端口**（`RecognitionImageSource`），不读磁盘、不读对象存储默认值；
 * 2. **只产出候选与原因，不决定任务状态**：状态仍由 `recognitions/state.ts` 的 `decideOutcome` 判定；
 * 3. **绝不发明错误码**：只返回 `PROVIDER_FAILURE_CODES` 的四个成员。
 *
 * ## 证据口径（不得外推）
 * 本文件是**骨架**：零真实供应商、零真实调用、零准确率证据。单测只喂假 `fetchImpl`，不联网。
 */
import type { ProviderOutcome, RecognitionProvider } from './provider.ts';
import { RECOGNITION_GATE_AUTHORIZATION, RecognitionWiringError, createProcessRecognitionGate } from './live-ports.ts';
import type { LiveRecognitionObservation, RealRecognitionPorts, RecognitionImageSource } from './live-ports.ts';
import type { ProviderCallState } from '../tts/live-ports.ts';
import { assertRecognitionEndpoint, requireLiveRecognitionImage } from './live-adapter.ts';
import { liveGateRefusalToErrorCode } from '../tts/live-ports.ts';
import { providerConfigVersionOf, readCallMetadata } from './call-metadata.ts';

/**
 * 带记账元数据的识别结果。
 *
 * 用**本文件局部**的交叉类型，而不是给 `provider.ts` 的 `ProviderOutcome` 加可选字段：
 * `usage` 与 `providerConfigVersion` 只服务记账（`privacy/media-call-accounting.ts` 按可选属性读，
 * 读不到就记 `null` / `unknown`），不该扩公共契约面 —— 一旦写进 `ProviderOutcome`，
 * 每个识别提供者都得为「本基线没有的」字段表态。
 *
 * ⛔ `usage` 是**未收口**的外来数据：形状由 `readCallMetadata` 收口后才落库（迁移 0055 的
 * `usage` 列还有 `jsonb_typeof = 'object'` 兜底）。
 */
type OpenAiVisionOutcome = ProviderOutcome & { usage?: unknown; providerConfigVersion?: string };

/** 剖面名（也写入 `model_version`：本基线没有已审供应商，绝不写一个模型名冒充能力主张）。 */
export const OPENAI_VISION_PROTOCOL = 'openai-vision-v1';

/**
 * 冻结剖面。`endpoint` / `model` 由运维显式给出（本基线没有已审供应商），
 * 其余字段冻结：任何一项被改动都必须在评审里显式说明。
 */
export const OPENAI_VISION_FROZEN_PROFILE = Object.freeze({
  protocol: OPENAI_VISION_PROTOCOL,
  /** 与媒体域口径一致：`packages/media/constants.mjs` 的 `MEDIA_PURPOSE_MAX_BYTES.weed_recognition` = 2 MiB。 */
  maxImageBytes: 2 * 1024 * 1024,
  mediaTransport: 'inlineDataUrl' as const,
  minTimeoutMs: 1000,
  maxTimeoutMs: 20000,
  defaultTimeoutMs: 15000,
  /** 契约 `RecognitionResult.candidates` 至多 3 条。 */
  maxCandidates: 3,
  maxRetries: 0,
  temperature: 0,
  maxTokens: 512,
} as const);

/** 本剖面对候选分数的写入字段名（契约字段由 `decideOutcome` 校验，这里只填）。 */
const CANDIDATE_KEY_SPECIES = 'species_id';
const CANDIDATE_KEY_SCORE = 'model_score';

/**
 * 闭集提示词：模型只能在给定 id 里选，或回答没有植物。
 *
 * 为什么不给拉丁名映射：`species_id` 是客户端目录的主键，任何「拉丁名→id」的猜测都会
 * 把「模型见过这个物种」与「目录里有这个物种」混为一谈（`#1003` 的原始事故）。
 */
export function buildOpenAiVisionPrompt(speciesIds: readonly string[]): string {
  const ids = speciesIds.map((id) => id.trim()).filter((id) => id !== '');
  return [
    '你是农田杂草识别助手。只输出 JSON，不要解释。',
    `允许的 species_id 只能取以下列表之一：${ids.join('、')}。`,
    '如果画面里没有植物主体，species_id 写 "none"。',
    '如果有植物主体，必须从列表里选最接近的一类，并在 reason 里写你看到的形态差异。',
    '输出格式：{"species_id":"<其中一个 id 或 none>","confidence":<0 到 1 的小数>,"reason":"<不超过 40 字>"}',
  ].join('\n');
}

/** 允许的候选 id 集合（空集合 ⇒ 构造期拒绝：闭集为空等于没给约束）。 */
export type OpenAiVisionOptions = {
  endpoint: string;
  apiKey: string;
  model: string;
  speciesIds: readonly string[];
  imageSource: RecognitionImageSource;
  authorization?: string;
  liveGate?: RealRecognitionPorts['liveGate'];
  fetchImpl?: typeof fetch;
  now?: () => number;
  onObservation?: (observation: LiveRecognitionObservation) => void;
};

function errorCodeForStatus(status: number): 'PROVIDER_QUOTA_EXCEEDED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_OUTCOME_UNKNOWN' {
  if (status === 429) return 'PROVIDER_QUOTA_EXCEEDED';
  if (status === 401 || status === 403 || status >= 500) return 'PROVIDER_UNAVAILABLE';
  return 'PROVIDER_OUTCOME_UNKNOWN';
}

/** 从 `message.content` 里取出 JSON（模型常把 JSON 包在 ```json 围栏里）。 */
function parseContentJson(content: unknown): Record<string, unknown> | null {
  if (typeof content !== 'string' || content.trim() === '') return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content);
  const text = (fenced ? (fenced[1] ?? content) : content).trim();
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 把模型的一段回答收成 `candidates`（闭集过滤 + 分数夹紧 + 上限截断）。 */
export function normalizeOpenAiVisionCandidates(
  payload: Record<string, unknown>,
  allowedIds: readonly string[],
): Array<Record<string, unknown>> {
  const allowed = new Set(allowedIds.map((id) => id.trim()).filter((id) => id !== ''));
  const raw = payload['candidates'];
  const list: Array<Record<string, unknown>> = [];
  if (Array.isArray(raw)) {
    // 兼容 `{"candidates":[...]}` 形状。
    for (const item of raw) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) list.push(item as Record<string, unknown>);
    }
  } else {
    // 兼容单条 `{"species_id":...,"confidence":...}` 形状。
    list.push(payload);
  }
  const picked: Array<{ id: string; score: number }> = [];
  for (const item of list) {
    const rawId = item[CANDIDATE_KEY_SPECIES];
    if (typeof rawId !== 'string') continue;
    const id = rawId.trim();
    if (id === '' || id === 'none') continue;
    if (!allowed.has(id)) continue;
    const rawScore = item['confidence'] ?? item[CANDIDATE_KEY_SCORE];
    const score = typeof rawScore === 'number' && Number.isFinite(rawScore) ? Math.min(1, Math.max(0, rawScore)) : 0;
    picked.push({ id, score });
  }
  picked.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const item of picked) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push({ [CANDIDATE_KEY_SPECIES]: item.id, rank: out.length + 1, [CANDIDATE_KEY_SCORE]: item.score });
    if (out.length >= OPENAI_VISION_FROZEN_PROFILE.maxCandidates) break;
  }
  return out;
}

/**
 * 闭集的规范化：去空白、去空串，**不做任何裁剪或截断**。
 *
 * 单独导出是为了让「闭集只能来自入参、且必须原样全量保留」这件事可被测试直接断言
 * （`#1014`：只保留首个 id 的回归必须能让用例变红）。
 */
export function openAiVisionAllowedIds(speciesIds: readonly string[]): readonly string[] {
  return speciesIds.map((id) => id.trim()).filter((id) => id !== '');
}

/**
 * 构造 `openai-vision-v1` 提供者。
 *
 * 构造期不合法（端点非 https、模型名空、闭集空、超时越界）⇒ **抛** `RecognitionWiringError`，
 * 由 `recognitions/provider.ts` 回落 fail-closed，⛔ 绝不回退替身。
 */
function r80Observation(partial: Partial<LiveRecognitionObservation> & { state: ProviderCallState }): LiveRecognitionObservation {
  return {
    protocol: OPENAI_VISION_PROTOCOL,
    errorCode: null,
    providerErrorCode: null,
    httpStatus: null,
    requestId: null,
    candidateCount: null,
    imageBytes: null,
    resultMayHaveBeenProcessed: true,
    elapsedMs: 0,
    endpointAsserted: true,
    sendAttempts: 1,
    ...partial,
  };
}

export function createOpenAiVisionRecognitionProvider(options: OpenAiVisionOptions): RecognitionProvider {
  if (options === null || typeof options !== 'object') {
    throw new RecognitionWiringError('openai-vision 装配缺少入参（fail-closed）');
  }
  const endpoint = assertRecognitionEndpoint(options.endpoint);
  if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
    throw new RecognitionWiringError('openai-vision 缺少 apiKey（fail-closed，未发包）');
  }
  const model = typeof options.model === 'string' ? options.model.trim() : '';
  if (model === '') throw new RecognitionWiringError('openai-vision 缺少模型名（fail-closed，未发包）');
  const allowedIds = openAiVisionAllowedIds(options.speciesIds);
  if (allowedIds.length === 0) {
    throw new RecognitionWiringError('openai-vision 的闭集物种列表为空（等于没有任何约束，fail-closed）');
  }
  const imageSource = options.imageSource;
  if (imageSource === null || typeof imageSource !== 'object' || typeof imageSource.read !== 'function') {
    throw new RecognitionWiringError('openai-vision 缺少图片字节来源端口（fail-closed）');
  }
  const authorization = options.authorization ?? RECOGNITION_GATE_AUTHORIZATION;
  const liveGate = options.liveGate ?? createProcessRecognitionGate({ authorization });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? ((): number => Date.now());
  const prompt = buildOpenAiVisionPrompt(allowedIds);
  const timeoutMs = OPENAI_VISION_FROZEN_PROFILE.defaultTimeoutMs;
  /**
   * 剖面版本串：`<剖面>#<模型>@<端点主机摘要8>`（构造期算一次，不逐次重算）。
   * 只含主机名的 8 字符 sha256 前缀 —— ⛔ 端点原文/路径/query/凭据都不出现；
   * 形状不合法时 `providerConfigVersionOf` 自己降级（先丢掉主机摘要，再退到剖面名）。
   */
  const providerConfigVersion = providerConfigVersionOf(OPENAI_VISION_PROTOCOL, model, endpoint);

  return {
    executionMode: 'real',
    modelVersion: OPENAI_VISION_PROTOCOL,
    available: true,
    unavailableReason: null,
    async recognize({ jobId, mediaId, mediaRevision }): Promise<OpenAiVisionOutcome> {
      // ① build（本地）：本地拒绝不占预算、不建连。
      let image: Uint8Array;
      try {
        const raw = await imageSource.read({ mediaId, mediaRevision });
        image = requireLiveRecognitionImage(raw, OPENAI_VISION_FROZEN_PROFILE.maxImageBytes);
      } catch {
        return { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' };
      }
      const startedAt = now();
      const body = JSON.stringify({
        model,
        temperature: OPENAI_VISION_FROZEN_PROFILE.temperature,
        max_tokens: OPENAI_VISION_FROZEN_PROFILE.maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: { url: `data:${contentTypeOf(image)};base64,${Buffer.from(image).toString('base64')}` },
              },
            ],
          },
        ],
      });

      // ② reserve（闸门，必须在建连之前）。
      let ticket;
      try {
        ticket = await liveGate.reserve({ authorization, attemptKey: `${jobId}:${mediaId}#${mediaRevision}` });
      } catch (error) {
        return { kind: 'failed', code: liveGateRefusalToErrorCode(error) };
      }

      // ③ send（恰好一次）。
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          body,
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${options.apiKey}`,
            'x-gy-protocol': OPENAI_VISION_PROTOCOL,
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const name = (error as { name?: unknown } | null)?.name;
        const timedOut = name === 'TimeoutError' || name === 'AbortError';
        await liveGate.settle(ticket, {
          state: timedOut ? 'TIMEOUT' : 'OUTCOME_UNKNOWN',
          providerErrorCode: timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_OUTCOME_UNKNOWN',
          resultMayHaveBeenProcessed: true,
        });
        options.onObservation?.(r80Observation({ state: timedOut ? 'TIMEOUT' : 'OUTCOME_UNKNOWN', providerErrorCode: timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_OUTCOME_UNKNOWN', resultMayHaveBeenProcessed: true, elapsedMs: now() - startedAt, candidateCount: 0 }));
        return { kind: 'failed', code: timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_OUTCOME_UNKNOWN' };
      }

      if (!response.ok) {
        const failureCode = errorCodeForStatus(response.status);
        await liveGate.settle(ticket, { state: 'HTTP_ERROR', providerErrorCode: failureCode, resultMayHaveBeenProcessed: response.status >= 500 });
        options.onObservation?.(r80Observation({ state: 'HTTP_ERROR', providerErrorCode: failureCode, httpStatus: response.status, elapsedMs: now() - startedAt, candidateCount: 0 }));
        return { kind: 'failed', code: failureCode };
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        await liveGate.settle(ticket, { state: 'OUTCOME_UNKNOWN', providerErrorCode: 'PROVIDER_OUTCOME_UNKNOWN', resultMayHaveBeenProcessed: true });
        return { kind: 'failed', code: 'PROVIDER_OUTCOME_UNKNOWN' };
      }
      const root = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
      const choices = root === null ? null : root['choices'];
      const first = Array.isArray(choices) && choices.length > 0 ? choices[0] : null;
      const message = first !== null && typeof first === 'object' ? (first as Record<string, unknown>)['message'] : null;
      const content = message !== null && typeof message === 'object' ? (message as Record<string, unknown>)['content'] : null;
      const parsed = parseContentJson(content);
      if (parsed === null) {
        // 供应商回了 200 但没给出可解析的候选 ⇒ 结果未知（绝不把「没读懂」当成功）。
        await liveGate.settle(ticket, { state: 'RESPONSE_EVIDENCE_INCOMPLETE', providerErrorCode: 'PROVIDER_OUTCOME_UNKNOWN', resultMayHaveBeenProcessed: true });
        options.onObservation?.(r80Observation({ state: 'RESPONSE_EVIDENCE_INCOMPLETE', providerErrorCode: 'PROVIDER_OUTCOME_UNKNOWN', httpStatus: response.status, elapsedMs: now() - startedAt, candidateCount: 0 }));
        return { kind: 'failed', code: 'PROVIDER_OUTCOME_UNKNOWN' };
      }

      // ④ settle（无论成败）。
      const candidates = normalizeOpenAiVisionCandidates(parsed, allowedIds);
      await liveGate.settle(ticket, { state: 'BUSINESS_RESPONSE', providerErrorCode: null, resultMayHaveBeenProcessed: true });
      options.onObservation?.(
        r80Observation({
          state: 'BUSINESS_RESPONSE',
          httpStatus: response.status,
          elapsedMs: now() - startedAt,
          candidateCount: candidates.length,
        }),
      );
      const reason = typeof parsed['reason'] === 'string' ? parsed['reason'] : '';
      if (candidates.length === 0) {
        // 空候选是「正常调用但没结果」：本分支**不**上报 `no_result`（那由调用方按 `branch` 语义决定），
        // 终态仍由 `decideOutcome` 判 `uncertain`；reason 截断到 80 字符，避免超长文案让终态判定抛协议违规。
        return { kind: 'completed', candidates: [], uncertainty_reasons: [reason === '' ? '模型未返回任何候选' : reason.slice(0, 80)], usage: readCallMetadata(root), providerConfigVersion };
      }
      return { kind: 'completed', candidates, usage: readCallMetadata(root), providerConfigVersion };
    },
  };
}

/** MIME 嗅探（与 `live-adapter.ts` 的图片校验口径一致：只认 PNG / JPEG）。 */
function contentTypeOf(image: Uint8Array): string {
  const png = image.length >= 8 && Buffer.from(image.subarray(0, 8)).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  return png ? 'image/png' : 'image/jpeg';
}
