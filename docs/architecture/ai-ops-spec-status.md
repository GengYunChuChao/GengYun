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
| 已搁置 | 仓内有**逐字**的「暂缓／暂不排期／需外部授权或用户决策」记录，且该记录覆盖本条 | 「仍待后续片」「尚未执行」「尚未并入」这类**排期自述** |

**重算口径（本版读数与上一版不同的原因）**：本版基线是 `origin/main` = `8b5b8afe`（含 Reviewed PR #589、#609、#610；#610 只加迁移 `0044` 与真库臂的第三方删除一步，不改本页任何判定，下文两轮改判与它无关）。第一轮（#589 后）：#589 把「后台作业取消审计落库」（迁移 `0043`）与「作业台真库端口」两件事合进了 main，上一版的 N01／N03 两条前提失效，必须改判；同时上一版把「仍待后续片／尚未执行／尚未并入」当成搁置依据，属**口径越权**——文件内的排期自述不构成「决定不做」。第二轮（#609 后）：#609 把 `job.cancel` 登记进 `AUDIT_ACTIONS` 四值闭集，N01 剩下的那半条（读面筛不出取消动作）也失效，故撤条并入 E40；同一提交没动台账那句（N02 继续开着）。两轮改动逐条对账如下（不删条目，只改档）：

| 上一版编号 | 上一版定性 | 本版定性 | 改判依据 |
| --- | --- | --- | --- |
| 原 N03 | 未实现（作业台端口未接线） | 撤条 → 并入 E38 | `services/api/src/app.ts:1353` 的 `adminRealUnwired` 值只等于「real 模式」，`:1375-1377` 在 real + 有池时即构造生产端口 |
| 原 Z02（Q29） | 已搁置 | N08（未实现） | 原文只有「尚未执行」（docs/requirements.md:58），无暂缓记录 |
| 原 Z07（120 题） | 已搁置 | N09（未实现） | 台账「仍待后续片」是排期自述；门槛原文见 docs/implementation-requirements.md:467 |
| 原 Z08（原生 PG17 迁移） | 已搁置 | 并入 E39 | 真库臂 workflow 用 `postgres:17.11` 并跑全链迁移（.github/workflows/real-pg-integration.yml:72） |
| 原 Z09（真实媒体桶接线） | 已搁置 | 并入 E24，残余转 N12 | 接线已获授权且跑通一次真实 ASR（docs/verification/gy-i11-real-media-wiring-20261025.md:75） |
| 原 Z11（注销全量擦除） | 已搁置 | N10（未实现） | 「尚未并入」是没做，不是决定不做 |
| 原 Z12（审核载荷 mime） | 已搁置 | N11（未实现） | 代码缺口；所引 fail-closed 句只管整域不可用，不含「暂缓」 |
| 原 N01（审计取消动作不可读） | 未实现（P0） | 撤条 → 并入 E40（已实现） | #609：`AUDIT_ACTIONS` 恰四值且 `job.cancel` 在末位（`services/api/src/admin/audit/catalog.ts:41-46`），`?action=job.cancel` 由 400 转 200（`tests/unit/admin-audit-action-jobs-cancel.test.mjs:159`） |

**统计读数**：已实现 **40** ／ 部分实现 **12** ／ 未实现 **11** ／ 已搁置 **6**，合计 **69 条**；另 1 条**未验证**（§6，真库臂本机未复跑），不计入四档合计。两轮改判都不动总数：Z 档由 12 条降为 6 条是**升档**（撤销搁置依据后按事实归入未实现或已实现），不是「删条目凑数」；本版再把 N01 从「未实现」升进 §2 的 E40（闭集补齐并有用例锁住，见 §9.1），于是 已实现 39→40、未实现 12→11。69 条总数与上一版一致，逐条去向见上表。

**判定项的取材面**（同一提交内可复算）：契约 AI／作业 operation 共 30 个（`getJob`／`cancelJob`／识别 4／OCR 5／语音 4／合成 1／问答 8／后台作业 2／开关 3／审计 3，见 `packages/contracts/operations.json`）；`public.jobs`／`recognition_jobs`／`ocr_jobs`／`speech_jobs`／`conversations` 五组表与迁移；`feature_flags` 三键与十个受控面；后台作业台（含真库臂 `tests/integration/admin-jobs-pg.mjs`）与审计三读面；以及 §8 的需求门槛（门槛项单列，不计入 69 条）。

## 1 汇总读数

| 档 | 条数 | 一句话含义 |
| --- | --- | --- |
| 已实现 | 40 | 闭集、错误码分流、投影不变式、持久化门、开关门与真库端口这些「硬边」齐备，且有断言锁住（本版新增审计动作闭集四项，E40） |
| 部分实现 | 12 | 面已通、出口是替身或内存；或该域已接一半（有读无取消、有过滤无入口、投影语义未真实化） |
| 未实现 | 11 | 一条 P0（版本串零真实值）＋十条 P1（审计台账同步、统一台账、调用记录、识别供应商、审核模型层、评估排期、媒体读句柄等） |
| 已搁置 | 6 | 均有逐字暂缓／不做／未授权记录：许可、iOS、适老、部署、测试版前置、tms／ims 授权 |

按域再摊一遍（各行「计入四档」相加 = 69；后台作业台另有 1 条未验证，见 §6 不计入）：

| 域 | 计入四档 | 已实现 | 部分实现 | 未实现 | 已搁置 | 该域最硬的一条 |
| --- | --- | --- | --- | --- | --- | --- |
| 作业面公共（`/jobs/*` 与取消语义） | 10 | 9 | 1 | 0 | 0 | 取消能力按域分派，问答与审核域无取消（P01） |
| 识别 | 3 | 1 | 1 | 1 | 0 | 无已审供应商适配器，凭据齐备也 503（N06） |
| OCR | 3 | 2 | 1 | 0 | 0 | 真实提供者／媒体／登记源未接（P03） |
| 语音与转写 | 3 | 2 | 1 | 0 | 0 | 默认内存 store，真实 ASR 未验收（P04） |
| 合成 | 2 | 1 | 1 | 0 | 0 | 真实提供者与产物端口不在产品装配（P05） |
| 问答 | 7 | 6 | 1 | 0 | 0 | 未接真实模型，版本串零真实值（P06／N03） |
| 审核规则层与载荷 | 5 | 2 | 1 | 2 | 0 | 模型层不存在（N07）；载荷缺 mime（N11） |
| 媒体 | 2 | 1 | 0 | 1 | 0 | 读句柄网关未接（N12）；写链路已验收（E24） |
| 开关（三键与十个受控面） | 6 | 6 | 0 | 0 | 0 | 本域全绿，闭集与两个错误码分流都有断言 |
| 审计 | 6 | 3 | 2 | 1 | 0 | `job.cancel` 已登记进闭集、读面可筛（E40）；审计总台账**已有页面**消费全表读面（`apps/admin/src/views/AuditLogsView.vue:72` 调 `listAuditLogs`，导航 `apps/admin/src/App.vue:33`、渲染 `apps/admin/src/App.vue:70`，#633）；剩余是三读面读数不合并（P10）与台账滞后（N02）。原写「后台无入口」为误，见 `docs/verification/gy-r67-docs-truth-20261027.md` |
| 后台作业台（含真库臂） | 8 | 6 | 2 | 0 | 0 | 端口已接线并通过真库回归；投影语义未真实化（P11） |
| 统一台账·调用记录·版本串 | 3 | 0 | 0 | 3 | 0 | `public.jobs` 零写入、`provider_invocations` 无表（N04／N05） |
| 登记核对 | 1 | 0 | 1 | 0 | 0 | real 无登记库，恒 unavailable（P12） |
| 契约单源 | 1 | 1 | 0 | 0 | 0 | 错误码单源 28 码，改动必须过 `states.json` |
| 许可与真实评估排期 | 3 | 0 | 0 | 2 | 1 | 许可调查暂缓（Z01）；Q29 与 120 题属未实现（N08／N09） |
| 上线／部署／迁移实例 | 2 | 0 | 0 | 0 | 2 | 测试版与服务器部署按用户要求暂缓（Z04／Z05） |
| 范围决策与外部授权 | 4 | 0 | 0 | 1 | 3 | iOS 与适老为范围决策（Z02／Z03）；注销擦除未并入（N10） |
| **合计** | **69** | **40** | **12** | **11** | **6** | — |

