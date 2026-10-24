/**
 * Fastify 应用装配。
 *
 * 已装配（每个域的**唯一注册点**都在 `buildApp` 尾部，按 `register*` 调用逐条可核；路径均带 `API_PREFIX`）：
 * 运营 `/health`；游客主页科普预览 `/public/home`；认证 `/auth/**` 与后台认证 `/admin/auth/**`；
 * 授权 `/me/consents**`；个人档案与目录查询 `/me/profile`、`/catalog/{kind}`；
 * 资料查询 `/knowledge/**`、`/herbicides/**`（GY-I07）；识别 `/recognitions/**`（GY-I09）；
 * 标签 OCR `/ocr/**`（GY-I10）；转写 `/speech/transcriptions/**`（GY-I11）；合成 `/speech/synthesis`（GY-I13）；
 * 跨 kind 作业读／取消 `/jobs/{id}`、`/jobs/{id}/cancel`（GY-I01）；媒体 `/media/**`、
 * `/community/media-access`、`/community/media/{grant_id}/content`（GY-I06）；消息 `/messages/**`；
 * 收藏／历史 `/favorites/**`、`/history/**`（GY-I16）；注销 `/me/account/deletion`、
 * `/account/deletions/{id}`（GY-I19）；社区 `/posts/**`、`/comments/**`、`/reports/**`（GY-I15）；
 * 文字问答 `/conversations/**`（GY-I12）；后台 `/admin/**`。
 *
 * **未注册的路径没有兜底实现**：一律由 `setNotFoundHandler` 返回契约 `NOT_FOUND`（`未实现的路径：…`），
 * 不伪造成功。`real` 模式下缺持久依赖或未获显式批准的域**在触达该真实依赖的那一步 fail-closed**：
 * 依赖数据库／对象存储／真实供应商的路由如实返回 503 `PROVIDER_UNAVAILABLE`（实测：`/messages`、
 * `/favorites`、`/history`、`/conversations`、`/posts`、`/me/profile`、`/knowledge`、`/media/{id}`、
 * `/account/deletions/{id}`），既不 404 也不降级成内存替身；只跑在进程内 store 或静态种子上的路由照常
 * 作答（实测：`GET /herbicides` ⇒ 200；`GET /ocr/{id}`、`GET /speech/transcriptions/{id}`、
 * `GET /jobs/{id}` 对未知 id ⇒ 404「不存在」）。
 */
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { CONTRACT_VERSION } from './contract.ts';
import type { AppConfig, TrustProxyConfig } from './config.ts';
import { ApiError, buildErrorEnvelope, retryAfterSecondsFor } from './errors.ts';
import { createJsonSchema2020ValidatorCompiler, RUNTIME_AJV_CUSTOM_OPTIONS } from './schema-validator.ts';
import type { PgPool } from './db/pool.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerPublicHomeRoute } from './routes/public-home.ts';
import { registerUserAuthRoutes } from './routes/auth.ts';
import { registerAdminAuthRoutes } from './routes/admin-auth.ts';
import { registerConsentRoutes } from './routes/consents.ts'; import { registerExportRoutes } from './routes/exports.ts';
import { registerProfileRoutes } from './routes/profile.ts';
import { registerKnowledgeRoutes } from './routes/knowledge.ts';
import { registerRecognitionRoutes } from './routes/recognitions.ts';
import { registerSpeechRoutes } from './routes/speech.ts';
import { createJobRegistry } from './jobs/registry.ts';
import { createOcrJobSource, createRecognitionJobSource, createSynthesisJobSource, createTranscriptionJobSource } from './jobs/sources.ts';
import { registerJobRoutes } from './jobs/routes.ts';
import type { SpeechStore } from './speech/store.ts';
import type { SpeechProvider } from './speech/provider.ts';
import type { SpeechMediaPort } from './speech/media.ts';
import { registerOcrRoutes, type OcrRouteDeps } from './routes/ocr.ts';
import { createUnwiredOcrTerminalHistoryPort, type OcrTerminalHistoryInput, type OcrTerminalHistoryPort } from './ocr/service.ts';
import { createMemoryAuthStore, createPostgresAuthStore, type AuthStore, type SqlExecutor } from './auth/store.ts';
import { createMemoryIdempotencyStore, createPostgresIdempotencyStore, type IdempotencyStore } from './auth/idempotency.ts';
import { STUB_LOOKUP_KEY, createWechatIdentityProvider, type WechatIdentityProvider } from './auth/wechat.ts';
import { AuthService, STUB_IDEMPOTENCY_HMAC_KEY } from './auth/service.ts';
import { createAuthGuards } from './auth/middleware.ts';
import {
  createRecognitionService,
  createUnwiredRecognitionTerminalHistoryPort,
  type RecognitionService,
  type RecognitionTerminalHistoryInput,
  type RecognitionTerminalHistoryPort,
} from './recognitions/service.ts';
import { createRecognitionProvider, type RecognitionProvider } from './recognitions/provider.ts';
import { createRecognitionMediaPort, type RecognitionMediaPort } from './recognitions/media.ts';
import { createMemoryRecognitionStore, type RecognitionStore } from './recognitions/store.ts';
import { registerSynthesisRoutes } from './routes/synthesis.ts';
import { createCheckedContentPortFromConfig } from './ai/checked-content-live-adapter.ts';
import type { CheckedContentPort, SubstituteCheckedContentEntry } from './tts/content.ts';
import { createSynthesisMediaPort, type SynthesisMediaPort, type SynthesisMediaPortOptions } from './tts/media.ts';
import { createTtsProvider, type TtsProvider } from './tts/provider.ts';
import { createSynthesisService, type SynthesisService } from './tts/service.ts';
import { createMemorySynthesisStore, type SynthesisStore } from './tts/store.ts';
// GY-I18 后台域（阶段 2 装配）：路由 + 阶段 1／1b 两个已合并的服务。
import { registerAdminRoutes } from './routes/admin.ts';
import { createAdminContentService } from './admin/service.ts';
import type { AdminContentService, AdminContentServiceOptions } from './admin/service.ts';
import { createAdminOpsService } from './admin/ops/service.ts';
import type { AdminOpsService, AdminOpsServiceOptions } from './admin/ops/service.ts';
import { createPostgresAccountAuthority } from './admin/ops/account-authority-pg.ts';
// GY-I17（#17）系统事件：账号停用/恢复 → 消息域 `system` 消息（结构性端口，不 import 消息域）。
import { createMessagesAccountEventsPort, createUnwiredAccountEventsPort, withAccountSystemEvents, type AccountEventsPort } from './admin/ops/account-events.ts';
import { createPostgresAccountsDirectory } from './admin/ops/accounts-pg.ts';
import { createPostgresFeatureFlags, probeFeatureFlagsTable } from './admin/ops/flags-pg.ts';
import { restrictAdminOpsToAccountsAuthority } from './admin/ops/accounts-only.ts';
import { createPostgresAdminJobPort } from './admin/ops/jobs-pg.ts';
import { createAdminContentStore } from './admin/store.ts';
import { createAdminOpsStore } from './admin/ops/store.ts';
import { createAdminRuntime } from './admin/runtime.ts';
import { createFailClosedAdminServices } from './admin/fail-closed-services.ts';
import { createAdminAuditLogService } from './admin/audit/service.ts';
import type { AdminAuditLogService, AdminAuditLogServiceOptions } from './admin/audit/service.ts';
import { createPostgresAdminAuditLogPort } from './admin/audit/pg.ts';
import type { AdminAuditLogPort } from './admin/audit/pg.ts';
import { createReferenceIntegrity } from './admin/reference-integrity.ts';
import type { AdminCallContext } from './admin/types.ts';
// GY-I18 本片：全局开关的**跨端点真实生效**（受控输出面清单 + 守卫包装 + 投稿面装饰）。
import {
  createFeatureFlagGate,
  createFlagGatedGuards,
  createPortFlagReader,
  createStoreFlagReader,
  flagSeedFromBaseline,
  FLAG_WIRING_BASELINE,
  type FeatureFlagGate,
  type FlagReader,
  type PortFlagReader,
} from './admin/ops/flag-gate.ts';
// GY-I18 本片：人工评审入口**空态**（无假任务/审核人/投票/专家认证）。
import { createHumanReviewDirectory, type HumanReviewDirectory } from './admin/human-review.ts';
// GY-I06 私有媒体域（#6）：存储适配器 + 服务层 + 7 条 HTTP 路由的单一注册点。
import { registerMediaRoutes } from './routes/media.ts';
import { createAppMediaService, createFailClosedMediaService, type AppMediaService, type CommunityAttachmentCounter, type RealMediaWiringApproval } from './media/service.ts';
// GY-I06/W12 媒体持久化（#6）：登记册/授权/幂等台账的事实源从进程内 `Map` 换成端口；
// `object_ref_cipher` 的键由配置注入（`MEDIA_OBJECT_REF_KEY`），缺键则**不接 PG**。
import { createMemoryMediaStore, type MediaStore } from './media/store.ts';
import { createPostgresMediaStore } from './media/store-pg.ts';
import { createObjectRefCipher } from './media/object-ref-cipher.ts';
import { resolveMediaObjectStore, type MediaObjectStore } from './media/object-store.ts';
import { createClosedContentSource, type PublishedContentSource } from './media/content-source.ts';
// GY-I27 接线单：授权中间件与撤回/注销消费者的 HTTP/服务侧适配（协议层在 packages/privacy/**）。
import { createPostgresConsentGate, type ConsentGate } from './privacy/egress.ts';
import { createPostgresConsentService, type EgressRevoker } from './privacy/consent-pg.ts';
import { createPostgresExportLedger, createPostgresPrivacyPorts } from './privacy/ledger-pg.ts';
import { createChatEgress, createMediaJobEgress, type ChatEgress, type MediaJobEgress } from './privacy/task-egress.ts';
// GY-R28 W7（#12）：文字问答的真实模型适配器与装配决策（供应商细节只在这两个文件里）。
import { planConversationChat } from './ai/chat-wiring.ts';
import { createSynthesisEgress, type SynthesisEgress } from './privacy/synthesis-egress.ts';
import { createEgressRevoker, createInFlightGuard } from '../../../packages/privacy/in-flight.mjs';
import { registerMessageRoutes } from './routes/messages.ts';
import { createMessagesService, type MessagesService } from './messages/service.ts';
import { createMemoryMessagesStore, type MessagesStore } from './messages/store.ts';
import { createPostgresMessagesStore } from './messages/store-pg.ts';
import { type MessageReferencePort } from './messages/reference.ts';
import { createCommunityReferencePort, type CommunityPublicVisibility } from './messages/reference-community.ts';
// GY-I16 收藏与可浏览的识别历史（#16）：本片两个子域 + 注销删除接线（F13 协议复用）。
import { registerFavoriteRoutes } from './routes/favorites.ts';
import { registerHistoryRoutes } from './routes/history.ts';
import { createFavoritesService, type FavoritesService } from './favorites/service.ts';
import { createMemoryFavoritesStore, type FavoritesStore } from './favorites/store.ts';
// GY-I16 阶段 2：收藏/历史的 PG 实现（迁移 `0018_favorites_history.sql`，`persistent: true`）。
import { createPostgresFavoritesStore } from './favorites/store-pg.ts';
import { isFavoriteTargetType } from './favorites/types.ts';
import { createHistoryService, type HistoryService } from './history/service.ts';
import { createMemoryHistoryStore, type HistoryStore } from './history/store.ts';
import { createPostgresHistoryStore } from './history/store-pg.ts';
import { createWiredHistoryJobPort, createUnwiredHistoryJobPort, type HistoryJobPort } from './history/job.ts';
import { createHistoryCascadePort, type HistoryCascadePort } from './history/cascade-wiring.ts';
import { createWiredVisibilityPort, type VisibilityPort } from './targetref/visibility.ts';
import { createReferenceQueryService } from './knowledge/reference-query.ts';
import {
  createUnavailableBackupPurgePort,
  createUserDataDeletion,
  type BackupPurgePort,
  type OwnerPurgeStore,
  type UserDataDeletionRegistry,
} from './privacy/user-data-deletion.ts';
// GY-I19（#19）本片：逐用户备份副本域的**真实**清除端口（有真库时接线；无真库不静默退回内存/unwired）。
import { createPostgresBackupPurgePort } from './privacy/backup-copies-pg.ts';
import { createPostgresBackupStateReader, type BackupStateDerivationPort } from './privacy/backup-state-derivation.ts';
import { createPostgresOnlinePurgeEvidenceRecorder, type OnlinePurgeEvidenceRecorder } from './privacy/online-purge-evidence.ts';
import { createPostgresOnlineStateReader, type OnlineStateDerivationPort } from './privacy/online-state-derivation.ts';
// GY-I19（#19）决策包 A 第 2 步：契约里**已冻结**的注销/删除申请 HTTP 面接线
// （openapi.json 的 `requestAccountDeletion` / `getDeletionReceipt`）。
//   - 申请/回执**复用既有**删除机制（`userDataDeletion`，见上方 GY-I16 装配）与
//     `packages/privacy/deletion-modules.mjs::receipt()` 投影，**不新建第二套台账**；
//   - 幂等走既有 `runIdempotent()`（24h 台账）；回执 bearer 用既有 `mintOpaqueToken()`，
//     服务端只存 sha256 摘要；
//   - GY-I19 本片（#19）在其上追加**持久化受理**：有真库（`pool`）时 `userDataDeletion`
//     接线 `requests` 端口 ⇒ 受理在**同一事务**内落库（账号状态 + `auth_epoch` + 全会话撤销 +
//     注销请求），走窄口径 `SECURITY DEFINER` 函数，见 `privacy/deletion-requests-pg.ts`
//     与迁移 `services/api/db/migrations/0016_account_deletion_persistence.sql`
//     （**复用** 0003 已建的 `public.deletion_requests` 表，不新建第二套表）；
//   - `real` 模式**整域不接线**（本片红线）⇒ `available: false` ⇒ 两个 operation
//     一律 503 `PROVIDER_UNAVAILABLE`，**不**回 200 空壳、**不**假装删除成功。
import { registerAccountDeletionRoutes } from './routes/account-deletion.ts';
import {
  createAccountDeletionRequestService,
  createDeletionReceiptRegistry,
  RECEIPT_TTL_MS,
  type AccountDeletionRequestService,
  type DeletionReceiptRegistry,
} from './privacy/account-deletion.ts';
import {
  createPostgresDeletionRequestStore,
  type DeletionRequestStore,
} from './privacy/deletion-requests-pg.ts';
// GY-I15 社区域（#15）阶段 2：服务层 + 装配层接线（关联可用性端口、事件投递、下架观察器）。
import { registerCommunityRoutes } from './routes/community.ts';
import { createCommunityService, type CommunityService } from './community/service.ts';
import { createMemoryCommunityStore, type CommunityStore } from './community/store.ts';
import { createPostgresCommunityStore } from './community/store-pg.ts';
import { createLocalPseudonymousAuthorDirectory } from './community/authors.ts';
// #15 社区域注销保留/去身份端口：清社区行（F13 保留/脱敏/媒体）＋ 作者换随机注销引用。
import { createCommunityOwnerPurgePort } from './community/purge.ts';
import type { AuthorDirectory, KnowledgeTarget } from './community/types.ts';
// #15 S4（R33）：装配层**真的**构造资料可用性端口（此前只有 `import type` + 注入位）。
import {
  createKnowledgeAvailabilityPort,
  createUnwiredKnowledgeAvailabilityPort,
  type KnowledgeAvailabilityPort,
} from './community/knowledge.ts';
import {
  createMessagesCommunityEventsPort,
  createUnwiredCommunityEventsPort,
  type CommunityEventsPort,
} from './community/events.ts';
import { withTakedownObserver } from './community/takedown.ts';
// GY-I14 ⇄ GY-I15 联动接线（#14 + #15）：审核域 ⇄ 社区发布/编辑链 ⇄ 后台下架。
//   - `createCommunityContentAuthority`：审核域的**内容权威端口**接到社区那一份 store（同源）；
//   - `createCommunityModerationLink`：社区侧的**结构性**审核域端口（社区目录不 import 审核域实现）。
import { createCommunityContentAuthority } from './community/moderation-authority.ts';
import { createCommunityModerationLink, type CommunityModerationLink } from './community/moderation-link.ts';
import { IDEMPOTENCY_TTL_SECONDS } from './auth/idempotency.ts';
// GY-I14（#14）审核域：**追加式**装配（只加 import + 一个可选注入项 + 一处作业源注册 + 一处 decorate）。
// 跨线披露：本块为纯追加（不改既有域行为、不重排既有装配）；回退 = 删除本块四处。
import { createModerationService } from './moderation/service.ts';
import { createPostgresModerationLedger } from './moderation/ledger-pg.ts';
import type { ModerationService } from './moderation/service.ts';
import { createModerationJobSource } from './moderation/job-source.ts';
import type { ContentAuthorityPort } from './moderation/types.ts';
// GY-I12（#12）文字问答子域：**追加式**装配（只加 import + 一个可选注入项 + 一处 decorate
// + 一处作业源注册 + 一处路由注册 + 一处检索读面复用）。跨线披露：本块为纯追加
// （不改既有域行为、不重排既有装配）；回退 = 删除本块六处。
import { registerConversationRoutes } from './routes/conversations.ts';
import {
  createConversationGuard,
  createConversationService,
  createDeterministicAnswerComposer,
  createMemoryConversationIdempotencyLedger,
  createTranscriptionPort,
  type ConversationIdempotencyLedger,
  type ConversationService,
  type AnswerComposer,
  type TranscriptionPort,
} from './conversations/service.ts';
import { createModerationRiskScreen, type RiskScreen } from './conversations/screen.ts';
import {
  createMemoryConversationStore,
  type ConversationStore,
} from './conversations/store.ts';
import { createPostgresConversationStore } from './conversations/store-pg.ts';
import type { AnswerGuard, DoseAuthority, RetrievalPort } from './conversations/guard.ts';
import { createUnwiredRetrievalPort } from './conversations/guard.ts';
import { createKnowledgeService } from './knowledge/service.ts';
import { createDeterministicDoseAuthority } from './conversations/dose.ts';
import { createKnowledgeRetrievalPort } from './conversations/retrieval.ts';
import { createAnswerJobSource } from './conversations/job.ts';
import type { ConversationContextPort } from './conversations/context.ts';
import {
  createUnwiredTurnCascadePort,
  type TurnCascadePort,
} from './conversations/cascade.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /** 认证服务（供 server.ts 做管理员初始化与测试注入）。 */
    authService: AuthService;
    /** GY-I09 识别服务（供回归测试驱动在途任务与状态判定）。 */
    recognitionService: RecognitionService;
    /** GY-I13 合成服务（供回归测试核对默认关闭、幂等收敛与任务终态）。 */
    synthesisService: SynthesisService;
    /** GY-I18 阶段 1：后台资料生命周期服务（25 个 operationId）。 */
    adminContentService: AdminContentService;
    /** GY-I18 阶段 1b：后台运营与开关服务（9 个 operationId）。 */
    adminOpsService: AdminOpsService;
    /**
     * R34：库内审计日志只读查询服务（1 个 operationId：`listAuditLogs`）。
     * 与 `adminOpsService` 分开装配：审计**读面**的生命周期与运营**写面**不同
     * （读面只依赖迁移 0033 的只读函数，不依赖任何写权威）。
     */
    adminAuditLogService: AdminAuditLogService;
    /**
     * GY-I18 本片：全局开关门（跨端点真实生效）。供回归测试核对"关闭 ⇒ 拒绝且零产出"、
     * "不可识别 ⇒ fail-closed"与"开关不改变适用判定结论"。
     */
    featureFlagGate: FeatureFlagGate;
    /** GY-I18 本片：人工评审入口（**空态**：无任务/审核人/投票/专家认证，未接线）。 */
    humanReviewDirectory: HumanReviewDirectory;
    /** GY-I06 媒体域服务（7 个 operationId；供回归测试核对 real fail-closed 与孤立对象清理）。 */
    mediaService: AppMediaService;
    /**
     * GY-I06 媒体域的对象存储端口（**仅供测试**模拟「客户端直传对象存储」并断言孤立对象被回收）。
     * 生产读取路径不经此装饰直接暴露给客户端，绝不进入任何响应投影。
     */
    mediaObjectStore: MediaObjectStore;
    /** Non-real message service; real remains closed until persistent storage is delivered. */
    messagesService: MessagesService | null;
    /** GY-I14 审核域服务（供回归测试驱动版本级任务、回调 seam 与可见性重查）。 */
    moderationService: ModerationService;
    /**
    /**
     * GY-I16 收藏服务；`real` 模式下为 `null`（内存存储不冒充持久化 ⇒ 三条路由 503）。
     * 也供回归测试驱动。
     */
    favoritesService: FavoritesService | null;
    /**
     * GY-I16 历史服务；`real` 模式下为 `null`（同上）。
     * **内部创建口** `historyService.appendHistory(...)` 供识别/OCR 域后续一行接线调用。
     */
    historyService: HistoryService | null;
    /**
     * GY-I16 注销删除接线：`favorites`/`history` 两个模块注册在**已合并的**
     * `packages/privacy` 删除注册协议上（不另起一套）。供回归测试与后续 GY-I19 接线驱动。
     */
    userDataDeletion: UserDataDeletionRegistry;
    /**
     * GY-I19（#19）本片：注销申请服务（`POST /me/account/deletion` 的唯一实现）。
     * **装配透明性/回归取证**用：`available === false`（`real` 模式）时路由整域 503，
     * 此装饰只如实反映装配结果，不参与鉴权判定。
     */
    accountDeletion: AccountDeletionRequestService;
    /** GY-I19（#19）本片：回执 bearer 台账（只存 sha256 摘要；取证用，不暴露明文）。 */
    deletionReceipts: DeletionReceiptRegistry;
    /**
     * GY-I15 社区服务（#15）。**未接线**（`real` 模式：真实持久存储未交付）
     * 时为 `null` ⇒ 16 条社区路由一律 503 `PROVIDER_UNAVAILABLE`，不返回空页、不假成功。
     */
    communityService: CommunityService | null;
  /**
   * **GY-I14 ⇄ GY-I15 联动接线**（#14 + #15）：社区侧的审核域联动端口；`real` 下社区服务为
   * `null`（整域 503），此端口也随之不可用（审核域在 real 下整域 fail-closed）。
   * 仅作装配透明性与**证据/回归**用；业务判定只在服务层内部发生。
   */
  communityModerationLink: CommunityModerationLink | null;
  /**
   * GY-I12 文字问答子域（#12）。**未接线**时为 `null`（`real` 模式下缺签名密钥或存储未就绪）
   * ⇒ 七条问答路由一律 503 `PROVIDER_UNAVAILABLE`（retryable），不返回空页、不假成功。
   */
  conversationService: ConversationService | null;
  }
}

