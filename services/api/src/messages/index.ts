/**
 * GY-I17（#17）阶段 1 · 消息域服务层统一出口。
 *
 * 只做服务端语义（归属、未读一致性、引用可用性 fail-closed、幂等/CAS、分页、不可变出口）；
 * **不注册路由**、不改 `services/api/src/app.ts`（阶段 2 装配；`app.ts` 被 #87 占用），
 * 也不触碰 `packages/contracts/**`（只读导入）与 `miniprogram/**`。
 *
 * 诚实边界：本包不代表消息系统已端到端可用；目标读取端口未接线（全部带目标的消息
 * `reference_state` 恒 `unavailable`）、数据库持久化与 HTTP 路由都在阶段 2。
 */
export * from './types.ts';
export * from './immutable.ts';
export * from './reference.ts';
export * from './store.ts';
export * from './validate.ts';
export * from './service.ts';
