import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { ApiError } from '../../services/api/src/errors.ts';

const stubConfig = () => loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

test('真实产品登录 HTTP：同键请求仍在处理返回 409 和 Retry-After，完成后重放不重复交换/建会话', { timeout: 10000 }, async t => {
  const entered = gate(), finish = gate();
  let calls = 0, sessionWrites = 0;
  const memory = createMemoryAuthStore();
  const store = {
    ...memory,
    async createSession(input) { sessionWrites++; return memory.createSession(input); },
  };
  const app = buildApp({
    config: stubConfig(), store,
    wechat: {
      async exchange() {
        calls++;
        entered.release();
        await finish.promise;
        return { subjectLookupHex: createHash('sha256').update('synthetic-retry-after-user').digest('hex') };
      },
    },
  });
  let first;
  t.after(async () => {
    finish.release();
    await first?.catch(() => {});
    await app.close();
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = (code = 'synthetic-code', key = 'retry-after-synthetic-key') => fetch(base + '/api/v1/auth/wechat', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ code }),
  });
  first = login();
  await entered.promise;
  const waiting = await login();
  const error = await waiting.json();
  assert.equal(waiting.status, 409);
  assert.equal(error.error.code, 'REQUEST_IN_PROGRESS');
  assert.equal(waiting.headers.get('retry-after'), '1');
  assert.equal(error.error.retryable, true);
  assert.equal(error.meta.execution_mode, 'stub');
  assert.equal(error.meta.contract_version, '1.0.0');
  assert.ok(error.meta.request_id);
  assert.equal(calls, 1);
  assert.equal(sessionWrites, 0, '等待者不创建会话');

  finish.release();
  const completed = await first;
  const original = await completed.json();
  assert.equal(completed.status, 200);
  assert.equal(completed.headers.get('retry-after'), null);
  assert.ok(original.data.access_token, '产品 Session 返回合成会话令牌');
  const replay = await login();
  const replayed = await replay.json();
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('retry-after'), null);
  assert.equal(replayed.data.expires_at, original.data.expires_at, '重放保持首次会话的绝对时效');
  assert.notEqual(replayed.data.access_token, original.data.access_token, '重放换发同一会话的令牌');
  assert.equal(calls, 1, '原键重试不再次交换身份');
  assert.equal(sessionWrites, 1, '原键重放不新建会话');

  const conflict = await login('different-synthetic-code');
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(conflict.headers.get('retry-after'), null, '不同内容冲突不得被标为处理中重试');
  const invalid = await login('synthetic-code', 'short');
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal(invalid.headers.get('retry-after'), null);
  const denied = await fetch(base + '/api/v1/auth/session');
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error.code, 'SESSION_REQUIRED');
  assert.equal(denied.headers.get('retry-after'), null);
});

// 2026-10-22 依 `docs/architecture/state-contract.md:27`（429 带 Retry-After）与 `:34`（处理中 409
// `REQUEST_IN_PROGRESS` 带 Retry-After）补齐：等待头由统一出口对这两类下发，其余错误码（含 503/504）
// 不带。原用例只覆盖 `REQUEST_IN_PROGRESS`，这里补上 429 的两个错误码，并把「仅」的范围写准。
test('统一错误出口只为 REQUEST_IN_PROGRESS 与 429 加等待头，保持错误码/封套/重试标记与其他错误行为', async t => {
  const app = buildApp({ config: stubConfig() });
  t.after(() => app.close());
  app.get('/test-error/:code', async request => {
    throw new ApiError(request.params.code, 'synthetic error', { details: [{ field: 'fixture', code: 'synthetic' }] });
  });
  for (const [code, status] of [
    ['REQUEST_IN_PROGRESS', 409], ['IDEMPOTENCY_CONFLICT', 409], ['REVISION_CONFLICT', 409],
    ['OBJECT_UNAVAILABLE', 409], ['PROVIDER_UNAVAILABLE', 503], ['PROVIDER_TIMEOUT', 504],
    ['RATE_LIMITED', 429], ['PROVIDER_QUOTA_EXCEEDED', 429],
  ]) {
    const response = await app.inject({ method: 'GET', url: '/test-error/' + code });
    assert.equal(response.statusCode, status, code);
    assert.equal(response.headers['retry-after'], code === 'REQUEST_IN_PROGRESS' || status === 429 ? '1' : undefined, code);
    const body = response.json();
    assert.equal(body.error.code, code);
    assert.equal(body.error.message, 'synthetic error');
    assert.equal(body.error.retryable, false, '本次不改变领域层的重试标记');
    assert.deepEqual(body.error.details, [{ field: 'fixture', code: 'synthetic' }]);
    assert.deepEqual(Object.keys(body).sort(), ['error', 'meta']);
    assert.deepEqual(Object.keys(body.error).sort(), ['code', 'details', 'message', 'retryable']);
    assert.equal(body.meta.execution_mode, 'stub');
    assert.equal(body.meta.contract_version, '1.0.0');
  }
});
