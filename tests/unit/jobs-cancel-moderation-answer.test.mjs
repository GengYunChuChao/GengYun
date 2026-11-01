/**
 * GY-R71 取消片 · **`moderation` 与 `answer` 两源的真取消回归**（真实回环 HTTP，动态空闲端口）。
 *
 * 基线事实（本片取证）：`upstream/main` = `8b646ae1` 时注册表的六源里只有四个带 `cancel`
 * （识别/转写/合成/OCR）；`moderation` 与 `answer` 缺 `cancel` ⇒ 注册表先确认作业存在，
 * 再以契约 503 `PROVIDER_UNAVAILABLE`「该作业所属能力尚未提供取消」拒绝
 * （`services/api/src/jobs/registry.ts` 的 `cancel` 分支）。本片给这两源补上 `cancel`。
 *
 * 本文件钉住的东西（五组 × 两源，逐组断**状态码 + 契约错误码**）：
 *   ① 取消成功：200 且 `state === 'cancelled'`、`revision` 恰好 +1、`result === null`；
 *   ② 重复取消：同键重放回放首次结果（200）；已 `cancelled` 且 `If-Match` = 当前 revision ⇒ 200
 *      且**不再迁移**（revision 不变）；持旧 revision ⇒ 409 `REVISION_CONFLICT`；
 *   ③ 取消已终态（`succeeded`）⇒ 409 `OBJECT_UNAVAILABLE`（不假装取消成功、状态不变）；
 *   ④ 取消不存在 ⇒ 404 `NOT_FOUND`；
 *   ⑤ 取消他人作业 ⇒ 404 `NOT_FOUND`，且与 ④ 的 `error` 封套**逐字段同形**（不泄露存在性）。
 *
 * **关键断言（"真取消"的判据，不是日志）**——取消之后**源表没有新增结论行**：
 *   - `answer`：取消后放行被阻塞的回答器并 `drain()`，`conversation_answers` 既不新增行、
 *     该轮次读回的 `answer` 仍为 `null`（`store.snapshot().answers` 计数不变 + `findTurnByJobId`）；
 *   - `moderation`：取消后投递一条**逐字段合法、签名有效**的供应商回调，回调被
 *     `CALLBACK_JOB_TERMINAL` 拒收，台账行数不变、`decision` 仍是 `pending`、`contract_value` 仍是
 *     `null`。**同一份回调**投给未取消的同形任务则被接受（正向对照：拒收的原因是取消，不是信封不合规）。
 *
 * 声明（如实）：模型/审核端口全部是**合成替身**（`provider.synthetic === true`），**不发任何网络请求**、
 * 不持有凭据、不读环境变量；本文件的读数为**本机回环**，不代表真实供应商能力或准确率。
 * 端口一律 `port: 0`（动态空闲口），每个用例 `t.after` 关闭；文件末尾另有一条实测"关闭后 connect 被拒"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';
import { createWiredRetrievalPort } from '../../services/api/src/conversations/guard.ts';
import {
  CLEAN_TEXT,
  countingPort,
  envelopeForTask,
  makeHarness,
  signedCallback,
  textContent,
} from '../moderation/_http-fixtures.mjs';

const API = '/api/v1';
const JOBS = `${API}/jobs`;
const START = Date.UTC(2026, 9, 30, 2, 0, 0);
const QUESTION = '稻田杂草怎么防除';

let keySeq = 0;
const nextKey = (label) => `gy-r71-${label}-${String((keySeq += 1)).padStart(4, '0')}`;

/** 合成检索端口：集合恒为空（本片只关心作业状态机与"是否落库回答"，不关心回答内容）。 */
function emptyRetrieval() {
  return createWiredRetrievalPort({
    note: 'GY-R71 测试替身检索端口：集合恒为空，不查资料库',
    read: async () => null,
  });
}

/**
 * **可控回答器**：`compose` 在 `blocking` 为真时挂起，直到用例显式放行。
 * 用途：把 answer 作业稳定停在 `running`（= 真的"在途"），从而可以在结算之前取消。
 */
