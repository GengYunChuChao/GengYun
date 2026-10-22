#!/usr/bin/env node
// 可重复运行的评估命令。
// 用法：
//   node tools/evaluation/run-evaluation.mjs --index <index.json> --predictions <predictions.json> [--manifest <frozen-manifest.json>] [--coverage <coverage-manifest.json>] [--digests <digests.json>] [--labels <labels.json>] [--out report.json] [--seed N] [--generated-at <ISO8601>] [--json]
// --generated-at 固定报告里的 `generatedAt`（缺省仍取墙钟，向后兼容）：指标本来确定，但墙钟时间戳让
//   「同输入两份报告」字节不同，`sha256` 比对就无法作为可复现证据；给出该参数后同输入两次运行的报告逐字节相同。
// --digests 给出逐条摘要台账：冻结集任何一条被改动都**点名**到 sampleId 与字段路径；
// --labels 给出标准答案键：按冻结清单 `answerKey` 单向核对并做索引↔答案键交叉核对。
// 两者都是**显式声明"我要核对完整性"**：一旦给出而核对不通过，本命令以退出码 1 结束（红），
//   避免"整体不一致但 CI 仍绿"；不给出时保持旧行为（报告内如实记 false，由读数断言把关）。
// --json 输出机器可读报告；默认输出报告 JSON 到 stdout，并附人类可读摘要到 stderr。
// 关键：只有**经冻结清单校验的独立 test 集**、真实来源、达第6节目标且预测完整时才可能 isRealEvaluation=true；
//       合成/占位/未冻结/样本不足/预测缺失的输入恒为 false，全部门禁 not_evaluated。
// 范围口径：GY-I03 承诺范围的展示用中文组名会经 species.json 映射为规范物种 ID 后再核对，
//       labelClass/gold/candidates 一律使用规范 ID（映射依据记入报告 coverageBinding.scopeBasis）。
import { writeFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  evaluateRun,
  METRIC_GATES,
  validateSampleIndex,
  validatePredictions,
  formatPredictionContractErrors,
} from '../../packages/evaluation/index.mjs';
import { loadJson, toPredictionMap, formatSummary, parseArgs } from './lib.mjs';
import { loadKnowledgeScope } from './knowledge-scope.mjs';

const USAGE =
  '用法: node tools/evaluation/run-evaluation.mjs --index <index.json> --predictions <predictions.json> [--manifest <frozen-manifest.json>] [--coverage <coverage-manifest.json>] [--digests <digests.json>] [--labels <labels.json>] [--out report.json] [--seed N] [--generated-at <ISO8601>] [--json]\n';

/** ISO8601 时间戳（必须带时区，避免"本地时间"歧义）。 */
const ISO8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * 解析 `--generated-at`：把用户给的时间点规范化为 UTC ISO 串（`Date#toISOString()`），
 * 使同一时刻的不同写法（+08:00 / Z / 不同小数位）产出**逐字节相同**的报告。
 * @returns {{ ok: true, value: string } | { ok: false, reason: string }}
 */
export function parseGeneratedAt(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: '--generated-at 缺少值（需 ISO8601 时间戳，例如 2026-10-04T00:00:00Z）' };
  }
  const value = raw.trim();
  if (!ISO8601.test(value)) {
    return { ok: false, reason: `--generated-at 不是合法的 ISO8601 时间戳：${value}（需带时区，例如 2026-10-04T00:00:00Z）` };
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { ok: false, reason: `--generated-at 无法解析为时间点：${value}` };
  return { ok: true, value: date.toISOString() };
}

/**
 * 运行一次评估（CLI 核心，便于集成测试在进程内驱动——本环境禁止派生子进程）。
 * @returns { exitCode, report }；仅向给定 stdout/stderr 写输出，不调用 process.exit。
 */
export function runEvaluation(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const args = parseArgs(argv);
  if (!args.index || !args.predictions) {
    stderr.write(USAGE);
    return { exitCode: 2, report: null };
  }
  // 时间戳先校验：用户显式给了报告时间点却写错，应当在跑评估之前就红，而不是悄悄回落到墙钟。
  let generatedAt;
  if (args['generated-at'] !== undefined) {
    const parsed = parseGeneratedAt(args['generated-at']);
    if (!parsed.ok) {
      stderr.write(`${parsed.reason}\n`);
      return { exitCode: 2, report: null };
    }
    generatedAt = parsed.value;
  }
  const records = loadJson(args.index);
  const predictions = toPredictionMap(loadJson(args.predictions));
  const frozenManifest = args.manifest ? loadJson(args.manifest) : null;
  const coverageManifest = args.coverage ? loadJson(args.coverage) : null;
  const digestLedger = args.digests ? loadJson(args.digests) : null;
  const labels = args.labels ? loadJson(args.labels) : null;

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

  // 预测结构契约（`schema/predictions.schema.json`）：不合契约即在评估前红，并点名 sampleId / task / 缺哪个字段。
  // 为什么放在 evaluateRun 之前：形状不合的预测在评分期只会**少算**（字段缺失 → 该项永不命中），
  // 报告里分不清"模型没给这个字段"与"模型给错了"；契约校验把这件事变成可见的失败。
  const contract = validatePredictions(records, predictions);
  if (!contract.ok) {
    stderr.write(`${formatPredictionContractErrors(contract)}\n`);
    return { exitCode: 1, report: null };
  }
  if (contract.skippedServiceFailure > 0) {
    stderr.write(`! ${contract.skippedServiceFailure} 条预测标注了服务失败（error/failed/served）：按服务失败跳过形状校验，报告中计为 invalid 且相关门禁 not_evaluated。\n`);
  }
  if (contract.extraIds.length > 0) {
    stderr.write(`! ${contract.extraIds.length} 条预测的 sampleId 不在索引内：跳过形状校验（报告按 extra 记并忽略）。\n`);
  }

  const report = evaluateRun(records, predictions, {
    gateDefs: METRIC_GATES,
    frozenManifest,
    coverageManifest,
    digestLedger,
    labels,
    knowledgeScope,
    seed: args.seed ? Number(args.seed) : undefined,
    // 时间戳走参数注入：未给 --generated-at 时为 undefined，evaluateRun 仍取墙钟（旧行为不变）。
    generatedAt,
  });

  // 完整性硬闸门：显式给了台账/答案键就必须核对通过，否则本命令以 1 结束（点名原因走 stderr）。
  let integrityExit = 0;
  if (args.digests && !report.frozenVerified) {
    stderr.write(`冻结校验失败（已给逐条台账）：${report.frozenVerification.reasons.join('；')}\n`);
    integrityExit = 1;
  }
  if (args.labels && report.answerKey && !report.answerKey.verified) {
    stderr.write(`标准答案键校验失败：${report.answerKey.reasons.join('；')}\n`);
    integrityExit = 1;
  }

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) {
    writeFileSync(String(args.out), json);
    stderr.write(`报告已写入 ${args.out}\n`);
  }
  stdout.write(json);
  stderr.write(`${formatSummary(report)}\n`);
  return { exitCode: integrityExit, report };
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
