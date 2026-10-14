// GY-I06（#6）私有媒体 · HTTP 上传面回归。
//
// 全部使用**合成身份**（微信登录替身 code）、**替身对象存储**与**合成媒体字节**
// （tests/media/_fixtures.mjs 构造），不含任何真实个人媒体、真实凭据、真实对象存储或供应商调用。
//
// 断言口径：逐条**独立反例**，先判 HTTP 状态再判契约错误码，并显式核对错误封套形状；
// 不做「只要不 500 就算过」的写法。EXIF 清除用「输入含 EXIF/GPS 标记、输出不含」双向断言。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createSubstituteObjectStore } from '../../services/api/src/media/object-store.ts';
import { sha256Hex } from '../../packages/media/validate.mjs';
import { jpegWithExif, pngPlain, wav61Seconds } from '../media/_fixtures.mjs';

const MIB = 1048576;
const KEY = (name) => `media-idem-${name}-0000`;

function makeApp(options = {}) {
  let nowMs = 1_700_000_000_000;
  const store = options.store ?? createSubstituteObjectStore();
  const app = buildApp({
    config: { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), executionMode: options.mode ?? 'stub' },
    mediaObjectStore: store,
    ...(options.contentSource === undefined ? {} : { mediaContentSource: options.contentSource }),
    ...(options.attachmentCounter === undefined ? {} : { mediaAttachmentCounter: options.attachmentCounter }),
    now: () => new Date(nowMs),
  });
  return { app, store, advance: (ms) => { nowMs += ms; } };
}

async function login(app, code) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/wechat',
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
  return {
    status: response.statusCode,
    body,
    raw: response.rawPayload,
    etag: response.headers.etag,
    cache: response.headers['cache-control'],
    contentType: response.headers['content-type'],
  };
}

/** 模拟「客户端凭上传句柄直传对象存储」（契约把上传句柄 URL 限定为 https，本地 loopback 不充当该数据面）。 */
async function clientUpload(app, mediaId, bytes) {
  const keys = app.mediaService.serverObjectKeys(mediaId);
  assert.ok(keys !== null && typeof keys.rawRef === 'string', '尚未签发上传对象键');
  await app.mediaObjectStore.putObject(keys.rawRef, bytes, 'application/octet-stream');
  return keys;
}

async function createUpload(app, token, input, key) {
  return call(app, 'POST', '/api/v1/media/uploads', token, {
    payload: input,
    headers: { 'idempotency-key': key },
  });
}

async function completeUpload(app, token, mediaId, input, key, ifMatch = '"1"') {
  return call(app, 'POST', `/api/v1/media/uploads/${mediaId}/complete`, token, {
    payload: input,
    headers: { 'idempotency-key': key, 'if-match': ifMatch },
  });
}

function declareFor(bytes, purpose, mime, extra = {}) {
  return { purpose, mime, bytes: bytes.length, sha256: sha256Hex(bytes), ...extra };
}