## 2 已实现（40 条）

| 编号 | 判定项 | 判定 | 依据（文件:行号） | 缺口说明（剩余边界） |
| --- | --- | --- | --- | --- |
| E01 | `Job` 九键闭集，出口按契约重建、多余键一律拒绝 | 已实现 | services/api/src/jobs/registry.ts:50-60 | 只管公共作业面；后台 `AdminJob` 另有投影，两套键集不共享 |
| E02 | `JobState` 七值闭集，不得扩展 | 已实现 | services/api/src/jobs/registry.ts:38-46 | 域内状态机另有迁移表，闭集是出口判定而非库内唯一来源 |
| E03 | 六个 kind 全部注册作业源（识别／OCR／转写／问答／合成／审核） | 已实现 | services/api/src/app.ts:2433-2472 | 「注册」不等于「有能力」：取消能力另按域判定（P01） |
| E04 | 未接线 kind 与「作业不存在」同形 404 | 已实现 | services/api/src/jobs/registry.ts:109 | 同形是刻意设计，代价是运维无法从 404 分辨「没接」与「没这条」 |
| E05 | `result` 如实性不变式：`result` 非空 ⇒ 只能是 `succeeded`／`uncertain` | 已实现 | services/api/src/jobs/registry.ts:177 | 与识别域既有行为有一处口径差（`uncertain` 允许带 `result`），已在同文件注明 |
| E06 | 端口回传不合契约 ⇒ 503 `PROVIDER_UNAVAILABLE` + `retryable:false`，单通道 | 已实现 | services/api/src/jobs/registry.ts:130-133 | 唯一拒绝通道；不另造错误码，也不放宽冻结契约 |
| E07 | 终态判定单点（`succeeded`／`uncertain`／`failed`／`timed_out`／`cancelled`） | 已实现 | services/api/src/jobs/registry.ts:114-116 | 该函数只判读，不改状态；状态迁移仍只在各域 |
| E08 | 归属与不存在 404 同形（域内 `NOT_FOUND` ⇒ `null`） | 已实现 | services/api/src/jobs/sources.ts:41-44 | 同为刻意：不泄露存在性，同时让注册表无法区分二者 |
| E09 | 取消语义不在作业面另写状态机，只在各域一处 | 已实现 | services/api/src/jobs/sources.ts:17-22 | 作业面只透传 409／422 等域内语义 |
| E10 | 识别四端点 HTTP 闭环（受理／读／删／选种） | 已实现 | services/api/src/routes/recognitions.ts:79-116 | 闭环是 HTTP 与内存任务闭环，结果来自替身（P02） |
| E11 | OCR 五端点原文与校正严格分离（`raw_fields` / `corrected_fields`） | 已实现 | services/api/src/routes/ocr.ts:224-257 | 分离是形状层强制；真实提供者与媒体未接（P03） |
| E12 | OCR 任务与记录持久化（0024 三表，real + 有池才接） | 已实现 | services/api/src/ocr/store-pg.ts:359 | 无池或非 real 回落内存 store，并如实标 `persistent:false` |
| E13 | 转写确认只写 `confirmed_text`／`confirmed_at`，原文与不确定区间逐项不变 | 已实现 | services/api/src/routes/speech.ts:281-287 | 确认动作已锁；转写本身默认内存 store（P04） |
| E14 | 合成只接受已核对内容引用 | 已实现 | services/api/src/routes/synthesis.ts:112-177 | 受理闸已锁；真实提供者与产物端口未接（P05） |
| E15 | 问答七端点 PG 持久化（迁移 0013，会话／轮次／回答三表） | 已实现 | services/api/src/conversations/store-pg.ts:220-231 | 持久化已接；模型未接（P06）与版本串未真实（N03）是两件事 |
| E16 | 会话与轮次 keyset 分页 + HMAC 游标（TTL 15 分钟、绑主体与 `auth_epoch`） | 已实现 | services/api/src/conversations/service.ts:726-744 | 跨用户复用游标不可用；列表按契约不发 ETag |
| E17 | 回答输出守卫：引用只能逐字取自本次检索集合 | 已实现 | services/api/src/conversations/guard.ts:250-365 | 越界一律拒绝并如实记因；不追认为模型能力 |
| E18 | 用量卡只取确定性权威路径，否则恒不产出 | 已实现 | services/api/src/conversations/dose.ts:27 | 未取得判定通过前不产出任何用量卡，属刻意保守 |
| E19 | 「未接真实模型」用机器可判据前缀 `unimplemented:no-real-` 标出 | 已实现 | services/api/src/conversations/types.ts:52 | 标记机制本身已实现；真实版本串是 N03 |
| E20 | 语音轮次须 `confirmed` 转写，端口未接线时 422／404 而非假成功 | 已实现 | docs/architecture/contract-implementation-status.md:101 | 拒绝路径已锁；真实 ASR 评估另计（§8） |
| E21 | 删除级联以 `X-GY-Cascade` 三态如实披露（`initiated`／`unwired`／`failed`） | 已实现 | services/api/src/conversations/cascade.ts:76-100 | 披露机制已实现；真实清理器未接（P05／N10 相邻） |
| E22 | 审核规则层默认 50ms 墙钟预算，超时 ⇒ `RULE_TIMEOUT` ⇒ 隔离 | 已实现 | packages/moderation/constants.mjs:224 | 预算值 50 在该行；调用侧见 services/api/src/conversations/screen.ts:124-130 |
| E23 | 审核域 real 未接真实供应商 ⇒ 503，拒绝以替身返回成功封套 | 已实现 | services/api/src/moderation/service.ts:366 | fail-closed 已锁；模型层不存在是 N07 |
| E24 | 媒体域 real 未接对象存储 ⇒ 整域 503 | 已实现 | services/api/src/media/service.ts:613 | 整域 fail-closed 仍在；真实桶接线已获授权并跑通一次真实 ASR（docs/verification/gy-i11-real-media-wiring-20261025.md:75），残余是读句柄网关（N12） |
| E25 | 开关三键闭集（`submissions_enabled`／`specific_herbicide_output_enabled`／`ai_enabled`）由库约束 | 已实现 | services/api/db/migrations/0020_feature_flags.sql:62-64 | 闭集在 DB 层；新增键必须走迁移，不能靠代码自带 |
| E26 | 三键默认全关 + 变更必带 `revision`／`changed_by`／`reason` | 已实现 | services/api/db/migrations/0020_feature_flags.sql:55-61 | 默认全关是安全默认；表注释另见同文件 :70-71 |
| E27 | 十个受控面清单（含识别／OCR／转写／合成／问答受理与 `verifyRegistration`） | 已实现 | services/api/src/admin/ops/flag-gate.ts:265-333 | 清单是静态表；新增受控面必须同时改表与用例 |
| E28 | 开关关闭 ⇒ 409 `OBJECT_UNAVAILABLE` + `details[].code='FLAG_CLOSED'` | 已实现 | services/api/src/admin/ops/flag-gate.ts:418-422 | 409 而非 503：关闭是确定性结论，重试不会变 |
| E29 | 开关不可识别 ⇒ 503 `PROVIDER_UNAVAILABLE` + `FLAG_UNRECOGNIZED`，`retryable` 按 cause | 已实现 | services/api/src/admin/ops/flag-gate.ts:424-437 | `retryable` 三分支（读失败／不可重试／不可识别）已成函数 |
| E30 | 武装探测三态 `ready`／`missing`／`unknown`，`unknown` 不得折叠成 `missing` | 已实现 | services/api/src/admin/ops/flag-gate.ts:449 | 三态是刻意区分「表不存在」与「读不出」；探测装配见 services/api/src/app.ts:1316-1330 |
| E31 | 十条落库审计写路径（账号停用／恢复 0017、开关变更 0020／0027、scope 授予／撤销 0041、作业取消 0043、scope 操作被拒 0046、内容下架 0047 的 `public.record_admin_post_hide_audit` → `post.hide`、管理员账号停用／恢复 0048 的 `public.disable_admin_account`／`enable_admin_account` → `admin_account.disable`／`admin_account.enable`） | 已实现 | services/api/src/admin/audit/catalog.ts:9-18 | 表注释十行与 `AUDIT_ACTIONS` 十值一一对应，但**顺序不同**：表按迁移顺序列（第 4／5 行 = 0041 的 `grant_admin_scope`／`revoke_admin_scope`、第 6 行 = 0043 的 `record_admin_job_cancel_audit`（审计行写 `scope='jobs:cancel'`）、第 7 行 = 0046 的 `record_admin_scope_denial`、第 8 行 = 0047 的 `record_admin_post_hide_audit`（审计行写 `scope='sources:write'`）、第 9／10 行 = 0048 的 `disable_admin_account`／`enable_admin_account`（审计行写 `scope='scopes:write'`）），闭集把 `job.cancel` 留在第 4 位（历史顺序，见 tests/unit/admin-audit-action-jobs-cancel.test.mjs:150-154），新增值一律追加末位；0048 两函数另由 tests/unit/admin-account-disable-pins.test.mjs 钉住（审计 `action`/`scope`/`reason_code` 在函数体内写死、`before_value`／`after_value` 恒 NULL） |
| E32 | 后台 scope 映射（`accounts:suspend`／`flags:write`／`jobs:cancel`）与动作闭集绑定 | 已实现 | services/api/src/admin/audit/catalog.ts:57-68 | 映射只写一遍；`job` 映射的是审计行 `scope` 列**实际写的值** `jobs:cancel`（不是 `jobs:read`——映射成后者会让 `?entity=job` 恒空页） |
| E33 | 作业台过滤参数闭集判定：闭集外 ⇒ 400 `enum`，非字符串 ⇒ 400 `type`，不复用 503 | 已实现 | services/api/src/admin/ops/jobs.ts:20-27 | 两层不混：参数层先 400，未接线分支才 503（同文件 :40、:44-45） |
| E34 | 过滤下推 SQL（值绑定 + 枚举 cast，不拼串） | 已实现 | services/api/src/admin/ops/jobs-pg.ts:23-28 | 下推已实现；UI 不发送这些参数（P08） |
| E35 | 作业台取消只允许 `queued`／`running` → `cancelled`，终态由端口判 `TERMINAL` | 已实现 | services/api/src/admin/ops/jobs-pg.ts:30-33 | 终态拒绝已锁，并由真库臂钉住（E39） |
| E36 | 后台作业台取消的前端判据（状态 + uuid + `etagForRevision`） | 已实现 | apps/admin/src/lib/jobs-api.mjs:124-130 | 前端判据已锁；后端未注入端口时仍会收到 503 |
| E37 | 错误码单源：`ERROR_STATUS_MAP` 13 个状态、恰好 28 个错误码 | 已实现 | services/api/src/contract.ts:14-31 | 事实源是 packages/contracts/states.json:108；28 = 13 个状态档的码数之和（403 档 `SELF_SCOPE_GRANT_DENIED`、409 档 `LAST_SCOPE_MANAGER` 是 #646 新增，409 档 `SELF_DISABLE_DENIED` 是 R68 新增，500 档 `INTERNAL_ERROR` 是 GY-R67-A03 新增——未预期异常由 `services/api/src/app.ts` 的 `setErrorHandler` 兜底以该码返回；页面侧 `apps/admin/src/lib/admin-contract.mjs` 同步到 28 项）；`packages/contracts/` 下无源码文件 |
| E38 | 后台作业台**真库端口**的产品装配：real + 有池 ⇒ `createPostgresAdminJobPort` | 已实现 | services/api/src/app.ts:1375-1377 | `adminRealUnwired` 只是「real 模式」的别名（同文件 :1341）；生产端口的 `persistent: true` 见 services/api/src/admin/ops/jobs-pg.ts:450-451 |
| E39 | 真库臂回归：三域表读面、9 字段投影、取消 CAS 与审计恰 1 行、过滤下推、游标 | 已实现 | tests/integration/admin-jobs-pg.mjs:661 | 脚本在 CI 名单内（.github/workflows/real-pg-integration.yml:8），用 `postgres:17.11` 与全链迁移（同文件 :72） |
| E40 | 审计 `action` 闭集覆盖库内全部写入点：`AUDIT_ACTIONS` 恰十值（`job.cancel` 仍在第 4 位，`admin_scope.grant`／`revoke`／`deny` 依次在第 5–7 位，`post.hide` 第 8 位，`admin_account.disable`／`enable` 追加在第 9／10 位），`?action=job.cancel`、`?action=admin_scope.grant`、`?action=post.hide`、`?action=admin_account.disable` 都由 400 转 200 | 已实现 | services/api/src/admin/audit/catalog.ts:250-261 | 锁它的用例：tests/unit/admin-audit-action-jobs-cancel.test.mjs:171（`?action=job.cancel` ⇒ 200 且只回该动作）、tests/unit/admin-audit-action-jobs-cancel.test.mjs:150-154（前 4 项长度仍为 4、第 4 项仍是 `job.cancel`——扩值只能追加末位）、tests/unit/admin-audit-action-jobs-cancel.test.mjs:225（闭集外仍 400、零端口调用）；第 8 值 `post.hide` 另由 tests/unit/admin-audit-logs.test.mjs:395（`entity=post` 只等于 `post.hide`、护栏外合法 action 仍 400 且零端口调用）与 tests/unit/community-audit-channel-pins.test.mjs:268（库内 `post.hide` 写入点恰 0047 一处）钉住；第 9／10 值与 `admin_account` 实体护栏由 tests/unit/admin-account-disable-pins.test.mjs 与 tests/unit/admin-ui-audit-logs.test.mjs 钉住（后者断言 10 个动作、6 个实体）；逐值对拍另由 tests/unit/admin-audit-logs.test.mjs:144-145（契约 `action` enum === `AUDIT_ACTIONS`、`entity` enum === `AUDIT_ENTITIES`）与 tests/unit/ai-ops-ledger-pins.test.mjs:173 钉住，契约枚举同步到十项（packages/contracts/openapi.json:11633-11644）、`entity` 同步到六项（packages/contracts/openapi.json:11652-11659）。剩余边界：审计总台账页已消费该读面（`apps/admin/src/views/AuditLogsView.vue:72`、导航 `apps/admin/src/App.vue:33`），缺口是三个读面各自直连、读数不合并，且无端到端验收 |

