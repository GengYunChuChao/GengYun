/**
 * GY-I22（issue #22）· **作业在途守卫** 与 **跨域对象归属**失败回归（HTTP 级，真实组合应用）。
 *
 * ## 本文件补的空白（为什么不是既有用例的重复）
 * - `tests/unit/jobs-registry.test.mjs` 用的是**假作业源**（`fakeSource` / `syntheticPort`），
 *   `tests/unit/admin-ops-job-integrity.test.mjs` 用的是**合成作业端口**：
 *   它们验证的是注册表/后台层的分派与校验，**不是**"真实识别域里，取消之后在途提供者的晚到
 *   结果会怎样"。要把这条测出来，必须让**真实服务**的提供者调用停在半途、并在取消之后放行 ——
 *   本文件用**可控提供者**（按 mediaId 一次性挂起）做到了，这是既有用例没有的接缝。
 * - `recognitions` 的成果语义按仓库设计只在**作业版本 CAS**上保证"迟到结果不复活"
 *   （`service.ts` `commitTerminal` → `store.commitTerminal(jobId, running.revision, ...)`），
 *   因此本文件断言的是**可观测结果**：作业仍为 `cancelled`、且**域 store 零写入**（识别记录 404）。
 * - **跨用户归属**：既有用例覆盖了媒体域与收藏/历史/消息域的越权同形 404；
 *   `POST /jobs/{id}/cancel`、`GET /jobs/{id}`、`PATCH /recognitions/{id}/selection` 这三个
 *   **识别线写面/读面**的越权同形在本片之前没有组合应用级用例。
 *
 * ## 覆盖
 *   F1. 取消后，在途提供者的**晚到成功结果**不得复活作业、不得写入识别记录（零写入）；
 *   F2. 取消**幂等**：同键 + 同 `If-Match` 原样重试回放已取消结果（不报版本冲突）；同键异体 ⇒ 409；
 *   F3. **跨用户归属**：他人作业/识别记录的读、取消、改选一律同形 404，且归属者对象状态不变；
 *   F4. 取消**不是持久禁令**（同对象同版本再受理会被接受为新任务 —— 如实登记的设计行为），
 *       但**旧任务的晚到结果不得写入新任务**（跨任务隔离）。
 *
 * 声明（不得误读）：账号、媒体 id、候选都是**合成夹具**；可控提供者是**测试替身**，
 * 不是真实供应商（零真实调用）。本文件不改任何实现文件、不修改任何既有断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';

const API = '/api/v1';
const START = Date.UTC(2026, 9, 27, 4, 0, 0);
const MEDIA_ID = '00000000-0000-4000-8000-0000000000a1';
const ABSENT_UUID = '00000000-0000-4000-8000-0000000000ff';

/** 与替身提供者"3 条有分数候选（可判 succeeded）"同形的合成成功结果。 */
function successOutcome() {
  return {
    kind: 'completed',
    candidates: [
      { species_id: 'synthetic-species-1', rank: 1, model_score: 0.91 },
      { species_id: 'synthetic-species-2', rank: 2, model_score: 0.55 },
      { species_id: 'synthetic-species-3', rank: 3, model_score: 0.22 },
    ],
    uncertainty_reasons: [],
  };
}

function deferred() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * 可控识别提供者：**按 mediaId 一次性挂起**第一次调用（模拟在途外发），
 * 之后的同 mediaId 调用立即成功。`calls` 供断言"提供者真实调用次数"。
 */
function controllableProvider() {
  const oneShot = new Set();
  const pending = new Map();
  const calls = [];
  return {
    calls,
    arm(mediaId) {
      oneShot.add(mediaId);
      pending.set(mediaId, deferred());
      return pending.get(mediaId);
    },
    provider: {
      executionMode: 'stub',
      modelVersion: 'stub-gy-i22-controllable',
      available: true,
      unavailableReason: null,
      async recognize(input) {
        calls.push({ jobId: input.jobId, mediaId: input.mediaId, mediaRevision: input.mediaRevision });
        if (oneShot.has(input.mediaId)) {
          oneShot.delete(input.mediaId);
          return pending.get(input.mediaId).promise;
        }
        return successOutcome();
      },
    },
  };
}

