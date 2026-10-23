// GY-I16（#16）R33 片：**历史删除的关联删除接线**（`services/api/src/history/cascade-wiring.ts`）。
//
// 授权来源：`.pg17/ruling-r33-i16-history-cascade-partial-20261023.md`
//   - 只接 `recognitions` 与 `ocr` 两类（媒体/外发跨 #6/#19，不在本片）；
//   - 新增披露值 `'partial'`，语义**严格**为「历史行已删 ＋ 至少一项关联已删 ＋ 未全部删成功」；
//   - ⛔ 「一项都没删成功」仍是 `failed`；⛔ 未接线仍是 `unwired`（不得改写）。
//
// 本文件只驱动适配器本身（零 I/O、零 app、零真库）：目标域用**记录型替身**，
// 断言的是「按 kind 分派到哪个口、用哪个 revision、失败如何折叠」，不重复驱动
// `history/service.ts` 的删除顺序（那条由 `tests/unit/history-http.test.mjs` 与真库臂覆盖）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createMemoryRecognitionStore } from '../../services/api/src/recognitions/store.ts';
import {
  CASCADE_OUTCOMES,
  createUnwiredHistoryCascadePort,
  createWiredHistoryCascadePort,
  isCascadeOutcome,
} from '../../services/api/src/history/cascade.ts';
import {
  CASCADE_IDEMPOTENCY_PREFIX,
  cascadeIdempotencyKey,
  createHistoryCascadeFromServices,
} from '../../services/api/src/history/cascade-wiring.ts';

const USER = '00000000-0000-4000-8a00-0000000000a1';
const HISTORY_ID = '00000000-0000-4000-8b00-0000000000b1';
const RECOGNITION_ID = '00000000-0000-4000-8c00-0000000000c1';
const OCR_ID = '00000000-0000-4000-8d00-0000000000d1';
const JOB_ID = '00000000-0000-4000-8e00-0000000000e1';

/**
 * 记录型替身：`behaviour` 里可以按方法覆盖成抛错，用来构造 404 / 409 / 任意异常。
 * 只记录**调用顺序与入参**，不做任何 I/O。
 */
function targetFixture({ prefix, idKey, revision = 1, behaviour = {} }) {
  const calls = [];
  const fail = (method) => {
    const entry = behaviour[method];
    if (entry === undefined) return null;
    return entry;
  };
  const read = async (input) => {
    calls.push(['get', input]);
    const boom = fail('get');
    if (boom !== null) throw boom;
    return { id: input[idKey], revision };
  };
  const remove = async (input) => {
    calls.push(['delete', input]);
    const boom = fail('delete');
    if (boom !== null) throw boom;
    return { accepted: true };
  };
  const api = prefix === 'recognition'
    ? { getRecognition: read, deleteRecognition: remove }
    : { getOcr: read, deleteOcr: remove };
  return { calls, api, idKey };
}

function recognitionFixture(options = {}) {
  return targetFixture({ prefix: 'recognition', idKey: 'recognitionId', ...options });
}

function ocrFixture(options = {}) {
  return targetFixture({ prefix: 'ocr', idKey: 'ocrId', ...options });
}

function servicesOf({ recognition, ocr }) {
  // 闭包取服务（与 `app.ts` 的装配同形）：记录闭包被执行了几次 = 是否真的在请求期解析。
  const resolved = { recognition: 0, ocr: 0 };
  return {
    resolved,
    services: {
      recognitionService: () => {
        resolved.recognition += 1;
        return recognition.api;
      },
      ocrService: () => {
        resolved.ocr += 1;
        return ocr.api;
      },
    },
  };
}

function request(overrides = {}) {
  return {
    userId: USER,
    historyId: HISTORY_ID,
    kind: 'recognition',
    target_ref: { type: 'recognition', id: RECOGNITION_ID, revision: 9 },
    jobId: JOB_ID,
    jobState: 'succeeded',
    ...overrides,
  };
}

function ocrRequest(overrides = {}) {
  return request({
    kind: 'ocr',
    target_ref: { type: 'ocr', id: OCR_ID, revision: 7 },
    ...overrides,
  });
}

