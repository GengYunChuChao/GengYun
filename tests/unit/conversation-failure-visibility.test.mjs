// GY-I12（#12）：**失败与重试可见性**（范围条目④）＋**数据最小化**（重点核第 5 条）。
//
// ④ 要证明的三件事（都是"静默做错"的高发方向）：
//   1) 失败与超时**显式可见且可区分**：作业读面给出 `failed`/`timed_out` + 契约错误码，
//      轮次读面如实"没有回答"，**绝**不拿半截文本冒充完整答案；
//   2) 失败**不留残渣**：一次失败不得落任何回答行（store 快照里 answers 为 0）；
//   3) 重试**幂等且不重复**：同键同体重放 ⇒ 同一个作业、不产生第二条轮次；换键 ⇒ 恰好新增一条，
//      先前失败的轮次保持失败（不被后来的成功"补写"成有回答）；
//   以及"依据正文被截断时**必须显式标注**节选"（不得静默返回半截文本）。
//
// ⑤ 数据最小化：七个 operation 的响应与 info 级日志都不得回显 bearer 令牌、`owner_id`、
//   openid、手机号；问答域源码里没有任何日志调用（没有可泄漏面）。
//
// 全部在 stub 模式 + 合成替身下断言：没有真实模型、没有真实资料库、不发任何真实外发调用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { conversationFixture, CONVERSATIONS, JOBS, retrievalItem, retrievalSet } from './conversation-fixtures.mjs';
import { ApiError } from '../../services/api/src/errors.ts';
import { createWiredRetrievalPort } from '../../services/api/src/conversations/guard.ts';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';
import {
  COMPOSER_EXCERPT_MAX,
  createDeterministicAnswerComposer,
  excerptOf,
} from '../../services/api/src/conversations/service.ts';

const QUESTION = '稻田稗草怎么识别？';

const ITEM = retrievalItem({
  id: '9f1c7a52-3b4d-4e88-9a10-2c5d6e7f8a90',
  title: '合成资料甲：稗草的识别（测试替身）',
  body: '稗草的识别要点：合成正文，仅用于回归，不含真实用量建议。',
});

/** 检索替身：第 `failTimes` 次读取抛错，其余正常（用来造"可重试的失败"）。 */
function flakyRetrieval(failTimes = 1) {
  let calls = 0;
  return {
    retrieval: createWiredRetrievalPort({
      note: '测试替身检索端口：按次数失败，不查资料库',
      read: async (input) => {
        calls += 1;
        if (calls <= failTimes) throw new Error(`模拟供应商读取失败（第 ${calls} 次）`);
        return retrievalSet(input.identity.userId, [ITEM]);
      },
    }),
  };
}

async function conversationRevision(fixture, conversationId) {
  const read = await fixture.call('GET', `${CONVERSATIONS}/${conversationId}`);
  assert.equal(read.status, 200);
  return read.body.data.revision;
}

async function turnsOf(fixture, conversationId) {
  const response = await fixture.call('GET', `${CONVERSATIONS}/${conversationId}/turns`);
  assert.equal(response.status, 200, `读轮次应 200：${JSON.stringify(response.body)}`);
  return response.body.data.items;
}

/** 受理一轮（不假设成功），返回作业 id。 */
async function accept(fixture, conversationId, tag, text = QUESTION) {
  fixture.clock.advance(1000);
  const accepted = await fixture.createTurn(conversationId, await conversationRevision(fixture, conversationId), {
    input_type: 'text',
    text,
  }, { tag });
  assert.equal(accepted.status, 202, `受理应 202：${JSON.stringify(accepted.body)}`);
  assert.equal(accepted.body.data.state, 'queued', '受理即 202：state 必须是 queued，不得预置终态');
  assert.equal(accepted.body.data.result, null, '受理时不得预置结果');
  return accepted.body.data.id;
}

