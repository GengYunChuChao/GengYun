/**
 * GY-I10 标签 OCR 任务的媒体引用校验端口。
 *
 * `POST /ocr` 的 body 是 `MediaJobInput{media_id, media_revision}`，因此服务端必须在受理前
 * 确认该私有媒体**属于调用者**且版本一致，否则不得创建任务。
 *
 * ## 三种端口（`kind` 即身份，与 `services/api/src/speech/media.ts` 同形）
 *
 * | kind | 何时使用 | 行为 |
 * | --- | --- | --- |
 * | `substitute` | `stub` / `preset_demo` | 替身：任意合法 uuid 视为调用者名下、已就绪、版本一致；不上传、不读字节 |
 * | `real` | `real` **且**媒体域两个端口齐备、对象存储是真实适配器 | 读登记册（归属/版本/状态/用途/衍生件键）→ 取字节 → 校验 Content-Type |
 * | `unwired` | 其余一切情形 | 一律 `OBJECT_UNAVAILABLE`（409），fail-closed，不泄露媒体是否存在 |
 *
 * ## 失败序（`real` 装配的实测顺序，不得含糊）
 *
 * ① 域级供应商闸门（`ocr/service.ts` 里 `provider.available`）**先于**本端口：`real` 缺真实 OCR 凭据
 * ⇒ 503 `PROVIDER_UNAVAILABLE`；② 凭据齐备才轮到本端口（`media.resolve`）⇒ 不成立即 404/409；
 * ③ 全部成立才 202。实测读数见 `docs/verification/gy-r70-ocr-media-port-20261030.md`。
 *
 * 端口身份由**注入者**决定（`kind` 是身份，不是布尔自述标志）：本文件不接受「自述已接线」的开关。
 *
 * ⛔ 不 import `services/api/src/recognitions/**`；本文件不读 ambient env、不碰文件系统、不新造错误码。
 */

export type MediaResolutionCode = 'NOT_FOUND' | 'REVISION_CONFLICT' | 'OBJECT_UNAVAILABLE';

export type MediaResolution = { ok: true; revision: number } | { ok: false; code: MediaResolutionCode };

export interface OcrMediaPort {
  /** 端口类型：substitute=替身（stub/preset_demo）、real=真实登记册校验、unwired=未接线（fail-closed）。 */
  readonly kind: 'substitute' | 'real' | 'unwired';
  /** 供证据文档引用的说明（不含任何私有媒体引用）。 */
  readonly note: string;
  resolve(input: { ownerUserId: string; mediaId: string; mediaRevision: number }): Promise<MediaResolution>;
}

const SUBSTITUTE_NOTE =
  '替身媒体引用端口（stub/preset_demo）：任意合法 uuid 媒体引用视为调用者名下、已就绪、版本一致；不上传、不读取真实照片。';

/**
 * 替身媒体端口：**明确标注的替身**，仅用于 stub/preset_demo 下离线联调标签 OCR 链路。
 * 它不接收真实照片字节，也不把任何真实对象声明为已就绪。
 */
