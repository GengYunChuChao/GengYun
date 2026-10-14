/**
 * GY-I14（#14）审核 HTTP 装配片 · **`GET /jobs/{id}`（kind=moderation）真实回环 HTTP 证据**。
 *
 * 契约（`packages/contracts/openapi.json`）：`Job` 九键、`JobState` 七值闭集、
 * `JobResult` 判别子 `kind` ⇒ `moderation` 分支 = `ModerationResult`（`{kind, value: Moderation}`）。
 * 本片**只接**这一个已有读面，**不新增**任何 path/operationId。
 *
 * 声明：全部输入是合成夹具、模型端口是合成替身；本文件不含任何真实供应商调用或凭据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { collectResultValueIssues } from '../../services/api/src/jobs/result-shape.ts';
import { CLEAN_TEXT, countingPort, makeHarness, mediaContent, textContent } from './_http-fixtures.mjs';

const API = '/api/v1';
const START = Date.UTC(2026, 9, 14, 6, 0, 0);

async function buildFixture(t, options = {}) {
  const auth = createMemoryAuthStore();
  const baseConfig = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
  const config = options.real ? { ...baseConfig, executionMode: 'real', requiresRealCredentials: true } : baseConfig;
  const app = buildApp({
    config,
    store: auth,
    now: () => new Date(START),
    ...(options.moderation === undefined ? {} : { moderationInjection: { service: options.moderation } }),
  });
  const account = async (seed) => {
    const user = await auth.createUser(seed.repeat(64));
    const token = `synthetic-moderation-token-${seed}`;
    await auth.createSession({
      userId: user.id,
      tokenHashHex: hashToken(token),
      authEpoch: user.authEpoch,
      expiresAt: new Date(START + 48 * 3600_000),
      audience: 'user',
    });
    return { user, token };
  };
  const a = await account('a');
  const b = await account('b');
  t.after(() => app.close());

  const call = async (method, path, actor = a, { headers = {}, payload } = {}) => {
    const response = await app.inject({
      method,
      url: path,
      headers: {
        ...(actor ? { authorization: `Bearer ${actor.token}` } : {}),
        ...headers,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
    const body = response.body === '' ? null : JSON.parse(response.body);
    return {
      status: response.statusCode,
      data: body,
      etag: response.headers['etag'],
      cache: response.headers['cache-control'],
    };
  };
  return { app, auth, a, b, call };
}

/**
 * 一套"审核域 + 真实 Fastify 回环"夹具。
 * 任务的 `submitted_by` 必须等于**认证中间件**给出的 userId（否则作业面按同形 404 处理），
 * 因此先建会话、再用该 userId 送审。
 */
async function setup(t, options = {}) {
  const tms = countingPort('tms');
  const ims = options.withImagePort ? countingPort('ims', { model_version: 'synthetic-ims-model@2.0' }) : null;
  const ports = ims === null ? { tms: tms.port } : { tms: tms.port, ims: ims.port };
  const harness = makeHarness({ ports });
  const fixture = await buildFixture(t, { real: options.real, moderation: harness.service });
  const actorA = { userId: fixture.a.user.id, role: 'user', authEpoch: fixture.a.user.authEpoch };
  const subject = textContent();
  harness.authority.seed(subject.target_ref, {
    visibility: 'private',
    author_state: 'active',
    source_kind: 'database',
    owner_id: actorA.userId,
  });
  const submit = async (content = subject, extra = {}) =>
    harness.service.submitScreening({ actor: actorA, content, ...extra });
  return { ...fixture, harness, tms, ims, actorA, subject, submit };
}

test('GET /jobs/{id}：审核作业按契约读出（九键/闭集/ModerationResult），且**不**扩散服务端租约', async (t) => {
  const h = await setup(t);
  const out = await h.submit();
  const task = out.tasks[0];

  const own = await h.call('GET', `${API}/jobs/${task.job_id}`, h.a);
  assert.equal(own.status, 200);
  assert.equal(own.cache, 'no-store');
  assert.equal(own.etag, '"1"');
  assert.equal(own.data.meta.contract_version, '1.0.0');
  assert.equal(own.data.meta.execution_mode, 'stub');

  const job = own.data.data;
  assert.deepEqual(
    Object.keys(job).sort(),
    ['id', 'revision', 'kind', 'target_ref', 'state', 'deadline_at', 'created_at', 'error_code', 'result'].sort(),
  );
  assert.equal(job.kind, 'moderation');
  assert.equal(job.id, task.job_id);
  assert.equal(job.revision, 1);
  assert.equal(job.state, 'succeeded');
  assert.equal(job.error_code, null);
  assert.deepEqual(job.target_ref, task.target_ref);
  assert.equal(Number.isNaN(Date.parse(job.deadline_at)), false);
  assert.equal(Number.isNaN(Date.parse(job.created_at)), false);

  // JobResult 判别子与分支 schema 逐项核对（复用作业面的契约镜像，不手抄）
  assert.deepEqual(Object.keys(job.result).sort(), ['kind', 'value']);
  assert.equal(job.result.kind, 'moderation');
  assert.deepEqual(collectResultValueIssues('moderation', job.result.value), []);
  assert.equal(job.result.value.decision, 'approved');
  assert.equal(job.result.value.id, task.job_id);
  assert.equal(job.result.value.rule_version, task.rule_version);

  // 卫生：响应体不得出现服务端租约、输入绑定摘要或正文原文
  const raw = JSON.stringify(own.data);
  assert.equal(raw.includes(task.lease_token), false, '租约是服务端回调 seam 凭据，绝不得投影进 HTTP 响应');
  assert.equal(raw.includes(task.evidence.input_binding_digest), false, '输入绑定摘要不进 HTTP 投影');
  assert.equal(raw.includes(CLEAN_TEXT), false, '响应体不得携带正文原文');
});

