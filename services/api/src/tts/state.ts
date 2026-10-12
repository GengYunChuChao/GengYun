/**
 * GY-I13 普通话 TTS 合成域 · 判定状态与 fail-closed 硬约束（只读消费冻结契约，不新增契约字段）。
 *
 * 契约来源：packages/contracts/openapi.json（1.0.0）
 *   SynthesisInput = { checked_content_ref: SynthesisTarget, locale: const "zh-CN" }
 *                    —— 两字段全必填，additionalProperties:false，**没有**任何自由文本入参
 *   SynthesisTarget = { type ∈ {answer|scheme|herbicide|species|static_region|dose_card}  ← 受限闭集
 *                       id: string(1..80), revision: integer >= 1 }  additionalProperties:false
 *   Synthesis      = { id(uuid), revision(int>=1), checked_content_ref: TargetRef, media_id(uuid) }
 *                    —— 四字段全必填，additionalProperties:false
 *   SynthesisResult = { kind: const "synthesis", value: Synthesis }
 *   Job.kind ∈ {recognition|ocr|transcription|answer|synthesis|moderation}；合成任务取 "synthesis"
 *   JobState = queued|running|succeeded|uncertain|failed|timed_out|cancelled（闭集 7 值）
 *   AuditState = pending|approved|rejected|quarantined（packages/contracts/states.json，闭集 4 值）
 *   ErrorCode = 契约闭集 24 值（本文件不新增、不改写）
 *
 * 本文件承载的核心安全规则（派单 §2，逐条即回归用例）：
 *
 *   1. **只播报经核对的内容**：`checked_content_ref.type` 只能取契约 `SynthesisTarget` 的 **6 个值**。
 *      `TargetRef`（16 值）里的 `post` / `comment` / `conversation` / `transcription` / `ocr` /
 *      `synthesis` / `job` / `source` / `media` / `recognition` **不在** `SynthesisTarget` 闭集内，
 *      因此社区帖、评论、会话、转写原文等一律 `INVALID_REQUEST`——那是「按文本念」，不是播报已核对内容。
 *   2. **未通过核对一律 fail-closed**：`decideCheckedContent` 要求核对状态**恰好**为 `approved`；
 *      `pending`（未核对／待审）、`rejected`（已驳回）、`quarantined`（已隔离）、
 *      以及**取不到核对状态**（端口抛错／返回未知状态值）一律拒绝，**绝不**「照文本念」。
 *   3. **修订绑定**：`Synthesis.checked_content_ref.revision` 必须等于**实际用于合成的那个 revision**；
 *      调用方传入的 `revision` 与内容当前 revision 不一致 ⇒ `REVISION_CONFLICT`。
 *      生成时**重读**内容并在执行期再次判定（见 service.ts），因此「受理后内容被修订」不会
 *      产出绑错版本的音频，也不会把新 revision 静默回填进旧任务。
 *   4. **失效（过期）口径可判定**：`Synthesis` 是否仍可播放由 `service.verifyUsable` 用同一套
 *      判定函数重算：核对状态仍为 `approved` + 内容当前 revision 仍等于绑定的 revision +
 *      产物仍在 ⇒ 可用；否则给出契约闭集内的错误码与原因，**不静默放行**。
 *
 * **契约缺口（如实记录，不新增契约字段）**：
 * - 契约**没有**规定 `JobState` 与 `ErrorCode` 的对应关系。本实现的选择：提供者超时 ⇒ `timed_out`
 *   + `PROVIDER_TIMEOUT`；其余失败 ⇒ `failed` + 对应错误码（见 service.ts `stateForProviderFailure`）。
 * - 契约**没有**给出 `Synthesis.checked_content_ref` 与 `Job.target_ref` 的关系。本实现令二者相等
 *   （同一个已核对目标引用），于是「结果属于同一 target_ref 与 revision」这条既有口径可直接核对。
 * - 契约**没有**定义 `AuditState` 的读取接口（服务端没有对应的读端点），也没有规定「取不到核对状态」
 *   应当用什么错误码。本实现的选择见 `decideCheckedContent` 的逐分支注释。
 * - 契约**没有**规定可合成文本的长度上限，也没有规定「内容修订后旧音频」的服务端判定入口
 *   （只有 POST，没有 GET /speech/synthesis/{id}）。本层**不发明**文本上限、**不截断**，
 *   并把失效判定实现为纯服务层口径，如实登记为契约缺口而不是自造端点。
 */

