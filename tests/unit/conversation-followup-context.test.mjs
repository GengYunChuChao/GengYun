// GY-I12（#12）：**会话上下文／追问语义**回归（范围条目①「保存引用…及会话上下文」）。
//
// 本文件锁住四件事（每一件都是"可被静默做错"的方向）：
//   1) **有上文才标注**：本会话的第一轮提问，正文不得出现任何"追问/上文"措辞（不改既有口径）；
//   2) **上下文只来自本会话 + 本主体**：同一主体的另一个会话、另一个主体的会话都不算上文；
//      别人的会话读不到（与不存在同形），端口直读恒空且不抛；
//   3) **上下文不扩引用**：追问轮的检索提问逐字等于本问（不拼接历史），引用集合也不因上文变大；
//   4) **有界且不缓存**：最多 `CONTEXT_MAX_TURNS` 轮（第 7 轮只看最近 5 轮）；删掉前轮后上下文
//      立刻收缩（不缓存旧历史）；上下文读失败 ⇒ 轮次显式 `failed`（**不**降级成"没有上文"）。
//
// 全部在 stub 模式 + 合成替身下断言：没有真实模型、没有真实资料库、不发任何真实外发调用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationFixture, CONVERSATIONS, JOBS, retrievalItem, retrievalSet } from './conversation-fixtures.mjs';
import { createWiredRetrievalPort } from '../../services/api/src/conversations/guard.ts';
import {
  CONTEXT_MAX_TURNS,
  createStoreConversationContext,
  createUnwiredConversationContext,
} from '../../services/api/src/conversations/context.ts';

const QUESTION_CROP = '稻田稗草怎么识别？';
const QUESTION_BUG = '千金子怎么防除？';

const ITEM_CROP = retrievalItem({
  id: '2c0d4a30-6d9b-4f5b-9d70-5c1b2b0a7f11',
  title: '合成资料甲：稗草的识别（测试替身）',
  body: '稗草的识别要点：合成正文，仅用于回归，不含真实用量建议。',
});
const ITEM_BUG = retrievalItem({
  id: '7b3f0c11-8a1d-4e6f-9c22-6d4e8f0a1b33',
  title: '合成资料乙：千金子的防除（测试替身）',
  body: '千金子的防除要点：合成正文，仅用于回归，不含真实用量建议。',
});

/** 检索替身：集合固定为两条，记录每次读取的入参（用来证明"历史没有进检索"）。 */
function retrievalInjection(seen = []) {
  return {
    retrieval: createWiredRetrievalPort({
      note: '测试替身检索端口：集合由用例显式给出，不查资料库',
      read: async (input) => {
        seen.push(input);
        return retrievalSet(input.identity.userId, [ITEM_CROP, ITEM_BUG]);
      },
    }),
  };
}

/** 会话当前 revision（`createTurn` 的 If-Match 用会话 revision，不自己推算）。 */
async function conversationRevision(fixture, conversationId) {
  const read = await fixture.call('GET', `${CONVERSATIONS}/${conversationId}`);
  assert.equal(read.status, 200, `读取会话应 200：${JSON.stringify(read.body)}`);
  return read.body.data.revision;
}

/** 列出一个会话的全部轮次（按 id 取用，不依赖列表顺序）。 */
async function turnsOf(fixture, conversationId, actor) {
  const response = await fixture.call('GET', `${CONVERSATIONS}/${conversationId}/turns`, actor);
  assert.equal(response.status, 200, `读轮次应 200：${JSON.stringify(response.body)}`);
  return response.body.data.items;
}

/**
 * 受理一轮并等它结算，返回该轮的轮次视图。
 *
 * 时钟**显式前进**：上下文按 `created_at` 定序，脚本时钟停在同一刻会让"先后"退化成随机 id 序，
 * 那样测出来的东西与生产不是一回事。取轮次一律按 `job_id` 反查，不用列表下标。
 */
async function askOne(fixture, conversationId, text, tag, actor) {
  fixture.clock.advance(1000);
  const accepted = await fixture.createTurn(conversationId, await conversationRevision(fixture, conversationId), {
    input_type: 'text',
    text,
  }, { tag, ...(actor === undefined ? {} : { actor }) });
  assert.equal(accepted.status, 202, `受理应 202：${JSON.stringify(accepted.body)}`);
  const jobId = accepted.body.data.id;
  const items = await turnsOf(fixture, conversationId, actor);
  const turn = items.find((item) => item.job_id === jobId);
  assert.notEqual(turn, undefined, `轮次列表里必须能找到 job_id=${jobId} 的轮次`);
  return { accepted, jobId, turn, items };
}

