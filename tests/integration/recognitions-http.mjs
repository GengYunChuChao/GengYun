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
const TERMINAL = ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'];
const observations = [];

const app = buildApp({
  config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
  recognitionStore: createMemoryRecognitionStore(),
  recognitionProvider: createStubRecognitionProvider(),
  recognitionMedia: createSubstituteMediaPort(),
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