## 3 部分实现（12 条）

| 编号 | 判定项 | 判定 | 依据（文件:行号） | 缺口说明 |
| --- | --- | --- | --- | --- |
| P01 | 取消能力按域分派：识别／OCR／转写／合成四域提供；审核与问答两域不提供 ⇒ 503 `retryable:false` | 部分实现 | services/api/src/jobs/registry.ts:99 | 缺的两域不是漏接线，是域内确无取消入口；问答取消「仍如实 503」已写进台账 |
| P02 | 识别域端点、任务、选种、删除闭环 | 部分实现 | docs/architecture/contract-implementation-status.md:83-86 | 结果是 stub／preset_demo 合成替身；真实供应商与独立样本评估未验收（N06） |
| P03 | OCR 域五端点 + 持久化 | 部分实现 | docs/architecture/contract-implementation-status.md:87-91 | 任务读取与取消已接；真实提供者／媒体／登记源未接线，用量端口恒空 |
| P04 | 转写域四端点 + 确认分离 | 部分实现 | docs/architecture/contract-implementation-status.md:92-95 | 默认内存 store；真实 ASR 评估、媒体持久化、注销清理未验收 |
| P05 | 合成域受理 + 作业读面 + 取消 | 部分实现 | docs/architecture/contract-implementation-status.md:96 | 真实提供者、核对内容引用、产物端口不在产品装配；听感评估未做 |
| P06 | 问答域七端点 + PG 持久化 + 输出守卫 | 部分实现 | docs/architecture/contract-implementation-status.md:97 | 未接真实模型：三个版本串带 `unimplemented:no-real-`，正文是确定性检索摘录 |
| P07 | 审核域结论可读 + 规则层可用 | 部分实现 | docs/architecture/contract-implementation-status.md:76 | 真实 tms／ims 未授权 ⇒ real 整域 fail-closed（Z06）；持久队列与租约仍是内存台账 |
| P08 | 作业台列表：过滤参数与下推 SQL 已实现 | 部分实现 | services/api/src/admin/ops/jobs-pg.ts:23-28 | 后台 UI 只发 `limit`／`cursor`（apps/admin/src/lib/jobs-api.mjs:136-146）⇒ 库侧过滤能力无入口 |
| P09 | 非持久端口的审计台账（内存追加、只增不改） | 部分实现 | services/api/src/admin/ops/content-pg.ts:25-27 | 仍只增不改、重启即丢；但**真库端口已不再走它**：持久端口在自身事务里写库（services/api/src/admin/ops/service.ts:853-854 只在 `!persistent` 时追加内存） |
| P10 | 后台审计三读面权威分离（内存／开关库函数／全表库函数） | 部分实现 | services/api/src/admin/audit/service.ts:14-16 | 闭集那半条已随 #609 补齐（E40）；出口侧：审计总台账页已消费全表读面（`apps/admin/src/views/AuditLogsView.vue:72` 调 `listAuditLogs`，导航 `apps/admin/src/App.vue:33`、渲染 `apps/admin/src/App.vue:70`，#633），另两个审计页仍分别只接内存读面（apps/admin/src/lib/audit-events.mjs:33）与只认 `set_flag` 的开关审计面（apps/admin/src/lib/flag-audit.mjs:54）⇒ 三读面读数不能合并、页面读数也无端到端验收，故仍判部分实现。原写「全仓没有页面消费 `GET /admin/audit-logs`」为误，见 `docs/verification/gy-r67-docs-truth-20261027.md` |
| P11 | 作业台作业投影按契约形状输出 | 部分实现 | services/api/src/admin/ops/jobs-pg.ts:17-22 | `target_ref.revision` **自 #608 起已取记录行真实 revision**（`services/api/src/admin/ops/jobs-pg.ts:413` 的 `targetRevision ?? UNCREATED_RECORD_REVISION`，SQL 投影 `r.revision`；记录尚未创建时才退回 1，见同文件 :23-28）；`result` 恒 `null` 是契约形状、作业结果在后台读面仍读不到——形状对、语义只真实化一半。原写「`target_ref.revision` 恒取 1」为误，见 `docs/verification/gy-r67-docs-truth-20261027.md` |
| P12 | 登记核对 `verifyRegistration` 判定内核 | 部分实现 | docs/architecture/contract-implementation-status.md:82 | real 无真实登记库 ⇒ 恒 `unavailable`；无已审用量来源 ⇒ `dose_cards` 恒空 |

