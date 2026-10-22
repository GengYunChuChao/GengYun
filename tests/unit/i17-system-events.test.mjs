/**
 * GY-I17（#17）阶段 2 · **账号级系统事件**（`system` 消息）单元回归（服务层 + HTTP 装配臂）。
 *
 * 覆盖（裁定 `.pg17/ruling-r31-i17-system-events-20261022.md`：只做 S1/S2，接受服务层 + PG 臂证据）：
 *   S1 `account_suspended` / S2 `account_restored`：`changed=true` ⇒ **恰好一条** `system` 消息，
 *      `read_at=null`、`target_ref=null`、事件键 `system:account:suspend|restore:<userId>:e<authEpoch>`；
 *   `changed=false`（重复停用）⇒ **0 条**新消息，计数 `skipped`；
 *   同键重投（重试/并发收敛）⇒ `created:false`、行数不变、**不重置**读状态；
 *   `countUnread` 增量恰 `+1`；列表投影 `target_ref=null ⇒ unavailable` 且**不调用**目标读取端口；
 *   消息写入抛错 ⇒ 账号处置**仍成功**（fail-open），但 `delivered:false` + `failed` 计数 + `warn` 日志；
 *   HTTP 臂：`POST /admin/accounts/{id}/suspend` 200 ⇒ 收件箱出现 1 条 `system`；写入失败仍 200。
 *
 * **可读性限制（如实，不得被引用为端到端证据）**：停用期间收件人 `state !== 'active'` ⇒
 * `/messages` 一律 401/403；恢复当前**没有** HTTP 路由（契约 `operations.json` 只有 `suspendUser`）。
 * 本文件的 HTTP 臂用**合成账号权威**（不连真库、不改内存账号状态）证明的是
 * 「账号处置结果 ⇒ 消息落库」的装配与语义，**不是**「收件人端到端可读」。真 PG 行为见
 * `tests/integration/messages-pg.mjs`（本片未取得真库读数）。
 *
 * 声明：所有账号/消息都是**合成输入**，不发起任何真实付费调用、不连真库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import { createMessagesService } from '../../services/api/src/messages/service.ts';
import { createWiredReferencePort } from '../../services/api/src/messages/reference.ts';
import {
  accountSystemEventKey,
  createMessagesAccountEventsPort,
  createUnwiredAccountEventsPort,
  withAccountSystemEvents,
} from '../../services/api/src/admin/ops/account-events.ts';

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const AUDIT_ID = '66666666-6666-4666-8666-666666666666';
const REQUEST_ID = '99999999-9999-4999-8999-999999999999';
const SIGNING_KEY = 'i17-system-events-test-signing-key';
const USER_ACTOR = { userId: OWNER, role: 'user', authEpoch: 1 };
const ACTION = { actorId: ACTOR, auditId: AUDIT_ID, userId: OWNER, expectedRevision: 1, requestId: REQUEST_ID };

function accountView(state) {
  return { id: OWNER, revision: 1, state, display_name: '示例账号' };
}

function outcomeOf(overrides = {}) {
  return {
    account: accountView('suspended'),
    authEpoch: 2,
    revokedSessions: 1,
    changed: true,
    auditId: AUDIT_ID,
    ...overrides,
  };
}

/** 合成账号权威：如实记录调用、按脚本回传 outcome（**不连真库**）。 */
function scriptedAuthority(script) {
  const calls = [];
  return {
    calls,
    authority: {
      persistent: true,
      async suspend(action) {
        calls.push({ op: 'suspend', action });
        return script.suspend(action);
      },
      async restore(action) {
        calls.push({ op: 'restore', action });
        return script.restore(action);
      },
    },
  };
}

/** 消息域（内存 store + **已接线**目标读取端口，后者记录每次调用）。 */
function makeServiceLayer() {
  let tick = 0;
  const start = Date.UTC(2026, 9, 22, 4);
  const now = () => new Date(start + (tick += 1) * 1000);
  const referenceCalls = [];
  const reference = createWiredReferencePort({
    resolve: async (input) => {
      referenceCalls.push(input);
      return 'available';
    },
  });
  const store = createMemoryMessagesStore({ now: () => now().getTime() });
  const service = createMessagesService({ store, reference, signingKey: SIGNING_KEY, now });
  return { store, service, referenceCalls };
}

