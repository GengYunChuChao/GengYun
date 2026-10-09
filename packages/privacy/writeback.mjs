/**
 * GY-I27 隐私模块 · 受控回写介质（controlled writeback medium）。
 *
 * 为什么「注入一个 write 函数」不是结构性保证（修复轮 7 结论）：
 *   修复轮 6 把保存动作做成注入端口的方法 `write(entry)`，并在**构造期**检查
 *   `write.constructor.name` 是否为 `AsyncFunction`/`GeneratorFunction`。该检查不成立：普通函数
 *   `entry => pending.then(() => save(entry))` 的 constructor 是 `Function`，**通过校验**；
 *   构造期放行后，`ledger` 在同步临界区内调用它即**启动了临界面之外的保存链**，返回值被忽略、
 *   立即回 `written:true`——随后的撤回/注销 `revokeInFlight` 撤不掉已经在飞的写入。
 *   即：**把任意函数从方法参数挪到构造参数，并未使「异步副作用无法进入临界区」成为结构性事实。**
 *
 * 为什么「只校验数据容器」仍不够（修复轮 8 结论）：
 *   修复轮 7 的 `assertWritebackMedium` 通过 `medium[key]` / `medium.rows` **读取属性值**来校验，
 *   且返回**调用方原对象**；`writebackMediumWrite` 又**二次读取** `medium.rows`。于是
 *   `Object.defineProperty(medium, 'rows', { get() { …读取时撤回用途… return nativeMap; } })`
 *   可被当作合法键通过；校验读取与写入读取之间（或读取时）执行调用方代码（如 `withdraw(recording)`），
 *   写入仍发生 → `written:true` 且落库 1 条，而授权已撤回。**与「写路径内没有调用方代码」的保证相反。**
 *
 * 本轮结构性方案（路径 a 收敛为「不执行访问器 + 内部固定已验证引用」）：
 *   1. **不执行访问器**：用 `Object.getOwnPropertyDescriptor` 读取 **own property descriptor**
 *      （不触发 `get`/`set`）；任何 own 键若为 **accessor**（有 `get`/`set`）→ **构造期拒绝**；
 *      `rows` 必须是 **own data descriptor**。
 *   2. **内部固定已验证的 Map 引用**：校验阶段**一次性捕获** `rows` 的 Map 引用，返回
 *      **冻结绑定** `Object.freeze({ rows: <capturedMap> })`；`writebackMediumWrite`/`Read`
 *      **只使用该绑定引用**，**不再读取 `medium.rows`**、不读取任何调用方可变属性。
 *   3. 构造后替换：绑定已冻结且为内部持有；调用方替换自己的 `medium.rows` **不影响**账本持有的绑定
 *      （见 R8-2）——本模块**选择「不影响」**而非「拒绝」，因为捕获引用后替换本就不生效，无需额外报错。
 *   4. 另拒绝 **Proxy** 介质：Proxy 的属性访问/描述符查询会执行调用方 `getOwnPropertyDescriptor` trap
 *      （即调用方代码），与本模块「写路径不执行调用方代码」的保证冲突。
 *
 * 保证范围（精确）：**写路径不读取调用方可变属性、不执行访问器**；内存参考路径的写入是结构性同步的，
 * 调用方代码无法插入其中。**实库单事务义务为部署契约**（见下与 README）。
 *
 * 实库契约（PostgreSQL 17，**部署义务**，模块无法对任意介质结构性强制）：
 *   实库适配器必须在**单事务**内完成「校验读取（`SELECT ... FOR UPDATE` / 行版本 CAS）+ 实际写入
 *   （`INSERT/UPDATE`）」并一起 `COMMIT`，**不得**把写入后置到事务之外。本模块的保证范围限定为：
 *   「不向临界区注入任意函数」+「不执行访问器/不读取调用方可变属性」+
 *   「内存参考实现（native Map + 内建同步写入）为已验证安全路径」。
 */
import { types } from 'node:util';

