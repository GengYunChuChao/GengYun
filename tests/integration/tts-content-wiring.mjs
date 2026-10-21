// GY-R28-W3 · TTS「已核对内容」端口真实分支的**回环 HTTP 读数**
//   —— 被测对象：`services/api/src/ai/checked-content-live-adapter.ts`（真实来源）
//     + `services/api/src/app.ts:989` 的装配替换（`createCheckedContentPortFromConfig`）。
//
// 口径（与本目录 `tts-http.mjs` 一致）：
//  - 纯回环：只连 `127.0.0.1:<随机端口>`；数据库查询端口是**注入的假端口**
//    （`fakeQueryable`），**不连任何真实数据库**、不读 `.env`、不读凭据、不付出任何外呼费用。
//  - 因此本脚本证明的是「接线与判定/拒绝码在 HTTP 面上的行为」，**不**证明真实库里有可朗读内容、
//    更**不**证明端到端可用（真实链路的读数见证据页 §4）。
//  - `real` 实例用**合成占位配置**通过 `config.ts` 的 real 校验；这些占位值不代表真实凭据可用。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createMemoryIdempotencyStore } from '../../services/api/src/auth/idempotency.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createWechatIdentityProvider, STUB_LOOKUP_KEY } from '../../services/api/src/auth/wechat.ts';
import { createMemorySynthesisStore } from '../../services/api/src/tts/store.ts';
import { createSubstituteMediaPort } from '../../services/api/src/tts/media.ts';
import { createStubTtsProvider } from '../../services/api/src/tts/provider.ts';
import { createCheckedContentPortFromConfig } from '../../services/api/src/ai/checked-content-live-adapter.ts';

const SYNTHESIS_URL = '/api/v1/speech/synthesis';
const JOBS_URL = '/api/v1/jobs';

const ANSWER_ID = '7a1f2c34-5b6d-4e8f-9a0b-1c2d3e4f5a6b';
const KNOWLEDGE_ID = '8b2c3d45-6c7e-4f90-8b1c-2d3e4f5a6b7c';
const UNKNOWN_ID = '9c3d4e56-7d8e-4a01-9c2d-3e4f5a6b7c8d';
const FOREIGN_ID = 'a4d5e6f7-8e9a-4b12-8d3e-4f5a6b7c8d9e';

/** 合成占位配置：只为通过 `config.ts` 的 real 校验；数据库指向永不连接的本地端口。 */
const REAL_ENV = {
  DATABASE_URL: 'postgres://synthetic-not-a-real@127.0.0.1:1/never',
  SESSION_SIGNING_KEY: 'synthetic-not-a-real-signing-key-0001',
  DELETION_LEDGER_KEY: 'synthetic-not-a-real-ledger-key-0001',
  WECHAT_APP_ID: 'wx-synthetic-not-a-real',
  WECHAT_APP_SECRET: 'synthetic-not-a-real-wechat-secret',
  OBJECT_STORAGE_ENDPOINT: 'https://storage.synthetic-not-a-real.invalid',
  OBJECT_STORAGE_BUCKET: 'synthetic-not-a-real-bucket',
  OBJECT_STORAGE_ACCESS_KEY: 'synthetic-not-a-real-access-key',
  OBJECT_STORAGE_SECRET_KEY: 'synthetic-not-a-real-secret-key',
};

const TEXT = '合成用例文本：水稻纹枯病初见病斑时，每亩用 5% 井冈霉素 100 毫升。';

// ---------------------------------------------------------------- 假查询端口

/**
 * 可控的只读查询端口：按 SQL 关键字分派，记录**每一次**查询（语句 + 参数）。
 * `rows` 为 `null` 时抛错（模拟连接/权限失败）。
 */
function fakeQueryable(rows) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      if (rows === null) throw new Error('synthetic: connect ECONNREFUSED 127.0.0.1:1');
      // `where id = $1` 的语义必须被模拟：真表按 id 命中，不含该 id 就返回空集。
      // 否则「拿知识 id 当 answer」这类跨类型负控制会被假端口喂回别人的行，
      // 从而把 404 误读成 409（假绿/假红都不可接受）。
      const wanted = values?.[0];
      const hit = (rows_) => (rows_ ?? []).filter((row) => row.id === undefined || row.id === wanted);
      if (text.includes('conversation_answers')) return { rows: hit(rows.answers) };
      if (text.includes('catalog_read.current_knowledge')) return { rows: hit(rows.knowledge) };
      throw new Error(`未预期的查询：${text}`);
    },
  };
}

const approvedAnswer = { id: ANSWER_ID, revision: 3, check_state: 'passed', owner_id: null, checked_text: TEXT };

/** 同一响应体的「形状」比较：剔掉每次请求都会变的 request_id（否则逐字比较恒假）。 */
function shapeOf(response) {
  return response.text.replace(/"request_id":"[^"]*"/, '"request_id":"<same>"');
}

// ---------------------------------------------------------------- 装配与客户端

