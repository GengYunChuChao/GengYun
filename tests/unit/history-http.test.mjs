// 历史：真实回环 HTTP（合成账号/合成任务行；无 PG、无真实识别提供者）。
//
// 覆盖 issue #16 的历史验收：时间/任务类型/失败状态真实可见、**候选与人工选择分开**
// （历史响应只给引用，候选/选择/OCR 核对/来源版本由已合并的详情面提供）、
// 归属与越权（同形 404）、分页、删除的历史行 + 级联披露、契约形状、real 模式整域关闭。
//
// 任务状态端口在**生产装配**下就已接线到已合并的公开读取口
// （`recognitionService.getJob` / `ocrService.getJob`），本文件用真实的内存识别 store
// 驱动该路径 —— 因此"读取时能看到实时失败状态"不是靠替身，而是走真实读取口。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { STUB_APP_ID, STUB_LOOKUP_KEY, STUB_OPENID_PREFIX, computeSubjectLookup } from '../../services/api/src/auth/wechat.ts';
import { createMemoryRecognitionStore } from '../../services/api/src/recognitions/store.ts';
import { createSubstituteMediaPort } from '../../services/api/src/recognitions/media.ts';
import { createStubRecognitionProvider } from '../../services/api/src/recognitions/provider.ts';
import { createUnwiredHistoryCascadePort, createWiredHistoryCascadePort } from '../../services/api/src/history/cascade.ts';
import {
  HISTORY_KEYS,
  TARGET_REF_KEYS,
  USER_A,
  USER_B,
  makeControllableVisibility,
  scriptedClock,
} from './favorites-history-fixtures.mjs';

const START = Date.UTC(2026, 9, 14, 6);
const HISTORY = '/api/v1/history';
const ABSENT = '00000000-0000-4000-8f00-0000000000ff';
const REC_ID = '00000000-0000-4000-8a00-000000000001';
const JOB_ID = '00000000-0000-4000-8b00-000000000001';
const TERMINAL_STATES = ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'];

/**
 * **GY-I16（#16）接入后的端到端通路**（以下三个助手只被本文件末三条用例使用）：
 * 打的是**生产装配**（`buildApp` 默认的替身提供者与替身媒体端口），因此走的是
 * 「受理 → 异步执行 → 真实终态提交 → 终态历史端口 → `historyService.appendHistory`」这一整条链，
 * 而不是直接调用内部创建口。合成账号/合成媒体引用；无 PG、无真实供应商调用。
 */
