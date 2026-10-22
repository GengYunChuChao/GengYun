import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { isTransientDatabaseError, type PgPool } from '../db/pool.ts';
import type { AuthenticatedIdentity } from '../auth/types.ts';
import { hashToken } from '../auth/tokens.ts';
import { IDEMPOTENCY_TTL_SECONDS, idempotencyScope, idempotencyKeyHashHex, idempotencyRequestHash } from '../auth/idempotency.ts';
import { ApiError } from '../errors.ts';
import { paginateCatalog } from './pagination.ts';

type Row = Record<string, unknown>;
type Identity = { identity: AuthenticatedIdentity; token: string };
export interface ProfileInput { crop_id: string; region_code: string; region_catalog_version: string }
export interface Profile { crop_id: string | null; region_code: string | null; region_catalog_version: string | null; revision: number }
export interface CatalogItem { [key: string]: string | null }
const crops = JSON.parse(readFileSync(new URL('../../../../packages/knowledge/catalog/crops.json', import.meta.url), 'utf8')).crops as Array<{id: string; name: string}>;
const regions = JSON.parse(readFileSync(new URL('../../../../packages/knowledge/catalog/regions-zhejiang.json', import.meta.url), 'utf8')).regions as Array<{code: string; name: string; parent_code: string | null; catalog_version: string}>;
const empty = (): Profile => ({ crop_id: null, region_code: null, region_catalog_version: null, revision: 1 });
function profile(row: Row): Profile {
  const revision = Number(row['revision']);
  if (!Number.isSafeInteger(revision) || revision < 2 || typeof row['crop_id'] !== 'string'
      || typeof row['region_code'] !== 'string' || !/^33[0-9]{4}$/.test(row['region_code'])
      || typeof row['region_catalog_version'] !== 'string') throw new ApiError('PROVIDER_UNAVAILABLE', '档案记录不可用');
  return { crop_id: row['crop_id'], region_code: row['region_code'], region_catalog_version: row['region_catalog_version'], revision };
}

