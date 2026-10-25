# GY-I14 审核 HTTP 装配片（#14）· 验证证据（2026-10-14）

- **分支**：`feat/gy-i14-moderation-http`（worktree `E:\GengYunCommander\GengYun_W34`）
- **基线**：`upstream/main` = `fcfa6de9d62aeaaa0489d3319f8f06911312af48`；**已两次合并最新 `upstream/main`**
  （`c85a1e8` 见 §10；`b054dc3` 见 §11）
- **代码交付 HEAD**：`9422fa9`（其后为 docs 提交 `7750b34`/`f1e7d01`，以及**合并提交 `5c0a4a7`**
  ——合并只解 `app.ts` 冲突、**两侧装配全部保留**，复核输出见 §10；最终分支 HEAD 以 `git rev-parse HEAD` 为准）
- **环境**：Windows；Node `v24.16.0`；npm `11.13.0`
- **纪律**：真实 `tms`/`ims` 供应商**未授权付费** ⇒ 本片**零真实调用**、零凭据、零外网；
  全部端口为**合成替身**；**未 push**（由指挥推送）。

## 0 一句话结论（不得外推）

本片把**已合并**的规则层 + 模型层装配成审核域，并把结论接到**已有**契约读面
`GET /jobs/{id}`（`kind=moderation`）：文字/图片**各自成版本级任务**、规则先挡、失败/超时/无结论一律隔离、
筛查通过与发布分开、编辑重审旧结论不套新版本、回调验签与版本核对、下架驱动缓存失效、读取时重查可见性；
`real` 未接真实供应商**整域 fail-closed（503 `PROVIDER_UNAVAILABLE`, retryable）**。
**不代表**真实 AI 筛查已上线、不代表准确率/召回率（真实样本各为 0，评估属 GY-I21）、不代表社区链已接线。

## 1 交付清单（`git diff --stat upstream/main...HEAD`）

```
 docs/architecture/contract-implementation-status.md |    2 +-
 docs/architecture/contract-status.json              |    6 +-
 docs/moderation/http-layer.md                       |  226 ++++++++
 docs/verification/gy-i14-moderation-http-20261014.md |  ~300 ++++
 services/api/src/app.ts                             |   35 +-
 services/api/src/moderation/callback.ts             |  295 ++++++++
 services/api/src/moderation/decisions.ts            |  486 +++++++++++++
 services/api/src/moderation/index.ts                |   26 +
 services/api/src/moderation/job-source.ts           |   45 ++
 services/api/src/moderation/nonbypass.ts            |  171 +++++
 services/api/src/moderation/packages.d.ts           |  264 +++++++
 services/api/src/moderation/provider.ts             |  150 ++++
 services/api/src/moderation/service.ts              | 1105 +++++++++++++++++++++++++++++
 services/api/src/moderation/types.ts                |  361 ++++++++++
 services/api/src/moderation/visibility.ts           |  315 ++++++++
 tests/moderation/_http-fixtures.mjs                 |  216 ++++++
 tests/moderation/http-callback.test.mjs             |  463 ++++++++++++
 tests/moderation/http-isolation.test.mjs            |  283 ++++++++
 tests/moderation/http-jobs.test.mjs                 |  218 ++++++
 tests/moderation/http-screening.test.mjs            |  338 ++++++++++
 tests/moderation/model-ports.test.mjs               |   48 +-
 21 files changed, 5256 insertions(+), 7 deletions(-)
```

（上面数字取自 `git diff --stat upstream/main...HEAD`；`packages/contracts/**`、`packages/moderation/**`、
`services/api/src/community/**`、`services/api/src/admin/**` **零改动**；`app.ts` 为纯追加式装配，见 §6。）

## 2 门禁与检查清单（命令 + 退出码 + 原始输出）

| # | 命令 | 退出码 | 原始输出（关键行） |
| --- | --- | --- | --- |
| 1 | `npm run lint` | 0 | `PASS tsc --noEmit services/api/tsconfig.json` / `PASS tsc --noEmit apps/admin/tsconfig.json` / `PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）` / `lint 通过` |
| 2 | `npm run test:unit` | 0 | `ℹ tests 1831` `ℹ pass 1830` `ℹ fail 0` `ℹ skipped 1`（`duration_ms 21558.6734`；在代码交付 HEAD `9422fa9` 上复跑） |
| 3 | `npm run test:contract` | 0 | `ℹ tests 6` `ℹ pass 6` `ℹ fail 0` |
| 4 | `npm run test:docs` | 0 | `PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables` |
| 5 | `node --test tests/moderation/http-screening.test.mjs tests/moderation/http-isolation.test.mjs tests/moderation/http-callback.test.mjs tests/moderation/http-jobs.test.mjs` | 0 | `ℹ tests 31` `ℹ pass 31` `ℹ fail 0` |
| 6 | `node tools/verify-contract-status.mjs` | 0 | `PASS: 覆盖 112 条契约操作；已装配 78 条；implemented 13 / partial 81 / planned 18；横切维度 8 条；中文表格一致` |
| 7 | `git diff --check` | 0 | （无输出 = 无空白错误） |
| 8 | `node tests/integration/jobs-http.mjs` | 0 | 见 §5（**该脚本不在任何 CI glob 内**，故显式运行） |

