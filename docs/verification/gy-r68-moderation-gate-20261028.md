# GY-R68 P1-a 社区发帖审核门负控制证据（2026-10-28）

本页是**负控制证据页**：把「默认装配下 `POST /posts` 一定被审核门挡住」这句话，从侦察报告里的**两段实测拼接**（审核域探针 + 代码路径阅读）升成**一条可复跑的端到端读数**——完整 `buildApp` + 真实 loopback HTTP 提交，并配一条正控制证明「422 不是别的门挡的」。

- 取证时间：2026-10-28 20:53–21:20（Asia/Hong_Kong，UTC+08:00）。
- 主机：`春秋蝉鸣少年归`（Windows 10.0.26200，Intel i7-12650H），Node `v24.16.0`。
- 基线提交：`da61b64dfba0d0ee7fb907f2e4169063f9b0bf1a`（`docs: refresh drill evidence on existing main revision (#735)`）。
- 工作树/分支：`wt-r68-p1a` / `test/gy-r68-moderation-negative-control`（由 `da61b64d` 新建）。
- 改动面：**只碰 `tests/**` 与本页**。`services/**`、`apps/**`、`packages/**`、迁移、`.github/**`、`tools/**` **一行未改**（读数见 §7）。
- 术语：「默认装配」= `buildApp` 不给审核域注入任何**服务**、**端口**、**权威**（`moderationInjection` 缺省或只带规则层选项）。它与产品装配路径上的「零端口注入」是同一件事：`services/api/src/app.ts:932` 的注释原文「**应用装配路径永不注入真实适配器端口（零端口注入）**」，装配点 `services/api/src/app.ts:935`。

## 0 结论摘要（三次读数，同一条请求）

| # | 装配 | `POST /api/v1/posts` | 内容行 | `GET /api/v1/posts` |
| --- | --- | --- | --- | --- |
| A | **纯默认**（连 `moderationInjection` 键都不传） | **422 `INPUT_UNCERTAIN`** | **0 行**（`insertPost` 未被调用） | 200（0 条） |
| B | 默认 + 审核域规则层时钟冻结（仍零端口/零服务注入） | **422 `INPUT_UNCERTAIN`**，`details[].code = MODEL_NOT_EVALUATED` | **0 行** | 200（0 条） |
| C | 正控制：注入**合成** `pass` 端口 | **201**，`visibility=published`、`audit_state=approved` | **恰好 1 行** | 200（1 条） |

三次请求的**正文、账号、请求体、路由与鉴权完全相同**（幂等键各臂不同 —— 它们本来就是三次不同的请求，且幂等键不参与判定），唯一的自变量是「审核端口有没有被注入」。A 与 B 逐字段相同（B 只是让理由码可被逐字断言，见 §1.2）；C 与 A/B 的差异把「422 来自审核门」这件事钉死。

## 1 装配形态

### 1.1 默认装配：审核域自建**替身**端口

`buildApp` 在缺省 `moderationInjection` 时走 `services/api/src/app.ts:935` 的 `??` 兜底，自建审核域服务。`stub` / `preset_demo` 模式下该服务拿到的是**替身端口**（`services/api/src/moderation/provider.ts:48` 的 `label: 'unsure'`），替身只回「无结论」，于是合流层判 `quarantined`：`services/api/src/moderation/decisions.ts:191` 的 `reasons.push('model_not_attempted')`。

`real` 模式下则整域 fail-closed：`services/api/src/moderation/service.ts:457` 的 `createFailClosedModerationService()`（无 `liveWiring` ⇒ 四类写操作全 deny、`503`）。本页只测 `stub`；`real` 的 503 读数属于既有用例（`tests/unit/community-http.test.mjs` 的 real 臂），本页不重复。

### 1.2 测试侧的两个旋钮（都不是端口注入，全部披露）

| 旋钮 | 出现在哪臂 | 作用 | 为什么必须披露 |
| --- | --- | --- | --- |
| `communityInjection.gate = makeGate()` | A / B / C | 社区**发布闸门**规则引擎冻结时钟 | 出厂预算 `DEFAULT_RULE_BUDGET_MS = 50`（`packages/moderation/constants.mjs:224`）吃墙钟；机器抖动会让社区规则层先超时，把读数从「审核域隔离」换成「规则超时」 |
| `moderationInjection.ruleOptions = FROZEN_RULE_OPTIONS` | 仅 B | 审核域**规则层**冻结时钟（`services/api/src/app.ts:946-948` 只透传到规则层） | 同上：审核域规则层超时同样会让理由码变成 `RULE_TIMEOUT`。A 臂刻意**不带**它，用真实墙钟跑一遍，证明「零旋钮的默认装配也挡」 |

