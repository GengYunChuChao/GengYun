// GY-R72 · 注销受理回执（202）与后续 GET／取消（DELETE）**同一套第三方删除口径**的机器取证。
//
// 缺陷（改前）：`services/api/src/privacy/account-deletion.ts::request()` 在受理时
// `projectReceipt(input.deletion.receipt(requestId))` **不带 options** ⇒ 第三方态不参与计算，
// 于是 202 里的 `third_party_state` 恒为协议处理器行上报的 `null`（= 「没有可信结论」），
// 而紧接着的 `GET /account/deletions/:id` 会现算成 `requested`/`confirmed` ⇒ 同一请求两套回执。
//
// 本文件锁住四条（T1–T4）：
//   T1  同一请求：POST 202 的 `third_party_state` 向量 === 紧随其后 GET 的同一向量（两种状态都覆盖：
//       有第三方行 ⇒ `requested`；无第三方行 ⇒ `null`）；
//   T2  第三方读侧端口抛错 ⇒ 202 的 `third_party_state === null` 且 **HTTP 仍 202**（⛔ 不是 500/503）；
//   T3  `projectReceipt()` 不传 options 的**老路径**逐字不变（既有 fixture 断言逐字相等，
//       且 `createAccountDeletionRequestService` 不带读取器时与 `projectReceipt(receipt)` 逐字相等）；
//   T4  取消（DELETE）路径的读数不受影响：取消前后与 GET 同一口径。
//
// ── 负控制（改一行就必须变红的可重跑说明）──────────────────────────────────────────────
// R1. 把 `services/api/src/routes/account-deletion.ts` 受理处（`produce` 里的 `service.request()`
//     调用）改回只传 `{ userId, receiptInput }`（不传 `readThirdPartyState`）⇒ T1「有第三方行」
//     变红（202 = null，GET = requested）。
// R2. 把 `services/api/src/routes/account-deletion.ts::thirdPartyRowsFor()` 的
//     `try { … } catch { return null; }` 改成不捕获（异常冒泡）⇒ T2 变红（202 变成 500）。
//     ⚠ 该函数的 `await` 在 `thirdPartyStateOf()` 的 try **之外**，所以这是唯一能让异常打到 202 的开关。
// R3. 把受理处改成「另造一套口径」（例如直接读 `deps.thirdParty.thirdPartyStatuses(requestId)`
//     而不走 `thirdPartyStateOf()`）⇒ T1 在**行存在**的臂上可能仍绿，但 T2（端口抛错）与
//     T3（老路径逐字）会露馅：另造口径要么绕过 fail-closed（T2 红），要么改动了 `projectReceipt()`
//     的默认语义（T3 红）。若三条都红不出来，说明这条负控制无效 —— 报告里如实写清。
//
// ── 本文件**不**覆盖的东西（如实写清，不冒充）─────────────────────────────────────────
// * 真库臂（`createPostgresThirdPartyDeletionPort()`）未跑：本文件用**注入端口**（进程内、无库、无网）。
// * 202 与 GET 之间仍有**时间窗**：两次读各按当时的行/时钟投影，行本身在窗口内变化时两者可以不同；
//   本文件断言的是「同一口径 + 同一份行 ⇒ 同一读数」，不是「时间冻结」。
// * 写侧（谁在何时 dispatch 给第三方）不在本片；本文件只读。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import {
  createAccountDeletionRequestService,
  projectReceipt,
} from '../../services/api/src/privacy/account-deletion.ts';

const API = '/api/v1';
const DELETION_PATH = `${API}/me/account/deletion`;
// 远未来固定基准（`2100-01-01T00:00:00Z`）：与跑测试的真实日期完全解耦（同 `third-party-deletion-wiring.test.mjs`）。
const clockMs = Date.parse('2100-01-01T00:00:00.000Z');

/** 合成身份：不经过微信换取、不产生任何外网调用。 */
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

/** stub 装配（无真库、无映射池）+ 可选注入项（这里只用 `userDataDeletionInjection.thirdParty`）。 */
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
  const session = await seedSession(authStore, 'r72-parity');
  return { app, authStore, session };
}

/** 受理（202）并返回完整响应：既有用例的 `startDeletion` 只取 id/bearer，这里要读 `handlers[]`。 */
async function acceptDeletion(app, token, key) {
  const response = await app.inject({
    method: 'POST',
    url: DELETION_PATH,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
    payload: { confirmation: 'delete_account' },
  });
  return { status: response.statusCode, body: response.json() };
}

async function readReceipt(app, id, receiptToken) {
  const response = await app.inject({
    method: 'GET',
    url: `${API}/account/deletions/${id}`,
    headers: { authorization: `Bearer ${receiptToken}` },
  });
  return { status: response.statusCode, body: response.json() };
}

