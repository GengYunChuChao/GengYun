# GY-I14 第一片 · 确定性硬规则审核层 验证证据（2026-10-11）

> 对象：`packages/moderation/**` + `tests/moderation/**`
> 口径：`Refs #14`（**不关闭整项 #14**）
> 结论一句话：**本片只交付确定性规则层组件，没有任何 HTTP 消费者；模型层与 API 接线为后续增量。**

**本文件中的每个数字、每段输出都是本机实际运行结果**，未运行过的一律标注"未取得"。

## 1 范围与边界（先读）

| 项 | 本片状态 |
| --- | --- |
| 确定性硬规则审核引擎（文本） | 已实现并测试（本机） |
| `rule_version` 内容派生 + 版本重审 | 已实现并测试（本机） |
| 规则级／目标级失败隔离 | 已实现并测试（本机） |
| HTTP 路由与 `app.ts` 接线 | **未做**（派单禁止触碰 `services/api/**`）→ 本组件**无消费者** |
| 图片／多媒体审核、模型判定 | **未做**（模型层增量） |
| `model_version` / `prompt_version` | **不产出**，不使用占位字符串 |
| 真实样本上的模型指标 | **未取得**（真实样本为 0，见 §11） |

## 2 环境与基线

| 项 | 值 |
| --- | --- |
| worktree | `E:\GengYunCommander\GengYun_W6` |
| 分支 | `feat/gy-i14-moderation-rules` |
| 基线 | `upstream/main = 2d562d5b6fb79896ef8935716b90939538f274c2` |
| Node / npm | `v24.16.0` / 随仓库 `engines` |
| Python（test:docs 用） | `3.14.3` |
| 依赖安装 | `npm ci --no-audit --no-fund` → `added 103 packages in 3s` |

## 3 门禁实际输出（本机）

### 3.1 `npm run test:unit` —— 纳入前后对照

**纳入前**（基线提交、本片改动尚未加入时实测）：

```
ℹ tests 683
ℹ suites 0
ℹ pass 682
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 14399.8873
```

**纳入后**（本片把 `tests/moderation/*.test.mjs` 追加进 `test:unit` glob 后实测，含返修轮）：

```
ℹ tests 796
ℹ suites 0
ℹ pass 795
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 14389.8936
```

（`duration_ms` 随机器负载浮动（实测 12s~36s），不参与判定。）

**差值 = 113**，与本片用例数完全相等（`node --test "tests/moderation/*.test.mjs"` 亦为 `tests 113 / pass 113 / fail 0`），
说明**本片用例确实被门禁执行**，不是"写在目录里没人跑"。

#### 用例数口径（93 → 100 → 113，逐次说清）

本片用例数**两轮增长**，本文件所有数字取**最后一次直跑的实测值（113）**：

1. 首次交付：**93** 条；
2. 返修轮 1（指挥预审意见）：补充 6 条错误封套用例（`errors.test.mjs`）+ 1 条引擎选项 fail-closed 用例 ⇒ **100** 条；
3. 返修轮 2（指挥返修令，fail-open 方向）：补充 **13** 条危险类"否定 + 转折/祈使"用例
   （3 条指定形态 + 4 条无标点形态 + 3 条纯否定不误伤 + 1 条取消词生效范围 + 1 条取消词可观测 + 1 条确定性口径）⇒ **113** 条。

按文件分布（逐个文件单独直跑 `node --test <file>` 的实测条数，合计 113）：

| 用例文件 | 条数 | 直跑实测 |
| --- | --- | --- |
| `tests/moderation/contract.test.mjs` | 10 | `tests 10 / pass 10 / fail 0` |
| `tests/moderation/errors.test.mjs` | 6 | `tests 6 / pass 6 / fail 0` |
| `tests/moderation/fail-closed.test.mjs` | 41 | `tests 41 / pass 41 / fail 0` |
| `tests/moderation/isolation.test.mjs` | 5 | `tests 5 / pass 5 / fail 0` |
| `tests/moderation/rule-version.test.mjs` | 10 | `tests 10 / pass 10 / fail 0` |
| `tests/moderation/rules.test.mjs` | 41 | `tests 41 / pass 41 / fail 0` |
| **合计** | **113** | `tests 113 / pass 113 / fail 0` |