export function createSubstituteMediaPort(): OcrMediaPort {
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
export function createUnwiredMediaPort(reason = '媒体 HTTP 路由已注册，但未接真实对象存储：无法读取私有媒体字节'): OcrMediaPort {
  return {
    kind: 'unwired',
    note: `${reason}（fail-closed）`,
    async resolve() {
      return { ok: false, code: 'OBJECT_UNAVAILABLE' };
    },
  };
}

/** 按执行模式选择媒体端口：只有替身模式才允许替身引用（`wiring` 缺省 = 一个端口都没配 ⇒ 未接线）。 */
export function createOcrMediaPort(executionMode: string, wiring?: OcrMediaPortWiring): OcrMediaPort {
  return executionMode === 'real' ? createRealOrUnwiredPort(wiring) : createSubstituteMediaPort();
}

// ============================================================================
// GY-R70 · 受理前媒体门（`POST /ocr` 的 `media.resolve`）的**真实端口**
// ============================================================================
// 为什么需要这一段：在本片之前，`real` 分支恒为 `createUnwiredMediaPort()`（见上面 `createOcrMediaPort`
// 的旧形态），于是真实凭据齐备时 `POST /ocr` 也必然在媒体门被拒 ⇒ 受理永远做不到 202。
// 本段补上的就是那一格：**同一个契约输入、同一个三码闭集**，只是把「这条媒体引用能不能建任务」
// 从「服务端不知道」升级成「按媒体域既有事实回答」。
//
// 与 `ai/ocr-image-source.ts`（识别期取字节，GY-R69）的**分工**（刻意不合并成一处）：
//   * 本端口回答「**能不能受理**」：归属 / 版本 / 就绪 / 用途 / 衍生件键 / 对象可取 / 类型可吃；
//   * 字节来源回答「**发什么给供应商**」：只出 `derivativeRef` 的字节，且失败码只作诊断。
//   两处判据同源（下面 `OCR_IMAGE_CONTENT_TYPES` / `OCR_IMAGE_PURPOSES` 直接 import，不复制常量），
//   因此「受理判通过、取字节却拒绝」这种错位只可能来自**事实在两次读取之间变了**，不会是口径漂移。
//
// ⛔ 不取 `rawRef` 字节：原件含 EXIF/GPS。「原始对象不出网」是媒体域已写死的口径（`media/service.ts`），
//    因此缺去元数据衍生件 ⇒ 明确拒绝（不是「试着发原件」）。
// ⛔ 写入面一律不碰：本端口只读，不 `putObject`、不改登记册。
// ⛔ 不新造错误码：`MediaResolutionCode` 仍是 `NOT_FOUND` / `REVISION_CONFLICT` / `OBJECT_UNAVAILABLE`
//    三码闭集；对象存储端口抛出的**其它**码（例如未接线端口的 `PROVIDER_UNAVAILABLE`）按
//    「对象取不到」折算成 `OBJECT_UNAVAILABLE` —— 该闭集是契约面码，不能因为诊断需要被扩容。

/** 媒体登记册的**只读取值面**（结构上即 `media/store.ts` 的 `MediaStore.getMedia`，也满足 `ai/ocr-image-source.ts` 的 `OcrImageRegistry`）。 */
export interface OcrMediaRecordView {
  readonly ownerId: string;
  readonly revision: number;
  readonly state: string;
  readonly purpose: string;
  /** 去元数据衍生件：本端口取字节的**唯一**对象键（原件不出网）。 */
  readonly derivativeRef: string | null;
}

/** 媒体登记册端口（归属、版本、状态、用途的唯一事实源）。 */
export interface OcrMediaRegistry {
  getMedia(mediaId: string): Promise<OcrMediaRecordView | null>;
}

/**
 * 对象存储端口的**只读取值面**（结构上即 `media/object-store.ts` 的 `MediaObjectStore`）。
 *
 * `kind` 刻意声明为 `string`：本端口**按 kind 判身份**（必须 `s3_compatible`），见 `ocrMediaRealRefusal`。
 */
export interface OcrMediaObjectStore {
  readonly kind: string;
  getObject(key: string): Promise<{ readonly bytes: Uint8Array; readonly contentType: string } | null>;
}

/**
 * `real` 分支的接线输入：**媒体域既有的两个端口**，全部可缺（缺即 fail-closed）。
 *
 * 产品装配里这两个值就是 `app.ts` 已经建好的 `mediaObjectStore` 与 `mediaStore`
 * （经 `OcrRouteDeps['mediaWiring']` 转发，与 `imageMedia` 同形、同一对来源）。
 * ⛔ 本文件不新建对象存储、不读新环境变量、不改 `config.ts` 必填清单、不铸造批准能力。
 */
export interface OcrMediaPortWiring {
  /** 媒体域的对象存储端口（`media/object-store.ts` 的 `MediaObjectStore`）。 */
  readonly objectStore?: OcrMediaObjectStore | null;
  /** 媒体登记册（`media/store.ts` 的 `MediaStore`）。 */
  readonly mediaRecords?: OcrMediaRegistry | null;
}

/** `real` 分支的拒绝原因（闭集；只进 `note` 与诊断，不新造对外错误码）。 */
export const OCR_MEDIA_REAL_REFUSALS = [
  /** 对象存储端口缺失，或不是 S3 兼容真实适配器（替身/未接线端口不得冒充）。 */
  'object_store_not_wired',
  /** 缺媒体登记册：归属与版本无处可查。 */
  'media_registry_not_configured',
] as const;

export type OcrMediaRealRefusal = (typeof OCR_MEDIA_REAL_REFUSALS)[number];

/**
 * 拒绝原因 → `unwired` 端口的 `reason`；`null` 表示**用 `createUnwiredMediaPort()` 的默认文案**。
 *
 * 为什么 `object_store_not_wired` 必须是 `null`：默认 `real` 装配（零注入）下对象存储就是 `unwired`
 * 端口 ⇒ 命中这一条 ⇒ 运行期 `note` 与本片之前**逐字相同**
 * （`tests/unit/runtime-strings-truth.test.mjs` 逐字钉住，`tests/integration/ocr-http.mjs` 钉 `mediaPort`）。
 */
const REFUSAL_REASONS: Record<OcrMediaRealRefusal, string | null> = {
  object_store_not_wired: null,
  media_registry_not_configured:
    '媒体对象存储已接线，但媒体登记册端口未配置：无法校验媒体归属、版本与就绪状态（fail-closed）',
};

/**
 * 判定 `real` 分支是否可接真实端口；`null` 表示**可以**，否则返回闭集原因。
 *
 * 顺序固定（便于逐条断言）：**对象存储身份 → 登记册**。首条故意排在最前：默认 `real` 装配（零注入）
 * 下对象存储是 `unwired` 端口 ⇒ 命中的是 `object_store_not_wired` ⇒ `note` 与本片之前逐字相同。
 *
 * 为什么判 `kind === 's3_compatible'` 而不是「注入了就算」：与 `speech/media.ts` 同一判据 ——
 * 替身（`substitute`）与未接线（`unwired`）端口都可能是**合法但非真实**的注入物，让它们冒充真实
 * 存取会把「能力未接线」谎报成「已接线」。`wiring === undefined`（装配层没转发）同样落到这一条。
 */
export function ocrMediaRealRefusal(wiring?: OcrMediaPortWiring): OcrMediaRealRefusal | null {
  if (wiring === undefined) return 'object_store_not_wired';
  const objectStore = wiring.objectStore ?? null;
  if (objectStore === null || objectStore.kind !== 's3_compatible') return 'object_store_not_wired';
  if ((wiring.mediaRecords ?? null) === null) return 'media_registry_not_configured';
  return null;
}

/** 端口抛出/登记册读不起时 ⇒ 既有三码闭集（保守：按「对象状态不允许」拒绝，不新建码、不放行）。 */
function resolutionCodeOf(error: unknown): MediaResolutionCode {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'NOT_FOUND' || code === 'REVISION_CONFLICT' || code === 'OBJECT_UNAVAILABLE') return code;
  return 'OBJECT_UNAVAILABLE';
}

