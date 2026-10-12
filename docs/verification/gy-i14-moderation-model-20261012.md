# GY-I14 第二片 · 模型层（端口 · 合流 · 版本绑定 · 失败隔离）验证证据（2026-10-12）

> 对象：`packages/moderation/**`（模型层新增文件）+ `tests/moderation/**` + `docs/moderation/model-layer.md`
> 口径：`Refs #14`（**不关闭整项 #14**）
> 结论一句话：**本片只交付模型层组件（可注入且默认关闭的端口、合流层、prompt 版本派生、版本绑定重审、失败隔离）；不注册路由、无 HTTP 消费者；真实 `tms`/`ims` 一次未调。**

**本文件中的每个数字、每段输出都是本机实际运行结果**，未运行过的一律标注"未取得"。

## 1 范围与边界（先读）

| 项 | 本片状态 |
| --- | --- |
| 文字（`tms`）／图片（`ims`）模型端口（可注入、默认关闭） | 已实现并测试（本机，**合成替身**） |
| 合流层：规则层结论 + 模型结论 ⇒ 完整合法契约 `Moderation`（`id` 除外） | 已实现并测试（本机） |
| `prompt_version` 内容派生（改一字必变） | 已实现并测试（本机） |
| 三元组版本绑定与重审失效 | 已实现并测试（本机） |
| 失败隔离 fail-closed（13 类失败矩阵） | 已实现并测试（本机） |
| HTTP 路由与 `services/api/**` 接线 | **未做**（派单禁止触碰）→ 本组件**无消费者** |
| 真实 `tms`/`ims` 调用 | **未做**（未交接真实 `BizType`，占位值 `policySelectionVerified:false`） |
| 模型准确率／召回率 | **未取得**（AI 筛查类真实样本为 0，见 `docs/evaluation/sample-gap-register.md`） |
| 带媒体目标的 `approved` 路径 | **仍不可达**（规则层对带媒体目标一律不判通过；属跨片依赖） |

## 2 环境与基线

| 项 | 值 |
| --- | --- |
| worktree | `E:\GengYunCommander\GengYun_W12` |
| 分支 | `feat/gy-i14-moderation-model` |
| 基线 | `upstream/main = d55629237b38931edc7a1c05c6745c490838e600`（开工前 `git fetch upstream --prune` 复核未变） |
| Node / npm | `v24.16.0` / 随仓库 `engines` |
| Python（`test:docs` 用） | `3.14.3` |
| 依赖安装 | `npm ci --no-audit --no-fund` → `added 103 packages in 12s` |

## 3 门禁实际输出（本机）

### 3.1 `npm run lint`（exit 0）

```
> gengyun@0.0.0 lint
> node tools/lint-workspaces.mjs

PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）
lint 通过（静态检查；不代表运行期或真实服务已通过）。
```

### 3.2 `npm run test:unit` —— 纳入前后对照（含一次**既有 flaky** 的如实记录）

**纳入前**（基线提交 `d5562923` 上实测，本片改动尚未加入）：

```
ℹ tests 819
ℹ suites 0
ℹ pass 818
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 21540.3064
```

**纳入后**（本片改动加入后实测；共 7 次全量运行，**6 次 0 失败、1 次出现 1 条既有用例抖动**）：

| 序号 | 场合 | tests | pass | fail | exit | 失败用例 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 开发完成后首次全量 | 932 | 931 | 0 | 0 | — |
| 2 | 最终扫描 | 932 | 930 | 1 | 1 | `rules.test.mjs:30`（**规则层**基线对照，非本片文件） |
| 3 | 复跑 1 | 932 | 931 | 0 | 0 | — |
| 4 | 复跑 2 | 932 | 931 | 0 | 0 | — |
| 5 | 复跑 3 | 932 | 931 | 0 | 0 | — |
| 6 | 夹具改为显式预算后·复跑 4 | 932 | 931 | 0 | 0 | — |
| 7 | 夹具改为显式预算后·复跑 5 | 932 | 931 | 0 | 0 | — |

第 2 次那一条的原始输出（节选）：

