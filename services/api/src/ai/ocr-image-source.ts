/**
 * GY-R69 · OCR 待识别图片字节来源（**真实 `OcrImageSource`**）：按 `media_id` + `revision` 从媒体域对象存储取字节。
 *
 * ## 为什么需要这个文件
 * `OcrProvider.extract({jobId, mediaId, mediaRevision})` 只带**引用**、不带图片字节（服务层的媒体端口只回
 * `{ok, revision}`），字节必须由注入的 `OcrImageSource` 给（见 `ai/ocr-live-ports.ts` 的 `OcrImageSource`）。
 * 在本次接线之前，产品装配注入的是 `createUnwiredImageSource('真实对象存储未接线…')`：它**恒返回 `null`**，
 * 于是适配器永远落 `failed PROVIDER_UNAVAILABLE`，一个字节都发不出去。本文件是那份真实实现，把「一次识别
 * 该读哪一张图」翻译成「对象存储里的哪一个对象」，并在翻译过程中完成四件不可让渡的事：
 *
 * 1. **版本一致**：请求的 `mediaRevision` 必须与登记册行的 `revision` 相同；不一致 `REVISION_CONFLICT`
 *    （媒体域既有码）—— 绝不把**别的版本**的字节喂给适配器。
 * 2. **就绪 + 用途**：只接受 `state === 'ready'` 且 `purpose === 'label_ocr'` 的媒体。除草识别照片
 *    （`weed_recognition`）与社区图（`community_image`）**一律拒绝**：识别标签不是识别杂草，把它当
 *    送检字节属于跨用途取值。
 * 3. **只出「去元数据衍生件」**：读 `derivativeRef`，**不读 `rawRef`**。这是媒体域已写死的口径
 *    （`media/service.ts` 的社区取图路径自述「对外只提供**已去元数据**的衍生件；原始对象不出网」，
 *    证据页 `docs/verification/gy-i06-media-real-provider-plan-20261021.md` §6「两个对象」条同口径）。
 *    把原件送去第三方 OCR 等于把相机 GPS/EXIF 一起送出去 —— 本端口宁可 fail-closed 也不这么干。
 *    ⚠ 与 `ai/asr-audio-source.ts` 的**唯一刻意差异**：ASR 读 `rawRef`（音频没有去元数据衍生物），
 *      图片有衍生物 ⇒ 这里读 `derivativeRef`。除此之外形状逐条对齐它。
 * 4. **类型可判**：对象自带的 `Content-Type` 必须落在 OCR 真正能吃的类型内（`OCR_IMAGE_CONTENT_TYPES`）；
 *    不在则明确拒绝（`application/octet-stream` 这类「元数据缺失」同样拒绝，不猜）。
 *
 * ## 硬性纪律（本文件自证）
 * - ⛔ 不读 ambient env、⛔ 不回退磁盘默认路径、⛔ 不产生任何「猜的」字节：本文件**不 import `node:fs`**、
 *   **不出现环境变量读取**（`tests/unit/ocr-image-source.test.mjs` 直接读本文件源码逐条断言）。
 *   字节的唯一来源是注入的对象存储端口。
 * - ⛔ 不新造错误码：`read()` 的内部失败码全部是契约既有错误码（`NOT_FOUND` / `REVISION_CONFLICT` /
 *   `OBJECT_UNAVAILABLE` / `PROVIDER_UNAVAILABLE`）。
 * - ⛔ 不静默成功：任一环节不成立一律 `read() → null`，由适配器按既有口径落 `failed PROVIDER_UNAVAILABLE`
 *   （未发包、不占预算）；**绝不返回空字节或占位图片**，**绝不回退到替身/示例图**。
 * - 端口未配置（缺登记册 / 缺对象存储）⇒ 复用 `createUnwiredImageSource()`
 *   —— **「未接线」只有那一份实现**，`kind === 'unwired'` 且恒 `null`。它不是替身：它不产出任何字节。
 *
 * ## 失败语义对照表（内部码 → 对外结局）
 * | 触发条件 | `lastFailure()` | 适配器对外 |
 * | --- | --- | --- |
 * | 端口未配置（缺登记册/对象存储） | `PROVIDER_UNAVAILABLE` | `failed PROVIDER_UNAVAILABLE`，零发包 |
 * | 媒体记录不存在 | `NOT_FOUND` | 同上 |
 * | 请求 revision ≠ 登记册 revision | `REVISION_CONFLICT` | 同上 |
 * | 媒体未就绪 / 用途不是 label_ocr / 无衍生件键 / 对象不存在 / 字节为空 / Content-Type 不受支持 / 端口异常 | `OBJECT_UNAVAILABLE` | 同上 |
 * | 对象存储端口自身抛 `PROVIDER_UNAVAILABLE`（未接线端口就是如此） | `PROVIDER_UNAVAILABLE`（**原样保留**） | 同上 |
 *
 * 为什么内部码**不**直接改变对外结局：适配器把「本地拒绝」统一映射成 `PROVIDER_UNAVAILABLE` 是既有红线
 * （`ai/ocr-live-adapter.ts` 的 `extract` 第一步把 `imageSource.read` 的异常/空值一律落该码），本片一个字
 * 都不放宽。内部码只作**诊断**：不落库、不含任何私有引用、不含图片内容（`lastFailureReason()` 同理）。
 */
