// 工具层公共 IO：加载索引与预测、构造预测 Map、生成可读摘要。
import { readFileSync } from 'node:fs';

export function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 预测文件支持两种形状：数组 [{sampleId, output}] 或对象 { "<sampleId>": {..output..} }。 */
export function toPredictionMap(raw) {
  const map = new Map();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry.sampleId !== 'string') throw new Error('预测数组项缺少 sampleId');
      map.set(entry.sampleId, entry.output ?? entry);
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
  lines.push(`dataKind=${report.dataKind}  isRealEvaluation=${report.isRealEvaluation}  frozenIndexVersion=${report.frozenIndexVersion}`);
  lines.push(`indexSha256=${report.indexSha256.slice(0, 16)}…  predictionSha256=${report.predictionSha256.slice(0, 16)}…`);
  for (const [task, t] of Object.entries(report.tasks)) {
    if (t.sampleCount === 0) {
      lines.push(`- ${task}: 0 样本（未评估）`);
      continue;
    }
    lines.push(`- ${task}: ${t.sampleCount} 样本  gateStatus=${t.gateStatus}`);
    const m = t.metrics;
    if (m.top1) lines.push(`    top1=${fmt(m.top1)}  top3=${fmt(m.top3)}`);
    if (m.riskRecall) lines.push(`    riskRecall=${fmt(m.riskRecall)}  normalFalseIsolation=${fmt(m.normalFalseIsolationRate)}`);
    if (m.cer) lines.push(`    CER=${fmt({ ...m.cer, n: m.utteranceCount })}  说话者=${m.speakerCount}`);
    if (m.answerableCorrectWithSource) lines.push(`    answerable=${fmt(m.answerableCorrectWithSource)}  expectedBehaviorPass=${fmt(m.expectedBehaviorPass)}`);
    if (m.scenarioPass) lines.push(`    scenarioPass=${fmt(m.scenarioPass)}`);
    if (m.ttsAllCorrect) lines.push(`    ttsAllCorrect=${fmt(m.ttsAllCorrect)}`);
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