/** `Content-Type` 归一：小写、去参数（`image/png; charset=binary` ⇒ `image/png`）；非字符串 ⇒ 空串。 */
function normalizeContentType(value: unknown): string {
  if (typeof value !== 'string') return '';
  const [base] = value.split(';');
  return (base ?? '').trim().toLowerCase();
}

const REAL_NOTE =
  '真实媒体引用端口（real）：按 media_id 读媒体登记册，逐条校验归属、版本、就绪状态、标签 OCR 用途与'
  + '去元数据衍生件键，再从对象存储取该衍生件并校验 Content-Type 在 OCR 可接受类型内；'
  + '越权与不存在同形 NOT_FOUND；不读 ambient env、不碰原件（含 EXIF 的 rawRef 不出网）';

/**
 * 真实媒体引用端口（`real`）：受理前的媒体门。
 *
 * 调用前必须已由 {@link ocrMediaRealRefusal} 判定 `null`（本函数自身不重复判定，以便调用方在
 * 拒绝时用闭集原因生成 `note`）。
 *
 * ## 为什么要真的取一次字节（与 `speech/media.ts` 刻意不同）
 * 语音侧只为「能不能建任务」读登记册，字节与 sha256 留给转写期的 `AudioSource` —— 那里有**逐字节
 * 校验**兜底，且整段录音下载两遍在计费桶上是纯浪费。OCR 侧没有这层兜底：适配器只认 PNG/JPEG
 * **头部**，一个「登记册说 ready、对象却是 `application/octet-stream` 或 0 字节」的媒体会被受理、
 * 然后在识别期失败，客户端拿到的是一个必然失败的 202。因此这里**当场证明对象真的取得到、类型真的
 * 吃得下**（代价 = 一次对象下载，见证据页「已知成本」）。⛔ 仍然不把字节交出去，只判真伪。
 *
 * ## 失败语义（内部码 → 对外）
 * | 触发条件 | 返回码 | HTTP |
 * | --- | --- | --- |
 * | `mediaRevision` 不是 >=1 整数 | `REVISION_CONFLICT` | 409 |
 * | 登记册读不起来 | 登记册错误里的闭集码；否则 `OBJECT_UNAVAILABLE` | 409（或 404） |
 * | 记录不存在 **或** 归属者不符 | `NOT_FOUND`（同形，不泄露存在性） | 404 |
 * | 请求 revision ≠ 登记册 revision | `REVISION_CONFLICT` | 409 |
 * | 未就绪 / 用途不是 label_ocr / 无衍生件键 / 对象不存在 / 字节为空 / Content-Type 不受支持 | `OBJECT_UNAVAILABLE` | 409 |
 * | 对象存储端口抛错（含未接线端口的 `PROVIDER_UNAVAILABLE`） | `OBJECT_UNAVAILABLE`（闭集折算） | 409 |
 */