三处数字可以互相对上：

1. **本节差额**：`796（纳入后）− 683（纳入前）= 113` = 上表合计；
2. **§5 的逐类条目数**：§5 表格 11 行（11 条规则）对应 `rules.test.mjs` 里
   **11 条命中 + 11 条不命中 = 22 条**独立用例；该文件余下 19 条 = 基线对照／类别覆盖／确定性／
   证据脱敏／`g`/`y` 标志／多规则命中 **6** 条 + 返修轮 2 的否定取消用例 **13** 条
   （1 + 22 + 6 + 13 = 41，与本文件该行实测 `tests 41` 一致）；
3. **§12 的直跑数字**：`node --test "tests/moderation/*.test.mjs"` → `tests 113 / pass 113 / fail 0`。

`fail-closed.test.mjs` 的 41 条 = `INPUT_CASES` 表驱动的 **28** 条输入闸门用例 + **13** 条引擎级／不变式用例。

纳入方式（纯加法，已获指挥授权）：

```diff
-    "test:unit": "node --test \"tests/unit/*.test.mjs\" \"tests/privacy/*.test.mjs\" \"tests/media/*.test.mjs\" \"tests/reference/*.test.mjs\"",
+    "test:unit": "node --test \"tests/unit/*.test.mjs\" \"tests/privacy/*.test.mjs\" \"tests/media/*.test.mjs\" \"tests/reference/*.test.mjs\" \"tests/moderation/*.test.mjs\"",
```

只改这一条脚本字符串：`workspaces` 未动、`package-lock.json` 未动、依赖未增删。

### 3.2 `npm run lint`

```
> gengyun@0.0.0 lint
> node tools/lint-workspaces.mjs

PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）
lint 通过（静态检查；不代表运行期或真实服务已通过）。
```

退出码 `0`。

### 3.3 `npm run test:contract`

```
> node --test "tests/contract/*.test.mjs"

✔ API 错误码与 HTTP 状态映射与契约 states.json 完全一致 (1.2209ms)
✔ API ExecutionMode 与契约 states.json 一致 (0.1319ms)
✔ API 错误码集合与 openapi ErrorCode 枚举一致 (0.2213ms)
✔ 错误码在状态映射中不重复归属 (0.1062ms)
✔ meta.contract_version 与契约 Meta 常量一致，且必填字段齐备 (0.105ms)
✔ Error / ErrorEnvelope 形状与契约一致 (0.0943ms)
ℹ tests 6
ℹ pass 6
ℹ fail 0
```

退出码 `0`。本片**未**向 `tests/contract/**` 增删文件；契约一致性由 `tests/moderation/contract.test.mjs` 直接比对
`packages/contracts/states.json` 与 `openapi.json`（该用例已纳入 `test:unit`）。

### 3.4 `npm run test:docs`

```
> node tools/run-python.mjs tools/validate_development_docs.py

PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables
```

退出码 `0`。

### 3.5 本片用例直跑

```
node --test "tests/moderation/*.test.mjs"
ℹ tests 113
ℹ pass 113
ℹ fail 0
```

## 4 规则清单与 `rule_version` 派生（本机实测值）

```
RULE_VERSION = mr1+sha256:64b8be6ae7bb3bf06c6870090a028e62
RULE_SET_DIGEST(sha256, 64) = 64b8be6ae7bb3bf06c6870090a028e6225298bd79895b2b8478099ab6959a1d7
规则条数 = 11
```

> 上述为**返修轮 2（否定取消机制）之后**的实测值。返修前为
> `mr1+sha256:b0139d79374b93d65c9b80af869fcd0d`（digest `b0139d79…881554`）——
> 规则集内容变化（新增 `negation_cancellers` 选项 + 匹配器实现与版本号变更）**必然**改变版本，
> 这正是 §7 版本重审机制生效的证据。

派生方式：`sha256(stableStringify({ schema, domain, matchers, rules }))`，其中

1. `matchers` = 匹配器 id + 版本号 + **实现源码**（`Function.prototype.toString()`）；
2. `rules` = 每条规则的 id／类别／原因码／标题／说明／严重级别／匹配器／模式（`source` + 排序后的 `flags`）／其它选项；
3. 展示版本取摘要前 32 位十六进制，前缀 `mr1+sha256:`，总长 43 ≤ 契约上限 80。

