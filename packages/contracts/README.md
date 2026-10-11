# 耕云初版 HTTP 契约 1.0.0（提案修订2）

GY-I01 / #1，待监工冻结；没有已运行API。业务v1.0、开发v1.1。

- [架构ADR](../../docs/architecture/adr-001-initial-architecture.md)
- [数据字典与索引](../../docs/architecture/data-dictionary.md)
- [HTTP/状态/隐私行为](../../docs/architecture/state-contract.md)
- [F/AC覆盖和交接](../../docs/architecture/acceptance-map.md)
- [OpenAPI 3.1.1](openapi.json)、[状态字典](states.json)、[操作索引](operations.json)
- [合成设计示例](examples.json)：不能用作真实来源、登记、审核或供应商证据。

OpenAPI使用JSON表示，可由支持3.1的工具读取。响应data/meta或error/meta；来源source_kind与执行execution_mode分开。普通CI只做离线契约检查；完整标准验证/框架兼容及真实能力证据另列。接入客户端只能消费本目录HTTP定义，不能引用供应商私有SDK。

版本变化须同PR更新消费者、枚举、索引、行为说明与示例；不能通过接口增加二月模块。所有写接口幂等；下表版本列“是”表示If-Match强ETag必需。身份和权限必须由服务端实现，标注不代表已经强制。

修订2补齐社区受控媒体读取与关联往返，Post.media提供媒体revision，Author提供独立revision/avatar_media；关联通过linked_knowledge_ref/linked_knowledge返回安全状态。新增请求链与失效断言见examples.json；API尚未实现。

