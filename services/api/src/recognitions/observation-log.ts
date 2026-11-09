/**
 * GY-R94 · 识别提供者**观测端口**的落日志实现（`services/api/src/app.ts` 装配用）。
 *
 * 为什么需要它：120 次直连实测的 12 次失败全部落 `PROVIDER_OUTCOME_UNKNOWN`，旧观测里只有
 * 状态与错误码，分不清「预算被打断」和「结构没读懂」。本模块把 `LiveRecognitionObservation`
 * 原样落成一条结构化日志事件，并补齐失败归因三项（`finishReason` / `completionTokens` /
 * `contentLength`）——下次失败看一眼日志就能归类，不必再翻请求体。
 *
 * ⛔ 只记结构读数：不记 `message.content` 正文、不记请求体、不记凭据、不记图片内容。
 */

import type { LiveRecognitionObservation } from './live-ports.ts';

/** 只要求 `info` / `warn` 两段签名的最小 logger 面（Fastify 的 `app.log` 满足它）。 */
export interface RecognitionObservationLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

/** 观测 → 一条结构化日志事件（字段与原观测一一对应，缺省一律落 `null`）。 */
export function recognitionObservationEvent(observation: LiveRecognitionObservation): Record<string, unknown> {
  return {
    event: 'recognition.provider.observation',
    protocol: observation.protocol,
    state: observation.state,
    errorCode: observation.errorCode,
    providerErrorCode: observation.providerErrorCode,
    httpStatus: observation.httpStatus,
    requestId: observation.requestId,
    candidateCount: observation.candidateCount,
    imageBytes: observation.imageBytes,
    resultMayHaveBeenProcessed: observation.resultMayHaveBeenProcessed,
    elapsedMs: observation.elapsedMs,
    endpointAsserted: observation.endpointAsserted,
    sendAttempts: observation.sendAttempts,
    // 失败归因三项：`finishReason=length` ⇒ 预算类；`stop` 且 `contentLength > 0` ⇒ 结构类。
    finishReason: observation.finishReason ?? null,
    completionTokens: observation.completionTokens ?? null,
    contentLength: observation.contentLength ?? null,
  };
}

/**
 * 观测 → 日志：业务回包记 `info`，其余（超时 / HTTP 错误 / 结果未知 / 证据不全）记 `warn`。
 *
 * 不吞异常、不做节流：观测端口是旁路，写日志失败不该影响识别判定（`onObservation` 的调用方
 * 已在 `openai-vision-adapter.ts` 用 `?.()` 保护，且不 await）。
 */
export function createRecognitionObservationSink(
  log: RecognitionObservationLogger,
): (observation: LiveRecognitionObservation) => void {
  return (observation) => {
    const event = recognitionObservationEvent(observation);
    if (observation.state === 'BUSINESS_RESPONSE') log.info(event, 'recognition provider observation');
    else log.warn(event, 'recognition provider observation');
  };
}