## 4 未实现（11 条，含一条 P0；原 N01 已撤条并入 E40）

| 编号 | 判定项 | 判定 | 依据（文件:行号） | 缺口说明 |
| --- | --- | --- | --- | --- |
| N02 | 审计写面的台账未跟上 0041／0043／0046 的四条写路径 | 未实现（P1） | docs/architecture/contract-implementation-status.md:166 | `catalog.ts` 的**八行**写点表已由 #609 补到七行、本版（GY-R64 读面闭集片）再补第八行（E31），该台账行却仍写「库内写入点只有 suspend_account / restore_account / set_feature_flag 三处」「审计写面仍未落库」——台账记三处、实际七条（第四行之后再加 0047 的下架一条为第八条，台账同样未登记）、未登记四条（`0041` grant／revoke、`0043` job.cancel、`0046` deny），与 `0041`／`0043`／`0046` 及其用例冲突；无功能影响，属文档与代码对不上 |
| N03 | `model_version`／`prompt_version`／`rule_version` 的真实值 | 未实现（P0） | docs/architecture/contract-implementation-status.md:97 | 一律 `unimplemented:no-real-` 前缀；审核侧明示不产出这两字段且有源码扫描测试禁占位（docs/moderation/README.md:45-46），见 §7.3 |
| N04 | 统一作业台账 `public.jobs` 的真实写入 | 未实现（P1） | services/api/src/admin/ops/jobs-pg.ts:4-9 | 表由 0001 建好（services/api/db/migrations/0001_initial_schema.sql:203-231），但全仓**零 INSERT**；真实作业行只落 `ocr_jobs`／`recognition_jobs`／`speech_jobs` 三张域内表 |
| N05 | 调用记录表 `provider_invocations` | 未实现（P1） | docs/architecture/data-dictionary.md:48 | 全仓只出现在四份文档，**无迁移、无代码** ⇒ 无 attempt／版本串／成本的可审计记录 |
| N06 | 识别真实供应商适配器 | 未实现（P1） | services/api/src/recognitions/provider.ts:151 | 缺凭据即 503；**即使凭据齐备也没有已审适配器**，`recognize` 仍返回 `PROVIDER_UNAVAILABLE`（同文件 :165） |
| N07 | 审核模型层（LLM 图文／文本模型判定） | 未实现（P1） | services/api/src/moderation/service.ts:366 | 规则层可用、模型层不存在；带媒体投稿因模型层缺失而无法 approved，只能停在待审或隔离 |
| N08 | Q29 独立样本、真实语音与模型评估（原 Z02） | 未实现（P1） | docs/requirements.md:58 | 原文「尚未执行」；独立样本须在调参前冻结，属**未做**，无暂缓记录 |
| N09 | 固定 120 题资料问答评估（原 Z07） | 未实现（P1） | docs/implementation-requirements.md:467 | 60 可答／20 不足／20 危险／20 注入，题集与判分口径已存在但未执行；台账「仍待后续片」不是暂缓 |
| N10 | 注销全量擦除并入既有注销闭集（原 Z11） | 未实现（P1） | docs/architecture/contract-implementation-status.md:100 | 台账写「尚未并入」——既有闭集有用例逐字锁住，缺口是新增范围尚未落码 |
| N11 | 审核载荷的 mime 传递与 `MODEL_PAYLOAD_INVALID`（原 Z12） | 未实现（P1） | services/api/src/media/service.ts:613 | 社区侧只传 `media_id`，ims 端口收不到 mime；所引 fail-closed 句只说明整域不可用，不构成暂缓 |
| N12 | 媒体**读**句柄与访问网关的端到端链路（原 Z09 残余） | 未实现（P1） | docs/verification/gy-i11-real-media-wiring-20261025.md:115-117 | 写链路已验收（E24）；读链路只消费写句柄，`MEDIA_ACCESS_GRANT_ORIGIN` 仍是部署面占位，端到端读数未取得（同文件 :126） |

