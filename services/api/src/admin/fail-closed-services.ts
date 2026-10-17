/**
 * `real` 模式且**未接真实持久存储**时，后台域的**整体 fail-closed** 替身。
 *
 * ## 为什么需要它
 * 后台服务默认建**内存** store（`AdminContentStore.persistent === false`）。若在
 * `executionMode === 'real'` 下仍把内存 store 交给服务层，写操作会返回**成功封套**，
 * 而落点只是**易失内存** —— 即在"真实模式"下对外声称成功、实则重启即丢。
 * 这**不能靠 `contract-status=partial` 之类文档披露替代**，必须在**运行时**拒绝。
 *
 * ## 沿用本仓既有口径
 * 本仓对"real 模式下没有真实后端"的一贯做法是：**real 永远走 fail-closed 实现**，
 * 严禁静默回退替身 —— 见 `speech/provider.ts` 的 `createSpeechProvider`（`real` ⇒
 * `createRealSpeechProvider`，缺凭据即 `available=false` ⇒ 受理直接 503
 * `PROVIDER_UNAVAILABLE`）；以及 `auth` 侧"real 模式必须持久化存储，否则拒绝签发会话"。
 * 本模块是后台域的同一形态：**34 条路由保持注册**（契约面不缩水、静态清单工具不受影响），
 * 但每个操作一律以 `PROVIDER_UNAVAILABLE`(503, retryable) 拒绝，**不落任何内存写**。
 *
 * ## 接线点（将来怎么解除 fail-closed）
 * 判定条件是 **`executionMode === 'real'` 本身**，**刻意不依赖 store 自称持久化**：
 * 一旦后台域接上真实持久 store，必须在 `app.ts` **显式放行**（一次可审查的接线变更），
 * 而不是靠替身自我声明就自动启用 —— 否则"把替身记为真实成功"仍可能发生。
 * 测试 `tests/unit/admin-real-mode-fail-closed.test.mjs` 钉住当前行为。
 */
import { ApiError } from '../errors.ts';
import { FAMILIES } from './families.ts';
import { createAdminContentStore, type AdminContentStore } from './store.ts';
import type { AdminContentService } from './service.ts';
import { OPS_OPERATION_IDS, type AdminOpsService } from './ops/service.ts';
import { createAdminOpsStore, type AdminOpsStore } from './ops/store.ts';
import { createUnwiredAdminJobPort } from './ops/jobs.ts';

/** 阶段 1 的 25 个 operationId（四类资料 × 6 + `listAuditEvents`），由家族描述符派生。 */
export const ADMIN_CONTENT_OPERATION_IDS: readonly string[] = Object.freeze([
  ...FAMILIES.flatMap((descriptor) => Object.values(descriptor.operations)),
  'listAuditEvents',
]);

export interface FailClosedAdminServices {
  readonly content: AdminContentService;
  readonly ops: AdminOpsService;
}

/**
 * 生成"一律 503"的后台服务对。
 *
 * 抛 `ApiError('PROVIDER_UNAVAILABLE', …, { retryable: false })`：`app.ts` 的 errorHandler
 * 会按契约把它映射为 **503 + `ErrorEnvelope`**（与既有 `PROVIDER_UNAVAILABLE` 同形），
 * 因此调用方拿不到任何成功封套，也不会有内存副作用（不写审计、不定型幂等）。
 */
export function createFailClosedAdminServices(reason: string): FailClosedAdminServices {
  const reject = async (): Promise<never> => {
    // 后台域整体 fail-closed 替身＝能力未接线（解除要装配层显式放行）：retryable 必须为 false。
    throw new ApiError('PROVIDER_UNAVAILABLE', reason, { retryable: false });
  };

  // 方法名 = 契约 operationId（与真实服务同形），逐条显式列出而非用 Proxy：
  // 让这份替身可被静态阅读、也可被 `registerAdminRoutes` 的装配期自检逐条命中。
  const contentMethods = Object.fromEntries(ADMIN_CONTENT_OPERATION_IDS.map((id) => [id, reject]));
  const opsMethods = Object.fromEntries(OPS_OPERATION_IDS.map((id) => [id, reject]));

  const contentStore: AdminContentStore = createAdminContentStore();
  const opsStore: AdminOpsStore = createAdminOpsStore();

  // 如实暴露 store/operationIds/jobPort，使接线状态可被测试与回归直接核对
  // （对象形状仍严格满足服务接口；`as` 只用于把"全部方法都是同一个拒绝函数"表达出来）。
  const content = Object.assign(contentMethods, {
    store: contentStore,
    operationIds: ADMIN_CONTENT_OPERATION_IDS,
  }) as unknown as AdminContentService;

  const ops = Object.assign(opsMethods, {
    store: opsStore,
    operationIds: OPS_OPERATION_IDS,
    jobPort: createUnwiredAdminJobPort(),
  }) as unknown as AdminOpsService;

  return { content, ops };
}
