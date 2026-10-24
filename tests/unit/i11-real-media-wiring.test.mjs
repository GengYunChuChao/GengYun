/**
 * GY-I11 · **受理阶段真实媒体端口**接线回归（全离线：不打腾讯云、不打真实桶、不写台账）。
 *
 * 本片要关的卡点：`services/api/src/speech/media.ts` 的 `real` 分支此前恒为
 * `createUnwiredMediaPort()` ⇒ `POST /api/v1/speech/transcriptions` **恒 409 `OBJECT_UNAVAILABLE`**，
 * 转写任务根本建不出来（前置的供应商 503 之后那一步永远过不去）。
 *
 * 本文件钉住两件事，缺一即红：
 *  A. **反向（fail-closed 不许放宽）**：`real` 下没有「真实对象存储端口 + 已铸造的批准能力」时，
 *     媒体域路由仍整域 503，受理仍 409（ASR 凭据齐备、越过供应商闸门之后），且**零外呼**
 *     （绊线 fetch 一次都不触发；受理端口一次都不碰对象存储）。
 *  B. **正向（端口真的接上）**：`--approve-real-media-wiring` 等价装配（真实 S3 兼容端口 + 批准能力 +
 *     媒体域已打开）下，受理端口 `kind === 'real'` 并逐条校验归属/版本/状态/用途/对象键；
 *     「上传 → complete → 受理 → 转写」在同一装配里走通，ASR 请求体字节与上传字节逐字节相同。
 *
 * ⚠ 本文件的音频全部是**合成音频**（正弦 PCM 合成 WAV），转写文本是**合成占位串**，
 *    不构成任何准确率或转写质量证据；对象存储与 ASR 端点都由本文件的进程内替身承接，
 *    不发任何真实网络请求（真实桶/真实 ASR 的读数在证据页，不在此处）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { sha256Hex as mediaSha256Hex } from '../../packages/media/validate.mjs';
import { ERROR_CODES } from '../../services/api/src/contract.ts';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import {
  createS3CompatibleObjectStore,
  createSubstituteObjectStore,
  createUnwiredObjectStore,
} from '../../services/api/src/media/object-store.ts';
import { REAL_MEDIA_APPROVAL_REQUIRED_REASON } from '../../services/api/src/media/service.ts';
import { createMemoryMediaStore } from '../../services/api/src/media/store.ts';
import {
  MEDIA_REAL_WIRING_FLAG,
  mediaRealPortsAssemblyOptions,
  resolveMediaRealPorts,
} from '../../services/api/src/media/real-ports.ts';
import {
  SPEECH_MEDIA_REAL_REFUSALS,
  createSpeechMediaPort,
  createUnwiredMediaPort,
  speechMediaRealRefusal,
} from '../../services/api/src/speech/media.ts';
import { SPEECH_MEDIA_DOMAIN_NOT_ASSEMBLED } from '../../services/api/src/routes/speech.ts';

const REPO = new URL('../../', import.meta.url);
const readRepoText = (relative) => readFileSync(new URL(relative, REPO), 'utf8');

const OWNER_SUBJECT = 'ab'.repeat(32);
const OTHER_OWNER = 'user-someone-else-i11-real';
const MEDIA_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OBJECT_KEY = 'media-objects/synthetic-i11-real-media-0001';
const STORAGE_HOST = 'storage.example.test';
const STORAGE_BUCKET = 'gy-media';
const SYNTHETIC_REQUEST_ID = '01234567-89ab-cdef-0123-456789abcdef';
/** 合成占位转写（不是任何真人语音的识别结果）。 */
const SYNTHETIC_TEXT = '合成转写：稻田稗草三到五叶期。';

// ---------------------------------------------------------------- 合成夹具

