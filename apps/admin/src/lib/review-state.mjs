/**
 * 人审入口空态的**事实常量**（B5）。
 *
 * 这些数字不是统计出来的，而是服务端实现的结构性结论：人审入口 `items` 恒为 `[]`，
 * 四个集合恒为冻结空数组，且全仓没有对应持久表。把数字与出处集中在这里，
 * 由 `tests/unit/admin-ui-review-state.test.mjs` 逐条核对引用的行号仍能对上，
 * 防止页面上的"0 与出处"在后续改动中悄悄失真。
 *
 * 页面本身**不发起任何网络请求**：契约与路由都没有人审读面。
 */

/**
 * 当前系统里实际待审核的对象数。
 *
 * 0 的含义是"结构性零"：服务端没有人审执行体，也没有任何持久表，
 * 不存在"还没加载到"的可能。不得被读成"待审已清空"或"审核通过率 100%"。
 */
export const REVIEW_COUNT = 0;

/** 紧跟数字的定性标签：让读者一眼看出 0 的来源，而不是猜。 */
export const REVIEW_COUNT_BADGE = '结构性零（wired: false）';

/** `HUMAN_REVIEW_COLLECTIONS` 的集合数（tasks／reviewers／votes／expert_certifications）。 */
export const HUMAN_REVIEW_COLLECTIONS_COUNT = 4;

/** 计数口径的三条出处（页面"数据来源"列表直接渲染）。 */
export const reviewCountSources = Object.freeze([
  {
    note: '人审入口 public humanReviewQueue() 的 items 恒为空数组：真实待审条数 = 0，且 human_review_state 恒为 under_construction。',
    file: 'services/api/src/moderation/nonbypass.ts:161-168',
  },
  {
    note: '后台人审目录 createHumanReviewDirectory() 的 tasks/reviewers/votes/expert_certifications 全为冻结空数组，wired: false。',
    file: 'services/api/src/admin/human-review.ts:68-89',
  },
  {
    note: '全仓没有审核队列读接口与审核动作接口：openapi.json 中 path 含 review 的数量为 0，routes/ 下也没有 review 路由。',
    file: 'packages/contracts/openapi.json',
  },
]);

/**
 * 可机械核对的代码锚点：`file` 的 `start..end` 行必须仍包含 `mustInclude` 里每一条。
 * 行号一漂移、断言一被改成恒真，测试就红——避免页面继续引用过时证据。
 */
export const REVIEW_CODE_ANCHORS = Object.freeze([
  {
    file: 'services/api/src/moderation/nonbypass.ts',
    start: 161,
    end: 168,
    mustInclude: ['export function humanReviewQueue', 'items: []', 'HUMAN_REVIEW_STATE'],
  },
  {
    file: 'services/api/src/admin/human-review.ts',
    start: 68,
    end: 89,
    mustInclude: ['export function createHumanReviewDirectory', 'wired: false', 'tasks: EMPTY', 'assertNoReviewClaim'],
  },
  {
    file: 'services/api/src/admin/human-review.ts',
    start: 29,
    end: 34,
    mustInclude: ['HUMAN_REVIEW_COLLECTIONS', 'tasks', 'reviewers', 'votes', 'expert_certifications'],
  },
  {
    file: 'services/api/src/moderation/types.ts',
    start: 110,
    end: 115,
    mustInclude: ["HUMAN_REVIEW_STATE = 'under_construction'"],
  },
  {
    file: 'services/api/src/routes/public-home.ts',
    start: 10,
    end: 15,
    mustInclude: ["human_review_state: 'under_construction'"],
  },
  {
    file: 'services/api/src/admin/ops/service.ts',
    // `#18` S2 PR-3 把 `OPS_OPERATION_IDS` 从 244-260 挪到 293-313（写面新增两条 operationId）。
    // 这不是产品 UI 改动：本条目只是「人审入口的 0 与出处」这一段证据锚点，
    // 锚点跟着后端行号走，否则 `tests/unit/admin-ui-review-state.test.mjs` 会红成"引用失效"。
    start: 379,
    end: 401,
    mustInclude: ['OPS_OPERATION_IDS'],
  },
]);
