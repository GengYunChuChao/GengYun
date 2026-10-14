#!/usr/bin/env node
// GY-I20 真实样本抽取器：从《杂草图片版.docx》这类"条目=物种名 + 形态特征 + 一张图"的 Office 文档中
// 抽取真实样本，登记内容哈希/尺寸/感知哈希，产出：
//   1) 仓内脱敏样本索引（schema: packages/evaluation/schema/sample.schema.json）；
//   2) 仓外本地路径映射（不入库）；
//   3) 仓外逐条诊断报告（含 dHash 近重复分布）。
//
// 约束：
//   - 只依赖 Node 标准库（自带最小 ZIP 读取器 + PNG 解码器），不引入第三方依赖；
//   - 原始媒体一律写到仓外目录，索引里只有 hash 与元数据（rawMediaCommitted=false）；
//   - 物种标签/判据要点由 `--labels` 指向的答案键文件提供（仓内、可审查），本工具只做**交叉核对**：
//     答案键必须覆盖文档全部条目、条目名必须与文档解析结果逐字一致，否则报错退出。
//
// 用法：
//   node tools/evaluation/extract-docx-weed-samples.mjs \
//     --docx <仓外 .docx 路径> --out-dir <仓外媒体目录> --path-map <仓外路径映射.json> \
//     --labels packages/evaluation/samples/gy-i20-weeds-labels.json \
//     --index packages/evaluation/samples/gy-i20-weeds-real-index.json \
//     [--report <仓外诊断.json>] [--emit-labels <草稿答案键.json>] [--emit-perceptual-hash]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync, inflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const SPECIES_CATALOG = join(REPO_ROOT, 'packages', 'knowledge', 'catalog', 'species.json');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 仓内相对路径（供索引引用）；仓外路径只留文件名，避免把绝对路径写进索引。 */
export function repoRelativeRef(p) {
  const abs = isAbsolute(String(p)) ? String(p) : resolve(process.cwd(), String(p));
  const rel = relative(REPO_ROOT, abs).replace(/\\/g, '/');
  return rel.startsWith('..') ? basename(abs) : rel;
}

// ---------------------------------------------------------------- 参数解析
export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i += 1;
      }
    } else args._.push(token);
  }
  return args;
}

// ---------------------------------------------------------------- 最小 ZIP 读取器
const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

/** 解析 zip 中央目录（不支持 zip64；条目 >4GiB 时明确报错）。 */
export function readZipEntries(buf) {
  const scanFrom = Math.max(0, buf.length - 66000);
  let eocd = -1;
  for (let i = buf.length - 22; i >= scanFrom; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/docx：未找到 EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(off) !== CD_SIG) throw new Error(`中央目录第 ${i} 项签名非法`);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOff === 0xffffffff) {
      throw new Error('该 docx 使用了 zip64，抽取器不支持');
    }
    entries.push({
      name: buf.toString('utf8', off + 46, off + 46 + nameLen),
      method,
      compSize,
      uncompSize,
      localOff,
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 解压单个条目（method 0 直存 / 8 deflate）。 */
export function readZipEntry(buf, entry) {
  const lo = entry.localOff;
  if (buf.readUInt32LE(lo) !== LFH_SIG) throw new Error(`条目 ${entry.name} 本地头签名非法`);
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`条目 ${entry.name} 使用了不支持的压缩方法 ${entry.method}`);
}

// ---------------------------------------------------------------- 最小 PNG 解码器
export function readPngHeader(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG（签名不符）');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
    interlace: buf[28],
  };
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** 解码 PNG 像素（支持 8/16 位、colorType 0/2/3/4/6、非隔行；隔行明确报错）。 */
export function decodePng(buf) {
  const head = readPngHeader(buf);
  if (head.interlace !== 0) throw new Error('PNG 使用了 Adam7 隔行，解码器不支持');
  if (head.bitDepth !== 8 && head.bitDepth !== 16) throw new Error(`不支持的位深 ${head.bitDepth}`);
  const idat = [];
  let palette = null;
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const channels = CHANNELS[head.colorType];
  const sampleBytes = head.bitDepth / 8;
  const bpp = channels * sampleBytes;
  const stride = head.width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * head.height) throw new Error('IDAT 解码长度不足');
  const out = Buffer.alloc(stride * head.height);
  let p = 0;
  for (let y = 0; y < head.height; y += 1) {
    const filter = raw[p];
    p += 1;
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      } else if (filter !== 0) throw new Error(`未知行过滤器 ${filter}`);
      cur[x] = v;
    }
  }
  return { ...head, channels, bpp, stride, pixels: out, palette };
}

