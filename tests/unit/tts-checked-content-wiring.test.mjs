/**
 * GY-R28-W3 · TTS「已核对内容」端口接线（real 分支接真实现）· 域内回归。
 *
 * 覆盖派单要求的四类读数，全部**不依赖真实数据库**（注入假查询端口）：
 *   1. 未配置（无连接池）⇒ 与接线前逐字一致：仍是 `unwired` 端口，读一律抛错（fail-closed），
 *      替身条目在 real 下**不被采用**；
 *   2. 配置齐 ⇒ 真实现：`answer` 读 `public.conversation_answers`、
 *      `species/herbicide/scheme/static_region` 读 `catalog_read.current_knowledge`；
 *   3. 负控制（逐条独立用例）：未核对 / 已驳回 / 未知核对状态 / revision 不一致 /
 *      跨账号引用 / 跨类型（跨页）引用 / 内容不存在 / 无正文 / 查询抛错——每条都断言**拒绝码**；
 *   4. 结构证据：SQL 是参数化查询（id 不进 SQL 文本）、只读（无 insert/update/delete）、
 *      `type` 进 WHERE、非 uuid 不查库、`dose_card` 当前无可核验来源（不查库、返回 404）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditStateFromCheckState,
  createCheckedContentPortFromConfig,
  createLiveCheckedContentPort,
  createSqlCheckedContentSource,
} from '../../services/api/src/ai/checked-content-live-adapter.ts';
import { CheckedContentUnavailableError, createUnwiredCheckedContentPort } from '../../services/api/src/tts/content.ts';
import { decideCheckedContent } from '../../services/api/src/tts/state.ts';

const ANSWER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ANSWER_ID = '22222222-2222-4222-8222-222222222222';
const KNOWLEDGE_ID = '33333333-3333-4333-8333-333333333333';
const CALLER = '44444444-4444-4444-8444-444444444444';
const OTHER_USER = '55555555-5555-4555-8555-555555555555';

/** 可控假查询端口：按 SQL 关键字分派，记录每一次查询（含是否发生）。 */
function fakePool(handlers) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      if (typeof handlers === 'function') return handlers(text, values);
      if (text.includes('conversation_answers')) return { rows: handlers.answers?.(values) ?? [] };
      if (text.includes('catalog_read.current_knowledge')) return { rows: handlers.knowledge?.(values) ?? [] };
      throw new Error(`未预期的查询：${text}`);
    },
  };
}

function answerRow(overrides = {}) {
  return { revision: 3, check_state: 'passed', owner_id: CALLER, checked_text: '雪霉病可用…（合成文本）', ...overrides };
}

function knowledgeRow(overrides = {}) {
  return { revision: 2, title: '水稻纹枯病', body: '…（合成正文）', ...overrides };
}

/** 走「装配处入口 → 端口 → 判定」的完整一跳，返回判定结果。 */
async function decideWith(config, requested) {
  const port = createCheckedContentPortFromConfig(config);
  let snapshot;
  try {
    snapshot = await port.read({ type: requested.type, id: requested.id });
  } catch {
    // 与 tts/service.ts:282-291 同口径：读不到核对状态 ⇒ OBJECT_UNAVAILABLE。
    return { ok: false, code: 'OBJECT_UNAVAILABLE', reason: 'AUDIT_STATE_UNREADABLE', port };
  }
  return { ...decideCheckedContent({ requested, callerUserId: CALLER, snapshot }), port };
}

// ---------------------------------------------------------------------------
// 一、未配置 ⇒ 与接线前逐字一致（fail-closed 不退化）
// ---------------------------------------------------------------------------

test('W3-01 未配置（real + 无连接池）⇒ 仍是 unwired 端口，原因文本与接线前逐字相同', async () => {
  const baseline = createUnwiredCheckedContentPort();
  const port = createCheckedContentPortFromConfig({ executionMode: 'real', pool: null });
  assert.equal(port.kind, 'unwired');
  assert.equal(port.note, baseline.note);
  await assert.rejects(() => port.read({ type: 'answer', id: ANSWER_ID }), (error) => {
    assert.ok(error instanceof CheckedContentUnavailableError);
    return true;
  });
});