对照（修复前实测）：`npm run test:unit` 首次全量为 `1831 / fail 1`，唯一失败是
`tests/moderation/model-ports.test.mjs:183`（原记 :156） 的文书边界负控制；原因与处理见 §6.2（**前提被达成后的同步**）。

## 3 新增用例原始输出（31/31，逐条）

```
✔ 版本级任务：文字内容生成一条 text 任务，登记结构结果/理由/证据/模型模板/规则版本（合成替身） (8.3225ms)
✔ 版本级任务：带图片内容生成 text + image 两条任务；按已合并规则层口径带媒体一律不得判通过 (3.0956ms)
✔ 规则先挡：广告导流/私交易/硬危险/危险混配/无依据用量/隐私/提示注入一律先在规则层驳回，模型端口不跑 (15.8204ms)
✔ 失败隔离：超时 / 配额 / 无结论 / 形状未知 / 明确不通过 —— 逐条可判别，且绝不记通过 (30.7866ms)
✔ 输入不可用 / 规则集非法 / 扫描限额耗尽：一律隔离且不通过（fail-closed 闸门在装配层同样生效） (1.8128ms)
✔ real 未接真实供应商：整域 fail-closed 503 PROVIDER_UNAVAILABLE（retryable），且不产出任何任务 (0.731ms)
✔ stub 对照：同一路径在 stub 下可跑通并如实标注替身/合成端口，但结论绝不冒充真实供应商 (0.7373ms)
✔ 筛查通过与发布分开：approved 只是必要条件；未显式发布则不可见，发布后才可见 (6.8993ms)
✔ 编辑生成新版本并重审：旧版本审核结果不得套新版本（负例），旧链接也不得可见 (4.4315ms)
✔ 发布闸门重跑证据链：同一 target/revision 换正文（同 revision 篡改）一律拒绝 (1.5014ms)
✔ 版本变化 ⇒ 旧结论失效（规则集升级 / 模型版本变化），发布被拒且重审报告可判别 (3.3813ms)
✔ 下架：仅管理员可下架，驱动整链缓存失效；该版本永久不可再发布；新版本重审后方可由管理员恢复 (3.5779ms)
✔ 读取时重查可见性（负例）：缓存、隐藏、账号停用/去身份、旧链接都不得重新公开 (1.5339ms)
✔ 待回调任务：模型层未求值 ⇒ pending/queued、无契约对象、端口不被调用；规则层事实如实登记 (3.7111ms)
✔ 回调正例：验签+版本+租约+摘要全部一致 ⇒ 只落定该版本级任务（approved），**绝不自动发布** (6.7462ms)
✔ 回调负例·伪造/篡改/缺失签名：一律拒绝（403 语义 SCOPE_DENIED），且不落定任何结论 (1.6313ms)
✔ 回调负例·超时/过期/回放/终态/未知作业：逐条可判别地拒绝 (3.7115ms)
✔ 回调负例·版本/租约/目标/epoch/摘要不一致：逐条拒绝（过期版本不得放行） (6.0317ms)
✔ 回调负例·下架后：旧回调不得复活已下架对象 (1.2966ms)
✔ 回调负例·载荷与控制类字段：形状非法/闭集不符/试图提权一律拒绝 (1.3207ms)
✔ 回调判定口径：block ⇒ rejected；unsure ⇒ 隔离（无结论绝不通过） (2.0645ms)
✔ 不可绕过·模型回报带控制类字段 ⇒ 整条拒绝并按隔离处理（且不抄录回报里的自由文本） (2.6238ms)
✔ 守卫端口：包装后的端口仍返回原回报；命中控制字段时抛可归类失败（合流层据此隔离） (0.4143ms)
✔ AI 不授权限/不改来源/不标专家，且公众票决不进入首版（人审入口保持空态） (4.0362ms)
✔ 规则集版本变化后：迟到回调按"过期版本"拒绝（旧版本审核结果不得套新版本） (1.0551ms)
✔ 带图片内容的图片任务：prompt 版本按内容所需端口集合核对；规则层未通过时模型 pass 也不得放行 (2.0289ms)
✔ GET /jobs/{id}：审核作业按契约读出（九键/闭集/ModerationResult），且**不**扩散服务端租约 (206.5766ms)
✔ GET /jobs/{id}：他人作业与"不存在的 uuid"同形 404；非法 uuid 400；未声明查询参数 400 (47.0394ms)
✔ POST /jobs/{id}/cancel：审核作业**不提供取消** ⇒ 契约 503 PROVIDER_UNAVAILABLE(retryable)，不伪造 cancelled (36.5644ms)
✔ 隔离任务的 HTTP 形态：带媒体内容两条版本级任务、均隔离且无契约对象可读（result=null，不填占位） (33.9053ms)
✔ real 模式：审核域整域 fail-closed（送审 503），作业读面对未接线能力仍是同形 404（不谎称可用） (28.1257ms)
ℹ tests 31 / ℹ pass 31 / ℹ fail 0 / ℹ skipped 0
```