/** 契约字段的**逐处理器向量**：`[模块, third_party_state]`（顺序即回执顺序，便于逐字比对）。 */
function thirdPartyVector(receipt) {
  const handlers = Array.isArray(receipt?.handlers) ? receipt.handlers : [];
  return handlers.map((handler) => [handler.module, handler.third_party_state]);
}

/** 第三方读侧端口的合成实现（`ThirdPartyDeletionReadPort`：只读行，不落库、不联网）。 */
function readPort(rows) {
  return {
    async listThirdPartyDeletions() {
      return rows;
    },
  };
}

const ROW_REQUESTED = [
  { recipient_id: 'vendor-a', online_status: 'requested', backup_status: 'requested' },
];

// ─────────────────────────────────────────────────────────────────────────────
// T1 · 同一请求：202 与紧随其后的 GET 必须是**同一套**第三方口径
// ─────────────────────────────────────────────────────────────────────────────

test('T1a 有第三方行：POST 202 的 third_party_state 向量 === 紧随其后 GET 的向量（负控制 R1：受理处不传读取器必红）', async () => {
  const { app, session } = await makeStubApp({
    userDataDeletionInjection: { thirdParty: readPort(ROW_REQUESTED) },
  });
  try {
    const accepted = await acceptDeletion(app, session.token, 'r72-t1a-accept-0001');
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));

    const receipt = accepted.body.data.deletion;
    const after = await readReceipt(app, receipt.id, accepted.body.data.receipt_token);
    assert.equal(after.status, 200, JSON.stringify(after.body));

    const acceptedVector = thirdPartyVector(receipt);
    const fetchedVector = thirdPartyVector(after.body.data);

    assert.deepEqual(
      acceptedVector,
      fetchedVector,
      `同一请求的两条回执必须是同一套第三方口径：202=${JSON.stringify(acceptedVector)} GET=${JSON.stringify(fetchedVector)}`,
    );
    // 不只是「两边相同」，还要是**对的那个值**：端口有 `requested` 行 ⇒ 两边都得是 `requested`。
    assert.ok(acceptedVector.length > 0, '回执必须带 handlers（否则下面的断言是空转）');
    for (const [module, state] of acceptedVector) {
      assert.equal(state, 'requested', `${module}：端口行 requested ⇒ 202 也必须是 requested（改前这里是 null）`);
    }
  } finally {
    await app.close();
  }
});

test('T1b 无第三方行：POST 202 与 GET 同为 null（⛔ 不用 not_requested/confirmed 冒充「没有接收方」）', async () => {
  const { app, session } = await makeStubApp({ userDataDeletionInjection: { thirdParty: readPort([]) } });
  try {
    const accepted = await acceptDeletion(app, session.token, 'r72-t1b-accept-0001');
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));

    const receipt = accepted.body.data.deletion;
    const after = await readReceipt(app, receipt.id, accepted.body.data.receipt_token);
    assert.equal(after.status, 200, JSON.stringify(after.body));

    const acceptedVector = thirdPartyVector(receipt);
    const fetchedVector = thirdPartyVector(after.body.data);
    assert.deepEqual(acceptedVector, fetchedVector);
    assert.ok(acceptedVector.length > 0);
    for (const [module, state] of acceptedVector) {
      assert.equal(state, null, `${module}：没有接收方行 ⇒ 两边都必须是 null`);
    }
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T2 · 端口抛错 ⇒ fail-closed：字段 null、HTTP 仍 202（负控制 R2：去掉 catch 必红）
// ─────────────────────────────────────────────────────────────────────────────

test('T2 第三方端口抛错 ⇒ 202 的 third_party_state === null 且 HTTP 仍 202（不是 500/503）', async () => {
  const exploding = {
    async listThirdPartyDeletions() {
      throw new Error('synthetic third-party read failure (GY-R72 T2)');
    },
  };
  const { app, session } = await makeStubApp({ userDataDeletionInjection: { thirdParty: exploding } });
  try {
    const accepted = await acceptDeletion(app, session.token, 'r72-t2-accept-0001');
    assert.equal(
      accepted.status,
      202,
      `第三方查询只是回执的一个字段：端口抛错不得把受理打挂（实际 ${accepted.status}：${JSON.stringify(accepted.body)}）`,
    );
    assert.equal(typeof accepted.body?.data?.receipt_token, 'string', 'fail-closed 只落字段，不否决受理（回执照签）');
    const vector = thirdPartyVector(accepted.body.data.deletion);
    assert.ok(vector.length > 0);
    for (const [module, state] of vector) {
      assert.equal(state, null, `${module}：端口抛错 ⇒ 「没有可信结论」= null`);
    }
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 · 向后兼容：`projectReceipt()` 不传 options 的老路径逐字不变
// ─────────────────────────────────────────────────────────────────────────────

/** 既有 fixture（与 `third-party-deletion-wiring.test.mjs::handlerReceipt()` 同形同值）。 */
function legacyReceipt() {
  return {
    id: 'req-legacy',
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
        third_party_state: 'requested',
        error_code: null,
      },
    ],
  };
}

/** 手写期望值（不调用被测函数生成，避免「自己和自己相等」）。 */
function legacyExpected() {
  return {
    id: 'req-legacy',
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
        third_party_state: 'requested',
        error_code: null,
      },
    ],
  };
}

