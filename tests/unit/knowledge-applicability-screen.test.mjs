// GY-I08 · 服务端装配层单测（issue #8 验收第 2 条：未核对／不适用／禁用不得进入可执行建议）。
//
// 被测：`services/api/src/knowledge/applicability-screen.ts`（装配层，不重写判定）。
// 断言四件事：
//   1. 错误映射**逐码覆盖**域库闭集，且每个目标码的 HTTP 状态都是 **4xx**（不含 5xx）；
//   2. 未登记的（未来新增的）阻断类别必须 **fail-closed**，不得因为「不认识」而放行；
//   3. 159 条场景用例在装配层**同判**：域库说不可执行，装配层就必须 blocked + 有 4xx 码；
//   4. 真实资料（20 条公告 + 159 条浙江资料）在装配层**零放行**、零用量卡。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCK_CODES,
  BLOCK_CODE_LIST,
  FORBIDDEN_LABELS,
  MATCH_STATES,
  evaluateDoseBoundary,
  loadHerbicideRecords,
  loadZhejiangKnowledge,
} from '../../packages/reference/index.mjs';
import { scanRiskWording } from '../../packages/reference/risk-wording.mjs';
import { ERROR_CODES } from '../../services/api/src/contract.ts';
import { ApiError } from '../../services/api/src/errors.ts';
import {
  BLOCK_ERROR_MAP,
  MATCH_ERROR_MAP,
  SCREEN_STATUS,
  assertScreenMappingsComplete,
  errorForBlockCodes,
  requireDoseCard,
  requireExecutableAdvice,
  screenApplicability,
  screenRegistrationMatch,
} from '../../services/api/src/knowledge/applicability-screen.ts';
import { MATCH_CASES, SCENARIOS, doseItem, item } from '../reference/_i08-scenarios.mjs';

/** 用真实 `ApiError` 求状态码：保证断言的是**出封套时**的状态，而不是我自己写的常量。 */
function statusOf(code) {
  return new ApiError(code, 'probe').status;
}

function isClientError(status) {
  return Number.isInteger(status) && status >= 400 && status < 500;
}

test('GY-I08 装配：阻断／匹配映射逐码覆盖闭集，目标码全部落在 4xx', () => {
  const { block_codes: blockCodes, match_states: matchStates } = assertScreenMappingsComplete();
  assert.equal(blockCodes.length, Object.keys(BLOCK_CODES).length);
  assert.equal(matchStates.length, MATCH_STATES.length);

  const problems = [];
  for (const code of blockCodes) {
    const mapped = BLOCK_ERROR_MAP[code];
    if (!mapped) {
      problems.push(`阻断类别 ${code} 没有映射`);
      continue;
    }
    if (!ERROR_CODES.includes(mapped)) problems.push(`${code} 映射到未登记的错误码 ${mapped}`);
    const status = statusOf(mapped);
    if (!isClientError(status)) problems.push(`${code} → ${mapped} 的状态是 ${status}（必须是 4xx）`);
  }
  for (const state of matchStates) {
    const mapped = MATCH_ERROR_MAP[state];
    if (mapped === null) {
      if (state !== 'matched') problems.push(`只有 matched 允许映射为 null，实际 ${state}`);
      continue;
    }
    if (!mapped) {
      problems.push(`匹配状态 ${state} 没有映射`);
      continue;
    }
    if (!ERROR_CODES.includes(mapped)) problems.push(`${state} 映射到未登记的错误码 ${mapped}`);
    const status = statusOf(mapped);
    if (!isClientError(status)) problems.push(`${state} → ${mapped} 的状态是 ${status}（必须是 4xx）`);
  }
  assert.deepEqual(problems, [], `映射表问题：\n${problems.join('\n')}`);
  const table = blockCodes.map((code) => `${code}→${BLOCK_ERROR_MAP[code]}(${statusOf(BLOCK_ERROR_MAP[code])})`);
  console.log(`[GY-I08 装配] 阻断映射 ${blockCodes.length} 条：${table.join(' ')}`);
  console.log(`[GY-I08 装配] 匹配映射 ${matchStates.length} 条：${matchStates.map((s) => `${s}→${MATCH_ERROR_MAP[s] ?? '放行'}`).join(' ')}`);
});

