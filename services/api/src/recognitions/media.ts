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
 * - **GY-R70 起**本文件这套**按域**媒体引用端口的 `real` 分支已接上媒体域**既有**的两个端口
 *   （`mediaStore` + `mediaObjectStore`，见 `createObjectStoreRecognitionMediaPort`）：按 `media_id` +
 *   `revision` 读登记册（归属/版本/状态/用途/衍生件键）→ 只从对象存储取**去元数据衍生件**
 *   （`derivativeRef`，⛔ 不读含 EXIF/GPS 的 `rawRef`）→ 校验对象 `Content-Type`。
 *   做法与 `services/api/src/ai/ocr-image-source.ts`（#766）同形，且**复用同一份实现**
 *   （`recognitions/image-source.ts` 的 `createObjectStoreRecognitionImageSource`）以避免两处口径漂移。
 *
 *   失败序（受理路径上的**唯一**顺序，改前改后逐条可复核）：
 *   ① 域级供应商闸门（`createRecognition` 里 `provider.available`）先于 `media.resolve`
 *      ⇒ `real` 缺凭据：503 `PROVIDER_UNAVAILABLE`（不排队、不回退替身）；
 *   ② 凭据齐备后才轮到本端口 ⇒ 端口未接线 / 登记册缺行 / 版本不符 / 未就绪 / 跨用途 / 无衍生件 /
 *      对象缺失 / 类型不受支持：409 `OBJECT_UNAVAILABLE`（**这也是「有凭据、无字节端口」的实测读数**）；
 *   ③ 两者齐备（凭据 + 可取的衍生件字节）才可能真正发包（发包在 `recognitions/live-adapter.ts`）。
 *
 *   ⚠ 与接线前**唯一**可观测差异：`real` 且**未给端口取值器**时仍恒为 `createUnwiredMediaPort()`
 *   （`kind: 'unwired'`，行为与接线前逐字相同）；给了取值器则 `kind: 'wired'`，端口会真的去读
 *   登记册与对象存储 —— 默认装配在 `real` 下拿到的是媒体域的**未接线**对象存储，因此结局仍是
 *   409 `OBJECT_UNAVAILABLE`（`describe().mediaPort` / `mediaNote` 随之如实变为 `wired` 与新文案）。
 *   `stub` / `preset_demo` 模式仍使用**明确标注的替身媒体引用**（合成，非真实上传）。
 */

import {
  createObjectStoreRecognitionImageSource,
  type RecognitionImagePortsResolver,
} from './image-source.ts';

export type MediaResolutionCode = 'NOT_FOUND' | 'REVISION_CONFLICT' | 'OBJECT_UNAVAILABLE';

export type MediaResolution = { ok: true; revision: number } | { ok: false; code: MediaResolutionCode };

export interface RecognitionMediaPort {
  /** 端口类型：substitute=替身（stub/preset_demo）、unwired=未接线（real，未给端口取值器）、wired=已接媒体域端口。 */
  readonly kind: 'substitute' | 'unwired' | 'wired';
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
export function createRecognitionMediaPort(
  executionMode: string,
  resolvePorts?: RecognitionImagePortsResolver,
): RecognitionMediaPort {
  if (executionMode !== 'real') return createSubstituteMediaPort();
  // 未给端口取值器（既有调用形态 `createRecognitionMediaPort(config.executionMode)`）⇒ 与接线前逐字相同。
  if (resolvePorts === undefined) return createUnwiredMediaPort();
  return createObjectStoreRecognitionMediaPort(resolvePorts);
}

/**
 * 已接线的媒体引用端口（`real` 的产品实现）：**复用**字节来源
 * （`recognitions/image-source.ts` 的 `createObjectStoreRecognitionImageSource`）做全部判定，
 * 因此「受理前校验」与「适配器取字节」看的是**同一行登记册、同一个衍生件对象、同一套拒绝理由**，
 * 不存在两份会各自漂移的口径。
 *
 * 三个契约码（本文件既有闭集）由字节来源的四个内部码**收敛**而来：
 * `NOT_FOUND` → `NOT_FOUND`；`REVISION_CONFLICT` → `REVISION_CONFLICT`；
 * `OBJECT_UNAVAILABLE` / `PROVIDER_UNAVAILABLE` → `OBJECT_UNAVAILABLE`（不泄露是「端口未接线」还是
 * 「对象不存在」——受理面对客户端只需一个如实拒绝）。
 *
 * ⚠ 成本如实登记：受理时这一次读会真的取一遍衍生件字节（用来确认「有凭据、也真有字节」才受理），
 * 执行时适配器**再读一次**。刻意**不**缓存：把图片字节留在进程内是一个新的数据留存面，
 * 而本域的字节本来就只该在发包那一刻存在。
 */
export function createObjectStoreRecognitionMediaPort(
  resolvePorts: RecognitionImagePortsResolver,
): RecognitionMediaPort {
  const source = createObjectStoreRecognitionImageSource(resolvePorts);
  return {
    kind: 'wired',
    note:
      '真实识别媒体引用：按 media_id+revision 读媒体域登记册（归属/版本/状态/用途/衍生件键）→ 只从对象存储'
      + '取**去元数据衍生件**并校验 Content-Type；不读含 EXIF/GPS 的原件、不读 ambient env、不伪造字节'
      + '（任一环节不成立即 OBJECT_UNAVAILABLE，绝不静默放行）',
    async resolve({ ownerUserId, mediaId, mediaRevision }) {
      const bytes = await source.read({ mediaId, mediaRevision, ownerUserId });
      if (bytes !== null) return { ok: true, revision: mediaRevision };
      const failure = source.lastFailure();
      if (failure === 'NOT_FOUND') return { ok: false, code: 'NOT_FOUND' };
      if (failure === 'REVISION_CONFLICT') return { ok: false, code: 'REVISION_CONFLICT' };
      return { ok: false, code: 'OBJECT_UNAVAILABLE' };
    },
  };
}
