/**
 * GY-I14（#14）审核 HTTP 装配片 · **审核服务**（规则先挡 → 模型合流 → 失败隔离 → 版本级任务）。
 *
 * 复用声明（**不另起一套**，派单 §1）：
 *   - 硬规则裁决：`packages/moderation` 的 `evaluateBoundHardRules`（= 规则层唯一入口 + 输入绑定）；
 *   - 模型合流 / 失败隔离 / 版本三元组：`mergeModeration`（返回契约 `Moderation` 或如实报缺）、
 *     `evaluateModelReReview`、`isModelLayerPublishable`、`checkMergedInvariant`；
 *   - 契约形状自检：`services/api/src/jobs/result-shape.ts` 的契约镜像（逐项抄录冻结契约）。
 *   本模块**不**重写规则匹配、不重写合流、不改 `packages/contracts/**`、不改 `packages/moderation/**`。
 *
 * 状态机（派单 §2.2）：
 *   待筛查 `pending`/`queued` → 通过 `approved`/`succeeded` │ 待复核 `quarantined`/`uncertain`
 *   │ 驳回 `rejected`/`succeeded`；**发布**与**下架**是可见性动作（`Visibility`），与筛查分成两步。
 *   AI 失败 / 超时 / 无结论 ⇒ **一律隔离**（`quarantined` + `uncertain`），**绝不记通过**。
 *
 * fail-closed（派单 §3）：`execution_mode === 'real'` 且真实供应商**未授权/未接线** ⇒
 *   整域按契约 503 `PROVIDER_UNAVAILABLE`（`retryable: true`）拒绝，**不得**用内存/替身返回成功封套。
 */
import { randomUUID } from 'node:crypto';
import {
  mergeModeration,
} from '../../../../packages/moderation/merge.mjs';
import { deriveRuleVersion } from '../../../../packages/moderation/index.mjs';
import { derivePromptVersionForIds } from '../../../../packages/moderation/prompt-version.mjs';
import { promptIdForPortKind } from '../../../../packages/moderation/prompts.mjs';
import { evaluateBoundHardRules, moderationInputDigest } from '../../../../packages/moderation/input-binding.mjs';
import { evaluateModelReReview, isModelLayerPublishable } from '../../../../packages/moderation/model-review.mjs';
import { ApiError } from '../errors.ts';
import type { ErrorCode } from '../contract.ts';
import {
  buildContractModeration,
  contentKindsFor,
  createModerationLedger,
  errorCodeFor,
  gateHolderFrom,
  orderedReasonCodes,
  projectKindScreening,
  requiredPortKindsFor,
  taskView,
} from './decisions.ts';
import type { KindProjection, ModerationLedger } from './decisions.ts';
import {
  CALLBACK_MAX_SKEW_MS,
  createCallbackReplayGuard,
  isCallbackExpired,
  isTerminalTaskState,
  parseCallbackEnvelope,
  verifyCallbackSignature,
} from './callback.ts';
import type { CallbackOutcome, CallbackReplayGuard } from './callback.ts';
import { humanReviewQueue } from './nonbypass.ts';
import { declaredModelVersion, declaredProvider, resolveModerationPorts } from './provider.ts';
import type { ResolvedModerationPorts } from './provider.ts';
import {
  PORT_KIND_BY_CONTENT_KIND,
  PROMPT_ID_BY_CONTENT_KIND,
  TARGET_REF_TYPES,
} from './types.ts';
import type {
  AuditState,
  ContentKind,
  ContractModeration,
  JobState,
  ModerationActor,
  ModerationContent,
  ModerationExecutionMode,
  ModerationTaskRecord,
  ModerationTaskView,
  TargetRef,
  Visibility,
} from './types.ts';
import {
  checkReadVisibility,
  createReadCache,
  createSubstituteContentAuthority,
} from './visibility.ts';
import type { ContentAuthorityPort } from './types.ts';
import type { ReadCache, ReadVerdict } from './visibility.ts';

/** 审核任务默认截止时间（受理时刻起算）：过期只是"不再等待"——任务仍是 `uncertain`（隔离），绝不放行。 */
export const DEFAULT_SCREENING_DEADLINE_MS = 5 * 60 * 1000;

