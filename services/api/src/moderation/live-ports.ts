/**
 * GY-I14（#14）· 真实审核供应商端口的**注入契约**（真实分支默认关闭，零默认实现）。
 *
 * 本文件与 `tms-live-adapter.ts` / `ims-live-adapter.ts` 一起补上 `provider.ts` 里点名的缺口：
 *
 *   > 真实端口必须由真实适配器 ＋ 一次显式可审查的接线变更提供（本阶段不存在这样的适配器）
 *
 * **本片只交付库件**：`provider.ts` 的 `resolveModerationPorts` 未被改动，`real` 仍恒
 * `ports: {}` / `fail_closed: true`；`app.ts` / `server.ts` **不 import** 本目录任何 live-* 文件
 * （证据页 `docs/verification/gy-r34-i14-live-adapter-20261023.md` 给了 `git grep` 证明）。
 * 真正打开真实外呼还需要**另一次**显式、可审查的接线变更（改装配点 + 供应商付费授权）。
 *
 * 「默认关闭」的机制与 `ai/ocr-live-ports.ts` / `tts/live-ports.ts` 同构：真实调用所需的全部
 * 向外能力（策略快照、被校验配置快照、凭据三元组、fetch、时钟）都收进端口对象，字段**全部必填**
 * （除 fetch/now），**没有任何默认实现** ⇒ 缺任一项就构造不出来。默认关闭不是开关，是类型上没有默认值。
 *
 * ⛔ 本文件不含任何网络实现、不含任何凭据值、不读 `process.env`、不读文件、不写台账。
 */

import type { ModerationPortLike, PortKind } from './provider.ts';

// ---------------------------------------------------------------------------
// 1. 冻结的供应商剖面（口径来源：`tools/ai-config.mjs` 的 `AI_ENDPOINTS` 与 `configurationIssues()`）
// ---------------------------------------------------------------------------

/**
 * 审核端口类别。**复用 `provider.ts` 的 `PortKind`**（不另立一套名字）：
 * `tms` 只承担文本、`ims` 只承担图片，串端口由合流层拒绝。
 */
export type ModerationVendorKind = PortKind;

/** 唯一允许的生产端点（逐字等于 `AI_ENDPOINTS.moderationText/moderationImage.endpoint`）。 */
export const MODERATION_VENDOR_ENDPOINTS = Object.freeze({
  tms: 'https://tms.tencentcloudapi.com',
  ims: 'https://ims.tencentcloudapi.com',
});

/** 唯一允许的 `X-TC-Action` / `X-TC-Version`（逐字等于 `AI_ENDPOINTS.moderation*`）。 */
export const MODERATION_VENDOR_ACTIONS = Object.freeze({
  tms: Object.freeze({ action: 'TextModeration', apiVersion: '2020-12-29' }),
  ims: Object.freeze({ action: 'ImageModeration', apiVersion: '2020-12-29' }),
});

/** 唯一允许的 `X-TC-Region`（`configurationIssues()` 的 `REGION_MISMATCH` 检查）。 */
export const MODERATION_VENDOR_REGION = 'ap-shanghai';

/** 供应商侧图片字节上限（`configurationIssues()` 的 `IMAGE_LIMIT_OR_TRANSPORT_MISMATCH`）。 */
export const MODERATION_MAX_IMAGE_BYTES = 2097152;

/** 唯一允许的图片传输形态。 */
export const MODERATION_MEDIA_TRANSPORT = 'inlineBase64' as const;

/**
 * 送审文本的码点上限。
 *
 * 口径＝`tools/ai-config.mjs:prepareOfflineRequest()` 里 `textInput(input, 200)`。超限
 * **fail-closed 不截断**：截断会让"只审了前 200 字"冒充"整段已审"，那是误放行的来源。
 */
export const MODERATION_MAX_TEXT_CHARACTERS = 200;

/** 单次任务允许的图片张数上限。超出 ⇒ fail-closed（绝不"只审一张就放行"）。 */
export const MODERATION_MAX_IMAGES_PER_TASK = 9;

/** 超时区间（毫秒），取自 `configurationIssues()` 的 `INVALID_TIMEOUT`：1000..20000。 */
export const MODERATION_TIMEOUT_MIN_MS = 1000;
export const MODERATION_TIMEOUT_MAX_MS = 20000;

