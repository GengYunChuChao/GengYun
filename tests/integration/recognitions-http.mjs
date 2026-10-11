// GY-I09 隔离集成回归：本机 loopback **真实 HTTP**（127.0.0.1 + fetch），
// execution_mode=stub + 合成身份 + 内存 store；走通 create → get → selection → delete。
//
// 运行：node tests/integration/recognitions-http.mjs
// 退出码 0 表示通过；任何断言失败以非 0 退出并打印原始断言。
//
// 边界（如实标注）：不接数据库（内存 store）、不接真实微信登录（合成身份）、
// 不接真实识别供应商（替身）、不上传真实照片（替身媒体引用）。
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryRecognitionStore } from '../../services/api/src/recognitions/store.ts';
import { createSubstituteMediaPort } from '../../services/api/src/recognitions/media.ts';
import { createStubRecognitionProvider } from '../../services/api/src/recognitions/provider.ts';

const MEDIA_ID = '11111111-1111-4111-8111-111111111111';
// 替身脚本按 media_id 的 sha256 分桶（provider.ts 有注释）；该 id 落在「候选全无分数」桶，
// 用于在真实 HTTP 上观测 uncertain 分支。
const MEDIA_ID_UNCERTAIN = '77777777-7777-4777-8777-777777777777';
// 该 id 让包装后的提供者**悬挂**，用于在真实 HTTP 上观测取消与取消重放。
const MEDIA_ID_HANG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TERMINAL = ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'];
const observations = [];

// 计数包装：用于断言「并发同键只调用提供者一次」（返修轮 1 [P1] 的独立取证）。
let providerCalls = 0;
const baseProvider = createStubRecognitionProvider();
const countingProvider = {
  ...baseProvider,
  async recognize(input) {
    providerCalls += 1;
    if (input.mediaId === MEDIA_ID_HANG) return new Promise(() => {});
    return baseProvider.recognize(input);
  },
};

const app = buildApp({
  config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
  recognitionStore: createMemoryRecognitionStore(),
  recognitionProvider: countingProvider,
  recognitionMedia: createSubstituteMediaPort(),
  // 悬挂场景用较短截止时间，避免集成脚本退出时被 30s 定时器拖住。
  recognitionJobDeadlineMs: 2500,
});

