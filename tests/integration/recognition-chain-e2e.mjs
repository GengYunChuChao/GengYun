/**
 * GY-I06 / I08 / I09 / I10 · 「上传识别 → 拿结果 → 看可信度与理由 → 加入识别历史 →
 * 从历史读回 → 删除历史 → 再读为空」**端到端**链路验收（本机 loopback **真实 HTTP** + fetch）。
 *
 * 运行：
 *   node tests/integration/recognition-chain-e2e.mjs
 *     ⇒ 只跑「内存臂」；真库臂**显式打印 SKIP 并以 77 退出**（＝未取得，不是通过；
 *       POSIX「skipped」惯例：跳过即未取得，⛔ 不得把 77 读成门禁通过）。
 *   npm run test:integration:recognition-chain-pg
 *     ⇒ 上面那条 ＋ 必带 env。本脚本**不进**无库的 `test:integration:http` 链：缺库即 77，
 *       挂进无库链只会让整链显式失败（合流后按 #312「跳过即未取得」的判据处理）。
 *   RECOGNITION_CHAIN_PG_TEST_URL=postgres://postgres@127.0.0.1:PORT/gengyun_recognition_chain_test \
 *   node tests/integration/recognition-chain-e2e.mjs
 *     ⇒ 内存臂 + 真 PG17 臂（身份与历史都落真库，另有独立连接直查表行）。
 *
 * 两条臂的差别**只有存储**：识别替身提供者/替身媒体/内存识别 store 在两条臂中完全相同
 * （仓内**不存在** PG 识别 store，见交接记录；识别记录只活在进程内）。
 *
 * 本文件**不**证明的事（如实标注，不硬凑）：
 *   - 真实识别供应商：仓内无凭据，`createRealRecognitionProvider` fail-closed（`real` 模式
 *     上传会 503 `PROVIDER_UNAVAILABLE`），本脚本全程 stub 替身 + 合成 media_id；
 *   - 真实图片上传：替身媒体端口只按 media_id 派候选，不解码图像；
 *   - 微信登录 / 微信开发者工具 / 真机证据：合成身份码，无微信侧调用；
 *   - 「同分候选 ⇒ uncertain」：#299 已并入 main（`ab7c31f`），同分并列判定规则已在产品代码内（`state.ts`
 *     头注释＋`REASON_TIED_TOP_SCORE`）；**本脚本仍未覆盖该路径**（替身不产出同分候选、脚本未构造该输入）⇒ 登记未取得（订正 2026-10-20，实测 main `df043a7`）。
 *
 * 退出码：三档，跳过＝未取得（`--allow-skip`／`GY_ALLOW_SKIP=1` 仅本机开发，⛔ 不得进门禁）：
 *   0  —— 内存臂（以及设置了 env 时的真库臂）全部通过；
 *   77 —— 真库臂**未取得**（`RECOGNITION_CHAIN_PG_TEST_URL` 未设置）：
 *         POSIX「skipped」惯例，本次运行没有验证真库持久化；
 *   1  —— 任一断言失败（打印原始断言与实测读数，不吞错）。
 */
import assert from 'node:assert/strict';
import pg from 'pg';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createPool } from '../../services/api/src/db/pool.ts';
import { applyMigrations, discoverMigrations } from '../../services/api/src/db/migrate.ts';
import { createPostgresAuthStore } from '../../services/api/src/auth/store.ts';
import { createPostgresHistoryStore } from '../../services/api/src/history/store-pg.ts';
import { createMemoryRecognitionStore } from '../../services/api/src/recognitions/store.ts';
import { createSubstituteMediaPort } from '../../services/api/src/recognitions/media.ts';
import { createStubRecognitionProvider } from '../../services/api/src/recognitions/provider.ts';

const API = '/api/v1';
const HISTORY = `${API}/history`;
const RECOGNITIONS = `${API}/recognitions`;
const TERMINAL = ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'];

/** 契约 History 投影的**完整**键集（多一个少一个都算投影漂移）。 */
const HISTORY_KEYS = ['created_at', 'id', 'job_state', 'kind', 'reference_state', 'revision', 'target_ref'];

/** 契约里必然不存在的历史 id（用于「他人 id」与「不存在」同形对照）。 */
const ABSENT_ID = '00000000-0000-4000-8f00-0000000000ff';

/**
 * 合成 media_id（无真实图像；替身媒体端口只按 media_id 的 sha256 分桶派候选）：
 *   - `MEDIA_SYNTH` 落在「有分数候选」桶 ⇒ 终态 `succeeded`；
 *   - `MEDIA_UNCERTAIN` 落在「候选无分数」桶 ⇒ 终态 `uncertain` + 如实原因。
 * 分桶口径见 `services/api/src/recognitions/provider.ts`（本脚本只断言**派生事实**，
 * 不断言阈值、不复制分桶算法）。
 */
const MEDIA_SYNTH = '11111111-1111-4111-8111-111111111111';
const MEDIA_UNCERTAIN = '77777777-7777-4777-8777-777777777777';