/** 解码结果为 8 位灰度（luma 近似）。 */
export function toGrayscale(img) {
  const { width, height, pixels, channels, colorType, palette } = img;
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const o = i * channels;
    let r;
    let g;
    let b;
    if (colorType === 3) {
      const idx = pixels[o] * 3;
      r = palette[idx];
      g = palette[idx + 1];
      b = palette[idx + 2];
    } else if (colorType === 0 || colorType === 4) {
      r = g = b = pixels[o];
    } else {
      r = pixels[o];
      g = pixels[o + 1];
      b = pixels[o + 2];
    }
    gray[i] = (r * 299 + g * 587 + b * 114) / 1000;
  }
  return gray;
}

/** 盒式缩放灰度图。 */
export function resizeGray(gray, srcW, srcH, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH);
  for (let ty = 0; ty < dstH; ty += 1) {
    const y0 = Math.floor((ty * srcH) / dstH);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * srcH) / dstH));
    for (let tx = 0; tx < dstW; tx += 1) {
      const x0 = Math.floor((tx * srcW) / dstW);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * srcW) / dstW));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          sum += gray[y * srcW + x];
          n += 1;
        }
      }
      out[ty * dstW + tx] = Math.round(sum / n);
    }
  }
  return out;
}

/** 64 位 dHash（9x8 灰度，逐行相邻比较）→ 16 位小写 hex。 */
export function dHashFromGray(gray, width, height) {
  const small = resizeGray(gray, width, height, 9, 8);
  let bits = '';
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) bits += small[y * 9 + x] > small[y * 9 + x + 1] ? '1' : '0';
  }
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/** 64 位 dHash（对解码结果直接计算）。 */
export function dHash(img) {
  return dHashFromGray(toGrayscale(img), img.width, img.height);
}

/** 灰度均值与标准差：用于"图片非退化（非空白/纯色）"的客观诊断，不用于质量分级。 */
export function grayStats(gray) {
  let sum = 0;
  for (let i = 0; i < gray.length; i += 1) sum += gray[i];
  const mean = sum / gray.length;
  let sq = 0;
  for (let i = 0; i < gray.length; i += 1) sq += (gray[i] - mean) ** 2;
  return { mean: Number(mean.toFixed(2)), std: Number(Math.sqrt(sq / gray.length).toFixed(2)) };
}

export function hammingHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return null;
  let d = 0;
  for (let i = 0; i < a.length; i += 1) {
    let v = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (v) {
      d += v & 1;
      v >>= 1;
    }
  }
  return d;
}

// ---------------------------------------------------------------- document.xml 解析
const decodeXmlText = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const decodeXmlAttr = (s) => decodeXmlText(s).replace(/\s+/g, ' ').trim();

/** 关系表：rId -> media 目标。 */
export function parseRels(xml) {
  const map = new Map();
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = (m[0].match(/Id="([^"]+)"/) ?? [])[1];
    const target = (m[0].match(/Target="([^"]+)"/) ?? [])[1];
    if (id && target) map.set(id, target);
  }
  return map;
}

/**
 * 把 document.xml 解析成"条目"序列：每个含图段落回溯最近两段非空文本作为
 * 物种名与形态特征；返回 [{ ordinal, name, morphology, mediaTarget }]。
 */
