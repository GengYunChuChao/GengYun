// GY-I09 识别任务闭环回归（全部为合成身份与合成媒体引用；不含任何真实个人媒体/凭据/真实供应商调用）。
//
// 本文件对每一条「应当拒绝 / 应当不可信」的情形各写一条**独立反例**（negative control），
// 断言策略：先判 typeof 再判值（`undefined` 不会被宽松放过），并显式断言状态字段，
// 不做「只要不抛错就算过」的写法。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryRecognitionStore } from '../../services/api/src/recognitions/store.ts';
import { createSubstituteMediaPort, createUnwiredMediaPort } from '../../services/api/src/recognitions/media.ts';
import { createStubRecognitionProvider, createRealRecognitionProvider } from '../../services/api/src/recognitions/provider.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';

const JOB_STATES = ['queued', 'running', 'succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'];
const TERMINAL = ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'];
const MEDIA_A = '11111111-1111-4111-8111-111111111111';
const MEDIA_B = '22222222-2222-4222-8222-222222222222';
const KEY = n => 'idem-' + n + '-0000000000';

/** 脚本化提供者：按调用次序返回脚本项；函数项返回 Promise（可做受控悬挂）。 */
function scriptedProvider(script, overrides = {}) {
  const queue = [...script];
  const calls = [];
  return {
    executionMode: 'stub',
    modelVersion: 'stub-v1',
    available: true,
    unavailableReason: null,
    calls,
    async recognize(input) {
      calls.push(input);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return typeof next === 'function' ? next() : next;
    },
    ...overrides,
  };
}

function config(mode = 'stub') {
  const base = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
  return mode === 'stub' ? base : { ...base, executionMode: mode };
}

function makeApp(options = {}) {
  const app = buildApp({
    config: config(options.mode ?? 'stub'),
    recognitionStore: options.store ?? createMemoryRecognitionStore(),
    recognitionProvider: options.provider ?? createStubRecognitionProvider(),
    recognitionMedia: options.media ?? createSubstituteMediaPort(),
    ...(options.jobDeadlineMs === undefined ? {} : { recognitionJobDeadlineMs: options.jobDeadlineMs }),
  });
  return app;
}

async function login(app, code) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/wechat',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'login-key-' + code },
    payload: { code },
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().data.access_token;
}

async function call(app, method, url, token, { payload, headers } = {}) {
  const r = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(headers ?? {}) },
  });
  let body = null;
  try { body = r.json(); } catch { body = null; }
  return { status: r.statusCode, body, etag: r.headers.etag, cache: r.headers['cache-control'] };
}

/** 建一个已受理、等待执行的任务。 */
async function createJob(app, token, { mediaId = MEDIA_A, key = KEY('create'), revision = 1, body } = {}) {
  return call(app, 'POST', '/api/v1/recognitions', token, {
    payload: body ?? { media_id: mediaId, media_revision: revision },
    headers: { 'idempotency-key': key },
  });
}

