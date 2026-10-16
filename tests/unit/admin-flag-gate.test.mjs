// GY-I18 本片 · **全局开关跨端点真实生效** 的回归（`Refs #18`）。
//
// 覆盖（每条都是实测断言，不是设计声明）：
//   A. 受控面清单与契约镜像一致（`FLAG_GATED_SURFACES` ⟷ `packages/contracts/operations.json`）。
//   B. 闸门语义：已配置开 ⇒ 放行；已配置关 ⇒ 409 `OBJECT_UNAVAILABLE`（retryable:false）；
//      缺失/非布尔/key 越界/读取抛错 ⇒ 503 `PROVIDER_UNAVAILABLE`（retryable:true，fail-closed）。
//   C. **零产出**：关闭时代理层一次都不会调用被包装的产出方（调用计数恒 0）。
//   D. **开关不改变适用判定结论**：开启时结果与不加闸门逐字节相同；关闭时是"拒绝"而不是"改过的结论"。
//   E. HTTP 跨端点：/herbicides 关闭 ⇒ 拒绝且响应里没有制剂/用量/成分任何字段；
//      断言顺序（未登录仍 401，开关状态不泄露给未鉴权方）；未受控面（/knowledge 列表、/health）不受影响。
//   F. 投稿面（本用例在服务层生效；社区 16 条路由已装配，投稿面经 `gatedGuards` 判开关，见 services/api/src/app.ts:1075）：关闭 ⇒ createPost 拒绝且**零落库**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createMemoryIdempotencyStore } from '../../services/api/src/auth/idempotency.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { CONTRACT_FLAG_KEYS } from '../../services/api/src/admin/ops/flags.ts';
import {
  FLAG_GATED_SURFACES,
  FLAG_WIRING_BASELINE,
  createFeatureFlagGate,
  createFlagGatedGuards,
  createStoreFlagReader,
  flagSeedFromBaseline,
  gateCommunityService,
  gateProducer,
} from '../../services/api/src/admin/ops/flag-gate.ts';
import { createAdminOpsStore } from '../../services/api/src/admin/ops/store.ts';
import { makeHarness, CLEAN_BODY, CLEAN_TITLE, USER_A, idem, makeSyntheticPassPort } from '../unit/community-fixtures.mjs';

const operations = JSON.parse(
  readFileSync(new URL('../../packages/contracts/operations.json', import.meta.url), 'utf8'),
);
const CONTRACT_OPS = new Map(operations.operations.map((op) => [op.id, op]));
const API = '/api/v1';
const SESSION_KEY = 'synthetic-i18-flaggate-signing-key-0123456789';
const ALL_SCOPES = ['flags:read', 'flags:write', 'sources:read', 'sources:write', 'audit:read'];

// ---------------------------------------------------------------------------
// A. 契约镜像
// ---------------------------------------------------------------------------

test('A. 受控面清单逐条对上契约（operationId / method / path），且只覆盖闭集内的 3 个开关', () => {
  assert.equal(FLAG_GATED_SURFACES.length > 0, true);
  for (const surface of FLAG_GATED_SURFACES) {
    const op = CONTRACT_OPS.get(surface.operationId);
    assert.ok(op, `受控面引用了契约里不存在的 operationId：${surface.operationId}`);
    assert.equal(surface.method.toLowerCase(), op.method, `${surface.operationId} 方法不符`);
    assert.equal(surface.routePattern, `${API}${op.path.replaceAll('{id}', ':id')}`, `${surface.operationId} 路径不符`);
    assert.equal(CONTRACT_FLAG_KEYS.includes(surface.key), true, `开关 key 不在契约闭集：${surface.key}`);
  }
  // 3 个开关都有受控面（否则"开关真实生效"无从谈起）。
  assert.deepEqual([...new Set(FLAG_GATED_SURFACES.map((s) => s.key))].sort(), [...CONTRACT_FLAG_KEYS].sort());
  // 没有重复的 (method, path)：重复会让判定顺序变得不确定。
  const routes = FLAG_GATED_SURFACES.map((s) => `${s.method} ${s.routePattern}`);
  assert.equal(new Set(routes).size, routes.length);
  // 装配基线覆盖全部 3 个 key，且是布尔值（不是"未定义"这种容易漂移的状态）。
  for (const key of CONTRACT_FLAG_KEYS) assert.equal(typeof FLAG_WIRING_BASELINE[key], 'boolean', key);
});

