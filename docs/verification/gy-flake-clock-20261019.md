# GY-FLAKE：规则预算 50ms 用例注入冻结时钟（消除偶发假红）

Refs #22（GY-FLAKE-DIAG 的实施页）。**只补「可注入时钟」，不改产品语义**：默认 `budget_ms` 仍是 50、
fail-closed（超时 ⇒ `quarantined`）一行未改、既有断言一条未删、未加 skip/todo、未调大默认预算。

- 改动基线：`d131e473409d1d41236468ec49208a73f57bd7e4`（= `upstream/main`）
- 分支／工作树：`test/gy-flake-clock-injection` @ `.pg17/wt-flake-fix`（`node_modules` 为本树内真实目录，非目录联接）
- 唯一依据：`.pg17/analysis/flake-diag-20261019.md`（§0 结论、§C2 四处组装点、§D1 修法清单、§D2 验证矩阵）
- 本页随改动同一提交交付：提交 sha 见 `git log -1 --format=%H`；交接文件 `.pg17/handoff/flake-clock-<sha>.md` 记录了实际值
- 本页读数全部来自本机实跑；未跑到的如实登记在 §4「未取得」

## 1 根因摘要

**机制**：`packages/moderation/engine.mjs` 的规则预算是**墙钟**预算，只在每条规则**开始前**比较一次
`now - started > budgetMs`（`:373`，`:362` 取值，`:319` 的 `clock = options.clock ?? Date.now`）。
默认预算 `DEFAULT_RULE_BUDGET_MS = 50`（`packages/moderation/constants.mjs:223`）。任何 **>50ms 的调度停顿**
落在"最后一次规则起点之前"，就把结论从 `approved`／`rejected` 翻成 `quarantined(RULE_TIMEOUT)`，
社区侧再映射成 422 `INPUT_UNCERTAIN`。

**触发链**：`tests/unit/*.test.mjs` 并行跑整套时，机器负载 ⇒ 单次规则层调用落入 50ms 停顿的概率约 `1.4e-4`
（诊断 §B3 实测），"危险用法"单轮约 56 次规则层调用 ⇒ 几十轮内偶发一次红。诊断 §A1 用 576 轮
（含 32 燃烧器 / 16 worker 重载臂）**0 命中**，机制复现（单点 90ms 停顿）则 **100% 必红** ⇒ 属"把机器速度
变成了测试结果"，不是产品缺陷。

**产品侧不是缺陷**（诊断 §C1）：契约要求「AI 超时/异常/不明为 quarantined，没有人审放行兜底」
（`docs/architecture/state-contract.md:95`）。生产装配**必须**用真实墙钟，因此修法只能是"给测试加可注入时钟"，
⛔ 不能改默认预算或放宽超时。

**缺陷在测试装配**：四处组装点没注入可控时钟（诊断 §C2 表 1–4），且产品注入缝缺 `clock`／`budget_ms`
（`conversations/screen.ts` 的 `RiskScreenDeps` 只有 `rules?`；`app.ts` 的 `moderationInjection` 没有 `ruleOptions`）。

## 2 改动（6 处；2 产品注入缝 + 4 测试侧；默认行为逐字不变）

### 2.1 产品注入缝（**只有可选参数**，未注入路径与改动前等价）

**`services/api/src/conversations/screen.ts`**（+25 −1）

```ts
// :96 RiskScreenDeps
  clock?: () => number;      // :105  缺省 ⇒ 规则层沿用自带 Date.now
  budget_ms?: number;        // :112  缺省 ⇒ 规则层沿用 DEFAULT_RULE_BUDGET_MS
// :158
  const clock = deps.clock;
  const budgetMs = deps.budget_ms;
// :176 规则层调用
  {
    rules: [...rules],
    ...(clock === undefined ? {} : { clock }),
    ...(budgetMs === undefined ? {} : { budget_ms: budgetMs }),
  }
```

**`services/api/src/app.ts`**（+7 −0）

```ts
// :402 moderationInjection
    ruleOptions?: Record<string, unknown>;
// :781 createModerationService({...}) 实参尾部
      ...(moderationInjection?.ruleOptions === undefined
        ? {}
        : { ruleOptions: moderationInjection.ruleOptions }),
```

