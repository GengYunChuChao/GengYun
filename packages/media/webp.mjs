/**
 * GY-I06 媒体模块 · WebP 无损（VP8L）**真实解码**（返修 E2）。
 *
 * 背景：此前 `stripWebp` 只做「结构性」判定（块名存在、位流头可解析），
 * 结果「只有 5 字节 VP8L 头、无任何像素位流」的空壳也能进入 ready —— 独立解码器
 * （libwebp/Pillow）对同一字节 load 失败。返修 E2 的根因即「结构形状 ≠ 可解码内容」。
 *
 * 本模块不再猜测结构，而是**真正解码 VP8L 熵编码图像**：读位流头 → 变换（含子图流）→
 * 颜色缓存 → 五个前缀码（Huffman）→ LZ77 回引 + 颜色缓存索引 → 还原
 * transform 之前的 W×H 像素缓冲。只有**完整走通并恰好产出 W×H 个像素**的位流才判可用；
 * 任何越界/非法构造一律受控拒绝（fail-closed）。
 *
 * 覆盖范围（**有界**，受控拒绝无法核验的变体）：
 *   - 接受：VP8L（无损）位流，含 4 种可选变换、meta-Huffman、颜色缓存、LZ77。
 *   - 拒绝：VP8（有损）与动画（ANIM/ANMF）—— 本模块不具备核验其内容的能力，
 *     按「无法核验即拒绝」原则上游以受控拒绝处理（见 exif.mjs stripWebp）。
 *
 * 本模块为纯 ESM、零第三方依赖（仅位运算与 TypedArray）。
 *
 * 参考：WebP Lossless Bitstream Specification（VP8L）与 libwebp dec/vp8l_dec.c 的位级语义。
 */

/** 单个 VP8L 位流最多产出的像素数（资源上界，与 PNG 的 64MiB 解码上界对齐）。 */
const MAX_PIXELS = 64 * 1024 * 1024 / 4;

/** 最多允许的 Huffman 码组数（meta-Huffman 熵图可能声明，须设界防资源耗尽）。 */
const MAX_HUFFMAN_GROUPS = 65536;

const MAX_CODE_LENGTH = 15;
const NUM_LITERAL_CODES = 256;
const NUM_LENGTH_CODES = 24;
const NUM_DISTANCE_CODES = 40;
const NUM_CODE_LENGTH_CODES = 19;
const CODE_LENGTH_CODES_ALPHABET = 19;

/** 码长码在码流中的出现顺序。 */
const CODE_LENGTH_CODE_ORDER = Object.freeze([
  17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
]);

/** 码长码 16/17/18 的额外位数与重复基数。 */
const CODE_LENGTH_EXTRA_BITS = Object.freeze([2, 3, 7]);
const CODE_LENGTH_REPEAT_OFFSETS = Object.freeze([3, 3, 11]);

/** 距离「平面码」到二维邻域的映射表（前 120 个距离码）。 */
const CODE_TO_PLANE = Object.freeze([
  0x18, 0x07, 0x17, 0x19, 0x28, 0x06, 0x27, 0x29, 0x16, 0x1a,
  0x26, 0x2a, 0x38, 0x05, 0x37, 0x39, 0x15, 0x1b, 0x36, 0x3a,
  0x25, 0x2b, 0x48, 0x04, 0x47, 0x49, 0x14, 0x1c, 0x35, 0x3b,
  0x46, 0x4a, 0x24, 0x2c, 0x58, 0x45, 0x4b, 0x34, 0x3c, 0x03,
  0x57, 0x59, 0x13, 0x1d, 0x56, 0x5a, 0x23, 0x2d, 0x44, 0x4c,
  0x55, 0x5b, 0x33, 0x3d, 0x68, 0x02, 0x67, 0x69, 0x12, 0x1e,
  0x66, 0x6a, 0x22, 0x2e, 0x54, 0x5c, 0x43, 0x4d, 0x65, 0x6b,
  0x32, 0x3e, 0x78, 0x01, 0x77, 0x79, 0x53, 0x5d, 0x11, 0x1f,
  0x64, 0x6c, 0x42, 0x4e, 0x76, 0x7a, 0x21, 0x2f, 0x75, 0x7b,
  0x31, 0x3f, 0x63, 0x6d, 0x52, 0x5e, 0x00, 0x74, 0x7c, 0x41,
  0x4f, 0x10, 0x20, 0x62, 0x6e, 0x30, 0x73, 0x7d, 0x51, 0x5f,
  0x40, 0x72, 0x7e, 0x61, 0x6f, 0x50, 0x71, 0x7f, 0x60, 0x70,
]);