/** `BizType` 形状（`configurationIssues()` 的 `MISSING_OR_INVALID_BIZTYPE`）。 */
export const MODERATION_BIZ_TYPE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * 本组件回归的**标签闭集**（与 `packages/moderation/model-verdict.mjs` 的取值逐项相同）。
 *
 * 为什么不直接 import 那一个常量：`tests/moderation/model-ports.test.mjs` 用**逐文件白名单**
 * （`SANCTIONED_MODEL_CONSUMER_FILES`）限制 `moderation/**` 里哪些文件可以引用模型合流符号，
 * 并明确规定"该目录里未列出的新文件命中仍判失败"。本片**不申请扩大那份白名单**（放宽门禁
 * 不是本片该做的事），因此这里保留一份局部闭集，并用用例逐项断言它与上游闭集相等
 * （`tests/unit/moderation-live-adapter.test.mjs` 的「标签闭集与上游一致」一条）——
 * 漂移会立刻变红，不会静默分叉。
 */
export const MODERATION_VERDICT_LABELS = Object.freeze(['pass', 'block', 'unsure'] as const);

/** 标签类型（从上面那份闭集派生，保证"闭集"与"类型"是同一个事实）。 */
export type ModerationVerdictLabel = (typeof MODERATION_VERDICT_LABELS)[number];

/**
 * 失败类别闭集（与 `packages/moderation/model-ports.mjs` 的 `MODEL_FAILURE_CLASSES` 逐项相同，
 * 理由同上：不扩大消费者白名单）。合流层只认 `error.model_failure`，因此本片**只声明类别**，
 * 不重复实现分类器。
 */
export const MODERATION_FAILURE_CLASSES = Object.freeze([
  'timeout',
  'quota_exceeded',
  'auth_failed',
  'payload_invalid',
  'response_shape_unknown',
  'port_error',
] as const);

export type ModerationFailureClass = (typeof MODERATION_FAILURE_CLASSES)[number];

// ---------------------------------------------------------------------------
// 2. 端口回报（闭集三键，绝无控制类字段）
// ---------------------------------------------------------------------------

/**
 * `evaluate()` 的返回形状：**只有** `label` / `reason_codes` / `summary` 三个键。
 *
 * 任何控制类字段（角色/scope/来源/可见性/发布/决策/人审/票决/训练开关）都不得出现在这里——
 * 保证来自两处：① 本片只从供应商回报里**白名单**取 3 个标量并重新构造对象（不是把供应商对象
 * 摊平出去）；② `provider.ts` 的 `guardModelPort`（`nonbypass.ts` 的控制字段扫描）是第二道闸。
 *
 * `summary` 只进摘要（合流层只保留长度），**永不**成为控制字段；`Score` 也只进这里。
 */
export type ModerationVerdict = {
  readonly label: ModerationVerdictLabel;
  readonly reason_codes: readonly string[];
  readonly summary: string;
};

// ---------------------------------------------------------------------------
// 3. 错误类型（构造期 fail-closed / 运行期可判别失败）
// ---------------------------------------------------------------------------

/** 端口/配置自身不合法（**构造期** fail-closed；绝不带着坏配置构造出端口）。 */
export class ModerationWiringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModerationWiringError';
  }
}

/**
 * **一次真实调用的可判别失败**。
 *
 * `model_failure` 是合流层唯一采信的类别字段（`packages/moderation/model-ports.mjs` 的分类器
 * 优先读它，其余启发式只在没有该字段时才生效）。任何失败都**只能**落到
 * `MODERATION_FAILURE_CLASSES` 六值之一 —— 没有"通过"这个取值。
 *
 * `message` 一律是**固定短标签**：不含响应正文、不含待审文本、不含请求头、不含凭据。
 */
export class ModerationPortError extends Error {
  readonly model_failure: ModerationFailureClass;
  /** HTTP 状态码；未建连时为 `null`。 */
  readonly http_status: number | null;
  /** 供应商**原始**业务错误码（原样保留，便于对账；不是契约码）。 */
  readonly provider_error_code: string | null;
  /** 本次请求是否**无法排除**已被供应商处理（超时/传输失败/证据不完整均为 true）。 */
  readonly result_may_have_been_processed: boolean;

