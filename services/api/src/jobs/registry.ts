/**
 * GY-I01 跨 kind 的作业读面/取消面 · **按 kind 分派的作业源注册表** 与 **契约形状守卫**。
 *
 * 契约（`packages/contracts/openapi.json`，本文件只读消费，不新增字段）：
 * - `GET  /jobs/{id}`       `getJob`    → 200 `JobEnvelope`（`x-task: GY-I01`）
 * - `POST /jobs/{id}/cancel` `cancelJob` → 200 `JobEnvelope`（`x-version-required: true` ⇒ 需 `If-Match`）
 * - `Job` = `{id, revision, kind, target_ref, state, deadline_at, created_at, error_code, result}`，
 *   `additionalProperties: false`；`kind` ∈ 6 值闭集；`state` ∈ 7 值闭集；
 *   `result` 是 `JobResult`（`discriminator: kind`）或 `null`；`error_code` 是契约 `ErrorCode` 或 `null`。
 *
 * 设计要点（派单 §设计要求 2/5/6/7/8）：
 * 1. **未注册的 kind ⇒ 与「作业不存在」完全同形的 `NOT_FOUND`**（fail-closed）：注册表里没有该 kind 的源，
 *    调用自然落到同一条 `NOT_FOUND` 分支，**绝不为未接线的能力伪造状态**。
 * 2. **归属与不存在同形**：各域源的 `get`/`cancel` 在「不存在**或**越权」时返回 `null`（由适配层把域内的
 *    `NOT_FOUND` 映射为 `null`），注册表因此无法、也不需要区分二者。
 * 3. **出口即重建**：命中后由 `assertContractJob` **按契约字段逐项重建**一个新对象（`additionalProperties:false`
 *    ⇒ 键集合必须恰好九个）并对 `result.value` 做 `structuredClone` ⇒ 出口不共享域内引用（出口不可变边界）。
 * 4. **`result.value` 必须过**冻结分支 schema 的**完整**校验**（`./result-shape.ts` 的契约镜像）：
 *    必填、类型、闭集、上界与 `additionalProperties:false` 逐项检查，**不以 `kind` 一致代替**；
 *    `value=null` / `value={}` / 只有部分字段等一律拒绝（监工 `5497968362` 的 P2）。
 * 5. **形状违规 = 端口回传不可信**：任何不合契约的 `Job`（未知 kind/state、`result` 判别子不一致、终态带 `result`、
 *    嵌套值不合分支）⇒ 统一走 `contractViolation` ⇒ **503 `PROVIDER_UNAVAILABLE`（`retryable`）**，
 *    与 `admin/ops/service.ts` 的 `portIntegrityFailure` **同一机制、同一个通道**；**不伪造状态、不放宽 schema**。
 */
import { ERROR_CODES, type ErrorCode } from '../contract.ts';
import { ApiError } from '../errors.ts';
import { TARGET_REF_TYPES, collectResultValueIssues } from './result-shape.ts';

// `TargetRef.type` 闭集与 `JobResult.value` 的**契约镜像**统一放在 `./result-shape.ts`（单一镜像来源）；
// 这里转出 `TARGET_REF_TYPES` 以免既有引用点（与本模块的单元用例）改动。
export { TARGET_REF_TYPES };