test('W3-02 real + 无连接池 ⇒ 即便注入了替身条目也不采用（受理前拒绝，不是「退回替身」）', async () => {
  const decision = await decideWith(
    {
      executionMode: 'real',
      entries: [{ type: 'answer', id: ANSWER_ID, revision: 3, auditState: 'approved', text: '替身文本' }],
      pool: null,
    },
    { type: 'answer', id: ANSWER_ID, revision: 3 },
  );
  assert.equal(decision.port.kind, 'unwired');
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'OBJECT_UNAVAILABLE');
  assert.equal(decision.reason, 'AUDIT_STATE_UNREADABLE');
});

test('W3-03 替身/演示模式 ⇒ 仍是 substitute 端口，且一个查询都不发（连接池被忽略）', async () => {
  const pool = fakePool(() => {
    throw new Error('替身模式不得查询数据库');
  });
  for (const mode of ['stub', 'preset_demo']) {
    const port = createCheckedContentPortFromConfig({
      executionMode: mode,
      entries: [{ type: 'answer', id: ANSWER_ID, revision: 3, auditState: 'approved', text: '替身文本' }],
      pool,
    });
    assert.equal(port.kind, 'substitute');
    const snapshot = await port.read({ type: 'answer', id: ANSWER_ID });
    assert.equal(snapshot.text, '替身文本');
  }
  assert.equal(pool.calls.length, 0);
});

test('W3-04 真实来源构造期 fail-closed：查询端口缺失/形状不符 ⇒ CheckedContentWiringError', () => {
  for (const bad of [null, undefined, {}, { query: 'not-a-function' }]) {
    assert.throws(() => createSqlCheckedContentSource(bad), /只读查询端口/);
  }
  assert.throws(() => createLiveCheckedContentPort({}), /缺少来源/);
});

// ---------------------------------------------------------------------------
// 二、配置齐 ⇒ 真实现（answer / knowledge 两条真实来源）
// ---------------------------------------------------------------------------

test('W3-05 answer 来源：读到已核对回答 ⇒ approved + 当前 revision + 正文，判定放行', async () => {
  const pool = fakePool({ answers: () => [answerRow()] });
  const decision = await decideWith({ executionMode: 'real', pool }, { type: 'answer', id: ANSWER_ID, revision: 3 });
  assert.equal(decision.ok, true);
  assert.equal(decision.revision, 3);
  assert.equal(decision.text, '雪霉病可用…（合成文本）');
  assert.equal(decision.port.kind, 'wired');
  // 参数化：id 只出现在绑定参数里，不进 SQL 文本。
  assert.equal(pool.calls.length, 1);
  assert.equal(pool.calls[0].text.includes(ANSWER_ID), false, 'id 不得拼进 SQL 文本');
  assert.deepEqual(pool.calls[0].values, [ANSWER_ID]);
  assert.match(pool.calls[0].text, /from public\.conversation_answers where id = \$1::uuid/);
});

test('W3-06 knowledge 来源：读 catalog_read.current_knowledge（type 进 WHERE），正文=标题+换行+正文', async () => {
  const pool = fakePool({ knowledge: (values) => (values[1] === 'herbicide' ? [knowledgeRow()] : []) });
  const decision = await decideWith({ executionMode: 'real', pool }, { type: 'herbicide', id: KNOWLEDGE_ID, revision: 2 });
  assert.equal(decision.ok, true);
  assert.equal(decision.text, '水稻纹枯病\n…（合成正文）');
  assert.equal(pool.calls[0].text.includes(KNOWLEDGE_ID), false);
  assert.deepEqual(pool.calls[0].values, [KNOWLEDGE_ID, 'herbicide']);
  assert.match(pool.calls[0].text, /from catalog_read\.current_knowledge where id = \$1::uuid and type = \$2/);
  // 四种知识类型都走同一读面。
  for (const type of ['species', 'scheme', 'static_region']) {
    await decideWith({ executionMode: 'real', pool: fakePool({ knowledge: () => [knowledgeRow()] }) }, { type, id: KNOWLEDGE_ID, revision: 2 });
  }
});

