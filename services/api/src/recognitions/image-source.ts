/**
 * GY-R70 · 拍草识别的**待识别图片字节来源**（真实 `RecognitionImageSource`）：按
 * `media_id` + `revision` 从媒体域对象存储取字节。
 *
 * ## 为什么要这个文件
 * `RecognitionProvider.recognize({jobId, mediaId, mediaRevision})` 只带**引用**、不带图片字节
 * （识别域的媒体端口只回 `{ok, revision}`）。在本片之前，`real` 分支根本没有适配器，因此也没有
 * 「字节从哪来」这个问题；一旦接上真实适配器，字节就必须有人给，且**只从注入端口给**。
 *
 * ## 形状来源（同形，逐条对齐）
 * `services/api/src/ai/ocr-image-source.ts`（GY-R69 / #766）。四件不可让渡的事逐条相同：
 * 1. **版本一致**：请求的 `mediaRevision` 必须与登记册行的 `revision` 相同，否则 `REVISION_CONFLICT`
 *    —— 绝不把**别的版本**的字节喂给适配器。
 * 2. **就绪 + 用途**：只接受 `state === 'ready'` 且 `purpose === 'weed_recognition'` 的媒体。
 *    标签图（`label_ocr`）与社区图（`community_image`）**一律拒绝**：识别杂草不是识别农药标签，
 *    把它当送检字节属于跨用途取值。
 * 3. **只出「去元数据衍生件」**：读 `derivativeRef`，**不读 `rawRef`**。媒体域口径是「对外只提供
 *    **已去元数据**的衍生件；原始对象不出网」（`services/api/src/media/service.ts` 的社区取图路径自述，
 *    证据页 `docs/verification/gy-i06-media-real-provider-plan-20261021.md` §6「两个对象」同口径）。
 *    识别照片的原件含相机 GPS/EXIF，送到第三方识别等于把定位一起送出去 ⇒ 宁可 fail-closed。
 * 4. **类型可判**：对象自带 `Content-Type` 必须落在本适配器真正能吃的类型内
 *    （`RECOGNITION_IMAGE_CONTENT_TYPES`）；缺失或不受支持一律拒绝（不猜）。
 *
 * ## 与原样的**唯一**刻意差异：端口用「取值器」晚绑定
 * `app.ts` 里识别域的装配点（`recognitionProviderResolved`）在媒体域端口（`mediaStore` /
 * `mediaObjectStore`）解析**之前**，因此本文件收的是 `() => { mediaRecords, objectStore }`
 * 而不是两个现成对象：取值器在每次 `read()` 时才调用一次，读到的是媒体域**既有**的那两个实例
 * （不新建存储、不读 env、不铸造批准能力）。除这一点，本文件与 `ocr-image-source.ts` 逐条同形。
 *
 * ## 硬性纪律（本文件自证）
 * - ⛔ 不读 ambient env、⛔ 不回退磁盘默认路径、⛔ 不产生任何「猜的」字节：本文件**不 import
 *   `node:fs`**、**不出现环境变量读取**、**不出现 `fetch(`**（`tests/unit/recognitions-live-adapter.test.mjs`
 *   直接读本文件源码逐条断言）。
 * - ⛔ 不新造错误码：内部失败码全部是契约既有错误码。
 * - ⛔ 不静默成功：任一环节不成立一律 `read() → null`，由适配器按既有口径落 `failed PROVIDER_UNAVAILABLE`
 *   （未发包、不占预算）；**绝不返回空字节或占位图片**，**绝不回退到替身/示例图**。
 *
 * ## 失败语义对照表（内部码 → 对外结局）
 * | 触发条件 | `lastFailure()` | 适配器对外 |
 * | --- | --- | --- |
 * | 端口取值器给出空端口（缺登记册/对象存储） | `PROVIDER_UNAVAILABLE` | `failed PROVIDER_UNAVAILABLE`，零发包 |
 * | 媒体记录不存在 / 归属不是调用者 | `NOT_FOUND` | 同上 |
 * | 请求 revision ≠ 登记册 revision | `REVISION_CONFLICT` | 同上 |
 * | 未就绪 / 用途不是 weed_recognition / 无衍生件键 / 对象不存在 / 空字节 / Content-Type 不受支持 / 端口异常 | `OBJECT_UNAVAILABLE` | 同上 |
 * | 对象存储端口自身抛 `PROVIDER_UNAVAILABLE`（未接线端口就是如此） | `PROVIDER_UNAVAILABLE`（**原样保留**） | 同上 |
 */
