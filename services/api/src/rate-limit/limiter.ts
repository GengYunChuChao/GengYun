/**
 * API 层限流中间件（认证端点按 IP、写接口按用户）。
 *
 * 语义与接线位置
 * -------------
 * 限流分两处执行，用的是**同一份规则表与同一个计数器**：
 *
 * 1. `checkIpRules`（挂在 `app.addHook('onRequest')`）：命中 `key: 'ip'` 的规则。
 *    必须早于鉴权——认证端点（`POST /auth/wechat`、`POST /admin/auth/session`）
 *    本身是**公开**的，若等到鉴权之后才计数，暴力破解的那条路径就永远数不到。
 * 2. `checkUserRules`（由 `wrapGuards` 包在鉴权守卫**之后**）：命中 `key: 'user'` 的规则。
 *    只有在服务端解析出 `request.userId` 之后才可能按用户计数，因此这里复用路由层已有的
 *    `AuthGuards` 接缝（与 `createFlagGatedGuards` 同一手法：包装 `createAuthGuards(...)` 的
 *    返回值，**不改任何路由文件**）。执行顺序：鉴权 → 限流 → 开关门 → scope → handler。
 *
 * 规则匹配是**首个命中生效**（顺序由 `defaultRateLimitRules` 给出）：`POST /auth/logout`
 * 既像认证端点又像写接口，按表里的顺序落到 `auth-ip`（同一类会话端点用同一把尺子）。
 *
 * 装配形态：`app.ts` 里写成一行 `createRateLimiter(...).mount(app).wrapGuards(...)`，
 * 本文件的 import 追加在 `app.ts` 末尾。这是**锚点中立**的取舍——`app.ts` 的行号是 `docs/**`
 * 手写引用与契约台账的证据锚点，在函数体里多插行会把它们整片推离事实位置。
 *
 * 错误契约
 * --------
 * 超限抛 `ApiError('RATE_LIMITED')`（契约 `error_status_map` 里 429 的既有码，
 * 见 `services/api/src/contract.ts` 的 `ERROR_STATUS_MAP[429]`），因此**不新增错误码**、
 * 不改 `packages/contracts/**`。`retryable: true`（同一请求稍后重试会成功），
 * 剩余窗口通过 `ApiError.retryAfterSeconds` 交给 `errors.ts` 的 `retryAfterSecondsFor`——
 * 这是 `Retry-After` 的**唯一出口**，本文件⛔不直接写该头。
 *
 * 响应头（放行与超限都写，客户端可自行退避）：
 * - `X-RateLimit-Limit`：窗口上限；
 * - `X-RateLimit-Remaining`：本次之后还剩几次（被拒为 0）；
 * - `X-RateLimit-Reset`：距离窗口恢复的**整数秒**（⛔不是 epoch 时间戳，口径见文档）。
 *
 * 单实例限制
 * ----------
 * 计数在进程内（`store.ts`），**多实例不共享**：N 个实例 ⇒ 实际允许量约 `N × limit`。
 * 需要跨实例一致限流时替换 `RateLimitStore` 实现即可，本文件与路由层不变。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { API_PREFIX } from '../contract.ts';
import { ApiError } from '../errors.ts';
import type { AuthGuards } from '../auth/middleware.ts';
import type { RateLimitConfig } from '../config.ts';
import { createMemoryRateLimitStore, type RateLimitStore } from './store.ts';

/** 计数键的两种口径。 */
export type RateLimitKeyKind = 'ip' | 'user';

/** 写方法（`key: 'user'` 的默认适用范围）。 */
export const WRITE_METHODS = Object.freeze(['POST', 'PUT', 'PATCH', 'DELETE'] as const);

/** 响应头名（放行与超限都写）。 */
export const RATE_LIMIT_HEADERS = Object.freeze({
  limit: 'X-RateLimit-Limit',
  remaining: 'X-RateLimit-Remaining',
  reset: 'X-RateLimit-Reset',
});

/** 一条限流规则。 */
export interface RateLimitRule {
  /** 规则 id，同时是计数键的命名空间（改 id ＝ 换一把新桶，不继承旧计数）。 */
  id: string;
  /** 命中的 HTTP 方法（大写）。 */
  methods: readonly string[];
  /** 命中的路径前缀（含 `API_PREFIX`；多条之间是「或」）。 */
  pathPrefixes: readonly string[];
  /** 计数键：客户端 IP 或服务端解析出的用户 id。 */
  key: RateLimitKeyKind;
  /** 窗口内允许的最大请求数。 */
  limit: number;
  /** 窗口长度（毫秒）。 */
  windowMs: number;
}

