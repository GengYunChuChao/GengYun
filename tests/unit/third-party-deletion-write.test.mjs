// GY-R73（P2-c）· 第三方删除「写侧」的机器取证（进程内：不连库、不联网、不发真实请求）。
//
// 本文件锁住设计 §4「库层有、运行面没有」被补上之后**唯一**一条新链路：
//   注销受理链（`executeHandlers()`）⇒ 写侧派发器 ⇒ 端口写侧（迁移 `0044` 的
//   `record_third_party_deletion`）⇒ 持久行 ⇒ 回执投影（`thirdPartyStateOf()` 读同一批行）。
//
// 断言分四组：
//   A. **四条装配缺口**（未接线 / 无适配器 / 适配器不可用 / 无收件人来源）⇒ 一条也不写，且原因可判；
//   B. **状态机**：`requested` → `confirmed`｜`failed`｜`unsupported` 的每一条转移，
//      含「confirmed 没有证据 ⇒ 写 failed」「failed 可被 confirmed 覆盖」「requested 不许盖掉 failed」；
//   C. **幂等 + 终态不回退**：同键重放不重复外发、不刷新 `requested_at`、不把终态改回去；
//   D. **fail-open**：写失败/读失败/适配器抛错 ⇒ 注销主流程照常完成（⛔ 不回滚、不抛），
//      但计数与事件必须可诊断（⛔ 不静默）。
//
// ── 负控制（改一行就必须变红的可重跑说明）──────────────────────────────────────────────
// N1. 把 `services/api/src/privacy/user-data-deletion.ts::executeHandlers()` 里
//     `await thirdPartyDispatch.dispatch({ requestId, userId: subject })` 整句注释掉 ⇒
//     「正常链路」「写侧整体炸掉」两组变红（`thirdPartyWrites.dispatched` 仍为 0、库里零行）。
// N2. 把 `third-party-deletion-dispatch.ts::stateOf()` 的 `confirmed` 分支改成
//     `evidenceRef: outcome.evidence_ref ?? null` 直写 ⇒「confirmed 没有证据」变红
//     （会写出 `confirmed`；真库那一侧再由 `third_party_confirmed_evidence` CHECK 拦住，见真库臂 face F）。
// N3. 把 `dispatch()` 的 `try { … } catch { … }` 兜底去掉、或让 `writeState()` 把异常抛出去 ⇒
//     「写侧整体炸掉 ⇒ 注销主流程照常完成」变红（`executeHandlers()` 会抛，受理链 500）。
// N4. 把终态/已请求的跳过判断删掉 ⇒「终态不回退」「requested 重放不刷新」变红。
//
// ── 本文件**不**覆盖的东西 ──────────────────────────────────────────────────────────
// * 真实第三方、真实凭据、真实外网：适配器在本文件里是**语义替身**，只回放四种结论。
// * 真库 SQL（CHECK / 唯一索引 / `G0003` / `security definer` 权限）：见
//   `tests/integration/third-party-deletion-pg.mjs` 的 face F（本片新增）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';
import { createUserDataDeletion } from '../../services/api/src/privacy/user-data-deletion.ts';
import {
  THIRD_PARTY_EVIDENCE_REQUIRED,
  THIRD_PARTY_FAILED_CODE,
  THIRD_PARTY_UNAVAILABLE_CODE,
  createThirdPartyDeletionDispatcher,
  writePortOf,
} from '../../services/api/src/privacy/third-party-deletion-dispatch.ts';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { USER_A } from './favorites-history-fixtures.mjs';

const API = '/api/v1';
const DELETION_PATH = `${API}/me/account/deletion`;
/** 远未来固定基准：与跑测试的真实日期解耦，不存在墙钟时炸弹。 */
const CLOCK_MS = Date.parse('2100-01-01T00:00:00.000Z');

function isoAt(offsetMs = 0) {
  return new Date(CLOCK_MS + offsetMs).toISOString();
}

function withCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function rowKey(recipientId, exportRef) {
  return `${recipientId}\u0000${exportRef ?? ''}`;
}

const TERMINAL_STATES = new Set(['confirmed', 'unsupported']);
const WRITABLE_STATES = new Set(['requested', 'confirmed', 'failed', 'unsupported']);

/**
 * 真库端口（`third-party-deletion-pg.ts` + 迁移 `0044`）的**语义替身**。
 *
 * 刻意照抄 SQL 的真实行为而不是"怎么方便怎么来"：
 *   - `(request_id, recipient_id, export_ref)` 唯一键（`export_ref` 为 NULL 时是另一组）；
 *   - `ON CONFLICT DO UPDATE … WHERE 非终态`（终态回退 ⇒ `G0003`）；
 *   - 重放同内容 ⇒ 原样返回既有行，**不刷新任何时刻**（`0044:230-245`）；
 *   - `requested_at = COALESCE(d.requested_at, EXCLUDED.requested_at)`（只写一次）；
 *   - 端口层 `normalizeWriteInput()` 的预检（confirmed 必须带证据、非 confirmed 不许带、
 *     failed 必须有 error_code）⇒ 这里用断言模拟"写不进去"，免得写侧的错误映射被静默吞掉。
 */
function createFakePort({ rows = [], failReads = false, failWriteAt = null } = {}) {
  const table = new Map();
  for (const row of rows) table.set(rowKey(row.recipientId, row.exportRef ?? null), { ...row });
  const writes = [];
  let seq = 0;

  return {
    persistent: true,
    writes,
    /** 只读快照（断言用）。 */
    snapshot(requestId) {
      return [...table.values()].filter((row) => row.requestId === requestId).map((row) => ({ ...row }));
    },
    async listThirdPartyDeletions(requestId) {
      if (failReads) throw withCode('注入的读失败', '08006');
      return [...table.values()].filter((row) => row.requestId === requestId).map((row) => ({ ...row }));
    },
    async subscribeThirdPartyDeletion(input) {
      seq += 1;
      assert.ok(WRITABLE_STATES.has(input.state), `state 必须在四值闭集内，收到 ${String(input.state)}`);
      if (input.state === 'confirmed') {
        assert.ok(
          typeof input.evidenceRef === 'string' && input.evidenceRef.length > 0,
          'confirmed 必须带 evidence_ref（真库由 third_party_confirmed_evidence 拦住）',
        );
      } else {
        assert.equal(input.evidenceRef ?? null, null, '非 confirmed 不得带 evidence_ref');
      }
      if (input.state === 'failed') {
        assert.ok(typeof input.errorCode === 'string' && input.errorCode.length > 0, 'failed 必须带 error_code');
      }
      const key = rowKey(input.recipientId, input.exportRef ?? null);
      const existing = table.get(key);
      // 注入点：第 N 次写失败（模拟驱动/连接/约束失败）。
      if (failWriteAt !== null && failWriteAt === seq) throw withCode('注入的写失败', '08006');
      writes.push({ seq, requestId: input.requestId, recipientId: input.recipientId, exportRef: input.exportRef ?? null, state: input.state, evidenceRef: input.evidenceRef ?? null, errorCode: input.errorCode ?? null, at: input.at });

      if (existing === undefined) {
        const fresh = {
          requestId: input.requestId,
          recipientId: input.recipientId,
          exportRef: input.exportRef ?? null,
          onlineState: input.state,
          backupState: input.state,
          requestedAt: input.at,
          confirmedAt: input.state === 'confirmed' ? input.at : null,
          evidenceRef: input.state === 'confirmed' ? input.evidenceRef : null,
          errorCode: input.errorCode ?? null,
        };
        table.set(key, fresh);
        return { ...fresh };
      }
      const identical =
        existing.onlineState === input.state &&
        existing.backupState === input.state &&
        (existing.evidenceRef ?? null) === (input.evidenceRef ?? null) &&
        (existing.errorCode ?? null) === (input.errorCode ?? null);
      if (identical) return { ...existing };
      if (TERMINAL_STATES.has(existing.onlineState) || TERMINAL_STATES.has(existing.backupState)) {
        throw withCode('该接收方的第三方删除已是终态，不可回退', 'G0003');
      }
      const next = {
        ...existing,
        onlineState: input.state,
        backupState: input.state,
        requestedAt: existing.requestedAt ?? input.at,
        confirmedAt: input.state === 'confirmed' ? input.at : null,
        evidenceRef: input.state === 'confirmed' ? input.evidenceRef : null,
        errorCode: input.errorCode ?? null,
      };
      table.set(key, next);
      return { ...next };
    },
  };
}