/** `components.schemas.Job.properties.kind.enum`（逐项一致，不得扩展）。 */
export const JOB_KINDS = ['recognition', 'ocr', 'transcription', 'answer', 'synthesis', 'moderation'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** `components.schemas.JobState.enum`（逐项一致，不得扩展）。 */
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

/** `Job.required`（九字段全必填；`additionalProperties:false` ⇒ 键集合必须恰好是这九个）。 */
export const JOB_KEYS = [
  'id',
  'revision',
  'kind',
  'target_ref',
  'state',
  'deadline_at',
  'created_at',
  'error_code',
  'result',
] as const;

/** `JobResult` 各分支的键（`oneOf` + discriminator ⇒ 恰好 `kind` + `value`）。 */
export const JOB_RESULT_KEYS = ['kind', 'value'] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 契约 `Job` 投影（本模块保证其键集合与类型）。 */
export interface ContractJob {
  id: string;
  revision: number;
  kind: JobKind;
  target_ref: { type: (typeof TARGET_REF_TYPES)[number]; id: string; revision: number };
  state: JobState;
  deadline_at: string;
  created_at: string;
  error_code: ErrorCode | null;
  result: { kind: JobKind; value: unknown } | null;
}

export interface JobSourceGetInput {
  userId: string;
  jobId: string;
}

export interface JobSourceCancelInput extends JobSourceGetInput {
  ifMatch: unknown;
  idempotencyKey: unknown;
}

/**
 * 共享作业源端口（各域在装配时注册自己的源）。
 *
 * - `get`：返回该域视角的契约 `Job`；**不存在或越权一律返回 `null`**（调用方不得据此区分二者）。
 * - `cancel`：**可选**。缺失表示「该域没有取消能力」——注册表会先确认作业确实存在，再以
 *   **`503 PROVIDER_UNAVAILABLE`（`retryable: false`，"该作业所属能力尚未提供取消"）** 如实拒绝
 *   （**不假装取消成功，也不为它另写状态机**）。
 *   有取消能力的域**必须复用域内既有实现**（含 `If-Match`/幂等/终态语义），本层不再判状态。
 */
export interface JobSourcePort {
  readonly kind: JobKind;
  get(input: JobSourceGetInput): Promise<unknown | null>;
  cancel?(input: JobSourceCancelInput): Promise<unknown | null>;
}

export interface JobRegistry {
  /** 已接线的 kind（按注册顺序）。 */
  readonly kinds: readonly JobKind[];
  /** 读取作业；未命中（不存在/越权/未接线 kind）⇒ `NOT_FOUND`。 */
  get(input: JobSourceGetInput): Promise<ContractJob>;
  /** 取消作业；未命中 ⇒ `NOT_FOUND`；作业存在但该域无取消能力 ⇒ `PROVIDER_UNAVAILABLE`（503，能力未接线）。 */
  cancel(input: JobSourceCancelInput): Promise<ContractJob>;
}

export function isTerminalJobState(state: JobState): boolean {
  return state === 'succeeded' || state === 'uncertain' || state === 'failed' || state === 'timed_out' || state === 'cancelled';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 域源/端口回传**不合契约**时的统一 fail-closed 拒绝路径。
 *
 * **沿用仓库既有机制**：与 `services/api/src/admin/ops/service.ts` 的 `portIntegrityFailure`
 * 同形——503 `PROVIDER_UNAVAILABLE`（契约闭集内的码）+ `retryable: false`，含义是"端口回传不可信 ⇒
 * 拒绝投影，既不登记成功也不把不合契约的记录当状态发出"。**只有一个错误通道**（本函数），
 * 不再另造；也**不放宽**冻结契约。
 */
export function contractViolation(where: string, reason: string): ApiError {
  // 端口回传不合契约 ⇒ 确定性缺陷（重试不会改善）：retryable 必须为 false。口径见 services/api/src/errors.ts 的 ApiError 注释。
  return new ApiError('PROVIDER_UNAVAILABLE', `作业投影不合契约（${where}）：${reason}`, { retryable: false });
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], where: string, what: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw contractViolation(where, `${what}的键集合必须恰好是 ${JSON.stringify(wanted)}，实际 ${JSON.stringify(actual)}`);
  }
}

function requireText(value: unknown, where: string, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) {
    throw contractViolation(where, `${field} 必须是长度 1..${maxLength} 的字符串`);
  }
  return value;
}

function requireDateTime(value: unknown, where: string, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw contractViolation(where, `${field} 必须是可解析的 date-time 字符串`);
  }
  return value;
}

