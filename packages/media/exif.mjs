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
 *      不允许进入 ready；
 *   4) **解压必须受预算约束**（返修 D3）——PNG 解压前按 IHDR 计算期望原始长度，
 *      解压中强制输出上限，解压后精确核对，杜绝「小体积 IDAT 解出巨大缓冲」的资源耗尽；
 *   5) **有块名 ≠ 有可用图像数据**（返修 C2/D2）——PNG 的 IDAT 须可真实解压且长度精确；
 *   6) **「结构形状」≠「可解码的真实内容」**（返修 E2/E3）——
 *      - PNG（E3）：解压长度精确仍不够，**逐行扫描线的滤波类型字节**（0..4）须合法，
 *        杜绝「IDAT=zlib([0xff,0])」这类长度恰好正确、真实解码器却报
 *        `unrecognized data stream contents` 的构造；
 *      - WebP（E2）：**VP8L 位流必须真实解码**（完整走通并恰好产出 W×H 像素，见 webp.mjs），
 *        「只有 5 字节位流头、没有任何像素位流」的空壳一律拒绝；VP8（有损）与动画
 *        （ANIM/ANMF）因**本模块不具备核验其真实内容的解码能力**，按「无法核验即拒绝」受控拒绝。
 *
 * 说明：本模块是**结构性段清除**，不做像素重编码。它移除元数据段但保留压缩数据，
 * 因此不改变图像内容，也不声称能达到「重编码级」的像素级净化。
 *
 * 覆盖范围（受控，fail-closed）：图片接受 JPEG / PNG / **可真实解码的 VP8L 无损 WebP**；
 * 有损 WebP 与动画 WebP 受控拒绝（需引入标准解码库方可放开，见 README 的依赖说明）。
 */

import { inflateSync } from 'node:zlib';
import { MIB } from './constants.mjs';
import { decodeVp8l } from './webp.mjs';

/**
 * 单张图片**解码后原始字节**的硬上限（D3 资源耗尽防线，政策上界）。
 * 契约侧上传字节上限仅约束压缩后大小，解压比完全不受约束，故此处独立设界：
 * 任何声明的 IHDR 尺寸若暗示解码结果超过该值，一律在**解压前**拒绝，
 * 避免为恶意尺寸分配大缓冲。可按运营需要调整。
 */
const MAX_DECODED_IMAGE_BYTES = 64 * MIB;

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

/**
 * 校验解压后扫描线的**逐行滤波类型字节**必须合法（0..4）。
 *
 * E3：解压长度精确匹配 ≠ 扫描线有效 —— `IDAT = zlib([0xff,0])` 的 1×1 图像长度恰好 2，
 * 但首字节 0xff 不是合法滤波类型，真实解码器（libwebp/Pillow）会报
 * `unrecognized data stream contents`。此处逐行核对：
 *   - 非交错：height 行，每行 `1 + 行字节`；
 *   - Adam7：七趟各自的 (pass_width × pass_height) 行。
 * 任一滤波字节 > 4，或行数与预期不符（游标未恰好走完）→ 判否。
 */
function pngFiltersValid(raw, ihdr) {
  const width = readU32be(ihdr, 0);
  const height = readU32be(ihdr, 4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  const channels = PNG_CHANNELS[colorType];
  const bitsPerPixel = bitDepth * channels;
  let p = 0;
  const pass = (passWidth, passHeight) => {
    if (passWidth < 1 || passHeight < 1) return true;
    const rowBytes = Math.ceil((passWidth * bitsPerPixel) / 8);
    for (let y = 0; y < passHeight; y += 1) {
      if (p >= raw.length) return false;
      if (raw[p] > 4) return false;
      p += 1 + rowBytes;
    }
    return true;
  };
  if (interlace === 0) {
    if (!pass(width, height)) return false;
  } else {
    for (const [x0, y0, dx, dy] of ADAM7_PASSES) {
      if (!pass(Math.ceil((width - x0) / dx), Math.ceil((height - y0) / dy))) return false;
    }
  }
  return p === raw.length;
}

/**
 * 有界 zlib 解压（D3 资源耗尽防线）。
 *
 * 旧实现 `inflateSync(bytes)` **先解压再判断**，对 1039 字节 IDAT 可解出 1 MiB
 * 并阻塞请求线程。现改为：
 *   - 调用方先按 IHDR 算出**期望原始长度** expectedRaw（见 pngRawSize）；
 *   - 解压时以 `maxOutputLength = limit` **强制预算**，一旦输出将超出即抛
 *     `ERR_BUFFER_TOO_LARGE` 中止（不会先分配出超限缓冲）；
 *   - 解压后输出长度必须**精确等于**期望值，否则视为炸弹/结构不符。
 * 失败时返回 null，且不保留任何解压缓冲（交由 GC 回收）。
 *
 * @param {Uint8Array} bytes 压缩流（IDAT 拼接）
 * @param {number} limit 输出硬上限（= expectedRaw，取自 IHDR，已受政策上界约束）
 * @returns {Buffer|null}
 */
function inflateBounded(bytes, limit) {
  if (!(limit >= 1)) return null;
  try {
    return inflateSync(Buffer.from(bytes), { maxOutputLength: limit });
  } catch {
    return null;
  }
}

/** PNG colorType -> 每像素通道数。 */
const PNG_CHANNELS = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });

/** PNG colorType -> 合法位深集合（规范约束）。 */
const PNG_BIT_DEPTHS = Object.freeze({
  0: Object.freeze([1, 2, 4, 8, 16]),
  2: Object.freeze([8, 16]),
  3: Object.freeze([1, 2, 4, 8]),
  4: Object.freeze([8, 16]),
  6: Object.freeze([8, 16]),
});

/** Adam7 交错的 7 个 pass 起始与步长。 */
const ADAM7_PASSES = Object.freeze([
  Object.freeze([0, 0, 8, 8]),
  Object.freeze([4, 0, 8, 8]),
  Object.freeze([0, 4, 4, 8]),
  Object.freeze([2, 0, 4, 4]),
  Object.freeze([0, 2, 2, 4]),
  Object.freeze([1, 0, 2, 2]),
  Object.freeze([0, 1, 1, 2]),
]);

/**
 * 由 13 字节 IHDR 计算**解码后原始字节数**（= 每行 1 字节 filter + 行字节）。
 * 非交错：`(rowBytes + 1) × height`；交错：Adam7 七趟之和。
 * 结构非法（尺寸为 0 / 位深-色型组合非法 / 压缩或滤波方法非 0 / 交错标志未知）返回 null。
 * @param {Uint8Array} ihdr
 * @returns {number|null}
 */
function pngRawSize(ihdr) {
  if (!ihdr || ihdr.length < 13) return null;
  const width = readU32be(ihdr, 0);
  const height = readU32be(ihdr, 4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const compression = ihdr[10];
  const filterMethod = ihdr[11];
  const interlace = ihdr[12];
  if (width < 1 || height < 1) return null;
  const channels = PNG_CHANNELS[colorType];
  if (channels === undefined) return null;
  if (!PNG_BIT_DEPTHS[colorType].includes(bitDepth)) return null;
  if (compression !== 0 || filterMethod !== 0) return null;
  if (interlace !== 0 && interlace !== 1) return null;
  const bitsPerPixel = bitDepth * channels;
  const passRaw = (pw, ph) => (pw < 1 || ph < 1 ? 0 : (Math.ceil((pw * bitsPerPixel) / 8) + 1) * ph);
  if (interlace === 0) return passRaw(width, height);
  let total = 0;
  for (const [x0, y0, dx, dy] of ADAM7_PASSES) {
    total += passRaw(Math.ceil((width - x0) / dx), Math.ceil((height - y0) / dy));
  }
  return total;
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
  const idatParts = [];
  let i = 8;
  let sawIHDR = false;
  let sawIDAT = false;
  let sawIEND = false;
  let iendEnd = -1;
  let ihdrData = null;
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
      ihdrData = bytes.subarray(i + 8, i + 8 + len);
    }
    if (type === 'IDAT') {
      sawIDAT = true;
      idatParts.push(bytes.subarray(i + 8, i + 8 + len));
    }
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
  // D3：解压前先按 IHDR 算出**期望原始长度**，据此设预算（解压前限尺寸）。
  const expectedRaw = pngRawSize(ihdrData);
  if (expectedRaw === null || expectedRaw < 1) return failed(bytes);
  if (expectedRaw > MAX_DECODED_IMAGE_BYTES) return failed(bytes);
  // C2 + D3：压缩流必须非空，且**在受限预算内**解压出的长度精确等于期望值 ——
  // 「空 IDAT + IEND」空壳、不可解压垃圾、以及「小尺寸 IHDR + 高压缩比炸弹」一律拒绝。
  const idat = concat(idatParts);
  if (idat.length < 1) return failed(bytes);
  const raw = inflateBounded(idat, expectedRaw);
  if (raw === null || raw.length !== expectedRaw) return failed(bytes);
  // E3：解压长度精确 ≠ 扫描线有效。逐行核对滤波类型字节（0..4），损坏扫描行受控拒绝。
  if (!pngFiltersValid(raw, ihdrData)) return failed(bytes);
  return { ok: true, data: concat(out), removed };
}