test('供应商读取失败 ⇒ failed：作业读面显式失败、轮次读面如实无回答、不落任何回答行', async (t) => {
  const fixture = await conversationFixture(t, { injection: flakyRetrieval(1) });
  const created = await fixture.createConversation({}, { tag: 'fail' });
  const conversationId = created.body.data.id;

  const jobId = await accept(fixture, conversationId, 'fail-t1');
  const job = await fixture.call('GET', `${JOBS}/${jobId}`);
  assert.equal(job.status, 200);
  assert.equal(job.body.data.state, 'failed', '失败必须显式落 failed（不得停在 running、更不得 succeeded）');
  assert.equal(job.body.data.error_code, 'PROVIDER_UNAVAILABLE');
  assert.equal(job.body.data.result, null, '失败的作业不得携带任何回答结果（不得返回半截文本）');
  assert.equal(typeof job.body.data.deadline_at, 'string', '失败也保留截止时间：可重试性可被读完');

  const turns = await turnsOf(fixture, conversationId);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].answer, null, '失败的轮次在读面上必须是"没有回答"，不得伪造空回答对象');
  assert.equal(turns[0].job_id, jobId, '轮次必须指向同一个作业（读面之间不得各说一套）');

  const snapshot = fixture.conversationStore.snapshot();
  assert.equal(snapshot.turns.length, 1, '受理的轮次本身要留痕（不是"什么都没发生"）');
  assert.equal(snapshot.answers.length, 0, '失败不得落任何回答行（不留半截正文残渣）');
  const failedTurn = snapshot.turns[0];
  assert.equal(failedTurn.job_state, 'failed');
  assert.equal(failedTurn.job_error_code, 'PROVIDER_UNAVAILABLE');
  assert.equal(failedTurn.answer_id, null, '失败的轮次不得挂回答 id');
});

test('超过截止时间 ⇒ timed_out：与 failed 可区分，且同样不带任何回答', async (t) => {
  const realStore = createMemoryConversationStore();
  let clock = null;
  // 在认领作业的瞬间把时钟推过 30s 截止时间：这是生产里"超时"的唯一判据（`scheduleAnswer`）。
  const slowStore = {
    ...realStore,
    async claimTurnJob(turnId, ownerId) {
      const claimed = await realStore.claimTurnJob(turnId, ownerId);
      clock.advance(60_000);
      return claimed;
    },
  };
  const fixture = await conversationFixture(t, {
    injection: { store: slowStore, ...flakyRetrieval(0) },
  });
  clock = fixture.clock;
  assert.notEqual(clock, null);

  const created = await fixture.createConversation({}, { tag: 'timeout' });
  const conversationId = created.body.data.id;
  const jobId = await accept(fixture, conversationId, 'timeout-t1');

  const job = await fixture.call('GET', `${JOBS}/${jobId}`);
  assert.equal(job.body.data.state, 'timed_out', '超时必须落 timed_out（与 failed 区分）');
  assert.equal(job.body.data.error_code, 'PROVIDER_TIMEOUT');
  assert.equal(job.body.data.result, null, '超时的作业不得携带任何回答');

  const turns = await turnsOf(fixture, conversationId);
  assert.equal(turns[0].answer, null);
  assert.equal(fixture.conversationStore.snapshot().answers.length, 0, '超时同样不得落回答行');

  // 两种失败状态必须能被客户端区分（否则"重试可能有用"与"等待超时"就分不开了）。
  assert.notEqual(job.body.data.state, 'failed');
  assert.notEqual(job.body.data.error_code, 'PROVIDER_UNAVAILABLE');
});

test('重试幂等：同键同体重放同一作业、不产生第二条轮次；换键才新增一条，且失败轮次不被补写', async (t) => {
  const fixture = await conversationFixture(t, { injection: flakyRetrieval(1) });
  const created = await fixture.createConversation({}, { tag: 'retry' });
  const conversationId = created.body.data.id;

  const jobId = await accept(fixture, conversationId, 'retry-t1');
  assert.equal((await fixture.call('GET', `${JOBS}/${jobId}`)).body.data.state, 'failed');

  // 同键同体（幂等重放）：仍 202、仍是同一个作业，且不得多出一条轮次。
  fixture.clock.advance(1000);
  const replayRevision = await conversationRevision(fixture, conversationId);
  const replay = await fixture.createTurn(conversationId, replayRevision, { input_type: 'text', text: QUESTION }, {
    tag: 'retry-t1',
  });
  assert.equal(replay.status, 202, '幂等重放必须仍是 202（不是 409）');
  assert.equal(replay.body.data.id, jobId, '同键同体必须返回同一个作业（不得新建）');
  assert.equal((await turnsOf(fixture, conversationId)).length, 1, '重放不得产生第二条轮次');

  // 换键重试（真正的重试）：本次瞬时失败已恢复 ⇒ 新轮次成功。
  const retriedJobId = await accept(fixture, conversationId, 'retry-t2');
  assert.notEqual(retriedJobId, jobId, '换键必须是一次新的作业');
  const retried = await fixture.call('GET', `${JOBS}/${retriedJobId}`);
  assert.equal(retried.body.data.state, 'succeeded', '瞬时失败恢复后重试应能成功');
  assert.equal(retried.body.data.result.value.status, 'answered');

  const turns = await turnsOf(fixture, conversationId);
  assert.equal(turns.length, 2, '失败轮次 + 重试轮次：恰好各一条（不得重复、不得丢）');
  const byJob = new Map(turns.map((turn) => [turn.job_id, turn]));
  assert.equal(byJob.get(jobId).answer, null, '先前失败的轮次不得被后来的成功补写成有回答');
  assert.equal(byJob.get(retriedJobId).answer.status, 'answered');
});