export interface BuildAppOptions {
  /** Test injection only; server.ts never enables synthetic policy publication. */
  consentGrantTestOptions?: { allowSyntheticGrantPolicy?: boolean };
  config: AppConfig;
  pool?: PgPool | null;
  /** 可注入时钟，便于确定性回归。 */
  now?: () => Date;
  /** 测试注入：替换会话存储（默认按 pool 选择内存/持久化实现）。 */
  store?: AuthStore;
  /** 测试注入：替换幂等台账。 */
  idempotency?: IdempotencyStore;
  /** 测试注入：替换微信身份提供者（默认按 executionMode 选择 real/stub）。 */
  wechat?: WechatIdentityProvider;
  /** 测试注入：替换识别存储（默认进程内内存 store；本片无持久化实现）。 */
  recognitionStore?: RecognitionStore;
  /** 测试注入：替换识别提供者（默认按 executionMode 选择 real/替身）。 */
  recognitionProvider?: RecognitionProvider;
  /** 测试注入：替换媒体引用端口（默认 real=未接线 fail-closed，其余=明确标注的替身）。 */
  recognitionMedia?: RecognitionMediaPort;
  /** 任务截止时间（毫秒），测试可缩短以真实观测 timed_out。 */
  recognitionJobDeadlineMs?: number;
  // GY-I11 转写域注入项（形状与上面识别域的同名项一致）。**全部可选**：
  // 不传时与注入前**逐字节同行为**——存储用内存实现、提供者与媒体端口按 executionMode 自建、
  // 截止时间取服务层默认；即默认装配路径仍成立「零端口注入」。
  /** 测试注入：替换转写存储（默认进程内内存 store；本片无持久化实现）。 */
  speechStore?: SpeechStore;
  /** 测试注入：替换 ASR 提供者（默认按 executionMode 选择 real/替身）。 */
  speechProvider?: SpeechProvider;
  /** 测试注入：替换媒体引用端口（默认 real=未接线 fail-closed，其余=明确标注的替身）。 */
  speechMedia?: SpeechMediaPort;
  /** 转写任务截止时间（毫秒），测试可缩短以真实观测 timed_out。 */
  speechJobDeadlineMs?: number;
  /** 测试注入：替换合成存储（默认进程内内存 store；本片无持久化实现）。 */
  synthesisStore?: SynthesisStore;
  /** 测试注入：替换合成提供者（默认按 executionMode 选择 real/替身）。 */
  synthesisProvider?: TtsProvider;
  /** 测试注入：替换合成产物存储端口（默认 real=未接线 fail-closed，其余=明确标注的替身）；`synthesisMediaWiring` = 合成产物真实存储的**显式注入**（批准能力＋`s3_compatible` 端口；装配层只转发、绝不铸造、不读 env，见 `tts/media.ts` 的 `SynthesisMediaPortOptions`）。 */
  synthesisMedia?: SynthesisMediaPort; synthesisMediaWiring?: SynthesisMediaPortOptions;
  /**
   * 测试注入：替换「已核对内容」读取端口（默认按 executionMode；`stub`/`preset_demo` 下为
   * **带明确标注替身条目**的内存源 `SYNTHESIS_SUBSTITUTE_CHECKED_CONTENT`，`real` 下为未接线端口）。
   */
  synthesisContent?: CheckedContentPort;
  /** 合成任务截止时间（毫秒），测试可缩短以真实观测 timed_out。 */
  synthesisJobDeadlineMs?: number;
  // GY-R31 媒体端口注入（OCR 域；识别/语音域的同形注入项见上方 `recognitionMedia` / `speechMedia`）。
  // **可选**：不传时与注入前**逐字节同行为**——`real` 下仍是未接线 fail-closed 端口，其余模式仍是
  // 明确标注的替身；即「默认装配不注入任何端口」这一条不变（槽位缺省 undefined ⇒ 由域内按
  // `config.executionMode` 自建）。类型取自 `routes/ocr.ts` 的依赖表，装配层**不** import 该域的
  // 适配器模块（`tests/integration/ocr-http.mjs` 的 import 禁项逐字保持）。
  /** 测试注入：替换 OCR 域媒体引用端口（默认 real=未接线 fail-closed，其余=明确标注的替身）。 */
  ocrMedia?: OcrRouteDeps['media'];
  // GY-I18 后台域注入项。**全部可选**：不传时自建空种子内存 store ——
  // 内容/运营存储为空种子；`AdminJobPort` **仍缺省未接线** ⇒ 作业读/取消按服务层 fail-closed
  // 返回 503（不返回空页、不伪造状态）；**社区帖子端口已接线**（下方 `communityPostPortForAdmin`，
  // 与社区服务**同一份** store）⇒ `hidePost` 按社区 CAS 语义如实作答（未知帖子 404、成功 200、
  // 已删除/未发布 409）；缺省装配下不是 503 —— 只有显式传入未接线端口、或适配器返回清单外的未知
  // 原因时，服务层才走同一 503 兜底。
  /** 测试注入：后台资料存储（默认新建内存 store）。 */
  adminInjection?: {
    contentStore?: AdminContentServiceOptions['store'];
    opsStore?: AdminOpsServiceOptions['store'];
    jobPort?: AdminOpsServiceOptions['jobPort'];
    communityStore?: AdminOpsServiceOptions['community'];
    /** 注入 flag 语义分类表：用于验证"含放宽语义 ⇒ 拒绝接线"（默认出厂表）。 */
    flagEffects?: AdminOpsServiceOptions['flagEffects'];
    /**
     * 真实账号写权威（GY-I22）：不传时 `real` 下按 `pool !== null` 自建
     * `createPostgresAccountAuthority({ pool })`；`pool === null` ⇒ 账号停用面继续整域 503。
     */
    accountAuthority?: AdminOpsServiceOptions['accountAuthority'];
    /**
     * 真实开关读写端口（GY-I18）：不传时 `real` 且 `pool !== null` 按
     * `createPostgresFeatureFlags({ pool })` 自建；`pool === null` ⇒ 开关面继续 503、开关门不武装。
     * 注入优先（测试用它钉住"注入端口才接线"，不依赖真实库）。
     */
    flagsPort?: AdminOpsServiceOptions['flagsPort'];
    /**
     * 真实审计日志读端口（R34）：不传时 `real` 且 `pool !== null` 按
     * `createPostgresAdminAuditLogPort({ pool })` 自建；`pool === null` ⇒ `/admin/audit-logs`
     * 保持 503（⛔ 不返回空页）。注入优先（测试用它钉住接线点，不依赖真实库）。
     */
    auditLogPort?: AdminAuditLogServiceOptions['port'];
  };
  // GY-I06 媒体域注入项（**全部可选**）：不传时按 executionMode 自建 ——
  // `real` ⇒ **未接线 fail-closed**（整域 503；**含 ambient env 里 `OBJECT_STORAGE_*` 齐备**：
  // 装配层不把 `process.env` 交给解析器，真实适配器只能经下面的显式注入开启），
  // `stub`/`preset_demo` ⇒ 明确标注的替身。
  /** 测试注入：替换对象存储端口（**这也是真实适配器的唯一开启方式**；默认 real=fail-closed 未接线，其余=明确标注的替身）。 */
  mediaObjectStore?: MediaObjectStore;
  /**
   * **真实媒体接线的显式批准能力**（r3 运行期构造期主闸门；`approveRealMediaWiring()` 铸造，
   * non-defaultable）。`real` 下**必须**与 `mediaObjectStore` 同时给出才可能走真实分支。
   * 装配层**绝不自行铸造**、也不从 env／原型链／全局对象派生 —— 只把调用方给出的能力对象转发给
   * `createAppMediaService`（见 `media/service.ts` 的闸门说明）。
   */
  realMediaApproval?: RealMediaWiringApproval;
  /** 测试注入：替换公开内容来源（默认为**关闭**：社区取图统一 404，不误放行）。 */
  mediaContentSource?: PublishedContentSource;
  /** 测试注入：替换「每帖 ≤3 图」槽位计数器（默认 real=未接线拒绝，其余=保守替身）。 */
  mediaAttachmentCounter?: CommunityAttachmentCounter;
  /**
   * 测试注入：替换媒体的**持久化端口**（登记册 / 短效授权 / 幂等台账三者的事实源）。
   *
   * 不传时按 `executionMode` 二分：`real` + 连接池 + `MEDIA_OBJECT_REF_KEY` ⇒ PG 实现
   * （重启后上传链路不断），其余 ⇒ 内存实现（stub/演示/无库夹具，语义与 W12 之前等价）。
   */
  mediaStore?: MediaStore;
  // GY-I27 接线单（用途授权接线）：隐私域端口。
  // **全部可选**：不传时——
  //   * 授权中间件仍会在**配置了数据库**时按 PG 读取口挂到 4 个 AI 执行入口
  //     （`/recognitions`、`/speech/transcriptions`、`/ocr`、`/speech/synthesis`）；
  //     无数据库（本地 stub/回环测试）⇒ 不挂，行为与接线前逐字相同；
  //   * 撤回/注销消费者不注入 ⇒ `consent-pg`/`grant-pg` 保持既有 `OBJECT_UNAVAILABLE` 兜底。
  privacyInjection?: {
    /** 授权中间件端口（覆盖默认解析）：仅测试或已核验的读取口需要显式注入。 */
    consent?: ConsentGate;
    /** 撤回/注销消费者：注入后 `consent-pg`/`grant-pg` 在撤回/授予时**先撤销在途外发**。 */
    egressRevoker?: EgressRevoker;
  };
  /** Synthetic tests only; these memory/reference injections do not enable the real-mode domain. */
  messagesInjection?: { store?: MessagesStore; reference?: MessageReferencePort };
  // GY-I14（#14）审核域注入项（**全部可选**，纯追加）：
  //   - 不传时按 executionMode 自建 —— `real` ⇒ **整域 fail-closed**（每次送审/发布/下架/读取/回调
  //     都以契约 503 `PROVIDER_UNAVAILABLE`（`retryable`）如实拒绝，**绝不用内存/替身返回成功封套**）；
  //     其余模式 ⇒ 明确标注的**替身**端口（替身一律回报"无结论"⇒ 隔离，不会放行任何内容）。
  //   - `service` 供回归测试注入已建好的审核域（含内存台账）以驱动版本级任务与回调 seam。
  moderationInjection?: {
    service?: ModerationService;
    ports?: { tms?: unknown; ims?: unknown };
    authority?: ContentAuthorityPort;
    callbackKey?: string;
    // 规则层选项（**可选**，只供回归测试注入冻结时钟）。不传 ⇒ `createModerationService`
    // 内部沿用默认口径（真实 `Date.now` + 默认 50ms 预算，超时 ⇒ 隔离），与不传该字段等价。
    ruleOptions?: Record<string, unknown>;
  };
  // GY-I16 收藏（#16）注入项。**全部可选**：不传时——收藏域新建内存 store；引用可用性端口
  // **已于 #167 接线**（缺省即同文件 `defaultVisibility`：`createWiredVisibilityPort`，可用性按
  // `/knowledge` 公开读面**每次读取重新派生**，核不到即 `unavailable`，绝不假装可用）；
  // real 模式下整域关闭。
  favoritesInjection?: {
    store?: FavoritesStore;
    visibility?: VisibilityPort;
  };
  // GY-I16 历史（#16）注入项。**全部可选**：不传时——历史域新建内存 store；引用可用性端口
  // **已于 #167 接线**（缺省即同文件 `defaultVisibility`：`createWiredVisibilityPort`，可用性按
  // `/knowledge` 公开读面**每次读取重新派生**，核不到即 `unavailable`）；
  // **任务状态端口默认接线到已合并的公开读取口**（`recognitionService.getJob` /
  // `ocrService.getJob`）⇒ 读取时能拿到真实任务状态（失败/超时/取消原样可见）；
  // 关联删除级联端口未接线（如实回 `unwired`，不谎称已启动）。
  historyInjection?: {
    store?: HistoryStore;
    visibility?: VisibilityPort;
    job?: HistoryJobPort;
    cascade?: HistoryCascadePort;
  };
  /**
   * GY-I16 注销删除注入项：备份副本清除端口（缺省未接线 ⇒ `backupState: 'pending'`，不谎称完成）。
   * GY-I19（#19）追加 `requests`：持久化受理端口的注入点（缺省＝按是否有真库自动装配；
   * 显式传入用于**故障注入**——例如让第 ③ 步 INSERT 撞回执摘要唯一索引，
   * 以实测「同一事务整体回滚、旧 token 不复活」这条安全性质）。
   */
  userDataDeletionInjection?: {
    backupPurge?: BackupPurgePort;
    requests?: DeletionRequestStore | null;
    /**
     * GY-R28 W6（G5/G11）：回执备份态的**只读推导端口**注入（测试与故障注入用）。
     * 缺省按「真库 + 受理已接线」自动装配，见下方 `backupStatesWiring`。
     */
    backupStates?: BackupStateDerivationPort;
    /**
     * GY-R32（#19 片B）：在线证据落库端口注入（测试与故障注入用）。
     * 缺省按「真库 + 受理已接线」自动装配，见下方 `onlineEvidenceWiring`。
     */
    onlineEvidence?: OnlinePurgeEvidenceRecorder;
    /**
     * GY-R32（#19 片B）：回执在线态的**只读推导端口**注入。
     * 缺省按「真库 + 受理已接线」自动装配，见下方 `onlineStatesWiring`。
     */
    onlineStates?: OnlineStateDerivationPort;
  };
  // GY-I15 社区域注入项（阶段 2 装配）。**全部可选**：不传时——
  //   * 存储用空的进程内内存 store（`real` 模式下整域 503，见下）；
  //   * 作者投影用**明确标注的本地假名投影**（不是真实 `public_authors`）；
  //   * 「杂草／药剂关联」可用性端口**已于 #15 S4（R33）接线**：有 `pool` ⇒ 用同一条 `pool` 查
  //     公开读视图 `catalog_read.current_knowledge`（见下方 `communityKnowledge`）；无 `pool`
  //     （没配 `DATABASE_URL`）⇒ 仍是**未接线**端口 ⇒ 新增/替换引用一律 409 `OBJECT_UNAVAILABLE`；
  //   * 事件端口接到本进程的消息服务公开创建口；消息服务为 null（real）时端口 `wired:false`。
  communityInjection?: {
    store?: CommunityStore;
    authors?: AuthorDirectory;
    /** 显式注入优先（测试钉住接线点 / 故障注入用）；缺省按有没有 `pool` 二分，见 `communityKnowledge`。 */
    knowledge?: KnowledgeAvailabilityPort;
    events?: CommunityEventsPort;
    /** 测试注入：替换发布闸门（默认出厂规则集；注入自定义规则集会真实改变派生 `rule_version`）。 */
    gate?: Parameters<typeof createCommunityService>[0]['gate'];
    /**
     * **GY-I14 ⇄ GY-I15 联动接线**：测试可注入自己的审核域联动端口；传 `null` 显式**关闭**联动
     * （回到接线前行为，用于"接线确实改变了行为"的对照与反例）。
     */
    moderation?: CommunityModerationLink | null;
  };
  /**
   * **仅测试注入**：日志输出的写入目标，用于断言「日志不含坐标等敏感原文」。生产装配
   * （`services/api/src/server.ts`）**永不传入**；不传时日志仍写进程 stdout，级别、格式与
   * 目标逐字节保持接线前行为（只多一条 `serializers.req`，见 `requestLogFields`）。
   */
  logStream?: { write(chunk: string): void };
  // GY-I12 文字问答子域注入项（#12）。**全部可选**：不传时——
  //   * `store`：非 real 模式用进程内内存 store（显式级联删除），**real 模式用 PG store**
  //     （`pool === null` ⇒ real 下整域 503，绝不用内存 store 在真实模式下声称成功）；
  //   * `retrieval`：接线到**与 `/knowledge` 同一个**读面实例（视图 + 同一模式门 + 同一
  //     `APP_KNOWLEDGE_UNVERIFIED_SEED` 开关 + 同一会话校验），不新建第二套资料读服务；
  //   * `dose`：接线到 GY-I08 的确定性描述子 `doseCardDescriptor`（本片唯一权威路径）；
  //   * `guard`/`composer`：确定性守卫与确定性回答器（**没有语言模型**）；`composer` 的注入
  //     口是**负控制**用的：回答器**无法**决定 `model_version`/`prompt_version`（那三个版本串
  //     只由服务层常量填充），所以替身不可能把自己标成真实模型；
  //   * `transcription`：语音轮次的转写核对端口（缺省复用 `app.speechService.getTranscription`）。
  conversationInjection?: {
    store?: ConversationStore;
    ledger?: ConversationIdempotencyLedger;
    retrieval?: RetrievalPort;
    dose?: DoseAuthority;
    guard?: AnswerGuard;
    composer?: AnswerComposer;
    /**
     * 问题与资料原文的风险/注入筛查（缺省接 `packages/moderation` 的
     * `dangerous_usage` + `prompt_injection` 规则层；注入只供负控制，不改默认行为）。
     */
    riskScreen?: RiskScreen;
    transcription?: TranscriptionPort;
    cascade?: TurnCascadePort;
    /**
     * 追问上下文端口（缺省由服务层自建：`createStoreConversationContext(store)`，只读本会话 +
     * 本主体的最近若干轮）。注入口只用于负控制：断言"上下文读失败 ⇒ 轮次显式 failed"，
     * 以及断言上下文**不**跨会话、**不**扩引用集合。
     */
    context?: ConversationContextPort;
  };
}

