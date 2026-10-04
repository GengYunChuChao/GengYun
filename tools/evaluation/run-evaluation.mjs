#!/usr/bin/env node
// 可重复运行的评估命令。
// 用法：
//   node tools/evaluation/run-evaluation.mjs --index <index.json> --predictions <predictions.json> [--out report.json] [--seed N] [--json]
// --json 输出机器可读报告；默认输出报告 JSON 到 stdout，并附人类可读摘要到 stderr。
// 关键：只有真实冻结样本且达第6节目标时才可能 isRealEvaluation=true；合成/占位输入恒为 false。
import { writeFileSync } from 'node:fs';
import { evaluateRun, METRIC_GATES, validateSampleIndex } from '../../packages/evaluation/index.mjs';
import { loadJson, toPredictionMap, formatSummary, parseArgs } from './lib.mjs';

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.index || !args.predictions) {
    process.stderr.write('用法: node tools/evaluation/run-evaluation.mjs --index <index.json> --predictions <predictions.json> [--out report.json] [--seed N] [--json]\n');
    process.exit(2);
  }
  const records = loadJson(args.index);
  const predictions = toPredictionMap(loadJson(args.predictions));

  const validation = validateSampleIndex(records);
  if (!validation.ok) {
    process.stderr.write(`索引校验失败，共 ${validation.errors.length} 项错误：\n${validation.errors.map((e) => `  - ${e}`).join('\n')}\n`);
    process.exit(1);
  }
  for (const w of validation.warnings) process.stderr.write(`! ${w}\n`);

  const report = evaluateRun(records, predictions, {
    gateDefs: METRIC_GATES,
    frozenIndexVersion: String(args.version ?? 'unfrozen'),
    seed: args.seed ? Number(args.seed) : undefined,
  });

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) {
    writeFileSync(String(args.out), json);
    process.stderr.write(`报告已写入 ${args.out}\n`);
  }
  if (args.json) {
    process.stdout.write(json);
  } else {
    process.stdout.write(json);
  }
  process.stderr.write(`${formatSummary(report)}\n`);
}

main();