两个旋钮都**只动时钟**：不放宽预算（仍是 50ms，检查逐条照跑，只是 `now - started` 恒为 0）、不改判据、不给模型层接线、不让审核域跳过送审。`ruleOptions` 也**不会**影响端口来源——B 臂与 A 臂的端口都是出厂替身。

这不是纸面顾虑：本页 §7.1 ④ 的第 3 次**全量**运行真的撞上了一次既有用例的 `RULE_TIMEOUT`（机器负载下 50ms 预算被读穿），而同一棵树的另两次全量为 `fail 0`。正因如此，本片新建的用例两个时钟都冻结，读数才与机器速度无关。

### 1.3 正控制用的合成端口

`tests/unit/community-fixtures.mjs` 的 `makeSyntheticPassPort('tms')`：`provider.synthetic === true`、四个网络 seam「持有即抛错」、不联网、不读环境变量、无凭据。它**只**用于证明「同一请求在审核层明确放行时能落库并发 201」。

## 2 请求与响应原文（脱敏）

三次请求共用：

```http
POST /api/v1/posts HTTP/1.1
authorization: Bearer <redacted：内存合成账号会话，不入页>
content-type: application/json
idempotency-key: <opaque：各臂不同，不参与判定>

{"title":"稗草防除经验交流","body":"今年雨水偏多，我按标签说明选择登记药剂，先看苗情再决定，注意轮换。","media_ids":[]}
```

正文是**合成文本**（`tests/unit/community-fixtures.mjs` 的 `CLEAN_TITLE` / `CLEAN_BODY`），不含任何真实用户内容。

### 2.1 臂 A（纯默认装配）响应

```http
HTTP/1.1 422 Unprocessable Entity
cache-control: no-store
```

```json
{
  "error": {
    "code": "INPUT_UNCERTAIN",
    "message": "内容未获审核域放行（隔离/未结论：decision=quarantined, model_layer=not_wired），一律不得发布",
    "retryable": false,
    "details": [{ "field": "reason_codes", "code": "MODEL_NOT_EVALUATED" }]
  },
  "meta": { "request_id": "<uuid>", "contract_version": "1.0.0", "execution_mode": "stub" }
}
```

同一条请求在 store 侧的四条读数：

```
rows_all_scopes  = 0
insertPost 调用  = 0
拒绝结论补录      = 1 条：{ decision: "quarantined", reason_codes: ["MODEL_NOT_EVALUATED"],
                            hard_rule_passed: true, contract_complete: false,
                            target_ref: { type: "post", revision: 1 } }
GET /posts       = 200，items = 0
```

### 2.2 臂 B（默认 + 审核域规则层冻结时钟）响应

```http
HTTP/1.1 422 Unprocessable Entity
cache-control: no-store
```

```json
{
  "error": {
    "code": "INPUT_UNCERTAIN",
    "message": "内容未获审核域放行（隔离/未结论：decision=quarantined, model_layer=not_wired），一律不得发布",
    "retryable": false,
    "details": [{ "field": "reason_codes", "code": "MODEL_NOT_EVALUATED" }]
  },
  "meta": { "request_id": "<uuid>", "contract_version": "1.0.0", "execution_mode": "stub" }
}
```

store 读数与臂 A **逐字段相同**（0 行 / `insertPost` 0 次 / 一条 `quarantined` + `MODEL_NOT_EVALUATED` 的补录 / `GET /posts` 200 空页）。

### 2.3 臂 C（正控制：合成 `pass` 端口）响应

```http
HTTP/1.1 201 Created
cache-control: no-store
etag: "1"
```

```json
{
  "data": {
    "id": "<uuid>",
    "revision": 1,
    "author": { "display_name": "耕云用户f326", "display_id": "gy-0389af6ab23f", "state": "active", "revision": 1 },
    "title": "稗草防除经验交流",
    "body": "今年雨水偏多，我按标签说明选择登记药剂，先看苗情再决定，注意轮换。",
    "crop_id": null,
    "region_code": null,
    "media_ids": [],
    "visibility": "published",
    "audit_state": "approved",
    "created_at": "2026-10-28T04:00:00.000Z",
    "updated_at": "2026-10-28T04:00:00.000Z",
    "media": [],
    "linked_knowledge_ref": null,
    "linked_knowledge": null
  },
  "meta": { "request_id": "<uuid>", "contract_version": "1.0.0", "execution_mode": "stub" }
}
```