test('第一轮提问：正文不带任何"追问/上文"标注（不改变既有回答口径）', async (t) => {
  const seen = [];
  const fixture = await conversationFixture(t, { injection: retrievalInjection(seen) });
  const created = await fixture.createConversation({}, { tag: 'ctx-first' });
  const conversationId = created.body.data.id;

  const { turn } = await askOne(fixture, conversationId, QUESTION_CROP, 'ctx-first-t1');
  assert.equal(turn.answer.status, 'answered');
  assert.doesNotMatch(turn.answer.checked_text, /本会话追问/u, '首轮没有上文，不得出现追问标注');
  assert.doesNotMatch(turn.answer.checked_text, /最近 \d+ 轮提问/u, '首轮不得声称有任何上文');
  assert.deepEqual(turn.answer.citations.map((citation) => citation.id), [ITEM_CROP.id]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].question, QUESTION_CROP, '检索只拿本问');
});

test('第二轮追问：正文显式标注「本会话追问」，且引用与检索仍只按本问（上下文不扩引用集合）', async (t) => {
  const seen = [];
  const fixture = await conversationFixture(t, { injection: retrievalInjection(seen) });
  const created = await fixture.createConversation({}, { tag: 'ctx-second' });
  const conversationId = created.body.data.id;

  await askOne(fixture, conversationId, QUESTION_CROP, 'ctx-second-t1');
  const { turn } = await askOne(fixture, conversationId, QUESTION_BUG, 'ctx-second-t2');

  assert.equal(turn.answer.status, 'answered');
  assert.match(turn.answer.checked_text, /本会话追问/u, '追问轮必须在正文里说清这是本会话内的追问');
  assert.match(turn.answer.checked_text, new RegExp(`最近 1 轮提问（上限 ${CONTEXT_MAX_TURNS} 轮）`, 'u'));

  // 上下文**不**扩引用：集合里有两条，但只有与本问有字面重合的那条被引用。
  assert.deepEqual(
    turn.answer.citations.map((citation) => citation.id),
    [ITEM_BUG.id],
    '追问轮的引用必须只按本问决定（不得因上文把上一轮的条目也带进来）',
  );
  assert.equal(seen.length, 2);
  assert.equal(seen[1].question, QUESTION_BUG, '检索入参必须逐字等于本问，不得把历史拼接进去');
});

test('跨会话不串：同一主体的另一个会话不算上文', async (t) => {
  const fixture = await conversationFixture(t, { injection: retrievalInjection() });
  const first = await fixture.createConversation({}, { tag: 'ctx-cross-a' });
  const second = await fixture.createConversation({}, { tag: 'ctx-cross-b' });
  const firstId = first.body.data.id;
  const secondId = second.body.data.id;
  assert.notEqual(firstId, secondId);

  await askOne(fixture, firstId, QUESTION_CROP, 'ctx-cross-t1');
  // 另一个会话的**首轮**：即便同一主体已经在别处问过，这里也不该出现追问标注。
  const fresh = await askOne(fixture, secondId, QUESTION_BUG, 'ctx-cross-t2');
  assert.doesNotMatch(fresh.turn.answer.checked_text, /本会话追问/u, '别的会话的轮次不得被当作本会话上文');

  // 同一会话内的第二轮：上文只该有 1 轮（不是 2 轮）—— 跨会话说不出这个数。
  const followUp = await askOne(fixture, secondId, QUESTION_CROP, 'ctx-cross-t3');
  assert.match(followUp.turn.answer.checked_text, /最近 1 轮提问/u, '上文轮数只统计本会话');
});

