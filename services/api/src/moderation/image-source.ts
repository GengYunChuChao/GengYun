/**
 * GY-R70 · 审核域的**待审图片字节来源**（真实 `ModerationImageSource`）：按 `media_id`（＋可选
 * `media_revision`）从媒体域既有的两个端口取字节 —— **只取去元数据衍生件**。
 *
 * ## 为什么要这个文件
 * 合流层给图片审核端口的请求里**只有不透明引用**（`media_id` / `media_revision` / `mime`，见
 * `packages/moderation/model-ports.mjs` 的图片引用归一器），**没有字节**。因此字节必须由注入的
 * `ModerationImageSource` 提供（`moderation/live-ports.ts:274` 定义、`:402` 注明"必填"）。
 * 在本片之前，产品侧注入的是 `createUnwiredModerationImageSource(...)`（`moderation/live-vendor.ts:397`）：
 * 它诚实返回 `null` ⇒ 适配器在「取不到待审图片」处 `failed PROVIDER_UNAVAILABLE`（未发包、不占预算），
 * 一个像素都送不出去。**本文件是那份真实实现**，把"这一次送审该读哪一张图"翻译成"对象存储里的哪一个对象"。
 *
 * ## 形状来源（同族先例，逐条对齐）
 * `services/api/src/ai/ocr-image-source.ts`（GY-R69）与 `services/api/src/recognitions/image-source.ts`
 * （GY-R70 拍草识别）。四件不可让渡的事逐条相同：
 *
 * 1. **只出「去元数据衍生件」**：读 `derivativeRef`，**不读 `rawRef`**。媒体域已写死这一口径
 *    （`media/service.ts` 的社区取图路径自述「对外只提供**已去元数据**的衍生件；原始对象不出网」，
 *    证据页 `docs/verification/gy-i06-media-real-provider-plan-20261021.md` §6「两个对象」同口径）。
 *    社区投稿图的原件含相机 GPS/EXIF，送到第三方审核等于把定位一起送出去 ⇒ 宁可 fail-closed。
 * 2. **就绪 + 用途**：只接受 `state === 'ready'` 且 `purpose === 'community_image'` 的媒体。
 *    标签 OCR 图（`label_ocr`）、杂草识别图（`weed_recognition`）、录音（`voice_question`）**一律拒绝**：
 *    审核社区投稿图不是识别农药标签，把它当送审字节属于跨用途取值。
 * 3. **归属**：媒体登记册行必须**有归属主体**（非空 `ownerId`）；给了 `ownerUserId` 的装配层还可以再收窄
 *    （不一致 ⇒ 与"不存在"**同形** `NOT_FOUND`，不泄露存在性）。为什么这里没有"调用者身份"判据：
 *    `ModerationImageSource.read()` 的入参只有 `{mediaId, mediaRevision}`（`live-ports.ts:278`）——
 *    审核域在这一层**拿不到**"谁在送审"，越权由上游（社区域 `me` 路由 + 审核域内容权威端口）判；
 *    本端口能如实做到的是「这条媒体有主体」＋「主体若被装配层钉死就必须相符」。
 * 4. **类型可判**：对象自带的 `Content-Type` 必须落在审核适配器真正能吃的类型内
 *    （`MODERATION_IMAGE_CONTENT_TYPES`，与 `live-vendor.ts:requireModerationImageBytes()` 的 PNG/JPEG
 *    头部嗅探同集合）；缺失或不受支持一律拒绝（不猜）。
 *
 * ## 版本口径（**与本族其余两份的唯一刻意差异**，请连同证据页 §7 一并读）
 * OCR / 识别两份要求"请求 `revision` 必须等于登记册 `revision`"，并把不一致判 `REVISION_CONFLICT`；
 * 本端口**同样**这么判 —— **但 `mediaRevision === null` 时不清零**：社区投稿的送审载荷
 * （`community/service.ts` 的 `mediaInputs()`）只带 `{media_id}`，**从不带** `media_revision`。
 * 若把 `null` 也判成冲突，本端口在**唯一真实存在的送审路径上永远不会返回字节**（等于没接线）。
 * 因此 `null` 的语义是"没有钉版本 ⇒ 读该媒体**登记册当前那一版**的衍生件"：
 * - 对象键仍然**只**来自登记册行本身（不猜、不拼、不回退）；
 * - 一旦调用方**给了**版本（整数 ≥ 1），就必须**逐字相同**，否则 `REVISION_CONFLICT`
 *   （版本给了却推不动是最危险的情形：手上有旧审核结论、发出去的是另一张图）；
 * - 版本形状不合法（`0` / 小数 / `NaN` / 负数）同样 `REVISION_CONFLICT`（与 OCR 受理端同口径）。
 *
 * ## 硬性纪律（本文件自证，`tests/unit/moderation-image-source.test.mjs` 直接读源码逐条断言）
 * - ⛔ 不读 ambient env、⛔ 不回退磁盘默认路径、⛔ 不产生任何「猜的」字节：本文件**不 import `node:fs`**、
 *   **不出现环境变量读取**、**不出现 `fetch(`**。字节的唯一来源是注入的对象存储端口。
 * - ⛔ 不新造错误码：内部失败码全部是契约既有错误码（`NOT_FOUND` / `REVISION_CONFLICT` /
 *   `OBJECT_UNAVAILABLE` / `PROVIDER_UNAVAILABLE`，与 OCR/识别/语音三侧逐字同集合）。
 * - ⛔ 不静默成功：任一环节不成立一律 `read() → null`，由适配器按既有口径抛
 *   `ModerationPortError('payload_invalid','image_bytes_missing')`（本地拒绝、零发包、不占预算）；
 *   **绝不返回空字节或占位图**，**绝不回退到替身/示例图**。
 * - 端口未配置（缺登记册 / 缺对象存储）⇒ 由装配层（`live-wiring.ts`）落回
 *   `createUnwiredModerationImageSource(...)` —— **「未接线」只有那一份实现**，`kind === 'unwired'` 且恒 `null`。
 *
 * ## 失败语义对照表（内部码 → 对外结局）
 * | 触发条件 | `lastFailure()` | 适配器对外 |
 * | --- | --- | --- |
 * | 端口取值器给出空端口（缺登记册/对象存储），或取值器自己抛错 | `PROVIDER_UNAVAILABLE` | `payload_invalid`，零发包 |
 * | 媒体 id 不是非空字符串 / 媒体记录不存在 / 无归属主体 / 归属主体不符 | `NOT_FOUND` | 同上 |
 * | 请求版本形状不合法 / 请求版本 ≠ 登记册版本 | `REVISION_CONFLICT` | 同上 |
 * | 未就绪 / 用途不是 community_image / 无衍生件键 / 对象不存在 / 空字节 / Content-Type 不受支持 | `OBJECT_UNAVAILABLE` | 同上 |
 * | 媒体登记册或对象存储端口自身抛错 | 抛出码在闭集内**原样保留**，否则 `PROVIDER_UNAVAILABLE`（登记册）/ `OBJECT_UNAVAILABLE`（对象存储） | 同上 |
 *
 * 为什么内部码**不**改变对外结局：适配器把"本地拒绝"统一落 `payload_invalid` 是既有红线
 * （图片适配器的本地拒绝分支），本片一个字都不放宽。内部码只作**诊断**：
 * 不落库、不含对象键、不含图片内容（`lastFailureReason()` 同理）。
 */
