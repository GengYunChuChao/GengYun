/**
 * GY-I16（#16）· 收藏／历史接入 **F13 注销删除注册协议**（`packages/privacy`，GY-I27 已合并）。
 *
 * ## 为什么是"接入"而不是"另起一套"
 * issue #16 第 4 项要求："注销删除接 F13：复用已合并的 `packages/privacy` 删除注册协议
 * （**不另起一套**）"。因此本文件：
 *   - 用已合并的 `createDeletionRegistry()`（模块注册协议）建注册表；
 *   - 用已合并的 `services/api/src/privacy/egress.ts::createPrivacyDeletionCoordinator()`
 *     （它本身就是 `packages/privacy/deletion-modules.mjs` 的封套）建成"全模块"协调器；
 *   - 只把**本片自己的两个模块** `favorites` / `history` 注册进去，各带一个删除处理器。
 * 本文件**不实现**删除流程本身（7 日在线 / 30 日备份 / 第三方证据 / 恢复清单重放属 GY-I19），
 * 也不注册任何契约路由。
 *
 * ## 已合并协议的两个约束（如实适配，不改协议）
 * 1. **处理器拿不到主体**：`executeHandlers` 调用处理器时只传 `{ requestId, module }`。
 *    因此本适配器在**创建请求时**绑定 `requestId → userId`，处理器按 `requestId` 反查主体；
 *    反查不到即抛错（由协议折叠为 `blocked` + `HANDLER_FAILED`），**不会**清理到任何人的数据。
 * 2. **`onlineState`/`backupState` 必须都在白名单内**，且 `completed` 必须带非空 `evidenceRef`。
 *    本适配器的两条状态各有事实依据：
 *    - `onlineState`：本模块**真的**把该主体的在线行删掉了 ⇒ `completed`，
 *      证据为 `"<module>:online-purged:<删除行数>"`（计数即证据，不含任何私有正文）；
 *    - `backupState`：备份副本的清除**本片未实现**（属 GY-I19）⇒ 默认 `pending`
 *      （**不谎称 completed**）。接线的 `backupPurge` 端口返回已清除且有证据时才置 `completed`。
 *      因此在备份清除接线之前，回执会如实显示该模块**未完成**（这是缺口，不是通过）。
 *
 * ## 与「收藏／历史不自动转成已使用事实」的关系
 * 本文件是**删除**方向的接线（用户权利），与"收藏=已使用"毫无关系；它不写任何使用类字段。
 */
import { createDeletionRegistry } from '../../../../packages/privacy/deletion.mjs';
import type { DeletionCoordinator } from '../../../../packages/privacy/deletion-modules.mjs';
import { createPrivacyDeletionCoordinator } from './egress.ts';

/** 注册到 F13 协议的模块名（闭集；`createDeletionCoordinator` 只接受闭集内的名字）。 */
export const FAVORITES_DELETION_MODULE = 'favorites';
export const HISTORY_DELETION_MODULE = 'history';

/** 必需模块闭集（本轮只声明本片的两个模块；其它域各自注册自己的模块）。 */
export const USER_DATA_DELETION_MODULES = [FAVORITES_DELETION_MODULE, HISTORY_DELETION_MODULE] as const;

/** 按主体清空的存储原语（只用得到这一个方法，避免本适配器拿到多余能力）。 */
export interface OwnerPurgeStore {
  deleteAllByOwner(ownerId: string): Promise<number>;
}

/**
 * 备份副本清除端口。**默认未接线** ⇒ `backupState: 'pending'`（不谎称完成）。
 * 接线（GY-I19）后返回 `{ purged: true, evidenceRef }` 即置 `completed`。
 */
export interface BackupPurgePort {
  readonly kind: 'wired' | 'unwired';
  readonly available: boolean;
  purge(input: { userId: string; module: string; onlineRemoved: number }): Promise<{ purged: boolean; evidenceRef?: string }>;
}

export function createUnwiredBackupPurgePort(
  note = '备份副本清除尚未接线（属 GY-I19）：备份状态保持 pending，不谎称完成',
): BackupPurgePort {
  void note;
  return {
    kind: 'unwired',
    available: false,
    async purge() {
      return { purged: false };
    },
  };
}

export interface UserDataDeletionDeps {
  favoritesStore: OwnerPurgeStore;
  historyStore: OwnerPurgeStore;
  /** 备份副本清除端口；不传即未接线（`backupState` 恒为 `pending`）。 */
  backupPurge?: BackupPurgePort;
  now?: () => Date;
}

/** 一次注销清理的诊断记录（内部；不出契约）。 */
export interface PurgeAuditEntry {
  requestId: string;
  userId: string;
  module: string;
  onlineRemoved: number;
  backupState: string;
  at: string;
}

