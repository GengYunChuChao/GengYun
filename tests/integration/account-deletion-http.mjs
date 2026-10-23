// GY-I19（#19）决策包 A 第 2 步 · 注销（账号删除）HTTP 接线 · **真实回环**集成脚本。
//
// 覆盖面（全部走 127.0.0.1 真实 HTTP，不直接调用业务函数）：
//   [0] 契约两个 operation 的**成功形状**：`POST /api/v1/me/account/deletion` → 202
//       `DeletionAcceptedEnvelope`（`ETag` + `no-store`）；`GET /api/v1/account/deletions/{id}` → 200。
//   [1] **202 只表示已受理**：`state ∈ {requested, processing, blocked}` 且**永不** `completed`；
//       各模块 `backup_state: 'pending'`（备份清除仍属 GY-I19，未接线，**不谎称完成**）。
//   [2] **期限与契约一致**（`docs/architecture/state-contract.md:107/109`）：回执 bearer 有效期 35 日、
//       在线截止 +7×24h、备份截止 +30×24h。
//   [3] **级联真的删了**：收藏/历史两个模块的**行**被按主体清空，且**只**清该主体（跨主体对照）。
//   [4] **回执 bearer 不是登录会话**（契约 `securitySchemes.deletionReceipt` 逐字「非登录会话」；
//       状态协议逐字「不允许用户session代替」）：用用户会话令牌查回执 / 跨请求用 bearer ⇒ 401。
//   [5] **失败与未装配可区分**：缺幂等键 400、错误 `confirmation` 400、无会话 401、
//       删除请求不可达 404 `NOT_FOUND`（**不是** 200 空壳）、`real` 模式整域 503 `PROVIDER_UNAVAILABLE`。
//   [6] **幂等**：同键同体重放 ⇒ 重新签发新 bearer（旧 bearer 立刻失效，因为台账只存摘要，
//       不回放旧响应）；同键异体（含 `If-Match` 进 hash 的契约口径）⇒ 409 `IDEMPOTENCY_CONFLICT`。
//
// 本脚本**不**触发任何外网/付费调用：身份用 `seedSession()` 直接在内存 auth store 播种，
// 存储用内存实现，执行模式为 `stub`（响应 `meta.execution_mode` 如实写出）。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';

const API = '/api/v1';
const DELETION_PATH = `${API}/me/account/deletion`;
const HOUR_MS = 3600 * 1000;

function note(line) {
  console.log(`  - ${line}`);
}

/** 播种合成身份与会话（不经过微信换取，不产生任何外网调用）。 */
async function seedSession(authStore, label) {
  const user = await authStore.createUser(`${label}-${randomUUID().replace(/-/g, '')}`);
  const token = mintOpaqueToken();
  await authStore.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    // 会话有效期也锚在合成时钟上：断言不依赖运行机器当下的墙上时间。
    expiresAt: new Date(clockMs + 3600 * 1000),
    audience: 'user',
  });
  return { token, userId: user.id };
}