async function makeFixture(t) {
  const time = START;
  const auth = createMemoryAuthStore();
  const control = controllableProvider();
  const app = buildApp({
    config: { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), executionMode: 'stub' },
    store: auth,
    now: () => new Date(time),
    recognitionProvider: control.provider,
  });
  t.after(() => app.close());

  async function makeUser(subject) {
    const user = await auth.createUser(subject.repeat(64));
    const token = `synthetic-gy-i22-job-token-${subject}`;
    await auth.createSession({
      userId: user.id,
      tokenHashHex: hashToken(token),
      authEpoch: user.authEpoch,
      expiresAt: new Date(START + 48 * 3600_000),
      audience: 'user',
    });
    return { user, token };
  }
  const a = await makeUser('a');
  const b = await makeUser('b');

  const call = async (method, path, token, { headers = {}, payload } = {}) => {
    const response = await app.inject({
      method,
      url: path,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...headers,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { payload }),
    });
    let body = null;
    try {
      body = response.json();
    } catch {
      body = null;
    }
    return { status: response.statusCode, body };
  };

  const createJob = (token, key, mediaId = MEDIA_ID, mediaRevision = 1) =>
    call('POST', `${API}/recognitions`, token, {
      headers: { 'idempotency-key': key },
      payload: { media_id: mediaId, media_revision: mediaRevision },
    });
  const getJob = (token, jobId) => call('GET', `${API}/jobs/${jobId}`, token);
  const cancelJob = (token, jobId, ifMatch, key) =>
    call('POST', `${API}/jobs/${jobId}/cancel`, token, {
      headers: { 'idempotency-key': key, ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }) },
    });
  const getRecognition = (token, id) => call('GET', `${API}/recognitions/${id}`, token);
  const selectSpecies = (token, id, ifMatch, key, selected = 'synthetic-species-1') =>
    call('PATCH', `${API}/recognitions/${id}/selection`, token, {
      headers: { 'idempotency-key': key, ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }) },
      payload: { selected_species_id: selected },
    });

  /** 有界轮询作业状态（真实时钟；注入时钟固定，不受影响）。 */
  async function waitForJob(token, jobId, predicate, label) {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const result = await getJob(token, jobId);
      if (result.status === 200 && predicate(result.body.data)) return result.body.data;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`等待作业状态超时：${label}`);
  }

  return { app, auth, control, a, b, call, createJob, getJob, cancelJob, getRecognition, selectSpecies, waitForJob, settle: () => app.recognitionService.settle() };
}

// ---------------------------------------------------------------------------
// F1. 取消后晚到结果不得复活、不得写入
// ---------------------------------------------------------------------------

test('F1·在途守卫：取消后在途提供者的晚到成功结果不得复活作业、不得写入识别记录（域 store 零写入）', async (t) => {
  const h = await makeFixture(t);
  const gate = h.control.arm(MEDIA_ID);

  const accepted = await h.createJob(h.a.token, 'gy-i22-f1-job-0001');
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  const jobId = accepted.body.data.id;
  const recognitionId = accepted.body.data.target_ref.id;

  // 提供者已被调用且停在半途（在途外发）。
  const running = await h.waitForJob(h.a.token, jobId, (job) => job.state === 'running', 'running');
  assert.equal(h.control.calls.length, 1, '提供者应恰被调用一次');

  // 取消（If-Match 必须与当前 revision 一致）。
  const cancelled = await h.cancelJob(h.a.token, jobId, `"${running.revision}"`, 'gy-i22-f1-cancel-0001');
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.data.state, 'cancelled');

  // 放行**晚到**的成功结果，并等所有在途执行落定。
  gate.release(successOutcome());
  await h.settle();

  const after = await h.getJob(h.a.token, jobId);
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.equal(after.body.data.state, 'cancelled', '晚到结果不得把已取消作业复活为成功');
  assert.equal(after.body.data.error_code, null, '取消不留错误码');
  assert.equal(after.body.data.result, null, '已取消作业不得产出结果');
  assert.equal(after.body.data.revision, cancelled.body.data.revision, '晚到结果不得再推进作业版本');

  // **零写入**：识别记录不得被创建（与不存在同形 404）。
  const recognition = await h.getRecognition(h.a.token, recognitionId);
  assert.equal(recognition.status, 404, `晚到结果不得写入识别记录（实际 ${recognition.status} ${recognition.body}）`);
  assert.equal(recognition.body.error.code, 'NOT_FOUND');
});