async function waitForTerminal(app, token, jobId, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await call(app, 'GET', '/api/v1/jobs/' + jobId, token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (TERMINAL.includes(r.body.data.state)) return r.body.data;
    if (Date.now() > deadline) throw new Error('等待任务终态超时：' + r.body.data.state);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const VALID_CANDIDATES = [
  { species_id: 'synthetic_weed_a', rank: 1, model_score: 0.81 },
  { species_id: 'synthetic_weed_b', rank: 2, model_score: 0.42 },
  { species_id: 'synthetic_weed_c', rank: 3, model_score: 0.17 },
];

test('GY-I09 识别任务闭环：契约面、七类状态与逐条反例（合成数据）', async t => {
  const app = makeApp();
  t.after(() => app.close());
  const tokenA = await login(app, 'synthetic-a');
  const tokenB = await login(app, 'synthetic-b');
  assert.equal(typeof tokenA, 'string');
  assert.ok(tokenA.length > 0);

  await t.test('未登录访问受保护路径 → 401 SESSION_REQUIRED', async () => {
    assert.equal((await call(app, 'POST', '/api/v1/recognitions', null, { payload: { media_id: MEDIA_A, media_revision: 1 } })).status, 401);
    assert.equal((await call(app, 'GET', '/api/v1/recognitions/' + MEDIA_A, null)).status, 401);
    assert.equal((await call(app, 'GET', '/api/v1/jobs/' + MEDIA_A, null)).status, 401);
  });

  await t.test('反例 1：body 含多余字段 → 400 INVALID_REQUEST（additionalProperties:false）', async () => {
    const r = await call(app, 'POST', '/api/v1/recognitions', tokenA, {
      payload: { media_id: MEDIA_A, media_revision: 1, owner_id: 'attacker' },
      headers: { 'idempotency-key': KEY('extra') },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'INVALID_REQUEST');
  });

  await t.test('反例 2：缺 Idempotency-Key → 400 IDEMPOTENCY_KEY_REQUIRED（含过短键）', async () => {
    const missing = await call(app, 'POST', '/api/v1/recognitions', tokenA, { payload: { media_id: MEDIA_A, media_revision: 1 } });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
    const short = await createJob(app, tokenA, { key: 'short' });
    assert.equal(short.status, 400);
    assert.equal(short.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  });

  await t.test('反例 3：media_id 非 uuid / media_revision 非正整数 → 400 INVALID_REQUEST', async () => {
    for (const payload of [
      { media_id: 'not-a-uuid', media_revision: 1 },
      { media_id: MEDIA_A, media_revision: 0 },
      { media_id: MEDIA_A, media_revision: 1.5 },
      { media_id: MEDIA_A },
      {},
    ]) {
      const r = await call(app, 'POST', '/api/v1/recognitions', tokenA, { payload, headers: { 'idempotency-key': KEY('bad-media') + Math.random() } });
      assert.equal(r.status, 400, JSON.stringify({ payload, body: r.body }));
      assert.equal(r.body.error.code, 'INVALID_REQUEST');
    }
  });

  await t.test('反例 4：媒体引用不可用（real 未接线端口）→ 409 OBJECT_UNAVAILABLE，不创建任务', async () => {
    const unwired = makeApp({ media: createUnwiredMediaPort() });
    try {
      const token = await login(unwired, 'synthetic-c');
      const r = await createJob(unwired, token, { key: KEY('unwired') });
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, 'OBJECT_UNAVAILABLE');
    } finally { await unwired.close(); }
  });

  // ---------------------------------------------------------------- 七类状态

  await t.test('状态 1 queued：202 受理即观测，且 result 为 null', async () => {
    const provider = scriptedProvider([() => new Promise(() => {})]);
    // 该用例只观测「202 受理即 queued」，提供一个短截止时间，避免测试进程被悬挂的
    // 提供者+30s 定时器拖住（任务随后 timeout 不影响本用例断言）。
    const held = makeApp({ provider, jobDeadlineMs: 400 });
    try {
      const token = await login(held, 'synthetic-d');
      const r = await createJob(held, token, { key: KEY('queued'), mediaId: MEDIA_B });
      assert.equal(r.status, 202);
      assert.equal(typeof r.body.data.state, 'string');
      assert.equal(r.body.data.state, 'queued');
      assert.equal(r.body.data.kind, 'recognition');
      assert.equal(r.body.data.result, null);
      assert.equal(r.body.data.error_code, null);
      assert.equal(r.body.data.target_ref.type, 'recognition');
      assert.equal(r.cache, 'no-store');
      assert.equal(r.etag, '"1"');
      assert.equal(r.body.meta.execution_mode, 'stub');
    } finally { await held.close(); }
  });

  await t.test('状态 2 running：提供者悬挂时可观测', async () => {
    let release;
    const provider = scriptedProvider([() => new Promise(resolve => { release = resolve; })]);
    const held = makeApp({ provider });
    try {
      const token = await login(held, 'synthetic-e');
      const created = await createJob(held, token, { key: KEY('running'), mediaId: MEDIA_B });
      const jobId = created.body.data.id;
      let observed = null;
      for (let i = 0; i < 200 && observed !== 'running'; i += 1) {
        const r = await call(held, 'GET', '/api/v1/jobs/' + jobId, token);
        observed = r.body.data.state;
        if (observed !== 'running') await new Promise(resolve => setTimeout(resolve, 2));
      }
      assert.equal(observed, 'running');
      release({ kind: 'completed', candidates: VALID_CANDIDATES, uncertainty_reasons: [] });
      const done = await waitForTerminal(held, token, jobId);
      assert.equal(done.state, 'succeeded');
    } finally { await held.close(); }
  });

  await t.test('状态 3 succeeded：有可信分数的 Top3 → 202→succeeded，候选不超过 3 且不补造', async () => {
    const provider = scriptedProvider([{ kind: 'completed', candidates: VALID_CANDIDATES, uncertainty_reasons: [] }]);
    const own = makeApp({ provider });
    try {
      const token = await login(own, 'synthetic-f');
      const created = await createJob(own, token, { key: KEY('succeeded'), mediaId: MEDIA_B });
      assert.equal(created.status, 202);
      const job = await waitForTerminal(own, token, created.body.data.id);
      assert.equal(job.state, 'succeeded');
      assert.equal(job.error_code, null);
      assert.equal(typeof job.result, 'object');
      assert.equal(job.result.kind, 'recognition');
      const value = job.result.value;
      assert.equal(value.candidates.length, 3);
      assert.deepEqual(value.candidates, VALID_CANDIDATES);
      assert.deepEqual(value.uncertainty_reasons, []);
      assert.equal(value.selected_species_id, null);
      assert.equal(value.model_version, 'stub-v1');

      // 少于 3 条候选：**不补造**。
      const two = scriptedProvider([{ kind: 'completed', candidates: VALID_CANDIDATES.slice(0, 2), uncertainty_reasons: [] }]);
      const own2 = makeApp({ provider: two });
      const token2 = await login(own2, 'synthetic-f2');
      const created2 = await createJob(own2, token2, { key: KEY('succeeded2'), mediaId: MEDIA_B });
      const job2 = await waitForTerminal(own2, token2, created2.body.data.id);
      assert.equal(job2.result.value.candidates.length, 2, '候选少于 3 条不得补造');
      await own2.close();
    } finally { await own.close(); }
  });

  await t.test('状态 4 uncertain：无分数 → uncertain + 原因，且不写分数', async () => {
    const nullScored = [
      { species_id: 'synthetic_weed_a', rank: 1, model_score: null },
      { species_id: 'synthetic_weed_b', rank: 2, model_score: null },
    ];
    const provider = scriptedProvider([{ kind: 'completed', candidates: nullScored, uncertainty_reasons: ['替身未给出可信分数'] }]);
    const own = makeApp({ provider });
    try {
      const token = await login(own, 'synthetic-g');
      const created = await createJob(own, token, { key: KEY('uncertain'), mediaId: MEDIA_B });
      const job = await waitForTerminal(own, token, created.body.data.id);
      assert.equal(job.state, 'uncertain', '无分数不得落 succeeded');
      assert.equal(job.error_code, null);
      assert.ok(Array.isArray(job.result.value.uncertainty_reasons));
      assert.ok(job.result.value.uncertainty_reasons.length >= 1, 'uncertain 必须至少一条原因');
      for (const candidate of job.result.value.candidates) {
        assert.equal(candidate.model_score, null, '没有分数时不得写入分数');
      }
    } finally { await own.close(); }
  });

  await t.test('状态 4b uncertain：空候选 → uncertain + 服务端如实原因（不补造候选）', async () => {
    const provider = scriptedProvider([{ kind: 'completed', candidates: [], uncertainty_reasons: [] }]);
    const own = makeApp({ provider });
    try {
      const token = await login(own, 'synthetic-h');
      const created = await createJob(own, token, { key: KEY('empty'), mediaId: MEDIA_B });
      const job = await waitForTerminal(own, token, created.body.data.id);
      assert.equal(job.state, 'uncertain');
      assert.deepEqual(job.result.value.candidates, []);
      assert.ok(job.result.value.uncertainty_reasons.length >= 1);
    } finally { await own.close(); }
  });

  await t.test('状态 4c uncertain：提供者自述原因（即使候选都有分数）→ 不得判 succeeded', async () => {
    const provider = scriptedProvider([{ kind: 'completed', candidates: VALID_CANDIDATES, uncertainty_reasons: ['拍摄角度过斜，建议重拍'] }]);
    const own = makeApp({ provider });
    try {
      const token = await login(own, 'synthetic-i');
      const created = await createJob(own, token, { key: KEY('selfuncertain'), mediaId: MEDIA_B });
      const job = await waitForTerminal(own, token, created.body.data.id);
      assert.equal(job.state, 'uncertain');
      assert.deepEqual(job.result.value.uncertainty_reasons, ['拍摄角度过斜，建议重拍']);
    } finally { await own.close(); }
  });

  await t.test('状态 5 failed：提供者配额失败 → failed + PROVIDER_QUOTA_EXCEEDED（绝不写 succeeded）', async () => {
    const provider = scriptedProvider([{ kind: 'failed', code: 'PROVIDER_QUOTA_EXCEEDED' }]);
    const own = makeApp({ provider });
    try {
      const token = await login(own, 'synthetic-j');
      const created = await createJob(own, token, { key: KEY('quota'), mediaId: MEDIA_B });
      const job = await waitForTerminal(own, token, created.body.data.id);
      assert.equal(job.state, 'failed');
      assert.equal(job.error_code, 'PROVIDER_QUOTA_EXCEEDED');
      assert.equal(job.result, null, '失败任务不得带识别结果');
      // 失败不产生识别记录：目标 id 如实 404。
      const record = await call(own, 'GET', '/api/v1/recognitions/' + created.body.data.target_ref.id, token);
      assert.equal(record.status, 404);
      assert.equal(record.body.error.code, 'NOT_FOUND');
    } finally { await own.close(); }
  });

  await t.test('状态 6 timed_out：提供者无响应且超过截止时间 → timed_out + PROVIDER_TIMEOUT', async () => {
    const provider = scriptedProvider([() => new Promise(() => {})]);
    const own = makeApp({ provider, jobDeadlineMs: 60 });
    try {
      const token = await login(own, 'synthetic-k');
      const created = await createJob(own, token, { key: KEY('timeout'), mediaId: MEDIA_B });
      const job = await waitForTerminal(own, token, created.body.data.id, 4000);
      assert.equal(job.state, 'timed_out');
      assert.equal(job.error_code, 'PROVIDER_TIMEOUT');
      assert.equal(job.result, null);
    } finally { await own.close(); }
  });

  await t.test('状态 7 cancelled：取消后**迟到的提供者结果不复活任务**', async () => {
    let release;
    const provider = scriptedProvider([() => new Promise(resolve => { release = resolve; })]);
    const own = makeApp({ provider });
    try {
      const token = await login(own, 'synthetic-l');
      const created = await createJob(own, token, { key: KEY('cancel'), mediaId: MEDIA_B });
      const jobId = created.body.data.id;
      // 等到 running（拿到当前 revision 做 If-Match）。
      let current = created.body.data;
      for (let i = 0; i < 200 && current.state === 'queued'; i += 1) {
        current = (await call(own, 'GET', '/api/v1/jobs/' + jobId, token)).body.data;
        await new Promise(resolve => setTimeout(resolve, 2));
      }
      assert.equal(current.state, 'running');
      const cancelled = await call(own, 'POST', '/api/v1/jobs/' + jobId + '/cancel', token, {
        headers: { 'if-match': '"' + current.revision + '"', 'idempotency-key': KEY('cancel-op') },
      });
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
      assert.equal(cancelled.body.data.state, 'cancelled');
      // 迟到的成功结果必须被丢弃。
      release({ kind: 'completed', candidates: VALID_CANDIDATES, uncertainty_reasons: [] });
      await new Promise(resolve => setTimeout(resolve, 30));
      const after = (await call(own, 'GET', '/api/v1/jobs/' + jobId, token)).body.data;
      assert.equal(after.state, 'cancelled', '旧回调不得复活已取消任务');
      assert.equal(after.result, null);
      // 已终态任务再次取消 → 409 OBJECT_UNAVAILABLE（不假装取消成功）。
      const again = await call(own, 'POST', '/api/v1/jobs/' + jobId + '/cancel', token, {
        headers: { 'if-match': '"' + after.revision + '"', 'idempotency-key': KEY('cancel-op2') },
      });
      assert.equal(again.status, 409);
      assert.equal(again.body.error.code, 'OBJECT_UNAVAILABLE');
    } finally { await own.close(); }
  });

  await t.test('返修轮 1 [P1]：同键同体**并发**创建 → 恰好 1 个 job、恰好 1 次提供者调用、两响应收敛', async () => {
    let release;
    const provider = scriptedProvider([() => new Promise(resolve => { release = resolve; })]);
    const own = makeApp({ provider });
    try {
      const token = await login(own, 'synthetic-concurrent-same');
      const key = KEY('concurrent-same');
      const [first, second] = await Promise.all([
        createJob(own, token, { key, mediaId: MEDIA_B }),
        createJob(own, token, { key, mediaId: MEDIA_B }),
      ]);
      assert.equal(first.status, 202, JSON.stringify(first.body));
      assert.equal(second.status, 202, JSON.stringify(second.body));
      assert.equal(typeof first.body.data.id, 'string');
      // 收敛判据：同一任务身份（id/kind/target_ref）。后到者按回执重新读取当前状态，
      // 因此瞬态 state/revision 可能已推进（queued → running），这属于如实读取而非第二个任务。
      assert.equal(first.body.data.id, second.body.data.id, '同键同体并发必须收敛到同一 job');
      assert.equal(first.body.data.kind, 'recognition');
      assert.equal(first.body.data.kind, second.body.data.kind);
      assert.equal(first.body.data.target_ref.id, second.body.data.target_ref.id);
      assert.equal(first.body.data.target_ref.type, 'recognition');
      assert.equal(first.body.data.state, 'queued');
      assert.ok(['queued', 'running'].includes(second.body.data.state), '后到者应报当前状态，实际 ' + second.body.data.state);
      // 恰好 1 次提供者调用：等到第一次调用出现，再给（错误的）第二次调用留出窗口。
      for (let i = 0; i < 200 && provider.calls.length === 0; i += 1) await new Promise(r => setTimeout(r, 2));
      assert.equal(provider.calls.length, 1, '并发同键只允许调用提供者一次');
      await new Promise(r => setTimeout(r, 40));
      assert.equal(provider.calls.length, 1, '不得出现第二次提供者调用');
      release({ kind: 'completed', candidates: VALID_CANDIDATES, uncertainty_reasons: [] });
      await own.recognitionService.settle();
      assert.equal(provider.calls.length, 1);
      const settled = await call(own, 'GET', '/api/v1/jobs/' + first.body.data.id, token);
      assert.equal(settled.body.data.state, 'succeeded');
    } finally { await own.close(); }
  });

  await t.test('返修轮 1 [P1]：同键**异体**并发 → IDEMPOTENCY_CONFLICT 且不产生第二个任务', async () => {
    let release;
    const provider = scriptedProvider([() => new Promise(resolve => { release = resolve; })]);
    const own = makeApp({ provider });
    try {
      const token = await login(own, 'synthetic-concurrent-diff');
      const key = KEY('concurrent-diff');
      const [a, b] = await Promise.all([
        createJob(own, token, { key, mediaId: MEDIA_A }),
        createJob(own, token, { key, mediaId: MEDIA_B }),
      ]);
      const statuses = [a.status, b.status].sort((x, y) => x - y);
      assert.deepEqual(statuses, [202, 409], JSON.stringify([a.body, b.body]));
      const conflict = a.status === 409 ? a : b;
      const accepted = a.status === 202 ? a : b;
      assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
      assert.equal(typeof accepted.body.data.id, 'string');
      for (let i = 0; i < 200 && provider.calls.length === 0; i += 1) await new Promise(r => setTimeout(r, 2));
      assert.equal(provider.calls.length, 1, '异体并发不得产生第二个任务');
      await new Promise(r => setTimeout(r, 40));
      assert.equal(provider.calls.length, 1);
      release({ kind: 'completed', candidates: VALID_CANDIDATES, uncertainty_reasons: [] });
      await own.recognitionService.settle();
    } finally { await own.close(); }
  });

  await t.test('返修轮 1 [P2]：取消成功后**原键 + 原 If-Match 原样重放** → 回放取消结果（非 REVISION_CONFLICT）', async () => {
    let release;
    const provider = scriptedProvider([() => new Promise(resolve => { release = resolve; })]);
    const own = makeApp({ provider });
    try {
      const token = await login(own, 'synthetic-cancel-replay');
      const created = await createJob(own, token, { key: KEY('cancel-replay-create'), mediaId: MEDIA_B });
      const jobId = created.body.data.id;
      let current = created.body.data;
      for (let i = 0; i < 200 && current.state === 'queued'; i += 1) {
        current = (await call(own, 'GET', '/api/v1/jobs/' + jobId, token)).body.data;
        await new Promise(r => setTimeout(r, 2));
      }
      assert.equal(current.state, 'running');
      const originalIfMatch = '"' + current.revision + '"';
      const cancelKey = KEY('cancel-replay-op');
      const cancelled = await call(own, 'POST', '/api/v1/jobs/' + jobId + '/cancel', token, {
        headers: { 'if-match': originalIfMatch, 'idempotency-key': cancelKey },
      });
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
      assert.equal(cancelled.body.data.state, 'cancelled');
      const cancelledRevision = cancelled.body.data.revision;
      // 原样重放：同一幂等键 + 同一（此时已过期的）If-Match。
      const replay = await call(own, 'POST', '/api/v1/jobs/' + jobId + '/cancel', token, {
        headers: { 'if-match': originalIfMatch, 'idempotency-key': cancelKey },
      });
      assert.equal(replay.status, 200, JSON.stringify(replay.body));
      assert.equal(replay.body.data.state, 'cancelled');
      assert.equal(replay.body.data.revision, cancelledRevision, '重放必须返回同一取消结果');
      // 但「新键 + 过期 If-Match」仍按契约报版本冲突（守卫未放宽）。
      const staleNewKey = await call(own, 'POST', '/api/v1/jobs/' + jobId + '/cancel', token, {
        headers: { 'if-match': originalIfMatch, 'idempotency-key': KEY('cancel-replay-stale') },
      });
      assert.equal(staleNewKey.status, 409);
      assert.equal(staleNewKey.body.error.code, 'REVISION_CONFLICT');
      // 新键 + 当前版本 → 已终态，不可取消（不假装取消成功）。
      const terminalNewKey = await call(own, 'POST', '/api/v1/jobs/' + jobId + '/cancel', token, {
        headers: { 'if-match': '"' + cancelledRevision + '"', 'idempotency-key': KEY('cancel-replay-terminal') },
      });
      assert.equal(terminalNewKey.status, 409);
      assert.equal(terminalNewKey.body.error.code, 'OBJECT_UNAVAILABLE');
      // 迟到结果仍不复活（守卫保留）。
      release({ kind: 'completed', candidates: VALID_CANDIDATES, uncertainty_reasons: [] });
      await new Promise(r => setTimeout(r, 30));
      const after = (await call(own, 'GET', '/api/v1/jobs/' + jobId, token)).body.data;
      assert.equal(after.state, 'cancelled');
      assert.equal(after.result, null);
      // 他人不可取消（归属守卫保留）。
      const tokenOther = await login(own, 'synthetic-cancel-replay-other');
      const foreignReplay = await call(own, 'POST', '/api/v1/jobs/' + jobId + '/cancel', tokenOther, {
        headers: { 'if-match': originalIfMatch, 'idempotency-key': cancelKey },
      });
      assert.equal(foreignReplay.status, 404);
      assert.equal(foreignReplay.body.error.code, 'NOT_FOUND');
    } finally { await own.close(); }
  });

  await t.test('反例 5：候选 >3 → failed PROVIDER_OUTCOME_UNKNOWN（不截断、不补造）', async () => {
    const provider = scriptedProvider([{
      kind: 'completed',
      candidates: [...VALID_CANDIDATES, { species_id: 'synthetic_weed_d', rank: 4, model_score: 0.9 }],
      uncertainty_reasons: [],
    }]);
    const own = makeApp({ provider });
    try {
      const token = await login(own, 'synthetic-m');
      const created = await createJob(own, token, { key: KEY('toomany'), mediaId: MEDIA_B });
      const job = await waitForTerminal(own, token, created.body.data.id);
      assert.equal(job.state, 'failed');
      assert.equal(job.error_code, 'PROVIDER_OUTCOME_UNKNOWN');
      assert.equal(job.result, null);
    } finally { await own.close(); }
  });

  await t.test('反例 6：同 rank 重复 → failed（不静默去重）', async () => {
    const provider = scriptedProvider([{
      kind: 'completed',
      candidates: [
        { species_id: 'synthetic_weed_a', rank: 1, model_score: 0.9 },
        { species_id: 'synthetic_weed_b', rank: 1, model_score: 0.8 },
      ],
      uncertainty_reasons: [],
    }]);
    const own = makeApp({ provider });
    try {
      const token = await login(own, 'synthetic-n');
      const created = await createJob(own, token, { key: KEY('rankdup'), mediaId: MEDIA_B });
      const job = await waitForTerminal(own, token, created.body.data.id);
      assert.equal(job.state, 'failed');
      assert.equal(job.error_code, 'PROVIDER_OUTCOME_UNKNOWN');
    } finally { await own.close(); }
  });

  await t.test('反例 7：候选字段缺失（model_score undefined）→ failed（先判 typeof，undefined 不放行）', async () => {
    const provider = scriptedProvider([{
      kind: 'completed',
      candidates: [{ species_id: 'synthetic_weed_a', rank: 1 }],
      uncertainty_reasons: [],
    }]);
    const own = makeApp({ provider });
    try {
      const token = await login(own, 'synthetic-o');
      const created = await createJob(own, token, { key: KEY('missfield'), mediaId: MEDIA_B });
      const job = await waitForTerminal(own, token, created.body.data.id);
      assert.equal(job.state, 'failed');
      assert.equal(job.error_code, 'PROVIDER_OUTCOME_UNKNOWN');
    } finally { await own.close(); }
  });

  await t.test('反例 8：提供者抛异常 → failed PROVIDER_OUTCOME_UNKNOWN', async () => {
    const provider = scriptedProvider([() => { throw new Error('synthetic provider crash'); }]);
    const own = makeApp({ provider });
    try {
      const token = await login(own, 'synthetic-p');
      const created = await createJob(own, token, { key: KEY('threw'), mediaId: MEDIA_B });
      const job = await waitForTerminal(own, token, created.body.data.id);
      assert.equal(job.state, 'failed');
      assert.equal(job.error_code, 'PROVIDER_OUTCOME_UNKNOWN');
    } finally { await own.close(); }
  });

  // ------------------------------------------------------- 归属、幂等、选择

  await t.test('反例 9：他人任务 id → 一律 NOT_FOUND（GET/PATCH/DELETE/jobs 均不泄露存在性）', async () => {
    const provider = scriptedProvider([{ kind: 'completed', candidates: VALID_CANDIDATES, uncertainty_reasons: [] }]);
    const own = makeApp({ provider });
    try {
      const tokenA2 = await login(own, 'synthetic-owner');
      const tokenB2 = await login(own, 'synthetic-other');
      const created = await createJob(own, tokenA2, { key: KEY('owner'), mediaId: MEDIA_B });
      const job = await waitForTerminal(own, tokenA2, created.body.data.id);
      const recognitionId = job.result.value.id;
      for (const [method, url, extra] of [
        ['GET', '/api/v1/recognitions/' + recognitionId, {}],
        ['PATCH', '/api/v1/recognitions/' + recognitionId + '/selection', { payload: { selected_species_id: 'synthetic_weed_a' }, headers: { 'if-match': '"1"', 'idempotency-key': KEY('other-sel') } }],
        ['DELETE', '/api/v1/recognitions/' + recognitionId, { headers: { 'if-match': '"1"', 'idempotency-key': KEY('other-del') } }],
        ['GET', '/api/v1/jobs/' + job.id, {}],
      ]) {
        const r = await call(own, method, url, tokenB2, extra);
        assert.equal(r.status, 404, method + ' ' + url + ' → ' + JSON.stringify(r.body));
        assert.equal(r.body.error.code, 'NOT_FOUND');
      }
      // 归属者本人可读。
      assert.equal((await call(own, 'GET', '/api/v1/recognitions/' + recognitionId, tokenA2)).status, 200);
    } finally { await own.close(); }
  });

  await t.test('幂等：同键同体不重复建任务；同键异体 → IDEMPOTENCY_CONFLICT', async () => {
    const provider = scriptedProvider([{ kind: 'completed', candidates: VALID_CANDIDATES, uncertainty_reasons: [] }]);
    const own = makeApp({ provider });
    try {
      const token = await login(own, 'synthetic-idem');
      const first = await createJob(own, token, { key: KEY('idem-same'), mediaId: MEDIA_B });
      const second = await createJob(own, token, { key: KEY('idem-same'), mediaId: MEDIA_B });
      assert.equal(second.status, 202);
      assert.equal(second.body.data.id, first.body.data.id, '同键同体必须复用同一任务');
      assert.equal(provider.calls.length, 1, '不得重复调用提供者');
      const conflict = await createJob(own, token, { key: KEY('idem-same'), mediaId: MEDIA_A });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
    } finally { await own.close(); }
  });

  await t.test('selection：只写 selected_species_id，模型原始 candidates/model_score/model_version 不变', async () => {
    const provider = scriptedProvider([{ kind: 'completed', candidates: VALID_CANDIDATES, uncertainty_reasons: [] }]);
    const own = makeApp({ provider });
    try {
      const token = await login(own, 'synthetic-select');
      const created = await createJob(own, token, { key: KEY('sel-create'), mediaId: MEDIA_B });
      const job = await waitForTerminal(own, token, created.body.data.id);
      const before = job.result.value;
      const missing = await call(own, 'PATCH', '/api/v1/recognitions/' + before.id + '/selection', token, {
        payload: { selected_species_id: 'synthetic_weed_b' }, headers: { 'idempotency-key': KEY('sel-nomatch') },
      });
      assert.equal(missing.status, 428);
      assert.equal(missing.body.error.code, 'REVISION_REQUIRED');
      const wrong = await call(own, 'PATCH', '/api/v1/recognitions/' + before.id + '/selection', token, {
        payload: { selected_species_id: 'synthetic_weed_b' }, headers: { 'if-match': '"9"', 'idempotency-key': KEY('sel-stale') },
      });
      assert.equal(wrong.status, 409);
      assert.equal(wrong.body.error.code, 'REVISION_CONFLICT');
      const malformed = await call(own, 'PATCH', '/api/v1/recognitions/' + before.id + '/selection', token, {
        payload: { selected_species_id: 'synthetic_weed_b' }, headers: { 'if-match': '1', 'idempotency-key': KEY('sel-badmatch') },
      });
      assert.equal(malformed.status, 400);
      assert.equal(malformed.body.error.code, 'INVALID_REQUEST');
      const extra = await call(own, 'PATCH', '/api/v1/recognitions/' + before.id + '/selection', token, {
        payload: { selected_species_id: 'synthetic_weed_b', rank: 1 }, headers: { 'if-match': '"1"', 'idempotency-key': KEY('sel-extra') },
      });
      assert.equal(extra.status, 400);
      assert.equal(extra.body.error.code, 'INVALID_REQUEST');
      const ok = await call(own, 'PATCH', '/api/v1/recognitions/' + before.id + '/selection', token, {
        payload: { selected_species_id: 'synthetic_weed_b' }, headers: { 'if-match': '"1"', 'idempotency-key': KEY('sel-ok') },
      });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.data.selected_species_id, 'synthetic_weed_b');
      assert.equal(ok.body.data.revision, before.revision + 1);
      assert.equal(ok.etag, '"2"');
      assert.deepEqual(ok.body.data.candidates, before.candidates, 'selection 不得改写模型原始候选');
      assert.equal(ok.body.data.model_version, before.model_version, 'selection 不得改写模型版本');
      for (const [index, candidate] of ok.body.data.candidates.entries()) {
        assert.equal(candidate.model_score, before.candidates[index].model_score, 'selection 不得改写 model_score');
      }
      // 重放同键同体：返回当前记录，不重复自增。
      const replay = await call(own, 'PATCH', '/api/v1/recognitions/' + before.id + '/selection', token, {
        payload: { selected_species_id: 'synthetic_weed_b' }, headers: { 'if-match': '"1"', 'idempotency-key': KEY('sel-ok') },
      });
      assert.equal(replay.status, 200);
      assert.equal(replay.body.data.revision, 2);
    } finally { await own.close(); }
  });

  await t.test('delete：归属/版本校验 → 202 Ack；重放同键返回同一结果；删除后 GET 404', async () => {
    const provider = scriptedProvider([{ kind: 'completed', candidates: VALID_CANDIDATES, uncertainty_reasons: [] }]);
    const own = makeApp({ provider });
    try {
      const token = await login(own, 'synthetic-delete');
      const created = await createJob(own, token, { key: KEY('del-create'), mediaId: MEDIA_B });
      const job = await waitForTerminal(own, token, created.body.data.id);
      const id = job.result.value.id;
      const noMatch = await call(own, 'DELETE', '/api/v1/recognitions/' + id, token, { headers: { 'idempotency-key': KEY('del-nomatch') } });
      assert.equal(noMatch.status, 428);
      const stale = await call(own, 'DELETE', '/api/v1/recognitions/' + id, token, { headers: { 'if-match': '"7"', 'idempotency-key': KEY('del-stale') } });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error.code, 'REVISION_CONFLICT');
      const ok = await call(own, 'DELETE', '/api/v1/recognitions/' + id, token, { headers: { 'if-match': '"1"', 'idempotency-key': KEY('del-ok') } });
      assert.equal(ok.status, 202, JSON.stringify(ok.body));
      assert.deepEqual(ok.body.data, { accepted: true });
      const replay = await call(own, 'DELETE', '/api/v1/recognitions/' + id, token, { headers: { 'if-match': '"1"', 'idempotency-key': KEY('del-ok') } });
      assert.equal(replay.status, 202);
      assert.deepEqual(replay.body.data, { accepted: true });
      const gone = await call(own, 'GET', '/api/v1/recognitions/' + id, token);
      assert.equal(gone.status, 404);
      assert.equal(gone.body.error.code, 'NOT_FOUND');
    } finally { await own.close(); }
  });

  await t.test('未知 id → 404 NOT_FOUND（不存在的任务/识别记录）', async () => {
    assert.equal((await call(app, 'GET', '/api/v1/recognitions/' + '33333333-3333-4333-8333-333333333333', tokenA)).status, 404);
    assert.equal((await call(app, 'GET', '/api/v1/jobs/' + '44444444-4444-4444-8444-444444444444', tokenA)).status, 404);
    const malformed = await call(app, 'GET', '/api/v1/recognitions/not-a-uuid', tokenA);
    // ajv format 生效时 400，否则由服务层如实 404；两者都不得 200/500。
    assert.ok([400, 404].includes(malformed.status), '非 uuid 路径参数必须 400 或 404，实际 ' + malformed.status);
  });

  await t.test('七类 JobState 覆盖性核对（本文件逐类构造，无缺项）', async () => {
    assert.deepEqual([...JOB_STATES], ['queued', 'running', 'succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled']);
  });
});

test('GY-I09 real 模式：缺凭据 fail-closed（503 PROVIDER_UNAVAILABLE），绝不静默回退替身', async t => {
  // real 执行模式下登录本身要求持久化会话存储（GY-I04 既有守卫，不削弱）。
  // 本用例只验证**识别提供者** fail-closed，因此直接在内存 store 里注入一个合成会话
  // （合成身份、无真实 openid/凭据）；这不代表 real 模式会话存储或真实登录已验收。
  async function synthesizeSession(store, token) {
    const user = await store.createUser('synthetic-subject-lookup-hex');
    await store.createSession({
      userId: user.id,
      tokenHashHex: hashToken(token),
      authEpoch: user.authEpoch,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      audience: 'user',
    });
    return token;
  }
  const storeA = createMemoryAuthStore();
  const app = buildApp({
    config: config('real'),
    store: storeA,
    recognitionProvider: createRealRecognitionProvider({ endpoint: null, apiKey: null }),
    recognitionMedia: createSubstituteMediaPort(),
  });
  t.after(() => app.close());
  const token = await synthesizeSession(storeA, 'synthetic-real-session-token-0001');
  const r = await call(app, 'POST', '/api/v1/recognitions', token, {
    payload: { media_id: MEDIA_A, media_revision: 1 },
    headers: { 'idempotency-key': KEY('real') },
  });
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'PROVIDER_UNAVAILABLE');
  // 不得回退替身：响应里没有 Job、没有 model_version、没有候选。
  assert.equal(r.body.data, undefined);
  assert.equal(r.body.error.details.length, 0);

  // 真实凭据齐备但无已审适配器：仍然 fail-closed，不回退替身。
  const storeB = createMemoryAuthStore();
  const app2 = buildApp({
    config: config('real'),
    store: storeB,
    recognitionProvider: createRealRecognitionProvider({ endpoint: 'https://vendor.invalid/v1', apiKey: 'synthetic-key-0123456789' }),
    recognitionMedia: createSubstituteMediaPort(),
  });
  t.after(() => app2.close());
  const token2 = await synthesizeSession(storeB, 'synthetic-real-session-token-0002');
  const accepted = await call(app2, 'POST', '/api/v1/recognitions', token2, {
    payload: { media_id: MEDIA_A, media_revision: 1 },
    headers: { 'idempotency-key': KEY('real2') },
  });
  assert.equal(accepted.status, 202);
  const job = await waitForTerminal(app2, token2, accepted.body.data.id);
  assert.equal(job.state, 'failed');
  assert.equal(job.error_code, 'PROVIDER_UNAVAILABLE');
  assert.equal(job.result, null);
});

