/**
 * GY-I09 识别任务的媒体引用校验端口。
 *
 * `POST /recognitions` 的 body 是 `MediaJobInput{media_id, media_revision}`，因此服务端必须
 * 在受理前确认该私有媒体**属于调用者**且版本一致，否则不得创建任务。
 *
 * 现状（如实记录，见证据文档与 PR 正文）：
 * - `packages/media/**` 是纯模块，**媒体 HTTP 路由尚未接线**（该模块 README §“services/api 挂载示例”
 *   明确标注「媒体 HTTP 路由尚未接线」），且契约把上传句柄 URL 限定为 `^https://`，本地 loopback
 *   无法提供该 https 数据面，因此**本片不接线媒体 HTTP 路由**（属 GY-I06 的剩余接线工作，避免越界）。
 * - 后果：`real` 模式下没有可核验的真实媒体来源 → **fail-closed**（一律 `OBJECT_UNAVAILABLE`），
 *   绝不静默放过；`stub` / `preset_demo` 模式使用**明确标注的替身媒体引用**（合成，非真实上传）。
 */

export type MediaResolutionCode = 'NOT_FOUND' | 'REVISION_CONFLICT' | 'OBJECT_UNAVAILABLE';

export type MediaResolution = { ok: true; revision: number } | { ok: false; code: MediaResolutionCode };

export interface RecognitionMediaPort {
  /** 端口类型：substitute=替身（stub/preset_demo）、unwired=未接线（real，fail-closed）。 */
  readonly kind: 'substitute' | 'unwired';
  /** 供证据文档引用的说明（不含任何私有媒体引用）。 */
  readonly note: string;
  resolve(input: { ownerUserId: string; mediaId: string; mediaRevision: number }): Promise<MediaResolution>;
}

const SUBSTITUTE_NOTE =
  '替身媒体引用端口（stub/preset_demo）：任意合法 uuid 媒体引用视为调用者名下、已就绪、版本一致；不上传、不读取真实照片。';

/**
 * 替身媒体端口：**明确标注的替身**，仅用于 stub/preset_demo 下离线联调识别链路。
 * 它不接收真实照片字节，也不把任何真实对象声明为已就绪。
 */
export function createSubstituteMediaPort(): RecognitionMediaPort {
  return {
    kind: 'substitute',
    note: SUBSTITUTE_NOTE,
    async resolve({ mediaRevision }) {
      // 形状已由服务层校验（uuid + 正整数）；此处只做版本一致性判定。
      if (!Number.isInteger(mediaRevision) || mediaRevision < 1) {
        return { ok: false, code: 'REVISION_CONFLICT' };
      }
      return { ok: true, revision: mediaRevision };
    },
  };
}

/**
 * 未接线端口：媒体 HTTP 层缺席时使用（real 模式）。一律 `OBJECT_UNAVAILABLE`，
 * 不泄露媒体是否存在，也不以「本地兜底」方式放行。
 */
export function createUnwiredMediaPort(reason = '媒体 HTTP 路由已注册，但未接真实对象存储：无法读取私有媒体字节'): RecognitionMediaPort {
  return {
    kind: 'unwired',
    note: `${reason}（fail-closed）`,
    async resolve() {
      return { ok: false, code: 'OBJECT_UNAVAILABLE' };
    },
  };
}

/** 按执行模式选择媒体端口：只有替身模式才允许替身引用。 */
export function createRecognitionMediaPort(executionMode: string): RecognitionMediaPort {
  return executionMode === 'real' ? createUnwiredMediaPort() : createSubstituteMediaPort();
}
