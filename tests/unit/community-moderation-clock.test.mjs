// GY-I14（#14）· 审核域「规则预算 50ms + 真实时钟」的**确定性**回归。
//
// 背景：规则层默认预算是 50ms 的**墙钟**预算（`DEFAULT_RULE_BUDGET_MS`；
// `packages/moderation/engine.mjs:373` 在每条规则开始前比较 `now - started > budgetMs`），
// 预算耗尽 ⇒ `RULE_TIMEOUT` ⇒ `quarantined` —— fail-closed 口径**一字未改**。机器一忙，
// "扫一遍规则"本身就吃掉 50ms，内容用例于是随机变红（把机器速度变成了测试结果）。
// 修法只加"可注入时钟"（注入缝：`services/api/src/app.ts` 的 `moderationInjection.ruleOptions`
// 与 `services/api/src/moderation/service.ts:139` 既有的 `ruleOptions`），预算与判定一行未动。
//
// 本文件把**语义**留在覆盖内（范式同 `tests/unit/community-gate.test.mjs:277-309`）：
//   1) 真实墙钟 + 同步忙等 >50ms 的匹配器 ⇒ 必然 `RULE_TIMEOUT` ⇒ `quarantined`（不得发布）；
//      同一个慢匹配器 + 冻结时钟 ⇒ 规则逐条求值完 ⇒ `approved`；
//   2) 脚本时钟跳出预算窗口（与机器负载无关）⇒ 同样 `quarantined`，且这条用例走的是
//      `moderationInjection.ruleOptions` → `createModerationService({ ruleOptions })` 这条注入缝
//      （不注入 service，由 `app.ts` 自建审核域）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLEAN_BODY, FROZEN_CLOCK, USER_A } from './community-fixtures.mjs';
import { makeHarness, makeWiredHarness, passingPort } from './community-moderation-fixtures.mjs';
import { scriptedClock } from '../moderation/_fixtures.mjs';
import { DEFAULT_RULE_BUDGET_MS, MATCHERS } from '../../packages/moderation/index.mjs';

const TARGET_ID = '7f3c1d20-8a4b-4c3d-9e2f-1a0b2c3d4e5f';

/** 送审内容：干净正文 + 合成目标（不建社区内容行，只走审核域的送审口）。 */
const CONTENT = Object.freeze({
  target_ref: { type: 'post', id: TARGET_ID, revision: 1 },
  text: CLEAN_BODY,
  media: [],
});

/** 同步忙等 60ms 的匹配器：确定性制造"规则求值本身占用 >50ms 墙钟"的场景。 */
function busyMatcher() {
  const deadline = Date.now() + 60;
  while (Date.now() < deadline) {
    // 忙等：占用的是**这一条规则**的墙钟（睡眠会让出控制权，测不到预算语义）。
  }
  return { matched: false, offset: null, length: 0 };
}

/** 只把 MR-01／02／07 依赖的那个匹配器换慢（不改 `packages/moderation` 一行）。 */
const SLOW_MATCHERS = { ...MATCHERS, negation_guarded_pattern: busyMatcher };

test('确定性：真实时钟下规则预算必然耗尽 ⇒ quarantined；冻结时钟下同一慢匹配器 approved', async () => {
  // 默认预算不得放大：本用例两条腿都**不传** `budget_ms`（走默认 50ms）。
  assert.equal(DEFAULT_RULE_BUDGET_MS, 50, '默认规则预算仍是 50ms');

  // ① 真实墙钟（只注入慢匹配器，不注入 clock）⇒ 忙等 60ms > 默认 50ms。
  const real = makeWiredHarness({ ports: { tms: passingPort() }, ruleOptions: { matchers: SLOW_MATCHERS } });
  const realOutcome = await real.moderation.submitScreening({ actor: USER_A, content: CONTENT });
  assert.equal(realOutcome.overall.decision, 'quarantined', '预算耗尽绝不放行（"没跑"不等于"通过"）');
  assert.equal(realOutcome.overall.publishable, false, '预算耗尽绝不可发布');
  assert.ok(realOutcome.overall.reason_codes.includes('RULE_TIMEOUT'), `实际 ${realOutcome.overall.reason_codes}`);

  // ② 同一个慢匹配器 + 冻结时钟（夹具默认口径）⇒ 规则逐条求值完 ⇒ approved。
  const frozen = makeWiredHarness({
    ports: { tms: passingPort() },
    ruleOptions: { clock: FROZEN_CLOCK, matchers: SLOW_MATCHERS },
  });
  const frozenOutcome = await frozen.moderation.submitScreening({ actor: USER_A, content: CONTENT });
  assert.equal(frozenOutcome.overall.decision, 'approved', '冻结时钟下规则全部求值完 ⇒ 可通过');
  assert.equal(frozenOutcome.overall.publishable, true);
  assert.deepEqual(frozenOutcome.overall.reason_codes, [], '全部求值且未命中 ⇒ 无原因码');
});

test('注入缝：脚本时钟跳出预算窗口 ⇒ 送审 quarantined + RULE_TIMEOUT（与机器负载无关）', async () => {
  // 这条**不注入 service**：审核域由 `app.ts` 用 `moderationInjection.ruleOptions` 自建 ——
  // 因此它同时证明"注入缝真的下传到规则层"（把 app.ts 的下传删掉 ⇒ 时钟不生效 ⇒ 真实墙钟下
  // 干净正文会被判通过 ⇒ 本用例变红）。
  const h = makeHarness({
    ports: { tms: passingPort() },
    ruleOptions: { budget_ms: 50, clock: scriptedClock([0, 1000, 1000]) },
  });
  const outcome = await h.moderation.submitScreening({ actor: USER_A, content: CONTENT });
  assert.equal(outcome.overall.decision, 'quarantined', '规则未求值不得判通过');
  assert.equal(outcome.overall.publishable, false);
  assert.ok(outcome.overall.reason_codes.includes('RULE_TIMEOUT'), `实际 ${outcome.overall.reason_codes}`);
});