function recordingLog() {
  const entries = [];
  return {
    entries,
    warn(payload, message) {
      entries.push({ payload, message });
    },
  };
}

// ---------------------------------------------------------------------------
// S1 / S2 生产语义
// ---------------------------------------------------------------------------

test('S1 changed=true ⇒ 恰好一条 system 消息：target_ref=null、read_at=null、键含 e<authEpoch>', async () => {
  const h = makeServiceLayer();
  const events = createMessagesAccountEventsPort({ messages: h.service });
  const { authority, calls } = scriptedAuthority({
    suspend: async () => outcomeOf(),
    restore: async () => outcomeOf(),
  });
  const decorated = withAccountSystemEvents(authority, { events });

  const outcome = await decorated.suspend(ACTION);

  assert.equal(calls.length, 1, '装饰器必须原样调用底层权威一次');
  assert.deepEqual(calls[0].action, ACTION, '入参不得被改写');
  assert.equal(outcome.changed, true, '返回值必须原样透传（不改写 outcome）');
  const rows = await h.store.listMessagesByOwner(OWNER);
  assert.equal(rows.length, 1, '一次真变更只产生一条系统消息');
  const [row] = rows;
  assert.equal(row.type, 'system', '账号级处置必须是 system（不是 moderation）');
  assert.equal(row.target_ref, null, '契约 TargetRef 闭集无 account 型 ⇒ 恒 null，不得臆造');
  assert.equal(row.read_at, null, '创建不当已读');
  assert.equal(row.event_key, `system:account:suspend:${OWNER}:e2`);
  assert.equal(
    row.event_key,
    accountSystemEventKey({ event: 'account_suspended', ownerId: OWNER, authEpoch: 2 }),
    '事件键必须由唯一映射函数给出',
  );
  assert.equal(events.wired, true);
  assert.equal(events.counters.delivered, 1);
  assert.equal(events.counters.failed, 0);
  assert.equal(events.counters.skipped, 0);
  // 未读派生：恰 +1（不是计数器列的读改写）。
  assert.deepEqual(await h.service.getUnreadCount(USER_ACTOR), { count: 1 });
});

test('S2 恢复事件用 restore 键；两次真变更（epoch 2→3）⇒ 两条不同键、未读=2、键长不超上界', async () => {
  const h = makeServiceLayer();
  const events = createMessagesAccountEventsPort({ messages: h.service });
  const { authority } = scriptedAuthority({
    suspend: async () => outcomeOf({ authEpoch: 2 }),
    restore: async () => outcomeOf({ authEpoch: 3, account: accountView('active'), revokedSessions: 0 }),
  });
  const decorated = withAccountSystemEvents(authority, { events });

  await decorated.suspend(ACTION);
  const restored = await decorated.restore(ACTION);

  assert.equal(restored.authEpoch, 3);
  const rows = await h.store.listMessagesByOwner(OWNER);
  assert.equal(rows.length, 2, '停用 + 恢复各一条');
  const keys = rows.map((row) => row.event_key).sort();
  assert.deepEqual(keys, [
    `system:account:restore:${OWNER}:e3`,
    `system:account:suspend:${OWNER}:e2`,
  ], '两类事件、两个版本必须是不同的键');
  assert.deepEqual(await h.service.getUnreadCount(USER_ACTOR), { count: 2 });
  const longest = accountSystemEventKey({
    event: 'account_restored', ownerId: OWNER, authEpoch: Number.MAX_SAFE_INTEGER,
  });
  assert.ok(longest.length <= 200, `事件键 ${longest.length} 不得超消息域 200 上界`);
});