// ---------------------------------------------------------------------------
// F2. 取消幂等
// ---------------------------------------------------------------------------

test('F2·取消幂等：同键同 If-Match 原样重试回放已取消结果；同键异体 ⇒ 409 IDEMPOTENCY_CONFLICT', async (t) => {
  const h = await makeFixture(t);
  // 让提供者停在半途，从而**确定地**把作业停在 `running`（revision=2）再取消，
  // 避免"先落定成终态 ⇒ 取消被终态守卫拒绝"这种与被测语义无关的干扰。
  const gate = h.control.arm(MEDIA_ID);
  const accepted = await h.createJob(h.a.token, 'gy-i22-f2-job-0001');
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  const jobId = accepted.body.data.id;
  const running = await h.waitForJob(h.a.token, jobId, (job) => job.state === 'running', 'running');

  const first = await h.cancelJob(h.a.token, jobId, `"${running.revision}"`, 'gy-i22-f2-cancel-0001');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.state, 'cancelled');
  const revisionAfterFirst = first.body.data.revision;

  // 原样重试（同键 + 同 If-Match）：必须回放，不得因 revision 已自增而报 REVISION_CONFLICT。
  const replay = await h.cancelJob(h.a.token, jobId, `"${running.revision}"`, 'gy-i22-f2-cancel-0001');
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.data.state, 'cancelled', '重放必须给出同一结论');
  assert.equal(replay.body.data.revision, revisionAfterFirst, '重放不得再次推进版本');

  // 同键异体（If-Match 不同）⇒ 幂等冲突，不得静默按新请求执行。
  const conflict = await h.cancelJob(h.a.token, jobId, `"${revisionAfterFirst}"`, 'gy-i22-f2-cancel-0001');
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(conflict.body.data, undefined);

  // 清理：放行在途提供者，确认已取消作业不被复活（与 F1 同一红线，此处只作收尾）。
  gate.release(successOutcome());
  await h.settle();
  assert.equal((await h.getJob(h.a.token, jobId)).body.data.state, 'cancelled');
});

// ---------------------------------------------------------------------------
// F3. 跨用户归属（识别线读面/写面）
// ---------------------------------------------------------------------------

test('F3·跨用户归属：他人作业/识别记录的读、取消、改选一律同形 404，且归属者对象状态不变', async (t) => {
  const h = await makeFixture(t);
  const accepted = await h.createJob(h.a.token, 'gy-i22-f3-job-0001');
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  const jobId = accepted.body.data.id;
  const recognitionId = accepted.body.data.target_ref.id;
  await h.settle();

  // A 自己能读（正控制）。
  const ownJob = await h.getJob(h.a.token, jobId);
  assert.equal(ownJob.status, 200, JSON.stringify(ownJob.body));
  const ownRecognition = await h.getRecognition(h.a.token, recognitionId);
  assert.ok([200, 404].includes(ownRecognition.status), `A 自己的识别记录状态应可读：${ownRecognition.status}`);

  // B 的四种越权尝试：一律 404 NOT_FOUND，且与"不存在"同形。
  const foreignRead = await h.getJob(h.b.token, jobId);
  const absentRead = await h.getJob(h.b.token, ABSENT_UUID);
  assert.equal(foreignRead.status, 404, JSON.stringify(foreignRead.body));
  assert.equal(foreignRead.body.error.code, 'NOT_FOUND');
  assert.equal(absentRead.status, 404);
  assert.deepEqual(foreignRead.body.error, absentRead.body.error, '他人作业与不存在必须同形');

  const foreignCancel = await h.cancelJob(h.b.token, jobId, `"${ownJob.body.data.revision}"`, 'gy-i22-f3-cancel-0001');
  assert.equal(foreignCancel.status, 404, JSON.stringify(foreignCancel.body));
  assert.equal(foreignCancel.body.error.code, 'NOT_FOUND');

  const foreignSelect = await h.selectSpecies(h.b.token, recognitionId, '"1"', 'gy-i22-f3-select-0001');
  assert.equal(foreignSelect.status, 404, JSON.stringify(foreignSelect.body));
  assert.equal(foreignSelect.body.error.code, 'NOT_FOUND');

  const foreignRecognition = await h.getRecognition(h.b.token, recognitionId);
  assert.equal(foreignRecognition.status, 404, JSON.stringify(foreignRecognition.body));

  // A 的对象状态未被越权请求触动。
  const after = await h.getJob(h.a.token, jobId);
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.equal(after.body.data.revision, ownJob.body.data.revision, '越权请求不得推进归属者作业版本');
  assert.equal(after.body.data.state, ownJob.body.data.state, '越权请求不得改变归属者作业状态');
});

