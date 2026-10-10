/**
 * GY-I06 媒体模块 · 音频**真实时长**解析（返修 B2）。
 *
 * 背景：此前只校验调用方声明的 `duration_ms` 范围，真实媒体时长未参与判断，
 * 导致「实际 61s、声明 1000ms」的合法 WAV 仍被判 ready，绕过 60 秒上限。
 *
 * 本模块按**有效编码**从字节解析真实时长；对接受的四类音频容器各自实现：
 *   - WAV   （RIFF/WAVE，PCM 等，按 fmt.byteRate 与 data 块长度计算）
 *   - ADTS  （AAC，逐帧累计样本数 / 采样率）
 *   - MPEG  （MP3，逐帧累计样本数 / 采样率；支持跳过 ID3v2）
 *   - M4A   （ISO BMFF，D1：须有 mdat + 音频 trak（hdlr=soun）+ mdhd + stsd 真实 sample entry
 *            + 样本表 stsz/stts/stco；时长取 stts 样本累计 / mdhd.timescale，不取容器 mvhd）
 *
 * 红线：**无法解析真实时长一律受控拒绝**（调用方转 INVALID_REQUEST），
 * 绝不回退到「信任调用方声明」。这样即便遇到未知编码变体，也不会出现绕过上限的通道。
 *
 * 说明：本模块不处理供应商采样率适配（属另一验收项），只做「真实时长」判定。
 */

const ADTS_SAMPLE_RATES = Object.freeze([
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
]);

/** MPEG1 位率表（kbps），索引 [layer]。 */
const MPEG1_BITRATE = Object.freeze({
  1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
});

/** MPEG2 / 2.5 位率表（kbps），索引 [layer]。 */
const MPEG2_BITRATE = Object.freeze({
  1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
});

function readU16le(b, o) {
  return (b[o] | (b[o + 1] << 8)) >>> 0;
}

