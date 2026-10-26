// GY-R59（P2-b）· 第三方删除「读侧 + 端口装配」的机器取证（进程内 `app.inject`，不监听端口、不连库、不联网）。
//
// 这份文件锁住设计 §1.2 的 #6/#7/#9/#10/#11/#12 与 §2 的 ④（"为什么现在读不出值"）：
//   1. `projectReceipt()` 的**优先级**：现算的第三方聚合态 > 处理器行上报值，且闭集外值不外泄；
//   2. 回执投影五种取值（`not_requested`/`requested`/`confirmed`/`failed`/`unsupported`）逐值正确；
//   3. 来源抛异常 ⇒ 该字段 `null`、回执仍 200（⛔ 不是 500）；
//   4. 四态端口装配：未接线 / 显式注入 / 真库（`persistent === true`）/ 显式不可用；
//   5. 读侧真的**问端口**（`refreshBackupStates()` 里 `thirdPartyRowsOf()` 优先端口，未接线才回退进程内行）；
//   6. 端到端：协议第三方行 ⇒ `GET /account/deletions/:id` 的 `third_party_state`（④ 的"读得出值"）。
//
// ── 负控制（改一行就必须变红的可重跑说明）──────────────────────────────────────────────
// N1. 把 `services/api/src/routes/account-deletion.ts::thirdPartyStateOf()` 里的
//     `try { … } catch { return null; }` 去掉（让异常冒泡）⇒ 本文件「来源抛异常 ⇒ 回执仍 200」变红
//     （实际会拿到 500 / `PROVIDER_UNAVAILABLE`），红不出来说明该用例没咬住代码。
// N2. 把 `services/api/src/privacy/account-deletion.ts` 的
//     `thirdPartyOverride ?? pickThirdParty(handler['third_party_state'])`
//     写成 `pickThirdParty(handler['third_party_state']) ?? thirdPartyOverride` ⇒「现算值优先」变红
//     （处理器行上报的 `requested` 会盖掉现算的 `confirmed`）。
// N3. 把 `services/api/src/privacy/user-data-deletion.ts` 的
//     `input.thirdParty ?? createUnwiredThirdPartyDeletionPort()` 换成
//     `createUnavailableThirdPartyDeletionPort()` ⇒「未接线 ⇒ refreshBackupStates 不抛」变红（变成抛）。
// N4. 把 `createUserDataDeletion()` 里 `hasThirdParty` 那类判定改成"注入即视为已接线"的硬编码，
//     或把装配层 `thirdPartyWiring` 第三臂写成 `createUnwiredThirdPartyDeletionPort()` ⇒
//     「受理已接线 + real + 无池 ⇒ 显式不可用」变红（会静默回成未接线）。
//
// ── 本文件**不**覆盖的东西（如实写清，不冒充）─────────────────────────────────────────
// * 真库臂（`pool !== null` ⇒ `createPostgresThirdPartyDeletionPort()`）只验到**装配身份**
//   （`persistent === true`）；真库 SQL 读行需要可用 Postgres，本机 `initdb` 受权限限制 ⇒ **未跑**，
//   证据留在 `tests/unit/third-party-deletion-pg.test.mjs`（同一端口的构造/参数形状）与 CI。
// * 写侧（谁在何时 dispatch 给第三方）属 P2-c，不在本文件；本文件只验 `unavailable` 端口**不落库**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { projectReceipt } from '../../services/api/src/privacy/account-deletion.ts';
import { thirdPartyReceiptState } from '../../services/api/src/privacy/third-party-deletion-projection.ts';
import {
  createUnavailableThirdPartyDeletionPort,
  createUnwiredThirdPartyDeletionPort,
} from '../../services/api/src/privacy/user-data-deletion.ts';
import { registerAccountDeletionRoutes } from '../../services/api/src/routes/account-deletion.ts';

const API = '/api/v1';
const DELETION_PATH = `${API}/me/account/deletion`;
// 远未来固定基准（`2100-01-01T00:00:00Z`）：与**跑测试的真实日期完全解耦**。
// 会话过期、回执的 `requested_at`/`online_due_at`/`backup_due_at`、确认时间全部从它推导，
// 因此「注入时钟晚于 requested_at」在任何一天跑都成立——不存在与墙钟耦合的时炸弹。
const clockMs = Date.parse('2100-01-01T00:00:00.000Z');

/** 与 `tests/unit/admin-real-mode-fail-closed.test.mjs` 同形的**合成占位** real 环境（非真实凭据）。 */
const REAL_ENV = {
  APP_EXECUTION_MODE: 'real',
  LOG_LEVEL: 'silent',
  // 合成占位：只用来过 `real` 模式的配置校验（`config.ts` 要求 real 必须给出库地址）。
  // ⛔ 不连库：`buildApp({ pool })` 的池**只**来自构造选项（`app.ts:755` 的 `pool = null`），
  // 不会因为存在 `DATABASE_URL` 就偷偷建池 —— 本文件「无池」的前提因此仍然成立。
  DATABASE_URL: 'postgres://synthetic-local-never-connected@127.0.0.1:5432/gengyun_synthetic_unused',
  SESSION_SIGNING_KEY: 'synthetic-not-a-real-signing-key',
  DELETION_LEDGER_KEY: 'synthetic-not-a-real-ledger-key',
  WECHAT_APP_ID: 'synthetic-not-a-real-appid',
  WECHAT_APP_SECRET: 'synthetic-not-a-real-appsecret',
  OBJECT_STORAGE_ENDPOINT: 'https://example.invalid',
  OBJECT_STORAGE_BUCKET: 'synthetic-not-a-real-bucket',
  OBJECT_STORAGE_ACCESS_KEY: 'synthetic-not-a-real-access-key',
  OBJECT_STORAGE_SECRET_KEY: 'synthetic-not-a-real-secret-key',
};