test('T3a projectReceipt() 不传 options ⇒ 逐字沿用处理器行上报值（既有 fixture 逐字相等）', () => {
  const receipt = legacyReceipt();
  assert.deepEqual(projectReceipt(receipt), legacyExpected());
  // 等价写法（`{}` / `undefined` / `thirdPartyState: null`）也必须逐字相同：
  assert.deepEqual(projectReceipt(receipt, {}), legacyExpected());
  assert.deepEqual(projectReceipt(receipt, { thirdPartyState: undefined }), legacyExpected());
  assert.deepEqual(projectReceipt(receipt, { thirdPartyState: null }), legacyExpected());
  assert.equal(projectReceipt(null), null, 'null 回执仍回 null（404 的依据不变）');
});

test('T3b 受理服务不带读取器（既有调用点）⇒ 投影与 projectReceipt(receipt) 逐字相等', async () => {
  const receipt = legacyReceipt();
  const registry = {
    requiredModules: () => ['favorites'],
    requestDeletionFor: () => ({ id: receipt.id }),
    executeHandlers: async () => ({ id: receipt.id }),
    receipt: () => receipt,
    cancelDeletion: () => null,
  };
  const service = createAccountDeletionRequestService({
    deletion: registry,
    receipts: { issue: async () => ({ token: 'r72-t3-token', expiresAt: new Date(clockMs).toISOString() }) },
  });

  const withoutReader = await service.request({ userId: 'u-legacy', receiptInput: 'r-legacy-1' });
  assert.deepEqual(
    withoutReader.deletion,
    projectReceipt(receipt),
    '不带读取器时必须走 projectReceipt(receipt)（不传 options）',
  );
  assert.deepEqual(withoutReader.deletion, legacyExpected(), '老路径逐字不变');
  assert.equal(withoutReader.receipt_token, 'r72-t3-token');

  // 显式传 `null` 与「不传」同义（`readThirdPartyState ?? null`）：不得偷偷改成现算。
  const withNullReader = await service.request({
    userId: 'u-legacy',
    receiptInput: 'r-legacy-2',
    readThirdPartyState: null,
  });
  assert.deepEqual(withNullReader.deletion, withoutReader.deletion);
});

// ─────────────────────────────────────────────────────────────────────────────
// T4 · 取消（DELETE）路径的读数不受影响
// ─────────────────────────────────────────────────────────────────────────────

test('T4 取消（DELETE）路径：取消前的 GET、取消的响应、取消后的 GET 是同一套第三方口径', async () => {
  const { app, session } = await makeStubApp({
    userDataDeletionInjection: { thirdParty: readPort(ROW_REQUESTED) },
  });
  try {
    const accepted = await acceptDeletion(app, session.token, 'r72-t4-accept-0001');
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    const receipt = accepted.body.data.deletion;

    const before = await readReceipt(app, receipt.id, accepted.body.data.receipt_token);
    assert.equal(before.status, 200, JSON.stringify(before.body));

    const cancelled = await app.inject({
      method: 'DELETE',
      url: DELETION_PATH,
      headers: { authorization: `Bearer ${session.token}`, 'idempotency-key': 'r72-t4-cancel-0001' },
    });
    assert.equal(cancelled.statusCode, 200, JSON.stringify(cancelled.json()));
    const cancelledBody = cancelled.json();
    assert.equal(cancelledBody.data.state, 'cancelled', '取消必须真的取消');

    assert.deepEqual(
      thirdPartyVector(cancelledBody.data),
      thirdPartyVector(before.body.data),
      '取消（DELETE）的第三方口径必须与取消前 GET 相同',
    );
    assert.deepEqual(thirdPartyVector(receipt), thirdPartyVector(cancelledBody.data), '202 也必须同一口径');

    const after = await readReceipt(app, receipt.id, accepted.body.data.receipt_token);
    assert.equal(after.status, 200, JSON.stringify(after.body));
    assert.equal(after.body.data.state, 'cancelled');
    assert.deepEqual(thirdPartyVector(after.body.data), thirdPartyVector(cancelledBody.data));
    for (const [module, state] of thirdPartyVector(after.body.data)) {
      assert.equal(state, 'requested', `${module}：端口行不变 ⇒ 取消前后都是 requested`);
    }
  } finally {
    await app.close();
  }
});
