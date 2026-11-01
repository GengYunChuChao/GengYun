/**
 * GY-R72 取消片 · **审核域取消按 `Idempotency-Key` 回放首次结果**（真实回环 HTTP，动态空闲端口）。
 *
 * 修的是什么（本片取证，`path:line` 见报告）：接线前 `services/api/src/moderation/service.ts:1187`
 * 的 `requireCancelIdempotencyKey(input.idempotencyKey)` **丢弃返回值**，随后先判
 * `job_revision !== expectedRevision ⇒ 409`、再判"已 `cancelled` ⇒ 返回当前视图"。
 * 后果：首次取消成功后 `job_revision` 已 +1，客户端用**同一个 `Idempotency-Key` + 同一个 `If-Match`**
 * 原样重试会拿到 **409 `REVISION_CONFLICT`**——而 OCR/转写/识别/合成/文字问答五源在同样情形下
 * 回放首次结果、返回 **200**。本片把这一个域对齐到那个语义（台账 store 由 W41 提供，本片不改它）。
 *
 * 本文件钉住的东西：
 *   T1 回放：同 key + 同 `If-Match` ⇒ 第二次**逐字段**等于第一次，`job_revision` 不再 +1、
 *      `ledger.update` 只发生一次（计数代理）；
 *   T2 同键异体：同 key + 换 `If-Match` ⇒ 409 `IDEMPOTENCY_CONFLICT`，且**没有**第二次写台账；
 *   T3 在途：同键占位仍是 `pending: true` ⇒ 409 `REQUEST_IN_PROGRESS` + `retryable: true`，不写台账；
 *   T4 缺头照旧：缺 `If-Match` ⇒ 428 `REVISION_REQUIRED`；缺 `Idempotency-Key` ⇒ 400 `IDEMPOTENCY_KEY_REQUIRED`；
 *   T5 未注入 = 旧行为：`createModerationService` 不传 `idempotency` ⇒ 同键原样重放仍 409
 *      `REVISION_CONFLICT`（**故意保留**的兼容路径，见 `service.ts` 末尾 `cancelIdempotencyOf` 的注释）；
 *   T6 缺表 fail-closed：注入 PG store 且就绪探测报 `missing` ⇒ 503 `PROVIDER_UNAVAILABLE` +
 *      `retryable: false`（**不许**静默退回旧路径）；
 *   T7 失败释放占位：版本冲突失败后，同一个 key + 正确 `If-Match` 能正常成功（不是永久在途）。
 *
 * 声明（如实）：模型/审核端口全部是**合成替身**（`provider.synthetic === true`），不发网络请求、
 * 不持有凭据；PG 臂只有**记录型假池**（探针语句用 `to_regclass` 认出来，不消耗业务应答），
 * 本机**没有真库读数**。端口一律 `port: 0`（动态空闲口），每个用例 `t.after` 关闭。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createModerationLedger } from '../../services/api/src/moderation/decisions.ts';
import {
  ModerationIdempotencyTablesMissingError,
  createMemoryModerationIdempotencyStore,
  createPgModerationIdempotencyStore,
} from '../../services/api/src/moderation/idempotency-store.ts';
import {
  idempotencyKeyHashHex,
  idempotencyRequestHash,
  idempotencyScope,
} from '../../services/api/src/auth/idempotency.ts';
import { ApiError } from '../../services/api/src/errors.ts';
import { countingPort, makeHarness, textContent } from '../moderation/_http-fixtures.mjs';

const API = '/api/v1';
const JOBS = `${API}/jobs`;
const START = Date.UTC(2026, 10, 2, 4, 0, 0);
/** 测试用 HMAC 密钥（与产品侧同源：`config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY`）。 */
const IDEM_HMAC_KEY = 'gy-r72-cancel-replay-hmac-key';

let keySeq = 0;
const nextKey = (label) => `gy-r72-${label}-${String((keySeq += 1)).padStart(4, '0')}`;
const cancelHeaders = (ifMatch, key) => ({ 'idempotency-key': key, 'if-match': ifMatch });

/**
 * 计数台账：套在 `createModerationLedger()` 外面只数 `update` 次数。
 * 用途：证明"回放"**没有**第二次写台账（只断言 revision 不够——revision 不变也可能是又写了一遍同值）。
 */
function countingLedger() {
  const base = createModerationLedger();
  const calls = { update: 0 };
  const ledger = {
    ...base,
    update(record) {
      calls.update += 1;
      return base.update(record);
    },
  };
  return { ledger, calls };
}

const PROBE_MARKER = 'to_regclass';

/**
 * 记录型假池（与 `tests/unit/moderation-idempotency-store.test.mjs:242-289` 同口径）：
 * 就绪探测（含 `to_regclass`）由 `probe` 单独应答、**不**消耗 `script`；`probe: 'missing'`
 * 表示迁移 `0051` 没跑过 ⇒ 写类方法必须抛 `ModerationIdempotencyTablesMissingError`。
 */
