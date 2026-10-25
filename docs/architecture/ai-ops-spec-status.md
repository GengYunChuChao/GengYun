# AI 与作业规格现状（四档判定）

本页把「AI 与作业」链路上**已被规格写死、且能机械证伪**的条款逐条摊开，按四档判定：已实现、部分实现、未实现、已搁置。判定只认两样东西——代码里的强制点，以及锁住该强制点的用例或迁移约束。文档里「已设计」「待验收」既不升级也不降级。

## 0 口径（先读这段，否则读数会被误读）

**判定项粒度**：一条 = 一个可独立证伪的规格条款（闭集、错误码分流、投影不变式、持久化接线、审计写面、门槛数值……），**不是 operation**。这与[契约实现状态](contract-implementation-status.md)的 operation 级 `partial` 不是同一把尺子：一个 operation（例如 `createOCR`）整体仍是 `partial`，而它内部「原文与校正严格分离」这条**条款**仍可判已实现。两处并存，互不覆盖。

**四档定义**：

| 档 | 判据 | 不算本档的情形 |
| --- | --- | --- |
| 已实现 | 有单一强制点（闭集／断言／状态机／迁移约束），且有用例或迁移把该强制点锁住 | 只在文档里写了 |
| 部分实现 | 强制点已落地，但出口仍被降级为替身、内存或被未接线的一支接管 | 分支根本不存在 |
| 未实现 | 规格要求存在、代码里没有对应强制点，且无「外部授权」类前置可豁免 | 已明确决定不做 |
| 已搁置 | 仓内有明确的「暂缓／暂不排期／需外部授权或用户决策」记录 | 只是没做 |

**统计读数**：已实现 **37** ／ 部分实现 **12** ／ 未实现 **8** ／ 已搁置 **12**，合计 **69 条**；另 1 条**未验证**（§6，本机无 PostgreSQL，真库读数未实测），不计入四档合计。

**判定项的取材面**（同一提交内可复算）：契约 AI／作业 operation 共 30 个（`getJob`／`cancelJob`／识别 4／OCR 5／语音 4／合成 1／问答 7／后台作业 2／开关 3／审计 3，见 `packages/contracts/operations.json`）；`public.jobs`／`recognition_jobs`／`ocr_jobs`／`speech_jobs`／`conversations` 五组表与迁移；`feature_flags` 三键与十个受控面；后台作业台与审计三读面；以及 §8 的需求门槛（门槛项单列，不计入 69 条）。

## 1 汇总读数

| 档 | 条数 | 一句话含义 |
| --- | --- | --- |
| 已实现 | 37 | 闭集、错误码分流、投影不变式、持久化门与开关门这些「硬边」基本齐备，且有断言锁住 |
| 部分实现 | 12 | 面已通、出口是替身或内存；或该域已接一半（有读无取消、有列表无过滤参数） |
| 未实现 | 8 | 三条 P0（审计写入、作业台真库端口、版本串真实值）＋五条 P1（统一台账、调用记录、识别供应商、审核模型层） |
| 已搁置 | 12 | 许可、真实外呼上线、iOS／适老、及若干明确写「后续片」的条目 |

按域再摊一遍（各行「计入四档」相加 = 69；后台作业台另有 1 条未验证，见 §6 不计入）：

| 域 | 计入四档 | 已实现 | 部分实现 | 未实现 | 已搁置 | 该域最硬的一条 |
| --- | --- | --- | --- | --- | --- | --- |
| 作业面公共（`/jobs/*` 与取消语义） | 10 | 9 | 1 | 0 | 0 | 取消能力按域分派，问答与审核域无取消（P01） |
| 识别 | 3 | 1 | 1 | 1 | 0 | 无已审供应商适配器，凭据齐备也 503（N07） |
| OCR | 3 | 2 | 1 | 0 | 0 | 真实提供者／媒体／登记源未接（P03） |
| 语音与转写 | 3 | 2 | 1 | 0 | 0 | 默认内存 store，真实 ASR 未验收（P04） |
| 合成 | 2 | 1 | 1 | 0 | 0 | 真实提供者与产物端口未在产品装配接线（P05） |
| 问答 | 7 | 6 | 1 | 0 | 0 | 未接真实模型，版本串零真实值（P06／N04） |
| 审核规则层 | 4 | 2 | 1 | 1 | 0 | 模型层不存在，带媒体投稿无法 approved（N08） |
| 媒体 | 2 | 1 | 0 | 0 | 1 | 真实桶接线需授权（Z09） |
| 开关（三键与十个受控面） | 6 | 6 | 0 | 0 | 0 | 本域全绿，闭集与两个错误码分流都有断言 |
| 审计 | 6 | 2 | 2 | 2 | 0 | 取消动作的审计只进内存，且读面闭集判 400（N01／N02） |
| 后台作业台 | 7 | 4 | 2 | 1 | 0 | 真库端口默认不接线，503 被用例锁死（N03） |
| 统一台账·调用记录·版本串 | 3 | 0 | 0 | 3 | 0 | `public.jobs` 零写入、`provider_invocations` 无表（N04／N05／N06） |
| 登记核对 | 1 | 0 | 1 | 0 | 0 | real 无登记库，恒 unavailable（P12） |
| 契约单源 | 1 | 1 | 0 | 0 | 0 | 错误码单源 24 码，改动必须过 `states.json` |
| 许可与真实评估排期 | 4 | 0 | 0 | 0 | 4 | 许可、Q29、iOS、120 题 |
| 上线／部署／迁移实例 | 4 | 0 | 0 | 0 | 4 | 测试版暂不上线、原生 PG17 执行、媒体桶授权 |
| 外部授权与前端形态 | 3 | 0 | 0 | 0 | 3 | tms／ims 授权、注销全量擦除、适老面 |
| **合计** | **69** | **37** | **12** | **8** | **12** | — |

