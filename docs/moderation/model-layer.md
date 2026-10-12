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
| `packages/moderation/input-binding.mjs` | **输入绑定**（返修 1 · P1）：把结论绑到它**实际检查过**的 `target_ref` + 正文 + 媒体引用摘要上，并提供合流时的重算比对 |
| `packages/moderation/merged-invariant.mjs` | **合流合法性**单一事实来源（返修 1 · P2）：`checkMergedInvariant` / `mergedFailureCodes`，合流层与两个闸门三处共用 |
| `packages/moderation/model-review.mjs` | 三元组版本绑定、重审失效、发布口径（内部复用规则层 `evaluateReReview` / `isPublishable`） |
| `packages/moderation/merge.mjs` | **合流层**：规则层结论 + 模型层结论 ⇒ 完整合法契约 `Moderation`（`id` 除外）；**必须**校验输入绑定 |

本片**没有改规则层既有语义**：`constants.mjs` / `matchers.mjs` / `rules.mjs` / `rule-version.mjs` /
`validate-input.mjs` / `engine.mjs` / `batch.mjs` / `review.mjs` 逐字节未动；
`index.mjs` 只**追加**导出与更新头部边界说明。规则层既有断言（`tests/moderation/` 原有 122 条）逐条继续通过。

## 输入绑定：结论必须绑定它**实际检查过**的内容（返修 1 · 监工 `5488195507` P1）

事故形态（监工独立复现）：对干净正文 A 跑 `evaluateHardRules` 得 `approved`，**同一个
`target_ref`/`revision`** 下把 `content.text` 换成硬规则会 `rejected` 的正文 B，再注入返回 pass 的假模型
⇒ 旧实现返回 **`approved`**：等于**模型放行 B 时复用了 A 的硬规则结论**，绕过"模型不能翻案"的硬边界。

摘要（`moderationInputDigest`，形如 `mib1+sha256:<32 位十六进制>`）覆盖的输入面 **恰好是规则层唯一接受的输入面**
（`ALLOWED_INPUT_FIELDS`）：`target_ref{type,id,revision}` + `text` **原文逐字符** + `media`（**保序**，元素内容逐个进摘要）。

| 选择 | 理由 |
| --- | --- |
| 覆盖 `target_ref` 与 `revision` | 同 id 换版本、或换成另一个对象，都必须被识别为"不是同一次检查" |
| 覆盖正文**逐字符** | 只绑"非空正文"等于没绑；换一个字就可能是另一种内容 |
| 覆盖**媒体引用集合**且**保序** | 监工明确要求不得只看数量；顺序变化对应不同的待发布内容，宁多失效不静默复用 |
| **不**覆盖未知顶层字段 | 规则层对未知字段本就判 `INPUT_UNKNOWN_FIELD`（fail-closed），摘要只覆盖"真正被检查的内容" |
| 用域分隔 + 规范化序列化（复用规则层 `stableStringify`） | 与 `rule-version.mjs`/`prompt-version.mjs` 同做法，避免跨组件摘要混淆；结构化输入需要稳定序列化 |
| 由 `evaluateBoundHardRules` 在**规则层结论旁**写入 `input_binding`（非契约字段） | 规则层字段逐字节不动；绑定只做"加字段"（有用例逐字段比对证明） |

与社区线（`#15` 阶段 1，`services/api/src/community/service.ts`）既有做法的异同：

| 维度 | 社区线 | 本模块 | 说明 |
| --- | --- | --- | --- |
| 绑定对象 | 正文 `text_digest = sha256Hex(text)` | `target_ref` + 正文 + **媒体引用** | 本模块范围更宽：本层是文本/图片两个端口的唯一合流点，媒体也是被检查的输入 |
| 哈希方式 | 对纯字符串直接 SHA-256 | 结构化输入 ⇒ `stableStringify` + 域分隔 + 摘要前缀 | 输入形状不同；安全目标一致 |
| 不一致时落点 | 降级为 `pending`（内容回到待筛查队列） | **隔离 `quarantined`** | 社区线那是"内容被编辑"；本层是"**本次调用把 A 的结论用在 B 上**"，属证据不可信/自相矛盾 |
| 存储位置 | 社区线自己的 `ModerationRecord.text_digest`（契约之外） | `input_binding`（契约之外） | 同一种现实约束：契约 `Moderation` 没有该字段（见 §9.5） |

