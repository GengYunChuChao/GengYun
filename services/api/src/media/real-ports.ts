/**
 * 媒体域 · 真实端口接线（GY-R28 · W2）。
 *
 * 上游断点（`docs/verification/gy-r28-w1-provider-wiring-20261021.md`）：W1 已把 TTS/OCR/ASR 的提供者
 * 接线做完，但媒体域在 `real` 下仍是**整域 fail-closed**，于是所有「需要真实媒体字节」的受理在提供者
 * 闸门之后落到 `409 OBJECT_UNAVAILABLE`。根因不是缺适配器（S3 适配器早已在 main，R27-S8 已逐字节复算
 * SigV4），而是**没有任何装配点把真实适配器与「显式批准」一起交给媒体域**，且 `config` 从没把
 * `OBJECT_STORAGE_*` 折算成结构化配置。
 *
 * 本文件只做三件事，且**只做这三件**：
 *   1. 把 `AppConfig` 里的真实对象存储配置 + 生产入口铸造的显式批准能力，折算成媒体域的装配选项；
 *   2. 用**闭集拒绝原因**把「形状对但没资格接线」的输入挡在装配之前（拒绝 ⇒ 契约码闭集
 *      `PROVIDER_UNAVAILABLE`、`retryable: false`，与既有 503 语义一致，不新造错误码）；
 *   3. 把「怎么才算一次显式运维动作」写死成**唯一启动参数**，让接线决定可 grep、可审查。
 *
 * ⛔ 三条不得越过的边界：
 *   - **不读 ambient env**：配置一律从已解析的 `config` 取（`media/**` 在
 *     `tests/unit/media-real-mode-fail-closed.test.mjs` 的 ambient env 审计里一次都不许读）；
 *   - **不伪造批准能力**：本文件只在 {@link resolveMediaRealPorts} 里调用一次
 *     `approveRealMediaWiring`，且它的触发条件是运维显式给出的启动参数；
 *   - **零注入时行为逐字节不变**：没有启动参数 ⇒ {@link resolveMediaRealPorts} 返回 `null` ⇒
 *     装配层不传任何媒体选项 ⇒ 走 main 的既有 fail-closed（`REAL_MEDIA_APPROVAL_REQUIRED_REASON`）。
 */
import {
  resolveMediaObjectStore,
  type MediaObjectStore,
  type ObjectStorageConfig,
} from './object-store.ts';
import {
  approveRealMediaWiring,
  DEFAULT_MEDIA_ACCESS_GRANT_ORIGIN,
  isRealMediaWiringApproved,
  normalizeMediaAccessGrantOrigin,
  type RealMediaWiringApproval,
} from './service.ts';

/**
 * 唯一的接线启动参数（逐字、必须整串匹配 `process.argv` 的某一项）。
 *
 * 选「启动参数」而不是环境变量的原因：环境变量在容器/CI 里极易被顺手带上并**长期生效**，
 * 而启动参数是一次性的、写进部署清单与进程列表就能被审出来；且 `config.ts` 的 ambient env
 * 面不因此扩张一个键。
 */
export const MEDIA_REAL_WIRING_FLAG = '--approve-real-media-wiring';

/**
 * 媒体元数据的持久化口径。
 *
 * ⚠️ 本修订**只有** `process_memory` 可构造：记录（owner/版本/rawRef/derivativeRef）、授权句柄与
 * 幂等键仍在进程内 Map/Set 里，**重启即丢**。因此「上传 → complete → 读」链路在**进程存活期内**
 * 成立，跨重启不成立（对象仍在桶里，但记录没了 ⇒ 对象变成不可达的孤儿）。
 * PG 化是**生产长期开启的前置条件**，且**不需要新迁移号**：`media` / `media_derivatives` 两张表
 * 早在 `services/api/db/migrations/0001_initial_schema.sql:171/192` 就已存在（实测：全新库跑满
 * 26 个迁移后 `information_schema` 里 `media` / `media_derivatives` / `content_media_refs` /
 * `community_media_grants` 四张表齐备）。真正缺的是 PG 仓储 + `media.object_ref_cipher` 的
 * 加密键接线 + 幂等表落库 + `app.ts` 装配（受结构断言约束），见证据页
 * `docs/verification/gy-r28-w2-media-ports-20261021.md` 的「剩余断点」。
 * 本字面量在这里的作用是让每个装配点**显式承认**这个限制，而不是默默假设已持久化。
 */
