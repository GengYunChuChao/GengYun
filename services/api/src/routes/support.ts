/**
 * 路由层共用支撑：成功封套的 meta、幂等重放。
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CONTRACT_VERSION } from '../contract.ts';
import type { AppConfig } from '../config.ts';
import { ApiError } from '../errors.ts';
import type { AuthService } from '../auth/service.ts';
import {
  idempotencyKeyHashHex,
  idempotencyScope,
  type IdempotencyOutcome,
  type IdempotencyRecord,
} from '../auth/idempotency.ts';

/** 成功响应 meta（openapi Meta）。request_id 为 Fastify 生成的 uuid。 */
export function buildMeta(request: FastifyRequest, config: AppConfig): Record<string, unknown> {
  return {
    request_id: request.id,
    contract_version: CONTRACT_VERSION,
    execution_mode: config.executionMode,
  };
}

export interface RouteOutcome {
  status: number;
  body: unknown;
  /** 不含凭据的结果引用，写入幂等台账；**绝不**写完整响应体（可能含 bearer 令牌）。 */
  idempotencyOutcome: IdempotencyOutcome;
  etag?: string;
  cacheControl?: string;
}

export interface IdempotentOptions {
  request: FastifyRequest;
  reply: FastifyReply;
  service: AuthService;
  /** 键域主体：已鉴权账号 id；公开登录端点为 'anonymous'。 */
  subject: string;
  method: string;
  routePath: string;
  now: () => Date;
  produce: () => Promise<RouteOutcome>;
  /**
   * 命中有效台账（同键同体）时的重放路径。
   * 台账只存不含凭据的结果引用，因此**不得回放旧响应**；必须重新校验当前状态并重新签发。
   * 缺省回落到 `produce`（退出类等无凭据的幂等操作）。
   */
  replay?: (record: IdempotencyRecord) => Promise<RouteOutcome>;
}

function send(outcome: RouteOutcome, reply: FastifyReply): void {
  if (outcome.etag !== undefined) reply.header('ETag', outcome.etag);
  if (outcome.cacheControl !== undefined) reply.header('Cache-Control', outcome.cacheControl);
  reply.status(outcome.status);
  reply.send(outcome.body);
}

/**
 * 幂等执行：先校验 Idempotency-Key。
 * - 未命中台账：执行 produce，只把**不含凭据的结果引用**写入台账。
 * - 命中有效台账同键同体：走 replay（重新校验当前状态并重新签发），**不回放旧响应**。
 * - 同键异体判 409 IDEMPOTENCY_CONFLICT。
 *
 * 注意：调用方必须已在此之前完成鉴权（契约「重放前重新鉴权」）。
 * 因此退出类请求在会话已撤销后的重放会得到 401，而不是回放旧 Ack——这是契约要求的行为。
 */
export async function runIdempotent(options: IdempotentOptions): Promise<void> {
  const { request, reply, service, subject, method, routePath, now, produce, replay } = options;

  const rawKey = request.headers['idempotency-key'];
  const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
  if (typeof key !== 'string' || key.trim().length < 8 || key.length > 128) {
    throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', '缺少或非法的 Idempotency-Key 头（8..128 字符）');
  }

  const scope = idempotencyScope(subject, method, routePath);
  const keyHashHex = idempotencyKeyHashHex(scope, key);
  const requestHash = service.hashIdempotencyRequest(request.body, request.headers['if-match']);
  const at = now();

  // 实际到期清理：每次幂等请求先物理删除已到期条目（不是只写 TTL 字段）。
  await service.purgeExpiredIdempotent(at);

  const existing = await service.findIdempotent(scope, keyHashHex);
  if (existing !== null && existing.expiresAt.getTime() > at.getTime()) {
    if (existing.requestHash !== requestHash) {
      throw new ApiError('IDEMPOTENCY_CONFLICT', '同一 Idempotency-Key 已被不同请求体使用');
    }
    // 命中台账：不回放旧响应（其中可能含已失效或明文的 bearer）；重新执行重放路径。
    const replayOutcome = await (replay ?? produce)(existing);
    reply.header('Cache-Control', 'no-store');
    send(replayOutcome, reply);
    return;
  }

  const outcome = await produce();
  await service.saveIdempotent(scope, keyHashHex, {
    requestHash,
    responseStatus: outcome.status,
    outcome: outcome.idempotencyOutcome,
    expiresAt: new Date(at.getTime() + service.idempotencyTtlSeconds * 1000),
  });

  send(outcome, reply);
}