> `ruleOptions` 在服务层**本来就存在**（`services/api/src/moderation/service.ts:139`
> `ruleOptions?: Record<string, unknown>`，`:390` `const ruleOptions = deps.ruleOptions ?? {}`，`:536-552`
> 原样交给 `evaluateBoundHardRules`），所以产品侧的缝只是把 `app.ts` 的这一个键**下传**，没有新增语义分支。

**「未注入路径 diff 为空」的说明**：
1. 两个新字段都用**条件展开**（`...(x === undefined ? {} : { x })`），未注入时对象里**不出现该键** ——
   规则层收到的仍是 `{ rules: [...] }`，与基线 `screen.ts:155-158` 的实参逐字相同；
2. 缺省兜底在引擎侧本来就是 `??`（`engine.mjs:319` `clock = options.clock ?? Date.now`、`:320`
   `budgetMs = options.budget_ms ?? DEFAULT_RULE_BUDGET_MS`），因此"键不存在"与"值 undefined"同义；
3. 机械读数（§3.4）：不传 deps 构造 `createModerationRiskScreen()` ⇒ 规则层**仍读真实墙钟**
   （`wallClockReads: 7`），`DEFAULT_RULE_BUDGET_MS` 仍是 `50`，`{}` 与不传的输出 `deepEqual`；
4. 生产装配未传 `ruleOptions`（`grep` 全仓：仅 `tests/**` 传入）⇒ 生产路径零变化。

### 2.2 测试侧（4 处；只换时钟来源，断言一条未删）

| 文件 | 改动 | 行锚 |
|---|---|---|
| `tests/unit/community-moderation-fixtures.mjs` | 新增 `FROZEN_RULE_OPTIONS = { clock: FROZEN_CLOCK, budget_ms: RULE_BUDGET_MS }`（`RULE_BUDGET_MS = 5000` 取自 `tests/moderation/_model-fixtures.mjs:26`，与既有做法同构）；`moderationInjection`、`makeWiredHarness`、`makeServiceHarness` 三处 **均**加 `ruleOptions: options.ruleOptions ?? FROZEN_RULE_OPTIONS` | `:26-27` `:43` `:236` `:392` `:427` |
| `tests/unit/conversation-fixtures.mjs` | `FROZEN_CLOCK = () => 0`；`conversationInjection` 默认 `riskScreen: createModerationRiskScreen({ clock: FROZEN_CLOCK })`，`options.injection` 仍在后（单例可覆盖） | `:20` `:86` `:292` |
| `tests/unit/conversation-risk-screen.test.mjs` | `FROZEN_RISK_DEPS = { clock: FROZEN_CLOCK }`；**7 处**端口构造改传它；`:211` 直调引擎补 `clock: FROZEN_CLOCK` | `:176` `:186/222/248/262/275/295/319` `:211` |
| `tests/unit/community-moderation-clock.test.mjs`（新增） | 「语义仍在」对照用例 ×2（§2.3） | 全文件 78 行 |

### 2.3 新增对照用例（照 `tests/unit/community-gate.test.mjs:277-309` 与 `tests/moderation/rules.test.mjs:190-205` 的范式）

`tests/unit/community-moderation-clock.test.mjs`：

1. **「确定性：真实时钟下规则预算必然耗尽 ⇒ quarantined；冻结时钟下同一慢匹配器 approved」**
   - 先把 `negation_guarded_pattern` 换成**同步忙等 60ms** 的匹配器（不改 `packages/moderation` 一行）；
   - 腿 ①：只注入 `matchers`（不注入 `clock`、不注入 `budget_ms`）⇒ 真实墙钟 + 默认 50ms ⇒
     必须 `quarantined` + `publishable === false` + `reason_codes` 含 `RULE_TIMEOUT`；
   - 腿 ②：同一慢匹配器 + `clock: FROZEN_CLOCK` ⇒ `approved` + `publishable === true` + `reason_codes` 为空；
   - 开头钉住 `assert.equal(DEFAULT_RULE_BUDGET_MS, 50)`（默认预算不得被本用例放大）。
2. **「注入缝：脚本时钟跳出预算窗口 ⇒ 送审 quarantined + RULE_TIMEOUT（与机器负载无关）」**
   - **不注入 service**，由 `app.ts` 用 `moderationInjection.ruleOptions` 自建审核域 ⇒
     `{ budget_ms: 50, clock: scriptedClock([0, 1000, 1000]) }` 必须 `quarantined` + `publishable === false`
     + 含 `RULE_TIMEOUT`。这条同时证明"缝真的下传到规则层"（删掉 `app.ts` 的下传 ⇒ 时钟不生效 ⇒ 变红）。

