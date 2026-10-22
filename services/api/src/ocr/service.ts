/**
 * GY-I10 标签 OCR 服务：受理、执行、原始字段、用户校正、登记核对与删除。
 *
 * 契约对齐（packages/contracts/openapi.json，未新增字段）：
 *   POST   /ocr                      createOCR  → 202 JobEnvelope
 *   GET    /ocr/{id}                 getOCR     → OCREnvelope
 *   DELETE /ocr/{id}                 deleteOCR  → 202 AckEnvelope
 *   PATCH  /ocr/{id}/correction      correctOCR → 200 OCREnvelope
 *   POST   /ocr/{id}/verify          verifyOCR  → 200 VerificationEnvelope
 *
 * fail-closed 要点（监工 2026-10-11 对 #82 的 CHANGES_REQUESTED 口径）：
 * - 未受理成功之前不创建任何 OCR 记录；failed / timed_out / cancelled **不产生** OCR 记录，
 *   GET 对它们如实 404，绝不产出「看起来成功」的空记录；
 * - 提供者失败/超时/协议违规一律落 failed / timed_out，并把 error_code 写在 Job 上，
 *   **不得**把失败写成 succeeded，**不得**静默回退替身；
 * - `missing_fields` 非空 ⇒ match_state 不得为 matched；登记库不可用 ⇒ `unavailable`；
 * - `dose_cards` 只在「matched + 条件齐全 + 绑定同一登记制剂 + 来源非模拟/未过期/已核对」时非空，
 *   其余一律 []，**绝不凭空补造剂量**；
 * - 越权与不存在一律 NOT_FOUND，不泄露存在性；revision 不一致 ⇒ REVISION_CONFLICT；
 * - `correctOCR` 只写 corrected_fields，**绝不覆写 raw_fields**（契约明文：保留 raw_fields，
 *   revision 递增并 invalidate 旧登记核对；不把手改计模型准确率）。
 *
 * 本文件不注册任何 HTTP 路由（属阶段 2）；本文件不改 `services/api/src/app.ts`。
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
import type { OcrMediaPort } from './media.ts';
import type { OcrProvider, ProviderFailureCode } from './provider.ts';
import type { OcrDosePort, OcrReferencePort } from './reference.ts';
import {
  OcrProtocolError,
  appendCorrection,
  assertDoseNotProduced,
  assertRawPreserved,
  decideMatchState,
  deriveOcrVerdict,
  diffLabelFields,
  gateDoseCards,
  isTerminalJobState,
  normalizeConditions,
  normalizeLabelFields,
  sanitizeRegistryLookup,
  toVerificationProjection,
  type Conditions,
  type JobState,
  type LabelFields,
  type OcrVerification,
  type RegistryLookup,
} from './state.ts';
import type { OcrJobRow, OcrRow, OcrStore } from './store.ts';

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

/** 契约 OCR 投影（additionalProperties:false，六字段全必填）。 */
export interface OcrProjection {
  id: string;
  revision: number;
  raw_fields: LabelFields;
  corrected_fields: LabelFields;
  verification: OcrVerification;
  model_version: string;
}

/** 契约 Job 投影（本任务只允许 kind='ocr'）。 */
export interface JobProjection {
  id: string;
  revision: number;
  kind: 'ocr';
  target_ref: { type: 'ocr'; id: string; revision: number };
  state: JobState;
  deadline_at: string;
  created_at: string;
  error_code: ErrorCode | null;
  result: { kind: 'ocr'; value: OcrProjection } | null;
}

/**
 * 标签 OCR 任务**终态**写入服务端识别历史的端口（GY-I16 #16 的跨线接线）。
 *
 * 与识别域同形的第二份声明（`recognitions/service.ts` 的 `RecognitionTerminalHistoryPort`）：
 * 两个域互不 import（`ocr/media.ts:13-14` 的既有口径），因此各自声明自己需要的形状，
 * **真正的接线只有一处** —— 装配层 `services/api/src/app.ts` 把它接到历史域的内部创建口
 * `appendHistory(input)`（不是契约 operationId、不注册路由）。
 *
 * 调用契约与识别域**逐条相同**：只在终态提交成功后调用；`job_state` 取实际落库值；
 * `target_ref` 指向 OCR 记录（`GET /ocr/{id}` 是详情面的权威）；幂等由装配层的
 * **确定性** `event_key` 保证（同一次任务重复投递 = no-op）；端口抛错由本域吞掉并记告警
 * —— 已落库的终态不因历史写入失败而改写，也绝不伪造"成功"。
 */
export interface OcrTerminalHistoryInput {
  /** 归属者（服务端解析出的用户 id，绝不来自客户端）。 */
  owner_id: string;
  kind: 'ocr';
  target_ref: { type: 'ocr'; id: string; revision: number };
  /** 内部作业标识（历史行读取时用它核对实时状态）。 */
  job_id: string;
  /** **实际落库**的终态。 */
  job_state: JobState;
}

