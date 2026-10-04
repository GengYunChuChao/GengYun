#!/usr/bin/env node
// 可重复运行的评估命令。
// 用法：
//   node tools/evaluation/run-evaluation.mjs --index <index.json> --predictions <predictions.json> [--manifest <frozen-manifest.json>] [--coverage <coverage-manifest.json>] [--out report.json] [--seed N] [--json]
// --json 输出机器可读报告；默认输出报告 JSON 到 stdout，并附人类可读摘要到 stderr。
// 关键：只有**经冻结清单校验的独立 test 集**、真实来源、达第6节目标且预测完整时才可能 isRealEvaluation=true；
//       合成/占位/未冻结/样本不足/预测缺失的输入恒为 false，全部门禁 not_evaluated。
// 范围口径：GY-I03 承诺范围的展示用中文组名会经 species.json 映射为规范物种 ID 后再核对，
//       labelClass/gold/candidates 一律使用规范 ID（映射依据记入报告 coverageBinding.scopeBasis）。
import { writeFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { evaluateRun, METRIC_GATES, validateSampleIndex } from '../../packages/evaluation/index.mjs';
import { loadJson, toPredictionMap, formatSummary, parseArgs } from './lib.mjs';
import { loadKnowledgeScope } from './knowledge-scope.mjs';

/**
 * 运行一次评估（CLI 核心，便于集成测试在进程内驱动——本环境禁止派生子进程）。
 * @returns { exitCode, report }；仅向给定 stdout/stderr 写输出，不调用 process.exit。
 */
export function runEvaluation(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const args = parseArgs(argv);
  if (!args.index || !args.predictions) {
    stderr.write('用法: node tools/evaluation/run-evaluation.mjs --index <index.json> --predictions <predictions.json> [--manifest <frozen-manifest.json>] [--coverage <coverage-manifest.json>] [--out report.json] [--seed N] [--json]\n');
    return { exitCode: 2, report: null };
  }
  const records = loadJson(args.index);
  const predictions = toPredictionMap(loadJson(args.predictions));
  const frozenManifest = args.manifest ? loadJson(args.manifest) : null;
  const coverageManifest = args.coverage ? loadJson(args.coverage) : null;

  // GY-I03 承诺范围：中文展示组名 → 规范物种 ID（依据 packages/knowledge/catalog/species.json）。
  let knowledgeScope = null;
  try {
    knowledgeScope = loadKnowledgeScope();
  } catch (err) {
    stderr.write(`范围口径解析失败：${err.message}\n`);
    return { exitCode: 3, report: null };
  }

  const validation = validateSampleIndex(records);
  if (!validation.ok) {
    stderr.write(`索引校验失败，共 ${validation.errors.length} 项错误：\n${validation.errors.map((e) => `  - ${e}`).join('\n')}\n`);
    return { exitCode: 1, report: null };
  }
  for (const w of validation.warnings) stderr.write(`! ${w}\n`);

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
    stderr.write(`报告已写入 ${args.out}\n`);
  }
  stdout.write(json);
  stderr.write(`${formatSummary(report)}\n`);
  return { exitCode: 0, report };
}

function main() {
  const { exitCode } = runEvaluation(process.argv.slice(2));
  process.exit(exitCode);
}

// 仅在作为脚本直接执行时进入 CLI；被测试 import 时不得触发 main（否则会解析测试进程 argv 并退出）。
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();
if (invokedDirectly) main();