/** Persistent profile only: no seed-as-success fallback, coordinates, providers or historical record writes. */
export function createProfileService(pool: PgPool, key: string) {
  async function transaction<T>(input: Identity, work: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient | undefined;
    try {
      if (input.identity.role !== 'user') throw new ApiError('SCOPE_DENIED', '需要用户会话');
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='4s'");
      const user = await client.query('SELECT state,auth_epoch FROM public.users WHERE id=$1::uuid FOR UPDATE', [input.identity.userId]);
      if (user.rows.length !== 1 || user.rows[0].state !== 'active' || Number(user.rows[0].auth_epoch) !== input.identity.authEpoch) {
        throw new ApiError('ACCOUNT_INACTIVE', '账号状态或版本已失效');
      }
      const session = await client.query(`SELECT id FROM public.sessions WHERE id=$1::uuid AND user_id=$2::uuid
        AND audience='user' AND auth_epoch=$3 AND token_hash=decode($4,'hex')
        AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
      [input.identity.sessionId, input.identity.userId, input.identity.authEpoch, hashToken(input.token)]);
      if (session.rows.length !== 1) throw new ApiError('SESSION_EXPIRED', '当前会话已失效');
      const result = await work(client);
      const live = await client.query('SELECT id FROM public.sessions WHERE id=$1::uuid AND expires_at>clock_timestamp()', [input.identity.sessionId]);
      if (live.rows.length !== 1) throw new ApiError('SESSION_EXPIRED', '当前会话已失效');
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      if (error instanceof ApiError) throw error;
      const code = (error as {code?: string}).code;
      // 状态码口径不变：`57014`/`55P03` 仍是 504 `PROVIDER_TIMEOUT`，其余仍是 503 `PROVIDER_UNAVAILABLE`。
      // `retryable` 是**另一个轴**（口径见 `services/api/src/errors.ts` 的 `ApiError` 注释）：瞬时态 ⇒ true。
      // 判据唯一出处是 `services/api/src/db/pool.ts` 的 `isTransientDatabaseError()`，本文件不另写码表。
      throw new ApiError(code === '57014' || code === '55P03' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE', '档案数据库暂不可用',
        { retryable: isTransientDatabaseError(error) });
    } finally { client?.release(); }
  }
  async function directory(client: PoolClient, kind: 'crops' | 'regions'): Promise<CatalogItem[]> {
    if (kind === 'crops') {
      const {rows} = await client.query('SELECT id,name FROM public.crops WHERE active AND id=ANY($1::varchar[]) ORDER BY id FOR SHARE', [crops.map(item => item.id)]);
      return rows.filter(row => crops.some(item => item.id === row.id && item.name === row.name));
    }
    const {rows} = await client.query('SELECT code,name,parent_code,catalog_version FROM public.regions WHERE supported AND code=ANY($1::varchar[]) ORDER BY code FOR SHARE', [regions.map(item => item.code)]);
    return rows.filter(row => regions.some(item => item.code === row.code && item.name === row.name && item.parent_code === row.parent_code && item.catalog_version === row.catalog_version));
  }
  return {
    async get(input: Identity) {
      return transaction(input, async client => {
        const {rows} = await client.query('SELECT crop_id,region_code,region_catalog_version,revision FROM public.single_profiles WHERE user_id=$1::uuid', [input.identity.userId]);
        return rows.length === 0 ? empty() : profile(rows[0]);
      });
    },
    async put(input: Identity, body: ProfileInput, ifMatch: string, idempotencyKey: string) {
      const scope = idempotencyScope(input.identity.userId, 'PUT', '/me/profile');
      const keyHash = idempotencyKeyHashHex(scope, idempotencyKey);
      const digest = idempotencyRequestHash({ crop_id: body.crop_id, region_code: body.region_code, region_catalog_version: body.region_catalog_version }, ifMatch, key);
      return transaction(input, async client => {
        await client.query("DELETE FROM public.idempotency_keys WHERE scope=$1 AND key_hash=decode($2,'hex') AND expires_at<=clock_timestamp()", [scope, keyHash]);
        const prior = await client.query("SELECT request_hash,outcome FROM public.idempotency_keys WHERE scope=$1 AND key_hash=decode($2,'hex') FOR UPDATE", [scope, keyHash]);
        if (prior.rows.length) {
          if (prior.rows[0].request_hash !== digest) throw new ApiError('IDEMPOTENCY_CONFLICT', '同键请求内容不一致');
          const receipt = prior.rows[0].outcome?.profileReceipt;
          if (receipt?.user_id !== input.identity.userId) throw new ApiError('PROVIDER_UNAVAILABLE', '档案回执不可用');
          return profile(receipt);
        }
        const current = await client.query('SELECT crop_id,region_code,region_catalog_version,revision FROM public.single_profiles WHERE user_id=$1::uuid FOR UPDATE', [input.identity.userId]);
        const before = current.rows.length ? profile(current.rows[0]) : empty();
        if (ifMatch !== `"${before.revision}"`) throw new ApiError('REVISION_CONFLICT', '档案版本已变化');
        const cropItems = await directory(client, 'crops');
        const regionItems = await directory(client, 'regions');
        if (!cropItems.some(item => item['id'] === body.crop_id) || !regionItems.some(item => item['code'] === body.region_code && item['catalog_version'] === body.region_catalog_version)) {
          throw new ApiError('INVALID_REQUEST', '请选择当前支持的作物和地区版本');
        }
        const {rows} = await client.query(`INSERT INTO public.single_profiles(user_id,crop_id,region_code,region_catalog_version,revision)
          VALUES($1::uuid,$2,$3,$4,2) ON CONFLICT(user_id) DO UPDATE SET crop_id=EXCLUDED.crop_id,
          region_code=EXCLUDED.region_code,region_catalog_version=EXCLUDED.region_catalog_version,
          revision=single_profiles.revision+1,updated_at=clock_timestamp()
          RETURNING crop_id,region_code,region_catalog_version,revision`, [input.identity.userId, body.crop_id, body.region_code, body.region_catalog_version]);
        const result = profile(rows[0]);
        await client.query(`INSERT INTO public.idempotency_keys(scope,key_hash,request_hash,response_status,outcome,expires_at)
          VALUES($1,decode($2,'hex'),$3,200,$4::jsonb,clock_timestamp()+($5::integer * interval '1 second'))`,
        [scope, keyHash, digest, JSON.stringify({profileReceipt: {...result, user_id: input.identity.userId}}), IDEMPOTENCY_TTL_SECONDS]);
        return result;
      });
    },
    async list(input: Identity, kind: 'crops' | 'regions', options: {cursor?: string; limit: number; parent_code?: string}) {
      return transaction(input, async client => {
        const items = await directory(client, kind);
        return paginateCatalog(items, {
          kind, userId: input.identity.userId, authEpoch: input.identity.authEpoch, hmacKey: key,
          limit: options.limit,
          ...(options.parent_code === undefined ? {} : {parentCode: options.parent_code}),
          ...(options.cursor === undefined ? {} : {cursor: options.cursor}),
        });
      });
    },
  };
}
