/**
 * GY-I11 录音转写任务的媒体引用校验端口。
 *
 * `POST /speech/transcriptions` 的 body 是 `MediaJobInput{media_id, media_revision}`，因此服务端
 * 必须在受理前确认该私有媒体（**普通话录音**）属于调用者且版本一致，否则不得创建任务。
 *
 * ## 三种端口（`kind` 即身份，不靠布尔自述标志）
 *
 * | kind | 何时使用 | 行为 |
 * | --- | --- | --- |
 * | `substitute` | `stub` / `preset_demo` | 明确标注的替身：任意合法 uuid 视为调用者名下、已就绪、版本一致；不上传、不读字节、不校验归属 |
 * | `real` | `real` **且**真实媒体端口齐备且媒体域本身已打开（见下） | 按 `media_id` 读**真实媒体登记册**（`MediaStore`），校验归属/版本/状态/用途/对象键 |
 * | `unwired` | 其余一切情形（含 `real` 缺任一条件） | 一律 `OBJECT_UNAVAILABLE`（409），fail-closed，不泄露媒体是否存在 |
 *
 * ## `real` 分支的四道门（缺任一条 ⇒ 仍是 `unwired` ⇒ 受理仍 409）
 *
 * 本文件**不接受**任何「布尔开关 / 自述已接线」的办法放行；判定全是端口身份与既有裁决：
 *
 * 1. **对象存储端口必须是真实适配器**（`kind === 's3_compatible'`）。替身（`substitute`）与未接线
 *    （`unwired`）端口一律拒绝 —— 与 `media/service.ts` 的 `createMediaRealPorts` 同一判据。
 *    产品装配里这个端口**只可能**由 `--approve-real-media-wiring` 启动参数 + `OBJECT_STORAGE_*`
 *    四键齐备经 `media/real-ports.ts#resolveMediaRealPorts` 铸造后显式注入（`app.ts` 不做
 *    ambient env 门控）；因此「没带启动参数」或「env 缺键」都落回 `unwired` ⇒ 409。
 * 2. **媒体域本身的构造期裁决必须是「已打开」**（`AppMediaService.failClosedReason === null`）。
 *    媒体域的主闸门是**运行期构造期批准能力**（`approveRealMediaWiring()` 铸造、`WeakSet` 品牌，
 *    见 `media/service.ts`）。本域**不重复解释配置、也不自行铸造**：直接沿用媒体域已经做过的裁决
 *    ⇒ 谁把「真实对象存储端口」硬塞进装配而没走批准能力，媒体域会整域 503，本域也随之 409
 *    （不会出现「媒体域拒绝、转写域却放行」的错位）。
 * 3. **媒体登记册端口必须存在**（`MediaStore`）：归属与版本只能从它读。
 * 4. 单次 `resolve()` 还要逐条成立：行存在 / `ownerId` 逐字相等 / `revision` 逐字相等 /
 *    `state === 'ready'` / 用途是音频类 / `rawRef` 非空。任一不成立即按既有闭集码拒绝
 *    （`NOT_FOUND` 与越权**同形**，不泄露存在性）。
 *
 * ## 本端口**不**做两件事（如实登记的边界）
 *
 * - ⛔ **不取录音字节、不核 `sha256`**：受理期只做「这条引用能不能建任务」的判定；真正的字节
 *   读取与「长度 + sha256 必须与登记册逐字节一致」由已交付的 `ai/asr-audio-source.ts`
 *   （`createObjectStoreAudioSource`）在转写期完成，不成立即 `failed PROVIDER_UNAVAILABLE`、零发包。
 *   在此再 `getObject()` 一次会把整段录音下载两遍（受理一遍、转写一遍），在真实计费桶上纯属浪费。
 * - ⛔ **不读 ambient env、不碰文件系统、不新造错误码**：端口唯一来源是注入；拒绝码全部是契约
 *   `ErrorCode` 闭集成员（`NOT_FOUND` / `REVISION_CONFLICT` / `OBJECT_UNAVAILABLE`）。
 *
 * ## 现状（本片之后）
 *
 * `real` 不再恒 409：带上 `--approve-real-media-wiring` 且对象存储四键、`MEDIA_ACCESS_GRANT_ORIGIN`、
 * `MEDIA_OBJECT_REF_KEY` 齐备时，媒体域 7 条路由与转写受理同时可用。缺任一条件 ⇒ 媒体域仍整域
 * 503 `PROVIDER_UNAVAILABLE`、受理仍 409 `OBJECT_UNAVAILABLE`，且零字节写入真实桶。
 */
import { SPEECH_AUDIO_PURPOSES } from '../ai/asr-audio-source.ts';

