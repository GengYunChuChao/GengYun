// GY-I20（issue #20）冻结完整性回归：
//   ① 逐条摘要台账：样本集任何一条被改动都必须**点名**到 sampleId 与字段路径（不是笼统失败）；
//   ② 标准答案键绑定：冻结清单单向钉住 labels 的 sha256+版本+条数，索引↔答案键逐条交叉核对；
//   ③ 跨平台稳定：同一内容 CRLF 与 LF 两种字节形态摘要相同（BOM 由读取侧剥离）。
// 真数据：packages/evaluation/samples/ 下的 172 条真实拍草样本（split=test）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIGEST_FIELD_PATHS,
  FROZEN_DIGESTS_SCHEMA,
  buildDigestLedger,
  computeAnswerKeySha256,
  computeRecordsSha256,
  evaluateRun,
  verifyAnswerKeyAgainstIndex,
  verifyAnswerKeyBinding,
  verifyDigestLedger,
  verifyFrozenManifest,
  METRIC_GATES,
} from '../../packages/evaluation/index.mjs';
import { loadJson } from '../../tools/evaluation/lib.mjs';

const SAMPLES = fileURLToPath(new URL('../../packages/evaluation/samples/', import.meta.url));
const INDEX_PATH = join(SAMPLES, 'gy-i20-weeds-real-index.json');
const LABELS_PATH = join(SAMPLES, 'gy-i20-weeds-labels.json');
const MANIFEST_PATH = join(SAMPLES, 'gy-i20-weeds-frozen-manifest.json');
const DIGESTS_PATH = join(SAMPLES, 'gy-i20-weeds-frozen-digests.json');
const COVERAGE_PATH = join(SAMPLES, 'gy-i20-weeds-coverage-manifest.json');
const PREDICTIONS_PATH = join(SAMPLES, 'gy-i20-weeds-predictions-none.json');

const readIndex = () => loadJson(INDEX_PATH);
const testRecordsOf = (records) => records.filter((r) => r.split === 'test');
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------- ① 逐条摘要台账

test('逐条摘要台账覆盖 172 条 test 样本，记录摘要/字段摘要自洽且可复算', () => {
  const records = readIndex();
  const testRecords = testRecordsOf(records);
  assert.equal(testRecords.length, 172);

  const ledger = loadJson(DIGESTS_PATH);
  assert.equal(ledger.schema, FROZEN_DIGESTS_SCHEMA);
  assert.equal(ledger.recordCount, 172);
  assert.equal(ledger.digestAlgorithm, 'sha256');
  assert.equal(ledger.fieldDigestLength, 12);
  assert.deepEqual(ledger.fieldPaths, [...DIGEST_FIELD_PATHS]);
  assert.equal(ledger.records.length, 172);

  // 台账必须由脚本从**真实** test 集复算得出：记录集摘要与索引对账。
  assert.equal(ledger.recordsSha256, computeRecordsSha256(testRecords));
  // 逐条：每条的字段摘要集合与路径表一一对应（不多不少）。
  for (const entry of ledger.records) {
    assert.deepEqual(Object.keys(entry.fields), [...DIGEST_FIELD_PATHS], `${entry.sampleId} 的字段路径与常量表不一致`);
    for (const [path, digest] of Object.entries(entry.fields)) {
      assert.match(digest, /^[a-f0-9]{12}$/, `${entry.sampleId}.${path} 的字段摘要应为 12 位十六进制`);
    }
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  }

  // 干净输入：通过，且无漂移。
  const check = verifyDigestLedger(ledger, testRecords);
  assert.equal(check.verified, true, check.reasons.join('；'));
  assert.deepEqual(check.reasons, []);
  assert.deepEqual(check.drift, { changed: [], added: [], removed: [] });
});

test('台账一行一条（便于 git diff：改一条只动一行）', () => {
  const text = readFileSync(DIGESTS_PATH, 'utf8');
  const recordLines = text.split(/\r?\n/).filter((l) => l.includes('"sampleId"'));
  assert.equal(recordLines.length, 172);
});