const apiError = (code) => Object.assign(new Error(`synthetic ${code}`), { code });

// ===========================================================================
// 1. 两类各自的成功档：partial（不是 initiated —— 媒体/外发未接，永远不可能"全部成功"）
// ===========================================================================

test('级联接线：识别腿删成功 ⇒ partial（用**当前** revision 做 If-Match，不是历史快照）', async () => {
  const recognition = recognitionFixture({ revision: 4 });
  const ocr = ocrFixture();
  const { services, resolved } = servicesOf({ recognition, ocr });
  const initiate = createHistoryCascadeFromServices(services);

  const outcome = await initiate(request());

  assert.equal(outcome, 'partial', '至少一项关联已删、未全部删成功 ⇒ partial（裁定第 1 条）');
  assert.equal(resolved.recognition, 1, '识别腿必须真的解析服务（闭包在请求期求值）');
  assert.equal(resolved.ocr, 0, 'kind=recognition 时不得碰 OCR 域');
  assert.deepEqual(recognition.calls.map(([method]) => method), ['get', 'delete'], '必须先读当前 revision 再删');
  const [, deleteInput] = recognition.calls[1];
  assert.equal(deleteInput.ifMatch, '"4"', 'If-Match 必须用**当前** revision 4（历史行里的快照是 9，已过期）');
  assert.equal(deleteInput.recognitionId, RECOGNITION_ID);
  assert.equal(deleteInput.userId, USER, '归属一律取历史行的 owner，不得来自客户端');
  assert.equal(deleteInput.idempotencyKey, `cascade:${HISTORY_ID}`, '幂等键确定性：只由服务端 historyId 派生');
  assert.equal(ocr.calls.length, 0);
});

test('级联接线：OCR 腿删成功 ⇒ partial（同形：先读当前 revision 再按 If-Match 软删）', async () => {
  const recognition = recognitionFixture();
  const ocr = ocrFixture({ revision: 2 });
  const { services, resolved } = servicesOf({ recognition, ocr });
  const initiate = createHistoryCascadeFromServices(services);

  const outcome = await initiate(ocrRequest());

  assert.equal(outcome, 'partial');
  assert.equal(resolved.ocr, 1);
  assert.equal(resolved.recognition, 0, 'kind=ocr 时不得碰识别域');
  assert.deepEqual(ocr.calls.map(([method]) => method), ['get', 'delete']);
  const [, deleteInput] = ocr.calls[1];
  assert.equal(deleteInput.ifMatch, '"2"');
  assert.equal(deleteInput.ocrId, OCR_ID);
  assert.equal(deleteInput.idempotencyKey, `cascade:${HISTORY_ID}`);
  assert.equal(recognition.calls.length, 0);
});

// ===========================================================================
// 2. 只一类成功 / 两类都失败：失败档不得被记成 partial
// ===========================================================================

test('级联接线：只一类删成功（另一类 404）⇒ 成功那条 partial、失败那条 failed（逐条独立判定）', async () => {
  const recognition = recognitionFixture({ revision: 1 });
  const ocr = ocrFixture({ behaviour: { get: apiError('NOT_FOUND') } });
  const { services } = servicesOf({ recognition, ocr });
  const initiate = createHistoryCascadeFromServices(services);

  assert.equal(await initiate(request()), 'partial', '识别腿真的删掉了 ⇒ partial');
  assert.equal(await initiate(ocrRequest()), 'failed', 'OCR 腿 404（读不到/他人/已删）⇒ 一项都没删成功 ⇒ failed');

  // 反向次序再跑一次：证明不是"第一次成功就一直成功"的粘滞状态。
  assert.equal(await initiate(ocrRequest()), 'failed');
  assert.equal(await initiate(request()), 'partial');
});

test('级联接线：两类都删失败（读 404 / 删 409）⇒ failed，绝不写成 partial', async () => {
  const recognition = recognitionFixture({ behaviour: { get: apiError('NOT_FOUND') } });
  const ocr = ocrFixture({ behaviour: { delete: apiError('REVISION_CONFLICT') } });
  const { services } = servicesOf({ recognition, ocr });
  const initiate = createHistoryCascadeFromServices(services);

  assert.equal(await initiate(request()), 'failed', '404 ⇒ failed（不得记 partial）');
  assert.equal(await initiate(ocrRequest()), 'failed', '409 ⇒ failed（不得记 partial）');
  assert.equal(recognition.calls.length, 1, '404 时不得继续调 delete（不猜、不蛮删）');
  assert.deepEqual(ocr.calls.map(([method]) => method), ['get', 'delete']);
});