  constructor(
    modelFailure: ModerationFailureClass,
    detail: string,
    extra: {
      httpStatus?: number | null;
      providerErrorCode?: string | null;
      resultMayHaveBeenProcessed?: boolean;
    } = {},
  ) {
    // detail 只允许固定短标签（调用方不得把响应正文/待审文本拼进来）。
    const label = /^[a-z0-9_.:-]{1,64}$/.test(detail) ? detail : 'unspecified';
    super(`真实审核端口失败（${modelFailure}:${label}）`);
    this.name = 'ModerationPortError';
    this.model_failure = modelFailure;
    this.http_status = extra.httpStatus ?? null;
    this.provider_error_code = extra.providerErrorCode ?? null;
    this.result_may_have_been_processed = extra.resultMayHaveBeenProcessed ?? true;
  }
}

// ---------------------------------------------------------------------------
// 4. 策略闸门（构造期硬拒，沿用 `ai/live-gate.ts` 的既有闸门形状）
// ---------------------------------------------------------------------------

/**
 * 策略快照 —— 逐字取自 `tools/ai-config.mjs:auditAIConfiguration()` 的
 * `endpoints[key].policySelectionVerified` 与 `endpoints[key].executionAllowed`。
 *
 * 为什么是**这两个**字段：`policySelectionVerified` 对 `moderation*` **恒为 `false`**
 * （BizType 是自描述占位值，控制台策略是否与期望一致从未被独立核对），
 * `executionAllowed` 对全部端点**恒为 `false`**。二者缺一就说明"这一次真实外呼没有授权"。
 */
export interface ModerationPolicySnapshot {
  /** BizType/策略选择是否已经**独立核对**（`tools/ai-config.mjs` 对审核恒 `false`）。 */
  readonly policySelectionVerified: boolean;
  /** 本次执行是否已被显式授权（`tools/ai-config.mjs` 恒 `false`）。 */
  readonly executionAllowed: boolean;
  /** 这份快照的出处（只读登记用；不得含凭据、不得含密钥文件路径）。 */
  readonly source: string;
}

/** 已核验放行的策略快照（`assertModerationPolicyOpen` 的返回值，只可能全是 `true`）。 */
export interface OpenModerationPolicy {
  readonly policySelectionVerified: true;
  readonly executionAllowed: true;
  readonly source: string;
}

/**
 * **策略闸门**：`policySelectionVerified !== true` 或 `executionAllowed !== true` ⇒ **构造硬拒**。
 *
 * 形状与 `ai/live-gate.ts:createProcessLiveGate()` 一致：选项对象 + 必填字段 + 缺项即抛错 +
 * **没有任何默认实现**（不存在"先跑起来再说"的分支）。区别只在于本闸门判的是**策略授权**，
 * 不判预算额度——预算台账闸门（`LiveCallGate`）本片**没有**接入，原因见证据页：
 * 它的能力闭集是 `tts|ocr|asr`，且 `tts/live-ports.ts` 明确写了"零共享文件、各域各自分支"，
 * 扩它属于跨域改动，不属本片；本片因此**不构造第二套预算闸门**，只做构造期硬拒。
 */
export function assertModerationPolicyOpen(policy: unknown): OpenModerationPolicy {
  if (policy === null || typeof policy !== 'object') {
    throw new ModerationWiringError('真实审核端口缺少策略快照（没有授权就不构造真实分支）');
  }
  const record = policy as Record<string, unknown>;
  if (record['policySelectionVerified'] !== true) {
    throw new ModerationWiringError(
      '真实审核端口的策略选择未核验（policySelectionVerified !== true）⇒ 构造硬拒，未发包',
    );
  }
  if (record['executionAllowed'] !== true) {
    throw new ModerationWiringError('真实审核端口未获执行授权（executionAllowed !== true）⇒ 构造硬拒，未发包');
  }
  const source = record['source'];
  if (typeof source !== 'string' || source.trim() === '' || source.length > 120) {
    throw new ModerationWiringError('真实审核端口的策略快照缺少出处（source 必须是非空短串）');
  }
  return Object.freeze({ policySelectionVerified: true as const, executionAllowed: true as const, source });
}