import type { ErrorCode } from '../contract.ts';

// ---------------------------------------------------------------------------
// 契约闭集与常量
// ---------------------------------------------------------------------------

/** packages/contracts/openapi.json -> components.schemas.SynthesisTarget.properties.type.enum（受限闭集 6 值）。 */
export const SYNTHESIS_TARGET_TYPES = [
  'answer',
  'scheme',
  'herbicide',
  'species',
  'static_region',
  'dose_card',
] as const;
export type SynthesisTargetType = (typeof SYNTHESIS_TARGET_TYPES)[number];

/**
 * `SynthesisTarget.type` 闭集之外、但存在于 `TargetRef`（16 值）的取值。
 * 逐项列出是为了在汇报里说清楚「哪些内容类型**不能**被合成」，而不是只写一句「不在闭集内」。
 */
export const FORBIDDEN_SYNTHESIS_TARGET_TYPES = [
  'recognition',
  'ocr',
  'transcription',
  'post',
  'comment',
  'conversation',
  'media',
  'synthesis',
  'job',
  'source',
] as const;

/** 契约 `SynthesisTarget.id`：minLength 1、maxLength 80（JSON Schema 数的是 Unicode 码点）。 */
export const MIN_TARGET_ID_CODE_POINTS = 1;
export const MAX_TARGET_ID_CODE_POINTS = 80;

/** 契约 `SynthesisInput.locale`：const "zh-CN"（首版只支持普通话）。 */
export const SYNTHESIS_LOCALE = 'zh-CN';

/** packages/contracts/states.json -> states.AuditState（闭集 4 值）。 */
export const AUDIT_STATES = ['pending', 'approved', 'rejected', 'quarantined'] as const;
export type AuditState = (typeof AUDIT_STATES)[number];

/** 唯一允许合成的核对状态：**恰好** `approved`。 */
export const SYNTHESIS_ALLOWED_AUDIT_STATE: AuditState = 'approved';

/** `Job.kind` 的合成取值。 */
export const SYNTHESIS_JOB_KIND = 'synthesis';

/** packages/contracts/states.json -> states.JobState（逐项一致，不得扩展）。 */
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

/** 终态：到达后不得再迁移（迟到的提供者结果不复活任务）。 */
export const TERMINAL_JOB_STATES = ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'] as const;

/** packages/contracts/states.json -> job_transitions（逐项一致）。 */
export const JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ['running', 'cancelled', 'timed_out', 'failed'],
  running: ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'],
  succeeded: [],
  uncertain: [],
  failed: [],
  timed_out: [],
  cancelled: [],
};

export function isJobState(value: unknown): value is JobState {
  return typeof value === 'string' && (JOB_STATES as readonly string[]).includes(value);
}

export function isTerminalJobState(state: JobState): boolean {
  return (TERMINAL_JOB_STATES as readonly string[]).includes(state);
}

export function canTransitionJob(from: JobState, to: JobState): boolean {
  return (JOB_TRANSITIONS[from] ?? []).includes(to);
}

export function isSynthesisTargetType(value: unknown): value is SynthesisTargetType {
  return typeof value === 'string' && (SYNTHESIS_TARGET_TYPES as readonly string[]).includes(value);
}

export function isAuditState(value: unknown): value is AuditState {
  return typeof value === 'string' && (AUDIT_STATES as readonly string[]).includes(value);
}

/** 域内协议/形状错误：由 service.ts 统一映射为契约 400 INVALID_REQUEST（不透出内部结构）。 */
export class TtsProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TtsProtocolError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 按契约 maxLength 口径统计长度：JSON Schema 的 `maxLength` 数的是 **Unicode 码点**，
 * 不是 UTF-16 码元。`SynthesisTarget.id` 是用户可见引用串（可能含 emoji），
 * 用 `[...text].length` 才能与契约一致。
 */
