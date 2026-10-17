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
  /** GY-I27 第三片：契约外的**非媒体**资料维度（合成域已核对正文的朗读外发）。 */
  export const NON_MEDIA_DATA_TYPES: readonly string[];
  export const NON_MEDIA_REQUIRED_CONSENTS: Readonly<Record<string, readonly string[]>>;
  /** 已知资料类型（媒体维 ∪ 非媒体维）的必需用途集合；未知类型返回 null。 */
  export function requiredConsentsForDataType(dataType: string): readonly string[] | null;
  export function isKnownDataType(dataType: string): boolean;
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
