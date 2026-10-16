/**
 * GY-I19（#19）决策包 A 第 2 步 · 注销（账号删除）HTTP 面的**装配层**：
 * 把 `packages/contracts/openapi.json` 里**已冻结但服务端零实现**的两个 operation 接到
 * **既有**的删除机制上（不另起一套台账）：
 *
 * | 契约（逐字） | 本文件提供 |
 * | --- | --- |
 * | `POST /me/account/deletion` → `requestAccountDeletion` | `createAccountDeletionRequestService()` |
 * | `GET /account/deletions/{id}` → `getDeletionReceipt` | `createDeletionReceiptRegistry()` |
 *
 * ## 复用了什么（一条都没自建）
 * - **删除请求与全模块完成判定**：`services/api/src/privacy/user-data-deletion.ts`
 *   （它本身是 `packages/privacy/deletion.mjs`＋`deletion-modules.mjs` 的封套）——
 *   本文件**不**新建注册表、**不**新增模块闭集、**不**改 `USER_DATA_DELETION_MODULES`；
 * - **回执投影**：`packages/privacy/deletion-modules.mjs` 的 `receipt()`（契约 `DeletionReceipt`
 *   形状，含「未报告的必需模块以 `pending` 出现」）——本文件只在其上做**形状归一**（`projectReceipt()`）；
 * - **幂等**：`services/api/src/routes/support.ts` 的 `runIdempotent()`（既有 24h 台账；
 *   回放按结果引用**重新签发**，不回放旧响应 —— 与「只存回执 hash」同口径）；
 * - **令牌**：`services/api/src/auth/tokens.ts` 的 `mintOpaqueToken()` / `hashToken()`
 *   （256 位随机不透明 bearer；服务端只存 sha256 摘要，明文只在 202 响应里出现一次）。
 *
 * ## 三条如实性硬边界（本片红线）
 * 1. **「已受理」≠「已删除」**：202 只表示已受理，各模块在线 `completed`、备份 `pending`，
 *    整体 `state` 由协议如实回落为 `blocked`（`state-contract.md:107` 逐字「不能完成时显示blocked
 *    和逾期，不把时钟到期当完成」）；`completed` 只有在**全模块在线与备份证据齐备**时才可能出现。
 * 2. **未覆盖 ⇒ 不可完成**：`backupPurge` 未接线 ⇒ 每个模块 `backup_state: 'pending'`
 *    ⇒ 全模块完成判定恒不成立（缺口对用户与监工可见，不谎称完成）。
 * 3. **未装配 ⇒ 503**：服务端执行模式不允许本片（`real`）时，两个 operation **不注册任何回退**，
 *   由 `registerAccountDeletionRoutes()` 抛契约 `PROVIDER_UNAVAILABLE`（503，`retryable: true`）。
 *
 * ## 已知缺口（如实登记，不在本文件掩盖）
 * - **进程内状态**：删除请求与回执映射都在内存（既有 `createUserDataDeletion()` 本就在内存），
 *   `packages/contracts` / `packages/privacy` 里**没有**注销请求的持久表 ⇒ 本片**不新建迁移**
 *   （那会是第二套台账）。因此**重启后旧回执 id 一律 404** —— 这是缺口，见交接 §8。
 * - **同事务撤会话/角色/外发/在途回写**（`docs/architecture/state-contract.md:105`）**未实现**：
 *   本片只受理并如实回报状态。该缺口已如实登记，**不**在本片用「先撤会话再受理」的方式
 *   伪造（那会让 202 永远回不去，是更坏的谎）。
 */
import { mintOpaqueToken, hashToken } from '../auth/tokens.ts';
// 复用**已合并**协议的安全错误码白名单（`services/api/src/privacy/deletion-reference.d.ts:14`）：
// 回执是用户可见面，只允许白名单内的最小失败码，自由文本一律折叠。
import { SAFE_ERROR_CODES } from '../../../../packages/privacy/deletion.mjs';
import type { UserDataDeletionRegistry } from './user-data-deletion.ts';