import { createUnwiredRecognitionImageSource } from './live-adapter.ts';
import type { RecognitionImageSource } from './live-ports.ts';

/** `read()` 的内部失败码闭集（**全部是既有契约错误码，不新造**；与 OCR/ASR 两侧逐字同集合）。 */
export const RECOGNITION_IMAGE_FAILURE_CODES = [
  'NOT_FOUND',
  'REVISION_CONFLICT',
  'OBJECT_UNAVAILABLE',
  'PROVIDER_UNAVAILABLE',
] as const;
export type RecognitionImageFailureCode = (typeof RECOGNITION_IMAGE_FAILURE_CODES)[number];

/**
 * 允许喂给识别适配器的**对象 Content-Type**（只认适配器真正能解析的两种）。
 *
 * 口径来源：`recognitions/live-adapter.ts` 的 `requireLiveRecognitionImage()` 只放行 PNG / JPEG 头部。
 * `image/webp` 是 `packages/media/constants.mjs` 的 `MEDIA_PURPOSE_MIME.weed_recognition` 合法上传类型，
 * 但**不是**本适配器可识别的类型 ⇒ 明确拒绝（测试逐条核对这份收窄关系，防止两处漂移）。
 */
export const RECOGNITION_IMAGE_CONTENT_TYPES = Object.freeze(['image/jpeg', 'image/png'] as const);

/** 允许喂给识别适配器的媒体用途（**只取拍草识别**）。口径来源：`packages/media/constants.mjs` 的 `MEDIA_PURPOSES`。 */
export const RECOGNITION_IMAGE_PURPOSES = Object.freeze(['weed_recognition'] as const);

/** 媒体登记册行的**只读取值面**（结构上即 `media/store.ts` 的 `MediaRecord`）。 */
export interface RecognitionImageRecordView {
  /** 归属主体。给了 `ownerUserId` 时必须一致，否则按「不存在」拒绝（不泄露存在性）。 */
  readonly ownerId?: string | null;
  readonly revision: number;
  readonly state: string;
  readonly purpose: string;
  /** 客户端直传的原件（**含元数据**）。本端口只拿它做诊断，**不取值**。 */
  readonly rawRef: string | null;
  /** 去元数据衍生件。本端口取字节的**唯一**对象键。 */
  readonly derivativeRef: string | null;
}

/** 媒体登记册（结构上即 `media/store.ts` 的 `MediaStore.getMedia`）。 */
export interface RecognitionImageRegistry {
  getMedia(mediaId: string): Promise<RecognitionImageRecordView | null>;
}

/**
 * 对象存储端口的**只读取值面**（结构上即 `media/object-store.ts` 的 `MediaObjectStore`）。
 * `kind` 刻意声明为 `string`：本端口**不按 kind 放行**，只按注入者的显式选择工作。
 */
export interface RecognitionImageObjectStore {
  readonly kind: string;
  getObject(key: string): Promise<{ readonly bytes: Uint8Array; readonly contentType: string } | null>;
}

/** 两个注入端口（**全部可缺**；缺即 fail-closed）。 */
export interface RecognitionImagePorts {
  readonly mediaRecords?: RecognitionImageRegistry | null;
  readonly objectStore?: RecognitionImageObjectStore | null;
}

/**
 * 端口**取值器**：每次 `read()` 调用一次。用取值器而不是现成对象，是因为装配顺序上媒体域端口在
 * 识别域之后解析（见文件头「唯一刻意差异」）。
 */
