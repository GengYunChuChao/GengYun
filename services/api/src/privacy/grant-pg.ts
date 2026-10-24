import type { PoolClient } from 'pg';
import { ApiError } from '../errors.ts';
import { IDEMPOTENCY_TTL_SECONDS, idempotencyKeyHashHex, idempotencyRequestHash, idempotencyScope } from '../auth/idempotency.ts';
import type { EgressRevoker } from './consent-pg.ts';

export interface ConsentGrantRequest {
  purpose: string;
  policy_version: string;
  recipient_ids: string[];
  idempotencyKey: string;
  /** Optional header is bound in the generic request digest, never a grant version precondition. */
  ifMatch?: string | string[];
}
type Row = Record<string, unknown>;
function number(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new ApiError('PROVIDER_UNAVAILABLE', '授权版本不可用');
  return n;
}
function evidence(value: unknown, synthetic: boolean): boolean {
  if (typeof value !== 'string' || value.length > 2000) return false;
  if (synthetic) return /^fixture:\/\/[a-z0-9/_-]+$/i.test(value);
  try { const u = new URL(value); return u.protocol === 'https:' && u.username === '' && u.password === ''; }
  catch { return false; }
}
/**
 * Internal SQL step: caller must already hold account/session locks in consent service.
 *
 * `egressRevoker`（接线单）：注入后，「已有业务依赖的授权变更」改为**先撤销在途外发**
 * 再写新 epoch；未注入 ⇒ 保持既有 `OBJECT_UNAVAILABLE` fail-closed 兜底（逐字不变）。
 */