## 4 关键断言（负例与 fail-closed 对照，逐条钉明）

### 4.1 版本级任务与登记

| 断言 | 位置 |
| --- | --- |
| 文字 ⇒ **1** 条任务（`text`/`tms`/`text_moderation`）；契约 `Moderation` 键集合**恰好 8 个**且 `collectResultValueIssues('moderation', …)` 为空；`id` 与 `job_id` 同源 | `http-screening.test.mjs` 用例 1 |
| 带图片 ⇒ **2** 条任务（`text`+`image`，独立 `job_id`，`tms`/`ims`、两个 prompt）；`ims` 端口**确被求值**且证据登记；两 kind 模型版本不同 ⇒ `MODEL_VERSION_CONFLICT` + `contract_value === null`（**不填占位串**） | 用例 2 |
| 证据只含**计数/摘要**：`text_length` 有值、`checked_media_refs` 是不透明引用；`JSON.stringify(task).includes(正文) === false` | 用例 1/2 |
| `input_binding_digest` = `moderationInputDigest(content)`（`mib1+sha256:<32 hex>`）；`rule_version` = 出厂规则集派生版本 | 用例 1 |

### 4.2 规则先挡（模型端口调用数为 0）

11 条出厂夹具逐条命中 ⇒ `rejected` + 命中原因码存在 + **`tms.calls.count === 0`**；反向夹具不得被误拦。
覆盖面自证：类别集合 ⊇ `{dangerous_usage, label_bound_dose, privacy, prompt_injection, authority_spoofing,
safety_claim, commerce}`；原因码集合 ⊇ `{DANGEROUS_MIX, DOSE_UNBOUNDED, DOSE_NOT_BOUND_TO_LABEL,
PRIVACY_PII, PRIVACY_COORDS, PROMPT_INJECTION, COMMERCE_SOLICITATION, COMMERCE_LINK}`。

### 4.3 失败隔离（逐条可判别，绝不记通过）

| 情形 | 实测 |
| --- | --- |
| 端口超时（`deadline_ms: 20` + 悬挂端口） | `quarantined`/`uncertain` + `MODEL_TIMEOUT` + `error_code = PROVIDER_TIMEOUT`；`contract_value.decision === 'quarantined'`（**不是** approved） |
| 配额失败（抛 `model_failure: quota_exceeded`） | `quarantined` + `MODEL_QUOTA_EXCEEDED` + `PROVIDER_OUTCOME_UNKNOWN` |
| 无结论（`unsure`） | `quarantined` + `MODEL_NOT_EVALUATED`，`model_kinds[0].status === 'failed'` |
| 形状未知（缺必报字段） | `quarantined` + `MODEL_RESPONSE_SHAPE_UNKNOWN` |
| 端口明确 `block` | `rejected`/`succeeded` + `MODEL_BLOCKED`（**不得**升级为 approved） |
| 缺端口（不注入 ⇒ 替身） | `quarantined`/`uncertain`，`provider.origin === 'substitute'`、`synthetic === true`、`model_version` 以 `synthetic-substitute-` 开头、`counts().substitutes === ['tms','ims']`、`overall.publishable === false` |
| 空正文 / 规则集非法 / 扫描限额耗尽 | 均 `quarantined`/`uncertain`（`RULE_CATALOG_INVALID` / `RULE_SCAN_TRUNCATED`），且**端口调用数为 0** |

### 4.4 `real` fail-closed 与 `stub` 对照

- `real`：`submitScreening`/`runModelScreening`/`publish`/`withdraw`/`readView`/`reReview`/`ingestCallback`
  **7 个入口全部**抛 `PROVIDER_UNAVAILABLE`、`status === 503`、`retryable === true`；
  `counts().tasks === 0`、`tasks(target) === []`、`taskByJobId(…) === null`；
  注入端口调用数 **0**（忽略替身）。契约封套核对：`error.code`/`error.retryable`/`details: []`/`meta.execution_mode='real'`/`meta.contract_version='1.0.0'`。
- `stub` 对照：同一路径跑通，但 `evidence.execution_mode === 'stub'`、`provider.synthetic === true`、
  `biz_type === 'synthetic-substitute-placeholder'`、`counts().authority_origin === 'substitute'`。

### 4.5 版本重审与发布隔离

- 筛查 `approved` 后权威侧仍 `private`、`publishedRevision === null`（所有者按 `private` 可读、**未发布**）；
  他人 `SCOPE_DENIED`；显式 `publish` 后才 `published`。
- 编辑 ⇒ `revision=2`：**未送审直接发布 ⇒ 400 `INVALID_REQUEST` 语义**（`INPUT_UNCERTAIN`，details 带 `NOT_SCREENED`）；
  旧链接（revision=1）⇒ `REVISION_SUPERSEDED`；重审后新 `job_id` + 新 `input_binding_digest`（旧结论仅留档）。
