/**
 * GY-I06 媒体模块 · 上传声明与真实字节校验。
 *
 * 硬红线：**不信声明 MIME / 扩展名**。上传声明的 mime 只用于「圈定候选」，
 * 真实类型以字节魔数（detect.mjs）为准，两者不符即 415 MEDIA_TYPE_UNSUPPORTED。
 */
import { createHash } from 'node:crypto';
import {
  MEDIA_MAX_BYTES,
  MEDIA_MAX_DURATION_MS,
  COMMUNITY_MAX_IMAGES_PER_POST,
  allowedMimeFor,
  maxBytesFor,
  kindOf,
  isMediaPurpose,
} from './constants.mjs';
import { MediaError } from './errors.mjs';
import { detectMediaType } from './detect.mjs';
import { computeAudioDurationMs } from './audio.mjs';

const SHA256_RE = /^[a-f0-9]{64}$/;

/** 计算 sha256 十六进制摘要。 */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function invalidRequest(message, details = []) {
  return new MediaError('INVALID_REQUEST', message, { details });
}

/**
 * 校验上传声明（openapi UploadInput）。
 * @param {object} input
 * @param {{ mediaCountForPost?: number }} [context] community_image 每帖图片数（含本次）。
 * @returns {{ purpose:string, mime:string, bytes:number, duration_ms:number|null, sha256:string }}
 */
export function validateUploadInput(input, context = {}) {
  if (input === null || typeof input !== 'object') {
    throw invalidRequest('上传声明缺失或格式错误');
  }
  const { purpose, mime, bytes, duration_ms: durationRaw, sha256 } = input;

  if (!isMediaPurpose(purpose)) {
    throw invalidRequest('purpose 非法', [{ field: '/purpose', code: 'invalid_purpose' }]);
  }
  const allowed = allowedMimeFor(purpose);
  if (typeof mime !== 'string' || !allowed.includes(mime)) {
    throw new MediaError('MEDIA_TYPE_UNSUPPORTED', '声明类型不在该用途允许范围内', {
      details: [{ field: '/mime', code: 'unsupported_for_purpose' }],
    });
  }

  const limit = Math.min(maxBytesFor(purpose), MEDIA_MAX_BYTES);
  if (!Number.isInteger(bytes) || bytes < 1) {
    throw invalidRequest('bytes 必须为正整数', [{ field: '/bytes', code: 'invalid' }]);
  }
  if (bytes > limit) {
    throw new MediaError('MEDIA_TOO_LARGE', `超过该用途字节上限（${limit}）`, {
      details: [{ field: '/bytes', code: 'too_large' }],
    });
  }

  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) {
    throw invalidRequest('sha256 必须为 64 位小写十六进制', [{ field: '/sha256', code: 'invalid' }]);
  }

  const kind = kindOf(purpose);
  let duration = null;
  if (kind === 'audio') {
    if (!Number.isInteger(durationRaw)) {
      throw invalidRequest('语音必须携带 duration_ms', [{ field: '/duration_ms', code: 'required' }]);
    }
    if (durationRaw < 1 || durationRaw > MEDIA_MAX_DURATION_MS) {
      throw invalidRequest(`duration_ms 必须在 1..${MEDIA_MAX_DURATION_MS}`, [
        { field: '/duration_ms', code: 'out_of_range' },
      ]);
    }
    duration = durationRaw;
  } else if (durationRaw !== undefined && durationRaw !== null) {
    throw invalidRequest('图片不接受 duration_ms', [{ field: '/duration_ms', code: 'not_allowed' }]);
  }

  if (purpose === 'community_image') {
    const count = Number(context.mediaCountForPost ?? 0);
    if (Number.isInteger(count) && count >= COMMUNITY_MAX_IMAGES_PER_POST) {
      throw invalidRequest(`每个帖子最多 ${COMMUNITY_MAX_IMAGES_PER_POST} 张图片`, [
        { field: '/purpose', code: 'post_image_limit' },
      ]);
    }
  }

  return { purpose, mime, bytes, duration_ms: duration, sha256 };
}

/** 校验完成上传声明（openapi UploadCompleteInput）。 */
export function validateCompleteInput(input) {
  if (input === null || typeof input !== 'object') {
    throw invalidRequest('完成上传声明缺失或格式错误');
  }
  const { sha256, bytes } = input;
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) {
    throw invalidRequest('sha256 必须为 64 位小写十六进制', [{ field: '/sha256', code: 'invalid' }]);
  }
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > MEDIA_MAX_BYTES) {
    throw invalidRequest(`bytes 必须在 1..${MEDIA_MAX_BYTES}`, [{ field: '/bytes', code: 'out_of_range' }]);
  }
  return { sha256, bytes };
}

