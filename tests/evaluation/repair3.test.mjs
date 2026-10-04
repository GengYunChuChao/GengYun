// 修复轮 3 回归：GY-I03 范围口径（展示用中文组名 ↔ 规范物种 ID 映射）。
// 监工第三轮 P1：CLI 直接把 coverage-report.json 的 species_groups.required（中文组名）
// 当作物种 ID 范围，导致现有 catalog 八个规范 ID 构造的合法冻结输入被误判"超出 GY-I03 范围"。
//
// 本文件用**真实仓库** packages/knowledge/catalog/species.json + coverage-report.json 驱动：
//   1) 校验中文组名 → 规范 ID 映射（含目录版本/摘要依据）；
//   2) 用真实数据跑真 CLI（tools/evaluation/run-evaluation.mjs）——八个规范 ID 必须通过范围校验；
//   3) 越界类仍必须被拒绝（范围校验未被移除）。
// 注意：输入样本来自 tests/evaluation/validation-fixture.mjs 的**程序验证夹具**（非真实样本），
//   仅用于验证程序的绑定/拒绝逻辑，不产出任何真实评估结论。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateRun, METRIC_GATES } from '../../packages/evaluation/index.mjs';
import { loadKnowledgeScope } from '../../tools/evaluation/knowledge-scope.mjs';
import { runEvaluation } from '../../tools/evaluation/run-evaluation.mjs';
import { buildValidationSet, frozenManifestFor, coverageManifestFor } from './validation-fixture.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 指挥核实、本文件独立复核的八组映射（规范 id ↔ group_name）。
const EXPECTED = [
  ['species_barnyardgrass', '稗草'],
  ['species_foxtail', '狗尾草'],
  ['species_nettle_group', '荨麻类'],
  ['species_crabgrass', '马唐'],
  ['species_goosegrass', '牛筋草'],
  ['species_shortawn_foxtail', '看麦娘'],
  ['species_lambsquarters', '藜'],
  ['species_alligatorweed', '空心莲子草'],
];
const EIGHT_IDS = EXPECTED.map(([id]) => id);
const EIGHT_GROUPS = EXPECTED.map(([, g]) => g);

const toMap = (predictions) => new Map(Object.entries(predictions));

// —— 1. 真实目录驱动：中文组名 → 规范 ID 映射与依据 ——
test('[映射] 真实 catalog/species.json + coverage-report.json：八个中文组名映射为八个规范 ID，并绑定目录版本/摘要', () => {
  const scope = loadKnowledgeScope();
  assert.ok(scope, '应能从真实仓库文件解析 GY-I03 范围');
  assert.deepEqual(scope.sourceGroups, EIGHT_GROUPS, '来源组名应等于 coverage-report 的 species_groups.required');
  assert.deepEqual(scope.classes, EIGHT_IDS, '范围类应为规范物种 ID（不是中文组名）');
  assert.equal(scope.catalogVersion, 'gy-i03-species-2026.10');
  assert.equal(scope.catalogRef, 'packages/knowledge/catalog/species.json');
  assert.equal(scope.basisRef, 'GY-I03#species_groups');
  assert.match(scope.catalogSha256, /^[a-f0-9]{64}$/, '应记录目录文件 SHA-256 作为可追溯依据');
});

test('[映射] 直接核对 catalog/species.json 的 id ↔ group_name（防映射表漂移）', () => {
  const catalog = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'knowledge', 'catalog', 'species.json'), 'utf8'));
  const map = new Map(catalog.species.map((s) => [s.group_name, s.id]));
  for (const [id, group] of EXPECTED) assert.equal(map.get(group), id, `${group} 应映射为 ${id}`);
  assert.equal(map.size, 8, '目录应恰好含八组承诺对象');
});

// —— 2. evaluateRun 层：对象口径记录 scopeBasis，数组口径向后兼容 ——
test('[范围口径] 传入带依据的范围对象：八规范 ID 绑定通过，并记录 scopeBasis', () => {
  const { records, predictions } = buildValidationSet({ classes: EIGHT_IDS });
  const scope = loadKnowledgeScope();
  const report = evaluateRun(records, toMap(predictions), {
    gateDefs: METRIC_GATES,
    frozenManifest: frozenManifestFor(records, { coverage: { weedPhotoCoveredClasses: EIGHT_IDS } }),
    coverageManifest: coverageManifestFor(EIGHT_IDS),
    knowledgeScope: scope,
  });
  assert.equal(report.coverageBinding.verified, true, report.coverageBinding.reasons.join('；'));
  assert.deepEqual(report.coverageBinding.boundClasses, EIGHT_IDS);
  assert.ok(report.coverageBinding.scopeBasis, '应记录范围口径依据');
  assert.equal(report.coverageBinding.scopeBasis.catalogVersion, 'gy-i03-species-2026.10');
  assert.match(report.coverageBinding.scopeBasis.catalogSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.coverageBinding.scopeBasis.sourceGroups, EIGHT_GROUPS);
});

