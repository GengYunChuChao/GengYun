/**
 * GY-I27（#29）· **合成域**（普通话 TTS 朗读）的外发账本接线。
 *
 * 与 `task-egress.ts`（识别/转写/标签 OCR 三个媒体任务域）**同形、同口径**，差异只有三处：
 *   1. 对象标识是**文本型**（`checked_content_ref.id` 是 1..80 任意字符串，不是 uuid）⇒
 *      走 0014 新增的 `exports.object_key` 列，账本 `object_type` 用 `checked_content`；
 *   2. 资料维度用**契约外第二维度** `NON_MEDIA_*`（合成不属四类媒体资料类型；复用媒体维度会
 *      多要 `recording`/`media_processing` 授权，见 `packages/privacy/constants.mjs` 的说明）；
 *   3. 提供者方法是 `synthesize`（TTS 域只有一个外发方法），且 `synthesize` 入参**不含**
 *      `ownerUserId` ⇒ 属主上下文由路由在受理前显式 `withOwner(...)` 绑定（见文末说明）。
 *
 * ## 为什么仍以「提供者端口」为接缝
 * 与媒体域同理：包装提供者即可覆盖「执行前重查 / 结果保存前重查」两个时刻，
 * **服务层判定语义一行未改**（`services/api/src/tts/service.ts` 不改判定、不接受自由文本）。
 *
 * ## 派发顺序（与账本口径逐条一致）
 *   1. 受理处 `reserveForAcceptance`：`real` 且提供者可用 ⇒ 重读已核对正文快照 → 解析
 *      「用户当前授权绑定里 `tts` 能力的唯一接收方」→ `ledger.reserve` 冻结快照；
 *      **`stub`/`preset_demo` 不预留、不记账**（替身不外发 ⇒ 账本里不得出现 `sent`）；
 *      `real` 未接真实传输 ⇒ **在任何账本变更之前** 503 `PROVIDER_UNAVAILABLE`（零 `sent`）。
 *   2. `synthesize` 被调用时：按 (object_type, object_key, revision) 找预留行 →
 *      `linkJob` → `assertExecutable` → `markSent`（**唯一权威授权边界**）→ 真正调提供者。
 *   3. 成功 ⇒ `saveResult`（与校验同事务写回写表）；失败 ⇒ `markFailed`（不写回写表）。
 *
 * ## 对象标识取「执行期重读的已核对正文快照」
 * 提供者收到的 `targetRef` 是服务层在**执行期**重读并重新判定通过的那个
 * `CheckedContentSnapshot`（`tts/service.ts` 的 `readAndDecide` → `runProviderWithDeadline`），
 * 包装器据此**再读一次同一端口**取 (id, revision) 并据此定位预留行 —— 不接受客户端在 body 里
 * 自由声明的 id 作为账本标识。若该标识**不是** `object_key` 允许的形状
 * （1..80 小写字母/数字/`_-.:`），包装器**拒绝派发**（fail-closed）：宁可拒绝，
 * 也不把无法如实记入账本的对象发出去。
 */
import { PrivacyError } from '../../../../packages/privacy/errors.mjs';
import { failureCodeOf, summarizeEgressOutcome } from './ledger-pg.ts';
import type { ExportRecord, PostgresExportLedger } from './ledger-pg.ts';
import type { InFlightGuard } from '../../../../packages/privacy/in-flight.mjs';
import type { CheckedContentPort } from '../tts/content.ts';

/** 0014 `exports.object_key` 的形状（与 `ledger-pg.ts` 的 `OBJECT_KEY` 逐字同源，1..128 字符）。 */
const OBJECT_KEY = /^[a-z0-9](?:[a-z0-9_.:-]{0,126}[a-z0-9])?$/;
const OBJECT_KEY_MAX = 128;

/** 合成域在账本里的资料类型（契约外第二维度；见 `packages/privacy/constants.mjs`）。 */
export const SYNTHESIS_LEDGER_DATA_TYPE = 'checked_content';
/** 合成域在账本里的对象类型（与 `exports.object_type` 的既有取值空间并列，非新表）。 */
export const SYNTHESIS_LEDGER_OBJECT_TYPE = 'checked_content';

