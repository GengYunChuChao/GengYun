// GY-I08 · 场景集**来源标注**核对（issue #8 验收第 1 条：至少 100 组，含冲突/失效/未知/模拟）。
//
// 为什么单独一个文件（R29 S2）：
//   派单要求「每条必须标 `synthetic|registry` 与来源；合成数据不许写成『真实登记核对通过』」。
//   如果标注只是文件头一句自述，它随时会漂移成空话。所以这里把标注**逐条回查**：
//     1) 合成用例：`kind` 必须落在闭集、`source` 引用的夹具构造器必须真实存在于
//        `tests/reference/_i08-scenarios.mjs`（改个不存在的名字 ⇒ 本文件转红）；
//        `note` 必须写明「非真实登记核对」，且不得出现 `REGISTRY_CLAIM_WORDS`；
//     2) 登记用例：直接用仓内**真实**数据（`records-2026.json` 20 条 +
//        `materials-zhejiang-v1.json` 159 条）建标注，`source.path` 必须真实存在、
//        `source.locator` 必须能在该文件原文里查到；并且这些真实条目**全部**
//        `review_status=unverified`、`dose_count=0`、`executable=false` —— 即
//        「标注成 registry」不等于「核对通过」，不得被拿去当核对结论；
//     3) 四类必覆盖（冲突/失效/未知/模拟）各自断言到**具体阻断类别**，每类 ≥3 组。
//
// 本文件不产生任何用量建议，也不修改任何数据：只读 + 断言。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateDoseBoundary,
  evaluateExecutableAdvice,
  loadHerbicideRecords,
  loadZhejiangKnowledge,
} from '../../packages/reference/index.mjs';
import {
  FIXTURE_BUILDERS,
  MANDATED_CLASSES,
  MATCH_CASES,
  PROVENANCE_KINDS,
  REGISTRY_CLAIM_WORDS,
  SCENARIOS,
  expectedCodes,
} from './_i08-scenarios.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA_MODULE = 'tests/reference/_i08-scenarios.mjs';
const ANN_RECORDS = 'packages/knowledge/herbicides/records-2026.json';
const ZJ_MATERIALS = 'packages/knowledge/zhejiang/materials-zhejiang-v1.json';

const ALL_CASES = [...SCENARIOS, ...MATCH_CASES];