## 2 已实现（37 条）

| 编号 | 判定项 | 判定 | 依据（文件:行号） | 缺口说明（剩余边界） |
| --- | --- | --- | --- | --- |
| E01 | `Job` 九键闭集，出口按契约重建、多余键一律拒绝 | 已实现 | services/api/src/jobs/registry.ts:50-60 | 只管公共作业面；后台 `AdminJob` 另有投影，两套键集不共享 |
| E02 | `JobState` 七值闭集，不得扩展 | 已实现 | services/api/src/jobs/registry.ts:38-46 | 域内状态机另有迁移表，闭集是出口判定而非库内唯一来源 |
| E03 | 六个 kind 全部注册作业源（识别／OCR／转写／问答／合成／审核） | 已实现 | services/api/src/app.ts:2279-2322 | 「注册」不等于「有能力」：取消能力另按域判定（P01） |
| E04 | 未接线 kind 与「作业不存在」同形 404 | 已实现 | services/api/src/jobs/registry.ts:108 | 同形是刻意设计，代价是运维无法从 404 分辨「没接」与「没这条」 |
| E05 | `result` 如实性不变式：`result` 非空 ⇒ 只能是 `succeeded`／`uncertain` | 已实现 | services/api/src/jobs/registry.ts:166-168 | 与识别域既有行为有一处口径差（`uncertain` 允许带 `result`），已在同文件注明 |
| E06 | 端口回传不合契约 ⇒ 503 `PROVIDER_UNAVAILABLE` + `retryable:false`，单通道 | 已实现 | services/api/src/jobs/registry.ts:130-133 | 唯一拒绝通道；不另造错误码，也不放宽冻结契约 |
| E07 | 终态判定单点（`succeeded`／`uncertain`／`failed`／`timed_out`／`cancelled`） | 已实现 | services/api/src/jobs/registry.ts:114-116 | 该函数只判读，不改状态；状态迁移仍只在各域 |
| E08 | 归属与不存在 404 同形（域内 `NOT_FOUND` ⇒ `null`） | 已实现 | services/api/src/jobs/sources.ts:41-44 | 同为刻意：不泄露存在性，同时让注册表无法区分二者 |
| E09 | 取消语义不在作业面另写状态机，只在各域一处 | 已实现 | services/api/src/jobs/sources.ts:17-22 | 作业面只透传 409／422 等域内语义 |
| E10 | 识别四端点 HTTP 闭环（受理／读／删／选种） | 已实现 | services/api/src/routes/recognitions.ts:79-116 | 闭环是 HTTP 与内存任务闭环，结果来自替身（P02） |
| E11 | OCR 五端点原文与校正严格分离（`raw_fields` / `corrected_fields`） | 已实现 | services/api/src/routes/ocr.ts:224-257 | 分离是形状层强制；真实提供者与媒体未接（P03） |
| E12 | OCR 任务与记录持久化（0024 三表，real + 有池才接） | 已实现 | services/api/src/ocr/store-pg.ts:359 | 无池或非 real 回落内存 store，并如实标 `persistent:false` |
| E13 | 转写确认只写 `confirmed_text`／`confirmed_at`，原文与不确定区间逐项不变 | 已实现 | services/api/src/routes/speech.ts:281-287 | 确认动作已锁；转写本身默认内存 store（P04） |
| E14 | 合成只接受已核对内容引用 | 已实现 | services/api/src/routes/synthesis.ts:112-177 | 受理闸已锁；真实提供者与产物端口未接（P05） |
| E15 | 问答七端点 PG 持久化（迁移 0013，会话／轮次／回答三表） | 已实现 | services/api/src/conversations/store-pg.ts:220-231 | 持久化已接；模型未接（P06）与版本串未真实（N04）是两件事 |
| E16 | 会话与轮次 keyset 分页 + HMAC 游标（TTL 15 分钟、绑主体与 `auth_epoch`） | 已实现 | services/api/src/conversations/service.ts:726-744 | 跨用户复用游标不可用；列表按契约不发 ETag |
| E17 | 回答输出守卫：引用只能逐字取自本次检索集合 | 已实现 | services/api/src/conversations/guard.ts:250-365 | 越界一律拒绝并如实记因；不追认为模型能力 |
| E18 | 用量卡只取确定性权威路径，否则恒不产出 | 已实现 | services/api/src/conversations/dose.ts:27 | 未取得判定通过前不产出任何用量卡，属刻意保守 |
| E19 | 「未接真实模型」用机器可判据前缀 `unimplemented:no-real-` 标出 | 已实现 | services/api/src/conversations/types.ts:52 | 标记机制本身已实现；真实版本串是 N04 |
| E20 | 语音轮次须 `confirmed` 转写，端口未接线时 422／404 而非假成功 | 已实现 | docs/architecture/contract-implementation-status.md:101 | 拒绝路径已锁；真实 ASR 评估另计（§8） |
| E21 | 删除级联以 `X-GY-Cascade` 三态如实披露（`initiated`／`unwired`／`failed`） | 已实现 | services/api/src/conversations/cascade.ts:76-100 | 披露机制已实现；真实清理器未接（P05／Z11 相邻） |
| E22 | 审核规则层默认 50ms 墙钟预算，超时 ⇒ `RULE_TIMEOUT` ⇒ 隔离 | 已实现 | packages/moderation/constants.mjs:224 | 预算值 50 在该行；调用侧见 services/api/src/conversations/screen.ts:124-130 |
| E23 | 审核域 real 未接真实供应商 ⇒ 503，拒绝以替身返回成功封套 | 已实现 | services/api/src/moderation/service.ts:366 | fail-closed 已锁；模型层不存在是 N08 |
| E24 | 媒体域 real 未接对象存储 ⇒ 整域 503 | 已实现 | services/api/src/media/service.ts:613 | 整域 fail-closed；真实桶接线需授权（Z09） |
| E25 | 开关三键闭集（`submissions_enabled`／`specific_herbicide_output_enabled`／`ai_enabled`）由库约束 | 已实现 | services/api/db/migrations/0020_feature_flags.sql:62-64 | 闭集在 DB 层；新增键必须走迁移，不能靠代码自带 |
| E26 | 三键默认全关 + 变更必带 `revision`／`changed_by`／`reason` | 已实现 | services/api/db/migrations/0020_feature_flags.sql:55-61 | 默认全关是安全默认；表注释另见同文件 :70-71 |
| E27 | 十个受控面清单（含识别／OCR／转写／合成／问答受理与 `verifyRegistration`） | 已实现 | services/api/src/admin/ops/flag-gate.ts:265-333 | 清单是静态表；新增受控面必须同时改表与用例 |
| E28 | 开关关闭 ⇒ 409 `OBJECT_UNAVAILABLE` + `details[].code='FLAG_CLOSED'` | 已实现 | services/api/src/admin/ops/flag-gate.ts:418-422 | 409 而非 503：关闭是确定性结论，重试不会变 |
| E29 | 开关不可识别 ⇒ 503 `PROVIDER_UNAVAILABLE` + `FLAG_UNRECOGNIZED`，`retryable` 按 cause | 已实现 | services/api/src/admin/ops/flag-gate.ts:424-437 | `retryable` 三分支（读失败／不可重试／不可识别）已成函数 |
| E30 | 武装探测三态 `ready`／`missing`／`unknown`，`unknown` 不得折叠成 `missing` | 已实现 | services/api/src/admin/ops/flag-gate.ts:449 | 三态是刻意区分「表不存在」与「读不出」；探测装配见 services/api/src/app.ts:1316-1330 |
| E31 | 三条落库审计写路径（账号停用／恢复 0017、开关变更 0020／0027） | 已实现 | services/api/src/admin/audit/catalog.ts:8-12 | 只有三条；通用写面缺位即 N01／N02 |
| E32 | 后台 scope 映射（`accounts:suspend`／`flags:write`）与动作闭集绑定 | 已实现 | services/api/src/admin/audit/catalog.ts:46-49 | 映射只写一遍；新增动作必须同时落库与扩闭集 |
| E33 | 作业台过滤参数闭集判定：闭集外 ⇒ 400 `enum`，非字符串 ⇒ 400 `type`，不复用 503 | 已实现 | services/api/src/admin/ops/jobs.ts:21-30 | 未接线时仍 503，但参数层先 400——两层不混 |
| E34 | 过滤下推 SQL（值绑定 + 枚举 cast，不拼串） | 已实现 | services/api/src/admin/ops/jobs-pg.ts:23-28 | 下推已实现；UI 不发送这些参数（P08） |
| E35 | 作业台取消只允许 `queued`／`running` → `cancelled`，终态由端口判 `TERMINAL` | 已实现 | services/api/src/admin/ops/jobs-pg.ts:30-33 | 终态拒绝已锁；该端口默认不接线（N03） |
| E36 | 后台作业台取消的前端判据（状态 + uuid + `etagForRevision`） | 已实现 | apps/admin/src/lib/jobs-api.mjs:124-130 | 前端判据已锁；后端未接线时仍会收到 503 |
| E37 | 错误码单源：`ERROR_STATUS_MAP` 12 个状态、恰好 24 个错误码 | 已实现 | services/api/src/contract.ts:14-27 | 事实源是 packages/contracts/states.json:108；`packages/contracts/` 下无源码文件 |

