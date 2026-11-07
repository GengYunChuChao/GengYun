// #29 AC-2「日志脱敏」的端到端负例，不是原语级证据的重复。
//
// 已有 `tests/privacy/redact.test.mjs` 证明 `redactForLog()` 这个纯函数会脱敏；
// 本文件证明的是**另一件事**：用 `buildApp` 起真实组合应用、挂真实内存日志流，
// 把带私有正文／图片／音频／精确坐标／凭据的请求真的打进来，然后扫描**这次运行产生的全部日志**。
//
// 为什么四个面都要单独一条 `test(...)`：日志是共享出口，任何一个面把请求载荷写进日志，
// 都会绕开“只在某个业务函数里脱敏”的局部保证。四个面各自留一条负例，才能单独看红点。
//
// 口径说明（不得误读）：
//   1. 本文件**不挂任何测试日志钩子**，扫描的是 `buildApp` 自己产生的日志；
//      如果将来业务把 `request.body` / 请求头 / 查询串写进日志，这里应当变红。
//   2. 媒体三面的契约 `MediaJobInput` 只接受 `media_id`（uuid）与 `media_revision`，
//      **没有**内联图片/音频字段。因此每个媒体面先发一条“哨兵体”请求（故意让 schema 400，
//      用于证明请求体原文不落日志），再发一条契约合法的请求（证明该面真的走到域内并产生日志）。
//      这不是把断言放宽：合法请求与哨兵请求的路径、方法、状态码都分别核对。
//   3. 问答面的 `POST /conversations` 只建会话，文字提问在 `POST /conversations/{id}/turns`；
//      本文件按契约先建会话再发文字轮次，并在 `POST /conversations` 上另发一条带哨兵的
//      非法体，覆盖“会话受理面也不会把正文/坐标/凭据写进日志”。
//   4. 全部身份、媒体 id、正文、坐标、令牌都是合成哨兵；不连 PG、不调真实模型、不联网。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createGuardConsentGate } from '../../services/api/src/privacy/egress.ts';
import { createConsentStore } from '../../packages/privacy/consent.mjs';
import { createPrivacyGuard } from '../../packages/privacy/guard.mjs';
import { createMemoryRecognitionStore } from '../../services/api/src/recognitions/store.ts';
import { createStubRecognitionProvider } from '../../services/api/src/recognitions/provider.ts';
import { createSubstituteMediaPort } from '../../services/api/src/recognitions/media.ts';
import { createAccountProvider, VERIFIED_RECIPIENT } from '../privacy/_fixtures.mjs';

const API = '/api/v1';
const START = Date.UTC(2026, 10, 7, 0, 0, 0);

// 20 个 base64 字符的合成片段：足够长，避免只断言 `data:` 前缀的弱判据。
const IMAGE_B64 = 'iVBORw0KGgoAAAANSUhEU';
const AUDIO_B64 = 'UklGRiQAAABXQVZFZm10';
const IMAGE_DATA_URI = `data:image/png;base64,${IMAGE_B64}`;
const AUDIO_DATA_URI = `data:audio/wav;base64,${AUDIO_B64}`;
const PRIVATE_TEXT = '私有正文哨兵-ZZ-7f3a';
const LAT = '12.34567';
const LNG = '89.01234';
const COORDINATES = `${LAT},${LNG}`;
const BEARER = 'Bearer sk-sentinel-9f3a2b';
const CREDENTIAL = 'sk-sentinel-9f3a2b';

const ALL_SENTINELS = [
  PRIVATE_TEXT,
  IMAGE_B64,
  AUDIO_B64,
  IMAGE_DATA_URI,
  AUDIO_DATA_URI,
  LAT,
  LNG,
  COORDINATES,
  CREDENTIAL,
  BEARER,
  'data:image/png',
  'data:audio/wav',
];

const MEDIA_ID = {
  recognition: '11111111-1111-4111-8111-111111111111',
  ocr: '22222222-2222-4222-8222-222222222222',
  speech: '33333333-3333-4333-8333-333333333333',
};

function memoryLog() {
  const chunks = [];
  return {
    chunks,
    stream: { write(chunk) { chunks.push(chunk); } },
    text() { return chunks.join(''); },
  };
}

function assertNoSentinel(text, label) {
  for (const sentinel of ALL_SENTINELS) {
    assert.equal(text.includes(sentinel), false, `${label} 出现哨兵原文：${sentinel}`);
  }
}

function assertLogged(logText, { path, method = 'POST', status }) {
  assert.ok(logText.length > 0, '正向对照失败：info 级日志流为空');
  assert.equal(logText.includes('"msg":"incoming request"'), true, `正向对照失败：缺 incoming request（${path}）`);
  assert.equal(logText.includes('"msg":"request completed"'), true, `正向对照失败：缺 request completed（${path}）`);
  assert.equal(logText.includes(`"url":"${path}"`), true, `正向对照失败：日志里没有路径 ${path}`);
  assert.equal(logText.includes(`"method":"${method}"`), true, `正向对照失败：日志里没有方法 ${method}`);
  assert.equal(logText.includes(`"statusCode":${status}`), true, `正向对照失败：日志里没有状态码 ${status}（${path}）`);
}

