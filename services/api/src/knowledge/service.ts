import type { PgPool } from '../db/pool.ts';
import type { AuthenticatedIdentity } from '../auth/types.ts';
import { hashToken } from '../auth/tokens.ts';
import { ApiError } from '../errors.ts';
import { paginateKnowledge } from './pagination.ts';

type Identity = { identity: AuthenticatedIdentity; token: string };
export interface KnowledgeQuery {
  cursor?: string; limit?: number; q?: string; crop_id?: string; region_code?: string;
  species_id?: string; growth_stage?: string; planting_method?: string; use_scene?: string;
}
type Row = Record<string, any>;
export interface KnowledgeServiceOptions {
  /**
   * 额外并入查询面的行（与 `catalog_read.current_knowledge` 同形）。
   *
   * 用途（GY-I07 / #7）：把**已合入仓库的浙江首批真实资料**
   * （`packages/knowledge/zhejiang/materials-zhejiang-v1.json`）并入同一份读取快照，
   * 使既有过滤/分页/游标水位/封套**不必改动**即可如实带出这批条目。
   *
   * 契约没有 visibility 字段，因此「未发布（private）」语义由**装配层**控制：
   * 只有非 `real` 执行模式**且**装配层显式放行未核对种子时才注入
   * （见 `routes/knowledge.ts` 的 `APP_KNOWLEDGE_UNVERIFIED_SEED` 显式开关）；
   * 行内 `review_status` 会**逐行**投影到 `SourceRef.review_status`（未核对即 `unverified`），
   * 绝不被统一改写成 `verified`。
   */
  extraRows?: () => Row[] | Promise<Row[]>;
}
/** Only the operator-owned, fail-closed public projection is readable by this group. */
export function createKnowledgeService(pool: PgPool, key: string, options: KnowledgeServiceOptions = {}) {
  async function read(input: Identity, query: KnowledgeQuery, id?: string) {
    let client;
    try {
      if (input.identity.role !== 'user') throw new ApiError('SCOPE_DENIED', '需要用户会话');
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='4s'");
      const account = await client.query('SELECT state,auth_epoch FROM public.users WHERE id=$1::uuid FOR SHARE', [input.identity.userId]);
      if (account.rows.length !== 1 || account.rows[0].state !== 'active' || Number(account.rows[0].auth_epoch) !== input.identity.authEpoch) throw new ApiError('ACCOUNT_INACTIVE', '账号已失效');
      const session = await client.query(`SELECT id FROM public.sessions WHERE id=$1::uuid AND user_id=$2::uuid
        AND audience='user' AND auth_epoch=$3 AND token_hash=decode($4,'hex')
        AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
      [input.identity.sessionId,input.identity.userId,input.identity.authEpoch,hashToken(input.token)]);
      if (!session.rows.length) throw new ApiError('SESSION_EXPIRED', '会话已失效');
      // One fresh statement snapshot includes body, source version, validity and
      // latest revision. No process cache or static seed fallback is consulted.
      const dbResult = await client.query('SELECT * FROM catalog_read.current_knowledge ORDER BY id');
      // GY-I07：把已合入的真实种子资料（浙江首批，未发布/未核对）并入**同一份**快照。
      // 同 id 以数据库投影为准（视图只含已核对+已发布，种子只含未核对+未发布，正常不重叠）。
      // 归并后按 id 升序 —— 与游标自述的 sort=id_asc 一致且确定性可复现
      // （数据库投影本已 ORDER BY id，排序不改变其相对顺序）。
      const extra = options.extraRows === undefined ? [] : await options.extraRows();
      const known = new Set(dbResult.rows.map((row: Row) => row.id));
      const rows = [...dbResult.rows, ...extra.filter((row) => !known.has(row.id))]
        .sort((a: Row, b: Row) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const filter = {q: query.q ?? null, crop_id: query.crop_id ?? null, region_code: query.region_code ?? null,
        species_id: query.species_id ?? null, growth_stage: query.growth_stage ?? null,
        planting_method: query.planting_method ?? null, use_scene: query.use_scene ?? null};
      const visible = rows.filter((row: Row) => (!id || row.id === id)
        && (!filter.q || `${row.title}\n${row.body}`.toLocaleLowerCase('zh-CN').includes(filter.q.toLocaleLowerCase('zh-CN')))
        && (!filter.crop_id || row.crop_ids.includes(filter.crop_id))
        && (!filter.region_code || row.region_codes.includes(filter.region_code))
        && (!filter.species_id || row.species_ids.includes(filter.species_id))
        // Current schema has no stage/method/scene evidence. It cannot prove
        // a requested applicability condition; do not silently drop filters.
        && !filter.growth_stage && !filter.planting_method && !filter.use_scene);
      // `review_status` / `validity` 逐行投影：数据库投影行不带这两列时按读视图的准入
      // 事实（已验证 + 有效）取 `verified` / `valid`；**并入的未核对种子行必须如实标 unverified**。
      const project = (row: Row) => {
        const validity = typeof row.validity === 'string' ? row.validity : 'valid';
        return {id: row.id,revision: row.revision,type: row.type,title: row.title,body: row.body,
        source: {id: row.source_id,version: row.source_version,title: row.source_title,url: row.url,
          publisher: row.publisher,source_kind: row.source_kind,evidence_kind: row.evidence_kind,
          validity,review_status: typeof row.review_status === 'string' ? row.review_status : 'verified',
          updated_at: new Date(row.updated_at).toISOString()},
        conditions: null,reference_state: validity === 'valid' ? 'available' : 'unavailable',dose_cards: []};
      };
      if (id && !visible.length) throw new ApiError('NOT_FOUND', '资料不可用');
      const page = id ? null : paginateKnowledge(visible, { userId: input.identity.userId,
        authEpoch: input.identity.authEpoch, hmacKey: key, filter, snapshot: rows,
        cursor: query.cursor, limit: query.limit ?? 20 });
      const result = page === null ? project(visible[0]) : {items: page.items.map(project),next_cursor:page.next_cursor};
      const alive = await client.query('SELECT id FROM public.sessions WHERE id=$1::uuid AND expires_at>clock_timestamp()', [input.identity.sessionId]);
      if (!alive.rows.length) throw new ApiError('SESSION_EXPIRED','会话已失效');
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(()=>{});
      if (error instanceof ApiError) throw error;
      throw new ApiError(['57014','55P03'].includes((error as {code?: string}).code ?? '') ? 'PROVIDER_TIMEOUT':'PROVIDER_UNAVAILABLE','资料数据库暂不可用');
    } finally {client?.release();}
  }
  return {list: (input: Identity, query: KnowledgeQuery) => read(input,query), get: (input: Identity,id: string,query: KnowledgeQuery) => read(input,query,id)};
}
