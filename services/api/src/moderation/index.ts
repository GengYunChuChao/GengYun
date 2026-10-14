/**
 * GY-I14（#14）审核 HTTP 装配片 · 统一出口。
 *
 * 本包（`services/api/src/moderation/**`）把**已合并**的 `packages/moderation`（规则层 + 模型层）
 * 装配成服务端审核域，并把结论接到**已有**契约读面 `GET /jobs/{id}`（`kind=moderation`）。
 *
 * 边界（必须与 PR 正文一致，**不得**读成"真实 AI 筛查已上线"）：
 *   - 真实 `tms`/`ims` 供应商**未授权付费**：`real` 模式整域 fail-closed
 *     （契约 503 `PROVIDER_UNAVAILABLE` + `retryable`），**不**用内存/替身返回成功封套；
 *   - `stub`/`preset_demo` 使用**明确标注的替身**：替身一律回报"无结论"⇒ 隔离，
 *     **不会放行任何内容**；替身回归**不是**模型准确率/召回率证据
 *     （`docs/evaluation/sample-gap-register.md`：真实样本各为 0）；
 *   - 供应商回调是**服务端受信 seam**（不在 OpenAPI 内，见 ADR-001 §62），
 *     本片**不新增**任何契约 path/字段；传输层是否挂 HTTP 端点由指挥决定；
 *   - 人审入口是**空态**（`HUMAN_REVIEW_STATE = 'under_construction'`）：没有人工审核队列、
 *     没有审核人、没有专家认证；公众票决**不进入首版**；
 *   - 持久化是**内存**台账（PG 迁移不属本片）；跨线接线（社区发布/编辑链调用本域）由指挥处理。
 */
export * from './types.ts';
export * from './nonbypass.ts';
export * from './provider.ts';
export * from './decisions.ts';
export * from './visibility.ts';
export * from './callback.ts';
export * from './service.ts';
export * from './job-source.ts';