- 同 revision 换正文 ⇒ 拒绝，details 带 `MODEL_LAYER_INPUT_BINDING_MISMATCH`。
- 规则集升级 ⇒ `RULE_VERSION_CHANGED`（`stale=true`/`action='re_review'`）；模型版本变化 ⇒ `MODEL_VERSION_CHANGED`；
  两者之下 `publish` 均被拒（`REVISION_CONFLICT`）。

### 4.6 下架 ⇒ 缓存失效 + 读取时重查（负例）

- 非管理员下架 ⇒ 403 `SCOPE_DENIED`（可见性不变）；管理员下架 ⇒ `hidden` + 已发布版本置空 +
  `invalidated_cache_keys === ['post|post-1001|1']` + `cache.size() === 0` + `event.kind === 'moderation.takedown'`
  （事件**不含正文**）；下架版本对作者与管理员**都**不可再发布（`OBJECT_UNAVAILABLE`）；
  新版本重审后作者仍不可、管理员可恢复。
- 读取重查：权威侧改 `hidden` ⇒ 缓存说 published 也不可见 + **缓存条目被失效**；
  `deleted` ⇒ `CONTENT_DELETED`；账号停用 ⇒ `ACCOUNT_INACTIVE`；去身份 ⇒ `AUTHOR_ANONYMIZED`；
  已发布 revision 置空 ⇒ `NOT_PUBLISHED`；`current_revision` 推进 ⇒ `REVISION_SUPERSEDED`；
  `private` 非所有者 ⇒ `SCOPE_DENIED`；无会话 ⇒ `SESSION_REQUIRED`；不存在 ⇒ `NOT_FOUND`。

### 4.7 回调（伪造/过期/回放/版本/摘要/租约/epoch/下架/控制字段）

伪造签名、篡改请求体、缺失签名、**服务端未配密钥** ⇒ `CALLBACK_SIGNATURE_INVALID`（提示 `SCOPE_DENIED`）；
签发时间越界 ⇒ `CALLBACK_EXPIRED`；同 `event_id` 二次 ⇒ `CALLBACK_REPLAY`（**优先于**终态判定）；终态 + 新事件
⇒ `CALLBACK_JOB_TERMINAL`；未知作业 ⇒ `CALLBACK_JOB_UNKNOWN`；`job_revision`/`lease_token`/`target_ref`/
`content_kind`/`authorization_epoch`/`input_digest`/`rule_version`/`prompt_version`/`model_version` 各自不符 ⇒
对应 `*_STALE`/`*_MISMATCH` 原因码（见 `docs/moderation/http-layer.md` §6 映射表）；下架后 ⇒
`CALLBACK_TARGET_WITHDRAWN`。**被拒回调一律不改变任务结论**（断言仍为 `pending`）。
控制字段（`role`/`scopes`/`source_kind`/`visibility`/`expert_reviewed`/`human_review`/`votes`）⇒ 整条
`CALLBACK_CONTROL_FIELD_FORBIDDEN`。**接受路径只落定筛查、绝不发布**（断言权威侧仍 `private`，需再显式 publish）。

### 4.8 不可绕过与 HTTP 回环

- 注入端口**统一**经 `guardModelPort`（`provider.resolveModerationPorts` 内）⇒ 回报带控制字段时结论为
  `quarantined` + `MODEL_RESPONSE_SHAPE_UNKNOWN`，且 `"admin"`/`verified_seed`/`expert_reviewed`/回报自由文本
  **均不出现**在任务记录里；干净回报不被误伤；`Proxy` 不可读结构判**不干净**（未检查 ≠ 干净）。
- 来源不变：筛查 + 下架前后 `source_kind === 'verified_seed'` 不变。
- 人审空态：`humanReviewQueue() === { human_review_state: 'under_construction', voting: 'disabled', items: [] }`；
  `publicVotingEnabled() === false`；冻结契约 **0** 处票决字段/路径。
- HTTP 回环（`app.inject`，经**真实装配**）：`GET /api/v1/jobs/{id}` ⇒ 200、九键、`kind='moderation'`、
  `result.kind='moderation'`、契约镜像无问题、`ETag: "1"`、`Cache-Control: no-store`、`meta.execution_mode='stub'`；
  响应体**不含**租约/输入绑定摘要/正文；他人作业与不存在 uuid 的 `error` **逐字段一致**；无会话 401；
  非法 uuid 400；未声明查询参数 400；`POST /jobs/{id}/cancel` ⇒ 503 `PROVIDER_UNAVAILABLE`(`retryable`)
  且状态未被伪造；带媒体两条任务在 HTTP 上均为 `uncertain` + `result: null`。

## 5 集成脚本（**不在任何 CI glob 内**，故显式运行）

`tests/integration/**` 不被 `test:unit` / `test:contract` 等 CI glob 覆盖。与本次改动直接相关的
`tests/integration/jobs-http.mjs`（作业读面/取消面回环）**已显式运行**：

