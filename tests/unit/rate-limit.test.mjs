// 限流（GY-R34）：滑动窗口计数、默认策略（认证端点按 IP / 写接口按用户）、
// 429 契约与 `Retry-After` / `X-RateLimit-*` 头。
//
// 覆盖派单要求的五条：窗口内超限 429、窗口过期恢复、不同 key 互不影响、白名单/豁免路径、
// 错误码与头字段正确；另外钉住两条容易回归的实现细节：
// - 同一请求串行过两条守卫（`requireAdmin` + `requireScope`）只计一次；
// - 计数在进程内**单实例**（本文件不断言多实例一致，因为那正是未做的部分）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig, RATE_LIMIT_DEFAULTS } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { ApiError, retryAfterSecondsFor } from '../../services/api/src/errors.ts';
import { DEFAULT_RATE_LIMIT_MAX_KEYS, createMemoryRateLimitStore } from '../../services/api/src/rate-limit/store.ts';
import {
  RATE_LIMIT_HEADERS,
  WRITE_METHODS,
  createRateLimiter,
  defaultRateLimitRules,
} from '../../services/api/src/rate-limit/limiter.ts';
import { scriptedClock } from './favorites-history-fixtures.mjs';

const START = Date.UTC(2026, 9, 14, 9, 0, 0);
const LOGIN_URL = '/api/v1/auth/wechat';
const FAVORITES = '/api/v1/favorites';
const FAVORITE_BODY = {
  target_ref: { type: 'herbicide', id: '00000000-0000-4000-8a00-000000000001', revision: 1 },
};

/** 只实现限流器会用到的那几个成员（`FastifyReply.header()` 的链式返回）。 */
function fakeReply() {
  const headers = new Map();
  return {
    headers,
    header(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
      return this;
    },
  };
}

function fakeRequest({ method = 'POST', url, routeUrl = url, ip = '203.0.113.7', userId = null } = {}) {
  return { method, url, ip, userId, routeOptions: { url: routeUrl } };
}

/** 取回被同步抛出的 `ApiError`（`assert.throws` 只返回 undefined，拿不到对象）。 */
function expectApiError(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ApiError, `应抛出 ApiError，实际是 ${String(error)}`);
    return error;
  }
  assert.fail('应当抛出 ApiError，但没有抛');
  return null;
}

