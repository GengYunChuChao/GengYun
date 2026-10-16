/**
 * GY-I12（#12）· 文字问答子域类型（契约 = 唯一权威）。
 *
 * 逐项对照 `packages/contracts/openapi.json`（契约 1.0.0）的 `components.schemas`：
 *   `Conversation` / `ConversationInput` / `Turn` / `TurnInput`（`TextTurnInput` /
 *   `SpeechTurnInput`）/ `Answer` / `SourceRef` / `DoseCard` / `Conditions`。
 *
 * **本文件不新增契约外字段**：下列每个内部记录都是「契约实体 + 服务端内部键
 * （`owner_id` / `job_id` / `job_state`）」的组合，内部键一律**不进响应**
 * （由 `service.ts` 的投影函数负责剥离；`CONVERSATION_KEYS` / `TURN_KEYS` / `ANSWER_KEYS`
 * 是投影后**恰好**应等于的契约键集，供回归用例逐键比对）。
 *
 * 诚实标注（红线）：`model_version` / `prompt_version` 的契约形状是自由字符串
 * （`minLength 1`、`maxLength 80`），本片**必须**让它们可被机器判据检出「未接真实模型」，
 * 因此固定使用 `UNIMPLEMENTED_VERSION_PREFIX` 前缀（见下）—— 绝不使用任何看起来像
 * 真实模型/提示词版本的取值，也绝不把替身能力记为真实成功。
 */

/** 契约 `Answer.status` 闭集。 */
export const ANSWER_STATUS = ['answered', 'insufficient', 'blocked'] as const;
export type AnswerStatus = (typeof ANSWER_STATUS)[number];

/** 契约 `Answer.check_state` 闭集。 */
export const CHECK_STATES = ['passed', 'blocked'] as const;
export type CheckState = (typeof CHECK_STATES)[number];

/** 契约 `Job.state` 闭集（`states.json` 的 `job_transitions` 键）。 */
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

/**
 * 「未接真实模型」的**机器可判据**前缀（红线②）。
 *
 * 契约三个版本串的取值口径（本片固定，`tests/unit/conversation-answer-guard.test.mjs`
 * 以正则 `^unimplemented:no-real-` 逐条断言，缺一即红）：
 *   - `model_version`  = `<前缀>model/text-qa-stub`
 *   - `prompt_version` = `<前缀>prompt/deterministic-citation-guard`
 *   - `rule_version`   = `<前缀>rule/<确定性规则版本>`
 *
 * 为什么不写 `stub-v1` 之类：那**可以**被读成某个替身/真实模型的版本号。带
 * `unimplemented:no-real-` 前缀的串在任何客户端都是显式「未实现」标记，
 * 且**无法**与"真实模型结果"混淆 —— 这正是本片唯一允许的标注方式。
 */
export const UNIMPLEMENTED_VERSION_PREFIX = 'unimplemented:no-real-';

/** 契约 `Conversation.conditions` 的形状（`Conditions`：六项可选属性，`crop_id`/`region_code` 必填）。 */
export interface Conditions {
  crop_id: string;
  region_code: string;
  species_id?: string;
  growth_stage?: string;
  planting_method?: string;
  use_scene?: string;
}

/** 契约 `SourceRef`（十键全必填，`additionalProperties:false`）。 */
export interface SourceRef {
  id: string;
  version: string;
  title: string;
  url: string;
  publisher: string;
  source_kind: string;
  evidence_kind: string;
  validity: string;
  review_status: string;
  updated_at: string;
}

/** 契约 `DoseCard`（十一键全必填；本基线资料基座恒不可就绪 ⇒ 恒为空数组）。 */
export type DoseCard = Record<string, unknown>;

/** 契约 `Conversation` 的**响应投影**（四键全必填）。 */
export interface ConversationView {
  id: string;
  revision: number;
  conditions: Conditions | null;
  created_at: string;
}

/** 契约 `Turn` 的**响应投影**（七键全必填）。 */
export interface TurnView {
  id: string;
  revision: number;
  input_text: string;
  transcription_ref: { type: string; id: string; revision: number } | null;
  job_id: string;
  answer: AnswerView | null;
  created_at: string;
}

/** 契约 `Answer` 的**响应投影**（十键全必填）。 */
export interface AnswerView {
  id: string;
  revision: number;
  status: AnswerStatus;
  checked_text: string;
  check_state: CheckState;
  citations: SourceRef[];
  dose_cards: DoseCard[];
  model_version: string;
  prompt_version: string;
  rule_version: string;
}

/** 持久化记录 = 契约实体 + 服务端内部键（**内部键不进响应**）。 */
export interface ConversationRecord {
  id: string;
  revision: number;
  owner_id: string;
  conditions: Conditions | null;
  created_at: Date;
  updated_at: Date;
}

/** 轮次记录。`job_*` 是**受理时**写下的作业快照（重启后仍可如实读出，不是估算）。 */
export interface TurnRecord {
  id: string;
  revision: number;
  conversation_id: string;
  owner_id: string;
  input_text: string;
  transcription_ref: { type: string; id: string; revision: number } | null;
  job_id: string;
  job_state: JobState;
  job_deadline_at: Date;
  job_created_at: Date;
  job_error_code: string | null;
  answer_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** 回答记录（`id` 与 `TurnRecord.answer_id` 一致；`turn_id` 用于归属与级联核对）。 */
export interface AnswerRecord {
  id: string;
  revision: number;
  turn_id: string;
  owner_id: string;
  status: AnswerStatus;
  checked_text: string;
  check_state: CheckState;
  citations: SourceRef[];
  dose_cards: DoseCard[];
  model_version: string;
  prompt_version: string;
  rule_version: string;
  created_at: Date;
  updated_at: Date;
}

/** 调用主体（与 `auth/middleware.ts` 的 `readIdentity` 同口径）。 */
export interface ConversationActor {
  userId: string;
  authEpoch: number;
  role: 'user' | 'admin';
}

/** 契约 `TurnInput` 的两种输入（判别子 `input_type`）。 */
export type TurnInput =
  | { input_type: 'text'; text: string }
  | { input_type: 'speech'; transcription_id: string; transcription_revision: number; confirmed: true };

/** 契约 `Conversation` 键集（投影后必须**恰好**等于它；`additionalProperties:false`）。 */
export const CONVERSATION_KEYS = ['id', 'revision', 'conditions', 'created_at'] as const;

/** 契约 `Turn` 键集。 */
export const TURN_KEYS = [
  'id',
  'revision',
  'input_text',
  'transcription_ref',
  'job_id',
  'answer',
  'created_at',
] as const;

/** 契约 `Answer` 键集。 */
export const ANSWER_KEYS = [
  'id',
  'revision',
  'status',
  'checked_text',
  'check_state',
  'citations',
  'dose_cards',
  'model_version',
  'prompt_version',
  'rule_version',
] as const;

/** 契约 `SourceRef` 键集。 */
export const SOURCE_REF_KEYS = [
  'id',
  'version',
  'title',
  'url',
  'publisher',
  'source_kind',
  'evidence_kind',
  'validity',
  'review_status',
  'updated_at',
] as const;

export function isAnswerStatus(value: unknown): value is AnswerStatus {
  return typeof value === 'string' && (ANSWER_STATUS as readonly string[]).includes(value);
}

export function isCheckState(value: unknown): value is CheckState {
  return typeof value === 'string' && (CHECK_STATES as readonly string[]).includes(value);
}

export function isJobState(value: unknown): value is JobState {
  return typeof value === 'string' && (JOB_STATES as readonly string[]).includes(value);
}