/** `real` 模式必填项（全部合成占位；`DATABASE_URL` 指向永不可达的合成库，测试不连库）。 */
function realEnv(overrides = {}) {
  return {
    APP_EXECUTION_MODE: 'real',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://synthetic_local_only@127.0.0.1:5432/gengyun_synthetic_never_connected',
    SESSION_SIGNING_KEY: 'synthetic-not-a-real-signing-key',
    DELETION_LEDGER_KEY: 'synthetic-not-a-real-ledger-key',
    WECHAT_APP_ID: 'synthetic-not-a-real-appid',
    WECHAT_APP_SECRET: 'synthetic-not-a-real-appsecret',
    OBJECT_STORAGE_ENDPOINT: `https://${STORAGE_HOST}`,
    OBJECT_STORAGE_BUCKET: STORAGE_BUCKET,
    OBJECT_STORAGE_ACCESS_KEY: 'AKIDSYNTHETICONLYI11',
    OBJECT_STORAGE_SECRET_KEY: 'i11-synthetic-secret-do-not-log',
    OBJECT_STORAGE_REGION: 'ap-shanghai',
    OBJECT_STORAGE_FORCE_PATH_STYLE: 'true',
    MEDIA_ACCESS_GRANT_ORIGIN: 'https://media.example.test',
    MEDIA_OBJECT_REF_KEY: 'c'.repeat(64),
    ...overrides,
  };
}

/** ASR 专用子账号对（明显合成的占位值，不是任何真实密钥）。 */
const ASR_ENV = {
  TENCENTCLOUD_ASR_SECRET_ID: 'synthetic-asr-secret-id-i11-real',
  TENCENTCLOUD_ASR_SECRET_KEY: 'synthetic-asr-secret-key-i11-real',
};

/** 16kHz / 单声道 / 16bit PCM 的合成 WAV（440Hz 正弦，不是任何人声）。 */
function syntheticWav(seconds = 0.4) {
  const samples = Math.round(16000 * seconds);
  const dataLength = samples * 2;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataLength, 40);
  for (let index = 0; index < samples; index += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / 16000) * 4096), 44 + index * 2);
  }
  return new Uint8Array(buffer);
}

const WAV = syntheticWav(0.4);
const DECLARED_UPLOAD = {
  purpose: 'voice_question',
  mime: 'audio/wav',
  bytes: WAV.length,
  sha256: mediaSha256Hex(WAV),
  duration_ms: 400,
};

/** 媒体登记册行（默认「已就绪的 voice_question 录音」；overrides 制造各种不合格）。 */
function recordingRecord(bytes, overrides = {}) {
  const at = Date.parse('2026-10-25T00:00:00.000Z');
  return {
    id: MEDIA_ID,
    ownerId: 'owner-i11-real',
    revision: 1,
    purpose: 'voice_question',
    mime: 'audio/wav',
    bytes: bytes.length,
    duration_ms: null,
    sha256: mediaSha256Hex(bytes),
    state: 'ready',
    failure_code: null,
    rawRef: OBJECT_KEY,
    derivativeRef: null,
    createdAt: at,
    updatedAt: at,
    expiresAt: at + 3_600_000,
    ...overrides,
  };
}

/**
 * 进程内对象存储 + ASR 替身（**唯一**被换掉的 `globalThis.fetch`；不发任何真实请求）。
 *
 * 适配器在**构造期**捕获 `globalThis.fetch`，所以必须在 `buildApp` 之前装好。
 */