合流层口径：绑定**缺失／不可用** ⇒ `MODEL_LAYER_INPUT_BINDING_MISSING`；**重算不一致** ⇒
`MODEL_LAYER_INPUT_BINDING_MISMATCH`；两者都让 `decision` 至少为 `quarantined`，并且
**任何模型端口的 pass 都无法覆盖这个拒绝**（有用例断言端口确实返回了 pass）。

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
3. **本包不导出任何端口实现**；且"应用装配未接线"由**模型合流 API 符号**判定（返修 3 · 监工 `4248262118`）：
   在 `services/` `apps/` `miniprogram/` `tools/` 中扫描本片模型合流的对外符号
   （`mergeModeration` / `checkMergedInvariant` / `isModelLayerPublishable` / `evaluateModelReReview` /
   `evaluateBoundHardRules` / `requiredModelPortKinds` 等），**必须零命中** ⇒ 暂无 HTTP 消费者。
   > 判据**不是**"扫 `packages/moderation` 这个包路径"：已合并的 #94（community）等线**合法消费规则层**
   > （同一个包路径），用包路径当判据会把合法引用误判为越界。用例对两种形态各给一例：
   > 合法规则层消费（真实取社区线 `moderation-gate.ts` 的 import 形态）放行；真实模型合流接线
   > （`import { mergeModeration } from '…/merge.mjs'`、`checkMergedInvariant(…)`、`isModelLayerPublishable(…)`）被抓。

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
| **结论没带输入绑定**（只跑了 `evaluateHardRules`） | `quarantined` | `MODEL_LAYER_INPUT_BINDING_MISSING`（返修 1 · P1） |
| **绑定与本次内容重算摘要不一致**（换正文／换同数量媒体） | `quarantined` | `MODEL_LAYER_INPUT_BINDING_MISMATCH`（返修 1 · P1） |
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
除 `hard_rule_passed` 与"无失败原因码"外，`approved` 还要求：**全部所需端口实际通过**，
且**输入绑定存在并已重算比对一致**（返修 1 · P1）。

### 4.1 放行闸门与导出消费者清查（返修 1 · 监工 `5488195507` P2）

事故形态（监工独立构造）：`decision='approved'` + `hard_rule_passed=true` + 三版本匹配 +
`reason_codes=['MODEL_TIMEOUT']` 的**自相矛盾结论**——`checkMergedInvariant` 早已判 `ok=false`，
但两个"放行闸门"只比版本 ⇒ `isModelLayerPublishable` 返回 `publishable=true`、
`evaluateModelReReview` 返回 `action='reuse'/publishable=true`。根因是**闸门分散、各自校验口径不同**。

处置：把"合流合法性"抽成单一事实来源 `checkMergedInvariant`（`merged-invariant.mjs`），
**三处共用**（合流层 + 两个闸门），并且闸门的前置条件还包含：
① 结论自身不得携带合流层失败原因码（`MODEL_*` 失败类 + `MODEL_BLOCKED`）；
② 输入绑定必须存在，且调用方给了当前内容时必须重算比对一致（返修 1 · P1 的回读侧）；
③ **所需端口的执行证据齐备且均为通过**（返修 2 · P1 加入；口径见 §4.2）。
任一不满足 ⇒ `publishable=false`、`evaluateModelReReview` 判 `stale` + `re_review` + `quarantined`。

本包**所有**"拿一个结论 ⇒ 回答可发布／可复用／是否合法"的出口，逐一清查如下：

| 出口 | 口径 | 是否过合流合法性 | 处置 / 不改的理由 |
| --- | --- | --- | --- |
| `mergeModeration` | 合流层（生产端） | 是（决定 `decision`，且输出 `input_binding.verified`） | 返修 1 已加输入绑定 |
| `isModelLayerPublishable` | **模型层唯一放行口径** | 是（返修 1 新增） | 模型层消费者**必须**用它 |
| `evaluateModelReReview` | 模型层复用/重审口径 | 是（返修 1 新增） | 同上；"有模型层失败原因 ⇒ 不复用" |
| `checkMergedInvariant` | 共用合法性 | 它本身就是该口径 | 三处共用，避免再次分散 |
| `checkMergedContractShape` | **形状**核对（不是放行判定） | 否（不回答"能不能发布"） | 只核契约 `Moderation` 字段是否齐备合法；不含放行语义 |
| `isPublishable` / `evaluateReReview` | **规则层**口径（PR #88 已合并） | 否 | **不改**：它只对规则层事实负责、不认识模型层码；改它就是改规则层既有语义。口径是"模型层结论必须走 `isModelLayerPublishable`"，并在 PR 正文写明 |
| `checkDecisionInvariant` / `assertDecisionInvariant` | **规则层**自身不变式 | 否 | 同上；合流结果不适用（见 §4 的口径差异表） |

