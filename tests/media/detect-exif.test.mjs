import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { detectMediaType } from '../../packages/media/detect.mjs';
import { stripImageMetadata } from '../../packages/media/exif.mjs';
import { decodeVp8l } from '../../packages/media/webp.mjs';
import {
  jpegWithExif,
  jpegPlain,
  pngWithExif,
  pngPlain,
  webpWithExif,
  wavBytes,
  mp3Bytes,
  aacBytes,
  m4aBytes,
  ascii,
  pngSignatureOnly,
  pngWithTrailingExif,
  pngTruncated,
  pngEmptyIdat,
  pngBadIdat,
  jpegSignatureOnly,
  jpegWithTrailing,
  webpNoImage,
  webpVp8xOnly,
  webpVp8xWithLossless,
  pngDecodedBomb,
  pngOversizeDimension,
  pngRawSizeMismatch,
  pngRealRgb,
  pngWithFilter,
  pngBadFilterByte,
  webpVp8lShortHeader,
  webpVp8lBadSignature,
  webpVp8lBadVersion,
  webpVp8xCanvasMismatch,
  webpVp8KeyFrame,
  webpAnimFrames,
  webpAnmfWithoutAnim,
  webpPlainLossless,
  webpVp8xWithBareLosslessHeader,
  webpVp8lTruncated,
  webpVp8lDistanceSymbolOutOfRange,
} from './_fixtures.mjs';

/** 从 PNG 字节中拼接全部 IDAT 负载，用于验证压缩流确实可解压。 */
function pngIdatPayload(bytes) {
  const parts = [];
  let i = 8;
  while (i + 12 <= bytes.length) {
    const len = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    if (type === 'IDAT') parts.push(bytes.subarray(i + 8, i + 8 + len));
    i += 12 + len;
    if (type === 'IEND') break;
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 从 WebP 字节中取出 VP8L chunk 负载（无则 null）。 */
function findVp8lChunk(bytes) {
  let i = 12;
  while (i + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
    const size = bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24);
    if (fourcc === 'VP8L') return bytes.subarray(i + 8, i + 8 + size);
    i += 8 + size + (size % 2);
  }
  return null;
}

function containsBytes(haystack, needleAscii) {
  const needle = ascii(needleAscii);
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

test('魔数探测：真实编码识别（不信扩展名）', () => {
  assert.equal(detectMediaType(jpegWithExif()).mime, 'image/jpeg');
  assert.equal(detectMediaType(pngWithExif()).mime, 'image/png');
  assert.equal(detectMediaType(webpWithExif()).mime, 'image/webp');
  assert.equal(detectMediaType(wavBytes()).mime, 'audio/wav');
  assert.equal(detectMediaType(mp3Bytes()).mime, 'audio/mpeg');
  assert.equal(detectMediaType(aacBytes()).mime, 'audio/aac');
  assert.equal(detectMediaType(m4aBytes()).mime, 'audio/aac');
});

test('魔数探测：未知/过短字节返回 null', () => {
  assert.equal(detectMediaType(new Uint8Array([1, 2, 3])), null);
  assert.equal(detectMediaType(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07])), null);
});

test('JPEG：APP1 Exif（含 GPS）被清除，JFIF 保留', () => {
  const input = jpegWithExif();
  const out = stripImageMetadata(input, 'image/jpeg');
  assert.equal(out.ok, true);
  assert.equal(out.changed, true);
  assert.ok(out.removed.includes('APP1:Exif'), `removed=${out.removed}`);
  assert.equal(containsBytes(out.data, 'Exif'), false, '不应残留 Exif 段');
  assert.equal(containsBytes(out.data, 'GPSDATA'), false, '不应残留 GPS 数据');
  assert.equal(containsBytes(out.data, 'JFIF'), true, 'JFIF 应保留');
  assert.deepEqual([out.data[0], out.data[1]], [0xff, 0xd8], '应以 SOI 开头');
  assert.ok(out.data.length < input.length);
});

test('JPEG：无 EXIF 时不变', () => {
  const input = jpegPlain();
  const out = stripImageMetadata(input, 'image/jpeg');
  assert.equal(out.ok, true);
  assert.equal(out.changed, false);
  assert.deepEqual([...out.data], [...input]);
});

