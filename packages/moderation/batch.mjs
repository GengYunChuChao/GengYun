/**
 * GY-I14 确定性硬规则审核层 · 批量审核与失败隔离（派单 §4.3）。
 *
 * 纪律：
 *   1) 每个目标**独立**求值：一条异常不得改变其它目标的判定；
 *   2) 单条目标在引擎外抛出（例如输入对象陷阱抛错）时，该条隔离为 `quarantined`，
 *      绝不当成"通过"，也绝不影响别人；
 *   3) 批量结果按输入顺序返回，并带 `index` 便于调用方逐条对账。
 *
 * 本模块同样**没有 HTTP 消费者**：它是组件级批量入口，不是路由。
 */
import { DECISION_APPROVED, DECISION_QUARANTINED, DECISION_REJECTED, isAuditState } from './constants.mjs';
import { evaluateHardRules, makeQuarantineResult } from './engine.mjs';

function summarize(results) {
  const summary = { total: results.length, approved: 0, rejected: 0, quarantined: 0, other: 0, engine_errors: 0 };
  for (const item of results) {
    const decision = item?.decision;
    if (!isAuditState(decision)) summary.other += 1;
    else if (decision === DECISION_APPROVED) summary.approved += 1;
    else if (decision === DECISION_REJECTED) summary.rejected += 1;
    else if (decision === DECISION_QUARANTINED) summary.quarantined += 1;
    else summary.other += 1;
    if (item?.engine_error) summary.engine_errors += 1;
  }
  return summary;
}

/**
 * 批量审核。
 *
 * @param {Array<unknown>} items 每个元素都是单条审核输入
 * @param {object} [options] 透传给 evaluateHardRules
 * @returns {{ batch_size: number, results: Array<object>, summary: object }}
 */
export function evaluateBatch(items, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const inputNotArray = !Array.isArray(items);
  const results = list.map((item, index) => {
    try {
      return { index, ...evaluateHardRules(item, options) };
    } catch (error) {
      return {
        index,
        ...makeQuarantineResult(['RULE_ENGINE_ERROR'], {
          rules: options.rules,
          matchers: options.matchers,
          matcher_revisions: options.matcher_revisions,
          budget_ms: options.budget_ms,
          engine_error: typeof error?.name === 'string' ? error.name : 'Error',
        }),
      };
    }
  });
  return {
    batch_size: results.length,
    input_was_array: !inputNotArray,
    results,
    summary: summarize(results),
  };
}