/**
 * 默认策略（顺序即匹配优先级，首个命中生效）。
 *
 * 1. `auth-ip`：`POST /api/v1/auth/*`、`POST /api/v1/admin/auth/*` 按客户端 IP 计数。
 *    覆盖登录、退出与后台登录/退出——都是「能造/能毁会话」的端点，同一把尺子。
 * 2. `write-user`：其余 `POST/PUT/PATCH/DELETE` 按服务端解析出的用户 id 计数。
 *    未鉴权的写请求（理论上只可能是公开端点）兜底按 IP 计数，避免出现「数不到」的空洞。
 */
export function defaultRateLimitRules(config: RateLimitConfig): RateLimitRule[] {
  return [
    {
      id: 'auth-ip',
      methods: Object.freeze(['POST']),
      pathPrefixes: Object.freeze([`${API_PREFIX}/auth/`, `${API_PREFIX}/admin/auth/`]),
      key: 'ip',
      limit: config.authIp.limit,
      windowMs: config.authIp.windowMs,
    },
    {
      id: 'write-user',
      methods: WRITE_METHODS,
      pathPrefixes: Object.freeze([`${API_PREFIX}/`]),
      key: 'user',
      limit: config.writeUser.limit,
      windowMs: config.writeUser.windowMs,
    },
  ];
}

export interface RateLimitOptions {
  /** 缺省用 `RATE_LIMIT_DEFAULTS`（= 默认策略生效）。 */
  config?: RateLimitConfig;
  /** 计数存储；缺省为进程内滑动窗口实现（单实例）。 */
  store?: RateLimitStore;
  /** 时钟；缺省为系统时钟。单测注入可精确推进窗口。 */
  now?: () => Date;
}

export interface RateLimiter {
  /** 配置开关（`false` 时两处检查与守卫包装全部直通）。 */
  readonly enabled: boolean;
  readonly rules: readonly RateLimitRule[];
  /**
   * 在 Fastify 实例上登记 IP 维度的 `onRequest` 钩子，并返回自身（便于
   * `createRateLimiter(...).mount(app).wrapGuards(guards)` 一行装配）。
   *
   * `onRequest` 阶段路由尚未匹配，规则只能按原始 URL 的路径前缀判定；这也正是它必须早于鉴权的
   * 原因——`POST /auth/wechat`、`POST /admin/auth/session` 是**公开**端点，等鉴权之后再计数就
   * 永远数不到暴力破解那条路径。
   */
  mount(app: FastifyInstance): RateLimiter;
  /** `onRequest` 钩子用：只处理 IP 计数规则。 */
  checkIpRules(request: FastifyRequest, reply: FastifyReply): void;
  /** 鉴权之后用：只处理用户计数规则。 */
  checkUserRules(request: FastifyRequest, reply: FastifyReply): void;
  /** 包装鉴权守卫，使「鉴权成功 ⇒ 立刻按用户计数」。 */
  wrapGuards(guards: AuthGuards): AuthGuards;
  /** 当前跟踪的 key 数（观测/测试用）。 */
  size(): number;
}

/** 去掉查询串，只留路径（`onRequest` 阶段路由尚未匹配，只能从原始 URL 取）。 */
function pathnameOf(url: string): string {
  const query = url.indexOf('?');
  const pathname = query === -1 ? url : url.slice(0, query);
  const hash = pathname.indexOf('#');
  return hash === -1 ? pathname : pathname.slice(0, hash);
}

/** IPv4-mapped IPv6（`::ffff:127.0.0.1`）与裸 IPv4 归一成同一个键，避免同一客户端拿到两把桶。 */
function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  const captured = mapped === null ? undefined : mapped[1];
  return captured === undefined ? trimmed : captured;
}

/**
 * 创建限流器。
 *
 * 计数键 = `<规则 id>:<ip:…|user:…>`，因此：
 * - 同一 IP 在 `auth-ip` 与（兜底的）`write-user` 上互不影响；
 * - 不同用户、不同 IP 互不影响（单测逐条钉住）。
 */