// ---------------------------------------------------------------------------
// B/C/D. 闸门语义 / 零产出 / 不改变判定
// ---------------------------------------------------------------------------

function readerOf(records) {
  const table = new Map(Object.entries(records));
  return createStoreFlagReader({ getFlag: (key) => table.get(key) ?? null });
}

const KEY = 'specific_herbicide_output_enabled';
const SURFACE = '除草剂登记制剂列表输出';

test('B1. 已配置「开」⇒ 放行，判据是存储值（decidedBy=configured）', () => {
  const gate = createFeatureFlagGate({ reader: readerOf({ [KEY]: { key: KEY, enabled: true, revision: 7 } }) });
  const verdict = gate.verdictFor(KEY, SURFACE);
  assert.equal(verdict.state, 'open');
  assert.equal(verdict.decidedBy, 'configured');
  assert.equal(verdict.revision, 7);
  gate.assertOpen(KEY, SURFACE); // 不抛
});

test('B2. 已配置「关」⇒ 409 OBJECT_UNAVAILABLE（确定关闭，retryable 必须为 false）', () => {
  const gate = createFeatureFlagGate({ reader: readerOf({ [KEY]: { key: KEY, enabled: false, revision: 2 } }) });
  assert.equal(gate.verdictFor(KEY, SURFACE).state, 'closed');
  let error = null;
  try {
    gate.assertOpen(KEY, SURFACE);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, '关闭态必须拒绝');
  assert.equal(error.code, 'OBJECT_UNAVAILABLE');
  assert.equal(error.status, 409);
  assert.equal(error.retryable, false, '确定性关闭不得声称可重试');
  assert.deepEqual(error.details, [{ field: 'feature_flag', code: 'FLAG_CLOSED' }]);
});

test('B3. 未识别取值 ⇒ 一律 fail-closed 503（绝不把"读不到"当成"开着"）', () => {
  const malformed = [
    ['行缺失', {}],
    ['enabled 不是布尔', { [KEY]: { key: KEY, enabled: 'true', revision: 1 } }],
    ['enabled 为 null', { [KEY]: { key: KEY, enabled: null, revision: 1 } }],
    ['key 不在契约闭集', { [KEY]: { key: 'hard_rules_enabled', enabled: true, revision: 1 } }],
    ['revision 非法', { [KEY]: { key: KEY, enabled: true, revision: 0 } }],
    ['整行不是对象', { [KEY]: 'on' }],
  ];
  for (const [label, records] of malformed) {
    const gate = createFeatureFlagGate({ reader: readerOf(records) });
    assert.equal(gate.verdictFor(KEY, SURFACE).state, 'fail_closed', `${label} 必须 fail-closed`);
    let error = null;
    try {
      gate.assertOpen(KEY, SURFACE);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, `${label} 必须拒绝`);
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE', label);
    assert.equal(error.status, 503, label);
    assert.equal(error.retryable, true, label);
    assert.deepEqual(error.details, [{ field: 'feature_flag', code: 'FLAG_UNRECOGNIZED' }], label);
  }
});

test('B4. 读取本身抛错 ⇒ 同样 fail-closed（不是 500，也不是放行）', () => {
  const gate = createFeatureFlagGate({
    reader: createStoreFlagReader({
      getFlag() {
        throw new Error('store exploded');
      },
    }),
  });
  assert.equal(gate.verdictFor(KEY, SURFACE).state, 'fail_closed');
  assert.throws(() => gate.assertOpen(KEY, SURFACE), (e) => e.code === 'PROVIDER_UNAVAILABLE');
});

