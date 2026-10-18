// GY-I20 第二片：样本缺口与核准标签「一条命令复算」的闸门。
// 目的：让 6 键与 observedAt 不再靠人抄，而是**现场重算 + 与证据页登记值逐键比对**；
// 并用内存/临时副本的负控制证明这套比对**会红**（不是恒绿的摆设）。
// ⛔ 不改仓内数据文件；负控制只写系统临时目录并事后清理。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_PATHS,
  GAP_KEYS,
  REPO_ROOT,
  collectMismatches,
  computeGapReport,
  countApprovedLabels,
  loadGapReport,
} from '../../tools/verify-sample-gap.mjs';

const EVIDENCE_PATH = join(REPO_ROOT, 'docs', 'verification', 'gy-i20-real-samples-20261014.md');
const TOOL_PATH = join(REPO_ROOT, 'tools', 'verify-sample-gap.mjs');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** 从证据页「$ node tools/verify-sample-gap.mjs」之后的代码块里取 `键=值`。 */
function registeredFromEvidence() {
  const lines = readFileSync(EVIDENCE_PATH, 'utf8').split(/\r?\n/);
  // 只认代码块里的 `$ node tools/verify-sample-gap.mjs`（§7 清单里的同名字样是索引，不是登记块）。
  const start = lines.findIndex((line) => line.trim().startsWith('$ node tools/verify-sample-gap.mjs'));
  assert.ok(start >= 0, '证据页缺少 `$ node tools/verify-sample-gap.mjs` 复算命令块：先补命令与登记值');
  const registered = {};
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.startsWith('```')) break;
    const match = /^([A-Za-z][A-Za-z0-9]*)=(\S+)$/.exec(line);
    if (!match) continue;
    registered[match[1]] = /^\d+$/.test(match[2]) ? Number(match[2]) : match[2];
  }
  return registered;
}

test('证据页登记的 6 键与 observedAt 与现场复算逐键一致', () => {
  const report = loadGapReport();
  const registered = registeredFromEvidence();
  const mismatches = collectMismatches(report, registered);
  assert.deepEqual(mismatches, [], `复算与证据页登记不一致：${mismatches.join('；')}`);
  for (const key of GAP_KEYS) {
    assert.equal(typeof registered[key], 'number', `证据页未登记数字：${key}`);
  }
  assert.equal(registered.observedAt, '2026-10-11');
});

test('observedAt 取自标签快照自身，provenance 与冻结清单互相钉死', () => {
  const report = loadGapReport();
  const labelSnapshot = readJson(DEFAULT_PATHS.labels);
  const frozen = readJson(DEFAULT_PATHS.frozen);

  assert.equal(report.observedAt, labelSnapshot.observed_at, 'observedAt 必须与标签快照 observed_at 字面相等');
  assert.equal(report.provenance.labelSnapshotObservedAt, labelSnapshot.observed_at);
  assert.equal(report.provenance.labelCount, labelSnapshot.labels.length);
  assert.equal(report.provenance.frozenAt, frozen.frozenAt, '样本侧时点须如实带出，避免与标签时点混淆');
  assert.equal(report.provenance.recordCount, frozen.recordCount);
  assert.equal(report.realIndexCount, frozen.recordCount, '索引条数须与冻结清单 recordCount 一致');
  assert.equal(report.provenance.indexSha256, frozen.indexSha256);
  assert.equal(report.provenance.indexVersion, frozen.indexVersion);
});

test('逐类最小值 0 与有样本覆盖类数 7 同时钉死（口径不互相冒充）', () => {
  const report = loadGapReport();
  const { perClass, coveredClassCount, promisedClasses } = report.derived;

  assert.equal(report.perCoveredClassMin, 0, '承诺 8 类含 species_nettle_group=0 ⇒ 逐类最小值是 0');
  assert.equal(
    Math.min(...promisedClasses.map((cls) => perClass[cls] ?? 0)),
    report.perCoveredClassMin,
    '逐类明细与 gaps.mjs 的 Math.min 口径必须一致',
  );
  assert.equal(report.covered, 7);
  assert.equal(coveredClassCount, 7, '有样本的覆盖类数：七类各 1');
  assert.deepEqual(Object.keys(perClass).sort(), [
    'species_alligatorweed',
    'species_barnyardgrass',
    'species_crabgrass',
    'species_foxtail',
    'species_goosegrass',
    'species_lambsquarters',
    'species_shortawn_foxtail',
  ]);
  assert.equal(perClass.species_nettle_group, undefined, '荨麻类 0 条样本，不得凭空出现');
  assert.equal(promisedClasses.length, 8, '承诺覆盖类 8 类，荨麻类在承诺内但无样本');
});