export type MediaPersistenceMode = 'process_memory';

/** 装配期拒绝原因（闭集）。对外一律折算成 `PROVIDER_UNAVAILABLE`。 */
export const MEDIA_REAL_WIRING_REFUSALS = [
  /** 启动参数给了，但执行模式不是 `real`（stub/preset_demo 下没有「真实存储」可言）。 */
  'execution_mode_not_real',
  /** 启动参数给了，但 `OBJECT_STORAGE_*` 四键不齐或非法 ⇒ `config.objectStorage === null`。 */
  'object_storage_not_configured',
  /** 访问网关原点仍是占位域（`.invalid`）：句柄解析不出任何主机，等于没接线。 */
  'access_grant_origin_not_deployable',
  /** 传入的不是由 `approveRealMediaWiring` 铸造的批准能力（形状/派生/克隆一律拒绝）。 */
  'approval_not_minted',
  /** 对象存储端口不是 S3 兼容适配器（替身/未接线端口不得冒充真实存储）。 */
  'object_store_not_s3_compatible',
  /** 持久化口径不是本修订支持的值（eg. 将来传入 `postgres` 而存储层尚未接线）。 */
  'persistence_unsupported',
] as const;

export type MediaRealWiringRefusal = (typeof MEDIA_REAL_WIRING_REFUSALS)[number];

/** 拒绝原因 ⇒ 契约错误码（闭集；**不新造码**）。 */
export const MEDIA_REAL_WIRING_REFUSAL_ERROR_CODES = {
  execution_mode_not_real: 'PROVIDER_UNAVAILABLE',
  object_storage_not_configured: 'PROVIDER_UNAVAILABLE',
  access_grant_origin_not_deployable: 'PROVIDER_UNAVAILABLE',
  approval_not_minted: 'PROVIDER_UNAVAILABLE',
  object_store_not_s3_compatible: 'PROVIDER_UNAVAILABLE',
  persistence_unsupported: 'PROVIDER_UNAVAILABLE',
} as const satisfies Record<MediaRealWiringRefusal, string>;

/**
 * 装配期接线错误。
 *
 * 生产入口里它是**启动失败**（进程拒绝在半接线状态起来，`exitCode != 0`）；只在对已构造对象做
 * 形状校验的调用方（测试/嵌入）里才会被折算成 503 `PROVIDER_UNAVAILABLE`。
 */
export class MediaRealWiringError extends Error {
  readonly refusal: MediaRealWiringRefusal;

  constructor(refusal: MediaRealWiringRefusal, message: string) {
    super(`${message}（接线拒绝：${refusal}）`);
    this.name = 'MediaRealWiringError';
    this.refusal = refusal;
  }

  /** 对外契约码（闭集里的唯一取值）。 */
  get errorCode(): (typeof MEDIA_REAL_WIRING_REFUSAL_ERROR_CODES)[MediaRealWiringRefusal] {
    return MEDIA_REAL_WIRING_REFUSAL_ERROR_CODES[this.refusal];
  }

  /** 对外 `retryable`：接线问题重试无用（与既有 fail-closed 同口径）。 */
  get retryable(): false {
    return false;
  }
}

/** 装配所需的部署配置面（结构类型；媒体域**不**依赖 `config.ts`，避免反向耦合）。 */
export interface MediaRealDeploymentConfig {
  executionMode: string;
  objectStorage: ObjectStorageConfig | null;
  mediaAccessGrantOrigin: string | null;
}

/** 真实端口三件套（全必填、无默认值：任何一项缺失都是编译期错误，而不是运行期默认）。 */
export interface MediaRealPorts {
  /** 已构造的 S3 兼容端口（真实字节唯一去处）。 */
  readonly objectStore: MediaObjectStore;
  /** 生产入口铸造的显式批准能力（媒体域只认 `WeakSet` 里的对象身份）。 */
  readonly approval: RealMediaWiringApproval;
  /** 元数据持久化口径（审计回显；见 {@link MediaPersistenceMode} 的重启即丢说明）。 */
  readonly persistence: MediaPersistenceMode;
}

