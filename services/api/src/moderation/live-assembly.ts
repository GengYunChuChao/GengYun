/**
 * GY-R70 · 审核域真实接线的**装配决定点**（生产装配的唯一判定处，默认关闭）。
 *
 * 断点（本片基线 `53354fe7` 的代码事实）：
 *   - `moderation/service.ts:134` 有 `liveWiring?: ModerationLiveWiring`；`:453-455` 的注释写着
 *     「real：**永不**回退替身。有凭据且显式打开（`liveWiring`）⇒ 用真实端口走完整服务」，
 *     实现是 `deps.liveWiring === undefined ? null : createLiveModerationPortsFromWiring(...)`；
 *   - `git grep -n liveWiring -- services/api/src` 只命中 `moderation/service.ts` 三处 ⇒
 *     **全仓没有任何生产代码传它** ⇒ `real` 下审核整域恒 503（fail-closed 本身没错，但它成了
 *     "无论怎么配置都开不了"的第二种错）。
 *
 * 本文件补的就是那个「另一次显式、可审查的接线变更」（`live-ports.ts` 头部点名的缺口），口径照
 * `media/real-ports.ts`（显式批准能力）与 `tts/real-ports.ts`（装配层只转发、不铸造）：
 *
 *   ① **唯一闸门是三个与门**（缺一项即 `wiring === null` ⇒ 调用方保持今天的 503）：
 *      `executionMode === 'real'` **且** 凭据三元组齐备 **且** 显式批准能力存在（本文件铸造）；
 *   ② **批准能力不可默认、不可派生、不可伪造**：判定只认模块私有 `WeakSet` 里的**对象身份**
 *      （照 `media/service.ts` 的 `approveRealMediaWiring`），形状相同的字面量、`Object.create`
 *      派生、`Proxy`、克隆副本一律无效；⛔ 装配层（`app.ts`）**不得**自行铸造；
 *   ③ **构造失败一律 fail-closed**：本函数**从不抛错**（异常在这里折成 `invalid_configuration`），
 *      且失败描述里**不含任何配置/异常文本** ⇒ 凭据不可能从拒绝路径回显；
 *   ④ **零外呼**：整个决定过程只构造对象（`createLiveModerationPortsFromWiring` 是纯构造），
 *      不调 `fetch`、不读时钟、不写台账、不读文件、不读 `process.env`。
 *
 * 拒绝描述的形状刻意与 HTTP 错误封套的 `details[]` 同形，且原因码只用**既有**闭集语义：
 * `errorCode` 是既有契约码 `PROVIDER_UNAVAILABLE`（503），`details[].code` 是既有原因码
 * `MODEL_NOT_EVALUATED`（"模型层没有给出任何结论"——没有端口 ⇒ 从未评估 ⇒ 不得放行）。
 * ⛔ `MODEL_NOT_EVALUATED` **不是** HTTP 错误码（422/503 才是），它只作 `details[].code`。
 *
 * ⛔ 本文件不含任何网络实现、不含任何凭据值、不读 `process.env`、不读文件、不写台账。
 */

import { AI_PROVIDER_DEFAULT_TIMEOUT_MS } from '../config.ts';
import {
  MODERATION_MAX_IMAGE_BYTES,
  MODERATION_MEDIA_TRANSPORT,
  MODERATION_VENDOR_ACTIONS,
  MODERATION_VENDOR_ENDPOINTS,
  MODERATION_VENDOR_REGION,
  type ModerationImageProfile,
  type ModerationLiveCredentials,
  type ModerationTextProfile,
} from './live-ports.ts';
import { createLiveModerationPortsFromWiring, type ModerationLiveWiring } from './live-wiring.ts';
import type { ModerationExecutionMode } from './types.ts';

// ---------------------------------------------------------------------------
// 1. 显式批准能力（唯一铸造点；⛔ 装配层不得调用）
// ---------------------------------------------------------------------------

/**
 * **真实审核接线的显式批准能力**（不可默认化的一次性凭据）。
 *
 * 为什么不能由配置决定：`tools/ai-config.mjs` 的 `auditAIConfiguration()` 对 `moderation*`
 * 的 `policySelectionVerified` **恒为 `false`**（BizType 是自描述占位值，控制台策略是否与期望
 * 一致从未被独立核对），`executionAllowed` 对全部端点**恒为 `false`**。因此"配置齐备"永远
 * 推不出"可以真实外呼"——审批必须是**另一次**显式动作，且要把两件配置给不出的事实写进来：
 *
 * - `policySource`：策略**被独立核对过**的出处（非凭据；不得是密钥文件路径）；
 * - `bizType`：**真实** BizType（`ai-config.mjs` 里那份是占位值，不能拿来开户）。
 *
 * 铸造即等于"批准人对着这两个值签字"：策略闸门（`assertModerationPolicyOpen`）要的两个布尔
 * 由**批准这一动作**给出，而不是从任何环境变量里读出来的。
 */
