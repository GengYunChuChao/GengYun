#!/usr/bin/env node
/**
 * GY-I20 第二片（样本缺口与核准标签）· **一条命令复算**。
 *
 * 用途：把「样本缺口 6 键」与「标签核准数」从**仓内快照**重新算一遍，供评审直接重跑，
 * 不联网、不读仓库外任何产物、不写任何文件。
 *
 * 口径（只复用既有实现，不另立算法）：
 *   - 样本侧：`packages/evaluation/src/gaps.mjs` 的 `computeGaps`（先去重独立对象、只计真实样本）；
 *   - 标签侧：`docs/research/gy-i03-public-label-index-20261011.json`，
 *     核准标签 = `reviewedBy != null && licensed === true` 的条数（**不是**抓取成功条数）。
 *
 * 输出固定 7 行 `键=值`（6 键 + observedAt），其余一律 `#` 注释行，便于 grep 与人工核对：
 *   realIndexCount=172
 *   covered=7
 *   outOfCoverage=165
 *   perCoveredClassMin=0        （承诺覆盖类逐类最小；荨麻类 0 ⇒ 0）
 *   lowQuality=0
 *   approvedLabels=0
 *   observedAt=2026-10-11       （来自标签快照自身的 observed_at）
 *
 * 用法：
 *   node tools/verify-sample-gap.mjs            # 人读
 *   node tools/verify-sample-gap.mjs --json     # 机读（stdout 仅 JSON）
 *   node tools/verify-sample-gap.mjs --self-test # 内存注入一条已核准标签，证明算法不是恒 0
 *   node tools/verify-sample-gap.mjs --index=<path> --labels=<path> --manifest=<path> --frozen=<path>
 * 退出码：0 = 复算成功（self-test 全部通过）；1 = 断言/自检失败；2 = 命令行用法或文件读取失败。
 *
 * 边界声明：只复算「快照里记的」。标签快照是 2026-10-11 的观测，样本是 2026-10-14 的冻结；
 * 输出带 `provenance`（含两侧时点与摘要），**不得**把本脚本读数当成"现在是 0"或"现在是达标"。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeGaps, dedupeByIndependentObject } from '../packages/evaluation/index.mjs';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_PATHS = Object.freeze({
  index: join(REPO_ROOT, 'packages', 'evaluation', 'samples', 'gy-i20-weeds-real-index.json'),
  manifest: join(REPO_ROOT, 'packages', 'evaluation', 'samples', 'gy-i20-weeds-coverage-manifest.json'),
  frozen: join(REPO_ROOT, 'packages', 'evaluation', 'samples', 'gy-i20-weeds-frozen-manifest.json'),
  labels: join(REPO_ROOT, 'docs', 'research', 'gy-i03-public-label-index-20261011.json'),
});

/** 对外固定 6 键（顺序即输出顺序）。 */
export const GAP_KEYS = Object.freeze([
  'realIndexCount',
  'covered',
  'outOfCoverage',
  'perCoveredClassMin',
  'lowQuality',
  'approvedLabels',
]);

