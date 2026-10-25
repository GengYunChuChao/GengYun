/**
 * GY-I27（#29）· **任务生命周期**的外发守卫接入（识别 / 语音转写 / 标签 OCR）。
 *
 * 把 `packages/privacy/in-flight.mjs` 的三件事接到**实际任务生命周期**上：
 *   - `assertExecutable`  —— 提供者**执行前**重查（账号状态 + auth_epoch + 全部必需用途 epoch）；
 *   - `saveResult`        —— 结果**保存前**重查，且回调版本必须等于预留版本；
 *     校验不过 ⇒ 抛错 ⇒ 调用方（各域服务）**不保存结果** ⇒ 域 store **零写入**；
 *   - `cancelVersion`     —— **只增不减**的取消墓碑（PG 侧 `cancelled_at`）：取消后晚到回调、
 *     乃至重新授权都不可复活该版本。
 *
 * ## 为什么以「提供者端口」为接缝（而不是改各域服务）
 * 各域的异步任务在服务内部调用提供者：`provider.recognize/transcribe({ jobId, mediaId, mediaRevision })`。
 * 因此**包装提供者**就能覆盖"执行前/保存前"两个时刻，而**不需要改任何服务层判定语义**
 * （`services/api/src/{recognitions,speech,ocr}/service.ts` 一行未改）。
 *
 * ## 派发顺序（与账本口径一致）
 *   1. 受理处 `reserveForAcceptance`：先解析「用户当前授权绑定里该能力的唯一接收方」，
 *      再 `ledger.reserve` 冻结快照（账号版本 / 全部必需用途 epoch / 接收方版本）；
 *      **`stub`/`preset_demo` 不预留、不记账**（替身不外发 ⇒ 账本里不得出现 `sent`）；
 *      **`real` 未接真实传输 ⇒ 在任何账本变更之前 503 `PROVIDER_UNAVAILABLE`**（零 `sent`）。
 *   2. 提供者被调用时：按对象找预留行 → `linkJob` → `assertExecutable` →
 *   3. `ledger.markSent`（唯一权威授权边界，同步事务内重读快照）→ 真正调用提供者 →
 *   4. 成功 ⇒ `saveResult`（写回与校验同事务）；失败 ⇒ `markFailed`（不写回写表）。
 */
import { PrivacyError } from '../../../../packages/privacy/errors.mjs';
import { failureCodeOf, summarizeEgressOutcome } from './ledger-pg.ts';
import type { ExportRecord, PostgresExportLedger } from './ledger-pg.ts';
import type { InFlightGuard } from '../../../../packages/privacy/in-flight.mjs';
import { isErrorCode } from '../contract.ts';

export interface MediaJobEgress {
  /** `real` 才接管派发；`stub`/`preset_demo` 恒为 false（替身不记账）。 */
  readonly engaged: boolean;
  readonly note: string;
  readonly dataType: string;
  /** 受理前预留；返回 null 表示本模式不记账（替身）。 */
  reserveForAcceptance(input: {
    userId: string;
    authEpoch: number;
    objectId: string;
    objectRevision: number;
  }): Promise<{ exportId: string } | null>;
  /** 受理失败（预留后服务层拒绝）⇒ 把预留置终态，避免残留 `reserved` 行被后续任务误用。 */
  abandonReservation(input: { exportId: string }): Promise<void>;
  /** 包装域提供者（`real` 才真正接管；其余模式原样返回）。 */
  provider<T extends { available?: boolean; unavailableReason?: string | null }>(inner: T, method: 'recognize' | 'transcribe'): T;
  /** 作业取消 ⇒ 写墓碑 + 在途置 failed（晚到回调不可复活）。 */
  cancelForJob(input: { jobId: string; userId: string; reason?: string }): Promise<{ cancelled: number }>;
  cancelVersion(input: { exportId: string; userId: string; objectVersion: number; reason?: string }): Promise<{ cancelled: boolean; alreadyCancelled: boolean; cancelledCount: number }>;
}

/**
 * 媒体类任务（识别 / 转写 / 标签 OCR）的外发守卫。
 *
 * @param deps.executionMode 执行模式；只有 `real` 才接管派发
 * @param deps.capability    接收方能力（`recipients.capability`：`weed` / `asr` / `ocr`）
 */
