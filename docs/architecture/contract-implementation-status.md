# GY-I01 契约实现状态对照

更新：2026-10-13。正式 main 基线 `3e8f89bb7dcd79d4ffe509ec79260acd71b26ded`。Refs [#1](https://github.com/GengYunChuChao/GengYun/issues/1)，只刷新已合并代码的对照，不关闭整项。已同步 #108／#109／#113／#115 的等待头、授权／科普分页和普通回执保留期修订，待合成果不计入本基线；历史实测仍见原验证记录。

## 1 判据与事实源

| 状态 | 含义 |
| --- | --- |
| implemented | main 上已有产品 HTTP 路由和可复核行为证据；仍须满足注明的运行条件 |
| partial | 有对应操作代码，但 HTTP 未装配、缺条件/分支，或存在明确契约偏差 |
| planned | 尚无此操作的产品实现证据；相关领域库不自动等于 HTTP 实现 |

`route_mounted` 独立记录能否进入产品路由。已注册接口也可能因鉴权、配置或未接线端口明确拒绝；无 HTTP 的服务代码不能直接调用。

事实源为 `packages/contracts/openapi.json`、`operations.json` 与 `states.json`；语义约定见[状态协议](state-contract.md)。[JSON 副本](contract-status.json)人工维护状态、证据和缺口，以下表格从该副本同步，脚本不会自动判定 implemented。

当前 `services/api/src/app.ts:197-207` 注册健康、公共主页、用户/后台身份、授权、档案、资料、识别、转写、合成和 OCR。健康端点不计入 112 条业务契约。GET /jobs/{id} 与 POST /jobs/{id}/cancel 当前只读取 recognition store；[PR #106](https://github.com/GengYunChuChao/GengYun/pull/106) 的跨域注册未计入本基线，本次不改其代码或接管其任务。

社区 16 项、消息 3 项和后台业务 34 项已有独立服务证据，状态记 partial、route_mounted=false。媒体/参考/隐私相关库存在，保留 planned 的条目表示本轮未取得对应产品服务证据，不否认这些库的成果。识别、OCR、ASR、TTS 新注册操作均记 partial，不以替身或回环测试宣称真实能力达标。

知识列表的 `id_asc` 排序偏差仍在，按上面的状态定义将 listKnowledge 从 implemented 修正为 partial；没有删除接口或改变实际功能。已装配仍为 32 条，状态计数是 11 implemented／74 partial／27 planned，不等于整项完成率。#116 后台到期修复的 CI 尚未获批、未合，后台独立默认及到期处理缺口仍保留。

<!-- contract-status-tables:start -->
## 2 横切约定

| 维度 | 来源锚点 | 状态 | 证据 | 缺口 / 条件 |
| --- | --- | --- | --- | --- |
| 错误码与 HTTP 状态映射 | packages/contracts/states.json#/error_status_map；docs/architecture/state-contract.md:17-30 | `partial` | services/api/src/contract.ts:14-58；services/api/src/errors.ts:29-63；tests/contract/contract-codes.test.mjs::API 错误码与 HTTP 状态映射与契约 states.json 完全一致 | 缺：契约 error_status_map 未定义 500/INTERNAL_ERROR，未预期异常以 500 + contract_gap=NO_CONTRACT_CODE_FOR_500 如实返回（app.ts:260-276）；后台凭据错误无专用码，复用 401 SESSION_REQUIRED（admin-auth.ts:12-13） |
| 分页（items + next_cursor、limit 默认 20 上限 50、服务端签名游标） | docs/architecture/state-contract.md:32；packages/contracts/openapi.json#/components/parameters/Cursor\|Limit | `partial` | services/api/src/knowledge/pagination.ts:24-65；services/api/src/profile/service.ts:105-131；services/api/src/privacy/consent-pagination.ts:24-65；tests/unit/knowledge-pagination.test.mjs::knowledge chain keeps first 15min deadline；tests/unit/consent-pagination.test.mjs::15分钟截止严格生效 | 授权列表HMAC/主体epoch/水位/15分钟固定期限已合（#109），科普固定期限与过期恢复已合（#115）；知识id_asc排序仍偏差，缺历史创建时点字段；目录按稳定目录键排序，其他后台/社区/消息分页仍需按各模块核对，不能记整维度完成 |
| 版本（强 ETag、If-Match 428/409、revision 自增） | docs/architecture/state-contract.md:15 | `implemented` | services/api/src/routes/profile.ts:37-41；services/api/src/routes/consents.ts:59-63；services/api/src/routes/knowledge.ts:30-34；services/api/src/profile/service.ts:86-87；tests/unit/profile-api.test.mjs::GY-I05 persistent profile/catalog HTTP and SQL regression | 无（需 DATABASE_URL；撤回/编辑路径的 If-Match 缺 428、不匹配 409 已实现） |
| 幂等（Idempotency-Key 8..128、同键同体重放、同键异体 409、进行中 409） | docs/architecture/state-contract.md:34 | `partial` | services/api/src/routes/support.ts:80-148；services/api/src/app.ts:219-224；services/api/src/auth/idempotency.ts:31-33；services/api/src/auth/service.ts:104-107；services/api/src/admin/identity.ts:23-25；services/api/src/admin/idempotent-write.ts:55-72；tests/unit/idempotency-retry-after-http.test.mjs::真实产品登录 HTTP：同键请求仍在处理；tests/unit/idempotency-job-ttl.test.mjs | REQUEST_IN_PROGRESS的Retry-After: 1已合（#108）；认证/识别OCRASRTTS普通回执24小时及非滑动时效已合（#113）。后台独立默认仍5分钟且完成回执未自动清理；#116修复待CI批准/未合，不计入main。内存域重启不持久，其他键域/当前可见性及持久业务唯一键仍须按模块验收 |
| source_kind / evidence_kind（来源取得方式与证据性质） | packages/contracts/states.json#/states/SourceKind\|EvidenceKind；docs/architecture/state-contract.md:60 | `partial` | services/api/src/db/catalog.ts:5-22；services/api/src/knowledge/service.ts:43-47；packages/reference/constants.mjs:1-60；tests/reference/contract.test.mjs::H2；services/api/src/ocr/reference.ts:35-49；services/api/src/ocr/reference.ts:223-245；tests/integration/ocr-http.mjs | 公共科普/资料已有来源字段投影，已装配 OCR 登记核对也使用来源投影；替身标记且 review_status=unverified，两种模式用量候选恒空；/herbicides 仍未装配，真实已审来源与制剂/条件完整的用量 HTTP 消费尚缺，不以库层或替身断言冒称真实用药验收 |
| 真实 / 替身 / 演示环境（execution_mode） | packages/contracts/states.json#/states/ExecutionMode；docs/architecture/state-contract.md:3 | `implemented` | services/api/src/contract.ts:9-11；services/api/src/config.ts:126-238；services/api/src/auth/wechat.ts:66-76；tests/unit/api-config.test.mjs::real 模式缺配置时一次性列出全部字段 | 无（本机实测：stub 启动并返回 meta.execution_mode=stub；APP_EXECUTION_MODE=real 且无凭据时 exit 1 并列出 9 个缺失字段，不半配置启动） |
| 取消（Job 取消、原子递增 revision、撤租约与外发） | docs/architecture/state-contract.md:48；packages/contracts/states.json#/job_transitions | `partial` | services/api/src/recognitions/service.ts:529-573；tests/unit/recognitions-api.test.mjs::状态 7 cancelled | 识别域 cancelJob 已装配，CAS 增 revision、幂等重放、终态守卫与迟到结果不复活已有证据；公共 Job 未消费转写/OCR/合成，cancelAdminJob 只有独立后台服务且无 HTTP；持久租约、外发撤销与跨域生命周期仍待完成 |
| 超时（数据库/健康检查/供应商调用截止） | docs/architecture/state-contract.md:50 | `partial` | services/api/src/db/pool.ts:27-53；services/api/src/auth/wechat.ts:32-33；services/api/src/knowledge/service.ts:57-60；tests/unit/api-health.test.mjs::/health 在 real 模式数据库不可达时返回 503 degraded；services/api/src/recognitions/service.ts:410-427；services/api/src/ocr/service.ts:52-58；services/api/src/speech/service.ts:590-608；services/api/src/tts/service.ts:549-565；tests/unit/recognitions-api.test.mjs::GY-I09 识别任务闭环 | 数据库/微信调用有截止；识别/OCR/ASR/TTS 默认阶段截止 30 秒并投影 deadline_at，超时进入 timed_out，非成功终态不产结果；问答 HTTP 阶段仍缺，持久任务的 15 秒租约/5 秒心跳与重启恢复尚未实现；录音 60 秒限制属于媒体/页面链，不能由此服务层证据推定真机通过 |

## 3 已装配操作（32 条）

装配只表示存在产品路由；请同时读状态和限制。

| 操作 id | 方法与路径 | 状态 | 证据 | 缺口 / 条件 |
| --- | --- | --- | --- | --- |
| `getPublicHome` | GET /public/home | `partial` | services/api/src/routes/public-home.ts:9-16；services/api/src/db/catalog.ts:14-27；tests/unit/public-home.test.mjs::public home refuses missing DB and non-real modes | 仅 execution_mode=real 且 DATABASE_URL 非空时读库；stub/preset_demo 明确返回 503 PROVIDER_UNAVAILABLE；响应仍固定 human_review_state=under_construction，真实内容审核/消费待完成；旧记录的“本机无 PG”只是当时环境限制 |
| `loginWechat` | POST /auth/wechat | `implemented` | services/api/src/routes/auth.ts:42-83；services/api/src/auth/wechat.ts:66-131；tests/unit/auth-routes.test.mjs::微信登录：仅凭 code 建立会话 | 无（需 Idempotency-Key；stub/preset_demo 用合成身份，不代表真实微信身份） |
| `loginAdmin` | POST /admin/auth/session | `implemented` | services/api/src/routes/admin-auth.ts:46-86；services/api/src/auth/password.ts:1-40；tests/unit/auth-routes.test.mjs::后台登录/会话/退出全流程 | 首次管理员需 ADMIN_BOOTSTRAP_LOGIN_NAME/PASSWORD；凭据错误沿用 401 SESSION_REQUIRED（契约无专用码） |
| `getAdminSession` | GET /admin/auth/session | `implemented` | services/api/src/routes/admin-auth.ts:88-101；tests/unit/auth-routes.test.mjs::后台高权限拒绝：scope 不足的管理员被 403 SCOPE_DENIED 拦下 | 无 |
| `getUserSession` | GET /auth/session | `implemented` | services/api/src/routes/auth.ts:85-99；tests/unit/auth-routes.test.mjs::GET /auth/session：返回本人 SessionInfo | 无 |
| `logoutUser` | POST /auth/logout | `implemented` | services/api/src/routes/auth.ts:101-122；tests/unit/auth-routes.test.mjs::退出登录：撤销当前会话后同一令牌立即失效 | 无 |
| `logoutAdmin` | POST /admin/auth/logout | `implemented` | services/api/src/routes/admin-auth.ts:103-127；tests/unit/auth-routes.test.mjs::后台登录/会话/退出全流程 | 无 |
| `getProfile` | GET /me/profile | `implemented` | services/api/src/routes/profile.ts:25-28；services/api/src/profile/service.ts:66-71；tests/unit/profile-api.test.mjs::GY-I05 persistent profile/catalog HTTP and SQL regression | 需 DATABASE_URL 与 0001..0010 迁移；无库时如实 503 PROVIDER_UNAVAILABLE |
| `putProfile` | PUT /me/profile | `implemented` | services/api/src/routes/profile.ts:29-42；services/api/src/profile/service.ts:72-104；tests/unit/profile-api.test.mjs::GY-I05 persistent profile/catalog HTTP and SQL regression | 无（需 If-Match 与 Idempotency-Key；空档案 revision=1，首次 PUT 写 revision=2） |
| `listCrops` | GET /catalog/crops | `implemented` | services/api/src/routes/profile.ts:43-53；services/api/src/profile/service.ts:57-64；tests/unit/profile-api.test.mjs::GY-I05 persistent profile/catalog HTTP and SQL regression | 需 DATABASE_URL；目录行须与 packages/knowledge/catalog/crops.json 逐字段一致 |
| `listRegions` | GET /catalog/regions | `implemented` | services/api/src/routes/profile.ts:43-53；services/api/src/profile/service.ts:57-64；tests/unit/profile-api.test.mjs::GY-I05 persistent profile/catalog HTTP and SQL regression | 需 DATABASE_URL；仅浙江（33 开头）行政区代码 |
| `listConsents` | GET /me/consents | `partial` | services/api/src/routes/consents.ts:40-49；services/api/src/privacy/consent-pg.ts:109-120；services/api/src/privacy/consent-pagination.ts:24-65；tests/unit/consent-pagination-http.test.mjs::授权分页走实际产品 HTTP 与受限 SQL | 授权列表签名、主体/auth_epoch/水位绑定、稳定排序和15分钟固定期限已合（#109）；真实授权政策/接收方配置与用途链路仍须验收，grant依赖运维导入consent_policies，不把列表合成记录证据当真实授权全链完成 |
| `grantConsent` | POST /me/consents | `partial` | services/api/src/routes/consents.ts:24-39；services/api/src/privacy/grant-pg.ts:26-97；tests/integration/consent-grant-pg.mjs::normal production app rejects synthetic registry | 该 purpose 的已核验可用政策行须先落入 consent_policies，否则 403 CONSENT_REQUIRED；合成政策注入/组件 PG 测试不等于真实授权来源和全消费者验收 |
| `withdrawConsent` | DELETE /me/consents/{purpose} | `partial` | services/api/src/routes/consents.ts:50-64；services/api/src/privacy/consent-pg.ts:135-179 | 撤回消费者（jobs/media/exports/author_links）未接入，存在任一条即409 OBJECT_UNAVAILABLE拒绝（consent-pg.ts:153-163）；真实授权政策/接收方和外发/注销全链未验，保留fail-closed边界 |
| `getJob` | GET /jobs/{id} | `partial` | services/api/src/routes/recognitions.ts:118-122；tests/unit/recognitions-api.test.mjs::GY-I09 识别任务闭环 | 识别域 Job 读取/取消已装配，含归属、If-Match、幂等与终态守卫；当前只消费 recognition store，转写/OCR/合成 Job 尚不能经此公共接口读取/取消；持久队列、租约及跨域注册待接线（#106 尚未合并，不计入本基线） |
| `cancelJob` | POST /jobs/{id}/cancel | `partial` | services/api/src/routes/recognitions.ts:130-134；tests/unit/recognitions-api.test.mjs::GY-I09 识别任务闭环 | 识别域 Job 读取/取消已装配，含归属、If-Match、幂等与终态守卫；当前只消费 recognition store，转写/OCR/合成 Job 尚不能经此公共接口读取/取消；持久队列、租约及跨域注册待接线（#106 尚未合并，不计入本基线） |
| `listKnowledge` | GET /knowledge | `partial` | services/api/src/routes/knowledge.ts:25-29；services/api/src/knowledge/service.ts:14-56；services/api/src/knowledge/pagination.ts:24-65；tests/unit/knowledge-api.test.mjs::knowledge real projection and limited runtime over loopback HTTP | 需DATABASE_URL与catalog_read.current_knowledge；签名/绑定/15分钟非滑动分页及失效后重新查询已合（#115）；当前id_asc排序仍不同于冻结(created_at DESC,id DESC)，实际表/投影无created_at，排序及历史数据方案未完成，按partial保留 |
| `getKnowledge` | GET /knowledge/{id} | `implemented` | services/api/src/routes/knowledge.ts:30-34；services/api/src/knowledge/service.ts:43-56；tests/unit/knowledge-api.test.mjs::knowledge real projection and limited runtime over loopback HTTP | 需 DATABASE_URL；不可见/不存在统一 404，ETag 为 revision |
| `createRecognition` | POST /recognitions | `partial` | services/api/src/routes/recognitions.ts:57-61；tests/unit/recognitions-api.test.mjs::GY-I09 识别任务闭环 | HTTP 与内存任务/结果/选种/删除闭环已装配；stub/preset_demo 为合成替身；real 媒体/提供者未接线时明确拒绝；真实供应商与独立样本评估（GY-I25/GY-I21）、持久任务与删除集成尚待验收 |
| `getRecognition` | GET /recognitions/{id} | `partial` | services/api/src/routes/recognitions.ts:74-78；tests/unit/recognitions-api.test.mjs::GY-I09 识别任务闭环 | HTTP 与内存任务/结果/选种/删除闭环已装配；stub/preset_demo 为合成替身；real 媒体/提供者未接线时明确拒绝；真实供应商与独立样本评估（GY-I25/GY-I21）、持久任务与删除集成尚待验收 |
| `deleteRecognition` | DELETE /recognitions/{id} | `partial` | services/api/src/routes/recognitions.ts:101-105；tests/unit/recognitions-api.test.mjs::GY-I09 识别任务闭环 | HTTP 与内存任务/结果/选种/删除闭环已装配；stub/preset_demo 为合成替身；real 媒体/提供者未接线时明确拒绝；真实供应商与独立样本评估（GY-I25/GY-I21）、持久任务与删除集成尚待验收 |
| `selectSpecies` | PATCH /recognitions/{id}/selection | `partial` | services/api/src/routes/recognitions.ts:86-90；tests/unit/recognitions-api.test.mjs::GY-I09 识别任务闭环 | HTTP 与内存任务/结果/选种/删除闭环已装配；stub/preset_demo 为合成替身；real 媒体/提供者未接线时明确拒绝；真实供应商与独立样本评估（GY-I25/GY-I21）、持久任务与删除集成尚待验收 |
| `createOCR` | POST /ocr | `partial` | services/api/src/routes/ocr.ts:192-196；tests/integration/ocr-http.mjs | OCR 五端点与原文/校正/登记核对分离已装配；real 提供者、媒体、登记源未接线时拒绝；两种模式用量端口恒空，不产出 dose_cards；当前内存任务不接公共 Job 读取/取消，真实标签评估与持久/删除链待验收 |
| `getOCR` | GET /ocr/{id} | `partial` | services/api/src/routes/ocr.ts:209-213；tests/integration/ocr-http.mjs | OCR 五端点与原文/校正/登记核对分离已装配；real 提供者、媒体、登记源未接线时拒绝；两种模式用量端口恒空，不产出 dose_cards；当前内存任务不接公共 Job 读取/取消，真实标签评估与持久/删除链待验收 |
| `deleteOCR` | DELETE /ocr/{id} | `partial` | services/api/src/routes/ocr.ts:260-264；tests/integration/ocr-http.mjs | OCR 五端点与原文/校正/登记核对分离已装配；real 提供者、媒体、登记源未接线时拒绝；两种模式用量端口恒空，不产出 dose_cards；当前内存任务不接公共 Job 读取/取消，真实标签评估与持久/删除链待验收 |
| `correctOCR` | PATCH /ocr/{id}/correction | `partial` | services/api/src/routes/ocr.ts:224-228；tests/integration/ocr-http.mjs | OCR 五端点与原文/校正/登记核对分离已装配；real 提供者、媒体、登记源未接线时拒绝；两种模式用量端口恒空，不产出 dose_cards；当前内存任务不接公共 Job 读取/取消，真实标签评估与持久/删除链待验收 |
| `verifyOCR` | POST /ocr/{id}/verify | `partial` | services/api/src/routes/ocr.ts:242-246；tests/integration/ocr-http.mjs | OCR 五端点与原文/校正/登记核对分离已装配；real 提供者、媒体、登记源未接线时拒绝；两种模式用量端口恒空，不产出 dose_cards；当前内存任务不接公共 Job 读取/取消，真实标签评估与持久/删除链待验收 |
| `createTranscription` | POST /speech/transcriptions | `partial` | services/api/src/routes/speech.ts:132-136；tests/integration/speech-http.mjs | 录音转写四端点与确认分离已装配；默认内存 store，stub/preset_demo 为明确替身，real 提供者/媒体未接线时拒绝；公共 Job 读取/取消未消费此域；真实 ASR 评估、媒体持久化和注销清理待验收 |
| `getTranscription` | GET /speech/transcriptions/{id} | `partial` | services/api/src/routes/speech.ts:153-157；tests/integration/speech-http.mjs | 录音转写四端点与确认分离已装配；默认内存 store，stub/preset_demo 为明确替身，real 提供者/媒体未接线时拒绝；公共 Job 读取/取消未消费此域；真实 ASR 评估、媒体持久化和注销清理待验收 |
| `deleteTranscription` | DELETE /speech/transcriptions/{id} | `partial` | services/api/src/routes/speech.ts:167-171；tests/integration/speech-http.mjs | 录音转写四端点与确认分离已装配；默认内存 store，stub/preset_demo 为明确替身，real 提供者/媒体未接线时拒绝；公共 Job 读取/取消未消费此域；真实 ASR 评估、媒体持久化和注销清理待验收 |
| `confirmTranscription` | PATCH /speech/transcriptions/{id}/confirmation | `partial` | services/api/src/routes/speech.ts:187-191；tests/integration/speech-http.mjs | 录音转写四端点与确认分离已装配；默认内存 store，stub/preset_demo 为明确替身，real 提供者/媒体未接线时拒绝；公共 Job 读取/取消未消费此域；真实 ASR 评估、媒体持久化和注销清理待验收 |
| `createSynthesis` | POST /speech/synthesis | `partial` | services/api/src/routes/synthesis.ts:86-90；tests/integration/tts-http.mjs | 合成受理端点已装配，仅接受已核对内容引用；真实提供者、核对内容与产物端口未在产品装配接线，明确拒绝；内存任务未接公共 Job 读取/取消；真实音频/听感评估、播放消费、持久/删除链待验收 |

## 4 未装配操作（80 条）

以下 HTTP 路径当前返回 NOT_FOUND；partial 项只有独立服务 / 参考组件，不能直接调用这些 HTTP 接口。

| 操作 id | 方法与路径 | 状态 | 证据 | 缺口 / 条件 |
| --- | --- | --- | --- | --- |
| `listSpecies` | GET /catalog/species | `planned` | — | 领域库层已有实现或数据（packages/reference、packages/knowledge），HTTP 路由未装配 |
| `getPrivacyPolicy` | GET /me/privacy-policy | `planned` | — | 未装配 |
| `listExports` | GET /me/exports | `planned` | — | 导出与注销未实现（GY-I19）；packages/privacy 已有删除清单/回执库与用例，无 HTTP 路由与 handler 注册 |
| `requestAccountDeletion` | POST /me/account/deletion | `planned` | — | 导出与注销未实现（GY-I19）；packages/privacy 已有删除清单/回执库与用例，无 HTTP 路由与 handler 注册 |
| `getDeletionReceipt` | GET /account/deletions/{id} | `planned` | — | 导出与注销未实现（GY-I19）；packages/privacy 已有删除清单/回执库与用例，无 HTTP 路由与 handler 注册 |
| `createUpload` | POST /media/uploads | `planned` | — | 相关 packages/media 库有字节校验、去 EXIF、时长、状态和访问控制用例；此契约操作的产品 HTTP 服务未装配，私有存储/用途授权及生命周期联调待完成（GY-I07/GY-I27） |
| `completeUpload` | POST /media/uploads/{id}/complete | `planned` | — | 相关 packages/media 库有字节校验、去 EXIF、时长、状态和访问控制用例；此契约操作的产品 HTTP 服务未装配，私有存储/用途授权及生命周期联调待完成（GY-I07/GY-I27） |
| `getMedia` | GET /media/{id} | `planned` | — | 相关 packages/media 库有字节校验、去 EXIF、时长、状态和访问控制用例；此契约操作的产品 HTTP 服务未装配，私有存储/用途授权及生命周期联调待完成（GY-I07/GY-I27） |
| `deleteMedia` | DELETE /media/{id} | `planned` | — | 相关 packages/media 库有字节校验、去 EXIF、时长、状态和访问控制用例；此契约操作的产品 HTTP 服务未装配，私有存储/用途授权及生命周期联调待完成（GY-I07/GY-I27） |
| `grantMediaAccess` | POST /media/{id}/access | `planned` | — | 相关 packages/media 库有字节校验、去 EXIF、时长、状态和访问控制用例；此契约操作的产品 HTTP 服务未装配，私有存储/用途授权及生命周期联调待完成（GY-I07/GY-I27） |
| `listHerbicides` | GET /herbicides | `planned` | — | 领域库层已有实现或数据（packages/reference、packages/knowledge），HTTP 路由未装配 |
| `getHerbicide` | GET /herbicides/{id} | `planned` | — | 领域库层已有实现或数据（packages/reference、packages/knowledge），HTTP 路由未装配 |
| `verifyRegistration` | POST /registrations/verify | `planned` | — | 领域库层已有实现或数据（packages/reference、packages/knowledge），HTTP 路由未装配 |
| `createConversation` | POST /conversations | `planned` | — | 此文字问答 HTTP 操作未装配；检索/资料守卫与供应商/评估组件不能替代问答任务闭环；按 GY-I12 推进，不等待 ASR/TTS |
| `listConversations` | GET /conversations | `planned` | — | 此文字问答 HTTP 操作未装配；检索/资料守卫与供应商/评估组件不能替代问答任务闭环；按 GY-I12 推进，不等待 ASR/TTS |
| `getConversation` | GET /conversations/{id} | `planned` | — | 此文字问答 HTTP 操作未装配；检索/资料守卫与供应商/评估组件不能替代问答任务闭环；按 GY-I12 推进，不等待 ASR/TTS |
| `deleteConversation` | DELETE /conversations/{id} | `planned` | — | 此文字问答 HTTP 操作未装配；检索/资料守卫与供应商/评估组件不能替代问答任务闭环；按 GY-I12 推进，不等待 ASR/TTS |
| `createTurn` | POST /conversations/{id}/turns | `planned` | — | 此文字问答 HTTP 操作未装配；检索/资料守卫与供应商/评估组件不能替代问答任务闭环；按 GY-I12 推进，不等待 ASR/TTS |
| `listTurns` | GET /conversations/{id}/turns | `planned` | — | 此文字问答 HTTP 操作未装配；检索/资料守卫与供应商/评估组件不能替代问答任务闭环；按 GY-I12 推进，不等待 ASR/TTS |
| `deleteTurn` | DELETE /conversations/{id}/turns/{turn_id} | `planned` | — | 此文字问答 HTTP 操作未装配；检索/资料守卫与供应商/评估组件不能替代问答任务闭环；按 GY-I12 推进，不等待 ASR/TTS |
| `listPosts` | GET /posts | `partial` | services/api/src/community/service.ts:490-495；tests/unit/community-contract.test.mjs | 独立社区服务已有此操作，含归属/可见性与先审后发守卫；app.ts 未装配社区 HTTP 路由，审核、媒体和真实存储/事件依赖未完成产品联调；相关服务测试不等于页面或真实审核验收（GY-I14/GY-I15） |
| `createPost` | POST /posts | `partial` | services/api/src/community/service.ts:556-561；tests/unit/community-contract.test.mjs | 独立社区服务已有此操作，含归属/可见性与先审后发守卫；app.ts 未装配社区 HTTP 路由，审核、媒体和真实存储/事件依赖未完成产品联调；相关服务测试不等于页面或真实审核验收（GY-I14/GY-I15） |
| `getPost` | GET /posts/{id} | `partial` | services/api/src/community/service.ts:620-625；tests/unit/community-contract.test.mjs | 独立社区服务已有此操作，含归属/可见性与先审后发守卫；app.ts 未装配社区 HTTP 路由，审核、媒体和真实存储/事件依赖未完成产品联调；相关服务测试不等于页面或真实审核验收（GY-I14/GY-I15） |
| `editPost` | PATCH /posts/{id} | `partial` | services/api/src/community/service.ts:627-632；tests/unit/community-contract.test.mjs | 独立社区服务已有此操作，含归属/可见性与先审后发守卫；app.ts 未装配社区 HTTP 路由，审核、媒体和真实存储/事件依赖未完成产品联调；相关服务测试不等于页面或真实审核验收（GY-I14/GY-I15） |
| `deletePost` | DELETE /posts/{id} | `partial` | services/api/src/community/service.ts:700-705；tests/unit/community-contract.test.mjs | 独立社区服务已有此操作，含归属/可见性与先审后发守卫；app.ts 未装配社区 HTTP 路由，审核、媒体和真实存储/事件依赖未完成产品联调；相关服务测试不等于页面或真实审核验收（GY-I14/GY-I15） |
| `listComments` | GET /posts/{id}/comments | `partial` | services/api/src/community/service.ts:735-740；tests/unit/community-contract.test.mjs | 独立社区服务已有此操作，含归属/可见性与先审后发守卫；app.ts 未装配社区 HTTP 路由，审核、媒体和真实存储/事件依赖未完成产品联调；相关服务测试不等于页面或真实审核验收（GY-I14/GY-I15） |
| `createComment` | POST /posts/{id}/comments | `partial` | services/api/src/community/service.ts:788-793；tests/unit/community-contract.test.mjs | 独立社区服务已有此操作，含归属/可见性与先审后发守卫；app.ts 未装配社区 HTTP 路由，审核、媒体和真实存储/事件依赖未完成产品联调；相关服务测试不等于页面或真实审核验收（GY-I14/GY-I15） |
| `getComment` | GET /comments/{id} | `partial` | services/api/src/community/service.ts:849-854；tests/unit/community-contract.test.mjs | 独立社区服务已有此操作，含归属/可见性与先审后发守卫；app.ts 未装配社区 HTTP 路由，审核、媒体和真实存储/事件依赖未完成产品联调；相关服务测试不等于页面或真实审核验收（GY-I14/GY-I15） |
| `editComment` | PATCH /comments/{id} | `partial` | services/api/src/community/service.ts:856-861；tests/unit/community-contract.test.mjs | 独立社区服务已有此操作，含归属/可见性与先审后发守卫；app.ts 未装配社区 HTTP 路由，审核、媒体和真实存储/事件依赖未完成产品联调；相关服务测试不等于页面或真实审核验收（GY-I14/GY-I15） |
| `deleteComment` | DELETE /comments/{id} | `partial` | services/api/src/community/service.ts:910-915；tests/unit/community-contract.test.mjs | 独立社区服务已有此操作，含归属/可见性与先审后发守卫；app.ts 未装配社区 HTTP 路由，审核、媒体和真实存储/事件依赖未完成产品联调；相关服务测试不等于页面或真实审核验收（GY-I14/GY-I15） |
| `likePosts` | PUT /posts/{id}/like | `partial` | services/api/src/community/service.ts:944-949；tests/unit/community-contract.test.mjs | 独立社区服务已有此操作，含归属/可见性与先审后发守卫；app.ts 未装配社区 HTTP 路由，审核、媒体和真实存储/事件依赖未完成产品联调；相关服务测试不等于页面或真实审核验收（GY-I14/GY-I15） |
| `unlikePosts` | DELETE /posts/{id}/like | `partial` | services/api/src/community/service.ts:948-953；tests/unit/community-contract.test.mjs | 独立社区服务已有此操作，含归属/可见性与先审后发守卫；app.ts 未装配社区 HTTP 路由，审核、媒体和真实存储/事件依赖未完成产品联调；相关服务测试不等于页面或真实审核验收（GY-I14/GY-I15） |
| `likeComments` | PUT /comments/{id}/like | `partial` | services/api/src/community/service.ts:952-957；tests/unit/community-contract.test.mjs | 独立社区服务已有此操作，含归属/可见性与先审后发守卫；app.ts 未装配社区 HTTP 路由，审核、媒体和真实存储/事件依赖未完成产品联调；相关服务测试不等于页面或真实审核验收（GY-I14/GY-I15） |
| `unlikeComments` | DELETE /comments/{id}/like | `partial` | services/api/src/community/service.ts:956-961；tests/unit/community-contract.test.mjs | 独立社区服务已有此操作，含归属/可见性与先审后发守卫；app.ts 未装配社区 HTTP 路由，审核、媒体和真实存储/事件依赖未完成产品联调；相关服务测试不等于页面或真实审核验收（GY-I14/GY-I15） |
| `createReport` | POST /reports | `partial` | services/api/src/community/service.ts:961-966；tests/unit/community-contract.test.mjs | 独立社区服务已有此操作，含归属/可见性与先审后发守卫；app.ts 未装配社区 HTTP 路由，审核、媒体和真实存储/事件依赖未完成产品联调；相关服务测试不等于页面或真实审核验收（GY-I14/GY-I15） |
| `getOwnReport` | GET /reports/{id} | `partial` | services/api/src/community/service.ts:1001-1006；tests/unit/community-contract.test.mjs | 独立社区服务已有此操作，含归属/可见性与先审后发守卫；app.ts 未装配社区 HTTP 路由，审核、媒体和真实存储/事件依赖未完成产品联调；相关服务测试不等于页面或真实审核验收（GY-I14/GY-I15） |
| `listFavorites` | GET /favorites | `planned` | — | 收藏/历史 HTTP 服务未装配；已有引用和隐私相关组件不构成此操作实现，持久化、归属与失效引用消费待完成（GY-I16） |
| `createFavorite` | POST /favorites | `planned` | — | 收藏/历史 HTTP 服务未装配；已有引用和隐私相关组件不构成此操作实现，持久化、归属与失效引用消费待完成（GY-I16） |
| `deleteFavorite` | DELETE /favorites/{id} | `planned` | — | 收藏/历史 HTTP 服务未装配；已有引用和隐私相关组件不构成此操作实现，持久化、归属与失效引用消费待完成（GY-I16） |
| `listHistory` | GET /history | `planned` | — | 收藏/历史 HTTP 服务未装配；已有引用和隐私相关组件不构成此操作实现，持久化、归属与失效引用消费待完成（GY-I16） |
| `deleteHistory` | DELETE /history/{id} | `planned` | — | 收藏/历史 HTTP 服务未装配；已有引用和隐私相关组件不构成此操作实现，持久化、归属与失效引用消费待完成（GY-I16） |
| `listMessages` | GET /messages | `partial` | services/api/src/messages/service.ts:293-298；tests/unit/messages-contract.test.mjs::三个 operationId | 独立消息服务已实现本人列表、派生未读数和幂等已读；app.ts 未装配消息 HTTP 路由；业务事件创建、真实存储与前端联调待接线，播放不记已读（GY-I17） |
| `getUnreadCount` | GET /messages/unread-count | `partial` | services/api/src/messages/service.ts:331-336；tests/unit/messages-contract.test.mjs::三个 operationId | 独立消息服务已实现本人列表、派生未读数和幂等已读；app.ts 未装配消息 HTTP 路由；业务事件创建、真实存储与前端联调待接线，播放不记已读（GY-I17） |
| `markMessageRead` | PUT /messages/{id}/read | `partial` | services/api/src/messages/service.ts:346-351；tests/unit/messages-contract.test.mjs::三个 operationId | 独立消息服务已实现本人列表、派生未读数和幂等已读；app.ts 未装配消息 HTTP 路由；业务事件创建、真实存储与前端联调待接线，播放不记已读（GY-I17） |
| `listAdminSources` | GET /admin/sources | `partial` | services/api/src/admin/service.ts:513-518；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `createSourceDraft` | POST /admin/sources | `partial` | services/api/src/admin/service.ts:514-519；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `getAdminSource` | GET /admin/sources/{id} | `partial` | services/api/src/admin/service.ts:515-520；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `editSourceDraft` | PATCH /admin/sources/{id} | `partial` | services/api/src/admin/service.ts:516-521；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `publishSource` | POST /admin/sources/{id}/publish | `partial` | services/api/src/admin/service.ts:517-522；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `withdrawSource` | POST /admin/sources/{id}/withdraw | `partial` | services/api/src/admin/service.ts:518-523；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `listAdminKnowledge` | GET /admin/knowledge | `partial` | services/api/src/admin/service.ts:520-525；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `createKnowledgeDraft` | POST /admin/knowledge | `partial` | services/api/src/admin/service.ts:521-526；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `getAdminKnowledge` | GET /admin/knowledge/{id} | `partial` | services/api/src/admin/service.ts:522-527；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `editKnowledgeDraft` | PATCH /admin/knowledge/{id} | `partial` | services/api/src/admin/service.ts:523-528；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `publishKnowledge` | POST /admin/knowledge/{id}/publish | `partial` | services/api/src/admin/service.ts:524-529；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `withdrawKnowledge` | POST /admin/knowledge/{id}/withdraw | `partial` | services/api/src/admin/service.ts:525-530；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `listAdminRegistration` | GET /admin/registrations | `partial` | services/api/src/admin/service.ts:527-532；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `createRegistrationDraft` | POST /admin/registrations | `partial` | services/api/src/admin/service.ts:528-533；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `getAdminRegistration` | GET /admin/registrations/{id} | `partial` | services/api/src/admin/service.ts:529-534；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `editRegistrationDraft` | PATCH /admin/registrations/{id} | `partial` | services/api/src/admin/service.ts:530-535；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `publishRegistration` | POST /admin/registrations/{id}/publish | `partial` | services/api/src/admin/service.ts:531-536；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `withdrawRegistration` | POST /admin/registrations/{id}/withdraw | `partial` | services/api/src/admin/service.ts:532-537；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `listAdminRestriction` | GET /admin/restrictions | `partial` | services/api/src/admin/service.ts:534-539；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `createRestrictionDraft` | POST /admin/restrictions | `partial` | services/api/src/admin/service.ts:535-540；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `getAdminRestriction` | GET /admin/restrictions/{id} | `partial` | services/api/src/admin/service.ts:536-541；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `editRestrictionDraft` | PATCH /admin/restrictions/{id} | `partial` | services/api/src/admin/service.ts:537-542；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `publishRestriction` | POST /admin/restrictions/{id}/publish | `partial` | services/api/src/admin/service.ts:538-543；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `withdrawRestriction` | POST /admin/restrictions/{id}/withdraw | `partial` | services/api/src/admin/service.ts:539-544；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `listAdminCategories` | GET /admin/categories | `partial` | services/api/src/admin/ops/service.ts:269-274；tests/unit/admin-ops-contract.test.mjs::恰好实现 9 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `editCategory` | PATCH /admin/categories/{id} | `partial` | services/api/src/admin/ops/service.ts:274-279；tests/unit/admin-ops-contract.test.mjs::恰好实现 9 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `listAdminUsers` | GET /admin/accounts | `partial` | services/api/src/admin/ops/service.ts:315-320；tests/unit/admin-ops-contract.test.mjs::恰好实现 9 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `suspendUser` | POST /admin/accounts/{id}/suspend | `partial` | services/api/src/admin/ops/service.ts:320-325；tests/unit/admin-ops-contract.test.mjs::恰好实现 9 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `listAdminJobs` | GET /admin/jobs | `partial` | services/api/src/admin/ops/service.ts:394-399；tests/unit/admin-ops-contract.test.mjs::恰好实现 9 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `cancelAdminJob` | POST /admin/jobs/{id}/cancel | `partial` | services/api/src/admin/ops/service.ts:401-406；tests/unit/admin-ops-contract.test.mjs::恰好实现 9 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `listFlags` | GET /admin/feature-flags | `partial` | services/api/src/admin/ops/service.ts:496-501；tests/unit/admin-ops-contract.test.mjs::恰好实现 9 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `setFlag` | PUT /admin/feature-flags/{key} | `partial` | services/api/src/admin/ops/service.ts:501-506；tests/unit/admin-ops-contract.test.mjs::恰好实现 9 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `hidePost` | POST /admin/posts/{id}/hide | `partial` | services/api/src/admin/ops/service.ts:566-571；tests/unit/admin-ops-contract.test.mjs::恰好实现 9 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `listAuditEvents` | GET /admin/audit-events | `partial` | services/api/src/admin/service.ts:541-546；tests/unit/admin-contract-conformance.test.mjs::只实现派单指定的 25 个 operationId | 独立后台服务已有此操作及 scope/版本守卫；app.ts 仅装配后台认证三端点，未装配此业务路由；真实存储、任务/公开内容等端口、审计与后台 UI 联调待完成（GY-I18） |
| `grantCommunityMediaAccess` | POST /community/media-access | `planned` | — | 相关 packages/media 库有字节校验、去 EXIF、时长、状态和访问控制用例；此契约操作的产品 HTTP 服务未装配，私有存储/用途授权及生命周期联调待完成（GY-I07/GY-I27） |
| `readCommunityMediaContent` | GET /community/media/{grant_id}/content | `planned` | — | 相关 packages/media 库有字节校验、去 EXIF、时长、状态和访问控制用例；此契约操作的产品 HTTP 服务未装配，私有存储/用途授权及生命周期联调待完成（GY-I07/GY-I27） |

## 5 计数

| 范围 | implemented | partial | planned | 合计 |
| --- | --- | --- | --- | --- |
| 契约操作 | 11 | 74 | 27 | 112 |
| 横切维度 | 2 | 6 | 0 | 8 |
<!-- contract-status-tables:end -->

## 6 可回归校验

在仓库根目录运行：

```powershell
node tools/verify-contract-status.mjs
node tools/verify-contract-status.mjs --runtime
node --test tests/unit/contract-status-tool.test.mjs
```

默认校验无需安装依赖，检查 112 条操作及 8 个维度覆盖、证据路径/行号/用例名、路由注册和中文表格一致性。静态扫描跟随 app.ts 实际导入并调用的 register*，支持 routes 目录之外的注册模块；仅存在文件或注释中的调用不计装配。

`--runtime` 需要项目锁定依赖和 Node 24，在清除业务配置、凭据与 NODE_OPTIONS 的子进程中调用实际 buildApp、ready 和 Fastify.hasRoute。使用 stub，不监听端口、不发 HTTP/供应商请求、不连接数据库。它证明当前注册清单，不能证明响应、鉴权、状态语义或真实能力。

先人工核对 JSON 的状态/证据，再运行 `node tools/verify-contract-status.mjs --write-doc` 同步标记区域中的表格。覆盖、装配或证据失败时不写文档；普通校验只读，检测陈旧表格后失败退出。脚本是独立命令，未追加 CI 工作流或修改 package.json；其回归测试由现有 unit 通配命令发现。

静态扫描使用正则，不是 TypeScript AST，只支持当前具名相对导入、直接 register*(app, ...) 与 app.get/post/put/patch/delete 写法，显式展开 API_PREFIX 和 crops/regions。模块内多注册函数、动态导入/条件注册、更多模板或插件 prefix 需要扩展扫描并用 runtime 模式核对，不据扫描成功推断任意装配写法正确。

## 7 验证边界

本轮记录见[新 main 进度同步验证](../verification/gy-i01-status-sync-20261013.md)，原装配工具验证见[接口对照刷新验证](../verification/gy-i01-contract-status-refresh-20261013.md)。既有已合业务证据按提交/文件/用例保留，本次未改变业务实现；不重复要求全项目、真机或付费供应商验收。

旧记录中的“本机没有 PG”“未取得成功响应”只描述当时环境。本轮只运行清洁 stub 产品装配与相称回归，不据其他任务的本地 PG、微信模拟器或旧 CI 推定真实供应商、真实微信身份、一加 ACE3V 或资料/用量验收通过。整项 #1 的契约偏差、跨域任务、真实消费者等剩余条件仍按原 issue 验收。
