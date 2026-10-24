/**
 * GY-I14（#14）· 真实审核供应商回报 → **本仓闭集**的唯一映射点（`tms` 与 `ims` 共用）。
 *
 * 三条不可动摇的口径：
 * 1. **只有闭集三键出得去**：`evaluate()` 的返回永远是**重新构造**的
 *    `{ label, reason_codes, summary }`，不是把供应商对象摊平。供应商回报里的任何多余字段
 *    （含角色/来源/可见性/发布/决策/人审/票决/训练开关）都不会被复制出去。
 * 2. **供应商回报是外部不可信输入**：它自己带控制类字段 ⇒ **整条回报拒绝**
 *    （`response_shape_unknown`），不是静默忽略。扫描复用 `nonbypass.ts` 的既有实现
 *    （`scanForbiddenControlFields`，同一份黑名单、同一份限额语义：**未检查 ≠ 干净**）。
 * 3. **失败绝不产出通过**：任何失败都抛 `ModerationPortError`，只带闭集类别 + 固定短标签；
 *    `Review` / 未知 `Suggestion` / 未知 `Label` 一律 `unsure`（合流层按 fail-closed 处理）。
 *
 * ⛔ 本文件不含任何网络调用、不含凭据、不打印待审正文或供应商正文。
 */

import { scanForbiddenControlFields } from './nonbypass.ts';
import {
  MODERATION_MAX_IMAGES_PER_TASK,
  MODERATION_MAX_TEXT_CHARACTERS,
  MODERATION_VERDICT_LABELS,
  ModerationPortError,
  type ModerationFailureClass,
  type ModerationImageSource,
  type ModerationVerdict,
  type ModerationVerdictLabel,
} from './live-ports.ts';

// ---------------------------------------------------------------------------
// 1. 原因码闭集
// ---------------------------------------------------------------------------

/** `Suggestion` 四档 → 原因码（未知 `Suggestion` 也是闭集成员，不发明新码）。 */
export const MODERATION_SUGGESTION_REASON_CODES = Object.freeze({
  pass: 'MODERATION_PROVIDER_SUGGESTION_PASS',
  review: 'MODERATION_PROVIDER_SUGGESTION_REVIEW',
  block: 'MODERATION_PROVIDER_SUGGESTION_BLOCK',
  unknown: 'MODERATION_PROVIDER_SUGGESTION_UNKNOWN',
});

/**
 * `Label` 原因码前缀。`Label` 进原因码，但**只允许**供应商枚举令牌的字面（见 `labelReasonCode`）：
 * 字母开头、仅 `[A-Za-z0-9_]`、≤32 字符 ⇒ 自由文本（空格/引号/换行/中文/链接）一个字都进不来。
 * 认不出的形态一律落到 `MODERATION_PROVIDER_LABEL_UNRECOGNIZED`（闭集成员）。
 */
export const MODERATION_LABEL_REASON_CODE_PREFIX = 'MODERATION_PROVIDER_LABEL_';
export const MODERATION_LABEL_UNRECOGNIZED = 'MODERATION_PROVIDER_LABEL_UNRECOGNIZED';

/** 供应商标签令牌允许的字符面（超出即视为"认不出"）。 */
const VENDOR_LABEL_TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

/** 契约 `Moderation.reason_codes` 的条数上限（`maxItems: 30`）——本片自己也不越过它。 */
const REASON_CODES_MAX_ITEMS = 30;

/** 供应商 `Suggestion` 的三档（`tools/verify-tencent-live.mjs` 用的就是这组字面）。 */
const VENDOR_SUGGESTIONS = Object.freeze(['Pass', 'Review', 'Block']);

function suggestionReasonCode(suggestion: string | null): string {
  if (suggestion === 'Pass') return MODERATION_SUGGESTION_REASON_CODES.pass;
  if (suggestion === 'Block') return MODERATION_SUGGESTION_REASON_CODES.block;
  if (suggestion === 'Review') return MODERATION_SUGGESTION_REASON_CODES.review;
  return MODERATION_SUGGESTION_REASON_CODES.unknown;
}

function labelReasonCode(label: string | null): string {
  if (label === null || !VENDOR_LABEL_TOKEN_PATTERN.test(label)) return MODERATION_LABEL_UNRECOGNIZED;
  return `${MODERATION_LABEL_REASON_CODE_PREFIX}${label.toUpperCase()}`;
}

