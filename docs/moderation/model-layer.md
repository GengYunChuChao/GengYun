# GY-I14 第二片：模型层（端口 · 合流 · 版本绑定 · 失败隔离）

> **边界声明（最重要，请先读这里）**
>
> 本片交付 GY-I14（#14）的**模型层组件**，是该项的**第二片**（第一片确定性规则层已由 PR #88 合并，`d5562923`）。
>
> - 本片**不注册路由、不改 `services/api/**`**，因此**本组件暂无 HTTP 消费者**，应用装配路径**未接线**；
> - 真实 `tms`（文本）／`ims`（图片）网络能力**只能**来自**注入式端口**，本包**不内置任何端口实现**；
>   真实调用需要用户交接两个真实 `BizType`（现为占位值，`policySelectionVerified:false`），本片**一律不调**；
> - **不得**把本片读成"AI 筛查已完成"、"发布链已通"；**不得**声称任何准确率／召回率
>   （`docs/evaluation/sample-gap-register.md` 已确认 AI 筛查类真实样本为 0，合成夹具只作确定性回归）；
> - 契约口径：`Refs #14`，**不关闭整项 #14**。

交付物：`packages/moderation/{prompts,prompt-version,model-reason-codes,model-verdict,model-ports,model-review,merge}.mjs`、
`tests/moderation/model-*.test.mjs` 与 `tests/moderation/prompt-version.test.mjs`、本说明与
`docs/verification/gy-i14-moderation-model-20261012.md`（真实命令与输出）。

## 1 文件与职责

| 文件 | 职责 |
| --- | --- |
| `packages/moderation/prompts.mjs` | prompt 定义**集中定义处**（声明式；不含任何执行能力） |
| `packages/moderation/prompt-version.mjs` | 由 prompt 定义**内容**派生 `prompt_version`（复用规则层 `stableStringify`） |
| `packages/moderation/model-reason-codes.mjs` | 模型层**原因码**闭集（`reason_codes` 取值；不是契约错误码） |
| `packages/moderation/model-verdict.mjs` | 模型回报形状归一（形状必须齐备；自由文本一律丢弃） |
| `packages/moderation/model-ports.mjs` | 端口契约、端口校验、失败归类、离线请求信封、图片引用归一 |
| `packages/moderation/model-review.mjs` | 三元组版本绑定、重审失效、发布口径（内部复用规则层 `evaluateReReview` / `isPublishable`） |
| `packages/moderation/merge.mjs` | **合流层**：规则层结论 + 模型层结论 ⇒ 完整合法契约 `Moderation`（`id` 除外） |

本片**没有改规则层既有语义**：`constants.mjs` / `matchers.mjs` / `rules.mjs` / `rule-version.mjs` /
`validate-input.mjs` / `engine.mjs` / `batch.mjs` / `review.mjs` 逐字节未动；
`index.mjs` 只**追加**导出与更新头部边界说明。规则层既有断言（`tests/moderation/` 原有 122 条）逐条继续通过。

## 2 端口契约：可注入、默认关闭（结构性，不是运行期开关）

端口的形状（由注入方提供，本包只校验、只调用 `evaluate`）：

| 字段 | 含义 |
| --- | --- |
| `kind` | `'tms'`（文本）或 `'ims'`（图片）；**必须与本次用途一致**，串端口即拒 |
| `model_version` | 提供者回报的模型标识，1..80；缺／空／越界 ⇒ `MODEL_VERSION_MISSING`（**绝不填占位串**） |
| `evaluate(request)` | 唯一执行入口（同步或异步）；返回 verdict 或抛错 |
| `seams` | `fetchImpl` / `credentials` / `liveGate` / `now`：真实网络能力的**全部载体**，由注入方持有 |
| `provider` | `biz_type` / `biz_type_selection_verified` / `synthetic` / `timeout_ms`：声明式绑定 |

"默认关闭"的三条结构性依据（均有用例，见 `tests/moderation/model-ports.test.mjs`）：

1. **本包对这些 seam 没有任何默认实现**：`MODEL_PORT_SEAM_DEFAULTS` 全部为 `null`，
   因此"关闭"不依赖任何运行期判断，而是"类型上就没有实现"；
2. **本包源码零命中网络原语**：无 HTTP 客户端调用、无 Node HTTP 模块、无供应商 SDK、
   无环境变量读取、无绝对 URL 字面量（逐文件正则扫描，命中即失败）；