import { createUnwiredModerationImageSource } from './live-vendor.ts';
import type { ModerationImageSource } from './live-ports.ts';

/**
 * `read()` 的内部失败码闭集（**全部是既有契约错误码，不新造**：与 `ai/ocr-image-source.ts` 的
 * `OCR_IMAGE_FAILURE_CODES` / 识别侧的 `RECOGNITION_IMAGE_FAILURE_CODES` **逐字同集合**，
 * 三侧诊断口径因此可对读）。
 */
export const MODERATION_IMAGE_FAILURE_CODES = [
  'NOT_FOUND',
  'REVISION_CONFLICT',
  'OBJECT_UNAVAILABLE',
  'PROVIDER_UNAVAILABLE',
] as const;
export type ModerationImageFailureCode = (typeof MODERATION_IMAGE_FAILURE_CODES)[number];

/**
 * 允许喂给审核适配器的**对象 Content-Type**（只认适配器真正能解析的两种）。
 *
 * 口径来源：`moderation/live-vendor.ts` 的 `requireModerationImageBytes()` 只放行 PNG / JPEG 头部。
 * `image/webp` 是 `packages/media/constants.mjs` 的 `MEDIA_PURPOSE_MIME.community_image` 合法上传类型，
 * 但**不是**审核适配器可识别的类型 ⇒ 明确拒绝（测试逐条核对这份收窄关系，防止两处漂移）。
 */