/** 颜色缓存哈希乘子（规格 §4.2.3）。 */
const COLOR_CACHE_MULTIPLIER = 0x1e35a7bd;

class DecodeError extends Error {}

/** LSB-first 位读取器；**越界即抛错**（不接受任何“读不到就当 0”的宽容语义）。 */
class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }

  bits(n) {
    let value = 0;
    for (let i = 0; i < n; i += 1) {
      const byteIndex = this.pos >> 3;
      if (byteIndex >= this.bytes.length) throw new DecodeError('unexpected_eof');
      value |= ((this.bytes[byteIndex] >> (this.pos & 7)) & 1) << i;
      this.pos += 1;
    }
    return value >>> 0;
  }
}

/** 子采样尺寸（向上取整）。 */
function subsample(size, bits) {
  return (size + (1 << bits) - 1) >> bits;
}

/**
 * 由码长表构建解码用规范 Huffman 表。
 * 单符号码（只有一个非零码长）**不消耗任何位**（规格约定）。
 *
 * Kraft 校验：任何情况下都拒绝**超订**（`left < 0`）；对于**不完整**码（`left > 0`），
 * 仅 `allowIncomplete` 为真时放行 —— 该放行只用于「码长码」（19 符号，等价 zlib
 * `inflate_table` 的 `type == CODES` 例外）；数据前缀码仍要求完整（单符号除外）。
 */
function buildHuffman(lengths, alphabetSize, allowIncomplete = false) {
  const count = new Int32Array(MAX_CODE_LENGTH + 1);
  let nonZero = 0;
  let onlySymbol = -1;
  for (let s = 0; s < alphabetSize; s += 1) {
    const l = lengths[s];
    if (l < 0 || l > MAX_CODE_LENGTH) throw new DecodeError('code_length_range');
    if (l > 0) {
      count[l] += 1;
      nonZero += 1;
      onlySymbol = s;
    }
  }
  if (nonZero === 0) throw new DecodeError('empty_prefix_code');
  if (nonZero === 1) return { single: true, symbol: onlySymbol };
  let left = 1;
  for (let len = 1; len <= MAX_CODE_LENGTH; len += 1) {
    left <<= 1;
    left -= count[len];
    if (left < 0) throw new DecodeError('over_subscribed_code');
  }
  if (left !== 0 && !allowIncomplete) throw new DecodeError('incomplete_prefix_code');
  const offsets = new Int32Array(MAX_CODE_LENGTH + 1);
  let total = 0;
  for (let len = 1; len <= MAX_CODE_LENGTH; len += 1) {
    offsets[len] = total;
    total += count[len];
  }
  const symbols = new Int32Array(total);
  const next = Int32Array.from(offsets);
  for (let s = 0; s < alphabetSize; s += 1) {
    const l = lengths[s];
    if (l > 0) symbols[next[l]++] = s;
  }
  return { single: false, count, offsets, symbols };
}

/** 读一个符号（规范 Huffman；MSB-first 累积，等价 puff/`inflate` 语义）。 */
function readSymbol(br, table) {
  if (table.single) return table.symbol;
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= MAX_CODE_LENGTH; len += 1) {
    code |= br.bits(1);
    const c = table.count[len];
    if (code - c < first) return table.symbols[index + code - first];
    index += c;
    first += c;
    first <<= 1;
    code <<= 1;
  }
  throw new DecodeError('bad_prefix_symbol');
}

