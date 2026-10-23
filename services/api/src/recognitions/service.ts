/**
 * GY-I09 识别任务服务：受理、执行、状态判定、用户选择、删除、任务查询与取消。
 *
 * 契约对齐（packages/contracts/openapi.json，未新增字段）：
 *   POST   /recognitions                 createRecognition  → 202 JobEnvelope
 *   GET    /recognitions/{id}            getRecognition     → RecognitionEnvelope
 *   PATCH  /recognitions/{id}/selection  selectSpecies      → RecognitionEnvelope
 *   DELETE /recognitions/{id}            deleteRecognition  → 202 AckEnvelope
 *   GET    /jobs/{id}                    getJob             → JobEnvelope（读 JobState 的唯一契约面）
 *   POST   /jobs/{id}/cancel             cancelJob          → JobEnvelope（构造 cancelled 的唯一契约面）
 *
 * fail-closed 要点（监工 2026-10-11 对 #82 的口径）：
 * - 未受理成功之前不创建任何识别记录；failed/timed_out/cancelled **不产生**识别记录，
 *   GET /recognitions/{id} 对它们如实 404，绝不产出「看起来成功」的空记录；
 * - 提供者失败/超时/协议违规一律落 failed/timed_out，并把 error_code 写在 Job 上；
 * - 无分数/无候选/提供者自述不确定 → uncertain + uncertainty_reasons（见 state.ts）；
 * - 取消或超时之后到达的提供者结果**不复活**任务（CAS 版本守卫）；
 * - 越权与不存在一律 NOT_FOUND，不泄露存在性；
 * - selection 只写 selected_species_id，绝不回写 candidates / model_score / model_version。
 *
 * GY-I16（#16）跨线接线：任务进入**终态且提交成功**后，把该终态交给历史端口
 * （`RecognitionTerminalHistoryPort`，装配层接到历史域的内部创建口 `appendHistory`）——
 * 因此「我的 → 识别历史」不再恒空，且 `failed`/`timed_out`/`uncertain` 原样可见。
 * 状态以 `commitTerminal` 的**返回值**为准（不是本域的乐观值），CAS 失败时**不写历史**。
 */
import { randomUUID } from 'node:crypto';
import { IDEMPOTENCY_TTL_SECONDS, idempotencyKeyHashHex, idempotencyRequestHash, idempotencyScope } from '../auth/idempotency.ts';
import { API_PREFIX, type ErrorCode } from '../contract.ts';
import { ApiError } from '../errors.ts';
import {
  BRANCH_DESCRIPTORS,
  FAILURE_BRANCHES,
  branchCreatesJob,
  retrySemanticsFor,
} from './branches.ts';
import {
  createReferenceLinkagePort,
  resolveSelectionLinkage,
  unavailableLinkage,
  type ReferenceLinkagePort,
  type SelectionConditions,
  type SelectionLinkage,
} from './linkage.ts';
import type { RecognitionMediaPort } from './media.ts';
import type { ProviderFailureCode, RecognitionProvider } from './provider.ts';
import {
  SELECTION_PROVENANCE_LABELS,
  summarizeSelections,
  type SelectionProvenance,
  type SelectionRecord,
  type SelectionSummary,
} from './selection.ts';
import {
  MAX_SPECIES_ID_LENGTH,
  CandidateProtocolError,
  decideOutcome,
  isTerminalJobState,
  type Candidate,
  type Decision,
  type JobState,
} from './state.ts';
import type {
  JobRow,
  RecognitionOwnerPurgeCounts,
  RecognitionRow,
  RecognitionStore,
} from './store.ts';

/** 任务截止时间（毫秒）：超过即 timed_out，且迟到结果不复活任务。 */
export const DEFAULT_JOB_DEADLINE_MS = 30 * 1000;
/** 幂等键长度口径与认证层一致（8..128）。 */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IF_MATCH_PATTERN = /^"[1-9][0-9]*"$/;

export interface MediaJobInput {
  media_id: string;
  media_revision: number;
}

export interface RecognitionProjection {
  id: string;
  revision: number;
  candidates: Candidate[];
  uncertainty_reasons: string[];
  selected_species_id: string | null;
  model_version: string;
}

export interface JobProjection {
  id: string;
  revision: number;
  kind: 'recognition';
  target_ref: { type: 'recognition'; id: string; revision: number };
  state: JobState;
  deadline_at: string;
  created_at: string;
  error_code: ErrorCode | null;
  result: { kind: 'recognition'; value: RecognitionProjection } | null;
}

