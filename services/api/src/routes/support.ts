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
  idempotencyRequestHash,
  idempotencyScope,
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
}

/**
 * 幂等执行：先校验 Idempotency-Key，命中重放窗口内同键同体则直接回放首次响应，
 * 同键异体判 409 IDEMPOTENCY_CONFLICT。
 *
 * 注意：调用方必须已在此之前完成鉴权（契约「重放前重新鉴权」）。
 * 因此退出类请求在会话已撤销后的重放会得到 401，而不是回放旧 Ack——这是契约要求的行为。
 */
export async function runIdempotent(options: IdempotentOptions): Promise<void> {
  const { request, reply, service, subject, method, routePath, now, produce } = options;

  const rawKey = request.headers['idempotency-key'];
  const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
  if (typeof key !== 'string' || key.trim().length < 8 || key.length > 128) {
    throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', '缺少或非法的 Idempotency-Key 头（8..128 字符）');
  }

  const scope = idempotencyScope(subject, method, routePath);
  const keyHashHex = idempotencyKeyHashHex(scope, key);
  const requestHash = idempotencyRequestHash(request.body, request.headers['if-match']);
  const at = now();

  const existing = await service.findIdempotent(scope, keyHashHex);
  if (existing !== null && existing.expiresAt.getTime() > at.getTime()) {
    if (existing.requestHash !== requestHash) {
      throw new ApiError('IDEMPOTENCY_CONFLICT', '同一 Idempotency-Key 已被不同请求体使用');
    }
    reply.header('Cache-Control', 'no-store');
    reply.status(existing.responseStatus);
    reply.send(existing.responseBody);
    return;
  }

  const outcome = await produce();
  await service.saveIdempotent(scope, keyHashHex, {
    requestHash,
    responseStatus: outcome.status,
    responseBody: outcome.body,
    expiresAt: new Date(at.getTime() + service.idempotencyTtlSeconds * 1000),
  });

  if (outcome.etag !== undefined) reply.header('ETag', outcome.etag);
  if (outcome.cacheControl !== undefined) reply.header('Cache-Control', outcome.cacheControl);
  reply.status(outcome.status);
  reply.send(outcome.body);
}