export const MODERATION_IMAGE_CONTENT_TYPES = Object.freeze(['image/jpeg', 'image/png'] as const);

/**
 * 允许喂给审核适配器的媒体用途（**只取社区投稿图**）。
 *
 * 口径来源：审核域的图片引用只有一条真实来源 —— 社区投稿的 `media_ids`（`community/service.ts` 的
 * `mediaRefs()` / `mediaInputs()`）；社区取图路径本身也只接受 `purpose === 'community_image'`
 * （`media/service.ts:1378`）。`packages/media/constants.mjs` 的 `MEDIA_PURPOSES` 另三种
 * （`weed_recognition` / `label_ocr` / `voice_question`）各有自己的域，跨用途取值一律拒。
 */
export const MODERATION_IMAGE_PURPOSES = Object.freeze(['community_image'] as const);

/** 媒体登记册行的**只读取值面**（结构上即 `media/store.ts` 的 `MediaRecord`）。 */
export interface ModerationImageRecordView {
  /** 归属主体。本端口要求**非空**；装配层给了 `ownerUserId` 时必须一致。 */
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
export interface ModerationImageRegistry {
  getMedia(mediaId: string): Promise<ModerationImageRecordView | null>;
}

/**
 * 对象存储端口的**只读取值面**（结构上即 `media/object-store.ts` 的 `MediaObjectStore`）。
 *
 * `kind` 刻意声明为 `string`：本端口**不按 kind 放行**，只按注入者的显式选择工作。
 * 注入未接线端口时 `getObject` 会抛 `MediaError('PROVIDER_UNAVAILABLE')`，本文件**原样保留**该码
 * （与 `ai/ocr-image-source.ts` 对同一种异常的处理逐字相同）。
 */
export interface ModerationImageObjectStore {
  readonly kind: string;
  getObject(key: string): Promise<{ readonly bytes: Uint8Array; readonly contentType: string } | null>;
}

/** 三个注入端口；**前两个全部可缺**（缺即 fail-closed），第三个是可选的归属收窄。 */
export interface ModerationImagePorts {
  /** 媒体登记册（`media/store.ts` 的 `MediaStore`）。 */
  readonly mediaRecords?: ModerationImageRegistry | null;
  /** 对象存储端口（`media/object-store.ts` 的 `MediaObjectStore`）。 */
  readonly objectStore?: ModerationImageObjectStore | null;
  /** 可选：把可见媒体**钉死**在某一个归属主体上（给了就逐字比对；本片装配层不设它）。 */
  readonly ownerUserId?: string | null;
}

/**
 * 端口**取值器**：每次 `read()` 调用一次。
 *
 * 为什么是取值器而不是现成对象：`app.ts` 里审核域的服务装配（`createModerationService`）发生在媒体域
 * 两个端口解析**之前**，与识别域同形。取值器在读取时才调用，读到的是媒体域**既有**的那两个实例
 * （不新建存储、不读 env、不铸造批准能力）。
 */
export type ModerationImagePortsResolver = () => ModerationImagePorts | null | undefined;

/**
 * 真实字节来源：`ModerationImageSource` ＋ 三个**只读**诊断读数（不含图片内容、不含私有引用）。
 *
 * 适配器对外只会看见 `Uint8Array | null`；本片的失败码差异必须能被断言，否则「媒体缺失/版本不符/
 * 用途不符/端口未配置分别 fail-closed」就只是一句话而不是可复核的事实。
 */
export interface ObjectStoreModerationImageSource extends ModerationImageSource {
  /** 最近一次 `read()` 的失败码；成功为 `null`。**诊断用**（并发读时以最后一次为准）。 */
  lastFailure(): ModerationImageFailureCode | null;
  /** 最近一次 `read()` 的失败**原因**（不含对象键、不含字节）；成功为 `null`。**诊断用**。 */
  lastFailureReason(): string | null;
  /** 已尝试取值次数（诊断读数；不改变任何语义）。 */
  readonly readAttempts: number;
}

/** 端口是否齐备（缺哪个就点名哪个：运维照这句话补，不必读源码）。 */
function missingPorts(ports: ModerationImagePorts | null | undefined): string[] {
  const missing: string[] = [];
  if (ports === null || ports === undefined || ports.mediaRecords == null) missing.push('媒体登记册（mediaRecords）');
  if (ports === null || ports === undefined || ports.objectStore == null) missing.push('对象存储端口（objectStore）');
  return missing;
}

/** 端口抛出的错误里若带的是本闭集码，**原样保留**（例如未接线端口的 PROVIDER_UNAVAILABLE）。 */
function failureCodeOf(error: unknown, fallback: ModerationImageFailureCode): ModerationImageFailureCode {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && (MODERATION_IMAGE_FAILURE_CODES as readonly string[]).includes(code)) {
    return code as ModerationImageFailureCode;
  }
  return fallback;
}

