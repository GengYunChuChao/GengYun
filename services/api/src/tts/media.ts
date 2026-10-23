/**
 * GY-I13 普通话 TTS 合成域 · 合成产物（媒体）落库端口。
 *
 * 三种端口，**按 `kind` 显式区分**（与 `media/object-store.ts` 同一口径）：
 *
 * | kind | 何时使用 | 行为 |
 * | --- | --- | --- |
 * | `substitute` | `stub` / `preset_demo` | **明确标注的替身产物存储**：只登记「标注产物」的内容类型与字节长度，正文是明文标注，**不是音频**、**不可播放** |
 * | `unwired` | `real` 且**未显式注入**批准能力（或未注入 `s3_compatible` 端口） | 一律 `OBJECT_UNAVAILABLE`（fail-closed），绝不「本地兜底」伪造一个 media_id |
 * | `s3_compatible` | `real` ＋ **显式注入**的批准能力 ＋ **显式注入**且已构造的 `MediaObjectStore` | 复用媒体域的对象存储适配器写**真实音频字节**；键规则与媒体域一致（`newObjectRef()`） |
 *
 * ## 本片接了什么、没接什么（如实）
 *
 * **接上的**：`real` 下第一次存在**可构造**的真实产物存储端口。它**复用**媒体域既有的对象存储实现
 * （`services/api/src/media/object-store.ts` 的 `MediaObjectStore`；⛔ 本文件不新写第二套 S3/OSS
 * 客户端、不自己拼 URL/签名），键名走媒体域同一条规则 `newObjectRef()`（不透明 `obj_` 引用，
 * ⛔ 不自造 `tts/…` 之类的路径前缀 —— 私有对象的桶路径不外露是媒体域的红线）。
 *
 * **闸门**：真实端口**只能**由调用方**显式注入**一个批准对象（
 * {@link approveRealSynthesisMediaWiring} 铸造，形状照抄媒体域 #193 的 `RealMediaWiringApproval`：
 * 模块私有 `WeakSet` 认**对象身份**，形状相同／派生／`Proxy`／JSON 往返副本一律无效）才能构造；
 * 未注入 ⇒ 仍是 `unwired`（`put` → `OBJECT_UNAVAILABLE`）。**`env` 只可能是解析输入，绝不是开启
 * 依据**：{@link createSynthesisMediaPort} 不读 `process.env`、也不把任何 `env` 记录折算成端口
 * （媒体域 #193 的 P1：那 4 个 `OBJECT_STORAGE_*` 键正是 `real` 的启动必填项 ⇒「传 env 就能开」
 * 等于**配置即门控**）。
 *
 * **未接的（不得据本文件声称已具备）**：真实 COS/S3 桶往返、真实 TTS 供应商音频、真机播放、
 * 30 段真实 TTS 评估；产物**删除/回收**路径；`media_id` ↔ 对象键索引的**可恢复化**（本文件用进程内
 * `Map`，与 `tts/store.ts` 的内存作业 store 同口径 ⇒ **重启后索引即丢、对象变孤儿**）。
 * 详见 `docs/verification/gy-r34-i13-tts-media-store-20261023.md`。
 *
 * 存储边界上的**防御性不变量**（纵深防御，服务层已先校验一次）：
 * - 替身端口拒绝「标注为替身却是 `audio/*`」「替身正文带 MP3/ID3 头」的对象 —— 替身不得伪装成真实音频；
 * - 真实端口拒绝替身产物、拒绝「声明 `audio/mpeg` 却没有 MPEG/ID3 头」的字节 —— 不把错误 JSON/HTML
 *   当音频落库，也不让替身占位冒充真实产物。
 */

import { randomUUID } from 'node:crypto';
import type { ErrorCode } from '../contract.ts';
import type { MediaObjectStore } from '../media/object-store.ts';
import type { SynthesisArtifact } from './state.ts';
import { newObjectRef } from '../../../../packages/media/index.mjs';

export type MediaPutResult = { ok: true; mediaId: string } | { ok: false; code: ErrorCode };

/** 产物标注（不含正文）：替身端口登记标注，真实端口登记对象键的**可公开摘要**。 */
export interface SynthesisMediaObjectSummary {
  contentType: string;
  byteLength: number;
  /** true = 替身标注产物（非音频、不可播放）；false = 真实对象存储里的音频。 */
  substitute: boolean;
  note: string;
}

