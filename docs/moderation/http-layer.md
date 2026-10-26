# GY-I14 · 审核装配层（文字／图片版本级审核、版本重审与发布隔离）

本文件说明 **#14 的第三片（HTTP 装配片）**：把**已合并**的 `packages/moderation`（规则层 + 模型层）
装配成服务端审核域，并把结论接到**已有**契约读面 `GET /jobs/{id}`（`kind=moderation`）。
规则层与模型层的内部口径见 `docs/moderation/README.md`、`docs/moderation/model-layer.md`。

> **不得**把本片读成"真实 AI 筛查已上线"：真实 `tms`/`ims` 供应商**未授权付费**，
> `real` 模式整域 fail-closed；`stub`/`preset_demo` 用的是**明确标注的替身**，
> 替身只回报"无结论"⇒ 隔离，**不会放行任何内容**；替代品回归**不是**准确率／召回率证据
> （`docs/evaluation/sample-gap-register.md`：`ai_moderation_risk`／`ai_moderation_normal` 真实样本各为 0）。

## 1 产物与边界

| 文件 | 职责 |
| --- | --- |
| `services/api/src/moderation/types.ts` | 契约镜像（`AuditState`/`Visibility`/`TargetRef`/`JobState`/`Moderation`）+ 域内类型与常量 |
| `services/api/src/moderation/nonbypass.ts` | 不可绕过守卫（控制类字段扫描、来源不变、人审空态、无票决） |
| `services/api/src/moderation/provider.ts` | 执行模式与端口解析（real 永不用替身；替身只报无结论） |
| `services/api/src/moderation/decisions.ts` | 版本级任务台账（`moderation_decisions` 形状）+ 判定投影 + 契约对象装配与自检 |
| `services/api/src/moderation/visibility.ts` | 权威端口（替身／未接线）、读缓存、读取时可见性重查、下架 |
| `services/api/src/moderation/callback.ts` | 供应商回调 seam：HMAC 验签、信封解析、过期判定、回放守卫 |
| `services/api/src/moderation/service.ts` | 审核服务：送审／模型阶段／发布／下架／读取重查／重审报告／回调受理 |
| `services/api/src/moderation/job-source.ts` | `moderation` 作业源（接入既有 `GET /jobs/{id}`） |
| `services/api/src/moderation/packages.d.ts` | `packages/moderation` 模型层子模块的**只读**类型声明（不修改该包） |
| `services/api/src/app.ts` | **追加式**装配：可选 `moderationInjection` + 注册作业源 + decorate（回退=删该块） |

**不变式**：本片**不新增**任何契约 path/operationId/字段，**不改** `packages/contracts/**`、
**不改** `packages/moderation/**`；真实供应商调用数为 **0**。

## 2 复用了什么（不另起一套）

- 硬规则裁决：`evaluateBoundHardRules(input, options)`（规则层唯一入口 **+ 输入绑定**）；
- 模型合流／失败隔离／版本三元组：`mergeModeration`、`evaluateModelReReview`、`isModelLayerPublishable`、
  `checkMergedInvariant`（**没有**第二套规则引擎、**没有**第二套合流判定）；
- 契约形状自检：`services/api/src/jobs/result-shape.ts` 的契约镜像（`collectResultValueIssues('moderation', …)`）；
- 作业读面：既有 `services/api/src/jobs/**`（按 kind 分派、归属同形 404、契约守卫、ETag/no-store）。

## 3 版本级任务（文字与图片各自成任务）

同一 `(target, revision)` 下按 `content_kind` 各建**一条**当前任务（各有独立 `job_id`、端口类别、
prompt 模板、结论行、租约），与数据字典 `moderation_decisions` 的
`unique(target_type,target_id,revision,job_id)` 对齐：

| 内容类别 `content_kind` | 端口 `port_kind` | 模型模板 `prompt_id` | 何时建立 |
| --- | --- | --- | --- |
| `text` | `tms` | `text_moderation` | 任何内容 |
| `image` | `ims` | `image_moderation` | 内容带媒体（`media.length > 0`） |

每条任务登记（非契约字段，绝不投影进 HTTP 的 `Moderation`）：

- **结构结果**：`state`（`JobState`）／`decision`（`AuditState`）／`error_code`（契约 `ErrorCode` 或 `null`）；
- **理由**：`reason_codes`（闭集、≤30、按规则层声明序）+ `evidence.reasons`（口径标签）；
- **证据**：`evidence.provider{kind,model_version,biz_type,synthetic,origin}`、
  `model_kinds[]`（各端口状态/标签/原因码）、`rule_reason_codes`／`model_reason_codes`、
  `rule_counts`、`checked_media_refs[]`（**不透明引用**，无字节）、`text_length`（**不落原文**）；
