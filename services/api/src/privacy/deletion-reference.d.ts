/**
 * `packages/privacy/deletion.mjs`（GY-I27 已合并的**注销删除模块注册协议**）的类型声明。
 *
 * 与 `services/api/src/privacy/reference.d.ts`、`egress-reference.d.ts` 同一做法：
 * 只声明**形状**，运行期以 `.mjs` 为准；**不复制实现、不修改该 `.mjs`**。
 *
 * 本文件是**新增**文件（不改动他人已有的两个 `.d.ts`），因为 GY-I16 需要把收藏／历史两个模块
 * 注册到同一份已合并协议上（issue #16 第 4 项：「复用已合并的 packages/privacy 删除注册协议，
 * 不另起一套」）。
 */

declare module '*packages/privacy/deletion.mjs' {
  /** 处理器可写入的固定安全错误码白名单（自由文本会被该模块折叠）。 */
  export const SAFE_ERROR_CODES: readonly string[];

  /** handler 返回形状：`onlineState`/`backupState` 必须属 `pending|running|completed|blocked`。 */
  export type DeletionHandlerResult = {
    onlineState: string;
    backupState: string;
    evidenceRef?: string;
    errorCode?: string | null;
  };

  /** 注册表形状（`type` 别名而非 `interface`，便于按 `Record<string, unknown>` 传给协调器）。 */
  export type DeletionRegistry = {
    registerModule(module: string, handler: (input: { requestId: string; module: string }) => Promise<DeletionHandlerResult>): string;
    createDeletionRequest(input?: { generation?: number; receiptInput?: string | null }): Record<string, unknown>;
    getRequest(requestId: string): Record<string, unknown> | null;
    executeHandlers(requestId: string): Promise<Record<string, unknown>>;
    completionStatus(requestId: string): { state: string; completed: boolean };
    receiptProjection(requestId: string): Record<string, unknown> | null;
    requestThirdPartyDeletion(input: Record<string, unknown>): Record<string, unknown>;
    confirmThirdPartyDeletion(input: Record<string, unknown>): Record<string, unknown>;
    failThirdPartyDeletion(input: Record<string, unknown>): Record<string, unknown>;
    markUnsupported(input: Record<string, unknown>): Record<string, unknown>;
    readonly _handlers: Map<string, unknown>;
    readonly _requests: Map<string, Record<string, unknown>>;
    readonly _handlerRows: Array<Record<string, unknown>>;
    readonly _thirdPartyRows: Array<Record<string, unknown>>;
  };

  export function createDeletionRegistry(deps?: { now?: () => Date }): DeletionRegistry;
}