/**
 * 账本对象键 = `<已核对正文类型>:<已核对正文标识>`。
 *
 * 为什么把类型也编进键：`exports.object_type` 对合成域是常量 `checked_content`（维度名），
 * 正文自身的类型（`answer`/`scheme`/`dose_card`…）不另有列；而不同正文类型可以有同名的 id
 * ⇒ 只用 id 会让两个不同对象的预留行互相命中。键**不加长上限判断**在这里做，
 * 超长（含类型后 > 128）一律拒绝而不截断（标识被静默改写比拒绝更危险）。
 */
const ledgerObjectKey = (type: string, id: string): string => `${type}:${id}`;

export interface SynthesisEgressReserveInput {
  userId: string;
  authEpoch: number;
  /** 已核对正文的类型（`checked_content_ref.type`；执行期会按它重读快照）。 */
  contentType: string;
  /** 已核对正文的标识（`checked_content_ref.id`；1..80 任意字符串，**不是** uuid）。 */
  contentId: string;
  contentRevision: number;
}

export interface SynthesisEgress {
  /** `real` 才接管派发；`stub`/`preset_demo` 恒为 false（替身不记账）。 */
  readonly engaged: boolean;
  readonly note: string;
  readonly dataType: string;
  /** 受理前预留；返回 null 表示本模式不记账（替身）。 */
  reserveForAcceptance(input: SynthesisEgressReserveInput): Promise<{ exportId: string } | null>;
  /** 受理失败（预留后服务层拒绝）⇒ 把预留置终态，避免残留 `reserved` 行被后续任务误用。 */
  abandonReservation(input: { exportId: string }): Promise<void>;
  /**
   * 包装合成提供者：捕获 `available`（real 未接真实传输 ⇒ 受理处 fail-closed），
   * `real` 时接管 `synthesize` 的派发顺序。其余模式**原样返回**（逐字不变）。
   */
  provider<T extends object>(inner: T): T;
  /**
   * 为**一次受理**绑定属主：返回一个只在该请求内使用的同形门面。
   * TTS 提供者的 `synthesize` 入参不含 `ownerUserId`，而账本必须按属主冻结快照，
   * 因此属主只能由受理处（路由）显式给出 —— 每个请求一个门面 ⇒ 并发请求互不串号，
   * 且**不依赖任何时序假设**（绑定先于服务调用发生）。
   */
  withOwner(userId: string): SynthesisEgress;
}

/**
 * 合成域（TTS）的外发账本接线。
 *
 * @param deps.executionMode 执行模式；只有 `real` 才接管派发
 * @param deps.capability    接收方能力（`recipients.capability`；合成用 `tts`）
 * @param deps.content       已核对正文读取端口（与合成服务**同一个**端口实例）
 * @param deps.deadlineMs    受理后允许派发的最长时间（超过则拒绝派发，不把陈旧快照当有效授权）
 */