## 3 部分实现（12 条）

| 编号 | 判定项 | 判定 | 依据（文件:行号） | 缺口说明 |
| --- | --- | --- | --- | --- |
| P01 | 取消能力按域分派：识别／OCR／转写／合成四域提供；审核与问答两域不提供 ⇒ 503 `retryable:false` | 部分实现 | services/api/src/jobs/registry.ts:94-95 | 缺的两域不是漏接线，是域内确无取消入口；问答取消「仍如实 503」已写进台账 |
| P02 | 识别域端点、任务、选种、删除闭环 | 部分实现 | docs/architecture/contract-implementation-status.md:83-86 | 结果是 stub／preset_demo 合成替身；真实供应商与独立样本评估未验收 |
| P03 | OCR 域五端点 + 持久化 | 部分实现 | docs/architecture/contract-implementation-status.md:87-91 | 任务读取与取消已接；真实提供者／媒体／登记源未接线，用量端口恒空 |
| P04 | 转写域四端点 + 确认分离 | 部分实现 | docs/architecture/contract-implementation-status.md:92-95 | 默认内存 store；真实 ASR 评估、媒体持久化、注销清理未验收 |
| P05 | 合成域受理 + 作业读面 + 取消 | 部分实现 | docs/architecture/contract-implementation-status.md:96 | 真实提供者、核对内容引用、产物端口未在产品装配接线；听感评估未做 |
| P06 | 问答域七端点 + PG 持久化 + 输出守卫 | 部分实现 | docs/architecture/contract-implementation-status.md:97 | 未接真实模型：三个版本串带 `unimplemented:no-real-`，正文是确定性检索摘录 |
| P07 | 审核域结论可读 + 规则层可用 | 部分实现 | docs/architecture/contract-implementation-status.md:76 | 真实 tms／ims 未授权 ⇒ real 整域 fail-closed；**持久队列与租约仍为内存台账** |
| P08 | 作业台列表：过滤参数与下推 SQL 已实现 | 部分实现 | services/api/src/admin/ops/jobs-pg.ts:23-28 | 后台 UI 只发 `limit`／`cursor`（apps/admin/src/lib/jobs-api.mjs:132-147）⇒ 库侧能力无入口 |
| P09 | 审计台账内存追加（只增不改） | 部分实现 | services/api/src/admin/ops/content-pg.ts:25-27 | 重启即丢；`listAuditEvents` 在 real 模式实测 503，有池时返回的是内存空页 |
| P10 | 后台审计三读面权威分离（内存／开关库函数／全表库函数） | 部分实现 | services/api/src/admin/audit/service.ts:14-16 | 读面齐备但库内只有三条写路径；通用写面缺失（N01／N02） |
| P11 | 作业台作业投影按契约形状输出 | 部分实现 | services/api/src/admin/ops/jobs-pg.ts:17-22 | `target_ref.revision` 恒取 1、`result` 恒 `null`——形状对、语义未真实化 |
| P12 | 登记核对 `verifyRegistration` 判定内核 | 部分实现 | docs/architecture/contract-implementation-status.md:82 | real 无真实登记库 ⇒ 恒 `unavailable`；无已审用量来源 ⇒ `dose_cards` 恒空 |