/** 适配器替身：按队列回放四种结论，并记录调用（`available`/`transportKind` 与真实适配器同形）。 */
function createFakeAdapter(outcomes, { available = true } = {}) {
  const calls = [];
  const queue = Array.isArray(outcomes) ? [...outcomes] : [outcomes];
  return {
    available,
    transportKind: available ? 'real' : 'unwired',
    note: 'synthetic',
    calls,
    async dispatch(input) {
      calls.push({ ...input });
      const next = queue.length > 1 ? queue.shift() : queue[0];
      const outcome = typeof next === 'function' ? next(input) : next;
      return { completed: outcome.status === 'confirmed', duration_ms: 3, attempted_at: isoAt(1000), ...outcome };
    },
  };
}

function confirmedOutcome(evidenceRef = 'receipt-2100-0001') {
  return { status: 'confirmed', completed: true, error_code: null, evidence_ref: evidenceRef };
}

function failedOutcome(errorCode = 'THIRD_PARTY_REJECTED') {
  return { status: 'failed', completed: false, error_code: errorCode, evidence_ref: null };
}

function unsupportedOutcome() {
  return { status: 'unsupported', completed: false, error_code: null, evidence_ref: null };
}

function unavailableOutcome() {
  return { status: 'unavailable', completed: false, error_code: 'OBJECT_UNAVAILABLE', evidence_ref: null };
}

/** 收件人来源替身：返回固定清单（⛔ 生产里没有这个来源，见第 1 组用例）。 */
function createFakeRecipients(list) {
  const calls = [];
  return {
    calls,
    async listRecipients(input) {
      calls.push({ ...input });
      return typeof list === 'function' ? list(input) : list;
    },
  };
}

/**
 * 一次性异步闸门（R73-P1）：把派发器按在某个 await 窗口里，用例再决定「此刻取消」还是「直接放行」。
 * `entered` 在窗口入口 resolve，`open()` 才让窗口继续 —— 两者分开，才能稳定复现
 * 「取消已经受理、但派发仍停在 await 里」这个交叠。
 */
function createGate() {
  let markEntered;
  let release;
  const entered = new Promise((resolve) => {
    markEntered = resolve;
  });
  const opened = new Promise((resolve) => {
    release = resolve;
  });
  return {
    entered,
    opened,
    hit() {
      markEntered();
    },
    open() {
      release();
    },
  };
}

/** 收件人来源替身：进入 `listRecipients()` 后先过闸门（异步窗口可控），放行后才返回清单。 */
function createGatedRecipients(list, gate) {
  return {
    async listRecipients() {
      gate.hit();
      await gate.opened;
      return list;
    },
  };
}

/** 在真库端口的 `listThirdPartyDeletions()` 外面套一道闸门（只为把这个「读现状」窗口按住）。 */
function createGatedReadPort(port, gate) {
  return {
    ...port,
    async listThirdPartyDeletions(requestId) {
      gate.hit();
      await gate.opened;
      return port.listThirdPartyDeletions(requestId);
    },
  };
}

/**
 * 写端口替身（R73-P1 第二轮）：`requested` 那笔**写完的那一刻**，用三级嵌套 `queueMicrotask`
 * 排入一次**真实** `cancelDeletion()`。
 *
 * 为什么是三级：写完 `requested` 到派发器恢复执行之间隔着几级 promise 解析（端口的写 →
 * `writeState()` → 派发器）；三级嵌套正好把「取消已受理」排在派发器取最后一读之前的那一拍，
 * 而取消那一刻适配器一次都还没被调——监工的反例读数（`adapter_calls=0` 时取消已受理，
 * 之后仍外发）就是这么复现出来的。
 */
function createCancelAtRequestedWritePort(port, cancel) {
  return {
    ...port,
    async subscribeThirdPartyDeletion(input) {
      const written = await port.subscribeThirdPartyDeletion(input);
      if (input.state === 'requested') {
        queueMicrotask(() => {
          queueMicrotask(() => {
            queueMicrotask(() => {
              cancel();
            });
          });
        });
      }
      return written;
    },
  };
}

/** 注销域四 store 的最小装配（与 `tests/unit/user-data-deletion.test.mjs::seed()` 同形）。 */
function createStores() {
  return {
    favoritesStore: createMemoryFavoritesStore({ now: () => CLOCK_MS }),
    historyStore: createMemoryHistoryStore({ now: () => CLOCK_MS }),
    messagesStore: createMemoryMessagesStore({ now: () => CLOCK_MS }),
    conversationsStore: createMemoryConversationStore(),
  };
}

/** 走**真实注册表**（含 coordinator）：受理 → 执行级联 → 写侧那一次派发。 */
async function runDeletion(extraDeps = {}) {
  const deletion = createUserDataDeletion({ ...createStores(), now: () => new Date(CLOCK_MS), ...extraDeps });
  const request = deletion.requestDeletionFor(USER_A.userId);
  const requestId = String(request.id);
  const executed = await deletion.executeHandlers(requestId);
  return { deletion, requestId, executed };
}

/** 直接驱动派发器（状态机/幂等的细粒度矩阵用；装配缝隙另有一组走真实注册表）。 */
function makeDispatcher({ port, adapter = null, recipients = null, log } = {}) {
  const events = [];
  const dispatcher = createThirdPartyDeletionDispatcher({
    port,
    adapter,
    recipients,
    now: () => new Date(CLOCK_MS),
    log: (event) => {
      events.push(event);
      if (log !== undefined) log(event);
    },
  });
  return { dispatcher, events };
}

