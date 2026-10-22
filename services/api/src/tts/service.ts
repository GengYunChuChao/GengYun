/**
 * GY-I13 普通话 TTS 合成服务：受理、执行、修订绑定与失效判定（**只做服务层**）。
 *
 * 契约对齐（packages/contracts/openapi.json，未新增字段、未自造端点）：
 *   POST /speech/synthesis   createSynthesis → 202 JobEnvelope
 *   POST /jobs/{id}/cancel   cancelJob       → 200 JobEnvelope（GY-R27 接线；共享作业面在 `jobs/` 层）
 *
 * 契约里 `POST /speech/synthesis` **只有 POST**：没有 `GET /speech/synthesis/{id}`，
 * 也没有 DELETE。因此本文件**不提供任何 HTTP 读/删端点**，只提供服务层入口
 * （`createSynthesis` 对应 202 受理；`inspectJob` / `verifyUsable` 是**服务层诊断与重算口径**，
 * 不是契约端点——见下方「契约缺口」；`cancelJob` 是共享作业面 `POST /jobs/{id}/cancel` 的域内实现）。
 *
 * 本阶段**不注册任何 HTTP 路由**（组装点 `services/api/src/app.ts` 与路由目录
 * `services/api/src/routes` 被 #9 / #10 / #11 占用，禁止触碰）；本文件也不 import 它们的任何内容。
 *
 * fail-closed 要点（派单 §2，逐条都有独立用例）：
 * - **只播报已核对内容**：`checked_content_ref.type` 限定在契约 `SynthesisTarget` 的 6 值闭集内
 *   （state.ts），社区帖/评论/会话/转写原文等一律 `INVALID_REQUEST`；
 * - **未通过核对一律拒绝**：受理前读核对快照并判定，`pending` / `rejected` / `quarantined` /
 *   取不到核对状态（端口抛错或未知状态值）一律拒绝，**绝不「照文本念」**；逐分支错误码与理由见
 *   `state.ts` 的 `decideCheckedContent` 表；
 * - **修订绑定**：受理时的 revision 与内容当前 revision 必须一致（否则 `REVISION_CONFLICT`）；
 *   执行期**重读**内容并再次判定，**实际用于合成的正文来自执行期重读**，
 *   因此「受理后内容被修订」只会让任务落 `failed` + 契约错误码，**不会**产出绑错版本的音频、
 *   也**不会**把新 revision 静默回填进旧任务；
 * - **不接受自由文本**：`SynthesisInput` 只有两字段，多余字段（含客户端自带 `text`/`script`/`openid`）
 *   一律 `INVALID_REQUEST`；`locale` 非 `zh-CN` ⇒ `INVALID_REQUEST`；
 * - **提供者失败不得写成功**：`real` 缺凭据 ⇒ **受理前** 503 `PROVIDER_UNAVAILABLE`，不排队、
 *   不回退替身；产物无处安放（媒体端口未接线）⇒ **受理前** 409 `OBJECT_UNAVAILABLE`；
 *   超时 → `timed_out` + `PROVIDER_TIMEOUT`；配额 → `failed` + `PROVIDER_QUOTA_EXCEEDED`；
 *   结果未知/协议违规/替身伪装成真实音频 → `failed` + `PROVIDER_OUTCOME_UNKNOWN`；
 *   落库失败 → `failed` + `OBJECT_UNAVAILABLE`；**任何异常路径都不得变成 `succeeded`**；
 *   真实适配器（`createLiveTtsProvider`，只能经注入式端口构造、应用装配路径不可达）额外带来一类
 *   **本地入参拒绝**：供应商侧文本上限超限 ⇒ 适配器在**预留与发包之前**抛 `TtsLocalInputError`
 *   （**不截断**），本层如实落 `failed` + `INVALID_REQUEST`（未发包、不占预算）；
 * - **幂等并发（#9 的 P1 教训）**：写路径**先原子占位、再建任务**。同主体同键同体并发 ⇒
 *   **恰好 1 个任务、恰好 1 次提供者调用**，落败者等待占位者落定后**收敛到同一任务**；
 *   同键异体 ⇒ `IDEMPOTENCY_CONFLICT` 且不产生第二个任务；占位者失败 ⇒ **释放占位**；
 * - **越权与不存在同形** `NOT_FOUND`（不泄露存在性）；
 * - **取消（GY-R27）**：`queued` / `running` ⇒ `cancelled`，`revision` **恰好 +1**（单次 CAS）；
 *   迁移合法性只问 `state.ts` 的 `canTransitionJob`（**不另写第二套状态机**，不新增迁移边）；
 *   终态（`succeeded`/`uncertain`/`failed`/`timed_out`/`cancelled`）再取消 ⇒ 409 `OBJECT_UNAVAILABLE`
 *   （**不是** 503 "能力未接线"）；取消**不产出合成记录**、清空 `error_code`；取消后迟到的提供者
 *   结果被 `commitTerminal` 的 revision CAS 拦下 ⇒ **不复活**作业（不靠删记录）；
 * - **超时必须在读面显式化**：任务超过 `deadline_at + JOB_EXPIRY_GRACE_MS` 仍未落终态
 *   （执行器缺失、进程重启、store 写异常……）⇒ 读面用 CAS 落 `timed_out` +
 *   `PROVIDER_TIMEOUT`，**绝不**让读面永远回报 `queued` / `running`；
 *   宽限用于把「截止前已完成、只是提交晚了几毫秒」的竞态让给执行器（两者都只写 `timed_out`）；
 * - **模式交叉不撒谎**：任务行记录**受理时的执行模式**；当前装配与记录的执行模式不一致 ⇒
 *   503 `PROVIDER_UNAVAILABLE`（`retryable:false`），**绝不**把 `stub` 受理的任务当成
 *   `real` 装配下的成功作业读出来（那会让替身产物冒充真实合成结果）；
 * - **产出媒体**：`Synthesis.media_id` 指向替身标注产物或未接线存储的结果，
 *   **不接真实对象存储**、**不产生任何音频字节**（见 media.ts / provider.ts）。
 *
 * **契约缺口（如实记录，不新增契约字段、不自造端点）**：
 * - 契约只有 `POST /speech/synthesis`，**没有**对应的读端点，因此
 *   `Synthesis` 的过期口径无法通过契约端点表达。本实现把它做成服务层可判定的重算：
 *   `verifyUsable({userId, synthesisId})` 用与受理/执行相同的判定函数重算「核对状态仍为 approved
 *   + 内容当前 revision 仍等于绑定的 revision + 产物仍在」，并给出契约闭集内的错误码。
 *   阶段 2 的播放路径（客户端）应消费该口径，而不是相信客户端缓存的 audio 或旧 revision。
 * - 契约**没有**规定 `JobState` 与 `ErrorCode` 的对应关系，也没有规定「同键同体并发」落败者该收到什么。
 *   本实现的映射见 `stateForProviderFailure` 与 `execute`；并发落败者优先**收敛**，
 *   仅在等待预算内仍未落定时才回契约内的 `REQUEST_IN_PROGRESS`（仍不重复执行副作用）。
 * - 契约**没有**规定可合成文本的长度上限。本层**不发明**上限、**不截断**：提供者的分段/限额
 *   属真实适配器职责，截断会把「未核对/不完整内容」读出来。
 * - 契约的 202 响应带 `ETag` / `Cache-Control` 头，本层只给出**状态语义 202**；
 *   头部的实际写入属阶段 2 的路由接线。
 */