async function login(base, code, auth) {
  const response = await fetch(`${base}/api/v1/auth/wechat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `synthetic-i16-history-${code}` },
    body: JSON.stringify({ code }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const token = body.data.access_token;
  // 归属者 id 只从服务端存储读（会话信息里没有 user_id）——用**与替身 provider 同一算法**的
  // subject 摘要反查，绝不从客户端声称的身份取值。
  const subject = computeSubjectLookup(STUB_LOOKUP_KEY, STUB_APP_ID, `${STUB_OPENID_PREFIX}${code}`);
  const user = await auth.findUserBySubject(subject);
  assert.notEqual(user, null, '登录后必须能在认证存储里按 subject 摘要查到该用户');
  return { token, userId: user.id };
}

/** 受理一次识别任务（契约 body 恰为 `{media_id, media_revision}`）。 */
async function createRecognition(base, actor, mediaId, key) {
  const response = await fetch(`${base}/api/v1/recognitions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${actor.token}`, 'idempotency-key': key },
    body: JSON.stringify({ media_id: mediaId, media_revision: 1 }),
  });
  return { status: response.status, body: await response.json() };
}

/** 轮询 `GET /jobs/{id}` 直到终态（与识别页客户端同一读面；上限 3s）。 */
async function waitForTerminal(base, actor, jobId) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const response = await fetch(`${base}/api/v1/jobs/${jobId}`, { headers: { authorization: `Bearer ${actor.token}` } });
    assert.equal(response.status, 200, `GET /jobs/${jobId}`);
    const body = await response.json();
    if (TERMINAL_STATES.includes(body.data.state)) return body.data;
    if (Date.now() > deadline) throw new Error(`等待任务终态超时：${body.data.state}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * 替身提供者的分桶（`recognitions/provider.ts`）：`bucketOf(media_id, 4) === 0` ⇒ 3 条有分数候选
 * ⇒ `succeeded`。这里按同一算法**离线搜**一个落该桶的合成 uuid（不猜、不硬编码）。
 */
function mediaIdForStubBucket(bucket) {
  const hex = '0123456789abcdef';
  for (let index = 0; index < 5000; index += 1) {
    const tail = index.toString(16).padStart(12, '0');
    const candidate = `00000000-0000-4000-8000-${tail}`;
    if (createHash('sha256').update(candidate).digest()[0] % 4 === bucket) return candidate;
  }
  throw new Error('未找到该桶的合成 media_id');
}

/** 一条真实的（内存）识别任务行：状态由用例给定，供已合并的 `getJob` 读取。 */
function recognitionRows(ownerUserId, state, options = {}) {
  const recognitionId = options.recognitionId ?? REC_ID;
  const jobId = options.jobId ?? JOB_ID;
  return {
    job: {
      id: jobId,
      revision: 2,
      kind: 'recognition',
      ownerUserId,
      recognitionId,
      mediaId: '00000000-0000-4000-8c00-000000000001',
      mediaRevision: 1,
      state,
      deadlineAt: new Date(START + 60_000),
      createdAt: new Date(START),
      updatedAt: new Date(START + 1000),
      errorCode: state === 'failed' ? 'PROVIDER_UNAVAILABLE' : null,
    },
    recognition: {
      id: recognitionId,
      revision: 2,
      ownerUserId,
      mediaId: '00000000-0000-4000-8c00-000000000001',
      mediaRevision: 1,
      candidates: [{ species_id: 'spc-model-1', rank: 1, model_score: 0.82 }],
      uncertaintyReasons: [],
      selectedSpeciesId: options.selectedSpeciesId ?? null,
      modelVersion: 'model-synthetic-v1',
      createdAt: new Date(START),
      updatedAt: new Date(START + 1000),
      deleted: false,
    },
  };
}

async function fixture(t, options = {}) {
  const clock = scriptedClock(START);
  const auth = createMemoryAuthStore();
  const recognitionStore = createMemoryRecognitionStore();
  const config = {
    ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    ...(options.real === true ? { executionMode: 'real', requiresRealCredentials: true } : {}),
  };
  const app = buildApp({
    config,
    store: auth,
    now: clock.now,
    recognitionStore,
    ...(options.historyInjection === undefined ? {} : { historyInjection: options.historyInjection }),
    // 端到端通路（末三条用例）：**生产装配**的替身提供者与替身媒体端口 ——
    // 不注入就等于「注入前的默认行为」，这里显式注入只为让用例自证"走的是替身、不是真实供应商"。
    ...(options.recognitionProvider === undefined ? {} : { recognitionProvider: options.recognitionProvider }),
    ...(options.recognitionMedia === undefined ? {} : { recognitionMedia: options.recognitionMedia }),
    ...(options.jobDeadlineMs === undefined ? {} : { recognitionJobDeadlineMs: options.jobDeadlineMs }),
  });
  async function account(subject) {
    const user = await auth.createUser(subject.repeat(64));
    const token = `synthetic-i16-history-${subject}`;
    await auth.createSession({
      userId: user.id,
      tokenHashHex: hashToken(token),
      authEpoch: user.authEpoch,
      expiresAt: new Date(START + 48 * 3600_000),
      audience: 'user',
    });
    return { user, token };
  }
  const a = await account('a');
  const b = await account('b');
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => app.close());

  async function call(method, path, actor = a, extra = {}) {
    // `contentType` 可**单独**声明 —— 无请求体也带 JSON 头，这正是真机形态：微信 `wx.request`
    // 默认注入 `content-type: application/json`，无体 `DELETE` 因此带着该头出门。
    // 旧版只在有 `payload` 时才加这个头，结构上不可能覆盖「无体 + JSON 头」这一整类。
    const contentType = extra.contentType ?? (extra.payload === undefined ? undefined : 'application/json');
    const body = extra.rawBody ?? (extra.payload === undefined ? undefined : JSON.stringify(extra.payload));
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(actor === null ? {} : { authorization: `Bearer ${actor.token}` }),
        ...(extra.headers ?? {}),
        ...(contentType === undefined ? {} : { 'content-type': contentType }),
      },
      ...(body === undefined ? {} : { body }),
    });
    return {
      status: response.status,
      body: await response.json(),
      etag: response.headers.get('etag'),
      cache: response.headers.get('cache-control'),
      cascade: response.headers.get('x-gy-cascade'),
    };
  }
  return { app, auth, clock, recognitionStore, a, b, call, base, login: (code) => login(base, code, auth) };
}