export type RecognitionImagePortsResolver = () => RecognitionImagePorts;

/** 真实字节来源：`RecognitionImageSource` ＋ 三个**只读**诊断读数（不含图片内容、不含私有引用）。 */
export interface ObjectStoreRecognitionImageSource extends RecognitionImageSource {
  /** 最近一次 `read()` 的失败码；成功为 `null`。**诊断用**（并发读时以最后一次为准）。 */
  lastFailure(): RecognitionImageFailureCode | null;
  /** 最近一次 `read()` 的失败**原因**（不含对象键、不含字节）；成功为 `null`。**诊断用**。 */
  lastFailureReason(): string | null;
  /** 已尝试取值次数（诊断读数；不改变任何语义）。 */
  readonly readAttempts: number;
}

/** 端口是否齐备（缺哪个就点名哪个：运维照这句话补，不必读源码）。 */
function missingPorts(ports: RecognitionImagePorts | null | undefined): string[] {
  const missing: string[] = [];
  if (ports === null || ports === undefined || ports.mediaRecords == null) missing.push('媒体登记册（mediaRecords）');
  if (ports === null || ports === undefined || ports.objectStore == null) missing.push('对象存储端口（objectStore）');
  return missing;
}

/** 端口抛出的错误里若带的是本闭集码，**原样保留**（例如未接线端口的 PROVIDER_UNAVAILABLE）。 */
function failureCodeOf(error: unknown, fallback: RecognitionImageFailureCode): RecognitionImageFailureCode {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && (RECOGNITION_IMAGE_FAILURE_CODES as readonly string[]).includes(code)) {
    return code as RecognitionImageFailureCode;
  }
  return fallback;
}

/** `Content-Type` 归一：小写、去参数；非字符串 ⇒ 空串。 */
function normalizeContentType(value: unknown): string {
  if (typeof value !== 'string') return '';
  const [base] = value.split(';');
  return (base ?? '').trim().toLowerCase();
}

/** 取值器的安全包装：取值器自己抛错也按「端口未配置」fail-closed（绝不把异常抛进请求期）。 */
function safeResolve(resolver: RecognitionImagePortsResolver): RecognitionImagePorts | null {
  try {
    const resolved = resolver();
    return resolved === null || typeof resolved !== 'object' ? null : resolved;
  } catch {
    return null;
  }
}

/**
 * 由注入端口构造真实字节来源。**这是识别域字节端口的产品唯一构造器**
 * （`app.ts` 把它交给 `createRecognitionProvider`）。
 */