function readU32le(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function readU32be(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function asciiAt(b, o, s) {
  if (b.length < o + s.length) return false;
  for (let i = 0; i < s.length; i += 1) {
    if (b[o + i] !== s.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * 解析 WAV（RIFF/WAVE）真实时长。
 * 严格：chunk 越界即视为截断；data 声明长度必须完整存在。
 */
export function wavDurationMs(bytes) {
  const riffSize = readU32le(bytes, 4);
  if (bytes.length < 12 || riffSize + 8 > bytes.length) return { ok: false, reason: 'truncated_riff' };
  let fmt = null;
  let dataStart = -1;
  let dataSize = -1;
  let i = 12;
  while (i + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
    const size = readU32le(bytes, i + 4);
    const bodyStart = i + 8;
    const end = bodyStart + size;
    if (end > bytes.length) return { ok: false, reason: 'truncated_chunk' };
    if (id === 'fmt ') {
      if (size < 16) return { ok: false, reason: 'bad_fmt' };
      fmt = {
        audioFormat: readU16le(bytes, bodyStart),
        channels: readU16le(bytes, bodyStart + 2),
        sampleRate: readU32le(bytes, bodyStart + 4),
        byteRate: readU32le(bytes, bodyStart + 8),
        blockAlign: readU16le(bytes, bodyStart + 12),
        bitsPerSample: readU16le(bytes, bodyStart + 14),
      };
    } else if (id === 'data' && dataStart < 0) {
      dataStart = bodyStart;
      dataSize = size;
    }
    i = end + (size % 2);
  }
  if (!fmt || dataStart < 0) return { ok: false, reason: 'missing_fmt_or_data' };
  if (fmt.channels < 1 || fmt.sampleRate < 1 || fmt.byteRate < 1) return { ok: false, reason: 'bad_fmt_values' };
  if (dataStart + dataSize > bytes.length) return { ok: false, reason: 'truncated_data' };
  if (dataSize < 1) return { ok: false, reason: 'empty_data' };
  // C1：不得直接信任头里的 byteRate。fmt 各字段必须自洽，否则可篡改 byteRate 绕过 60s 上限。
  if (fmt.bitsPerSample < 1 || fmt.blockAlign < 1) return { ok: false, reason: 'bad_fmt_values' };
  const expectedBlockAlign = (fmt.channels * fmt.bitsPerSample) / 8;
  if (!Number.isInteger(expectedBlockAlign) || expectedBlockAlign !== fmt.blockAlign) {
    return { ok: false, reason: 'inconsistent_fmt_block_align' };
  }
  if (fmt.byteRate !== fmt.sampleRate * fmt.blockAlign) return { ok: false, reason: 'inconsistent_fmt_byte_rate' };
  // data 块长度必须是 blockAlign 的整数倍（整帧对齐），否则无法可靠核对时长。
  if (dataSize % fmt.blockAlign !== 0) return { ok: false, reason: 'data_not_frame_aligned' };
  const ms = (dataSize / fmt.byteRate) * 1000;
  return { ok: true, container: 'wav', durationMs: Math.max(0, Math.round(ms)), sampleRate: fmt.sampleRate };
}

/**
 * 解析 ADTS（AAC）真实时长：逐帧累计 1024 样本 / 采样率。
 * 严格：同步字非法、帧长越界、尾部残留均视为失败。
 */
export function adtsDurationMs(bytes) {
  let i = 0;
  let frames = 0;
  let samples = 0;
  let sampleRate = null;
  while (i + 7 <= bytes.length) {
    if (!(bytes[i] === 0xff && (bytes[i + 1] & 0xf0) === 0xf0)) return { ok: false, reason: 'bad_adts_sync' };
    const protectionAbsent = bytes[i + 1] & 0x01;
    const sfIndex = (bytes[i + 2] >> 2) & 0x0f;
    if (sfIndex >= ADTS_SAMPLE_RATES.length) return { ok: false, reason: 'bad_adts_sf' };
    const frameLength = ((bytes[i + 3] & 0x03) << 11) | (bytes[i + 4] << 3) | (bytes[i + 5] >> 5);
    const headerLen = protectionAbsent ? 7 : 9;
    if (frameLength < headerLen || i + frameLength > bytes.length) return { ok: false, reason: 'truncated_adts' };
    if (sampleRate === null) sampleRate = ADTS_SAMPLE_RATES[sfIndex];
    frames += 1;
    samples += 1024;
    i += frameLength;
  }
  if (frames === 0) return { ok: false, reason: 'no_adts_frame' };
  if (i !== bytes.length) return { ok: false, reason: 'adts_trailing' };
  return { ok: true, container: 'adts', durationMs: Math.round((samples / sampleRate) * 1000), sampleRate };
}

/** 解析单个 MPEG 音频帧头；非法返回 null。 */
function parseMpegFrame(b, o) {
  const b1 = b[o + 1];
  const b2 = b[o + 2];
  const versionBits = (b1 >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5, 1=保留
  const layerBits = (b1 >> 1) & 0x03; // 3=I, 2=II, 1=III
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sfIndex = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  if (versionBits === 1 || layerBits === 0) return null;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sfIndex === 3) return null;
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const layer = layerBits === 3 ? 1 : layerBits === 2 ? 2 : 3;
  const srTable = version === 1 ? [44100, 48000, 32000] : version === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000];
  const sampleRate = srTable[sfIndex];
  const bitrate = (version === 1 ? MPEG1_BITRATE : MPEG2_BITRATE)[layer][bitrateIndex];
  if (!bitrate) return null;
  const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576;
  const frameLength =
    layer === 1
      ? Math.floor(12 * ((bitrate * 1000) / sampleRate) + padding) * 4
      : Math.floor((samplesPerFrame / 8) * ((bitrate * 1000) / sampleRate)) + padding;
  if (frameLength < 4) return null;
  return { sampleRate, samplesPerFrame, frameLength };
}

/**
 * 解析 MPEG（MP3）真实时长：跳过 ID3v2 后逐帧累计样本数。
 * 严格：首帧即须可解析；帧采样率须一致；结构异常即失败。
 */
export function mpegDurationMs(bytes) {
  if (bytes.length < 4) return { ok: false, reason: 'too_short' };
  let i = 0;
  if (asciiAt(bytes, 0, 'ID3')) {
    if (bytes.length < 10) return { ok: false, reason: 'bad_id3' };
    const size =
      ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    i = 10 + size;
    if (i > bytes.length) return { ok: false, reason: 'truncated_id3' };
  }
  let frames = 0;
  let samples = 0;
  let sampleRate = null;
  let j = i;
  while (j + 4 <= bytes.length) {
    if (bytes[j] === 0xff && (bytes[j + 1] & 0xe0) === 0xe0 && (bytes[j + 1] & 0x06) !== 0) {
      const h = parseMpegFrame(bytes, j);
      if (h) {
        // C1：帧头可解析 ≠ 帧负载存在。必须整帧落在缓冲区内，否则只是 4 字节伪头。
        if (j + h.frameLength > bytes.length) return { ok: false, reason: 'truncated_mpeg_frame' };
        if (sampleRate === null) sampleRate = h.sampleRate;
        if (h.sampleRate !== sampleRate) return { ok: false, reason: 'inconsistent_mpeg' };
        frames += 1;
        samples += h.samplesPerFrame;
        j += h.frameLength;
        continue;
      }
    }
    if (frames === 0) return { ok: false, reason: 'no_mpeg_frame' };
    return { ok: false, reason: 'mpeg_garbage_after_frames' };
  }
  if (frames === 0) return { ok: false, reason: 'no_mpeg_frame' };
  if (j !== bytes.length) return { ok: false, reason: 'mpeg_trailing' };
  return { ok: true, container: 'mpeg', durationMs: Math.round((samples / sampleRate) * 1000), sampleRate };
}

/** M4A 中可识别的音频 sample entry 格式码（fail-closed：仅接受已知音频编码）。 */
const M4A_AUDIO_SAMPLE_FORMATS = Object.freeze([
  'mp4a', 'alac', 'ac-3', 'ec-3', 'Opus', 'fLaC', 'lpcm', 'samr', 'sawb',
]);

/**
 * stsd（样本描述表）是否含**真实 sample entry**：
 * `version/flags(4) + entry_count(4) + entry[size(4) + format(4) + …]`。
 * 「entry_count=1 但没有任何 entry」的空壳必须判否（D1）。
 */
function audioDescriptions(bytes, stsd) {
  if (stsd.end - stsd.start < 8 || readU32be(bytes, stsd.start) !== 0) return null;
  const count = readU32be(bytes, stsd.start + 4);
  if (count < 1 || count > (stsd.end - stsd.start - 8) / 8) return null;
  const descriptions = new Set();
  let e = stsd.start + 8;
  for (let index = 1; index <= count; index += 1) {
    if (e + 8 > stsd.end) return null;
    const entrySize = readU32be(bytes, e);
    if (entrySize < 8 || e + entrySize > stsd.end) return null;
    const format = String.fromCharCode(bytes[e + 4], bytes[e + 5], bytes[e + 6], bytes[e + 7]);
    // Require the common audio sample-entry header; codec payloads are not decoded here.
    if (M4A_AUDIO_SAMPLE_FORMATS.includes(format) && entrySize >= 36) descriptions.add(index);
    e += entrySize;
  }
  return e === stsd.end ? descriptions : null;
}

/**
 * stsz（样本大小表）摘要：`version/flags(4) + sample_size(4) + sample_count(4) [+ 每样本大小(4)]`。
 * 返回 `{ sampleCount, totalBytes }`；**计数为 0 / 每样本条目被截断**返回 null（不可核验）。
 */
function stszSummary(bytes, stsz) {
  if (stsz.end - stsz.start < 12 || readU32be(bytes, stsz.start) !== 0) return null;
  const sampleSize = readU32be(bytes, stsz.start + 4);
  const sampleCount = readU32be(bytes, stsz.start + 8);
  if (sampleCount < 1) return null;
  if (sampleSize > 0) {
    if (stsz.start + 12 !== stsz.end) return null;
    const totalBytes = sampleSize * sampleCount;
    return Number.isSafeInteger(totalBytes) ? { sampleCount, totalBytes, sampleSize } : null;
  }
  // sample_size==0 → 必须紧跟 sample_count 个 4 字节样本大小，且恰好落在 box 内。
  if (stsz.start + 12 + sampleCount * 4 !== stsz.end) return null;
  let total = 0;
  const entries = [];
  for (let k = 0; k < sampleCount; k += 1) {
    const size = readU32be(bytes, stsz.start + 12 + k * 4);
    if (size < 1) return null;
    entries.push(size);
    total += size;
  }
  return Number.isSafeInteger(total) ? { sampleCount, totalBytes: total, sampleSize, entries } : null;
}

/**
 * stts（time-to-sample）摘要：各条目 `sample_count × sample_delta`。
 * 返回 `{ totalUnits, sampleCount }`；**声明的 entry_count 没有对应条目数据**（条目截断）
 * 即返回 null —— E1：这正是监工「把 entry_count 从 1 改成 2 却不追加条目」的反例，
 * 旧实现据此判 null 后**回退信任 mvhd 时长**，现已必须受控拒绝。
 */
function sttsSummary(bytes, stts) {
  if (stts.end - stts.start < 8) return null;
  const count = readU32be(bytes, stts.start + 4);
  if (count < 1) return null;
  if (stts.start + 8 + count * 8 > stts.end) return null; // 条目数不符 / 截断
  let totalUnits = 0;
  let sampleCount = 0;
  for (let k = 0; k < count; k += 1) {
    const sc = readU32be(bytes, stts.start + 8 + k * 8);
    const sd = readU32be(bytes, stts.start + 12 + k * 8);
    totalUnits += sc * sd;
    sampleCount += sc;
  }
  return { totalUnits, sampleCount };
}

/**
 * stco / co64（chunk 偏移表）：返回**绝对文件偏移**数组。
 * 条目数为 0 / 偏移表被截断返回 null（E1：仅检查 box 存在不足以证明样本定位有效）。
 */
function chunkOffsets(bytes, box, sixtyFour) {
  if (box.end - box.start < 8 || readU32be(bytes, box.start) !== 0) return null;
  const count = readU32be(bytes, box.start + 4);
  if (count < 1) return null;
  const width = sixtyFour ? 8 : 4;
  if (box.start + 8 + count * width !== box.end) return null;
  const offsets = [];
  for (let k = 0; k < count; k += 1) {
    const o = box.start + 8 + k * width;
    const offset = sixtyFour ? readU32be(bytes, o) * 4294967296 + readU32be(bytes, o + 4) : readU32be(bytes, o);
    if (!Number.isSafeInteger(offset)) return null;
    offsets.push(offset);
  }
  return offsets;
}

/** Expand stsc runs using stsz sizes; validate whole chunks, not only their starts. */
function mappedChunksFit(bytes, stsc, sizes, offsets, descriptions, mdat) {
  if (!stsc || stsc.end - stsc.start < 8 || readU32be(bytes, stsc.start) !== 0) return false;
  const count = readU32be(bytes, stsc.start + 4);
  if (count < 1 || stsc.start + 8 + count * 12 !== stsc.end) return false;
  const runs = [];
  let previous = 0;
  for (let k = 0; k < count; k += 1) {
    const e = stsc.start + 8 + k * 12;
    const first = readU32be(bytes, e);
    const samples = readU32be(bytes, e + 4);
    const description = readU32be(bytes, e + 8);
    if (first <= previous || first > offsets.length || samples < 1 || !descriptions.has(description)) return false;
    runs.push({ first, samples });
    previous = first;
  }
  if (runs[0].first !== 1) return false;
  let sample = 0;
  let run = 0;
  const ranges = [];
  for (let chunk = 0; chunk < offsets.length; chunk += 1) {
    if (run + 1 < runs.length && runs[run + 1].first === chunk + 1) run += 1;
    const n = runs[run].samples;
    if (n > sizes.sampleCount - sample) return false;
    let length = sizes.sampleSize * n;
    if (!sizes.sampleSize) {
      length = 0;
      for (let k = 0; k < n; k += 1) length += sizes.entries[sample + k];
    }
    const start = offsets[chunk];
    const end = start + length;
    if (!Number.isSafeInteger(end) || length < 1 || start < mdat.start || end > mdat.end) return false;
    ranges.push({ start, end });
    sample += n;
  }
  if (sample !== sizes.sampleCount) return false;
  ranges.sort((a, b) => a.start - b.start);
  return ranges.every((range, i) => i === 0 || range.start >= ranges[i - 1].end);
}

/** mdhd（媒体头）的 timescale / duration；非法返回 null。 */
function mdhdTimescale(bytes, mdhd) {
  const v = bytes[mdhd.start];
  if (v === 1) {
    if (mdhd.start + 32 > mdhd.end) return null;
    return {
      timescale: readU32be(bytes, mdhd.start + 20),
      duration: readU32be(bytes, mdhd.start + 24) * 4294967296 + readU32be(bytes, mdhd.start + 28),
    };
  }
  if (mdhd.start + 20 > mdhd.end) return null;
  return { timescale: readU32be(bytes, mdhd.start + 12), duration: readU32be(bytes, mdhd.start + 16) };
}

/**
 * 解析 M4A（ISO BMFF）真实时长。
 *
 * D1：`stsd` 存在 ≠ 有效音轨；`mvhd` 时长 ≠ 有音频。必须核对**实际音轨与样本结构**：
 *   1) 顶层存在 `mdat`（媒体数据）**且负载非空**；
 *   2) 存在 `trak > mdia`，其 `hdlr.handler_type == 'soun'`（音轨，非视频）；
 *   3) 该音轨有 `mdhd`（取**音轨自身** timescale，而非容器 mvhd）；
 *   4) `minf > stbl` 下 `stsd` 含音频 sample entry、并有 `stsz`、`stts`、`stsc`、`stco`/`co64`。
 *
 * E1：**没有样本 / 时间表损坏不能证明时长** —— 必须进一步核对样本结构与媒体内容一致：
 *   - `mdat` 负载必须非空（size==8 的空壳不能证明任何样本存在）；
 *   - `stts` 声明的 `entry_count` 必须有对应条目（截断 → 不可核验），**绝不回退信任 mvhd**；
 *   - `stts` 累计样本数必须等于 `stsz.sample_count`；`stsz` 累计字节须 ≥1 且不超过 `mdat` 负载；
 *   - `stsc` 逐块映射到 `stsz` 样本及有效音频描述，完整字节范围在 `mdat` 内且不重叠。
 *
 * 时长一律取 `stts` 样本累计 / `mdhd.timescale`（不取容器 mvhd）。
 * 任一无法核对 → 受控拒绝（reason 供上层转 `duration_unverifiable`）。仅核验容器/样本定位，不证明 AAC 可解码。
 */
export function m4aDurationMs(bytes) {
  function findBox(off, end, type) {
    let i = off;
    while (i + 8 <= end) {
      let size = readU32be(bytes, i);
      const t = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
      let header = 8;
      if (size === 1) {
        if (i + 16 > end) return null;
        size = readU32be(bytes, i + 8) * 4294967296 + readU32be(bytes, i + 12);
        header = 16;
      } else if (size === 0) {
        size = end - i;
      }
      if (size < header || i + size > end) return null;
      if (t === type) return { start: i + header, end: i + size };
      i += size;
    }
    return null;
  }
  if (!asciiAt(bytes, 4, 'ftyp')) return { ok: false, reason: 'not_ftyp' };
  // 必须存在媒体数据，否则不存在可解码样本。
  const mdat = findBox(0, bytes.length, 'mdat');
  if (!mdat) return { ok: false, reason: 'no_mdat' };
  // E1：有 mdat box ≠ 有媒体数据。空负载（size==8）无法证明任何样本存在。
  if (mdat.end - mdat.start < 1) return { ok: false, reason: 'empty_mdat' };
  const moov = findBox(0, bytes.length, 'moov');
  if (!moov) return { ok: false, reason: 'no_moov' };

  let result = null;
  let t = moov.start;
  while (t + 8 <= moov.end) {
    const ttype = String.fromCharCode(bytes[t + 4], bytes[t + 5], bytes[t + 6], bytes[t + 7]);
    let tlen = readU32be(bytes, t);
    let theader = 8;
    if (tlen === 1) {
      if (t + 16 > moov.end) return { ok: false, reason: 'bad_moov_child' };
      tlen = readU32be(bytes, t + 8) * 4294967296 + readU32be(bytes, t + 12);
      theader = 16;
    } else if (tlen === 0) {
      tlen = moov.end - t;
    }
    if (tlen < theader || t + tlen > moov.end) return { ok: false, reason: 'bad_moov_child' };
    if (ttype === 'trak') {
      const mdia = findBox(t + theader, t + tlen, 'mdia');
      if (mdia) {
        // 音轨判定：hdlr.handler_type == 'soun'（排除视频/字幕等轨道）。
        const hdlr = findBox(mdia.start, mdia.end, 'hdlr');
        const isAudio =
          hdlr &&
          hdlr.end - hdlr.start >= 12 &&
          String.fromCharCode(bytes[hdlr.start + 8], bytes[hdlr.start + 9], bytes[hdlr.start + 10], bytes[hdlr.start + 11]) ===
            'soun';
        if (isAudio) {
          const mdhd = findBox(mdia.start, mdia.end, 'mdhd');
          const minf = findBox(mdia.start, mdia.end, 'minf');
          const stbl = minf ? findBox(minf.start, minf.end, 'stbl') : null;
          if (mdhd && stbl) {
            const stsd = findBox(stbl.start, stbl.end, 'stsd');
            const stsz = findBox(stbl.start, stbl.end, 'stsz');
            const stts = findBox(stbl.start, stbl.end, 'stts');
            const stsc = findBox(stbl.start, stbl.end, 'stsc');
            const stco = findBox(stbl.start, stbl.end, 'stco');
            const co64 = stco ? null : findBox(stbl.start, stbl.end, 'co64');
            const offsetsBox = stco || co64;
            const descriptions = stsd ? audioDescriptions(bytes, stsd) : null;
            if (descriptions && descriptions.size > 0 && stsz && stts && stsc && offsetsBox) {
              const head = mdhdTimescale(bytes, mdhd);
              const sizes = stszSummary(bytes, stsz);
              const times = sttsSummary(bytes, stts);
              const offsets = chunkOffsets(bytes, offsetsBox, co64 !== null);
              if (head && head.timescale >= 1 && sizes && times && offsets) {
                const mdatPayload = mdat.end - mdat.start;
                // E1：样本结构必须自洽，且与 mdat 真实内容一致，否则不能证明时长。
                const consistent =
                  sizes.sampleCount === times.sampleCount &&
                  sizes.totalBytes >= 1 &&
                  sizes.totalBytes <= mdatPayload &&
                  times.totalUnits >= 1 &&
                  mappedChunksFit(bytes, stsc, sizes, offsets, descriptions, mdat);
                if (consistent) {
                  result = { timescale: head.timescale, durationUnits: times.totalUnits };
                  break;
                }
              }
            }
          }
        }
      }
    }
    t += tlen;
  }
  if (!result) return { ok: false, reason: 'no_audio_track' };
  return { ok: true, container: 'm4a', durationMs: Math.round((result.durationUnits / result.timescale) * 1000) };
}

/**
 * 按容器解析音频真实时长。
 * @param {Uint8Array} bytes
 * @returns {{ ok: true, container: string, durationMs: number, sampleRate?: number } | { ok: false, reason: string }}
 */
export function computeAudioDurationMs(bytes) {
  if (!bytes || typeof bytes.length !== 'number' || bytes.length < 4) return { ok: false, reason: 'no_bytes' };
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WAVE')) return wavDurationMs(bytes);
  if (asciiAt(bytes, 0, 'ID3')) return mpegDurationMs(bytes);
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0) return mpegDurationMs(bytes);
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return adtsDurationMs(bytes);
  if (asciiAt(bytes, 4, 'ftyp')) return m4aDurationMs(bytes);
  return { ok: false, reason: 'unknown_container' };
}
