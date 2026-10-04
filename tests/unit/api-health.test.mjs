import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../services/api/src/config.ts';
import { buildApp } from '../../services/api/src/app.ts';

/** 构造 real 模式配置（绕过环境加载，用于验证健康检查不假记）。 */
function realConfig() {
  return {
    executionMode: 'real',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    databaseUrl: null,
    databaseHealthTimeoutMs: 500,
    requiresRealCredentials: true,
  };
}

test('/health 在 stub 模式如实报告数据库未配置（不假记连接成功）', async () => {
  const app = buildApp({ config: loadConfig({ APP_EXECUTION_MODE: 'stub' }) });
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.checks.api.status, 'ok');
  assert.equal(body.checks.database.configured, false);
  assert.equal(body.checks.database.status, 'not_configured');
  assert.equal(body.meta.contract_version, '1.0.0');
  assert.equal(body.meta.execution_mode, 'stub');
  assert.match(body.meta.request_id, /^[0-9a-f-]{36}$/);
  await app.close();
});

test('/health 在 real 模式数据库不可达时返回 503 degraded，不假装 ok', async () => {
  const failingPool = {
    async query() {
      const error = new Error('connection refused');
      error.code = 'ECONNREFUSED';
      throw error;
    },
  };
  const app = buildApp({ config: realConfig(), pool: failingPool });
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 503);
  const body = res.json();
  assert.equal(body.status, 'degraded');
  assert.equal(body.checks.database.status, 'error');
  assert.equal(body.checks.database.code, 'ECONNREFUSED');
  await app.close();
});

test('/health 在 real 模式下未配置数据库视为降级（503）', async () => {
  const app = buildApp({ config: realConfig(), pool: null });
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().checks.database.status, 'not_configured');
  await app.close();
});

test('/health 在数据库可达时返回 ok', async () => {
  const okPool = { async query() { return { rows: [{ '?column?': 1 }] }; } };
  const app = buildApp({ config: realConfig(), pool: okPool });
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().checks.database.status, 'ok');
  await app.close();
});

test('未知路径返回契约 NOT_FOUND 错误封套', async () => {
  const app = buildApp({ config: loadConfig({ APP_EXECUTION_MODE: 'stub' }) });
  const res = await app.inject({ method: 'GET', url: '/api/v1/not-implemented' });
  assert.equal(res.statusCode, 404);
  const body = res.json();
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.equal(body.error.retryable, false);
  assert.deepEqual(body.error.details, []);
  assert.equal(body.meta.contract_version, '1.0.0');
  assert.equal(body.meta.execution_mode, 'stub');
  await app.close();
});
