import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../services/api/src/config.ts';
import { buildApp } from '../../services/api/src/app.ts';

/** 带一个声明 JSON body schema 的 POST 路由，确保内容类型解析器确定性执行。 */
function appWithProbe() {
  const app = buildApp({ config: loadConfig({ APP_EXECUTION_MODE: 'stub' }) });
  app.post('/probe', { schema: { body: { type: 'object' } } }, async () => ({ ok: true }));
  return app;
}

test('不完整 JSON 请求体返回 400 INVALID_REQUEST（不落入 500 缺口）', async () => {
  const app = appWithProbe();
  const res = await app.inject({
    method: 'POST',
    url: '/probe',
    headers: { 'content-type': 'application/json' },
    payload: '{"a":',
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.error.code, 'INVALID_REQUEST');
  assert.equal(body.error.retryable, false);
  assert.equal(body.meta.contract_version, '1.0.0');
  assert.equal(body.meta.execution_mode, 'stub');
  assert.equal(body.contract_gap, undefined);
  await app.close();
});

test('超过默认 1MiB 的 JSON 返回 413 MEDIA_TOO_LARGE', async () => {
  const app = appWithProbe();
  const res = await app.inject({
    method: 'POST',
    url: '/probe',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ data: 'x'.repeat(1200 * 1024) }),
  });
  assert.equal(res.statusCode, 413);
  const body = res.json();
  assert.equal(body.error.code, 'MEDIA_TOO_LARGE');
  assert.equal(body.meta.contract_version, '1.0.0');
  assert.equal(body.contract_gap, undefined);
  await app.close();
});

test('方法不匹配的路径上不完整 JSON 同样返回 400（解析先于路由）', async () => {
  const app = buildApp({ config: loadConfig({ APP_EXECUTION_MODE: 'stub' }) });
  const res = await app.inject({
    method: 'POST',
    url: '/health',
    headers: { 'content-type': 'application/json' },
    payload: '{"a":',
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'INVALID_REQUEST');
  await app.close();
});