async function bootAppFor(config, synthesisOverride) {
  const authStore = createMemoryAuthStore();
  const app = buildApp({
    config,
    store: authStore,
    idempotency: createMemoryIdempotencyStore(),
    now: () => new Date(),
    ...(config.executionMode === 'real'
      ? { wechat: createWechatIdentityProvider({ executionMode: 'stub', appId: null, appSecret: null, lookupKey: STUB_LOOKUP_KEY }) }
      : {}),
    synthesisProvider: synthesisOverride.provider,
    synthesisMedia: createSubstituteMediaPort(),
    synthesisStore: createMemorySynthesisStore(),
    synthesisContent: synthesisOverride.content,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  return { app, authStore, base: `http://127.0.0.1:${port}` };
}

async function seedSession(authStore, label) {
  const user = await authStore.createUser(`synthetic-lookup-${label}-0000000000000000`);
  const token = `synthetic-http-token-${label}-${randomUUID()}`;
  await authStore.createSession({
    userId: user.id,
    audience: 'user',
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return { userId: user.id, token };
}

async function call(base, method, path, options = {}) {
  const headers = {};
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.key !== undefined) headers['idempotency-key'] = options.key;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

let keyCounter = 0;
function nextKey() {
  keyCounter += 1;
  return `tts-content-wiring-key-${String(keyCounter).padStart(6, '0')}`;
}

const body = (ref) => ({ checked_content_ref: { ...ref }, locale: 'zh-CN' });

const summary = { pass: 0, fail: 0 };
async function check(label, fn) {
  try {
    const observed = await fn();
    summary.pass += 1;
    console.log(`PASS  ${label}${observed ? `  [${observed}]` : ''}`);
  } catch (error) {
    summary.fail += 1;
    console.log(`FAIL  ${label} → ${error?.message ?? error}`);
  }
}

function assertEnvelope(response, status, code) {
  assert.equal(response.status, status, `HTTP 状态应为 ${status}，实际 ${response.status}（${response.text.slice(0, 200)}）`);
  const error = response.json?.error ?? null;
  assert.notEqual(error, null, '契约错误封套缺失');
  assert.equal(error.code, code, `契约错误码应为 ${code}，实际 ${error.code}`);
  return error;
}

/** 用一个「real 模式 + 注入替身提供者 + 注入真实核对源」的实例跑一次受理并返回读数。 */
async function acceptWith(rows, ref, options = {}) {
  const pool = fakeQueryable(rows);
  const content = createCheckedContentPortFromConfig({ executionMode: 'real', pool });
  const config = loadConfig({ APP_EXECUTION_MODE: 'real', LOG_LEVEL: 'silent', ...REAL_ENV });
  const booted = await bootAppFor(config, { provider: createStubTtsProvider({}), content });
  try {
    const identity = await seedSession(booted.authStore, options.label ?? 'w3');
    const response = await call(booted.base, 'POST', SYNTHESIS_URL, { token: identity.token, key: nextKey(), body: body(ref) });
    let job = null;
    if (response.status === 202) {
      const jobId = response.json?.data?.id;
      const read = await call(booted.base, 'GET', `${JOBS_URL}/${jobId}`, { token: identity.token });
      job = { read, id: jobId };
    }
    return { response, pool, job };
  } finally {
    await new Promise((resolve) => booted.app.close(resolve));
  }
}

// ---------------------------------------------------------------- 读数

const realConfig = loadConfig({ APP_EXECUTION_MODE: 'real', LOG_LEVEL: 'silent', ...REAL_ENV });

await check('R00 real + 产品默认提供者（无凭据）⇒ 503 PROVIDER_UNAVAILABLE，核对源查询 0 次（核对闸根本没被走到）', async () => {
  const pool = fakeQueryable({ answers: [approvedAnswer] });
  const content = createCheckedContentPortFromConfig({ executionMode: 'real', pool });
  const booted = await bootAppFor(realConfig, { provider: undefined, content });
  try {
    const identity = await seedSession(booted.authStore, 'r00');
    const response = await call(booted.base, 'POST', SYNTHESIS_URL, {
      token: identity.token,
      key: nextKey(),
      body: body({ type: 'answer', id: ANSWER_ID, revision: 3 }),
    });
    assertEnvelope(response, 503, 'PROVIDER_UNAVAILABLE');
    assert.equal(pool.calls.length, 0, '提供者闸先于核对闸：此时不应有任何核对查询');
    return `503 PROVIDER_UNAVAILABLE；核对查询 ${pool.calls.length} 次`;
  } finally {
    await new Promise((resolve) => booted.app.close(resolve));
  }
});

await check('R01 real + 真实核对源（answer 行已核对、revision 3）⇒ 受理 202，核对源被读 2 次（受理闸 accept + 执行前复核 execute，见 service.ts:279）且参数化', async () => {
  const { response, pool, job } = await acceptWith({ answers: [approvedAnswer] }, { type: 'answer', id: ANSWER_ID, revision: 3 });
  assert.equal(response.status, 202, `期望 202，实际 ${response.status}（${response.text.slice(0, 200)}）`);
  assert.equal(pool.calls.length, 2, `核对查询应为 2 次（accept + execute），实际 ${pool.calls.length}`);
  for (const call_ of pool.calls) {
    assert.deepEqual(call_.values, [ANSWER_ID]);
    assert.equal(call_.text.includes(ANSWER_ID), false, 'id 不得拼进 SQL 文本');
  }
  assert.notEqual(job, null);
  assert.equal(job.read.status, 200, `GET /jobs/{id} 应为 200，实际 ${job.read.status}`);
  return `受理 202 → GET /jobs/{id} ${job.read.status}（state=${job.read.json?.data?.state}）；核对查询 ${pool.calls.length} 次`;
});

await check('R02 负控制·未核对（check_state=pending 的脏行）⇒ 422 INPUT_UNCERTAIN，不建任务', async () => {
  const { response } = await acceptWith(
    { answers: [{ ...approvedAnswer, check_state: 'pending' }] },
    { type: 'answer', id: ANSWER_ID, revision: 3 },
  );
  const error = assertEnvelope(response, 422, 'INPUT_UNCERTAIN');
  return `422 INPUT_UNCERTAIN（${error.details?.[0]?.code ?? error.code}）`;
});

await check('R03 负控制·版本不一致（库内 revision 4，请求 3）⇒ 409 REVISION_CONFLICT', async () => {
  const { response } = await acceptWith(
    { answers: [{ ...approvedAnswer, revision: 4 }] },
    { type: 'answer', id: ANSWER_ID, revision: 3 },
  );
  const error = assertEnvelope(response, 409, 'REVISION_CONFLICT');
  return `409 REVISION_CONFLICT（${error.details?.[0]?.code ?? error.code}）`;
});

await check('R04 负控制·跨页/跨类型（知识 id 当 answer）⇒ 404，且与「不存在」逐字同形', async () => {
  const rows = { answers: [approvedAnswer], knowledge: [{ id: KNOWLEDGE_ID, revision: 2, title: '水稻纹枯病', body: TEXT }] };
  const crossed = await acceptWith(rows, { type: 'answer', id: KNOWLEDGE_ID, revision: 2 });
  const missing = await acceptWith(rows, { type: 'answer', id: UNKNOWN_ID, revision: 1 });
  assert.equal(crossed.response.status, 404, `跨类型应 404，实际 ${crossed.response.status}`);
  assert.equal(shapeOf(crossed.response), shapeOf(missing.response), '跨类型与不存在必须同形（不泄露存在性）');
  return '404 且响应体与不存在逐字相同';
});

await check('R05 负控制·跨账号（他人回答，owner_id 非本人）⇒ 404，与不存在同形', async () => {
  const rows = { answers: [{ ...approvedAnswer, id: FOREIGN_ID, owner_id: randomUUID() }] };
  const foreign = await acceptWith(rows, { type: 'answer', id: FOREIGN_ID, revision: 3 });
  const missing = await acceptWith(rows, { type: 'answer', id: UNKNOWN_ID, revision: 3 });
  assert.equal(foreign.response.status, 404);
  assert.equal(shapeOf(foreign.response), shapeOf(missing.response), '越权与不存在必须同形');
  return '404 且响应体与不存在逐字相同';
});

await check('R06 负控制·查询抛错（连接失败）⇒ 409 OBJECT_UNAVAILABLE，绝不当作 approved', async () => {
  const { response } = await acceptWith(null, { type: 'answer', id: ANSWER_ID, revision: 3 });
  const error = assertEnvelope(response, 409, 'OBJECT_UNAVAILABLE');
  return `409 OBJECT_UNAVAILABLE（${error.details?.[0]?.code ?? error.code}）`;
});

await check('R07 未配置连接池（real + pool:null）⇒ 与接线前一致：409 OBJECT_UNAVAILABLE，核对查询 0 次', async () => {
  const content = createCheckedContentPortFromConfig({ executionMode: 'real', pool: null });
  assert.equal(content.kind, 'unwired');
  const booted = await bootAppFor(realConfig, { provider: createStubTtsProvider({}), content });
  try {
    const identity = await seedSession(booted.authStore, 'r07');
    const response = await call(booted.base, 'POST', SYNTHESIS_URL, {
      token: identity.token,
      key: nextKey(),
      body: body({ type: 'answer', id: ANSWER_ID, revision: 3 }),
    });
    const error = assertEnvelope(response, 409, 'OBJECT_UNAVAILABLE');
    return `409 OBJECT_UNAVAILABLE（${error.details?.[0]?.code ?? error.code}）`;
  } finally {
    await new Promise((resolve) => booted.app.close(resolve));
  }
});

console.log(`\n${summary.fail === 0 ? 'PASS' : 'FAIL'}  W3 核对端口接线读数：pass=${summary.pass} fail=${summary.fail}`);
if (summary.fail !== 0) process.exitCode = 1;