## 3 探针（三条变异 + 一条等价性探针；全部实跑，逐字读数）

### 3.1 探针 ①：把冻结时钟改回真实时钟 ⇒ 必须红

```powershell
# 变异：tests/unit/community-fixtures.mjs:59  FROZEN_CLOCK = () => 0;  →  () => Date.now();
node --test tests/unit/community-moderation-clock.test.mjs
```

```
✖ 确定性：真实时钟下规则预算必然耗尽 ⇒ quarantined；冻结时钟下同一慢匹配器 approved (197.6779ms)
✔ 注入缝：脚本时钟跳出预算窗口 ⇒ 送审 quarantined + RULE_TIMEOUT（与机器负载无关） (7.1621ms)
ℹ tests 2 / ℹ pass 1 / ℹ fail 1
  AssertionError [ERR_ASSERTION]: 冻结时钟下规则全部求值完 ⇒ 可通过
  + 'quarantined'
  - 'approved'
      at TestContext.<anonymous> (file:///E:/GengYunCommander/.pg17/wt-flake-fix/tests/unit/community-moderation-clock.test.mjs:61:10)
```

⇒ **红**（腿 ② 翻成 `quarantined`）。已 `git checkout -- tests/unit/community-fixtures.mjs` 复原。

### 3.2 探针 ②：把 fail-closed 改成放行 ⇒ 必须红

```powershell
# 变异：packages/moderation/engine.mjs:375 删掉 failClosed.push('RULE_TIMEOUT');
node --test tests/unit/community-moderation-clock.test.mjs
```

```
✖ 确定性：…（126.2433ms）
✖ 注入缝：…（9.2207ms）
ℹ tests 2 / ℹ pass 0 / ℹ fail 2
  AssertionError [ERR_ASSERTION]: 实际 ENGINE_INVARIANT_VIOLATION
      at TestContext.<anonymous> (file:///E:/GengYunCommander/.pg17/wt-flake-fix/tests/unit/community-moderation-clock.test.mjs:53:10)
```

⇒ **两例全红**。额外收获：光删原因码不做别的，引擎自带的判定不变式
（`approved ⟺ hard_rule_passed === true`，`engine.mjs:254`）会把它抓成 `ENGINE_INVARIANT_VIOLATION`
（`guardInvariant`，`:283-298`）—— 这条变异**连"假绿"都制造不出来**。已 `git checkout -- packages/moderation/engine.mjs` 复原。

### 3.3 探针 ③：把默认预算改成 5000 ⇒ 「真实时钟必红」对照用例必须红

```powershell
# 变异：packages/moderation/constants.mjs:223  DEFAULT_RULE_BUDGET_MS = 50;  →  5000;
node --test tests/unit/community-moderation-clock.test.mjs
node .pg17/tmp/flake-fix-writer/probe3-budget.mjs     # 行为级读数（脚本已删，全文见附录 A）
```

```
✖ 确定性：真实时钟下规则预算必然耗尽 ⇒ quarantined；冻结时钟下同一慢匹配器 approved (1.1597ms)
  AssertionError [ERR_ASSERTION]: 默认规则预算仍是 50ms

  5000 !== 50
ℹ tests 2 / ℹ pass 1 / ℹ fail 1
```

```
{"DEFAULT_RULE_BUDGET_MS":5000,"decision":"approved","reason_codes":[]}
AssertionError [ERR_ASSERTION]: 真实时钟 + 60ms 忙等 + 默认预算 ⇒ 必须 quarantined
+ 'approved'
- 'quarantined'
    at file:///E:/GengYunCommander/.pg17/wt-flake-fix/.pg17/tmp/flake-fix-writer/probe3-budget.mjs:26:8
```

⇒ **红两处**：常量守卫先红（`5000 !== 50`），行为级读数同步从 `quarantined` 翻成 `approved`（预算被放大后
60ms 忙等不再超时）—— 即"真实时钟必红"的对照逻辑确实依赖默认 50ms。基线同脚本读数：
`{"DEFAULT_RULE_BUDGET_MS":50,"decision":"quarantined","reason_codes":["RULE_TIMEOUT"]}` ⇒ `PROBE3_OK`。
已 `git checkout -- packages/moderation/constants.mjs` 复原（`git status --porcelain` 复核：仅 5 改 + 1 新）。