const PG_ENV = 'RECOGNITION_CHAIN_PG_TEST_URL';
const PG_RESET_ENV = 'RECOGNITION_CHAIN_PG_RESET';
const PG_TEST_DB = '/gengyun_recognition_chain_test';
// 「跳过即未取得」：缺库时默认以 77 退出（POSIX skipped 惯例），只有显式授权才降为 0。
const ALLOW_SKIP = process.argv.includes('--allow-skip') || process.env.GY_ALLOW_SKIP === '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 证据行：每条都带臂名与步骤名，便于在验收页里逐行引用「实测」。 */
const evidence = [];
function note(armName, step, message) {
  const line = `[GY-RECOG-E2E] arm=${armName} step=${step} ${message}`;
  evidence.push(line);
  console.log(line);
}

/** 全局单调幂等键：同一个 label 调两次必须拿到**不同**键（同键才是重放）。 */
let keySeq = 0;
function idem(label) {
  keySeq += 1;
  return `gy-recog-chain-${label}-${String(keySeq).padStart(4, '0')}`;
}

/** 监听中的服务集合：任一臂失败也要全部关掉，否则事件循环不退出（诚实失败，不挂死）。 */
const listeners = new Set();

async function http(origin, token, method, path, options = {}) {
  const headers = { accept: 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const init = { method, headers };
  // 只在**有 body**时加 content-type：DELETE 无体带 application/json 会被判 400。
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
  }
  Object.assign(headers, options.headers ?? {});
  const res = await fetch(`${origin}${path}`, init);
  const text = await res.text();
  let body = null;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  return {
    status: res.status,
    body,
    cache: res.headers.get('cache-control'),
    etag: res.headers.get('etag'),
    cascade: res.headers.get('x-gy-cascade'),
  };
}

async function login(origin, code, who) {
  const res = await http(origin, null, 'POST', `${API}/auth/wechat`, {
    body: { code },
    headers: { 'idempotency-key': idem(`login-${who}`) },
  });
  assert.equal(res.status, 200, `登录必须 200（${who}）：${JSON.stringify(res.body)}`);
  assert.equal(res.body.data.token_type, 'Bearer');
  assert.equal(typeof res.body.data.access_token, 'string');
  // 会话投影**不**含主体 id（否则等于把 userId 发到客户端）：主体身份只能由服务端持有。
  for (const forbidden of ['user_id', 'userId', 'subject']) {
    assert.equal(Object.hasOwn(res.body.data, forbidden), false, `会话投影不得含 ${forbidden}`);
  }
  return res.body.data.access_token;
}

/**
 * `POST /recognitions`。
 *
 * `allowTerminal`：**同键重放**用。幂等回放返回的是同一任务的**当前**投影（任务早已终态时
 * `state` 就是终态，不是受理瞬间的快照）—— 这一点如实记录，不强行断言 `queued`。
 */
async function upload(origin, token, mediaId, key, { allowTerminal = false } = {}) {
  const res = await http(origin, token, 'POST', RECOGNITIONS, {
    body: { media_id: mediaId, media_revision: 1 },
    headers: { 'idempotency-key': key },
  });
  assert.equal(res.status, 202, `上传识别必须 202：${JSON.stringify(res.body)}`);
  assert.equal(res.body.meta.execution_mode, 'stub');
  assert.equal(res.body.data.kind, 'recognition');
  assert.ok(
    ['queued', ...TERMINAL].includes(res.body.data.state),
    `任务状态必须在闭集内，实测 ${res.body.data.state}`,
  );
  if (!allowTerminal) {
    assert.equal(res.body.data.state, 'queued', '受理即 queued，不在请求里同步返回结果');
  }
  assert.equal(res.cache, 'no-store', '任务面响应不得可缓存');
  return { res, jobId: res.body.data.id, recognitionId: res.body.data.target_ref.id, state: res.body.data.state };
}

async function waitJob(origin, token, jobId, budgetMs = 3000) {
  const started = Date.now();
  for (;;) {
    const res = await http(origin, token, 'GET', `${API}/jobs/${jobId}`);
    assert.equal(res.status, 200, `轮询任务必须 200：${JSON.stringify(res.body)}`);
    if (TERMINAL.includes(res.body.data.state)) return { job: res.body.data, elapsed: Date.now() - started };
    if (Date.now() - started > budgetMs) {
      throw new Error(`任务 ${jobId} 未在 ${budgetMs}ms 内到终态（当前 ${res.body.data.state}）`);
    }
    await sleep(10);
  }
}

/**
 * 等历史行出现（**有界轮询**，不靠 sleep 猜）。
 *
 * 为什么必须轮询：`recognitions/service.ts` 的 `commitTerminal` 先 CAS 提交终态、**之后**才
 * `await recordTerminalHistory(...)`（端口异常还被吞掉只记告警）⇒ `GET /jobs/{id}` 已能看到
 * 终态时，历史行**可能**还没落库。实测延迟写在证据行里（`appeared_after_job`）。
 */
