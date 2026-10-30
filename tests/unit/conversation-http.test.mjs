// GY-I12（#12）：文字问答服务端 HTTP 面回归（真实回环 HTTP + 契约机械判据）。
//
// 覆盖：契约里**全部七个**问答 operation 的成功形状与错误码、幂等重放、If-Match/强 ETag、
// 归属不可越权、分页游标、`answer` 作业跨 kind 读面、未接线如实失败（两态对照）。
//
// 本文件里的资料条目与来源**全部是合成替身**（`example.invalid`、`测试替身`），
// 不读真实资料库、不接真实模型、不发任何真实外发调用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationFixture, CONVERSATIONS, JOBS, ABSENT_ID, retrievalItem, retrievalSet, assertShape, assertEnvelopeShape, assertErrorShape, conversationOperations, operationNode, loadSchema, shapeIssues } from './conversation-fixtures.mjs';
import { API_PREFIX } from '../../services/api/src/contract.ts';
import { createWiredRetrievalPort, createUnwiredRetrievalPort, createUnwiredDoseAuthority } from '../../services/api/src/conversations/guard.ts';
import { createUnwiredTranscriptionPort, RELEVANCE_RULE } from '../../services/api/src/conversations/service.ts';
import { UNIMPLEMENTED_VERSION_PREFIX } from '../../services/api/src/conversations/types.ts';

// ---------------------------------------------------------------------------
// 判据与替身
// ---------------------------------------------------------------------------

/** 路由表（fastify `printRoutes({commonPrefix:false})` 是每行一条、带完整路径）。 */
function servedRoutes(app) {
  const lines = app.printRoutes({ commonPrefix: false }).split('\n');
  const stack = [];
  const routes = [];
  for (const line of lines) {
    const matched = /^([\s│├└─]*?)(?:├── |└── )(.*)$/.exec(line);
    if (matched === null) continue;
    const depth = Math.floor(matched[1].length / 4);
    const row = matched[2].trim();
    const paren = row.lastIndexOf(' (');
    const segment = paren === -1 ? row : row.slice(0, paren);
    const methods = paren === -1 ? '' : row.slice(paren + 2, -1);
    stack.length = depth;
    const parent = depth === 0 ? '' : stack[depth - 1];
    const full = parent + (segment.startsWith('/') ? segment : `/${segment}`);
    stack[depth] = full;
    if (methods === '') continue;
    routes.push({
      path: full,
      methods: methods.split(', ').map((value) => value.trim().toLowerCase()).filter((value) => value !== 'head'),
    });
  }
  return routes;
}

/** 契约 operation 的 path 用 `{id}`，fastify 用 `:id`。 */
function normalizePath(path) {
  return path.replace(/\{([a-z_]+)\}/g, ':$1');
}

const QUESTION = '稻田杂草怎么防除？';
const ITEM_A = retrievalItem({
  id: '8de526e2-ada8-514a-bbab-a0da3e784b0d',
  title: '合成条目甲：稻田杂草防除要点（测试替身）',
  body: '稻田杂草防除要点：合成正文，仅用于回归，不含真实用量建议。',
});
const ITEM_B = retrievalItem({
  id: '1f0e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
  title: '合成条目乙：旱地杂草（测试替身）',
  body: '旱地杂草说明：合成正文，与本次提问无字面重合。',
  source: { id: '1f0e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f' },
});

function retrievalInjection(items, seen = []) {
  return {
    retrieval: createWiredRetrievalPort({
      note: '测试替身检索端口：集合由用例显式给出，不查资料库',
      read: async (input) => {
        seen.push(input);
        return retrievalSet(input.identity.userId, items);
      },
    }),
  };
}

function withoutRequestId(body) {
  return { ...body, meta: { ...body.meta, request_id: '(忽略)' } };
}

/** 「未接真实模型」的机器判据（诚实标注红线的执行点）。 */
function versionProblems(answer) {
  const problems = [];
  for (const key of ['model_version', 'prompt_version', 'rule_version']) {
    const value = answer[key];
    if (typeof value !== 'string' || !value.startsWith(UNIMPLEMENTED_VERSION_PREFIX)) {
      problems.push(`${key} 未显式标注"未接真实模型"（缺前缀 ${UNIMPLEMENTED_VERSION_PREFIX}）：${JSON.stringify(value)}`);
    }
    if (typeof value === 'string' && value.length > 80) problems.push(`${key} 超出契约 maxLength 80`);
  }
  return problems;
}

async function acceptedTurn(fixture, conversationId, revision, payload = { input_type: 'text', text: QUESTION }, extra = {}) {
  const response = await fixture.createTurn(conversationId, revision, payload, extra);
  assert.equal(response.status, 202, `受理轮次应 202：${JSON.stringify(response.body)}`);
  return response;
}

// ---------------------------------------------------------------------------