/**
 * 核验实际字节与声明一致（长度、hash、真实类型、音频真实时长），返回真实类型与真实时长。
 *
 * 音频（B2 返修）：真实时长以字节解析结果为准——
 *   - 无法解析真实时长 → 受控拒绝（INVALID_REQUEST，field=/file）；
 *   - 真实时长 > 60s   → 拒绝（INVALID_REQUEST，field=/duration_ms）；
 *   - 声明时长与真实时长偏差超出容差 → 拒绝（虚报，INVALID_REQUEST，field=/duration_ms）。
 * 绝不回退「信任调用方声明」。
 *
 * @param {{ bytes: Uint8Array, declared: {mime:string, bytes:number, sha256:string, purpose:string, duration_ms?:number|null} }} args
 * @returns {{ mime:string, container:string, durationMs?:number }}
 */
export function assertBytesMatchDeclaration({ bytes, declared }) {
  if (!bytes || typeof bytes.length !== 'number') {
    throw invalidRequest('缺少上传字节');
  }
  const limit = Math.min(maxBytesFor(declared.purpose), MEDIA_MAX_BYTES);
  if (bytes.length > limit) {
    throw new MediaError('MEDIA_TOO_LARGE', `实际上传超过该用途字节上限（${limit}）`, {
      details: [{ field: '/bytes', code: 'too_large' }],
    });
  }
  if (bytes.length !== declared.bytes) {
    throw invalidRequest('实际上传字节数与声明不符', [{ field: '/bytes', code: 'mismatch' }]);
  }
  if (sha256Hex(bytes) !== declared.sha256) {
    throw invalidRequest('实际上传哈希与声明不符', [{ field: '/sha256', code: 'mismatch' }]);
  }
  const detected = detectMediaType(bytes);
  if (!detected) {
    throw new MediaError('MEDIA_TYPE_UNSUPPORTED', '无法识别真实编码（疑似伪扩展名或损坏文件）', {
      details: [{ field: '/file', code: 'unknown_magic' }],
    });
  }
  // 伪扩展名防线：声明的 MIME 必须与真实编码一致（不只「都属于该用途」）。
  if (detected.mime !== declared.mime) {
    throw new MediaError('MEDIA_TYPE_UNSUPPORTED', '真实编码与声明类型不符（伪扩展名）', {
      details: [{ field: '/file', code: 'declared_vs_real_mismatch' }],
    });
  }
  if (!allowedMimeFor(declared.purpose).includes(detected.mime)) {
    throw new MediaError('MEDIA_TYPE_UNSUPPORTED', '真实编码与该用途不符（不信扩展名）', {
      details: [{ field: '/file', code: 'unsupported_for_purpose' }],
    });
  }
  const expectedKind = kindOf(declared.purpose);
  const actualKind = detected.mime.startsWith('image/') ? 'image' : 'audio';
  if (expectedKind !== actualKind) {
    throw new MediaError('MEDIA_TYPE_UNSUPPORTED', '真实编码类别与该用途不符', {
      details: [{ field: '/file', code: 'kind_mismatch' }],
    });
  }

  // 音频：依有效编码解析**真实时长**并参与上限判断；无法解析则受控拒绝。
  let durationMs;
  if (actualKind === 'audio') {
    const real = computeAudioDurationMs(bytes);
    if (!real.ok) {
      throw invalidRequest('无法从字节验证音频真实时长', [
        { field: '/file', code: 'duration_unverifiable' },
      ]);
    }
    if (real.durationMs > MEDIA_MAX_DURATION_MS) {
      throw invalidRequest(`音频真实时长超过上限（${MEDIA_MAX_DURATION_MS}ms）`, [
        { field: '/duration_ms', code: 'out_of_range' },
      ]);
    }
    const declaredMs = declared.duration_ms;
    if (typeof declaredMs === 'number') {
      const tolerance = Math.max(2000, Math.ceil(real.durationMs * 0.1));
      if (Math.abs(declaredMs - real.durationMs) > tolerance) {
        throw invalidRequest('声明时长与真实时长不符', [{ field: '/duration_ms', code: 'mismatch' }]);
      }
    }
    durationMs = real.durationMs;
  }

  return { ...detected, durationMs };
}
