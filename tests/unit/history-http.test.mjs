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
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createMemoryRecognitionStore } from '../../services/api/src/recognitions/store.ts';
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
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(actor === null ? {} : { authorization: `Bearer ${actor.token}` }),
        ...(extra.headers ?? {}),
        ...(extra.payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(extra.payload === undefined ? {} : { body: JSON.stringify(extra.payload) }),
    });
    return {
      status: response.status,
      body: await response.json(),
      etag: response.headers.get('etag'),
      cache: response.headers.get('cache-control'),
      cascade: response.headers.get('x-gy-cascade'),
    };
  }
  return { app, auth, clock, recognitionStore, a, b, call };
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
