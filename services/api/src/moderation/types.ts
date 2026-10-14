/**
 * GY-I14（#14）审核 HTTP 装配片 · 类型与常量（**只读**对照冻结契约）。
 *
 * 契约来源（`packages/contracts/openapi.json`，本片只读消费、不新增字段/路径）：
 *   - `AuditState` = pending | approved | rejected | quarantined（闭集 4 值）
 *   - `Visibility` = private | published | hidden | deleted（闭集 4 值）
 *   - `TargetRef`  = { type(16 值闭集), id(1..80), revision(≥1) }
 *   - `Moderation` = { id, target_ref, decision, reason_codes(≤30，每条 1..80),
 *                      hard_rule_passed, model_version(1..80), prompt_version(1..80), rule_version(1..80) }
 *   - `Job`/`JobResult`：`kind: 'moderation'` ⇒ `ModerationResult = { kind:'moderation', value: Moderation }`
 *   - `JobState` = queued | running | succeeded | uncertain | failed | timed_out | cancelled
 *   - 错误码闭集见 `packages/contracts/states.json#error_status_map`
 *
 * 本片**不新增**任何 operationId/path：审核结论经**已有** `GET /jobs/{id}` 读取（kind=moderation），
 * 供应商回调**不在** OpenAPI 开放（架构决议 `docs/architecture/adr-001-initial-architecture.md`：
 * “供应商 callback 只允许服务端受信端点并验签，不在客户端 OpenAPI 开放”）——因此回调在本片是
 * **服务端受信 seam**（`callback.ts`），不是一条新路由。
 */

/** 契约 `TargetRef.properties.type.enum`（16 值，逐项一致）。 */
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
  'conversation',
  'dose_card',
  'media',
  'synthesis',
  'job',
  'source',
] as const;
export type TargetType = (typeof TARGET_REF_TYPES)[number];

/** 契约 `AuditState`（闭集 4 值）。 */
export const AUDIT_STATES = ['pending', 'approved', 'rejected', 'quarantined'] as const;
export type AuditState = (typeof AUDIT_STATES)[number];