```
test at tests\moderation\rules.test.mjs:30:1
✖ 干净文本应当放行：approved 且 hard_rule_passed 为 true（基线对照） (64.2989ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + 'quarantined'
  - 'approved'
```

**这是本片改动之前就存在的墙钟预算敏感性**，不是本片新增用例失败：

- 该用例属**规则层**（`rules.test.mjs` 只 import `constants`/`matchers`/`rules`/`engine` 与 `_fixtures.mjs`，**不加载任何模型层文件**）；
- 用时 64.3ms **超过规则层默认墙钟预算 `DEFAULT_RULE_BUDGET_MS = 50`**，机制用同一输入直接复现如下
  （只把时钟拖慢，输入与规则集完全不变）：

```
默认预算（0ms 级时钟）: approved hard_rule_passed= true reason_codes= []
同一输入、仅时钟被拖慢 1000ms: quarantined hard_rule_passed= false reason_codes= ["RULE_TIMEOUT"] counts.timeouts= 11
默认预算常量 DEFAULT_RULE_BUDGET_MS = 50
```

- 规则层**自己的**用例（`tests/moderation/fail-closed.test.mjs` 的"规则预算耗尽 ⇒ 未求值的规则不得算通过"）
  已经把这个行为写成规格，所以"干净文本 ⇒ approved"这条基线断言**依赖墙钟**，在整套 `test:unit`
  并行（含 PGlite／Postgres／HTTP 集成用例）时可能偶发抖动；
- 本片**已把自己的一半摘干净**：模型层夹具一律显式给足预算（`_model-fixtures.mjs` 的 `RULE_BUDGET_MS = 5000`），
  因此**本片新增的 113 条用例在 7 次实测中全部通过**，不受该抖动影响；
- 夹具改为显式预算之后的 2 次全量运行均为 `932 / 931 / 0 fail`（序号 6、7）；
- **未改** `rules.test.mjs`：它属第一片（PR #88 已合并），改它就是动别人片的既有断言；
  建议由规则层 owner 用一行修掉（给该调用显式 `budget_ms`，或在规则层用例里注入时钟），本片不代改。

**基线侧的对照实测（如实记录，不夸大）**：在 `d5562923` 的独立 worktree（`E:\GengYunCommander\.w12-i14-baseline`，
`npm ci` 后）跑 `npm run test:unit` 共 4 次：3 次正常 + 1 次在 **20 个 CPU 占满进程**下跑，
结果都是 `819 / 818 / 0 fail`——即**没能**在基线侧复现该抖动。因此本片只主张"该断言的失败机制在规则层、
且本片新增用例全部稳定通过"，**不主张**已用统计方法证明它在基线上同样高频。

**差值（本片新增用例口径）**：`tests 819 → 932`（**+113**）、`pass 818 → 931`（**+113**，抖动的那 1 条属既有用例）、
`fail 0`（本片用例始终 0 失败）。根 `package.json` **未改动**。

### 3.3 `tests/moderation/**` 前后数字对照（单目录）

| 时点 | tests | pass | fail | 命令 |
| --- | --- | --- | --- | --- |
| 改动前（基线） | 122 | 122 | 0 | `node --test "tests/moderation/*.test.mjs"` |
| 改动后 | 235 | 235 | 0 | 同上 |

**+113**，全部来自新增文件；既有 122 条**逐条继续通过**（规则层既有断言未变）。

新增文件逐项数字（各自单独跑）：

| 文件 | tests | pass |
| --- | --- | --- |
| `tests/moderation/model-merge.test.mjs` | 18 | 18 |
| `tests/moderation/model-fail-closed.test.mjs` | 34 | 34 |
| `tests/moderation/model-ports.test.mjs` | 37 | 37 |
| `tests/moderation/prompt-version.test.mjs` | 8 | 8 |
| `tests/moderation/model-review.test.mjs` | 16 | 16 |

### 3.4 `npm run test:contract`（exit 0）

