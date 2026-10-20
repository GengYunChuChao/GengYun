/**
 * GY-I23 · 本机时延／容量取证：**HTTP 边界**计时与连接复用工具。
 *
 * ## 为什么单独一层
 * `tools/perf/` 下两个驱动脚本（`latency-sample.mjs`／`load-50vu.mjs`）都要用**同一种**
 * 计时口径与同一种连接语义，否则两条读数不可比。口径与证据页 §4.2 逐字一致：
 *
 * - 计时钟：`process.hrtime.bigint()`，取样点在**客户端 HTTP 边界**——
 *   起点＝请求即将写出，终点＝响应体**读完后**的 `'end'` 事件；
 * - 服务端 `responseTime` 在本机栈**不可得**（`tools/local-dev/api.mjs` 传 `LOG_LEVEL='silent'`），
 *   因此一切时延只认客户端 HTTP 边界，**不得**用 `app.inject()` 进程内计时冒充（规格书 §5 第 6 条）；
 * - 连接类别：`cold`＝每次一个一次性连接（`agent: false`，不复用）；`hot`＝keep-alive
 *   复用同一连接（同一 `Agent`）。两组**分开算分位数**，⛔ 不得合并成一条 p95；
 * - 响应体：默认只**计数**字节数（不落字符串），避免把客户端字符串拼接的成本算进服务端时延；
 *   需要正文时（登录、读 ETag）显式 `capture: true`。
 *
 * 本文件**零网络副作用**：只导出函数，不在模块加载时发请求。
 */
import http from 'node:http';
import https from 'node:https';

/** 高精度毫秒（浮点）：仅用于「起点快照」，区间差值一律用 `hrtime` 相减。 */
export function hrtimeMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

/** keep-alive 连接池（`hot` 组用；`maxSockets` 由调用方按并发度给，缺省 64）。 */
export function createKeepAliveAgent({ maxSockets = 64, maxFreeSockets = 64 } = {}) {
  return new http.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets, maxFreeSockets });
}

/**
 * 一次带计时的 HTTP 请求。
 *
 * 返回值恒为对象（**不抛错**），失败以 `status: 0` + `error` 表达，便于把「未取得」的样本
 * 逐条计入 `dropped`／`drop_reasons`，而不是静默剔除（规格书 §4.2）。
 */
export async function timedRequest({
  baseUrl,
  path,
  method = 'GET',
  headers = {},
  body,
  agent,
  timeoutMs = 10000,
  capture = false,
}) {
  const url = new URL(path, baseUrl);
  const transport = url.protocol === 'https:' ? https : http;
  const startedAt = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - startedAt) / 1e6;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let request;
    try {
      request = transport.request(
        {
          host: url.hostname,
          port: url.port === '' ? undefined : url.port,
          path: url.pathname + url.search,
          method,
          headers,
          // `false` ⇒ 一次性连接（cold）；对象 ⇒ 复用连接（hot）；`undefined` ⇒ 全局 agent。
          agent,
        },
        (response) => {
          let bytes = 0;
          const chunks = capture ? [] : null;
          response.on('data', (chunk) => {
            bytes += chunk.length;
            if (chunks !== null) chunks.push(chunk);
          });
          response.on('end', () =>
            finish({
              status: response.statusCode,
              headers: response.headers,
              bytes,
              elapsedMs: elapsed(),
              text: chunks === null ? undefined : Buffer.concat(chunks).toString('utf8'),
            }),
          );
          response.on('aborted', () =>
            finish({ status: 0, error: 'RESPONSE_ABORTED', bytes, elapsedMs: elapsed() }),
          );
          response.on('error', (error) =>
            finish({ status: 0, error: 'RESPONSE_ERROR: ' + error.message, bytes, elapsedMs: elapsed() }),
          );
        },
      );
    } catch (error) {
      finish({ status: 0, error: 'REQUEST_CONSTRUCTION_FAILED: ' + error.message, elapsedMs: elapsed() });
      return;
    }
    request.setTimeout(timeoutMs, () => {
      const error = new Error('client timeout after ' + timeoutMs + ' ms');
      error.code = 'CLIENT_TIMEOUT';
      request.destroy(error);
    });
    request.on('error', (error) =>
      finish({
        status: 0,
        error: (error.code === 'CLIENT_TIMEOUT' ? 'CLIENT_TIMEOUT' : error.code ?? 'REQUEST_ERROR') + ': ' + error.message,
        elapsedMs: elapsed(),
      }),
    );
    if (body !== undefined && body !== null) request.write(body);
    request.end();
  });
}

/** 安全 JSON 解析（失败返回 `null`；调用方负责把它记成一条丢弃原因）。 */
export function parseJson(text) {
  if (typeof text !== 'string' || text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 合成微信身份登录（`stub` 执行模式）：`POST /api/v1/auth/wechat` 换会话。
 *
 * 幂等键每个登录各取唯一值：同键异体会被判 `IDEMPOTENCY_CONFLICT`，而这里要的是
 * **多个不同用户**（每个虚拟用户一条独立身份，避免 50 个 VU 抢同一条 profile 的版本号）。
 */
export async function loginStub({ baseUrl, code, idempotencyKey, timeoutMs = 10000 }) {
  const result = await timedRequest({
    baseUrl,
    path: '/api/v1/auth/wechat',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify({ code }),
    timeoutMs,
    capture: true,
  });
  const parsed = parseJson(result.text);
  const token = parsed?.data?.access_token;
  return {
    ok: result.status === 200 && typeof token === 'string' && token !== '',
    status: result.status,
    elapsedMs: result.elapsedMs,
    token: typeof token === 'string' ? token : null,
    error: result.error,
  };
}

/** 可复现的确定性 PRNG（mulberry32）：同一 `--seed` 出同一请求序列。 */
export function createSeededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