// ------------------------------------------------------------------ WebP

/**
 * 清除 WebP 元数据（RIFF/WEBP + EXIF/XMP chunk）。
 *
 * E2：「有效头」**不等于**「有效媒体」——此前仅解析 5 字节 VP8L 位流头即判可用，
 * 于是「只有头、没有任何像素位流」的空壳（如 44 字节文件）也能进入 ready，
 * 独立解码器（libwebp/Pillow）对同一字节 load 失败。现改为**真实解码**：
 *   - VP8L：必须由 webp.mjs 的 VP8L 解码器**完整走通并恰好产出 W×H 像素**才接受；
 *   - VP8（有损）/ ANIM / ANMF（动画）：本模块**不具备核验其真实内容的能力**，
 *     按「无法核验即拒绝」（fail-closed）一律受控拒绝 —— 绝不接受未经核验的媒体。
 *
 * 其余结构性约束保持不变：RIFF 声明长度须与文件等长（禁尾部走私）、chunk 须恰好铺满、
 * VP8X 画布须与真实图像尺寸一致。
 */
function stripWebp(bytes) {
  if (!(asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP'))) return failed(bytes);
  const riffSize = readU32le(bytes, 4);
  // RIFF 声明长度必须与文件实际长度一致（不允许声明之外的尾部字节）。
  if (riffSize + 8 !== bytes.length) return failed(bytes);
  const body = [bytes.subarray(0, 12)];
  const removed = [];
  let canvas = null;
  let simpleFrame = null; // 真实解码通过的 VP8L 尺寸
  let sawLossy = false;
  let sawAnim = false;
  let sawAnimFrame = false;
  let i = 12;
  while (i + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
    const size = readU32le(bytes, i + 4);
    const total = 8 + size + (size % 2); // 奇数长度补齐到偶数
    const end = i + total;
    if (end > bytes.length) return failed(bytes); // 截断
    const p = i + 8;
    if (fourcc === 'VP8L') {
      // E2：必须**真实解码** —— 完整走通且恰好产出 W×H 像素才接受。
      const decoded = decodeVp8l(bytes.subarray(p, p + size));
      if (!decoded.ok) return failed(bytes);
      if (simpleFrame) return failed(bytes); // 多个简单图像块 → 结构可疑
      simpleFrame = { width: decoded.width, height: decoded.height };
    } else if (fourcc === 'VP8 ') {
      sawLossy = true; // 有损：无法核验真实像素内容，受控拒绝
    } else if (fourcc === 'VP8X') {
      if (size < 10) return failed(bytes);
      canvas = {
        width: ((bytes[p + 4] | (bytes[p + 5] << 8) | (bytes[p + 6] << 16)) & 0xffffff) + 1,
        height: ((bytes[p + 7] | (bytes[p + 8] << 8) | (bytes[p + 9] << 16)) & 0xffffff) + 1,
      };
      if (canvas.width < 1 || canvas.height < 1) return failed(bytes);
    } else if (fourcc === 'ANIM') {
      sawAnim = true;
    } else if (fourcc === 'ANMF') {
      sawAnimFrame = true; // 动画帧：无法核验内容，受控拒绝
    }
    if (fourcc === 'EXIF' || fourcc === 'XMP ') removed.push(`WEBP:${fourcc.trim()}`);
    else body.push(bytes.subarray(i, end));
    i = end;
  }
  if (i !== bytes.length) return failed(bytes); // chunk 未恰好铺满 → 尾部残留
  // fail-closed：有损 / 动画一律拒绝（无法核验其真实内容）。
  if (sawLossy || sawAnim || sawAnimFrame) return failed(bytes);
  // 必须存在**真实可解码的图像数据**（仅 VP8X 扩展头不算）。
  if (!simpleFrame) return failed(bytes);
  if (canvas && (canvas.width !== simpleFrame.width || canvas.height !== simpleFrame.height)) {
    return failed(bytes);
  }
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
