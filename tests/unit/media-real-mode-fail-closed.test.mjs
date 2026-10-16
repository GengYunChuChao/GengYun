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
// 1-A（历史）接线曾把 real 的对象存储判据定为"`OBJECT_STORAGE_*` 齐备才接真实适配器"。
// **本片（PR #193 修订 A 项）撤回该口径**：那 4 个键正是 real 模式的**启动必填**项
// （`services/api/src/config.ts` 的 `REQUIRED_WHEN_REAL`）⇒「运维不设键」**不可能**充当可启动
// real 环境的门，把 ambient `process.env` 交给 resolver 等于**配置即门控**（监工 P1）。
// 现在的门是**显式注入**：`app.ts` 只做 `mediaObjectStore ?? resolveMediaObjectStore({ executionMode })`
// —— **不传 `env`**；`resolveMediaObjectStore` 的 `env` 形参**保留**，但只供**显式装配／测试**
// 使用（其 JSDoc 已写明装配层不得传 ambient `process.env`）。
//
// **本文件默认不设置任何 `OBJECT_STORAGE_*` 环境变量**：合成值只作为**参数**内联传给
// `resolveMediaObjectStore`，不落盘、不连任何真实端点。唯一的例外是下面 1-A 负控制那一条
// —— 它**必须**把 4 个合成键注入 ambient `process.env` 才能证否"配置即门控"，
// 并在 `t.after` 里**逐键还原**（该用例与其它用例都不依赖这两个变量此前是否存在）。
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
// 默认只作为**参数**内联使用；唯一把它注入 ambient `process.env` 的地方是 1-A 负控制用例，
// 且该用例在 `t.after` 逐键还原（见文件头说明）。
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

test('GY-I06 1-A 装配：real 缺任一 OBJECT_STORAGE_* ⇒ 仍 unwired（逐字 fail-closed）；显式传入齐备 env ⇒ s3_compatible（零网络）', async () => {
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

  // 5) 装配点静态自证：唯一装配行**不得**把 `process.env` 交给 `resolveMediaObjectStore`。
  //    （1-A 修订后判据反转：旧断言要求传 `process.env`，那正是监工 P1 的成因 ⇒ 本断言随之反转。）
  //    运行期由下面两条用例（负控制／正控制）钉住行为，这里只锁**结构**：
  //    改回 `env: process.env` ⇒ 本断言红。
  assert.doesNotMatch(
    readFileSync(new URL('../../services/api/src/app.ts', import.meta.url), 'utf8'),
    /resolveMediaObjectStore\(\{ executionMode: config\.executionMode, env: process\.env \}\)/,
    'app.ts 的对象存储装配点**不得**把 ambient `process.env` 传给 resolveMediaObjectStore',
  );
});

// ===================================================================================
// 1-A 修订（PR #193 P1）：三条机器判据 —— 门是"显式注入"，不是"环境里有配置"。
// 三条都可"注入即红"：负控制把 4 键注入 ambient env（改回读 ambient env 即红）；
// 正控制检查注入端口确实被使用（装配层不再采信注入即红）；结构性判据检查装配层源码
// 不把 `process.env` 交给解析器（改回 `env: process.env` 即红）。
// ===================================================================================

/** 把对象存储 4 键注入 ambient `process.env`，返回**逐键还原**函数（重入安全：先存再写）。 */
function injectAmbientStorageEnv() {
  const saved = new Map();
  for (const key of REQUIRED_STORAGE_KEYS) {
    saved.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    process.env[key] = SYNTHETIC_STORAGE_ENV[key];
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * 装配层**媒体装配块**：按**内容锚点**在源码文本里切片 ——
 * 从含 `const mediaObjectStore = ` 的那一行，到其后**第一**个 `createAppMediaService({` 之前。
 *
 * **为什么不去注释**（本片踩过的坑，留证）：仓内既有同类判据
 * （`tests/integration/tts-http.mjs` S01、`tests/integration/ocr-http.mjs`）用正则一次性删掉
 * 块注释（正则里的定界符此处用全角 ／＊ ＊／ 代替，否则本注释自身会被提前闭合），
 * 但 `app.ts` 的**单行注释**里合法地含有块注释的**起始定界符**字面
 * （`app.ts:83` 与 `app.ts:832` 的 `packages/privacy/**`、`admin/ops/**`）。
 * 盲去注释会从那里起把**上万字符真实代码**吞到下一个**结束定界符**
 * （实测：去注释后 `const mediaObjectStore` 落进被删区段、整条判据触到"找不到"而**响亮**失败；
 * 若哪天恰好删除那两行注释，同一写法会改判**被吞掉后的残文**——即转为**假绿**）。
 * 所以这里改为：**读源码文本、锚内容行、按行号切片**（同 `ocr-http.mjs` 的"按行定位"写法），
 * 不引入注释剥离，也不另造解析器。
 *
 * 找不到锚点、锚点不唯一、切片为空 ⇒ **抛错**（判据必须锚在**真实存在**的那一段源码上，
 * 找不到不得静默通过）。
 */
function readMediaAssemblyBlock() {
  const lines = readFileSync(new URL('../../services/api/src/app.ts', import.meta.url), 'utf8').split(/\r?\n/);
  const anchors = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes('const mediaObjectStore = ')) anchors.push(index);
  }
  assert.equal(anchors.length, 1, `app.ts 必须有唯一的 \`const mediaObjectStore = \` 装配行，实为 ${anchors.length} 处`);
  const start = anchors[0];
  let end = -1;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].includes('createAppMediaService({')) { end = index; break; }
  }
  assert.notEqual(end, -1, 'app.ts 的媒体装配块必须以 createAppMediaService({ 收尾');
  // 不含注释行：单行注释里的 `process.env`/`env` 只是说明文字，不构成装配行为。
  const block = lines
    .slice(start, end)
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  assert.ok(block.trim().length > 0, '媒体装配块不得为空');
  return block;
}