3. **本包不导出任何端口实现**，且仓库内 `services/` `apps/` `miniprogram/` `tools/`
   **零命中** `mergeModeration` / `packages/moderation` ⇒ 应用装配未接线，暂无 HTTP 消费者。

因此 `execution_mode: 'real'` 与"未接线"**逐字节相同**（合流层只用注入的端口，
`execution_mode` 仅记录在诊断字段里）：两者都输出 `quarantined` + `MODEL_LAYER_PORT_MISSING`。

**BizType 闸门**：端口必须显式声明 `provider.biz_type_selection_verified === true` **才会被调用**；
否则 `MODEL_BIZTYPE_UNVERIFIED` 且 `evaluate` **一次都不被调用**（用例断言调用次数为 0）。
这是"占位 BizType ⇒ 不发真实请求"的落地点，也是本阶段不可能真发包的证明之一。

**隐私**：请求对象里允许出现待筛查正文（端口需要它），但本包不落盘、不打印、不序列化它；
图片一律只传**不透明引用**（`media_id` / `media_revision` / `mime`），**不传图片字节**，
媒体描述符里出现 `bytes` 或未知字段即判载荷非法。

## 3 合流层如何复用规则层接口

| 规则层接口 | 合流层的用法 |
| --- | --- |
| `pending_model_layer_fields` | **准入闸门**：只有规则层声明 `['model_version','prompt_version']` 时本层才去补。声明缺失／不完整 ⇒ `MODEL_LAYER_DECLARATION_MISSING`；规则层自己带了这两个字段 ⇒ `MODEL_LAYER_FIELD_SPOOFED` 且**绝不采信其值** |
| `missingContractFields()` | **缺失清单唯一权威**：本层把 `model_version` / `prompt_version` 补上后，用该函数过滤出"仍然缺什么"。补全成功时 `missing_contract_fields === ['id']`；补不上时**如实报缺**且 `contract_value === null`（不装配半成品） |
| `orderReasonCodes` / `truncateReasonCodes` | **原因码排序与截断**复用同一实现（fail-closed 码优先、`REASON_CODES_TRUNCATED` 置顶） |
| `evaluateReReview` | **规则版本／目标绑定／结构自洽**三件事全部委派给它（`model-review.mjs`），本层只**追加**模型版本与 prompt 版本两项比较 |
| `isPublishable` | **发布口径**委派给它，本层再 `AND` 上"模型／prompt 版本与当前一致" |
| `REVIEW_ACTIONS` / `REVIEW_LANDINGS` | 动作与落点沿用同一闭集（`reuse` ／ `re_review`、`pending` ／ `quarantined`），**不另立标准** |
| `MODEL_LAYER_FIELDS` | 只读消费其值，**不修改**规则层常量 |
| `MODERATION_ERROR_CODES` | 错误封套码仍只有规则层这三个值，本层**未新增错误码、未新增契约字段** |

合流结果的顶层字段与契约 `Moderation` 同名（`target_ref` / `decision` / `reason_codes` /
`hard_rule_passed` / `rule_version` + `model_version` / `prompt_version`），
因此**可以直接喂给规则层的 `evaluateReReview` / `isPublishable`**（有用例断言这一点）。

## 4 判定口径与失败隔离矩阵

合流决策（唯一出口）：

| 规则层 `decision` | 机制 | 合流 `decision` |
| --- | --- | --- |
| `rejected` | 原样保留 | `rejected` |
| `quarantined` | 原样保留 | `quarantined` |
| `approved` | 所需端口全部**实际求值且 `pass`**，且无任何 fail-closed 原因码 | `approved` |
| `approved` | 某个端口明确 `block` | `rejected`（只降不升） |
| `approved` | 其余全部情形（缺端口／失败／没结论） | `quarantined` |

> 优先级：同一目标多个端口同时"失败"和"明确不通过"时，**`rejected` 优先**
> （有端口明确判定不得通过）；两类原因码都会写进 `reason_codes`。两者都阻断发布。

失败矩阵（每一类都有独立反例，见 `tests/moderation/model-fail-closed.test.mjs`）：