/** 合成身份：不经过微信换取、不产生任何外网调用（与 `tests/unit/account-deletion-receipt-auth.test.mjs` 同源）。 */
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

/** stub 装配（无真库、无映射池）+ 可选注入项；`extra` 直接覆盖 `buildApp` 选项。 */
async function makeStubApp(extra = {}) {
  const authStore = createMemoryAuthStore();
  const app = buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    now: () => new Date(clockMs),
    store: authStore,
    favoritesInjection: { store: createMemoryFavoritesStore({ now: () => clockMs }) },
    historyInjection: { store: createMemoryHistoryStore({ now: () => clockMs }) },
    ...extra,
  });
  const session = await seedSession(authStore, 'tpd-read');
  return { app, authStore, session };
}

/** 202 受理 ⇒ 取删除请求 id 与回执 bearer（后续 GET 用）。 */
async function startDeletion(app, token, key) {
  const accepted = await app.inject({
    method: 'POST',
    url: DELETION_PATH,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
    payload: { confirmation: 'delete_account' },
  });
  assert.equal(accepted.statusCode, 202, '合成主体在 stub 装配下受理必须 202');
  const body = accepted.json();
  return {
    id: body.data.deletion.id,
    receiptToken: body.data.receipt_token,
    initialState: body.data.deletion.state,
  };
}

async function getReceipt(app, id, receiptToken) {
  return app.inject({
    method: 'GET',
    url: `${API}/account/deletions/${id}`,
    headers: { authorization: `Bearer ${receiptToken}` },
  });
}

/**
 * 回执路由用的固定请求 id：`GET /account/deletions/:id` 的 path 参数是 `format: uuid`
 * （`receiptParams`），非 UUID 会在 schema 校验阶段直接 400，测不到投影。
 */
const ROUTE_ID = '5b1c6c1e-2f77-4a6f-9a1c-3d2b1a0f9e11';

// ─────────────────────────────────────────────────────────────────────────────
// 1) 纯函数：`projectReceipt()` 的第二参优先级（#11）
// ─────────────────────────────────────────────────────────────────────────────

/** 回执骨架：处理器行**如实**上报 `third_party_state`（协议当前恒为 null，这里刻意给个非 null 值以可判别）。 */
function handlerReceipt(reportedThirdPartyState) {
  return {
    id: 'req-1',
    state: 'blocked',
    revision: 4,
    requested_at: new Date(clockMs - 60 * 1000).toISOString(),
    online_due_at: new Date(clockMs + 6 * 86400 * 1000).toISOString(),
    backup_due_at: new Date(clockMs + 29 * 86400 * 1000).toISOString(),
    handlers: [
      {
        module: 'favorites',
        online_state: 'completed',
        backup_state: 'pending',
        third_party_state: reportedThirdPartyState,
        error_code: null,
      },
    ],
  };
}

test('GY-R59 P2-b 投影优先级：不传/传 null ⇒ 逐字沿用处理器行上报值（追加前行为零改动）', () => {
  const receipt = handlerReceipt('requested');
  assert.equal(projectReceipt(receipt).handlers[0].third_party_state, 'requested');
  assert.equal(
    projectReceipt(receipt, { thirdPartyState: null }).handlers[0].third_party_state,
    'requested',
    'null 的语义是「没有可信的第三方结论」⇒ 回落处理器行，而不是把 null 当值写出去',
  );
  assert.equal(
    projectReceipt(receipt, { thirdPartyState: undefined }).handlers[0].third_party_state,
    'requested',
  );
});

test('GY-R59 P2-b 投影优先级：现算值优先于处理器行上报值（负控制 N2：写反必红）', () => {
  const receipt = handlerReceipt('requested');
  for (const state of ['not_requested', 'requested', 'confirmed', 'failed', 'unsupported']) {
    assert.equal(
      projectReceipt(receipt, { thirdPartyState: state }).handlers[0].third_party_state,
      state,
      `现算值 ${state} 必须盖过处理器行上报的 requested`,
    );
  }
});

