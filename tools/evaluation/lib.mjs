// 工具层公共 IO：加载索引与预测、构造预测 Map、生成可读摘要。
import { readFileSync } from 'node:fs';

/**
 * 读 JSON 文件。必须先剥离 UTF-8 BOM 再 `JSON.parse`：Node 的 JSON.parse 不接受 BOM，
 * 而 Windows 编辑器/Excel 导出常带 BOM。剥离后"同一内容不同换行符/缩进/BOM"解析出的对象一致，
 * 逐条摘要（`JSON.stringify(parsed)`）才真正与文件字节形态无关。
 */
export function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

/** 预测文件支持两种形状：数组 [{sampleId, output}] 或对象 { "<sampleId>": {..output..} }。 */
export function toPredictionMap(raw) {
  const map = new Map();
  if (Array.isArray(raw)) {
    const duplicates = [];
    for (const entry of raw) {
      if (!entry || typeof entry.sampleId !== 'string') throw new Error('预测数组项缺少 sampleId');
      if (map.has(entry.sampleId)) duplicates.push(entry.sampleId);
      map.set(entry.sampleId, entry.output ?? entry);
    }
    if (duplicates.length > 0) {
      throw new Error(`预测数组存在重复 sampleId（模型评估禁止重复预测充数）：${[...new Set(duplicates)].join(', ')}`);
    }
    return map;
  }
  if (raw && typeof raw === 'object') {
    for (const [sampleId, output] of Object.entries(raw)) map.set(sampleId, output);
    return map;
  }
  throw new Error('预测文件格式无法识别');
}

const fmt = (r) => (r && r.p !== null && r.p !== undefined ? `${(r.p * 100).toFixed(2)}% [${(r.low * 100).toFixed(2)}%, ${(r.high * 100).toFixed(2)}%] n=${r.n}` : '—');

/** 人类可读摘要（终端用）。 */
export function formatSummary(report) {
  const lines = [];
  lines.push(`dataKind=${report.dataKind}  isRealEvaluation=${report.isRealEvaluation}  frozenVerified=${report.frozenVerified}  frozenIndexVersion=${report.frozenIndexVersion}`);
  lines.push(`indexSha256=${report.indexSha256.slice(0, 16)}…  testIndexSha256=${(report.testIndexSha256 ?? '').slice(0, 16)}…  predictionSha256=${report.predictionSha256.slice(0, 16)}…`);
  if (report.splits) lines.push(`划分：train=${report.splits.train}  validation=${report.splits.validation}  test=${report.splits.test}（最终验收仅用 test）`);
  lines.push(`独立对象去重排除=${report.duplicatesExcluded ?? 0}  覆盖清单=${report.coverageManifestPresent ? '有' : '缺'}  覆盖绑定=${report.coverageBinding?.verified ? '通过' : '未通过'}`);
  if (report.answerKey) {
    lines.push(
      `标准答案键：${report.answerKey.verified ? '已核对通过' : '未核实'}`
        + `（版本=${report.answerKey.pinnedVersion ?? '—'} 条目=${report.answerKey.pinnedRecordCount ?? '—'} sha256=${(report.answerKey.computedSha256 ?? '').slice(0, 16)}…）`,
    );
    if (report.answerKey.mismatches.length > 0) {
      lines.push(`    索引↔答案键不符=${report.answerKey.mismatches.map((m) => `#${m.ordinal}(${m.sampleId})[${m.fields.join('/')}]`).join('、')}`);
    }
  }
  if (report.frozenVerification?.drift) {
    const d = report.frozenVerification.drift;
    lines.push(`逐条摘要台账：${report.frozenVerification.digestLedgerProvided ? '已提供' : '未提供'}  改动=${d.changed.length} 新增=${d.added.length} 删除=${d.removed.length}`);
  }
  if (report.coverageBinding && !report.coverageBinding.verified) {
    lines.push(`    覆盖绑定依据=${report.coverageBinding.basisRef ?? '—'}  承诺类=${JSON.stringify(report.coverageBinding.boundClasses ?? [])}`);
  }
  if (report.coverageBinding?.scopeBasis) {
    const sb = report.coverageBinding.scopeBasis;
    lines.push(`    范围口径依据=${sb.basisRef ?? '—'}  catalog=${sb.catalogRef ?? '—'}@${sb.catalogVersion ?? '—'} sha256=${(sb.catalogSha256 ?? '').slice(0, 16)}…  映射组=${JSON.stringify(sb.sourceGroups ?? [])}`);
  }
  if (report.predictionEvidence) {
    const pe = report.predictionEvidence;
    lines.push(`预测完整性：期望=${pe.expected} 有效=${pe.present} 缺失=${pe.missing.length} 非法=${pe.invalid.length} 多余=${pe.extra.length} complete=${pe.complete}`);
  }
  for (const [task, t] of Object.entries(report.tasks)) {
    if (t.sampleCount === 0) {
      lines.push(`- ${task}: 0 样本（未评估）`);
      continue;
    }
    lines.push(`- ${task}: ${t.sampleCount} 样本 / 可评分 ${t.scoredCount ?? t.sampleCount}  gateStatus=${t.gateStatus}`);
    const m = t.metrics;
    if (m.top1) lines.push(`    top1=${fmt(m.top1)}  top3=${fmt(m.top3)}`);
    if (m.riskRecall) lines.push(`    riskRecall=${fmt(m.riskRecall)}  normalFalseIsolation=${fmt(m.normalFalseIsolationRate)}`);
    if (m.cer) lines.push(`    CER=${fmt({ ...m.cer, n: m.utteranceCount })}  说话者=${m.speakerCount}  原始缺失=${m.originalMissingCount ?? 0}`);
    if (m.answerableCorrectWithSource) lines.push(`    answerable=${fmt(m.answerableCorrectWithSource)}  expectedBehaviorPass=${fmt(m.expectedBehaviorPass)}`);
    if (m.scenarioPass) lines.push(`    scenarioPass=${fmt(m.scenarioPass)}`);
    if (m.ttsAllCorrect) lines.push(`    ttsAllCorrect=${fmt(m.ttsAllCorrect)}  未测段=${m.untestedCount ?? 0}`);
    if (m.registrationNumberExact) lines.push(`    登记号完全正确=${fmt(m.registrationNumberExact)}  原始分母=${m.originalEvaluationDenominator ?? m.consideredForModelAccuracy ?? '—'}  原始缺失=${m.originalMissingCount ?? 0}  完整模型准确率可主张=${m.completeModelAccuracy ?? false}  校正样本=${m.correctedCount ?? 0}`);
  }
  const missing = report.gaps.filter((g) => g.missing > 0);
  lines.push(`样本缺口桶：${missing.length}/${report.gaps.length} 未达标`);
  for (const g of missing) lines.push(`    [缺${g.missing}] ${g.bucket} (需${g.required}, 有${g.present})`);
  for (const w of report.warnings) lines.push(`! ${w}`);
  return lines.join('\n');
}

/** 极简参数解析：--key value / --flag。 */
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
    } else {
      args._.push(token);
    }
  }
  return args;
}
