/**
 * GY-I07 科普／除草剂查询与来源版本展示 · 统一出口。
 *
 * 供 services/api（后端路由）与小程序页面（本地演示数据）共同 import；
 * 枚举、错误码与展示标签以本模块为唯一事实来源（只读消费 packages/contracts）。
 *
 * 边界：本模块是**查询展示层**，不实现 HTTP、不接数据库、不生成用量建议。
 */

export * from './constants.mjs';
export * from './errors.mjs';
export * from './catalog.mjs';
export * from './records.mjs';
export * from './seed.mjs';
export * from './zhejiang.mjs';
export * from './query.mjs';
export * from './source-version.mjs';
export * from './labels.mjs';
export * from './service.mjs';
