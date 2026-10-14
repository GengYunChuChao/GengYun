/**
 * Fastify 应用装配。
 *
 * 已装配：/health（运营）、游客主页科普预览（/api/v1/public/home）、
 * /api/v1 下的认证与后台认证、授权列表／授予及受限撤回路由、契约错误封套、404、
 * 个人档案与资料查询，以及 GY-I09 的识别任务闭路（/recognitions/**、/jobs/{id}[/cancel]）。
 * 其余业务路由（问答、社区、媒体等）尚未实现；未实现路径返回契约 NOT_FOUND，
 * 不伪造成功。
 */
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { CONTRACT_VERSION } from './contract.ts';
import type { AppConfig } from './config.ts';
import { ApiError, buildErrorEnvelope } from './errors.ts';
import type { PgPool } from './db/pool.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerPublicHomeRoute } from './routes/public-home.ts';
import { registerUserAuthRoutes } from './routes/auth.ts';
import { registerAdminAuthRoutes } from './routes/admin-auth.ts';
import { registerConsentRoutes } from './routes/consents.ts';
import { registerProfileRoutes } from './routes/profile.ts';
import { registerKnowledgeRoutes } from './routes/knowledge.ts';
import { registerRecognitionRoutes } from './routes/recognitions.ts';
import { registerSpeechRoutes } from './routes/speech.ts';
import { createJobRegistry } from './jobs/registry.ts';
import { createRecognitionJobSource, createTranscriptionJobSource } from './jobs/sources.ts';
import { registerJobRoutes } from './jobs/routes.ts';
import type { SpeechStore } from './speech/store.ts';
import type { SpeechProvider } from './speech/provider.ts';
import type { SpeechMediaPort } from './speech/media.ts';
import { registerOcrRoutes } from './routes/ocr.ts';
import { createMemoryAuthStore, createPostgresAuthStore, type AuthStore, type SqlExecutor } from './auth/store.ts';
import { createMemoryIdempotencyStore, createPostgresIdempotencyStore, type IdempotencyStore } from './auth/idempotency.ts';
import { STUB_LOOKUP_KEY, createWechatIdentityProvider, type WechatIdentityProvider } from './auth/wechat.ts';
import { AuthService, STUB_IDEMPOTENCY_HMAC_KEY } from './auth/service.ts';
import { createAuthGuards } from './auth/middleware.ts';
import { createRecognitionService, type RecognitionService } from './recognitions/service.ts';
import { createRecognitionProvider, type RecognitionProvider } from './recognitions/provider.ts';
import { createRecognitionMediaPort, type RecognitionMediaPort } from './recognitions/media.ts';
import { createMemoryRecognitionStore, type RecognitionStore } from './recognitions/store.ts';
import { registerSynthesisRoutes } from './routes/synthesis.ts';
import { createCheckedContentPort, type CheckedContentPort } from './tts/content.ts';
import { createSynthesisMediaPort, type SynthesisMediaPort } from './tts/media.ts';
import { createTtsProvider, type TtsProvider } from './tts/provider.ts';
import { createSynthesisService, type SynthesisService } from './tts/service.ts';
import { createMemorySynthesisStore, type SynthesisStore } from './tts/store.ts';
// GY-I18 后台域（阶段 2 装配）：路由 + 阶段 1／1b 两个已合并的服务。
import { registerAdminRoutes } from './routes/admin.ts';
import { createAdminContentService } from './admin/service.ts';
import type { AdminContentService, AdminContentServiceOptions } from './admin/service.ts';
import { createAdminOpsService } from './admin/ops/service.ts';
import type { AdminOpsService, AdminOpsServiceOptions } from './admin/ops/service.ts';
import { createAdminContentStore } from './admin/store.ts';
import { createAdminOpsStore } from './admin/ops/store.ts';
import { createAdminRuntime } from './admin/runtime.ts';
import { createFailClosedAdminServices } from './admin/fail-closed-services.ts';
// GY-I18 本片：全局开关的**跨端点真实生效**（受控输出面清单 + 守卫包装 + 投稿面装饰）。
import {
  createFeatureFlagGate,
  createFlagGatedGuards,
  createStoreFlagReader,
  flagSeedFromBaseline,
  FLAG_WIRING_BASELINE,
  type FeatureFlagGate,
} from './admin/ops/flag-gate.ts';
// GY-I18 本片：人工评审入口**空态**（无假任务/审核人/投票/专家认证）。
import { createHumanReviewDirectory, type HumanReviewDirectory } from './admin/human-review.ts';
// GY-I06 私有媒体域（#6）：存储适配器 + 服务层 + 7 条 HTTP 路由的单一注册点。
import { registerMediaRoutes } from './routes/media.ts';
import { createAppMediaService, type AppMediaService, type CommunityAttachmentCounter } from './media/service.ts';
import { resolveMediaObjectStore, type MediaObjectStore } from './media/object-store.ts';
import { createClosedContentSource, type PublishedContentSource } from './media/content-source.ts';
// GY-I27 接线单：授权中间件与撤回/注销消费者的 HTTP/服务侧适配（协议层在 packages/privacy/**）。
import { createPostgresConsentGate, type ConsentGate } from './privacy/egress.ts';
import { createPostgresConsentService, type EgressRevoker } from './privacy/consent-pg.ts';
import { createPostgresExportLedger, createPostgresPrivacyPorts } from './privacy/ledger-pg.ts';
import { createMediaJobEgress, type MediaJobEgress } from './privacy/task-egress.ts';
import { createEgressRevoker, createInFlightGuard } from '../../../packages/privacy/in-flight.mjs';
import { registerMessageRoutes } from './routes/messages.ts';
import { createMessagesService, type MessagesService } from './messages/service.ts';
import { createMemoryMessagesStore, type MessagesStore } from './messages/store.ts';
import { createUnwiredReferencePort, type MessageReferencePort } from './messages/reference.ts';
// GY-I16 收藏与可浏览的识别历史（#16）：本片两个子域 + 注销删除接线（F13 协议复用）。
import { registerFavoriteRoutes } from './routes/favorites.ts';
import { registerHistoryRoutes } from './routes/history.ts';
import { createFavoritesService, type FavoritesService } from './favorites/service.ts';
import { createMemoryFavoritesStore, type FavoritesStore } from './favorites/store.ts';
import { createHistoryService, type HistoryService } from './history/service.ts';
import { createMemoryHistoryStore, type HistoryStore } from './history/store.ts';
import { createWiredHistoryJobPort, createUnwiredHistoryJobPort, type HistoryJobPort } from './history/job.ts';
import { createUnwiredHistoryCascadePort, type HistoryCascadePort } from './history/cascade.ts';
import { createUnwiredVisibilityPort, type VisibilityPort } from './targetref/visibility.ts';
import {
  createUserDataDeletion,
  type BackupPurgePort,
  type UserDataDeletionRegistry,
} from './privacy/user-data-deletion.ts';
// GY-I15 社区域（#15）阶段 2：服务层 + 装配层接线（关联可用性端口、事件投递、下架观察器）。
import { registerCommunityRoutes } from './routes/community.ts';
import { createCommunityService, type CommunityService } from './community/service.ts';
import { createMemoryCommunityStore, type CommunityStore } from './community/store.ts';
import { createLocalPseudonymousAuthorDirectory } from './community/authors.ts';
import type { AuthorDirectory } from './community/types.ts';
import type { KnowledgeAvailabilityPort } from './community/knowledge.ts';
import {
  createMessagesCommunityEventsPort,
  createUnwiredCommunityEventsPort,
  type CommunityEventsPort,
} from './community/events.ts';
import { withTakedownObserver } from './community/takedown.ts';
import { IDEMPOTENCY_TTL_SECONDS } from './auth/idempotency.ts';
// GY-I14（#14）审核域：**追加式**装配（只加 import + 一个可选注入项 + 一处作业源注册 + 一处 decorate）。
// 跨线披露：本块为纯追加（不改既有域行为、不重排既有装配）；回退 = 删除本块四处。
import { createModerationService } from './moderation/service.ts';
import type { ModerationService } from './moderation/service.ts';
import { createModerationJobSource } from './moderation/job-source.ts';
import type { ContentAuthorityPort } from './moderation/types.ts';

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
     * GY-I15 社区服务（#15）。**未接线**（`real` 模式：真实持久存储未交付）
     * 时为 `null` ⇒ 16 条社区路由一律 503 `PROVIDER_UNAVAILABLE`，不返回空页、不假成功。
     */
    communityService: CommunityService | null;
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
  /** 测试注入：替换合成产物存储端口（默认 real=未接线 fail-closed，其余=明确标注的替身）。 */
  synthesisMedia?: SynthesisMediaPort;
  /** 测试注入：替换「已核对内容」读取端口（默认按 executionMode；stub 下为空替身源）。 */
  synthesisContent?: CheckedContentPort;
  /** 合成任务截止时间（毫秒），测试可缩短以真实观测 timed_out。 */
  synthesisJobDeadlineMs?: number;
  // GY-I18 后台域注入项。**全部可选**：不传时与接线前**逐字节同行为** ——
  // 内容/运营存储为空种子，`AdminJobPort` 与社区帖子端口**未接线**，
  // 因此作业读/取消与隐藏帖子按服务层 fail-closed 返回 503（不返回空页、不伪造状态）。
  /** 测试注入：后台资料存储（默认新建内存 store）。 */
  adminInjection?: {
    contentStore?: AdminContentServiceOptions['store'];
    opsStore?: AdminOpsServiceOptions['store'];
    jobPort?: AdminOpsServiceOptions['jobPort'];
    communityStore?: AdminOpsServiceOptions['community'];
    /** 注入 flag 语义分类表：用于验证"含放宽语义 ⇒ 拒绝接线"（默认出厂表）。 */
    flagEffects?: AdminOpsServiceOptions['flagEffects'];
  };
  // GY-I06 媒体域注入项（**全部可选**）：不传时按 executionMode 自建 ——
  // `real` ⇒ 未接线对象存储（整域 fail-closed 503），`stub`/`preset_demo` ⇒ 明确标注的替身。
  /** 测试注入：替换对象存储端口（默认 real=未接线 fail-closed，其余=明确标注的替身）。 */
  mediaObjectStore?: MediaObjectStore;
  /** 测试注入：替换公开内容来源（默认为**关闭**：社区取图统一 404，不误放行）。 */
  mediaContentSource?: PublishedContentSource;
  /** 测试注入：替换「每帖 ≤3 图」槽位计数器（默认 real=未接线拒绝，其余=保守替身）。 */
  mediaAttachmentCounter?: CommunityAttachmentCounter;
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
  };
  // GY-I16 收藏（#16）注入项。**全部可选**：不传时与接线前**逐字节同行为** —— 收藏域新建
  // 内存 store、可见性端口**未接线**（一律 unavailable，绝不假装可用）；real 模式下整域关闭。
  favoritesInjection?: {
    store?: FavoritesStore;
    visibility?: VisibilityPort;
  };
  // GY-I16 历史（#16）注入项。**全部可选**：不传时——历史域新建内存 store；可见性端口未接线；
  // **任务状态端口默认接线到已合并的公开读取口**（`recognitionService.getJob` /
  // `ocrService.getJob`）⇒ 读取时能拿到真实任务状态（失败/超时/取消原样可见）；
  // 关联删除级联端口未接线（如实回 `unwired`，不谎称已启动）。
  historyInjection?: {
    store?: HistoryStore;
    visibility?: VisibilityPort;
    job?: HistoryJobPort;
    cascade?: HistoryCascadePort;
  };
  /** GY-I16 注销删除注入项：备份副本清除端口（缺省未接线 ⇒ `backupState: 'pending'`，不谎称完成）。 */
  userDataDeletionInjection?: { backupPurge?: BackupPurgePort };
  // GY-I15 社区域注入项（阶段 2 装配）。**全部可选**：不传时——
  //   * 存储用空的进程内内存 store（`real` 模式下整域 503，见下）；
  //   * 作者投影用**明确标注的本地假名投影**（不是真实 `public_authors`）；
  //   * 「杂草／药剂关联」可用性端口**未接线** ⇒ 新增/替换引用一律 `OBJECT_UNAVAILABLE`；
  //     （真实接线需要请求会话身份进入社区服务，属跨线决定，见 PR 正文"未取得"）
  //   * 事件端口接到本进程的消息服务公开创建口；消息服务为 null（real）时端口 `wired:false`。
  communityInjection?: {
    store?: CommunityStore;
    authors?: AuthorDirectory;
    knowledge?: KnowledgeAvailabilityPort;
    events?: CommunityEventsPort;
    /** 测试注入：替换发布闸门（默认出厂规则集；注入自定义规则集会真实改变派生 `rule_version`）。 */
    gate?: Parameters<typeof createCommunityService>[0]['gate'];
  };
  /**
   * **仅测试注入**：日志输出的写入目标，用于断言「日志不含坐标等敏感原文」。生产装配
   * （`services/api/src/server.ts`）**永不传入**；不传时日志仍写进程 stdout，级别、格式与
   * 目标逐字节保持接线前行为（只多一条 `serializers.req`，见 `requestLogFields`）。
   */
  logStream?: { write(chunk: string): void };
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

