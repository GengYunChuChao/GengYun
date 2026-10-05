/**
 * 不透明会话令牌与摘要。
 *
 * 契约与状态协议要求：
 * - 用户/后台令牌为**可服务端撤销的不透明 bearer**，不在 URL / 日志记录；
 * - 用户会话默认 7 日绝对有效期，后台 8 小时绝对有效期，无自动永续续期；
 * - 服务端只保存摘要（0001 的 sessions.token_hash / admin_sessions.token_hash 为 bytea）。
 */
import { createHash, randomBytes } from 'node:crypto';

/** 用户会话绝对有效期：7 日（state-contract）。 */
export const USER_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
/** 后台会话绝对有效期：8 小时（state-contract）。 */
export const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;

/** 生成 256 位随机不透明令牌（base64url，无结构化信息，客户端不可推导身份）。 */
export function mintOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 令牌摘要（hex）。令牌本身熵足够，无需加盐；仅用于等值查找。 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 通用 SHA-256（hex）。 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 解析 `Authorization: Bearer <token>`；缺失或格式不符返回 null。 */
export function readBearerToken(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(raw.trim());
  if (match === null) return null;
  const token = match[1];
  return token === undefined || token === '' ? null : token;
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