// ─────────────────────────────────────────────────────────────────────────────
// A) 装配缺口：四条臂各自"一条也不写"，且原因可判（⛔ 不静默）
// ─────────────────────────────────────────────────────────────────────────────

test('写侧装配：未接线端口 ⇒ WRITE_PORT_UNWIRED，一条也不写（stub 今天的形态）', async () => {
  const { deletion } = await runDeletion();
  const readings = deletion.thirdPartyWrites;
  assert.equal(readings.dispatched, 0, '未接线时不得向任何接收方外发');
  assert.equal(readings.writeFailures, 0, '未接线不是写失败（⛔ 不把"没接"记成"写坏了"）');
  assert.equal(deletion.lastThirdPartyDispatch().reason, 'WRITE_PORT_UNWIRED');
  // 未接线端口的读侧行为一字未改（P2-b 的既有断言不受影响）。
  assert.equal(await deletion.thirdParty.listThirdPartyDeletions(randomUUID()), null);
});

test('写侧装配：有写端口但没有适配器 ⇒ ADAPTER_UNWIRED，一条也不写', async () => {
  const port = createFakePort();
  const { deletion } = await runDeletion({ thirdParty: port });
  assert.equal(port.writes.length, 0, '没有适配器就发不出去，也就不能先写 requested 再假装发过');
  assert.equal(deletion.thirdPartyWrites.dispatched, 0);
  assert.equal(deletion.lastThirdPartyDispatch().reason, 'ADAPTER_UNWIRED');
});

test('写侧装配：适配器未接线/不可用 ⇒ ADAPTER_UNAVAILABLE，一条也不写', async () => {
  const port = createFakePort();
  const adapter = createFakeAdapter(unavailableOutcome(), { available: false });
  const { deletion } = await runDeletion({
    thirdParty: port,
    thirdPartyAdapter: adapter,
    thirdPartyRecipients: createFakeRecipients([{ recipientId: 'alipay-cloud' }]),
  });
  assert.equal(adapter.calls.length, 0, 'available=false 的适配器连 dispatch 都不该被调用');
  assert.equal(port.writes.length, 0);
  assert.equal(deletion.lastThirdPartyDispatch().reason, 'ADAPTER_UNAVAILABLE');
});

test('写侧装配：有端口有适配器但没有收件人来源 ⇒ RECIPIENTS_UNWIRED，一条也不写（⛔ 不硬编码名单）', async () => {
  const port = createFakePort();
  const adapter = createFakeAdapter(confirmedOutcome());
  const { deletion } = await runDeletion({ thirdParty: port, thirdPartyAdapter: adapter });
  assert.equal(adapter.calls.length, 0);
  assert.equal(port.writes.length, 0, '没有收件人来源时不许凭空造接收方，也就一行都不许写');
  assert.equal(deletion.lastThirdPartyDispatch().reason, 'RECIPIENTS_UNWIRED');
  assert.equal(deletion.thirdPartyWrites.dispatched, 0);
});

test('写侧装配：收件人来源给空清单 ⇒ NO_RECIPIENTS，一条也不写', async () => {
  const port = createFakePort();
  const { dispatcher, events } = makeDispatcher({
    port,
    adapter: createFakeAdapter(confirmedOutcome()),
    recipients: createFakeRecipients([]),
  });
  const result = await dispatcher.dispatch({ requestId: randomUUID(), userId: USER_A.userId });
  assert.equal(result.reason, 'NO_RECIPIENTS');
  assert.equal(result.recipients, 0);
  assert.equal(port.writes.length, 0);
  assert.deepEqual(events, [], '「本来就没有接收方」不是异常，不产生告警噪音');
});

test('写侧装配：缺口告警每个原因只报一次（配置运行期不变，⛔ 不为每次注销刷同一条 warn）', async () => {
  const { dispatcher, events } = makeDispatcher({ port: createFakePort(), adapter: null });
  await dispatcher.dispatch({ requestId: randomUUID(), userId: USER_A.userId });
  await dispatcher.dispatch({ requestId: randomUUID(), userId: USER_A.userId });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'third_party_deletion_dispatch_unwired');
  assert.equal(events[0].reason, 'ADAPTER_UNWIRED');
});

// ─────────────────────────────────────────────────────────────────────────────
// B) 状态机：requested → confirmed / failed / unsupported
// ─────────────────────────────────────────────────────────────────────────────

test('正常链路：先写 requested 再外发，拿到证据后写 confirmed（同一 (request,recipient) 只有一行）', async () => {
  const port = createFakePort();
  const adapter = createFakeAdapter(confirmedOutcome('evidence-abc'));
  const { deletion, requestId } = await runDeletion({
    thirdParty: port,
    thirdPartyAdapter: adapter,
    thirdPartyRecipients: createFakeRecipients([{ recipientId: 'alipay-cloud' }]),
  });

  assert.deepEqual(
    port.writes.map((write) => write.state),
    ['requested', 'confirmed'],
    '必须先落 requested（发出前）再落结论（收到后），顺序颠倒就等于"先宣称完成再发请求"',
  );
  assert.equal(port.writes[0].at, isoAt(0), 'requested_at 用注入时钟');
  assert.equal(adapter.calls.length, 1, '一次受理只向一个接收方发一次');
  assert.equal(adapter.calls[0].requestId, requestId);
  assert.equal(adapter.calls[0].recipientId, 'alipay-cloud');
  assert.equal(adapter.calls[0].exportRef ?? null, null, '整账号注销链没有导出物 ⇒ exportRef 恒 null');

  const rows = port.snapshot(requestId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].onlineState, 'confirmed');
  assert.equal(rows[0].evidenceRef, 'evidence-abc');
  assert.equal(rows[0].confirmedAt, isoAt(1000), 'confirmed_at 取适配器的 attempted_at（外发那一刻）');
  assert.equal(rows[0].requestedAt, isoAt(0), 'requested_at 冻结在第一次写');

  const readings = deletion.thirdPartyWrites;
  assert.equal(readings.dispatched, 1);
  assert.equal(readings.confirmed, 1);
  assert.equal(readings.failed, 0);
  assert.equal(readings.writeFailures, 0);
  assert.equal(deletion.lastThirdPartyDispatch().reason, 'OK');
});

