import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectMediaType } from '../../packages/media/detect.mjs';
import { stripImageMetadata } from '../../packages/media/exif.mjs';
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
  jpegSignatureOnly,
  jpegWithTrailing,
  webpNoImage,
} from './_fixtures.mjs';

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
  assert.equal(containsBytes(out.data, 'VP8 '), true, 'VP8 帧应保留');
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