实测：追加一条规则后版本变为 `mr1+sha256:200a17d13e0c98941e5569c37b24618a`（与当前值不同）。

## 5 逐类规则命中的实际观测（本机 · 规则夹具）

**声明**：下表是**规则夹具上的确定性回归**，不是真实样本评估。夹具来源见 `tests/moderation/_fixtures.mjs`。

| 规则 | 类别 | 原因码 | 命中结论 | 命中偏移 | 不命中结论 | 命中时 `hard_rule_passed` |
| --- | --- | --- | --- | --- | --- | --- |
| MR-01 | `dangerous_usage` | `DANGEROUS_MIX` | `rejected` / `hit` | 2 | `approved` / `evaluated` | `false` |
| MR-02 | `dangerous_usage` | `DOSE_UNBOUNDED` | `rejected` / `hit` | 0 | `approved` / `evaluated` | `false` |
| MR-03 | `label_bound_dose` | `DOSE_NOT_BOUND_TO_LABEL` | `rejected` / `hit` | 0 | `approved` / `evaluated` | `false` |
| MR-04 | `privacy` | `PRIVACY_PII` | `rejected` / `hit` | 7 | `approved` / `evaluated` | `false` |
| MR-05 | `privacy` | `PRIVACY_PII` | `rejected` / `hit` | 0 | `approved` / `evaluated` | `false` |
| MR-06 | `privacy` | `PRIVACY_COORDS` | `rejected` / `hit` | 4 | `approved` / `evaluated` | `false` |
| MR-07 | `prompt_injection` | `PROMPT_INJECTION` | `rejected` / `hit` | 0 | `approved` / `evaluated` | `false` |
| MR-08 | `authority_spoofing` | `FALSE_AUTHORITY` | `rejected` / `hit` | 2 | `approved` / `evaluated` | `false` |
| MR-09 | `safety_claim` | `ABSOLUTE_SAFETY_CLAIM` | `rejected` / `hit` | 4 | `approved` / `evaluated` | `false` |
| MR-10 | `commerce` | `COMMERCE_SOLICITATION` | `rejected` / `hit` | 7 | `approved` / `evaluated` | `false` |
| MR-11 | `commerce` | `COMMERCE_LINK` | `rejected` / `hit` | 8 | `approved` / `evaluated` | `false` |

要点：**命中即 `hard_rule_passed=false`**（命中说明"并非全部规则都未命中"），
**不命中即 `approved`**（证明没有别的规则误拦，即不过度拦截）。

基线对照（干净文本）：

```
decision=approved hard_rule_passed=true counts={"total":11,"evaluated":11,"hits":0,"errors":0,"timeouts":0,"not_evaluated":0}
reason_codes=[]
```

隐私加固实测：命中证据只有 `{field, offset, length, suppressed}`；
用例 `命中证据只含偏移，不含命中原文（隐私红线：正文不得回传）` 断言结果 JSON 里**不含**手机号
`13812345678`、住址片段 `双溪村3组12号`、坐标 `30.274158` 与输入正文本身（实测通过）。

### 5.1 危险类"否定 + 转折/祈使"取消机制（返修轮 2 · fail-open 方向）

**返修前实测（真实漏拦）**：同一探针脚本在返修前后各跑一次，输入完全相同。返修前
**无标点**的"否定 + 转折"句式被判 `approved`——即**放行了危险混配/用量请求**：

| 探针输入 | 返修前 | 返修后 |
| --- | --- | --- |
| `不要单独用，要混配` | `rejected`（靠句读边界，否定词在上一句读段） | `rejected` |
| `不建议这么打，但可以混着打` | `rejected`（同上） | `rejected` |
| `别按标签来，随便加量就行` | `rejected`（同上） | `rejected` |
| `不要单独用而要混配`（无标点） | **`approved` ← 漏拦** | `rejected` |
| `不建议这么打但可以混着打`（无标点） | **`approved` ← 漏拦** | `rejected` |
| `别按标签来但可以随便加量`（无标点） | **`approved` ← 漏拦** | `rejected` |
| `不能脱离标签而随意加倍`（无标点） | **`approved` ← 漏拦** | `rejected` |
| 对照：`不要随意混配，必须按标签单独使用`（纯否定） | `approved`（正确） | `approved`（不变） |
| 对照：`用量必须绑定登记制剂与标签条件，不能脱离标签使用。`（纯否定） | `approved`（正确） | `approved`（不变） |