## 4 未实现（8 条，含三条 P0）

| 编号 | 判定项 | 判定 | 依据（文件:行号） | 缺口说明 |
| --- | --- | --- | --- | --- |
| N01 | `action:'job.cancel'` 的审计**落库** | 未实现（P0） | services/api/src/admin/ops/service.ts:823-831 | 只进进程内内存台账（同文件 :317 的 `appendAudit`）；`admin_audit_events` 对运行时角色零权限（services/api/src/admin/ops/content-pg.ts:25-27）⇒ 重启即丢，见 §7.1 |
| N02 | 审计通用写面（迁移 0043）与动作闭集扩容 | 未实现（P0） | services/api/src/admin/audit/catalog.ts:24-35 | 迁移目录最大编号 0042，**0043 不存在**；`AUDIT_ACTIONS` 闭集只有三个动作 ⇒ `?action=job.cancel` 被判 400，见 §7.1 |
| N03 | 后台作业台真库端口的产品装配 | 未实现（P0） | services/api/src/admin/ops/jobs.ts:2-12 | `createUnwiredAdminJobPort` 是缺省：读与取消一律 503；`app.ts:1315` 仅 real + 有池才接，且 503 已被用例锁死（tests/failmatrix/cases.mjs:158-159），见 §7.2 |
| N04 | `model_version`／`prompt_version`／`rule_version` 的真实值 | 未实现（P0） | docs/architecture/contract-implementation-status.md:97 | 一律 `unimplemented:no-real-` 前缀；审核侧明示不产出这两字段且有源码扫描测试禁占位（docs/moderation/README.md:45-46），见 §7.3 |
| N05 | 统一作业台账 `public.jobs` 的真实写入 | 未实现（P1） | services/api/src/admin/ops/jobs-pg.ts:5 | 表由 0001 建好（services/api/db/migrations/0001_initial_schema.sql:203-231），但全仓**零 INSERT**；真实作业行只落 `ocr_jobs`／`recognition_jobs`／`speech_jobs` 三张域内表 |
| N06 | 调用记录表 `provider_invocations` | 未实现（P1） | docs/architecture/data-dictionary.md:48 | 全仓只出现在四份文档，**无迁移、无代码** ⇒ 无 attempt／版本串／成本的可审计记录 |
| N07 | 识别真实供应商适配器 | 未实现（P1） | services/api/src/recognitions/provider.ts:147-148 | 缺凭据即 503；**即使凭据齐备也没有已审适配器**，`recognize` 仍返回 `PROVIDER_UNAVAILABLE`（同文件 :165） |
| N08 | 审核模型层（LLM 图文／文本模型判定） | 未实现（P1） | services/api/src/moderation/service.ts:366 | 规则层可用、模型层不存在；带媒体投稿因模型层缺失而无法 approved，只能停在待审或隔离 |