test('B5. `armed:false`（real 未接线）⇒ 不判开关、不拒绝用户面产出（如实声明，非 fail-open 静默）', () => {
  const gate = createFeatureFlagGate({ reader: readerOf({}), armed: false });
  assert.equal(gate.armed, false);
  const verdict = gate.verdictFor(KEY, SURFACE);
  assert.equal(verdict.state, 'open');
  assert.equal(verdict.decidedBy, 'unavailable', '必须如实报"没有权威来源"');
  assert.doesNotThrow(() => gate.assertOpen(KEY, SURFACE));
});

test('C. 关闭 ⇒ 被包装的产出方**一次都不会被调用**（零产出，不是"产出后被丢弃"）', async () => {
  let calls = 0;
  const producer = {
    async listHerbicides() {
      calls += 1;
      return { data: { items: [{ formulation: { registration_number: 'PD20260001' } }] } };
    },
    unrelated() {
      return 'untouched';
    },
  };
  const closed = createFeatureFlagGate({ reader: readerOf({ [KEY]: { key: KEY, enabled: false, revision: 2 } }) });
  const gated = gateProducer(producer, 'listHerbicides', closed, KEY, SURFACE);
  await assert.rejects(() => gated.listHerbicides(), (e) => e.code === 'OBJECT_UNAVAILABLE');
  assert.equal(calls, 0, '关闭态下产出方不得被调用');
  assert.equal(gated.unrelated(), 'untouched', '非受控方法必须原样透传');

  const open = createFeatureFlagGate({ reader: readerOf({ [KEY]: { key: KEY, enabled: true, revision: 1 } }) });
  const gatedOpen = gateProducer(producer, 'listHerbicides', open, KEY, SURFACE);
  const result = await gatedOpen.listHerbicides();
  assert.equal(calls, 1);
  assert.equal(result.data.items[0].formulation.registration_number, 'PD20260001');
});

test('D. 开关**不改变适用判定结论**：开启时结果与不加闸门逐字节相同；关闭时是拒绝而非"改过的结论"', async () => {
  // 判定函数：确定性、纯函数；闸门**不得**改写它的入参或返回值。
  let seenInput = null;
  const judgement = {
    evaluate(input) {
      seenInput = JSON.parse(JSON.stringify(input));
      return { match_state: 'matched', conditions: { crop_id: input.crop_id }, dose_cards: [] };
    },
  };
  const open = createFeatureFlagGate({ reader: readerOf({ [KEY]: { key: KEY, enabled: true, revision: 1 } }) });
  const gated = gateProducer(judgement, 'evaluate', open, KEY, SURFACE);
  const input = Object.freeze({ crop_id: 'crop_rice', region_code: '330100' });
  const viaGate = await gated.evaluate(input);
  const direct = judgement.evaluate(input);
  assert.deepEqual(viaGate, direct, '开启时经闸门与不经闸门必须逐字节相同');
  assert.deepEqual(seenInput, input, '闸门不得改写判定入参');
  assert.deepEqual(input, { crop_id: 'crop_rice', region_code: '330100' }, '入参原件未被改动');

  const closed = createFeatureFlagGate({ reader: readerOf({ [KEY]: { key: KEY, enabled: false, revision: 2 } }) });
  const blocked = gateProducer(judgement, 'evaluate', closed, KEY, SURFACE);
  const before = seenInput;
  await assert.rejects(() => blocked.evaluate(input), (e) => e.code === 'OBJECT_UNAVAILABLE');
  assert.deepEqual(seenInput, before, '关闭时不产生任何新的判定结论');
});

test('B6. 未命中受控面的路由/操作不被判定（不得因"没查到"而拒绝别人）', () => {
  const gate = createFeatureFlagGate({ reader: readerOf({}) }); // 全部不可识别 ⇒ 命中即 503
  assert.doesNotThrow(() => gate.assertSurfaceOpen('GET', `${API}/knowledge`));
  assert.doesNotThrow(() => gate.assertSurfaceOpen('GET', `${API}/admin/feature-flags`));
  assert.throws(() => gate.assertSurfaceOpen('GET', `${API}/herbicides`), (e) => e.code === 'PROVIDER_UNAVAILABLE');
  // 用错 operationId 是接线 bug：必须显式失败，不静默放行。
  assert.throws(() => gate.assertOperationOpen('notAnOperation'), /未在受控面清单/);
});