test('PNG：eXIf / tEXt 被清除', () => {
  const input = pngWithExif();
  const out = stripImageMetadata(input, 'image/png');
  assert.equal(out.ok, true);
  assert.equal(out.changed, true);
  assert.ok(out.removed.includes('PNG:eXIf'));
  assert.ok(out.removed.includes('PNG:tEXt'));
  assert.equal(containsBytes(out.data, 'eXIf'), false);
  assert.equal(containsBytes(out.data, 'gps:'), false);
  assert.equal(containsBytes(out.data, 'IDAT'), true, 'IDAT 应保留');
});

test('PNG：无元数据时不变', () => {
  const input = pngPlain();
  const out = stripImageMetadata(input, 'image/png');
  assert.equal(out.changed, false);
});

test('WebP：EXIF / XMP chunk 被清除且 RIFF 长度更新', () => {
  const input = webpWithExif();
  const out = stripImageMetadata(input, 'image/webp');
  assert.equal(out.ok, true);
  assert.equal(out.changed, true);
  assert.ok(out.removed.includes('WEBP:EXIF'));
  assert.ok(out.removed.includes('WEBP:XMP'));
  assert.equal(containsBytes(out.data, 'EXIF'), false);
  assert.equal(containsBytes(out.data, 'XMP '), false);
  assert.equal(containsBytes(out.data, 'VP8L'), true, 'VP8L 位流应保留');
  const riffSize = out.data[4] | (out.data[5] << 8) | (out.data[6] << 16) | (out.data[7] << 24);
  assert.equal(riffSize, out.data.length - 8, 'RIFF 长度应与新体长一致');
});

test('音频不做 EXIF 处理（原样返回）', () => {
  const wav = wavBytes();
  const out = stripImageMetadata(wav, 'audio/wav');
  assert.equal(out.changed, false);
  assert.deepEqual([...out.data], [...wav]);
});

// ------------------------------------------------ B1 回归：PNG 尾部与完整结构

test('B1 PNG：仅 8 字节签名（无图像数据）→ 拒绝', () => {
  const out = stripImageMetadata(pngSignatureOnly(), 'image/png');
  assert.equal(out.ok, false, '仅签名不得判为可清理/可发布');
});

test('B1 PNG：IEND 之后的尾部 eXIf 走私 → 拒绝', () => {
  const input = pngWithTrailingExif();
  // 前置条件：尾部确实残留了合成 GPS 标记
  assert.equal(containsBytes(input, 'SYNTHETIC-GPS-ONLY'), true);
  const out = stripImageMetadata(input, 'image/png');
  assert.equal(out.ok, false, 'IEND 之后有尾部字节必须拒绝');
});

test('B1 PNG：截断（长度域超出实际）→ 拒绝', () => {
  const out = stripImageMetadata(pngTruncated(), 'image/png');
  assert.equal(out.ok, false);
});

test('B1 PNG：合法文件对外字节不再原样回退，且逐块重建', () => {
  const input = pngWithExif();
  const out = stripImageMetadata(input, 'image/png');
  assert.equal(out.ok, true);
  assert.equal(containsBytes(out.data, 'eXIf'), false);
  assert.equal(containsBytes(out.data, 'gps:'), false);
  assert.equal(containsBytes(out.data, 'IHDR'), true);
  assert.equal(containsBytes(out.data, 'IDAT'), true);
  assert.equal(containsBytes(out.data, 'IEND'), true);
});

// ------------------------------------------------ B1 回归：JPEG / WebP 完整性

test('B1 JPEG：仅 SOI（无图像数据）→ 拒绝', () => {
  assert.equal(stripImageMetadata(jpegSignatureOnly(), 'image/jpeg').ok, false);
});

test('B1 JPEG：EOI 之后的尾部字节 → 拒绝', () => {
  assert.equal(stripImageMetadata(jpegWithTrailing(), 'image/jpeg').ok, false);
});

test('B1 WebP：无 VP8/VP8L/VP8X 图像块 → 拒绝', () => {
  assert.equal(stripImageMetadata(webpNoImage(), 'image/webp').ok, false);
});

// ------------------------------------------------ C2 回归：真实图像数据校验