test('GY-I08 装配：未登记阻断类别 fail-closed（409，不 5xx，不放行）', () => {
  const error = errorForBlockCodes(['future_block_code_added_by_a_later_rule_version'], ['未知阻断']);
  assert.equal(error.code, 'OBJECT_UNAVAILABLE');
  assert.equal(error.unmapped, true, '必须打上 unmapped 标记供告警');
  assert.equal(isClientError(statusOf(error.code)), true);
  assert.equal(statusOf(error.code), 409);
  // 已知码仍优先：混合列表里已知码胜出，但 unmapped 标记保留。
  const mixed = errorForBlockCodes([BLOCK_CODES.UNREVIEWED, 'future_code']);
  assert.equal(mixed.code, 'OBJECT_UNAVAILABLE');
  assert.equal(mixed.unmapped, true);
  const known = errorForBlockCodes([BLOCK_CODES.MISSING_CONDITION]);
  assert.equal(known.code, 'CONDITIONS_INCOMPLETE');
  assert.equal(known.unmapped, false);
  console.log(`[GY-I08 装配] fail-closed：未知码→${error.code}(${statusOf(error.code)})、unmapped=${error.unmapped}；缺条件→${known.code}(${statusOf(known.code)})`);
});

test('GY-I08 装配：可执行判定与域库同判（合成正例放行，阻断例一律 blocked）', () => {
  const positive = screenApplicability(doseItem(), {});
  assert.equal(positive.status, SCREEN_STATUS.EXECUTABLE);
  assert.equal(positive.error, null);
  assert.equal(positive.dose_count, 1);
  assert.deepEqual(positive.dose_card.dose, { number: '40', unit: '克/公顷', condition: '苗后茎叶喷雾' });
  assert.equal(positive.dose_error, null);

  const negative = screenApplicability(doseItem({ verification: { review_status: 'unverified' } }), {});
  assert.equal(negative.status, SCREEN_STATUS.BLOCKED);
  assert.equal(negative.dose_card, null);
  assert.equal(negative.dose_count, 0);
  assert.ok(negative.error, '阻断必须带错误');
  assert.equal(negative.error.code, 'OBJECT_UNAVAILABLE');
  assert.equal(statusOf(negative.error.code), 409);

  // 有建议但**无原文用量**：不编造卡片，单独给「不可渲染」的 4xx。
  const noDose = screenApplicability(item({}), {});
  assert.equal(noDose.status, SCREEN_STATUS.EXECUTABLE, '该记录本身可进入可执行建议');
  assert.equal(noDose.dose_card, null, '没有原文用量时不得产出卡片');
  assert.ok(noDose.dose_error, '必须说明为什么不能渲染用量');
  assert.equal(noDose.dose_error.code, 'OBJECT_UNAVAILABLE');
  assert.equal(isClientError(statusOf(noDose.dose_error.code)), true);
  console.log(`[GY-I08 装配] 正例 executable / 未核对 blocked(${negative.error.code}) / 无原文用量 executable+dose_error(${noDose.dose_error.code})`);
});