// ---------------------------------------------------------------------------
// ④-模型侧上游失败：与检索失败**同口径**（本片补的正是这段 loop 级口径）
// ---------------------------------------------------------------------------
// 缺口现场：`conversation-chat-live.test.mjs:321-392` 只钉适配器把供应商状态映射成契约错误码，
// `:454-511` 只钉外发口的 reserve-then-send 与失败记账；上面三条用例只钉**检索**失败。
// 也就是"回答器（模型）抛错之后 loop 怎么结算"此前没有任何用例：错误码可能被折叠成
// `PROVIDER_UNAVAILABLE`、可能落出半截回答行、也可能把模型侧超时写成 `failed` —— 三种都是
// "静默做错"，客户端会因此拿到错误的可重试性判断（回退到 `settleCodeOf` 的兜底分支就长这样）。
const MODEL_QUOTA_ERROR = new ApiError('PROVIDER_QUOTA_EXCEEDED', '模拟供应商配额不足（测试替身）', {
  retryable: true,
});
const MODEL_TIMEOUT_ERROR = new ApiError('PROVIDER_TIMEOUT', '模拟供应商超时（测试替身）', { retryable: true });

test('模型上游失败 ⇒ failed/timed_out 且错误码原样透出、零回答行；恢复后重试恰好新增一条（旧失败轮次不被补写）', async (t) => {
  const calls = [];
  const script = [MODEL_QUOTA_ERROR, MODEL_TIMEOUT_ERROR];
  const fixture = await conversationFixture(t, {
    injection: {
      ...flakyRetrieval(0),
      // 真实模型的替身：前两次按脚本失败，恢复后扮演"守规矩的模型"（只引用它从本次检索集合里读到的条目）。
      composer: {
        async compose(input) {
          calls.push(input);
          const step = script[calls.length - 1];
          if (step !== undefined) throw step;
          const only = input.set.items[0];
          return { text: `（替身模型已恢复）依据检索条目的回答：${only.title}`, citations: [only.source], dose_cards: [] };
        },
      },
    },
  });
  const created = await fixture.createConversation({}, { tag: 'model' });
  const conversationId = created.body.data.id;

  // ① 供应商配额不足：`failed` + **原样**错误码（不得折成 PROVIDER_UNAVAILABLE）
  const quotaJobId = await accept(fixture, conversationId, 'model-t1');
  const quota = await fixture.call('GET', `${JOBS}/${quotaJobId}`);
  assert.equal(quota.status, 200, `失败作业的读面必须仍是 200（不得 5xx）：${JSON.stringify(quota.body)}`);
  assert.equal(quota.body.data.state, 'failed');
  assert.equal(
    quota.body.data.error_code,
    'PROVIDER_QUOTA_EXCEEDED',
    '模型侧错误码必须原样透出（折叠成 PROVIDER_UNAVAILABLE 会把"稍后重试可能成功"说成"供应商不可用"）',
  );
  assert.notEqual(quota.body.data.error_code, 'PROVIDER_UNAVAILABLE');
  assert.equal(quota.body.data.result, null, '模型失败不得携带任何回答或半截引用');
  assert.equal(typeof quota.body.data.deadline_at, 'string', '失败也保留截止时间：可重试性可被读完');
  assert.equal(fixture.conversationStore.snapshot().answers.length, 0, '模型失败不得落任何回答行');

  // ② 同键重放：同一个作业、不多出轮次、不把失败改写成排队/成功、也**不**再问一次模型
  fixture.clock.advance(1000);
  const replay = await fixture.createTurn(
    conversationId,
    await conversationRevision(fixture, conversationId),
    { input_type: 'text', text: QUESTION },
    { tag: 'model-t1' },
  );
  assert.equal(replay.status, 202, '幂等重放必须仍是 202');
  assert.equal(replay.body.data.id, quotaJobId, '同键同体必须返回同一个作业');
  assert.equal(replay.body.data.state, 'failed', '重放不得把已失败的作业改写');
  assert.equal((await turnsOf(fixture, conversationId)).length, 1, '重放不得新增轮次');
  assert.equal(calls.length, 1, '重放不得再次调用模型（失败不得被"顺手重试"）');

  // ③ 模型侧超时：`timed_out` + PROVIDER_TIMEOUT（与 `failed` 可区分，与"截止时间已过"同口径）
  const timeoutJobId = await accept(fixture, conversationId, 'model-t2');
  const timeout = await fixture.call('GET', `${JOBS}/${timeoutJobId}`);
  assert.equal(timeout.body.data.state, 'timed_out', '模型侧超时必须落 timed_out（不是 failed）');
  assert.equal(timeout.body.data.error_code, 'PROVIDER_TIMEOUT');
  assert.equal(timeout.body.data.result, null);
  assert.equal(fixture.conversationStore.snapshot().answers.length, 0, '超时同样不得落回答行');

  // ④ 恢复后真正的重试：成功恰好一条新轮次，引用只来自本次检索集合
  const retriedJobId = await accept(fixture, conversationId, 'model-t3');
  const retried = await fixture.call('GET', `${JOBS}/${retriedJobId}`);
  assert.equal(retried.body.data.state, 'succeeded', '模型恢复后重试应能成功');
  const answer = retried.body.data.result.value;
  assert.equal(answer.status, 'answered');
  assert.deepEqual(answer.citations, [ITEM.source], '成功轮次的引用必须恰好是本次集合那一条（不掺失败轮次的残留）');

  // ⑤ 落库与读面口径：失败/超时两轮零回答行、不被后来的成功补写
  const turns = await turnsOf(fixture, conversationId);
  assert.equal(turns.length, 3, '失败 + 超时 + 重试：恰好三条轮次（不重复、不丢）');
  const byJob = new Map(turns.map((turn) => [turn.job_id, turn]));
  assert.equal(byJob.get(quotaJobId).answer, null, '失败轮次不得被后来的成功补写成有回答');
  assert.equal(byJob.get(timeoutJobId).answer, null, '超时轮次同样不得被补写');
  assert.equal(byJob.get(retriedJobId).answer.status, 'answered');
  const snapshot = fixture.conversationStore.snapshot();
  assert.equal(snapshot.answers.length, 1, '两次失败零回答行 + 成功一行：恰好一行');
  assert.equal(snapshot.answers[0].turn_id, byJob.get(retriedJobId).id, '唯一的回答行必须挂在成功那一轮');
  assert.equal(snapshot.turns.filter((turn) => turn.job_state === 'failed').length, 1);
  assert.equal(snapshot.turns.filter((turn) => turn.job_state === 'timed_out').length, 1);
  assert.equal(snapshot.turns.find((turn) => turn.job_id === quotaJobId).job_error_code, 'PROVIDER_QUOTA_EXCEEDED');

  // ⑥ 反向对照：三次受理都真的走到了模型（否则本用例可能因问题被筛查阻断而空转）
  assert.equal(calls.length, 3, '三次受理各调用一次模型');
  for (const input of calls) {
    assert.notEqual(input.set, null, '模型失败发生在检索之后：回答器必须拿到检索集合');
    assert.equal(input.set.items.length, 1);
  }
  assert.equal(typeof calls[0].egress.objectId, 'string', '外发记账上下文必须随调用传入（失败要能归因到具体轮次）');
  const egressObjects = calls.map((input) => input.egress.objectId);
  assert.equal(new Set(egressObjects).size, 3, '三次调用必须各自归因到不同轮次（失败不得共享一个记账对象）');
  const egressRevisions = calls.map((input) => input.egress.objectRevision);
  for (const revision of egressRevisions) {
    assert.ok(Number.isInteger(revision) && revision >= 1, `轮次 revision 必须是正整数：${revision}`);
  }
  assert.deepEqual(
    [...egressRevisions].sort((left, right) => left - right),
    egressRevisions,
    '失败/超时/重试分别落在递增的轮次 revision 上（不得复用同一轮次）',
  );

  // ⑦ 成功之后不得回头改写先前两次失败的作业读面
  assert.equal((await fixture.call('GET', `${JOBS}/${quotaJobId}`)).body.data.state, 'failed');
  assert.equal((await fixture.call('GET', `${JOBS}/${timeoutJobId}`)).body.data.state, 'timed_out');
});