/**
 * 校验并组装真实端口（**不铸造批准能力**，只校验「有人已经显式铸造过」）。
 *
 * 拒绝顺序固定（便于判据逐条断言）：批准能力 → 持久化口径 → 端口 kind。
 */
export function createMediaRealPorts(input: {
  objectStore: MediaObjectStore;
  approval: RealMediaWiringApproval;
  persistence: MediaPersistenceMode;
}): MediaRealPorts {
  if (!isRealMediaWiringApproved(input.approval)) {
    throw new MediaRealWiringError(
      'approval_not_minted',
      '缺少由 approveRealMediaWiring 铸造的批准能力：拒绝把未获批的端口接成真实媒体域',
    );
  }
  if (input.persistence !== 'process_memory') {
    throw new MediaRealWiringError(
      'persistence_unsupported',
      '本修订只支持 process_memory 持久化口径（PG 存储层尚未接线）',
    );
  }
  if (input.objectStore.kind !== 's3_compatible') {
    throw new MediaRealWiringError(
      'object_store_not_s3_compatible',
      `对象存储端口 kind=${JSON.stringify(input.objectStore.kind)}，不是 s3_compatible：替身/未接线端口不得冒充真实存储`,
    );
  }
  return Object.freeze({
    objectStore: input.objectStore,
    approval: input.approval,
    persistence: input.persistence,
  });
}

/**
 * 把真实端口折算成 `buildApp` 的装配选项（只产出这两个键）。
 *
 * `accessGrantOrigin` **不在这里产出**：它由 `config.mediaAccessGrantOrigin` 经 `buildApp` 转发，
 * 本文件不改写它（见 `app.ts` 媒体装配段）。
 */
export function mediaRealPortsAssemblyOptions(ports: MediaRealPorts): {
  mediaObjectStore: MediaObjectStore;
  realMediaApproval: RealMediaWiringApproval;
} {
  // 再校验一次身份：装配选项是**跨函数传递的普通对象**，任一层都可能被重新拼装。
  if (!isRealMediaWiringApproved(ports.approval)) {
    throw new MediaRealWiringError('approval_not_minted', '装配选项里的批准能力不是铸造产物');
  }
  return { mediaObjectStore: ports.objectStore, realMediaApproval: ports.approval };
}

/**
 * 生产入口解析：**唯一**决定「这次启动要不要接真实媒体域」的地方。
 *
 * - 没有 {@link MEDIA_REAL_WIRING_FLAG} ⇒ 返回 `null`（不注入任何媒体选项 ⇒ 与 main 逐字节一致）；
 * - 有该参数 ⇒ 逐条前置校验（模式 / 配置齐备 / 网关原点可部署），任一条不过就**抛**
 *   {@link MediaRealWiringError}，让进程拒绝半接线启动；
 * - 通过后**铸造**批准能力，并构造 S3 兼容端口。
 *
 * 该函数是 `(config, argv)` 的纯函数：不读 env、不做 IO（对象存储调用发生在请求期，不在这里）。
 */
export function resolveMediaRealPorts(input: {
  config: MediaRealDeploymentConfig;
  argv: readonly string[];
}): MediaRealPorts | null {
  if (!input.argv.includes(MEDIA_REAL_WIRING_FLAG)) return null;

  const { config } = input;
  if (config.executionMode !== 'real') {
    throw new MediaRealWiringError(
      'execution_mode_not_real',
      `启动参数 ${MEDIA_REAL_WIRING_FLAG} 只在 APP_EXECUTION_MODE=real 下有意义，实际为 ${JSON.stringify(config.executionMode)}`,
    );
  }
  if (config.objectStorage === null) {
    throw new MediaRealWiringError(
      'object_storage_not_configured',
      '缺少合法的 OBJECT_STORAGE_ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY（四键齐备且为 https endpoint）',
    );
  }
  assertAccessGrantOriginDeployable(config.mediaAccessGrantOrigin);

  const objectStore = resolveMediaObjectStore({
    executionMode: 'real',
    env: objectStorageEnv(config.objectStorage),
  });
  const approval = approveRealMediaWiring({
    reason: `${MEDIA_REAL_WIRING_FLAG}（生产入口显式运维动作）`,
  });
  return createMediaRealPorts({ objectStore, approval, persistence: 'process_memory' });
}