```
$ node tests/integration/jobs-http.mjs
  - 识别域 job=06659a7e-… 受理=queued → succeeded result.kind=recognition
  - 转写域 job=4ba5c911-… state=succeeded
  - 前后对照：转写 job 改前 404 → 改后 200
  - 同形 404 三类（他人作业 / 合法但不存在 / kind 未接线）一致
  - 钉子：非 uuid ⇒ 400（HTTP 层）；合法但不存在 ⇒ 404（服务层）；未声明查询参数 ⇒ 400
  - cancel：running→cancelled revision=3；同键重放回放；新键旧 If-Match→409
  - 转写域 cancel ⇒ 503 PROVIDER_UNAVAILABLE（能力未接线，如实拒绝；状态未变）
  - cancel 并发：同键 ⇒ 恰好一次迁移；异键同 If-Match ⇒ 恰好一个 200 + 一个 409
  - 如实性：succeeded(result≠null,error_code=null) / failed(result=null,error_code=PROVIDER_OUTCOME_UNKNOWN)
  - 单一注册：/jobs/{id} 与 /jobs/{id}/cancel 各 1 处，均在 jobs/routes.ts
  - 嵌套 result.value 守卫：坏投影经路由 503（改前 200 透出），契约合法仍 200
  - 钉子：无取消能力 kind 的 cancel ⇒ 缺 Key 400 / 缺 If-Match 428 / 齐备 503
[exit 0]
```

> **说明（必须写进 PR 正文）**：该脚本**不被 CI 自动执行**（不在任何 glob 内），上表结果是**本机显式运行**
> 的原始输出；审核域的 31 项新用例位于 `tests/moderation/*.test.mjs`，**在 `npm run test:unit` 的 glob 内**
> （已随全量 1831 项一起跑过）。

## 6 跨线披露（逐处、可回退）

### 6.1 `services/api/src/app.ts`（+34/−1，纯追加）

获指挥**明确裁定允许**：新增 import 块、`FastifyInstance.moderationService` 声明、
可选 `BuildAppOptions.moderationInjection`、`buildApp` 解构参数增加一个可选字段（同一行改写，即那 −1）、
一处 `app.decorate`、一处 `createModerationJobSource(moderationService)` 注册。**不改**既有域行为、
不重排既有装配。**回退 = 删除 app.ts 中标注 `GY-I14` 的四块。**
（社区发布/编辑链 `services/api/src/community/**`、后台 `services/api/src/admin/**` **零改动**。）

### 6.2 `tests/moderation/model-ports.test.mjs`（文书边界负控制同步，+34/−?）

**这不是放宽或绕过，而是"前提被达成后对既有负控制的同步更新"**：

- **原判据**：全仓（`services`/`apps`/`miniprogram`/`tools`）**零命中**模型合流 API 符号；
- **它当时的前提**：模型层片的边界声明是"**本包暂无 HTTP 消费者**、应用装配路径未接线"；
- **前提如何被达成**：本任务（**同一 issue #14**）按设计给模型层接入**唯一受信消费者**
  `services/api/src/moderation/**`；不引用这些符号就不可能完成装配 ⇒ 该负控制必须更新；
- **只放宽一处**：白名单是**逐个受信文件**（6 个文件），不是目录通配；其它任何目录
  （#15 community / #18 admin / tools / apps / miniprogram）以及该目录内**未列出的新文件**命中仍**判失败**
  （用例内含 5 条白名单自证断言）；
- **一行回退**：删除 `SANCTIONED_MODEL_CONSUMER_FILES`。

### 6.3 `docs/architecture/contract-status.json` + `docs/architecture/contract-implementation-status.md`

`getJob` / `cancelJob` 两条 blocker 中"`moderation` 的作业源未接线"已按事实更新（审核域已接入、
real 整域 fail-closed、持久队列/租约仍待接线）。中文对照表用**仓内工具**同步：
`node tools/verify-contract-status.mjs --write-doc` ⇒ 1 行变更，随后 `node tools/verify-contract-status.mjs` **PASS**。

### 6.4 **未改**（留给指挥/监工）

`packages/moderation/README.md` 与 `docs/moderation/model-layer.md` 中"本包当前没有 HTTP 消费者"一类
边界声明现已过时（本片即为该消费者）。**本片未改已合并组件的文档**，在此如实登记，供所有者同步。

## 7 覆盖矩阵（派单 §2/§4 → 用例）