import { randomUUID } from 'node:crypto';
import {
  IDEMPOTENCY_TTL_SECONDS,
  idempotencyKeyHashHex,
  idempotencyRequestHash,
  idempotencyScope,
} from '../auth/idempotency.ts';
import { API_PREFIX, type ErrorCode } from '../contract.ts';
import { ApiError } from '../errors.ts';
import type { CheckedContentPort } from './content.ts';
import { TtsLocalInputError } from './live-ports.ts';
import type { SynthesisMediaPort } from './media.ts';
import type { ProviderFailureCode, TtsProvider } from './provider.ts';
import {
  SynthesisArtifactError,
  TtsProtocolError,
  canTransitionJob,
  decideCheckedContent,
  isSynthesisTargetType,
  isTerminalJobState,
  normalizeSynthesisInput,
  requireSynthesisArtifact,
  stateForProviderFailure,
  type CheckedContentDecision,
  type CheckedContentRefusalReason,
  type CheckedContentSnapshot,
  type JobState,
  type SynthesisJobProjection,
  type SynthesisProjection,
  type SynthesisTargetRef,
} from './state.ts';
import type { SynthesisJobRow, SynthesisRow, SynthesisStore } from './store.ts';

/** 契约 `POST /speech/synthesis` 的受理状态（服务层直接给出状态语义，阶段 2 路由透传）。 */
export const SYNTHESIS_ACCEPTED_STATUS = 202;
/** 任务截止时间（毫秒）：超过即 `timed_out`，且迟到结果不复活任务。 */
export const DEFAULT_JOB_DEADLINE_MS = 30 * 1000;
/**
 * 读面「超时裁定」的宽限（毫秒）。
 *
 * 执行器自己的 deadline 竞速在 `deadline_at` 到点时就该落终态；只有当执行器**没能**落终态
 * （进程重启、store 抛错、任务卡在 `queued`/`running`）时，读面才是唯一的裁定者。
 * 因此读面留一小段宽限，避免把「截止前已完成、只是提交晚了几毫秒」的成功任务误判成
 * `timed_out`：成功与超时谁先提交由 store 的 CAS 决定，宽限把这条竞态窗口让给执行器。
 */
export const JOB_EXPIRY_GRACE_MS = 5 * 1000;
/** 幂等键长度口径与认证层一致（8..128）。 */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
/**
 * 同键并发时未占位方的等待预算（毫秒）：在预算内等待占位者落定并**收敛**同一任务，
 * 超时才回 `REQUEST_IN_PROGRESS`。等待用真实墙钟（`Date.now()`）而不是注入的 `now()`，
 * 避免测试注入停表时钟时等待循环不退出。
 */
export const DEFAULT_IDEMPOTENCY_WAIT_MS = 3 * 1000;
/** 占位轮询间隔（毫秒）。 */
export const IDEMPOTENCY_POLL_MS = 2;
/** 占位尝试次数：占位者失败释放占位后，本请求最多再尝试一次（不无限重试）。 */
export const CLAIM_ATTEMPTS = 2;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 契约 `If-Match` 口径（强 ETag = `"<正整数 revision>"`，不允许 `*`）：与识别/OCR/转写域逐字一致。 */
const IF_MATCH_PATTERN = /^"[1-9][0-9]*"$/;

/** 失效判定的原因 = 核对判定原因 + 产物缺失。 */
export type SynthesisUsabilityReason = CheckedContentRefusalReason | 'MEDIA_MISSING';

export type SynthesisUsability =
  | {
      usable: true;
      media_id: string;
      checked_content_ref: SynthesisTargetRef;
      /** true = 指向替身标注产物（**非真实音频**），调用方不得当作真实音频播放。 */
      substitute: boolean;
    }
  | { usable: false; code: ErrorCode; reason: SynthesisUsabilityReason; message: string };