function makeDb({ script = [], probe = 'ready' } = {}) {
  let index = 0;
  const answerProbe = () => {
    if (probe instanceof Error) throw probe;
    if (probe === 'missing') return { rows: [{ ready: false }] };
    if (probe === 'unknown') return { rows: [] };
    return { rows: [{ ready: true }] };
  };
  const next = async (text, values) => {
    const sql = String(text).replace(/\s+/g, ' ').trim();
    if (sql.includes(PROBE_MARKER)) return answerProbe();
    const response = script[index];
    index += 1;
    if (response instanceof Error) throw response;
    return { rows: response ?? [] };
  };
  const pool = { query: next };
  return { pool, store: createPgModerationIdempotencyStore({ pool }) };
}

/**
 * 建 app + 回环 HTTP 夹具。
 *
 * `options.wired === false` ⇒ **不注入** `idempotency`（模拟无池部署），用来钉"未注入 = 旧行为"。
 * `options.idempotency` ⇒ 换掉默认的内存台账（T6 用它塞 PG store）。
 * `options.ledger` ⇒ `countingLedger()` 的返回值（T1/T2/T3 用它数写入次数）。
 */
async function makeFixture(t, options = {}) {
  const auth = createMemoryAuthStore();
  const config = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
  const tms = countingPort('tms');
  const idempotency = options.idempotency ?? createMemoryModerationIdempotencyStore();
  const moderation = makeHarness({
    ports: { tms: tms.port },
    ...(options.ledger === undefined ? {} : { ledger: options.ledger.ledger }),
    ...(options.wired === false
      ? {}
      : { idempotency, idempotencyHmacKey: options.idempotencyHmacKey ?? IDEM_HMAC_KEY }),
  });
  const app = buildApp({
    config,
    store: auth,
    now: () => new Date(START),
    moderationInjection: { service: moderation.service },
  });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });

  const account = async (seed) => {
    const user = await auth.createUser(seed.repeat(64));
    const token = `synthetic-r72-token-${seed}`;
    await auth.createSession({
      userId: user.id,
      tokenHashHex: hashToken(token),
      authEpoch: user.authEpoch,
      expiresAt: new Date(START + 48 * 3600_000),
      audience: 'user',
    });
    return { user, token };
  };
  const a = await account('a');
  const b = await account('b');

  const call = async (method, path, actor = a, { headers = {}, payload } = {}) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        ...(actor === null ? {} : { authorization: `Bearer ${actor.token}` }),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text === '' ? null : JSON.parse(text),
      etag: response.headers.get('etag'),
    };
  };
  t.after(async () => {
    await app.close();
  });
  return { app, auth, a, b, call, origin, moderation, idempotency, tms };
}

/** 建一个"待回调"（`queued`）的审核任务——异步供应商路径，也是审核域唯一可取消的窗口。 */
async function deferredTask(h) {
  const out = await h.moderation.service.submitScreening({
    actor: { userId: h.a.user.id, role: 'user', authEpoch: h.a.user.authEpoch },
    content: textContent(),
    defer_model: true,
  });
  const task = out.tasks[0];
  assert.equal(task.state, 'queued', '异步路径必须停在 queued（唯一可取消窗口）');
  return task;
}

// ===========================================================================
// T1 · 回放
// ===========================================================================

test('T1 回放：同一 key + 同一 If-Match ⇒ 第二次逐字段等于第一次，job_revision 不再 +1、台账只写一次', async (t) => {
  const counter = countingLedger();
  const h = await makeFixture(t, { ledger: counter });
  const task = await deferredTask(h);
  const key = nextKey('t1');

  const first = await h.call('POST', `${JOBS}/${task.job_id}/cancel`, h.a, { headers: cancelHeaders('"1"', key) });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.state, 'cancelled');
  assert.equal(first.body.data.revision, 2, '首次取消 job_revision 必须恰好 +1（1 → 2）');
  assert.equal(first.body.data.result, null);
  assert.equal(counter.calls.update, 1, '首次取消只写一次台账');

  const second = await h.call('POST', `${JOBS}/${task.job_id}/cancel`, h.a, { headers: cancelHeaders('"1"', key) });
  assert.equal(second.status, 200, `同一 Key + 同一 If-Match 的原样重试必须回放 200：${JSON.stringify(second.body)}`);
  // 回放的是**视图**（`data`）；封套里的 `meta.request_id` 是本次请求自己的 id，本来就该不同。
  assert.deepEqual(second.body.data, first.body.data, '回放的视图必须与首次逐字段相同');
  assert.notEqual(second.body.meta.request_id, first.body.meta.request_id, 'request_id 属于本次请求，不是回放内容');
  assert.equal(second.etag, first.etag, '回放的 ETag 必须是首次那一版');
  assert.equal(counter.calls.update, 1, '回放不得再写台账（否则"回放"变成"又取消了一次"）');
  assert.equal(h.moderation.ledger.byJobId(task.job_id).job_revision, 2, '回放不得让 job_revision 再 +1');
});

