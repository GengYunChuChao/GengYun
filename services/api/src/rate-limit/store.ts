/**
 * 限流计数存储（**接口化**，当前只有进程内实现）。
 *
 * 为什么先接口、后实现：本仓不引入新的外部依赖（⛔ 不加 Redis / 不加限流库），
 * 而「单实例进程内计数」有明确的边界——**多实例不共享**（见 `docs/architecture/rate-limit-policy.md`
 * 的「限制与替换点」）。把计数收敛到本接口后，未来换外置存储只需再实现一个
 * `RateLimitStore`（Redis/Postgres/网关令牌桶），中间件与路由层、错误码、响应头
 * 全部不改：接口方法只有 `consume` / `sweep` / `size`，不含任何进程内状态假设。
 *
 * 计数模型：**滑动窗口计数（sliding window counter，精确窗口日志）**——每个 key 只存
 * 「窗口内每次放行的时间戳」，窗口右移时过期命中被逐出，因此不会出现固定窗口在
 * 窗口边界的双倍突刺（固定窗口最坏允许 `2×limit`）。取舍见同一份文档：
 * 令牌桶更平滑、但需要为每个 key 持久化令牌数与上次补充时刻，且「窗口内 N 次」这类
 * 可解释口径难以直接映射；认证/写接口这类**人类操作**限流用滑动窗口更贴近直觉
 * （「一分钟内最多 20 次」），且 `resetAt` / `Retry-After` 都能从命中时间直接算出。
 *
 * 内存占用有界：只保存**被放行**的命中（被拒的请求不写入 ⇒ 不延长窗口，客户端仍可在
 * 窗口恢复后按 `Retry-After` 重试），因此单 key 最多 `limit` 个时间戳；key 总数由
 * `maxKeys` 上限兜底（超出后淘汰**最久未被使用**的 key）。被淘汰的 key 计数归零 ⇒
 * 该 key 的限流**临时失效（fail-open）**，这是有意的取舍：宁可漏限一个冷 key，
 * 也不能让一个攻击者用海量随机 key 把进程内存打爆。这条取舍写在文档的「风险」里。
 */

/** 一个限流窗口的判据（正整数，由配置层校验；此处仍做防御性归一）。 */
export interface RateLimitWindow {
  /** 窗口内允许放行的最大请求数。 */
  limit: number;
  /** 窗口长度（毫秒）。 */
  windowMs: number;
}

/** 单次计数的判定结果（中间件据此写头与决定是否抛 429）。 */
export interface RateLimitDecision {
  /** 是否放行本次请求。 */
  allowed: boolean;
  /** 归一后的窗口上限（用于 `X-RateLimit-Limit`）。 */
  limit: number;
  /** 本次放行后窗口内**还能**放行几次；被拒时为 0。 */
  remaining: number;
  /** 窗口完全恢复的绝对时刻（毫秒时间戳）＝窗口内最早一次命中 + `windowMs`。 */
  resetAtMs: number;
  /** 被拒时建议等待的毫秒数（放行时为 0）；`Retry-After` 由它向上取整到秒。 */
  retryAfterMs: number;
}

/**
 * 计数存储接口。
 *
 * - `consume` 是**同步**的：进程内实现立刻返回；未来外置实现若要异步，需把本接口改成
 *   `Promise` 并在中间件里 `await`（`limiter.ts` 的两处调用点合计 2 行），这仍是接口内部
 *   的事，不改错误码/响应头/规则表。
 * - 时钟由调用方传入（`nowMs`），存储自己**不读系统时钟** ⇒ 单测可精确推进窗口，
 *   也让「同一请求链里只取一次时间」成为可能。
 */
export interface RateLimitStore {
  consume(key: string, window: RateLimitWindow, nowMs: number): RateLimitDecision;
  /** 释放已过期的 key（可外部定期调用；`consume` 也会自剪枝）。 */
  sweep(nowMs: number): void;
  /** 当前跟踪的 key 数（观测/测试用，不含业务语义）。 */
  size(): number;
}