test('契约一致性：实现的路由集合覆盖 operations.json 里全部七个问答 operation，且不多出契约外路径', async (t) => {
  const fixture = await conversationFixture(t);
  const routes = servedRoutes(fixture.app);
  const operations = conversationOperations();
  assert.equal(operations.length, 7, '契约里问答 operation 恰好七条');

  const missing = [];
  for (const operation of operations) {
    const path = `${API_PREFIX}${normalizePath(operation.path)}`;
    const hit = routes.find((route) => route.path === path && route.methods.includes(operation.method));
    if (hit === undefined) missing.push(`${operation.id}: ${operation.method.toUpperCase()} ${operation.path}`);
  }
  assert.deepEqual(missing, [], `未装配的契约 operation：\n${missing.join('\n')}`);

  const extra = routes.filter((route) => route.path.startsWith(`${API_PREFIX}/conversations`)).filter((route) => {
    const suffix = route.path.slice(API_PREFIX.length);
    return !operations.some((operation) => normalizePath(operation.path) === suffix && route.methods.includes(operation.method));
  });
  assert.deepEqual(extra, [], '不得注册契约之外的问答路径/方法');

  // openapi 里七条 operation 与 operations.json 必须指向同一个路径集合（两文件不漂移）。
  for (const operation of operations) {
    assert.ok(operationNode(operation) !== undefined);
    assert.equal(operationNode(operation)['x-scope'], 'user', `${operation.id} 的 x-scope`);
  }
});

test('七个 operation 的成功响应逐键满足契约 schema 与响应头口径', async (t) => {
  const fixture = await conversationFixture(t, { injection: retrievalInjection([ITEM_A, ITEM_B]) });
  const created = await fixture.createConversation({ conditions: { crop_id: 'rice', region_code: '330100' } }, { tag: 'shape' });
  assertEnvelopeShape('ConversationEnvelope', created.body, 'createConversation 201');
  assertShape('Conversation', created.body.data, 'Conversation');
  assert.deepEqual(Object.keys(created.body.data).sort(), ['conditions', 'created_at', 'id', 'revision']);
  assert.equal(created.status, 201);
  assert.equal(created.etag, '"1"', '单资源必须回强 ETag');
  assert.equal(created.cache, 'no-store');
  const conversationId = created.body.data.id;

  const got = await fixture.call('GET', `${CONVERSATIONS}/${conversationId}`);
  assert.equal(got.status, 200);
  assertEnvelopeShape('ConversationEnvelope', got.body, 'getConversation 200');
  assert.equal(got.etag, '"1"');

  const listed = await fixture.call('GET', `${CONVERSATIONS}`);
  assert.equal(listed.status, 200);
  assertEnvelopeShape('ConversationPageEnvelope', listed.body, 'listConversations 200');
  assertShape('ConversationPage', listed.body.data, 'ConversationPage');
  assert.equal(listed.etag, null, '契约写明"列表无此头"：列表不得回 ETag');
  assert.equal(listed.cache, 'no-store');

  const turn = await acceptedTurn(fixture, conversationId, 1, undefined, { tag: 'shape' });
  assertEnvelopeShape('JobEnvelope', turn.body, 'createTurn 202');
  assertShape('Job', turn.body.data, 'Job');
  assert.equal(turn.body.data.kind, 'answer');
  assert.deepEqual(Object.keys(turn.body.data).sort(), ['created_at', 'deadline_at', 'error_code', 'id', 'kind', 'result', 'revision', 'state', 'target_ref']);
  assert.equal(turn.etag, '"1"');
  assert.equal(turn.cache, 'no-store');

  const turns = await fixture.call('GET', `${CONVERSATIONS}/${conversationId}/turns`);
  assert.equal(turns.status, 200);
  assertEnvelopeShape('TurnPageEnvelope', turns.body, 'listTurns 200');
  assertShape('TurnPage', turns.body.data, 'TurnPage');
  assert.equal(turns.etag, null);
  const item = turns.body.data.items[0];
  assertShape('Turn', item, 'Turn');
  assert.deepEqual(Object.keys(item).sort(), ['answer', 'created_at', 'id', 'input_text', 'job_id', 'revision', 'transcription_ref']);
  assertShape('Answer', item.answer, 'Answer');
  assert.deepEqual(Object.keys(item.answer).sort(), [
    'check_state', 'checked_text', 'citations', 'dose_cards', 'id', 'model_version', 'prompt_version', 'revision', 'rule_version', 'status',
  ]);
  // 契约上 `Turn.job_id` 必须能被作业读面读到（跨 kind 读面）。
  const job = await fixture.call('GET', `${JOBS}/${item.job_id}`);
  assert.equal(job.status, 200);
  assertEnvelopeShape('JobEnvelope', job.body, 'GET /jobs/{id} 200');
  assertShape('Job', job.body.data, 'Job');
  assert.deepEqual(Object.keys(job.body.data.target_ref).sort(), ['id', 'revision', 'type']);
  assert.equal(job.body.data.kind, 'answer');
  assert.equal(job.body.data.target_ref.type, 'answer');
  assert.equal(job.body.data.result.kind, 'answer', 'JobResult 判别子必须等于 Job.kind');
  assert.deepEqual(item.answer, job.body.data.result.value, '作业读面与轮次读面必须给出同一个回答');

  const deletedTurn = await fixture.call('DELETE', `${CONVERSATIONS}/${conversationId}/turns/${item.id}`, fixture.a, {
    headers: { 'idempotency-key': 'idem-del-turn-shape', 'if-match': `"${item.revision}"` },
  });
  assert.equal(deletedTurn.status, 202);
  assertEnvelopeShape('AckEnvelope', deletedTurn.body, 'deleteTurn 202');
  assertShape('Ack', deletedTurn.body.data, 'Ack');
  assert.equal(deletedTurn.etag, null, 'Ack 没有 revision 可绑定：不得伪造 ETag');
  assert.equal(deletedTurn.cache, 'no-store');

  const deleted = await fixture.call('DELETE', `${CONVERSATIONS}/${conversationId}`, fixture.a, {
    headers: { 'idempotency-key': 'idem-del-conv-shape', 'if-match': '"1"' },
  });
  assert.equal(deleted.status, 202);
  assertEnvelopeShape('AckEnvelope', deleted.body, 'deleteConversation 202');
  assert.equal(deleted.etag, null);
});