// ===========================================================================
// 3. 未接线：unwired 不变（适配器不参与，目标域零调用）
// ===========================================================================

test('级联接线：端口未接线 ⇒ 仍是 unwired（⛔ 不得改写 partial），且目标域零调用', async () => {
  const recognition = recognitionFixture();
  const ocr = ocrFixture();
  const { services, resolved } = servicesOf({ recognition, ocr });
  // 反向控制：适配器本身即使"能删"，未接线端口也**不得**采信它。
  const initiate = createHistoryCascadeFromServices(services);
  const unwired = createUnwiredHistoryCascadePort();

  assert.equal(unwired.available, false);
  assert.equal(unwired.kind, 'unwired');
  assert.equal(await unwired.initiate(request()), 'unwired');
  assert.equal(await unwired.initiate(ocrRequest()), 'unwired');
  assert.equal(resolved.recognition, 0, '未接线端口不得触碰任何域（initiate 零 I/O）');
  assert.equal(resolved.ocr, 0);
  assert.deepEqual(recognition.calls, []);
  assert.deepEqual(ocr.calls, []);
  // 适配器仍然工作 —— 但那是**已接线**端口的路径，与 unwired 无关。
  assert.equal(await initiate(request()), 'partial');
});

// ===========================================================================
// 4. 确定性 / 无抛错（服务层依赖「绝不向上抛」这条不变量）
// ===========================================================================

test('级联接线：确定性（同请求两次 ⇒ 同 outcome、同 If-Match、同幂等键；不含时间戳/随机数）', async () => {
  const recognition = recognitionFixture({ revision: 3 });
  const { services } = servicesOf({ recognition, ocr: ocrFixture() });
  const initiate = createHistoryCascadeFromServices(services);

  const first = await initiate(request());
  const second = await initiate(request());

  assert.equal(first, 'partial');
  assert.equal(second, 'partial');
  const [, deleteA] = recognition.calls[1];
  const [, deleteB] = recognition.calls[3];
  assert.deepEqual(deleteA, deleteB, '同一历史行的两次投递必须逐字段相同（可幂等去重）');
  assert.equal(cascadeIdempotencyKey(HISTORY_ID), `${CASCADE_IDEMPOTENCY_PREFIX}${HISTORY_ID}`);
  assert.match(deleteA.idempotencyKey, /^cascade:[0-9a-f-]{36}$/, '幂等键形状：cascade:<uuid>，无时间戳/随机数');
  assert.ok(deleteA.idempotencyKey.length >= 8 && deleteA.idempotencyKey.length <= 128, '落在契约幂等键长度区间');
});

test('级联接线：绝不向上抛 —— 读抛错 / 删抛错 / 闭包抛错 / 入参不合约 一律折 failed', async () => {
  const cases = [
    ['get 抛任意异常', recognitionFixture({ behaviour: { get: new Error('synthetic db down') } }), 'failed'],
    ['delete 抛任意异常', recognitionFixture({ behaviour: { delete: new Error('synthetic db down') } }), 'failed'],
    ['delete 返回 rejected 的 409', recognitionFixture({ behaviour: { delete: apiError('REVISION_CONFLICT') } }), 'failed'],
  ];
  for (const [label, recognition, expected] of cases) {
    const { services } = servicesOf({ recognition, ocr: ocrFixture() });
    const initiate = createHistoryCascadeFromServices(services);
    const outcome = await initiate(request()).then(
      (value) => value,
      (error) => `THREW:${error instanceof Error ? error.message : String(error)}`,
    );
    assert.equal(outcome, expected, `${label} ⇒ ${expected}（且不得 reject）`);
  }

  // 装配顺序漂移（装饰还没发生）⇒ 闭包抛错，也不得外泄。
  const broken = createHistoryCascadeFromServices({
    recognitionService: () => {
      throw new Error('历史域尚未装配（装配顺序错误）');
    },
    ocrService: () => {
      throw new Error('历史域尚未装配（装配顺序错误）');
    },
  });
  assert.equal(await broken(request()), 'failed');
  assert.equal(await broken(ocrRequest()), 'failed');

  // 入参不合约（缺 jobId / kind 非闭集）⇒ 内部断言抛错但由本函数吞掉 ⇒ failed，不猜。
  const ok = recognitionFixture();
  const { services } = servicesOf({ recognition: ok, ocr: ocrFixture() });
  const initiate = createHistoryCascadeFromServices(services);
  assert.equal(await initiate(request({ jobId: '' })), 'failed');
  assert.equal(await initiate(request({ kind: 'transcription' })), 'failed');
  assert.deepEqual(ok.calls, [], '入参被判不合约时不得触碰目标域');
});

