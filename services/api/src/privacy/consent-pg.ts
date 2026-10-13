import type { PoolClient } from 'pg';
import { createPrivacyGuard } from '../../../../packages/privacy/guard.mjs';
import type { PgPool } from '../db/pool.ts';
import type { AuthenticatedIdentity } from '../auth/types.ts';
import { hashToken } from '../auth/tokens.ts';
import { idempotencyKeyHashHex, idempotencyRequestHash, idempotencyScope } from '../auth/idempotency.ts';
import { ApiError } from '../errors.ts';
import { persistConsentGrant, type ConsentGrantRequest } from './grant-pg.ts';
import { paginateConsentRecords } from './consent-pagination.ts';

export const CONSENT_PURPOSES = ['recording', 'media_processing', 'external_inference', 'public_posting'] as const;
type Row = Record<string, unknown>;
type Identity = { identity: AuthenticatedIdentity; token: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function positive(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new ApiError('PROVIDER_UNAVAILABLE', '授权版本不可用');
  return n;
}
function dto(row: Row) {
  const recipients = row['recipient_ids'];
  if (!uuid.test(String(row['id'])) || !CONSENT_PURPOSES.includes(row['purpose'] as typeof CONSENT_PURPOSES[number])
      || typeof row['policy_version'] !== 'string' || row['policy_version'].length < 1 || row['policy_version'].length > 80
      || !Array.isArray(recipients) || recipients.length > 30 || new Set(recipients).size !== recipients.length
      || recipients.some(value => typeof value !== 'string' || value.length < 1 || value.length > 80)
      || !['granted', 'withdrawn'].includes(String(row['state']))
      || !(row['granted_at'] instanceof Date) || !Number.isFinite(row['granted_at'].getTime())
      || (row['state'] === 'granted' ? row['withdrawn_at'] !== null : !(row['withdrawn_at'] instanceof Date))) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '授权记录不可用');
  }
  return {
    id: String(row['id']), purpose: String(row['purpose']), policy_version: String(row['policy_version']),
    recipient_ids: row['recipient_ids'], state: String(row['state']), epoch: positive(row['epoch']),
    revision: positive(row['revision']), granted_at: (row['granted_at'] as Date).toISOString(),
    withdrawn_at: row['withdrawn_at'] === null ? null : (row['withdrawn_at'] as Date).toISOString(),
  };
}
function assertCurrent(row: Row): void {
  dto(row);
  const epoch = positive(row['current_epoch']);
  if (row['state'] !== row['epoch_state'] || positive(row['epoch']) !== (row['epoch_state'] === 'granted' ? epoch : epoch - 1)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '授权版本不一致');
  }
}
const currentRecords = `SELECT c.*,p.state AS epoch_state,p.current_epoch FROM public.privacy_epochs p
  LEFT JOIN public.consent_records c ON c.user_id=p.user_id AND c.purpose=p.purpose
  AND c.epoch=CASE WHEN p.state='granted' THEN p.current_epoch ELSE p.current_epoch-1 END`;

