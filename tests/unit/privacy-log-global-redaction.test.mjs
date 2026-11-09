// 全局日志脱敏（pino `formatters.log`）的回归证据。
//
// 背景：pino 10.x 的 `formatters.log` 在 `serializers` **之前**运行。Fastify 请求日志把
// 原始 `Request`/`Reply` 实例塞进日志对象，而它们的 method/url/ip/statusCode 是 prototype
// getter；若 formatter 用 `Object.entries()` 重建对象，这些字段会整层丢失，`serializers.req`
// 只能拿到 `{}`。本文件用真实 `buildApp` + 内存日志流同时钉住两件事：
//   1. 全局 formatter 真的脱敏（键名 + 值形态双层）；
//   2. 类实例原样透传，请求日志仍有 method/url/statusCode（正向对照）。
//
// 每条用例都有下界守卫：先确认 `app.log` 确实写进了注入的日志流，再断言脱敏；
// 不允许「一条日志都没抓到所以没泄漏」的假绿。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';

function memoryLog() {
  const chunks = [];
  return {
    chunks,
    stream: { write(chunk) { chunks.push(chunk); } },
    text() { return chunks.join(''); },
  };
}

/** 起一个只挂内存日志流的 stub 应用（不连 PG、不调外部供应商）。 */
function makeApp(t) {
  const log = memoryLog();
  const app = buildApp({
    config: loadConfig({
      APP_EXECUTION_MODE: 'stub',
      LOG_LEVEL: 'info',
      SESSION_SIGNING_KEY: 'synthetic-privacy-log-global-redaction-signing-key-0123456789',
    }),
    logStream: log.stream,
  });
  t.after(async () => {
    await app.close();
  });
  return { app, log };
}

/**
 * 下界守卫：确认 `app.log` 确实可写、且写入的是本用例注入的日志流。
 * 先跑它再断言脱敏，避免「没抓到日志」被误当成「没有泄漏」。
 */
function assertLogWritable(app, log, label) {
  const before = log.chunks.length;
  const marker = `log-stream-writable:${label}`;
  app.log.info({ marker }, 'log stream guard');
  assert.ok(log.chunks.length > before, `${label}：app.log 未写入注入的 logStream`);
  assert.equal(log.text().includes(marker), true, `${label}：日志流里没有刚写入的下界探针`);
}

function assertNoSentinels(text, sentinels, label) {
  for (const sentinel of sentinels) {
    assert.equal(text.includes(sentinel), false, `${label} 出现哨兵原文：${sentinel}`);
  }
}

test('全局日志脱敏·1：探针载荷的私有正文/凭据/图片不落日志', async t => {
  const { app, log } = makeApp(t);
  assertLogWritable(app, log, 'probe');

  const sentinels = ['SENTINEL_BODY_7f3a', 'SENTINEL_TOKEN_9f3a', 'SENTINELB64PAYLOAD'];
  const before = log.chunks.length;
  app.log.info(
    {
      body: 'SENTINEL_BODY_7f3a',
      headers: { authorization: 'Bearer SENTINEL_TOKEN_9f3a' },
      image: 'data:image/png;base64,SENTINELB64PAYLOAD',
    },
    'probe',
  );
  assert.ok(log.chunks.length > before, '探针日志未写入 logStream');
  const text = log.text();
  assert.ok(log.chunks.length >= 1, '下界：日志行数必须 ≥ 1');

  assertNoSentinels(text, sentinels, '探针日志');
  assert.equal(text.includes('"body":"[REDACTED]"'), true, '敏感键 body 必须整值替换');
  assert.equal(text.includes('"authorization":"[REDACTED]"'), true, '嵌套敏感键 authorization 必须整值替换');
  assert.equal(text.includes('"image":"[REDACTED]"'), true, '敏感键 image 必须整值替换');
  assert.equal(text.includes('[REDACTED]'), true, '日志行必须出现 [REDACTED]');
});