test('输入校验：契约声明的 400/428/409 逐条对上，且错误封套形状一致', async (t) => {
  const fixture = await conversationFixture(t);
  const created = await fixture.createConversation({}, { tag: 'validate' });
  const conversationId = created.body.data.id;

  const bad = [
    ['conditions 的 region_code 不符 ^33[0-9]{4}$', await fixture.createConversation({ conditions: { crop_id: 'rice', region_code: '33010' } }, { tag: 'v1' }), 400],
    ['conditions 缺 crop_id', await fixture.createConversation({ conditions: { region_code: '330100' } }, { tag: 'v2' }), 400],
    ['conditions 多出契约外键', await fixture.createConversation({ conditions: { crop_id: 'rice', region_code: '330100', extra: 'x' } }, { tag: 'v3' }), 400],
    ['请求体多出契约外键', await fixture.createConversation({ unexpected: 1 }, { tag: 'v4' }), 400],
    ['缺 Idempotency-Key', await fixture.call('POST', CONVERSATIONS, fixture.a, { payload: {} }), 400],
    ['Idempotency-Key 过短', await fixture.call('POST', CONVERSATIONS, fixture.a, { payload: {}, headers: { 'idempotency-key': 'short' } }), 400],
    ['路径 id 非法 uuid', await fixture.call('GET', `${CONVERSATIONS}/not-a-uuid`), 400],
    ['limit=0', await fixture.call('GET', `${CONVERSATIONS}?limit=0`), 400],
    ['limit=51', await fixture.call('GET', `${CONVERSATIONS}?limit=51`), 400],
    ['契约外查询键', await fixture.call('GET', `${CONVERSATIONS}?q=x`), 400],
    ['坏游标', await fixture.call('GET', `${CONVERSATIONS}?cursor=not-a-cursor`), 400],
    ['DELETE 缺 If-Match', await fixture.call('DELETE', `${CONVERSATIONS}/${conversationId}`, fixture.a, { headers: { 'idempotency-key': 'idem-v-ifmatch' } }), 428],
    ['If-Match 用 *', await fixture.call('DELETE', `${CONVERSATIONS}/${conversationId}`, fixture.a, { headers: { 'idempotency-key': 'idem-v-star', 'if-match': '*' } }), 400],
    ['If-Match revision 不符', await fixture.call('DELETE', `${CONVERSATIONS}/${conversationId}`, fixture.a, { headers: { 'idempotency-key': 'idem-v-stale', 'if-match': '"9"' } }), 409],
    ['createTurn 缺 If-Match', await fixture.call('POST', `${CONVERSATIONS}/${conversationId}/turns`, fixture.a, { payload: { input_type: 'text', text: 'x' }, headers: { 'idempotency-key': 'idem-v-turn-ifmatch' } }), 428],
    ['TurnInput 判别子在闭集外', await fixture.call('POST', `${CONVERSATIONS}/${conversationId}/turns`, fixture.a, { payload: { input_type: 'image', text: 'x' }, headers: { 'idempotency-key': 'idem-v-turn-type', 'if-match': '"1"' } }), 400],
    ['text 输入缺 text', await fixture.call('POST', `${CONVERSATIONS}/${conversationId}/turns`, fixture.a, { payload: { input_type: 'text' }, headers: { 'idempotency-key': 'idem-v-turn-text', 'if-match': '"1"' } }), 400],
    ['text 超 8000', await fixture.call('POST', `${CONVERSATIONS}/${conversationId}/turns`, fixture.a, { payload: { input_type: 'text', text: 'x'.repeat(8001) }, headers: { 'idempotency-key': 'idem-v-turn-long', 'if-match': '"1"' } }), 400],
    ['speech 输入缺 transcription_revision', await fixture.call('POST', `${CONVERSATIONS}/${conversationId}/turns`, fixture.a, { payload: { input_type: 'speech', transcription_id: ABSENT_ID, confirmed: true }, headers: { 'idempotency-key': 'idem-v-turn-speech', 'if-match': '"1"' } }), 400],
  ];
  for (const [label, response, status] of bad) {
    assert.equal(response.status, status, `${label} 应 ${status}，实得 ${response.status}：${JSON.stringify(response.body)}`);
    assert.ok(typeof response.body.error.code === 'string' && response.body.error.code.length > 0, `${label} 必须给契约错误码`);
    assertErrorShape(response.body, response.body.error.code, status, label);
  }

  // 具体的错误码（不是笼统的 400）。
  assert.equal((await fixture.call('GET', `${CONVERSATIONS}?cursor=not-a-cursor`)).body.error.code, 'INVALID_CURSOR');
  assert.equal((await fixture.call('DELETE', `${CONVERSATIONS}/${conversationId}`, fixture.a, { headers: { 'idempotency-key': 'idem-v-if2' } })).body.error.code, 'REVISION_REQUIRED');
  assert.equal((await fixture.call('DELETE', `${CONVERSATIONS}/${conversationId}`, fixture.a, { headers: { 'idempotency-key': 'idem-v-if3', 'if-match': '"9"' } })).body.error.code, 'REVISION_CONFLICT');
  assert.equal((await fixture.call('POST', CONVERSATIONS, fixture.a, { payload: {} })).body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal((await fixture.call('GET', CONVERSATIONS, null)).body.error.code, 'SESSION_REQUIRED');
  // 契约未给 405：方法不对也必须是契约内的 404（`setNotFoundHandler`），不得 200。
  const wrongMethod = await fixture.call('PATCH', `${CONVERSATIONS}/${conversationId}`, fixture.a, { payload: {} });
  assert.equal(wrongMethod.status, 404);
  assert.equal(wrongMethod.body.error.code, 'NOT_FOUND');
});

test('幂等重放：同键同体返回同一资源且不产生第二条，同键异体 409', async (t) => {
  const fixture = await conversationFixture(t, { injection: retrievalInjection([ITEM_A]) });
  const first = await fixture.createConversation({ conditions: { crop_id: 'rice', region_code: '330100' } }, { tag: 'idem' });
  const replay = await fixture.createConversation({ conditions: { crop_id: 'rice', region_code: '330100' } }, { tag: 'idem' });
  assert.equal(replay.status, 201, '重放必须回同一个 201');
  assert.equal(replay.body.data.id, first.body.data.id, '同键重放不得新建资源');
  assert.equal(replay.etag, '"1"', '重放也要给强 ETag');
  assert.equal(fixture.conversationStore.snapshot().conversations.length, 1);

  const conflict = await fixture.createConversation({ conditions: { crop_id: 'wheat', region_code: '330100' } }, { tag: 'idem' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');

  const turn = await acceptedTurn(fixture, first.body.data.id, 1, undefined, { tag: 'idem' });
  const turnReplay = await acceptedTurn(fixture, first.body.data.id, 1, undefined, { tag: 'idem' });
  assert.equal(turnReplay.body.data.id, turn.body.data.id, '同键重放不得新建第二条轮次');
  assert.equal(fixture.conversationStore.snapshot().turns.length, 1);

  const del = await fixture.call('DELETE', `${CONVERSATIONS}/${first.body.data.id}`, fixture.a, {
    headers: { 'idempotency-key': 'idem-del-replay', 'if-match': '"1"' },
  });
  const delReplay = await fixture.call('DELETE', `${CONVERSATIONS}/${first.body.data.id}`, fixture.a, {
    headers: { 'idempotency-key': 'idem-del-replay', 'if-match': '"1"' },
  });
  assert.equal(del.status, 202);
  assert.equal(delReplay.status, 202, '删除重放不得报 409：第一次删除已经成功');
  assert.deepEqual(delReplay.body.data, { accepted: true });
});

test('归属不可越权：他人与不存在逐键同形（404），跨用户游标不可用', async (t) => {
  const fixture = await conversationFixture(t);
  await fixture.createConversation({}, { tag: 'own' });
  fixture.clock.advance(1000);
  const mine = await fixture.createConversation({}, { tag: 'own2' });
  const mineId = mine.body.data.id;

  const otherRead = await fixture.call('GET', `${CONVERSATIONS}/${mineId}`, fixture.b);
  const absentRead = await fixture.call('GET', `${CONVERSATIONS}/${ABSENT_ID}`, fixture.b);
  assert.equal(otherRead.status, 404);
  assert.equal(absentRead.status, 404);
  assert.deepEqual(withoutRequestId(otherRead.body), withoutRequestId(absentRead.body), '他人与不存在必须逐键同形（不泄露存在性）');

  const otherDelete = await fixture.call('DELETE', `${CONVERSATIONS}/${mineId}`, fixture.b, {
    headers: { 'idempotency-key': 'idem-own-del', 'if-match': '"1"' },
  });
  assert.equal(otherDelete.status, 404);
  assert.equal(otherDelete.body.error.code, 'NOT_FOUND');

  const otherTurns = await fixture.call('GET', `${CONVERSATIONS}/${mineId}/turns`, fixture.b);
  assert.equal(otherTurns.status, 404);
  const otherTurnPost = await acceptedTurnOutcome(fixture, mineId, fixture.b);
  assert.equal(otherTurnPost.status, 404, '往他人会话写轮次必须 404（不得 403 泄露存在性）');

  const page = await fixture.call('GET', `${CONVERSATIONS}?limit=1`);
  assert.equal(page.body.data.items[0].id, mineId, '列表按 created_at DESC 排序');
  assert.ok(page.body.data.next_cursor !== null, '还有下一页时必须给游标');
  const crossUser = await fixture.call('GET', `${CONVERSATIONS}?limit=1&cursor=${encodeURIComponent(page.body.data.next_cursor)}`, fixture.b);
  assert.equal(crossUser.status, 400);
  assert.equal(crossUser.body.error.code, 'INVALID_CURSOR', '游标绑定主体：换人用必须失效');
});

async function acceptedTurnOutcome(fixture, conversationId, actor) {
  const response = await fixture.call('POST', `${CONVERSATIONS}/${conversationId}/turns`, actor, {
    payload: { input_type: 'text', text: QUESTION },
    headers: { 'idempotency-key': `idem-other-${conversationId}`, 'if-match': '"1"' },
  });
  return response;
}

test('分页：游标翻页互不重不漏，会话与轮次两条列表都按契约给 next_cursor', async (t) => {
  const fixture = await conversationFixture(t, { injection: retrievalInjection([ITEM_A]) });
  const ids = [];
  for (let index = 0; index < 3; index += 1) {
    const created = await fixture.createConversation({}, { tag: `page-${index}` });
    ids.push(created.body.data.id);
    fixture.clock.advance(1000);
  }
  const first = await fixture.call('GET', `${CONVERSATIONS}?limit=2`);
  assert.equal(first.body.data.items.length, 2);
  assert.equal(first.body.data.items[0].id, ids[2], '最新在前');
  const second = await fixture.call('GET', `${CONVERSATIONS}?limit=2&cursor=${encodeURIComponent(first.body.data.next_cursor)}`);
  assert.equal(second.body.data.items.length, 1);
  assert.equal(second.body.data.items[0].id, ids[0]);
  assert.equal(second.body.data.next_cursor, null, '没有更多时必须如实给 null，不得编造游标');
  const union = new Set([...first.body.data.items, ...second.body.data.items].map((row) => row.id));
  assert.deepEqual([...union].sort(), [...ids].sort(), '翻页必须不重不漏');

  const conversationId = ids[2];
  for (let index = 0; index < 3; index += 1) {
    await acceptedTurn(fixture, conversationId, 1, { input_type: 'text', text: `${QUESTION}${index}` }, { tag: `tpage-${index}` });
    fixture.clock.advance(1000);
  }
  const turnsFirst = await fixture.call('GET', `${CONVERSATIONS}/${conversationId}/turns?limit=2`);
  assert.equal(turnsFirst.body.data.items.length, 2);
  assert.ok(turnsFirst.body.data.next_cursor !== null);
  const turnsSecond = await fixture.call('GET', `${CONVERSATIONS}/${conversationId}/turns?limit=2&cursor=${encodeURIComponent(turnsFirst.body.data.next_cursor)}`);
  assert.equal(turnsSecond.body.data.items.length, 1);
  assert.equal(turnsSecond.body.data.next_cursor, null);
  const turnUnion = new Set([...turnsFirst.body.data.items, ...turnsSecond.body.data.items].map((row) => row.id));
  assert.equal(turnUnion.size, 3);
});

test('answer 作业：202 受理后可被跨 kind 读面读到，状态与失败可区分，已终态取消按既有 409 拒绝', async (t) => {
  const fixture = await conversationFixture(t, { injection: retrievalInjection([ITEM_A, ITEM_B]) });
  const created = await fixture.createConversation({}, { tag: 'job' });
  const conversationId = created.body.data.id;
  const accepted = await acceptedTurn(fixture, conversationId, 1, undefined, { tag: 'job' });
  const jobId = accepted.body.data.id;
  assert.equal(accepted.body.data.state, 'queued', '受理即 202：state 必须是 queued 而不是 succeeded');
  assert.equal(accepted.body.data.result, null, '受理时不得预置结果');

  const job = await fixture.call('GET', `${JOBS}/${jobId}`);
  assert.equal(job.status, 200);
  assert.equal(job.body.data.state, 'succeeded');
  assert.equal(job.body.data.error_code, null, 'succeeded 不得带 error_code');
  assert.equal(job.body.data.result.kind, 'answer');

  const turns = await fixture.call('GET', `${CONVERSATIONS}/${conversationId}/turns`);
  assert.equal(turns.body.data.items[0].job_id, jobId, '轮次上的 job_id 必须就是作业读面认的 id');

  // GY-R71 取消片：本域**已提供** cancel（接线前是 503「该能力尚未提供取消」）。可取消窗口只有
  // `queued`/`running`；这里这条作业上面已经读到 `succeeded` ⇒ 按既有语义拒绝，且不改状态。
  // 200 `cancelled` 的活体路径（含"取消后迟到结算不落回答行"）见
  // `tests/unit/jobs-cancel-moderation-answer.test.mjs` 的 answer·①②③ 三组。
  const cancel = await fixture.call('POST', `${JOBS}/${jobId}/cancel`, fixture.a, {
    headers: { 'idempotency-key': 'idem-job-cancel', 'if-match': `"${job.body.data.revision}"` },
  });
  assert.equal(cancel.status, 409, JSON.stringify(cancel.body));
  assert.equal(cancel.body.error.code, 'OBJECT_UNAVAILABLE', '已终态作业不可取消：必须如实拒绝，不得伪造 cancelled');
  assert.equal(
    cancel.body.error.retryable,
    false,
    '已终态不可取消（不是瞬时态）⇒ 同一请求重试不会成功 ⇒ 不得标为可重试',
  );
  const afterCancel = await fixture.call('GET', `${JOBS}/${jobId}`);
  assert.equal(afterCancel.body.data.state, 'succeeded', '被拒绝的取消不得改动状态');
  assert.equal(afterCancel.body.data.revision, job.body.data.revision, '被拒绝的取消不得改动 revision');

  const absent = await fixture.call('GET', `${JOBS}/${ABSENT_ID}`);
  assert.equal(absent.status, 404, '未接线 kind 与作业不存在同形');
  assert.equal(absent.body.error.code, 'NOT_FOUND');
  const otherUser = await fixture.call('GET', `${JOBS}/${jobId}`, fixture.b);
  assert.equal(otherUser.status, 404, '他人作业不可读（与不存在同形）');
});

test('回答产出：引用只能取自本次检索集合，正文如实标注未接真实模型', async (t) => {
  const seen = [];
  const fixture = await conversationFixture(t, { injection: retrievalInjection([ITEM_A, ITEM_B], seen) });
  const created = await fixture.createConversation({ conditions: { crop_id: 'rice', region_code: '330100' } }, { tag: 'ans' });
  const conversationId = created.body.data.id;
  const accepted = await acceptedTurn(fixture, conversationId, 1, undefined, { tag: 'ans' });

  assert.equal(seen.length, 1, '回答阶段必须真的读一次检索集合');
  const readInput = seen[0];
  assert.equal(readInput.question, QUESTION);
  assert.equal(readInput.identity.userId, fixture.a.user.id, '受理时捕获的会话身份要传下去');
  assert.equal(readInput.token, fixture.a.token, '受理时捕获的会话凭据要传下去（异步阶段不跳过鉴权）');
  assert.deepEqual(readInput.conditions, { crop_id: 'rice', region_code: '330100' });

  const job = await fixture.call('GET', `${JOBS}/${accepted.body.data.id}`);
  const answer = job.body.data.result.value;
  assert.equal(answer.status, 'answered', '有字面重合的条目时应给出 answered');
  assert.equal(answer.check_state, 'passed');
  assert.ok(answer.citations.length >= 1, 'answered 必须带引用');
  assert.ok(answer.citations.length <= 20);
  for (const citation of answer.citations) {
    assert.deepEqual(shapeIssues(loadSchema('SourceRef'), citation, 'SourceRef'), []);
    const matched = [ITEM_A, ITEM_B].filter((item) => item.id === citation.id);
    assert.equal(matched.length, 1, `引用必须来自本次检索集合：${citation.id}`);
    assert.deepEqual(citation, matched[0].source, '引用必须逐字等于检索集合里的来源（不得改写）');
  }
  assert.equal(answer.citations.some((citation) => citation.id === ITEM_A.id), true, '相关条目必须在引用里');
  assert.deepEqual(answer.dose_cards, [], '确定性权威路径判定不可产出用量卡时不得产出');
  assert.match(answer.checked_text, /未接真实模型/);
  assert.deepEqual(versionProblems(answer), []);
  assert.ok(answer.rule_version.includes(RELEVANCE_RULE), '规则版本要能读出确定性正文规则');
  assert.match(answer.rule_version, /\+dose\/[^+]+$/, '规则版本要能读出用量权威版本（不得省略）');

  // 作业读面与轮次读面必须给出同一个回答（同一次读取的两个投影，不得各自编造）。
  const turns = await fixture.call('GET', `${CONVERSATIONS}/${conversationId}/turns`);
  assert.deepEqual(turns.body.data.items[0].answer, answer);
});

test('检索集合为空/未接线 ⇒ 如实 insufficient（不编造引用、不给用量）', async (t) => {
  const fixture = await conversationFixture(t, { injection: {
    retrieval: createWiredRetrievalPort({ note: '测试替身：空集合', read: async (input) => retrievalSet(input.identity.userId, []) }),
    dose: createUnwiredDoseAuthority(),
  } });
  const created = await fixture.createConversation({}, { tag: 'empty' });
  const accepted = await acceptedTurn(fixture, created.body.data.id, 1, undefined, { tag: 'empty' });
  const job = await fixture.call('GET', `${JOBS}/${accepted.body.data.id}`);
  assert.equal(job.body.data.state, 'succeeded');
  const answer = job.body.data.result.value;
  assert.equal(answer.status, 'insufficient');
  assert.equal(answer.check_state, 'passed');
  assert.deepEqual(answer.citations, []);
  assert.deepEqual(answer.dose_cards, []);
  assert.match(answer.checked_text, /资料不足/);
  assert.deepEqual(versionProblems(answer), []);

  // 完全未接线的检索端口（默认装配在无资料库时就是这个）：一律 null ⇒ 同样 insufficient。
  const unwired = await conversationFixture(t, { injection: { retrieval: createUnwiredRetrievalPort() } });
  const created2 = await unwired.createConversation({}, { tag: 'unwired' });
  const accepted2 = await acceptedTurn(unwired, created2.body.data.id, 1, undefined, { tag: 'unwired' });
  const job2 = await unwired.call('GET', `${JOBS}/${accepted2.body.data.id}`);
  assert.equal(job2.body.data.result.value.status, 'insufficient');
  assert.deepEqual(job2.body.data.result.value.citations, []);
});

test('语音轮次：转写端口未接线 ⇒ 422 INPUT_UNCERTAIN；已接线但查不到 ⇒ 404（都不落假成功）', async (t) => {
  const payload = { input_type: 'speech', transcription_id: '5c9a1f2e-3d4b-4a5c-8e7f-1a2b3c4d5e6f', transcription_revision: 1, confirmed: true };

  // 端口未接线：无法确认转写 ⇒ 契约给 `INPUT_UNCERTAIN` 预留的状态码是 422（不是 503 假装服务不可用，
  // 更不是 202 假装受理）。两条路都必须**零副作用**：不留轮次行。
  const unwired = await conversationFixture(t, { injection: { transcription: createUnwiredTranscriptionPort('测试：转写核对端口未接线') } });
  const created = await unwired.createConversation({}, { tag: 'speech' });
  const response = await unwired.call('POST', `${CONVERSATIONS}/${created.body.data.id}/turns`, unwired.a, {
    payload,
    headers: { 'idempotency-key': 'idem-speech-unwired', 'if-match': '"1"' },
  });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, 'INPUT_UNCERTAIN');
  // 新增（本文件此前对这条路径**零** `retryable` 断言）：未接线＝能力未装配 ⇒ 需运维接线，
  // 同一请求在无人工/运维介入下稍后重试不会成功 ⇒ 必须为 false（不得暗示"稍后自己会好"）。
  // 口径原文见 services/api/src/errors.ts 的 ApiError 注释。
  assert.equal(
    response.body.error.retryable,
    false,
    '转写端口未接线 ⇒ retryable 必须为 false（能力未装配不是瞬时故障）',
  );
  assert.equal(unwired.conversationStore.snapshot().turns.length, 0, '未受理就不得留下轮次行（不得半截写入）');
  assert.equal(unwired.conversationStore.snapshot().answers.length, 0);

  // 对照态：端口已接线（装配默认复用语音域读面），但转写不存在 ⇒ 契约 404，而不是 422。
  const wired = await conversationFixture(t);
  const created2 = await wired.createConversation({}, { tag: 'speech2' });
  const missing = await wired.call('POST', `${CONVERSATIONS}/${created2.body.data.id}/turns`, wired.a, {
    payload,
    headers: { 'idempotency-key': 'idem-speech-missing', 'if-match': '"1"' },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
  assert.notEqual(missing.body.error.code, response.body.error.code, '两种失败必须可区分（不可笼统同一码）');
  assert.equal(wired.conversationStore.snapshot().turns.length, 0);
});

test('未接线如实失败（两态对照）：整域未接线 ⇒ 契约路径 503，契约外相邻路径 404，都不是 200 空壳', async (t) => {
  const fixture = await conversationFixture(t, { real: true });
  assert.equal(fixture.app.conversationService, null, 'real 且无 DATABASE_URL ⇒ 整域 fail-closed');
  const created = await fixture.call('POST', CONVERSATIONS, fixture.a, { payload: {}, headers: { 'idempotency-key': 'idem-unwired-1' } });
  assert.equal(created.status, 503);
  assert.equal(created.body.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(created.body.error.retryable, false);
  const list = await fixture.call('GET', CONVERSATIONS);
  assert.equal(list.status, 503);
  assert.equal(list.body.error.code, 'PROVIDER_UNAVAILABLE');
  assert.notEqual(list.status, 200, '未接线不得回 200 空壳（那是假成功）');

  // 对照读数：同一实例里**不依赖数据库**的既有契约路径照常给出契约内状态，
  // 证明问答域的 503 是"本域未接线"，不是"整站挂了"。
  const neighbor = await fixture.call('GET', `${JOBS}/${ABSENT_ID}`);
  assert.equal(neighbor.status, 404, `未接线的问答域不得连带把其它域打成 503：${JSON.stringify(neighbor.body)}`);
  assert.equal(neighbor.body.error.code, 'NOT_FOUND');
  assert.equal(neighbor.body.meta.execution_mode, 'real');

  // 契约未实现的相邻路径：如实 404（既不是 200，也不是 503）。
  const adjacent = [
    ['PATCH', `${CONVERSATIONS}/${ABSENT_ID}`],
    ['GET', `${CONVERSATIONS}/${ABSENT_ID}/turns/${ABSENT_ID}`],
    ['PUT', `${CONVERSATIONS}/${ABSENT_ID}/turns`],
    ['GET', `${CONVERSATIONS}/${ABSENT_ID}/answers`],
  ];
  for (const [method, path] of adjacent) {
    const response = await fixture.call(method, path, fixture.a, { payload: method === 'GET' ? undefined : {} });
    assert.equal(response.status, 404, `${method} ${path} 必须如实 404`);
    assert.equal(response.body.error.code, 'NOT_FOUND');
  }
});

test('删会话：202 受理，其下轮次与回答一并处理，且后续读取如实 404', async (t) => {
  const fixture = await conversationFixture(t, { injection: retrievalInjection([ITEM_A]) });
  const created = await fixture.createConversation({}, { tag: 'del-conv' });
  const conversationId = created.body.data.id;
  const accepted = await acceptedTurn(fixture, conversationId, 1, undefined, { tag: 'del-conv' });
  const before = fixture.conversationStore.snapshot();
  assert.deepEqual(
    { conversations: before.conversations.length, turns: before.turns.length, answers: before.answers.length },
    { conversations: 1, turns: 1, answers: 1 },
    '前置：一条会话、一条轮次、一条回答都已落库',
  );

  const removed = await fixture.call('DELETE', `${CONVERSATIONS}/${conversationId}`, fixture.a, {
    headers: { 'idempotency-key': 'idem-del-conv-1', 'if-match': '"1"' },
  });
  assert.equal(removed.status, 202, `受理删除应 202：${JSON.stringify(removed.body)}`);
  assert.deepEqual(removed.body.data, { accepted: true });
  assert.equal(removed.etag, null, 'Ack 无 revision：不得伪造 ETag');

  // 契约 `deleteConversation` 的级联 = 会话连同其下轮次与回答一并处理（不得只删会话）。
  const after = fixture.conversationStore.snapshot();
  assert.deepEqual(
    { conversations: after.conversations.length, turns: after.turns.length, answers: after.answers.length },
    { conversations: 0, turns: 0, answers: 0 },
    '删会话必须级联到其下轮次与回答（只删会话行 = 用例必须变红）',
  );
  const reread = await fixture.call('GET', `${CONVERSATIONS}/${conversationId}`);
  assert.equal(reread.status, 404);
  assert.equal(reread.body.error.code, 'NOT_FOUND');
  const turns = await fixture.call('GET', `${CONVERSATIONS}/${conversationId}/turns`);
  assert.equal(turns.status, 404, '会话没了，其轮次列表同样如实 404');
  const job = await fixture.call('GET', `${JOBS}/${accepted.body.data.id}`);
  assert.equal(job.status, 404, '已删轮次的作业也不得再被读到');
  const list = await fixture.call('GET', CONVERSATIONS);
  assert.deepEqual(list.body.data.items, []);
  assert.equal(list.body.data.next_cursor, null);
});

test('诚实标注判据：任何回答都不得被表述为真实模型结果（版本串可被机器检出）', async (t) => {
  const fixture = await conversationFixture(t, { injection: retrievalInjection([ITEM_A]) });
  const created = await fixture.createConversation({}, { tag: 'honest' });
  const accepted = await acceptedTurn(fixture, created.body.data.id, 1, undefined, { tag: 'honest' });
  const answer = (await fixture.call('GET', `${JOBS}/${accepted.body.data.id}`)).body.data.result.value;
  assert.deepEqual(versionProblems(answer), []);
  // 判据本身也要能抓住"替身标成真实模型"（负控制见 conversation-answer-guard.test.mjs）。
  assert.notDeepEqual(versionProblems({ ...answer, model_version: 'gpt-4o-mini' }), []);
  for (const text of [answer.checked_text]) {
    assert.equal(/真实模型|实时问答|真实付费/.test(text.replace(/未接真实模型/g, '')), false, `正文不得声称真实模型结果：${text}`);
  }
});