test('[向后兼容] 仍接受字符串数组范围口径（无 scopeBasis）', () => {
  const { records, predictions } = buildValidationSet({ classes: EIGHT_IDS });
  const report = evaluateRun(records, toMap(predictions), {
    gateDefs: METRIC_GATES,
    frozenManifest: frozenManifestFor(records, { coverage: { weedPhotoCoveredClasses: EIGHT_IDS } }),
    coverageManifest: coverageManifestFor(EIGHT_IDS),
    knowledgeScope: EIGHT_IDS,
  });
  assert.equal(report.coverageBinding.verified, true);
  assert.equal(report.coverageBinding.scopeBasis, null);
});

// —— 3. CLI 集成：真实仓库数据驱动 ——
// 说明：本环境禁止派生子进程（node spawn 子进程恒 EBUSY），故直接驱动 CLI 导出的 runEvaluation()，
//   它走的是与命令行完全相同的代码路径（参数解析 → 真实 loadKnowledgeScope → evaluateRun → 报告 JSON），
//   并读取真实仓库 packages/knowledge/catalog/species.json + coverage-report.json。
function runCli(files) {
  let stdout = '';
  let stderr = '';
  const io = {
    stdout: { write: (s) => { stdout += s; return true; } },
    stderr: { write: (s) => { stderr += s; return true; } },
  };
  const { exitCode, report } = runEvaluation([
    '--index', files.index,
    '--predictions', files.predictions,
    '--manifest', files.manifest,
    '--coverage', files.coverage,
    '--json',
  ], io);
  return { exitCode, report, stdout, stderr };
}

function writeInputs(dir, classes) {
  const { records, predictions } = buildValidationSet({ classes });
  const files = {
    index: join(dir, 'index.json'),
    predictions: join(dir, 'predictions.json'),
    manifest: join(dir, 'manifest.json'),
    coverage: join(dir, 'coverage.json'),
  };
  writeFileSync(files.index, JSON.stringify(records));
  writeFileSync(files.predictions, JSON.stringify(predictions));
  writeFileSync(files.manifest, JSON.stringify(frozenManifestFor(records, { coverage: { weedPhotoCoveredClasses: classes } })));
  writeFileSync(files.coverage, JSON.stringify(coverageManifestFor(classes)));
  return files;
}

test('[CLI 集成·真实仓库数据] 八个规范 ID 的冻结输入经 CLI 范围校验通过（旧口径会误拒）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gy-i20-repair3-'));
  try {
    const { exitCode, report, stdout, stderr } = runCli(writeInputs(dir, EIGHT_IDS));
    assert.equal(exitCode, 0);
    assert.ok(stdout.length > 0, 'CLI 应输出报告 JSON');
    assert.match(stderr, /范围口径依据=GY-I03#species_groups/, `stderr 摘要应含范围口径依据，实际=${stderr}`);
    assert.equal(report.coverageBinding.verified, true, `范围校验应通过，实际 reasons=${JSON.stringify(report.coverageBinding.reasons)}`);
    assert.deepEqual(report.coverageBinding.boundClasses, EIGHT_IDS);
    assert.equal(report.coverageBinding.reasons.some((r) => r.includes('GY-I03')), false, '不得再出现"超出 GY-I03 范围"');
    assert.equal(report.coverageManifestPresent, true, '冻结覆盖清单应被识别');
    const sb = report.coverageBinding.scopeBasis;
    assert.ok(sb, 'CLI 报告应含范围口径依据');
    assert.equal(sb.catalogVersion, 'gy-i03-species-2026.10');
    assert.match(sb.catalogSha256, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('[CLI 集成·负例] 越界物种 ID 仍被 CLI 拒绝（范围校验未被移除）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gy-i20-repair3-'));
  try {
    const outOfScope = [...EIGHT_IDS, 'species_unknown_weed'];
    const { report } = runCli(writeInputs(dir, outOfScope));
    assert.equal(report.coverageBinding.verified, false);
    assert.ok(report.coverageBinding.reasons.some((r) => r.includes('GY-I03')), '应报"超出 GY-I03 已承诺范围"');
    assert.ok(report.coverageBinding.reasons.some((r) => r.includes('species_unknown_weed')));
    assert.equal(report.isRealEvaluation, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('[回归守卫] 若把 coverage-report 的原始中文组名直接当范围（旧 CLI 口径），合法规范 ID 必被误拒', () => {
  const coverageReport = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'knowledge', 'coverage-report.json'), 'utf8'));
  const rawGroups = coverageReport.species_groups.required;
  assert.deepEqual(rawGroups, EIGHT_GROUPS, '原始清单为中文组名');
  const { records, predictions } = buildValidationSet({ classes: EIGHT_IDS });
  const report = evaluateRun(records, toMap(predictions), {
    gateDefs: METRIC_GATES,
    frozenManifest: frozenManifestFor(records, { coverage: { weedPhotoCoveredClasses: EIGHT_IDS } }),
    coverageManifest: coverageManifestFor(EIGHT_IDS),
    knowledgeScope: rawGroups, // 复刻旧口径
  });
  assert.equal(report.coverageBinding.verified, false);
  assert.ok(report.coverageBinding.reasons.some((r) => r.includes('超出 GY-I03')));
});