test('全局日志脱敏·2：正向对照——请求日志仍有 method/url/statusCode，req/res 不被清空', async t => {
  const { app, log } = makeApp(t);
  assertLogWritable(app, log, 'request');

  const response = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 200, response.body);

  const text = log.text();
  assert.ok(log.chunks.length >= 1, '下界：请求日志行数必须 ≥ 1');
  assert.equal(text.includes('"msg":"incoming request"'), true, '正向对照失败：缺 incoming request');
  assert.equal(text.includes('"msg":"request completed"'), true, '正向对照失败：缺 request completed');
  assert.equal(text.includes('"method":"GET"'), true, '正向对照失败：请求日志丢 method（类实例被重建）');
  assert.equal(text.includes('"url":"/health"'), true, '正向对照失败：请求日志丢 url（类实例被重建）');
  assert.equal(text.includes('"statusCode":200'), true, '正向对照失败：请求日志丢 statusCode（类实例被重建）');
  assert.equal(text.includes('"req":{}'), false, '正向对照失败：req 被清空成 {}');
  assert.equal(text.includes('"res":{}'), false, '正向对照失败：res 被清空成 {}');
  assert.equal(text.includes('"req":{"method":"GET"'), true, 'req 序列化后必须从 method 开始');
});

test('全局日志脱敏·3：嵌套对象与数组里的正文/坐标不落日志', async t => {
  const { app, log } = makeApp(t);
  assertLogWritable(app, log, 'nested');

  const before = log.chunks.length;
  app.log.info(
    {
      outer: {
        inner: [
          { text: 'SENTINEL_NESTED' },
          { lat: 30.123456, lng: 120.654321 },
        ],
      },
    },
    'nested',
  );
  assert.ok(log.chunks.length > before, '嵌套探针日志未写入 logStream');
  const text = log.text();
  assert.ok(log.chunks.length >= 1, '下界：日志行数必须 ≥ 1');

  assertNoSentinels(text, ['SENTINEL_NESTED', '30.123456', '120.654321'], '嵌套日志');
  assert.equal(text.includes('"lat":"[REDACTED]"'), true, '数组里的 lat 必须整值替换');
  assert.equal(text.includes('"lng":"[REDACTED]"'), true, '数组里的 lng 必须整值替换');
  assert.equal(text.includes('[REDACTED]'), true, '日志行必须出现 [REDACTED]');
});

test('全局日志脱敏·4：超过深度上限的最内层哨兵被替换为 [DEPTH]', async t => {
  const { app, log } = makeApp(t);
  assertLogWritable(app, log, 'depth');

  const deep = {
    l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: { l9: { l10: 'SENTINEL_DEEP' } } } } } } } } },
  };
  const before = log.chunks.length;
  app.log.info({ deep }, 'depth');
  assert.ok(log.chunks.length > before, '深度探针日志未写入 logStream');
  const text = log.text();
  assert.ok(log.chunks.length >= 1, '下界：日志行数必须 ≥ 1');

  assertNoSentinels(text, ['SENTINEL_DEEP'], '深度日志');
  assert.equal(text.includes('[DEPTH]'), true, '超过深度上限必须出现 [DEPTH]');
});

test('全局日志脱敏·5：Error/Date 类实例原样透传，err 仍由 pino 序列化', async t => {
  const { app, log } = makeApp(t);
  assertLogWritable(app, log, 'class-instances');

  const before = log.chunks.length;
  assert.doesNotThrow(() => {
    app.log.info({ err: new Error('boom'), when: new Date(0) }, 'class instances');
  }, '类实例透传不得抛错');
  assert.ok(log.chunks.length > before, '类实例探针日志未写入 logStream');
  const text = log.text();
  assert.ok(log.chunks.length >= 1, '下界：日志行数必须 ≥ 1');

  assert.equal(text.includes('"message":"boom"'), true, 'err 必须仍被 pino 的 err 序列化出 message');
  assert.equal(text.includes('"type":"Error"'), true, 'err 必须仍被 pino 的 err 序列化出 type');
  assert.equal(text.includes('"stack"'), true, 'err 必须仍被 pino 的 err 序列化出 stack');
  assert.equal(text.includes('"when":"1970-01-01T00:00:00.000Z"'), true, 'Date 实例必须原样交给序列化');
});