test('changed=false（重复停用）⇒ 0 条新消息、不重置读状态、计数 skipped', async () => {
  const h = makeServiceLayer();
  const events = createMessagesAccountEventsPort({ messages: h.service });
  let epoch = 2;
  let changed = true;
  const { authority } = scriptedAuthority({
    // 第一次真变更（epoch 2）；第二次幂等重放：状态已是 suspended ⇒ changed=false、epoch 不变。
    suspend: async () => {
      const outcome = outcomeOf({ authEpoch: epoch, changed });
      changed = false;
      return outcome;
    },
    restore: async () => outcomeOf(),
  });
  const decorated = withAccountSystemEvents(authority, { events });

  await decorated.suspend(ACTION);
  const rows = await h.store.listMessagesByOwner(OWNER);
  assert.equal(rows.length, 1);
  await h.service.markMessageRead(USER_ACTOR, rows[0].id, { idempotencyKey: 'i17-sys-events-read-0001', ifMatch: '"1"' });
  assert.deepEqual(await h.service.getUnreadCount(USER_ACTOR), { count: 0 });

  const replay = await decorated.suspend(ACTION);

  assert.equal(replay.changed, false, '幂等分支如实回传 changed=false');
  assert.equal(epoch, 2, '幂等分支不递增 auth_epoch');
  const after = await h.store.listMessagesByOwner(OWNER);
  assert.equal(after.length, 1, '重放不得产生第二条消息');
  assert.notEqual(after[0].read_at, null, '幂等重放不得重置读状态');
  assert.deepEqual(await h.service.getUnreadCount(USER_ACTOR), { count: 0 });
  assert.equal(events.counters.skipped, 1);
  assert.equal(events.counters.delivered, 1, '只有第一次真变更投递');
});

test('同键重投（重试/并发收敛）⇒ created:false、行数不变、读状态不重置', async () => {
  const h = makeServiceLayer();
  const events = createMessagesAccountEventsPort({ messages: h.service });
  const event = { event: 'account_suspended', ownerId: OWNER, authEpoch: 2 };

  const first = await events.publish(event);
  const second = await events.publish(event);

  assert.equal(first.created, true);
  assert.equal(second.created, false, '同 (owner_id, event_key) 只能有一条');
  assert.equal(second.messageId, first.messageId, '命中去重键时回传既有消息 id');
  assert.equal((await h.store.listMessagesByOwner(OWNER)).length, 1);
  assert.equal(events.counters.delivered, 2, '两次都被消息域接受（第二次是同键去重）');

  await h.service.markMessageRead(USER_ACTOR, first.messageId, { idempotencyKey: 'i17-sys-events-read-0002', ifMatch: '"1"' });
  const marked = (await h.store.listMessagesByOwner(OWNER))[0];
  await events.publish(event);
  const again = (await h.store.listMessagesByOwner(OWNER))[0];
  assert.equal(again.read_at, marked.read_at, '同键重投不得重置读状态');
  assert.deepEqual(await h.service.getUnreadCount(USER_ACTOR), { count: 0 });
});

// ---------------------------------------------------------------------------
// 投影：target_ref=null ⇒ unavailable（且不调端口）
// ---------------------------------------------------------------------------

test('列表投影：system 的 target_ref=null ⇒ reference_state 恒 unavailable 且不调用目标读取端口', async () => {
  const h = makeServiceLayer();
  const events = createMessagesAccountEventsPort({ messages: h.service });
  const { authority } = scriptedAuthority({ suspend: async () => outcomeOf(), restore: async () => outcomeOf() });
  await withAccountSystemEvents(authority, { events }).suspend(ACTION);

  const page = await h.service.listMessages(USER_ACTOR);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].type, 'system');
  assert.equal(page.items[0].target_ref, null);
  assert.equal(page.items[0].reference_state, 'unavailable', '没有可核验目标 ⇒ 保守不可用（不是 available）');
  assert.deepEqual(h.referenceCalls, [], 'target_ref=null 时**不得**调用目标读取端口（早返回）');

  // 对照：带真实 target_ref 的消息会调用端口，且端口回 available ⇒ 投影为 available。
  await h.service.appendMessage({
    owner_id: OWNER,
    type: 'moderation',
    target_ref: { type: 'post', id: 'post-1', revision: 1 },
    event_key: 'control:moderation:post-1:r1',
  });
  const withControl = await h.service.listMessages(USER_ACTOR);
  assert.equal(h.referenceCalls.length, 1, '有目标时才查端口（证明上面的"零调用"不是端口没接线）');
  const control = withControl.items.find((item) => item.type === 'moderation');
  assert.equal(control.reference_state, 'available');
});

