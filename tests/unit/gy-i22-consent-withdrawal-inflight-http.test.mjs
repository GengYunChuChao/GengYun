/**
 * GY-I22（issue #22）· **授权撤回 / 在途外发**失败回归 —— 在**真实组合应用**（`buildApp`）的
 * 4 个真实 AI 受理入口上验证。
 *
 * ## 本文件补的空白（为什么不是既有用例的重复）
 * `tests/unit/privacy-egress-http.test.mjs` 自己起的是**最小合成 Fastify 实例**（`/synthetic/egress`），
 * 它的文件头就写明"不改任何既有路由/装配文件：自己起一个最小 Fastify 实例，把
 * `createConsentPreHandler` / `createPrivacyEgress` 按装配说明挂上去验证"。
 * ⇒ 因此「`app.ts` 把授权中间件挂到 **4 个真实 AI 受理面**、且每个面按自己的
 * `dataType` 声明必需用途集合」这条**跨模块装配事实**在真实组合应用上**此前没有任何用例覆盖**：
 * 任何一面漏挂 `consent`、或挂错 `dataType`、或把授权判定挪到会话判定之前，既有用例都不会变红。
 * `tests/privacy/in-flight.test.mjs`（13 条）与 `tests/privacy/ledger.test.mjs`（65 条）覆盖的是
 * **协议层**的在途回写阻断；本文件只在**组合应用层**补齐"装配是否真的接上"，不重复协议层结论。
 *
 * ## 覆盖
 *   1. 未授权 ⇒ 4 个真实受理面**一致** 403 `CONSENT_REQUIRED`，错误封套逐字节同形；
 *   2. 部分授权 ⇒ 按各面 `dataType` 的**必需用途集合**逐面精确判定（合成只需 external_inference）；
 *   3. 授权齐全 ⇒ 4 个面都放行到业务处理（正控制，排除整列 403 空转）；
 *   4. **在途撤回** ⇒ 同一次请求在撤回后立即被拒（调用时重查，不缓存），
 *      且**不**把"取回并删除自己的数据"（GET/DELETE 不挂授权）也一并关掉；
 *   5. **账号在途变化**（隐私侧账号权威：停用/待删除、auth_epoch 前进）⇒ 4 面一致 403 `ACCOUNT_INACTIVE`；
 *   6. **口径不得放宽**：游客/伪造令牌在受理面仍是 401（鉴权在授权之前，不泄露授权状态）；
 *   7. `real` 未接真实依赖 ⇒ 4 面一致 503 `PROVIDER_UNAVAILABLE`(retryable)、**零外发**
 *      （注入计数提供者证明业务提供者**一次都没被调用**）、无成功封套。
 *
 * 授权中间件与用途存储用的是**已合并的真实实现**（`packages/privacy/guard.mjs` 的
 * `createPrivacyGuard` + `consent.mjs` 的 `createConsentStore`），经 `createGuardConsentGate`
 * 注入 `buildApp` 的 `privacyInjection.consent` —— 即装配方真实的接线方式。
 *
 * 声明（不得误读）：账号、正文、媒体 id、开关都是**合成夹具**；零真实供应商调用；
 * 本文件不改任何实现文件、不修改任何既有断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createGuardConsentGate } from '../../services/api/src/privacy/egress.ts';
import { createConsentStore } from '../../packages/privacy/consent.mjs';
import { createPrivacyGuard } from '../../packages/privacy/guard.mjs';
import { createAccountProvider } from '../privacy/_fixtures.mjs';

const API = '/api/v1';
const START = Date.UTC(2026, 9, 26, 4, 0, 0);
const ABSENT_UUID = '00000000-0000-4000-8000-000000000042';
const MEDIA_BODY = { media_id: '00000000-0000-4000-8000-000000000001', media_revision: 1 };
const SYNTHESIS_BODY = { checked_content_ref: { type: 'answer', id: 'synthetic-answer-1', revision: 1 }, locale: 'zh-CN' };

/** 与 `tests/unit/privacy-egress-http.test.mjs` 同形的**合成占位** real 环境（非真实凭据、不连接）。 */
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

/**
 * 4 个真实 AI 受理面 + 各自的资料类型。
 * `dataType: null` 表示该入口不声明资料类型（合成域只要求 `external_inference`）。
 */
