/**
 * GY-I14 确定性硬规则审核层 · 失败隔离验收（派单 §4.3）。
 *
 * 两条硬要求：
 *   1) 单条规则抛错 ⇒ 该规则计入"未求值/失败"，整体不得通过，且**不得**吞成"未命中"；
 *   2) 批量审核时，一条异常**不得**影响其它目标的判定结果（各自独立）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MATCHERS } from '../../packages/moderation/matchers.mjs';
import { RULES } from '../../packages/moderation/rules.mjs';
import {
  CLEAN_TEXT,
  makeInput,
  runBatch,
  runRules,
  withThrowingGetter,
  withThrowingOwnKeys,
} from './_fixtures.mjs';

const PRIVACY_TEXT = '有事打我电话 13812345678，或者晚上再联系。';

function compareVerdict(a, b, name) {
  assert.equal(a.decision, b.decision, `${name}: decision 被污染`);
  assert.equal(a.hard_rule_passed, b.hard_rule_passed, `${name}: hard_rule_passed 被污染`);
  assert.deepEqual(a.reason_codes, b.reason_codes, `${name}: reason_codes 被污染`);
  assert.deepEqual(
    a.rules.map((item) => [item.id, item.status]),
    b.rules.map((item) => [item.id, item.status]),
    `${name}: 逐规则状态被污染`,
  );
}

test('批量审核：中间一条输入读失败，前后两条判定完全不受影响', () => {
  const clean = makeInput({ text: CLEAN_TEXT });
  const privacy = makeInput({ text: PRIVACY_TEXT });
  const batch = runBatch([clean, withThrowingGetter('text'), privacy]);

  assert.equal(batch.batch_size, 3);
  assert.deepEqual(batch.results.map((item) => item.index), [0, 1, 2]);
  assert.equal(batch.results[0].decision, 'approved');
  assert.equal(batch.results[1].decision, 'quarantined');
  assert.ok(batch.results[1].reason_codes.includes('INPUT_READ_FAILED'));
  assert.equal(batch.results[2].decision, 'rejected');
  assert.ok(batch.results[2].reason_codes.includes('PRIVACY_PII'));
  assert.notEqual(batch.results[2].decision, 'approved');

  // 与单独求值逐字段对齐：批量没有污染任何一条。
  compareVerdict(batch.results[0], runRules(clean), '第 1 条');
  compareVerdict(batch.results[2], runRules(privacy), '第 3 条');
  assert.equal(batch.summary.approved, 1);
  assert.equal(batch.summary.rejected, 1);
  assert.equal(batch.summary.quarantined, 1);
});

test('批量审核：引擎级抛出（ownKeys 陷阱）被隔离为该条失败，其它目标不受影响', () => {
  const clean = makeInput({ text: CLEAN_TEXT });
  const batch = runBatch([clean, withThrowingOwnKeys(), clean]);

  assert.equal(batch.batch_size, 3);
  assert.equal(batch.results[1].decision, 'quarantined');
  assert.ok(batch.results[1].reason_codes.includes('RULE_ENGINE_ERROR'));
  assert.equal(batch.results[1].hard_rule_passed, false);
  assert.equal(batch.results[1].engine_error, 'Error');
  assert.equal(batch.results[0].decision, 'approved');
  assert.equal(batch.results[2].decision, 'approved');
  compareVerdict(batch.results[0], batch.results[2], '两条干净目标');
});

test('批量审核：单条规则抛错只影响该规则的求值，不影响批内其它目标', () => {
  const explodingRule = {
    id: 'MR-92',
    category: 'privacy',
    reason_code: 'PRIVACY_PII',
    title: '抛错规则',
    description: '仅用于批量隔离用例',
    severity: 'block',
    matcher: 'any_pattern',
    patterns: [/苗/],
  };
  const options = {
    rules: [...RULES, explodingRule],
    matchers: {
      ...MATCHERS,
      any_pattern: (text, rule) => {
        if (rule.id === 'MR-92') throw new Error('boom: MR-92');
        return MATCHERS.any_pattern(text, rule);
      },
    },
  };
  const clean = makeInput({ text: CLEAN_TEXT });
  const privacy = makeInput({ text: PRIVACY_TEXT });
  const batch = runBatch([clean, privacy], options);

  assert.equal(batch.results[0].decision, 'quarantined', '有规则未求值，干净文本也不得通过');
  assert.ok(batch.results[0].reason_codes.includes('RULE_ENGINE_ERROR'));
  const failed = batch.results[0].rules.find((item) => item.id === 'MR-92');
  assert.equal(failed.status, 'error');
  assert.equal(failed.matched, false);
  // 另一条目标仍然照常给出自己的命中结论（隐私命中照拦）。
  assert.equal(batch.results[1].decision, 'quarantined');
  assert.ok(batch.results[1].reason_codes.includes('PRIVACY_PII'));
  assert.ok(batch.results[1].reason_codes.includes('RULE_ENGINE_ERROR'));
});

test('批量审核：输入不是数组时返回空批次而不是抛错或放行', () => {
  const batch = runBatch(undefined);
  assert.equal(batch.batch_size, 0);
  assert.equal(batch.input_was_array, false);
  assert.deepEqual(batch.results, []);
  const batch2 = runBatch(null);
  assert.equal(batch2.batch_size, 0);
});

test('失败隔离不影响确定性：同一批重复跑得到同一组判定', () => {
  const items = [makeInput({ text: CLEAN_TEXT }), withThrowingGetter('text'), makeInput({ text: PRIVACY_TEXT })];
  const first = runBatch(items);
  const second = runBatch(items);
  assert.deepEqual(
    first.results.map((item) => [item.decision, item.reason_codes]),
    second.results.map((item) => [item.decision, item.reason_codes]),
  );
});