function readRepoFile(relative) {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

/** 夹具构造器是否真实存在于数据模块（`function X(` 或 `const X =`）。 */
function isDeclaredInDataModule(name, sourceText) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(function\\s+${escaped}\\s*\\(|const\\s+${escaped}\\s*=)`).test(sourceText);
}

// ---------------------------------------------------------------------------
// 1) 合成用例的来源标注：闭集 + 可回查 + 不得自称核对通过
// ---------------------------------------------------------------------------

test('GY-I08 来源标注：每条用例都带 provenance，kind 落在闭集内，source 可回查', () => {
  assert.ok(ALL_CASES.length >= 100, `场景总数必须 ≥100，实际 ${ALL_CASES.length}`);
  const dataSource = readRepoFile(DATA_MODULE);
  const problems = [];

  for (const row of ALL_CASES) {
    const provenance = row.provenance;
    const id = String(row.id);
    if (!provenance || typeof provenance !== 'object') {
      problems.push(`${id} 缺少 provenance`);
      continue;
    }
    if (!PROVENANCE_KINDS.includes(provenance.kind)) problems.push(`${id} kind 非法：${String(provenance.kind)}`);
    if (typeof provenance.source !== 'string' || provenance.source === '') problems.push(`${id} 缺少 source`);
    const fixtures = Array.isArray(provenance.fixtures) ? provenance.fixtures : [];
    if (fixtures.length === 0) problems.push(`${id} 缺少 fixtures`);
    for (const fixture of fixtures) {
      if (!FIXTURE_BUILDERS.includes(fixture)) problems.push(`${id} 引用了未登记夹具 ${fixture}`);
      if (!isDeclaredInDataModule(fixture, dataSource)) problems.push(`${id} 引用的夹具 ${fixture} 在数据模块里不存在`);
    }
    if (provenance.kind === 'synthetic') {
      if (!provenance.source.startsWith('fixture:')) problems.push(`${id} 合成用例 source 必须以 fixture: 开头`);
      if (!String(provenance.note ?? '').includes('非真实登记核对')) {
        problems.push(`${id} 合成用例 note 未注明「非真实登记核对」`);
      }
      for (const fixture of fixtures) {
        if (!provenance.source.includes(fixture)) problems.push(`${id} 的 source 未列出夹具 ${fixture}`);
      }
    }
  }

  assert.deepEqual(problems, [], `来源标注问题：\n${problems.join('\n')}`);

  const synthetic = ALL_CASES.filter((row) => row.provenance.kind === 'synthetic').length;
  const registry = ALL_CASES.filter((row) => row.provenance.kind === 'registry').length;
  console.log(`[GY-I08 来源标注] 用例总数=${ALL_CASES.length}（synthetic=${synthetic}、registry=${registry}）；夹具清单=${FIXTURE_BUILDERS.join(',')}`);
});

test('GY-I08 来源标注：合成用例不得自称「真实登记核对通过」等核对结论', () => {
  const offenders = [];
  for (const row of ALL_CASES) {
    if (row.provenance?.kind !== 'synthetic') continue;
    const selfDescription = `${row.name ?? ''} ${row.provenance.note ?? ''}`;
    for (const word of REGISTRY_CLAIM_WORDS) {
      if (selfDescription.includes(word)) offenders.push(`${row.id} 含「${word}」`);
    }
  }
  assert.deepEqual(offenders, [], `合成用例不得写成核对通过：\n${offenders.join('\n')}`);
  console.log(`[GY-I08 来源标注] 自述禁忌词清单 ${REGISTRY_CLAIM_WORDS.length} 条，合成用例命中 0 条`);
});

// ---------------------------------------------------------------------------
// 2) 真实登记数据：标注为 registry，但**不**等于核对通过
// ---------------------------------------------------------------------------

function registryCases() {
  const cases = [];
  const annRaw = readRepoFile(ANN_RECORDS);
  for (const item of loadHerbicideRecords().items) {
    cases.push({
      id: `REG-ANN-${item.registration_number}`,
      kind: 'registry',
      source: { path: ANN_RECORDS, locator: item.registration_number },
      reviewStatus: item.verification?.review_status ?? null,
      item,
      rawText: annRaw,
    });
  }
  const zjRaw = readRepoFile(ZJ_MATERIALS);
  for (const item of loadZhejiangKnowledge().items) {
    cases.push({
      id: `REG-ZJ-${item.item_id}`,
      kind: 'registry',
      source: { path: ZJ_MATERIALS, locator: item.item_id },
      reviewStatus: item.review_status ?? item.verification?.review_status ?? null,
      item,
      rawText: zjRaw,
    });
  }
  return cases;
}

test('GY-I08 来源标注：真实数据用例标 registry，source 可回查且仍为未核对/不可执行/无用量', () => {
  const cases = registryCases();
  assert.ok(cases.length >= 100, `真实数据用例必须 ≥100 条（凑够「登记」维度），实际 ${cases.length}`);

  const problems = [];
  let doseCards = 0;
  let executable = 0;
  for (const testCase of cases) {
    // 来源可回查：文件真实存在 + locator 能在原文里查到（不是编的 id）
    if (!areLocatorResolvable(testCase)) problems.push(`${testCase.id} 的 source 无法回查（${testCase.source.path}#${testCase.source.locator}）`);
    if (testCase.kind !== 'registry') problems.push(`${testCase.id} kind 应为 registry`);
    // 真实资料仍是**未核对**：标注成 registry 不等于核对通过
    if (testCase.reviewStatus !== 'unverified') problems.push(`${testCase.id} review_status 应为 unverified，实际 ${String(testCase.reviewStatus)}`);

    const boundary = evaluateDoseBoundary(testCase.item, {});
    const advice = evaluateExecutableAdvice(testCase.item, {});
    if (boundary.dose_count !== 0) {
      doseCards += 1;
      problems.push(`${testCase.id} 未核对真实资料产出了用量卡（dose_count=${boundary.dose_count}）`);
    }
    if (boundary.renderable !== false) problems.push(`${testCase.id} renderable 应为 false`);
    if (advice.executable !== false) {
      executable += 1;
      problems.push(`${testCase.id} 未核对真实资料被放行成可执行建议`);
    }
    if (!Array.isArray(boundary.block_codes) || boundary.block_codes.length === 0) {
      problems.push(`${testCase.id} 阻断必须给出具体 block_codes（不得静默放过）`);
    }
  }

  assert.deepEqual(problems, [], `真实数据用例问题：\n${problems.join('\n')}`);
  console.log(`[GY-I08 来源标注] registry 用例=${cases.length}（公告记录 ${loadHerbicideRecords().items.length} + 浙江资料 ${loadZhejiangKnowledge().items.length}）；用量卡=${doseCards}（期望 0）、可执行建议=${executable}（期望 0）、review_status 全 unverified`);
});

function areLocatorResolvable(testCase) {
  const { path: relative, locator } = testCase.source;
  if (typeof relative !== 'string' || typeof locator !== 'string' || locator === '') return false;
  return testCase.rawText.includes(`"${locator}"`);
}

// ---------------------------------------------------------------------------
// 3) 四类必覆盖：冲突 / 失效 / 未知 / 模拟 —— 每类断言到具体阻断类别
// ---------------------------------------------------------------------------

test('GY-I08 来源标注：冲突/失效/未知/模拟四类各 ≥3 组，且断言到具体阻断类别', () => {
  const problems = [];
  const report = [];
  for (const mandated of MANDATED_CLASSES) {
    const rows = ALL_CASES.filter((row) => expectedCodes(row).includes(mandated.code));
    report.push(`${mandated.klass}=${rows.length}(${mandated.code})`);
    if (rows.length < mandated.min) problems.push(`${mandated.klass} 类覆盖不足：${rows.length} < ${mandated.min}`);
    for (const row of rows) {
      if (!PROVENANCE_KINDS.includes(row.provenance?.kind)) problems.push(`${row.id} 属于${mandated.klass}类但来源标注非法`);
    }
  }
  assert.deepEqual(problems, [], `四类覆盖问题：\n${problems.join('\n')}`);
  assert.ok(report.length === 4, '四类必须齐全');
  console.log(`[GY-I08 来源标注] 四类覆盖：${report.join('、')}`);
});