/** 只带 `rateLimit` 覆盖项的限流配置（其余取默认值）。 */
function rateConfig(overrides = {}) {
  return {
    ...RATE_LIMIT_DEFAULTS,
    ...overrides,
    authIp: { ...RATE_LIMIT_DEFAULTS.authIp, ...(overrides.authIp ?? {}) },
    writeUser: { ...RATE_LIMIT_DEFAULTS.writeUser, ...(overrides.writeUser ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// 1. 滑动窗口存储：窗口内超限、窗口过期恢复、不同 key 互不影响、key 上限
// ---------------------------------------------------------------------------

test('滑动窗口：窗口内超限被拒，被拒的请求不延长窗口，窗口滑过后恢复', () => {
  const store = createMemoryRateLimitStore();
  const window = { limit: 3, windowMs: 60_000 };

  const first = store.consume('k', window, START);
  assert.equal(first.allowed, true);
  assert.equal(first.remaining, 2);
  assert.equal(first.resetAtMs, START + 60_000);
  assert.equal(store.consume('k', window, START + 1_000).allowed, true);
  assert.equal(store.consume('k', window, START + 2_000).allowed, true);

  // 第 4 次落在同一窗口内 ⇒ 拒绝，剩余为 0，retryAfter 指向**最早**那次命中 + 窗口。
  const denied = store.consume('k', window, START + 30_000);
  assert.equal(denied.allowed, false);
  assert.equal(denied.remaining, 0);
  assert.equal(denied.resetAtMs, START + 60_000);
  assert.equal(denied.retryAfterMs, 30_000);

  // 窗口半开：恰好 60s 时最早那次已过期 ⇒ 放行（若被拒请求写过时间戳，这里会是 429）。
  const recovered = store.consume('k', window, START + 60_000);
  assert.equal(recovered.allowed, true);
  // 滑动窗口：此刻桶里是 START+1000、START+2000 与本次命中，最早一次仍是 START+1000 ⇒ 再 59s 才全空。
  assert.equal(recovered.resetAtMs, START + 61_000);
});

test('滑动窗口：不同 key 互不影响（一个 key 超限不影响另一个）', () => {
  const store = createMemoryRateLimitStore();
  const window = { limit: 1, windowMs: 60_000 };

  assert.equal(store.consume('auth-ip:ip:1.1.1.1', window, START).allowed, true);
  assert.equal(store.consume('auth-ip:ip:1.1.1.1', window, START).allowed, false);
  assert.equal(store.consume('auth-ip:ip:2.2.2.2', window, START).allowed, true);
  assert.equal(store.consume('write-user:user:u-1', window, START).allowed, true);
  assert.equal(store.consume('write-user:user:u-1', window, START).allowed, false);
  assert.equal(store.consume('write-user:user:u-2', window, START).allowed, true);
});

test('滑动窗口：key 总数有上限，超出时淘汰最久未用的 key（该 key 计数归零 = 有意 fail-open）', () => {
  const store = createMemoryRateLimitStore({ maxKeys: 2 });
  const window = { limit: 1, windowMs: 60_000 };
  assert.equal(DEFAULT_RATE_LIMIT_MAX_KEYS, 5_000);

  store.consume('a', window, START);
  store.consume('b', window, START);
  assert.equal(store.size(), 2);
  store.consume('c', window, START);
  assert.equal(store.size(), 2, '超出上限后仍只有 2 个桶');

  // `a` 被淘汰 ⇒ 它的窗口丢失，再来一次会被当作新 key 放行（有意的内存有界取舍）。
  assert.equal(store.consume('a', window, START).allowed, true);
  // `b` 已被淘汰（此时最久未用），`c` 仍在 ⇒ 第二次仍被拒。
  assert.equal(store.consume('c', window, START).allowed, false);
});

test('滑动窗口：窗口长度变化会重建该 key 的桶（不把旧口径混进新口径）', () => {
  const store = createMemoryRateLimitStore();
  assert.equal(store.consume('k', { limit: 1, windowMs: 60_000 }, START).allowed, true);
  assert.equal(store.consume('k', { limit: 1, windowMs: 60_000 }, START).allowed, false);
  assert.equal(store.consume('k', { limit: 1, windowMs: 30_000 }, START).allowed, true, '改窗口 ⇒ 新桶');

  store.sweep(START + 10 * 60_000);
  assert.equal(store.size(), 0, 'sweep 释放整桶');
});

// ---------------------------------------------------------------------------
// 2. 规则表与默认策略（唯一事实源＝config.ts 的 RATE_LIMIT_DEFAULTS）
// ---------------------------------------------------------------------------

test('默认策略：认证端点 POST 按 IP、其余写方法按用户，数值来自 RATE_LIMIT_DEFAULTS', () => {
  const rules = defaultRateLimitRules(RATE_LIMIT_DEFAULTS);
  assert.deepEqual(rules.map((rule) => rule.id), ['auth-ip', 'write-user']);

  const [auth, write] = rules;
  assert.equal(auth.key, 'ip');
  assert.deepEqual([...auth.methods], ['POST']);
  assert.deepEqual([...auth.pathPrefixes], ['/api/v1/auth/', '/api/v1/admin/auth/'], '登录与后台登录共用一把尺子');
  assert.equal(auth.limit, 20);
  assert.equal(auth.windowMs, 60_000);

  assert.equal(write.key, 'user');
  assert.deepEqual([...write.methods], [...WRITE_METHODS]);
  assert.deepEqual([...write.methods], ['POST', 'PUT', 'PATCH', 'DELETE']);
  assert.deepEqual([...write.pathPrefixes], ['/api/v1/']);
  assert.equal(write.limit, 120);
  assert.equal(write.windowMs, 60_000);

  // 配置覆盖直接改规则表（不是运行期再判断一遍）。
  const custom = defaultRateLimitRules(rateConfig({ authIp: { limit: 3, windowMs: 1_000 } }));
  assert.equal(custom[0].limit, 3);
  assert.equal(custom[0].windowMs, 1_000);
});

// ---------------------------------------------------------------------------
// 3. 限流器本身：豁免路径、白名单、头字段、429 契约、守卫包装与去重
// ---------------------------------------------------------------------------

test('认证端点按 IP 计数：超限抛 RATE_LIMITED(429)，并写出三个 X-RateLimit-* 头', () => {
  const limiter = createRateLimiter({ config: rateConfig({ authIp: { limit: 1, windowMs: 60_000 }, writeUser: { limit: 50, windowMs: 60_000 } }), now: () => new Date(START) });
  const request = fakeRequest({ url: LOGIN_URL });
  const reply = fakeReply();

  limiter.checkIpRules(request, reply);
  assert.equal(reply.headers.get('x-ratelimit-limit'), '1');
  assert.equal(reply.headers.get('x-ratelimit-remaining'), '0');
  assert.equal(reply.headers.get('x-ratelimit-reset'), '60');
  assert.equal(reply.headers.has('retry-after'), false, 'Retry-After 只由 errors.ts 的唯一出口写');

  const secondReply = fakeReply();
  const error = expectApiError(() => limiter.checkIpRules(fakeRequest({ url: LOGIN_URL }), secondReply));
  assert.equal(error.code, 'RATE_LIMITED');
  assert.equal(error.status, 429);
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfterSeconds, 60);
  assert.equal(secondReply.headers.get('x-ratelimit-remaining'), '0');
  // 唯一出口：`Retry-After` 由 `retryAfterSecondsFor` 从同一个事实算出。
  assert.equal(retryAfterSecondsFor(error), 60);
});

test('豁免路径与白名单 IP 不计数；不在规则表里的方法/路径也不计数', () => {
  // 豁免用例必须用**本来会命中规则**的路径才有牙齿：早先版本配 `exemptPaths:['/health']`
  // 打 `/health`，而 `/health` 不在任何规则的前缀里 ⇒ 删掉 `isExempt` 也照样过（断言不可证伪）。
  // 现在改成豁免 `/api/v1/auth` 前缀、打真实的 `POST /api/v1/auth/wechat`（会命中 auth-ip 规则）。
  // 白名单与对照组换到 `/api/v1/admin/auth/session`：同属 auth-ip 规则，但**不在**豁免前缀下。
  const ADMIN_LOGIN_URL = '/api/v1/admin/auth/session';
  const limiter = createRateLimiter({
    config: rateConfig({
      authIp: { limit: 1, windowMs: 60_000 },
      writeUser: { limit: 1, windowMs: 60_000 },
      exemptPaths: ['/api/v1/auth'],
      allowlistIps: ['198.51.100.7'],
    }),
    now: () => new Date(START),
  });

  // 豁免路径：连打 5 次都不计数（也不写头）。
  for (let i = 0; i < 5; i += 1) {
    const reply = fakeReply();
    limiter.checkIpRules(fakeRequest({ url: LOGIN_URL }), reply);
    assert.equal(reply.headers.size, 0);
  }

  // 白名单 IP：同一 IP 连打 5 次登录（非豁免路径）也不计数。
  for (let i = 0; i < 5; i += 1) {
    const reply = fakeReply();
    limiter.checkIpRules(fakeRequest({ url: ADMIN_LOGIN_URL, ip: '198.51.100.7' }), reply);
    assert.equal(reply.headers.size, 0);
  }

  // 非写方法（GET）不命中写规则 ⇒ 不计数。
  for (let i = 0; i < 5; i += 1) {
    const reply = fakeReply();
    limiter.checkUserRules(fakeRequest({ method: 'GET', url: FAVORITES, userId: 'u-1' }), reply);
    assert.equal(reply.headers.size, 0);
  }

  // 对照：既不在豁免前缀、也不在白名单里的同一路径，第 2 次就被拒。
  limiter.checkIpRules(fakeRequest({ url: ADMIN_LOGIN_URL, ip: '203.0.113.9' }), fakeReply());
  assert.throws(() => limiter.checkIpRules(fakeRequest({ url: ADMIN_LOGIN_URL, ip: '203.0.113.9' }), fakeReply()), ApiError);
});

test('IPv4-mapped IPv6 与裸 IPv4 共用同一把桶（同一客户端不会拿到两份额度）', () => {
  const limiter = createRateLimiter({ config: rateConfig({ authIp: { limit: 1, windowMs: 60_000 } }), now: () => new Date(START) });
  limiter.checkIpRules(fakeRequest({ url: LOGIN_URL, ip: '::ffff:203.0.113.7' }), fakeReply());
  assert.throws(() => limiter.checkIpRules(fakeRequest({ url: LOGIN_URL, ip: '203.0.113.7' }), fakeReply()), ApiError);
});

test('写接口按用户计数：用户之间互不影响，未鉴权时兜底按 IP', () => {
  const limiter = createRateLimiter({ config: rateConfig({ writeUser: { limit: 1, windowMs: 60_000 } }), now: () => new Date(START) });
  const url = FAVORITES;
  limiter.checkUserRules(fakeRequest({ url, userId: 'user-a' }), fakeReply());
  assert.throws(() => limiter.checkUserRules(fakeRequest({ url, userId: 'user-a' }), fakeReply()), ApiError);
  // 另一个用户不受影响。
  limiter.checkUserRules(fakeRequest({ url, userId: 'user-b' }), fakeReply());

  // 未鉴权（`userId === null`）⇒ 走 `ip:` 键，与同 IP 的匿名写请求共享额度。
  limiter.checkUserRules(fakeRequest({ url, userId: null, ip: '203.0.113.30' }), fakeReply());
  assert.throws(() => limiter.checkUserRules(fakeRequest({ url, userId: null, ip: '203.0.113.30' }), fakeReply()), ApiError);
});

test('wrapGuards：先跑内层守卫再计数；同一请求串行过两条守卫只计一次；关闭时原样返回', async () => {
  const limiter = createRateLimiter({ config: rateConfig({ writeUser: { limit: 1, windowMs: 60_000 } }), now: () => new Date(START) });
  const order = [];
  const guards = {
    requireUser: async (request) => {
      order.push('guard');
      request.userId = 'user-a';
    },
    requireAdmin: async (request) => {
      order.push('admin');
      request.userId = 'admin-a';
    },
    requireScope: () => async () => {
      order.push('scope');
    },
  };

  const wrapped = limiter.wrapGuards(guards);
  const request = fakeRequest({ url: FAVORITES });
  const reply = fakeReply();
  await wrapped.requireUser(request, reply);
  assert.deepEqual(order, ['guard'], '内层守卫先执行');
  assert.equal(reply.headers.get('x-ratelimit-remaining'), '0');

  // 同一请求接着过第二条守卫（真实形态：`requireAdmin` + `requireScope`）⇒ 不重复计数。
  await wrapped.requireScope('session:read')(request, reply);
  await wrapped.requireAdmin(request, reply);
  assert.deepEqual(order, ['guard', 'scope', 'admin']);

  // 新请求（新对象）用同一用户 ⇒ 已超限。
  await assert.rejects(async () => wrapped.requireUser(fakeRequest({ url: FAVORITES }), fakeReply()), ApiError);
});

test('mount(app)：登记一条 onRequest 钩子并把 IP 维度接上去；关闭时不登记钩子', async () => {
  const registered = [];
  const app = { addHook: (name, handler) => { registered.push({ name, handler }); } };

  const limiter = createRateLimiter({ config: rateConfig({ authIp: { limit: 1, windowMs: 60_000 } }), now: () => new Date(START) });
  assert.equal(limiter.mount(app), limiter, '返回自身，便于 `createRateLimiter(...).mount(app).wrapGuards(...)` 一行装配');
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'onRequest', 'IP 维度必须挂 onRequest（早于鉴权）');

  await registered[0].handler(fakeRequest({ url: LOGIN_URL, ip: '203.0.113.50' }), fakeReply());
  await assert.rejects(
    async () => registered[0].handler(fakeRequest({ url: LOGIN_URL, ip: '203.0.113.50' }), fakeReply()),
    ApiError,
  );

  const off = createRateLimiter({ config: rateConfig({ enabled: false }) });
  off.mount(app);
  assert.equal(registered.length, 1, '关闭时连钩子都不登记（直通路径零开销）');
});

test('开关关闭时：检查直通、守卫原样返回（不计数、不写头）', () => {
  const guards = { requireUser: async () => {}, requireAdmin: async () => {}, requireScope: () => async () => {} };
  const limiter = createRateLimiter({ config: rateConfig({ enabled: false }), now: () => new Date(START) });
  assert.equal(limiter.enabled, false);
  assert.equal(limiter.wrapGuards(guards), guards, '直通时不解包守卫');

  const reply = fakeReply();
  for (let i = 0; i < 10; i += 1) limiter.checkIpRules(fakeRequest({ url: LOGIN_URL }), reply);
  assert.equal(reply.headers.size, 0);
});

// ---------------------------------------------------------------------------
// 4. 错误码口径：RATE_LIMITED 复用契约既有码，Retry-After 仍只有一个出口
// ---------------------------------------------------------------------------

test('429 契约：复用 RATE_LIMITED（不新增错误码），Retry-After 取限流器剩余窗口', () => {
  assert.equal(retryAfterSecondsFor(new ApiError('RATE_LIMITED', 'x')), 1, '拿不到剩余窗口 ⇒ 固定 1 秒');
  assert.equal(retryAfterSecondsFor(new ApiError('RATE_LIMITED', 'x', { retryAfterSeconds: 42 })), 42);
  assert.equal(retryAfterSecondsFor(new ApiError('RATE_LIMITED', 'x', { retryAfterSeconds: 1.2 })), 2, '整数秒（向上取整）');
  assert.equal(retryAfterSecondsFor(new ApiError('RATE_LIMITED', 'x', { retryAfterSeconds: 0 })), 1, '小于 1 一律按 1 秒');
  assert.equal(retryAfterSecondsFor(new ApiError('REQUEST_IN_PROGRESS', 'x')), 1);
  assert.equal(retryAfterSecondsFor(new ApiError('NOT_FOUND', 'x')), null, '非 429/409 不写该头');
});

// ---------------------------------------------------------------------------
// 5. 配置解析：缺省即默认策略、可覆盖、非法值一次性报出
// ---------------------------------------------------------------------------

test('配置：未给 RATE_LIMIT_* 时等于默认策略（开启；认证 20/60s；写 120/60s）', () => {
  const config = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
  assert.deepEqual(config.rateLimit, {
    enabled: true,
    authIp: { limit: 20, windowMs: 60_000 },
    writeUser: { limit: 120, windowMs: 60_000 },
    exemptPaths: ['/health'],
    allowlistIps: [],
    maxKeys: 5_000,
  });
});

test('配置：RATE_LIMIT_* 可覆盖；列表用逗号分隔，显式空串清空默认豁免', () => {
  const config = loadConfig({
    APP_EXECUTION_MODE: 'stub',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_ENABLED: 'false',
    RATE_LIMIT_AUTH_LIMIT: '3',
    RATE_LIMIT_AUTH_WINDOW_MS: '1000',
    RATE_LIMIT_WRITE_LIMIT: '9',
    RATE_LIMIT_WRITE_WINDOW_MS: '2000',
    RATE_LIMIT_EXEMPT_PATHS: '/health, /api/v1/metrics',
    RATE_LIMIT_ALLOWLIST_IPS: '127.0.0.1, 203.0.113.5',
    RATE_LIMIT_MAX_KEYS: '17',
  });
  assert.deepEqual(config.rateLimit, {
    enabled: false,
    authIp: { limit: 3, windowMs: 1_000 },
    writeUser: { limit: 9, windowMs: 2_000 },
    exemptPaths: ['/health', '/api/v1/metrics'],
    allowlistIps: ['127.0.0.1', '203.0.113.5'],
    maxKeys: 17,
  });

  const cleared = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', RATE_LIMIT_EXEMPT_PATHS: '' });
  assert.deepEqual(cleared.rateLimit.exemptPaths, [], '空串 = 清空，而不是回落到默认 /health');
});

test('配置：非法 RATE_LIMIT_* 一次性报出（字段名 + INVALID_VALUE，不静默夹取）', () => {
  assert.throws(
    () =>
      loadConfig({
        APP_EXECUTION_MODE: 'stub',
        LOG_LEVEL: 'silent',
        RATE_LIMIT_ENABLED: 'yes',
        RATE_LIMIT_AUTH_LIMIT: '0',
        RATE_LIMIT_WRITE_WINDOW_MS: '50',
        RATE_LIMIT_EXEMPT_PATHS: 'health',
        RATE_LIMIT_ALLOWLIST_IPS: '10.0.0.0/8',
        RATE_LIMIT_MAX_KEYS: '-1',
      }),
    (error) => {
      assert.equal(error.name, 'ConfigError');
      const fields = error.issues.map((issue) => issue.field);
      assert.deepEqual(fields, [
        'RATE_LIMIT_ENABLED',
        'RATE_LIMIT_AUTH_LIMIT',
        'RATE_LIMIT_WRITE_WINDOW_MS',
        'RATE_LIMIT_EXEMPT_PATHS',
        'RATE_LIMIT_ALLOWLIST_IPS',
        'RATE_LIMIT_MAX_KEYS',
      ]);
      assert.ok(error.issues.every((issue) => issue.code === 'INVALID_VALUE'));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 5b. 代理语义：API_TRUST_PROXY 的取值面与非法值（默认 false）
// ---------------------------------------------------------------------------

test('配置：API_TRUST_PROXY 默认 false；true/false/非负整数跳数都按字面解析', () => {
  const base = { APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' };
  assert.equal(loadConfig(base).trustProxy, false, '未配置 ⇒ 不信任任何代理（直连/本地口径不变）');
  assert.equal(loadConfig({ ...base, API_TRUST_PROXY: '' }).trustProxy, false, '空串等同未配置');
  assert.equal(loadConfig({ ...base, API_TRUST_PROXY: 'true' }).trustProxy, true);
  assert.equal(loadConfig({ ...base, API_TRUST_PROXY: 'TRUE' }).trustProxy, true, '大小写不敏感');
  assert.equal(loadConfig({ ...base, API_TRUST_PROXY: 'false' }).trustProxy, false);
  assert.equal(loadConfig({ ...base, API_TRUST_PROXY: '0' }).trustProxy, 0, '0 按跳数解析（与 false 等价）');
  assert.equal(loadConfig({ ...base, API_TRUST_PROXY: '1' }).trustProxy, 1, '数字按跳数解析，不按布尔解析');
  assert.equal(loadConfig({ ...base, API_TRUST_PROXY: ' 2 ' }).trustProxy, 2, '两侧空白不算非法');
  assert.equal(loadConfig({ ...base, API_TRUST_PROXY: '32' }).trustProxy, 32);
});

test('配置：非法 API_TRUST_PROXY 报错不夹取（yes / -1 / 2.5 / 越界跳数）', () => {
  for (const bad of ['yes', '-1', '2.5', '33', '1.0', 'true,false']) {
    assert.throws(
      () => loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', API_TRUST_PROXY: bad }),
      (error) => {
        assert.equal(error.name, 'ConfigError', `API_TRUST_PROXY=${bad} 应报 ConfigError`);
        assert.deepEqual(error.issues.map((issue) => issue.field), ['API_TRUST_PROXY']);
        assert.equal(error.issues[0].code, 'INVALID_VALUE');
        return true;
      },
    );
  }
});


// ---------------------------------------------------------------------------
// 6. 端到端（真实 Fastify 实例）：认证端点 429、窗口过期恢复、写接口按用户
// ---------------------------------------------------------------------------

function newApp(t, extra = {}) {
  const clock = scriptedClock(START);
  const store = createMemoryAuthStore();
  const config = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', ...(extra.env ?? {}) });
  const app = buildApp({ config, store, now: clock.now, ...(extra.build ?? {}) });
  t.after(() => app.close());
  return { app, clock, store };
}

function login(app, code, ip) {
  return app.inject({
    method: 'POST',
    url: LOGIN_URL,
    headers: { 'idempotency-key': `idem-${code}` },
    payload: { code },
    ...(ip === undefined ? {} : { remoteAddress: ip }),
  });
}

test('端到端：POST /auth/wechat 窗口内超限 ⇒ 429 RATE_LIMITED + Retry-After + X-RateLimit-*', async (t) => {
  const { app } = newApp(t, { env: { RATE_LIMIT_AUTH_LIMIT: '2' } });

  const first = await login(app, 'code-r34-1');
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['x-ratelimit-limit'], '2');
  assert.equal(first.headers['x-ratelimit-remaining'], '1');
  assert.equal(first.headers['x-ratelimit-reset'], '60');

  assert.equal((await login(app, 'code-r34-2')).statusCode, 200);

  const denied = await login(app, 'code-r34-3');
  assert.equal(denied.statusCode, 429);
  const body = denied.json();
  assert.equal(body.error.code, 'RATE_LIMITED');
  assert.equal(body.error.retryable, true);
  assert.equal(body.meta.contract_version, '1.0.0');
  assert.equal(typeof body.meta.request_id, 'string');
  assert.equal(denied.headers['retry-after'], '60');
  assert.equal(denied.headers['x-ratelimit-limit'], '2');
  assert.equal(denied.headers['x-ratelimit-remaining'], '0');
  assert.equal(denied.headers['x-ratelimit-reset'], '60');
  assert.equal(denied.headers['cache-control'], 'no-store');

  // 后台登录与登录共用同一把尺子（`POST /api/v1/admin/auth/*` 也在 IP 规则里）：
  // 上面的额度已被用户登录用完 ⇒ 后台登录同样 429（证明两条路径不是两份额度）。
  const admin = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/session',
    headers: { 'idempotency-key': 'idem-admin-r34' },
    payload: { login_name: 'nobody', password: 'x' },
  });
  assert.equal(admin.statusCode, 429);
});

test('端到端：窗口过期后恢复（注入时钟推进 60s+，无需 sleep）', async (t) => {
  const { app, clock } = newApp(t, { env: { RATE_LIMIT_AUTH_LIMIT: '1' } });

  assert.equal((await login(app, 'code-win-1')).statusCode, 200);
  const denied = await login(app, 'code-win-2');
  assert.equal(denied.statusCode, 429);
  assert.equal(denied.headers['retry-after'], '60', '剩余窗口原样报给客户端');

  clock.advance(60_001);
  const recovered = await login(app, 'code-win-3');
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.headers['x-ratelimit-remaining'], '0');
});

test('端到端：不同 IP 互不影响（同一窗口内 A 超限不影响 B）', async (t) => {
  const { app } = newApp(t, { env: { RATE_LIMIT_AUTH_LIMIT: '1' } });

  assert.equal((await login(app, 'code-ip-a1', '198.51.100.10')).statusCode, 200);
  assert.equal((await login(app, 'code-ip-a2', '198.51.100.10')).statusCode, 429);
  const other = await login(app, 'code-ip-b1', '198.51.100.11');
  assert.equal(other.statusCode, 200);
});

// ---------------------------------------------------------------------------
// 6b. 代理语义端到端：默认忽略 X-Forwarded-For；开了 API_TRUST_PROXY 才生效
//     （用 `app.inject({ remoteAddress, headers })` 造「socket = 网关」的形态，不必真起端口）
// ---------------------------------------------------------------------------

/** 同一条 socket 对端（= 网关地址）、可变的 `X-Forwarded-For`。 */
function viaProxy(app, { code, xff, socket }) {
  return app.inject({
    method: 'POST',
    url: LOGIN_URL,
    headers: { 'idempotency-key': `idem-${code}`, ...(xff === undefined ? {} : { 'x-forwarded-for': xff }) },
    payload: { code },
    remoteAddress: socket,
  });
}

test('端到端：默认不信任代理 ⇒ 换 X-Forwarded-For 不换 socket 仍是同一把桶', async (t) => {
  const { app } = newApp(t, { env: { RATE_LIMIT_AUTH_LIMIT: '2' } });
  const socket = '198.51.100.20';

  assert.equal((await viaProxy(app, { code: 'code-xff-off-1', xff: '203.0.113.1', socket })).statusCode, 200);
  assert.equal((await viaProxy(app, { code: 'code-xff-off-2', xff: '203.0.113.2', socket })).statusCode, 200);
  const denied = await viaProxy(app, { code: 'code-xff-off-3', xff: '203.0.113.3', socket });
  assert.equal(denied.statusCode, 429, '默认口径下 XFF 被忽略：三个不同 XFF 共用 socket 这一把桶');
  assert.equal(denied.headers['x-ratelimit-limit'], '2');
  assert.equal(denied.headers['x-ratelimit-remaining'], '0');
});

test('端到端：API_TRUST_PROXY=true ⇒ X-Forwarded-For 生效，换 XFF 即换桶', async (t) => {
  const { app } = newApp(t, { env: { RATE_LIMIT_AUTH_LIMIT: '1', API_TRUST_PROXY: 'true' } });
  const socket = '198.51.100.21';

  // 两个不同客户端（都经同一网关进来）各拿一份额度。
  assert.equal((await viaProxy(app, { code: 'code-xff-on-a', xff: '203.0.113.11', socket })).statusCode, 200);
  assert.equal((await viaProxy(app, { code: 'code-xff-on-b', xff: '203.0.113.12', socket })).statusCode, 200);
  // 同一个客户端第二次：429（证明额度确实是按 XFF 里那个地址分的，而不是按 socket）。
  const denied = await viaProxy(app, { code: 'code-xff-on-a2', xff: '203.0.113.11', socket });
  assert.equal(denied.statusCode, 429);
  assert.equal(denied.headers['retry-after'], '60');
});

test('端到端：API_TRUST_PROXY=1（跳数）⇒ 只信最近一跳，取 XFF 最右一项', async (t) => {
  const { app } = newApp(t, { env: { RATE_LIMIT_AUTH_LIMIT: '1', API_TRUST_PROXY: '1' } });
  const socket = '198.51.100.22';

  // 最右项（网关观测到的客户端）不同 ⇒ 不同桶。
  assert.equal((await viaProxy(app, { code: 'code-hop-1', xff: '9.9.9.9, 203.0.113.31', socket })).statusCode, 200);
  assert.equal((await viaProxy(app, { code: 'code-hop-2', xff: '9.9.9.9, 203.0.113.32', socket })).statusCode, 200);
  // 只改客户端自带的**最左**一项（伪造项）⇒ 仍是同一把桶，绕不过去。
  // （这正是跳数比 `true` 更抗伪造的地方：`true` 取最左，客户端自带的值会变成 request.ip。）
  const spoofed = await viaProxy(app, { code: 'code-hop-3', xff: '1.1.1.1, 203.0.113.31', socket });
  assert.equal(spoofed.statusCode, 429);
});

test('端到端：写接口按用户计数，且 GET 与豁免路径 /health 永不计数', async (t) => {
  const { app, store } = newApp(t, { env: { RATE_LIMIT_WRITE_LIMIT: '1' } });

  async function account(subject) {
    const user = await store.createUser(subject.repeat(64));
    const token = `synthetic-r34-token-${subject}`;
    await store.createSession({
      userId: user.id,
      tokenHashHex: hashToken(token),
      authEpoch: user.authEpoch,
      expiresAt: new Date(START + 48 * 3_600_000),
      audience: 'user',
    });
    return token;
  }
  const tokenA = await account('a');
  const tokenB = await account('b');

  /** 管理端会话（`hidePost` 需要 `sources:write`）。 */
  async function adminAccount(subject) {
    const adminId = await store.createAdmin({
      loginName: `r34-${subject}-${Math.random().toString(36).slice(2, 8)}`,
      credentialHash: 'synthetic-not-a-real-credential-hash',
      scopes: ['sources:write'],
    });
    const token = `synthetic-r34-admin-token-${subject}`;
    await store.createSession({
      userId: adminId,
      tokenHashHex: hashToken(token),
      authEpoch: 1,
      expiresAt: new Date(START + 48 * 3_600_000),
      audience: 'admin',
    });
    return token;
  }

  async function favorite(token) {
    return app.inject({ method: 'POST', url: FAVORITES, headers: { authorization: `Bearer ${token}` }, payload: FAVORITE_BODY });
  }

  const firstA = await favorite(tokenA);
  assert.notEqual(firstA.statusCode, 429, '第一次写请求不应被限流');
  assert.equal(firstA.headers['x-ratelimit-limit'], '1');
  assert.equal(firstA.headers['x-ratelimit-remaining'], '0');

  const secondA = await favorite(tokenA);
  assert.equal(secondA.statusCode, 429);
  assert.equal(secondA.json().error.code, 'RATE_LIMITED');

  const firstB = await favorite(tokenB);
  assert.notEqual(firstB.statusCode, 429, '另一个用户有独立额度');

  // 真实管理端写路由（`POST /api/v1/admin/posts/:id/hide`，`OPS_SCOPES.hidePost`）走同一条链：
  // 先跑守卫、再计数 ⇒ **业务 404 也照样消耗额度**，同一管理员第二次直接 429。
  // 早先只有假守卫的对照，断言落不到真实路由上；这条把端到端补齐（审查者曾用探针验证该序列）。
  const adminToken = await adminAccount('h');
  const postId = randomUUID();
  let hideSeq = 0;
  const hide = () =>
    app.inject({
      method: 'POST',
      url: `/api/v1/admin/posts/${postId}/hide`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        'if-match': '"1"',
        'idempotency-key': `idem-r34-hide-${(hideSeq += 1)}`,
      },
      // 契约要求 `reason`（缺了是 400，测不到限流），`If-Match` 是管理端写请求的必备头（缺了 428）。
      payload: { reason: '限流端到端：失败响应也计数' },
    });

  const firstHide = await hide();
  assert.equal(firstHide.statusCode, 404, `未知帖子按社区 CAS 语义如实回答不存在（响应：${firstHide.body}）`);
  assert.equal(firstHide.headers['x-ratelimit-limit'], '1');
  assert.equal(firstHide.headers['x-ratelimit-remaining'], '0', '失败的写请求也计了数');
  const secondHide = await hide();
  assert.equal(secondHide.statusCode, 429);
  assert.equal(secondHide.json().error.code, 'RATE_LIMITED');

  // GET 不在写规则里：连打 5 次都不产生 429 / 也不带头。
  for (let i = 0; i < 5; i += 1) {
    const read = await app.inject({ method: 'GET', url: FAVORITES, headers: { authorization: `Bearer ${tokenA}` } });
    assert.notEqual(read.statusCode, 429);
    assert.equal(read.headers['x-ratelimit-limit'], undefined);
  }

  // 豁免路径：/health 连打 5 次都是 200。
  for (let i = 0; i < 5; i += 1) {
    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
  }
});