返修后逐条真实输出（截取）：

```
不要单独用而要混配                    -> decision=rejected hits=[MR-01] reason_codes=["DANGEROUS_MIX"]
不建议这么打但可以混着打              -> decision=rejected hits=[MR-01] reason_codes=["DANGEROUS_MIX"]
别按标签来但可以随便加量              -> decision=rejected hits=[MR-02] reason_codes=["DOSE_UNBOUNDED"]
不能脱离标签而随意加倍                -> decision=rejected hits=[MR-02,MR-03] reason_codes=["DOSE_UNBOUNDED","DOSE_NOT_BOUND_TO_LABEL"]
```

机制（两条可区分的命中路径，用例 `取消词生效可观测` 断言其差异）：

- `mechanism=boundary`：转折词前有标点，否定词落在**上一句读段**，本来就不会压掉命中；
- `mechanism=canceller`：同一句读段内，否定词之后出现取消词
  （`但/但是/而/而是/要/应/应该/建议/最好`）⇒ 否定失效、命中成立，结果里
  `evidence.cancelled=1` 且 `evidence.cancelled_by` 记录具体取消词（实测取到 `而` / `但`）。

**范围隔离实测**：`rule.negation_cancellers` 只挂在 MR-01／MR-02／MR-03 上（用例断言 `['MR-01','MR-02','MR-03']`）；
其它类别的否定护栏行为不变——`按标签使用可以减少残留风险，但不代表完全没有残留。` 返修前后均为 `approved`
（MR-09 仍被压掉），这正是"只对危险两类生效"的证据。

**保留误伤对照（3 条独立用例）**：`不要随意混配…`、`不要在高温时段随意混配…`、`不能脱离标签使用…`
返修后仍**不命中**，证明危险类没有退化成"见否定词就拦"。

**有意付出的代价（如实登记）**：取消词含单字 `要`／`应`，而中文里 `需要`／`主要`／`反应` 等词也含这些字。
因此**无标点**且恰好含这些字的危险类句子可能被**误拦**（over-block）。这是**有意选择**：
危险用法/用量放行（漏拦）比误拦严重得多。该权衡已写入
`docs/moderation/README.md` 的已知限制一节。

**确定性复核（返修后）**：对上述 5 条文本各重复求值 50 次，除墙钟诊断字段 `budget.elapsed_ms` 外
**逐字节完全相同**（`same=50 / diff=0`）；该口径已固化为用例
`确定性口径：除墙钟诊断字段外两次求值完全相同`。

## 6 fail-closed 实际观测（本机）

以下为直接调用引擎后的真实输出（截取）：

```
缺 text -> decision=quarantined hard_rule_passed=false reason_codes=["INPUT_TEXT_MISSING"] evaluated=0/11
text 为空串 -> decision=quarantined hard_rule_passed=false reason_codes=["INPUT_TEXT_EMPTY"] evaluated=0/11
text 落单代理项 -> decision=quarantined hard_rule_passed=false reason_codes=["INPUT_TEXT_ENCODING_INVALID"] evaluated=0/11
未覆盖类型 species -> decision=quarantined hard_rule_passed=false reason_codes=["TARGET_TYPE_NOT_COVERED"] evaluated=0/11
带媒体（图片未审） -> decision=quarantined hard_rule_passed=false reason_codes=["MEDIA_NOT_EVALUATED_BY_RULE_LAYER"] evaluated=0/11
省略 media -> decision=quarantined hard_rule_passed=false reason_codes=["INPUT_MEDIA_MISSING"] evaluated=0/11
未知顶层字段 -> decision=quarantined hard_rule_passed=false reason_codes=["INPUT_UNKNOWN_FIELD"] evaluated=0/11
text getter 抛错 -> decision=quarantined hard_rule_passed=false reason_codes=["INPUT_READ_FAILED","INPUT_TEXT_MISSING"] evaluated=0/11
输入 undefined -> decision=quarantined hard_rule_passed=false reason_codes=["INPUT_NOT_OBJECT"] evaluated=0/11
输入 null -> decision=quarantined hard_rule_passed=false reason_codes=["INPUT_NOT_OBJECT"] evaluated=0/11
空规则集 -> decision=quarantined hard_rule_passed=false reason_codes=["RULE_CATALOG_INVALID"]
超时（脚本化时钟 0→1000ms，预算 50ms） -> decision=quarantined hard_rule_passed=false counts={"total":11,"evaluated":0,"hits":0,"errors":0,"timeouts":11,"not_evaluated":0} reason_codes=["RULE_TIMEOUT"]
```

