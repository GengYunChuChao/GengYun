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
// 版本串的**单一真源**是 live 适配器的这两个导出（`model/<model>#live-1` / `prompt/citation-bind/1`）：
// 本文件只**取数**，⛔ 不复制字面量。`ai/chat-live-adapter.ts` 对本文件只有 `import type { ChatEgress }`，
// 所以这条反向依赖在运行时不成环（构建期也不成环：类型导入被擦除）。
import { CHAT_PROMPT_VERSION, chatModelVersion } from '../ai/chat-live-adapter.ts';
import { INVOCATION_STATE, failureCodeOf, summarizeEgressOutcome } from './ledger-pg.ts';
import type { ExportRecord, InvocationState, PostgresExportLedger } from './ledger-pg.ts';
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
      // 失败原因用契约既有码 `OBJECT_UNAVAILABLE`（409，确定性、重试不改）：这里的语义是
      // 「这一行外发不成立/对象不可用」，与同文件「未登记即派发被拒」用同一个码。
      // ⛔ 不得写自造码（原写法 `ACCEPTANCE_FAILED` 不在 `ERROR_CODES` 内，契约外）。
      await ledger.markFailed(input.exportId, { errorCode: 'OBJECT_UNAVAILABLE' }).catch(() => {});
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
 * `conversation_turn` + `object_key = <turnId>` 登记 —— 与既有维度的**判据同源**，只是换了维度。
 *
 * 为什么是 `conversation_turn`（2026-10-25 二轮，监工 R1 否决了近似容器类型）：账本行会被
 * `/me/exports` 原样投影成契约 `object_ref.type`（`packages/privacy/egress.mjs:397`），
 * 而一次问答外发记的是**轮次**——`objectId` 是轮次 id、`objectRevision` 是**轮次** revision
 * （`services/api/src/conversations/service.ts:1105-1106` 传的是 `claimed.id` / `claimed.revision`）。
 * 若把类型写成容器 `conversation`，`object_ref` 就成了「会话类型 + 轮次 id + 轮次 revision」的错配：
 * 类型、标识、版本不再指向同一真实实体。轮次是契约实体 `Turn`（id / revision），
 * 因此契约 `TargetRef.type` 补了 `conversation_turn` 这一成员（16 → 17 值），
 * 读面按枚举成员原样投影，不再做近似映射。裁定见
 * `.pg17/ruling-r34-exports-turn-identity-20261025.md`。
 */
export const CHAT_EGRESS_OBJECT_TYPE = 'conversation_turn';

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
 * 从一次外发的**返回值**里取结构用量（供应商文档里的 `usage` 对象）。
 *
 * 只认顶层 `usage`：`call()` 返回的是供应商响应经适配后的对象（`ai/chat-live-adapter.ts` 的
 * `ChatCompletionBody`），其顶层 `usage` 就是用量的落点；⛔ 不读 `choices`、⛔ 不读正文。
 *
 * 形状的最终收口在账本侧（`ledger-pg.ts` 的 `sanitizedUsage`：只留非负整数键值、最多 8 键）。
 * 这里只负责「从哪儿取」，不负责「什么算合法数字」—— 两处分开，免得两边各松一半。
 *
 * ⚠ 本仓**没有实测样本**：`usage` 的键名与值类型来自供应商文档（OpenAI 兼容的
 * `{prompt_tokens, completion_tokens, total_tokens}`），未对真实响应验证过（见派单回报的未验证清单）。
 */