| 要求 | 用例 |
| --- | --- |
| 文字与图片各成版本级任务；登记结构结果/理由/证据/模型模板与规则版本 | `http-screening` 用例 1/2；`_http-fixtures` |
| 待筛查/通过/待复核/驳回 + 发布/下架；状态机 | `http-screening` 用例 1–6；`http-isolation` 全 6 项 |
| AI 失败/超时/无结论 ⇒ 隔离（绝不记通过） | `http-screening` 用例 4/5 |
| 筛查通过与发布分开 | `http-isolation` 用例 1；`http-callback` 用例 2 |
| 编辑重审；旧版本结果不套新版本（负例） | `http-isolation` 用例 2/3/4 |
| 规则先挡（广告导流/交易/硬危险/混配/无依据用量/隐私/注入） | `http-screening` 用例 3 |
| AI 不授权限/不改来源/不标专家；公众票决不进入首版 | `http-callback` 用例 9/11 |
| 回调校验签名与版本；伪造/过期/回放 ⇒ 拒绝 | `http-callback` 用例 3–7/13 |
| 下架 ⇒ 缓存失效；读取时重查可见性（缓存/旧链接不得复活） | `http-isolation` 用例 5/6 |
| `real` 未接供应商 fail-closed 反例 + `stub` 对照 | `http-screening` 用例 6/7；`http-jobs` 用例 5 |
| 契约读面（不新增路径）与隔离真实 HTTP 形态 | `http-jobs` 全 5 项 |

## 8 提交（每个内聚小步一次 commit，均未 push）

| commit | 内容 |
| --- | --- |
| `3cd8ead` | 审核域服务层（10 个新文件） |
| `9806a04` | `app.ts` 追加式装配（跨线披露） |
| `975e50f` | 审核域三处口径修正（待回调保留规则层事实 / 当前规则版本按注入规则集派生 / 回放优先判定） |
| `71d1f61` | 版本级任务/规则先挡/失败隔离/real fail-closed 回归（7 项）+ 加严 `modelLayerReachable` + 判定投影修正 |
| `1c28561` | 版本重审/发布隔离/下架缓存/读取重查回归（6 项）+ 可见性与缓存口径修正 |
| `ddd94e8` | 回调验签/版本/回放与不可绕过回归（13 项）+ 端口统一加守卫 + 视图租约字段 |
| `042c73c` | `/jobs/{id}` 真实回环 HTTP 回归（5 项） |
| `9422fa9` | 文书边界负控制同步（**逐个受信文件**白名单）+ 契约状态事实更新（跨线披露） |
| `7750b34` | `docs/moderation/http-layer.md`（装配层说明 + 跨线接线要求）+ 本证据页 |
| `f1e7d01` | 证据页钉住代码交付 HEAD / 最终 diffstat / 提交清单 |
| `5c0a4a7` | **Merge `upstream/main`（`c85a1e8`）**：仅解 `app.ts` 冲突（两侧装配全保留）+ 契约状态并集（见 §10） |
| `391fbec` | **Merge `upstream/main`（`b054dc3`）**：再解 `app.ts` 冲突（#16 收藏/历史/注销 + #18 受控面 + 本片审核域全保留），见 §11 |

## 9 未取得 / 未验证（不得读成已完成）

- 真实 `tms`/`ims` 供应商：**未授权付费** ⇒ 未接、未调、**无**真实请求编号与耗时；
- 真实持久层（PG 迁移 / `moderation_decisions` 落库）、持久租约与队列：未接线（本片内存台账）；
- 社区发布/编辑链与后台 `hidePost` 调用本域：**未接线**（跨线待派单，接线要求见
  `docs/moderation/http-layer.md` §9）；因此 `real` 的 503 目前只在**服务边界**可见；
- 供应商回调的 HTTP 端点：**未装配**（ADR-001 §62 明确不在客户端 OpenAPI 开放；是否挂服务端端点由指挥决定）；
- 200 风险 + 200 正常的独立评估：**由 GY-I21 执行**，不在本片；
- 人审：未上线（空态）；公众票决：首版不进入；
- 部署与真机：未取得（无云端部署、无真机运行）；
- `tests/integration/**` 中的其它脚本未因本片改动而过：
  与本片直接相关的 `jobs-http.mjs` 已显式运行（§5），其余集成脚本（admin/media/speech/…）未受影响亦未重跑。

## 10 合并增量（`upstream/main` = `c85a1e8`，合并提交 `5c0a4a7`）

监工复核 #150 时报的唯一阻塞是"与最新 main 的**实际合并冲突**（仅 `services/api/src/app.ts`）"。
本节记录解冲突口径与合并后复核的**原始输出**。

### 10.1 冲突与解冲突（**两侧装配全部保留，只做增量合并**）

| 冲突点 | 解法 |
| --- | --- |
| `FastifyInstance` 声明 | 保留审核域 `moderationService`（GY-I14）+ 社区 `communityService`（GY-I15） |
| `BuildAppOptions` | 保留 `moderationInjection` + `communityInjection` 两个可选注入项（各自完整） |
| `buildApp` 解构参数 | 同时加入 `moderationInjection` 与 `communityInjection` |
| 构造区 | 保留审核域 `createModerationService(...)` 块；`const sql/authStore` 一行**逐字保留 upstream 文本**（不重排） |
| `app.decorate` 区 | 保留 `moderationService` + `communityService`；upstream 已把 GY-I27 的 `consentGate`/`egressRevoker` **前移**到识别域之前，故删除本处**重复副本**（前移后的副本仍在；保留重复声明会 TS 报错） |