// ---------------------------------------------------------------------------
// 5. 被校验配置快照 + 凭据 + 字节来源
// ---------------------------------------------------------------------------

/** 文本端口（TMS）的被校验配置快照。 */
export interface ModerationTextProfile {
  /** 唯一允许的目标端点：只能传 `MODERATION_VENDOR_ENDPOINTS.tms`（离线用例另允许 loopback，见 `live-tc3.ts`）。 */
  readonly endpoint: string;
  readonly action: string;
  readonly apiVersion: string;
  /** 恒为 `ap-shanghai`（取自被校验配置，**不取调用方运行期入参**）。 */
  readonly region: string;
  /** 1000..20000，取自被校验配置。 */
  readonly timeoutMs: number;
  /** 必须为 0：任何重发都是一次新的付费调用。 */
  readonly maxRetries: number;
  /** **真实 BizType** 必须由调用方注入（`tools/ai-config.mjs` 里的是自描述占位值）。 */
  readonly bizType: string;
}

/** 图片端口（IMS）的被校验配置快照：在文本那份之上加了图片专属两项。 */
export interface ModerationImageProfile extends ModerationTextProfile {
  /** 必须为 `MODERATION_MAX_IMAGE_BYTES`；超限 fail-closed，**不压缩、不裁剪**。 */
  readonly maxImageBytes: number;
  /** 必须为 `inlineBase64`（唯一允许的传输形态）。 */
  readonly mediaTransport: typeof MODERATION_MEDIA_TRANSPORT;
}

/**
 * TC3 凭据三元组（**只在内存**；绝不入账本、绝不打印、绝不序列化、绝不写日志）。
 * 与 TTS/OCR 同源口径：审核用**共享配对**，长期密钥没有临时令牌时 `sessionToken` 显式空串。
 */
export interface ModerationLiveCredentials {
  readonly secretId: string;
  readonly secretKey: string;
  readonly sessionToken: string;
}

/**
 * 私有图片字节来源（注入式，仅 IMS 需要）。
 *
 * 为什么需要它：合流层给图片端口的请求里**只有不透明引用**（`media_id` / `media_revision` /
 * `mime`，见 `packages/moderation/model-ports.mjs` 的图片引用归一器），**没有字节**。
 * 让适配器自己去读对象存储/磁盘会把"读哪张图"变成隐式行为，因此字节必须由注入方提供。
 * 拿不到字节就返回 `null` —— 适配器按"取不到待审图片"fail-closed，**绝不用占位图冒充**。
 */
export interface ModerationImageSource {
  readonly kind: 'wired' | 'unwired';
  /** 供证据/诊断引用的如实标注（不含任何图片内容或私有引用）。 */
  readonly note: string;
  read(input: { mediaId: string; mediaRevision: number | null }): Promise<Uint8Array | null>;
}

// ---------------------------------------------------------------------------
// 6. 端口对象与注入契约
// ---------------------------------------------------------------------------

/** 端口持有的四个网络/时间 seam（与 `packages/moderation/model-ports.mjs` 的 seam 名逐项同名）。 */
export type ModerationPortSeams = {
  readonly fetchImpl: typeof fetch;
  readonly credentials: ModerationLiveCredentials;
  /**
   * 本端口**构造时那份已核验的策略闸门快照**。
   *
   * 如实说明：本片没有接预算/台账闸门（理由见 `assertModerationPolicyOpen` 的注释），
   * 因此这个槽位装的是**策略闸门快照**，不是 `LiveCallGate`。槽位名沿用 seam 闭集，
   * 是因为合流层要求四个 seam **都显式持有**（缺一个即判端口非法），不是因为它必须是预算台账。
   */
  readonly liveGate: OpenModerationPolicy;
  readonly now: () => number;
};