export function createRateLimiter(options: RateLimitOptions = {}): RateLimiter {
  const config = options.config;
  const enabled = config === undefined ? true : config.enabled;
  const rules = config === undefined ? [] : defaultRateLimitRules(config);
  const store = options.store ?? (config === undefined
    ? createMemoryRateLimitStore()
    : createMemoryRateLimitStore({ maxKeys: config.maxKeys }));
  const now = options.now ?? (() => new Date());
  const exemptPaths = config?.exemptPaths ?? [];
  const allowlistIps = (config?.allowlistIps ?? []).map(normalizeIp);
  /**
   * 同一请求里多条守卫（`requireAdmin` + `requireScope`）会串行走过 `wrapGuards`：
   * 记住已计数的规则 id，避免一次请求被计成两次。
   */
  const countedRules = new WeakMap<FastifyRequest, Set<string>>();

  const wasCounted = (request: FastifyRequest, ruleId: string): boolean => {
    let counted = countedRules.get(request);
    if (counted === undefined) {
      counted = new Set<string>();
      countedRules.set(request, counted);
    }
    if (counted.has(ruleId)) return true;
    counted.add(ruleId);
    return false;
  };

  const isExempt = (pathname: string): boolean =>
    exemptPaths.some((exempt) => pathname === exempt || pathname.startsWith(`${exempt}/`));

  const isAllowlisted = (ip: string): boolean => allowlistIps.includes(normalizeIp(ip));

  const resolveRule = (method: string, pathname: string): RateLimitRule | null => {
    const upper = method.toUpperCase();
    for (const rule of rules) {
      if (!rule.methods.includes(upper)) continue;
      if (rule.pathPrefixes.some((prefix) => pathname.startsWith(prefix))) return rule;
    }
    return null;
  };

  const applyHeaders = (reply: FastifyReply, decision: { limit: number; remaining: number; resetAtMs: number }, nowMs: number): void => {
    reply.header(RATE_LIMIT_HEADERS.limit, String(decision.limit));
    reply.header(RATE_LIMIT_HEADERS.remaining, String(decision.remaining));
    reply.header(RATE_LIMIT_HEADERS.reset, String(Math.max(0, Math.ceil((decision.resetAtMs - nowMs) / 1000))));
  };

  const enforce = (rule: RateLimitRule, identifier: string, request: FastifyRequest, reply: FastifyReply): void => {
    if (wasCounted(request, rule.id)) return;
    const nowMs = now().getTime();
    const decision = store.consume(`${rule.id}:${identifier}`, { limit: rule.limit, windowMs: rule.windowMs }, nowMs);
    // 先写头再抛：429 响应同样带 `X-RateLimit-*`，客户端不必靠错误体猜剩余量。
    applyHeaders(reply, decision, nowMs);
    if (decision.allowed) return;
    const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
    throw new ApiError('RATE_LIMITED', `请求过于频繁，请 ${retryAfterSeconds} 秒后再试`, {
      retryable: true,
      // `Retry-After` 的唯一出口是 `errors.ts` 的 `retryAfterSecondsFor`（本文件不写该头）。
      retryAfterSeconds,
    });
  };

  const checkIpRules = (request: FastifyRequest, reply: FastifyReply): void => {
    if (!enabled) return;
    const pathname = pathnameOf(request.url);
    if (isExempt(pathname)) return;
    const ip = normalizeIp(request.ip);
    if (isAllowlisted(ip)) return;
    const rule = resolveRule(request.method, pathname);
    if (rule === null || rule.key !== 'ip') return;
    enforce(rule, `ip:${ip}`, request, reply);
  };

  const checkUserRules = (request: FastifyRequest, reply: FastifyReply): void => {
    if (!enabled) return;
    // 守卫阶段路由已匹配：用路由模板（含 `:param`），与 `createFlagGatedGuards` 同口径。
    const pathname = pathnameOf(request.routeOptions?.url ?? request.url);
    if (isExempt(pathname)) return;
    const ip = normalizeIp(request.ip);
    if (isAllowlisted(ip)) return;
    const rule = resolveRule(request.method, pathname);
    if (rule === null || rule.key !== 'user') return;
    const userId = request.userId;
    // 未鉴权的写请求（公开端点）兜底按 IP：宁可收紧，也不留「数不到」的空洞。
    const identifier = typeof userId === 'string' && userId !== '' ? `user:${userId}` : `ip:${ip}`;
    enforce(rule, identifier, request, reply);
  };

  const limiter: RateLimiter = {
    enabled,
    rules,
    mount(app: FastifyInstance): RateLimiter {
      // 关掉时连钩子都不登记：直通路径零开销（守卫包装同样原样返回）。
      if (!enabled) return limiter;
      app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
        checkIpRules(request, reply);
      });
      return limiter;
    },
    checkIpRules,
    checkUserRules,
    wrapGuards(guards: AuthGuards): AuthGuards {
      if (!enabled) return guards;
      // 收窄成两参调用：本仓守卫都是 async 且不使用 `done`（与 `createFlagGatedGuards` 同注释）。
      const wrap = (inner: preHandlerHookHandler): preHandlerHookHandler =>
        async (request: FastifyRequest, reply: FastifyReply) => {
          const run = inner as unknown as (request: FastifyRequest, reply: FastifyReply) => Promise<void> | void;
          await run(request, reply);
          checkUserRules(request, reply);
        };
      return {
        requireUser: wrap(guards.requireUser),
        requireAdmin: wrap(guards.requireAdmin),
        requireScope: (scope: string) => wrap(guards.requireScope(scope)),
      };
    },
    size(): number {
      return store.size();
    },
  };
  return limiter;
}
