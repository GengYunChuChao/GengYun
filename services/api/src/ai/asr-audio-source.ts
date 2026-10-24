/**
 * GY-I11 · 录音字节来源（**真实 `AudioSource`**）：按 `media_id` + `revision` 从对象存储端口取字节。
 *
 * ## 为什么需要这个文件
 * `SpeechProvider.transcribe({jobId, mediaId, mediaRevision})` 只带**引用**、不带录音字节
 * （服务层的媒体端口只回 `{ok, revision}`），字节必须由注入的 `AudioSource` 给
 * （见 `asr-live-ports.ts` 的 `AudioSource`）。在本次接线之前，产品装配注入的是
 * `createUnwiredAudioSource('真实对象存储未接线…')`：它**恒返回 `null`**，于是适配器
 * 永远落 `failed PROVIDER_UNAVAILABLE`，一个字节都发不出去。本文件是那份真实实现，
 * 把「一次转写该读哪一段录音」翻译成「对象存储里的哪一个对象」，并在翻译过程中完成三件
 * 不可让渡的事：
 *
 * 1. **归属校验**：先按 `jobId` 取任务快照（这次转写是谁授权的），再按 `mediaId` 取媒体
 *    登记册行（这段录音归谁所有），两者 owner 必须**逐字一致**；越权与不存在**同形**
 *    `NOT_FOUND`（不泄露"这个 mediaId 存在但属于别人"）。
 * 2. **版本一致**：请求的 `mediaRevision`、任务授权的 `mediaRevision`、登记册行的
 *    `revision` 三者一致；不一致 `REVISION_CONFLICT`（媒体域既有码）。
 * 3. **字节身份**：取回的对象必须与该媒体行登记的 `bytes` 与 `sha256` **逐字节一致**
 *    （`media/service.ts` 的 `completeUpload` 在落 `ready` 之前已用
 *    `assertBytesMatchDeclaration` 证明过这条不变量）。长度或哈希不符 ⇒ 视为**取错对象**
 *    ⇒ `OBJECT_UNAVAILABLE`；绝不把别的媒体/别的版本的字节喂给适配器。
 *
 * ## 硬性纪律（本文件自证）
 * - ⛔ 不读 ambient env、⛔ 不回退磁盘默认路径、⛔ 不产生任何「猜的」字节：本文件
 *   **不 import `node:fs`**、**不出现 `process.env`**（`tests/unit/i11-audio-source-wiring.test.mjs`
 *   直接读本文件源码逐条断言）。字节的唯一来源是注入的对象存储端口。
 * - ⛔ 不新造错误码：`read()` 的内部失败码全部是契约 `ErrorCode` 闭集成员
 *   （`NOT_FOUND` / `REVISION_CONFLICT` / `OBJECT_UNAVAILABLE` / `PROVIDER_UNAVAILABLE`）。
 * - ⛔ 不静默成功：任一环节不成立一律 `read() → null`，由适配器按既有口径落
 *   `failed PROVIDER_UNAVAILABLE`（未发包、不占预算）；**绝不返回空字节或占位音频**。
 * - 端口未配置（缺归属源 / 登记册 / 对象存储）⇒ 复用 `createUnwiredAudioSource()`
 *   —— **「未接线」只有那一份实现**，`kind === 'unwired'` 且恒 `null`。它不是替身：
 *   它不产出任何字节。
 *
 * ## 失败语义对照表（内部码 → 对外结局）
 * | 触发条件 | `lastFailure()` | 适配器对外 |
 * | --- | --- | --- |
 * | 端口未配置（缺归属源/登记册/对象存储） | `PROVIDER_UNAVAILABLE` | `failed PROVIDER_UNAVAILABLE`，零发包 |
 * | 任务不存在 / 请求的媒体 ≠ 任务授权媒体 / 媒体不属于任务 owner | `NOT_FOUND` | 同上 |
 * | 任务授权 revision ≠ 请求 / 登记册 revision 已推进 | `REVISION_CONFLICT` | 同上 |
 * | 媒体未就绪 / 用途不是音频 / 无对象键 / 对象不存在 / 端口异常 / 字节与登记册不符 | `OBJECT_UNAVAILABLE` | 同上 |
 *
 * 为什么内部码**不**直接改变对外结局：适配器把「本地拒绝」统一映射成
 * `PROVIDER_UNAVAILABLE` 是既有红线（`tests/unit/ai-live-provider-wiring.test.mjs` 的
 * 「取不到字节 ⇒ PROVIDER_UNAVAILABLE、零预留、零发包」与
 * `tests/unit/i11-audio-mp3-wav-guard.test.mjs` 的 MP3 案例逐字钉住），本片一个字都不放宽。
 * 内部码只作**诊断**：不落库、不含任何私有引用、不含录音内容。
 */
