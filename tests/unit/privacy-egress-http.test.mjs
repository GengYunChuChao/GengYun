/**
 * GY-I27（#29）· `services/api` 侧装配回归：授权中间件（Fastify preHandler）+ real 模式 fail-closed。
 *
 * 监工对 #121 的 P1 口径在此复验：`real` 模式下真实依赖未接入 ⇒ **fail-closed**
 * （契约内 `PROVIDER_UNAVAILABLE`，503，`retryable: true`），**不得**用替身返回成功封套；
 * 替身只允许在明确标注的 `stub` / `preset_demo` 下出现（同一路由的 stub 对照用例）。
 *
 * 本文件**不改任何既有路由/装配文件**：自己起一个最小 Fastify 实例，
 * 把 `createConsentPreHandler` / `createPrivacyEgress` 按装配说明挂上去验证。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createConsentStore } from '../../packages/privacy/consent.mjs';
import { createExportLedger } from '../../packages/privacy/ledger.mjs';
import { createPrivacyGuard } from '../../packages/privacy/guard.mjs';
import { createRealEgressTransport, resolveEgressTransport } from '../../packages/privacy/egress.mjs';
import { createConsentPreHandler, createPrivacyEgress, toApiError, withPrivacyErrors } from '../../services/api/src/privacy/egress.ts';
import { ApiError, buildErrorEnvelope } from '../../services/api/src/errors.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createAccountProvider, createRecipientStore, VERIFIED_RECIPIENT } from '../privacy/_fixtures.mjs';

const OBJECT_ID = '00000000-0000-4000-8000-0000000000c1';

/** 与 tests/unit/admin-real-mode-fail-closed.test.mjs 同形的**合成占位** real 环境（非真实凭据）。 */
const REAL_ENV = {
  APP_EXECUTION_MODE: 'real',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://synthetic_local_only@127.0.0.1:5432/gengyun_synthetic_never_connected',
  SESSION_SIGNING_KEY: 'synthetic-not-a-real-signing-key',
  DELETION_LEDGER_KEY: 'synthetic-not-a-real-ledger-key',
  WECHAT_APP_ID: 'synthetic-not-a-real-appid',
  WECHAT_APP_SECRET: 'synthetic-not-a-real-appsecret',
  OBJECT_STORAGE_ENDPOINT: 'https://example.invalid',
  OBJECT_STORAGE_BUCKET: 'synthetic-not-a-real-bucket',
  OBJECT_STORAGE_ACCESS_KEY: 'synthetic-not-a-real-access-key',
  OBJECT_STORAGE_SECRET_KEY: 'synthetic-not-a-real-secret-key',
};

function environment(env = { APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }) {
  const account = createAccountProvider({ u1: { state: 'active', authEpoch: 1 } });
  const consentStore = createConsentStore();
  const recipientStore = createRecipientStore({ [VERIFIED_RECIPIENT.id]: VERIFIED_RECIPIENT });
  const ledger = createExportLedger({ consentStore, account, recipientStore });
  const guard = createPrivacyGuard({ account, consentStore });
  return { account, consentStore, recipientStore, ledger, guard, config: loadConfig(env) };
}

async function grantVoice(consentStore) {
  for (const purpose of ['recording', 'media_processing', 'external_inference']) {
    await consentStore.grant({ userId: 'u1', purpose, policyVersion: '1.0.0', recipientIds: [VERIFIED_RECIPIENT.id] });
  }
}

/**
 * 最小 Fastify 实例：
 *  - 第一个钩子**模拟会话层**（把身份填到 `request.userId` / `request.authEpoch`）；
 *  - 第二个钩子是**本片交付的授权中间件**（真实装配位置见 egress.ts 文档「挂载点」）。
 */
