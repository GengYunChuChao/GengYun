#!/usr/bin/env node
// 可重复运行的评估命令。
// 用法：
//   node tools/evaluation/run-evaluation.mjs --index <index.json> --predictions <predictions.json> [--manifest <frozen-manifest.json>] [--coverage <coverage-manifest.json>] [--out report.json] [--seed N] [--json]
// --json 输出机器可读报告；默认输出报告 JSON 到 stdout，并附人类可读摘要到 stderr。
// 关键：只有**经冻结清单校验的独立 test 集**、真实来源、达第6节目标且预测完整时才可能 isRealEvaluation=true；
//       合成/占位/未冻结/样本不足/预测缺失的输入恒为 false，全部门禁 not_evaluated。
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateRun, METRIC_GATES, validateSampleIndex } from '../../packages/evaluation/index.mjs';
import { loadJson, toPredictionMap, formatSummary, parseArgs } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 读取 GY-I03 承诺覆盖范围（物种组），用于核对冻结承诺类是否落在首批承诺范围内。
 * 缺失时返回 null（不阻断：绑定校验仍要求内嵌 coverage 与外部清单一致）。
 */
function loadKnowledgeScope() {
  const file = join(HERE, '..', '..', 'packages', 'knowledge', 'coverage-report.json');
  if (!existsSync(file)) return null;
  try {
    const report = JSON.parse(readFileSync(file, 'utf8'));
    const required = report?.species_groups?.required;
    return Array.isArray(required) && required.length > 0 ? required : null;
  } catch {
    return null;
  }
}

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
  const knowledgeScope = loadKnowledgeScope();

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
    knowledgeScope,
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
