/**
 * GY-I09 识别任务的媒体引用校验端口。
 *
 * `POST /recognitions` 的 body 是 `MediaJobInput{media_id, media_revision}`，因此服务端必须
 * 在受理前确认该私有媒体**属于调用者**且版本一致，否则不得创建任务。
 *
 * 现状（如实记录，见证据文档与 PR 正文）：
 * - 媒体 **HTTP 路由已注册、可调用**（`services/api/src/routes/media.ts` 的 `registerMediaRoutes`，
 *   装配点 `services/api/src/app.ts` 的 `buildApp`；7 条 operation 逐个对齐契约）。原稿曾据
 *   `packages/media/README.md` §「services/api 挂载示例」称「媒体 HTTP 路由尚未接线」——该 README
 *   **现已改为**「媒体 HTTP 路由已接线；**未接线的是句柄消费网关**」：仍未接线的是**真实对象存储适配**
 *   （`services/api/src/media/object-store.ts` 的 `createUnwiredObjectStore`；真实开启需 `app.ts` 的
 *   `mediaObjectStore` ＋ `approveRealMediaWiring()` 显式批准）与**句柄消费网关**（部署期数据面；契约内
 *   没有返回 owner 私有媒体字节的 operation）⇒ `real` 下媒体域 7 条路由整域 503 `PROVIDER_UNAVAILABLE`
 *   （fail-closed）。
 * - 本文件这套**按域**媒体引用端口并未改接媒体域：`real` 下仍由 `createUnwiredMediaPort` 承担
 *   ⇒ `POST /recognitions` 在受理前一律如实 `OBJECT_UNAVAILABLE`(409)，绝不静默放过；
 *   `stub` / `preset_demo` 模式使用**明确标注的替身媒体引用**（合成，非真实上传）。
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
 * 未接线端口：本域**未接真实对象存储**时使用（real 模式）。一律 `OBJECT_UNAVAILABLE`，
 * 不泄露媒体是否存在，也不以「本地兜底」方式放行。
 * ⚠ 默认 `reason` 文案含「媒体 HTTP 层尚未接线」，属**运行期字符串**（会进 `note`），
 * 本片按零行为改动**原样保留**；媒体 HTTP 路由其实已注册，见文件头与交接未取得项。
 */
export function createUnwiredMediaPort(reason = '媒体 HTTP 层尚未接线，无法核验私有媒体'): RecognitionMediaPort {
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