/**
 * 识别任务**终态**写入服务端识别历史的端口（GY-I16 #16 的跨线接线）。
 *
 * ## 为什么是一个端口、而不是本域直接 import 历史域
 * 历史域的**内部创建口** `AppHistoryService.appendHistory(input)` 住在
 * `services/api/src/history/service.ts`（不是契约 operationId、**不注册路由**）。识别域只声明
 * 「我要把一次已落库的终态交给历史域」这一件事的形状，接线（真正调用 `appendHistory`）由**装配层**
 * `services/api/src/app.ts` 完成 —— 与 `recognitionEgress`、`linkage` 等既有跨线端口的做法一致，
 * 本域**不** import 历史域、不新增契约出口。
 *
 * ## 调用契约（接线方必须满足）
 * - **只在终态提交成功之后调用**（`commitTerminal` 返回非 `null`）：CAS 失败（任务已被取消或已终态）
 *   时**不得**调用，否则会把一次从未发生的终态写进历史；
 * - `target_ref` 的 `id` 是**识别记录 id**（任务创建时即分配的内部分配 id）、`revision` 是提交时
 *   识别记录的 `revision`；
 * - **`job_state` 必须是实际落库的终态**（取 `commitTerminal` 的返回值，不取本域的乐观值）；
 * - 幂等由**装配层**用**确定性** `event_key`（由本任务的稳定标识派生，**不含**时间戳/随机数）
 *   保证：同一次任务重复投递是 **no-op**，不得产生第二条历史行。
 *
 * ## 失败边界
 * 历史行是**可浏览性**的产物，不是任务结果的权威（权威在识别 store）。因此端口抛错
 * （历史域未装配、入参不合约、存储异常）由本域**吞掉并记一条告警**，绝不把已落库的终态任务
 * 回滚或改写成失败 —— 但也**绝不**伪造一条"成功"的历史。
 */
export interface RecognitionTerminalHistoryInput {
  /** 归属者（服务端解析出的用户 id，绝不来自客户端）。 */
  owner_id: string;
  kind: 'recognition';
  target_ref: { type: 'recognition'; id: string; revision: number };
  /** 内部作业标识（历史行读取时用它核对实时状态）。 */
  job_id: string;
  /** **实际落库**的终态。 */
  job_state: JobState;
}

export interface RecognitionTerminalHistoryPort {
  /** 端口接线状态：`wired`=装配层已接到历史域内部创建口；`unwired`=未接线（只告警，不写）。 */
  readonly kind: 'wired' | 'unwired';
  /** 供证据文档/诊断引用的说明（可安全公开：不含归属与目标正文）。 */
  readonly note: string;
  recordTerminal(input: RecognitionTerminalHistoryInput): Promise<void>;
}

/**
 * 未接线端口（**合法**的 fail-closed 端口：识别域照常跑，只是历史里没有它的一行）。
 *
 * 不是产品默认：`app.ts` 的装配默认已接到历史域（stub/preset_demo）；
 * `real` 模式下历史域整域关闭（`historyService === null`）⇒ 本端口就是这一支。
 */
export function createUnwiredRecognitionTerminalHistoryPort(
  note = '识别终态写入历史的端口尚未接线：任务照常执行，但不产生服务端历史行',
): RecognitionTerminalHistoryPort {
  return {
    kind: 'unwired',
    note,
    async recordTerminal() {
      // 未接线 = 什么都不做（**不是**假装写成功、也不是回退替身）。
    },
  };
}

