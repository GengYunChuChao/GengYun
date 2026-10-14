/**
 * GY-I18 · **人工评审入口：空态**（`Refs #18`）。
 *
 * ## 为什么要有这个模块
 * 派单第 5 条要求：「**不把基础账号管理说成人工评审已完成**；人审入口保持**空态**
 * （无假任务／审核人／投票／专家认证）」。
 *
 * 现实约束：本片（乃至当前仓库）**没有**人工评审的执行体 —— 没有评审任务队列、
 * 没有评审人目录、没有投票、没有专家认证，也没有任何持久表。
 * 因此本模块**不是**一个"评审功能"，而是一个**如实声明的空态**：
 * 它把"现在是空的"变成**可机读、可断言**的事实，防止将来有人用
 * `reviewer: 'system'`、`expert_certified: true`、`votes: [...]` 之类字段
 * 把"机器门槛"或"账号管理动作"包装成"已通过人工评审"。
 *
 * ## 三条纪律（由测试钉住）
 * 1. **四个集合恒为空**：`tasks` / `reviewers` / `votes` / `expert_certifications`。
 * 2. **`wired === false`**：未接线，不得对外声明"人工评审可用"。
 * 3. **不存在"声称评审完成"的写入口**：`assertNoReviewClaim()` 是唯一入口且**一律拒绝**，
 *    因此任何试图登记"某内容已通过人工评审"的代码路径都会显式失败，而不是静默成功。
 *
 * 与 `community/moderation-gate.ts` 的关系：那个是**确定性规则层 + 模型层**的自动审核闸门，
 * 与"人工评审"是两回事。本模块刻意不引用它，避免把自动结论读成人工结论。
 * 发布审计里的 `reason_code` 也只写自动门槛的结果（`publish_gate_passed` 等），**不写**
 * `human_review*` 之类的字样。
 */
import { ApiError } from '../errors.ts';

/** 人工评审的四个集合名（**闭集**：新增集合必须同时改这里与测试，防悄悄加一个"看起来有内容"的表）。 */
export const HUMAN_REVIEW_COLLECTIONS = Object.freeze([
  'tasks',
  'reviewers',
  'votes',
  'expert_certifications',
] as const);

export type HumanReviewCollection = (typeof HUMAN_REVIEW_COLLECTIONS)[number];

/** 空态快照（可机读；所有集合都是**冻结空数组**，没有任何伪造条目）。 */
export interface HumanReviewState {
  readonly wired: false;
  readonly tasks: readonly never[];
  readonly reviewers: readonly never[];
  readonly votes: readonly never[];
  readonly expert_certifications: readonly never[];
  /** 为什么是空的（写进证据页与后台说明，避免被读成"还没加载"）。 */
  readonly reason: string;
}

export interface HumanReviewDirectory {
  /** `false` = 本进程没有人工评审执行体。**不得**被读成"评审通过率 100%"之类结论。 */
  readonly wired: false;
  readonly collections: readonly HumanReviewCollection[];
  state(): HumanReviewState;
  /**
   * 唯一的"登记评审结论"入口：**一律拒绝**。
   * 存在它的意义是让"想伪造人审完成"的调用方拿到一个显式失败，
   * 而不是找到某个被遗忘的可写集合。
   */
  assertNoReviewClaim(surface: string): never;
}

const EMPTY: readonly never[] = Object.freeze([]);

const REASON =
  '本片未接入人工评审：无评审任务、无评审人目录、无投票、无专家认证，也没有任何持久表；' +
  '自动发布门槛（确定性契约复检/规则层）不等于人工评审完成。';

export function createHumanReviewDirectory(): HumanReviewDirectory {
  return Object.freeze({
    wired: false,
    collections: HUMAN_REVIEW_COLLECTIONS,
    state(): HumanReviewState {
      // 每次返回**新建**的冻结快照：调用方连"改一改就多出一个评审人"都做不到。
      return Object.freeze({
        wired: false as const,
        tasks: EMPTY,
        reviewers: EMPTY,
        votes: EMPTY,
        expert_certifications: EMPTY,
        reason: REASON,
      });
    },
    assertNoReviewClaim(surface: string): never {
      throw new ApiError('OBJECT_UNAVAILABLE', `本片未接入人工评审，不得声称「${surface}」已通过人工评审`, {
        details: [{ field: 'human_review', code: 'NOT_WIRED' }],
      });
    },
  });
}