test('GY-I06 HTTP 上传面：契约形状、真实类型核验、限额、EXIF 清除与孤立对象回收', async (t) => {
  const { app, store } = makeApp();
  t.after(() => app.close());
  const token = await login(app, 'media-upload-owner');
  const jpeg = jpegWithExif();
  const jpegSha = sha256Hex(jpeg);
  const png = pngPlain();

  await t.test('未登录访问任一媒体路由 → 401 SESSION_REQUIRED', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const cases = [
      ['POST', '/api/v1/media/uploads', { payload: { purpose: 'label_ocr', mime: 'image/png', bytes: 10, sha256: jpegSha }, headers: { 'idempotency-key': KEY('anon') } }],
      ['POST', `/api/v1/media/uploads/${id}/complete`, { payload: { sha256: jpegSha, bytes: jpeg.length }, headers: { 'idempotency-key': KEY('anon'), 'if-match': '"1"' } }],
      ['GET', `/api/v1/media/${id}`, {}],
      ['DELETE', `/api/v1/media/${id}`, { headers: { 'idempotency-key': KEY('anon'), 'if-match': '"1"' } }],
      ['POST', `/api/v1/media/${id}/access`, { headers: { 'idempotency-key': KEY('anon'), 'if-match': '"1"' } }],
      // 请求体必须是**契约合法**形状：否则 HTTP 层 schema 会先于鉴权返回 400（本用例只验鉴权）。
      ['POST', '/api/v1/community/media-access', {
        payload: { content_ref: { type: 'post', id, revision: 1 }, media_ref: { media_id: id, media_revision: 1 }, slot: 'attachment', author_revision: null },
        headers: { 'idempotency-key': KEY('anon'), 'if-match': '"1"' },
      }],
      ['GET', `/api/v1/community/media/${id}/content`, { headers: { 'x-media-access-token': 'x' } }],
    ];
    for (const [method, url, options] of cases) {
      const response = await call(app, method, url, null, options);
      assert.equal(response.status, 401, `${method} ${url} → ${response.status}`);
      assert.equal(response.body.error.code, 'SESSION_REQUIRED', `${method} ${url}`);
    }
  });

  await t.test('createUpload 成功：201 UploadGrantEnvelope + 强 ETag + no-store + initiated/revision=1', async () => {
    const response = await createUpload(app, token, declareFor(jpeg, 'weed_recognition', 'image/jpeg'), KEY('create-ok'));
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.etag, '"1"');
    assert.equal(response.cache, 'no-store');
    assert.equal(response.body.meta.execution_mode, 'stub');
    assert.equal(response.body.meta.contract_version, '1.0.0');
    assert.deepEqual(Object.keys(response.body.data).sort(), ['media', 'upload']);
    assert.deepEqual(Object.keys(response.body.data.media).sort(), [
      'bytes', 'duration_ms', 'failure_code', 'id', 'mime', 'purpose', 'revision', 'sha256', 'state',
    ]);
    assert.equal(response.body.data.media.state, 'initiated');
    assert.equal(response.body.data.media.revision, 1);
    assert.equal(response.body.data.media.duration_ms, null);
    assert.equal(response.body.data.media.failure_code, null);
    // 上传句柄：契约 AccessGrant（https URL + 短效令牌**不入 URL**）。
    assert.match(response.body.data.upload.url, /^https:\/\//);
    assert.equal(response.body.data.upload.method, 'PUT');
    assert.ok(response.body.data.upload.access_token.length > 0);
    assert.ok(!response.body.data.upload.url.includes(response.body.data.upload.access_token), '访问令牌不得出现在 URL 中');
    // 公开投影不得外露对象引用/归属/桶路径。
    // 说明：**上传句柄 URL** 是 owner 自己的短效直传句柄，契约要求它是 https 的 PUT 地址，
    // 依 `packages/media/store.mjs` 的硬红线「object_ref 只出现在服务端记录与短效句柄中」属允许范围；
    // 但不透明引用**不得**出现在 `data.media` 投影里，且响应里不得出现归属/桶/密钥信息。
    const mediaProjection = JSON.stringify(response.body.data.media);
    for (const forbidden of ['rawRef', 'derivativeRef', 'obj_', 'ownerId', 'owner_id']) {
      assert.ok(!mediaProjection.includes(forbidden), `Media 投影泄露 ${forbidden}`);
    }
    const serialized = JSON.stringify(response.body);
    for (const forbidden of ['ownerId', 'owner_id', 'rawRef', 'derivativeRef', 'OBJECT_STORAGE', 'secretKey', 'accessKey']) {
      assert.ok(!serialized.includes(forbidden), `响应泄露 ${forbidden}`);
    }
  });

  await t.test('反例：body 多余字段 → 400 INVALID_REQUEST（additionalProperties:false）', async () => {
    const response = await createUpload(
      app,
      token,
      { ...declareFor(jpeg, 'weed_recognition', 'image/jpeg'), owner_id: 'attacker' },
      KEY('extra-field'),
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INVALID_REQUEST');
  });

  await t.test('反例：缺 / 过短 Idempotency-Key → 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
    const missing = await call(app, 'POST', '/api/v1/media/uploads', token, {
      payload: declareFor(jpeg, 'weed_recognition', 'image/jpeg'),
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
    const short = await createUpload(app, token, declareFor(jpeg, 'weed_recognition', 'image/jpeg'), 'short');
    assert.equal(short.status, 400);
    assert.equal(short.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  });

  await t.test('反例：空路径参数形状非法 → HTTP 层 400（存在性判定留给服务层 404）', async () => {
    const response = await call(app, 'GET', '/api/v1/media/not-a-uuid', token);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'INVALID_REQUEST');
  });

  await t.test('反例：用途与声明类型不符 → 415 MEDIA_TYPE_UNSUPPORTED（不是 400）', async () => {
    const response = await createUpload(app, token, declareFor(jpeg, 'voice_question', 'image/jpeg', { duration_ms: 1000 }), KEY('purpose-mime'));
    assert.equal(response.status, 415, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'MEDIA_TYPE_UNSUPPORTED');
  });

  await t.test('反例：超限（识别图 >2MiB / 帖图 >5MiB / 语音 >10MiB / 时长 >60s）→ 413 或 400', async () => {
    const recognition = await createUpload(
      app,
      token,
      { purpose: 'weed_recognition', mime: 'image/jpeg', bytes: 3 * MIB, sha256: jpegSha },
      KEY('too-big-recognition'),
    );
    assert.equal(recognition.status, 413, JSON.stringify(recognition.body));
    assert.equal(recognition.body.error.code, 'MEDIA_TOO_LARGE');

    const community = await createUpload(
      app,
      token,
      { purpose: 'community_image', mime: 'image/png', bytes: 6 * MIB, sha256: jpegSha },
      KEY('too-big-community'),
    );
    assert.equal(community.status, 413);
    assert.equal(community.body.error.code, 'MEDIA_TOO_LARGE');

    // 语音字节上限 = 全局上限（UploadInput.bytes.maximum = 10MiB）：超过由 HTTP 层 schema 拦下。
    const voiceBytes = await createUpload(
      app,
      token,
      { purpose: 'voice_question', mime: 'audio/wav', bytes: 10 * MIB + 1, duration_ms: 10_000, sha256: jpegSha },
      KEY('too-big-voice'),
    );
    assert.equal(voiceBytes.status, 400, JSON.stringify(voiceBytes.body));
    assert.equal(voiceBytes.body.error.code, 'INVALID_REQUEST');

    const voiceDuration = await createUpload(
      app,
      token,
      { purpose: 'voice_question', mime: 'audio/wav', bytes: 1024, duration_ms: 60_001, sha256: jpegSha },
      KEY('too-long-voice'),
    );
    assert.equal(voiceDuration.status, 400);
    assert.equal(voiceDuration.body.error.code, 'INVALID_REQUEST');

    // 语音缺 duration_ms → 400（契约只对音频要求该字段）。
    const voiceMissingDuration = await createUpload(
      app,
      token,
      { purpose: 'voice_question', mime: 'audio/wav', bytes: 1024, sha256: jpegSha },
      KEY('voice-no-duration'),
    );
    assert.equal(voiceMissingDuration.status, 400);
    assert.equal(voiceMissingDuration.body.error.code, 'INVALID_REQUEST');

    // 图片不接受 duration_ms。
    const imageWithDuration = await createUpload(
      app,
      token,
      { purpose: 'label_ocr', mime: 'image/png', bytes: 10, duration_ms: 1000, sha256: jpegSha },
      KEY('image-with-duration'),
    );
    assert.equal(imageWithDuration.status, 400);
    assert.equal(imageWithDuration.body.error.code, 'INVALID_REQUEST');
  });

  await t.test('社区每帖 ≤3 图：第 4 张 createUpload → 400（保守替身计数器，非静默放宽）', async () => {
    const replies = [];
    for (let index = 0; index < 3; index += 1) {
      replies.push(await createUpload(app, token, declareFor(png, 'community_image', 'image/png'), KEY(`post-slot-${index}`)));
    }
    for (const reply of replies) assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const fourth = await createUpload(app, token, declareFor(png, 'community_image', 'image/png'), KEY('post-slot-3'));
    assert.equal(fourth.status, 400, JSON.stringify(fourth.body));
    assert.equal(fourth.body.error.code, 'INVALID_REQUEST');
    assert.deepEqual(fourth.body.error.details[0], { field: '/purpose', code: 'post_image_limit' });
  });

  // ------------------------------------------------------------ completeUpload

  await t.test('completeUpload 成功：202 + ready/revision=2，且**输出不含 EXIF/GPS**（原始对象留私有参考）', async () => {
    const created = await createUpload(app, token, declareFor(jpeg, 'label_ocr', 'image/jpeg'), KEY('complete-ok'));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const mediaId = created.body.data.media.id;
    await clientUpload(app, mediaId, jpeg);

    const completed = await completeUpload(app, token, mediaId, { sha256: jpegSha, bytes: jpeg.length }, KEY('complete-ok-op'));
    assert.equal(completed.status, 202, JSON.stringify(completed.body));
    assert.equal(completed.etag, '"2"');
    assert.equal(completed.cache, 'no-store');
    assert.equal(completed.body.data.state, 'ready');
    assert.equal(completed.body.data.revision, 2);
    assert.equal(completed.body.data.failure_code, null);

    const keys = app.mediaService.serverObjectKeys(mediaId);
    assert.equal(typeof keys.derivativeRef, 'string', '图片必须生成去元数据衍生件');
    const derivative = await app.mediaObjectStore.getObject(keys.derivativeRef);
    assert.ok(derivative !== null);
    const input = Buffer.from(jpeg);
    const output = Buffer.from(derivative.bytes);
    // 双向断言：输入**含** EXIF/GPS 标记，输出**不含**。
    assert.ok(input.includes(Buffer.from('Exif')), '夹具本身必须带 EXIF');
    assert.ok(input.includes(Buffer.from('GPSDATA')), '夹具本身必须带 GPS 信息');
    assert.ok(!output.includes(Buffer.from('Exif')), '衍生件不得含 EXIF 标记');
    assert.ok(!output.includes(Buffer.from('GPSDATA')), '衍生件不得含 GPS 信息');
    assert.ok(!output.includes(Buffer.from('GPS')), '衍生件不得含 GPS 标记');
    assert.equal(output[0], 0xff);
    assert.equal(output[1], 0xd8);
    assert.equal(output[output.length - 2], 0xff);
    assert.equal(output[output.length - 1], 0xd9);
    // 原始 + 衍生共 2 个对象。
    assert.equal(await app.mediaObjectStore.objectCount(), 2);
  });

  await t.test('反例：伪扩展名（声明 image/png、真实 JPEG）→ 415，且上传对象被回收', async () => {
    const before = await app.mediaObjectStore.objectCount();
    const created = await createUpload(app, token, declareFor(jpeg, 'label_ocr', 'image/png'), KEY('fake-ext'));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const mediaId = created.body.data.media.id;
    await clientUpload(app, mediaId, jpeg);
    const completed = await completeUpload(app, token, mediaId, { sha256: jpegSha, bytes: jpeg.length }, KEY('fake-ext-op'));
    assert.equal(completed.status, 415, JSON.stringify(completed.body));
    assert.equal(completed.body.error.code, 'MEDIA_TYPE_UNSUPPORTED');
    // 打开「先看错误码」：不得以 200/202 放行。
    const after = await call(app, 'GET', `/api/v1/media/${mediaId}`, token);
    assert.equal(after.body.data.state, 'rejected');
    assert.equal(after.body.data.failure_code, 'validation_failed');
    assert.equal(await app.mediaObjectStore.objectCount(), before, '失败上传不得残留孤立对象');
  });

  await t.test('反例：无图像数据（仅 PNG 签名）→ 415，且上传对象被回收', async () => {
    const before = await app.mediaObjectStore.objectCount();
    const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const created = await createUpload(app, token, declareFor(sig, 'label_ocr', 'image/png'), KEY('sig-only'));
    const mediaId = created.body.data.media.id;
    await clientUpload(app, mediaId, sig);
    const completed = await completeUpload(app, token, mediaId, { sha256: sha256Hex(sig), bytes: sig.length }, KEY('sig-only-op'));
    assert.equal(completed.status, 415, JSON.stringify(completed.body));
    assert.equal(completed.body.error.code, 'MEDIA_TYPE_UNSUPPORTED');
    assert.equal(await app.mediaObjectStore.objectCount(), before);
  });

  await t.test('反例：实际字节与声明 hash 不符 → 400，且上传对象被回收', async () => {
    const before = await app.mediaObjectStore.objectCount();
    const created = await createUpload(app, token, declareFor(jpeg, 'label_ocr', 'image/jpeg'), KEY('hash-mismatch'));
    const mediaId = created.body.data.media.id;
    await clientUpload(app, mediaId, png);
    const completed = await completeUpload(app, token, mediaId, { sha256: jpegSha, bytes: jpeg.length }, KEY('hash-mismatch-op'));
    assert.equal(completed.status, 400, JSON.stringify(completed.body));
    assert.equal(completed.body.error.code, 'INVALID_REQUEST');
    assert.equal(await app.mediaObjectStore.objectCount(), before);
  });

  await t.test('反例：音频真实时长 >60s（声明 60s，真实 61s）→ 400，且上传对象被回收', async () => {
    const before = await app.mediaObjectStore.objectCount();
    const wav = wav61Seconds();
    const created = await createUpload(
      app,
      token,
      { purpose: 'voice_question', mime: 'audio/wav', bytes: wav.length, duration_ms: 60_000, sha256: sha256Hex(wav) },
      KEY('voice-real-61s'),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const mediaId = created.body.data.media.id;
    await clientUpload(app, mediaId, wav);
    const completed = await completeUpload(app, token, mediaId, { sha256: sha256Hex(wav), bytes: wav.length }, KEY('voice-real-61s-op'));
    assert.equal(completed.status, 400, JSON.stringify(completed.body));
    assert.equal(completed.body.error.code, 'INVALID_REQUEST');
    assert.equal(await app.mediaObjectStore.objectCount(), before);
  });

  await t.test('反例：If-Match 缺失 → 428；不匹配 → 409；格式非法 → 400（完成接口）', async () => {
    const created = await createUpload(app, token, declareFor(jpeg, 'label_ocr', 'image/jpeg'), KEY('ifmatch-bad'));
    const mediaId = created.body.data.media.id;
    await clientUpload(app, mediaId, jpeg);
    const body = { sha256: jpegSha, bytes: jpeg.length };

    const missing = await call(app, 'POST', `/api/v1/media/uploads/${mediaId}/complete`, token, {
      payload: body, headers: { 'idempotency-key': KEY('ifmatch-missing') },
    });
    assert.equal(missing.status, 428, JSON.stringify(missing.body));
    assert.equal(missing.body.error.code, 'REVISION_REQUIRED');

    const malformed = await call(app, 'POST', `/api/v1/media/uploads/${mediaId}/complete`, token, {
      payload: body, headers: { 'idempotency-key': KEY('ifmatch-malformed'), 'if-match': '1' },
    });
    assert.equal(malformed.status, 400, JSON.stringify(malformed.body));
    assert.equal(malformed.body.error.code, 'INVALID_REQUEST');

    const stale = await call(app, 'POST', `/api/v1/media/uploads/${mediaId}/complete`, token, {
      payload: body, headers: { 'idempotency-key': KEY('ifmatch-stale'), 'if-match': '"9"' },
    });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.error.code, 'REVISION_CONFLICT');

    // 原样重放（同键 + 原 If-Match）回放首次成功结果，而不是被自增后的 revision 判成 409。
    const ok = await completeUpload(app, token, mediaId, body, KEY('ifmatch-ok'));
    assert.equal(ok.status, 202, JSON.stringify(ok.body));
    const replay = await completeUpload(app, token, mediaId, body, KEY('ifmatch-ok'));
    assert.equal(replay.status, 202, JSON.stringify(replay.body));
    assert.equal(replay.body.data.revision, ok.body.data.revision);
    // 同键异体 → IDEMPOTENCY_CONFLICT。
    const conflict = await call(app, 'POST', `/api/v1/media/uploads/${mediaId}/complete`, token, {
      payload: { sha256: jpegSha, bytes: jpeg.length }, headers: { 'idempotency-key': KEY('ifmatch-ok'), 'if-match': '"2"' },
    });
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  });

  await t.test('反例：完成时对象尚未落盘 → 409 OBJECT_UNAVAILABLE（不伪造 ready）', async () => {
    const created = await createUpload(app, token, declareFor(jpeg, 'label_ocr', 'image/jpeg'), KEY('no-object'));
    const mediaId = created.body.data.media.id;
    const completed = await completeUpload(app, token, mediaId, { sha256: jpegSha, bytes: jpeg.length }, KEY('no-object-op'));
    assert.equal(completed.status, 409, JSON.stringify(completed.body));
    assert.equal(completed.body.error.code, 'OBJECT_UNAVAILABLE');
  });

  await t.test('取消（客户端放弃上传）：24h 后 expireInitiated 回收对象，不留孤立对象', async () => {
    const scoped = makeApp();
    try {
      const ownerToken = await login(scoped.app, 'media-cancel-owner');
      const created = await createUpload(scoped.app, ownerToken, declareFor(jpeg, 'label_ocr', 'image/jpeg'), KEY('cancel'));
      const mediaId = created.body.data.media.id;
      await clientUpload(scoped.app, mediaId, jpeg);
      assert.equal(await scoped.app.mediaObjectStore.objectCount(), 1);
      const early = await scoped.app.mediaService.expireInitiated();
      assert.equal(early.expired, 0, '未到期不得回收');
      scoped.advance(24 * 60 * 60 * 1000 + 1);
      const expired = await scoped.app.mediaService.expireInitiated();
      assert.equal(expired.expired, 1);
      assert.equal(await scoped.app.mediaObjectStore.objectCount(), 0, '过期记录的对象必须被回收');
      const after = await call(scoped.app, 'GET', `/api/v1/media/${mediaId}`, ownerToken);
      assert.equal(after.body.data.state, 'rejected');
      assert.equal(after.body.data.failure_code, 'expired');
    } finally {
      await scoped.app.close();
    }
  });

  await t.test('孤立对象清理：cleanupOrphans 回收 rejected/deleted 记录的对象', async () => {
    const scoped = makeApp();
    try {
      const ownerToken = await login(scoped.app, 'media-orphan-owner');
      const created = await createUpload(scoped.app, ownerToken, declareFor(jpeg, 'label_ocr', 'image/jpeg'), KEY('orphan'));
      const mediaId = created.body.data.media.id;
      await clientUpload(scoped.app, mediaId, jpeg);
      const completed = await completeUpload(scoped.app, ownerToken, mediaId, { sha256: jpegSha, bytes: jpeg.length }, KEY('orphan-op'));
      assert.equal(completed.status, 202, JSON.stringify(completed.body));
      assert.equal(await scoped.app.mediaObjectStore.objectCount(), 2);
      const deleted = await call(scoped.app, 'DELETE', `/api/v1/media/${mediaId}`, ownerToken, {
        headers: { 'idempotency-key': KEY('orphan-del'), 'if-match': '"2"' },
      });
      assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
      const stats = await scoped.app.mediaService.stats();
      assert.equal(stats.objectCount, 0, '删除后不得残留对象');
      const swept = await scoped.app.mediaService.cleanupOrphans();
      assert.equal(swept.removedObjects, 0, '删除已即时回收，清理任务不应重复计数');
      assert.equal(await scoped.app.mediaObjectStore.objectCount(), 0);
    } finally {
      await scoped.app.close();
    }
  });

  await t.test('并发同键：同键并发 createUpload 不得产生第二条媒体记录（409 REQUEST_IN_PROGRESS 或回放同一 id）', async () => {
    const scoped = makeApp();
    try {
      const ownerToken = await login(scoped.app, 'media-concurrent-upload');
      const key = KEY('concurrent-upload');
      const payload = declareFor(jpeg, 'label_ocr', 'image/jpeg');
      const before = (await scoped.app.mediaService.stats()).mediaCount;
      const [first, second] = await Promise.all([
        createUpload(scoped.app, ownerToken, payload, key),
        createUpload(scoped.app, ownerToken, payload, key),
      ]);
      const statuses = [first.status, second.status].sort((x, y) => x - y);
      if (statuses[0] === 201 && statuses[1] === 409) {
        const conflict = first.status === 409 ? first : second;
        assert.equal(conflict.body.error.code, 'REQUEST_IN_PROGRESS', JSON.stringify(conflict.body));
        assert.equal(conflict.body.error.retryable, true);
      } else {
        // 允许「第一个已完成、第二个按台账回放」：此时两者必须是**同一条**媒体记录。
        assert.deepEqual(statuses, [201, 201], JSON.stringify([first.body, second.body]));
        assert.equal(first.body.data.media.id, second.body.data.media.id, '同键同体必须收敛到同一媒体');
      }
      const after = (await scoped.app.mediaService.stats()).mediaCount;
      assert.equal(after - before, 1, '同键并发只能产生一条媒体记录');
      assert.equal(await scoped.app.mediaObjectStore.objectCount(), 0, '不得留下孤立对象');
    } finally {
      await scoped.app.close();
    }
  });

  await t.test('并发同键：同键并发 completeUpload 只自增一次、只落一个衍生件', async () => {
    const scoped = makeApp();
    try {
      const ownerToken = await login(scoped.app, 'media-concurrent-complete');
      const created = await createUpload(scoped.app, ownerToken, declareFor(jpeg, 'label_ocr', 'image/jpeg'), KEY('concurrent-complete-create'));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const mediaId = created.body.data.media.id;
      await clientUpload(scoped.app, mediaId, jpeg);
      const key = KEY('concurrent-complete');
      const [first, second] = await Promise.all([
        completeUpload(scoped.app, ownerToken, mediaId, { sha256: jpegSha, bytes: jpeg.length }, key),
        completeUpload(scoped.app, ownerToken, mediaId, { sha256: jpegSha, bytes: jpeg.length }, key),
      ]);
      const statuses = [first.status, second.status].sort((x, y) => x - y);
      if (statuses[0] === 202 && statuses[1] === 409) {
        const conflict = first.status === 409 ? first : second;
        assert.equal(conflict.body.error.code, 'REQUEST_IN_PROGRESS', JSON.stringify(conflict.body));
      } else {
        assert.deepEqual(statuses, [202, 202], JSON.stringify([first.body, second.body]));
        assert.equal(first.body.data.revision, second.body.data.revision, '同键重放必须返回同一 revision');
      }
      const settled = await call(scoped.app, 'GET', `/api/v1/media/${mediaId}`, ownerToken);
      assert.equal(settled.body.data.state, 'ready');
      assert.equal(settled.body.data.revision, 2, '同键并发只允许自增一次');
      assert.equal(await scoped.app.mediaObjectStore.objectCount(), 2, '只允许一个原始件 + 一个衍生件');
    } finally {
      await scoped.app.close();
    }
  });

  await t.test('并发同键（服务层确定性）：第二个同键请求被 409 REQUEST_IN_PROGRESS 拒绝，只落一条记录', async () => {
    // `app.inject` 会串行化到「第二个请求看到台账后回放」，因此这里直接并发调用服务层，
    // 精确覆盖「占位未释放时第二个同键请求必须被拒绝」这条守卫（而不是只覆盖回放路径）。
    const scoped = makeApp();
    try {
      const actor = { ownerId: 'synthetic-concurrent-actor', authEpoch: 1, sessionRef: 'synthetic-session' };
      const input = declareFor(jpeg, 'label_ocr', 'image/jpeg');
      const settled = await Promise.allSettled([
        scoped.app.mediaService.initiateUpload({ actor, input, idempotencyKey: KEY('service-concurrent') }),
        scoped.app.mediaService.initiateUpload({ actor, input, idempotencyKey: KEY('service-concurrent') }),
      ]);
      const fulfilled = settled.filter((item) => item.status === 'fulfilled');
      const rejected = settled.filter((item) => item.status === 'rejected');
      assert.equal(fulfilled.length, 1, '只允许一个请求创建媒体');
      assert.equal(rejected.length, 1, '并发同键的第二个请求必须被明确拒绝（不得静默创建第二条）');
      assert.equal(rejected[0].reason.code, 'REQUEST_IN_PROGRESS');
      assert.equal(rejected[0].reason.status, 409);
      assert.equal(rejected[0].reason.retryable, true);
      assert.equal((await scoped.app.mediaService.stats()).mediaCount, 1);
      assert.equal(await scoped.app.mediaObjectStore.objectCount(), 0, '不得留下孤立对象');
    } finally {
      await scoped.app.close();
    }
  });

  await t.test('替身对象存储如实标注：不发起外部请求，句柄指向保留域', async () => {
    assert.equal(store.kind, 'substitute');
    assert.equal(store.externalRequestCount, 0);
    assert.match(store.note, /替身/);
    const handle = await store.presignUpload({ key: 'obj_probe', contentType: 'image/jpeg', expiresInSeconds: 60 });
    assert.match(handle.url, /^https:\/\/substitute\.invalid\//);
  });
});
