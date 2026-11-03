// GY-R72 · 注销受理回执（202）与后续 GET／取消（DELETE）**同一套第三方删除口径**的机器取证。
//
// 缺陷（改前）：`services/api/src/privacy/account-deletion.ts::request()` 在受理时
// `projectReceipt(input.deletion.receipt(requestId))` **不带 options** ⇒ 第三方态不参与计算，
// 于是 202 里的 `third_party_state` 恒为协议处理器行上报的 `null`（= 「没有可信结论」），
// 而紧接着的 `GET /account/deletions/:id` 会现算成 `requested`/`confirmed` ⇒ 同一请求两套回执。
//
// 本文件锁住五条（T1–T4 行为 + T5 结构钉子）：
//   T1  同一请求：POST 202 的 `third_party_state` 向量 === 紧随其后 GET 的同一向量（两种状态都覆盖：
//       有第三方行 ⇒ `requested`；无第三方行 ⇒ `null`）；
//   T2  第三方读侧端口抛错 ⇒ 202 的 `third_party_state === null` 且 **HTTP 仍 202**（⛔ 不是 500/503）；
//   T3  `projectReceipt()` 不传 options 的**老路径**逐字不变（既有 fixture 断言逐字相等，
//       且 `createAccountDeletionRequestService` 不带读取器时与 `projectReceipt(receipt)` 逐字相等）；
//   T4  取消（DELETE）路径的读数不受影响：取消前后与 GET 同一口径。
//   T5  **结构钉子**（纯源码切片 + 文本断言；不按行号，故别人合法插行不会假红；不连库）：
//       受理读口只允许**一个实现** —— 路由里 `readThirdPartyState:` 只出现 1 次且右值必须是
//       `thirdPartyStateOf.bind(null, deps)`；`projectReceiptForAccepted()` 只定义 1 处、且其中
//       「老路径」分支调用的是**不带 options** 的 `projectReceipt(receipt)`；`thirdPartyStateOf()`
//       只定义 1 处、`catch { return null; }` 仍只在读侧那两处（fail-closed 单一实现）。
//       ⇒ 专门堵住 R3a 实测抓不到的洞：「复制一份等价实现」行为全绿但结构已分叉。
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
//     ⚠ 实测：把受理处换成**等价的匿名箭头**（`(rid, rc) => thirdPartyStateOf(deps, rid, rc)`）
//     ⇒ T1–T4 **全绿**（读数一模一样），只有 T5 会红。这就是加 T5 的原因。
// R4. 把受理那行的右值改成等价的匿名箭头（同上）⇒ T5 必红（右值不是 `thirdPartyStateOf.bind(null, deps)`
//     且右值里出现 `=>`），而 T1–T4 仍全绿。还原后必须回到基线 sha256。
//
// ── 本文件**不**覆盖的东西（如实写清，不冒充）─────────────────────────────────────────
// * 真库臂（`createPostgresThirdPartyDeletionPort()`）未跑：本文件用**注入端口**（进程内、无库、无网）。
// * 202 与 GET 之间仍有**时间窗**：两次读各按当时的行/时钟投影，行本身在窗口内变化时两者可以不同；
//   本文件断言的是「同一口径 + 同一份行 ⇒ 同一读数」，不是「时间冻结」。
// * 写侧（谁在何时 dispatch 给第三方）不在本片；本文件只读。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

