/**
 * GY-I15（#15）阶段 1 · 社区域服务层（服务端语义，**不注册路由**）。
 *
 * 覆盖契约 operationId：`listPosts`/`createPost`/`getPost`/`editPost`/`deletePost`、
 * `listComments`/`createComment`/`getComment`/`editComment`/`deleteComment`、
 * `likePosts`/`unlikePosts`/`likeComments`/`unlikeComments`、`createReport`/`getOwnReport`。
 * **不做** `hidePost`（属 #18）、`/community/media*`（依赖媒体接线）。
 *
 * 核心不变式（先审后发）：
 *   一条内容**对外可见** ⟺ `visibility === 'published'` 且 `audit_state === 'approved'`
 *   且存在一条审核结论**恰好绑定** `TargetRef{type,id,当前revision}`、`rule_version` 等于
 *   当前派生版本、且 `text_digest` 等于当前正文摘要，并且 `evaluateReReview` 与
 *   `isPublishable` 都同意可发布。
 *   可见性在**每次读取时**重新计算（`assess`），因此规则集升级后旧结论自动失效、
 *   内容立即退出列表，直到重审通过——不是"写时信任一次、之后永远可见"。
 *
 * 未取得（如实声明，不得当作已完成）：
 *   - 没有 HTTP 路由、没有 `app.ts` 装配（阶段 2）；返回的是契约 **data 载荷**，
 *     `meta`/封套由阶段 2 的路由层补齐；
 *   - 没有数据库迁移，只有内存存储（进程重启即丢）；
 *   - **模型层审核（LLM）不在本片**：`Moderation.model_version`/`prompt_version` 不产出、
 *     不填占位串；因此本片不得声称审核准确率/召回率（真实样本各为 0，见
 *     `docs/evaluation/sample-gap-register.md`）；
 *   - 带图片的帖子一律**不得发布**（图片审核属模型层，规则层遇媒体即隔离）；
 *   - 阶段 2 已接线「杂草／药剂关联」可用性端口（`knowledge.ts`，默认未接线 ⇒ 新增/替换引用
 *     一律 `OBJECT_UNAVAILABLE`），以及审核结果/下架事件投递（`events.ts` → 消息中心公开端口）。
 *     带媒体的目标**仍然不可能被抬成 `approved`**：规则层对带媒体目标一律不判通过
 *     （`packages/moderation/merge.mjs` 明确声明这是跨片依赖），因此"图片帖子"本片**未取得**。
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../errors.ts';
import { sha256Hex } from '../auth/tokens.ts';
import { idempotencyKeyHashHex, idempotencyRequestHash, idempotencyScope } from '../auth/idempotency.ts';
import { createPublishGate } from './moderation-gate.ts';
import type { GateOutcome, PublishGate, RuleLayerVerdict } from './moderation-gate.ts';
// 阶段 2 接线（#15）：杂草／药剂关联可用性 + 审核结果/下架事件投递。
// 两者都是**可选**依赖，且默认实现一律 fail-closed；不注入时与阶段 1 逐字同行为
// （唯一例外是"编辑遗漏关联保留旧值"这一条契约语义修正，见 editPost 注释）。
import {
  createUnwiredKnowledgeAvailabilityPort,
  unavailableLink,
  type KnowledgeAvailabilityPort,
  type KnowledgeLinkProjection,
} from './knowledge.ts';
import {
  createUnwiredCommunityEventsPort,
  type CommunityEvent,
  type CommunityEventTarget,
  type CommunityEventsPort,
} from './events.ts';
// GY-I14 ⇄ GY-I15 联动接线（#14 + #15）：版本级审核任务与"明确驳回"否决来自已合并审核域。
// 社区**不 import** `services/api/src/moderation/**`；这里只消费结构性端口（由装配层传入）。
import {
  linkActorOf,
  readImageModerationReadiness,
  type CommunityModerationLink,
  type LinkConclusion,
  type LinkImageReadiness,
  type LinkScreenResult,
} from './moderation-link.ts';
import type {
  CommentCommitPatch,
  CommentRecord,
  CommitFailureReason,
  CommunityStore,
  IdempotencyOutcome,
  ModerationRecord,
  PostCommitPatch,
  PostRecord,
  ReportRecord,
} from './store.ts';
import { planReportTransition } from './report-state.ts';
import {
  UUID_PATTERN,
  parseCursor,
  parseLimit,
  requireIdempotencyKey,
  requireIfMatch,
  requireUserActor,
  validateCommentInput,
  validatePostInput,
  validateReportDispositionInput,
  validateReportInput,
} from './validate.ts';
import type {
  Ack,
  AuditState,
  AuthorDirectory,
  Comment,
  CommentInput,
  CommentPage,
  CommunityActor,
  KnowledgeTarget,
  Post,
  PostInput,
  PostPage,
  Report,
  ReportInput,
  Visibility,
} from './types.ts';

/** 游标有效期（与 profile/service 同量级：只服务翻页，不做长期令牌）。 */
export const CURSOR_TTL_MS = 15 * 60 * 1000;
/** 幂等重放窗口（契约参数描述：只覆盖客户端超时重试）。 */
export const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
/** 同键并发等待上界：超过即 409 REQUEST_IN_PROGRESS。 */
export const IDEMPOTENCY_WAIT_MS = 2000;

export interface CommunityServiceDeps {
  store: CommunityStore;
  /** 作者投影（阶段 2 接 `public_authors`）。**必填**：不提供默认值，避免悄悄伪造作者。 */
  authors: AuthorDirectory;
  /** 签名密钥（游标签名 + 幂等请求摘要 HMAC）；只在内存使用，不落库、不入日志。 */
  signingKey: string;
  /** 发布闸门；默认出厂规则集。注入自定义规则集会真实改变派生 `rule_version`。 */
  gate?: PublishGate;
  /**
   * 阶段 2：「杂草／药剂关联」可用性端口。
   * 默认**未接线**（`createUnwiredKnowledgeAvailabilityPort()`）⇒ 一切引用判不可用，
   * 因此"新增/替换引用"一律 `OBJECT_UNAVAILABLE`（fail-closed，绝不静默丢弃关联）。
   */
  knowledge?: KnowledgeAvailabilityPort;
  /**
   * 阶段 2：审核结果／下架事件投递端口（转发到已合并的消息中心公开创建口）。
   * 默认**未接线** ⇒ 如实回传"未投递"，不影响内容写入的权威结果。
   */
  events?: CommunityEventsPort;
  /**
   * **GY-I14 ⇄ GY-I15 联动接线（#14 + #15）**：审核域联动端口。
   *
   * 不传时与本接线前**逐字同行为**（社区仍只用本地规则层闸门 + 本地结论台账）。
   * 传入后（**B09**：服务失败或**无法判断不公开**）：
   *   1. 投稿/评论/编辑在**落内容行之前**送审审核域（建立版本级审核任务）；
   *   2. **只有审核域明确放行**（`publishable`：任务集非空且全部 approved）才允许落内容行并公开；
   *      审核域**明确驳回**（规则层/模型层）⇒ 400 `INVALID_REQUEST`（不落库，回传原因码）；
   *      其余（**隔离/未结论**：`quarantined`/`pending`/超时/未接线/无结论）⇒ 422 `INPUT_UNCERTAIN`
   *      （同样**不落库**，但**不**伪装成驳回：台账 `decision` 如实记 `quarantined`/`pending`）；
   *   3. 审核域抛错（`real` 未接真实供应商等）⇒ **原样上抛**（契约 503 `PROVIDER_UNAVAILABLE`）；
   *   4. 读取时若审核域台账对该版本**退回非放行**（迟到的驳回 **或** 迟到的隔离/无结论），
   *      内容立即退出公开面（"曾经通过"不是继续可见的理由）。
   *
   * **未接线/无结论不得冒充通过**：`model_layer === 'not_wired'` 既不是通过也不是驳回 ⇒ **隔离（非公开）**；
   * 本服务的结论台账照旧保持 `contract_complete:false` + `missing_contract_fields`（见 `buildVerdict`）。
   */
  moderation?: CommunityModerationLink;
  now?: () => Date;
  newId?: () => string;
  idempotencyTtlMs?: number;
  idempotencyWaitMs?: number;
}

export interface WriteOptions {
  idempotencyKey?: string;
  ifMatch?: string;
}

export interface ListPostsQuery {
  cursor?: string | null;
  limit?: number | null;
  crop_id?: string | null;
  region_code?: string | null;
  mine?: boolean | null;
}

export interface ListCommentsQuery {
  cursor?: string | null;
  limit?: number | null;
}

/** 内容重审结果（内部操作，供阶段 2 的巡检任务与测试使用）。 */
export interface ReReviewReport {
  re_reviewed: boolean;
  publishable: boolean;
  decision: RuleLayerVerdict['decision'];
  reason_codes: string[];
  rule_version: string | null;
  visibility: Visibility;
}

function notFound(): ApiError {
  return new ApiError('NOT_FOUND', '内容不存在或不可用');
}

function requireUuidParam(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ApiError('INVALID_REQUEST', `${field} 必须是 uuid`, {
      details: [{ field, code: 'INVALID_UUID' }],
    });
  }
  return value;
}

/** 正文摘要：帖子 = title + LF + body（与送审文本一致），评论 = body。 */
function postModerationText(record: Pick<PostRecord, 'title' | 'body'>): string {
  return `${record.title}\n${record.body}`;
}
function commentModerationText(record: Pick<CommentRecord, 'body'>): string {
  return record.body;
}
function mediaInputs(mediaIds: readonly string[]): Array<{ media_id: string }> {
  return mediaIds.map((media_id) => ({ media_id }));
}

