import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../errors.ts';

const TTL_MS = 15 * 60 * 1000;
const KEYS = ['v', 'kind', 'user', 'auth_epoch', 'filter', 'sort', 'watermark', 'after', 'expires'];
interface CatalogItem { [key: string]: string | null }
interface Options {
  kind: 'crops' | 'regions' | 'species';
  userId: string;
  authEpoch: number;
  hmacKey: string;
  limit: number;
  parentCode?: string;
  /**
   * 物种目录的 `q`。它与 `parentCode` 是同一件事：**一条会签进游标的收窄条件**
   * （换关键词即旧游标失效），不是「客户端自己过滤」的自由参数。
   */
  q?: string;
  /** `q` 的检索面；`kind='species'` 时必须给出。归一化在本文内部完成，调用方只给原文。 */
  searchText?: (item: CatalogItem) => string;
  cursor?: string;
  now?: number;
}
function invalid(): ApiError {
  return new ApiError('INVALID_CURSOR', '目录游标无效或已失效，请重新查询');
}
/** `q` 归一化：折叠空白 + 小写化，与 packages/reference/catalog.mjs 的 normalizeText 同口径（只用于比较）。 */
function normalizeTerm(value: string | undefined | null): string {
  return typeof value === 'string' ? value.replace(/\s+/g, '').toLowerCase() : '';
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
  // 物种目录没有父级：`q` 占同一个 `filter` 槽位，于是「换关键词重放旧游标」= INVALID_CURSOR。
  // 归一化后为空的关键词按「未收窄」处理（与 reference 层 q 的口径一致，不当作必空条件）。
  const term = options.kind === 'species' ? normalizeTerm(options.q) : '';
  // 接线缺失时不许「静默 0 条」——那正是「空数组冒充成功」的另一种写法。
  if (term !== '' && options.searchText === undefined) throw new ApiError('PROVIDER_UNAVAILABLE', '目录检索面未装配');
  const filter = options.kind === 'species' ? (term === '' ? null : term) : (options.parentCode ?? null);
  const field = options.kind === 'regions' ? 'code' : 'id';
  const visible = filter === null ? items : items.filter(item => options.kind === 'species'
    ? normalizeTerm(options.searchText?.(item)).includes(filter)
    : item['parent_code'] === filter);
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