export interface RecognitionServiceOptions {
  store: RecognitionStore;
  provider: RecognitionProvider;
  media: RecognitionMediaPort;
  /** 幂等请求摘要密钥（服务端密钥，不入库、不下发）。 */
  idempotencyHmacKey: string;
  /**
   * 终态写入服务端识别历史的端口（**可选**；缺省 = 未接线 fail-closed，见端口注释）。
   * 接线属跨线，装配点唯一：`services/api/src/app.ts`。
   */
  history?: RecognitionTerminalHistoryPort;
  /**
   * 选择后关联科普与条件的**只读**资料端口（可选）。
   *
   * 缺省按其执行模式装配：`real` 只并入**已核对**条目（与既有
   * `catalog_read.current_knowledge` 口径一致），非 real 可并入已发布但未核对的
   * 真实公告附表记录（逐条如实带 `review_status`）。
   * 注入替身端口即可在测试里构造「有效/失效/模拟」各式条目做负例。
   */
  linkage?: ReferenceLinkagePort;
  now?: () => Date;
  idFactory?: () => string;
  jobDeadlineMs?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidRequest(message: string, field?: string): ApiError {
  return new ApiError('INVALID_REQUEST', message, field === undefined ? {} : { details: [{ field, code: 'invalid' }] });
}

/** 校验 body 恰为 MediaJobInput（additionalProperties:false：多余字段 400）。 */
export function requireMediaJobInput(body: unknown): MediaJobInput {
  if (!isPlainObject(body)) throw invalidRequest('请求体必须是对象');
  const extra = Object.keys(body).filter((key) => key !== 'media_id' && key !== 'media_revision');
  if (extra.length > 0) throw invalidRequest('请求体含未定义字段', `/${extra[0]}`);
  if (!('media_id' in body) || !('media_revision' in body)) {
    throw invalidRequest('缺少必填字段 media_id / media_revision');
  }
  const mediaId = body['media_id'];
  const mediaRevision = body['media_revision'];
  if (typeof mediaId !== 'string' || !UUID_PATTERN.test(mediaId)) {
    throw invalidRequest('media_id 必须是 uuid', '/media_id');
  }
  if (typeof mediaRevision !== 'number' || !Number.isInteger(mediaRevision) || mediaRevision < 1) {
    throw invalidRequest('media_revision 必须是 >=1 的整数', '/media_revision');
  }
  return { media_id: mediaId, media_revision: mediaRevision };
}

/** 校验 body 恰为 SelectionInput。 */
export function requireSelectionInput(body: unknown): { selected_species_id: string } {
  if (!isPlainObject(body)) throw invalidRequest('请求体必须是对象');
  const extra = Object.keys(body).filter((key) => key !== 'selected_species_id');
  if (extra.length > 0) throw invalidRequest('请求体含未定义字段', `/${extra[0]}`);
  const selected = body['selected_species_id'];
  if (typeof selected !== 'string' || selected.length < 1 || selected.length > MAX_SPECIES_ID_LENGTH) {
    throw invalidRequest('selected_species_id 必须是 1..80 字符的字符串', '/selected_species_id');
  }
  return { selected_species_id: selected };
}

export function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < IDEMPOTENCY_KEY_MIN_LENGTH || value.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', `缺少或非法的 Idempotency-Key 头（${IDEMPOTENCY_KEY_MIN_LENGTH}..${IDEMPOTENCY_KEY_MAX_LENGTH} 字符）`);
  }
  return value;
}

/** 契约 If-Match 口径：缺失 428，格式非法 400，不匹配由调用方判 409。 */
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

function toRecognition(row: RecognitionRow): RecognitionProjection {
  return {
    id: row.id,
    revision: row.revision,
    candidates: row.candidates.map((item) => ({ species_id: item.species_id, rank: item.rank, model_score: item.model_score })),
    uncertainty_reasons: [...row.uncertaintyReasons],
    selected_species_id: row.selectedSpeciesId,
    model_version: row.modelVersion,
  };
}

export function toJob(row: JobRow, recognition: RecognitionRow | null): JobProjection {
  const usable = recognition !== null && !recognition.deleted && (row.state === 'succeeded' || row.state === 'uncertain');
  return {
    id: row.id,
    revision: row.revision,
    kind: 'recognition',
    target_ref: { type: 'recognition', id: row.recognitionId, revision: recognition === null ? 1 : recognition.revision },
    state: row.state,
    deadline_at: row.deadlineAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    error_code: row.errorCode,
    result: usable ? { kind: 'recognition', value: toRecognition(recognition) } : null,
  };
}

/** 提供者失败码 → 终态 JobState（绝不落 succeeded）。 */
export function stateForProviderFailure(code: ProviderFailureCode): JobState {
  return code === 'PROVIDER_TIMEOUT' ? 'timed_out' : 'failed';
}