export function codePointLength(text: string): number {
  return [...text].length;
}

// ---------------------------------------------------------------------------
// 契约投影
// ---------------------------------------------------------------------------

/**
 * 已核对目标引用（= `SynthesisTarget`）。
 * 注意：`Synthesis.checked_content_ref` 在契约里是 `TargetRef`（16 值），
 * 但本域只会写入 6 值闭集内的值，因此投影类型**收窄**为闭集类型——
 * 这让「不得回绑社区帖等未核对类型」在类型层面就写不进去。
 */
export interface SynthesisTargetRef {
  type: SynthesisTargetType;
  id: string;
  revision: number;
}

/** 契约 `Synthesis` 投影（四字段全必填，additionalProperties:false）。 */
export interface SynthesisProjection {
  id: string;
  revision: number;
  checked_content_ref: SynthesisTargetRef;
  media_id: string;
}

/** 契约 `SynthesisResult`。 */
export interface SynthesisResultProjection {
  kind: typeof SYNTHESIS_JOB_KIND;
  value: SynthesisProjection;
}

/** 契约 `Job` 投影（本任务只允许 `kind='synthesis'`）。 */
export interface SynthesisJobProjection {
  id: string;
  revision: number;
  kind: typeof SYNTHESIS_JOB_KIND;
  target_ref: SynthesisTargetRef;
  state: JobState;
  deadline_at: string;
  created_at: string;
  error_code: ErrorCode | null;
  result: SynthesisResultProjection | null;
}

// ---------------------------------------------------------------------------
// 入参校验（契约 additionalProperties:false 的显式实现）
// ---------------------------------------------------------------------------

/** 校验 body 恰为 `SynthesisTarget`（三字段全必填、闭集、码点长度、revision 整数）。 */
export function normalizeSynthesisTargetRef(raw: unknown): SynthesisTargetRef {
  if (!isPlainObject(raw)) throw new TtsProtocolError('checked_content_ref 必须是对象');
  const extra = Object.keys(raw).filter((key) => key !== 'type' && key !== 'id' && key !== 'revision');
  if (extra.length > 0) throw new TtsProtocolError(`checked_content_ref 含未定义字段 ${extra[0]}`);
  for (const key of ['type', 'id', 'revision'] as const) {
    if (!(key in raw)) throw new TtsProtocolError(`checked_content_ref 缺少必填字段 ${key}`);
  }
  const type = raw['type'];
  const id = raw['id'];
  const revision = raw['revision'];
  if (typeof type !== 'string' || !isSynthesisTargetType(type)) {
    // 不外泄「这个 type 是否存在」的更多信息，只如实说明闭集。
    throw new TtsProtocolError(
      `checked_content_ref.type 必须是 ${SYNTHESIS_TARGET_TYPES.join(' / ')} 之一（不得合成其它类型的内容）`,
    );
  }
  if (typeof id !== 'string') throw new TtsProtocolError('checked_content_ref.id 必须是字符串');
  const idLength = codePointLength(id);
  if (idLength < MIN_TARGET_ID_CODE_POINTS || idLength > MAX_TARGET_ID_CODE_POINTS) {
    throw new TtsProtocolError(
      `checked_content_ref.id 码点长度必须在 ${MIN_TARGET_ID_CODE_POINTS}..${MAX_TARGET_ID_CODE_POINTS}（实际 ${idLength}）`,
    );
  }
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    throw new TtsProtocolError('checked_content_ref.revision 必须是 >=1 的整数');
  }
  return { type, id, revision };
}

