# packages/moderation · 确定性硬规则审核层（GY-I14 第一片）

**边界声明**：本包只交付 **GY-I14（#14）的确定性硬规则审核层组件**，是该项的**第一片**。
- 本片**不新增路由**、不改 `services/api/**`，因此**本包当前没有 HTTP 消费者**；
- 图片／多媒体审核与 `model_version` / `prompt_version` 属**模型层增量**，本片**不产出**、不填占位串；
- **不得**把本包读成"AI 筛查已完成"。

人读说明（规则分类、判定口径、fail-closed 语义、版本重审、失败隔离、已知限制）见
仓库内 `docs/moderation/README.md`；真实命令与输出见
`docs/verification/gy-i14-moderation-rules-20261011.md`。

## 否定护栏在危险类上更保守（宁可多拦）

MR-01／MR-02／MR-03（`dangerous_usage` / `label_bound_dose`）的否定护栏**可被转折/祈使词取消**：
同一句读段内、否定词之后出现 `但/但是/而/而是/要/应/应该/建议/最好` 时，否定失效、命中成立。
否则「不要单独用而要混配」这类句式会被整句压掉 ⇒ **放行**危险混配与无依据用量（fail-open）。

- 只对这两类生效（`negation_cancellers` 仅挂在这三条规则上，`validateRuleCatalog` 会拒绝挂到别的匹配器），其它类别行为不变；
- 纯否定（`不要随意混配`、`不能脱离标签使用`）仍**不命中**；
- **代价**：取消词含单字 `要`／`应`，无标点且含 `需要`／`主要`／`反应` 的句子可能被**误拦**——危险类接受误拦；
- 可观测：`evidence.cancelled` / `evidence.cancelled_by`（取值来自规则闭集，不是输入原文）。

详见 `docs/moderation/README.md` §3.1 与 §7 已知限制。

## 快速用法

```js
import { evaluateHardRules, toRuleLayerDraft, RULE_VERSION } from './index.mjs';

const result = evaluateHardRules({
  target_ref: { type: 'post', id: 'post-1001', revision: 1 },
  text: '帖子的正文……',
  media: [], // 必须显式声明：省略 ≠ 没有媒体（未知即不放行）
});

// result.decision ∈ pending|approved|rejected|quarantined（契约闭集，不新增值）
// result.hard_rule_passed === true 仅在"全部规则实际求值且均未命中"时成立
// result.rule_version 由规则集内容哈希派生
toRuleLayerDraft(result); // 显式 incomplete 的草稿，未补 model_version / prompt_version
```

## 出口一览

| 出口 | 用途 |
| --- | --- |
| `evaluateHardRules` / `evaluateTarget` | 单目标审核（fail-closed） |
| `evaluateBatch` | 批量审核，逐目标失败隔离 |
| `validateModerationInput` | 输入校验（缺字段／类型不符／空／超长／编码异常／未知字段一律不放行） |
| `RULES` / `validateRuleCatalog` / `rulesByCategory` | 规则集集中定义与自检 |
| `DANGEROUS_NEGATION_CANCELLERS` | 危险类否定取消词闭集（MR-01／MR-02／MR-03 使用） |
| `deriveRuleVersion` / `RULE_VERSION` / `ruleSetDigest` | 由规则集内容派生版本 |
| `evaluateReReview` / `isPublishable` | 版本重审失效判定与发布口径 |
| `checkDecisionInvariant` / `assertDecisionInvariant` | 判定不变式检查（`approved ⟺ hard_rule_passed === true`） |

## 测试

```powershell
npm run test:unit                              # 已纳入 tests/moderation/*.test.mjs
node --test "tests/moderation/*.test.mjs"
```