import { createUnwiredImageSource } from './ocr-live-adapter.ts';
import type { OcrImageSource } from './ocr-live-ports.ts';

/**
 * `read()` 的内部失败码闭集（**全部是既有契约错误码，不新造**：与 `ai/asr-audio-source.ts` 的
 * `SPEECH_AUDIO_FAILURE_CODES` 逐字同集合，语音/图片两侧的诊断口径因此可对读）。
 */
export const OCR_IMAGE_FAILURE_CODES = [
  'NOT_FOUND',
  'REVISION_CONFLICT',
  'OBJECT_UNAVAILABLE',
  'PROVIDER_UNAVAILABLE',
] as const;
export type OcrImageFailureCode = (typeof OCR_IMAGE_FAILURE_CODES)[number];

/**
 * 允许喂给 OCR 的**对象 Content-Type**（只认适配器真正能解析的两种）。
 *
 * 口径来源：`ai/ocr-live-adapter.ts` 的 `requireLiveOcrImage()` 只放行 PNG / JPEG 头部，因此上游
 * **多给一种**都只会把失败推迟到适配器、把「不受支持」说成「图片头部非法」。这里提前收窄成同集合：
 * `image/webp` 虽然是 `packages/media/constants.mjs` 的 `MEDIA_PURPOSE_MIME.label_ocr` 合法上传类型，
 * 但**不是**本适配器可识别的类型 ⇒ 明确拒绝（测试逐条核对这份收窄关系，防止两处漂移）。
 */
export const OCR_IMAGE_CONTENT_TYPES = Object.freeze(['image/jpeg', 'image/png'] as const);

/**
 * 允许喂给 OCR 的媒体用途（**只取标签 OCR**）。
 * 口径来源：`packages/media/constants.mjs` 的 `MEDIA_PURPOSES`；测试按 `MEDIA_PURPOSE_KIND` 逐条核对。
 */
export const OCR_IMAGE_PURPOSES = Object.freeze(['label_ocr'] as const);

/** 媒体登记册行的**只读取值面**（结构上即 `media/store.ts` 的 `MediaRecord`）。 */
export interface OcrImageRecordView {
  readonly revision: number;
  readonly state: string;
  readonly purpose: string;
  /** 客户端直传的原件（**含元数据**）。本端口**只**用它做诊断，不取值。 */
  readonly rawRef: string | null;
  /** 去元数据衍生件。本端口取字节的**唯一**对象键。 */
  readonly derivativeRef: string | null;
}

/** 媒体登记册（结构上即 `media/store.ts` 的 `MediaStore.getMedia`）。 */
export interface OcrImageRegistry {
  getMedia(mediaId: string): Promise<OcrImageRecordView | null>;
}

/**
 * 对象存储端口的**只读取值面**（结构上即 `media/object-store.ts` 的 `MediaObjectStore`）。
 *
 * `kind` 刻意声明为 `string`：本端口**不按 kind 放行**，只按注入者的显式选择工作（判据是"装配层注入了
 * 哪个端口"，不是一个自述布尔标志）。注入未接线端口时 `getObject` 会抛 `MediaError('PROVIDER_UNAVAILABLE')`，
 * 本文件**原样保留**该码（与 ASR 侧一致）。
 */
