/**
 * GY-R90 · `stripJpeg` 对「EOI 之后的尾随字节」的容忍边界。
 *
 * 背景：真实手机相册 / IM 转存的 JPEG 大量在 EOI（`FF D9`）之后还挂着若干尾随字节
 * （实测本机相册 33 张里 24 张如此，尾随 24 B 甚至 37 KB 量级）。旧实现要求
 * `i === bytes.length`，于是这些照片在 `/media/uploads/:id/complete` 一律
 * 415 `MEDIA_TYPE_UNSUPPORTED 图片解码失败，无法去除元数据`。
 *
 * 本文件钉死两件事，缺一不可：
 *   A. 尾随字节被**丢弃**而不是被拒：输出只保留 `0..EOI`，且以 `FF D9` 结尾；
 *   B. fail-closed 边界**一条都没放宽**：无 SOI、无 EOI（截断）、段长度越界 /
 *      结构损坏、空输入全部仍然判红。
 *
 * 样本全部在内存里合成（最小 JPEG：SOI + APP0(JFIF) + SOS + 熵数据 + EOI），
 * 不提交任何真实图片字节。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stripImageMetadata } from '../../packages/media/exif.mjs';

const u8 = (...parts) => Uint8Array.from(parts.flat());
const u16be = (n) => u8((n >> 8) & 0xff, n & 0xff);
const ascii = (s) => u8([...s].map((c) => c.charCodeAt(0)));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

/** 最小合法 JPEG：SOI + APP0(JFIF) + SOS + 2 字节熵数据 + EOI（无 EXIF，故清理前后应逐字节相同）。 */
function minimalJpeg() {
  const jfif = concat(ascii('JFIF\0'), u8(1, 1, 0, 0, 1, 0, 1, 0, 0));
  const app0 = concat(u8(0xff, 0xe0), u16be(jfif.length + 2), jfif);
  const sos = concat(u8(0xff, 0xda), u16be(8), u8(1, 1, 0, 0, 0x3f, 0x00));
  return concat(u8(0xff, 0xd8), app0, sos, u8(0x12, 0x34), u8(0xff, 0xd9));
}

/** 最小合法 JPEG + 1 个 APP1 Exif 段（含合成 GPS 标记），用于「清理结果不因尾随字节而变」的对照。 */
function minimalJpegWithExif() {
  const exifPayload = concat(ascii('Exif\0\0'), ascii('MM\0*'), u8(0, 0, 0, 8), ascii('GPS-SYNTH'));
  const app1 = concat(u8(0xff, 0xe1), u16be(exifPayload.length + 2), exifPayload);
  const sos = concat(u8(0xff, 0xda), u16be(8), u8(1, 1, 0, 0, 0x3f, 0x00));
  return concat(u8(0xff, 0xd8), app1, sos, u8(0x12, 0x34), u8(0xff, 0xd9));
}

const endsWithEoi = (bytes) => bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ------------------------------------------------------ A. 尾随字节被丢弃（不是被拒）

test('R90 ① EOI 之后 1 个字节 → 通过，且输出以 FF D9 结尾', () => {
  const base = minimalJpeg();
  const out = stripImageMetadata(concat(base, u8(0x00)), 'image/jpeg');
  assert.equal(out.ok, true, 'EOI 后仅 1 字节不应整张拒绝');
  assert.equal(endsWithEoi(out.data), true, '输出必须以 EOI 结尾');
  assert.equal(out.data.length, base.length, '尾随字节必须被丢弃，不得进入输出');
  assert.equal(sameBytes(out.data, base), true, '输出必须逐字节等于「去掉尾随字节的同一张图」');
});

test('R90 ② EOI 之后 37 KiB 尾随字节（含合成元数据）→ 通过且尾随字节不残留', () => {
  const base = minimalJpeg();
  const trailer = new Uint8Array(37 * 1024);
  // 确定性填充：前段是仿 GPS 的明文字节，后段是递增噪声（模拟真实 trailer）。
  const gps = ascii('GPS-SYNTH-TRAILER-1.2345,103.9876');
  trailer.set(gps, 0);
  for (let i = gps.length; i < trailer.length; i += 1) trailer[i] = (i * 31 + 7) & 0xff;

  const input = concat(base, trailer);
  const out = stripImageMetadata(input, 'image/jpeg');
  assert.equal(out.ok, true, 'EOI 后 37 KiB 尾随字节不应整张拒绝');
  assert.equal(endsWithEoi(out.data), true);
  assert.equal(out.data.length, base.length, '输出长度必须就是 0..EOI，不夹带 37 KiB');
  const hay = Buffer.from(out.data).toString('latin1');
  assert.equal(hay.includes('GPS-SYNTH-TRAILER'), false, '尾随字节里的元数据不得残留');
});