/** 替身产物对象（只登记标注，不含音频字节）。 */
export interface SubstituteMediaObject extends SynthesisMediaObjectSummary {
  mediaId: string;
  ownerUserId: string;
  synthesisId: string;
  substitute: true;
}

/** 读回结果（真实端口）：字节 + 内容类型。**不含**任何桶名、对象键或供应商信息。 */
export interface StoredSynthesisArtifact {
  bytes: Uint8Array;
  contentType: string;
  byteLength: number;
}

export interface SynthesisMediaPort {
  /**
   * 端口类型：`substitute`=替身标注存储（stub/preset_demo）、`unwired`=未接线（real 的默认装配，
   * fail-closed）、`s3_compatible`=真实对象存储（仅当显式注入批准能力 + 真实端口时可构造）。
   */
  readonly kind: 'substitute' | 'unwired' | 's3_compatible';
  /** 供证据文档／诊断引用的如实标注（不含任何音频字节或私有媒体）。 */
  readonly note: string;
  put(input: { ownerUserId: string; synthesisId: string; artifact: SynthesisArtifact }): Promise<MediaPutResult>;
  exists(mediaId: string): Promise<boolean>;
  /** 供诊断：该 media_id 指向的产物标注（不含正文）。 */
  describeObject(mediaId: string): Promise<SynthesisMediaObjectSummary | null>;
}

/**
 * **读回端口**（只有真实端口提供；替身/未接线端口没有字节可读）。
 *
 * 服务端/测试专用：不进任何响应投影、不进日志（与媒体域 `serverObjectKeys` 同口径）。
 * 当前**没有** HTTP 读面（契约里没有「取合成音频字节」的 operation）⇒ 它只用于
 * 「字节确实落进了对象存储」的逐字节自证，以及将来的播放面接线。
 */
export interface SynthesisMediaReadPort {
  /**
   * 读回字节。`null` = 索引里没有该 media_id，或对象键已不在（被外部删除）——
   * 如实返回「没有」，⛔ 不伪造字节。存储故障/超时**抛出**（调用方必须区分「没有」与「读不到」）。
   */
  readArtifact(mediaId: string): Promise<StoredSynthesisArtifact | null>;
  /** 服务端/测试诊断：该 media_id 的对象键（与媒体域同一规则；不进入响应/日志）。 */
  objectKeyFor(mediaId: string): string | null;
}

const SUBSTITUTE_NOTE =
  '替身产物存储（stub/preset_demo）：只登记**非音频**标注产物；不接真实对象存储、不写入任何真实音频、不接受真实音频上传。';

/**
 * 字节是否带 MPEG/ID3 头（`ID3` 标签 或 MPEG 帧同步 `0xFF 0xEx`）。
 * 两处用它：替身存储拒绝「伪装成真实音频的替身」，真实端口拒绝「把错误 JSON/HTML 当音频落库」。
 * 这是**头部嗅探**，不是完整解码器，也不构成任何音频质量结论。
 */
export function hasMpegAudioHeader(body: Uint8Array): boolean {
  if (body.byteLength >= 3 && body[0] === 0x49 && body[1] === 0x44 && body[2] === 0x33) return true; // 'ID3'
  if (body.byteLength >= 2 && body[0] === 0xff && (body[1]! & 0xe0) === 0xe0) return true; // MPEG 帧同步
  return false;
}

// ------------------------------------------------------------------ 替身端口

/**
 * 替身产物存储：明确标注、确定性、**不含音频**。
 * 拒绝条件（返回契约错误码，不静默接受）：
 * - `substitute === false`（真实产物）⇒ `OBJECT_UNAVAILABLE`：替身存储绝不接收真实音频
 *   （否则「真实存储已接线」会看起来成立）；真实产物请走 `s3_compatible` 端口；
 * - `audio/*` 且 `substitute=true` ⇒ `MEDIA_TYPE_UNSUPPORTED`（替身不得伪装成真实音频）；
 * - 替身正文带 MP3/ID3 头 ⇒ `MEDIA_TYPE_UNSUPPORTED`（纵深防御）。
 */