async function login(app, code) {
  const response = await app.inject({
    method: 'POST',
    url: `${API}/auth/wechat`,
    headers: { 'content-type': 'application/json', 'idempotency-key': `login-key-${code}` },
    payload: { code },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().data.access_token;
}

async function call(app, method, url, token, { payload, headers } = {}) {
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(headers ?? {}),
    },
  });
  let body = null;
  try { body = response.json(); } catch { body = null; }
  return { status: response.statusCode, body };
}

/**
 * 每个面一套独立 fixture：独立 auth store、独立 consent store、独立日志流、独立 app。
 * 这样任一面变红时，日志里不会混入其他面的请求，便于单独定位。
 */
async function makeFixture(t) {
  const authStore = createMemoryAuthStore();
  const consentStore = createConsentStore();
  const account = createAccountProvider();
  const log = memoryLog();
  const app = buildApp({
    config: loadConfig({
      APP_EXECUTION_MODE: 'stub',
      LOG_LEVEL: 'info',
      SESSION_SIGNING_KEY: 'synthetic-privacy-log-redaction-signing-key-0123456789',
    }),
    store: authStore,
    now: () => new Date(START),
    logStream: log.stream,
    privacyInjection: {
      consent: createGuardConsentGate(createPrivacyGuard({ account, consentStore })),
    },
    // 识别域显式用替身端口，避免环境变量意外把测试指向真实提供者。
    recognitionStore: createMemoryRecognitionStore(),
    recognitionProvider: createStubRecognitionProvider(),
    recognitionMedia: createSubstituteMediaPort(),
  });
  t.after(async () => {
    await app.close();
  });

  const token = await login(app, 'synthetic-privacy-log-redaction');
  const session = await authStore.findSession(hashToken(token), 'user');
  assert.ok(session !== null && session !== undefined, '前置：合成登录必须留下会话');
  // 媒体三面的真实必需用途集合：recording + media_processing + external_inference。
  // 问答面当前只要求会话（不挂 consent gate），因此这里不发明一个不存在的 `qa` 用途。
  for (const purpose of ['recording', 'media_processing', 'external_inference']) {
    await consentStore.grant({
      userId: session.userId,
      purpose,
      policyVersion: '1.0.0',
      recipientIds: [VERIFIED_RECIPIENT.id],
    });
  }
  return { app, log, token };
}

/** 媒体面：先发哨兵体（400），再发契约合法体（202）。 */
async function exerciseMediaFace(t, { path, mediaId, dataUri, keyPrefix }) {
  const { app, log, token } = await makeFixture(t);

  const probePayload = {
    media_id: dataUri,
    media_revision: 1,
    note: PRIVATE_TEXT,
    coordinates: COORDINATES,
    authorization: BEARER,
  };
  // 前置自检：哨兵必须真的在请求体里，避免“请求没带原文所以日志没泄漏”的空断言。
  assert.equal(JSON.stringify(probePayload).includes(dataUri), true, '前置：媒体 data URI 必须在哨兵体里');
  assert.equal(JSON.stringify(probePayload).includes(PRIVATE_TEXT), true, '前置：私有正文必须在哨兵体里');
  assert.equal(JSON.stringify(probePayload).includes(COORDINATES), true, '前置：坐标对必须在哨兵体里');
  assert.equal(JSON.stringify(probePayload).includes(BEARER), true, '前置：凭据必须在哨兵体里');

  const probe = await call(app, 'POST', path, token, {
    payload: probePayload,
    headers: { 'idempotency-key': `${keyPrefix}-probe-0001` },
  });
  assert.equal(probe.status, 400, `哨兵体应被 schema 拒绝，实得 ${probe.status}：${JSON.stringify(probe.body)}`);
  assert.equal(probe.body?.error?.code, 'INVALID_REQUEST');

  const privateProbe = `${dataUri} ${PRIVATE_TEXT} ${COORDINATES} ${BEARER}`;
  assert.equal(privateProbe.includes(dataUri), true);
  assert.equal(privateProbe.includes(PRIVATE_TEXT), true);
  const valid = await call(app, 'POST', path, token, {
    payload: { media_id: mediaId, media_revision: 1 },
    headers: {
      'idempotency-key': `${keyPrefix}-valid-0001`,
      // 合法请求本身也带一个合成泄漏探针头：如果将来日志开始记录请求头，这条 202 路径也必须变红。
      'x-gy-private-probe': privateProbe,
    },
  });
  assert.equal(valid.status, 202, `契约合法请求应走到域内，实得 ${valid.status}：${JSON.stringify(valid.body)}`);

  const text = log.text();
  assertLogged(text, { path, status: 400 });
  assertLogged(text, { path, status: 202 });
  assert.equal(text.includes('"remoteAddress":"127.0.0.1"'), true, '正向对照失败：请求日志缺 remoteAddress');
  assertNoSentinel(text, `${path} 的全部日志`);
  return { probe, valid, text };
}

