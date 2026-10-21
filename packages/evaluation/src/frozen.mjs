// 冻结清单校验与预测完整性校验（修复轮 1）。
// 目标：最终验收只认"经冻结清单校验的独立 test 集"，且预测必须完整、结构合法、可对应索引。
// 来源标签（sourceKind）或手填版本号**不能**代替冻结清单校验。

import { createHash } from 'node:crypto';
import {
  originalOcrFields,
  originalAsrOutput,
  isObject,
  WEED_DECISIONS,
  MODERATION_DECISIONS,
  TTS_JUDGEMENT_FIELDS,
} from './metrics.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** 规范化覆盖类清单（去空、去非字符串，保持顺序）。返回 null 表示非数组。 */
function normalizeCoveredClasses(value) {
  if (!Array.isArray(value)) return null;
  return value.filter((c) => typeof c === 'string' && c.trim() !== '');
}

/** 承诺覆盖清单的规范化 SHA-256（用于与冻结清单绑定核对）。 */
export function computeCoverageSha256(coverage) {
  const classes = normalizeCoveredClasses(coverage?.weedPhotoCoveredClasses) ?? [];
  return sha256(JSON.stringify({ weedPhotoCoveredClasses: classes }));
}

/** 计算一组记录（保持给定顺序）的规范化 SHA-256。 */
export function computeRecordsSha256(records) {
  return sha256(JSON.stringify(records));
}

// —— 逐条摘要台账（GY-I20「冻结 = 可验证，且可点名」）——
// 冻结清单的 indexSha256 只覆盖**整份** test 集：任何一条被改动都只能得到"整体不一致"，
// 无法定位到底是哪一条、改了哪个字段（三种完全不同的篡改返回同一句理由，见
// tests/evaluation/frozen-drift-naming.test.mjs 的改前读数）。
// 台账把指纹下放到**每条记录**与**每个字段路径**：
//   - 记录摘要 = sha256(JSON.stringify(record))：证明这一条整体未变；
//   - 字段摘要 = sha256(JSON.stringify(record[路径])) 前 12 位：把差异定位到字段。
// 两者均在 JSON.parse 之后计算，与换行符/缩进/BOM 无关（CRLF 与 LF 两种字节形态摘要相同）。

export const FROZEN_DIGESTS_SCHEMA = 'gengyun.evaluation.frozen-digests.v1';

/**
 * 逐字段摘要覆盖的字段路径（有序；覆盖索引记录的**全部** 17 个顶层键，
 * 其中 gold 拆成 5 个叶子路径，便于把"答案被改"与"元数据被改"分开点名）。
 */
export const DIGEST_FIELD_PATHS = [
  'schemaVersion',
  'task',
  'split',
  'clusterId',
  'contentSha256',
  'sourceKind',
  'sourceRef',
  'labelClass',
  'coverage',
  'quality',
  'gold.speciesId',
  'gold.externalLabel',
  'gold.labelSource',
  'gold.criteriaRef',
  'gold.media',
  'annotation',
  'rawMediaCommitted',
  'rawMediaSha256',
  'notes',
  'perceptualHash',
];

/** 字段摘要位数（十六进制）。12 位 = 48 bit，只用于定位差异，不承担安全边界。 */
export const FIELD_DIGEST_LENGTH = 12;

/** 「字段不存在」的哨兵：让"字段被删除"与"字段值为 null"得到不同摘要。 */
const ABSENT_FIELD = Object.freeze({ __absent__: true });

function pickPath(record, path) {
  const parts = path.split('.');
  let acc = record;
  for (const part of parts) {
    if (acc === null || typeof acc !== 'object') return undefined;
    acc = acc[part];
  }
  return acc;
}

/** 单条记录的规范化摘要（整条内容）。 */
export function computeRecordDigest(record) {
  return sha256(JSON.stringify(record));
}

/** 单个字段值的摘要（前 FIELD_DIGEST_LENGTH 位）。 */
export function computeFieldDigest(value) {
  return sha256(JSON.stringify(value === undefined ? ABSENT_FIELD : value)).slice(0, FIELD_DIGEST_LENGTH);
}

/** 单条记录的逐字段摘要表（路径 → 摘要）。 */
export function computeFieldDigests(record) {
  const out = {};
  for (const path of DIGEST_FIELD_PATHS) out[path] = computeFieldDigest(pickPath(record, path));
  return out;
}