test('T1b 无第三方行 + 本部署不可派发：POST 202 与 GET 同为 unsupported（⛔ 不用 not_requested/confirmed 冒充「没有接收方」）', async () => {
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
    /**
     * GY-R74 真值变更（不是放宽）：本臂的装配**不具备派发能力**（没有写端口／适配器／收件人来源，
     * 见 `services/api/src/app.ts` 把 `thirdPartyWritable` 传成 `false`），于是「零接收方」不再等于
     * 「没有可信结论」（`null`）——它等于「这台机器发不出去、也无法证实」，回执照实报 `'unsupported'`
     * （契约 `ThirdPartyState` 闭集内，语义正是「做不到／无法证实」）。
     *
     * 旧口径（`null`）写于 #860 合入时：那时回执没有任何能力信号可用，`null` 是唯一不撒谎的取值。
     * GY-R74 把能力信号接到受理链上之后，生产（`real`）回执仍报 `null` 就等于把「做不到」说成
     * 「不知道」，与「回执必须能读出未完成原因」的产品要求相反 ⇒ 本条按新真值改写。
     * ⛔ 没有放松的部分：仍钉住 ① POST 202 与 GET 两条回执**逐处理器相同**；② 不许出现
     * `not_requested`（等于替用户说「不需要删」）；③ 不许出现 `confirmed`（无任何第三方证据）。
     */
    for (const [module, state] of acceptedVector) {
      assert.equal(state, 'unsupported', `${module}：没有接收方行 + 不可派发 ⇒ 两边都必须是 unsupported`);
      assert.notEqual(state, 'confirmed', `${module}：没有真实第三方证据 ⇒ ⛔ 不得为 confirmed`);
      assert.notEqual(state, 'not_requested', `${module}：⛔ 不得替用户说「不需要删」`);
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

// ─────────────────────────────────────────────────────────────────────────────
// T5 · 结构钉子：「受理读口只有一个实现」必须能被测试抓到（R3a 那个洞）
//
// 判据一律是**源码切片 + 正则**，不写行号：
//   * 别人在上方/下方合法插行 ⇒ 本用例不受影响（切片按函数名/实参键定位）；
//   * 别人把读口复制一份等价实现 ⇒ 必红（这正是行为测试 T1–T4 抓不到的那种改动）。
// ─────────────────────────────────────────────────────────────────────────────

const ROUTES_SRC_URL = new URL('../../services/api/src/routes/account-deletion.ts', import.meta.url);
const PRIVACY_SRC_URL = new URL('../../services/api/src/privacy/account-deletion.ts', import.meta.url);

/**
 * 取**顶层函数**切片：从 `function <name>(` 起，到其后第一个「列 0 的 `}` 行」为止（含该行）。
 * 定位只按函数名，不按行号 ⇒ 上方插行不会假红；函数不存在或重名（>1 处）直接判红。
 */
function sliceTopLevelFunction(source, name, fileLabel) {
  const definition = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`, 'g');
  const found = [...source.matchAll(definition)];
  assert.equal(
    found.length,
    1,
    `${fileLabel} 里顶层函数 ${name} 必须恰好定义 1 处（实得 ${found.length} 处）—— ⛔ 复制实现/重名会让「同源」变成两套`,
  );
  const start = found[0].index;
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `${fileLabel} 里 ${name} 的收尾行（列 0 的 }）必须可定位`);
  return source.slice(start, end + 3);
}

/**
 * `catch { … return null; }` 形态的口径（fail-closed 分支），容忍换行、缩进与夹在中间的注释
 * ——「补一句解释注释」不该让结构钉子假红，只有**把 null 改掉/加第二层 catch**才该红。
 */
const FAIL_CLOSED_SOURCE = String.raw`catch\s*(?:\([^)]*\))?\s*\{(?:\s|//[^\n]*\n|/\*[\s\S]*?\*\/)*return\s+null\s*;?\s*\}`;

test('T5 结构钉子：受理读口只允许一个实现（同一 thirdPartyStateOf + 老路径不带 options + fail-closed 单点）', () => {
  const routes = readFileSync(ROUTES_SRC_URL, 'utf8');
  const privacy = readFileSync(PRIVACY_SRC_URL, 'utf8');

  // ── 1) 路由受理处：`readThirdPartyState:` 只作为实参键出现 1 次，右值必须是同一个已存在的函数对象 ──
  const readerKeys = [...routes.matchAll(/readThirdPartyState\s*:/g)];
  assert.equal(
    readerKeys.length,
    1,
    `路由里 readThirdPartyState: 只允许出现 1 次（受理处实参键），实得 ${readerKeys.length} 次 —— ⛔ 多一处就是两套读口`,
  );
  assert.match(
    routes,
    /readThirdPartyState\s*:\s*thirdPartyStateOf\s*\.\s*bind\s*\(\s*null\s*,\s*deps\s*\)/,
    '202 的第三方读口必须是 GET/DELETE/replay 用的**同一个** thirdPartyStateOf.bind(null, deps)（⛔ 不许匿名箭头、不许另写一份）',
  );
  const readerLine = routes.slice(readerKeys[0].index, routes.indexOf('\n', readerKeys[0].index));
  assert.doesNotMatch(
    readerLine,
    /=>/,
    '受理读口的右值里出现箭头函数 ⇒ 说明另造了一份实现（结构钉子不允许，哪怕行为等价）',
  );

  // ── 2) 服务层：`projectReceiptForAccepted` 只定义 1 处，且「老路径」分支调用的是不带 options 的
  //        `projectReceipt(receipt)`；带读取器的分支才传 `{ thirdPartyState }`。 ──
  const accepted = sliceTopLevelFunction(privacy, 'projectReceiptForAccepted', 'privacy/account-deletion.ts');
  assert.match(
    accepted,
    /if\s*\(\s*read\s*===\s*null\s*\)\s*return\s+projectReceipt\(\s*receipt\s*\)\s*;/,
    '老路径分支必须是 `if (read === null) return projectReceipt(receipt);`（不传 options，既有调用点行为逐字不变）',
  );
  assert.match(
    accepted,
    /projectReceipt\(\s*receipt\s*,\s*\{\s*thirdPartyState\s*:/,
    '带读取器的分支必须把现算值交给 `projectReceipt(receipt, { thirdPartyState })`（复用既有闭集白名单，不另造映射）',
  );
  const projections = [...accepted.matchAll(/projectReceipt\(/g)];
  assert.equal(
    projections.length,
    2,
    `projectReceiptForAccepted 里只允许两次投影调用（老路径 1 次 + 带读取器 1 次），实得 ${projections.length} 次`,
  );
  assert.doesNotMatch(
    accepted,
    /catch/,
    '服务层不许自带 try/catch ——「受理不因第三方查询而 500」只能有一处实现（在读侧）',
  );

  // ── 3) 读侧：`thirdPartyStateOf` 只定义 1 处，其函数体内 catch 只出现 1 次且返回 null；
  //        全路由文件的 fail-closed（`catch { return null; }`）只有两处：读端口的 thirdPartyRowsFor + 投影的 thirdPartyStateOf。 ──
  const stateOf = sliceTopLevelFunction(routes, 'thirdPartyStateOf', 'routes/account-deletion.ts');
  const catchesInStateOf = [...stateOf.matchAll(/catch/g)];
  assert.equal(
    catchesInStateOf.length,
    1,
    `thirdPartyStateOf() 里只允许一个 catch（fail-closed 单点），实得 ${catchesInStateOf.length} 个`,
  );
  assert.match(
    stateOf,
    new RegExp(FAIL_CLOSED_SOURCE),
    'thirdPartyStateOf() 的 catch 必须原样 `return null`（契约语义：null = 没有可信结论；⛔ 不许改成抛出）',
  );
  const failClosed = [...routes.matchAll(new RegExp(FAIL_CLOSED_SOURCE, 'g'))];
  /**
   * GY-R74：读端口那一处的 fail-closed 形态从 `catch { return null; }` 改成
   * `catch { return { ok: false }; }`（见 `services/api/src/routes/account-deletion.ts::thirdPartyRowsFor`）。
   *
   * 为什么必须区分：读侧端口「**没读到**」（真库故障 / explicit-unavailable 端口抛错）与
   * 「**读到了空集**」在回执里的诚实结论不同 —— 前者只能说「不知道」（`null`），后者才足以说
   * 「没有接收方」，再按装配能力升级为 `'unsupported'`。合成一个 `null` 会把这两件事混成一件，
   * 于是「这台机器发不出去」也会被写成「不知道」，正是本片要堵的静默降级。
   *
   * 钉子意图不变、且更紧：routes 里的 fail-closed 仍然是**恰好两处、一处一种形态**
   * （读端口 `{ ok: false }` + 投影 `return null`），⛔ 不许出现第三处，也不许两种形态互相顶替。
   */
  const failClosedProbe = [...routes.matchAll(/catch\s*(?:\([^)]*\))?\s*\{\s*return\s*\{\s*ok:\s*false\s*\}\s*;?\s*\}/g)];
  assert.equal(
    failClosed.length + failClosedProbe.length,
    2,
    `routes 里 fail-closed 只允许 2 处（thirdPartyRowsFor 读端口 + thirdPartyStateOf 投影），`
      + `实得 return null ${failClosed.length} 处 + return { ok: false } ${failClosedProbe.length} 处`,
  );
  assert.equal(failClosedProbe.length, 1, '读端口的 fail-closed 只在 thirdPartyRowsFor() 里出现一次');
  assert.match(
    sliceTopLevelFunction(routes, 'thirdPartyRowsFor', 'routes/account-deletion.ts'),
    /catch\s*(?:\([^)]*\))?\s*\{\s*return\s*\{\s*ok:\s*false\s*\}\s*;?\s*\}/,
    'thirdPartyRowsFor() 的 catch 必须是 `return { ok: false }`（区分「没读到」与「读到空集」；⛔ 不许冒泡成 500）',
  );

  // ── 4) 反向确认：这三处结构在**同一个提交面**上是自洽的（读口就是 readThirdPartyState 的右值，
  //        服务层确实把它交给 projectReceiptForAccepted 的第三参）。 ──
  assert.match(
    privacy,
    /readThirdPartyState\?:\s*DeletionThirdPartyStateReader\s*\|\s*null/,
    '接口上必须仍声明可选读取器 `readThirdPartyState?: DeletionThirdPartyStateReader | null`（不传即老路径）',
  );
  assert.match(
    privacy,
    /projectReceiptForAccepted\(input,\s*requestId,\s*readThirdPartyState\)/,
    'request() 必须把读取器原样交给 projectReceiptForAccepted（⛔ 不许在这里另算一遍）',
  );
});