关键点：

1. **"没跑"不等于"通过"**：上述所有闸门不通过的场景中 `evaluated=0/11`，规则一条都没算求值，
   `hard_rule_passed` 保持 `false`。
2. **未覆盖的 target type 一律隔离**：契约 16 个 `TargetRef.type` 中，本片声明覆盖 8 个
   （`post`/`comment`/`answer`/`conversation`/`transcription`/`ocr`/`dose_card`/`synthesis`），
   其余 8 个逐个实测均 `quarantined` + `TARGET_TYPE_NOT_COVERED`；已覆盖的 8 个干净文本均 `approved`。
3. **带媒体的目标不得由规则层放行**：图片审核属模型层，`media` 非空即隔离；
   且 `media` 必须显式声明——省略 `media` 等同"不知道有没有图片"，同样隔离。
4. **空规则集不得通过**：`rules: []` 走 `RULE_CATALOG_INVALID` + `quarantined`，
   避免"零条规则都没命中所以通过"。
5. **不变式自检**：`{"ok":true,"violations":[]}`；`approved ⟺ hard_rule_passed === true` 由
   `checkDecisionInvariant` 逐条核对，且用例专门验证它能抓住 `undefined`、
   `hard_rule_passed` 为字符串 `'true'`、`reason_codes` 31 项、`approved` 与 `false` 并存等情形。

## 7 版本重审实际观测（本机）

```
旧 rule_version = mr1+sha256:64b8be6ae7bb3bf06c6870090a028e62
追加一条规则后的 rule_version = mr1+sha256:200a17d13e0c98941e5569c37b24618a（不同=true）
同版本重审 -> stale=false action=reuse landing=null publishable=true reason_codes=[]
规则集变化后 -> stale=true action=re_review landing=pending publishable=false reason_codes=["RULE_VERSION_CHANGED","NOT_PUBLISHABLE"]
旧结果在新版本下 isPublishable = {"publishable":false,"reason_codes":["RULE_VERSION_CHANGED"]}
新规则集重跑同一文本 -> decision=rejected rule_version=mr1+sha256:200a17d13e0c98941e5569c37b24618a reason_codes=["COMMERCE_SOLICITATION"]
目标 revision 1→2 -> stale=true landing=pending reason_codes=["TARGET_REVISION_CHANGED","NOT_PUBLISHABLE"]
自称通过但 hard_rule_passed=false -> stale=true landing=quarantined reason_codes=["DECISION_INCONSISTENT"]
```

> 这一组实测在返修轮 2 **之后**重跑，除 `rule_version` 数值外结论完全一致——
> 说明返修只改变了规则集内容（版本随之改变、旧结果失效），没有改变版本重审语义。

要点：

- 规则集内容变化 ⇒ `rule_version` 变化 ⇒ 旧 `approved` 被判定 `stale`、动作为 `re_review`、
  落点 `pending`，且**旧结果在新版本下不可发布**（`isPublishable` 返回 `false`）。
- 新规则集重跑同一文本**结论真的变了**（`approved` → `rejected`），证明不是"只换版本号、行为不变"。
- 目标 `revision` 变化（编辑生成新版本）同样使旧结果失效（`pending`）。
- 目标 `type`/`id` 变化 ⇒ `quarantined`（已不是同一对象）。
- **"自称通过却没有 `hard_rule_passed=true`"⇒ `DECISION_INCONSISTENT` + `quarantined`**，
  即监工对 PR #82 判 P1 的"必要条件未知却放行"形态，在本层被显式判为失效。

## 8 失败隔离实际观测（本机）