export type MediaResolutionCode = 'NOT_FOUND' | 'REVISION_CONFLICT' | 'OBJECT_UNAVAILABLE';

export type MediaResolution = { ok: true; revision: number } | { ok: false; code: MediaResolutionCode };

export interface SpeechMediaPort {
  /** 端口类型：substitute=替身（stub/preset_demo）、real=真实登记册校验、unwired=未接线（fail-closed）。 */
  readonly kind: 'substitute' | 'real' | 'unwired';
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
 * 未接线端口：本域**未接真实对象存储/媒体域未打开**时使用（real 模式）。一律 `OBJECT_UNAVAILABLE`，
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

// ---------------------------------------------------------------- 真实端口

/**
 * 媒体登记册的**只读取值面**（结构上即 `media/store.ts` 的 `MediaStore.getMedia`，
 * 也被 `ai/asr-audio-source.ts` 的 `SpeechRecordingRegistry` 满足）。
 *
 * 只声明本端口真正用到的 5 个字段：不复制整行结构，也不给登记册加写面。
 */
export interface SpeechMediaRecordView {
  readonly ownerId: string;
  readonly revision: number;
  readonly state: string;
  readonly purpose: string;
  readonly rawRef: string | null;
}

export interface SpeechMediaRegistry {
  getMedia(mediaId: string): Promise<SpeechMediaRecordView | null>;
}

/** 对象存储端口的**身份面**：本端口只判 `kind`，取值一律由登记册与转写期字节来源负责。 */
export interface SpeechMediaObjectStoreIdentity {
  readonly kind: string;
}

/**
 * `real` 分支的接线输入（**全部必填**，缺即拒绝；没有默认值可以「碰巧」接上真实存储）。
 */
export interface SpeechMediaPortWiring {
  /** 媒体域的对象存储端口（产品装配里即 `app.mediaObjectStore` 经 `speechAudioMedia` 转发的那一个）。 */
  readonly objectStore: SpeechMediaObjectStoreIdentity | null;
  /** 媒体登记册（`media/store.ts` 的 `MediaStore`）。 */
  readonly mediaRecords: SpeechMediaRegistry | null;
  /**
   * 媒体域的构造期裁决（`AppMediaService.failClosedReason`）：`null` = 媒体域已打开（真实端口 +
   * 已铸造的批准能力 + 可持久化）；非 `null` = 媒体域整域关闭，本域必须同形关闭。
   */
  readonly mediaDomainRefusal: string | null;
}

/** `real` 分支的拒绝原因（闭集；只进 `note` 与诊断，不新造对外错误码）。 */
export const SPEECH_MEDIA_REAL_REFUSALS = [
  /** 对象存储端口缺失或不是 S3 兼容真实适配器（替身/未接线端口不得冒充）。 */
  'object_store_not_wired',
  /** 媒体域构造期裁决为「关闭」（缺批准能力 / 缺持久化）：本域随之关闭，不各自解释配置。 */
  'media_domain_closed',
  /** 缺媒体登记册：无法校验归属与版本。 */
  'media_registry_not_configured',
] as const;

export type SpeechMediaRealRefusal = (typeof SPEECH_MEDIA_REAL_REFUSALS)[number];

const REFUSAL_REASONS: Record<SpeechMediaRealRefusal, string> = {
  // 与 `createUnwiredMediaPort()` 的默认文案**逐字相同**：默认 real 装配（未接线）的运行期
  // `note` 因此与本片之前逐字一致（`tests/unit/runtime-strings-truth.test.mjs` 逐字钉住）。
  object_store_not_wired: '媒体 HTTP 路由已注册，但未接真实对象存储：无法读取私有录音字节',
  media_domain_closed:
    '真实对象存储端口已注入，但媒体域仍整域关闭（缺少 approveRealMediaWiring() 铸造的显式批准能力，或缺持久化）：录音引用不可校验',
  media_registry_not_configured: '媒体登记册端口未配置：无法校验录音归属与版本',
};

/**
 * 判定 `real` 分支是否可接真实端口；返回 `null` 表示**可以**，否则返回闭集里的拒绝原因。
 *
 * 顺序固定（便于判据逐条断言）：对象存储身份 → 媒体域裁决 → 登记册。
 * 首条故意排在媒体域裁决之前：默认 `real` 装配（零注入）下对象存储就是 `unwired` 端口 ⇒
 * 命中 `object_store_not_wired` ⇒ `note` 与本片之前**逐字相同**。
 */
export function speechMediaRealRefusal(wiring: SpeechMediaPortWiring | undefined): SpeechMediaRealRefusal | null {
  if (wiring === undefined) return 'object_store_not_wired';
  const { objectStore, mediaDomainRefusal, mediaRecords } = wiring;
  if (objectStore === null || objectStore.kind !== 's3_compatible') return 'object_store_not_wired';
  if (mediaDomainRefusal !== null) return 'media_domain_closed';
  if (mediaRecords === null) return 'media_registry_not_configured';
  return null;
}

/** 登记册读取异常 ⇒ 既有闭集码（保守：按「对象状态不允许」拒绝，不新建码、不放行）。 */
function resolutionCodeOf(error: unknown): MediaResolutionCode {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'NOT_FOUND' || code === 'REVISION_CONFLICT' || code === 'OBJECT_UNAVAILABLE') return code;
  return 'OBJECT_UNAVAILABLE';
}

