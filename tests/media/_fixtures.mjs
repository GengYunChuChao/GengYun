/**
 * GY-I06 媒体测试夹具：构造**结构性最小但真实可解析**的图片/音频字节，
 * 用于魔数探测与 EXIF 清除测试。全部为合成字节，不含任何个人原始媒体。
 */
export function u8(...parts) {
  const flat = parts.flat();
  return Uint8Array.from(flat);
}

export function ascii(s) {
  return Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
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

function pngChunk(type, data) {
  return concat(u32be(data.length), ascii(type), data, u32be(0));
}

/** PNG：签名 + IHDR + eXIf + tEXt + IDAT + IEND。 */
export function pngWithExif() {
  const sig = u8([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = pngChunk('IHDR', u8([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]));
  const exif = pngChunk('eXIf', concat(ascii('MM\0*'), u8([0, 0, 0, 8])));
  const text = pngChunk('tEXt', concat(ascii('Comment\0'), ascii('gps:1.2345,103.9876')));
  const idat = pngChunk('IDAT', u8([0x78, 0x9c, 0x01]));
  const iend = pngChunk('IEND', u8());
  return concat(sig, ihdr, exif, text, idat, iend);
}

/** PNG：无元数据。 */
export function pngPlain() {
  const sig = u8([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = pngChunk('IHDR', u8([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]));
  const idat = pngChunk('IDAT', u8([0x78, 0x9c, 0x01]));
  const iend = pngChunk('IEND', u8());
  return concat(sig, ihdr, idat, iend);
}

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

/** WAV：RIFF/WAVE + fmt + data。 */
export function wavBytes() {
  const fmt = concat(ascii('fmt '), u32le(16), u8(new Array(16).fill(0)));
  const data = concat(ascii('data'), u32le(4), u8([1, 2, 3, 4]));
  const body = concat(ascii('WAVE'), fmt, data);
  return concat(ascii('RIFF'), u32le(body.length), body);
}

/** MP3：ID3v2 标签头 + 载荷。 */
export function mp3Bytes() {
  return concat(ascii('ID3'), u8([3, 0, 0]), u32be(0), u8([0xff, 0xfb, 0x90, 0x00]));
}

/** AAC：ADTS 帧同步 + 载荷。 */
export function aacBytes() {
  return concat(u8([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc]), u8([0, 0, 0, 0]));
}

/** M4A/ISO BMFF：size + ftyp + 'M4A '。 */
export function m4aBytes() {
  return concat(u32be(24), ascii('ftyp'), ascii('M4A '), u32be(0), ascii('M4A '));
}