const AI_FACES = Object.freeze([
  { label: '识别受理 POST /recognitions', path: `${API}/recognitions`, payload: MEDIA_BODY, dataType: 'weed_recognition' },
  { label: '图文受理 POST /ocr', path: `${API}/ocr`, payload: MEDIA_BODY, dataType: 'label_ocr' },
  { label: '转写受理 POST /speech/transcriptions', path: `${API}/speech/transcriptions`, payload: MEDIA_BODY, dataType: 'voice_question' },
  { label: '合成受理 POST /speech/synthesis', path: `${API}/speech/synthesis`, payload: SYNTHESIS_BODY, dataType: null },
]);

/** `packages/privacy/constants.mjs` 的必需用途集合（照抄声明，不在此重新定义语义）。 */
const REQUIRED_CONSENTS = Object.freeze({
  weed_recognition: ['media_processing', 'external_inference'],
  label_ocr: ['media_processing', 'external_inference'],
  voice_question: ['recording', 'media_processing', 'external_inference'],
});

async function makeFixture(t, options = {}) {
  const time = START;
  const auth = createMemoryAuthStore();
  const user = await auth.createUser('a'.repeat(64));
  const token = 'synthetic-gy-i22-consent-user-token';
  await auth.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(START + 48 * 3600_000),
    audience: 'user',
  });

  // 真实隐私侧权威（不走合成路由）：账号提供者 + 用途授权存储 + 授权守卫。
  const account = createAccountProvider({ [user.id]: { state: 'active', authEpoch: 1 } });
  const consentStore = createConsentStore();

  const config = {
    ...loadConfig(options.real === true ? { ...REAL_ENV } : { APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
  };
  const app = buildApp({
    config,
    store: auth,
    now: () => new Date(time),
    privacyInjection: { consent: createGuardConsentGate(createPrivacyGuard({ account, consentStore })) },
    ...(options.recognitionProvider === undefined ? {} : { recognitionProvider: options.recognitionProvider }),
    ...(options.speechProvider === undefined ? {} : { speechProvider: options.speechProvider }),
    ...(options.synthesisProvider === undefined ? {} : { synthesisProvider: options.synthesisProvider }),
  });
  t.after(() => app.close());

  async function grant(purpose) {
    await consentStore.grant({ userId: user.id, purpose, policyVersion: '1.0.0', recipientIds: [] });
  }
  return { app, auth, account, consentStore, user, token, grant, config };
}

async function post(app, face, token, keySeed) {
  const response = await app.inject({
    method: 'POST',
    url: face.path,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      'content-type': 'application/json',
      'idempotency-key': `gy-i22-consent-${keySeed}-0001`,
    },
    payload: face.payload,
  });
  let body = null;
  try {
    body = response.json();
  } catch {
    body = null;
  }
  return { status: response.statusCode, body };
}

/**
 * 第 5 个受控写面：`PATCH /recognitions/{id}/selection`。
 * `routes/recognitions.ts` 对它挂的是**同一个** `consentGate`（用途 `external_inference`、
 * 资料类型 `weed_recognition`）—— 但 4 面矩阵里没有它，故单独驱动。
 */
async function selection(app, token, recognitionId, { ifMatch = '"1"' } = {}) {
  const response = await app.inject({
    method: 'PATCH',
    url: `${API}/recognitions/${recognitionId}/selection`,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': 'gy-i22-consent-selection-0001',
      'if-match': ifMatch,
    },
    payload: { selected_species_id: 'synthetic-species-1' },
  });
  let body = null;
  try {
    body = response.json();
  } catch {
    body = null;
  }
  return { status: response.statusCode, body };
}

/** 逐字节同形指纹（排除逐次不同的 `meta.request_id`）。 */
function fingerprint(result) {
  assert.ok(result.body !== null, '响应必须是 JSON 错误封套');
  assert.equal(result.body.data, undefined, '错误响应不得携带成功封套');
  return JSON.stringify({
    error: result.body.error,
    contract_version: result.body.meta.contract_version,
    execution_mode: result.body.meta.execution_mode,
  });
}

/**
 * 逐面断言同样的状态码与错误码。
 *
 * `uniformEnvelope: true`（默认）额外要求**逐字节同形的封套** —— 这只对
 * **共享守卫**给出的回答成立（会话/授权/账号三类判定都出自 `auth/middleware.ts` 与
 * `privacy/egress.ts` 的同一段代码，因此 message/retryable/details 必须一模一样）。
 *
 * `uniformEnvelope: false` 用于**各域自己的提供者结论**（如 `PROVIDER_UNAVAILABLE`）：
 * 那种回答来自各域提供者，message 与 `retryable` 由各域语义决定（本文件只断言
 * **契约错误码与 HTTP 状态**一致，不假装它们逐字节同形）。
 */
