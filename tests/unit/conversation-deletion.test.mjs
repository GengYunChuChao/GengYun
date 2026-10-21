// GY-I12（#12）：删除级联与 F13 注销清理回归。
//
// 覆盖：`deleteTurn` 的 202 + 非契约披露头 `X-GY-Cascade`（只区分已启动/未接线/失败）、
// 轮次级联（回答随轮次一并消失）、`deleteConversation` 的级联、F13 模块注册与按主体清空。
//
// NC3 的「改前红」方向（只删会话不删轮次 ⇒ 用例变红）在本文件与
// `tests/unit/conversation-store-pg.test.mjs` 的 SQL 变异里各给一次原始读数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationFixture, retrievalItem, retrievalSet, CONVERSATIONS, JOBS, ABSENT_ID } from './conversation-fixtures.mjs';
import { createWiredRetrievalPort } from '../../services/api/src/conversations/guard.ts';
import {
  CONVERSATIONS_DELETION_MODULE,
  CASCADE_DISCLOSURE,
  createConversationDeletion,
  createUnwiredTurnCascadePort,
  createWiredTurnCascadePort,
} from '../../services/api/src/conversations/cascade.ts';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import { USER_DATA_DELETION_MODULES, createUserDataDeletion } from '../../services/api/src/privacy/user-data-deletion.ts';

const QUESTION = '稻田杂草怎么防除？';
const ITEM = retrievalItem({
  id: '8de526e2-ada8-514a-bbab-a0da3e784b0d',
  title: '合成条目甲：稻田杂草防除要点（测试替身）',
  body: '稻田杂草防除要点：合成正文，仅用于回归，不含真实用量建议。',
});

async function acceptedTurnWithAnswer(fixture, conversationId, tag) {
  const accepted = await fixture.call('POST', `${CONVERSATIONS}/${conversationId}/turns`, fixture.a, {
    payload: { input_type: 'text', text: QUESTION },
    headers: { 'idempotency-key': `idem-${tag}`, 'if-match': '"1"' },
  });
  assert.equal(accepted.status, 202, `受理应 202：${JSON.stringify(accepted.body)}`);
  await fixture.app.conversationService.drain();
  return accepted;
}

test('deleteTurn：202 受理、回答随轮次消失、会话仍在，并如实披露级联处置', async (t) => {
  const fixture = await conversationFixture(t, {
    injection: { retrieval: createWiredRetrievalPort({ note: '合成集合', read: async (input) => retrievalSet(input.identity.userId, [ITEM]) }) },
  });
  const created = await fixture.createConversation({}, { tag: 'del-turn' });
  const conversationId = created.body.data.id;
  const accepted = await acceptedTurnWithAnswer(fixture, conversationId, 'del-turn');
  const turnId = accepted.body.data.id;
  const before = fixture.conversationStore.snapshot();
  assert.equal(before.turns.length, 1);
  assert.equal(before.answers.length, 1, '前置：回答已结算落库');

  const turn = (await fixture.call('GET', `${CONVERSATIONS}/${conversationId}/turns`)).body.data.items[0];
  const removed = await fixture.call('DELETE', `${CONVERSATIONS}/${conversationId}/turns/${turn.id}`, fixture.a, {
    headers: { 'idempotency-key': 'idem-del-turn-1', 'if-match': `"${turn.revision}"` },
  });
  assert.equal(removed.status, 202);
  assert.deepEqual(removed.body.data, { accepted: true });
  assert.equal(removed.etag, null, 'Ack 无 revision：不得伪造 ETag');
  // 非契约披露头：值只能是闭集里的一项，且默认装配如实是 `unwired`（不谎称"已清除"）。
  assert.ok(CASCADE_DISCLOSURE.includes(removed.cascade), `披露值必须在闭集内：${removed.cascade}`);
  assert.equal(removed.cascade, 'unwired', '默认装配的级联端口未接线 ⇒ 必须如实披露 unwired');
  assert.equal(removed.body.data.accepted, true);
  assert.match(JSON.stringify(removed.body), /accepted/, '响应体只含契约的 Ack，不得夹带级联细节');

  // 级联：轮次与它的回答都没了；会话仍在（删轮次不得连坐会话）。
  const after = fixture.conversationStore.snapshot();
  assert.deepEqual(
    { conversations: after.conversations.length, turns: after.turns.length, answers: after.answers.length },
    { conversations: 1, turns: 0, answers: 0 },
    '删除轮次必须级联到回答，且不得删掉会话',
  );
  const turns = await fixture.call('GET', `${CONVERSATIONS}/${conversationId}/turns`);
  assert.equal(turns.status, 200);
  assert.deepEqual(turns.body.data.items, []);
  assert.equal(turns.body.data.next_cursor, null);
  // 作业读面也随轮次消失（不泄漏已删轮次的作业）。
  const job = await fixture.call('GET', `${JOBS}/${turnId}`);
  assert.equal(job.status, 404);
  assert.equal(job.body.error.code, 'NOT_FOUND');
});