test('GY-I08 装配：119 条登记／限制场景在装配层逐例同判，且阻断例零用量卡', () => {
  const problems = [];
  let blocked = 0;
  let executableWithDose = 0;
  let executableNoDose = 0;
  for (const scenario of SCENARIOS) {
    const expect = scenario.expect;
    const outcome = screenApplicability(scenario.item, scenario.ctx ?? {}, scenario.opts ?? {});
    const expectedStatus = expect.exec ? SCREEN_STATUS.EXECUTABLE : SCREEN_STATUS.BLOCKED;
    if (outcome.status !== expectedStatus) {
      problems.push(`${scenario.id} 装配层 status=${outcome.status}，域库期望 ${expectedStatus}`);
    }
    if (!expect.exec) {
      blocked += 1;
      if (outcome.error === null) problems.push(`${scenario.id} 被阻断却无错误码`);
      else if (!isClientError(statusOf(outcome.error.code))) {
        problems.push(`${scenario.id} 错误码 ${outcome.error.code} 非 4xx`);
      }
      if (outcome.dose_card !== null) problems.push(`${scenario.id} 被阻断却产出用量卡`);
      if (outcome.dose_count !== 0) problems.push(`${scenario.id} 被阻断却 dose_count=${outcome.dose_count}`);
      // 用量卡片入口必须同样拒绝，且拒绝原因是阻断而不是 500。
      try {
        requireDoseCard(scenario.item, scenario.ctx ?? {}, scenario.opts ?? {});
        problems.push(`${scenario.id} 被阻断却仍能取到用量卡`);
      } catch (error) {
        if (!(error instanceof ApiError)) problems.push(`${scenario.id} requireDoseCard 抛的不是 ApiError`);
        else if (!isClientError(error.status)) problems.push(`${scenario.id} requireDoseCard 抛了 ${error.status}`);
      }
    } else if (expect.dose) {
      executableWithDose += 1;
      if (outcome.error !== null) problems.push(`${scenario.id} 放行却带错误`);
      if (outcome.dose_card === null) problems.push(`${scenario.id} 期望可渲染却没有用量卡`);
      if (outcome.dose_error !== null) problems.push(`${scenario.id} 可渲染却带 dose_error`);
      const card = requireDoseCard(scenario.item, scenario.ctx ?? {}, scenario.opts ?? {});
      const boundary = evaluateDoseBoundary(scenario.item, scenario.ctx ?? {}, scenario.opts ?? {});
      if (JSON.stringify(card.dose) !== JSON.stringify(boundary.dose_card.dose)) {
        problems.push(`${scenario.id} 用量卡三元组与域库不一致`);
      }
    } else {
      executableNoDose += 1;
      if (outcome.error !== null) problems.push(`${scenario.id} 放行却带错误`);
      if (outcome.dose_card !== null) problems.push(`${scenario.id} 无原文用量却产出卡片`);
      if (outcome.dose_error === null) problems.push(`${scenario.id} 无原文用量却没有说明`);
      else if (!isClientError(statusOf(outcome.dose_error.code))) {
        problems.push(`${scenario.id} dose_error ${outcome.dose_error.code} 非 4xx`);
      }
      try {
        requireDoseCard(scenario.item, scenario.ctx ?? {}, scenario.opts ?? {});
        problems.push(`${scenario.id} 无原文用量却仍能取到用量卡`);
      } catch (error) {
        if (!(error instanceof ApiError)) problems.push(`${scenario.id} requireDoseCard 抛的不是 ApiError`);
        else if (!isClientError(error.status)) problems.push(`${scenario.id} requireDoseCard 抛了 ${error.status}`);
      }
    }
    // 文案不得含禁用承诺词
    for (const text of [...outcome.reasons, outcome.error?.message ?? '', outcome.dose_error?.message ?? '']) {
      for (const forbidden of FORBIDDEN_LABELS) {
        if (String(text).includes(forbidden)) problems.push(`${scenario.id} 文案含禁用词「${forbidden}」`);
      }
    }
  }
  assert.deepEqual(problems, [], `装配层与域库判定不一致：\n${problems.slice(0, 20).join('\n')}`);
  assert.equal(blocked + executableWithDose + executableNoDose, SCENARIOS.length);
  console.log(
    `[GY-I08 装配] 场景 ${SCENARIOS.length} 条：blocked=${blocked}、可执行且有用量=${executableWithDose}、可执行但无原文用量=${executableNoDose}；阻断例逐条带 4xx 且 requireDoseCard 一律拒绝`,
  );
});

test('GY-I08 装配：真实资料零放行（20 条公告 + 159 条浙江资料）', () => {
  const announcement = loadHerbicideRecords().items;
  const zhejiang = loadZhejiangKnowledge().items;
  assert.equal(announcement.length, 20, '真实公告记录条数变了，需复核');
  assert.equal(zhejiang.length, 159, '浙江资料条数变了，需复核');

  const rows = [
    ...announcement.map((item) => ({ label: `公告 ${item.registration_number ?? item.record_id}`, item })),
    ...zhejiang.map((item) => ({ label: `浙江 ${item.item_id}`, item })),
  ];
  const problems = [];
  for (const row of rows) {
    const outcome = screenApplicability(row.item, {});
    if (outcome.status !== SCREEN_STATUS.BLOCKED) problems.push(`${row.label} 被放行`);
    if (outcome.dose_card !== null) problems.push(`${row.label} 产出了用量卡`);
    if (outcome.dose_count !== 0) problems.push(`${row.label} dose_count=${outcome.dose_count}`);
    if (outcome.error === null) problems.push(`${row.label} 无错误码`);
    else if (!isClientError(statusOf(outcome.error.code))) problems.push(`${row.label} 错误码 ${outcome.error.code} 非 4xx`);
  }
  assert.deepEqual(problems, [], `真实资料放行问题：\n${problems.slice(0, 20).join('\n')}`);
  console.log(`[GY-I08 装配] 真实资料 ${rows.length} 条（公告 ${announcement.length} + 浙江 ${zhejiang.length}）全部 blocked、用量卡 0、错误码全 4xx`);
});

