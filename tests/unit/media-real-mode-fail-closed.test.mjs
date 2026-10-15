// GY-I06（#6）媒体域 · real 模式 fail-closed 反例 + 对象存储端口如实标注。
//
// 本文件是「若不修就会失败」的**负控制**：real 模式下真实对象存储未接线时，
// 媒体域必须整域 503 `PROVIDER_UNAVAILABLE`（`retryable: true`），**绝不**用内存/替身实现
// 返回成功封套。若把 `resolveMediaObjectStore('real')` 改回替身、或去掉
// `createAppMediaService` 的 `kind !== 's3_compatible'` 判据，本文件会立刻失败。
//
// 真实 S3/COS 适配器只被**构造**（构造不发起任何网络请求）与**预签名**（纯本地计算），
// 不发起任何真实对象存储调用；`externalRequestCount` 恒为 0 即其证据。
//
// 1-A（本片）接线：real 的对象存储判据从"一律未接线"改为"`OBJECT_STORAGE_*` 齐备才接真实适配器，
// 缺任一仍逐字保持 fail-closed"。**本文件与全仓测试/CI/dev 配置都不设置 `OBJECT_STORAGE_*`
// 环境变量**（那是对 ADR-001 门控动手）：下面的合成值只作为**参数**内联传给
// `resolveMediaObjectStore`，不写 `process.env`、不落盘、不连任何真实端点。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import {
  createS3CompatibleObjectStore,
  createSubstituteObjectStore,
  createUnwiredObjectStore,
  readObjectStorageConfig,
  resolveMediaObjectStore,
} from '../../services/api/src/media/object-store.ts';
import { sha256Hex } from '../../packages/media/validate.mjs';
import { jpegWithExif } from '../media/_fixtures.mjs';

const KEY = (name) => `media-real-${name}-0000`;
const MEDIA_ID = '55555555-5555-4555-8555-555555555555';
const jpeg = jpegWithExif();
const DECLARED = { purpose: 'label_ocr', mime: 'image/jpeg', bytes: jpeg.length, sha256: sha256Hex(jpeg) };

// 1-A 对象存储配置的**合成占位**（RFC2606 保留域 `.invalid`，不可解析 ⇒ 即便误调用也不可能外发）。
// 只作为参数内联使用：**不设置**任何 `process.env.OBJECT_STORAGE_*`（红线：ADR-001 门控）。
const SYNTHETIC_STORAGE_ENV = {
  OBJECT_STORAGE_ENDPOINT: 'https://synthetic-object-storage.invalid',
  OBJECT_STORAGE_BUCKET: 'synthetic-media-placeholder',
  OBJECT_STORAGE_ACCESS_KEY: 'synthetic-access-key-id',
  OBJECT_STORAGE_SECRET_KEY: 'synthetic-secret-key-value',
};
const REQUIRED_STORAGE_KEYS = [
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_BUCKET',
  'OBJECT_STORAGE_ACCESS_KEY',
  'OBJECT_STORAGE_SECRET_KEY',
];

function baseConfig() {
  return loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
}

/** real 模式下微信登录本身 fail-closed，这里直接注入合成会话（不代表真实登录已验收）。 */
async function synthesizeSession(store, token) {
  const user = await store.createUser('synthetic-subject-lookup-hex');
  await store.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    audience: 'user',
  });
  return token;
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