```
单条规则抛错 -> decision=quarantined hard_rule_passed=false rules[0].status=error counts={"total":1,"evaluated":0,"hits":0,"errors":1,"timeouts":0,"not_evaluated":0} reason_codes=["RULE_ENGINE_ERROR"]
批量（干净 / 读输入抛错 / 隐私命中）-> 0:approved , 1:quarantined , 2:rejected
批量逐条 reason_codes = [[],["INPUT_READ_FAILED","INPUT_TEXT_MISSING"],["PRIVACY_PII"]]
批量 summary = {"total":3,"approved":1,"rejected":1,"quarantined":1,"other":0,"engine_errors":0}
```

要点：

- 抛错的规则状态是 `error`，**不是** `evaluated`、`matched` 恒为 `false`——异常没被吞成"未命中"。
- 批量里中间一条异常，前后两条判定与**单独求值逐字段一致**（用例 `compareVerdict` 逐字段比对）。
- 另有 `ownKeys` 陷阱抛错的目标，在批量入口被兜底为 `quarantined` + `RULE_ENGINE_ERROR`，不影响其它目标。

## 9 开发过程中的真实失败与处置（保留原始报错）

本片开发中实际出现过 1 次用例失败（首次运行 `node --test "tests/moderation/*.test.mjs"`）：

```
✖ 契约 Moderation 的必填字段被本片诚实拆分为三层，且不重叠 (1.2677ms)
  AssertionError [ERR_ASSERTION]: 三层字段并集必须恰好覆盖契约必填字段
  actual: [ 'decision', 'hard_rule_passed', 'id', 'model_version', 'prompt_version', 'reason_codes', 'rule_version' ]
  expected: [ 'decision', 'hard_rule_passed', 'id', 'model_version', 'prompt_version', 'reason_codes', 'rule_version', 'target_ref' ]
  operator: 'deepStrictEqual'
```

**处置**：这不是"用例写错、把断言改松"，而是我的分层建模漏了一层——
`target_ref` 是"调用方提供、规则层校验后回填"的绑定字段，既不属于规则层产出，也不属于模型层。
于是把它显式建模为第四层 `TARGET_BINDING_FIELDS`（并导出 `MODERATION_FIELD_LAYERS` 供逐项核对），
四层并集恰好等于契约 `Moderation.required`。
**断言只被加强、没有被削弱**：新增了"同一字段不得出现在多层"的检查。

处置后该用例通过，全部 113 条用例通过。

### 9.1 返修轮 2 的失败面（返修令正是冲它而来）

返修前的探针实测显示：**无标点**的"否定 + 转折"句式在危险类规则上被判 `approved`，
即**放行**了危险混配 / 无依据用量请求（4 条实测，见 §5.1 表）。这是本片自己登记的
风险 ①（fail-open 方向），由指挥返修令要求先行修复；返修后 7 条形态全部 `rejected`，且
11 条既有"不命中"用例继续通过。

## 9.2 门禁 `test:unit` 在本机存在**与本片无关**的资源型抖动（原始报错保留）

纳入本片用例后，截至本次记录（2026-10-11，含返修轮 2），`npm run test:unit` 共运行 **14** 次：
**8 次全绿**、**6 次出现失败**（全绿时为 `796 / 795 / fail 0 / skipped 1`；返修轮 1 期间的绿行为 `783 / 782`）。
失败比例随本机内存负载变化，**不是本片稳定性的指标**。
**失败全部落在改动前就存在的 PGlite／加密／子进程／文件生成套件**；
本片用例在直接运行时恒为全绿（见 9.2.4）。

> 回报给监工的最终 HEAD 上，`test:unit` 实测 `796 / 795 / fail 0 / skipped 1`（moderation 失败项为空），
> `lint` / `test:contract` / `test:docs` 均为退出码 0。
> 即：**本报告所述的最终 SHA 上，四条门禁均为绿色**；下文的抖动记录是为了不让监工在别的时刻碰到失败时误判。

### 9.2.1 失败运行之一（完整原始输出已保存）

```
ℹ tests 773
ℹ pass 763
ℹ fail 9
ℹ skipped 1
```

失败项全清单（`✖` 原样）：