function installLoopbackCloud() {
  const original = globalThis.fetch;
  const objects = new Map();
  const asrCalls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === STORAGE_HOST) {
      const key = decodeURIComponent(url.pathname.replace(new RegExp(`^/${STORAGE_BUCKET}/`), ''));
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'PUT') {
        const body = init.body === undefined ? Buffer.alloc(0) : Buffer.from(init.body);
        objects.set(key, { bytes: body, contentType: String(init.headers?.['content-type'] ?? 'application/octet-stream') });
        return new Response(null, { status: 200 });
      }
      if (method === 'DELETE') {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      const stored = objects.get(key);
      if (stored === undefined) return new Response('missing', { status: 404 });
      return new Response(stored.bytes, { status: 200, headers: { 'content-type': stored.contentType } });
    }
    if (url.hostname === 'asr.tencentcloudapi.com') {
      asrCalls.push({
        body: JSON.parse(String(init.body ?? '{}')),
        method: init.method ?? null,
        redirect: init.redirect ?? null,
        hasSignature: typeof init.headers?.Authorization === 'string',
      });
      return new Response(
        JSON.stringify({ Response: { RequestId: SYNTHETIC_REQUEST_ID, Result: SYNTHETIC_TEXT, AudioDuration: 400 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`本测试不得发出任何其它外呼：${url.hostname}`);
  };
  return {
    objects,
    asrCalls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** 绊线 fetch：任何一次调用都算失败。 */
function installTripwire() {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    calls.push(String(typeof input === 'string' ? input : input.url));
    throw new Error(`绊线被触发：本断言不得发出任何请求（${calls[calls.length - 1]}）`);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** 自称 `persistent` 的内存 auth 存储（`real` 的会话闸门要求；见既有同类用例）。 */
function persistentAuthStore() {
  const memory = createMemoryAuthStore();
  const store = Object.create(memory);
  Object.defineProperty(store, 'persistent', { value: true, enumerable: true });
  return store;
}

async function authenticate(store, subject) {
  const user = await store.createUser(subject);
  const token = mintOpaqueToken();
  await store.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(Date.now() + 3_600_000),
    audience: 'user',
  });
  return { token, user };
}

async function call(app, method, url, token, { payload, headers } = {}) {
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...(headers ?? {}) },
  });
  let body = null;
  try { body = response.json(); } catch { body = null; }
  return { status: response.statusCode, body };
}

// ================================================================ A. 反向（不许放宽）

test('A·端口级反向：real 不给接线输入 ⇒ 仍 unwired、仍 OBJECT_UNAVAILABLE、note 逐字不变', async () => {
  // ① 本片之前的默认结局：零接线输入。
  const bare = createSpeechMediaPort('real');
  assert.equal(bare.kind, 'unwired');
  assert.equal(bare.note, createUnwiredMediaPort().note, '默认 real 装配的 note 必须与本片之前逐字一致');
  assert.ok(bare.note.includes('fail-closed'));
  assert.deepEqual(await bare.resolve({ ownerUserId: 'u', mediaId: MEDIA_ID, mediaRevision: 1 }), {
    ok: false,
    code: 'OBJECT_UNAVAILABLE',
  });

  // ② 四道门逐条缺一项都不得放行（顺序即 `speechMediaRealRefusal` 的固定顺序）。
  const registry = createMemoryMediaStore();
  const realStore = createS3CompatibleObjectStore(loadConfig(realEnv()).objectStorage);
  assert.equal(realStore.kind, 's3_compatible');
  assert.equal(realStore.externalRequestCount, 0, '构造真实适配器不得外呼');
  const cases = [
    ['零接线输入', undefined, 'object_store_not_wired'],
    ['对象存储端口缺失', { objectStore: null, mediaRecords: registry, mediaDomainRefusal: null }, 'object_store_not_wired'],
    ['替身端口冒充真实存储', { objectStore: createSubstituteObjectStore(), mediaRecords: registry, mediaDomainRefusal: null }, 'object_store_not_wired'],
    ['未接线端口', { objectStore: createUnwiredObjectStore(), mediaRecords: registry, mediaDomainRefusal: null }, 'object_store_not_wired'],
    [
      '真实端口，但媒体域仍关闭（缺批准能力）',
      { objectStore: realStore, mediaRecords: registry, mediaDomainRefusal: REAL_MEDIA_APPROVAL_REQUIRED_REASON },
      'media_domain_closed',
    ],
    ['真实端口 + 媒体域打开，但缺登记册', { objectStore: realStore, mediaRecords: null, mediaDomainRefusal: null }, 'media_registry_not_configured'],
  ];
  for (const [label, wiring, expect] of cases) {
    assert.equal(speechMediaRealRefusal(wiring), expect, label);
    const built = createSpeechMediaPort('real', wiring);
    assert.equal(built.kind, 'unwired', `${label}：必须仍 unwired`);
    assert.ok(built.note.includes('fail-closed'), `${label}：note 必须如实标注 fail-closed`);
    assert.deepEqual(
      await built.resolve({ ownerUserId: 'u', mediaId: MEDIA_ID, mediaRevision: 1 }),
      { ok: false, code: 'OBJECT_UNAVAILABLE' },
      `${label}：不得放行`,
    );
  }
  // 闭集与判据覆盖一致（扩张闭集必须同步补反例）。
  assert.deepEqual([...SPEECH_MEDIA_REAL_REFUSALS].sort(), [...new Set(cases.map(([, , expect]) => expect))].sort());
  for (const code of ['NOT_FOUND', 'REVISION_CONFLICT', 'OBJECT_UNAVAILABLE']) {
    assert.equal(ERROR_CODES.includes(code), true, `${code} 必须是契约既有错误码（不新造码）`);
  }
  assert.equal(realStore.externalRequestCount, 0, '受理端口一次都不得碰对象存储');

  // ③ 非 real 模式：替身（行为与之前逐字一致，且**不接受**接线输入）。
  const substituteNote = createSpeechMediaPort('stub').note;
  for (const mode of ['stub', 'preset_demo']) {
    const built = createSpeechMediaPort(mode, { objectStore: realStore, mediaRecords: registry, mediaDomainRefusal: null });
    assert.equal(built.kind, 'substitute', `${mode} 必须仍是替身（接线输入不参与该分支）`);
    assert.equal(built.note, substituteNote, `${mode} 的 note 必须与替身逐字一致`);
    assert.deepEqual(await built.resolve({ ownerUserId: 'u', mediaId: MEDIA_ID, mediaRevision: 2 }), { ok: true, revision: 2 });
  }
});

