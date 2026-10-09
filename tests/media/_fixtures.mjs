/**
 * GY-I06 媒体测试夹具：构造**结构性最小但真实可解析**的图片/音频字节，
 * 用于魔数探测、EXIF 清除、真实时长与边界回归测试。全部为合成字节，不含任何个人原始媒体。
 */
import { deflateSync } from 'node:zlib';

export function u8(...parts) {
  const flat = parts.flat();
  return Uint8Array.from(flat);
}

export function ascii(s) {
  return Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
}

export function u16le(n) {
  return Uint8Array.from([n & 0xff, (n >> 8) & 0xff]);
}

export function u16be(n) {
  return Uint8Array.from([(n >> 8) & 0xff, n & 0xff]);
}

export function u32be(n) {
  return Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

export function u32le(n) {
  return Uint8Array.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

export function concat(...parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ------------------------------------------------------------------ JPEG

/** JPEG：SOI + APP1(Exif 含 GPS) + APP0(JFIF) + SOS + 熵数据 + EOI。 */
export function jpegWithExif() {
  const exifPayload = concat(ascii('Exif\0\0'), ascii('MM\0*'), u8([0, 0, 0, 8]), ascii('GPSDATA-1.2345,103.9876'));
  const app1 = concat(u8(0xff, 0xe1), u16be(exifPayload.length + 2), exifPayload);
  const jfif = concat(ascii('JFIF\0'), u8([1, 1, 0, 0, 1, 0, 1, 0, 0]));
  const app0 = concat(u8(0xff, 0xe0), u16be(jfif.length + 2), jfif);
  const sos = concat(u8(0xff, 0xda), u16be(8), u8([1, 1, 0, 0, 0x3f, 0x00]));
  return concat(u8(0xff, 0xd8), app1, app0, sos, u8([0x12, 0x34, 0x56, 0x78]), u8(0xff, 0xd9));
}

/** JPEG：无 EXIF（SOI + APP0 + SOS + 数据 + EOI）。 */
export function jpegPlain() {
  const jfif = concat(ascii('JFIF\0'), u8([1, 1, 0, 0, 1, 0, 1, 0, 0]));
  const app0 = concat(u8(0xff, 0xe0), u16be(jfif.length + 2), jfif);
  const sos = concat(u8(0xff, 0xda), u16be(8), u8([1, 1, 0, 0, 0x3f, 0x00]));
  return concat(u8(0xff, 0xd8), app0, sos, u8([0x11, 0x22]), u8(0xff, 0xd9));
}

/** JPEG：仅 SOI（无 SOS/EOI），无图像数据。 */
export function jpegSignatureOnly() {
  return u8(0xff, 0xd8);
}

/** JPEG：EOI 之后附加私密尾部字节（走私回归）。 */
export function jpegWithTrailing() {
  return concat(jpegPlain(), ascii('TRAILING-SECRET'));
}

// ------------------------------------------------------------------- PNG

/** CRC32（PNG 规范使用，用于让合成 PNG 结构真实可校验）。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeAndData = concat(ascii(type), data);
  return concat(u32be(data.length), typeAndData, u32be(crc32(typeAndData)));
}

/** 构造可被 zlib 解压的最小 PNG IDAT 数据（1x1 灰度图：filter + 1 字节像素）。 */
function realIdatData() {
  // 原始扫描线：filter(0) + 1 像素(0)，经真实 zlib deflate（含可校验的 zlib 头与 Adler32）。
  const raw = u8([0x00, 0x7f]);
  return deflateSync(raw);
}

/** PNG：签名 + IHDR + eXIf + tEXt + IDAT + IEND（IDAT 为真实可解压流）。 */
export function pngWithExif() {
  const sig = u8([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = pngChunk('IHDR', u8([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]));
  const exif = pngChunk('eXIf', concat(ascii('MM\0*'), u8([0, 0, 0, 8])));
  const text = pngChunk('tEXt', concat(ascii('Comment\0'), ascii('gps:1.2345,103.9876')));
  const idat = pngChunk('IDAT', realIdatData());
  const iend = pngChunk('IEND', u8());
  return concat(sig, ihdr, exif, text, idat, iend);
}

/** PNG：无元数据（IDAT 为真实可解压流）。 */
export function pngPlain() {
  const sig = u8([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = pngChunk('IHDR', u8([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]));
  const idat = pngChunk('IDAT', realIdatData());
  const iend = pngChunk('IEND', u8());
  return concat(sig, ihdr, idat, iend);
}

/** PNG：仅 8 字节签名（无 IHDR/IDAT/IEND），无图像数据。 */
export function pngSignatureOnly() {
  return u8([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

/** PNG：IHDR + 空 IDAT + IEND（有块名但无图像数据，C2 回归）。 */
export function pngEmptyIdat() {
  const sig = u8([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = pngChunk('IHDR', u8([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]));
  const idat = pngChunk('IDAT', u8());
  const iend = pngChunk('IEND', u8());
  return concat(sig, ihdr, idat, iend);
}

/** PNG：IHDR + IDAT(不可解压垃圾) + IEND（C2 回归）。 */
export function pngBadIdat() {
  const sig = u8([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = pngChunk('IHDR', u8([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]));
  const idat = pngChunk('IDAT', u8([0x00, 0x01, 0x02, 0x03, 0x04]));
  const iend = pngChunk('IEND', u8());
  return concat(sig, ihdr, idat, iend);
}

/** PNG：IEND 之后附加合成的 eXIf 伪块（尾部元数据走私回归）。 */
export function pngWithTrailingExif() {
  const base = pngPlain();
  const smuggled = pngChunk('eXIf', concat(ascii('MM\0*'), ascii('SYNTHETIC-GPS-ONLY')));
  return concat(base, smuggled);
}

/** PNG：声明长度超出实际（截断）。 */
export function pngTruncated() {
  const base = pngPlain();
  return base.subarray(0, base.length - 4); // 砍掉 IEND 的 CRC
}

// ------------------------------------------------------------------ WebP

function webpChunk(fourcc, data) {
  const padded = data.length % 2 === 1 ? concat(data, u8([0])) : data;
  return concat(ascii(fourcc), u32le(data.length), padded);
}

/** WebP：RIFF/WEBP + VP8 + EXIF + XMP。 */
export function webpWithExif() {
  const vp8 = webpChunk('VP8 ', u8([1, 2, 3, 4]));
  const exif = webpChunk('EXIF', concat(ascii('MM\0*'), u8([0, 0, 0, 8])));
  const xmp = webpChunk('XMP ', ascii('<x:xmpmeta/>'));
  const body = concat(ascii('WEBP'), vp8, exif, xmp);
  return concat(ascii('RIFF'), u32le(body.length), body);
}

/** WebP：仅 RIFF/WEBP 头（无 VP8 图像块）。 */
export function webpNoImage() {
  const body = ascii('WEBP');
  return concat(ascii('RIFF'), u32le(body.length), body);
}

/** WebP：仅 VP8X 扩展头（10 字节，无 VP8/VP8L/ANMF 帧）——空壳，C2 回归。 */
export function webpVp8xOnly() {
  const vp8x = webpChunk('VP8X', u8([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  const body = concat(ascii('WEBP'), vp8x);
  return concat(ascii('RIFF'), u32le(body.length), body);
}

/** WebP：VP8X 扩展头 + 真实 VP8L 位流（正常可接受）。 */
export function webpVp8xWithLossless() {
  const vp8x = webpChunk('VP8X', u8([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  const vp8l = webpChunk('VP8L', u8([0x2f, 0x01, 0x00, 0x00, 0x00]));
  const body = concat(ascii('WEBP'), vp8x, vp8l);
  return concat(ascii('RIFF'), u32le(body.length), body);
}

// ------------------------------------------------------------------ 音频

/**
 * 构造合法的 PCM WAV（RIFF/WAVE + fmt + data）。
 * @param {{ sampleRate?:number, channels?:number, bitsPerSample?:number, dataBytes:number }} opts
 */
export function pcmWav({ sampleRate = 8000, channels = 1, bitsPerSample = 16, dataBytes }) {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const fmt = concat(
    ascii('fmt '),
    u32le(16),
    u16le(1), // PCM
    u16le(channels),
    u32le(sampleRate),
    u32le(byteRate),
    u16le(blockAlign),
    u16le(bitsPerSample),
  );
  const data = concat(ascii('data'), u32le(dataBytes), new Uint8Array(dataBytes));
  const body = concat(ascii('WAVE'), fmt, data);
  return concat(ascii('RIFF'), u32le(body.length), body);
}

/** 1 秒 PCM WAV（8kHz / 单声道 / 16bit），真实时长 = 1000ms。 */
export function wavBytes() {
  return pcmWav({ dataBytes: 8000 * 2 * 1 });
}

/** 61 秒 PCM WAV（8kHz / 单声道 / 16bit）= 976000 字节数据（<10MiB，但超 60s）。 */
export function wav61Seconds() {
  return pcmWav({ sampleRate: 8000, channels: 1, bitsPerSample: 16, dataBytes: 8000 * 2 * 61 });
}

/** WAV：data 声明长度超出实际（截断回归）。 */
export function wavTruncated() {
  const full = wavBytes();
  return full.subarray(0, full.length - 1000);
}

/**
 * WAV：篡改 fmt.byteRate 为更小值（不改动 data），
 * 使「直接信头 → 时长虚高」的旧实现会误判为超 60s，而结构核对会发现字段不自洽（C1 回归）。
 */
export function wavTamperedByteRate() {
  const bytes = pcmWav({ sampleRate: 8000, channels: 1, bitsPerSample: 16, dataBytes: 8000 * 2 * 1 });
  // fmt 体起始 = 20（RIFF8 + 'WAVE'4 + 'fmt '4 + size4），byteRate 偏移 = 20 + 8。
  const off = 20 + 8;
  bytes[off] = 0x40; // 篡改 byteRate 低字节（原为 16000 = 0x3E80）
  bytes[off + 1] = 0x1f;
  return bytes;
}

/** WAV：fmt 自洽但 data 长度不是 blockAlign 整数倍（帧不对齐，C1 回归）。 */
export function wavUnalignedData() {
  return pcmWav({ sampleRate: 8000, channels: 2, bitsPerSample: 16, dataBytes: 101 });
}

/** WAV：只保留 RIFF/WAVE 头与 fmt，data 为空（C1 回归）。 */
export function wavEmptyData() {
  return pcmWav({ sampleRate: 8000, channels: 1, bitsPerSample: 16, dataBytes: 0 });
}

/** ADTS AAC 帧：protection_absent=1，7 字节头 + payload。 */
function adtsFrame(sfIndex, payloadLen) {
  const frameLength = 7 + payloadLen;
  return concat(
    u8([0xff, 0xf1]),
    u8([(1 << 6) | (sfIndex << 2)]),
    u8([0x40 | ((frameLength >> 11) & 0x03)]),
    u8([(frameLength >> 3) & 0xff]),
    u8([((frameLength & 0x07) << 5) | 0x1f]),
    u8([0xfc]),
    new Uint8Array(payloadLen),
  );
}

/** 合法 ADTS AAC：默认 1 帧 @44100Hz（≈23ms）。 */
export function aacBytes({ frames = 1, sfIndex = 4 } = {}) {
  const parts = [];
  for (let i = 0; i < frames; i += 1) parts.push(adtsFrame(sfIndex, 4));
  return concat(...parts);
}

/** MPEG1 Layer3 帧（44100Hz / 128kbps）。 */
function mp3Frame() {
  const header = u8([0xff, 0xfb, 0x90, 0x00]);
  const frameLength = Math.floor((1152 / 8) * ((128 * 1000) / 44100)); // 417
  return concat(header, new Uint8Array(frameLength - 4));
}

/** MP3：ID3v2(空) + N 个合法帧。 */
export function mp3Bytes({ frames = 5 } = {}) {
  const parts = [ascii('ID3'), u8([3, 0, 0]), u32be(0)];
  for (let i = 0; i < frames; i += 1) parts.push(mp3Frame());
  return concat(...parts);
}

/** MP3：仅 4 字节合法帧头、无帧负载（伪头，C1 回归）。 */
export function mp3FakeHeaderOnly() {
  return u8([0xff, 0xfb, 0x90, 0x00]);
}

/** MP3：1 个完整帧 + 截断的第二帧负载（C1 回归）。 */
export function mp3TruncatedFrame() {
  const full = mp3Bytes({ frames: 2 });
  return full.subarray(0, full.length - 100);
}

/** M4A/ISO BMFF：ftyp('M4A ') + moov>mvhd（timescale=1000, duration=ms）+ trak>mdia>minf>stbl>stsd。 */
export function m4aBytes({ durationMs = 1000, withTrack = true } = {}) {
  const mvhdPayload = concat(u8([0, 0, 0, 0]), u32be(0), u32be(0), u32be(1000), u32be(durationMs));
  const mvhd = concat(u32be(8 + mvhdPayload.length), ascii('mvhd'), mvhdPayload);
  const children = [mvhd];
  if (withTrack) {
    // 最小音轨：trak > mdia > minf > stbl > stsd（stsd 内含 1 个条目）。
    const stsdPayload = concat(u32be(0), u32be(1)); // version/flags + entry_count
    const stsd = concat(u32be(8 + stsdPayload.length), ascii('stsd'), stsdPayload);
    const stbl = concat(u32be(8 + stsd.length), ascii('stbl'), stsd);
    const minf = concat(u32be(8 + stbl.length), ascii('minf'), stbl);
    const mdia = concat(u32be(8 + minf.length), ascii('mdia'), minf);
    const trak = concat(u32be(8 + mdia.length), ascii('trak'), mdia);
    children.push(trak);
  }
  const moovBody = concat(...children);
  const moov = concat(u32be(8 + moovBody.length), ascii('moov'), moovBody);
  const ftyp = concat(u32be(16), ascii('ftyp'), ascii('M4A '), u32be(0));
  return concat(ftyp, moov);
}

/** M4A：有 mvhd 但无任何 trak（无音轨/媒体数据，C1 回归）。 */
export function m4aNoTrack() {
  return m4aBytes({ durationMs: 1000, withTrack: false });
}