| 失败类别 | decision | 可判别原因码 |
| --- | --- | --- |
| 未注入所需端口（未接线） | `quarantined` | `MODEL_LAYER_PORT_MISSING` |
| 端口形状非法（非对象／`evaluate` 非函数／`seams` 缺声明／`provider` 缺字段／kind 不符） | `quarantined` | `MODEL_LAYER_PORT_INVALID` |
| BizType 未核验（占位值） | `quarantined` | `MODEL_BIZTYPE_UNVERIFIED`（**不调用端口**） |
| 规则层未按 `pending_model_layer_fields` 声明 | `quarantined` | `MODEL_LAYER_DECLARATION_MISSING` |
| 规则层冒充 `model_version` / `prompt_version` | `quarantined` | `MODEL_LAYER_FIELD_SPOOFED` |
| 提供者未回报合法 `model_version` | `quarantined` | `MODEL_VERSION_MISSING`（且 `missing_contract_fields` 含它） |
| 两个 kind 回报不同模型标识（契约只有一个字段） | `quarantined` | `MODEL_VERSION_CONFLICT` |
| 超时（端口抛 `TimeoutError`／超 `deadline_ms`） | `quarantined` | `MODEL_TIMEOUT` |
| 配额耗尽（HTTP 429／显式声明） | `quarantined` | `MODEL_QUOTA_EXCEEDED` |
| 鉴权失败（HTTP 401／403） | `quarantined` | `MODEL_AUTH_FAILED` |
| 载荷非法（端口判定／HTTP 400／媒体描述符夹带 `bytes` 或未知字段） | `quarantined` | `MODEL_PAYLOAD_INVALID` |
| 媒体类型本片不承担（非 `image/*`） | `quarantined` | `MODEL_MEDIA_UNSUPPORTED` |
| 未知响应形状（非对象／缺 `label`／`label` 越界／缺必报字段／回报版本与声明矛盾） | `quarantined` | `MODEL_RESPONSE_SHAPE_UNKNOWN` |
| 端口抛出无法归类的异常 | `quarantined` | `MODEL_PORT_ERROR` |
| 模型 `unsure`（没结论） | `quarantined` | `MODEL_NOT_EVALUATED` |
| 模型明确 `block` | `rejected` | `MODEL_BLOCKED` |
| `content` 与规则层看到的输入不一致／非法 `execution_mode`／规则层结果自相矛盾 | `quarantined` | `MODEL_MERGE_INPUT_INVALID` |
| prompt 定义非法（无法派生版本） | `quarantined` | `MODEL_PROMPT_DEFINITION_INVALID` |

**落点选择（`quarantined`，不选 `pending`）及理由**：`pending` 在规则层口径中专指
"**旧判定失去强制力、可由确定性重跑自动推进**"（版本／修订变化）。模型侧失败不是这种情形——
缺端口是**结构性未接线**，超时／配额／鉴权／形状未知是**必要证据缺失或不可信**，
与规则层的"类型未覆盖／输入非法／选项非法"同类，必须留痕并阻断，不能靠"排队重跑"保证有结论。
因此：**运行期模型失败一律 `quarantined`**；**版本变化仍沿用规则层口径落 `pending`**（见 §6）。

**`hard_rule_passed` 只反映规则层事实**：本层逐字节回填规则层的值，模型结论**不得**改写它。
由此产生一个**必须显式声明的口径差异**：

| 层 | 不变式 | 说明 |
| --- | --- | --- |
| 规则层 | `approved ⟺ hard_rule_passed === true` | 该层唯一的判定者就是硬规则 |
| 合流层 | `approved ⟹ hard_rule_passed === true`（**单向**） | 判定者有两个；"硬规则过了"不等于"整体过了" |

所以合流结果**允许**出现 `hard_rule_passed=true` + `decision='quarantined'`（规则通过、模型没跑或没结论），
这是本片 fail-closed 的主线；`checkDecisionInvariant`（规则层）**不**适用于合流结果，
合流层有自己的 `checkMergedInvariant`。反向（`hard_rule_passed=false` + `approved`）则**永远禁止**。

## 5 图片／多媒体的口径与跨片依赖

- 规则层遇到带媒体的目标一律 `quarantined` + `MEDIA_NOT_EVALUATED_BY_RULE_LAYER`，
  且**硬规则一条都没有求值**（`counts.evaluated === 0`，`hard_rule_passed === false`）；