export interface UserDataDeletionRegistry {
  readonly coordinator: DeletionCoordinator;
  /** 必需模块闭集。 */
  requiredModules(): string[];
  /**
   * 为**某个用户**创建注销删除请求（在已合并协议之上绑定主体）。
   * 未注册齐全部必需模块时由协调器抛 `OBJECT_UNAVAILABLE`（不假装能完成）。
   */
  requestDeletionFor(userId: string, options?: { generation?: number; receiptInput?: string | null }): Record<string, unknown>;
  executeHandlers(requestId: string): Promise<Record<string, unknown>>;
  completionStatus(requestId: string): { state: string; completed: boolean; missingModules: readonly string[] };
  receipt(requestId: string): Record<string, unknown> | null;
  /** 诊断审计（内部；只含模块名/行数/状态，不含任何私有正文或凭据）。 */
  audit(): PurgeAuditEntry[];
}

/**
 * 建注册表 + 协调器 + 两个模块处理器。
 *
 * 处理器语义（逐条与已合并协议对齐）：
 *   - 只清理 `requestId` 绑定的那个主体的数据；反查不到主体 ⇒ 抛错（协议折叠为 `blocked`）；
 *   - `onlineState`：`deleteAllByOwner` 成功 ⇒ `completed` + 证据 `<module>:online-purged:<n>`；
 *   - `backupState`：`backupPurge` 已接线且返回 `purged:true` 且有证据 ⇒ `completed`
 *     （证据 `<module>:backup-purged`）；否则 `pending`；
 *   - 抛出任何异常都由协议折叠为 `blocked`（本适配器不吞错）。
 */
export function createUserDataDeletion(input: UserDataDeletionDeps): UserDataDeletionRegistry {
  const now = input.now ?? (() => new Date());
  const backupPurge = input.backupPurge ?? createUnwiredBackupPurgePort();
  const registry = createDeletionRegistry({ now });
  const coordinator = createPrivacyDeletionCoordinator({
    registry,
    requiredModules: [...USER_DATA_DELETION_MODULES],
    now,
  });
  /** 请求 → 主体绑定（已合并协议的处理器入参不含主体，故在此绑定）。 */
  const subjectByRequest = new Map<string, string>();
  const auditLog: PurgeAuditEntry[] = [];

  function subjectOf(requestId: string): string {
    const userId = subjectByRequest.get(requestId);
    if (userId === undefined) {
      // 反查不到主体 ⇒ 绝不用"空主体"去清理（那会删到错误范围）。抛错让协议折叠为 blocked。
      throw new Error('删除请求未绑定主体：拒绝清理');
    }
    return userId;
  }

  function makeHandler(module: string, store: OwnerPurgeStore) {
    return async (input_: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const requestId = String(input_['requestId'] ?? '');
      const userId = subjectOf(requestId);
      const onlineRemoved = await store.deleteAllByOwner(userId);
      let backupState = 'pending';
      let evidenceRef = `${module}:online-purged:${onlineRemoved}`;
      if (backupPurge.available) {
        const backup = await backupPurge.purge({ userId, module, onlineRemoved });
        const backupEvidence = typeof backup.evidenceRef === 'string' ? backup.evidenceRef.trim() : '';
        if (backup.purged === true && backupEvidence.length > 0) {
          backupState = 'completed';
          evidenceRef = `${evidenceRef};${module}:backup-purged:${backupEvidence}`;
        }
      }
      auditLog.push({
        requestId,
        userId,
        module,
        onlineRemoved,
        backupState,
        at: now().toISOString(),
      });
      return { onlineState: 'completed', backupState, evidenceRef, errorCode: null };
    };
  }

  coordinator.registerModule(FAVORITES_DELETION_MODULE, makeHandler(FAVORITES_DELETION_MODULE, input.favoritesStore));
  coordinator.registerModule(HISTORY_DELETION_MODULE, makeHandler(HISTORY_DELETION_MODULE, input.historyStore));

  return {
    coordinator,
    requiredModules: () => coordinator.requiredModules(),
    requestDeletionFor(userId, options = {}) {
      if (typeof userId !== 'string' || userId.length === 0) {
        throw new Error('注销删除请求必须绑定非空主体');
      }
      const request = coordinator.createDeletionRequest(options);
      const id = String(request['id']);
      subjectByRequest.set(id, userId);
      return request;
    },
    executeHandlers: (requestId) => coordinator.executeHandlers(requestId),
    completionStatus: (requestId) => coordinator.completionStatus(requestId),
    receipt: (requestId) => coordinator.receipt(requestId),
    audit: () => auditLog.map((entry) => ({ ...entry })),
  };
}