/** 规则层结论的最小读取形状（只读；`packages/moderation` 的原形状见其 `index.mjs`）。 */
interface RuleLayerRead {
  decision: AuditState;
  reason_codes: string[];
  hard_rule_passed: boolean;
  rule_version: string | null;
  input_valid: boolean;
  media_count: number;
  counts: Record<string, unknown> | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读取规则层结论（**不抛错**：读不出来就当作"没有结论"⇒ 隔离）。 */
function readRuleLayer(result: unknown): RuleLayerRead {
  const holder = isPlainObject(result) ? result : {};
  const decisionRead = holder['decision'];
  const decision: AuditState =
    decisionRead === 'approved' || decisionRead === 'rejected' || decisionRead === 'quarantined' || decisionRead === 'pending'
      ? decisionRead
      : 'quarantined';
  const codesRead = holder['reason_codes'];
  const inputRead = holder['input'];
  const input = isPlainObject(inputRead) ? inputRead : {};
  const mediaCount = typeof input['media_count'] === 'number' ? input['media_count'] : 0;
  const countsRead = holder['counts'];
  const ruleVersion = holder['rule_version'];
  return {
    decision,
    reason_codes: Array.isArray(codesRead) ? codesRead.filter((code): code is string => typeof code === 'string') : [],
    hard_rule_passed: holder['hard_rule_passed'] === true,
    rule_version: typeof ruleVersion === 'string' ? ruleVersion : null,
    input_valid: input['valid'] === true,
    media_count: mediaCount,
    counts: isPlainObject(countsRead) ? countsRead : null,
  };
}

export interface ModerationServiceDeps {
  executionMode: ModerationExecutionMode;
  /** 注入端口（**仅测试/演示**；`real` 下被忽略，见 `resolveModerationPorts`）。 */
  ports?: { tms?: unknown; ims?: unknown };
  /** 内容权威端口（默认：real ⇒ 未接线 fail-closed；其余 ⇒ 明确标注的替身）。 */
  authority?: ContentAuthorityPort;
  /** 决策台账（默认新建内存台账）。 */
  store?: ModerationLedger;
  /** 读缓存（默认新建；永远只作提示）。 */
  cache?: ReadCache;
  /** 回调验签密钥（只在内存；不落库、不入日志）。缺省时回调一律拒绝（无密钥 ⇒ 无法验签）。 */
  callbackKey?: string;
  now?: () => Date;
  newId?: () => string;
  newLeaseToken?: () => string;
  /** 规则层选项（测试可注入冻结时钟/预算/自定义规则集；生产用出厂规则集）。 */
  ruleOptions?: Record<string, unknown>;
  /** 模型端口超时（毫秒），透传合流层 `deadline_ms`。 */
  modelDeadlineMs?: number;
}

export interface ScreeningOutcome {
  target_ref: TargetRef;
  tasks: ModerationTaskView[];
  overall: { decision: AuditState; reason_codes: string[]; publishable: boolean };
  /** 本次（异步路径）是否把任务留在"待回调"。 */
  deferred: boolean;
}

export interface PublishOutcome {
  target_ref: TargetRef;
  published: boolean;
  visibility: Visibility;
  published_revision: number;
  reason_codes: string[];
  cache_keys_invalidated: string[];
}

export interface WithdrawOutcome {
  target_ref: TargetRef;
  visibility: Visibility;
  withdrawn: boolean;
  invalidated_cache_keys: string[];
  /** 下架事件（供缓存/列表/详情订阅；**不下发**任何正文）。 */
  event: { kind: 'moderation.takedown'; target_ref: TargetRef; reason_code: string; at: string };
}

export interface ReadViewOutcome extends ReadVerdict {
  target_ref: TargetRef;
}

export interface ReReviewReport {
  target_ref: TargetRef;
  rule_version_current: string | null;
  tasks: Array<{
    job_id: string;
    content_kind: ContentKind;
    stale: boolean;
    action: 'reuse' | 're_review';
    publishable: boolean;
    reason_codes: string[];
  }>;
  publishable: boolean;
  reason_codes: string[];
}

export interface ModerationService {
  readonly execution_mode: ModerationExecutionMode;
  /** 当前规则集派生版本（无法派生 ⇒ `null` ⇒ 任何内容都不得发布）。 */
  currentRuleVersion(): string | null;
  /** 送审（规则先挡；模型层同步求值，或按 `defer_model` 留在待回调）。 */
  submitScreening(input: { actor: ModerationActor; content: ModerationContent; defer_model?: boolean }): Promise<ScreeningOutcome>;
  /** 对已建任务补跑模型层（同步路径；等价于 `submitScreening(defer_model=false)` 的模型阶段）。 */
  runModelScreening(input: { actor: ModerationActor; content: ModerationContent }): Promise<ScreeningOutcome>;
  /** **发布**（与筛查分开的一步；重跑版本/证据/输入绑定闸门）。 */
  publish(input: { actor: ModerationActor; content: ModerationContent }): Promise<PublishOutcome>;
  /** **下架**（管理员动作；驱动缓存失效，旧回调不复活）。 */
  withdraw(input: { actor: ModerationActor; target_ref: TargetRef; reason_code: string }): Promise<WithdrawOutcome>;
  /** 读取面的**重查**（隐藏/失效/注销/旧链接不因缓存重新公开）。 */
  readView(input: { actor: ModerationActor | null; target_ref: TargetRef }): Promise<ReadViewOutcome>;
  /** 版本重审报告（当前版本下旧结论是否仍有效）。 */
  reReview(input: { actor: ModerationActor; target_ref: TargetRef; content?: ModerationContent }): Promise<ReReviewReport>;
  /** 供应商回调（**服务端受信 seam**，不在 OpenAPI 内；验签 + 版本 + 回放 + 下架核对）。 */
  ingestCallback(input: { raw_body: string; signature: string }): Promise<CallbackOutcome>;
  tasks(target_ref: TargetRef): ModerationTaskView[];
  taskByJobId(jobId: string): ModerationTaskView | null;
  humanReview(): ReturnType<typeof humanReviewQueue>;
  counts(): {
    tasks: number;
    current: number;
    superseded: number;
    withdrawn: number;
    cache_entries: number;
    callbacks_settled: number;
    substitutes: string[];
    authority_origin: string;
    callback_key_configured: boolean;
  };
}

function sessionRequired(): ApiError {
  return new ApiError('SESSION_REQUIRED', '缺少会话主体', {
    details: [{ field: 'actor', code: 'SESSION_REQUIRED' }],
  });
}

function invalidRequest(message: string, details: Array<{ field: string; code: string }> = []): ApiError {
  return new ApiError('INVALID_REQUEST', message, { details });
}

/**
 * **模型层可达性**（装配层的安全加严，必须与文档一致）：
 * 只有"规则层得出可放行结论"或"规则层仅因声明了媒体而不评估（图片只能由模型层筛查）"时，
 * 才把内容交给模型端口；其余任何情形（驳回、输入非法、引擎异常、规则集非法、超时、扫描截断、
 * 版本未知）都**不外发**给第三方供应商——既有安全理由（不把已判定违规/含 PII 的内容外发），
 * 也避免为注定不放行的内容付费调用。结论方向**不变**：模型不得把非通过抬成通过。
 */
function modelLayerReachable(rule: RuleLayerRead): boolean {
  if (!rule.input_valid) return false;
  if (rule.decision === 'rejected') return false;
  if (rule.decision === 'approved') return true;
  return rule.reason_codes.every((code) => code === 'MEDIA_NOT_EVALUATED_BY_RULE_LAYER');
}

/** 主体校验（不接受客户端自述身份；缺一项即 401）。 */
function assertActor(actor: ModerationActor | null | undefined): ModerationActor {
  if (
    actor === null ||
    actor === undefined ||
    typeof actor.userId !== 'string' ||
    actor.userId.length === 0 ||
    (actor.role !== 'user' && actor.role !== 'admin') ||
    !Number.isInteger(actor.authEpoch) ||
    actor.authEpoch < 1
  ) {
    throw sessionRequired();
  }
  return actor;
}

/** 目标引用校验（契约 `TargetRef`：type 闭集、id 1..80、revision ≥1）。 */
function assertTargetRef(value: unknown): TargetRef {
  if (!isPlainObject(value)) throw invalidRequest('target_ref 必须是对象');
  const type = value['type'];
  if (typeof type !== 'string' || !(TARGET_REF_TYPES as readonly string[]).includes(type)) {
    throw invalidRequest('target_ref.type 必须是契约闭集成员', [{ field: 'target_ref.type', code: 'INVALID_ENUM' }]);
  }
  const id = value['id'];
  if (typeof id !== 'string' || id.length < 1 || id.length > 80) {
    throw invalidRequest('target_ref.id 必须是 1..80 的字符串', [{ field: 'target_ref.id', code: 'INVALID_LENGTH' }]);
  }
  const revision = value['revision'];
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    throw invalidRequest('target_ref.revision 必须是 ≥1 的整数', [{ field: 'target_ref.revision', code: 'INVALID_RANGE' }]);
  }
  return { type: type as TargetRef['type'], id, revision };
}

