import type { ExecutionMode } from '../contract.ts';
import { ApiError } from '../errors.ts';
import { classifyDatabaseError, type PgPool } from './pool.ts';

export interface HomePreview {
  id: string;
  title: string;
  summary: string;
  content_type: 'knowledge';
  source_kind: 'database' | 'verified_seed';
}

/** Server-owned real mode only. One MVCC statement; no fallback or cached approval. */
export async function readHomePreviews(pool: PgPool | null, mode: ExecutionMode): Promise<HomePreview[]> {
  if (mode !== 'real' || pool === null) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '主页资料数据库尚未接入', { retryable: false });
  }
  try {
    const result = await pool.query<HomePreview>({
      text: 'SELECT id, title, summary, content_type, source_kind FROM catalog_read.home_species ORDER BY id LIMIT 10',
    });
    return result.rows;
  } catch (error) {
    const timeout = classifyDatabaseError(error) === 'timeout' || (error as { code?: unknown })?.code === '57014';
    throw new ApiError(timeout ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE', '主页资料数据库暂不可用', { retryable: true });
  }
}

/** Internal-only evidence lookup. It returns registration metadata, never dose text. */
export async function readRegistrationEvidence(pool: PgPool | null, mode: ExecutionMode, registrationNumber: string) {
  if (mode !== 'real' || pool === null) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '登记资料数据库尚未接入');
  }
  if (registrationNumber.trim().length === 0 || registrationNumber.length > 80) {
    throw new ApiError('INVALID_REQUEST', '登记号格式错误');
  }
  try {
    const result = await pool.query({
      text: 'SELECT * FROM catalog_read.registration_evidence WHERE registration_number = $1 ORDER BY registration_id LIMIT 20',
      values: [registrationNumber],
    });
    return result.rows;
  } catch {
    throw new ApiError('PROVIDER_UNAVAILABLE', '登记资料数据库暂不可用', { retryable: true });
  }
}
