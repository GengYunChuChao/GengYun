/**
 * GY-I14 审核组件 · 统一出口。
 *
 * 供后续 API 接线增量（services/api）共同 import；
 * 契约闭集（AuditState / TargetRef / reason_codes 上限）以 packages/contracts 为唯一事实来源，
 * 本模块只是只读消费者。
 *
 * 边界声明（必须与 PR 正文一致）：
 *   本包目前包含**两片**：
 *   - **第一片（规则层）**：`constants/matchers/rules/rule-version/validate-input/engine/batch/review`，
 *     确定性硬规则判定；已由 PR #88 合并进 main（d5562923）。
 *   - **第二片（模型层，本片）**：`prompts/prompt-version/model-reason-codes/model-verdict/
 *     model-ports/model-review/merge`，可注入且**默认关闭**的模型审核端口 + 合流层 +
 *     prompt 版本派生 + 版本绑定重审 + 失败隔离。
 *   两片共同点：
 *   - 本包**不新增路由**、不改 `services/api/**`，因此**暂无 HTTP 消费者**（合流层同样没有调用点）；
 *   - 真实 `tms`/`ims` 网络能力**只能**来自注入式端口，本包**不内置任何端口实现**，
 *     应用装配路径在本阶段**永不提供** ⇒ 缺端口一律 fail-closed；
 *   - 图片／多媒体的判定由模型层端口承担，但规则层对带媒体目标一律不判通过，
 *     因此**带媒体的目标在本片不可能被抬成 `approved`**（见 merge.mjs 的边界声明）。
 *   不得把本包读成"AI 筛查已完成"或"发布链已通"。
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
export * from './prompts.mjs';
export * from './prompt-version.mjs';
export * from './model-reason-codes.mjs';
export * from './model-verdict.mjs';
export * from './model-ports.mjs';
export * from './model-review.mjs';
export * from './merge.mjs';
