/**
 * GY-I22（#22）· `real` 模式下后台运营面的**能力级 fail-closed 外壳**。
 *
 * ## 它解决的矛盾
 * `app.ts` 在 `executionMode === 'real'` 下把**整个**后台域换成 `createFailClosedAdminServices()`
 * （监工 P1：绝不能拿内存 store 在"真实模式"下返回成功封套）。这是正确的默认。
 * 但账号面在本仓已经接上**真实持久权威**：迁移 0017 的 `public.suspend_account()` 在单个事务里改
 * `users.state` + 递增 `auth_epoch` + 撤会话 + 写审计；GY-I18/T-R12-03 又给读面注入了
 * 真实目录 `createPostgresAccountsDirectory()`（读迁移 0021 的窄口径函数
 * `public.list_admin_accounts()`：运行时角色只有 EXECUTE，对 `users.nickname` / `created_at`
 * 仍然没有任何列权限）。
 * 若仍被整域 503 一并挡死，主检出里就**没有一条**可验证的真实账号路径 —— 交付等于空转。
 *
 * ## 口径（不放松任何既有守卫）
 * - **能力决定返回码**：只有真正接上真实后端的能力放行；其余后台运营操作
 *   （分类、作业、开关、帖子下架）继续逐条 503，`retryable: false`，
 *   措辞与整域替身**同源**（同一段 `reason`）；
 * - **读面在真实目录注入时放行**（`options.accountsReadWired === true` ⇒ `listAdminUsers` 转发 inner）：
 *   放行的判据是**能力对象存在** —— `app.ts` 只有真的构造出 `createPostgresAccountsDirectory({ pool })`
 *   才传 `true`；⛔ 不读任何自述持久化布尔标志、⛔ 不因"配置里写了 `DATABASE_URL`"而放行。
 *   目录未注入时读面**仍逐条 503**：返回空页会把"本进程无权回答"说成"平台没有账号"（伪造结论）；
 * - 默认 `accountsReadWired: false` ⇒ 本外壳与 GY-I22 首版的返回集合**逐字不变**（只许新增用例）；
 * - `accountsWired` 固定 `false`：读面是否接线由上面那个显式参数**单独表达**，本标志不代表账号面
 *   "已完整接线"（停用与读面是两条独立能力，任何一条缺失都不该说成完整）；
 * - 不返回成功封套、不写内存、不占幂等位：拒绝发生在写外壳**之前**（`suspendUser` / `listAdminUsers`
 *   也只在拿到真实能力时被转发，其余全部在进入 `runIdempotentWrite` 前抛出）。
 *
 * 转发对象只有两个：`inner.suspendUser`（真实停用权威）与 `inner.listAdminUsers`（真实读目录）。
 * 新增可放行操作必须在 `app.ts` 再写一次显式放行（与 `fail-closed-services.ts` 头部"接线点"要求一致），
 * ⛔ 不得改成"整对象透传"。
 */
import { ApiError } from '../../errors.ts';
import type { AdminOpsService } from './service.ts';

/** 外壳的接线开关（全部缺省 `false`＝GY-I22 首版口径）。 */
export interface RestrictAdminOpsOptions {
  /**
   * 读面 `listAdminUsers` 是否已接上真实目录。
   * 只能由 `app.ts` 在**确实构造出** `AdminAccountsDirectory` 时置 `true`。
   */
  accountsReadWired?: boolean;
}

/**
 * 用**同一段** `reason` 构造拒绝：与 `createFailClosedAdminServices()` 的整域替身逐字同源，
 * 便于调用方与既有回归用同一个判据核对"这条路由到底有没有被放行"。
 */
export function restrictAdminOpsToAccountsAuthority(
  inner: AdminOpsService,
  reason: string,
  options: RestrictAdminOpsOptions = {},
): AdminOpsService {
  const reject = async (): Promise<never> => {
    // 能力未接线＝运维动作，无运维介入下重试不可能成功 ⇒ retryable 必须为 false。
    throw new ApiError('PROVIDER_UNAVAILABLE', reason, { retryable: false });
  };

  // 判据是能力对象存在（由调用方在构造出真实目录后显式置位），不是自述标志。
  const accountsReadWired = options.accountsReadWired === true;

  return {
    // 如实暴露底层 store/jobPort，使"接线状态"仍可被测试与回归直接核对。
    store: inner.store,
    jobPort: inner.jobPort,
    accountsWired: false,
    operationIds: inner.operationIds,

    listAdminCategories: reject,
    editCategory: reject,
    // 真实读目录注入时放行（默认仍是 reject，与首版逐字相同）。
    listAdminUsers: accountsReadWired ? inner.listAdminUsers : reject,
    // 真实单事务停用权威（迁移 0017 的 `suspend_account()`）。
    suspendUser: inner.suspendUser,
    listAdminJobs: reject,
    cancelAdminJob: reject,
    listFlags: reject,
    setFlag: reject,
    hidePost: reject,
  };
}
