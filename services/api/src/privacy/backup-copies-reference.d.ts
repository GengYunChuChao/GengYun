// GY-I19（#19）· 备份副本域：`packages/privacy/*.mjs` 是纯 JS（仓内既有约定：不生成 .d.ts，
// 由 TS 侧的 `*.d.ts` 声明文件给出运行时形状）。本文件只声明本片 TS 侧真正用到的导出，
// ⛔ 不新增运行时实现，也不把 JS 的类型整体搬进来。
declare module '*packages/privacy/backup-copies.mjs' {
  /** 清单行的产出者标识（`lineage` 列的唯一取值）。 */
  export const BACKUP_COPY_LINEAGE: string;
  /** 删除模块 → 副本范围名的闭集镜像。 */
  export const BACKUP_COPY_SCOPES: Readonly<Record<string, string>>;
  export const BACKUP_COPY_SHAPE: RegExp;
  export const BACKUP_COPY_DIGEST_SHAPE: RegExp;
  /** 证据摘要的域分隔版本串（设计 §7.2）。 */
  export const BACKUP_PURGE_EVIDENCE_VERSION: string;
  export function scopeForBackupModule(module: string): string;
  export function assertBackupCopyModule(module: string): string;
  export function assertBackupCopyScope(scope: string): string;
  export function normalizeObjectRefs(input: {
    objectRefs: readonly string[];
    records: number;
  }): { objectRefs: string[]; records: number };
  export function copyPayloadJson(input: { objectRefs: readonly string[]; records: number }): string;
  export function copyPayloadDigest(payloadJson: string): string;
  export function purgeEvidenceRef(input: {
    requestId: string;
    module: string;
    payloadDigests: readonly string[];
  }): string;
}

declare module '*packages/privacy/backup-retention.mjs' {
  export const BACKUP_RETENTION_DAYS: number;
  export const BACKUP_RETENTION_MS: number;
  export const BACKUP_COPY_STATES: readonly string[];
  export const BACKUP_PURGE_ACTIONS: readonly string[];
  export const BACKUP_PURGE_REASONS: {
    readonly PURGE_DUE: 'BACKUP_PURGE_DUE';
    readonly WAITING_RETENTION: 'BACKUP_WAITING_RETENTION';
    readonly NO_COPIES: 'BACKUP_NO_COPIES';
    readonly ALL_PURGED: 'BACKUP_ALL_PURGED';
    readonly COPY_FAILED: 'BACKUP_COPY_FAILED';
    readonly INPUT_INVALID: 'BACKUP_INPUT_INVALID';
  };
  export function evaluateBackupPurge(input?: {
    now?: Date | number | string;
    copies?: readonly { state: string; retentionUntil: Date | number | string }[];
  }): {
    action: string;
    dueCopies: readonly { state: string; retentionUntil: Date | number | string }[];
    reason: string;
  };
  export function backupRetentionUntil(requestedAt: Date | number | string): string;
  export function onlineRetentionUntil(requestedAt: Date | number | string): string;
  export function retentionDeadlines(requestedAt: Date | number | string): Record<string, string>;
}
