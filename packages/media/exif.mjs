/**
 * GY-I06 媒体模块 · 图片 EXIF / 元数据清除。
 *
 * 目标：上传完成后，图片在服务端去除 EXIF（含 GPS 精确位置）与常见元数据段，
 * 原始对象保留为私有参考，对外仅提供**去元数据后的受控衍生件**（见 service.mjs）。
 *
 * 覆盖容器：JPEG（APP1 Exif / APP1 XMP / APP13 Photoshop）、PNG（eXIf / tEXt / iTXt / zTXt）、
 * WebP（EXIF / XMP chunk）。音频不做 EXIF 处理（原始位置不来自音频容器头）。
 *
 * 安全红线（返修 B1 强化）：
 *   1) **对外字节必须全部经过结构校验与清理**——无论在哪个容器发现元数据，
 *      返回的字节都是「逐块重建 + 结构校验通过」的结果，绝不回退返回原始输入；
 *   2) **容器尾部的多余字节一律拒绝**（PNG IEND 之后、JPEG EOI 之后、WebP RIFF 声明之外），
 *      杜绝「写入 IEND/EOI 之后仍被下游读取」的走私通道；
 *   3) **无图像数据 / 结构损坏的容器一律拒绝**（如仅 PNG 签名、仅 SOI 的 JPEG），
 *      不允许进入 ready。
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

function readU32be(bytes, o) {
  return ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
}

function readU32le(bytes, o) {
  return (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
}

/** PNG chunk 类型必须是 4 个 ASCII 字母。 */
function isChunkType(type) {
  return /^[A-Za-z]{4}$/.test(type);
}

const XMP_NS = 'http://ns.adobe.com/xap/1.0/';

/** 统一的失败结果：ok=false，调用方据此走 rejected(decode_failed)。 */
function failed(bytes) {
  return { ok: false, data: bytes, removed: [] };
}

// ------------------------------------------------------------------ JPEG

/**
 * 在熵编码数据流中定位下一个真正的标记起始（跳过 0xFF00 填充、RSTn 重启标记、连续 0xFF 填充）。
 * @returns {number} 标记起始下标；未找到返回 -1。
 */
function findNextJpegMarker(bytes, start) {
  let j = start;
  while (j + 1 < bytes.length) {
    if (bytes[j] !== 0xff) {
      j += 1;
      continue;
    }
    const n = bytes[j + 1];
    if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) {
      j += 2; // 字节填充 / 重启标记，属于熵数据
      continue;
    }
    if (n === 0xff) {
      j += 1; // 连续填充字节，继续找
      continue;
    }
    return j;
  }
  return -1;
}

function stripJpeg(bytes) {
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) return failed(bytes);
  const chunks = [bytes.subarray(0, 2)]; // SOI
  const removed = [];
  let sawSOS = false;
  let sawEOI = false;
  let i = 2;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) return failed(bytes); // 结构损坏：期望标记
    const marker = bytes[i + 1];
    if (marker === 0xd9) {
      chunks.push(bytes.subarray(i, i + 2)); // EOI
      i += 2;
      sawEOI = true;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      chunks.push(bytes.subarray(i, i + 2)); // 无负载标记
      i += 2;
      continue;
    }
    if (i + 3 >= bytes.length) return failed(bytes);
    const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
    if (segLen < 2 || i + 2 + segLen > bytes.length) return failed(bytes);

    if (marker === 0xda) {
      // SOS：长度前缀头 + 其后熵编码数据（直到下一个真标记）。
      chunks.push(bytes.subarray(i, i + 2 + segLen));
      i += 2 + segLen;
      sawSOS = true;
      const next = findNextJpegMarker(bytes, i);
      if (next < 0) return failed(bytes); // 无终止标记（截断）
      if (next > i) chunks.push(bytes.subarray(i, next));
      i = next;
      continue;
    }

    const dataStart = i + 4;
    const isExif = marker === 0xe1 && asciiAt(bytes, dataStart, 'Exif\0\0');
    const isXmp = marker === 0xe1 && asciiAt(bytes, dataStart, XMP_NS);
    const isPhotoshop = marker === 0xed;
    if (isExif || isXmp || isPhotoshop) {
      removed.push(isExif ? 'APP1:Exif' : isXmp ? 'APP1:XMP' : 'APP13:Photoshop');
    } else {
      chunks.push(bytes.subarray(i, i + 2 + segLen));
    }
    i += 2 + segLen;
  }
  if (!sawSOS) return failed(bytes); // 无图像数据（无 SOS）
  if (!sawEOI) return failed(bytes); // 未以 EOI 正常结束
  if (i !== bytes.length) return failed(bytes); // EOI 之后仍有尾部字节 → 拒绝
  return { ok: true, data: concat(chunks), removed };
}