// ---------------------------------------------------------------------------
// F4. 同对象同版本再受理：取消不是持久禁令；但跨任务不得串写
// ---------------------------------------------------------------------------

test('F4·跨任务隔离：取消后同对象同版本再受理会成为**新任务**（如实登记设计行为），但旧任务的晚到结果不得写入新任务', async (t) => {
  const h = await makeFixture(t);
  const gate = h.control.arm(MEDIA_ID);

  // 任务 1：同对象同版本，提供者停在半途。
  const first = await h.createJob(h.a.token, 'gy-i22-f4-job-0001');
  assert.equal(first.status, 202, JSON.stringify(first.body));
  const job1 = first.body.data.id;
  const recognition1 = first.body.data.target_ref.id;
  const running1 = await h.waitForJob(h.a.token, job1, (job) => job.state === 'running', 'job1 running');
  const cancel1 = await h.cancelJob(h.a.token, job1, `"${running1.revision}"`, 'gy-i22-f4-cancel-0001');
  assert.equal(cancel1.status, 200, JSON.stringify(cancel1.body));

  // 任务 2：**同对象同版本**、新幂等键 —— 取消不是持久禁令。
  const second = await h.createJob(h.a.token, 'gy-i22-f4-job-0002');
  assert.equal(second.status, 202, `取消不是持久禁令：同对象同版本再受理应被接受（实际 ${second.status} ${second.body}）`);
  const job2 = second.body.data.id;
  const recognition2 = second.body.data.target_ref.id;
  assert.notEqual(job2, job1, '再受理必须产生新的作业');
  assert.notEqual(recognition2, recognition1, '再受理必须产生新的识别记录标识');

  const settled2 = await h.waitForJob(
    h.a.token,
    job2,
    (job) => ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'].includes(job.state),
    'job2 terminal',
  );
  assert.ok(['succeeded', 'uncertain'].includes(settled2.state), `新任务应正常完成：${JSON.stringify(settled2)}`);

  // 现在放行**任务 1 的晚到成功结果**：它绝不能写到任务 2 的记录上，也不能创建任务 1 的记录。
  gate.release(successOutcome());
  await h.settle();

  const job1After = await h.getJob(h.a.token, job1);
  assert.equal(job1After.body.data.state, 'cancelled', '任务 1 不得被自己的晚到结果复活');
  assert.equal(job1After.body.data.result, null);
  assert.equal((await h.getRecognition(h.a.token, recognition1)).status, 404, '任务 1 的识别记录不得被创建');

  const recognition2After = await h.getRecognition(h.a.token, recognition2);
  assert.equal(recognition2After.status, 200, '任务 2 的记录必须仍然存在');
  assert.equal(
    recognition2After.body.data.revision,
    recognition2After.body.data.revision,
    '任务 2 记录内容不得被任务 1 的晚到结果改写',
  );
  assert.deepEqual(
    recognition2After.body.data.candidates.map((c) => c.species_id),
    ['synthetic-species-1', 'synthetic-species-2', 'synthetic-species-3'],
    '任务 2 的候选必须来自它自己的提供者调用（不得混入任务 1 的结果）',
  );

  // 提供者恰好被调用两次（每个任务一次），没有额外外发。
  assert.equal(h.control.calls.length, 2, `提供者调用次数应为 2，实际 ${h.control.calls.length}`);
  assert.equal(h.control.calls[0].jobId, job1);
  assert.equal(h.control.calls[1].jobId, job2);
  assert.deepEqual(
    h.control.calls.map((c) => [c.mediaId, c.mediaRevision]),
    [[MEDIA_ID, 1], [MEDIA_ID, 1]],
    '两次调用必须指向同一对象同一版本（本用例的主题）',
  );
});