export function createSubstituteMediaPort(options: { idFactory?: () => string } = {}): SynthesisMediaPort {
  const objects = new Map<string, SubstituteMediaObject>();
  let counter = 0;
  const nextId =
    options.idFactory ??
    ((): string => {
      counter += 1;
      // 确定性 uuid（v4 形状）：替身存储不需要随机性，测试可完全复现。
      const hex = counter.toString(16).padStart(12, '0');
      return `00000000-0000-4000-8000-${hex}`;
    });

  return {
    kind: 'substitute',
    note: SUBSTITUTE_NOTE,
    async put({ ownerUserId, synthesisId, artifact }) {
      if (!artifact.substitute) {
        // 真实合成产物需要**真实**对象存储；替身存储绝不把它记成替身对象。
        return { ok: false, code: 'OBJECT_UNAVAILABLE' };
      }
      if (artifact.contentType.toLowerCase().startsWith('audio/')) {
        return { ok: false, code: 'MEDIA_TYPE_UNSUPPORTED' };
      }
      if (hasMpegAudioHeader(artifact.body)) {
        return { ok: false, code: 'MEDIA_TYPE_UNSUPPORTED' };
      }
      const mediaId = nextId();
      objects.set(mediaId, {
        mediaId,
        ownerUserId,
        synthesisId,
        contentType: artifact.contentType,
        byteLength: artifact.body.byteLength,
        substitute: true,
        note: '替身标注产物（非真实音频、不可播放）',
      });
      return { ok: true, mediaId };
    },
    async exists(mediaId) {
      return objects.has(mediaId);
    },
    async describeObject(mediaId) {
      const object = objects.get(mediaId);
      if (object === undefined) return null;
      return {
        contentType: object.contentType,
        byteLength: object.byteLength,
        substitute: object.substitute,
        note: object.note,
      };
    },
  };
}

// ------------------------------------------------------------- 未接线（fail-closed）

/** 未接线端口（`real` 的默认装配）：一律 `OBJECT_UNAVAILABLE`。 */
export function createUnwiredMediaPort(reason = '真实对象存储尚未接线，无法存放合成产物'): SynthesisMediaPort {
  return {
    kind: 'unwired',
    note: `${reason}（fail-closed）`,
    async put() {
      return { ok: false, code: 'OBJECT_UNAVAILABLE' };
    },
    async exists() {
      return false;
    },
    async describeObject() {
      return null;
    },
  };
}

// ----------------------------------- 真实产物存储接线的显式批准能力（运行期构造期闸门）

/**
 * 合成产物真实存储接线的**显式批准能力**（形状照抄媒体域 #193 的 `RealMediaWiringApproval`）。
 *
 * 为什么不复用「配置／端口 kind／来源模块」：`real` 能不能把音频写进真实桶，**不能**由环境决定 ——
 * `process.env`、`options.env`、端口从哪个模块来、以及任何自述标志都属「配置即门控」
 * （媒体域两轮对抗性复审已实测：把来源放在被审文件之外，封闭世界的静态判据全绿而真实端口已被拿到）。
 * ⇒ 闸门必须落在**运行期、被执行的那条路径**上：{@link createSynthesisMediaPort} 在 `real` 下
 * **必须**收到一个由 {@link approveRealSynthesisMediaWiring} 铸造的本能力对象，否则一律 `unwired`。
 *
 * 该能力**不可默认化、不可伪造、不可派生**：
 *   - 唯一铸造点是 {@link approveRealSynthesisMediaWiring}（显式、可 grep、可审查的一次调用）；
 *   - 判定只认模块私有 `WeakSet` 中的**对象身份**（不是形状、不是标志位）：形状相同的字面量、
 *     `Object.create(token)` 派生物、`Proxy` 包装、结构化克隆／JSON 往返副本一律无效；
 *   - 取值走 `Object.hasOwn`（**不读原型链**）：`Object.prototype` 上的同名属性不算给出。
 *
 * ⛔ 装配层（`app.ts`）**不得**自行铸造（那等于自我批准）；它只转发调用方给出的那个对象。
 */
export interface RealSynthesisMediaApproval {
  /** 批准理由（仅审计回显，不参与判定）。 */
  readonly reason: string;
  /** 批准时刻（ISO 8601，仅审计）。 */
  readonly approvedAt: string;
}