function gatedComposer() {
  const waiters = [];
  let blocking = true;
  const compose = async () => {
    if (!blocking) return { text: '', citations: [], dose_cards: [] };
    await new Promise((resolve) => waiters.push(resolve));
    return { text: '', citations: [], dose_cards: [] };
  };
  return {
    composer: { kind: 'deterministic_guard_only', note: 'GY-R71 测试替身：compose 可被挂起', compose },
    /** 放行当前在途调用（之后的调用仍会阻塞）。 */
    releasePending() {
      while (waiters.length > 0) waiters.shift()();
    },
    /** 彻底放行（之后的调用不再阻塞）。 */
    releaseAll() {
      blocking = false;
      while (waiters.length > 0) waiters.shift()();
    },
  };
}

async function makeFixture(t, options = {}) {
  const auth = createMemoryAuthStore();
  const config = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
  const conversationStore = createMemoryConversationStore();
  const tms = countingPort('tms');
  const moderation = makeHarness({ ports: { tms: tms.port } });
  const gate = options.gate ?? gatedComposer();
  const app = buildApp({
    config,
    store: auth,
    now: () => new Date(START),
    moderationInjection: { service: moderation.service },
    conversationInjection: { store: conversationStore, composer: gate.composer, retrieval: emptyRetrieval() },
  });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const port = Number(new URL(origin).port);

  const account = async (seed) => {
    const user = await auth.createUser(seed.repeat(64));
    const token = `synthetic-r71-token-${seed}`;
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
      cache: response.headers.get('cache-control'),
    };
  };
  t.after(async () => {
    await app.close();
  });
  return { app, auth, a, b, call, origin, port, moderation, conversationStore, tms, gate };
}

/** 等到作业进入指定状态（回答器被挂起时用于观察 `running`）。 */
async function waitForJobState(h, jobId, state, actor = h.a) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const read = await h.call('GET', `${JOBS}/${jobId}`, actor);
    if (read.status === 200 && read.body.data.state === state) return read;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`作业 ${jobId} 未在预期时间内进入 ${state}`);
}

const cancelHeaders = (ifMatch, key) => ({ 'idempotency-key': key, 'if-match': ifMatch });

// ===========================================================================
// answer 源（kind=answer，域内实现 conversations/service.ts 的 cancelTurn）
// ===========================================================================

