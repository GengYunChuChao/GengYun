/**
 * GY-I06 媒体模块 · 真实类型探测（魔数/容器）。
 *
 * 硬红线：**不信扩展名/声明 MIME**，以实际字节判定真实编码。
 * 返回的 MIME 只取契约 UploadInput.mime 枚举内的值：
 *   image/jpeg | image/png | image/webp | audio/mpeg | audio/wav | audio/aac
 */

function startsWith(bytes, signature, offset = 0) {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

function asciiAt(bytes, offset, text) {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * 探测真实媒体类型。
 * @param {Uint8Array} bytes
 * @returns {{ mime: string, container: string } | null} 不在已知集合内返回 null。
 */
export function detectMediaType(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const b0 = bytes[0];
  const b1 = bytes[1];

  // ---- 图片 ----
  if (startsWith(bytes, JPEG_MAGIC)) return { mime: 'image/jpeg', container: 'jpeg' };
  if (startsWith(bytes, PNG_MAGIC)) return { mime: 'image/png', container: 'png' };
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return { mime: 'image/webp', container: 'webp' };

  // ---- 音频 ----
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WAVE')) return { mime: 'audio/wav', container: 'wav' };
  // ID3v2 标签的 MP3。
  if (asciiAt(bytes, 0, 'ID3')) return { mime: 'audio/mpeg', container: 'mpeg' };
  if (b0 === 0xff && (b1 & 0xf6) === 0xf0) return { mime: 'audio/aac', container: 'adts-aac' };
  if (b0 === 0xff && (b1 & 0xe0) === 0xe0 && (b1 & 0x06) !== 0) {
    return { mime: 'audio/mpeg', container: 'mpeg' };
  }
  // ISO BMFF（m4a/aac 容器，major brand 限定为音频/通用品牌）。
  if (asciiAt(bytes, 4, 'ftyp')) {
    const brand = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0);
    const audioBrands = new Set(['M4A ', 'M4B ', 'mp42', 'mp41', 'isom', 'iso2', 'dash']);
    if (audioBrands.has(brand)) return { mime: 'audio/aac', container: 'm4a' };
  }

  return null;
}

/** 探测并要求命中；未命中抛类型不支持由调用方处理（此处返回 null 语义由上层决策）。 */
export function detectOrNull(bytes) {
  try {
    return detectMediaType(bytes);
  } catch {
    return null;
  }
}
