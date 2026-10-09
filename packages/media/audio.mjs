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
 *   - M4A   （ISO BMFF，moov>mvhd 的 duration / timescale）
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

/** 解析 M4A（ISO BMFF）真实时长：moov > mvhd 的 duration / timescale。 */
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
  const moov = findBox(0, bytes.length, 'moov');
  if (!moov) return { ok: false, reason: 'no_moov' };
  const mvhd = findBox(moov.start, moov.end, 'mvhd');
  if (!mvhd) return { ok: false, reason: 'no_mvhd' };
  // C1：mvhd 时长 ≠ 存在可解码音频。必须至少有一条音轨，且该音轨具备媒体数据描述。
  // 结构：moov > trak > mdia > minf > stbl > stsd（样本描述表）。
  let sawAudioTrack = false;
  {
    let t = moov.start;
    while (t + 8 <= moov.end) {
      const ttype = String.fromCharCode(bytes[t + 4], bytes[t + 5], bytes[t + 6], bytes[t + 7]);
      let tlen = readU32be(bytes, t);
      let theader = 8;
      if (tlen === 1) {
        if (t + 16 > moov.end) break;
        tlen = readU32be(bytes, t + 8) * 4294967296 + readU32be(bytes, t + 12);
        theader = 16;
      } else if (tlen === 0) {
        tlen = moov.end - t;
      }
      if (tlen < theader || t + tlen > moov.end) return { ok: false, reason: 'bad_moov_child' };
      if (ttype === 'trak') {
        const mdia = findBox(t + theader, t + tlen, 'mdia');
        if (mdia) {
          const minf = findBox(mdia.start, mdia.end, 'minf');
          if (minf) {
            const stbl = findBox(minf.start, minf.end, 'stbl');
            if (stbl) {
              const stsd = findBox(stbl.start, stbl.end, 'stsd');
              if (stsd && stsd.end - stsd.start >= 8) sawAudioTrack = true;
            }
          }
        }
      }
      t += tlen;
    }
  }
  if (!sawAudioTrack) return { ok: false, reason: 'no_audio_track' };
  const version = bytes[mvhd.start];
  let timescale;
  let duration;
  if (version === 1) {
    if (mvhd.start + 32 > mvhd.end) return { ok: false, reason: 'bad_mvhd' };
    timescale = readU32be(bytes, mvhd.start + 20);
    duration = readU32be(bytes, mvhd.start + 24) * 4294967296 + readU32be(bytes, mvhd.start + 28);
  } else {
    if (mvhd.start + 20 > mvhd.end) return { ok: false, reason: 'bad_mvhd' };
    timescale = readU32be(bytes, mvhd.start + 12);
    duration = readU32be(bytes, mvhd.start + 16);
  }
  if (!timescale) return { ok: false, reason: 'bad_timescale' };
  return { ok: true, container: 'm4a', durationMs: Math.round((duration / timescale) * 1000) };
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
