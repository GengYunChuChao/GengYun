/**
 * GY-I14 确定性硬规则审核层 · 统一出口。
 *
 * 供后续 API 接线增量（services/api）与模型层增量共同 import；
 * 契约闭集（AuditState / TargetRef / reason_codes 上限）以 packages/contracts 为唯一事实来源，
 * 本模块只是只读消费者。
 *
 * 边界声明（必须与 PR 正文一致）：
 *   本包是**第一片**——只交付可独立测试的**确定性规则层组件**。
 *   - 本 PR **不新增路由**、不改 `services/api/**`，因此本组件**暂无 HTTP 消费者**；
 *   - `model_version` / `prompt_version` 属模型层，本片**不产出**、不填占位串；
 *   - 图片／多媒体审核属模型层，规则层遇到带媒体的目标一律不得判为通过。
 *   不得把本包读成"AI 筛查已完成"。
 */
export * from './constants.mjs';
export * from './errors.mjs';
export * from './matchers.mjs';
export * from './rules.mjs';
export * from './rule-version.mjs';
export * from './validate-input.mjs';
export * from './engine.mjs';
export * from './batch.mjs';
export * from './review.mjs';