- **输入绑定**：`input_binding_digest`（`mib1+sha256:…`）+ `input_binding_verified`；
- **模型模板与规则版本**：`prompt_id`／`prompt_version`、`rule_version`、`model_version`。

## 4 状态机、判定投影与隔离

| 情形 | 任务 `decision` / `state` | `error_code` |
| --- | --- | --- |
| 规则层命中（广告导流／私交易／硬危险／混配／无依据用量／隐私／提示注入／伪权威／绝对安全） | `rejected` / `succeeded` | `null`（合法结论，发布时才以 400 拒绝） |
| 规则层输入不可用／引擎异常／规则集非法／扫描截断 | `quarantined` / `uncertain` | `INPUT_UNCERTAIN`／`PROVIDER_OUTCOME_UNKNOWN` |
| 规则层超时 | `quarantined` / `uncertain` | `PROVIDER_TIMEOUT` |
| 规则层通过 + 该端口 `pass` | `approved` / `succeeded` | `null` |
| 规则层通过 + 该端口 `blocked` | `rejected` / `succeeded` | `null` |
| 规则层通过 + 端口失败／超时／无结论／未求值／缺证据 | `quarantined` / `uncertain` | `PROVIDER_TIMEOUT`／`PROVIDER_OUTCOME_UNKNOWN`／`PROVIDER_UNAVAILABLE` |
| 异步供应商路径：任务已建、模型层待回调 | `pending` / `queued` | `null` |
| 带媒体内容 | 两条任务均**不得** `approved`（已合并规则层对媒体一律不判通过） | `INPUT_UNCERTAIN` |

口径要点：

- **隔离一律用 `uncertain`（不是 `timed_out`）**：审核语义里"超时"就是"无结论"，用 `uncertain` 才能
  让调用方**读到**隔离原因码；本片**不合成** `timed_out`，绝不把失败/超时"记成通过"。
- **模型层可达性加严（安全方向）**：只有"规则层已通过"或"规则层**仅因声明媒体**而未评估"（图片只能由
  模型层筛查）才把内容交给模型端口；其余任何 fail-closed 情形**不外发**给第三方（既不把已判定违规或含
  PII 的内容出网，也不为注定不放行的内容付费调用）。结论方向不变：模型不得把非通过抬成通过。
- **契约对象装配不出来就不装配**：`Moderation.model_version`/`prompt_version` 无真实值（如规则层直接
  驳回因而未调用模型、或两个 kind 回报不同模型版本 ⇒ `MODEL_VERSION_CONFLICT`）时 `Job.result = null`
  （契约允许 `succeeded`/`uncertain` 不带 `result`），**绝不填占位串**。

## 5 发布隔离、下架与读取时重查

- **筛查通过与发布分开**：`approved` 只是**必要条件**；`publish()` 是独立一步，并**重跑**：
  逐任务 `isModelLayerPublishable`（合流不变式 + 模型层失败原因码 + **输入绑定重算比对**）与
  `evaluateModelReReview`（版本三元组 + 租约/历史不复活）。任一不通过 ⇒ 拒绝，且不改变可见性。
- **编辑重审**：新 `revision` 必须重新送审（新 `job_id` + 新输入绑定）；旧版本结论**不得**套新版本；
  权威侧当前 revision 推进后，旧链接读取判 `REVISION_SUPERSEDED`。
- **下架（管理员动作）**：可见性 → `hidden`、已发布 revision 置空、`(target,revision)` 记 **withdrawn 标记**、
  返回**被失效的缓存键**（下架对外唯一的信号；失效在同一次 `withdraw()` 内同步完成，不另发事件）。
  该版本**永久不可再发布**；新版本重审后**由管理员**恢复。撤回/注销 epoch 变化使旧回调失效。
- **读取时重查**：读缓存**只作提示**。每次读取都问权威端口；与权威不一致即**立即失效整链**并拒绝。
  隐藏／已删除／账号停用／已去身份／旧 revision／未发布／非所有者／无会话**一律不可见**；
  **结论过期的已发布内容同样不可见**（`RESCREEN_REQUIRED`：规则集/模型/prompt 版本在结论之后前进 ⇒
  必须重评，不得按"已审"返回；契约状态不新增，对用户的"待重评"由社区读面既有的
  `audit_state: 'pending'` 表达）。

## 6 供应商回调 seam（不在 OpenAPI 内）

架构决议（`docs/architecture/adr-001-initial-architecture.md` §62）："供应商 callback 只允许服务端
受信端点并验签，**不在客户端 OpenAPI 开放**"。因此回调是**服务端受信 seam**
（`service.ingestCallback({ raw_body, signature })`），**不是**一条新路径；是否挂 HTTP 端点由指挥决定。

核对项（任何一项不符即**拒绝**，且不得改变任何结论）：