/**
 * 生成逐条摘要台账（`recordCount` / `recordsSha256` / `recordsDigest` / `records[]`）。
 * - `recordsSha256` = 与冻结清单 `indexSha256` 同一算法（可直接对账）；
 * - `recordsDigest` = 台账自身 records 数组的摘要（防台账被手改）。
 */
export function buildDigestLedger(records, { indexVersion = null, split = 'test' } = {}) {
  const entries = records.map((record) => ({
    sampleId: record.sampleId,
    sha256: computeRecordDigest(record),
    fields: computeFieldDigests(record),
  }));
  return {
    schema: FROZEN_DIGESTS_SCHEMA,
    indexVersion,
    split,
    recordCount: entries.length,
    recordsSha256: computeRecordsSha256(records),
    recordsDigest: sha256(JSON.stringify(entries)),
    digestAlgorithm: 'sha256',
    fieldDigestLength: FIELD_DIGEST_LENGTH,
    canonicalization:
      '记录摘要 = sha256(JSON.stringify(record))；字段摘要 = sha256(JSON.stringify(record[字段路径])) 前 12 位十六进制；两者都在 JSON.parse 之后计算，与文件换行符/缩进/BOM 无关（读取侧先剥离 BOM 再解析）',
    fieldPaths: [...DIGEST_FIELD_PATHS],
    records: entries,
  };
}