// ---------------------------------------------------------------------------
// F. 投稿面：关闭 ⇒ 拒绝且零落库（本用例在服务层生效；社区路由已装配，投稿面经 gatedGuards 判开关，见 services/api/src/app.ts:1075）
// ---------------------------------------------------------------------------

test('F. submissions_enabled 关闭 ⇒ createPost 拒绝且**一条内容都没落库**；开启 ⇒ 正常发布', async () => {
  const harness = makeHarness();
  const closed = createFeatureFlagGate({
    reader: readerOf({ submissions_enabled: { key: 'submissions_enabled', enabled: false, revision: 3 } }),
  });
  const gatedClosed = gateCommunityService(harness.service, closed);
  await assert.rejects(
    () => gatedClosed.createPost(USER_A, { title: CLEAN_TITLE, body: CLEAN_BODY, media_ids: [] }, { idempotencyKey: idem('flag-off') }),
    (e) => e.code === 'OBJECT_UNAVAILABLE' && e.status === 409,
  );
  const listed = await harness.service.listPosts(USER_A, {});
  assert.deepEqual(listed.items, [], '关闭态不得留下任何内容行（零产出）');
  // 读面不受投稿开关影响（开关只决定"是否产出新的投稿"，不改变既有可见性判定）。
  assert.equal(listed.next_cursor === null || typeof listed.next_cursor === 'string', true);

  const open = createFeatureFlagGate({
    reader: readerOf({ submissions_enabled: { key: 'submissions_enabled', enabled: true, revision: 2 } }),
  });
  const gatedOpen = gateCommunityService(harness.service, open);
  const post = await gatedOpen.createPost(USER_A, { title: CLEAN_TITLE, body: CLEAN_BODY, media_ids: [] }, { idempotencyKey: idem('flag-on') });
  assert.equal(post.id.length > 0, true);
  assert.equal((await harness.service.getPost(USER_A, post.id)).id, post.id);
});

test('F2. `createFlagGatedGuards` 只包裹 requireUser：后台守卫原样透传（不重复判权限）', () => {
  const calls = [];
  const guards = {
    requireUser: async () => calls.push('user'),
    requireAdmin: async () => calls.push('admin'),
    requireScope: (scope) => async () => calls.push(`scope:${scope}`),
  };
  const gate = createFeatureFlagGate({ reader: readerOf({}) });
  const wrapped = createFlagGatedGuards(guards, gate);
  assert.equal(wrapped.requireAdmin, guards.requireAdmin, 'requireAdmin 必须原样透传');
  assert.equal(wrapped.requireScope, guards.requireScope, 'requireScope 必须原样透传');
  assert.notEqual(wrapped.requireUser, guards.requireUser);
});

// ---------------------------------------------------------------------------
// E. HTTP 跨端点（真实装配 + app.inject）
// ---------------------------------------------------------------------------

async function seedAdmin(authStore) {
  const adminId = await authStore.createAdmin({
    loginName: `gyi18-flaggate-${Math.random().toString(36).slice(2, 10)}`,
    credentialHash: 'synthetic-not-a-real-credential-hash',
    scopes: ALL_SCOPES,
  });
  const token = mintOpaqueToken();
  await authStore.createSession({
    userId: adminId,
    tokenHashHex: hashToken(token),
    authEpoch: 1,
    expiresAt: new Date(Date.now() + 3_600_000),
    audience: 'admin',
  });
  return token;
}