其它冲突点（作业源注册 `createJobRegistry([...])`）**自动合并成功**：上游的识别域源（含外发墓碑）
与本片 `createModerationJobSource(...)` **同时存在**。合并后 `git diff --stat upstream/main...HEAD`
= 21 files changed, **5266 insertions(+), 9 deletions(-)**（即仅本片增量）。
`git diff upstream/main -- services/api/src/app.ts` 的 `-` 行**只有** `buildApp` 解构那一行（现同时含两侧注入项）。

契约状态并集：`docs/architecture/contract-status.json` 自动合并保留 upstream 全部条目与本片事实更新；
本轮补齐 `cancelJob` 条目的同源更新（审核域无取消能力 ⇒ 503 如实拒绝；不再声称"moderation 作业源未接线"）
并加两条 `job-source.ts` 证据项，中文对照表用 `node tools/verify-contract-status.mjs --write-doc` 同步（1 行）。

### 10.2 合并后复核（原始输出）

```
=== [1] npm run lint ===
PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）
lint 通过（静态检查；不代表运行期或真实服务已通过）。            [exit 0]

=== [2] node --test tests/moderation/http-{screening,isolation,callback,jobs}.test.mjs ===
ℹ tests 31 / ℹ pass 31 / ℹ fail 0 / ℹ skipped 0                    [exit 0]

=== [3] node --test tests/moderation/model-ports.test.mjs ===
ℹ tests 39 / ℹ pass 39 / ℹ fail 0 / ℹ skipped 0                    [exit 0]

=== [4] node tools/verify-contract-status.mjs ===
PASS: 覆盖 112 条契约操作；已装配 94 条；implemented 13 / partial 81 / planned 18；横切维度 8 条；中文表格一致
PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。      [exit 0]

=== [5] node tests/integration/jobs-http.mjs（不在任何 CI glob，显式运行） ===
  - 识别域 job=09a4157c-c515-479e-906c-f058db7790a9 受理=queued → succeeded result.kind=recognition
  - 转写域 job=d9e8ad40-214a-4e8e-95af-222b49361eab state=succeeded
  - 前后对照：转写 job 改前 404 → 改后 200
  - 同形 404 三类（他人作业 / 合法但不存在 / kind 未接线）一致
  - 钉子：非 uuid ⇒ 400（HTTP 层）；合法但不存在 ⇒ 404（服务层）；未声明查询参数 ⇒ 400
  - cancel：running→cancelled revision=3；同键重放回放；新键旧 If-Match→409
  - 转写域 cancel ⇒ 503 PROVIDER_UNAVAILABLE（能力未接线，如实拒绝；状态未变）
  - cancel 并发：同键 ⇒ 恰好一次迁移；异键同 If-Match ⇒ 恰好一个 200 + 一个 409
  - 如实性：succeeded(result≠null,error_code=null) / failed(result=null,error_code=PROVIDER_OUTCOME_UNKNOWN)
  - 单一注册：/jobs/{id} 与 /jobs/{id}/cancel 各 1 处，均在 jobs/routes.ts
  - 嵌套 result.value 守卫：坏投影经路由 503（改前 200 透出），契约合法仍 200
  - 钉子：无取消能力 kind 的 cancel ⇒ 缺 Key 400 / 缺 If-Match 428 / 齐备 503     [exit 0]

=== [6] git diff --check ===
（无输出）                                                        [exit 0]

=== [extra · 非监工要求] npm run test:unit（合并后全量，验证两侧装配共存） ===
ℹ tests 1887 / ℹ pass 1886 / ℹ fail 0 / ℹ skipped 1 （duration_ms 22655.6015）  [exit 0]

=== [extra] npm run test:docs ===
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables  [exit 0]
```

> 合并后全量 `test:unit` 由 **1831** 增至 **1887** 项（上游新增用例），**fail 0** ⇒ 社区（#15）、
> 持久账本（#29 第二片）与本片审核域的装配在同一 `app.ts` 中共存且各自回归全绿。

## 11 再合一次最新 main（`b054dc3`，合并提交 `391fbec`）

监工第二轮批复的唯一阻塞仍是"与最新 main 的**实际合并冲突**（仅 `app.ts`）"。
上游本轮增量：`fdb40ea`（#151 GY-I25 r2）→ `1b0b3d6`（#144 GY-I16 收藏/历史/注销）
→ `b054dc3`（#145 GY-I18 受控面）。本节记录解冲突口径与本轮复核原始输出。

### 11.1 冲突与解冲突（**两侧装配全部保留，只做增量**）