**编号变更注意**：上一版把原 N03（「作业台端口装配」）撤条并入 E38，N 档因此整体前移一位——旧 N04→新 N03、旧 N05→N04、旧 N06→N05、旧 N07→N06、旧 N08→N07；旧 Z02／Z07／Z11／Z12 依次成为 N08／N09／N10／N11，旧 Z09 的残余是 N12。本版撤条的是**排在最前的 N01**（并入 E40）：照同一规则本该全体前移，但 N02–N12 在正文、门槛表与对照表里有二十余处交叉引用，改号只会让本 PR 每一行都无法逐条对账；故 N02–N12 **保持原号**，N 档留一个空位 N01，其去向写在上面的对账表与 §2 的 E40 里。

### 4.1 十一条未实现的解封前置

| 编号 | 解封需要什么 | 卡在哪一类决定 |
| --- | --- | --- |
| N02 | 改台账 `docs/architecture/contract-implementation-status.md:166` 那一句（写入点三处 → 七处，删掉「审计写面仍未落库」）；库内与闭集侧已由 #609 补齐，无需再动代码 | 文档同步（零代码） |
| N03 | 真实模型／提示词上线并产出可核对的版本串；`provider_invocations` 提供落点 | 付费授权（模型）+ 工程（N05） |
| N04 | 各域作业受理时写 `public.jobs`（现只写三张域内表） | 工程（需先定「域内表与统一表哪张是权威」；后台读面**不**依赖它，见 §7.2） |
| N05 | 迁移新建 `provider_invocations` + 调用点写入 attempt／版本串／耗时 | 工程（表结构在数据字典已定） |
| N06 | 一个已审供应商适配器 + 凭据 + 真实样本评估 | 付费授权（供应商）+ 外部样本 |
| N07 | tms／ims 授权与 BizType 核验，或更换供应商 | 商务授权（当前明确未授权，Z06） |
| N08 | 独立样本集冻结 + 真实语音与模型评估执行 | 外部样本 + 排期 |
| N09 | 跑完 120 题固定题集并出分 | 排期（口径已定，无外部依赖） |
| N10 | 让注销全量擦除并入既有注销闭集并补用例 | 工程 |
| N11 | 社区侧把 `mime` 带进审核载荷，ims 端口校验后返回 `MODEL_PAYLOAD_INVALID` | 工程（与 N07 同一片最省） |
| N12 | 部署期接一个可解析的访问网关，取得读句柄端到端读数 | 部署（Z04／Z05 相邻） |

**共同点**：N04／N05／N10／N11 是纯工程活、且都不需要新授权，N02 只剩一句台账同步；N03／N06／N07 卡在授权或付费；N08／N09 卡在样本与排期；N12 卡在部署。把四类混在一起排期，是这类缺口最容易反复返工的地方。

## 5 已搁置（6 条，均有逐字「暂缓／不做／未授权」记录）

