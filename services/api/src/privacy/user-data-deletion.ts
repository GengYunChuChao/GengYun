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
 * 本文件**不实现**删除流程本身（7 日在线 / 30 日备份的执行、第三方证据、恢复清单重放仍待后续片），
 * 也不注册任何契约路由。
 *
 * ## GY-I19（#19）追加：受理＝一次窄口径 `SECURITY DEFINER` 函数调用
 * 裁定一要求「注销请求持久化 + 同一事务内撤销 + `auth_epoch` 递增」全部经**唯一一个**
 * 窄口径函数完成（运行时角色对 `users.state`/`auth_epoch`/`revision` 与
 * `deletion_requests` **没有**任何直接列权限，见
 * `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的 `protected_columns`）。
 * 因此 `requests` 端口**接线**后：
 *   - `requestDeletionFor()` 在绑定主体之后**启动**持久化受理（同一事务，见
 *     `services/api/src/privacy/deletion-requests-pg.ts`）；
 *   - `executeHandlers()` 第一步 await 它 ⇒ 事务未提交就**不会**进入级联、不会签发回执、不会返回 202；
 *   - **未接线**（`requests` 缺省）时行为与追加前**逐字一致**：纯进程内，如实不持久化。
 * 仍未实现并如实登记为缺口：outbox、7/30 日到期执行、第三方完成证据、备份副本清除、恢复清单重放。
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
import type {
  CreateDeletionRequestInput,
  DeletionRequestRecord,
  DeletionRequestStore,
} from './deletion-requests-pg.ts';

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
  /**
   * GY-I19（#19）· 注销请求的**持久化受理端口**。不传即保持既有的进程内行为
   * （**不伪造持久化**）；接线后「受理」＝一次窄口径 `SECURITY DEFINER` 函数调用：
   * 同一事务内完成账号状态迁移 + `auth_epoch` 递增 + 全部会话撤销 + 注销请求落库。
   */
  requests?: DeletionRequestStore;
  /**
   * 回执 bearer 的有效期（毫秒）。接线 `requests` 时**必须显式给出**：
   * 持久列 `receipt_expires_at` 记录的期限必须与受理服务的回执期限**同源**，
   * 这里不接受第二套默认值（那会变成两套期限各自漂移）。
   */
  receiptTtlMs?: number;
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
  const requests = input.requests ?? null;
  const receiptTtlMs = input.receiptTtlMs ?? null;
  // 接线持久化受理 ⇒ 必须与受理服务的回执期限同源；缺参数就**拒绝装配**（fail closed），
  // 而不是悄悄用另一个默认 TTL 写出与回执不符的期限。
  if (requests !== null && (receiptTtlMs === null || !Number.isSafeInteger(receiptTtlMs) || receiptTtlMs <= 0)) {
    throw new Error('接线持久化注销请求时必须显式给出 receiptTtlMs（须与受理服务的回执期限同源）');
  }
  const registry = createDeletionRegistry({ now });
  const coordinator = createPrivacyDeletionCoordinator({
    registry,
    requiredModules: [...USER_DATA_DELETION_MODULES],
    now,
  });
  /** 请求 → 主体绑定（已合并协议的处理器入参不含主体，故在此绑定）。 */
  const subjectByRequest = new Map<string, string>();
  const auditLog: PurgeAuditEntry[] = [];
  /** 受理时**已启动**的持久化事务（按请求 id 挂起；由 `executeHandlers()` 先行 await）。 */
  const durableByRequest = new Map<string, Promise<DeletionRequestRecord>>();

  function requireDate(value: unknown, field: string): string {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error(`注销删除请求缺少可解析时刻：${field}`);
    }
    return value.toISOString();
  }

  /**
   * 启动持久化受理（三处写入在同一事务内，见 `services/api/db/migrations/0016_account_deletion_persistence.sql`）。
   *
   * 这里**只启动、不 await**：`requestDeletionFor` 必须保持同步（已合并协议与既有调用方的期望），
   * 真正的 await 落在 `executeHandlers()` 的第一步。因此受理路由在签回执/返回 202 之前，
   * 事务必然已经提交；失败也必然**在 202 之前**抛出，不会出现「已答应受理但库里什么都没有」。
   */
  function startDurableAcceptance(
    requestId: string,
    userId: string,
    request: Record<string, unknown>,
  ): Promise<DeletionRequestRecord> {
    const issuedAt = now().toISOString();
    const durableInput: CreateDeletionRequestInput = {
      id: requestId,
      userId,
      receiptHash: String(request['receiptHash']),
      generation: Number(request['generation']),
      requestedAt: requireDate(request['requestedAt'], 'requestedAt'),
      onlineDueAt: requireDate(request['onlineDueAt'], 'onlineDueAt'),
      backupDueAt: requireDate(request['backupDueAt'], 'backupDueAt'),
      receiptIssuedAt: issuedAt,
      // 与受理服务的回执期限同源：同一 `clock()`、同一 TTL 常量（由装配处传入 `RECEIPT_TTL_MS`）。
      receiptExpiresAt: new Date(Date.parse(issuedAt) + (receiptTtlMs as number)).toISOString(),
    };
    const pending = (requests as DeletionRequestStore).createRequest(durableInput);
    // 启动即挂空 catch：否则一个未处理的拒绝会终止进程。
    // 真正的失败在 `executeHandlers()` 处 await 同一个 promise 时如实暴露（同一个拒绝可被多次 await）。
    pending.catch(() => {});
    return pending;
  }

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
      if (requests !== null) {
        durableByRequest.set(id, startDurableAcceptance(id, userId, request));
      }
      return request;
    },
    async executeHandlers(requestId) {
      // 持久化受理（同一事务）必须先有结论：失败 ⇒ 在此抛出，**不进入级联、不签发回执、不返回 202**。
      const pending = durableByRequest.get(requestId);
      if (pending !== undefined) await pending;
      return coordinator.executeHandlers(requestId);
    },
    completionStatus: (requestId) => coordinator.completionStatus(requestId),
    receipt: (requestId) => coordinator.receipt(requestId),
    audit: () => auditLog.map((entry) => ({ ...entry })),
  };
}