test('deleteTurn：revision 不符 409、他人 404、不存在与他人逐键同形', async (t) => {
  const fixture = await conversationFixture(t);
  const created = await fixture.createConversation({}, { tag: 'del-turn-2' });
  const conversationId = created.body.data.id;
  const accepted = await acceptedTurnWithAnswer(fixture, conversationId, 'del-turn-2');
  const turn = (await fixture.call('GET', `${CONVERSATIONS}/${conversationId}/turns`)).body.data.items[0];

  const stale = await fixture.call('DELETE', `${CONVERSATIONS}/${conversationId}/turns/${turn.id}`, fixture.a, {
    headers: { 'idempotency-key': 'idem-del-turn-2a', 'if-match': '"7"' },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'REVISION_CONFLICT');
  assert.equal(fixture.conversationStore.snapshot().turns.length, 1, '冲突不得产生副作用');

  const foreign = await fixture.call('DELETE', `${CONVERSATIONS}/${conversationId}/turns/${turn.id}`, fixture.b, {
    headers: { 'idempotency-key': 'idem-del-turn-2b', 'if-match': `"${turn.revision}"` },
  });
  assert.equal(foreign.status, 404);
  const absent = await fixture.call('DELETE', `${CONVERSATIONS}/${conversationId}/turns/${ABSENT_ID}`, fixture.a, {
    headers: { 'idempotency-key': 'idem-del-turn-2c', 'if-match': `"${turn.revision}"` },
  });
  assert.equal(absent.status, 404);
  assert.deepEqual(
    { ...foreign.body, meta: { ...foreign.body.meta, request_id: 'x' } },
    { ...absent.body, meta: { ...absent.body.meta, request_id: 'x' } },
    '他人与不存在必须逐键同形（不泄露轮次存在性）',
  );
  assert.equal(accepted.status, 202);
  assert.equal(fixture.conversationStore.snapshot().turns.length, 1, '两次失败都不得删掉轮次');

  // 幂等重放：第一次成功后同键再来一次 ⇒ 仍是 202 `{accepted:true}`（不报 409）。
  const ok = await fixture.call('DELETE', `${CONVERSATIONS}/${conversationId}/turns/${turn.id}`, fixture.a, {
    headers: { 'idempotency-key': 'idem-del-turn-2d', 'if-match': `"${turn.revision}"` },
  });
  assert.equal(ok.status, 202);
  const replay = await fixture.call('DELETE', `${CONVERSATIONS}/${conversationId}/turns/${turn.id}`, fixture.a, {
    headers: { 'idempotency-key': 'idem-del-turn-2d', 'if-match': `"${turn.revision}"` },
  });
  assert.equal(replay.status, 202, '删除重放必须如实回同一结论，不得用 404/409 谎称失败');
  assert.deepEqual(replay.body.data, { accepted: true });
});

test('级联端口三态：已接线清理器 ⇒ initiated / 有 unsupported ⇒ unwired / 抛错 ⇒ failed（都不改写成删除失败）', async (t) => {
  const cases = [
    ['initiated', createWiredTurnCascadePort({ cleaners: [async () => ({ state: 'cleaned' })] })],
    ['unwired', createWiredTurnCascadePort({ cleaners: [async () => ({ state: 'cleaned' }), async () => ({ state: 'unsupported', note: '音频归语音域' })] })],
    ['failed', createWiredTurnCascadePort({ cleaners: [async () => { throw new Error('合成清理器故障'); }] })],
    ['unwired', createUnwiredTurnCascadePort()],
  ];
  for (const [expected, cascade] of cases) {
    const fixture = await conversationFixture(t, { injection: { cascade } });
    const created = await fixture.createConversation({}, { tag: `casc-${expected}` });
    const accepted = await acceptedTurnWithAnswer(fixture, created.body.data.id, `casc-${expected}`);
    const turn = (await fixture.call('GET', `${CONVERSATIONS}/${created.body.data.id}/turns`)).body.data.items[0];
    const removed = await fixture.call('DELETE', `${CONVERSATIONS}/${created.body.data.id}/turns/${turn.id}`, fixture.a, {
      headers: { 'idempotency-key': `idem-casc-${expected}`, 'if-match': `"${turn.revision}"` },
    });
    assert.equal(removed.status, 202, `${expected}：级联处置结果不得改变 202 受理事实`);
    assert.equal(removed.cascade, expected, `披露值应为 ${expected}`);
    assert.equal(fixture.conversationStore.snapshot().turns.length, 0, `${expected}：主体删除已经生效，不得回滚`);
    assert.equal(accepted.status, 202);
  }
});

test('F13 注销清理：模块在启动时已注册、按主体真删、回执如实（备份未清 ⇒ 不谎称完成）', async () => {
  const store = createMemoryConversationStore();
  const ownerA = '00000000-0000-4000-8a00-000000000001';
  const ownerB = '00000000-0000-4000-8b00-000000000002';
  for (const [owner, count] of [[ownerA, 2], [ownerB, 1]]) {
    for (let index = 0; index < count; index += 1) {
      const conversationId = `${owner.slice(0, -4)}${String(1000 + index)}`;
      await store.insertConversation({
        id: conversationId,
        owner_id: owner,
        conditions: null,
        created_at: new Date(Date.UTC(2026, 9, 14, 6, index)),
      });
      await store.insertTurn({
        id: `${owner.slice(0, -4)}${String(2000 + index)}`,
        conversation_id: conversationId,
        owner_id: owner,
        input_text: QUESTION,
        transcription_ref: null,
        job_id: `${owner.slice(0, -4)}${String(3000 + index)}`,
        job_state: 'succeeded',
        job_deadline_at: new Date(Date.UTC(2026, 9, 14, 7)),
        job_created_at: new Date(Date.UTC(2026, 9, 14, 6, index)),
        job_error_code: null,
        created_at: new Date(Date.UTC(2026, 9, 14, 6, index)),
      });
    }
  }
  const deletion = createConversationDeletion(store, { now: () => new Date(Date.UTC(2026, 9, 14, 8)) });
  assert.equal(deletion.module, CONVERSATIONS_DELETION_MODULE);
  assert.equal(deletion.module, 'conversations');

  const request = deletion.requestDeletionFor(ownerA);
  const requestId = String(request['id']);
  const executed = await deletion.executeHandlers(requestId);
  assert.ok(executed !== null && executed !== undefined);
  const status = deletion.completionStatus(requestId);
  // 诚实标注：备份副本清除未接线 ⇒ 整个删除请求**不得**判完成（与 #16 同口径）。
  assert.equal(status.completed, false, '备份副本未清除时整体不得判完成（不谎称）');
  assert.notEqual(status.state, 'completed');
  assert.deepEqual(status.missingModules, [], '本模块已报告：缺口在备份，不在"缺报告"');
  const receipt = deletion.receipt(requestId);
  assert.ok(receipt !== null);
  const row = receipt.handlers.find((handler) => handler.module === 'conversations');
  assert.deepEqual(
    { online: row.online_state, backup: row.backup_state, error: row.error_code },
    { online: 'completed', backup: 'pending', error: null },
    '在线行确已删除 ⇒ completed；备份未清除 ⇒ 如实 pending',
  );

  const after = store.snapshot();
  assert.equal(after.conversations.length, 1, '只清该主体');
  assert.equal(after.conversations[0].owner_id, ownerB);
  assert.equal(after.turns.length, 1, '轮次必须随会话一并清除');
  assert.deepEqual(after.answers, []);

  const audit = deletion.audit();
  assert.deepEqual(audit, [{
    requestId,
    userId: ownerA,
    onlineRemoved: 2,
    backupState: 'pending',
    at: '2026-10-14T08:00:00.000Z',
  }], '审计只含模块名/行数/状态，不含任何正文');
});

test('F13：会话域**已并入**统一注销闭集（扩大而非替换），单域装配口仍可独立驱动', async () => {
  // C1b-3（§7 P0-3 路径①）：闭集从 [favorites, history] 扩到含 messages 与 conversations。
  // 这是**加强**（注销承诺清理的域变多），既有条目一条不少；旧断言「闭集不含 conversations」
  // 的反向锁随路径①作废 —— 但它被替换成更强的正向断言，不是删掉了事。
  assert.deepEqual([...USER_DATA_DELETION_MODULES], ['favorites', 'history', 'messages', 'conversations']);
  for (const legacy of ['favorites', 'history']) {
    assert.ok(USER_DATA_DELETION_MODULES.includes(legacy), `闭集不得丢掉既有模块 ${legacy}`);
  }
  assert.equal(USER_DATA_DELETION_MODULES.includes(CONVERSATIONS_DELETION_MODULE), true, '会话域必须进闭集');
  // 两个模块名常量必须同值：本域（cascade.ts）与统一闭集（user-data-deletion.ts）各声明一次。
  assert.equal(CONVERSATIONS_DELETION_MODULE, 'conversations');

  // 单域装配口（`createConversationDeletion`）仍可独立驱动：只认自己的模块名，
  // 闭集外注册会被协议拒绝；0 行也如实记 0。
  const store = createMemoryConversationStore();
  const deletion = createConversationDeletion(store, { now: () => new Date(Date.UTC(2026, 9, 14, 8)) });
  assert.equal(deletion.module, CONVERSATIONS_DELETION_MODULE);
  const unknown = deletion.requestDeletionFor('00000000-0000-4000-8a00-000000000001');
  const unknownId = String(unknown['id']);
  await deletion.executeHandlers(unknownId);
  const undone = deletion.completionStatus(unknownId);
  assert.equal(undone.completed, false, '备份未清除 ⇒ 即便主体没有会话也不得判完成');
  assert.deepEqual(
    deletion.audit().map((entry) => ({ userId: entry.userId, onlineRemoved: entry.onlineRemoved, backupState: entry.backupState })),
    [{ userId: '00000000-0000-4000-8a00-000000000001', onlineRemoved: 0, backupState: 'pending' }],
    '"清空 0 行"也要如实记成 0（不把没有数据说成删过）',
  );
  assert.equal(store.snapshot().conversations.length, 0);
});

test('F13：统一账本（路径①）一次请求同时清四域 —— 会话域不再"有刀没有手"', async () => {
  const ownerA = '00000000-0000-4000-8a00-000000000001';
  const ownerB = '00000000-0000-4000-8b00-000000000002';
  const conversationStore = createMemoryConversationStore();
  for (const [owner, count] of [[ownerA, 2], [ownerB, 1]]) {
    for (let index = 0; index < count; index += 1) {
      const conversationId = `${owner.slice(0, -4)}${String(1000 + index)}`;
      await conversationStore.insertConversation({
        id: conversationId,
        owner_id: owner,
        conditions: null,
        created_at: new Date(Date.UTC(2026, 9, 14, 6, index)),
      });
      await conversationStore.insertTurn({
        id: `${owner.slice(0, -4)}${String(2000 + index)}`,
        conversation_id: conversationId,
        owner_id: owner,
        input_text: QUESTION,
        transcription_ref: null,
        job_id: `${owner.slice(0, -4)}${String(3000 + index)}`,
        job_state: 'succeeded',
        job_deadline_at: new Date(Date.UTC(2026, 9, 14, 7)),
        job_created_at: new Date(Date.UTC(2026, 9, 14, 6, index)),
        job_error_code: null,
        created_at: new Date(Date.UTC(2026, 9, 14, 6, index)),
      });
    }
  }
  const clock = { now: () => new Date(Date.UTC(2026, 9, 14, 8)) };
  const favoritesStore = createMemoryFavoritesStore({ now: () => clock.now().getTime() });
  const historyStore = createMemoryHistoryStore({ now: () => clock.now().getTime() });
  const messagesStore = createMemoryMessagesStore({ now: () => clock.now().getTime() });
  await favoritesStore.insertFavorite({
    id: '00000000-0000-4000-8a00-000000000901',
    revision: 1,
    owner_id: ownerA,
    target_ref: { type: 'species', id: 'spc-unified', revision: 1 },
    created_at: clock.now().toISOString(),
  });
  await messagesStore.insertMessage({
    id: '00000000-0000-4000-8a00-000000000902',
    revision: 1,
    owner_id: ownerA,
    type: 'system',
    target_ref: null,
    read_at: null,
    created_at: clock.now().toISOString(),
    event_key: 'evt-unified',
  });

  const deletion = createUserDataDeletion({
    favoritesStore,
    historyStore,
    messagesStore,
    conversationsStore: conversationStore,
    now: clock.now,
  });
  assert.deepEqual(deletion.requiredModules(), ['favorites', 'history', 'messages', 'conversations']);

  const requestId = String(deletion.requestDeletionFor(ownerA).id);
  await deletion.executeHandlers(requestId);

  // 一次请求、四个模块行：全部如实出现在同一份回执里（不再有第二本账）。
  const receipt = deletion.receipt(requestId);
  assert.deepEqual(
    receipt.handlers.map((row) => row.module),
    ['favorites', 'history', 'messages', 'conversations'],
  );
  const conversationsRow = receipt.handlers.find((row) => row.module === 'conversations');
  assert.equal(conversationsRow.online_state, 'completed', '会话行确实被删 ⇒ completed');
  assert.equal(conversationsRow.backup_state, 'pending', '会话域备份清单属 G6/G8（P1）⇒ 如实 pending');
  assert.equal(conversationsRow.error_code, null);

  // 真删了：A 的会话与轮次归零，B 原样。
  const after = conversationStore.snapshot();
  assert.equal(after.conversations.length, 1, '只清该主体');
  assert.equal(after.conversations[0].owner_id, ownerB);
  assert.equal(after.turns.length, 1, '轮次随会话级联消失');
  // 证据串里能看见会话域的清空行数。
  assert.equal(deletion.evidenceOf(requestId).conversations, 'conversations:online-purged:2');
});