test('模型产出不可交付（空正文 / 契约外超长正文）⇒ 作业 failed、零回答行（半成品绝不落库）', async (t) => {
  /** 只换回答器（检索照常返回一条可用来源）：用来造"模型产出不可交付"的两种形态。 */
  const withComposer = (compose) => conversationFixture(t, {
    injection: { ...flakyRetrieval(0), composer: { compose } },
  });

  // 形态① 空正文却带结构化引用 ⇒ 守卫拒绝产出空回答（`guard.ts:413-416`）。
  const empty = await withComposer(async () => ({ text: '   ', citations: [ITEM.source], dose_cards: [] }));
  const emptyConversation = (await empty.createConversation({}, { tag: 'empty-answer' })).body.data.id;
  const emptyJobId = await accept(empty, emptyConversation, 'empty-t1');
  const emptyJob = await empty.call('GET', `${JOBS}/${emptyJobId}`);
  assert.equal(emptyJob.status, 200);
  assert.equal(emptyJob.body.data.state, 'failed', '空正文不得被结算成 succeeded');
  assert.equal(emptyJob.body.data.error_code, 'PROVIDER_UNAVAILABLE');
  assert.equal(emptyJob.body.data.result, null, '空正文不得以"有回答"的形式交付');
  assert.equal(empty.conversationStore.snapshot().answers.length, 0, '空正文不得落任何回答行（不落半成品）');
  assert.equal((await turnsOf(empty, emptyConversation))[0].answer, null);

  // 形态② 正文超出契约 `checked_text` 上限（16000）⇒ 落库前的契约形状闸门拒绝
  // （`service.ts:1024-1041` → `assertAnswerContract`）：**不**"先存下再想办法"。
  const tooLong = '合成正文'.repeat(4001);
  assert.ok(tooLong.length > 16000, '前置：正文确实超契约上限');
  const long = await withComposer(async () => ({ text: tooLong, citations: [ITEM.source], dose_cards: [] }));
  const longConversation = (await long.createConversation({}, { tag: 'long-answer' })).body.data.id;
  const longJobId = await accept(long, longConversation, 'long-t1');
  const longJob = await long.call('GET', `${JOBS}/${longJobId}`);
  assert.equal(longJob.body.data.state, 'failed', '契约外的正文不得被落库（也不得出现在 Turn.answer 里）');
  assert.equal(longJob.body.data.error_code, 'PROVIDER_UNAVAILABLE');
  assert.equal(longJob.body.data.result, null);
  assert.equal(long.conversationStore.snapshot().answers.length, 0, '契约形状过不了的回答绝不落库');
  assert.equal((await turnsOf(long, longConversation))[0].answer, null);
});

