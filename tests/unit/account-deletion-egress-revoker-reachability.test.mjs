/**
 * #19（GY-I19）· 「注销受理时先撤销在途外发」（#553 交付的 `egressRevoker` 注入）的**装配可达性台账**。
 *
 * GY-R74 起的事实（方案 A：按域如实降级，不再整域关闭）：
 *   1. `services/api/src/app.ts` 的 `egressRevoker` 仍**只在 `executionMode === 'real'` 且有连接池
 *      （外发账本 `egressLedger !== null`）**时装配（非 real 无真实外发 ⇒ 不注入，回落无撤销）；
 *   2. `available` 不再是 `executionMode !== 'real'`，而是
 *      `executionMode !== 'real' || 受理可持久化(durableDeletionRequests !== null && pool.connect)`。
 *      于是 `real` + 真库 ⇒ **本域接线、可受理**（在线清除执行者 GY-R74 已接线；
 *      备份介质与第三方证据仍不可用 ⇒ 由回执逐域 `blocked` 表达，见 `[5c]`/`account-deletion-pg`）；
 *   3. `real` 但**没有可用连接池**（无池，或池缺 `connect`）⇒ 受理无法持久化 ⇒ 仍是
 *      `requireWired()` 之前的 503 `PROVIDER_UNAVAILABLE`（本文件末条用例锁住这条唯一的 503）。
 *
 * 前两条用例因此改成锁「real 受理真的进得去」的**新事实**：受理链会在合成池上走到
 * 外发冻结/持久化，并按库的真实回答如实 409/503（⛔ 不伪造 202 空壳）。
 * 它不是放宽断言 —— 旧口径「real 一律 503 且零写入」已随本片的产品行为变更失效，
 * 取而代之的是更严的三条：`available === true`、`code` 必须是闭集内的真实原因、零假写入。
 *
 * 全部用例用**合成 PG 替身**（只记录 SQL、回空行）＋内存 auth store：
 * 不连任何数据库、不发任何外网请求、不产生费用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';

const API = '/api/v1';
const DELETION_PATH = `${API}/me/account/deletion`;
const SESSION_SIGNING_KEY = 'synthetic-i19-egress-revoker-reachability-key-0123456789';

/** 账本撤销在途外发的那条原子 UPDATE（`privacy/ledger-pg.ts::revokeInFlight`）。 */
const REVOKE_SQL = /UPDATE public\.exports SET state='failed', error_code='CONSENT_WITHDRAWN'/;
/** 写入类语句（用于「503 零写入」的判据）。 */
const WRITE_SQL = /^(INSERT|UPDATE|DELETE)\b/i;

/**
 * 合成 PG 替身：**同时**提供 `query` 与 `connect`（`app.ts` 的 `egressPoolUsable` 要求两者齐备
 * ⇒ 外发账本 `egressLedger` 与在途守卫才会装配）。只把 SQL 归一化成单行记进 `log`。
 */
function spyPool({ withConnect = true } = {}) {
  const log = [];
  const record = (text) => {
    log.push(String(text).replace(/\s+/g, ' ').trim());
    return { rows: [], rowCount: 0 };
  };
  return {
    log,
    query: async (text) => record(text),
    ...(withConnect ? { connect: async () => ({ query: async (text) => record(text), release() {} }) } : {}),
  };
}

/** 记录调用次数的撤销器（`AccountEgressRevoker` 形状 + 同形的撤回方法）。 */
function spyRevoker() {
  const calls = [];
  return {
    calls,
    async onAccountSuspendedOrDeleted(input) {
      calls.push(input);
      return { revokedInFlight: 0 };
    },
    async onConsentWithdrawn() {
      return { revokedInFlight: 0 };
    },
  };
}

function makeConfig(executionMode) {
  const base = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', SESSION_SIGNING_KEY });
  return executionMode === 'real'
    ? { ...base, executionMode: 'real', requiresRealCredentials: true, logLevel: 'silent' }
    : { ...base, executionMode: 'stub', logLevel: 'silent' };
}

/** 播种合成身份与会话（不经微信换取、不产生外网请求）。 */
async function seedSession(authStore, label) {
  const user = await authStore.createUser(`${label}-${mintOpaqueToken().slice(0, 10)}`);
  const token = mintOpaqueToken();
  await authStore.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    audience: 'user',
  });
  return { token, userId: user.id };
}

/**
 * 装配一个 app 并投一次注销受理。
 *
 * - `pool`：`null` ⇒ 无连接池；`{ withConnect: false }` ⇒ 有池但缺 `connect()`
 *   （`egressPoolUsable === false` ⇒ **无外发账本**，即便 real 也不会有撤销器）；
 * - `injectRevoker`：经 `privacyInjection.egressRevoker` 注入（唯一可达的触发面）；
 * - `memoryRequests`：`userDataDeletionInjection.requests = null` ⇒ 受理走**内存**实现
 *   （避免 stub+合成池时打到 0016 的 `SECURITY DEFINER` 函数；本文件只关心撤销接线）。
 */
async function acceptDeletion({ executionMode, pool = null, injectRevoker, memoryRequests = false, label }) {
  const authStore = createMemoryAuthStore();
  const app = buildApp({
    config: makeConfig(executionMode),
    ...(pool === null ? {} : { pool: pool === 'no-connect' ? spyPool({ withConnect: false }) : pool }),
    store: authStore,
    ...(memoryRequests ? { userDataDeletionInjection: { requests: null } } : {}),
    ...(injectRevoker === undefined ? {} : { privacyInjection: { egressRevoker: injectRevoker } }),
  });
  const { token, userId } = await seedSession(authStore, label);
  const response = await app.inject({
    method: 'POST',
    url: DELETION_PATH,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'idempotency-key': `probe-${label}`,
    },
    payload: { confirmation: 'delete_account' },
  });
  const body = response.json();
  const result = {
    available: app.accountDeletion.available,
    status: response.statusCode,
    code: body?.error?.code ?? null,
    retryable: body?.error?.retryable ?? null,
    state: body?.data?.deletion?.state ?? null,
    userId,
    revokeSql: pool === null ? 0 : pool.log.filter((sql) => REVOKE_SQL.test(sql)).length,
    writeSql: pool === null ? 0 : pool.log.filter((sql) => WRITE_SQL.test(sql)).length,
  };
  await app.close();
  return result;
}