test('日志载荷脱敏·受理面 1：POST /recognitions 的图片与私有正文不落日志', async t => {
  const { probe, valid } = await exerciseMediaFace(t, {
    path: `${API}/recognitions`,
    mediaId: MEDIA_ID.recognition,
    dataUri: IMAGE_DATA_URI,
    keyPrefix: 'privacy-log-recognition',
  });
  assert.equal(probe.status, 400, '哨兵体不得因为“没写日志”而被放过');
  assert.equal(valid.status, 202, '合法识别请求必须真的受理');
});

test('日志载荷脱敏·受理面 2：POST /ocr 的标签图与私有正文不落日志', async t => {
  const { probe, valid } = await exerciseMediaFace(t, {
    path: `${API}/ocr`,
    mediaId: MEDIA_ID.ocr,
    dataUri: IMAGE_DATA_URI,
    keyPrefix: 'privacy-log-ocr',
  });
  assert.equal(probe.status, 400, '哨兵体不得因为“没写日志”而被放过');
  assert.equal(valid.status, 202, '合法 OCR 请求必须真的受理');
});

test('日志载荷脱敏·受理面 3：POST /speech/transcriptions 的音频与私有正文不落日志', async t => {
  const { probe, valid } = await exerciseMediaFace(t, {
    path: `${API}/speech/transcriptions`,
    mediaId: MEDIA_ID.speech,
    dataUri: AUDIO_DATA_URI,
    keyPrefix: 'privacy-log-speech',
  });
  assert.equal(probe.status, 400, '哨兵体不得因为“没写日志”而被放过');
  assert.equal(valid.status, 202, '合法转写请求必须真的受理');
});

test('日志载荷脱敏·受理面 4：POST /conversations 的文字提问、坐标与凭据不落日志', async t => {
  const { app, log, token } = await makeFixture(t);

  // 4a. 会话受理面上的哨兵体：`POST /conversations` 契约只接受 conditions（additionalProperties:false），
  // 这里故意塞入文字/坐标/凭据，证明 400 路径也不会把原文写进日志。
  const probe = await call(app, 'POST', `${API}/conversations`, token, {
    payload: {
      conditions: { crop_id: 'rice', region_code: '330100' },
      text: `${PRIVATE_TEXT} 坐标 ${COORDINATES} 凭据 ${BEARER}`,
      latitude: Number(LAT),
      longitude: Number(LNG),
      authorization: BEARER,
    },
    headers: { 'idempotency-key': 'privacy-log-conversation-probe-0001' },
  });
  assert.equal(probe.status, 400, `哨兵体应被拒绝，实得 ${probe.status}：${JSON.stringify(probe.body)}`);
  assert.equal(probe.body?.error?.code, 'INVALID_REQUEST');

  // 4b. 契约合法路径：先建会话，再在轮次上发真实文字提问（文字提问的受理面是 turns，不是 createConversation）。
  const created = await call(app, 'POST', `${API}/conversations`, token, {
    payload: { conditions: { crop_id: 'rice', region_code: '330100' } },
    headers: { 'idempotency-key': 'privacy-log-conversation-create-0001' },
  });
  assert.equal(created.status, 201, `合法建会话应 201，实得 ${created.status}：${JSON.stringify(created.body)}`);
  const conversationId = created.body.data.id;
  assert.equal(typeof conversationId, 'string');

  const question = `${PRIVATE_TEXT} 坐标 ${COORDINATES} 凭据 ${BEARER}`;
  assert.equal(question.includes(PRIVATE_TEXT), true, '前置：私有正文必须在文字提问里');
  assert.equal(question.includes(COORDINATES), true, '前置：坐标对必须在文字提问里');
  assert.equal(question.includes(BEARER), true, '前置：凭据必须在文字提问里');
  const turn = await call(app, 'POST', `${API}/conversations/${conversationId}/turns`, token, {
    payload: { input_type: 'text', text: question },
    headers: {
      'idempotency-key': 'privacy-log-conversation-turn-0001',
      'if-match': '"1"',
    },
  });
  assert.equal(turn.status, 202, `合法文字轮次应 202，实得 ${turn.status}：${JSON.stringify(turn.body)}`);
  if (app.conversationService !== null) await app.conversationService.drain();

  const text = log.text();
  assertLogged(text, { path: `${API}/conversations`, status: 400 });
  assertLogged(text, { path: `${API}/conversations`, status: 201 });
  assertLogged(text, { path: `${API}/conversations/${conversationId}/turns`, status: 202 });
  assertNoSentinel(text, '问答受理面的全部日志');
});
