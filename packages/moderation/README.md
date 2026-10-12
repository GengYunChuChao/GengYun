# packages/moderation · 审核组件（GY-I14）

本包目前包含**两片**：

| 片 | 内容 | 状态 |
| --- | --- | --- |
| 第一片 · 规则层 | `constants` / `matchers` / `rules` / `rule-version` / `validate-input` / `engine` / `batch` / `review`：确定性硬规则判定 | 已由 PR #88 合并进 main（`d5562923`） |
| 第二片 · 模型层 | `prompts` / `prompt-version` / `model-reason-codes` / `model-verdict` / `model-ports` / `model-review` / `merge`：可注入且**默认关闭**的模型端口、合流层、prompt 版本派生、版本绑定重审、失败隔离 | 本分支交付，**未合并** |

**边界声明**（两片共同，请先读这里）：

- 本包**不新增路由**、不改 `services/api/**`，因此**本包当前没有 HTTP 消费者**
  （合流层同样没有调用点，用例会扫描 `services/` `apps/` `miniprogram/` `tools/` 断言零命中）；
- 真实 `tms`/`ims` 网络能力**只能**来自注入式端口；本包**不内置任何端口实现、不读环境变量、
  不含任何网络原语**，应用装配路径在本阶段**永不提供** ⇒ 缺端口一律 fail-closed；
- 图片／多媒体的判定由模型层端口承担，但规则层对带媒体目标一律不判通过，
  因此**带媒体的目标在本片不可能被抬成 `approved`**；
- **不得**把本包读成"AI 筛查已完成"或"发布链已通"；也不得把合成端口回归当作模型准确率／召回率证据。

人读说明（规则分类、判定口径、fail-closed 语义、版本重审、失败隔离、已知限制）见
仓库内 `docs/moderation/README.md`；模型层（端口、合流、版本绑定、失败矩阵）见
`docs/moderation/model-layer.md`；真实命令与输出见
`docs/verification/gy-i14-moderation-rules-20261011.md`（规则层）与
`docs/verification/gy-i14-moderation-model-20261012.md`（模型层）。

## 否定护栏在危险类上更保守（宁可多拦）

MR-01／MR-02／MR-03（`dangerous_usage` / `label_bound_dose`）的否定护栏**可被转折/祈使词取消**：
同一句读段内、否定词之后出现 `但/但是/而/而是/要/应/应该/建议/最好` 时，否定失效、命中成立。
否则「不要单独用而要混配」这类句式会被整句压掉 ⇒ **放行**危险混配与无依据用量（fail-open）。

- 只对这两类生效（`negation_cancellers` 仅挂在这三条规则上，`validateRuleCatalog` 会拒绝挂到别的匹配器），其它类别行为不变；
- 纯否定（`不要随意混配`、`不能脱离标签使用`）仍**不命中**；
- **代价**：取消词含单字 `要`／`应`，无标点且含 `需要`／`主要`／`反应` 的句子可能被**误拦**——危险类接受误拦；
- 可观测：`evidence.cancelled` / `evidence.cancelled_by`（取值来自规则闭集，不是输入原文）。

详见 `docs/moderation/README.md` §3.1 与 §7 已知限制。

## 扫描限额是 fail-closed 闸门（未检查 ≠ 干净）

匹配器对候选匹配数与取消词扫描范围都有上界（`MAX_MATCHES = 64`、`FORWARD_CLAUSE_LIMIT = 64`）。
**上界用尽而仍有未检查内容时绝不返回"未命中"**：该规则状态记为 `truncated`，整体
`quarantined` + `RULE_SCAN_TRUNCATED`，`hard_rule_passed` 保持 false。
反例：`不要随意混配。`×63 + `把两种药混配。`（448 字符）能正常驳回；×64（455 字符）会让真实混配
落在第 65 个候选上——旧实现把它当作"未命中"而 `approved`，现在一律隔离。
同理，重审与发布都会**结构性校验绑定**（`type` 闭集 / `id` 非空 ≤80 / `revision` ≥1 正整数），
非法绑定一律 `TARGET_REF_INVALID` + 隔离，不得 `reuse` 或发布。

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

## 模型层（第二片）出口与口径

