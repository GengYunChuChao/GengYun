#!/usr/bin/env node
// 可重复运行的评估命令。
// 用法：
//   node tools/evaluation/run-evaluation.mjs --index <index.json> --predictions <predictions.json> [--manifest <frozen-manifest.json>] [--coverage <coverage-manifest.json>] [--out report.json] [--seed N] [--json]
// --json 输出机器可读报告；默认输出报告 JSON 到 stdout，并附人类可读摘要到 stderr。
// 关键：只有**经冻结清单校验的独立 test 集**、真实来源、达第6节目标且预测完整时才可能 isRealEvaluation=true；
//       合成/占位/未冻结/样本不足/预测缺失的输入恒为 false，全部门禁 not_evaluated。
import { writeFileSync } from 'node:fs';
import { evaluateRun, METRIC_GATES, validateSampleIndex } from '../../packages/evaluation/index.mjs';
import { loadJson, toPredictionMap, formatSummary, parseArgs } from './lib.mjs';

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.index || !args.predictions) {
    process.stderr.write('用法: node tools/evaluation/run-evaluation.mjs --index <index.json> --predictions <predictions.json> [--manifest <frozen-manifest.json>] [--coverage <coverage-manifest.json>] [--out report.json] [--seed N] [--json]\n');
    process.exit(2);
  }
  const records = loadJson(args.index);
  const predictions = toPredictionMap(loadJson(args.predictions));
  const frozenManifest = args.manifest ? loadJson(args.manifest) : null;
  const coverageManifest = args.coverage ? loadJson(args.coverage) : null;

  const validation = validateSampleIndex(records);
  if (!validation.ok) {
    process.stderr.write(`索引校验失败，共 ${validation.errors.length} 项错误：\n${validation.errors.map((e) => `  - ${e}`).join('\n')}\n`);
    process.exit(1);
  }
  for (const w of validation.warnings) process.stderr.write(`! ${w}\n`);

  const report = evaluateRun(records, predictions, {
    gateDefs: METRIC_GATES,
    frozenManifest,
    coverageManifest,
    seed: args.seed ? Number(args.seed) : undefined,
  });

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) {
    writeFileSync(String(args.out), json);
    process.stderr.write(`报告已写入 ${args.out}\n`);
  }
  process.stdout.write(json);
  process.stderr.write(`${formatSummary(report)}\n`);
}

main();