const REAL_NOTE =
  '真实录音引用端口（real）：按 media_id 读媒体登记册，逐条校验归属、版本、就绪状态、音频用途与对象键；' +
  '越权与不存在同形 NOT_FOUND；不读 ambient env、不取录音字节（字节与 sha256 由转写期 AudioSource 校验）';

/**
 * 真实媒体引用端口（`real`）：只读媒体登记册做受理期判定。
 *
 * 调用前必须已由 {@link speechMediaRealRefusal} 判定 `null`（本函数自身不再重复判定，
 * 以便调用方在拒绝时用闭集原因生成 `note`）。
 */
export function createRealMediaPort(wiring: SpeechMediaPortWiring): SpeechMediaPort {
  const mediaRecords = wiring.mediaRecords as SpeechMediaRegistry;
  return {
    kind: 'real',
    note: REAL_NOTE,
    async resolve({ ownerUserId, mediaId, mediaRevision }) {
      // ① 服务层已校验正整数；这里再判一次形状（不信任上游，形状不合法即版本冲突）。
      if (!Number.isInteger(mediaRevision) || mediaRevision < 1) return { ok: false, code: 'REVISION_CONFLICT' };

      // ② 登记册：归属、版本、状态、用途、对象键的唯一事实源。
      let record: SpeechMediaRecordView | null;
      try {
        record = await mediaRecords.getMedia(mediaId);
      } catch (error) {
        // 登记册读不起来 ⇒ 保守拒绝（不泄露「行是否存在」，也不算「不存在」）。
        return { ok: false, code: resolutionCodeOf(error) };
      }
      if (record === null) return { ok: false, code: 'NOT_FOUND' };

      // ③ 归属：越权与不存在**同形**（不泄露「这个 mediaId 存在但属于别人」）。
      if (record.ownerId !== ownerUserId) return { ok: false, code: 'NOT_FOUND' };
      // ④ 版本：请求的 revision 必须就是登记册当前 revision。
      if (record.revision !== mediaRevision) return { ok: false, code: 'REVISION_CONFLICT' };
      // ⑤ 只有「已就绪」的媒体可以建转写任务（initiated/processing/rejected/deleted 一律拒绝）。
      if (record.state !== 'ready') return { ok: false, code: 'OBJECT_UNAVAILABLE' };
      // ⑥ 用途必须是音频类：照片（`label_ocr` 等）不是录音，不得建成转写任务。
      if (!(SPEECH_AUDIO_PURPOSES as readonly string[]).includes(record.purpose)) {
        return { ok: false, code: 'OBJECT_UNAVAILABLE' };
      }
      // ⑦ 对象键必须在：没有键就没有「这份录音」，建任务等于建一个必然失败的任务。
      if (record.rawRef === null || record.rawRef === '') return { ok: false, code: 'OBJECT_UNAVAILABLE' };

      return { ok: true, revision: record.revision };
    },
  };
}

// ---------------------------------------------------------------- 装配

/**
 * 按执行模式选择媒体端口。
 *
 * - 非 `real` ⇒ 明确标注的替身（**不接受**接线输入，行为与之前逐字一致）。
 * - `real` + {@link speechMediaRealRefusal} 拒绝 ⇒ `unwired`（fail-closed，`note` 由闭集原因生成）。
 * - `real` + 四道门全过 ⇒ {@link createRealMediaPort}。
 *
 * `wiring` 可缺省：缺省等价于「一个端口都没配」⇒ `unwired`，这正是本片之前的默认结局。
 */
export function createSpeechMediaPort(executionMode: string, wiring?: SpeechMediaPortWiring): SpeechMediaPort {
  if (executionMode !== 'real') return createSubstituteMediaPort();
  const refusal = speechMediaRealRefusal(wiring);
  if (refusal !== null) return createUnwiredMediaPort(REFUSAL_REASONS[refusal]);
  return createRealMediaPort(wiring as SpeechMediaPortWiring);
}