test('GY-I08 装配：登记匹配非 matched 一律带 4xx，matched 才返回记录', () => {
  const problems = [];
  const states = new Map();
  for (const testCase of MATCH_CASES) {
    const outcome = screenRegistrationMatch(testCase.candidates, testCase.query, testCase.opts ?? {});
    states.set(outcome.state, (states.get(outcome.state) ?? 0) + 1);
    if (outcome.state !== testCase.state) problems.push(`${testCase.id} state 期望 ${testCase.state} 实际 ${outcome.state}`);
    if (outcome.state === 'matched') {
      if (outcome.matched === null) problems.push(`${testCase.id} matched 却无记录`);
      if (outcome.error !== null) problems.push(`${testCase.id} matched 却带错误`);
      continue;
    }
    if (outcome.matched !== null) problems.push(`${testCase.id} 非 matched 却返回记录`);
    if (outcome.error === null) problems.push(`${testCase.id} 非 matched 却无错误码`);
    else if (!isClientError(statusOf(outcome.error.code))) problems.push(`${testCase.id} 错误码 ${outcome.error.code} 非 4xx`);
    if (outcome.dose_card !== null) problems.push(`${testCase.id} 匹配失败却给用量卡`);
  }
  assert.deepEqual(problems, [], `匹配装配问题：\n${problems.slice(0, 20).join('\n')}`);
  console.log(`[GY-I08 装配] 匹配用例 ${MATCH_CASES.length} 条：${[...states].map(([s, n]) => `${s}=${n}`).join('、')}`);
});

test('GY-I08 装配：requireExecutableAdvice 抛 ApiError（4xx）而不是 5xx 或静默返回', () => {
  const cases = [
    { label: '未核对', item: doseItem({ verification: { review_status: 'unverified' } }), ctx: {}, code: 'OBJECT_UNAVAILABLE', status: 409 },
    { label: '不适用', item: doseItem(), ctx: { crop_id: 'crop_wheat' }, code: 'INPUT_UNCERTAIN', status: 422 },
    { label: '禁用', item: doseItem({ verification: { restriction_status: 'banned' } }), ctx: {}, code: 'OBJECT_UNAVAILABLE', status: 409 },
    { label: '开关关闭', item: doseItem(), ctx: {}, opts: { executableEnabled: false }, code: 'SCOPE_DENIED', status: 403 },
  ];
  const problems = [];
  for (const item of cases) {
    try {
      requireExecutableAdvice(item.item, item.ctx, item.opts ?? {});
      problems.push(`${item.label} 没有抛错（静默放过）`);
    } catch (error) {
      if (!(error instanceof ApiError)) problems.push(`${item.label} 抛的不是 ApiError：${error?.constructor?.name}`);
      else {
        if (error.code !== item.code) problems.push(`${item.label} 错误码期望 ${item.code} 实际 ${error.code}`);
        if (error.status !== item.status) problems.push(`${item.label} 状态期望 ${item.status} 实际 ${error.status}`);
        if (error.status >= 500) problems.push(`${item.label} 抛成了 5xx`);
        if (String(error.message).trim() === '') problems.push(`${item.label} 错误信息为空`);
        const scan = scanRiskWording(error.message);
        if (!scan.ok) problems.push(`${item.label} 错误信息含风险承诺词：${scan.hits.map((h) => h.term).join(',')}`);
      }
    }
  }
  assert.deepEqual(problems, [], `requireExecutableAdvice 问题：\n${problems.join('\n')}`);
  // 正例：可执行时不抛，原样返回。
  const ok = requireExecutableAdvice(doseItem(), {});
  assert.equal(ok.status, SCREEN_STATUS.EXECUTABLE);
  console.log(`[GY-I08 装配] requireExecutableAdvice：${cases.map((c) => `${c.label}→${c.code}(${c.status})`).join('、')}；正例不抛`);
});

test('GY-I08 装配：所有阻断原因过风险文字守卫（无绝对安全／零药害类承诺）', () => {
  const texts = [];
  for (const scenario of SCENARIOS) {
    const outcome = screenApplicability(scenario.item, scenario.ctx ?? {}, scenario.opts ?? {});
    texts.push(...outcome.reasons);
    if (outcome.error) texts.push(outcome.error.message);
  }
  const hits = [];
  for (const text of texts) {
    const scan = scanRiskWording(text);
    if (!scan.ok) hits.push(`${text} → ${scan.hits.map((h) => h.term).join(',')}`);
  }
  assert.deepEqual(hits, [], `阻断原因含风险承诺词：\n${hits.slice(0, 10).join('\n')}`);
  console.log(`[GY-I08 装配] 阻断原因 ${texts.length} 条全部通过风险文字守卫（命中 0）`);
});
