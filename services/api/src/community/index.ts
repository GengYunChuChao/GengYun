/**
 * GY-I15（#15）阶段 1 · 社区域服务层统一出口。
 *
 * 只做服务端语义（审核 gate、归属、可见性、幂等、点赞、举报、分页）；
 * **不注册路由**、不改 `services/api/src/app.ts`（阶段 2 装配），
 * 也不触碰 `packages/contracts/**` 与 `packages/moderation/**`（只读导入）。
 *
 * 诚实边界：本包不代表社区已端到端可用；模型层（LLM）审核、图片审核、资料关联
 * 可用性、数据库持久化与 HTTP 路由都在阶段 2 或别的任务里。
 */
export * from './types.ts';
export * from './authors.ts';
export * from './validate.ts';
export * from './moderation-gate.ts';
export * from './store.ts';
export * from './service.ts';