async function waitHistoryFor(origin, token, recognitionId, budgetMs = 3000) {
  const started = Date.now();
  for (;;) {
    const res = await http(origin, token, 'GET', HISTORY);
    assert.equal(res.status, 200, `历史列表必须 200：${JSON.stringify(res.body)}`);
    assert.equal(res.cache, 'no-store');
    assert.equal(res.etag, null, '历史列表无 ETag（不是可协商缓存的表示）');
    const items = res.body.data.items;
    const hit = items.filter((item) => item.target_ref?.id === recognitionId);
    if (hit.length === 1) return { items, hit: hit[0], elapsed: Date.now() - started };
    if (hit.length > 1) throw new Error(`同一识别挂了 ${hit.length} 条历史：${JSON.stringify(hit)}`);
    if (Date.now() - started > budgetMs) {
      throw new Error(`历史行未在 ${budgetMs}ms 内出现（recognition=${recognitionId}，当前 items=${JSON.stringify(items)}）`);
    }
    await sleep(10);
  }
}

async function listHistory(origin, token) {
  const res = await http(origin, token, 'GET', HISTORY);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res;
}

function deleteHistory(origin, token, id, revision, key) {
  return http(origin, token, 'DELETE', `${HISTORY}/${id}`, {
    headers: { 'idempotency-key': key, 'if-match': `"${revision}"` },
  });
}

function listItems(body) {
  return body.data.items;
}

/** 计数包装：重放不得再触发第二次提供者调用（也即不得产生第二个任务）。 */
function countingProvider(counter) {
  const base = createStubRecognitionProvider();
  return {
    ...base,
    async recognize(input) {
      counter.calls += 1;
      return base.recognize(input);
    },
  };
}

function buildArm(name, overrides) {
  const counter = { calls: 0 };
  const app = buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    recognitionStore: createMemoryRecognitionStore(),
    recognitionProvider: countingProvider(counter),
    recognitionMedia: createSubstituteMediaPort(),
    // 悬挂/超时分支不在本链路断言范围内；给个短截止避免退出时被定时器拖住。
    recognitionJobDeadlineMs: 2500,
    ...overrides,
  });
  return { name, app, counter, db: overrides.__db ?? null };
}

// ---------------------------------------------------------------------------
// 链路本体：两条臂跑**同一段**断言（只有存储不同）
// ---------------------------------------------------------------------------