// ---------------------------------------------------------------------------
// fail-open：消息写入失败不回滚账号处置
// ---------------------------------------------------------------------------

test('消息写入抛错 ⇒ 账号处置仍成功（同一 outcome）、delivered:false、failed 计数、warn 日志', async () => {
  const expected = outcomeOf();
  const { authority } = scriptedAuthority({ suspend: async () => expected, restore: async () => expected });
  const events = createMessagesAccountEventsPort({
    messages: {
      async appendMessage() {
        throw Object.assign(new Error('合成故障：消息域不可用'), { code: 'PROVIDER_UNAVAILABLE' });
      },
    },
  });
  const log = recordingLog();
  const decorated = withAccountSystemEvents(authority, { events, log });

  const outcome = await decorated.suspend(ACTION);

  assert.equal(outcome, expected, '通知失败不得改写/吞掉已提交的账号处置结果');
  assert.equal(events.counters.failed, 1);
  assert.equal(events.counters.delivered, 0);
  assert.equal(log.entries.length, 1, '失败必须留可诊断日志');
  assert.equal(log.entries[0].payload.event, 'account_suspended');
  assert.equal(log.entries[0].payload.owner_id, OWNER);
  assert.equal(log.entries[0].payload.reason, 'PROVIDER_UNAVAILABLE');
  assert.equal(log.entries[0].payload.delivered, false);
  assert.equal(log.entries[0].payload.failed_total, 1);
  assert.match(log.entries[0].message, /fail-open/);
});

test('事件端口自身抛错（违约）⇒ 装饰器折叠为未投递，仍不吞账号处置结果', async () => {
  const expected = outcomeOf({ authEpoch: 5 });
  const { authority } = scriptedAuthority({ suspend: async () => expected, restore: async () => expected });
  const events = {
    wired: true,
    note: '合成：publish 违约抛错',
    counters: { delivered: 0, failed: 0, skipped: 0 },
    async publish() {
      throw new Error('合成违约：端口直接抛错');
    },
  };
  const log = recordingLog();

  const outcome = await withAccountSystemEvents(authority, { events, log }).suspend(ACTION);

  assert.equal(outcome, expected);
  assert.equal(log.entries.length, 1, '端口违约也必须留痕（否则失败静默）');
  assert.equal(log.entries[0].payload.reason, 'EVENT_DELIVERY_FAILED');
});

test('未接线端口（消息服务 null）⇒ 不伪造投递：failed=1 + warn 日志 + 0 行', async () => {
  const h = makeServiceLayer();
  const { authority } = scriptedAuthority({ suspend: async () => outcomeOf(), restore: async () => outcomeOf() });
  const events = createUnwiredAccountEventsPort('消息服务未接线（合成）');
  const log = recordingLog();

  await withAccountSystemEvents(authority, { events, log }).suspend(ACTION);

  assert.equal(events.wired, false);
  assert.equal(events.counters.failed, 1, '未接线不得算成功');
  assert.equal(log.entries.length, 1);
  assert.equal((await h.store.listMessagesByOwner(OWNER)).length, 0);
});

// ---------------------------------------------------------------------------
// HTTP 装配臂：账号停用路由 ⇒ system 消息（收件箱可见性仅到服务层，见文件头限制）
// ---------------------------------------------------------------------------

