/**
 * GY-I22（#22）· `real` 模式下后台运营面的**能力级 fail-closed 外壳**。
 *
 * ## 它解决的矛盾
 * `app.ts` 在 `executionMode === 'real'` 下把**整个**后台域换成 `createFailClosedAdminServices()`
 * （监工 P1：绝不能拿内存 store 在"真实模式"下返回成功封套）。这是正确的默认。
 * 但账号停用（`suspendUser`）在本片已经接上**真实持久权威**：迁移 0017 的
 * `public.suspend_account()` 在单个事务里改 `users.state` + 递增 `auth_epoch` + 撤会话 + 写审计。
 * 若仍被整域 503 一并挡死，主检出里就**没有一条**可验证的真实停用路径 —— 交付等于空转。
 *
 * ## 口径（不放松任何既有守卫）
 * - **能力决定返回码**：只有真正接上真实写权威的那个操作放行；其余后台运营操作
 *   （分类、作业、开关、帖子下架、以及**账号读面** `listAdminUsers`）继续逐条 503，
 *   `retryable: false`，措辞与整域替身**同源**（同一段 `reason`）；
 * - 读面 `listAdminUsers` **刻意不保留**：账号读面仍按内存种子判定（`accountsWired`），
 *   real 下没有真实读后端 ⇒ 返回空页会把"本进程无权回答"说成"平台没有账号"（伪造结论）；
 * - `accountsWired` 固定 `false`：本外壳不代表账号面"已完整接线"；
 * - 不返回成功封套、不写内存、不占幂等位：拒绝发生在写外壳**之前**（`suspendUser` 也只在
 *   拿到真实权威时被转发，其余全部在进入 `runIdempotentWrite` 前抛出）。
 *
 * 转发对象只有一个：`inner.suspendUser`。新增可放行操作必须在 `app.ts` 再写一次显式放行
 * （与 `fail-closed-services.ts` 头部"接线点"要求一致），⛔ 不得改成"整对象透传"。
 */
import { ApiError } from '../../errors.ts';
import type { AdminOpsService } from './service.ts';

/**
 * 用**同一段** `reason` 构造拒绝：与 `createFailClosedAdminServices()` 的整域替身逐字同源，
 * 便于调用方与既有回归用同一个判据核对"这条路由到底有没有被放行"。
 */
export function restrictAdminOpsToAccountsAuthority(
  inner: AdminOpsService,
  reason: string,
): AdminOpsService {
  const reject = async (): Promise<never> => {
    // 能力未接线＝运维动作，无运维介入下重试不可能成功 ⇒ retryable 必须为 false。
    throw new ApiError('PROVIDER_UNAVAILABLE', reason, { retryable: false });
  };

  return {
    // 如实暴露底层 store/jobPort，使"接线状态"仍可被测试与回归直接核对。
    store: inner.store,
    jobPort: inner.jobPort,
    accountsWired: false,
    operationIds: inner.operationIds,

    listAdminCategories: reject,
    editCategory: reject,
    listAdminUsers: reject,
    // **唯一放行**：真实单事务停用权威（迁移 0017 的 `suspend_account()`）。
    suspendUser: inner.suspendUser,
    listAdminJobs: reject,
    cancelAdminJob: reject,
    listFlags: reject,
    setFlag: reject,
    hidePost: reject,
  };
}
