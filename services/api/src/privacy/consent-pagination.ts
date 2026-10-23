/**
 * 授权列表（`GET /me/consents`）的分页：**快照水位 + 签名游标**。
 *
 * 签名/解码核在 `signed-list-cursor.ts`（唯一实现，外发清单 `GET /me/exports` 共用同一份）。
 * 本文件只保留授权域自己的两件事：
 *   1. 水位 = 调用方给的**完整当前快照**的签名（新增/撤回/改版本都会改变水位 ⇒ 旧游标失效）；
 *   2. 游标锚点 = 快照内的记录 id（uuid），翻页从该 id 之后继续。
 */
import { ApiError } from '../errors.ts';
import {
  LIST_CURSOR_TTL_MS,
  decodeListCursor,
  encodeListCursor,
  invalidListCursor,
  signCursorValue,
  type ListCursorBinding,
} from './signed-list-cursor.ts';

const SORT = 'granted_at_desc_id_desc';
const KIND = 'consents';
const DOMAIN = 'consent-list/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INVALID_MESSAGE = '授权分页游标无效、已过期或授权记录已变化';

interface PageOptions {
  userId: string;
  authEpoch: number;
  hmacKey: string;
  limit: number;
  cursor?: string;
  now?: number;
}

/** Caller supplies the current DTO snapshot in DB granted_at DESC, id DESC order, under its identity/record locks. */
export function paginateConsentRecords<T extends { id: string }>(items: readonly T[], options: PageOptions) {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 50) {
    throw new ApiError('INVALID_REQUEST', '分页大小必须为 1..50');
  }
  if (!options.hmacKey) throw new ApiError('PROVIDER_UNAVAILABLE', '授权游标签名配置不可用');
  const now = options.now ?? Date.now();
  const binding: ListCursorBinding = {
    domain: DOMAIN,
    kind: KIND,
    sort: SORT,
    userId: options.userId,
    authEpoch: options.authEpoch,
    hmacKey: options.hmacKey,
    filter: null,
  };
  const watermark = signCursorValue(binding, JSON.stringify(items));
  let start = 0, expires = now + LIST_CURSOR_TTL_MS;
  if (options.cursor !== undefined) {
    const decoded = decodeListCursor(binding, options.cursor, {
      now,
      watermark,
      afterPattern: UUID,
      message: INVALID_MESSAGE,
    });
    const index = items.findIndex((item) => item.id === decoded.after);
    if (index < 0) throw invalidListCursor(INVALID_MESSAGE);
    start = index + 1;
    expires = decoded.expires;
  }
  const page = items.slice(start, start + options.limit);
  const last = page.at(-1);
  if (start + page.length >= items.length || last === undefined) return { items: page, next_cursor: null };
  return { items: page, next_cursor: encodeListCursor(binding, { after: last.id, watermark, expires }) };
}
