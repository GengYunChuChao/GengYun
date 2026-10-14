import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../errors.ts';

const TTL_MS = 15 * 60 * 1000;
const KEYS = ['v', 'kind', 'user', 'auth_epoch', 'filter', 'sort', 'watermark', 'after', 'expires'];
interface CatalogItem { [key: string]: string | null }
interface Options {
  kind: 'crops' | 'regions';
  userId: string;
  authEpoch: number;
  hmacKey: string;
  limit: number;
  parentCode?: string;
  cursor?: string;
  now?: number;
}
function invalid(): ApiError {
  return new ApiError('INVALID_CURSOR', '目录游标无效或已失效，请重新查询');
}

/** Caller supplies the fresh key-ordered catalog under its authenticated DB transaction. */
export function paginateCatalog<T extends CatalogItem>(items: readonly T[], options: Options) {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 50) {
    throw new ApiError('INVALID_REQUEST', '分页大小必须为 1..50');
  }
  if (!options.hmacKey) throw new ApiError('PROVIDER_UNAVAILABLE', '目录游标签名配置不可用');
  const now = options.now ?? Date.now();
  const sign = (value: string) => createHmac('sha256', options.hmacKey)
    .update(`profile-catalog/v1\n${value}`).digest('base64url');
  const watermark = sign(JSON.stringify(items));
  const filter = options.parentCode ?? null;
  const field = options.kind === 'crops' ? 'id' : 'code';
  const visible = items.filter(item => filter === null || item['parent_code'] === filter);
  let start = 0, expires = now + TTL_MS;
  if (options.cursor !== undefined) {
    try {
      if (typeof options.cursor !== 'string' || options.cursor.length > 2048) throw invalid();
      const [encoded, signature, extra] = options.cursor.split('.');
      if (!encoded || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(encoded)
          || !/^[A-Za-z0-9_-]{43}$/.test(signature)) throw invalid();
      const received = Buffer.from(signature, 'base64url');
      const expected = Buffer.from(sign(encoded), 'base64url');
      if (received.length !== expected.length || received.toString('base64url') !== signature
          || !timingSafeEqual(expected, received)) throw invalid();
      const bytes = Buffer.from(encoded, 'base64url');
      if (bytes.toString('base64url') !== encoded) throw invalid();
      const value = JSON.parse(bytes.toString('utf8'));
      if (!value || Array.isArray(value) || typeof value !== 'object'
          || Object.keys(value).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(value, key))
          || value.v !== 1 || value.kind !== options.kind || value.user !== options.userId
          || value.auth_epoch !== options.authEpoch || value.filter !== filter
          || value.watermark !== watermark || value.sort !== 'catalog_key_asc'
          || !Number.isSafeInteger(value.expires) || value.expires <= now || value.expires > now + TTL_MS
          || typeof value.after !== 'string') throw invalid();
      const index = visible.findIndex(item => item[field] === value.after);
      if (index < 0) throw invalid();
      start = index + 1;
      expires = value.expires;
    } catch { throw invalid(); }
  }
  const page = visible.slice(start, start + options.limit);
  if (start + page.length >= visible.length) return { items: page, next_cursor: null };
  const encoded = Buffer.from(JSON.stringify({ v: 1, kind: options.kind, user: options.userId,
    auth_epoch: options.authEpoch, filter, watermark, sort: 'catalog_key_asc',
    after: page.at(-1)?.[field], expires })).toString('base64url');
  return { items: page, next_cursor: `${encoded}.${sign(encoded)}` };
}
