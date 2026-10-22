// GY-I08 · 登记／匹配／限制场景用例集（issue #8 验收第 1 条与第 4 条）。
//
// 要求（docs/initial-issues.md · GY-I08；docs/implementation-requirements.md §6.1「登记匹配与冲突」）：
//   「至少100组登记／匹配／限制场景全部通过，含冲突、失效、未知和模拟」；
//   「无来源、模拟、失效、多匹配和关键字段冲突均阻断，所有消费端使用同一规则版本」。
//
// 组织方式（**可复核**）：
//   - 用例数据在 `tests/reference/_i08-scenarios.mjs`（含每条用例的来源标注
//     `provenance = { kind, source, fixtures, note }`，来源标注本身由
//     `tests/reference/i08-scenarios-provenance.test.mjs` 逐条回查）；
//   - 本文件只剩**运行器与断言**：逐例断言期望的阻断类别必须出现、期望的放行必须放行、
//     **被阻断的用例一律不得产出可执行建议与用量卡**、**每条用例必须带来源标注**；
//   - 计数断言：总数 ≥ 100、失败数 = 0、每个阻断类别至少被覆盖一次；
//   - 运行结束打印原始计数（总数／分组／逐类阻断／放行／用量卡），供回传粘贴。
//
// 本文件**不含**任何依赖真实用量正例的断言：首批真实资料没有用量列，
// 凡需要真实用量正例的场景一律标为**缺项/未取得**（见文末 `test('缺项登记')`）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLICABILITY_RULE_VERSION,
  BLOCK_CODES,
  BLOCK_CODE_LIST,
  DISPLAY_LABELS,
  FORBIDDEN_LABELS,
  MATCH_STATES,
  evaluateDoseBoundary,
  evaluateExecutableAdvice,
  evaluateRegistrationMatch,
  loadHerbicideRecords,
} from '../../packages/reference/index.mjs';
import { miniReference } from './_fixtures.mjs';
import {
  FIXTURE_BUILDERS,
  MATCH_CASES,
  PROVENANCE_KINDS,
  REGISTRY_CLAIM_WORDS,
  SCENARIOS,
  candidateItem,
  conflictPair,
} from './_i08-scenarios.mjs';

/**
 * 来源标注的**运行时**校验（派单：每条必须标 `synthetic|registry` 与来源；
 * 合成数据不许写成「真实登记核对通过」）。
 *
 * 与 `i08-scenarios-provenance.test.mjs` 的静态回查互补：那边核对「标注引用的来源
 * 在仓里真实存在」，这里保证运行器**消费到的每条用例确实带标注** —— 删掉任意一条标注，
 * 该用例当场转红，而不是只剩一句文件头自述。
 */
