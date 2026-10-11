# GY-I14 第一片：确定性硬规则审核层（组件说明）

> **边界声明（最重要，请先读这里）**
>
> 本组件是 GY-I14（#14）的**第一片**，只交付**可独立测试的确定性硬规则审核层**。
> - 本 PR **不新增路由**、不改 `services/api/**`，因此**本组件暂无 HTTP 消费者**；
> - 图片／多媒体的 AI 筛查、模型判定与 `model_version` / `prompt_version` 属**模型层增量**，本片**不产出**；
> - 因此**不得**把本组件读成"AI 筛查已完成"，也不得把规则夹具回归当作模型准确率／召回率证据。
>
> 交付物：`packages/moderation/**`（纯 ESM）、`tests/moderation/**`、本说明与
> `docs/verification/gy-i14-moderation-rules-20261011.md`（真实命令与输出）。
> 契约 `Refs #14`，**不关闭整项 #14**。

## 1 组件位置与职责

| 文件 | 职责 |
| --- | --- |
| `packages/moderation/constants.mjs` | 只读消费 `packages/contracts` 的闭集与上限（`AuditState`、`TargetRef.type`、`reason_codes` 上限等），**不修改契约** |
| `packages/moderation/rules.mjs` | 规则集**集中定义处**（唯一审计点）+ 规则集结构校验 |
| `packages/moderation/matchers.mjs` | 确定性文本匹配器（含否定护栏、住址链、坐标、交易链接） |
| `packages/moderation/rule-version.mjs` | 由规则集**内容**派生 `rule_version`（稳定哈希） |
| `packages/moderation/validate-input.mjs` | 输入校验（fail-closed 第一道闸） |
| `packages/moderation/engine.mjs` | 审核引擎：逐规则失败隔离、预算、决策、不变式自检、草稿投影 |
| `packages/moderation/batch.mjs` | 批量审核与跨目标失败隔离 |
| `packages/moderation/review.mjs` | 版本重审／失效判定与发布口径 |

组件消费契约的方式是"**只读 + 逐项比对**"：`tests/moderation/contract.test.mjs` 直接读
`packages/contracts/states.json` 与 `openapi.json`，一旦契约变动而本组件没跟上，用例立即失败。

## 2 与契约的字段边界

契约 `Moderation` 的必填字段被**诚实拆成四层**（`MODERATION_FIELD_LAYERS`）：

| 层 | 字段 | 本片是否产出 |
| --- | --- | --- |
| `rule_layer` | `decision`、`reason_codes`、`hard_rule_passed`、`rule_version` | **是** |
| `target_binding` | `target_ref` | 校验后原样回填（缺省即隔离） |
| `model_layer` | `model_version`、`prompt_version` | **否**（模型层增量补齐） |
| `persistence_layer` | `id` | **否**（持久层生成） |

`AuditState` 是**闭集 4 值**（`pending` / `approved` / `rejected` / `quarantined`），本组件**不新增任何值**。
`reason_codes` 遵守契约上限（≤30 项，每项 1..80 字符），超限时优先保留 fail-closed 原因码并置顶 `REASON_CODES_TRUNCATED`。

规则层结果用 `toRuleLayerDraft()` 投影成**显式标注 `complete: false`** 的草稿，
`missing_contract_fields` 明确列出 `id` / `model_version` / `prompt_version`——
**不使用占位字符串假装已填**（用例 `本片不产出 model_version / prompt_version：源码里没有占位赋值` 会扫描源码拦截这种写法）。

## 3 规则清单

规则全部集中在 `packages/moderation/rules.mjs`，每条带稳定 `id`、类别、原因码与说明。

