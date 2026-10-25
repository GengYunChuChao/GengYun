/**
 * GY-I27（#29）· **合成域**（普通话 TTS 朗读）的外发账本接线。
 *
 * 与 `task-egress.ts`（识别/转写/标签 OCR 三个媒体任务域）**同形、同口径**，差异只有三处：
 *   1. 对象标识是**文本型**（`checked_content_ref.id` 是 1..80 任意字符串，不是 uuid）⇒
 *      走 0014 新增的 `exports.object_key` 列，并以**该条正文的真实内容类型**作为
 *      账本 `object_type`（`answer`/`scheme`/… 六值闭集，见 `SYNTHESIS_LEDGER_DATA_TYPE`
 *      下方的说明；`checked_content` 只用于资料维度 `data_type`）；
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

/** 0014 `exports.object_key` 的形状（与 `ledger-pg.ts` 的 `OBJECT_KEY` 逐字同源，1..80 字符）。 */
const OBJECT_KEY = /^[a-z0-9](?:[a-z0-9_.:-]{0,78}[a-z0-9])?$/;
const OBJECT_KEY_MAX = 80;

/** 合成域在账本里的资料类型（契约外第二维度；见 `packages/privacy/constants.mjs`）。 */
export const SYNTHESIS_LEDGER_DATA_TYPE = 'checked_content';