test('只改一条样本的一个字段 ⇒ 台账点名该 sampleId 且 fields 只列那一个字段', () => {
  const records = readIndex();
  const ledger = loadJson(DIGESTS_PATH);

  // case 1：改第 5 条的 labelClass
  const case1 = clone(records);
  const i5 = case1.findIndex((r) => r.sampleId === 'gy-i20-weeds-005');
  assert.ok(i5 >= 0);
  case1[i5].labelClass = 'species_crabgrass';
  const r1 = verifyDigestLedger(ledger, testRecordsOf(case1));
  assert.equal(r1.verified, false);
  assert.equal(r1.drift.changed.length, 1);
  assert.equal(r1.drift.changed[0].sampleId, 'gy-i20-weeds-005');
  assert.deepEqual(r1.drift.changed[0].fields, ['labelClass'], '只改一个字段时不得把整条记录所有字段都列出来');
  assert.ok(
    r1.reasons.some((r) => r.includes('gy-i20-weeds-005') && r.includes('labelClass')),
    `理由必须点名到样本与字段，实际：${JSON.stringify(r1.reasons)}`,
  );

  // case 2：只改第 101 条的 notes（最不显眼的字段也要点名）
  const case2 = clone(records);
  const i101 = case2.findIndex((r) => r.sampleId === 'gy-i20-weeds-101');
  assert.ok(i101 >= 0);
  case2[i101].notes = `${case2[i101].notes ?? ''}X`;
  const r2 = verifyDigestLedger(ledger, testRecordsOf(case2));
  assert.equal(r2.verified, false);
  assert.deepEqual(r2.drift.changed.map((c) => [c.sampleId, c.fields]), [['gy-i20-weeds-101', ['notes']]]);
});

test('新增/删除样本 ⇒ 台账点名 added / removed', () => {
  const records = readIndex();
  const ledger = loadJson(DIGESTS_PATH);

  const extra = clone(records);
  extra.push({ ...clone(extra[0]), sampleId: 'gy-i20-weeds-173' });
  const added = verifyDigestLedger(ledger, testRecordsOf(extra));
  assert.equal(added.verified, false);
  assert.deepEqual(added.drift.added, ['gy-i20-weeds-173']);
  assert.ok(added.reasons.some((r) => r.includes('冻结集新增样本：gy-i20-weeds-173')));

  const fewer = clone(records).filter((r) => r.sampleId !== 'gy-i20-weeds-042');
  const removed = verifyDigestLedger(ledger, testRecordsOf(fewer));
  assert.equal(removed.verified, false);
  assert.deepEqual(removed.drift.removed, ['gy-i20-weeds-042']);
  assert.ok(removed.reasons.some((r) => r.includes('冻结集样本被删除：gy-i20-weeds-042')));
});

test('冻结清单登记台账指针，且给台账时 verifyFrozenManifest 把漂移并入理由（点名）', () => {
  const records = readIndex();
  const testRecords = testRecordsOf(records);
  const manifest = loadJson(MANIFEST_PATH);
  const ledger = loadJson(DIGESTS_PATH);

  assert.equal(manifest.manifestVersion, '1.1.0');
  assert.equal(manifest.digestLedger.schema, FROZEN_DIGESTS_SCHEMA);
  assert.equal(manifest.digestLedger.recordCount, ledger.recordCount);
  assert.equal(manifest.digestLedger.recordsDigest, ledger.recordsDigest);
  assert.equal(manifest.digestLedger.recordsSha256, ledger.recordsSha256);

  // 干净：通过且 drift 为空三元组。
  const clean = verifyFrozenManifest(manifest, testRecords, { digestLedger: ledger });
  assert.equal(clean.verified, true, clean.reasons.join('；'));
  assert.equal(clean.digestLedgerProvided, true);
  assert.deepEqual(clean.drift, { changed: [], added: [], removed: [] });

  // 篡改：总口径仍会报"整体不一致"，但**必须**同时点名到样本与字段。
  const tampered = clone(records);
  const i = tampered.findIndex((r) => r.sampleId === 'gy-i20-weeds-018');
  assert.ok(i >= 0, '样本 gy-i20-weeds-018 必须存在');
  tampered[i].perceptualHash = '0000000000000000';
  const bad = verifyFrozenManifest(manifest, testRecordsOf(tampered), { digestLedger: ledger });
  assert.equal(bad.verified, false);
  assert.equal(bad.drift.changed.length, 1);
  assert.deepEqual(bad.drift.changed[0].fields, ['perceptualHash']);
  assert.ok(bad.reasons.some((r) => r.includes(`冻结集被改动：${bad.drift.changed[0].sampleId} 字段 perceptualHash`)));
});

