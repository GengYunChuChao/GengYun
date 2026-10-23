/**
 * 外发清单（契约 `listExports` / `GET /me/exports`）的读面装配。
 *
 * ## 数据来源
 * 只走**既有外发账本的读面**：`privacy/ledger-pg.ts` 的 `createPostgresExportLedger().list()`
 * （`WHERE user_id = $1` + `(created_at,id)` keyset），经 `packages/privacy/egress.mjs` 的
 * `listExportsForUser()` 投影成契约 `ExportPage`（`{ items, next_cursor }`）。本文件
 * **不写任何 SQL**：账本的列面与排序口径已经由 `ledger-pg.ts` 一处承担。
 *
 * ## 游标
 * 账本自带的 keyset 游标是**不透明但未签名**的（`base64url(JSON)`，无主体/有效期绑定）。
 * 契约面要的是"私有列表的签名游标" ⇒ 本文件把它**原样装进**全仓唯一的签名游标引擎
 * `privacy/signed-list-cursor.ts`（与授权列表 `GET /me/consents` 同一份实现）：
 *   - 外层游标绑定 `user` / `auth_epoch` / `kind` / `sort` / `expires` 并带 HMAC；
 *   - 内层（账本 keyset）作为 `after` 锚点，**不重写分页策略**：翻页仍由账本 keyset 执行。
 * ⇒ 别人的游标、换登录版本后的旧游标、过期游标、篡改游标都在**读库之前**被拒（`INVALID_CURSOR`）。
 *
 * ## fail-closed
 * - 无连接池 ⇒ 路由层直接 `PROVIDER_UNAVAILABLE`(503)，**不用内存账本冒充持久化**；
 * - 账本记录形状不合契约 ⇒ `toContractExport` 抛 `PROVIDER_UNAVAILABLE`（宁可 503 也不输出
 *   自相矛盾的条目）；
 * - 运行时角色对 `public.exports` 无 SELECT 授权（`20-login-roles.sql` 的 egress_ledger 组未部署，
 *   见 `tests/unit/sql-column-coverage.test.mjs` 的 `LEDGER_COVERAGE_EXEMPT`）
 *   ⇒ `ledger-pg.ts` 的 `mapPgError` 把 42501 归为 `PROVIDER_UNAVAILABLE`(503, retryable=false)。
 */
import type { PgPool } from '../db/pool.ts';
import { ApiError } from '../errors.ts';
import { listExportsForUser } from '../../../../packages/privacy/egress.mjs';
import { createPostgresExportLedger, type PostgresExportLedger } from './ledger-pg.ts';
import {
  LIST_CURSOR_TTL_MS,
  decodeListCursor,
  encodeListCursor,
  type ListCursorBinding,
} from './signed-list-cursor.ts';

/** 契约 `ExportPage` 的一页（`items` 为 `components.schemas.Export`）。 */
export interface ExportPage {
  items: Array<Record<string, unknown>>;
  next_cursor: string | null;
}

export const EXPORTS_CURSOR_KIND = 'exports';
export const EXPORTS_CURSOR_SORT = 'created_at_desc_id_desc';
export const EXPORTS_CURSOR_DOMAIN = 'export-list/v1';
const INVALID_MESSAGE = '导出清单分页游标无效、已过期或清单已变化';
/**
 * 内层锚点（账本 keyset 游标）的形状：`base64url(JSON{t,id})`。
 * 上限 1536 是为了让**外层**游标（base64url(JSON(9 键)) + `.` + 43 字符签名）稳在契约 2048 以内。
 */
const LEDGER_CURSOR = /^[A-Za-z0-9_-]{1,1536}$/;

export interface ExportsListService {
  list(
    identity: { userId: string; authEpoch: number },
    query: { limit: number; cursor?: string | null },
  ): Promise<ExportPage>;
}

export function createExportsListService(input: {
  pool: PgPool;
  /** 游标签名密钥（与授权列表同源：会话签名密钥）；空值 ⇒ 503，不降级成无签名游标。 */
  hmacKey: string;
  now?: () => number;
  /** 测试注入点：默认用真实 PG 账本读面。 */
  ledger?: Pick<PostgresExportLedger, 'list'>;
}): ExportsListService {
  const clock = input.now ?? (() => Date.now());
  /**
   * 账本读面**懒建**：装配期不碰连接池。
   *
   * 口径同本仓其它域（`tests/unit/ocr-store-pg-wiring.test.mjs`「构造期不得打库」）：
   * `buildApp` 只是接线，不能因为池对象形状不合就在**启动期**抛错 —— 那会把「后端未配置」
   * 变成进程起不来的崩溃。第一个真实请求才解析账本，解析不了 ⇒ 契约 `PROVIDER_UNAVAILABLE`。
   */
  let readFace: Pick<PostgresExportLedger, 'list'> | null = input.ledger ?? null;
  function ledger(): Pick<PostgresExportLedger, 'list'> {
    if (readFace === null) {
      try {
        readFace = createPostgresExportLedger({ pool: input.pool });
      } catch {
        throw new ApiError('PROVIDER_UNAVAILABLE', '外发账本连接池不可用');
      }
    }
    return readFace;
  }
  return {
    async list(identity, query) {
      if (typeof input.hmacKey !== 'string' || input.hmacKey.length === 0) {
        throw new ApiError('PROVIDER_UNAVAILABLE', '导出游标签名配置不可用');
      }
      const binding: ListCursorBinding = {
        domain: EXPORTS_CURSOR_DOMAIN,
        kind: EXPORTS_CURSOR_KIND,
        sort: EXPORTS_CURSOR_SORT,
        userId: identity.userId,
        authEpoch: identity.authEpoch,
        hmacKey: input.hmacKey,
        filter: null,
      };
      const now = clock();
      let anchor: string | null = null;
      let expires = now + LIST_CURSOR_TTL_MS;
      if (query.cursor !== undefined && query.cursor !== null) {
        const decoded = decodeListCursor(binding, query.cursor, {
          now,
          watermark: null,
          afterPattern: LEDGER_CURSOR,
          message: INVALID_MESSAGE,
        });
        anchor = decoded.after;
        expires = decoded.expires;
      }
      // 账本读面（既有实现）：`WHERE user_id=$1` 的 keyset 页；`limit+1` 的看一页由账本自己处理。
      const page = await listExportsForUser(ledger(), {
        userId: identity.userId,
        limit: query.limit,
        cursor: anchor,
      });
      const next = page.next_cursor;
      if (next === null) return { items: page.items, next_cursor: null };
      if (!LEDGER_CURSOR.test(next)) {
        // 账本给出的锚点超出本面能承载的形状 ⇒ 宁可 503，也不吐一个下页一定被拒的游标。
        throw new ApiError('PROVIDER_UNAVAILABLE', '外发账本读面返回了不可承载的分页锚点');
      }
      return { items: page.items, next_cursor: encodeListCursor(binding, { after: next, watermark: null, expires }) };
    },
  };
}