export interface ModerationLiveWiringApproval {
  /** 批准理由（仅审计回显，不参与判定）。 */
  readonly reason: string;
  /** 批准时刻（ISO 8601，仅审计）。 */
  readonly approvedAt: string;
  /** 策略被独立核对过的出处（非凭据；要求非空短串）。 */
  readonly policySource: string;
  /** 真实 BizType（形状 `[A-Za-z0-9_-]{1,32}`，由 `live-ports.ts` 的剖面断言复核）。 */
  readonly bizType: string;
}

/** 模块私有身份集合：只认本模块铸造的对象身份（不认形状、不认标志位、不走原型链）。 */
const APPROVED_MODERATION_LIVE_WIRINGS = new WeakSet<object>();

/** 拒绝原因的**闭集**（机器可判；不含任何配置值）。 */
export const MODERATION_LIVE_REFUSAL_REASONS = Object.freeze([
  /** 没有显式批准能力（或给了一个不是本模块铸造的对象）。 */
  'missing_approval',
  /** 批准能力有，但凭据三元组不齐（real 下确实没有真实密钥）。 */
  'missing_credentials',
  /** 批准与凭据都有，但配置不合法（快照断言/端口构造拒绝）⇒ 同样 fail-closed。 */
  'invalid_configuration',
] as const);

export type ModerationLiveRefusalReason = (typeof MODERATION_LIVE_REFUSAL_REASONS)[number];

/**
 * 铸造一份真实审核接线批准能力（**唯一铸造点**）。
 *
 * 每次调用都是一次需要审查的显式接线决定：本片**不**引入 `--approve-*` 启动开关
 * （那属于生产入口 `server.ts` 的一次独立、可审查的变更；见证据页「需要裁定的点」）。
 * ⛔ 生产装配路径（`app.ts` / `server.ts`）今天**不调用**本函数，用例会逐文件断言这一点。
 */
export function approveModerationLiveWiring(input: {
  reason: string;
  policySource: string;
  bizType: string;
  approvedAt?: string;
}): ModerationLiveWiringApproval {
  const approval: ModerationLiveWiringApproval = Object.freeze({
    reason: input.reason,
    approvedAt: input.approvedAt ?? new Date().toISOString(),
    policySource: input.policySource,
    bizType: input.bizType,
  });
  APPROVED_MODERATION_LIVE_WIRINGS.add(approval);
  return approval;
}

/** 只认「由 {@link approveModerationLiveWiring} 铸造」的对象身份；形状相同／派生／代理／克隆一律 false。 */
export function isModerationLiveWiringApproved(value: unknown): value is ModerationLiveWiringApproval {
  return typeof value === 'object' && value !== null && APPROVED_MODERATION_LIVE_WIRINGS.has(value);
}

// ---------------------------------------------------------------------------
// 2. 拒绝描述（与 HTTP 错误封套 `details[]` 同形；原因码只用既有闭集）
// ---------------------------------------------------------------------------

/**
 * 既有原因码语义：模型层**没有给出任何结论**（`packages/moderation/model-verdict.mjs` 的
 * `MODEL_NOT_EVALUATED`）。没有真实端口 ⇒ 从未评估 ⇒ 不得放行。
 *
 * 这里写字面量而不是 import 那个包：`tests/moderation/model-ports.test.mjs` 用**逐文件白名单**
 * 限制 `moderation/**` 里哪些文件可以引用模型合流符号，本片不申请扩大白名单。漂移会由用例
 * （与本包闭集逐项比对那条）立刻打红，不会静默分叉。
 */
export const MODERATION_LIVE_REFUSAL_REASON_CODE = 'MODEL_NOT_EVALUATED';

/** 拒绝描述：对外仍是既有 503 `PROVIDER_UNAVAILABLE`（`retryable: false`），不新增契约码。 */
export interface ModerationLiveWiringRefusal {
  /** 既有契约错误码（HTTP 503）；⛔ 不是 `MODEL_NOT_EVALUATED`。 */
  readonly errorCode: 'PROVIDER_UNAVAILABLE';
  readonly retryable: false;
  readonly reason: ModerationLiveRefusalReason;
  /** 与错误封套 `details[]` 同形；原因码是既有闭集语义，不是新码。 */
  readonly details: readonly { readonly field: 'reason_codes'; readonly code: string }[];
}