### 4.1 八条未实现的解封前置

| 编号 | 解封需要什么 | 卡在哪一类决定 |
| --- | --- | --- |
| N01 | 一个对 `admin_audit_events` 有写权的窄函数，`appendAudit` 改调它 | 工程（表已存在，权限模型已定） |
| N02 | 新迁移扩写函数入参与 `AUDIT_ACTIONS` 闭集（至少加 `job.cancel`） | 工程（必须与 N01 同一片，否则写进去读不出） |
| N03 | 确认作业台数据源（`public.jobs` 先有行，否则接了也是空表） | 依赖 N05，属排序问题而非权限问题 |
| N04 | 真实模型／提示词上线并产出可核对的版本串；`provider_invocations` 提供落点 | 付费授权（模型）+ 工程（N06） |
| N05 | 各域作业受理时写 `public.jobs`（现只写三张域内表） | 工程（需先定「域内表与统一表哪张是权威」） |
| N06 | 迁移新建 `provider_invocations` + 调用点写入 attempt／版本串／耗时 | 工程（表结构在数据字典已定） |
| N07 | 一个已审供应商适配器 + 凭据 + 真实样本评估 | 付费授权（供应商）+ 外部样本 |
| N08 | tms／ims 授权与 BizType 核验，或更换供应商 | 商务授权（当前明确未授权） |

**共同点**：N01／N02／N05／N06 全是工程活，却都排在「权限与权威表」之后；N04／N07／N08 才是真正卡在授权或付费上。把两类混在一起排期，是这类缺口最容易反复返工的地方。

## 5 已搁置（12 条，均有明确「暂缓／暂不排期／需外部授权」记录）

| 编号 | 判定项 | 判定 | 依据（文件:行号） | 缺口说明（为何记为搁置而非未实现） |
| --- | --- | --- | --- | --- |
| Z01 | 素材与语料的许可调查、再分发许可 | 已搁置 | docs/verification/gy-i03-evidence.md:84 | 用户明确要求暂缓；全仓 `licensed=false`。前置是用户决策，不是代码 |
| Z02 | 独立样本调参与真实评估（Q29） | 已搁置 | docs/requirements.md:58 | 台账写明「尚未执行」；独立样本在调参前冻结，属排期决策 |
| Z03 | 服务器部署与真实外呼上线 | 已搁置 | docs/verification/gy-i26-pr69-integration-20261011.md:71 | 按用户当前要求暂缓；命令不取生产凭据、不调真实识别／语音／问答 |
| Z04 | 测试版上线前置三项 | 已搁置 | docs/verification/platform-checklist.md:64 | 用户 2026-10-25 明确「测试版暂不上线」，三项保留记录、不作阻塞 |
| Z05 | iOS 侧读数与验收 | 已搁置 | docs/verification/gy-i23-latency-capacity-local-20261020.md:216 | 用户已正式暂缓，且「暂缓 ≠ 验收通过」 |
| Z06 | 适老版 AI 面文案与触控形态 | 已搁置 | docs/verification/gy-i15-community-http-20261020.md:66 | 本轮不做，恢复时间待用户决定；既有字号与触控保护保留 |
| Z07 | 固定 120 题资料问答评估 | 已搁置 | docs/architecture/contract-implementation-status.md:97 | 台账写「仍待后续片」；题集与判分口径已存在，排期未定 |
| Z08 | 原生 PG17 实例上的迁移执行 | 已搁置 | docs/architecture/contract-implementation-status.md:100 | 同写「仍待后续片」；迁移与用例已在隔离夹具上跑过 |
| Z09 | 真实媒体对象存储接线 | 已搁置 | docs/architecture/contract-implementation-status.md:92 | 需 `--approve-real-media-wiring` + 四键 + 授权，属新增付费／权限前置 |
| Z10 | 真实 tms／ims 内容安全供应商授权 | 已搁置 | services/api/src/moderation/service.ts:366 | 原文写「tms/ims 未授权、BizType 未核验」⇒ 前置是商务授权与核验 |
| Z11 | 注销全量擦除并入既有注销闭集 | 已搁置 | docs/architecture/contract-implementation-status.md:100 | 台账记为「尚未并入」；既有闭集有用例逐字锁住，属后续片 |
| Z12 | 图片审核载荷的 mime 传递与 `MODEL_PAYLOAD_INVALID` | 已搁置 | services/api/src/media/service.ts:613 | 社区侧只传 `media_id`，ims 端口收不到 mime；等模型层（N08）落地后一并处理 |

