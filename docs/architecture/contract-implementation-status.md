# GY-I01 契约实现状态对照

issue：`GengYunChuChao/GengYun#1`（`stage:initial` / `priority:P0` / `phase:M1`）。基线 `upstream/main = 2d562d5b6fb79896ef8935716b90939538f274c2`。本文口径 **`Refs #1`**，不关闭 #1，也不构成验收通过。

**本文要回答的问题只有一个**：读完它，任何一个下游开发者能仅凭它判断某条契约「现在能不能调、调不通是该等哪一项」。

## 1 判据、状态定义与事实源

| 状态 | 含义 | 必须给出的东西 |
| --- | --- | --- |
| `implemented` | 在 main 上已被 `services/api/src/app.ts` 真正装配，且行为有可复核证据 | 源码 `文件:行` 或 `测试文件::用例名`；「契约里有定义」不算 |
| `partial` | 有代码，但缺运行条件、或缺分支，或与冻结契约存在已记录的偏差 | 缺什么（前置 issue、用户侧资源，还是没人做） |
| `planned` | 仅契约冻结，无实现 | 缺什么 |

三条自我约束，写下来是为了能被核对：

1. **证据不足只能降档，不得推断为已实现**。本文的 12 条 `implemented` 全部有测试用例名或源码行号；证据只到「库层有用例」的一律记 `planned` 或 `partial`，并写明 HTTP 路由未装配。
2. **逐个核对装配列表，而不是看路由文件是否存在**。`services/api/src/app.ts:113-119` 是当前的 `register*` 装配清单：`registerHealthRoutes`（`/health`，运营端点，不在业务契约内）、`registerPublicHomeRoute`、`registerUserAuthRoutes`、`registerAdminAuthRoutes`、`registerConsentRoutes`、`registerProfileRoutes`、`registerKnowledgeRoutes`。除这七项以外的路由一律不计已挂载，`app.ts:121-126` 的 404 兜底会如实返回 `NOT_FOUND`。`tools/verify-contract-status.mjs` 把这个判定做成了可回归检查。
3. **没执行的不写通过**。本轮的本机实测与未取得项分别记在[验证记录](../verification/gy-i01-contract-status-20261011.md)，失败的原始报错原样保留。CI 状态不当作本机实测。

事实源优先级：`packages/contracts/openapi.json`（路径/字段）、`packages/contracts/operations.json`（112 条操作，含 scope 与是否要求版本头）、`packages/contracts/states.json`（枚举与错误码到 HTTP 状态的映射）→ 本文的行为描述以 [状态协议](state-contract.md) 为准。

机器可读副本：[contract-status.json](contract-status.json)（逐条 112 行 + 8 条横切维度，含证据与阻塞字段）。

## 2 #1 范围点名的横切约定