### 4.2 端口执行证据：**"没有证据" ≠ "全部通过"**（返修 2 · 监工 `5489050358` P1）

事故形态（监工独立构造）：`existingApproved()` 那种"有有效 `input_binding`、三版本匹配、**但完全没有
`model_layer.kinds`**"的记录 ⇒ 旧实现 `checkMergedInvariant.ok=true`、`isModelLayerPublishable.publishable=true`、
`evaluateModelReReview` 可复用。根因：不变式**只在 `kinds` 存在时**才检查端口状态，
"缺失／空对象"直接跳过——把"没有模型执行证据"当成"所有端口通过"。与已修的两条同类：**缺失 ≠ 通过**。

| 规则 | 说明 |
| --- | --- |
| `tms` 证据：**任何**内容都必需 | 存在该端口的 `kinds` 条目、且 `status === 'pass'`（"实际求值过且结论是通过类"） |
| `ims` 证据：内容**带媒体**时必需 | 由**内容**决定（`media` 非空），**不得**由"结论里有没有 `kinds`"决定（那正是本缺陷） |
| `kinds` 缺失／空对象 | ⇒ 判不通过（`MODEL_LAYER_INVARIANT_VIOLATION`），不得发布、不得复用 |
| 缺所需端口 / 任一存在端口 `status !== 'pass'` | ⇒ 同上（`unsure`/`timeout`/`not_invoked`/`failed`/`blocked` 都算不通过） |
| 自报 `media_count` 与本次实际内容不一致 | ⇒ 判不通过（否则可伪造"没有媒体"把所需端口降级为只有 `tms`） |
| 所需端口无法确定（既无当前输入、绑定也无 `media_count`） | ⇒ 判不通过（fail-closed，不允许"不确定就放行"） |

`checkMergedInvariant(merged, { input })` 与两个放行闸门**共用**这一口径（闸门把 `options.input` 透传进来）。

### 4.3 全包清查：所有"某字段缺失即跳过／即通过"的点（返修 2 · 要求顺带清查）

| 位置 | 缺失/为空时会怎样 | 处置 |
| --- | --- | --- |
| `checkMergedInvariant` 的端口证据 | **返修前**：`kinds` 缺失/空 ⇒ **跳过检查**（缺陷） | **本轮已修**：缺失/空/缺所需端口/状态非通过 ⇒ 一律不通过 |
| `modelExecutionEvidence` 的"所需端口" | 无法确定所需集合 | **本轮已修**：判不通过并写明原因 |
| `modelExecutionEvidence` 的自报形状 | 自报 `media_count` 与实际不一致 | **本轮已修**：判不通过（防"伪造没媒体"） |
| `mergedFailureCodes` | 缺 `reason_codes` ⇒ 返回 `[]`（无失败码） | **不改**：不变式另有"`reason_codes` 必须是数组"硬检查 ⇒ 缺失仍被判不通过 |
| `readInputBinding` | 缺绑定 ⇒ `present:false`、`verified:false` | 已正确（返修 1）：闸门与不变式都拒 |
| `mergedLegality` 的 `options.input` | 调用方没给当前内容 ⇒ `UNVERIFIED` | 已正确（返修 1）：不得发布（内容是否仍是同一份未知） |
| `verifyInputBinding` | 绑定缺失/摘要非法 ⇒ `MISSING`；入参不可规范化 ⇒ `UNVERIFIED` | 已正确（返修 1） |
| `merge.checkRuleLayerResult` 的 `input` | 规则层结果没带 `input` ⇒ `inputValid:false` ⇒ 不尝试模型层 | 已正确：决策仍为隔离（"没跑"≠"通过"） |
| `merge` 的端口存在性 / `validateModelPort` | 缺端口 ⇒ `MISSING`；缺 `seams`/`provider` 字段 ⇒ `INVALID`；缺 `model_version` ⇒ `MODEL_VERSION_MISSING`；BizType 未核验 ⇒ 不调用 | 已正确（返修 1 之前即如此） |
| `normalizeModelVerdict` 的 `reason_codes`/`summary` | 缺 ⇒ 形状未知（因为 prompt 声明它们是必报字段） | 已正确 |
| `normalizeModelVerdict` 的 `model_version` | 回报里缺 ⇒ **采用端口声明的模型标识** | **不改**：端口声明是必填且已校验；模型标识由注入方声明，不是模型自陈，不回显不构成"缺证据" |
| `validateModelPort` 的 `provider.timeout_ms` | 缺 ⇒ 合流层不设额外 deadline | **不改**：端口自己持有超时并在超时时抛错（归类 `MODEL_TIMEOUT`）；合流层 deadline 是纵深防御，不是放行条件 |
| `normalizeMediaRef` 的 `mime` | 缺但 `kind === 'image'` ⇒ 视为图片 | **不改**：只影响"是不是图片"；缺标识仍判 `PAYLOAD_INVALID`；证据核对按内容的媒体条目数，与 `mime` 无关 |
| `checkMergedContractShape` 的 `contract_value` | 为 `null` ⇒ 全部必填字段算缺 ⇒ 报问题 | 已正确（形状检查本就不放行） |
| `merge` 的 `promptDefinition` | 为 `null` ⇒ `PROMPT_DEFINITION_INVALID` 且**不调用端口** | 已正确 |
| `merge` 的 `mediaRefs` | 与媒体条目数不等 ⇒ 不调用 `ims` 且 `PAYLOAD_INVALID` | 已正确 |

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
| 既有结论**没带输入绑定** | 是 | `quarantined` | `MODEL_LAYER_INPUT_BINDING_MISSING`（返修 1 · P1） |
| 有绑定但调用方未给当前内容 | 是 | `quarantined` | `MODEL_LAYER_INPUT_BINDING_UNVERIFIED`（不得发布；内容是否仍是同一份未知） |
| 绑定摘要与当前内容不一致 | 是 | `quarantined` | `MODEL_LAYER_INPUT_BINDING_MISMATCH`（返修 1 · P1） |
| 结论自身带合流层失败原因码（`MODEL_TIMEOUT` 等）或违反合流不变式 | 是 | `quarantined` | `MODEL_LAYER_INVARIANT_VIOLATION` + 原失败码（返修 1 · P2） |
| 三版本与目标均未变、绑定已核、结论自身合法 | 否 | — | `reuse` 且 `publishable: true` |

