/**
 * GY-R28-W1 · 供应商业务错误码 → 契约 `ErrorCode` 的**唯一**映射表（三域共用）。
 *
 * 为什么单独一份：TTS / OCR / ASR 走同一套腾讯云 TC3 错误码语义（配额 / 鉴权 / 参数 / 内部错），
 * 三处各抄一遍迟早漂移，而漂移的后果是**同一类供应商故障在不同域落到不同契约码**。
 * 本文件是纯函数 + 常量，无 IO、无凭据、无网络。
 *
 * 映射口径（保持 `tts/provider.ts` 原有实现逐字不变，本文件只是把它搬到这里供三域共用）：
 * - 配额/限流类 ⇒ `PROVIDER_QUOTA_EXCEEDED`
 * - 账号/服务/凭据不可用 ⇒ `PROVIDER_UNAVAILABLE`（对外不区分是哪一种，避免泄露账号状态）
 * - `InvalidParameter*` / `MissingParameter` ⇒ `PROVIDER_OUTCOME_UNKNOWN`
 *   （请求体由**服务端**从已核对内容/受控字节构造，参数错说明是我们自己的适配器缺陷，
 *    映射成 400 会把责任错误推给客户端）
 * - `InternalError*` / 未知码 ⇒ `PROVIDER_OUTCOME_UNKNOWN`（不声称可用，也不声称是干净失败）
 */
import type { LiveGateErrorCode } from '../tts/live-ports.ts';

/** 供应商原始错误码 → 契约码。原始码由调用方**原样**写入台账，本函数只做契约映射。 */
export function providerErrorCodeToErrorCode(code: string): LiveGateErrorCode {
  // 配额/限流类。
  if (/^(ResourceUnavailable\.ResourcePackageRunOut|UnsupportedOperation\.PkgExhausted)/.test(code)) return 'PROVIDER_QUOTA_EXCEEDED';
  if (/^(RequestLimitExceeded|LimitExceeded)/.test(code)) return 'PROVIDER_QUOTA_EXCEEDED';
  // 账号/服务/凭据不可用（对外不区分是哪一种，避免泄露账号状态）。
  if (/^(AuthFailure|UnauthorizedOperation)($|\.)/.test(code)) return 'PROVIDER_UNAVAILABLE';
  if (['InvalidCredential', 'FailedOperation.UnOpenError', 'FailedOperation.UserNotRegistered'].includes(code)) {
    return 'PROVIDER_UNAVAILABLE';
  }
  // `InvalidParameter*` / `MissingParameter`：请求体由服务端从已核对正文构造，
  // 参数错说明是**我们自己的适配器缺陷**，映射成 400 会把责任错误推给客户端 ⇒ 按「结果不可判定」处理。
  if (/^(InvalidParameter|MissingParameter)/.test(code)) return 'PROVIDER_OUTCOME_UNKNOWN';
  // `InternalError*` / `FailedOperation.ServiceIsolate` / 未知码：不声称可用，也不声称是干净失败。
  return 'PROVIDER_OUTCOME_UNKNOWN';
}