/** `Suggestion` → 本仓闭集标签。**`Review` 与任何未知值都不是通过**。 */
function verdictLabelOf(suggestion: string | null): ModerationVerdictLabel {
  if (suggestion === 'Pass') return 'pass';
  if (suggestion === 'Block') return 'block';
  return 'unsure';
}

// ---------------------------------------------------------------------------
// 2. 失败分类（逐条对齐 `packages/moderation/model-ports.mjs` 的既有分类器语义）
// ---------------------------------------------------------------------------

/**
 * HTTP 状态 → 失败类别。**逐条**对齐既有分类器：
 * 401/403 ⇒ `auth_failed`；429 ⇒ `quota_exceeded`；400/413/422 ⇒ `payload_invalid`；
 * 其余（含全部 5xx）⇒ `port_error`。没有"通过"这个取值。
 */
export function moderationFailureFromHttpStatus(status: number): ModerationFailureClass {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 429) return 'quota_exceeded';
  if (status === 400 || status === 413 || status === 422) return 'payload_invalid';
  return 'port_error';
}

/**
 * 抛出中的异常 → 失败类别。`AbortError` / `TimeoutError` 是超时唯一可靠信号
 * （既有分类器同样只看这两个名字）；其余一律 `port_error`。
 */
export function moderationFailureFromThrown(error: unknown): ModerationFailureClass {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  return 'port_error';
}

/**
 * 供应商业务错误码 → 失败类别（分组口径与 `ai/error-map.ts` 的 §2 一致，只是落点是**类别**，
 * 不是契约码：本层不产契约码）。
 */
export function moderationFailureFromVendorErrorCode(code: string): ModerationFailureClass {
  if (/^(RequestLimitExceeded|LimitExceeded)/.test(code)) return 'quota_exceeded';
  if (/^(ResourceUnavailable\.ResourcePackageRunOut|UnsupportedOperation\.PkgExhausted)/.test(code)) {
    return 'quota_exceeded';
  }
  if (/^(AuthFailure|UnauthorizedOperation)($|\.)/.test(code)) return 'auth_failed';
  if (['InvalidCredential', 'FailedOperation.UnOpenError', 'FailedOperation.UserNotRegistered'].includes(code)) {
    return 'auth_failed';
  }
  if (/^(InvalidParameter|MissingParameter)/.test(code)) return 'payload_invalid';
  return 'port_error';
}

// ---------------------------------------------------------------------------
// 3. 供应商回报 → 闭集结论
// ---------------------------------------------------------------------------

/** 一张图/一段文本的供应商结论摘要（只留三档字面 + 令牌 + 分数，不留正文）。 */
export interface VendorSample {
  readonly suggestion: string | null;
  readonly labelToken: string | null;
  readonly score: number | null;
}

function readOwn(holder: unknown, key: string): { ok: boolean; present: boolean; value: unknown } {
  if (holder === null || typeof holder !== 'object') return { ok: false, present: false, value: undefined };
  try {
    return { ok: true, present: key in holder, value: (holder as Record<string, unknown>)[key] };
  } catch {
    return { ok: false, present: false, value: undefined };
  }
}

/**
 * **可信度检查**：供应商回报（`Response` 对象）里出现任何控制类字段 ⇒ 整条回报拒绝。
 *
 * 扫描复用 `nonbypass.ts` 的既有实现，因此限额语义也沿用：键数/深度超上界即判"未检查 ≠ 干净"
 * ⇒ 同样拒绝。本片把送审文本限制在 200 码点以内，正是为了让正常回报的键数远低于该上界。
 */
function assertVendorResponseTrustworthy(response: Record<string, unknown>, httpStatus: number): void {
  const scan = scanForbiddenControlFields(response);
  if (!scan.ok) {
    throw new ModerationPortError('response_shape_unknown', 'vendor_control_fields', {
      httpStatus,
      resultMayHaveBeenProcessed: true,
    });
  }
}

function readSample(response: Record<string, unknown>): VendorSample {
  const suggestionRead = readOwn(response, 'Suggestion');
  const suggestion = typeof suggestionRead.value === 'string' ? suggestionRead.value : null;
  const labelRead = readOwn(response, 'Label');
  const labelToken = typeof labelRead.value === 'string' && labelRead.value !== '' ? labelRead.value : null;
  const scoreRead = readOwn(response, 'Score');
  const rawScore = scoreRead.value;
  const score =
    typeof rawScore === 'number' && Number.isFinite(rawScore) && rawScore >= 0 && rawScore <= 100 ? rawScore : null;
  return { suggestion, labelToken, score };
}