export interface OcrImageObjectStore {
  readonly kind: string;
  getObject(key: string): Promise<{ readonly bytes: Uint8Array; readonly contentType: string } | null>;
}

/** `createObjectStoreOcrImageSource()` 的两个注入端口；**全部可缺**（缺即 fail-closed）。 */
export interface ObjectStoreOcrImageSourceOptions {
  /** 媒体登记册（`media/store.ts` 的 `MediaStore`）。 */
  readonly mediaRecords?: OcrImageRegistry | null;
  /** 对象存储端口（`media/object-store.ts` 的 `MediaObjectStore`）。 */
  readonly objectStore?: OcrImageObjectStore | null;
}

/**
 * 真实图片字节来源：`OcrImageSource` ＋ 三个**只读**诊断读数（不含图片内容、不含私有引用）。
 *
 * 适配器对外只会看见 `Uint8Array | null`，本片的失败码差异必须能被断言，否则「媒体缺失/版本不符/
 * 用途不符/端口未配置分别 fail-closed」就只是一句话而不是可复核的事实。
 */
export interface ObjectStoreOcrImageSource extends OcrImageSource {
  /** 最近一次 `read()` 的失败码；成功为 `null`。**诊断用**（并发读时以最后一次为准）。 */
  lastFailure(): OcrImageFailureCode | null;
  /** 最近一次 `read()` 的失败**原因**（不含对象键、不含字节）；成功为 `null`。**诊断用**。 */
  lastFailureReason(): string | null;
  /** 已尝试取值次数（诊断读数；不改变任何语义）。 */
  readonly readAttempts: number;
}

/** 端口是否齐备（缺哪个就点名哪个：运维照这句话补，不必读源码）。 */
function missingPorts(options: ObjectStoreOcrImageSourceOptions): string[] {
  const missing: string[] = [];
  if (options.mediaRecords == null) missing.push('媒体登记册（mediaRecords）');
  if (options.objectStore == null) missing.push('对象存储端口（objectStore）');
  return missing;
}

/** 端口抛出的错误里若带的是本闭集码，**原样保留**（例如未接线端口的 PROVIDER_UNAVAILABLE）。 */
function failureCodeOf(error: unknown, fallback: OcrImageFailureCode): OcrImageFailureCode {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && (OCR_IMAGE_FAILURE_CODES as readonly string[]).includes(code)) {
    return code as OcrImageFailureCode;
  }
  return fallback;
}

/** `Content-Type` 归一：小写、去参数（`image/png; charset=binary` ⇒ `image/png`）；非字符串 ⇒ 空串。 */
function normalizeContentType(value: unknown): string {
  if (typeof value !== 'string') return '';
  const [base] = value.split(';');
  return (base ?? '').trim().toLowerCase();
}

/**
 * 由注入的端口构造图片字节来源。**这是产品装配的唯一构造器**
 * （`services/api/src/routes/ocr.ts` 的 `registerOcrRoutes()` 调它，再交 `createOcrProvider`）。
 *
 * - 端口齐备 ⇒ `kind === 'wired'`，按 `media_id + revision → 登记册（版本/状态/用途/衍生件键）→ 对象存储`
 *   取字节；任一环节不成立即 `null`（fail-closed），并在 `lastFailure()` 留下既有码。
 * - 端口缺失 ⇒ `kind === 'unwired'`（`createUnwiredImageSource()`），恒 `null`：**能力未接线**，
 *   不是替身、不产字节。
 */