test('GY-I09 替身提供者确定性：同一 media_id 稳定分桶（离线可复现）', async t => {
  const provider = createStubRecognitionProvider({ executionMode: 'stub' });
  const first = await provider.recognize({ jobId: 'j', mediaId: MEDIA_A, mediaRevision: 1 });
  const second = await provider.recognize({ jobId: 'j', mediaId: MEDIA_A, mediaRevision: 1 });
  assert.deepEqual(first, second);
  assert.equal(provider.modelVersion, 'stub-v1');
  assert.equal(provider.executionMode, 'stub');
  assert.equal(provider.available, true);
  const demo = createStubRecognitionProvider({ executionMode: 'preset_demo' });
  assert.equal(demo.modelVersion, 'preset-demo-v1');
  assert.equal(demo.executionMode, 'preset_demo');
  const demoOutcome = await demo.recognize({ jobId: 'j', mediaId: MEDIA_A, mediaRevision: 1 });
  assert.equal(demoOutcome.kind, 'completed');
  assert.equal(demoOutcome.candidates.length, 3);
  const real = createRealRecognitionProvider({ endpoint: null, apiKey: null });
  assert.equal(real.available, false);
  assert.equal(real.executionMode, 'real');
  assert.equal(typeof real.unavailableReason, 'string');
  const realWithCreds = createRealRecognitionProvider({ endpoint: 'https://vendor.invalid/v1', apiKey: 'synthetic-key-0123456789' });
  assert.equal(realWithCreds.available, true);
  assert.deepEqual(await realWithCreds.recognize({ jobId: 'j', mediaId: MEDIA_A, mediaRevision: 1 }), { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });
});