// ===========================================================================
// T2 · 同键异体
// ===========================================================================

test('T2 同键异体：同一 key、不同 If-Match ⇒ 409 IDEMPOTENCY_CONFLICT，且没有第二次写台账', async (t) => {
  const counter = countingLedger();
  const h = await makeFixture(t, { ledger: counter });
  const task = await deferredTask(h);
  const key = nextKey('t2');

  const first = await h.call('POST', `${JOBS}/${task.job_id}/cancel`, h.a, { headers: cancelHeaders('"1"', key) });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(counter.calls.update, 1);

  // 同一个 Key 换一个 If-Match = **另一个请求**：不许把首次结果塞给它，也不许再写一次。
  const other = await h.call('POST', `${JOBS}/${task.job_id}/cancel`, h.a, { headers: cancelHeaders('"2"', key) });
  assert.equal(other.status, 409, JSON.stringify(other.body));
  assert.equal(other.body.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(counter.calls.update, 1, '同键异体不得写台账');
  assert.equal(h.moderation.ledger.byJobId(task.job_id).job_revision, 2, '同键异体不得改 revision');
});

// ===========================================================================
// T3 · 同键在途
// ===========================================================================

test('T3 在途：同键占位仍 pending ⇒ 409 REQUEST_IN_PROGRESS（retryable），不写台账', async (t) => {
  const counter = countingLedger();
  const h = await makeFixture(t, { ledger: counter });
  const task = await deferredTask(h);
  const key = nextKey('t3');

  // 手工造一条"已占位、未结算"的台账行：requestHash 必须与 service 要算的那一份**完全相同**
  // （否则先撞的是 409 IDEMPOTENCY_CONFLICT，就测不到在途那一条）。
  const scope = idempotencyScope(h.a.user.id, 'POST', `${JOBS}/${task.job_id}/cancel`);
  const keyHash = idempotencyKeyHashHex(scope, key);
  const at = h.moderation.now();
  const seeded = await h.idempotency.claimIdempotent(
    scope,
    keyHash,
    {
      scope,
      keyHash,
      requestHash: idempotencyRequestHash(null, '"1"', IDEM_HMAC_KEY),
      payload: {},
      pending: true,
      expiresAt: new Date(at.getTime() + 24 * 3600_000),
    },
    at,
  );
  assert.equal(seeded, 'claimed', '造在途行必须真的占到位置');

  const res = await h.call('POST', `${JOBS}/${task.job_id}/cancel`, h.a, { headers: cancelHeaders('"1"', key) });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'REQUEST_IN_PROGRESS');
  assert.equal(res.body.error.retryable, true, '"在途"是可重试的：客户端稍后重试即可拿到结果');
  assert.equal(counter.calls.update, 0, '在途请求不得写台账');
  assert.equal(h.moderation.ledger.byJobId(task.job_id).state, 'queued', '在途请求不得改动作业');
});

// ===========================================================================
// T4 · 缺头照旧
// ===========================================================================

test('T4 缺头照旧：缺 If-Match ⇒ 428 REVISION_REQUIRED；缺 Idempotency-Key ⇒ 400 IDEMPOTENCY_KEY_REQUIRED', async (t) => {
  const h = await makeFixture(t);
  const task = await deferredTask(h);

  const noMatch = await h.call('POST', `${JOBS}/${task.job_id}/cancel`, h.a, {
    headers: { 'idempotency-key': nextKey('t4-nomatch') },
  });
  assert.equal(noMatch.status, 428, JSON.stringify(noMatch.body));
  assert.equal(noMatch.body.error.code, 'REVISION_REQUIRED');

  const noKey = await h.call('POST', `${JOBS}/${task.job_id}/cancel`, h.a, { headers: { 'if-match': '"1"' } });
  assert.equal(noKey.status, 400, JSON.stringify(noKey.body));
  assert.equal(noKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

  // 两条缺头请求都必须在**任何台账写入之前**被拒（缺头不该消耗调用方的键）。
  assert.equal(h.moderation.ledger.byJobId(task.job_id).state, 'queued');
  assert.equal(h.moderation.ledger.byJobId(task.job_id).job_revision, 1);
});

// ===========================================================================
// T5 · 未注入台账 = 旧行为（故意保留的兼容路径）
// ===========================================================================

test('T5 未注入 idempotency ⇒ 行为与接线前一致：同键原样重放仍 409 REVISION_CONFLICT', async (t) => {
  const h = await makeFixture(t, { wired: false });
  const task = await deferredTask(h);
  const key = nextKey('t5');

  const first = await h.call('POST', `${JOBS}/${task.job_id}/cancel`, h.a, { headers: cancelHeaders('"1"', key) });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.revision, 2);

  // 无池部署（`app.ts` 里 `...(pool === null ? {} : { idempotency: … })` 那一支）**没有**台账可回放：
  // 保持旧口径——持旧 revision 的重放如实判版本冲突，而不是假装回放（不谎称幂等）。
  const replay = await h.call('POST', `${JOBS}/${task.job_id}/cancel`, h.a, { headers: cancelHeaders('"1"', key) });
  assert.equal(replay.status, 409, JSON.stringify(replay.body));
  assert.equal(replay.body.error.code, 'REVISION_CONFLICT');

  // 而"已 cancelled + 当前 revision"的 no-op 仍成立（这条不依赖台账，旧口径本来就对）。
  const noop = await h.call('POST', `${JOBS}/${task.job_id}/cancel`, h.a, { headers: cancelHeaders('"2"', key) });
  assert.equal(noop.status, 200, JSON.stringify(noop.body));
  assert.equal(noop.body.data.revision, 2);
});