```
rows_all_scopes = 1（visibility=published, audit_state=approved，id 与响应 data.id 相同）
insertPost 调用 = 1
拒绝结论补录     = 0 条
GET /posts      = 200，items = 1
```

## 3 两次读数（A/B vs C）的差异

| 维度 | 默认装配（A / B） | 合成 `pass` 端口（C） | 说明 |
| --- | --- | --- | --- |
| HTTP 状态 | 422 | 201 | 差别只可能来自审核层结论 |
| 错误码 / 数据 | `INPUT_UNCERTAIN` + `details[].code` | 成功封套 `data` | 不是 `400 INVALID_REQUEST`（驳回）、不是 `409`、不是 `503`（未接线） |
| 内容行 | **0** | **1** | 写库发生在审核放行**之后** |
| 结论台账 | 补录 `quarantined` + `MODEL_NOT_EVALUATED` | 无补录（结论随内容行同原子写入） | 「隔离」与「通过」在台账上可分辨 |
| 读面 | `GET /posts` 200 / 0 条 | `GET /posts` 200 / 1 条 | **读面两臂都正常**：被挡的是写面，不是路由/鉴权/整域 503 |

结论：**同一条请求，只换审核端口，结果从 422 变成 201**。因此 422 不是 schema、不是幂等键、不是投稿授权闸，也不是规则层——见 §4 的第二条独立证据。

## 4 「422 不是别的门挡的」的第二条证据

正控制证明「注入放行端口就能发」，但理论上仍可能是「注入端口顺带绕过了别的门」。为此响应与台账里另有三条读数直接排除其它门：

1. **规则层是通过的**：台账补录里 `hard_rule_passed: true`。若规则层挡下，`decision` 会是 `rejected`（400 `INVALID_REQUEST`），而不是 `quarantined`（422）。
2. **投稿授权闸是过的**：夹具在请求前按真实实现 `consentStore.grant(...)` 补齐 `public_posting` 授权；若未授权，响应会是 `403 CONSENT_REQUIRED`（`tests/unit/community-posting-consent.test.mjs` 的既有口径），不是 422。
3. **鉴权与路由是通的**：同一进程、同一 token 的 `GET /posts` 返 200；`GET /posts/<随机 uuid>` 返同形 404 而不是 503——整域可用，只有写面被挡。

对应的代码路径（本基线逐字）：送审在落库**之前**（`services/api/src/community/service.ts:1035` 的 `screenWithModeration(...)`），未获放行即抛（`:1041` 的 `requireDomainClearance(...)`），隔离错误由 `:509-517` 的 `domainIsolation` 造出（`INPUT_UNCERTAIN` + `details[].field='reason_codes'`），落库调用在 `:1073` 的 `insertPost(...)` —— 抛点在落库之前，所以「0 行」是**结构性**的，不是断言口径。

## 5 声明：这是**替身级**证据，不证明真实审核能力

必须连结论一起读：

- 本页三次读数全部由**替身/合成**端口产生。替身端口（`label: 'unsure'`）**不是**真实 tms / ims 供应商，**零真实外呼、无真实凭据、BizType 未核验、无真实样本**（[真实样本缺口登记](../evaluation/sample-gap-register.md)：`ai_moderation_risk` / `ai_moderation_normal` 真实样本各为 0）。
- 因此本页**不能**被引用成「审核能力已就绪」「召回率／误隔离率达标」或任何质量成绩；它只证明**门的接线与 fail-closed 行为**。
- 正控制的 201 同样**不是**「真实审核通过」的证据：那是一条**明确标注的合成放行**，`provider.synthetic === true`，四个网络 seam 持有即抛错。
- 本页不覆盖：`real` 模式的 503 读数（属既有用例）、PG 持久化臂（本文件无池 ⇒ 内存实现）、图片/媒体路径、评论与编辑路径（与发帖同一道门，同源点在 `services/api/src/community/service.ts:1175` / `services/api/src/community/service.ts:1368` / `services/api/src/community/service.ts:1480`，本片未逐条重跑）。