test('向后兼容：两参调用（无台账）仍可用，drift=null，原有理由句不变', () => {
  const records = readIndex();
  const manifest = loadJson(MANIFEST_PATH);
  const clean = verifyFrozenManifest(manifest, testRecordsOf(records));
  assert.equal(clean.verified, true, clean.reasons.join('；'));
  assert.equal(clean.drift, null);
  assert.equal(clean.digestLedgerProvided, false);

  // 原有五条理由句一字未改：篡改时首条仍是 indexSha256 的整体结论。
  const tampered = clone(records);
  tampered[0].labelClass = 'species_crabgrass';
  const bad = verifyFrozenManifest(manifest, testRecordsOf(tampered));
  assert.equal(bad.verified, false);
  assert.ok(bad.reasons.some((r) => r.startsWith('冻结清单 indexSha256 与实际 test 集内容不一致')));
});

// ---------------------------------------------------------------- 跨平台稳定性

test('同一内容 CRLF 与 LF 两种字节形态：逐条摘要完全相同（跨平台可复算）', () => {
  const lfText = readFileSync(INDEX_PATH, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'gy-i20-crlf-'));
  try {
    const crlfPath = join(dir, 'index-crlf.json');
    const bomPath = join(dir, 'index-bom.json');
    writeFileSync(crlfPath, lfText.replace(/\r?\n/g, '\r\n'), 'utf8');
    writeFileSync(bomPath, `\uFEFF${lfText}`, 'utf8');

    // 字节确实不同（否则这条测试没有意义）。
    assert.notEqual(readFileSync(INDEX_PATH).length, readFileSync(crlfPath).length);
    assert.notEqual(readFileSync(INDEX_PATH).length, readFileSync(bomPath).length);

    const lf = buildDigestLedger(testRecordsOf(loadJson(INDEX_PATH)));
    const crlf = buildDigestLedger(testRecordsOf(loadJson(crlfPath)));
    const bom = buildDigestLedger(testRecordsOf(loadJson(bomPath)));

    assert.equal(lf.recordsDigest, crlf.recordsDigest);
    assert.equal(lf.recordsDigest, bom.recordsDigest);
    assert.equal(lf.recordsSha256, crlf.recordsSha256);
    assert.deepEqual(lf.records[4].fields, crlf.records[4].fields);
    // 与仓库里已提交的台账也一致（说明台账不是某台机器的换行符产物）。
    assert.equal(lf.recordsDigest, loadJson(DIGESTS_PATH).recordsDigest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- ② 标准答案键

test('冻结清单单向钉住答案键（sha256+版本+条数），答案键不反向依赖清单', () => {
  const labels = loadJson(LABELS_PATH);
  const manifest = loadJson(MANIFEST_PATH);

  assert.ok(manifest.answerKey, '冻结清单必须登记 answerKey');
  assert.equal(manifest.answerKey.sha256, computeAnswerKeySha256(labels));
  assert.equal(manifest.answerKey.version, labels.version);
  assert.equal(manifest.answerKey.recordCount, labels.entries.length);
  assert.equal(manifest.answerKey.recordCount, 172);
  // 单向：labels 文件里不得出现对冻结清单的引用（否则两文件互为因果，改任一都说不清）。
  const labelsText = readFileSync(LABELS_PATH, 'utf8');
  assert.equal(labelsText.includes('frozen-manifest'), false);
  assert.equal(labelsText.includes('digests'), false);

  const clean = verifyAnswerKeyBinding(manifest, labels);
  assert.equal(clean.verified, true, clean.reasons.join('；'));
  assert.equal(clean.pinned, true);
  assert.equal(clean.provided, true);
});

test('改答案键一条 entry ⇒ 冻结校验仍过、答案键校验必红（原洞留证），且点名 ordinal+sampleId', () => {
  const records = readIndex();
  const testRecords = testRecordsOf(records);
  const labels = loadJson(LABELS_PATH);
  const manifest = loadJson(MANIFEST_PATH);
  const ledger = loadJson(DIGESTS_PATH);

  const tamperedLabels = clone(labels);
  tamperedLabels.entries[4].labelClass = 'species_crabgrass';

  // 洞的证据：答案键被改而样本集未被改 ⇒ 冻结校验（只看样本集）仍为 true。
  const frozenStillGreen = verifyFrozenManifest(manifest, testRecords, { digestLedger: ledger });
  assert.equal(frozenStillGreen.verified, true, '冻结校验只看样本集，本测试固定这个事实（正是需要 answerKey 绑定的原因）');

  // 绑定校验必须红。
  const binding = verifyAnswerKeyBinding(manifest, tamperedLabels);
  assert.equal(binding.verified, false);
  assert.ok(binding.reasons.some((r) => r.includes('标准答案键 sha256 与冻结清单不一致')));

  // 逐条交叉核对必须点名（ordinal 与 sampleId 同时给）。
  const cross = verifyAnswerKeyAgainstIndex(testRecords, tamperedLabels);
  assert.equal(cross.verified, false);
  assert.ok(cross.mismatches.length >= 1);
  assert.equal(cross.mismatches[0].ordinal, 5);
  assert.equal(cross.mismatches[0].sampleId, 'gy-i20-weeds-005');
  assert.deepEqual(cross.mismatches[0].fields, ['labelClass']);
  assert.ok(cross.reasons.some((r) => r.includes('第 5 条（gy-i20-weeds-005）')));
});

test('只改答案键里一个非判分字段（notes）也必须被 sha256 发现', () => {
  const labels = loadJson(LABELS_PATH);
  const manifest = loadJson(MANIFEST_PATH);
  const tamperedLabels = clone(labels);
  tamperedLabels.entries[9].notes = '手工改动';
  const binding = verifyAnswerKeyBinding(manifest, tamperedLabels);
  assert.equal(binding.verified, false);
  assert.ok(binding.reasons.some((r) => r.includes('标准答案键 sha256 与冻结清单不一致')));
});

test('清单未钉答案键 / 钉了但没给答案键 ⇒ 一律按未核实计（不得按通过）', () => {
  const labels = loadJson(LABELS_PATH);
  const manifest = loadJson(MANIFEST_PATH);

  const unpinned = clone(manifest);
  delete unpinned.answerKey;
  const a = verifyAnswerKeyBinding(unpinned, labels);
  assert.equal(a.verified, false);
  assert.equal(a.pinned, false);
  assert.ok(a.reasons.some((r) => r.includes('未钉住标准答案键')));

  const b = verifyAnswerKeyBinding(manifest, null);
  assert.equal(b.verified, false);
  assert.equal(b.provided, false);
  assert.ok(b.reasons.some((r) => r.includes('未提供答案键文件')));
});

test('annotatorRef 只有「来源级标识 + 派生规则」两种写法：索引逐条按规则派生', () => {
  const labels = loadJson(LABELS_PATH);
  const records = readIndex();
  const sourceRef = labels.annotation.annotatorRef;
  assert.equal(sourceRef, 'docx_weeds_v1');
  for (const record of records) {
    assert.equal(
      record.annotation.annotatorRef,
      `${sourceRef}_source_label`,
      `${record.sampleId} 的 annotatorRef 必须按「来源级标识 + _source_label」派生，不接受第三种写法`,
    );
    assert.equal(record.annotation.method, 'reliable_label');
    assert.equal(record.annotation.modelGenerated, false);
  }
});

// ---------------------------------------------------------------- 端到端（离线、不花钱）

test('端到端：给台账与答案键跑一次评估 ⇒ 全部 claimable=false、isRealEvaluation=false，但完整性核对通过', () => {
  const records = readIndex();
  const manifest = loadJson(MANIFEST_PATH);
  const coverageManifest = loadJson(COVERAGE_PATH);
  const ledger = loadJson(DIGESTS_PATH);
  const labels = loadJson(LABELS_PATH);

  const report = evaluateRun(records, new Map(), {
    gateDefs: METRIC_GATES,
    frozenManifest: manifest,
    coverageManifest,
    digestLedger: ledger,
    labels,
  });

  assert.equal(report.isRealEvaluation, false, '空预测 + 样本不足：不得主张真实评估');
  assert.equal(report.frozenVerified, true, report.frozenVerification.reasons.join('；'));
  assert.equal(report.frozenVerification.digestLedgerProvided, true);
  assert.deepEqual(report.frozenVerification.drift, { changed: [], added: [], removed: [] });
  assert.equal(report.answerKey.verified, true, report.answerKey.reasons.join('；'));
  assert.equal(report.answerKey.provided, true);
  assert.equal(report.answerKey.pinned, true);
  assert.deepEqual(report.answerKey.mismatches, []);

  // 空预测：观测值必须为 null（不许伪造成绩），门禁一律 not_evaluated。
  for (const [task, t] of Object.entries(report.tasks)) {
    assert.equal(t.gateStatus, 'not_evaluated', `${task} 应为 not_evaluated`);
    for (const g of t.gates) {
      assert.equal(g.claimable, false, `${task}/${g.metric} 不得可主张`);
      assert.equal(g.status, 'not_evaluated');
      assert.ok(g.basis && g.basis.kind && g.basis.ref && g.basis.text, `${task}/${g.metric} 的门禁必须带依据（为什么是这个数）`);
    }
  }
  assert.equal(report.tasks.weed_photo.metrics.top1.p, null, '无预测时不得产出 Top1 读数');

  // 报告结构与 schema 声明的字段同形（仓内无 JSON-Schema 校验器，故按字段断言）。
  assert.equal(report.schemaVersion, '1.0.0', '报告 schemaVersion 保持 1.0.0：本轮只做可选增量');
});

test('端到端负控制：样本被改一个字 ⇒ 报告如实记 false 并点名，不写"通过"', () => {
  const records = readIndex();
  const manifest = loadJson(MANIFEST_PATH);
  const ledger = loadJson(DIGESTS_PATH);
  const labels = loadJson(LABELS_PATH);

  const tampered = clone(records);
  const i = tampered.findIndex((r) => r.sampleId === 'gy-i20-weeds-077');
  assert.ok(i >= 0);
  tampered[i].notes = `${tampered[i].notes ?? ''}改`;

  const report = evaluateRun(tampered, new Map(), {
    gateDefs: METRIC_GATES,
    frozenManifest: manifest,
    digestLedger: ledger,
    labels,
  });
  assert.equal(report.frozenVerified, false);
  assert.equal(report.isRealEvaluation, false);
  assert.deepEqual(report.frozenVerification.drift.changed.map((c) => [c.sampleId, c.fields]), [['gy-i20-weeds-077', ['notes']]]);
  assert.ok(
    report.warnings.some((w) => w.includes('冻结集逐条点名') && w.includes('gy-i20-weeds-077[notes]')),
    `warnings 必须点名到样本与字段，实际：${JSON.stringify(report.warnings)}`,
  );
});
