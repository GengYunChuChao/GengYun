/**
 * GY-I22 收口片 · 「审核域规则层冻结时钟」注入夹具（**不是测试文件**，本文件没有 `test()` 调用）。
 *
 * ## 为什么需要它（stall 臂暴露的第二个装配点）
 * 规则层有两个**各自独立**的装配点，时钟来源不同：
 *   1. 社区发布闸门 `createPublishGate()`：`tests/unit/community-fixtures.mjs` 的 `makeGate()`
 *      已经把 `clock: FROZEN_CLOCK` 透传下去，测试侧早已免疫机器负载；
 *   2. 审核域服务 `createModerationService()`：`services/api/src/app.ts` 的 `moderationInjection`
 *      在本基线只接受 `{ service, ports, authority, callbackKey }`（`services/api/src/app.ts:395-400`），
 *      **没有** `ruleOptions` 缝。于是被测进程里审核域的规则层吃的是 `Date.now` 墙钟 +
 *      `DEFAULT_RULE_BUDGET_MS = 50`（`packages/moderation/constants.mjs:223`）。
 *
 * 机器一卡（CI 抢占 / 覆盖插桩 / 采集器慢），`packages/moderation/engine.mjs:373` 的
 * `now - started > budgetMs` 成立 ⇒ `:375` 塞入 `RULE_TIMEOUT` ⇒ 审核域判
 * `decision=quarantined, model_layer=not_wired` ⇒ 社区一律 `422 INPUT_UNCERTAIN`
 * （`services/api/src/community/service.ts:393`），与待测行为无关。
 *
 * 本仓实测（stall 臂：每读一次钟即让时间前进 200ms）会稳定打穿 4 个文件的 17 条用例，失败断言
 * 一律落在上面这条链上——**根因是规则预算，不是断言依赖真实时钟**。
 *
 * ## 本夹具做什么
 * 显式构造一支**与 `app.ts:766-777` 默认装配逐字段等价**的审核域服务，唯一差别是规则层
 * `clock` 冻结为常量。测试把它当 `moderationInjection.service` 注入，`app.ts` 的 `??` 兜底
 * 逻辑原样接管其余全部接线（社区联动 link `:780-783`、消息域事件、读取时重查、下架）。
 *
 * 预算**不放大**：冻结后 `now - started` 恒为 0，`budget_ms` 仍是出厂 `50`，检查照跑，
 * 只是永远不会误判。超时语义（`RULE_TIMEOUT` ⇒ `quarantined` ⇒ 不发布）也一字未改，
 * 仍有专门用例守着它（`tests/moderation/fail-closed.test.mjs` 注入
 * `scriptedClock([0, 1000])` + `budget_ms: 50` 断言超时分支）。
 *
 * ## 边界（不得误读）
 * - **零产品代码改动**：`services/**`、`packages/**` 未动一行；本文件只是测试侧夹具。
 * - 模型端口仍由调用方显式传入（合成 `pass` 端口 ⇒ `provider.synthetic === true`、四个网络
 *   seam 持有即抛错），本夹具**不**替代"真实审核未接入、零真实外呼"的声明。
 * - 一旦 `app.ts` 出现 `moderationInjection.ruleOptions` 透传缝，各调用点可退化为
 *   `moderationInjection: { ...原端口, ruleOptions: FROZEN_RULE_OPTIONS }`（本文件已导出）。
 *
 * 坐标：GY-I22 收口片 · 分支 `test/gy-unit-stall-hygiene` · 基线 `d131e47`。
 */
import { createModerationService } from '../../services/api/src/moderation/service.ts';
import { createCommunityContentAuthority } from '../../services/api/src/community/moderation-authority.ts';
import { createLocalPseudonymousAuthorDirectory } from '../../services/api/src/community/authors.ts';

/** 冻结时钟：规则层每次读时间都得到 0 ⇒ `now - started === 0`，预算恒不触发。 */
export const FROZEN_RULE_CLOCK = () => 0;

/** 出厂默认规则预算（同 `packages/moderation/constants.mjs:223` 的 `DEFAULT_RULE_BUDGET_MS`）。 */
export const DEFAULT_RULE_BUDGET_MS = 50;

/** 规则层选项：冻结时钟 + 出厂预算（**不放大**预算，只冻结时钟）。 */
export const FROZEN_RULE_OPTIONS = Object.freeze({
  clock: FROZEN_RULE_CLOCK,
  budget_ms: DEFAULT_RULE_BUDGET_MS,
});

/**
 * 构造一支规则层时钟冻结的审核域服务（其余装配与 `app.ts` 默认值逐字段同形）。
 *
 * @param {object} [options]
 * @param {'stub'|'real'|'preset_demo'} [options.executionMode] 必须与被测 app 的
 *   `config.executionMode` 一致（`real` 下审核域整域 fail-closed、忽略注入端口）。
 * @param {object} [options.ports] 模型端口，通常 `{ tms: makeSyntheticPassPort('tms') }`。
 * @param {object} [options.store] 社区 store；给了就挂**同源**内容权威（与 `app.ts:759-762` /
 *   `:775` 的默认一致）。`real` 模式下 `app.ts` 刻意**不给**权威（`:773-774`），本函数同形。
 * @param {object} [options.authors] 作者投影；默认自建。该投影是确定性函数
 *   （`services/api/src/community/authors.ts:27`：`sha256(DISPLAY_DOMAIN\0userId)`），
 *   另建实例与 app 内那一支等价，故无需共用同一实例。
 * @param {object} [options.ruleOptions] 覆盖规则层选项（默认 `FROZEN_RULE_OPTIONS`）。
 * @returns 审核域服务（可直接当 `moderationInjection.service`）。
 */
export function createFrozenRuleModeration(options = {}) {
  const { executionMode = 'stub', ports, store, authors } = options;
  const authority = store !== undefined && executionMode !== 'real'
    ? createCommunityContentAuthority({
      store,
      authors: authors ?? createLocalPseudonymousAuthorDirectory(),
    })
    : undefined;
  return createModerationService({
    executionMode,
    ...(ports === undefined ? {} : { ports }),
    ...(authority === undefined ? {} : { authority }),
    ruleOptions: options.ruleOptions ?? FROZEN_RULE_OPTIONS,
  });
}

/** `moderationInjection` 形状的便捷包装：`{ service }`。 */
export function frozenModerationInjection(options = {}) {
  return { service: createFrozenRuleModeration(options) };
}
