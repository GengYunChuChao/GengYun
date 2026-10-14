#!/usr/bin/env node
// GY-I20 真实样本冻结清单生成/复算器。
// 冻结清单必须可复算：本工具从**索引文件本身**重算 test 集规范化 SHA-256、记录数与覆盖绑定摘要，
// 再写出（--out）或核对（--verify）冻结清单；来源标签或手填版本号都不能代替这一步。
//
// 用法：
//   node tools/evaluation/freeze-real-samples.mjs --index <index.json> --coverage <coverage-manifest.json> \
//     --index-version <版本号> [--frozen-at <ISO 时间>] [--out <frozen-manifest.json>] [--verify <frozen-manifest.json>]
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { computeCoverageSha256, computeRecordsSha256, verifyCoverageBinding, verifyFrozenManifest } from '../../packages/evaluation/index.mjs';
import { parseArgs } from './lib.mjs';

const load = (p) => JSON.parse(readFileSync(String(p), 'utf8'));

/** 计算冻结清单的可核查字段（纯函数，便于测试与复算）。 */
export function computeFreezeFacts(records, coverageManifest, { indexVersion, frozenAt, manifestVersion = '1.0.0' }) {
  const testRecords = records.filter((r) => r && r.split === 'test');
  const classes = Array.isArray(coverageManifest?.weedPhotoCoveredClasses)
    ? coverageManifest.weedPhotoCoveredClasses.filter((c) => typeof c === 'string' && c.trim() !== '')
    : [];
  const manifest = {
    manifestVersion,
    indexVersion,
    split: 'test',
    recordCount: testRecords.length,
    indexSha256: computeRecordsSha256(testRecords),
    frozenAt,
    coverage: {
      weedPhotoCoveredClasses: classes,
      coverageSha256: computeCoverageSha256({ weedPhotoCoveredClasses: classes }),
      basisRef: coverageManifest?.basisRef ?? null,
    },
  };
  return {
    manifest,
    facts: {
      totalRecords: records.length,
      testRecords: testRecords.length,
      indexSha256: manifest.indexSha256,
      coverageSha256: manifest.coverage.coverageSha256,
      recordCount: manifest.recordCount,
    },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.index || !args.coverage) {
    process.stderr.write(
      '用法: node tools/evaluation/freeze-real-samples.mjs --index <index.json> --coverage <coverage-manifest.json> --index-version <v> [--frozen-at <ISO>] [--out <manifest.json>] [--verify <manifest.json>]\n',
    );
    process.exit(2);
  }
  const records = load(args.index);
  const coverage = load(args.coverage);
  const { manifest, facts } = computeFreezeFacts(records, coverage, {
    indexVersion: args['index-version'] ? String(args['index-version']) : 'unversioned',
    frozenAt: args['frozen-at'] ? String(args['frozen-at']) : new Date().toISOString(),
  });

  process.stdout.write(`索引总记录=${facts.totalRecords}  split=test 记录=${facts.testRecords}\n`);
  process.stdout.write(`indexSha256(规范化 test 集)=${facts.indexSha256}\n`);
  process.stdout.write(`coverageSha256(承诺覆盖类)=${facts.coverageSha256}  承诺类数=${manifest.coverage.weedPhotoCoveredClasses.length}\n`);

  if (args.out) {
    writeFileSync(String(args.out), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`冻结清单已写出 ${args.out}\n`);
  }

  if (args.verify) {
    const existing = load(args.verify);
    const frozen = verifyFrozenManifest(existing, records.filter((r) => r.split === 'test'));
    const binding = verifyCoverageBinding(existing, coverage);
    process.stdout.write(`复算核对 ${args.verify}：冻结=${frozen.verified ? '通过' : '不通过'}（${frozen.reasons.join('；') || '无差异'}）\n`);
    process.stdout.write(`覆盖绑定：${binding.verified ? '通过' : '不通过'}（${binding.reasons.join('；') || '无差异'}）\n`);
    process.stdout.write(`冻结清单自身 sha256=${frozen.manifestSha256}\n`);
    const exitCode = frozen.verified && binding.verified ? 0 : 1;
    process.exit(exitCode);
  }
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();
if (invokedDirectly) main();
