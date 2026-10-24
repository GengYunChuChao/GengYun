/**
 * #19（GY-I19）· 「注销受理时先撤销在途外发」（#553 交付的 `egressRevoker` 注入）的**装配可达性台账**。
 *
 * 结论（锁**装配事实**，不锁实现细节）：这条能力在**两道互斥的装配门**之下**没有任何生产可达调用** ——
 *   1. `services/api/src/app.ts` 的 `egressRevoker` **只在 `executionMode === 'real'` 且有连接池
 *      （外发账本 `egressLedger !== null`）**时装配（非 real 无真实外发 ⇒ 不注入，回落无撤销）；
 *   2. 同一文件的 `available: config.executionMode !== 'real'` ⇒ real 下 `accountDeletionWired === null`
 *      ⇒ `routes/account-deletion.ts::requireWired()` 在**任何状态变更之前** 503 `PROVIDER_UNAVAILABLE`
 *      （该 503 是 #424 起的既有红线，由 `tests/integration/account-deletion-http.mjs` 的 `[5c]` 锁定）；
 *   3. 非 real（唯一接线模式）装配期**不建**撤销器 ⇒ 受理时不会撤销任何在途外发
 *      （替身/演示模式本来就不记账，见 `app.ts` 的外发账本注释）。
 * ⇒ 唯一可达的触发面是 `privacyInjection.egressRevoker`（测试/故障注入）。
 *
 * 本文件是**当前装配事实的回归锁**：若将来开放 real 注销（`available` 不再排除 real），
 * 前两条用例会变红 —— 那是**需要同步拍板**的信号（real 受理必须连同 `[5c]` 集成臂、
 * 以及「撤销在途外发是否先于受理」一起改），**不是**放宽断言的理由。
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

test('可达性①：real + 有池 + 有 ledger ⇒ 撤销器会装配，但注销整域在 requireWired() 先 503，撤销永不发生', async () => {
  const pool = spyPool();
  const reading = await acceptDeletion({ executionMode: 'real', pool, label: 'reach-real-pool' });
  assert.equal(reading.available, false, 'real 下 `available` 必须仍为 false（#424 起的红线，本片不放宽）');
  assert.equal(reading.status, 503);
  assert.equal(reading.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(reading.retryable, false);
  assert.equal(reading.revokeSql, 0, 'real 下受理根本到不了撤销器 ⇒ 零 `UPDATE public.exports … CONSENT_WITHDRAWN`');
  assert.equal(reading.writeSql, 0, '503 必须在任何状态变更之前发生 ⇒ 零写入');
});

test('可达性②：real + 注入撤销器也不能救活 ⇒ 仍 503，且注入的撤销器零次调用', async () => {
  const pool = spyPool();
  const revoker = spyRevoker();
  const reading = await acceptDeletion({ executionMode: 'real', pool, injectRevoker: revoker, label: 'reach-real-inject' });
  assert.equal(reading.available, false);
  assert.equal(reading.status, 503);
  assert.equal(reading.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(revoker.calls.length, 0, 'requireWired() 在受理之前抛错 ⇒ 注入的撤销器不会被调用');
  assert.equal(reading.revokeSql, 0);
  assert.equal(reading.writeSql, 0);
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

test('反向：real 下缺池 / 池不可用（无 connect ⇒ 无 ledger）仍是 503 且零写入', async () => {
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