test('GY-I06 real 模式 + 未接真实对象存储：整域 503 PROVIDER_UNAVAILABLE（fail-closed 反例）', async (t) => {
  const store = createMemoryAuthStore();
  const app = buildApp({ config: { ...baseConfig(), executionMode: 'real' }, store });
  t.after(() => app.close());
  const token = await synthesizeSession(store, 'synthetic-real-media-session-01');

  // 判据：默认装配给 real 的就是未接线端口。
  assert.equal(app.mediaObjectStore.kind, 'unwired');
  assert.notEqual(app.mediaService.failClosedReason, null);

  const routes = [
    ['POST', '/api/v1/media/uploads', { payload: DECLARED, headers: { 'idempotency-key': KEY('real-create') } }],
    ['POST', `/api/v1/media/uploads/${MEDIA_ID}/complete`, { payload: { sha256: DECLARED.sha256, bytes: DECLARED.bytes }, headers: { 'idempotency-key': KEY('real-complete'), 'if-match': '"1"' } }],
    ['GET', `/api/v1/media/${MEDIA_ID}`, {}],
    ['DELETE', `/api/v1/media/${MEDIA_ID}`, { headers: { 'idempotency-key': KEY('real-delete'), 'if-match': '"1"' } }],
    ['POST', `/api/v1/media/${MEDIA_ID}/access`, { headers: { 'idempotency-key': KEY('real-access'), 'if-match': '"1"' } }],
    ['POST', '/api/v1/community/media-access', {
      payload: { content_ref: { type: 'post', id: MEDIA_ID, revision: 1 }, media_ref: { media_id: MEDIA_ID, media_revision: 1 }, slot: 'attachment', author_revision: null },
      headers: { 'idempotency-key': KEY('real-community'), 'if-match': '"1"' },
    }],
    ['GET', `/api/v1/community/media/${MEDIA_ID}/content`, { headers: { 'x-media-access-token': 'synthetic-token' } }],
  ];
  for (const [method, url, options] of routes) {
    const response = await call(app, method, url, token, options);
    assert.equal(response.status, 503, `${method} ${url} → ${response.status} ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error.code, 'PROVIDER_UNAVAILABLE', `${method} ${url}`);
    assert.equal(response.body.error.retryable, true, `${method} ${url} 必须标记可重试`);
    // 不得返回任何成功封套。
    assert.equal(response.body.data, undefined, `${method} ${url} 不得带 data`);
    assert.equal(response.body.meta.execution_mode, 'real');
  }
});

test('GY-I06 stub 对照：同一批路由在替身模式下可用（证明上面的 503 来自 fail-closed 而非路由缺失）', async (t) => {
  const store = createMemoryAuthStore();
  const app = buildApp({ config: baseConfig(), store, mediaObjectStore: createSubstituteObjectStore() });
  t.after(() => app.close());
  const token = await synthesizeSession(store, 'synthetic-stub-media-session-01');
  const created = await call(app, 'POST', '/api/v1/media/uploads', token, {
    payload: DECLARED,
    headers: { 'idempotency-key': KEY('stub-create') },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.media.state, 'initiated');
  assert.equal(app.mediaService.failClosedReason, null);
});

test('GY-I06 端口级 fail-closed：把未接线端口注入**非 real** 模式也一律 503（不只看模式开关）', async (t) => {
  const store = createMemoryAuthStore();
  const app = buildApp({
    config: baseConfig(),
    store,
    mediaObjectStore: createUnwiredObjectStore('测试注入的未接线端口'),
  });
  t.after(() => app.close());
  const token = await synthesizeSession(store, 'synthetic-unwired-port-01');
  const created = await call(app, 'POST', '/api/v1/media/uploads', token, {
    payload: DECLARED,
    headers: { 'idempotency-key': KEY('unwired-port') },
  });
  assert.equal(created.status, 503, JSON.stringify(created.body));
  assert.equal(created.body.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(created.body.error.retryable, true);
});

test('GY-I06 显式放行：注入真实适配器（仅构造 + 本地预签名，零网络）后 real 模式可用', async (t) => {
  const realStore = createS3CompatibleObjectStore({
    endpoint: 'https://cos.ap-shanghai.myqcloud.com',
    bucket: 'gengyun-media-placeholder',
    accessKey: 'synthetic-access-key-id',
    secretKey: 'synthetic-secret-key-value',
    region: 'ap-shanghai',
    forcePathStyle: false,
  });
  // 构造本身不得发起任何外部请求。
  assert.equal(realStore.externalRequestCount, 0);
  assert.match(realStore.note, /从未被实际调用/);

  const store = createMemoryAuthStore();
  const app = buildApp({
    config: { ...baseConfig(), executionMode: 'real' },
    store,
    mediaObjectStore: realStore,
  });
  t.after(() => app.close());
  const token = await synthesizeSession(store, 'synthetic-real-wired-01');

  // createUpload 只做本地预签名（不触碰桶），用于证明「显式放行」这条接线路径确实存在。
  const created = await call(app, 'POST', '/api/v1/media/uploads', token, {
    payload: DECLARED,
    headers: { 'idempotency-key': KEY('wired-create') },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.meta.execution_mode, 'real');
  const url = created.body.data.upload.url;
  assert.match(url, /^https:\/\/gengyun-media-placeholder\.cos\.ap-shanghai\.myqcloud\.com\//);
  assert.match(url, /X-Amz-Algorithm=AWS4-HMAC-SHA256/);
  assert.match(url, /X-Amz-Expires=86400/);
  assert.match(url, /X-Amz-Signature=[0-9a-f]{64}/);
  assert.ok(!url.includes('synthetic-secret-key-value'), '签名密钥绝不进 URL');
  // 关键：整轮没有发起过任何真实对象存储请求。
  assert.equal(realStore.externalRequestCount, 0, '本任务不授权任何真实对象存储调用');

  // 真实适配器不提供对象计数（需 list 权限，未接线）⇒ 如实拒绝，不伪造。
  await assert.rejects(() => realStore.objectCount(), (error) => error.code === 'PROVIDER_UNAVAILABLE');
});

test('GY-I06 对象存储端口：如实标注、构造校验与配置读取', async (t) => {
  // 替身与未接线端口的 kind/note 必须可区分，且都不发起外部请求。
  const substitute = createSubstituteObjectStore();
  assert.equal(substitute.kind, 'substitute');
  assert.equal(substitute.externalRequestCount, 0);
  assert.match(substitute.note, /替身/);
  assert.match(substitute.note, /substitute\.invalid/);

  const unwired = createUnwiredObjectStore();
  assert.equal(unwired.kind, 'unwired');
  assert.match(unwired.note, /fail-closed/);
  await assert.rejects(() => unwired.putObject('obj_x', new Uint8Array([1]), 'image/jpeg'), (error) => error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === true);
  await assert.rejects(() => unwired.objectCount(), (error) => error.code === 'PROVIDER_UNAVAILABLE');

  // 按执行模式解析：real + **缺任一** `OBJECT_STORAGE_*` ⇒ 未接线（fail-closed）；替身/演示才给替身。
  // （1-A 后 real 的判据是"对象存储配置是否齐备"，不再是"模式是否 real"；齐备路径见下一个用例。）
  assert.equal(resolveMediaObjectStore({ executionMode: 'real' }).kind, 'unwired');
  assert.equal(resolveMediaObjectStore({ executionMode: 'real', env: {} }).kind, 'unwired');
  assert.equal(resolveMediaObjectStore({ executionMode: 'stub' }).kind, 'substitute');
  assert.equal(resolveMediaObjectStore({ executionMode: 'preset_demo' }).kind, 'substitute');

  // 真实适配器构造校验：缺凭据 / 非 https 一律**抛错**，绝不退回替身。
  assert.throws(() => createS3CompatibleObjectStore({
    endpoint: 'https://cos.ap-shanghai.myqcloud.com', bucket: '', accessKey: 'k', secretKey: 's', region: 'ap-shanghai', forcePathStyle: false,
  }), /拒绝构造/);
  assert.throws(() => createS3CompatibleObjectStore({
    endpoint: 'http://cos.ap-shanghai.myqcloud.com', bucket: 'b', accessKey: 'k', secretKey: 's', region: 'ap-shanghai', forcePathStyle: false,
  }), /拒绝构造/);

  // 配置读取：缺失逐项列出（不回显任何凭据值）。
  const missing = readObjectStorageConfig({});
  assert.deepEqual(missing.config, null);
  assert.deepEqual(missing.issues.map((issue) => issue.field).sort(), [
    'OBJECT_STORAGE_ACCESS_KEY', 'OBJECT_STORAGE_BUCKET', 'OBJECT_STORAGE_ENDPOINT', 'OBJECT_STORAGE_SECRET_KEY',
  ]);
  const complete = readObjectStorageConfig({
    OBJECT_STORAGE_ENDPOINT: 'https://cos.ap-shanghai.myqcloud.com',
    OBJECT_STORAGE_BUCKET: 'b',
    OBJECT_STORAGE_ACCESS_KEY: 'k',
    OBJECT_STORAGE_SECRET_KEY: 's',
  });
  assert.equal(complete.issues.length, 0);
  assert.equal(complete.config.region, 'ap-shanghai');
  assert.equal(complete.config.forcePathStyle, false);
  const plaintext = readObjectStorageConfig({
    OBJECT_STORAGE_ENDPOINT: 'http://cos.ap-shanghai.myqcloud.com',
    OBJECT_STORAGE_BUCKET: 'b', OBJECT_STORAGE_ACCESS_KEY: 'k', OBJECT_STORAGE_SECRET_KEY: 's',
  });
  assert.equal(plaintext.config, null);
  assert.equal(plaintext.issues[0].field, 'OBJECT_STORAGE_ENDPOINT');
});

test('GY-I06 1-A 装配：real 缺任一 OBJECT_STORAGE_* ⇒ 仍 unwired（逐字 fail-closed）；齐备 ⇒ s3_compatible（零网络）', async () => {
  // 1) 缺 env（默认装配路径）⇒ 与接线前**逐字一致**：同一个 reason/note，且每个操作仍 503 retryable。
  const absent = resolveMediaObjectStore({ executionMode: 'real', env: {} });
  assert.equal(absent.kind, 'unwired');
  assert.equal(absent.note, createUnwiredObjectStore().note, '缺 env 的 reason/note 必须与接线前逐字一致');
  assert.equal(absent.externalRequestCount, 0);
  await assert.rejects(
    () => absent.putObject('obj_synthetic', new Uint8Array([1]), 'image/jpeg'),
    (error) => error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === true,
  );

  // 2) 缺**任一**必填键都不得放行（缺配置 ≠ 放行）；明文 http endpoint 同理。
  for (const missing of REQUIRED_STORAGE_KEYS) {
    const env = { ...SYNTHETIC_STORAGE_ENV };
    delete env[missing];
    const store = resolveMediaObjectStore({ executionMode: 'real', env });
    assert.equal(store.kind, 'unwired', `缺 ${missing} 时不得构造真实适配器`);
    await assert.rejects(
      () => store.presignUpload({ key: 'obj_synthetic', contentType: 'image/jpeg', expiresInSeconds: 300 }),
      (error) => error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === true,
      `缺 ${missing} 时预签名必须仍被 fail-closed 拒绝`,
    );
  }
  assert.equal(
    resolveMediaObjectStore({
      executionMode: 'real',
      env: { ...SYNTHETIC_STORAGE_ENV, OBJECT_STORAGE_ENDPOINT: 'http://synthetic-object-storage.invalid' },
    }).kind,
    'unwired',
    '明文 http endpoint 不得构造真实适配器',
  );

  // 3) 齐备 ⇒ 真实适配器（`kind==='s3_compatible'`）；只做**本地**预签名，零外部请求。
  const wired = resolveMediaObjectStore({ executionMode: 'real', env: SYNTHETIC_STORAGE_ENV });
  assert.equal(wired.kind, 's3_compatible');
  assert.equal(wired.externalRequestCount, 0);
  assert.match(wired.note, /从未被实际调用/);
  const handle = await wired.presignUpload({ key: 'obj_synthetic', contentType: 'image/jpeg', expiresInSeconds: 300 });
  assert.equal(handle.method, 'PUT');
  assert.match(handle.url, /^https:\/\/synthetic-media-placeholder\.synthetic-object-storage\.invalid\/obj_synthetic\?/);
  assert.match(handle.url, /X-Amz-Algorithm=AWS4-HMAC-SHA256/);
  assert.match(handle.url, /X-Amz-Expires=300/);
  assert.match(handle.url, /X-Amz-Signature=[0-9a-f]{64}/);
  assert.ok(!handle.url.includes(SYNTHETIC_STORAGE_ENV.OBJECT_STORAGE_SECRET_KEY), '签名密钥绝不进 URL');
  assert.equal(wired.externalRequestCount, 0, '预签名是纯本地计算，不得发起任何真实对象存储请求');

  // 4) 替身分支：`env` 齐备也**不得**影响 stub/preset_demo（逐字不变）。
  assert.equal(resolveMediaObjectStore({ executionMode: 'stub', env: SYNTHETIC_STORAGE_ENV }).kind, 'substitute');
  assert.equal(resolveMediaObjectStore({ executionMode: 'preset_demo', env: SYNTHETIC_STORAGE_ENV }).kind, 'substitute');

  // 5) 装配点静态自证：唯一装配行必须把 `process.env` 交给 `resolveMediaObjectStore`。
  //    运行期无法在不**设置** `OBJECT_STORAGE_*` 的前提下验证这条传递（红线：ADR-001 门控，本片不碰），
  //    故这里只锁该行文本（去掉 `env: process.env` ⇒ 本断言红）。
  assert.match(
    readFileSync(new URL('../../services/api/src/app.ts', import.meta.url), 'utf8'),
    /resolveMediaObjectStore\(\{ executionMode: config\.executionMode, env: process\.env \}\)/,
    'app.ts 的对象存储装配点必须传入 process.env',
  );
});