```
✖ mixed LF/CRLF output passes and regeneration remains deterministic LF (5965.3284ms)
✖ P2-③ 后台账号 suspended 后同键同体重放 → 403 ACCOUNT_INACTIVE (1290.8634ms)
✖ P2-③ 后台 auth_epoch 递增后同键同体重放 → 403 ACCOUNT_INACTIVE (2010.801ms)
✖ P2-③ 后台关联会话撤销后同键同体重放 → 401 SESSION_EXPIRED (1016.2923ms)
✖ tests\unit\auth-store-pg.test.mjs (7013.9642ms)
✖ tests\unit\gy-i03-db.test.mjs (6972.3947ms)
✖ tests\unit\local-profile-bootstrap.test.mjs (6965.0808ms)
✖ tests\unit\migrations-constraint.test.mjs (6859.1519ms)
✖ actual source CLI rejects pg overrides before any socket connection (5209.1938ms)
```

根因（原始报错，说明是内存耗尽而非逻辑错误）：

```
test at tests\reference\generated-data-check.test.mjs:76:1
✖ mixed LF/CRLF output passes and regeneration remains deterministic LF
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  3221226505 !== 0            # 子进程被 Windows 致命退出码终止（0xC0000409）
      at TestContext.<anonymous> (tests/reference/generated-data-check.test.mjs:87:10)
```

```
test at tests\unit\auth-routes.test.mjs:519:1
✖ P2-③ 后台 auth_epoch 递增后同键同体重放 → 403 ACCOUNT_INACTIVE
  Error: Deriving bits failed
      at scryptSync (node:internal/crypto/scrypt:71:37)
      at hashPassword (services/api/src/auth/password.ts:18:16)
      at AuthService.ensureBootstrapAdmin (services/api/src/auth/service.ts:248:23)
```

四个 PGlite 测试文件整体失败（`'test failed'`，各约 7 秒）——它们的子用例未计入，
故总数 `773 < 783`（少 10 条），与 `fail 9` 自洽。

### 9.2.2 归因实验一：**完全排除**本片用例

只跑改动前就存在的四组用例（`tests/unit` / `tests/privacy` / `tests/media` / `tests/reference`，
**不含** `tests/moderation`），独立运行 4 次，其中第 2 次复现失败：

```
✖ staging own database profile rejects source DB and any pg URL options before sockets (1935.4539ms)
  AssertionError [ERR_ASSERTION]:

  #
  # Fatal process out of memory: ExternalEntityTable::InitializeTable (first segment allocation)
  #

  2147483651 !== 1
      at TestContext.<anonymous> (tests/unit/staging-intake.test.mjs:39:12)
    actual: 2147483651,
    expected: 1,
    operator: 'strictEqual'
```

### 9.2.3 第二种失败形态（返修轮 2 期间新观察到）：**连子进程都生不出来**

机器负载更高时，`node --test` **每个测试文件派生一个子进程**这一层就会失败。
这一次失败项里**包含本片的两个文件**（`tests\moderation\contract.test.mjs`、`tests\moderation\errors.test.mjs`），
**必须说清它们不是因为断言失败**：

```
✖ tests\moderation\contract.test.mjs (2454.442ms)
  Error: spawn UNKNOWN
      at ChildProcess.spawn (node:internal/child_process:441:11)
      at TestContext.<anonymous> (node:internal/test_runner/runner:454:19)
      at FileTest.start (node:internal/test_runner/runner:1177:17)
    errno: -4094,
    code: 'UNKNOWN',
    syscall: 'spawn'
```

同一运行里 `tests\media\lifecycle.test.mjs`、`tests\media\validate.test.mjs` 等**既有**文件报同样的
`Error: spawn UNKNOWN`／`'test failed'`，且该次运行总用例数掉到 `550`（正常 796）——
即操作系统已无法创建进程（errno −4094），**在文件启动阶段就失败**，与本片任何断言无关。
这也是"文件级失败"会让总数骤降的原因：文件没跑起来，它的用例一条都不会计入。

### 9.2.4 结论与影响评估

- **抖动的成因**：本机内存/进程资源耗尽下，派生大量 Node 子进程／PGlite 实例的**既有**用例
  被 V8 OOM、OpenSSL `scryptSync` 内存分配失败终止，或干脆 `spawn UNKNOWN`。
  **先于本片存在**，与本片代码无关。（本机同时有多个写手 worktree 跑同类门禁，是压力来源的合理解释，
  但此处不作断言。）