/**
 * 内容规范化：**逐字段保真**（不静默丢弃、不补默认值）。
 *
 * 输入绑定的本意是"结论只对**这一份**内容有效"，因此这里保留调用方声明的媒体字段原样
 * （多一个 `mime` 就是另一份内容）；发布会用同一份内容重算摘要并比对。
 */
function normalizeContent(content: unknown): ModerationContent {
  if (!isPlainObject(content)) throw invalidRequest('content 必须是对象');
  const targetRef = assertTargetRef(content['target_ref']);
  const text = content['text'];
  if (typeof text !== 'string') throw invalidRequest('content.text 必须是字符串');
  const mediaRead = content['media'];
  if (!Array.isArray(mediaRead)) throw invalidRequest('content.media 必须是数组');
  const media = mediaRead.map((item, index) => {
    if (!isPlainObject(item)) throw invalidRequest(`content.media[${index}] 必须是对象`);
    const mediaId = item['media_id'];
    if (typeof mediaId !== 'string' || mediaId.length < 1 || mediaId.length > 80) {
      throw invalidRequest(`content.media[${index}].media_id 必须是 1..80 的字符串`);
    }
    const normalized: { media_id: string; media_revision?: number; mime?: string } = { media_id: mediaId };
    const revisionRead = item['media_revision'];
    if (revisionRead !== undefined) {
      if (typeof revisionRead !== 'number' || !Number.isInteger(revisionRead) || revisionRead < 1) {
        throw invalidRequest(`content.media[${index}].media_revision 必须是 ≥1 的整数`);
      }
      normalized.media_revision = revisionRead;
    }
    const mimeRead = item['mime'];
    if (mimeRead !== undefined) {
      if (typeof mimeRead !== 'string' || mimeRead.length < 1 || mimeRead.length > 80) {
        throw invalidRequest(`content.media[${index}].mime 必须是 1..80 的字符串`);
      }
      normalized.mime = mimeRead;
    }
    return normalized;
  });
  return { target_ref: targetRef, text, media };
}

function noPortsForReal(): ApiError {
  return new ApiError(
    'PROVIDER_UNAVAILABLE',
    'real 模式未接真实审核供应商（tms/ims 未授权、BizType 未核验）：审核不可用，拒绝以替身/内存返回成功封套',
    { retryable: true },
  );
}

/**
 * **real 模式的整域 fail-closed 服务**（沿用 `admin/fail-closed-services.ts` 的既有机制）：
 * 每个会"声称完成"的操作都以契约 503 `PROVIDER_UNAVAILABLE`（`retryable`）如实拒绝；
 * 读面（`tasks`/`taskByJobId`）返回空 —— real 下不存在任何审核任务（送审根本不会被受理）。
 */
export function createFailClosedModerationService(): ModerationService {
  const deny = (): never => {
    throw noPortsForReal();
  };
  return {
    execution_mode: 'real',
    currentRuleVersion: () => {
      try {
        return deriveRuleVersion();
      } catch {
        return null;
      }
    },
    submitScreening: async () => deny(),
    runModelScreening: async () => deny(),
    publish: async () => deny(),
    withdraw: async () => deny(),
    readView: async () => deny(),
    reReview: async () => deny(),
    ingestCallback: async () => deny(),
    tasks: () => [],
    taskByJobId: () => null,
    humanReview: () => humanReviewQueue(),
    counts: () => ({
      tasks: 0,
      current: 0,
      superseded: 0,
      withdrawn: 0,
      cache_entries: 0,
      callbacks_settled: 0,
      substitutes: [],
      authority_origin: 'unwired',
      callback_key_configured: false,
    }),
  };
}