export function createObjectStoreOcrMediaPort(wiring: OcrMediaPortWiring): OcrMediaPort {
  const mediaRecords = wiring.mediaRecords as OcrMediaRegistry;
  const objectStore = wiring.objectStore as OcrMediaObjectStore;
  return {
    kind: 'real',
    note: REAL_NOTE,
    async resolve({ ownerUserId, mediaId, mediaRevision }) {
      // ① 形状（不信任上游；形状不合法即版本冲突，与替身端口同口径）。
      if (!Number.isInteger(mediaRevision) || mediaRevision < 1) return { ok: false, code: 'REVISION_CONFLICT' };

      // ② 登记册：归属、版本、状态、用途、对象键的唯一事实源。
      let record: OcrMediaRecordView | null;
      try {
        record = await mediaRecords.getMedia(mediaId);
      } catch (error) {
        return { ok: false, code: resolutionCodeOf(error) };
      }
      if (record === null) return { ok: false, code: 'NOT_FOUND' };

      // ③ 归属：越权与不存在**同形**（不泄露「这个 mediaId 存在但属于别人」）。
      if (record.ownerId !== ownerUserId) return { ok: false, code: 'NOT_FOUND' };
      // ④ 版本：请求的 revision 必须就是登记册当前 revision。
      if (record.revision !== mediaRevision) return { ok: false, code: 'REVISION_CONFLICT' };
      // ⑤ 只有「已就绪」的媒体可以建识别任务（initiated/processing/rejected/deleted 一律拒绝）。
      if (record.state !== 'ready') return { ok: false, code: 'OBJECT_UNAVAILABLE' };
      // ⑥ 用途必须是标签 OCR：杂草图（weed_recognition）与社区图（community_image）不是标签图。
      if (!(OCR_IMAGE_PURPOSES as readonly string[]).includes(record.purpose)) {
        return { ok: false, code: 'OBJECT_UNAVAILABLE' };
      }
      // ⑦ 对象键必须在：缺衍生件就没有「能出网的那一张图」（原件含元数据，不出网）。
      if (record.derivativeRef === null || record.derivativeRef === '') {
        return { ok: false, code: 'OBJECT_UNAVAILABLE' };
      }

      // ⑧ 取字节：端口异常与对象缺失都 fail-closed（不要空字节、不要占位图）。
      let object: Awaited<ReturnType<OcrMediaObjectStore['getObject']>>;
      try {
        object = await objectStore.getObject(record.derivativeRef);
      } catch (error) {
        return { ok: false, code: resolutionCodeOf(error) };
      }
      if (object === null) return { ok: false, code: 'OBJECT_UNAVAILABLE' };
      if (object.bytes.length === 0) return { ok: false, code: 'OBJECT_UNAVAILABLE' };
      // ⑨ 类型可判：对象自带的 Content-Type 必须落在 OCR 真正能吃的类型内（缺失一律拒绝，不猜）。
      const contentType = normalizeContentType(object.contentType);
      if (!(OCR_IMAGE_CONTENT_TYPES as readonly string[]).includes(contentType)) {
        return { ok: false, code: 'OBJECT_UNAVAILABLE' };
      }

      return { ok: true, revision: record.revision };
    },
  };
}