export interface SynthesisServiceOptions {
  store: SynthesisStore;
  provider: TtsProvider;
  media: SynthesisMediaPort;
  /** 已核对内容读取端口（只读；未接线时读一律抛错 ⇒ 一律拒绝）。 */
  content: CheckedContentPort;
  /** 幂等请求摘要密钥（服务端密钥，不入库、不下发）。 */
  idempotencyHmacKey: string;
  now?: () => Date;
  idFactory?: () => string;
  jobDeadlineMs?: number;
  /** 同键并发等待预算；测试可调小以免拖慢回归。 */
  idempotencyWaitMs?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidRequest(message: string, field?: string): ApiError {
  return new ApiError('INVALID_REQUEST', message, field === undefined ? {} : { details: [{ field, code: 'invalid' }] });
}

/** 把域内协议错误统一映射为契约 400 INVALID_REQUEST；字段名按契约 `SynthesisInput` 的取值。 */
function asInvalidRequest(error: TtsProtocolError): ApiError {
  const message = error.message;
  const field = message.startsWith('checked_content_ref')
    ? '/checked_content_ref'
    : message.includes('locale')
      ? '/locale'
      : message.includes('未定义字段')
        ? '/'
        : '/checked_content_ref';
  return invalidRequest(message, field);
}

export function requireIdempotencyKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length < IDEMPOTENCY_KEY_MIN_LENGTH ||
    value.length > IDEMPOTENCY_KEY_MAX_LENGTH
  ) {
    throw new ApiError(
      'IDEMPOTENCY_KEY_REQUIRED',
      `缺少或非法的 Idempotency-Key 头（${IDEMPOTENCY_KEY_MIN_LENGTH}..${IDEMPOTENCY_KEY_MAX_LENGTH} 字符）`,
    );
  }
  return value;
}

/**
 * 契约 `If-Match` 口径（**缺失 428 / 格式非法 400**；不匹配由调用方判 409）：
 * 与识别域、OCR 域、转写域（PR #321）**逐字同一口径**，不在此发明新分支。
 */
export function requireIfMatch(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    throw new ApiError('REVISION_REQUIRED', '缺少 If-Match 版本头');
  }
  if (typeof value !== 'string' || !IF_MATCH_PATTERN.test(value)) {
    throw new ApiError('INVALID_REQUEST', 'If-Match 版本格式非法（应为 "正整数"）');
  }
  const revision = Number(value.slice(1, -1));
  if (!Number.isSafeInteger(revision) || revision < 1) throw new ApiError('INVALID_REQUEST', 'If-Match 版本非法');
  return revision;
}

/** 拒绝判定 → 契约错误封套（错误码取自契约闭集，`details.code` 带上可单独指出的原因）。 */
function refusalToApiError(decision: Extract<ReturnType<typeof decideCheckedContent>, { ok: false }>): ApiError {
  if (decision.code === 'NOT_FOUND') {
    // **越权与不存在必须完全同形**：内容不存在（TARGET_NOT_FOUND）与非本人（TARGET_FOREIGN_OWNER）
    // 若把内部原因写进 message / details，攻击者据此即可区分「存在但非我」与「不存在」。
    // 因此对外只给同一句话与空 details；内部原因仅供服务端日志与回归断言使用。
    return new ApiError('NOT_FOUND', '已核对目标不存在或不可见');
  }
  return new ApiError(decision.code, `${decision.message}（${decision.reason}）`, {
    details: [{ field: '/checked_content_ref', code: decision.reason }],
  });
}

export function toSynthesis(row: SynthesisRow): SynthesisProjection {
  // 四字段全必填，additionalProperties:false：替身标注等内部信息**不进**投影。
  return {
    id: row.id,
    revision: row.revision,
    checked_content_ref: { ...row.checkedContentRef },
    media_id: row.mediaId,
  };
}

