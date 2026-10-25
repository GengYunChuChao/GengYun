// GY-R34 · **`/ocr/{id}/verify` 形状拒绝**的 HTTP 面回归（真实装配 `buildApp` + `app.inject`）。
//
// 背景（为什么需要这条用例）：运行时 Ajv 沿用 `coerceTypes: 'array'`，会在 schema 校验**之前**
// 归一化原始值 —— `dosage_form: ''` 变成 `null`、`42` / `true` / `['水剂']` 变成字符串，
// 于是契约里写死的 `minLength: 1`（以及「必须为字符串」）在 HTTP 面**静默失效**：
// 空串会被当成「未采集」一路走到业务层，得到 200 或 404 而**不是** 400。
// `/registrations/verify` 早就在 `preValidation`（归一化**之前**）按原始值拒绝，`/ocr/{id}/verify`
// 此前缺这一道 ⇒ 同一份 `VerifyInput` 在两条路由上两种口径。本片把它对齐。
//
// 覆盖：
//   A. 空串 ⇒ 400 `INVALID_REQUEST`，`details` 逐项点名（`/fields/dosage_form`、
//      `/fields/ingredients/0/name` …）；
//   B. 非字符串（数字 / 布尔 / 单元素数组 / 成分项非对象）⇒ 400（这些正是 `coerceTypes` 会
//      「修好」因而 schema 判不出来的形状）；
//   C. **顺序**：钩子在 `preHandler` / 业务层**之前** —— 空串 + 不存在的 id 仍是 400（不是 404），
//      空串 + 坏 `If-Match` 仍是 400（不是 412、也不 500）；
//   D. **不许收严**（正控制）：`null`、`ingredients: []`、**纯空白** `'   '`、以及完整字段
//      ⇒ 一律 200（前者是契约允许的「未采集」，纯空白是 `minLength: 1` 允许且服务层按空读归一）；
//   E. 钩子**不越界**：缺键 / 多余键 / `fields` 非对象 / `conditions` 非法仍由 **schema** 判 400
//      （错误封套形状不变）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createMemoryIdempotencyStore } from '../../services/api/src/auth/idempotency.ts';

const API = '/api/v1';
const URL_VERIFY = (id) => `${API}/ocr/${id}/verify`;
const SESSION_KEY = 'synthetic-gyr34-ocr-verify-align-signing-key-0123456789';

// ---------------------------------------------------------------- 装配 / 会话

function newApp() {
  const config = loadConfig({
    APP_EXECUTION_MODE: 'stub',
    LOG_LEVEL: 'silent',
    SESSION_SIGNING_KEY: SESSION_KEY,
  });
  const store = createMemoryAuthStore();
  const app = buildApp({ config, store, idempotency: createMemoryIdempotencyStore() });
  return { app, store };
}

