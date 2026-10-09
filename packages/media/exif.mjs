/**
 * GY-I06 媒体模块 · 图片 EXIF / 元数据清除。
 *
 * 目标：上传完成后，图片在服务端去除 EXIF（含 GPS 精确位置）与常见元数据段，
 * 原始对象保留为私有参考，对外仅提供**去元数据后的受控衍生件**（见 service.mjs）。
 *
 * 覆盖容器：JPEG（APP1 Exif / APP1 XMP / APP13 Photoshop）、PNG（eXIf / tEXt / iTXt / zTXt）、
 * WebP（EXIF / XMP chunk）。音频不做 EXIF 处理（原始位置不来自音频容器头）。
 *
 * 说明：本模块是**结构性段清除**，不做像素重编码。它移除元数据段但保留压缩数据，
 * 因此不改变图像内容，也不声称能达到「重编码级」的像素级净化。
 */

function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function asciiAt(bytes, offset, text) {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

const XMP_NS = 'http://ns.adobe.com/xap/1.0/';

function stripJpeg(bytes) {
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) return { ok: false, data: bytes, removed: [] };
  const chunks = [bytes.subarray(0, 2)]; // SOI
  const removed = [];
  let i = 2;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) return { ok: false, data: bytes, removed: [] }; // 结构损坏
    const marker = bytes[i + 1];
    // 无负载标记：RSTn / TEM；SOI/EOI 单独处理。
    if (marker === 0xd9) {
      chunks.push(bytes.subarray(i, i + 2)); // EOI
      i += 2;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      chunks.push(bytes.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
    if (segLen < 2 || i + 2 + segLen > bytes.length) return { ok: false, data: bytes, removed: [] };
    const segment = bytes.subarray(i, i + 2 + segLen);
    const dataStart = i + 4;
    const isExif = marker === 0xe1 && asciiAt(bytes, dataStart, 'Exif\0\0');
    const isXmp = marker === 0xe1 && asciiAt(bytes, dataStart, XMP_NS);
    const isPhotoshop = marker === 0xed;
    if (isExif || isXmp || isPhotoshop) {
      removed.push(isExif ? 'APP1:Exif' : isXmp ? 'APP1:XMP' : 'APP13:Photoshop');
    } else {
      chunks.push(segment);
    }
    i += 2 + segLen;
    if (marker === 0xda) {
      // SOS：其后为熵编码数据，原样拷贝至结尾。
      chunks.push(bytes.subarray(i));
      i = bytes.length;
      break;
    }
  }
  if (i < bytes.length) chunks.push(bytes.subarray(i));
  return { ok: true, data: removed.length ? concat(chunks) : bytes, removed };
}

function stripPng(bytes) {
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let k = 0; k < magic.length; k += 1) if (bytes[k] !== magic[k]) return { ok: false, data: bytes, removed: [] };
  const out = [bytes.subarray(0, 8)];
  const removed = [];
  const dropTypes = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt']);
  let i = 8;
  while (i + 8 <= bytes.length) {
    const len = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    const end = i + 12 + len;
    if (len < 0 || end > bytes.length) return { ok: false, data: bytes, removed: [] };
    if (dropTypes.has(type)) {
      removed.push(`PNG:${type}`);
    } else {
      out.push(bytes.subarray(i, end));
    }
    i = end;
    if (type === 'IEND') break;
  }
  return { ok: true, data: removed.length ? concat(out) : bytes, removed };
}

function stripWebp(bytes) {
  if (!(asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP'))) return { ok: false, data: bytes, removed: [] };
  const head = bytes.subarray(0, 12);
  const body = [head];
  const removed = [];
  let i = 12;
  while (i + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
    const size = bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24);
    const total = 8 + size + (size % 2); // 奇数长度补齐到偶数
    const end = i + total;
    if (size < 0 || end > bytes.length) return { ok: false, data: bytes, removed: [] };
    if (fourcc === 'EXIF' || fourcc === 'XMP ') {
      removed.push(`WEBP:${fourcc.trim()}`);
    } else {
      body.push(bytes.subarray(i, end));
    }
    i = end;
  }
  if (i < bytes.length) body.push(bytes.subarray(i));
  const merged = concat(body);
  if (removed.length) {
    const riffSize = merged.length - 8;
    merged[4] = riffSize & 0xff;
    merged[5] = (riffSize >> 8) & 0xff;
    merged[6] = (riffSize >> 16) & 0xff;
    merged[7] = (riffSize >> 24) & 0xff;
  }
  return { ok: true, data: removed.length ? merged : bytes, removed };
}

/**
 * 清除图片元数据。
 * @param {Uint8Array} bytes
 * @param {string} mime 已核验的真实图片 MIME（image/jpeg|image/png|image/webp）
 * @returns {{ ok: boolean, changed: boolean, data: Uint8Array, removed: string[] }}
 */
export function stripImageMetadata(bytes, mime) {
  let result;
  if (mime === 'image/jpeg') result = stripJpeg(bytes);
  else if (mime === 'image/png') result = stripPng(bytes);
  else if (mime === 'image/webp') result = stripWebp(bytes);
  else return { ok: true, changed: false, data: bytes, removed: [] };
  if (!result.ok) return { ok: false, changed: false, data: bytes, removed: [] };
  return { ok: true, changed: result.removed.length > 0, data: result.data, removed: result.removed };
}