async function runChain(arm) {
  const { name: armName, app, counter } = arm;
  await app.listen({ host: '127.0.0.1', port: 0 });
  listeners.add(app);
  const address = app.server.address();
  assert.ok(address !== null && typeof address === 'object', 'listen 后必须拿得到端口');
  const origin = `http://127.0.0.1:${address.port}`;
  const storeNote = armName.includes('pg')
    ? 'postgres(identity+history)/memory(recognition)'
    : 'memory(identity+history+recognition)';
  note(armName, 'start', `loopback origin=${origin} execution_mode=stub provider=substitute store=${storeNote}`);

  // === 步骤 1（#6 识别入口）身份：两个合成账号，B 只用来做越权对照 ===
  const tokenA = await login(origin, 'synthetic-recog-chain-a', 'a');
  const tokenB = await login(origin, 'synthetic-recog-chain-b', 'b');
  note(armName, 'i06-login', '两个合成账号登录成功（会话投影不含 userId）');

  // === 步骤 2（#6）：上传受理 ⇒ jobId + 识别记录 id ===
  const uploadKey = idem('upload-a');
  const first = await upload(origin, tokenA, MEDIA_SYNTH, uploadKey);
  assert.match(first.jobId, /^[0-9a-f-]{36}$/, 'jobId 必须是 uuid');
  assert.match(first.recognitionId, /^[0-9a-f-]{36}$/, '识别记录 id 必须是 uuid');
  assert.notEqual(first.jobId, first.recognitionId, '任务 id 与识别记录 id 不是同一个东西');
  note(armName, 'i06-upload', `status=202 job=${first.jobId} recognition=${first.recognitionId} state=queued cache=no-store`);

  // 同一 Idempotency-Key 重放：必须收敛到**同一个**任务/识别记录，且不产生第二条任务。
  const replayCreate = await upload(origin, tokenA, MEDIA_SYNTH, uploadKey, { allowTerminal: true });
  assert.equal(replayCreate.jobId, first.jobId, '同一请求键重放必须回放同一个 job');
  assert.equal(replayCreate.recognitionId, first.recognitionId);
  note(
    armName,
    'i06-replay',
    `同键重放 ⇒ 同一 job=${replayCreate.jobId} recognition=${replayCreate.recognitionId}（回放的是该任务**当前**投影 state=${replayCreate.state}）`,
  );

  // === 步骤 3（#8）：拿结果 ===
  const { job, elapsed: jobMs } = await waitJob(origin, tokenA, first.jobId);
  assert.equal(job.state, 'succeeded', `替身在该 media 上必须给可信结果：${JSON.stringify(job)}`);
  assert.equal(job.error_code, null);
  assert.deepEqual(job.target_ref, { type: 'recognition', id: first.recognitionId, revision: 1 });
  assert.equal(job.result.kind, 'recognition');
  const value = job.result.value;
  assert.equal(value.id, first.recognitionId);
  assert.equal(typeof value.model_version, 'string');
  assert.ok(value.model_version.length > 0, '结果必须带模型版本');
  assert.ok(Array.isArray(value.candidates) && value.candidates.length >= 1, '成功结果必须至少有一条候选');
  assert.ok(value.candidates.length <= 3, '候选不得超过契约上限 3 条');
  // 替身对 MEDIA_SYNTH 的确定性产出就是 2 条：少给不行，**补造第 3 条也不行**（只断上界挡不住补造）。
  assert.equal(value.candidates.length, 2, '该媒体只有 2 条候选 ⇒ 不得补造第 3 条');
  // rank 1..n 连续且唯一；species_id 非空字符串；分数为 number|null（不得是字符串/NaN）。
  value.candidates.forEach((candidate, index) => {
    assert.equal(candidate.rank, index + 1, `候选 rank 必须 1..n 连续：${JSON.stringify(value.candidates)}`);
    assert.equal(typeof candidate.species_id, 'string');
    assert.ok(candidate.species_id.length > 0);
    assert.ok(candidate.model_score === null || typeof candidate.model_score === 'number');
    assert.equal(Object.hasOwn(candidate, 'category'), false, '候选投影不得自造 category 字段');
  });
  // 「至少一项可信度依据」：本条链路取 类别（species_id）+ 置信度（model_score）。
  assert.ok(
    value.candidates.some((candidate) => typeof candidate.model_score === 'number' && Number.isFinite(candidate.model_score)),
    '成功结果必须至少有一条**带分数**的候选（否则「可信」无依据）',
  );
  assert.deepEqual(value.uncertainty_reasons, [], 'succeeded 不得携带不确定原因（否则是自相矛盾的投影）');
  assert.equal(value.selected_species_id, null, '识别结果不自带「已选中」事实');
  note(
    armName,
    'i08-result',
    `job=${job.id} state=succeeded elapsed=${jobMs}ms model_version=${value.model_version} candidates=${JSON.stringify(value.candidates)} reasons=[]`,
  );

  // === 步骤 4（#8）：结果面按识别 id 读回，且与任务面**同形** ===
  const readBack = await http(origin, tokenA, 'GET', `${RECOGNITIONS}/${first.recognitionId}`);
  assert.equal(readBack.status, 200, JSON.stringify(readBack.body));
  assert.equal(readBack.cache, 'no-store');
  assert.equal(readBack.etag, '"1"', '识别结果以强 ETag 暴露 revision');
  assert.deepEqual(readBack.body.data, value, '任务面与结果面必须是同一份投影（不得两套字段）');
  note(armName, 'i08-readback', `GET ${RECOGNITIONS}/{id} ⇒ 200 etag=${readBack.etag} 与 job.result.value 逐字段相等`);

  // === 步骤 5（#8）：低可信/不确定必须**显式**区分，且不得补造分数（不断言阈值）===
  const uncertain = await upload(origin, tokenA, MEDIA_UNCERTAIN, idem('upload-uncertain'));
  const { job: uncertainJob } = await waitJob(origin, tokenA, uncertain.jobId);
  assert.ok(TERMINAL.includes(uncertainJob.state));
  assert.equal(uncertainJob.state, 'uncertain', `该 media 必须落 uncertain：${JSON.stringify(uncertainJob)}`);
  assert.notEqual(uncertainJob.state, job.state, '「可信」与「不确定」必须在终态上可区分');
  assert.equal(uncertainJob.error_code, null, 'uncertain 不是 failed：不写错误码');
  const uncertainValue = uncertainJob.result.value;
  assert.ok(
    Array.isArray(uncertainValue.uncertainty_reasons) && uncertainValue.uncertainty_reasons.length >= 1,
    'uncertain 必须带至少一条如实原因',
  );
  uncertainValue.uncertainty_reasons.forEach((reason) => {
    assert.equal(typeof reason, 'string');
    assert.ok(reason.trim().length > 0);
  });
  // 候选若存在而分数缺失 ⇒ 必须保持 null（服务端不得「补」一个看起来可信的分数）。
  assert.ok(
    uncertainValue.candidates.every((candidate) => candidate.model_score === null),
    `无分数候选不得被补造分数：${JSON.stringify(uncertainValue.candidates)}`,
  );
  note(
    armName,
    'i08-uncertain',
    `job=${uncertainJob.id} state=uncertain candidates=${JSON.stringify(uncertainValue.candidates)} reasons=${JSON.stringify(uncertainValue.uncertainty_reasons)}`,
  );
  // #299 已并入 main（ab7c31f），同分规则已在产品代码内；本脚本仍未覆盖该路径 ⇒ 如实登记「未取得」（订正 2026-10-20）。
  note(
    armName,
    'skip-tie',
    'SKIP 同分候选区分：#299 已并入 main（ab7c31f），同分规则已在产品代码内；本脚本仍未覆盖该路径（替身不产出同分候选、脚本未构造该输入）⇒ 登记「未取得」，不写死期望',
  );

  // === 步骤 6（#9）：终态落历史，且历史如实保留终态 ===
  const arrived = await waitHistoryFor(origin, tokenA, first.recognitionId);
  const historyRow = arrived.hit;
  assert.deepEqual(Object.keys(historyRow).sort(), [...HISTORY_KEYS].sort(), '历史投影键集必须恰等契约集合');
  assert.equal(Object.hasOwn(historyRow, 'owner_id'), false, '投影不得把 owner_id 发给客户端');
  assert.equal(historyRow.kind, 'recognition');
  assert.equal(historyRow.job_state, 'succeeded');
  assert.equal(historyRow.revision, 1);
  assert.deepEqual(historyRow.target_ref, { type: 'recognition', id: first.recognitionId, revision: 1 });
  assert.equal(Number.isNaN(Date.parse(historyRow.created_at)), false, 'created_at 必须是可解析时间');
  // 无库读面（stub + 无 knowledge 读面）⇒ 如实 unavailable，而不是假装核验过。
  assert.equal(historyRow.reference_state, 'unavailable');
  note(
    armName,
    'i09-history',
    `history=${historyRow.id} rev=${historyRow.revision} created_at=${historyRow.created_at} target=${JSON.stringify(historyRow.target_ref)} job_state=${historyRow.job_state} reference_state=${historyRow.reference_state} appeared_after_job=${arrived.elapsed}ms`,
  );

  const uncertainRow = (await waitHistoryFor(origin, tokenA, uncertain.recognitionId)).hit;
  assert.equal(uncertainRow.job_state, 'uncertain', '非成功终态也要如实入历史，不得改写成 succeeded');
  assert.equal(uncertainRow.kind, 'recognition');
  note(armName, 'i09-history-uncertain', `history=${uncertainRow.id} job_state=${uncertainRow.job_state}（非成功终态原样保留）`);

  // 重放创建口不得多出第二条历史（同一任务的 event_key 去重）。
  const replayAgain = await upload(origin, tokenA, MEDIA_SYNTH, uploadKey, { allowTerminal: true });
  assert.equal(replayAgain.jobId, first.jobId);
  const afterReplay = await listHistory(origin, tokenA);
  assert.equal(
    listItems(afterReplay.body).filter((item) => item.target_ref.id === first.recognitionId).length,
    1,
    '同一请求键重放不得产生第二条历史',
  );
  assert.equal(counter.calls, 2, `两次上传应对应恰好两次提供者调用（实测 ${counter.calls}）`);
  note(armName, 'i09-replay', `重放后该识别历史条数=1；提供者累计调用=${counter.calls}`);

  // === 步骤 7（#9）：从历史读回 + 时间序稳定 ===
  const reads = [];
  for (let i = 0; i < 3; i += 1) reads.push((await listHistory(origin, tokenA)).body.data);
  assert.equal(reads[0].items.length, 2, '本链路应恰好两条历史（成功 + 不确定）');
  const firstIds = reads[0].items.map((item) => item.id);
  for (const read of reads.slice(1)) {
    assert.deepEqual(read.items.map((item) => item.id), firstIds, '重复读取必须给出同一顺序（时间序稳定）');
  }
  const times = reads[0].items.map((item) => Date.parse(item.created_at));
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(
      times[i - 1] >= times[i],
      `历史必须按 created_at 倒序：${JSON.stringify(reads[0].items.map((item) => item.created_at))}`,
    );
  }
  assert.equal(reads[0].next_cursor, null, '两条不超页，next_cursor 必须为 null');
  note(armName, 'i09-stable', `3 次读取 id 顺序一致=${JSON.stringify(firstIds)} created_at 倒序成立`);

  // === 步骤 7b（真库臂专属）：删除**之前**用独立连接直查表行，证明真的落库 ===
  // 必须在删除前查：链路的最后一步会把行物理删掉（这正是 #10 的要求），删完再查只能看到 0 行。
  if (arm.db !== null) {
    const { owner } = arm.db;
    const rows = await owner.query(
      'SELECT id, owner_id, kind, target_type, target_id, target_revision, revision, job_id, job_state, event_key FROM history WHERE job_id = $1',
      [first.jobId],
    );
    assert.equal(rows.rowCount, 1, `真库中该任务必须恰好一行历史（实测 ${rows.rowCount}）`);
    const row = rows.rows[0];
    assert.equal(row.kind, 'recognition');
    assert.equal(row.target_type, 'recognition');
    assert.equal(row.target_id, first.recognitionId);
    assert.equal(row.target_revision, 1);
    assert.equal(row.revision, 1);
    assert.equal(row.job_state, 'succeeded');
    assert.equal(row.event_key, `recognition:${first.jobId}`, 'event_key 必须是确定性键（同任务重复投递 no-op）');

    const users = await owner.query('SELECT id FROM users ORDER BY created_at, id');
    assert.equal(users.rowCount, 2, '两个合成账号必须真落 users 表');
    assert.ok(
      users.rows.some((candidate) => candidate.id === row.owner_id),
      'history.owner_id 必须指向真库 users 行（外键成立）',
    );
    const others = await owner.query('SELECT count(*)::int AS n FROM history WHERE owner_id <> $1', [row.owner_id]);
    assert.equal(others.rows[0].n, 0, 'B 不得有任何历史行');
    const byEvent = await owner.query('SELECT count(*)::int AS n FROM history WHERE owner_id = $1 AND event_key = $2', [
      row.owner_id,
      `recognition:${first.jobId}`,
    ]);
    assert.equal(byEvent.rows[0].n, 1, '同一 (owner,event_key) 只允许一行');
    note(
      armName,
      'pg-rows',
      `直查 history：job_id=${first.jobId} owner=${row.owner_id} event_key=${row.event_key} job_state=${row.job_state} target=${row.target_type}:${row.target_id}@${row.target_revision}；users=${users.rowCount} 行；他人历史=0；(owner,event_key) 唯一=1 行`,
    );
  }

  // === 步骤 8（#16 跨用户隔离 / IDOR）：B 读不到 A 的任何东西 ===
  const bList = await listHistory(origin, tokenB);
  assert.deepEqual(bList.body.data, { items: [], next_cursor: null }, 'B 的历史必须为空');
  const bReadRecognition = await http(origin, tokenB, 'GET', `${RECOGNITIONS}/${first.recognitionId}`);
  const absentRecognition = await http(origin, tokenB, 'GET', `${RECOGNITIONS}/${ABSENT_ID}`);
  assert.equal(bReadRecognition.status, 404, '他人识别记录不得可读');
  assert.equal(bReadRecognition.body.error.code, 'NOT_FOUND');
  assert.deepEqual(bReadRecognition.body.error, absentRecognition.body.error, '他人 id 与不存在 id 的错误体必须同形');
  // 契约没有 `GET /history/{id}`（只有 DELETE）⇒ 直读历史详情无此路径，如实登记。
  const bReadHistory = await http(origin, tokenB, 'GET', `${HISTORY}/${historyRow.id}`);
  assert.equal(bReadHistory.status, 404, '契约未注册 GET /history/{id} ⇒ 不得悄然长出读详情路径');
  const bDeleteForeign = await deleteHistory(origin, tokenB, historyRow.id, historyRow.revision, idem('del-foreign'));
  assert.equal(bDeleteForeign.status, 404, '他人历史不得可删');
  assert.equal(bDeleteForeign.body.error.code, 'NOT_FOUND');
  const bListAfter = await listHistory(origin, tokenB);
  assert.deepEqual(bListAfter.body.data, { items: [], next_cursor: null });
  const aListAfterB = await listHistory(origin, tokenA);
  assert.equal(listItems(aListAfterB.body).length, 2, 'B 的越权尝试不得动到 A 的行');
  note(
    armName,
    'i16-idor',
    `B 列表=空；B 读 A 识别=${bReadRecognition.status}（与不存在同形=${JSON.stringify(bReadRecognition.body.error) === JSON.stringify(absentRecognition.body.error)}）；B 删 A 历史=${bDeleteForeign.status} ${bDeleteForeign.body.error.code}；A 历史仍=2 条`,
  );

  // === 步骤 9（#10）：删除历史 ===
  const deleteKey = idem('del-own');
  const removed = await deleteHistory(origin, tokenA, historyRow.id, historyRow.revision, deleteKey);
  assert.equal(removed.status, 200, `删除历史必须 200：${JSON.stringify(removed.body)}`);
  assert.deepEqual(removed.body.data, { accepted: true });
  assert.equal(removed.body.meta.execution_mode, 'stub');
  assert.ok(
    ['initiated', 'unwired', 'failed'].includes(removed.cascade),
    `X-GY-Cascade 必须在闭集内，实测 ${removed.cascade}`,
  );
  const afterFirstDelete = await listHistory(origin, tokenA);
  assert.deepEqual(
    listItems(afterFirstDelete.body).map((item) => item.id),
    [uncertainRow.id],
    '只删被点的那一条（另一条不受影响）',
  );
  note(
    armName,
    'i10-delete',
    `history=${historyRow.id} status=200 accepted=true cascade=${removed.cascade}；剩余=${listItems(afterFirstDelete.body).length} 条`,
  );

  // 删第二条 ⇒ 再读为空。
  const removedSecond = await deleteHistory(origin, tokenA, uncertainRow.id, uncertainRow.revision, idem('del-own-2'));
  assert.equal(removedSecond.status, 200, JSON.stringify(removedSecond.body));
  const emptyList = await listHistory(origin, tokenA);
  assert.deepEqual(emptyList.body.data, { items: [], next_cursor: null }, '两条都删完后必须为空');
  assert.equal(emptyList.etag, null, '空列表同样无 ETag');
  note(armName, 'i10-empty', `全部删除后 GET ${HISTORY} ⇒ ${JSON.stringify(emptyList.body.data)}`);

  // === 步骤 10（#10）：删除后的重放与重复删除语义 ===
  // (a) **同键重放**：幂等台账回放同一结果 ⇒ 200（不是又删了一次，也不复活数据）。
  const replayDelete = await deleteHistory(origin, tokenA, historyRow.id, historyRow.revision, deleteKey);
  assert.equal(replayDelete.status, 200, '同键重放必须回放首次结果 200');
  assert.deepEqual(replayDelete.body.data, { accepted: true });
  assert.equal(replayDelete.cascade, removed.cascade, '重放必须回放同一份级联披露');
  assert.deepEqual((await listHistory(origin, tokenA)).body.data, { items: [], next_cursor: null }, '重放不得复活历史');
  // (b) **换新键**再删同一条 ⇒ 行已不存在 ⇒ 404，且与「完全不存在 id」的 404 逐字段同形。
  const secondDelete = await deleteHistory(origin, tokenA, historyRow.id, historyRow.revision, idem('del-own-again'));
  const absentDelete = await deleteHistory(origin, tokenA, ABSENT_ID, 1, idem('del-absent'));
  assert.equal(secondDelete.status, 404, '行已删除时换键再删必须 404（不幂等回放 200）');
  assert.equal(secondDelete.body.error.code, 'NOT_FOUND');
  assert.deepEqual(secondDelete.body.error, absentDelete.body.error, '已删除 id 与不存在 id 必须同形');
  // 对不存在 id 用错版本头仍是 404（不因版本检查泄露存在性）。
  assert.equal(absentDelete.status, 404);
  note(
    armName,
    'i10-delete-again',
    `同键重放=${replayDelete.status} accepted=true cascade=${replayDelete.cascade}；换键再删=${secondDelete.status} ${secondDelete.body.error.code}（与不存在同形=${JSON.stringify(secondDelete.body.error) === JSON.stringify(absentDelete.body.error)}）`,
  );

  // === 步骤 11（真库臂专属）：删除后直查真库，确认是**物理删除**且未连带删账号 ===
  if (arm.db !== null) {
    const { owner } = arm.db;
    const total = await owner.query('SELECT count(*)::int AS n FROM history');
    assert.equal(total.rows[0].n, 0, `删除后真库不得残留历史行（实测 ${total.rows[0].n}）`);
    const usersStill = await owner.query('SELECT count(*)::int AS n FROM users');
    assert.equal(usersStill.rows[0].n, 2, '删除历史不得连带删除账号行');
    const ledger = await owner.query('SELECT count(*)::int AS n FROM history_idempotency');
    assert.ok(ledger.rows[0].n >= 2, `删除幂等台账必须真落库（实测 ${ledger.rows[0].n} 行）`);
    note(
      armName,
      'pg-after-delete',
      `直查 history 总行数=0（物理删除）；users 仍=${usersStill.rows[0].n} 行；history_idempotency=${ledger.rows[0].n} 行（同键重放由真库台账裁决）`,
    );
  }

  note(armName, 'done', '链路全部断言通过：上传受理→结果→可信度/理由→历史→读回→越权隔离→删除→再读为空→重放语义');
  return { origin, historyId: historyRow.id, jobId: first.jobId, recognitionId: first.recognitionId };
}

