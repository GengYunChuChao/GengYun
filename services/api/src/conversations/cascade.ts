/**
 * GY-I12（#12）· 会话/轮次级联删除端口（契约 `deleteTurn` 的 description：
 * 「If-Match对应turn；级联音频/结果/外发处理但不删他人媒体。」）。
 *
 * 端口范式**逐条沿用**已合并的 `services/api/src/history/cascade.ts`（#16）：
 *   - 端口自述 `kind`（`'wired' | 'unwired'`）与 `available` 两个字段，
 *     **未接线与就绪对调用方可见**，不靠"没有异常"暗示成功；
 *   - 处置结果是**闭集** `'initiated' | 'unwired' | 'failed'`：只区分「已启动 / 未接线 / 失败」，
 *     **绝不**声称"已完成删除"（真正的完成证据属删除协议回执，不属本端口的返回值）；
 *   - `failed` **不回滚已完成的主体删除**：轮次行已经删掉了，级联处置失败必须如实披露
 *     （响应头 `X-GY-Cascade`），而不是把删除改写成失败。
 *
 * 本片**不**实现音频/外发处理的实际删除（转写媒体归语音域、外发副本归删除协议 GY-I19）：
 * 因此默认实现是 `createUnwiredTurnCascadePort()`，如实返回 `unwired`。这与契约的 202
 * `AckEnvelope`（`accepted: true`）不矛盾 —— 202 表达的是"删除请求已受理并生效于本域行"，
 * 不是"跨域副本都已清除"。
 */
import type { DeletionCoordinator } from '../../../../packages/privacy/deletion-modules.mjs';
import { createDeletionRegistry } from '../../../../packages/privacy/deletion.mjs';
import { createPrivacyDeletionCoordinator } from '../privacy/egress.ts';

/** 级联处置结果闭集（与 `history/cascade.ts` 的 `CascadeDisclosure` 同口径）。 */
export const CASCADE_DISCLOSURE = ['initiated', 'unwired', 'failed'] as const;
export type CascadeDisclosure = (typeof CASCADE_DISCLOSURE)[number];

export interface TurnCascadeRequest {
  userId: string;
  conversationId: string;
  turnId: string;
  /** 被删轮次引用的转写（`TargetRef`）：文字输入为 `null`（无音频可级联）。 */
  transcriptionRef: { type: string; id: string; revision: number } | null;
  /** 该轮次的回答 id（若已有回答）：结果副本的清理目标。 */
  answerId: string | null;
}

export interface TurnCascadeOutcome {
  disposition: CascadeDisclosure;
  note: string;
}

export interface TurnCascadePort {
  readonly kind: 'wired' | 'unwired';
  readonly note: string;
  readonly available: boolean;
  /** 处置一个**已被删除**的轮次所留下的跨域副本（音视频/结果/外发）。 */
  initiate(request: TurnCascadeRequest): Promise<TurnCascadeOutcome>;
}

/** 未接线的级联端口：如实返回 `unwired`，不假装完成。 */
export function createUnwiredTurnCascadePort(
  note = '音频/结果/外发副本的级联处理尚未接线（属语音域与删除协议 GY-I19）：本端口不声称完成',
): TurnCascadePort {
  return {
    kind: 'unwired',
    note,
    available: false,
    async initiate() {
      return { disposition: 'unwired', note };
    },
  };
}

/**
 * 装置一个**已接线**的级联端口：实际处置动作由调用方给定的 `cleaners` 承担。
 *
 * 语义硬边界（与 #16 同口径）：
 *   - 任一清理器抛错 ⇒ 整体 `failed`（**不**静默忽略、**不**回滚已完成的删除）；
 *   - 清理器报 `'unsupported'` ⇒ 该项如实记为未接线（`unwired`），不当作成功；
 *   - 全部清理器报 `'cleaned'` 才算 `initiated`（"已启动并执行到位"，仍不等于跨域回执完成）。
 */
export interface TurnCleanerResult {
  state: 'cleaned' | 'unsupported' | 'failed';
  note?: string;
}

export function createWiredTurnCascadePort(options: {
  cleaners: ReadonlyArray<(request: TurnCascadeRequest) => Promise<TurnCleanerResult>>;
  note?: string;
}): TurnCascadePort {
  const note = options.note ?? '级联处置已接线：逐项由本域清理器执行，失败如实披露';
  return {
    kind: 'wired',
    note,
    available: true,
    async initiate(request) {
      let sawUnsupported = false;
      for (const clean of options.cleaners) {
        let result: TurnCleanerResult;
        try {
          result = await clean(request);
        } catch {
          return { disposition: 'failed', note };
        }
        if (result.state === 'failed') return { disposition: 'failed', note };
        if (result.state === 'unsupported') sawUnsupported = true;
      }
      return { disposition: sawUnsupported ? 'unwired' : 'initiated', note };
    },
  };
}

/** F13 注销删除协议里的模块名（闭集内的名字，见 `createDeletionCoordinator`）。 */
export const CONVERSATIONS_DELETION_MODULE = 'conversations';

/** 本域在 F13 协议里需要的存储原语（只暴露按主体清空这一个能力）。 */
export interface ConversationPurgeStore {
  deleteAllByOwner(ownerId: string): Promise<number>;
}

