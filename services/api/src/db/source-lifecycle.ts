import { ApiError } from '../errors.ts';
import type { PgPool } from './pool.ts';

export interface SourceOperation {
  operationId: string;
  action: 'withdraw' | 'restore';
  sourceId: string;
  sourceVersionId: string;
  expectedRevision: number;
  expectedValidity: 'valid' | 'unknown' | 'expired' | 'conflicting' | 'withdrawn';
  reason: string;
  restoresOperationId?: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** No pg query options: they can override the URL authority or read SSL files. */
export function validateSourceDatabaseUrl(value: string | undefined,
  databasePaths: readonly string[] = ['/gengyun_source_ops_test','/gengyun_local']): string {
  let url: URL;
  try { url = new URL(value ?? ''); }
  catch { throw new ApiError('INVALID_REQUEST','只允许显式的本机隔离来源操作数据库'); }
  if (!['postgres:','postgresql:'].includes(url.protocol)
    || !['127.0.0.1','localhost','[::1]'].includes(url.hostname)
    || !databasePaths.includes(url.pathname)
    || url.href.includes('?') || url.href.includes('#')) {
    throw new ApiError('INVALID_REQUEST','只允许无查询参数和片段的本机隔离来源操作数据库');
  }
  return url.href;
}
export function validateSourceOperation(input: SourceOperation): void {
  if (![input.operationId,input.sourceId,input.sourceVersionId].every((v) => typeof v==='string' && uuid.test(v))
    || !['withdraw','restore'].includes(input.action)
    || !Number.isInteger(input.expectedRevision) || input.expectedRevision<1 || input.expectedRevision>=2147483647
    || !['valid','unknown','expired','conflicting','withdrawn'].includes(input.expectedValidity)
    || typeof input.reason !== 'string' || input.reason.trim().length===0 || [...input.reason].length>200
    || (input.action==='restore' && (typeof input.restoresOperationId!=='string' || !uuid.test(input.restoresOperationId)))
    || (input.action==='withdraw' && input.restoresOperationId!==undefined)) {
    throw new ApiError('INVALID_REQUEST','来源操作参数错误');
  }
}
/** One fixed database function call. Its row locks + CAS + audit share one transaction. */
export async function applySourceOperation(pool: PgPool, input: SourceOperation) {
  validateSourceOperation(input);
  try {
    const result = await pool.query('SELECT catalog_ops.apply_source_operation($1,$2,$3,$4,$5,$6,$7,$8) AS result',
      [input.operationId,input.action,input.sourceId,input.sourceVersionId,input.expectedRevision,input.expectedValidity,input.reason,input.restoresOperationId??null]);
    const receipt = result.rows[0]?.result;
    if (receipt === null || typeof receipt !== 'object'
      || receipt.operation_id !== input.operationId.toLowerCase() || receipt.action !== input.action
      || receipt.source_id !== input.sourceId.toLowerCase() || receipt.source_version_id !== input.sourceVersionId.toLowerCase()
      || !Number.isInteger(receipt.resulting_revision) || receipt.resulting_revision < 2
      || receipt.resulting_validity !== (input.action === 'withdraw' ? 'withdrawn' : 'valid')
      || typeof receipt.replayed !== 'boolean') {
      throw new ApiError('PROVIDER_OUTCOME_UNKNOWN','来源操作回执未确认，请保持同一编号核对后重试');
    }
    return {
      operation_id: receipt.operation_id, action: receipt.action, source_id: receipt.source_id,
      source_version_id: receipt.source_version_id, resulting_revision: receipt.resulting_revision,
      resulting_validity: receipt.resulting_validity, replayed: receipt.replayed,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const code=(error as {code?: unknown})?.code;
    switch(code) {
      case 'G0001': case '22P02': throw new ApiError('INVALID_REQUEST','来源操作参数错误');
      case 'G0002': throw new ApiError('NOT_FOUND','目标来源版本不存在');
      case 'G0003': throw new ApiError('REVISION_CONFLICT','来源状态或版本已变化');
      case 'G0004': throw new ApiError('SOURCE_CONFLICT','不满足精确撤回恢复条件');
      case 'G0005': case '23505': throw new ApiError('IDEMPOTENCY_CONFLICT','操作编号已用于其他请求');
      case '57014': throw new ApiError('PROVIDER_TIMEOUT','来源操作超时',{retryable:true});
      default: {
        const unknown = typeof code !== 'string' || ['ECONNRESET','EPIPE','ETIMEDOUT'].includes(code);
        throw new ApiError(unknown ? 'PROVIDER_OUTCOME_UNKNOWN' : 'PROVIDER_UNAVAILABLE',
          '来源操作结果未确认，请使用同一操作编号核对后重试',{retryable:true});
      }
    }
  }
}
