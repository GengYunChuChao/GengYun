/**
 * GY-I27 隐私模块 · 统一出口。
 *
 * 供 services/api（后端）与后续小程序工具链共同 import；
 * 授权错误码与枚举以本模块为唯一事实来源（消费 packages/contracts/states.json）。
 */
export * from './constants.mjs';
export * from './errors.mjs';
export * from './consent.mjs';
export * from './guard.mjs';
export * from './commit-gate.mjs';
export * from './ledger.mjs';
export * from './deletion.mjs';
export * from './redact.mjs';