test('W3-07 只读：全部 SQL 只有 select（无 insert/update/delete/for update）', async () => {
  const statements = [];
  const pool = fakePool((text) => {
    statements.push(text);
    return { rows: [] };
  });
  const port = createCheckedContentPortFromConfig({ executionMode: 'real', pool });
  await port.read({ type: 'answer', id: ANSWER_ID });
  await port.read({ type: 'scheme', id: KNOWLEDGE_ID });
  assert.equal(statements.length, 2);
  for (const sql of statements) {
    assert.match(sql, /^select /);
    assert.equal(/insert|update|delete|for update|alter|create/i.test(sql), false, `不得含写语句：${sql}`);
  }
});

// ---------------------------------------------------------------------------
// 三、负控制（逐条独立用例，断言拒绝码）
// ---------------------------------------------------------------------------

test('W3-08 负控制·未核对（pending）⇒ 422 INPUT_UNCERTAIN，不放行', async () => {
  const pool = fakePool({ answers: () => [answerRow({ check_state: 'pending' })] });
  const decision = await decideWith({ executionMode: 'real', pool }, { type: 'answer', id: ANSWER_ID, revision: 3 });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'INPUT_UNCERTAIN');
  assert.equal(decision.reason, 'AUDIT_PENDING');
});

test('W3-09 负控制·已驳回（check_state=blocked）⇒ 409 OBJECT_UNAVAILABLE（AUDIT_REJECTED）', async () => {
  const pool = fakePool({ answers: () => [answerRow({ check_state: 'blocked' })] });
  const decision = await decideWith({ executionMode: 'real', pool }, { type: 'answer', id: ANSWER_ID, revision: 3 });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'OBJECT_UNAVAILABLE');
  assert.equal(decision.reason, 'AUDIT_REJECTED');
});

test('W3-10 负控制·库内出现契约外核对状态 ⇒ 原样透出 ⇒ 409（AUDIT_STATE_UNREADABLE，绝不规整成 approved）', async () => {
  assert.equal(auditStateFromCheckState('passed'), 'approved');
  assert.equal(auditStateFromCheckState('blocked'), 'rejected');
  assert.equal(auditStateFromCheckState('weird'), 'weird');
  const pool = fakePool({ answers: () => [answerRow({ check_state: 'weird' })] });
  const decision = await decideWith({ executionMode: 'real', pool }, { type: 'answer', id: ANSWER_ID, revision: 3 });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'OBJECT_UNAVAILABLE');
  assert.equal(decision.reason, 'AUDIT_STATE_UNREADABLE');
});

test('W3-11 负控制·版本不一致（库内 revision 4，请求 3）⇒ 409 REVISION_CONFLICT，不复用旧审核', async () => {
  const pool = fakePool({
    answers: () => [answerRow({ revision: 4 })],
    knowledge: () => [knowledgeRow({ revision: 9 })],
  });
  const answerDecision = await decideWith({ executionMode: 'real', pool }, { type: 'answer', id: ANSWER_ID, revision: 3 });
  assert.equal(answerDecision.code, 'REVISION_CONFLICT');
  assert.equal(answerDecision.reason, 'REVISION_MISMATCH');
  const knowledgeDecision = await decideWith({ executionMode: 'real', pool }, { type: 'scheme', id: KNOWLEDGE_ID, revision: 2 });
  assert.equal(knowledgeDecision.code, 'REVISION_CONFLICT');
  assert.equal(knowledgeDecision.reason, 'REVISION_MISMATCH');
});

test('W3-12 负控制·跨账号引用（他人的回答）⇒ 404 NOT_FOUND，与不存在同形', async () => {
  const pool = fakePool({ answers: () => [answerRow({ owner_id: OTHER_USER })] });
  const decision = await decideWith({ executionMode: 'real', pool }, { type: 'answer', id: OTHER_ANSWER_ID, revision: 3 });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'NOT_FOUND');
  assert.equal(decision.reason, 'TARGET_FOREIGN_OWNER');
});