| 核对 | 拒绝原因码 |
| --- | --- |
| HMAC-SHA256（定时安全比较；缺失/长度不符/篡改/未配密钥） | `CALLBACK_SIGNATURE_INVALID` |
| 签发时间越出 ±5 分钟 | `CALLBACK_EXPIRED` |
| 同一 `event_id` 已落定（回放；判定优先于终态） | `CALLBACK_REPLAY` |
| 作业不存在／已终态 | `CALLBACK_JOB_UNKNOWN`／`CALLBACK_JOB_TERMINAL` |
| `job_revision`／`lease_token`／`target_ref`／`content_kind`／授权 epoch 不一致 | `CALLBACK_JOB_REVISION_STALE`／`CALLBACK_LEASE_MISMATCH`／`CALLBACK_TARGET_REVISION_STALE`／`CALLBACK_CONTENT_KIND_MISMATCH`／`CALLBACK_EPOCH_REVOKED` |
| 输入摘要与任务登记不一致（换内容不换版本） | `CALLBACK_INPUT_DIGEST_MISMATCH` |
| 过期版本：`rule_version`／`model_version`／`prompt_version` 与当前不一致 | `CALLBACK_RULE_VERSION_STALE`／`CALLBACK_MODEL_VERSION_STALE`／`CALLBACK_PROMPT_VERSION_STALE` |
| 目标已下架（旧回调不得复活） | `CALLBACK_TARGET_WITHDRAWN` |
| 载荷形状/闭集非法 | `CALLBACK_PAYLOAD_INVALID` |
| 回报携带控制类字段（role/scopes/source_kind/visibility/expert_reviewed/human_review/votes/…） | `CALLBACK_CONTROL_FIELD_FORBIDDEN` |

传输层契约错误码提示（`CallbackOutcome.contract_error_code`，均在契约闭集内）：
签名 ⇒ `SCOPE_DENIED`(403)；过期/形状/控制字段 ⇒ `INVALID_REQUEST`(400)；回放 ⇒ `IDEMPOTENCY_CONFLICT`(409)；
终态/下架 ⇒ `OBJECT_UNAVAILABLE`(409)；epoch ⇒ `ACCOUNT_INACTIVE`(403)；版本/摘要/租约不符 ⇒
`REVISION_CONFLICT`(409) 或 `INVALID_REQUEST`(400)；未知作业 ⇒ `NOT_FOUND`(404)。**本片不注册路由。**

回调被接受时**只**落定该版本级任务（`pass` ⇒ `approved`；`block` ⇒ `rejected`；`unsure` ⇒ `quarantined`；
规则层未通过时 `pass` 也只落 `quarantined`），**绝不**发布。

## 7 不可绕过（AC08）

- **AI 不授权限**：端口回报一律先过 `guardModelPort`（在 `provider.resolveModerationPorts` 内统一加守卫），
  回报里出现控制类字段 ⇒ 整条回报按**形状不可信**拒绝 ⇒ 隔离（不是静默丢弃，事故形态不消失）；
- **不改来源**：`source_kind` 只能由资料/人工链路写；审核前后逐字节一致（用例断言）；
- **不标"专家已审"**：当前**无实现**（人审队列、审核人、专家认证）；`humanReviewQueue()` 恒为空态，钉子已在
  `tests/unit/admin-ui-review-state.test.mjs`／`tests/unit/admin-ops-governance.test.mjs` 条件化：路径存在时必须带 `x-scope`、响应不暴露他人票数、未接线时不得出现评审人/投票字段（`human_review_state = 'under_construction'` 不变，取自契约 `Home.human_review_state` 的 `const`）。⚠ 条件化**不是**"实现只差一处"：P3 落地时仍会红的反向钉至少 9 处（含源码 `wired: false`／`items: []` 两处**弱钉**、`REVIEW_CODE_ANCHORS` 的行区间锚、"routes 目录里没有 review 路由"、页面 `REVIEW_COUNT === 0`、审核入口空态四连），逐条见 `docs/architecture/acceptance-map.md` 的「反向钉残留清单」；
- **公众票决不进入首版**：`publicVotingEnabled() === false`；若契约出现票决路径，开关仍须默认关闭且回执 `wired: false`（钉子见 `tests/moderation/http-callback.test.mjs`）；
- 模型回报里的**自由文本**（`summary` 等）不进结果、不进日志、不落库（沿用模型层"丢弃全部自由文本"）。

## 8 执行模式（`real` 一律 fail-closed）

- `real`：**忽略**任何注入端口（它们只可能是合成替身），整域 fail-closed —— 送审／模型阶段／发布／下架／
  读取／重审／回调全部以契约 **503 `PROVIDER_UNAVAILABLE`（`retryable: true`）** 拒绝，
  **零任务、零端口调用**；作业读面对该 kind 仍是"作业不存在"同形 404。**绝不用内存/替身返回成功封套。**