/** Tencent Cloud RequestId 形状（UUID 或十六进制连字符串）；只记录合法形态，否则 `null`。 */
const MODERATION_REQUEST_ID_PATTERN = /^[a-fA-F0-9-]{8,64}$/;

/**
 * 从供应商回报里取 **脱敏** 的 RequestId（只用于登记/对账，不含待审正文）。
 *
 * 取不到或形态不合法 ⇒ `null`（绝不猜一个值）；该值只进 `ModerationLiveObservation`，
 * 不进 `ModerationVerdict`（合流层回报仍是闭集三键）。
 */
export function moderationRequestIdFromPayload(payload: unknown): string | null {
  const responseRead = readOwn(payload, 'Response');
  if (!responseRead.ok || !responseRead.present || responseRead.value === null || typeof responseRead.value !== 'object') {
    return null;
  }
  const requestIdRead = readOwn(responseRead.value, 'RequestId');
  const value = requestIdRead.value;
  return typeof value === 'string' && MODERATION_REQUEST_ID_PATTERN.test(value) ? value : null;
}

function summarize(samples: readonly VendorSample[]): string {
  const suggestions = samples.map((sample) => (sample.suggestion === null ? 'unknown' : sample.suggestion));
  const labels = samples.map((sample) => (sample.labelToken === null ? 'unknown' : sample.labelToken));
  const scores = samples.map((sample) => (sample.score === null ? 'unknown' : String(sample.score)));
  const head = `images=${samples.length} Suggestion=${suggestions.join(',')} Label=${labels.join(',')} Score=${scores.join(',')}`;
  // 摘要只进摘要（合流层只保留长度）；截断到 200 字符以免无界增长。
  return head.length <= 200 ? head : head.slice(0, 200);
}

function mergeVerdicts(samples: readonly VendorSample[]): ModerationVerdict {
  const reasonCodes: string[] = [];
  const push = (code: string): void => {
    if (reasonCodes.length >= REASON_CODES_MAX_ITEMS) return;
    if (!reasonCodes.includes(code)) reasonCodes.push(code);
  };
  for (const sample of samples) {
    push(suggestionReasonCode(sample.suggestion));
    push(labelReasonCode(sample.labelToken));
  }
  // 任一 Block ⇒ block（绝不因为别的样本 Pass 就抬成 pass）。
  const labels = samples.map((sample) => verdictLabelOf(sample.suggestion));
  let label: ModerationVerdictLabel = 'unsure';
  if (labels.includes('block')) label = 'block';
  else if (labels.length > 0 && labels.every((item) => item === 'pass')) label = 'pass';
  return { label, reason_codes: reasonCodes, summary: summarize(samples) };
}

/**
 * 文本端口的回报解析：`{ Response: { Suggestion, Label, Score, ... } }` → 闭集结论。
 *
 * 拒绝矩阵：
 * - 欠载/缺 `Response` ⇒ `port_error`（不是"没检出问题"，是"我们不知道"）；
 * - `Response` 带控制类字段 ⇒ `response_shape_unknown`（整条拒绝）；
 * - `Response.Error.Code` ⇒ 按供应商错误码分组映射（配额/鉴权/参数/其余）；
 * - 否则取 `Suggestion` / `Label` / `Score` 三个标量，`Review` 与未知值都是 `unsure`。
 */