```
> gengyun@0.0.0 test:contract
> node --test "tests/contract/*.test.mjs"

✔ API 错误码与 HTTP 状态映射与契约 states.json 完全一致 (1.7125ms)
✔ API ExecutionMode 与契约 states.json 一致 (0.2106ms)
✔ API 错误码集合与 openapi ErrorCode 枚举一致 (0.2904ms)
✔ 错误码在状态映射中不重复归属 (0.1019ms)
✔ meta.contract_version 与契约 Meta 常量一致，且必填字段齐备 (0.1171ms)
✔ Error / ErrorEnvelope 形状与契约一致 (0.1149ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 201.0711
```

### 3.5 `npm run test:docs`（exit 0）

```
> gengyun@0.0.0 test:docs
> node tools/run-python.mjs tools/validate_development_docs.py

PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
```

> 备注（如实记录过程）：本文件与 `docs/moderation/model-layer.md` 首次运行 `test:docs` 时曾以
> `model-layer.md:75: inconsistent table` 与 `model-layer.md: missing link ../verification/gy-i14-moderation-model-20261012.md`
> 失败——表格单元格里的裸 `|` 会被校验器当成列分隔符，且被引用文件当时尚未创建。两处均已修正，上面是**修正后**实测。

## 4 新增文件清单与职责

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `packages/moderation/prompts.mjs` | 86 | prompt 定义集中定义处（文本／图片两个 prompt；声明式，无执行能力） |
| `packages/moderation/prompt-version.mjs` | 190 | 由 prompt 定义内容派生 `prompt_version`（复用规则层 `stableStringify`） |
| `packages/moderation/model-reason-codes.mjs` | 88 | 模型层原因码闭集（22 个 `MODEL_*`，与规则层闭集零重叠） |
| `packages/moderation/model-verdict.mjs` | 130 | 模型回报形状归一（形状齐备；自由文本一律丢弃，只留计数） |
| `packages/moderation/model-ports.mjs` | 302 | 端口契约与校验、失败归类、离线请求信封、图片引用归一 |
| `packages/moderation/model-review.mjs` | 151 | 三元组版本绑定、重审失效、发布口径 |
| `packages/moderation/merge.mjs` | 695 | 合流层（决策唯一出口、契约装配、形状与不变式自检） |
| `tests/moderation/_model-fixtures.mjs` | 132 | 合成夹具（端口替身、合法/非法输入、既有结论） |
| `tests/moderation/model-merge.test.mjs` | 365 | 合流主口径 + 正控制 + 契约结构校验 + 未接线等价性 |
| `tests/moderation/model-fail-closed.test.mjs` | 381 | 失败隔离矩阵（13 类 fail-closed + 不得翻案 + 输入类失败） |
| `tests/moderation/model-ports.test.mjs` | 317 | 端口契约、"默认关闭"结构性证据、失败归类、引用归一 |
| `tests/moderation/prompt-version.test.mjs` | 166 | prompt 版本派生（改一字必变、归一化、非法定义） |
| `tests/moderation/model-review.test.mjs` | 283 | 版本绑定与重审失效三组独立反例 + 发布口径 |

改动的**既有**文件（逐条说明，规则层语义未动）：

| 文件 | 改动 | 影响 |
| --- | --- | --- |
| `packages/moderation/index.mjs` | 头部边界说明重写 + **追加** 7 行 `export *` | 只增加出口；无既有导出被改名或删除 |
| `packages/moderation/README.md` | 头部边界说明与出口一览更新 + 新增模型层小节 | 纯文档 |
| `docs/moderation/model-layer.md` | 新增 | 纯文档 |
| `docs/verification/gy-i14-moderation-model-20261012.md` | 新增（本文件） | 纯文档 |

**未触碰**：`packages/contracts/**`、`packages/privacy/**`、`packages/{media,reference,knowledge,evaluation}/**`、
`services/api/**`、`apps/admin/**`、`miniprogram/**`、`tools/prepare-wechat.mjs`、
根 `package.json` / `package-lock.json`、`.github/workflows/**`。规则层 8 个 `.mjs`（`constants`/`matchers`/`rules`/
`rule-version`/`validate-input`/`engine`/`batch`/`review`）**逐字节未改**。

## 5 合流层如何复用规则层接口