export function createMediaJobEgress(deps: {
  ledger: PostgresExportLedger;
  inFlight: Pick<InFlightGuard, 'assertExecutable' | 'saveResult'>;
  executionMode: 'real' | 'stub' | 'preset_demo';
  dataType: string;
  purpose?: string;
  capability: string;
}): MediaJobEgress {
  const { ledger, inFlight, executionMode, dataType, capability } = deps;
  const purpose = deps.purpose ?? 'external_inference';
  const engaged = executionMode === 'real';
  let providerAvailable = false;
  let providerUnavailableReason: string | null = null;

  const note = engaged
    ? '真实外发消费者已接管：reserve → assertExecutable → markSent → 提供者 → saveResult'
    : `替身/演示模式（${executionMode}）：不发生真实外发，外发账本不记账`;

  async function resolveObject(input: { objectId: string; objectRevision: number }): Promise<ExportRecord | null> {
    return ledger.findReservedByObject({ objectType: 'media', objectId: input.objectId, objectRevision: input.objectRevision });
  }

  return {
    engaged,
    note,
    dataType,

    async reserveForAcceptance(input) {
      if (!engaged) return null;
      // 红线：real 且真实传输未接入 ⇒ **在任何账本变更之前** fail-closed（503，可重试）。
      if (!providerAvailable) {
        throw new PrivacyError(
          'PROVIDER_UNAVAILABLE',
          providerUnavailableReason ?? '真实外发传输未接入：real 模式 fail-closed',
          // 真实外发传输未接入＝未接线：retryable 必须为 false。
          { retryable: false },
        );
      }
      const recipientId = await ledger.resolveRecipient({ userId: input.userId, purpose, capability });
      const record = await ledger.reserve({
        userId: input.userId,
        authEpoch: input.authEpoch,
        objectType: 'media',
        objectId: input.objectId,
        objectRevision: input.objectRevision,
        dataType,
        purpose,
        recipientId,
        sourceVersion: null,
      });
      return { exportId: record.id };
    },

    provider<T extends { available?: boolean; unavailableReason?: string | null }>(inner: T, method: 'recognize' | 'transcribe'): T {
      providerAvailable = inner?.available === true;
      providerUnavailableReason = inner?.unavailableReason ?? null;
      if (!engaged) return inner;
      const wrapped = { ...inner } as Record<string, unknown>;
      wrapped[method] = async (input: { jobId?: string; mediaId: string; mediaRevision: number }) => {
        const record = await resolveObject({ objectId: input.mediaId, objectRevision: input.mediaRevision });
        if (record === null) {
          // 未登记即派发 ⇒ 拒绝（fail-closed），不产生任何外发。
          throw new PrivacyError('OBJECT_UNAVAILABLE', '无外发预留（未登记的外发被拒绝）');
        }
        if (typeof input.jobId === 'string') await ledger.linkJob({ exportId: record.id, jobId: input.jobId });
        await inFlight.assertExecutable({ exportId: record.id, userId: record.userId });
        const sent = await ledger.markSent(record.id);
        let outcome: unknown;
        try {
          outcome = await (inner as unknown as Record<string, (value: unknown) => Promise<unknown>>)[method]!(input);
        } catch (error) {
          const code = failureCodeOf(error) ?? 'PROVIDER_UNAVAILABLE';
          await ledger.markFailed(record.id, { errorCode: code }).catch(() => {});
          throw error;
        }
        const failure = failureCodeOf(outcome);
        if (failure !== null) {
          await ledger.markFailed(record.id, { errorCode: failure });
          return outcome;
        }
        // 保存前重查 + 结果写入（与校验同事务）；被拒 ⇒ 抛错 ⇒ 域服务不保存结果（零写入）。
        await inFlight.saveResult({
          exportId: record.id,
          userId: sent.userId,
          objectVersion: sent.objectRevision,
          result: summarizeEgressOutcome(outcome),
        });
        return outcome;
      };
      return wrapped as unknown as T;
    },

    async abandonReservation(input) {
      if (!engaged) return;
      // 受理在预留之后失败：把预留置终态（active→failed），避免残留 reserved 行被后续任务误用。
      await ledger.markFailed(input.exportId, { errorCode: 'ACCEPTANCE_FAILED' }).catch(() => {});
    },

    async cancelForJob(input) {
      if (!engaged) return { cancelled: 0 };
      return ledger.cancelForJob({ jobId: input.jobId, userId: input.userId, reason: input.reason ?? 'job_cancelled' });
    },

    async cancelVersion(input) {
      return ledger.cancelVersion(input);
    },
  };
}

// ---------------------------------------------------------------------------
// 文字问答（`/conversations` 的回答生成侧）的外发守卫 —— GY-R28 W7（#12）
// ---------------------------------------------------------------------------