export function moderationVerdictFromVendorPayload(input: { payload: unknown; httpStatus: number }): ModerationVerdict {
  const responseRead = readOwn(input.payload, 'Response');
  if (!responseRead.ok || !responseRead.present || responseRead.value === null || typeof responseRead.value !== 'object') {
    throw new ModerationPortError('port_error', 'vendor_response_missing', {
      httpStatus: input.httpStatus,
      resultMayHaveBeenProcessed: true,
    });
  }
  const response = responseRead.value as Record<string, unknown>;
  assertVendorResponseTrustworthy(response, input.httpStatus);

  const errorRead = readOwn(response, 'Error');
  if (errorRead.present && errorRead.value !== null && typeof errorRead.value === 'object') {
    const codeRead = readOwn(errorRead.value, 'Code');
    const rawCode = typeof codeRead.value === 'string' && codeRead.value !== '' ? codeRead.value : null;
    const safeCode = rawCode !== null && /^[A-Za-z0-9.]{1,100}$/.test(rawCode) ? rawCode : 'UNRECOGNIZED_ERROR';
    throw new ModerationPortError(moderationFailureFromVendorErrorCode(safeCode), 'vendor_business_error', {
      httpStatus: input.httpStatus,
      providerErrorCode: safeCode,
      resultMayHaveBeenProcessed: true,
    });
  }

  return mergeVerdicts([readSample(response)]);
}

/** 图片端口的多图合成：逐张各自一份样本，**任一 Block 即 block，全 Pass 才 pass，其余 unsure**。 */
export function moderationVerdictFromImageSamples(samples: readonly VendorSample[]): ModerationVerdict {
  return mergeVerdicts(samples);
}

/** 单张图的回报解析（与文本同一套拒绝矩阵，只是样本来源是 `ImageModeration` 的 `Response`）。 */
export function imageSampleFromVendorPayload(input: { payload: unknown; httpStatus: number }): VendorSample {
  const responseRead = readOwn(input.payload, 'Response');
  if (!responseRead.ok || !responseRead.present || responseRead.value === null || typeof responseRead.value !== 'object') {
    throw new ModerationPortError('port_error', 'vendor_response_missing', {
      httpStatus: input.httpStatus,
      resultMayHaveBeenProcessed: true,
    });
  }
  const response = responseRead.value as Record<string, unknown>;
  assertVendorResponseTrustworthy(response, input.httpStatus);
  const errorRead = readOwn(response, 'Error');
  if (errorRead.present && errorRead.value !== null && typeof errorRead.value === 'object') {
    const codeRead = readOwn(errorRead.value, 'Code');
    const rawCode = typeof codeRead.value === 'string' && codeRead.value !== '' ? codeRead.value : null;
    const safeCode = rawCode !== null && /^[A-Za-z0-9.]{1,100}$/.test(rawCode) ? rawCode : 'UNRECOGNIZED_ERROR';
    throw new ModerationPortError(moderationFailureFromVendorErrorCode(safeCode), 'vendor_business_error', {
      httpStatus: input.httpStatus,
      providerErrorCode: safeCode,
      resultMayHaveBeenProcessed: true,
    });
  }
  return readSample(response);
}

// ---------------------------------------------------------------------------
// 4. 送审输入（本地校验先于任何外呼）
// ---------------------------------------------------------------------------

function requireContent(request: unknown): Record<string, unknown> {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new ModerationPortError('payload_invalid', 'request_not_object', { resultMayHaveBeenProcessed: false });
  }
  const contentRead = readOwn(request, 'content');
  if (!contentRead.present || contentRead.value === null || typeof contentRead.value !== 'object') {
    throw new ModerationPortError('payload_invalid', 'request_content_missing', { resultMayHaveBeenProcessed: false });
  }
  return contentRead.value as Record<string, unknown>;
}

function assertRequestKind(request: unknown, expected: 'tms' | 'ims'): void {
  const kindRead = readOwn(request, 'kind');
  if (kindRead.present && kindRead.value !== expected) {
    // 串端口（用文本端口判图片）是接线错误：本地拒绝，绝不外呼。
    throw new ModerationPortError('payload_invalid', 'request_kind_mismatch', { resultMayHaveBeenProcessed: false });
  }
}

/** 取送审文本：必须是 1..200 码点的非空字符串，超限 **fail-closed 不截断**。 */
export function requireModerationText(request: unknown): string {
  assertRequestKind(request, 'tms');
  const content = requireContent(request);
  const textRead = readOwn(content, 'text');
  if (typeof textRead.value !== 'string') {
    throw new ModerationPortError('payload_invalid', 'text_missing', { resultMayHaveBeenProcessed: false });
  }
  const text = textRead.value;
  const length = Array.from(text).length;
  if (length === 0) {
    throw new ModerationPortError('payload_invalid', 'text_empty', { resultMayHaveBeenProcessed: false });
  }
  if (length > MODERATION_MAX_TEXT_CHARACTERS) {
    throw new ModerationPortError('payload_invalid', 'text_too_long', { resultMayHaveBeenProcessed: false });
  }
  return text;
}