/**
 * `real` 的**唯一**分派口（`createOcrMediaPort` 调它；两向都只落既有端口，绝不落替身）：
 * 端口齐备 ⇒ 真实端口；否则 ⇒ `unwired`（`note` 由闭集原因生成，缺省那条逐字不变）。
 */
function createRealOrUnwiredPort(wiring?: OcrMediaPortWiring): OcrMediaPort {
  const refusal = ocrMediaRealRefusal(wiring);
  if (refusal === null) return createObjectStoreOcrMediaPort(wiring as OcrMediaPortWiring);
  const reason = REFUSAL_REASONS[refusal];
  return reason === null ? createUnwiredMediaPort() : createUnwiredMediaPort(reason);
}

// ============================================================================
// GY-R70 · 为什么 import 写在文件**末尾**（不是风格偏好）
// ============================================================================
// 1) 上面 78 行之前的行号被既有文档当证据引用（`docs/verification/gy-r28-w12-media-persistence-20261022.md`
//    的 `ocr/media.ts:77`、`gy-r29-chain-e2e-20261022.md` 的 `:76-78` 与 `:69-71`、
//    `gy-r31-i14-image-path-20261022.md` 的 `:26-36`）。在顶部插入 import 会让它们全部 SUSPECT。
//    ESM 的 `import` 声明是**提升的**（hoisted）⇒ 放末尾与放顶部逐字等价，用它换「既有行号不变」。
//    这与本仓 `routes/ocr.ts` / `ocr/service.ts` 末尾 import 的既有做法同源，不是新发明的手法。
// 2) 为什么这两支常量**必须**来自 `ai/ocr-image-source.ts`（⛔ 不复制进本文件）：受理门（本文件）与
//    识别期字节来源（`createObjectStoreOcrImageSource`）必须吃**同一份**「OCR 能吃什么用途/类型」口径。
//    复制两份的话，任何一侧单独收窄都会造成「受理通过、取字节却拒绝」的错位 —— 那种 202 是骗人的。
//    测试 `tests/unit/ocr-media-port.test.mjs` 直接断言两侧引用的是**同一对象**（防漂移）。
import { OCR_IMAGE_CONTENT_TYPES, OCR_IMAGE_PURPOSES } from '../ai/ocr-image-source.ts';