async function build({ config, guard, preHandler, handler }) {
  const app = Fastify({ logger: false });
  app.decorateRequest('userId', null);
  app.decorateRequest('authEpoch', null);
  app.addHook('preValidation', async (request) => {
    // 仅测试：模拟 GY-I04 会话层填充（真实运行只来自服务端存储，客户端无法声明）。
    const user = request.headers['x-synthetic-user'];
    request.userId = typeof user === 'string' && user.length > 0 ? user : null;
    const epoch = request.headers['x-synthetic-auth-epoch'];
    request.authEpoch = typeof epoch === 'string' && epoch.length > 0 ? Number(epoch) : null;
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.status).send(buildErrorEnvelope(error, { request_id: request.id, execution_mode: config.executionMode }));
    }
    return reply.status(500).send({ error: { message: '服务器内部错误', retryable: false, details: [] } });
  });
  // 业务处理包一层 `withPrivacyErrors`：真实装配中调用 send()/saveResult() 的路由必须这么挂，
  // 否则协议层的 PrivacyError 会冒泡成 500（如实但没有契约错误码）。
  app.post('/synthetic/egress', preHandler === undefined ? {} : { preHandler }, withPrivacyErrors(handler));
  await app.ready();
  return app;
}

function inject(app, headers = {}) {
  return app.inject({ method: 'POST', url: '/synthetic/egress', headers });
}

test('授权中间件：缺身份版本 ⇒ 401 SESSION_REQUIRED（不得静默放行）', async () => {
  const env = environment();
  const app = await build({
    config: env.config,
    guard: env.guard,
    preHandler: createConsentPreHandler(env.guard, { purpose: 'external_inference', dataType: 'voice_question' }),
    handler: async () => ({ ok: true }),
  });
  try {
    const res = await inject(app, { 'x-synthetic-user': 'u1' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, 'SESSION_REQUIRED');
    assert.equal(res.json().data, undefined);
  } finally {
    await app.close();
  }
});

test('授权中间件：未授权 ⇒ 403 CONSENT_REQUIRED；错用途 ⇒ 403 SCOPE_DENIED', async () => {
  const env = environment();
  const headers = { 'x-synthetic-user': 'u1', 'x-synthetic-auth-epoch': '1' };
  const app = await build({
    config: env.config,
    guard: env.guard,
    preHandler: createConsentPreHandler(env.guard, { purpose: 'external_inference', dataType: 'voice_question' }),
    handler: async () => ({ ok: true }),
  });
  try {
    const denied = await inject(app, headers);
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error.code, 'CONSENT_REQUIRED');
  } finally {
    await app.close();
  }

  const env2 = environment();
  await env2.consentStore.grant({ userId: 'u1', purpose: 'public_posting', policyVersion: '1.0.0', recipientIds: [VERIFIED_RECIPIENT.id] });
  const app2 = await build({
    config: env2.config,
    guard: env2.guard,
    preHandler: createConsentPreHandler(env2.guard, { purpose: 'public_posting', dataType: 'voice_question' }),
    handler: async () => ({ ok: true }),
  });
  try {
    const wrong = await inject(app2, headers);
    assert.equal(wrong.statusCode, 403);
    assert.equal(wrong.json().error.code, 'SCOPE_DENIED');
  } finally {
    await app2.close();
  }
});

test('授权中间件：注销（auth_epoch 前进）⇒ 403 ACCOUNT_INACTIVE；授权齐全 ⇒ 放行到业务处理', async () => {
  const env = environment();
  await grantVoice(env.consentStore);
  const preHandler = createConsentPreHandler(env.guard, { purpose: 'external_inference', dataType: 'voice_question' });

  const app = await build({ config: env.config, guard: env.guard, preHandler, handler: async () => ({ reached: true }) });
  try {
    const ok = await inject(app, { 'x-synthetic-user': 'u1', 'x-synthetic-auth-epoch': '1' });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().reached, true);

    env.account.set('u1', { state: 'deletion_pending', authEpoch: 2 });
    const inactive = await inject(app, { 'x-synthetic-user': 'u1', 'x-synthetic-auth-epoch': '2' });
    assert.equal(inactive.statusCode, 403);
    assert.equal(inactive.json().error.code, 'ACCOUNT_INACTIVE');

    const stale = await inject(app, { 'x-synthetic-user': 'u1', 'x-synthetic-auth-epoch': '1' });
    assert.equal(stale.statusCode, 403);
    assert.equal(stale.json().error.code, 'ACCOUNT_INACTIVE');
  } finally {
    await app.close();
  }
});