| 规则层接口 | 合流层的用法（`merge.mjs` / `model-review.mjs`） |
| --- | --- |
| `pending_model_layer_fields` | **准入闸门**：声明必须恰为 `['model_version','prompt_version']`；缺失/不全 ⇒ `MODEL_LAYER_DECLARATION_MISSING`；规则层自带这两个字段 ⇒ `MODEL_LAYER_FIELD_SPOOFED` 且**不采信其值** |
| `missingContractFields()` | **缺失清单唯一权威**：调用后过滤出"仍缺什么"。补全 ⇒ `['id']`；补不上 ⇒ 如实报缺且 `contract_value === null`（不装配半成品、不填占位） |
| `orderReasonCodes` / `truncateReasonCodes` | 原因码排序与截断复用同一实现 |
| `evaluateReReview` | 规则版本／目标绑定／结构自洽全部委派；本层只追加模型与 prompt 版本两项比较（`model-review.mjs`） |
| `isPublishable` | 发布口径委派，再 `AND` "模型／prompt 版本与当前一致" |
| `REVIEW_ACTIONS` / `REVIEW_LANDINGS` | 动作与落点沿用同一闭集，不另立标准 |
| `MODEL_LAYER_FIELDS` | 只读消费，未修改规则层常量 |
| `MODERATION_ERROR_CODES` | 错误封套码仍只有这三个值，**未新增错误码、未新增契约字段** |

合流结果顶层字段与契约 `Moderation` 同名，可直接喂给规则层 `evaluateReReview` / `isPublishable`（有用例断言）。

## 6 `prompt_version` 派生方式与样例值

派生输入 = schema `mp1` + 域 `gengyun.moderation.model-prompts` + 参与本次筛查的 prompt 定义
（按 id 排序，顺序无关）：`system` / `user_template` / `purpose` / `policy_notes` **原文逐字符**参与哈希，
`placeholders` / `required_output_fields` / `verdict_labels` 排序去重后参与。

| 项 | 实测值 |
| --- | --- |
| 文本 prompt 单独版本 | `mp1+sha256:e24f2f6a556034373f889fa6b5fec386` |
| 图片 prompt 单独版本 | `mp1+sha256:d00373e881c3bbc72998d05fc8342d50` |
| 文本 + 图片集合版本 | `mp1+sha256:f0e8f336b99eddb91c035d429912e323` |
| 规则层 `rule_version`（本片未改动） | `mr1+sha256:736efcf2abc48c2c39a5036140eabbea` |

"改一个字符 ⇒ 版本必变"已覆盖 `user_template` / `system` / `purpose` / `policy_notes` /
`required_output_fields` / `verdict_labels` / `placeholders` 六类字段，全部断言版本改变。

## 7 `reason_codes` 超限口径：截断（不是拒绝）

- 排序：规则层码在前（沿用 `orderReasonCodes`），模型层码按闭集声明序在后，去重；
- 长度越界（`<1` 或 `>80`）的项裁掉并置顶 `REASON_CODES_TRUNCATED`；去重后仍 >30 条则从尾部截断；
- 全量留在非契约字段 `reason_codes_full`，丢弃计数在 `invalid_dropped_count`；
- **理由**：(1) 契约 `maxItems: 30` 是硬上限，"拒绝"会让整条不产出契约对象、调用方拿不到任何结论；
  (2) 规则层既有口径就是"截断 + 置顶标记 + 诊断留全量"，沿用可避免两套语义；
  (3) 决策由 `decision` 决定，原因码只是证据标签，**裁码不改变决策**——有专门反例断言
  `quarantined` / `rejected` 不因截断变成 `approved`。

## 8 失败隔离矩阵（哪类失败落哪个 decision）

