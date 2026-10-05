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
 * 结构性方案（本轮选定：**受控数据介质**，对应派发稿路径 (a)）：
 *   写入口**不再是任意用户函数**。调用方只提供**纯数据容器** `{ rows: <native Map> }`，
 *   写入由**账本自身的同步代码**以 Map 内建方法完成（`Map.prototype.set.call`）。于是：
 *   - 调用方无法把任何函数放进写路径 → 不存在「被调用时启动异步任务」的可能；
 *   - 结构上只接受 native Map（禁止子类/覆写）→ 写操作必然是内建同步数据操作；
 *   - 违反即**构造期 / 调用前拒绝**——不依赖 `constructor.name` 猜测，也不做「调用后判 Promise」。
 *
 * 取舍说明（为何不选路径 (b)「事务内刷写契约」）：
 *   路径 (b) 让部署方在**同一事务**内刷写账本产出的冻结提交包。但账本无法对「部署方是否真的在同一
 *   事务内、是否后置到事务之外」作结构性判定——该职责落在部署方；且其「受控入口」若仍以函数承载，
 *   会重复本轮被否的问题。故参考组件采用 (a)：写路径内**完全没有调用方代码**，可被本模块结构性保证；
 *   实库的单事务义务作为**部署契约**在下方与 README 明确（见「实库契约」）。
 *
 * 实库契约（PostgreSQL 17，**部署义务**，模块无法对任意介质结构性强制）：
 *   实库适配器必须在**单事务**内完成「校验读取（`SELECT ... FOR UPDATE` / 行版本 CAS）+ 实际写入
 *   （`INSERT/UPDATE`）」并一起 `COMMIT`，**不得**把写入后置到事务之外。本模块的保证范围限定为：
 *   「不向临界区注入任意函数」+「内存参考实现（native Map + 内建同步写入）为已验证安全路径」。
 */

/**
 * 内存参考介质：纯数据容器，无任何可执行函数。调用方持有引用即可观察写入。
 * @returns {{ rows: Map<string, object> }}
 */
export function createMemoryWritebackMedium() {
  return { rows: new Map() };
}

/**
 * 构造/调用前校验：**只接受纯数据容器**。
 *
 * 结构性拒绝（非运行时启发式）：
 *   1. 介质必须是普通对象；
 *   2. 介质**不得包含任何函数属性**（如 `write`）——写路径内不允许存在可被调用的调用方代码；
 *   3. `rows` 必须是**原生 Map**（`instanceof Map` 且原型严格为 `Map.prototype`），
 *      以便账本以内建 `Map.prototype.set` 写入，杜绝被覆写的异步 `set`。
 *
 * @param {object} medium
 * @returns {object} 同一介质
 */
export function assertWritebackMedium(medium) {
  if (!medium || typeof medium !== 'object') {
    throw new Error('回写介质必须是纯数据对象形如 { rows: Map }（不得为函数或空值）');
  }
  for (const key of Object.keys(medium)) {
    if (typeof medium[key] === 'function') {
      throw new Error(
        `回写介质不得包含可执行函数（${key}）；只接受纯数据容器，写入由账本自身同步代码完成`,
      );
    }
  }
  const rows = medium.rows;
  if (!(rows instanceof Map) || Object.getPrototypeOf(rows) !== Map.prototype) {
    throw new Error('回写介质必须提供原生 Map 作为 rows 容器（不得为子类/覆写对象）');
  }
  return medium;
}

/**
 * 账本自身的同步写入：调用 Map 内建方法，**不执行任何调用方代码**。
 * @param {{ rows: Map<string, object> }} medium
 * @param {object} entry
 * @returns {object} 同一 entry
 */
export function writebackMediumWrite(medium, entry) {
  Map.prototype.set.call(medium.rows, entry.exportId, entry);
  return entry;
}

/**
 * 账本自身的同步读取（供审计/测试）：返回浅拷贝，调用方改写不影响介质。
 * @param {{ rows: Map<string, object> }} medium
 * @param {string} exportId
 * @returns {object|null}
 */
export function writebackMediumRead(medium, exportId) {
  if (!Map.prototype.has.call(medium.rows, exportId)) return null;
  return { ...Map.prototype.get.call(medium.rows, exportId) };
}
