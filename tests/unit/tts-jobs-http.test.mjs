/**
 * GY-I13（#13）合成域接入**已合并的共享作业源/跟进组件** · 真实回环 HTTP + 状态流转回归。
 *
 * 覆盖（逐条可单独指出）：
 * - **接线**：`GET /jobs/{id}` 能读出 `kind=synthesis` 的契约 `Job`（九键 / `additionalProperties:false` /
 *   `JobResult` 判别子 `synthesis` ⇒ `SynthesisResult`），且 `result.value` 通过
 *   `collectResultValueIssues('synthesis', …)`（**不手抄契约**，复用 `jobs/result-shape.ts` 的镜像）；
 * - **归属与不存在同形**：他人作业 / 不存在的 uuid / 非法 uuid 三者的 404 形状与既有域一致；
 * - **状态流转**：`queued`（受理即读）→ `succeeded`（带 `result`）/ `failed`（带契约 `error_code`，**不伪装成功**）；
 * - **无取消能力 ⇒ 不伪造 `cancelled`**：`cancel` 对已存在的合成作业如实 503 `PROVIDER_UNAVAILABLE`(`retryable`)，
 *   读取后状态与 revision **未被改动**；
 * - **幂等/并发口径与既有域一致**：同 `Idempotency-Key` 重复请求 → 同一 `job_id`、不新建任务；
 * - **`real` 未接真实依赖 fail-closed 对照**：受理前 503 `PROVIDER_UNAVAILABLE`（`retryable`），
 *   **不落任务、不产假音频**；`stub` 对照下替身产物**不是** `audio/*`、`substitute` 不进契约投影。
 *
 * 声明：全部输入为**合成夹具**（替身核对源 + 替身提供者 + 内存 store）；本文件**不含**任何真实
 * 供应商调用、凭据或真实音频。真机音频/交互证据属 #23，不在本文件范围内。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { collectResultValueIssues } from '../../services/api/src/jobs/result-shape.ts';
import { createMemoryCheckedContentPort } from '../../services/api/src/tts/content.ts';
import { SUBSTITUTE_ARTIFACT_CONTENT_TYPE } from '../../services/api/src/tts/provider.ts';
import { createMemorySynthesisStore } from '../../services/api/src/tts/store.ts';

const API = '/api/v1';
const SYNTHESIS_URL = `${API}/speech/synthesis`;
const START = Date.UTC(2026, 9, 14, 6, 0, 0);
const MISSING_JOB_ID = '00000000-0000-4000-8500-00000000dead';

const CHECKED_TEXT = '合成播报稿夹具：每亩用登记制剂 30 毫升，兑水 30 升常规喷雾。';
const REF = { type: 'answer', id: 'answer-i13-jobs-approved', revision: 3 };

/** 替身核对源：一条 `approved` 条目（**合成夹具**，非真实资料库、非真实审核结论）。 */
function contentPort() {
  return createMemoryCheckedContentPort([
    { type: REF.type, id: REF.id, revision: REF.revision, auditState: 'approved', text: CHECKED_TEXT, ownerUserId: null },
  ]);
}

/** 会失败的替身提供者：用于构造 `failed` + 契约 `error_code` 的状态流转（不触达任何真实供应商）。 */
function failingProvider() {
  return {
    executionMode: 'stub',
    providerVersion: 'stub-failing-v1',
    note: '合成夹具提供者（测试用；不触达真实供应商，不产生任何音频）',
    available: true,
    unavailableReason: null,
    async synthesize() {
      // 非超时失败码 ⇒ 契约 `failed`（超时码会按既有口径落 `timed_out`，这里刻意分开）。
      return { kind: 'failed', code: 'PROVIDER_OUTCOME_UNKNOWN' };
    },
  };
}