/*
 * 账本**对象类型** = 该条已核对正文的**真实内容类型**本身（`checked_content_ref.type`：
 * `answer`/`scheme`/`herbicide`/`species`/`static_region`/`dose_card`，闭集见
 * `services/api/src/tts/state.ts:53-60`，6 值全部在契约 `TargetRef.type` 的 17 值枚举内）。
 *
 * 为什么不再用常量 `checked_content`：`checked_content` 是**资料维度**（`data_type`，见
 * `SYNTHESIS_LEDGER_DATA_TYPE` 与 `packages/privacy/constants.mjs:45`），不是外发对象的实体类型。它被写进
 * `exports.object_type` 后会被 `/me/exports` 原样投影成契约 `object_ref.type`
 * （`packages/privacy/egress.mjs:397`），而 `TargetRef.type` 的 17 值闭集里没有它
 * ⇒ 越枚举，整页投影失败（503）。改成真实内容类型后，(type,id) 二元组本身就能唯一
 * 定位对象，**不再需要**把类型编进 object_key 来区分同名 id。
 */

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
  /**
   * 把**一个已受理的任务**绑定到它的属主（受理处拿到服务层返回的 `jobId` 后立即调用）。
   *
   * 为什么必须显式绑定：`synthesize` 的入参只有 `{jobId,text,locale,targetRef}`，**不含属主**，
   * 而账本行必须按属主定位。若执行期不按本次派发的属主过滤，两用户对**同一对象版本**各持
   * `reserved` 时，B 的派发会命中 A 的行并把 A 的外发翻成 `sent`、把 B 的 `job_id` 记到 A 名下
   * （跨用户串用，全程静默）。绑定后执行期只按该属主过滤（`findReservedByObject({userId})`），
   * 不绑定 ⇒ **拒绝派发**（fail-closed，绝不回退到「不按属主过滤」的全局查询）。
   */
  bindJobOwner(input: { jobId: string; userId: string }): void;
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
   * 属主槽：**按任务**记录「这次派发允许在账本上留下外发痕迹的属主」。
   *
   * 为什么必须按任务而不是按对象版本：`synthesize` 的入参不含属主，而两用户可以对**同一
   * 对象版本**各持一行 `reserved`（受理时各冻结一次快照）。若执行期先按「对象版本」全局定位
   * 再回头核对属主，就会命中他人的行（B 的派发把 A 的外发翻成 `sent`、把 B 的 `job_id` 记到
   * A 名下）。按 `jobId` 绑定属主后，查询本身带属主过滤 ⇒ 结构上不可能命中他人行。
   */
  const jobOwners = new Map<string, string>();
  /** 已预留的外发（`exportId` → 属主），仅用于诊断与自证，不参与定位。 */
  const reservations = new Map<string, string>();
  let providerAvailable = false;
  let providerUnavailableReason: string | null = null;

  const note = engaged
    ? '真实外发消费者已接管：reserve → assertExecutable → markSent → 提供者 → saveResult'
    : `替身/演示模式（${executionMode}）：不发生真实外发，外发账本不记账`;

  /** 任务属主键：`jobId` 与属主一一对应；未绑定的任务没有属主 ⇒ 拒绝派发。 */
  const jobKey = (jobId: string): string => jobId;

  /**
   * 重读已核对正文，返回**实际被朗读快照**派生出的账本对象二元组 (类型, 键) 与 revision；
   * 取不到快照、类型不一致或标识不合法 ⇒ 拒绝派发（fail-closed，不产生任何外发）。
   */
  async function readSnapshot(targetRef: { type: string; id: string; revision: number }): Promise<{
    objectType: string;
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
    // 对象键 = 裸 id（不再拼 `<type>:` 前缀）：类型已作为对象类型单列，前缀只会白占
    // 契约 `TargetRef.id` 的 80 字符预算。超长一律拒绝而不截断（标识被静默改写比拒绝更危险）。
    const objectKey = id;
    if (objectKey.length > OBJECT_KEY_MAX || !OBJECT_KEY.test(objectKey)) {
      throw new PrivacyError('INVALID_REQUEST', '已核对正文标识不是合法的账本对象键（1..80 小写字母/数字/_-.:）');
    }
    if (!Number.isInteger(revision) || (revision as number) < 1) {
      throw new PrivacyError('INVALID_REQUEST', '已核对正文 revision 非法');
    }
    return { objectType: type, objectKey, objectRevision: revision as number };
  }

  /**
   * 定位本次派发对应的预留行：**只按本次派发所属的属主**过滤（`userId` 进查询条件），
   * 因此永远不会命中他人的预留行。
   *
   *   1. 任务已由受理处绑定属主 ⇒ 按 `(属主, 对象类型, 对象键, revision)` 查一次；查不到 ⇒ 拒绝派发；
   *   2. 任务未绑定属主 ⇒ **拒绝派发**（fail-closed）。绝不退化成「不按属主过滤」的全局查询 ——
   *      那正是跨用户串用预留行的入口（B 的派发消耗 A 的预留）。
   */
  async function resolveObject(input: {
    jobId: string;
    objectType: string;
    objectKey: string;
    objectRevision: number;
  }): Promise<ExportRecord | null> {
    const owner = jobOwners.get(jobKey(input.jobId));
    if (owner === undefined) {
      throw new PrivacyError('OBJECT_UNAVAILABLE', '本次派发未绑定属主，禁止派发（不按对象版本全局匹配预留行）');
    }
    return ledger.findReservedByObject({
      objectType: input.objectType,
      objectKey: input.objectKey,
      objectRevision: input.objectRevision,
      userId: owner,
    });
  }

  /**
   * 把任务绑定到属主（受理处在拿到 `jobId` 后调用）。**只记录**、不校验账本状态：
   * 定位与授权仍然由执行期的「按属主查预留行」+ `assertExecutable` + `markSent` 三段把守，
   * 绑定本身不构成授权。
   */
  function bindJobOwner(input: { jobId: string; userId: string }): void {
    if (typeof input.jobId !== 'string' || input.jobId.length === 0) return;
    if (typeof input.userId !== 'string' || input.userId.length === 0) return;
    jobOwners.set(jobKey(input.jobId), input.userId);
  }

  /** 一次受理的预留实现（`userId` 由闭包固定；门面与基础实例共用）。 */
  async function reserveFor(userId: string, input: SynthesisEgressReserveInput): Promise<{ exportId: string } | null> {
    if (!engaged) return null;
    // 红线：real 且真实传输未接入／缺真实 TTS 凭据 ⇒ **在任何账本变更之前** fail-closed（503，**不可重试**）。
    // 未接线、缺凭据都属配置类：需运维改配置，单靠等待时间不会自愈 ⇒ `retryable` 必须为 false
    // 口径见 `services/api/src/errors.ts:32/:35`；与 `privacy/task-egress.ts:91-92`、
    // `packages/privacy/egress.mjs:116-117` 同形。
    if (!providerAvailable) {
      throw new PrivacyError(
        'PROVIDER_UNAVAILABLE',
        providerUnavailableReason ?? '真实外发传输未接入：real 模式 fail-closed',
        { retryable: false },
      );
    }
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
      objectType: snapshot.objectType,
      objectKey: snapshot.objectKey,
      objectRevision: snapshot.objectRevision,
      dataType,
      purpose,
      recipientId,
      sourceVersion: null,
    });
    reservations.set(record.id, record.userId);
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
      // 属主绑定：`synthesize` 入参不含属主，任务与属主的对应由受理处登记（`bindJobOwner`）。
      // 未登记 ⇒ 拒绝派发（fail-closed）——否则就得按对象版本全局匹配预留行，那是跨用户串用的入口。
      const jobId = input?.jobId;
      if (typeof jobId !== 'string' || jobId.length === 0) {
        throw new PrivacyError('OBJECT_UNAVAILABLE', '缺少任务标识，禁止派发（无法确定外发属主）');
      }
      const snapshot = await readSnapshot({
        type: String(target.type),
        id: String(target.id),
        revision: Number(target.revision),
      });
      const record = await resolveObject({ jobId, ...snapshot });
      if (record === null) {
        // 未登记即派发 ⇒ 拒绝（fail-closed），不产生任何外发。
        throw new PrivacyError('OBJECT_UNAVAILABLE', '无外发预留（未登记的外发被拒绝）');
      }
      // 授权快照时效：超过受理后允许的最长时间即拒绝派发（陈旧快照不得当作当前授权）。
      const requestedAt = Date.parse(String(record.requestedAt ?? ''));
      if (Number.isFinite(requestedAt) && requestedAt + deadlineMs < now().getTime()) {
        throw new PrivacyError('OBJECT_UNAVAILABLE', '外发预留已超过授权时效，禁止派发');
      }
      // 任务标识已在入口校验为非空字符串 ⇒ 直接登记（不重复判空）。
      await ledger.linkJob({ exportId: record.id, jobId });
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
    bindJobOwner,
    withOwner(userId: string): SynthesisEgress {
      // 同形门面：只把「预留/放弃」固定到本次受理的属主，
      // `provider`/`engaged`/`note`/`dataType`/`bindJobOwner` **沿用基础实例**（提供者包装只做一次）。
      return {
        engaged,
        note,
        dataType,
        provider: base.provider,
        reserveForAcceptance: (input) => reserveFor(userId, input),
        abandonReservation: base.abandonReservation,
        bindJobOwner: base.bindJobOwner,
        withOwner: base.withOwner,
      };
    },
  };
  return base;
}