/**
 * 内存参考介质：纯数据容器，无任何可执行函数。**冻结**后调用方无法替换 `rows`。
 * 调用方持有引用即可观察写入（同一 Map 引用会被校验阶段捕获）。
 * @returns {{ rows: Map<string, object> }}
 */
export function createMemoryWritebackMedium() {
  return Object.freeze({ rows: new Map() });
}

/**
 * 构造/调用前校验：**不执行访问器**，只读 own property descriptor。
 *
 * 结构性拒绝（非运行时启发式）：
 *   1. 介质必须是非 null 对象，且**不得为 Proxy**（其描述符查询会执行调用方 trap）；
 *   2. 遍历 `Reflect.ownKeys(medium)`，对每个 own 键取 `Object.getOwnPropertyDescriptor`（**不触发访问器**）：
 *      - 若为 **accessor**（有 `get`/`set`）→ 拒绝；
 *      - 若为 data descriptor 且 `value` 为**函数** → 拒绝；
 *   3. `rows` 必须是 **own data descriptor**，其 `value` 必须是**原生 Map**
 *      （`instanceof Map` 且原型严格为 `Map.prototype`）。
 *
 * 返回**冻结绑定** `{ rows: <capturedMap> }`：账本后续只使用该引用，不再触碰调用方对象。
 * @param {object} medium
 * @returns {{ rows: Map<string, object> }}
 */
export function assertWritebackMedium(medium) {
  if (medium === null || typeof medium !== 'object') {
    throw new Error('回写介质必须是纯数据对象形如 { rows: Map }（不得为函数或空值）');
  }
  if (types.isProxy(medium)) {
    throw new Error('回写介质不得为 Proxy（其属性/描述符访问会执行调用方代码）');
  }
  // 不执行访问器：Reflect.ownKeys 与 Object.getOwnPropertyDescriptor 均不触发 get/set。
  for (const key of Reflect.ownKeys(medium)) {
    const desc = Object.getOwnPropertyDescriptor(medium, key);
    if (!desc) continue;
    if (desc.get || desc.set) {
      throw new Error(
        `回写介质不得包含访问器属性（${String(key)}：get/set）；只接受 own data descriptor，写路径不得执行调用方代码`,
      );
    }
    if (typeof desc.value === 'function') {
      throw new Error(
        `回写介质不得包含可执行函数（${String(key)}）；只接受纯数据容器，写入由账本自身同步代码完成`,
      );
    }
  }
  const rowsDesc = Object.getOwnPropertyDescriptor(medium, 'rows');
  if (!rowsDesc || !('value' in rowsDesc)) {
    throw new Error('回写介质必须提供 own data descriptor 的 rows 容器（不得为访问器或继承属性）');
  }
  const rows = rowsDesc.value;
  if (!(rows instanceof Map) || Object.getPrototypeOf(rows) !== Map.prototype) {
    throw new Error('回写介质必须提供原生 Map 作为 rows 容器（不得为子类/覆写对象）');
  }
  // 内部固定已验证的 Map 引用：返回冻结绑定，写/读只用此引用，绝不回读 medium.rows。
  return Object.freeze({ rows });
}

/**
 * 账本自身的同步写入：只使用**已捕获的绑定引用**，调用 Map 内建方法，**不执行任何调用方代码**。
 * @param {{ rows: Map<string, object> }} binding 由 assertWritebackMedium 返回的冻结绑定
 * @param {object} entry
 * @returns {object} 同一 entry
 */
export function writebackMediumWrite(binding, entry) {
  Map.prototype.set.call(binding.rows, entry.exportId, entry);
  return entry;
}

/**
 * 账本自身的同步读取（供审计/测试）：只使用**已捕获的绑定引用**，返回浅拷贝。
 * @param {{ rows: Map<string, object> }} binding 由 assertWritebackMedium 返回的冻结绑定
 * @param {string} exportId
 * @returns {object|null}
 */
export function writebackMediumRead(binding, exportId) {
  if (!Map.prototype.has.call(binding.rows, exportId)) return null;
  return { ...Map.prototype.get.call(binding.rows, exportId) };
}
