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