test('上下文只读本会话本主体：他人读不到（同形 404），端口直读恒空且不抛', async (t) => {
  const fixture = await conversationFixture(t, { injection: retrievalInjection() });
  const created = await fixture.createConversation({}, { tag: 'ctx-owner' });
  const conversationId = created.body.data.id;
  await askOne(fixture, conversationId, QUESTION_CROP, 'ctx-owner-t1');
  const service = fixture.app.conversationService;
  assert.notEqual(service, null);

  const mine = await service.context.read({
    conversationId,
    ownerId: fixture.a.user.id,
    excludeTurnId: null,
  });
  assert.equal(mine.conversation_id, conversationId);
  assert.equal(mine.turns.length, 1, '自身份能看到本会话的 1 轮上文');
  assert.equal(mine.turns[0].question, QUESTION_CROP);
  assert.equal(mine.turns[0].answer_status, 'answered');

  const foreign = await service.context.read({
    conversationId,
    ownerId: fixture.b.user.id,
    excludeTurnId: null,
  });
  assert.deepEqual(foreign.turns, [], '别人的会话读不到上下文（恒空，不抛错，不泄露存在性）');

  const absent = await service.context.read({
    conversationId: '00000000-0000-4000-8f00-0000000000ff',
    ownerId: fixture.a.user.id,
    excludeTurnId: null,
  });
  assert.deepEqual(absent.turns, [], '不存在的会话与别人的会话同形（都是空）');

  // HTTP 面：他人读轮次/追加轮次都是同形 404（存在性不泄露）。
  const foreignRead = await fixture.call('GET', `${CONVERSATIONS}/${conversationId}/turns`, fixture.b);
  assert.equal(foreignRead.status, 404);
  const foreignAsk = await fixture.call('POST', `${CONVERSATIONS}/${conversationId}/turns`, fixture.b, {
    payload: { input_type: 'text', text: QUESTION_BUG },
    headers: { 'idempotency-key': 'idem-ctx-owner-foreign', 'if-match': '"1"' },
  });
  assert.equal(foreignAsk.status, 404);
  assert.equal(foreignAsk.body.error.code, 'NOT_FOUND');
});

test('上限 5 轮：会话再长也只有最近 5 轮进上文（不随长度无界增长）', async (t) => {
  assert.equal(CONTEXT_MAX_TURNS, 5, '上限是语义的一部分：改这个数必须改本条断言');
  const fixture = await conversationFixture(t, { injection: retrievalInjection() });
  const created = await fixture.createConversation({}, { tag: 'ctx-cap' });
  const conversationId = created.body.data.id;

  const markers = [];
  for (let index = 1; index <= 7; index += 1) {
    const question = index % 2 === 0 ? QUESTION_BUG : QUESTION_CROP;
    const { turn } = await askOne(fixture, conversationId, question, `ctx-cap-t${index}`);
    assert.equal(turn.answer.status, 'answered', `第 ${index} 轮应 answered`);
    const matched = /最近 (\d+) 轮提问/u.exec(turn.answer.checked_text);
    markers.push(matched === null ? 0 : Number(matched[1]));
  }
  assert.deepEqual(markers, [0, 1, 2, 3, 4, 5, 5], '第 1 轮无上文，其后每轮 +1，到上限后不再增长');
});

test('删除前轮 ⇒ 上下文立刻收缩（不缓存旧历史）', async (t) => {
  const fixture = await conversationFixture(t, { injection: retrievalInjection() });
  const created = await fixture.createConversation({}, { tag: 'ctx-del' });
  const conversationId = created.body.data.id;

  await askOne(fixture, conversationId, QUESTION_CROP, 'ctx-del-t1');
  const second = await askOne(fixture, conversationId, QUESTION_BUG, 'ctx-del-t2');
  assert.match(second.turn.answer.checked_text, /最近 1 轮提问/u);

  // 删掉最近那一轮（If-Match 用**轮次** revision，不是会话 revision）。
  const removed = await fixture.call(
    'DELETE',
    `${CONVERSATIONS}/${conversationId}/turns/${second.turn.id}`,
    fixture.a,
    { headers: { 'idempotency-key': 'idem-ctx-del-1', 'if-match': `"${second.turn.revision}"` } },
  );
  assert.equal(removed.status, 202, `删除应 202：${JSON.stringify(removed.body)}`);

  const service = fixture.app.conversationService;
  const afterDelete = await service.context.read({
    conversationId,
    ownerId: fixture.a.user.id,
    excludeTurnId: null,
  });
  assert.equal(afterDelete.turns.length, 1, '已删轮次不得继续出现在上文里');
  assert.equal(afterDelete.turns[0].question, QUESTION_CROP);

  // 再问一轮：上文轮数按**删除后**的实际历史算（1 轮，不是 2 轮）。
  const third = await askOne(fixture, conversationId, QUESTION_CROP, 'ctx-del-t3');
  assert.match(third.turn.answer.checked_text, /最近 1 轮提问/u, '上下文不得缓存已删轮次');
});

