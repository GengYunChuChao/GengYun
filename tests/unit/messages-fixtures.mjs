/**
 * GY-I17（#17）阶段 1 · 消息域测试夹具。
 *
 * 声明（必须如实，不得被引用为端到端证据）：
 *   这里的消息、目标引用与端口实现都是**合成输入**，用于验证确定性服务语义
 *   （归属、未读一致性、引用 fail-closed、幂等/CAS、分页、不可变出口）。
 *   它们**不是**真实事件流量，也**不是**"消息系统已端到端可用"的证据：
 *   本文件不经 HTTP 路由（消息三端点路由已装配，见 services/api/src/app.ts:1066）、没有持久化、目标读取端口生产实现未接线。
 */
import { ApiError, buildErrorEnvelope } from '../../services/api/src/errors.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import { createMessagesService, strongEtagOf } from '../../services/api/src/messages/service.ts';
import { createUnwiredReferencePort, createWiredReferencePort } from '../../services/api/src/messages/reference.ts';

export { ApiError, buildErrorEnvelope, createUnwiredReferencePort, createWiredReferencePort, strongEtagOf };

/** 仅测试用签名密钥（不是真实密钥、不入库、不入日志）。 */
export const TEST_SIGNING_KEY = 'messages-phase1-test-signing-key';

export const USER_A = Object.freeze({
  userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role: 'user',
  authEpoch: 1,
});
export const USER_B = Object.freeze({
  userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  role: 'user',
  authEpoch: 1,
});
export const ADMIN = Object.freeze({
  userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  role: 'admin',
  authEpoch: 1,
});

/** 一个**不存在**的合法 uuid（用于"未知 id"与"他人消息"的同形比较）。 */
export const ABSENT_MESSAGE_ID = '00000000-0000-4000-8f00-00000000dead';

/** 生成契约格式的确定性 uuid（避免随机性影响断言；4 位组是 4 个 hex 字符）。 */
export function makeIdFactory(namespace = '1') {
  let counter = 0;
  return () => {
    counter += 1;
    return `00000000-0000-4000-8${namespace}00-${String(counter).padStart(12, '0')}`;
  };
}

/** 合法幂等键（契约要求 8..128 字符）。 */
export function idem(seed) {
  return `idem-${String(seed).padStart(4, '0')}`;
}

export function assertApiError(code, status) {
  return (error) => {
    assertApiErrorShape(error, code, status);
    return true;
  };
}

export function assertApiErrorShape(error, code, status) {
  if (!(error instanceof ApiError)) {
    throw new Error(`应为 ApiError，实际：${String(error)}`);
  }
  if (typeof error.code !== 'string') throw new Error(`错误码应为字符串，实际 ${typeof error.code}`);
  if (error.code !== code) throw new Error(`错误码应为 ${code}，实际 ${error.code}`);
  if (typeof error.status !== 'number') throw new Error(`HTTP 状态应为数字，实际 ${typeof error.status}`);
  if (error.status !== status) throw new Error(`HTTP 状态应为 ${status}，实际 ${error.status}`);
}

export async function captureError(run) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('期望抛出错误，但没有抛出');
}

/**
 * 把业务错误渲染成**逐字节可比**的契约错误封套（`ErrorEnvelope`）。
 * 归属/不存在同形判定的核心工具：同一个 `request_id` + 同一个 `execution_mode`
 * 下，两份封套的 JSON 串必须完全相等。
 */
export function errorEnvelopeJson(error, requestId = '99999999-9999-4999-8999-999999999999', executionMode = 'stub') {
  if (!(error instanceof ApiError)) throw new Error(`应为 ApiError，实际：${String(error)}`);
  return JSON.stringify(buildErrorEnvelope(error, { request_id: requestId, execution_mode: executionMode }));
}

/**
 * 计数屏障：`arm()` 后前 `size` 次 `wait()` 会互相等到都到齐才一起放行。
 * 用途：让两条并发标记请求**都跨过"读记录"这一步之后**再各自写，
 * 从而真正检验"检查与写入之间的窗口"是否被 CAS 关掉。
 */
export function makeBarrier(size) {
  let arrived = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let armed = false;
  return {
    arm() {
      armed = true;
    },
    async wait() {
      if (!armed) return;
      arrived += 1;
      if (arrived >= size) release();
      await gate;
    },
    get arrived() {
      return arrived;
    },
  };
}

/** 挂起一次：`arm()` 后**第一次**经过的调用会挂住，直到 `release()`。 */
export function makePausePoint() {
  let release;
  let entered;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  const enteredPromise = new Promise((resolve) => {
    entered = resolve;
  });
  let armed = false;
  let used = false;
  return {
    arm() {
      armed = true;
    },
    async pauseOnce() {
      if (!armed || used) return;
      used = true;
      entered();
      await blocker;
    },
    get entered() {
      return enteredPromise;
    },
    release() {
      release();
    },
  };
}

/**
 * 脚本化时钟：`now()` 返回可控时刻，`advance(ms)` 手动推进。
 * 用途：制造"同刻多条"（不推进 ⇒ `created_at` 全等）与"游标过期"（推进 16 分钟）。
 */
export function scriptedClock(baseMs = Date.UTC(2026, 9, 12, 3, 0, 0)) {
  let ms = baseMs;
  return {
    now: () => new Date(ms),
    advance: (deltaMs) => {
      ms += deltaMs;
      return ms;
    },
    get ms() {
      return ms;
    },
  };
}

/**
 * 构造一套完整依赖（内存 store + 未接线引用端口 + 确定性 id/时钟）。
 * `now` 每次调用递增 1 秒，保证 `created_at` 排序稳定可断言。
 */
export function makeHarness(options = {}) {
  let tick = 0;
  const base = Date.UTC(2026, 9, 12, 3, 0, 0);
  const now = options.now ?? (() => new Date(base + (tick += 1) * 1000));
  const baseStore = options.store ?? createMemoryMessagesStore({ now: () => now().getTime() });
  const store = options.storeWrapper === undefined ? baseStore : options.storeWrapper(baseStore);
  const reference = options.reference ?? createUnwiredReferencePort();
  const newId = options.newId ?? makeIdFactory(options.namespace ?? '1');
  const service = createMessagesService({
    store,
    reference,
    signingKey: TEST_SIGNING_KEY,
    now,
    newId,
    ...(options.idempotencyWaitMs === undefined ? {} : { idempotencyWaitMs: options.idempotencyWaitMs }),
    ...(options.idempotencyTtlMs === undefined ? {} : { idempotencyTtlMs: options.idempotencyTtlMs }),
  });
  return { store, rawStore: baseStore, reference, service, newId, now };
}

/** 便捷：经内部创建口落一条消息（返回 `{created, message}`）。 */
export async function append(service, overrides = {}) {
  return service.appendMessage({
    owner_id: USER_A.userId,
    type: 'comment',
    target_ref: null,
    event_key: 'evt-1',
    ...overrides,
  });
}

/** 契约 `Message` 的键集（`additionalProperties:false` 的逐字段比对基准）。 */
export const MESSAGE_KEYS = ['id', 'revision', 'type', 'target_ref', 'reference_state', 'read_at', 'created_at'];
