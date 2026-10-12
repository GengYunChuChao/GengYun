/**
 * GY-I14 确定性硬规则审核层 · 逐规则命中／不命中回归。
 *
 * 纪律（派单 §4.4）：每个"应当拦截"与"应当放行"的情形**各一条独立用例**，
 * **不用**矩阵条数证明 fail-closed；断言先 `typeof` 再判值以捕捉 `undefined`。
 *
 * 再次声明：这是**规则夹具上的确定性回归**，不是真实样本上的模型指标。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { RULES } from '../../packages/moderation/rules.mjs';
import { DANGEROUS_NEGATION_CANCELLERS } from '../../packages/moderation/matchers.mjs';
import { DEFAULT_RULE_BUDGET_MS, RULE_CATEGORIES, isAuditState } from '../../packages/moderation/constants.mjs';
import {
  CLEAN_TEXT,
  NEGATION_CANCELLATION_FIXTURES,
  PURE_NEGATION_FIXTURES,
  RULE_TEXT_FIXTURES,
  makeInput,
  runRules,
} from './_fixtures.mjs';

function ruleById(id) {
  const rule = RULES.find((item) => item.id === id);
  assert.ok(rule, `规则集里没有 ${id}`);
  return rule;
}

test('干净文本应当放行：approved 且 hard_rule_passed 为 true（基线对照）', () => {
  const result = runRules(makeInput({ text: CLEAN_TEXT }));
  assert.equal(typeof result.decision, 'string');
  assert.equal(result.decision, 'approved');
  assert.equal(result.hard_rule_passed, true);
  assert.equal(typeof result.hard_rule_passed, 'boolean');
  assert.equal(result.counts.total, RULES.length);
  assert.equal(result.counts.evaluated, RULES.length, '全部规则都必须实际求值');
  assert.equal(result.counts.not_evaluated, 0);
  assert.equal(result.counts.errors, 0);
  assert.equal(result.counts.timeouts, 0);
});

for (const fixture of RULE_TEXT_FIXTURES) {
  test(`${fixture.rule_id} 命中：${fixture.reason_code}`, () => {
    const rule = ruleById(fixture.rule_id);
    assert.equal(rule.reason_code, fixture.reason_code);
    assert.equal(rule.category, fixture.category);

    const result = runRules(makeInput({ text: fixture.hit }));
    const entry = result.rules.find((item) => item.id === fixture.rule_id);
    assert.ok(entry, `${fixture.rule_id} 未出现在求值结果里`);
    assert.equal(typeof entry.status, 'string');
    assert.equal(entry.status, 'hit');
    assert.equal(entry.matched, true);
    assert.ok(result.reason_codes.includes(fixture.reason_code), 'reason_codes 必须带上命中原因码');
    assert.equal(result.decision, 'rejected');
    // 命中即"硬规则未全通过"：hard_rule_passed 必须为 false，且不得被当成通过。
    assert.equal(result.hard_rule_passed, false);
    assert.notEqual(result.decision, 'approved');
  });

  test(`${fixture.rule_id} 不命中（${fixture.miss_kind}）：${fixture.reason_code}`, () => {
    const result = runRules(makeInput({ text: fixture.miss }));
    const entry = result.rules.find((item) => item.id === fixture.rule_id);
    assert.ok(entry);
    assert.equal(entry.status, 'evaluated', `${fixture.rule_id} 不应命中"应当放行"的文本`);
    assert.equal(entry.matched, false);
    assert.equal(result.reason_codes.includes(fixture.reason_code), false);
    // 本用例同时证明没有别的规则误拦（否则 decision 不会是 approved）。
    assert.equal(result.decision, 'approved');
    assert.equal(result.hard_rule_passed, true);
  });
}

test('规则类别覆盖：每个声明类别都有命中与不命中两类夹具', () => {
  const covered = new Set(RULE_TEXT_FIXTURES.map((item) => item.category));
  for (const category of RULE_CATEGORIES) {
    assert.equal(covered.has(category), true, `类别 ${category} 缺夹具`);
  }
  for (const fixture of RULE_TEXT_FIXTURES) {
    assert.equal(typeof fixture.hit, 'string');
    assert.equal(typeof fixture.miss, 'string');
    assert.ok(fixture.hit.length > 0 && fixture.miss.length > 0);
    assert.notEqual(fixture.hit, fixture.miss);
  }
});

// ---- fail-open 方向返修（2026-10-11）：危险类的"否定 + 转折/祈使"必须照常拦截 ----

for (const fixture of NEGATION_CANCELLATION_FIXTURES) {
  test(`危险类否定取消：${fixture.name} ⇒ 不得放行`, () => {
    const result = runRules(makeInput({ text: fixture.text }));
    const entry = result.rules.find((item) => item.id === fixture.rule_id);
    assert.ok(entry, `${fixture.rule_id} 未出现在求值结果里`);
    // 最高优先断言：绝不 approved（fail-open 方向的底线）。
    assert.notEqual(result.decision, 'approved', `漏拦：${fixture.text}`);
    assert.equal(result.hard_rule_passed, false);
    assert.equal(result.decision, 'rejected', `应判 rejected：${fixture.text}`);
    // 逐条独立用例：必须由该规则自己命中，并带上自己的原因码。
    assert.equal(entry.status, 'hit');
    assert.equal(entry.matched, true);
    assert.ok(result.reason_codes.includes(fixture.reason_code));
    if (fixture.required_by_order) assert.equal(typeof fixture.required_by_order, 'boolean');
  });
}

for (const fixture of PURE_NEGATION_FIXTURES) {
  test(`纯否定无转折：${fixture.name} ⇒ 仍不命中`, () => {
    const result = runRules(makeInput({ text: fixture.text }));
    const entry = result.rules.find((item) => item.id === fixture.rule_id);
    assert.ok(entry);
    assert.equal(entry.status, 'evaluated', `不得因返修而误伤纯否定句：${fixture.text}`);
    assert.equal(entry.matched, false);
    assert.equal(result.decision, 'approved');
    assert.equal(result.hard_rule_passed, true);
  });
}

test('否定取消词只对危险两类生效，其它类别的否定护栏行为不变', () => {
  const withCancellers = RULES.filter((rule) => rule.negation_cancellers !== undefined).map((rule) => rule.id);
  assert.deepEqual(withCancellers, ['MR-01', 'MR-02', 'MR-03']);
  for (const id of withCancellers) {
    const rule = ruleById(id);
    assert.ok(
      ['dangerous_usage', 'label_bound_dose'].includes(rule.category),
      `${id} 不属于危险两类，不应启用取消词`,
    );
    assert.deepEqual([...rule.negation_cancellers], [...DANGEROUS_NEGATION_CANCELLERS]);
  }
  // 非危险类的"否定 + 转折"仍按原语义压掉（返修不得改变其它类行为）。
  const safety = runRules(makeInput({ text: '按标签使用可以减少残留风险，但不代表完全没有残留。' }));
  assert.equal(safety.decision, 'approved');
  assert.equal(safety.rules.find((item) => item.id === 'MR-09').status, 'evaluated');
});

test('取消词生效可观测：evidence.cancelled_by 记录机制，与句读边界命中可区分', () => {
  const byCanceller = runRules(makeInput({ text: '不要单独用而要混配' }));
  const cancellerEntry = byCanceller.rules.find((item) => item.id === 'MR-01');
  assert.equal(cancellerEntry.status, 'hit');
  assert.equal(cancellerEntry.evidence.cancelled, 1);
  assert.equal(typeof cancellerEntry.evidence.cancelled_by, 'string');
  assert.ok(DANGEROUS_NEGATION_CANCELLERS.includes(cancellerEntry.evidence.cancelled_by));

  const byBoundary = runRules(makeInput({ text: '不要单独用，要混配' }));
  const boundaryEntry = byBoundary.rules.find((item) => item.id === 'MR-01');
  assert.equal(boundaryEntry.status, 'hit');
  assert.equal(boundaryEntry.evidence.cancelled, 0);
  assert.equal(boundaryEntry.evidence.cancelled_by, null);
});

test('确定性口径：内容判定逐字节可复现（本目录统一注入冻结时钟，墙钟不再是变量）', () => {
  // 判定字段必须逐字节可复现。本目录的规则层调用统一走 `runRules`（注入 `FROZEN_CLOCK`），
  // 因此连 `budget.elapsed_ms` 都是确定值；这里仍按原口径把墙钟诊断字段剔除后再逐字节比对，
  // 这样即使将来有人改回真实时钟，这条用例依旧成立。
  const stripClock = (result) => {
    const { budget, ...rest } = result;
    return { ...rest, budget: { ms: budget.ms, exhausted: budget.exhausted } };
  };
  assert.equal(typeof stripClock(runRules(makeInput())).budget.elapsed_ms, 'undefined');
  for (const fixture of NEGATION_CANCELLATION_FIXTURES) {
    const input = () => makeInput({ text: fixture.text });
    const first = JSON.stringify(stripClock(runRules(input())));
    for (let round = 0; round < 10; round += 1) {
      assert.equal(
        JSON.stringify(stripClock(runRules(input()))),
        first,
        `${fixture.name} 第 ${round} 次求值不一致`,
      );
    }
  }
});

test('时钟口径：默认预算值仍被断言，且内容用例一律不得裸调用引擎（防墙钟抖动回归）', () => {
  // 1) 默认预算值本身被**显式**断言（此前只是隐含：靠"机器别太慢"来保证内容用例能通过）。
  //    这里是 50ms 的墙钟预算——正是"并行跑整套 test:unit 时偶发假失败"的根源，所以把它钉在断言里。
  const baseline = runRules(makeInput({ text: CLEAN_TEXT }));
  assert.equal(typeof DEFAULT_RULE_BUDGET_MS, 'number');
  assert.equal(baseline.budget.ms, DEFAULT_RULE_BUDGET_MS, '夹具不得偷偷改默认预算');
  assert.equal(baseline.decision, 'approved');
  assert.equal(baseline.counts.timeouts, 0, '冻结时钟下超时闸门不可能被触发');

  // 2) 结构性防回归：本目录**不得**再出现裸的规则层入口调用。
  //    裸调用 = 用真实 `Date.now` 跑墙钟预算 ⇒ 内容用例会在负载下随机变成 `quarantined`（RULE_TIMEOUT）。
  //    需要时间语义的用例请显式注入 `clock`（`fail-closed.test.mjs` 已这么做）。
  const here = dirname(fileURLToPath(import.meta.url));
  // 用拼接构造被扫描的字面量，避免本用例自己把自己算作"裸调用"。
  const bareEntries = ['evaluateHardRules', 'evaluateBatch', 'evaluateTarget', 'makeQuarantineResult'].map(
    (name) => `${name}(`,
  );
  const offenders = [];
  for (const name of readdirSync(here).filter((item) => item.endsWith('.test.mjs')).sort()) {
    const text = readFileSync(join(here, name), 'utf8');
    for (const bare of bareEntries) {
      if (text.includes(bare)) offenders.push(`${name} :: ${bare}`);
    }
  }
  assert.deepEqual(offenders, [], '规则层调用必须走 runRules/runBatch（冻结时钟），否则内容用例会重新依赖真实墙钟');
});

test('冻结时钟可机械证明：走夹具的内容判定一次都不读真实墙钟', () => {
  // 这不是"相信它不会超时"，而是**机械证明**：把 `Date.now` 换成计数器，
  // 跑一遍内容判定后计数器必须为 0——引擎在注入时钟后不再触碰真实墙钟，
  // 因此任何真实调度停顿／GC／IO 抖动都不可能改变这条内容判定的结论。
  const original = Date.now;
  let wallClockReads = 0;
  Date.now = () => {
    wallClockReads += 1;
    return original();
  };
  let result;
  try {
    result = runRules(makeInput({ text: CLEAN_TEXT }));
  } finally {
    Date.now = original;
  }
  assert.equal(wallClockReads, 0, '注入时钟后引擎仍读了真实墙钟 ⇒ 内容判定会重新受负载影响');
  assert.equal(result.decision, 'approved');
  assert.equal(result.counts.timeouts, 0);
  assert.equal(Date.now, original, '必须还原全局 Date.now');
});

test('命中证据只含偏移，不含命中原文（隐私红线：正文不得回传）', () => {
  const sensitive = [
    { text: '有事打我电话 13812345678，或者晚上再联系。', secret: '13812345678' },
    { text: '我家住浙江省杭州市余杭区径山镇双溪村3组12号，欢迎来玩。', secret: '双溪村3组12号' },
    { text: '我的地块坐标 30.274158,120.155070，就在村口那片。', secret: '30.274158' },
  ];
  for (const item of sensitive) {
    const result = runRules(makeInput({ text: item.text }));
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(item.secret), false, `结果里泄漏了命中原文：${item.secret}`);
    assert.equal(serialized.includes(item.text), false, '结果里不得回传输入正文');
    for (const entry of result.rules) {
      if (entry.status !== 'hit') continue;
      assert.equal(typeof entry.evidence.offset, 'number');
      assert.equal(typeof entry.evidence.length, 'number');
      assert.equal('text' in entry.evidence, false);
    }
  }
});

test('同一文本重复求值结果完全一致（确定性，无随机、无状态）', () => {
  for (const fixture of RULE_TEXT_FIXTURES) {
    const first = runRules(makeInput({ text: fixture.hit }));
    const second = runRules(makeInput({ text: fixture.hit }));
    assert.equal(first.decision, second.decision);
    assert.deepEqual(first.reason_codes, second.reason_codes);
    assert.equal(first.rule_version, second.rule_version);
    assert.deepEqual(
      first.rules.map((item) => [item.id, item.status]),
      second.rules.map((item) => [item.id, item.status]),
    );
  }
});

test('规则集里没有带 g/y 标志的模式（有状态会破坏确定性）', () => {
  for (const rule of RULES) {
    for (const pattern of rule.patterns ?? []) {
      assert.equal(pattern.flags.includes('g'), false, `${rule.id} 带 g 标志`);
      assert.equal(pattern.flags.includes('y'), false, `${rule.id} 带 y 标志`);
    }
  }
});

test('多条规则同时命中时 reason_codes 仍不超过契约上限 30 且全部落在闭集', () => {
  const combined = RULE_TEXT_FIXTURES.map((item) => item.hit).join('');
  const result = runRules(makeInput({ text: combined }));
  assert.equal(isAuditState(result.decision), true);
  assert.equal(result.decision, 'rejected');
  assert.ok(result.reason_codes.length <= 30);
  for (const code of result.reason_codes) {
    assert.equal(typeof code, 'string');
    assert.ok(code.length >= 1 && code.length <= 80);
  }
});