/**
 * 问答外发的**对象类型**（`exports.object_type`，≤40）：一次「回答一个轮次」= 一个外发对象。
 *
 * 为什么不用 `media`：媒体维要求 `object_id` 是 uuid 且 `dataType ∈ MEDIA_PURPOSES`，
 * 问答的资料类型是**非媒体维**的 `checked_content`（唯一闭集成员，其必需用途恰为
 * `external_inference`），对象标识必须走 `object_key`。因此对象维度按
 * `conversation` + `object_key = <turnId>` 登记 —— 与既有维度的**判据同源**，只是换了维度。
 *
 * 为什么是 `conversation` 而不是 `conversation_turn`（GY-R35 写入侧改写）：账本行的
 * `object_type` 会被 `/me/exports` 原样投影成契约 `object_ref.type`
 * （`packages/privacy/egress.mjs:388`），而 `TargetRef.type` 是 16 值闭集
 * （`packages/contracts/openapi.json:11551-11570`），**没有**「轮次」这一实体类型 ——
 * 域外的值会让整页投影失败（503）。轮次属于会话，故取最贴近的容器类型。
 *
 * **已知代价（接受）**：`object_type='conversation'` 下会同时存在「会话 id」与「轮次 id」
 * 两种 `object_key`。两者都是 uuid、语义上都可读，读面只按 (type,id) 二元组原样投影，
 * 不存在把会话 id 误判成轮次 id 的判据；这是让轮次外发仍能如实记账而付的最小代价。
 */
export const CHAT_EGRESS_OBJECT_TYPE = 'conversation';

/**
 * 非媒体维对象键的既有限制（`ledger-pg.ts` 的 `OBJECT_KEY`：1..80 小写字母/数字/`_-.`/`:`）。
 * 上限 80 与契约 `TargetRef.id` 的 `maxLength: 80` 同口径（DB 侧 CHECK 由迁移 0040 收到 80）。
 */
const CHAT_OBJECT_KEY = /^[a-z0-9][a-z0-9_\-.:]{0,78}[a-z0-9]$/;

/**
 * 从抛出来的错误里取「账本可接受的安全错误码」。
 *
 * 只认契约闭集形状（`^[A-Z_]{1,64}$`）且必须确实是 `ERROR_STATUS_MAP` 的成员 —— 账本只收短 token，
 * 收错值会被它的校验拒掉，那反而会把"失败"变成"记账也失败"的二连错。
 */
function errorCodeOf(value: unknown): string | null {
  const code = (value as { code?: unknown } | null)?.code;
  return typeof code === 'string' && isErrorCode(code) ? code : null;
}

/**
 * 问答外发的守卫端口。
 *
 * 与 `MediaJobEgress` **同一套账本口径与同一套派发顺序**（预留 → 执行前重查 → `markSent`
 * → 真正外发 → 保存前重查/写回），差异只在接缝形状：
 * 媒体域包装的是「域提供者对象的方法」（`provider(inner, method)`）；
 * 问答域包装的是「一次外发调用」（`send({ call })`），因为回答生成没有可包装的长生命周期
 * 提供者实例，且对象维度不是 `media`。
 */
/** `ChatEgress.send` 的入参形状（泛型化以便实现方写出带类型的 `send<T>`）。 */
export interface ChatEgressSend<T> {
  userId: string;
  authEpoch: number;
  /** 会话轮次 id（uuid；用于 `object_key`，不落正文）。 */
  objectId: string;
  /** 轮次 revision（外发预留时冻结的版本号）。 */
  objectRevision: number;
  call: () => Promise<T>;
  outcomeOf: (result: T) => Record<string, unknown>;
  /** 失败 → 安全错误码（闭集外的值会被账本拒；缺省按 `PROVIDER_UNAVAILABLE`）。 */
  failureCodeOf?: (error: unknown) => string | null;
}

export interface ChatEgress {
  /** `real` 才接管外发；其余模式恒 false（此时 `send` 直接拒绝，绝不无账外发）。 */
  readonly engaged: boolean;
  readonly note: string;
  readonly dataType: string;
  /**
   * **reserve-then-send**：一次问答外发的唯一入口。
   *
   * 顺序（与账本口径逐条对齐，任何一步失败都不外发）：
   *   1. 解析用户当前授权绑定里 `capability` 的唯一接收方；
   *   2. `ledger.reserve` 冻结快照（账号版本 / 必需用途 epoch / 接收方版本）；
   *   3. `inFlight.assertExecutable`（执行前重查：账号状态 + auth_epoch + 用途 epoch）；
   *   4. `ledger.markSent`（唯一权威授权边界）；
   *   5. `call()` —— 真正的模型外发；
   *   6. 成功 ⇒ `inFlight.saveResult`（保存前重查 + 写回结构分类）；失败 ⇒ `markFailed`（**不**写回）。
   *
   * `outcomeOf` 只能返回结构分类 token（账本 `export_writebacks.result` 只收短 token，
   * 不收正文/用量明细 —— 用量进结构化日志，见 `ai/chat-live-adapter.ts`）。
   */
  send<T>(input: ChatEgressSend<T>): Promise<T>;
}

