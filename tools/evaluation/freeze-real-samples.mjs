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
import {
  FROZEN_DIGESTS_SCHEMA,
  buildDigestLedger,
  computeAnswerKeySha256,
  computeCoverageSha256,
  computeRecordsSha256,
  serializeDigestLedger,
  verifyAnswerKeyBinding,
  verifyCoverageBinding,
  verifyDigestLedger,
  verifyFrozenManifest,
} from '../../packages/evaluation/index.mjs';
import { parseArgs } from './lib.mjs';

const load = (p) => JSON.parse(readFileSync(String(p), 'utf8'));

/**
 * 计算冻结清单的可核查字段（纯函数，便于测试与复算）。
 * `labels`（可选）给出时，清单**单向**钉住标准答案键：`answerKey = { path, version, recordCount, sha256 }`；
 * `digestLedger`（可选）给出时登记逐条摘要台账指针，使冻结集被改动时可点名到样本与字段。
 */
export function computeFreezeFacts(
  records,
  coverageManifest,
  { indexVersion, frozenAt, manifestVersion = '1.1.0', labels = null, answerKeyPath = null, digestLedgerPath = null } = {},
) {
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
  if (labels) {
    manifest.answerKey = {
      path: answerKeyPath ?? null,
      version: typeof labels.version === 'string' ? labels.version : null,
      recordCount: Array.isArray(labels.entries) ? labels.entries.length : null,
      sha256: computeAnswerKeySha256(labels),
      binding: '清单单向钉住答案键（sha256+版本+条数）；答案键不反向依赖清单',
    };
  }
  if (digestLedgerPath) {
    const ledger = buildDigestLedger(testRecords, { indexVersion });
    manifest.digestLedger = {
      path: digestLedgerPath,
      schema: FROZEN_DIGESTS_SCHEMA,
      recordCount: ledger.recordCount,
      recordsSha256: ledger.recordsSha256,
      recordsDigest: ledger.recordsDigest,
      scope: '逐条记录摘要 + 逐字段摘要（12 位），可点名到 sampleId 与字段路径',
    };
  }
  return {
    manifest,
    facts: {
      totalRecords: records.length,
      testRecords: testRecords.length,
      indexSha256: manifest.indexSha256,
      coverageSha256: manifest.coverage.coverageSha256,
      recordCount: manifest.recordCount,
      answerKeySha256: manifest.answerKey?.sha256 ?? null,
      digestLedgerRecordsDigest: manifest.digestLedger?.recordsDigest ?? null,
    },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.index || !args.coverage) {
    process.stderr.write(
      '用法: node tools/evaluation/freeze-real-samples.mjs --index <index.json> --coverage <coverage-manifest.json> --index-version <v> [--frozen-at <ISO>] [--labels <labels.json>] [--digests <digests.json>|--verify-digests <digests.json>] [--out <manifest.json>] [--verify <manifest.json>]\n',
    );
    process.exit(2);
  }
  const records = load(args.index);
  const coverage = load(args.coverage);
  const labels = args.labels ? load(args.labels) : null;
  const testRecords = records.filter((r) => r.split === 'test');

  // 台账路径：--digests 写出时的目标路径，或 --verify-digests 指向的既有台账路径。
  const digestPath = args.digests ? String(args.digests) : args['verify-digests'] ? String(args['verify-digests']) : null;

  // --verify-digests：重算台账并与既有台账逐条比对（改动即点名）。
  if (args['verify-digests']) {
    const existing = load(args['verify-digests']);
    const recomputed = buildDigestLedger(testRecords, { indexVersion: args['index-version'] ? String(args['index-version']) : existing.indexVersion ?? null });
    const structural = verifyDigestLedger(existing, testRecords);
    const byteStable = serializeDigestLedger(existing) === serializeDigestLedger(recomputed);
    process.stdout.write(`逐条台账核对 ${args['verify-digests']}：结构=${structural.verified ? '通过' : '不通过'}  逐字节可复算=${byteStable ? '是' : '否'}\n`);
    if (structural.reasons.length > 0) process.stdout.write(`  差异：${structural.reasons.join('；')}\n`);
    if (!byteStable) process.stdout.write('  差异：重算台账与既有台账文本不一致（台账非由本脚本生成，或被手改/字段口径已变）\n');
    if (!structural.verified || !byteStable) process.exit(1);
  }

  const { manifest, facts } = computeFreezeFacts(records, coverage, {
    indexVersion: args['index-version'] ? String(args['index-version']) : 'unversioned',
    frozenAt: args['frozen-at'] ? String(args['frozen-at']) : new Date().toISOString(),
    labels,
    answerKeyPath: args.labels ? String(args.labels) : null,
    digestLedgerPath: digestPath,
  });

  process.stdout.write(`索引总记录=${facts.totalRecords}  split=test 记录=${facts.testRecords}\n`);
  process.stdout.write(`indexSha256(规范化 test 集)=${facts.indexSha256}\n`);
  process.stdout.write(`coverageSha256(承诺覆盖类)=${facts.coverageSha256}  承诺类数=${manifest.coverage.weedPhotoCoveredClasses.length}\n`);
  if (facts.answerKeySha256) {
    process.stdout.write(`answerKeySha256(规范化答案键)=${facts.answerKeySha256}  答案键版本=${manifest.answerKey.version}  条目=${manifest.answerKey.recordCount}\n`);
  }
  if (facts.digestLedgerRecordsDigest) process.stdout.write(`逐条摘要台账：recordsDigest=${facts.digestLedgerRecordsDigest}  记录数=${manifest.digestLedger.recordCount}\n`);

  if (args.digests) {
    const ledger = buildDigestLedger(testRecords, { indexVersion: manifest.indexVersion });
    writeFileSync(String(args.digests), serializeDigestLedger(ledger));
    process.stdout.write(`逐条摘要台账已写出 ${args.digests}（${ledger.recordCount} 条，recordsDigest=${ledger.recordsDigest}）\n`);
  }

  if (args.out) {
    writeFileSync(String(args.out), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`冻结清单已写出 ${args.out}\n`);
  }

  if (args.verify) {
    const existing = load(args.verify);
    const ledgerForVerify = args['verify-digests'] ? load(args['verify-digests']) : args.digests ? load(args.digests) : null;
    const frozen = verifyFrozenManifest(existing, testRecords, { digestLedger: ledgerForVerify });
    const binding = verifyCoverageBinding(existing, coverage);
    process.stdout.write(`复算核对 ${args.verify}：冻结=${frozen.verified ? '通过' : '不通过'}（${frozen.reasons.join('；') || '无差异'}）\n`);
    process.stdout.write(`覆盖绑定：${binding.verified ? '通过' : '不通过'}（${binding.reasons.join('；') || '无差异'}）\n`);
    process.stdout.write(`冻结清单自身 sha256=${frozen.manifestSha256}\n`);
    let answerKeyOk = true;
    if (existing.answerKey) {
      const check = verifyAnswerKeyBinding(existing, labels);
      answerKeyOk = check.verified;
      process.stdout.write(`答案键绑定：${check.verified ? '通过' : '不通过'}（${check.reasons.join('；') || '无差异'}）\n`);
    }
    if (frozen.drift && (frozen.drift.changed.length || frozen.drift.added.length || frozen.drift.removed.length)) {
      process.stdout.write(`逐条漂移：改动=${frozen.drift.changed.length} 新增=${frozen.drift.added.length} 删除=${frozen.drift.removed.length}\n`);
    }
    const exitCode = frozen.verified && binding.verified && answerKeyOk ? 0 : 1;
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
