/**
 * GY-I16（#16）· 历史子域统一出口。
 *
 * 只做服务端语义（归属、失败状态真实可见、可见性与任务状态读取时重查、分页、不可变出口）；
 * 契约注册在 `services/api/src/routes/history.ts`，装配在 `services/api/src/app.ts`。
 */
export * from './types.ts';
export * from './validate.ts';
export * from './store.ts';
export * from './job.ts';
export * from './cascade.ts';
export * from './service.ts';
