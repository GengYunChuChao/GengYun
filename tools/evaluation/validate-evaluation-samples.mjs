#!/usr/bin/env node
// 样本索引合规校验命令。
// 用法：node tools/evaluation/validate-evaluation-samples.mjs --index <index.json> [--hamming N] [--quiet]
// 校验：schema 必填/枚举、原始媒体不提交、模型不自答、同源裁剪/连拍/近重复不跨 split。
// 退出码：0=通过，1=有错误。
import { validateSampleIndex } from '../../packages/evaluation/index.mjs';
import { loadJson, parseArgs } from './lib.mjs';

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.index) {
    process.stderr.write('用法: node tools/evaluation/validate-evaluation-samples.mjs --index <index.json> [--hamming N]\n');
    process.exit(2);
  }
  const records = loadJson(args.index);
  const { ok, errors, warnings, stats } = validateSampleIndex(records, {
    hammingThreshold: args.hamming ? Number(args.hamming) : undefined,
  });

  if (!args.quiet) {
    process.stdout.write(`样本索引：${args.index}\n`);
    process.stdout.write(`总记录=${stats?.total ?? 0}  按任务=${JSON.stringify(stats?.byTask ?? {})}\n`);
    process.stdout.write(`按划分=${JSON.stringify(stats?.bySplit ?? {})}  按来源=${JSON.stringify(stats?.bySourceKind ?? {})}\n`);
    if (stats && stats.synthetic > 0) {
      process.stdout.write(`注意：含 ${stats.synthetic} 条 synthetic_placeholder，仅用于验证程序，不得计入真实评估。\n`);
    }
    for (const w of warnings) process.stdout.write(`! ${w}\n`);
    for (const e of errors) process.stdout.write(`错误: ${e}\n`);
  }
  process.stdout.write(ok ? '校验结果：通过（无错误）\n' : `校验结果：失败（${errors.length} 项错误）\n`);
  process.exit(ok ? 0 : 1);
}

main();