| operationId | 方法与路径（前缀/api/v1） | 权限 | 版本 |
| --- | --- | --- | --- |
| getPublicHome | `GET /public/home` | public | 否 |
| loginWechat | `POST /auth/wechat` | public | 否 |
| loginAdmin | `POST /admin/auth/session` | public | 否 |
| getAdminSession | `GET /admin/auth/session` | session:read | 否 |
| getUserSession | `GET /auth/session` | user | 否 |
| logoutUser | `POST /auth/logout` | user | 否 |
| logoutAdmin | `POST /admin/auth/logout` | session:logout | 否 |
| getProfile | `GET /me/profile` | user | 否 |
| putProfile | `PUT /me/profile` | user | 是 |
| listCrops | `GET /catalog/crops` | user | 否 |
| listRegions | `GET /catalog/regions` | user | 否 |
| listSpecies | `GET /catalog/species` | user | 否 |
| getPrivacyPolicy | `GET /me/privacy-policy` | user | 否 |
| listConsents | `GET /me/consents` | user | 否 |
| grantConsent | `POST /me/consents` | user | 否 |
| withdrawConsent | `DELETE /me/consents/{purpose}` | user | 是 |
| listExports | `GET /me/exports` | user | 否 |
| requestAccountDeletion | `POST /me/account/deletion` | user | 否 |
| getDeletionReceipt | `GET /account/deletions/{id}` | receipt | 否 |
| createUpload | `POST /media/uploads` | user | 否 |
| completeUpload | `POST /media/uploads/{id}/complete` | user | 是 |
| getMedia | `GET /media/{id}` | user | 否 |
| deleteMedia | `DELETE /media/{id}` | user | 是 |
| grantMediaAccess | `POST /media/{id}/access` | user | 是 |
| getJob | `GET /jobs/{id}` | user | 否 |
| cancelJob | `POST /jobs/{id}/cancel` | user | 是 |
| listKnowledge | `GET /knowledge` | user | 否 |
| getKnowledge | `GET /knowledge/{id}` | user | 否 |
| listHerbicides | `GET /herbicides` | user | 否 |
| getHerbicide | `GET /herbicides/{id}` | user | 否 |
| verifyRegistration | `POST /registrations/verify` | user | 否 |
| createRecognition | `POST /recognitions` | user | 否 |
| getRecognition | `GET /recognitions/{id}` | user | 否 |
| deleteRecognition | `DELETE /recognitions/{id}` | user | 是 |
| selectSpecies | `PATCH /recognitions/{id}/selection` | user | 是 |
| createOCR | `POST /ocr` | user | 否 |
| getOCR | `GET /ocr/{id}` | user | 否 |
| deleteOCR | `DELETE /ocr/{id}` | user | 是 |
| correctOCR | `PATCH /ocr/{id}/correction` | user | 是 |
| verifyOCR | `POST /ocr/{id}/verify` | user | 是 |
| createTranscription | `POST /speech/transcriptions` | user | 否 |
| getTranscription | `GET /speech/transcriptions/{id}` | user | 否 |
| deleteTranscription | `DELETE /speech/transcriptions/{id}` | user | 是 |
| confirmTranscription | `PATCH /speech/transcriptions/{id}/confirmation` | user | 是 |
| createSynthesis | `POST /speech/synthesis` | user | 否 |
| createConversation | `POST /conversations` | user | 否 |
| listConversations | `GET /conversations` | user | 否 |
| getConversation | `GET /conversations/{id}` | user | 否 |
| deleteConversation | `DELETE /conversations/{id}` | user | 是 |
| createTurn | `POST /conversations/{id}/turns` | user | 是 |
| listTurns | `GET /conversations/{id}/turns` | user | 否 |
| deleteTurn | `DELETE /conversations/{id}/turns/{turn_id}` | user | 是 |
| listPosts | `GET /posts` | user | 否 |
| createPost | `POST /posts` | user | 否 |
| getPost | `GET /posts/{id}` | user | 否 |
| editPost | `PATCH /posts/{id}` | user | 是 |
| deletePost | `DELETE /posts/{id}` | user | 是 |
| listComments | `GET /posts/{id}/comments` | user | 否 |
| createComment | `POST /posts/{id}/comments` | user | 是 |
| getComment | `GET /comments/{id}` | user | 否 |
| editComment | `PATCH /comments/{id}` | user | 是 |
| deleteComment | `DELETE /comments/{id}` | user | 是 |
| likePosts | `PUT /posts/{id}/like` | user | 是 |
| unlikePosts | `DELETE /posts/{id}/like` | user | 是 |
| likeComments | `PUT /comments/{id}/like` | user | 是 |
| unlikeComments | `DELETE /comments/{id}/like` | user | 是 |
| createReport | `POST /reports` | user | 否 |
| getOwnReport | `GET /reports/{id}` | user | 否 |
| listFavorites | `GET /favorites` | user | 否 |
| createFavorite | `POST /favorites` | user | 否 |
| deleteFavorite | `DELETE /favorites/{id}` | user | 是 |
| listHistory | `GET /history` | user | 否 |
| deleteHistory | `DELETE /history/{id}` | user | 是 |
| listMessages | `GET /messages` | user | 否 |
| getUnreadCount | `GET /messages/unread-count` | user | 否 |
| markMessageRead | `PUT /messages/{id}/read` | user | 是 |
| listAdminSources | `GET /admin/sources` | sources:read | 否 |
| createSourceDraft | `POST /admin/sources` | sources:write | 否 |
| getAdminSource | `GET /admin/sources/{id}` | sources:read | 否 |
| editSourceDraft | `PATCH /admin/sources/{id}` | sources:write | 是 |
| publishSource | `POST /admin/sources/{id}/publish` | sources:write | 是 |
| withdrawSource | `POST /admin/sources/{id}/withdraw` | sources:write | 是 |
| listAdminKnowledge | `GET /admin/knowledge` | sources:read | 否 |
| createKnowledgeDraft | `POST /admin/knowledge` | sources:write | 否 |
| getAdminKnowledge | `GET /admin/knowledge/{id}` | sources:read | 否 |
| editKnowledgeDraft | `PATCH /admin/knowledge/{id}` | sources:write | 是 |
| publishKnowledge | `POST /admin/knowledge/{id}/publish` | sources:write | 是 |
| withdrawKnowledge | `POST /admin/knowledge/{id}/withdraw` | sources:write | 是 |
| listAdminRegistration | `GET /admin/registrations` | sources:read | 否 |
| createRegistrationDraft | `POST /admin/registrations` | sources:write | 否 |
| getAdminRegistration | `GET /admin/registrations/{id}` | sources:read | 否 |
| editRegistrationDraft | `PATCH /admin/registrations/{id}` | sources:write | 是 |
| publishRegistration | `POST /admin/registrations/{id}/publish` | sources:write | 是 |
| withdrawRegistration | `POST /admin/registrations/{id}/withdraw` | sources:write | 是 |
| listAdminRestriction | `GET /admin/restrictions` | sources:read | 否 |
| createRestrictionDraft | `POST /admin/restrictions` | sources:write | 否 |
| getAdminRestriction | `GET /admin/restrictions/{id}` | sources:read | 否 |
| editRestrictionDraft | `PATCH /admin/restrictions/{id}` | sources:write | 是 |
| publishRestriction | `POST /admin/restrictions/{id}/publish` | sources:write | 是 |
| withdrawRestriction | `POST /admin/restrictions/{id}/withdraw` | sources:write | 是 |
| listAdminCategories | `GET /admin/categories` | sources:read | 否 |
| editCategory | `PATCH /admin/categories/{id}` | sources:write | 是 |
| listAdminUsers | `GET /admin/accounts` | accounts:read | 否 |
| suspendUser | `POST /admin/accounts/{id}/suspend` | accounts:suspend | 是 |
| listAdminJobs | `GET /admin/jobs` | jobs:read | 否 |
| cancelAdminJob | `POST /admin/jobs/{id}/cancel` | jobs:cancel | 是 |
| listFlags | `GET /admin/feature-flags` | flags:read | 否 |
| setFlag | `PUT /admin/feature-flags/{key}` | flags:write | 是 |
| hidePost | `POST /admin/posts/{id}/hide` | sources:write | 是 |
| listAuditEvents | `GET /admin/audit-events` | audit:read | 否 |
| grantCommunityMediaAccess | `POST /community/media-access` | user | 是 |
| readCommunityMediaContent | `GET /community/media/{grant_id}/content` | user | 否 |

## GY-I06 私有字节传输增补

这是原JSON授权契约的新增传输路径，既有Media/AccessGrant字段不变。参考媒体模块原先只生成示例URL，不能作为HTTP已实现证据；实现与迁移影响见[ADR](../../docs/architecture/adr-gy-i06-local-private-transport.md)。

| operationId | 方法与路径（前缀/api/v1） | 权限 | 版本 |
| --- | --- | --- | --- |
| receivePrivateMediaBytes | `PUT /media/uploads/{id}/content` | userSession＋header短效token | If-Match必需 |
| readOwnerMediaContent | `GET /media/{id}/content` | userSession＋header短效token | 当前媒体版本重新验证 |
