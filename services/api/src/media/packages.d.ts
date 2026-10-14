/**
 * GY-I06（#6）· `packages/media` 的只读类型声明。
 *
 * 用途：`services/api` 是 TypeScript（`strict` + `noUncheckedIndexedAccess`），而 GY-I06 的
 * `packages/media/**` 是纯 ESM `.mjs`。与 `services/api/src/community/moderation.d.ts`、
 * `services/api/src/privacy/reference.d.ts` 的做法一致，这里就地声明该模块的形状，
 * **不修改 `packages/media/**`**（只读导入），只在 `services/api` 侧复用其已合并的
 * 校验/嗅探/EXIF/时长/句柄原语。
 *
 * 声明依据（逐条对照 `packages/media` 的实际导出，不猜字段）：
 *   - `MediaError` / `toErrorEnvelope`：errors.mjs
 *   - `MEDIA_PURPOSES` / `MEDIA_STATES` / `MEDIA_MAX_BYTES` / `MEDIA_MAX_DURATION_MS` /
 *     `COMMUNITY_MAX_IMAGES_PER_POST` / `MEDIA_INITIATED_TTL_MS` / `MEDIA_ACCESS_TTL_MS` /
 *     `kindOf` / `allowedMimeFor` / `maxBytesFor` / `canTransition`：constants.mjs
 *   - `detectMediaType`：detect.mjs
 *   - `stripImageMetadata`：exif.mjs
 *   - `validateUploadInput` / `validateCompleteInput` / `assertBytesMatchDeclaration` /
 *     `sha256Hex`：validate.mjs
 *   - `createAccessTokenFactory` / `hashToken`：tokens.mjs
 *   - `newObjectRef`：store.mjs
 *
 * 若 `packages/media` 改变导出形状，`npm run lint`（tsc --noEmit）会失败 —— 这正是本声明的作用：
 * 让漂移在静态检查阶段暴露，而不是在运行期静默错判。
 */
declare module '*packages/media/index.mjs' {
  export class MediaError extends Error {
    constructor(
      code: string,
      message: string,
      options?: { retryable?: boolean; details?: Array<{ field: string; code: string }> },
    );
    readonly code: string;
    readonly retryable: boolean;
    readonly details: Array<{ field: string; code: string }>;
    readonly status: number;
  }

  export const MEDIA_PURPOSES: readonly string[];
  export const MEDIA_STATES: readonly string[];
  export const MEDIA_MAX_BYTES: number;
  export const MEDIA_MAX_DURATION_MS: number;
  export const COMMUNITY_MAX_IMAGES_PER_POST: number;
  export const MEDIA_INITIATED_TTL_MS: number;
  export const MEDIA_ACCESS_TTL_MS: number;

  export function kindOf(purpose: string): 'image' | 'audio';
  export function allowedMimeFor(purpose: string): readonly string[];
  export function maxBytesFor(purpose: string): number;
  export function canTransition(from: string, to: string): boolean;
  export function isMediaPurpose(value: unknown): boolean;
  export function isMediaState(value: unknown): boolean;

  export function detectMediaType(bytes: Uint8Array): { mime: string; container: string } | null;

  export function stripImageMetadata(
    bytes: Uint8Array,
    mime: string,
  ): { ok: boolean; data: Uint8Array; removed: string[] };

  export function sha256Hex(bytes: Uint8Array): string;

  export function validateUploadInput(
    input: unknown,
    context?: { mediaCountForPost?: number },
  ): { purpose: string; mime: string; bytes: number; duration_ms: number | null; sha256: string };

  export function validateCompleteInput(input: unknown): { sha256: string; bytes: number };

  export function assertBytesMatchDeclaration(args: {
    bytes: Uint8Array;
    declared: {
      mime: string;
      bytes: number;
      sha256: string;
      purpose: string;
      duration_ms?: number | null;
    };
  }): { mime: string; container: string; durationMs?: number };

  export function createAccessTokenFactory(secret: string): {
    issue(payload: Record<string, unknown>): string;
    verify(token: string): Record<string, unknown> | null;
    hash(token: string): string;
  };

  export function hashToken(token: string): string;
  export function newObjectRef(): string;
}
