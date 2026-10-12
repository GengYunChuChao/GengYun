/**
 * GY-I11 普通话录音与转写服务：受理、执行、原始转写、用户核对与删除（**只做服务层**）。
 *
 * 契约对齐（packages/contracts/openapi.json，未新增字段）：
 *   POST   /speech/transcriptions                     createTranscription → 202 JobEnvelope
 *   GET    /speech/transcriptions/{id}                getTranscription    → TranscriptionEnvelope
 *   DELETE /speech/transcriptions/{id}                deleteTranscription → 202 AckEnvelope
 *   PATCH  /speech/transcriptions/{id}/confirmation   confirmTranscription→ 200 TranscriptionEnvelope
 *
 * 本阶段**不注册任何 HTTP 路由**（组装点 `services/api/src/app.ts` 与路由目录
 * `services/api/src/routes` 被 #9 / #10 占用，禁止触碰）；本文件也不 import 它们的任何内容。
 * 契约里的 `POST /speech/synthesis` 属 #13 TTS，**本片不做**。
 *
 * fail-closed 要点（派单 §2，逐条都有独立用例）：
 * - **`raw_text` / `confirmed_text` 严格分离**：确认路径只写 `confirmed_text` + `confirmed_at`，
 *   `raw_text` 与 `uncertain_spans` 原样保留（存储层不变量兜底）；用户确认是人的判断，
 *   **不计入模型准确率**，本层也不提供任何回灌入口；
 * - **`uncertain_spans` 如实**：只做形状/区间校验，不删改、不裁剪、不补造、不排序；
 * - **超长 fail-closed**：`raw_text` 码点 > 8000 一律判提供者协议违规（`failed` +
 *   `PROVIDER_OUTCOME_UNKNOWN`），**绝不静默截断**，也绝不写记录；
 * - **空转写不得成功**：空/纯空白文本 ⇒ `uncertain` 终态 + `INPUT_UNCERTAIN`，**不写记录**，
 *   不编造文本；`failed` / `timed_out` / `cancelled` / `uncertain` 均不产生转写记录，
 *   `getTranscription` 对它们如实 `NOT_FOUND`，绝不产出「看起来成功」的空记录；
 * - **提供者失败不得写成功**：`real` 缺凭据 ⇒ **受理前** 503 `PROVIDER_UNAVAILABLE`，
 *   不排队、不回退替身；超时 → `timed_out` + `PROVIDER_TIMEOUT`；配额 →
 *   `failed` + `PROVIDER_QUOTA_EXCEEDED`；结果未知/协议违规 → `failed` +
 *   `PROVIDER_OUTCOME_UNKNOWN`；任何异常路径都不得变成 `succeeded`；
 * - **幂等并发主动做对（#9 的 P1 教训）**：写路径**先原子占位、再建任务/调提供者**。
 *   同主体同键同体并发 ⇒ **恰好 1 个任务、恰好 1 次提供者调用**，且落败者等待占位者落定后
 *   **收敛到同一响应**（而不是重复执行副作用）；同键异体 ⇒ `IDEMPOTENCY_CONFLICT`，
 *   且不产生第二个任务；占位者失败 ⇒ **释放占位**，同键正常重试不会被永久判成处理中；
 * - **越权与不存在同形** `NOT_FOUND`（不泄露存在性）；`revision` 不一致 ⇒ `REVISION_CONFLICT`；
 *   缺 `If-Match` ⇒ `REVISION_REQUIRED`；body 多余字段 ⇒ `INVALID_REQUEST`。
 *
 * **契约缺口（如实记录，不新增契约字段）**：
 * - 契约**没有**规定 `JobState` 与 `ErrorCode` 的对应关系；下面的映射（见 `stateForProviderFailure`
 *   与 `execute`）是本实现的选择：超时→`timed_out`，其余失败→`failed`，无法判定文本→`uncertain`，
 *   空转写/提供者无法判定 → `INPUT_UNCERTAIN`，超长与畸形区间 → `PROVIDER_OUTCOME_UNKNOWN`。
 * - 契约**没有**规定同键同体并发时未占位方应当收到什么。本实现优先**收敛**（等待后回放同一结果），
 *   仅在等待预算内仍未落定时才回契约内的 `REQUEST_IN_PROGRESS`（仍不重复执行副作用）。
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
import type { SpeechMediaPort } from './media.ts';
import type { ProviderFailureCode, SpeechProvider } from './provider.ts';
import {
  CONFIRMATION_VALUE,
  SpeechProtocolError,
  type JobState,
  type TranscriptionProjection,
  type UncertainSpan,
  isEmptyTranscript,
  normalizeConfirmedText,
  normalizeModelVersion,
  normalizeUncertainSpans,
  requireTranscriptText,
} from './state.ts';
import type { SpeechJobRow, SpeechStore, TranscriptionRow } from './store.ts';

/** 任务截止时间（毫秒）：超过即 `timed_out`，且迟到结果不复活任务。 */
export const DEFAULT_JOB_DEADLINE_MS = 30 * 1000;
/** 幂等键长度口径与认证层一致（8..128）。 */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
/**
 * 同键并发时未占位方的等待预算（毫秒）：在预算内等待占位者落定并**收敛**同一响应，
 * 超时才回 `REQUEST_IN_PROGRESS`。等待用真实墙钟（`Date.now()`）而不是注入的 `now()`，
 * 避免测试注入停表时钟时等待循环不退出。
 */
