import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../errors.ts';

const CURSOR_TTL_MS = 15 * 60 * 1000;
const SORT = 'granted_at_desc_id_desc';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURSOR_KEYS = ['v', 'kind', 'user', 'auth_epoch', 'filter', 'sort', 'watermark', 'after', 'expires'];

interface PageOptions {
  userId: string;
  authEpoch: number;
  hmacKey: string;
  limit: number;
  cursor?: string;
  now?: number;
}

function invalidCursor(): ApiError {
  return new ApiError('INVALID_CURSOR', '授权分页游标无效、已过期或授权记录已变化');
}

/** Caller supplies the current DTO snapshot in DB granted_at DESC, id DESC order, under its identity/record locks. */
export function paginateConsentRecords<T extends { id: string }>(items: readonly T[], options: PageOptions) {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 50) {
    throw new ApiError('INVALID_REQUEST', '分页大小必须为 1..50');
  }
  if (!options.hmacKey) throw new ApiError('PROVIDER_UNAVAILABLE', '授权游标签名配置不可用');
  const now = options.now ?? Date.now();
  // Domain separation prevents a cursor/signature from another API from being accepted here.
  const sign = (value: string) => createHmac('sha256', options.hmacKey).update(`consent-list/v1\n${value}`).digest('base64url');
  const watermark = sign(JSON.stringify(items));
  let start = 0, expires = now + CURSOR_TTL_MS;
  if (options.cursor !== undefined) {
    try {
      if (typeof options.cursor !== 'string' || options.cursor.length > 2048) throw invalidCursor();
      const [encoded, signature, extra] = options.cursor.split('.');
      if (!encoded || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(encoded)
          || !/^[A-Za-z0-9_-]{43}$/.test(signature)) throw invalidCursor();
      const expected = Buffer.from(sign(encoded), 'base64url');
      const received = Buffer.from(signature, 'base64url');
      if (received.length !== expected.length || received.toString('base64url') !== signature
          || !timingSafeEqual(expected, received)) throw invalidCursor();
      const bytes = Buffer.from(encoded, 'base64url');
      if (bytes.toString('base64url') !== encoded) throw invalidCursor();
      const value = JSON.parse(bytes.toString('utf8'));
      if (!value || Array.isArray(value) || typeof value !== 'object'
          || Object.keys(value).length !== CURSOR_KEYS.length || CURSOR_KEYS.some(key => !Object.hasOwn(value, key))
          || value.v !== 1 || value.kind !== 'consents' || value.user !== options.userId
          || value.auth_epoch !== options.authEpoch || value.filter !== null || value.sort !== SORT
          || value.watermark !== watermark || !Number.isSafeInteger(value.expires) || value.expires <= now
          || typeof value.after !== 'string' || !UUID.test(value.after)) throw invalidCursor();
      const index = items.findIndex(item => item.id === value.after);
      if (index < 0) throw invalidCursor();
      start = index + 1;
      expires = value.expires;
    } catch { throw invalidCursor(); }
  }
  const page = items.slice(start, start + options.limit);
  if (start + page.length >= items.length) return { items: page, next_cursor: null };
  const encoded = Buffer.from(JSON.stringify({
    v: 1, kind: 'consents', user: options.userId, auth_epoch: options.authEpoch, filter: null,
    sort: SORT, watermark, after: page.at(-1)?.id, expires,
  })).toString('base64url');
  return { items: page, next_cursor: `${encoded}.${sign(encoded)}` };
}
