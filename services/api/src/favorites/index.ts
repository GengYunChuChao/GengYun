/**
 * GY-I16（#16）· 收藏子域统一出口。
 *
 * 只做服务端语义（归属、去重、取消 CAS、可见性 fail-closed、分页、不可变出口）；
 * 契约注册在 `services/api/src/routes/favorites.ts`，装配在 `services/api/src/app.ts`。
 */
export * from './types.ts';
export * from './validate.ts';
export * from './store.ts';
export * from './service.ts';