export function createModerationService(deps: ModerationServiceDeps): ModerationService {
  if (deps.executionMode === 'real') {
    // **不**注入任何替身：real 一律走 fail-closed 服务（含未接线权威端口，读面也不可能"看起来可用"）。
    return createFailClosedModerationService();
  }

  const executionMode = deps.executionMode;
  const ledger = deps.store ?? createModerationLedger();
  const cache = deps.cache ?? createReadCache();
  const authority = deps.authority ?? createSubstituteContentAuthority();
  const clock = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());
  const newLeaseToken = deps.newLeaseToken ?? (() => randomUUID());
  const callbackKey = deps.callbackKey ?? null;
  const replayGuard: CallbackReplayGuard = createCallbackReplayGuard();
  const resolved: ResolvedModerationPorts = resolveModerationPorts({
    executionMode,
    ...(deps.ports === undefined ? {} : { injected: deps.ports }),
  });
  const ruleOptions = deps.ruleOptions ?? {};
  const nowIso = (): string => clock().toISOString();
  const screeningDeadlineMs = deps.modelDeadlineMs ?? DEFAULT_SCREENING_DEADLINE_MS;

  function currentRuleVersion(): string | null {
    try {
      // **必须**用本服务实际使用的规则集派生"当前版本"：调用方注入自定义规则集时，
      // 默认规则集的版本无关紧要（否则"规则集升级后旧结论失效"会被误判为"从未生效"）。
      return deriveRuleVersion(
        ruleOptions['rules'] as never,
        ruleOptions['matchers'] as never,
        ruleOptions['matcher_revisions'] as never,
      );
    } catch {
      return null;
    }
  }

  function currentModelVersion(kind: ContentKind): string | null {
    return declaredModelVersion(resolved.ports[PORT_KIND_BY_CONTENT_KIND[kind]]);
  }

  function currentPromptVersion(mediaCount: number): string | null {
    const ids: string[] = [];
    for (const portKind of requiredPortKindsFor(mediaCount)) {
      const id = promptIdForPortKind(portKind);
      if (typeof id !== 'string') return null;
      ids.push(id);
    }
    try {
      return derivePromptVersionForIds(ids);
    } catch {
      return null;
    }
  }

  /** 该内容类别下，端口证据的 origin（`substitute` / `injected` / `none`）。 */
  function portOrigin(kind: ContentKind): 'injected' | 'substitute' | 'none' {
    const portKind = PORT_KIND_BY_CONTENT_KIND[kind];
    const port = resolved.ports[portKind];
    if (port === undefined || port === null) return 'none';
    return resolved.substitutes.includes(portKind) ? 'substitute' : 'injected';
  }

  function mediaRefsOf(content: ModerationContent): string[] {
    return content.media.map((item) => `${item.media_id}:${item.media_revision ?? 1}`);
  }

  function buildTask(args: {
    kind: ContentKind;
    content: ModerationContent;
    projection: KindProjection;
    merged: Awaited<ReturnType<typeof mergeModeration>> | null;
    rule: RuleLayerRead;
    digest: string;
    mediaRefs: string[];
    authorizationEpoch: number;
    submittedBy: string;
  }): ModerationTaskRecord {
    const { kind, content, projection, merged, rule } = args;
    const portKind = PORT_KIND_BY_CONTENT_KIND[kind];
    const port = resolved.ports[portKind];
    const provider = declaredProvider(port);
    const promptId = PROMPT_ID_BY_CONTENT_KIND[kind];
    const origin = portOrigin(kind);
    const jobId = newId();
    // 契约 `Moderation` 的 `id` 属持久层字段：这里就用任务 id（Job.result.value 与 Job 自身同源）。
    const contract: ContractModeration | null = buildContractModeration({
      job_id: jobId,
      target_ref: content.target_ref,
      decision: projection.decision,
      reason_codes: projection.reason_codes,
      hard_rule_passed: projection.hard_rule_passed,
      model_version: projection.model_version,
      prompt_version: projection.prompt_version,
      rule_version: projection.rule_version,
    });
    const modelKinds = merged === null ? [] : Object.values(merged.model_layer?.kinds ?? {});
    const createdAt = nowIso();
    return {
      job_id: jobId,
      target_ref: content.target_ref,
      content_kind: kind,
      port_kind: portKind,
      prompt_id: promptId,
      job_revision: 1,
      state: projection.state,
      lease_token: newLeaseToken(),
      authorization_epoch: args.authorizationEpoch,
      submitted_by: args.submittedBy,
      deadline_at: new Date(Date.parse(createdAt) + screeningDeadlineMs).toISOString(),
      decision: projection.decision,
      reason_codes: projection.reason_codes,
      hard_rule_passed: projection.hard_rule_passed,
      rule_version: projection.rule_version,
      model_version: projection.model_version,
      prompt_version: projection.prompt_version,
      contract_value: contract,
      gate_holder: gateHolderFrom({
        target_ref: content.target_ref,
        decision: projection.decision,
        reason_codes: projection.reason_codes,
        hard_rule_passed: projection.hard_rule_passed,
        rule_version: projection.rule_version,
        model_version: projection.model_version,
        prompt_version: projection.prompt_version,
        merged,
      }),
      error_code: projection.error_code,
      evidence: {
        execution_mode: executionMode,
        provider:
          port === undefined || port === null
            ? null
            : {
                kind: portKind,
                model_version: declaredModelVersion(port) ?? projection.model_version,
                biz_type: provider.biz_type,
                synthetic: provider.synthetic,
                origin,
              },
        model_template: promptId,
        input_binding_digest: args.digest,
        input_binding_verified: merged?.input_binding?.verified === true,
        text_length: content.text.length,
        media_count: content.media.length,
        checked_media_refs: [...args.mediaRefs],
        rule_reason_codes: [...rule.reason_codes],
        model_reason_codes: projection.model_reason_codes,
        model_kinds: modelKinds.map((entry) => ({
          kind: entry.kind as 'tms' | 'ims',
          status: entry.status,
          label: entry.label,
          reason_codes: [...entry.reason_codes],
          reported: entry.reported,
          synthetic: entry.synthetic === true,
        })),
        reasons: projection.reasons,
        rule_counts: merged?.rule_layer?.counts ?? rule.counts,
      },
      created_at: createdAt,
      updated_at: createdAt,
      superseded: false,
    };
  }

  async function screen(args: {
    actor: ModerationActor;
    content: ModerationContent;
    deferModel: boolean;
  }): Promise<ScreeningOutcome> {
    assertActor(args.actor);
    const content = normalizeContent(args.content);
    const target = content.target_ref;
    const digest = moderationInputDigest(content);
    const mediaRefs = mediaRefsOf(content);

    let ruleRaw: unknown;
    try {
      ruleRaw = evaluateBoundHardRules(
        { target_ref: target, text: content.text, media: content.media },
        ruleOptions,
      );
    } catch {
      // 规则层抛错 = "没跑"：不得当作通过。这里用与规则层同形的最小隔离结论（不伪造版本）。
      ruleRaw = {
        decision: 'quarantined',
        reason_codes: ['RULE_ENGINE_ERROR'],
        hard_rule_passed: false,
        rule_version: null,
        input: { valid: false, media_count: content.media.length },
        counts: null,
      };
    }
    const rule = readRuleLayer(ruleRaw);
    const mediaCount = content.media.length;
    const kinds = contentKindsFor(mediaCount);

    const canRunModel = modelLayerReachable(rule);
    let merged: Awaited<ReturnType<typeof mergeModeration>> | null = null;
    let mergeFailed: string[] = [];
    let deferred = false;

    if (canRunModel && args.deferModel) {
      deferred = true;
    } else if (canRunModel) {
      try {
        merged = await mergeModeration(ruleRaw, {
          content: { target_ref: target, text: content.text, media: content.media },
          ports: resolved.ports,
          execution_mode: executionMode,
          ...(deps.modelDeadlineMs === undefined ? {} : { deadline_ms: deps.modelDeadlineMs }),
        });
      } catch {
        // 合流层抛错（不该发生；防御性兜底）⇒ 一律隔离，绝不放行。
        merged = null;
        mergeFailed = ['MODEL_PORT_ERROR'];
      }
    }

    const records: ModerationTaskRecord[] = [];
    for (const kind of kinds) {
      let projection: KindProjection;
      if (mergeFailed.length > 0) {
        projection = {
          content_kind: kind,
          decision: 'quarantined',
          state: 'uncertain',
          reason_codes: orderedReasonCodes([...rule.reason_codes, ...mergeFailed]),
          hard_rule_passed: false,
          rule_reason_codes: [...rule.reason_codes],
          model_reason_codes: [...mergeFailed],
          reasons: ['model_screening_error'],
          error_code: errorCodeFor({ ruleReasonCodes: rule.reason_codes, modelReasonCodes: mergeFailed, modelStatus: 'failed' }),
          rule_version: rule.rule_version,
          model_version: null,
          prompt_version: null,
        };
      } else {
        projection = projectKindScreening({
          contentKind: kind,
          ruleDecision: rule.decision,
          ruleReasonCodes: rule.reason_codes,
          ruleInputValid: rule.input_valid,
          ruleHardPassed: rule.hard_rule_passed,
          ruleVersion: rule.rule_version,
          modelDeferred: canRunModel && deferred,
          merged: canRunModel && !deferred ? merged : null,
        });
      }
      records.push(
        buildTask({
          kind,
          content,
          projection,
          merged: canRunModel && !deferred && mergeFailed.length === 0 ? merged : null,
          rule,
          digest,
          mediaRefs,
          authorizationEpoch: args.actor.authEpoch,
          submittedBy: args.actor.userId,
        }),
      );
    }

    const stored: ModerationTaskRecord[] = [];
    for (const record of records) stored.push(ledger.create(record));

    const overallDecision: AuditState = stored.every((record) => record.decision === 'approved')
      ? 'approved'
      : stored.some((record) => record.decision === 'rejected')
        ? 'rejected'
        : stored.some((record) => record.decision === 'pending')
          ? 'pending'
          : 'quarantined';

    return {
      target_ref: target,
      tasks: stored.map(taskView),
      overall: {
        decision: overallDecision,
        reason_codes: orderedReasonCodes(stored.flatMap((record) => record.reason_codes)),
        publishable: overallDecision === 'approved',
      },
      deferred,
    };
  }

  /**
   * 发布闸门（**与筛查分开的第二步**）：逐任务重跑
   * `isModelLayerPublishable` + `evaluateModelReReview`（两者都消费同一份**输入绑定核验**），
   * 任一不通过 ⇒ 不得发布。**没有**"审核通过就自动发布"的路径。
   */
  async function publish(args: { actor: ModerationActor; content: ModerationContent }): Promise<PublishOutcome> {
    const actor = assertActor(args.actor);
    const content = normalizeContent(args.content);
    const target = content.target_ref;
    const reasons: string[] = [];
    const refuse = (code: ErrorCode): never => {
      throw new ApiError(code, '内容不得发布（审核/版本/证据闸门不通过）', {
        details: reasons.map((reason) => ({ field: 'reason_codes', code: reason })),
      });
    };

    const snapshot = await authority.read(target);
    if (snapshot !== null && snapshot.visibility === 'hidden' && actor.role !== 'admin') {
      reasons.push('TARGET_WITHDRAWN');
      return refuse('OBJECT_UNAVAILABLE');
    }
    if (snapshot !== null && snapshot.author_state !== 'active') {
      reasons.push(snapshot.author_state === 'inactive' ? 'ACCOUNT_INACTIVE' : 'AUTHOR_ANONYMIZED');
      return refuse('ACCOUNT_INACTIVE');
    }
    if (ledger.isWithdrawn(target)) {
      reasons.push('TARGET_WITHDRAWN');
      return refuse('OBJECT_UNAVAILABLE');
    }

    const mediaCount = content.media.length;
    const ruleVersion = currentRuleVersion();
    if (ruleVersion === null) {
      reasons.push('RULE_VERSION_UNKNOWN');
      return refuse('INPUT_UNCERTAIN');
    }
    const promptVersion = currentPromptVersion(mediaCount);
    if (promptVersion === null) {
      reasons.push('MODEL_PROMPT_VERSION_UNKNOWN');
      return refuse('INPUT_UNCERTAIN');
    }

    for (const kind of contentKindsFor(mediaCount)) {
      const task = ledger.current(target, kind);
      if (task === null) {
        reasons.push(`NOT_SCREENED:${kind}`);
        continue;
      }
      if (task.decision !== 'approved') {
        reasons.push(`DECISION_NOT_APPROVED:${kind}:${task.decision}`);
        reasons.push(...task.reason_codes);
        continue;
      }
      const modelVersion = currentModelVersion(kind) ?? task.model_version;
      if (modelVersion === null) {
        reasons.push(`MODEL_VERSION_UNKNOWN:${kind}`);
        continue;
      }
      const gate = isModelLayerPublishable(task.gate_holder, {
        rule_version: ruleVersion,
        model_version: modelVersion,
        prompt_version: promptVersion,
        input: content,
      });
      if (gate.publishable !== true) {
        reasons.push(...gate.reason_codes.map((code) => `${kind}:${code}`));
        continue;
      }
      const recheck = evaluateModelReReview(task.gate_holder, {
        rule_version: ruleVersion,
        model_version: modelVersion,
        prompt_version: promptVersion,
        target_ref: target,
        input: content,
      });
      if (recheck.stale === true || recheck.action !== 'reuse' || recheck.publishable !== true) {
        reasons.push(...recheck.reason_codes.map((code) => `${kind}:${code}`));
      }
    }

    if (reasons.some((reason) => reason.includes('DECISION_NOT_APPROVED') || reason.startsWith('NOT_SCREENED'))) {
      return refuse('INPUT_UNCERTAIN');
    }
    if (reasons.length > 0) return refuse('REVISION_CONFLICT');

    await authority.setVisibility(target, 'published');
    await authority.setPublishedRevision(target, target.revision);
    cache.set(target, {
      visibility: 'published',
      published_revision: target.revision,
      author_state: 'active',
      cached_at: nowIso(),
    });
    return {
      target_ref: target,
      published: true,
      visibility: 'published',
      published_revision: target.revision,
      reason_codes: [],
      cache_keys_invalidated: [],
    };
  }

  async function withdraw(args: { actor: ModerationActor; target_ref: TargetRef; reason_code: string }): Promise<WithdrawOutcome> {
    const actor = assertActor(args.actor);
    if (actor.role !== 'admin') {
      throw new ApiError('SCOPE_DENIED', '下架是管理员动作', { details: [{ field: 'role', code: 'SCOPE_DENIED' }] });
    }
    const target = assertTargetRef(args.target_ref);
    if (typeof args.reason_code !== 'string' || args.reason_code.length < 1 || args.reason_code.length > 80) {
      throw invalidRequest('reason_code 必须是 1..80 的字符串');
    }
    await authority.setVisibility(target, 'hidden');
    await authority.setPublishedRevision(target, null);
    ledger.markWithdrawn(target);
    const invalidated = cache.invalidateTarget(target);
    return {
      target_ref: target,
      visibility: 'hidden',
      withdrawn: true,
      invalidated_cache_keys: invalidated,
      event: { kind: 'moderation.takedown', target_ref: target, reason_code: args.reason_code, at: nowIso() },
    };
  }

  /**
   * 读取面重查：**每次都问权威**，缓存只用来发现"缓存与权威不一致"并把它清掉。
   */
  async function readView(args: { actor: ModerationActor | null; target_ref: TargetRef }): Promise<ReadViewOutcome> {
    const target = assertTargetRef(args.target_ref);
    const actor = args.actor ?? null;
    if (actor !== null) assertActor(actor);
    const snapshot = await authority.read(target);
    const published = await authority.publishedRevision(target);
    const cached = cache.get(target);
    const verdict = checkReadVisibility({
      actor,
      target,
      snapshot,
      published_revision: published,
      cache_entry: cached,
    });
    let invalidated: string[] = [];
    if (verdict.cache_entry_stale || (!verdict.visible && cached !== null)) {
      // 缓存与权威不一致（或内容已不可见）⇒ **立即失效整链**，而不是把脏条目留在缓存里。
      invalidated = cache.invalidateTarget(target);
    } else if (verdict.visible && snapshot !== null) {
      cache.set(target, {
        visibility: snapshot.visibility,
        published_revision: published,
        author_state: snapshot.author_state,
        cached_at: nowIso(),
      });
    }
    return {
      ...verdict,
      cache_keys_invalidated: [...new Set([...verdict.cache_keys_invalidated, ...invalidated])],
      target_ref: target,
    };
  }

  async function reReview(args: { actor: ModerationActor; target_ref: TargetRef; content?: ModerationContent }): Promise<ReReviewReport> {
    assertActor(args.actor);
    const target = assertTargetRef(args.target_ref);
    const content = args.content === undefined ? null : normalizeContent(args.content);
    const ruleVersion = currentRuleVersion();
    const reports: ReReviewReport['tasks'] = [];
    const allReasons: string[] = [];
    for (const task of ledger.forRevision(target)) {
      const mediaCount = task.evidence.media_count;
      const modelVersion = currentModelVersion(task.content_kind) ?? task.model_version;
      const promptVersion = currentPromptVersion(mediaCount);
      const outcome = evaluateModelReReview(task.gate_holder, {
        ...(ruleVersion === null ? {} : { rule_version: ruleVersion }),
        ...(modelVersion === null ? {} : { model_version: modelVersion }),
        ...(promptVersion === null ? {} : { prompt_version: promptVersion }),
        target_ref: target,
        ...(content === null ? {} : { input: content }),
      });
      reports.push({
        job_id: task.job_id,
        content_kind: task.content_kind,
        stale: outcome.stale === true,
        action: outcome.action,
        publishable: outcome.publishable === true,
        reason_codes: [...outcome.reason_codes],
      });
      allReasons.push(...outcome.reason_codes.map((code) => `${task.content_kind}:${code}`));
    }
    return {
      target_ref: target,
      rule_version_current: ruleVersion,
      tasks: reports,
      publishable: reports.length > 0 && reports.every((report) => report.publishable),
      reason_codes: [...new Set(allReasons)],
    };
  }

  /** `ingestCallback` 的契约错误码提示（传输层用；本片不注册路由）。 */
  function callbackErrorHint(reasonCode: string): string {
    if (reasonCode === 'CALLBACK_SIGNATURE_INVALID') return 'SCOPE_DENIED';
    if (reasonCode === 'CALLBACK_JOB_UNKNOWN') return 'NOT_FOUND';
    if (reasonCode === 'CALLBACK_REPLAY') return 'IDEMPOTENCY_CONFLICT';
    if (reasonCode === 'CALLBACK_JOB_TERMINAL' || reasonCode === 'CALLBACK_TARGET_WITHDRAWN') return 'OBJECT_UNAVAILABLE';
    if (reasonCode === 'CALLBACK_EPOCH_REVOKED') return 'ACCOUNT_INACTIVE';
    if (reasonCode.includes('_VERSION_STALE') || reasonCode === 'CALLBACK_JOB_REVISION_STALE' || reasonCode === 'CALLBACK_TARGET_REVISION_STALE' || reasonCode === 'CALLBACK_INPUT_DIGEST_MISMATCH') {
      return 'REVISION_CONFLICT';
    }
    return 'INVALID_REQUEST';
  }

  function callbackReject(reason_codes: string[], issues: string[] = []): CallbackOutcome {
    return {
      accepted: false,
      reason_codes,
      issues,
      task: null,
      contract_error_code: callbackErrorHint(reason_codes[0] ?? 'CALLBACK_PAYLOAD_INVALID'),
    };
  }

  async function ingestCallback(args: { raw_body: string; signature: string }): Promise<CallbackOutcome> {
    if (callbackKey === null) {
      // 无验签密钥 ⇒ **无法验签** ⇒ 一律拒绝（"配错密钥"不得退化成"接受"）。
      return callbackReject(['CALLBACK_SIGNATURE_INVALID'], ['服务端未配置回调验签密钥']);
    }
    if (typeof args.raw_body !== 'string' || !verifyCallbackSignature(args.raw_body, args.signature, callbackKey)) {
      return callbackReject(['CALLBACK_SIGNATURE_INVALID'], ['签名缺失或不匹配']);
    }
    const parsed = parseCallbackEnvelope(args.raw_body);
    if (!parsed.ok || parsed.envelope === null) return callbackReject(parsed.reason_codes, parsed.issues);
    const envelope = parsed.envelope;
    if (isCallbackExpired(envelope.issued_at, clock().getTime(), CALLBACK_MAX_SKEW_MS)) {
      return callbackReject(['CALLBACK_EXPIRED'], [`签发时间越出 ±${CALLBACK_MAX_SKEW_MS}ms 偏差`]);
    }
    if (replayGuard.seen(envelope.job_id, envelope.event_id)) {
      // **回放优先判定**：同一 `event_id` 已落定过 ⇒ 无论任务后来变成什么状态，都按"回放"拒绝
      // （比"终态"更精确地指出事故形态；两者都是拒绝）。
      return callbackReject(['CALLBACK_REPLAY'], ['同一 event_id 已落定过']);
    }
    const task = ledger.byJobId(envelope.job_id);
    if (task === null) return callbackReject(['CALLBACK_JOB_UNKNOWN'], ['job_id 不存在（未接线/未登记）']);
    if (isTerminalTaskState(task.state)) {
      return callbackReject(['CALLBACK_JOB_TERMINAL'], [`任务已终态（state=${task.state}）`]);
    }
    if (envelope.job_revision !== task.job_revision) {
      return callbackReject(
        ['CALLBACK_JOB_REVISION_STALE'],
        [`job_revision=${envelope.job_revision} 与当前 ${task.job_revision} 不一致`],
      );
    }
    if (envelope.lease_token !== task.lease_token) {
      return callbackReject(['CALLBACK_LEASE_MISMATCH'], ['lease_token 与当前租约不一致']);
    }
    if (
      envelope.target_ref.type !== task.target_ref.type ||
      envelope.target_ref.id !== task.target_ref.id ||
      envelope.target_ref.revision !== task.target_ref.revision
    ) {
      return callbackReject(['CALLBACK_TARGET_REVISION_STALE'], ['target_ref 与当前任务绑定不一致']);
    }
    if (envelope.content_kind !== task.content_kind) {
      return callbackReject(['CALLBACK_CONTENT_KIND_MISMATCH'], ['content_kind 与任务不一致']);
    }
    if (envelope.authorization_epoch !== task.authorization_epoch) {
      return callbackReject(['CALLBACK_EPOCH_REVOKED'], ['授权 epoch 已变化（撤回/注销）']);
    }
    if (ledger.isWithdrawn(task.target_ref)) {
      return callbackReject(['CALLBACK_TARGET_WITHDRAWN'], ['目标已下架，旧回调不得复活']);
    }
    if (envelope.input_digest !== task.evidence.input_binding_digest) {
      return callbackReject(['CALLBACK_INPUT_DIGEST_MISMATCH'], ['回调声明的输入摘要与本任务登记的不一致']);
    }
    const ruleVersion = currentRuleVersion();
    if (ruleVersion !== null && envelope.rule_version !== ruleVersion) {
      return callbackReject(['CALLBACK_RULE_VERSION_STALE'], ['rule_version 与当前规则集不一致']);
    }
    const promptVersion = currentPromptVersion(task.evidence.media_count);
    if (promptVersion !== null && envelope.prompt_version !== promptVersion) {
      return callbackReject(['CALLBACK_PROMPT_VERSION_STALE'], ['prompt_version 与当前模板集不一致']);
    }
    const modelVersion = currentModelVersion(task.content_kind);
    if (modelVersion !== null && envelope.model_version !== modelVersion) {
      return callbackReject(['CALLBACK_MODEL_VERSION_STALE'], ['model_version 与当前端口声明不一致']);
    }

    // ---- 接受：只落定"该版本级任务"的筛查结论；**绝不**发布 ----
    const label = envelope.verdict.label;
    let decision: AuditState;
    let state: JobState = 'succeeded';
    let errorCode: string | null = null;
    let reasons: string[];
    let modelCodes: string[];
    if (label === 'block') {
      decision = 'rejected';
      modelCodes = ['MODEL_BLOCKED'];
      reasons = ['model_blocked'];
    } else if (label === 'unsure') {
      decision = 'quarantined';
      state = 'uncertain';
      errorCode = 'PROVIDER_OUTCOME_UNKNOWN';
      modelCodes = ['MODEL_NOT_EVALUATED'];
      reasons = ['model_no_conclusion'];
    } else if (task.hard_rule_passed !== true) {
      // 规则层没通过时，模型 pass 也**不得**把结论抬成通过（与合流层同向）。
      decision = 'quarantined';
      state = 'uncertain';
      errorCode = 'INPUT_UNCERTAIN';
      modelCodes = [];
      reasons = ['rule_not_passed'];
    } else {
      decision = 'approved';
      modelCodes = [];
      reasons = ['rule_and_model_pass'];
    }

    const portKind = PORT_KIND_BY_CONTENT_KIND[task.content_kind];
    const kindEntries = task.evidence.model_kinds.map((entry) => ({ ...entry, reason_codes: [...entry.reason_codes] }));
    const existingIndex = kindEntries.findIndex((entry) => entry.kind === portKind);
    const newEntry = {
      kind: portKind,
      status: label === 'pass' ? ('pass' as const) : label === 'block' ? ('blocked' as const) : ('failed' as const),
      label,
      reason_codes: [...modelCodes],
      reported: null,
      synthetic: false,
    };
    if (existingIndex >= 0) kindEntries[existingIndex] = newEntry;
    else kindEntries.push(newEntry);

    const reasonCodes = orderedReasonCodes([...task.evidence.rule_reason_codes, ...modelCodes]);
    const updated: ModerationTaskRecord = {
      ...task,
      job_revision: task.job_revision + 1,
      state,
      decision,
      reason_codes: reasonCodes,
      error_code: errorCode,
      model_version: envelope.model_version,
      prompt_version: envelope.prompt_version,
      rule_version: ruleVersion ?? task.rule_version,
      evidence: {
        ...task.evidence,
        input_binding_verified: true,
        input_binding_digest: envelope.input_digest,
        model_reason_codes: modelCodes,
        model_kinds: kindEntries,
        reasons,
        provider: {
          kind: portKind,
          model_version: envelope.model_version,
          biz_type: null,
          synthetic: false,
          origin: 'callback',
        },
      },
      updated_at: nowIso(),
    };
    updated.contract_value = buildContractModeration({
      job_id: updated.job_id,
      target_ref: updated.target_ref,
      decision: updated.decision,
      reason_codes: updated.reason_codes,
      hard_rule_passed: updated.hard_rule_passed,
      model_version: updated.model_version,
      prompt_version: updated.prompt_version,
      rule_version: updated.rule_version,
    });
    updated.gate_holder = {
      target_ref: updated.target_ref,
      decision: updated.decision,
      reason_codes: updated.reason_codes,
      hard_rule_passed: updated.hard_rule_passed,
      rule_version: updated.rule_version,
      model_version: updated.model_version,
      prompt_version: updated.prompt_version,
      input_binding: {
        schema: 'mib1',
        digest: envelope.input_digest,
        media_count: updated.evidence.media_count,
        text_length: updated.evidence.text_length,
        verified: true,
      },
      model_layer: {
        status: 'attempted',
        kinds: Object.fromEntries(kindEntries.map((entry) => [entry.kind, entry])),
        reason_codes: [...modelCodes],
        synthetic_ports: [],
      },
    };
    ledger.update(updated);
    replayGuard.markSettled(envelope.job_id, envelope.event_id);
    return {
      accepted: true,
      reason_codes: [],
      issues: [],
      task: taskView(updated),
      contract_error_code: null,
    };
  }

  return {
    execution_mode: executionMode,
    currentRuleVersion,
    submitScreening: async (input) => screen({ actor: input.actor, content: input.content, deferModel: input.defer_model === true }),
    runModelScreening: async (input) => screen({ actor: input.actor, content: input.content, deferModel: false }),
    publish,
    withdraw,
    readView,
    reReview,
    ingestCallback,
    tasks: (target_ref) => ledger.forRevision(target_ref).map(taskView),
    taskByJobId: (jobId) => {
      const record = ledger.byJobId(jobId);
      return record === null ? null : taskView(record);
    },
    humanReview: () => humanReviewQueue(),
    counts: () => ({
      ...ledger.snapshotCounts(),
      cache_entries: cache.size(),
      callbacks_settled: replayGuard.settledCount(),
      substitutes: [...resolved.substitutes],
      authority_origin: authority.origin,
      callback_key_configured: callbackKey !== null,
    }),
  };
}