/** 构建已装配的 Fastify 实例（未监听端口，便于测试用 app.inject）。 */
export function buildApp({ config, pool = null, now, store, idempotency, wechat, consentGrantTestOptions, recognitionStore, recognitionProvider, recognitionMedia, recognitionJobDeadlineMs, speechStore, speechProvider, speechMedia, speechJobDeadlineMs, synthesisStore, synthesisProvider, synthesisMedia, synthesisContent, synthesisJobDeadlineMs, adminInjection, mediaObjectStore: mediaObjectStoreOption, mediaContentSource, mediaAttachmentCounter, privacyInjection, messagesInjection, moderationInjection, favoritesInjection, historyInjection, userDataDeletionInjection, communityInjection, logStream }: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    // 日志是**共享出口**：请求日志发生在路由与 schema 校验之前，路由层拒绝（400）救不回已经
    // 写下的日志，因此坐标不进日志必须在这里做（见 `requestLogFields`）。
    logger: config.logLevel === 'silent' ? false : {
      level: config.logLevel,
      serializers: { req: requestLogFields },
      // 仅测试注入；不传时逐字节保持默认行为（写进程 stdout，不新建文件、不改级别与格式）。
      ...(logStream === undefined ? {} : { stream: logStream }),
    },
    genReqId: () => randomUUID(),
    // 契约 WechatLoginInput / AdminLoginInput 为 additionalProperties:false；
    // Fastify 默认 removeAdditional:true 会静默剔除多余字段，这里改为拒绝，
    // 以确保「客户端不可指定 openid / 角色 / 用户 id」在 API 层被显式拦下（400）。
    ajv: { customOptions: { removeAdditional: false } },
  });

  const clock = now ?? (() => new Date());
  const messagesService = config.executionMode === 'real' ? null : createMessagesService({
    store: messagesInjection?.store ?? createMemoryMessagesStore({ now: () => clock().getTime() }),
    reference: messagesInjection?.reference ?? createUnwiredReferencePort(),
    signingKey: config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY,
    now: clock,
    idempotencyTtlMs: IDEMPOTENCY_TTL_SECONDS * 1000,
  });
  // GY-I14（#14）审核域：`real` ⇒ fail-closed 整域（未授权真实 tms/ims 供应商）；其余模式 ⇒ 替身端口
  // （替身只回报"无结论"⇒ 隔离）。**应用装配路径永不注入真实适配器端口**（零端口注入）。
  const moderationService: ModerationService =
    moderationInjection?.service ??
    createModerationService({
      executionMode: config.executionMode,
      ...(moderationInjection?.ports === undefined ? {} : { ports: moderationInjection.ports }),
      ...(moderationInjection?.authority === undefined ? {} : { authority: moderationInjection.authority }),
      ...(moderationInjection?.callbackKey === undefined ? {} : { callbackKey: moderationInjection.callbackKey }),
    });
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
  const guards = createAuthGuards({ store: authStore, now: clock });

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
  const recognitionProviderResolved =
    recognitionProvider ??
    createRecognitionProvider({
      executionMode: config.executionMode,
      endpoint: process.env['RECOGNITION_PROVIDER_URL'] ?? null,
      apiKey: process.env['RECOGNITION_PROVIDER_KEY'] ?? null,
    });
  const recognitionService = createRecognitionService({
    store: recognitionStore ?? createMemoryRecognitionStore(),
    // GY-I27 第二片：识别域的提供者包装在**装配处**完成（该域的服务由本文件构建）；
    // `real` 才接管派发，替身/演示原样返回（不记账）。
    provider: recognitionEgress === undefined
      ? recognitionProviderResolved
      : recognitionEgress.provider(recognitionProviderResolved, 'recognize'),
    media: recognitionMedia ?? createRecognitionMediaPort(config.executionMode),
    idempotencyHmacKey: config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY,
    now: clock,
    ...(recognitionJobDeadlineMs === undefined ? {} : { jobDeadlineMs: recognitionJobDeadlineMs }),
  });

  // GY-I13 合成域：real 走 fail-closed 提供者（缺凭据受理前 503，绝不回退替身）；产物存储与
  // 「已核对内容」读取端口同样按执行模式解析（real 未接线 ⇒ 受理前拒绝）。
  // **应用装配路径永不注入真实适配器端口**：真实发送只能经 `createLiveTtsProvider(ports)` 触达，
  // 而本文件不 import 它（零端口注入）。
  const synthesisService = createSynthesisService({
    store: synthesisStore ?? createMemorySynthesisStore(),
    provider: synthesisProvider ?? createTtsProvider({ executionMode: config.executionMode }),
    media: synthesisMedia ?? createSynthesisMediaPort(config.executionMode),
    content: synthesisContent ?? createCheckedContentPort(config.executionMode),
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
  // GY-I15 社区域（#15）阶段 2 装配。
  //
  // **real 模式 ⇒ 社区整域 fail-closed**（与 GY-I18 后台域、GY-I17 消息域同一口径）：
  // 社区 store 是**内存**实现（`persistent:false`），真实持久存储未交付。若在 `real` 下把它交给
  // 服务层，写操作会返回**成功封套**而落点只是易失内存 —— 即在"真实模式"下声称投稿成功、
  // 重启即丢。因此这里在**运行时**拒绝（503 `PROVIDER_UNAVAILABLE`, retryable），
  // 而不是靠文档披露。将来接真实持久 store 必须在这里**显式放行**（一次可审查的接线变更）。
  //
  // **事件投递**：只把消息域的公开创建口 `appendMessage` 作为**结构性端口**传进来
  // （不 import 消息域、不改其实现）。消息服务在 real 下为 `null` ⇒ 事件端口 `wired:false`。
  //
  // **下架观察器**：交给后台（GY-I18）的社区帖子端口套一层观察器，使
  // `POST /admin/posts/{id}/hide` 生效后能投递「下架」事件；观察器只发通知，
  // 不改 visibility、不改错误映射（权威判定仍在社区 store 的 CAS 里）。
  // ---------------------------------------------------------------------------
  const communitySigningKey = config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY;
  const communityStore = communityInjection?.store ?? createMemoryCommunityStore({ now: () => clock().getTime() });
  const communityEvents: CommunityEventsPort =
    communityInjection?.events ??
    (messagesService === null
      ? createUnwiredCommunityEventsPort('消息服务未接线（real 模式）：审核结果/下架事件无法投递')
      : createMessagesCommunityEventsPort({ messages: messagesService }));
  const communityRealUnwired = config.executionMode === 'real';
  let communityService: CommunityService | null;
  if (communityRealUnwired) {
    const reason = 'real 模式未接真实持久后端：社区业务不可用（拒绝以内存 store 返回成功封套）';
    communityService = null;
    app.log.warn({ executionMode: config.executionMode }, `GY-I15 社区域：${reason} ⇒ 16 条社区路由一律 503 PROVIDER_UNAVAILABLE`);
  } else {
    communityService = createCommunityService({
      store: communityStore,
      // **必填**：不提供默认值，避免某个接线点忘了接作者来源时悄悄用假名当真实作者。
      authors: communityInjection?.authors ?? createLocalPseudonymousAuthorDirectory(),
      gate: communityInjection?.gate,
      knowledge: communityInjection?.knowledge,
      events: communityEvents,
      signingKey: communitySigningKey,
      now: clock,
    });
  }
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
  const featureFlagGate = createFeatureFlagGate({
    reader: createStoreFlagReader(adminOpsStore),
    armed: !adminRealUnwired,
  });
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
  // （`adminRealUnwired` 已在上方与开关门一并判定：它同时决定后台域是否 fail-closed
  //  以及开关门是否有权威来源。）

  let adminContentService: AdminContentService;
  let adminOpsService: AdminOpsService;
  if (adminRealUnwired) {
    const reason = 'real 模式未接真实持久后端：后台业务不可用（拒绝以内存 store 返回成功封套）';
    const failClosed = createFailClosedAdminServices(reason);
    adminContentService = failClosed.content;
    adminOpsService = failClosed.ops;
    app.log.warn({ executionMode: config.executionMode }, `GY-I18 后台域：${reason} ⇒ 34 条后台路由一律 503 PROVIDER_UNAVAILABLE`);
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
      jobPort: adminInjection?.jobPort,
      // GY-I15 接线：后台 `hidePost` 用社区**同一份** store（默认已套下架观察器）。
      community: communityPostPortForAdmin,
      flagEffects: adminInjection?.flagEffects,
    });
  }

  // GY-I06 私有媒体域（#6）：契约 7 个 operationId 的唯一装配点。
  //
  // **零真实存储注入**：对象存储端口按执行模式解析 —— `real` 一律 `unwired`（整域 fail-closed
  // 503 PROVIDER_UNAVAILABLE，绝不把内存/替身存储记成真实持久化），`stub`/`preset_demo` 用
  // **明确标注的替身**（句柄域名 `substitute.invalid`，不在响应里冒充真实网关）。
  // 将来接真实对象存储必须在**这里显式**改为传入 `createS3CompatibleObjectStore(...)`
  // ——判据是端口的 `kind`，不是任何自述持久化的布尔标志（同监工对 #121 的 P1 口径）。
  // 公开内容来源默认**关闭**：社区取图统一 404，不误放行；真实来源属社区/审核线，跨线接线。
  const mediaObjectStore = mediaObjectStoreOption ?? resolveMediaObjectStore({ executionMode: config.executionMode });
  const mediaService = createAppMediaService({
    executionMode: config.executionMode,
    objectStore: mediaObjectStore,
    tokenSecret: config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY,
    contentSource: mediaContentSource ?? createClosedContentSource(),
    ...(mediaAttachmentCounter === undefined ? {} : { attachmentCounter: mediaAttachmentCounter }),
    now: clock,
  });

  // GY-I16 收藏与可浏览的识别历史（#16）：本片两个子域的唯一装配点。
  //
  // **real 模式整体关闭**（与本仓「real 永远 fail-closed、严禁静默回退替身」一致）：
  // 两域当前只有**内存** store，若在 real 下仍交出服务层，写操作会返回成功封套而落点易失
  // —— 那是"在真实模式下声称成功、重启即丢"。因此 real ⇒ 服务为 `null` ⇒ 5 条路由 503
  // PROVIDER_UNAVAILABLE。将来接真实持久 store 时必须**在这里显式放行**（一次可审查的变更）。
  //
  // **引用可用性端口默认未接线**（`createUnwiredVisibilityPort`）：一律 `unavailable`，
  // **绝不**返回 `'available'` 来"默认可用"（同 #17 消息域口径）。这直接落实 issue #16
  // 「隐藏／失效／注销不因缓存或旧链接重新公开」——服务端在没有真实可见性核验前不作出任何
  // "可用"陈述；真实接线 = 在这里把一个 `VisibilityPort` 传进来。
  //
  // **任务状态端口默认接线到已合并的公开读取口**：`recognitionService.getJob`（#9）与
  // `ocrService.getJob`（#10）—— 只调用公开方法、不改他人文件。这样历史列表/详情的
  // `job_state` 在读取时能取到**实时**状态（失败/超时/取消原样可见），核不到时才退回入库值。
  // `ocrService` 在下方 `registerOcrRoutes` 时才被装饰，这里只捕获闭包、请求期才解析。
  const favoritesStore = favoritesInjection?.store ?? createMemoryFavoritesStore({ now: () => clock().getTime() });
  const historyStore = historyInjection?.store ?? createMemoryHistoryStore({ now: () => clock().getTime() });
  const favoritesVisibility = favoritesInjection?.visibility ?? createUnwiredVisibilityPort();
  const historyVisibility = historyInjection?.visibility ?? createUnwiredVisibilityPort();
  const historyJobPort: HistoryJobPort =
    historyInjection?.job ??
    createWiredHistoryJobPort({
      note: '任务状态端口接线到已合并的公开读取口：recognitionService.getJob（#9）/ ocrService.getJob（#10）',
      resolve: async ({ kind, jobId, userId }) => {
        if (kind === 'recognition') return app.recognitionService.getJob({ userId, jobId });
        return app.ocrService.getJob({ userId, jobId });
      },
    });
  const historyCascadePort: HistoryCascadePort = historyInjection?.cascade ?? createUnwiredHistoryCascadePort();
  const favoritesService =
    config.executionMode === 'real'
      ? null
      : createFavoritesService({
          store: favoritesStore,
          visibility: favoritesVisibility,
          signingKey: config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY,
          now: clock,
        });
  const historyService =
    config.executionMode === 'real'
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
  const userDataDeletion = createUserDataDeletion({
    favoritesStore,
    historyStore,
    ...(userDataDeletionInjection?.backupPurge === undefined
      ? {}
      : { backupPurge: userDataDeletionInjection.backupPurge }),
  });

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
  app.decorate('featureFlagGate', featureFlagGate);
  app.decorate('humanReviewDirectory', humanReviewDirectory);
  app.decorate('mediaService', mediaService);
  app.decorate('mediaObjectStore', mediaObjectStore);
  app.decorate('messagesService', messagesService);
  app.decorate('moderationService', moderationService);
  app.decorate('favoritesService', favoritesService);
  app.decorate('historyService', historyService);
  app.decorate('userDataDeletion', userDataDeletion);
  app.decorate('communityService', communityService);

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
  registerProfileRoutes(app, config, pool, guards);
  // 本片起：以下五个域的输出面受**全局开关**控制（受控面清单见 `admin/ops/flag-gate.ts`），
  // 因此传入 `gatedGuards`（= 原守卫 + 开关门；先鉴权、后判开关）。守卫链语义与错误码次序不变。
  // 合并口径（与 `upstream/main` 的 GY-I27 外发账本接线**两侧全保留**）：
  // 保留 main 的调用签名与 `egress` 依赖，只把 `guards` 换成 `gatedGuards` —— 两者互不替代。
  registerKnowledgeRoutes(app, config, pool, gatedGuards);
  registerRecognitionRoutes(app, config, gatedGuards, recognitionService, { consent: consentGate, egress: recognitionEgress });
  registerSpeechRoutes(app, config, { guards: gatedGuards, store: speechStore, provider: speechProvider, media: speechMedia, jobDeadlineMs: speechJobDeadlineMs, consent: consentGate, egress: speechEgress });
  registerSynthesisRoutes(app, config, gatedGuards, synthesisService, consentGate);
  registerOcrRoutes(app, config, { guards: gatedGuards, consent: consentGate, egress: ocrEgress });
  // GY-I01 跨 kind 作业读面/取消面：`/jobs/{id}` 与 `/jobs/{id}/cancel` 的**唯一注册点**。
  // 各域以作业源形式接入（本片：识别域 + 转写域）；未接线的 kind ⇒ 与「作业不存在」同形 404。
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
  ]));
  registerAdminRoutes(app, guards, { content: adminContentService, ops: adminOpsService });
  // GY-I06 媒体域 7 条路由的**唯一注册点**（失败即整域 503；未装配路径仍由 404 处理器兜底）。
  registerMediaRoutes(app, config, guards, mediaService);
  registerMessageRoutes(app, config, guards, messagesService);
  // GY-I16 收藏／历史 5 条路由的唯一注册点（real 模式 service 为 null ⇒ 一律 503）。
  registerFavoriteRoutes(app, config, guards, favoritesService);
  registerHistoryRoutes(app, config, guards, historyService);
  // GY-I15 社区 16 条路由的**唯一注册点**（real 模式 ⇒ service 为 null ⇒ 整域 503）。
  // 本片起：投稿/评论两条 **POST** 面（`POST /posts`、`POST /posts/:id/comments`）纳入全局开关
  // `submissions_enabled`（受控面清单里的 `createPost`/`createComment`），因此传 `gatedGuards`；
  // 其余 14 条读/改/删路由不在受控面清单里 ⇒ 闸门按 (method, 路由模板) 判**不命中即不判**，
  // 行为与 `upstream/main` 逐字相同（守卫语义与错误码次序不变）。
  registerCommunityRoutes(app, config, gatedGuards, communityService);

  app.setNotFoundHandler((request, reply) => {
    // 404 封套的 `message` 会原样回到调用方并被其日志/崩溃上报带走，因此同样不落查询串：
    // 未匹配的 URL 可能携带被拒的坐标参数（同一 `logSafePath` 口径）。
    const path = logSafePath(request.url);
    const error = new ApiError('NOT_FOUND', `未实现的路径：${request.method}${path === null ? '' : ` ${path}`}`);
    reply
      .status(error.status)
      .send(buildErrorEnvelope(error, { request_id: request.id, execution_mode: config.executionMode }));
  });

  app.setErrorHandler((error, request, reply) => {
    const envelope = (apiError: ApiError) =>
      buildErrorEnvelope(apiError, { request_id: request.id, execution_mode: config.executionMode });

    if (error instanceof ApiError) {
      // 状态协议：同键请求仍在处理时，409 带 Retry-After（秒），等待后可重试原请求。
      if (error.code === 'REQUEST_IN_PROGRESS') reply.header('Retry-After', '1');
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