/**
 * 读取单个前缀码（simple 或 normal 两种编码方式），返回解码表。
 * @param {BitReader} br
 * @param {number} alphabetSize
 */
function readPrefixCode(br, alphabetSize) {
  const lengths = new Int32Array(alphabetSize);
  if (br.bits(1)) {
    // simple：直接给出 1 或 2 个符号（各码长 1）。
    const numSymbols = br.bits(1) + 1;
    const firstSymbolLenCode = br.bits(1);
    const s0 = br.bits(firstSymbolLenCode === 0 ? 1 : 8);
    if (s0 >= alphabetSize) throw new DecodeError('simple_symbol_out_of_range');
    lengths[s0] = 1;
    if (numSymbols === 2) {
      const s1 = br.bits(8);
      if (s1 >= alphabetSize) throw new DecodeError('simple_symbol_out_of_range');
      // 与参考实现（libwebp）一致：两符号相同不视为错误，等价于单符号码（同一 slot 赋值两次）。
      lengths[s1] = 1;
    }
  } else {
    // normal：码长本身用「码长码」前缀编码。
    const codeLengthCodeLengths = new Int32Array(NUM_CODE_LENGTH_CODES);
    const numCodes = br.bits(4) + 4;
    if (numCodes > NUM_CODE_LENGTH_CODES) throw new DecodeError('too_many_code_length_codes');
    for (let i = 0; i < numCodes; i += 1) {
      codeLengthCodeLengths[CODE_LENGTH_CODE_ORDER[i]] = br.bits(3);
    }
    const clTable = buildHuffman(codeLengthCodeLengths, CODE_LENGTH_CODES_ALPHABET, true);
    let maxSymbol;
    if (br.bits(1)) {
      const lengthNbits = 2 + 2 * br.bits(3);
      maxSymbol = 2 + br.bits(lengthNbits);
      if (maxSymbol > alphabetSize) throw new DecodeError('max_symbol_out_of_range');
    } else {
      maxSymbol = alphabetSize;
    }
    let symbol = 0;
    let max = maxSymbol;
    let prevCodeLen = 8; // 规格默认码长
    while (symbol < alphabetSize && max > 0) {
      max -= 1;
      const codeLen = readSymbol(br, clTable);
      if (codeLen < 16) {
        lengths[symbol] = codeLen;
        symbol += 1;
        if (codeLen !== 0) prevCodeLen = codeLen;
      } else {
        const usePrev = codeLen === 16;
        const slot = codeLen - 16;
        const repeat = br.bits(CODE_LENGTH_EXTRA_BITS[slot]) + CODE_LENGTH_REPEAT_OFFSETS[slot];
        if (symbol + repeat > alphabetSize) throw new DecodeError('code_length_repeat_overflow');
        const length = usePrev ? prevCodeLen : 0;
        for (let r = 0; r < repeat; r += 1) {
          lengths[symbol] = length;
          symbol += 1;
        }
      }
    }
  }
  return buildHuffman(lengths, alphabetSize);
}

/**
 * 读取（可能多组的）五元前缀码组。
 * meta-Huffman：熵图（一张子图）逐 tile 指定码组；码组只按**首次出现的顺序**读取。
 */
function readPrefixCodeGroups(br, xsize, ysize, colorCacheBits, allowMeta) {
  let entropyImage = null;
  let precision = 0;
  let mapping = null;
  let numGroups = 1;
  if (allowMeta && br.bits(1)) {
    precision = br.bits(3) + 2;
    const ex = subsample(xsize, precision);
    const ey = subsample(ysize, precision);
    entropyImage = decodeImageStream(br, ex, ey, false);
    const maxGroup = new Int32Array(MAX_HUFFMAN_GROUPS).fill(-1);
    let count = 0;
    for (let i = 0; i < entropyImage.length; i += 1) {
      const g = (entropyImage[i] >>> 8) & 0xffff;
      if (g >= MAX_HUFFMAN_GROUPS) throw new DecodeError('too_many_huffman_groups');
      if (maxGroup[g] === -1) {
        maxGroup[g] = count;
        count += 1;
      }
    }
    numGroups = count;
    mapping = maxGroup;
  }
  const greenSize = NUM_LITERAL_CODES + NUM_LENGTH_CODES + (colorCacheBits > 0 ? 1 << colorCacheBits : 0);
  const groups = [];
  for (let g = 0; g < numGroups; g += 1) {
    groups.push({
      green: readPrefixCode(br, greenSize),
      red: readPrefixCode(br, NUM_LITERAL_CODES),
      blue: readPrefixCode(br, NUM_LITERAL_CODES),
      alpha: readPrefixCode(br, NUM_LITERAL_CODES),
      dist: readPrefixCode(br, NUM_DISTANCE_CODES),
    });
  }
  return { groups, entropyImage, precision, mapping };
}