- `stub` / `preset_demo`：端口为**明确标注的替身**（`provider.synthetic === true`，
  `model_version = synthetic-substitute-<kind>@0.0.0`，四个网络 seam"持有但调用即抛错"），
  替身**只回报 `unsure`** ⇒ 合流层记 `MODEL_NOT_EVALUATED` ⇒ 隔离。替身**不会放行任何内容**；
  要跑"通过"路径必须由调用方**显式注入**合成端口（仅测试/演示）。

## 9 跨线接线要求（**本片不是**社区接线；属待派单）

本片**只**交付审核域与作业源，**未改** `services/api/src/community/**`（#15 线）与
`services/api/src/admin/**`（#18 线）。后续接线需要（建议一行式调用）：

1. **投稿/编辑：先规则层，再由审核作业产出结论，未通过/未结论一律不可公开。**
   社区侧的调用点在 `createPost` / `editPost` 落库前（该文件已有 `gate.evaluate(...)` 调用），
   期望入参/出参：

   ```js
   // 送审（文字与图片各自成版本级任务；规则先挡；real 下抛 503 PROVIDER_UNAVAILABLE）
   const outcome = await moderationService.submitScreening({
     actor: { userId: authorId, role: 'user', authEpoch },      // 认证中间件给出的主体，客户端不可自述
     content: {
       target_ref: { type: 'post', id: postId, revision },      // 版本级绑定
       text: `${title}\n${body}`,                               // 与社区既有送审文本同口径
       media: media_ids.map((media_id) => ({ media_id })),      // 必须**显式**声明（省略 ≠ 没有媒体）
     },
   });
   // outcome.overall.publishable === true 只表示"筛查通过"，**不等于已发布**
   ```

2. **发布：与筛查分开的一步，且必须传**同一份 `content`**（同一 revision、同一媒体字段集合）**：

   ```js
   const published = await moderationService.publish({ actor, content }); // 不通过 ⇒ ApiError(400/409/422)
   ```

   形状一致性是**输入绑定的本意**（同 revision 换正文 ⇒ `MODEL_LAYER_INPUT_BINDING_MISMATCH` ⇒ 拒绝）。
   建议社区把"送审内容"与"发布内容"用**同一个构造函数**产出（例如 `postModerationContent(record)`），
   避免两处形状漂移。

3. **下架（#18 `hidePost`）**：把可见性动作改为调用本域，以获得下架标记 + 缓存整链失效：

   ```js
   const takedown = await moderationService.withdraw({ actor: adminActor, target_ref, reason_code });
   // takedown.invalidated_cache_keys（下架对外唯一信号：真正被清掉的缓存键，不含正文）
   ```

4. **读取（列表/详情）**：社区既有实现已在**每次读取时重算** `effectiveState`（等价口径）；
   若要复用本域缓存语义，可调用 `moderationService.readView({ actor, target_ref })`
  （隐藏/失效/注销/旧链接不因缓存或旧链接重新公开）。本片**不改**社区读取路径。

## 10 契约缺口与待接线（如实登记）

- 契约里**没有**"提交审核"的 operation：审核任务由发布/编辑链在服务端创建（属跨线接线，见 §9）；
  因此 `real` 的 503 在**服务边界**可见，传输层形态由共享错误处理器映射（`buildErrorEnvelope`）。
- 契约里**没有**供应商回调路径（ADR-001 §62 明确不在客户端 OpenAPI 开放）⇒ 回调是服务端 seam。
- 持久化是**内存**台账（PG 迁移不属本片）；`moderation_decisions` 的 SQL/迁移待接线。
- **已合并文档的边界声明需要同步（跨线，本片未改）**：
  `packages/moderation/README.md` 的"本包当前没有 HTTP 消费者"、
  `docs/moderation/model-layer.md` 的同义表述，以及
  `tests/moderation/model-ports.test.mjs` 的负控制（后者已按"前提被达成"同步，
  白名单为**逐个受信文件**，其它目录仍判失败）。前者留给指挥/监工与 `packages/moderation/**` 的所有者更新。

## 11 未取得／未验证（不得读成已完成）

- 真实 `tms`/`ims` 供应商：**未授权付费** ⇒ 未接、未调、无真实请求编号与耗时；
- 真实持久层（PG）与持久租约／队列：未接线；
- 社区发布/编辑链与后台 `hidePost` 的实际接线：**未做**（跨线待派单）；
- 200 风险 + 200 正常的独立评估：由 **GY-I21** 执行，**不在本片**；
- 人审：未上线（空态）；公众票决：首版不进入（钉子已在 `tests/**` 条件化，见 §7）；
- 部署与真机：未取得（见证据页"未取得项"）。