async function expectUniform(app, faces, token, status, code, note, { uniformEnvelope = true } = {}) {
  const fingerprints = new Set();
  for (const [index, face] of faces.entries()) {
    const result = await post(app, face, token, index);
    assert.notEqual(
      result.body?.error?.message?.startsWith?.('未实现的路径') === true,
      true,
      `${face.label}：该面未注册，不属于"被授权中间件拒绝" —— ${note}`,
    );
    assert.equal(result.status, status, `${face.label}：期望 ${status}，实际 ${result.status} ${JSON.stringify(result.body)}`);
    assert.equal(result.body.error.code, code, `${face.label}：期望 ${code}，实际 ${result.body.error.code}`);
    assert.equal(result.body.data, undefined, `${face.label}：不得返回成功封套`);
    fingerprints.add(fingerprint(result));
  }
  if (uniformEnvelope) {
    assert.equal(
      fingerprints.size,
      1,
      `4 个真实受理面必须给出逐字节同形的错误封套；实际 ${fingerprints.size} 种：\n${[...fingerprints].join('\n')}`,
    );
  } else {
    assert.deepEqual(
      [...new Set([...fingerprints].map((json) => JSON.parse(json).error.code))],
      [code],
      `${note}：错误码必须一致`,
    );
  }
}

// ---------------------------------------------------------------------------
// 1. 未授权 ⇒ 4 面一致拒绝
// ---------------------------------------------------------------------------

test('跨模块·授权：未授予任何用途 ⇒ 4 个真实 AI 受理面一致 403 CONSENT_REQUIRED，且封套逐字节同形', async (t) => {
  const h = await makeFixture(t);
  await expectUniform(h.app, AI_FACES, h.token, 403, 'CONSENT_REQUIRED', '未授权');
});

// ---------------------------------------------------------------------------
// 2. 部分授权 ⇒ 按 dataType 的必需用途集合逐面精确判定
// ---------------------------------------------------------------------------

test('跨模块·授权：缺 media_processing ⇒ 三个媒体面都被拒，只要求 external_inference 的合成面放行（按 dataType 精确判定）', async (t) => {
  const h = await makeFixture(t);
  // 只给 external_inference 与 recording：媒体类资料类型还缺 media_processing。
  await h.grant('external_inference');
  await h.grant('recording');

  for (const [index, face] of AI_FACES.entries()) {
    const result = await post(h.app, face, h.token, index);
    if (face.dataType === null) {
      assert.notEqual(result.status, 401, `${face.label}：不要求 media_processing，不得 401`);
      assert.notEqual(result.status, 403, `${face.label}：不要求 media_processing，不得 403（${JSON.stringify(result.body)}）`);
    } else {
      assert.equal(result.status, 403, `${face.label}：缺 media_processing 必须 403（${JSON.stringify(result.body)}）`);
      assert.equal(result.body.error.code, 'CONSENT_REQUIRED', `${face.label}：缺的是 media_processing`);
      // 逐面核对"必需集合"与契约常量一致（不在此重新定义语义，只引用）。
      assert.ok(REQUIRED_CONSENTS[face.dataType].includes('media_processing'));
    }
  }
});

// ---------------------------------------------------------------------------
// 3. 正控制：授权齐全 ⇒ 4 面都到达业务处理
// ---------------------------------------------------------------------------

test('跨模块·正控制：用途齐全 ⇒ 4 个真实受理面都不被授权中间件拒绝（排除整列 403 空转）', async (t) => {
  const h = await makeFixture(t);
  for (const purpose of ['recording', 'media_processing', 'external_inference']) await h.grant(purpose);

  for (const [index, face] of AI_FACES.entries()) {
    const result = await post(h.app, face, h.token, index);
    assert.notEqual(result.status, 401, `${face.label}：授权齐全不得 401（${JSON.stringify(result.body)}）`);
    assert.notEqual(result.status, 403, `${face.label}：授权齐全不得 403（${JSON.stringify(result.body)}）`);
  }
});

// ---------------------------------------------------------------------------
// 4. 在途撤回：调用时重查、不缓存；且不误伤"取回自己的数据"
// ---------------------------------------------------------------------------