/** 校验 body 恰为 `SynthesisInput`（两字段全必填、locale 恒为 zh-CN、无自由文本入参）。 */
export function normalizeSynthesisInput(raw: unknown): { checked_content_ref: SynthesisTargetRef; locale: string } {
  if (!isPlainObject(raw)) throw new TtsProtocolError('请求体必须是对象');
  const extra = Object.keys(raw).filter((key) => key !== 'checked_content_ref' && key !== 'locale');
  if (extra.length > 0) {
    // 客户端自带 text / script / openid 之类一律在此被拦下：本域**不接受**任何自由文本入参。
    throw new TtsProtocolError(`请求体含未定义字段 ${extra[0]}（不接受自由文本或身份字段）`);
  }
  for (const key of ['checked_content_ref', 'locale'] as const) {
    if (!(key in raw)) throw new TtsProtocolError(`缺少必填字段 ${key}`);
  }
  if (raw['locale'] !== SYNTHESIS_LOCALE) {
    throw new TtsProtocolError(`locale 必须是 "${SYNTHESIS_LOCALE}"（首版只支持普通话）`);
  }
  return { checked_content_ref: normalizeSynthesisTargetRef(raw['checked_content_ref']), locale: SYNTHESIS_LOCALE };
}

// ---------------------------------------------------------------------------
// 「是否播报已核对内容」的核心判定
// ---------------------------------------------------------------------------

/**
 * 核对源为本次目标提供的快照（形状由本域约定，**不是**契约字段）。
 * `auditState` 与 `text` 刻意声明为 `unknown`：端口可能给出未知状态或非文本正文，
 * 由 `decideCheckedContent` 逐项判定为「不可读 ⇒ 拒绝」，而不是靠类型断言假定它合法。
 */
export interface CheckedContentSnapshot {
  type: SynthesisTargetType;
  id: string;
  /** 内容当前 revision（与调用方传入的 revision 比对）。 */
  revision: number;
  /** 核对状态：期望 `AuditState`，未知值一律按「取不到核对状态」处理。 */
  auditState: unknown;
  /** 归属：null = 平台／运营公共内容；非 null = 该账号私有内容。 */
  ownerUserId: string | null;
  /** 已核对正文；只有 `approved` 且可取时才可能非空。 */
  text: unknown;
}

/** 拒绝原因：逐条可单独指出（派单 §3 要求每个「应当拒绝」情形各一条独立用例）。 */
export const CHECKED_CONTENT_REFUSAL_REASONS = [
  /** 内容不存在（或非本人可见，与不存在同形）。 */
  'TARGET_NOT_FOUND',
  /** 内容存在但归属他人：与不存在同形，不泄露存在性。 */
  'TARGET_FOREIGN_OWNER',
  /** 取不到核对状态：端口抛错、状态缺失或不在 AuditState 闭集内。 */
  'AUDIT_STATE_UNREADABLE',
  /** 未核对／待审。 */
  'AUDIT_PENDING',
  /** 已驳回。 */
  'AUDIT_REJECTED',
  /** 已隔离。 */
  'AUDIT_QUARANTINED',
  /** 端口返回的目标与本次请求的目标不一致（不得拿别的内容顶替）。 */
  'TARGET_MISMATCH',
  /** 传入 revision 与内容当前 revision 不一致（不复用旧审核）。 */
  'REVISION_MISMATCH',
  /** 核对通过但取不到可朗读正文（空／非字符串）。 */
  'CONTENT_UNREADABLE',
] as const;
export type CheckedContentRefusalReason = (typeof CHECKED_CONTENT_REFUSAL_REASONS)[number];

export type CheckedContentDecision =
  | { ok: true; revision: number; text: string }
  | { ok: false; code: ErrorCode; reason: CheckedContentRefusalReason; message: string };

function refuse(
  reason: CheckedContentRefusalReason,
  code: ErrorCode,
  message: string,
): Extract<CheckedContentDecision, { ok: false }> {
  return { ok: false, code, reason, message };
}

