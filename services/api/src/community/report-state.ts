/**
 * 举报状态机（GY-I15 · R31-S1）：`received → isolated → closed` 的**唯一合法转移表**。
 *
 * ## 为什么要有这一层
 *
 * 迁移 `0022_community_persistence.sql:134` 建的 `community_reports` 已经有 `state` 列与
 * 三值 CHECK（`received`/`isolated`/`closed`）、也已经为运营队列建了
 * `community_reports_state_created_idx (state, created_at DESC, id DESC)`；契约
 * `packages/contracts/openapi.json` 的 `Report.state` 同样是这三值 + `revision`。但**全仓没有
 * 一处写状态**：`community/store.ts:201-202` 只有 `insertReport` / `getReport`，服务层只有
 * `createReport`/`getOwnReport`，于是 `createReport` 落库的 `state: 'received'` 就是这条记录的
 * **终态**——「举报 → 受理 → 处置」的后半程（推进与幂等）整段缺失。
 *
 * 缺的就是**转移本身**：既有代码里没有任何函数知道「`received` 之后允许去哪、`closed` 之后
 * 还能不能动」。本文件把这张表单独拎出来（纯函数、不碰存储、不碰 HTTP），让「合法的下一步」
 * 成为可以被断言的对象，而不是散落在各调用点的 if。
 *
 * ## 口径映射（为什么不叫 `pending/triaged/resolved/rejected`）
 *
 * | 本片语义 | 既有契约/迁移取值 | 说明 |
 * | --- | --- | --- |
 * | pending（待受理） | `received` | `createReport` 落库即此态 |
 * | triaged（已受理并隔离） | `isolated` | 处置动作 `triage`：举报成立 ⇒ 目标内容进隔离 |
 * | resolved（处置完毕） | `closed` | 处置动作 `resolve` |
 * | rejected（驳回） | `closed` | 处置动作 `reject` |
 *
 * ⛔ 不新增/不改契约取值（`Report.state` 的三值枚举一个也不能动）：`resolved` 与 `rejected`
 * 在**状态取值上收敛为 `closed`**，二者的区分只体现为「走的哪条转移路径」。这个收敛是
 * 本片的**已知弱化**：终态之后无法从 `state` 单列反查结论是「成立」还是「驳回」——若要反查，
 * 需要新增一列（迁移 + `deploy/postgres-cvm/sql/20-login-roles.sql` 的列级授权 +
 * `90-assert-least-privilege.sql` 的列清单三处同步），本片**不做**，已在证据页登记为未取得项。
 *
 * ## 终态是单向门
 *
 * `closed` 之后**没有**任何合法动作（与帖子/评论的 `visibility: 'deleted'` 同一条纪律：
 * 已处置的举报不得被重新打开）。这同时是「处置后不可再处置」的实现方式：重复处置不会
 * 变成一条静默成功，而是 `TERMINAL_STATE` 拒绝。
 */

import type { ReportState } from './store.ts';

/** 状态取值闭集（与迁移 CHECK、契约 `Report.state` 逐值一致）。 */
export const REPORT_STATES = ['received', 'isolated', 'closed'] as const satisfies readonly ReportState[];

/** 处置动作闭集（内部动作名；**不是**契约字段，不出现在任何响应体里）。 */
export const REPORT_ACTIONS = ['triage', 'resolve', 'reject'] as const;

export type ReportAction = (typeof REPORT_ACTIONS)[number];

/** 每个动作的前置状态与目标状态。 */
const TRANSITIONS: Readonly<Record<ReportAction, { readonly from: readonly ReportState[]; readonly to: ReportState }>> =
  Object.freeze({
    /** 受理成立：举报被采纳，目标内容应进入隔离（隔离本身由审核域/下架链路执行）。 */
    triage: { from: ['received'], to: 'isolated' },
    /** 处置完毕：从待受理或已隔离推进到终态。 */
    resolve: { from: ['received', 'isolated'], to: 'closed' },
    /** 驳回：只允许从待受理直接结案（已隔离的内容不通过举报状态机解除隔离）。 */
    reject: { from: ['received'], to: 'closed' },
  });

/** 转移失败原因（内部口径；对外一律折叠为契约内 `409 REVISION_CONFLICT`，见 service `commitRefusal`）。 */
export type ReportTransitionFailure = 'TERMINAL_STATE' | 'ILLEGAL_TRANSITION' | 'UNKNOWN_ACTION';

export type ReportTransitionPlan =
  | { readonly ok: true; readonly from: ReportState; readonly action: ReportAction; readonly to: ReportState }
  | {
      readonly ok: false;
      readonly from: ReportState;
      readonly action: ReportAction;
      readonly reason: ReportTransitionFailure;
    };

/** 是否为终态（终态不接受任何处置动作）。 */
export function isTerminalReportState(state: ReportState): boolean {
  return state === 'closed';
}

/**
 * 规划一次转移：**只判定，不写库**。
 *
 * 返回 `ok:false` 的两种情况对调用方的含义相同（都不许写），区分它们只为把拒绝原因
 * 说清楚：终态是「已经处置过了」，非法转移是「这个动作不属于当前状态」。
 */
export function planReportTransition(current: ReportState, action: string): ReportTransitionPlan {
  if (!(REPORT_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, from: current, action: action as ReportAction, reason: 'UNKNOWN_ACTION' };
  }
  const known = action as ReportAction;
  const rule = TRANSITIONS[known];
  if (isTerminalReportState(current)) return { ok: false, from: current, action: known, reason: 'TERMINAL_STATE' };
  if (!rule.from.includes(current)) return { ok: false, from: current, action: known, reason: 'ILLEGAL_TRANSITION' };
  return { ok: true, from: current, action: known, to: rule.to };
}

/** 转移表自述（证据页与用例断言共用，避免用例里复制一份表）。 */
export function describeReportStateMachine(): Array<{
  action: ReportAction;
  from: readonly ReportState[];
  to: ReportState;
}> {
  return REPORT_ACTIONS.map((action) => ({ action, from: [...TRANSITIONS[action].from], to: TRANSITIONS[action].to }));
}