test('依据正文超长时显式标注节选（不得静默返回半截文本）', async (t) => {
  // 端口层判据：不超过上限逐字照搬，超过则必须带可读的节选标注。
  const short = '短正文';
  assert.equal(excerptOf(short), short, '不超过上限必须逐字照搬（不得改动既有正文）');
  const longBody = `${'稗'}_${'x'.repeat(COMPOSER_EXCERPT_MAX + 50)}`;
  const excerpt = excerptOf(longBody);
  assert.ok(excerpt.startsWith(longBody.slice(0, COMPOSER_EXCERPT_MAX)), '截断只能发生在上限处');
  assert.match(excerpt, /正文节选，原文更长/u, '截断必须有显式标注，不得静默');
  assert.ok(excerpt.length > COMPOSER_EXCERPT_MAX, '标注必须真的加在截断之后');

  const longItem = retrievalItem({
    id: '3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d',
    title: '合成资料丙：稗草的识别（长正文·测试替身）',
    body: `稗草的识别要点：${'合成正文'.repeat(200)}`,
  });
  assert.ok(longItem.body.length > COMPOSER_EXCERPT_MAX, '前置：正文确实超长');
  const composer = createDeterministicAnswerComposer();
  const composed = composer.compose({
    question: QUESTION,
    conditions: null,
    set: retrievalSet('11111111-1111-4111-8111-111111111111', [longItem]),
  });
  assert.match(composed.text, /正文节选，原文更长/u, '回答正文里也必须能看出"这是节选"');

  // 端到端：经过守卫后 `checked_text` 仍然带着这个标注（不得被后续环节抹掉）。
  const fixture = await conversationFixture(t, {
    injection: {
      retrieval: createWiredRetrievalPort({
        note: '测试替身检索端口：长正文条目',
        read: async (input) => retrievalSet(input.identity.userId, [longItem]),
      }),
    },
  });
  const created = await fixture.createConversation({}, { tag: 'excerpt' });
  const jobId = await accept(fixture, created.body.data.id, 'excerpt-t1');
  const job = await fixture.call('GET', `${JOBS}/${jobId}`);
  const answer = job.body.data.result.value;
  assert.equal(answer.status, 'answered');
  assert.match(answer.checked_text, /正文节选，原文更长/u);
  assert.ok(t);
});

// ---------------------------------------------------------------------------
// ⑤ 数据最小化：响应与日志都不回显令牌 / 内部主键 / openid / 手机号
// ---------------------------------------------------------------------------