/**
 * 判定「这份已核对目标是否可以被朗读」，并给出**实际用于合成的 revision 与正文**。
 *
 * 逐分支的错误码选择理由（派单要求写明；错误码全部取自契约闭集，不新增）：
 *
 * | 情形 | 错误码 | 理由 |
 * | --- | --- | --- |
 * | 快照为 null（不存在／不可见） | 404 `NOT_FOUND` | 契约与既有口径：私有非本人同形，不透露目标是否存在 |
 * | 快照归属他人 | 404 `NOT_FOUND` | 同上：与不存在同形，不泄露存在性 |
 * | 核对状态缺失／未知／端口抛错 | 409 `OBJECT_UNAVAILABLE` | 「取不到核对状态」时**不能声称可用**；既有口径把「失效关联」判为 409 OBJECT_UNAVAILABLE，此处复用同一语义（对象当前不可用），而不是退回 404 假装不存在 |
 * | `pending`（未核对／待审） | 422 `INPUT_UNCERTAIN` | 请求本身可解析，但「是否经核对」这一前置条件尚未确定，属**输入不确定**；既不能冒充「不存在」，也不能声称「已驳回」 |
 * | `rejected`（已驳回） | 409 `OBJECT_UNAVAILABLE` | 已有明确结论：该内容不可用；按「对象不可用」拒绝，且不得因**重试**而放行 |
 * | `quarantined`（已隔离） | 409 `OBJECT_UNAVAILABLE` | 同上，已隔离即不可用 |
 * | 端口回错目标 | 409 `OBJECT_UNAVAILABLE` | 无法证明这就是本次请求的目标 ⇒ 对象不可用，绝不用别的内容顶替 |
 * | revision 不一致 | 409 `REVISION_CONFLICT` | 既有口径：刷新当前版本并显式确认，**不复用旧审核**；不得把新 revision 回填进旧请求 |
 * | 核对通过但正文取不到／为空 | 409 `OBJECT_UNAVAILABLE` | 无法产出可朗读内容 ⇒ 对象不可用；**绝不用空串或占位文本当成功** |
 *
 * 判定顺序也是刻意的：**核对状态先于版本判定**。若反过来，攻击面就是「改一个 revision 数字
 * 让未核对内容走完版本检查」，而本层对未核对内容的结论不依赖版本是否一致。
 */
export function decideCheckedContent(input: {
  requested: SynthesisTargetRef;
  callerUserId: string;
  snapshot: CheckedContentSnapshot | null;
}): CheckedContentDecision {
  const { requested, callerUserId, snapshot } = input;
  if (snapshot === null) {
    return refuse('TARGET_NOT_FOUND', 'NOT_FOUND', '已核对目标不存在或不可见');
  }
  if (snapshot.ownerUserId !== null && snapshot.ownerUserId !== callerUserId) {
    // 越权与不存在同形：不泄露他人内容是否存在。
    return refuse('TARGET_FOREIGN_OWNER', 'NOT_FOUND', '已核对目标不存在或不可见');
  }
  if (typeof snapshot.type !== 'string' || snapshot.type !== requested.type || snapshot.id !== requested.id) {
    return refuse('TARGET_MISMATCH', 'OBJECT_UNAVAILABLE', '核对源返回的目标与请求不一致');
  }
  if (!isAuditState(snapshot.auditState)) {
    // 取不到核对状态（未知值 / 缺失 / 端口未接线的抛错也走这一支）⇒ 一律不放行。
    return refuse('AUDIT_STATE_UNREADABLE', 'OBJECT_UNAVAILABLE', '取不到该内容的核对状态，按未通过核对拒绝');
  }
  if (snapshot.auditState === 'pending') {
    return refuse('AUDIT_PENDING', 'INPUT_UNCERTAIN', '内容尚未通过核对（待审），不得朗读');
  }
  if (snapshot.auditState === 'rejected') {
    return refuse('AUDIT_REJECTED', 'OBJECT_UNAVAILABLE', '内容已驳回，不可朗读');
  }
  if (snapshot.auditState === 'quarantined') {
    return refuse('AUDIT_QUARANTINED', 'OBJECT_UNAVAILABLE', '内容已隔离，不可朗读');
  }
  // 到这里 auditState 已确定性为 approved（上面三个分支已排除其余取值）。
  const currentRevision = snapshot.revision;
  if (typeof currentRevision !== 'number' || !Number.isInteger(currentRevision) || currentRevision < 1) {
    return refuse('AUDIT_STATE_UNREADABLE', 'OBJECT_UNAVAILABLE', '核对状态自洽性无法验证（revision 非法）');
  }
  if (currentRevision !== requested.revision) {
    return refuse('REVISION_MISMATCH', 'REVISION_CONFLICT', '传入 revision 与内容当前 revision 不一致');
  }
  if (typeof snapshot.text !== 'string' || snapshot.text.trim().length === 0) {
    return refuse('CONTENT_UNREADABLE', 'OBJECT_UNAVAILABLE', '核对通过但取不到可朗读正文');
  }
  return { ok: true, revision: currentRevision, text: snapshot.text };
}