/**
 * 问答外发守卫。
 *
 * @param deps.executionMode 执行模式；只有 `real` 才接管（其余模式 `send` 一律拒绝）
 * @param deps.capability    接收方能力（`recipients.capability`；问答用 `llm`，闭集已含）
 * @param deps.dataType      资料类型（`checked_content`，其必需用途恰为 `external_inference`）
 */
export function createChatEgress(deps: {
  ledger: PostgresExportLedger;
  inFlight: Pick<InFlightGuard, 'assertExecutable' | 'saveResult'>;
  executionMode: 'real' | 'stub' | 'preset_demo';
  dataType?: string;
  purpose?: string;
  capability?: string;
}): ChatEgress {
  const { ledger, inFlight, executionMode } = deps;
  const dataType = deps.dataType ?? 'checked_content';
  const purpose = deps.purpose ?? 'external_inference';
  const capability = deps.capability ?? 'llm';
  const engaged = executionMode === 'real';

  const note = engaged
    ? '问答真实模型外发已接管：reserve → assertExecutable → markSent → 外发 → saveResult'
    : `替身/演示模式（${executionMode}）：问答不发生真实外发，外发账本不记账`;

  const egress: ChatEgress = {
    engaged,
    note,
    dataType,

    async send<T>(input: ChatEgressSend<T>): Promise<T> {
      // 未接账本/非 real ⇒ **在产生任何外发之前**拒绝（fail-closed，且不留 reserved 行）。
      if (!engaged) {
        throw new PrivacyError('PROVIDER_UNAVAILABLE', '问答真实外发未接管（非 real 模式）：拒绝无账外发', {
          retryable: false,
        });
      }
      // 裸 id、不带 `turn:` 前缀：账本 `object_key` 就是 `/me/exports` 的 `object_ref.id`
      // （`ledger-pg.ts:110-112`），前缀会白占契约 `TargetRef.id` 的 80 字符预算，且会被
      // 原样漏给客户端。轮次身份由 `object_type='conversation'` + uuid 共同表达。
      const objectKey = String(input.objectId).toLowerCase();
      if (!CHAT_OBJECT_KEY.test(objectKey)) {
        throw new PrivacyError('INVALID_REQUEST', '外发对象键非法（只允许小写字母/数字/_-. :）');
      }
      const recipientId = await ledger.resolveRecipient({ userId: input.userId, purpose, capability });
      const record = await ledger.reserve({
        userId: input.userId,
        authEpoch: input.authEpoch,
        objectType: CHAT_EGRESS_OBJECT_TYPE,
        objectKey,
        objectRevision: input.objectRevision,
        dataType,
        purpose,
        recipientId,
        sourceVersion: null,
      });
      // 执行前重查：撤回/注销后不得再起新外发。
      await inFlight.assertExecutable({ exportId: record.id, userId: record.userId });
      const sent = await ledger.markSent(record.id);
      let outcome: T;
      try {
        outcome = await input.call();
      } catch (error) {
        // `failureCodeOf` 认的是账本摘要形状（`{kind:'failed', code}`），**不认** Error；
        // 所以抛出来的 Error 先按它的 `code`（契约闭集里的错误码）取，取不到再落默认值。
        const code = input.failureCodeOf?.(error) ?? errorCodeOf(error) ?? failureCodeOf(error) ?? 'PROVIDER_UNAVAILABLE';
        // 失败**不**记账为成功：只把预留置终态（不写回写表）。
        await ledger.markFailed(record.id, { errorCode: code }).catch(() => {});
        throw error;
      }
      const failure = failureCodeOf(outcome);
      if (failure !== null) {
        await ledger.markFailed(record.id, { errorCode: failure });
        return outcome;
      }
      // 保存前重查 + 写回结构分类（与校验同事务）；被拒 ⇒ 抛错 ⇒ 调用方不保存结果（零写入）。
      await inFlight.saveResult({
        exportId: record.id,
        userId: sent.userId,
        objectVersion: sent.objectRevision,
        result: input.outcomeOf(outcome),
      });
      return outcome;
    },
  };
  return egress;
}
