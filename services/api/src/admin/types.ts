/**
 * 后台资料「草稿→发布→撤回」生命周期服务层：共享类型（GY-I18 阶段 1）。
 *
 * 范围声明（与派单 CMD-2026-10-12-I18-ADMIN-CONTENT-PHASE1 一致）：
 * - 本目录只实现 `packages/contracts/openapi.json` 中 25 个 operationId 的**服务层**。
 * - **不注册路由、不改 app.ts、不改 apps/admin/**、不改 miniprogram/**。
 * - 存储为**进程内内存 store**（非真实 PostgreSQL 接线）；`execution_mode` 因此标 `stub`。
 * - 不实现适用性判定、原文用量绑定、剂量换算（属 GY-I08 线），需要处只记跨片依赖。
 */

/** 四类资料家族。契约里 admin 资料只有这四类，其读写 scope 全部复用 sources:read / sources:write。 */
export const ADMIN_FAMILIES = ['sources', 'knowledge', 'registrations', 'restrictions'] as const;
export type AdminFamily = (typeof ADMIN_FAMILIES)[number];

/**
 * 调用方注入的后台身份（本片**不实现登录**）。
 *
 * 字段语义与 `services/api/src/auth/middleware.ts` 的 `readIdentity` 逐条对齐：
 * `userId` / `authEpoch`（正整数）/ `role`（= audience）/ `scopes` 全部由服务端权威来源注入，
 * 本服务层**不接受**来自请求体、查询串或自定义头的身份声明。
 */
export interface AdminIdentity {
  userId: string;
  authEpoch: number;
  role: 'admin' | 'user';
  /** 后台已授予的 scope，例如 'sources:read' / 'sources:write' / 'audit:read'。 */
  scopes: readonly string[];
}

/** 单次调用的上下文：身份 + 契约声明的头部 + 请求标识。 */
export interface AdminCallContext {
  identity: AdminIdentity;
  /** 契约 Meta.request_id（uuid）。缺省时由服务生成，仅用于测试/装配便利。 */
  requestId?: string;
  /** 契约参数 Idempotency-Key（8..128 字符），所有写操作 required。 */
  idempotencyKey?: string;
  /** 契约参数 If-Match（`^"[1-9][0-9]*"$`），edit/publish/withdraw required。 */
  ifMatch?: string;
}

/** 强 ETag：资源当前修订号。契约要求列表响应**不带** ETag 头。 */
export type ETag = `"${number}"`;

/** 服务层响应描述符：阶段 2 的路由直接消费（本片不注册路由，故不返回 Fastify 结构）。 */
export interface ServiceResponse<TBody> {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: TBody;
}

/** 契约 `TargetRef`（components.schemas.TargetRef）。 */
export interface TargetRefValue {
  type: string;
  id: string;
  revision: number;
}

/** 契约 `AuditEvent.result` 闭集。 */
export const AUDIT_RESULTS = ['accepted', 'denied', 'failed'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

/**
 * 内部审计记录：契约 `AuditEvent` 的字段，**加上** `actor_id`。
 *
 * 契约缺口：`AuditEvent` 的 8 个必填字段里**没有主体/actor 字段**，
 * 而派单要求审计事件「含主体」。本片把主体存在只可追加的内部记录上，
 * 契约投影（`projectAuditEvent`）按 `additionalProperties:false` 只输出合同的 8 个字段。
 */
export interface AuditRecord extends ContractAuditEvent {
  actor_id: string;
}

/** 契约 `AuditEvent` 的字面形状（additionalProperties:false）。 */
export interface ContractAuditEvent {
  id: string;
  action: string;
  scope: string;
  target_ref: TargetRefValue | null;
  reason_code: string;
  request_id: string;
  result: AuditResult;
  created_at: string;
}

/** 生命周期状态机（服务层内部；契约没有对应字段）。 */
export type Lifecycle = 'draft' | 'published' | 'withdrawn';

/** 单个资料修订。修订**只可追加**：已发布修订永不原地改写。 */
export interface StoredRevision<TInput> {
  readonly revision: number;
  readonly content: TInput;
  readonly createdAt: Date;
  /** 创建该修订的后台主体。 */
  readonly authorId: string;
  /** 该修订派生自的已发布修订号；草稿首版为 null。 */
  readonly derivedFromRevision: number | null;
}

/** 一个资料实体（跨修订的聚合根）。 */
export interface StoredEntity<TInput> {
  readonly id: string;
  readonly family: AdminFamily;
  /**
   * 管辖主体。契约的草稿 schema 没有 owner/steward 字段，
   * 因此「管辖」是**服务层构造**：非本主体管辖的目标对外一律与「不存在」同形（NOT_FOUND）。
   */
  readonly stewardId: string;
  readonly createdAt: Date;
  readonly revisions: StoredRevision<TInput>[];
  /** 已发布修订号；从未发布为 null。撤回**不**清空它（旧已发布修订保持可追溯）。 */
  publishedRevision: number | null;
  lifecycle: Lifecycle;
  publishedAt: Date | null;
  publishedById: string | null;
  /** 契约 `SourcePublishInput.evidence_ref` 原样留存；本片不解释其语义（属 GY-I08）。 */
  publishedEvidenceRef: string | null;
  /** 契约 `SourcePublishInput.reason` 原样留存。 */
  publishedReason: string | null;
  withdrawnAt: Date | null;
  withdrawnById: string | null;
  /** 契约 `ReasonInput.reason` 原文；契约 `AuditEvent` 无自由文本字段，故只能留在实体上。 */
  withdrawnReason: string | null;
}

/** 幂等台账结果引用：只放**不含凭据**的已定型响应（状态 + 头 + 体），用于同键重放。 */
export interface ContentIdempotencyOutcome {
  kind: 'admin_content';
  status: number;
  headers: Readonly<Record<string, string>>;
  body: unknown;
}

/** 幂等台账记录。 */
export interface ContentIdempotencyRecord {
  requestHash: string;
  responseStatus: number;
  outcome: ContentIdempotencyOutcome;
  expiresAt: Date;
}