| 失败类别 | decision | 原因码 |
| --- | --- | --- |
| 未注入所需端口 | `quarantined` | `MODEL_LAYER_PORT_MISSING` |
| 端口形状非法（非对象／`evaluate` 非函数／`seams` 缺声明／`provider` 缺字段或类型错／kind 不符） | `quarantined` | `MODEL_LAYER_PORT_INVALID` |
| BizType 未核验 | `quarantined` | `MODEL_BIZTYPE_UNVERIFIED`（端口**一次都没被调用**） |
| 规则层未按接口声明 / 冒充模型层字段 | `quarantined` | `MODEL_LAYER_DECLARATION_MISSING` / `MODEL_LAYER_FIELD_SPOOFED` |
| 提供者未回报合法 `model_version` | `quarantined` | `MODEL_VERSION_MISSING`（`missing_contract_fields` 含它，`contract_value=null`） |
| 两个 kind 回报不同模型标识 | `quarantined` | `MODEL_VERSION_CONFLICT` |
| 超时（抛 `TimeoutError` / 超 `deadline_ms`） | `quarantined` | `MODEL_TIMEOUT` |
| 配额耗尽（429 / 显式声明） | `quarantined` | `MODEL_QUOTA_EXCEEDED` |
| 鉴权失败（401 / 403） | `quarantined` | `MODEL_AUTH_FAILED` |
| 载荷非法（端口判定 / 400 / 描述符夹带 `bytes` 或未知字段） | `quarantined` | `MODEL_PAYLOAD_INVALID` |
| 非图片媒体（本片只承担图片） | `quarantined` | `MODEL_MEDIA_UNSUPPORTED` |
| 未知响应形状（非对象／缺 `label`／越界／缺必报字段／版本矛盾） | `quarantined` | `MODEL_RESPONSE_SHAPE_UNKNOWN` |
| 端口抛无法归类的异常 | `quarantined` | `MODEL_PORT_ERROR` |
| 模型 `unsure` | `quarantined` | `MODEL_NOT_EVALUATED` |
| 模型明确 `block` | `rejected` | `MODEL_BLOCKED` |
| `content` 与规则层输入不一致／非法 `execution_mode`／规则层结果自相矛盾 | `quarantined` | `MODEL_MERGE_INPUT_INVALID` |
| 规则层 `rejected` + 模型通过 | `rejected` | 规则层原因码保留（模型**不得翻案**） |
| 规则层 `quarantined` + 模型通过 | `quarantined` | 规则层原因码保留 |
| 带媒体 + 图片端口不可用 | `quarantined` | `MODEL_LAYER_PORT_MISSING` + `MEDIA_NOT_EVALUATED_BY_RULE_LAYER` |
| 带媒体 + 图片端口通过 | `quarantined` | `MEDIA_NOT_EVALUATED_BY_RULE_LAYER`（硬规则一条没跑，"没跑"≠"通过"） |
| 输入闸门不通过 | `quarantined`（模型层不尝试） | 规则层原因码；**不追加**模型层噪音码 |

## 9 回退-复跑（用例有牙齿的证明，原始输出）

### 9.1 回退 A：去掉合流层的 fail-closed 守卫

- 回退内容：把决策分支的 `failClosedCodes.length > 0 || !kindsAllPass` 与最后一道闸的同样条件删掉，
  只保留 `hardRulePassed` 判断（即"模型失败也算通过"的形态）。
- 复跑：`node --test "tests/moderation/model-fail-closed.test.mjs"`，原始输出摘要：

```
exit code: 1
ℹ tests 34
ℹ pass 12
ℹ fail 22
  AssertionError [ERR_ASSERTION]: 缺端口: 不得判为通过
  AssertionError [ERR_ASSERTION]: evaluate 非函数: 不得判为通过
  AssertionError [ERR_ASSERTION]: provider 缺字段: 不得判为通过
```

（失败清单含：缺端口、端口非法、BizType 未核验、`model_version` 缺失、超时×2、配额×2、鉴权×2、
载荷非法×2、形状未知×4、端口抛错、`unsure`、`hard_rule_passed` 只反映规则层 等 22 条。）

- 恢复：用备份覆盖回原文件，复核 SHA256 一致（实测 `sha256 一致 = True`），恢复后该文件 34/34 通过。

### 9.2 回退 B：prompt 文本不再参与哈希