## 6 要让演示环境能发帖，唯一不破坏 fail-closed 的做法

**结论：只能由用户明确裁决是否接入一条 `synthetic: true` 的演示审核端口；工程侧不得用「默认放行」「配置默认值」「测试特例」等方式悄悄打开。**

理由（按依赖顺序）：

1. 今天的 422 **不是 bug**，而是「先审后发」的正确落点：模型层没有结论 ⇒ 不发布（`services/api/src/community/service.ts:1041` → `:509-517`）。为了「能发帖」把这条判据放宽，等于把「未审内容」当「已审通过」发布，直接违反 B09/#14 的既有权衡。
2. 唯一**不破坏** fail-closed 的打开方式：在装配层加一条**显式开关**，只在 `stub` / `preset_demo` 下注入一条 `synthetic: true` 的演示审核端口，并在装配处、端口声明处与用户可见面上同时标注「演示／替身」，且 `real` 模式继续忽略它（`services/api/src/moderation/service.ts:451-462` 的 real 分支不回退替身）。
3. 这条开关**属于用户决策，不属于写手**：它同时改变「谁能发布内容」这一产品语义，并牵动「合成样本不得当质量成绩」的文档口径（[AI 运维规格状态](../architecture/ai-ops-spec-status.md) §6 的门槛仍未执行）。本片只出证据，**不实现**该开关，也不替用户选。
4. 若用户选择**不**接演示端口，则演示环境的正确读数就是本页 A/B 臂：**社区只读可用、发帖被如实拒绝**，且拒绝文案点明「审核域未放行」，不是含糊的失败。

## 7 门禁读数

| 命令 | exit | 读数 |
| --- | --- | --- |
| `node --test tests/unit/community-moderation-negative-control.test.mjs` | 0 | `tests 3 / pass 3 / fail 0`（6.7s） |
| `node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs` | 0 | `PASS: --strict 下没有基线之外的新增`（详见 §7.1） |
| `node tools/verify-contract-status.mjs` | 0 | `PASS: 覆盖 126 条契约操作；已装配 126 条`、`PASS: 中文表格一致` |
| `node --test "tests/unit/*.test.mjs"`（全量） | 0 | `tests 4579 / pass 4576 / fail 0 / skipped 1 / todo 2`（四次运行中三次全绿；一次命中既有 `RULE_TIMEOUT` 抖动，见 §7.1 ④） |

### 7.1 逐条读数

**① 新增用例本身**（`tests/unit/community-moderation-negative-control.test.mjs`）

```
$ node --test tests/unit/community-moderation-negative-control.test.mjs
✔ 负控制（纯默认）· 零测试侧旋钮：POST /posts ⇒ 422 INPUT_UNCERTAIN，内容行 0，GET /posts 仍 200 (818.8ms)
✔ 负控制（默认装配）· POST /posts ⇒ 422 INPUT_UNCERTAIN + MODEL_NOT_EVALUATED，内容行 0 行 (467.2ms)
✔ 正控制 · 合成 pass 端口：同一请求 ⇒ 201 published/approved，内容行恰好 1 (306.3ms)
ℹ tests 3 / pass 3 / fail 0 / duration_ms 6658.5      exit 0
```

**② `node tools/verify-doc-anchors.mjs --strict --symbol=strict --scan docs`**

```
COUNT: BROKEN 4 / OUT_OF_RANGE 2 / SUSPECT 9 / NOT_SYMBOL_LINE 4（合计 19 条）
BARE-ORPHAN: 登记 3543 条；本次命中 3543、基线外新增 0、陈旧 0
DRIFT-BASELINE: 登记 15 条；本次命中 15、新增 0、陈旧 0
SYMBOL-STRICT: 可判 781 条：落代码行 741 通过、36 进基线（去重后 31）、4 条 NOT_SYMBOL_LINE
SYMBOL-STRICT-BASELINE: 登记 31 条；命中 31、基线外新增 0、陈旧 0
ANCHOR-COUNT: 进判据锚点 6275 条 / 228 份文档（清册登记 6217 条 / 226 份；下降 0 份、上升 4 份、面内扫不到 0 个）
PASS: --strict 下没有基线之外的新增
```