/** 前缀编码的长度/距离值：`sym>=4` 时读额外位。 */
function readPrefixValue(sym, br) {
  if (sym < 4) return sym + 1;
  const extraBits = (sym - 2) >> 1;
  const offset = (2 + (sym & 1)) << extraBits;
  return offset + br.bits(extraBits) + 1;
}

/** 距离平面码 -> 实际回引距离（像素）。 */
function planeCodeToDistance(width, planeCode) {
  if (planeCode > CODE_TO_PLANE.length) return planeCode - CODE_TO_PLANE.length;
  const distCode = CODE_TO_PLANE[planeCode - 1];
  const yOffset = distCode >> 4;
  const xOffset = 8 - (distCode & 0xf);
  const dist = yOffset * width + xOffset;
  return dist >= 1 ? dist : 1;
}

/** 颜色缓存哈希槽。 */
function cacheSlot(argb, shift) {
  return ((argb * COLOR_CACHE_MULTIPLIER) >>> shift) | 0;
}

/**
 * 解码 LZ77 编码的像素缓冲（transform 之前）。
 * 每个输出像素都会写入颜色缓存（写同值幂等）。
 */
function decodeImageData(br, width, height, colorCacheBits, codeGroups) {
  const total = width * height;
  if (total > MAX_PIXELS) throw new DecodeError('too_many_pixels');
  const out = new Uint32Array(total);
  const cacheSize = colorCacheBits > 0 ? 1 << colorCacheBits : 0;
  const cache = cacheSize > 0 ? new Uint32Array(cacheSize) : null;
  const cacheShift = 32 - colorCacheBits;
  const { groups, entropyImage, precision, mapping } = codeGroups;
  const entropyWidth = entropyImage ? subsample(width, precision) : 0;
  let pos = 0;
  while (pos < total) {
    let group = groups[0];
    if (entropyImage) {
      const x = pos % width;
      const y = (pos / width) | 0;
      const idx = (y >> precision) * entropyWidth + (x >> precision);
      const g = (entropyImage[idx] >>> 8) & 0xffff;
      const dense = mapping[g];
      if (dense < 0 || dense >= groups.length) throw new DecodeError('bad_entropy_group');
      group = groups[dense];
    }
    const symbol = readSymbol(br, group.green);
    if (symbol < NUM_LITERAL_CODES) {
      const red = readSymbol(br, group.red);
      const blue = readSymbol(br, group.blue);
      const alpha = readSymbol(br, group.alpha);
      if (red > 255 || blue > 255 || alpha > 255) throw new DecodeError('literal_out_of_range');
      const pixel = ((alpha << 24) | (red << 16) | (symbol << 8) | blue) >>> 0;
      out[pos] = pixel;
      pos += 1;
      if (cache) cache[cacheSlot(pixel, cacheShift)] = pixel;
    } else if (symbol < NUM_LITERAL_CODES + NUM_LENGTH_CODES) {
      const length = readPrefixValue(symbol - NUM_LITERAL_CODES, br);
      const distSymbol = readSymbol(br, group.dist);
      const distCode = readPrefixValue(distSymbol, br);
      const dist = planeCodeToDistance(width, distCode);
      if (dist < 1 || dist > pos) throw new DecodeError('distance_out_of_range');
      if (pos + length > total) throw new DecodeError('copy_out_of_range');
      for (let k = 0; k < length; k += 1) {
        const pixel = out[pos - dist];
        out[pos] = pixel;
        pos += 1;
        if (cache) cache[cacheSlot(pixel, cacheShift)] = pixel;
      }
    } else {
      if (!cache) throw new DecodeError('cache_symbol_without_cache');
      const cacheIndex = symbol - (NUM_LITERAL_CODES + NUM_LENGTH_CODES);
      if (cacheIndex >= cacheSize) throw new DecodeError('cache_index_out_of_range');
      const pixel = cache[cacheIndex];
      out[pos] = pixel;
      pos += 1;
    }
  }
  return out;
}