| 维度 | 来源锚点 | 状态 | 证据 | 阻塞 / 缺什么 |
| --- | --- | --- | --- | --- |
| 错误码 | `states.json#/error_status_map`；[状态协议](state-contract.md):17-30 | `partial` | `services/api/src/contract.ts:14-58`、`services/api/src/errors.ts:29-63`；`tests/contract/contract-codes.test.mjs::API 错误码与 HTTP 状态映射与契约 states.json 完全一致` | 缺：契约 `error_status_map` 没有 500 码，未预期异常以 500 + `contract_gap=NO_CONTRACT_CODE_FOR_500` 如实返回（`services/api/src/app.ts:170-184`）；后台凭据错误无专用码，复用 401 `SESSION_REQUIRED`（`services/api/src/routes/admin-auth.ts:12-13`） |
| 分页 | [状态协议](state-contract.md):32；`openapi.json#/components/parameters/Cursor`、`Limit` | `partial` | `services/api/src/knowledge/service.ts:36-51`、`services/api/src/profile/service.ts:105-131`、`services/api/src/privacy/consent-pg.ts:48-55`；`tests/unit/knowledge-api.test.mjs::knowledge real projection and limited runtime over loopback HTTP (synthetic only)` | 缺：`/me/consents` 的游标是裸 base64url，未 HMAC 签名、未绑定主体/过滤器/版本水位、无 15 分钟有效期，与状态协议 32 行的要求不符；`/knowledge` 排序是 id 升序，与「`(created_at DESC,id DESC)`」不一致。`items + next_cursor`、limit 默认 20 上限 50 在三处 schema 中一致 |
| 版本 | [状态协议](state-contract.md):15 | `implemented` | `services/api/src/routes/profile.ts:37-41`、`services/api/src/routes/consents.ts:59-63`、`services/api/src/routes/knowledge.ts:30-34`、`services/api/src/profile/service.ts:86-87`；`tests/unit/profile-api.test.mjs::GY-I05 persistent profile/catalog HTTP and SQL regression (synthetic identity)` | 无（需 `DATABASE_URL`；`If-Match` 缺失 428、不匹配 409 已实现并被用例覆盖） |
| 幂等 | [状态协议](state-contract.md):34 | `partial` | `services/api/src/routes/support.ts:80-148`、`services/api/src/auth/idempotency.ts:1-60`；`tests/unit/auth-routes.test.mjs::幂等：同键同体收敛到同一会话（重放换发令牌、旧令牌失效）；台账不含明文令牌；同键异体 → 409` | 缺：409 `REQUEST_IN_PROGRESS` 没有带 `Retry-After` 响应头（`support.ts:141-145` 只置 `retryable=true`，错误处理器不加头），与状态协议 34 行「带 Retry-After」不符 |
| `source_kind` | `states.json#/states/SourceKind`、`EvidenceKind`；[状态协议](state-contract.md):60 | `partial` | `services/api/src/db/catalog.ts:5-22`、`services/api/src/knowledge/service.ts:60-64`、`packages/reference/constants.mjs:1-60`；`tests/reference/contract.test.mjs::H2：来源/剂型缺失时，普通 string 必填字段以「未采集」占位` | 缺：只有 `/public/home` 与 `/knowledge` 两条已装配路径投影该字段（都要真实库）；`/herbicides` 的 `source_kind`/`evidence_kind` 投影只存在于未装配的 `packages/reference/service.mjs`，HTTP 层取不到。「模拟来源不产生 DoseCard」只有契约与库层断言 |
| 真实 / 替身环境 | `states.json#/states/ExecutionMode`；[状态协议](state-contract.md):3 | `implemented` | `services/api/src/contract.ts:9-11`、`services/api/src/config.ts:126-238`、`services/api/src/auth/wechat.ts:66-76`；`tests/unit/api-config.test.mjs::real 模式缺配置时一次性列出全部字段，且不静默启动` | 无。本机实测：stub 启动成功且 `meta.execution_mode=stub`；`APP_EXECUTION_MODE=real` 且无凭据时 exit 1 并列出 9 个缺失字段，不半配置启动 |
| 取消 | [状态协议](state-contract.md):48；`states.json#/job_transitions` | `planned` | 无实现 | 无实现：`cancelJob` / `cancelAdminJob` 未装配（`POST /api/v1/jobs/{id}/cancel` 返回 404），没有 Job 读写、没有租约（`lease_token`/`lease_expires_at`）、没有取消时的原子 revision 递增；只有 `states.json` 冻结了 `cancelled` 为不可复活终态 |
| 超时 | [状态协议](state-contract.md):50 | `partial` | `services/api/src/db/pool.ts:27-53`、`services/api/src/auth/wechat.ts:32-33`、`services/api/src/knowledge/service.ts:74-78`；`tests/unit/api-health.test.mjs::/health 在 real 模式数据库不可达时返回 503 degraded，不假装 ok` | 缺：已实现的只有连接池 `statement_timeout` 5s / `query_timeout` 6s、健康检查默认 2s、微信 `code2session` 8s `AbortController`、SQL `57014`/`55P03` → `PROVIDER_TIMEOUT`。「单识别/ASR/问答阶段硬截止 30 秒」「语音录制 60 秒与处理 30 秒区分」「`deadline_at` 与租约 15 秒 / 心跳 5 秒」全部无实现 |

「取消与超时」是 #1 范围里的一类约定，这里拆成两行，因为两半的完成度差得很远，合并写会把「取消=完全没有」藏进 `partial`。

## 3 已装配的 16 条操作（逐条）

计数：`implemented` 12、`partial` 4。下表 16 行与 `tools/verify-contract-status.mjs` 的源码扫描结果逐条一致。

