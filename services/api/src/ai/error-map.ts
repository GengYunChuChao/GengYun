/**
 * GY-R28 W7（#12）· 真实模型外发的**错误口径**（唯一翻译点）。
 *
 * 目标：把「传输层/供应商层发生了什么」翻译成契约**既有**错误码闭集
 * （`services/api/src/contract.ts` 的 `ERROR_STATUS_MAP`，**不新增**任何 ErrorCode），
 * 并给出是否需要重试的结论。问答服务层的 `settleCodeOf` 只认 `ApiError.code`，
 * 因此这里产出的必须是 `ApiError`；非 `ApiError` 的异常一律被服务层兜底成
 * `PROVIDER_UNAVAILABLE`——那会把「超时」误报成「不可用」，所以**所有**适配器异常都必须
 * 先经过本模块。
 *
 * ## 红线
 * - 错误消息**绝不**包含：响应正文、提问正文、密钥、Authorization 头。
 *   `detail` 只允许是固定的短标签（如 `http_429`、`timeout`、`bad_json`）。
 * - 不重试「已经在供应商侧产生副作用」的形态：本模块只被适配器用于**派发前后的传输层**判定；
 *   超时/网络中断这类「未知是否已计费」的形态明确标 `retryable: true` 但**由调用方**决定是否
 *   重试，且重试只允许发生在 `markSent` 之前（见 `chat-live-adapter.ts` 的注释）。
 */
import { ApiError } from '../errors.ts';
import type { ErrorCode } from '../contract.ts';

/** 失败形态（只用于内部判定与日志，不进契约、不进响应正文）。 */
export const CHAT_FAILURE_KINDS = [
  'timeout',
  'transport',
  'rate_limited',
  'upstream_unavailable',
  'auth',
  'bad_request',
  'bad_response',
  'refused',
] as const;
export type ChatFailureKind = (typeof CHAT_FAILURE_KINDS)[number];

export interface ChatFailure {
  /** 契约既有错误码（闭集成员）。 */
  readonly code: ErrorCode;
  /** 是否值得重试（传输层视角；适配器仍会按「是否已派发」二次约束）。 */
  readonly retryable: boolean;
  readonly kind: ChatFailureKind;
}

const FAILURES: Readonly<Record<ChatFailureKind, ChatFailure>> = Object.freeze({
  // 超时：请求可能已到达供应商 ⇒ 视为「结果未知但可能计费」，标可重试，由调用方决定。
  timeout: { code: 'PROVIDER_TIMEOUT', retryable: true, kind: 'timeout' },
  // 传输层中断（DNS/连接重置/代理断开）：未拿到任何响应。
  transport: { code: 'PROVIDER_UNAVAILABLE', retryable: true, kind: 'transport' },
  // 供应商限流/配额：重试可能有用，但必须让上层看到真实原因。
  rate_limited: { code: 'PROVIDER_QUOTA_EXCEEDED', retryable: true, kind: 'rate_limited' },
  // 供应商 5xx / 网关错误。
  upstream_unavailable: { code: 'PROVIDER_UNAVAILABLE', retryable: true, kind: 'upstream_unavailable' },
  // 401/403：**本仓库侧凭据/权限问题**，重试无意义（不得把密钥问题伪装成临时故障）。
  auth: { code: 'PROVIDER_UNAVAILABLE', retryable: false, kind: 'auth' },
  // 400/413/415/422 等：请求形状/内容被拒，重试无意义。
  bad_request: { code: 'PROVIDER_UNAVAILABLE', retryable: false, kind: 'bad_request' },
  // 200 但响应不可解析（不是 OpenAI 兼容形状、缺 choices/content）。
  bad_response: { code: 'PROVIDER_OUTCOME_UNKNOWN', retryable: false, kind: 'bad_response' },
  // 适配器自身 fail-closed（未配置/未记账/无依据集合）：**从未外发**。
  refused: { code: 'PROVIDER_UNAVAILABLE', retryable: false, kind: 'refused' },
});

export function chatFailure(kind: ChatFailureKind): ChatFailure {
  return FAILURES[kind];
}

/** HTTP 状态 → 失败形态（只在**未**读到可用正文时调用）。 */
export function chatFailureForStatus(status: number): ChatFailure {
  if (status === 401 || status === 403) return FAILURES.auth;
  if (status === 408) return FAILURES.timeout;
  if (status === 429) return FAILURES.rate_limited;
  if (status === 400 || status === 404 || status === 413 || status === 415 || status === 422) {
    return FAILURES.bad_request;
  }
  if (status >= 500) return FAILURES.upstream_unavailable;
  // 其余 2xx/3xx 之外的未知状态：按上游不可用处理（可重试，但不猜测语义）。
  return FAILURES.upstream_unavailable;
}

/** 抛出中的异常 → 失败形态（`AbortError` 是超时唯一可靠信号）。 */
export function chatFailureForThrown(error: unknown): ChatFailure {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  if (name === 'AbortError' || name === 'TimeoutError') return FAILURES.timeout;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return FAILURES.timeout;
  return FAILURES.transport;
}

/**
 * 把失败形态包成 `ApiError`。
 *
 * `detail` 必须是**固定短标签**（如 `http_429` / `bad_json`）——调用方不得把响应正文、
 * 提问正文或任何请求头内容拼进来（这条是红线，评审按「消息里出现非标签字符串」判红）。
 */
export function chatApiError(failure: ChatFailure, detail: string): ApiError {
  const label = /^[a-z0-9_.:-]{1,64}$/.test(detail) ? detail : 'unspecified';
  return new ApiError(failure.code, `问答真实模型外发失败（${failure.kind}:${label}）`, {
    retryable: failure.retryable,
  });
}

/** 失败形态 → 写进外发账本的**结构分类** token（`exports` 只收短 token，不收正文）。 */
export function chatEgressCode(failure: ChatFailure): string {
  return failure.code;
}