/** 把 pg 连接池适配为认证层的 SqlExecutor（只暴露 query）。 */
function createSqlExecutor(pool: PgPool): SqlExecutor {
  const run = pool.query.bind(pool) as unknown as (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
  return {
    query: async (text: string, values?: unknown[]) => {
      const result = await run(text, values);
      return { rows: result.rows };
    },
  };
}

/** 请求日志字段（默认 `serializers.req` 的子集，去掉一切原文风险）。 */
type RequestLogFields = {
  method?: string;
  url?: string;
  host?: string;
  remoteAddress?: string;
  remotePort?: number;
};

/** 高精度小数（经纬度形态）：出现在路径里也不落原文。 */
const COORDINATE_LIKE = /-?\d{1,3}\.\d{4,}/;

/**
 * 日志安全路径（GY-I05「服务端不接收原始坐标」的**日志侧**）：只返回不含查询串/片段（`?`／`#`）
 * 的**站内相对路径**；任何解析不出的形态返回 `null`，由调用方 fail-closed 丢弃整段原文：
 *   - 非字符串 / 空串 / 不以单个 `/` 开头（绝对 URL、协议相对 URL `//host/...`、`host/path` 形态）；
 *   - 含 `://`（代理可能转发 absolute-form 请求行，其中可能夹带查询串）；
 *   - 路径含高精度小数（坐标形态）。
 *
 * 之所以不用「参数名黑名单」：黑名单能被任意改名绕过，而查询串的值**任何一段都可能是坐标**
 * （见 `packages/privacy/redact.mjs` 的日志硬红线），所以整条查询串一律不落。
 */
export function logSafePath(url: unknown): string | null {
  if (typeof url !== 'string' || url === '' || !url.startsWith('/') || url.startsWith('//') || url.includes('://')) {
    return null;
  }
  const end = url.search(/[?#]/);
  const path = end === -1 ? url : url.slice(0, end);
  return COORDINATE_LIKE.test(path) ? null : path;
}

/**
 * 请求日志序列化器：只输出 method 与日志安全路径（外加 host / 远端地址这类不含请求内容的值）。
 * 代替 Fastify 默认序列化器——后者会把**含查询串的原始 URL** 逐字写进日志，等于把被拒的坐标落盘。
 * 与默认行为的差别仅此一项；解析不出安全路径时只落 method，不落任何原文。
 */
export function requestLogFields(request: unknown): RequestLogFields {
  const source = (request ?? {}) as {
    method?: unknown; url?: unknown; host?: unknown; ip?: unknown; socket?: { remotePort?: unknown };
  };
  const fields: RequestLogFields = {};
  if (typeof source.method === 'string' && source.method !== '') fields.method = source.method;
  const path = logSafePath(source.url);
  if (path !== null) fields.url = path;
  if (typeof source.host === 'string' && source.host !== '') fields.host = source.host;
  if (typeof source.ip === 'string' && source.ip !== '') fields.remoteAddress = source.ip;
  if (typeof source.socket?.remotePort === 'number') fields.remotePort = source.socket.remotePort;
  return fields;
}

/**
 * **GY-I14 ⇄ GY-I15 联动接线（后台下架 ⇄ 审核域）**：包装后台 `hidePost`。
 *
 * 纪律（与 `community/takedown.ts` 的下架观察器同口径）：
 *   - 后台下架的**权威写入仍在社区 store 的 CAS 里**；本层**不**复制可见性判定、
 *     **不**改错误映射、**不**改响应形状；
 *   - 本层只做一件事：CAS **成功返回之后**调用审核域 `withdraw`，从而
 *     1. 失效审核域对该目标**全部 revision** 的读缓存（`invalidated_cache_keys`）；
 *     2. 在审核域台账打**永久 withdrawn 标记** ⇒ 该版本此后不得再被发布/复活。
 *   - 处置**已经生效**：审核域不可用时**不回滚**一次已生效的合规处置，而是如实抛
 *     契约 503（`retryable`）——重试是幂等的（后台的 `changed:false` 路径不重复处置）。
 *   - `target_ref.revision` 取**处置前**的版本（后台隐藏会把 revision +1），
 *     因为被公开发布、也是缓存里被记住的就是那一版。
 */
function withModerationTakedownLink(
  ops: AdminOpsService,
  deps: {
    link: CommunityModerationLink;
    posts: AdminOpsServiceOptions['community'];
    reason?: string;
  },
): AdminOpsService {
  const reason = deps.reason ?? 'admin_hide';
  return {
    ...ops,
    async hidePost(ctx: AdminCallContext, id: string, body: unknown) {
      const before = deps.posts === undefined ? null : await deps.posts.getPost(id);
      const response = await ops.hidePost(ctx, id, body);
      const targetRef = { type: 'post' as const, id, revision: before === null ? 1 : before.revision };
      try {
        await deps.link.withdraw({
          // 主体来自**真实后台会话**（路由已强制 admin + `sources:write`）；客户端不可自述。
          actor: { userId: ctx.identity.userId, role: 'admin', authEpoch: ctx.identity.authEpoch },
          target_ref: targetRef,
          reason_code: reason,
        });
      } catch (error) {
        // 真瞬时（端口自己声明可重试）原样上抛，保留端口给出的结论。
        if (error instanceof ApiError && error.retryable) throw error;
        // 走到这里只剩三类：确定性缺陷／能力未接线（端口 fail-closed 形状不可用）／无法归类。
        // 同一请求在无运维介入下稍后重试都不会成功 ⇒ retryable 必须为 false。
        // 口径原文见 services/api/src/errors.ts 的 ApiError 注释。
        throw new ApiError(
          'PROVIDER_UNAVAILABLE',
          '后台下架已生效，但审核域缓存失效未完成（fail-closed；需先排查审核域端口或缺陷，重试同一请求不会自行恢复）',
          { retryable: false },
        );
      }
      return response;
    },
  };
}

/**
 * `catalog_read.current_knowledge` 的判定用最小投影（GY-I16 引用可用性接线）。
 *
 * 用类型别名而不是 `interface`：`pg` 的 `query<Row>()` 要求 `Row extends QueryResultRow`
 * （索引签名），对象字面量别名才有隐式索引签名（与 `db/catalog.ts` 的既有写法一致）。
 */
type PublicKnowledgeReadRow = { id: string; revision: number; type: string };
/**
 * 社区关联读取口（#15 S4）用的最小投影：比 `PublicKnowledgeReadRow` 多取 `title`（关联摘要只
 * 允许 `title`）与 `source_kind`（端口要拒绝模拟来源）。视图自身已只含「已发布 + 已核对 + 当前生效」。
 */
type CommunityKnowledgeReadRow = { id: string; revision: number; type: string; title: string; source_kind: string };

/**
 * GY-I13 缩片（合成 → 播放 · 受理链路打通）：`stub`/`preset_demo` 下注入的**替身核对条目**。
 *
 * 边界（逐条刻意收窄，见 `.pg17/ruling-451-narrow-scope.md`）：
 * - **只在替身模式生效**：`createCheckedContentPort(executionMode, entries)` 对 `real` **忽略** `entries`，
 *   一律返回未接线端口（`tts/content.ts:105-110`）⇒ real 仍 fail-closed，不因本条目放宽 ✗；
 * - **不改任何服务端语义**：条目只是「已核对内容读取端口」的数据；`decideCheckedContent` 的
 *   归属/核对状态/revision/正文判定与拒绝码**完全未改**（`tts/state.ts`），TTS 提供者与产物端口未改；
 * - **与客户端替身样本是同一对值**：id/revision/正文必须与 `miniprogram/utils/voice-api.js` 的
 *   `SUBSTITUTE_SPEAK_SAMPLES[0].targetRef` 与其 `checkedText` 逐字一致；该配对由回归用例锁定
 *   （`tests/unit/miniprogram-voice-playback.test.mjs` 直接比对本常量与客户端夹具）。
 * - 条目**明确标注为替身**：非真实资料库、非真实核对结论、不构成任何用药建议；正文是**非音频**文本
 *   （音频出口的缺口见 `ruling-451` §三：契约没有面向客户端的音频出口）。
 */
export const SYNTHESIS_SUBSTITUTE_CHECKED_CONTENT: readonly SubstituteCheckedContentEntry[] = [
  {
    type: 'answer',
    id: 'sample-i13-passed',
    revision: 1,
    auditState: 'approved',
    // 与客户端替身样本逐字一致（含标点与空格），不得改写、不得归一化。
    text: '稗草苗后茎叶处理：每亩用 30 毫升，兑水 30 升常规喷雾。'
      + '不得在高温时段施药，不要与碱性药剂混用；安全间隔期 14 天。',
  },
];

/** 构建已装配的 Fastify 实例（未监听端口，便于测试用 app.inject）。 */
export function buildApp({ config, pool = null, now, store, idempotency, wechat, consentGrantTestOptions, recognitionStore, recognitionProvider, recognitionMedia, recognitionJobDeadlineMs, speechStore, speechProvider, speechMedia, speechJobDeadlineMs, synthesisStore, synthesisProvider, synthesisMedia, synthesisMediaWiring, synthesisContent, synthesisJobDeadlineMs, ocrMedia, adminInjection, mediaObjectStore: mediaObjectStoreOption, mediaContentSource, mediaAttachmentCounter, mediaStore: mediaStoreOption, realMediaApproval: mediaRealApprovalOption, privacyInjection, messagesInjection, moderationInjection, favoritesInjection, historyInjection, userDataDeletionInjection, communityInjection, conversationInjection, logStream }: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    // 日志是**共享出口**：请求日志发生在路由与 schema 校验之前，路由层拒绝（400）救不回已经
    // 写下的日志，因此坐标不进日志必须在这里做（见 `requestLogFields`）。
    logger: config.logLevel === 'silent' ? false : {
      level: config.logLevel,
      serializers: { req: requestLogFields },
      // 仅测试注入；不传时逐字节保持默认行为（写进程 stdout，不新建文件、不改级别与格式）。
      ...(logStream === undefined ? {} : { stream: logStream }),
    },
    genReqId: () => randomUUID(), trustProxy: trustProxyOption(config.trustProxy ?? false),
    // 契约 WechatLoginInput / AdminLoginInput 为 additionalProperties:false；
    // Fastify 默认 removeAdditional:true 会静默剔除多余字段，这里改为拒绝，
    // 以确保「客户端不可指定 openid / 角色 / 用户 id」在 API 层被显式拦下（400）。
    // GY-I02：选项常量与下方的 2020-12 校验器**共用一份**（`schema-validator.ts`），
    // 换方言不换校验口径。
    ajv: { customOptions: RUNTIME_AJV_CUSTOM_OPTIONS },
  });

  // GY-I02（#2）：运行时校验器切到契约声明的 dialect——JSON Schema **2020-12**（`Ajv2020`）。
  //
  // 改前 Fastify 走默认 `@fastify/ajv-compiler`（`ajv` 的 draft-07 入口）：2020-12 专有关键字
  // （`prefixItems`、`$dynamicRef`、`unevaluatedProperties`…）要么编译报错，要么被静默忽略后放行请求。
  // 必须在**任何路由注册之前**设置：Fastify 在 `ready()` 时按此编译器编译全部路由 schema。
  // 逐项对照见 `./schema-validator.ts` 与 `tests/unit/openapi-2020-fastify-adapter.test.mjs`。
  app.setValidatorCompiler(createJsonSchema2020ValidatorCompiler());

  // GY-I16（#16；Refs #7）真机阻断缺陷修复：**空请求体的写请求按「无请求体」处理**。
  //
  // 现象：微信 `wx.request` 默认注入 `content-type: application/json`，而取消收藏的
  // `DELETE /api/v1/favorites/{id}` **没有请求体**。Fastify 对 `bodywith` 方法
  // （DELETE/POST/PUT/PATCH/OPTIONS）**只凭该头**就进 JSON 解析器
  // （`node_modules/fastify/lib/handle-request.js`），空体被判 `FST_ERR_CTP_EMPTY_JSON_BODY`
  // ⇒ 被下方错误处理器映射成 400 `INVALID_REQUEST`「请求体格式错误」。
  // 该 400 发生在**路由、鉴权与 schema 校验之前**（真机日志 0.5737 ms 返回、`connection: close`），
  // 因此真机上「取消收藏」100% 失败，且连 401/428/409 都被它遮住；同类无体写请求
  // （history/community/identify 的 DELETE、无体 POST）一并被拒——是**整类**而不是收藏单点。
  //
  // 修法：与 Fastify 自身 `isEmptyBody`（`lib/handle-request.js`）**同口径**判定"确无请求体"
  // （无 `transfer-encoding`，且 `content-length` 缺失或为 `0`）：此时请求声明的 JSON 内容类型
  // 没有可解析的体，摘掉该声明让请求走 Fastify 的"无体"分支（与客户端根本没发这个头**逐字一致**），
  // 而不是进解析器。**不替换**默认 JSON 解析器：非空体仍由 Fastify 默认解析器
  // （`secure-json-parse`，含防原型/构造器污染）处理，非法 JSON 仍照旧 400。
  //
  // **不放宽任何校验**：鉴权（401）、`If-Match` 必填（428）、版本比对（409）、
  // `Idempotency-Key` 要求、归属与非本人同形 404 全部照常执行；声明了 `schema.body` 的路由
  // 遇到空体仍被 schema 拒绝（400 `INVALID_REQUEST`，语义比"请求体格式错误"更准）。
  // 边界（如实记录）：`transfer-encoding: chunked` 的空体不在此列（无法在解析前确知为空），
  // 微信 `wx.request` 的无体请求不发该头。
  app.addHook('onRequest', (request, _reply, done) => {
    const headers = request.headers;
    if (
      headers['content-type'] !== undefined &&
      headers['transfer-encoding'] === undefined &&
      (headers['content-length'] === undefined || headers['content-length'] === '0')
    ) {
      delete headers['content-type'];
    }
    done();
  });

  // ---------------------------------------------------------------------------
  // GY-I22 缺陷 F-01（Refs #22）：**拒绝类响应的缓存头统一出口**。
  //
  // 实测缺陷（I22 安全矩阵，`docs/verification/gy-i22-secmatrix-20261019.md` 的 F-01）：
  // 23 个游客面 401 响应缺 `Cache-Control: no-store`（无 `public`、无 `max-age`、无数据泄露
  // ⇒ 不阻塞发布，但属真实缺陷）。归因不是「忘了写头」，而是**头写在了错误的位置**：
  //   - 有头的两处是 `onRequest` 钩子：`routes/messages.ts:21-23`、`routes/community.ts:181-183`——
  //     钩子先于鉴权执行，所以**成功与失败响应都带** no-store；
  //   - 其余域把 `reply.header('Cache-Control', 'no-store')` 写在**成功分支**里，鉴权失败抛
  //     `ApiError` 后直接进本文件下面的 `setErrorHandler`，于是 401/403/404/409/422/503 全部缺该头。
  //
  // 修法：不逐路由补漏（23 个面 × 每个域各自的错误路径 ⇒ 必然再漏），改在**响应统一出口**判定一次：
  // 状态码 ≥ 400（鉴权失败、授权拒绝、同形 404、校验失败、500 全在这一类）就补 `no-store`。
  //
  // 为什么是 `onSend` 而不是只改 `setErrorHandler`：`setErrorHandler` 覆盖不到
  // `setNotFoundHandler`（未匹配路径的 404，见本文件末尾）与将来任何在路由里直接
  // `reply.status(4xx).send(...)` 的拒绝面；`onSend` 是这三条路径**共同的唯一**出口，
  // 一处实现即可锁住不变量（本文件末尾两个处理器处另有交叉引用注释，避免以后重复添加）。
  //
  // 边界（不允许被误读）：
  //   - **只写错误响应**：`statusCode < 400` 一律不碰 ⇒ 公共只读成功面（`/health`、`/public/home`、
  //     `/herbicides` 等）的缓存语义保持接线前**逐字节相同**，不会因为本片被一律关掉缓存；
  //   - **不覆盖路由已写的值**：已有 `Cache-Control` 时原样保留（现状里所有成功分支写的就是
  //     `no-store`，本钩子只补齐「缺」的那些，不改变任何既有取值）；
  //   - **只加一个响应头**：状态码、错误封套结构、`ETag`/`Retry-After` 等既有头、
  //     错误码判定次序与鉴权逻辑全部不变。
  // ---------------------------------------------------------------------------
  app.addHook('onSend', async (_request, reply, payload) => {
    if (reply.statusCode >= 400 && reply.getHeader('cache-control') === undefined) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  const clock = now ?? (() => new Date());
  // GY-I17（#17）阶段 2：`real` 且真实连接池已接入 ⇒ 消息域走 PostgreSQL 持久化；
  // `real` 但 `pool === null` ⇒ 维持整域 fail-closed（服务为 null，路由 503），
  // 注入的内存 store 在 `real` 下**不**能冒充持久化（`tests/unit/messages-http.test.mjs` 钉住这条）。
  //
  // 存储实例先单独取出（C1b / §7 P0-2）：注销清理必须清的就是**线上这一份**，
  // 若在服务构造处内联新建、注销侧再建一个，内存模式下会清掉另一个空 store 而假称完成。
  const messagesStore: MessagesStore =
    config.executionMode === 'real'
      ? (pool === null
          ? createMemoryMessagesStore({ now: () => clock().getTime() })
          : createPostgresMessagesStore({ pool }))
      : (messagesInjection?.store ?? createMemoryMessagesStore({ now: () => clock().getTime() }));
  // GY-I17 G4：装配顺序「先消息域后社区域」⇒ 后绑定读取器；漏赋值 ⇒ 恒 unavailable（fail-closed）。
  let communityVisibility: CommunityPublicVisibility | null = null;
  const messageReference: MessageReferencePort =
    messagesInjection?.reference ?? createCommunityReferencePort({ community: () => communityVisibility });
  const messagesService = config.executionMode === 'real'
    ? (pool === null ? null : createMessagesService({
        store: messagesStore,
        reference: messageReference,
        signingKey: config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY,
        now: clock,
        idempotencyTtlMs: IDEMPOTENCY_TTL_SECONDS * 1000,
      }))
    : createMessagesService({
        store: messagesStore,
        reference: messageReference,
        signingKey: config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY,
        now: clock,
        idempotencyTtlMs: IDEMPOTENCY_TTL_SECONDS * 1000,
      });
  // GY-I14 ⇄ GY-I15 联动接线（#14 + #15）：社区 store 与作者投影**只声明一次**，
  // 由社区服务、后台 `hidePost` 与审核域的**同源内容权威端口**三方共用同一实例。
  // 说明：这两行原在下方"社区装配"块内；本接线只把**声明**前移到审核域构造之前
  // （审核域构造时需要权威端口），其余装配顺序与内容**逐字未变**。
  const communityStore: CommunityStore =
    communityInjection?.store ??
    // **存储模式选择（GY-I15 切片 C1）**：有连接池 ⇒ PG 实现（迁移 `0022_community_persistence.sql`），
    // 无池 ⇒ 内存实现。与收藏/历史域同一写法；PG 实现如实声明 `persistent: true`，装配层据此
    // 在 `real` 下**显式放行**（见下方社区装配块），内存实现仍在 real 下整域 503。
    (pool !== null
      ? createPostgresCommunityStore({ pool })
      : createMemoryCommunityStore({ now: () => clock().getTime() }));
  const communityAuthors: AuthorDirectory = communityInjection?.authors ?? createLocalPseudonymousAuthorDirectory();
  // 同源权威端口：审核域读到的就是社区真实内容行，下架写的也是同一行（不是第二份副本）。
  const communityContentAuthority = createCommunityContentAuthority({
    store: communityStore,
    authors: communityAuthors,
  });
  // GY-I14（#14）审核域：`real` ⇒ fail-closed 整域（未授权真实 tms/ims 供应商）；其余模式 ⇒ 替身端口
  // （替身只回报"无结论"⇒ 隔离）。**应用装配路径永不注入真实适配器端口**（零端口注入）。
  // 本接线起：非 real 模式下**内容权威端口**默认是同源社区权威（除非显式注入）。
  const moderationService: ModerationService =
    moderationInjection?.service ??
    createModerationService({
      executionMode: config.executionMode,
      ...(moderationInjection?.ports === undefined ? {} : { ports: moderationInjection.ports }),
      ...(moderationInjection?.authority !== undefined
        ? { authority: moderationInjection.authority }
        : config.executionMode === 'real'
          ? {}
          : { authority: communityContentAuthority }),
      ...(moderationInjection?.callbackKey === undefined ? {} : { callbackKey: moderationInjection.callbackKey }),
      // 规则层选项：未注入时该键不出现（与 `createModerationService` 的默认口径逐字等价）。
      ...(moderationInjection?.ruleOptions === undefined
        ? {}
        : { ruleOptions: moderationInjection.ruleOptions }),
      ...(pool === null ? {} : { store: createPostgresModerationLedger({ pool }) }), // GY-R29 S7 台账落库（0028）；无池 ⇒ 内存台账
    });
  // 社区侧的审核域联动端口（版本级任务 / 明确驳回否决 / 下架缓存失效 / 读取时重查）。
  // `communityInjection.moderation === null` 可显式关闭联动（回到接线前行为，供反例与隔离用）。
  const communityModerationLink: CommunityModerationLink | null =
    communityInjection?.moderation === undefined
      ? createCommunityModerationLink({ moderation: moderationService })
      : communityInjection.moderation;
  const sql = store === undefined && pool !== null ? createSqlExecutor(pool) : null;  const authStore = store ?? (sql === null ? createMemoryAuthStore() : createPostgresAuthStore(sql));
  const idempotencyStore = idempotency ?? (sql === null ? createMemoryIdempotencyStore() : createPostgresIdempotencyStore(sql));
  const wechatProvider =
    wechat ??
    createWechatIdentityProvider({
      executionMode: config.executionMode,
      appId: config.wechatAppId,
      appSecret: config.wechatAppSecret,
      // 真实模式用 SESSION_SIGNING_KEY 作为 HMAC 密钥；替身/演示用固定桩密钥。
      lookupKey: config.sessionSigningKey ?? STUB_LOOKUP_KEY,
    });

  const service = new AuthService({
    store: authStore,
    wechat: wechatProvider,
    idempotency: idempotencyStore,
    executionMode: config.executionMode,
    now: clock,
    bootstrap: config.adminBootstrap,
    // 幂等请求摘要用带服务端密钥的 HMAC：real 模式取 SESSION_SIGNING_KEY（不入库），
    // 替身/演示用固定桩密钥。
    idempotencyHmacKey: config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY,
  });
  const guards = createRateLimiter({ config: config.rateLimit, now: clock }).mount(app).wrapGuards(createAuthGuards({ store: authStore, now: clock }));

  // ---------------------------------------------------------------------------
  // GY-I27 隐私域装配（两片接线；**必须早于识别域服务构造** —— 识别域的提供者包装发生在此处）。
  //  1. 授权中间件：注入的 `privacyInjection.consent` 优先；否则**仅当配置了数据库**时
  //     复用已合并的 `consent-pg.requireConsent` 单事务读取口（不新写 SQL、不新造事实源）。
  //     无数据库（本地 stub/回环测试、以及所有既有集成脚本）⇒ 不挂 ⇒ 行为与接线前逐字相同。
  //  2. 撤回/注销消费者：注入优先；否则**配置了数据库**时由持久账本现建（撤回/授予时撤销在途外发）。
  //  3. **持久外发账本**（第二片）：仅当配置了数据库时装配；提交边界在**单事务**内完成
  //     「校验读取 + 实际写入」（见 privacy/ledger-pg.ts）。`real` 未接真实传输 ⇒
  //     受理处在**任何账本变更之前** 503 `PROVIDER_UNAVAILABLE`，**零 sent 记录**；
  //     替身/演示模式**不记账**（替身不发生真实外发）。
  // ---------------------------------------------------------------------------
  const consentSigningKey = config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY;
  const consentGate: ConsentGate | undefined =
    privacyInjection?.consent ??
    (pool === null
      ? undefined
      : createPostgresConsentGate(createPostgresConsentService(pool, consentSigningKey, consentGrantTestOptions ?? {})));

  // 账本需要**事务**（`connect()`）；测试里注入的「假池」只实现 query（用于验证其他域的
  // 数据库错误映射）⇒ 此处按形状判定：不满足则**不装配账本**并告警（不抛，不静默降级为替身）。
  const egressPoolUsable = pool !== null && typeof pool.connect === 'function' && typeof pool.query === 'function';
  if (pool !== null && !egressPoolUsable) {
    app.log.warn('GY-I27 外发账本未装配：连接池缺少 connect()/query()（测试替身或非法池）');
  }
  const privacyPorts = egressPoolUsable ? createPostgresPrivacyPorts({ pool }) : null;
  const egressLedger = egressPoolUsable ? createPostgresExportLedger({ pool }) : null;
  const privacyInFlight =
    egressLedger !== null && privacyPorts !== null
      ? createInFlightGuard({
          ledger: egressLedger,
          account: privacyPorts.account,
          consentStore: privacyPorts.consentStore,
        })
      : null;
  const egressRevoker: EgressRevoker | undefined =
    privacyInjection?.egressRevoker ??
    (egressLedger === null ? undefined : createEgressRevoker({ ledger: egressLedger }));
  const mediaEgress = (dataType: string, capability: string): MediaJobEgress | undefined =>
    egressLedger === null || privacyInFlight === null
      ? undefined
      : createMediaJobEgress({
          ledger: egressLedger,
          inFlight: privacyInFlight,
          executionMode: config.executionMode,
          dataType,
          capability,
        });
  const recognitionEgress = mediaEgress('weed_recognition', 'weed');
  const speechEgress = mediaEgress('voice_question', 'asr');
  const ocrEgress = mediaEgress('label_ocr', 'ocr');

  // GY-I09 识别任务闭环：real 走 fail-closed 提供者（缺凭据 503，绝不回退替身），
  // stub/preset_demo 用明确标注的替身；媒体引用端口同理（real 未接线 → OBJECT_UNAVAILABLE）。
  //
  // **GY-I16（#16）跨线接线：识别/OCR 的终态 → 服务端识别历史**
  // ------------------------------------------------
  // 派单裁定：在识别任务「进入终态并产出识别记录」时（OCR 同理，见其终态提交处）调用**已存在**的
  // 内部创建口 `historyService.appendHistory({owner_id, kind, target_ref, job_id, job_state, event_key})`
  // （不是契约 operationId、不注册路由）。接线只在**本文件**发生：两个域各自声明一个「把已落库的
  // 终态交给历史域」的端口（`RecognitionTerminalHistoryPort`／`OcrTerminalHistoryPort`），
  // **不 import 对方的服务、不改契约、不加新的契约出口**。
  //
  // 三条硬边界（逐条对应裁定，不得放宽）：
  //   1. **只在终态提交成功后**（`commitTerminal` 返回非 `null`）才投递：CAS 失败（已被取消/已终态）
  //      时**不投递** ⇒ 不会把一次从未发生的终态写进历史；`job_state` 取**实际落库值**（非乐观值）。
  //   2. **确定性 `event_key`**：`<kind>:<job_id>` —— 只由**服务端分配**的作业 id 派生，
  //      **不含**时间戳/随机数；同一次任务重复投递 ⇒ 历史域按 `(owner_id, event_key)` 去重 ⇒ **no-op**。
  //      （历史 store 另有 `(owner_id, kind, target_ref.id)` 唯一约束作第二道去重。）
  //   3. **未接线 = 什么都不做**（不伪造历史、不声称成功）：只有「`real` 且历史域**无**持久化落点」
  //      （`historyService === null`，见下方装配门禁与上方 `historyDomainEnabled`）才落到未接线实现；
  //      `real` + 持久化落点、以及全部非 `real` 分支都走 wired（识别/OCR 任务照常执行）。
  //
  // `app.historyService` 在本文件**下方**才被装配（其任务状态端口要读 `recognitionService.getJob`／
  // `app.ocrService.getJob`，故本端口**不捕获历史服务实例、只捕获 `app`，请求期才解析**）——
  // 与同一装配块里历史任务状态端口的既有做法同源（那里只捕获闭包、请求期才解析 `app.ocrService`）。
  //
  // **store 提前构造**（只提前「构造」，不提前「判定」）：下面两个端口要不要接线，判据是
  // `historyStore.persistent`（与下方 `historyService` 的门禁表达式**同一口径**），因此 store 必须在
  // 端口之前就位。选型规则与别处逐字相同（原注释块见下方「历史/收藏 store 选择」）：
  //   - 注入的 store 优先（测试/装配覆盖项）；
  //   - `real` + 有池 ⇒ PostgreSQL store（`persistent: true`，迁移 0018）；
  //   - 其余（非 real，或 real 无池）⇒ 内存 store（`persistent: false`）。
  // store 是 **store 级、非 nullable**：注销清空（`createUserDataDeletion`）拿到的是 store 而不是
  // service；`real` 无池时仍需一个可调用对象，但下方服务层门禁会把它判成"不持久" ⇒ 服务为 `null`
  // ⇒ 该 store **不接收本域任何写入**（注销清空只会得到 0 行，不会凭空产生"已清空 N 行"的证据）。
  const historyStore: HistoryStore =
    historyInjection?.store ??
    (config.executionMode === 'real' && pool !== null
      ? createPostgresHistoryStore(pool, { now: () => clock().getTime() })
      : createMemoryHistoryStore({ now: () => clock().getTime() }));
  const recordHistoryTerminal = async (input: {
    owner_id: string;
    kind: 'recognition' | 'ocr';
    target_ref: { type: 'recognition'; id: string; revision: number } | { type: 'ocr'; id: string; revision: number };
    job_id: string;
    job_state: string;
  }): Promise<void> => {
    const history = app.historyService;
    if (history === null) return; // real：历史域整域关闭（**不是**配置错误，不告警）
    // `undefined` 只可能来自「装配顺序漂移」（本端口在 `app.decorate('historyService', …)` 之前被调用）。
    // 那种情况下静默丢弃历史是**看不见的假成功**，因此如实抛错，由域侧记告警（任务结果不受影响）。
    if (history === undefined) throw new Error('历史域尚未装配（装配顺序错误），本次终态未写入历史');
    // 本函数形状 = `appendHistory` 入参 + 本层补的**确定性** `event_key`；`appendHistory` 自己逐字段校验
    // （未知字段一律 400，因此这里不做任何预转换、也不吞掉它的拒绝）。
    await history.appendHistory({ ...input, event_key: `${input.kind}:${input.job_id}` });
  };
  // **real 模式的判据（本片修正点）**：不是「执行模式是不是 real」，而是「历史域是否真的开启」——
  // 与下方 `historyService` 的**同一**门禁表达式（`real && !historyStore.persistent ⇒ null`）逐字同源：
  //   - 非 real（stub/演示）⇒ 开启（内存 store，既有行为不变）⇒ 端口 **wired**；
  //   - real + 持久化落点（`DATABASE_URL` 的 PG store，或注入的持久 store）⇒ 服务**开启**
  //     ⇒ 端口 **wired**：识别/OCR 终态**真的**落一行 history（修正前这里被误判成"整域关闭"，
  //     于是 real + PG 的生产路径写不出 history 行）；
  //   - real + 无落点（没配 `DATABASE_URL` 的内存 store / 注入的内存 store）⇒ 服务为 `null`
  //     ⇒ 端口 **unwired**：任务照常执行、**不伪造**历史，5 条历史路由仍如实 503（不放宽守卫）。
  const historyDomainEnabled = config.executionMode !== 'real' || historyStore.persistent;
  const recognitionTerminalHistory: RecognitionTerminalHistoryPort = historyDomainEnabled
    ? {
        kind: 'wired',
        note: '识别终态已接线到历史域内部创建口（appendHistory；确定性 event_key、同任务重复投递为 no-op）',
        recordTerminal: (input: RecognitionTerminalHistoryInput) => recordHistoryTerminal(input),
      }
    : createUnwiredRecognitionTerminalHistoryPort(
        'real 模式且历史域无持久化落点（无 DATABASE_URL / 注入的内存 store）：终态不写历史，不放宽守卫',
      );
  const ocrTerminalHistory: OcrTerminalHistoryPort = historyDomainEnabled
    ? {
        kind: 'wired',
        note: 'OCR 终态已接线到历史域内部创建口（appendHistory；确定性 event_key、同任务重复投递为 no-op）',
        recordTerminal: (input: OcrTerminalHistoryInput) => recordHistoryTerminal(input),
      }
    : createUnwiredOcrTerminalHistoryPort(
        'real 模式且历史域无持久化落点（无 DATABASE_URL / 注入的内存 store）：终态不写历史，不放宽守卫',
      );
  const recognitionProviderResolved =
    recognitionProvider ??
    createRecognitionProvider({
      executionMode: config.executionMode,
      endpoint: process.env['RECOGNITION_PROVIDER_URL'] ?? null,
      apiKey: process.env['RECOGNITION_PROVIDER_KEY'] ?? null,
    });
  const recognitionService = createRecognitionService({
    store: recognitionStore ?? (config.executionMode === 'real' && pool !== null ? createPostgresRecognitionStore({ pool }) : createMemoryRecognitionStore()),
    // GY-I27 第二片：识别域的提供者包装在**装配处**完成（该域的服务由本文件构建）；
    // `real` 才接管派发，替身/演示原样返回（不记账）。
    provider: recognitionEgress === undefined
      ? recognitionProviderResolved
      : recognitionEgress.provider(recognitionProviderResolved, 'recognize'),
    media: recognitionMedia ?? createRecognitionMediaPort(config.executionMode),
    idempotencyHmacKey: config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY,
    // GY-I16 #16 跨线接线：识别任务终态 → 服务端识别历史（见上方 `recognitionTerminalHistory`）。
    history: recognitionTerminalHistory,
    now: clock,
    ...(recognitionJobDeadlineMs === undefined ? {} : { jobDeadlineMs: recognitionJobDeadlineMs }),
  });

  // GY-I13 合成域：real 走 fail-closed 提供者（缺凭据受理前 503，绝不回退替身）；产物存储（R34-I13：只认显式注入的批准能力＋`s3_compatible` 端口，装配层不铸造、不读 env）与
  // 「已核对内容」读取端口同样按执行模式解析。**R28-W3 起**核对端口的 real 分支已接真实现：
  // `createCheckedContentPortFromConfig({executionMode, entries, pool})` —— 非 real 走替身（不变）、
  // real 且无连接池（未配 `DATABASE_URL`）走**未接线**端口（与接线前逐字一致、仍 fail-closed）、
  // real 且有池才走 PostgreSQL 只读核对源（实现 `services/api/src/ai/checked-content-live-adapter.ts`）。
  // **应用装配路径永不注入真实发送端口**：真实发送只能经 `createLiveTtsProvider(ports)` 触达，
  // 而本文件不 import 它（零端口注入）。本文件新增的 import 是**只读核对源**，不对外发包。
  //
  // 缩片（GY-I13 「合成 → 播放」·受理链路打通）：替身模式带上**明确标注的替身核对条目**
  // （`SYNTHESIS_SUBSTITUTE_CHECKED_CONTENT`，见其定义处的边界说明），使客户端替身样本能走完
  // 「受理 202 → `GET /jobs/{id}` 读面」。`real` 分支**忽略**该实参（替身条目永不进 real）；
  // 服务层判定与拒绝码未改。
  // GY-I27（#29）·合成域外发账本接线（与识别/转写/OCR 三域同形）：
  // real 模式且账本可用时，用**出站包装器**接管 `synthesize` 的派发顺序
  // （无预留 ⇒ `OBJECT_UNAVAILABLE`；`markSent` 是唯一权威授权边界）。
  // 记账对象标识取**执行期重读的已核对正文快照**（`checked_content_ref` 的 1..80 文本 id），
  // 存进 0014 新增的 `exports.object_key` 列 ⇒ 不需要把非 uuid 标识硬塞进 uuid 列。
  // 账本/在途守卫未装配（未配置数据库或连接池不可用）⇒ 返回 `undefined` ⇒ 路由与包装逐字不变。
  const synthesisContentResolved =
    synthesisContent ?? createCheckedContentPortFromConfig({ executionMode: config.executionMode, entries: SYNTHESIS_SUBSTITUTE_CHECKED_CONTENT, pool });
  const synthesisProviderResolved: TtsProvider = synthesisProvider ?? createTtsProvider({ executionMode: config.executionMode, aiProviders: config.aiProviders?.tts ?? null });
  const synthesisEgress: SynthesisEgress | undefined =
    egressLedger === null || privacyInFlight === null
      ? undefined
      : createSynthesisEgress({
          ledger: egressLedger,
          inFlight: privacyInFlight,
          executionMode: config.executionMode,
          content: synthesisContentResolved,
          capability: 'tts',
        });
  const synthesisService = createSynthesisService({
    store: synthesisStore ?? createMemorySynthesisStore(),
    provider: synthesisEgress === undefined ? synthesisProviderResolved : synthesisEgress.provider(synthesisProviderResolved),
    media: synthesisMedia ?? createSynthesisMediaPort(config.executionMode, synthesisMediaWiring),
    content: synthesisContentResolved,
    idempotencyHmacKey: config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY,
    now: clock,
    ...(synthesisJobDeadlineMs === undefined ? {} : { jobDeadlineMs: synthesisJobDeadlineMs }),
  });

  // GY-I18 后台域：阶段 1（资料生命周期，25 个 operationId）+ 阶段 1b（运营与开关，9 个）。
  //
  // **两个切片必须共用同一个 `AdminRuntime`**（串行临界区 + **同一份只可追加审计** +
  // 同一套幂等台账）：`listAuditEvents` 是阶段 1 的操作，读的是内容 store 的审计流；
  // 若两个 store 各建一份 runtime，后台运营/开关的写操作（分类/账号/作业/开关/隐藏帖子）
  // 就不会出现在审计里 —— 那等于**审计漏记**。这里由装配层共享一个 runtime 修好，
  // **不改服务层代码**（两个 store 的工厂都已支持注入 `runtime`）。
  //
  // **零端口注入**：`AdminJobPort` 与社区帖子端口默认**不注入** ⇒ 服务层对平台级作业的
  // 读/取消与 `hidePost` 返回 503 `PROVIDER_UNAVAILABLE`（**不返回空页**：空页等于宣称
  // 「平台当前没有作业」，那是无法确认的结论）。真实作业端口与社区存储属后续接线；
  // 本文件**不**自建会与其它域割裂的替身实例（那会让「隐藏了帖子」在不同 store 上失真）。
  // ---------------------------------------------------------------------------
  // GY-I15 社区域（#15）装配。
  //
  // **持久化（切片 C1）**：`communityStore` 在**有连接池**时是 PG 实现
  // （`community/store-pg.ts` + 迁移 `0022_community_persistence.sql`），无池时是内存实现。
  //
  // **real 模式 ⇒ 放行判据是"存储自述持久化"，不是"有没有接线"**（与 GY-I18 后台域、
  // GY-I17 消息域同一口径的反向用法）：内存 store（`persistent:false`）在 `real` 下仍**整域
  // fail-closed**（503 `PROVIDER_UNAVAILABLE`, retryable）——否则写操作会返回**成功封套**
  // 而落点只是易失内存，即在"真实模式"下声称投稿成功、重启即丢。PG store 如实声明
  // `persistent:true`，因此 `real` + 连接池时才放行；无池仍拒绝，**不静默退回内存**。
  //
  // **事件投递**：只把消息域的公开创建口 `appendMessage` 作为**结构性端口**传进来
  // （不 import 消息域、不改其实现）。消息服务在 real 下为 `null` ⇒ 事件端口 `wired:false`。
  //
  // **下架观察器**：交给后台（GY-I18）的社区帖子端口套一层观察器，使
  // `POST /admin/posts/{id}/hide` 生效后能投递「下架」事件；观察器只发通知，
  // 不改 visibility、不改错误映射（权威判定仍在社区 store 的 CAS 里）。
  // ---------------------------------------------------------------------------
  const communitySigningKey = config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY;
  // `communityStore` / `communityAuthors` 已在本文件上方（审核域构造之前）**声明一次**，
  // 由社区服务、后台 `hidePost` 与审核域同源权威端口三方共用；此处不再重复声明。
  const communityEvents: CommunityEventsPort =
    communityInjection?.events ??
    (messagesService === null
      ? createUnwiredCommunityEventsPort('消息服务未接线（real 模式）：审核结果/下架事件无法投递')
      : createMessagesCommunityEventsPort({ messages: messagesService }));
  // ---------------------------------------------------------------------------
  // **#15 S4（R33）· 「杂草／药剂关联」可用性端口的装配层接线**
  //
  // 接线前：装配层只 `import type` + 留一个注入位 ⇒ 生产路径**从不**构造真实端口，服务层缺省
  // 落到 `createUnwiredKnowledgeAvailabilityPort()` ⇒ 任何 `linked_knowledge_ref` 必 409
  // `OBJECT_UNAVAILABLE`（`community/service.ts` 的 `requireAvailableLink`）。
  //
  // 现在：缺省按「**有没有真库**」二分，判据只有一条 `pool === null`（与 `communityStore`、
  // 收藏/历史的可见性端口同一写法）：
  //   * 有 `pool` ⇒ 用**同一条 `pool`** 查与 `/knowledge` **同一张**公开读视图
  //     `catalog_read.current_knowledge`（迁移 0010 + 0012）。该视图的 WHERE 已经把
  //     「`visibility='published'` + 来源 `validity='valid'`/`review_status='verified'` +
  //     当前生效版本（无更新修订、`valid_from<=now<valid_to`）+ 非模拟来源（0005 只放行
  //     `database`/`verified_seed`）」全部写在里面 ⇒ 命中即按 `available` 投影；
  //     未命中／视图缺失／无权限／查询失败一律 `unavailable`（`createKnowledgeAvailabilityPort`
  //     把任何异常折叠为不可用，不会变成 500，也不会"默认可用"）。
  //   * 无 `pool` ⇒ 保持**未接线**端口（一律 `unavailable`）⇒ 新增/替换引用仍 409
  //     `OBJECT_UNAVAILABLE`，绝不因为"没有数据库"就假装可用。
  //
  // 语义与错误码**逐字不变**：目标不存在／不可见（下架、失效、被新修订替换、未核对、模拟资料）／
  // 类型或版本不符，一律同一条 409，响应**不区分**原因、不泄露资料是否存在。
  // 授权已具备：`deploy/postgres-cvm/sql/20-login-roles.sql` 已把 `gengyun_knowledge_runtime`
  // 授给 `gengyun_api_runtime` ⇒ 本接线**不需要新迁移、不需要新授权**。
  //
  // 读取口**逐次现查**（不缓存、不落库）：下架/失效后同一条帖子的投影立刻转 `unavailable`，
  // 符合「读取时重查当前可见性」的既有口径。
  // ---------------------------------------------------------------------------
  /**
   * 关联目标在公开读视图里的**当前**投影（只取判定与 `summary.title` 所需列）。
   *
   * 命中 ⇒ 视图已保证「已发布 + 来源已核对 + 当前生效 + 非模拟来源」，故按可用投影返回；
   * 读不到（无视图／无权限／查询失败／目标不在读面）⇒ `null` ⇒ 端口按 `unavailable` 处理。
   * 位置参数形式（`pool.query(text, values)`）与 `publicKnowledgeRowOf`、`privacy/ledger-pg.ts`
   * 一致（测试夹具的 PGlite 只支持该形式，`{text,values}` 会打断协议流）。
   */
  async function communityKnowledgeRowOf(target: KnowledgeTarget): Promise<unknown> {
    if (pool === null) return null;
    let row: CommunityKnowledgeReadRow | undefined;
    try {
      const result = await pool.query<CommunityKnowledgeReadRow>(
        'SELECT id, revision, type, title, source_kind FROM catalog_read.current_knowledge WHERE id = $1::uuid',
        [target.id],
      );
      row = result.rows[0];
    } catch {
      // 读面不可核对（缺视图/权限不足/超时/非法 id）⇒ 一律"核不到"，不把异常带进帖子响应。
      return null;
    }
    if (row === undefined) return null;
    return {
      id: String(row.id),
      type: String(row.type),
      revision: Number(row.revision),
      title: String(row.title),
      reference_state: 'available',
      // 视图只收 `validity='valid'` 且 `review_status='verified'` 的来源（0005 的 WHERE）⇒ 如实标注。
      source: { validity: 'valid', review_status: 'verified', source_kind: String(row.source_kind) },
    };
  }
  const communityKnowledge: KnowledgeAvailabilityPort =
    communityInjection?.knowledge ??
    (pool === null
      ? createUnwiredKnowledgeAvailabilityPort('无数据库连接池：资料可用性读取口没有可核对的公开读面')
      : createKnowledgeAvailabilityPort({
          note: '资料可用性端口已接线到公开读面：逐次现查 catalog_read.current_knowledge'
            + '（已发布 + 来源已核对 + 当前生效 + 非模拟），id/type/revision 逐项一致才判可用',
          read: (target) => communityKnowledgeRowOf(target),
        }));
  // **放行判据 = `communityStore.persistent`**（不是"某处注入了什么"）：内存实现在 real 下
  // 一律 503，PG 实现在 real + 连接池时放行；持久化改造后这条判据仍然成立且更严。
  const communityRealUnwired = config.executionMode === 'real' && !communityStore.persistent;
  let communityService: CommunityService | null;
  if (communityRealUnwired) {
    const reason = 'real 模式未接真实持久后端（无连接池 ⇒ 内存 store 不持久）：社区业务不可用'
      + '（拒绝以内存 store 返回成功封套）';
    communityService = null;
    app.log.warn({ executionMode: config.executionMode }, `GY-I15 社区域：${reason} ⇒ 16 条社区路由一律 503 PROVIDER_UNAVAILABLE`);
  } else {
    communityService = createCommunityService({
      store: communityStore,
      // **必填**：不提供默认值，避免某个接线点忘了接作者来源时悄悄用假名当真实作者。
      authors: communityAuthors,
      gate: communityInjection?.gate,
      knowledge: communityKnowledge,
      events: communityEvents,
      // GY-I14 ⇄ GY-I15 联动接线：投稿/评论/编辑在落内容行前送审审核域；明确驳回一律不得公开。
      ...(communityModerationLink === null ? {} : { moderation: communityModerationLink }),
      signingKey: communitySigningKey,
      now: clock,
    });
  }
  communityVisibility = communityService?.visibility ?? null;
  // 后台 `hidePost` 的社区帖子端口：注入优先；否则用**同一个**社区 store（绝不自建第二份，
  // 否则"后台隐藏了帖子"在社区读取侧不生效）。上面套下架观察器只为发通知。
  const communityPostPortForAdmin =
    adminInjection?.communityStore ?? withTakedownObserver(communityStore, { events: communityEvents });

  const adminSigningKey = config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY;
  const adminRuntime = createAdminRuntime();
  const adminContentStore = adminInjection?.contentStore ?? createAdminContentStore({ runtime: adminRuntime });
  // **开关播种（本片新增）**：把 3 个开关与该输出面**当前是否真的在产出**对齐（见
  // `admin/ops/flag-gate.ts` 的 `FLAG_WIRING_BASELINE` 说明）。不播种的话，出厂默认（全 false）
  // 会让 `listFlags` 自述"药剂输出已关闭"而 `/herbicides` 照常产出 —— 开关等于没生效。
  // 注入的 store 不覆盖（测试可自带 flagSeed 做反例）。
  const adminOpsStore =
    adminInjection?.opsStore ?? createAdminOpsStore({ runtime: adminRuntime, flagSeed: flagSeedFromBaseline() });
  // 全局开关门：读取**当前**开关状态。real 模式后台域整体 fail-closed ⇒ 开关没有权威来源，
  // 此时 `armed:false`（保持既有产出行为，不拿未接线的开关中断用户面）—— 见证据页「未取得项」。
  const adminRealUnwired = config.executionMode === 'real';
  // **GY-I18 接线（#18）**：`real` 且拿到真实库池 ⇒ 开关读写走迁移 0020 的 `public.feature_flags`
  // （读面 `listFlags`、写面 `setFlag`：单事务 CAS + 审计）。显式注入优先（测试用它钉住接线点，
  // 不依赖真库）；`pool === null` ⇒ `flagsPort` 为 null，开关面继续 503、开关门不武装
  // —— 与接线前逐字相同。
  const flagsPort =
    adminInjection?.flagsPort ??
    (adminRealUnwired && pool !== null ? createPostgresFeatureFlags({ pool }) : null);
  const flagsWired = flagsPort !== null;
  // **GY-I18 第一批：平台级作业真库端口**。与 `flagsPort` 同一门：显式注入优先（测试钉住接线点），
  // 否则 `real` + 有池才建；`pool === null` 或非 real ⇒ 不建端口 ⇒ 服务层走未接线分支（读/取消 503）。
  const adminJobPort =
    adminInjection?.jobPort ??
    (adminRealUnwired && pool !== null ? createPostgresAdminJobPort({ pool }) : undefined);
  // **武装的前置条件（T-R12-08R）**：`real` + 有池 + **表确认可用**，三者缺一不可。
  // 只应用迁移子集的库（例如 `egress-ledger-pg.mjs` 只跑 0001/0003/0008/0009/0011）里没有
  // 0020 的 `public.feature_flags`；那种库上不能武装：否则首个受控面请求预取失败 ⇒ 503，
  // 把与开关无关的既有面打红。探测是只读的 `to_regclass`，在 `onReady` 里跑一次
  // （服务开始接请求之前）。
  // **#282 P1 修复**：探测结果改**三态**（`probeFeatureFlagsTable`）—— 只有**确认未安装**
  // （`missing`）才让门永久降级未武装（与接线前逐字相同）；探测**异常/形状读不懂**（`unknown`）
  // 绝不再当成"表不存在"，门保持武装并 fail-closed，且下一次判前重探。否则一次连接/权限抖动
  // 就会把已接真实端口的开关门永久退成 `open`，库里的 `false` 不再阻断受控面（旧 `false` 语义）。
  // 注意：开关端口本身仍保留 —— 缺表时它的读写自然 503（不伪造成功封套），与未接线时的
  // 用户可见行为一致；开关门的武装则严格以「表**确认**可用」为准。
  const flagArmingProbe =
    adminRealUnwired && pool !== null && flagsPort !== null
      ? () => probeFeatureFlagsTable(pool)
      : undefined;
  // 开关**唯一权威**：接了真实端口就只信库（内存 store 的播种状态不再参与判定，
  // 避免"库说关、内存说开"的双权威）；未接端口时维持既有内存读取口。
  const flagGateReader: FlagReader =
    flagsPort === null ? createStoreFlagReader(adminOpsStore) : createPortFlagReader(flagsPort);
  const flagGatePrepare =
    flagsPort === null ? undefined : () => (flagGateReader as PortFlagReader).refresh();
  const featureFlagGate = createFeatureFlagGate({
    reader: flagGateReader,
    // 静态口径（`stub` ⇒ 武装；`real` 未接端口 ⇒ 不武装）由 `armed` 表达；`real` 已接端口时
    // 还须先过 `armingProbe` 的运行时探测：只有**确认缺表**（`missing`）才降级未武装，
    // 探测异常/读不懂（`unknown`）保持武装并 fail-closed（#282 P1 修复）—— 见 `flag-gate.ts`。
    armed: !adminRealUnwired || flagsWired,
    ...(flagArmingProbe === undefined ? {} : { armingProbe: flagArmingProbe }),
    ...(flagGatePrepare === undefined ? {} : { prepare: flagGatePrepare }),
  });
  // 就绪探测必须在**服务开始接请求之前**完成：挂到 `onReady`（`listen` 与 `inject` 都会先走它），
  // 而不是懒到首个受控面请求才探 —— 否则第一笔请求仍可能因未定而 503。
  const gatePrepare = featureFlagGate.prepare;
  if (gatePrepare !== undefined) {
    app.addHook('onReady', async () => {
      await gatePrepare();
    });
  }
  // 受控输出面的守卫链：**先鉴权（401/403 次序不变）、后判开关**。
  const gatedGuards = createFlagGatedGuards(guards, featureFlagGate);
  // 人工评审入口空态：本片未接入任何人工评审（无任务/审核人/投票/专家认证）。
  const humanReviewDirectory = createHumanReviewDirectory();

  // **real 模式 ⇒ 后台域整体 fail-closed**（监工返修 P1）。
  // 后台服务建的是**内存** store；若在 `real` 下仍把它交给服务层，写操作会返回**成功封套**
  // 而落点只是易失内存 —— 即在"真实模式"下声称成功、重启即丢。这不能靠
  // `contract-status=partial` 之类文档披露替代，必须在**运行时**拒绝。
  // 口径与本仓一致：real 永远走 fail-closed 实现（缺真实后端即 503，**严禁静默回退替身**）。
  // **刻意不依赖任何"自述持久化"的布尔标志**：将来后台域接上真实持久 store 时，必须在这里
  // **显式放行**（一次可审查的接线变更），而不是靠替身自称真实就能自动启用。
  // （`adminRealUnwired` 已在上方与开关门一并判定：它决定是否进入「整域 fail-closed」分支；
  //   开关门是否武装、开关面是否放行，另由 `flagsWired` 单独决定。）

  let adminContentService: AdminContentService;
  let adminOpsService: AdminOpsService;
  let adminAuditLogService: AdminAuditLogService;
  if (adminRealUnwired) {
    const reason = 'real 模式未接真实持久后端：后台业务不可用（拒绝以内存 store 返回成功封套）';
    const failClosed = createFailClosedAdminServices(reason);
    adminContentService = failClosed.content;
    // **real 下的两条显式放行**（每条都必须有真实持久权威，逐个列出、不整对象透传）：
    // 1. **GY-I22（#22）账号停用**：迁移 0017 的 `public.suspend_account()`（`users.state` +
    //    `auth_epoch` + 撤会话 + 审计**同一事务**）；
    // 2. **GY-I18（#18）开关读写**：迁移 0020 的 `public.feature_flags` + `public.set_feature_flag()`
    //    （`listFlags` 读、`setFlag` 单事务 CAS + 审计）；
    // 3. **GY-I18 放行表第 4 条：帖子下架**（本片新增）：判据是**社区帖子端口的能力位**
    //    `communityPostPortForAdmin.persistent === true` —— 即迁移 0022 的 PG 社区 store
    //    （`community/store-pg.ts` 自述 `persistent: true`）。内存实现恒 `false`，
    //    因此 real 默认装配（`pool === null`）下 `hidePost` 仍 503（35 条反例一条不改仍绿）。
    //    写本身不新增迁移：`deploy/postgres-cvm/sql/20-login-roles.sql` 已有
    //    `GRANT UPDATE (…, visibility, audit_state, updated_at) ON public.community_posts`。
    //    ⛔ 不在 real 分支挂 `withModerationTakedownLink`：real 未注入审核权威时，
    //    替身权威对未登记目标 `setVisibility` 会抛 `OBJECT_UNAVAILABLE`，
    //    把一次**已生效**的社区下架折成 503（下架成功却报失败）。
    //    ⛔ 库内审计**未取得**：`appendAudit` 仍落内存 ops store（`persistent: false`），
    //    重启即丢且 real 下无读面 —— 如实登记，不得声称"审计已落库"。
    // 放行条件只有"拿到真实库池 / 显式注入权威/端口"，**不看**任何自述持久化标志；
    // 其余后台路由（含账号读面 `listAdminUsers`、分类、作业）仍逐条 503
    // —— 见 `admin/ops/accounts-only.ts` 与 `admin/fail-closed-services.ts` 的"接线点"要求。
    // **GY-I17（#17）系统事件接线**（裁定 `.pg17/ruling-r31-i17-system-events-20261022.md`）：
    // 账号停用/恢复在**事务已提交**之后追加一条 `system` 消息（`target_ref=null`，契约
    // `TargetRef` 闭集无 account 型，⛔ 不臆造）。装饰器只**追加**通知：不改写入参/返回、
    // 不改错误映射；消息写入失败**不回滚**已提交的停用/恢复（fail-open，口径同
    // `community/events.ts`），但留 `delivered:false` + 计数 + `warn` 日志，绝不谎报成功。
    // 幂等分支（`outcome.changed === false`）**不投递**：重放不产生第二条消息、不重置读状态。
    // 消息服务在 real 下仅拿到库池时才非 null ⇒ 否则端口如实 `wired:false`（不伪造投递）。
    const accountEvents: AccountEventsPort =
      messagesService === null
        ? createUnwiredAccountEventsPort('消息服务未接线（real 模式）：账号停用/恢复的系统事件无法投递')
        : createMessagesAccountEventsPort({ messages: messagesService });
    const accountAuthorityBase =
      adminInjection?.accountAuthority ??
      (pool === null ? null : createPostgresAccountAuthority({ pool }));
    const realAccountAuthority =
      accountAuthorityBase === null
        ? null
        : withAccountSystemEvents(accountAuthorityBase, { events: accountEvents, log: app.log });
    // **GY-I18/T-R12-03 第三个显式放行（读面）**：真实账号目录只在**确实拿到库池**时构造；
    // `pool === null` ⇒ 目录为 null ⇒ 读面保持 503（⛔ 不拿内存种子冒充真实账号，也⛔ 不返回空页）。
    // 读的是迁移 0021 的窄口径函数 `public.list_admin_accounts()`（运行时角色只有 EXECUTE）。
    const realAccountsDirectory = pool === null ? null : createPostgresAccountsDirectory({ pool });
    // **R34 显式放行（库内审计**读**面，不是写面）**：只在**确实拿到库池**时构造只读端口；
    // `pool === null` ⇒ 端口 null ⇒ `/admin/audit-logs` 保持 503（⛔ 不返回空页：空页会被读成
    // "平台不存在任何后台审计记录"，那是伪造读数）。读的是迁移 0033 的
    // `public.list_admin_audit_logs()` —— 运行时角色对 `admin_audit_events` 仍是**零表级权限**，
    // 只有该函数的 EXECUTE（`deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-r34-audit-logs-grant`）。
    // ⛔ 本片**不**解决"审计落库"：三处库内写入（`suspend_account`/`restore_account`/`set_feature_flag`）
    // 之外的 `appendAudit` 仍落内存 ops store（`persistent:false`），此处只补**读**通道。
    const realAuditLogPort =
      adminInjection?.auditLogPort ?? (pool === null ? null : createPostgresAdminAuditLogPort({ pool }));
    adminAuditLogService = createAdminAuditLogService({
      port: realAuditLogPort,
      now: clock,
      signingKey: adminSigningKey,
      executionMode: config.executionMode,
    });
    if (realAccountAuthority === null && !flagsWired) {
      adminOpsService = failClosed.ops;
      app.log.warn({ executionMode: config.executionMode }, `GY-I18 后台域：${reason} ⇒ 36 条后台路由一律 503 PROVIDER_UNAVAILABLE`);
    } else {
      adminOpsService = restrictAdminOpsToAccountsAuthority(
        createAdminOpsService({
          store: adminOpsStore,
          now: clock,
          signingKey: adminSigningKey,
          executionMode: config.executionMode,
          accountAuthority: realAccountAuthority,
          accountsDirectory: realAccountsDirectory,
          // 只转**真实**端口：`null` 时服务层保持"无 port 走内存 store"的既有分支。
          ...(flagsPort === null ? {} : { flagsPort }),
          jobPort: adminJobPort,
          // GY-I15 接线同上：端口仍按**同一份**社区 store 装配；`hidePost` 是否放行由上面的
          // `hidePostWired`（= `persistent === true`）决定，本行不改变判据。
          community: communityPostPortForAdmin,
          flagEffects: adminInjection?.flagEffects,
        }),
        reason,
        // 判据是**能力对象存在**：目录构造成功才放行读面；否则 `listAdminUsers` 仍逐条 503。
        {
          accountsReadWired: realAccountsDirectory !== null,
          flagsWired,
          // 下架面的判据同理，且更严：**只有真实持久的社区帖子端口**才放行（内存实现恒 false）。
          hidePostWired: communityPostPortForAdmin.persistent === true,
        },
      );
      const released: string[] = [];
      if (realAccountAuthority !== null) released.push('账号停用');
      if (realAccountsDirectory !== null) released.push('账号读面');
      if (flagsWired) released.push('开关读写');
      // 只在**真的**放行时才把这个能力计入读数：未持久化时它仍属"逐条 503"的一员。
      if (communityPostPortForAdmin.persistent === true) released.push('帖子下架');
      // R34：库内审计**读**面（迁移 0033 的只读函数）；审计**写**面仍未落库，不在此列。
      if (realAuditLogPort !== null) released.push('库内审计读面');
      app.log.warn(
        {
          executionMode: config.executionMode,
          accountsReadWired: realAccountsDirectory !== null,
          flagsWired,
          hidePostWired: communityPostPortForAdmin.persistent === true,
          auditLogReadWired: realAuditLogPort !== null,
        },
        `GY-I18/I22/R34 已接真实持久权威 ⇒ ${released.join('、')}走真实库（读面经 public.list_admin_accounts()，迁移 0021；下架经 community_posts 的 CAS，迁移 0022；审计日志经 public.list_admin_audit_logs()，迁移 0033）；其余 ${36 - released.length} 条后台路由仍 503 PROVIDER_UNAVAILABLE`,
      );
    }
  } else {
    adminContentService = createAdminContentService({
      store: adminContentStore,
      now: clock,
      signingKey: adminSigningKey,
      executionMode: config.executionMode,
    });
    adminOpsService = createAdminOpsService({
      store: adminOpsStore,
      now: clock,
      signingKey: adminSigningKey,
      executionMode: config.executionMode,
      // GY-I22：**只经显式注入**开启真实停用权威（与 `mediaObjectStore` 同一口径：
      // 不读 ambient 配置、不因"有 pool"就自动在 stub 域里接真实写）。
      accountAuthority: adminInjection?.accountAuthority,
      // GY-I18：stub 域**只**经显式注入接真实开关端口（默认仍是内存 store；不因"有 pool"自动接库）。
      ...(flagsPort === null ? {} : { flagsPort }),
      jobPort: adminJobPort,
      // GY-I15 接线：后台 `hidePost` 用社区**同一份** store（默认已套下架观察器）。
      community: communityPostPortForAdmin,
      flagEffects: adminInjection?.flagEffects,
    });
    // GY-I14 ⇄ GY-I15 联动接线：后台下架生效后**驱动审核域下架**（整链缓存失效 + 该版本永久不可复活）。
    // 只用**包装**的方式追加一个时机，不改 `admin/ops/**` 的任何实现。
    if (communityModerationLink !== null) {
      adminOpsService = withModerationTakedownLink(adminOpsService, {
        link: communityModerationLink,
        posts: communityPostPortForAdmin,
      });
    }
    // R34：审计日志读面在 stub/preset_demo 域**只经显式注入**接真实库端口（与 `flagsPort` 同一口径：
    // 不因"恰好有 pool"就在 stub 域自动读库）。默认注入为空 ⇒ 端口 null ⇒ 读面 503
    // （未接线 ≠ 没有历史；空页会被读成"平台从未发生任何后台事件"）。
    adminAuditLogService = createAdminAuditLogService({
      port: adminInjection?.auditLogPort ?? null,
      now: clock,
      signingKey: adminSigningKey,
      executionMode: config.executionMode,
    });
  }

  // GY-I06 私有媒体域（#6）：契约 7 个 operationId 的唯一装配点。
  //
  // **对象存储端口的唯一起因是显式注入**（`mediaObjectStore` 选项）：注入什么端口就用什么端口，
  // 端口这一侧**只**做 `??` 兜底，**不**读取、也**不**传递任何环境配置 —— 因此
  // **ambient `process.env` 不是开启真实适配器的门**：
  //   - **未显式注入** ⇒ 一律 `resolveMediaObjectStore({ executionMode })`（**不传 `env`**）：
  //     `real` ⇒ `unwired`（整域 fail-closed 503 `PROVIDER_UNAVAILABLE`，与接线前逐字一致，
  //     **环境里四个 `OBJECT_STORAGE_*` 键齐备也一样** —— 缺配置不是放行理由，配置齐备也不是）；
  //     `stub`/`preset_demo` ⇒ **明确标注的替身**（句柄域名 `substitute.invalid`，不冒充真实网关）。
  //   - **显式注入**（运维/启动代码在**已审查**的前提下构造端口，或测试注入）⇒ 按注入的端口装配，
  //     与执行模式无关：注入 `kind === 's3_compatible'` 才走真实分支。
  //
  // 为什么必须有这道门（监工对 PR #193 的 P1，裁定见仓库外 `.pg17/ruling-issue193-supervisor-p1.md`；
  // 派单 `.pg17/dispatch/issue193-refailclosed.md` A 项）：这 4 个 `OBJECT_STORAGE_*` 键**正是 real
  // 模式的启动必填项**（见 `config.ts` 的 `REQUIRED_WHEN_REAL`）⇒「运维不设键」**不可能**充当
  // 「可启动的 real 环境」的门 —— 把 ambient env 交给 resolver 等于**配置即门控**，
  // 在隐私守卫（上传受理的用途授权已由 GY-I27 第三片接上，但**缺数据库时不挂**；撤回 epoch 未接）
  // 与可恢复媒体元数据（`media/service.ts` 的 `records`/`grants`/`idempotency`
  // 仍是进程内 `Map`，重启即丢 owner/版本/rawRef 与回收依据）尚未接妥前，会为真实用户媒体开门。
  // 这两片落地前，真实适配器只允许经**显式注入**装配；**不得**用布尔自述标志当门控
  // （判据是端口的 `kind`，同监工对 #121 的 P1 口径）。
  // 桶私有性、≤300 秒短效句柄与私有内容网关仍属部署期接线（ADR-001 的门控不在本片）。
  // 公开内容来源默认**关闭**：社区取图统一 404，不误放行；真实来源属社区/审核线，跨线接线。
  //
  // r3（第二轮对抗性复审后的**方向性改判**，裁定 `.pg17/ruling-i193-runtime-gate.md`）：
  // 上面的静态判据（AST 审计 + 端口溯源 + 运行时 env 探针）**已降级为启发式**，不再是唯一依据 ——
  // 两轮返修的失败同源：判据是**封闭世界静态检查**，只要把来源放在被审文件之外
  // （新增模块 + 签名默认值、`Object.prototype` 投毒、链路文件 1 行副作用 import、动态取键）
  // 就能全绿而 `POST /api/v1/media/uploads` 返回 201。**主闸门已移到运行期构造期**：
  // 见 `media/service.ts` 的 `approveRealMediaWiring` / `RealMediaWiringApproval` —— `real` 下
  // `createAppMediaService` 必须收到**显式批准能力**（对象身份、WeakSet 品牌、不可从
  // env／`options.env`／原型链／全局对象派生），否则整域 fail-closed 503，与「环境里有没有那四个键」
  // 「谁读了 env」「端口从哪个模块来」全都无关。
  // ⛔ 装配层**不得自行铸造**该能力（那等于自我批准）：这里只**转发**调用方给出的选项。
  //
  // 访问网关原点（契约 `AccessGrant.url` 的 host）**只来自配置层**：`config.mediaAccessGrantOrigin`
  // 已由 `config.ts` 校验（https、无凭据、无路径/查询），这里**原样透传**；未配置（`null`）就
  // **不传该属性**，服务层落回不可解析占位域 `https://media.placeholder.invalid`。
  // 它只改句柄的 host，**不**是真实端口的门（端口仍只由上面的显式注入决定）。
  const mediaObjectStore = mediaObjectStoreOption ?? resolveMediaObjectStore({ executionMode: config.executionMode });
  // **持久化端口**（W12，#6）：登记册 / 短效授权 / 幂等台账三者的**事实源**。
  // 判据与 favorites/history 逐字同形（`real` 才接 PG，否则内存），但多一个非它不可的前置条件：
  // `media.object_ref_cipher` 是 `text NOT NULL`，落库前必须加密，因此**没有键就不接 PG**。
  // 键的「有没有」判据：`config.ts` 给出的正常形状是 `string`／`null`，但既有测试夹具直接
  // 拼 `{ ...baseConfig(), executionMode: 'real' }` 之类的字面量配置，新字段可能是 `undefined`／空白。
  // 这里统一归一化一次：**只有非空字符串才算有键**，其余一律按「未配置」走 fail-closed，
  // ⛔ 不得因为 `undefined !== null` 就当成有键去做加密（那会让缺键在构造期抛错，而不是 503）。
  const mediaObjectRefKeyMaterial: string | null =
    typeof config.mediaObjectRefKey === 'string' && config.mediaObjectRefKey.trim() !== ''
      ? config.mediaObjectRefKey
      : null;
  const mediaStore: MediaStore = mediaStoreOption
    ?? (config.executionMode === 'real' && pool !== null && mediaObjectRefKeyMaterial !== null
      ? createPostgresMediaStore({ pool, cipher: createObjectRefCipher(mediaObjectRefKeyMaterial) })
      : createMemoryMediaStore({ now: () => clock().getTime() }));
  // `real` + 有数据库池 + **缺** `MEDIA_OBJECT_REF_KEY` ⇒ 媒体域整域 fail-closed（503），
  // **不是**降级：拿不到键就无法如实写 `object_ref_cipher`，用进程内 `Map` 顶替等于向客户端
  // 谎报「已持久化」——这正是 W12 要消灭的那种假持久化。
  const mediaPersistenceRefusal: string | null =
    config.executionMode === 'real' && pool !== null && mediaObjectRefKeyMaterial === null
      ? 'real 模式的媒体持久化缺少 MEDIA_OBJECT_REF_KEY：object_ref_cipher 无法加密，拒绝以进程内状态承载媒体事实'
      : null;
  const mediaService: AppMediaService = mediaPersistenceRefusal === null
    ? createAppMediaService({
        executionMode: config.executionMode,
        objectStore: mediaObjectStore,
        tokenSecret: config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY,
        contentSource: mediaContentSource ?? createClosedContentSource(),
        ...(mediaAttachmentCounter === undefined ? {} : { attachmentCounter: mediaAttachmentCounter }),
        // non-defaultable：未显式给出时**不带该属性**（闸门只认自有属性 + WeakSet 品牌）。
        ...(mediaRealApprovalOption === undefined ? {} : { realMediaApproval: mediaRealApprovalOption }),
        // 未配置 ⇒ **不带该属性**（缺省行为 = 服务层占位域），配置即生效（句柄 host 跟随部署值）。
        ...(config.mediaAccessGrantOrigin === null ? {} : { accessGrantOrigin: config.mediaAccessGrantOrigin }),
        // 持久化端口：**唯一**的事实源（登记册/授权/台账），缺省时服务内部会退到内存实现，
        // 装配层在这里显式给出按模式二分的实现，避免「进程内 Map 仍是事实源」的假持久化。
        persistence: mediaStore,
        now: clock,
      })
    : createFailClosedMediaService(mediaPersistenceRefusal);

  // GY-I16 收藏与可浏览的识别历史（#16）：本片两个子域的唯一装配点。
  //
  // **real 模式按「有没有真实持久化落点」二分**（与本仓「real 永远 fail-closed、严禁静默回退
  // 替身」一致，且与问答域的 `conversationStore` 门禁同一口径）：
  //   - `real` + 有 `pool` ⇒ 接 PG store（`persistent: true`，迁移 `0018`）⇒ 服务**开启**，
  //     写操作落到真实库表，进程重启后仍在；
  //   - `real` + 无 `pool`（没配 `DATABASE_URL`）⇒ 服务仍为 `null` ⇒ 5 条路由**保持 503**
  //     PROVIDER_UNAVAILABLE（绝不静默回退内存替身去声称成功）；
  //   - 非 `real`（stub/演示）⇒ 内存 store + 服务开启（既有行为不变）。
  // 判据是 **`store.persistent`** 而不是只看 `config.executionMode`：注入进来的内存 store
  // 在 real 下同样必须 503（见下方 `favoritesService` / `historyService` 的门禁表达式，
  // 与问答域 `conversationStore === null || (real && !conversationStore.persistent)` 逐字同形）。
  //
  // **引用可用性端口接线到公开读面**（本片接线，替代此前的 `createUnwiredVisibilityPort`：
  // 未接线时收藏/历史 `reference_state` 恒为 `unavailable` ⇒ 收藏页「查看资料」永不可跳转）。
  // 端口的唯一权威是 `/knowledge` 的**公开读面**，逐次现查：
  //   1) 数据库读视图 `catalog_read.current_knowledge`（已核对来源 + 已发布 + 当前生效版本）；
  //   2) 浙江首批真实资料投影（`knowledge/reference-query.ts#toSeedRows`：`validity='valid'` 且未
  //      `hidden`/`deleted`），与 `routes/knowledge.ts` **同一模式门与同一显式开关**。
  // 只有目标 id **当前在读面里**、且 `type` 与 `revision` 逐项一致才判 `available`；其余一切
  // （不在读面／读面不可核对／版本已替换／类型不符／读取失败）一律 `unavailable`，且**不区分**
  // "已下架"与"不存在"（同 #17 消息域口径）。判定**不缓存、不落库**，"下架/失效不因缓存或旧链接
  // 重新公开"因此在结构上成立（详见 `targetref/visibility.ts` 的三条硬边界）。
  // 读面开关的判据与 `routes/knowledge.ts` 逐字相同；两处不漂移由回归用例
  // `tests/unit/favorites-visibility-wiring.test.mjs`（"列表里能读到的资料，收藏后必须可用"）锁住。
  //
  // **任务状态端口默认接线到已合并的公开读取口**：`recognitionService.getJob`（#9）与
  // `ocrService.getJob`（#10）—— 只调用公开方法、不改他人文件。这样历史列表/详情的
  // `job_state` 在读取时能取到**实时**状态（失败/超时/取消原样可见），核不到时才退回入库值。
  // `ocrService` 在下方 `registerOcrRoutes` 时才被装饰，这里只捕获闭包、请求期才解析。
  // store 选择：**real 且有 `pool` 才接 PG**（`persistent: true`），否则内存实现。
  //
  // 这两个 store 都是 **store 级**（非 nullable），因为注销清空（`createUserDataDeletion`）拿到的是
  // store 而不是 service。`real` 且无 `pool` 时仍需一个可调用对象 ⇒ 选内存实现，但下方
  // 服务层门禁会把它判成"不持久" ⇒ 服务为 `null` ⇒ 该 store **不接收本域任何写入**，
  // 注销清空只会得到 0 行（不会凭空产生"已清空 N 行"的证据）。
  //
  // ⚠ `historyStore` 的**构造**在**上方**（GY-I16 终态端口处）：终态端口要不要接线，判据是
  // `store.persistent`（与下面 `historyService` 的门禁表达式同一口径），所以必须先于端口就位。
  // 本处不再重复构造，避免出现"两个 store、两套判据"。
  const favoritesStore: FavoritesStore =
    favoritesInjection?.store ??
    (config.executionMode === 'real' && pool !== null
      ? createPostgresFavoritesStore(pool, { now: () => clock().getTime() })
      : createMemoryFavoritesStore({ now: () => clock().getTime() }));
  /** 浙江首批投影面（与 `/knowledge` 同源同过滤同开关）；开关关闭时它恒为空集合。 */
  const publicKnowledgeSeedFace = createReferenceQueryService({
    includeUnverifiedSeed:
      config.executionMode !== 'real' && /^(1|true)$/i.test(process.env['APP_KNOWLEDGE_UNVERIFIED_SEED'] ?? ''),
  });
  /**
   * `/knowledge` 查询面的**唯一实例**（GY-I12 跨片复用缝，纯追加）。
   *
   * 本片把它同时交给：
   *   1) `registerKnowledgeRoutes`（经 `KnowledgeRouteDeps.service` 覆盖项；不传时该函数
   *      按原样自建，行为不变）；
   *   2) 文字问答域的检索端口（`createKnowledgeRetrievalPort({ face })`）。
   * 这样"引用只能取自**本次**检索集合"里的检索集合，与用户直接 `GET /knowledge` 读到的
   * 是**同一个实例、同一份视图投影、同一模式门、同一显式开关**，不存在第二套读法。
   * `pool === null`（无 `DATABASE_URL`）时为 `null` ⇒ `/knowledge` 自己就是 503，
   * 问答域随之**未接线检索面**（`createUnwiredRetrievalPort` ⇒ 集合恒为空 ⇒ 守卫如实
   * 判 `insufficient`，**不编造**引用）。
   */
  const knowledgeQueryFace = pool === null
    ? null
    : createKnowledgeService(pool, config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY, {
        extraRows: () => publicKnowledgeSeedFace.seedRows(),
      });
  /**
   * 公开读面里该 id 的**当前**投影（只取判定所需两列）；读面无法核对时返回 `null`。
   *
   * - 没有数据库（`pool === null`）时 `/knowledge` 自己就是 503（`routes/knowledge.ts#ready`）
   *   ⇒ 没有任何目标读得到，一律"核不到"；**不退回**种子面（那会声称一个列表页打不开的目标
   *   "可用"，是假阳性）。
   * - 读视图查询失败（缺视图／权限不足／超时）⇒ 同样"核不到"，也不退回种子面（此时
   *   `/knowledge` 同样取不到那批行）。异常不外传、不入响应。
   */
  async function publicKnowledgeRowOf(id: string): Promise<{ type: string; revision: number } | null> {
    if (pool === null) return null;
    let row: PublicKnowledgeReadRow | undefined;
    try {
      // 与 `knowledge/service.ts` 读同一张只读视图：行在视图里即"已核对 + 已发布 + 当前生效"。
      // 位置参数形式（`pool.query(text, values)`）：与 `privacy/ledger-pg.ts` 等既有调用一致，
      // 且测试夹具的 PGlite 只支持该形式（`{text,values}` 对象形式会打断协议流）。
      const result = await pool.query<PublicKnowledgeReadRow>(
        'SELECT id, revision, type FROM catalog_read.current_knowledge WHERE id = $1::uuid',
        [id],
      );
      row = result.rows[0];
    } catch {
      return null;
    }
    if (row !== undefined) return { type: String(row.type), revision: Number(row.revision) };
    const seed = publicKnowledgeSeedFace.seedRows().find((candidate) => candidate['id'] === id);
    if (seed === undefined) return null;
    return { type: String(seed['type']), revision: Number(seed['revision']) };
  }
  const defaultVisibility: VisibilityPort = createWiredVisibilityPort({
    note:
      '引用可用性端口已接线到公开读面：逐次核验目标当前是否出现在 /knowledge 读面'
      + '（数据库读视图 catalog_read.current_knowledge + 浙江首批投影），type/revision 逐项一致才判可用',
    resolve: async ({ target_ref }) => {
      // 只核验收藏契约闭集（`species|herbicide|scheme`）：其余目标本片没有可核验的读面。
      if (!isFavoriteTargetType(target_ref.type)) return 'unavailable';
      const row = await publicKnowledgeRowOf(target_ref.id);
      if (row === null) return 'unavailable';
      if (row.type !== target_ref.type) return 'unavailable';
      if (row.revision !== target_ref.revision) return 'unavailable';
      return 'available';
    },
  });
  const favoritesVisibility: VisibilityPort = favoritesInjection?.visibility ?? defaultVisibility;
  const historyVisibility: VisibilityPort = historyInjection?.visibility ?? defaultVisibility;
  const historyJobPort: HistoryJobPort =
    historyInjection?.job ??
    createWiredHistoryJobPort({
      note: '任务状态端口接线到已合并的公开读取口：recognitionService.getJob（#9）/ ocrService.getJob（#10）',
      resolve: async ({ kind, jobId, userId }) => {
        if (kind === 'recognition') return app.recognitionService.getJob({ userId, jobId });
        return app.ocrService.getJob({ userId, jobId });
      },
    });
  const historyCascadePort: HistoryCascadePort = historyInjection?.cascade ?? createHistoryCascadePort({ recognitionService: () => app.recognitionService, ocrService: () => app.ocrService });
  // 服务层门禁（**唯一**开关）：只有"有真实持久化落点"时才交出服务。
  //   - 非 `real` ⇒ 开启（内存 store，既有行为）；
  //   - `real` + `store.persistent === true`（PG store）⇒ 开启；
  //   - `real` + 不持久（无 `pool` 时的内存实现 / 外部注入的内存替身）⇒ `null` ⇒ 5 条路由 503。
  // 表达式与问答域 `conversationStore === null || (real && !conversationStore.persistent)` 同形，
  // 理由也相同：注入的内存 store 在 real 下**不得**绕过 fail-closed。
  const favoritesService =
    config.executionMode === 'real' && !favoritesStore.persistent
      ? null
      : createFavoritesService({
          store: favoritesStore,
          visibility: favoritesVisibility,
          signingKey: config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY,
          now: clock,
        });
  const historyService =
    config.executionMode === 'real' && !historyStore.persistent
      ? null
      : createHistoryService({
          store: historyStore,
          visibility: historyVisibility,
          job: historyJobPort,
          cascade: historyCascadePort,
          signingKey: config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY,
          now: clock,
        });
  // GY-I16 第 4 项：**复用已合并的** `packages/privacy` 删除注册协议（不另起一套），
  // 只把本片自己的 `favorites`/`history` 两个模块注册进去（在线部分真的清理并留证据；
  // 备份副本清除未接线 ⇒ `backupState: 'pending'`，如实显示未完成）。
  // GY-I19（#19）本片：注销请求的**持久化受理端口**。
  //   - 有真库（`pool !== null`）⇒ 接线：受理经窄口径 `SECURITY DEFINER` 函数在**同一事务**内
  //     完成「账号改 deletion_pending + auth_epoch 递增 + 撤全部会话 + 注销请求落库」；
  //   - 无真库（内存模式，含既有集成测试与 `real` 不接线路径）⇒ **不**接线，行为与追加前逐字一致；
  //   - `requests: null` 可显式关闭（故障注入方向的反向控制用）。
  //   - `receiptTtlMs` 必须与受理服务的回执期限**同源** ⇒ 直接复用 `RECEIPT_TTL_MS` 常量
  //     （第二个默认 TTL 会让持久列与回执各说一套）。
  const injectedDeletionRequests = userDataDeletionInjection?.requests;
  const durableDeletionRequests: DeletionRequestStore | null =
    injectedDeletionRequests === undefined
      ? (pool === null ? null : createPostgresDeletionRequestStore({ pool }))
      : injectedDeletionRequests;
  // GY-I19（#19）本片：逐用户备份副本清除端口的装配（设计 §7.4 三态；回执里
  // 有备份对象就按「到期清除 + 删除后复核」给出 completed/blocked，不再是恒 pending）。
  //   - 有真库且**受理已接线**（`durableDeletionRequests !== null`）⇒ 真实 PG 端口：逐请求/逐模块
  //     读行、到期判定、清除后复核、证据摘要全部落库；
  //   - 受理**未接线**（`requests: null` 或内存模式）⇒ 保持缺省 unwired：没有受理行就没有清单行，
  //     「未接线 ⇒ pending」是如实状态（既有 `favorites-history-deletion-registration.test.mjs`
  //     反向控制就锁这条：`requests: null` 时 `backup_state` 必须仍是 pending）；
  //   - 受理已接线但**无真库**（只可能来自注入 store）且是 `real` 模式 ⇒ 显式不可用端口
  //     （模块 blocked + `PROVIDER_UNAVAILABLE`），⛔ 不静默退回内存实现或 unwired；
  //   - stub/demo 无真库 ⇒ 保持缺省 unwired（进程内没有副本域可清，`pending` 才是如实状态）。
  const backupPurgeWiring: { backupPurge?: BackupPurgePort } =
    userDataDeletionInjection?.backupPurge !== undefined
      ? { backupPurge: userDataDeletionInjection.backupPurge }
      : durableDeletionRequests !== null && pool !== null
        ? { backupPurge: createPostgresBackupPurgePort({ pool, now: clock }) }
        : durableDeletionRequests !== null && config.executionMode === 'real'
          ? { backupPurge: createUnavailableBackupPurgePort() }
          : {};
  // GY-R28 W6（G5/G11）：回执 `backupState` 的**只读推导**装配（门与 `backupPurgeWiring` 严格同门）。
  //   - 有真库且**受理已接线**（存在清单行）⇒ 真实只读端口：回执的备份态由 `user_backup_copies` 的
  //     真实行推导（四域全 `purged` 且证据可复算 ⇒ `completed`；未到期 ⇒ `pending`；到期未清 /
  //     缺清单行 / 有 `failed` 行 ⇒ `blocked` + 原因码）；
  //   - 受理**未接线**（`requests: null` 或内存模式）⇒ **不接线**：没有清单行就无法判定，
  //     「回执照抄上次执行结论」才是如实状态（既有反向控制用例锁这条：`requests: null` 时
  //     `backup_state` 必须仍是 pending）；
  //   - 显式注入优先（测试与故障注入），与 `backupPurge` 的覆盖顺序一致。
  const backupStatesWiring: { backupStates?: BackupStateDerivationPort } =
    userDataDeletionInjection?.backupStates !== undefined
      ? { backupStates: userDataDeletionInjection.backupStates }
      : durableDeletionRequests !== null && pool !== null
        ? { backupStates: createPostgresBackupStateReader({ pool, now: clock }) }
        : {};
  // GY-R32（#19 片B）：在线证据落库 + 回执在线态推导（迁移 0031）。
  // 门与 `backupPurgeWiring`/`backupStatesWiring` **严格同门**：
  //   - 有真库且受理已接线 ⇒ 真实端口（写走 0031 唯一写函数；读走 0031 唯一读函数）；
  //   - 受理未接线 / 无真库 ⇒ **不接线**：没有请求行就没有证据可写/可读，
  //     回执照旧由处理器结果投影（既有反向控制用例锁这条：`requests: null` 时在线态不得被"推导"改写）；
  //   - 显式注入优先（测试与故障注入）。
  const onlineEvidenceWiring: { onlineEvidence?: OnlinePurgeEvidenceRecorder } =
    userDataDeletionInjection?.onlineEvidence !== undefined
      ? { onlineEvidence: userDataDeletionInjection.onlineEvidence }
      : durableDeletionRequests !== null && pool !== null
        ? { onlineEvidence: createPostgresOnlinePurgeEvidenceRecorder({ pool, now: clock }) }
        : {};
  const onlineStatesWiring: { onlineStates?: OnlineStateDerivationPort } =
    userDataDeletionInjection?.onlineStates !== undefined
      ? { onlineStates: userDataDeletionInjection.onlineStates }
      : durableDeletionRequests !== null && pool !== null
        ? { onlineStates: createPostgresOnlineStateReader({ pool, now: clock }) }
        : {};
  // #12 会话域存储（**提前声明**）：注销清理把会话域并进同一本账，而备份清单是「全有或全无」
  // —— `backupCopySources()` 需要在**装配期**就知道该 store 有没有 `snapshotOwner`，因此这份
  // store 必须先于注销装配就位；后面的问答子域装配**复用**同一实例（不再重复创建）。
  // 语义与既有口径逐字一致：`real` + 无池 ⇒ null（域不可用），非 real ⇒ 内存实现。
  const conversationStore: ConversationStore | null =
    conversationInjection?.store ??
    (config.executionMode === 'real'
      ? (pool === null ? null : createPostgresConversationStore(pool))
      : createMemoryConversationStore());
  // #17 消息域（C1b / §7 P0-2）：把**线上那一份**消息存储收窄成注销协议要的 `OwnerPurgeStore`。
  // 注入的替身可能只实现读路径 ⇒ 缺 `deleteAllByOwner` 时**调用即抛错**（由协议折叠为 `blocked` +
  // `HANDLER_FAILED`），⛔ 不在装配期假装"能清"，也不在这里静默跳过消息域（那正是 #17 的原缺口）。
  const messagesPurgeDelete = messagesStore.deleteAllByOwner?.bind(messagesStore);
  const messagesPurgeCounts = messagesStore.purgeOwnerData?.bind(messagesStore);
  const messagesPurgeSnapshot = messagesStore.snapshotOwner?.bind(messagesStore);
  const messagesDeletionStore: OwnerPurgeStore = {
    async deleteAllByOwner(ownerId) {
      if (messagesPurgeDelete === undefined) {
        throw new Error('消息域存储未实现按主体清空（deleteAllByOwner）：拒绝假装清空');
      }
      return messagesPurgeDelete(ownerId);
    },
    ...(messagesPurgeCounts === undefined
      ? {}
      : { purgeOwnerData: (ownerId: string) => messagesPurgeCounts(ownerId) }),
    ...(messagesPurgeSnapshot === undefined
      ? {}
      : {
          snapshotOwner: (
            ownerId: string,
            client: Parameters<NonNullable<OwnerPurgeStore['snapshotOwner']>>[1],
          ) => messagesPurgeSnapshot(ownerId, client),
        }),
  };
  // #15 社区域（R31-S6 / F13 保留规则）：**同一份**社区 store ＋ **同一个**作者目录 ⇒ 一个端口。
  // 端口内做三件事并如实分账：清社区行（`purgeOwnerData`：保留/脱敏/媒体）＋ 把作者投影换成
  // 随机注销引用（`AuthorDirectory.anonymize`）＋ 把**行级** `author_id` 换成行内匿名引用
  // （迁移 0030：`anonymized_author_ref`，与存储清理同一事务）。两条旧原因码
  // （`author-row-reference-not-replaced` / `author-reference-not-durable`）因此不再出现；
  // 只在**能力缺失/生成失败**（`author-reference-unavailable` / `-failed`）时仍如实 blocked，
  // ⛔ 不用保留行数冒充 completed。
  const communityPurgePort = createCommunityOwnerPurgePort({
    store: communityStore,
    authors: communityAuthors,
  });
  // #19 延续片 · 语音域：注销必须清**路由正在用的那一份**数据。
  // ⚠️ 语音 store 的解析点是 `routes/speech.ts:128`（注入优先 → real 且真池 用 PG → 否则内存），
  // 而且那里**刻意不外露 store 实例**：`tests/unit/speech-store-pg-wiring.test.mjs` 的源码钉子
  // 要求本文件对语音存储层只允许 `import type`（⛔ 不得在装配层 import 值实现）。
  // 因此这里不复制那份三态解析，也不另建第二个 store 实例（那会清到另一份缓存/另一个实例的
  // 表探测状态），而是用启动后 `app.decorate('speechService', …)` 暴露的服务在**调用期**取原语
  // （`routes/speech.ts:145`）。注销请求必然晚于装配完成，所以调用期一定拿得到；真拿不到就抛，
  // 由删除协议折叠成 `blocked` + `HANDLER_FAILED`，⛔ 不静默算完成。
  const speechPurgeOwnerData = async (
    ownerId: string,
  ): Promise<{ records: number; idempotency: number }> => {
    const service = app.speechService as
      | { purgeOwnerData?: (id: string) => Promise<{ records: number; idempotency: number }> }
      | undefined;
    const purge = service?.purgeOwnerData;
    if (typeof purge !== 'function') {
      throw new Error('语音域存储未实现按主体清空（purgeOwnerData）：拒绝假装清空');
    }
    return purge.call(service, ownerId);
  };
  // #19 延续片 · 识别域：同一套理由与做法。识别 store 的解析点是上面 `createRecognitionService`
  // 的内联三段式（`recognitionStore ?? (real && 有池 ? PG : 内存)`），那份表达式被
  // `tests/unit/recognitions-store-pg-wiring.test.mjs` 的源码钉子**逐字**钉住，本文件也不许再
  // 另建第二个实例（内存模式下等于清另一份空数据，却照报「已清 N 行」）。
  // 所以：从 `app.decorate('recognitionService', …)`（:2009）暴露的服务在**调用期**取原语。
  const recognitionPurgeOwnerData = async (
    ownerId: string,
  ): Promise<{ records: number; idempotency: number }> => {
    const service = app.recognitionService as unknown as
      | { purgeOwnerData?: (id: string) => Promise<{ records: number; idempotency: number }> }
      | undefined;
    const purge = service?.purgeOwnerData;
    if (typeof purge !== 'function') {
      throw new Error('识别域存储未实现按主体清空（purgeOwnerData）：拒绝假装清空');
    }
    return purge.call(service, ownerId);
  };
  // #19 延续片：把两个端口收窄成注销协议要的 `OwnerPurgeStore`（照 `messagesDeletionStore` 的
  // 做法：**缺原语时调用即抛**，由协议折叠 `blocked` + `HANDLER_FAILED`）。
  // ⛔ 不在这里静默跳过这两个域 —— 「表里没接」正是本片要消掉的缺口；「接了但不会清」必须喊出来。
  // 注：本片**不**为这两域提供 `snapshotOwner`（备份副本只对收藏/历史/消息/会话四域生成行），
  // 因此它们的备份列如实保持 `pending`，⛔ 不冒充完成。
  const recognitionsDeletionStore: OwnerPurgeStore = {
    async deleteAllByOwner(ownerId) {
      return (await recognitionPurgeOwnerData(ownerId)).records;
    },
    purgeOwnerData: (ownerId: string) => recognitionPurgeOwnerData(ownerId),
  };
  const speechDeletionStore: OwnerPurgeStore = {
    async deleteAllByOwner(ownerId) {
      return (await speechPurgeOwnerData(ownerId)).records;
    },
    purgeOwnerData: (ownerId: string) => speechPurgeOwnerData(ownerId),
  };
  // R34 片 3（#19 / #10）· OCR 域（三表）：**无条件注入**，手法同语音/识别两域 —— 存储实例在
  // `routes/ocr.ts` 内部构造（本文件刻意不 import 任何 OCR 存储/提供者适配器，见
  // `tests/integration/ocr-http.mjs` 的原文子串判据与 `tests/unit/ocr-store-pg-wiring.test.mjs`），
  // 因此这里用启动后 `decorate` 暴露的**服务**在**调用期**取原语；注销请求必然晚于装配完成。
  // ⚠️ 与前两域**方向相反**：OCR 三表的表级 DELETE 是**用户 2026-10-24 批准**的例外
  // （`deploy/postgres-cvm/sql/20-login-roles.sql` 的 R34 段 + `90-assert` 的 `allow_table_dml`），
  // 存储层因此是真 `DELETE … RETURNING`（`store-pg.ts` 的 `purgeOwnerRows`：同一事务、
  // 先 `ocr_records` 后 `ocr_jobs`、再按 scope 首段清台账）。
  // 缺权（42501）/连接失败/原语缺失 ⇒ 调用即抛 ⇒ 协议折叠 `blocked` + `HANDLER_FAILED`，
  // ⛔ 不折成 `completed`，也不折成"0 行"。
  const ocrPurgeOwnerData = async (ownerId: string) => {
    const service = (app as unknown as {
      ocrService?: {
        purgeOwnerData?: (id: string) => Promise<{
          records: number;
          idempotency: number;
          tableCounts?: Readonly<Record<string, number>>;
        }>;
      };
    }).ocrService;
    const purge = service?.purgeOwnerData;
    if (typeof purge !== 'function') {
      throw new Error('OCR 域存储未实现按主体清空（purgeOwnerData）：拒绝假装清空');
    }
    return purge.call(service, ownerId);
  };
  const ocrDeletionStore: OwnerPurgeStore = {
    async deleteAllByOwner(ownerId) {
      return (await ocrPurgeOwnerData(ownerId)).records;
    },
    purgeOwnerData: (ownerId: string) => ocrPurgeOwnerData(ownerId),
  };
  const userDataDeletion = createUserDataDeletion({
    favoritesStore,
    historyStore,
    messagesStore: messagesDeletionStore,
    // #12 会话域（C1b-3 / §7 P0-3 路径①）：并入**同一本账**。`conversationStore` 在本文件
    // 稍后才装配（`real` 无池时为 null），因此这里用闭包惰性取值：域不可用时**调用即抛**
    // （协议折叠 blocked + HANDLER_FAILED），⛔ 不在装配期假装"能清"，也不静默跳过该域。
    conversationsStore: {
      async deleteAllByOwner(ownerId) {
        const store = conversationStore;
        if (store === null) throw new Error('会话域不可用（real 模式无连接池）：拒绝假装清空');
        return store.deleteAllByOwner(ownerId);
      },
      // G6/G8 收口：会话域现在也提供 `snapshotOwner`（只回会话行 id 与计数），因此四域齐全、
      // 备份清单能写四行。注入的替身若没有该原语，这里**不转发** ⇒ `backupCopySources()` 返回
      // null ⇒ 各模块因「没有副本行」如实 blocked（反向控制用例正是走这条路径）。
      ...(typeof conversationStore?.snapshotOwner === 'function'
        ? {
            snapshotOwner: (
              ownerId: string,
              client: Parameters<NonNullable<OwnerPurgeStore['snapshotOwner']>>[1],
            ) => (conversationStore as NonNullable<typeof conversationStore>)
              .snapshotOwner!(ownerId, client),
          }
        : {}),
    },
    // #15 社区域（R31-S6 / F13）：**无条件注入** —— 只要社区 store 在装配期存在，注销就会按
    // F13 保留/脱敏该主体的帖子与评论、移除不可脱敏媒体、清点赞与举报自由文本，并把作者
    // 投影换成注销引用；未完成项如实 blocked（见 `community/purge.ts`）。
    // 端口同时提供 `deleteAllByOwner`（= `records`）与分表计数的 `purgeOwnerData`；
    // `makeHandler` 优先走后者，因此保留/脱敏/媒体/台账读数都不会丢。
    communityStore: communityPurgePort,
    // #19 延续片 · 识别域（四表）：**无条件注入** —— 只要识别 store 在装配期存在（本文件已解析成
    // `recognitionsPersistenceStore`，三种执行模式都有实例），注销就必须清它。
    // 走 `purgeOwnerData` ⇒ 证据串带 `recognitions:online-purged:<n>` / `:idempotency-purged:<n>`
    // 并落库 0031（`ONLINE_EVIDENCE_MODULES` 已含该模块名）。
    recognitionsStore: recognitionsDeletionStore,
    // #19 延续片 · 语音域（三表）：同上，无条件注入。转写原文是最敏感的一类个人数据，不留副本。
    speechStore: speechDeletionStore,
    // R34 片 3 · OCR 域（三表）：同上，无条件注入。走 `purgeOwnerData` ⇒ 证据串带
    // `ocr:online-purged:<n>` / `:idempotency-purged:<n>` / `:tables:ocr_records=<n>,ocr_jobs=<n>`，
    // 并落库 0031（`ONLINE_EVIDENCE_MODULES` 已含该模块名）。
    ocrStore: ocrDeletionStore,
    // 与其它服务同源使用应用时钟：回执的 `requested_at`/在线 7 日/备份 30 日截止必须由**同一**时钟推出，
    // 否则同一请求的「受理时刻」与「截止时刻」会来自两个时间源（真实模式下不可复现）。
    now: clock,
    ...backupPurgeWiring,
    ...backupStatesWiring,
    ...onlineEvidenceWiring,
    ...onlineStatesWiring,
    ...(durableDeletionRequests === null
      ? {}
      : { requests: durableDeletionRequests, receiptTtlMs: RECEIPT_TTL_MS }),
  });

  // GY-I19（#19）本片：注销/删除申请 HTTP 面的装配（两个 operation）。
  //   - `deletionReceipts`：回执 bearer 台账（只存 sha256 摘要；有效期 35 日）；
  //   - `accountDeletion`：申请服务，**复用**上面那份 `userDataDeletion`（模块闭集与处理器同源，
  //     不新建第二套台账）；本片新增的只有**受理持久化**（迁移 0016，复用 0003 已建的
  //     `public.deletion_requests` 表；见上方 `durableDeletionRequests` 装配）；
  //   - 执行模式门（本片红线「真实依赖缺失 ⇒ 如实失败/503」）：`real` 模式**整域不接线**
  //     ——真实执行链路（7 日在线 / 30 日备份 / 第三方完成证据）尚未实现，
  //     因此**不接线**：`available: false` ⇒ 两个 operation 一律 503 `PROVIDER_UNAVAILABLE`
  //     （`retryable: false`），**不**回 200 空壳、**不**假装删除成功。`stub`/`preset_demo`
  //     是明确标注的替身执行模式（响应 `meta.execution_mode` 会如实写出来）⇒ 接线可用；
  //     202 只表示「已受理」：备份副本清除未接线 ⇒ 该请求此刻**确实无法完成** ⇒ `state: 'blocked'`
  //     （`state-contract.md:107` 逐字「不能完成时显示blocked和逾期，不把时钟到期当完成」），
  //     绝不回 `completed`。
  const deletionReceipts = createDeletionReceiptRegistry({ now: clock });
  const accountDeletion = createAccountDeletionRequestService({
    deletion: userDataDeletion,
    receipts: deletionReceipts,
    available: config.executionMode !== 'real',
  });

  // =====================================================================================
  // GY-I12（#12）文字问答子域装配（**纯追加**）
  // =====================================================================================
  // 本块只**新增**局部量与一处 decorate，不改上面任何既有域的实参/行为。回退 = 删本块。
  //
  // 1) 存储：非 `real` 用进程内 store（删除是**显式级联**：会话→轮次→回答）；
  //    `real` 用 PG store（同一事务内 `SELECT ... FOR UPDATE` + CAS 删除，迁移
  //    `services/api/db/migrations/0013_conversations.sql` 的三张表 + `ON DELETE CASCADE`）。
  //    为什么 `real` + `pool === null` 时整域置 `null`：把内存 store 交给 real 模式的服务层
  //    = 在真实模式下声称成功、进程重启即丢（与 `app.ts` 既有的收藏/历史口径逐字一致）。
  //    注：`conversationStore` 已在**上方注销装配之前**声明（备份清单需要它在装配期就位），此处不再新建。
  // 2) 幂等台账：**本域自带**（`ConversationOutcome` 只存 `conversation_id`/`turn_id` 引用，
  //    不含正文与凭据）。为什么不复用 `auth/idempotency.ts` 的台账：它的
  //    `IdempotencyOutcome` 是 `{sessionId,audience} | {accepted:true}` 闭联合，
  //    且被既有断言逐字锁住（`tests/unit/auth-store-pg.test.mjs`：`idempotency_keys` 列集、
  //    `outcome = {accepted:true}`）⇒ 扩展它会迫使放宽既有断言。故只**复用其口径**
  //    （scope 三段式 `sha256(subject\\nMETHOD\\npath)` + HMAC 请求摘要 + 占位行），存储自持。
  const conversationLedger: ConversationIdempotencyLedger =
    conversationInjection?.ledger ?? createMemoryConversationIdempotencyLedger();
  // 3) 检索集合：接线到**与 `/knowledge` 同一个**读面实例（`knowledgeQueryFace`，见下），
  //    保证"引用只能取自本次检索集合"的判据与用户实际能读到的资料**同一份**。
  const conversationRetrieval: RetrievalPort =
    conversationInjection?.retrieval ??
    (knowledgeQueryFace === null
      ? createUnwiredRetrievalPort(
          '资料读面未配置（无 DATABASE_URL）：检索集合恒为空，拒绝在没有依据的情况下产出任何引用',
        )
      : createKnowledgeRetrievalPort({ face: knowledgeQueryFace }));
  // 4) 用量权威：只接 GY-I08 的**确定性**描述子（`doseCardDescriptor`）；本片**没有**语言模型，
  //    因此未取得确定性判定通过前**不产出**任何用量卡（域库本基线恒 `renderable:false`）。
  const conversationDose: DoseAuthority = conversationInjection?.dose ?? createDeterministicDoseAuthority();
  // 5) 输出守卫（引用只能取自本次检索集合 + 用量卡只能取自确定性权威路径）。
  const conversationGuard: AnswerGuard = conversationInjection?.guard ?? createConversationGuard({ dose: conversationDose });
  // 5a) 回答生成器（GY-R28 W7 / #12）：**只有**四件事同时成立才接真实模型 ——
  //     ① 配置里给了 `chatProvider`（https 端点 + 模型名 + 密钥齐备）；
  //     ② 外发账本可用（`DATABASE_URL` + 带 `connect()` 的池 ⇒ `egressLedger`/`privacyInFlight` 非 null）；
  //     ③ 执行模式为 `real`（`ChatEgress.engaged`）；④ 未被测试/装配注入覆盖。
  //     任一不成立 ⇒ 沿用基线确定性回答器（版本串仍带 `unimplemented:no-real-`），
  //     **行为与 main 逐字节一致**。决策本身是纯函数（`ai/chat-wiring.ts`），四条与门逐条有单测。
  const conversationChatPlan = planConversationChat({
    ...(conversationInjection?.composer === undefined ? {} : { injectedComposer: conversationInjection.composer }),
    // 少数既有测试直接构造精简 config（未走 `loadConfig`）；缺 `chatProvider` 时一律按「未配置」处理
    // （fail-closed：不做任何真实外发，版本串仍是带 `unimplemented:no-real-` 的那条路径）。
    chat: config.chatProvider ?? null,
    executionMode: config.executionMode,
    egressLedger,
    privacyInFlight,
    // 只记结构读数（状态码/耗时/token/出口记录），不记正文与密钥。
    log: app.log,
  });
  for (const warning of conversationChatPlan.warnings) app.log.warn(warning);
  const conversationComposer: AnswerComposer = conversationChatPlan.composer;
  // 5a-2) 版本串**由装配层**给（回答器无权决定，NC2）：只有 `mode === 'live'` 才有覆盖值，
  //      其余一切情况都不传 ⇒ 三个串照旧全部带 `unimplemented:no-real-`。
  const conversationAnswerVersions = conversationChatPlan.answerVersions;
  // 5b) 风险/注入筛查（问题 + 资料原文）：**复用** `packages/moderation` 现成的
  //     `dangerous_usage` + `prompt_injection` 规则层，不新写第二套规则；缺省启用（fail-closed）。
  const conversationRiskScreen: RiskScreen = conversationInjection?.riskScreen ?? createModerationRiskScreen();
  // 6) 语音轮次：只读复用已合并的 `app.speechService.getTranscription`（受理时核对
  //    `transcription_id` + `transcription_revision` + `confirmed`），不新建第二套转写存储。
  const conversationTranscription = conversationInjection?.transcription ?? createTranscriptionPort({
    getTranscription: (input) => app.speechService.getTranscription(input),
  });
  const conversationCascade: TurnCascadePort = conversationInjection?.cascade ?? createUnwiredTurnCascadePort();
  const conversationService: ConversationService | null =
    // `real` 下只有 `persistent === true` 的 store 才配得上"真实成功"：无 `DATABASE_URL` 时
    // `conversationStore` 为 null，**注入的内存 store 也不例外**（否则测试注入口就成了绕过
    // fail-closed 的后门）。非 `real` 模式照旧用内存 store，与收藏/历史口径一致。
    conversationStore === null || (config.executionMode === 'real' && !conversationStore.persistent)
      ? null
      : createConversationService({
          store: conversationStore,
          retrieval: conversationRetrieval,
          guard: conversationGuard,
          composer: conversationComposer,
          riskScreen: conversationRiskScreen,
          transcription: conversationTranscription,
          cascade: conversationCascade,
          // 追问上下文：缺省由服务层按自己的 store 自建（见 `conversations/context.ts`）。
          ...(conversationInjection?.context === undefined ? {} : { context: conversationInjection.context }),
          ledger: conversationLedger,
          ...(conversationAnswerVersions === undefined ? {} : { answerVersions: conversationAnswerVersions }),
          signingKey: config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY,
          now: clock,
        });
  // 7) 注销删除（C1b-3 / §7 P0-3 路径①）：会话域**并入 `userDataDeletion` 那一本账**
  //    （见上方 `conversationsStore` 依赖）。本片**不再**另建只含 `conversations` 的第二个
  //    协调器与第二个 requestId —— 一次注销 = 一个请求、一份回执、一条证据链。
  //    备份副本清除属 GY-I19 G6/G8（P1）⇒ 该模块回执如实 `pending`（不谎称完成）。

  // 请求身份槽位（GY-I27 接口缝：req.userId / req.authEpoch / req.role）。
  app.decorateRequest('userId', null);
  app.decorateRequest('authEpoch', null);
  app.decorateRequest('role', null);
  app.decorateRequest('sessionId', null);
  app.decorateRequest('sessionExpiresAt', null);
  app.decorateRequest('accountRevision', null);
  app.decorateRequest('authScopes', null);
  app.decorate('authService', service);
  app.decorate('recognitionService', recognitionService);
  app.decorate('synthesisService', synthesisService);
  app.decorate('adminContentService', adminContentService);
  app.decorate('adminOpsService', adminOpsService);
  app.decorate('adminAuditLogService', adminAuditLogService);
  app.decorate('featureFlagGate', featureFlagGate);
  app.decorate('humanReviewDirectory', humanReviewDirectory);
  app.decorate('mediaService', mediaService);
  app.decorate('mediaObjectStore', mediaObjectStore);
  app.decorate('messagesService', messagesService);
  app.decorate('moderationService', moderationService);
  app.decorate('favoritesService', favoritesService);
  app.decorate('historyService', historyService);
  app.decorate('userDataDeletion', userDataDeletion);
  // GY-I19（#19）本片：注销装配的只读取证面（回执台账只含 sha256 摘要，不含明文 bearer）。
  app.decorate('accountDeletion', accountDeletion);
  app.decorate('deletionReceipts', deletionReceipts);
  app.decorate('communityService', communityService);
  // GY-I12（#12）：问答服务。注销删除注册已并入 `userDataDeletion`（C1b-3 / P0-3 路径①），
  // 不再单独 decorate 第二个协调器（那是"两本账"的形状）。
  app.decorate('conversationService', conversationService);
  // GY-I14 ⇄ GY-I15 联动接线：把装配好的联动端口挂出来（只读用途；业务判定仍在服务层内部）。
  app.decorate('communityModerationLink', communityModerationLink);

  // 注：GY-I27 的 `consentSigningKey`/`consentGate`/`egressRevoker` 声明已在上方
  // 「GY-I27 隐私域装配（两片接线）」块内完成（合并时上游把该块前移并扩成含
  // 持久外发账本的第二片）。此处**不再重复声明**：同一标识符二次 `const` 会直接语法错误，
  // 且上游版本是严格超集（仍以 `privacyInjection.consent`/`egressRevoker` 优先）。
  // 这是本次合并的唯一语义冲突点：只能保留上游那份声明，本片只保留自己的装配（decorate/register）。

  registerHealthRoutes(app, config, pool);
  registerPublicHomeRoute(app, config, pool);
  registerUserAuthRoutes(app, config, { service, guards, now: clock });
  registerAdminAuthRoutes(app, config, { service, guards, now: clock });
  registerConsentRoutes(app, config, pool, guards, {
    ...(consentGrantTestOptions ?? {}),
    ...(egressRevoker === undefined ? {} : { egressRevoker }),
  });
  // GY-I19（#19）：`listExports`（`GET /me/exports`）装配（无池 ⇒ 503 fail-closed，见 `routes/exports.ts`）。
  // ⚠ 新 import 与上一条 import 同行：独占一行会推移 `app.ts` 行号，令历史证据页的引用锚点判 SUSPECT。
  registerExportRoutes(app, config, pool, guards);
  registerProfileRoutes(app, config, pool, guards);
  // 本片起：以下域的输出面受**全局开关**控制（受控面与其 `operationId` 的权威清单见
  // `admin/ops/flag-gate.ts` 的 `FLAG_GATED_SURFACES`：除草剂列表／详情、社区 `createPost`／
  // `createComment`、识别、OCR、转写、合成、文字问答），因此传入 `gatedGuards`（= 原守卫 + 开关门；
  // 先鉴权、后判开关）。守卫链语义与错误码次序不变。
  // 合并口径（与 `upstream/main` 的 GY-I27 外发账本接线**两侧全保留**）：
  // 保留 main 的调用签名与 `egress` 依赖，只把 `guards` 换成 `gatedGuards` —— 两者互不替代。
  // GY-I07 第二片（跨线 **#7 公开读 × #18 引用失效**）：把**后台资料来源存储**里既有的
  // 「读取时重算」解析器注入公开读**详情面**（`createReferenceIntegrity(store).resolve`）。
  // 接线点仅此一处、纯追加：用的是本函数上方**已经建好的那一个** `adminContentStore`
  // （`adminInjection?.contentStore ?? createAdminContentStore(...)`，见上方装配），
  // **不新建第二份 store**、不改它的创建或注入口径、不改任何既有实参。
  // 回退方式：删掉这里的第 5 个实参即可回到接线前行为（`deps.resolve === undefined` ⇒ 不判定）。
  // 生产默认：该 store 在 `real` 模式下**空且只读**（后台写口整域 fail-closed）⇒ `resolve()` 恒
  // `unverifiable` ⇒ 详情面照旧可见，即"失效拦截"在生产尚未全面生效（见 PR 正文"未取得项"）。
  registerKnowledgeRoutes(app, config, pool, gatedGuards, {
    resolve: createReferenceIntegrity(adminContentStore).resolve,
    // GY-I12 复用缝（纯追加的两个覆盖项）：把上面建好的**同一个实例**交给读面，
    // 使文字问答域的检索集合与 `/knowledge` 逐字节同源。不传时本函数自建，行为不变。
    reference: publicKnowledgeSeedFace,
    service: knowledgeQueryFace,
  });
  registerRecognitionRoutes(app, config, gatedGuards, recognitionService, { consent: consentGate, egress: recognitionEgress });
  // GY-I11 录音字节来源（本片唯一接线点）：把**已经按既有口径解析好的**对象存储端口与媒体
  // 登记册交给转写域，真实 AudioSource 据此按 `media_id` + `revision` 取字节并做归属校验。
  //   - 这里只**转发**既有端口，不构造新存储、不读 env、**不**走 `approveRealMediaWiring()`
  //     （真实对象存储的开启仍只由上面的 `mediaObjectStore` 显式注入决定）；
  //   - `real` 且未注入真实存储 ⇒ 转发的是 `unwired` 端口：`getObject` 抛
  //     `PROVIDER_UNAVAILABLE` ⇒ 字节来源 fail-closed（未发包），与接线前同一结局；
  //   - 真实存储与批准能力都到位时，同一条装配**无需再改**即可取到真实字节。
  const speechAudioMedia = { objectStore: mediaObjectStore, mediaRecords: mediaStore };
  registerSpeechRoutes(app, config, { guards: gatedGuards, store: speechStore, provider: speechProvider, media: speechMedia, audioMedia: speechAudioMedia, jobDeadlineMs: speechJobDeadlineMs, consent: consentGate, egress: speechEgress }, config.executionMode === 'real' ? pool : null);
  registerSynthesisRoutes(app, config, gatedGuards, synthesisService, consentGate, synthesisEgress);
  // GY-R27 S10（#10）· OCR 域的**持久化接线**（迁移 `0024_ocr_persistence.sql`）。
  //
  // 规则与本文件上方消息域的 `real` 口径**对齐**（`messagesService` 那段：`real` 且 `pool !== null`
  // 才接真实库），但**降级方式按本域现状**、不照抄消息域的整域 503：
  //   * `real` 且 `pool !== null` ⇒ 下面这个变量是**那个** `PgPool`，域内据此构造
  //     `createPostgresOcrStore`（`persistent: true`）；
  //   * 其余模式（`stub` / `preset_demo`）或 `real` 但无池 ⇒ 变量是 `null` ⇒ 域内用内存 store
  //     （`persistent: false`）。⛔ 不把内存实现伪装成持久化：`describe().storePersistent` 如实回报
  //     `false`，且"这个变量是 null"在装配层一眼可读。
  //     为什么不在 `real + 无池` 时整域 fail-closed：OCR 域在本基线**没有**这条产品行为（接线前
  //     `real + 无池` 一直可用内存 store），把它改成 503 属于改变既有业务语义，超出本片范围。
  //
  // ⛔ 刻意**不**写成 `deps` 的键（`store:` / `pool:`）：`tests/integration/ocr-http.mjs` 把装配行的
  //    「恰四个键（consent/egress/guards/history）＋ app.ts 不得引用 OCR 存储/提供者适配器模块」
  //    钉成结构性质，本接线用位置实参传入**同一个**池、由域内决定实现，因此那两条断言逐字保持
  //    （见证据页「既有断言 前→后」）。
  // GY-R31（#9/#10/#11 共同缺口）：deps 增 `media` **槽位**（值取注入项，缺省 undefined ⇒ 域内按
  //    `executionMode` 自建）。这是唯一一处键集变化：四键 → 五键，两条结构断言（本文件同名判据
  //    在 `tests/unit/ocr-store-pg-wiring.test.mjs` 与 `tests/integration/ocr-http.mjs`）已同步登记，
  //    只加白名单、不删原有项；`store`/`provider`/`reference` 仍不得成为装配键，import 禁项不变。
  const ocrPersistencePool = config.executionMode === 'real' ? pool : null;
  registerOcrRoutes(app, config, { guards: gatedGuards, consent: consentGate, egress: ocrEgress, history: ocrTerminalHistory, media: ocrMedia }, ocrPersistencePool);
  // GY-I01 跨 kind 作业读面/取消面：`/jobs/{id}` 与 `/jobs/{id}/cancel` 的**唯一注册点**。
  // 各域以作业源形式接入，**共 6 个**（识别 + 转写 + 审核 + 合成 + OCR + 文字问答，即下面
  // `createJobRegistry` 的 6 条 `create*JobSource` 实参）；未接入的 kind ⇒ 与「作业不存在」同形 404。
  // 必须在 registerSpeechRoutes 之后：转写服务由该插件装配并装饰为 app.speechService。
  // GY-I27 第二片：识别域取消成功后写外发取消墓碑（只增不减 ⇒ 晚到回调不可复活）。
  registerJobRoutes(app, config, guards, createJobRegistry([
    createRecognitionJobSource(
      recognitionService,
      recognitionEgress === undefined
        ? {}
        : { onCancelled: async (input) => { await recognitionEgress.cancelForJob({ ...input, reason: 'job_cancelled' }); } },
    ),
    createTranscriptionJobSource(app.speechService),
    // GY-I14（#14）审核域作业源（纯追加）：`GET /jobs/{id}` 现可返回 `kind=moderation` 的
    // 契约 `ModerationResult`；`cancel` **不提供** ⇒ 注册表以 503 PROVIDER_UNAVAILABLE 如实拒绝。
    createModerationJobSource(moderationService),
    // GY-I13（#13）合成域作业源（**纯追加，不重排上面三项**）：`GET /jobs/{id}` 现可返回
    // `kind=synthesis` 的契约 `SynthesisResult`（`tts/service.ts` 的 `inspectJob` 只读复用）。
    // GY-R27 取消片：`cancel` **已提供**（复用 `tts/service.ts` 的 `cancelJob`：`queued`/`running`
    // ⇒ `cancelled`，revision 恰好 +1；终态再取消 ⇒ 409 `OBJECT_UNAVAILABLE`），
    // `POST /jobs/{id}/cancel` 对合成作业由 503 `PROVIDER_UNAVAILABLE`（未接线）变为 200 `cancelled`。
    createSynthesisJobSource(synthesisService),
    // GY-I10（#10）标签 OCR 域作业源（**纯追加，不重排上面四项**）：`GET /jobs/{id}` 现可返回
    // `kind=ocr` 的契约 `Job`（九键、七类 `JobState` 与 `error_code` 逐类可读；读面**只读复用** OCR 域
    // 已合并的 `getJob`，域内投影本就是契约形状 ⇒ 装配点不 import 该域适配器、不新增契约字段）。
    // 此前该 kind 未接线 ⇒ 与「作业不存在」同形 404，且 `GET /ocr/{id}` 只在产出记录后可读
    // ⇒ `failed`/`timed_out` 与"仍在处理"同形。
    // `cancel` **不提供**（OCR 域本基线无取消入口）⇒ 注册表先确认作业存在，再 503
    // PROVIDER_UNAVAILABLE (`retryable`) 如实拒绝，**不伪造** `cancelled`、不谎称作业不存在。
    createOcrJobSource(app.ocrService),
    // GY-I12（#12）文字问答域作业源（**纯追加，不重排上面五项**）：`GET /jobs/{id}` 现可返回
    // `kind=answer` 的契约 `Job`（`AnswerResult.kind='answer'` 分支契约里本就有；`result` 只在
    // 作业落终态 `succeeded`/`uncertain` 且回答行存在时给出 ⇒ 与注册表的如实性不变式一致）。
    // 作业 id 是 `createTurn` 受理时写下的 `Job.id`（**与 `Turn.id` 不同**），
    // 读面按 `(job_id, owner_id)` 查轮次 ⇒ 越权与不存在**同形** `NOT_FOUND`。
    // `cancel` **不提供**（本基线无问答取消入口）⇒ 注册表先确认作业存在，再 503
    // PROVIDER_UNAVAILABLE (`retryable`) 如实拒绝，**不伪造** `cancelled`、不谎称作业不存在。
    createAnswerJobSource({
      findByJobId: async ({ userId, jobId }) => {
        const service = app.conversationService;
        if (service === null) return null;
        return service.store.findTurnByJobId(jobId, userId);
      },
    }),
  ]));
  registerAdminRoutes(app, guards, {
    content: adminContentService,
    ops: adminOpsService,
    audit: adminAuditLogService,
  });
  // GY-I06 媒体域 7 条路由的**唯一注册点**（失败即整域 503；未装配路径仍由 404 处理器兜底）。
  // GY-I27 第三片（C7）：把与识别/转写/合成/OCR **同源的那一个** `consentGate` 交给媒体域，
  // 媒体域只在 `POST /media/uploads` 上按请求体 `purpose` 用它（其余 6 条入口不挂）。
  // 缺数据库且未注入 ⇒ `consentGate === undefined` ⇒ 媒体域拿到缺省 passthrough，行为不变。
  registerMediaRoutes(app, config, guards, mediaService, { consent: consentGate });
  registerMessageRoutes(app, config, guards, messagesService);
  // GY-I16 收藏／历史 5 条路由的唯一注册点（real 模式 service 为 null ⇒ 一律 503）。
  registerFavoriteRoutes(app, config, guards, favoritesService);
  registerHistoryRoutes(app, config, guards, historyService);
  // GY-I19（#19）本片：注销/删除申请 2 条路由（`requestAccountDeletion` / `getDeletionReceipt`）
  // 的**唯一注册点**。`real` 模式 ⇒ `accountDeletion.available === false` ⇒ 这两个 operation
  // 全程 503 `PROVIDER_UNAVAILABLE`（如实失败，不回 200 空壳、不假装删除成功）。
  // 注：必需模块闭集若未注册齐，由既有协调器在**受理处**抛 `OBJECT_UNAVAILABLE`(409)
  // （`deletion-modules.mjs` 的既有语义）——本片不另加一层「假装能完成」的兜底。
  const accountDeletionWired = accountDeletion.available ? accountDeletion : null;
  registerAccountDeletionRoutes(app, config, guards, {
    service: accountDeletionWired,
    receipts: accountDeletionWired === null ? null : deletionReceipts,
    deletion: accountDeletionWired === null ? null : userDataDeletion,
    // 幂等台账用既有认证服务（24h 台账；同键同体重新签发，不回放旧 bearer）。
    authService: service,
    now: clock,
  });
  // GY-I15 社区 16 条路由的**唯一注册点**（real 模式 ⇒ service 为 null ⇒ 整域 503）。
  // 本片起：投稿/评论两条 **POST** 面（`POST /posts`、`POST /posts/:id/comments`）纳入全局开关
  // `submissions_enabled`（受控面清单里的 `createPost`/`createComment`），因此传 `gatedGuards`；
  // 其余 14 条读/改/删路由不在受控面清单里 ⇒ 闸门按 (method, 路由模板) 判**不命中即不判**，
  // 行为与 `upstream/main` 逐字相同（守卫语义与错误码次序不变）。
  // GY-R28 W10：把与识别/媒体**同源的那一个** `consentGate` 交给社区域，社区域只在投稿面
  // （`POST /posts`、`PATCH /posts/:id`、`POST /posts/:id/comments`、`PATCH /comments/:id`）
  // 用它问 `public_posting`；读/赞/举报/删除不挂。缺数据库且未注入 ⇒ `undefined` ⇒ 直通。
  registerCommunityRoutes(app, config, gatedGuards, communityService, { consent: consentGate });
  // GY-I12（#12）文字问答域 7 条路由的**唯一注册点**（契约 `operations.json` 里本域的
  // 全部 operation，逐条一一对应；未实现的相邻路径不注册 ⇒ 由 404 处理器如实兜底）。
  // 这一段刻意**排在 `registerJobRoutes` 之后**：作业源在注册表构造时就捕获了
  // `app.conversationService` 的求值闭包，而路由注册只影响 HTTP 面的可见性，两者无次序耦合。
  // `real` 且无 `DATABASE_URL` ⇒ `conversationService === null` ⇒ 整域 503（不假成功）。
  // 本片起：问答受理面（`POST /conversations/:id/turns`，operationId `createTurn`）纳入全局开关
  // `ai_enabled`（受控面清单里的 `createTurn`），因此传 `gatedGuards`；其余 6 条会话/轮次
  // 读/改/删路由不在受控面清单里 ⇒ 闸门按 (method, 路由模板) 判**不命中即不判**，行为与
  // `upstream/main` 逐字相同（守卫语义与错误码次序不变）。
  registerConversationRoutes(app, config, gatedGuards, conversationService);

  app.setNotFoundHandler((request, reply) => {
    // 404 封套的 `message` 会原样回到调用方并被其日志/崩溃上报带走，因此同样不落查询串：
    // 未匹配的 URL 可能携带被拒的坐标参数（同一 `logSafePath` 口径）。
    // 缓存头（GY-I22 F-01）不在这里写：`onSend` 钩子已按「状态码 ≥ 400 ⇒ no-store」统一补齐，
    // 本处理器只负责状态码与封套，不重复写头（见上方 `app.addHook('onSend', …)` 的说明）。
    const path = logSafePath(request.url);
    const error = new ApiError('NOT_FOUND', `未实现的路径：${request.method}${path === null ? '' : ` ${path}`}`);
    reply
      .status(error.status)
      .send(buildErrorEnvelope(error, { request_id: request.id, execution_mode: config.executionMode }));
  });

  app.setErrorHandler((error, request, reply) => {
    // 缓存头（GY-I22 F-01）：本处理器只决定**状态码与封套**，`Cache-Control: no-store` 由
    // 上方 `onSend` 钩子按「状态码 ≥ 400」统一补齐——鉴权失败的 `ApiError`、schema 校验失败、
    // Fastify 内容类型错误与 500 兜底都在同一处生效，不在此逐分支重复写头。
    const envelope = (apiError: ApiError) =>
      buildErrorEnvelope(apiError, { request_id: request.id, execution_mode: config.executionMode });

    if (error instanceof ApiError) {
      // 等待头（`Retry-After`，整数秒）的**唯一出口**：取值规则与契约依据见
      // `services/api/src/errors.ts` 的 `retryAfterSecondsFor`——429（限流）与 409
      // `REQUEST_IN_PROGRESS`（同一 Key 的请求仍在处理）必须带该头（state-contract.md:27 / :34），
      // 其余错误码（含 503/504）不写。调用点不得各自写头，这里也不写 HTTP-date 形式。
      const retryAfterSeconds = retryAfterSecondsFor(error);
      if (retryAfterSeconds !== null) reply.header('Retry-After', String(retryAfterSeconds));
      reply.status(error.status).send(envelope(error));
      return;
    }

    const statusCode = (error as { statusCode?: number }).statusCode;
    const errorCode = (error as { code?: string }).code;

    // Fastify 内容类型解析错误（非法 JSON / 内容类型 / 请求体过大）：
    // 这些是客户端请求错误，映射到契约错误码，而不是 500 缺口。
    if (typeof errorCode === 'string' && errorCode.startsWith('FST_ERR_CTP_')) {
      if (statusCode === 413) {
        reply.status(413).send(envelope(new ApiError('MEDIA_TOO_LARGE', '请求体超过大小限制')));
        return;
      }
      if (statusCode === 415) {
        reply.status(415).send(envelope(new ApiError('MEDIA_TYPE_UNSUPPORTED', '不支持的媒体类型')));
        return;
      }
      // 400：非法 JSON 请求体、空请求体、非法 Content-Length 等。
      reply.status(400).send(envelope(new ApiError('INVALID_REQUEST', '请求体格式错误')));
      return;
    }

    // Fastify schema 校验失败映射为契约 INVALID_REQUEST，保留字段明细。
    const validation = (error as { validation?: Array<{ instancePath?: string; message?: string }> }).validation;
    if (Array.isArray(validation) && validation.length > 0) {
      const apiError = new ApiError('INVALID_REQUEST', '请求校验失败', {
        details: validation.slice(0, 30).map((item) => ({
          field: (item.instancePath && item.instancePath !== '' ? item.instancePath : '/').slice(0, 80),
          code: (item.message ?? 'invalid').slice(0, 80),
        })),
      });
      reply.status(apiError.status).send(envelope(apiError));
      return;
    }

    request.log.error({ err: error }, 'unhandled error');
    // 契约 error_status_map 未定义 500 / INTERNAL_ERROR（见 docs/engineering-shell.md“契约缺口”）。
    // 不伪造契约错误码：如实返回 500，并显式标记该缺口，供监工与指挥核对。
    reply.status(500).send({
      error: {
        message: '服务器内部错误',
        retryable: false,
        details: [],
      },
      meta: {
        request_id: request.id,
        contract_version: CONTRACT_VERSION,
        execution_mode: config.executionMode,
      },
      contract_gap: 'NO_CONTRACT_CODE_FOR_500',
    });
  });

  return app;
}

/**
 * GY-R34（返修）· 把 `API_TRUST_PROXY` 的三种取值翻译成 Fastify 的 `trustProxy` 选项。
 *
 * `true` / `false` 原样交出；**跳数必须自己编译成谓词**，因为 Fastify 5 已经不再支持数字：
 * `node_modules/fastify/lib/request.js:43-62` 的 `getTrustProxyFn` 对 `typeof tp === 'number'`
 * 走「fail closed ⇒ 一律 `() => false`」分支（注释原文：hop-count-only trust cannot validate the
 * immediate peer），`@fastify/proxy-addr` 的 `compile` 对 number 直接
 * `TypeError: unsupported trust argument`。也就是说：把数字原样传下去，配置**看着生效、
 * 实际等于没配**——云托管网关后仍是全站共享一份登录额度，正是本次要修的坑。
 *
 * 谓词语义与旧版跳数一致：`hop` 是「从 socket 对端数起的第几跳」，只有第 `hop` 跳是可信代理
 * 才继续往 `X-Forwarded-For` 里取值。`hop < N` ⇒ 只信最近 N 跳、客户端地址取第 N 跳；
 * `N = 0` 与 `false` 等价。实测（`app.inject({ remoteAddress: '198.51.100.5', headers: {
 * 'x-forwarded-for': '1.2.3.4, 203.0.113.7' } })`）：`false` ⇒ `request.ip = 198.51.100.5`；
 * `(_, hop) => hop < 1` ⇒ `203.0.113.7`；`(_, hop) => hop < 2` ⇒ `1.2.3.4`；`true` ⇒ `1.2.3.4`。
 *
 * 与 `true` 的差别（也是跳数更好的地方）：`true` 信任整条链、取**最左**一项，网关只追加不覆盖时
 * 客户端自带的 `X-Forwarded-For` 会变成 `request.ip`（可伪造换额度）；跳数只信最近一跳、取**最右**
 * 一项，客户端自己写的最左项进不了 `request.ip`。代价：跳数不校验对端地址 ⇒ 容器**不能**被绕过
 * 网关直连（直连客户端自带够多跳数即可伪造），且 `N` 必须与真实跳数一致（多了 ⇒ 取到代理地址，
 * 又是共享桶）。装配点：`buildApp` 的 `Fastify({...})` 选项里与 `genReqId` **同一行**（不新增行——
 * `app.ts` 的行号是文档与台账的锚点，见 `docs/architecture/contract-status.json` 与 `tools/verify-doc-anchors.mjs`）。
 */
export function trustProxyOption(
  trustProxy: TrustProxyConfig,
): boolean | ((address: string, hop: number) => boolean) {
  if (typeof trustProxy !== 'number') return trustProxy;
  return (_address: string, hop: number) => hop < trustProxy;
}

// GY-R34 限流器同理追加在末尾，但排在识别 PG store 那行 import **之前**：那一行必须仍是本文件最后一行
// （见 tests/unit/recognitions-store-pg-wiring.test.mjs 的结构钉子）。装配点保持单行
// `createRateLimiter(...).mount(app).wrapGuards(...)`，既有行号一行不动；规则表/存储/取舍都在 rate-limit/limiter.ts 里。
import { createRateLimiter } from './rate-limit/limiter.ts';
import { createPostgresRecognitionStore } from './recognitions/store-pg.ts'; // 追加在文件末尾：app.ts 行号是契约台账锚点，顶部 import 区零插入（ESM 提升，语义等价）