// 手机号判据：**独立 token 边界**，不是「前一位不是数字」。
//
// 旧口径 `(?<!\d)…(?!\d)` 只排数字邻居，**没排字母**：服务端 id 是 `crypto.randomUUID()`，末段是
// 12 位十六进制，`…-16271493087d` / `…-f14298666267`（11 位数字紧邻字母）这类片段会被判成手机号
// ⇒ 本文件既有 flaky（PR #322 首跑红、同 SHA 重跑绿；「响应」「日志」两条断言是同一缺陷，父提交
// `47fe028` 在 `:264`/`:286`；本文件的对应行号会随插入漂移，不在此钉死）。R28-S12 探针实测：
// 20 万个随机 UUID 旧口径误命中 62 个（0.031%）；一次扫描面含 13 个 id（21 处出现），实测 400 次
// 扫描面重跑有 4 次假红（响应面 1.0%）。
//
// 收紧依据：手机号在 JSON / 日志里永远是**独立 token**（`"phone":"138…"`、`contact=138…`、
// `tel:138…`、中文行文里），字段值两侧必是引号/冒号/等号/空白/中文；而标识符片段两侧必然是
// `[0-9A-Za-z_]`。因此把边界从「非数字」收紧为「非标识符字符」，前后两侧同时收紧。
// 取舍：`a13812345678b`、`tel13812345678` 这类紧贴 ASCII 字母的 11 位数字**故意**不命中——它只
// 可能来自十六进制/UUID/哈希片段，不可能是任何真实响应/日志里的手机号字段值（逐字钉在
// 「手机号判据的边界」用例里）。
const PHONE_RE = /(?<![0-9A-Za-z_])1[3-9]\d{9}(?![0-9A-Za-z_])/u;
/**
 * 扫描前的一次性归一化（R28-S12 / E7）：把文本里的**转义序列** `\n` `\r` `\t` 还原成空白，再交给
 * `PHONE_RE`。原因：`JSON.stringify` 之后，「行首手机号」在文本里是「反斜杠 + n/t/r」，紧贴号码前
 * 的是字母 `n`/`t` ⇒ token 边界会把真实手机号误判成「标识符内部」而漏报（旧口径 `(?<!\d)` 反而
 * 能抓到，所以这是收紧后必须补上的窄缺口）。
 *
 * 只替换**反斜杠转义**，不改 `PHONE_RE` 本身、不放宽边界：换进来的是分隔符（空格），不是字母/数字，
 * 因此 `a13812345678b` / `_13812345678` / `13812345678_` / 随机 UUID 归一化后仍必须不命中。
 */
const normalizeScanText = (text) => text.replace(/\\[nrt]/gu, ' ');
/** 旧口径（缺陷版本）：**只**用于反向对照——证明语料里确实含会被它误命中的形态。 */
const WIDE_PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/u;
/** 随机标识符形状（uuid，服务端 id 的真实来源）：用于「扫描面确实含标识符」的反向对照。 */
const UUID_SHAPE_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u;

/**
 * 确定性 uuid-v4 形态语料（固定种子）：给「随机标识符不得被判成手机号」一个可复现的量化面。
 * 形状与 `crypto.randomUUID()` 一致：8-4-4-4-12 小写十六进制，version=4、variant∈8/9/a/b。
 */