/** 一个不透明的图片引用（**不含字节**，与合流层的图片引用归一器同形）。 */
export interface ModerationMediaRefInput {
  readonly mediaId: string;
  readonly mediaRevision: number | null;
}

/**
 * 取图片引用列表。
 *
 * 条数必须在 `1..MODERATION_MAX_IMAGES_PER_TASK`：**多图绝不"只审一张就放行"**——
 * 超上界时整条 fail-closed（不是挑前 N 张），否则未审的图会跟着已审的图一起发布。
 */
export function requireModerationMediaRefs(request: unknown): ModerationMediaRefInput[] {
  assertRequestKind(request, 'ims');
  const content = requireContent(request);
  const refsRead = readOwn(content, 'media_refs');
  if (!Array.isArray(refsRead.value) || refsRead.value.length === 0) {
    throw new ModerationPortError('payload_invalid', 'media_refs_missing', { resultMayHaveBeenProcessed: false });
  }
  if (refsRead.value.length > MODERATION_MAX_IMAGES_PER_TASK) {
    throw new ModerationPortError('payload_invalid', 'media_refs_too_many', { resultMayHaveBeenProcessed: false });
  }
  const refs: ModerationMediaRefInput[] = [];
  for (const item of refsRead.value) {
    const idRead = readOwn(item, 'media_id');
    if (typeof idRead.value !== 'string' || idRead.value === '') {
      throw new ModerationPortError('payload_invalid', 'media_id_invalid', { resultMayHaveBeenProcessed: false });
    }
    const revisionRead = readOwn(item, 'media_revision');
    const revision =
      typeof revisionRead.value === 'number' && Number.isSafeInteger(revisionRead.value) && revisionRead.value >= 1
        ? revisionRead.value
        : null;
    refs.push({ mediaId: idRead.value, mediaRevision: revision });
  }
  return refs;
}

const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');

/**
 * 图片字节本地校验（**先于任何外呼**）：PNG/JPEG 头 + 字节上限。
 * 头部口径与 `tools/ai-config.mjs:imageInfo()` / `ai/ocr-live-adapter.ts:requireLiveOcrImage()` 一致
 * （只做头部嗅探，不做完整解码，也不剥 EXIF）。超限 **fail-closed 不压缩、不裁剪**。
 */
export function requireModerationImageBytes(raw: unknown, maxImageBytes: number): Uint8Array {
  if (!(raw instanceof Uint8Array) || raw.length === 0) {
    throw new ModerationPortError('payload_invalid', 'image_bytes_missing', { resultMayHaveBeenProcessed: false });
  }
  if (raw.length > maxImageBytes) {
    throw new ModerationPortError('payload_invalid', 'image_bytes_too_large', { resultMayHaveBeenProcessed: false });
  }
  const bytes = Buffer.from(raw);
  const png =
    raw.length >= 24 &&
    bytes.subarray(0, 8).equals(PNG_MAGIC) &&
    bytes.toString('ascii', 12, 16) === 'IHDR' &&
    bytes.readUInt32BE(16) > 0 &&
    bytes.readUInt32BE(20) > 0;
  const jpeg =
    raw.length >= 4 &&
    raw[0] === 0xff &&
    raw[1] === 0xd8 &&
    raw[2] === 0xff &&
    raw[raw.length - 2] === 0xff &&
    raw[raw.length - 1] === 0xd9;
  if (!png && !jpeg) {
    throw new ModerationPortError('payload_invalid', 'image_header_invalid', { resultMayHaveBeenProcessed: false });
  }
  return raw;
}

/**
 * **明确未接线**的图片字节来源：对象存储属媒体域，本片未接线。
 * 它诚实返回 `null`（而不是伪造字节、也不是读本地磁盘）⇒ 适配器按"取不到字节"fail-closed。
 */
export function createUnwiredModerationImageSource(reason: string): ModerationImageSource {
  return {
    kind: 'unwired',
    note: `${reason}（fail-closed，不伪造字节）`,
    async read() {
      return null;
    },
  };
}

/** 标签闭集（供用例断言"本片与上游同一份闭集"；此处再导出一次，避免用例去猜路径）。 */
export const MODERATION_LABELS = MODERATION_VERDICT_LABELS;