test('GET /jobs/{id}：他人作业与"不存在的 uuid"同形 404；非法 uuid 400；未声明查询参数 400', async (t) => {
  const h = await setup(t);
  const out = await h.submit();
  const task = out.tasks[0];

  const foreign = await h.call('GET', `${API}/jobs/${task.job_id}`, h.b);
  const missing = await h.call('GET', `${API}/jobs/00000000-0000-4000-8500-00000000dead`, h.b);
  assert.equal(foreign.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(foreign.data.error.code, 'NOT_FOUND');
  assert.deepEqual(foreign.data.error, missing.data.error, '他人作业与不存在必须同形');
  assert.equal(foreign.data.error.retryable, false);

  const guest = await h.call('GET', `${API}/jobs/${task.job_id}`, null);
  assert.equal(guest.status, 401);
  assert.equal(guest.data.error.code, 'SESSION_REQUIRED');

  // 路径参数契约声明 format: uuid ⇒ HTTP 层判 400（与"不存在"分开）
  const badId = await h.call('GET', `${API}/jobs/not-a-uuid`, h.a);
  assert.equal(badId.status, 400);
  assert.equal(badId.data.error.code, 'INVALID_REQUEST');

  // 契约未声明查询参数 ⇒ 未声明参数一律 400（不静默忽略）
  const withQuery = await h.call('GET', `${API}/jobs/${task.job_id}?probe=1`, h.a);
  assert.equal(withQuery.status, 400);
  assert.equal(withQuery.data.error.code, 'INVALID_REQUEST');
});

test('POST /jobs/{id}/cancel：审核作业**不提供取消** ⇒ 契约 503 PROVIDER_UNAVAILABLE(retryable)，不伪造 cancelled', async (t) => {
  const h = await setup(t);
  const out = await h.submit();
  const task = out.tasks[0];

  const cancelled = await h.call('POST', `${API}/jobs/${task.job_id}/cancel`, h.a, {
    headers: { 'if-match': '"1"', 'idempotency-key': 'synthetic-cancel-key-1' },
  });
  assert.equal(cancelled.status, 503);
  assert.equal(cancelled.data.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(cancelled.data.error.retryable, true);

  // 状态未被伪造：仍是 succeeded/approved
  const after = await h.call('GET', `${API}/jobs/${task.job_id}`, h.a);
  assert.equal(after.data.data.state, 'succeeded');
  assert.equal(after.data.data.result.value.decision, 'approved');
});

test('隔离任务的 HTTP 形态：带媒体内容两条版本级任务、均隔离且无契约对象可读（result=null，不填占位）', async (t) => {
  const h = await setup(t, { withImagePort: true });
  const content = mediaContent();
  h.harness.authority.seed(content.target_ref, {
    visibility: 'private',
    author_state: 'active',
    source_kind: 'database',
    owner_id: h.actorA.userId,
  });
  const out = await h.submit(content);
  assert.equal(out.tasks.length, 2);

  for (const task of out.tasks) {
    const read = await h.call('GET', `${API}/jobs/${task.job_id}`, h.a);
    assert.equal(read.status, 200, task.content_kind);
    assert.equal(read.data.data.state, 'uncertain');
    assert.equal(read.data.data.error_code, 'INPUT_UNCERTAIN');
    assert.equal(read.data.data.result, null, `${task.content_kind}：契约对象装配不出来时如实 result=null`);
  }
});

test('real 模式：审核域整域 fail-closed（送审 503），作业读面对未接线能力仍是同形 404（不谎称可用）', async (t) => {
  const h = await buildFixture(t, { real: true });
  const refused = await h.app.moderationService
    .submitScreening({ actor: { userId: h.a.user.id, role: 'user', authEpoch: 1 }, content: textContent() })
    .then(() => null, (error) => error);
  assert.ok(refused, 'real 模式送审必须被拒');
  assert.equal(refused.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(refused.status, 503);
  assert.equal(refused.retryable, true);

  const missing = await h.call('GET', `${API}/jobs/00000000-0000-4000-8500-00000000dead`, h.a);
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error.code, 'NOT_FOUND');
  assert.equal(h.app.moderationService.execution_mode, 'real');
  assert.deepEqual(h.app.moderationService.tasks({ type: 'post', id: 'post-1001', revision: 1 }), []);
  assert.equal(h.app.moderationService.counts().tasks, 0);
});
