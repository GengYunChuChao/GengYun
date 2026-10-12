/**
 * GY-I13 普通话 TTS 合成域 · 合成产物（媒体）落库端口。
 *
 * 现状（如实记录，见汇报与 PR 正文）：
 * - 本片**不接真实对象存储**（没有已审的对象存储实现，也没有本域可用的上传数据面）。
 * - `stub` / `preset_demo`：使用**明确标注的替身产物存储**——只登记「标注产物」的
 *   内容类型与字节长度，产物正文是明文标注，**不是音频**、**不可播放**；
 *   它不把任何真实音频声明为已产出，也不让真实存储成功路径看起来已接线。
 * - `real`：**未接线**（`kind='unwired'`）：`put` 一律 `OBJECT_UNAVAILABLE`，
 *   `exists` 一律 false，绝不「本地兜底」伪造一个 media_id。
 *
 * 存储边界上的**防御性不变量**（纵深防御，服务层已先校验一次）：即便上层漏检，
 * 这里也拒绝把「标注为替身却是 audio/*」或「替身正文带 MP3/ID3 头」的对象写进存储——
 * 替身不得伪装成真实音频。
 */

import type { ErrorCode } from '../contract.ts';
import type { SynthesisArtifact } from './state.ts';

export type MediaPutResult = { ok: true; mediaId: string } | { ok: false; code: ErrorCode };

/** 替身产物对象（只登记标注，不含音频字节）。 */
export interface SubstituteMediaObject {
  mediaId: string;
  ownerUserId: string;
  synthesisId: string;
  contentType: string;
  byteLength: number;
  substitute: true;
  note: string;
}

export interface SynthesisMediaPort {
  /** 端口类型：substitute=替身标注存储（stub/preset_demo）、unwired=未接线（real，fail-closed）。 */
  readonly kind: 'substitute' | 'unwired';
  /** 供证据文档／诊断引用的如实标注（不含任何音频字节或私有媒体）。 */
  readonly note: string;
  put(input: { ownerUserId: string; synthesisId: string; artifact: SynthesisArtifact }): Promise<MediaPutResult>;
  exists(mediaId: string): Promise<boolean>;
  /** 供诊断：该 media_id 指向的替身标注（不含正文）。 */
  describeObject(mediaId: string): Promise<Omit<SubstituteMediaObject, 'mediaId' | 'ownerUserId' | 'synthesisId'> | null>;
}

const SUBSTITUTE_NOTE =
  '替身产物存储（stub/preset_demo）：只登记**非音频**标注产物；不接真实对象存储、不写入任何真实音频、不接受真实音频上传。';

/**
 * 字节是否带 MPEG/ID3 头（`ID3` 标签 或 MPEG 帧同步 `0xFF 0xEx`）。
 * 两处用它：替身存储拒绝「伪装成真实音频的替身」，真实适配器拒绝「把错误 JSON/HTML 当音频落库」。
 * 这是**头部嗅探**，不是完整解码器，也不构成任何音频质量结论。
 */
export function hasMpegAudioHeader(body: Uint8Array): boolean {
  if (body.byteLength >= 3 && body[0] === 0x49 && body[1] === 0x44 && body[2] === 0x33) return true; // 'ID3'
  if (body.byteLength >= 2 && body[0] === 0xff && (body[1]! & 0xe0) === 0xe0) return true; // MPEG 帧同步
  return false;
}

/**
 * 替身产物存储：明确标注、确定性、**不含音频**。
 * 拒绝条件（返回契约错误码，不静默接受）：
 * - `substitute === false`（真实产物）⇒ `OBJECT_UNAVAILABLE`：真实对象存储**未接线**，
 *   替身存储绝不接收真实音频（否则「真实存储已接线」会看起来成立）；
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
        // 真实合成产物需要**真实**对象存储；本片未接线，绝不把它记成替身对象。
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

/**
 * 未接线产物存储（`real` 模式）：一律 `OBJECT_UNAVAILABLE`。
 * 不泄露任何对象是否存在（`exists` 恒 false），也不以「本地兜底」方式放行。
 */
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

/** 按执行模式选择产物存储：只有替身模式才允许替身存储。 */
export function createSynthesisMediaPort(executionMode: string, options: { idFactory?: () => string } = {}): SynthesisMediaPort {
  return executionMode === 'real' ? createUnwiredMediaPort() : createSubstituteMediaPort(options);
}