async function httpFixture(t, { appendMessage } = {}) {
  const auth = createMemoryAuthStore();
  const messagesStore = createMemoryMessagesStore({ now: () => Date.now() });
  const logs = recordingLog();
  const messagesHolder = { service: null };
  const events = createMessagesAccountEventsPort({
    messages: {
      appendMessage: appendMessage ?? ((input) => messagesHolder.service.appendMessage(input)),
    },
  });
  const target = await auth.createUser('7'.repeat(64));
  const baseAuthority = {
    persistent: true,
    async suspend() {
      return outcomeOf({ account: { ...accountView('suspended'), id: target.id } });
    },
    async restore() {
      return outcomeOf({ account: { ...accountView('active'), id: target.id }, authEpoch: 3, revokedSessions: 0 });
    },
  };
  const app = buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    store: auth,
    messagesInjection: { store: messagesStore },
    adminInjection: {
      // 生产装配点（`app.ts` 的 real 分支）用同一装饰器包真实 PG 权威；这里用合成权威走同一路径。
      accountAuthority: withAccountSystemEvents(baseAuthority, { events, log: logs }),
    },
  });
  messagesHolder.service = app.messagesService;
  const start = Date.now();
  const adminId = await auth.createAdmin({
    loginName: 'i17-sys-events-admin',
    credentialHash: 'synthetic-not-a-real-credential-hash',
    scopes: ['accounts:suspend'],
  });
  const adminToken = 'synthetic-i17-sys-events-admin-token';
  await auth.createSession({
    userId: adminId, tokenHashHex: hashToken(adminToken), authEpoch: 1,
    expiresAt: new Date(start + 3600_000), audience: 'admin',
  });
  const userToken = 'synthetic-i17-sys-events-user-token';
  await auth.createSession({
    userId: target.id, tokenHashHex: hashToken(userToken), authEpoch: target.authEpoch,
    expiresAt: new Date(start + 3600_000), audience: 'user',
  });
  t.after(() => app.close());
  let seq = 0;
  async function suspend() {
    seq += 1;
    return app.inject({
      method: 'POST',
      url: `/api/v1/admin/accounts/${target.id}/suspend`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
        'idempotency-key': `i17-sys-events-http-${String(seq).padStart(4, '0')}`,
        'if-match': '"1"',
      },
      payload: { reason: '示例：违规处置' },
    });
  }
  async function inbox() {
    return app.inject({ method: 'GET', url: '/api/v1/messages', headers: { authorization: `Bearer ${userToken}` } });
  }
  async function unread() {
    return app.inject({ method: 'GET', url: '/api/v1/messages/unread-count', headers: { authorization: `Bearer ${userToken}` } });
  }
  return { app, auth, messagesStore, events, logs, target, suspend, inbox, unread };
}

test('HTTP：POST /admin/accounts/{id}/suspend 200 ⇒ 收件箱 1 条 system（target_ref=null、unavailable、未读）', async (t) => {
  const h = await httpFixture(t);

  const suspended = await h.suspend();
  assert.equal(suspended.statusCode, 200, suspended.body);
  assert.equal(suspended.json().data.state, 'suspended', '响应体仍是账号投影（装饰器不改写）');

  const rows = await h.messagesStore.listMessagesByOwner(h.target.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'system');
  assert.equal(rows[0].target_ref, null);
  assert.equal(rows[0].event_key, `system:account:suspend:${h.target.id}:e2`);
  assert.equal(h.events.counters.delivered, 1);

  const list = await h.inbox();
  assert.equal(list.statusCode, 200, list.body);
  const items = list.json().data.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'system');
  assert.equal(items[0].target_ref, null);
  assert.equal(items[0].reference_state, 'unavailable');
  assert.equal(items[0].read_at, null, '发送/创建不当作已读');
  const count = await h.unread();
  assert.equal(count.json().data.count, 1);
});

test('HTTP：消息写入抛错 ⇒ 停用仍 200（不回滚）、计数 failed=1、收件箱 0 条', async (t) => {
  const h = await httpFixture(t, {
    appendMessage: async () => {
      throw Object.assign(new Error('合成故障：消息域不可用'), { code: 'PROVIDER_UNAVAILABLE' });
    },
  });

  const suspended = await h.suspend();

  assert.equal(suspended.statusCode, 200, '账号处置是权威结果：通知失败不得把它变成 5xx');
  assert.equal(suspended.json().data.state, 'suspended');
  assert.equal(h.events.counters.delivered, 0);
  assert.equal(h.events.counters.failed, 1);
  assert.equal(h.logs.entries.length, 1);
  assert.equal(h.logs.entries[0].payload.reason, 'PROVIDER_UNAVAILABLE');
  const list = await h.inbox();
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().data.items, [], '失败不得留下半条消息');
  assert.equal((await h.unread()).json().data.count, 0);
});
