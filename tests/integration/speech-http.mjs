// GY-I11 阶段 2b 隔离集成回归：**经真实装配的 app**（`buildApp`）+ 本机 loopback 真实 HTTP。
//
// 运行：`node tests/integration/speech-http.mjs`（退出码 0 表示通过；任何断言失败以非 0 退出并打印原始断言）
//
// 与阶段 2a 的差别：2a 时 `app.ts`/`routes/recognitions.ts` 尚未落地，只能在测试内自建最小 app；
// 现在 `buildApp` 已装配 `registerSpeechRoutes`（app.ts 只加两行），因此本脚本改为**打真实装配**：
// 同一个 `buildApp` 同时提供鉴权、错误封套、ajv `removeAdditional:false` 与转写路由。
//
// 边界（如实标注，不得外推）：
// - 只用本机回环（127.0.0.1，随机端口）；**不发起任何外网请求**、**不连接任何数据库**（内存 store）。
// - 身份是**合成**的：stub 模式下经真实 `POST /api/v1/auth/wechat`（替身身份提供者）登录；
//   real 模式实例直接按 `AuthStore` 公开 API 播种会话（real 模式禁止内存 store 签发会话，故不登录）。
// - ASR 提供者是**明确标注的替身**（stub 分桶）或 real 的 fail-closed 实现；**不是真实供应商**。
// - **ASR 真实样本为 0** ⇒ 本脚本不产生、不声称任何准确率或转写质量结论。
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemorySpeechStore } from '../../services/api/src/speech/store.ts';
import { createSubstituteMediaPort } from '../../services/api/src/speech/media.ts';

const API = '/api/v1';
const PATH = API + '/speech/transcriptions';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const observations = [];
const root = new URL('../../', import.meta.url);

let keySeq = 0;
const newKey = (label) => `speech-http-${label}-${String((keySeq += 1)).padStart(4, '0')}`;

/** 与 `speech/provider.ts` 的 `bucketOf` 同口径：sha256(media_id) 首字节对 6 取模。 */
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
  throw new Error(`未找到分桶 ${bucket} 的媒体 uuid`);
}
// 替身分桶语义（见 provider.ts）：0 正常带 2 区间 / 1 全置信 / 2 空转写 / 3 恰好 100 区间 / 4 超长 / 5 畸形区间。
const MEDIA = {
  normal: mediaIdForBucket(0),
  confident: mediaIdForBucket(1),
  silent: mediaIdForBucket(2),
  atLimit: mediaIdForBucket(3),
  tooLong: mediaIdForBucket(4),
  malformedSpan: mediaIdForBucket(5),
};