- 本片承担图片审核：`ims` 端口照常求值并把结论写进诊断字段，但**不可能**把该目标抬成 `approved`——
  抬成通过就等于"没跑硬规则却通过"，与 `hard_rule_passed` 只反映规则层事实直接冲突；
- 因此"带媒体 + 图片端口可用且通过"仍然是 `quarantined`。这是**刻意的保守口径**，
  也是本片对外最容易被误读的一点：**图片审核端口已交付，但图片目标在本片仍不可达 `approved`**；
- 要让带媒体目标真正可达 `approved`，需要改**规则层**的覆盖／媒体口径（例如对媒体目标的文本部分
  求值并显式扩大 `COVERED_TARGET_TYPES`）：属**跨片依赖**，本片不擅自改规则层语义。
- 已交付的正面价值：端口契约与注入方式、失败矩阵、`MEDIA_NOT_EVALUATED_BY_RULE_LAYER` 的政策留痕，
  以及"带媒体 + 模型不可用 ⇒ 不得通过"的独立反例。

## 6 版本绑定与重审失效

结论绑定三元组 `rule_version` + `model_version` + `prompt_version`（外加 `TargetRef`）。
`evaluateModelReReview(existing, { rule_version, model_version, prompt_version, target_ref })`：

| 情形 | `stale` | 落点 | 原因码 |
| --- | --- | --- | --- |
| 只改 `rule_version` | 是 | `pending` | `RULE_VERSION_CHANGED`（由规则层判出） |
| 只改 `model_version` | 是 | `pending` | `MODEL_VERSION_CHANGED` |
| 只改 `prompt_version` | 是 | `pending` | `MODEL_PROMPT_VERSION_CHANGED` |
| 既有结论缺 `model_version` / `prompt_version` | 是 | `quarantined` | `MODEL_VERSION_UNKNOWN` / `MODEL_PROMPT_VERSION_UNKNOWN` |
| 调用方未给当前 model／prompt 版本 | 是 | `quarantined` | 同上（"不知道用哪版"不等于"没变化"） |
| 目标 `revision` 变化 | 是 | `pending` | `TARGET_REVISION_CHANGED`（规则层判出） |
| `approved` 与 `hard_rule_passed` 自相矛盾 | 是 | `quarantined` | `DECISION_INCONSISTENT`（规则层判出） |
| 三版本与目标均未变且自洽 | 否 | — | `reuse` 且 `publishable: true` |

发布口径 `isModelLayerPublishable` = 规则层 `isPublishable` **且** 模型／prompt 版本与当前一致；
任一不满足即 `NOT_PUBLISHABLE`。"通过筛查"与"发布"仍是两步（F08）。

## 7 `reason_codes` 合流与超限口径

**排序**：规则层码在前（沿用 `orderReasonCodes` 的结果，规则层既有语义优先），
模型层码按 `MODEL_REASON_CODES` 声明序在后，未知码最后，全部去重。

**超限口径选择：截断（truncate），不是拒绝（reject）。** 理由：

1. 契约对 `reason_codes` 的约束是硬上限 `maxItems: 30`；**拒绝**意味着整条不产出契约对象，
   调用方拿不到任何结论，反而更容易被误读成"没问题"，或被迫另造一套结构；
2. 规则层已经采用"截断 + `REASON_CODES_TRUNCATED` 置顶 + 全量留在诊断字段"的口径，
   合流层沿用同一口径可避免两套语义并存；
3. **裁码绝不改变决策**：决策只由 `decision` 决定，原因码只是证据标签；
   截断发生在决策之后，且 `quarantined` / `rejected` 一旦成立不会被截断改写（有专门反例）；
4. 截断时的实际行为：长度越界（`<1` 或 `>80`）的项一律裁掉并置顶 `REASON_CODES_TRUNCATED`；
   去重后仍 >30 条则从**尾部**截断（极端情况下被丢的是模型层码，
   但那种情形下规则层码本身已经解释了阻断原因，不会出现"只有模型码能解释却全被丢掉"）；
   合流全量保留在非契约字段 `reason_codes_full`，丢弃计数在 `invalid_dropped_count`。

## 8 `prompt_version` 派生方式与样例值

哈希输入（`canonicalPromptPayload`，复用规则层 `stableStringify`）：schema `mp1` + 域
`gengyun.moderation.model-prompts` + 参与本次筛查的 prompt 定义（按 id 排序，顺序无关），
每个定义包含 `system` / `user_template` / `purpose` / `policy_notes` **原文逐字符**、
`placeholders` / `required_output_fields` / `verdict_labels`（排序去重）与其它选项。

