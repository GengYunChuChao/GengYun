/**
 * GY-I11 普通话录音与转写域 · 判定状态与 fail-closed 硬约束（只读消费冻结契约，不新增契约字段）。
 *
 * 契约来源：packages/contracts/openapi.json（1.0.0，`x-contract-status: proposed`）
 *   Transcription = { id(uuid), revision(int>=1), raw_text(string, maxLength 8000),
 *                     uncertain_spans(UncertainSpan[], maxItems 100),
 *                     confirmed_text(string 1..8000 | null), confirmed_at(date-time | null),
 *                     model_version(string 1..80) }  —— 七字段全必填，additionalProperties:false
 *   UncertainSpan = { start(int>=0), end(int>=1), reason(string 1..80) } —— 三字段全必填
 *   ConfirmTranscriptionInput = { confirmed_text(string 1..8000), confirmation const "checked_and_sendable" }
 *   MediaJobInput = { media_id(uuid), media_revision(int>=1) }
 *   JobState = queued | running | succeeded | uncertain | failed | timed_out | cancelled（闭集 7 值）
 *   ErrorCode = 契约闭集 24 值（本文件不新增、不改写）
 *
 * 本文件承载的四条硬规则（派单 §2，逐条即回归用例）：
 *
 *   1. **`raw_text` 与 `confirmed_text` 严格分离**：`confirmed_text` 只由确认路径写入，
 *      **绝不**用来覆写 `raw_text`。用户确认是人的判断，不是模型输出，因此
 *      **不得计入任何模型准确率**；本层不提供任何把 `confirmed_text` 回灌进
 *      `raw_text` 或模型输出统计的入口（契约也没有这样的字段）。
 *   2. **`uncertain_spans` 如实**：只做形状与区间合法性校验（`start < end`、`reason` 1..80、
 *      条数 <= 100），**不删改、不裁剪、不补造、不排序**，逐项按提供者所报顺序原样保留；
 *      无法判定文本时落 `uncertain` 终态，**不编造文本**。
 *   3. **超长 fail-closed**：`raw_text` 码点长度 > 8000 时**不得静默截断**、不得以截断文本当成功；
 *      一律协议违规（见 `requireTranscriptText`）。
 *   4. **不得写成功**：提供者失败/超时/结果未知/协议违规一律落 `failed` / `timed_out`，
 *      任何异常路径都不得变成 `succeeded`（见 service.ts 的 `execute`）。
 *
 * **契约缺口（如实记录，不新增契约字段）**：
 * - `UncertainSpan.start` / `end` **没有**规定坐标单位（字符偏移？码点？毫秒时间轴？），
 *   也**没有**规定区间必须落在 `raw_text` 之内。本实现按「`raw_text` 的字符区间」理解，
 *   但**不**做 `end <= raw_text.length` 的越界拒绝：契约没有该约束，越界拒绝会变成一条
 *   自造的更严规则，而裁剪/丢弃越界区间又属于「删改」。因此本层**原样透传**并在汇报中
 *   登记为未取得项，交由契约修订统一，而不是在本层猜一个单位。
 * - 契约**没有**给出 `JobState` 与 `ErrorCode` 的对应关系。本层的映射（见 service.ts）
 *   属实现层口径，不是契约条文。
 * - `Transcription.raw_text` **没有** `minLength`，因此空字符串在契约上是合法的**字段值**；
 *   本层判定「空转写不可用」（落 `uncertain` 终态且不产生转写记录），属实现层的 fail-closed
 *   选择，而不是契约要求。
 */

/** `Transcription.raw_text.maxLength`。 */
export const MAX_RAW_TEXT_LENGTH = 8000;
/** `Transcription.confirmed_text.maxLength` 与 `ConfirmTranscriptionInput.confirmed_text.maxLength`。 */
export const MAX_CONFIRMED_TEXT_LENGTH = 8000;
/** `Transcription.uncertain_spans.maxItems`。 */
export const MAX_UNCERTAIN_SPANS = 100;
/** `UncertainSpan.reason.minLength` / `.maxLength`。 */
export const MIN_SPAN_REASON_LENGTH = 1;
export const MAX_SPAN_REASON_LENGTH = 80;
/** `Transcription.model_version.minLength` / `.maxLength`。 */
export const MAX_MODEL_VERSION_LENGTH = 80;
/** `ConfirmTranscriptionInput.confirmation.const`。 */
export const CONFIRMATION_VALUE = 'checked_and_sendable';

