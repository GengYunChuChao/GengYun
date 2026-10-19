import type { ExecutionMode } from '../contract.ts';
import { ApiError } from '../errors.ts';
import { classifyDatabaseError, isTransientDatabaseError, type PgPool } from './pool.ts';

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
    // `retryable` 按 `errors.ts` 的唯一口径分档（本文件两处 catch 同口径）：
    // 超时类 ⇒ `PROVIDER_TIMEOUT` 且可重试；连接层/管理员干预/串行化冲突/死锁 ⇒ 瞬时，可重试；
    // 其余（28P01 凭据、3D000 库缺失、42501 权限、无 code 的无法归类错误）⇒ 需运维介入，**不可重试**。
    throw new ApiError(timeout ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE', '主页资料数据库暂不可用', {
      retryable: isTransientDatabaseError(error),
    });
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
  } catch (error) {
    // 与 `readHomePreviews()` 同一口径（此处保留既有 `PROVIDER_UNAVAILABLE` 状态码不变，只订正 `retryable`）：
    // 瞬时类可重试；配置/权限/无法归类 ⇒ 不可重试。
    throw new ApiError('PROVIDER_UNAVAILABLE', '登记资料数据库暂不可用', {
      retryable: isTransientDatabaseError(error),
    });
  }
}
