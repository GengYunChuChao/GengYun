/**
 * GY-I16（#16）· 收藏／历史两个子域共用的**不可变边界**。
 *
 * 与 `services/api/src/messages/immutable.ts`（#17）同一思路的本地实现：特征域之间不互相 import，
 * 但边界语义必须一致。本片把这份边界收在**本片内部共享**的一处，避免收藏与历史各写一份。
 *
 * 1. **入口冻结** `freezeDeep`：写入存储时对记录及其**嵌套**对象（`target_ref`）递归
 *    `Object.freeze`。ESM 天然严格模式 ⇒ 越界赋值抛 `TypeError`，是**可判定**的行为。
 * 2. **出口深拷贝** `cloneDeep`（`structuredClone`，不是浅拷贝）：所有读写响应返回调用方
 *    **自有**的普通可变数据，与存储**零共享引用**。
 */
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