| 操作 id | 方法与路径 | 状态 | 证据（可复核） | 阻塞 / 缺什么 |
| --- | --- | --- | --- | --- |
| `getPublicHome` | GET /public/home | `partial` | `services/api/src/routes/public-home.ts:9-16`、`services/api/src/db/catalog.ts:14-27`；`tests/unit/public-home.test.mjs::public home refuses missing DB and non-real modes without issuing queries` | 缺分支：仅 `execution_mode=real` 且 `DATABASE_URL` 非空时读库（`catalog.ts:15`）；stub / preset_demo 恒 503 `PROVIDER_UNAVAILABLE`，本机无真实 PostgreSQL 17，因此**未取得任何一次成功响应**；响应固定 `human_review_state=under_construction` |
| `loginWechat` | POST /auth/wechat | `implemented` | `services/api/src/routes/auth.ts:42-83`、`services/api/src/auth/wechat.ts:66-131`；`tests/unit/auth-routes.test.mjs::微信登录：仅凭 code 建立会话，返回契约 Session 封套（不强制手机号）` | 无（需 `Idempotency-Key`；stub / preset_demo 用合成身份，不代表真实微信身份） |
| `getUserSession` | GET /auth/session | `implemented` | `services/api/src/routes/auth.ts:85-99`；`tests/unit/auth-routes.test.mjs::GET /auth/session：返回本人 SessionInfo（audience/scopes/revision），ETag 为 revision` | 无 |
| `logoutUser` | POST /auth/logout | `implemented` | `services/api/src/routes/auth.ts:101-122`；`tests/unit/auth-routes.test.mjs::退出登录：撤销当前会话后同一令牌立即失效（401 SESSION_EXPIRED）` | 无 |
| `loginAdmin` | POST /admin/auth/session | `implemented` | `services/api/src/routes/admin-auth.ts:46-86`、`services/api/src/auth/password.ts:1-46`；`tests/unit/auth-routes.test.mjs::后台登录/会话/退出全流程（独立 audience=admin，带契约 scope）` | 无（首次管理员需 `ADMIN_BOOTSTRAP_LOGIN_NAME`/`ADMIN_BOOTSTRAP_PASSWORD`；凭据错误沿用 401 `SESSION_REQUIRED`，见 §2 错误码行） |
| `getAdminSession` | GET /admin/auth/session | `implemented` | `services/api/src/routes/admin-auth.ts:88-101`；`tests/unit/auth-routes.test.mjs::后台高权限拒绝：scope 不足的管理员被 403 SCOPE_DENIED 拦下` | 无 |
| `logoutAdmin` | POST /admin/auth/logout | `implemented` | `services/api/src/routes/admin-auth.ts:103-127`；`tests/unit/auth-routes.test.mjs::后台登录/会话/退出全流程（独立 audience=admin，带契约 scope）` | 无 |
| `getProfile` | GET /me/profile | `implemented` | `services/api/src/routes/profile.ts:25-28`、`services/api/src/profile/service.ts:66-71`；`tests/unit/profile-api.test.mjs::GY-I05 persistent profile/catalog HTTP and SQL regression (synthetic identity)` | 需 `DATABASE_URL` 与迁移 0001..0010；无库时如实 503 `PROVIDER_UNAVAILABLE`（本机 stub 实测） |
| `putProfile` | PUT /me/profile | `implemented` | `services/api/src/routes/profile.ts:29-42`、`services/api/src/profile/service.ts:72-104`；`tests/unit/profile-api.test.mjs::GY-I05 persistent profile/catalog HTTP and SQL regression (synthetic identity)` | 无（需 `If-Match` 与 `Idempotency-Key`；空档案 revision=1，首次 PUT 写 revision=2） |
| `listCrops` | GET /catalog/crops | `implemented` | `services/api/src/routes/profile.ts:43-53`、`services/api/src/profile/service.ts:57-64`；`tests/unit/profile-api.test.mjs::GY-I05 persistent profile/catalog HTTP and SQL regression (synthetic identity)` | 需 `DATABASE_URL`；库中行必须与 `packages/knowledge/catalog/crops.json` 逐字段一致，否则被过滤掉（不补写） |
| `listRegions` | GET /catalog/regions | `implemented` | `services/api/src/routes/profile.ts:43-53`、`services/api/src/profile/service.ts:57-64`；`tests/unit/profile-api.test.mjs::GY-I05 persistent profile/catalog HTTP and SQL regression (synthetic identity)` | 需 `DATABASE_URL`；仅浙江（`33` 开头）行政区代码 |
| `listConsents` | GET /me/consents | `partial` | `services/api/src/routes/consents.ts:40-49`、`services/api/src/privacy/consent-pg.ts:48-55`、`services/api/src/privacy/consent-pg.ts:116-127` | 缺：游标未签名未绑定（见 §2 分平行）；且依赖运维手工把 `consent_policies` 落库——迁移 0009 不提供管理 API 或生产种子（`docs/verification/gy-i27-consent-grant-pg.md:9`） |
| `grantConsent` | POST /me/consents | `partial` | `services/api/src/routes/consents.ts:24-39`、`services/api/src/privacy/grant-pg.ts:26-97`；`.github/workflows/consent-grant-postgres.yml` 驱动 `tests/integration/consent-grant-pg.mjs`（需真实 PostgreSQL，见该文件 11-18 行的 `CONSENT_GRANT_TEST_URL` 前置） | 缺运行条件：该 purpose 的可用政策行必须已在 `consent_policies` 中且来源已核验，否则如实 403 `CONSENT_REQUIRED`；本机没有真实 PostgreSQL 与已核验政策，**该用例本轮未执行**，只在 `allowSyntheticGrantPolicy` 测试注入下可走通 |
| `withdrawConsent` | DELETE /me/consents/{purpose} | `partial` | `services/api/src/routes/consents.ts:50-64`、`services/api/src/privacy/consent-pg.ts:140-183` | 缺分支：撤回消费者（jobs / media / exports / author_links）未接入，存在任一条依赖即以 409 `OBJECT_UNAVAILABLE` 拒绝而不是假成功（`consent-pg.ts:164-169`）；同样依赖 `consent_policies` 已落库 |
| `listKnowledge` | GET /knowledge | `implemented` | `services/api/src/routes/knowledge.ts:25-29`、`services/api/src/knowledge/service.ts:14-80`；`tests/unit/knowledge-api.test.mjs::knowledge real projection and limited runtime over loopback HTTP (synthetic only)` | 需 `DATABASE_URL` 与 `catalog_read.current_knowledge` 视图；排序为 id 升序，与状态协议 32 行不一致（见 §2 分平行） |
| `getKnowledge` | GET /knowledge/{id} | `implemented` | `services/api/src/routes/knowledge.ts:30-34`、`services/api/src/knowledge/service.ts:60-69`；`tests/unit/knowledge-api.test.mjs::knowledge real projection and limited runtime over loopback HTTP (synthetic only)` | 需 `DATABASE_URL`；不可见与不存在统一 404，ETag 为 revision |

