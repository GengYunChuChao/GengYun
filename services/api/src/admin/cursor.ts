/**
 * 分页游标编解码（GY-I18 阶段 1）。
 *
 * 契约参数 `Cursor`：`{type:"string", maxLength:2048}`；响应体是 `items` + `next_cursor`。
 * 本实现沿用仓库既有做法（见 `services/api/src/knowledge/service.ts`）：游标是
 * **带 HMAC 签名**的不透明串，客户端无法伪造，也改不动其中的过滤/水位信息。
 *
 * 为什么带 watermark：游标只记「上一页最后一条的 id」并不安全——期间数据发生变化后
 * 继续翻页会静默跳条/重条。这里把当前可见集合的 id 序列摘要写进游标，集合一变就
 * `INVALID_CURSOR`，宁可让客户端重开一页。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../errors.ts';

/** 契约 `Cursor.maxLength`。 */
export const CURSOR_MAX_LENGTH = 2048;
/** 游标有效期：15 分钟（与既有知识读口径一致）。 */
export const CURSOR_TTL_MS = 15 * 60 * 1000;

export interface CursorPayload {
  kind: 'content' | 'audit';
  /** 调用方主体，防止一个管理员复用别人的游标。 */
  subject: string;
  /** 资料家族；审计列表用 '*'。 */
  family: string;
  /** 上一页最后一条的 id；首页为 null。 */
  after: string | null;
  /** 当前可见集合 id 序列的 HMAC 摘要。 */
  watermark: string;
  /** 到期时刻（epoch ms）。 */
  expires: number;
}

export interface CursorCodec {
  encode(payload: CursorPayload): string;
  decode(cursor: string): CursorPayload;
  watermarkOf(ids: readonly string[]): string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createCursorCodec(key: string): CursorCodec {
  const sign = (text: string): string => createHmac('sha256', key).update(text).digest('base64url');

  return {
    watermarkOf(ids) {
      return sign(JSON.stringify(ids));
    },
    encode(payload) {
      const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
      return `${body}.${sign(body)}`;
    },
    decode(cursor) {
      const parts = cursor.split('.');
      if (parts.length !== 2) throw new ApiError('INVALID_CURSOR', '游标格式非法');
      const [body, signature] = parts;
      if (body === undefined || signature === undefined || body === '' || signature === '') {
        throw new ApiError('INVALID_CURSOR', '游标格式非法');
      }
      const expected = Buffer.from(sign(body));
      const provided = Buffer.from(signature);
      if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
        throw new ApiError('INVALID_CURSOR', '游标签名不匹配');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        throw new ApiError('INVALID_CURSOR', '游标内容不可解析');
      }
      if (
        !isRecord(parsed) ||
        (parsed['kind'] !== 'content' && parsed['kind'] !== 'audit') ||
        typeof parsed['subject'] !== 'string' ||
        typeof parsed['family'] !== 'string' ||
        (parsed['after'] !== null && typeof parsed['after'] !== 'string') ||
        typeof parsed['watermark'] !== 'string' ||
        typeof parsed['expires'] !== 'number' ||
        !Number.isFinite(parsed['expires'])
      ) {
        throw new ApiError('INVALID_CURSOR', '游标字段非法');
      }
      return {
        kind: parsed['kind'],
        subject: parsed['subject'],
        family: parsed['family'],
        after: parsed['after'],
        watermark: parsed['watermark'],
        expires: parsed['expires'],
      };
    },
  };
}