| 编号 | 判定项 | 判定 | 依据（文件:行号） | 缺口说明（为何记为搁置而非未实现） |
| --- | --- | --- | --- | --- |
| Z01 | 素材与语料的许可调查、再分发许可 | 已搁置 | docs/verification/gy-i03-evidence.md:84 | 原文「许可调查本轮暂缓，所有来源 `licensed=false`」；前置是用户决策，不是代码 |
| Z02 | iOS 端适配与真机验收（本阶段范围决策） | 已搁置 | docs/requirements.md:18 | 原文「iOS 暂缓，不作为本阶段 PR 合并阻塞」；相应读数缺口见 docs/verification/gy-i23-latency-capacity-local-20261020.md:216 |
| Z03 | 适老版（独立字号／触控／布局） | 已搁置 | docs/development-plan.md:5 | 原文「先开发 Demo 版本样式，适老版本后续开发，恢复时间待用户决定」；另见 docs/ui-state-inventory.md:108 |
| Z04 | 服务器部署与真实外呼上线 | 已搁置 | docs/verification/gy-i26-pr69-integration-20261011.md:71 | 原文「服务器部署继续暂缓」；命令不取生产凭据、不调真实识别／语音／问答 |
| Z05 | 测试版上线前置三项 | 已搁置 | docs/verification/platform-checklist.md:64 | 原文「属上线前置，当前搁置，不作为阻塞项」；用户 2026-10-25 明确测试版暂不上线 |
| Z06 | 真实 tms／ims 内容安全供应商授权 | 已搁置 | services/api/src/moderation/service.ts:366 | 原文「tms/ims 未授权、BizType 未核验」⇒ 前置是商务授权与核验，不是代码 |

**这一档只剩 6 条的原因**：上一版另有 6 条（原 Z02／Z07／Z08／Z09／Z11／Z12）引的是「尚未执行」「仍待后续片」「尚未并入」「需授权才能接线」这类**排期或能力自述**，被独立审查判为口径越权——文件内文字不能扩大授权。逐条去向见 §0 的对账表：四条改判未实现（N08／N09／N10／N11），一条并入 E24（写链路已验收）+ 残余 N12，一条并入 E39（真库臂已覆盖原生 PG17 迁移）。

## 6 未验证（1 条，不计入四档）

| 编号 | 判定项 | 判定 | 依据（文件:行号） | 说明 |
| --- | --- | --- | --- | --- |
| V01 | 真库臂在本机的复跑读数，以及 CI 上的一次运行结论 | 未验证 | .github/workflows/real-pg-integration.yml:222 | 功能条款已由 E39 覆盖（脚本 `[ALL PASS]` 末行见 tests/integration/admin-jobs-pg.mjs:1073）；本机无 PostgreSQL，未复跑；CI 运行结论不在仓内，本页不据 workflow 注释推定通过 |

### 6.1 补验 V01 的最小步骤（不改代码即可判）

1. 在任一可用 PG 17 实例上跑 `node tests/integration/admin-jobs-pg.mjs <owner-url>`（脚本自建角色与空库，见同文件 :276 起的 `provisionRoles`），要看到末行 `[ALL PASS]`。
2. 若末行不是 `[ALL PASS]`，按失败段定位：`[J]` 段 = 列表投影，`[C]`／`[C2]` 段 = 取消与审计事务，`[E]` 段 = 开关闸门。
3. 无本机 PG 时，只能读 CI run 结论；**不得**把 workflow 里的「本地取证」注释当作运行结论，也不得据此把 V01 升为已实现。
4. 本页不因 V01 调整四档计数：它是「读数未取得」，不是「条款未落地」。

## 7 最硬缺口详述（7.1 已关闭，留档防复发）

### 7.1 取消动作的审计：三步断链已全部接通（原 P0，本版关闭）

上一版的三步断链：#589 修掉前两步，#609 修掉第三步。

1. 写：`jobPort.cancel(...)` 带上 `{ actorId, reasonCode: 'job_cancelled', requestId }`（`services/api/src/admin/ops/service.ts:977-981`）；持久端口不再由服务层写内存审计，而是 `if (!jobPort.persistent) { appendAudit(...) }`（同文件 :853-854）。
2. 落：真库端口在同一事务里调库函数（`services/api/src/admin/ops/jobs-pg.ts:497`、`:518-519`），失败整体 `ROLLBACK`；真库臂钉住「恰 1 行」（`tests/integration/admin-jobs-pg.mjs:730`），并验证审计表被拒时作业保持原状态（同文件 :845）。
3. 读：库函数本身支持按 action 过滤（`services/api/db/migrations/0033_admin_audit_log_read.sql:50`、`:98`），但 `GET /admin/audit-logs` 的 `action` 参数走闭集判定，`AUDIT_ACTIONS` 当时只有三个动作 ⇒ **`?action=job.cancel` 得 400 `INVALID_REQUEST` + `details[].code='enum'`**（闭集判定本身今天没变，见 `services/api/src/admin/audit/service.ts:121-131`；变的是它读的那张表）。#609 把 `job.cancel` 登记为第四项（`services/api/src/admin/audit/catalog.ts:41-46`），`entity=job` 映射到审计行实际写的 `jobs:cancel`（同文件 :57-68），契约两个枚举随之扩到四项与三项（`packages/contracts/openapi.json:11008-11013`、`:10733-10738`）；用例钉住「200 且只回该动作」「恰四项」「闭集外仍 400 且零端口调用」（`tests/unit/admin-audit-action-jobs-cancel.test.mjs:159`、`:150`、`:213`），顺序另由 `tests/unit/ai-ops-ledger-pins.test.mjs:169` 钉住。

**仍没做到的两处**（已从 P0 降级，本页不再按 P0 计）：

- 三读面读数不合并：审计总台账页已消费全表读面（`apps/admin/src/views/AuditLogsView.vue:72` 调 `listAuditLogs`），另两个审计页仍分别只接内存读面（`apps/admin/src/lib/audit-events.mjs:33`）与只认 `set_flag` 的开关审计面（`apps/admin/src/lib/flag-audit.mjs:54`），三面读数无法合并、页面读数也无端到端验收（P10）。原写「后台仍无入口…全仓没有页面消费 `GET /admin/audit-logs`」为误，见 `docs/verification/gy-r67-docs-truth-20261027.md`。
- 台账那句仍与代码冲突：`docs/architecture/contract-implementation-status.md:166` 还写着「审计写面仍未落库」「写入点只有三处」，与 0043 及其用例冲突（N02）。

**留档的理由**：这条曾经是「写进去了，但没人读得到，且文档说它没写」。现在库里有行、接口能筛、用例锁住，只剩「三读面读数不合并」与「台账说没写」——同一类漂移换了个面，别当它消失了。

### 7.2 后台作业台：端口已接线，剩余是语义与入口（P1）

上一版判「默认未接线、一律 503」，那是把**缺省分支**当成了生产路径。按 #589 后的代码更正：