/** 经**内部创建口**落一条历史（该口不是契约 operationId、无 HTTP 入口）。 */
async function append(app, overrides = {}) {
  return app.historyService.appendHistory({
    owner_id: overrides.owner_id ?? 'unknown',
    kind: 'recognition',
    target_ref: { type: 'recognition', id: REC_ID, revision: 2 },
    job_id: JOB_ID,
    job_state: 'queued',
    event_key: 'evt-rec-1',
    ...overrides,
  });
}

test('历史HTTP：空列表 → 内部口落行 → 契约形状（无候选/选择/来源版本字段、无 ETag）', async (t) => {
  const h = await fixture(t);
  const empty = await h.call('GET', HISTORY);
  assert.equal(empty.status, 200);
  assert.equal(empty.cache, 'no-store');
  assert.equal(empty.etag, null, '列表无 ETag（契约 headers.ETag.description）');
  assert.deepEqual(empty.body.data, { items: [], next_cursor: null });

  h.clock.advance(1000);
  const rows = recognitionRows(h.a.user.id, 'succeeded');
  await h.recognitionStore.insertJob(rows.job);
  await h.recognitionStore.insertRecognition(rows.recognition);
  const appended = await append(h.app, { owner_id: h.a.user.id, job_state: 'queued' });
  assert.equal(appended.created, true);

  const page = await h.call('GET', HISTORY);
  assert.equal(page.body.data.items.length, 1);
  const item = page.body.data.items[0];
  assert.deepEqual(Object.keys(item).sort(), [...HISTORY_KEYS].sort());
  assert.deepEqual(Object.keys(item.target_ref).sort(), [...TARGET_REF_KEYS].sort());
  assert.equal(item.kind, 'recognition');
  assert.equal(item.created_at, new Date(START + 1000).toISOString(), '时间必须可见');
  // 入库时记的是 `queued`，但任务状态端口已接线 ⇒ 读取时以**实时值**为准（这里是 `succeeded`）。
  assert.equal(item.job_state, 'succeeded');
  // 「候选与人工选择分开」「OCR 核对」「来源版本」属详情面（getRecognition/getOCR），不在历史里。
  for (const forbidden of ['candidates', 'selected_species_id', 'model_version', 'verification', 'used']) {
    assert.equal(Object.hasOwn(item, forbidden), false, `历史不得含 ${forbidden}`);
  }
  // 内部字段 `job_id` / `event_key` 绝不出契约。
  for (const internal of ['job_id', 'event_key', 'owner_id']) {
    assert.equal(Object.hasOwn(item, internal), false, `内部字段不得出契约：${internal}`);
  }
  // 镜像字段（候选/人工选择/来源版本）确实存在于已合并的详情面，可经其读取。
  const detail = await h.call('GET', `/api/v1/recognitions/${REC_ID}`, h.a);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.candidates.length, 1);
  assert.equal(detail.body.data.selected_species_id, null, '模型候选与人工选择是两个分离字段');
  assert.equal(detail.body.data.model_version, 'model-synthetic-v1', '来源(模型)版本由详情面提供');
});

test('历史HTTP：任务状态端口已接线到已合并读取口 ⇒ 失败状态真实可见（读取时重查）', async (t) => {
  const h = await fixture(t);
  // A 的失败任务：入库时 queued，实时状态为 failed。
  const rows = recognitionRows(h.a.user.id, 'failed');
  await h.recognitionStore.insertJob(rows.job);
  await h.recognitionStore.insertRecognition(rows.recognition);
  await append(h.app, { owner_id: h.a.user.id, job_state: 'queued' });

  const page = await h.call('GET', HISTORY);
  assert.equal(page.status, 200);
  assert.equal(page.body.data.items[0].job_state, 'failed', '实时失败状态必须原样可见，不得显示为成功或排队中');

  // 任务终态变化（failed → timed_out）也被读取时重查捕捉到。
  const advanced = await h.recognitionStore.updateJob(JOB_ID, 2, (row) => ({
    ...row,
    state: 'timed_out',
    revision: row.revision + 1,
  }));
  assert.notEqual(advanced, null);
  const after = await h.call('GET', HISTORY);
  assert.equal(after.body.data.items[0].job_state, 'timed_out');

  // 删除识别记录（#9 的软删除）后：历史行仍在，但状态核不到 ⇒ 退回入库值（不外推、不升级）。
  await h.recognitionStore.updateRecognition(REC_ID, 2, (row) => ({ ...row, deleted: true, revision: row.revision + 1 }));
  const afterDelete = await h.call('GET', HISTORY);
  assert.equal(afterDelete.body.data.items.length, 1, '失败/失效记录不得被隐藏');
  assert.ok(['queued', 'timed_out'].includes(afterDelete.body.data.items[0].job_state));
  assert.notEqual(afterDelete.body.data.items[0].job_state, 'succeeded');
});