test('级联接线：target_ref.type 与 kind 不一致 ⇒ failed 且零调用（不猜该删哪张表）', async () => {
  const recognition = recognitionFixture();
  const ocr = ocrFixture();
  const { services } = servicesOf({ recognition, ocr });
  const initiate = createHistoryCascadeFromServices(services);

  assert.equal(
    await initiate(request({ target_ref: { type: 'species', id: RECOGNITION_ID, revision: 1 } })),
    'failed',
  );
  assert.equal(
    await initiate(ocrRequest({ target_ref: { type: 'media', id: OCR_ID, revision: 1 } })),
    'failed',
  );
  assert.deepEqual(recognition.calls, []);
  assert.deepEqual(ocr.calls, []);
});

// ===========================================================================
// 5. 端口折叠口径：partial 必须透传（否则"部分已删"会被静默降级成 failed）
// ===========================================================================

test('级联端口折叠：partial 透传 / 非闭集与 unused 取值折 failed / 抛错折 failed', async () => {
  assert.deepEqual([...CASCADE_OUTCOMES], ['initiated', 'partial', 'unwired', 'failed']);
  for (const value of CASCADE_OUTCOMES) assert.equal(isCascadeOutcome(value), true, `${value} 在闭集内`);
  for (const value of [undefined, null, '', 'partial-done', 0, true]) {
    assert.equal(isCascadeOutcome(value), false, `${String(value)} 不得被当成闭集取值`);
  }

  const passing = createWiredHistoryCascadePort({ initiate: async () => 'partial' });
  assert.equal(await passing.initiate(request()), 'partial', 'partial 必须原样透传（不得折叠成 failed）');
  assert.equal(passing.lastOutcome(), 'partial');

  for (const [label, value] of [
    ['unwired（实现自认未接线段 ⇒ 端口不得自相矛盾）', 'unwired'],
    ['非闭集字符串', 'done'],
    ['undefined', undefined],
    ['数字', 1],
  ]) {
    const port = createWiredHistoryCascadePort({ initiate: async () => value });
    assert.equal(await port.initiate(request()), 'failed', `${label} ⇒ failed`);
  }

  const throwing = createWiredHistoryCascadePort({
    initiate: async () => {
      throw new Error('synthetic');
    },
  });
  assert.equal(await throwing.initiate(request()), 'failed');
  assert.equal(throwing.lastOutcome(), 'failed');
});

// ===========================================================================
// 6. **生产装配**可观测（负控制锚点）：把 `app.ts` 的默认值改回
//    `createUnwiredHistoryCascadePort()` ⇒ 下面两条必红（unwired ≠ partial / failed）。
//    这样"接线是否真的装上"由机器判定，而不是靠读代码。
// ===========================================================================

const API = '/api/v1';
const START = Date.UTC(2026, 9, 23, 6);
const OWNER_RECOGNITION = '00000000-0000-4000-9a00-000000000001';
const OWNER_JOB = '00000000-0000-4000-9b00-000000000001';
const MISSING_RECOGNITION = '00000000-0000-4000-9c00-0000000000ff';