- **本片影响**：`tests/moderation/**` 为纯同步函数调用，113 条合计约 0.2~0.8 秒，
  **不派生进程、不开端口、不连数据库**；正常负载下**直接运行连续 4 次全绿**（`113 / 113 / fail 0`），
  50 次重复求值逐字节一致（§5.1）。
- **证据缺口（如实登记）**：6 次失败中完整保留 3 次的原始输出（`fail 9` 见 §9.2.1；
  `fail 20`、`fail 23` 见 §9.2.3 与 §3）；另 3 次（`fail 3`、`fail 6`、`fail 10`）只保留了汇总行。
- **给监工的建议**：复核本 PR 时若遇到 `test:unit` 失败，
  请先看失败项里有没有本片文件；**若有，请确认是 `spawn UNKNOWN` 这类资源错误还是断言失败**——
  本片用例的正确复核方式是 `node --test "tests/moderation/*.test.mjs"`
  （113 条，恒为全绿，单进程、约 0.3 秒）。
  这类抖动属既有门禁的机器资源问题，不应记在本 PR 名下；建议由指挥评估是否单独开一项治理任务
  （如给 PGlite 套件串行化、给 node --test 限制并发、或调高内存上限）。

## 10 验证分列（按环境）

| 环境 | 取得情况 | 说明 |
| --- | --- | --- |
| **本机**（Node v24.16.0，Windows） | **已取得** | `lint` / `test:unit` / `test:contract` / `test:docs` 四条门禁均已实跑通过；规则层 **113** 条用例直接运行恒为全绿（单进程约 0.3 秒）；规则命中、fail-closed、版本重审、失败隔离、否定取消 5 组观测均出自本机。注：`test:unit` 在本机存在**与本次改动无关**的资源型抖动（14 次运行中 6 次失败，失败全部落在既有 PGlite／加密／子进程／文件生成套件）——详见 §9.2 |
| **隔离环境**（受限执行沙箱） | **未取得** | 本片为纯函数组件，未做隔离环境实跑；沙箱 ACL 相关证据见既有 `docs/verification/*` 其它文档 |
| **真机**（微信真机） | **未取得** | 本片无小程序改动、无页面；真机证据不适用本轮 |
| **真实供应商**（模型/第三方） | **未取得** | 本片不调用任何模型或外部服务，无真实请求可记录 |
| **真实样本** | **0** | `docs/evaluation/sample-gap-register.md` 第 9／10 行确认 `ai_moderation_risk` / `ai_moderation_normal` **实际到位均为 0**；该文档 §2 明确"不可用演示样本替代"。因此本片**不提供**任何模型准确率／召回率数字 |

## 11 未取得项与阻塞（如实）

1. **HTTP 消费方**：无路由、无 `app.ts` 接线（派单禁止触碰 `services/api/**`），因此本组件当前
   **不可能**被任何请求触达；`Moderation` 落库、契约错误码映射（`error_status_map`）、
   幂等／`If-Match` 语义均**未实现**。组件内错误码显式带 `http_status: null`，**不伪造**已映射。
2. **模型层字段**：`model_version` / `prompt_version` 未产出；`toRuleLayerDraft()` 明确
   `complete:false` 与 `missing_contract_fields:["id","model_version","prompt_version"]`。
3. **图片／多媒体审核**：未实现。带媒体目标一律不得 `approved`（这是刻意 fail-closed，不代表安全）。
4. **真实样本指标**：真实样本 0，本片无任何模型指标可报。
5. **单条规则不可被抢占**：预算检查发生在规则之间，病态规则内部的死循环无法在进程内中断；
   进程级超时属接线增量。本层以 20000 字符文本上界限制单条规则成本。
6. **否定护栏是确定性启发式**：同句读段内的"否定 + 转折"仍可能漏拦（已知方向见
   `docs/moderation/README.md` 第 7 节"已知限制"）。
7. **`tests/contract/**` 未纳入本片**：契约一致性用例放在 `tests/moderation/contract.test.mjs`
   （已进 `test:unit`）；若监工要求它同时进 `test:contract`，属可改动的接线，本片未擅自扩大改动面。

## 12 复现命令

```powershell
cd E:\GengYunCommander\GengYun_W6
npm ci --no-audit --no-fund
npm run lint
npm run test:unit
npm run test:contract
npm run test:docs
node --test "tests/moderation/*.test.mjs"
```