test('历史HTTP：他人任务核不到 ⇒ 只退回入库值，不泄露他人任务状态', async (t) => {
  const h = await fixture(t);
  const rows = recognitionRows(h.b.user.id, 'succeeded');
  await h.recognitionStore.insertJob(rows.job);
  await h.recognitionStore.insertRecognition(rows.recognition);
  // A 的历史行"错误地"指向 B 的任务：接线后也**核不到**（getJob 归属校验拒绝）。
  await append(h.app, { owner_id: h.a.user.id, job_state: 'failed' });
  const page = await h.call('GET', HISTORY);
  assert.equal(page.body.data.items[0].job_state, 'failed', '核不到时必须退回入库值，绝不采用他人任务的状态');
});

test('历史HTTP：失败/超时/取消 五类非成功终态逐类可见（不被折叠成一句"失败"）', async (t) => {
  const h = await fixture(t);
  const states = ['failed', 'timed_out', 'cancelled', 'uncertain', 'queued'];
  for (const [index, state] of states.entries()) {
    h.clock.advance(1000);
    const jobId = `00000000-0000-4000-8b00-00000000000${index}`;
    const recId = `00000000-0000-4000-8a00-00000000000${index}`;
    const rows = recognitionRows(h.a.user.id, state, { jobId, recognitionId: recId });
    await h.recognitionStore.insertJob(rows.job);
    await h.recognitionStore.insertRecognition(rows.recognition);
    await append(h.app, {
      owner_id: h.a.user.id,
      job_id: jobId,
      target_ref: { type: 'recognition', id: recId, revision: 2 },
      job_state: 'queued',
      event_key: `evt-${index}`,
    });
  }
  const page = await h.call('GET', HISTORY);
  const byTarget = new Map(page.body.data.items.map((item) => [item.target_ref.id, item.job_state]));
  for (const [index, state] of states.entries()) {
    assert.equal(byTarget.get(`00000000-0000-4000-8a00-00000000000${index}`), state, `状态 ${state} 必须逐类可见`);
  }
  assert.equal(page.body.data.items.length, states.length);
});

test('历史HTTP：去重（同一任务不产生第二行）、归属隔离、越权与不存在同形', async (t) => {
  const h = await fixture(t);
  await append(h.app, { owner_id: h.a.user.id, job_state: 'succeeded' });
  const duplicate = await append(h.app, { owner_id: h.a.user.id, job_state: 'succeeded' });
  assert.equal(duplicate.created, false, '同 event_key 不得重复创建');
  assert.equal((await h.call('GET', HISTORY)).body.data.items.length, 1);

  assert.deepEqual((await h.call('GET', HISTORY, h.b)).body.data, { items: [], next_cursor: null });

  const mine = (await h.call('GET', HISTORY)).body.data.items[0];
  const foreign = await h.call('DELETE', `${HISTORY}/${mine.id}`, h.b, {
    headers: { 'idempotency-key': 'his-b-0001', 'if-match': '"1"' },
  });
  const absent = await h.call('DELETE', `${HISTORY}/${ABSENT}`, h.b, {
    headers: { 'idempotency-key': 'his-b-0002', 'if-match': '"1"' },
  });
  assert.equal(foreign.status, 404);
  assert.equal(absent.status, 404);
  assert.deepEqual(foreign.body.error, absent.body.error, '他人历史与不存在必须同形');
  // 非本人不得拿到 409。
  const foreignStale = await h.call('DELETE', `${HISTORY}/${mine.id}`, h.b, {
    headers: { 'idempotency-key': 'his-b-0003', 'if-match': '"9"' },
  });
  assert.equal(foreignStale.status, 404);
});