/**
 * 校验并**按契约重建** `Job` 投影（出口不共享域内引用）。
 *
 * 逐项落实（契约 + 派单 §设计要求 6/7）：
 * - 九键恰好齐备（`additionalProperties:false`）；
 * - `kind`/`state`/`target_ref.type` 必须落在闭集内（**未知 kind 一律拒绝**，不放宽 schema）；
 * - `revision`/`target_ref.revision` 为 ≥1 的正整数；`id` 为 uuid；时间戳可解析；
 * - `error_code` 为 `null` 或契约 `ErrorCode` 闭集成员；
 * - `result` 判别子必须与 `kind` 一致（`JobResult` 是 `discriminator: kind` 的 `oneOf`）；
 * - **如实性不变式**：`result !== null` ⇒ `state ∈ {succeeded, uncertain}`；反过来
 *   `state ∈ {queued, running, failed, timed_out, cancelled}` ⇒ `result === null`；
 *   `state === 'succeeded'` ⇒ `error_code === null`。
 *
 * ⚠ 口径差异（如实登记，见证据文档）：派单 §设计要求 6 写的是"`succeeded` 才可带 `result`，
 * `failed`/`timed_out`/`uncertain` 必须 `result=null`"。但**已合并**的识别域实现（`recognitions/service.ts`
 * 的 `toJob`）与**其既有集成测试**都要求 `state='uncertain'` 时**带** `result`（不确定候选照实下发，
 * 测试断言 `result.value.uncertainty_reasons`）。本模块按"`result` 只允许出现在 `succeeded`/`uncertain`"
 * 执行——这是两个已接线域都能满足的**不变式**；若强行按字面实现，会**破坏已合并的识别域行为**，
 * 属派单禁止的"改各域语义"，故停下来如实上报，不擅自改识别域。
 */
export function assertContractJob(raw: unknown, where: string): ContractJob {
  if (!isPlainObject(raw)) throw contractViolation(where, 'Job 必须是对象');
  exactKeys(raw, JOB_KEYS, where, 'Job');

  const id = raw['id'];
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) throw contractViolation(where, 'id 必须是 uuid');
  const revision = raw['revision'];
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    throw contractViolation(where, 'revision 必须是 >=1 的整数');
  }
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !(JOB_KINDS as readonly string[]).includes(kind)) {
    throw contractViolation(where, `kind 必须是契约闭集成员（未知 kind：${String(kind)}）`);
  }
  const state = raw['state'];
  if (typeof state !== 'string' || !(JOB_STATES as readonly string[]).includes(state)) {
    throw contractViolation(where, `state 必须是契约闭集成员（未知 state：${String(state)}）`);
  }

  const targetRef = raw['target_ref'];
  if (!isPlainObject(targetRef)) throw contractViolation(where, 'target_ref 必须是对象');
  exactKeys(targetRef, ['type', 'id', 'revision'], where, 'target_ref');
  const targetType = targetRef['type'];
  if (typeof targetType !== 'string' || !(TARGET_REF_TYPES as readonly string[]).includes(targetType)) {
    throw contractViolation(where, `target_ref.type 必须是契约闭集成员（实际 ${String(targetType)}）`);
  }
  const targetId = requireText(targetRef['id'], where, 'target_ref.id', 80);
  const targetRevision = targetRef['revision'];
  if (typeof targetRevision !== 'number' || !Number.isInteger(targetRevision) || targetRevision < 1) {
    throw contractViolation(where, 'target_ref.revision 必须是 >=1 的整数');
  }

  const deadlineAt = requireDateTime(raw['deadline_at'], where, 'deadline_at');
  const createdAt = requireDateTime(raw['created_at'], where, 'created_at');

  const errorCode = raw['error_code'];
  if (errorCode !== null && (typeof errorCode !== 'string' || !(ERROR_CODES as readonly string[]).includes(errorCode))) {
    throw contractViolation(where, `error_code 必须是 null 或契约 ErrorCode 闭集成员（实际 ${String(errorCode)}）`);
  }

  const rawResult = raw['result'];
  let result: { kind: JobKind; value: unknown } | null = null;
  if (rawResult !== null) {
    if (!isPlainObject(rawResult)) throw contractViolation(where, 'result 必须是对象或 null');
    exactKeys(rawResult, JOB_RESULT_KEYS, where, 'result');
    const resultKind = rawResult['kind'];
    if (typeof resultKind !== 'string' || resultKind !== kind) {
      throw contractViolation(where, `result.kind 必须与 Job.kind 一致（Job.kind=${kind}，result.kind=${String(resultKind)}）`);
    }
    if (!('value' in rawResult)) throw contractViolation(where, 'result.value 必须存在');
    // **嵌套结果的完整契约校验**（监工 5497968362 的 P2）：不以 `kind` 一致代替分支 schema ——
    // 必填、类型、闭集、上界与 `additionalProperties:false` 全部逐项校验（镜像见 `./result-shape.ts`）。
    const valueIssues = collectResultValueIssues(kind as JobKind, rawResult['value']);
    if (valueIssues.length > 0) {
      throw contractViolation(where, `result.value 不合 ${kind} 的契约分支：${valueIssues.slice(0, 4).join('；')}`);
    }
    result = { kind: kind as JobKind, value: structuredClone(rawResult['value']) };
  }

  // 如实性不变式（见上文"口径差异"）。
  if (result !== null && state !== 'succeeded' && state !== 'uncertain') {
    throw contractViolation(where, `state=${state} 不得携带 result（只有 succeeded/uncertain 可以）`);
  }
  // 允许 succeeded/uncertain 不带 result（例如记录已删除）——契约未强制二者必须同时出现。
  if (state === 'succeeded' && errorCode !== null) {
    throw contractViolation(where, 'state=succeeded 时 error_code 必须为 null');
  }
  if ((state === 'failed' || state === 'timed_out') && errorCode === null) {
    throw contractViolation(where, `state=${state} 必须带契约 error_code（不得把失败报成无原因）`);
  }

  return {
    id,
    revision,
    kind: kind as JobKind,
    target_ref: { type: targetType as ContractJob['target_ref']['type'], id: targetId, revision: targetRevision },
    state: state as JobState,
    deadline_at: deadlineAt,
    created_at: createdAt,
    error_code: errorCode as ErrorCode | null,
    result,
  };
}