test('confirmed 但拿不到证据 ⇒ 写 failed + EVIDENCE_REQUIRED，绝不许写 confirmed', async () => {
  for (const evidence of [null, '', '   ']) {
    const port = createFakePort();
    const adapter = createFakeAdapter({ status: 'confirmed', completed: true, error_code: null, evidence_ref: evidence });
    const { deletion, requestId } = await runDeletion({
      thirdParty: port,
      thirdPartyAdapter: adapter,
      thirdPartyRecipients: createFakeRecipients([{ recipientId: 'alipay-cloud' }]),
    });
    assert.equal(
      port.writes.some((write) => write.state === 'confirmed'),
      false,
      `证据为 ${JSON.stringify(evidence)} 时不许写出 confirmed（那行没有证据，回执会照它说"已确认"）`,
    );
    const rows = port.snapshot(requestId);
    assert.equal(rows[0].onlineState, 'failed');
    assert.equal(rows[0].errorCode, THIRD_PARTY_EVIDENCE_REQUIRED);
    assert.equal(rows[0].evidenceRef, null);
    assert.equal(rows[0].confirmedAt, null);
    assert.equal(deletion.thirdPartyWrites.confirmed, 0);
    assert.equal(deletion.thirdPartyWrites.failed, 1);
  }
});

test('适配器明确失败 ⇒ 写 failed + 对方原因码；不为 failed 编造证据', async () => {
  const port = createFakePort();
  const { deletion, requestId } = await runDeletion({
    thirdParty: port,
    thirdPartyAdapter: createFakeAdapter(failedOutcome('THIRD_PARTY_REJECTED')),
    thirdPartyRecipients: createFakeRecipients([{ recipientId: 'alipay-cloud' }]),
  });
  const rows = port.snapshot(requestId);
  assert.equal(rows[0].onlineState, 'failed');
  assert.equal(rows[0].errorCode, 'THIRD_PARTY_REJECTED');
  assert.equal(rows[0].evidenceRef, null);
  assert.equal(rows[0].confirmedAt, null);
  assert.equal(deletion.thirdPartyWrites.failed, 1);
});

test('适配器 unsupported ⇒ 写 unsupported（终态），且不写证据', async () => {
  const port = createFakePort();
  const { deletion, requestId } = await runDeletion({
    thirdParty: port,
    thirdPartyAdapter: createFakeAdapter(unsupportedOutcome()),
    thirdPartyRecipients: createFakeRecipients([{ recipientId: 'legacy-no-api' }]),
  });
  const rows = port.snapshot(requestId);
  assert.equal(rows[0].onlineState, 'unsupported');
  assert.equal(rows[0].evidenceRef, null);
  assert.equal(deletion.thirdPartyWrites.unsupported, 1);
});

test('适配器返回 unavailable（压根没发出去）⇒ 记 failed + OBJECT_UNAVAILABLE，不记 confirmed', async () => {
  const port = createFakePort();
  const { deletion, requestId } = await runDeletion({
    thirdParty: port,
    thirdPartyAdapter: createFakeAdapter(unavailableOutcome()),
    thirdPartyRecipients: createFakeRecipients([{ recipientId: 'alipay-cloud' }]),
  });
  const rows = port.snapshot(requestId);
  assert.equal(rows[0].onlineState, 'failed');
  assert.equal(rows[0].errorCode, THIRD_PARTY_UNAVAILABLE_CODE);
  assert.equal(deletion.thirdPartyWrites.confirmed, 0);
  assert.equal(deletion.thirdPartyWrites.failed, 1);
});

test('适配器抛错 ⇒ 折成 failed + THIRD_PARTY_FAILED，不中断下一个接收方', async () => {
  const port = createFakePort();
  const adapter = createFakeAdapter([
    () => {
      throw withCode('适配器内部炸了', 'ECONNRESET');
    },
    confirmedOutcome('evidence-second'),
  ]);
  const { deletion, requestId } = await runDeletion({
    thirdParty: port,
    thirdPartyAdapter: adapter,
    thirdPartyRecipients: createFakeRecipients([{ recipientId: 'first' }, { recipientId: 'second' }]),
  });
  const rows = port.snapshot(requestId);
  assert.equal(rows.length, 2, '两个接收方各一行');
  const first = rows.find((row) => row.recipientId === 'first');
  const second = rows.find((row) => row.recipientId === 'second');
  assert.equal(first.onlineState, 'failed');
  assert.equal(first.errorCode, THIRD_PARTY_FAILED_CODE);
  assert.equal(second.onlineState, 'confirmed', '前一个炸了不许拖累后一个');
  assert.equal(second.evidenceRef, 'evidence-second');
  assert.equal(deletion.thirdPartyWrites.dispatched, 2);
});

