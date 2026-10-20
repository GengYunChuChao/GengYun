/**
 * GY-I06（#6）媒体域 · 私有对象存储适配器。
 *
 * 三种端口实现，**按 `kind` 显式区分**（沿用本仓 `speech/media.ts`、`recognitions/media.ts`、
 * `tts/media.ts` 的同一口径）：
 *
 * | kind | 何时使用 | 行为 |
 * | --- | --- | --- |
 * | `substitute` | `stub` / `preset_demo` / 测试注入 | 进程内内存对象存储；**明确标注的替身**，不发起任何网络请求 |
 * | `unwired` | `real` 且未**显式注入**真实适配器（含装配点不传 `env` 的情形） | 每个操作抛 `PROVIDER_UNAVAILABLE`（503，`retryable: false`）；**fail-closed** |
 * | `s3_compatible` | 装配层**显式注入**已构造的实例，或测试显式传入齐备的合成 `env` | S3/COS 兼容真实适配器（SigV4 预签名 + `fetch` 传输） |
 *
 * 硬性纪律（来自监工对 #121 的 P1 裁定）：
 * - `real` 模式下真实存储/持久端口未真正接入 ⇒ **必须 fail-closed**，以契约内的
 *   `PROVIDER_UNAVAILABLE`（503，`retryable: false`）明确拒绝，**不得**用内存/替身实现返回成功封套。
 * - 判据是**注入端口的 `kind`**，不是一个自述「我已持久化」的布尔标志：接真实存储必须是**装配层**
 *   一次可审查的接线变更 —— 而该变更自 PR #193 的 P1 起**只允许是显式注入端口实例**，
 *   **不允许**把 ambient `process.env` 交给 `resolveMediaObjectStore`（那等于"配置即门控"）。
 * - **缺任一必填配置（或 endpoint 非 https）⇒ 仍 `unwired`（fail-closed，与接线前逐字一致）**：
 *   配置缺失**不**构成放行理由，也**不**退回替身；缺失字段名由启动期 `loadConfig`（real 必填）报出。
 * - 本文件不发起任何真实调用：真实适配器的**构造与预签名都是纯本地计算**，只有显式
 *   `putObject`/`getObject`/`deleteObject` 才会 `fetch`。
 *
 * **已跑通声明（如实）**：`createS3CompatibleObjectStore` / `presignS3Url` 的 put/get/has/delete/presign 全路径
 * 已在测试的**进程内 `fetch` 替身**下跑通（`tests/unit/media-object-store-s3-paths.test.mjs`），签名由测试
 * **独立重算**（自写 SigV4 规范化串 + HMAC-SHA256 链）逐字节校验；**产品装配路径仍从未被实际调用**、
 * 未对接任何真实 COS/S3 桶、未做真实签名往返，且测试不发起任何真实网络请求；真实对象存储、CDN、访问网关属部署期接线。
 * 见 `docs/verification/gy-i06-private-media-20261014.md`、`docs/verification/gy-r27-object-store-s3-paths-20261020.md`。
 */
import { createHash, createHmac } from 'node:crypto';
import { MediaError } from '../../../../packages/media/index.mjs';

export type MediaObjectStoreKind = 'substitute' | 's3_compatible' | 'unwired';

export interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
}

/** 短效句柄（契约 `AccessGrant` 的 `url` / `expires_at` / `method` 三要素）。 */
export interface PresignedHandle {
  url: string;
  method: 'PUT' | 'GET';
  expires_at: string;
}

/**
 * 媒体域的对象存储端口。
 *
 * 与 `packages/media/store.mjs` 的内存参考实现**同名同义**（`put` / `get` / `has` / `delete`），
 * 但这里是**异步**端口：契约的 `completeUpload` body 只有 `{sha256, bytes}`（**不含媒体字节**），
 * 因此字节必须由服务端从对象存储取回；真实适配器的取回是网络 I/O，无法在同步端口里表达。
 */