- 改一个字（含说明文案、policy 备注）⇒ 版本必变（有"改一个字符"用例与**回退-复跑**证据）；
- `prompt_version` 契约字段取**本次实际用到的那组 prompt** 的集合版本
  （文本目标 = 文本 prompt；带媒体目标 = 文本 + 图片 prompt），
  这样"另一个 prompt 改了"也会让带媒体目标的旧结论失效；
- 零个 prompt 参与时**拒绝派生**（"零个 prompt"不构成"已筛查"）。

出厂样例值（本机实测，可复核）：

| 项 | 值 |
| --- | --- |
| 文本 prompt 单独版本 | `mp1+sha256:e24f2f6a556034373f889fa6b5fec386` |
| 图片 prompt 单独版本 | `mp1+sha256:d00373e881c3bbc72998d05fc8342d50` |
| 文本 + 图片集合版本 | `mp1+sha256:f0e8f336b99eddb91c035d429912e323` |
| 规则层 `rule_version`（未改动） | `mr1+sha256:736efcf2abc48c2c39a5036140eabbea` |

## 9 契约缺口（如实登记，未自行扩权）

1. **`Moderation.model_version` 只有一个字段，而一次筛查可能用两个模型**（文本 `tms` + 图片 `ims`）。
   本片对"两个 kind 回报不同模型标识"选择 `MODEL_VERSION_CONFLICT` + `quarantined`（fail-closed），
   而**没有**新增契约字段。要正确表达"多模型绑定"，需要契约侧增量。
2. **契约未定义模型层原因码闭集**。契约只约束 `reason_codes` 的类型与长度，不约束取值。
   本片新增的是**组件内原因码**（`MODEL_*` 前缀，与规则层闭集零重叠），
   **错误封套码与契约错误码一个都没有新增**。若下游希望"原因码全仓统一闭集"，
   需要契约或治理层给出统一清单——本片不做这个决定。
3. **`Moderation` 没有"是否已跑过模型"的显式字段**。本片把该证据放在非契约诊断字段
   （`model_layer.status` / `kinds[*].status`），契约对象本身无法表达"这条是模型没跑导致的隔离"，
   只能靠 `MODEL_*` 原因码间接推断。
4. **带媒体目标的 `approved` 不可达**（见 §5）：这不是本片能单方面修的，属规则层口径 + 接线口径的跨片依赖。

## 10 已知限制（不掩饰）

1. **无 HTTP 消费者**：无路由、无鉴权、无持久化；`Moderation` 落库、契约错误码映射、幂等与
   `If-Match` 语义都属 API 接线增量。
2. **端口是注入式的，本仓库当前没有任何真实端口**：全部用例使用 `provider.synthetic === true`
   的合成替身，因此**正控制里的 `approved` 不是"真实模型认可"**，只是"本层口径下通过"；
   真实 `BizType` 未交接前，本片不具备任何真实审核能力。
3. **不声称准确率／召回率**：AI 筛查类真实样本为 0，本片只有确定性回归。
4. **自由文本被丢弃**：模型自报的 `reason_codes` / `summary` 不进结果、不进日志（隐私优先），
   只保留计数。人工复核若需要模型原话，需要另立受控通道（属后续增量）。
5. **超时依赖注入**：合流层的 `deadline_ms`（缺省取端口声明的 `provider.timeout_ms`）只能打断
   "合流层等待"，不能抢占端口内部已经发出的调用（进程级／worker 级超时属接线增量）。
6. **`execution_mode` 只是标签**：它不影响"要不要跑端口"，因此"默认关闭"**不**靠它；
   若下游误以为切成 `real` 就会跑模型，会得到 `quarantined` 而不是静默通过（方向安全）。

## 11 如何运行

```powershell
npm run test:unit                                       # 已纳入 tests/moderation/*.test.mjs
node --test "tests/moderation/model-*.test.mjs"         # 模型层用例
node --test "tests/moderation/prompt-version.test.mjs"  # prompt 版本派生用例
```

真实命令与输出见 [`../verification/gy-i14-moderation-model-20261012.md`](../verification/gy-i14-moderation-model-20261012.md)。