function readJson(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`读取失败：${path}（${error.message}）`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON 解析失败：${path}（${error.message}）`);
  }
}

/** 核准标签：两个字段都必须成立；缺字段或 `reviewedBy: null` 一律不计。 */
export function countApprovedLabels(labels) {
  if (!Array.isArray(labels)) throw new Error('标签快照缺少 labels 数组');
  return labels.filter((label) => label && label.reviewedBy != null && label.licensed === true).length;
}

/**
 * 复算一份报告。所有输入都是已解析的 JSON 值，便于测试在内存里篡改（⛔ 不改仓内文件）。
 * @returns {object} 6 键 + observedAt + derived（coveredClassCount/perClass）+ provenance
 */
export function computeGapReport({ records, coverageManifest, frozenManifest, labelSnapshot }) {
  if (!Array.isArray(records)) throw new Error('样本索引必须是数组（裸数组快照）');
  const gaps = computeGaps(records, { coverageManifest });
  const byBucket = new Map(gaps.map((entry) => [entry.bucket, entry]));
  const bucketPresent = (bucket) => {
    const entry = byBucket.get(bucket);
    if (!entry) throw new Error(`computeGaps 未返回桶：${bucket}`);
    return entry.present;
  };

  // 逐类明细与 gaps.mjs 同口径：先按独立对象去重，再过滤 真实/覆盖内/clear。
  const { kept } = dedupeByIndependentObject(records.filter((r) => r && r.sourceKind !== 'synthetic_placeholder'));
  const perClass = {};
  for (const record of kept) {
    if (record.task !== 'weed_photo' || record.coverage !== 'covered' || record.quality !== 'clear') continue;
    perClass[record.labelClass] = (perClass[record.labelClass] ?? 0) + 1;
  }
  const promisedClasses = Array.isArray(coverageManifest?.weedPhotoCoveredClasses)
    ? coverageManifest.weedPhotoCoveredClasses.filter((cls) => typeof cls === 'string' && cls.length > 0)
    : [];
  const minFromPerClass = promisedClasses.length > 0
    ? Math.min(...promisedClasses.map((cls) => perClass[cls] ?? 0))
    : 0;
  const perCoveredClassMin = bucketPresent('weed_photo_covered_per_class');
  if (minFromPerClass !== perCoveredClassMin) {
    throw new Error(`逐类明细与 gaps.mjs 口径不一致：逐类最小值=${minFromPerClass}，gaps.present=${perCoveredClassMin}`);
  }

  const covered = bucketPresent('weed_photo_covered');
  const coveredClassCount = promisedClasses.filter((cls) => (perClass[cls] ?? 0) > 0).length;
  if (coveredClassCount > covered) {
    throw new Error(`有样本覆盖类数 ${coveredClassCount} 不应超过覆盖内总数 ${covered}`);
  }

  const observedAt = labelSnapshot?.observed_at;
  if (typeof observedAt !== 'string' || observedAt.length === 0) {
    throw new Error('标签快照缺少 observed_at：输出不得缺少观测时点（否则是拿旧快照冒充现状）');
  }
  if (frozenManifest && Number.isInteger(frozenManifest.recordCount) && frozenManifest.recordCount !== records.length) {
    throw new Error(`索引条数 ${records.length} 与冻结清单 recordCount=${frozenManifest.recordCount} 不一致：快照被改动过`);
  }

  return {
    realIndexCount: records.length,
    covered,
    outOfCoverage: bucketPresent('weed_photo_out_of_coverage'),
    perCoveredClassMin,
    lowQuality: bucketPresent('weed_photo_low_quality'),
    approvedLabels: countApprovedLabels(labelSnapshot?.labels),
    observedAt,
    derived: { coveredClassCount, perClass, promisedClasses },
    provenance: {
      indexVersion: frozenManifest?.indexVersion ?? null,
      recordCount: frozenManifest?.recordCount ?? null,
      frozenAt: frozenManifest?.frozenAt ?? null,
      indexSha256: frozenManifest?.indexSha256 ?? null,
      coverageSha256: frozenManifest?.coverage?.coverageSha256 ?? null,
      labelSnapshotObservedAt: observedAt,
      labelCount: Array.isArray(labelSnapshot?.labels) ? labelSnapshot.labels.length : 0,
    },
  };
}

export function loadGapReport(paths = {}) {
  const resolved = { ...DEFAULT_PATHS, ...paths };
  const record = readJson(resolve(resolved.index));
  const coverageManifest = readJson(resolve(resolved.manifest));
  const frozenManifest = readJson(resolve(resolved.frozen));
  const labelSnapshot = readJson(resolve(resolved.labels));
  return computeGapReport({ records: record, coverageManifest, frozenManifest, labelSnapshot });
}

/** 与登记值逐键比对，返回差异数组（空数组＝一致）。 */
export function collectMismatches(report, registered) {
  const mismatches = [];
  for (const key of GAP_KEYS) {
    if (!(key in registered)) {
      mismatches.push(`${key}: 未登记（须先在证据页补登记值再接断言）`);
      continue;
    }
    if (report[key] !== registered[key]) {
      mismatches.push(`${key}: 实测=${report[key]} 登记=${registered[key]}`);
    }
  }
  if (registered.observedAt !== undefined && report.observedAt !== registered.observedAt) {
    mismatches.push(`observedAt: 实测=${report.observedAt} 登记=${registered.observedAt}`);
  }
  return mismatches;
}

/** 7 行 `键=值` + `#` 注释：人读与 grep 都用这一份。 */
export function formatGapReport(report) {
  const lines = GAP_KEYS.map((key) => `${key}=${report[key]}`);
  lines.push(`observedAt=${report.observedAt}`);
  lines.push(`# 派生：有样本的覆盖类数 coveredClassCount=${report.derived.coveredClassCount}（${Object.keys(report.derived.perClass).length} 个类有样本）`);
  lines.push(`# perClass=${JSON.stringify(report.derived.perClass)}`);
  lines.push(`# perCoveredClassMin 口径=packages/evaluation/src/gaps.mjs:40 承诺覆盖类逐类最小值；承诺类=${JSON.stringify(report.derived.promisedClasses)}`);
  lines.push(`# provenance=${JSON.stringify(report.provenance)}`);
  return lines.join('\n');
}

/** --self-test：只在内存里注入，证明 approvedLabels 不是恒 0 的摆设。 */
export function runSelfTest(labelSnapshot) {
  const checks = [];
  const check = (label, fn) => {
    try {
      fn();
      checks.push({ label, ok: true });
    } catch (error) {
      checks.push({ label, ok: false, reason: error.message });
    }
  };
  const base = labelSnapshot?.labels ?? [];
  const clone = () => JSON.parse(JSON.stringify(base));

  check('真实快照核准标签=0（24 条均无 reviewedBy/licensed）', () => {
    const actual = countApprovedLabels(clone());
    if (actual !== 0) throw new Error(`期望 0，实测 ${actual}`);
  });
  check('内存注入 reviewedBy + licensed=true ⇒ 核准标签变 1（算法不空转）', () => {
    const injected = clone();
    if (injected.length === 0) throw new Error('快照没有标签，无法注入');
    injected[0] = { ...injected[0], reviewedBy: 'self-test', licensed: true };
    const actual = countApprovedLabels(injected);
    if (actual !== 1) throw new Error(`期望 1，实测 ${actual}`);
  });
  check('只给 licensed=true、reviewedBy 缺省 ⇒ 仍不计（两字段缺一不可）', () => {
    const injected = clone();
    injected[0] = { ...injected[0], reviewedBy: null, licensed: true };
    const actual = countApprovedLabels(injected);
    if (actual !== 0) throw new Error(`期望 0，实测 ${actual}`);
  });
  check('只给 reviewedBy、licensed=false ⇒ 仍不计', () => {
    const injected = clone();
    injected[0] = { ...injected[0], reviewedBy: 'self-test', licensed: false };
    const actual = countApprovedLabels(injected);
    if (actual !== 0) throw new Error(`期望 0，实测 ${actual}`);
  });
  check('空标签数组 ⇒ 0（不得抛错或编造）', () => {
    const actual = countApprovedLabels([]);
    if (actual !== 0) throw new Error(`期望 0，实测 ${actual}`);
  });
  return checks;
}

function parseArgs(argv) {
  const options = { json: false, selfTest: false, paths: {} };
  for (const arg of argv) {
    if (arg === '--json') options.json = true;
    else if (arg === '--self-test') options.selfTest = true;
    else if (arg.startsWith('--index=')) options.paths.index = arg.slice('--index='.length);
    else if (arg.startsWith('--labels=')) options.paths.labels = arg.slice('--labels='.length);
    else if (arg.startsWith('--manifest=')) options.paths.manifest = arg.slice('--manifest='.length);
    else if (arg.startsWith('--frozen=')) options.paths.frozen = arg.slice('--frozen='.length);
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.selfTest) {
    const labelSnapshot = readJson(resolve(options.paths.labels ?? DEFAULT_PATHS.labels));
    const checks = runSelfTest(labelSnapshot);
    for (const entry of checks) {
      process.stdout.write(`  [${entry.ok ? 'PASS' : 'FAIL'}] ${entry.label}${entry.ok ? '' : ` -> ${entry.reason}`}\n`);
    }
    const failed = checks.filter((entry) => !entry.ok).length;
    process.stdout.write(`self-test: ${failed === 0 ? 'PASS' : 'FAIL'} (${checks.length - failed}/${checks.length})\n`);
    process.exitCode = failed === 0 ? 0 : 1;
    return;
  }

  const report = loadGapReport(options.paths);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write('# GY-I20 样本缺口复算（只读仓内快照；不联网、不写文件）\n');
  process.stdout.write(`# index=${resolve(options.paths.index ?? DEFAULT_PATHS.index)}\n`);
  process.stdout.write(`# labels=${resolve(options.paths.labels ?? DEFAULT_PATHS.labels)}\n`);
  process.stdout.write(`${formatGapReport(report)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`verify-sample-gap: ${error.message}\n`);
    process.exitCode = 2;
  }
}