test('跨模块·在途撤回：撤回 external_inference 后 4 面立即一致 403 CONSENT_REQUIRED；读面不被一并关掉（GET 仍非 403）', async (t) => {
  const h = await makeFixture(t);
  for (const purpose of ['recording', 'media_processing', 'external_inference']) await h.grant(purpose);

  // 撤回前：受理面确实可用（正控制，排除"从来不可用"）。
  const before = await post(h.app, AI_FACES[0], h.token, 0);
  assert.notEqual(before.status, 403, JSON.stringify(before.body));
  assert.notEqual(before.status, 401, JSON.stringify(before.body));

  await h.consentStore.withdraw({ userId: h.user.id, purpose: 'external_inference' });

  // 撤回后：同一枚令牌、同一请求立即被拒（调用时重查，不是缓存判定）。
  await expectUniform(h.app, AI_FACES, h.token, 403, 'CONSENT_REQUIRED', '撤回 external_inference 后');

  // 撤回**不得**把"取回并删除自己的数据"也关掉：读取面不挂授权中间件 ⇒ 作业不存在是 404。
  const read = await h.app.inject({
    method: 'GET',
    url: `${API}/recognitions/${ABSENT_UUID}`,
    headers: { authorization: `Bearer ${h.token}` },
  });
  assert.equal(read.statusCode, 404, `读面不得因撤回变成 403（实际 ${read.statusCode} ${read.body}）`);
  assert.equal(read.json().error.code, 'NOT_FOUND');

  // 重新授权后恢复可用（撤回是判定，不是不可逆封禁）。
  await h.grant('external_inference');
  const after = await post(h.app, AI_FACES[0], h.token, 9);
  assert.notEqual(after.status, 403, JSON.stringify(after.body));
});

// ---------------------------------------------------------------------------
// 5. 账号在途变化（隐私侧账号权威）
// ---------------------------------------------------------------------------

test('跨模块·账号在途变化：隐私侧账号待删除/auth_epoch 前进 ⇒ 4 面一致 403 ACCOUNT_INACTIVE（不得只靠会话存储的旧结论放行）', async (t) => {
  const h = await makeFixture(t);
  for (const purpose of ['recording', 'media_processing', 'external_inference']) await h.grant(purpose);
  assert.notEqual((await post(h.app, AI_FACES[0], h.token, 0)).status, 403);

  // 待删除（注销中）：账号状态不再 active。
  h.account.set(h.user.id, { state: 'deletion_pending' });
  await expectUniform(h.app, AI_FACES, h.token, 403, 'ACCOUNT_INACTIVE', '账号待删除');

  // 停用 + 版本前进：状态与旧版本都要拦（两个判据都要生效）。
  h.account.set(h.user.id, { state: 'active', authEpoch: 2 });
  await expectUniform(h.app, AI_FACES, h.token, 403, 'ACCOUNT_INACTIVE', 'auth_epoch 前进（旧会话）');
});

// ---------------------------------------------------------------------------
// 6. 口径不得放宽：鉴权在授权之前
// ---------------------------------------------------------------------------

test('跨模块·口径：游客与伪造令牌在受理面一律 401（鉴权先于授权，开关/授权状态不泄露给未鉴权调用方）', async (t) => {
  const h = await makeFixture(t);
  // 即使用途齐全，未鉴权也必须是 401 而不是 403（不得把"缺会话"说成"缺授权"）。
  for (const purpose of ['recording', 'media_processing', 'external_inference']) await h.grant(purpose);
  await expectUniform(h.app, AI_FACES, null, 401, 'SESSION_REQUIRED', '游客');
  await expectUniform(h.app, AI_FACES, 'forged-not-a-real-token', 401, 'SESSION_EXPIRED', '伪造令牌');
});

// ---------------------------------------------------------------------------
// 8. 第 5 个受控写面：人工选择（AI 矩阵之外，但挂同一授权中间件）
// ---------------------------------------------------------------------------