async function buildFixture(t, options = {}) {
  const auth = createMemoryAuthStore();
  const baseConfig = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
  // real 模式：沿用既有回归的装配口径（stub 配置 + 显式切模式），**不提供任何真实凭据**，
  // 因此校验必然落到 fail-closed 分支（这正是本用例要证明的）。
  const config = options.real === true ? { ...baseConfig, executionMode: 'real', requiresRealCredentials: true } : baseConfig;
  const store = createMemorySynthesisStore();
  const app = buildApp({
    config,
    store: auth,
    now: () => new Date(START),
    synthesisStore: store,
    synthesisContent: contentPort(),
    ...(options.provider === undefined ? {} : { synthesisProvider: options.provider }),
  });
  const account = async (seed) => {
    const user = await auth.createUser(seed.repeat(64));
    const token = `synthetic-i13-token-${seed}`;
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
  return { app, auth, store, a, b, call };
}

const synthesisBody = (ref = REF) => ({ checked_content_ref: { ...ref }, locale: 'zh-CN' });

let keySeq = 0;
const nextKey = () => `synthetic-i13-idem-key-${String((keySeq += 1)).padStart(4, '0')}`;

/** 受理一条合成任务并等到执行落定（stub 替身，确定性、无网络）。 */
async function acceptOne(h, ref = REF) {
  const accepted = await h.call('POST', SYNTHESIS_URL, h.a, { headers: { 'idempotency-key': nextKey() }, payload: synthesisBody(ref) });
  assert.equal(accepted.status, 202, `受理应 202，实际 ${accepted.status}：${JSON.stringify(accepted.data)}`);
  await h.app.synthesisService.settle();
  return accepted.data.data;
}

// ---------------------------------------------------------------- 接线与契约形状

test('接线·GET /jobs/{id} 读出 kind=synthesis 的契约 Job（九键/闭集/SynthesisResult），未接线的旧行为不变', async (t) => {
  const h = await buildFixture(t);
  const job = await acceptOne(h);
  assert.equal(job.kind, 'synthesis');
  assert.equal(job.state, 'queued', '受理后 202 投影是 queued');
  assert.equal(job.result, null, 'queued 不得携带 result');

  const read = await h.call('GET', `${API}/jobs/${job.id}`, h.a);
  assert.equal(read.status, 200);
  assert.equal(read.cache, 'no-store');
  assert.equal(read.data.meta.contract_version, '1.0.0');
  assert.equal(read.data.meta.execution_mode, 'stub');
  assert.equal(read.etag, '"3"', '执行落定后 revision 递增到 3（queued=1 → running=2 → 终态=3）');

  const out = read.data.data;
  assert.deepEqual(
    Object.keys(out).sort(),
    ['id', 'revision', 'kind', 'target_ref', 'state', 'deadline_at', 'created_at', 'error_code', 'result'].sort(),
    'Job 键集合必须恰好九个（additionalProperties:false）',
  );
  assert.equal(out.kind, 'synthesis');
  assert.equal(out.id, job.id);
  assert.equal(out.state, 'succeeded');
  assert.equal(out.error_code, null);
  assert.deepEqual(out.target_ref, { ...REF }, 'target_ref 必须等于绑定的已核对目标与 revision');
  assert.equal(Number.isNaN(Date.parse(out.deadline_at)), false);
  assert.equal(Number.isNaN(Date.parse(out.created_at)), false);

  // JobResult 判别子 + 分支 schema 逐项核对（复用作业面镜像，不手抄）
  assert.deepEqual(Object.keys(out.result).sort(), ['kind', 'value']);
  assert.equal(out.result.kind, 'synthesis');
  assert.deepEqual(collectResultValueIssues('synthesis', out.result.value), []);
  assert.deepEqual(Object.keys(out.result.value).sort(), ['checked_content_ref', 'id', 'media_id', 'revision']);
  assert.deepEqual(out.result.value.checked_content_ref, { ...REF }, '结果里的 checked_content_ref 必须与 target_ref 一致');
  assert.match(out.result.value.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.match(out.result.value.media_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

  // 卫生：替身标注 / 正文原文 / 内部字段都不得进契约投影
  const raw = JSON.stringify(read.data);
  assert.equal(raw.includes('substitute'), false, 'substitute 是内部标注，不进契约投影');
  assert.equal(raw.includes(CHECKED_TEXT), false, '响应体不得携带已核对正文原文');
  assert.equal(raw.includes(SUBSTITUTE_ARTIFACT_CONTENT_TYPE), false, '产物 MIME 不进契约投影');
});

test('接线·未注册的接口形态不新增：TTS 域仍只有 POST（GET/DELETE /speech/synthesis 仍是 404）', async (t) => {
  const h = await buildFixture(t);
  for (const method of ['GET', 'DELETE']) {
    const response = await h.call(method, SYNTHESIS_URL, h.a);
    assert.equal(response.status, 404, `${method} ${SYNTHESIS_URL} 不应被本片新造出来`);
  }
});

// ---------------------------------------------------------------- 归属与不存在同形

test('反例·他人作业 / 不存在的 uuid / 非法 uuid：前两者同形 404，非法 uuid 由 HTTP 层判 400', async (t) => {
  const h = await buildFixture(t);
  const job = await acceptOne(h);

  const foreign = await h.call('GET', `${API}/jobs/${job.id}`, h.b);
  const missing = await h.call('GET', `${API}/jobs/${MISSING_JOB_ID}`, h.b);
  assert.equal(foreign.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(foreign.data.error.code, 'NOT_FOUND');
  assert.deepEqual(foreign.data.error, missing.data.error, '他人作业与「不存在」必须逐字段同形（不泄露存在性）');
  assert.equal(foreign.data.error.retryable, false);

  const guest = await h.call('GET', `${API}/jobs/${job.id}`, null);
  assert.equal(guest.status, 401);
  assert.equal(guest.data.error.code, 'SESSION_REQUIRED');

  // 路径参数契约声明 format: uuid ⇒ 非 uuid 由 HTTP 层判 400（与「不存在」分开，两层分工）
  const badId = await h.call('GET', `${API}/jobs/not-a-uuid`, h.a);
  assert.equal(badId.status, 400);
  assert.equal(badId.data.error.code, 'INVALID_REQUEST');

  // 契约未声明查询参数 ⇒ 未声明参数一律 400（不静默忽略）
  const withQuery = await h.call('GET', `${API}/jobs/${job.id}?probe=1`, h.a);
  assert.equal(withQuery.status, 400);
  assert.equal(withQuery.data.error.code, 'INVALID_REQUEST');

  // 越权者也不能取消他人的合成作业（同形 404，而不是先告诉他「存在但不可取消」）
  const foreignCancel = await h.call('POST', `${API}/jobs/${job.id}/cancel`, h.b, {
    headers: { 'if-match': '"2"', 'idempotency-key': nextKey() },
  });
  assert.equal(foreignCancel.status, 404);
  assert.equal(foreignCancel.data.error.code, 'NOT_FOUND');
});

// ---------------------------------------------------------------- 状态流转（成功 / 失败 / 取消）

test('状态流转·失败：提供者失败 ⇒ failed + 契约 error_code（绝不伪装 succeeded），result 如实为 null', async (t) => {
  const h = await buildFixture(t, { provider: failingProvider() });
  const job = await acceptOne(h);

  const read = await h.call('GET', `${API}/jobs/${job.id}`, h.a);
  assert.equal(read.status, 200);
  const out = read.data.data;
  assert.equal(out.kind, 'synthesis');
  assert.equal(out.state, 'failed');
  assert.equal(out.error_code, 'PROVIDER_OUTCOME_UNKNOWN', 'failed 必须带契约闭集内的 error_code（不得报成无原因）');
  assert.equal(out.result, null, 'failed 不得携带 result');
});

test('状态流转·无取消能力：cancel 如实 503 PROVIDER_UNAVAILABLE(retryable)，**不伪造 cancelled**、状态与 revision 不变', async (t) => {
  const h = await buildFixture(t);
  const job = await acceptOne(h);
  const before = (await h.call('GET', `${API}/jobs/${job.id}`, h.a)).data.data;

  const cancelled = await h.call('POST', `${API}/jobs/${job.id}/cancel`, h.a, {
    headers: { 'if-match': `"${before.revision}"`, 'idempotency-key': nextKey() },
  });
  assert.equal(cancelled.status, 503);
  assert.equal(cancelled.data.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(cancelled.data.error.retryable, false, '合成域无取消能力（未接线）⇒ 同一请求重试不会成功，不得标为可重试');

  const after = (await h.call('GET', `${API}/jobs/${job.id}`, h.a)).data.data;
  assert.equal(after.state, before.state, '取消能力缺失 ⇒ 状态不得被改动（没有伪造 cancelled）');
  assert.equal(after.revision, before.revision, 'revision 不得因失败的取消而递增');
  assert.deepEqual(after.result, before.result);
});

test('状态流转·取消能力缺失时缺请求头仍按既有口径：缺 Idempotency-Key ⇒ 400；缺 If-Match ⇒ 428', async (t) => {
  const h = await buildFixture(t);
  const job = await acceptOne(h);

  const noKey = await h.call('POST', `${API}/jobs/${job.id}/cancel`, h.a, { headers: { 'if-match': '"2"' } });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.data.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

  const noVersion = await h.call('POST', `${API}/jobs/${job.id}/cancel`, h.a, { headers: { 'idempotency-key': nextKey() } });
  assert.equal(noVersion.status, 428);
  assert.equal(noVersion.data.error.code, 'REVISION_REQUIRED');

  // 两头齐备后才落到「存在但该域无取消能力」的 503（与既有 kind 同一顺序语义）
  const both = await h.call('POST', `${API}/jobs/${job.id}/cancel`, h.a, {
    headers: { 'if-match': '"2"', 'idempotency-key': nextKey() },
  });
  assert.equal(both.status, 503);
  assert.equal(both.data.error.code, 'PROVIDER_UNAVAILABLE');
});

// ---------------------------------------------------------------- 幂等与并发

test('幂等·同 Idempotency-Key 重复请求收敛到同一 job_id（不新建任务、不重复调用提供者）', async (t) => {
  const h = await buildFixture(t);
  const key = nextKey();
  const first = await h.call('POST', SYNTHESIS_URL, h.a, { headers: { 'idempotency-key': key }, payload: synthesisBody() });
  const second = await h.call('POST', SYNTHESIS_URL, h.a, { headers: { 'idempotency-key': key }, payload: synthesisBody() });
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(second.data.data.id, first.data.data.id, '同键必须收敛到同一任务 id');
  await h.app.synthesisService.settle();

  // 作业读面在时序不同时也必须是同一条作业（id 相同、状态是终态）
  const read = await h.call('GET', `${API}/jobs/${first.data.data.id}`, h.a);
  assert.equal(read.status, 200);
  assert.equal(read.data.data.id, first.data.data.id);
  assert.equal(read.data.data.state, 'succeeded');
});

test('并发·同键并发请求只产生一条作业（作业读面可复核：id 唯一、状态终态）', async (t) => {
  const h = await buildFixture(t);
  const key = nextKey();
  const results = await Promise.all([
    h.call('POST', SYNTHESIS_URL, h.a, { headers: { 'idempotency-key': key }, payload: synthesisBody() }),
    h.call('POST', SYNTHESIS_URL, h.a, { headers: { 'idempotency-key': key }, payload: synthesisBody() }),
  ]);
  await h.app.synthesisService.settle();
  const ids = new Set(results.filter((r) => r.status === 202).map((r) => r.data.data.id));
  assert.equal(ids.size, 1, `同键并发只应有一个 job_id，实际 ${JSON.stringify([...ids])}`);
  const [jobId] = [...ids];
  const read = await h.call('GET', `${API}/jobs/${jobId}`, h.a);
  assert.equal(read.data.data.id, jobId);
  assert.equal(read.data.data.state, 'succeeded');
});

// ---------------------------------------------------------------- real 未接真实依赖 ⇒ fail-closed（对照）

test('real 未接真实 TTS ⇒ 受理前 503 PROVIDER_UNAVAILABLE(retryable)，**不落任务、不产假音频**；stub 对照可用', async (t) => {
  const real = await buildFixture(t, { real: true });
  const refused = await real.call('POST', SYNTHESIS_URL, real.a, {
    headers: { 'idempotency-key': nextKey() },
    payload: synthesisBody(),
  });
  assert.equal(refused.status, 503, 'real 未接真实依赖必须 fail-closed');
  assert.equal(refused.data.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(refused.data.error.retryable, false, '真实 TTS 未接线 ⇒ 需运维改配置，不是瞬时故障 ⇒ 不得标为可重试');

  // 不落任务：没有任何可读作业（与「作业不存在」同形 404，不谎称有任务）
  const described = real.app.synthesisService.describe();
  assert.equal(described.providerAvailable, false);
  assert.equal(described.realAudioProduced, false, '本片不产生任何真实音频');
  assert.equal(
    /audio\/mpeg|audio\/wav/i.test(described.providerNote),
    false,
    '替身/未接线标注不得声称真实音频',
  );
  const missing = await real.call('GET', `${API}/jobs/${MISSING_JOB_ID}`, real.a);
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error.code, 'NOT_FOUND');

  // stub 对照：替身可受理，且产物**不是** audio/*（明确标注的替身，不得以替身冒充真实音频）
  const stub = await buildFixture(t);
  const accepted = await acceptOne(stub);
  const read = await stub.call('GET', `${API}/jobs/${accepted.id}`, stub.a);
  assert.equal(read.status, 200);
  assert.equal(read.data.data.state, 'succeeded');
  const object = await stub.store.getSynthesis(read.data.data.result.value.id);
  assert.equal(object.substitute, true, 'stub 产物必须如实标注为替身');
  assert.equal(
    String(object.providerVersion).includes('audio'),
    false,
    '替身提供者版本不得伪装成真实音频来源',
  );
  assert.equal(stub.app.synthesisService.describe().mediaNote.includes('替身'), true);
});