## 6 未验证（1 条，不计入四档）

| 编号 | 判定项 | 判定 | 依据（文件:行号） | 说明 |
| --- | --- | --- | --- | --- |
| V01 | real + 有连接池时后台作业台的真库读数（列表过滤命中、取消 CAS、`TERMINAL` 拒绝） | 未验证 | services/api/src/admin/ops/jobs-pg.ts:333-339 | 代码路径存在且有构造器，但本机无 PostgreSQL，未取得真库读数；反证路径（未接线 503）反而已被用例锁定（tests/failmatrix/cases.mjs:158-159） |

### 6.1 补验 V01 的最小步骤（不改代码即可判）

1. 起一个带迁移的 PG 实例，跑到 0042，再插入若干 `recognition_jobs`／`ocr_jobs`／`speech_jobs` 行（`public.jobs` 现在是空的，见 N05）。
2. 以 real 模式 + 有池启动 API，使 `services/api/src/app.ts:1315` 走真库端口那一支。
3. `GET /admin/jobs?state=queued` 应命中而不是 503；`POST /admin/jobs/{id}/cancel` 用错 `If-Match` 应 409，对终态作业应得 `TERMINAL` 拒绝。
4. 若第 3 步仍 503，说明池未注入或判定条件不成立——此时 V01 应改判「未实现」，不得留在未验证。

## 7 三条最硬缺口（详述）

### 7.1 取消动作的审计只进内存，且读面闭集把它判 400

链路是三步，每步都只做了一半：

1. 写：`services/api/src/admin/ops/service.ts:823-831` 组装 `action:'job.cancel'`、`reasonCode:'job_cancelled'`、`result:'accepted'`，交给同文件 `:317` 的 `appendAudit`。
2. 落：`appendAudit` 写的是被注入的 `runtime.audit`——进程内数组（`services/api/src/admin/ops/content-pg.ts:25-27` 原文：`admin_audit_events` 对运行时角色**零权限**，写入只能走独立的窄函数，属另一片）。
3. 读：唯一可能的库内读面靠迁移 0033 的 `list_admin_audit_logs`（`services/api/src/admin/audit/pg.ts:5-9`），但**没有写就没有可读**；而 `GET /admin/audit-logs` 的 `action` 参数是闭集判定，闭集只有 `account.suspend`／`account.restore`／`set_flag`（`services/api/src/admin/audit/catalog.ts:24-35`），非闭集 ⇒ `INVALID_REQUEST` + `details[].code='enum'`（`services/api/src/admin/audit/service.ts:126-131`）。**结论：`?action=job.cancel` 判 400，不是空页。**

迁移 `0043` 在 main 上不存在（迁移目录最大编号 0042），这正是「窄函数」缺席的物证。严重度 P0：后台对「谁取消了哪个作业」**无持久证据**，重启即丢，且现有三动作闭集使这条记录即便入库也查不出来。

### 7.2 后台作业台的真库端口默认未接线

- 缺省是**无实现**：`services/api/src/admin/ops/jobs.ts:2-12` 的 `createUnwiredAdminJobPort()`（`wired===false`，`list()` 空、`get()` 返回 `null`、`cancel()` 一律 `PORT_UNAVAILABLE`）⇒ 服务层读与写**一律 503 `PROVIDER_UNAVAILABLE`**。
- 装配在 `services/api/src/app.ts:1313-1315`：只有 real 且有池才建 `createPostgresAdminJobPort`（`services/api/src/admin/ops/jobs-pg.ts:333-339`）。
- 现状被用例**锁死**：`tests/failmatrix/cases.mjs:158-159` 把「后台读作业面 503 + `PROVIDER_UNAVAILABLE`」写成期望值 ⇒ 接线必须同时改用例，否则 CI 会拦。

已实现的一半：状态／错误码闭集过滤（`services/api/src/admin/ops/jobs.ts:21-30`）与下推 SQL（`services/api/src/admin/ops/jobs-pg.ts:23-28`）；取消只允许 `queued`／`running`（同文件 :30-33）。未真实化的一半：`target_ref.revision` 恒取 1、`result` 恒 `null`（同文件 :17-22），后台 UI 只发 `limit`／`cursor`（`apps/admin/src/lib/jobs-api.mjs:132-147`）⇒ 过滤能力无入口。

### 7.3 模型／提示词版本零真实值

