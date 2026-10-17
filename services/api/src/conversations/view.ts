/**
 * GY-I12（#12）· **响应投影**（契约 ⇄ 内部记录的唯一转换点）。
 *
 * 硬纪律：投影出来的对象键集合**恰好**等于契约声明（`CONVERSATION_KEYS` / `TURN_KEYS` /
 * `ANSWER_KEYS` / `SOURCE_REF_KEYS`），因为契约里这些 schema 都是 `additionalProperties:false`
 * —— 多给一个内部键（`owner_id` / `job_state` / `turn_id` …）就是契约外字段，
 * 少给一个必填键就是不合契约。这里**逐键构造**，不使用 `{...record}` 展开，
 * 避免内部键随记录演进而"漏"进响应（回归用例逐键比对，见 `conversation-http.test.mjs`）。
 *
 * 时间一律 `Date.prototype.toISOString()`（与 `knowledge/service.ts` 的既有口径一致），
 * 日期非法时**抛出**而不是编造一个时间串。
 */
import { ApiError } from '../errors.ts';
import {
  type AnswerRecord,
  type AnswerView,
  type ConversationRecord,
  type ConversationView,
  type DoseCard,
  type SourceRef,
  type TurnRecord,
  type TurnView,
} from './types.ts';

function iso(value: Date, field: string): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    // 内部记录自相矛盾 ⇒ 确定性缺陷（重试不会改善）：retryable 必须为 false。口径见 services/api/src/errors.ts 的 ApiError 注释。
    throw new ApiError('PROVIDER_UNAVAILABLE', `内部记录字段 ${field} 不是合法时间`, { retryable: false });
  }
  return value.toISOString();
}

/** 契约 `SourceRef` 投影（十键，逐键构造）。 */
export function sourceRefViewOf(source: SourceRef): SourceRef {
  return {
    id: source.id,
    version: source.version,
    title: source.title,
    url: source.url,
    publisher: source.publisher,
    source_kind: source.source_kind,
    evidence_kind: source.evidence_kind,
    validity: source.validity,
    review_status: source.review_status,
    updated_at: source.updated_at,
  };
}

/** 契约 `Conversation` 投影（四键）。 */
export function conversationViewOf(record: ConversationRecord): ConversationView {
  return {
    id: record.id,
    revision: record.revision,
    // `conditions` 是契约里的可空对象；逐键拷贝，避免内部引用被调用方改写。
    conditions: record.conditions === null ? null : { ...record.conditions },
    created_at: iso(record.created_at, 'conversation.created_at'),
  };
}

/** 契约 `Answer` 投影（十键；`status`/`check_state` 的原值原样透出）。 */
export function answerViewOf(record: AnswerRecord): AnswerView {
  return {
    id: record.id,
    revision: record.revision,
    status: record.status,
    checked_text: record.checked_text,
    check_state: record.check_state,
    citations: record.citations.map((citation) => sourceRefViewOf(citation)),
    dose_cards: record.dose_cards.map((card) => ({ ...(card as DoseCard) })),
    model_version: record.model_version,
    prompt_version: record.prompt_version,
    rule_version: record.rule_version,
  };
}

/** 契约 `Turn` 投影（七键；`answer` 无回答时为 `null`，**不**用空对象占位）。 */
export function turnViewOf(record: TurnRecord, answer: AnswerRecord | null): TurnView {
  // 回答行存在但记录里没挂上 ⇒ 内部不一致，宁可 503 也不透出"半个回答"。
  if (record.answer_id !== null && answer === null) {
    // 内部记录自相矛盾 ⇒ 确定性缺陷（重试不会改善）：retryable 必须为 false。口径见 services/api/src/errors.ts 的 ApiError 注释。
    throw new ApiError('PROVIDER_UNAVAILABLE', '轮次记录指向的回答行缺失（拒绝透出）', { retryable: false });
  }
  if (record.answer_id === null && answer !== null) {
    // 内部记录自相矛盾 ⇒ 确定性缺陷（重试不会改善）：retryable 必须为 false。口径见 services/api/src/errors.ts 的 ApiError 注释。
    throw new ApiError('PROVIDER_UNAVAILABLE', '未挂载回答的轮次出现了回答行（拒绝透出）', { retryable: false });
  }
  return {
    id: record.id,
    revision: record.revision,
    input_text: record.input_text,
    transcription_ref: record.transcription_ref === null ? null : { ...record.transcription_ref },
    job_id: record.job_id,
    answer: answer === null ? null : answerViewOf(answer),
    created_at: iso(record.created_at, 'turn.created_at'),
  };
}
