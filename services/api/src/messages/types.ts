/**
 * GY-I17（#17）阶段 1 · 消息域契约类型。
 *
 * **只读消费** `packages/contracts/openapi.json`（契约 1.0.0，`x-proposal-revision=2`），
 * 本片不改契约、不新增字段、不新增错误码。
 *
 * 逐项核对（2026-10-12，基线 `upstream/main = ffd5bf73`；命令见证据文档）：
 *   - `Message`：`additionalProperties:false`；required **恰为** 7 项
 *     `id`/`revision`/`type`/`target_ref`/`reference_state`/`read_at`/`created_at`。
 *     契约里**没有** `title`/`body`/`actor`/`summary`/`unread`/`source_event` 等字段。
 *     这与 `docs/architecture/state-contract.md`「消息只存事件类型与对象引用，
 *     不保存受限正文缩略」一致：消息本体**不携带目标正文**，可跳转性只由
 *     `reference_state` 表达。因此本片**不伪造**标题/正文/actor，也不为其造替身。
 *   - `Message.type`：闭集 `comment|like|moderation|system`。
 *   - `TargetRef`：三字段全必填；`type` 闭集 17 项（见 `TARGET_REF_TYPES`）、
 *     `id` 1..80、`revision` 整数 ≥1。
 *   - `ReferenceState`：闭集 `available|unavailable`（与 `packages/contracts/states.json`
 *     的 `states.ReferenceState` 同值；语义见 `services/api/src/messages/reference.ts`）。
 *   - `MessagePage`：`items`（`maxItems:50`）+ `next_cursor`（`minLength:1`/`maxLength:2048` 或 null）。
 *   - `UnreadCount`：`{count}`，整数 `minimum:0`。
 *   - Envelope：`{data, meta}` —— `MessagePageEnvelope`/`UnreadCountEnvelope`/`MessageEnvelope`。
 *     封套与 `meta` 由阶段 2 的路由层补齐；本片**只产出 `data` 载荷**（与社区域同口径）。
 */

/** openapi.json -> Message.type（闭集，不得扩展）。 */
export const MESSAGE_TYPES = ['comment', 'like', 'moderation', 'system'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** packages/contracts/states.json -> states.ReferenceState。 */
export const REFERENCE_STATES = ['available', 'unavailable'] as const;
export type ReferenceState = (typeof REFERENCE_STATES)[number];

/** openapi.json -> TargetRef.type（17 项闭集，不得扩展）。 */
export const TARGET_REF_TYPES = [
  'species',
  'herbicide',
  'scheme',
  'static_region',
  'recognition',
  'ocr',
  'transcription',
  'answer',
  'post',
  'comment',
  'conversation', 'conversation_turn',
  'dose_card',
  'media',
  'synthesis',
  'job',
  'source',
] as const;
export type TargetRefType = (typeof TARGET_REF_TYPES)[number];

/** openapi.json -> TargetRef。 */
export interface TargetRef {
  type: TargetRefType;
  id: string;
  revision: number;
}

/**
 * openapi.json -> Message（响应投影；`reference_state` **每次读取时派生**，不入库）。
 *
 * 字段顺序与契约 `properties` 一致，便于与 `additionalProperties:false` 逐字段比对。
 */
export interface Message {
  id: string;
  revision: number;
  type: MessageType;
  target_ref: TargetRef | null;
  reference_state: ReferenceState;
  read_at: string | null;
  created_at: string;
}

/** openapi.json -> MessagePage。 */
export interface MessagePage {
  items: Message[];
  next_cursor: string | null;
}

/** openapi.json -> UnreadCount。 */
export interface UnreadCount {
  count: number;
}

/**
 * 消息接口的调用主体（契约 `security: userSession`）。
 * 与 `services/api/src/community/types.ts` 的 `CommunityActor` 同口径，
 * 但**本片独立定义**：特征域不互相 import（仓库既有分层：特征域只依赖 `auth/` 基础设施）。
 */
export interface MessagesActor {
  userId: string;
  role: 'user' | 'admin';
  authEpoch: number;
}

/**
 * 内部创建口的入参（**不是**契约 operationId，也**不注册**任何路由）。
 *
 * `event_key`：来源事件 + 版本的去重键（**内部字段，不出契约**）。
 * 调用方（将来的审核/社区/系统接线）必须把「事件身份 + 版本」编进该键
 * （例如 `comment:<comment_id>:r3`）；同 `(owner_id, event_key)` 只会存在一条消息
 * ⇒ 重复调度不重复创建（issue #17 验收第 1 条）。
 */
export interface AppendMessageInput {
  owner_id: string;
  type: MessageType;
  target_ref: TargetRef | null;
  event_key: string;
}
