/**
 * GY-I15（#15）阶段 1 · 社区域服务层类型。
 *
 * 形状来源：`packages/contracts/openapi.json`（契约 1.0.0），**只读消费、不修改契约**。
 * 本文件只声明**契约已定义**的字段；凡是契约没有的字段（例如点赞计数、举报详情回显、
 * 审核结论里的 model_version／prompt_version）都不在这里造，见 service.ts 的边界声明。
 *
 * 对照的契约 schema：
 *   PostInput / Post / CommentInput / Comment / ReportInput / Report / ReportTarget /
 *   TargetRef / Author / CommunityMediaRef / KnowledgeTarget / KnowledgeLink /
 *   PostPage / CommentPage / Visibility / AuditState。
 */

/** openapi.json -> Visibility（闭集 4 值）。 */
export type Visibility = 'private' | 'published' | 'hidden' | 'deleted';

/** openapi.json -> AuditState（闭集 4 值，与 packages/moderation 一致）。 */
export type AuditState = 'pending' | 'approved' | 'rejected' | 'quarantined';

/** openapi.json -> TargetRef.properties.type.enum（17 值）。 */
export type TargetType =
  | 'species'
  | 'herbicide'
  | 'scheme'
  | 'static_region'
  | 'recognition'
  | 'ocr'
  | 'transcription'
  | 'answer'
  | 'post'
  | 'comment'
  | 'conversation' | 'conversation_turn'
  | 'dose_card'
  | 'media'
  | 'synthesis'
  | 'job'
  | 'source';

/** openapi.json -> TargetRef（id 1..80、revision ≥1 正整数）。 */
export interface TargetRef {
  type: TargetType;
  id: string;
  revision: number;
}

/** openapi.json -> ReportTarget（type 收窄为 post / comment）。 */
export interface ReportTarget {
  type: 'post' | 'comment';
  id: string;
  revision: number;
}

export type KnowledgeTargetType = 'species' | 'herbicide' | 'scheme';

/** openapi.json -> KnowledgeTarget。 */
export interface KnowledgeTarget {
  type: KnowledgeTargetType;
  id: string;
  revision: number;
}

/** openapi.json -> CommunityMediaRef。 */
export interface CommunityMediaRef {
  media_id: string;
  media_revision: number;
}

/** openapi.json -> KnowledgeLinkSummary。 */
export interface KnowledgeLinkSummary {
  title: string;
}

/**
 * openapi.json -> KnowledgeLink。
 * 本片不接线资料可用性查询（阶段 2 由 GY-I15 接线 GY-I04/GY-I05 的资料读取），
 * 因此响应里的关联投影恒为 `null`，且**显式关联一律拒绝**（见 service.ts）。
 */
export interface KnowledgeLink {
  target_ref: KnowledgeTarget;
  reference_state: string;
  unavailable_reason: 'TARGET_UNAVAILABLE' | null;
  summary: KnowledgeLinkSummary | null;
}

/** openapi.json -> Author（revision 来自 public_authors，不是 post/media revision）。 */
export interface Author {
  display_name: string;
  display_id: string;
  state: 'active' | 'anonymized';
  avatar_media_id: string | null;
  revision: number;
  avatar_media: CommunityMediaRef | null;
}

/** openapi.json -> PostInput（additionalProperties:false）。 */
export interface PostInput {
  title: string;
  body: string;
  media_ids: string[];
  crop_id?: string;
  region_code?: string;
  linked_knowledge_ref?: KnowledgeTarget | null;
}

/** openapi.json -> Post。所有创建/详情/列表/编辑响应共用此形状。 */
export interface Post {
  id: string;
  revision: number;
  author: Author;
  title: string;
  body: string;
  crop_id: string | null;
  region_code: string | null;
  media_ids: string[];
  visibility: Visibility;
  audit_state: AuditState;
  created_at: string;
  updated_at: string;
  media: CommunityMediaRef[];
  linked_knowledge_ref: KnowledgeTarget | null;
  linked_knowledge: KnowledgeLink | null;
}

/** openapi.json -> CommentInput。 */
export interface CommentInput {
  body: string;
}

/** openapi.json -> Comment（没有 updated_at，也没有点赞计数）。 */
export interface Comment {
  id: string;
  revision: number;
  post_id: string;
  author: Author;
  body: string;
  visibility: Visibility;
  audit_state: AuditState;
  created_at: string;
}

/** openapi.json -> ReportInput.properties.reason_code.enum。 */
export type ReportReasonCode = 'dangerous' | 'privacy' | 'advertising' | 'misleading' | 'other';

/** openapi.json -> ReportInput（required: target_ref / reason_code）。 */
export interface ReportInput {
  target_ref: ReportTarget;
  reason_code: ReportReasonCode;
  detail?: string;
}

/** openapi.json -> Report（没有举报人字段：举报者身份不对外投影）。 */
export interface Report {
  id: string;
  revision: number;
  target_ref: TargetRef;
  state: 'received' | 'isolated' | 'closed';
  reason_code: string;
}

/** openapi.json -> PostPage（items ≤50 + next_cursor）。 */
export interface PostPage {
  items: Post[];
  next_cursor: string | null;
}

/** openapi.json -> CommentPage。 */
export interface CommentPage {
  items: Comment[];
  next_cursor: string | null;
}

/** openapi.json -> Ack。 */
export interface Ack {
  accepted: boolean;
}

/**
 * 调用方主体：由鉴权阶段（阶段 2 的 Fastify 中间件）注入。
 *
 * 本片没有 HTTP 层，因此不读取 `req`；但语义与 `auth/middleware.ts` 的
 * `readIdentity` 一致：缺 userId／authEpoch／role ⇒ SESSION_REQUIRED，
 * 非 user 角色（后台会话）⇒ SCOPE_DENIED 仅服务层兜底：HTTP 面 `authenticateUser` 只取 'user' 会话，实际返 401 `SESSION_EXPIRED`。
 */
export interface CommunityActor {
  userId: string;
  role: 'user' | 'admin';
  authEpoch: number;
}

/** 作者投影来源。阶段 2 接 `public_authors`；本片只做可注入的假名投影（见 authors.ts）。 */
export interface AuthorDirectory {
  resolve(userId: string): Promise<Author | null>;
  /**
   * 注销去身份（F13 第 279 行）：把该主体此后的一切作者投影换成**不可反查原账户的注销引用**
   * （`display_name: '已注销用户'`、`state: 'anonymized'`、随机 `display_id`、默认头像）。
   *
   * **可选能力**：注入的替身可能只实现读路径。缺它时注销装配处必须如实把「作者引用未替换」
   * 计入 `blocked`，⛔ 不得静默跳过（那正是"未完成却报完成"）。
   */
  anonymize?(userId: string): Promise<Author>;
}