/** 本片交付的端口类型：形状严格扩展 `provider.ts` 的 `ModerationPortLike`（编译器强制）。 */
export interface ModerationLivePort extends ModerationPortLike {
  readonly kind: ModerationVendorKind;
  readonly model_version: string;
  readonly provider: Record<string, unknown> & {
    readonly biz_type: string;
    readonly biz_type_selection_verified: true;
    readonly synthetic: false;
    readonly timeout_ms: number;
  };
  readonly seams: ModerationPortSeams;
  readonly evaluate: (request: unknown) => Promise<ModerationVerdict>;
  /**
   * **脱敏**投影：`JSON.stringify(port)` 与任何"把端口整体打进日志/证据"的写法都走这里。
   *
   * 为什么需要它：`seams.credentials` 是端口对象的一部分，默认序列化会把 `secretKey` 原样打出来。
   * 凭据只允许在内存里被签名函数按字段读取，**绝不**允许出现在序列化结果中。
   */
  toJSON(): ModerationPortRedactedView;
}

/** `JSON.stringify(port)` 能看到的全部内容（凭据只剩一个标记，`.kind === 'redacted'`）。 */
export interface ModerationPortRedactedView {
  readonly kind: ModerationVendorKind;
  readonly model_version: string;
  readonly provider: ModerationLivePort['provider'];
  readonly seams: {
    readonly credentials: { readonly kind: 'redacted' };
    readonly liveGate: OpenModerationPolicy;
    readonly fetchImpl: 'function';
    readonly now: 'function';
  };
  readonly evaluate: 'function';
}

/**
 * 构造端口的**脱敏投影**（`toJSON()` 的唯一实现，两个适配器共用）。
 *
 * ⛔ 这里**不得**加入 `seams.credentials` 的任何字段值（连 secretId 都不行）。
 */
export function moderationPortRedactedView(input: {
  kind: ModerationVendorKind;
  modelVersion: string;
  provider: ModerationLivePort['provider'];
  liveGate: OpenModerationPolicy;
}): ModerationPortRedactedView {
  return Object.freeze({
    kind: input.kind,
    model_version: input.modelVersion,
    provider: input.provider,
    seams: Object.freeze({
      credentials: Object.freeze({ kind: 'redacted' as const }),
      liveGate: input.liveGate,
      fetchImpl: 'function' as const,
      now: 'function' as const,
    }),
    evaluate: 'function' as const,
  });
}

/** 真实文本端口（TMS）的全部向外能力。字段全部必填（除 fetch/now）。 */
export interface RealModerationTextPorts {
  readonly policy: ModerationPolicySnapshot;
  readonly profile: ModerationTextProfile;
  readonly credentials: ModerationLiveCredentials;
  /** 仅离线用例注入（可注入假函数以证明"走到即将发送"）；默认 `globalThis.fetch`。 */
  readonly fetchImpl?: typeof fetch;
  /** 仅可注入时钟（毫秒）；默认 `Date.now`。 */
  readonly now?: () => number;
}