| 出口 | 用途 |
| --- | --- |
| `mergeModeration` | **合流层**：规则层结论 + 模型层结论 ⇒ 完整合法契约 `Moderation`（`id` 除外） |
| `mergeReasonCodes` / `checkMergedContractShape` / `checkMergedInvariant` | 原因码合流（截断口径）、契约形状核对、合流判定不变式（**单向**必要条件；返修 1 起三处共用） |
| `evaluateBoundHardRules` / `moderationInputDigest` / `verifyInputBinding` / `readInputBinding` | **输入绑定**（返修 1 · 监工 `5488195507` P1）：结论必须绑定它实际检查过的 `target_ref`+正文+媒体引用摘要；合流时**重算比对**，不一致即隔离，任何模型 pass 都覆盖不了 |
| `mergedFailureCodes` / `MERGED_FAILURE_REASON_CODES` | 合流层"出现即不得放行／不得复用"的原因码清单（模型失败类 + `MODEL_BLOCKED`） |
| `MODEL_REASON_CODES` | 模型层**原因码**闭集（`reason_codes` 取值，不是契约错误码；错误封套码仍只有规则层 `MODERATION_ERROR_CODES` 三个值，本层未新增） |
| `MODEL_PORT_SEAMS` / `MODEL_PORT_SEAM_DEFAULTS` | 真实网络 seam 清单；本包对它们的默认实现**全为 `null`**（默认关闭靠"类型上就没有实现"） |
| `validateModelPort` / `classifyModelFailure` / `buildModelRequest` / `normalizeMediaRef` | 端口校验、失败归类、离线请求信封、图片引用归一（**不传字节**） |
| `normalizeModelVerdict` | 模型回报形状归一；**丢弃全部自由文本**（只留计数，杜绝 PII 抄进结果） |
| `derivePromptVersion` / `PROMPT_VERSIONS_BY_ID` / `derivePromptVersionForIds` | 由 prompt 定义内容派生 `prompt_version`（改一个字符 ⇒ 版本必变） |
| `evaluateModelReReview` / `isModelLayerPublishable` / `MODEL_BINDING_FIELDS` | 三元组 `rule_version`+`model_version`+`prompt_version` 绑定、重审失效与发布口径（内部复用规则层 `evaluateReReview` / `isPublishable`） |

口径要点（详见 `docs/moderation/model-layer.md`）：

- **`hard_rule_passed` 只反映规则层事实**，模型结论不得改写；因此合流结果允许出现
  `hard_rule_passed=true` + `decision='quarantined'`（规则过了、模型没跑／没结论）。
  合流层不变式只有**单向**必要条件：`approved ⟹ hard_rule_passed === true 且无 fail-closed 原因码`。
- **绝不升级**：规则层 `rejected` / `quarantined` 时合流结论只能是它本身。
- **失败一律隔离**：缺端口／端口非法／BizType 未核验／超时／配额／鉴权失败／载荷非法／
  形状未知／端口抛错／模型 `unsure`／版本缺失 ⇒ `quarantined`（另有端口明确判定不通过 ⇒ `rejected`），
  且必须留下可判别的 `MODEL_*` 原因码。
- `reason_codes` 超限走**截断**（不是拒绝）：`REASON_CODES_TRUNCATED` 置顶、≤30 条，
  合流全量留在非契约字段 `reason_codes_full`；**裁码绝不改变决策**。
- **输入绑定（返修 1 · P1）**：生产接线应使用 `evaluateBoundHardRules(input, options)` 得到规则层结论
  （结论自带 `input_binding`）；合流必须传 `content`，层内会重算摘要比对，
  不一致 ⇒ `MODEL_LAYER_INPUT_BINDING_MISMATCH` + `quarantined`。**缺少绑定一律不得通过**。
- **放行闸门（返修 1 · P2）**：模型层结论**必须**用 `isModelLayerPublishable` / `evaluateModelReReview`
  （两者都过 `checkMergedInvariant` + 模型失败原因 + 输入绑定核验，调用时要传 `input`）；
  规则层的 `isPublishable` 只对规则层事实负责，**不得**用于放行模型层结论。
- **端口执行证据（返修 2 · 监工 `5489050358` P1）**：`approved` 还要求**所需端口的执行证据齐备且均为通过**——
  任何内容都要求 `tms`，内容带媒体额外要求 `ims`（所需集合由**内容**决定，不看结论里有没有 `kinds`）；
  `kinds` 缺失／空对象／缺所需端口／状态非 `pass` ⇒ 一律不得发布、不得复用。
  **"没有证据" ≠ "全部通过"。**

## 测试

```powershell
npm run test:unit                              # 已纳入 tests/moderation/*.test.mjs
node --test "tests/moderation/*.test.mjs"
```