function usageOfOutcome(value: unknown): Record<string, unknown> | null {
  const usage = (value as { usage?: unknown } | null)?.usage;
  if (usage === null || usage === undefined || typeof usage !== 'object' || Array.isArray(usage)) return null;
  return usage as Record<string, unknown>;
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

/** `ChatEgress` 写 `provider_invocations` 的可观测读数（进程内累计，只增不减）。 */
export interface InvocationWriteReadings {
  /** 成功落库的调用行数。 */
  written: number;
  /** 写失败次数（⛔ 写账本失败不许咽成静默 ⇒ 它必须有地方被看见）。 */
  failed: number;
  /** 最近一次写失败的**安全码**（契约错误码，不是驱动原文）；无失败时 `null`。 */
  lastError: string | null;
}

export interface ChatEgress {
  /** `real` 才接管外发；其余模式恒 false（此时 `send` 直接拒绝，绝不无账外发）。 */
  readonly engaged: boolean;
  readonly note: string;
  readonly dataType: string;
  /** 写账本读数（见 `InvocationWriteReadings`）。⛔ 只读计数，不含任何正文/凭据。 */
  invocationReadings(): InvocationWriteReadings;
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
  /**
   * live 适配器本次用的模型名（装配层的 `Config.chatProvider.model`）。
   * 给了 ⇒ `chatModelVersion(model)` 换成版本串写进 `provider_invocations.model_version`；
   * 没给 ⇒ 该列留 `NULL`。⛔ 绝不手写/猜测版本串（先例：`community/moderation-gate.ts:28`
   * 「`model_version` / `prompt_version` 属模型层，本片不产出、不填占位串」）。
   *
   * ⚠ 本片（R72-W2）的写入范围不含装配层 `ai/chat-wiring.ts` ⇒ 生产调用点**还没传**这个参数，
   * 因此当前部署下 `model_version` 实写 `NULL`；补这一行是接线片的活（1 行 diff）。
   */
  model?: string | null;
  /**
   * 写账本失败的可观测出口（默认进 stderr）。入参只有安全 token（错误码 + id + 状态），
   * ⛔ 不含正文/凭据。实现方**不得**抛错（这里的语义是「记一笔就走」）。
   */
  log?: (event: Record<string, unknown>) => void;
}): ChatEgress {
  const { ledger, inFlight, executionMode } = deps;
  const dataType = deps.dataType ?? 'checked_content';
  const purpose = deps.purpose ?? 'external_inference';
  const capability = deps.capability ?? 'llm';
  const engaged = executionMode === 'real';

  const note = engaged
    ? '问答真实模型外发已接管：reserve → assertExecutable → markSent → 外发 → 写调用记录 → saveResult'
    : `替身/演示模式（${executionMode}）：问答不发生真实外发，外发账本不记账`;

  // 版本串：prompt 恒有真源（live 适配器的常量）；model 只有装配层给得出来，没给就 NULL。
  const modelName = typeof deps.model === 'string' ? deps.model.trim() : '';
  const modelVersion = modelName === '' ? null : chatModelVersion(modelName);
  const promptVersion = CHAT_PROMPT_VERSION;

  /** 写账本读数（`invocationReadings()` 返回的就是它；⛔ 不暴露给 HTTP 面）。 */
  const readings: InvocationWriteReadings = { written: 0, failed: 0, lastError: null };
  const emit =
    deps.log ??
    ((event: Record<string, unknown>) => {
      // 兜底出口：没注入日志口时**也不许静默**（进 stderr，服务日志的默认去处）。
      console.warn(JSON.stringify(event));
    });

  /**
   * 写一行 `provider_invocations`（本文件**唯一**的写点）。
   *
   * 两条硬规矩（各有一条用例钉住）：
   *  ⛔ **不咽**：写失败必须留下可观测读数 —— `invocationReadings().failed` / `lastError` 累加，
   *     并发一条 `provider_invocation_write_failed` 事件（含安全码、`export_id`、状态；不含驱动原文）。
   *  ⛔ **不改判**：写失败**不得**把已经成功的问答判成失败 —— 外发已经发生、正文已经拿到，
   *     记账失败是记账的问题，不是回答的问题。所以这里自己 catch，绝不让异常穿过 `send`。
   */
  async function recordInvocationRow(input: {
    exportId: string;
    jobId: string | null;
    invocationState: InvocationState;
    sentAt: Date;
    durationMs: number;
    usage: Record<string, unknown> | null;
  }): Promise<void> {
    try {
      await ledger.recordInvocation({
        exportId: input.exportId,
        jobId: input.jobId,
        capability,
        invocationState: input.invocationState,
        sentAt: input.sentAt,
        durationMs: input.durationMs,
        usage: input.usage,
        modelVersion,
        promptVersion,
      });
      readings.written += 1;
    } catch (error) {
      readings.failed += 1;
      const code = errorCodeOf(error) ?? 'PROVIDER_UNAVAILABLE';
      readings.lastError = code;
      emit({
        event: 'provider_invocation_write_failed',
        code,
        export_id: input.exportId,
        invocation_state: input.invocationState,
      });
    }
  }

  const egress: ChatEgress = {
    engaged,
    note,
    dataType,
    // 返回**快照**（不是内部对象）：调用方拿到的是读数，不是可以改库的手柄。
    invocationReadings: () => ({ ...readings }),

    async send<T>(input: ChatEgressSend<T>): Promise<T> {
      // 未接账本/非 real ⇒ **在产生任何外发之前**拒绝（fail-closed，且不留 reserved 行）。
      // ⛔ 这里**不写** `provider_invocations`：一次外发都没发生，写一行就是把「没发」洗成「发过」。
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
      // ⛔ 这里被拒 ⇒ 同样**不写** `provider_invocations`（没有外发）；`reserve` 失败同理，
      //    所以那条路径连 `sent` 都到不了，这张表自然零行。
      await inFlight.assertExecutable({ exportId: record.id, userId: record.userId });
      const sent = await ledger.markSent(record.id);
      // 下三行是**外发即将发生**的时刻读数：`sentAt` 取进入 `call()` 之前（不是拿到返回值的时刻），
      // `startedAt` 只计这一次调用；两者都进 `provider_invocations.sent_at` / `duration_ms`。
      const sentAt = new Date();
      const startedAt = Date.now();
      let outcome: T;
      try {
        outcome = await input.call();
      } catch (error) {
        // ✅ **写**：`call()` 抛错也是外发**已经发生**（供应商回错 / 超时 / 传输中断）⇒ `send_failed`。
        await recordInvocationRow({
          exportId: record.id,
          jobId: sent.jobId,
          invocationState: INVOCATION_STATE.sendFailed,
          sentAt,
          durationMs: Date.now() - startedAt,
          usage: null,
        });
        // `failureCodeOf` 认的是账本摘要形状（`{kind:'failed', code}`），**不认** Error；
        // 所以抛出来的 Error 先按它的 `code`（契约闭集里的错误码）取，取不到再落默认值。
        const code = input.failureCodeOf?.(error) ?? errorCodeOf(error) ?? failureCodeOf(error) ?? 'PROVIDER_UNAVAILABLE';
        // 失败**不**记账为成功：只把预留置终态（不写回写表）。
        await ledger.markFailed(record.id, { errorCode: code }).catch(() => {});
        throw error;
      }
      const failure = failureCodeOf(outcome);
      if (failure !== null) {
        // ✅ **写**：供应商回了错（以**值**的形式返回，不抛错）—— 外发确实发生了 ⇒ `send_failed`。
        // 这一行 `usage` 恒 NULL：回错响应里的 `usage` 不可信（多半根本没有），⛔ 不去猜。
        await recordInvocationRow({
          exportId: record.id,
          jobId: sent.jobId,
          invocationState: INVOCATION_STATE.sendFailed,
          sentAt,
          durationMs: Date.now() - startedAt,
          usage: null,
        });
        await ledger.markFailed(record.id, { errorCode: failure });
        return outcome;
      }
      // ✅ **写**：外发成功且拿到正文 ⇒ `sent`；`usage` 只从响应顶层 `usage` 取结构读数。
      await recordInvocationRow({
        exportId: record.id,
        jobId: sent.jobId,
        invocationState: INVOCATION_STATE.sent,
        sentAt,
        durationMs: Date.now() - startedAt,
        usage: usageOfOutcome(outcome),
      });
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
