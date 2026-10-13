/**
 * 不可变边界（GY-I18 阶段 1 · 返修 1，回应监工 5487925429 / 行内 4245801050）。
 *
 * 缺陷回顾：投影把 `revision.content` **原对象**交给调用方，而入库时又没冻结它，
 * 于是「拿响应改一改」就能改写已发布正文，且 revision 与审计条数都不变。
 *
 * 本模块提供两条并用、互相冗余的边界：
 *
 * 1. **入口冻结** `freezeDeep`：写入存储时对修订及其**嵌套**对象递归 `Object.freeze`。
 *    语义选择：越界改动**直接抛错**（ESM 模块天然是严格模式，对冻结属性赋值抛 `TypeError`），
 *    而不是静默丢弃——抛错是**可判定**的行为，测试可以断言它。
 *    作用：让「已发布正文不可变」成为**结构性不变量**，将来任何一处忘记拷贝也会立刻暴露。
 *
 * 2. **出口深拷贝** `cloneDeep`：所有读/写响应、公开视图与历史/版本视图一律返回
 *    **深**拷贝（`structuredClone`）。浅拷贝不算修好——本次缺陷就在 `content.body`
 *    这样的嵌套层。作用：调用方拿到的是自有的普通可变数据，与存储**零共享引用**。
 *
 * 只用其中一条都不够稳：只冻结则调用方会拿到冻结对象（某些序列化/组装路径会不适），
 * 只拷贝则依赖“每处都记得拷贝”。两条并用后，任何一条被破坏，另一条仍然守住存储。
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

/** 深拷贝（不是浅拷贝）。用于把存储侧对象变成调用方自有的普通数据。 */
export function cloneDeep<T>(value: T): T {
  return structuredClone(value);
}

/**
 * 存储边界入口：深拷贝 + 深冻结。
 * 库内内容从此不与任何外部对象共享引用，也不可能被外部改写。
 */
export function takeOwnershipDeep<T>(value: T): T {
  return freezeDeep(cloneDeep(value));
}