// ---------------------------------------------------------------------------
// 真库臂的数据库准备（fresh 专用测试库；与 `tests/integration/favorites-history-pg.mjs` 同口径）
// ---------------------------------------------------------------------------

function readPgUrl() {
  const raw = process.env[PG_ENV] ?? '';
  if (raw === '') return null;
  const url = new URL(raw);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'postgres URL only');
  assert.equal(url.search, '', '不要把参数塞进连接串（测试库校验只认 pathname）');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'loopback only');
  assert.equal(url.pathname, PG_TEST_DB, `dedicated test DB only（${PG_TEST_DB}）`);
  return url;
}

async function preparePg(url) {
  const owner = new pg.Client({ connectionString: url.href });
  await owner.connect();
  try {
    const version = (await owner.query('SHOW server_version')).rows[0].server_version;
    assert.match(version, /^17\./, `本片只对 PG17 取证，实测 server_version=${version}`);
    console.log(`[GY-RECOG-E2E] real PostgreSQL patch: ${version}`);

    if (process.env[PG_RESET_ENV] === '1') {
      // 显式 opt-in 的清库（只对上面硬钉的专用测试库）：便于同一台机器重复取证。
      await owner.query('DROP SCHEMA IF EXISTS public CASCADE');
      await owner.query('CREATE SCHEMA public AUTHORIZATION CURRENT_USER');
      console.log('[GY-RECOG-E2E] public schema 已按 opt-in（RECOGNITION_CHAIN_PG_RESET=1）重置');
    }
    const tables = await owner.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'",
    );
    assert.equal(
      tables.rows[0].n,
      0,
      'fresh DB required：专用测试库必须是空库（或显式 RECOGNITION_CHAIN_PG_RESET=1 重置）',
    );

    const migrations = discoverMigrations().filter((migration) => ['0001', '0018'].includes(migration.version));
    const plan = await applyMigrations(owner, migrations);
    assert.deepEqual(
      plan.applied,
      ['0001', '0018'],
      `身份(0001)与历史(0018)迁移必须恰好应用一次：${JSON.stringify(plan.applied)}`,
    );
    const again = await applyMigrations(owner, migrations);
    assert.equal(again.applied.length, 0, '重复应用必须是 no-op（迁移不可重放）');
    console.log('[GY-RECOG-E2E] 迁移应用：0001_initial_schema.sql + 0018_favorites_history.sql（重复应用 no-op）');

    const pool = createPool(url.href);
    assert.ok(pool !== null, 'createPool 必须给出连接池');
    return { owner, pool };
  } catch (error) {
    await owner.end().catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const pgUrl = readPgUrl();
  const started = Date.now();
  console.log('[GY-RECOG-E2E] 链路：上传识别（合成 media_id / 替身提供者）→ 结果 → 可信度与理由 → 识别历史 → 读回 → 越权隔离 → 删除 → 再读为空');

  // 臂 1：内存存储（默认，无外部依赖；CI 可跑）
  const memoryArm = buildArm('memory', {});
  await runChain(memoryArm);
  await memoryArm.app.close();
  listeners.delete(memoryArm.app);
  console.log('[GY-RECOG-E2E] arm=memory PASS');
  console.log('[GY-RECOG-E2E] ── 边界：本臂不落库（身份/历史/识别记录都在进程内存）──');

  // 臂 2：真 PG17（身份 + 历史落库；识别仍是替身 + 内存 store，仓内无 PG 识别 store）
  if (pgUrl === null) {
    console.log(`[GY-RECOG-E2E] arm=pg SKIP real PG17: ${PG_ENV} 未设置 —— 本次运行**没有**验证真库持久化（不是通过，也不是失败）。`);
    console.log(`[GY-RECOG-E2E]      运行方式：${PG_ENV}=postgres://postgres@127.0.0.1:PORT${PG_TEST_DB} node tests/integration/recognition-chain-e2e.mjs`);
    console.log(`[GY-RECOG-E2E]      或：${PG_ENV}=… npm run test:integration:recognition-chain-pg`);
    if (ALLOW_SKIP) {
      console.log('[GY-RECOG-E2E] EXITCODE=0（--allow-skip / GY_ALLOW_SKIP=1 已显式授权：仅本机开发，⛔ 不得接进门禁）。');
    } else {
      console.log('[GY-RECOG-E2E] EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本机明知无真库时可显式加 --allow-skip 取 0，⛔ 不得接进门禁）。');
      process.exitCode = 77;
    }
  } else {
    const { owner, pool } = await preparePg(pgUrl);
    try {
      const pgArm = buildArm('pg', {
        store: createPostgresAuthStore(pool),
        historyInjection: { store: createPostgresHistoryStore(pool) },
        __db: { owner, pool },
      });
      await runChain(pgArm);
      await pgArm.app.close();
      listeners.delete(pgArm.app);
      console.log('[GY-RECOG-E2E] arm=pg PASS');
    } finally {
      await pool.end().catch(() => {});
      await owner.end().catch(() => {});
    }
  }

  console.log(`[GY-RECOG-E2E] 合计 ${evidence.length} 条证据行；耗时 ${Date.now() - started}ms`);
  if (process.exitCode === 77) {
    console.log('未取得 recognition-chain-e2e 完整链路：内存臂已通过，但真库持久化臂被跳过 —— 整体**不是**通过（见上方 arm=pg 行）。');
  } else {
    console.log('PASS recognition-chain-e2e (内存臂：loopback 真 HTTP；真库臂见上方 arm=pg 行)');
  }
  // 显式收敛：识别域内存 store / 幂等台账可能残留定时器，断言已定 ⇒ 以既定码退出（不挂死）。
  process.exit(process.exitCode ?? 0);
}

await (async () => {
  try {
    await main();
  } catch (error) {
    console.error('[GY-RECOG-E2E] FAIL 断言失败（原始输出如下，未跳过、未吞错）：');
    console.error(error);
    // 失败路径必须有界：先关掉所有监听中的服务，再让已排队的 stdout 落地，最后以 1 退出。
    await Promise.all([...listeners].map((app) => app.close().catch(() => {})));
    listeners.clear();
    process.exitCode = 1;
    await sleep(50);
    process.exit(1);
  }
})();