/** 回执 bearer 的有效期：35 日（`docs/architecture/state-contract.md:107`「有效期35日」）。 */
export const RECEIPT_TTL_MS = 35 * 24 * 60 * 60 * 1000;

/** `GET /account/deletions/{id}` 的鉴权方式（契约 `deletionReceipt`）：**非登录会话**。 */
export const RECEIPT_AUTH_KIND = 'deletionReceipt';

/** 契约为注销申请声明的两个执行模式之外的模式一律 503（见文件头边界 3）。 */
export const ACCOUNT_DELETION_UNAVAILABLE_MESSAGE =
  '注销删除请求存储未接线（本基线为进程内、无注销请求持久表）：如实拒绝，不伪造受理';

/** 202 响应体（契约 `DeletionAcceptedEnvelope` 的 `data`；`meta` 由路由层补）。 */
export interface DeletionAcceptedProjection {
  receipt_token: string;
  receipt_expires_at: string;
  deletion: Record<string, unknown>;
}

export interface DeletionReceiptRecord {
  readonly tokenHash: string;
  readonly requestId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/**
 * 回执 bearer 台账形状（注入点：`registerAccountDeletionRoutes()` 用它做 `GET` 的鉴权）。
 * 与 `app.userDataDeletion` **同一份**注册表 —— 不是第二套删除台账。
 *
 * ## 续签语义（为什么重放会换发新 bearer）
 * 明文 bearer **只在 202 响应里出现一次**（台账只存 sha256 摘要）。因此幂等重放**不可能**
 * 回放旧 bearer（那需要存明文），只能为**同一个删除请求**重新签发，并**同时作废**该请求的
 * 旧摘要（`issue()` 先 `forgetRequest()`）⇒ 任一时刻**每个删除请求至多一个**有效 bearer。
 */
export interface DeletionReceiptRegistry {
  /** 为某个删除请求签发回执 bearer（明文返回一次；台账只存摘要）。 */
  issue(requestId: string): { token: string; expiresAt: string };
  /** 按明文 bearer 反查删除请求 id；未知/已过期/已换发 ⇒ `null`（调用方据此 401 / 404）。 */
  resolveRequestId(token: string): string | null;
  /** 作废某请求名下的全部 bearer（换发时内部使用；不删删除请求本身）。 */
  forgetRequest(requestId: string): number;
  /** 诊断：当前有效 bearer 条数（不含明文）。 */
  liveCount(): number;
}

/**
 * 回执 bearer 台账。
 *
 * - 只存 sha256 摘要（`auth/tokens.ts::hashToken`），**不存明文**、不写日志、不进 URL；
 * - `now` 可注入 ⇒ 过期判定可确定性测试（`expires_at = issuedAt + 35 日`）；
 * - 过期条目按**读取时判定**（`resolveRequestId` 过期即 `null`），并顺手物理删除（不留悬挂摘要）。
 */
export function createDeletionReceiptRegistry(input: { now?: () => Date } = {}): DeletionReceiptRegistry {
  const now = input.now ?? (() => new Date());
  const byHash = new Map<string, DeletionReceiptRecord>();
  const hashesByRequest = new Map<string, Set<string>>();

  function forgetRequest(requestId: string): number {
    const hashes = hashesByRequest.get(requestId);
    if (hashes === undefined) return 0;
    for (const hash of hashes) byHash.delete(hash);
    hashesByRequest.delete(requestId);
    return hashes.size;
  }

  return {
    issue(requestId) {
      if (typeof requestId !== 'string' || requestId.length === 0) {
        throw new Error('签发回执 bearer 需要非空删除请求 id');
      }
      // 同一删除请求只保留一个有效 bearer（重放 ⇒ 换发 ⇒ 旧 bearer 立即失效）。
      forgetRequest(requestId);
      const token = mintOpaqueToken();
      const tokenHash = hashToken(token);
      const issued = now();
      const expiresAt = new Date(issued.getTime() + RECEIPT_TTL_MS).toISOString();
      byHash.set(tokenHash, { tokenHash, requestId, issuedAt: issued.toISOString(), expiresAt });
      const hashes = hashesByRequest.get(requestId) ?? new Set<string>();
      hashes.add(tokenHash);
      hashesByRequest.set(requestId, hashes);
      return { token, expiresAt };
    },
    resolveRequestId(token) {
      if (typeof token !== 'string' || token.length === 0) return null;
      const record = byHash.get(hashToken(token));
      if (record === undefined) return null;
      if (new Date(record.expiresAt).getTime() <= now().getTime()) {
        // 到期即作废（不回放、不续期）：调用方按「凭据不可用」如实拒绝。
        byHash.delete(record.tokenHash);
        hashesByRequest.get(record.requestId)?.delete(record.tokenHash);
        return null;
      }
      return record.requestId;
    },
    forgetRequest,
    liveCount: () => byHash.size,
  };
}

/**
 * 注销申请服务（`POST /me/account/deletion` 的唯一实现）。
 *
 * `available === false` ⇒ 路由**不注册回退**：抛契约 `PROVIDER_UNAVAILABLE`（503，`retryable: true`）。
 */
export interface AccountDeletionRequestService {
  readonly available: boolean;
  readonly unavailableMessage: string | null;
  /** 已登记的必需模块（与 `packages/privacy` 注册表**同源**：直接读协调器，不另存一份）。 */
  declaredModules(): string[];
  /**
   * 受理：建删除请求（未绑定主体 ⇒ 处理器不会清理任何数据）、**驱动既有删除级联**
   * （对**每个已登记模块**都跑一次处理器）并签发回执 bearer。
   */
  request(input: { userId: string; receiptInput: string }): Promise<DeletionAcceptedProjection>;
}

/**
 * 建注销申请服务。
 *
 * ⛔ 本函数**不注册模块、不建注册表**：模块闭集与处理器来自 `input.deletion`
 * （`services/api/src/privacy/user-data-deletion.ts` 的装配结果）。
 *
 * ## 级联语义（为什么受理处就真的删，而不是只排队）
 * 契约的 202 description 是「受理异步任务，尚未完成」——**不是**「已删除」。本片没有作业队列
 * （`deletion-modules.mjs` 的完成判定是**状态协议**，不是 worker），若只建请求不驱动处理器，
 * 回执将**永远**停在 `pending`，而用户数据一个字节都没动 —— 那是比「如实 503」更坏的谎。
 * 因此本函数在受理处**同步驱动既有级联**，然后按**处理器真实写下的行**投影：
 *   - 在线阶段：`deleteAllByOwner` 成功 ⇒ `online_state: 'completed'`（既有装配只在成功后写行）；
 *   - 备份阶段：`backupPurge` 未接线 ⇒ `backup_state: 'pending'`（不谎称完成）；
 *   - 因此 `state` 只可能是 `requested`/`processing`/`blocked`，**绝不**是 `completed`。
 * 处理器按 `requestId` 反查主体（`subjectByRequest`），只清该主体的数据 ⇒ 不会跨主体误删。
 */
export function createAccountDeletionRequestService(input: {
  deletion: UserDataDeletionRegistry;
  receipts: DeletionReceiptRegistry;
  available?: boolean;
  unavailableMessage?: string;
}): AccountDeletionRequestService {
  const available = input.available ?? true;
  return {
    available,
    unavailableMessage: available ? null : (input.unavailableMessage ?? ACCOUNT_DELETION_UNAVAILABLE_MESSAGE),
    declaredModules: () => input.deletion.requiredModules(),
    async request({ userId, receiptInput }) {
      if (typeof userId !== 'string' || userId.length === 0) {
        throw new Error('注销申请需要非空主体');
      }
      if (typeof receiptInput !== 'string' || receiptInput.length === 0) {
        throw new Error('注销申请需要回执 bearer 明文');
      }
      // 主体绑定 + 全模块受理检查都在既有装配里（缺模块 ⇒ OBJECT_UNAVAILABLE，不假装能完成）。
      const request = input.deletion.requestDeletionFor(userId, { receiptInput });
      const requestId = String(request['id']);
      // 驱动**既有**删除级联：注册表里每个已登记模块都会被执行一次（不跳过任何模块）。
      await input.deletion.executeHandlers(requestId);
      const issued = input.receipts.issue(requestId);
      const deletion = projectReceipt(input.deletion.receipt(requestId));
      if (deletion === null) throw new Error('删除请求创建后回执缺失');
      return { receipt_token: issued.token, receipt_expires_at: issued.expiresAt, deletion };
    },
  };
}

/**
 * 把既有协议回执**严格归一**到契约 `DeletionReceipt`（**不重写**协议已有的任何判定）。
 *
 * - `id` / `state` / `revision` / `requested_at` / `online_due_at` / `backup_due_at` / `handlers[]`
 *   全部取自 `deletion-modules.mjs::receipt()`：`state` 来自协议的完成判定、行状态按**处理器
 *   真实写下的行**映射（未报告的必需模块 ⇒ `pending`）、错误码只透白名单内的安全码；
 * - 本函数只做**形状归一**（契约要求的字符串/整数/date-time 类型）与「非法枚举折叠为安全默认」，
 *   **不做**任何「部分覆盖说成全部完成」的抬升：`completed` 只可能来自协议完成判定。
 *
 * `null` 入参 ⇒ `null`（调用方据此 404 `NOT_FOUND`，绝不返回空壳 200）。
 */
export function projectReceipt(receipt: Record<string, unknown> | null): Record<string, unknown> | null {
  if (receipt === null) return null;
  const rawHandlers = Array.isArray(receipt['handlers']) ? receipt['handlers'] : [];
  const handlers = rawHandlers.map((row) => {
    const handler = (row ?? {}) as Record<string, unknown>;
    return {
      module: String(handler['module']),
      online_state: pickState(handler['online_state']),
      // 备份阶段未接线时既有装配如实给 `pending`（不谎称完成）；本文件不覆盖它。
      backup_state: pickState(handler['backup_state']),
      third_party_state: pickThirdParty(handler['third_party_state']),
      error_code: pickErrorCode(handler['error_code']),
    };
  });
  return {
    id: String(receipt['id']),
    state: normalizeState(receipt['state']),
    revision: normalizeRevision(receipt['revision']),
    requested_at: normalizeTime(receipt['requested_at'], 'requested_at'),
    online_due_at: normalizeTime(receipt['online_due_at'], 'online_due_at'),
    backup_due_at: normalizeTime(receipt['backup_due_at'], 'backup_due_at'),
    handlers,
  };
}

const DELETION_STATES = ['requested', 'processing', 'blocked', 'completed'] as const;
const HANDLER_STATES = ['pending', 'running', 'completed', 'blocked'] as const;
const THIRD_PARTY_STATES = ['not_requested', 'requested', 'confirmed', 'failed', 'unsupported'] as const;

function normalizeState(value: unknown): string {
  return typeof value === 'string' && (DELETION_STATES as readonly string[]).includes(value) ? value : 'processing';
}

function normalizeRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

/** 契约要求 date-time：不可解析时不编造时间戳（如实抛出 ⇒ 调用方 500，而不是回一个假期限）。 */
function normalizeTime(value: unknown, field: string): string {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
  throw new TypeError(`回执缺少可解析的 ${field}`);
}

/** 行状态：只接受契约 `HANDLER_STATES` 白名单，其余（含缺字段）一律 `pending`。 */
function pickState(value: unknown): string {
  return typeof value === 'string' && (HANDLER_STATES as readonly string[]).includes(value) ? value : 'pending';
}

function pickThirdParty(value: unknown): string | null {
  return typeof value === 'string' && (THIRD_PARTY_STATES as readonly string[]).includes(value) ? value : null;
}

/** 自由文本一律不透出：只允许协议白名单内的安全错误码（其余折叠为 `HANDLER_FAILED`）。 */
function pickErrorCode(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 80) return 'HANDLER_FAILED';
  return SAFE_ERROR_CODES.includes(value) ? value : 'HANDLER_FAILED';
}