test('多接收方：一个确认一个失败，各写一行且计数分开（exportRef 为空走 null 键）', async () => {
  const port = createFakePort();
  const adapter = createFakeAdapter([confirmedOutcome('ev-1'), failedOutcome('THIRD_PARTY_TIMEOUT')]);
  const { deletion, requestId } = await runDeletion({
    thirdParty: port,
    thirdPartyAdapter: adapter,
    thirdPartyRecipients: createFakeRecipients([{ recipientId: 'alpha' }, { recipientId: 'beta' }]),
  });
  const rows = port.snapshot(requestId);
  assert.deepEqual(rows.map((row) => [row.recipientId, row.onlineState, row.exportRef]).sort(), [
    ['alpha', 'confirmed', null],
    ['beta', 'failed', null],
  ]);
  assert.equal(deletion.thirdPartyWrites.confirmed, 1);
  assert.equal(deletion.thirdPartyWrites.failed, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// C) 幂等 + 终态不回退
// ─────────────────────────────────────────────────────────────────────────────

test('终态不回退：confirmed 之后重放 ⇒ 一条新写都没有、不重复外发、不触发 G0003', async () => {
  const port = createFakePort();
  const adapter = createFakeAdapter(confirmedOutcome('ev-terminal'));
  const { dispatcher } = makeDispatcher({
    port,
    adapter,
    recipients: createFakeRecipients([{ recipientId: 'alipay-cloud' }]),
  });
  const requestId = randomUUID();
  const first = await dispatcher.dispatch({ requestId, userId: USER_A.userId });
  assert.equal(first.reason, 'OK');
  assert.equal(port.writes.length, 2);

  // 第二次：适配器改成会"失败"，若写侧真去写，就会把 confirmed 改成 failed（真库 ⇒ G0003）。
  adapter.calls.length = 0;
  const second = await dispatcher.dispatch({ requestId, userId: USER_A.userId });
  assert.equal(second.reason, 'OK');
  assert.equal(second.rows[0].skipped, 'terminal');
  assert.equal(port.writes.length, 2, '终态之后不许再多写一行');
  assert.equal(adapter.calls.length, 0, '终态之后不许再外发一次');
  assert.equal(dispatcher.readings.skipped, 1);
  assert.equal(dispatcher.readings.writeFailures, 0, '我们的跳过发生在写之前 ⇒ 不该撞到库层 G0003');
  assert.equal(port.snapshot(requestId)[0].onlineState, 'confirmed');
});

test('unsupported 同样是终态：重放不再外发、不再改写', async () => {
  const port = createFakePort();
  const adapter = createFakeAdapter(unsupportedOutcome());
  const { dispatcher } = makeDispatcher({
    port,
    adapter,
    recipients: createFakeRecipients([{ recipientId: 'legacy' }]),
  });
  const requestId = randomUUID();
  await dispatcher.dispatch({ requestId, userId: USER_A.userId });
  const writesAfterFirst = port.writes.length;
  adapter.calls.length = 0;
  const second = await dispatcher.dispatch({ requestId, userId: USER_A.userId });
  assert.equal(second.rows[0].skipped, 'terminal');
  assert.equal(port.writes.length, writesAfterFirst);
  assert.equal(adapter.calls.length, 0);
});

test('requested 重放 ⇒ 跳过（不重复外发、不刷新 requested_at）', async () => {
  const requestId = randomUUID();
  // 预置一行「已请求但还没有结论」：真实的顺序是先写 requested 再外发，外发那一步还没回。
  const port = createFakePort({
    rows: [
      {
        requestId,
        recipientId: 'alipay-cloud',
        exportRef: null,
        onlineState: 'requested',
        backupState: 'requested',
        requestedAt: isoAt(-60_000),
        confirmedAt: null,
        evidenceRef: null,
        errorCode: null,
      },
    ],
  });
  const adapter = createFakeAdapter(confirmedOutcome('ev-late'));
  const { dispatcher } = makeDispatcher({
    port,
    adapter,
    recipients: createFakeRecipients([{ recipientId: 'alipay-cloud' }]),
  });
  const result = await dispatcher.dispatch({ requestId, userId: USER_A.userId });
  assert.equal(result.rows[0].skipped, 'already_requested');
  assert.equal(adapter.calls.length, 0);
  assert.equal(port.writes.length, 0, '重复 requested 不许再写一行（真库那边由 COALESCE 兜底，但我们连写都不该发）');
  assert.equal(port.snapshot(requestId)[0].requestedAt, isoAt(-60_000), 'requested_at 不许被刷新');
});

test('failed 可被后续 confirmed 覆盖，且重发前不许用 requested 把 failed 盖回去', async () => {
  const requestId = randomUUID();
  const port = createFakePort({
    rows: [
      {
        requestId,
        recipientId: 'alipay-cloud',
        exportRef: null,
        onlineState: 'failed',
        backupState: 'failed',
        requestedAt: isoAt(-120_000),
        confirmedAt: null,
        evidenceRef: null,
        errorCode: 'THIRD_PARTY_TIMEOUT',
      },
    ],
  });
  const adapter = createFakeAdapter(confirmedOutcome('ev-retry'));
  const { dispatcher } = makeDispatcher({
    port,
    adapter,
    recipients: createFakeRecipients([{ recipientId: 'alipay-cloud' }]),
  });
  const result = await dispatcher.dispatch({ requestId, userId: USER_A.userId });
  assert.equal(result.reason, 'OK');
  assert.deepEqual(port.writes.map((write) => write.state), ['confirmed'], 'failed 之后重发只落结论，不许先写 requested');
  assert.equal(adapter.calls.length, 1, 'failed 不是终态 ⇒ 允许重发一次');
  const row = port.snapshot(requestId)[0];
  assert.equal(row.onlineState, 'confirmed');
  assert.equal(row.requestedAt, isoAt(-120_000), 'requested_at 仍是最初那次');
  assert.equal(row.errorCode, null, 'confirmed 之后不许残留上个失败的原因码');
});

test('同一请求内同一接收方重复出现 ⇒ 归一去重，只发一次', async () => {
  const port = createFakePort();
  const adapter = createFakeAdapter(confirmedOutcome('ev-dedupe'));
  const { dispatcher } = makeDispatcher({
    port,
    adapter,
    recipients: createFakeRecipients([
      { recipientId: 'alipay-cloud' },
      { recipientId: 'alipay-cloud' },
      { recipientId: '' },
      { recipientId: 'x'.repeat(81) },
    ]),
  });
  const requestId = randomUUID();
  const result = await dispatcher.dispatch({ requestId, userId: USER_A.userId });
  assert.equal(result.recipients, 1, '空/超 80 字符的接收方按端口层预检丢弃，重复的归一');
  assert.equal(adapter.calls.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// D) fail-open：写侧的任何问题都不许让注销回滚或抛出
// ─────────────────────────────────────────────────────────────────────────────

test('写失败 fail-open：不抛、计数、记事件；requested 都写不进去时干脆不外发', async () => {
  const port = createFakePort({ failWriteAt: 1 });
  const adapter = createFakeAdapter(confirmedOutcome());
  const { dispatcher, events } = makeDispatcher({
    port,
    adapter,
    recipients: createFakeRecipients([{ recipientId: 'alipay-cloud' }]),
  });
  const result = await dispatcher.dispatch({ requestId: randomUUID(), userId: USER_A.userId });

  assert.equal(result.reason, 'WRITE_FAILED');
  assert.equal(result.rows[0].writeFailed, true);
  assert.equal(adapter.calls.length, 0, '连 requested 都写不进去时**不许**外发（否则库里永远没有这笔外发的痕迹）');
  assert.equal(dispatcher.readings.writeFailures, 1);
  assert.equal(dispatcher.readings.lastError, '08006');
  const failureEvent = events.find((event) => event.event === 'third_party_deletion_write_failed');
  assert.ok(failureEvent !== undefined, '写失败必须有事件（⛔ 不许静默）');
  assert.equal(failureEvent.code, '08006');
  assert.equal(failureEvent.state, 'requested');
});

test('结论写入失败 fail-open：外发过、行停在 requested、计数与事件都留着', async () => {
  const port = createFakePort({ failWriteAt: 2 });
  const adapter = createFakeAdapter(confirmedOutcome('ev-lost'));
  const { dispatcher, events } = makeDispatcher({
    port,
    adapter,
    recipients: createFakeRecipients([{ recipientId: 'alipay-cloud' }]),
  });
  const requestId = randomUUID();
  const result = await dispatcher.dispatch({ requestId, userId: USER_A.userId });

  assert.equal(result.reason, 'WRITE_FAILED');
  assert.equal(adapter.calls.length, 1, '结论没写进去，但外发确实发生过（读数必须如实分开）');
  assert.equal(dispatcher.readings.dispatched, 1);
  assert.equal(dispatcher.readings.confirmed, 0, '没落库就不许记 confirmed');
  assert.equal(dispatcher.readings.writeFailures, 1);
  assert.equal(port.snapshot(requestId)[0].onlineState, 'requested', '行停在 requested（不假装收到了结论）');
  assert.ok(events.some((event) => event.event === 'third_party_deletion_write_failed' && event.state === 'confirmed'));
});

test('读现状失败 ⇒ READ_FAILED 且一次也不外发（"可能已发过"比"重复外发"更不可接受）', async () => {
  const port = createFakePort({ failReads: true });
  const adapter = createFakeAdapter(confirmedOutcome());
  const { dispatcher, events } = makeDispatcher({
    port,
    adapter,
    recipients: createFakeRecipients([{ recipientId: 'alipay-cloud' }]),
  });
  const result = await dispatcher.dispatch({ requestId: randomUUID(), userId: USER_A.userId });
  assert.equal(result.reason, 'READ_FAILED');
  assert.equal(adapter.calls.length, 0);
  assert.equal(port.writes.length, 0);
  assert.equal(dispatcher.readings.writeFailures, 1);
  assert.ok(events.some((event) => event.event === 'third_party_deletion_read_failed'));
});

test('收件人来源抛错 ⇒ RECIPIENTS_FAILED，不写不外发', async () => {
  const port = createFakePort();
  const adapter = createFakeAdapter(confirmedOutcome());
  const { dispatcher } = makeDispatcher({
    port,
    adapter,
    recipients: {
      async listRecipients() {
        throw withCode('收件人目录不可用', 'PROVIDER_UNAVAILABLE');
      },
    },
  });
  const result = await dispatcher.dispatch({ requestId: randomUUID(), userId: USER_A.userId });
  assert.equal(result.reason, 'RECIPIENTS_FAILED');
  assert.equal(port.writes.length, 0);
  assert.equal(adapter.calls.length, 0);
});

test('观测出口自己抛错也不许打断受理链', async () => {
  const port = createFakePort({ failWriteAt: 1 });
  const { dispatcher } = makeDispatcher({
    port,
    adapter: createFakeAdapter(confirmedOutcome()),
    recipients: createFakeRecipients([{ recipientId: 'alipay-cloud' }]),
    log: () => {
      throw new Error('logger exploded');
    },
  });
  const result = await dispatcher.dispatch({ requestId: randomUUID(), userId: USER_A.userId });
  assert.equal(result.reason, 'WRITE_FAILED', '日志出口坏了不影响判定');
  assert.equal(dispatcher.readings.writeFailures, 1);
});

test('写侧整体炸掉 ⇒ 注销主流程照常完成（fail-open 的最终证据）', async () => {
  const stores = createStores();
  const shape = (registry, requestId) => ({
    status: registry.completionStatus(requestId),
    handlers: registry
      .receipt(requestId)
      .handlers.map((handler) => [handler.module, handler.online_state, handler.backup_state]),
  });

  // 对照臂：同一个注销域，**完全不接**第三方写侧（今天生产在 stub 下的形态）。
  const control = createUserDataDeletion({ ...stores, now: () => new Date(CLOCK_MS) });
  const controlId = String(control.requestDeletionFor(USER_A.userId).id);
  await control.executeHandlers(controlId);

  // 故障臂：读写两侧都炸。
  const port = {
    persistent: true,
    async listThirdPartyDeletions() {
      throw withCode('注入的读失败', '08006');
    },
    async subscribeThirdPartyDeletion() {
      throw withCode('注入的写失败', '08006');
    },
  };
  const deletion = createUserDataDeletion({
    ...stores,
    now: () => new Date(CLOCK_MS),
    thirdParty: port,
    thirdPartyAdapter: createFakeAdapter(confirmedOutcome()),
    thirdPartyRecipients: createFakeRecipients([{ recipientId: 'alipay-cloud' }]),
  });
  const requestId = String(deletion.requestDeletionFor(USER_A.userId).id);
  // 1) 没有抛：`executeHandlers()` 正常返回协调器结果。
  const executed = await deletion.executeHandlers(requestId);
  assert.equal(typeof executed, 'object');

  // 2) 注销本体与「完全没接第三方」那一臂**逐字一致**（⛔ 写侧炸了不许改变注销结果）。
  assert.deepEqual(shape(deletion, requestId), shape(control, controlId));
  assert.deepEqual(
    deletion.receipt(requestId).handlers.map((handler) => [handler.module, handler.online_state]),
    [
      ['favorites', 'completed'],
      ['history', 'completed'],
      ['messages', 'completed'],
      ['conversations', 'completed'],
    ],
  );
  // 3) 写侧如实记账（⛔ 不静默）：失败次数 > 0，且最近一次结论是可判的原因码。
  assert.equal(deletion.thirdPartyWrites.writeFailures, 1);
  assert.equal(deletion.thirdPartyWrites.lastError, '08006');
  assert.equal(deletion.lastThirdPartyDispatch().reason, 'READ_FAILED');
});

// ─────────────────────────────────────────────────────────────────────────────
// E) 装配探测 + 真实 app 装配（今天生产的行为）
// ─────────────────────────────────────────────────────────────────────────────

test('writePortOf()：只有真带了写方法的端口才算写侧已接线（unwired/unavailable 一律 null）', async () => {
  const { createUnwiredThirdPartyDeletionPort, createUnavailableThirdPartyDeletionPort } = await import(
    '../../services/api/src/privacy/user-data-deletion.ts'
  );
  assert.equal(writePortOf(createUnwiredThirdPartyDeletionPort()), null);
  assert.equal(writePortOf(createUnavailableThirdPartyDeletionPort()), null);
  assert.equal(writePortOf(null), null);
  assert.equal(writePortOf({}), null);
  const writable = createFakePort();
  assert.equal(writePortOf(writable), writable, '真库端口读写同体 ⇒ 探测到的就是同一个对象');
});

test('app 装配：注入真库形状端口 + 适配器，但没有收件人来源 ⇒ 202 照常、库里零行（今天生产就是这样）', async () => {
  const port = createFakePort();
  const adapter = createFakeAdapter(confirmedOutcome('ev-app'));
  const authStore = createMemoryAuthStore();
  const app = buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    now: () => new Date(CLOCK_MS),
    store: authStore,
    favoritesInjection: { store: createMemoryFavoritesStore({ now: () => CLOCK_MS }) },
    historyInjection: { store: createMemoryHistoryStore({ now: () => CLOCK_MS }) },
    userDataDeletionInjection: { thirdParty: port, thirdPartyAdapter: adapter },
  });
  const user = await authStore.createUser(`tpd-write-${randomUUID().replace(/-/g, '')}`);
  const token = mintOpaqueToken();
  await authStore.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(CLOCK_MS + 3600 * 1000),
    audience: 'user',
  });

  const accepted = await app.inject({
    method: 'POST',
    url: DELETION_PATH,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': `tpd-write-${randomUUID()}` },
    payload: { confirmation: 'delete_account' },
  });
  assert.equal(accepted.statusCode, 202, '写侧"没接上收件人"不许影响注销受理');

  const registry = app.userDataDeletion;
  assert.equal(registry.lastThirdPartyDispatch().reason, 'RECIPIENTS_UNWIRED');
  assert.equal(registry.thirdPartyWrites.dispatched, 0);
  assert.equal(registry.thirdPartyWrites.writeFailures, 0);
  assert.equal(port.writes.length, 0, '没有真实接收方 ⇒ 一条也不写（⛔ 不伪造接收方）');
});

test('回归：回执的 third_party_state 仍由路由投影给出，写侧只改持久行（不改协议处理器行）', async () => {
  const port = createFakePort();
  const { deletion, requestId } = await runDeletion({
    thirdParty: port,
    thirdPartyAdapter: createFakeAdapter(confirmedOutcome('ev-proj')),
    thirdPartyRecipients: createFakeRecipients([{ recipientId: 'alipay-cloud' }]),
  });
  const receipt = deletion.receipt(requestId);
  // `packages/privacy/deletion.mjs:359` 创建的处理器行 `thirdPartyState` 恒为 null，
  // 且写侧**不**去改协议账本 ⇒ 协调器回执的该字段仍是 null；页面上的值由
  // `routes/account-deletion.ts::thirdPartyStateOf()` 读同一批持久行后覆盖。
  assert.deepEqual(
    receipt.handlers.map((handler) => handler.third_party_state),
    [null, null, null, null],
    '写侧不许偷偷改写协调器回执（否则回执与投影会变成两本账）',
  );
  assert.equal(port.snapshot(requestId)[0].onlineState, 'confirmed', '事实在库里，不在这里');
});

// ─────────────────────────────────────────────────────────────────────────────
// F) R73-P1：取消与派发的交叠（取消受理之后不许再产生新的写入与外发）
//
// 负控制 N5：把 `third-party-deletion-dispatch.ts` 里的四个取消检查点删掉（或只在入口查一次）⇒
// T-P1-a / T-P1-b / T-P1-d 变红（取消已受理，但适配器仍被调用一次、`requested`/`confirmed` 仍写下去）。
// 负控制 N6（第二轮）：把最后一次同步读取那一行临时改成恒 `false`（等于退回「读到未取消」的旧口径，
// 让读与外发之间的让位点重新出现）⇒ T-P1-e 变红（`adapter_calls=1`、`writes=[requested, confirmed]`）。
// 反向对照：T-P1-c 证明判据没有把正常路径一起关掉。
// ─────────────────────────────────────────────────────────────────────────────

test('R73-P1 T-P1-a：收件人查询期间取消 ⇒ 零外发、零写入，回执仍是 cancelled', async () => {
  const port = createFakePort();
  const adapter = createFakeAdapter(confirmedOutcome());
  const gate = createGate();
  const deletion = createUserDataDeletion({
    ...createStores(),
    now: () => new Date(CLOCK_MS),
    thirdParty: port,
    thirdPartyAdapter: adapter,
    thirdPartyRecipients: createGatedRecipients([{ recipientId: 'alipay-cloud' }], gate),
  });
  const requestId = String(deletion.requestDeletionFor(USER_A.userId).id);

  // 受理后**不 await**：让 executeHandlers 一路跑到收件人查询，被闸门按住。
  const running = deletion.executeHandlers(requestId);
  await gate.entered;

  // 此刻取消：回执必须立刻是 cancelled，且取消之前确实一条也没写、一次也没发。
  const cancelled = deletion.cancelDeletion(USER_A.userId);
  assert.equal(cancelled.state, 'cancelled', '取消受理必须立刻在回执里可见');
  assert.equal(adapter.calls.length, 0, '取消那一刻还没有外发');
  assert.equal(port.writes.length, 0, '取消那一刻还没有写入');

  gate.open();
  const executed = await running;
  assert.equal(typeof executed, 'object');

  assert.equal(adapter.calls.length, 0, '放行之后也不许再外发（取消之后没有新的外发）');
  assert.deepEqual(port.writes, [], '放行之后也不许再写 requested/confirmed（既成事实之外零新写）');
  assert.equal(deletion.receipt(requestId).state, 'cancelled', '本次回执仍是 cancelled');
  assert.equal(deletion.lastThirdPartyDispatch().reason, 'CANCELLED_AFTER_ACCEPT');
  assert.equal(deletion.thirdPartyWrites.dispatched, 0, '外发读数为零（⛔ 不改口）');
  assert.equal(deletion.thirdPartyWrites.skippedCancelled, 1);
});

test('R73-P1 T-P1-b：列收件人 / 读现状两个 await 窗口里取消 ⇒ 都零外发、零新写入', async () => {
  for (const placement of ['listRecipients', 'listThirdPartyDeletions']) {
    const gate = createGate();
    const basePort = createFakePort();
    const port = placement === 'listThirdPartyDeletions' ? createGatedReadPort(basePort, gate) : basePort;
    const adapter = createFakeAdapter(confirmedOutcome());
    const deletion = createUserDataDeletion({
      ...createStores(),
      now: () => new Date(CLOCK_MS),
      thirdParty: port,
      thirdPartyAdapter: adapter,
      thirdPartyRecipients:
        placement === 'listRecipients'
          ? createGatedRecipients([{ recipientId: 'alipay-cloud' }], gate)
          : createFakeRecipients([{ recipientId: 'alipay-cloud' }]),
    });
    const requestId = String(deletion.requestDeletionFor(USER_A.userId).id);

    const running = deletion.executeHandlers(requestId);
    await gate.entered;
    assert.equal(deletion.cancelDeletion(USER_A.userId).state, 'cancelled', `${placement}：取消必须受理`);

    gate.open();
    await running;

    assert.equal(adapter.calls.length, 0, `${placement}：取消之后不许外发`);
    assert.equal(basePort.writes.length, 0, `${placement}：取消之后不许写 requested/confirmed`);
    assert.equal(deletion.lastThirdPartyDispatch().reason, 'CANCELLED_AFTER_ACCEPT', `${placement}：原因必须可判`);
    assert.equal(deletion.thirdPartyWrites.dispatched, 0, `${placement}：外发读数为零`);
    assert.equal(deletion.thirdPartyWrites.skippedCancelled, 1, `${placement}：跳过读数如实计数`);
  }
});

test('R73-P1 T-P1-c：同一条链不取消 ⇒ 仍是一次外发 + requested→confirmed（判据没关掉正常路径）', async () => {
  const port = createFakePort();
  const adapter = createFakeAdapter(confirmedOutcome('ev-r73-p1'));
  const deletion = createUserDataDeletion({
    ...createStores(),
    now: () => new Date(CLOCK_MS),
    thirdParty: port,
    thirdPartyAdapter: adapter,
    thirdPartyRecipients: createFakeRecipients([{ recipientId: 'alipay-cloud' }]),
  });
  const requestId = String(deletion.requestDeletionFor(USER_A.userId).id);
  await deletion.executeHandlers(requestId);

  assert.equal(adapter.calls.length, 1);
  assert.deepEqual(port.writes.map((write) => write.state), ['requested', 'confirmed']);
  assert.equal(deletion.lastThirdPartyDispatch().reason, 'OK');
  assert.equal(deletion.thirdPartyWrites.skippedCancelled, 0);
});

test('R73-P1 T-P1-d：取消判据抛错 ⇒ 按取消处理（零外发、零写入、原因可判）', async () => {
  const port = createFakePort();
  const adapter = createFakeAdapter(confirmedOutcome());
  const { dispatcher, events } = makeDispatcher({
    port,
    adapter,
    recipients: createFakeRecipients([{ recipientId: 'alipay-cloud' }]),
  });
  const result = await dispatcher.dispatch({
    requestId: randomUUID(),
    userId: USER_A.userId,
    // 「判据自己坏了」不能等于「放行外发」：fail-closed 到不发。
    isRequestCancelled: () => {
      throw withCode('判据自己坏了', 'PROBE_BROKEN');
    },
  });

  assert.equal(result.reason, 'CANCELLED_AFTER_ACCEPT');
  assert.equal(adapter.calls.length, 0);
  assert.equal(port.writes.length, 0);
  assert.equal(dispatcher.readings.dispatched, 0);
  assert.equal(dispatcher.readings.skippedCancelled, 1);
  assert.equal(dispatcher.readings.writeFailures, 0, '判据坏了不是持久侧失败（⛔ 不混进写失败读数）');
  const skipped = events.find((event) => event.event === 'third_party_deletion_skipped_cancelled');
  assert.ok(skipped !== undefined, '跳过必须有事件（⛔ 不许静默）');
  assert.equal(skipped.recipient_id, 'alipay-cloud');
  assert.equal(skipped.skipped_reason, 'probe_failed');
});

test('R73-P1 T-P1-e：requested 写完那一轮里受理取消 ⇒ 零外发、只留 requested、回执 cancelled', async () => {
  const base = createFakePort();
  const adapter = createFakeAdapter(confirmedOutcome('ev-too-late'));
  // 取消受理那一刻的读数（监工反例里那两行：state=cancelled、adapter_calls=0）。
  const accepted = [];
  let deletion = null;
  const port = createCancelAtRequestedWritePort(base, () => {
    const receipt = deletion.cancelDeletion(USER_A.userId);
    accepted.push({ state: receipt.state, adapterCalls: adapter.calls.length });
  });
  deletion = createUserDataDeletion({
    ...createStores(),
    now: () => new Date(CLOCK_MS),
    thirdParty: port,
    thirdPartyAdapter: adapter,
    thirdPartyRecipients: createFakeRecipients([{ recipientId: 'alipay-cloud' }]),
  });
  const requestId = String(deletion.requestDeletionFor(USER_A.userId).id);
  await deletion.executeHandlers(requestId);

  assert.deepEqual(accepted, [{ state: 'cancelled', adapterCalls: 0 }], '反例前置：取消受理时一次外发都还没有');
  assert.equal(adapter.calls.length, 0, '取消已受理之后不许再发起外发（最后一米的读数必须是最新的）');
  assert.deepEqual(
    base.writes.map((write) => write.state),
    ['requested'],
    '既成事实只有 requested：取消之后不许再写 confirmed',
  );
  assert.equal(deletion.receipt(requestId).state, 'cancelled', '本次回执仍是 cancelled');
  assert.equal(deletion.lastThirdPartyDispatch().reason, 'CANCELLED_AFTER_ACCEPT', '原因必须可判（⛔ 不许落成 OK）');
  assert.ok(deletion.thirdPartyWrites.skippedCancelled >= 1, '跳过读数如实计数');
  assert.equal(deletion.thirdPartyWrites.dispatched, 0, '外发读数为零');
});

test('R73-P1 T-P1-f：异步判据在最后一米无法同步确认 ⇒ fail-closed 到不发（⛔ 不许静默外发）', async () => {
  const port = createFakePort();
  const adapter = createFakeAdapter(confirmedOutcome());
  const { dispatcher, events } = makeDispatcher({
    port,
    adapter,
    recipients: createFakeRecipients([{ recipientId: 'alipay-cloud' }]),
  });
  const result = await dispatcher.dispatch({
    requestId: randomUUID(),
    userId: USER_A.userId,
    // 判据永远 resolve 成「未取消」：最后一米仍拿不到同步布尔值 ⇒ 少发，不多发。
    isRequestCancelled: async () => false,
  });

  assert.equal(adapter.calls.length, 0, '异步判据无法同步确认时不许外发');
  assert.equal(result.reason, 'CANCELLED_AFTER_ACCEPT', '不是静默外发，也不是 OK');
  assert.equal(port.writes.length, 0, '连 requested 都不写（写之前那一读就没通过）');
  assert.equal(dispatcher.readings.dispatched, 0);
  assert.equal(dispatcher.readings.skippedCancelled, 1);
  const skipped = events.find((event) => event.event === 'third_party_deletion_skipped_cancelled');
  assert.ok(skipped !== undefined, '跳过必须有事件（⛔ 不许静默）');
  assert.equal(skipped.skipped_reason, 'unconfirmable', '原因与「判据抛错」分开：这里是拿不到同步值');
});

test('R73-P1 T-P1-g：前两次探测成功、最后一次异步 reject ⇒ 拒绝就地收尾，零发零写且不炸进程', async () => {
  const port = createFakePort();
  const adapter = createFakeAdapter(confirmedOutcome());
  const { dispatcher } = makeDispatcher({
    port,
    adapter,
    recipients: createFakeRecipients([{ recipientId: 'alipay-cloud' }]),
  });
  const probeCalls = [];
  const leaked = [];
  const onUnhandled = (reason) => leaked.push(reason);
  // 只为取证「有没有漏出 unhandled rejection」；产品侧收尾不依赖这个监听器。
  process.on('unhandledRejection', onUnhandled);
  try {
    const result = await dispatcher.dispatch({
      requestId: randomUUID(),
      userId: USER_A.userId,
      // 审查反例的形状：两个远端检查点都 resolve 成「未取消」，紧贴副作用那一读起异步失败。
      // 失败的那几份 Promise 没人 await（同步读只能返回 `'unconfirmable'`），必须被就地收尾。
      isRequestCancelled: () => {
        probeCalls.push(probeCalls.length + 1);
        return probeCalls.length <= 2
          ? Promise.resolve(false)
          : Promise.reject(new Error('SYNTHETIC_PROBE_OFFLINE'));
      },
    });
    // `unhandledRejection` 在微任务清空后才判定：等一个宏任务再断言，免得测早了看不出来。
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 用例能走到这里并跑完断言，本身就是「没被未处理拒绝打断」的证据。
    assert.equal(leaked.length, 0, 'thenable 的拒绝必须被就地收尾（⛔ 不许漏成 unhandled rejection）');
    assert.ok(probeCalls.length >= 3, '确实走到了紧贴副作用的补问（前两次成功、之后失败）');
    assert.equal(result.reason, 'CANCELLED_AFTER_ACCEPT', '读不到同步布尔值 ⇒ fail-closed 到不发');
    assert.equal(adapter.calls.length, 0, '零外发');
    assert.equal(port.writes.length, 0, '零写入（连 requested 都不写）');
    assert.equal(dispatcher.readings.dispatched, 0);
    assert.equal(dispatcher.readings.skippedCancelled, 1);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
