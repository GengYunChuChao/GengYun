/**
 * `packages/privacy/**` 新模块（GY-I27 本轮：外发消费者 / 在途守卫 / 全模块删除协议）的
 * 类型声明。包内是纯 ESM `.mjs`，与 `reference.d.ts` 同一做法：声明**只描述形状**，
 * 运行期以 `.mjs` 为准（不复制实现、不修改任何 `.mjs`）。
 */

declare module '*packages/privacy/egress.mjs' {
  export const EGRESS_MODES: readonly ['real', 'stub', 'preset_demo'];
  export const STUB_EGRESS_LABEL: string;
  export const PRESET_DEMO_EGRESS_LABEL: string;
  export const REAL_EGRESS_UNWIRED_NOTE: string;
  export const REAL_EGRESS_APPROVAL_REQUIRED: string;

  export interface EgressTransport {
    readonly kind: 'real' | 'stub' | 'preset_demo';
    readonly stub: boolean;
    readonly available: boolean;
    readonly label: string;
    readonly note: string | null;
    readonly unavailableReason: string | null;
    send(entry: Record<string, unknown>): Promise<{ transportRef?: string; note?: string }>;
  }

  export interface EgressConsumer {
    readonly executionMode: 'real' | 'stub' | 'preset_demo';
    readonly transportKind: string;
    readonly available: boolean;
    readonly label: string;
    readonly note: string | null;
    readonly unavailableReason: string | null;
    reserve(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    send(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    dispatch(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    audit(): Array<Record<string, unknown>>;
  }

  export function createStubEgressTransport(options: { executionMode?: 'stub' | 'preset_demo' }): EgressTransport;
  export function createRealEgressTransport(options?: { adapter?: { send(entry: Record<string, unknown>): Promise<unknown> } | null }): EgressTransport;
  export function resolveEgressTransport(options: {
    executionMode: 'real' | 'stub' | 'preset_demo';
    realTransport?: EgressTransport | null;
    realTransportApproved?: boolean;
  }): EgressTransport;
  export function createEgressConsumer(deps: {
    ledger: Record<string, unknown>;
    transport: EgressTransport;
    executionMode: 'real' | 'stub' | 'preset_demo';
    logSink?: ((entry: Record<string, unknown>) => void) | null;
    now?: () => Date;
  }): EgressConsumer;
  export function toContractExport(record: unknown): Record<string, unknown>;
  export function listExportsForUser(
    ledger: Record<string, unknown>,
    input: { userId: string; limit?: number; cursor?: string | null },
  ): { items: Array<Record<string, unknown>>; next_cursor: string | null };
}

declare module '*packages/privacy/in-flight.mjs' {
  export interface InFlightGuard {
    assertExecutable(input: { exportId: string; userId: string }): Promise<{ exportId: string; purposes: string[] }>;
    assertSavable(input: { exportId: string; userId: string; objectVersion: number }): Promise<{ exportId: string; objectVersion: number }>;
    cancelVersion(input: {
      exportId: string;
      userId: string;
      objectVersion: number;
      reason?: string;
    }): { exportId: string; objectVersion: number; cancelled: boolean; alreadyCancelled: boolean; revokedInFlight: number };
    isVersionCancelled(input: { exportId: string; objectVersion: number }): boolean;
    saveResult(input: {
      exportId: string;
      userId: string;
      objectVersion: number;
      result?: unknown;
    }): Promise<{ written: boolean; exportId: string; objectVersion: number }>;
    cancelledVersionsOf(exportId: string): number[];
    cancelledVersionCount(): number;
    audit(): Array<Record<string, unknown>>;
  }

  export interface EgressRevoker {
    onConsentWithdrawn(input: { userId: string; purpose: string }): { revokedInFlight: number };
    onAccountSuspendedOrDeleted(input: { userId: string }): { revokedInFlight: number };
    audit(): Array<Record<string, unknown>>;
  }

  export function createInFlightGuard(deps: {
    ledger: Record<string, unknown>;
    account: { stateOf(userId: string): Promise<string>; authEpochOf(userId: string): Promise<number> };
    consentStore: { isGranted(input: Record<string, unknown>): Promise<boolean>; currentEpoch(input: Record<string, unknown>): Promise<number> };
    now?: () => Date;
  }): InFlightGuard;

  export function createEgressRevoker(deps: { ledger: Record<string, unknown>; now?: () => Date }): EgressRevoker;
}

declare module '*packages/privacy/deletion-modules.mjs' {
  export const DELETION_MODULE_LIMIT: number;
  export interface DeletionCoordinator {
    requiredModules(): string[];
    declareRequiredModules(modules: string[]): string[];
    registerModule(module: string, handler: (input: Record<string, unknown>) => Promise<Record<string, unknown>>): string;
    registeredModules(): string[];
    missingRegistrations(): string[];
    missingModules(requestId: string): string[];
    createDeletionRequest(input?: { generation?: number; receiptInput?: string | null }): Record<string, unknown>;
    executeHandlers(requestId: string): Promise<Record<string, unknown>>;
    completionStatus(requestId: string): { state: string; completed: boolean; missingModules: readonly string[] };
    receipt(requestId: string): Record<string, unknown> | null;
    thirdPartyStatuses(requestId: string): Array<Record<string, unknown>>;
  }
  export function createDeletionCoordinator(deps: {
    registry: Record<string, unknown>;
    requiredModules: string[];
    now?: () => Date;
  }): DeletionCoordinator;
}