export function parseDocumentEntries(documentXml, relsXml) {
  const rels = parseRels(relsXml);
  const paragraphs = (documentXml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? []).map((p) => {
    const text = decodeXmlText([...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join('')).trim();
    const ids = new Set();
    for (const m of p.matchAll(/r:embed="([^"]+)"/g)) ids.add(m[1]);
    for (const m of p.matchAll(/r:id="([^"]+)"/g)) ids.add(m[1]);
    const embed = [...p.matchAll(/r:embed="([^"]+)"/g)].map((m) => m[1]);
    const link = [...p.matchAll(/r:link="([^"]+)"/g)].map((m) => m[1]);
    const media = [...embed, ...link, ...ids]
      .map((id) => rels.get(id))
      .filter((t) => typeof t === 'string' && t.startsWith('media/'));
    return { text, media: [...new Set(media)] };
  });

  const entries = [];
  for (let i = 0; i < paragraphs.length; i += 1) {
    const media = paragraphs[i].media;
    if (media.length === 0) continue;
    if (media.length > 1) throw new Error(`第 ${i} 段含 ${media.length} 张图，抽取器只支持"一条目一图"`);
    let name = null;
    let morphology = null;
    for (let j = i - 1; j >= 0 && (name === null || morphology === null); j -= 1) {
      const t = paragraphs[j].text;
      if (!t) continue;
      if (morphology === null) morphology = t;
      else if (name === null) name = t;
    }
    if (!name) throw new Error(`第 ${i} 段图片之前未找到物种名段落`);
    entries.push({ ordinal: entries.length + 1, name, morphology: morphology ?? '', mediaTarget: media[0] });
  }
  return entries;
}

// ---------------------------------------------------------------- 物种映射
/** 去掉中英文括号，返回主体名与括号内候选别名。 */
export function nameTokens(rawName) {
  const inner = [];
  const stripped = rawName
    .replace(/[（(]([^）)]*)[）)]/g, (_, g) => {
      inner.push(g);
      return ' ';
    })
    .trim();
  const tokens = new Set([stripped]);
  for (const chunk of inner) for (const part of chunk.split(/[、,，;；/／]/)) tokens.add(part.trim());
  for (const part of stripped.split(/[、,，;；/／]/)) tokens.add(part.trim());
  return [...tokens].filter(Boolean);
}

/** 规范物种目录：group_name/alias/canonical_name -> 规范 ID。 */
export function loadSpeciesIndex(catalogPath = SPECIES_CATALOG) {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const byName = new Map();
  const order = [];
  for (const sp of catalog.species) {
    order.push(sp.id);
    for (const name of [sp.group_name, sp.canonical_name, ...(sp.aliases ?? [])]) {
      if (typeof name === 'string' && name.trim()) byName.set(name.trim(), sp.id);
    }
  }
  return { byName, order, catalogVersion: catalog.catalog_version ?? null };
}

/** 文档条目名 → 规范物种 ID（精确同名，含括号内别名）；无命中返回 null。 */
export function matchCanonicalSpecies(rawName, speciesIndex) {
  for (const token of nameTokens(rawName)) {
    const id = speciesIndex.byName.get(token);
    if (id) return id;
  }
  return null;
}