| 规则 id | 类别 | 原因码 | 拦截形态 |
| --- | --- | --- | --- |
| MR-01 | `dangerous_usage` | `DANGEROUS_MIX` | 要求把多种药剂混配／混着打／交叉混用 |
| MR-02 | `dangerous_usage` | `DOSE_UNBOUNDED` | "随便加""加多少都行""不用计量"，脱离标签的随意用量 |
| MR-03 | `label_bound_dose` | `DOSE_NOT_BOUND_TO_LABEL` | "不用看标签""直接加倍"，用量脱离登记制剂与条件 |
| MR-04 | `privacy` | `PRIVACY_PII` | 手机号、18 位身份证号 |
| MR-05 | `privacy` | `PRIVACY_PII` | 精确住址链（≥3 级行政区划 + 门牌级词） |
| MR-06 | `privacy` | `PRIVACY_COORDS` | 原始坐标（高精度十进制对／经纬度键值／度分秒／GPS） |
| MR-07 | `prompt_injection` | `PROMPT_INJECTION` | 忽略指令、索要系统提示词、改写角色、越狱、绕过限制 |
| MR-08 | `authority_spoofing` | `FALSE_AUTHORITY` | 冒充专家认证、声称机构背书、把社区经验当官方结论 |
| MR-09 | `safety_claim` | `ABSOLUTE_SAFETY_CLAIM` | "绝对安全""保证无残留""永久有效" |
| MR-10 | `commerce` | `COMMERCE_SOLICITATION` | 加微信、私聊下单、扫码购买、厂家直销／批发价 |
| MR-11 | `commerce` | `COMMERCE_LINK` | 淘宝／京东等电商外链，或外链附近存在交易语境 |

前 6 类对应派单 §3 的最低覆盖；`commerce` 类别对应 F05／AC16「广告、购买链接、私下交易导流不发布」。

**确定性**：规则无随机、无时间、无 I/O；匹配器禁止带 `g`/`y` 标志（有状态正则会让同一文本两次求值结果不同），
该约束由 `validateRuleCatalog` 强制并有专门用例。

**不过度拦截**：每条规则都有独立的"应当放行"用例（`tests/moderation/rules.test.mjs`），
其中多数是**否定护栏**场景（"不要随意混配"不应命中、"我不是专家"不应命中、"不代表完全没有残留"不应命中）。

### 3.1 危险类对否定护栏更保守（宁可多拦）

MR-01／MR-02／MR-03 属于**危险用法与用量**两类，它们的否定护栏**可以被转折/祈使词取消**：
在同一句读段内、否定词之后出现 `但` / `但是` / `而` / `而是` / `要` / `应` / `应该` / `建议` / `最好` 时，
否定失效、**命中照常成立**。原因很直接：`不要单独用而要混配`、`不建议这么打但可以混着打` 这类句式里，
真正的危险请求在转折词之后——若整句被否定压掉，就等于**放行危险混配与无依据用量**（fail-open）。

- **只对这两类生效**：`negation_cancellers` 仅挂在 MR-01／MR-02／MR-03 上；其它类别的否定护栏行为完全不变
  （如 MR-09 的"但不代表完全没有残留"仍不命中）。`validateRuleCatalog` 会拒绝把该选项挂到别的匹配器上。
- **纯否定仍不命中**：`不要随意混配`、`不能脱离标签使用` 这类**无转折**句子继续不命中。
- **有意付出的代价**：取消词含单字 `要`／`应`，中文里 `需要`／`主要`／`反应` 也含这些字，
  因此**无标点**且恰好含这些字的危险类句子可能被**误拦**。危险类**接受误拦**——
  漏拦会放行危险用量/混配，远比误拦严重。
- **可观测**：结果里 `evidence.cancelled` 记录"取消词顶掉否定"的次数，`evidence.cancelled_by` 记录具体取消词
  （取值来自规则闭集，不是输入原文）。

## 4 判定口径（fail-closed）

判定只有一个出口，禁止旁路：

| 决策 | 触发条件 |
| --- | --- |
| `quarantined`（隔离） | 存在**任一** fail-closed 条件：输入非法／target type 未覆盖／带媒体未审／规则未求值／规则抛错／超时／规则集非法 |
| `rejected`（驳回） | 无 fail-closed 条件，且至少一条规则**实际命中** |
| `approved`（通过） | 无 fail-closed 条件，且**全部**规则**实际求值**且**均未命中** |