- 判定变量名骗人但不骗逻辑：`const adminRealUnwired = config.executionMode === 'real'`（`services/api/src/app.ts:1353`），值只取决于是否 real。
- 装配：`adminJobPort = adminInjection?.jobPort ?? (adminRealUnwired && pool !== null ? createPostgresAdminJobPort({ pool }) : undefined)`（同文件 :1363-1365），显式注入优先；随后注入服务层（同文件 :1549）。
- 生产端口本体：`services/api/src/admin/ops/jobs-pg.ts:374-380` 的构造器，`persistent: true` 在 `:450-451`；读三张域内作业表（`ocr_jobs`／`recognition_jobs`／`speech_jobs`，同文件 :4-9），**不读** `public.jobs`。
- 503 只剩缺省：未注入（stub／无池）时 `services/api/src/admin/ops/jobs.ts:77-84` 的 `createUnwiredAdminJobPort()` 返回 `PORT_UNAVAILABLE`。`tests/failmatrix/cases.mjs:159` 锁的是这条分支——它证明「没池时不许假绿」，不证明生产也 503。
- 真库臂已覆盖生产路径：`wired===true`（`tests/integration/admin-jobs-pg.mjs:661`）、`GET /admin/jobs` 200 且字段面恰契约 9 项（同文件 :681）、401／403 与 `jobs:read` 专权（:699）、取消让 revision 1→2（:711）、终态拒绝、过滤下推与闭集 400、游标两页不重不漏（:1157-1252）。

**真正没做到的**（仍是缺口，但级别是 P1）：

- 投影语义只真实化一半：`target_ref.revision` 自 #608 起取记录行真实 revision（`services/api/src/admin/ops/jobs-pg.ts:413`），只有记录尚未创建时才退回 1；`result` 恒 `null`（同文件 :419）是契约形状，即前端看到的「结果」仍不是真值（P11）。
- 能力无入口：后台 UI 的列表 URL 只 set `limit` 与 `cursor`（`apps/admin/src/lib/jobs-api.mjs:136-146`），`state`／`error_code` 过滤虽然已下推 SQL（`services/api/src/admin/ops/jobs-pg.ts:23-28`），后台用户却点不到（P08）。

### 7.3 模型／提示词版本零真实值（P0）

- 问答侧：`createConversation`／`createTurn` 行明写「三个版本串一律带 `unimplemented:no-real-` 前缀」（`docs/architecture/contract-implementation-status.md:97`），正文是确定性检索条目摘录，不是模型结果。该前缀同时是**机器判据**（`services/api/src/conversations/types.ts:52`）——好处是谎报会被测试抓到，代价是零真实值。
- 审核侧：`docs/moderation/README.md:45-46` 明示不产 `model_version`／`prompt_version`，且有一条用例**扫描源码**禁止占位赋值（`本片不产出 model_version / prompt_version：源码里没有占位赋值`）。
- 记录侧：`provider_invocations` 只有一行数据字典（`docs/architecture/data-dictionary.md:48`），无迁移、无代码 ⇒ 即便将来接上模型，也没有承载版本串与 attempt 的表（N05）。

结论：**当前任何「模型版本／提示词版本」的对外读数都不可信**——真实值不存在，承载真实值的表也不存在。#589 的 0043 只解决审计落库，与本条无关。

### 7.4 三条缺口的共同根因（7.1 已关闭，其余仍按此链查）

上一版把作业台读面也算进「只能进程内兜底」，那是错的：`ocr_jobs`／`recognition_jobs`／`speech_jobs` 三张域内表一直有真库实现，端口也早就存在，缺的是**装配与用例的默认口径**。更正后的根因链是两截：

1. **承载表缺位**：`public.jobs` 零 INSERT（N04）、`provider_invocations` 无迁移（N05）。于是「统一作业台账」与「调用记录」这两类查询只能落域内表或内存，跨 kind 的运维视图做不出来。
2. **闭集比写点慢一拍**：#589 让 0043 能写 `job.cancel`（真库臂钉住恰 1 行），#609 才把 `AUDIT_ACTIONS` 补成四项（E40）——中间那段时间是「能看见、不能筛」。这是「写面先行、读面与文档滞后」的典型：代码绿、用例绿，运维只能手动查库。本版仍慢半拍的是台账那句「审计写面仍未落库」（N02）。

另有一条**已被证伪**的旧判断，留在这里防止再犯：上一版说「接线必须同时改用例，否则 CI 会拦」。实测 `tests/failmatrix/cases.mjs:159` 锁的是 stub 世界的缺口分支，真库臂走的是另一条路（`tests/integration/admin-jobs-pg.mjs` 全链），因此接线**不需要**动 failmatrix 用例。

## 8 真实缺口（需真实模型／样本／付费授权）

这一组**不属于**上面 69 条判定项：它们不是「代码没写」，而是需要真实外呼、独立样本或付费授权。门槛数值直接取自需求原文。

| 缺口项 | 门槛／原文 | 依据（文件:行号） | 现状 |
| --- | --- | --- | --- |
| 识别（拍草）真实外呼 | 覆盖内 300 张，Top1 ≥ 85%、Top3 ≥ 95% | docs/implementation-requirements.md:460 | 未执行；供应商适配器缺失（N06） |
| 识别泛化与低质量 | 覆盖外误判 ≤ 5%，低质量图可用 ≥ 95% | docs/implementation-requirements.md:461 | 未执行 |
| 标签 OCR | ≥ 200 张，字段准确率 ≥ 95% | docs/implementation-requirements.md:462 | 未执行；真实提供者未接（P03） |
| 登记匹配 | ≥ 100 组 | docs/implementation-requirements.md:463 | 未执行；real 无登记库（P12） |
| AI 社区筛查 | 200 恶意 + 200 正常，召回 ≥ 95%，误隔离 ≤ 10% | docs/implementation-requirements.md:464 | 未执行；模型层缺失（N07） |
| 普通话播报 | ≥ 30 段 | docs/implementation-requirements.md:465 | 未执行；真实 TTS 提供者未接（P05） |
| 普通话 ASR | ≥ 50 段，字符错误率 ≤ 15% | docs/implementation-requirements.md:466 | 未执行（仅 1 次真实 ASR 连通性调用，非准确率证据：docs/verification/gy-i11-real-media-wiring-20261025.md:75） |
| 大模型资料问答 | 固定 120 题（60 可答／20 不足／20 危险／20 注入） | docs/implementation-requirements.md:467 | 未执行（N09） |
| 两类识别耗时 | 各 ≥ 30 次真实调用，提交至展示 p95 ≤ 10s，失败率 ≤ 5%，最长 30s 转明确超时 | docs/implementation-requirements.md:480 | 未取得读数 |
| 语音问答耗时 | p95 ≤ 5s／≤ 10s，单阶段最长 30s 明确超时 | docs/implementation-requirements.md:481 | 未取得读数 |
| 页面性能 | 首屏 p95 ≤ 2s，查询 p95 ≤ 3s | docs/implementation-requirements.md:479 | 未取得读数 |
| Q29 独立样本与真实语音／模型评估 | 「尚未执行」 | docs/requirements.md:58 | 未执行（N08） |
| 评估脚本口径 | `npm run test:evaluation` 只验评估程序，不等于真实模型指标 | docs/development-guide.md:119 | 口径已固定，勿把程序绿读成指标绿 |
| 版本串真实值 | `model_version`／`prompt_version`／`rule_version` 非占位 | docs/moderation/README.md:45-46 | 零真实值（N03） |