/** 回环 HTTP 调用（只走 127.0.0.1）。 */
function makeHttp(origin) {
  return async function http(path, options = {}) {
    const headers = {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    };
    const response = await fetch(origin + path, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return {
      status: response.status,
      body,
      text,
      etag: response.headers.get('etag'),
      cache: response.headers.get('cache-control'),
      retryAfter: response.headers.get('retry-after'),
    };
  };
}

/** 契约 `DeletionReceipt.handlers[]` 的唯一合法形状（逐字对齐 openapi.json:12418-12475）。 */
function assertHandlerShape(handler) {
  assert.deepEqual(Object.keys(handler).sort(), ['backup_state', 'error_code', 'module', 'online_state', 'third_party_state']);
  assert.equal(typeof handler.module, 'string');
  assert.ok(handler.module.length >= 1 && handler.module.length <= 80);
  for (const state of [handler.online_state, handler.backup_state]) {
    assert.ok(['pending', 'running', 'completed', 'blocked'].includes(state), `非法 handler 状态：${state}`);
  }
  assert.ok(
    handler.third_party_state === null ||
      ['not_requested', 'requested', 'confirmed', 'failed', 'unsupported'].includes(handler.third_party_state),
  );
  assert.ok(
    handler.error_code === null ||
      (typeof handler.error_code === 'string' && handler.error_code.length >= 1 && handler.error_code.length <= 80),
  );
}

/** 契约 `DeletionReceipt` 的整体形状（逐字对齐 openapi.json:12476-12520）。 */
function assertReceiptShape(receipt, expectedId) {
  assert.deepEqual(
    Object.keys(receipt).sort(),
    ['backup_due_at', 'handlers', 'id', 'online_due_at', 'requested_at', 'revision', 'state'],
  );
  assert.equal(receipt.id, expectedId);
  assert.ok(['requested', 'processing', 'blocked', 'completed'].includes(receipt.state));
  assert.ok(Number.isSafeInteger(receipt.revision) && receipt.revision >= 1);
  for (const field of ['requested_at', 'online_due_at', 'backup_due_at']) {
    assert.equal(Number.isNaN(Date.parse(receipt[field])), false, `${field} 必须是 date-time`);
  }
  assert.ok(Array.isArray(receipt.handlers) && receipt.handlers.length <= 50);
  for (const handler of receipt.handlers) assertHandlerShape(handler);
  // 「已受理」/「部分覆盖」**绝不**等于「已删除」：`completed` 必须与全模块（在线+备份）证据一致。
  const fullyCovered = receipt.handlers.every((row) => row.online_state === 'completed' && row.backup_state === 'completed');
  assert.equal(receipt.state === 'completed', fullyCovered, '完成态必须与全模块覆盖一致（不得把部分覆盖说成全部完成）');
  return receipt;
}

const REAL_ENV = {
  DATABASE_URL: 'postgres://synthetic_local_only@127.0.0.1:5432/gengyun_synthetic_never_connected',
  SESSION_SIGNING_KEY: 'synthetic-not-a-real-signing-key',
  DELETION_LEDGER_KEY: 'synthetic-not-a-real-ledger-key',
  WECHAT_APP_ID: 'synthetic-not-a-real-appid',
  WECHAT_APP_SECRET: 'synthetic-not-a-real-appsecret',
  OBJECT_STORAGE_ENDPOINT: 'https://example.invalid',
  OBJECT_STORAGE_BUCKET: 'synthetic-not-a-real-bucket',
  OBJECT_STORAGE_ACCESS_KEY: 'synthetic-not-a-real-access-key',
  OBJECT_STORAGE_SECRET_KEY: 'synthetic-not-a-real-secret-key',
};

const clockMs = Date.parse('2026-10-15T03:00:00.000Z');
const stubAuthStore = createMemoryAuthStore();
const favoritesStore = createMemoryFavoritesStore({ now: () => clockMs });
const historyStore = createMemoryHistoryStore({ now: () => clockMs });
const stubApp = buildApp({
  config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
  now: () => new Date(clockMs),
  store: stubAuthStore,
  favoritesInjection: { store: favoritesStore },
  historyInjection: { store: historyStore },
});

/** 播种 A/B 两个主体各一行收藏 + 一行历史（行形状与 tests/unit/user-data-deletion.test.mjs 同源）。 */
async function seedRows(userId, tag) {
  await favoritesStore.insertFavorite({
    id: randomUUID(),
    revision: 1,
    owner_id: userId,
    target_ref: { type: 'species', id: `spc-${tag}`, revision: 1 },
    created_at: new Date(clockMs).toISOString(),
  });
  await historyStore.insertHistory({
    id: randomUUID(),
    revision: 1,
    owner_id: userId,
    kind: 'recognition',
    target_ref: { type: 'recognition', id: `rec-${tag}`, revision: 1 },
    job_id: `job-${tag}`,
    job_state: 'failed',
    created_at: new Date(clockMs).toISOString(),
    event_key: `evt-${tag}`,
  });
}

async function main() {
  await stubApp.listen({ host: '127.0.0.1', port: 0 });
  const address = stubApp.server.address();
  assert.equal(typeof address, 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const http = makeHttp(origin);
  note(`loopback origin=${origin} execution_mode=${stubApp.accountDeletion.available ? 'stub(wired)' : 'unwired'}`);

  // ---------------------------------------------------------------- [0] 前置：两个主体各有数据
  const { token: tokenA, userId: userA } = await seedSession(stubAuthStore, 'acct-del-a');
  const { token: tokenB, userId: userB } = await seedSession(stubAuthStore, 'acct-del-b');
  assert.notEqual(userA, userB, '两个主体必须不同（跨主体对照的前提）');
  await seedRows(userA, 'a');
  await seedRows(userB, 'b');

  const listFavorites = async (token) => http(`${API}/favorites`, { token });
  const listHistory = async (token) => http(`${API}/history`, { token });
  const before = {
    favA: await listFavorites(tokenA),
    hisA: await listHistory(tokenA),
    favB: await listFavorites(tokenB),
    hisB: await listHistory(tokenB),
  };
  for (const [label, res] of Object.entries(before)) {
    assert.equal(res.status, 200, `${label}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.data.items.length, 1, `${label} 前置必须各有一行`);
  }
  note(`前置：A 收藏=${before.favA.body.data.items.length} 历史=${before.hisA.body.data.items.length}；B 收藏=${before.favB.body.data.items.length} 历史=${before.hisB.body.data.items.length}`);

  // ---------------------------------------------------------------- [5a] 失败路径可区分（且零状态变更）
  const unauthenticated = await http(DELETION_PATH, {
    method: 'POST',
    headers: { 'idempotency-key': 'acct-del-unauthenticated' },
    body: { confirmation: 'delete_account' },
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.body.error.code, 'SESSION_REQUIRED');

  const noKey = await http(DELETION_PATH, { method: 'POST', token: tokenA, body: { confirmation: 'delete_account' } });
  assert.equal(noKey.status, 400, JSON.stringify(noKey.body));
  assert.equal(noKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

  const shortKey = await http(DELETION_PATH, {
    method: 'POST',
    token: tokenA,
    headers: { 'idempotency-key': 'short12' },
    body: { confirmation: 'delete_account' },
  });
  assert.equal(shortKey.status, 400, JSON.stringify(shortKey.body));
  assert.equal(shortKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

  const wrongConfirmation = await http(DELETION_PATH, {
    method: 'POST',
    token: tokenA,
    headers: { 'idempotency-key': 'acct-del-wrong-confirmation' },
    body: { confirmation: 'delete' },
  });
  assert.equal(wrongConfirmation.status, 400, JSON.stringify(wrongConfirmation.body));
  assert.equal(wrongConfirmation.body.error.code, 'INVALID_REQUEST');

  const extraField = await http(DELETION_PATH, {
    method: 'POST',
    token: tokenA,
    headers: { 'idempotency-key': 'acct-del-extra-field' },
    body: { confirmation: 'delete_account', owner_id: 'attacker' },
  });
  assert.equal(extraField.status, 400, JSON.stringify(extraField.body));
  assert.equal(extraField.body.error.code, 'INVALID_REQUEST');

  const afterRejections = {
    favA: await listFavorites(tokenA),
    hisA: await listHistory(tokenA),
  };
  for (const [label, res] of Object.entries(afterRejections)) {
    assert.equal(res.body.data.items.length, 1, `${label}：被拒请求不得改变任何状态`);
  }
  assert.deepEqual(favoritesStore.snapshotCounts(), { favorites: 2, unique_targets: 2 });
  assert.deepEqual(historyStore.snapshotCounts(), { history: 2, unique_targets: 2 });
  note(`失败路径：无会话 401 SESSION_REQUIRED；缺键/短键 400 IDEMPOTENCY_KEY_REQUIRED；confirmation 非法或多余字段 400 INVALID_REQUEST；存储零变更`);

  // ---------------------------------------------------------------- [1][2][3] 正向：受理 A 的注销
  const keyA = 'acct-del-key-0001';
  const accepted = await http(DELETION_PATH, {
    method: 'POST',
    token: tokenA,
    headers: { 'idempotency-key': keyA },
    body: { confirmation: 'delete_account' },
  });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  assert.equal(accepted.cache, 'no-store');
  assert.equal(accepted.body.meta.execution_mode, 'stub');
  assert.equal(accepted.body.meta.contract_version, '1.0.0');
  const acceptedData = accepted.body.data;
  assert.deepEqual(Object.keys(acceptedData).sort(), ['deletion', 'receipt_expires_at', 'receipt_token']);
  assert.equal(typeof acceptedData.receipt_token, 'string');
  assert.ok(acceptedData.receipt_token.length >= 1 && acceptedData.receipt_token.length <= 512);
  const receiptId = acceptedData.deletion.id;
  assertReceiptShape(acceptedData.deletion, receiptId);
  assert.equal(accepted.etag, `"${acceptedData.deletion.revision}"`, '契约要求 202 带资源 revision 强 ETag');

  // 202 = 「受理异步任务，尚未完成」：初始态绝不 completed，备份阶段未接线 ⇒ pending。
  // 且**必须**回 `blocked`：`state-contract.md:107` 逐字「不能完成时显示blocked和逾期，
  // 不把时钟到期当完成」——备份证据未齐 ⇒ 该请求此刻确实无法完成，投影不得粉饰为 processing/completed。
  assert.equal(acceptedData.deletion.state, 'blocked', `备用证据未齐时必须是 blocked：${acceptedData.deletion.state}`);
  assert.deepEqual(
    acceptedData.deletion.handlers.map((row) => row.module).sort(),
    // GY-I15（#15）· R31-S6：社区域并入同一本账（闭集只许扩大）——四个既有域一个不少，
    // 新增的是 `community`：装配处无条件注入社区清理原语，因此真实注销路径一定清
    // 帖子/评论/点赞/举报，回执也必须把它摊开。
    // GY-R34-I19：再并入识别域与语音域（`recognitions` / `speech`）——装配处同样无条件注入
    // 两个按主体清空的端口（走迁移 0034 的 SECURITY DEFINER 函数），所以回执必须摊成七项。
    ['community', 'conversations', 'favorites', 'history', 'messages', 'recognitions', 'speech'],
    '回执必须逐模块摊开（未报告的必需模块也要出现；C1b 起含消息域与会话域，S6 起含社区域，R34 起含识别域与语音域，原有各域一条不少）',
  );
  for (const row of acceptedData.deletion.handlers) {
    assert.equal(row.online_state, 'completed', `${row.module} 在线清理真的跑过`);
    assert.equal(row.backup_state, 'pending', `${row.module} 备份副本清除未接线 ⇒ 如实 pending`);
    assert.equal(row.error_code, null);
  }

  // 期限：回执 bearer 35 日（state-contract.md:107）、在线 +7×24h、备份 +30×24h（:109）。
  const requestedAt = Date.parse(acceptedData.deletion.requested_at);
  assert.equal(Date.parse(acceptedData.receipt_expires_at) - requestedAt, 35 * 24 * HOUR_MS, '回执 bearer 有效期必须是 35 日');
  assert.equal(Date.parse(acceptedData.deletion.online_due_at) - requestedAt, 7 * 24 * HOUR_MS, '在线截止 = 受理 + 7×24h');
  assert.equal(Date.parse(acceptedData.deletion.backup_due_at) - requestedAt, 30 * 24 * HOUR_MS, '备份截止 = 受理 + 30×24h');
  note(`202 受理：id=${receiptId} state=${acceptedData.deletion.state} revision=${acceptedData.deletion.revision} ETag=${accepted.etag} 回执期限=+35d 在线截止=+7d 备份截止=+30d`);

  // 级联真的删了：A 清空、B 原样（跨主体对照）。
  const afterFavA = await listFavorites(tokenA);
  const afterHisA = await listHistory(tokenA);
  const afterFavB = await listFavorites(tokenB);
  const afterHisB = await listHistory(tokenB);
  assert.equal(afterFavA.body.data.items.length, 0, 'A 的收藏必须被真的删除');
  assert.equal(afterHisA.body.data.items.length, 0, 'A 的历史必须被真的删除（不得只删收藏）');
  assert.equal(afterFavB.body.data.items.length, 1, 'B 的收藏不得被波及');
  assert.equal(afterHisB.body.data.items.length, 1, 'B 的历史不得被波及');
  assert.deepEqual(favoritesStore.snapshotCounts(), { favorites: 1, unique_targets: 1 });
  assert.deepEqual(historyStore.snapshotCounts(), { history: 1, unique_targets: 1 });
  note(`级联：A 收藏 1→${afterFavA.body.data.items.length} 历史 1→${afterHisA.body.data.items.length}；B 收藏=${afterFavB.body.data.items.length} 历史=${afterHisB.body.data.items.length}（不受影响）`);

  // ---------------------------------------------------------------- [4] 回执查询与凭据边界
  const receiptRead = await http(`${API}/account/deletions/${receiptId}`, { token: acceptedData.receipt_token });
  assert.equal(receiptRead.status, 200, JSON.stringify(receiptRead.body));
  assert.equal(receiptRead.cache, 'no-store');
  assert.equal(receiptRead.etag, `"${receiptRead.body.data.revision}"`);
  assertReceiptShape(receiptRead.body.data, receiptId);
  assert.equal(receiptRead.body.data.state, acceptedData.deletion.state);
  // 回执不含账号/媒体信息（状态协议 state-contract.md:107「无账号和媒体信息」）。
  const receiptText = JSON.stringify(receiptRead.body);
  for (const leak of [userA, userB, 'spc-a', 'rec-a', 'job-a', acceptedData.receipt_token]) {
    assert.equal(receiptText.includes(leak), false, `回执不得出现 ${leak}`);
  }

  const noCredential = await http(`${API}/account/deletions/${receiptId}`);
  assert.equal(noCredential.status, 401);
  assert.equal(noCredential.body.error.code, 'SESSION_REQUIRED');

  // 用户会话令牌**不能**代替回执 bearer（状态协议逐字「不允许用户session代替」）。
  const sessionForReceipt = await http(`${API}/account/deletions/${receiptId}`, { token: tokenB });
  assert.equal(sessionForReceipt.status, 401, JSON.stringify(sessionForReceipt.body));
  assert.equal(sessionForReceipt.body.error.code, 'SESSION_EXPIRED');

  // 回执 bearer 绑定单个删除请求：换一个（合法 uuid 的）请求 id 一律 401，不泄露其是否存在。
  const crossRequest = await http(`${API}/account/deletions/${randomUUID()}`, { token: acceptedData.receipt_token });
  assert.equal(crossRequest.status, 401, JSON.stringify(crossRequest.body));
  assert.equal(crossRequest.body.error.code, 'SESSION_EXPIRED');

  const malformedId = await http(`${API}/account/deletions/not-a-uuid`, { token: acceptedData.receipt_token });
  assert.equal(malformedId.status, 400, JSON.stringify(malformedId.body));
  assert.equal(malformedId.body.error.code, 'INVALID_REQUEST');
  note('回执鉴权：无凭据 401 SESSION_REQUIRED；用户会话令牌顶替 401 SESSION_EXPIRED；跨请求 401 SESSION_EXPIRED；id 非 uuid 400 INVALID_REQUEST');

  // ---------------------------------------------------------------- [5b] 删除请求不可达 ⇒ 404（不是 200 空壳）
  // 进程内台账重启即空 ⇒ 「bearer 有效但删除请求不在了」是真实形状：如实 404，不编造回执。
  const orphanId = randomUUID();
  const orphanToken = stubApp.deletionReceipts.issue(orphanId).token;
  const orphan = await http(`${API}/account/deletions/${orphanId}`, { token: orphanToken });
  assert.equal(orphan.status, 404, JSON.stringify(orphan.body));
  assert.equal(orphan.body.error.code, 'NOT_FOUND');
  note('不可达删除请求：404 NOT_FOUND（不是 200 空壳）');

  // ---------------------------------------------------------------- [6] 幂等：同键同体重新签发、异体 409
  const replay = await http(DELETION_PATH, {
    method: 'POST',
    token: tokenA,
    headers: { 'idempotency-key': keyA },
    body: { confirmation: 'delete_account' },
  });
  assert.equal(replay.status, 202, JSON.stringify(replay.body));
  assert.equal(replay.body.data.deletion.id, receiptId, '同键同体必须收敛到同一删除请求');
  assert.notEqual(replay.body.data.receipt_token, acceptedData.receipt_token, '台账只存摘要 ⇒ 重放只能换发，不回放旧 bearer');
  const staleBearer = await http(`${API}/account/deletions/${receiptId}`, { token: acceptedData.receipt_token });
  assert.equal(staleBearer.status, 401, '换发后旧 bearer 必须立刻失效');
  assert.equal(staleBearer.body.error.code, 'SESSION_EXPIRED');
  const freshBearer = await http(`${API}/account/deletions/${receiptId}`, { token: replay.body.data.receipt_token });
  assert.equal(freshBearer.status, 200, JSON.stringify(freshBearer.body));
  assert.equal(stubApp.deletionReceipts.liveCount(), 2, '孤儿 bearer + 重放后的现行 bearer');
  note(`幂等重放：同 id=${receiptId}，bearer 换发（旧 401 / 新 200），台账 liveCount=${stubApp.deletionReceipts.liveCount()}`);

  // 同键异体：契约 `IdempotencyKey` 逐字「hash包含If-Match」⇒ 同键不同 If-Match 即异体。
  const conflicting = await http(DELETION_PATH, {
    method: 'POST',
    token: tokenA,
    headers: { 'idempotency-key': keyA, 'if-match': '"1"' },
    body: { confirmation: 'delete_account' },
  });
  assert.equal(conflicting.status, 409, JSON.stringify(conflicting.body));
  assert.equal(conflicting.body.error.code, 'IDEMPOTENCY_CONFLICT');
  note('同键异体（If-Match 进 hash）：409 IDEMPOTENCY_CONFLICT');

  // ---------------------------------------------------------------- 幂等范围按主体隔离
  const otherSubject = await http(DELETION_PATH, {
    method: 'POST',
    token: tokenB,
    headers: { 'idempotency-key': keyA },
    body: { confirmation: 'delete_account' },
  });
  assert.equal(otherSubject.status, 202, JSON.stringify(otherSubject.body));
  assert.notEqual(otherSubject.body.data.deletion.id, receiptId, '同键不同主体是各自的键域，必须各自受理');
  assert.equal((await listFavorites(tokenB)).body.data.items.length, 0, 'B 自己的注销也必须真的清掉 B 的数据');
  assert.deepEqual(favoritesStore.snapshotCounts(), { favorites: 0, unique_targets: 0 });
  note(`键域按主体隔离：B 用同一 Idempotency-Key 也各自受理（id=${otherSubject.body.data.deletion.id}）`);

  // ---------------------------------------------------------------- [5c] real 模式：整域 503，不假装能删
  const realAuthStore = createMemoryAuthStore();
  const realApp = buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'real', LOG_LEVEL: 'silent', ...REAL_ENV }),
    now: () => new Date(clockMs),
    store: realAuthStore,
  });
  const realOrigin = await realApp.listen({ host: '127.0.0.1', port: 0 });
  const realHttp = makeHttp(realOrigin);
  try {
    assert.equal(realApp.accountDeletion.available, false, 'real 模式下注销请求存储未接线 ⇒ 整域不可用');
    assert.equal(realApp.deletionReceipts.liveCount(), 0);
    const { token: realToken } = await seedSession(realAuthStore, 'acct-del-real');
    const realAccepted = await realHttp(DELETION_PATH, {
      method: 'POST',
      token: realToken,
      headers: { 'idempotency-key': 'acct-del-real-0001' },
      body: { confirmation: 'delete_account' },
    });
    assert.equal(realAccepted.status, 503, JSON.stringify(realAccepted.body));
    assert.equal(realAccepted.body.error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(realAccepted.body.error.retryable, false);
    assert.equal(realAccepted.body.meta.execution_mode, 'real');
    const realReceipt = await realHttp(`${API}/account/deletions/${randomUUID()}`, { token: mintOpaqueToken() });
    assert.equal(realReceipt.status, 503, JSON.stringify(realReceipt.body));
    assert.equal(realReceipt.body.error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(realApp.deletionReceipts.liveCount(), 0, '未装配路径不得留下任何状态');
    note('real 模式：POST/GET 均 503 PROVIDER_UNAVAILABLE(retryable=false)，零状态变更');
  } finally {
    await realApp.close();
  }

  console.log('PASS GY-I19 account-deletion loopback HTTP integration (synthetic identities + memory stores + stub/real wiring arms)');
}

try {
  await main();
} catch (error) {
  console.error('FAIL GY-I19 account-deletion loopback HTTP integration');
  console.error(error);
  process.exitCode = 1;
} finally {
  await stubApp.close();
}