test('real 未接真实依赖 ⇒ 503 PROVIDER_UNAVAILABLE(retryable)：零外发、零账本变更，无成功封套', async () => {
  const env = environment({ ...REAL_ENV });
  await grantVoice(env.consentStore);
  const assembly = createPrivacyEgress({ executionMode: 'real', ledger: env.ledger });
  assert.equal(assembly.available, false);
  assert.equal(assembly.realUnwired, true);
  assert.equal(assembly.transportKind, 'real');

  const app = await build({
    config: env.config,
    guard: env.guard,
    handler: async () =>
      assembly.consumer.send({
        identity: { userId: 'u1', authEpoch: 1 },
        objectType: 'transcription', objectId: OBJECT_ID, objectRevision: 1,
        dataType: 'voice_question', purpose: 'external_inference',
        recipientId: VERIFIED_RECIPIENT.id, sourceVersion: 'asr-v1', payload: { text: '私有正文' },
      }),
  });
  try {
    const res = await inject(app);
    assert.equal(res.statusCode, 503, res.body);
    assert.equal(res.json().error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(res.json().error.retryable, true);
    assert.equal(res.json().data, undefined, '不得返回成功封套');
    assert.equal(res.json().meta.execution_mode, 'real');
  } finally {
    await app.close();
  }
  assert.equal(env.ledger.list({ userId: 'u1' }).items.length, 0, 'fail-closed 不得留下外发登记');
});

test('stub 对照：同一路由在 stub 下可用，且回执/账本如实标注替身', async () => {
  const env = environment({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
  await grantVoice(env.consentStore);
  const assembly = createPrivacyEgress({ executionMode: 'stub', ledger: env.ledger });
  assert.equal(assembly.available, true);
  assert.equal(assembly.realUnwired, false);

  const app = await build({
    config: env.config,
    guard: env.guard,
    handler: async () =>
      assembly.consumer.send({
        identity: { userId: 'u1', authEpoch: 1 },
        objectType: 'transcription', objectId: OBJECT_ID, objectRevision: 1,
        dataType: 'voice_question', purpose: 'external_inference',
        recipientId: VERIFIED_RECIPIENT.id, sourceVersion: 'asr-v1', payload: { text: '私有正文' },
      }),
  });
  try {
    const res = await inject(app);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().egress.stub, true, '替身必须自报替身');
    assert.match(String(res.json().egress.label), /替身/);
    assert.equal(assembly.executionMode, 'stub');
  } finally {
    await app.close();
  }
  const rows = env.ledger.list({ userId: 'u1' }).items;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'sent');
  assert.equal(rows[0].recipientId, VERIFIED_RECIPIENT.id);
});

test('装配期拒绝：非 real 模式注入真实传输（避免以真实外发污染替身/演示证据）', () => {
  const env = environment();
  const real = createRealEgressTransport({ adapter: { async send() { return {}; } } });
  assert.throws(
    () => createPrivacyEgress({ executionMode: 'stub', ledger: env.ledger, realTransport: real, realTransportApproved: true }),
    /不得注入真实外发传输/,
  );
  assert.equal(
    resolveEgressTransport({ executionMode: 'real', realTransport: real, realTransportApproved: false }).available,
    false,
    'real 模式未显式放行时必须 fail-closed，即使有真实传输对象',
  );
  assert.equal(
    resolveEgressTransport({ executionMode: 'real', realTransport: real, realTransportApproved: true }).available,
    true,
    'real 模式显式放行后才使用真实传输',
  );
});

test('toApiError：契约错误码原样保留；非契约错误返回 null（不伪造错误码、不透出原文）', () => {
  const privacyLike = Object.assign(new Error('用途 external_inference 授权已撤回'), {
    name: 'PrivacyError', code: 'CONSENT_REQUIRED', retryable: false, details: [],
  });
  const mapped = toApiError(privacyLike);
  assert.ok(mapped instanceof ApiError);
  assert.equal(mapped.code, 'CONSENT_REQUIRED');
  assert.equal(mapped.status, 403);
  assert.equal(mapped.retryable, false);

  const retryable = toApiError(Object.assign(new Error('x'), { name: 'PrivacyError', code: 'PROVIDER_UNAVAILABLE', retryable: true }));
  assert.equal(retryable.status, 503);
  assert.equal(retryable.retryable, true);

  assert.equal(toApiError(new Error('内部实现细节与私有正文')), null);
  assert.equal(toApiError('字符串异常'), null);
  const original = new ApiError('NOT_FOUND', 'x');
  assert.equal(toApiError(original), original);
});