// ---------------------------------------------------------------- 主线
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.docx || !args['out-dir']) {
    process.stderr.write(
      '用法: node tools/evaluation/extract-docx-weed-samples.mjs --docx <仓外.docx> --out-dir <仓外媒体目录> [--path-map p.json] [--labels labels.json] [--index index.json] [--report r.json] [--emit-labels p.json] [--emit-perceptual-hash]\n',
    );
    process.exit(2);
  }
  const docxBytes = readFileSync(String(args.docx));
  const docxSha256 = sha256(docxBytes);
  const entries = readZipEntries(docxBytes);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const read = (name) => {
    const e = byName.get(name);
    if (!e) throw new Error(`docx 缺少条目 ${name}`);
    return readZipEntry(docxBytes, e);
  };
  const docEntries = parseDocumentEntries(read('word/document.xml').toString('utf8'), read('word/_rels/document.xml.rels').toString('utf8'));
  const speciesIndex = loadSpeciesIndex();

  // 1) 抽取媒体 + 计算摘要
  const outDir = String(args['out-dir']);
  mkdirSync(outDir, { recursive: true });
  const media = [];
  for (const entry of docEntries) {
    const zipName = `word/${entry.mediaTarget}`;
    const e = byName.get(zipName);
    if (!e) throw new Error(`docx 缺少媒体条目 ${zipName}`);
    const bytes = readZipEntry(docxBytes, e);
    const file = basename(entry.mediaTarget);
    writeFileSync(join(outDir, file), bytes);
    const img = decodePng(bytes);
    const gray = toGrayscale(img);
    const stats = grayStats(gray);
    media.push({
      ordinal: entry.ordinal,
      docxName: entry.name,
      morphology: entry.morphology,
      mediaTarget: entry.mediaTarget,
      localFile: join(outDir, file),
      bytes: bytes.length,
      contentSha256: sha256(bytes),
      width: img.width,
      height: img.height,
      pngBitDepth: img.bitDepth,
      pngColorType: img.colorType,
      perceptualHash: dHashFromGray(gray, img.width, img.height),
      grayMean: stats.mean,
      grayStd: stats.std,
    });
  }

  // 2) 草稿答案键（供人工审查后入库）
  const draft = {
    schema: 'gengyun.evaluation.weed-labels.v1',
    note: '草稿：labelClass/coverage 由 group_name/别名精确匹配自动生成，须人工审查后定稿。',
    sourceRef: 'docx_weeds_v1',
    sourceDocSha256: docxSha256,
    entries: media.map((m) => ({
      ordinal: m.ordinal,
      docxName: m.docxName,
      labelClass: matchCanonicalSpecies(m.docxName, speciesIndex) ?? `ext_weed_${String(m.ordinal).padStart(3, '0')}`,
      coverage: matchCanonicalSpecies(m.docxName, speciesIndex) ? 'covered' : 'out_of_coverage',
      mappingKind: matchCanonicalSpecies(m.docxName, speciesIndex) ? 'promised_group_name_exact' : 'outside_promised_scope',
      criteria: m.morphology,
      criteriaSource: `${basename(String(args.docx))} 条目 ${m.ordinal} 形态特征段`,
    })),
  };
  if (args['emit-labels']) {
    writeFileSync(String(args['emit-labels']), `${JSON.stringify(draft, null, 2)}\n`);
    process.stdout.write(`草稿答案键已写入 ${args['emit-labels']}\n`);
  }

  // 3) 答案键交叉核对（定稿路径）
  let labels = null;
  if (args.labels) {
    labels = JSON.parse(readFileSync(String(args.labels), 'utf8'));
    if (labels.sourceDocSha256 && labels.sourceDocSha256 !== docxSha256) {
      throw new Error(`答案键绑定的来源文档 sha256 与本次 docx 不一致（答案键 ${labels.sourceDocSha256} ≠ 实际 ${docxSha256}）`);
    }
    const byOrdinal = new Map(labels.entries.map((e) => [e.ordinal, e]));
    if (labels.entries.length !== media.length) {
      throw new Error(`答案键条目数 ${labels.entries.length} ≠ 文档条目数 ${media.length}`);
    }
    for (const m of media) {
      const l = byOrdinal.get(m.ordinal);
      if (!l) throw new Error(`答案键缺少条目 ${m.ordinal}`);
      if (l.docxName !== m.docxName) throw new Error(`条目 ${m.ordinal} 名称不一致：答案键「${l.docxName}」≠ 文档「${m.docxName}」`);
    }
  }

  // 4) 组装索引记录
  const labelByOrdinal = labels ? new Map(labels.entries.map((e) => [e.ordinal, e])) : new Map(draft.entries.map((e) => [e.ordinal, e]));
  const sourceRefBase = (labels && labels.sourceRef) || draft.sourceRef;
  const records = media.map((m) => {
    const l = labelByOrdinal.get(m.ordinal);
    const sampleId = `gy-i20-weeds-${String(m.ordinal).padStart(3, '0')}`;
    const record = {
      schemaVersion: '1.0.0',
      sampleId,
      task: 'weed_photo',
      split: 'test',
      clusterId: `gy-i20-weeds-cl-${String(m.ordinal).padStart(3, '0')}`,
      contentSha256: m.contentSha256,
      sourceKind: 'real_collected',
      sourceRef: `${sourceRefBase}#entry-${String(m.ordinal).padStart(3, '0')}`,
      labelClass: l.labelClass,
      coverage: l.coverage,
      quality: 'clear',
      gold: {
        speciesId: l.coverage === 'covered' ? l.labelClass : null,
        externalLabel: l.coverage === 'covered' ? null : l.docxName,
        labelSource: `${sourceRefBase}#entry-${String(m.ordinal).padStart(3, '0')}`,
        criteriaRef: `${args.labels ? repoRelativeRef(args.labels) : 'gy-i20-weeds-labels.json'}#entry-${String(m.ordinal).padStart(3, '0')}`,
        media: {
          format: 'png',
          width: m.width,
          height: m.height,
          bytes: m.bytes,
          pngColorType: m.pngColorType,
          pngBitDepth: m.pngBitDepth,
        },
      },
      annotation: {
        method: 'reliable_label',
        annotatorRef: `${sourceRefBase}_source_label`,
        modelGenerated: false,
      },
      rawMediaCommitted: false,
      rawMediaSha256: m.contentSha256,
      notes: `标签与判据取自来源文档同名条目（${l.criteriaSource}）；未经独立复核（无 reviewedBy）。映射口径=${l.mappingKind}。`,
    };
    if (args['emit-perceptual-hash']) record.perceptualHash = m.perceptualHash;
    return record;
  });

  // 5) 写索引 / 路径映射 / 诊断
  if (args.index) {
    mkdirSync(dirname(String(args.index)), { recursive: true });
    writeFileSync(String(args.index), `${JSON.stringify(records, null, 2)}\n`);
  }
  const pathMap = {
    note: '本地路径映射（仓库外，不入库）：sampleId -> 抽取出的原始媒体绝对路径。',
    docxPath: String(args.docx),
    docxSha256,
    extractedAt: new Date().toISOString(),
    mapping: records.map((r, i) => ({ sampleId: r.sampleId, docxEntry: media[i].ordinal, docxMedia: media[i].mediaTarget, localPath: media[i].localFile })),
  };
  if (args['path-map']) {
    mkdirSync(dirname(String(args['path-map'])), { recursive: true });
    writeFileSync(String(args['path-map']), `${JSON.stringify(pathMap, null, 2)}\n`);
  }

  const byHash = new Map();
  for (const m of media) byHash.set(m.contentSha256, (byHash.get(m.contentSha256) ?? []).concat([m.ordinal]));
  const dupGroups = [...byHash.values()].filter((g) => g.length > 1);
  const ph = media.map((m) => m.perceptualHash);
  const nearPairs = [];
  const distanceHistogram = {};
  let minPairwiseDistance = null;
  for (let i = 0; i < ph.length; i += 1) {
    for (let j = i + 1; j < ph.length; j += 1) {
      const d = hammingHex(ph[i], ph[j]);
      if (d === null) continue;
      distanceHistogram[d] = (distanceHistogram[d] ?? 0) + 1;
      if (minPairwiseDistance === null || d < minPairwiseDistance) minPairwiseDistance = d;
      if (d <= 8) nearPairs.push({ a: media[i].ordinal, b: media[j].ordinal, distance: d });
    }
  }
  const byClass = {};
  const byCoverage = { covered: 0, out_of_coverage: 0 };
  for (const r of records) {
    byClass[r.labelClass] = (byClass[r.labelClass] ?? 0) + 1;
    byCoverage[r.coverage] += 1;
  }
  const coveredStrict = records.filter((r) => r.coverage === 'covered').length;
  const congenerExtra = labels
    ? labels.entries.filter((e) => Array.isArray(e.nearGroups) && e.nearGroups.some((g) => g.kind === 'congener')).length
    : 0;
  const report = {
    docx: { name: basename(String(args.docx)), sha256: docxSha256, bytes: docxBytes.length, zipEntries: entries.length },
    extraction: {
      documentParagraphs: (read('word/document.xml').toString('utf8').match(/<w:p\b[^>]*>/g) ?? []).length,
      docxEntries: docEntries.length,
      mediaExtracted: media.length,
      mediaBytes: media.reduce((a, m) => a + m.bytes, 0),
      outDir,
    },
    dedupe: {
      distinctContentSha256: byHash.size,
      duplicateContentGroups: dupGroups,
      duplicateContentCount: dupGroups.reduce((a, g) => a + g.length - 1, 0),
      distinctPerceptualHash: new Set(ph).size,
      nearPairCountAtHamming8: nearPairs.length,
      nearPairsSampleAtHamming8: nearPairs.slice(0, 40),
      minPairwiseDistance,
      distanceHistogram,
    },
    imageSanity: {
      note: '客观非退化诊断：灰度标准差接近 0 表示空白/纯色图。不用于质量分级，不代表人工目视已核对。',
      minGrayStd: Math.min(...media.map((m) => m.grayStd)),
      maxGrayStd: Math.max(...media.map((m) => m.grayStd)),
      degenerateCountStdBelow5: media.filter((m) => m.grayStd < 5).length,
      grayStdBelow20: media.filter((m) => m.grayStd < 20).length,
      grayMeanMin: Math.min(...media.map((m) => m.grayMean)),
      grayMeanMax: Math.max(...media.map((m) => m.grayMean)),
    },
    counts: {
      byCoverage,
      byLabelClass: byClass,
      coveredStrict,
      coveredIncludingSameGenusRelatives: coveredStrict + congenerExtra,
      sameGenusRelativesNotCounted: congenerExtra,
      quality: { clear: records.length },
    },
    media: media.map(({ ordinal, docxName, mediaTarget, bytes, width, height, contentSha256, perceptualHash }) => ({
      ordinal,
      docxName,
      mediaTarget,
      bytes,
      width,
      height,
      contentSha256,
      perceptualHash,
    })),
  };
  if (args.report) {
    mkdirSync(dirname(String(args.report)), { recursive: true });
    writeFileSync(String(args.report), `${JSON.stringify(report, null, 2)}\n`);
  }

  process.stdout.write(`docx=${basename(String(args.docx))} sha256=${docxSha256}\n`);
  process.stdout.write(`文档条目=${docEntries.length}  抽取图片=${media.length}  原始媒体字节=${report.extraction.mediaBytes}\n`);
  process.stdout.write(`去重：distinct contentSha256=${byHash.size}  重复内容组=${dupGroups.length}  重复条数=${report.dedupe.duplicateContentCount}\n`);
  process.stdout.write(`dHash 近重复对（汉明≤8）=${nearPairs.length}\n`);
  process.stdout.write(`按覆盖：covered=${byCoverage.covered}  out_of_coverage=${byCoverage.out_of_coverage}\n`);
  process.stdout.write(`覆盖内（严格同名）=${coveredStrict}；若并入同属近缘种=${coveredStrict + congenerExtra}（近缘种 ${congenerExtra} 条未计入）\n`);
  const coveredPerClass = {};
  for (const r of records) if (r.coverage === 'covered') coveredPerClass[r.labelClass] = (coveredPerClass[r.labelClass] ?? 0) + 1;
  process.stdout.write(`覆盖内逐类计数=${JSON.stringify(coveredPerClass)}\n`);
  process.stdout.write(`覆盖外类别数=${new Set(records.filter((r) => r.coverage === 'out_of_coverage').map((r) => r.labelClass)).size}（逐条=ext_weed_<条目号>）\n`);
  process.stdout.write(`dHash 互异=${new Set(ph).size}/${ph.length}  两两最小汉明距离=${minPairwiseDistance}  近重复对(汉明≤8)=${nearPairs.length}\n`);
  process.stdout.write(
    `图像非退化诊断：灰度标准差 min=${report.imageSanity.minGrayStd} max=${report.imageSanity.maxGrayStd}；std<5 的空白/纯色图=${report.imageSanity.degenerateCountStdBelow5} 张\n`,
  );
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();
if (invokedDirectly && existsSync(process.argv[1])) main();