export function createRecognitionService(options: RecognitionServiceOptions) {
  const store = options.store;
  const provider = options.provider;
  const media = options.media;
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => randomUUID());
  const jobDeadlineMs = options.jobDeadlineMs ?? DEFAULT_JOB_DEADLINE_MS;
  const idempotencyHmacKey = options.idempotencyHmacKey;
  /**
   * 选择后关联端口。缺省按执行模式装配（`real` 只并入已核对条目）。
   * 端口只读资料层，**不可能**写入资料或产出用量卡（用量由 linkage.ts 恒阻断）。
   */
  const linkagePort =
    options.linkage ?? createReferenceLinkagePort({ requireVerified: provider.executionMode === 'real' });
  /** 终态 → 服务端识别历史（GY-I16 #16 接线；缺省未接线，见 `RecognitionTerminalHistoryPort`）。 */
  const historyPort = options.history ?? createUnwiredRecognitionTerminalHistoryPort();
  const inFlight = new Set<Promise<void>>();

  function scopeFor(userId: string, method: string, routePath: string): string {
    return idempotencyScope(userId, method, routePath);
  }

  /**
   * 同键收敛的有界等待预算（用真实时钟，避免受注入时钟影响）；
   * 与 routes/support.ts 的认证幂等重放口径一致。
   */
  const CLAIM_WAIT_STEP_MS = 2;
  const CLAIM_WAIT_BUDGET_MS = 1000;

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 写路径的幂等执行（监工 review 5483726169 [P1]）：
   * 「**原子占位** → 执行写入 → 写完成回执」三段，占位与查回执在同一临界区内完成，
   * 因此同主体同键并发**只能有一个**进入 `produce`：
   * - 同键同体并发：后到者得到 `in_progress`，有界等待其回执后按回执重放（收敛到同一结果，不产生第二个任务）；
   * - 同键异体并发：立即 `conflict` → `IDEMPOTENCY_CONFLICT`，且不产生第二个任务；
   * - 等待超预算：`REQUEST_IN_PROGRESS`（409，可重试），仍不产生第二个任务；
   * - `produce` 抛错：释放占位（不落回执），错误原样抛出。
   */
  async function runIdempotentWrite<T>(input: {
    scope: string;
    key: string;
    requestHash: string;
    /** 命中完成回执时的重放路径（按结果引用重新读取当前状态）。 */
    replay: (payload: Record<string, unknown>) => Promise<T>;
    /** 只有占位成功者才执行；返回结果与**不含凭据**的结果引用。 */
    produce: () => Promise<{ result: T; payload: Record<string, unknown> }>;
  }): Promise<T> {
    const keyHashHex = idempotencyKeyHashHex(input.scope, input.key);
    const deadline = Date.now() + CLAIM_WAIT_BUDGET_MS;
    for (;;) {
      const at = now();
      await store.purgeIdempotent(at);
      const claim = await store.claimIdempotent(input.scope, keyHashHex, {
        requestHash: input.requestHash,
        expiresAt: new Date(at.getTime() + IDEMPOTENCY_TTL_SECONDS * 1000),
        now: at,
      });
      if (claim.status === 'conflict') {
        throw new ApiError('IDEMPOTENCY_CONFLICT', '同一 Idempotency-Key 已被不同请求体使用');
      }
      if (claim.status === 'completed') return input.replay(claim.row.payload);
      if (claim.status === 'in_progress') {
        if (Date.now() >= deadline) {
          throw new ApiError('REQUEST_IN_PROGRESS', '同一 Idempotency-Key 的请求正在处理中，请稍后重试', { retryable: true });
        }
        await delay(CLAIM_WAIT_STEP_MS);
        continue;
      }
      try {
        const produced = await input.produce();
        await store.completeIdempotent(input.scope, keyHashHex, {
          requestHash: input.requestHash,
          // 只存不含凭据的结果引用；重放时按引用重新读取当前状态。
          payload: produced.payload,
          expiresAt: new Date(now().getTime() + IDEMPOTENCY_TTL_SECONDS * 1000),
        });
        return produced.result;
      } catch (error) {
        // 写入失败不落回执：释放占位，后续同键请求可重新尝试。
        await store.releaseIdempotent(input.scope, keyHashHex);
        throw error;
      }
    }
  }

  async function getOwnedJob(userId: string, jobId: string): Promise<JobRow> {
    if (typeof jobId !== 'string' || !UUID_PATTERN.test(jobId)) throw new ApiError('NOT_FOUND', '任务不存在');
    const row = await store.getJob(jobId);
    // 越权与不存在同形：不泄露存在性。
    if (row === null || row.ownerUserId !== userId) throw new ApiError('NOT_FOUND', '任务不存在');
    return row;
  }

  async function getOwnedRecognition(userId: string, recognitionId: string, allowDeleted = false): Promise<RecognitionRow> {
    if (typeof recognitionId !== 'string' || !UUID_PATTERN.test(recognitionId)) throw new ApiError('NOT_FOUND', '识别记录不存在');
    const row = await store.getRecognition(recognitionId);
    if (row === null || row.ownerUserId !== userId || (row.deleted && !allowDeleted)) {
      throw new ApiError('NOT_FOUND', '识别记录不存在');
    }
    return row;
  }

  /** 受理识别任务：202 + Job（state=queued），随后异步执行。 */
  async function createRecognition(input: {
    userId: string;
    body: unknown;
    idempotencyKey: unknown;
  }): Promise<{ job: JobProjection; replayed: boolean }> {
    const mediaJobInput = requireMediaJobInput(input.body);
    const key = requireIdempotencyKey(input.idempotencyKey);
    // real 缺凭据/无已审适配器：受理前 fail-closed，不排队、不回退替身。
    // `retryable: false`：这是"能力未装配／未接线"（需运维改配置），不是瞬时故障 —— 同一请求原样重试不会成功。
    // 口径原文见 `services/api/src/errors.ts` 的 `ApiError` 上方注释。
    if (!provider.available) {
      throw new ApiError('PROVIDER_UNAVAILABLE', provider.unavailableReason ?? '识别提供者不可用', {
        retryable: false,
      });
    }
    const resolution = await media.resolve({
      ownerUserId: input.userId,
      mediaId: mediaJobInput.media_id,
      mediaRevision: mediaJobInput.media_revision,
    });
    if (!resolution.ok) throw new ApiError(resolution.code, '媒体引用不可用');

    const at = now();
    const scope = scopeFor(input.userId, 'POST', `${API_PREFIX}/recognitions`);
    const requestHash = idempotencyRequestHash(mediaJobInput, undefined, idempotencyHmacKey);
    const outcome = await runIdempotentWrite<{ job: JobProjection; replayed: boolean }>({
      scope,
      key,
      requestHash,
      replay: async (payload) => {
        const jobId = payload['job_id'];
        if (typeof jobId !== 'string') throw new ApiError('PROVIDER_OUTCOME_UNKNOWN', '幂等台账结果引用非法');
        const existing = await getOwnedJob(input.userId, jobId);
        const recognition = await store.getRecognition(existing.recognitionId);
        return { job: toJob(existing, recognition), replayed: true };
      },
      produce: async () => {
        const jobId = idFactory();
        const row: JobRow = {
          id: jobId,
          revision: 1,
          kind: 'recognition',
          ownerUserId: input.userId,
          recognitionId: idFactory(),
          mediaId: mediaJobInput.media_id,
          mediaRevision: mediaJobInput.media_revision,
          state: 'queued',
          deadlineAt: new Date(at.getTime() + jobDeadlineMs),
          createdAt: at,
          updatedAt: at,
          errorCode: null,
        };
        await store.insertJob(row);
        return { result: { job: toJob(row, null), replayed: false }, payload: { job_id: jobId } };
      },
    });
    // 只有占位成功者（非重放）才启动执行：同键收敛不会产生第二次提供者调用。
    if (!outcome.replayed) track(execute(outcome.job.id));
    return outcome;
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

  /** 执行一次识别任务：queued → running → 终态。任何异常都不得变成 succeeded。 */
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

    const outcome = await runProviderWithDeadline(running);
    if (outcome.kind === 'timeout') {
      await commitTerminal(jobId, running, { state: 'timed_out', errorCode: 'PROVIDER_TIMEOUT' }, null);
      return;
    }
    if (outcome.kind === 'threw') {
      await commitTerminal(jobId, running, { state: 'failed', errorCode: 'PROVIDER_OUTCOME_UNKNOWN' }, null);
      return;
    }
    if (outcome.value.kind === 'failed') {
      await commitTerminal(
        jobId,
        running,
        { state: stateForProviderFailure(outcome.value.code), errorCode: outcome.value.code },
        null,
      );
      return;
    }

    let decision: Decision;
    try {
      // 第三参数为提供者上报的六类失败/边界分支：一旦上报，**一律** uncertain
      // （覆盖外/低质量/需重拍不得因同时返回高分候选而被写成成功）。
      decision = decideOutcome(outcome.value.candidates, outcome.value.uncertainty_reasons, outcome.value.branch);
    } catch (error) {
      if (error instanceof CandidateProtocolError) {
        // 提供者协议违规（候选 >3 / rank 重复 / 字段缺失）：fail-closed，不截断、不补造。
        await commitTerminal(jobId, running, { state: 'failed', errorCode: 'PROVIDER_OUTCOME_UNKNOWN' }, null);
        return;
      }
      throw error;
    }

    const finishedAt = now();
    const recognition: RecognitionRow = {
      id: running.recognitionId,
      revision: 1,
      ownerUserId: running.ownerUserId,
      mediaId: running.mediaId,
      mediaRevision: running.mediaRevision,
      candidates: decision.candidates,
      uncertaintyReasons: decision.uncertaintyReasons,
      selectedSpeciesId: null,
      modelVersion: provider.modelVersion,
      createdAt: finishedAt,
      updatedAt: finishedAt,
      deleted: false,
    };
    await commitTerminal(jobId, running, { state: decision.state, errorCode: null }, recognition);
  }

  async function runProviderWithDeadline(job: JobRow): Promise<
    | { kind: 'timeout' }
    | { kind: 'threw' }
    | { kind: 'value'; value: Awaited<ReturnType<RecognitionProvider['recognize']>> }
  > {
    const remaining = Math.max(0, job.deadlineAt.getTime() - now().getTime());
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), remaining);
    });
    const call = provider
      .recognize({ jobId: job.id, mediaId: job.mediaId, mediaRevision: job.mediaRevision })
      .then((value) => ({ kind: 'value' as const, value }))
      .catch(() => ({ kind: 'threw' as const }));
    try {
      return await Promise.race([call, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * 原子提交终态：CAS 失败（任务已被取消或已终态）→ 什么也不写，**旧回调不复活**。
   *
   * 提交**成功后**（只有这一次 CAS 会成功）把该终态交给历史端口落一行服务端识别历史（GY-I16 #16）：
   * - `job_state` 取**返回值**（实际落库的终态），不取本域的乐观值；
   * - 端口抛错只记告警：历史行不是任务结果的权威，已落库的终态**不因历史写入失败而改写**；
   * - 端口实现方（装配层）用确定性 `event_key` 去重 ⇒ 同一次任务重复投递是 no-op。
   */
  async function commitTerminal(
    jobId: string,
    running: JobRow,
    terminal: { state: JobState; errorCode: ErrorCode | null },
    recognition: RecognitionRow | null,
  ): Promise<JobRow | null> {
    const at = now();
    const committed = await store.commitTerminal(jobId, running.revision, terminal, recognition, at);
    if (committed !== null) {
      await recordTerminalHistory({
        owner_id: committed.ownerUserId,
        kind: 'recognition',
        target_ref: { type: 'recognition', id: committed.recognitionId, revision: recognition === null ? 1 : recognition.revision },
        job_id: committed.id,
        job_state: committed.state,
      });
    }
    return committed;
  }

  /** 把一次**已落库**的终态交给历史端口（吞掉端口异常，不改变任务结果）。 */
  async function recordTerminalHistory(input: RecognitionTerminalHistoryInput): Promise<void> {
    try {
      await historyPort.recordTerminal(input);
    } catch (error) {
      // 只记一条告警（含端口接线状态与任务 id 形状，不含归属身份/媒体引用/候选）。
      console.warn(
        `GY-I16 识别终态历史写入失败（端口=${historyPort.kind}，job_state=${input.job_state}）：`,
        error instanceof Error ? error.message : typeof error,
      );
    }
  }

  async function getRecognition(input: { userId: string; recognitionId: string }): Promise<RecognitionProjection> {
    const row = await getOwnedRecognition(input.userId, input.recognitionId);
    return toRecognition(row);
  }

  async function getJob(input: { userId: string; jobId: string }): Promise<JobProjection> {
    const row = await getOwnedJob(input.userId, input.jobId);
    const recognition = row.state === 'succeeded' || row.state === 'uncertain' ? await store.getRecognition(row.recognitionId) : null;
    return toJob(row, recognition);
  }

  /** 记录用户选择：只写 selected_species_id，绝不回写模型原始候选与分数。 */
  async function selectSpecies(input: {
    userId: string;
    recognitionId: string;
    body: unknown;
    ifMatch: unknown;
    idempotencyKey: unknown;
  }): Promise<RecognitionProjection> {
    const selection = requireSelectionInput(input.body);
    const key = requireIdempotencyKey(input.idempotencyKey);
    const expectedRevision = requireIfMatch(input.ifMatch);
    const row = await getOwnedRecognition(input.userId, input.recognitionId);
    const scope = scopeFor(input.userId, 'PATCH', `${API_PREFIX}/recognitions/${input.recognitionId}/selection`);
    const requestHash = idempotencyRequestHash({ selection, ifMatch: `"${expectedRevision}"` }, undefined, idempotencyHmacKey);
    return runIdempotentWrite<RecognitionProjection>({
      scope,
      key,
      requestHash,
      // 幂等重放先于版本校验：首次成功请求的**原样重试**必须回放首次结果，
      // 而不是被已自增的 revision 判成 409（与 packages/media 完成接口 B3 口径一致）。
      replay: async () => {
        const current = await store.getRecognition(row.id);
        if (current === null) throw new ApiError('NOT_FOUND', '识别记录不存在');
        return toRecognition(current);
      },
      produce: async () => {
        if (row.revision !== expectedRevision) throw new ApiError('REVISION_CONFLICT', '识别记录版本与 If-Match 不一致');
        const at = now();
        // 关联科普与条件：**只取有效、可访问、非模拟**资料，且用量恒被 GY-I08 守卫阻断。
        const linkage = await resolveLinkageFor(selection.selected_species_id);
        // 原子提交：CAS 更新识别记录 + **追加**独立的用户选择记录（候选与人工选择分开记录）。
        const committed = await store.commitSelection(
          row.id,
          expectedRevision,
          (current) => ({
            ...current,
            // 只动这两项：candidates / model_score / model_version 保持模型原始值。
            selectedSpeciesId: selection.selected_species_id,
            revision: current.revision + 1,
            updatedAt: at,
          }),
          {
            id: idFactory(),
            revision: 1,
            recognitionId: row.id,
            ownerUserId: row.ownerUserId,
            speciesId: selection.selected_species_id,
            // 人工选择：**永不**计入模型成绩（见 selection.ts 的 MODEL_ATTRIBUTABLE_PROVENANCE）。
            provenance: 'human',
            decidedAt: at,
            linkage,
          },
        );
        if (committed === null) throw new ApiError('REVISION_CONFLICT', '识别记录已被并发修改');
        return { result: toRecognition(committed.recognition), payload: { accepted: true } };
      },
    });
  }

  /**
   * 解析某个已选品种的关联科普与条件。
   *
   * **关联失败不使选择失败**：用户的选择已写入且可重试，但记录里必须**如实**带出
   * 「关联未取得 + 原因」——不用空资料冒充「查过但没有」，更不因此产出任何用量。
   */
  async function resolveLinkageFor(
    speciesId: string,
    conditions: SelectionConditions | null = null,
  ): Promise<SelectionLinkage> {
    try {
      const records = await linkagePort.itemsForSpecies(speciesId);
      return resolveSelectionLinkage({ speciesId, conditions, records });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return unavailableLinkage(speciesId, reason);
    }
  }

  /**
   * 人工选择的独立记录（归属者限定）。
   * 越权与不存在一律 `NOT_FOUND`（不泄露存在性，与识别记录读面同口径）。
   */
  async function listSelections(input: {
    userId: string;
    recognitionId: string;
  }): Promise<{ items: SelectionRecord[]; summary: SelectionSummary }> {
    await getOwnedRecognition(input.userId, input.recognitionId);
    const items = await store.listSelections(input.recognitionId, input.userId);
    return { items, summary: summarizeSelections(items) };
  }

  /** 人工选择的来源标签（页面/证据页共用，避免两端各写一套文案）。 */
  function selectionProvenanceLabels(): Record<SelectionProvenance, string> {
    return { ...SELECTION_PROVENANCE_LABELS };
  }

  /**
   * 六类分支的**如实指引**（`branches.ts` 闭集的稳定投影）。
   * 逐分支给出：契约内落点（state / error_code）、是否可重试、唯一重试动作、如实原因。
   * `requires_human_action` 与 `retryable` 分开给出：前者为 `true` 时恢复必须先由人介入，
   * ⛔ 调用方不得据此自动重试（口径见 `branches.ts` 的 `BranchDescriptor.retryable` 注释）。
   */
  function branchGuide(): {
    branch: string;
    label: string;
    job_state: string | null;
    error_code: string | null;
    retryable: boolean;
    retry_action: string | null;
    requires_human_action: boolean;
    reason: string | null;
    creates_job: boolean;
  }[] {
    return FAILURE_BRANCHES.map((branch) => {
      const descriptor = BRANCH_DESCRIPTORS[branch];
      const retry = retrySemanticsFor(branch);
      return {
        branch: descriptor.branch,
        label: descriptor.label,
        job_state: descriptor.jobState,
        error_code: descriptor.errorCode,
        retryable: retry.retryable,
        retry_action: retry.retryAction,
        requires_human_action: retry.requiresHumanAction,
        reason: descriptor.reason,
        creates_job: branchCreatesJob(branch),
      };
    });
  }

  /** 删除识别记录（归属者限定）。 */
  async function deleteRecognition(input: {
    userId: string;
    recognitionId: string;
    ifMatch: unknown;
    idempotencyKey: unknown;
  }): Promise<{ accepted: true }> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    const expectedRevision = requireIfMatch(input.ifMatch);
    const scope = scopeFor(input.userId, 'DELETE', `${API_PREFIX}/recognitions/${input.recognitionId}`);
    const requestHash = idempotencyRequestHash(null, `"${expectedRevision}"`, idempotencyHmacKey);
    return runIdempotentWrite<{ accepted: true }>({
      scope,
      key,
      requestHash,
      replay: async () => ({ accepted: true }),
      produce: async () => {
        const row = await getOwnedRecognition(input.userId, input.recognitionId);
        if (row.revision !== expectedRevision) throw new ApiError('REVISION_CONFLICT', '识别记录版本与 If-Match 不一致');
        const at = now();
        const updated = await store.updateRecognition(row.id, expectedRevision, (current) => ({
          ...current,
          deleted: true,
          revision: current.revision + 1,
          updatedAt: at,
        }));
        if (updated === null) throw new ApiError('REVISION_CONFLICT', '识别记录已被并发修改');
        return { result: { accepted: true }, payload: { accepted: true } };
      },
    });
  }

  /** 取消任务：只允许 queued/running；已终态一律 OBJECT_UNAVAILABLE（不假装取消成功）。 */
  async function cancelJob(input: {
    userId: string;
    jobId: string;
    ifMatch: unknown;
    idempotencyKey: unknown;
  }): Promise<JobProjection> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    const expectedRevision = requireIfMatch(input.ifMatch);
    // 归属守卫先行（越权/不存在一律 NOT_FOUND，不泄露存在性）：不放宽身份与归属。
    const row = await getOwnedJob(input.userId, input.jobId);
    const scope = scopeFor(input.userId, 'POST', `${API_PREFIX}/jobs/${input.jobId}/cancel`);
    const requestHash = idempotencyRequestHash(null, `"${expectedRevision}"`, idempotencyHmacKey);
    return runIdempotentWrite<JobProjection>({
      scope,
      key,
      requestHash,
      // 监工 review 5483726169 [P2]：**先读幂等回执**再谈版本/终态。
      // 首次取消成功后，原键 + 原 If-Match 的原样重试必须回放已存储的取消结果，
      // 而不是因为 revision 已自增（或被终态判断挡下）返回 REVISION_CONFLICT / OBJECT_UNAVAILABLE。
      replay: async () => currentJobProjection(input.userId, input.jobId),
      produce: async () => {
        // 仅在未命中回执时才做版本/终态判断（守卫语义不变）。
        if (row.revision !== expectedRevision) throw new ApiError('REVISION_CONFLICT', '任务版本与 If-Match 不一致');
        if (isTerminalJobState(row.state)) {
          throw new ApiError('OBJECT_UNAVAILABLE', `任务已处于终态 ${row.state}，不可取消`);
        }
        const at = now();
        const updated = await store.updateJob(row.id, expectedRevision, (current) => ({
          ...current,
          state: 'cancelled',
          errorCode: null,
          revision: current.revision + 1,
          updatedAt: at,
        }));
        // CAS 失败说明此刻已被其他写入改为终态（例如刚好成功/超时）：如实报冲突。
        if (updated === null) throw new ApiError('REVISION_CONFLICT', '任务状态已变化，未能取消');
        const recognition = updated.state === 'succeeded' || updated.state === 'uncertain' ? await store.getRecognition(updated.recognitionId) : null;
        return { result: toJob(updated, recognition), payload: { job_id: updated.id } };
      },
    });
  }

  /** 任务当前投影（幂等重放用：按结果引用重新读取当前状态）。 */
  async function currentJobProjection(userId: string, jobId: string): Promise<JobProjection> {
    const row = await getOwnedJob(userId, jobId);
    const recognition = row.state === 'succeeded' || row.state === 'uncertain' ? await store.getRecognition(row.recognitionId) : null;
    return toJob(row, recognition);
  }

  return {
    createRecognition,
    getRecognition,
    selectSpecies,
    deleteRecognition,
    getJob,
    cancelJob,
    /** 人工选择的独立记录（归属者限定；改选历史 append-only）。 */
    listSelections,
    /** 人工选择来源标签（页面与证据页共用同一份文案）。 */
    selectionProvenanceLabels,
    /**
     * 六类失败/边界分支的**如实指引**（闭集，唯一事实来源见 `branches.ts`）。
     *
     * 小程序的 `identify-api.js` 镜像同一份指引，并由回归测试逐项断言两端一致
     * （漂移即失败）—— 因此这里不是装饰性输出，而是跨端一致性的锚点。
     */
    branchGuide,
    settle,
    /**
     * 账号注销清理（GY-R34-I19）：按主体清空识别域四表（selections → jobs → records → 台账前缀）。
     *
     * 为什么在这个层：识别存储的解析点是装配处的内联三段式，且本服务是唯一持有该实例的地方
     * （装配层把服务装饰成 `app.recognitionService`）。注销只能用它手里这一份 store，另建实例
     * 会清到另一份数据（内存模式下更是空数据），却照样报「已清 N 行」—— 那是静默假账。
     *
     * 存储缺原语时**抛错**，不返回 0 假装清空：删除协议会把异常折叠成回执 `blocked` +
     * `HANDLER_FAILED`，⛔ 不会把该域标成 `completed`。
     */
    async purgeOwnerData(ownerId: string): Promise<RecognitionOwnerPurgeCounts> {
      const purge = store.purgeOwnerData;
      if (purge === undefined) {
        throw new Error('识别域存储未实现按主体清空（purgeOwnerData）：拒绝假装清空');
      }
      return purge.call(store, ownerId);
    },
    /** 供证据文档/诊断：当前提供者与媒体端口标注。 */
    describe: () => ({
      executionMode: provider.executionMode,
      modelVersion: provider.modelVersion,
      providerAvailable: provider.available,
      providerUnavailableReason: provider.unavailableReason,
      mediaPort: media.kind,
      mediaNote: media.note,
      storePersistent: store.persistent,
      jobDeadlineMs,
      /** 选择后关联端口（只读资料层；用量恒被 GY-I08 守卫阻断）。 */
      linkagePort: linkagePort.kind,
      linkageNote: linkagePort.note,
      /** 终态 → 服务端识别历史的端口（GY-I16 #16 接线；未接线时任务照常执行）。 */
      historyPort: historyPort.kind,
      historyNote: historyPort.note,
      /** 人工选择一律不计模型成绩（来源闭集与模型成绩无交集）。 */
      selectionProvenance: 'human',
      selectionModelAttributable: false,
    }),
  };
}

export type RecognitionService = ReturnType<typeof createRecognitionService>;