export interface OcrTerminalHistoryPort {
  /** 端口接线状态：`wired`=装配层已接到历史域内部创建口；`unwired`=未接线（只告警，不写）。 */
  readonly kind: 'wired' | 'unwired';
  /** 供证据文档/诊断引用的说明（可安全公开：不含归属与目标正文）。 */
  readonly note: string;
  recordTerminal(input: OcrTerminalHistoryInput): Promise<void>;
}

/**
 * 未接线端口（**合法**的 fail-closed 端口：OCR 任务照常跑，只是历史里没有它的一行）。
 * `real` 模式下历史域整域关闭（`historyService === null`）⇒ 本端口就是这一支。
 */
export function createUnwiredOcrTerminalHistoryPort(
  note = 'OCR 终态写入历史的端口尚未接线：任务照常执行，但不产生服务端历史行',
): OcrTerminalHistoryPort {
  return {
    kind: 'unwired',
    note,
    async recordTerminal() {
      // 未接线 = 什么都不做（**不是**假装写成功、也不是回退替身）。
    },
  };
}

export interface OcrServiceOptions {
  store: OcrStore;
  provider: OcrProvider;
  media: OcrMediaPort;
  reference: OcrReferencePort;
  dose: OcrDosePort;
  /** 幂等请求摘要密钥（服务端密钥，不入库、不下发）。 */
  idempotencyHmacKey: string;
  /**
   * 终态写入服务端识别历史的端口（**可选**；缺省 = 未接线 fail-closed，见端口注释）。
   * 接线属跨线，装配点唯一：`services/api/src/app.ts`（经 `routes/ocr.ts` 的 `deps.history` 传入）。
   */
  history?: OcrTerminalHistoryPort;
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

/** 把域内协议错误统一映射为契约 400 INVALID_REQUEST（不透出内部结构）。 */
function asInvalidRequest(error: OcrProtocolError, field: string): ApiError {
  return invalidRequest(error.message, field);
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

/** 校验 body 恰为 OCRCorrectionInput。 */
export function requireOcrCorrectionInput(body: unknown): { corrected_fields: LabelFields } {
  if (!isPlainObject(body)) throw invalidRequest('请求体必须是对象');
  const extra = Object.keys(body).filter((key) => key !== 'corrected_fields');
  if (extra.length > 0) throw invalidRequest('请求体含未定义字段', `/${extra[0]}`);
  if (!('corrected_fields' in body)) throw invalidRequest('缺少必填字段 corrected_fields');
  try {
    return { corrected_fields: normalizeLabelFields(body['corrected_fields'], 'corrected_fields') };
  } catch (error) {
    if (error instanceof OcrProtocolError) throw asInvalidRequest(error, '/corrected_fields');
    throw error;
  }
}

/** 校验 body 恰为 VerifyInput（fields 必填，conditions 可选；additionalProperties:false）。 */
export function requireVerifyInput(body: unknown): { fields: LabelFields; conditions: Conditions | null } {
  if (!isPlainObject(body)) throw invalidRequest('请求体必须是对象');
  const extra = Object.keys(body).filter((key) => key !== 'fields' && key !== 'conditions');
  if (extra.length > 0) throw invalidRequest('请求体含未定义字段', `/${extra[0]}`);
  if (!('fields' in body)) throw invalidRequest('缺少必填字段 fields');
  let fields: LabelFields;
  try {
    fields = normalizeLabelFields(body['fields'], 'fields');
  } catch (error) {
    if (error instanceof OcrProtocolError) throw asInvalidRequest(error, '/fields');
    throw error;
  }
  const rawConditions = body['conditions'];
  if (rawConditions === undefined || rawConditions === null) return { fields, conditions: null };
  try {
    return { fields, conditions: normalizeConditions(rawConditions, 'conditions') };
  } catch (error) {
    if (error instanceof OcrProtocolError) throw asInvalidRequest(error, '/conditions');
    throw error;
  }
}

export function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < IDEMPOTENCY_KEY_MIN_LENGTH || value.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
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

function toOcr(row: OcrRow): OcrProjection {
  return {
    id: row.id,
    revision: row.revision,
    // raw_fields 永远来自模型原始输出，**不受** corrected_fields 影响。
    raw_fields: {
      registration_number: row.rawFields.registration_number,
      name: row.rawFields.name,
      ingredients: row.rawFields.ingredients.map((item) => ({ ...item })),
      dosage_form: row.rawFields.dosage_form,
    },
    corrected_fields: {
      registration_number: row.correctedFields.registration_number,
      name: row.correctedFields.name,
      ingredients: row.correctedFields.ingredients.map((item) => ({ ...item })),
      dosage_form: row.correctedFields.dosage_form,
    },
    verification: toVerificationProjection(row.verification),
    model_version: row.modelVersion,
  };
}

export function toJob(row: OcrJobRow, ocr: OcrRow | null): JobProjection {
  const usable = ocr !== null && !ocr.deleted && (row.state === 'succeeded' || row.state === 'uncertain');
  return {
    id: row.id,
    revision: row.revision,
    kind: 'ocr',
    target_ref: { type: 'ocr', id: row.ocrId, revision: ocr === null ? 1 : ocr.revision },
    state: row.state,
    deadline_at: row.deadlineAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    error_code: row.errorCode,
    result: usable ? { kind: 'ocr', value: toOcr(ocr) } : null,
  };
}

/** 提供者失败码 → 终态 JobState（绝不落 succeeded）。 */
export function stateForProviderFailure(code: ProviderFailureCode): JobState {
  return code === 'PROVIDER_TIMEOUT' ? 'timed_out' : 'failed';
}

export function createOcrService(options: OcrServiceOptions) {
  const store = options.store;
  const provider = options.provider;
  const media = options.media;
  const reference = options.reference;
  const dose = options.dose;
  /** 终态 → 服务端识别历史（GY-I16 #16 接线；缺省未接线，见 `OcrTerminalHistoryPort`）。 */
  const historyPort = options.history ?? createUnwiredOcrTerminalHistoryPort();
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => randomUUID());
  const jobDeadlineMs = options.jobDeadlineMs ?? DEFAULT_JOB_DEADLINE_MS;
  const idempotencyHmacKey = options.idempotencyHmacKey;
  const inFlight = new Set<Promise<void>>();
  /** 真实调用提供者的累计次数（仅在 `runProviderWithDeadline` 真正发起调用处 +1）。 */
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

  /**
   * **原子占位**（先占位、再建任务）：消除 check-then-act 竞态。
   *
   * 之前的写法是「先 find 判空 → 再 insert」，同键并发时两个调用方都会看到空台账，
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
        // 因此重复请求无需等待就能定位到同一个任务。
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

  /** 占位者完成业务后写入最终结果引用（并解除 pending）。 */
  async function finalizeIdempotentScope(scope: string, key: string, payload: Record<string, unknown>): Promise<void> {
    await store.finalizeIdempotent(scope, idempotencyKeyHashHex(scope, key), payload);
  }

  /** 占位者业务失败时释放占位，避免同一 Idempotency-Key 的正常重试被永久判成处理中。 */
  async function releaseIdempotentScope(scope: string, key: string): Promise<void> {
    await store.releaseIdempotent(scope, idempotencyKeyHashHex(scope, key));
  }

  /** 同键请求仍在处理中：契约内如实回报，绝不重复执行副作用。 */
  function inProgress(): ApiError {
    // `retryable: true`：同键请求仍在跑是**时间能解决的**瞬时态（等待后重放不重复执行副作用）；且 HTTP 出口
    // 对 `REQUEST_IN_PROGRESS` 已发 `Retry-After: 1`（`services/api/src/app.ts:1837`）并声明"等待后可重试原请求"。
    return new ApiError('REQUEST_IN_PROGRESS', '同一 Idempotency-Key 的请求正在处理中', { retryable: true });
  }

  async function getOwnedOcr(userId: string, ocrId: string, allowDeleted = false): Promise<OcrRow> {
    if (typeof ocrId !== 'string' || !UUID_PATTERN.test(ocrId)) throw new ApiError('NOT_FOUND', 'OCR 记录不存在');
    const row = await store.getOcr(ocrId);
    // 越权与不存在同形：不泄露存在性。
    if (row === null || row.ownerUserId !== userId || (row.deleted && !allowDeleted)) {
      throw new ApiError('NOT_FOUND', 'OCR 记录不存在');
    }
    return row;
  }

  async function getOwnedJob(userId: string, jobId: string): Promise<OcrJobRow> {
    if (typeof jobId !== 'string' || !UUID_PATTERN.test(jobId)) throw new ApiError('NOT_FOUND', '任务不存在');
    const row = await store.getJob(jobId);
    if (row === null || row.ownerUserId !== userId) throw new ApiError('NOT_FOUND', '任务不存在');
    return row;
  }

  /**
   * 由「标签字段 + 可选条件」产生 Verification。步骤即 fail-closed 链：
   *   1) 查登记库：不可用 → unavailable（**不**伪装成 no_match）；返回物经 `sanitizeRegistryLookup`
   *      逐字段收敛，无法解析一律当 unavailable（**不**丢坏候选保留好候选，避免 ambiguous 静默变 matched）；
   *   2) 纯函数判定 match_state（missing_fields / conflict_fields / ambiguous 的硬规则在 state.ts）；
   *   3) **只有 matched** 才去取用量卡候选；
   *   4) 候选按**不可信载荷**交给 gate，由 gate 校验并重新投影出真正能下发的卡。
   *
   * 注意：生产装配的用量端口（替身 / 未接线）**恒返回空候选**，因此
   * `dose_cards` 在生产路径恒为 `[]`（#7 验收第 3 条：不对模拟记录显示真实用量）。
   * gate 的通过面由测试**注入**可信来源证明，绝不靠替身数据扮演可信来源。
   */
  async function verifyFields(fields: LabelFields, conditions: Conditions | null): Promise<OcrVerification> {
    let lookup: RegistryLookup;
    try {
      lookup = sanitizeRegistryLookup(await reference.lookup({ registrationNumber: fields.registration_number, name: fields.name }));
    } catch {
      // 登记库抛错等同不可用：**不得**降级成 no_match。
      lookup = { status: 'unavailable', reason: '登记库查询异常' };
    }
    const decision = decideMatchState(fields, lookup);

    let candidates: unknown = [];
    const registrationNumber = decision.registration === null ? null : decision.registration.formulation.registration_number;
    if (decision.match_state === 'matched' && registrationNumber !== null) {
      try {
        candidates = await dose.listCandidates({ registrationNumber });
      } catch {
        // 用量来源异常等同无候选：宁可 dose_cards 为空，也不补造剂量。
        candidates = [];
      }
    }

    // gate 以**本次核对命中的权威登记记录**为准做制剂交叉核对（收口"登记制剂绑定"）；
    // 载荷自身仍按不可信数据处理，且 gate 是全域的（不抛错）——这里再兜一层：任何意外一律"不放行"。
    let doseCards: OcrVerification['dose_cards'] = [];
    try {
      doseCards = gateDoseCards({ candidates, conditions, registration: decision.registration }).dose_cards;
    } catch {
      doseCards = [];
    }

    // 稳定状态码（四类明确状态：冲突 / 无匹配 / 多结果 / 已失效）+ 用量阻断守卫。
    // 为什么还要这道带：上面「只有 matched 才取候选」是**取数**门，这里是**下发**门。
    // 两门独立 —— 任一处被改坏，另一处仍拦住；两门同时被改坏时
    // `tests/unit/ocr-match-gate.test.mjs` 的负控制臂必红（真删除那行 dosage_form 比对即复现）。
    const verdict = deriveOcrVerdict({
      match_state: decision.match_state,
      conflict_fields: decision.conflict_fields,
    });
    // 已阻断却仍带出用量卡 ⇒ 抛错（fail-closed，不静默吞掉上游门的丢失）。
    assertDoseNotProduced(verdict, doseCards);
    const gatedDoseCards: OcrVerification['dose_cards'] = verdict.dose_blocked ? [] : doseCards;

    return {
      match_state: decision.match_state,
      registration: decision.registration,
      conflict_fields: decision.conflict_fields,
      missing_fields: decision.missing_fields,
      dose_cards: gatedDoseCards,
    };
  }

  /** 受理标签 OCR 任务：202 + Job（state=queued），随后异步执行。 */
  async function createOcr(input: {
    userId: string;
    body: unknown;
    idempotencyKey: unknown;
  }): Promise<{ job: JobProjection; replayed: boolean }> {
    const mediaJobInput = requireMediaJobInput(input.body);
    const key = requireIdempotencyKey(input.idempotencyKey);
    // real 缺凭据/无已审适配器：受理前 fail-closed，不排队、不回退替身。
    // `retryable: false` 显式写出（与省略时的默认值一致，但不再依赖默认值）：这是"能力未装配／未接线"
    // （需运维改配置），不是瞬时故障 —— 同一请求原样重试不会成功。口径原文见 `services/api/src/errors.ts`。
    if (!provider.available) {
      throw new ApiError('PROVIDER_UNAVAILABLE', provider.unavailableReason ?? 'OCR 提供者不可用', {
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
    const scope = scopeFor(input.userId, 'POST', `${API_PREFIX}/ocr`);
    const requestHash = idempotencyRequestHash(mediaJobInput, undefined, idempotencyHmacKey);

    // 任务 id 在占位前生成：占位记录本身就是「这个键对应这个任务」的原子凭据。
    const jobId = idFactory();
    const ocrId = idFactory();
    const claim = await claimIdempotentScope(scope, key, requestHash, { job_id: jobId }, at);
    if (claim.kind === 'existing') {
      // 同键重复请求：绝不新建任务、绝不重复调用提供者。
      const reservedJobId = claim.payload['job_id'];
      if (typeof reservedJobId === 'string') {
        const existing = await store.getJob(reservedJobId);
        if (existing !== null && existing.ownerUserId === input.userId) {
          const ocr = await store.getOcr(existing.ocrId);
          return { job: toJob(existing, ocr), replayed: true };
        }
      }
      // 占位者尚未把任务落库：如实回 REQUEST_IN_PROGRESS，由客户端稍后重试。
      throw inProgress();
    }

    const row: OcrJobRow = {
      id: jobId,
      revision: 1,
      kind: 'ocr',
      ownerUserId: input.userId,
      ocrId,
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

  /** 执行一次标签 OCR：queued → running → 终态。任何异常都不得变成 succeeded。 */
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

    let rawFields: LabelFields;
    try {
      rawFields = normalizeLabelFields(outcome.value.fields, 'raw_fields');
    } catch (error) {
      if (error instanceof OcrProtocolError) {
        // 提供者协议违规（缺字段 / 多余字段 / 越界）：fail-closed，不修补、不补造。
        await commitTerminal(jobId, running, { state: 'failed', errorCode: 'PROVIDER_OUTCOME_UNKNOWN' }, null);
        return;
      }
      throw error;
    }

    // 首次核对**不带条件**：因此 dose_cards 必为 []（条件未采集不得给剂量）。
    const verification = await verifyFields(rawFields, null);
    const finishedAt = now();
    const ocr: OcrRow = {
      id: running.ocrId,
      revision: 1,
      ownerUserId: running.ownerUserId,
      mediaId: running.mediaId,
      mediaRevision: running.mediaRevision,
      rawFields,
      // 尚未校正：corrected_fields 初始等于原始输出，但此后两者独立演进。
      correctedFields: { ...rawFields, ingredients: rawFields.ingredients.map((item) => ({ ...item })) },
      verification,
      modelVersion: provider.modelVersion,
      createdAt: finishedAt,
      updatedAt: finishedAt,
      deleted: false,
    };
    await commitTerminal(jobId, running, { state: 'succeeded', errorCode: null }, ocr);
  }

  async function runProviderWithDeadline(job: OcrJobRow): Promise<
    | { kind: 'timeout' }
    | { kind: 'threw' }
    | { kind: 'value'; value: Awaited<ReturnType<OcrProvider['extract']>> }
  > {
    const remaining = Math.max(0, job.deadlineAt.getTime() - now().getTime());
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), remaining);
    });
    // 可观测计数（诊断/证据用；不含凭据、不改变语义）：**真正发起提供者调用**的次数。
    // 计数点就在下面这一行，因此「受理前 fail-closed」时它必然为 0；
    // 也用于在真实装配上证明「同键同体并发只调用一次」。
    providerCalls += 1;
    const call = provider
      .extract({ jobId: job.id, mediaId: job.mediaId, mediaRevision: job.mediaRevision })
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
   * 提交**成功后**把该终态交给历史端口落一行服务端识别历史（GY-I16 #16）：
   * `job_state` 取**返回值**（实际落库的终态），端口抛错只记告警（已落库的终态不因历史写入失败改写）。
   */
  async function commitTerminal(
    jobId: string,
    running: OcrJobRow,
    terminal: { state: JobState; errorCode: ErrorCode | null },
    ocr: OcrRow | null,
  ): Promise<OcrJobRow | null> {
    const at = now();
    const committed = await store.commitTerminal(jobId, running.revision, terminal, ocr, at);
    if (committed !== null) {
      await recordTerminalHistory({
        owner_id: committed.ownerUserId,
        kind: 'ocr',
        target_ref: { type: 'ocr', id: committed.ocrId, revision: ocr === null ? 1 : ocr.revision },
        job_id: committed.id,
        job_state: committed.state,
      });
    }
    return committed;
  }

  /** 把一次**已落库**的终态交给历史端口（吞掉端口异常，不改变任务结果）。 */
  async function recordTerminalHistory(input: OcrTerminalHistoryInput): Promise<void> {
    try {
      await historyPort.recordTerminal(input);
    } catch (error) {
      console.warn(
        `GY-I16 OCR 终态历史写入失败（端口=${historyPort.kind}，job_state=${input.job_state}）：`,
        error instanceof Error ? error.message : typeof error,
      );
    }
  }

  async function getOcr(input: { userId: string; ocrId: string }): Promise<OcrProjection> {
    const row = await getOwnedOcr(input.userId, input.ocrId);
    return toOcr(row);
  }

  async function getJob(input: { userId: string; jobId: string }): Promise<JobProjection> {
    const row = await getOwnedJob(input.userId, input.jobId);
    const ocr = row.state === 'succeeded' || row.state === 'uncertain' ? await store.getOcr(row.ocrId) : null;
    return toJob(row, ocr);
  }

  /**
   * 取消作业：`queued` / `running` → `cancelled`，revision **恰好 +1**（单次 CAS，不 +2）。
   *
   * 口径与校正/删除一致：`Idempotency-Key` 幂等 + `If-Match` 乐观并发；状态机由 OCR 域
   * 自己决定（`canTransitionJob` 已允许 queued→cancelled、running→cancelled，不新增迁移边）：
   * - 终态（succeeded / uncertain / failed / timed_out / cancelled）不可再取消 ⇒ OBJECT_UNAVAILABLE；
   * - 版本不符 ⇒ REVISION_CONFLICT；
   * - 取消后 `execute` 的迟到结果因 `commitTerminal` 的 CAS 失败**不复活**（状态机保证，
   *   而非「删除记录」），因此这里既不删记录、也不改写已落库的 OCR。
   */
  async function cancelJob(input: {
    userId: string;
    jobId: string;
    ifMatch: unknown;
    idempotencyKey: unknown;
  }): Promise<JobProjection> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    const expectedRevision = requireIfMatch(input.ifMatch);
    // 归属检查先行：越权/不存在同形 NOT_FOUND，且不消耗调用方的 Idempotency-Key。
    const row = await getOwnedJob(input.userId, input.jobId);
    const at = now();
    const scope = scopeFor(input.userId, 'POST', `${API_PREFIX}/jobs/${input.jobId}/cancel`);
    const requestHash = idempotencyRequestHash(null, `"${expectedRevision}"`, idempotencyHmacKey);
    // 幂等占位先于版本/终态校验：首次成功取消的**原样重试**必须回放首次结果，
    // 而不是被已自增的 revision 判成 409、或被已落地的 cancelled 判成冲突。
    const claim = await claimIdempotentScope(scope, key, requestHash, {}, at);
    if (claim.kind === 'existing') {
      if (claim.pending) throw inProgress();
      return getJob({ userId: input.userId, jobId: input.jobId });
    }
    try {
      if (row.revision !== expectedRevision) {
        throw new ApiError('REVISION_CONFLICT', '作业版本与 If-Match 不一致');
      }
      if (isTerminalJobState(row.state)) {
        throw new ApiError('OBJECT_UNAVAILABLE', `作业已处于终态 ${row.state}，不可取消`);
      }
      const updated = await store.updateJob(row.id, expectedRevision, (current) => ({
        ...current,
        state: 'cancelled',
        errorCode: null,
        revision: current.revision + 1,
        updatedAt: at,
      }));
      if (updated === null) throw new ApiError('REVISION_CONFLICT', '作业状态已变化，未能取消');
      await finalizeIdempotentScope(scope, key, { job_id: updated.id });
      // cancelled 不产出 OCR 记录 ⇒ result 恒为 null（与 failed / timed_out 同形）。
      return toJob(updated, null);
    } catch (error) {
      await releaseIdempotentScope(scope, key);
      throw error;
    }
  }

  /**
   * 用户校正：**只写 corrected_fields**，raw_fields 原样保留，revision 递增，
   * 并按 corrected_fields **重算** verification（旧登记核对随之失效，不留陈旧结论）。
   *
   * **实现层口径声明（契约未规定，指挥已接受现状）**：契约只要求「保留 raw_fields、
   * revision 递增并 invalidate 旧登记核对」，**没有**规定失效后该如何重算，也没有规定
   * `verification` 应该绑定哪一份字段。本实现选择「按 corrected_fields、在**无 conditions**
   * 下重算」，因此校正后的 `verification.dose_cards` 必然为 `[]`（条件未随校正提交）。
   * 这是本实现的选择，不是契约条文；若将来要求条件随行持久化，需先补契约字段。
   */
  async function correctOcr(input: {
    userId: string;
    ocrId: string;
    body: unknown;
    ifMatch: unknown;
    idempotencyKey: unknown;
  }): Promise<OcrProjection> {
    const correction = requireOcrCorrectionInput(input.body);
    const key = requireIdempotencyKey(input.idempotencyKey);
    const expectedRevision = requireIfMatch(input.ifMatch);
    const row = await getOwnedOcr(input.userId, input.ocrId);
    const at = now();
    const scope = scopeFor(input.userId, 'PATCH', `${API_PREFIX}/ocr/${input.ocrId}/correction`);
    const requestHash = idempotencyRequestHash(correction, `"${expectedRevision}"`, idempotencyHmacKey);
    // 幂等占位先于版本校验：首次成功请求的**原样重试**必须回放首次结果，
    // 而不是被已自增的 revision 判成 409；同键并发则只有首个调用方能执行写入。
    const claim = await claimIdempotentScope(scope, key, requestHash, {}, at);
    if (claim.kind === 'existing') {
      if (claim.pending) throw inProgress();
      const current = await store.getOcr(row.id);
      if (current === null) throw new ApiError('NOT_FOUND', 'OCR 记录不存在');
      return toOcr(current);
    }
    try {
      if (row.revision !== expectedRevision) throw new ApiError('REVISION_CONFLICT', 'OCR 记录版本与 If-Match 不一致');

      // 重算核对：条件未采集 → dose_cards 必为 []，且旧结论被替换而非并存。
      const verification = await verifyFields(correction.corrected_fields, null);
      const updated = await store.updateOcr(row.id, expectedRevision, (current) => {
        // 台账只**追加**：`raw_fields` 是模型原始输出的快照（不可覆盖），`corrected_fields`
        // 是校正后另存的这一版字段，`actor_user_id` / `changes` 回答「谁改的、改了什么」。
        // 同字段原样重提（diff 为空）不产生新版本 —— 保留旧行为（仍递增 revision），
        // 但不把「什么都没改」记成一次改写。
        const unchanged = diffLabelFields(current.correctedFields, correction.corrected_fields).length === 0;
        const correctionLog = unchanged
          ? current.verification.correction_log
          : appendCorrection(current.verification.correction_log, {
              actorUserId: input.userId,
              at,
              revision: current.revision + 1,
              before: current.correctedFields,
              after: correction.corrected_fields,
              raw: current.rawFields,
            });
        if (correctionLog !== undefined) assertRawPreserved(correctionLog, current.rawFields);
        return {
          ...current,
          // rawFields 原样不动 —— 模型原始输出始终可复核；校正不计入模型准确率。
          correctedFields: correction.corrected_fields,
          verification: correctionLog === undefined ? verification : { ...verification, correction_log: correctionLog },
          revision: current.revision + 1,
          updatedAt: at,
        };
      });
      if (updated === null) throw new ApiError('REVISION_CONFLICT', 'OCR 记录已被并发修改');
      await finalizeIdempotentScope(scope, key, { accepted: true });
      return toOcr(updated);
    } catch (error) {
      await releaseIdempotentScope(scope, key);
      throw error;
    }
  }

  /**
   * 登记核对：按提交的 fields + 可选 conditions 重算 verification 并落库（revision 递增）。
   * **不改** raw_fields，也**不改** corrected_fields —— 校正只走 correctOCR。
   *
   * **实现层口径声明（契约未规定，指挥已接受现状）**：`Verification` 是 `OCR` 上的必填字段，
   * 但契约**没有**规定 `verification` 必须与 `corrected_fields` 一致。本实现让 `verification`
   * 反映**最后一次请求提交的字段与条件**，因此在「先 correct 再 verify（或反之）」之后，
   * 落库的 `verification` 可能与 `corrected_fields` 不同步。这是本实现的选择，不是契约条文；
   * 选择它的理由是不让 verify 越权覆写用户校正结果（`corrected_fields` 只由 correctOCR 写）。
   */
  async function verifyOcr(input: {
    userId: string;
    ocrId: string;
    body: unknown;
    ifMatch: unknown;
    idempotencyKey: unknown;
  }): Promise<OcrVerification> {
    return (await verifyOcrWithRevision(input)).verification;
  }

  /**
   * 与 `verifyOcr` **同一实现**，额外带回记录 revision（供路由写契约要求的强 `ETag`）。
   *
   * 这是 HTTP 层需要的薄适配：契约 `verifyOCR` 的 200 响应声明了 `ETag: 资源revision强ETag`，
   * 而 `OcrVerification` 本身**不含** revision（契约 `Verification` 是 `additionalProperties:false`
   * 的五字段对象，不能往里塞字段）。与其让路由在 verify 之后再读一次记录（多一次 I/O 且有 TOCTOU），
   * 不如由服务层在同一次临界区内带出。**既有 `verifyOcr` 的返回值与语义完全不变。**
   */
  async function verifyOcrWithRevision(input: {
    userId: string;
    ocrId: string;
    body: unknown;
    ifMatch: unknown;
    idempotencyKey: unknown;
  }): Promise<{ verification: OcrVerification; revision: number }> {
    const verifyInput = requireVerifyInput(input.body);
    const key = requireIdempotencyKey(input.idempotencyKey);
    const expectedRevision = requireIfMatch(input.ifMatch);
    const row = await getOwnedOcr(input.userId, input.ocrId);
    const at = now();
    const scope = scopeFor(input.userId, 'POST', `${API_PREFIX}/ocr/${input.ocrId}/verify`);
    const requestHash = idempotencyRequestHash(verifyInput, `"${expectedRevision}"`, idempotencyHmacKey);
    const claim = await claimIdempotentScope(scope, key, requestHash, {}, at);
    if (claim.kind === 'existing') {
      if (claim.pending) throw inProgress();
      const current = await store.getOcr(row.id);
      if (current === null) throw new ApiError('NOT_FOUND', 'OCR 记录不存在');
      return { verification: toVerificationProjection(current.verification), revision: current.revision };
    }
    try {
      if (row.revision !== expectedRevision) throw new ApiError('REVISION_CONFLICT', 'OCR 记录版本与 If-Match 不一致');

      const verification = await verifyFields(verifyInput.fields, verifyInput.conditions);
      const updated = await store.updateOcr(row.id, expectedRevision, (current) => ({
        ...current,
        // 核对只替换契约五字段，**不得**擦掉用户校正台账（台账只由 correctOCR 追加）。
        verification:
          current.verification.correction_log === undefined
            ? verification
            : { ...verification, correction_log: current.verification.correction_log },
        revision: current.revision + 1,
        updatedAt: at,
      }));
      if (updated === null) throw new ApiError('REVISION_CONFLICT', 'OCR 记录已被并发修改');
      await finalizeIdempotentScope(scope, key, { accepted: true });
      return { verification: toVerificationProjection(updated.verification), revision: updated.revision };
    } catch (error) {
      await releaseIdempotentScope(scope, key);
      throw error;
    }
  }

  /** 删除 OCR 记录（归属者限定；软删除，revision 递增）。 */
  async function deleteOcr(input: {
    userId: string;
    ocrId: string;
    ifMatch: unknown;
    idempotencyKey: unknown;
  }): Promise<{ accepted: true }> {
    const result = await deleteOcrWithRevision(input);
    return { accepted: result.accepted };
  }

  /**
   * 与 `deleteOcr` **同一实现**，额外带回删除后的记录 revision
   * （供路由写契约 `deleteOCR` 202 响应声明的强 `ETag`）。既有 `deleteOcr` 返回值不变。
   */
  async function deleteOcrWithRevision(input: {
    userId: string;
    ocrId: string;
    ifMatch: unknown;
    idempotencyKey: unknown;
  }): Promise<{ accepted: true; revision: number }> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    const expectedRevision = requireIfMatch(input.ifMatch);
    const at = now();
    // 先做归属检查（allowDeleted：已删除记录仍属同一归属者，其幂等重放必须能被识别），
    // 这样越权请求不会消耗掉 Idempotency-Key。
    const row = await getOwnedOcr(input.userId, input.ocrId, true);
    const scope = scopeFor(input.userId, 'DELETE', `${API_PREFIX}/ocr/${input.ocrId}`);
    const requestHash = idempotencyRequestHash(null, `"${expectedRevision}"`, idempotencyHmacKey);
    const claim = await claimIdempotentScope(scope, key, requestHash, {}, at);
    if (claim.kind === 'existing') {
      if (claim.pending) throw inProgress();
      const current = await store.getOcr(row.id);
      if (current === null) throw new ApiError('NOT_FOUND', 'OCR 记录不存在');
      return { accepted: true, revision: current.revision };
    }
    try {
      if (row.revision !== expectedRevision) throw new ApiError('REVISION_CONFLICT', 'OCR 记录版本与 If-Match 不一致');
      const updated = await store.updateOcr(row.id, expectedRevision, (current) => ({
        ...current,
        deleted: true,
        revision: current.revision + 1,
        updatedAt: at,
      }));
      if (updated === null) throw new ApiError('REVISION_CONFLICT', 'OCR 记录已被并发修改');
      await finalizeIdempotentScope(scope, key, { accepted: true });
      return { accepted: true, revision: updated.revision };
    } catch (error) {
      await releaseIdempotentScope(scope, key);
      throw error;
    }
  }