test('A·装配级反向：real（ASR 凭据齐备、无启动参数）⇒ 媒体域 503 + 受理 409 + 零外呼', async (t) => {
  const tripwire = installTripwire();
  const store = persistentAuthStore();
  const config = loadConfig({ ...realEnv(), ...ASR_ENV });
  t.after(() => tripwire.restore());
  assert.notEqual(config.aiProviders.asr, null, 'ASR 凭据齐备 ⇒ 越得过供应商闸门（否则读到的是 503 而非 409）');
  assert.notEqual(config.objectStorage, null, '对象存储四键齐备时 config.objectStorage 必须非 null');
  // 没有启动参数 ⇒ 解析器返回 null ⇒ 装配层不传任何媒体选项（与 main 逐字节一致）。
  assert.equal(resolveMediaRealPorts({ config, argv: ['node', 'server.ts'] }), null);

  const app = buildApp({ config, store });
  t.after(() => app.close());

  assert.equal(app.mediaObjectStore.kind, 'unwired', '零注入 + 真实配置仍必须是 unwired');
  assert.notEqual(app.mediaService.failClosedReason, null, '媒体域必须整域关闭');
  assert.equal(app.speechService.describe().mediaPort, 'unwired', '转写域受理端口必须仍未接线');

  const { token } = await authenticate(store, OWNER_SUBJECT);
  const mediaRoutes = [
    ['POST', '/api/v1/media/uploads', { payload: DECLARED_UPLOAD, headers: { 'idempotency-key': 'i11-real-rev-create' } }],
    [
      'POST',
      `/api/v1/media/uploads/${MEDIA_ID}/complete`,
      { payload: { sha256: DECLARED_UPLOAD.sha256, bytes: DECLARED_UPLOAD.bytes }, headers: { 'idempotency-key': 'i11-real-rev-complete', 'if-match': '"1"' } },
    ],
    ['GET', `/api/v1/media/${MEDIA_ID}`, {}],
    ['DELETE', `/api/v1/media/${MEDIA_ID}`, { headers: { 'idempotency-key': 'i11-real-rev-delete', 'if-match': '"1"' } }],
    ['POST', `/api/v1/media/${MEDIA_ID}/access`, { headers: { 'idempotency-key': 'i11-real-rev-access', 'if-match': '"1"' } }],
  ];
  for (const [method, url, options] of mediaRoutes) {
    const response = await call(app, method, url, token, options);
    assert.equal(response.status, 503, `${method} ${url} → ${response.status} ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(response.body.error.retryable, false);
    assert.equal(response.body.data, undefined, `${method} ${url} 不得带成功封套`);
  }

  // 受理：供应商可用 ⇒ 越过 503 闸门，落到媒体引用校验 ⇒ **409 OBJECT_UNAVAILABLE**。
  const accepted = await call(app, 'POST', '/api/v1/speech/transcriptions', token, {
    payload: { media_id: MEDIA_ID, media_revision: 1 },
    headers: { 'idempotency-key': 'i11-real-rev-transcribe' },
  });
  assert.equal(accepted.status, 409, JSON.stringify(accepted.body));
  assert.equal(accepted.body.error.code, 'OBJECT_UNAVAILABLE');
  assert.equal(accepted.body.data, undefined, '不得返回任何任务封套');
  assert.equal(app.speechService.describe().providerCalls, 0, '受理前拒绝不得调用提供者');

  // 零外呼：整轮没有发出任何请求（桶、ASR 都没有）。
  assert.deepEqual(tripwire.calls, [], '反向装配必须零外呼');
});

// ================================================================ B. 正向（端口真的接上）

test('B·端口矩阵：真实端口 + 媒体域打开 ⇒ kind=real，逐条校验归属/版本/状态/用途/对象键', async () => {
  const bytes = syntheticWav(0.2);
  const realStore = createS3CompatibleObjectStore(loadConfig(realEnv()).objectStorage);
  const makePort = (registry) =>
    createSpeechMediaPort('real', { objectStore: realStore, mediaRecords: registry, mediaDomainRefusal: null });

  // 正控制：一条合格的、已就绪的语音录音 ⇒ 放行，回的是登记册上的 revision。
  const okRegistry = createMemoryMediaStore();
  await okRegistry.createMedia(recordingRecord(bytes, { revision: 3 }));
  const ok = makePort(okRegistry);
  assert.equal(ok.kind, 'real');
  assert.ok(ok.note.includes('真实录音引用端口'));
  assert.deepEqual(await ok.resolve({ ownerUserId: 'owner-i11-real', mediaId: MEDIA_ID, mediaRevision: 3 }), {
    ok: true,
    revision: 3,
  });
  assert.deepEqual(await ok.resolve({ ownerUserId: 'owner-i11-real', mediaId: recordingRecord(bytes).id, mediaRevision: 3 }), {
    ok: true,
    revision: 3,
  });

  const cases = [
    ['行不存在', { empty: true }, 'NOT_FOUND'],
    ['越权（与不存在同形）', { record: { ownerId: OTHER_OWNER } }, 'NOT_FOUND'],
    ['版本已推进', { mediaRevision: 2 }, 'REVISION_CONFLICT'],
    ['未就绪（initiated）', { record: { state: 'initiated' } }, 'OBJECT_UNAVAILABLE'],
    ['用途不是音频（label_ocr 照片）', { record: { purpose: 'label_ocr' } }, 'OBJECT_UNAVAILABLE'],
    ['没有对象键（rawRef=null）', { record: { rawRef: null } }, 'OBJECT_UNAVAILABLE'],
    ['没有对象键（rawRef 空串）', { record: { rawRef: '' } }, 'OBJECT_UNAVAILABLE'],
  ];
  for (const [label, spec, expect] of cases) {
    const registry = createMemoryMediaStore();
    if (spec.empty !== true) await registry.createMedia(recordingRecord(bytes, spec.record ?? {}));
    assert.deepEqual(
      await makePort(registry).resolve({
        ownerUserId: 'owner-i11-real',
        mediaId: MEDIA_ID,
        mediaRevision: spec.mediaRevision ?? 1,
      }),
      { ok: false, code: expect },
      label,
    );
  }

  // 形状不合法（非整数/非正）：版本冲突，不信任上游。
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.deepEqual(
      await ok.resolve({ ownerUserId: 'owner-i11-real', mediaId: MEDIA_ID, mediaRevision: bad }),
      { ok: false, code: 'REVISION_CONFLICT' },
      `revision=${String(bad)}`,
    );
  }

  // 登记册抛错 ⇒ 保守拒绝（不泄露行是否存在、也不算「不存在」）。
  const throwing = {
    async getMedia() {
      throw Object.assign(new Error('registry unavailable'), { code: 'PROVIDER_UNAVAILABLE' });
    },
  };
  assert.deepEqual(await makePort(throwing).resolve({ ownerUserId: 'x', mediaId: MEDIA_ID, mediaRevision: 1 }), {
    ok: false,
    code: 'OBJECT_UNAVAILABLE',
  });
  assert.equal(realStore.externalRequestCount, 0, '受理端口不得发起任何对象存储请求（不取录音字节）');
});

test('B·产品装配：真实端口 + 批准能力 ⇒ 上传→complete→受理→转写 全链路走通，ASR 请求体字节逐字节相同', async (t) => {
  const cloud = installLoopbackCloud();
  const store = persistentAuthStore();
  const config = loadConfig({ ...realEnv(), ...ASR_ENV });
  const ports = resolveMediaRealPorts({ config, argv: ['node', 'server.ts', MEDIA_REAL_WIRING_FLAG] });
  assert.notEqual(ports, null, '给了启动参数就必须解析出真实端口');
  assert.deepEqual(Object.keys(mediaRealPortsAssemblyOptions(ports)).sort(), ['mediaObjectStore', 'realMediaApproval']);

  const app = buildApp({ config, store, ...mediaRealPortsAssemblyOptions(ports) });
  t.after(async () => {
    cloud.restore();
    await app.close();
  });

  assert.equal(app.mediaService.failClosedReason, null, '接线后媒体域不得再有 fail-closed 原因');
  assert.equal(app.speechService.describe().mediaPort, 'real', '接线后转写域受理端口必须是 real');
  assert.equal(app.speechService.describe().providerAvailable, true);

  const { token, user } = await authenticate(store, OWNER_SUBJECT);

  // ① createUpload（只做本地预签名）
  const created = await call(app, 'POST', '/api/v1/media/uploads', token, {
    payload: DECLARED_UPLOAD,
    headers: { 'idempotency-key': 'i11-real-fwd-create' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const mediaId = created.body.data.media.id;
  const uploadUrl = created.body.data.upload.url;
  assert.ok(uploadUrl.startsWith(`https://${STORAGE_HOST}/${STORAGE_BUCKET}/`), '上传句柄必须指向真实对象存储端点');
  assert.match(uploadUrl, /X-Amz-Signature=[0-9a-f]{64}/, '上传句柄必须是 SigV4 预签名 URL');

  // ② 客户端 PUT 字节（走适配器的预签名 URL；由进程内桶替身承接）
  const put = await globalThis.fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'audio/wav' }, body: WAV });
  assert.equal(put.status, 200);
  const keys = await app.mediaService.serverObjectKeys(mediaId);
  assert.ok(keys !== null && typeof keys.rawRef === 'string');
  assert.deepEqual([...cloud.objects.get(keys.rawRef).bytes], [...WAV], '落桶字节必须与上传字节逐字节一致');

  // ③ complete：服务端从桶取回字节并核 sha256 ⇒ ready（音频不产生衍生物）
  const completed = await call(app, 'POST', `/api/v1/media/uploads/${mediaId}/complete`, token, {
    payload: { sha256: DECLARED_UPLOAD.sha256, bytes: DECLARED_UPLOAD.bytes },
    headers: { 'idempotency-key': 'i11-real-fwd-complete', 'if-match': '"1"' },
  });
  assert.equal(completed.status, 202, JSON.stringify(completed.body));
  assert.equal(completed.body.data.state, 'ready');
  assert.equal(completed.body.data.duration_ms, 400, '音频时长按真实 WAV 头回填');
  const afterComplete = await app.mediaService.serverObjectKeys(mediaId);
  assert.equal(afterComplete.derivativeRef, null, '音频不产生衍生物');

  // ④ 受理：不再是 409
  const accepted = await call(app, 'POST', '/api/v1/speech/transcriptions', token, {
    payload: { media_id: mediaId, media_revision: completed.body.data.revision },
    headers: { 'idempotency-key': 'i11-real-fwd-transcribe' },
  });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  assert.equal(accepted.body.data.state, 'queued');
  assert.equal(accepted.body.data.result, null);
  const jobId = accepted.body.data.id;
  const transcriptionId = accepted.body.data.target_ref.id;

  // ⑤ 在途任务落定：真实适配器恰好发送一次，请求体字节与上传字节逐字节相同
  await app.speechService.settle();
  const settled = await app.speechService.getJob({ userId: user.id, jobId });
  assert.equal(settled.state, 'succeeded', JSON.stringify(settled));
  assert.equal(settled.error_code, null);
  const transcription = await call(app, 'GET', `/api/v1/speech/transcriptions/${transcriptionId}`, token, {});
  assert.equal(transcription.status, 200, JSON.stringify(transcription.body));
  assert.equal(transcription.body.data.raw_text, SYNTHETIC_TEXT, '转写正文原样来自供应商 Result');

  assert.equal(cloud.asrCalls.length, 1, '恰好发送一次');
  const asr = cloud.asrCalls[0];
  assert.equal(asr.method, 'POST');
  assert.equal(asr.redirect, 'manual');
  assert.equal(asr.hasSignature, true, '必须带 TC3 Authorization 头');
  assert.equal(asr.body.DataLen, WAV.length, 'DataLen 必须是真实字节数');
  assert.equal(
    Buffer.compare(Buffer.from(asr.body.Data, 'base64'), Buffer.from(WAV)),
    0,
    'ASR 请求体字节必须与上传到桶里的录音逐字节相同',
  );
  assert.equal(asr.body.VoiceFormat, 'wav');
  assert.equal(asr.body.EngSerViceType, '16k_zh');
  assert.equal(asr.body.SourceType, 1);
});