export function createObjectStoreRecognitionImageSource(
  resolvePorts: RecognitionImagePortsResolver,
): ObjectStoreRecognitionImageSource {
  if (typeof resolvePorts !== 'function') {
    const unwired = createUnwiredRecognitionImageSource('真实识别图片字节来源未接线：缺少端口取值器');
    let attempts = 0;
    return {
      kind: unwired.kind,
      note: unwired.note,
      async read() {
        attempts += 1;
        return null;
      },
      lastFailure() {
        return 'PROVIDER_UNAVAILABLE';
      },
      lastFailureReason() {
        return '端口未配置：缺少端口取值器';
      },
      get readAttempts() {
        return attempts;
      },
    };
  }

  let lastFailure: RecognitionImageFailureCode | null = null;
  let lastReason: string | null = null;
  let attempts = 0;

  return {
    kind: 'wired',
    note:
      '真实识别图片字节来源：按 media_id+revision 读媒体登记册（归属/版本/状态/用途/衍生件键）→ 只从对象存储端口取'
      + '**去元数据衍生件** → 校验对象 Content-Type 在识别适配器可接受类型内；不读 ambient env、不回退磁盘默认路径、'
      + '不外发含元数据原件、不伪造字节（任一环节不成立即 fail-closed）',
    async read({ mediaId, mediaRevision, ownerUserId }) {
      attempts += 1;
      const fail = (code: RecognitionImageFailureCode, reason: string): null => {
        lastFailure = code;
        lastReason = reason;
        return null;
      };

      // ⓪ 端口取值（取值器晚绑定；缺端口 ⇒ fail-closed，绝不改用别的来源补字节）。
      const ports = safeResolve(resolvePorts);
      const missing = missingPorts(ports);
      if (missing.length > 0) {
        return fail('PROVIDER_UNAVAILABLE', `端口未配置：缺 ${missing.join('、')}`);
      }
      const mediaRecords = ports?.mediaRecords as RecognitionImageRegistry;
      const objectStore = ports?.objectStore as RecognitionImageObjectStore;

      // ① 媒体登记册：对象键、状态、用途、版本都只从这一行取。
      let record: RecognitionImageRecordView | null;
      try {
        record = await mediaRecords.getMedia(mediaId);
      } catch (error) {
        return fail(failureCodeOf(error, 'PROVIDER_UNAVAILABLE'), '媒体登记册读取失败');
      }
      if (record === null) return fail('NOT_FOUND', '媒体记录不存在');
      // ② 归属（仅在调用方给出主体时判定）：越权与不存在同形，不泄露存在性。
      if (typeof ownerUserId === 'string' && ownerUserId !== '' && record.ownerId !== undefined && record.ownerId !== ownerUserId) {
        return fail('NOT_FOUND', '媒体记录不存在');
      }
      // ③ 版本一致：登记册当前 revision 必须正是这次识别被授权的那一版。
      if (record.revision !== mediaRevision) {
        return fail('REVISION_CONFLICT', `媒体版本已推进（登记 ${record.revision}，请求 ${mediaRevision}）`);
      }
      // ④ 只有「已就绪」且「拍草识别用途」的媒体可以喂给适配器（标签图不是杂草图）。
      if (record.state !== 'ready') return fail('OBJECT_UNAVAILABLE', `媒体未就绪（state=${record.state}）`);
      if (!(RECOGNITION_IMAGE_PURPOSES as readonly string[]).includes(record.purpose)) {
        return fail('OBJECT_UNAVAILABLE', `媒体用途不是拍草识别（purpose=${record.purpose}）`);
      }
      // ⑤ 对象键：只取**去元数据衍生件**；原件不出网（含 EXIF/GPS），缺失即 fail-closed。
      if (record.derivativeRef === null || record.derivativeRef === '') {
        return fail(
          'OBJECT_UNAVAILABLE',
          record.rawRef === null || record.rawRef === ''
            ? '媒体没有对象键（rawRef 与 derivativeRef 均为空）'
            : '媒体只有含元数据的原件（derivativeRef 为空）：按「原始对象不出网」不外发',
        );
      }

      // ⑥ 取字节：端口异常（含未接线端口的 PROVIDER_UNAVAILABLE）与对象缺失都 fail-closed。
      let object: Awaited<ReturnType<RecognitionImageObjectStore['getObject']>>;
      try {
        object = await objectStore.getObject(record.derivativeRef);
      } catch (error) {
        return fail(failureCodeOf(error, 'OBJECT_UNAVAILABLE'), '对象存储取字节失败');
      }
      if (object === null) return fail('OBJECT_UNAVAILABLE', '对象存储里没有该对象');
      // ⑦ 不许交空字节包：空对象等于「没取到」，绝不能当成功数据往上交。
      if (object.bytes.length === 0) return fail('OBJECT_UNAVAILABLE', '对象字节为空');
      // ⑧ 类型可判：对象自带的 Content-Type 必须落在适配器真正能吃的类型内。
      const contentType = normalizeContentType(object.contentType);
      if (!(RECOGNITION_IMAGE_CONTENT_TYPES as readonly string[]).includes(contentType)) {
        return fail('OBJECT_UNAVAILABLE', `对象 Content-Type 不在识别适配器可接受类型内（${contentType === '' ? '缺失' : contentType}）`);
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
