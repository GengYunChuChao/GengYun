/**
 * `packages/privacy/**` 基础模块（错误/常量/脱敏）的类型声明。
 *
 * 与 `reference.d.ts` / `egress-reference.d.ts` 同一做法：声明**只描述形状**，
 * 运行期以 `.mjs` 为准（不复制实现、不修改任何 `.mjs`）。
 */

declare module '*packages/privacy/errors.mjs' {
  export interface PrivacyFieldError {
    field: string;
    code: string;
  }
  export class PrivacyError extends Error {
    constructor(code: string, message: string, options?: { retryable?: boolean; details?: PrivacyFieldError[] });
    readonly code: string;
    readonly retryable: boolean;
    readonly details: PrivacyFieldError[];
    readonly status: number;
  }
  export function toErrorEnvelope(
    error: unknown,
    meta?: { request_id?: string; execution_mode?: string },
  ): unknown;
}

declare module '*packages/privacy/constants.mjs' {
  export const CONTRACT_VERSION: string;
  export const CONSENT_PURPOSES: readonly string[];
  export const MEDIA_PURPOSES: readonly string[];
  export const CONSENT_STATES: readonly string[];
  export const EXPORT_STATES: readonly string[];
  export const THIRD_PARTY_STATES: readonly string[];
  export const DELETION_STATES: readonly string[];
  export const HANDLER_STATES: readonly string[];
  export const ACCOUNT_STATES: readonly string[];
  export const MEDIA_PURPOSE_REQUIRED_CONSENTS: Readonly<Record<string, readonly string[]>>;
  export const ERROR_STATUS_MAP: Readonly<Record<number, readonly string[]>>;
  export function isErrorCode(value: string): boolean;
  export function statusForErrorCode(code: string): number;
}

declare module '*packages/privacy/redact.mjs' {
  export function redactForLog(value: unknown, options?: { depth?: number }): unknown;
  export function assertNoSensitiveLeak(
    value: unknown,
    forbiddenFragments: readonly string[],
  ): { ok: boolean; leaked?: string };
}