import { createHash } from 'node:crypto';

import { createUnwiredAudioSource } from './asr-live-adapter.ts';
import type { AudioSource } from './asr-live-ports.ts';

/**
 * `read()` 的内部失败码闭集（**全部是既有契约错误码，不新造**）。
 *
 * `PROVIDER_UNAVAILABLE` 在这里特指**能力未接线**（端口未配置），与媒体域
 * `createUnwiredObjectStore` 的 503 同一语义；它**不是**「供应商故障」——
 * 端口未配置时适配器连预留都不会做。
 */
export const SPEECH_AUDIO_FAILURE_CODES = [
  'NOT_FOUND',
  'REVISION_CONFLICT',
  'OBJECT_UNAVAILABLE',
  'PROVIDER_UNAVAILABLE',
] as const;
export type SpeechAudioFailureCode = (typeof SPEECH_AUDIO_FAILURE_CODES)[number];

/**
 * 允许喂给 ASR 的媒体用途（**只取音频类**）。
 *
 * 口径来源：`packages/media/constants.mjs` 的 `MEDIA_PURPOSE_KIND` 里值为 `'audio'` 的全部
 * 条目 —— 当前唯一一条是 `voice_question`（`MEDIA_PURPOSE_MIME.voice_question` =
 * `audio/mpeg|wav|aac`）。图片用途（`weed_recognition` / `label_ocr` / `community_image`）
 * **一律拒绝**：识别照片不是录音，把它当字节喂给 ASR 属于跨用途取值。
 * 测试直接读 `packages/media` 逐条核对本常量，防止两处漂移。
 */
export const SPEECH_AUDIO_PURPOSES = Object.freeze(['voice_question'] as const);

/** 转写任务的**归属源**（结构上即 `speech/store.ts` 的 `SpeechStore.getJob`）。 */
export interface SpeechJobOwnerSource {
  getJob(jobId: string): Promise<{
    readonly ownerUserId: string;
    readonly mediaId: string;
    readonly mediaRevision: number;
  } | null>;
}

/** 媒体登记册行的**只读取值面**（结构上即 `media/store.ts` 的 `MediaRecord`）。 */
export interface SpeechRecordingRecord {
  readonly ownerId: string;
  readonly revision: number;
  readonly state: string;
  readonly purpose: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly rawRef: string | null;
}

/** 媒体登记册（结构上即 `media/store.ts` 的 `MediaStore.getMedia`）。 */
export interface SpeechRecordingRegistry {
  getMedia(mediaId: string): Promise<SpeechRecordingRecord | null>;
}

/**
 * 对象存储端口的**只读取值面**（结构上即 `media/object-store.ts` 的 `MediaObjectStore`）。
 *
 * `kind` 刻意声明为 `string`：本端口**不按 kind 放行**，只按注入者的显式选择工作
 * （判据是"装配层注入了哪个端口"，不是一个自述布尔标志）。注入未接线端口时
 * `getObject` 会抛 `MediaError('PROVIDER_UNAVAILABLE')`，本文件原样保留该码。
 */
