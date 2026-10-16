import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../errors.ts';

const TTL_MS = 15 * 60 * 1000;
/**
 * 游标自述的排序标识 —— 必须与读取层（`service.ts` 的 SQL `ORDER BY`
 * 与归并比较器）**逐字一致**：契约把排序写进游标签名绑定
 * （`docs/architecture/state-contract.md:32`），旧排序签发的游标在这里被拒，
 * 由客户端按其既有口径「点击查询重新开始」，不静默换序续读。
 */
const SORT = 'created_at_desc';
const KEYS = ['v', 'kind', 'user', 'auth_epoch', 'filter', 'sort', 'watermark', 'after', 'expires'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
interface Options {
  userId: string;
  authEpoch: number;
  hmacKey: string;
  filter: Record<string, string | null>;
  /** Complete fresh DB projection, including source lifecycle evidence. */
  snapshot: readonly unknown[];
  limit: number;
  cursor?: string;
  now?: number;
}
function invalid(): ApiError {
  return new ApiError('INVALID_CURSOR', '资料游标无效、已过期或资料已变化');
}

/** Caller authenticates and reads the fresh projection under its existing DB transaction. */
export function paginateKnowledge<T extends { id: string }>(items: readonly T[], options: Options) {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 50) {
    throw new ApiError('INVALID_REQUEST', '分页大小必须为 1..50');
  }
  if (!options.hmacKey) throw new ApiError('PROVIDER_UNAVAILABLE', '资料游标签名配置不可用');
  const now = options.now ?? Date.now();
  const sign = (value: string) => createHmac('sha256', options.hmacKey)
    .update(`knowledge-list/v1\n${value}`).digest('base64url');
  const watermark = sign(JSON.stringify(options.snapshot));
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
          || value.v !== 1 || value.kind !== 'knowledge' || value.user !== options.userId
          || value.auth_epoch !== options.authEpoch || value.sort !== SORT
          || JSON.stringify(value.filter) !== JSON.stringify(options.filter) || value.watermark !== watermark
          || !Number.isSafeInteger(value.expires) || value.expires <= now || value.expires > now + TTL_MS
          || typeof value.after !== 'string' || !UUID.test(value.after)) throw invalid();
      const index = items.findIndex(item => item.id === value.after);
      if (index < 0) throw invalid();
      start = index + 1;
      expires = value.expires;
    } catch { throw invalid(); }
  }
  const page = items.slice(start, start + options.limit);
  if (start + page.length >= items.length) return { items: page, next_cursor: null };
  const encoded = Buffer.from(JSON.stringify({ v: 1, kind: 'knowledge', user: options.userId,
    auth_epoch: options.authEpoch, filter: options.filter, sort: SORT, watermark,
    after: page.at(-1)?.id, expires })).toString('base64url');
  return { items: page, next_cursor: `${encoded}.${sign(encoded)}` };
}