- 回退内容：`canonicalPrompt` 不再把 `purpose` / `system` / `user_template` / `policy_notes` 放进派生输入
  （只留 `id` 与排序后的集合字段）。
- 复跑：`node --test "tests/moderation/prompt-version.test.mjs"`，原始输出摘要：

```
exit code: 1
ℹ tests 8
ℹ pass 6
ℹ fail 2
  AssertionError [ERR_ASSERTION]: user_template 追加一个字符 必须改变 prompt 版本
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
```

- 恢复：同上，复核 SHA256 一致（实测 `sha256 一致 = True`），恢复后该文件 8/8 通过。

## 10 契约缺口与跨片依赖（如实登记）

1. **`model_version` 只有一个字段，一次筛查可能用到两个模型**（`tms` + `ims`）：本片对"回报不一致"
   选择 `MODEL_VERSION_CONFLICT` + `quarantined`，**未新增契约字段**；正确表达多模型绑定需契约增量。
2. **契约未定义模型层原因码闭集**：本片新增的是组件内原因码（`MODEL_*`，与规则层闭集零重叠），
   错误封套码与契约错误码**一个都没新增**；若要求全仓统一原因码闭集，需契约/治理层给清单。
3. **契约没有"模型是否跑过"的字段**：该证据只能在非契约诊断字段（`model_layer.status` / `kinds[*].status`）
   里表达，契约对象只能靠 `MODEL_*` 原因码间接推断。
4. **跨片依赖（最重要）**：带媒体目标在本片**不可能** `approved`——规则层对该类目标不判通过且
   硬规则一条未跑，而 `hard_rule_passed` 只反映规则层事实。要让图片目标真正可达 `approved`，
   必须由**规则层口径变更**（对媒体目标的文本部分求值／显式扩大 `COVERED_TARGET_TYPES`）配合，
   本片**不擅自改**规则层语义。
5. **跨片依赖**：本组件仍**无 HTTP 消费者**。任何 API 接线增量必须改为调用 `mergeModeration`
   （而不是只看规则层的 `approved`），否则"规则层通过"仍会被当成"可以放行"——这正是本片要堵的口子。

## 11 未做与不得声称

- 未注册路由、未改 `services/api/**`、未做持久化、未映射契约错误码；
- 未调用任何真实 `tms`/`ims`（无真实 `BizType`），**未取得**任何真实服务证据；
- **不声称**任何准确率／召回率；**不声称**"AI 筛查已完成"或"发布链已通"；
- 正控制中的 `approved` 来自 `provider.synthetic === true` 的合成端口，只作确定性回归，
  不得被引用为真实模型能力证据。

## 12 写手自评：监工最可能挑出的 3 个点

1. **"你新增了 `MODEL_*` 原因码，而派单说不得新增错误码"**：本片新增的是 `reason_codes` 取值
   （契约只约束类型与长度，不约束闭集），**错误封套码与契约错误码一个都没新增**；
   复用规则层码会让"模型超时"被报成 `RULE_TIMEOUT`、把"模型版本变化"报成 `RULE_VERSION_CHANGED`，
   即原因码说谎。取舍与代价见 `docs/moderation/model-layer.md` §9.2。
2. **"带媒体的目标仍然拿不到 `approved`，那你的图片审核到底交付了什么"**：交付的是端口契约与注入方式、
   失败矩阵、以及"带媒体 + 模型不可用 ⇒ 不得通过"的反例；抬成 `approved` 与
   "`hard_rule_passed` 只反映规则层事实"直接冲突，属跨片依赖（规则层媒体口径）。
   这是**刻意**的保守口径，不是遗漏；见 §10.4 与 `model-layer.md` §5。
3. **"合流结果出现 `hard_rule_passed=true` + `decision='quarantined'`，和你们自己文档里的
   `approved ⟺ hard_rule_passed` 矛盾"**：矛盾只存在于**规则层**不变式；合流层有两个判定者，
   只有单向必要条件 `approved ⟹ hard_rule_passed === true`，并另设 `checkMergedInvariant`。
   这是本片 fail-closed 的主线（规则过了 ≠ 整体过了），已在 `model-layer.md` §4 显式列表说明。