export interface SpeechAudioObjectStore {
  readonly kind: string;
  getObject(key: string): Promise<{ readonly bytes: Uint8Array; readonly contentType: string } | null>;
}

/** `createObjectStoreAudioSource()` 的三个注入端口；**全部可缺**（缺即 fail-closed）。 */
export interface ObjectStoreAudioSourceOptions {
  /** 转写任务归属源（`speech/store.ts` 的 `SpeechStore`）。 */
  readonly jobs?: SpeechJobOwnerSource | null;
  /** 媒体登记册（`media/store.ts` 的 `MediaStore`）。 */
  readonly mediaRecords?: SpeechRecordingRegistry | null;
  /** 对象存储端口（`media/object-store.ts` 的 `MediaObjectStore`）。 */
  readonly objectStore?: SpeechAudioObjectStore | null;
}

/**
 * 真实录音字节来源：`AudioSource` ＋ 两个**只读**诊断读数（不含录音内容、不含私有引用）。
 *
 * `lastFailure()` / `readAttempts` 是给证据与测试用的：适配器对外只会看见
 * `Uint8Array | null`，本片的失败码差异必须能被断言，否则「媒体缺失/未授权/端口未配置
 * 分别 fail-closed」就只是一句话而不是可复核的事实。
 */
export interface ObjectStoreAudioSource extends AudioSource {
  /** 最近一次 `read()` 的失败码；成功为 `null`。**诊断用**（并发读时以最后一次为准）。 */
  lastFailure(): SpeechAudioFailureCode | null;
  /** 已尝试取值次数（诊断读数；不改变任何语义）。 */
  readonly readAttempts: number;
}

/** 端口是否齐备（缺哪个就点名哪个：运维照这句话补，不必读源码）。 */
function missingPorts(options: ObjectStoreAudioSourceOptions): string[] {
  const missing: string[] = [];
  if (options.jobs == null) missing.push('转写任务归属源（jobs）');
  if (options.mediaRecords == null) missing.push('媒体登记册（mediaRecords）');
  if (options.objectStore == null) missing.push('对象存储端口（objectStore）');
  return missing;
}

/** 端口抛出的错误里若带的是本闭集码，**原样保留**（例如未接线端口的 PROVIDER_UNAVAILABLE）。 */
function failureCodeOf(error: unknown, fallback: SpeechAudioFailureCode): SpeechAudioFailureCode {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && (SPEECH_AUDIO_FAILURE_CODES as readonly string[]).includes(code)) {
    return code as SpeechAudioFailureCode;
  }
  return fallback;
}

/** 与 `packages/media/validate.mjs` 的 `sha256Hex()` 同算法（sha256、小写 hex）。 */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 由注入的端口构造录音字节来源。**这是产品装配的唯一构造器**
 * （`services/api/src/speech/provider.ts` 的 `createSpeechProvider()` 调用它）。
 *
 * - 端口齐备 ⇒ `kind === 'wired'`，按 `jobId → 归属 → media_id+revision → 登记册 → 对象存储`
 *   取字节；任一环节不成立即 `null`（fail-closed），并在 `lastFailure()` 留下既有码。
 * - 端口缺失 ⇒ `kind === 'unwired'`（`createUnwiredAudioSource()`），恒 `null`：
 *   **能力未接线**，不是替身、不产字节。
 */