/** 受理一轮文字问答并把作业停在 `running`（回答器被挂起）。 */
async function answerJobRunning(h, tag) {
  const created = await h.call('POST', `${API}/conversations`, h.a, {
    headers: { 'idempotency-key': nextKey(`conv-${tag}`) },
    payload: {},
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const conversationId = created.body.data.id;
  const turn = await h.call('POST', `${API}/conversations/${conversationId}/turns`, h.a, {
    headers: { 'idempotency-key': nextKey(`turn-${tag}`), 'if-match': '"1"' },
    payload: { input_type: 'text', text: QUESTION },
  });
  assert.equal(turn.status, 202, JSON.stringify(turn.body));
  const jobId = turn.body.data.id;
  assert.equal(turn.body.data.state, 'queued');
  // 受理 → running 是既有状态机（claimTurnJob），取消窗口就是这一段。
  const running = await waitForJobState(h, jobId, 'running');
  assert.equal(running.etag, '"2"', 'running 的 revision 必须恰好是 2（受理 1 + 认领 1）');
  return { conversationId, jobId };
}

test('answer·① 取消成功：200 + cancelled + revision 恰好 +1 + result=null，且**源表不新增回答行**（真取消）', async (t) => {
  const h = await makeFixture(t);
  const { jobId } = await answerJobRunning(h, 'ok');
  const answersBefore = h.conversationStore.snapshot().answers.length;
  assert.equal(answersBefore, 0, '受理后、结算前不得有回答行');

  const cancelled = await h.call('POST', `${JOBS}/${jobId}/cancel`, h.a, {
    headers: cancelHeaders('"2"', nextKey('cancel-ok')),
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.data.kind, 'answer');
  assert.equal(cancelled.body.data.state, 'cancelled');
  assert.equal(cancelled.body.data.revision, 3, 'revision 必须恰好 +1（2 → 3），不是 +2');
  assert.equal(cancelled.body.data.error_code, null, 'cancelled 不带失败原因');
  assert.equal(cancelled.body.data.result, null, 'cancelled 不得携带 result（无结论可投影）');
  assert.equal(cancelled.etag, '"3"');
  assert.equal(cancelled.cache, 'no-store');

  // 读面与取消面同源：GET 读到的就是刚取消的那一版。
  const read = await h.call('GET', `${JOBS}/${jobId}`, h.a);
  assert.equal(read.status, 200);
  assert.equal(read.body.data.state, 'cancelled');
  assert.equal(read.body.data.revision, 3);
  assert.equal(read.body.data.result, null);

  // ---- 关键断言：放行被阻塞的回答器，迟到的结算**不得**落库任何结论行 ----
  h.gate.releasePending();
  await h.app.conversationService.drain();
  assert.equal(
    h.conversationStore.snapshot().answers.length,
    answersBefore,
    '取消后源表（conversation_answers）不得新增结论行',
  );
  const afterDrain = await h.call('GET', `${JOBS}/${jobId}`, h.a);
  assert.equal(afterDrain.body.data.state, 'cancelled', '迟到的回答不得把作业复活成 succeeded/failed');
  assert.equal(afterDrain.body.data.revision, 3, '迟到的结算不得再改 revision');
  const turnAfter = await h.conversationStore.findTurnByJobId(jobId, h.a.user.id);
  assert.equal(turnAfter.answer, null, '该轮次不得有任何回答行');
});

test('answer·② 重复取消：同键重放 200（回放首次结果）；同一 revision 再取消 200 且**不再迁移**；旧 revision 409', async (t) => {
  const h = await makeFixture(t);
  const { jobId } = await answerJobRunning(h, 'idem');
  const key = nextKey('cancel-idem');
  const first = await h.call('POST', `${JOBS}/${jobId}/cancel`, h.a, { headers: cancelHeaders('"2"', key) });
  assert.equal(first.status, 200);
  assert.equal(first.body.data.revision, 3);

  // ① 同一 Idempotency-Key + 同一 If-Match 的原样重试 ⇒ 回放首次结果（不判 409、不执行第二次取消）。
  const replay = await h.call('POST', `${JOBS}/${jobId}/cancel`, h.a, { headers: cancelHeaders('"2"', key) });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.data.state, 'cancelled');
  assert.equal(replay.body.data.revision, 3, '重放不得再 +1');

  // ② 换新键、但 If-Match = **当前** revision ⇒ 幂等 no-op：200 且 revision 不变（不产生第二次迁移）。
  const noop = await h.call('POST', `${JOBS}/${jobId}/cancel`, h.a, { headers: cancelHeaders('"3"', nextKey('cancel-noop')) });
  assert.equal(noop.status, 200, JSON.stringify(noop.body));
  assert.equal(noop.body.data.state, 'cancelled');
  assert.equal(noop.body.data.revision, 3, '已 cancelled 的作业不得被"再取消一次"而涨 revision');

  // ③ 持**旧** revision（取消前那一版）⇒ 既有语义如实报版本冲突。
  const stale = await h.call('POST', `${JOBS}/${jobId}/cancel`, h.a, { headers: cancelHeaders('"2"', nextKey('cancel-stale')) });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.error.code, 'REVISION_CONFLICT');
  assert.equal(stale.body.error.retryable, false);
});

test('answer·③ 取消已终态（succeeded）⇒ 409 OBJECT_UNAVAILABLE，状态/revision 不变（不假装取消成功）', async (t) => {
  const h = await makeFixture(t);
  const { jobId } = await answerJobRunning(h, 'done');
  // 放行 → 既有结算路径把它推到 succeeded。
  h.gate.releaseAll();
  await h.app.conversationService.drain();
  const settled = await h.call('GET', `${JOBS}/${jobId}`, h.a);
  assert.equal(settled.body.data.state, 'succeeded');
  assert.equal(settled.body.data.revision, 3);
  const answersBefore = h.conversationStore.snapshot().answers.length;

  const rejected = await h.call('POST', `${JOBS}/${jobId}/cancel`, h.a, {
    headers: cancelHeaders(`"${settled.body.data.revision}"`, nextKey('cancel-done')),
  });
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error.code, 'OBJECT_UNAVAILABLE');
  assert.equal(rejected.body.error.retryable, false);

  const after = await h.call('GET', `${JOBS}/${jobId}`, h.a);
  assert.equal(after.body.data.state, 'succeeded', '拒绝取消不得改动状态');
  assert.equal(after.body.data.revision, 3, '拒绝取消不得改动 revision');
  assert.equal(after.body.data.result.kind, 'answer');
  assert.equal(h.conversationStore.snapshot().answers.length, answersBefore, '被拒绝的取消不得删/增结论行');
});

