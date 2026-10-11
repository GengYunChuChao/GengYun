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

**纳入后**（本片把 `tests/moderation/*.test.mjs` 追加进 `test:unit` glob 后实测）：

```
ℹ tests 783
ℹ suites 0
ℹ pass 782
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 13217.513
```

**差值 = 100**，与本片用例数完全相等（`node --test "tests/moderation/*.test.mjs"` 亦为 `tests 100 / pass 100 / fail 0`），
说明**本片用例确实被门禁执行**，不是"写在目录里没人跑"。

#### 用例数口径（消除 93 与 100 两个数字的歧义）

本片用例数**从 93 增至 100**：首次交付时为 **93** 条；随后应指挥预审意见补充了
**6 条错误封套用例**（`tests/moderation/errors.test.mjs`）与
**1 条引擎选项 fail-closed 用例**（`evaluateHardRules` 的选项非法场景），合计 **100** 条。
本文件所有数字均取**最后一次直跑的实测值**（即 100）。

按文件分布（逐个文件单独直跑 `node --test <file>` 的实测条数，合计 100）：

| 用例文件 | 条数 | 直跑实测 |
| --- | --- | --- |
| `tests/moderation/contract.test.mjs` | 10 | `tests 10 / pass 10 / fail 0` |
| `tests/moderation/errors.test.mjs` | 6 | `tests 6 / pass 6 / fail 0` |
| `tests/moderation/fail-closed.test.mjs` | 41 | `tests 41 / pass 41 / fail 0` |
| `tests/moderation/isolation.test.mjs` | 5 | `tests 5 / pass 5 / fail 0` |
| `tests/moderation/rule-version.test.mjs` | 10 | `tests 10 / pass 10 / fail 0` |
| `tests/moderation/rules.test.mjs` | 28 | `tests 28 / pass 28 / fail 0` |
| **合计** | **100** | `tests 100 / pass 100 / fail 0` |

三处数字可以互相对上：

1. **本节差额**：`783（纳入后）− 683（纳入前）= 100` = 上表合计；
2. **§5 的逐类条目数**：§5 表格 11 行（11 条规则）对应 `rules.test.mjs` 里
   **11 条命中 + 11 条不命中 = 22 条**独立用例；该文件余下 6 条为基线对照、类别覆盖、
   确定性、证据脱敏、`g`/`y` 标志与多规则命中专项用例（1 + 22 + 5 = 28）；
3. **§12 的直跑数字**：`node --test "tests/moderation/*.test.mjs"` → `tests 100 / pass 100 / fail 0`。

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
ℹ tests 100
ℹ pass 100
ℹ fail 0
```

## 4 规则清单与 `rule_version` 派生（本机实测值）

```
RULE_VERSION = mr1+sha256:b0139d79374b93d65c9b80af869fcd0d
RULE_SET_DIGEST(sha256, 64) = b0139d79374b93d65c9b80af869fcd0d86c0b8d78006d1f614d2bfe639881554
规则条数 = 11
```

派生方式：`sha256(stableStringify({ schema, domain, matchers, rules }))`，其中

1. `matchers` = 匹配器 id + 版本号 + **实现源码**（`Function.prototype.toString()`）；
2. `rules` = 每条规则的 id／类别／原因码／标题／说明／严重级别／匹配器／模式（`source` + 排序后的 `flags`）／其它选项；
3. 展示版本取摘要前 32 位十六进制，前缀 `mr1+sha256:`，总长 43 ≤ 契约上限 80。

实测：追加一条规则后版本变为 `mr1+sha256:22c171e7cc99aa8900d9dcdb19194dcc`（与旧值不同）。

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
旧 rule_version = mr1+sha256:b0139d79374b93d65c9b80af869fcd0d
追加一条规则后的 rule_version = mr1+sha256:22c171e7cc99aa8900d9dcdb19194dcc（不同=true）
同版本重审 -> stale=false action=reuse landing=null publishable=true reason_codes=[]
规则集变化后 -> stale=true action=re_review landing=pending publishable=false reason_codes=["RULE_VERSION_CHANGED","NOT_PUBLISHABLE"]
旧结果在新版本下 isPublishable = {"publishable":false,"reason_codes":["RULE_VERSION_CHANGED"]}
新规则集重跑同一文本 -> decision=rejected rule_version=mr1+sha256:22c171e7cc99aa8900d9dcdb19194dcc reason_codes=["COMMERCE_SOLICITATION"]
目标 revision 1→2 -> stale=true landing=pending reason_codes=["TARGET_REVISION_CHANGED","NOT_PUBLISHABLE"]
自称通过但 hard_rule_passed=false -> stale=true landing=quarantined reason_codes=["DECISION_INCONSISTENT"]
```

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

处置后该用例通过，全部 100 条用例通过。

## 9.2 门禁运行中观察到的一次**与本片无关**的资源型抖动（原始报错保留）

在反复运行门禁时，观察到过一次**不绿色**的 `test:unit`：

```
ℹ tests 773
ℹ pass 769
ℹ fail 3
ℹ skipped 1
```

**归因过程（先排除本片，再下结论）**：把本片的 `tests/moderation/*.test.mjs` **完全排除**，
只跑改动前就存在的四组用例（`tests/unit` / `tests/privacy` / `tests/media` / `tests/reference`），
在第 2 次重复运行中复现了失败：

```
✖ staging own database profile rejects source DB and any pg URL options before sockets (1935.4539ms)
  AssertionError [ERR_ASSERTION]:

  #
  # Fatal process out of memory: ExternalEntityTable::InitializeTable (first segment allocation)
  #

  2147483651 !== 1
      at TestContext.<anonymous> (file:///E:/GengYunCommander/GengYun_W6/tests/unit/staging-intake.test.mjs:39:12)
    actual: 2147483651,
    expected: 1,
    operator: 'strictEqual'
```

即：**既有**用例 `tests/unit/staging-intake.test.mjs:30` 派生的子进程在本机内存压力下被 V8 OOM 终止
（Windows 致命退出码 `2147483651`），而该用例断言退出码必须为 `1`。与本片代码无关。

随后 `npm run test:unit` 连续 5 次运行均为 `783 tests / 782 pass / fail 0 / skipped 1`。
**未保留失败那一次的完整原始日志**（仅保留了复现实验中的这段堆栈）——这是本次证据的一处缺口，如实登记。

**对本片的影响评估**：本片用例为纯同步函数调用，100 条合计约 0.3 秒、不派生进程、不开端口、不连数据库，
因此本片把 `tests/moderation/*.test.mjs` 纳入门禁对上述内存压力**几乎无影响**；
但"门禁存在与本次改动无关的资源型抖动"这一点仍应让监工知晓。

## 10 验证分列（按环境）

| 环境 | 取得情况 | 说明 |
| --- | --- | --- |
| **本机**（Node v24.16.0，Windows） | **已取得** | `lint` / `test:unit` / `test:contract` / `test:docs` 四条门禁实跑通过；规则层 100 条用例通过；§4~§8 观测均出自本机 |
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