// ================================================================ C. 结构性自证

test('C·结构性：受理端口不读 ambient env / 不碰文件系统 / 不自己发包；批准来源只能是媒体域', () => {
  const source = readRepoText('services/api/src/speech/media.ts');
  // 去掉注释后再断言：注释里**必须**能写这些纪律，代码里一次都不许出现。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(code.includes('process.env'), false, '受理端口不得读 ambient env');
  assert.equal(code.includes('node:fs'), false, '受理端口不得碰文件系统');
  assert.equal(code.includes('fetch('), false, '受理端口本身不得发包');
  assert.equal(code.includes('createS3CompatibleObjectStore'), false, '受理端口不得自行构造真实适配器');

  // 批准来源唯一：路由层不得自行铸造批准能力，也不得读 env。
  const routeSource = readRepoText('services/api/src/routes/speech.ts');
  const routeCode = routeSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(routeCode.includes('approveRealMediaWiring'), false, '路由层不得自行铸造批准能力');
  assert.equal(routeCode.includes('process.env'), false, '路由层不得读 ambient env');
  assert.equal(routeCode.includes('failClosedReason'), true, '路由层必须沿用媒体域的构造期裁决');
  assert.ok(routeSource.includes('mediaDomainRefusal(app)'), '路由层必须把媒体域裁决传进受理端口');
  assert.ok(SPEECH_MEDIA_DOMAIN_NOT_ASSEMBLED.includes('未装配'), '拿不到裁决时必须按未装配处理');

  // 装配面不扩张：`app.ts` 的两处关键行逐字不变（既有判据钉住那 8 个注入键与 2 处端口转发）。
  const appSource = readRepoText('services/api/src/app.ts');
  assert.ok(
    appSource.includes('const speechAudioMedia = { objectStore: mediaObjectStore, mediaRecords: mediaStore };'),
    'app.ts 的端口转发行必须逐字不变',
  );
  assert.ok(appSource.includes('audioMedia: speechAudioMedia'), 'app.ts 的注入键必须逐字不变');
  assert.equal(appSource.includes('createSpeechMediaPort'), false, 'app.ts 不得新增对 speech/media 的运行时引用');
});
