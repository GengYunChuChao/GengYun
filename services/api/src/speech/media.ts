/**
 * GY-I11 录音转写任务的媒体引用校验端口。
 *
 * `POST /speech/transcriptions` 的 body 是 `MediaJobInput{media_id, media_revision}`，因此服务端
 * 必须在受理前确认该私有媒体（**普通话录音**）属于调用者且版本一致，否则不得创建任务。
 *
 * 现状（如实记录，见汇报与 PR 正文）：
 * - 媒体 **HTTP 路由已注册、可调用**（`services/api/src` 下 `routes` 目录的 `media.ts`，导出
 *   `registerMediaRoutes`；装配点 `services/api/src/app.ts` 的 `buildApp`；7 条 operation 逐个对齐契约）；
 *   **未接线的是真实对象存储适配与句柄消费网关**（`services/api/src/media/object-store.ts` 的
 *   `createUnwiredObjectStore`；真实开启需 `app.ts` 的 `mediaObjectStore` ＋
 *   `approveRealMediaWiring()` 显式批准，装配路径不自行铸造、不从 env 派生）
 *   ⇒ `real` 模式下媒体域 7 条路由整域 503 `PROVIDER_UNAVAILABLE`（fail-closed）。
 * - 本文件这套**按域**媒体引用端口并未改接媒体域：`real` 下仍由 `createUnwiredMediaPort` 承担。
 *   该端口只在受理函数的**媒体校验步骤**（`createTranscription` 里的 `media.resolve`）被触达，而它前面还有
 *   域级供应商闸门（同一函数里 `provider.available` 的判定先于 `media.resolve`）：`real` 缺真实 ASR 供应商
 *   凭据时（产品装配只传 `executionMode`，不传 endpoint/apiKey），先返回 503 `PROVIDER_UNAVAILABLE`；
 *   只有该域供应商判定**可用**时（显式注入已接线 provider —— 转写装配不读供应商 env），才轮到本端口
 *   ⇒ 409 `OBJECT_UNAVAILABLE`（如实拒绝）。
 *   `stub` / `preset_demo` 模式使用**明确标注的替身媒体引用**（合成，非真实上传、不读取任何录音字节）。
 * - 替身端口**不校验归属**（没有媒体存储可供查询），因此它只在 `stub` / `preset_demo` 下接线，
 *   绝不用于生产判定；生产路径一律走未接线端口。
 *
 * 与 GY-I10 的媒体端口同形（同一契约输入、同一 fail-closed 口径）；本片不 import
 * `services/api/src/recognitions/**` 与 `services/api/src/ocr/**`，以免在 #9 / #10 合并前
 * 耦合到未冻结的模块。
 */

export type MediaResolutionCode = 'NOT_FOUND' | 'REVISION_CONFLICT' | 'OBJECT_UNAVAILABLE';

export type MediaResolution = { ok: true; revision: number } | { ok: false; code: MediaResolutionCode };

export interface SpeechMediaPort {
  /** 端口类型：substitute=替身（stub/preset_demo）、unwired=未接线（real，fail-closed）。 */
  readonly kind: 'substitute' | 'unwired';
  /** 供证据文档引用的说明（不含任何私有媒体引用）。 */
  readonly note: string;
  resolve(input: { ownerUserId: string; mediaId: string; mediaRevision: number }): Promise<MediaResolution>;
}

const SUBSTITUTE_NOTE =
  '替身录音引用端口（stub/preset_demo）：任意合法 uuid 媒体引用视为调用者名下、已就绪、版本一致；不上传、不读取真实录音，也不校验归属。';

/**
 * 替身媒体端口：**明确标注的替身**，仅用于 stub/preset_demo 下离线联调转写链路。
 * 它不接收真实录音字节，也不把任何真实对象声明为已就绪。
 */
export function createSubstituteMediaPort(): SpeechMediaPort {
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
export function createUnwiredMediaPort(reason = '媒体 HTTP 路由已注册，但未接真实对象存储：无法读取私有录音字节'): SpeechMediaPort {
  return {
    kind: 'unwired',
    note: `${reason}（fail-closed）`,
    async resolve() {
      return { ok: false, code: 'OBJECT_UNAVAILABLE' };
    },
  };
}

/** 按执行模式选择媒体端口：只有替身模式才允许替身引用。 */
export function createSpeechMediaPort(executionMode: string): SpeechMediaPort {
  return executionMode === 'real' ? createUnwiredMediaPort() : createSubstituteMediaPort();
}