export interface MediaObjectStore {
  readonly kind: MediaObjectStoreKind;
  /** 供证据文档/诊断引用的如实标注（不含任何私有对象引用、桶名或凭据）。 */
  readonly note: string;
  /** 已发起的外部（网络）请求数。替身/未接线端口恒为 0 —— 用于核对「真实存储未被实际调用」。 */
  readonly externalRequestCount: number;
  putObject(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  getObject(key: string): Promise<StoredObject | null>;
  hasObject(key: string): Promise<boolean>;
  /**
   * 删除对象。**返回值的语义是「已确认删除」而非「本次是否真的移除了条目」**：
   * - `true` = 已确认删除（含幂等删除「对象本就不存在」，与 S3 `DeleteObject` 的 204 一致）；
   * - `false` = **未能确认**（保守：调用方必须保留引用以便重试，不得当成删除成功）；
   * - 抛出 = 暂时失败（调用方同样必须保留引用）。
   *
   * 这条语义是隐私红线的一部分（监工批复 P1）：未确认删除**不得**丢失重试依据。
   */
  deleteObject(key: string): Promise<boolean>;
  /** 当前对象数（诊断/测试断言孤立对象是否被回收）。 */
  objectCount(): Promise<number>;
  presignUpload(input: { key: string; contentType: string; expiresInSeconds: number }): Promise<PresignedHandle>;
  presignDownload(input: { key: string; expiresInSeconds: number }): Promise<PresignedHandle>;
}

// ------------------------------------------------------------------ 替身端口

const SUBSTITUTE_NOTE =
  '替身对象存储（stub/preset_demo/测试注入）：进程内内存对象，不发起任何网络请求；' +
  '其句柄 URL 指向保留域 substitute.invalid，**不是**真实对象存储或访问网关，重启即丢。';

/**
 * 替身对象存储：**明确标注的替身**。
 *
 * 它不把任何真实对象声明为已持久化；`note` 与句柄域名（`substitute.invalid`）在响应/日志/文档中
 * 都显式标明替身身份，避免「看起来已接线」。
 */
export function createSubstituteObjectStore(options: { note?: string } = {}): MediaObjectStore {
  const objects = new Map<string, StoredObject>();
  return {
    kind: 'substitute',
    note: options.note ?? SUBSTITUTE_NOTE,
    get externalRequestCount() {
      return 0;
    },
    async putObject(key, bytes, contentType) {
      objects.set(key, { bytes: Uint8Array.from(bytes), contentType });
    },
    async getObject(key) {
      const entry = objects.get(key);
      return entry === undefined ? null : { bytes: Uint8Array.from(entry.bytes), contentType: entry.contentType };
    },
    async hasObject(key) {
      return objects.has(key);
    },
    async deleteObject(key) {
      // 幂等删除：键本就不存在也视为**已确认删除**（与 S3 `DeleteObject` 的 204 语义一致）。
      // 否则「一次成功删除后的重试」会返回 false，让引用永远悬空、无法收敛。
      objects.delete(key);
      return true;
    },
    async objectCount() {
      return objects.size;
    },
    async presignUpload({ key, expiresInSeconds }) {
      return {
        url: `https://substitute.invalid/media-objects/${encodeURIComponent(key)}?intent=upload`,
        method: 'PUT',
        expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      };
    },
    async presignDownload({ key, expiresInSeconds }) {
      return {
        url: `https://substitute.invalid/media-objects/${encodeURIComponent(key)}?intent=download`,
        method: 'GET',
        expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      };
    },
  };
}

// ------------------------------------------------------------- 未接线（fail-closed）

export const UNWIRED_OBJECT_STORE_REASON =
  '真实对象存储（S3/COS 兼容）尚未接线：媒体域不可用，拒绝以内存/替身存储返回成功封套';

/**
 * 未接线端口（`real` 模式的默认装配路径）：每个操作**一律** `PROVIDER_UNAVAILABLE`（503，`retryable: false`）。
 * 不泄露对象是否存在，也不以「本地兜底」方式放行。
 */
export function createUnwiredObjectStore(reason: string = UNWIRED_OBJECT_STORE_REASON): MediaObjectStore {
  const fail = (): MediaError =>
    // 对象存储未接线（未注入真实适配器）：retryable 必须为 false。
    new MediaError('PROVIDER_UNAVAILABLE', `${reason}（fail-closed）`, { retryable: false });
  return {
    kind: 'unwired',
    note: `${reason}（fail-closed）`,
    get externalRequestCount() {
      return 0;
    },
    async putObject(): Promise<void> {
      throw fail();
    },
    async getObject(): Promise<StoredObject | null> {
      throw fail();
    },
    async hasObject(): Promise<boolean> {
      throw fail();
    },
    async deleteObject(): Promise<boolean> {
      throw fail();
    },
    async objectCount(): Promise<number> {
      throw fail();
    },
    async presignUpload(): Promise<PresignedHandle> {
      throw fail();
    },
    async presignDownload(): Promise<PresignedHandle> {
      throw fail();
    },
  };
}

// ------------------------------------------------------------- 真实适配器（未验证）

export interface ObjectStorageConfig {
  /** 形如 `https://cos.ap-shanghai.myqcloud.com`（不含 bucket）。 */
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
  /** 路径样式寻址（自建 S3 兼容服务常用）；默认虚拟主机样式（COS/S3 默认）。 */
  forcePathStyle: boolean;
}

export interface ObjectStorageConfigIssue {
  field: string;
  code: 'MISSING' | 'INVALID_VALUE';
  reason: string;
}

/** 从环境变量读取对象存储配置（**不**回显任何凭据值）。 */
export function readObjectStorageConfig(
  env: Record<string, string | undefined>,
  fallbackRegion = 'ap-shanghai',
): { config: ObjectStorageConfig | null; issues: ObjectStorageConfigIssue[] } {
  const issues: ObjectStorageConfigIssue[] = [];
  const read = (name: string): string | null => {
    const value = env[name];
    if (value === undefined) return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  };

  const endpoint = read('OBJECT_STORAGE_ENDPOINT');
  const bucket = read('OBJECT_STORAGE_BUCKET');
  const accessKey = read('OBJECT_STORAGE_ACCESS_KEY');
  const secretKey = read('OBJECT_STORAGE_SECRET_KEY');
  const required = [
    ['OBJECT_STORAGE_ENDPOINT', endpoint],
    ['OBJECT_STORAGE_BUCKET', bucket],
    ['OBJECT_STORAGE_ACCESS_KEY', accessKey],
    ['OBJECT_STORAGE_SECRET_KEY', secretKey],
  ] as const;
  for (const [field, value] of required) {
    if (value === null) {
      issues.push({ field, code: 'MISSING', reason: '真实对象存储适配器必须提供该配置' });
    }
  }
  if (endpoint !== null && !/^https:\/\/[^\s/]+/i.test(endpoint)) {
    issues.push({
      field: 'OBJECT_STORAGE_ENDPOINT',
      code: 'INVALID_VALUE',
      reason: '必须是 https:// 开头的 endpoint（明文 http 不接受）',
    });
  }
  if (issues.length > 0) return { config: null, issues };
  if (endpoint === null || bucket === null || accessKey === null || secretKey === null) {
    return { config: null, issues };
  }

  return {
    config: {
      endpoint,
      bucket,
      accessKey,
      secretKey,
      region: read('OBJECT_STORAGE_REGION') ?? fallbackRegion,
      forcePathStyle: (read('OBJECT_STORAGE_FORCE_PATH_STYLE') ?? 'false').toLowerCase() === 'true',
    },
    issues,
  };
}

// ---- SigV4（AWS 签名版本 4；COS/S3 兼容）-------------------------------------

type SignedMethod = 'PUT' | 'GET' | 'DELETE';

function sha256HexOf(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** RFC3986 编码（AWS 要求：仅 `A-Za-z0-9-_.~` 不编码）。 */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalPath(key: string): string {
  return `/${key.split('/').map((segment) => rfc3986(segment)).join('/')}`;
}

function amzDateParts(now: Date): { short: string; long: string } {
  const long = `${now.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
  return { short: long.slice(0, 8), long };
}

/**
 * 生成 SigV4 预签名 URL（GET/PUT/DELETE）。
 *
 * **已独立复算、仍未真实往返**：本函数的产出由 `tests/unit/media-object-store-s3-paths.test.mjs` 用自写的
 * SigV4 规范化串 + HMAC-SHA256 链逐字节复算校验；仍未对真实 COS/S3 端点发起过任何签名往返核验。
 */
export function presignS3Url(options: {
  config: ObjectStorageConfig;
  method: SignedMethod;
  key: string;
  expiresInSeconds: number;
  now?: Date;
}): string {
  const { config, method, key } = options;
  const endpoint = new URL(config.endpoint);
  const host = config.forcePathStyle ? endpoint.host : `${config.bucket}.${endpoint.host}`;
  const path = config.forcePathStyle ? `/${config.bucket}${canonicalPath(key)}` : canonicalPath(key);
  const { short, long } = amzDateParts(options.now ?? new Date());
  const scope = `${short}/${config.region}/s3/aws4_request`;
  const query: Array<readonly [string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${config.accessKey}/${scope}`],
    ['X-Amz-Date', long],
    ['X-Amz-Expires', String(options.expiresInSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const canonicalQuery = query
    .map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  const canonicalRequest = [method, path, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', long, scope, sha256HexOf(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretKey}`, short), config.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  return `${endpoint.protocol}//${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/**
 * S3/COS 兼容真实适配器。
 *
 * **产品装配路径从未被实际调用**（全路径只在测试的进程内 `fetch` 替身下跑通）：装配路径只在 `real` 且 `OBJECT_STORAGE_*` 齐备时**构造**它
 * （见 `resolveMediaObjectStore`），而构造不发起任何网络请求；只有 `putObject` / `getObject` /
 * `deleteObject` 等显式调用才会。构造不合法（缺 endpoint/bucket/凭据，或非 https）时**立即抛错**，
 * 绝不退回替身。
 */
export function createS3CompatibleObjectStore(config: ObjectStorageConfig): MediaObjectStore {
  const missing =
    config.endpoint.trim() === '' || config.bucket.trim() === '' || config.accessKey.trim() === '' || config.secretKey.trim() === '';
  if (missing) {
    throw new Error('真实对象存储适配器缺少 endpoint/bucket/accessKey/secretKey，拒绝构造');
  }
  if (!/^https:\/\//i.test(config.endpoint)) {
    throw new Error('真实对象存储适配器要求 https endpoint，拒绝构造');
  }
  let externalRequests = 0;

  const send = async (
    method: SignedMethod,
    key: string,
    payload?: { bytes: Uint8Array; contentType: string },
  ): Promise<Response> => {
    externalRequests += 1;
    const url = presignS3Url({ config, method, key, expiresInSeconds: 300 });
    const headers: Record<string, string> = { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' };
    const init: RequestInit = { method, headers };
    if (payload !== undefined) {
      headers['content-type'] = payload.contentType;
      init.body = payload.bytes as unknown as RequestInit['body'];
    }
    return fetch(url, init);
  };

  const getObject = async (key: string): Promise<StoredObject | null> => {
    const response = await send('GET', key);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new MediaError('PROVIDER_UNAVAILABLE', `对象存储读取失败（HTTP ${response.status}）`, {
        retryable: response.status >= 500,
      });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes, contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
  };

  return {
    kind: 's3_compatible',
    note: `S3/COS 兼容真实适配器（region=${config.region}，虚拟主机样式=${!config.forcePathStyle}）：产品装配路径从未被实际调用；put/get/has/delete/presign 全路径已在测试的进程内 fetch 替身下跑通，签名由测试独立重算校验；未对接任何真实桶、未做真实签名往返。`,
    get externalRequestCount() {
      return externalRequests;
    },
    async putObject(key, bytes, contentType) {
      const response = await send('PUT', key, { bytes, contentType });
      if (!response.ok) {
        throw new MediaError('PROVIDER_UNAVAILABLE', `对象存储写入失败（HTTP ${response.status}）`, {
          retryable: response.status >= 500,
        });
      }
    },
    getObject,
    async hasObject(key) {
      return (await getObject(key)) !== null;
    },
    async deleteObject(key) {
      const response = await send('DELETE', key);
      // 2xx / 404 = 已确认删除（幂等）；其余状态**抛错**，让调用方保留引用并可重试。
      if (response.ok || response.status === 404) return true;
      throw new MediaError('PROVIDER_UNAVAILABLE', `对象存储删除失败（HTTP ${response.status}）`, {
        retryable: response.status >= 500,
      });
    },
    async objectCount() {
      throw new MediaError('PROVIDER_UNAVAILABLE', '真实适配器不提供对象计数（需 list 权限，未接线）');
    },
    async presignUpload({ key, expiresInSeconds }) {
      return {
        url: presignS3Url({ config, method: 'PUT', key, expiresInSeconds }),
        method: 'PUT',
        expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      };
    },
    async presignDownload({ key, expiresInSeconds }) {
      return {
        url: presignS3Url({ config, method: 'GET', key, expiresInSeconds }),
        method: 'GET',
        expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      };
    },
  };
}

// ------------------------------------------------------------------ 装配解析

export interface ResolveObjectStoreOptions {
  executionMode: string;
  /**
   * 对象存储配置来源。⛔ **只供显式装配／测试使用：装配层（`app.ts`）不得传 ambient `process.env`** ✗
   * （这是监工对 PR #193 的 P1：那 4 个键正是 real 启动必填项 ⇒ 传 ambient env 等于"配置即门控"）。
   * **可选**：不传等同于"没有任何配置" ⇒ 保持 fail-closed。
   * 只读取 `OBJECT_STORAGE_*` 键名，**不回显任何值**（见 `readObjectStorageConfig`）。
   */
  env?: Record<string, string | undefined>;
}

/**
 * 未显式传入 `env` 时使用的空配置表：**null 原型** ⇒ 即使 `Object.prototype` 被投毒
 * （对抗性复审 B2/B3 的机制：`Object.defineProperty(Object.prototype, 'OBJECT_STORAGE_*', …)`）
 * 也供不出任何 `OBJECT_STORAGE_*` 键。
 */
const NO_STORAGE_ENV: Record<string, string | undefined> = Object.create(null) as Record<string, string | undefined>;

/**
 * 按执行模式解析对象存储端口。
 *
 * - `real` 且**显式传入的** `env` 里 `OBJECT_STORAGE_*` **齐备**（`readObjectStorageConfig` 无 issue）
 *   ⇒ `s3_compatible` 真实适配器。**构造与预签名都是纯本地**：不发起任何网络请求，只有显式调用
 *   对象操作才会。
 * - `real` 且**缺任一**必填键（或 endpoint 非 https / 未注入 `env`） ⇒ `unwired`
 *   （fail-closed）：reason/note 与接线前**逐字一致**，不因"缺配置"退回替身或放行。
 * - `stub` / `preset_demo` ⇒ 明确标注的替身（`env` **不参与**该分支，与接线前逐字一致）。
 *
 * ⛔ **`env` 只供显式装配／测试使用：装配层（`app.ts`）不得把 ambient `process.env` 传进来** ✗。
 * 原因见下表与 `app.ts` 媒体装配点的长注释：这 4 个键正是 real 模式**启动必填**项 ⇒ 传 ambient env
 * 等于「配置即门控」，会在隐私守卫与媒体元数据可恢复化落地前为真实用户媒体开门
 * （监工对 PR #193 的 P1）。装配层的唯一开启方式是**显式注入**一个已构造的端口实例。
 *
 * ⛔ 另外（r3，对抗性复审 B2/B3 的机制）：未传 `env` 时用的是**null 原型空表**（见
 * `NO_STORAGE_ENV`）——`env[name]` 走原型链，若用普通 `{}`，被投毒的 `Object.prototype` 能凭空
 * 供出整套 `OBJECT_STORAGE_*`。真实闸门在 {@link createAppMediaService} 的批准能力上，
 * 这里只是同一方向上的加固（不让污染面**产出**真实端口）。
 */
export function resolveMediaObjectStore(options: ResolveObjectStoreOptions): MediaObjectStore {
  if (options.executionMode === 'real') {
    const { config } = readObjectStorageConfig(options.env ?? NO_STORAGE_ENV);
    if (config === null) return createUnwiredObjectStore();
    return createS3CompatibleObjectStore(config);
  }
  return createSubstituteObjectStore();
}