async function loginUser(app) {
  const res = await app.inject({
    method: 'POST',
    url: `${API}/auth/wechat`,
    headers: { 'idempotency-key': 'gyi18-flaggate-login-0001' },
    payload: { code: 'synthetic-i18-flaggate' },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data.access_token;
}

function newApp() {
  const config = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', SESSION_SIGNING_KEY: SESSION_KEY });
  const store = createMemoryAuthStore();
  const app = buildApp({
    config,
    store,
    idempotency: createMemoryIdempotencyStore(),
    // GY-I14 ⇄ GY-I15 联动接线后：社区**只有审核域明确放行**才允许落内容行（B09）。
    // 本文件 E7 的"投稿面基线可用"前提因此显式注入**明确标注的合成 `pass` 端口**
    // （不联网、无凭据、`provider.synthetic === true`）；**不得**读成真实审核已接通。
    moderationInjection: { ports: { tms: makeSyntheticPassPort('tms') } },
  });
  return { app, store };
}

test('E1. 装配基线：3 个开关与各自输出面的真实状态一致（否则开关等于没生效）', async () => {
  const { app, store } = newApp();
  try {
    const adminToken = await seedAdmin(store);
    const listed = await app.inject({ method: 'GET', url: `${API}/admin/feature-flags`, headers: { authorization: `Bearer ${adminToken}` } });
    assert.equal(listed.statusCode, 200, listed.body);
    const byKey = Object.fromEntries(listed.json().data.items.map((flag) => [flag.key, flag]));
    for (const key of CONTRACT_FLAG_KEYS) assert.equal(byKey[key].enabled, FLAG_WIRING_BASELINE[key], `${key} 与装配基线不一致`);
    assert.deepEqual(byKey, byKey, 'sanity');
    assert.equal(app.featureFlagGate.armed, true, 'stub 下开关门必须已启用');
    assert.equal(app.humanReviewDirectory.wired, false);
  } finally {
    await app.close();
  }
});

test('E2. 跨端点：关闭「药剂输出」⇒ /herbicides 列表与详情**拒绝且不产出任何制剂/用量数据**', async () => {
  const { app, store } = newApp();
  try {
    const adminToken = await seedAdmin(store);
    const userToken = await loginUser(app);

    // 关闭前：真实产出（基线开启）。
    const before = await app.inject({ method: 'GET', url: `${API}/herbicides`, headers: { authorization: `Bearer ${userToken}` } });
    assert.equal(before.statusCode, 200, before.body);
    assert.equal(before.json().data.items.length > 0, true, '基线：/herbicides 当前真实可用');
    const firstId = before.json().data.items[0].id;
    const detailBefore = await app.inject({ method: 'GET', url: `${API}/herbicides/${firstId}`, headers: { authorization: `Bearer ${userToken}` } });
    assert.equal(detailBefore.statusCode, 200, detailBefore.body);

    // 后台关闭开关（revision 1 ⇒ 2）。
    const closed = await app.inject({
      method: 'PUT',
      url: `${API}/admin/feature-flags/specific_herbicide_output_enabled`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'idempotency-key': 'gyi18-flaggate-close-0001', 'if-match': '"1"' },
      payload: { enabled: false, reason: '示例：比赛期间停止药剂输出' },
    });
    assert.equal(closed.statusCode, 200, closed.body);
    assert.equal(closed.json().data.enabled, false);
    assert.equal(closed.json().data.revision, 2);

    // 关闭后：列表与详情都拒绝，且响应体里**没有**任何制剂/成分/用量字段。
    for (const url of [`${API}/herbicides`, `${API}/herbicides/${firstId}`]) {
      const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${userToken}` } });
      assert.equal(res.statusCode, 409, `${url} 必须拒绝，实际 ${res.statusCode} ${res.body}`);
      const body = res.json();
      assert.equal(body.error.code, 'OBJECT_UNAVAILABLE');
      assert.equal(body.error.retryable, false);
      assert.equal(body.data, undefined, `${url} 不得返回成功封套`);
      const text = JSON.stringify(body);
      for (const forbidden of ['formulation', 'registration_number', 'dosage_form', 'ingredient', 'dose_card', 'risk_text', 'producer']) {
        assert.equal(text.includes(forbidden), false, `${url} 拒绝了却仍带出 ${forbidden}`);
      }
    }

    // 未受控面不受影响：`/knowledge`（不在受控清单里）拿到的仍是**它自己的**结果
    // （未配数据库 ⇒ 503 资料数据库尚未配置），**不是**开关的 409 —— 证明开关是精确的，
    // 没有把"没查到"变成拒绝、也不是全域断电。
    const knowledge = await app.inject({ method: 'GET', url: `${API}/knowledge`, headers: { authorization: `Bearer ${userToken}` } });
    assert.equal(knowledge.statusCode, 503, knowledge.body);
    assert.equal(knowledge.json().error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(knowledge.json().error.details.length, 0, '不得被开关改写成 FLAG_CLOSED');
    assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);

    // 重新开启 ⇒ 立即恢复（没有"负缓存"把关闭状态粘住）。
    const reopened = await app.inject({
      method: 'PUT',
      url: `${API}/admin/feature-flags/specific_herbicide_output_enabled`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'idempotency-key': 'gyi18-flaggate-reopen-0001', 'if-match': '"2"' },
      payload: { enabled: true, reason: '示例：恢复药剂输出' },
    });
    assert.equal(reopened.statusCode, 200, reopened.body);
    assert.equal(reopened.json().data.revision, 3);
    const after = await app.inject({ method: 'GET', url: `${API}/herbicides`, headers: { authorization: `Bearer ${userToken}` } });
    assert.equal(after.statusCode, 200, after.body);
  } finally {
    await app.close();
  }
});

test('E3. 断言顺序：未登录访问受控面仍是 401（开关状态不泄露给未鉴权调用方）', async () => {
  const { app, store } = newApp();
  try {
    const adminToken = await seedAdmin(store);
    await app.inject({
      method: 'PUT',
      url: `${API}/admin/feature-flags/specific_herbicide_output_enabled`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'idempotency-key': 'gyi18-flaggate-close-0002', 'if-match': '"1"' },
      payload: { enabled: false, reason: '示例：关闭' },
    });
    // 关闭状态下：未登录仍是 401 SESSION_REQUIRED（不是 409）⇒ 开关判定在鉴权之后。
    const anonymous = await app.inject({ method: 'GET', url: `${API}/herbicides` });
    assert.equal(anonymous.statusCode, 401, anonymous.body);
    assert.equal(anonymous.json().error.code, 'SESSION_REQUIRED');
    // 伪造令牌同理（401），不会因为"开关关着"就换成 409/503。
    const forged = await app.inject({ method: 'GET', url: `${API}/herbicides`, headers: { authorization: 'Bearer not-a-real-token' } });
    assert.equal(forged.statusCode, 401, forged.body);
  } finally {
    await app.close();
  }
});

test('E4. 跨端点：关闭 ai_enabled ⇒ AI 任务受理面拒绝；未受控的 AI 读面不受影响', async () => {
  const { app, store } = newApp();
  try {
    const adminToken = await seedAdmin(store);
    const userToken = await loginUser(app);
    const mediaBody = { media_id: '00000000-0000-4000-8000-000000000001', media_revision: 1 };
    const synthesisBody = { checked_content_ref: { type: 'answer', id: 'synthetic-answer-1', revision: 1 }, locale: 'zh-CN' };
    const cases = [
      [`${API}/recognitions`, mediaBody],
      [`${API}/ocr`, mediaBody],
      [`${API}/speech/transcriptions`, mediaBody],
      [`${API}/speech/synthesis`, synthesisBody],
    ];

    const closed = await app.inject({
      method: 'PUT',
      url: `${API}/admin/feature-flags/ai_enabled`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'idempotency-key': 'gyi18-flaggate-ai-close-0001', 'if-match': '"1"' },
      payload: { enabled: false, reason: '示例：停止 AI 任务受理' },
    });
    assert.equal(closed.statusCode, 200, closed.body);

    for (const [index, [url, payload]] of cases.entries()) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json', 'idempotency-key': `gyi18-flaggate-ai-000${index}` },
        payload,
      });
      assert.equal(res.statusCode, 409, `${url} 中止受理时必须是 409（实际 ${res.statusCode} ${res.body}）`);
      assert.equal(res.json().error.code, 'OBJECT_UNAVAILABLE');
      assert.equal(res.json().data, undefined, `${url} 不得返回成功封套`);
    }

    // 读面（不在受控清单里）不受影响：任务不存在是 404，而不是被开关拦成 409。
    const read = await app.inject({
      method: 'GET',
      url: `${API}/recognitions/00000000-0000-4000-8000-000000000001`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    assert.equal(read.statusCode, 404, read.body);
    assert.equal(read.json().error.code, 'NOT_FOUND');
  } finally {
    await app.close();
  }
});

test('E5. 端到端 fail-closed：开关行被写坏（enabled 非布尔）⇒ 受控面 503 而不是放行', async () => {
  const config = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', SESSION_SIGNING_KEY: SESSION_KEY });
  const store = createMemoryAuthStore();
  // 注入一个"行被写坏"的开关存储：模拟将来真实配置库里的脏数据/迁移事故。
  // 说明：契约种子自检会在**接线期**拦住形状非法的 seed，所以这里在读取口上模拟
  // "库里那一行被写坏了"（构造期合法、读取期不可识别）——这正是 fail-closed 要覆盖的窗口。
  const broken = createAdminOpsStore();
  broken.getFlag = (key) =>
    key === 'specific_herbicide_output_enabled'
      ? { key, enabled: 'yes', revision: 1 }
      : { key, enabled: true, revision: 1 };
  const app = buildApp({ config, store, idempotency: createMemoryIdempotencyStore(), adminInjection: { opsStore: broken } });
  try {
    const userToken = await loginUser(app);
    const res = await app.inject({ method: 'GET', url: `${API}/herbicides`, headers: { authorization: `Bearer ${userToken}` } });
    assert.equal(res.statusCode, 503, res.body);
    assert.equal(res.json().error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(res.json().error.retryable, true);
    assert.equal(res.json().data, undefined);
    // 未受控面照旧（脏数据只影响它自己守的那一面）。
    assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('E7. 跨端点（#148 社区 HTTP 装配后）：关闭 submissions_enabled ⇒ POST /posts 与评论被拒且**零落库**', async () => {
  const { app, store } = newApp();
  try {
    const adminToken = await seedAdmin(store);
    const userToken = await loginUser(app);
    const postPayload = { title: CLEAN_TITLE, body: CLEAN_BODY, media_ids: [] };

    // 关闭前：社区投稿面真实可用（基线开启）⇒ 201 且列表可见。
    const created = await app.inject({
      method: 'POST', url: `${API}/posts`,
      headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json', 'idempotency-key': 'gyi18-flaggate-post-open-0001' },
      payload: postPayload,
    });
    assert.equal(created.statusCode, 201, created.body);
    const postId = created.json().data.id;
    const before = await app.inject({ method: 'GET', url: `${API}/posts`, headers: { authorization: `Bearer ${userToken}` } });
    assert.equal(before.statusCode, 200, before.body);
    assert.equal(before.json().data.items.length, 1);

    // 后台关闭投稿开关。
    const closed = await app.inject({
      method: 'PUT', url: `${API}/admin/feature-flags/submissions_enabled`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'idempotency-key': 'gyi18-flaggate-subs-close-0001', 'if-match': '"1"' },
      payload: { enabled: false, reason: '示例：停止投稿' },
    });
    assert.equal(closed.statusCode, 200, closed.body);
    assert.equal(closed.json().data.enabled, false);

    // 关闭后：新投稿与新评论一律拒绝，且**没有**任何新内容行。
    const blockedPost = await app.inject({
      method: 'POST', url: `${API}/posts`,
      headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json', 'idempotency-key': 'gyi18-flaggate-post-closed-0001' },
      payload: { title: '关闭后不应落库的帖子', body: CLEAN_BODY, media_ids: [] },
    });
    assert.equal(blockedPost.statusCode, 409, blockedPost.body);
    assert.equal(blockedPost.json().error.code, 'OBJECT_UNAVAILABLE');
    assert.equal(blockedPost.json().error.retryable, false);
    assert.equal(blockedPost.json().data, undefined);

    const blockedComment = await app.inject({
      method: 'POST', url: `${API}/posts/${postId}/comments`,
      headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json', 'idempotency-key': 'gyi18-flaggate-cmt-closed-0001' },
      payload: { body: CLEAN_BODY },
    });
    assert.equal(blockedComment.statusCode, 409, blockedComment.body);
    assert.equal(blockedComment.json().error.code, 'OBJECT_UNAVAILABLE');

    const after = await app.inject({ method: 'GET', url: `${API}/posts`, headers: { authorization: `Bearer ${userToken}` } });
    assert.equal(after.json().data.items.length, 1, '关闭态不得新增任何内容行（零产出）');
    const comments = await app.inject({ method: 'GET', url: `${API}/posts/${postId}/comments`, headers: { authorization: `Bearer ${userToken}` } });
    assert.equal(comments.statusCode, 200);
    assert.deepEqual(comments.json().data.items, [], '关闭态不得新增任何评论行');

    // 读面不受影响（开关只决定"是否受理新投稿/评论"，不改变既有可见性判定）。
    const detail = await app.inject({ method: 'GET', url: `${API}/posts/${postId}`, headers: { authorization: `Bearer ${userToken}` } });
    assert.equal(detail.statusCode, 200, detail.body);

    // 未登录仍是 401（开关判定在鉴权之后，开关状态不泄露给未鉴权方）。
    const anonymous = await app.inject({
      method: 'POST', url: `${API}/posts`,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'gyi18-flaggate-post-anon-0001' },
      payload: postPayload,
    });
    assert.equal(anonymous.statusCode, 401, anonymous.body);
    assert.equal(anonymous.json().error.code, 'SESSION_REQUIRED');

    // 重新开启 ⇒ 立即恢复受理（无"负缓存"）。
    const reopened = await app.inject({
      method: 'PUT', url: `${API}/admin/feature-flags/submissions_enabled`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'idempotency-key': 'gyi18-flaggate-subs-open-0001', 'if-match': '"2"' },
      payload: { enabled: true, reason: '示例：恢复投稿' },
    });
    assert.equal(reopened.statusCode, 200, reopened.body);
    const recovered = await app.inject({
      method: 'POST', url: `${API}/posts`,
      headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json', 'idempotency-key': 'gyi18-flaggate-post-reopen-0001' },
      payload: postPayload,
    });
    assert.equal(recovered.statusCode, 201, recovered.body);
  } finally {
    await app.close();
  }
});

test('E6. real 模式（后台域未接线）⇒ 开关门不启用：不拿未接线的开关中断用户面（如实声明）', async () => {
  const base = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', SESSION_SIGNING_KEY: SESSION_KEY });
  const config = { ...base, executionMode: 'real', requiresRealCredentials: true, logLevel: 'silent' };
  const store = createMemoryAuthStore();
  const app = buildApp({ config, store, idempotency: createMemoryIdempotencyStore() });
  try {
    assert.equal(app.featureFlagGate.armed, false, 'real 未接线时开关门必须处于"无权威来源"状态');
    const token = 'synthetic-i18-flaggate-real-mode-token';
    const user = await store.createUser('synthetic-i18-flaggate-real');
    await store.createSession({
      userId: user.id,
      tokenHashHex: hashToken(token),
      authEpoch: user.authEpoch,
      expiresAt: new Date(Date.now() + 3_600_000),
      audience: 'user',
    });
    // /herbicides 在 real 模式下仍走既有产出路径（未被未接线的开关拦下）。
    const res = await app.inject({ method: 'GET', url: `${API}/herbicides`, headers: { authorization: `Bearer ${token}` } });
    assert.notEqual(res.statusCode, 409, res.body);
    assert.notEqual(res.statusCode, 503, res.body);
    // 而后台域自身在 real 下仍是 fail-closed 503（与本片无关的既有口径，未被削弱）；
    // 且用户会话访问后台仍是 403 SCOPE_DENIED 组。
    const admin = await app.inject({ method: 'GET', url: `${API}/admin/feature-flags`, headers: { authorization: `Bearer ${token}` } });
    assert.equal(admin.statusCode, 403, admin.body);
    assert.equal(admin.json().error.code, 'SCOPE_DENIED');
  } finally {
    await app.close();
  }
});