test('历史HTTP：删除历史行 + 级联披露（未接线如实说明，接线后只启动不声称完成）', async (t) => {
  const pushed = [];
  const wired = createWiredHistoryCascadePort({
    initiate: async (request) => {
      pushed.push(request);
      return 'initiated';
    },
  });
  const h = await fixture(t, { historyInjection: { cascade: wired } });
  await append(h.app, { owner_id: h.a.user.id, job_state: 'failed' });
  const item = (await h.call('GET', HISTORY)).body.data.items[0];

  // If-Match/幂等头部纪律。
  assert.equal(
    (await h.call('DELETE', `${HISTORY}/${item.id}`, h.a, { headers: { 'idempotency-key': 'his-a-0001' } })).status,
    428,
  );
  const stale = await h.call('DELETE', `${HISTORY}/${item.id}`, h.a, {
    headers: { 'idempotency-key': 'his-a-0002', 'if-match': '"9"' },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'REVISION_CONFLICT');

  const removed = await h.call('DELETE', `${HISTORY}/${item.id}`, h.a, {
    headers: { 'idempotency-key': 'his-a-0003', 'if-match': '"1"' },
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.data, { accepted: true });
  assert.equal(removed.cache, 'no-store');
  assert.equal(removed.cascade, 'initiated', 'X-GY-Cascade 为非契约披露标记：只表示"已启动"');
  assert.equal(pushed.length, 1, '级联只启动一次');
  assert.deepEqual(pushed[0].target_ref, { type: 'recognition', id: REC_ID, revision: 2 });
  assert.equal(pushed[0].userId, h.a.user.id);
  assert.equal(pushed[0].jobId, JOB_ID);
  assert.equal((await h.call('GET', HISTORY)).body.data.items.length, 0);

  // 幂等重放：回放同一份披露，**不**重复触发第二次级联删除。
  const replayed = await h.call('DELETE', `${HISTORY}/${item.id}`, h.a, {
    headers: { 'idempotency-key': 'his-a-0003', 'if-match': '"1"' },
  });
  assert.equal(replayed.status, 200);
  assert.equal(replayed.cascade, 'initiated');
  assert.equal(pushed.length, 1, '重放不得再次触发级联');

  // 未接线端口：只删历史行，如实披露 `unwired`（不谎称级联已完成）。
  const h2 = await fixture(t, { historyInjection: { cascade: createUnwiredHistoryCascadePort() } });
  await append(h2.app, { owner_id: h2.a.user.id, job_state: 'failed' });
  const item2 = (await h2.call('GET', HISTORY)).body.data.items[0];
  const removed2 = await h2.call('DELETE', `${HISTORY}/${item2.id}`, h2.a, {
    headers: { 'idempotency-key': 'his-a-0004', 'if-match': '"1"' },
  });
  assert.equal(removed2.status, 200);
  assert.equal(removed2.cascade, 'unwired');
  assert.equal((await h2.call('GET', HISTORY)).body.data.items.length, 0, '级联未接线也必须能删除自己的记录');
});

test('历史HTTP：无体 DELETE 带微信默认 JSON content-type 时不得被判成 400（同类写面，非收藏单点）', async (t) => {
  const h = await fixture(t);
  await append(h.app, { owner_id: h.a.user.id, job_state: 'failed' });
  const item = (await h.call('GET', HISTORY)).body.data.items[0];

  // 与收藏同一个机制、**不同域不同路由**：修复前空 JSON 体 ⇒ 400「请求体格式错误」，
  // 请求到不了路由；修复后与"不带该头"的同一请求行为一致。
  const withDefaultHeader = { contentType: 'application/json' };

  // 回归①：缺 If-Match **仍然** 428。
  const missing = await h.call('DELETE', `${HISTORY}/${item.id}`, h.a, {
    ...withDefaultHeader,
    headers: { 'idempotency-key': 'his-nobody-0001' },
  });
  assert.equal(missing.status, 428);
  assert.equal(missing.body.error.code, 'REVISION_REQUIRED');

  // 回归②：版本不符 **仍然** 409。
  const stale = await h.call('DELETE', `${HISTORY}/${item.id}`, h.a, {
    ...withDefaultHeader,
    headers: { 'idempotency-key': 'his-nobody-0002', 'if-match': '"9"' },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'REVISION_CONFLICT');

  // 回归③：未登录 **仍然** 401。
  const anonymous = await h.call('DELETE', `${HISTORY}/${item.id}`, null, {
    ...withDefaultHeader,
    headers: { 'idempotency-key': 'his-nobody-0003', 'if-match': '"1"' },
  });
  assert.equal(anonymous.status, 401);
  assert.ok(['SESSION_REQUIRED', 'SESSION_EXPIRED'].includes(anonymous.body.error.code));

  // 正例：无体 + JSON 头 ⇒ 200 Ack（级联披露照常）。
  const removed = await h.call('DELETE', `${HISTORY}/${item.id}`, h.a, {
    ...withDefaultHeader,
    headers: { 'idempotency-key': 'his-nobody-0004', 'if-match': '"1"' },
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.data, { accepted: true });
  assert.equal(removed.cache, 'no-store');
  assert.equal((await h.call('GET', HISTORY)).body.data.items.length, 0);
});

test('历史HTTP：请求校验、分页与 real 模式整域关闭', async (t) => {
  const h = await fixture(t);
  // 内部创建口：未知字段（含任何"已使用"类字段）一律拒绝。
  for (const extra of [{ used: true }, { reference_state: 'available' }, { id: 'x' }, { revision: 9 }, { created_at: 'x' }]) {
    const error = await h.app.historyService
      .appendHistory({
        owner_id: h.a.user.id,
        kind: 'recognition',
        target_ref: { type: 'recognition', id: REC_ID, revision: 1 },
        job_id: JOB_ID,
        job_state: 'failed',
        event_key: 'evt-bad',
        ...extra,
      })
      .then(() => null)
      .catch((e) => e);
    assert.equal(error?.code, 'INVALID_REQUEST', JSON.stringify(extra));
  }
  // `job_state` 非闭集 ⇒ 拒绝（不猜、不兜底）。
  const badState = await h.app.historyService
    .appendHistory({
      owner_id: h.a.user.id,
      kind: 'recognition',
      target_ref: { type: 'recognition', id: REC_ID, revision: 1 },
      job_id: JOB_ID,
      job_state: 'unknown',
      event_key: 'evt-bad-2',
    })
    .then(() => null)
    .catch((e) => e);
  assert.equal(badState?.code, 'INVALID_REQUEST');

  // 分页：limit=1 翻两页不重不漏。
  for (let index = 0; index < 3; index += 1) {
    h.clock.advance(1000);
    await append(h.app, {
      owner_id: h.a.user.id,
      target_ref: { type: 'recognition', id: `rec-page-${index}`, revision: 1 },
      job_id: `job-page-${index}`,
      job_state: 'succeeded',
      event_key: `evt-page-${index}`,
    });
  }
  const page1 = await h.call('GET', `${HISTORY}?limit=1`);
  assert.equal(page1.body.data.items.length, 1);
  const page2 = await h.call('GET', `${HISTORY}?limit=1&cursor=${encodeURIComponent(page1.body.data.next_cursor)}`);
  assert.equal(page2.body.data.items.length, 1);
  assert.notEqual(page1.body.data.items[0].id, page2.body.data.items[0].id);
  assert.equal((await h.call('GET', `${HISTORY}?kind=ocr`)).status, 400, '契约没有按任务类型筛选的参数');

  const real = await fixture(t, { real: true });
  for (const [method, path, extra] of [
    ['GET', HISTORY, {}],
    ['DELETE', `${HISTORY}/${ABSENT}`, { headers: { 'idempotency-key': 'his-real-0001', 'if-match': '"1"' } }],
  ]) {
    const result = await real.call(method, path, real.a, extra);
    assert.equal(result.status, 503, `${method} ${path}`);
    assert.equal(result.body.error.code, 'PROVIDER_UNAVAILABLE');
  }
  assert.equal(real.app.historyService, null);
  void USER_A;
  void USER_B;
  void makeControllableVisibility;
});

// ---------------------------------------------------------------------------
// GY-I16（#16）切片 C：**把「识别／OCR 完成」接到服务端识别历史**（端到端验收）
//
// 与上面全部用例的差别：这里**不再**直接调用内部创建口，而是打**生产装配**的完整通路 ——
//   登录 → POST /recognitions（替身媒体端口）→ 异步执行 → 终态提交 → 终态历史端口
//   → `historyService.appendHistory` → GET /history
// 因此这组用例是「接线被撤下 ⇒ 必红」的那一组（撤下接线后历史列表恒空，第一条断言即失败）。
// ---------------------------------------------------------------------------

test('历史HTTP·接线：stub 完成一次识别 ⇒ GET /history 恰 1 条（终态提交后自动写入，非内部口直调）', async (t) => {
  const h = await fixture(t, {
    recognitionProvider: createStubRecognitionProvider(),
    recognitionMedia: createSubstituteMediaPort(),
  });
  const actor = await h.login('synthetic-history-wire');

  const created = await createRecognition(h.base, actor, mediaIdForStubBucket(0), 'wire-create-0001');
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const job = created.body.data;
  const terminal = await waitForTerminal(h.base, actor, job.id);
  assert.equal(terminal.state, 'succeeded', '本用例只覆盖成功终态（失败/超时见下一条）');

  const page = await h.call('GET', HISTORY, actor);
  assert.equal(page.status, 200);
  assert.equal(page.body.data.items.length, 1, '终态提交后必须自动落 1 条识别历史（撤下接线 ⇒ 恒 0 条）');
  const item = page.body.data.items[0];
  assert.equal(item.kind, 'recognition');
  assert.deepEqual(Object.keys(item).sort(), [...HISTORY_KEYS].sort());
  assert.equal(item.job_state, 'succeeded', 'job_state 与任务终态一致');
  assert.deepEqual(item.target_ref, {
    type: 'recognition',
    id: terminal.target_ref.id,
    revision: terminal.target_ref.revision,
  });
  // `reference_state` 是逐次派生（不是入库字段）：识别/OCR 目标不在 `/knowledge` 公开读面内
  // ⇒ 如实 `unavailable`（本片不放宽可见性守卫、也不给它造一个读面）。
  assert.equal(item.reference_state, 'unavailable', 'reference_state 必须逐次派生（不得在写入时固化）');
  // 内部字段绝不出契约。
  for (const internal of ['job_id', 'event_key', 'owner_id']) {
    assert.equal(Object.hasOwn(item, internal), false, `内部字段不得出契约：${internal}`);
  }
  // 详情面能取到（「我的 → 识别历史」进详情的那一跳，`historydetail.js:106-118`）。
  const detail = await h.call('GET', `/api/v1/recognitions/${item.target_ref.id}`, actor);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.candidates.length, 3, '详情面照旧给出模型候选');
  // 端口接线状态可见（诊断/证据用）：生产装配下是 wired。
  assert.equal(h.app.recognitionService.describe().historyPort, 'wired');
});

test('历史HTTP·接线：失败/超时也各追加 1 条，job_state 与任务一致（绝不写成 succeeded）', async (t) => {
  const MEDIA_QUOTA = '00000000-0000-4000-8000-0000000000f1';
  const MEDIA_HANG = '00000000-0000-4000-8000-0000000000f2';
  /** 按媒体引用分派的替身提供者：配额失败 ⇒ failed；悬挂 ⇒ 由服务层截止时间判 timed_out。 */
  const outcomes = new Map([
    [MEDIA_QUOTA, { kind: 'failed', code: 'PROVIDER_QUOTA_EXCEEDED' }],
    [MEDIA_HANG, () => new Promise(() => {})],
  ]);
  const h = await fixture(t, {
    jobDeadlineMs: 60,
    recognitionMedia: createSubstituteMediaPort(),
    recognitionProvider: {
      executionMode: 'stub',
      modelVersion: 'stub-history-wire-v1',
      available: true,
      unavailableReason: null,
      async recognize({ mediaId }) {
        const outcome = outcomes.get(mediaId);
        if (typeof outcome === 'function') return outcome();
        assert.notEqual(outcome, undefined, `未脚本化的媒体引用：${mediaId}`);
        return outcome;
      },
    },
  });
  const actor = await h.login('synthetic-history-wire-neg');

  const failed = await createRecognition(h.base, actor, MEDIA_QUOTA, 'wire-fail-000001');
  assert.equal(failed.status, 202, JSON.stringify(failed.body));
  assert.equal((await waitForTerminal(h.base, actor, failed.body.data.id)).state, 'failed');

  const timedOut = await createRecognition(h.base, actor, MEDIA_HANG, 'wire-hang-000001');
  assert.equal(timedOut.status, 202, JSON.stringify(timedOut.body));
  assert.equal((await waitForTerminal(h.base, actor, timedOut.body.data.id)).state, 'timed_out');

  const page = await h.call('GET', HISTORY, actor);
  assert.equal(page.status, 200);
  const items = page.body.data.items;
  assert.equal(items.length, 2, '失败与超时各追加 1 条（撤下接线 ⇒ 0 条）');
  const byTarget = new Map(items.map((item) => [item.target_ref.id, item.job_state]));
  assert.equal(byTarget.get(failed.body.data.target_ref.id), 'failed');
  assert.equal(byTarget.get(timedOut.body.data.target_ref.id), 'timed_out');
  for (const item of items) {
    assert.notEqual(item.job_state, 'succeeded', '失败/超时绝不因写了历史而变成成功');
    assert.equal(item.kind, 'recognition');
  }
});

test('历史HTTP·接线：OCR 终态同样追加 1 条（kind=ocr，详情面走 GET /ocr/{id}）', async (t) => {
  const h = await fixture(t);
  const actor = await h.login('synthetic-history-wire-ocr');
  const mediaId = '00000000-0000-4000-8000-0000000000c1';

  const response = await fetch(`${h.base}/api/v1/ocr`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${actor.token}`, 'idempotency-key': 'wire-ocr-000001' },
    body: JSON.stringify({ media_id: mediaId, media_revision: 1 }),
  });
  const raw = await response.text();
  assert.equal(response.status, 202, raw);
  const job = JSON.parse(raw).data;

  const ocr = await h.call('GET', `/api/v1/ocr/${job.target_ref.id}`, actor);
  assert.equal(ocr.status, 200, JSON.stringify(ocr.body));

  const page = await h.call('GET', HISTORY, actor);
  assert.equal(page.body.data.items.length, 1, 'OCR 终态提交后必须自动落 1 条（撤下接线 ⇒ 0 条）');
  const item = page.body.data.items[0];
  assert.equal(item.kind, 'ocr');
  assert.deepEqual(item.target_ref, { type: 'ocr', id: job.target_ref.id, revision: job.target_ref.revision });
  assert.equal(item.job_state, 'succeeded');
  // OCR 的读面（历史详情的 `historydetail.js:120-128`）照旧可用，历史不复制其正文。
  for (const forbidden of ['raw_fields', 'corrected_fields', 'verification']) {
    assert.equal(Object.hasOwn(item, forbidden), false, `历史不得含 ${forbidden}`);
  }
});

test('历史HTTP·接线：同一次任务重复投递终态 ⇒ no-op（确定性 event_key，不追加第二条）', async (t) => {
  const h = await fixture(t, {
    recognitionProvider: createStubRecognitionProvider(),
    recognitionMedia: createSubstituteMediaPort(),
  });
  const actor = await h.login('synthetic-history-wire-idem');
  const created = await createRecognition(h.base, actor, mediaIdForStubBucket(0), 'wire-idem-000001');
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const job = created.body.data;
  const terminal = await waitForTerminal(h.base, actor, job.id);

  const first = await h.call('GET', HISTORY, actor);
  assert.equal(first.body.data.items.length, 1);
  const rowId = first.body.data.items[0].id;

  // 幂等键是**确定性**的（只由服务端分配的作业 id 派生，不含时间戳/随机数）⇒ 装配层用的就是这一把。
  const eventKey = `recognition:${job.id}`;
  assert.equal(typeof eventKey, 'string');
  const replayed = await h.app.historyService.appendHistory({
    owner_id: actor.userId,
    kind: 'recognition',
    target_ref: { type: 'recognition', id: terminal.target_ref.id, revision: terminal.target_ref.revision },
    job_id: job.id,
    job_state: terminal.state,
    event_key: eventKey,
  });
  assert.equal(replayed.created, false, '同 event_key 重放必须 no-op（created:false）');
  assert.equal(replayed.history.id, rowId, '重放必须回放同一条既有历史行');

  const after = await h.call('GET', HISTORY, actor);
  assert.equal(after.body.data.items.length, 1, '重复终态事件不得追加第二条历史行');
  assert.equal(after.body.data.items[0].id, rowId);

  // 第二道去重（store 的 `(owner_id, kind, target_ref.id)` 唯一约束）：换个 event_key 但同目标
  // ⇒ 仍不得产生第二条（同一识别记录只能有一条历史）。
  const otherKey = await h.app.historyService.appendHistory({
    owner_id: actor.userId,
    kind: 'recognition',
    target_ref: { type: 'recognition', id: terminal.target_ref.id, revision: terminal.target_ref.revision },
    job_id: job.id,
    job_state: terminal.state,
    event_key: `${eventKey}:retry`,
  });
  assert.equal(otherKey.created, false, '同目标不同键也不得产生第二条历史行');
  assert.equal((await h.call('GET', HISTORY, actor)).body.data.items.length, 1);

  // 归属过滤：他人列表为空、且越权删除与「不存在」同形（不泄露存在性）。
  assert.deepEqual((await h.call('GET', HISTORY, h.b)).body.data, { items: [], next_cursor: null });
  const foreign = await h.call('DELETE', `${HISTORY}/${rowId}`, h.b, {
    headers: { 'idempotency-key': 'wire-idem-b-01', 'if-match': '"1"' },
  });
  assert.equal(foreign.status, 404);
  assert.equal((await h.call('GET', HISTORY, actor)).body.data.items.length, 1, '越权删除不得影响本人历史');
});

test('历史HTTP·接线：real 模式仍整域 503（不放宽守卫），且终态历史端口未接线', async (t) => {
  const real = await fixture(t, { real: true });
  assert.equal(real.app.historyService, null);
  const page = await real.call('GET', HISTORY, real.a);
  assert.equal(page.status, 503);
  assert.equal(page.body.error.code, 'PROVIDER_UNAVAILABLE');
  // 端口如实标注自身未接线（**不**回退替身、不伪造一片可用历史）。
  assert.equal(real.app.recognitionService.describe().historyPort, 'unwired');
});