  return {
    createOcr,
    getOcr,
    getJob,
    cancelJob,
    correctOcr,
    verifyOcr,
    verifyOcrWithRevision,
    deleteOcr,
    deleteOcrWithRevision,
    settle,
    /** 供证据文档/诊断：当前提供者与各端口标注。 */
    describe: () => ({
      executionMode: provider.executionMode,
      modelVersion: provider.modelVersion,
      providerAvailable: provider.available,
      providerUnavailableReason: provider.unavailableReason,
      mediaPort: media.kind,
      mediaNote: media.note,
      referencePort: reference.kind,
      referenceNote: reference.note,
      referenceAvailable: reference.available,
      referenceUnavailableReason: reference.unavailableReason,
      dosePort: dose.kind,
      doseNote: dose.note,
      /** 终态 → 服务端识别历史的端口（GY-I16 #16 接线；未接线时任务照常执行）。 */
      historyPort: historyPort.kind,
      historyNote: historyPort.note,
      storePersistent: store.persistent,
      jobDeadlineMs,
      /** 真实调用提供者的累计次数（诊断/证据用；受理前 fail-closed 时恒为 0）。 */
      providerCalls,
    }),
  };
}

export type OcrService = ReturnType<typeof createOcrService>;

/** 组装一个按执行模式接线的 OCR 服务（阶段 2 的路由将直接复用本工厂）。 */
export function createOcrServiceForMode(input: {
  executionMode: 'real' | 'stub' | 'preset_demo';
  provider: OcrProvider;
  store: OcrStore;
  media: OcrMediaPort;
  reference: OcrReferencePort;
  dose: OcrDosePort;
  idempotencyHmacKey: string;
  /** 终态写入服务端识别历史的端口（**可选**；缺省未接线，见 `OcrTerminalHistoryPort`）。 */
  history?: OcrTerminalHistoryPort;
  now?: () => Date;
  idFactory?: () => string;
  jobDeadlineMs?: number;
}): OcrService {
  return createOcrService({
    store: input.store,
    provider: input.provider,
    media: input.media,
    reference: input.reference,
    dose: input.dose,
    idempotencyHmacKey: input.idempotencyHmacKey,
    ...(input.history === undefined ? {} : { history: input.history }),
    now: input.now,
    idFactory: input.idFactory,
    jobDeadlineMs: input.jobDeadlineMs,
  });
}