**核心不变式**：`decision === 'approved'` **当且仅当** `hard_rule_passed === true`。
两者由 `checkDecisionInvariant` 逐条检查；引擎每次返回前都自查，违反则以 `quarantined` 兜底并记录
`invariant_violations`，**绝不"修好"成通过**。

三条最容易被忽视的 fail-closed 语义（本片显式实现并有负例）：

1. **"没跑"不等于"通过"**：输入闸门不通过时，`counts.evaluated = 0`、`counts.not_evaluated = 规则数`，
   `hard_rule_passed` 保持 false。
2. **未覆盖该 target type 不等于通过**：`COVERED_TARGET_TYPES` 之外的 8 个契约类型一律 `quarantined`
   + `TARGET_TYPE_NOT_COVERED`。这条正是"必要条件未知却放行"的反面：本层**声明自己覆盖什么**，
   覆盖之外一律不给结论。
3. **带媒体的目标不得由规则层放行**：图片审核属模型层，规则层只看文本；
   输入里的 `media` 非空即 `quarantined` + `MEDIA_NOT_EVALUATED_BY_RULE_LAYER`。
   同理，输入必须**显式**声明 `media`（省略 ≠ 没有媒体）："不确定有没有图片"也不放行。
4. **选项给错不等于按默认值跑一遍**：`rules` / `matchers` / `clock` / `budget_ms` / `max_text_length`
   若被显式传入但类型非法（如 `rules` 传字符串、`budget_ms` 传 `NaN`），一律 `quarantined`
   + `ENGINE_OPTIONS_INVALID`，并把明细放在结果的非契约字段 `option_errors` 里——
   静默回落到默认值会让调用方误以为自定规则或时间预算已生效。

**隐私加固**：命中证据只回传 `{field, offset, length, suppressed}`，**不回传命中原文**——
手机号／身份证号／住址／坐标不会被抄进结果、日志或原因码（有专门用例断言结果 JSON 不含命中原文）。

## 5 版本重审

`rule_version` 由规则集**内容**派生（`rule-version.mjs`）：哈希输入包括

1. schema 与 domain 标识；
2. 匹配器指纹（id + 版本号 + **实现源码**）；
3. 每条规则的完整描述符（id／类别／原因码／标题／说明／严重级别／匹配器／模式 source+flags／其它选项）。

因此改规则、改模式、改匹配器实现、改说明文案都会改变 `rule_version`——这是**有意的保守选择**：
宁多失效，不静默复用。输出形如 `mr1+sha256:<32 位十六进制>`，不是手填字面量。

`evaluateReReview(existing, { rule_version, target_ref })` 的失效判定与落点：

| 情形 | stale | 落点 | 原因码 |
| --- | --- | --- | --- |
| 规则集内容变化（版本不同） | 是 | `pending` | `RULE_VERSION_CHANGED` |
| 目标 `revision` 变化（编辑生成新版本） | 是 | `pending` | `TARGET_REVISION_CHANGED` |
| 目标 `type`／`id` 变化（不是同一对象） | 是 | `quarantined` | `TARGET_REF_CHANGED` |
| 缺／非法 `rule_version` | 是 | `quarantined` | `RULE_VERSION_UNKNOWN` |
| `decision` 非法 | 是 | `quarantined` | `DECISION_INVALID` |
| 自称通过但 `hard_rule_passed` 不为 `true` | 是 | `quarantined` | `DECISION_INCONSISTENT` |
| 版本、目标均未变且自洽 | 否 | — | — |

**落点理由**：规则集或目标修订变化意味着"旧判定失去强制力"，内容回到待筛查队列（`pending`）由确定性规则自动重跑，
重跑本身仍 fail-closed，不会因排队而放行；而"版本号缺失／决策非法／自相矛盾／绑定对象已变"属于**证据不可信**，
不能自动排队放行，必须 `quarantined`。