test('R90 ⑤ 正常无尾随的 JPEG（回归）：清理前后逐字节一致', () => {
  const input = minimalJpeg();
  const out = stripImageMetadata(input, 'image/jpeg');
  assert.equal(out.ok, true);
  assert.equal(out.changed, false, '无元数据段时 changed 应为 false');
  assert.equal(sameBytes(out.data, input), true, '无尾随字节时输出必须与输入逐字节相同');
  assert.equal(out.data.length, input.length, '不得因新逻辑少一截');
});

test('R90 ⑥ 尾随字节不得改变清理结果：含 Exif 的同一张图，有无尾随的输出必须逐字节相同', () => {
  const base = minimalJpegWithExif();
  const clean = stripImageMetadata(base, 'image/jpeg');
  const withTail = stripImageMetadata(concat(base, new Uint8Array(4096).fill(0xff)), 'image/jpeg');
  assert.equal(clean.ok, true);
  assert.ok(clean.removed.includes('APP1:Exif'), `removed=${clean.removed}`);
  assert.equal(withTail.ok, true);
  assert.deepEqual(withTail.removed, clean.removed, '尾随字节不改变已清除段的判定');
  assert.equal(sameBytes(withTail.data, clean.data), true, '尾随字节不改变输出字节');
});

// --------------------------------------- B. fail-closed 边界：坏样本必须仍然判红

test('R90 ③ 截断（无 EOI）→ 仍然拒绝', () => {
  const base = minimalJpeg();
  const truncated = base.subarray(0, base.length - 2); // 去掉 EOI
  assert.equal(stripImageMetadata(truncated, 'image/jpeg').ok, false, '无 EOI 的截断字节不得判为可清理');
});

test('R90 ③b 熵数据后无任何终止标记（SOS 之内截断）→ 仍然拒绝', () => {
  const base = minimalJpeg();
  assert.equal(stripImageMetadata(base.subarray(0, base.length - 2), 'image/jpeg').ok, false);
  assert.equal(stripImageMetadata(base.subarray(0, base.length - 4), 'image/jpeg').ok, false);
  assert.equal(stripImageMetadata(base.subarray(0, 30), 'image/jpeg').ok, false, 'SOS 段内截断');
});

test('R90 ④ 非 JPEG 头 → 仍然拒绝', () => {
  const pngMagic = u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  assert.equal(stripImageMetadata(pngMagic, 'image/jpeg').ok, false);
  assert.equal(stripImageMetadata(concat(minimalJpeg(), u8(0xff, 0xd9)).subarray(1), 'image/jpeg').ok, false);
  // 明确不是 SOI 的任意字节（含以 FF 开头但第二字节不是 D8）
  assert.equal(stripImageMetadata(u8(0xff, 0xd9, 0xff, 0xd8), 'image/jpeg').ok, false);
});

test('R90 空输入 → 仍然拒绝', () => {
  assert.equal(stripImageMetadata(new Uint8Array(0), 'image/jpeg').ok, false);
  assert.equal(stripImageMetadata(u8(0xff), 'image/jpeg').ok, false, '只有 SOI 首字节也不得放行');
});

test('R90 仅 SOI（无 SOS / 无图像数据）→ 仍然拒绝', () => {
  assert.equal(stripImageMetadata(u8(0xff, 0xd8), 'image/jpeg').ok, false);
  assert.equal(stripImageMetadata(u8(0xff, 0xd8, 0xff, 0xd9), 'image/jpeg').ok, false, 'SOI+EOI 无图像数据');
});

test('R90 SOS 段长度越界 / 段长度非法 → 仍然拒绝', () => {
  const base = minimalJpeg();
  const sosAt = 2 + 2 + 2 + 14; // SOI + APP0(2+2+14) 之后就是 SOS
  assert.equal(base[sosAt], 0xff);
  assert.equal(base[sosAt + 1], 0xda);

  const lenTooBig = Uint8Array.from(base);
  lenTooBig[sosAt + 2] = 0xff;
  lenTooBig[sosAt + 3] = 0xff; // 段长 65535 ≫ 文件长度
  assert.equal(stripImageMetadata(lenTooBig, 'image/jpeg').ok, false, '段长度越过文件尾必须拒绝');

  const lenTooSmall = Uint8Array.from(base);
  lenTooSmall[sosAt + 2] = 0x00;
  lenTooSmall[sosAt + 3] = 0x01; // 段长 1 < 2（非法）
  assert.equal(stripImageMetadata(lenTooSmall, 'image/jpeg').ok, false, '段长 < 2 必须拒绝');
});

test('R90 结构损坏（期望标记但读到非 0xFF）→ 仍然拒绝', () => {
  const base = minimalJpeg();
  const broken = Uint8Array.from(base);
  broken[2] = 0x00; // SOI 之后本该是 FF 开头的段标记
  assert.equal(stripImageMetadata(broken, 'image/jpeg').ok, false);
});