test('C2 PNG 正例：合成图片 IDAT 压缩流可被真实 zlib 解压（夹具可信度）', () => {
  const input = pngWithExif();
  const idat = pngIdatPayload(input);
  assert.ok(idat.length > 0, 'IDAT 负载不应为空');
  const raw = inflateSync(Buffer.from(idat));
  assert.ok(raw.length > 0, 'IDAT 必须能解出非空扫描线数据');
});

test('C2 PNG：清元数据后 IDAT 仍可解压（输出仍为有效图像）', () => {
  const out = stripImageMetadata(pngWithExif(), 'image/png');
  assert.equal(out.ok, true);
  const raw = inflateSync(Buffer.from(pngIdatPayload(out.data)));
  assert.ok(raw.length > 0);
});

test('C2 PNG：IHDR + 空 IDAT + IEND（有块名无数据）→ 拒绝', () => {
  assert.equal(stripImageMetadata(pngEmptyIdat(), 'image/png').ok, false);
});

test('C2 PNG：IDAT 为不可解压垃圾 → 拒绝', () => {
  assert.equal(stripImageMetadata(pngBadIdat(), 'image/png').ok, false);
});

test('C2 WebP：仅 10 字节 VP8X 扩展头（无实际帧）→ 拒绝', () => {
  assert.equal(stripImageMetadata(webpVp8xOnly(), 'image/webp').ok, false);
});

test('C2 WebP：VP8X 扩展头 + 真实 VP8L 位流 → 接受', () => {
  const out = stripImageMetadata(webpVp8xWithLossless(), 'image/webp');
  assert.equal(out.ok, true);
});

// ------------------------------------------------ D3 回归：解压预算与资源耗尽

test('D3 PNG：小体积 IDAT 高压缩比炸弹（1×1 声明 / 解出 1 MiB）→ 拒绝', () => {
  const input = pngDecodedBomb();
  // 前置：文件本身体积很小（~1 KB），却能解出 1 MiB —— 正是资源耗尽构造
  assert.ok(input.length < 4096, `炸弹文件应很小，实际 ${input.length}`);
  const raw = inflateSync(Buffer.from(pngIdatPayload(input)));
  assert.equal(raw.length, 1048576, '前置：该 IDAT 不设预算时会解出 1 MiB');
  // 修复后：按 IHDR 期望（2 字节）设预算 → 解压立即中止并拒绝
  assert.equal(stripImageMetadata(input, 'image/png').ok, false);
});

test('D3 PNG：IHDR 声明超大尺寸（超出解码上界）→ 解压前拒绝', () => {
  assert.equal(stripImageMetadata(pngOversizeDimension(), 'image/png').ok, false);
});

test('D3 PNG：解压长度与 IHDR 期望不符（2 期望 / 3 实际）→ 拒绝', () => {
  assert.equal(stripImageMetadata(pngRawSizeMismatch(), 'image/png').ok, false);
});

test('D3 PNG 正例：真实可解码图解压长度精确匹配 IHDR → 接受', () => {
  const input = pngRealRgb({ width: 4, height: 3 });
  const out = stripImageMetadata(input, 'image/png');
  assert.equal(out.ok, true);
  const raw = inflateSync(Buffer.from(pngIdatPayload(out.data)));
  assert.equal(raw.length, (4 * 3 + 1) * 3, '解压原始长度应精确等于 (rowBytes+1)×height');
});

// ------------------------------------------------ D2 回归：WebP 真实位流可用性

test('D2 WebP：VP8L 负载仅 1 字节（无完整位流头）→ 拒绝（监工反例）', () => {
  const input = webpVp8lShortHeader();
  assert.equal(input.length, 22, `应复现监工 22 字节构造，实际 ${input.length}`);
  assert.equal(stripImageMetadata(input, 'image/webp').ok, false);
});

test('D2 WebP：VP8L 位流签名非法（非 0x2f）→ 拒绝', () => {
  assert.equal(stripImageMetadata(webpVp8lBadSignature(), 'image/webp').ok, false);
});

test('D2 WebP：VP8L 位流版本非 0 → 拒绝', () => {
  assert.equal(stripImageMetadata(webpVp8lBadVersion(), 'image/webp').ok, false);
});

test('D2 WebP：VP8L 尺寸与 VP8X 画布不符 → 拒绝', () => {
  assert.equal(stripImageMetadata(webpVp8xCanvasMismatch(), 'image/webp').ok, false);
});

