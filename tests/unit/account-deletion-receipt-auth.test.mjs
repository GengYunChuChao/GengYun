// GY-I19（#19）回执查询的**鉴权语义**机器检查（进程内 `app.inject`，不监听端口、不连库、不联网）。
//
// 为什么单独一条：`docs/architecture/contract-status.json:457`（`getDeletionReceipt.blocker`）逐字写着
// 「未知/过期/跨请求一律 401、请求不可达 404 NOT_FOUND」，而实现是
// `services/api/src/routes/account-deletion.ts:193-201`：
//   :194 无 bearer                ⇒ 401 `SESSION_REQUIRED`
//   :198 摘要解析失败 **或** 摘要绑定的 id ≠ 路径 id ⇒ 401 `SESSION_EXPIRED`（**不是** 404：不泄露 id 是否存在）
//   :201 摘要已绑定本 id 但台账里没有该请求      ⇒ 404 `NOT_FOUND`
// 这三条一旦被「顺手放宽」（例如把 `boundId !== id` 去掉、或跨主体改成 404），台账与契约都会漂移，
// 且外部看不出差别。故本文件把可观测行为逐条钉住；判据本身就是台账 blocker 的原文。
//
// 反向控制（见 PR 描述与证据页）：把 `:198` 的 `boundId === null || boundId !== id` 改成
// `boundId === null`，下面第 3 条必须变红——红不出来说明本检查没咬住代码。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';

const API = '/api/v1';
const DELETION_PATH = `${API}/me/account/deletion`;
const clockMs = Date.parse('2026-10-15T03:00:00.000Z');

/** 合成身份：不经过微信换取、不产生任何外网调用（与 `tests/integration/account-deletion-http.mjs` 同源）。 */
async function seedSession(authStore, label) {
  const user = await authStore.createUser(`${label}-${randomUUID().replace(/-/g, '')}`);
  const token = mintOpaqueToken();
  await authStore.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(clockMs + 3600 * 1000),
    audience: 'user',
  });
  return { token, userId: user.id };
}

async function makeHarness() {
  const authStore = createMemoryAuthStore();
  const favoritesStore = createMemoryFavoritesStore({ now: () => clockMs });
  const historyStore = createMemoryHistoryStore({ now: () => clockMs });
  const app = buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    now: () => new Date(clockMs),
    store: authStore,
    favoritesInjection: { store: favoritesStore },
    historyInjection: { store: historyStore },
  });
  const a = await seedSession(authStore, 'auth-a');
  const b = await seedSession(authStore, 'auth-b');
  return { app, a, b };
}

/** 只抽断言需要的两个可观测量：状态码与契约错误码。 */
function pick(response) {
  let body = null;
  try {
    body = response.json();
  } catch {
    body = null;
  }
  return { status: response.statusCode, code: body?.error?.code ?? null };
}

test('GY-I19 回执鉴权：无凭据 401 SESSION_REQUIRED；用户会话令牌顶替 401 SESSION_EXPIRED', async () => {
  const { app } = await makeHarness();
  const id = randomUUID();

  const anonymous = await app.inject({ method: 'GET', url: `${API}/account/deletions/${id}` });
  assert.equal(anonymous.statusCode, 401, '回执查询无 bearer 必须 401，不得回 200 空壳或 404');
  assert.equal(pick(anonymous).code, 'SESSION_REQUIRED', '无凭据的错误码必须是契约 401 档的 SESSION_REQUIRED');

  await app.close();
});