## 4 未装配的 96 条操作

以下 operation 在 `operations.json` 中存在，但 `app.ts` 没有装配对应路由，调用会得到 `app.ts:121-126` 的 404 `NOT_FOUND`。按缺失原因分族；逐条的完整阻塞文本见 [contract-status.json](contract-status.json)。

### 4.1 媒体与社区取图（7 条）——`packages/media` 库已实现并有用例，HTTP 未装配

| 操作 id | 方法与路径 |
| --- | --- |
| `createUpload` | POST /media/uploads |
| `completeUpload` | POST /media/uploads/{id}/complete |
| `getMedia` | GET /media/{id} |
| `deleteMedia` | DELETE /media/{id} |
| `grantMediaAccess` | POST /media/{id}/access |
| `grantCommunityMediaAccess` | POST /community/media-access |
| `readCommunityMediaContent` | GET /community/media/{grant_id}/content |

`packages/media` 的字节校验、去 EXIF、真实时长与状态机在 `tests/media/*.test.mjs` 中有用例，社区 grant 与取图在 `tests/media/access.test.mjs` 中有用例；但这些用例直接调用库，**不经过 HTTP**。前置：媒体用途授权（GY-I27）与对象存储。

### 4.2 Job（2 条）——只有契约状态机，无 worker、无队列、无路由

| 操作 id | 方法与路径 |
| --- | --- |
| `getJob` | GET /jobs/{id} |
| `cancelJob` | POST /jobs/{id}/cancel |

### 4.3 资料检索与登记核对（4 条）——领域库/数据已有，HTTP 未装配

| 操作 id | 方法与路径 |
| --- | --- |
| `listSpecies` | GET /catalog/species |
| `listHerbicides` | GET /herbicides |
| `getHerbicide` | GET /herbicides/{id} |
| `verifyRegistration` | POST /registrations/verify |

`packages/reference` 已实现 `/knowledge`、`/herbicides`、`/catalog/*` 的契约投影并有 `tests/reference/*.test.mjs` 用例，但**只有测试消费它**，`app.ts` 未装配；`services/api/src/db/catalog.ts:30-46` 的登记证据查询也还没有路由。

### 4.4 AI 能力（21 条）——未接入，前置 GY-I25 与 GY-I21

