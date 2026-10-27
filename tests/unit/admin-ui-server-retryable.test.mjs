/**
 * 用例：账号目录读面与停用写面**必须听服务端的 `retryable`**（R67-B04）。
 *
 * 审计缺陷（R67-B04）：
 *  - `apps/admin/src/lib/admin-api.mjs` 的 `isRetriable(kind)` 是本地闭集，
 *    `failure()` 直接 `retriable: isRetriable(kind)`，且 5xx 一律落成 `unavailable`
 *    ⇒ **503 恒可重试**，不管服务端在错误体里写没写 `retryable:false`；
 *  - `apps/admin/src/lib/account-suspend-api.mjs` 读了 `retry-after` 头，却没读 `envelope.retryable`；
 *  - `apps/admin/src/lib/view-model.mjs` 的 `canRetry` 只信本地 `retriable`。
 * 结果：服务端说「别重试」时，账号目录与停用横幅仍然承诺「稍后重试」。
 *
 * 断言口径（逐条对应派单要求）：
 *  - 服务端**显式** `retryable:false` ⇒ 不给重试（`serverRetryable === false`、`retriable === false`、
 *    文案不承诺「稍后重试」、给出人工处理指引）；
 *  - 服务端**显式** `retryable:true` ⇒ 给重试（非空对照）；
 *  - 服务端**没写**（`null`）⇒ 退化为既有本地闭集口径（向后兼容，既有断言不动）；
 *  - `serverAllowsRetry` **只许一处定义**（`admin-api.mjs`），其余面再导出/引用同一个函数对象。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import * as adminApi from '../../apps/admin/src/lib/admin-api.mjs';
import * as jobsApi from '../../apps/admin/src/lib/jobs-api.mjs';
import * as suspendApi from '../../apps/admin/src/lib/account-suspend-api.mjs';
import { describe, describeSuspendFailure } from '../../apps/admin/src/lib/view-model.mjs';

const BASE = '/api/v1';
const TOKEN = 'synthetic-admin-token';
const ACCOUNT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function jsonResponse(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body };
}

function fake(handler) {
  const calls = [];
  return {
    calls,
    impl: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    },
  };
}

const suspendBase = () => ({
  baseUrl: BASE,
  token: TOKEN,
  id: ACCOUNT_ID,
  revision: 3,
  reason: '账号疑似被盗用，先停用',
  idempotencyKey: suspendApi.newIdempotencyKey(),
});

const listAccounts = (handler) => adminApi.fetchAccountsPage({ fetchImpl: fake(handler).impl, baseUrl: BASE, token: TOKEN });

const suspendWith = (handler) => suspendApi.suspendAccount({ ...suspendBase(), fetchImpl: fake(handler).impl });

test('fetchAccountsPage: 503 + retryable:false ⇒ 不可重试，文案不承诺「稍后重试」', async () => {
  const result = await listAccounts(() =>
    jsonResponse(503, { error: { code: 'PROVIDER_UNAVAILABLE', message: 'real 模式未接真实持久后端', retryable: false } }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'unavailable');
  assert.equal(result.serverRetryable, false, '服务端显式 retryable:false 必须落到 serverRetryable');
  assert.equal(result.retriable, false, 'retryable:false 时本地不得再说可重试');

  const view = adminApi.describeFailure(result);
  assert.equal(view.retriable, false, 'describeFailure 也不得承诺可重试');
  assert.equal(view.action, 'none', '不可自动重试 ⇒ 不给 retry/restart 动作');
  assert.match(view.detail, /retryable=false/, '必须写明是服务端声明不可重试');
  assert.doesNotMatch(view.detail, /稍后重试/, 'retryable:false 时不得承诺「稍后重试」');
  assert.match(view.detail, /人工|手动|后端状态/, '必须给出人工处理指引');
});

test('fetchAccountsPage: 503 + retryable:true ⇒ 仍可重试（非空对照）', async () => {
  const result = await listAccounts(() =>
    jsonResponse(503, { error: { code: 'SERVICE_UNAVAILABLE', message: '维护中', retryable: true } }),
  );
  assert.equal(result.kind, 'unavailable');
  assert.equal(result.serverRetryable, true);
  assert.equal(result.retriable, true, '服务端显式 retryable:true 时保留可重试');

  const view = adminApi.describeFailure(result);
  assert.equal(view.retriable, true);
  assert.equal(view.action, 'retry');
  assert.match(view.detail, /稍后重试/);
});

test('fetchAccountsPage: 503 但错误体没写 retryable ⇒ 退化为本地闭集（向后兼容）', async () => {
  const result = await listAccounts(() => jsonResponse(503, { error: { code: 'PROVIDER_UNAVAILABLE' } }));
  assert.equal(result.kind, 'unavailable');
  assert.equal(result.serverRetryable, null, '「没写」必须与「显式 false」区分开');
  assert.equal(result.retriable, true, '没写 ⇒ 保持既有本地闭集口径');
});

test('fetchAccountsPage: 网络错误（fetch 抛）⇒ serverRetryable 为 null，仍按本地闭集可重试', async () => {
  const result = await listAccounts(() => {
    throw new TypeError('fetch failed');
  });
  assert.equal(result.kind, 'network_error');
  assert.equal(result.serverRetryable, null);
  assert.equal(result.retriable, true);
});

test('suspendAccount: 503 + retryable:false ⇒ 停用横幅不给重试，改为人工处理指引', async () => {
  const result = await suspendWith(() =>
    jsonResponse(503, { error: { code: 'PROVIDER_UNAVAILABLE', message: '停用端口未接线', retryable: false } }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'unavailable');
  assert.equal(result.serverRetryable, false);
  assert.equal(result.retriable, false);

  const view = describeSuspendFailure(result);
  assert.equal(view.retriable, false, '停用横幅不得再给「用同一幂等键重试」');
  assert.equal(view.action, 'reload', '改为「重新读取」确认当前状态');
  assert.match(view.detail, /retryable=false/);
  assert.doesNotMatch(view.detail, /稍后重试/);
});

test('suspendAccount: 409 REQUEST_IN_PROGRESS + retryable:false ⇒ in_progress 也不给重试', async () => {
  const result = await suspendWith(() =>
    jsonResponse(409, { error: { code: 'REQUEST_IN_PROGRESS', message: '同一键在飞', retryable: false } }),
  );
  assert.equal(result.kind, 'in_progress');
  assert.equal(result.serverRetryable, false);
  assert.equal(result.retriable, false);

  const view = describeSuspendFailure(result);
  assert.equal(view.retriable, false);
  assert.notEqual(view.action, 'retry');
  assert.doesNotMatch(view.detail, /稍后/);
});

test('suspendAccount: 503 但错误体没写 retryable ⇒ 保持既有 in_progress/unavailable 口径', async () => {
  const result = await suspendWith(() => jsonResponse(503, { error: { code: 'PROVIDER_UNAVAILABLE' } }));
  assert.equal(result.serverRetryable, null);
  assert.equal(result.retriable, true);
  const view = describeSuspendFailure(result);
  assert.equal(view.retriable, true);
  assert.equal(view.action, 'retry');
});

test('describe(state)：账号目录列表侧 canRetry 也听 serverRetryable', () => {
  const blocked = describe({
    phase: 'error',
    failure: { ok: false, kind: 'unavailable', status: 503, retriable: true, serverRetryable: false },
  });
  assert.equal(blocked.canRetry, false, '服务端显式 retryable:false ⇒ 列表侧不给重试');
  assert.doesNotMatch(blocked.detail, /稍后重试/);

  const allowed = describe({
    phase: 'error',
    failure: { ok: false, kind: 'unavailable', status: 503, retriable: true, serverRetryable: true },
  });
  assert.equal(allowed.canRetry, true, '显式 retryable:true ⇒ 列表侧仍可重试');
});

test('serverAllowsRetry 真值表：显式布尔优先，没写才回落本地闭集', () => {
  assert.equal(typeof adminApi.serverAllowsRetry, 'function', 'admin-api.mjs 必须是唯一判据的所在地');
  const allows = adminApi.serverAllowsRetry;

  assert.equal(allows({ kind: 'unavailable', serverRetryable: false }), false, '显式 false 压过本地闭集');
  assert.equal(allows({ kind: 'rate_limited', serverRetryable: false }), false);
  assert.equal(allows({ kind: 'network_error', serverRetryable: false }), false);
  assert.equal(allows({ kind: 'forbidden', serverRetryable: true }), true, '显式 true 压过本地闭集');
  assert.equal(allows({ kind: 'unavailable', serverRetryable: null }), true, '没写 ⇒ 本地闭集');
  assert.equal(allows({ kind: 'rate_limited', serverRetryable: null }), true);
  assert.equal(allows({ kind: 'forbidden', serverRetryable: null }), false);
  assert.equal(allows({ kind: 'signed_out' }), false);
  assert.equal(allows(null), false);
  // 已经算过的 `retriable` 也要能被采信（消费侧传入的是 failure 结果对象）。
  assert.equal(allows({ kind: 'unavailable', retriable: false }), false);
  assert.equal(allows({ kind: 'forbidden', retriable: true }), true);
});

test('serverAllowsRetry 只有一处定义：jobs-api 只是再导出同一个函数对象', () => {
  const libDir = fileURLToPath(new URL('../../apps/admin/src/lib/', import.meta.url));
  const hits = [];
  for (const name of readdirSync(libDir)) {
    if (!name.endsWith('.mjs')) continue;
    const source = readFileSync(`${libDir}${name}`, 'utf8');
    const count = source.match(/\bfunction\s+serverAllowsRetry\s*\(/g)?.length ?? 0;
    if (count > 0) hits.push(`${name}×${count}`);
  }
  assert.deepEqual(hits, ['admin-api.mjs×1'], `判据只许有一处定义，实际：${hits.join('、') || '（无）'}`);

  assert.equal(typeof jobsApi.serverAllowsRetry, 'function', 'jobs-api 必须继续导出（既有 import 不能断）');
  assert.equal(jobsApi.serverAllowsRetry, adminApi.serverAllowsRetry, 'jobs-api 必须再导出同一个函数对象');
});