**一句话**：这一节的每一项都以「真实调用／真实样本／付费授权」为前置，代码侧再绿也不能抵。三条复算纪律：样本必须在调参前冻结（Q29 口径，docs/requirements.md:58）；「≥ 30 次真实调用」「≥ 200 张」数的是**外呼次数**而不是用例迭代；每次读数必须带环境标注（原生 PG17／隔离夹具／本机回环），否则不可与本页其他读数比较。

## 9 复核方式（本页读数的反证路径）

```powershell
node tools/verify-doc-anchors.mjs --strict   # 本页所有「路径:行号」必须指向真实存在的行
npm run test:docs                            # 文档链接、表格列数、F／AC／Q 映射
npm run verify:anchors                       # 契约台账锚点 + 文档手写行号
```

读数会因下列改动失效，改一处就要改本页对应行：开关受控面清单扩容（E27）、`AUDIT_ACTIONS` 闭集扩容（E40）、`public.jobs` 出现首个 INSERT（N04）、`provider_invocations` 落迁移（N05）、任一版本串去掉 `unimplemented:no-real-` 前缀（N03）、媒体读句柄网关接线（N12）、真库端口投影改成真值（P11）。

**不夸大的三条**：本页的「已实现」只证机制在代码里成立且被锁，不证该域可上线；「已实现」不把 operation 从 `partial` 升级；本页不复制真实能力验收，也不替代 §8 的任何门槛读数。

### 9.1 判定升降的条件（改判定时照着走）

| 档位迁移 | 触发条件 | 必须同步改的东西 |
| --- | --- | --- |
| 未实现 → 部分实现 | 端口／表／分支已存在，但出口仍被未接线的一支接管 | 补「缺口说明」写清是哪种降级；台账（若属 operation）同步 |
| 部分实现 → 已实现 | 强制点唯一、且有用例或迁移约束锁住；替身路径被删除或明确仅测试用 | 补用例锚点；本页依据列加锁它的用例行号（E38／E39 即此路径） |
| 已实现 → 部分实现 | 强制点被绕过（新入口未过守卫）或锁它的用例被弱化 | 说明绕过路径；这属回退，须在 PR 里单列 |
| 已搁置 → 未实现 | 只找到排期自述（「仍待后续片」「尚未执行」「尚未并入」）而找不到逐字暂缓／授权记录 | 撤掉搁置依据，改判「该做而未做」（本版 Z02／Z07／Z11／Z12 走的就是这一格） |
| 已搁置 → 已实现 | 授权到位且代码落地 | 同时补 §8 对应门槛的真实读数，二者缺一不算（本版原 Z08／Z09 走这一格，且 §8 仍写未执行） |
| 未实现 → 已实现 | 出现强制点 + 锁它的用例 | 本版 N01 → E40 走的就是这一格：0043（#589）只给了写面，写面单有不够——闭集没扩时 N01 一直保持未实现；#609 补齐闭集、留下锁它的用例（`tests/unit/admin-audit-action-jobs-cancel.test.mjs:159`）才改判 |
| 未验证 → 已实现 | 在 real + 有池环境取到真库读数，或读到 CI 该 job 的成功结论 | 记下读数的环境与日期；本机无 PG 时不得改判 |

## 10 附录：契约 operation 与本页判定项的对照

本页判定项不是 operation，但每个 operation 都能追到支撑它的条款编号。契约共 118 个 operation，其中 AI／作业域 30 个（下表按组列出，组内 operation 共用同一批判定项）。

| operation（组） | 域 | 支撑它的判定项 |
| --- | --- | --- |
| `getJob` | 作业面公共 | E01、E04、E05、E06、E07 |
| `cancelJob` | 作业面公共 | E09、P01 |
| `createRecognition`／`getRecognition`／`deleteRecognition`／`selectSpecies` | 识别 | E10、P02、N06 |
| `createOCR`／`getOCR`／`deleteOCR`／`correctOCR`／`verifyOCR` | OCR | E11、E12、P03 |
| `createTranscription`／`getTranscription`／`deleteTranscription`／`confirmTranscription` | 语音与转写 | E13、E20、P04、N12 |
| `createSynthesis` | 合成 | E14、P05 |
| `createConversation`／`listConversations`／`getConversation`／`deleteConversation` | 问答 | E15、E16、E19、P06 |
| `createTurn`／`listTurns`／`deleteTurn` | 问答 | E15、E17、E19、E20、P06、N03 |
| `listAdminJobs` | 后台作业台 | E33、E34、E38、E39、P08、P11 |
| `cancelAdminJob` | 后台作业台 | E35、E36、E38、E39、E40 |
| `listFlags` | 开关 | E25、E26、E27 |
| `setFlag` | 开关 | E28、E31、E32 |
| `listFlagAuditEvents` | 审计 | E31、P10 |
| `listAuditLogs` | 审计 | E31、E40、P10、N02 |
| `listAuditEvents` | 审计 | P09、P10、N02 |

读法：一个 operation 在[契约实现状态](contract-implementation-status.md)里是 `partial`，本页对应条款却可能多数是「已实现」——那说明该 operation 差的不是机制，而是**接线**或**真实值**。反之，若某 operation 的支撑条款里出现 N 编号，它就是被那条未实现项按住的。

## 11 相关页与维护

- [契约实现状态](contract-implementation-status.md)：operation 级状态与逐行证据（本页与之互补，不覆盖；其审计行 :164 尚待按 0043 同步）
- [数据字典](data-dictionary.md)：`jobs`、`provider_invocations` 等表的字段口径
- [审核设计](../moderation/README.md)：规则层与模型层的边界、版本串不产出的原因
- [代码实现需求](../implementation-requirements.md)：§8 全部门槛数值的原文
- [开发指南](../development-guide.md)：`test:docs`、`verify:anchors`、`test:evaluation` 三脚本各自证明什么
- [真实媒体端口接线验收](../verification/gy-i11-real-media-wiring-20261025.md)：写链路读数与读链路残余（E24／N12）
- [真库臂 workflow](../../.github/workflows/real-pg-integration.yml)：`postgres:17.11` 与各集成脚本的执行位（E39）
- [开发进度](../development-progress.md)：本页的入口行

维护规则：只按「代码／迁移／用例」的现状改判定；某条从「未实现」转「已实现」必须同时给出强制点与锁它的用例；「已搁置」的进出都必须附**逐字**的用户决策或授权记录，排期自述不算。