function refusalOf(reason: ModerationLiveRefusalReason): ModerationLiveWiringRefusal {
  return Object.freeze({
    errorCode: 'PROVIDER_UNAVAILABLE' as const,
    retryable: false as const,
    reason,
    details: Object.freeze([
      Object.freeze({ field: 'reason_codes' as const, code: MODERATION_LIVE_REFUSAL_REASON_CODE }),
    ]),
  });
}

// ---------------------------------------------------------------------------
// 3. 决定点：real ∧ 凭据齐备 ∧ 显式批准 ⇒ 接线；任一不满足 ⇒ null（保持今天的 503）
// ---------------------------------------------------------------------------

/** 决定结果。`wiring === null` 时 `refusal` 只在 real 下非 null（非 real 不是"失败"）。 */
export type ModerationLiveWiringPlan =
  | { readonly wiring: ModerationLiveWiring; readonly refusal: null }
  | { readonly wiring: null; readonly refusal: ModerationLiveWiringRefusal | null };

/**
 * 由冻结的口径构造两份被校验剖面。
 *
 * 端点/动作/版本/地域/图片上限/传输形态**全部取自 `live-ports.ts` 的冻结常量**（那两份常量本身
 * 逐字对齐 `tools/ai-config.mjs` 的 `AI_ENDPOINTS` 与 `configurationIssues()`）；超时取
 * `config.ts` 的冻结档 `AI_PROVIDER_DEFAULT_TIMEOUT_MS`（落在 `INVALID_TIMEOUT` 的 1000..20000
 * 区间内），重试恒 0（任何重发都是一次新的付费调用）。⛔ 这里不自创任何新档位/新端点。
 */
function profilesFor(bizType: string): { text: ModerationTextProfile; image: ModerationImageProfile } {
  const base = {
    region: MODERATION_VENDOR_REGION,
    timeoutMs: AI_PROVIDER_DEFAULT_TIMEOUT_MS,
    maxRetries: 0 as const,
    bizType,
  };
  return {
    text: {
      ...base,
      endpoint: MODERATION_VENDOR_ENDPOINTS.tms,
      action: MODERATION_VENDOR_ACTIONS.tms.action,
      apiVersion: MODERATION_VENDOR_ACTIONS.tms.apiVersion,
    },
    image: {
      ...base,
      endpoint: MODERATION_VENDOR_ENDPOINTS.ims,
      action: MODERATION_VENDOR_ACTIONS.ims.action,
      apiVersion: MODERATION_VENDOR_ACTIONS.ims.apiVersion,
      maxImageBytes: MODERATION_MAX_IMAGE_BYTES,
      mediaTransport: MODERATION_MEDIA_TRANSPORT,
    },
  };
}

/** 凭据"齐备"的判定：只判存在与形状，**绝不读值出去、绝不出现在任何消息里**。 */
function hasCredentials(value: unknown): value is ModerationLiveCredentials {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const secretId = record['secretId'];
  const secretKey = record['secretKey'];
  const sessionToken = record['sessionToken'];
  return (
    typeof secretId === 'string' &&
    secretId.trim() !== '' &&
    typeof secretKey === 'string' &&
    secretKey.trim() !== '' &&
    typeof sessionToken === 'string'
  );
}

/**
 * **装配决定点**：判断本次装配要不要给 `createModerationService` 传 `liveWiring`。
 *
 * 三个与门（缺任一 ⇒ `wiring: null`，调用方保持今天的 503 fail-closed）：
 *   1. `executionMode === 'real'`（stub / preset_demo **永不**接真实端口，即使环境里有凭据）；
 *   2. 显式批准能力存在（{@link isModerationLiveWiringApproved}，对象身份判定）；
 *   3. 凭据三元组齐备（`config.moderationLive.credentials`）。
 *
 * 构造阶段任何异常都折成 `invalid_configuration`（**不重抛、不把异常文本带出**）：拒绝路径上
 * 只有闭集原因与固定文案，因此凭据值没有回显通道。
 *
 * ⛔ 本函数返回非 null 只表示"端口构造成功"，**不表示**审核策略有效、也不表示违规样本会被拦。
 */