export function toJob(row: SynthesisJobRow, synthesis: SynthesisRow | null): SynthesisJobProjection {
  const usable = synthesis !== null && row.state === 'succeeded';
  return {
    id: row.id,
    revision: row.revision,
    kind: 'synthesis',
    // 结果的 target_ref 与结果里的 checked_content_ref 必须一致（同一已核对目标与 revision）。
    target_ref: { ...row.checkedContentRef },
    state: row.state,
    deadline_at: row.deadlineAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    error_code: row.errorCode,
    result: usable ? { kind: 'synthesis', value: toSynthesis(synthesis) } : null,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createSynthesisService(options: SynthesisServiceOptions) {
  const store = options.store;
  const provider = options.provider;
  const media = options.media;
  const content = options.content;
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => randomUUID());
  const jobDeadlineMs = options.jobDeadlineMs ?? DEFAULT_JOB_DEADLINE_MS;
  const idempotencyWaitMs = options.idempotencyWaitMs ?? DEFAULT_IDEMPOTENCY_WAIT_MS;
  const idempotencyHmacKey = options.idempotencyHmacKey;
  const inFlight = new Set<Promise<void>>();

  const routePath = `${API_PREFIX}/speech/synthesis`;

  /**
   * 读核对快照并判定。**任何**读取失败（未接线／查询异常／超时）一律按
   * 「取不到核对状态」fail-closed 处理：409 `OBJECT_UNAVAILABLE`，
   * **绝不**当作 approved，也**绝不**退回 404 假装内容不存在。
   */
  async function readAndDecide(
    requested: SynthesisTargetRef,
    callerUserId: string,
    where: 'accept' | 'execute' | 'verify',
  ): Promise<CheckedContentDecision> {
    let snapshot: CheckedContentSnapshot | null = null;
    try {
      snapshot = await content.read({ type: requested.type, id: requested.id });
    } catch {
      return {
        ok: false,
        code: 'OBJECT_UNAVAILABLE',
        reason: 'AUDIT_STATE_UNREADABLE',
        message: `取不到该内容的核对状态（${where}），按未通过核对拒绝`,
      };
    }
    return decideCheckedContent({ requested, callerUserId, snapshot });
  }

  /**
   * 幂等占位结果：
   * - `claimed`：本次请求占位成功，**是唯一有权执行副作用的调用方**；
   * - `existing`：同键请求已存在（可能仍在处理中），调用方**不得**再执行任何副作用。
   */
  type ClaimOutcome =
    | { kind: 'claimed' }
    | { kind: 'existing'; payload: Record<string, unknown>; pending: boolean };

  /** 等待同键占位者的结果。 */
  type ClaimResolution =
    | { kind: 'settled'; payload: Record<string, unknown> }
    | { kind: 'released' }
    | { kind: 'timeout' };

  /**
   * **原子占位**（先占位、再建任务）：消除 check-then-act 竞态。
   *
   * 若写成「先 find 判空 → 再 insert」，同键并发时两个调用方都会看到空台账，
   * 于是建出 2 个任务、触发 2 次提供者调用（正是监工对 #9 判 P1 的形态）。
   * 现在由 store.claimIdempotent 在同一同步临界区内「检查 + 写入」，只有一个调用方拿到 `claimed`。
   */
  async function claimIdempotentScope(
    scope: string,
    key: string,
    requestHash: string,
    placeholder: Record<string, unknown>,
    at: Date,
  ): Promise<ClaimOutcome> {
    await store.purgeIdempotent(at);
    const keyHashHex = idempotencyKeyHashHex(scope, key);
    const claim = await store.claimIdempotent(
      scope,
      keyHashHex,
      {
        requestHash,
        // 占位阶段即写入结果引用（job_id 在占位前生成），
        // 因此同键请求无需重复执行副作用即可定位到同一个任务。
        payload: placeholder,
        pending: true,
        expiresAt: new Date(at.getTime() + IDEMPOTENCY_TTL_SECONDS * 1000),
      },
      at,
    );
    if (claim === 'claimed') return { kind: 'claimed' };
    const row = await store.findIdempotent(scope, keyHashHex);
    if (row === null) {
      // 占位后被清理等极端情形：**不回 claimed**（那会重复执行副作用），如实让客户端稍后重试。
      return { kind: 'existing', payload: {}, pending: true };
    }
    if (row.requestHash !== requestHash) {
      throw new ApiError('IDEMPOTENCY_CONFLICT', '同一 Idempotency-Key 已被不同请求体使用');
    }
    return { kind: 'existing', payload: row.payload, pending: row.pending };
  }

  /**
   * 等待占位者落定（同键同体并发必须**收敛**）：
   * - 条目消失 ⇒ 占位者已释放占位（业务失败）⇒ 调用方可重新占位重试；
   * - `pending=false` ⇒ 占位者已完成，回放其结果引用；
   * - 超出等待预算（真实墙钟，且轮询次数有上限）⇒ `timeout`，由调用方回契约内的
   *   `REQUEST_IN_PROGRESS`：**绝不**因等待超时而重复执行副作用。
   */
  async function awaitPlaceholder(scope: string, keyHashHex: string, budgetMs: number): Promise<ClaimResolution> {
    const wallDeadline = Date.now() + budgetMs;
    const maxPolls = Math.ceil(budgetMs / IDEMPOTENCY_POLL_MS) + 2;
    for (let poll = 0; poll < maxPolls; poll += 1) {
      const row = await store.findIdempotent(scope, keyHashHex);
      if (row === null) return { kind: 'released' };
      if (!row.pending) return { kind: 'settled', payload: row.payload };
      if (Date.now() >= wallDeadline) return { kind: 'timeout' };
      await delay(IDEMPOTENCY_POLL_MS);
    }
    return { kind: 'timeout' };
  }

  async function finalizeIdempotentScope(scope: string, key: string, payload: Record<string, unknown>): Promise<void> {
    await store.finalizeIdempotent(scope, idempotencyKeyHashHex(scope, key), payload);
  }

  /** 占位者业务失败时释放占位，避免同一 Idempotency-Key 的正常重试被永久判成处理中。 */
  async function releaseIdempotentScope(scope: string, key: string): Promise<void> {
    await store.releaseIdempotent(scope, idempotencyKeyHashHex(scope, key));
  }

  /** 同键请求仍在处理中且等待预算已用尽：契约内如实回报，绝不重复执行副作用。 */
  function inProgress(): ApiError {
    // `retryable: true`：等待预算用尽**只是"还没好"**，同一请求原样重试仍可能拿到已完成的结果（不重复执行副作用）；
    // 且 HTTP 出口对 `REQUEST_IN_PROGRESS` 已发 `Retry-After: 1`（`services/api/src/app.ts:1837`）并声明
    // "等待后可重试原请求" ⇒ 必须可重试，否则与响应头自相矛盾。同族其它 13 处 `REQUEST_IN_PROGRESS` 均已为 true。
    return new ApiError('REQUEST_IN_PROGRESS', '同一 Idempotency-Key 的请求正在处理中', { retryable: true });
  }

  async function getOwnedJob(userId: string, jobId: string): Promise<SynthesisJobRow> {
    if (typeof jobId !== 'string' || !UUID_PATTERN.test(jobId)) throw new ApiError('NOT_FOUND', '任务不存在');
    const row = await store.getJob(jobId);
    if (row === null || row.ownerUserId !== userId) throw new ApiError('NOT_FOUND', '任务不存在');
    return row;
  }

  async function getOwnedSynthesis(userId: string, synthesisId: string): Promise<SynthesisRow> {
    if (typeof synthesisId !== 'string' || !UUID_PATTERN.test(synthesisId)) throw new ApiError('NOT_FOUND', '合成记录不存在');
    const row = await store.getSynthesis(synthesisId);
    // 越权与不存在同形：不泄露存在性。
    if (row === null || row.ownerUserId !== userId) throw new ApiError('NOT_FOUND', '合成记录不存在');
    return row;
  }

  /**
   * 模式交叉不撒谎：任务行记录了**受理时的执行模式**，当前装配必须与之一致才解释其状态。
   *
   * 为什么不「直接读出」：`media_id` 属于**受理方模式**的产物（`stub` 下是替身标注产物，
   * 不是音频、不可播放）。若 `real` 装配把 `stub` 受理的任务读成 `succeeded` + `result`，
   * 客户端就会把替身产物当成真实合成结果 —— 这正是「模式交叉撒谎」的形态。
   * 因此宁可 503 如实说「当前装配解释不了这个任务」，也不给出一个看似成功的投影。
   * `retryable:false`：不是瞬时故障，同一装配重试不会变好（需换回对应模式或重新受理）。
   */
  function assertJobMode(row: SynthesisJobRow): void {
    if (row.executionMode === provider.executionMode) return;
    throw new ApiError(
      'PROVIDER_UNAVAILABLE',
      `该任务由 ${String(row.executionMode)} 模式受理，当前装配为 ${provider.executionMode} 模式，无法解释其状态`,
      { retryable: false },
    );
  }

  /**
   * 读面超时裁定（口径见 `JOB_EXPIRY_GRACE_MS` 的注释）。
   *
   * - 只处理非终态；终态任务原样返回（**不会**把 `succeeded` / `failed` 改成 `timed_out`）；
   * - 用 CAS（期望 revision = 刚读到的 revision）：执行器若已提交终态，CAS 失败 ⇒ 以 store 最新为准；
   * - 只写任务状态与错误码，**不写合成记录**：超时没有产物，绝不凭空给 `media_id`。
   */
  async function adjudicateExpiredJob(row: SynthesisJobRow): Promise<SynthesisJobRow> {
    if (row.state !== 'queued' && row.state !== 'running') return row;
    const at = now();
    if (at.getTime() < row.deadlineAt.getTime() + JOB_EXPIRY_GRACE_MS) return row;
    const settled = await store.commitTerminal(
      row.id,
      row.revision,
      { state: 'timed_out', errorCode: 'PROVIDER_TIMEOUT' },
      null,
      at,
    );
    if (settled !== null) return settled;
    // CAS 失败（并发已落终态）：以 store 里的最新记录为准，不覆盖、不重试。
    return (await store.getJob(row.id)) ?? row;
  }

  /**
   * 受理合成任务：202 语义 + Job（state=queued），随后异步执行。
   *
   * 顺序是刻意的（每一步都在受理前完成 fail-closed 判定）：
   *   ① body 形状/闭集/locale 校验（契约 additionalProperties:false）
   *   ② Idempotency-Key 校验
   *   ③ 提供者可用性（real 缺凭据 ⇒ 503，**不排队、不回退替身**）
   *   ④ 产物存储可用性（未接线 ⇒ 409，**不产生「受理了必然失败」的任务**）
   *   ⑤ 读核对快照并判定（未核对/取不到核对状态/修订不一致 ⇒ 拒绝）
   *   ⑥ 原子占位 → 落任务 → 落定占位 → 异步执行
   */
  async function createSynthesis(input: {
    userId: string;
    body: unknown;
    idempotencyKey: unknown;
  }): Promise<{ status: typeof SYNTHESIS_ACCEPTED_STATUS; job: SynthesisJobProjection; replayed: boolean }> {
    let parsed: { checked_content_ref: SynthesisTargetRef; locale: string };
    try {
      parsed = normalizeSynthesisInput(input.body);
    } catch (error) {
      if (error instanceof TtsProtocolError) throw asInvalidRequest(error);
      throw error;
    }
    const key = requireIdempotencyKey(input.idempotencyKey);
    const requested = parsed.checked_content_ref;

    // real 缺凭据/无已审适配器：受理前 fail-closed，不排队、不回退替身。
    // `retryable: false`：这是"能力未装配／未接线"（需运维改配置），不是瞬时故障 —— 同一请求原样重试不会成功。
    // 口径原文见 `services/api/src/errors.ts` 的 `ApiError` 上方注释。
    if (!provider.available) {
      throw new ApiError('PROVIDER_UNAVAILABLE', provider.unavailableReason ?? 'TTS 提供者不可用', {
        retryable: false,
      });
    }
    if (media.kind === 'unwired') {
      // 产物无处安放：受理一个必然失败的任务没有意义，且会让「已核对」这件事被无谓地暴露。
      throw new ApiError('OBJECT_UNAVAILABLE', '合成产物存储未接线，无法受理');
    }

    const decision = await readAndDecide(requested, input.userId, 'accept');
    if (!decision.ok) throw refusalToApiError(decision);

    const at = now();
    const scope = idempotencyScope(input.userId, 'POST', routePath);
    const requestHash = idempotencyRequestHash(parsed, undefined, idempotencyHmacKey);

    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      // 任务 id 与记录 id 在占位前生成：占位记录本身就是「这个键对应这个任务」的原子凭据。
      const jobId = idFactory();
      const synthesisId = idFactory();
      const claim = await claimIdempotentScope(scope, key, requestHash, { job_id: jobId }, at);
      if (claim.kind === 'claimed') {
        const row: SynthesisJobRow = {
          id: jobId,
          revision: 1,
          kind: 'synthesis',
          ownerUserId: input.userId,
          // 记录受理时的执行模式：读面据此判断「当前装配能否解释这个任务」（模式交叉不得撒谎）。
          executionMode: provider.executionMode,
          synthesisId,
          checkedContentRef: { ...requested },
          locale: parsed.locale,
          state: 'queued',
          deadlineAt: new Date(at.getTime() + jobDeadlineMs),
          createdAt: at,
          updatedAt: at,
          errorCode: null,
        };
        try {
          await store.insertJob(row);
        } catch (error) {
          // 落库失败：释放占位，否则同键重试会被永久判成处理中。
          await releaseIdempotentScope(scope, key);
          throw error;
        }
        await finalizeIdempotentScope(scope, key, { job_id: jobId });
        track(execute(jobId));
        return { status: SYNTHESIS_ACCEPTED_STATUS, job: toJob(row, null), replayed: false };
      }

      // 同键重复请求：绝不新建任务、绝不重复调用提供者；等占位者落定后**收敛**同一响应。
      const resolution = await awaitPlaceholder(scope, idempotencyKeyHashHex(scope, key), idempotencyWaitMs);
      if (resolution.kind === 'released') continue;
      if (resolution.kind === 'settled') {
        const reservedJobId = resolution.payload['job_id'];
        if (typeof reservedJobId === 'string') {
          const existing = await store.getJob(reservedJobId);
          if (existing !== null && existing.ownerUserId === input.userId) {
            // 重放同样不得跨模式撒谎，也不得把一个早已过期的任务永远回报成 `queued`。
            assertJobMode(existing);
            const settled = await adjudicateExpiredJob(existing);
            const synthesis = settled.state === 'succeeded' ? await store.getSynthesis(settled.synthesisId) : null;
            return { status: SYNTHESIS_ACCEPTED_STATUS, job: toJob(settled, synthesis), replayed: true };
          }
        }
      }
      throw inProgress();
    }
    throw inProgress();
  }

  function track(promise: Promise<void>): void {
    inFlight.add(promise);
    promise
      .catch(() => {
        // execute 内部已把失败写成 failed；这里只保证不产生未处理拒绝。
      })
      .finally(() => {
        inFlight.delete(promise);
      });
  }

  /** 等所有在途执行落定（测试用，不改变生产顺序）。 */
  async function settle(): Promise<void> {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
  }

  /** 执行一次合成：queued → running → 终态。任何异常都不得变成 succeeded。 */
  async function execute(jobId: string): Promise<void> {
    const queued = await store.getJob(jobId);
    if (queued === null || queued.state !== 'queued') return;
    const at = now();
    const running = await store.updateJob(jobId, queued.revision, (row) => ({
      ...row,
      state: 'running',
      revision: row.revision + 1,
      updatedAt: at,
    }));
    if (running === null) return;

    // **执行期重读并重新判定**：实际朗读的正文只能来自这里，且必须仍是 approved 且
    // revision 与受理时一致；否则一律 failed（不会绑错版本、不会回填新 revision）。
    const decision = await readAndDecide(running.checkedContentRef, running.ownerUserId, 'execute');
    if (!decision.ok) {
      await commitTerminal(jobId, running, { state: 'failed', errorCode: decision.code }, null);
      return;
    }

    const outcome = await runProviderWithDeadline(running, decision.text);
    if (outcome.kind === 'timeout') {
      await commitTerminal(jobId, running, { state: 'timed_out', errorCode: 'PROVIDER_TIMEOUT' }, null);
      return;
    }
    if (outcome.kind === 'threw') {
      // 本地入参拒绝（如真实适配器的文本上限，**未发包、不占预算**）按契约入参错误码如实落账；
      // 其余抛出（提供者内部异常）一律「结果不可判定」，绝不落 succeeded。
      const code = outcome.error instanceof TtsLocalInputError ? outcome.error.code : 'PROVIDER_OUTCOME_UNKNOWN';
      await commitTerminal(jobId, running, { state: 'failed', errorCode: code }, null);
      return;
    }
    const value = outcome.value;
    if (value.kind === 'failed') {
      await commitTerminal(jobId, running, { state: stateForProviderFailure(value.code), errorCode: value.code }, null);
      return;
    }

    let artifact;
    try {
      artifact = requireSynthesisArtifact(value.artifact);
      if (provider.executionMode !== 'real' && !artifact.substitute) {
        // 替身提供者声称产出真实音频：协议违规，绝不写成功（不得伪造真实音频）。
        throw new SynthesisArtifactError('替身提供者不得声称产出真实音频');
      }
    } catch (error) {
      if (error instanceof SynthesisArtifactError) {
        await commitTerminal(jobId, running, { state: 'failed', errorCode: 'PROVIDER_OUTCOME_UNKNOWN' }, null);
        return;
      }
      throw error;
    }

    const put = await media.put({ ownerUserId: running.ownerUserId, synthesisId: running.synthesisId, artifact });
    if (!put.ok) {
      // 产物无法落库 ⇒ 失败，不得落 succeeded（也不得凭空给一个 media_id）。
      await commitTerminal(jobId, running, { state: 'failed', errorCode: put.code }, null);
      return;
    }

    const finishedAt = now();
    const synthesis: SynthesisRow = {
      id: running.synthesisId,
      revision: 1,
      ownerUserId: running.ownerUserId,
      // 回绑**实际用于合成的** revision（= 执行期重读并判定通过的那个 revision）。
      checkedContentRef: { ...running.checkedContentRef },
      mediaId: put.mediaId,
      substitute: artifact.substitute,
      providerVersion: provider.providerVersion,
      createdAt: finishedAt,
      updatedAt: finishedAt,
    };
    await commitTerminal(jobId, running, { state: 'succeeded', errorCode: null }, synthesis);
  }

  async function runProviderWithDeadline(
    job: SynthesisJobRow,
    text: string,
  ): Promise<
    | { kind: 'timeout' }
    | { kind: 'threw'; error: unknown }
    | { kind: 'value'; value: Awaited<ReturnType<TtsProvider['synthesize']>> }
  > {
    const remaining = Math.max(0, job.deadlineAt.getTime() - now().getTime());
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), remaining);
    });
    const call = provider
      .synthesize({ jobId: job.id, text, locale: job.locale, targetRef: { ...job.checkedContentRef } })
      .then((value) => ({ kind: 'value' as const, value }))
      // 保留抛出对象：本地入参拒绝（TtsLocalInputError）与提供者内部异常要分开映射。
      .catch((error: unknown) => ({ kind: 'threw' as const, error }));
    try {
      return await Promise.race([call, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** 原子提交终态：CAS 失败（任务已终态）→ 什么也不写，**晚到的结果不复活任务**。 */
  async function commitTerminal(
    jobId: string,
    running: SynthesisJobRow,
    terminal: { state: JobState; errorCode: ErrorCode | null },
    synthesis: SynthesisRow | null,
  ): Promise<SynthesisJobRow | null> {
    return store.commitTerminal(jobId, running.revision, terminal, synthesis, now());
  }

  /**
   * 服务层诊断读（**不是**契约端点；契约没有 GET /speech/synthesis/{id}，已如实登记为缺口；
   * 阶段 2 的 `GET /jobs/{id}` 经共享作业源走这里）。
   * 归属不符 ⇒ `NOT_FOUND`（与不存在同形）；模式不符 ⇒ 503（不跨模式解释状态）；
   * 已过截止且仍未落终态 ⇒ 就地裁定为 `timed_out`（超时必须在读面显式可见）。
   */
  async function inspectJob(input: { userId: string; jobId: string }): Promise<SynthesisJobProjection> {
    const row = await getOwnedJob(input.userId, input.jobId);
    assertJobMode(row);
    const adjudicated = await adjudicateExpiredJob(row);
    const synthesis = adjudicated.state === 'succeeded' ? await store.getSynthesis(adjudicated.synthesisId) : null;
    return toJob(adjudicated, synthesis);
  }

  /**
   * 用户取消合成作业（`POST /jobs/{id}/cancel` 的**域内实现**；GY-R27 取消片，#13 的取消能力接线）。
   *
   * 语义（派单 §4，逐条都有独立用例钉住）：
   * - `queued` / `running` ⇒ `cancelled`，`revision` **恰好 +1**（**单次** `store.updateJob` CAS，不 +2）；
   * - 状态机**只有一处**：迁移合法性只问 `state.ts` 的 `canTransitionJob`，本函数不另写第二套状态机、
   *   不新增迁移边；`TERMINAL_JOB_STATES` 任一终态再取消 ⇒ `OBJECT_UNAVAILABLE`（对象状态不允许），
   *   **不是** `PROVIDER_UNAVAILABLE`（那是"该域根本没有取消能力"的未接线形态）；
   * - **取消不产生合成记录**：本函数只写作业状态，不碰 `syntheses`；`result` 随之恒为 `null`；
   *   随后迟到的提供者结果由 `commitTerminal` 的 revision CAS 挡下（旧回调不复活，不靠删记录）；
   * - 越权与不存在同形 `NOT_FOUND`：归属检查**先于**幂等占位，越权请求不消耗 `Idempotency-Key`；
   * - `If-Match` 缺失 ⇒ 428 `REVISION_REQUIRED`、格式非法 ⇒ 400 `INVALID_REQUEST`、
   *   与当前 revision 不符 ⇒ 409 `REVISION_CONFLICT`（与识别/OCR/转写域同一口径）；
   * - 同键原样重试 ⇒ 回放当前作业投影（**不再 +1 revision**）；同键并发 ⇒ 落败方**有界等待**
   *   占位者落定后收敛到同一投影（与 `createSynthesis` 同一套占位/收敛骨架，超预算才
   *   `REQUEST_IN_PROGRESS`）；同键异体 ⇒ `IDEMPOTENCY_CONFLICT`。
   *
   * **模式口径（本实现的选择，契约未规定）**：取消**不做** `assertJobMode`。理由：取消只写状态、
   * 不解释任何产物（`result` 恒为 `null`），因此本操作**不可能**把替身产物冒充成真实合成结果
   * （"模式交叉不撒谎"约束的是**读面解释产物**，见 `inspectJob`）。反之若在此按模式 503，
   * 跨模式遗留的 `queued`/`running` 作业将**永远无法取消**（读面 503 也不再替它裁定超时）。
   */
  async function cancelJob(input: {
    userId: string;
    jobId: string;
    ifMatch: unknown;
    idempotencyKey: unknown;
  }): Promise<SynthesisJobProjection> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    const expectedRevision = requireIfMatch(input.ifMatch);
    // 归属先于占位：越权/不存在与「任务不存在」同形，且不消耗幂等键。
    const row = await getOwnedJob(input.userId, input.jobId);
    const at = now();
    const scope = idempotencyScope(input.userId, 'POST', `${API_PREFIX}/jobs/${input.jobId}/cancel`);
    const requestHash = idempotencyRequestHash(null, `"${expectedRevision}"`, idempotencyHmacKey);
    // 幂等占位先于版本/终态校验：首次成功取消的**原样重试**必须回放结果，
    // 而不是被已自增的 revision 判成 409、或被已落地的 cancelled 判成冲突。
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      const claim = await claimIdempotentScope(scope, key, requestHash, {}, at);
      if (claim.kind === 'claimed') {
        try {
          if (row.revision !== expectedRevision) {
            throw new ApiError('REVISION_CONFLICT', '作业版本与 If-Match 不一致');
          }
          // 终态（含已 cancelled）再取消：对象状态不允许 ⇒ 409 OBJECT_UNAVAILABLE。
          if (isTerminalJobState(row.state)) {
            throw new ApiError('OBJECT_UNAVAILABLE', `作业已处于终态 ${row.state}，不可取消`);
          }
          // 唯一的迁移判据来源（不在此另写状态机）。
          if (!canTransitionJob(row.state, 'cancelled')) {
            throw new ApiError('OBJECT_UNAVAILABLE', `作业状态 ${row.state} 不可取消`);
          }
          const updated = await store.updateJob(row.id, expectedRevision, (current) => ({
            ...current,
            state: 'cancelled',
            // 取消不是失败/不确定：错误码清空（GET 读回 error_code=null）。
            errorCode: null,
            revision: current.revision + 1,
            updatedAt: at,
          }));
          // CAS 落空 ⇒ 作业在本次读写之间被别的写入改动，如实 409，不覆盖别人。
          if (updated === null) throw new ApiError('REVISION_CONFLICT', '作业状态已变化，未能取消');
          await finalizeIdempotentScope(scope, key, { job_id: updated.id });
          // cancelled 不产出合成记录 ⇒ result 恒为 null（与 failed / timed_out 同形）。
          return toJob(updated, null);
        } catch (error) {
          // 业务失败释放占位，否则同一 Idempotency-Key 的正常重试会被永久判成「处理中」。
          await releaseIdempotentScope(scope, key);
          throw error;
        }
      }

      // 同键请求：绝不重复执行副作用；等占位者落定后**收敛**到同一投影。
      const resolution = await awaitPlaceholder(scope, idempotencyKeyHashHex(scope, key), idempotencyWaitMs);
      if (resolution.kind === 'released') continue;
      if (resolution.kind === 'settled') {
        // 回放只回放**当前作业投影**：不做模式解释（见上）、不重复副作用、不再自增 revision。
        const current = await store.getJob(row.id);
        if (current === null) throw new ApiError('NOT_FOUND', '任务不存在');
        return toJob(current, null);
      }
      throw inProgress();
    }
    throw inProgress();
  }

  /**
   * **失效（过期）口径**：判断一条合成记录现在是否仍可播放。
   *
   * 重算三件事（与受理/执行同一套判定函数，不另设宽松规则）：
   *   ① 目标内容当前仍为 `approved`（否则按 `decideCheckedContent` 的映射给出错误码）；
   *   ② 内容当前 revision 仍**等于**记录绑定的 revision（否则 `REVISION_CONFLICT`：内容已修订，
   *      旧音频视为过期）；
   *   ③ 产物仍在（否则 `OBJECT_UNAVAILABLE`）。
   *
   * 服务层入口，不是契约端点；阶段 2 的播放路径应消费它而不是相信客户端缓存。
   */
  async function verifyUsable(input: { userId: string; synthesisId: string }): Promise<SynthesisUsability> {
    const row = await getOwnedSynthesis(input.userId, input.synthesisId);
    const decision = await readAndDecide(row.checkedContentRef, row.ownerUserId, 'verify');
    if (!decision.ok) {
      return { usable: false, code: decision.code, reason: decision.reason, message: decision.message };
    }
    const exists = await media.exists(row.mediaId);
    if (!exists) {
      return {
        usable: false,
        code: 'OBJECT_UNAVAILABLE',
        reason: 'MEDIA_MISSING',
        message: '合成产物已不可用（未接线或已清理）',
      };
    }
    return {
      usable: true,
      media_id: row.mediaId,
      checked_content_ref: { ...row.checkedContentRef },
      substitute: row.substitute,
    };
  }

  return {
    createSynthesis,
    inspectJob,
    cancelJob,
    verifyUsable,
    settle,
    /** 供证据文档／诊断：当前提供者与各端口标注（替身如实标注，不含凭据、不含音频）。 */
    describe: () => ({
      executionMode: provider.executionMode,
      providerVersion: provider.providerVersion,
      providerNote: provider.note,
      providerAvailable: provider.available,
      providerUnavailableReason: provider.unavailableReason,
      mediaPort: media.kind,
      mediaNote: media.note,
      contentPort: content.kind,
      contentNote: content.note,
      storePersistent: store.persistent,
      jobDeadlineMs,
      idempotencyWaitMs,
      /** 本片**不产生任何真实音频**：如实标注，避免被误读为已接线真实合成。 */
      realAudioProduced: false,
      acceptedStatus: SYNTHESIS_ACCEPTED_STATUS,
    }),
  };
}

export type SynthesisService = ReturnType<typeof createSynthesisService>;

/** 组装一个按执行模式接线的合成服务（阶段 2 的路由将直接复用本工厂）。 */
export function createSynthesisServiceForMode(input: {
  executionMode: 'real' | 'stub' | 'preset_demo';
  provider: TtsProvider;
  store: SynthesisStore;
  media: SynthesisMediaPort;
  content: CheckedContentPort;
  idempotencyHmacKey: string;
  now?: () => Date;
  idFactory?: () => string;
  jobDeadlineMs?: number;
  idempotencyWaitMs?: number;
}): SynthesisService {
  return createSynthesisService({
    store: input.store,
    provider: input.provider,
    media: input.media,
    content: input.content,
    idempotencyHmacKey: input.idempotencyHmacKey,
    now: input.now,
    idFactory: input.idFactory,
    jobDeadlineMs: input.jobDeadlineMs,
    idempotencyWaitMs: input.idempotencyWaitMs,
  });
}