/** 进程内 key 上限缺省值：5000 个活跃 key × 每 key ≤ limit 个时间戳，量级在 1e5 数字。 */
export const DEFAULT_RATE_LIMIT_MAX_KEYS = 5000;

export interface MemoryRateLimitStoreOptions {
  /** key 上限（正整数）；超出后淘汰最久未被使用的 key。 */
  maxKeys?: number;
}

interface Bucket {
  /** 窗口内被放行的命中时刻（升序，因为 `nowMs` 由单调推进的调用方给出）。 */
  hits: number[];
  /** 该桶建立时的窗口长度；窗口配置变化时整桶重建（不把旧口径混进新口径）。 */
  windowMs: number;
}

/**
 * 进程内滑动窗口计数存储（**单实例**）。
 *
 * ⚠️ 多实例部署时各进程各算一份 ⇒ 实际允许量 ≈ `limit × 实例数`，且 `Retry-After` 只反映
 * 本实例窗口。需要跨实例一致限流时必须换外置存储实现（接口不变）。
 */
export function createMemoryRateLimitStore(options: MemoryRateLimitStoreOptions = {}): RateLimitStore {
  const maxKeys = Math.max(1, Math.trunc(options.maxKeys ?? DEFAULT_RATE_LIMIT_MAX_KEYS));
  const buckets = new Map<string, Bucket>();

  /** 逐出窗口外的命中（窗口半开：恰好 `windowMs` 之前的那次算已过期）。 */
  const trim = (bucket: Bucket, nowMs: number): void => {
    const windowStart = nowMs - bucket.windowMs;
    let expired = 0;
    for (;;) {
      const hit = bucket.hits[expired];
      if (hit === undefined || hit > windowStart) break;
      expired += 1;
    }
    if (expired > 0) bucket.hits.splice(0, expired);
  };

  /** 把 key 移到 Map 末尾，使迭代顺序＝最近使用顺序（`Map` 保序，用作 LRU）。 */
  const touch = (key: string, bucket: Bucket): void => {
    buckets.delete(key);
    buckets.set(key, bucket);
  };

  return {
    consume(key, window, nowMs) {
      const limit = Math.max(1, Math.trunc(window.limit));
      const windowMs = Math.max(1, Math.trunc(window.windowMs));
      let bucket = buckets.get(key);
      const isNewKey = bucket === undefined;
      if (bucket === undefined || bucket.windowMs !== windowMs) {
        bucket = { hits: [], windowMs };
        buckets.set(key, bucket);
      }
      trim(bucket, nowMs);
      touch(key, bucket);

      const oldestHit = bucket.hits[0];
      const resetAtMs = oldestHit === undefined ? nowMs + windowMs : oldestHit + windowMs;
      if (bucket.hits.length >= limit) {
        // 被拒不写入：不延长窗口，客户端仍可在窗口恢复后重试（与 `Retry-After` 一致）。
        return { allowed: false, limit, remaining: 0, resetAtMs, retryAfterMs: Math.max(1, resetAtMs - nowMs) };
      }
      bucket.hits.push(nowMs);
      if (isNewKey) {
        // 新 key 才可能抬高总数；淘汰最久未用的（末尾是刚 touch 的当前 key，不会被选中）。
        while (buckets.size > maxKeys) {
          const oldest = buckets.keys().next();
          if (oldest.done === true) break;
          buckets.delete(oldest.value);
        }
      }
      return {
        allowed: true,
        limit,
        remaining: Math.max(0, limit - bucket.hits.length),
        resetAtMs,
        retryAfterMs: 0,
      };
    },

    sweep(nowMs) {
      for (const [key, bucket] of buckets) {
        const windowStart = nowMs - bucket.windowMs;
        const last = bucket.hits[bucket.hits.length - 1];
        // 空桶或最近一次命中都已滑出窗口 ⇒ 整桶可释放（此后计数归零）。
        if (last === undefined || last <= windowStart) buckets.delete(key);
      }
    },

    size() {
      return buckets.size;
    },
  };
}