/** 契约 `UncertainSpan`（三字段全必填，additionalProperties:false）。 */
export interface UncertainSpan {
  start: number;
  end: number;
  reason: string;
}

/**
 * 契约 `Transcription` 投影（七字段全必填）。
 * `additionalProperties:false`：除了这七个键**不得**再下发任何字段。
 */
export interface TranscriptionProjection {
  id: string;
  revision: number;
  /** 模型原始输出：**确认路径永远不得改写本字段**。 */
  raw_text: string;
  /** 提供者如实上报的不确定区间：不删改、不补造。 */
  uncertain_spans: UncertainSpan[];
  /** 用户核对后的文本（未经核对为 null）：与 `raw_text` 严格分离，不计入模型准确率。 */
  confirmed_text: string | null;
  confirmed_at: string | null;
  model_version: string;
}

/** packages/contracts/openapi.json -> components.schemas.JobState.enum（逐项一致，不得扩展）。 */
export const JOB_STATES = [
  'queued',
  'running',
  'succeeded',
  'uncertain',
  'failed',
  'timed_out',
  'cancelled',
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** 终态：到达后不得再迁移（迟到的提供者回调不复活任务）。 */
export const TERMINAL_JOB_STATES = ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'] as const;

export function isJobState(value: unknown): value is JobState {
  return typeof value === 'string' && (JOB_STATES as readonly string[]).includes(value);
}

export function isTerminalJobState(state: JobState): boolean {
  return (TERMINAL_JOB_STATES as readonly string[]).includes(state);
}

/**
 * 允许的状态迁移。终态不可离开；`cancelled` / `timed_out` 优先于任何迟到结果。
 * `queued → failed / timed_out` 覆盖「还没开始就超过截止时间」的情形。
 */
export function canTransitionJob(from: JobState, to: JobState): boolean {
  if (isTerminalJobState(from)) return false;
  if (from === 'queued') return to === 'running' || to === 'cancelled' || to === 'failed' || to === 'timed_out';
  if (from === 'running') return isTerminalJobState(to);
  return false;
}

/** 提供者 / 转写输出被拒的原因（fail-closed，不透出提供者原文，避免把私有录音内容带进错误信息）。 */
export class SpeechProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpeechProtocolError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 按契约 maxLength 口径统计长度：JSON Schema 的 `maxLength` 数的是 **Unicode 码点**，
 * 不是 UTF-16 码元，也不是字节数。用 `[...text].length` 而不是 `text.length`，
 * 否则含代理对（emoji 等）的文本会被提前判越界，或反之放过真正超限的文本。
 */
export function codePointLength(text: string): number {
  return [...text].length;
}

/** 单个不确定区间校验：先判 `typeof` / `Number.isInteger`，再判值；不修补、不补造。 */
export function normalizeUncertainSpan(raw: unknown, index: number): UncertainSpan {
  if (!isPlainObject(raw)) throw new SpeechProtocolError(`uncertain_spans[${index}] 不是对象`);
  const extra = Object.keys(raw).filter((key) => key !== 'start' && key !== 'end' && key !== 'reason');
  if (extra.length > 0) throw new SpeechProtocolError(`uncertain_spans[${index}] 含未定义字段 ${extra[0]}`);
  for (const key of ['start', 'end', 'reason'] as const) {
    if (!(key in raw)) throw new SpeechProtocolError(`uncertain_spans[${index}] 缺少必填字段 ${key}`);
  }
  const start = raw['start'];
  const end = raw['end'];
  const reason = raw['reason'];
  if (typeof start !== 'number' || !Number.isInteger(start) || start < 0) {
    throw new SpeechProtocolError(`uncertain_spans[${index}].start 必须是 >=0 的整数`);
  }
  if (typeof end !== 'number' || !Number.isInteger(end) || end < 1) {
    throw new SpeechProtocolError(`uncertain_spans[${index}].end 必须是 >=1 的整数`);
  }
  // 契约只分别约束 start>=0 / end>=1，没有写 start<end；但倒置区间不可能是一个真实区间，
  // 因此按派单 §2.2 拒绝，**不**自动交换两端（交换属于「改」）。
  if (start >= end) {
    throw new SpeechProtocolError(`uncertain_spans[${index}] 区间倒置或为空（start ${start} >= end ${end}）`);
  }
  if (typeof reason !== 'string' || reason.length < MIN_SPAN_REASON_LENGTH || reason.length > MAX_SPAN_REASON_LENGTH) {
    throw new SpeechProtocolError(
      `uncertain_spans[${index}].reason 长度必须在 ${MIN_SPAN_REASON_LENGTH}..${MAX_SPAN_REASON_LENGTH}`,
    );
  }
  return { start, end, reason };
}

/**
 * 校验不确定区间数组：超上限即协议违规（**不截断**），顺序与内容原样保留。
 * 空数组是合法且**有意义**的取值（= 提供者未上报任何不确定区间），不得被当成缺字段。
 */
export function normalizeUncertainSpans(raw: unknown): UncertainSpan[] {
  if (!Array.isArray(raw)) throw new SpeechProtocolError('uncertain_spans 必须是数组');
  if (raw.length > MAX_UNCERTAIN_SPANS) {
    throw new SpeechProtocolError(`uncertain_spans 超过契约上限 ${MAX_UNCERTAIN_SPANS} 条（实际 ${raw.length} 条，不截断）`);
  }
  return raw.map((item, index) => normalizeUncertainSpan(item, index));
}

/**
 * 校验模型原始输出文本（提供者側）。**fail-closed**：
 * - 非字符串 ⇒ 协议违规；
 * - 码点长度 > 8000 ⇒ 协议违规（**绝不**截断后当成功）；
 * - 长度本身不设下限（契约 `raw_text` 无 `minLength`），空串由 `isEmptyTranscript` 单独判定。
 */
export function requireTranscriptText(raw: unknown, where = 'raw_text'): string {
  if (typeof raw !== 'string') throw new SpeechProtocolError(`${where} 必须是字符串`);
  if (codePointLength(raw) > MAX_RAW_TEXT_LENGTH) {
    throw new SpeechProtocolError(
      `${where} 码点长度 ${codePointLength(raw)} 超过契约上限 ${MAX_RAW_TEXT_LENGTH}（不截断，fail-closed）`,
    );
  }
  return raw;
}

/**
 * 空转写判定：只有空白字符（含全角空格）视同「没有可用的转写文本」。
 * 契约允许空串作为 `raw_text` 的字段值，但按派单 §2.2「无法判定时落 `uncertain` 终态
 * 而不是编造文本」，本层判定它**不可用**（不写记录、不落 succeeded）。
 */
export function isEmptyTranscript(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * 校验用户核对文本（`ConfirmTranscriptionInput.confirmed_text`）：非字符串或长度不在 1..8000
 * 一律拒绝。**不做相似度/一致性校验**：契约没有要求它与 `raw_text` 相等，也不允许本层
 * 替用户「修正」文本；它记的是人的核对结果，不是模型输出。
 */
export function normalizeConfirmedText(raw: unknown, where = 'confirmed_text'): string {
  if (typeof raw !== 'string') throw new SpeechProtocolError(`${where} 必须是字符串`);
  if (raw.length < 1 || codePointLength(raw) > MAX_CONFIRMED_TEXT_LENGTH) {
    throw new SpeechProtocolError(`${where} 长度必须在 1..${MAX_CONFIRMED_TEXT_LENGTH}`);
  }
  return raw;
}

/** 校验模型版本标识（`Transcription.model_version`，1..80）。 */
export function normalizeModelVersion(raw: unknown, where = 'model_version'): string {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > MAX_MODEL_VERSION_LENGTH) {
    throw new SpeechProtocolError(`${where} 长度必须在 1..${MAX_MODEL_VERSION_LENGTH}`);
  }
  return raw;
}