/** `Content-Type` 归一：小写、去参数（`image/png; charset=binary` ⇒ `image/png`）；非字符串 ⇒ 空串。 */
function normalizeContentType(value: unknown): string {
  if (typeof value !== 'string') return '';
  const [base] = value.split(';');
  return (base ?? '').trim().toLowerCase();
}

/** 请求里带的版本是否**可用**（整数 ≥ 1）；`null` 表示"没钉版本"（见文件头「版本口径」）。 */
function usableRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** 取值器的安全包装：取值器自己抛错也按「端口未配置」fail-closed（绝不把异常抛进请求期）。 */
function safeResolve(resolver: ModerationImagePortsResolver): ModerationImagePorts | null {
  try {
    const resolved = resolver();
    return resolved === null || typeof resolved !== 'object' ? null : resolved;
  } catch {
    return null;
  }
}

/**
 * 由注入端口构造真实字节来源。**这是审核域字节端口的产品唯一构造器**
 * （`moderation/live-wiring.ts` 调它，再交给图片端口）。
 *
 * - 端口齐备 ⇒ `kind === 'wired'`，按 `media_id(+revision) → 登记册（归属/状态/用途/衍生件键）→
 *   对象存储` 取字节；任一环节不成立即 `null`（fail-closed），并在 `lastFailure()` 留下既有码。
 * - **本构造器不产出「未接线」形态**：缺端口由装配层落回 `createUnwiredModerationImageSource()`
 *   （"未接线"只有那一份实现）。取值器若在运行期给不出端口，`read()` 落 `PROVIDER_UNAVAILABLE`。
 */