function provenanceProblems(row) {
  const problems = [];
  const provenance = row?.provenance;
  if (!provenance || typeof provenance !== 'object') return [`${row?.id} 缺少来源标注 provenance`];
  if (!PROVENANCE_KINDS.includes(provenance.kind)) problems.push(`${row.id} 来源标注 kind 非法：${String(provenance.kind)}`);
  if (typeof provenance.source !== 'string' || provenance.source.trim() === '') {
    problems.push(`${row.id} 来源标注缺少 source`);
  }
  const fixtures = Array.isArray(provenance.fixtures) ? provenance.fixtures : [];
  if (fixtures.length === 0) problems.push(`${row.id} 来源标注缺少 fixtures`);
  for (const fixture of fixtures) {
    if (!FIXTURE_BUILDERS.includes(fixture)) problems.push(`${row.id} 引用了未登记的夹具：${String(fixture)}`);
  }
  if (provenance.kind === 'synthetic') {
    if (!String(provenance.source).startsWith('fixture:')) {
      problems.push(`${row.id} 合成用例的 source 必须以 fixture: 开头`);
    }
    if (!String(provenance.note ?? '').includes('非真实登记核对')) {
      problems.push(`${row.id} 合成用例的 note 必须注明「非真实登记核对」`);
    }
  }
  for (const word of REGISTRY_CLAIM_WORDS) {
    if (`${row.name ?? ''} ${provenance.note ?? ''}`.includes(word)) {
      problems.push(`${row.id} 合成用例自称「${word}」（不得把合成数据写成核对通过）`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 运行器与计数
// ---------------------------------------------------------------------------

const GROUP_ORDER = ['登记', '匹配', '限制'];

function runScenario(scenario) {
  const ctx = scenario.ctx ?? {};
  const opts = scenario.opts ?? {};
  const advice = evaluateExecutableAdvice(scenario.item, ctx, opts);
  const boundary = evaluateDoseBoundary(scenario.item, ctx, opts);
  return { advice, boundary };
}

function checkScenario(scenario) {
  const expect = scenario.expect;
  const ctx = scenario.ctx ?? {};
  const opts = scenario.opts ?? {};
  const { advice, boundary } = runScenario(scenario);
  const problems = provenanceProblems(scenario);

  if (advice.executable !== expect.exec) problems.push(`executable 期望 ${expect.exec} 实际 ${advice.executable}`);
  if (boundary.renderable !== expect.dose) problems.push(`用量卡 renderable 期望 ${expect.dose} 实际 ${boundary.renderable}`);
  if (boundary.dose_count !== (expect.dose ? 1 : 0)) problems.push(`dose_count 期望 ${expect.dose ? 1 : 0} 实际 ${boundary.dose_count}`);
  for (const code of expect.codes ?? []) {
    if (!boundary.block_codes.includes(code)) problems.push(`缺少阻断类别 ${code}（实际 ${boundary.block_codes.join('/') || '无'}）`);
  }
  if (expect.codes && expect.codes.length === 0) {
    if (boundary.block_codes.length !== 0) problems.push(`期望无阻断类别，实际 ${boundary.block_codes.join('/')}`);
  }
  if (expect.reasonHas) {
    const hit = [...advice.reasons, ...boundary.reasons].some((r) => String(r).includes(expect.reasonHas));
    if (!hit) problems.push(`原因中缺少片段「${expect.reasonHas}」`);
  }

  // 硬约束：凡未产出可执行建议的用例，一律不得产出用量卡，也不得放行任何用量。
  if (advice.executable === false && (boundary.renderable || boundary.dose_count !== 0)) {
    problems.push('被阻断却仍产出用量卡（关闭/资格不足必须同时关闭用量卡）');
  }
  // 规则版本：每条用例都必须回传同一规则版本。
  if (advice.rule_version !== APPLICABILITY_RULE_VERSION || boundary.rule_version !== APPLICABILITY_RULE_VERSION) {
    problems.push(`规则版本不一致：${advice.rule_version}/${boundary.rule_version}`);
  }
  // 阻断类别必须落在闭集内。
  for (const code of boundary.block_codes) {
    if (!BLOCK_CODE_LIST.includes(code)) problems.push(`阻断类别 ${code} 不在闭集内`);
  }
  // 文案：任何原因都不得含禁用标签（无绝对安全/零药害承诺）。
  for (const reason of [...advice.reasons, ...boundary.reasons]) {
    for (const forbidden of FORBIDDEN_LABELS) {
      if (String(reason).includes(forbidden)) problems.push(`原因文案含禁用词「${forbidden}」`);
    }
  }

  // 跨端一致（所有消费端同一规则版本、同一判定）：小程序镜像必须同判。
  const miniAdvice = miniReference.evaluateExecutableAdvice(scenario.item, ctx, opts);
  const miniBoundary = miniReference.evaluateDoseBoundary(scenario.item, ctx, opts);
  if (miniAdvice.executable !== advice.executable) problems.push(`跨端 executable 不一致（镜像 ${miniAdvice.executable}）`);
  if (miniAdvice.rule_version !== APPLICABILITY_RULE_VERSION) problems.push(`镜像规则版本不一致：${miniAdvice.rule_version}`);
  if (miniBoundary.renderable !== boundary.renderable) problems.push(`跨端 renderable 不一致（镜像 ${miniBoundary.renderable}）`);
  if ([...miniBoundary.block_codes].sort().join(',') !== [...boundary.block_codes].sort().join(',')) {
    problems.push(`跨端阻断类别不一致（镜像 ${miniBoundary.block_codes.join('/')}）`);
  }

  return { id: scenario.id, group: scenario.group, problems, advice, boundary };
}

function checkMatchCase(testCase) {
  const verdict = evaluateRegistrationMatch(testCase.candidates, testCase.query, testCase.opts ?? {});
  const problems = provenanceProblems(testCase);
  if (!MATCH_STATES.includes(verdict.state)) problems.push(`状态 ${verdict.state} 不在契约 MatchState 闭集`);
  if (verdict.state !== testCase.state) problems.push(`state 期望 ${testCase.state} 实际 ${verdict.state}`);
  for (const code of testCase.codes) {
    if (!verdict.block_codes.includes(code)) problems.push(`缺少阻断类别 ${code}（实际 ${verdict.block_codes.join('/') || '无'}）`);
  }
  if (testCase.state === 'matched' && verdict.matched === null) problems.push('state=matched 但未返回命中记录');
  if (testCase.state !== 'matched' && verdict.matched !== null) problems.push('state 非 matched 却返回了命中记录（不得放行）');
  if (verdict.rule_version !== APPLICABILITY_RULE_VERSION) problems.push(`规则版本不一致：${verdict.rule_version}`);
  for (const reason of verdict.reasons) {
    if (reason.trim() === '') problems.push('阻断必须给出可读原因（AC02）');
    for (const forbidden of FORBIDDEN_LABELS) {
      if (String(reason).includes(forbidden)) problems.push(`原因文案含禁用词「${forbidden}」`);
    }
  }
  if (testCase.state !== 'matched' && verdict.reasons.length === 0) problems.push('阻断必须给出可读原因（AC02）');
  return { id: testCase.id, group: '登记', problems, verdict };
}

/** 汇总并打印（原始输出供回传粘贴）。 */
function summarize() {
  const results = SCENARIOS.map(checkScenario).concat(MATCH_CASES.map(checkMatchCase));
  const failures = results.filter((r) => r.problems.length > 0);

  const byGroup = {};
  for (const group of GROUP_ORDER) byGroup[group] = 0;
  for (const r of results) byGroup[r.group] = (byGroup[r.group] ?? 0) + 1;

  const byCode = {};
  for (const code of BLOCK_CODE_LIST) byCode[code] = 0;
  for (const r of results) {
    const codes = r.advice ? r.boundary.block_codes : r.verdict.block_codes;
    for (const code of codes) byCode[code] = (byCode[code] ?? 0) + 1;
  }

  const opened = results.filter((r) => (r.advice ? r.advice.executable : r.verdict.state === 'matched')).length;
  const rendered = results.filter((r) => r.boundary && r.boundary.renderable === true).length;

  const lines = [];
  lines.push(`[GY-I08] 用例总数=${results.length} 通过=${results.length - failures.length} 失败=${failures.length}`);
  lines.push(`[GY-I08] 分组计数: ${GROUP_ORDER.map((g) => `${g}=${byGroup[g]}`).join(' ')}`);
  lines.push(`[GY-I08] 放行(可执行建议或 matched)计数=${opened}`);
  lines.push(`[GY-I08] 用量卡可渲染计数=${rendered}（真实资料无用量列，正例仅用合成夹具）`);
  lines.push('[GY-I08] 被阻断类别逐类计数:');
  for (const code of BLOCK_CODE_LIST) lines.push(`  ${code}=${byCode[code]}`);
  if (failures.length > 0) {
    lines.push('[GY-I08] 失败明细:');
    for (const f of failures) lines.push(`  ${f.id}: ${f.problems.join(' | ')}`);
  }
  return { results, failures, byGroup, byCode, opened, rendered, report: lines.join('\n') };
}

const SUMMARY = summarize();

test('GY-I08 用例集：登记／匹配／限制 ≥100 组，全部通过', () => {
  console.log(SUMMARY.report);
  assert.ok(SUMMARY.results.length >= 100, `用例总数应≥100，实际 ${SUMMARY.results.length}`);
  assert.deepEqual(SUMMARY.failures.map((f) => f.id), [], '所有用例必须通过（失败为 0）');
});

test('GY-I08 用例集：三类分组各自不少于 25 组', () => {
  for (const group of GROUP_ORDER) {
    assert.ok(SUMMARY.byGroup[group] >= 25, `${group} 组用例应≥25，实际 ${SUMMARY.byGroup[group]}`);
  }
});

test('GY-I08 用例集：每个阻断类别至少被覆盖一次（闭集无死角）', () => {
  const uncovered = BLOCK_CODE_LIST.filter((code) => SUMMARY.byCode[code] === 0);
  assert.deepEqual(uncovered, [], `以下阻断类别未覆盖：${uncovered.join('/')}`);
});

test('GY-I08 用例集：被阻断用例逐类计数均为正（阻断面确实在生效）', () => {
  const blocked = SUMMARY.results.filter((r) => (r.advice ? r.advice.executable === false : r.verdict.state !== 'matched'));
  assert.ok(blocked.length >= 60, `被阻断用例应≥60，实际 ${blocked.length}`);
  for (const r of blocked) {
    const codes = r.advice ? r.boundary.block_codes : r.verdict.block_codes;
    assert.ok(codes.length > 0, `${r.id} 被阻断但未给出阻断类别`);
  }
});

test('GY-I08：风险文字不得出现绝对安全／零药害承诺（全量标签与原因扫描）', () => {
  const texts = [];
  for (const value of Object.values(DISPLAY_LABELS)) {
    if (typeof value === 'string') texts.push(value);
    else if (value && typeof value === 'object') texts.push(...Object.values(value));
  }
  for (const r of SUMMARY.results) {
    if (r.advice) texts.push(...r.advice.reasons, ...r.boundary.reasons);
    else texts.push(...r.verdict.reasons);
  }
  for (const text of texts) {
    for (const forbidden of FORBIDDEN_LABELS) {
      assert.ok(!String(text).includes(forbidden), `文案「${text}」含禁用词「${forbidden}」`);
    }
  }
});

test('GY-I08 缺项登记：真实资料无用量列 ⇒ 用量正例为缺项/未取得，不补造', () => {
  const doc = loadHerbicideRecords();
  assert.ok(doc.items.length >= 20, `应有≥20 条真实记录，实际 ${doc.items.length}`);
  // 登记值：与证据页 / 缺口台账登记的「真实用量正例数」一致（当前 0）。把它改成非 0 而数据里
  // 没有正例 ⇒ 下面的断言立即转红（正确修法是补真实数据后同步登记值，不是改数据凑绿）。
  const DOSE_POSITIVE_COUNT_REGISTERED = 0;
  let renderable = 0;
  let dosePositive = 0;
  for (const record of doc.items) {
    // 缺项：真实资料没有用量列 ⇒ dose_text=null、usable_as_dose=false、card_ready=false。
    assert.equal(record.verification?.usable_as_dose, false, `${record.registration_number} 不得标为可用于用量`);
    assert.equal(record.verification?.dose_text ?? null, null, `${record.registration_number} 的 dose_text 必须保持 null`);
    assert.equal(record.verification?.card_ready ?? false, false, `${record.registration_number} 的 card_ready 必须为 false`);
    if (
      record.verification?.usable_as_dose === true &&
      typeof record.verification?.dose_text === 'string' &&
      record.verification.dose_text.trim() !== ''
    ) {
      dosePositive += 1;
    }
    const boundary = evaluateDoseBoundary(record, {});
    if (boundary.renderable) renderable += 1;
    assert.equal(boundary.dose_count, 0, `${record.registration_number} 不得产出用量卡`);
  }
  const output = `[GY-I08] 真实资料 DosCard 渲染计数=${renderable}（期望 0；真实用量正例 ${DOSE_POSITIVE_COUNT_REGISTERED}：缺项/未取得，不补造）`;
  console.log(output);
  assert.ok(
    output.includes(`真实用量正例 ${DOSE_POSITIVE_COUNT_REGISTERED}`),
    `对外文案必须写明登记的真实用量正例数，实际：${output}`,
  );
  if (DOSE_POSITIVE_COUNT_REGISTERED === 0) {
    assert.ok(output.includes('正例 0'), `N=0 时对外文案必须写明「正例 0」，实际：${output}`);
  }
  assert.equal(
    dosePositive,
    DOSE_POSITIVE_COUNT_REGISTERED,
    `实测真实用量正例=${dosePositive}，与登记值 ${DOSE_POSITIVE_COUNT_REGISTERED} 不符：数据变了必须同步登记值（不得改数据凑绿）`,
  );
  assert.equal(renderable, 0, '真实资料无用量列，DoseCard 计数必须保持 0');
});

// ---------------------------------------------------------------------------
// P1 返修（2026-10-14 监工 CHANGES_REQUESTED）：**同登记号资料冲突不得被输入收窄消除**
//
// 监工探针（运行 SHA `8957f58`）：两候选同登记号 `PD20210001`、成分含量 40% / 50% 矛盾、
// 均 published/valid/verified；**只查登记号**返回 `conflict`/`field_conflict`，
// **增加 `ingredients_text=40%`（选其中一侧）后返回 `matched`、`block_codes=[]`、选中 A**。
// 这违反 #8「来源和确定性规则先检查，模型或用户选中候选不能绕过」与「关键字段冲突均阻断」。
//
// 本用例把该场景**逐条**钉死（数据表中另有 MRG-031…MRG-040 同形覆盖）。
// ---------------------------------------------------------------------------
test('GY-I08 P1 返修：同登记号资料冲突不得被输入收窄消除（监工 2026-10-14 探针）', () => {
  const pair = conflictPair();
  const onlyRegistration = evaluateRegistrationMatch(pair, { registration_number: 'PD20210001' });
  const pickSide = evaluateRegistrationMatch(pair, { registration_number: 'PD20210001', ingredients_text: '40%' });

  // 1) 只查登记号：冲突阻断（修复前即如此，作为对照基线）。
  assert.equal(onlyRegistration.state, 'conflict', '只查登记号应判 conflict');
  assert.ok(onlyRegistration.block_codes.includes(BLOCK_CODES.FIELD_CONFLICT), 'block_codes 应含 field_conflict');
  assert.equal(onlyRegistration.matched, null, '冲突时不得返回命中记录');

  // 2) **监工探针**：加 ingredients_text=40%（选其中一侧）后，冲突**不得**被消掉。
  assert.notEqual(pickSide.state, 'matched', '收窄条件不得把同登记号资料冲突变成 matched');
  assert.equal(pickSide.state, 'conflict', '收窄后仍必须是 conflict');
  assert.ok(pickSide.block_codes.includes(BLOCK_CODES.FIELD_CONFLICT), '收窄后 block_codes 必须含 field_conflict');
  assert.equal(pickSide.matched, null, '不得返回被选中的候选 A');
  assert.deepEqual([...pickSide.block_codes], [BLOCK_CODES.FIELD_CONFLICT]);

  // 3) 换用另一类矛盾字段（剂型）单边收窄 ⇒ 同样否决：证明不是只对 ingredients_text 打补丁。
  const byForm = evaluateRegistrationMatch(conflictPair({ bDosageForm: '悬乳剂' }), {
    registration_number: 'PD20210001',
    dosage_form: '水分散粒剂',
  });
  assert.equal(byForm.state, 'conflict', '剂型单边收窄后仍必须是 conflict');
  assert.ok(byForm.block_codes.includes(BLOCK_CODES.FIELD_CONFLICT));
  assert.equal(byForm.matched, null);

  // 4) 语义边界：**显式查询另一个登记号**是合法收窄（登记号是制剂身份），冲突组在范围外 ⇒ 不误伤。
  const other = evaluateRegistrationMatch(
    pair.concat([candidateItem({ record_id: 'c', registration_number: 'PD20210002' })]),
    { registration_number: 'PD20210002' },
  );
  assert.equal(other.state, 'matched', '查询另一个无冲突登记号不应被冲突组牵连');
  assert.equal(other.matched.registration_number, 'PD20210002');

  console.log(
    `[GY-I08 P1] 只查登记号 → ${onlyRegistration.state}/${onlyRegistration.block_codes.join(',')}；` +
      `加 ingredients_text=40% → ${pickSide.state}/${pickSide.block_codes.join(',')}、matched=${pickSide.matched === null ? 'null' : 'A'}（修复前为 matched 且返回 A）；` +
      `剂型单边收窄 → ${byForm.state}/${byForm.block_codes.join(',')}；查另一个登记号 → ${other.state}`,
  );
});