async function main() {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.equal(typeof address, 'object');
  const origin = 'http://127.0.0.1:' + address.port;
  observations.push('loopback origin=' + origin);

  async function http(path, options = {}) {
    const response = await fetch(origin + path, options);
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    return { status: response.status, body, etag: response.headers.get('etag'), cache: response.headers.get('cache-control') };
  }
  const json = (token, extra = {}) => ({
    ...extra,
    headers: {
      // 只在带请求体时声明 JSON：DELETE 无体请求若带 application/json 会被解析器判 400。
      ...(extra.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(extra.headers ?? {}),
    },
  });

  // —— 合成身份（替身登录，非真实微信） ——
  const login = await http('/api/v1/auth/wechat', json(null, {
    method: 'POST', headers: { 'idempotency-key': 'integration-login-a' }, body: JSON.stringify({ code: 'synthetic-integration-a' }),
  }));
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const token = login.body.data.access_token;
  assert.equal(typeof token, 'string');
  const other = await http('/api/v1/auth/wechat', json(null, {
    method: 'POST', headers: { 'idempotency-key': 'integration-login-b' }, body: JSON.stringify({ code: 'synthetic-integration-b' }),
  }));
  const otherToken = other.body.data.access_token;

  // —— create（202 JobEnvelope，state=queued） ——
  const created = await http('/api/v1/recognitions', json(token, {
    method: 'POST', headers: { 'idempotency-key': 'integration-create-0001' },
    body: JSON.stringify({ media_id: MEDIA_ID, media_revision: 1 }),
  }));
  assert.equal(created.status, 202, JSON.stringify(created.body));
  assert.equal(created.body.data.state, 'queued');
  assert.equal(created.body.meta.execution_mode, 'stub');
  assert.equal(created.cache, 'no-store');
  const jobId = created.body.data.id;
  const recognitionId = created.body.data.target_ref.id;
  observations.push('create job=' + jobId + ' recognition=' + recognitionId + ' state=' + created.body.data.state);

  // —— 轮询 getJob 直到终态 ——
  let job = created.body.data;
  for (let i = 0; i < 200 && !TERMINAL.includes(job.state); i += 1) {
    const r = await http('/api/v1/jobs/' + jobId, json(token));
    assert.equal(r.status, 200);
    job = r.body.data;
    if (!TERMINAL.includes(job.state)) await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(TERMINAL.includes(job.state), '任务未到达终态：' + job.state);
  observations.push('final state=' + job.state + ' error_code=' + JSON.stringify(job.error_code) + ' model_version=' + job.result.value.model_version);
  // 该桶替身只给 2 条候选：**不得补造**第 3 条。
  assert.equal(job.state, 'succeeded');
  assert.equal(job.error_code, null);
  assert.equal(job.result.value.candidates.length, 2, '候选少于 3 条不得补造');
  assert.deepEqual(job.result.value.uncertainty_reasons, []);
  for (const candidate of job.result.value.candidates) assert.equal(typeof candidate.model_score, 'number');

  // —— get（RecognitionEnvelope + ETag + no-store） ——
  const got = await http('/api/v1/recognitions/' + recognitionId, json(token));
  assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.equal(got.etag, '"1"');
  assert.equal(got.cache, 'no-store');
  assert.deepEqual(got.body.data.candidates, job.result.value.candidates);

  // —— 越权（他人任务）一律 404 NOT_FOUND ——
  const foreign = await http('/api/v1/recognitions/' + recognitionId, json(otherToken));
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.error.code, 'NOT_FOUND');

  // —— selection（模型原始字段不变） ——
  const selected = await http('/api/v1/recognitions/' + recognitionId + '/selection', json(token, {
    method: 'PATCH',
    headers: { 'if-match': '"1"', 'idempotency-key': 'integration-select-0001' },
    body: JSON.stringify({ selected_species_id: job.result.value.candidates[0].species_id }),
  }));
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  assert.equal(selected.body.data.selected_species_id, job.result.value.candidates[0].species_id);
  assert.equal(selected.etag, '"2"');
  assert.deepEqual(selected.body.data.candidates, job.result.value.candidates);
  observations.push('selection=' + selected.body.data.selected_species_id + ' revision=' + selected.body.data.revision);

  // —— delete（202 Ack）→ get 404 ——
  const deleted = await http('/api/v1/recognitions/' + recognitionId, json(token, {
    method: 'DELETE',
    headers: { 'if-match': '"2"', 'idempotency-key': 'integration-delete-0001' },
  }));
  assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
  assert.deepEqual(deleted.body.data, { accepted: true });
  const gone = await http('/api/v1/recognitions/' + recognitionId, json(token));
  assert.equal(gone.status, 404);
  observations.push('delete=accepted; get after delete=404');

  // —— uncertain 分支（真实 HTTP）：候选全无分数 → uncertain + 原因，不写分数 ——
  const uncertainCreated = await http('/api/v1/recognitions', json(token, {
    method: 'POST', headers: { 'idempotency-key': 'integration-create-0002' },
    body: JSON.stringify({ media_id: MEDIA_ID_UNCERTAIN, media_revision: 1 }),
  }));
  assert.equal(uncertainCreated.status, 202);
  let uncertainJob = uncertainCreated.body.data;
  for (let i = 0; i < 200 && !TERMINAL.includes(uncertainJob.state); i += 1) {
    const r = await http('/api/v1/jobs/' + uncertainJob.id, json(token));
    uncertainJob = r.body.data;
    if (!TERMINAL.includes(uncertainJob.state)) await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(uncertainJob.state, 'uncertain', '无分数必须落 uncertain');
  assert.ok(uncertainJob.result.value.uncertainty_reasons.length >= 1);
  for (const candidate of uncertainJob.result.value.candidates) {
    assert.equal(candidate.model_score, null, '没有分数时不得写入分数');
  }
  observations.push('uncertain job=' + uncertainJob.id + ' reasons=' + JSON.stringify(uncertainJob.result.value.uncertainty_reasons));

  // —— 返修轮 1 [P1]：同键同体**并发**（真实 HTTP + Promise.all）→ 1 个 job、1 次提供者调用 ——
  const beforeSame = providerCalls;
  const sameKey = 'integration-concurrent-same-0001';
  const concurrentSame = await Promise.all([
    http('/api/v1/recognitions', json(token, { method: 'POST', headers: { 'idempotency-key': sameKey }, body: JSON.stringify({ media_id: MEDIA_ID, media_revision: 1 }) })),
    http('/api/v1/recognitions', json(token, { method: 'POST', headers: { 'idempotency-key': sameKey }, body: JSON.stringify({ media_id: MEDIA_ID, media_revision: 1 }) })),
  ]);
  for (const r of concurrentSame) assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(typeof concurrentSame[0].body.data.id, 'string');
  assert.equal(concurrentSame[0].body.data.id, concurrentSame[1].body.data.id, '并发同键同体必须收敛到同一 job');
  for (let i = 0; i < 200 && providerCalls === beforeSame; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(providerCalls - beforeSame, 1, '并发同键只允许 1 次提供者调用（实际 ' + (providerCalls - beforeSame) + ' 次）');
  observations.push('concurrent same-key: job=' + concurrentSame[0].body.data.id + ' provider_calls=' + (providerCalls - beforeSame) + ' (两个响应同一 job)');

  // —— 返修轮 1 [P1]：同键**异体**并发 → 一个 202 + 一个 409 IDEMPOTENCY_CONFLICT，无第二个任务 ——
  const beforeDiff = providerCalls;
  const diffKey = 'integration-concurrent-diff-0001';
  const concurrentDiff = await Promise.all([
    http('/api/v1/recognitions', json(token, { method: 'POST', headers: { 'idempotency-key': diffKey }, body: JSON.stringify({ media_id: MEDIA_ID, media_revision: 1 }) })),
    http('/api/v1/recognitions', json(token, { method: 'POST', headers: { 'idempotency-key': diffKey }, body: JSON.stringify({ media_id: MEDIA_ID_UNCERTAIN, media_revision: 1 }) })),
  ]);
  const diffStatuses = concurrentDiff.map(r => r.status).sort((a, b) => a - b);
  assert.deepEqual(diffStatuses, [202, 409], JSON.stringify(concurrentDiff.map(r => r.body)));
  const conflict = concurrentDiff.find(r => r.status === 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  for (let i = 0; i < 200 && providerCalls === beforeDiff; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(providerCalls - beforeDiff, 1, '异体并发不得产生第二个任务');
  observations.push('concurrent different-body: statuses=' + JSON.stringify(diffStatuses) + ' conflict=' + conflict.body.error.code + ' provider_calls=' + (providerCalls - beforeDiff));

  // —— 返修轮 1 [P2]：取消成功后原键 + 原 If-Match 原样重放（真实 HTTP）——
  const hangCreated = await http('/api/v1/recognitions', json(token, {
    method: 'POST', headers: { 'idempotency-key': 'integration-cancel-create-0001' },
    body: JSON.stringify({ media_id: MEDIA_ID_HANG, media_revision: 1 }),
  }));
  assert.equal(hangCreated.status, 202);
  let hangJob = hangCreated.body.data;
  for (let i = 0; i < 200 && hangJob.state !== 'running'; i += 1) {
    hangJob = (await http('/api/v1/jobs/' + hangJob.id, json(token))).body.data;
    if (hangJob.state !== 'running') await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(hangJob.state, 'running');
  const cancelKey = 'integration-cancel-key-0001';
  const cancelled = await http('/api/v1/jobs/' + hangJob.id + '/cancel', json(token, {
    method: 'POST', headers: { 'if-match': '"' + hangJob.revision + '"', 'idempotency-key': cancelKey },
  }));
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.data.state, 'cancelled');
  const cancelledRevision = cancelled.body.data.revision;
  const cancelReplay = await http('/api/v1/jobs/' + hangJob.id + '/cancel', json(token, {
    method: 'POST', headers: { 'if-match': '"' + hangJob.revision + '"', 'idempotency-key': cancelKey },
  }));
  assert.equal(cancelReplay.status, 200, JSON.stringify(cancelReplay.body));
  assert.equal(cancelReplay.body.data.state, 'cancelled');
  assert.equal(cancelReplay.body.data.revision, cancelledRevision, '原样重放必须回放同一取消结果');
  const cancelStale = await http('/api/v1/jobs/' + hangJob.id + '/cancel', json(token, {
    method: 'POST', headers: { 'if-match': '"' + hangJob.revision + '"', 'idempotency-key': 'integration-cancel-key-0002' },
  }));
  assert.equal(cancelStale.status, 409);
  assert.equal(cancelStale.body.error.code, 'REVISION_CONFLICT');
  observations.push('cancel=' + cancelledRevision + '; same-key replay -> 200 cancelled revision=' + cancelReplay.body.data.revision + '; new-key stale If-Match -> 409 ' + cancelStale.body.error.code);

  console.log('PASS GY-I09 loopback HTTP integration (synthetic identity + stub provider + memory store)');
  for (const line of observations) console.log('  - ' + line);
}

try {
  await main();
} catch (error) {
  console.error('FAIL GY-I09 loopback HTTP integration');
  console.error(error);
  process.exitCode = 1;
} finally {
  await app.close();
}
