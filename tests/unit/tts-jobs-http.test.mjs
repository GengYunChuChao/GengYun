/**
 * GY-I13（#13）合成域接入**已合并的共享作业源/跟进组件** · 真实回环 HTTP + 状态流转回归。
 *
 * 覆盖（逐条可单独指出）：
 * - **接线**：`GET /jobs/{id}` 能读出 `kind=synthesis` 的契约 `Job`（九键 / `additionalProperties:false` /
 *   `JobResult` 判别子 `synthesis` ⇒ `SynthesisResult`），且 `result.value` 通过
 *   `collectResultValueIssues('synthesis', …)`（**不手抄契约**，复用 `jobs/result-shape.ts` 的镜像）；
 * - **归属与不存在同形**：他人作业 / 不存在的 uuid / 非法 uuid 三者的 404 形状与既有域一致；
 * - **状态流转**：`queued`（受理即读）→ `succeeded`（带 `result`）/ `failed`（带契约 `error_code`，**不伪装成功**）；
 * - **取消（GY-R27 接线）**：`cancel` 对已存在的合成作业**真的取消**（`queued`/`running` ⇒ 200 `cancelled`，
 *   revision 恰好 +1、`error_code` 清空、`result` 为 null）；终态再取消 ⇒ 409 `OBJECT_UNAVAILABLE`
 *   （**不是** 503 `PROVIDER_UNAVAILABLE`，也不伪造第二次取消）；取消后迟到的提供者结果**不复活**作业；
 * - **幂等/并发口径与既有域一致**：同 `Idempotency-Key` 重复请求 → 同一 `job_id`、不新建任务；
 *   取消的同键回放不再自增 revision；
 * - **`real` 未接真实依赖 fail-closed 对照**：受理前 503 `PROVIDER_UNAVAILABLE`（`retryable`），
 *   **不落任务、不产假音频**；`stub` 对照下替身产物**不是** `audio/*`、`substitute` 不进契约投影。
 *
 * 声明：全部输入为**合成夹具**（替身核对源 + 替身提供者 + 内存 store）；本文件**不含**任何真实
 * 供应商调用、凭据或真实音频。真机音频/交互证据属 #23，不在本文件范围内。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { collectResultValueIssues } from '../../services/api/src/jobs/result-shape.ts';
import { createMemoryCheckedContentPort } from '../../services/api/src/tts/content.ts';
import { SUBSTITUTE_ARTIFACT_CONTENT_TYPE, createStubTtsProvider } from '../../services/api/src/tts/provider.ts';
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
  const auth = options.auth ?? createMemoryAuthStore();
  const baseConfig = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
  // real 模式：沿用既有回归的装配口径（stub 配置 + 显式切模式），**不提供任何真实凭据**，
  // 因此校验必然落到 fail-closed 分支（这正是本用例要证明的）。
  const config = options.real === true ? { ...baseConfig, executionMode: 'real', requiresRealCredentials: true } : baseConfig;
  const store = options.store ?? createMemorySynthesisStore();
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
  const a = options.actorA ?? (await account('a'));
  const b = options.actorB ?? (await account('b'));
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

/**
 * 直接往**同一内存 store** 落一条合成作业行（用于精确构造 `queued`/`running` 现场）：
 * 不经过受理、不调用提供者 ⇒ 取消用例不依赖执行器时序，也就不会因机器快慢而抖动。
 */