/** 提供者失败码 → 终态（**绝不**落 `succeeded`）。 */
export function stateForProviderFailure(code: ErrorCode): JobState {
  return code === 'PROVIDER_TIMEOUT' ? 'timed_out' : 'failed';
}

/** 合成产物协议错误（提供者输出形状非法）：fail-closed，不修补、不补造。 */
export class SynthesisArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SynthesisArtifactError';
  }
}

/** 合成产物（本域约定的适配层形状，不是契约字段）。 */
export interface SynthesisArtifact {
  /** MIME 类型：#替身产物必须是明确标注的**非音频**类型，不得伪装成 audio/*。 */
  contentType: string;
  /** 产物字节。替身产物是明文标注，**不是**音频字节。 */
  body: Uint8Array;
  /** true = 替身占位产物（非真实音频，不可播放）。 */
  substitute: boolean;
}

export const MAX_ARTIFACT_CONTENT_TYPE_LENGTH = 80;

/**
 * 校验提供者产物。**fail-closed**：
 * - 必须恰为 `{contentType, body, substitute}` 三键（多键/缺键都拒绝，不猜默认值）；
 * - `body` 必须是非空 `Uint8Array`（空产物不得当成功）；
 * - `contentType` 必须是 1..80 的字符串；
 * - `substitute !== true` 的产物必须**不是**替身提供者给出的（见 service.ts 的
 *   `executionMode !== 'real'` 交叉校验）：替身不得声称产出真实音频；
 * - `substitute === true` 时 `contentType` 不得是 `audio/*`：替身不得伪装成真实音频。
 */
export function requireSynthesisArtifact(raw: unknown): SynthesisArtifact {
  if (!isPlainObject(raw)) throw new SynthesisArtifactError('合成产物必须是对象');
  const extra = Object.keys(raw).filter((key) => key !== 'contentType' && key !== 'body' && key !== 'substitute');
  if (extra.length > 0) throw new SynthesisArtifactError(`合成产物含未定义字段 ${extra[0]}`);
  for (const key of ['contentType', 'body', 'substitute'] as const) {
    if (!(key in raw)) throw new SynthesisArtifactError(`合成产物缺少字段 ${key}`);
  }
  const contentType = raw['contentType'];
  const body = raw['body'];
  const substitute = raw['substitute'];
  if (typeof contentType !== 'string' || contentType.length < 1 || contentType.length > MAX_ARTIFACT_CONTENT_TYPE_LENGTH) {
    throw new SynthesisArtifactError(`合成产物 contentType 长度必须在 1..${MAX_ARTIFACT_CONTENT_TYPE_LENGTH}`);
  }
  if (!(body instanceof Uint8Array)) throw new SynthesisArtifactError('合成产物 body 必须是 Uint8Array');
  if (body.byteLength === 0) throw new SynthesisArtifactError('合成产物 body 不得为空（不得把空产物当成功）');
  if (typeof substitute !== 'boolean') throw new SynthesisArtifactError('合成产物 substitute 必须是布尔值');
  if (substitute && contentType.toLowerCase().startsWith('audio/')) {
    // 替身占位产物不得伪装成真实音频（派单 §2.7：不得伪造真实音频）。
    throw new SynthesisArtifactError('替身产物不得声明为 audio/*（不得伪造真实音频）');
  }
  return { contentType, body, substitute };
}