/** 契约 `Visibility`（闭集 4 值）。 */
export const VISIBILITIES = ['private', 'published', 'hidden', 'deleted'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/** 契约 `JobState`（闭集 7 值）。 */
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

/** 契约 `Job.properties.kind.enum` 中与本片相关的值。 */
export const MODERATION_JOB_KIND = 'moderation';

/** 契约 `TargetRef`。 */
export interface TargetRef {
  type: TargetType;
  id: string;
  revision: number;
}

/** 契约 `Moderation`（`id` 由持久层/本片生成，其余字段逐项对应）。 */
export interface ContractModeration {
  id: string;
  target_ref: TargetRef;
  decision: AuditState;
  reason_codes: string[];
  hard_rule_passed: boolean;
  model_version: string;
  prompt_version: string;
  rule_version: string;
}

/**
 * 版本级审核任务的内容类别：**文字与图片各自成任务**（派单 §2.1）。
 * 两类任务各有独立 `job_id`、独立端口（tms/ims）、独立 prompt 模板与独立结论行
 * （对照数据字典 `moderation_decisions` 的 `unique(target_type,target_id,revision,job_id)`）。
 */
export const CONTENT_KINDS = ['text', 'image'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

/** 内容类别 ⇒ 模型端口类别（tms=文本审核端口，ims=图片审核端口）。 */
export const PORT_KIND_BY_CONTENT_KIND: Readonly<Record<ContentKind, 'tms' | 'ims'>> = Object.freeze({
  text: 'tms',
  image: 'ims',
});

/** 内容类别 ⇒ prompt 模板 id（与 `packages/moderation/prompts.mjs` 的映射一致）。 */
export const PROMPT_ID_BY_CONTENT_KIND: Readonly<Record<ContentKind, string>> = Object.freeze({
  text: 'text_moderation',
  image: 'image_moderation',
});

/** 执行模式（契约 `ExecutionMode` 闭集 3 值）。 */
export const EXECUTION_MODES = ['real', 'stub', 'preset_demo'] as const;
export type ModerationExecutionMode = (typeof EXECUTION_MODES)[number];

/**
 * 人审入口状态：**空态**。
 *
 * 首版没有人工审核队列、没有审核人、没有专家认证（派单 §3：人审入口保持空态，
 * **不得**造假任务/假审核人/假投票/专家认证）。该值取自契约 `Home.human_review_state`
 * 的 `const: "under_construction"`，是全仓唯一的“人审未上线”事实表达。
 */
export const HUMAN_REVIEW_STATE = 'under_construction';

/**
 * 公众票决：**首版不进入**（派单 §2.5）。
 *
 * 本常量是"未开启"的可断言事实；用例同时扫描契约与本模块出口，
 * 断言不存在任何票决 operationId/字段/函数。
 */
export const PUBLIC_VOTE_ENABLED = false as const;

/** 调用主体（与 `auth/middleware.ts` 的 `readIdentity` 同口径）。 */
export interface ModerationActor {
  userId: string;
  role: 'user' | 'admin';
  authEpoch: number;
}

/**
 * 模型端口回报里的**控制类字段黑名单**（非绕过守卫，见 `nonbypass.ts`）。
 *
 * 这些字段任何模型/供应商回报都**不得**携带：权限、角色、来源、可见性、发布、
 * 专家认证、人审结论、票决。命中即拒绝整条回报（不是静默丢弃——
 * 静默丢弃会让"模型试图提权"这一事实消失）。
 */
export const MODEL_FORBIDDEN_CONTROL_FIELDS = Object.freeze([
  'role',
  'roles',
  'scope',
  'scopes',
  'permission',
  'permissions',
  'grant',
  'grants',
  'user_id',
  'userid',
  'owner_id',
  'source_kind',
  'source',
  'provenance',
  'visibility',
  'published',
  'publish',
  'decision',
  'expert_reviewed',
  'expert_review',
  'expert',
  'human_review',
  'human_review_state',
  'reviewer',
  'reviewer_id',
  'vote',
  'votes',
  'vote_count',
  'train',
  'training',
  'epoch',
  'auth_epoch',
  'account_state',
  'deleted',
  'withdraw',
]);

/** 版本级审核任务（`moderation_decisions` 行 + 它是哪条作业）。 */
export interface ModerationTaskRecord {
  /** 任务/作业 id（uuid）。一条版本级任务 = 一行 `moderation_decisions` + 一条 `Job`。 */
  job_id: string;
  target_ref: TargetRef;
  content_kind: ContentKind;
  port_kind: 'tms' | 'ims';
  prompt_id: string;
  /** 作业版本：每次状态推进 +1（回调必须回带当前值，见 callback.ts）。 */
  job_revision: number;
  state: JobState;
  /** 领取租约（回调必须回带且相等；过期/旧租约 ⇒ 拒绝，旧回调不复活）。 */
  lease_token: string;
  /** 该任务被授权时的账号/授权 epoch（撤回/注销后旧回调不得回写）。 */
  authorization_epoch: number;
  /** 送审主体（归属判定：他人作业与"作业不存在"**同形** 404；非契约字段，不进 HTTP 投影）。 */
  submitted_by: string;
  /** 任务截止时间（受理时刻 + 审核截止；契约 `Job.deadline_at` 必填）。 */
  deadline_at: string;
  decision: AuditState;
  reason_codes: string[];
  hard_rule_passed: boolean;
  rule_version: string | null;
  model_version: string | null;
  prompt_version: string | null;
  /** 契约合法的 `Moderation`（不合法时为 `null`：**绝不**填占位串）。 */
  contract_value: ContractModeration | null;
  /** 版本/放行闸门载体（非契约，只存摘要/计数/闭集码；见 `GateHolder`）。 */
  gate_holder: GateHolder;
  /** 契约 `ErrorCode`（终态失败/超时时必填，与 `jobs/registry.ts` 的不变式一致）。 */
  error_code: string | null;
  evidence: TaskEvidence;
  created_at: string;
  updated_at: string;
  /** 同 (target,revision,content_kind) 被更新的任务取代时置 true（保留审计，不再作为当前结论）。 */
  superseded: boolean;
}

/** 单个端口类别的模型执行证据条目（与 `packages/moderation` 的 `model_layer.kinds` 同形）。 */
export interface GateKindEntry {
  kind: 'tms' | 'ims';
  status: 'not_invoked' | 'failed' | 'blocked' | 'pass';
  label: string | null;
  reason_codes: string[];
  reported: Record<string, unknown> | null;
  synthetic: boolean;
}

/**
 * **版本/放行闸门的输入载体**（非契约字段）：合流结果里供
 * `checkMergedInvariant` / `evaluateModelReReview` / `isModelLayerPublishable` 读取的字段子集。
 *
 * 为什么必须留存它：审核结论不能"写时信任一次"。回读（发布、读取可见性、重审）时必须能
 * **重跑**已合并模型层的版本绑定与放行闸门，而不是另写一套判定。本载体不含任何原文
 * （只有摘要、计数、闭集原因码与端口状态）。
 */
export interface GateHolder {
  target_ref: TargetRef;
  decision: AuditState;
  reason_codes: string[];
  hard_rule_passed: boolean;
  rule_version: string | null;
  model_version: string | null;
  prompt_version: string | null;
  input_binding: {
    schema: string;
    digest: string | null;
    media_count: number | null;
    text_length: number | null;
    verified: boolean;
  } | null;
  model_layer: {
    status: 'attempted' | 'not_attempted';
    kinds: Record<string, GateKindEntry>;
    reason_codes: string[];
    synthetic_ports: string[];
  } | null;
}

/** 结构结果／理由／证据／模型模板与规则版本的登记（非契约字段，绝不投影进契约 `Moderation`）。 */
export interface TaskEvidence {
  execution_mode: ModerationExecutionMode;
  /** 实际求值的端口与其模型版本；未接线时为 `null`（**不填替身冒充**）。 */
  provider: {
    kind: 'tms' | 'ims';
    model_version: string | null;
    biz_type: string | null;
    synthetic: boolean;
    /** `'injected'`=调用方注入的端口；`'substitute'`=本片明确标注的替身；
     *  `'callback'`=结论来自供应商异步回调；`'none'`=未接线。 */
    origin: 'injected' | 'substitute' | 'callback' | 'none';
  } | null;
  /** 模型模板标识（prompt id）。 */
  model_template: string;
  /** 输入绑定摘要（结论绑定**它实际检查过的内容**；不落原文）。 */
  input_binding_digest: string | null;
  input_binding_verified: boolean;
  /** 只计长度/计数，绝不落原文（PII/坐标/链接不进审核记录）。 */
  text_length: number | null;
  media_count: number;
  /** 已检查的媒体**不透明引用**（`media_id:revision`），不含字节。 */
  checked_media_refs: string[];
  rule_reason_codes: string[];
  model_reason_codes: string[];
  /** 本次内容所需的全部端口执行证据（合流层口径，逐项原样留存）。 */
  model_kinds: GateKindEntry[];
  /** 可判别理由（闭集原因码，不含原文）。 */
  reasons: string[];
  rule_counts: Record<string, unknown> | null;
}

/** 契约合法的任务投影（读面出口；不含任何原文、不含内部字段）。 */
export interface ModerationTaskView {
  job_id: string;
  job_revision: number;
  /**
   * 领取租约（**非契约字段**）：仅供**服务端受信回调 seam** 回带核对。
   * **绝不得**投影进任何 HTTP 响应（作业读面 `job-source.ts` 逐字段重建投影，不扩散本字段；
   * 用例显式断言响应体里不含它）。
   */
  lease_token: string;
  target_ref: TargetRef;
  content_kind: ContentKind;
  port_kind: 'tms' | 'ims';
  prompt_id: string;
  state: JobState;
  decision: AuditState;
  reason_codes: string[];
  hard_rule_passed: boolean;
  rule_version: string | null;
  model_version: string | null;
  prompt_version: string | null;
  error_code: string | null;
  contract_value: ContractModeration | null;
  evidence: TaskEvidence;
  created_at: string;
  updated_at: string;
  /** 归属主体（非契约字段：供作业面做同形 404 判定）。 */
  submitted_by: string;
  deadline_at: string;
  superseded: boolean;
}

/** 审核内容（送审输入；正文与**显式声明**的媒体引用）。 */
export interface ModerationContent {
  target_ref: TargetRef;
  text: string;
  media: Array<{ media_id: string; media_revision?: number; mime?: string }>;
}

/** 权威内容状态读取结果（读缓存**不作数**：每次读取都重新问）。 */
export interface AuthoritySnapshot {
  exists: boolean;
  visibility: Visibility;
  /** 作者账号状态：`inactive`（停用/注销中）与 `anonymized`（已去身份）都不得重新公开。 */
  author_state: 'active' | 'anonymized' | 'inactive';
  source_kind: 'database' | 'verified_seed' | 'simulation';
  /** 内容所有者（`private` 可见性只对所有者开放；作者投影不是身份来源）。 */
  owner_id: string | null;
  /** 权威侧的当前 revision（与 `target_ref.revision` 不一致 ⇒ 旧链接，不得可见）。 */
  current_revision: number;
}

/**
 * 内容权威端口：可见性/账号状态/来源的**唯一**事实来源。
 *
 * 读路径必须**每次**经此端口重查（`visibility.ts` 的读缓存只作提示，命中缓存也要重查）。
 * 本片提供内存替身实现（`createSubstituteContentAuthority`，明确标注 `origin: 'substitute'`）
 * 与 real 未接线时的 fail-closed 实现（`createUnwiredContentAuthority`）。
 */
export interface ContentAuthorityPort {
  readonly origin: 'substitute' | 'unwired';
  read(target_ref: TargetRef): Promise<AuthoritySnapshot | null>;
  setVisibility(target_ref: TargetRef, visibility: Visibility): Promise<void>;
  /** 记录该目标被**上架**的 revision（下架后置空 ⇒ 旧链接不复活）。 */
  setPublishedRevision(target_ref: TargetRef, revision: number | null): Promise<void>;
  publishedRevision(target_ref: TargetRef): Promise<number | null>;
}