test('GY-R59 P2-b 投影优先级：闭集外的现算值不算数（不把脏值透出契约）', () => {
  const receipt = handlerReceipt('requested');
  assert.equal(
    projectReceipt(receipt, { thirdPartyState: 'confirmed; DROP TABLE x' }).handlers[0].third_party_state,
    'requested',
    '闭集外字符串等价于「没给」⇒ 回落处理器行，⛔ 不原样透出',
  );
  assert.equal(
    projectReceipt(handlerReceipt(null), { thirdPartyState: 'bogus' }).handlers[0].third_party_state,
    null,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) 路由级：`thirdPartyStateOf()` 的三条硬约束（#10）
//    直接用**最小 Fastify** 注册路由，只替换 deps：不建库、不建账号、不跑处理器。
// ─────────────────────────────────────────────────────────────────────────────

function routeReceipt(reportedThirdPartyState = null) {
  const receipt = handlerReceipt(reportedThirdPartyState);
  return { ...receipt, id: ROUTE_ID };
}

/** 只装配 GET 需要的三件东西（`service`/`receipts`/`deletion`）+ 注入的同步来源 + 可选读侧端口。 */
async function makeRouteApp(thirdParty, reportedThirdPartyState = null, thirdPartyRows = null) {
  const receipt = routeReceipt(reportedThirdPartyState);
  const app = Fastify({ logger: false });
  registerAccountDeletionRoutes(
    app,
    loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    { requireUser: async () => {} },
    {
      // `requireWired()` 三件缺一即 503；GET 不使用 service，给个占位即可。
      service: {},
      receipts: {
        issue: async () => ({ token: 'unused', expiresAt: new Date(clockMs).toISOString() }),
        resolveRequestId: async (token) => (token === 'receipt-token' ? receipt.id : null),
      },
      deletion: {
        receipt: () => receipt,
        // 本文件不注入推导端口 ⇒ 路由的 `?.()` 直接跳过（与本片改动前一致）。
        refreshOnlineStates: undefined,
        refreshBackupStates: undefined,
      },
      thirdParty,
      thirdPartyRows,
      authService: null,
      now: () => new Date(clockMs),
    },
  );
  await app.ready();
  return app;
}

async function routeReceiptState(thirdParty, reportedThirdPartyState = null, thirdPartyRows = null) {
  const app = await makeRouteApp(thirdParty, reportedThirdPartyState, thirdPartyRows);
  try {
    const response = await app.inject({
      method: 'GET',
      url: `${API}/account/deletions/${ROUTE_ID}`,
      headers: { authorization: 'Bearer receipt-token' },
    });
    const body = response.json();
    return { status: response.statusCode, body, field: body?.data?.handlers?.[0]?.third_party_state };
  } finally {
    await app.close();
  }
}

const ROWS = {
  not_requested: [{ recipient_id: 'vendor-a', online_status: 'not_requested', backup_status: 'not_requested' }],
  requested: [{ recipient_id: 'vendor-a', online_status: 'requested', backup_status: 'requested' }],
  confirmed: [
    { recipient_id: 'vendor-a', online_status: 'confirmed', backup_status: 'confirmed', evidence_ref: 'ev-1' },
  ],
  failed: [
    { recipient_id: 'vendor-a', online_status: 'failed', backup_status: 'failed', error_code: 'THIRD_PARTY_FAILED' },
  ],
  unsupported: [{ recipient_id: 'vendor-a', online_status: 'unsupported', backup_status: 'unsupported' }],
};

test('GY-R59 P2-b 回执投影：端口行 ⇒ third_party_state 五值逐值正确', async () => {
  for (const [expected, rows] of Object.entries(ROWS)) {
    const observed = await routeReceiptState({ thirdPartyStatuses: () => rows });
    assert.equal(observed.status, 200, `${expected}：来源正常时回执必须 200`);
    assert.equal(observed.field, expected, `端口行 ${expected} ⇒ 契约字段必须逐字相同`);
  }
});

test('GY-R59 P2-b 回执投影：端口无行 ⇒ null（⛔ 不用 confirmed/not_requested 冒充"没有接收方"）', async () => {
  const observed = await routeReceiptState({ thirdPartyStatuses: () => [] });
  assert.equal(observed.status, 200);
  assert.equal(observed.field, null, '无接收方 ⇒ 契约允许 null，且不得写成 not_requested/confirmed');
});

test('GY-R59 P2-b 回执投影：来源抛异常 ⇒ 该字段 null、其余字段照常、回执仍 200（负控制 N1：去掉 try/catch 必红）', async () => {
  const observed = await routeReceiptState({
    thirdPartyStatuses() {
      throw new Error('synthetic third-party source failure');
    },
  });
  assert.equal(observed.status, 200, '第三方只是回执的一个字段：来源异常不得把整个回执打成 500');
  assert.equal(observed.field, null, '异常 ⇒ 「没有可信结论」= null');
  assert.equal(
    observed.body?.data?.handlers?.[0]?.online_state,
    'completed',
    '降级必须只落在第三方字段：同一行的在线态照常返回',
  );
});

test('GY-R59 P2-b 回执投影：来源未装配（null）⇒ 回落处理器行上报值', async () => {
  const observed = await routeReceiptState(null, 'requested');
  assert.equal(observed.status, 200);
  assert.equal(observed.field, 'requested', '没有来源时逐字沿用处理器行（追加前行为）');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) 四态端口装配（#7）——`app.thirdPartyDeletion` 就是本次真正接进注册表的那个端口
// ─────────────────────────────────────────────────────────────────────────────

test('GY-R59 P2-b 装配臂①：无注入 + 无真库 + 非 real ⇒ 未接线端口（回 null，不谎称"查过了没有接收方"）', async () => {
  const { app } = await makeStubApp();
  try {
    assert.equal(
      app.thirdPartyDeletion,
      app.userDataDeletion.thirdParty,
      '取证装饰器必须与注册表里实际使用的端口**同一个对象**',
    );
    assert.equal(await app.thirdPartyDeletion.listThirdPartyDeletions('req-x'), null, '未接线端口只能回 null');
    assert.equal(app.userDataDeletion.thirdPartyAdapter, null, '适配器本期只支持注入 ⇒ 未注入即 null');
  } finally {
    await app.close();
  }
});

test('GY-R59 P2-b 装配臂②：显式注入端口 ⇒ 逐字用它（不被真库/未接线覆盖）', async () => {
  const injected = {
    async listThirdPartyDeletions() {
      return [{ recipient_id: 'vendor-injected', online_status: 'requested', backup_status: 'requested' }];
    },
  };
  const { app } = await makeStubApp({ userDataDeletionInjection: { thirdParty: injected } });
  try {
    assert.equal(app.thirdPartyDeletion, injected, '注入优先：身份必须逐字相等');
    assert.equal(app.userDataDeletion.thirdParty, injected);
    assert.equal((await app.thirdPartyDeletion.listThirdPartyDeletions('req-x')).length, 1);
  } finally {
    await app.close();
  }
});

test('GY-R59 P2-b 装配臂③：有连接池 ⇒ 真库只读端口（persistent === true）', async () => {
  // 合成池：真被查询就抛，用来证明本用例只验**装配身份**（真库读行另有集成证据）。
  const pool = {
    async query() {
      throw new Error('synthetic pool：本用例不应发生任何查询');
    },
  };
  const { app } = await makeStubApp({ pool });
  try {
    assert.equal(app.userDataDeletion.thirdParty, app.thirdPartyDeletion);
    assert.equal(app.thirdPartyDeletion.persistent, true, '真库端口的身份标记（P2-a 的 ThirdPartyDeletionPort）');
    assert.equal(typeof app.thirdPartyDeletion.listThirdPartyDeletions, 'function');
  } finally {
    await app.close();
  }
});

test('GY-R59 P2-b 装配臂④：受理已接线 + real + 无池 ⇒ 显式不可用端口（调用即抛 PROVIDER_UNAVAILABLE，⛔ 不静默回退）', async () => {
  const app = buildApp({
    config: loadConfig(REAL_ENV),
    now: () => new Date(clockMs),
    store: createMemoryAuthStore(),
    favoritesInjection: { store: createMemoryFavoritesStore({ now: () => clockMs }) },
    historyInjection: { store: createMemoryHistoryStore({ now: () => clockMs }) },
    // 受理已接线只可能来自注入（本用例没有连接池）⇒ 走「显式不可用」臂。
    userDataDeletionInjection: { requests: {} },
  });
  try {
    assert.equal(app.userDataDeletion.thirdParty, app.thirdPartyDeletion);
    await assert.rejects(
      app.thirdPartyDeletion.listThirdPartyDeletions('req-x'),
      (error) => {
        assert.equal(error.code, 'PROVIDER_UNAVAILABLE', '必须用契约内既有安全码，读路径据实 503');
        return true;
      },
      'real + 无池：读侧必须"如实不可用"，不得静默退回内存或 unwired',
    );
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) 默认端口实现的小语义（#6）
// ─────────────────────────────────────────────────────────────────────────────

test('GY-R59 P2-b 端口默认实现：unwired 回 null、unavailable 抛 PROVIDER_UNAVAILABLE', async () => {
  assert.equal(await createUnwiredThirdPartyDeletionPort().listThirdPartyDeletions('req-x'), null);
  await assert.rejects(
    createUnavailableThirdPartyDeletionPort().listThirdPartyDeletions('req-x'),
    (error) => error.code === 'PROVIDER_UNAVAILABLE',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) 读侧真的问端口：`refreshBackupStates()` 的 blocked 复位判定（#12）
//    （负控制 N3：把缺省端口换成 unavailable 端口，本用例的"不抛"必红）
// ─────────────────────────────────────────────────────────────────────────────

/** 只读推导端口的合成实现：没有副本行 ⇒ 不推进任何模块（`modules: []`）。 */
function makeDerivationPort() {
  return {
    kind: 'postgres',
    available: true,
    async derive({ requestId }) {
      return { requestId, modules: [], overall: 'pending', missingModules: [] };
    },
  };
}

/**
 * 造一个**存储态**确实是 `blocked` 的删除请求。
 *
 * 为什么必须这样绕：`thirdPartyRowsOf()` 的两个调用点都在
 * `if (request['state'] === 'blocked')` 分支里（`user-data-deletion.ts:1174` / `:1296` 附近），
 * 而 stub 装配下正常受理的请求存储态是 `processing`（`deletion.mjs:202`）；"blocked" 平时只是
 * `completionStatus()` 的**推导**结果，不写回请求对象。让一个处理器在首次执行时抛出
 * （`deletion.mjs:190` 把抛出的模块记成 blocked、`:202` 再把请求置 blocked）是本文件唯一
 * 不碰内部 Map、又不真跑第三方写侧（P2-c）就能到达读侧的构造方式。
 *
 * ⛔ 这不是"为了绿而改被测对象"：处理器 blocked 是**既有**的事实（注入 store 抛错），
 * 请求因此 blocked 也是既有状态机给出的结论；第三方读侧正是在这个分支里被问到的。
 */
function makeBlockedApp(thirdParty) {
  const favorites = createMemoryFavoritesStore({ now: () => clockMs });
  return makeStubApp({
    // 只让删除动作抛：列表/详情等其它动作保持真实内存实现，避免把无关路径一起打坏。
    favoritesInjection: {
      store: {
        ...favorites,
        async deleteAllByOwner() {
          throw new Error('synthetic favorites delete failure');
        },
      },
    },
    userDataDeletionInjection: {
      backupStates: makeDerivationPort(),
      ...(thirdParty === undefined ? {} : { thirdParty }),
    },
  });
}

test('GY-R59 P2-b 读侧：blocked 请求会**真的**问端口（注入端口收到 requestId）', async () => {
  const calls = [];
  const { app, session } = await makeBlockedApp({
    async listThirdPartyDeletions(requestId) {
      calls.push(requestId);
      return [];
    },
  });
  try {
    const { id, initialState } = await startDeletion(app, session.token, 'k-tpd-read-spy');
    assert.equal(initialState, 'blocked', '前提：处理器抛错 ⇒ 受理回执如实 blocked');
    assert.equal(app.userDataDeletion.coordinator.getRequest(id).state, 'blocked', '前提：存储态也是 blocked');
    const refreshed = await app.userDataDeletion.refreshBackupStates(id);
    assert.notEqual(refreshed, null, '接线的推导端口 + 已受理请求 ⇒ 必须真的走完成');
    assert.deepEqual(calls, [id], '读侧必须按 requestId 问一次端口（⛔ 不拿进程内行冒充持久事实）');
    // 处理器仍 blocked ⇒ 不得复位；端口返回空行也不会被当成"第三方没问题"。
    assert.equal(refreshed.stateReset, false, '还有 blocked 的处理器 ⇒ 不得复位成 processing');
  } finally {
    await app.close();
  }
});

test('GY-R59 P2-b 读侧：未接线端口 ⇒ refreshBackupStates 不抛（回退进程内行；负控制 N3：换成 unavailable 必红）', async () => {
  const { app, session } = await makeBlockedApp();
  try {
    const { id } = await startDeletion(app, session.token, 'k-tpd-read-unwired');
    const refreshed = await app.userDataDeletion.refreshBackupStates(id);
    assert.notEqual(refreshed, null);
    assert.equal(refreshed.stateReset, false, '处理器仍 blocked ⇒ 不复位（第三方未接线不改变这条结论）');
    assert.deepEqual(app.userDataDeletion.coordinator.thirdPartyStatuses(id), [], '进程内第三方行仍为空');
  } finally {
    await app.close();
  }
});

test('GY-R59 P2-b 读侧：显式不可用端口 ⇒ refreshBackupStates 抛出（⛔ 不把"读不到"折叠成"没有接收方"）', async () => {
  const { app, session } = await makeBlockedApp(createUnavailableThirdPartyDeletionPort());
  try {
    const { id } = await startDeletion(app, session.token, 'k-tpd-read-unavailable');
    await assert.rejects(
      app.userDataDeletion.refreshBackupStates(id),
      (error) => error.code === 'PROVIDER_UNAVAILABLE',
      '读不到第三方行时必须抛（路由据实 503），⛔ 不得静默当成"没有接收方"继续推进',
    );
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6) 端到端（④ 的反面）：协议第三方行 ⇒ GET 回执 third_party_state 逐态可见
// ─────────────────────────────────────────────────────────────────────────────

test('GY-R59 P2-b 端到端：同一删除请求的第三方态经协调器 ⇒ 回执逐态可见（追加前恒 null）', async () => {
  const { app, session } = await makeStubApp();
  try {
    const coordinator = app.userDataDeletion.coordinator;
    const cases = [
      ['requested', (id) => coordinator.requestThirdPartyDeletion({ requestId: id, recipientId: 'vendor-e2e' })],
      [
        'confirmed',
        (id) => {
          coordinator.requestThirdPartyDeletion({ requestId: id, recipientId: 'vendor-e2e' });
          coordinator.confirmThirdPartyDeletion({ requestId: id, recipientId: 'vendor-e2e', evidenceRef: 'ev-e2e' });
        },
      ],
      [
        'failed',
        (id) => {
          coordinator.requestThirdPartyDeletion({ requestId: id, recipientId: 'vendor-e2e' });
          coordinator.failThirdPartyDeletion({ requestId: id, recipientId: 'vendor-e2e' });
        },
      ],
      [
        'unsupported',
        (id) => {
          coordinator.requestThirdPartyDeletion({ requestId: id, recipientId: 'vendor-e2e' });
          coordinator.markUnsupported({ requestId: id, recipientId: 'vendor-e2e' });
        },
      ],
    ];

    for (const [expected, seed] of cases) {
      const { id, receiptToken } = await startDeletion(app, session.token, `k-tpd-e2e-${expected}`);
      // 反证 ④：**协议回执本身**永远上报 null（`third_party_state` 只在 handler 行上，且没人写它）。
      assert.equal(
        app.userDataDeletion.receipt(id).handlers[0].third_party_state,
        null,
        '协议回执的 handler 行不含第三方结论 ⇒ 不重算就恒 null（正是 ④）',
      );
      seed(id);
      const response = await getReceipt(app, id, receiptToken);
      assert.equal(response.statusCode, 200);
      assert.equal(
        response.json().data.handlers[0].third_party_state,
        expected,
        `协议第三方行 ${expected} ⇒ 回执必须读出 ${expected}`,
      );
    }
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7) 取消回执（设计点名的两处之外，本片多接的一处：同一请求只有一份投影）
// ─────────────────────────────────────────────────────────────────────────────

test('GY-R59 P2-b 端到端：取消回执同样带现算的第三方态（⛔ 取消后不回落 null）', async () => {
  const { app, session } = await makeStubApp();
  try {
    const { id } = await startDeletion(app, session.token, 'k-tpd-e2e-cancel');
    app.userDataDeletion.coordinator.requestThirdPartyDeletion({ requestId: id, recipientId: 'vendor-e2e' });
    const cancelled = await app.inject({
      method: 'DELETE',
      url: DELETION_PATH,
      headers: { authorization: `Bearer ${session.token}`, 'idempotency-key': 'k-tpd-e2e-cancel-delete' },
    });
    assert.equal(cancelled.statusCode, 200, '在途请求可取消 ⇒ 200');
    const body = cancelled.json();
    assert.equal(body.data.state, 'cancelled');
    assert.equal(
      body.data.handlers[0].third_party_state,
      'requested',
      '取消只改请求状态，不改第三方事实：取消回执必须与取消前的 GET 逐字一致（同源投影）',
    );
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8) 读侧端口 → 回执（(b) 方案：路由内 `await` 取行**一次**，再喂同步投影）
//    设计 §2 ④ 的症状（"端口接线了，回执仍恒 null"）就在这里被真正修掉：
//    ⛔ 不是把端口当同步源用，也不是给投影加异步；是取行 + 同步闭包这一层机关。
// ─────────────────────────────────────────────────────────────────────────────

/** 真库端口行的口径（`third-party-deletion-pg.ts::ThirdPartyDeletionRecord`，camelCase）。 */
function portRows(requestId) {
  const requestedAt = new Date(clockMs - 60 * 1000).toISOString();
  return [
    {
      requestId,
      recipientId: 'vendor-online',
      exportRef: 'exp-1',
      onlineState: 'confirmed',
      backupState: 'confirmed',
      requestedAt,
      confirmedAt: new Date(clockMs - 30 * 1000).toISOString(),
      evidenceRef: 'ev-9',
      errorCode: null,
    },
    {
      requestId,
      recipientId: 'vendor-pending',
      exportRef: null,
      onlineState: 'requested',
      backupState: 'requested',
      requestedAt,
      confirmedAt: null,
      evidenceRef: null,
      errorCode: null,
    },
  ];
}

test('GY-R59 P2-b 端口行驱动回执：camelCase 端口行 ⇒ third_party_state 由端口给出（不是处理器行的 null）', async () => {
  const seen = [];
  const port = {
    persistent: true,
    async listThirdPartyDeletions(requestId) {
      seen.push(requestId);
      return portRows(requestId);
    },
  };
  const observed = await routeReceiptState(null, null, port);
  assert.equal(observed.status, 200);
  assert.deepEqual(seen, [ROUTE_ID], '端口必须按回执的请求 id 取行，且当次请求只取一次');
  assert.equal(observed.field, 'requested', '一行 confirmed ＋ 一行 requested ⇒ 聚合态 requested');
});

test('GY-R59 P2-b 端口行驱动回执：两行都 confirmed ⇒ confirmed（端口行是结论的事实来源）', async () => {
  // `confirmed` 是**带时间与证据的结论**，不是一句状态字节：`toReceiptState()` 只在
  // `confirmed_at` 与 `evidence_ref` 都给全时才把阶段读成 completed（见
  // `third-party-deletion-projection.ts::projectPhase` 的 `evidenceOk`）——只把状态写成
  // confirmed、却把证据留空的行，投影按 `requested` 读，这是既有协议口径，不是本片放宽的。
  const port = {
    persistent: true,
    async listThirdPartyDeletions(requestId) {
      return portRows(requestId).map((row) => ({
        ...row,
        onlineState: 'confirmed',
        backupState: 'confirmed',
        confirmedAt: new Date(clockMs - 20 * 1000).toISOString(),
        evidenceRef: 'ev-9',
      }));
    },
  };
  const observed = await routeReceiptState(null, null, port);
  assert.equal(observed.status, 200);
  assert.equal(observed.field, 'confirmed', '端口说两行都确认 ⇒ 回执必须读成 confirmed');
});

test('GY-R59 P2-b 端口行双拼写：`online_status` 与 `onlineState` 同时存在且不同 ⇒ 取 snake_case', async () => {
  // 优先级 = **协议口径优先**：`toProjectionRows()` 的 `pick(snake, camel) = row[snake] ?? row[camel]`。
  // 理由：`ThirdPartyProjectionSource.thirdPartyStatuses()` 的权威口径就是 snake_case
  // （`projectThirdPartyDeletion()` 只读 `online_status`/`backup_status`/…），camelCase 只是
  // PG 端口（`ThirdPartyDeletionRecord`）的传输拼写。两者同时出现说明有人把"传输形状"和
  // "协议形状"混在一行里，此时必须让**协议口径**赢，否则同一行会被两种拼写解释成两个结论
  // （本例：snake 说 confirmed、camel 说 failed），回执就会随机漂移。
  const port = {
    persistent: true,
    async listThirdPartyDeletions(requestId) {
      return portRows(requestId).map((row) => ({
        ...row,
        online_status: 'confirmed',
        onlineState: 'failed',
        backup_status: 'confirmed',
        backupState: 'failed',
        confirmed_at: new Date(clockMs - 10 * 1000).toISOString(),
        confirmedAt: null,
        evidence_ref: 'ev-dup',
        evidenceRef: null,
      }));
    },
  };
  const observed = await routeReceiptState(null, null, port);
  assert.equal(observed.status, 200);
  assert.equal(
    observed.field,
    'confirmed',
    '双键同存时 snake_case（协议口径）胜出；若取 camelCase 会读成 failed',
  );
});

test('GY-R59 P2-b 端口抛错 ⇒ 该字段 null、回执仍 200（⛔ 不 500；real 无池时这是唯一安全降级）', async () => {
  const port = {
    async listThirdPartyDeletions() {
      throw new Error('synthetic third-party port failure');
    },
  };
  const observed = await routeReceiptState(null, null, port);
  assert.equal(observed.status, 200, '端口读失败只降级第三方字段，不得把整个回执打成 500');
  assert.equal(observed.field, null, '读不到行 ⇒ 没有可信结论 = null');
  assert.equal(observed.body?.data?.handlers?.[0]?.online_state, 'completed', '同一行其余字段照常返回');
});

test('GY-R59 P2-b 端口抛错但装了同步来源 ⇒ 回退同步来源（读不到端口行 ≠ 没有结论）', async () => {
  const port = {
    async listThirdPartyDeletions() {
      throw new Error('synthetic third-party port failure');
    },
  };
  const observed = await routeReceiptState({ thirdPartyStatuses: () => ROWS.requested }, null, port);
  assert.equal(observed.status, 200);
  assert.equal(observed.field, 'requested', '端口不可读时，装配好的同步来源仍然给得出结论');
});

test('GY-R59 P2-b 路由层：注入端口抛错 ⇒ GET 回执仍 200 且该字段 null（⛔ 不 500）', async () => {
  // 与用例「端口抛错 ⇒ 200」的区别：那条走最小路由夹具，这条走**完整 buildApp 装配**
  // （app.ts 的 `thirdPartyRows` 真的被传给路由），证明降级发生在生产形状的装配上。
  const port = {
    persistent: true,
    async listThirdPartyDeletions() {
      throw new Error('synthetic third-party port failure at route level');
    },
  };
  const { app, session } = await makeStubApp({ userDataDeletionInjection: { thirdParty: port } });
  try {
    const { id, receiptToken } = await startDeletion(app, session.token, 'k-tpd-route-throw');
    const response = await getReceipt(app, id, receiptToken);
    assert.equal(response.statusCode, 200, '第三方读失败只是该字段降级，回执整体仍 200');
    assert.equal(response.json().data.handlers[0].third_party_state, null);
  } finally {
    await app.close();
  }
});

test('GY-R59 P2-b 路由层：读侧端口不可用 ⇒ GET 回执 503 PROVIDER_UNAVAILABLE（⛔ 不假装已复位）', async () => {
  // 与 `thirdPartyStateOf()` 的 `null` 口径**刻意不同**：那条路是回执字段投影（降级为 null），
  // 这条路是 `refreshBackupStates()` 的 blocked 复位判定 —— 读不到第三方行就**不许**复位，
  // 异常冒泡到路由 ⇒ 503 + `PROVIDER_UNAVAILABLE`。两种失败观都写成断言，不留成注释。
  const { app, session } = await makeBlockedApp(createUnavailableThirdPartyDeletionPort());
  try {
    const { id, receiptToken } = await startDeletion(app, session.token, 'k-tpd-route-503');
    const response = await getReceipt(app, id, receiptToken);
    assert.equal(response.statusCode, 503, '读侧端口不可用 ⇒ 回执读面如实 503');
    assert.equal(response.json().error.code, 'PROVIDER_UNAVAILABLE');
  } finally {
    await app.close();
  }
});

test('GY-R59 P2-b 时钟回归：注入的 clock 晚于 requested_at ⇒ 仍能取值（投影自取系统时间必红）', async () => {
  // 判别力（与**跑测试的日期完全解耦**）：本文件所有时刻都由 `clockMs`（2100-01-01Z）推导，
  // 回执的 `requested_at` = clockMs - 60s，即**远在未来**。实现若把 `now` 退回缺省（系统时钟），
  // 投影看到 `requestedAt ≫ now` ⇒ 时间线不可信 ⇒ 整段 fail-closed ⇒ 字段变 null。
  //
  // 本用例用两个断言把这条判别力钉死：
  //   a) 走真实路由（`deps.now()` = clockMs）⇒ 必须取到 `requested`；
  //   b) 同一请求、同一来源、**不传 now** ⇒ 必须 `null`（判別力自检，不依赖墙钟）；
  //      ⇒ 实现若改成自取系统时间，(a) 必然退化成 null 而变红。
  // 负控制（可重跑）：删掉 `routes/account-deletion.ts::thirdPartyStateOf()` 里的 `now: deps.now(),`
  // 一行 ⇒ (a) 拿到 null ⇒ 本用例红。
  const syncSource = { thirdPartyStatuses: () => ROWS.requested };
  const requestedAt = handlerReceipt(null).requested_at;
  const observed = await routeReceiptState(syncSource);
  assert.equal(observed.status, 200);
  assert.equal(observed.field, 'requested', '窗口判定必须与回执同一个时钟，不得用系统时间');
  assert.equal(
    thirdPartyReceiptState({ source: syncSource, requestId: ROUTE_ID, requestedAt }),
    null,
    '判别力自检：不传注入时钟时必须 fail-closed（⇒ 实现若自取系统时间，上面那条就会红）',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 9) 装配层把端口交给路由（`thirdPartyRows`）——同一份传递代码，mode 不参与
// ─────────────────────────────────────────────────────────────────────────────

test('GY-R59 P2-b 装配：注入 persistent 端口 ⇒ 回执由端口行驱动（端到端，不落 handler 的 null）', async () => {
  // ⚠ 本用例**不传 pool**：有连接池时注销受理走真库台账（`privacy/deletion-requests-pg.ts`
  // 的 `createRequest`），合成池必然 503 `PROVIDER_UNAVAILABLE`（既有装配行为，与本片无关，
  // 见报告「未跑什么」一节）。真正的「真库臂」只能由 CI 的真 Postgres 证明；
  // 这里用同一形状（`persistent: true` + camelCase 行）的注入端口证明**传递与投影**这段代码。
  const calls = [];
  const port = {
    persistent: true,
    async listThirdPartyDeletions(requestId) {
      calls.push(requestId);
      return portRows(requestId);
    },
  };
  const { app, session } = await makeStubApp({ userDataDeletionInjection: { thirdParty: port } });
  try {
    assert.equal(app.thirdPartyDeletion, port, '注入即用：身份必须逐字相等（装配臂②）');
    const { id, receiptToken } = await startDeletion(app, session.token, 'k-tpd-e2e-port');
    assert.equal(
      app.userDataDeletion.receipt(id).handlers[0].third_party_state,
      null,
      '反证 ④：协议回执自己永远不带第三方结论',
    );
    const response = await getReceipt(app, id, receiptToken);
    assert.equal(response.statusCode, 200);
    assert.equal(
      response.json().data.handlers[0].third_party_state,
      'requested',
      'app.ts 传给路由的 `thirdPartyRows` 必须真的被用来取行（否则这里恒 null）',
    );
    assert.ok(calls.includes(id), '取行必须发生在这次 GET 里，且用的是这个删除请求的 id');
  } finally {
    await app.close();
  }
});

test('GY-R59 P2-b 装配：real + 有连接池 + 注入 persistent 端口 ⇒ 端口身份落在注入臂（real 面仍 503 是既有门）', async () => {
  const pool = {
    async query() {
      throw new Error('synthetic pool：本用例不应发生任何查询');
    },
  };
  const port = {
    persistent: true,
    async listThirdPartyDeletions(requestId) {
      return portRows(requestId);
    },
  };
  const app = buildApp({
    config: loadConfig(REAL_ENV),
    now: () => new Date(clockMs),
    pool,
    store: createMemoryAuthStore(),
    favoritesInjection: { store: createMemoryFavoritesStore({ now: () => clockMs }) },
    historyInjection: { store: createMemoryHistoryStore({ now: () => clockMs }) },
    userDataDeletionInjection: { requests: {}, thirdParty: port },
  });
  try {
    assert.equal(app.thirdPartyDeletion, port, 'real + 有池 + 注入 ⇒ 注入臂优先（⛔ 不被真库臂顶掉）');
    assert.equal(app.userDataDeletion.thirdParty, port, '注册表里用的必须是同一个端口对象');
    assert.equal(app.thirdPartyDeletion.persistent, true);
  } finally {
    await app.close();
  }
});