export function createObjectStoreModerationImageSource(
  resolvePorts: ModerationImagePortsResolver,
): ObjectStoreModerationImageSource {
  if (typeof resolvePorts !== 'function') {
    const unwired = createUnwiredModerationImageSource('真实审核图片字节来源未接线：缺少端口取值器');
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

  let lastFailure: ModerationImageFailureCode | null = null;
  let lastReason: string | null = null;
  let attempts = 0;

  return {
    kind: 'wired',
    note:
      '真实审核图片字节来源：按 media_id(+revision) 读媒体登记册（归属/版本/状态/用途/衍生件键）→ 只从对象存储端口取'
      + '**去元数据衍生件** → 校验对象 Content-Type 在审核适配器可接受类型内；不读 ambient env、不回退磁盘默认路径、'
      + '不外发含元数据原件、不伪造字节（任一环节不成立即 fail-closed）',
    async read({ mediaId, mediaRevision }) {
      attempts += 1;
      const fail = (code: ModerationImageFailureCode, reason: string): null => {
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
      const mediaRecords = ports?.mediaRecords as ModerationImageRegistry;
      const objectStore = ports?.objectStore as ModerationImageObjectStore;

      // ① 引用形状：适配器已保证非空字符串，这里再钉一遍（诊断面不依赖上游的口径）。
      if (typeof mediaId !== 'string' || mediaId === '') return fail('NOT_FOUND', '媒体引用不合法（mediaId 为空）');

      // ② 媒体登记册：对象键、状态、用途、版本、归属都只从这一行取。
      let record: ModerationImageRecordView | null;
      try {
        record = await mediaRecords.getMedia(mediaId);
      } catch (error) {
        return fail(failureCodeOf(error, 'PROVIDER_UNAVAILABLE'), '媒体登记册读取失败');
      }
      if (record === null) return fail('NOT_FOUND', '媒体记录不存在');
      // ③ 归属：必须是**有主体**的私有媒体；给了 ownerUserId 就必须相符（越权与不存在同形）。
      if (typeof record.ownerId !== 'string' || record.ownerId === '') {
        return fail('NOT_FOUND', '媒体记录没有归属主体');
      }
      const pinnedOwner = ports?.ownerUserId;
      if (typeof pinnedOwner === 'string' && pinnedOwner !== '' && record.ownerId !== pinnedOwner) {
        return fail('NOT_FOUND', '媒体记录不存在');
      }
      // ④ 版本：给了就必须逐字相同；没给（社区送审载荷的常态）只读登记册当前版本，形状不合法一律拒。
      if (mediaRevision !== null) {
        if (!usableRevision(mediaRevision)) {
          return fail('REVISION_CONFLICT', `请求版本不合法（${String(mediaRevision)}）`);
        }
        if (record.revision !== mediaRevision) {
          return fail('REVISION_CONFLICT', `媒体版本已推进（登记 ${record.revision}，请求 ${mediaRevision}）`);
        }
      }
      // ⑤ 只有「已就绪」且「社区投稿图」用途的媒体可以送审（标签图/杂草图/录音都不是待审图片）。
      if (record.state !== 'ready') return fail('OBJECT_UNAVAILABLE', `媒体未就绪（state=${record.state}）`);
      if (!(MODERATION_IMAGE_PURPOSES as readonly string[]).includes(record.purpose)) {
        return fail('OBJECT_UNAVAILABLE', `媒体用途不是社区投稿图（purpose=${record.purpose}）`);
      }
      // ⑥ 对象键：只取**去元数据衍生件**；原件不出网（含 EXIF/GPS），缺失即 fail-closed。
      if (record.derivativeRef === null || record.derivativeRef === '') {
        return fail(
          'OBJECT_UNAVAILABLE',
          record.rawRef === null || record.rawRef === ''
            ? '媒体没有对象键（rawRef 与 derivativeRef 均为空）'
            : '媒体只有含元数据的原件（derivativeRef 为空）：按「原始对象不出网」不外发',
        );
      }

      // ⑦ 取字节：端口异常（含未接线端口的 PROVIDER_UNAVAILABLE）与对象缺失都 fail-closed。
      let object: Awaited<ReturnType<ModerationImageObjectStore['getObject']>>;
      try {
        object = await objectStore.getObject(record.derivativeRef);
      } catch (error) {
        return fail(failureCodeOf(error, 'OBJECT_UNAVAILABLE'), '对象存储取字节失败');
      }
      if (object === null) return fail('OBJECT_UNAVAILABLE', '对象存储里没有该对象');
      // ⑧ 不许交空字节包：空对象等于「没取到」，绝不能当成功数据往上交。
      if (object.bytes.length === 0) return fail('OBJECT_UNAVAILABLE', '对象字节为空');
      // ⑨ 类型可判：对象自带的 Content-Type 必须落在审核适配器真正能吃的类型内。
      const contentType = normalizeContentType(object.contentType);
      if (!(MODERATION_IMAGE_CONTENT_TYPES as readonly string[]).includes(contentType)) {
        return fail(
          'OBJECT_UNAVAILABLE',
          `对象 Content-Type 不在审核适配器可接受类型内（${contentType === '' ? '缺失' : contentType}）`,
        );
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