**发布口径**：`isPublishable(result)` 要求 `approved` **且** `hard_rule_passed === true` **且**
`rule_version` 等于当前版本；任一不满足即不得发布——"旧版本审核结果不能套新版本"（AC19）。
注意"通过筛查"与"发布"在本组件里是**两个步骤**（F08：通过筛查不等同于专业验证）。

## 6 失败隔离

- **单条规则抛错**：该规则状态记为 `error`（不是 `evaluated`、`matched` 恒为 false），
  计入 fail-closed，整体 `quarantined`；异常**不会**被吞成"未命中"。
- **匹配器返回结构非法**：同样记为 `error`。
- **批量审核**：每条目标独立求值；单条目标在引擎外抛出（例如输入对象陷阱抛错）时，
  该条隔离为 `quarantined` + `RULE_ENGINE_ERROR`，**不影响**批内其它目标的判定。
- **超时**：规则预算（默认 50ms，可注入）只在**开始一条规则之前**检查；超出即从该条起全部记为 `timeout`，
  计入 fail-closed。

## 7 已知限制（如实登记，不掩饰）

1. **无 HTTP 消费者**：本组件无路由、无鉴权、无持久化；`Moderation` 落库、契约错误码映射、
   幂等与 `If-Match` 语义都属 API 接线增量，本片**未实现**（`MODERATION_ERROR_CODES` 显式带 `http_status: null`）。
2. **单条规则不可抢占**：预算检查发生在规则之间，一个病态规则内部的长循环无法在进程内被打断
   （进程级／worker 级超时属接线增量）。本层用文本长度上界（20000 字符）限制单条规则的成本。
3. **否定护栏是确定性启发式**，不是语义理解。危险两类（MR-01／MR-02／MR-03）已对
   "否定 + 转折/祈使"做了保守化处理（§3.1：取消词顶掉否定，宁可多拦），但仍有残留边界：
   - 取消词是**有限闭集**：未列出的转折说法（如"不如""倒不如""反而"）仍可能被压掉 ⇒ 这类**漏拦**风险仍在；
   - 反向代价：取消词含单字 `要`／`应`，**无标点**且含 `需要`／`主要`／`反应` 的危险类句子可能被**误拦**；
   - 非危险类（含 MR-09 安全承诺）**未**启用取消词，其"否定 + 转折"仍按原语义压掉。
   全量语义覆盖须由模型层增量补齐；本轮只把**最严重的两类**的漏拦面收窄并加了回归。
4. **图片／多媒体完全未审**：带媒体目标一律不得 approved（这是刻意的 fail-closed，而非"已审过"）。
5. **文案改动也会改变 `rule_version`**：说明文案参与内容哈希，因此修错别字会导致既有结果整体重审。
   方向安全（多失效），代价是版本抖动。
6. **规则夹具不是真实样本**：`docs/evaluation/sample-gap-register.md` 已确认 `ai_moderation_risk` /
   `ai_moderation_normal` 真实样本**各为 0**（第 9／10 行），且原文明确"不可用演示样本替代"。
   本片全部用例只能表述为"**规则夹具上的确定性回归**"，**不得**用于声称任何模型准确率／召回率。
7. **确定性口径**：判定字段（`decision` / `reason_codes` / `hard_rule_passed` / `rule_version` / 逐规则状态）
   逐字节可复现；非契约诊断字段 `budget.elapsed_ms` 取自真实墙钟，**是唯一允许逐次变动的字段**。

## 8 如何运行

```powershell
npm run test:unit        # 已纳入 tests/moderation/*.test.mjs
node --test "tests/moderation/*.test.mjs"
```

`tests/moderation/*.test.mjs` 已追加到根 `package.json` 的 `test:unit` glob（纯加法，未改 workspaces、
未动 `package-lock.json`、未增删依赖）。