### 3.4 等价性探针：未注入路径与改动前等价

`.pg17/tmp/flake-fix-writer/probe-default-path.mjs`（临时物，本轮结束已删除、全文见附录 A；复跑须按附录 A 落回同一路径）：

```powershell
node .pg17/tmp/flake-fix-writer/probe-default-path.mjs
```

```
{"probe":"no-deps","decision":"approved","wallClockReads":7}
{"probe":"empty-vs-absent","equal":true,"rule_version":"mr1+sha256:c6e81c94497ee5a278a0e19553d5b8db"}
{"probe":"frozen-clock","decision":"approved","wallClockReads":0}
{"probe":"default-budget","DEFAULT_RULE_BUDGET_MS":50}
```

读法：不传 deps ⇒ 规则层**仍读真实墙钟**（7 次）、判定仍 `approved`；`{}` 与不传**输出完全相同**；
注入 `clock` 后墙钟读取 **0 次**（时钟确实被规则层采用）且干净文本判定不变；默认预算仍 `50`。

## 4 读数（门禁逐字）

| 门禁 | 命令 | 逐字读数 |
|---|---|---|
| 新用例 | `node --test tests/unit/community-moderation-clock.test.mjs` | `tests 2 / pass 2 / fail 0 / skipped 0 / todo 0`，`duration_ms 1141.3538` |
| 单测全量 | `node --test "tests/unit/*.test.mjs"` | `tests 1700 / pass 1699 / fail 0 / cancelled 0 / skipped 1 / todo 0`，`duration_ms 49861.6083` |
| 审核域 | `node --test "tests/moderation/*.test.mjs"` | `tests 302 / pass 302 / fail 0 / skipped 0 / todo 0`，`duration_ms 1319.9949` |
| 社区族 | `node --test "tests/unit/community-*.test.mjs"` | `tests 103 / pass 103 / fail 0 / skipped 0 / todo 0`，`duration_ms 2617.285` |
| 类型 | `npx tsc -p services/api/tsconfig.json --noEmit` | 无输出，`TSC_EXIT=0` |
| 契约状态 | `node tools/verify-contract-status.mjs` | `PASS: 覆盖 112 条契约操作；已装配 108 条；implemented 13 / partial 95 / planned 4；横切维度 8 条；形状错误 0 项；语义错误 0 项` / `PASS: 语义可核 59 条区间 + 0 条片段；不可核 134 条区间 + 131 条片段（不可核不计入通过）` / `PASS: 中文表格一致` / `PASS: 状态为人工判定；…`，`EXIT=0` |
| 契约状态（运行时） | `node tools/verify-contract-status.mjs --runtime` | 同上四行 + `PASS: 无凭据 stub 子进程中的实际 Fastify 产品装配与静态扫描、对照表一致（不监听 / 不请求服务）。`，`EXIT=0` |
| 开发文档 | `python -B tools/validate_development_docs.py` | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables`，`EXIT=0` |
| 空白/冲突 | `git diff HEAD --check` | 无输出，`CHECK_EXIT=0` |
| 工作树 | `git status --porcelain` | `M services/api/src/app.ts` / `M services/api/src/conversations/screen.ts` / `M tests/unit/community-moderation-fixtures.mjs` / `M tests/unit/conversation-fixtures.mjs` / `M tests/unit/conversation-risk-screen.test.mjs` / `?? tests/unit/community-moderation-clock.test.mjs`（提交前）；提交后为 **0 行**（探针脚本已删除，全文见附录 A）。`git show --stat HEAD`：7 files changed, 455 insertions(+), 13 deletions(-) |

**单测 1 项 skipped 的出处**：`tests/unit/knowledge-api.test.mjs:102` `{skip:!f.native}`（需原生 PG 连接，
环境相关、与本次改动无关；基线 `upstream/main` 的完整基线跑同样是 `skipped 1`，诊断 §A1 记录
`tests 2661 / pass 2660 / fail 0 / skipped 1`）。

### 未取得

- `node tests/integration/community-http.test.mjs`：**该文件在本树不存在**（`MODULE_NOT_FOUND`，
  `tests/integration/` 下只有 `account-deletion-http.mjs`、`admin-http.mjs`、`favorites-history-isolation-http.mjs`
  等 `*.mjs`，无 `community-http.test.mjs`）。社区/审核域 HTTP 覆盖改由 `tests/moderation/http-*.test.mjs`
  （`http-screening` / `http-isolation` / `http-callback` 等，已随 `tests/moderation/*.test.mjs` 302/302 全绿）承担。
- 诊断 §D3 的暴露面文件（`tests/unit/community-http.test.mjs`、`gy-i22-*`、`admin-flag-gate.test.mjs`）**本次未逐条注入**：
  它们与 `tests/unit/community-*.test.mjs` 同族且已全绿，但**在强制停顿臂下仍会红**是既有已知暴露面（诊断 D3 已登记），
  不属本片"最小修法 D"范围。未在本轮做强制停顿复验（未取得）。
- 未 push、未开 PR、未评论（按派单约束）。

## 附录 A：临时探针脚本（不提交；临时目录已删除，全文如下）

`probe-default-path.mjs`：

```js
import assert from 'node:assert/strict';
import { createModerationRiskScreen } from '../../../services/api/src/conversations/screen.ts';

const CLEAN = '今年雨水偏多，我按标签说明选择登记药剂，先看苗情再决定，注意轮换。';

function countClock(fn) {
  const real = Date.now;
  let reads = 0;
  Date.now = () => { reads += 1; return real(); };
  try { return { value: fn(), reads: () => reads }; } finally { Date.now = real; }
}

const plain = countClock(() => createModerationRiskScreen().screenQuestion({ turnId: 't1', text: CLEAN }));
assert.equal(plain.value.decision, 'approved');
assert.equal(plain.value.blocked, false);
console.log(JSON.stringify({ probe: 'no-deps', decision: plain.value.decision, wallClockReads: plain.reads() }));
assert.ok(plain.reads() > 0, '未注入时规则层必须读真实墙钟（否则说明默认路径被改了）');

const a = createModerationRiskScreen().screenQuestion({ turnId: 't1', text: CLEAN });
const b = createModerationRiskScreen({}).screenQuestion({ turnId: 't1', text: CLEAN });
assert.deepEqual(b, a);
console.log(JSON.stringify({ probe: 'empty-vs-absent', equal: true, rule_version: a.rule_version }));

const frozen = countClock(() => createModerationRiskScreen({ clock: () => 0 }).screenQuestion({ turnId: 't1', text: CLEAN }));
assert.equal(frozen.value.decision, 'approved');
assert.equal(frozen.reads(), 0, '注入冻结时钟后引擎仍读墙钟 ⇒ 注入无效');
console.log(JSON.stringify({ probe: 'frozen-clock', decision: frozen.value.decision, wallClockReads: frozen.reads() }));

const { DEFAULT_RULE_BUDGET_MS } = await import('../../../packages/moderation/index.mjs');
assert.equal(DEFAULT_RULE_BUDGET_MS, 50);
console.log(JSON.stringify({ probe: 'default-budget', DEFAULT_RULE_BUDGET_MS }));
```

`probe3-budget.mjs`（探针 ③ 的行为级读数）：

```js
import assert from 'node:assert/strict';
import { CLEAN_BODY, USER_A } from '../../../tests/unit/community-fixtures.mjs';
import { makeWiredHarness, passingPort } from '../../../tests/unit/community-moderation-fixtures.mjs';
import { DEFAULT_RULE_BUDGET_MS, MATCHERS } from '../../../packages/moderation/index.mjs';

function busyMatcher() {
  const deadline = Date.now() + 60;
  while (Date.now() < deadline) { /* 忙等 60ms */ }
  return { matched: false, offset: null, length: 0 };
}

const h = makeWiredHarness({
  ports: { tms: passingPort() },
  ruleOptions: { matchers: { ...MATCHERS, negation_guarded_pattern: busyMatcher } },
});
const outcome = await h.moderation.submitScreening({
  actor: USER_A,
  content: { target_ref: { type: 'post', id: '7f3c1d20-8a4b-4c3d-9e2f-1a0b2c3d4e5f', revision: 1 }, text: CLEAN_BODY, media: [] },
});
console.log(JSON.stringify({ DEFAULT_RULE_BUDGET_MS, decision: outcome.overall.decision, reason_codes: outcome.overall.reason_codes }));
assert.equal(outcome.overall.decision, 'quarantined');
assert.ok(outcome.overall.reason_codes.includes('RULE_TIMEOUT'));
console.log('PROBE3_OK');
```