test('GY-I06 1-A 负控制：real 装配下把 OBJECT_STORAGE_* 注入 ambient env ⇒ 媒体域仍整域 503（配置不是门）', async (t) => {
  // （A 项的直接否命题。）4 键注入 **ambient** `process.env`，走**默认装配**（不注入端口）。
  // 改回 `resolveMediaObjectStore({ …, env: process.env })` ⇒ 本用例红（会造出真实适配器、返回 2xx）。
  const restoreEnv = injectAmbientStorageEnv();
  t.after(() => restoreEnv());
  const store = createMemoryAuthStore();
  const app = buildApp({ config: { ...baseConfig(), executionMode: 'real' }, store });
  t.after(() => app.close());
  const token = await synthesizeSession(store, 'synthetic-real-ambient-env-01');

  // 默认装配必须仍是**未接线**端口：ambient 配置齐备也不得把它变成真实适配器。
  assert.equal(
    app.mediaObjectStore.kind,
    'unwired',
    'real + ambient OBJECT_STORAGE_* 齐备时，默认装配仍必须是 unwired（配置不是门）',
  );
  assert.notEqual(app.mediaService.failClosedReason, null);
  assert.equal(app.mediaObjectStore.externalRequestCount, 0);

  // 每个入口仍整域 503 + retryable，且**不带任何成功封套**（零网络：kind 是端口自己的字段，
  // 未接线端口即使被误调用也会拒绝，不会外发）。
  const routes = [
    ['POST', '/api/v1/media/uploads', { payload: DECLARED, headers: { 'idempotency-key': KEY('ambient-create') } }],
    ['POST', `/api/v1/media/uploads/${MEDIA_ID}/complete`, { payload: { sha256: DECLARED.sha256, bytes: DECLARED.bytes }, headers: { 'idempotency-key': KEY('ambient-complete'), 'if-match': '"1"' } }],
    ['GET', `/api/v1/media/${MEDIA_ID}`, {}],
    ['DELETE', `/api/v1/media/${MEDIA_ID}`, { headers: { 'idempotency-key': KEY('ambient-delete'), 'if-match': '"1"' } }],
    ['POST', `/api/v1/media/${MEDIA_ID}/access`, { headers: { 'idempotency-key': KEY('ambient-access'), 'if-match': '"1"' } }],
    ['POST', '/api/v1/community/media-access', {
      payload: { content_ref: { type: 'post', id: MEDIA_ID, revision: 1 }, media_ref: { media_id: MEDIA_ID, media_revision: 1 }, slot: 'attachment', author_revision: null },
      headers: { 'idempotency-key': KEY('ambient-community'), 'if-match': '"1"' },
    }],
    ['GET', `/api/v1/community/media/${MEDIA_ID}/content`, { headers: { 'x-media-access-token': 'synthetic-token' } }],
  ];
  for (const [method, url, options] of routes) {
    const response = await call(app, method, url, token, options);
    assert.equal(
      response.status,
      503,
      `${method} ${url} → ${response.status} ${JSON.stringify(response.body)}（ambient 配置齐备不得放行）`,
    );
    assert.equal(response.body.error.code, 'PROVIDER_UNAVAILABLE', `${method} ${url}`);
    assert.equal(response.body.error.retryable, true, `${method} ${url} 必须标记可重试`);
    assert.equal(response.body.data, undefined, `${method} ${url} 不得带 data`);
    assert.equal(response.body.meta.execution_mode, 'real');
  }
  assert.equal(app.mediaObjectStore.externalRequestCount, 0, '不得发起任何真实对象存储请求');

  // 对照：同一批 ambient 键作为**显式参数**确实能构造真实适配器（证明 4 键本身有效，
  // 被否定的只是"装配层读 ambient env"这条路径）—— 仅构造，零网络。
  const viaExplicitParam = resolveMediaObjectStore({ executionMode: 'real', env: { ...SYNTHETIC_STORAGE_ENV } });
  assert.equal(viaExplicitParam.kind, 's3_compatible');
  assert.equal(viaExplicitParam.externalRequestCount, 0);
});