test('可达性①：real + 有池 ⇒ 受理域已接线；外发冻结前置探测在合成池上如实 409，零写入', async () => {
  const pool = spyPool();
  const reading = await acceptDeletion({ executionMode: 'real', pool, label: 'reach-real-pool' });
  // GY-R74（方案 A）：real + 真库不再整域 503 —— 受理真的进得去。
  // 理由：在线清除执行者已于 GY-R74 接线并带真库臂证据；备份介质与第三方证据仍不可用，
  // 故按域如实降级而不是整域关闭。
  assert.equal(reading.available, true, 'real + 有池 ⇒ 受理域必须接线（⛔ 不再整域 503）');
  // 合成池里没有 0011 的外发账本表 ⇒ 「冻结在途外发」的前置探测如实判定不可用，
  // ⛔ 不降级为"跳过撤销继续受理"（那会在撤销不了在途外发的情况下删号）。
  assert.equal(reading.status, 409);
  assert.equal(reading.code, 'OBJECT_UNAVAILABLE');
  assert.equal(reading.retryable, false);
  assert.equal(reading.revokeSql, 0, '前置探测失败 ⇒ 不该有 `UPDATE public.exports … CONSENT_WITHDRAWN`');
  assert.equal(reading.writeSql, 0, '前置探测失败必须在任何状态变更之前 ⇒ 零写入');
});

test('可达性②：real + 注入撤销器 ⇒ 撤销真的发生（调用一次、带正确主体），随后按库的真实回答 503', async () => {
  const pool = spyPool();
  const revoker = spyRevoker();
  const reading = await acceptDeletion({ executionMode: 'real', pool, injectRevoker: revoker, label: 'reach-real-inject' });
  assert.equal(reading.available, true);
  // GY-R74：受理链在 real 下真的跑到了「受理时先撤销在途外发」这一步（旧口径下这里零调用）。
  assert.equal(revoker.calls.length, 1, 'real 受理链必须调用注入的撤销器（且只一次）');
  assert.deepEqual(revoker.calls[0], { userId: reading.userId }, '撤销必须带本次受理的那个主体');
  // 合成池上 `createRequest` 回空行 ⇒ 受理无法持久化 ⇒ 如实 503（⛔ 不回 200/202 空壳）。
  assert.equal(reading.status, 503);
  assert.equal(reading.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(reading.retryable, false);
  assert.equal(reading.revokeSql, 0, '注入的替身不碰 `public.exports`（撤销 SQL 由真实账本端口发）');
  assert.ok(reading.writeSql > 0, '受理持久化确实尝试过写入（不是"什么都没做就 503"）');
});

test('可达性③：唯一接线模式（非 real）装配期不建撤销器 ⇒ 即便有池有 ledger，受理也零撤销', async () => {
  const pool = spyPool();
  const reading = await acceptDeletion({
    executionMode: 'stub',
    pool,
    memoryRequests: true,
    label: 'reach-stub-pool',
  });
  assert.equal(reading.available, true, '非 real 是明确标注的替身执行模式 ⇒ 本域接线（既有口径）');
  assert.equal(reading.status, 202);
  assert.equal(
    reading.revokeSql,
    0,
    '非 real 不建撤销器（`egressRevoker` 装配门要求 real）⇒ 受理时不得出现任何 `UPDATE public.exports` 撤销写入',
  );
});

test('可达性④（正向对照）：唯一可达触发面 = privacyInjection.egressRevoker ⇒ 受理前调用一次、带正确主体', async () => {
  const revoker = spyRevoker();
  const reading = await acceptDeletion({
    executionMode: 'stub',
    pool: spyPool(),
    injectRevoker: revoker,
    memoryRequests: true,
    label: 'reach-stub-inject',
  });
  assert.equal(reading.status, 202);
  assert.equal(revoker.calls.length, 1, '注入后才真正走到「受理时先撤销在途外发」');
  assert.deepEqual(revoker.calls[0], { userId: reading.userId });
});

test('反向：real 下缺池 / 池不可用（无 connect ⇒ 受理无法持久化）仍是 503 且零写入', async () => {
  // GY-R74 起这是**唯一**保留的整域 503：real 但没有可用连接池 ⇒ `deletion_requests` 写不进去 ⇒
  // 7 日在线清除驱动读不到请求行 ⇒ 受理就不能假装成功。文案见 `ACCOUNT_DELETION_UNAVAILABLE_MESSAGE`。
  const noPool = await acceptDeletion({ executionMode: 'real', pool: null, label: 'reach-real-nopool' });
  assert.equal(noPool.available, false);
  assert.equal(noPool.status, 503);
  assert.equal(noPool.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(noPool.writeSql, 0);

  const poolNoConnect = spyPool({ withConnect: false });
  const noLedger = await acceptDeletion({ executionMode: 'real', pool: poolNoConnect, label: 'reach-real-noledger' });
  assert.equal(noLedger.available, false);
  assert.equal(noLedger.status, 503);
  assert.equal(noLedger.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(noLedger.revokeSql, 0);
  assert.equal(noLedger.writeSql, 0, '缺 ledger 也不得留下任何写入');
});