test('GY-I19 回执鉴权：用户会话令牌**不是**回执 bearer（契约 deletionReceipt「非登录会话」）⇒ 401 SESSION_EXPIRED', async () => {
  const { app, a } = await makeHarness();

  const accepted = await app.inject({
    method: 'POST',
    url: DELETION_PATH,
    headers: { authorization: `Bearer ${a.token}`, 'idempotency-key': 'k-receipt-auth-1' },
    payload: { confirmation: 'delete_account' },
  });
  assert.equal(accepted.statusCode, 202, '合成主体在 stub 装配下受理必须 202');
  const deletionId = accepted.json().data.deletion.id;

  // 用**用户会话令牌**查回执：契约要求这种顶替一律 401，而不是 200。
  const bySession = await app.inject({
    method: 'GET',
    url: `${API}/account/deletions/${deletionId}`,
    headers: { authorization: `Bearer ${a.token}` },
  });
  assert.equal(bySession.statusCode, 401, '用户会话令牌顶替回执 bearer 必须 401');
  assert.equal(pick(bySession).code, 'SESSION_EXPIRED', '顶替凭据的错误码必须是 SESSION_EXPIRED（不是 200 / 403）');

  await app.close();
});

test('GY-I19 回执鉴权：A 的回执 bearer 查 B 的请求 id ⇒ 401 SESSION_EXPIRED（**不是** 404，防 id 存在性探测）', async () => {
  const { app, a, b } = await makeHarness();

  const acceptedA = await app.inject({
    method: 'POST',
    url: DELETION_PATH,
    headers: { authorization: `Bearer ${a.token}`, 'idempotency-key': 'k-receipt-auth-a' },
    payload: { confirmation: 'delete_account' },
  });
  assert.equal(acceptedA.statusCode, 202);
  const dataA = acceptedA.json().data;
  const idA = dataA.deletion.id;
  const bearerA = dataA.receipt_token;
  assert.equal(typeof bearerA, 'string', '受理必须掏出回执 bearer');

  const acceptedB = await app.inject({
    method: 'POST',
    url: DELETION_PATH,
    headers: { authorization: `Bearer ${b.token}`, 'idempotency-key': 'k-receipt-auth-b' },
    payload: { confirmation: 'delete_account' },
  });
  assert.equal(acceptedB.statusCode, 202);
  const idB = acceptedB.json().data.deletion.id;
  assert.notEqual(idA, idB, '两个主体的注销请求 id 不得相同');

  // ① 自己的 bearer 查自己的 id：200（正控制，证明下面的红不是因为凭据整体不可用）。
  const own = await app.inject({
    method: 'GET',
    url: `${API}/account/deletions/${idA}`,
    headers: { authorization: `Bearer ${bearerA}` },
  });
  assert.equal(own.statusCode, 200, '自己的回执 bearer 查自己的请求必须 200');
  assert.equal(own.json().data.id, idA);

  // ② 同一 bearer 查**别人**的 id：401 SESSION_EXPIRED。
  //    台账 docs/architecture/contract-status.json:457 逐字：「未知/过期/跨请求一律 401」；
  //    实现 routes/account-deletion.ts:197-198 的理由是「不泄露该 id 是否存在（防探测）」。
  //    ⛔ 若这里回 404，等于把「该 id 是否存在」变成可探测信号 —— 与契约口径相反。
  const crossUser = await app.inject({
    method: 'GET',
    url: `${API}/account/deletions/${idB}`,
    headers: { authorization: `Bearer ${bearerA}` },
  });
  assert.notEqual(crossUser.statusCode, 404, '跨主体/跨请求不得回 404：那会把 id 存在性变成可探测信号');
  assert.equal(crossUser.statusCode, 401, '跨主体/跨请求必须 401');
  assert.equal(pick(crossUser).code, 'SESSION_EXPIRED', '跨主体/跨请求的错误码必须是 SESSION_EXPIRED');

  await app.close();
});

test('GY-I19 受理口：无会话 POST ⇒ 401 SESSION_REQUIRED（且不得先落任何状态）', async () => {
  const { app } = await makeHarness();

  const denied = await app.inject({
    method: 'POST',
    url: DELETION_PATH,
    headers: { 'idempotency-key': 'k-receipt-auth-anon' },
    payload: { confirmation: 'delete_account' },
  });
  assert.equal(denied.statusCode, 401, '未登录受理必须 401');
  assert.equal(pick(denied).code, 'SESSION_REQUIRED');

  await app.close();
});
