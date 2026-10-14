/**
 * GY-I15（#15）社区域统一出口。
 *
 * 阶段 1：服务端语义（审核 gate、归属、可见性、幂等、点赞、举报、分页）。
 * 阶段 2：HTTP 路由（`routes/community.ts`）+ 装配（`app.ts`）+ 两个接线端口
 *   （`knowledge.ts` 杂草／药剂关联可用性、`events.ts` 审核结果/下架事件 → 消息中心公开端口）
 *   + 下架观察器（`takedown.ts`）。
 * **不修改** `packages/contracts/**`、`packages/moderation/**`（只读导入）、
 * `services/api/src/messages/**`、`services/api/src/admin/**`、`services/api/src/media/**`。
 *
 * 诚实边界：本包不代表社区已端到端可用；模型层（LLM）审核未接入 HTTP 装配、
 * 图片审核受规则层媒体口径限制（带媒体目标不可能被抬成 `approved`）、
 * 资料关联需真实数据库与会话域读取口、`real` 模式因真实持久存储未接线而整域 fail-closed。
 */
export * from './types.ts';
export * from './authors.ts';
export * from './validate.ts';
export * from './moderation-gate.ts';
export * from './knowledge.ts';
export * from './events.ts';
export * from './takedown.ts';
export * from './store.ts';
export * from './service.ts';