export interface ConversationDeletionRegistration {
  module: string;
  /** 随 F13 请求绑定主体的删除请求（处理器按 `requestId` 反查主体 ⇒ 只清理该主体）。 */
  requestDeletionFor(userId: string, options?: { generation?: number; receiptInput?: string | null }): Record<string, unknown>;
  executeHandlers(requestId: string): Promise<Record<string, unknown>>;
  completionStatus(requestId: string): { state: string; completed: boolean; missingModules: readonly string[] };
  receipt(requestId: string): Record<string, unknown> | null;
  /** 诊断审计（只含模块名/行数/状态，不含任何私有正文）。 */
  audit(): Array<{ requestId: string; userId: string; onlineRemoved: number; backupState: string; at: string }>;
}

/**
 * 把**会话/轮次/回答**注册进已合并的 F13 删除注册协议（`packages/privacy`，**不另起一套**）。
 *
 * ⚠️ C1b-3（§7 P0-3 路径①）之后：**生产装配不再走本函数**。会话域已并入
 * `services/api/src/privacy/user-data-deletion.ts` 的 `USER_DATA_DELETION_MODULES`
 * （`CONVERSATIONS_DELETION_MODULE`），一次注销＝一个 requestId、一份回执、一条证据链。
 * 本函数保留为**独立的单域装配口**（离线验证/单模块驱动用），不再由 `app.ts` 创建；
 * 那段「闭集被既有断言锁住所以本域自带闭集」的理由已成历史（闭集当时无法改成扩集）。
 *
 * 处理器语义（逐条与已合并协议对齐）：
 *   - `onlineState`：本模块**真的**删掉了该主体的会话行 ⇒ `completed`，
 *     证据为 `conversations:online-purged:<会话行数>`（计数即证据，不含私有正文）；
 *   - `backupState`：备份副本清除本片未实现（属 GY-I19）⇒ 恒 `pending`（**不谎称完成**）；
 *   - 反查不到主体 ⇒ 抛错，由协议折叠为 `blocked`（绝不用空主体清理）。
 */
export function createConversationDeletionRegistration(
  store: ConversationPurgeStore,
  options: { coordinator: DeletionCoordinator; now?: () => Date },
): ConversationDeletionRegistration {
  const now = options.now ?? (() => new Date());
  const coordinator = options.coordinator;
  const subjectByRequest = new Map<string, string>();
  const auditLog: Array<{ requestId: string; userId: string; onlineRemoved: number; backupState: string; at: string }> = [];

  coordinator.registerModule(CONVERSATIONS_DELETION_MODULE, async (input: Record<string, unknown>) => {
    const requestId = String(input['requestId'] ?? '');
    const userId = subjectByRequest.get(requestId);
    if (userId === undefined) throw new Error('删除请求未绑定主体：拒绝清理');
    const onlineRemoved = await store.deleteAllByOwner(userId);
    const backupState = 'pending';
    auditLog.push({ requestId, userId, onlineRemoved, backupState, at: now().toISOString() });
    return {
      onlineState: 'completed',
      backupState,
      evidenceRef: `${CONVERSATIONS_DELETION_MODULE}:online-purged:${onlineRemoved}`,
      errorCode: null,
    };
  });

  return {
    module: CONVERSATIONS_DELETION_MODULE,
    requestDeletionFor(userId, opts = {}) {
      if (typeof userId !== 'string' || userId.length === 0) {
        throw new Error('注销删除请求必须绑定非空主体');
      }
      const request = coordinator.createDeletionRequest(opts);
      subjectByRequest.set(String(request['id']), userId);
      return request;
    },
    executeHandlers: (requestId) => coordinator.executeHandlers(requestId),
    completionStatus: (requestId) => coordinator.completionStatus(requestId),
    receipt: (requestId) => coordinator.receipt(requestId),
    audit: () => auditLog.map((entry) => ({ ...entry })),
  };
}

/** 契约 `TargetRef`（只用到三键，避免依赖具体域的类型文件）。 */
export interface CascadeTargetRef {
  type: string;
  id: string;
  revision: number;
}

/**
 * 建**只含本模块**的 F13 删除协调器并注册处理器（独立单域装配口）。
 *
 * ⚠️ C1b-3（§7 P0-3 路径①）后 `app.ts` **不再**调用本函数：会话域已并入
 * `privacy/user-data-deletion.ts` 的统一闭集（同一 requestId 账本）。保留它只用于
 * 「只想单独驱动会话域」的离线/单元场景（`tests/unit/conversation-deletion.test.mjs`），
 * 生产装配必须走统一账本 —— 两个账本 = 两次请求 = 回执对不上。
 */
export function createConversationDeletion(
  store: ConversationPurgeStore,
  options: { now?: () => Date } = {},
): ConversationDeletionRegistration {
  const now = options.now ?? (() => new Date());
  const registry = createDeletionRegistry({ now });
  const coordinator = createPrivacyDeletionCoordinator({
    registry,
    requiredModules: [CONVERSATIONS_DELETION_MODULE],
    now,
  });
  return createConversationDeletionRegistration(store, { coordinator, now });
}