/** 一条真实的（内存）识别行：`getRecognition` / `deleteRecognition` 直接读它。 */
function recognitionRows(ownerUserId, recognitionId, jobId) {
  return {
    job: {
      id: jobId,
      revision: 2,
      kind: 'recognition',
      ownerUserId,
      recognitionId,
      mediaId: '00000000-0000-4000-9d00-000000000001',
      mediaRevision: 1,
      state: 'succeeded',
      deadlineAt: new Date(START + 60_000),
      createdAt: new Date(START),
      updatedAt: new Date(START + 1000),
      errorCode: null,
    },
    recognition: {
      id: recognitionId,
      revision: 2,
      ownerUserId,
      mediaId: '00000000-0000-4000-9d00-000000000001',
      mediaRevision: 1,
      candidates: [{ species_id: 'spc-model-1', rank: 1, model_score: 0.82 }],
      uncertaintyReasons: [],
      selectedSpeciesId: null,
      modelVersion: 'model-synthetic-v1',
      createdAt: new Date(START),
      updatedAt: new Date(START + 1000),
      deleted: false,
    },
  };
}

/**
 * 默认装配（stub + 内存 store）的 app：**不注入** `historyInjection`，
 * 因此走的就是 `app.ts` 里那条生产默认值 —— 本用例断言的正是它。
 */
async function assemblyFixture(t, { recognitionExists }) {
  const auth = createMemoryAuthStore();
  const recognitionStore = createMemoryRecognitionStore();
  const config = { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }) };
  const app = buildApp({ config, store: auth, now: () => new Date(START), recognitionStore });
  t.after(() => app.close());

  const user = await auth.createUser('c'.repeat(64));
  const token = 'synthetic-i16-cascade-wiring-1';
  await auth.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(START + 48 * 3600_000),
    audience: 'user',
  });
  if (recognitionExists) {
    const rows = recognitionRows(user.id, OWNER_RECOGNITION, OWNER_JOB);
    await recognitionStore.insertJob(rows.job);
    await recognitionStore.insertRecognition(rows.recognition);
  }
  const appended = await app.historyService.appendHistory({
    owner_id: user.id,
    kind: 'recognition',
    target_ref: { type: 'recognition', id: recognitionExists ? OWNER_RECOGNITION : MISSING_RECOGNITION, revision: 2 },
    job_id: OWNER_JOB,
    job_state: 'succeeded',
    event_key: 'recognition:cascade-wiring-1',
  });

  const remove = () =>
    app.inject({
      method: 'DELETE',
      url: `${API}/history/${appended.history.id}`,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-cascade-wiring-1', 'if-match': '"1"' },
    });
  const readRecognition = (id) =>
    app.inject({ method: 'GET', url: `${API}/recognitions/${id}`, headers: { authorization: `Bearer ${token}` } });
  return { app, remove, readRecognition, historyId: appended.history.id };
}

test('生产装配：删历史 ⇒ 关联识别被**真的软删**（GET 404），披露 partial（改回 unwired 即红）', async (t) => {
  const f = await assemblyFixture(t, { recognitionExists: true });
  assert.equal((await f.readRecognition(OWNER_RECOGNITION)).statusCode, 200, '前置：识别记录此刻可读');

  const response = await f.remove();
  assert.equal(response.statusCode, 202, `契约只声明 202：${response.body}`);
  assert.deepEqual(response.json().data, { accepted: true });
  assert.equal(
    response.headers['x-gy-cascade'],
    'partial',
    '生产默认装配必须披露 partial（识别腿已删、媒体/外发未接）；若为 unwired 说明接线没装上',
  );
  assert.equal(
    (await f.readRecognition(OWNER_RECOGNITION)).statusCode,
    404,
    '级联必须真的删掉那条识别记录（软删 ⇒ 与不存在同形 404）',
  );
});

test('生产装配：关联识别核不到（404）⇒ 一项都没删成功 ⇒ failed（⛔ 不得记 partial、⛔ 不得仍是 unwired）', async (t) => {
  const f = await assemblyFixture(t, { recognitionExists: false });

  const response = await f.remove();
  assert.equal(response.statusCode, 202);
  assert.equal(
    response.headers['x-gy-cascade'],
    'failed',
    '目标是他人/已删/不存在 ⇒ 一项都没删成功 ⇒ failed；unwired 说明接线没装上',
  );
});