function deterministicUuids(count) {
  let state = 0x9e3779b9;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const ids = new Array(count);
  for (let i = 0; i < count; i += 1) {
    let compact = '';
    for (let k = 0; k < 32; k += 1) compact += (next() >>> 28).toString(16);
    compact = `${compact.slice(0, 12)}4${compact.slice(13, 16)}${'89ab'[next() % 4]}${compact.slice(17)}`;
    ids[i] = `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
  }
  return ids;
}

/** 七个 operation 的响应全文（含头）拼起来，逐类敏感值扫描。 */
async function sweepResponses(fixture) {
  const chunks = [];
  const record = (response) => {
    chunks.push(JSON.stringify(response.body));
    chunks.push(JSON.stringify({ etag: response.etag, cache: response.cache, cascade: response.cascade }));
    return response;
  };

  const created = record(await fixture.createConversation(
    { conditions: { crop_id: 'rice', region_code: '330100' } },
    { tag: 'min' },
  ));
  assert.equal(created.status, 201);
  const conversationId = created.body.data.id;

  record(await fixture.call('GET', CONVERSATIONS));
  record(await fixture.call('GET', `${CONVERSATIONS}/${conversationId}`));

  fixture.clock.advance(1000);
  const accepted = record(await fixture.createTurn(conversationId, 1, { input_type: 'text', text: QUESTION }, {
    tag: 'min-t1',
  }));
  assert.equal(accepted.status, 202);
  record(await fixture.call('GET', `${JOBS}/${accepted.body.data.id}`));
  record(await fixture.call('GET', `${CONVERSATIONS}/${conversationId}/turns`));

  const turn = (await turnsOf(fixture, conversationId))[0];
  record(await fixture.call('DELETE', `${CONVERSATIONS}/${conversationId}/turns/${turn.id}`, fixture.a, {
    headers: { 'idempotency-key': 'idem-min-del-turn', 'if-match': `"${turn.revision}"` },
  }));
  record(await fixture.call('DELETE', `${CONVERSATIONS}/${conversationId}`, fixture.a, {
    headers: { 'idempotency-key': 'idem-min-del-conv', 'if-match': `"${created.body.data.revision}"` },
  }));
  return chunks.join('\n');
}

test('数据最小化（响应）：七个 operation 的响应不回显令牌、owner_id、openid、手机号', async (t) => {
  const fixture = await conversationFixture(t, { injection: flakyRetrieval(0) });
  const text = await sweepResponses(fixture);

  assert.equal(text.includes(fixture.a.token), false, '响应里不得出现 bearer 令牌');
  assert.equal(text.includes(fixture.a.user.id), false, '响应里不得出现内部主体主键（owner id）');
  assert.equal(text.includes('owner_id'), false, '响应里不得出现内部列名 owner_id');
  assert.equal(text.includes('openid'), false, '响应里不得出现 openid');
  assert.equal(PHONE_RE.test(normalizeScanText(text)), false, '响应里不得出现手机号');
  // 反向对照：扫描面确实覆盖到了真实响应（否则上面的"未命中"是空断言）。
  assert.ok(text.includes(QUESTION), '扫描面必须包含真实请求正文（证明扫的是真响应）');
  assert.ok(text.includes('cjk-bigram+word-match'), '扫描面必须包含回答正文（证明扫到了回答）');
  // 反向对照：扫描面确实含服务端随机标识符（收紧 token 边界后，上面这条"未命中"才有意义）。
  assert.ok(UUID_SHAPE_RE.test(text), '扫描面必须含随机标识符（否则收紧边界后的未命中是空断言）');
});

test('数据最小化（日志）：info 级日志不回声令牌/owner_id/openid/手机号；问答域源码无日志调用', async (t) => {
  const chunks = [];
  const fixture = await conversationFixture(t, {
    injection: flakyRetrieval(0),
    logLevel: 'info',
    logStream: { write(chunk) { chunks.push(String(chunk)); } },
  });
  await sweepResponses(fixture);
  const logs = chunks.join('');

  assert.ok(logs.length > 0, '前置：info 级确实产生了日志（否则本条是空断言）');
  assert.equal(logs.includes(fixture.a.token), false, '日志里不得出现 bearer 令牌');
  assert.equal(logs.includes(fixture.a.user.id), false, '日志里不得出现内部主体主键');
  assert.equal(logs.includes('owner_id'), false, '日志里不得出现内部列名 owner_id');
  assert.equal(logs.includes('openid'), false, '日志里不得出现 openid');
  assert.equal(logs.includes('authorization'), false, '日志里不得出现授权头字段');
  assert.equal(PHONE_RE.test(normalizeScanText(logs)), false, '日志里不得出现手机号');
  // 反向对照：日志确实含服务端随机标识符（收紧 token 边界后，上面这条"未命中"才有意义）。
  assert.ok(UUID_SHAPE_RE.test(logs), '日志扫描面必须含随机标识符（否则未命中是空断言）');

  // 静态判据：问答域**根本没有**日志调用 ⇒ 不存在"忘了脱敏"的面（比事后脱敏更强）。
  const root = 'services/api/src/conversations';
  const files = readdirSync(root).filter((name) => name.endsWith('.ts'));
  assert.ok(files.length >= 10, `前置：问答域源码文件应被枚举到：${files.length}`);
  const sources = [
    ...files.map((name) => ({ path: join(root, name), code: readFileSync(join(root, name), 'utf8') })),
    { path: 'services/api/src/routes/conversations.ts', code: readFileSync('services/api/src/routes/conversations.ts', 'utf8') },
  ];
  for (const source of sources) {
    assert.doesNotMatch(source.code, /console\s*\./u, `${source.path} 不得有 console 调用`);
    assert.doesNotMatch(source.code, /request\s*\.\s*log\s*\./u, `${source.path} 不得把请求/身份写日志`);
    assert.doesNotMatch(source.code, /app\s*\.\s*log\s*\./u, `${source.path} 不得把请求/身份写日志`);
  }
});

// ---------------------------------------------------------------------------
// ⑥ 手机号判据的边界（R28-S12）：真手机号必红、随机标识符必绿
// ---------------------------------------------------------------------------
//
// 本片修的是**判据**，不是产品行为：产品仍然不得回显手机号（父提交 `:264`/`:286` 两条断言一条未减，
// 「响应」「日志」两侧都扫，只是把 `PHONE_RE` 的 token 边界收紧 + 扫描前归一化 JSON 转义）。
// 这里把「什么算手机号」双向钉死，防两个方向回退：
//   1) 收得过头 ⇒ 真手机号漏判（下面 leaked 表必须全部命中）；
//   2) 收得不够 ⇒ 随机标识符又被判成手机号（下面 identifiers 表 + N=100000 语料必须全部不命中）。
test('手机号判据的边界：真手机号必命中、随机标识符必不命中（旧口径在同一语料上会误命中）', () => {
  // 1) 真实泄漏形态：手机号是独立 token（JSON 值 / 查询或表单 / 中文行文里）。
  const leaked = [
    '"phone":"13812345678"',
    '"phone":"19900001111","x"',
    'contact=13812345678',
    'tel:13812345678',
    '手机号13812345678已登记',
    '{"a":1,"phone":13812345678}',
  ];
  for (const text of leaked) {
    assert.equal(PHONE_RE.test(text), true, `真手机号必须命中（否则收紧过头）：${text}`);
  }

  // 2) 随机标识符与「紧贴 ASCII 标识符字符」的片段：**故意**不命中。
  //    `a13812345678b` 的前后都是十六进制字符 ⇒ 它只可能是 UUID/哈希片段，不可能是手机号字段值；
  //    若把它判成手机号，就会把 `…-16271493087d` 这类真 id 判成泄漏（本文件既有 flaky 的根因）。
  const identifiers = [
    '9f1c7a52-3b4d-4e88-9a10-2c5d6e7f8a90',
    '3902e459-54cd-4036-a8c4-16271493087d',
    '5dc7bb9-5f56-4095-a3d0-f14298666267',
    'd41d8cd98f00b204e9800998ecf8427e',
    '1e19412284915f8b',
    'a13812345678b',
    '_13812345678',
    '13812345678_',
  ];
  for (const text of identifiers) {
    assert.equal(PHONE_RE.test(text), false, `标识符/贴边形态不得判成手机号（否则又回到既有 flaky）：${text}`);
  }

  // 3) JSON 转义形态（R28-S12 / E7）：`JSON.stringify` 之后，「行首手机号」前一位是转义序列的字母
  //    `n`/`t`/`r`，直接扫会被 token 边界判成「标识符内部」而漏报；归一化后必须命中。
  //    同时验证归一化**没有**把贴边形态打回旧口径的假阳。
  const escapedForms = [
    '{"note":"x\\n13812345678"}',
    '{"note":"x\\t13812345678"}',
    '{"note":"x\\r13812345678"}',
  ];
  for (const text of escapedForms) {
    assert.equal(PHONE_RE.test(text), false, `原始转义文本会被 token 边界挡住（E7 的缺口现场）：${text}`);
    assert.equal(
      PHONE_RE.test(normalizeScanText(text)),
      true,
      `转义序列归一化后必须命中真手机号（否则行首号码漏报）：${text}`,
    );
  }
  const stillCleanAfterNormalize = [
    'a13812345678b',
    '_13812345678',
    '13812345678_',
    '9f1c7a52-3b4d-4e88-9a10-2c5d6e7f8a90',
  ];
  for (const text of stillCleanAfterNormalize) {
    assert.equal(
      PHONE_RE.test(normalizeScanText(text)),
      false,
      `归一化不得把标识符/贴边形态判回手机号：${text}`,
    );
  }

  // 4) 量化面：N=100000 个同形态（uuid v4、固定种子 ⇒ 可复现）标识符。
  //    这是**回退探测器**，不是随机采样证据：uuid 形状下任何 11 位数字窗口的两端邻居至少有一个是
  //    十六进制字符（数字或 a–f，都属 `[0-9A-Za-z_]`），新口径**不可能**命中 ⇒ `tightHits === 0`
  //    对 uuid 语料结构恒真。它真正能抓的是「有人把 PHONE_RE 退回旧宽口径」：同一语料上 24 命中 ⇒ 立刻红。
  //    先证语料非空：旧口径必须在这批语料上命中 >0，否则「新口径 0 命中」可能只是语料里根本没有
  //    该形态的空断言。
  const corpus = deterministicUuids(100000);
  const wideHits = corpus.filter((id) => WIDE_PHONE_RE.test(id)).length;
  const tightHits = corpus.filter((id) => PHONE_RE.test(id)).length;
  const normalizedTightHits = corpus.filter((id) => PHONE_RE.test(normalizeScanText(id))).length;
  assert.ok(wideHits > 0, `反向对照：旧口径在 N=100000 同形态标识符上必须有命中（实测 ${wideHits}）`);
  assert.equal(tightHits, 0, `新口径不得把任何随机标识符判成手机号（N=100000，实测 ${tightHits}）`);
  assert.equal(
    normalizedTightHits,
    0,
    `归一化后同样不得把随机标识符判成手机号（N=100000，实测 ${normalizedTightHits}）`,
  );
});