test('GY-I06 1-A 正控制：ambient 4 键齐备时**显式注入**真实 kind 的 store ⇒ 装配确实走真实分支（门是注入，不是环境）', async (t) => {
  const realStore = createS3CompatibleObjectStore({
    endpoint: 'https://cos.ap-shanghai.myqcloud.com',
    bucket: 'gengyun-media-placeholder',
    accessKey: 'synthetic-access-key-id',
    secretKey: 'synthetic-secret-key-value',
    region: 'ap-shanghai',
    forcePathStyle: false,
  });
  assert.equal(realStore.kind, 's3_compatible');
  assert.equal(realStore.externalRequestCount, 0);

  const restoreEnv = injectAmbientStorageEnv();
  t.after(() => restoreEnv());
  const store = createMemoryAuthStore();
  const app = buildApp({
    config: { ...baseConfig(), executionMode: 'real' },
    store,
    mediaObjectStore: realStore,
  });
  t.after(() => app.close());
  const token = await synthesizeSession(store, 'synthetic-real-explicit-injection-01');

  // 装配层必须**原样采用注入的端口**（而不是按 executionMode/ambient env 自己解析一个别的）。
  assert.equal(app.mediaObjectStore, realStore, '显式注入的端口必须被原样装配');
  assert.equal(app.mediaObjectStore.kind, 's3_compatible');
  assert.equal(app.mediaService.failClosedReason, null);

  // createUpload 只做**本地预签名**（不触碰桶）⇒ 201 + 真实适配器形状的直传 URL。
  const created = await call(app, 'POST', '/api/v1/media/uploads', token, {
    payload: DECLARED,
    headers: { 'idempotency-key': KEY('explicit-create') },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.meta.execution_mode, 'real');
  assert.equal(created.body.data.upload.method, 'PUT');
  const url = created.body.data.upload.url;
  assert.match(url, /^https:\/\/gengyun-media-placeholder\.cos\.ap-shanghai\.myqcloud\.com\//);
  assert.match(url, /X-Amz-Algorithm=AWS4-HMAC-SHA256/);
  assert.match(url, /X-Amz-Signature=[0-9a-f]{64}/);
  assert.ok(!url.includes('synthetic-secret-key-value'), '签名密钥绝不进 URL');
  // 关键：整轮零真实对象存储请求（预签名是纯本地计算；红线：不接真实桶）。
  assert.equal(realStore.externalRequestCount, 0, '本任务不授权任何真实对象存储调用');
});

test('GY-I06 1-A 结构性判据：app.ts 媒体装配层**不得**把 `process.env` 交给 resolveMediaObjectStore', () => {
  // 与仓内既有同类判据同法（`tests/integration/tts-http.mjs` S01、`tests/integration/ocr-http.mjs`
  // 的装配行结构证据）：读源码**文本**，不另造解析器。但**不去注释**——见 readMediaAssemblyBlock
  // 的说明：`app.ts` 的单行注释里合法含 `/*` 字面，盲去块注释会吞掉真实代码（本片实测）。
  const block = readMediaAssemblyBlock();
  assert.ok(block.includes('resolveMediaObjectStore('), '媒体装配块必须调用 resolveMediaObjectStore');
  // 1) 装配层不得出现 ambient 环境读取（含 `process.env['X']` 形式的动态取键）。
  assert.equal(block.includes('process.env'), false, '装配层不得读取 ambient `process.env`');
  // 2) 解析器的唯一实参**不得**含 `env` 键（回退行除外 —— 回退行只随注入与否出现，
  //    所以直接禁止：回退行只能是 `{ executionMode: … }`）。
  assert.doesNotMatch(block, /resolveMediaObjectStore\(\{[^}]*\benv\b/, 'resolveMediaObjectStore 调用不得传 `env`');
  // 3) 回退行必须**恰好**只描述执行模式（`{ executionMode: config.executionMode }` 或简写
  //    `{ executionMode }`）。改回 `env: process.env` 或任何"配置打开真实适配器"的写法 ⇒ 本断言红。
  const fallbackCalls = [...block.matchAll(/resolveMediaObjectStore\(\{([^}]*)\}\)/g)].map((match) => match[1].trim());
  assert.ok(fallbackCalls.length > 0, '装配层必须有 resolveMediaObjectStore 回退调用');
  for (const args of fallbackCalls) {
    assert.match(
      args,
      /^executionMode(?:: config\.executionMode)?$/,
      `resolveMediaObjectStore 的参数只允许执行模式，实为 { ${args} }`,
    );
  }
  // 4) 唯一装配行本身：只有 `媒体端口选项 ?? 按模式解析` 一种形状。
  assert.match(
    block,
    /const mediaObjectStore = mediaObjectStoreOption \?\? resolveMediaObjectStore\(\{ executionMode: config\.executionMode \}\);/,
    '装配行必须是 `mediaObjectStoreOption ?? resolveMediaObjectStore({ executionMode: config.executionMode })`',
  );
});