test('answer·④⑤ 取消不存在 404；取消他人作业 404 且与"不存在"**逐字段同形**；缺头 400/428', async (t) => {
  const h = await makeFixture(t);
  const { jobId } = await answerJobRunning(h, 'authz');

  const missing = await h.call('POST', `${JOBS}/${randomUUID()}/cancel`, h.a, {
    headers: cancelHeaders('"2"', nextKey('cancel-missing')),
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
  assert.equal(missing.body.error.retryable, false);

  const foreign = await h.call('POST', `${JOBS}/${jobId}/cancel`, h.b, {
    headers: cancelHeaders('"2"', nextKey('cancel-foreign')),
  });
  assert.equal(foreign.status, 404, '他人作业不可取消（与不存在同形，不泄露存在性）');
  assert.equal(foreign.body.error.code, 'NOT_FOUND');
  assert.deepEqual(foreign.body.error, missing.body.error, '他人作业与不存在的错误封套必须逐字段相同');

  // 越权请求不得改动归属者的作业。
  const still = await h.call('GET', `${JOBS}/${jobId}`, h.a);
  assert.equal(still.body.data.state, 'running', '被拒绝的越权取消不得改动作业状态');

  // 契约：`Idempotency-Key` 必填（缺 ⇒ 400）、`If-Match` 必填（缺 ⇒ 428）。
  const noKey = await h.call('POST', `${JOBS}/${jobId}/cancel`, h.a, { headers: { 'if-match': '"2"' } });
  assert.equal(noKey.status, 400, JSON.stringify(noKey.body));
  assert.equal(noKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  const noMatch = await h.call('POST', `${JOBS}/${jobId}/cancel`, h.a, { headers: { 'idempotency-key': nextKey('cancel-nomatch') } });
  assert.equal(noMatch.status, 428, JSON.stringify(noMatch.body));
  assert.equal(noMatch.body.error.code, 'REVISION_REQUIRED');
});

// ===========================================================================
// moderation 源（kind=moderation，域内实现 moderation/service.ts 的 cancelJob）
// ===========================================================================

/** 建一个"待回调"（`queued`）的审核任务——异步供应商路径，也是审核域唯一可取消的窗口。 */
async function deferredTask(h, content = textContent(), extra = {}) {
  const out = await h.moderation.service.submitScreening({
    actor: { userId: h.a.user.id, role: 'user', authEpoch: h.a.user.authEpoch },
    content,
    defer_model: true,
    ...extra,
  });
  const task = out.tasks[0];
  assert.equal(task.state, 'queued', '异步路径必须停在 queued（唯一可取消窗口）');
  assert.equal(task.decision, 'pending', '待回调任务没有结论');
  return task;
}

test('moderation·① 取消成功：200 + cancelled + job_revision 恰好 +1 + result=null，且**迟到回调落不了结论**（真取消）', async (t) => {
  const h = await makeFixture(t);
  const task = await deferredTask(h);
  const rowsBefore = h.moderation.ledger.history(task.target_ref).length;
  assert.equal(rowsBefore, 1, '送审即建一行任务');

  const cancelled = await h.call('POST', `${JOBS}/${task.job_id}/cancel`, h.a, {
    headers: cancelHeaders('"1"', nextKey('mod-cancel-ok')),
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.data.kind, 'moderation');
  assert.equal(cancelled.body.data.state, 'cancelled');
  assert.equal(cancelled.body.data.revision, 2, 'job_revision 必须恰好 +1（1 → 2）');
  assert.equal(cancelled.body.data.error_code, null);
  assert.equal(cancelled.body.data.result, null, 'cancelled 不得携带 ModerationResult');
  assert.equal(cancelled.etag, '"2"');

  // 取消**已落库**（内存台账同步、持久台账 flush）：读面读到的是已提交的 cancelled。
  const read = await h.call('GET', `${JOBS}/${task.job_id}`, h.a);
  assert.equal(read.body.data.state, 'cancelled');
  assert.equal(read.body.data.revision, 2);
  assert.equal(read.body.data.result, null);

  // ---- 关键断言：取消之后，一条**逐字段合法且签名有效**的回调也落不了结论 ----
  const late = await h.moderation.service.ingestCallback(signedCallback(envelopeForTask(task)));
  assert.equal(late.accepted, false, '取消后迟到回调必须被拒收（否则"取消"没阻止落库）');
  assert.deepEqual(late.reason_codes, ['CALLBACK_JOB_TERMINAL']);
  assert.equal(
    h.moderation.ledger.history(task.target_ref).length,
    rowsBefore,
    '取消后源表（moderation_decisions）不得新增结论行',
  );
  const rowAfter = h.moderation.ledger.byJobId(task.job_id);
  assert.equal(rowAfter.state, 'cancelled', '迟到回调不得复活任务');
  assert.equal(rowAfter.job_revision, 2, '迟到回调不得改 revision');
  assert.equal(rowAfter.decision, 'pending', '迟到回调不得补写结论（decision 仍是无结论）');
  assert.equal(rowAfter.contract_value, null, '迟到回调不得补写契约结论对象');
});

test('moderation·② 重复取消：同一 revision 再取消 200 且**不再迁移**；旧 revision 409；缺头 400/428', async (t) => {
  const h = await makeFixture(t);
  const task = await deferredTask(h);
  const first = await h.call('POST', `${JOBS}/${task.job_id}/cancel`, h.a, { headers: cancelHeaders('"1"', nextKey('mod-idem')) });
  assert.equal(first.status, 200);
  assert.equal(first.body.data.revision, 2);

  // 已 cancelled + If-Match = 当前 revision ⇒ 幂等 no-op（200、revision 不变）。
  // 本夹具**未注入**取消幂等台账（`makeHarness` 不传 `idempotency`）⇒ 走"未接线"分支，同键也不回放；接线后的回放见 `moderation-cancel-idempotency.test.mjs`（GY-R72）。
  const noop = await h.call('POST', `${JOBS}/${task.job_id}/cancel`, h.a, {
    headers: cancelHeaders('"2"', nextKey('mod-idem-again')),
  });
  assert.equal(noop.status, 200, JSON.stringify(noop.body));
  assert.equal(noop.body.data.state, 'cancelled');
  assert.equal(noop.body.data.revision, 2, '重复取消不得再涨 revision');

  // 持旧 revision（取消前那一版）⇒ 既有语义如实报版本冲突。
  const stale = await h.call('POST', `${JOBS}/${task.job_id}/cancel`, h.a, {
    headers: cancelHeaders('"1"', nextKey('mod-idem-stale')),
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.error.code, 'REVISION_CONFLICT');

  // 契约头缺失：与其它五源同形（400 / 428）——缺头在任何台账读写**之前**被拒，与是否回放无关。
  const noKey = await h.call('POST', `${JOBS}/${task.job_id}/cancel`, h.a, { headers: { 'if-match': '"2"' } });
  assert.equal(noKey.status, 400, JSON.stringify(noKey.body));
  assert.equal(noKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  const noMatch = await h.call('POST', `${JOBS}/${task.job_id}/cancel`, h.a, {
    headers: { 'idempotency-key': nextKey('mod-nomatch') },
  });
  assert.equal(noMatch.status, 428, JSON.stringify(noMatch.body));
  assert.equal(noMatch.body.error.code, 'REVISION_REQUIRED');
});

test('moderation·③ 取消已终态（succeeded）与已隔离（uncertain）⇒ 409 OBJECT_UNAVAILABLE，结论原样保留', async (t) => {
  const h = await makeFixture(t);
  // 同步路径：规则+模型已出结论 ⇒ 没有可取消的窗口。
  const out = await h.moderation.service.submitScreening({
    actor: { userId: h.a.user.id, role: 'user', authEpoch: h.a.user.authEpoch },
    content: textContent(),
  });
  const done = out.tasks[0];
  assert.equal(done.state, 'succeeded');

  const rejected = await h.call('POST', `${JOBS}/${done.job_id}/cancel`, h.a, {
    headers: cancelHeaders('"1"', nextKey('mod-done')),
  });
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error.code, 'OBJECT_UNAVAILABLE');
  assert.equal(rejected.body.error.retryable, false);

  const after = await h.call('GET', `${JOBS}/${done.job_id}`, h.a);
  assert.equal(after.body.data.state, 'succeeded', '拒绝取消不得改动状态');
  assert.equal(after.body.data.revision, 1, '拒绝取消不得改动 revision');
  assert.equal(after.body.data.result.kind, 'moderation', '已作出的结论必须原样保留');

  // 隔离（uncertain）同样是**已作出的判定**：取消它等于抹掉隔离事实 ⇒ 按既有 409 拒绝。
  const quarantined = await h.moderation.service.submitScreening({
    actor: { userId: h.a.user.id, role: 'user', authEpoch: h.a.user.authEpoch },
    content: textContent({ text: '', target_ref: { type: 'post', id: 'post-r71-iso', revision: 1 } }),
  });
  const isoTask = quarantined.tasks[0];
  assert.equal(isoTask.state, 'uncertain', JSON.stringify(isoTask.state));
  const denied = await h.call('POST', `${JOBS}/${isoTask.job_id}/cancel`, h.a, {
    headers: cancelHeaders(`"${isoTask.job_revision}"`, nextKey('mod-iso')),
  });
  assert.equal(denied.status, 409, JSON.stringify(denied.body));
  assert.equal(denied.body.error.code, 'OBJECT_UNAVAILABLE');
  const isoAfter = await h.call('GET', `${JOBS}/${isoTask.job_id}`, h.a);
  assert.equal(isoAfter.body.data.state, 'uncertain', '隔离事实不得被"取消"抹成 cancelled');
});

test('moderation·④⑤ 取消不存在 404；取消他人作业 404 且与"不存在"**逐字段同形**；正向对照证明回调本可落库', async (t) => {
  const h = await makeFixture(t);
  const task = await deferredTask(h);

  const missing = await h.call('POST', `${JOBS}/${randomUUID()}/cancel`, h.a, {
    headers: cancelHeaders('"1"', nextKey('mod-missing')),
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
  assert.equal(missing.body.error.retryable, false);

  const foreign = await h.call('POST', `${JOBS}/${task.job_id}/cancel`, h.b, {
    headers: cancelHeaders('"1"', nextKey('mod-foreign')),
  });
  assert.equal(foreign.status, 404, '他人作业不可取消（与不存在同形，不泄露存在性）');
  assert.equal(foreign.body.error.code, 'NOT_FOUND');
  assert.deepEqual(foreign.body.error, missing.body.error, '他人作业与不存在的错误封套必须逐字段相同');

  const still = await h.call('GET', `${JOBS}/${task.job_id}`, h.a);
  assert.equal(still.body.data.state, 'queued', '被拒绝的越权取消不得改动作业状态');

  // ---- 正向对照：**同一份**回调信封投给未取消的同形任务 ⇒ 被接受并落结论（0 → 1 行更新）----
  const control = await deferredTask(h, textContent({ target_ref: { type: 'post', id: 'post-r71-control', revision: 1 } }));
  const ok = await h.moderation.service.ingestCallback(signedCallback(envelopeForTask(control)));
  assert.equal(ok.accepted, true, JSON.stringify(ok));
  const controlRow = h.moderation.ledger.byJobId(control.job_id);
  assert.equal(controlRow.state, 'succeeded', '未取消的任务照常被回调推进（说明拒收的原因是取消，不是信封不合规）');
  assert.equal(typeof controlRow.contract_value, 'object', '未取消的任务照常落契约结论对象');
  assert.equal(CLEAN_TEXT.length > 0, true);
});

// ===========================================================================
// answer 的**持久实现**结算次序（无真库也能判：记录型假池）
// ===========================================================================

/**
 * GY-R71 取消片对 `store-pg.ts` 的必要修正：`settleTurnJob` 必须**先 CAS 抢状态、再插回答**。
 *
 * 反过来的次序（基线形态：先 `INSERT conversation_answers`、再 `UPDATE … WHERE job_state IN
 * ('queued','running')`）在取消竞态下会留下一条**孤儿回答行**：轮次停在 `cancelled`、`answer_id`
 * 为空，但源表已经多了一条结论 ⇒ 取消并没有真正阻止"落库结论"。
 *
 * 本用例用**记录型假池**在门禁内钉住这条次序（真库那条臂 `tests/integration/conversations-pg.mjs`
 * 需要真实 PostgreSQL，不在九条门禁里）：
 *   - 取消后再结算（CAS 返回 0 行）⇒ 返回 `null`，且**一条 `INSERT INTO conversation_answers` 都不发**；
 *   - 正常结算（CAS 返回 1 行）⇒ 返回已结算的轮次，且确实发了 INSERT（证明本夹具真的走到了插入路径，
 *     上面那条"没有 INSERT"不是空断言）。
 */
test('answer·PG 结算次序：CAS 拿不到（已取消）⇒ 零 INSERT；CAS 拿到 ⇒ 才 INSERT（同事务）', async () => {
  const { createPostgresConversationStore } = await import('../../services/api/src/conversations/store-pg.ts');
  const turnId = '11111111-1111-4111-8111-111111111111';
  const ownerId = '22222222-2222-4222-8222-222222222222';
  const conversationId = '33333333-3333-4333-8333-333333333333';
  const answerId = '44444444-4444-4444-8444-444444444444';
  const stamp = '2026-10-30T02:00:00.000Z';
  const turnRow = {
    id: turnId,
    conversation_id: conversationId,
    owner_id: ownerId,
    revision: 3,
    input_text: QUESTION,
    transcription_ref: null,
    job_id: '55555555-5555-4555-8555-555555555555',
    job_state: 'succeeded',
    job_deadline_at: stamp,
    job_created_at: stamp,
    job_error_code: null,
    answer_id: answerId,
    created_at: stamp,
    updated_at: stamp,
  };
  const answer = {
    id: answerId,
    turn_id: turnId,
    owner_id: ownerId,
    status: 'insufficient',
    checked_text: '',
    check_state: 'passed',
    citations: [],
    dose_cards: [],
    model_version: 'unimplemented:no-real-model/text-qa-deterministic',
    prompt_version: 'unimplemented:no-real-prompt/citation-guard-only',
    rule_version: 'unimplemented:no-real-rule/test',
    created_at: new Date(stamp),
  };

  /** 记录型假池：只按 SQL 的首段决定回传什么，不做任何真实数据库动作。 */
  function recordingPool(claimRows) {
    const statements = [];
    const decide = (text) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)$/.test(text) || text.startsWith('SET LOCAL')) return { rows: [] };
      // GY-R71 作业台账片在 `insertTurn` / `claimTurnJob` / `settleTurnJob` 的**同一事务**里写台账行
      // （`services/api/src/jobs/ledger.ts` 的 upsert，`INSERT INTO public.jobs … ON CONFLICT (id) DO UPDATE`），
      // 所以假池必须认得这条语句。它不改变本用例的任何断言：取消（CAS 0 行）之后仍然**一条**
      // `INSERT INTO conversation_answers` 都不许出现，正常结算里 CAS 仍必须排在插回答行之前。
      if (text.includes('INSERT INTO public.jobs')) return { rows: [] };
      if (text.includes('INSERT INTO conversation_answers')) return { rows: [{ id: answerId }] };
      // `answer_id = COALESCE(...)` 的语句也带 `RETURNING id`（列清单以 id 开头）⇒ 必须先判它。
      if (text.includes('UPDATE conversation_turns') && text.includes('answer_id = COALESCE')) return { rows: [turnRow] };
      if (text.includes('UPDATE conversation_turns') && text.includes('RETURNING id')) return { rows: claimRows };
      throw new Error(`假池收到未预期的 SQL：${text.slice(0, 80)}`);
    };
    const sql = {
      async query(text) {
        statements.push(text);
        return decide(text);
      },
    };
    return {
      statements,
      async query(text) {
        statements.push(text);
        return decide(text);
      },
      async connect() {
        return { query: sql.query, release() {} };
      },
    };
  }

  // ---- A：已被取消（CAS 0 行）⇒ 不插任何回答行 ----
  const deniedPool = recordingPool([]);
  const deniedStore = createPostgresConversationStore(deniedPool);
  const denied = await deniedStore.settleTurnJob({ turnId, ownerId, state: 'succeeded', errorCode: null, answer, at: new Date(stamp) });
  assert.equal(denied, null, '已取消的轮次不得被结算');
  assert.equal(
    deniedPool.statements.some((text) => text.includes('INSERT INTO conversation_answers')),
    false,
    '取消后**一条** conversation_answers 行都不许插（否则取消没阻止落库结论）',
  );

  // ---- B：正常结算（CAS 1 行）⇒ 才插回答行 ----
  const okPool = recordingPool([{ id: turnId }]);
  const okStore = createPostgresConversationStore(okPool);
  const settled = await okStore.settleTurnJob({ turnId, ownerId, state: 'succeeded', errorCode: null, answer, at: new Date(stamp) });
  assert.ok(settled !== null, 'CAS 拿到状态时必须完成结算');
  assert.equal(settled.answer_id, answerId);
  assert.equal(settled.job_state, 'succeeded');
  const insertIndex = okPool.statements.findIndex((text) => text.includes('INSERT INTO conversation_answers'));
  const claimIndex = okPool.statements.findIndex((text) => text.includes('RETURNING id'));
  assert.ok(insertIndex > 0, '正常结算必须真的插入回答行（证明断言 A 不是空断言）');
  assert.ok(claimIndex > 0 && claimIndex < insertIndex, '次序必须是"先 CAS 抢状态，再插回答行"');
});

// ===========================================================================
// 收工实测：端口释放
// ===========================================================================
test('收工：动态端口在 close 之后确实不再监听（connect 被拒）', async () => {
  const auth = createMemoryAuthStore();
  const config = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
  const app = buildApp({ config, store: auth, now: () => new Date(START) });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const probe = await fetch(`${origin}/api/v1/health`);
  assert.ok(probe.status === 200 || probe.status === 404, `监听期间应可连接（实际 ${probe.status}）`);
  await app.close();
  await assert.rejects(
    () => fetch(`${origin}/api/v1/health`),
    (error) => error instanceof TypeError || error?.cause !== undefined,
    'close 之后同一端口必须拒绝连接（端口已释放）',
  );
});