test('上下文读失败 ⇒ 轮次显式 failed（不降级成"没有上文"），换键重试可成功且不产生重复轮次', async (t) => {
  let reads = 0;
  const fixture = await conversationFixture(t, {
    injection: {
      ...retrievalInjection(),
      context: {
        kind: 'store',
        note: '负控制：第一次读上下文直接失败，之后恢复正常',
        read: async ({ conversationId: conversationIdInput }) => {
          reads += 1;
          if (reads === 1) throw new Error('模拟上下文读失败（负控制）');
          return { conversation_id: conversationIdInput, turns: [] };
        },
      },
    },
  });
  const created = await fixture.createConversation({}, { tag: 'ctx-boom' });
  const conversationId = created.body.data.id;

  const first = await askOne(fixture, conversationId, QUESTION_CROP, 'ctx-boom-t1');
  const job = await fixture.call('GET', `${JOBS}/${first.jobId}`);
  assert.equal(job.status, 200);
  assert.equal(job.body.data.state, 'failed', '上下文读失败必须落显式 failed，不得静默当成"首轮提问"照常回答');
  assert.equal(job.body.data.error_code, 'PROVIDER_UNAVAILABLE');
  assert.equal(job.body.data.result, null, '失败的作业不得携带任何回答（不得返回半截文本）');
  assert.equal(first.turn.answer, null, '失败的轮次在读面上没有回答');

  // 重试：新幂等键 ⇒ 新轮次；此时上下文端口已恢复。
  const retried = await askOne(fixture, conversationId, QUESTION_CROP, 'ctx-boom-t2');
  assert.equal(retried.jobId === first.jobId, false, '重试必须是一次新的作业');
  const retriedJob = await fixture.call('GET', `${JOBS}/${retried.jobId}`);
  assert.equal(retriedJob.body.data.state, 'succeeded', '端口恢复后重试应能成功（失败是可重试的）');
  assert.equal(retried.turn.answer.status, 'answered');

  const items = await turnsOf(fixture, conversationId);
  assert.equal(items.length, 2, '失败轮次 + 重试轮次：各一条，不得凭空多出第三条');
  const failedStill = items.find((item) => item.job_id === first.jobId);
  assert.equal(failedStill.answer, null, '失败的轮次不得被后来的重试"补写"成有回答');
});

test('未接线上下文端口：恒空、不抛、不编造历史（装配缺省不是它，但语义要钉住）', async () => {
  const port = createUnwiredConversationContext();
  assert.equal(port.kind, 'unwired');
  const read = await port.read({ conversationId: 'any', ownerId: 'any', excludeTurnId: null });
  assert.deepEqual(read.turns, []);
  assert.equal(read.conversation_id, 'any');
  assert.match(port.note, /未接线/u);
});

test('store 版上下文端口：同会话同主体、时间正序、排除本轮（直接对 store 读，不经 HTTP）', async (t) => {
  const fixture = await conversationFixture(t, { injection: retrievalInjection() });
  const created = await fixture.createConversation({}, { tag: 'ctx-port' });
  const conversationId = created.body.data.id;
  const first = await askOne(fixture, conversationId, QUESTION_CROP, 'ctx-port-t1');
  const second = await askOne(fixture, conversationId, QUESTION_BUG, 'ctx-port-t2');

  const port = createStoreConversationContext(fixture.conversationStore);
  const ordered = await port.read({
    conversationId,
    ownerId: fixture.a.user.id,
    excludeTurnId: null,
  });
  assert.deepEqual(
    ordered.turns.map((turn) => turn.question),
    [QUESTION_CROP, QUESTION_BUG],
    '上下文按时间正序（最早的在前，与 store 的降序读法无关）',
  );
  assert.equal(ordered.turns[0].turn_id, first.turn.id);
  assert.equal(ordered.turns[1].turn_id, second.turn.id);

  const withoutCurrent = await port.read({
    conversationId,
    ownerId: fixture.a.user.id,
    excludeTurnId: second.turn.id,
  });
  assert.deepEqual(withoutCurrent.turns.map((turn) => turn.question), [QUESTION_CROP], '本轮必须被排除');

  // 上限收窄：`maxTurns` 只是端口参数，不改变存储。
  const narrowed = await createStoreConversationContext(fixture.conversationStore, { maxTurns: 1 }).read({
    conversationId,
    ownerId: fixture.a.user.id,
    excludeTurnId: null,
  });
  assert.deepEqual(narrowed.turns.map((turn) => turn.turn_id), [second.turn.id], '只保留最近 1 轮');
});
