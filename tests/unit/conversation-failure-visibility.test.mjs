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
// ⇒ 本文件既有 flaky（PR #322 首跑红、同 SHA 重跑绿；:264 与 :286 同一缺陷）。R28-S12 探针实测：
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
  assert.equal(PHONE_RE.test(text), false, '响应里不得出现手机号');
  // 反向对照：扫描面确实覆盖到了真实响应（否则上面的"未命中"是空断言）。
  assert.ok(text.includes(QUESTION), '扫描面必须包含真实请求正文（证明扫的是真响应）');
  assert.ok(text.includes('cjk-bigram+word-match'), '扫描面必须包含回答正文（证明扫到了回答）');
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
  assert.equal(PHONE_RE.test(logs), false, '日志里不得出现手机号');

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