test('D2 WebP：有 ANMF 但缺 ANIM 头 → 拒绝', () => {
  assert.equal(stripImageMetadata(webpAnmfWithoutAnim(), 'image/webp').ok, false);
});

test('D2 WebP：VP8（有损）位流 → 受控拒绝（本模块无法核验其真实内容）', () => {
  assert.equal(stripImageMetadata(webpVp8KeyFrame({ width: 4, height: 4 }), 'image/webp').ok, false);
});

test('D2 WebP：VP8X + ANIM + ANMF 动画 → 受控拒绝（本模块无法核验其真实内容）', () => {
  assert.equal(stripImageMetadata(webpAnimFrames(), 'image/webp').ok, false);
});

// ------------------------------------------- E3 回归：PNG 扫描行滤波类型校验

test('E3 PNG 反例（监工构造）：IDAT=zlib([0xff,0]) 长度精确但滤波字节非法 → 拒绝', () => {
  const input = pngBadFilterByte();
  // 前置：IDAT 确实可解压且长度精确（2 字节 = 1 行 filter + 1 像素），仅滤波字节非法
  const raw = inflateSync(Buffer.from(pngIdatPayload(input)));
  assert.equal(raw.length, 2, '前置：解压长度精确等于 IHDR 期望');
  assert.equal(raw[0], 0xff, '前置：首字节 0xff 不是合法滤波类型（0..4）');
  assert.equal(stripImageMetadata(input, 'image/png').ok, false);
});

test('E3 PNG 正例：每行使用合法非零滤波类型（1..4）→ 接受', () => {
  for (const filter of [1, 2, 3, 4]) {
    const out = stripImageMetadata(pngWithFilter({ width: 4, height: 3, filter }), 'image/png');
    assert.equal(out.ok, true, `filter=${filter} 应被接受`);
  }
});

// ------------------------------------------- E2 回归：WebP 真实帧内容校验

test('E2 WebP 反例①（监工构造）：VP8X + VP8L 仅 5 字节位流头、无像素位流 → 拒绝', () => {
  const input = webpVp8xWithBareLosslessHeader();
  assert.equal(input.length, 44, `应复现监工 44 字节构造，实际 ${input.length}`);
  assert.equal(stripImageMetadata(input, 'image/webp').ok, false);
});

test('E2 WebP 反例②：VP8L 位流被截断（像素位流不完整）→ 拒绝', () => {
  assert.equal(stripImageMetadata(webpVp8lTruncated(), 'image/webp').ok, false);
});

test('E2 WebP 反例③：VP8L 前缀码越界（距离码符号 > 39）→ 拒绝', () => {
  assert.equal(stripImageMetadata(webpVp8lDistanceSymbolOutOfRange(), 'image/webp').ok, false);
});

test('E2 WebP 正例：普通（无 VP8X）真实无损 VP8L 位流 → 接受', () => {
  assert.equal(stripImageMetadata(webpPlainLossless({ width: 8, height: 8 }), 'image/webp').ok, true);
});

test('E2 WebP：清 EXIF 后源字节确为真实可解码 VP8L（输出仍可解码）', () => {
  const out = stripImageMetadata(webpWithExif(), 'image/webp');
  assert.equal(out.ok, true);
  const chunk = findVp8lChunk(out.data);
  assert.ok(chunk, '输出应保留 VP8L chunk');
  const decoded = decodeVp8l(chunk);
  assert.equal(decoded.ok, true, `输出 VP8L 应可真实解码：${JSON.stringify(decoded)}`);
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 4);
});

test('E2 WebP 正例：VP8X 画布与真实 VP8L 尺寸一致 → 接受（并保留 VP8X）', () => {
  const out = stripImageMetadata(webpVp8xWithLossless(), 'image/webp');
  assert.equal(out.ok, true);
  const decoded = decodeVp8l(findVp8lChunk(out.data));
  assert.deepEqual([decoded.width, decoded.height], [2, 1]);
});

test('E2 WebP：真实无损 VP8L 位流可被独立解码器读出正确尺寸（夹具可信度）', () => {
  const decoded = decodeVp8l(findVp8lChunk(webpPlainLossless({ width: 8, height: 8 })));
  assert.equal(decoded.ok, true);
  assert.deepEqual([decoded.width, decoded.height], [8, 8]);
});