/** 缺少批准能力时 `real` 的 fail-closed 原因（对外仍是既有 `OBJECT_UNAVAILABLE` 语义）。 */
export const REAL_SYNTHESIS_MEDIA_APPROVAL_REQUIRED_REASON =
  'real 模式缺少合成产物真实存储接线的显式批准能力：合成产物存储不可用（拒绝以内存/替身存储返回成功应答）';

/** 有批准能力、但没有显式注入真实对象存储端口时的 fail-closed 原因。 */
export const REAL_SYNTHESIS_MEDIA_OBJECT_STORE_REQUIRED_REASON =
  'real 模式未显式注入 s3_compatible 对象存储端口：合成产物无处存放（拒绝把替身存储当成真实产物存储）';

/** 真实端口接受的产物类型：真实适配器（`provider.ts` 的 live 分支）唯一产出就是 `audio/mpeg`。 */
export const REAL_SYNTHESIS_ARTIFACT_CONTENT_TYPE = 'audio/mpeg';

const APPROVED_REAL_SYNTHESIS_MEDIA = new WeakSet<object>();

/** 铸造一份合成产物真实存储接线批准能力（**唯一铸造点**；每次调用都是一次需审查的显式接线决定）。 */
export function approveRealSynthesisMediaWiring(input: {
  reason: string;
  approvedAt?: string;
}): RealSynthesisMediaApproval {
  const approval: RealSynthesisMediaApproval = Object.freeze({
    reason: input.reason,
    approvedAt: input.approvedAt ?? new Date().toISOString(),
  });
  APPROVED_REAL_SYNTHESIS_MEDIA.add(approval);
  return approval;
}

/** 只认「由 {@link approveRealSynthesisMediaWiring} 铸造」的对象身份；形状相同／派生／代理／克隆一律 false。 */
export function isRealSynthesisMediaWiringApproved(value: unknown): value is RealSynthesisMediaApproval {
  return typeof value === 'object' && value !== null && APPROVED_REAL_SYNTHESIS_MEDIA.has(value);
}

/** 接线拒绝原因（闭集）：拒绝 ⇒ 端口仍是 `unwired`（`put` → `OBJECT_UNAVAILABLE`），不新造错误码。 */
export const SYNTHESIS_MEDIA_WIRING_REFUSALS = [
  /** 传入的不是由 `approveRealSynthesisMediaWiring` 铸造的批准能力（形状/派生/克隆一律拒绝）。 */
  'approval_not_minted',
  /** 没有显式注入对象存储端口。 */
  'object_store_not_injected',
  /** 对象存储端口不是 S3 兼容适配器（替身/未接线端口不得冒充真实存储）。 */
  'object_store_not_s3_compatible',
] as const;

export type SynthesisMediaWiringRefusal = (typeof SYNTHESIS_MEDIA_WIRING_REFUSALS)[number];

/**
 * 直接构造真实端口时的接线拒绝错误。
 *
 * 生产装配路径**不会**看到它：{@link createSynthesisMediaPort} 先判闸门，任一条不过就返回 `unwired`
 * 端口（对外仍是 `OBJECT_UNAVAILABLE`）。它只在「绕过工厂直接 new」这种编程错误上抛出，
 * 让错接线在测试里立刻可见，而不是悄悄降级成一个看起来正常的端口。
 */
export class SynthesisMediaWiringError extends Error {
  readonly refusal: SynthesisMediaWiringRefusal;

  constructor(refusal: SynthesisMediaWiringRefusal, message: string) {
    super(`${message}（接线拒绝：${refusal}）`);
    this.name = 'SynthesisMediaWiringError';
    this.refusal = refusal;
  }
}

// ------------------------------------------------------------- 真实端口（对象存储）

/**
 * 真实端口的装配选项（{@link createSynthesisMediaPort} 的第二个实参）。
 *
 * **每个门控项都只有「显式给出」一种来源**：没有默认对象存储、没有 `env` 折算、没有
 * 「读到了 `process.env` 就自动开」的分支（见 {@link createSynthesisMediaPort}）。
 */