// ------------------------------------------------------------------- PNG

function stripPng(bytes) {
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8) return failed(bytes);
  for (let k = 0; k < magic.length; k += 1) if (bytes[k] !== magic[k]) return failed(bytes);

  const out = [bytes.subarray(0, 8)];
  const removed = [];
  const dropTypes = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt']);
  let i = 8;
  let sawIHDR = false;
  let sawIDAT = false;
  let sawIEND = false;
  let iendEnd = -1;
  while (i + 12 <= bytes.length) {
    const len = readU32be(bytes, i);
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    if (!isChunkType(type)) return failed(bytes);
    const end = i + 12 + len;
    if (end > bytes.length) return failed(bytes); // 截断
    if (!sawIHDR) {
      // 首块必须是 IHDR，且长度固定为 13。
      if (type !== 'IHDR' || len !== 13) return failed(bytes);
      sawIHDR = true;
    }
    if (type === 'IDAT') sawIDAT = true;
    if (type === 'IEND') {
      if (len !== 0) return failed(bytes);
      out.push(bytes.subarray(i, end));
      i = end;
      sawIEND = true;
      iendEnd = end;
      break;
    }
    if (dropTypes.has(type)) removed.push(`PNG:${type}`);
    else out.push(bytes.subarray(i, end));
    i = end;
  }
  // 必须完成 IHDR/IDAT/IEND，且 IEND 之后不得有尾部字节。
  if (!sawIHDR || !sawIDAT || !sawIEND) return failed(bytes);
  if (iendEnd !== bytes.length) return failed(bytes);
  return { ok: true, data: concat(out), removed };
}

// ------------------------------------------------------------------ WebP

function stripWebp(bytes) {
  if (!(asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP'))) return failed(bytes);
  const riffSize = readU32le(bytes, 4);
  // RIFF 声明长度必须与文件实际长度一致（不允许声明之外的尾部字节）。
  if (riffSize + 8 !== bytes.length) return failed(bytes);
  const body = [bytes.subarray(0, 12)];
  const removed = [];
  let sawImage = false;
  let i = 12;
  while (i + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
    const size = readU32le(bytes, i + 4);
    const total = 8 + size + (size % 2); // 奇数长度补齐到偶数
    const end = i + total;
    if (end > bytes.length) return failed(bytes); // 截断
    if (fourcc === 'VP8 ' || fourcc === 'VP8L' || fourcc === 'VP8X') sawImage = true;
    if (fourcc === 'EXIF' || fourcc === 'XMP ') removed.push(`WEBP:${fourcc.trim()}`);
    else body.push(bytes.subarray(i, end));
    i = end;
  }
  if (i !== bytes.length) return failed(bytes); // chunk 未恰好铺满 → 尾部残留
  if (!sawImage) return failed(bytes); // 无图像数据（无 VP8/VP8L/VP8X）
  const merged = concat(body);
  const newRiffSize = merged.length - 8;
  merged[4] = newRiffSize & 0xff;
  merged[5] = (newRiffSize >> 8) & 0xff;
  merged[6] = (newRiffSize >> 16) & 0xff;
  merged[7] = (newRiffSize >> 24) & 0xff;
  return { ok: true, data: merged, removed };
}

/**
 * 清除图片元数据。
 * @param {Uint8Array} bytes
 * @param {string} mime 已核验的真实图片 MIME（image/jpeg|image/png|image/webp）
 * @returns {{ ok: boolean, changed: boolean, data: Uint8Array, removed: string[] }}
 *   ok=false 表示容器结构损坏 / 无图像数据 / 尾部非法，调用方必须据此拒绝该媒体。
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