| 冲突点 | 解法 |
| --- | --- |
| `BuildAppOptions` | 保留 `moderationInjection`（#14）+ 上游 `favoritesInjection` / `historyInjection` / `userDataDeletionInjection`（#16）；共用 `communityInjection`（#15）不动 |
| `buildApp` 解构参数 | 并集：`… messagesInjection, moderationInjection, favoritesInjection, historyInjection, userDataDeletionInjection, communityInjection, logStream`（上游相对顺序保持） |
| `app.decorate` 区 | `moderationService` + 上游 `favoritesService` / `historyService` / `userDataDeletion` + 共用 `communityService`（四个 decorate 一个不少） |
| GY-I27 `consentSigningKey`/`consentGate`/`egressRevoker` | 同上一轮口径：只保留上游**已前移**的那份（含持久外发账本第二片），本片侧**无重复声明**；说明注释在场 |
| 自动合并区（无需人工） | `const gatedGuards = createFlagGatedGuards(guards, featureFlagGate)`（#18 受控面）、`registerCommunityRoutes(app, config, gatedGuards, communityService)`、`createRecognitionJobSource(…, 外发墓碑)` 与本片 `createModerationJobSource(moderationService)` **同时存在**；本片**不改** #18/#15 的守卫选择 |

**契约状态 = 双方条目并集（已逐条核对）**：`docs/architecture/contract-status.json` 共 **112 条操作**；
上游 #16 的新 blocker（`listFavorites`/`listHistory`/`createFavorite`/`deleteFavorite`/`deleteHistory`）
**逐条保留**，本片两条事实更新（`getJob`/`cancelJob`）在场；`git diff upstream/main -- docs/architecture/contract-status.json`
仅显示本片那两条 blocker 与两条 `job-source.ts` 证据项（10 insertions / 2 deletions）。
中文对照表由 `node tools/verify-contract-status.mjs --write-doc` 同步（本轮工具报告"中文表格一致"，无行变更）。

### 11.2 本轮复核（原始输出）

```
=== [1] npm run lint ===
PASS tsc --noEmit services/api/tsconfig.json
PASS tsc --noEmit apps/admin/tsconfig.json
PASS 仓库卫生扫描（无禁用 TLS 写法 / 疑似硬编码密钥 / 真实 .env）
lint 通过（静态检查；不代表运行期或真实服务已通过）。            [exit 0]

=== [2] node --test tests/moderation/http-{screening,isolation,callback,jobs}.test.mjs \
                tests/moderation/model-ports.test.mjs ===
ℹ tests 70 / ℹ pass 70 / ℹ fail 0 / ℹ skipped 0                    [exit 0]
（= 审核域 31 项 http 用例 + 39 项模型端口用例）

=== [3] node tools/verify-contract-status.mjs --runtime ===
PASS: 覆盖 112 条契约操作；已装配 99 条；implemented 13 / partial 86 / planned 13；横切维度 8 条；中文表格一致
PASS: 无凭据 stub 子进程中的实际 Fastify 产品装配与静态扫描、对照表一致（不监听 / 不请求服务）。
PASS: 状态为人工判定；脚本不证明语义正确、真实能力或整项验收。      [exit 0]

=== [4] node tests/integration/jobs-http.mjs（不在任何 CI glob，显式运行） ===
  - loopback origin=http://127.0.0.1:61506
  - 识别域 job=ab10c7e8-439e-4894-b2c4-031d27860ef7 受理=queued → succeeded result.kind=recognition
  - 转写域 job=1c436127-39e6-4248-8029-2ce86b484019 state=succeeded
  - 前后对照：转写 job 改前 404 → 改后 200
  - 同形 404 三类（他人作业 / 合法但不存在 / kind 未接线）一致
  - 钉子：非 uuid ⇒ 400（HTTP 层）；合法但不存在 ⇒ 404（服务层）；未声明查询参数 ⇒ 400
  - cancel：running→cancelled revision=3；同键重放回放；新键旧 If-Match→409
  - 转写域 cancel ⇒ 503 PROVIDER_UNAVAILABLE（能力未接线，如实拒绝；状态未变）
  - cancel 并发：同键 ⇒ 恰好一次迁移；异键同 If-Match ⇒ 恰好一个 200 + 一个 409
  - 如实性：succeeded(result≠null,error_code=null) / failed(result=null,error_code=PROVIDER_OUTCOME_UNKNOWN)
  - 单一注册：/jobs/{id} 与 /jobs/{id}/cancel 各 1 处，均在 jobs/routes.ts
  - 嵌套 result.value 守卫：坏投影经路由 503（改前 200 透出），契约合法仍 200
  - 钉子：无取消能力 kind 的 cancel ⇒ 缺 Key 400 / 缺 If-Match 428 / 齐备 503     [exit 0]

=== [5] git diff --check ===
（无输出）                                                        [exit 0]

=== [extra · 非监工要求] npm run test:unit（合并后全量） ===
ℹ tests 1962 / ℹ pass 1961 / ℹ fail 0 / ℹ skipped 1 （duration_ms 21296.9485）   [exit 0]

=== [extra] npm run test:contract ===
ℹ tests 6 / ℹ pass 6 / ℹ fail 0                                   [exit 0]

=== [extra] npm run test:docs ===
PASS: 27 initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables  [exit 0]
```

> 全量由 **1887 → 1962** 项（上游 #16/#18 新增用例）且 **fail 0**；
> `verify-contract-status --runtime` 在**无凭据 stub 子进程里真实装配 Fastify** 后与静态扫描/对照表一致
> ⇒ "两侧装配都保留"得到运行时证据（不只是静态 diff）。
