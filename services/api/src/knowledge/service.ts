import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PgPool } from '../db/pool.ts';
import type { AuthenticatedIdentity } from '../auth/types.ts';
import { hashToken } from '../auth/tokens.ts';
import { ApiError } from '../errors.ts';

type Identity = { identity: AuthenticatedIdentity; token: string };
export interface KnowledgeQuery {
  cursor?: string; limit?: number; q?: string; crop_id?: string; region_code?: string;
  species_id?: string; growth_stage?: string; planting_method?: string; use_scene?: string;
}
type Row = Record<string, any>;
/** Only the operator-owned, fail-closed public projection is readable by this group. */
export function createKnowledgeService(pool: PgPool, key: string) {
  const sign = (text: string) => createHmac('sha256', key).update(text).digest('base64url');
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
      const {rows} = await client.query('SELECT * FROM catalog_read.current_knowledge ORDER BY id');
      const filter = {q: query.q ?? null, crop_id: query.crop_id ?? null, region_code: query.region_code ?? null,
        species_id: query.species_id ?? null, growth_stage: query.growth_stage ?? null,
        planting_method: query.planting_method ?? null, use_scene: query.use_scene ?? null};
      const watermark = sign(JSON.stringify(rows));
      let after = '';
      if (query.cursor !== undefined) {
        try {
          const [encoded, signature, extra] = query.cursor.split('.');
          if (!encoded || !signature || extra !== undefined) throw Error();
          const expected = Buffer.from(sign(encoded)), got = Buffer.from(signature);
          if (expected.length !== got.length || !timingSafeEqual(expected,got)) throw Error();
          const cursor = JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
          if (cursor.user !== input.identity.userId || cursor.kind !== 'knowledge' || cursor.sort !== 'id_asc'
            || cursor.watermark !== watermark || JSON.stringify(cursor.filter) !== JSON.stringify(filter)
            || !Number.isSafeInteger(cursor.expires) || cursor.expires <= Date.now()
            || typeof cursor.after !== 'string') throw Error();
          after = cursor.after;
        } catch { throw new ApiError('INVALID_CURSOR', '资料游标无效或资料已变化'); }
      }
      const visible = rows.filter((row: Row) => (!id || row.id === id) && row.id > after
        && (!filter.q || `${row.title}\n${row.body}`.toLocaleLowerCase('zh-CN').includes(filter.q.toLocaleLowerCase('zh-CN')))
        && (!filter.crop_id || row.crop_ids.includes(filter.crop_id))
        && (!filter.region_code || row.region_codes.includes(filter.region_code))
        && (!filter.species_id || row.species_ids.includes(filter.species_id))
        // Current schema has no stage/method/scene evidence. It cannot prove
        // a requested applicability condition; do not silently drop filters.
        && !filter.growth_stage && !filter.planting_method && !filter.use_scene);
      const project = (row: Row) => ({id: row.id,revision: row.revision,type: row.type,title: row.title,body: row.body,
        source: {id: row.source_id,version: row.source_version,title: row.source_title,url: row.url,
          publisher: row.publisher,source_kind: row.source_kind,evidence_kind: row.evidence_kind,
          validity: 'valid',review_status: 'verified',updated_at: new Date(row.updated_at).toISOString()},
        conditions: null,reference_state: 'available',dose_cards: []});
      if (id && !visible.length) throw new ApiError('NOT_FOUND', '资料不可用');
      const page = visible.slice(0,query.limit ?? 20);
      const encoded = Buffer.from(JSON.stringify({user: input.identity.userId,kind:'knowledge',sort:'id_asc',filter,watermark,
        after:page.at(-1)?.id,expires:Date.now()+15*60*1000})).toString('base64url');
      const result = id ? project(visible[0]) : {items: page.map(project),next_cursor:visible.length>page.length ? `${encoded}.${sign(encoded)}` : null};
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