/** 真实图片端口（IMS）的全部向外能力：多一个字节来源。 */
export interface RealModerationImagePorts {
  readonly policy: ModerationPolicySnapshot;
  readonly profile: ModerationImageProfile;
  readonly credentials: ModerationLiveCredentials;
  /** **必填**：没有字节来源就拿不到要审的图（本片产品侧尚未接线，见 `createUnwiredModerationImageSource`）。 */
  readonly imageSource: ModerationImageSource;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// 7. 快照校验（纵深防御：配置侧已挡一层，构造期再逐项断言一遍）
// ---------------------------------------------------------------------------

function numberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * 构造期**快照**：复制一份并冻结，端口从此只读这一份（不再看调用方手里的原对象）。
 *
 * 为什么不能只保留引用：`profile` / `credentials` 若按引用持有，构造之后改写 `bizType` /
 * `secretKey` / `timeoutMs` 会**真的**改变线上行为（换 BizType、换签名密钥、改超时），
 * 而 `port.provider.biz_type` 仍报构造期的旧值 ⇒ 自述与线上字节分叉。
 *
 * 本文件的两份剖面与凭据三元组的字段**全部是标量** ⇒ 展开复制即深拷贝（没有嵌套引用可逃逸）；
 * 冻结让"构造之后再改写"直接抛 `TypeError`，而不是悄悄生效。
 */
export function snapshotModerationRecord<T extends object>(record: T): Readonly<T> {
  return Object.freeze({ ...record });
}

/**
 * 两个端口**共用**的那部分剖面对账（区域/超时/零重试/BizType 形状）。
 * 逐项口径见 `tools/ai-config.mjs:configurationIssues()`。
 */
function assertModerationProfileCommon(
  profile: ModerationTextProfile,
  expected: { action: string; apiVersion: string },
  label: string,
): void {
  if (profile === null || typeof profile !== 'object') {
    throw new ModerationWiringError(`真实${label}审核端口缺少被校验配置快照（fail-closed，未发包）`);
  }
  if (profile.action !== expected.action) {
    throw new ModerationWiringError(`真实${label}审核的 action 必须是 ${expected.action}（fail-closed，未发包）`);
  }
  if (profile.apiVersion !== expected.apiVersion) {
    throw new ModerationWiringError(`真实${label}审核的 apiVersion 必须是 ${expected.apiVersion}（fail-closed，未发包）`);
  }
  if (profile.region !== MODERATION_VENDOR_REGION) {
    throw new ModerationWiringError(`真实${label}审核的 region 必须是被校验配置的固定区域（fail-closed，未发包）`);
  }
  if (!numberInRange(profile.timeoutMs, MODERATION_TIMEOUT_MIN_MS, MODERATION_TIMEOUT_MAX_MS)) {
    throw new ModerationWiringError(
      `真实${label}审核的 timeoutMs 必须是被校验配置里的 ${MODERATION_TIMEOUT_MIN_MS}..${MODERATION_TIMEOUT_MAX_MS} 整数`,
    );
  }
  if (profile.maxRetries !== 0) {
    throw new ModerationWiringError(`真实${label}审核的 maxRetries 必须为 0（任何重发都是一次新的付费调用）`);
  }
  if (typeof profile.bizType !== 'string' || !MODERATION_BIZ_TYPE_PATTERN.test(profile.bizType)) {
    throw new ModerationWiringError(`真实${label}审核的 BizType 必须由调用方注入且形如 [A-Za-z0-9_-]{1,32}`);
  }
}

/** 校验文本端口的被校验配置快照（任一项不符即拒绝构造）。 */
export function assertModerationTextProfile(profile: ModerationTextProfile): ModerationTextProfile {
  assertModerationProfileCommon(profile, MODERATION_VENDOR_ACTIONS.tms, '文本');
  return profile;
}

/** 校验图片端口的被校验配置快照（在文本那份之上再查图片两项）。 */
export function assertModerationImageProfile(profile: ModerationImageProfile): ModerationImageProfile {
  assertModerationProfileCommon(profile, MODERATION_VENDOR_ACTIONS.ims, '图片');
  if (profile.maxImageBytes !== MODERATION_MAX_IMAGE_BYTES) {
    throw new ModerationWiringError(`真实图片审核的 maxImageBytes 必须是 ${MODERATION_MAX_IMAGE_BYTES}（fail-closed，未发包）`);
  }
  if (profile.mediaTransport !== MODERATION_MEDIA_TRANSPORT) {
    throw new ModerationWiringError('真实图片审核的 mediaTransport 必须是 inlineBase64（fail-closed，未发包）');
  }
  return profile;
}

/** 校验凭据三元组（只判"是否存在"，**绝不读值出去**；错误消息里不含任何凭据片段）。 */
export function assertModerationCredentials(credentials: ModerationLiveCredentials): ModerationLiveCredentials {
  if (credentials === null || typeof credentials !== 'object') {
    throw new ModerationWiringError('真实审核端口缺少凭据三元组（fail-closed，未发包）');
  }
  if (typeof credentials.secretId !== 'string' || credentials.secretId.trim() === '') {
    throw new ModerationWiringError('真实审核端口缺少 secretId（同源配对，不逐字段混配、不回退）');
  }
  if (typeof credentials.secretKey !== 'string' || credentials.secretKey.trim() === '') {
    throw new ModerationWiringError('真实审核端口缺少 secretKey（同源配对，不逐字段混配、不回退）');
  }
  if (typeof credentials.sessionToken !== 'string') {
    throw new ModerationWiringError('真实审核端口的临时令牌必须是字符串（长期密钥显式空串，不继承其它 token）');
  }
  return credentials;
}