export function createObjectStoreOcrImageSource(
  options: ObjectStoreOcrImageSourceOptions = {},
): ObjectStoreOcrImageSource {
  const missing = missingPorts(options);
  let unwiredAttempts = 0;
  if (missing.length > 0) {
    const unwired = createUnwiredImageSource(`真实图片字节来源未接线：缺 ${missing.join('、')}`);
    return {
      kind: unwired.kind,
      note: unwired.note,
      async read(input) {
        unwiredAttempts += 1;
        return unwired.read(input);
      },
      lastFailure() {
        return 'PROVIDER_UNAVAILABLE';
      },
      lastFailureReason() {
        return `端口未配置：缺 ${missing.join('、')}`;
      },
      get readAttempts() {
        return unwiredAttempts;
      },
    };
  }

  const mediaRecords = options.mediaRecords as OcrImageRegistry;
  const objectStore = options.objectStore as OcrImageObjectStore;
  let lastFailure: OcrImageFailureCode | null = null;
  let lastReason: string | null = null;
  let attempts = 0;

  return {
    kind: 'wired',
    note:
      '真实图片字节来源：按 media_id+revision 读媒体登记册（版本/状态/用途/衍生件键）→ 只从对象存储端口取'
      + '**去元数据衍生件** → 校验对象 Content-Type 在 OCR 可接受类型内；不读 ambient env、不回退磁盘默认路径、'
      + '不外发含元数据原件、不伪造字节（任一环节不成立即 fail-closed）',
    async read({ mediaId, mediaRevision }) {
      attempts += 1;
      const fail = (code: OcrImageFailureCode, reason: string): null => {
        lastFailure = code;
        lastReason = reason;
        return null;
      };

      // ① 媒体登记册：对象键、状态、用途、版本都只从这一行取。
      let record: OcrImageRecordView | null;
      try {
        record = await mediaRecords.getMedia(mediaId);
      } catch (error) {
        return fail(failureCodeOf(error, 'PROVIDER_UNAVAILABLE'), '媒体登记册读取失败');
      }
      if (record === null) return fail('NOT_FOUND', '媒体记录不存在');
      // ② 版本一致：登记册当前 revision 必须正是这次识别被授权的那一版。
      if (record.revision !== mediaRevision) {
        return fail('REVISION_CONFLICT', `媒体版本已推进（登记 ${record.revision}，请求 ${mediaRevision}）`);
      }
      // ③ 只有「已就绪」且「标签 OCR 用途」的媒体可以喂给 OCR（照片不是录音，杂草图不是标签图）。
      if (record.state !== 'ready') return fail('OBJECT_UNAVAILABLE', `媒体未就绪（state=${record.state}）`);
      if (!(OCR_IMAGE_PURPOSES as readonly string[]).includes(record.purpose)) {
        return fail('OBJECT_UNAVAILABLE', `媒体用途不是标签 OCR（purpose=${record.purpose}）`);
      }
      // ④ 对象键：只取**去元数据衍生件**；原件不出网（含 EXIF/GPS），缺失即 fail-closed。
      if (record.derivativeRef === null || record.derivativeRef === '') {
        return fail(
          'OBJECT_UNAVAILABLE',
          record.rawRef === null || record.rawRef === ''
            ? '媒体没有对象键（rawRef 与 derivativeRef 均为空）'
            : '媒体只有含元数据的原件（derivativeRef 为空）：按「原始对象不出网」不外发',
        );
      }

      // ⑤ 取字节：端口异常（含未接线端口的 PROVIDER_UNAVAILABLE）与对象缺失都 fail-closed。
      let object: Awaited<ReturnType<OcrImageObjectStore['getObject']>>;
      try {
        object = await objectStore.getObject(record.derivativeRef);
      } catch (error) {
        return fail(failureCodeOf(error, 'OBJECT_UNAVAILABLE'), '对象存储取字节失败');
      }
      if (object === null) return fail('OBJECT_UNAVAILABLE', '对象存储里没有该对象');
      // ⑥ 不许交空字节包：空对象等于「没取到」，绝不能当成功数据往上交。
      if (object.bytes.length === 0) return fail('OBJECT_UNAVAILABLE', '对象字节为空');
      // ⑦ 类型可判：对象自带的 Content-Type 必须落在 OCR 真正能吃的类型内（缺失/不受支持一律拒绝）。
      const contentType = normalizeContentType(object.contentType);
      if (!(OCR_IMAGE_CONTENT_TYPES as readonly string[]).includes(contentType)) {
        return fail('OBJECT_UNAVAILABLE', `对象 Content-Type 不在 OCR 可接受类型内（${contentType === '' ? '缺失' : contentType}）`);
      }

      lastFailure = null;
      lastReason = null;
      return object.bytes;
    },
    lastFailure() {
      return lastFailure;
    },
    lastFailureReason() {
      return lastReason;
    },
    get readAttempts() {
      return attempts;
    },
  };
}
