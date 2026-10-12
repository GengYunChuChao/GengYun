/**
 * GY-I17（#17）阶段 1 · 消息域不可变边界。
 *
 * 与 `services/api/src/admin/immutable.ts`（#18，**只读参考、未修改**）同一条思路的
 * 本地实现：特征域之间不互相 import（仓库既有分层），但**边界语义必须一致**：
 *
 * 1. **入口冻结** `freezeDeep`：写入存储时对记录及其**嵌套**对象（`target_ref`）递归
 *    `Object.freeze`。ESM 模块天然严格模式 ⇒ 越界赋值抛 `TypeError`，是**可判定**的行为；
 *    于是「消息内容不可变」成为结构性不变量，任何一处漏拷贝都会立刻暴露。
 * 2. **出口深拷贝** `cloneDeep`（`structuredClone`，不是浅拷贝）：所有读写响应返回
 *    调用方**自有**的普通可变数据，与存储**零共享引用**。本次特别针对
 *    `message.target_ref.id` 这种嵌套层：浅拷贝不算修好。
 *
 * 只用一条都不够稳：只冻结会让调用方拿到冻结对象；只拷贝则依赖「每处都记得拷贝」。
 */

/** 递归冻结对象图（数组与嵌套对象一起冻）；返回同一引用。 */
export function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      freezeDeep((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** 深拷贝（不是浅拷贝）：把存储侧对象变成调用方自有的普通数据。 */
export function cloneDeep<T>(value: T): T {
  return structuredClone(value);
}

/** 存储边界入口：深拷贝 + 深冻结。库内记录从此不与任何外部对象共享引用。 */
export function takeOwnershipDeep<T>(value: T): T {
  return freezeDeep(cloneDeep(value));
}
