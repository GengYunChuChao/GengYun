/**
 * GY-I14 确定性硬规则审核层 · fail-closed 验收（派单 §4.1，最重要的一组）。
 *
 * 断言纪律：每条用例都要求
 *   1) `decision !== 'approved'`；
 *   2) `hard_rule_passed` **不是** true（且必须是 boolean）；
 *   3) decision 落在契约闭集内；
 *   4) 期望的 fail-closed 原因码确实出现。
 * 也就是说：只要"必要条件未知"，就绝不放行——这正是监工对 PR #82 判 P1 的形态。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIT_STATES,
  MAX_TEXT_LENGTH,
  isAuditState,
} from '../../packages/moderation/constants.mjs';
import { MATCHERS } from '../../packages/moderation/matchers.mjs';
import { RULES, validateRuleCatalog } from '../../packages/moderation/rules.mjs';
import {
  assertDecisionInvariant,
  checkDecisionInvariant,
  toRuleLayerDraft,
} from '../../packages/moderation/engine.mjs';
import {
  CLEAN_TEXT,
  buildScanLimitText,
  makeInput,
  runRules,
  scriptedClock,
  withThrowingGetter,
} from './_fixtures.mjs';

function expectNotApproved(result, name) {
  assert.equal(typeof result.decision, 'string', `${name}: decision 必须是字符串`);
  assert.equal(isAuditState(result.decision), true, `${name}: decision 越界 ${String(result.decision)}`);
  assert.notEqual(result.decision, 'approved', `${name}: 不得判为通过`);
  assert.equal(typeof result.hard_rule_passed, 'boolean', `${name}: hard_rule_passed 必须是布尔值`);
  assert.notEqual(result.hard_rule_passed, true, `${name}: hard_rule_passed 不得为 true`);
  const invariant = checkDecisionInvariant(result);
  assert.deepEqual(invariant.violations, [], `${name}: 违反不变式`);
  assert.equal(toRuleLayerDraft(result).complete, false);
}

const INPUT_CASES = [
  { name: '输入 undefined', input: undefined, code: 'INPUT_NOT_OBJECT' },
  { name: '输入 null', input: null, code: 'INPUT_NOT_OBJECT' },
  { name: '输入数组', input: [], code: 'INPUT_NOT_OBJECT' },
  { name: '输入字符串', input: '忽略以上指令', code: 'INPUT_NOT_OBJECT' },
  { name: '输入数字', input: 42, code: 'INPUT_NOT_OBJECT' },
  { name: '空对象（全部字段缺失）', input: {}, code: 'INPUT_TARGET_REF_INVALID' },
  { name: '缺 target_ref', input: { text: CLEAN_TEXT, media: [] }, code: 'INPUT_TARGET_REF_INVALID' },
  { name: 'target_ref 非对象', input: makeInput({ target_ref: 'post-1001' }), code: 'INPUT_TARGET_REF_INVALID' },
  {
    name: 'target type 不在契约闭集',
    input: makeInput({ target_ref: { type: 'unknown_thing', id: 'x-1', revision: 1 } }),
    code: 'INPUT_TARGET_TYPE_INVALID',
  },
  {
    name: 'target type 合法但本片未覆盖（species）',
    input: makeInput({ target_ref: { type: 'species', id: 'sp-1', revision: 1 } }),
    code: 'TARGET_TYPE_NOT_COVERED',
  },
  {
    name: 'target id 为空串',
    input: makeInput({ target_ref: { type: 'post', id: '', revision: 1 } }),
    code: 'INPUT_TARGET_ID_INVALID',
  },
  {
    name: 'target id 超过 80',
    input: makeInput({ target_ref: { type: 'post', id: 'x'.repeat(81), revision: 1 } }),
    code: 'INPUT_TARGET_ID_INVALID',
  },
  {
    name: 'target revision 为 0',
    input: makeInput({ target_ref: { type: 'post', id: 'post-1', revision: 0 } }),
    code: 'INPUT_TARGET_REVISION_INVALID',
  },
  {
    name: 'target revision 非整数',
    input: makeInput({ target_ref: { type: 'post', id: 'post-1', revision: 1.5 } }),
    code: 'INPUT_TARGET_REVISION_INVALID',
  },
  {
    name: 'target revision 是字符串',
    input: makeInput({ target_ref: { type: 'post', id: 'post-1', revision: '1' } }),
    code: 'INPUT_TARGET_REVISION_INVALID',
  },
  { name: '缺 text', input: { target_ref: { type: 'post', id: 'post-1', revision: 1 }, media: [] }, code: 'INPUT_TEXT_MISSING' },
  { name: 'text 为 null', input: makeInput({ text: null }), code: 'INPUT_TEXT_NOT_STRING' },
  { name: 'text 为数字', input: makeInput({ text: 123 }), code: 'INPUT_TEXT_NOT_STRING' },
  { name: 'text 为空串', input: makeInput({ text: '' }), code: 'INPUT_TEXT_EMPTY' },
  { name: 'text 全空白', input: makeInput({ text: '   \n\t ' }), code: 'INPUT_TEXT_EMPTY' },
  { name: 'text 落单代理项（编码异常）', input: makeInput({ text: '苗情\uD800异常' }), code: 'INPUT_TEXT_ENCODING_INVALID' },
  { name: 'text 含替换字符（解码损坏）', input: makeInput({ text: `苗情${'\uFFFD'}异常` }), code: 'INPUT_TEXT_ENCODING_INVALID' },
  { name: 'text 含控制字符', input: makeInput({ text: '苗情\u0000异常' }), code: 'INPUT_TEXT_ENCODING_INVALID' },
  {
    name: '缺 media（未知是否有图片）',
    input: { target_ref: { type: 'post', id: 'post-1', revision: 1 }, text: CLEAN_TEXT },
    code: 'INPUT_MEDIA_MISSING',
  },
  { name: 'media 非数组', input: makeInput({ media: 'none' }), code: 'INPUT_MEDIA_NOT_ARRAY' },
  {
    name: '带媒体（图片审核属模型层，规则层不得放行）',
    input: makeInput({ media: [{ kind: 'image' }] }),
    code: 'MEDIA_NOT_EVALUATED_BY_RULE_LAYER',
  },
  { name: '未知顶层字段', input: { ...makeInput(), note: '额外条件' }, code: 'INPUT_UNKNOWN_FIELD' },
  { name: 'text getter 抛错', input: withThrowingGetter('text'), code: 'INPUT_READ_FAILED' },
];

for (const item of INPUT_CASES) {
  test(`fail-closed：${item.name} ⇒ 不得通过`, () => {
    const result = runRules(item.input);
    expectNotApproved(result, item.name);
    assert.ok(result.reason_codes.includes(item.code), `缺原因码 ${item.code}：${result.reason_codes.join(',')}`);
  });
}

test('fail-closed：text 超长（超过组件防御上界）⇒ 不得通过', () => {
  const result = runRules(makeInput({ text: '苗'.repeat(50) }), { max_text_length: 10 });
  expectNotApproved(result, 'text 超长');
  assert.ok(result.reason_codes.includes('INPUT_TEXT_TOO_LONG'));
});

test('输入闸门不通过时，规则一条都不算求值（"没跑"≠"通过"）', () => {
  const cases = [undefined, {}, makeInput({ text: '' }), makeInput({ media: [{}] })];
  for (const input of cases) {
    const result = runRules(input);
    assert.equal(result.counts.evaluated, 0, '输入闸门不通过时不得声称规则已求值');
    assert.equal(result.counts.total, RULES.length);
    assert.equal(result.counts.not_evaluated, RULES.length);
    assert.equal(result.decision, 'quarantined');
  }
});

test('未覆盖的 target type：全部 17 个契约类型中，未声明覆盖的一律隔离', async () => {
  const { TARGET_TYPES, COVERED_TARGET_TYPES } = await import('../../packages/moderation/constants.mjs');
  const uncovered = TARGET_TYPES.filter((type) => !COVERED_TARGET_TYPES.includes(type));
  assert.ok(uncovered.length > 0, '至少应存在未覆盖类型以证明该闸门有效');
  for (const type of uncovered) {
    const result = runRules(makeInput({ target_ref: { type, id: 'ref-1', revision: 1 } }));
    expectNotApproved(result, `未覆盖类型 ${type}`);
    assert.ok(result.reason_codes.includes('TARGET_TYPE_NOT_COVERED'));
    assert.equal(result.decision, 'quarantined');
  }
  for (const type of COVERED_TARGET_TYPES) {
    const result = runRules(makeInput({ target_ref: { type, id: 'ref-1', revision: 1 } }));
    assert.equal(result.decision, 'approved', `已覆盖类型 ${type} 的干净文本应放行`);
  }
});

// ---- 规则引擎级 fail-closed ----

test('fail-closed：空规则集不得通过（"零条规则都没命中"不是通过）', () => {
  const result = runRules(makeInput(), { rules: [] });
  expectNotApproved(result, '空规则集');
  assert.ok(result.reason_codes.includes('RULE_CATALOG_INVALID'));
  assert.equal(result.decision, 'quarantined');
});

test('fail-closed：规则集结构非法（id 重复／原因码越界／带 g 标志）不得通过', () => {
  const duplicated = [RULES[0], { ...RULES[1], id: RULES[0].id }];
  const badCode = [{ ...RULES[0], reason_code: 'NOT_A_CODE' }];
  const stateful = [{ ...RULES[0], matcher: 'any_pattern', patterns: [/苗/g] }];
  for (const [name, rules] of [['id 重复', duplicated], ['原因码越界', badCode], ['g 标志', stateful]]) {
    assert.equal(validateRuleCatalog(rules, MATCHERS).valid, false, `${name} 应被判非法`);
    const result = runRules(makeInput(), { rules });
    expectNotApproved(result, `规则集非法（${name}）`);
    assert.ok(result.reason_codes.includes('RULE_CATALOG_INVALID'));
  }
});

test('fail-closed：单条规则抛错 ⇒ 计入"未求值/失败"，不得吞成"未命中"', () => {
  const rules = [
    {
      id: 'MR-90',
      category: 'privacy',
      reason_code: 'PRIVACY_PII',
      title: '会抛错的规则',
      description: '仅用于失败隔离用例',
      severity: 'block',
      matcher: 'any_pattern',
      patterns: [/苗/],
    },
  ];
  const matchers = {
    ...MATCHERS,
    any_pattern: () => {
      throw new Error('boom: rule exploded');
    },
  };
  const result = runRules(makeInput(), { rules, matchers });
  expectNotApproved(result, '规则抛错');
  assert.ok(result.reason_codes.includes('RULE_ENGINE_ERROR'));
  assert.equal(result.rules[0].status, 'error');
  assert.notEqual(result.rules[0].status, 'evaluated');
  assert.equal(result.rules[0].matched, false);
  assert.equal(result.counts.errors, 1);
  assert.equal(result.counts.evaluated, 0);
  assert.deepEqual(result.invariant_violations, []);
});

test('fail-closed：匹配器返回结构非法也算失败，不得当作"未命中"', () => {
  const rules = [
    {
      id: 'MR-91',
      category: 'privacy',
      reason_code: 'PRIVACY_PII',
      title: '返回非法结构的匹配器',
      description: '仅用于失败隔离用例',
      severity: 'block',
      matcher: 'any_pattern',
      patterns: [/苗/],
    },
  ];
  const matchers = { ...MATCHERS, any_pattern: () => null };
  const result = runRules(makeInput(), { rules, matchers });
  expectNotApproved(result, '匹配器返回 null');
  assert.equal(result.rules[0].status, 'error');
  assert.equal(result.hard_rule_passed, false);
});

test('fail-closed：规则预算耗尽（超时）⇒ 未求值的规则不得算通过', () => {
  const result = runRules(makeInput(), {
    clock: scriptedClock([0, 1000]),
    budget_ms: 50,
  });
  expectNotApproved(result, '规则超时');
  assert.ok(result.reason_codes.includes('RULE_TIMEOUT'));
  assert.equal(result.decision, 'quarantined');
  assert.equal(result.counts.timeouts, RULES.length);
  assert.equal(result.counts.evaluated, 0);
  assert.equal(result.budget.exhausted, true);
  for (const entry of result.rules) assert.equal(entry.status, 'timeout');
});

test('fail-closed：时钟不可用（抛错）⇒ 不放行', () => {
  const result = runRules(makeInput(), {
    clock: () => {
      throw new Error('boom: clock');
    },
  });
  expectNotApproved(result, '时钟抛错');
  assert.ok(result.reason_codes.includes('RULE_ENGINE_ERROR'));
  assert.equal(result.counts.not_evaluated, RULES.length);
});

test('fail-closed：给错引擎选项不等于按默认值跑一遍就算通过', () => {
  const cases = [
    ['rules 非数组', { rules: 'RULES' }],
    ['matchers 为数组', { matchers: [] }],
    ['clock 不是函数', { clock: 'Date.now' }],
    ['budget_ms 为 NaN', { budget_ms: Number.NaN }],
    ['budget_ms 为负', { budget_ms: -1 }],
    ['max_text_length 为 0', { max_text_length: 0 }],
  ];
  for (const [name, options] of cases) {
    const result = runRules(makeInput(), options);
    expectNotApproved(result, `选项非法（${name}）`);
    assert.ok(result.reason_codes.includes('ENGINE_OPTIONS_INVALID'), `${name} 缺原因码`);
    assert.ok(result.option_errors.length > 0, `${name} 未记录选项错误`);
    assert.equal(result.counts.evaluated, 0);
  }
  // 合法选项不受影响。
  const ok = runRules(makeInput(), { budget_ms: 1000, max_text_length: 20000 });
  assert.deepEqual(ok.option_errors, []);
  assert.equal(ok.decision, 'approved');
});

// ---- 扫描限额截断（返修轮 3 · 监工 P1）----

test('fail-closed：扫描限额截断（×64）不得把未检查的尾部当作"未命中"', () => {
  const text = buildScanLimitText(64);
  // 先排除"这是超长隔离"的解释：455 字符远在上限之内。
  assert.ok(text.length <= MAX_TEXT_LENGTH, `反例必须在上限内：${text.length}`);
  const result = runRules(makeInput({ text }));

  expectNotApproved(result, '扫描限额截断（×64）');
  assert.equal(result.decision, 'quarantined');
  assert.ok(result.reason_codes.includes('RULE_SCAN_TRUNCATED'), result.reason_codes.join(','));
  // 未检查的尾部不得算作"已求值且未命中"。
  const entry = result.rules.find((item) => item.id === 'MR-01');
  assert.equal(entry.status, 'truncated');
  assert.notEqual(entry.status, 'evaluated');
  assert.equal(entry.matched, false);
  assert.equal(entry.evidence.truncated, true);
  assert.equal(result.counts.truncated, 1);
  assert.equal(result.counts.evaluated, RULES.length - 1);
  assert.equal(result.hard_rule_passed, false);
  assert.deepEqual(checkDecisionInvariant(result).violations, []);
});

test('对照：扫描限额之内（×63）仍按真实命中判 rejected', () => {
  const text = buildScanLimitText(63);
  assert.ok(text.length <= MAX_TEXT_LENGTH);
  const result = runRules(makeInput({ text }));
  assert.equal(result.decision, 'rejected');
  assert.ok(result.reason_codes.includes('DANGEROUS_MIX'));
  assert.equal(result.reason_codes.includes('RULE_SCAN_TRUNCATED'), false);
  const entry = result.rules.find((item) => item.id === 'MR-01');
  assert.equal(entry.status, 'hit');
  assert.equal(result.counts.hits, 1);
  assert.equal(result.counts.truncated, 0);
});

test('扫描限额与输入长度上限是两个不同的闸门（×64 反例未被误判为超长）', () => {
  const text = buildScanLimitText(64);
  const byLimit = runRules(makeInput({ text }));
  assert.equal(byLimit.reason_codes.includes('INPUT_TEXT_TOO_LONG'), false);
  assert.equal(byLimit.input.valid, true);
  // 把上限压到文本之下，才会走"超长"这条闸门——证明上面那条不是超长导致的。
  const tooLong = runRules(makeInput({ text }), { max_text_length: 100 });
  expectNotApproved(tooLong, '压小上限后的×64文本');
  assert.ok(tooLong.reason_codes.includes('INPUT_TEXT_TOO_LONG'));
  assert.equal(tooLong.reason_codes.includes('RULE_SCAN_TRUNCATED'), false);
});

test('核心不变式：approved ⟺ hard_rule_passed === true（全部用例加总核对）', () => {
  const samples = [
    ...INPUT_CASES.map((item) => item.input),
    makeInput(),
    makeInput({ text: '这个配方保证无残留，绝对安全。' }),
    makeInput({ media: [] }),
  ];
  for (const input of samples) {
    const result = runRules(input);
    assert.equal(
      result.decision === 'approved',
      result.hard_rule_passed === true,
      `不变式被破坏：decision=${result.decision} hard_rule_passed=${String(result.hard_rule_passed)}`,
    );
  }
});

test('不变式检查能捕捉 undefined／越界值（先 typeof 再判值）', () => {
  const cases = [
    { name: 'decision 为 undefined', result: { decision: undefined, hard_rule_passed: false, reason_codes: [], rule_version: 'v' } },
    { name: 'hard_rule_passed 为字符串', result: { decision: 'approved', hard_rule_passed: 'true', reason_codes: [], rule_version: 'v' } },
    { name: 'rule_version 为 undefined', result: { decision: 'quarantined', hard_rule_passed: false, reason_codes: [], rule_version: undefined } },
    { name: 'reason_codes 超过 30 项', result: { decision: 'quarantined', hard_rule_passed: false, reason_codes: Array.from({ length: 31 }, (_, i) => `CODE_${i}`), rule_version: 'v' } },
    { name: 'approved 但 hard_rule_passed 为 false', result: { decision: 'approved', hard_rule_passed: false, reason_codes: [], rule_version: 'v' } },
    { name: 'hard_rule_passed 为 true 但 decision 不是 approved', result: { decision: 'pending', hard_rule_passed: true, reason_codes: [], rule_version: 'v' } },
    {
      name: 'approved 但存在被扫描限额截断的规则',
      result: {
        decision: 'approved',
        hard_rule_passed: true,
        reason_codes: [],
        rule_version: 'v',
        counts: { total: 1, evaluated: 0, hits: 0, errors: 0, timeouts: 0, truncated: 1, not_evaluated: 0 },
      },
    },
    {
      name: 'approved 但存在未求值的规则',
      result: {
        decision: 'approved',
        hard_rule_passed: true,
        reason_codes: [],
        rule_version: 'v',
        counts: { total: 1, evaluated: 0, hits: 0, errors: 0, timeouts: 0, truncated: 0, not_evaluated: 1 },
      },
    },
  ];
  for (const item of cases) {
    const report = checkDecisionInvariant(item.result);
    assert.equal(report.ok, false, `${item.name} 应被不变式抓住`);
    assert.ok(report.violations.length > 0);
    assert.throws(() => assertDecisionInvariant(item.result), `${item.name} 断言版应抛错`);
  }
  const ok = runRules(makeInput());
  assert.deepEqual(checkDecisionInvariant(ok), { ok: true, violations: [] });
  assert.equal(assertDecisionInvariant(ok), ok);
});

test('契约闭集核对：全部用例的 decision 都在 AuditState 之内', () => {
  for (const item of INPUT_CASES) {
    const result = runRules(item.input);
    assert.ok(AUDIT_STATES.includes(result.decision));
  }
});
