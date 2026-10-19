/**
 * GY-I22（#22）· `real` 模式下后台运营面的**能力级 fail-closed 外壳**。
 * GY-I18（#18）· 追加**开关面**与**账号读面**的放行开关（两者默认关闭 ⇒ 既有行为逐字不变）。
 *
 * ## 它解决的矛盾
 * `app.ts` 在 `executionMode === 'real'` 下把**整个**后台域换成 `createFailClosedAdminServices()`
 * （监工 P1：绝不能拿内存 store 在"真实模式"下返回成功封套）。这是正确的默认。
 * 但能力是一块块接上真实持久权威的：账号停用（迁移 0017 的 `public.suspend_account()`）、
 * 开关读写（迁移 0020 的 `public.feature_flags` + `public.set_feature_flag()`）、账号读面
 * （迁移 0021 的窄口径读函数 `public.list_admin_accounts()`：运行时角色只有 EXECUTE，对
 * `users.nickname` / `created_at` 仍然没有任何列权限）。
 * 若仍被整域 503 一并挡死，主检出里就**没有一条**可验证的真实路径 —— 交付等于空转。
 *
 * ## 口径（不放松任何既有守卫）
 * - **能力决定返回码**：只有真正接上真实后端的那一个操作放行；其余后台运营操作
 *   （分类、作业、帖子下架）继续逐条 503，`retryable: false`，措辞与整域替身**同源**
 *   （同一段 `reason`）；
 * - **读面在真实目录注入时放行**（`options.accountsReadWired === true` ⇒ `listAdminUsers` 转发 inner）：
 *   放行的判据是**能力对象存在** —— `app.ts` 只有真的构造出 `createPostgresAccountsDirectory({ pool })`
 *   才传 `true`；⛔ 不读任何自述持久化布尔标志、⛔ 不因"配置里写了 `DATABASE_URL`"而放行。
 *   目录未注入时读面**仍逐条 503**：返回空页会把"本进程无权回答"说成"平台没有账号"（伪造结论）；
 * - 默认 `accountsReadWired: false` / `flagsWired: false` ⇒ 本外壳与 GY-I22 首版的返回集合
 *   **逐字不变**（只许新增用例）；
 * - `accountsWired` 固定 `false`：读面与开关是否接线由上面两个显式参数**单独表达**，本标志不代表
 *   账号面"已完整接线"（停用、读面、开关是三条独立能力，任何一条缺失都不该说成完整）；
 * - 不返回成功封套、不写内存、不占幂等位：拒绝发生在写外壳**之前**（被转发的操作只在
 *   拿到真实后端时放行，其余全部在进入 `runIdempotentWrite` 前抛出）。
 *
 * 转发对象必须**逐个显式**列出：`inner.suspendUser`（真实停用权威）、`inner.listAdminUsers`
 * （真实读目录）、`inner.listFlags` / `inner.setFlag`（真实开关读写）。
 * 新增可放行操作必须在 `app.ts` 再写一次显式放行
 * （与 `fail-closed-services.ts` 头部"接线点"要求一致），⛔ 不得改成"整对象透传"。
 *
 * ## GY-I18 的放行开关为什么默认 `false`
 * 既有调用点（`tests/unit/admin-accounts-authority-shell.test.mjs` 等）只断言"除停用外一律 503"。
 * 若默认放行开关面，`flagsPort` 未接时 `listFlags` 会走内存 store —— 正是监工 P1 禁止的
 * "real 模式下拿内存 store 返回成功封套"。因此只有 `app.ts` 在**确实**建出对应 PG 端口时才传
 * `flagsWired: true` / `accountsReadWired: true`；默认 `false` 让所有既有断言逐字成立。
 */
import { ApiError } from '../../errors.ts';
import type { AdminOpsService } from './service.ts';

/** 外壳的接线开关（全部缺省 `false`＝GY-I22 首版口径）。 */
export interface RestrictToAccountsAuthorityOptions {
  /**
   * 开关面（`listFlags`/`setFlag`）是否已接真实 PG 端口。**默认 `false`** = 继续 503。
   * 只有 `app.ts` 在 `pool !== null` 且 `executionMode === 'real'`、确实构造出
   * `createPostgresFeatureFlags({ pool })` 时才传 `true`。
   */
  readonly flagsWired?: boolean;
  /**
   * 读面 `listAdminUsers` 是否已接上真实目录。
   * 只能由 `app.ts` 在**确实构造出** `AdminAccountsDirectory` 时置 `true`。
   */
  readonly accountsReadWired?: boolean;
}

/**
 * 用**同一段** `reason` 构造拒绝：与 `createFailClosedAdminServices()` 的整域替身逐字同源，
 * 便于调用方与既有回归用同一个判据核对"这条路由到底有没有被放行"。
 */
export function restrictAdminOpsToAccountsAuthority(
  inner: AdminOpsService,
  reason: string,
  options: RestrictToAccountsAuthorityOptions = {},
): AdminOpsService {
  const reject = async (): Promise<never> => {
    // 能力未接线＝运维动作，无运维介入下重试不可能成功 ⇒ retryable 必须为 false。
    throw new ApiError('PROVIDER_UNAVAILABLE', reason, { retryable: false });
  };
  const flagsWired = options.flagsWired === true;
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
    // **放行 1**：真实单事务停用权威（迁移 0017 的 `suspend_account()`）。
    suspendUser: inner.suspendUser,
    listAdminJobs: reject,
    cancelAdminJob: reject,
    // **放行 2**（需 `flagsWired: true`）：真实开关读写（迁移 0020 的 `feature_flags`）。
    listFlags: flagsWired ? inner.listFlags : reject,
    setFlag: flagsWired ? inner.setFlag : reject,
    hidePost: reject,
  };
}