export function resolveModerationLiveWiring(input: {
  /** 执行模式（只认字面量 `'real'`）。 */
  executionMode: string;
  /** 显式批准能力（未铸造的对象一律无效）。 */
  approval?: unknown;
  /** 凭据三元组（生产由 `config.moderationLive` 提供；非 real 恒 `null`）。 */
  credentials?: unknown;
}): ModerationLiveWiringPlan {
  // 非 real：不接线、也不算失败（stub/preset_demo 走既有替身端口，行为与改前逐字相同）。
  if (input.executionMode !== 'real') return { wiring: null, refusal: null };
  if (!isModerationLiveWiringApproved(input.approval)) {
    return { wiring: null, refusal: refusalOf('missing_approval') };
  }
  if (!hasCredentials(input.credentials)) {
    return { wiring: null, refusal: refusalOf('missing_credentials') };
  }
  const approval = input.approval;
  try {
    const profiles = profilesFor(approval.bizType);
    const candidate: ModerationLiveWiring = {
      // 策略闸门要的两个布尔由**批准这一动作**给出（配置侧对审核恒 false，见文件头）。
      policy: {
        policySelectionVerified: true,
        executionAllowed: true,
        source: approval.policySource,
      },
      textProfile: profiles.text,
      imageProfile: profiles.image,
      credentials: input.credentials,
    };
    // 构造一次以确认"这套快照真的能构造出真实端口"（纯对象构造：不联网、不读时钟、不写台账）。
    // 服务侧会按同一份 wiring 再构造一次；两次构造都没有副作用。
    const ports = createLiveModerationPortsFromWiring(candidate);
    if (ports === null) return { wiring: null, refusal: refusalOf('invalid_configuration') };
    return { wiring: candidate, refusal: null };
  } catch {
    // 构造失败（配置不合法）：fail-closed，且**不**把异常文本带出（凭据只在内存里按字段读）。
    return { wiring: null, refusal: refusalOf('invalid_configuration') };
  }
}

// ---------------------------------------------------------------------------
// 4. 装配层用的**唯一入口**（`app.ts` 里一处等行替换，净 0 行）
// ---------------------------------------------------------------------------

/** `moderationServiceAssemblyOption` 的入参：执行模式 + 两个"是否已具备"的事实 + 可选日志出口。 */
export interface ModerationServiceAssemblyInput {
  readonly executionMode: ModerationExecutionMode;
  /** 显式批准能力（未由本模块铸造 ⇒ 一律无效）。 */
  readonly approval?: unknown;
  /** 凭据三元组（生产来自 `config.moderationLive`；非 real 恒 `null`）。 */
  readonly credentials?: unknown;
  /** 闭集原因的出口（装配层传 `(line) => app.log.warn(line)`；缺省即不记日志）。 */
  readonly log?: (line: string) => void;
}

/**
 * 审核服务装配用的选项片段：**总是**带回 `executionMode`，**只在三与门全过时**多带一个 `liveWiring`。
 *
 * 为什么做成"选项片段"而不是在 `app.ts` 里写 `if` + 新变量：`services/api/src/app.ts` 的行号是
 * `docs/architecture/contract-status.json` 与 `docs/**` 手写锚点的指向对象，**插行会让成批锚点漂移**
 * （`tools/verify-doc-anchors.mjs` 的基线说明与其 accept 账本记着这类事故）。本片段让装配点是
 * 一处**等行替换**（净 0 行），判断与文案留在这里，装配层只转发。
 *
 * ⛔ 返回的 `liveWiring` 只表示"端口构造成功"，**不表示**审核策略有效、违规样本会被拦、或供应商会
 * 接受这份剖面——那需要真实凭据与真实付费调用，本片不做（见证据页「没证明什么」）。
 */
export function moderationServiceAssemblyOption(
  input: ModerationServiceAssemblyInput,
): { executionMode: ModerationExecutionMode; liveWiring?: ModerationLiveWiring } {
  const plan = resolveModerationLiveWiring({
    executionMode: input.executionMode,
    ...(input.approval === undefined ? {} : { approval: input.approval }),
    ...(input.credentials === undefined ? {} : { credentials: input.credentials }),
  });
  if (plan.refusal !== null) {
    // 只写闭集原因与原因码：不含异常文本、不含任何配置值（凭据没有进入这条路径的通道）。
    input.log?.(
      `GY-R70 审核域真实接线未成立：reason=${plan.refusal.reason}（`
        + `${plan.refusal.errorCode}/${plan.refusal.details.map((detail) => detail.code).join(',')}）`
        + ' ⇒ real 下审核整域保持 fail-closed 503，绝不回退替身',
    );
  }
  return plan.wiring === null
    ? { executionMode: input.executionMode }
    : { executionMode: input.executionMode, liveWiring: plan.wiring };
}