export function createSynthesisEgress(deps: {
  ledger: PostgresExportLedger;
  inFlight: Pick<InFlightGuard, 'assertExecutable' | 'saveResult'>;
  executionMode: 'real' | 'stub' | 'preset_demo';
  content: CheckedContentPort;
  dataType?: string;
  purpose?: string;
  capability: string;
  deadlineMs?: number;
  now?: () => Date;
}): SynthesisEgress {
  const { ledger, inFlight, executionMode, content, capability } = deps;
  const dataType = deps.dataType ?? SYNTHESIS_LEDGER_DATA_TYPE;
  const purpose = deps.purpose ?? 'external_inference';
  const deadlineMs = deps.deadlineMs ?? 120_000;
  const now = deps.now ?? (() => new Date());
  const engaged = executionMode === 'real';
  /**
   * 属主槽（本次受理允许在账本上留下外发痕迹的用户）与
   * 「已登记过外发的对象版本 → 允许的属主集合」索引（用于按属主过滤定位预留行，不靠全局扫描）。
   * 由基础实例与它派生的门面**共享**。
   */
  const owners = new Set<string>();
  const index = new Map<string, Set<string>>();
  let providerAvailable = false;
  let providerUnavailableReason: string | null = null;

  const note = engaged
    ? '真实外发消费者已接管：reserve → assertExecutable → markSent → 提供者 → saveResult'
    : `替身/演示模式（${executionMode}）：不发生真实外发，外发账本不记账`;

  const versionedKey = (objectRevision: number, objectKey: string): string => `${objectRevision}\u0000${objectKey}`;

  /**
   * 重读已核对正文，返回**实际被朗读快照**派生出的账本对象键与 revision；
   * 取不到快照、类型不一致或标识不合法 ⇒ 拒绝派发（fail-closed，不产生任何外发）。
   */
  async function readSnapshot(targetRef: { type: string; id: string; revision: number }): Promise<{
    objectKey: string;
    objectRevision: number;
  }> {
    let snapshot: { type?: unknown; id?: unknown; revision?: unknown } | null;
    try {
      snapshot = await content.read({ type: targetRef.type, id: targetRef.id });
    } catch {
      // 端口抛错 = 取不到核对状态（与合成服务同一映射口径：不当作 approved）。
      throw new PrivacyError('OBJECT_UNAVAILABLE', '取不到已核对正文快照，禁止派发');
    }
    if (snapshot === null || snapshot === undefined) {
      throw new PrivacyError('OBJECT_UNAVAILABLE', '已核对正文不可见，禁止派发');
    }
    const id = snapshot.id;
    const revision = snapshot.revision;
    const type = snapshot.type;
    // 快照必须回指同一个 (type,id)：端口返回别的对象 ⇒ 标识不可信，拒绝（不给错对象记账）。
    if (typeof type !== 'string' || type !== targetRef.type || typeof id !== 'string' || id !== targetRef.id) {
      throw new PrivacyError('OBJECT_UNAVAILABLE', '已核对正文快照与请求标识不一致，禁止派发');
    }
    if (id.length > 80) {
      throw new PrivacyError('INVALID_REQUEST', '已核对正文标识超长（>80），禁止派发');
    }
    const objectKey = ledgerObjectKey(type, id);
    if (objectKey.length > OBJECT_KEY_MAX || !OBJECT_KEY.test(objectKey)) {
      throw new PrivacyError('INVALID_REQUEST', '已核对正文标识不是合法的账本对象键（1..128 小写字母/数字/_-.:）');
    }
    if (!Number.isInteger(revision) || (revision as number) < 1) {
      throw new PrivacyError('INVALID_REQUEST', '已核对正文 revision 非法');
    }
    return { objectKey, objectRevision: revision as number };
  }

  /** 预留成功后登记「对象版本 → 属主」，供执行期按属主定位预留行。 */
  function noteReservation(record: ExportRecord): void {
    const key = versionedKey(record.objectRevision, record.objectId);
    const existing = index.get(key);
    if (existing === undefined) index.set(key, new Set([record.userId]));
    else existing.add(record.userId);
  }

  /**
   * 定位本次派发对应的预留行：
   *   1. 先按「登记过该对象版本的属主」逐个查（每个候选都带 `userId` 过滤）—— 不会命中他人的行；
   *   2. 一个候选都没登记过（进程重启后的孤儿预留行）⇒ 退化为按对象版本查一次；
   *   3. 查到属主不在本次受理的属主集合内 ⇒ **拒绝派发**（绝不替他人在账本上留下外发痕迹）。
   */
  async function resolveObject(input: { objectKey: string; objectRevision: number }): Promise<ExportRecord | null> {
    const candidates = index.get(versionedKey(input.objectRevision, input.objectKey)) ?? new Set<string>();
    for (const userId of candidates) {
      const found = await ledger.findReservedByObject({
        objectType: SYNTHESIS_LEDGER_OBJECT_TYPE,
        objectKey: input.objectKey,
        objectRevision: input.objectRevision,
        userId,
      });
      if (found !== null) return found;
    }
    const unscoped = await ledger.findReservedByObject({
      objectType: SYNTHESIS_LEDGER_OBJECT_TYPE,
      objectKey: input.objectKey,
      objectRevision: input.objectRevision,
    });
    if (unscoped === null) return null;
    if (owners.size === 0) return unscoped;
    if (!owners.has(unscoped.userId)) {
      throw new PrivacyError('OBJECT_UNAVAILABLE', '外发预留不属于本次受理的属主，禁止派发');
    }
    return unscoped;
  }

  /** 一次受理的预留实现（`userId` 由闭包固定；门面与基础实例共用）。 */
  async function reserveFor(userId: string, input: SynthesisEgressReserveInput): Promise<{ exportId: string } | null> {
    if (!engaged) return null;
    // 红线：real 且真实传输未接入 ⇒ **在任何账本变更之前** fail-closed（503，可重试）。
    if (!providerAvailable) {
      throw new PrivacyError(
        'PROVIDER_UNAVAILABLE',
        providerUnavailableReason ?? '真实外发传输未接入：real 模式 fail-closed',
        { retryable: true },
      );
    }
    owners.add(userId);
    // 受理时就重读快照并冻结标识（执行期会再重读一次；不一致 ⇒ 找不到同版本预留行 ⇒ 拒绝派发）。
    const snapshot = await readSnapshot({
      type: input.contentType,
      id: input.contentId,
      revision: input.contentRevision,
    });
    const recipientId = await ledger.resolveRecipient({ userId, purpose, capability });
    const record = await ledger.reserve({
      userId,
      authEpoch: input.authEpoch,
      objectType: SYNTHESIS_LEDGER_OBJECT_TYPE,
      objectKey: snapshot.objectKey,
      objectRevision: snapshot.objectRevision,
      dataType,
      purpose,
      recipientId,
      sourceVersion: null,
    });
    noteReservation(record);
    return { exportId: record.id };
  }

  async function abandon(exportId: string): Promise<void> {
    if (!engaged) return;
    // 受理在预留之后失败：把预留置终态（active→failed），避免残留 reserved 行被后续任务误用。
    await ledger.markFailed(exportId, { errorCode: 'ACCEPTANCE_FAILED' }).catch(() => {});
  }

  function provider<T extends object>(inner: T): T {
    const probe = inner as { available?: boolean; unavailableReason?: string | null };
    providerAvailable = probe?.available === true;
    providerUnavailableReason = probe?.unavailableReason ?? null;
    if (!engaged) return inner;
    const wrapped = { ...(inner as Record<string, unknown>) };
    wrapped['synthesize'] = async (input: {
      jobId?: string;
      text?: unknown;
      locale?: unknown;
      targetRef?: { type?: unknown; id?: unknown; revision?: unknown };
    }) => {
      const target = input?.targetRef;
      if (target === undefined || target === null || typeof target !== 'object') {
        throw new PrivacyError('OBJECT_UNAVAILABLE', '缺少已核对正文引用，禁止派发');
      }
      const snapshot = await readSnapshot({
        type: String(target.type),
        id: String(target.id),
        revision: Number(target.revision),
      });
      const record = await resolveObject(snapshot);
      if (record === null) {
        // 未登记即派发 ⇒ 拒绝（fail-closed），不产生任何外发。
        throw new PrivacyError('OBJECT_UNAVAILABLE', '无外发预留（未登记的外发被拒绝）');
      }
      // 授权快照时效：超过受理后允许的最长时间即拒绝派发（陈旧快照不得当作当前授权）。
      const requestedAt = Date.parse(String(record.requestedAt ?? ''));
      if (Number.isFinite(requestedAt) && requestedAt + deadlineMs < now().getTime()) {
        throw new PrivacyError('OBJECT_UNAVAILABLE', '外发预留已超过授权时效，禁止派发');
      }
      if (typeof input.jobId === 'string') await ledger.linkJob({ exportId: record.id, jobId: input.jobId });
      await inFlight.assertExecutable({ exportId: record.id, userId: record.userId });
      const sent = await ledger.markSent(record.id);
      let outcome: unknown;
      try {
        outcome = await (inner as unknown as Record<string, (value: unknown) => Promise<unknown>>)['synthesize']!(input);
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
  }

  const base: SynthesisEgress = {
    engaged,
    note,
    dataType,
    reserveForAcceptance: (input) => reserveFor(input.userId, input),
    abandonReservation: (input) => abandon(input.exportId),
    provider,
    withOwner(userId: string): SynthesisEgress {
      // 同形门面：只把「预留/放弃/属主绑定」固定到本次受理的属主，
      // `provider`/`engaged`/`note`/`dataType` **沿用基础实例**（提供者包装只做一次）。
      return {
        engaged,
        note,
        dataType,
        provider: base.provider,
        reserveForAcceptance: (input) => reserveFor(userId, input),
        abandonReservation: base.abandonReservation,
        withOwner: base.withOwner,
      };
    },
  };
  return base;
}
