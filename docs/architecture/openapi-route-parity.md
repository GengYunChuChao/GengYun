# 路由 × OpenAPI 契约对照表

本文件由 `node tools/openapi-route-parity.mjs --write-doc` 生成，**不要手改标记块内容**；
`tests/contract/openapi-route-parity.test.mjs` 会比对标记块与重新生成的结果，漂移即红。

数据来源三处：实现侧 `buildApp()` 后 `app.printRoutes({commonPrefix:false})`（逐条 `app.hasRoute` 复核）、
契约侧 `packages/contracts/openapi.json`、台账侧 `docs/architecture/contract-status.json`。
操作级证据与阻塞说明见 `docs/architecture/contract-implementation-status.md`。

**口径局限**：本表只对账到**操作级**——method、path、operationId、2xx 响应存在性、台账 `planned` 状态；
**字段级 schema 未纳入**：请求/响应体的字段、类型、必填与枚举差异不在本表判定范围内，以 `packages/contracts/openapi.json` 为准。
<!-- openapi-route-parity:start -->

契约版本：`1.0.0`；生成命令：`node tools/openapi-route-parity.mjs --write-doc`（勿手改本块）。

| 指标 | 读数 |
| --- | --- |
| 已挂载路由（不含 HEAD） | 119 |
| 契约操作（paths × method） | 118 |
| 实现 ∩ 契约 | 118 |
| 多出（实现有、契约无） | 0 |
| 例外（实现有、契约按设计不含） | 1 |
| 少掉（契约有、实现无，且台账未标 planned） | 0 |
| 未实现但台账已标 `planned` | 0 |
| 台账 `route_mounted` 与运行时不一致 | 0 |

### 多出（实现有、契约无）

无。

### 例外（实现有、契约按设计不含）

| 方法 | 实现路由 | 依据 |
| --- | --- | --- |
| GET | `/health` | 健康检查，`services/api/src/routes/health.ts:1-4` 明确排除在业务契约之外 |

### 少掉（契约有、实现无）

无。

### 未实现但台账已标 planned

无。

### 台账 route_mounted 与运行时不一致

无。

### 路由 × 契约对照表