test('W3-13 负控制·跨页/跨类型引用（拿知识 id 当 answer、拿回答 id 当 scheme）⇒ 404 NOT_FOUND', async () => {
  const pool = fakePool({
    answers: (values) => (values[0] === ANSWER_ID ? [answerRow()] : []),
    knowledge: (values) => (values[1] === 'scheme' && values[0] === KNOWLEDGE_ID ? [knowledgeRow()] : []),
  });
  const knowledgeAsAnswer = await decideWith({ executionMode: 'real', pool }, { type: 'answer', id: KNOWLEDGE_ID, revision: 2 });
  assert.equal(knowledgeAsAnswer.code, 'NOT_FOUND');
  assert.equal(knowledgeAsAnswer.reason, 'TARGET_NOT_FOUND');
  const answerAsScheme = await decideWith({ executionMode: 'real', pool }, { type: 'scheme', id: ANSWER_ID, revision: 3 });
  assert.equal(answerAsScheme.code, 'NOT_FOUND');
  const wrongKnowledgeType = await decideWith({ executionMode: 'real', pool }, { type: 'herbicide', id: KNOWLEDGE_ID, revision: 2 });
  assert.equal(wrongKnowledgeType.code, 'NOT_FOUND', 'type 必须进 WHERE：同 id 的不同类型不得互相顶替');
});

test('W3-14 负控制·未核对/未发布的知识不在读面 ⇒ 查不到行 ⇒ 404（不是「按已核对放行」）', async () => {
  const pool = fakePool({ knowledge: () => [] });
  const decision = await decideWith({ executionMode: 'real', pool }, { type: 'species', id: KNOWLEDGE_ID, revision: 1 });
  assert.equal(decision.code, 'NOT_FOUND');
  assert.equal(decision.reason, 'TARGET_NOT_FOUND');
});

test('W3-15 负控制·核对通过但无正文 ⇒ 409 OBJECT_UNAVAILABLE（CONTENT_UNREADABLE，绝不念空串）', async () => {
  const pool = fakePool({ knowledge: () => [knowledgeRow({ body: '' })] });
  const decision = await decideWith({ executionMode: 'real', pool }, { type: 'scheme', id: KNOWLEDGE_ID, revision: 2 });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'OBJECT_UNAVAILABLE');
  assert.equal(decision.reason, 'CONTENT_UNREADABLE');
});

test('W3-16 负控制·凭据/连接缺失导致查询抛错 ⇒ 409 OBJECT_UNAVAILABLE（绝不当成 approved）', async () => {
  const pool = {
    calls: 0,
    async query() {
      this.calls += 1;
      const error = new Error('connect ECONNREFUSED 10.0.0.1:5432');
      throw error;
    },
  };
  const port = createCheckedContentPortFromConfig({ executionMode: 'real', pool });
  assert.equal(port.kind, 'wired');
  await assert.rejects(() => port.read({ type: 'answer', id: ANSWER_ID }), (error) => {
    assert.ok(error instanceof CheckedContentUnavailableError);
    assert.equal(error.message.includes('ECONNREFUSED'), false, '不得外带驱动原文');
    return true;
  });
  const decision = await decideWith({ executionMode: 'real', pool }, { type: 'answer', id: ANSWER_ID, revision: 3 });
  assert.equal(decision.code, 'OBJECT_UNAVAILABLE');
  assert.equal(decision.reason, 'AUDIT_STATE_UNREADABLE');
});

// ---------------------------------------------------------------------------
// 四、边界：不存在的内容形状（不查库 / 无可核验来源）
// ---------------------------------------------------------------------------

test('W3-17 dose_card 当前无可核验来源 ⇒ 404，且不发起查询（不拼别处的卡来冒充）', async () => {
  const pool = fakePool(() => {
    throw new Error('dose_card 不得产生查询');
  });
  const decision = await decideWith({ executionMode: 'real', pool }, { type: 'dose_card', id: ANSWER_ID, revision: 1 });
  assert.equal(decision.code, 'NOT_FOUND');
  assert.equal(pool.calls.length, 0);
});

test('W3-18 非 uuid 标识（契约允许 1..80 任意字符串，但两来源主键都是 uuid）⇒ 404，且不查库', async () => {
  const pool = fakePool(() => {
    throw new Error('非 uuid 不得产生查询');
  });
  const port = createCheckedContentPortFromConfig({ executionMode: 'real', pool });
  assert.equal(await port.read({ type: 'answer', id: 'not-a-uuid' }), null);
  assert.equal(await port.read({ type: 'scheme', id: 'x'.repeat(80) }), null);
  assert.equal(pool.calls.length, 0);
});