export const DEFAULT_IDEMPOTENCY_WAIT_MS = 3 * 1000;
/** 占位轮询间隔（毫秒）。 */
export const IDEMPOTENCY_POLL_MS = 2;
/** 占位尝试次数：占位者失败释放占位后，本请求最多再尝试一次（不无限重试）。 */
export const CLAIM_ATTEMPTS = 2;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IF_MATCH_PATTERN = /^"[1-9][0-9]*"$/;

export interface MediaJobInput {
  media_id: string;
  media_revision: number;
}

/** 契约 Job 投影（本任务只允许 kind='transcription'）。 */
export interface JobProjection {
  id: string;
  revision: number;
  kind: 'transcription';
  target_ref: { type: 'transcription'; id: string; revision: number };
  state: JobState;
  deadline_at: string;
  created_at: string;
  error_code: ErrorCode | null;
  result: { kind: 'transcription'; value: TranscriptionProjection } | null;
}

export interface SpeechServiceOptions {
  store: SpeechStore;
  provider: SpeechProvider;
  media: SpeechMediaPort;
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

/** 把域内协议错误统一映射为契约 400 INVALID_REQUEST（不透出内部结构）。 */
function asInvalidRequest(error: SpeechProtocolError, field: string): ApiError {
  return invalidRequest(error.message, field);
}

/** 校验 body 恰为 `MediaJobInput`（additionalProperties:false：多余字段 400）。 */
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

/** 校验 body 恰为 `ConfirmTranscriptionInput`（两字段全必填，`confirmation` 必须是契约常量）。 */
export function requireConfirmInput(body: unknown): { confirmed_text: string; confirmation: typeof CONFIRMATION_VALUE } {
  if (!isPlainObject(body)) throw invalidRequest('请求体必须是对象');
  const extra = Object.keys(body).filter((key) => key !== 'confirmed_text' && key !== 'confirmation');
  if (extra.length > 0) throw invalidRequest('请求体含未定义字段', `/${extra[0]}`);
  if (!('confirmed_text' in body) || !('confirmation' in body)) {
    throw invalidRequest('缺少必填字段 confirmed_text / confirmation');
  }
  if (body['confirmation'] !== CONFIRMATION_VALUE) {
    throw invalidRequest(`confirmation 必须是 "${CONFIRMATION_VALUE}"`, '/confirmation');
  }
  try {
    return {
      confirmed_text: normalizeConfirmedText(body['confirmed_text'], 'confirmed_text'),
      confirmation: CONFIRMATION_VALUE,
    };
  } catch (error) {
    if (error instanceof SpeechProtocolError) throw asInvalidRequest(error, '/confirmed_text');
    throw error;
  }
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

/**
 * 校验提供者转写载荷（适配层约定形状 `{text, uncertain_spans}`，两键都必须显式出现）。
 * **fail-closed**：缺字段 / 多余字段 / 类型不符 / 超长 / 区间畸形一律抛错，
 * 绝不补造空区间、绝不截断文本。
 */
export function requireTranscriptPayload(payload: unknown): { text: string; spans: UncertainSpan[] } {
  if (!isPlainObject(payload)) throw new SpeechProtocolError('转写载荷必须是对象');
  const extra = Object.keys(payload).filter((key) => key !== 'text' && key !== 'uncertain_spans');
  if (extra.length > 0) throw new SpeechProtocolError(`转写载荷含未定义字段 ${extra[0]}`);
  if (!('text' in payload) || !('uncertain_spans' in payload)) {
    throw new SpeechProtocolError('转写载荷缺少 text / uncertain_spans（不得默认成空区间）');
  }
  return {
    text: requireTranscriptText(payload['text'], 'raw_text'),
    spans: normalizeUncertainSpans(payload['uncertain_spans']),
  };
}

export function toTranscription(row: TranscriptionRow): TranscriptionProjection {
  return {
    id: row.id,
    revision: row.revision,
    // raw_text 永远来自模型原始输出，**不受** confirmed_text 影响。
    raw_text: row.rawText,
    uncertain_spans: row.uncertainSpans.map((span) => ({ start: span.start, end: span.end, reason: span.reason })),
    confirmed_text: row.confirmedText,
    confirmed_at: row.confirmedAt === null ? null : row.confirmedAt.toISOString(),
    model_version: row.modelVersion,
  };
}

export function toJob(row: SpeechJobRow, transcription: TranscriptionRow | null): JobProjection {
  const usable = transcription !== null && !transcription.deleted && row.state === 'succeeded';
  return {
    id: row.id,
    revision: row.revision,
    kind: 'transcription',
    // 未产出记录时 target_ref.revision 用 1 占位（实现层选择：契约要求 revision>=1，
    // 而此时并不存在可引用的记录版本）。
    target_ref: { type: 'transcription', id: row.transcriptionId, revision: transcription === null ? 1 : transcription.revision },
    state: row.state,
    deadline_at: row.deadlineAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    error_code: row.errorCode,
    result: usable ? { kind: 'transcription', value: toTranscription(transcription) } : null,
  };
}

/** 提供者失败码 → 终态 JobState（绝不落 succeeded）。 */
export function stateForProviderFailure(code: ProviderFailureCode): JobState {
  return code === 'PROVIDER_TIMEOUT' ? 'timed_out' : 'failed';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createSpeechService(options: SpeechServiceOptions) {
  const store = options.store;
  const provider = options.provider;
  const media = options.media;
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => randomUUID());
  const jobDeadlineMs = options.jobDeadlineMs ?? DEFAULT_JOB_DEADLINE_MS;
  const idempotencyWaitMs = options.idempotencyWaitMs ?? DEFAULT_IDEMPOTENCY_WAIT_MS;
  const idempotencyHmacKey = options.idempotencyHmacKey;
  const inFlight = new Set<Promise<void>>();
  /** 真实调用提供者的累计次数（仅在 runProviderWithDeadline 真正发起调用处 +1）。 */
  let providerCalls = 0;

  function scopeFor(userId: string, method: string, routePath: string): string {
    return idempotencyScope(userId, method, routePath);
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
        // 占位阶段即写入结果引用（create 路径的 job_id 在占位前已生成），
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

  /** 占位者完成业务后写入最终结果引用（并解除 pending）。 */
  async function finalizeIdempotentScope(scope: string, key: string, payload: Record<string, unknown>): Promise<void> {
    await store.finalizeIdempotent(scope, idempotencyKeyHashHex(scope, key), payload);
  }

  /** 占位者业务失败时释放占位，避免同一 Idempotency-Key 的正常重试被永久判成处理中。 */
  async function releaseIdempotentScope(scope: string, key: string): Promise<void> {
    await store.releaseIdempotent(scope, idempotencyKeyHashHex(scope, key));
  }

  /** 同键请求仍在处理中且等待预算已用尽：契约内如实回报，绝不重复执行副作用。 */
  function inProgress(): ApiError {
    return new ApiError('REQUEST_IN_PROGRESS', '同一 Idempotency-Key 的请求正在处理中');
  }

  /**
   * 读改写路径（确认 / 删除）的幂等骨架：
   * 占位 → 执行 → 落定；冲突/失败 ⇒ 释放占位并如实抛错；同键并发 ⇒ 等待并收敛同一结果。
   */
  async function runIdempotentWrite<T>(
    scope: string,
    key: string,
    requestHash: string,
    at: Date,
    work: () => Promise<T>,
    replay: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      const claim = await claimIdempotentScope(scope, key, requestHash, {}, at);
      if (claim.kind === 'claimed') {
        try {
          const value = await work();
          await finalizeIdempotentScope(scope, key, { accepted: true });
          return value;
        } catch (error) {
          await releaseIdempotentScope(scope, key);
          throw error;
        }
      }
      const resolution = await awaitPlaceholder(scope, idempotencyKeyHashHex(scope, key), idempotencyWaitMs);
      if (resolution.kind === 'released') continue;
      if (resolution.kind === 'settled') return replay();
      throw inProgress();
    }
    throw inProgress();
  }

  async function getOwnedTranscription(userId: string, transcriptionId: string, allowDeleted = false): Promise<TranscriptionRow> {
    if (typeof transcriptionId !== 'string' || !UUID_PATTERN.test(transcriptionId)) {
      throw new ApiError('NOT_FOUND', '转写记录不存在');
    }
    const row = await store.getTranscription(transcriptionId);
    // 越权与不存在同形：不泄露存在性。
    if (row === null || row.ownerUserId !== userId || (row.deleted && !allowDeleted)) {
      throw new ApiError('NOT_FOUND', '转写记录不存在');
    }
    return row;
  }

  async function getOwnedJob(userId: string, jobId: string): Promise<SpeechJobRow> {
    if (typeof jobId !== 'string' || !UUID_PATTERN.test(jobId)) throw new ApiError('NOT_FOUND', '任务不存在');
    const row = await store.getJob(jobId);
    if (row === null || row.ownerUserId !== userId) throw new ApiError('NOT_FOUND', '任务不存在');
    return row;
  }

  /** 受理转写任务：202 语义 + Job（state=queued），随后异步执行。 */
  async function createTranscription(input: {
    userId: string;
    body: unknown;
    idempotencyKey: unknown;
  }): Promise<{ job: JobProjection; replayed: boolean }> {
    const mediaJobInput = requireMediaJobInput(input.body);
    const key = requireIdempotencyKey(input.idempotencyKey);
    // real 缺凭据/无已审适配器：**受理前** fail-closed，不建任务、不排队、不回退替身。
    if (!provider.available) {
      throw new ApiError('PROVIDER_UNAVAILABLE', provider.unavailableReason ?? 'ASR 提供者不可用');
    }
    const resolution = await media.resolve({
      ownerUserId: input.userId,
      mediaId: mediaJobInput.media_id,
      mediaRevision: mediaJobInput.media_revision,
    });
    if (!resolution.ok) throw new ApiError(resolution.code, '录音引用不可用');

    const at = now();
    const scope = scopeFor(input.userId, 'POST', `${API_PREFIX}/speech/transcriptions`);
    const requestHash = idempotencyRequestHash(mediaJobInput, undefined, idempotencyHmacKey);

    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      // 任务 id 在占位前生成：占位记录本身就是「这个键对应这个任务」的原子凭据。
      const jobId = idFactory();
      const transcriptionId = idFactory();
      const claim = await claimIdempotentScope(scope, key, requestHash, { job_id: jobId }, at);
      if (claim.kind === 'claimed') {
        const row: SpeechJobRow = {
          id: jobId,
          revision: 1,
          kind: 'transcription',
          ownerUserId: input.userId,
          transcriptionId,
          mediaId: mediaJobInput.media_id,
          mediaRevision: mediaJobInput.media_revision,
          state: 'queued',
          deadlineAt: new Date(at.getTime() + jobDeadlineMs),
          createdAt: at,
          updatedAt: at,
          errorCode: null,
        };
        // 先落任务，再解除 pending：解除 pending 之后任何同键请求都能读到该任务。
        try {
          await store.insertJob(row);
        } catch (error) {
          // 落库失败：释放占位，否则同键重试会被永久判成处理中。
          await releaseIdempotentScope(scope, key);
          throw error;
        }
        await finalizeIdempotentScope(scope, key, { job_id: jobId });
        track(execute(jobId));
        return { job: toJob(row, null), replayed: false };
      }

      // 同键重复请求：绝不新建任务、绝不重复调用提供者；等占位者落定后**收敛**同一响应。
      const resolutionState = await awaitPlaceholder(scope, idempotencyKeyHashHex(scope, key), idempotencyWaitMs);
      if (resolutionState.kind === 'released') continue;
      if (resolutionState.kind === 'settled') {
        const reservedJobId = resolutionState.payload['job_id'];
        if (typeof reservedJobId === 'string') {
          const existing = await store.getJob(reservedJobId);
          if (existing !== null && existing.ownerUserId === input.userId) {
            const transcription = existing.state === 'succeeded' ? await store.getTranscription(existing.transcriptionId) : null;
            return { job: toJob(existing, transcription), replayed: true };
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

  /** 执行一次转写：queued → running → 终态。任何异常都不得变成 succeeded。 */
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
    const value = outcome.value;
    if (value.kind === 'failed') {
      await commitTerminal(
        jobId,
        running,
        { state: stateForProviderFailure(value.code), errorCode: value.code },
        null,
      );
      return;
    }
    if (value.kind === 'uncertain') {
      // 提供者明确表示无法判定：落 uncertain 终态，**不编造文本、不写记录**。
      await commitTerminal(jobId, running, { state: 'uncertain', errorCode: 'INPUT_UNCERTAIN' }, null);
      return;
    }

    let text: string;
    let spans: UncertainSpan[];
    let modelVersion: string;
    try {
      const payload = requireTranscriptPayload(value.transcript);
      text = payload.text;
      spans = payload.spans;
      modelVersion = normalizeModelVersion(provider.modelVersion);
    } catch (error) {
      if (error instanceof SpeechProtocolError) {
        // 提供者协议违规（缺字段 / 多余字段 / 超长 / 区间畸形）：fail-closed，
        // **不截断、不修补、不补造**，不写记录。
        await commitTerminal(jobId, running, { state: 'failed', errorCode: 'PROVIDER_OUTCOME_UNKNOWN' }, null);
        return;
      }
      throw error;
    }

    if (isEmptyTranscript(text)) {
      // 空转写：无法判定文本 ⇒ uncertain 终态（不是 succeeded），不写记录。
      await commitTerminal(jobId, running, { state: 'uncertain', errorCode: 'INPUT_UNCERTAIN' }, null);
      return;
    }

    const finishedAt = now();
    const transcription: TranscriptionRow = {
      id: running.transcriptionId,
      revision: 1,
      ownerUserId: running.ownerUserId,
      mediaId: running.mediaId,
      mediaRevision: running.mediaRevision,
      rawText: text,
      uncertainSpans: spans,
      // 未经用户核对：confirmed_text / confirmed_at 恒为 null（不得替用户「确认」）。
      confirmedText: null,
      confirmedAt: null,
      modelVersion,
      createdAt: finishedAt,
      updatedAt: finishedAt,
      deleted: false,
    };
    await commitTerminal(jobId, running, { state: 'succeeded', errorCode: null }, transcription);
  }

  async function runProviderWithDeadline(job: SpeechJobRow): Promise<
    | { kind: 'timeout' }
    | { kind: 'threw' }
    | { kind: 'value'; value: Awaited<ReturnType<SpeechProvider['transcribe']>> }
  > {
    const remaining = Math.max(0, job.deadlineAt.getTime() - now().getTime());
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), remaining);
    });
    // 可观测计数（诊断/证据用，不含凭据、不改变语义）：真实调用提供者的次数。
    // 计数点就在真正发起调用的这一行，因此「受理前 fail-closed」时它必然为 0。
    providerCalls += 1;
    const call = provider
      .transcribe({ jobId: job.id, mediaId: job.mediaId, mediaRevision: job.mediaRevision })
      .then((value) => ({ kind: 'value' as const, value }))
      .catch(() => ({ kind: 'threw' as const }));
    try {
      return await Promise.race([call, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** 原子提交终态：CAS 失败（任务已被取消或已终态）→ 什么也不写，**旧回调不复活**。 */
  async function commitTerminal(
    jobId: string,
    running: SpeechJobRow,
    terminal: { state: JobState; errorCode: ErrorCode | null },
    transcription: TranscriptionRow | null,
  ): Promise<SpeechJobRow | null> {
    const at = now();
    return store.commitTerminal(jobId, running.revision, terminal, transcription, at);
  }

  async function getTranscription(input: { userId: string; transcriptionId: string }): Promise<TranscriptionProjection> {
    const row = await getOwnedTranscription(input.userId, input.transcriptionId);
    return toTranscription(row);
  }

  async function getJob(input: { userId: string; jobId: string }): Promise<JobProjection> {
    const row = await getOwnedJob(input.userId, input.jobId);
    const transcription =
      row.state === 'succeeded' ? await store.getTranscription(row.transcriptionId) : null;
    return toJob(row, transcription);
  }

  /**
   * 用户核对：**只写 `confirmed_text` + `confirmed_at`**，`raw_text` 与 `uncertain_spans`
   * 原样保留（存储层不变量兜底），revision 递增。
   *
   * 幂等占位先于版本校验：首次成功请求的**原样重试**必须回放首次结果，
   * 而不是被已自增的 revision 判成 409；同键并发则只有首个调用方能执行写入，
   * 落败者等待并收敛到同一结果。
   *
   * **不做相似度校验**：契约没有要求 `confirmed_text` 与 `raw_text` 相等；
   * 用户核对是人的判断，**不计入模型准确率**，也不得据此改写模型原始输出。
   */
  async function confirmTranscription(input: {
    userId: string;
    transcriptionId: string;
    body: unknown;
    ifMatch: unknown;
    idempotencyKey: unknown;
  }): Promise<TranscriptionProjection> {
    const confirmation = requireConfirmInput(input.body);
    const key = requireIdempotencyKey(input.idempotencyKey);
    const expectedRevision = requireIfMatch(input.ifMatch);
    const row = await getOwnedTranscription(input.userId, input.transcriptionId);
    const at = now();
    const scope = scopeFor(input.userId, 'PATCH', `${API_PREFIX}/speech/transcriptions/${input.transcriptionId}/confirmation`);
    const requestHash = idempotencyRequestHash(confirmation, `"${expectedRevision}"`, idempotencyHmacKey);
    return runIdempotentWrite(
      scope,
      key,
      requestHash,
      at,
      async () => {
        if (row.revision !== expectedRevision) {
          throw new ApiError('REVISION_CONFLICT', '转写记录版本与 If-Match 不一致');
        }
        const updated = await store.updateTranscription(row.id, expectedRevision, (current) => ({
          ...current,
          // 只写确认结果：rawText / uncertainSpans 原样不动（存储层不变量会兜底拒绝改写）。
          confirmedText: confirmation.confirmed_text,
          confirmedAt: at,
          revision: current.revision + 1,
          updatedAt: at,
        }));
        if (updated === null) throw new ApiError('REVISION_CONFLICT', '转写记录已被并发修改');
        return toTranscription(updated);
      },
      async () => {
        const current = await store.getTranscription(row.id);
        if (current === null) throw new ApiError('NOT_FOUND', '转写记录不存在');
        return toTranscription(current);
      },
    );
  }

  /**
   * 删除转写记录（归属者限定；软删除，revision 递增）。
   * 先做归属检查（allowDeleted：已删除记录仍属同一归属者，其幂等重放必须能被识别），
   * 这样越权请求不会消耗掉 Idempotency-Key。
   */
  async function deleteTranscription(input: {
    userId: string;
    transcriptionId: string;
    ifMatch: unknown;
    idempotencyKey: unknown;
  }): Promise<{ accepted: true }> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    const expectedRevision = requireIfMatch(input.ifMatch);
    const at = now();
    const row = await getOwnedTranscription(input.userId, input.transcriptionId, true);
    const scope = scopeFor(input.userId, 'DELETE', `${API_PREFIX}/speech/transcriptions/${input.transcriptionId}`);
    const requestHash = idempotencyRequestHash(null, `"${expectedRevision}"`, idempotencyHmacKey);
    return runIdempotentWrite<{ accepted: true }>(
      scope,
      key,
      requestHash,
      at,
      async () => {
        if (row.revision !== expectedRevision) {
          throw new ApiError('REVISION_CONFLICT', '转写记录版本与 If-Match 不一致');
        }
        const updated = await store.updateTranscription(row.id, expectedRevision, (current) => ({
          ...current,
          deleted: true,
          revision: current.revision + 1,
          updatedAt: at,
        }));
        if (updated === null) throw new ApiError('REVISION_CONFLICT', '转写记录已被并发修改');
        return { accepted: true as const };
      },
      async () => ({ accepted: true as const }),
    );
  }

  return {
    createTranscription,
    getTranscription,
    getJob,
    confirmTranscription,
    deleteTranscription,
    settle,
    /** 供证据文档/诊断：当前提供者与各端口标注（替身如实标注，不含凭据）。 */
    describe: () => ({
      executionMode: provider.executionMode,
      modelVersion: provider.modelVersion,
      providerNote: provider.note,
      providerAvailable: provider.available,
      providerUnavailableReason: provider.unavailableReason,
      mediaPort: media.kind,
      mediaNote: media.note,
      storePersistent: store.persistent,
      jobDeadlineMs,
      idempotencyWaitMs,
      /** 真实调用提供者的累计次数（诊断/证据用；受理前 fail-closed 时恒为 0）。 */
      providerCalls,
    }),
  };
}

export type SpeechService = ReturnType<typeof createSpeechService>;

/** 组装一个按执行模式接线的转写服务（阶段 2 的路由将直接复用本工厂）。 */
export function createSpeechServiceForMode(input: {
  executionMode: 'real' | 'stub' | 'preset_demo';
  provider: SpeechProvider;
  store: SpeechStore;
  media: SpeechMediaPort;
  idempotencyHmacKey: string;
  now?: () => Date;
  idFactory?: () => string;
  jobDeadlineMs?: number;
  idempotencyWaitMs?: number;
}): SpeechService {
  return createSpeechService({
    store: input.store,
    provider: input.provider,
    media: input.media,
    idempotencyHmacKey: input.idempotencyHmacKey,
    now: input.now,
    idFactory: input.idFactory,
    jobDeadlineMs: input.jobDeadlineMs,
    idempotencyWaitMs: input.idempotencyWaitMs,
  });
}