/**
 * 把**已解析**的对象存储配置逐字段还原成显式 env 记录，交给 {@link resolveMediaObjectStore} 构造端口。
 *
 * 为什么绕这一圈而不是直接 `createS3CompatibleObjectStore(config)`：`tests/unit/media-real-mode-fail-closed.test.mjs`
 * 有一条 fail-closed 判据要求「真实适配器工厂在生产源码里**只允许**被 `resolveMediaObjectStore` 调用一次」。
 * 那条判据**原样未动**（本文件不碰工厂名），真实端口的构造永远只经 resolver。
 *
 * 同一条用例里另有「resolver 生产调用点恰好一处（app.ts#buildApp）」——本片把它的**闭集由 1 处放宽为 2 处**
 * （第二处就是本文件的 {@link resolveMediaRealPorts}），因为 `buildApp` 的端口初值被判据逐字钉成
 * `mediaObjectStoreOption ?? resolveMediaObjectStore({ executionMode: config.executionMode })` 且实参只许
 * `executionMode`，真实端口只能由显式注入进入装配；不接受「入口永远无法构造真实端口」这一结构性死结。
 * 该修订已书面记录在 `docs/verification/gy-r28-w2-media-ports-20261022.md` 第 3 节（判据变更申请），
 * 并同时**加强**：第二处的实参形状（只许 `executionMode` + `env`）、`env` 必须来自 `objectStorageEnv(...)`、
 * 本文件不得出现 `process.env` —— 三条都是新增断言。
 *
 * ⚠️ 这张表是**显式构造的内存记录**，不是 ambient env：媒体链路一次都不读 `process.env`；
 * 凭据只在此处内存中转，不入日志、不入响应、不落盘。映射是**双射**（endpoint/bucket/AK/SK/region/
 * forcePathStyle 全部逐字段还原），resolver 内的 `readObjectStorageConfig` 会原样解析回来。
 */
function objectStorageEnv(config: ObjectStorageConfig): Record<string, string | undefined> {
  return {
    OBJECT_STORAGE_ENDPOINT: config.endpoint,
    OBJECT_STORAGE_BUCKET: config.bucket,
    OBJECT_STORAGE_ACCESS_KEY: config.accessKey,
    OBJECT_STORAGE_SECRET_KEY: config.secretKey,
    OBJECT_STORAGE_REGION: config.region,
    OBJECT_STORAGE_FORCE_PATH_STYLE: config.forcePathStyle ? 'true' : 'false',
  };
}

/**
 * 访问网关原点必须**可部署**：未配置（占位 `.invalid` 域）时真实媒体域等于没接线——
 * 上传句柄与取图句柄都会指到一个永不解析的主机。
 */
export function assertAccessGrantOriginDeployable(origin: string | null): string {
  const value = origin ?? DEFAULT_MEDIA_ACCESS_GRANT_ORIGIN;
  let normalized: string;
  try {
    normalized = normalizeMediaAccessGrantOrigin(value);
  } catch {
    throw new MediaRealWiringError(
      'access_grant_origin_not_deployable',
      `MEDIA_ACCESS_GRANT_ORIGIN 非法：只接受 https://<host>[:port]（实际 ${JSON.stringify(value)}）`,
    );
  }
  if (normalized === DEFAULT_MEDIA_ACCESS_GRANT_ORIGIN) {
    throw new MediaRealWiringError(
      'access_grant_origin_not_deployable',
      'MEDIA_ACCESS_GRANT_ORIGIN 未配置：句柄会指向占位域 media.placeholder.invalid（RFC 6761，永不解析）',
    );
  }
  return normalized;
}