let loginCounter = 0;
async function login(app) {
  loginCounter += 1;
  const res = await app.inject({
    method: 'POST',
    url: `${API}/auth/wechat`,
    headers: { 'idempotency-key': `gyr34-ocr-verify-align-login-${String(loginCounter).padStart(4, '0')}` },
    payload: { code: `synthetic-gyr34-ocr-verify-align-${loginCounter}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data.access_token;
}

/** 断言一条错误封套的形状（契约 `ErrorEnvelope`：code / message / retryable / details）。 */
function assertErrorEnvelope(body, code) {
  assert.deepEqual(Object.keys(body).sort(), ['error', 'meta']);
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'details', 'message', 'retryable']);
  assert.equal(body.error.code, code);
  assert.deepEqual(Object.keys(body.meta).sort(), ['contract_version', 'execution_mode', 'request_id']);
}

// ---------------------------------------------------------------- 夹具

/** 找一个哈希分桶等于 bucket 的媒体 uuid（与替身提供者的确定性分桶口径一致）。 */
const bucketCache = new Map();
function mediaIdForBucket(bucket) {
  if (bucketCache.has(bucket)) return bucketCache.get(bucket);
  for (let attempt = 0; attempt < 500000; attempt += 1) {
    const candidate = randomUUID();
    if (createHash('sha256').update(candidate).digest()[0] % 6 === bucket) {
      bucketCache.set(bucket, candidate);
      return candidate;
    }
  }
  throw new Error(`未能找到分桶 ${bucket} 的媒体 uuid`);
}

let keyCounter = 0;
function nextKey(prefix) {
  keyCounter += 1;
  return `gyr34-${prefix}-${String(keyCounter).padStart(6, '0')}`;
}

/**
 * 走**真实 HTTP 面**受理一个 OCR 任务、驱动替身落定，读回记录投影（含 `revision` / `raw_fields`）。
 * 与线上一致：`POST /ocr` → 202，随后由执行器推进；此处直接驱动内存 store 的 `settle()`。
 */
async function createRecord(app, token, bucket = 0) {
  const accepted = await app.inject({
    method: 'POST',
    url: `${API}/ocr`,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': nextKey('ocr') },
    payload: { media_id: mediaIdForBucket(bucket), media_revision: 1 },
  });
  assert.equal(accepted.statusCode, 202, accepted.body);
  const ocrId = accepted.json().data.target_ref.id;
  await app.ocrService.settle();
  const read = await app.inject({
    method: 'GET',
    url: `${API}/ocr/${ocrId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(read.statusCode, 200, read.body);
  return read.json().data;
}

/** 发一次 verify（默认带正确的 `If-Match` 与新的幂等键）。 */
function verify(app, { token, id, revision, payload, ifMatch = 'correct', key = undefined }) {
  const headers = { authorization: `Bearer ${token}`, 'idempotency-key': key ?? nextKey('verify') };
  if (ifMatch === 'correct') headers['if-match'] = `"${revision}"`;
  else if (ifMatch !== null) headers['if-match'] = ifMatch;
  return app.inject({ method: 'POST', url: URL_VERIFY(id), headers, payload });
}

/** 用一份完整标签字段（取自替身 matched 桶）构造 `VerifyInput`，只覆盖 `patch` 里的键。 */
function inputOf(raw, patch = {}) {
  return { fields: { ...raw, ...patch } };
}

// ---------------------------------------------------------------------------
// A. 空串 ⇒ 400，details 逐项点名
// ---------------------------------------------------------------------------

test('A1. `dosage_form: ""` + 成分项 `name: ""` ⇒ 400 INVALID_REQUEST，details 逐项点名实例路径', async () => {
  const { app } = newApp();
  const token = await login(app);
  const record = await createRecord(app, token, 0);

  const res = await verify(app, {
    token,
    id: record.id,
    revision: record.revision,
    payload: inputOf(record.raw_fields, {
      dosage_form: '',
      ingredients: [{ name: '', content_text: '41', unit_text: '%' }],
    }),
  });

  assert.equal(res.statusCode, 400, res.body);
  const body = res.json();
  assertErrorEnvelope(body, 'INVALID_REQUEST');
  assert.equal(res.headers.etag, undefined, '拒绝的请求不得带出 ETag');
  assert.equal(body.data, undefined, '拒绝的请求不得带出任何核对结论');
  // 逐项点名：字段路径 + 原因（与 `/registrations/verify` 同形）。
  assert.deepEqual(
    body.error.details.map((item) => item.field),
    ['/fields/dosage_form', '/fields/ingredients/0/name'],
  );
  assert.equal(body.error.details[0].code, '必须是长度不少于 1 的字符串（不得为空串）');
  assert.equal(body.error.details[1].code, '必须是长度不少于 1 的字符串（不得为空串）');
});

test('A2. 三个可空文本维度的空串都拒（`registration_number` / `name` / `dosage_form` 逐个点名）', async () => {
  const { app } = newApp();
  const token = await login(app);

  const cases = [
    { key: 'registration_number', field: '/fields/registration_number' },
    { key: 'name', field: '/fields/name' },
    { key: 'dosage_form', field: '/fields/dosage_form' },
  ];
  for (const item of cases) {
    const record = await createRecord(app, token, 0);
    const res = await verify(app, {
      token,
      id: record.id,
      revision: record.revision,
      payload: inputOf(record.raw_fields, { [item.key]: '' }),
    });
    assert.equal(res.statusCode, 400, `${item.key} 空串应 400：${res.body}`);
    const body = res.json();
    assertErrorEnvelope(body, 'INVALID_REQUEST');
    assert.deepEqual(body.error.details.map((detail) => detail.field), [item.field], item.key);
  }
});

// ---------------------------------------------------------------------------
// B. 非字符串 ⇒ 400（正是 `coerceTypes: 'array'` 会「修好」因而 schema 判不出来的形状）
// ---------------------------------------------------------------------------

test('B1. 非字符串（数字 / 布尔 / 单元素数组 / 成分项非对象）⇒ 400，且逐项点名', async () => {
  const { app } = newApp();
  const token = await login(app);

  const cases = [
    { label: '数字', patch: { dosage_form: 42 }, field: '/fields/dosage_form' },
    { label: '布尔', patch: { name: true }, field: '/fields/name' },
    { label: '单元素数组', patch: { dosage_form: ['水剂'] }, field: '/fields/dosage_form' },
    { label: '对象', patch: { registration_number: { value: 'PD20210001' } }, field: '/fields/registration_number' },
  ];
  for (const item of cases) {
    const record = await createRecord(app, token, 0);
    const res = await verify(app, {
      token,
      id: record.id,
      revision: record.revision,
      payload: inputOf(record.raw_fields, item.patch),
    });
    assert.equal(res.statusCode, 400, `${item.label} 应 400：${res.body}`);
    const body = res.json();
    assertErrorEnvelope(body, 'INVALID_REQUEST');
    assert.deepEqual(body.error.details.map((detail) => detail.field), [item.field], item.label);
    assert.notEqual(body.error.details[0].code, undefined, `${item.label} 必须带原因`);
  }
});

test('B2. 成分项形状非法（`ingredients: [null]` / 成分项里的数字）⇒ 400，路径定位到具体成分项', async () => {
  const { app } = newApp();
  const token = await login(app);

  const record = await createRecord(app, token, 0);
  const notObject = await verify(app, {
    token,
    id: record.id,
    revision: record.revision,
    payload: inputOf(record.raw_fields, { ingredients: [null] }),
  });
  assert.equal(notObject.statusCode, 400, notObject.body);
  assertErrorEnvelope(notObject.json(), 'INVALID_REQUEST');
  assert.deepEqual(notObject.json().error.details.map((detail) => detail.field), ['/fields/ingredients/0']);

  const record2 = await createRecord(app, token, 0);
  const numberInIngredient = await verify(app, {
    token,
    id: record2.id,
    revision: record2.revision,
    payload: inputOf(record2.raw_fields, {
      ingredients: [{ name: '草甘膦', content_text: 41, unit_text: '%' }],
    }),
  });
  assert.equal(numberInIngredient.statusCode, 400, numberInIngredient.body);
  assert.deepEqual(
    numberInIngredient.json().error.details.map((detail) => detail.field),
    ['/fields/ingredients/0/content_text'],
  );
});

// ---------------------------------------------------------------------------
// C. 顺序：钩子在 preHandler / 业务层之前（不泄露记录存在性、不先报 412/500）
// ---------------------------------------------------------------------------

test('C1. 空串 + **不存在的 id** ⇒ 400（不是 404）：形状校验先于归属查询，不泄露存在性', async () => {
  const { app } = newApp();
  const token = await login(app);
  const missingId = randomUUID();

  const res = await verify(app, {
    token,
    id: missingId,
    revision: 1,
    payload: inputOf(
      { registration_number: 'PD20210001', name: '替身示例草甘膦水剂', ingredients: [], dosage_form: '水剂' },
      { dosage_form: '' },
    ),
  });
  assert.equal(res.statusCode, 400, res.body);
  const body = res.json();
  assertErrorEnvelope(body, 'INVALID_REQUEST');
  assert.equal(body.error.code === 'NOT_FOUND', false, '不得先报存在性结论');
});

test('C2. 空串 + **坏的 If-Match** ⇒ 仍是 400（不是 412）：钩子先于业务层的版本比对', async () => {
  const { app } = newApp();
  const token = await login(app);
  const record = await createRecord(app, token, 0);

  const res = await verify(app, {
    token,
    id: record.id,
    revision: record.revision,
    ifMatch: '"999"',
    payload: inputOf(record.raw_fields, { dosage_form: '' }),
  });
  assert.equal(res.statusCode, 400, res.body);
  assertErrorEnvelope(res.json(), 'INVALID_REQUEST');
});

// ---------------------------------------------------------------------------
// D. 正控制：**不许收严**（`null` / `[]` / 纯空白 / 完整字段 ⇒ 200）
// ---------------------------------------------------------------------------

test('D1. `null` / `ingredients: []` / **纯空白** / 完整字段 ⇒ 一律 200（形状放行，交业务层）', async () => {
  const { app } = newApp();
  const token = await login(app);

  // 逐个用独立记录，避免 revision 互相牵扯。
  const cases = [
    { label: 'dosage_form=null', patch: { dosage_form: null }, expected: 'insufficient' },
    { label: 'ingredients=[]', patch: { ingredients: [] }, expected: 'insufficient' },
    { label: '纯空白 dosage_form', patch: { dosage_form: '   ' }, expected: 'insufficient' },
    { label: '完整字段', patch: {}, expected: 'matched' },
  ];
  for (const item of cases) {
    const record = await createRecord(app, token, 0);
    const res = await verify(app, {
      token,
      id: record.id,
      revision: record.revision,
      payload: inputOf(record.raw_fields, item.patch),
    });
    assert.equal(res.statusCode, 200, `${item.label} 不得被形状校验收严：${res.body}`);
    assert.deepEqual(Object.keys(res.json()).sort(), ['data', 'meta'], item.label);
    assert.equal(res.json().data.match_state, item.expected, item.label);
    assert.notEqual(res.headers.etag, undefined, `${item.label}：放行的请求仍应带出 ETag`);
  }
});

test('D2. 纯空白**不**报 400 而按「未采集」处理：`missing_fields` 点名该维度、且不诬成 conflict', async () => {
  const { app } = newApp();
  const token = await login(app);
  const record = await createRecord(app, token, 0);

  const res = await verify(app, {
    token,
    id: record.id,
    revision: record.revision,
    payload: inputOf(record.raw_fields, { dosage_form: '  \t ' }),
  });
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json().data;
  assert.equal(data.match_state, 'insufficient', '空白剂型不得判 matched');
  assert.deepEqual(data.missing_fields, ['dosage_form']);
  assert.deepEqual(data.conflict_fields, [], '空读不是「另一种剂型」，绝不得诬成 conflict');
  assert.equal(data.registration, null);
});

// ---------------------------------------------------------------------------
// E. 钩子不越界：缺键 / 多余键 / fields 非对象 / conditions 非法仍由 schema 判 400
// ---------------------------------------------------------------------------

test('E1. 缺键 / 多余键 / `fields` 非对象 / `conditions` 非法 ⇒ 仍由 schema 判 400（封套形状不变）', async () => {
  const { app } = newApp();
  const token = await login(app);
  const record = await createRecord(app, token, 0);
  const raw = record.raw_fields;

  const payloads = [
    { label: '缺 fields', payload: {} },
    { label: 'fields=字符串', payload: { fields: 'not-an-object' } },
    { label: '多余键', payload: { fields: { ...raw, unrecognized: 1 } } },
    { label: '缺 ingredient 键', payload: { fields: { ...raw, ingredients: [{ name: '草甘膦' }] } } },
    {
      label: 'conditions 非法键',
      payload: { fields: { ...raw }, conditions: { crop_id: 'rice', illegal_key: 'x' } },
    },
    { label: '超长字符串', payload: { fields: { ...raw, name: 'x'.repeat(81) } } },
  ];
  for (const item of payloads) {
    const res = await verify(app, {
      token,
      id: record.id,
      revision: record.revision,
      payload: item.payload,
    });
    assert.equal(res.statusCode, 400, `${item.label} 应 400：${res.body}`);
    assertErrorEnvelope(res.json(), 'INVALID_REQUEST');
  }
});

test('E2. 20 项以上的 details 被截断到 30 条上限内（错误封套不得因输入规模膨胀）', async () => {
  const { app } = newApp();
  const token = await login(app);
  const record = await createRecord(app, token, 0);

  // 20 个成分项 × 3 个空串键 = 60 处违规 ⇒ details 必须被截断。
  const ingredients = Array.from({ length: 20 }, () => ({ name: '', content_text: '', unit_text: '' }));
  const res = await verify(app, {
    token,
    id: record.id,
    revision: record.revision,
    payload: inputOf(record.raw_fields, { ingredients }),
  });
  assert.equal(res.statusCode, 400, res.body);
  const body = res.json();
  assertErrorEnvelope(body, 'INVALID_REQUEST');
  assert.ok(Array.isArray(body.error.details), 'details 必须是数组');
  assert.equal(body.error.details.length, 30, `details 必须截断到 30 条，实际 ${body.error.details.length}`);
});
