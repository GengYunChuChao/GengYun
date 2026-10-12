/**
 * 写路径的幂等外壳（GY-I18 阶段 1 抽出，阶段 1b 复用）。
 *
 * 语义（与阶段 1 逐条一致）：
 * - **先原子占位**（`claimIdempotent`），再执行 `produce`，成功后定型结果（`completeIdempotent`），
 *   失败释放占位（`releaseIdempotent`）；
 * - 同键同体并发 ⇒ 只有占位者执行 produce（**恰好 1 次生效 + 恰好 1 条审计**），
 *   后到者命中已定型结果并**按记录原样重放**（结果引用不含任何凭据）；
 * - 同键异体 ⇒ `IDEMPOTENCY_CONFLICT`(409)；未定型的占位 ⇒ `REQUEST_IN_PROGRESS`(409，可重试)；
 * - `produce` 是**同步**函数：中间没有 `await` ⇒ 不存在部分生效。
 *
 * 抽出动机：阶段 1b 的 5 个写操作必须复用**同一套**占位/重放语义，不另写一份。
 */
import { ApiError } from '../errors.ts';
import { idempotencyKeyHashHex, idempotencyRequestHash, idempotencyScope } from '../auth/idempotency.ts';
import { cloneDeep, freezeDeep } from './immutable.ts';
import { requireIdempotencyKeyValue } from './identity.ts';
import type { ResolvedContext } from './identity.ts';
import type { AdminRuntime } from './runtime.ts';
import type { ContentIdempotencyOutcome, ServiceResponse } from './types.ts';

export interface IdempotentWriteDeps {
  /** 只需要 runtime 的台账与临界区能力（`AdminContentStore` 结构上满足）。 */
  runtime: AdminRuntime;
  signingKey: string;
  ttlSeconds: number;
  now: () => Date;
}

/** 幂等键域：主体 + 方法 + **具体**路径（含真实 id，避免不同目标互相串键）。 */
export interface IdempotentKeyDomain {
  method: string;
  path: string;
  expectedStatus: number;
}

export async function runIdempotentWrite<TBody>(
  deps: IdempotentWriteDeps,
  context: ResolvedContext,
  keyDomain: IdempotentKeyDomain,
  requestBody: unknown,
  produce: () => ServiceResponse<TBody> | Promise<ServiceResponse<TBody>>,
): Promise<ServiceResponse<TBody>> {
  const rawKey = requireIdempotencyKeyValue(context.idempotencyKey);

  const scope = idempotencyScope(context.identity.userId, keyDomain.method, keyDomain.path);
  const keyHash = idempotencyKeyHashHex(scope, rawKey);
  const requestHash = idempotencyRequestHash(requestBody, context.ifMatch, deps.signingKey);
  const issuedAt = deps.now();
  const expiresAt = new Date(issuedAt.getTime() + deps.ttlSeconds * 1000);

  // `produce` 可以是同步或异步：
  // - 阶段 1 与阶段 1b 的本地内存写路径都是**同步**的 ⇒ 提交期间没有任何 await 让步点；
  // - 需要走外部端口（`AdminJobPort`）的 `cancelAdminJob` 是异步的 ⇒ 临界区会**跨 await 持有**。
  //   这仍然保证「占位 → 生效 → 定型」之间不被其它写路径插入（临界区是严格队列），
  //   代价是端口 I/O 期间独占队列（head-of-line）。阶段 2 接真实 PG/HTTP 时应改为
  //   按目标分片的短临界区；本片如实记录该限制。
  return deps.runtime.transaction(async () => {
    const settled = deps.runtime.findIdempotent(scope, keyHash);
    if (settled !== null) {
      if (settled.requestHash !== requestHash) {
        throw new ApiError('IDEMPOTENCY_CONFLICT', '同一幂等键已用于不同请求体');
      }
      return {
        status: settled.outcome.status,
        headers: cloneDeep(settled.outcome.headers),
        body: cloneDeep(settled.outcome.body) as TBody,
      };
    }
    if (!deps.runtime.claimIdempotent(scope, keyHash, { requestHash, responseStatus: keyDomain.expectedStatus, expiresAt, now: issuedAt })) {
      const row = deps.runtime.peekIdempotent(scope, keyHash);
      if (row !== null && row.requestHash === requestHash) {
        throw new ApiError('REQUEST_IN_PROGRESS', '同一幂等键的请求正在处理中', { retryable: true });
      }
      throw new ApiError('IDEMPOTENCY_CONFLICT', '同一幂等键已用于不同请求体');
    }
    try {
      const response = await produce();
      const outcome: ContentIdempotencyOutcome = {
        kind: 'admin_content',
        status: response.status,
        headers: { ...response.headers },
        body: cloneDeep(response.body),
      };
      freezeDeep(outcome);
      deps.runtime.completeIdempotent(scope, keyHash, outcome, expiresAt);
      return response;
    } catch (error) {
      // 失败必须释放占位，否则同键重试会被自己的占位挡住。
      deps.runtime.releaseIdempotent(scope, keyHash);
      throw error;
    }
  });
}