| 操作 id | 方法与路径 |
| --- | --- |
| `createRecognition` | POST /recognitions |
| `getRecognition` | GET /recognitions/{id} |
| `deleteRecognition` | DELETE /recognitions/{id} |
| `selectSpecies` | PATCH /recognitions/{id}/selection |
| `createOCR` | POST /ocr |
| `getOCR` | GET /ocr/{id} |
| `deleteOCR` | DELETE /ocr/{id} |
| `correctOCR` | PATCH /ocr/{id}/correction |
| `verifyOCR` | POST /ocr/{id}/verify |
| `createTranscription` | POST /speech/transcriptions |
| `getTranscription` | GET /speech/transcriptions/{id} |
| `deleteTranscription` | DELETE /speech/transcriptions/{id} |
| `confirmTranscription` | PATCH /speech/transcriptions/{id}/confirmation |
| `createSynthesis` | POST /speech/synthesis |
| `createConversation` | POST /conversations |
| `listConversations` | GET /conversations |
| `getConversation` | GET /conversations/{id} |
| `deleteConversation` | DELETE /conversations/{id} |
| `createTurn` | POST /conversations/{id}/turns |
| `listTurns` | GET /conversations/{id}/turns |
| `deleteTurn` | DELETE /conversations/{id}/turns/{turn_id} |

### 4.5 社区、引用、收藏、历史与消息（24 条）——业务未实现

| 操作 id | 方法与路径 |
| --- | --- |
| `listPosts` | GET /posts |
| `createPost` | POST /posts |
| `getPost` | GET /posts/{id} |
| `editPost` | PATCH /posts/{id} |
| `deletePost` | DELETE /posts/{id} |
| `listComments` | GET /posts/{id}/comments |
| `createComment` | POST /posts/{id}/comments |
| `getComment` | GET /comments/{id} |
| `editComment` | PATCH /comments/{id} |
| `deleteComment` | DELETE /comments/{id} |
| `likePosts` | PUT /posts/{id}/like |
| `unlikePosts` | DELETE /posts/{id}/like |
| `likeComments` | PUT /comments/{id}/like |
| `unlikeComments` | DELETE /comments/{id}/like |
| `createReport` | POST /reports |
| `getOwnReport` | GET /reports/{id} |
| `listFavorites` | GET /favorites |
| `createFavorite` | POST /favorites |
| `deleteFavorite` | DELETE /favorites/{id} |
| `listHistory` | GET /history |
| `deleteHistory` | DELETE /history/{id} |
| `listMessages` | GET /messages |
| `getUnreadCount` | GET /messages/unread-count |
| `markMessageRead` | PUT /messages/{id}/read |

消费任务见[覆盖与交接](acceptance-map.md)：F05/F08 → GY-I14/15/18，F18 → GY-I16，F19 → GY-I17。`packages/privacy` 提供了守卫与账本库，但没有 HTTP 装配。

### 4.6 导出与注销（3 条）——未实现，前置 GY-I19

| 操作 id | 方法与路径 |
| --- | --- |
| `listExports` | GET /me/exports |
| `requestAccountDeletion` | POST /me/account/deletion |
| `getDeletionReceipt` | GET /account/deletions/{id} |

`packages/privacy/deletion.mjs` 与 `ledger.mjs` 有删除清单与回执用例（`tests/privacy/deletion.test.mjs`），但没有路由，也没有注册任何 `module_handler`。

### 4.7 隐私政策读取（1 条）

| 操作 id | 方法与路径 |
| --- | --- |
| `getPrivacyPolicy` | GET /me/privacy-policy |

### 4.8 后台业务（34 条）——后台只装配了认证三端点