export function createObjectStoreAudioSource(options: ObjectStoreAudioSourceOptions = {}): ObjectStoreAudioSource {
  const missing = missingPorts(options);
  let unwiredAttempts = 0;
  if (missing.length > 0) {
    const unwired = createUnwiredAudioSource(`真实录音字节来源未接线：缺 ${missing.join('、')}`);
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
      get readAttempts() {
        return unwiredAttempts;
      },
    };
  }

  const jobs = options.jobs as SpeechJobOwnerSource;
  const mediaRecords = options.mediaRecords as SpeechRecordingRegistry;
  const objectStore = options.objectStore as SpeechAudioObjectStore;
  let lastFailure: SpeechAudioFailureCode | null = null;
  let attempts = 0;

  return {
    kind: 'wired',
    note:
      '真实录音字节来源：按 jobId 取任务归属 → 校验 media_id+revision → 读媒体登记册（owner/revision/state/用途）' +
      ' → 从对象存储端口取对象 → 长度与 sha256 必须与登记册一致；' +
      '不读 ambient env、不回退磁盘默认路径、不伪造字节（任一环节不成立即 fail-closed）',
    async read({ jobId, mediaId, mediaRevision }) {
      attempts += 1;
      const fail = (code: SpeechAudioFailureCode): null => {
        lastFailure = code;
        return null;
      };

      // ① 归属源：拿不到「谁授权的这次转写」就不取字节（越权与不存在同形）。
      let job: Awaited<ReturnType<SpeechJobOwnerSource['getJob']>>;
      try {
        job = await jobs.getJob(jobId);
      } catch (error) {
        return fail(failureCodeOf(error, 'PROVIDER_UNAVAILABLE'));
      }
      if (job === null) return fail('NOT_FOUND');
      // ② 任务授权的引用必须与请求逐字一致：适配器不得凭一次授权去读**另一段**录音。
      if (job.mediaId !== mediaId) return fail('NOT_FOUND');
      if (job.mediaRevision !== mediaRevision) return fail('REVISION_CONFLICT');

      // ③ 媒体登记册：对象键、归属、状态、用途、字节身份都只从这一行取。
      let record: SpeechRecordingRecord | null;
      try {
        record = await mediaRecords.getMedia(mediaId);
      } catch (error) {
        return fail(failureCodeOf(error, 'PROVIDER_UNAVAILABLE'));
      }
      if (record === null) return fail('NOT_FOUND');
      // ④ **归属校验**：录音必须属于同一次转写的主人（越权与不存在同形，不泄露存在性）。
      if (record.ownerId !== job.ownerUserId) return fail('NOT_FOUND');
      // ⑤ 版本一致：请求的 revision、任务授权的、登记册当前的三者相同。
      if (record.revision !== mediaRevision) return fail('REVISION_CONFLICT');
      // ⑥ 只有「已就绪」且「音频用途」的媒体可以喂给 ASR（照片不是录音）。
      if (record.state !== 'ready') return fail('OBJECT_UNAVAILABLE');
      if (!(SPEECH_AUDIO_PURPOSES as readonly string[]).includes(record.purpose)) return fail('OBJECT_UNAVAILABLE');
      // ⑦ 对象键：录音取**原始对象**（音频没有去元数据的衍生物）；缺失即 fail-closed。
      if (record.rawRef === null || record.rawRef === '') return fail('OBJECT_UNAVAILABLE');

      // ⑧ 取字节：端口异常（含未接线端口的 PROVIDER_UNAVAILABLE）与对象缺失都 fail-closed。
      let object: Awaited<ReturnType<SpeechAudioObjectStore['getObject']>>;
      try {
        object = await objectStore.getObject(record.rawRef);
      } catch (error) {
        return fail(failureCodeOf(error, 'OBJECT_UNAVAILABLE'));
      }
      if (object === null) return fail('OBJECT_UNAVAILABLE');

      // ⑨ 字节身份：长度与 sha256 必须正是该媒体行登记过的那一份，否则视为取错对象。
      if (object.bytes.length !== record.bytes) return fail('OBJECT_UNAVAILABLE');
      if (sha256Hex(object.bytes) !== record.sha256) return fail('OBJECT_UNAVAILABLE');

      lastFailure = null;
      return object.bytes;
    },
    lastFailure() {
      return lastFailure;
    },
    get readAttempts() {
      return attempts;
    },
  };
}