test('全局日志脱敏·6：Error.message/stack 内嵌凭据不落日志（两种打点形状）', async t => {
  const { app, log } = makeApp(t);
  assertLogWritable(app, log, 'err-credentials');

  // 监工给的负控制原文：非法原点被放进 MediaRealWiringError 的那类消息。
  const err = new TypeError('AccessGrant 网关原点不得内嵌凭据：https://user:SECRET_PASS@example.com');

  // 两种真实打点形状，都走真正的 `request.log`（app.ts:2742 的 { err } 形状 + pino 把首个 Error 参数
  // 放进 err、并把 err.message 抄进 msg 的形状）。
  app.get('/__privacy-log/err-object', async (request) => {
    request.log.error({ err }, 'unhandled error');
    return { ok: true };
  });
  app.get('/__privacy-log/err-arg', async (request) => {
    request.log.error(err);
    return { ok: true };
  });

  const before = log.chunks.length;
  for (const url of ['/__privacy-log/err-object', '/__privacy-log/err-arg']) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200, `${url} 应命中探针路由：${response.body}`);
  }
  assert.ok(log.chunks.length > before, 'Error 探针日志未写入 logStream');

  const text = log.text();
  assert.ok(log.chunks.length >= 1, '下界：日志行数必须 ≥ 1');
  assert.equal(text.includes('SECRET_PASS'), false, 'Error.message/stack 的凭据泄漏到日志');
  assert.equal(text.includes('[REDACTED]'), true, 'Error 日志必须出现 [REDACTED]');
  assert.equal(text.includes('"type":"TypeError"'), true, 'err 序列化必须保留 type');
  assert.equal(text.includes('"message"'), true, 'err 序列化必须保留 message 键（不是把整个错误丢了）');
  assert.equal(text.includes('"stack"'), true, 'err 序列化必须保留 stack 键（不是把整个错误丢了）');
  assert.equal(text.includes('"msg":"unhandled error"'), true, '下界：{ err } 形状没有写入 unhandled error');
  assert.equal(text.includes('AccessGrant 网关原点不得内嵌凭据：https://[REDACTED]@example.com'), true, '凭据段应被就地擦除');
  assert.equal(
    (text.match(/"type":"TypeError"/g) ?? []).length,
    2,
    '下界：两种打点形状必须各写出一条 TypeError（只写一条说明另一种没被覆盖）',
  );
  assert.equal(
    (text.match(/"stack"/g) ?? []).length,
    2,
    '下界：两种打点形状的 stack 都必须保留',
  );
});

test('全局日志脱敏·7：err.cause 链里的凭据同样不落日志', async t => {
  const { app, log } = makeApp(t);
  assertLogWritable(app, log, 'err-cause');

  const err = new Error('outer', { cause: new Error('https://u:SECRET_CAUSE@example.com') });
  const before = log.chunks.length;
  app.log.error({ err }, 'cause probe');
  assert.ok(log.chunks.length > before, 'cause 探针日志未写入 logStream');

  const text = log.text();
  assert.ok(log.chunks.length >= 1, '下界：日志行数必须 ≥ 1');
  assert.equal(text.includes('SECRET_CAUSE'), false, 'err.cause 里的凭据泄漏到日志');
  assert.equal(text.includes('"cause"'), true, '下界：cause 必须挂在序列化结果上（不是整条丢了）');
  assert.equal(text.includes('"type":"Error"'), true, '外层 err 序列化必须保留 type');
  assert.equal(text.includes('https://[REDACTED]@example.com'), true, 'cause 的凭据段应被就地擦除');
});

test('全局日志脱敏·8：普通字段里的 URL 内嵌凭据只擦 userinfo，保留 host', async t => {
  const { app, log } = makeApp(t);
  assertLogWritable(app, log, 'url-userinfo');

  const before = log.chunks.length;
  app.log.info({ url: 'https://user:SECRET_URL@example.com/path' }, 'origin probe');
  assert.ok(log.chunks.length > before, 'URL 凭据探针日志未写入 logStream');

  const text = log.text();
  assert.ok(log.chunks.length >= 1, '下界：日志行数必须 ≥ 1');
  assert.equal(text.includes('SECRET_URL'), false, '普通字段 url 里的内嵌凭据泄漏到日志');
  assert.equal(text.includes('example.com'), true, '脱敏不得把整条 URL 清掉（host 用于排障）');
  assert.equal(text.includes('https://[REDACTED]@example.com/path'), true, '只应擦除 user:password@ 段');
});