exit **0**。本页是**新增文档**，第一版曾因三个只写行号、没有回带路径的裸锚点被判 `BARE_ORPHAN 基线外新增 3 条` 而 exit 1；补回 `services/api/src/community/service.ts` 路径前缀后归零。**没有**改 `tools/**` 的册子（既没 `--write-orphan-baseline`，也没删条目）。

**③ `node tools/verify-contract-status.mjs`**

```
PASS: 覆盖 126 条契约操作；已装配 126 条；implemented 18 / partial 108 / planned 0；横切维度 8 条；形状错误 0 项；语义错误 0 项
PASS: 行号区间 311 条（台账直写 302 条 + 符号解析 9 条；有实质内容 311 条）
PASS: 中文表格一致
PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。
```

exit **0**（本片未动契约与台账，读数与基线同形）。

**④ 全量 `node --test "tests/unit/*.test.mjs"`**

同一棵树的**四次**全量读数（本提交的 `tests/**` 四次逐字节相同；第 3 次是在与本片无关的长跑并发时跑的）：

```
# 第 1 次（提交前）
ℹ tests 4579 / suites 17 / pass 4576 / fail 0 / skipped 1 / todo 2
ℹ duration_ms 308649.3      exit 0

# 第 2 次（提交后复跑）
ℹ tests 4579 / suites 17 / pass 4576 / fail 0 / skipped 1 / todo 2
ℹ duration_ms 697738.1      exit 0

# 第 3 次（提交后复跑，机器同时有其它长跑）
ℹ tests 4579 / suites 17 / pass 4575 / fail 1 / skipped 1 / todo 2
ℹ duration_ms 216290.9      exit 1
✖ approve 幂等：同状态重复通过 ⇒ changed:false、revision/审计/通知都不变（tests/unit/admin-post-review-s3.test.mjs:128）
  ApiError: 硬规则已明确否决该内容，不允许人工通过
    details: [ { field: 'reason_codes', code: 'RULE_TIMEOUT' } ]

# 第 4 次（机器空闲，在本提交的最终 HEAD 上跑；本页此段之后只补了这一行读数）
ℹ tests 4579 / suites 17 / pass 4576 / fail 0 / skipped 1 / todo 2
ℹ duration_ms 212685.8      exit 0
```

第 3 次的唯一红是**既有用例的墙钟抖动**，不是本片引入的：`RULE_TIMEOUT` 来自出厂规则预算 `DEFAULT_RULE_BUDGET_MS = 50` 在机器负载下被读穿（正是 `tests/unit/stall-hygiene-fixtures.mjs` 与既有 `community-http.test.mjs` 要冻结时钟的那一类）。三条独立读数支持这个归因：① 该用例文件与本片**逐字节无关**——`git diff --name-only da61b64d..HEAD` 里没有 `tests/unit/admin-post-review-s3.test.mjs`，也没有 `services/**`；② 单独跑该文件 **3 次全部通过**（`pass 14 / fail 0`，exit 0 三次）；③ 同一棵树上另外两次全量 `fail 0`。

`skipped 1` 与 `todo 2` 都是**基线既有条目**（本片一行未改、一条未新增，本片新增的 3 条用例三次都全部执行、全部通过）；本页不代它们声称"合理"，只登记本片没有把它们变多变少。

### 7.2 未改动的目录（自证）

```
$ git diff --name-only da61b64d -- services apps packages .github tools
（空输出：一行都没有）
```

## 8 未能声称 / 没做的事

- **没跑 PG 臂**：本片不连真实库，「内容行 0 行」是内存 store 的读数；真库侧同判据由既有 `tests/integration/community-pg.mjs` 覆盖，本页不代为声称。
- **没跑 `real` 模式**：`real` 下审核域整域 fail-closed（503），与本题的 `stub` 422 是两条不同读数；`real` 读数属既有用例，本页未重跑。
- **没做变异/注入破坏性验证**：本片没有把「审核门」故意拆掉再跑一遍（那要改 `services/**`，属禁区）。负控制的可信度来自「正控制 + 三条排除性读数」（§4），不来自破坏性实验。
- **没有评估审核质量**：见 §5，一次也没有。
- **侦察报告的分歧**：`RECON.md` 引 `packages/moderation/constants.mjs:223`，本基线实测 `DEFAULT_RULE_BUDGET_MS` 在 `:224`。本页按实测写 `:224`，不回改侦察报告（它不在本片改动面内）。