/**
 * 解码一个图像流（level0 含变换；子图不含）。
 * 返回 transform 之前的像素缓冲（ARGB，`alpha<<24|red<<16|green<<8|blue`）。
 */
function decodeImageStream(br, xsize, ysize, isLevel0) {
  let transformX = xsize;
  let transformY = ysize;
  let transforms = 0;
  let transformTypes = 0;
  if (isLevel0) {
    while (br.bits(1)) {
      const type = br.bits(2);
      // WebP lossless specification §4: each transform type occurs at most once.
      if (transformTypes & (1 << type)) throw new DecodeError('duplicate_transform');
      transformTypes |= 1 << type;
      if (type === 0 || type === 1) {
        // PREDICTOR / CROSS_COLOR：3 bit 子采样位 + 一张子图流。
        const bits = br.bits(3) + 2;
        decodeImageStream(br, subsample(transformX, bits), subsample(transformY, bits), false);
      } else if (type === 2) {
        // SUBTRACT_GREEN：无附加数据。
      } else {
        // COLOR_INDEXING：颜色表（num_colors × 1 的子图流）。
        const numColors = br.bits(8) + 1;
        const bits = numColors > 16 ? 0 : numColors > 4 ? 1 : numColors > 2 ? 2 : 3;
        transformX = subsample(transformX, bits);
        decodeImageStream(br, numColors, 1, false);
      }
      transforms += 1;
      if (transforms > 4) throw new DecodeError('too_many_transforms');
    }
  }
  let colorCacheBits = 0;
  if (br.bits(1)) {
    colorCacheBits = br.bits(4);
    if (colorCacheBits < 1 || colorCacheBits > 11) throw new DecodeError('bad_color_cache_bits');
  }
  const codeGroups = readPrefixCodeGroups(br, transformX, transformY, colorCacheBits, isLevel0);
  return decodeImageData(br, transformX, transformY, colorCacheBits, codeGroups);
}

/**
 * 真实解码一个 VP8L 位流（chunk 负载，含 0x2f 魔数）。
 * @param {Uint8Array} chunk VP8L chunk 负载
 * @returns {{ ok: true, width: number, height: number, hasAlpha: boolean } | { ok: false, reason: string }}
 *   `ok=false` 表示该位流**无法核验为有效图像**，调用方必须据此拒绝该媒体。
 */
export function decodeVp8l(chunk) {
  try {
    if (!chunk || chunk.length < 5) return { ok: false, reason: 'too_short' };
    const br = new BitReader(chunk);
    if (br.bits(8) !== 0x2f) return { ok: false, reason: 'bad_signature' };
    const width = br.bits(14) + 1;
    const height = br.bits(14) + 1;
    const hasAlpha = br.bits(1) === 1;
    if (br.bits(3) !== 0) return { ok: false, reason: 'bad_version' };
    if (width < 1 || height < 1) return { ok: false, reason: 'bad_dimensions' };
    if (width * height > MAX_PIXELS) return { ok: false, reason: 'too_many_pixels' };
    decodeImageStream(br, width, height, true);
    return { ok: true, width, height, hasAlpha };
  } catch (err) {
    if (err instanceof DecodeError) return { ok: false, reason: err.message };
    if (err instanceof RangeError) return { ok: false, reason: 'resource_limit' };
    return { ok: false, reason: 'decode_error' };
  }
}