| 操作 id | 方法与路径 |
| --- | --- |
| `listAdminSources` | GET /admin/sources |
| `createSourceDraft` | POST /admin/sources |
| `getAdminSource` | GET /admin/sources/{id} |
| `editSourceDraft` | PATCH /admin/sources/{id} |
| `publishSource` | POST /admin/sources/{id}/publish |
| `withdrawSource` | POST /admin/sources/{id}/withdraw |
| `listAdminKnowledge` | GET /admin/knowledge |
| `createKnowledgeDraft` | POST /admin/knowledge |
| `getAdminKnowledge` | GET /admin/knowledge/{id} |
| `editKnowledgeDraft` | PATCH /admin/knowledge/{id} |
| `publishKnowledge` | POST /admin/knowledge/{id}/publish |
| `withdrawKnowledge` | POST /admin/knowledge/{id}/withdraw |
| `listAdminRegistration` | GET /admin/registrations |
| `createRegistrationDraft` | POST /admin/registrations |
| `getAdminRegistration` | GET /admin/registrations/{id} |
| `editRegistrationDraft` | PATCH /admin/registrations/{id} |
| `publishRegistration` | POST /admin/registrations/{id}/publish |
| `withdrawRegistration` | POST /admin/registrations/{id}/withdraw |
| `listAdminRestriction` | GET /admin/restrictions |
| `createRestrictionDraft` | POST /admin/restrictions |
| `getAdminRestriction` | GET /admin/restrictions/{id} |
| `editRestrictionDraft` | PATCH /admin/restrictions/{id} |
| `publishRestriction` | POST /admin/restrictions/{id}/publish |
| `withdrawRestriction` | POST /admin/restrictions/{id}/withdraw |
| `listAdminCategories` | GET /admin/categories |
| `editCategory` | PATCH /admin/categories/{id} |
| `listAdminUsers` | GET /admin/accounts |
| `suspendUser` | POST /admin/accounts/{id}/suspend |
| `listAdminJobs` | GET /admin/jobs |
| `cancelAdminJob` | POST /admin/jobs/{id}/cancel |
| `listFlags` | GET /admin/feature-flags |
| `setFlag` | PUT /admin/feature-flags/{key} |
| `hidePost` | POST /admin/posts/{id}/hide |
| `listAuditEvents` | GET /admin/audit-events |

后台 scope 常量与守卫（`session:read`、`session:logout`、`sources:read/write`、`accounts:read/suspend`、`jobs:read/cancel`、`flags:read/write`、`audit:read`）已在 `services/api/src/auth/middleware.ts:201-247` 就绪，但没有业务路由消费它们。

## 5 计数

| 范围 | `implemented` | `partial` | `planned` | 合计 |
| --- | --- | --- | --- | --- |
| 契约操作（`operations.json`） | 12 | 4 | 96 | 112 |
| 横切维度（#1 范围点名） | 2 | 5 | 1 | 8 |
| 合计 | 14 | 9 | 97 | 120 |

`implemented` 的 12 条操作是 `loginWechat`、`getUserSession`、`logoutUser`、`loginAdmin`、`getAdminSession`、`logoutAdmin`、`getProfile`、`putProfile`、`listCrops`、`listRegions`、`listKnowledge`、`getKnowledge`；`partial` 的 4 条是 `getPublicHome`、`listConsents`、`grantConsent`、`withdrawConsent`。

## 6 可回归校验

`tools/verify-contract-status.mjs` 校验三件能被机器证明的事，跑法：

```powershell
node tools/verify-contract-status.mjs
```

1. **覆盖性**：`operations.json` 的每个 `(method,path)` 在 `contract-status.json` 中恰好出现一次，不遗漏、不臆造。
2. **装配一致性**：先取每个 `routes/*.ts` 的 `register*` 导出，再确认 `app.ts` 真的调用了它，最后把扫到的路由与对照表声明的 `route_mounted` 逐条比对。**路由文件里写了 `app.get(...)` 但没被 `app.ts` 装配，不计已挂载**——这一条正是「契约里有定义 ≠ 已实现」的机器化。
3. **证据可复核**：`implemented`/`partial` 行所引的源码路径必须存在且行号不越界，所引用例名必须真的出现在该测试文件里。

**为什么状态本身只能人工维护**：`implemented` 的语义正确性、`partial` 的「缺什么」都要求读代码与判据，脚本推不出来。脚本只保证「表不会腐烂」（覆盖性、装配一致性、证据存在），**不会**把人工判定升档，也不证明实现语义正确。校验失败即 exit 1。

已知局限（如实写）：

- 脚本用正则扫路由声明，不解析 TypeScript。`services/api/src/routes/profile.ts:43` 的 `for (const kind of ['crops','regions'])` 是显式展开的两个取值，未做通用模板求值——宁可少扫也不猜。
- 该脚本**没有接进 `npm run test:*` 或 CI**：本轮约束是「只碰 `docs/` 与校验脚本」，改根 `package.json` 超出范围，故只提供命令与文档，由监工决定是否纳管。

## 7 本文不能证明什么

- 不证明任何 AC 通过、不关闭 #1、不代替监工验收。
- `implemented` 只表示「main 上装配了、有可复核证据」，不表示真实环境已验证：本机没有独立 PostgreSQL 17 服务器，相关用例跑在内存 PostgreSQL 引擎（PGlite）上；微信登录走的是合成身份；供应商、正式 AppID、真机、部署均未取得。
- 契约里没有的字段与行为，本文不推断、不补写。