let passed = 0;
async function group(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error?.message}`);
    throw error;
  }
}

/** 回环 HTTP 调用（只走 127.0.0.1）。 */
function makeHttp(origin) {
  return async function http(path, options = {}) {
    const headers = {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    };
    const response = await fetch(origin + path, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return {
      status: response.status,
      body,
      text,
      etag: response.headers.get('etag'),
      cache: response.headers.get('cache-control'),
    };
  };
}

/** 播种合成身份与会话（用于 real / 注入实例；不经过微信换取，不产生任何外网调用）。 */
async function seedSession(authStore, label) {
  const user = await authStore.createUser(`${label}-${randomUUID().replace(/-/g, '')}`);
  const token = mintOpaqueToken();
  await authStore.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    audience: 'user',
  });
  return { token, userId: user.id };
}

const REAL_ENV = {
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

// ---------------------------------------------------------------- 真实装配（stub 模式）
const stubAuthStore = createMemoryAuthStore();
const stubApp = buildApp({
  config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
  store: stubAuthStore,
});
const stubOrigin = await stubApp.listen({ host: '127.0.0.1', port: 0 });
const stubHttp = makeHttp(stubOrigin);
const speech = stubApp.speechService;
const calls = () => speech.describe().providerCalls;
observations.push('loopback origin=' + stubOrigin);

try {
  // —— 合成身份（替身登录，非真实微信） ——
  const login = async (code) => {
    const res = await stubHttp(`${API}/auth/wechat`, {
      method: 'POST', headers: { 'idempotency-key': 'speech-http-login-' + code }, body: { code },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data.access_token;
  };
  const tokenA = await login('speech-http-synthetic-a');
  const tokenB = await login('speech-http-synthetic-b');
  assert.equal(typeof tokenA, 'string');
  assert.equal(typeof tokenB, 'string');

  // 创建并等待落定：用服务实例的 `settle()` 确定性等待（不依赖轮询 job；
  // GY-I01 收敛后 `/jobs/{id}` 亦已能读到转写作业，见 [11]）。
  async function createAndSettle(mediaId, token = tokenA) {
    const created = await stubHttp(PATH, {
      method: 'POST', token,
      headers: { 'idempotency-key': newKey('create') },
      body: { media_id: mediaId, media_revision: 1 },
    });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    await speech.settle();
    return created;
  }
  const transcriptionIdOf = (created) => created.body.data.target_ref.id;

  await group('[1] POST 202 + JobEnvelope 形状与头部（ETag/Cache-Control/meta，additionalProperties:false）', async () => {
    const created = await createAndSettle(MEDIA.normal);
    assert.equal(created.etag, '"1"');
    assert.equal(created.cache, 'no-store');
    assert.deepEqual(Object.keys(created.body).sort(), ['data', 'meta']);
    const { data, meta } = created.body;
    assert.equal(data.kind, 'transcription');
    assert.equal(data.state, 'queued');
    assert.equal(data.result, null);
    assert.equal(data.revision, 1);
    assert.equal(data.error_code, null);
    assert.equal(data.target_ref.type, 'transcription');
    assert.match(data.target_ref.id, UUID_PATTERN);
    assert.match(meta.request_id, UUID_PATTERN);
    assert.equal(meta.contract_version, '1.0.0');
    assert.equal(meta.execution_mode, 'stub');
    assert.deepEqual(
      Object.keys(data).sort(),
      ['created_at', 'deadline_at', 'error_code', 'id', 'kind', 'result', 'revision', 'state', 'target_ref'],
    );
    observations.push('create job=' + data.id + ' transcription=' + data.target_ref.id);
  });

  let normalId = null;
  await group('[+] 正控制：经真实装配受理 → succeeded → GET 200 读到转写七字段', async () => {
    const created = await createAndSettle(MEDIA.normal);
    normalId = transcriptionIdOf(created);
    const got = await stubHttp(`${PATH}/${normalId}`, { token: tokenA });
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.equal(got.etag, '"1"');
    assert.equal(got.cache, 'no-store');
    const data = got.body.data;
    assert.equal(typeof data.raw_text, 'string');
    assert.equal(data.confirmed_text, null);
    assert.equal(data.confirmed_at, null);
    assert.equal(data.model_version, 'stub-v1');
    assert.ok(Array.isArray(data.uncertain_spans));
    assert.deepEqual(
      Object.keys(data).sort(),
      ['confirmed_at', 'confirmed_text', 'id', 'model_version', 'raw_text', 'revision', 'uncertain_spans'],
    );
    observations.push('succeeded raw_text 长度=' + data.raw_text.length + ' spans=' + data.uncertain_spans.length + ' model_version=' + data.model_version);
  });

  await group('[2] 状态如实：queued(202) / succeeded(200) / uncertain·failed(无记录 ⇒ GET 404)，且每次受理恰好 1 次提供者调用', async () => {
    const before = calls();
    const silent = await createAndSettle(MEDIA.silent); // 桶 2：空转写 ⇒ uncertain
    assert.equal(calls() - before, 1, '每个被受理的任务应恰好触发 1 次提供者调用');
    const silentGet = await stubHttp(`${PATH}/${transcriptionIdOf(silent)}`, { token: tokenA });
    assert.equal(silentGet.status, 404);
    assert.equal(silentGet.body.error.code, 'NOT_FOUND');

    const tooLong = await createAndSettle(MEDIA.tooLong); // 桶 4：超长 ⇒ failed
    assert.equal((await stubHttp(`${PATH}/${transcriptionIdOf(tooLong)}`, { token: tokenA })).status, 404);

    const malformed = await createAndSettle(MEDIA.malformedSpan); // 桶 5：畸形区间 ⇒ failed
    assert.equal((await stubHttp(`${PATH}/${transcriptionIdOf(malformed)}`, { token: tokenA })).status, 404);

    observations.push('状态观测：queued=202；succeeded=200；uncertain/failed=无记录(404)');
  });

  await group('[3] 归属：他人 GET/DELETE/PATCH ⇒ 404，与「不存在」同形；无会话一律 401', async () => {
    const foreignGet = await stubHttp(`${PATH}/${normalId}`, { token: tokenB });
    const missingGet = await stubHttp(`${PATH}/${randomUUID()}`, { token: tokenB });
    assert.equal(foreignGet.status, 404);
    assert.equal(missingGet.status, 404);
    assert.deepEqual(foreignGet.body.error, missingGet.body.error);
    assert.deepEqual({ ...foreignGet.body.meta, request_id: 'x' }, { ...missingGet.body.meta, request_id: 'x' });

    const confirmBody = { confirmed_text: '他人试图确认', confirmation: 'checked_and_sendable' };
    const foreignDelete = await stubHttp(`${PATH}/${normalId}`, {
      method: 'DELETE', token: tokenB, headers: { 'if-match': '"1"', 'idempotency-key': newKey('fdel') },
    });
    const missingDelete = await stubHttp(`${PATH}/${randomUUID()}`, {
      method: 'DELETE', token: tokenB, headers: { 'if-match': '"1"', 'idempotency-key': newKey('mdel') },
    });
    assert.equal(foreignDelete.status, 404);
    assert.equal(missingDelete.status, 404);
    assert.deepEqual(foreignDelete.body.error, missingDelete.body.error);

    const foreignPatch = await stubHttp(`${PATH}/${normalId}/confirmation`, {
      method: 'PATCH', token: tokenB, headers: { 'if-match': '"1"', 'idempotency-key': newKey('fpatch') }, body: confirmBody,
    });
    const missingPatch = await stubHttp(`${PATH}/${randomUUID()}/confirmation`, {
      method: 'PATCH', token: tokenB, headers: { 'if-match': '"1"', 'idempotency-key': newKey('mpatch') }, body: confirmBody,
    });
    assert.equal(foreignPatch.status, 404);
    assert.equal(missingPatch.status, 404);
    assert.deepEqual(foreignPatch.body.error, missingPatch.body.error);

    const own = await stubHttp(`${PATH}/${normalId}`, { token: tokenA });
    assert.equal(own.status, 200);
    assert.equal(own.body.data.revision, 1);
    assert.equal(own.body.data.confirmed_text, null);

    for (const [method, path, options] of [
      ['POST', PATH, { body: { media_id: MEDIA.normal, media_revision: 1 }, headers: { 'idempotency-key': newKey('anon') } }],
      ['GET', `${PATH}/${normalId}`, {}],
      ['DELETE', `${PATH}/${normalId}`, { headers: { 'if-match': '"1"', 'idempotency-key': newKey('anon') } }],
      ['PATCH', `${PATH}/${normalId}/confirmation`, { headers: { 'if-match': '"1"', 'idempotency-key': newKey('anon') }, body: confirmBody }],
    ]) {
      const res = await stubHttp(path, { method, ...options });
      assert.equal(res.status, 401, `${method} 无会话应为 401`);
      assert.equal(res.body.error.code, 'SESSION_REQUIRED');
    }
  });

  await group('[4] If-Match：缺失 ⇒ 428 REVISION_REQUIRED；格式非法 ⇒ 400 INVALID_REQUEST；不匹配 ⇒ 409 REVISION_CONFLICT', async () => {
    const body = { confirmed_text: '核对文本', confirmation: 'checked_and_sendable' };
    const patch = (ifMatch) => stubHttp(`${PATH}/${normalId}/confirmation`, {
      method: 'PATCH', token: tokenA,
      headers: { ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }), 'idempotency-key': newKey('ifm') },
      body,
    });
    const del = (ifMatch) => stubHttp(`${PATH}/${normalId}`, {
      method: 'DELETE', token: tokenA,
      headers: { ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }), 'idempotency-key': newKey('ifd') },
    });

    const missing = await patch(undefined);
    assert.equal(missing.status, 428);
    assert.equal(missing.body.error.code, 'REVISION_REQUIRED');
    for (const malformed of ['1', '*', 'abc', '""', '"0"']) {
      const res = await patch(malformed);
      assert.equal(res.status, 400, `If-Match=${malformed} 应为 400`);
      assert.equal(res.body.error.code, 'INVALID_REQUEST');
    }
    const stale = await patch('"99"');
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'REVISION_CONFLICT');
    const after = await stubHttp(`${PATH}/${normalId}`, { token: tokenA });
    assert.equal(after.body.data.revision, 1);
    assert.equal(after.body.data.confirmed_text, null);
    assert.deepEqual(after.body.data.uncertain_spans, after.body.data.uncertain_spans);

    const delMissing = await del(undefined);
    assert.equal(delMissing.status, 428);
    assert.equal((await del('nope')).status, 400);
    const delStale = await del('"77"');
    assert.equal(delStale.status, 409);
    assert.equal(delStale.body.error.code, 'REVISION_CONFLICT');
  });

  await group('[5] 幂等：同键同体重放同一 job；同键异体 409；同键同体并发 3 ⇒ 恰好 1 任务 + 恰好 1 次提供者调用', async () => {
    const body = { media_id: MEDIA.confident, media_revision: 1 };
    const key = newKey('idem');
    const callsBefore = calls();
    const first = await stubHttp(PATH, { method: 'POST', token: tokenA, headers: { 'idempotency-key': key }, body });
    assert.equal(first.status, 202);
    await speech.settle();
    const replay = await stubHttp(PATH, { method: 'POST', token: tokenA, headers: { 'idempotency-key': key }, body });
    assert.equal(replay.status, 202);
    assert.equal(replay.body.data.id, first.body.data.id, '同键同体重放必须回到同一 job');
    assert.equal(replay.body.data.target_ref.id, first.body.data.target_ref.id);
    assert.equal(calls() - callsBefore, 1, '重放不得再次调用提供者');

    const sameKey = newKey('conflict');
    const accepted = await stubHttp(PATH, {
      method: 'POST', token: tokenA, headers: { 'idempotency-key': sameKey }, body: { media_id: MEDIA.normal, media_revision: 1 },
    });
    assert.equal(accepted.status, 202);
    const conflict = await stubHttp(PATH, {
      method: 'POST', token: tokenA, headers: { 'idempotency-key': sameKey }, body: { media_id: MEDIA.atLimit, media_revision: 1 },
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');

    const concurrentKey = newKey('concurrent');
    const concurrentBody = { media_id: MEDIA.confident, media_revision: 1 };
    const before = calls();
    const results = await Promise.all([1, 2, 3].map(() => stubHttp(PATH, {
      method: 'POST', token: tokenA, headers: { 'idempotency-key': concurrentKey }, body: concurrentBody,
    })));
    await speech.settle();
    for (const res of results) assert.equal(res.status, 202, JSON.stringify(res.body));
    const jobIds = [...new Set(results.map((r) => r.body.data.id))];
    const targetIds = [...new Set(results.map((r) => r.body.data.target_ref.id))];
    const callDelta = calls() - before;
    console.log(
      `[并发实测·真实装配 HTTP 同键同体 3 次] 不同 job id 数=${jobIds.length}、不同 target_ref.id 数=${targetIds.length}、提供者调用数=${callDelta}`,
    );
    assert.equal(jobIds.length, 1, '并发同键必须收敛到同一任务');
    assert.equal(targetIds.length, 1);
    assert.equal(callDelta, 1, `同键同体并发必须恰好 1 次提供者调用，实际 ${callDelta}`);
    observations.push('并发同键同体 3 次 ⇒ 1 个任务、1 次提供者调用');
  });

  await group('[6] 确认只写 confirmed_text/confirmed_at：raw_text 与 uncertain_spans 逐项不变，revision +1', async () => {
    const before = (await stubHttp(`${PATH}/${normalId}`, { token: tokenA })).body.data;
    const text = '用户核对后的文本（与模型原始输出不同，属人的判断）';
    const patched = await stubHttp(`${PATH}/${normalId}/confirmation`, {
      method: 'PATCH', token: tokenA,
      headers: { 'if-match': `"${before.revision}"`, 'idempotency-key': newKey('confirm') },
      body: { confirmed_text: text, confirmation: 'checked_and_sendable' },
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.etag, `"${before.revision + 1}"`);
    const data = patched.body.data;
    assert.equal(data.confirmed_text, text);
    assert.equal(typeof data.confirmed_at, 'string');
    assert.equal(Number.isNaN(Date.parse(data.confirmed_at)), false);
    assert.equal(data.revision, before.revision + 1);
    assert.equal(data.raw_text, before.raw_text, 'raw_text 绝不得被确认覆写');
    assert.deepEqual(data.uncertain_spans, before.uncertain_spans, 'uncertain_spans 不得被确认改动');
    const reread = (await stubHttp(`${PATH}/${normalId}`, { token: tokenA })).body.data;
    assert.equal(reread.raw_text, before.raw_text);
    assert.deepEqual(reread.uncertain_spans, before.uncertain_spans);
    assert.equal(reread.confirmed_text, text);
  });

  await group('[7] uncertain_spans 如实透传：100 条上限原样返回、0 条仍为 []（不删改、不补造、不排序）', async () => {
    const atLimit = await createAndSettle(MEDIA.atLimit);
    const got = await stubHttp(`${PATH}/${transcriptionIdOf(atLimit)}`, { token: tokenA });
    assert.equal(got.status, 200);
    assert.equal(got.body.data.uncertain_spans.length, 100);
    for (const span of got.body.data.uncertain_spans) {
      assert.equal(typeof span.start, 'number');
      assert.equal(typeof span.end, 'number');
      assert.ok(span.start < span.end);
      assert.equal(typeof span.reason, 'string');
    }
    const confident = await createAndSettle(MEDIA.confident);
    const gotConfident = await stubHttp(`${PATH}/${transcriptionIdOf(confident)}`, { token: tokenA });
    assert.deepEqual(gotConfident.body.data.uncertain_spans, []);
  });

  await group('[8] raw_text > 8000 码点不静默截断：落 failed（无记录 ⇒ 404），受理响应本身仍是 202/queued', async () => {
    const created = await createAndSettle(MEDIA.tooLong);
    const got = await stubHttp(`${PATH}/${transcriptionIdOf(created)}`, { token: tokenA });
    assert.equal(got.status, 404, '超长必须 fail-closed，不得产出截断后的记录');
    assert.equal(created.body.data.state, 'queued');
  });

  await group('[10] 请求边界：缺/短幂等键、多余字段、非 uuid、revision 边界、未声明查询参数（limit）一律按契约拒绝', async () => {
    const post = (options) => stubHttp(PATH, { method: 'POST', token: tokenA, ...options });
    assert.equal((await post({ body: { media_id: MEDIA.normal, media_revision: 1 } })).body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
    assert.equal(
      (await post({ headers: { 'idempotency-key': 'short' }, body: { media_id: MEDIA.normal, media_revision: 1 } })).body.error.code,
      'IDEMPOTENCY_KEY_REQUIRED',
    );
    assert.equal(
      (await post({ headers: { 'idempotency-key': newKey('extra') }, body: { media_id: MEDIA.normal, media_revision: 1, language: 'zh-CN' } })).body.error.code,
      'INVALID_REQUEST',
    );
    assert.equal(
      (await post({ headers: { 'idempotency-key': newKey('uuid') }, body: { media_id: 'not-a-uuid', media_revision: 1 } })).body.error.code,
      'INVALID_REQUEST',
    );
    for (const revision of [0, -1, 1.5]) {
      const res = await post({ headers: { 'idempotency-key': newKey('rev') }, body: { media_id: randomUUID(), media_revision: revision } });
      assert.equal(res.status, 400, `media_revision=${revision}`);
      assert.equal(res.body.error.code, 'INVALID_REQUEST');
    }
    const limitGet = await stubHttp(`${PATH}/${normalId}?limit=5`, { token: tokenA });
    assert.equal(limitGet.status, 400);
    assert.equal(limitGet.body.error.code, 'INVALID_REQUEST');
    const noQueryPost = await post({ headers: { 'idempotency-key': newKey('ok') }, body: { media_id: MEDIA.normal, media_revision: 1 } });
    assert.equal(noQueryPost.status, 202, '无查询串的对照应正常受理');
    const limitPost = await stubHttp(`${PATH}?limit=5`, {
      method: 'POST', token: tokenA, headers: { 'idempotency-key': newKey('limit2') }, body: { media_id: MEDIA.normal, media_revision: 1 },
    });
    assert.equal(limitPost.status, 400);
    assert.equal(limitPost.body.error.code, 'INVALID_REQUEST');

    const confirm = (body) => stubHttp(`${PATH}/${normalId}/confirmation`, {
      method: 'PATCH', token: tokenA, headers: { 'if-match': '"2"', 'idempotency-key': newKey('conf') }, body,
    });
    assert.equal((await confirm({ confirmed_text: '文本', confirmation: 'ok' })).body.error.code, 'INVALID_REQUEST');
    assert.equal((await confirm({ confirmed_text: '文本', confirmation: 'checked_and_sendable', note: '多余' })).body.error.code, 'INVALID_REQUEST');
    assert.equal((await confirm({ confirmed_text: '', confirmation: 'checked_and_sendable' })).body.error.code, 'INVALID_REQUEST');
    assert.equal((await confirm({ confirmation: 'checked_and_sendable' })).body.error.code, 'INVALID_REQUEST');

    const unchanged = (await stubHttp(`${PATH}/${normalId}`, { token: tokenA })).body.data;
    assert.equal(unchanged.revision, 2);
  });

  await group('[11] 跨域作业面（GY-I01 收敛后）：转写 job 经共享 `GET /jobs/{id}` 可读（改前 404 → 改后 200）', async () => {
    const created = await createAndSettle(MEDIA.confident);
    const jobId = created.body.data.id;
    const probe = await stubHttp(`${API}/jobs/${jobId}`, { token: tokenA });
    assert.equal(probe.status, 200, JSON.stringify(probe.body));
    assert.equal(probe.body.data.id, jobId);
    assert.equal(probe.body.data.kind, 'transcription');
    if (probe.body.data.result !== null) assert.equal(probe.body.data.result.kind, 'transcription');
    assert.equal(probe.etag, `"${probe.body.data.revision}"`);
    console.log(`[跨域作业面] GET ${API}/jobs/{id}（转写 job）→ ${probe.status} state=${probe.body.data.state} kind=${probe.body.data.kind}（GY-I01 收敛前该 id 为 404）`);
    observations.push('转写 job 经共享 /jobs/{id} 可读（改前 404 → 改后 200）');
  });

  // ---------------------------------------------------------------- real 模式实例：默认关闭
  const realAuthStore = createMemoryAuthStore();
  const realApp = buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'real', LOG_LEVEL: 'silent', ...REAL_ENV }),
    store: realAuthStore,
  });
  const realOrigin = await realApp.listen({ host: '127.0.0.1', port: 0 });
  const realHttp = makeHttp(realOrigin);
  try {
    const { token: realToken } = await seedSession(realAuthStore, 'speech-http-real');
    await group('[9] real 缺凭据：受理前 503 PROVIDER_UNAVAILABLE、提供者调用 0 次、不回退替身（含结构性证据）', async () => {
      const described = realApp.speechService.describe();
      assert.equal(described.executionMode, 'real');
      assert.equal(described.providerAvailable, false);
      assert.equal(described.modelVersion, 'real-unconfigured');
      assert.notEqual(described.modelVersion, 'stub-v1', '不得静默回退替身');
      assert.equal(described.mediaPort, 'unwired');
      assert.equal(described.providerCalls, 0);

      const res = await realHttp(PATH, {
        method: 'POST', token: realToken, headers: { 'idempotency-key': newKey('real') }, body: { media_id: randomUUID(), media_revision: 1 },
      });
      assert.equal(res.status, 503, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'PROVIDER_UNAVAILABLE');
      // 新增（本文件此前**零** `retryable` 断言；OCR/ASR 两面都没有，正是跨域口径长期不一致的原因）：
      // 「真实 ASR 提供者未接线」需运维改配置（凭据/适配器），不是时间能解决的 ⇒ 不得声称"重试就会好"。
      assert.equal(
        res.body.error.retryable,
        false,
        'ASR 受理面：能力未接线 ⇒ retryable 必须为 false（口径原文见 services/api/src/errors.ts）',
      );
      assert.equal(res.body.meta.execution_mode, 'real');
      assert.equal(res.text.includes('stub'), false, '响应不得出现替身标识');
      assert.equal(realApp.speechService.describe().providerCalls, 0, '受理前 fail-closed 不得调用提供者');

      // 结构性证据（读源码文本，不靠行为推断）：
      const appText = readFileSync(new URL('services/api/src/app.ts', root), 'utf8');
      const providerText = readFileSync(new URL('services/api/src/speech/provider.ts', root), 'utf8');
      // 默认仍是零端口注入：注册行只出现 `guards` 槽位 + 四个**可选**注入值（不传即 undefined ⇒ 插件按模式自建），
      // 以及 GY-I27 接线单追加的**隐私域**授权中间件端口 `consent`（与提供者/存储/媒体端口无关）。
      // ⚠ 2026-10-16（GY-I10 作业读面接线片）**既有断言修复**：本断言在基线 `cf9c3c8` 上**本就失败**
      //   （实测原始输出见交接文档）——它写于该行还是简写 `{ guards, … }` 的时代，`guards` 无冒号故不被
      //   正则计入；此后该行改为 `guards: gatedGuards`（全局开关门），`guards` 才被计入。原意（"只允许
      //   这个槽位，不得塞入 provider/store/媒体/作业端口"）不变，故把必填的 `guards` 显式列入白名单。
      //   下方另补**值断言**：钉住该槽位装的确实是 `gatedGuards`（旗标门包装），防"键在值换"被漏过。
      const registrationLine = appText
        .split(/\r?\n/)
        .find((line) => line.includes('registerSpeechRoutes(app, config,'));
      assert.ok(registrationLine !== undefined, 'app.ts 必须有 registerSpeechRoutes 装配行');
      for (const required of [
        'guards',
        'store: speechStore',
        'provider: speechProvider',
        'media: speechMedia',
        'jobDeadlineMs: speechJobDeadlineMs',
      ]) {
        assert.ok(registrationLine.includes(required), `注册行必须仍传 ${required}`);
      }
      assert.ok(
        /consent: (consentGate|undefined)\b/.test(registrationLine),
        `注册行只允许追加隐私域 consent 端口，实际：${registrationLine.trim()}`,
      );
      assert.ok(
        /egress: (speechEgress|undefined)\b/.test(registrationLine),
        `注册行只允许追加隐私域 egress 端口（GY-I27 第二片），实际：${registrationLine.trim()}`,
      );
      const injectedKeys = [...registrationLine.matchAll(/([A-Za-z]+):/g)].map((match) => match[1]).sort();
      assert.deepEqual(
        injectedKeys,
        ['consent', 'egress', 'guards', 'jobDeadlineMs', 'media', 'provider', 'store'].sort(),
        `注册行不允许出现其它注入键：${injectedKeys.join(', ')}`,
      );
      // 值断言（键存在 ≠ 值正确）：`guards` 槽位必须装**旗标门包装后的** `gatedGuards`，
      // 不是裸 `guards`（`\b` 词边界：裸 `guards` 是 `gatedGuards` 的后缀，不能只做子串判断）。
      assert.equal(/\bguards: gatedGuards\b/.test(registrationLine), true, `注册行 guards 槽位必须装 gatedGuards（旗标门），实际：${registrationLine.trim()}`);
      assert.equal(
        /const gatedGuards = createFlagGatedGuards\(guards, featureFlagGate\);/.test(appText),
        true,
        'app.ts 必须有 gatedGuards 绑定（createFlagGatedGuards(guards, featureFlagGate)）',
      );
      // 装配路径对 speech/{store,provider,media} 的引用**只能是 import type**（运行时被类型擦除）。
      for (const mod of ['speech/store', 'speech/provider', 'speech/media']) {
        const refs = appText.split(/\r?\n/).filter((line) => line.includes(mod));
        assert.ok(refs.length > 0, `app.ts 应有 ${mod} 的类型引用`);
        for (const line of refs) {
          assert.ok(
            /^import type \{[^}]+\} from '\.\/speech\//.test(line.trim()),
            `app.ts 对 ${mod} 只能有 import type 引用（运行时擦除），实际：${line.trim()}`,
          );
        }
      }
      for (const network of ['fetch(', 'node:http', 'node:https', 'node:net']) {
        assert.equal(providerText.includes(network), false, `speech 提供者层不得含网络调用：${network}`);
      }
      const realSlice = providerText.slice(
        providerText.indexOf('export function createRealSpeechProvider'),
        providerText.indexOf('export function createSpeechProvider'),
      );
      assert.equal(realSlice.includes('createStubSpeechProvider'), false, 'real 分支不得回退替身');
      assert.equal(realSlice.includes('fetch('), false, 'real 分支不得发起网络请求');
      observations.push('default-off 结构性证据：注册行只传 guards + 可选注入值 + 隐私域 consent 端口（默认 undefined ⇒ 零端口注入）；provider.ts 无网络客户端；real 分支无替身回退');
    });
  } finally {
    await realApp.close();
  }

  // ---------------------------------------------------------------- 注入式实例（#87 形状）：
  // 用 app.ts 新增的 speechStore/speechProvider/speechMedia/speechJobDeadlineMs 在**真实装配**上
  // 构造出此前无法构造的终态（timed_out 等），并把终态读出来（经装饰的 `speechService.getJob`）。
  const injectedAuthStore = createMemoryAuthStore();
  const scriptedCalls = { count: 0 };
  const scriptedOutcomes = new Map(); // media_id → 结局
  const scriptedProvider = {
    executionMode: 'stub',
    modelVersion: 'stub-scripted-v1',
    note: '集成脚本注入的合成提供者（非真实 ASR；不构成任何准确率或转写质量证据）',
    available: true,
    unavailableReason: null,
    async transcribe({ mediaId }) {
      scriptedCalls.count += 1;
      const outcome = scriptedOutcomes.get(mediaId);
      assert.ok(outcome !== undefined, `注入提供者未登记该媒体：${mediaId}`);
      if (outcome.kind === 'never') return new Promise(() => {});
      return structuredClone(outcome);
    },
  };
  const scenario = {
    ok: mediaIdForBucket(0),
    hang: randomUUID(),
    uncertain: randomUUID(),
    quota: randomUUID(),
  };
  scriptedOutcomes.set(scenario.ok, { kind: 'completed', transcript: { text: '合成用例·注入提供者文本', uncertain_spans: [{ start: 0, end: 4, reason: '合成用例·前缀不确定' }] } });
  scriptedOutcomes.set(scenario.hang, { kind: 'never' });
  scriptedOutcomes.set(scenario.uncertain, { kind: 'uncertain', reason: '合成用例·有效语音不足' });
  scriptedOutcomes.set(scenario.quota, { kind: 'failed', code: 'PROVIDER_QUOTA_EXCEEDED' });

  const injectedApp = buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    store: injectedAuthStore,
    speechStore: createMemorySpeechStore(),
    speechProvider: scriptedProvider,
    speechMedia: createSubstituteMediaPort(),
    // 注入较短截止时间，使悬挂场景在毫秒级落 timed_out（服务层默认 30s）。
    speechJobDeadlineMs: 250,
  });
  const injectedOrigin = await injectedApp.listen({ host: '127.0.0.1', port: 0 });
  const injectedHttp = makeHttp(injectedOrigin);
  try {
    const { token: injectedToken, userId: injectedUserId } = await seedSession(injectedAuthStore, 'speech-http-injected');

    await group('[12] 真实装配上的终态（注入提供者 + 250ms 截止时间）：succeeded / timed_out / uncertain / failed', async () => {
      const create = async (mediaId) => {
        const res = await injectedHttp(PATH, {
          method: 'POST', token: injectedToken, headers: { 'idempotency-key': newKey('inj') }, body: { media_id: mediaId, media_revision: 1 },
        });
        assert.equal(res.status, 202, JSON.stringify(res.body));
        assert.equal(res.body.data.state, 'queued');
        await injectedApp.speechService.settle();
        return res.body.data;
      };
      const stateOf = async (jobId) => injectedApp.speechService.getJob({ userId: injectedUserId, jobId });
      const callsBefore = injectedApp.speechService.describe().providerCalls;

      // succeeded（对照）：GET 记录 200
      const okJob = await create(scenario.ok);
      const okState = await stateOf(okJob.id);
      assert.equal(okState.state, 'succeeded');
      assert.equal(okState.error_code, null);
      assert.notEqual(okState.result, null);
      assert.equal((await injectedHttp(`${PATH}/${okJob.target_ref.id}`, { token: injectedToken })).status, 200);

      // timed_out（悬挂提供者 + 注入的 250ms 截止时间）——**这是 2a 无法在真实装配上构造的那一类**
      const hangJob = await create(scenario.hang);
      const hangState = await stateOf(hangJob.id);
      assert.equal(hangState.state, 'timed_out', `悬挂提供者必须落 timed_out，实际 ${hangState.state}`);
      assert.equal(hangState.error_code, 'PROVIDER_TIMEOUT');
      assert.equal(hangState.result, null);
      assert.equal((await injectedHttp(`${PATH}/${hangJob.target_ref.id}`, { token: injectedToken })).status, 404, 'timed_out 不产生转写记录');

      // uncertain（提供者明确无法判定）
      const uncertainJob = await create(scenario.uncertain);
      const uncertainState = await stateOf(uncertainJob.id);
      assert.equal(uncertainState.state, 'uncertain');
      assert.equal(uncertainState.error_code, 'INPUT_UNCERTAIN');
      assert.equal((await injectedHttp(`${PATH}/${uncertainJob.target_ref.id}`, { token: injectedToken })).status, 404);

      // failed（提供者配额）
      const quotaJob = await create(scenario.quota);
      const quotaState = await stateOf(quotaJob.id);
      assert.equal(quotaState.state, 'failed');
      assert.equal(quotaState.error_code, 'PROVIDER_QUOTA_EXCEEDED');
      assert.equal((await injectedHttp(`${PATH}/${quotaJob.target_ref.id}`, { token: injectedToken })).status, 404);

      // 每个被受理的任务恰好 1 次提供者调用；注入提供者确实被使用（4 次）。
      assert.equal(injectedApp.speechService.describe().providerCalls - callsBefore, 4);
      assert.equal(scriptedCalls.count, 4);
      console.log(`[注入实例实测] succeeded/timed_out/uncertain/failed 终态齐备；提供者调用=${scriptedCalls.count}（每个受理任务恰好 1 次）`);
      observations.push('注入实例终态：succeeded / timed_out(PROVIDER_TIMEOUT) / uncertain(INPUT_UNCERTAIN) / failed(PROVIDER_QUOTA_EXCEEDED)');
    });

    await group('[13] 默认行为不变：不传 speech* 注入项时仍按 executionMode 自建（默认零端口注入）', async () => {
      const injected = injectedApp.speechService.describe();
      assert.equal(injected.modelVersion, 'stub-scripted-v1', '传入的注入项必须生效');
      assert.equal(injected.mediaPort, 'substitute');
      assert.equal(injected.storePersistent, false, '注入的内存 store 如实标注不持久');
      // 默认实例（本脚本 [1]–[11] 全部跑在它上面，未传任何 speech* 注入项）仍按模式自建：
      const byMode = stubApp.speechService.describe();
      assert.equal(byMode.executionMode, 'stub');
      assert.equal(byMode.modelVersion, 'stub-v1', '默认实例不得被注入影响');
      assert.notEqual(byMode.modelVersion, injected.modelVersion);
      assert.equal(byMode.mediaPort, 'substitute');
      assert.equal(byMode.storePersistent, false);
      assert.equal(typeof byMode.providerCalls, 'number');
      // real 默认实例（[9]）同样未传注入项 ⇒ 503 + 0 次调用，默认零端口注入在 real 下亦成立。
      observations.push(`默认实例 describe(): model=${byMode.modelVersion} media=${byMode.mediaPort}（与注入实例 ${injected.modelVersion} 可区分）`);
    });
  } finally {
    await injectedApp.close();
  }
} finally {
  await stubApp.close();
}

console.log(
  `PASS ${passed} loopback HTTP groups; real assembly via buildApp (app.ts 仅追加注入项，默认零端口注入); ` +
    'synthetic identity; stub provider (替身) / injected scripted provider / real fail-closed; loopback only, no supplier, no PG, no real ASR sample',
);
for (const line of observations) console.log('  - ' + line);
