// GY-I04 · **登记核对 HTTP 面**（契约 operationId `verifyRegistration`，
// `POST /registrations/verify`）的端到端回归（真实装配 `buildApp` + `app.inject`）。
//
// 覆盖：
//   A. 鉴权：未登录 401 `SESSION_REQUIRED`、坏令牌 401 `SESSION_EXPIRED`（不泄露任何业务结论）；
//   B. `Idempotency-Key` 形状（契约 required，8..128）：缺/短/长 ⇒ 400 `IDEMPOTENCY_KEY_REQUIRED`；
//   C. 请求体契约（`VerifyInput` additionalProperties:false）：缺键/多余键/越界/非法地区码/多余查询串 ⇒ 400；
//   D. 200 封套：`VerificationEnvelope{data,meta}`、`data` 严格五键、`Cache-Control: no-store`、无 `ETag`；
//   E. 结论：matched / conflict / insufficient / no_match（**不是**「请求存在就通过」）；
//   F. 全局开关不可绕过：关闭「药剂输出」⇒ 409 且**零制剂字段**；重开 ⇒ 立即恢复；
//   G. 重放：同一 `Idempotency-Key` 同体两次结论一致（纯函数、无台账）；换键同体也一致；
//   H. 信息泄露：响应不含幂等键原值、内部标识、bearer；错误封套形状仍守契约；
//   I. real 模式（真实登记库未接线）⇒ 200 `unavailable`（fail-closed，不伪装成 no_match）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createMemoryIdempotencyStore } from '../../services/api/src/auth/idempotency.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';

const API = '/api/v1';
const URL_VERIFY = `${API}/registrations/verify`;
const SESSION_KEY = 'synthetic-i04-regverify-signing-key-0123456789';
const IDEM = 'gyi04-idem-key-000001';
const contract = JSON.parse(
  readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'),
);
const schemas = contract.components.schemas;
const VERIFICATION_KEYS = [...schemas.Verification.required].sort();
const OPERATION = contract.paths['/registrations/verify'].post;

/** 仓内真实记录 `PD20161371`（唑草酮 / 水分散粒剂 / 唑草酮 40%）的一条完整标签读取结果。 */
function bodyOf(patch = {}) {
  return {
    fields: {
      registration_number: 'PD20161371',
      name: '唑草酮',
      ingredients: [{ name: '唑草酮', content_text: '40%', unit_text: '%' }],
      dosage_form: '水分散粒剂',
      ...patch,
    },
  };
}

function stubConfig() {
  return loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', SESSION_SIGNING_KEY: SESSION_KEY });
}

async function newApp({ executionMode = 'stub' } = {}) {
  const base = stubConfig();
  const config = executionMode === 'real'
    ? { ...base, logLevel: 'silent', executionMode: 'real', requiresRealCredentials: true }
    : base;
  const store = createMemoryAuthStore();
  const app = buildApp({ config, store, idempotency: createMemoryIdempotencyStore() });
  return { app, store };
}

async function login(app, code = 'synthetic-i04-regverify') {
  const res = await app.inject({
    method: 'POST',
    url: `${API}/auth/wechat`,
    headers: { 'idempotency-key': IDEM },
    payload: { code },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data.access_token;
}

/** real 模式下的合成会话（真实模式不回退替身身份，与同族用例一致）。 */
async function syntheticSession(store) {
  const token = 'synthetic-i04-regverify-real-mode-token';
  const user = await store.createUser('synthetic-i04-regverify-real-mode');
  await store.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(Date.now() + 3_600_000),
    audience: 'user',
  });
  return token;
}

async function seedAdmin(store) {
  const adminId = await store.createAdmin({
    loginName: `gyi04-regverify-${Math.random().toString(36).slice(2, 10)}`,
    credentialHash: 'synthetic-not-a-real-credential-hash',
    scopes: ['flags:read', 'flags:write', 'sources:read', 'sources:write', 'audit:read'],
  });
  const token = mintOpaqueToken();
  await store.createSession({
    userId: adminId,
    tokenHashHex: hashToken(token),
    authEpoch: 1,
    expiresAt: new Date(Date.now() + 3_600_000),
    audience: 'admin',
  });
  return token;
}