> 返修 1 起，`stale = true` 的含义是"**不得按原样复用**"（版本／绑定／自身合法性任一不成立），
> 不再只表示"版本变了"。落点仍沿用规则层口径：**版本变化 ⇒ `pending`**，
> 其余（未知／不一致／失败／不合法）⇒ `quarantined`。

发布口径 `isModelLayerPublishable` = 规则层 `isPublishable` **且** 模型／prompt 版本与当前一致
**且** 合流合法性成立 **且** 输入绑定已与当前内容重算比对一致（返修 1 · P1+P2）；
任一不满足即 `NOT_PUBLISHABLE`。调用方要传 `input`（当前这份内容）才可能得到 `publishable: true`。
"通过筛查"与"发布"仍是两步（F08）。

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
5. **契约 `Moderation` 没有"这份结论绑定了哪份内容"的字段**（返修 1 · P1 的现实约束）：
   本片把绑定放在非契约字段 `input_binding`（规则层结论侧与合流结果侧各一份），
   因此**存储层必须把该字段一起存**，否则回读时就只剩版本可用、
   内容是否仍是同一份无法核验（闸门会以 `MODEL_LAYER_INPUT_BINDING_MISSING` 拒绝放行，方向安全）。
   社区线（`#15`）面对同一约束，做法相同（把 `text_digest` 存在契约之外的 `ModerationRecord` 上）。
   若要把内容绑定提升为契约字段，需要契约侧增量。

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
7. **输入绑定是"调用方必须传对同一份内容"的协作口径**（返修 1 · P1）：
   摘要在组件内保证"不一致必被发现"，但组件无法阻止调用方**根本不调用** `mergeModeration`
   而只拿规则层结论去发布——那属于接线口径的跨片依赖（见 §9.5 与 §4.1 清查表）。
   本片能保证的是：**凡走本层**的路径，模型结论都无法覆盖"内容不一致"这个拒绝。
8. **端口执行证据（`model_layer.kinds`）也必须落库**（返修 2 · P1）：
   不放行"没有执行证据"的结论；因此存储层若只存契约 `Moderation` 字段而丢掉
   `model_layer.kinds`，回读时该结论**会**被判不可发布（方向安全，但同样需要接线方配合）。
   这与 §9.5 是同一类约束：**放行所需的事实有一部分在本片的非契约字段里**。

## 11 如何运行

```powershell
npm run test:unit                                       # 已纳入 tests/moderation/*.test.mjs
node --test "tests/moderation/model-*.test.mjs"         # 模型层用例
node --test "tests/moderation/prompt-version.test.mjs"  # prompt 版本派生用例
```

真实命令与输出见 [`../verification/gy-i14-moderation-model-20261012.md`](../verification/gy-i14-moderation-model-20261012.md)。