// ===========================================================================
// T6 · 缺表 fail-closed（记录型假池，不连库）
// ===========================================================================

test('T6 缺表：PG 台账就绪探测报 missing ⇒ 503 PROVIDER_UNAVAILABLE + retryable:false（不静默退回旧路径）', async (t) => {
  const db = makeDb({ probe: 'missing' });
  const h = await makeFixture(t, { idempotency: db.store });
  const task = await deferredTask(h);

  const res = await h.call('POST', `${JOBS}/${task.job_id}/cancel`, h.a, {
    headers: cancelHeaders('"1"', nextKey('t6')),
  });
  assert.equal(res.status, 503, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(res.body.error.retryable, false, '迁移没跑是部署问题，重试不会好 ⇒ retryable:false');
  assert.match(res.body.error.message, /0051_moderation_idempotency\.sql/);

  // 关键否证：**没有**静默退回旧路径——作业仍是 queued、revision 仍是 1（旧路径会把它取消掉）。
  const row = h.moderation.ledger.byJobId(task.job_id);
  assert.equal(row.state, 'queued', '缺表时不得假装取消成功');
  assert.equal(row.job_revision, 1);

  // 同一条错误形状与 store 自身抛的一致（不是路由层另造一个）。
  await assert.rejects(
    async () => db.store.claimIdempotent('s', 'k', { scope: 's', keyHash: 'k', requestHash: 'r', payload: {}, pending: true, expiresAt: new Date(START + 3600_000) }, new Date(START)),
    (error) => {
      assert.ok(error instanceof ModerationIdempotencyTablesMissingError);
      assert.ok(error instanceof ApiError);
      return true;
    },
  );
});

// ===========================================================================
// T7 · 失败释放占位
// ===========================================================================

test('T7 失败释放占位：版本冲突失败后，同一个 key + 正确 If-Match 能正常成功（不是永久在途）', async (t) => {
  const counter = countingLedger();
  const h = await makeFixture(t, { ledger: counter });
  const task = await deferredTask(h);
  const key = nextKey('t7');

  // 第一次：版本不符 ⇒ 占位必须被 release（否则这个键会被自己的占位挡死）。
  const conflict = await h.call('POST', `${JOBS}/${task.job_id}/cancel`, h.a, { headers: cancelHeaders('"2"', key) });
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.error.code, 'REVISION_CONFLICT');
  assert.equal(counter.calls.update, 0, '版本冲突不得写台账');

  // 第二次：同一个 key、正确的 If-Match ⇒ 必须能重新占位并成功。
  const ok = await h.call('POST', `${JOBS}/${task.job_id}/cancel`, h.a, { headers: cancelHeaders('"1"', key) });
  assert.equal(ok.status, 200, `占位未被释放（永久 REQUEST_IN_PROGRESS / IDEMPOTENCY_CONFLICT）：${JSON.stringify(ok.body)}`);
  assert.equal(ok.body.data.state, 'cancelled');
  assert.equal(ok.body.data.revision, 2);
  assert.equal(counter.calls.update, 1);

  // 第三次：这次才是"原样重试"⇒ 回放（证明成功之后占位是 finalize 过的，不是仍 pending）。
  const replay = await h.call('POST', `${JOBS}/${task.job_id}/cancel`, h.a, { headers: cancelHeaders('"1"', key) });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.deepEqual(replay.body.data, ok.body.data, '回放的视图必须与成功那次逐字段相同');
  assert.equal(counter.calls.update, 1, '回放不得再写台账');
});