export interface SynthesisMediaPortOptions {
  /** 替身端口的确定性 id 工厂（真实端口用它生成 `media_id` 的 uuid；缺省 `randomUUID`）。 */
  idFactory?: () => string;
  /**
   * **显式注入**的真实对象存储端口（必须是 `kind === 's3_compatible'`，即媒体域
   * `createS3CompatibleObjectStore` 或装配层同口径构造的实例）。
   *
   * ⛔ 这里**只收已构造的实例**：本文件不从 `process.env`／`options.env` 造端口 ——
   * env 只可能是解析输入、且解析必须发生在**调用方**那次显式接线里（媒体域 #193 P1）。
   */
  objectStore?: MediaObjectStore;
  /**
   * **显式注入**的批准能力（{@link approveRealSynthesisMediaWiring} 铸造；non-defaultable）。
   * 缺失或不是铸造产物 ⇒ `real` 一律 `unwired`，与本进程环境里有没有 `OBJECT_STORAGE_*` 无关。
   */
  realSynthesisMediaApproval?: RealSynthesisMediaApproval;
  /** 单次对象读写的截止时间（毫秒，默认 10000）；超时 ⇒ 受控失败，不落「已合成」。 */
  storageTimeoutMs?: number;
}

const DEFAULT_STORAGE_TIMEOUT_MS = 10_000;
const MAX_ALLOCATION_ATTEMPTS = 3;

const REAL_OBJECT_NOTE =
  '真实对象存储中的合成音频（audio/mpeg）：键规则与媒体域一致（不透明 obj_ 引用）；'
  + 'media_id ↔ 对象键索引在本进程内，重启即丢（可恢复化属后续片）。';

class StorageDeadlineError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label}超过 ${timeoutMs}ms 未完成`);
    this.name = 'StorageDeadlineError';
  }
}

/**
 * 给一次对象存储调用加截止时间。
 *
 * 为什么要它：服务层的执行路径只把 `put` 的**返回值**当判定依据（`tts/service.ts` 的 `execute`）；
 * 如果端口一直挂着不返回，作业会停在 `running` 直到被截止时间收割。超时即**受控失败**，
 * 让作业立刻落 `failed` + `OBJECT_UNAVAILABLE`（不产生「已合成」假象）。
 *
 * ⚠️ 超时**不中止**底层请求（`fetch` 没有传递 `AbortSignal` 的位置）：迟到完成的写入仍可能
 * 在桶里留下一个**没有 media_id 指向的孤儿对象**，而本片没有 list 权限、也没有回收路径 ⇒
 * 这条残余风险如实登记在证据页，⛔ 不声称已消除。
 */
async function withDeadline<T>(label: string, timeoutMs: number, operation: () => Promise<T>): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return operation();
  const started = operation();
  // 超时先落定时，迟到的那次拒绝不得变成未处理拒绝（进程级告警/退出）。
  started.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new StorageDeadlineError(label, timeoutMs)), timeoutMs);
      timer.unref();
    });
    return await Promise.race([started, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 真实产物存储端口：复用媒体域的对象存储适配器写真实音频字节。
 *
 * 失败语义（全部**受控**：返回契约闭集里的错误码，绝不抛给服务层、也绝不落 `succeeded`）：
 *
 * | 情形 | 返回 | 服务层落点（`tts/service.ts`） |
 * | --- | --- | --- |
 * | 存储写入/查询抛错、超时、分配冲突（media_id 或对象键冲突用尽尝试） | `OBJECT_UNAVAILABLE`(409) | 作业 `failed` + `OBJECT_UNAVAILABLE` |
 * | 声明 `audio/mpeg` 但字节没有 MPEG/ID3 头（错误 JSON/HTML 冒充音频） | `MEDIA_TYPE_UNSUPPORTED`(415) | 作业 `failed` + `MEDIA_TYPE_UNSUPPORTED` |
 * | 替身产物进了真实端口（替身不得冒充真实产物） | `PROVIDER_OUTCOME_UNKNOWN`(503) | 作业 `failed` + `PROVIDER_OUTCOME_UNKNOWN` |
 *
 * 为什么超时也落 `OBJECT_UNAVAILABLE` 而不是 `PROVIDER_TIMEOUT`：服务层对**产物落库**失败一律写
 * `failed` + `put.code`（`tts/service.ts` 的 `media.put` 分支），而 `stateForProviderFailure`
 * 把 `PROVIDER_TIMEOUT` 映射成 `timed_out`。若这里返回 `PROVIDER_TIMEOUT`，就会出现
 * 「同一错误码在提供者失败分支是 `timed_out`、在落库分支是 `failed`」的自相矛盾 ⇒
 * 统一按「对象当前不可用」记 `OBJECT_UNAVAILABLE`（与 `media/**` 的 409 语义同口径）。
 */