test('跨模块·授权：第 5 个受控写面 PATCH /recognitions/{id}/selection 未授权 403 CONSENT_REQUIRED；授权齐全后到达归属判定（404 而非 403）', async (t) => {
  const h = await makeFixture(t);

  // 未授权：该写面必须先被授权中间件拦下（否则「先写派生内容」的口子就开了）。
  const denied = await selection(h.app, h.token, ABSENT_UUID);
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(denied.body.error.code, 'CONSENT_REQUIRED');
  assert.equal(denied.body.data, undefined);

  // 授权齐全后：授权不再拦，**归属/存在性**照旧生效 ⇒ 404（不是 403，也不是 200）。
  for (const purpose of ['recording', 'media_processing', 'external_inference']) await h.grant(purpose);
  const allowed = await selection(h.app, h.token, ABSENT_UUID);
  assert.equal(allowed.status, 404, `授权齐全后应到达归属判定（404），实际 ${allowed.status} ${allowed.body}`);
  assert.equal(allowed.body.error.code, 'NOT_FOUND');
  assert.equal(allowed.body.data, undefined);
});

// ---------------------------------------------------------------------------
// 9. real 未接真实依赖 ⇒ 零外发
// ---------------------------------------------------------------------------

test('跨模块·real 未接真实依赖：4 个真实受理面一致 503 PROVIDER_UNAVAILABLE(retryable)，且业务提供者零调用（零外发）', async (t) => {
  const calls = { recognize: 0, transcribe: 0, synthesize: 0 };
  const unavailable = (reason) => ({
    available: false,
    unavailableReason: reason,
    async recognize() {
      calls.recognize += 1;
      return { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' };
    },
    async transcribe() {
      calls.transcribe += 1;
      return { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' };
    },
    async synthesize() {
      calls.synthesize += 1;
      return { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' };
    },
  });
  const h = await makeFixture(t, {
    real: true,
    recognitionProvider: unavailable('合成：真实识别供应商未接入（fail-closed）'),
    speechProvider: unavailable('合成：真实 ASR 供应商未接入（fail-closed）'),
    synthesisProvider: unavailable('合成：真实 TTS 供应商未接入（fail-closed）'),
  });
  for (const purpose of ['recording', 'media_processing', 'external_inference']) await h.grant(purpose);

  await expectUniform(h.app, AI_FACES, h.token, 503, 'PROVIDER_UNAVAILABLE', 'real 未接真实依赖', {
    uniformEnvelope: false,
  });

  // 跨域观察（**口径已统一，此前不一致**）：同一个 `PROVIDER_UNAVAILABLE`（能力未接线造成的 503）
  // 在四个域上一律 `retryable === false`。统一前识别/合成标 `true`、OCR/ASR 标 `false`（本文件曾把
  // 那处不一致显式钉住并登记在证据页「发现与披露」）；现按 `services/api/src/errors.ts` 的口径原文收敛：
  // "能力未装配／未接线"需运维改配置、不是时间能解决的 ⇒ 不得声称"重试就会好"。
  // 这里把四个域**逐一**钉死（不是只看总数），使任何一域无声漂移都会立刻变红。
  const retryableByFace = {};
  for (const [index, face] of AI_FACES.entries()) {
    const result = await post(h.app, face, h.token, index);
    assert.equal(result.status, 503, `${face.label}：期望 503`);
    assert.equal(result.body.data, undefined, `${face.label}：不得返回成功封套`);
    assert.equal(typeof result.body.error.retryable, 'boolean', `${face.label}：retryable 必须是布尔`);
    assert.equal(
      result.body.error.retryable,
      false,
      `${face.label}：能力未接线 ⇒ retryable 必须为 false（同一请求重试不会成功）`,
    );
    retryableByFace[face.label] = result.body.error.retryable;
  }
  assert.deepEqual(
    retryableByFace,
    {
      '识别受理 POST /recognitions': false,
      '图文受理 POST /ocr': false,
      '转写受理 POST /speech/transcriptions': false,
      '合成受理 POST /speech/synthesis': false,
    },
    'PROVIDER_UNAVAILABLE（能力未接线）的 retryable 在四域必须一致为 false（口径原文见 services/api/src/errors.ts）',
  );
  // **零外发**：提供者（=真实供应商调用的唯一出口）一次都没有被调用。
  assert.deepEqual(calls, { recognize: 0, transcribe: 0, synthesize: 0 }, 'fail-closed 必须发生在任何供应商调用之前');

  // 撤回授权后仍是拒绝，且仍然是零外发（授权判定先于提供者；两条红线都不能被绕过）。
  await h.consentStore.withdraw({ userId: h.user.id, purpose: 'external_inference' });
  await expectUniform(h.app, AI_FACES, h.token, 403, 'CONSENT_REQUIRED', 'real + 撤回后');
  assert.deepEqual(calls, { recognize: 0, transcribe: 0, synthesize: 0 }, '撤回后同样零外发');
});