export async function persistConsentGrant(client: PoolClient, userId: string, hmacKey: string, input: ConsentGrantRequest, allowSynthetic: boolean, egressRevoker: EgressRevoker | null = null): Promise<Row> {
  if (!['recording','media_processing','external_inference','public_posting'].includes(input.purpose)
      || typeof input.policy_version !== 'string' || input.policy_version.length < 1 || input.policy_version.length > 80
      || !Array.isArray(input.recipient_ids) || input.recipient_ids.length > 30 || new Set(input.recipient_ids).size !== input.recipient_ids.length
      || input.recipient_ids.some(id => typeof id !== 'string' || id.length < 1 || id.length > 80)) {
    throw new ApiError('INVALID_REQUEST', '授权输入无效');
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 128) throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', '缺少有效幂等键');
  const scope = idempotencyScope(userId, 'POST', '/me/consents');
  const key = idempotencyKeyHashHex(scope, input.idempotencyKey);
  const hash = idempotencyRequestHash({ purpose: input.purpose, policy_version: input.policy_version, recipient_ids: input.recipient_ids }, input.ifMatch, hmacKey);
  await client.query("DELETE FROM public.idempotency_keys WHERE scope=$1 AND key_hash=decode($2,'hex') AND expires_at<=clock_timestamp()", [scope,key]);
  const prior = (await client.query("SELECT request_hash,outcome FROM public.idempotency_keys WHERE scope=$1 AND key_hash=decode($2,'hex') FOR UPDATE", [scope,key])).rows[0];
  if (prior && prior.request_hash !== hash) throw new ApiError('IDEMPOTENCY_CONFLICT', '同键请求内容不一致');
  // Current authority is locked even on replay: retired/expired/unverified resources never re-enable consent.
  const policy = (await client.query(`SELECT * FROM public.consent_policies WHERE purpose=$1 AND enabled
    AND reviewed_at<=clock_timestamp() AND valid_from<=clock_timestamp() AND valid_until>clock_timestamp() FOR SHARE`, [input.purpose])).rows[0];
  if (!policy) throw new ApiError('CONSENT_REQUIRED', '没有可用的已核验用途政策');
  const synthetic = policy.source_kind === 'synthetic';
  if ((synthetic && !allowSynthetic) || (!synthetic && policy.source_kind !== 'verified')
      || !evidence(policy.source_ref, synthetic) || !evidence(policy.review_evidence_ref, synthetic)
      || !/^[0-9a-f]{64}$/.test(policy.content_sha256)) throw new ApiError('CONSENT_REQUIRED', '用途政策来源尚未核验');
  if (policy.policy_version !== input.policy_version) throw new ApiError('REVISION_CONFLICT', '用途政策版本已变化');
  const assertPolicyFresh = async () => {
    const fresh = await client.query('SELECT id FROM public.consent_policies WHERE id=$1 AND valid_until>clock_timestamp()', [policy.id]);
    if (fresh.rows.length !== 1) throw new ApiError('CONSENT_REQUIRED', '用途政策已到期');
  };
  const bindings = policy.recipient_bindings as Record<string, unknown>;
  if (input.purpose === 'external_inference' && input.recipient_ids.length === 0) throw new ApiError('CONSENT_REQUIRED', '对外推理需要已核验接收方');
  for (const id of [...input.recipient_ids].sort()) {
    const binding = bindings[id] as Record<string, unknown> | undefined;
    if (!binding || !evidence(binding['no_training_evidence_ref'], synthetic) || !evidence(binding['deletion_evidence_ref'], synthetic)) throw new ApiError('CONSENT_REQUIRED', '接收方核验证据不可用');
    const recipient = (await client.query(`SELECT * FROM public.recipients WHERE id=$1 AND enabled
      AND no_training_verified AND deletion_verified FOR SHARE`, [id])).rows[0];
    if (!recipient || recipient.config_version !== binding['config_version'] || recipient.policy_version !== binding['policy_version']
        || recipient.capability !== binding['capability'] || recipient.retention_online_days !== binding['retention_online_days']
        || recipient.retention_backup_days !== binding['retention_backup_days'] || !['weed','ocr','asr','tts','llm','moderation'].includes(recipient.capability)
        || recipient.retention_online_days > 7 || recipient.retention_backup_days > 30) throw new ApiError('CONSENT_REQUIRED', '接收方配置或留存删除尚未核验');
  }
  const epoch = (await client.query('SELECT * FROM public.privacy_epochs WHERE user_id=$1 AND purpose=$2 FOR UPDATE', [userId,input.purpose])).rows[0];
  const currentEpoch = epoch ? number(epoch.current_epoch) : 0;
  if (epoch && currentEpoch === 0 && epoch.state !== 'withdrawn') throw new ApiError('PROVIDER_UNAVAILABLE', '未授予用途版本不一致');
  const current = currentEpoch === 0 ? null : (await client.query(`SELECT * FROM public.consent_records WHERE user_id=$1 AND purpose=$2 AND epoch=$3 FOR UPDATE`, [userId,input.purpose,epoch.state === 'granted' ? currentEpoch : currentEpoch-1])).rows[0];
  if (currentEpoch > 0 && (!current || current.state !== epoch.state)) throw new ApiError('PROVIDER_UNAVAILABLE', '授权记录与版本不一致');
  if (prior) {
    if (!current || current.state !== 'granted' || prior.outcome?.privacyGrantId !== current.id
        || current.policy_version !== input.policy_version || JSON.stringify(current.recipient_ids) !== JSON.stringify(input.recipient_ids)) {
      throw new ApiError('CONSENT_REQUIRED', '历史授予已失效');
    }
    await assertPolicyFresh();
    return current;
  }
  const expected = current ? number(current.revision) : 1;
  // 授权变更消费者（接线单）：注入后先撤销在途外发；未注入 ⇒ 保持既有 fail-closed 兜底。
  const deps = (await client.query(`SELECT EXISTS(SELECT 1 FROM public.media WHERE owner_id=$1)
    OR EXISTS(SELECT 1 FROM public.exports WHERE user_id=$1)
    OR EXISTS(SELECT 1 FROM public.author_links WHERE user_id=$1) AS present`, [userId])).rows[0];
  if (deps?.present) {
    if (!egressRevoker) throw new ApiError('OBJECT_UNAVAILABLE', '已有业务依赖的授权变更消费者尚未接入');
    // 与撤回同口径：消费者必须先真的撤销在途外发；账本未就绪或失败 ⇒ **如实拒绝**（fail-closed），
    // 不把驱动错误冒泡成 PROVIDER_UNAVAILABLE。
    try {
      await egressRevoker.onConsentWithdrawn({ userId, purpose: input.purpose });
    } catch {
      throw new ApiError('OBJECT_UNAVAILABLE', '授权变更消费者不可用：拒绝在途未撤销的授权变更');
    }
  }
  // Revisions never reset; different keys are serialized new consent intents, not stale-header conflicts.
  const revision = Math.max(expected, epoch ? number(epoch.revision) : 1) + 1;
  const nextEpoch = currentEpoch + 1;
  if (current?.state === 'granted') await client.query("UPDATE public.consent_records SET state='withdrawn',withdrawn_at=clock_timestamp(),revision=revision+1 WHERE id=$1", [current.id]);
  const record = (await client.query(`INSERT INTO public.consent_records(user_id,purpose,policy_version,recipient_ids,state,epoch,revision)
    VALUES($1,$2,$3,$4::jsonb,'granted',$5,$6) RETURNING *`, [userId,input.purpose,input.policy_version,JSON.stringify(input.recipient_ids),nextEpoch,revision])).rows[0];
  await client.query(`INSERT INTO public.privacy_epochs(user_id,purpose,current_epoch,state,revision) VALUES($1,$2,$3,'granted',$4)
    ON CONFLICT(user_id,purpose) DO UPDATE SET current_epoch=excluded.current_epoch,state='granted',revision=excluded.revision,updated_at=clock_timestamp()`, [userId,input.purpose,nextEpoch,revision]);
  await client.query(`INSERT INTO public.idempotency_keys(scope,key_hash,request_hash,response_status,outcome,expires_at)
    VALUES($1,decode($2,'hex'),$3,201,$4::jsonb,clock_timestamp()+($5::integer * interval '1 second'))`, [scope,key,hash,JSON.stringify({privacyGrantId:record.id}),IDEMPOTENCY_TTL_SECONDS]);
  // Time can advance while blocked in SQL even though rows are locked.
  await assertPolicyFresh();
  return record;
}