export function createCommunityService(deps: CommunityServiceDeps) {
  const store = deps.store;
  const authors = deps.authors;
  const gate = deps.gate ?? createPublishGate();
  const knowledge = deps.knowledge ?? createUnwiredKnowledgeAvailabilityPort();
  const events = deps.events ?? createUnwiredCommunityEventsPort();
  const moderationLink: CommunityModerationLink | null = deps.moderation ?? null;
  const signingKey = deps.signingKey;
  const clock = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());
  const idempotencyTtlMs = deps.idempotencyTtlMs ?? IDEMPOTENCY_TTL_MS;
  const idempotencyWaitMs = deps.idempotencyWaitMs ?? IDEMPOTENCY_WAIT_MS;

  const nowIso = (): string => clock().toISOString();
  const sign = (value: string): string => createHmac('sha256', signingKey).update(value).digest('base64url');

  // -------------------------------------------------------------------------
  // 幂等：先原子占位 → 审核/落库 → 写回结果；失败释放占位；同键异体冲突
  // -------------------------------------------------------------------------

  async function withIdempotency<T>(
    scope: string,
    keyHash: string,
    requestDigest: string,
    responseStatus: number,
    produce: () => Promise<{ outcome: IdempotencyOutcome; result: T }>,
    replay: (ref: IdempotencyOutcome) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await store.findIdempotency(scope, keyHash);
      if (existing !== null) {
        if (existing.request_hash !== requestDigest) {
          throw new ApiError('IDEMPOTENCY_CONFLICT', '同键请求内容不一致');
        }
        return replay(existing.outcome);
      }
      const claimed = await store.claimIdempotency(scope, keyHash, {
        request_hash: requestDigest,
        response_status: responseStatus,
        expires_at: clock().getTime() + idempotencyTtlMs,
      });
      if (!claimed) {
        const settled = await store.awaitIdempotencySettled(scope, keyHash, idempotencyWaitMs);
        if (settled === 'timeout') {
          throw new ApiError('REQUEST_IN_PROGRESS', '同键请求正在处理中，请稍后重试', { retryable: true });
        }
        continue;
      }
      let produced: { outcome: IdempotencyOutcome; result: T };
      try {
        produced = await produce();
      } catch (error) {
        // 失败释放占位：本次不留任何"半成品"结果，也不让后续同键重试被永久挡住。
        await store.releaseIdempotency(scope, keyHash);
        throw error;
      }
      const saved = await store.completeIdempotency(scope, keyHash, {
        response_status: responseStatus,
        outcome: produced.outcome,
      });
      if (saved) return produced.result;
      // 占位已被他人完成/释放（理论上不出现）：回到循环按台账重放，不重复落库。
    }
    throw new ApiError('REQUEST_IN_PROGRESS', '同键请求正在处理中，请稍后重试', { retryable: true });
  }

  // -------------------------------------------------------------------------
  // 审核结论：落台账 + 读取时重算可见性
  // -------------------------------------------------------------------------

  /**
   * 构造审核结论台账记录（纯函数，不写库）。
   * 结论**随内容同一次原子提交**写入（见 `insertPost`/`commitPostIfCurrent`），
   * 或在"未提交内容"的拒绝路径上经 `putRefusalVerdict` 补录。
   */
  function buildVerdict(
    target: { type: 'post' | 'comment'; id: string; revision: number },
    outcome: GateOutcome,
    text: string,
  ): ModerationRecord {
    return {
      id: newId(),
      target_ref: { type: target.type, id: target.id, revision: target.revision },
      decision: outcome.decision,
      reason_codes: [...outcome.reason_codes],
      hard_rule_passed: outcome.hard_rule_passed,
      rule_version: outcome.rule_version,
      // 结论绑定"这一份正文"，不只绑定 revision。
      text_digest: sha256Hex(text),
      // 契约 Moderation 共 9 个必填：本片只产出规则层 + 绑定部分，模型层字段不假装已填。
      contract_complete: false,
      missing_contract_fields: [...outcome.missing_contract_fields],
      created_at: nowIso(),
    };
  }

  /** 未提交内容的结论补录（拒绝/隔离）：仅在该 (target,revision) 尚无内容与结论时写入。 */
  async function recordRefusalVerdict(
    target: { type: 'post' | 'comment'; id: string; revision: number },
    outcome: GateOutcome,
    text: string,
  ): Promise<boolean> {
    return store.putRefusalVerdict(buildVerdict(target, outcome, text));
  }

  // -------------------------------------------------------------------------
  // GY-I14 ⇄ GY-I15 联动接线（#14 + #15）：审核域送审 / 否决 / 读取时重查
  // -------------------------------------------------------------------------

  /**
   * **送审审核域**（落内容行**之前**调用）。
   *
   * 调用时机：社区本地规则层闸门（`gate.evaluate`，规则先挡的**记录口径**）已放行之后、
   * 任何内容行落库之前。返回值三态互斥：`publishable`（明确放行）/ `vetoed`（明确驳回）/
   * `isolation`（隔离·未结论）；后两者都**不得**落内容行、不得公开（见 `requireDomainClearance`）。
   *
   * 审核域抛错**不在此处捕获**：`real` 未接真实供应商时必须让契约 503 原样到达调用方
   * （fail-closed；绝不把"不可用"降级成"通过"或"普通 400"）。
   */
  async function screenWithModeration(
    user: CommunityActor,
    target: { type: 'post' | 'comment'; id: string; revision: number },
    text: string,
    mediaIds: readonly string[],
  ): Promise<LinkScreenResult | null> {
    if (moderationLink === null) return null;
    return moderationLink.screen({
      actor: linkActorOf(user),
      // 送审内容与"同一构造函数"口径一致：帖子 = title + LF + body；媒体**显式**声明。
      content: { target_ref: { ...target }, text, media: mediaInputs(mediaIds) },
    });
  }

  /**
   * **审核域放行门**（落内容行**之前**调用）：未获审核域**明确放行** ⇒ 一律不落库、不公开。
   *
   * 三态处置（**不混淆驳回与隔离**；B09「服务失败或无法判断不公开」）：
   *   - `publishable === true`（审核域明确通过）⇒ 放行，继续写入；
   *   - `vetoed === true`（明确驳回）⇒ 结论补录（`decision:'rejected'`）+ 400 `INVALID_REQUEST`；
   *   - 其余（`isolation`：`quarantined`/`pending`/超时/未接线/无结论）⇒ 结论补录（如实记
   *     `quarantined`/`pending`，**不**伪装成驳回）+ 422 `INPUT_UNCERTAIN`。
   *
   * `screen === null` 表示**本服务未接线审核域联动端口**（接线前口径，逐字不变）。
   */
  async function requireDomainClearance(
    screen: LinkScreenResult | null,
    target: { type: 'post' | 'comment'; id: string; revision: number },
    outcome: GateOutcome,
    text: string,
  ): Promise<void> {
    if (screen === null || screen.publishable === true) return;
    await recordDomainVerdict(target, outcome, screen, text);
    throw screen.vetoed === true ? domainRefusal(screen) : domainIsolation(screen);
  }

  /**
   * **图片审核能力位缺失**的理由码（GY-R31 · #14 缺口 G3）。
   *
   * 与其它拒绝理由码同形（`details[].field === 'reason_codes'`），但**专属**于"这一类内容此刻
   * 没有可求值的图片审核端口"：它在契约错误码闭集内（422 `INPUT_UNCERTAIN`），并且**只在带媒体
   * 投稿**时才会出现 —— 调用方据此可以把"图片审核未就绪"与"内容违规/规则未通过/未送审"区分开
   * （两次读数见 `docs/verification/gy-r31-i14-image-path-20261022.md`）。
   */
  const IMAGE_MODERATION_UNAVAILABLE = 'IMAGE_MODERATION_UNAVAILABLE';

  /** 规则层"不评估媒体"的跨片声明码（`packages/moderation` 的既有口径，不自造同义词）。 */
  const MEDIA_ONLY_CODE = 'MEDIA_NOT_EVALUATED_BY_RULE_LAYER';

  /**
   * 规则层**只是不评估媒体**（不是判定违规）——与审核域 `modelLayerReachable` 同一口径。
   *
   * 只有这种"未结论"才允许把带媒体内容**送进**审核链路；其余任何 `!publishable`（驳回、输入
   * 非法、引擎异常、扫描截断、媒体之外的原因）仍按原口径拒绝，一处也不放宽。
   */
  function ruleLayerDeferredMedia(outcome: GateOutcome): boolean {
    if (outcome.decision === 'rejected') return false;
    return outcome.reason_codes.length > 0 && outcome.reason_codes.every((code) => code === MEDIA_ONLY_CODE);
  }

  /**
   * 带媒体内容"**已提交审核**"的那一态：审核域有任务、但没有（也**不可能**有）明确放行结论，
   * 同时也没有明确驳回。
   *
   * 这不是"放行发布"，而是"受理并留在审核链路里"：社区随后落**私有 + 待审**内容行，**不**调用
   * 发布闸门、不对外可见。规则层不评估图片 ⇒ 带媒体内容在审核域里恒为隔离/待审，因此
   * `publishable === true` 的带媒体内容不存在（真出现就仍按 `service.ts` 的既有不变式拒绝）。
   */
  function isMediaReviewPending(screen: LinkScreenResult | null): boolean {
    return screen !== null && screen.publishable !== true && screen.vetoed !== true;
  }

  /**
   * 把审核域那一条结论装配成本域的结论记录（**不落库**；调用方决定补录还是随内容行写入）。
   *
   * 复用 `buildVerdict`（`rule_version`/`text_digest`/`missing_contract_fields` 仍来自本服务实际
   * 使用的那份规则集，**不伪造**），只把结论替换为审核域给出的那一条；隔离时 `decision` 如实记
   * `quarantined`/`pending`（**不**写成 `rejected`）。模型层未接线时 `contract_complete` 保持 `false`。
   */
  function domainVerdict(
    target: { type: 'post' | 'comment'; id: string; revision: number },
    outcome: GateOutcome,
    screen: LinkScreenResult,
    text: string,
  ): ModerationRecord {
    return {
      ...buildVerdict(target, outcome, text),
      id: newId(),
      decision: screen.decision,
      reason_codes: [...screen.reason_codes].slice(0, 30),
      hard_rule_passed: screen.rule_layer === 'passed',
    };
  }

  /**
   * 审核域**未获放行**（驳回或隔离）时未提交内容的结论补录。
   *
   * 复用 `buildVerdict`（`rule_version`/`text_digest`/`missing_contract_fields` 仍来自
   * 本服务实际使用的那份规则集，**不伪造**），只把结论替换为审核域给出的那一条；
   * 隔离时 `decision` 如实记 `quarantined`/`pending`（**不**写成 `rejected`）。
   * 模型层未接线时 `contract_complete` 保持 `false`。
   */
  async function recordDomainVerdict(
    target: { type: 'post' | 'comment'; id: string; revision: number },
    outcome: GateOutcome,
    screen: LinkScreenResult,
    text: string,
  ): Promise<boolean> {
    return store.putRefusalVerdict(domainVerdict(target, outcome, screen, text));
  }

  /** 审核域明确驳回 ⇒ 契约闭集内的拒绝错误（与本地 `refusal` 的 rejected 分支同形）。 */
  function domainRefusal(screen: LinkScreenResult): ApiError {
    const details = screen.reason_codes.slice(0, 30).map((code) => ({ field: 'reason_codes', code }));
    return new ApiError(
      'INVALID_REQUEST',
      `内容被审核域明确驳回，已拒绝发布（rule_layer=${screen.rule_layer}, model_layer=${screen.model_layer}）`,
      { details },
    );
  }

  /**
   * 审核域**隔离/未结论** ⇒ 契约闭集内的"不确定"错误（与本地 `refusal` 的非 rejected 分支同形）。
   *
   * 刻意与 `domainRefusal` 分开：**"待审核/无结论"不是"驳回"**，错误码（422 vs 400）、
   * 文案与台账 `decision` 都如实区分（审计上可分辨），但**两者都不公开**。
   */
  function domainIsolation(screen: LinkScreenResult): ApiError {
    const details = screen.reason_codes.slice(0, 30).map((code) => ({ field: 'reason_codes', code }));
    return new ApiError(
      'INPUT_UNCERTAIN',
      `内容未获审核域放行（隔离/未结论：decision=${screen.decision}, model_layer=${screen.model_layer}），一律不得发布`,
      { details },
    );
  }

  /**
   * 读取时重查：审核域台账对该**当前版本**是否已退回"非放行"（驳回 **或** 隔离/未结论）。
   *
   * 返回非 `null` ⇒ 该版本不得继续公开，调用方必须降级（fail-closed），降级后的
   * `audit_state` 如实区分 `rejected`（驳回）与 `pending`/`quarantined`（隔离）。
   *
   * 边界（如实登记）：台账**可读但完全没有该版本任务**（`present === false`）时返回 `null`——
   * 没有结论可"退回"，可见性的主判据仍是本服务的结论台账；接线后**新建**内容不存在这种状态
   * （送审先于落库）。台账**不可读**（`readable === false`）或端口抛错时返回 `'quarantined'`：
   * **无法判断 ⇒ 隔离**（B09），不得继续公开。
   */
  function domainWithholdingOf(kind: 'post' | 'comment', id: string, revision: number): AuditState | null {
    if (moderationLink === null) return null;
    let conclusion: LinkConclusion;
    try {
      conclusion = moderationLink.conclusionFor({ type: kind, id, revision });
    } catch {
      // 端口异常 ⇒ 无法判断 ⇒ 隔离（绝不放行）。
      return 'quarantined';
    }
    if (conclusion.readable !== true) return 'quarantined'; // 台账读不出来 ⇒ 隔离
    if (conclusion.present !== true) return null; // 无该版本任务 ⇒ 没有结论可"退回"
    if (conclusion.publishable === true) return null; // 审核域明确放行 ⇒ 不降级
    if (conclusion.vetoed === true) return conclusion.decision ?? 'rejected'; // 明确驳回
    return conclusion.decision ?? 'quarantined'; // 隔离/未结论（pending/quarantined）⇒ 退出公开面
  }

  /**
   * CAS 失败的契约映射（监工 5487924826 返修 1 · 第 3 条）。
   *
   * - `NOT_FOUND` / `AUTHOR_CHANGED` ⇒ `404 NOT_FOUND`：不泄露存在性（非作者永远拿不到 409）；
   * - `DELETED` ⇒ `409 OBJECT_UNAVAILABLE`：对象已被下架，**写路径**明确报"目标不可用"，
   *   绝不静默成功、绝不复活（读路径对已删除内容仍是 404，读写口径差别见 PR 正文）；
   * - `REVISION_CHANGED` / `VISIBILITY_CHANGED` / `AUDIT_STATE_CHANGED` ⇒ `409 REVISION_CONFLICT`：
   *   客户端 `If-Match` 依据的视图已过期，按 `docs/architecture/state-contract.md`「刷新当前版本并
   *   显式确认，不复用旧审核」处理。
   * 三者都在契约 409/404 错误码闭集内（`REVISION_CONFLICT`/`OBJECT_UNAVAILABLE`/`NOT_FOUND`）。
   */
  function commitRefusal(reason: CommitFailureReason): ApiError {
    switch (reason) {
      case 'NOT_FOUND':
      case 'AUTHOR_CHANGED':
        return notFound();
      case 'DELETED':
        return new ApiError('OBJECT_UNAVAILABLE', '目标内容已下架，不可继续修改');
      case 'REVISION_CHANGED':
        return new ApiError('REVISION_CONFLICT', '目标版本已变化，请刷新后重试');
      case 'VISIBILITY_CHANGED':
      case 'AUDIT_STATE_CHANGED':
      case 'STATE_CHANGED':
        return new ApiError('REVISION_CONFLICT', '目标当前状态已变化，请刷新后重试');
    }
  }

  /**
   * **读取时**重算内容的有效状态（可见性 + 审核状态）。
   *
   * 这是本片的"先审后发"落点：存储行只记录"写入时"的状态，真正对外投影的
   * `visibility`/`audit_state` 每次读取都按**当前规则版本**重新判定：
   *   - 结论缺失／失效（规则集升级、revision 变化、证据不可信）⇒ 降级为 `hidden` + `pending`
   *     （`evaluateReReview` 判 `quarantined` 时如实报 `quarantined`），"旧结论不得继续放行"；
   *   - 结论新鲜且明确不可发布 ⇒ 按结论如实报 `rejected`/`quarantined`，且不再公开；
   *   - 结论新鲜且可发布 ⇒ 报 `published` + `approved`。
   * 因此"规则集升级后旧内容自动退出可见"不需要额外的后台任务，也没有"写时信任一次"的窗口。
   */
  async function effectiveState(
    kind: 'post' | 'comment',
    record: PostRecord | CommentRecord,
  ): Promise<{ visibility: Visibility; audit_state: AuditState }> {
    if (record.visibility === 'deleted') return { visibility: 'deleted', audit_state: record.audit_state };
    const demoted = (auditState: AuditState): { visibility: Visibility; audit_state: AuditState } => ({
      visibility: record.visibility === 'published' ? 'hidden' : record.visibility,
      audit_state: auditState,
    });
    const verdict = await store.getModeration(kind, record.id, record.revision);
    if (verdict === null) return demoted('pending');
    if (
      verdict.target_ref.type !== kind ||
      verdict.target_ref.id !== record.id ||
      verdict.target_ref.revision !== record.revision
    ) {
      return demoted('pending');
    }
    const text =
      kind === 'post' ? postModerationText(record as PostRecord) : commentModerationText(record as CommentRecord);
    if (verdict.text_digest !== sha256Hex(text)) return demoted('pending');
    const assessment = gate.assess({ type: kind, id: record.id, revision: record.revision }, verdict);
    if (assessment.stale) return demoted(assessment.landing === 'quarantined' ? 'quarantined' : 'pending');
    if (assessment.publishable) {
      // GY-I14 联动接线 · **读取时重查**：本地结论"曾经通过"不是继续可见的理由 ——
      // 审核域台账里该版本若已**退回非放行**（迟到的驳回 / 迟到的隔离·未结论 / 台账不可读），
      // 一律立即降级为不可公开（fail-closed）。降级后的 `audit_state` 如实区分
      // `rejected`（驳回）与 `pending`/`quarantined`（隔离），见 `domainWithholdingOf`。
      const withholding = domainWithholdingOf(kind, record.id, record.revision);
      if (withholding !== null) return demoted(withholding);
      return { visibility: record.visibility, audit_state: 'approved' };
    }
    return demoted(verdict.decision);
  }

  /** 发布口径谓词：只有有效状态恰好是 `published` + `approved` 才算公开可见。 */
  async function isPubliclyVisible(kind: 'post' | 'comment', record: PostRecord | CommentRecord): Promise<boolean> {
    const state = await effectiveState(kind, record);
    return state.visibility === 'published' && state.audit_state === 'approved';
  }

  /**
   * 被拒绝的发布请求 → 契约错误码 + reason_codes（逐条作为 details 回传）。
   *
   * `mediaReadiness`：**只在带媒体投稿被拒时**传入。能力位未就绪 ⇒ 追加
   * `IMAGE_MODERATION_UNAVAILABLE`（与"内容违规/规则未通过"可区分，见该常量注释）。
   */
  function refusal(outcome: GateOutcome, mediaReadiness: LinkImageReadiness | null = null): ApiError {
    const codes = [...outcome.refusal_reason_codes];
    if (mediaReadiness !== null && mediaReadiness.ready !== true) codes.push(IMAGE_MODERATION_UNAVAILABLE);
    const details = [...new Set(codes)].map((code) => ({ field: 'reason_codes', code }));
    if (outcome.decision === 'rejected') {
      return new ApiError(
        'INVALID_REQUEST',
        `内容未通过硬规则审核，已拒绝发布（decision=rejected, rule_version=${outcome.rule_version ?? 'unknown'}）`,
        { details },
      );
    }
    return new ApiError(
      'INPUT_UNCERTAIN',
      `内容筛查未完成或未通过（decision=${outcome.decision}），一律不得发布`,
      { details },
    );
  }

  // -------------------------------------------------------------------------
  // 阶段 2：「杂草／药剂关联」投影与闸门（契约 PostInput 描述逐条落实）
  // -------------------------------------------------------------------------

  /** 同一关联目标（type/id/revision 逐项相等）——用于"编辑遗漏/未变 ⇒ 保留旧值"。 */
  function sameLink(a: KnowledgeTarget | null, b: KnowledgeTarget | null): boolean {
    if (a === null || b === null) return a === b;
    return a.type === b.type && a.id === b.id && a.revision === b.revision;
  }

  /**
   * 逐次现查关联投影。端口抛错（任何原因）一律按**不可用**处理：
   * 取不到状态绝不能变成"默认可用"，也不能把资料域细节带进帖子响应。
   */
  async function linkProjection(target: KnowledgeTarget): Promise<KnowledgeLinkProjection> {
    try {
      const projection = await knowledge.lookup(target);
      if (projection === null || typeof projection !== 'object') return unavailableLink(target);
      return projection;
    } catch {
      return unavailableLink(target);
    }
  }

  /**
   * 「新增/替换引用需当前可用」闸门：不可用 ⇒ 契约闭集内 `OBJECT_UNAVAILABLE`。
   * **不得**静默丢弃关联——契约明写「创建遗漏关联等于无关联」，静默丢弃会让客户端
   * 以为关联已保存。
   */
  async function requireAvailableLink(target: KnowledgeTarget): Promise<KnowledgeTarget> {
    const projection = await linkProjection(target);
    if (projection.reference_state !== 'available') {
      throw new ApiError(
        'OBJECT_UNAVAILABLE',
        '关联资料目标当前不可用：新增/替换引用需当前可用（不静默丢弃关联）',
      );
    }
    return { ...target };
  }

  // -------------------------------------------------------------------------
  // 阶段 2：审核结果／下架事件投递（**只调用消息中心公开端口**，不改其实现）
  // -------------------------------------------------------------------------

  /**
   * 投递一次审核结果事件。
   *
   * 投递**只覆盖已提交的 revision**（创建/编辑成功、以及重审把既有内容降级为不可见）。
   * 被拒的写入请求**不投递**：那条 revision 从未落库，投一条指向不存在版本的消息
   * 只会产生悬挂引用，而作者本人在**同一个请求**里已拿到同步错误封套（含原因码）。
   *
   * 事件端口按契约不抛错；这里仍兜底 try/catch，**绝不让通知影响内容写入的权威结果**。
   */
  async function publishModerationResult(
    ownerId: string,
    target: CommunityEventTarget,
    decision: AuditState,
    reasonCodes: readonly string[],
  ): Promise<void> {
    const event: CommunityEvent = {
      event: 'moderation_result',
      ownerId,
      target: { ...target },
      decision,
      reasonCodes: [...reasonCodes],
    };
    try {
      await events.publish(event);
    } catch {
      // 通知失败不改变内容写入结果，也不入响应（事件端口自身已如实标注未投递）。
    }
  }

  /**
   * 投递一次「他人互动」事件（他人评论 / 他人点赞），接收者 = **被评论/被赞内容的作者**。
   *
   * 四条硬边界（issue #17 验收第 2、3、4 条）：
   *   1. **自评自赞不投递**：自己给自己发通知是典型脏数据，也没有信息量；
   *   2. 接收者由服务端从**内容行**取 `author_id`，**绝不**来自客户端入参；
   *   3. 目标在写入前已过 `isPubliclyVisible` / `publiclyVisibleTarget` 闸门（评论另加
   *      「评论本身已 `published`」），**被下架/删除/无权**的对象在落库前就 404，
   *      根本走不到这里 ⇒ 不给不可见对象新增消息；
   *   4. 与 `publishModerationResult` 同口径：事件端口按契约不抛错，这里仍兜底 try/catch，
   *      通知失败**不**改变内容写入的权威结果，也不入响应。
   */
  async function publishInteraction(event: CommunityEvent): Promise<void> {
    try {
      await events.publish(event);
    } catch {
      // 通知不是权威结果：内容/计数已落库，失败由事件端口如实标注 delivered:false。
    }
  }

  /**
   * 作者投影。入参是**作者引用**，不是"用户 id"：
   *   - 未注销行 = `author_id`（内部 uuid，`AuthorDirectory` 派生活跃假名）；
   *   - 已注销行 = `anonymized_author_ref`（`gy-anon-<16 hex>`，迁移 0030 的**行内**注销引用，
   *     `AuthorDirectory.resolve` 直接按引用投影，不依赖任何进程内映射）。
   *
   * 调用方一律用 `record.author_id ?? record.anonymized_author_ref` 传进来（⛔ 不要 `String(null)`，
   * 那会得到字符串 `'null'` 并被当成一个"用户 id"）。
   */
  async function projectAuthor(authorRef: string | null) {
    if (typeof authorRef !== 'string' || authorRef.length === 0) {
      // 不该发生：迁移 0030 的 `num_nonnulls(author_id, anonymized_author_ref) = 1` 保证恰好一个非空。
      // 真发生就是行形状坏了 ⇒ 明确失败，⛔ 不编一个 display_name。
      throw new ApiError('PROVIDER_UNAVAILABLE', '作者投影不可用（内容行没有作者引用）');
    }
    const author = await authors.resolve(authorRef);
    if (author === null) {
      // 不伪造作者：无法投影就明确失败，而不是编一个 display_name。
      throw new ApiError('PROVIDER_UNAVAILABLE', '作者投影不可用');
    }
    return author;
  }

  /** 内容行的作者引用：`author_id` 优先，注销后落到行内引用（两列恰好一个非空）。 */
  function authorRefOf(record: { author_id: string | null; anonymized_author_ref: string | null }): string | null {
    return record.author_id ?? record.anonymized_author_ref;
  }

  async function projectPost(record: PostRecord): Promise<Post> {
    const state = await effectiveState('post', record);
    return {
      id: record.id,
      revision: record.revision,
      author: await projectAuthor(authorRefOf(record)),
      title: record.title,
      body: record.body,
      crop_id: record.crop_id,
      region_code: record.region_code,
      media_ids: [...record.media_ids],
      visibility: state.visibility,
      audit_state: state.audit_state,
      created_at: record.created_at,
      updated_at: record.updated_at,
      // 媒体投影需要"当前已发布且独立筛查通过"的附件版本（阶段 2 接 packages/media）。
      // 本片带媒体的内容一律不发布，因此公开投影恒为空数组。
      media: [],
      linked_knowledge_ref: record.linked_knowledge_ref === null ? null : { ...record.linked_knowledge_ref },
      // 关联安全投影**逐次现查**（默认未接线 ⇒ 恒为不可用投影，但 ref 原样保留）。
      linked_knowledge: record.linked_knowledge_ref === null ? null : await linkProjection(record.linked_knowledge_ref),
    };
  }

  async function projectComment(record: CommentRecord): Promise<Comment> {
    const state = await effectiveState('comment', record);
    return {
      id: record.id,
      revision: record.revision,
      post_id: record.post_id,
      author: await projectAuthor(authorRefOf(record)),
      body: record.body,
      visibility: state.visibility,
      audit_state: state.audit_state,
      created_at: record.created_at,
    };
  }

  function projectReport(record: ReportRecord): Report {
    return {
      id: record.id,
      revision: record.revision,
      target_ref: { ...record.target_ref },
      state: record.state,
      reason_code: record.reason_code,
    };
  }

  // -------------------------------------------------------------------------
  // 游标（签名 + 绑定主体/路由/过滤/排序，防篡改与跨主体复用）
  // -------------------------------------------------------------------------

  interface CursorPayload {
    subject: string;
    route: string;
    filter: Record<string, string | boolean | null>;
    sort: 'created_at_desc' | 'created_at_asc';
    after: { created_at: string; id: string };
    expires: number;
  }

  function encodeCursor(payload: CursorPayload): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${body}.${sign(body)}`;
  }

  function decodeCursor(
    cursor: string | null,
    expected: Omit<CursorPayload, 'after' | 'expires'>,
  ): { created_at: string; id: string } | null {
    if (cursor === null) return null;
    try {
      const parts = cursor.split('.');
      if (parts.length !== 2) throw new Error('shape');
      const body = parts[0];
      const signature = parts[1];
      if (typeof body !== 'string' || typeof signature !== 'string' || body.length === 0) throw new Error('shape');
      const expectedSignature = Buffer.from(sign(body));
      const received = Buffer.from(signature);
      if (received.length !== expectedSignature.length || !timingSafeEqual(expectedSignature, received)) {
        throw new Error('signature');
      }
      const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
      if (value['subject'] !== expected.subject || value['route'] !== expected.route) throw new Error('scope');
      if (value['sort'] !== expected.sort) throw new Error('sort');
      if (JSON.stringify(value['filter']) !== JSON.stringify(expected.filter)) throw new Error('filter');
      const expires = value['expires'];
      if (typeof expires !== 'number' || !Number.isFinite(expires) || expires <= clock().getTime()) throw new Error('expired');
      const after = value['after'];
      if (typeof after !== 'object' || after === null) throw new Error('after');
      const afterRecord = after as Record<string, unknown>;
      if (typeof afterRecord['created_at'] !== 'string' || typeof afterRecord['id'] !== 'string') throw new Error('after');
      return { created_at: afterRecord['created_at'], id: afterRecord['id'] };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('INVALID_CURSOR', '游标无效或已失效');
    }
  }

  // -------------------------------------------------------------------------
  // 读取辅助
  // -------------------------------------------------------------------------

  /** 该主体是否可读这条帖子（作者可读自己的非删除内容；他人仅可读当前公开可见版本）。 */
  async function readablePost(user: CommunityActor, id: string): Promise<PostRecord> {
    const record = await store.getPost(id);
    if (record === null || record.visibility === 'deleted') throw notFound();
    if (record.author_id === user.userId) return record;
    if (!(await isPubliclyVisible('post', record))) throw notFound();
    return record;
  }

  /** 该主体是否可读这条评论（作者可读自己的待审评论；他人仅可读公开且父帖可见的评论）。 */
  async function readableComment(user: CommunityActor, id: string): Promise<CommentRecord> {
    const record = await store.getComment(id);
    if (record === null || record.visibility === 'deleted') throw notFound();
    if (record.author_id === user.userId) return record;
    const parent = await store.getPost(record.post_id);
    if (parent === null || !(await isPubliclyVisible('post', parent))) throw notFound();
    if (!(await isPubliclyVisible('comment', record))) throw notFound();
    return record;
  }

  /** 点赞/举报的目标必须**当前公开可见**（更严：作者也不能对隔离内容操作）。 */
  async function publiclyVisibleTarget(
    kind: 'post' | 'comment',
    id: string,
  ): Promise<PostRecord | CommentRecord> {
    if (kind === 'post') {
      const record = await store.getPost(id);
      if (record === null || !(await isPubliclyVisible('post', record))) throw notFound();
      return record;
    }
    const record = await store.getComment(id);
    if (record === null || !(await isPubliclyVisible('comment', record))) throw notFound();
    const parent = await store.getPost(record.post_id);
    if (parent === null || !(await isPubliclyVisible('post', parent))) throw notFound();
    return record;
  }

  // -------------------------------------------------------------------------
  // 公开操作（对应 operationId）
  // -------------------------------------------------------------------------

  const service = {
    /** `listPosts`：`GET /posts`。`mine=true` 时返回主体自己的非删除内容（含未公开版本）。 */
    async listPosts(actor: unknown, query: ListPostsQuery = {}): Promise<PostPage> {
      const user = requireUserActor(actor);
      const limit = parseLimit(query.limit ?? null);
      const cursor = parseCursor(query.cursor ?? null);
      const cropId = query.crop_id ?? null;
      const regionCode = query.region_code ?? null;
      const mine = query.mine === true;
      if (cropId !== null && (typeof cropId !== 'string' || cropId.length < 1 || cropId.length > 80)) {
        throw new ApiError('INVALID_REQUEST', 'crop_id 必须是 1..80 的字符串', {
          details: [{ field: 'crop_id', code: 'INVALID_LENGTH' }],
        });
      }
      if (regionCode !== null && (typeof regionCode !== 'string' || !/^33[0-9]{4}$/.test(regionCode))) {
        throw new ApiError('INVALID_REQUEST', 'region_code 必须是 ^33[0-9]{4}$ 的地区码', {
          details: [{ field: 'region_code', code: 'PATTERN_MISMATCH' }],
        });
      }

      const after = decodeCursor(cursor, {
        subject: user.userId,
        route: 'posts',
        filter: { crop_id: cropId, region_code: regionCode, mine },
        sort: 'created_at_desc',
      });
      // 分块 keyset（#444 §S5）：筛选下推存储层后 `LIMIT` 才生效，每轮多要 1 行判「还有下一页」；公开复核
      // 依赖规则层与审核台账（SQL 判不了的谓词），被丢掉的行由游标前进补回，所以页内不缺行、不跳行。
      const survivors: PostRecord[] = [];
      let more = false;
      let cursorPoint: { createdAt: string; id: string } | null =
        after === null ? null : { createdAt: after.created_at, id: after.id };
      for (;;) {
        const batch = await store.listPosts({
          scope: mine ? 'mine' : 'public',
          authorId: mine ? user.userId : null,
          cropId,
          regionCode,
          after: cursorPoint,
          limit: limit + 1 - survivors.length,
        });
        const tail = batch.at(-1);
        if (tail === undefined) break;
        cursorPoint = { createdAt: tail.created_at, id: tail.id };
        for (const record of batch) {
          // `mine` 的归属与「非删除」已在下推谓词里判过；公开列表还要按当前规则重查一次。
          if (mine || (await isPubliclyVisible('post', record))) survivors.push(record);
          if (survivors.length > limit) break;
        }
        if (survivors.length > limit) more = true;
        if (more || batch.length < limit + 1 - survivors.length) break;
      }
      const page = survivors.slice(0, limit);
      const last = page[page.length - 1];
      const next_cursor =
        more && last !== undefined
          ? encodeCursor({
              subject: user.userId,
              route: 'posts',
              filter: { crop_id: cropId, region_code: regionCode, mine },
              sort: 'created_at_desc',
              after: { created_at: last.created_at, id: last.id },
              expires: clock().getTime() + CURSOR_TTL_MS,
            })
          : null;
      const items: Post[] = [];
      for (const record of page) items.push(await projectPost(record));
      return { items, next_cursor };
    },

    /**
     * `createPost`：`POST /posts`。先审后发；未获批准一律**不落内容行**。
     *
     * 通过筛查后仍是**两步**（GY-I14 P1-1）：先以「私有 / 待审」落库，再由审核域发布闸门
     * （`CommunityModerationLink.publish`）写 `published` + `approved`。闸门拒绝时行保留为
     * `pending_review`（仅作者可见），错误原样上抛 —— 绝不出现"本域自己宣布已发布"。
     */
    async createPost(actor: unknown, input: unknown, options: WriteOptions = {}): Promise<Post> {
      const user = requireUserActor(actor);
      const body: PostInput = validatePostInput(input);
      const key = requireIdempotencyKey(options.idempotencyKey);
      const scope = idempotencyScope(user.userId, 'POST', '/posts');
      const keyHash = idempotencyKeyHashHex(scope, key);
      const digest = idempotencyRequestHash(body, undefined, signingKey);
      return withIdempotency(
        scope,
        keyHash,
        digest,
        201,
        async () => {
          // 契约 PostInput：「创建遗漏关联等于无关联」⇒ 未给就是 null；
          // 给了（含显式 null 以外的目标）⇒ 必须**当前可用**，否则 OBJECT_UNAVAILABLE。
          const requestedLink = body.linked_knowledge_ref ?? null;
          const linkTarget = requestedLink === null ? null : await requireAvailableLink(requestedLink);
          // 作者投影不可用时**不落任何内容行**（不伪造作者）；先探一次，避免留下"投影不了的内容"。
          await projectAuthor(user.userId);
          const id = newId();
          const target = { type: 'post' as const, id, revision: 1 };
          const text = postModerationText({ title: body.title, body: body.body });
          // 先审后发：审核发生在**任何内容行落库之前**。
          const outcome = gate.evaluate(target, text, mediaInputs(body.media_ids));
          // 图片审核与门（GY-R31 · #14 缺口 G3）：带媒体内容必须**同时**满足
          //   ① 规则层只是"不评估媒体"（不是判定违规）—— 与审核域 `modelLayerReachable` 同口径；
          //   ② 图片审核端口真的有（能力位 `ready === true`）—— 只在文本端口上打补丁不算就绪。
          // 缺任一 ⇒ 仍然拒绝（fail-closed）：缺② 时理由码追加 `IMAGE_MODERATION_UNAVAILABLE`，
          // 缺① 时与接线前逐字同口径（400/422 由 `refusal` 决定）。
          const mediaCount = body.media_ids.length;
          const imageReadiness: LinkImageReadiness | null =
            mediaCount > 0 ? readImageModerationReadiness(moderationLink) : null;
          const mediaAccepted =
            mediaCount > 0 &&
            ruleLayerDeferredMedia(outcome) &&
            imageReadiness !== null &&
            imageReadiness.ready === true;
          if (!outcome.publishable && !mediaAccepted) {
            // 未提交内容：结论只做**补录**（不覆盖任何已提交内容的结论），然后拒绝发布。
            await recordRefusalVerdict(target, outcome, text);
            throw refusal(outcome, imageReadiness);
          }
          // GY-I14 联动接线：规则先挡放行后、**落内容行之前**送审审核域 —— 建立该 revision 的
          // 版本级审核任务（`GET /jobs/{id}` 可读）；**未获明确放行**（明确驳回 / 隔离 / 未结论）
          // 一律不落内容行、不公开（B09：服务失败或无法判断不公开）。
          const screen = await screenWithModeration(user, target, text, body.media_ids);
          // **带媒体内容的"已提交审核"态**（GY-R31 · #14 缺口 G3）：审核域对该版本有任务、
          // 但没有（也**不可能**有）明确放行结论、也没有明确驳回 —— 这就是图片帖子能到达的
          // 那一态：落「私有 / 待审」内容行并留在审核链路里，**不**走发布闸门、不对外可见。
          const mediaReview = mediaAccepted && isMediaReviewPending(screen);
          if (!mediaReview) {
            await requireDomainClearance(screen, target, outcome, text);
            if (mediaCount > 0) {
              // 双保险：图片审核属模型层，规则层遇到媒体必隔离；万一有人把 gate 换成会放行媒体的实现，
              // 这里也必须拒绝，而不是把"没有图片审核"的内容当通过发出去。
              throw new ApiError('PROVIDER_UNAVAILABLE', '带媒体内容不得由规则层放行（内部不变式违反）');
            }
          }
          const link = moderationLink;
          // **发布闸门不在本域**（GY-I14 P1-1）：联动已接线时，内容先以「待审 / 私有」落库，
          // 只有审核域的发布闸门写成功后才会变成 `published` + `approved`。
          // ⛔ 本域**不再**写死 `visibility:'published'` + `audit_state:'approved'`。
          const awaitingPublish = !mediaReview && screen !== null && link !== null;
          const timestamp = nowIso();
          const record: PostRecord = {
            id,
            revision: 1,
            author_id: user.userId,
            // 新行的作者指针是活跃账户 ⇒ 匿名引用必为 NULL（迁移 0030 的"恰好一个"约束）。
            anonymized_author_ref: null,
            title: body.title,
            body: body.body,
            crop_id: body.crop_id ?? null,
            region_code: body.region_code ?? null,
            media_ids: [...body.media_ids],
            linked_knowledge_ref: linkTarget,
            visibility: awaitingPublish || mediaReview ? 'private' : 'published',
            audit_state: awaitingPublish || mediaReview ? 'pending' : 'approved',
            created_at: timestamp,
            updated_at: timestamp,
          };
          // 内容与审核结论**同一次原子提交**写入（不存在"内容已可见但其结论还没落"的窗口）。
          // 带媒体时结论**如实**取审核域那一条（`quarantined`/`pending`），不伪造成"待审 = 未判"。
          const inserted = await store.insertPost(
            record,
            mediaReview && screen !== null ? domainVerdict(target, outcome, screen, text) : buildVerdict(target, outcome, text),
          );
          if (!inserted) {
            throw new ApiError('PROVIDER_UNAVAILABLE', '内容 id 冲突（内部不变式违反）');
          }
          let committedRecord: PostRecord = record;
          if (awaitingPublish && link !== null) {
            // 第二步：交审核域发布。闸门拒绝 ⇒ **行保留为 pending_review**（私有 / 待审，
            // 不静默丢弃、也不留 published），错误原样上抛（fail-closed）。
            await link.publish({
              actor: linkActorOf(user),
              content: { target_ref: target, text, media: mediaInputs(body.media_ids) },
            });
            const published = await store.getPost(id);
            if (published === null) {
              throw new ApiError('PROVIDER_UNAVAILABLE', '发布后读不到内容行（内部不变式违反）');
            }
            committedRecord = published;
          }
          // 审核结果事件（已提交的 revision）投递到消息中心公开端口；失败不回滚内容。
          // 带媒体内容此刻**还没有**审核结果（隔离 / 待审），因此不投递"审核结果"事件。
          if (!mediaReview) {
            await publishModerationResult(user.userId, { type: 'post', id, revision: 1 }, outcome.decision, outcome.reason_codes);
          }
          return { outcome: { kind: 'post' as const, id, revision: 1 }, result: await projectPost(committedRecord) };
        },
        async (ref) => projectPost(await readablePost(user, ref.id)),
      );
    },

    /** `getPost`：`GET /posts/{id}`。他人对不可见内容一律 `NOT_FOUND`（不泄露存在性）。 */
    async getPost(actor: unknown, id: unknown): Promise<Post> {
      const user = requireUserActor(actor);
      const postId = requireUuidParam(id, 'id');
      return projectPost(await readablePost(user, postId));
    },

    /** `editPost`：`PATCH /posts/{id}`。仅作者；新 revision 必须**重新审核**后才可能可见。 */
    async editPost(actor: unknown, id: unknown, input: unknown, options: WriteOptions = {}): Promise<Post> {
      const user = requireUserActor(actor);
      const postId = requireUuidParam(id, 'id');
      const body = validatePostInput(input);
      const key = requireIdempotencyKey(options.idempotencyKey);
      const ifMatch = requireIfMatch(options.ifMatch);
      const scope = idempotencyScope(user.userId, 'PATCH', `/posts/${postId}`);
      const keyHash = idempotencyKeyHashHex(scope, key);
      const digest = idempotencyRequestHash(body, options.ifMatch, signingKey);
      return withIdempotency(
        scope,
        keyHash,
        digest,
        200,
        async () => {
          const record = await store.getPost(postId);
          // 只做"存在且属于本人"的快速失败（不泄露存在性）；已删除/状态变化由下面的 CAS 定夺，
          // 且**写路径**对已删除对象统一报 409 OBJECT_UNAVAILABLE（不因并发时序改变错误码语义）。
          if (record === null || record.author_id !== user.userId) throw notFound();
          if (record.revision !== ifMatch.revision) {
            throw new ApiError('REVISION_CONFLICT', '帖子版本已变化，请刷新后重试');
          }
          // 契约 PostInput 的编辑语义（逐字）：「**编辑遗漏关联保留旧值，显式 null 解除关联。
          // 新增/替换引用需当前可用，原已保存失效引用可原样保留，但只输出不可用投影**」。
          // 阶段 1 把"遗漏"当成 null（等于静默解除关联），这里修正为契约语义。
          const priorLink = record.linked_knowledge_ref;
          let nextLink: KnowledgeTarget | null;
          if (body.linked_knowledge_ref === undefined) {
            // 遗漏 ⇒ 保留旧值（**不**因为旧引用此刻失效就报错，也不清除它）。
            nextLink = priorLink === null ? null : { ...priorLink };
          } else {
            const requested = body.linked_knowledge_ref ?? null;
            if (requested === null) nextLink = null; // 显式 null ⇒ 解除关联
            else if (priorLink !== null && sameLink(priorLink, requested)) nextLink = { ...priorLink }; // 未变 ⇒ 原样保留
            else nextLink = await requireAvailableLink(requested); // 新增/替换 ⇒ 需当前可用
          }
          const revision = record.revision + 1;
          const target = { type: 'post' as const, id: postId, revision };
          await projectAuthor(user.userId);
          // 旧结论必须失效：用 evaluateReReview 显式证明"没有静默复用旧判定"。
          const prior = await store.getModeration('post', postId, record.revision);
          if (prior !== null && !gate.assess(target, prior).stale) {
            throw new ApiError('PROVIDER_UNAVAILABLE', '重审判定未生效（内部不变式违反），拒绝编辑');
          }
          const text = postModerationText({ title: body.title, body: body.body });
          const outcome = gate.evaluate(target, text, mediaInputs(body.media_ids));
          // 图片审核与门：与 `createPost` 逐字同口径（见那里的注释）。
          const mediaCount = body.media_ids.length;
          const imageReadiness: LinkImageReadiness | null =
            mediaCount > 0 ? readImageModerationReadiness(moderationLink) : null;
          const mediaAccepted =
            mediaCount > 0 &&
            ruleLayerDeferredMedia(outcome) &&
            imageReadiness !== null &&
            imageReadiness.ready === true;
          if (!outcome.publishable && !mediaAccepted) {
            await recordRefusalVerdict(target, outcome, text);
            throw refusal(outcome, imageReadiness);
          }
          // GY-I14 联动接线：**新 revision 必须重新送审**（新版本级任务 + 新输入绑定），
          // 旧版本的审核域结论**不得**套到新版本上（版本级绑定由审核域自己保证）；
          // 新版本未获明确放行（驳回 / 隔离）同样不得落库、不得公开。
          const screen = await screenWithModeration(user, target, text, body.media_ids);
          // 带媒体 ⇒ "已提交审核"态（与 `createPost` 同口径）：新 revision 落「私有 / 待审」，
          // 留在审核链路里，不走发布闸门。
          const mediaReview = mediaAccepted && isMediaReviewPending(screen);
          if (!mediaReview) {
            await requireDomainClearance(screen, target, outcome, text);
            if (mediaCount > 0) {
              throw new ApiError('PROVIDER_UNAVAILABLE', '带媒体内容不得由规则层放行（内部不变式违反）');
            }
          }
          const link = moderationLink;
          // 与 `createPost` 同一口径：联动已接线时先落「待审 / 私有」，再由审核域发布闸门
          // 把该**新 revision** 写成 `published` + `approved`（⛔ 本域不写死 approved）。
          const awaitingPublish = !mediaReview && screen !== null && link !== null;
          const patch: PostCommitPatch = {
            revision,
            title: body.title,
            body: body.body,
            crop_id: body.crop_id ?? null,
            region_code: body.region_code ?? null,
            media_ids: [...body.media_ids],
            linked_knowledge_ref: nextLink,
            visibility: awaitingPublish || mediaReview ? 'private' : 'published',
            audit_state: awaitingPublish || mediaReview ? 'pending' : 'approved',
            updated_at: nowIso(),
          };
          // 检查（revision/归属/未删除）与写入在**同一原子提交**内完成；
          // 审核结论也随这次提交一起写入。`record`（旧快照）只用于给出"期望值"，不用于写回。
          const committed = await store.commitPostIfCurrent(
            postId,
            { revision: record.revision, author_id: user.userId },
            patch,
            mediaReview && screen !== null ? domainVerdict(target, outcome, screen, text) : buildVerdict(target, outcome, text),
          );
          if (!committed.ok) throw commitRefusal(committed.reason);
          let committedRecord: PostRecord = committed.record;
          if (awaitingPublish && link !== null) {
            // 第二步：交审核域发布该新 revision。闸门拒绝 ⇒ **行保留为 pending_review**
            // （私有 / 待审，不静默丢弃、也不留 published），错误原样上抛（fail-closed）。
            await link.publish({
              actor: linkActorOf(user),
              content: { target_ref: target, text, media: mediaInputs(body.media_ids) },
            });
            const published = await store.getPost(postId);
            if (published === null) {
              throw new ApiError('PROVIDER_UNAVAILABLE', '发布后读不到内容行（内部不变式违反）');
            }
            committedRecord = published;
          }
          // 带媒体内容此刻还没有审核结果（隔离 / 待审）⇒ 不投递"审核结果"事件（与 `createPost` 同口径）。
          if (!mediaReview) {
            await publishModerationResult(
              user.userId,
              { type: 'post', id: postId, revision },
              outcome.decision,
              outcome.reason_codes,
            );
          }
          return {
            outcome: { kind: 'post' as const, id: postId, revision },
            result: await projectPost(committedRecord),
          };
        },
        async (ref) => projectPost(await readablePost(user, ref.id)),
      );
    },

    /** `deletePost`：`DELETE /posts/{id}`。仅作者；软删除（保留审计证据），对外一律 `NOT_FOUND`。 */
    async deletePost(actor: unknown, id: unknown, options: WriteOptions = {}): Promise<Ack> {
      const user = requireUserActor(actor);
      const postId = requireUuidParam(id, 'id');
      const key = requireIdempotencyKey(options.idempotencyKey);
      const ifMatch = requireIfMatch(options.ifMatch);
      const scope = idempotencyScope(user.userId, 'DELETE', `/posts/${postId}`);
      const keyHash = idempotencyKeyHashHex(scope, key);
      const digest = idempotencyRequestHash(null, options.ifMatch, signingKey);
      return withIdempotency(
        scope,
        keyHash,
        digest,
        200,
        async () => {
          const record = await store.getPost(postId);
          if (record === null || record.author_id !== user.userId) throw notFound();
          if (record.revision !== ifMatch.revision) throw new ApiError('REVISION_CONFLICT', '帖子版本已变化');
          // 删除同样是 CAS：与并发的编辑/重审交错时，后到者只会看到"已删除"，不会把它写回 published。
          const deleted = await store.commitPostIfCurrent(
            postId,
            { revision: record.revision, author_id: user.userId },
            { visibility: 'deleted', updated_at: nowIso() },
            null,
          );
          if (!deleted.ok) throw commitRefusal(deleted.reason);
          return {
            outcome: { kind: 'ack' as const, id: postId, revision: record.revision },
            result: { accepted: true },
          };
        },
        async () => ({ accepted: true }),
      );
    },

    /** `listComments`：`GET /posts/{id}/comments`。父帖不可见 ⇒ 整个列表 `NOT_FOUND`。 */
    async listComments(actor: unknown, postId: unknown, query: ListCommentsQuery = {}): Promise<CommentPage> {
      const user = requireUserActor(actor);
      const parentId = requireUuidParam(postId, 'id');
      const limit = parseLimit(query.limit ?? null);
      const cursor = parseCursor(query.cursor ?? null);
      // 父帖可读性先行：隐藏父帖不得通过评论列表泄露正文或存在性。
      await readablePost(user, parentId);
      const parent = await store.getPost(parentId);
      if (parent === null) throw notFound();
      const parentPublic = await isPubliclyVisible('post', parent);
      const all = await store.listComments(parentId);
      const readable: CommentRecord[] = [];
      for (const record of all) {
        if (record.visibility === 'deleted') continue;
        if (record.author_id === user.userId) {
          readable.push(record);
          continue;
        }
        if (parentPublic && (await isPubliclyVisible('comment', record))) readable.push(record);
      }
      const after = decodeCursor(cursor, {
        subject: user.userId,
        route: 'comments',
        filter: { post_id: parentId },
        sort: 'created_at_asc',
      });
      const remaining =
        after === null
          ? readable
          : readable.filter(
              (record) =>
                record.created_at > after.created_at ||
                (record.created_at === after.created_at && record.id > after.id),
            );
      const page = remaining.slice(0, limit);
      const last = page[page.length - 1];
      const next_cursor =
        remaining.length > limit && last !== undefined
          ? encodeCursor({
              subject: user.userId,
              route: 'comments',
              filter: { post_id: parentId },
              sort: 'created_at_asc',
              after: { created_at: last.created_at, id: last.id },
              expires: clock().getTime() + CURSOR_TTL_MS,
            })
          : null;
      const items: Comment[] = [];
      for (const record of page) items.push(await projectComment(record));
      return { items, next_cursor };
    },

    /** `createComment`：`POST /posts/{id}/comments`。If-Match = 父帖当前 revision，父帖须 published。 */
    async createComment(
      actor: unknown,
      postId: unknown,
      input: unknown,
      options: WriteOptions = {},
    ): Promise<Comment> {
      const user = requireUserActor(actor);
      const parentId = requireUuidParam(postId, 'id');
      const body: CommentInput = validateCommentInput(input);
      const key = requireIdempotencyKey(options.idempotencyKey);
      const ifMatch = requireIfMatch(options.ifMatch);
      const scope = idempotencyScope(user.userId, 'POST', `/posts/${parentId}/comments`);
      const keyHash = idempotencyKeyHashHex(scope, key);
      const digest = idempotencyRequestHash(body, options.ifMatch, signingKey);
      return withIdempotency(
        scope,
        keyHash,
        digest,
        201,
        async () => {
          const parent = await store.getPost(parentId);
          if (parent === null || parent.visibility === 'deleted') throw notFound();
          if (!(await isPubliclyVisible('post', parent))) throw notFound();
          if (parent.revision !== ifMatch.revision) {
            throw new ApiError('REVISION_CONFLICT', '父帖版本已变化，请刷新后重试');
          }
          await projectAuthor(user.userId);
          const id = newId();
          const target = { type: 'comment' as const, id, revision: 1 };
          const text = commentModerationText({ body: body.body });
          const outcome = gate.evaluate(target, text, []);
          if (!outcome.publishable) {
            await recordRefusalVerdict(target, outcome, text);
            throw refusal(outcome);
          }
          // GY-I14 联动接线：评论同样**先审后发**（版本级任务绑定该评论 revision）；
          // 未获明确放行（驳回 / 隔离）一律不落评论行、不公开。
          const screen = await screenWithModeration(user, target, text, []);
          await requireDomainClearance(screen, target, outcome, text);
          const link = moderationLink;
          // 与 `createPost` 同一口径：联动已接线时先落「待审 / 私有」，再由审核域发布闸门
          // 把该评论 revision 写成 `published` + `approved`（⛔ 本域不写死 approved）。
          const awaitingPublish = screen !== null && link !== null;
          const record: CommentRecord = {
            id,
            revision: 1,
            post_id: parentId,
            author_id: user.userId,
            // 同 `createPost`：活跃作者行的匿名引用恒为 NULL（迁移 0030 的"恰好一个"约束）。
            anonymized_author_ref: null,
            body: body.body,
            visibility: awaitingPublish ? 'private' : 'published',
            audit_state: awaitingPublish ? 'pending' : 'approved',
            created_at: nowIso(),
          };
          // 插入评论时在**同一临界区**再校验父帖（存在、未删除、revision 未变），
          // 防止"父帖刚被删除，评论却插入成功"。
          const inserted = await store.insertComment(record, buildVerdict(target, outcome, text), {
            id: parentId,
            revision: ifMatch.revision,
          });
          if (!inserted) {
            throw new ApiError('REVISION_CONFLICT', '父帖已被删除或版本已变化，请刷新后重试');
          }
          let committedRecord: CommentRecord = record;
          if (awaitingPublish && link !== null) {
            // 第二步：交审核域发布该评论 revision。闸门拒绝 ⇒ **行保留为 pending_review**
            // （私有 / 待审，不静默丢弃、也不留 `published`），错误原样上抛（fail-closed）。
            await link.publish({
              actor: linkActorOf(user),
              content: { target_ref: target, text, media: [] },
            });
            const published = await store.getComment(id);
            if (published === null) {
              throw new ApiError('PROVIDER_UNAVAILABLE', '发布后读不到评论行（内部不变式违反）');
            }
            committedRecord = published;
          }
          await publishModerationResult(
            user.userId,
            { type: 'comment', id, revision: 1 },
            outcome.decision,
            outcome.reason_codes,
          );
          // GY-I17 第 7 片：**他人评论**通知被评论帖子的作者（自评不通知）。
          // 只在评论**已经公开发布**后发：待审/私有的评论对外不可见，投一条通知等于
          // 泄露"存在一条受限评论"。跳转目标取**帖子**（评论行对他人未必可读）；
          // 去重键带 `commentId` ⇒ 同一评论只通知一次，重复调度不新建第二行。
          // 迁移 0030：父帖作者已注销（`author_id = NULL`）⇒ **没有接收者**，不投递
          // （⛔ 不要把 `ownerId: null` 塞进事件：那会造出一条无人可收的孤儿通知）。
          if (committedRecord.visibility === 'published' && parent.author_id !== null && parent.author_id !== user.userId) {
            await publishInteraction({
              event: 'comment_created',
              ownerId: parent.author_id,
              target: { type: 'post', id: parentId, revision: parent.revision },
              commentId: id,
              actorId: user.userId,
            });
          }
          return {
            outcome: { kind: 'comment' as const, id, revision: 1 },
            result: await projectComment(committedRecord),
          };
        },
        async (ref) => projectComment(await readableComment(user, ref.id)),
      );
    },

    /** `getComment`：`GET /comments/{id}`。作者可读自己的待审评论；他人仅可读公开版本。 */
    async getComment(actor: unknown, id: unknown): Promise<Comment> {
      const user = requireUserActor(actor);
      const commentId = requireUuidParam(id, 'id');
      return projectComment(await readableComment(user, commentId));
    },

    /** `editComment`：`PATCH /comments/{id}`。仅作者 + 必须重审。 */
    async editComment(actor: unknown, id: unknown, input: unknown, options: WriteOptions = {}): Promise<Comment> {
      const user = requireUserActor(actor);
      const commentId = requireUuidParam(id, 'id');
      const body = validateCommentInput(input);
      const key = requireIdempotencyKey(options.idempotencyKey);
      const ifMatch = requireIfMatch(options.ifMatch);
      const scope = idempotencyScope(user.userId, 'PATCH', `/comments/${commentId}`);
      const keyHash = idempotencyKeyHashHex(scope, key);
      const digest = idempotencyRequestHash(body, options.ifMatch, signingKey);
      return withIdempotency(
        scope,
        keyHash,
        digest,
        200,
        async () => {
          const record = await store.getComment(commentId);
          if (record === null || record.author_id !== user.userId) throw notFound();
          if (record.revision !== ifMatch.revision) throw new ApiError('REVISION_CONFLICT', '评论版本已变化');
          const revision = record.revision + 1;
          const target = { type: 'comment' as const, id: commentId, revision };
          await projectAuthor(user.userId);
          const prior = await store.getModeration('comment', commentId, record.revision);
          if (prior !== null && !gate.assess(target, prior).stale) {
            throw new ApiError('PROVIDER_UNAVAILABLE', '重审判定未生效（内部不变式违反），拒绝编辑');
          }
          const text = commentModerationText({ body: body.body });
          const outcome = gate.evaluate(target, text, []);
          if (!outcome.publishable) {
            await recordRefusalVerdict(target, outcome, text);
            throw refusal(outcome);
          }
          // GY-I14 联动接线：评论编辑生成的新 revision 同样必须先送审（旧结论不得套新版本）；
          // 未获明确放行（驳回 / 隔离）同样不得落库、不得公开。
          const screen = await screenWithModeration(user, target, text, []);
          await requireDomainClearance(screen, target, outcome, text);
          const link = moderationLink;
          // 与 `editPost` 同一口径：先落「待审 / 私有」，再由审核域发布闸门发布**该新 revision**。
          const awaitingPublish = screen !== null && link !== null;
          const patch: CommentCommitPatch = {
            revision,
            body: body.body,
            visibility: awaitingPublish ? 'private' : 'published',
            audit_state: awaitingPublish ? 'pending' : 'approved',
          };
          const committed = await store.commitCommentIfCurrent(
            commentId,
            { revision: record.revision, author_id: user.userId },
            patch,
            buildVerdict(target, outcome, text),
          );
          if (!committed.ok) throw commitRefusal(committed.reason);
          let committedRecord: CommentRecord = committed.record;
          if (awaitingPublish && link !== null) {
            // 闸门拒绝 ⇒ 新 revision 停在待审、公开面消失（旧版本结论不得继续放行）。
            await link.publish({
              actor: linkActorOf(user),
              content: { target_ref: target, text, media: [] },
            });
            const published = await store.getComment(commentId);
            if (published === null) {
              throw new ApiError('PROVIDER_UNAVAILABLE', '发布后读不到评论行（内部不变式违反）');
            }
            committedRecord = published;
          }
          await publishModerationResult(
            user.userId,
            { type: 'comment', id: commentId, revision },
            outcome.decision,
            outcome.reason_codes,
          );
          return {
            outcome: { kind: 'comment' as const, id: commentId, revision },
            result: await projectComment(committedRecord),
          };
        },
        async (ref) => projectComment(await readableComment(user, ref.id)),
      );
    },

    /** `deleteComment`：`DELETE /comments/{id}`。仅作者；软删除。 */
    async deleteComment(actor: unknown, id: unknown, options: WriteOptions = {}): Promise<Ack> {
      const user = requireUserActor(actor);
      const commentId = requireUuidParam(id, 'id');
      const key = requireIdempotencyKey(options.idempotencyKey);
      const ifMatch = requireIfMatch(options.ifMatch);
      const scope = idempotencyScope(user.userId, 'DELETE', `/comments/${commentId}`);
      const keyHash = idempotencyKeyHashHex(scope, key);
      const digest = idempotencyRequestHash(null, options.ifMatch, signingKey);
      return withIdempotency(
        scope,
        keyHash,
        digest,
        200,
        async () => {
          const record = await store.getComment(commentId);
          if (record === null || record.author_id !== user.userId) throw notFound();
          if (record.revision !== ifMatch.revision) throw new ApiError('REVISION_CONFLICT', '评论版本已变化');
          const deleted = await store.commitCommentIfCurrent(
            commentId,
            { revision: record.revision, author_id: user.userId },
            { visibility: 'deleted' },
            null,
          );
          if (!deleted.ok) throw commitRefusal(deleted.reason);
          return {
            outcome: { kind: 'ack' as const, id: commentId, revision: record.revision },
            result: { accepted: true },
          };
        },
        async () => ({ accepted: true }),
      );
    },

    /** `likePosts`：`PUT /posts/{id}/like`。重复 PUT 幂等（不重复计数；点赞不改内容 revision）。 */
    async likePosts(actor: unknown, id: unknown, options: WriteOptions = {}): Promise<Ack> {
      return like(actor, 'post', id, 'PUT', options);
    },
    /** `unlikePosts`：`DELETE /posts/{id}/like`。未点赞时为无操作，计数不为负。 */
    async unlikePosts(actor: unknown, id: unknown, options: WriteOptions = {}): Promise<Ack> {
      return like(actor, 'post', id, 'DELETE', options);
    },
    /** `likeComments`：`PUT /comments/{id}/like`。 */
    async likeComments(actor: unknown, id: unknown, options: WriteOptions = {}): Promise<Ack> {
      return like(actor, 'comment', id, 'PUT', options);
    },
    /** `unlikeComments`：`DELETE /comments/{id}/like`。 */
    async unlikeComments(actor: unknown, id: unknown, options: WriteOptions = {}): Promise<Ack> {
      return like(actor, 'comment', id, 'DELETE', options);
    },

    /** `createReport`：`POST /reports`。目标是当前公开可见版本；举报者身份只存库、不投影。 */
    async createReport(actor: unknown, input: unknown, options: WriteOptions = {}): Promise<Report> {
      const user = requireUserActor(actor);
      const body: ReportInput = validateReportInput(input);
      const key = requireIdempotencyKey(options.idempotencyKey);
      const scope = idempotencyScope(user.userId, 'POST', '/reports');
      const keyHash = idempotencyKeyHashHex(scope, key);
      const digest = idempotencyRequestHash(body, undefined, signingKey);
      return withIdempotency(
        scope,
        keyHash,
        digest,
        201,
        async () => {
          const target = await publiclyVisibleTarget(body.target_ref.type, body.target_ref.id);
          if (target.revision !== body.target_ref.revision) {
            throw new ApiError('REVISION_CONFLICT', '举报目标版本已变化，请刷新后重试');
          }
          const id = newId();
          const record: ReportRecord = {
            id,
            revision: 1,
            reporter_id: user.userId,
            target_ref: { type: body.target_ref.type, id: body.target_ref.id, revision: target.revision },
            state: 'received',
            reason_code: body.reason_code,
            detail: body.detail ?? null,
            created_at: nowIso(),
            // 迁移 0032：新举报的举报者恒为活账户 ⇒ 行内注销引用为 NULL
            // （库侧 `community_reports_reporter_exactly_one` 要求恰好一个非空）。
            anonymized_author_ref: null,
          };
          await store.insertReport(record);
          return { outcome: { kind: 'report' as const, id, revision: 1 }, result: projectReport(record) };
        },
        async (ref) => {
          const record = await store.getReport(ref.id);
          if (record === null || record.reporter_id !== user.userId) throw notFound();
          return projectReport(record);
        },
      );
    },

    /** `getOwnReport`：`GET /reports/{id}`。**仅举报者本人**可读，他人一律 `NOT_FOUND`。 */
    async getOwnReport(actor: unknown, id: unknown): Promise<Report> {
      const user = requireUserActor(actor);
      const reportId = requireUuidParam(id, 'id');
      const record = await store.getReport(reportId);
      if (record === null || record.reporter_id !== user.userId) throw notFound();
      return projectReport(record);
    },

    // -----------------------------------------------------------------------
    // 内部操作（**不是**契约 operationId；阶段 2 由巡检任务调用，无 HTTP 入口）
    // -----------------------------------------------------------------------

    /**
     * **举报状态推进**（GY-I15 · R31-S1）：`received → isolated → closed`。
     *
     * ## 为什么落在"内部操作"而不是注册 `PATCH /reports/{id}`
     *
     * `packages/contracts/openapi.json` 的举报面只有 `createReport` / `getOwnReport` 两条 op，
     * 处置动作**没有**任何 schema。本片受「不改契约 paths/schemas」约束，因此只把能力接到
     * 服务层：行为由单测（内存实现）与 PG 集成臂断言，注册路由属于"补完契约后"的那一片。
     * 这也意味着**授权面尚未接线**（谁能调这个函数目前由进程内调用方决定，不是 HTTP 层决定的）——
     * 已登记在证据页的未取得项里，不在这里假装已有权限模型。
     *
     * ## 三条语义
     *
     * 1. **只允许合法转移**：表在 `community/report-state.ts`。非法转移与"终态后再处置"一律
     *    `409 REVISION_CONFLICT`（契约 409 闭集里没有 `STATE_CONFLICT`，见证据页「新口径，待裁」）。
     * 2. **幂等由 CAS 承载**：`expected_revision` 必须等于当前 revision。拿同一个
     *    `expected_revision` 重复调用 ⇒ 第二次已被第一次推进 ⇒ 409，**不会**静默成功，
     *    也不会产生第二条记录。这同时是"处置后不可再处置"的实现：终态在状态机层就拒绝。
     * 3. **不做归属校验**：处置方是运营侧，不是举报者本人；举报者能读自己的举报（
     *    `getOwnReport`）但**不能**推进它。
     */
    async advanceReport(reportId: unknown, input: unknown): Promise<Report> {
      const id = requireUuidParam(reportId, 'report_id');
      const body = validateReportDispositionInput(input);
      const current = await store.getReport(id);
      if (current === null) throw notFound();
      const plan = planReportTransition(current.state, body.action);
      if (!plan.ok) {
        throw new ApiError(
          'REVISION_CONFLICT',
          plan.reason === 'TERMINAL_STATE' ? '举报已处置完毕，不可再次处置' : '举报当前状态不接受该处置动作',
        );
      }
      const committed = await store.commitReportIfCurrent(
        id,
        { revision: body.expected_revision, state: current.state },
        { revision: current.revision + 1, state: plan.to },
      );
      if (!committed.ok) throw commitRefusal(committed.reason);
      return projectReport(committed.record);
    },

    /**
     * 读取某版本的审核结论台账。**仅内容作者**可读（他人/不存在一律 `NOT_FOUND`）。
     * 返回结构**不是**契约 `Moderation`：缺 `model_version`/`prompt_version`（模型层未接入），
     * 用 `contract_complete:false` 与 `missing_contract_fields` 如实标注。
     */
    async getModerationDecision(actor: unknown, targetRef: unknown): Promise<ModerationRecord> {
      const user = requireUserActor(actor);
      const target = parseInternalTarget(targetRef);
      const content =
        target.type === 'post' ? await store.getPost(target.id) : await store.getComment(target.id);
      if (content === null || content.author_id !== user.userId) throw notFound();
      const record = await store.getModeration(target.type, target.id, target.revision);
      if (record === null) throw notFound();
      return record;
    },

    /**
     * **联动接线自述**（不是契约 operationId、不注册路由、不参与任何业务判定）：
     * 审核域联动端口是否已接线 + 口径说明 + 审核域台账只读计数（供证据页与用例断言）。
     */
    moderationLinkNote(): {
      wired: boolean;
      note: string;
      counts: ReturnType<CommunityModerationLink['counts']> | null;
    } {
      if (moderationLink === null) {
        return { wired: false, note: '审核域联动端口未接线（社区行为与本接线前逐字相同）', counts: null };
      }
      return { wired: true, note: moderationLink.note, counts: moderationLink.counts() };
    },

    /**
     * 按**当前**规则版本重审既有内容（规则集升级 / revision 变化后使用）。
     *
     * 复用 `packages/moderation` 的 `evaluateReReview` 判定失效，再复用 `evaluateHardRules`
     * 重跑规则；重审未通过的内容保持 `hidden`（不得因"曾经通过"而继续可见）。
     */
    async reReviewContent(actor: unknown, targetRef: unknown): Promise<ReReviewReport> {
      const user = requireUserActor(actor);
      const target = parseInternalTarget(targetRef);
      const record: PostRecord | CommentRecord | null =
        target.type === 'post' ? await store.getPost(target.id) : await store.getComment(target.id);
      if (record === null || record.author_id !== user.userId) throw notFound();
      if (record.revision !== target.revision) throw notFound();
      const prior = await store.getModeration(target.type, target.id, target.revision);
      if (prior === null) throw notFound();

      // 已下架内容**不得被重审复活**：重审只能"继续不可见 / 重新可见一个仍存活的版本"。
      if (record.visibility === 'deleted') {
        return {
          re_reviewed: false,
          publishable: false,
          decision: record.audit_state,
          reason_codes: ['NOT_PUBLISHABLE'],
          rule_version: prior.rule_version,
          visibility: 'deleted',
        };
      }

      const assessment = gate.assess(
        { type: target.type, id: target.id, revision: target.revision },
        prior,
      );
      const text =
        target.type === 'post' ? postModerationText(record as PostRecord) : commentModerationText(record as CommentRecord);
      if (!assessment.stale && prior.text_digest === sha256Hex(text)) {
        return {
          re_reviewed: false,
          publishable: assessment.publishable,
          decision: prior.decision,
          reason_codes: assessment.reason_codes,
          rule_version: prior.rule_version,
          visibility: (await effectiveState(target.type, record)).visibility,
        };
      }

      const outcome = gate.evaluate(
        { type: target.type, id: target.id, revision: target.revision },
        text,
        target.type === 'post' ? mediaInputs((record as PostRecord).media_ids) : [],
      );
      const visibility: Visibility = outcome.publishable ? 'published' : 'hidden';
      const auditState: AuditState = outcome.publishable ? 'approved' : outcome.decision;
      const verdict = buildVerdict({ type: target.type, id: target.id, revision: target.revision }, outcome, text);
      // 重审写回同样是 CAS：期望"读到的版本 + 读到的可见性/审核状态"，与删除交错时
      // 只会拿到 DELETED（返回"未重审、仍为 deleted"），**绝不复活**已下架内容。
      const expected = {
        revision: target.revision,
        author_id: user.userId,
        visibility: record.visibility,
        audit_state: record.audit_state,
      };
      const committed =
        target.type === 'post'
          ? await store.commitPostIfCurrent(
              target.id,
              expected,
              { visibility, audit_state: auditState, updated_at: nowIso() },
              verdict,
            )
          : await store.commitCommentIfCurrent(target.id, expected, { visibility, audit_state: auditState }, verdict);
      if (!committed.ok) {
        if (committed.reason === 'DELETED') {
          return {
            re_reviewed: false,
            publishable: false,
            decision: record.audit_state,
            reason_codes: ['NOT_PUBLISHABLE'],
            rule_version: prior.rule_version,
            visibility: 'deleted',
          };
        }
        throw commitRefusal(committed.reason);
      }
      // 重审把既有内容**降级为不可见**（或重新放行）：这是对作者有意义的审核结果，
      // 投递一条消息；同一 (rev, decision) 重复投递命中去重键，不产生第二条。
      await publishModerationResult(
        user.userId,
        { type: target.type, id: target.id, revision: target.revision },
        auditState,
        outcome.reason_codes,
      );
      return {
        re_reviewed: true,
        publishable: outcome.publishable,
        decision: outcome.decision,
        reason_codes: [...outcome.reason_codes],
        rule_version: outcome.rule_version,
        visibility,
      };
    },

    /** 诊断用：点赞计数（契约 `Post`/`Comment` **没有**点赞计数字段，故无对外读取口）。 */
    async countLikes(kind: 'post' | 'comment', id: string): Promise<number> {
      return store.countLikes(kind, id);
    },

    /**
     * GY-I17（#17）· G4：**只读**判据 —— "该目标此刻是否公开可读"。
     *
     * 复用与写入/读取**同一道**闸门 `publiclyVisibleTarget`（帖子看可见性+审核结论，
     * 评论另校验父帖），所以这里不会比真实读取面更宽：任何"读不到"（不存在、未发布、
     * 已下架、已删除、无权、审核退回）都被**折叠成同一个 `false`** —— 不区分原因、
     * 不带目标细节，存在性无从泄露。
     *
     * **仅供消息域跳转端口内部接线**：不注册路由、不进 OpenAPI、不进任何响应投影。
     */
    visibility: Object.freeze({
      async isPubliclyVisible(kind: 'post' | 'comment', id: string): Promise<boolean> {
        try {
          await publiclyVisibleTarget(kind, id);
          return true;
        } catch {
          return false;
        }
      },
    }),
  };

  async function like(
    actor: unknown,
    kind: 'post' | 'comment',
    id: unknown,
    method: 'PUT' | 'DELETE',
    options: WriteOptions,
  ): Promise<Ack> {
    const user = requireUserActor(actor);
    const targetId = requireUuidParam(id, 'id');
    const key = requireIdempotencyKey(options.idempotencyKey);
    const ifMatch = requireIfMatch(options.ifMatch);
    const routePath = kind === 'post' ? `/posts/${targetId}/like` : `/comments/${targetId}/like`;
    const scope = idempotencyScope(user.userId, method, routePath);
    const keyHash = idempotencyKeyHashHex(scope, key);
    const digest = idempotencyRequestHash({ kind, id: targetId }, options.ifMatch, signingKey);
    return withIdempotency(
      scope,
      keyHash,
      digest,
      200,
      async () => {
        const target = await publiclyVisibleTarget(kind, targetId);
        if (target.revision !== ifMatch.revision) {
          throw new ApiError('REVISION_CONFLICT', '目标版本已变化，请刷新后重试');
        }
        if (method === 'PUT') {
          const added = await store.addLike(kind, targetId, user.userId);
          // GY-I17 第 7 片：**他人点赞**通知被赞内容的作者（自赞不通知）。
          // `addLike` 返回「是否真的新增」：已赞再 PUT（换幂等键重放）为 `false` ⇒ 不重复
          // 调度；即使重复调度，事件键 `...:u<likerId>` 也会命中去重索引，不产生第二行。
          // 迁移 0030：被赞内容已注销（`author_id = NULL`）⇒ 没有接收者，不投递。
          if (added && target.author_id !== null && target.author_id !== user.userId) {
            await publishInteraction({
              event: 'like_created',
              ownerId: target.author_id,
              target: { type: kind, id: targetId, revision: target.revision },
              actorId: user.userId,
            });
          }
        } else {
          await store.removeLike(kind, targetId, user.userId);
        }
        return {
          outcome: { kind: 'ack' as const, id: targetId, revision: target.revision },
          result: { accepted: true },
        };
      },
      async () => ({ accepted: true }),
    );
  }

  return service;
}

export type CommunityService = ReturnType<typeof createCommunityService>;

function parseInternalTarget(value: unknown): { type: 'post' | 'comment'; id: string; revision: number } {
  if (typeof value !== 'object' || value === null) {
    throw new ApiError('INVALID_REQUEST', 'target_ref 必须是对象');
  }
  const record = value as Record<string, unknown>;
  const type = record['type'];
  const id = record['id'];
  const revision = record['revision'];
  if (type !== 'post' && type !== 'comment') throw new ApiError('INVALID_REQUEST', 'target_ref.type 必须是 post/comment');
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) throw new ApiError('INVALID_REQUEST', 'target_ref.id 必须是 uuid');
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    throw new ApiError('INVALID_REQUEST', 'target_ref.revision 必须是 ≥1 的整数');
  }
  return { type, id, revision };
}