/** 台账写成「一条记录一行」的 JSON 文本（git diff 可读：改一条只动一行）。 */
export function serializeDigestLedger(ledger) {
  const { records, ...head } = ledger;
  const lines = ['{'];
  for (const [key, value] of Object.entries(head)) lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  lines.push('  "records": [');
  records.forEach((entry, index) => {
    lines.push(`    ${JSON.stringify(entry)}${index === records.length - 1 ? '' : ','}`);
  });
  lines.push('  ]');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/**
 * 台账 ↔ 实际 test 集逐条比对，产出**点名**结果。
 * 返回 { verified, reasons, drift:{ changed:[{sampleId,fields[]}], added[], removed[] }, recordCount, recordsSha256 }。
 * `drift.changed[].fields` 只列**摘要确实不同**的字段路径——只改一个字段就只列那一个。
 */
export function verifyDigestLedger(ledger, records, { maxNamed = 20 } = {}) {
  const empty = { verified: false, reasons: [], drift: null, recordCount: 0, recordsSha256: null };
  if (!isObject(ledger)) {
    return { ...empty, reasons: ['未提供逐条摘要台账：冻结集被改动时无法点名到具体样本（只能得到整体不一致）'] };
  }
  if (ledger.schema !== FROZEN_DIGESTS_SCHEMA) {
    return { ...empty, reasons: [`逐条摘要台账 schema 非 ${FROZEN_DIGESTS_SCHEMA}（当前 ${ledger.schema ?? '未填写'}）`] };
  }
  if (!Array.isArray(ledger.records)) return { ...empty, reasons: ['逐条摘要台账缺 records 数组'] };
  const paths = Array.isArray(ledger.fieldPaths) ? ledger.fieldPaths : [];
  if (paths.length > 0 && paths.join(',') !== DIGEST_FIELD_PATHS.join(',')) {
    return { ...empty, reasons: ['逐条摘要台账的 fieldPaths 与当前字段摘要口径不一致：字段摘要不可比，须重新生成台账'] };
  }

  const reasons = [];
  const recordsSha256 = computeRecordsSha256(records);
  if (typeof ledger.recordsSha256 === 'string' && ledger.recordsSha256 !== recordsSha256) {
    reasons.push(`逐条摘要台账 recordsSha256 与实际 test 集不一致（台账 ${ledger.recordsSha256.slice(0, 16)}… ≠ 实际 ${recordsSha256.slice(0, 16)}…）：台账与冻结集不是同一次冻结`);
  }
  if (ledger.recordsDigest !== sha256(JSON.stringify(ledger.records))) {
    reasons.push('逐条摘要台账 recordsDigest 与其自身 records 不一致（台账被手改）');
  }

  const frozenById = new Map(ledger.records.map((entry) => [entry?.sampleId, entry]));
  const actualIds = new Set(records.map((r) => r.sampleId));
  const changed = [];
  const added = [];
  for (const record of records) {
    const frozenEntry = frozenById.get(record.sampleId);
    if (!frozenEntry) {
      added.push(record.sampleId);
      continue;
    }
    const actualSha = computeRecordDigest(record);
    if (frozenEntry.sha256 === actualSha) continue;
    const actualFields = computeFieldDigests(record);
    const frozenFields = isObject(frozenEntry.fields) ? frozenEntry.fields : {};
    const fields = DIGEST_FIELD_PATHS.filter((path) => frozenFields[path] !== actualFields[path]);
    changed.push({ sampleId: record.sampleId, fields, recordSha256: actualSha, frozenRecordSha256: frozenEntry.sha256 ?? null });
  }
  const removed = ledger.records.map((entry) => entry?.sampleId).filter((id) => !actualIds.has(id));

  // 点名：一条一个理由，避免"笼统失败"。
  for (const item of changed.slice(0, maxNamed)) {
    const fieldText = item.fields.length > 0 ? item.fields.join('/') : '未登记字段（记录内容变了，但不属于已登记字段路径）';
    reasons.push(`冻结集被改动：${item.sampleId} 字段 ${fieldText}（记录摘要 ${String(item.recordSha256).slice(0, 12)}… ≠ 冻结 ${String(item.frozenRecordSha256).slice(0, 12)}…）`);
  }
  if (changed.length > maxNamed) reasons.push(`另有 ${changed.length - maxNamed} 条改动未逐条列出（上限 ${maxNamed} 条）`);
  for (const id of added.slice(0, maxNamed)) reasons.push(`冻结集新增样本：${id}（不在逐条摘要台账内，冻结集被扩充）`);
  if (added.length > maxNamed) reasons.push(`另有 ${added.length - maxNamed} 条新增未逐条列出`);
  for (const id of removed.slice(0, maxNamed)) reasons.push(`冻结集样本被删除：${id}（在逐条摘要台账内，但实际 test 集已无此条）`);
  if (removed.length > maxNamed) reasons.push(`另有 ${removed.length - maxNamed} 条删除未逐条列出`);
  if (changed.length + added.length + removed.length > 0) {
    reasons.push(`逐条摘要比对：改动 ${changed.length} 条 / 新增 ${added.length} 条 / 删除 ${removed.length} 条（共 ${ledger.records.length} 条台账记录）`);
  }

  return {
    verified: reasons.length === 0,
    reasons,
    drift: { changed, added, removed },
    recordCount: ledger.records.length,
    recordsSha256,
  };
}

/**
 * 校验冻结清单是否真的对应给定 test 集。
 * 清单字段：{ manifestVersion, indexVersion, split:'test', recordCount, indexSha256, frozenAt }。
 * 第三参 `digestLedger`（可选）给出逐条摘要台账：给出时**改为点名**（哪一条、哪个字段），
 * 不给出时保持原有整体口径（向后兼容）。
 * 返回 { verified, reasons, computedSha256, manifestSha256, drift, digestLedgerProvided }。
 */
export function verifyFrozenManifest(manifest, testRecords, { digestLedger = null } = {}) {
  const reasons = [];
  const computedSha256 = computeRecordsSha256(testRecords);
  if (!isObject(manifest)) {
    return {
      verified: false,
      reasons: ['缺少冻结清单：未提供经核实的冻结清单，不得主张真实评估'],
      computedSha256,
      manifestSha256: null,
      drift: null,
      digestLedgerProvided: false,
    };
  }
  if (manifest.split !== 'test') reasons.push(`冻结清单 split 必须为 test（当前 ${manifest.split ?? '未填写'}）`);
  if (typeof manifest.indexVersion !== 'string' || manifest.indexVersion.trim() === '') reasons.push('冻结清单缺 indexVersion');
  if (typeof manifest.frozenAt !== 'string' || manifest.frozenAt.trim() === '') reasons.push('冻结清单缺 frozenAt（冻结时间）');
  if (manifest.recordCount !== testRecords.length) reasons.push(`冻结清单 recordCount=${manifest.recordCount} 与实际 test 集 ${testRecords.length} 不一致`);
  if (manifest.indexSha256 !== computedSha256) reasons.push('冻结清单 indexSha256 与实际 test 集内容不一致（冻结集被改动或清单未核实）');

  let drift = null;
  if (isObject(digestLedger)) {
    const ledgerCheck = verifyDigestLedger(digestLedger, testRecords);
    drift = ledgerCheck.drift;
    reasons.push(...ledgerCheck.reasons);
    const pinned = manifest.digestLedger;
    if (isObject(pinned)) {
      if (pinned.recordsSha256 && pinned.recordsSha256 !== computedSha256) {
        reasons.push('冻结清单 digestLedger.recordsSha256 与实际 test 集不一致（清单登记的台账属于另一次冻结）');
      }
      if (Number.isInteger(pinned.recordCount) && pinned.recordCount !== ledgerCheck.recordCount) {
        reasons.push(`冻结清单 digestLedger.recordCount=${pinned.recordCount} 与台账 ${ledgerCheck.recordCount} 不一致`);
      }
    } else {
      reasons.push('冻结清单未登记逐条摘要台账指针（digestLedger）：无法确认台账属于本次冻结');
    }
  }

  return {
    verified: reasons.length === 0,
    reasons,
    computedSha256,
    manifestSha256: sha256(JSON.stringify(manifest)),
    drift,
    digestLedgerProvided: isObject(digestLedger),
  };
}

// —— 标准答案键绑定（GY-I20「答案不能被悄悄改掉」）——
// 冻结清单**单向**钉住答案键（sha256 + 版本 + 条数）；答案键不反向依赖清单，避免环形依赖。
// 规范化摘要 = sha256(JSON.stringify(parsed))，与 computeRecordsSha256 同风格：与 CRLF/缩进/BOM 无关。

/** 答案键的规范化摘要（与换行符/缩进/BOM 无关）。 */
export function computeAnswerKeySha256(labels) {
  return sha256(JSON.stringify(labels));
}

/**
 * 核对答案键是否仍是被冻结的那一份（清单 → 答案键单向）。
 * 返回 { verified, pinned, provided, pinnedSha256, computedSha256, reasons }。
 */
export function verifyAnswerKeyBinding(frozenManifest, labels) {
  const pinned = frozenManifest?.answerKey;
  const computedSha256 = isObject(labels) ? computeAnswerKeySha256(labels) : null;
  if (!isObject(pinned)) {
    return {
      verified: false,
      pinned: false,
      provided: isObject(labels),
      pinnedSha256: null,
      computedSha256,
      reasons: ['冻结清单未钉住标准答案键（answerKey）：答案键被改动时无从发现，按未核实计'],
    };
  }
  if (!isObject(labels)) {
    return {
      verified: false,
      pinned: true,
      provided: false,
      pinnedSha256: pinned.sha256 ?? null,
      computedSha256: null,
      reasons: ['冻结清单已钉住标准答案键，但未提供答案键文件：无法核对（不得按通过计）'],
    };
  }
  const reasons = [];
  if (pinned.sha256 !== computedSha256) reasons.push('标准答案键 sha256 与冻结清单不一致（答案键被改动或清单未核实）');
  if (typeof pinned.version === 'string' && labels.version !== pinned.version) {
    reasons.push(`标准答案键版本不符（清单 ${pinned.version} ≠ 实际 ${labels.version ?? '未填写'}）`);
  }
  const entryCount = Array.isArray(labels.entries) ? labels.entries.length : null;
  if (Number.isInteger(pinned.recordCount) && entryCount !== pinned.recordCount) {
    reasons.push(`标准答案键条数不符（清单 ${pinned.recordCount} ≠ 实际 ${entryCount}）`);
  }
  return { verified: reasons.length === 0, pinned: true, provided: true, pinnedSha256: pinned.sha256 ?? null, computedSha256, reasons };
}

/** 从 sampleId 末段取序号（`gy-i20-weeds-005` → 5）；取不到返回 null。 */
export function ordinalOf(sampleId) {
  const match = /(\d+)$/.exec(String(sampleId ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * 答案键 ↔ 索引交叉核对（按 ordinal 对齐），**点名**到条目号 + sampleId + 字段。
 * 用于发现"只改答案键"或"只改索引 gold"的单边漂移（两边都改会同时打破 sha256 与逐条台账）。
 * 返回 { verified, mismatches:[{ordinal, sampleId, fields[]}], reasons }。
 */
export function verifyAnswerKeyAgainstIndex(indexRecords, labels) {
  if (!isObject(labels) || !Array.isArray(labels.entries)) {
    return { verified: false, mismatches: [], reasons: ['未提供标准答案键 entries：索引与答案键无法交叉核对'] };
  }
  const byOrdinal = new Map(labels.entries.map((entry) => [entry?.ordinal, entry]));
  const mismatches = [];
  for (const record of indexRecords) {
    const ordinal = ordinalOf(record.sampleId);
    const entry = byOrdinal.get(ordinal);
    if (!entry) {
      mismatches.push({ ordinal, sampleId: record.sampleId, fields: ['<答案键缺条目>'] });
      continue;
    }
    const fields = [];
    if (record.labelClass !== entry.labelClass) fields.push('labelClass');
    if (record.coverage !== entry.coverage) fields.push('coverage');
    const expectedSpeciesId = entry.coverage === 'covered' ? entry.labelClass : null;
    if ((record.gold?.speciesId ?? null) !== expectedSpeciesId) fields.push('gold.speciesId');
    const expectedExternalLabel = entry.coverage === 'out_of_coverage' ? entry.docxName : null;
    if ((record.gold?.externalLabel ?? null) !== expectedExternalLabel) fields.push('gold.externalLabel');
    const expectedSourceRef = typeof labels.sourceRef === 'string' ? `${labels.sourceRef}#entry-${String(ordinal).padStart(3, '0')}` : null;
    if (expectedSourceRef !== null && record.sourceRef !== expectedSourceRef) fields.push('sourceRef');
    if ((record.gold?.labelSource ?? null) !== (record.sourceRef ?? null)) fields.push('gold.labelSource');
    if (fields.length > 0) mismatches.push({ ordinal, sampleId: record.sampleId, fields });
  }
  const reasons = mismatches.map(
    (item) => `答案键与索引不符：第 ${item.ordinal} 条（${item.sampleId}）字段 ${item.fields.join('/')}`,
  );
  return { verified: reasons.length === 0, mismatches, reasons };
}

/**
 * 承诺覆盖清单与冻结清单的**绑定校验**（修复轮 2）。
 * 冻结清单须内嵌 `coverage = { weedPhotoCoveredClasses, coverageSha256, basisRef }`；
 * 外部 `coverageManifest` 必须与内嵌绑定逐字节一致——**缩减/修改/新增一律拒绝**，
 * 变更只能通过产出新的冻结版本（新的 indexVersion / manifestSha256）来表达。
 * 可选 `scopeClasses`（GY-I03 承诺范围）用于核对承诺类是否落在首批承诺范围内。
 * 返回 { verified, reasons, boundClasses, coverageSha256, frozenCoverageSha256, basisRef }。
 */
export function verifyCoverageBinding(frozenManifest, coverageManifest, { scopeClasses = null } = {}) {
  const empty = { verified: false, reasons: [], boundClasses: null, coverageSha256: null, frozenCoverageSha256: null, basisRef: null };
  if (!isObject(frozenManifest)) {
    return { ...empty, reasons: ['缺少冻结清单：承诺覆盖清单无法与冻结版本绑定'] };
  }
  const embedded = frozenManifest.coverage;
  const boundClasses = normalizeCoveredClasses(embedded?.weedPhotoCoveredClasses);
  if (!isObject(embedded) || boundClasses === null || boundClasses.length === 0) {
    return { ...empty, reasons: ['冻结清单未内嵌承诺覆盖类清单（coverage.weedPhotoCoveredClasses），逐类达标不可推断'] };
  }
  const frozenCoverageSha256 = computeCoverageSha256({ weedPhotoCoveredClasses: boundClasses });
  const reasons = [];
  if (embedded.coverageSha256 !== frozenCoverageSha256) reasons.push('冻结清单 coverageSha256 与其内嵌覆盖类不一致（冻结覆盖块被改动）');
  if (typeof embedded.basisRef !== 'string' || embedded.basisRef.trim() === '') reasons.push('冻结清单未标注覆盖承诺依据（coverage.basisRef，应指向 GY-I03 承诺范围）');

  const externalClasses = normalizeCoveredClasses(coverageManifest?.weedPhotoCoveredClasses);
  if (externalClasses === null || externalClasses.length === 0) {
    reasons.push('未提供外部覆盖清单：与冻结绑定的承诺类无法核对（逐类达标按未满足计）');
  } else {
    const externalSha = computeCoverageSha256({ weedPhotoCoveredClasses: externalClasses });
    if (externalSha !== frozenCoverageSha256) {
      reasons.push(
        `外部覆盖清单与冻结清单绑定不一致（外部 ${externalClasses.length} 类 ≠ 冻结 ${boundClasses.length} 类）：覆盖清单被缩减/修改，须作为新冻结版本重新冻结`,
      );
    }
  }

  if (Array.isArray(scopeClasses) && scopeClasses.length > 0) {
    const scope = new Set(scopeClasses);
    const outside = boundClasses.filter((c) => !scope.has(c));
    if (outside.length > 0) reasons.push(`冻结承诺覆盖类超出 GY-I03 已承诺范围：${outside.join(', ')}`);
  }

  return { verified: reasons.length === 0, reasons, boundClasses, coverageSha256: frozenCoverageSha256, frozenCoverageSha256, basisRef: embedded.basisRef ?? null };
}

/**
 * 单条预测的结构/失败标记校验。
 * 返回 { ok, reason }：ok=false 表示该预测不可用于评分（缺失/结构非法/服务失败）。
 * 注意：`decision=uncertain` 等拒识是**合法结果**，不是失败；这里只看结构完整性与失败标记。
 */
export function validatePredictionOutput(task, output) {
  if (!isObject(output)) return { ok: false, reason: '预测缺失或非对象' };
  if (output.error !== undefined && output.error !== null) return { ok: false, reason: '预测标注 error（服务失败）' };
  if (output.failed === true) return { ok: false, reason: '预测 failed=true（服务失败）' };
  if (output.served === false) return { ok: false, reason: '预测 served=false（未实际测量）' };

  switch (task) {
    case 'weed_photo':
      if (!Array.isArray(output.candidates)) return { ok: false, reason: '缺少 candidates 数组' };
      if (!WEED_DECISIONS.includes(output.decision)) return { ok: false, reason: `缺少合法最终 decision（需 ${WEED_DECISIONS.join('/')}）` };
      return { ok: true };
    case 'label_ocr':
      if (originalOcrFields({ output }) === null) return { ok: false, reason: '缺少原始模型 fields（校正稿不得冒充）' };
      return { ok: true };
    case 'registration_match':
      if (typeof output.status !== 'string') return { ok: false, reason: '缺少 status' };
      return { ok: true };
    case 'ai_moderation':
      if (!MODERATION_DECISIONS.includes(output.decision)) {
        return { ok: false, reason: `缺少合法最终 decision（需 ${MODERATION_DECISIONS.join('/')}；unknown/服务错误/非法枚举不得算正常通过）` };
      }
      return { ok: true };
    case 'tts':
      // 六项判定必须明确存在且为布尔值；缺失记未测，不得默认成功。
      if (TTS_JUDGEMENT_FIELDS.some((k) => typeof output[k] !== 'boolean')) {
        const missing = TTS_JUDGEMENT_FIELDS.filter((k) => typeof output[k] !== 'boolean');
        return { ok: false, reason: `缺少 TTS 布尔判定字段（未测）：${missing.join('/')}` };
      }
      return { ok: true };
    case 'asr':
      if (originalAsrOutput({ output }).hypothesis === null) return { ok: false, reason: '缺少原始转写 hypothesis（校正稿不得冒充）' };
      return { ok: true };
    case 'qa':
      return { ok: true };
    default:
      return { ok: false, reason: `未知 task=${task}` };
  }
}

/**
 * 预测覆盖与结构校验：对照 test 集逐条检查 ID 对应、结构合法。
 * 返回 { expected, present, missing, invalid, extra, byTask, complete }。
 */
export function validatePredictionCoverage(testRecords, predictions) {
  const expectedIds = new Set(testRecords.map((r) => r.sampleId));
  const missing = [];
  const invalid = [];
  const byTask = {};

  for (const r of testRecords) {
    const bucket = (byTask[r.task] ??= { expected: 0, present: 0, missing: 0, invalid: 0 });
    bucket.expected += 1;
    const output = predictions.get(r.sampleId);
    if (output === undefined) {
      missing.push(r.sampleId);
      bucket.missing += 1;
      continue;
    }
    const check = validatePredictionOutput(r.task, output);
    if (!check.ok) {
      invalid.push({ sampleId: r.sampleId, task: r.task, reason: check.reason });
      bucket.invalid += 1;
      continue;
    }
    bucket.present += 1;
  }

  const extra = [];
  for (const id of predictions.keys()) if (!expectedIds.has(id)) extra.push(id);

  const complete = missing.length === 0 && invalid.length === 0;
  return {
    expected: expectedIds.size,
    present: expectedIds.size - missing.length - invalid.length,
    missing,
    invalid,
    extra,
    byTask,
    complete,
  };
}