/** 「完全不带请求体」的哨兵（与「显式传 undefined」区分开：后者会落回默认请求体）。 */
const NO_BODY = Symbol('no-body');
const DEFAULT_PAYLOAD = Symbol('default-payload');

function post(app, { token, key = IDEM, payload = DEFAULT_PAYLOAD, url = URL_VERIFY } = {}) {
  const headers = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (key !== null) headers['idempotency-key'] = key;
  const request = { method: 'POST', url, headers };
  if (payload !== NO_BODY) request.payload = payload === DEFAULT_PAYLOAD ? bodyOf() : payload;
  return app.inject(request);
}

/** 断言一条错误封套的形状（契约 `ErrorEnvelope`：code / message / retryable / details）。 */
function assertErrorEnvelope(body, code) {
  assert.deepEqual(Object.keys(body).sort(), ['error', 'meta']);
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'details', 'message', 'retryable']);
  assert.equal(body.error.code, code);
  assert.deepEqual(Object.keys(body.meta).sort(), ['contract_version', 'execution_mode', 'request_id']);
}

// ---------------------------------------------------------------------------
// A. 鉴权
// ---------------------------------------------------------------------------

test('A1. 未登录 ⇒ 401 SESSION_REQUIRED；坏令牌 ⇒ 401 SESSION_EXPIRED（不产出任何核对结论）', async () => {
  const { app } = await newApp();
  try {
    const anonymous = await post(app, { token: undefined });
    assert.equal(anonymous.statusCode, 401, anonymous.body);
    assertErrorEnvelope(anonymous.json(), 'SESSION_REQUIRED');
    assert.equal(anonymous.json().data, undefined, '未鉴权不得返回成功封套');
    assert.equal(anonymous.headers['cache-control'], 'no-store');

    const bad = await post(app, { token: 'not-a-real-token' });
    assert.equal(bad.statusCode, 401, bad.body);
    assertErrorEnvelope(bad.json(), 'SESSION_EXPIRED');
    // 无论 401 的原因，响应里都不得出现任何制剂字段（不能借错误路径泄露登记数据）。
    for (const forbidden of ['formulation', 'registration_number', 'dosage_form', 'ingredient']) {
      assert.equal(JSON.stringify(bad.json()).includes(forbidden), false, `401 泄露 ${forbidden}`);
    }
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// B. Idempotency-Key 形状（契约 parameters.Idempotency-Key：required，8..128）
// ---------------------------------------------------------------------------

test('B1. Idempotency-Key 缺失/过短/过长 ⇒ 400 IDEMPOTENCY_KEY_REQUIRED（形状校验，不落台账）', async () => {
  const { app } = await newApp();
  try {
    const token = await login(app);
    const idemParam = OPERATION.parameters.find((param) => param.$ref === '#/components/parameters/IdempotencyKey');
    assert.ok(idemParam, '契约必须仍声明 Idempotency-Key 参数');
    assert.equal(schemas === undefined, false);

    for (const [label, key] of [
      ['缺失', null],
      ['7 字符', 'a'.repeat(7)],
      ['129 字符', 'a'.repeat(129)],
    ]) {
      const res = await post(app, { token, key });
      assert.equal(res.statusCode, 400, `${label} 的键应被拒：${res.body}`);
      assertErrorEnvelope(res.json(), 'IDEMPOTENCY_KEY_REQUIRED');
    }
    // 正控制：契约边界内（8 / 128）必须放行到业务层（此处为 200 matched）。
    for (const key of ['a'.repeat(8), 'b'.repeat(128)]) {
      const res = await post(app, { token, key });
      assert.equal(res.statusCode, 200, `边界内的键不得被拒：${key.length} 字符 ${res.body}`);
    }
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// C. 请求体契约
// ---------------------------------------------------------------------------

test('C1. 请求体逐字段守契约（additionalProperties:false）⇒ 缺键/多余键/越界一律 400 INVALID_REQUEST', async () => {
  const { app } = await newApp();
  try {
    const token = await login(app);
    const cases = [
      ['无请求体', NO_BODY],
      ['缺 fields', { conditions: { crop_id: 'crop_rice', region_code: '330000' } }],
      ['fields 缺 dosage_form', { fields: { registration_number: 'PD20161371', name: '唑草酮', ingredients: [] } }],
      ['fields 多余字段', { fields: { ...bodyOf().fields, extra: 1 } }],
      ['顶层多余字段', { ...bodyOf(), extra: 1 }],
      ['登记号超长', bodyOf({ registration_number: 'x'.repeat(81) })],
      ['成分超过 20 条', { fields: { ...bodyOf().fields, ingredients: Array.from({ length: 21 }, () => ({ name: 'a', content_text: '1%', unit_text: '%' })) } }],
      ['成分缺键', { fields: { ...bodyOf().fields, ingredients: [{ name: 'a', content_text: '1%' }] } }],
      ['conditions 缺 region_code', { ...bodyOf(), conditions: { crop_id: 'crop_rice' } }],
      ['conditions 地区码非法', { ...bodyOf(), conditions: { crop_id: 'crop_rice', region_code: '440000' } }],
    ];
    for (const [label, payload] of cases) {
      const res = await post(app, { token, payload });
      assert.equal(res.statusCode, 400, `${label} 应为 400：${res.body}`);
      assert.equal(res.json().error.code, 'INVALID_REQUEST', `${label} 错误码：${res.body}`);
    }
    // 该 operation 契约里没有 query 参数 ⇒ 任何查询串都 400（不静默忽略）。
    const withQuery = await post(app, { token, url: `${URL_VERIFY}?dry_run=1` });
    assert.equal(withQuery.statusCode, 400, withQuery.body);
    assert.equal(withQuery.json().error.code, 'INVALID_REQUEST');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// D. 200 封套
// ---------------------------------------------------------------------------

test('D1. matched 200：VerificationEnvelope 形状、data 严格五键、no-store、无 ETag', async () => {
  const { app } = await newApp();
  try {
    const token = await login(app);
    const res = await post(app, { token });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['cache-control'], 'no-store');
    // 契约 200 的 ETag 说明是「资源 revision 强 ETag」；本操作不产生任何资源 ⇒ 不伪造该头。
    assert.equal(res.headers.etag, undefined, '本操作无资源 revision ⇒ 不得自造 ETag');

    const body = res.json();
    assert.deepEqual(Object.keys(body).sort(), ['data', 'meta']);
    assert.deepEqual(Object.keys(body.data).sort(), VERIFICATION_KEYS);
    assert.deepEqual(Object.keys(body.meta).sort(), ['contract_version', 'execution_mode', 'request_id']);
    assert.equal(body.meta.contract_version, '1.0.0');
    assert.equal(body.meta.execution_mode, 'stub');
    assert.match(body.meta.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// E. 结论（不是「请求存在就通过」）
// ---------------------------------------------------------------------------

test('E1. 结论由字段决定：matched / conflict / insufficient / no_match 各归其位', async () => {
  const { app } = await newApp();
  try {
    const token = await login(app);

    const matched = (await post(app, { token })).json().data;
    assert.equal(matched.match_state, 'matched');
    assert.deepEqual(matched.conflict_fields, []);
    assert.deepEqual(matched.missing_fields, []);
    assert.deepEqual(matched.dose_cards, [], '无已审用量来源 ⇒ 用量卡恒空');
    assert.equal(matched.registration.formulation.registration_number, 'PD20161371');

    const conflict = (await post(app, { token, payload: bodyOf({ dosage_form: '乳油' }) })).json().data;
    assert.equal(conflict.match_state, 'conflict');
    assert.deepEqual(conflict.conflict_fields, ['dosage_form']);

    const insufficient = (await post(app, { token, payload: bodyOf({ registration_number: null }) })).json().data;
    assert.equal(insufficient.match_state, 'insufficient');
    assert.deepEqual(insufficient.missing_fields, ['registration_number']);
    assert.equal(insufficient.registration, null);

    const noMatch = (await post(app, {
      token,
      payload: bodyOf({ registration_number: 'PD00000000', name: '不存在的药剂名称' }),
    })).json().data;
    assert.equal(noMatch.match_state, 'no_match');
    assert.equal(noMatch.registration, null);

    // 「只要请求存在就 matched」会被这一条直接钉死：同一端点、同一键域，结论随字段变化。
    assert.deepEqual(
      new Set([matched.match_state, conflict.match_state, insufficient.match_state, noMatch.match_state]).size,
      4,
    );
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// F. 全局开关不可绕过
// ---------------------------------------------------------------------------

test('F1. 关闭「药剂输出」⇒ 409 OBJECT_UNAVAILABLE 且零制剂字段；重开 ⇒ 立即恢复', async () => {
  const { app, store } = await newApp();
  try {
    const userToken = await login(app);
    const adminToken = await seedAdmin(store);

    // 关闭前：真实产出。
    const before = await post(app, { token: userToken });
    assert.equal(before.statusCode, 200, before.body);
    assert.equal(before.json().data.match_state, 'matched');

    const closed = await app.inject({
      method: 'PUT',
      url: `${API}/admin/feature-flags/specific_herbicide_output_enabled`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'gyi04-regverify-flag-close-0001',
        'if-match': '"1"',
      },
      payload: { enabled: false, reason: '示例：比赛期间停止药剂输出' },
    });
    assert.equal(closed.statusCode, 200, closed.body);
    assert.equal(closed.json().data.enabled, false);

    // 关闭后：本端点必须同样拒绝（否则「关闭药剂输出」可被这个新端点绕过）。
    const blocked = await post(app, { token: userToken });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assertErrorEnvelope(blocked.json(), 'OBJECT_UNAVAILABLE');
    assert.equal(blocked.json().error.retryable, false);
    assert.equal(blocked.json().data, undefined, '拒绝时不得返回成功封套');
    for (const forbidden of ['formulation', 'registration_number', 'dosage_form', 'ingredient', 'risk_text', 'producer', 'dose_card']) {
      assert.equal(JSON.stringify(blocked.json()).includes(forbidden), false, `拒绝却仍带出 ${forbidden}`);
    }
    // 未登录方仍先吃 401：开关状态不泄露给未鉴权调用方。
    const anonymous = await post(app, { token: undefined });
    assert.equal(anonymous.statusCode, 401);

    // 重开 ⇒ 立即恢复（没有负缓存把关闭态粘住）。
    const reopened = await app.inject({
      method: 'PUT',
      url: `${API}/admin/feature-flags/specific_herbicide_output_enabled`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'gyi04-regverify-flag-open-0001',
        'if-match': '"2"',
      },
      payload: { enabled: true, reason: '示例：恢复药剂输出' },
    });
    assert.equal(reopened.statusCode, 200, reopened.body);
    const after = await post(app, { token: userToken });
    assert.equal(after.statusCode, 200, after.body);
    assert.equal(after.json().data.match_state, 'matched');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// G. 重放
// ---------------------------------------------------------------------------

test('G1. 同一 Idempotency-Key 重放 ⇒ 结论一致且无副作用；换键同体 ⇒ 结论也一致', async () => {
  const { app } = await newApp();
  try {
    const token = await login(app);
    const first = await post(app, { token, key: 'gyi04-replay-00000001' });
    const replay = await post(app, { token, key: 'gyi04-replay-00000001' });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(replay.statusCode, 200, replay.body);
    // 结论（data）逐字节一致；只有 meta.request_id 是每次请求各自的（Fastify 生成）。
    assert.equal(JSON.stringify(first.json().data), JSON.stringify(replay.json().data));
    assert.notEqual(first.json().meta.request_id, replay.json().meta.request_id);

    // 换一个键、同一请求体：仍然是同一结论（本端点幂等由纯函数给出，不写 24h 台账）。
    const otherKey = await post(app, { token, key: 'gyi04-replay-00000002' });
    assert.equal(JSON.stringify(otherKey.json().data), JSON.stringify(first.json().data));

    // 五次重放后仍稳定：不是「第一次算完被缓存」，也不是「重放被记账」。
    for (let index = 0; index < 5; index += 1) {
      const again = await post(app, { token, key: `gyi04-replay-0000000${index}` });
      assert.equal(JSON.stringify(again.json().data), JSON.stringify(first.json().data));
    }
  } finally {
    await app.close();
  }
});

test('G2. 重放不会把「冲突」翻成「通过」：同键重放冲突请求仍为 conflict', async () => {
  const { app } = await newApp();
  try {
    const token = await login(app);
    const payload = bodyOf({ dosage_form: '乳油' });
    const first = await post(app, { token, key: 'gyi04-replay-conflict-01', payload });
    const replay = await post(app, { token, key: 'gyi04-replay-conflict-01', payload });
    assert.equal(first.json().data.match_state, 'conflict');
    assert.equal(replay.json().data.match_state, 'conflict');
    assert.deepEqual(replay.json().data.conflict_fields, ['dosage_form']);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// H. 信息泄露
// ---------------------------------------------------------------------------

test('H1. 响应不回显幂等键原值/令牌，也不含内部标识', async () => {
  const { app } = await newApp();
  try {
    const token = await login(app);
    const key = 'gyi04-canary-idempotency-key-0001';
    const res = await post(app, { token, key });
    const text = JSON.stringify(res.json()) + JSON.stringify(res.headers);
    for (const forbidden of [key, token, 'record_id', 'source_version', 'identity_hash', 'gy-i03-hb', 'content_hash']) {
      assert.equal(text.includes(forbidden), false, `响应里不得出现 ${forbidden}`);
    }
    // 反向控制：契约字段确实在（否则上一条会因为「响应是空的」而假绿）。
    assert.equal(text.includes('registration_number'), true);
    assert.equal(text.includes('"match_state"'), true);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// I. real 模式：真实登记库未接线 ⇒ unavailable（fail-closed）
// ---------------------------------------------------------------------------

test('I1. real 模式 ⇒ 200 + match_state=unavailable（不伪装成 no_match / matched）', async () => {
  const { app, store } = await newApp({ executionMode: 'real' });
  try {
    const token = await syntheticSession(store);
    const res = await post(app, { token });
    assert.equal(res.statusCode, 200, res.body);
    const data = res.json().data;
    assert.equal(data.match_state, 'unavailable');
    assert.equal(data.registration, null);
    assert.deepEqual(data.dose_cards, []);
    assert.equal(res.json().meta.execution_mode, 'real');
    assert.equal(res.headers['cache-control'], 'no-store');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// J. 待核维度缺失（R1）：HTTP 面同样不得报 matched
// ---------------------------------------------------------------------------

test('J1. ingredients=[] / 纯空白 dosage_form ⇒ 200 非 matched（insufficient）且 missing_fields 点名该维度', async () => {
  const { app } = await newApp();
  try {
    const token = await login(app);
    // 两条都是**契约合法请求**（`ingredients` 无 minItems；`dosage_form` 的 minLength 只挡空串），
    // 因此它们必须走到业务层并由业务层给出「未核对完成」的结论，而不是 400 或 matched。
    for (const [label, payload, expectedField] of [
      ['ingredients 空数组', bodyOf({ ingredients: [] }), 'ingredients'],
      ['dosage_form 纯空白', bodyOf({ dosage_form: '   ' }), 'dosage_form'],
    ]) {
      const res = await post(app, { token, payload });
      assert.equal(res.statusCode, 200, `${label}：${res.body}`);
      const data = res.json().data;
      assert.notEqual(data.match_state, 'matched', `${label} 不得报核对通过：${res.body}`);
      assert.equal(data.match_state, 'insufficient', `${label}：${res.body}`);
      assert.deepEqual(data.missing_fields, [expectedField], `${label} 必须点名缺失维度`);
      assert.equal(data.registration, null, `${label} 未核对完成不得带出登记记录`);
      assert.deepEqual(data.conflict_fields, [], `${label} 缺失不是冲突`);
      assert.deepEqual(data.dose_cards, [], `${label}`);
      assert.deepEqual(Object.keys(data).sort(), VERIFICATION_KEYS, `${label} 仍严格是契约五键`);
      assert.equal(res.headers['cache-control'], 'no-store');
    }
  } finally {
    await app.close();
  }
});