/**
 * 建注册表：**kind 不得重复**（同一路径/同一 kind 重复装配属装配期错误，立即抛出，
 * 避免"两处注册同一作业源"这类静默行为）。
 */
export function createJobRegistry(sources: readonly JobSourcePort[]): JobRegistry {
  const list = [...sources];
  const seen = new Set<JobKind>();
  for (const source of list) {
    if (seen.has(source.kind)) throw new Error(`作业源 kind 重复注册：${source.kind}`);
    seen.add(source.kind);
  }

  return {
    kinds: list.map((source) => source.kind),
    async get(input) {
      for (const source of list) {
        const raw = await source.get(input);
        if (raw !== null && raw !== undefined) return assertContractJob(raw, `作业源 ${source.kind}.get`);
      }
      // 不存在 / 越权 / 该 kind 未接线：一律同形。
      throw new ApiError('NOT_FOUND', '作业不存在');
    },
    async cancel(input) {
      let existsWithoutCancel = false;
      for (const source of list) {
        if (source.cancel === undefined) {
          // 该域没有取消能力：先确认作业是否属于它（存在即"存在但不可取消"，如实拒绝；绝不假装取消）。
          const raw = await source.get(input);
          if (raw !== null && raw !== undefined) {
            assertContractJob(raw, `作业源 ${source.kind}.get`);
            existsWithoutCancel = true;
          }
          continue;
        }
        const raw = await source.cancel(input);
        if (raw !== null && raw !== undefined) return assertContractJob(raw, `作业源 ${source.kind}.cancel`);
      }
      if (existsWithoutCancel) {
        // 该域**根本没有取消能力**（能力未接线），与"对象当前不可用"是两件事：
        // 按契约 `cancelJob` 的响应闭集，503 = `PROVIDER_UNAVAILABLE`（`x-error-status-map["503"]`），
        // 并沿用项目"未接线 ⇒ fail-closed 503"的口径（先例：`db/catalog.ts` 的"尚未接入"、
        // admin 的 `AdminJobPort`）⇒ **不谎称对象状态**（故不用 409 `OBJECT_UNAVAILABLE`）。
        // `retryable: false`：接线（给该域补上取消能力）是**运维/发版动作**，不是时间能解决的 ——
        // 同一请求原样重试不会成功，故不置 true。（契约为 503 保留 `Retry-After` 只表示"服务端可以给出
        // 建议等待时长"，不等于"重试即可成功"。口径原文见 `services/api/src/errors.ts` 的 `ApiError` 注释。）
        throw new ApiError('PROVIDER_UNAVAILABLE', '该作业所属能力尚未提供取消（未接线）', { retryable: false });
      }
      throw new ApiError('NOT_FOUND', '作业不存在');
    },
  };
}