export function createObjectStoreSynthesisMediaPort(options: {
  objectStore: MediaObjectStore;
  approval: RealSynthesisMediaApproval;
  idFactory?: () => string;
  storageTimeoutMs?: number;
}): SynthesisMediaPort & SynthesisMediaReadPort {
  if (!isRealSynthesisMediaWiringApproved(options.approval)) {
    throw new SynthesisMediaWiringError(
      'approval_not_minted',
      '缺少由 approveRealSynthesisMediaWiring 铸造的批准能力：拒绝把未获批端口接成真实产物存储',
    );
  }
  const injected: unknown = options.objectStore;
  if (typeof injected !== 'object' || injected === null) {
    throw new SynthesisMediaWiringError(
      'object_store_not_injected',
      '缺少显式注入的对象存储端口：拒绝以替身/内存存储冒充真实产物存储',
    );
  }
  const objectStore = injected as MediaObjectStore;
  if (objectStore.kind !== 's3_compatible') {
    throw new SynthesisMediaWiringError(
      'object_store_not_s3_compatible',
      `对象存储端口 kind=${JSON.stringify(objectStore.kind)}，不是 s3_compatible：替身/未接线端口不得冒充真实存储`,
    );
  }

  const timeoutMs = options.storageTimeoutMs ?? DEFAULT_STORAGE_TIMEOUT_MS;
  const idFactory = options.idFactory ?? ((): string => randomUUID());
  /**
   * `media_id` → 对象键索引。**进程内**（与 `tts/store.ts` 的内存作业 store 同口径）：
   * 重启后索引丢失 ⇒ 桶里的对象变成不可达孤儿。可恢复化（PG 台账 + 回收引用）是后续片，
   * 本片不声称已持久化，也不因为「桶里真有字节」就把作业写成 `succeeded` 之外的东西。
   */
  const objects = new Map<string, { key: string; contentType: string; byteLength: number }>();

  return {
    kind: 's3_compatible',
    note: REAL_OBJECT_NOTE,
    async put({ artifact }) {
      // ① 替身产物不得进入真实存储：否则「真实存储已接线」会看起来成立（与替身端口同一条红线）。
      if (artifact.substitute) {
        return { ok: false, code: 'PROVIDER_OUTCOME_UNKNOWN' };
      }
      // ② 只收真实适配器产出的类型，且字节必须真的像音频（不接受错误 JSON/HTML）。
      if (
        artifact.contentType.toLowerCase() !== REAL_SYNTHESIS_ARTIFACT_CONTENT_TYPE
        || !hasMpegAudioHeader(artifact.body)
      ) {
        return { ok: false, code: 'MEDIA_TYPE_UNSUPPORTED' };
      }
      try {
        for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt += 1) {
          const mediaId = idFactory();
          // `Synthesis.media_id` 契约是 uuid：id 形状不对就不落库（不靠类型断言假定它合法）。
          if (!UUID_PATTERN.test(mediaId)) continue;
          if (objects.has(mediaId)) continue;
          // 键规则与媒体域**同一条**：`newObjectRef()` 的不透明 `obj_` 引用，⛔ 不自造路径前缀。
          const key = newObjectRef();
          const taken = await withDeadline('对象存储存在性检查', timeoutMs, () => objectStore.hasObject(key));
          // 键冲突：绝不是「覆盖同键」的理由（那会毁掉别人的对象）—— 换一个键重试。
          if (taken) continue;
          await withDeadline('对象存储写入', timeoutMs, () =>
            objectStore.putObject(key, artifact.body, artifact.contentType));
          objects.set(mediaId, {
            key,
            contentType: artifact.contentType,
            byteLength: artifact.body.byteLength,
          });
          return { ok: true, mediaId };
        }
        // 分配冲突用尽（media_id 或键反复冲突）：受控失败，不返回一个指向别人对象的 media_id。
        return { ok: false, code: 'OBJECT_UNAVAILABLE' };
      } catch {
        // 存储抛错/超时：受控失败。绝不把异常漏给服务层——那会让作业停在 `running`。
        return { ok: false, code: 'OBJECT_UNAVAILABLE' };
      }
    },
    async exists(mediaId) {
      const entry = objects.get(mediaId);
      if (entry === undefined) return false;
      try {
        return await withDeadline('对象存储存在性检查', timeoutMs, () => objectStore.hasObject(entry.key));
      } catch {
        // 无法确认产物是否仍在 ⇒ 按「不可用」处理（fail-closed），绝不声称可用。
        return false;
      }
    },
    async describeObject(mediaId) {
      const entry = objects.get(mediaId);
      if (entry === undefined) return null;
      return {
        contentType: entry.contentType,
        byteLength: entry.byteLength,
        substitute: false,
        note: REAL_OBJECT_NOTE,
      };
    },
    async readArtifact(mediaId) {
      const entry = objects.get(mediaId);
      if (entry === undefined) return null;
      const stored = await withDeadline('对象存储读取', timeoutMs, () => objectStore.getObject(entry.key));
      if (stored === null) return null; // 键已不在（被外部删除）：如实返回「没有」，不伪造字节。
      return {
        bytes: stored.bytes,
        contentType: stored.contentType,
        byteLength: stored.bytes.byteLength,
      };
    },
    objectKeyFor(mediaId) {
      return objects.get(mediaId)?.key ?? null;
    },
  };
}