- 问答侧：`createConversation`／`createTurn` 行明写「三个版本串一律带 `unimplemented:no-real-` 前缀」（`docs/architecture/contract-implementation-status.md:97`），正文是确定性检索条目摘录，不是模型结果。该前缀同时是**机器判据**（`services/api/src/conversations/types.ts:52`）——好处是谎报会被测试抓到，代价是零真实值。
- 审核侧：`docs/moderation/README.md:45-46` 明示不产 `model_version`／`prompt_version`，且有一条用例**扫描源码**禁止占位赋值（`本片不产出 model_version / prompt_version：源码里没有占位赋值`）。
- 记录侧：`provider_invocations` 只有一行数据字典（`docs/architecture/data-dictionary.md:48`），无迁移、无代码 ⇒ 即便将来接上模型，也没有承载版本串与 attempt 的表。

结论：**当前任何「模型版本／提示词版本」的对外读数都是不可信的**，因为根本没有真实值，也没有可存放真实值的表。

### 7.4 三条 P0 的共同根因（一条线）

它们不是三件独立的事，而是同一条断点上的三截：

1. **没有承载表**：`public.jobs` 零 INSERT（N05）、`provider_invocations` 无迁移（N06）、`admin_audit_events` 对运行时角色零权限且无窄写函数（N01／N02）。前面三条都由这一截派生。
2. **于是只能进程内兜底**：作业台账、审计台账、后台作业台读面都退回内存实现，读面在 real 模式下如实 503（P09／N03）。这一层是**诚实**的——它拒绝返回空页或假成功（对照 `services/api/src/admin/audit/service.ts:33-34` 的选择），代价是后台在 real 模式下基本不可用。
3. **用例把兜底锁成期望值**：`tests/failmatrix/cases.mjs:158-159` 把 503 写成期望，于是「接线」这件事同时是一次用例改动 —— 这既是保护（不许悄悄假绿），也是负债（漏接不会被测试红）。

因此正确的接线顺序是：**先加表与窄写函数（迁移 + 角色授权），再接线端口，最后改用例**。反过来先接线，会立刻撞上「审计写不进库」和「作业行不存在」两堵墙。

## 8 真实缺口（需真实模型／样本／付费授权）

这一组**不属于**上面 69 条判定项：它们不是「代码没写」，而是需要真实外呼、独立样本或付费授权。门槛数值直接取自需求原文。

| 缺口项 | 门槛／原文 | 依据（文件:行号） | 现状 |
| --- | --- | --- | --- |
| 识别（拍草）真实外呼 | 覆盖内 300 张，Top1 ≥ 85%、Top3 ≥ 95% | docs/implementation-requirements.md:460 | 未执行；供应商适配器缺失（N07） |
| 识别泛化与低质量 | 覆盖外误判 ≤ 5%，低质量图可用 ≥ 95% | docs/implementation-requirements.md:461 | 未执行 |
| 标签 OCR | ≥ 200 张，字段准确率 ≥ 95% | docs/implementation-requirements.md:462 | 未执行；真实提供者未接（P03） |
| 登记匹配 | ≥ 100 组 | docs/implementation-requirements.md:463 | 未执行；real 无登记库（P12） |
| AI 社区筛查 | 200 恶意 + 200 正常，召回 ≥ 95%，误隔离 ≤ 10% | docs/implementation-requirements.md:464 | 未执行；模型层缺失（N08） |
| 普通话播报 | ≥ 30 段 | docs/implementation-requirements.md:465 | 未执行；真实 TTS 提供者未接（P05） |
| 普通话 ASR | ≥ 50 段，字符错误率 ≤ 15% | docs/implementation-requirements.md:466 | 未执行 |
| 大模型资料问答 | 固定 120 题（60 可答／20 不足／20 危险／20 注入） | docs/implementation-requirements.md:467 | 未执行（Z07） |
| 两类识别耗时 | 各 ≥ 30 次真实调用，提交至展示 p95 ≤ 10s，失败率 ≤ 5%，最长 30s 转明确超时 | docs/implementation-requirements.md:480 | 未取得读数 |
| 语音问答耗时 | p95 ≤ 5s／≤ 10s，单阶段最长 30s 明确超时 | docs/implementation-requirements.md:481 | 未取得读数 |
| 页面性能 | 首屏 p95 ≤ 2s，查询 p95 ≤ 3s | docs/implementation-requirements.md:479 | 未取得读数 |
| Q29 独立样本与真实语音／模型评估 | 「尚未执行」 | docs/requirements.md:58 | 未执行（Z02） |
| 评估脚本口径 | `npm run test:evaluation` 只验评估程序，不等于真实模型指标 | docs/development-guide.md:119 | 口径已固定，勿把程序绿读成指标绿 |
| 版本串真实值 | `model_version`／`prompt_version`／`rule_version` 非占位 | docs/moderation/README.md:45-46 | 零真实值（N04） |

**一句话**：这一节的每一项都以「真实调用／真实样本／付费授权」为前置，代码侧再绿也不能抵。三条复算纪律：样本必须在调参前冻结（Q29 口径，docs/requirements.md:58）；「≥ 30 次真实调用」「≥ 200 张」数的是**外呼次数**而不是用例迭代；每次读数必须带环境标注（原生 PG17／隔离夹具／本机回环），否则不可与本页其他读数比较。