test('CLI --json 与库函数返回同一份读数', () => {
  const result = spawnSync(process.execPath, [TOOL_PATH, '--json'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, `CLI 退出码非 0：${result.stderr}`);
  const fromCli = JSON.parse(result.stdout);
  const report = loadGapReport();
  for (const key of GAP_KEYS) assert.equal(fromCli[key], report[key], `--json 与库函数的 ${key} 不一致`);
  assert.equal(fromCli.observedAt, report.observedAt);
  assert.deepEqual(fromCli.derived, report.derived);
});

test('--self-test 通过：核准标签算法不空转（注入一条即变 1）', () => {
  const result = spawnSync(process.execPath, [TOOL_PATH, '--self-test'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, `自检退出码非 0：${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /self-test: PASS \(5\/5\)/);
  assert.match(result.stdout, /\[PASS\] 内存注入 reviewedBy \+ licensed=true ⇒ 核准标签变 1/);
});

test('负控制 A：临时副本里注入一条已核准标签，比对必须转红', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gy-i20-gap-a-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const snapshot = readJson(DEFAULT_PATHS.labels);
  const tampered = {
    ...snapshot,
    labels: [{ ...snapshot.labels[0], reviewedBy: 'negative-control', licensed: true }, ...snapshot.labels.slice(1)],
  };
  const tamperedPath = join(dir, 'labels-tampered.json');
  writeFileSync(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');

  const report = loadGapReport({ labels: tamperedPath });
  assert.equal(report.approvedLabels, 1, '篡改副本必须真的算出 1，否则负控制没测到东西');
  const mismatches = collectMismatches(report, registeredFromEvidence());
  assert.ok(mismatches.length > 0, '核准标签被篡改后比对必须报差异');
  assert.ok(
    mismatches.some((message) => message.startsWith('approvedLabels:') && message.includes('实测=1') && message.includes('登记=0')),
    `差异须点名 approvedLabels：${mismatches.join('；')}`,
  );
  // 仓内快照不受影响（负控制只落在临时副本）。
  assert.equal(countApprovedLabels(readJson(DEFAULT_PATHS.labels).labels), 0);
});

test('负控制 B：索引少 1 条或与冻结清单不符时，复算必须报错/报差异', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gy-i20-gap-b-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const records = readJson(DEFAULT_PATHS.index);
  const coverageManifest = readJson(DEFAULT_PATHS.manifest);
  const labelSnapshot = readJson(DEFAULT_PATHS.labels);
  const shortened = records.slice(0, records.length - 1);

  const report = computeGapReport({ records: shortened, coverageManifest, frozenManifest: null, labelSnapshot });
  assert.equal(report.realIndexCount, records.length - 1);
  const mismatches = collectMismatches(report, registeredFromEvidence());
  assert.ok(
    mismatches.some((message) => message.startsWith('realIndexCount:') && message.includes(`实测=${records.length - 1}`)),
    `少一条索引时必须点名 realIndexCount：${mismatches.join('；')}`,
  );

  // 冻结清单在场时，条数不符应直接抛错而不是静默给出漂亮数字。
  const tamperedPath = join(dir, 'index-tampered.json');
  writeFileSync(tamperedPath, `${JSON.stringify(shortened, null, 2)}\n`, 'utf8');
  assert.throws(
    () => loadGapReport({ index: tamperedPath }),
    /与冻结清单 recordCount=\d+ 不一致/,
    '索引条数与冻结清单不符时必须抛错',
  );
});