/** No exports, media writes or generic commit callbacks. */
export function createPostgresConsentService(pool: PgPool, hmacKey: string, options: { allowSyntheticGrantPolicy?: boolean } = {}) {
  async function transaction<T>(input: Identity, work: (client: PoolClient, user: Row) => Promise<T>): Promise<T> {
    let client: PoolClient | undefined;
    try {
      if (input.identity.role !== 'user') throw new ApiError('SCOPE_DENIED', '需要用户会话');
      if (!Number.isSafeInteger(input.identity.authEpoch) || input.identity.authEpoch < 1) throw new ApiError('INVALID_REQUEST', '身份版本无效');
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '4s'");
      // All managed mutations take account, session, epoch, record locks in this order.
      const { rows } = await client.query('SELECT id,state,auth_epoch,revision FROM public.users WHERE id=$1::uuid FOR UPDATE', [input.identity.userId]);
      const user = rows[0] as Row | undefined;
      if (!user || user['state'] !== 'active' || positive(user['auth_epoch']) !== input.identity.authEpoch) {
        throw new ApiError('ACCOUNT_INACTIVE', '账号状态或身份版本已失效');
      }
      const session = await client.query(`SELECT id FROM public.sessions
        WHERE id=$1::uuid AND user_id=$2::uuid AND audience='user' AND auth_epoch=$3
        AND token_hash=decode($4,'hex') AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
      [input.identity.sessionId, input.identity.userId, input.identity.authEpoch, hashToken(input.token)]);
      if (session.rows.length !== 1) throw new ApiError('SESSION_EXPIRED', '当前会话已失效');
      const result = await work(client, user);
      const live = await client.query('SELECT id FROM public.sessions WHERE id=$1::uuid AND expires_at>clock_timestamp()', [input.identity.sessionId]);
      if (live.rows.length !== 1) throw new ApiError('SESSION_EXPIRED', '当前会话已失效');
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      if (error instanceof ApiError) throw error;
      const code = (error as { code?: string }).code;
      if (code === 'ACCOUNT_INACTIVE' || code === 'CONSENT_REQUIRED' || code === 'SCOPE_DENIED') {
        throw new ApiError(code, '当前身份或用途授权不满足要求');
      }
      throw new ApiError(code === '57014' || code === '55P03' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE', '授权服务暂不可用');
    } finally { client?.release(); }
  }

  function referenceGuard(user: Row, current: Row[]) {
    // Immutable data read under PG locks; the reference guard is a read gate, not a PG commitGate.
    const id = String(user['id']);
    const snapshots = new Map(current.map(row => [String(row['purpose']), {
      granted: row['state'] === 'granted', epoch: positive(row['current_epoch']),
    }]));
    return createPrivacyGuard({
      account: {
        stateOf: async userId => userId === id ? String(user['state']) : 'deleted',
        authEpochOf: async userId => userId === id ? positive(user['auth_epoch']) : 0,
      },
      consentStore: {
        isGranted: async ({ userId, purpose }) => userId === id && (snapshots.get(purpose)?.granted ?? false),
        currentEpoch: async ({ userId, purpose }) => userId === id ? (snapshots.get(purpose)?.epoch ?? 0) : 0,
      },
    });
  }

  return {
    async grant(input: Identity, request: ConsentGrantRequest) {
      return transaction(input, async client => dto(await persistConsentGrant(client, input.identity.userId, hmacKey, request, options.allowSyntheticGrantPolicy === true)));
    },
    async list(input: Identity, options: { cursor?: string; limit: number }) {
      return transaction(input, async (client, user) => {
        await referenceGuard(user, []).assertAccountActive(input.identity.userId, { authEpoch: input.identity.authEpoch });
        const { rows } = await client.query(`${currentRecords}
          WHERE p.user_id=$1::uuid AND p.current_epoch>0
          ORDER BY c.granted_at DESC,c.id DESC FOR SHARE OF p`, [input.identity.userId]);
        rows.forEach(assertCurrent);
        // Four closed-set purposes: lock/read the complete current snapshot before signing its watermark.
        return paginateConsentRecords(rows.map(dto), {
          ...options, userId: input.identity.userId, authEpoch: input.identity.authEpoch, hmacKey,
        });
      });
    },

    /** For read consumers only. Returning this result cannot authorize a later async write/dispatch. */
    async requireConsent(input: Identity, requirement: { purpose: string; dataType?: string }) {
      return transaction(input, async (client, user) => {
        const { rows } = await client.query(`${currentRecords}
          WHERE p.user_id=$1::uuid AND p.current_epoch>0 FOR SHARE OF p`, [input.identity.userId]);
        rows.forEach(assertCurrent);
        // Epoch rows and their corresponding records must agree before the guard can authorize a read.
        return referenceGuard(user, rows).requireConsent(requirement)({ userId: input.identity.userId, authEpoch: input.identity.authEpoch });
      });
    },

    async withdraw(input: Identity, options: { purpose: string; ifMatch: string; idempotencyKey: string }) {
      const scope = idempotencyScope(input.identity.userId, 'DELETE', `/me/consents/${options.purpose}`);
      const key = idempotencyKeyHashHex(scope, options.idempotencyKey);
      const requestHash = idempotencyRequestHash(null, options.ifMatch, hmacKey);
      return transaction(input, async client => {
        await client.query('DELETE FROM public.idempotency_keys WHERE scope=$1 AND key_hash=decode($2,\'hex\') AND expires_at<=clock_timestamp()', [scope, key]);
        const prior = await client.query('SELECT request_hash,outcome FROM public.idempotency_keys WHERE scope=$1 AND key_hash=decode($2,\'hex\') FOR UPDATE', [scope, key]);
        if (prior.rows.length) {
          const row = prior.rows[0];
          if (row.request_hash !== requestHash) throw new ApiError('IDEMPOTENCY_CONFLICT', '同键请求内容不一致');
          const id = row.outcome?.privacyConsentId;
          if (typeof id !== 'string' || !uuid.test(id)) throw new ApiError('PROVIDER_UNAVAILABLE', '历史授权回执不可用');
          const historical = await client.query(`SELECT * FROM public.consent_records
            WHERE id=$1::uuid AND user_id=$2::uuid AND purpose=$3 AND state='withdrawn' FOR SHARE`, [id, input.identity.userId, options.purpose]);
          if (historical.rows.length !== 1) throw new ApiError('PROVIDER_UNAVAILABLE', '历史授权回执不可用');
          return dto(historical.rows[0]);
        }
        const current = await client.query(`${currentRecords}
          WHERE p.user_id=$1::uuid AND p.purpose=$2 AND p.current_epoch>0 FOR UPDATE OF p`, [input.identity.userId, options.purpose]);
        if (current.rows.length !== 1) throw new ApiError('NOT_FOUND', '没有该用途授权记录');
        let record = current.rows[0];
        assertCurrent(record);
        if (`"${positive(record.revision)}"` !== options.ifMatch) throw new ApiError('REVISION_CONFLICT', '授权版本已变化');
        if (record.state === 'granted') {
          // Consumer cancellation/deletion is not delivered here. Refuse existing dependencies rather than fake success.
          const dependencies = await client.query(`SELECT EXISTS(SELECT 1 FROM public.jobs WHERE owner_id=$1::uuid)
            OR EXISTS(SELECT 1 FROM public.media WHERE owner_id=$1::uuid)
            OR EXISTS(SELECT 1 FROM public.exports WHERE user_id=$1::uuid)
            OR EXISTS(SELECT 1 FROM public.author_links WHERE user_id=$1::uuid) AS present`, [input.identity.userId]);
          if (dependencies.rows[0]?.present) throw new ApiError('OBJECT_UNAVAILABLE', '已有资料或任务的撤回消费者尚未接入');
          const updated = await client.query(`UPDATE public.consent_records SET state='withdrawn',withdrawn_at=clock_timestamp(),revision=revision+1
            WHERE id=$1::uuid AND user_id=$2::uuid AND state='granted' RETURNING *`, [record.id, input.identity.userId]);
          if (updated.rows.length !== 1) throw new ApiError('REVISION_CONFLICT', '授权版本已变化');
          record = updated.rows[0];
          const epoch = await client.query(`UPDATE public.privacy_epochs SET current_epoch=current_epoch+1,state='withdrawn',revision=revision+1,updated_at=clock_timestamp()
            WHERE user_id=$1::uuid AND purpose=$2 AND state='granted' AND current_epoch=$3 RETURNING user_id`, [input.identity.userId, options.purpose, record.epoch]);
          if (epoch.rows.length !== 1) throw new ApiError('REVISION_CONFLICT', '授权版本已变化');
        }
        await client.query(`INSERT INTO public.idempotency_keys(scope,key_hash,request_hash,response_status,outcome,expires_at)
          VALUES($1,decode($2,'hex'),$3,200,$4::jsonb,clock_timestamp()+interval '5 minutes')`,
        [scope, key, requestHash, JSON.stringify({ privacyConsentId: String(record.id) })]);
        return dto(record);
      });
    },
  };
}