## 9 复核方式（本页读数的反证路径）

```powershell
node tools/verify-doc-anchors.mjs --strict   # 本页所有「路径:行号」必须指向真实存在的行
npm run test:docs                            # 文档链接、表格列数、F／AC／Q 映射
npm run verify:anchors                       # 契约台账锚点 + 文档手写行号
```

读数会因下列改动失效，改一处就要改本页对应行：开关受控面清单扩容（E27）、`AUDIT_ACTIONS` 闭集扩容（N02）、作业台端口接线（N03）、`public.jobs` 出现首个 INSERT（N05）、`provider_invocations` 落迁移（N06）、任一版本串去掉 `unimplemented:no-real-` 前缀（N04）。

**不夸大的三条**：本页的「已实现」只证机制在代码里成立且被锁，不证该域可上线；「已实现」不把 operation 从 `partial` 升级；本页不复制真实能力验收，也不替代 §8 的任何门槛读数。

### 9.1 判定升降的条件（改判定时照着走）

| 档位迁移 | 触发条件 | 必须同步改的东西 |
| --- | --- | --- |
| 未实现 → 部分实现 | 端口／表／分支已存在，但出口仍被未接线的一支接管 | 补「缺口说明」写清是哪种降级；台账（若属 operation）同步 |
| 部分实现 → 已实现 | 强制点唯一、且有用例或迁移约束锁住；替身路径被删除或明确仅测试用 | 补用例锚点；本页依据列加锁它的用例行号 |
| 已实现 → 部分实现 | 强制点被绕过（新入口未过守卫）或锁它的用例被弱化 | 说明绕过路径；这属回退，须在 PR 里单列 |
| 已搁置 → 未实现 | 外部前置消失（授权到手／用户恢复排期）而代码仍未做 | 改判据为「该做而未做」，去掉暂缓依据 |
| 已搁置 → 已实现 | 授权到位且代码落地 | 同时补 §8 对应门槛的真实读数，二者缺一不算 |
| 未验证 → 已实现 | 在 real + 有池环境取到真库读数（列表过滤命中、取消 CAS、`TERMINAL` 拒绝） | 记下取得读数的环境与日期；本机无 PG 时不得改判 |

## 10 附录：契约 operation 与本页判定项的对照

本页判定项不是 operation，但每个 operation 都能追到支撑它的条款编号。契约共 118 个 operation，其中 AI／作业域 30 个（下表按组列出，组内 operation 共用同一批判定项）。

| operation（组） | 域 | 支撑它的判定项 |
| --- | --- | --- |
| `getJob` | 作业面公共 | E01、E04、E05、E06、E07 |
| `cancelJob` | 作业面公共 | E09、P01 |
| `createRecognition`／`getRecognition`／`deleteRecognition`／`selectSpecies` | 识别 | E10、P02、N07 |
| `createOCR`／`getOCR`／`deleteOCR`／`correctOCR`／`verifyOCR` | OCR | E11、E12、P03 |
| `createTranscription`／`getTranscription`／`deleteTranscription`／`confirmTranscription` | 语音与转写 | E13、E20、P04 |
| `createSynthesis` | 合成 | E14、P05 |
| `createConversation`／`listConversations`／`getConversation`／`deleteConversation` | 问答 | E15、E16、E19、P06 |
| `createTurn`／`listTurns`／`deleteTurn` | 问答 | E15、E17、E19、E20、P06、N04 |
| `listAdminJobs` | 后台作业台 | E33、E34、P08、P11、N03 |
| `cancelAdminJob` | 后台作业台 | E35、E36、N01、N03 |
| `listFlags` | 开关 | E25、E26、E27 |
| `setFlag` | 开关 | E28、E31、E32 |
| `listFlagAuditEvents` | 审计 | E31、P10 |
| `listAuditLogs` | 审计 | E31、P10、N01、N02 |
| `listAuditEvents` | 审计 | P09、P10、N01、N02 |

读法：一个 operation 在[契约实现状态](contract-implementation-status.md)里是 `partial`，本页对应条款却可能多数是「已实现」——那说明该 operation 差的不是机制，而是**接线**或**真实值**。反之，若某 operation 的支撑条款里出现 N 编号，它就是被那条未实现项按住的。

## 11 相关页与维护

- [契约实现状态](contract-implementation-status.md)：operation 级状态与逐行证据（本页与之互补，不覆盖）
- [数据字典](data-dictionary.md)：`jobs`、`provider_invocations` 等表的字段口径
- [审核设计](../moderation/README.md)：规则层与模型层的边界、版本串不产出的原因
- [代码实现需求](../implementation-requirements.md)：§8 全部门槛数值的原文
- [开发指南](../development-guide.md)：`test:docs`、`verify:anchors`、`test:evaluation` 三脚本各自证明什么
- [开发进度](../development-progress.md)：本页的入口行

维护规则：只按「代码／迁移／用例」的现状改判定；某条从「未实现」转「已实现」必须同时给出强制点与锁它的用例；「已搁置」转出必须附用户决策或授权记录。