// ---------------------------------------------------------------------- 装配

/**
 * 按执行模式选择产物存储端口。
 *
 * - `stub` / `preset_demo` ⇒ 明确标注的替身（`options.objectStore`／批准能力**不参与**该分支，
 *   与接线前逐字一致）；
 * - `real` ⇒ 依次判**两个显式注入项**，任一缺失就 `unwired`（fail-closed）：
 *   ① {@link RealSynthesisMediaApproval}（`Object.hasOwn` 取值，不读原型链）；
 *   ② `kind === 's3_compatible'` 的对象存储端口。
 *
 * ⛔ **没有第三条开启路径**：本函数不读 `process.env`、不把 `env` 记录折算成端口、也没有任何默认
 * 端口／默认批准能力（媒体域 #193 的 P1 与 r3 主闸门同口径）。默认装配（`app.ts` 不注入任何选项）
 * ⇒ `real` 下仍是 `unwired` ⇒ `POST /speech/synthesis` 受理前 409 `OBJECT_UNAVAILABLE`。
 */
export function createSynthesisMediaPort(
  executionMode: string,
  options: SynthesisMediaPortOptions = {},
): SynthesisMediaPort {
  if (executionMode !== 'real') return createSubstituteMediaPort(options);

  // 只认**自有属性**：`Object.prototype.realSynthesisMediaApproval`（污染）不算「给出了批准能力」。
  const approval: unknown = Object.hasOwn(options, 'realSynthesisMediaApproval')
    ? options.realSynthesisMediaApproval
    : undefined;
  if (!isRealSynthesisMediaWiringApproved(approval)) {
    return createUnwiredMediaPort(REAL_SYNTHESIS_MEDIA_APPROVAL_REQUIRED_REASON);
  }
  const injectedStore: unknown = Object.hasOwn(options, 'objectStore') ? options.objectStore : undefined;
  if (typeof injectedStore !== 'object' || injectedStore === null) {
    return createUnwiredMediaPort(REAL_SYNTHESIS_MEDIA_OBJECT_STORE_REQUIRED_REASON);
  }
  try {
    return createObjectStoreSynthesisMediaPort({
      objectStore: injectedStore as MediaObjectStore,
      approval,
      ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
      ...(options.storageTimeoutMs === undefined ? {} : { storageTimeoutMs: options.storageTimeoutMs }),
    });
  } catch (error) {
    if (error instanceof SynthesisMediaWiringError) {
      // 形状对但没资格（例如注入了替身端口）：退回 fail-closed，而不是抛给装配层或降级放行。
      return createUnwiredMediaPort(`real 模式合成产物存储未接线：${error.message}`);
    }
    throw error;
  }
}