| 方法 | 契约路径 | operationId | scope | 版本头 | 已挂载 | 台账状态 | 对账 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/account/deletions/{id}` | getDeletionReceipt | receipt | 不要求 | 是 | partial | 一致 |
| GET | `/admin/accounts` | listAdminUsers | accounts:read | 不要求 | 是 | partial | 一致 |
| POST | `/admin/accounts/{id}/suspend` | suspendUser | accounts:suspend | 需要 | 是 | partial | 一致 |
| GET | `/admin/administrators` | listAdministrators | scopes:read | 不要求 | 是 | partial | 一致 |
| GET | `/admin/administrators/{id}/scopes` | listAdministratorScopes | scopes:read | 不要求 | 是 | partial | 一致 |
| GET | `/admin/audit-events` | listAuditEvents | audit:read | 不要求 | 是 | partial | 一致 |
| GET | `/admin/audit-logs` | listAuditLogs | audit:read | 不要求 | 是 | partial | 一致 |
| POST | `/admin/auth/logout` | logoutAdmin | session:logout | 不要求 | 是 | implemented | 一致 |
| GET | `/admin/auth/session` | getAdminSession | session:read | 不要求 | 是 | implemented | 一致 |
| POST | `/admin/auth/session` | loginAdmin | public | 不要求 | 是 | implemented | 一致 |
| GET | `/admin/categories` | listAdminCategories | sources:read | 不要求 | 是 | partial | 一致 |
| PATCH | `/admin/categories/{id}` | editCategory | sources:write | 需要 | 是 | partial | 一致 |
| GET | `/admin/feature-flags` | listFlags | flags:read | 不要求 | 是 | partial | 一致 |
| PUT | `/admin/feature-flags/{key}` | setFlag | flags:write | 需要 | 是 | partial | 一致 |
| GET | `/admin/flag-audit-events` | listFlagAuditEvents | flags:read | 不要求 | 是 | partial | 一致 |
| GET | `/admin/jobs` | listAdminJobs | jobs:read | 不要求 | 是 | partial | 一致 |
| POST | `/admin/jobs/{id}/cancel` | cancelAdminJob | jobs:cancel | 需要 | 是 | partial | 一致 |
| GET | `/admin/knowledge` | listAdminKnowledge | sources:read | 不要求 | 是 | partial | 一致 |
| POST | `/admin/knowledge` | createKnowledgeDraft | sources:write | 不要求 | 是 | partial | 一致 |
| GET | `/admin/knowledge/{id}` | getAdminKnowledge | sources:read | 不要求 | 是 | partial | 一致 |
| PATCH | `/admin/knowledge/{id}` | editKnowledgeDraft | sources:write | 需要 | 是 | partial | 一致 |
| POST | `/admin/knowledge/{id}/publish` | publishKnowledge | sources:write | 需要 | 是 | partial | 一致 |
| POST | `/admin/knowledge/{id}/withdraw` | withdrawKnowledge | sources:write | 需要 | 是 | partial | 一致 |
| POST | `/admin/posts/{id}/hide` | hidePost | sources:write | 需要 | 是 | partial | 一致 |
| GET | `/admin/registrations` | listAdminRegistration | sources:read | 不要求 | 是 | partial | 一致 |
| POST | `/admin/registrations` | createRegistrationDraft | sources:write | 不要求 | 是 | partial | 一致 |
| GET | `/admin/registrations/{id}` | getAdminRegistration | sources:read | 不要求 | 是 | partial | 一致 |
| PATCH | `/admin/registrations/{id}` | editRegistrationDraft | sources:write | 需要 | 是 | partial | 一致 |
| POST | `/admin/registrations/{id}/publish` | publishRegistration | sources:write | 需要 | 是 | partial | 一致 |
| POST | `/admin/registrations/{id}/withdraw` | withdrawRegistration | sources:write | 需要 | 是 | partial | 一致 |
| GET | `/admin/restrictions` | listAdminRestriction | sources:read | 不要求 | 是 | partial | 一致 |
| POST | `/admin/restrictions` | createRestrictionDraft | sources:write | 不要求 | 是 | partial | 一致 |
| GET | `/admin/restrictions/{id}` | getAdminRestriction | sources:read | 不要求 | 是 | partial | 一致 |
| PATCH | `/admin/restrictions/{id}` | editRestrictionDraft | sources:write | 需要 | 是 | partial | 一致 |
| POST | `/admin/restrictions/{id}/publish` | publishRestriction | sources:write | 需要 | 是 | partial | 一致 |
| POST | `/admin/restrictions/{id}/withdraw` | withdrawRestriction | sources:write | 需要 | 是 | partial | 一致 |
| GET | `/admin/sources` | listAdminSources | sources:read | 不要求 | 是 | partial | 一致 |
| POST | `/admin/sources` | createSourceDraft | sources:write | 不要求 | 是 | partial | 一致 |
| GET | `/admin/sources/{id}` | getAdminSource | sources:read | 不要求 | 是 | partial | 一致 |
| PATCH | `/admin/sources/{id}` | editSourceDraft | sources:write | 需要 | 是 | partial | 一致 |
| POST | `/admin/sources/{id}/publish` | publishSource | sources:write | 需要 | 是 | partial | 一致 |
| POST | `/admin/sources/{id}/withdraw` | withdrawSource | sources:write | 需要 | 是 | partial | 一致 |
| POST | `/auth/logout` | logoutUser | user | 不要求 | 是 | implemented | 一致 |
| GET | `/auth/session` | getUserSession | user | 不要求 | 是 | implemented | 一致 |
| POST | `/auth/wechat` | loginWechat | public | 不要求 | 是 | implemented | 一致 |
| GET | `/catalog/crops` | listCrops | user | 不要求 | 是 | implemented | 一致 |
| GET | `/catalog/regions` | listRegions | user | 不要求 | 是 | implemented | 一致 |
| GET | `/catalog/species` | listSpecies | user | 不要求 | 是 | implemented | 一致 |
| DELETE | `/comments/{id}` | deleteComment | user | 需要 | 是 | partial | 一致 |
| GET | `/comments/{id}` | getComment | user | 不要求 | 是 | partial | 一致 |
| PATCH | `/comments/{id}` | editComment | user | 需要 | 是 | partial | 一致 |
| DELETE | `/comments/{id}/like` | unlikeComments | user | 需要 | 是 | partial | 一致 |
| PUT | `/comments/{id}/like` | likeComments | user | 需要 | 是 | partial | 一致 |
| POST | `/community/media-access` | grantCommunityMediaAccess | user | 需要 | 是 | partial | 一致 |
| GET | `/community/media/{grant_id}/content` | readCommunityMediaContent | user | 不要求 | 是 | partial | 一致 |
| GET | `/conversations` | listConversations | user | 不要求 | 是 | partial | 一致 |
| POST | `/conversations` | createConversation | user | 不要求 | 是 | partial | 一致 |
| DELETE | `/conversations/{id}` | deleteConversation | user | 需要 | 是 | partial | 一致 |
| GET | `/conversations/{id}` | getConversation | user | 不要求 | 是 | partial | 一致 |
| GET | `/conversations/{id}/turns` | listTurns | user | 不要求 | 是 | partial | 一致 |
| POST | `/conversations/{id}/turns` | createTurn | user | 需要 | 是 | partial | 一致 |
| DELETE | `/conversations/{id}/turns/{turn_id}` | deleteTurn | user | 需要 | 是 | partial | 一致 |
| GET | `/favorites` | listFavorites | user | 不要求 | 是 | implemented | 一致 |
| POST | `/favorites` | createFavorite | user | 不要求 | 是 | implemented | 一致 |
| DELETE | `/favorites/{id}` | deleteFavorite | user | 需要 | 是 | implemented | 一致 |
| GET | `/herbicides` | listHerbicides | user | 不要求 | 是 | implemented | 一致 |
| GET | `/herbicides/{id}` | getHerbicide | user | 不要求 | 是 | implemented | 一致 |
| GET | `/history` | listHistory | user | 不要求 | 是 | implemented | 一致 |
| DELETE | `/history/{id}` | deleteHistory | user | 需要 | 是 | partial | 一致 |
| GET | `/jobs/{id}` | getJob | user | 不要求 | 是 | partial | 一致 |
| POST | `/jobs/{id}/cancel` | cancelJob | user | 需要 | 是 | partial | 一致 |
| GET | `/knowledge` | listKnowledge | user | 不要求 | 是 | partial | 一致 |
| GET | `/knowledge/{id}` | getKnowledge | user | 不要求 | 是 | implemented | 一致 |
| DELETE | `/me/account/deletion` | cancelDeletion | user | 不要求 | 是 | partial | 一致 |
| POST | `/me/account/deletion` | requestAccountDeletion | user | 不要求 | 是 | partial | 一致 |
| GET | `/me/consents` | listConsents | user | 不要求 | 是 | partial | 一致 |
| POST | `/me/consents` | grantConsent | user | 不要求 | 是 | partial | 一致 |
| DELETE | `/me/consents/{purpose}` | withdrawConsent | user | 需要 | 是 | partial | 一致 |
| GET | `/me/exports` | listExports | user | 不要求 | 是 | partial | 一致 |
| GET | `/me/privacy-policy` | getPrivacyPolicy | user | 不要求 | 是 | partial | 一致 |
| GET | `/me/profile` | getProfile | user | 不要求 | 是 | implemented | 一致 |
| PUT | `/me/profile` | putProfile | user | 需要 | 是 | implemented | 一致 |
| DELETE | `/media/{id}` | deleteMedia | user | 需要 | 是 | partial | 一致 |
| GET | `/media/{id}` | getMedia | user | 不要求 | 是 | partial | 一致 |
| POST | `/media/{id}/access` | grantMediaAccess | user | 需要 | 是 | partial | 一致 |
| POST | `/media/uploads` | createUpload | user | 不要求 | 是 | partial | 一致 |
| POST | `/media/uploads/{id}/complete` | completeUpload | user | 需要 | 是 | partial | 一致 |
| GET | `/messages` | listMessages | user | 不要求 | 是 | partial | 一致 |
| PUT | `/messages/{id}/read` | markMessageRead | user | 需要 | 是 | partial | 一致 |
| GET | `/messages/unread-count` | getUnreadCount | user | 不要求 | 是 | partial | 一致 |
| POST | `/ocr` | createOCR | user | 不要求 | 是 | partial | 一致 |
| DELETE | `/ocr/{id}` | deleteOCR | user | 需要 | 是 | partial | 一致 |
| GET | `/ocr/{id}` | getOCR | user | 不要求 | 是 | partial | 一致 |
| PATCH | `/ocr/{id}/correction` | correctOCR | user | 需要 | 是 | partial | 一致 |
| POST | `/ocr/{id}/verify` | verifyOCR | user | 需要 | 是 | partial | 一致 |
| GET | `/posts` | listPosts | user | 不要求 | 是 | partial | 一致 |
| POST | `/posts` | createPost | user | 不要求 | 是 | partial | 一致 |
| DELETE | `/posts/{id}` | deletePost | user | 需要 | 是 | partial | 一致 |
| GET | `/posts/{id}` | getPost | user | 不要求 | 是 | partial | 一致 |
| PATCH | `/posts/{id}` | editPost | user | 需要 | 是 | partial | 一致 |
| GET | `/posts/{id}/comments` | listComments | user | 不要求 | 是 | partial | 一致 |
| POST | `/posts/{id}/comments` | createComment | user | 需要 | 是 | partial | 一致 |
| DELETE | `/posts/{id}/like` | unlikePosts | user | 需要 | 是 | partial | 一致 |
| GET | `/posts/{id}/like` | getPostLike | user | 不要求 | 是 | partial | 一致 |
| PUT | `/posts/{id}/like` | likePosts | user | 需要 | 是 | partial | 一致 |
| GET | `/public/home` | getPublicHome | public | 不要求 | 是 | partial | 一致 |
| POST | `/recognitions` | createRecognition | user | 不要求 | 是 | partial | 一致 |
| DELETE | `/recognitions/{id}` | deleteRecognition | user | 需要 | 是 | partial | 一致 |
| GET | `/recognitions/{id}` | getRecognition | user | 不要求 | 是 | partial | 一致 |
| PATCH | `/recognitions/{id}/selection` | selectSpecies | user | 需要 | 是 | partial | 一致 |
| POST | `/registrations/verify` | verifyRegistration | user | 不要求 | 是 | partial | 一致 |
| POST | `/reports` | createReport | user | 不要求 | 是 | partial | 一致 |
| GET | `/reports/{id}` | getOwnReport | user | 不要求 | 是 | partial | 一致 |
| POST | `/speech/synthesis` | createSynthesis | user | 不要求 | 是 | partial | 一致 |
| POST | `/speech/transcriptions` | createTranscription | user | 不要求 | 是 | partial | 一致 |
| DELETE | `/speech/transcriptions/{id}` | deleteTranscription | user | 需要 | 是 | partial | 一致 |
| GET | `/speech/transcriptions/{id}` | getTranscription | user | 不要求 | 是 | partial | 一致 |
| PATCH | `/speech/transcriptions/{id}/confirmation` | confirmTranscription | user | 需要 | 是 | partial | 一致 |

<!-- openapi-route-parity:end -->
