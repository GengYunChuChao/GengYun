/**
 * GY-I27 隐私模块 · 受控原子回写端口（writeback port）。
 *
 * 为什么需要它（修复轮 6 结论）：
 *   上一轮把「保存动作」作为**任意回调** `write` 传进提交临界区，并在**调用之后**判断其返回值是否为
 *   Promise。普通函数 `() => pending.then(() => save())` 不是 `async` 声明、能通过构造名检查，
 *   但**调用即已启动异步保存链**——随后的 `INVALID_REQUEST` 无法取消它，释放 `pending` 后仍会落库。
 *   「先调用、再判错」在原理上救不回已启动的异步任务。
 *
 * 结构性修复：**不再接受任意回调**。保存动作改为**受控同步写端口**——
 *   - 端口在 `ledger` **构造时**注入并被校验为同步（`assertSyncWritebackPort`）；缺方法或声明为
 *     `async` / `generator` 即**构造即抛错**（禁止静默降级）。
 *   - `guardWriteback` 只做「把**数据**（`result`）交给端口写入」，在**同步临界区内**执行：
 *     `write(entry)`。守卫拒绝 ⇒ 根本不调用端口 ⇒ **保存根本不会发生/生效**，
 *     不存在「启动了再报错」的窗口。
 *   - 异步/数据库部署由端口自身在**同一事务**内完成写入（端口即部署方的原子存储边界），
 *     不得把写入后置到事务之外。
 *
 * 端口契约：
 *   `{ write(entry): void, get?(exportId): object|null }`
 *   `entry = { exportId, userId, revision, result, committedAt }`（已冻结）。
 *   `write` **必须同步完成**；其返回值被忽略（端口是受控部署代码，不参与「事后判错」）。
 */

/**
 * 内存参考实现：纯同步写入，供单元测试与契约验证。
 * @returns {{ write: (entry: object) => object, get: (exportId: string) => object|null }}
 */
export function createMemoryWritebackStore() {
  /** @type {Map<string, object>} */
  const rows = new Map();
  return {
    write(entry) {
      rows.set(entry.exportId, entry);
      return entry;
    },
    get(exportId) {
      return rows.has(exportId) ? { ...rows.get(exportId) } : null;
    },
  };
}

/**
 * 构造期校验：端口必须提供**同步** `write(entry)`；缺方法或声明为 async / generator 即抛错。
 * @param {object} port
 * @returns {object} 同一端口（便于链式）
 */
export function assertSyncWritebackPort(port) {
  if (!port || typeof port.write !== 'function') {
    throw new Error('writeback 端口必须提供 write(entry) 方法');
  }
  const ctor = port.write.constructor;
  const name = ctor && ctor.name;
  if (name === 'AsyncFunction' || name === 'GeneratorFunction' || name === 'AsyncGeneratorFunction') {
    throw new Error('writeback 端口的 write 必须同步完成（不得为 async / generator）');
  }
  return port;
}