async function seedJob(store, overrides = {}) {
  const row = {
    id: randomUUID(),
    revision: 1,
    kind: 'synthesis',
    ownerUserId: overrides.ownerUserId,
    // 与 `APP_EXECUTION_MODE=stub` 的装配一致：读面 `assertJobMode` 才不会因模式交叉 503。
    executionMode: 'stub',
    synthesisId: randomUUID(),
    checkedContentRef: { ...REF },
    locale: 'zh-CN',
    state: 'queued',
    deadlineAt: new Date(START + 10 * 60 * 1000),
    createdAt: new Date(START),
    updatedAt: new Date(START),
    errorCode: null,
    ...overrides,
  };
  await store.insertJob(row);
  return row;
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

test('状态流转·取消已接线：running 作业 cancel ⇒ 200 cancelled（revision 恰好 +1、error_code 清空、result=null），GET 读回一致', async (t) => {
  const h = await buildFixture(t);
  // 刻意带上残余错误码：取消不是失败，必须清空（GET 读回 error_code=null）。
  const job = await seedJob(h.store, {
    ownerUserId: h.a.user.id,
    state: 'running',
    revision: 2,
    errorCode: 'PROVIDER_QUOTA_EXCEEDED',
  });

  const before = (await h.call('GET', `${API}/jobs/${job.id}`, h.a)).data.data;
  assert.equal(before.state, 'running', '前置：作业处于 running');
  assert.equal(before.revision, 2, '前置：running 的 revision 为 2（queued=1 → running=2）');

  const cancelled = await h.call('POST', `${API}/jobs/${job.id}/cancel`, h.a, {
    headers: { 'if-match': `"${before.revision}"`, 'idempotency-key': nextKey() },
  });
  assert.equal(cancelled.status, 200, `取消应 200，实际 ${cancelled.status}：${JSON.stringify(cancelled.data)}`);
  assert.notEqual(
    cancelled.data.error?.code,
    'PROVIDER_UNAVAILABLE',
    '取消已接线 ⇒ 绝不得再回「该作业所属能力尚未提供取消」的 503',
  );
  assert.equal(cancelled.data.data.state, 'cancelled');
  assert.equal(cancelled.data.data.revision, 3, 'revision 必须**恰好 +1**（不得 +2、不得不变）');
  assert.equal(cancelled.etag, '"3"', '响应 ETag 必须是取消后的 revision 强 ETag');
  assert.equal(cancelled.cache, 'no-store');
  assert.equal(cancelled.data.data.error_code, null, '取消不是错误 ⇒ error_code 必须清空');
  assert.equal(cancelled.data.data.result, null, '取消不产出合成记录 ⇒ result 恒为 null');
  assert.deepEqual(cancelled.data.data.target_ref, { ...REF }, '取消不得改写 target_ref');
  assert.deepEqual(
    Object.keys(cancelled.data.data).sort(),
    ['id', 'revision', 'kind', 'target_ref', 'state', 'deadline_at', 'created_at', 'error_code', 'result'].sort(),
    '取消的响应体仍必须是九键契约 Job（additionalProperties:false）',
  );

  // 判据 7：取消后 GET /jobs/{id} 读到 state=cancelled、error_code 清空。
  const after = (await h.call('GET', `${API}/jobs/${job.id}`, h.a)).data.data;
  assert.equal(after.state, 'cancelled');
  assert.equal(after.revision, 3, '读面不得因取消再自增 revision');
  assert.equal(after.error_code, null);
  assert.equal(after.result, null);
  assert.equal(after.kind, 'synthesis');

  // 判据 6：重复取消（换新键、带当前 revision）⇒ 409 OBJECT_UNAVAILABLE，不 5xx、不再 +1 revision。
  const again = await h.call('POST', `${API}/jobs/${job.id}/cancel`, h.a, {
    headers: { 'if-match': '"3"', 'idempotency-key': nextKey() },
  });
  assert.equal(again.status, 409, `重复取消必须 409（对象当前不可取消），实际 ${again.status}`);
  assert.equal(again.data.error.code, 'OBJECT_UNAVAILABLE', '终态再取消是 OBJECT_UNAVAILABLE，不是 PROVIDER_UNAVAILABLE');
  assert.equal(again.data.error.retryable, false);
  const finalRead = (await h.call('GET', `${API}/jobs/${job.id}`, h.a)).data.data;
  assert.equal(finalRead.state, 'cancelled', '重复取消不得改写状态');
  assert.equal(finalRead.revision, 3, '重复取消不得再自增 revision');
});

test('状态流转·终态（succeeded）作业 cancel ⇒ 409 OBJECT_UNAVAILABLE，**不伪造 cancelled**、状态与 revision 不变', async (t) => {
  const h = await buildFixture(t);
  const job = await acceptOne(h);
  const before = (await h.call('GET', `${API}/jobs/${job.id}`, h.a)).data.data;
  assert.equal(before.state, 'succeeded', '前置：作业已落终态 succeeded');

  const rejected = await h.call('POST', `${API}/jobs/${job.id}/cancel`, h.a, {
    headers: { 'if-match': `"${before.revision}"`, 'idempotency-key': nextKey() },
  });
  assert.equal(rejected.status, 409, `终态取消应 409，实际 ${rejected.status}：${JSON.stringify(rejected.data)}`);
  assert.equal(rejected.data.error.code, 'OBJECT_UNAVAILABLE');
  assert.notEqual(rejected.data.error.code, 'PROVIDER_UNAVAILABLE', '取消已接线 ⇒ 不得回「能力未接线」的 503');

  const after = (await h.call('GET', `${API}/jobs/${job.id}`, h.a)).data.data;
  assert.equal(after.state, before.state, '终态取消 ⇒ 状态不得被改动（没有伪造 cancelled）');
  assert.equal(after.revision, before.revision, 'revision 不得因失败的取消而递增');
  assert.deepEqual(after.result, before.result, '终态取消不得改动既有结果');
});

test('状态流转·取消后迟到的提供者结果**不复活**作业（HTTP 端到端：闸门放行后仍是 cancelled）', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  // 复用产品替身提供者（**非真实音频**），只在外面套一道闸门以制造 running 现场。
  const stub = createStubTtsProvider();
  const h = await buildFixture(t, {
    provider: {
      ...stub,
      note: '闸门替身提供者（非真实音频、不触达真实供应商）',
      async synthesize(input) {
        await gate;
        return stub.synthesize(input);
      },
    },
  });

  const accepted = await h.call('POST', SYNTHESIS_URL, h.a, { headers: { 'idempotency-key': nextKey() }, payload: synthesisBody() });
  assert.equal(accepted.status, 202);
  const jobId = accepted.data.data.id;

  // 等执行器把作业推进到 running（提供者被闸门挡住）。
  let running = null;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const read = (await h.call('GET', `${API}/jobs/${jobId}`, h.a)).data.data;
    if (read.state === 'running') {
      running = read;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.notEqual(running, null, '前置：作业应进入 running');
  assert.equal(running.revision, 2);

  // 闸门**必须**无条件放行（否则变异/断言失败会把在途执行永远挂在事件循环上，表现为挂死而非红）。
  let cancelled;
  try {
    cancelled = await h.call('POST', `${API}/jobs/${jobId}/cancel`, h.a, {
      headers: { 'if-match': `"${running.revision}"`, 'idempotency-key': nextKey() },
    });
  } finally {
    // 放行迟到结果：终态 CAS 用的是 running.revision(2)，库内已是取消后的 revision ⇒ 写不进去。
    release();
  }
  await h.app.synthesisService.settle();

  assert.equal(cancelled.status, 200, `取消应 200，实际 ${cancelled.status}：${JSON.stringify(cancelled.data)}`);
  assert.equal(cancelled.data.data.revision, 3, 'revision 必须恰好 +1');

  const after = (await h.call('GET', `${API}/jobs/${jobId}`, h.a)).data.data;
  assert.equal(after.state, 'cancelled', '迟到结果不得把已取消的作业复活成 succeeded');
  assert.equal(after.revision, 3, '迟到结果不得再自增 revision');
  assert.equal(after.result, null, '取消后不得冒出可读的合成结果');
  assert.equal(after.error_code, null);
  // 取消不产出合成记录：该作业的 synthesis_id 在 store 里必须查不到。
  const row = await h.store.getJob(jobId);
  assert.equal(await h.store.getSynthesis(row.synthesisId), null, '取消后不得写入合成记录');
});

test('状态流转·取消的同键回放：原样重试 ⇒ 200 且不再 +1 revision；换键重试 ⇒ 409、仍不 +1', async (t) => {
  const h = await buildFixture(t);
  const job = await seedJob(h.store, { ownerUserId: h.a.user.id, state: 'queued', revision: 1 });
  const key = nextKey();

  const first = await h.call('POST', `${API}/jobs/${job.id}/cancel`, h.a, {
    headers: { 'if-match': '"1"', 'idempotency-key': key },
  });
  assert.equal(first.status, 200);
  assert.equal(first.data.data.state, 'cancelled');
  assert.equal(first.data.data.revision, 2);

  // 同键同体原样重试：必须回放（不得被已自增的 revision 判成 409、不得再 +1）。
  const replay = await h.call('POST', `${API}/jobs/${job.id}/cancel`, h.a, {
    headers: { 'if-match': '"1"', 'idempotency-key': key },
  });
  assert.equal(replay.status, 200, `同键回放应 200，实际 ${replay.status}：${JSON.stringify(replay.data)}`);
  assert.equal(replay.data.data.state, 'cancelled');
  assert.equal(replay.data.data.revision, 2, '回放不得再自增 revision');

  // 换键 + 当前 revision ⇒ 终态不可取消（409，不是 5xx），仍不再 +1。
  const again = await h.call('POST', `${API}/jobs/${job.id}/cancel`, h.a, {
    headers: { 'if-match': '"2"', 'idempotency-key': nextKey() },
  });
  assert.equal(again.status, 409);
  assert.equal(again.data.error.code, 'OBJECT_UNAVAILABLE');
  const persisted = await h.store.getJob(job.id);
  assert.equal(persisted.state, 'cancelled');
  assert.equal(persisted.revision, 2, '重复取消不得再自增 revision');
});

test('状态流转·取消已接线后，缺/非法请求头仍按既有口径：缺 Key ⇒ 400；缺 If-Match ⇒ 428；非法 ⇒ 400；齐备才触达取消语义', async (t) => {
  const h = await buildFixture(t);
  const job = await seedJob(h.store, { ownerUserId: h.a.user.id, state: 'queued', revision: 2 });

  const noKey = await h.call('POST', `${API}/jobs/${job.id}/cancel`, h.a, { headers: { 'if-match': '"2"' } });
  assert.equal(noKey.status, 400, `缺 Idempotency-Key 应 400，实际 ${noKey.status}`);
  assert.equal(noKey.data.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

  const noVersion = await h.call('POST', `${API}/jobs/${job.id}/cancel`, h.a, { headers: { 'idempotency-key': nextKey() } });
  assert.equal(noVersion.status, 428, `缺 If-Match 应 428，实际 ${noVersion.status}`);
  assert.equal(noVersion.data.error.code, 'REVISION_REQUIRED');

  const badVersion = await h.call('POST', `${API}/jobs/${job.id}/cancel`, h.a, {
    headers: { 'if-match': 'abc', 'idempotency-key': nextKey() },
  });
  assert.equal(badVersion.status, 400, `非法 If-Match 应 400，实际 ${badVersion.status}`);
  assert.equal(badVersion.data.error.code, 'INVALID_REQUEST');

  // 两头齐备后才落到取消语义：旧 revision ⇒ 409 REVISION_CONFLICT（**不再是 503 未接线**）。
  const stale = await h.call('POST', `${API}/jobs/${job.id}/cancel`, h.a, {
    headers: { 'if-match': '"1"', 'idempotency-key': nextKey() },
  });
  assert.equal(stale.status, 409, `旧 revision 应 409，实际 ${stale.status}：${JSON.stringify(stale.data)}`);
  assert.equal(stale.data.error.code, 'REVISION_CONFLICT');
  assert.notEqual(stale.data.error.code, 'PROVIDER_UNAVAILABLE');

  // 上面每一次失败都不得改动作业（状态与 revision 双向守护）。
  const untouched = await h.store.getJob(job.id);
  assert.equal(untouched.state, 'queued', '请求头不合法的取消不得改状态');
  assert.equal(untouched.revision, 2, '请求头不合法的取消不得自增 revision');

  // 正确凭据 ⇒ 200 cancelled，revision 恰好 2 → 3。
  const ok = await h.call('POST', `${API}/jobs/${job.id}/cancel`, h.a, {
    headers: { 'if-match': '"2"', 'idempotency-key': nextKey() },
  });
  assert.equal(ok.status, 200, `正确凭据应 200，实际 ${ok.status}：${JSON.stringify(ok.data)}`);
  assert.equal(ok.data.data.state, 'cancelled');
  assert.equal(ok.data.data.revision, 3);
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

// ---------------------------------------------------------------- 模式交叉不撒谎 / 音频归属

test('模式交叉·stub 受理的任务标识在 real 装配下 503 可解释，绝不把替身产物当成 real 的成功作业读出', async (t) => {
  // 反事实：只有「同一 store 被两套模式共享」时才可能把 stub 任务读成 real 作业
  // （生产默认各进程独立内存 store；这里刻意共享，用来证明读面不会撒谎）。
  const shared = createMemorySynthesisStore();
  const stub = await buildFixture(t, { store: shared });
  const job = await acceptOne(stub);

  const own = await stub.call('GET', `${API}/jobs/${job.id}`, stub.a);
  assert.equal(own.status, 200, '前置：同一模式下读得到该作业');
  assert.equal(own.data.data.state, 'succeeded');
  assert.equal(own.data.data.result.kind, 'synthesis');
  const stubMediaId = own.data.data.result.value.media_id;

  // 同一 auth store / 同一主体 / 同一 synthesis store，但装配切到 real（无真实凭据）。
  const real = await buildFixture(t, {
    real: true,
    store: shared,
    auth: stub.auth,
    actorA: stub.a,
    actorB: stub.b,
  });
  assert.equal(real.app.synthesisService.describe().executionMode, 'real');
  assert.equal(real.app.synthesisService.describe().providerAvailable, false);

  const crossed = await real.call('GET', `${API}/jobs/${job.id}`, real.a);
  assert.equal(crossed.status, 503, `real 装配读 stub 任务必须 503，实际 ${crossed.status}：${JSON.stringify(crossed.data)}`);
  assert.equal(crossed.data.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(crossed.data.error.retryable, false, '模式不符不是瞬时故障 ⇒ 不得标为可重试');
  assert.match(crossed.data.error.message, /stub/);
  assert.match(crossed.data.error.message, /real/);
  assert.equal(crossed.data.data, undefined, '503 不得携带任何作业投影（不冒充成功、不泄 media_id）');
  assert.equal(JSON.stringify(crossed.data).includes(stubMediaId), false, '响应体不得泄露 stub 产物 id');

  // 交叉读取绝不改动原任务：stub 装配下它仍是原本的 succeeded + 同一 revision。
  const reread = await stub.call('GET', `${API}/jobs/${job.id}`, stub.a);
  assert.equal(reread.status, 200);
  assert.equal(reread.data.data.state, 'succeeded');
  assert.equal(reread.data.data.revision, own.data.data.revision, '交叉模式读取不得改写任务 revision');
  assert.deepEqual(reread.data.data.result, own.data.data.result);
});

test('音频归属与访问·合成 media_id 在媒体域无隐式出口：属主读与不存在同形 404，他人读同形 404（需显式凭据）', async (t) => {
  const h = await buildFixture(t);
  const job = await acceptOne(h);
  const read = await h.call('GET', `${API}/jobs/${job.id}`, h.a);
  assert.equal(read.status, 200);
  const mediaId = read.data.data.result.value.media_id;
  assert.match(mediaId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

  // 属主直接读媒体域：合成产物不因「同一属主」而被旁路读出，与不存在的媒体同形。
  const owner = await h.call('GET', `${API}/media/${mediaId}`, h.a);
  const missing = await h.call('GET', `${API}/media/${MISSING_JOB_ID}`, h.a);
  assert.equal(owner.status, 404, `合成产物不得在媒体域被隐式读出，实际 ${owner.status}：${JSON.stringify(owner.data)}`);
  assert.equal(missing.status, 404);
  assert.deepEqual(owner.data.error, missing.data.error, '属主读合成产物与「媒体不存在」必须逐字段同形');

  // 他人读同一条 id：同形 404（不泄露「这条 id 存在」）。
  const foreign = await h.call('GET', `${API}/media/${mediaId}`, h.b);
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.data.error, owner.data.error, '跨用户读合成产物必须与不存在同形');

  // 访问凭据入口也不认它：没有显式 grant 就没有访问，不得凭空发凭据。
  for (const actor of [h.a, h.b]) {
    const grant = await h.call('POST', `${API}/media/${mediaId}/access`, actor, {
      headers: { 'if-match': '"1"', 'idempotency-key': nextKey() },
    });
    assert.equal(grant.status, 404, `无显式凭据不得发放访问授权，实际 ${grant.status}：${JSON.stringify(grant.data)}`);
    assert.equal(grant.data.error.code, 'NOT_FOUND');
  }
});
