// GY-I06（#6）媒体域 · real 模式 fail-closed 反例 + 对象存储端口如实标注。
//
// 本文件是「若不修就会失败」的**负控制**：real 模式下真实对象存储未接线时，
// 媒体域必须整域 503 `PROVIDER_UNAVAILABLE`（`retryable: false`），**绝不**用内存/替身实现
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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
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
// r3 主闸门（运行期构造期批准能力）：铸造点、品牌判定与拒绝原因文案。
import {
  approveRealMediaWiring,
  createAppMediaService,
  isRealMediaWiringApproved,
  REAL_MEDIA_APPROVAL_REQUIRED_REASON,
} from '../../services/api/src/media/service.ts';
import { sha256Hex } from '../../packages/media/validate.mjs';
import { jpegWithExif } from '../media/_fixtures.mjs';

const KEY = (name) => `media-real-${name}-0000`;
/** r3：真实媒体接线的**显式批准能力**夹具（唯一铸造点 `approveRealMediaWiring`）。 */
const mintApproval = (label) => approveRealMediaWiring({ reason: `r3 测试夹具：${label}（合成端点，零外呼）` });
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
    assert.equal(
      response.body.error.retryable,
      false,
      `${method} ${url} 未接线（需运维接线）⇒ 不得标记可重试：同一请求重试不会成功`,
    );
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
  assert.equal(created.body.error.retryable, false);
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
    // r3 主闸门：真实分支还**必须**显式给出批准能力（non-defaultable；铸造点唯一）。
    realMediaApproval: mintApproval('显式放行'),
  });
  t.after(() => app.close());
  // 反面对照（同一真实端口、**不给批准能力**）⇒ 仍整域 fail-closed：闸门是构造期能力，不是端口来源。
  const unapprovedApp = buildApp({
    config: { ...baseConfig(), executionMode: 'real' },
    store: createMemoryAuthStore(),
    mediaObjectStore: realStore,
  });
  t.after(() => unapprovedApp.close());
  assert.equal(
    unapprovedApp.mediaService.failClosedReason,
    REAL_MEDIA_APPROVAL_REQUIRED_REASON,
    '显式注入真实端口但缺少批准能力 ⇒ failClosedReason 必须点名「缺少批准能力」',
  );
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
  await assert.rejects(() => unwired.putObject('obj_x', new Uint8Array([1]), 'image/jpeg'), (error) => error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === false);
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
  // 1) 缺 env（默认装配路径）⇒ 与接线前**逐字一致**：同一个 reason/note，且每个操作仍 503（`retryable: false`：未接线＝能力未装配，需运维接线）。
  const absent = resolveMediaObjectStore({ executionMode: 'real', env: {} });
  assert.equal(absent.kind, 'unwired');
  assert.equal(absent.note, createUnwiredObjectStore().note, '缺 env 的 reason/note 必须与接线前逐字一致');
  assert.equal(absent.externalRequestCount, 0);
  await assert.rejects(
    () => absent.putObject('obj_synthetic', new Uint8Array([1]), 'image/jpeg'),
    (error) => error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === false,
  );

  // 2) 缺**任一**必填键都不得放行（缺配置 ≠ 放行）；明文 http endpoint 同理。
  for (const missing of REQUIRED_STORAGE_KEYS) {
    const env = { ...SYNTHETIC_STORAGE_ENV };
    delete env[missing];
    const store = resolveMediaObjectStore({ executionMode: 'real', env });
    assert.equal(store.kind, 'unwired', `缺 ${missing} 时不得构造真实适配器`);
    await assert.rejects(
      () => store.presignUpload({ key: 'obj_synthetic', contentType: 'image/jpeg', expiresInSeconds: 300 }),
      (error) => error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === false,
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

/**
 * 把一批键注入 ambient `process.env`，返回**逐键还原**函数（重入安全：先存再写，缺失键还原为 delete）。
 * 还原是逐字节的：`t.after` 里调用它即可，用例失败也照样还原（见下方各用例的 `t.after`）。
 */
function injectAmbientEnv(entries) {
  const saved = new Map();
  for (const [key, value] of Object.entries(entries)) {
    saved.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * 把对象存储 4 键注入 ambient `process.env`，返回**逐键还原**函数。
 * （r2 起它只是 `injectAmbientEnv` 的逐字等价别名：键与值仍取 `SYNTHETIC_STORAGE_ENV`，
 * 语义与 r1 完全一致；既有负控制用例调用点未变。）
 */
function injectAmbientStorageEnv() {
  return injectAmbientEnv(SYNTHETIC_STORAGE_ENV);
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
    assert.equal(
      response.body.error.retryable,
      false,
      `${method} ${url} 未接线（需运维接线）⇒ 不得标记可重试：同一请求重试不会成功`,
    );
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
    // r3 主闸门：显式注入端口**并**显式给出批准能力，才走真实分支。
    realMediaApproval: mintApproval('1-A 正控制'),
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

// ===================================================================================
// r2（PR #193 第二轮返修）：B1 —— 判据强度从「装配块内一行」扩到「整个 app.ts + 媒体链路」，
// 并把「唯一显式注入来源」证成**机械事实**（AST 溯源），而不是靠某处标准拼写。
//
// 为什么必须扩（对抗性复审 M19，见 `.pg17/adv-verdict-i06-media-refailclosed-eee87c7.md`）：
// 只锁「装配块里那一行」时，下面这种同形变体下上一个版本的 9 条用例**全绿**，而危害可达
// （`POST /api/v1/media/uploads` ⇒ 201 + 预签名 URL）：
//   · resolver 换名；
//   · 装配块内**逐字保留**那句装饰性装配行（于是块内判据照旧通过）；
//   · 真实端口挪到 `createAppMediaService({ objectStore: … })` 实参位置（**块外**，块内判据看不见）；
//   · 门用**非 canonical ambient 键**（`OBJECT_STORAGE_ALLOW_REAL === '1'`）而不是那 4 个标准键。
// 所以这里改成两条**全文件／全链路**判据：
//   A)「ambient env 读取」审计（AST）：`app.ts` 只允许读白名单里的非存储键（逐字枚举），
//      `services/api/src/media/**` 与 `routes/media.ts` **一次都不许读**。覆盖
//      `process.env`、`process['env']`、`globalThis.process.env`、`import.meta.env`，
//      以及**整表传递／别名／解构／对象展开／动态取键**（这些一律视为违规，因为没有"按名读某个键"可核对）。
//   B)「唯一显式注入来源」溯源（AST）：端口变量的声明初值、`createAppMediaService` 的 `objectStore`
//      实参、以及该名字在全文件的**每一处**出现，必须逐处等于枚举出来的角色（多一处即红）；
//      并且 `services/api/src/**` 内两个工厂的生产调用点各**恰好 1 处**（真实工厂的唯一样点就在
//      `resolveMediaObjectStore` 内部）。
// 判据自身的灵敏度由用例「B1 判据自检」用合成夹具钉住：M19 同形必须判违规，canonical 源码必须无违规。
// ⛔ 不新增第二套孤立解析器：用仓库既有依赖 `typescript`（`node_modules/typescript`，与 `npm run lint`
//    的 tsc 同一份）的官方解析器，与仓内既有「读源码文本」判据（`tests/integration/tts-http.mjs` S01、
//    `tests/integration/ocr-http.mjs`）同一思路；差别只在于那两处按**文本**断言，而 `app.ts` 的
//    **单行注释**里合法含 `/*` 字面（见 `readMediaAssemblyBlock` 的说明），盲去注释不可靠，
//    因此这里升级为按 AST 断言（仍是只读源码，不引入新依赖、不另写正则解析器）。
// ===================================================================================

/** 仓库根（本文件位于 `<root>/tests/unit/`）。 */
const REPO_ROOT_URL = new URL('../../', import.meta.url);

/** `app.ts` 允许读取的 ambient 键：逐字枚举，**全部与存储/媒体无关**（键名形状由用例断言）。GY-R68 追补的 `MODERATION_DEMO_PORT` 是审核域**演示端口**开关（`services/api/src/moderation/demo-port.ts`，装配处按名读这一个键）：人工过了一遍——① 键名不命中 `STORAGE_SHAPED_ENV_KEY`；② 它不是存储门控、不改变媒体域任何行为（媒体域仍只认显式注入的端口）；③ 它只在 `APP_EXECUTION_MODE != real` 生效，real 下装配层根本不注入（`demo-port.ts` 的 refused 分支）。 */
const APP_AMBIENT_ENV_ALLOWLIST = Object.freeze([
  'RECOGNITION_PROVIDER_URL',
  'RECOGNITION_PROVIDER_KEY',
  'APP_KNOWLEDGE_UNVERIFIED_SEED', 'MODERATION_DEMO_PORT',
]);

/** 除上表外只允许 **Node/运行时内部**读取的键；出现未列出的键 ⇒ 判据红（见运行时探针用例）。 */
const RUNTIME_AMBIENT_ENV_ALLOWLIST = Object.freeze([
  'NODE_V8_COVERAGE', 'FORCE_COLOR', 'NO_COLOR', 'COLORTERM', 'TERM', 'COLUMNS', 'LINES',
  'NODE_ENV', 'NODE_OPTIONS', 'NODE_NO_WARNINGS', 'CI', 'TZ', 'LANG', 'LC_ALL', 'TZDIR',
]);

/** **存储/媒体形状**的键名：装配期一个都不许读（不管是标准键还是自造键）。 */
const STORAGE_SHAPED_ENV_KEY = /OBJECT_STORAGE|S3|COS|STORAGE|BUCKET|MEDIA_STORE/i;

/** **存储形状**的服务入参名（AST 审计用；`objectStore` 命中 `store`）。 */
const STORAGE_SHAPED_PROPERTY = /store|storage|bucket|s3|cos|object_storage/i;

/** 媒体端口变量的名字（装配层唯一输入/端口的名字，逐字）。 */
const MEDIA_PORT_VARIABLE = 'mediaObjectStore';
const MEDIA_PORT_OPTION = 'mediaObjectStoreOption';
const MEDIA_RESOLVER = 'resolveMediaObjectStore';
const REAL_STORE_FACTORY = 'createS3CompatibleObjectStore';

/** ambient env 对象的可能写法（整表读取/别名识别用）。 */
const PROCESS_ROOTS = new Set([
  'process',
  'globalThis.process',
  'global.process',
  'globalThis["process"]',
  'global["process"]',
  'window.process',
]);

/** 媒体链路上**一次都不许读 ambient env** 的文件（相对仓库根）。 */
const MEDIA_CHAIN_FILES = Object.freeze([
  'services/api/src/media/object-store.ts',
  'services/api/src/media/service.ts',
  'services/api/src/media/real-ports.ts',
  'services/api/src/routes/media.ts',
]);

const compactNodeText = (node, source) => node.getText(source).replace(/\s+/g, '').replace(/['"]/g, '"');
const lineOf = (node, source) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
const oneLine = (text) => text.replace(/\s+/g, ' ').trim();
const shortText = (node, source, limit = 110) => oneLine(node.getText(source)).slice(0, limit);

/** 该节点是不是 `process.env`／`process['env']`／`globalThis.process.env`／`import.meta.env`。 */
function ambientEnvNodeOf(node, source) {
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'env') {
    const base = compactNodeText(node.expression, source);
    if (PROCESS_ROOTS.has(base)) return { base, form: 'property-access' };
    if (base === 'import.meta') return { base, form: 'import-meta-env' };
  }
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    node.argumentExpression.text === 'env'
  ) {
    const base = compactNodeText(node.expression, source);
    if (PROCESS_ROOTS.has(base)) return { base, form: 'element-access' };
    if (base === 'import.meta') return { base, form: 'import-meta-env' };
  }
  return null;
}

/** 这次读取取的是哪个键；返回 `null` 表示「没有按名读某个键」（整表/动态）。 */
function ambientEnvKeyOf(envNode, source) {
  const parent = envNode.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === envNode) return parent.name.text;
  if (ts.isElementAccessExpression(parent) && parent.expression === envNode) {
    const argument = parent.argumentExpression;
    if (argument && ts.isStringLiteralLike(argument)) return argument.text;
    return null;
  }
  return null;
}

/** 整表传递／别名／解构／展开／动态取键的说明；`null` 表示这是一次**按名**读取。 */
function ambientEnvTableUseOf(envNode, source) {
  const parent = envNode.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === envNode) return null;
  if (ts.isElementAccessExpression(parent) && parent.expression === envNode) {
    const argument = parent.argumentExpression;
    if (argument && ts.isStringLiteralLike(argument)) return null;
    return `动态取键（键名无法逐字核对）：${shortText(parent, source)}`;
  }
  return `整表传递/别名/解构/展开（父节点 ${ts.SyntaxKind[parent.kind]}）：${shortText(parent, source)}`;
}

/** 审计一个已解析文件里的 ambient env 读取：返回**发现**（读数）与**违规**（判据）。 */
function auditAmbientEnv(parsed, allowedKeys) {
  const { source } = parsed;
  const findings = [];
  const visit = (node) => {
    const access = ambientEnvNodeOf(node, source);
    if (access) {
      const tableUse = ambientEnvTableUseOf(node, source);
      findings.push({
        line: lineOf(node, source),
        form: access.form,
        base: access.base,
        key: tableUse === null ? ambientEnvKeyOf(node, source) : null,
        tableUse,
        snippet: shortText(node.parent, source),
      });
    }
    // `const { env } = process` 形态：没有 `process.env` 节点，单独识别。
    if (ts.isObjectBindingPattern(node)) {
      const declaration = ts.isVariableDeclaration(node.parent) ? node.parent : null;
      const initializer = declaration?.initializer;
      const bindsEnv = node.elements.some(
        (element) =>
          ts.isBindingElement(element) &&
          element.propertyName === undefined &&
          element.name.getText(source) === 'env',
      );
      if (bindsEnv && initializer !== undefined && ts.isIdentifier(initializer) && initializer.text === 'process') {
        findings.push({
          line: lineOf(node, source),
          form: 'destructure',
          base: 'process',
          key: 'env',
          tableUse: '解构 ambient env 对象本身',
          snippet: shortText(declaration, source),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const violations = [];
  for (const finding of findings) {
    if (finding.tableUse !== null) {
      violations.push({ rule: 'R-A1 整表/动态读取 ambient env', ...finding });
    } else if (!allowedKeys.includes(finding.key)) {
      violations.push({ rule: 'R-A2 读取了未列入白名单的 ambient 键', ...finding });
    }
  }
  return { findings, violations };
}

/** 端口名在文件里的每一处出现，按**角色**归类（多出任何角色都会被判违规）。 */
function mediaPortIdentifierRole(node, source) {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return 'declaration';
  if (ts.isBindingElement(parent) && parent.propertyName === node) {
    return `binding-element:propertyName→${parent.name.getText(source)}`;
  }
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
    return `property-assignment:${parent.name.getText(source)}`;
  }
  if (ts.isPropertySignature(parent) && parent.name === node) return 'property-signature';
  if (ts.isCallExpression(parent)) {
    return `call-argument:${oneLine(parent.expression.getText(source)).slice(0, 40)}`;
  }
  return `other:${ts.SyntaxKind[parent.kind]}`;
}

/**
 * 「唯一显式注入来源」溯源：端口变量的声明初值、服务的 `objectStore` 实参、
 * 以及端口名在全文件的每一处出现，逐处核对。
 */
function auditMediaPortProvenance(parsed) {
  const { source } = parsed;
  const declarations = [];
  const identifierRoles = [];
  const resolverCalls = [];
  const serviceProperties = [];

  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === MEDIA_PORT_VARIABLE
    ) {
      declarations.push({
        line: lineOf(node, source),
        initializer: node.initializer === undefined ? null : oneLine(node.initializer.getText(source)),
      });
    }
    if (
      ts.isIdentifier(node) &&
      node.text === MEDIA_PORT_VARIABLE &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      identifierRoles.push({ line: lineOf(node, source), role: mediaPortIdentifierRole(node, source) });
    }
    if (ts.isCallExpression(node)) {
      const callee = compactNodeText(node.expression, source);
      if (callee === MEDIA_RESOLVER) {
        const argument = node.arguments[0];
        const properties =
          argument && ts.isObjectLiteralExpression(argument)
            ? argument.properties.map((property) =>
                ts.isPropertyAssignment(property) ? property.name.getText(source) : ts.SyntaxKind[property.kind],
              )
            : null;
        resolverCalls.push({
          line: lineOf(node, source),
          argument: argument === undefined ? null : oneLine(argument.getText(source)),
          properties,
        });
      }
      if (callee === 'createAppMediaService' && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        for (const property of node.arguments[0].properties) {
          serviceProperties.push(
            ts.isPropertyAssignment(property)
              ? { name: property.name.getText(source), initializer: oneLine(property.initializer.getText(source)) }
              : { name: ts.SyntaxKind[property.kind], initializer: null },
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const violations = [];
  const canonicalInitializer = `${MEDIA_PORT_OPTION} ?? ${MEDIA_RESOLVER}({ executionMode: config.executionMode })`;
  if (declarations.length !== 1) {
    violations.push({ rule: 'R-B1 端口变量必须恰好声明一处', detail: declarations });
  }
  if (declarations.length === 1 && declarations[0].initializer !== canonicalInitializer) {
    violations.push({
      rule: 'R-B2 端口初值必须是「显式注入选项 ?? 只按执行模式解析」',
      expected: canonicalInitializer,
      actual: declarations[0].initializer,
    });
  }
  const objectStoreArguments = serviceProperties.filter((property) => property.name === 'objectStore');
  if (objectStoreArguments.length !== 1) {
    violations.push({ rule: 'R-B3 服务装配必须恰好一个 objectStore 实参', detail: objectStoreArguments });
  } else if (objectStoreArguments[0].initializer !== MEDIA_PORT_VARIABLE) {
    violations.push({
      rule: 'R-B4 objectStore 实参必须**就是**那个端口变量（不得再包一层解析/条件）',
      expected: MEDIA_PORT_VARIABLE,
      actual: objectStoreArguments[0].initializer,
    });
  }
  const storageShapedProperties = serviceProperties.filter(
    (property) => property.name !== 'objectStore' && STORAGE_SHAPED_PROPERTY.test(property.name),
  );
  if (storageShapedProperties.length > 0) {
    violations.push({ rule: 'R-B5 服务装配不得有第二个存储形状入参', detail: storageShapedProperties });
  }
  const unexpectedRoles = identifierRoles.filter(
    (entry) => !['declaration', 'property-assignment:objectStore', 'property-signature'].includes(entry.role) &&
      !entry.role.startsWith('binding-element:propertyName→') &&
      !entry.role.startsWith('call-argument:app.decorate'),
  );
  if (unexpectedRoles.length > 0) {
    violations.push({ rule: 'R-B6 端口名不得出现在枚举角色之外的位置', detail: unexpectedRoles });
  }
  if (resolverCalls.length !== 1) {
    violations.push({ rule: 'R-B7 装配层必须恰好一处 resolver 调用', detail: resolverCalls });
  }
  for (const call of resolverCalls) {
    if (call.properties === null || call.properties.length !== 1 || call.properties[0] !== 'executionMode') {
      violations.push({ rule: 'R-B8 resolver 的参数只允许 executionMode 一个键', detail: call });
    }
  }
  return { violations, declarations, identifierRoles, resolverCalls, serviceProperties };
}

/** 解析仓库内文件（只读）。 */
function parseRepoFile(repoPath) {
  const text = readFileSync(new URL(repoPath, REPO_ROOT_URL), 'utf8');
  return { repoPath, text, source: ts.createSourceFile(repoPath, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS) };
}

/** 解析一段合成源码（判据自检用，不落盘）。 */
function parseSynthetic(label, text) {
  return { repoPath: label, text, source: ts.createSourceFile(label, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS) };
}

/** 枚举 `services/api/src/**` 下两个工厂的**生产调用点**（含所在文件与外层函数名）。 */
function productionStoreFactoryCallSites(relativeDir, factoryNames) {
  const root = fileURLToPath(new URL(relativeDir, REPO_ROOT_URL));
  const files = [];
  for (const dirent of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!dirent.isFile() || !/\.(ts|mts|mjs)$/.test(dirent.name)) continue;
    files.push(join(dirent.parentPath ?? root, dirent.name));
  }
  const sites = [];
  const candidates = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!factoryNames.some((name) => text.includes(name))) continue;
    candidates.push(file);
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = compactNodeText(node.expression, source);
        if (factoryNames.includes(callee)) {
          let enclosing = null;
          for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
            if (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isMethodDeclaration(parent)) {
              enclosing = parent.name === undefined ? '(匿名)' : parent.name.getText(source);
              break;
            }
            if (ts.isArrowFunction(parent)) {
              enclosing = '(箭头函数)';
              break;
            }
          }
          sites.push({
            name: callee,
            file: file.slice(file.replace(/\\/g, '/').indexOf('/services/') + 1).replace(/\\/g, '/'),
            line: lineOf(node, source),
            enclosing,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { scannedFiles: files.length, candidateFiles: candidates.length, sites };
}

/**
 * 媒体路由装配守卫（启发式）：枚举 `routes/media.ts` 里对 `service` 的全部成员取用
 * 与 7 条路由注册的 `preHandler`，用于回归时提示「端口/存储被暴露到路由层」或「入口丢了守卫」。
 */
function mediaRouteRegistrationGuard(parsed) {
  const { source } = parsed;
  const serviceProps = new Set();
  const registrations = [];
  let requireUserOccurrences = 0;
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(source) === 'service') {
      serviceProps.add(node.name.getText(source));
    }
    if (ts.isPropertyAccessExpression(node) && node.getText(source) === 'guards.requireUser') {
      requireUserOccurrences += 1;
    }
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && /^app\.(get|post|put|patch|delete)$/.test(node.expression.getText(source))
    ) {
      const [pathArg, optionsArg] = node.arguments;
      const preHandler = optionsArg !== undefined && ts.isObjectLiteralExpression(optionsArg)
        ? optionsArg.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(source) === 'preHandler')
        : undefined;
      registrations.push({
        method: node.expression.name.getText(source),
        path: pathArg === undefined ? '(动态)' : compactNodeText(pathArg, source),
        preHandler: preHandler === undefined ? null : compactNodeText(preHandler.initializer, source),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return {
    serviceProps: [...serviceProps].sort(),
    // 注释里的同名字样不算（AST 口径）：只数真正的 `guards.requireUser` 引用。
    requireUserCount: requireUserOccurrences,
    registrations,
  };
}

/** 共享断言：媒体域整域 fail-closed 的封套（503 + PROVIDER_UNAVAILABLE + retryable + 无 data）。 */
function expectMediaDomainClosed(response, label) {
  assert.equal(response.status, 503, `${label} → ${response.status} ${JSON.stringify(response.body)}`);
  assert.equal(response.body.error.code, 'PROVIDER_UNAVAILABLE', label);
  assert.equal(response.body.error.retryable, false, `${label}：未接线＝能力未装配，需运维接线，同一请求原样重试不会成功`);
  assert.equal(response.body.data, undefined, `${label} 不得带任何成功封套`);
  assert.equal(response.body.meta.execution_mode, 'real', label);
}

/** 媒体域 ambient env 探针：记录装配期/请求期每一次 `process.env` 读取与整表枚举。 */
function installAmbientEnvProbe() {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'env');
  const target = process.env;
  const reads = [];
  const enumerations = [];
  const proxy = new Proxy(target, {
    get(inner, property) {
      if (typeof property === 'string') reads.push({ phase: probe.phase, key: property });
      return Reflect.get(inner, property);
    },
    set: (inner, property, value) => Reflect.set(inner, property, value),
    has: (inner, property) => Reflect.has(inner, property),
    ownKeys(inner) {
      enumerations.push(`ownKeys（阶段 ${probe.phase}）`);
      return Reflect.ownKeys(inner);
    },
    getOwnPropertyDescriptor(inner, property) {
      if (typeof property === 'string') enumerations.push(`getOwnPropertyDescriptor:${property}（阶段 ${probe.phase}）`);
      return Reflect.getOwnPropertyDescriptor(inner, property);
    },
    defineProperty: (inner, property, attributes) => Reflect.defineProperty(inner, property, attributes),
    deleteProperty: (inner, property) => Reflect.deleteProperty(inner, property),
  });
  const probe = { phase: 'assembly', reads, enumerations, detached: false };
  Object.defineProperty(process, 'env', { ...(descriptor ?? {}), value: proxy });
  probe.detach = () => {
    if (probe.detached) return;
    probe.detached = true;
    Object.defineProperty(
      process,
      'env',
      descriptor ?? { value: target, writable: true, configurable: true, enumerable: true },
    );
  };
  return probe;
}

test('GY-I06 1-A B1（唯一显式注入来源）：app.ts 端口溯源 —— 声明初值/服务实参/全文件角色逐处枚举，生产调用点各恰一处', () => {
  const app = parseRepoFile('services/api/src/app.ts');
  const audit = auditMediaPortProvenance(app);

  // 无违规：端口初值只允许 `mediaObjectStoreOption ?? resolveMediaObjectStore({ executionMode })`。
  assert.deepEqual(audit.violations, [], 'app.ts 的媒体端口溯源必须零违规');
  assert.equal(audit.declarations.length, 1, '端口变量必须恰好一处声明');
  assert.equal(
    audit.declarations[0].initializer,
    `${MEDIA_PORT_OPTION} ?? ${MEDIA_RESOLVER}({ executionMode: config.executionMode })`,
    '端口初值只允许「显式注入选项 ?? 只按执行模式解析」',
  );
  assert.deepEqual(
    audit.resolverCalls.map((call) => call.properties),
    [['executionMode']],
    'resolver 调用必须恰好一处，参数只允许 executionMode 一个键（⛔ 不得传 env）',
  );

  // 端口名在全文件的**每一处**出现都必须落在枚举角色里（多一处即红）。
  // GY-I11 语音片新增一处转交（`audioMedia`）⇒ 1→2；GY-R69 OCR 片再新增一处同形转交（`ocrImageMedia`）⇒ 2→3；
  // GY-R70 识别片新增第三处同形转交（`recognitionMediaPorts`：识别域 provider 的 `imageSource` ＋ 该域 `media` 端口）⇒ 3→4；
  // GY-R70 审核片新增第四处同形转交（`createModerationService` 的 `imageMedia` 取值器）⇒ 4→5。
  // 五处都逐行钉死：多出第六处、或挪到别的行 ⇒ 红。
  assert.deepEqual(
    audit.identifierRoles.map((entry) => entry.role).sort(),
    [
      'binding-element:propertyName→mediaObjectStoreOption',
      'call-argument:app.decorate', 'declaration',
      'property-assignment:objectStore', 'property-assignment:objectStore',
      'property-assignment:objectStore', 'property-assignment:objectStore',
      'property-assignment:objectStore',
      'property-signature',
      'property-signature',
    ],
    '端口名只允许出现在：类型声明（注入选项/装饰）×2、解构绑定（唯一输入）、端口声明、objectStore 实参 ×5（媒体服务装配 + 语音/OCR/识别/审核四域转发）、测试装饰',
  );
  {
    const objectStoreArguments = audit.identifierRoles.filter((entry) => entry.role === 'property-assignment:objectStore');
    const lineOf = (marker) => app.text.split(/\r?\n/).findIndex((line) => line.includes(marker)) + 1;
    const speechAudioMediaLine = lineOf('const speechAudioMedia = {');
    const ocrImageMediaLine = lineOf('const ocrImageMedia = ');
    const recognitionMediaLine = lineOf('const recognitionMediaPorts = ');
    const moderationImageMediaLine = lineOf('imageMedia: () => ({ objectStore: mediaObjectStore, mediaRecords: mediaStore })');
    assert.ok(speechAudioMediaLine > 0 && ocrImageMediaLine > 0 && recognitionMediaLine > 0 && moderationImageMediaLine > 0, 'app.ts 必须有 speechAudioMedia / ocrImageMedia / recognitionMediaPorts / 审核域取值器 四条端口转发行');
    for (const [label, line, literal] of [
      ['语音域', speechAudioMediaLine, 'const speechAudioMedia = { objectStore: mediaObjectStore, mediaRecords: mediaStore };'], ['OCR 域', ocrImageMediaLine, '{ objectStore: mediaObjectStore, mediaRecords: mediaStore };'],
      ['识别域', recognitionMediaLine, '{ objectStore: mediaObjectStore, mediaRecords: mediaStore });'],
      ['审核域', moderationImageMediaLine, 'imageMedia: () => ({ objectStore: mediaObjectStore, mediaRecords: mediaStore }),'],
    ]) {
      assert.equal(objectStoreArguments.filter((entry) => entry.line === line).length, 1, `${label}：该行必须恰有一处 objectStore 实参（端口转交）`);
      assert.ok(app.text.includes(literal), `${label}：该行只允许原样转发既有端口（不得新建/派生存储端口）`);
    }
    const mediaServiceOnly = objectStoreArguments.filter((entry) => entry.line !== speechAudioMediaLine && entry.line !== ocrImageMediaLine && entry.line !== recognitionMediaLine && entry.line !== moderationImageMediaLine);
    assert.equal(mediaServiceOnly.length, 1, `除四处域内转发外，objectStore 只允许出现在媒体服务装配那一行；越界：${JSON.stringify(mediaServiceOnly)}`);
    assert.equal(app.text.split(/\r?\n/)[mediaServiceOnly[0].line - 1].trim(), 'objectStore: mediaObjectStore,', '剩下那一处必须仍是媒体服务装配的存储端口实参');
  }
  // 唯一输入：解构绑定必须把 `BuildAppOptions.mediaObjectStore` 绑定为 `mediaObjectStoreOption`。
  assert.ok(
    audit.identifierRoles.some((entry) => entry.role === 'binding-element:propertyName→mediaObjectStoreOption'),
    '显式注入选项必须经唯一的解构绑定进入装配',
  );
  // 服务装配里不得有第二个存储形状入参（例如 `objectStoreOverride`/`storage`/`bucket`）。
  assert.deepEqual(
    audit.serviceProperties
      .filter((property) => STORAGE_SHAPED_PROPERTY.test(property.name))
      .map((property) => property.name),
    ['objectStore'],
    'createAppMediaService 只允许 objectStore 一个存储形状入参',
  );

  // 生产调用点（片 W2 / GY-R28 修订：**二处闭集**，逐处钉死文件与外层函数）：
  //   1. `app.ts#buildApp` —— 零注入回退，只带执行模式（⛔ 不传 env）；
  //   2. `media/real-ports.ts#resolveMediaRealPorts` —— 仅由 `--approve-real-media-wiring` 驱动，
  //      传入的是由**已解析配置**逐字段还原的显式记录（见下方「加强」断言）。
  // 为什么必须多出第二处：`buildApp` 的端口初值被判据逐字钉成
  // `mediaObjectStoreOption ?? resolveMediaObjectStore({ executionMode: config.executionMode })`
  // 且实参只允许 `executionMode` 一个键，所以「真实端口」只可能由**显式注入**进入装配；
  // 而注入方必须是生产入口，入口构造端口又只能经 resolver —— 闭集由 1 处变 2 处，是接线的**必要条件**。
  // 该修订不放宽任何其他维度：工厂仍只允许被 resolver 调一次；resolver 的两处之外多一处即红。
  const counts = productionStoreFactoryCallSites('services/api/src', [MEDIA_RESOLVER, REAL_STORE_FACTORY]);
  assert.ok(counts.scannedFiles > 100, `必须真扫到生产源码（实测 ${counts.scannedFiles} 个文件）`);
  const resolverSites = counts.sites.filter((site) => site.name === MEDIA_RESOLVER);
  const factorySites = counts.sites.filter((site) => site.name === REAL_STORE_FACTORY);
  assert.deepEqual(
    resolverSites.map((site) => [site.file, site.enclosing]),
    [
      ['services/api/src/app.ts', 'buildApp'],
      ['services/api/src/media/real-ports.ts', 'resolveMediaRealPorts'],
    ],
    'resolver 在生产源码里只允许这两处：buildApp 的零注入回退、real-ports 的批准驱动装配（多一处即红）',
  );
  assert.deepEqual(
    factorySites.map((site) => [site.file, site.enclosing]),
    [['services/api/src/media/object-store.ts', MEDIA_RESOLVER]],
    '真实适配器工厂在生产源码里只允许被 resolver 调用一次（其余一律不得构造真实端口）',
  );

  // 加强（片 W2 新增）：第二处 resolver 调用的**实参形状**同样钉死——只允许 `{ executionMode, env }`，
  // 且 `env` 必须是 `objectStorageEnv(...)` 的产物（由已解析配置还原），⛔ 不得是 ambient `process.env`。
  const realPorts = parseRepoFile('services/api/src/media/real-ports.ts');
  const realPortsResolverArgs = [];
  const visitRealPorts = (node) => {
    if (ts.isCallExpression(node) && compactNodeText(node.expression, realPorts.source) === MEDIA_RESOLVER) {
      const [argument] = node.arguments;
      const properties = argument !== undefined && ts.isObjectLiteralExpression(argument) ? argument.properties : [];
      realPortsResolverArgs.push(
        properties.map((property) => ({
          key: property.name === undefined ? '(无名)' : property.name.getText(realPorts.source),
          value: property.initializer === undefined ? '' : compactNodeText(property.initializer, realPorts.source),
        })),
      );
    }
    ts.forEachChild(node, visitRealPorts);
  };
  visitRealPorts(realPorts.source);
  assert.equal(realPortsResolverArgs.length, 1, 'real-ports.ts 必须恰好一处 resolver 调用');
  assert.deepEqual(
    realPortsResolverArgs[0].map((entry) => entry.key),
    ['executionMode', 'env'],
    'real-ports 的 resolver 调用只允许 executionMode + env 两个键',
  );
  assert.match(
    realPortsResolverArgs[0][1].value,
    /^objectStorageEnv\(/u,
    'real-ports 传给 resolver 的 env 必须由 objectStorageEnv(...) 从已解析配置还原（不是 ambient env）',
  );
  // ambient env 用**同一套 AST 审计**再验一遍（比正则更严：连 `globalThis['pro'+'cess'].env` 也抓，
  // 且不会被本文件注释里的 `process.env` 字样误伤）。
  const realPortsAmbient = auditAmbientEnv(realPorts, []);
  assert.deepEqual(realPortsAmbient.violations, [], 'real-ports.ts 不得读 ambient env');
  assert.deepEqual(realPortsAmbient.findings, [], 'real-ports.ts 的 ambient env 读取点实测必须为 0');
});

test('GY-I06 1-A B1（全文件 ambient env 审计）：app.ts 只允许白名单里的 4 个非媒体键；media/** 与 routes/media.ts 一次都不许读', () => {
  const app = parseRepoFile('services/api/src/app.ts');
  const audit = auditAmbientEnv(app, APP_AMBIENT_ENV_ALLOWLIST);

  // 白名单本身必须是「非存储形状」的键（否则白名单会变成后门）。
  for (const key of APP_AMBIENT_ENV_ALLOWLIST) {
    assert.ok(!STORAGE_SHAPED_ENV_KEY.test(key), `白名单键 ${key} 不得是存储/媒体形状`);
  }
  assert.deepEqual(audit.violations, [], 'app.ts 不得读取任何未列入白名单的 ambient 键（含整表传递/动态取键）');
  // 读数证据：实测读取点必须**恰好**等于白名单（多了少了都红）。
  assert.deepEqual(
    audit.findings.map((finding) => finding.key).sort(),
    [...APP_AMBIENT_ENV_ALLOWLIST].sort(),
    'app.ts 的 ambient env 读取点必须恰好等于白名单里的非存储键（逐字枚举，多了少了都红）',
  );
  for (const finding of audit.findings) {
    assert.equal(finding.tableUse, null, `第 ${finding.line} 行必须是按名读取：${finding.snippet}`);
  }

  // 媒体链路：一次都不许读 ambient env（存储端口的唯一输入是显式参数/显式注入）。
  for (const repoPath of MEDIA_CHAIN_FILES) {
    const parsed = parseRepoFile(repoPath);
    const chainAudit = auditAmbientEnv(parsed, []);
    assert.deepEqual(
      chainAudit.findings,
      [],
      `${repoPath} 不得读取 ambient env（实测：${JSON.stringify(chainAudit.findings)}）`,
    );
  }
});

test('GY-I06 1-A B1（判据自检）：M19 同形必须判违规，canonical 源码必须零违规', () => {
  // 夹具 1：对抗性复审的 M19 同形 —— resolver 换名、装配块内保留逐字装饰行、
  // 真实端口挪到 `objectStore:` 实参位置、门用非 canonical ambient 键。
  const m19 = parseSynthetic(
    'm19-fixture.ts',
    [
      "import { createS3CompatibleObjectStore, readObjectStorageConfig } from './media/object-store.ts';",
      'function resolveStoreFromAmbient(ambientEnv) {',
      "  if (ambientEnv['OBJECT_STORAGE_ALLOW_REAL'] !== '1') return null;",
      '  const { config } = readObjectStorageConfig(ambientEnv);',
      '  return config === null ? null : createS3CompatibleObjectStore(config);',
      '}',
      'function buildApp({ mediaObjectStore: mediaObjectStoreOption }) {',
      '  const mediaObjectStore = mediaObjectStoreOption ?? resolveMediaObjectStore({ executionMode: config.executionMode });',
      '  const mediaService = createAppMediaService({',
      '    executionMode: config.executionMode,',
      '    objectStore: resolveStoreFromAmbient(process.env) ?? mediaObjectStore,',
      '  });',
      '  return mediaService;',
      '}',
    ].join('\n'),
  );
  const m19Ambient = auditAmbientEnv(m19, APP_AMBIENT_ENV_ALLOWLIST);
  const m19Provenance = auditMediaPortProvenance(m19);
  assert.ok(m19Ambient.violations.length > 0, 'M19 同形必须被 ambient 审计判违规（整表把 process.env 交出去）');
  assert.ok(
    m19Ambient.violations.some((violation) => violation.rule.startsWith('R-A1')),
    `M19 同形的整表传递必须被点名：${JSON.stringify(m19Ambient.violations)}`,
  );
  assert.ok(m19Provenance.violations.length > 0, 'M19 同形必须被端口溯源判违规（真实端口挪到了 objectStore 实参）');
  const relocated = m19Provenance.violations.find((violation) => violation.rule.startsWith('R-B4'));
  assert.ok(relocated, `M19 同形必须点名 objectStore 实参不是端口变量本身：${JSON.stringify(m19Provenance.violations)}`);
  assert.match(
    String(relocated.actual),
    /process\.env/,
    '违规读数必须逐字给出真实端口的来源表达式（含 process.env）',
  );
  assert.ok(
    m19Provenance.violations.some((violation) => violation.rule.startsWith('R-B6')),
    'M19 同形把端口名用在了枚举角色之外（`?? mediaObjectStore`）⇒ 必须被判违规',
  );

  // 夹具 2：非 canonical 键被**直接**按名读取（证明键名会被逐字点到）。
  const nonCanonical = parseSynthetic(
    'non-canonical-key-fixture.ts',
    "const mediaService = createAppMediaService({ objectStore: process.env['OBJECT_STORAGE_ALLOW_REAL'] === '1' ? realStore : mediaObjectStore });",
  );
  const nonCanonicalAudit = auditAmbientEnv(nonCanonical, APP_AMBIENT_ENV_ALLOWLIST);
  assert.ok(
    nonCanonicalAudit.findings.some((finding) => finding.key === 'OBJECT_STORAGE_ALLOW_REAL'),
    `非 canonical 键必须被逐字点到：${JSON.stringify(nonCanonicalAudit.findings)}`,
  );
  assert.ok(nonCanonicalAudit.violations.some((violation) => violation.rule.startsWith('R-A2')), '非 canonical 键不在白名单 ⇒ 违规');

  // 夹具 3：元素访问 / 整表别名 / 解构 / 对象展开 —— 四种读取形状都必须被判违规。
  const shapes = [
    ['globalThis.process["env"]', 'const mediaObjectStore = globalThis.process["env"]["OBJECT_STORAGE_ENDPOINT"] ? a : b;'],
    ['整表别名', 'const ambientEnv = process.env;\nconst mediaObjectStore = ambientEnv.OBJECT_STORAGE_ENDPOINT ? a : b;'],
    ['解构 process.env 对象', 'const { env } = process;\nconst mediaObjectStore = env.OBJECT_STORAGE_ENDPOINT ? a : b;'],
    ['对象展开', 'const mediaObjectStore = readObjectStorageConfig({ ...process.env });'],
    ['import.meta.env', 'const mediaObjectStore = import.meta.env.OBJECT_STORAGE_ENDPOINT ? a : b;'],
  ];
  for (const [label, text] of shapes) {
    const audit = auditAmbientEnv(parseSynthetic(`${label}.ts`, text), APP_AMBIENT_ENV_ALLOWLIST);
    assert.ok(audit.violations.length > 0, `${label} 形状必须被判违规（实测 ${JSON.stringify(audit.findings)}）`);
  }

  // 夹具 4：忠实换名（语义等价、无 bypass）—— ambient 审计必须**零违规**（不误报），
  // 端口溯源必须红（判据只认那一种写法：换名/移位必须同步更新判据，属**故意**的 fail-closed 过敏感）。
  const faithfulRename = parseSynthetic(
    'faithful-rename-fixture.ts',
    [
      'function buildApp({ mediaObjectStore: mediaObjectStoreOption }) {',
      '  const mediaObjectStore = mediaObjectStoreOption ?? resolveStoreByMode({ executionMode: config.executionMode });',
      '  const mediaService = createAppMediaService({ executionMode: config.executionMode, objectStore: mediaObjectStore });',
      '  return mediaService;',
      '}',
    ].join('\n'),
  );
  assert.deepEqual(
    auditAmbientEnv(faithfulRename, APP_AMBIENT_ENV_ALLOWLIST).violations,
    [],
    '忠实换名（不读 ambient env）不得被 ambient 审计误报',
  );
  assert.ok(
    auditMediaPortProvenance(faithfulRename).violations.length > 0,
    '换名/移位必须让端口溯源自红（判据只认枚举出来的写法，改名须人工同步）',
  );

  // 正控制：真实源码必须零违规（判据不得对 canonical 装配误报）。
  const realApp = parseRepoFile('services/api/src/app.ts');
  assert.deepEqual(auditAmbientEnv(realApp, APP_AMBIENT_ENV_ALLOWLIST).violations, []);
  assert.deepEqual(auditMediaPortProvenance(realApp).violations, []);
});

test('GY-I06 1-A 负控制（非 canonical ambient 键）：OBJECT_STORAGE_ALLOW_REAL 等键齐备也不得改变默认装配 ⇒ 仍整域 503', async (t) => {
  // 对抗性复审 M19 用的门是**非 canonical** 键（`OBJECT_STORAGE_ALLOW_REAL === '1'`）。
  // 本用例把「标准 4 键 + 一切像开关的自造键」一起注入 ambient env，默认装配（不注入端口）仍必须 fail-closed。
  const restoreEnv = injectAmbientEnv({
    ...SYNTHETIC_STORAGE_ENV,
    OBJECT_STORAGE_ALLOW_REAL: '1',
    OBJECT_STORAGE_MODE: 'real',
    OBJECT_STORAGE_ENABLED: 'true',
    S3_ENABLE_REAL: '1',
    COS_ENABLE_REAL: '1',
    MEDIA_OBJECT_STORE: 's3',
    GY_I06_REAL_MEDIA: '1',
  });
  t.after(() => restoreEnv());

  const store = createMemoryAuthStore();
  const app = buildApp({ config: { ...baseConfig(), executionMode: 'real' }, store });
  t.after(() => app.close());
  const token = await synthesizeSession(store, 'synthetic-non-canonical-env-01');

  assert.equal(app.mediaObjectStore.kind, 'unwired', '非 canonical ambient 键不得把默认装配变成真实适配器');
  assert.notEqual(app.mediaService.failClosedReason, null);
  assert.equal(app.mediaService.objectStore.kind, 'unwired');
  assert.equal(app.mediaObjectStore.externalRequestCount, 0);

  const routes = [
    ['POST', '/api/v1/media/uploads', { payload: DECLARED, headers: { 'idempotency-key': KEY('noncanon-create') } }],
    ['POST', `/api/v1/media/uploads/${MEDIA_ID}/complete`, {
      payload: { sha256: DECLARED.sha256, bytes: DECLARED.bytes },
      headers: { 'idempotency-key': KEY('noncanon-complete'), 'if-match': '"1"' },
    }],
    ['GET', `/api/v1/media/${MEDIA_ID}`, {}],
    ['DELETE', `/api/v1/media/${MEDIA_ID}`, { headers: { 'idempotency-key': KEY('noncanon-delete'), 'if-match': '"1"' } }],
    ['POST', `/api/v1/media/${MEDIA_ID}/access`, { headers: { 'idempotency-key': KEY('noncanon-access'), 'if-match': '"1"' } }],
    ['POST', '/api/v1/community/media-access', {
      payload: {
        content_ref: { type: 'post', id: MEDIA_ID, revision: 1 },
        media_ref: { media_id: MEDIA_ID, media_revision: 1 },
        slot: 'attachment',
        author_revision: null,
      },
      headers: { 'idempotency-key': KEY('noncanon-community'), 'if-match': '"1"' },
    }],
    ['GET', `/api/v1/community/media/${MEDIA_ID}/content`, { headers: { 'x-media-access-token': 'synthetic-token' } }],
  ];
  for (const [method, url, options] of routes) {
    expectMediaDomainClosed(await call(app, method, url, token, options), `${method} ${url}`);
  }
  assert.equal(app.mediaObjectStore.externalRequestCount, 0, '不得发起任何真实对象存储请求');
});

test('GY-I06 1-A B1（运行时来源检查）：装配期与请求期不得读取任何存储形状 ambient 键（env 探针实测）', async (t) => {
  // 先注入「标准键 + 像开关的自造键」，再挂 env 探针：任何一次**存储形状**的 ambient 读取都会被记录。
  const restoreEnv = injectAmbientEnv({
    ...SYNTHETIC_STORAGE_ENV,
    OBJECT_STORAGE_ALLOW_REAL: '1',
    S3_ENABLE_REAL: '1',
    COS_ENABLE_REAL: '1',
    MEDIA_OBJECT_STORE: 's3',
  });
  t.after(() => restoreEnv());
  const probe = installAmbientEnvProbe();
  t.after(() => probe.detach());

  probe.phase = 'assembly';
  const store = createMemoryAuthStore();
  const app = buildApp({ config: { ...baseConfig(), executionMode: 'real' }, store });
  t.after(() => app.close());
  const token = await synthesizeSession(store, 'synthetic-runtime-source-01');

  probe.phase = 'request';
  const response = await call(app, 'POST', '/api/v1/media/uploads', token, {
    payload: DECLARED,
    headers: { 'idempotency-key': KEY('runtime-source') },
  });
  probe.detach();

  // 来源检查（一）：默认装配**不得**读取任何存储形状的 ambient 键（标准键、自造键都不行）。
  const storageReads = probe.reads.filter((entry) => STORAGE_SHAPED_ENV_KEY.test(entry.key));
  assert.deepEqual(storageReads, [], '装配期/请求期都不得读取存储形状的 ambient 键');
  // 来源检查（二）：不得整表枚举 ambient env（`Object.keys`/展开/env 快照）。
  assert.deepEqual(probe.enumerations, [], '不得整表枚举 ambient env');
  // 来源检查（三）：读到的键必须是「白名单里的非媒体键（app.ts）」或「Node/运行时内部键」；
  // 出现新键 ⇒ 要么它确实来自运行时（核后补注列入），要么装配路径新增了一条 ambient 输入 —— 两者都必须人工过一遍。
  const unknownKeys = [
    ...new Set(
      probe.reads
        .map((entry) => entry.key)
        .filter((key) => !APP_AMBIENT_ENV_ALLOWLIST.includes(key) && !RUNTIME_AMBIENT_ENV_ALLOWLIST.includes(key)),
    ),
  ];
  assert.deepEqual(
    unknownKeys,
    [],
    `出现未列入白名单的 ambient 键读取：${JSON.stringify(unknownKeys)}（若确实来自 Node 运行时，核后补注列入；否则说明装配路径新增了 ambient 输入）`,
  );
  // 探针有效性（非真空）：必须真的观测到装配期的按名读取，否则说明探针没挂上/被测代码绕开了 process.env 代理。
  assert.ok(
    probe.reads.some((entry) => entry.phase === 'assembly' && APP_AMBIENT_ENV_ALLOWLIST.includes(entry.key)),
    `探针必须观测到装配期的 ambient 读取（实测：${JSON.stringify(probe.reads)}）`,
  );

  // 运行时来源/身份（一）：行为发生在**端口身份**上 —— 未注入 ⇒ 未接线端口 ⇒ 整域 503。
  assert.equal(app.mediaObjectStore.kind, 'unwired');
  assert.equal(app.mediaService.objectStore.kind, 'unwired');
  assert.notEqual(app.mediaService.failClosedReason, null);
  expectMediaDomainClosed(response, 'POST /api/v1/media/uploads（非 canonical 键注入下）');
  assert.equal(app.mediaObjectStore.externalRequestCount, 0);

  // 运行时来源/身份（二）：判据是端口 `kind`，不是「是否 real」这个布尔 —— 2×2 矩阵
  // （real/stub × 未接线/真实端口）只有端口 `kind` 决定结果。
  const unwiredPort = createUnwiredObjectStore('测试注入的未接线端口（2×2 矩阵）');
  const realPort = createS3CompatibleObjectStore({
    endpoint: 'https://cos.ap-shanghai.myqcloud.com',
    bucket: 'gengyun-media-placeholder',
    accessKey: 'synthetic-access-key-id',
    secretKey: 'synthetic-secret-key-value',
    region: 'ap-shanghai',
    forcePathStyle: false,
  });
  const outcomes = [];
  const approval = mintApproval('2×2 矩阵');
  for (const [executionMode, port, approved, expected] of [
    ['real', undefined, false, { kind: 'unwired', status: 503 }],
    ['stub', unwiredPort, false, { kind: 'unwired', status: 503 }],
    ['real', realPort, true, { kind: 's3_compatible', status: 201 }],
    ['stub', realPort, false, { kind: 's3_compatible', status: 201 }],
    // r3 主闸门：端口**确实**是真实 kind，但 real 下**没给批准能力** ⇒ 服务层必须整域关闭
    // （端口身份不变，闸门在构造期能力上）。
    ['real', realPort, false, { kind: 's3_compatible', status: 503 }],
  ]) {
    const modeStore = createMemoryAuthStore();
    const modeApp = buildApp({
      config: { ...baseConfig(), executionMode },
      store: modeStore,
      ...(port === undefined ? {} : { mediaObjectStore: port }),
      ...(approved ? { realMediaApproval: approval } : {}),
    });
    const modeToken = await synthesizeSession(modeStore, `synthetic-2x2-${executionMode}-${expected.kind}`);
    const created = await call(modeApp, 'POST', '/api/v1/media/uploads', modeToken, {
      payload: DECLARED,
      headers: { 'idempotency-key': KEY(`2x2-${executionMode}-${expected.kind}`) },
    });
    outcomes.push({
      executionMode,
      port: port === undefined ? '(未注入)' : port.kind,
      kind: modeApp.mediaObjectStore.kind,
      status: created.status,
      failClosedReason: modeApp.mediaService.failClosedReason === null ? null : '(fail-closed)',
      externalRequests: modeApp.mediaObjectStore.externalRequestCount,
    });
    await modeApp.close();
    assert.equal(modeApp.mediaObjectStore.kind, expected.kind, `${executionMode} + ${port === undefined ? '未注入' : port.kind}`);
    assert.equal(created.status, expected.status, JSON.stringify(created.body));
    assert.equal(modeApp.mediaObjectStore.externalRequestCount, 0, '预签名是纯本地计算，不得外发');
  }
  assert.deepEqual(
    outcomes,
    [
      { executionMode: 'real', port: '(未注入)', kind: 'unwired', status: 503, failClosedReason: '(fail-closed)', externalRequests: 0 },
      { executionMode: 'stub', port: 'unwired', kind: 'unwired', status: 503, failClosedReason: null, externalRequests: 0 },
      { executionMode: 'real', port: 's3_compatible', kind: 's3_compatible', status: 201, failClosedReason: null, externalRequests: 0 },
      { executionMode: 'stub', port: 's3_compatible', kind: 's3_compatible', status: 201, failClosedReason: null, externalRequests: 0 },
      { executionMode: 'real', port: 's3_compatible', kind: 's3_compatible', status: 503, failClosedReason: '(fail-closed)', externalRequests: 0 },
    ],
    '判据必须只跟随端口 kind：同样 real 模式，注入真实端口 + 显式批准能力即可用、未注入即整域 503；'
      + '未接线端口在 stub 下也一律 503（此时 503 由端口本身拒绝产生，服务层不加 failClosedReason）；'
      + 'r3：真实端口 + real 但**缺少批准能力** ⇒ 端口 kind 仍是 s3_compatible 而服务层整域 503',
  );
});

// ===================================================================================
// r3（裁定 `ruling-i193-runtime-gate.md`）：真实媒体的**主闸门**是运行期构造期
// 「显式批准能力」，不是任何静态/文本判据。上面的结构性判据已降级为**启发式回归护栏**
// （覆盖与未覆盖清单见本文件末尾那条用例打印）。下面五条是 B1–B4 的运行期判据，
// 全部用合成 `.invalid` 端点/合成凭据的自造等价夹具，零真实外呼、不读密钥。
// ===================================================================================

/** 合成真实适配器配置（`.invalid` 保留域，永不解析；与既有用例同形）。 */
const R3_SYNTHETIC_STORE_CONFIG = {
  endpoint: 'https://cos.ap-shanghai.myqcloud.com',
  bucket: 'gengyun-media-placeholder',
  accessKey: 'synthetic-access-key-id',
  secretKey: 'synthetic-secret-key-value',
  region: 'ap-shanghai',
  forcePathStyle: false,
};

/** 7 条媒体路由的请求清单（与 1-A 负控制逐条同形；`label` 只用于保证幂等键互不冲突）。 */
function mediaRouteRequests(label) {
  return [
    ['POST', '/api/v1/media/uploads', { payload: DECLARED, headers: { 'idempotency-key': KEY(`${label}-create`) } }],
    ['POST', `/api/v1/media/uploads/${MEDIA_ID}/complete`, { payload: { sha256: DECLARED.sha256, bytes: DECLARED.bytes }, headers: { 'idempotency-key': KEY(`${label}-complete`), 'if-match': '"1"' } }],
    ['GET', `/api/v1/media/${MEDIA_ID}`, {}],
    ['DELETE', `/api/v1/media/${MEDIA_ID}`, { headers: { 'idempotency-key': KEY(`${label}-delete`), 'if-match': '"1"' } }],
    ['POST', `/api/v1/media/${MEDIA_ID}/access`, { headers: { 'idempotency-key': KEY(`${label}-access`), 'if-match': '"1"' } }],
    ['POST', '/api/v1/community/media-access', {
      payload: { content_ref: { type: 'post', id: MEDIA_ID, revision: 1 }, media_ref: { media_id: MEDIA_ID, media_revision: 1 }, slot: 'attachment', author_revision: null },
      headers: { 'idempotency-key': KEY(`${label}-community`), 'if-match': '"1"' },
    }],
    ['GET', `/api/v1/community/media/${MEDIA_ID}/content`, { headers: { 'x-media-access-token': 'synthetic-token' } }],
  ];
}

test('GY-I06 r3 B1（运行期主闸门）：ambient 四键齐备 + 真实端口，但未提供批准能力 ⇒ real 仍整域 503 且 failClosedReason 点名批准', async (t) => {
  // 最恶劣的一条路径（正是 r2 被判漏的形状）：环境里四键齐备、调用方显式注入了一个**真实**端口，
  // 但**没有**任何批准能力 ⇒ 服务层必须在构造期整域关闭，7 条入口一律 503。
  const restoreEnv = injectAmbientStorageEnv();
  t.after(() => restoreEnv());
  const realStore = createS3CompatibleObjectStore(R3_SYNTHETIC_STORE_CONFIG);
  const store = createMemoryAuthStore();
  const app = buildApp({
    config: { ...baseConfig(), executionMode: 'real' },
    store,
    mediaObjectStore: realStore,
  });
  t.after(() => app.close());
  const token = await synthesizeSession(store, 'synthetic-r3-gate-no-approval');

  // 端口身份如实保留（装配层不擅自改写注入对象），但执行端口被整域换成未接线端口。
  assert.equal(app.mediaObjectStore, realStore, '注入的端口必须被原样装配（不得悄悄替换）');
  assert.equal(app.mediaObjectStore.kind, 's3_compatible');
  assert.equal(app.mediaService.objectStore.kind, 'unwired', '未批准 ⇒ 服务层必须换成未接线端口');
  assert.equal(app.mediaService.failClosedReason, REAL_MEDIA_APPROVAL_REQUIRED_REASON);
  assert.match(String(app.mediaService.failClosedReason), /缺少真实媒体接线的显式批准能力/);

  for (const [method, url, options] of mediaRouteRequests('r3-no-approval')) {
    const response = await call(app, method, url, token, options);
    expectMediaDomainClosed(response, `${method} ${url}（真实端口 + ambient 四键齐备，但无批准能力）`);
  }
  assert.equal(realStore.externalRequestCount, 0, '整轮不得有任何真实对象存储请求');
});

test('GY-I06 r3 批准能力：不可伪造/不可派生/不可默认化，显式批准 + 真实端口才走真实分支', async (t) => {
  // 1) 伪造与派生一律不是能力（形状相同不算，只认铸造点的对象身份）。
  const genuine = mintApproval('r3 判据 2 夹具');
  assert.equal(isRealMediaWiringApproved(genuine), true, '铸造点给出的对象必须被认作批准能力');
  assert.equal(Object.isFrozen(genuine), true, '批准能力必须冻结（防止事后改写自述字段）');
  const forged = [
    ['布尔 true', true],
    ['字符串', 'approved'],
    ['同形状字面量', { reason: 'r3 夹具', approvedAt: '2026-10-16T00:00:00.000Z' }],
    ['冻结的同形状对象', Object.freeze({ reason: 'r3 夹具', approvedAt: '2026-10-16T00:00:00.000Z' })],
    ['Object.create(批准能力) 原型继承', Object.create(genuine)],
    ['structuredClone 弱拷贝', structuredClone(genuine)],
    ['JSON 往返副本', JSON.parse(JSON.stringify(genuine))],
    ['Proxy 包装', new Proxy(genuine, {})],
    ['undefined', undefined],
    ['null', null],
  ];
  for (const [label, value] of forged) {
    assert.equal(isRealMediaWiringApproved(value), false, `${label} 不得被认作批准能力`);
  }

  // 2) 能力不可从 ambient env 派生：注入一堆"看起来像批准"的键也改变不了判定。
  const restoreEnv = injectAmbientEnv({
    ...SYNTHETIC_STORAGE_ENV,
    OBJECT_STORAGE_ALLOW_REAL: '1',
    GY_I06_REAL_MEDIA_APPROVED: '1',
    REAL_MEDIA_APPROVAL: 'granted',
  });
  t.after(() => restoreEnv());
  assert.equal(
    isRealMediaWiringApproved({ reason: 'r3 夹具', approvedAt: '2026-10-16T00:00:00.000Z' }),
    false,
    'ambient 键不得把同形状对象变成批准能力',
  );

  // 3) 生效路径：显式批准 + 真实端口（real）⇒ 真实分支可用（仅本地预签名，零外呼）。
  const realStore = createS3CompatibleObjectStore(R3_SYNTHETIC_STORE_CONFIG);
  const store = createMemoryAuthStore();
  const app = buildApp({
    config: { ...baseConfig(), executionMode: 'real' },
    store,
    mediaObjectStore: realStore,
    realMediaApproval: genuine,
  });
  t.after(() => app.close());
  const token = await synthesizeSession(store, 'synthetic-r3-approval-positive');
  const created = await call(app, 'POST', '/api/v1/media/uploads', token, {
    payload: DECLARED,
    headers: { 'idempotency-key': KEY('r3-approval-create') },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.meta.execution_mode, 'real');
  assert.equal(app.mediaService.failClosedReason, null);
  assert.match(created.body.data.upload.url, /^https:\/\/gengyun-media-placeholder\.cos\.ap-shanghai\.myqcloud\.com\//);
  assert.ok(!created.body.data.upload.url.includes('synthetic-secret-key-value'), '签名密钥绝不进 URL');
  assert.equal(realStore.externalRequestCount, 0, '预签名是纯本地计算，不得外发');

  // 4) 能力不能替代端口：批准 + 未接线端口 ⇒ 仍整域 503。
  const closedStore = createMemoryAuthStore();
  const closedApp = buildApp({
    config: { ...baseConfig(), executionMode: 'real' },
    store: closedStore,
    mediaObjectStore: createUnwiredObjectStore('r3 夹具：批准但端口未接线'),
    realMediaApproval: genuine,
  });
  t.after(() => closedApp.close());
  const closedToken = await synthesizeSession(closedStore, 'synthetic-r3-approval-unwired-port');
  expectMediaDomainClosed(
    await call(closedApp, 'POST', '/api/v1/media/uploads', closedToken, { payload: DECLARED, headers: { 'idempotency-key': KEY('r3-approval-unwired') } }),
    '批准能力 + 未接线端口',
  );

  // 5) **显式传 `undefined` 等同于没提供**（能力是不可默认化的；缺省不是「放宽」）。
  const undefinedStore = createMemoryAuthStore();
  const undefinedApp = buildApp({
    config: { ...baseConfig(), executionMode: 'real' },
    store: undefinedStore,
    mediaObjectStore: realStore,
    realMediaApproval: undefined,
  });
  t.after(() => undefinedApp.close());
  const undefinedToken = await synthesizeSession(undefinedStore, 'synthetic-r3-approval-undefined');
  const undefinedResponse = await call(undefinedApp, 'POST', '/api/v1/media/uploads', undefinedToken, {
    payload: DECLARED,
    headers: { 'idempotency-key': KEY('r3-approval-undefined') },
  });
  expectMediaDomainClosed(undefinedResponse, 'realMediaApproval 显式 undefined');
  assert.equal(undefinedApp.mediaService.failClosedReason, REAL_MEDIA_APPROVAL_REQUIRED_REASON);
});

test('GY-I06 r3 B3（等价夹具）：模块求值期副作用把真实端口挂到全局 ⇒ 默认装配仍整域 503，零外呼', async (t) => {
  // 等价于复审 r2-B3 的「链路文件里加 1 行副作用 import / 在模块求值期构造真实适配器」：
  // 这里把副作用直接摆在进程里（构造真实端口并挂到 globalThis），同时把 ambient 四键也注入齐备。
  // 判据：默认装配（不注入端口、不注入批准）必须仍整域 503，且副作用端口一次都没被调用。
  const restoreEnv = injectAmbientStorageEnv();
  t.after(() => restoreEnv());
  const sideEffectStore = createS3CompatibleObjectStore(R3_SYNTHETIC_STORE_CONFIG);
  const globalKey = '__GY_I06_R3_SIDE_EFFECT_STORE__';
  globalThis[globalKey] = sideEffectStore;
  t.after(() => {
    delete globalThis[globalKey];
  });
  assert.equal(sideEffectStore.externalRequestCount, 0);

  const store = createMemoryAuthStore();
  const app = buildApp({ config: { ...baseConfig(), executionMode: 'real' }, store });
  t.after(() => app.close());
  const token = await synthesizeSession(store, 'synthetic-r3-side-effect');

  assert.equal(app.mediaObjectStore.kind, 'unwired', '全局上的真实端口不得被默认装配采信');
  assert.equal(app.mediaService.failClosedReason, REAL_MEDIA_APPROVAL_REQUIRED_REASON);
  for (const [method, url, options] of mediaRouteRequests('r3-side-effect')) {
    expectMediaDomainClosed(await call(app, method, url, token, options), `${method} ${url}（模块求值期副作用端口）`);
  }
  assert.equal(sideEffectStore.externalRequestCount, 0, '副作用构造的适配器一次都不得被调用');
  assert.equal(globalThis[globalKey], sideEffectStore, '取证：副作用端口确实一直挂在全局上（判据不是靠它不存在）');
});

test('GY-I06 r3 B4（等价夹具）：原型链上的端口/批准能力一律不算数，单次启动内改装配值也不开闸，且零残留', async (t) => {
  const prototypeBefore = Object.getOwnPropertyNames(Object.prototype).sort();
  const restoreEnv = injectAmbientStorageEnv();
  t.after(() => restoreEnv());

  // 1) 等价于复审 r2-B4 的 `Object.prototype` 投毒：端口与批准能力**沿原型链可达但不是自有属性**。
  //    这里用 `Object.create` 造等价的「被污染选项对象」而不是真的污染 `Object.prototype`：
  //    进程级污染会让 Fastify/ajv 的 schema 遍历把原型属性当成 schema 节点 ⇒ 栈溢出（测试环境自身
  //    的副作用，HTTP 夹具无法表达）；判定逻辑是同一处 `Object.hasOwn` + 同一处 WeakSet 品牌检查。
  const poisonProto = {
    objectStore: createS3CompatibleObjectStore(R3_SYNTHETIC_STORE_CONFIG),
    realMediaApproval: { reason: 'r3 原型投毒夹具', approvedAt: '2026-10-16T00:00:00.000Z' },
  };
  const poisonedOptions = Object.create(poisonProto);
  poisonedOptions.executionMode = 'real';
  poisonedOptions.tokenSecret = 'synthetic-token-secret';
  const poisonedService = createAppMediaService(poisonedOptions);
  assert.equal(poisonedService.objectStore.kind, 'unwired', '原型链上的端口不得成为执行端口');
  assert.equal(poisonedService.failClosedReason, REAL_MEDIA_APPROVAL_REQUIRED_REASON, '原型链上的批准能力不得被采信');

  // 同一原型、把批准能力放成**自有属性** ⇒ 立刻可用（证明否定的只是「原型链来源」，不是能力本身/端口本身）。
  const ownOptions = Object.create(poisonProto);
  ownOptions.executionMode = 'real';
  ownOptions.tokenSecret = 'synthetic-token-secret';
  ownOptions.realMediaApproval = mintApproval('r3 B4 自有属性夹具');
  const ownService = createAppMediaService(ownOptions);
  assert.equal(ownService.failClosedReason, null, '自有属性提供的批准能力必须被采信');
  assert.equal(ownService.objectStore.kind, 's3_compatible');
  assert.equal(poisonProto.objectStore.externalRequestCount, 0, '能力判定本身不得引发任何外呼');

  // 2) 等价的「进程级原型投毒」在 app 边界上表达：选项对象从原型上**继承**端口与批准能力
  //    （`buildApp` 的形参解构会沿原型链取值 ⇒ 端口**确实**被装成真实端口），但服务层按
  //    `Object.hasOwn` 判定 ⇒ 原型来源的批准能力不算数 ⇒ 媒体域仍整域 503。
  //    注：直接污染真正的 `Object.prototype`（对象值）在本进程内**无法**与 Fastify/ajv 共存：
  //    任何 `for…in` 遍历都会顺着原型自我递归而栈溢出（已实测 `RangeError: Maximum call stack size exceeded`），
  //    因此用「选项对象带原型」这一同机制夹具表达。判据落在同一处 `Object.hasOwn`。
  const prototypePortedStore = createS3CompatibleObjectStore(R3_SYNTHETIC_STORE_CONFIG);
  const poisonedAppOptions = Object.create({
    mediaObjectStore: prototypePortedStore,
    realMediaApproval: { reason: 'r3 原型投毒夹具（对象值）', approvedAt: '2026-10-16T00:00:00.000Z' },
  });
  poisonedAppOptions.config = { ...baseConfig(), executionMode: 'real' };
  const poisonedStore = createMemoryAuthStore();
  poisonedAppOptions.store = poisonedStore;
  const poisonedApp = buildApp(poisonedAppOptions);
  t.after(() => poisonedApp.close());
  const poisonedToken = await synthesizeSession(poisonedStore, 'synthetic-r3-prototype-poison');
  assert.equal(
    poisonedApp.mediaObjectStore,
    prototypePortedStore,
    '取证：原型上的端口确实被装配层装上了（这不是判据失败 —— 闸门在批准能力上）',
  );
  assert.equal(poisonedApp.mediaService.objectStore.kind, 'unwired', '原型来源的批准能力不得打开执行端口');
  assert.equal(poisonedApp.mediaService.failClosedReason, REAL_MEDIA_APPROVAL_REQUIRED_REASON);
  for (const [method, url, options] of mediaRouteRequests('r3-prototype')) {
    expectMediaDomainClosed(await call(poisonedApp, method, url, poisonedToken, options), `${method} ${url}（原型链投毒）`);
  }
  assert.equal(prototypePortedStore.externalRequestCount, 0, '原型投毒端口一次都不得被调用');

  // 3) 单次启动内改装配值（one-launch tamper）：装饰值被改成谎报 kind 的假端口，
  //    服务层只信构造期端口与构造期批准能力 ⇒ 仍整域 503（假 kind 骗不过闸门）。
  const tamperStore = createMemoryAuthStore();
  const app = buildApp({ config: { ...baseConfig(), executionMode: 'real' }, store: tamperStore });
  t.after(() => app.close());
  const tamperToken = await synthesizeSession(tamperStore, 'synthetic-r3-one-launch-tamper');
  const beforeTamper = await call(app, 'POST', '/api/v1/media/uploads', tamperToken, {
    payload: DECLARED,
    headers: { 'idempotency-key': KEY('r3-tamper-before') },
  });
  expectMediaDomainClosed(beforeTamper, '改装配值之前');
  app.mediaObjectStore = {
    kind: 's3_compatible',
    note: 'r3 夹具：谎报 kind 的假端口',
    externalRequestCount: 0,
    putObject: async () => {},
    getObject: async () => null,
    hasObject: async () => false,
    deleteObject: async () => {},
    objectCount: async () => 0,
    presignUpload: async () => ({ method: 'PUT', url: 'https://synthetic-object-storage.invalid/', headers: {}, expiresAt: new Date().toISOString() }),
    presignDownload: async () => ({ method: 'GET', url: 'https://synthetic-object-storage.invalid/', headers: {}, expiresAt: new Date().toISOString() }),
  };
  const afterTamper = await call(app, 'POST', '/api/v1/media/uploads', tamperToken, {
    payload: DECLARED,
    headers: { 'idempotency-key': KEY('r3-tamper-after') },
  });
  expectMediaDomainClosed(afterTamper, '改装配值之后（谎报 kind 的假端口）');
  assert.equal(app.mediaService.objectStore.kind, 'unwired', '服务层端口来自构造期，不来自可变的装饰值');
  assert.equal(app.mediaService.failClosedReason, REAL_MEDIA_APPROVAL_REQUIRED_REASON);

  // 4) 零残留。
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), prototypeBefore, 'Object.prototype 必须零残留');
  assert.equal(poisonProto.objectStore.externalRequestCount, 0);
});

test('GY-I06 r3 路由装配守卫：媒体路由只允许经 service 的具名操作与 failClosedReason 取端口，7 条入口都仍在 requireUser 之后', () => {
  const parsed = parseRepoFile('services/api/src/routes/media.ts');
  const guard = mediaRouteRegistrationGuard(parsed);

  // 该文件对 `service` 的全部取用必须是**具名操作**或 fail-closed 读点，不得把端口/存储暴露给路由层。
  assert.deepEqual(
    guard.serviceProps,
    [
      'completeUpload',
      'deleteMedia',
      'failClosedReason',
      'getMedia',
      'grantCommunityMediaAccess',
      'grantMediaAccess',
      'initiateUpload',
      'readCommunityMediaContent',
    ],
    '媒体路由只允许这些 service 成员（新增/挪动端口取用 ⇒ 本判据红，需人工确认）',
  );
  assert.equal(guard.registrations.length, 7, `媒体路由必须恰好 7 条，实测 ${JSON.stringify(guard.registrations.map((r) => `${r.method} ${r.path}`))}`);
  for (const registration of guard.registrations) {
    assert.ok(
      String(registration.preHandler).includes('guards.requireUser'),
      `${registration.method} ${registration.path} 必须在 guards.requireUser 之后（实测 preHandler=${registration.preHandler}）`,
    );
  }
  assert.equal(guard.requireUserCount, 7, 'requireUser 必须逐条出现在 7 条入口上（少一条即红）');
});

test('GY-I06 r3 启发式覆盖清单：静态判据已降级为回归护栏（打印覆盖与未覆盖，供审查对照）', () => {
  // 静态/文本判据**不是**安全闸门（r2 的 B1–B5 已证明封闭世界的静态判据可被整体绕过），
  // 它们只是「有人在 app.ts 里重新引入 ambient 门控」这类回归的早期告警。这里把它们跑一遍，
  // 并把**覆盖**与**未覆盖**如实打印出来（`node --test` 默认吞掉 stdout，加 `--test-reporter=spec` 可见）。
  const app = parseRepoFile('services/api/src/app.ts');
  const provenance = auditMediaPortProvenance(app);
  const ambient = auditAmbientEnv(app, APP_AMBIENT_ENV_ALLOWLIST);
  const callSites = productionStoreFactoryCallSites('services/api/src', [MEDIA_RESOLVER, REAL_STORE_FACTORY]);
  const ownedMediaChain = MEDIA_CHAIN_FILES.map((repoPath) => ({ repoPath, findings: auditAmbientEnv(parseRepoFile(repoPath), []).findings }));

  assert.deepEqual(provenance.violations, [], '启发式：app.ts 端口溯源零违规');
  assert.deepEqual(ambient.violations, [], '启发式：app.ts ambient env 读取零违规');
  assert.ok(ownedMediaChain.every((entry) => entry.findings.length === 0), '启发式：媒体链路文件不得读 ambient env');
  assert.deepEqual(
    callSites.sites.filter((site) => site.name === MEDIA_RESOLVER).map((site) => `${site.file}#${site.enclosing}`),
    ['services/api/src/app.ts#buildApp', 'services/api/src/media/real-ports.ts#resolveMediaRealPorts'],
    '启发式：resolver 生产调用点必须恰好两处（app.ts 的零注入回退、media/real-ports.ts 的批准驱动装配）',
  );
  assert.deepEqual(
    callSites.sites.filter((site) => site.name === REAL_STORE_FACTORY).map((site) => `${site.file}#${site.enclosing}`),
    ['services/api/src/media/object-store.ts#resolveMediaObjectStore'],
    '启发式：真实适配器工厂生产调用点必须恰好一处（resolver 内部）',
  );

  const coverage = [
    '【启发式覆盖（回归护栏，非安全闸门）】',
    `1. app.ts 端口溯源：声明/初值/服务实参/角色枚举 → ${provenance.violations.length} 违规`,
    `2. app.ts ambient env 读取：整表/动态/未白名单键 → ${ambient.violations.length} 违规（白名单恰 ${ambient.findings.length} 个非媒体键）`,
    `3. 媒体链路文件（${MEDIA_CHAIN_FILES.length} 个）ambient env 读取 → ${ownedMediaChain.reduce((sum, entry) => sum + entry.findings.length, 0)} 违规`,
    `4. 生产调用点：${MEDIA_RESOLVER} → 2 处（app.ts#buildApp 的零注入回退、media/real-ports.ts#resolveMediaRealPorts 的批准驱动装配）、${REAL_STORE_FACTORY} → 1 处（object-store.ts#resolveMediaObjectStore）`,
    `5. 扫描面：services/api/src 下 ${callSites.scannedFiles} 个 .ts/.mts/.mjs，其中 ${callSites.candidateFiles} 个提到过工厂名`,
    '6. 运行时来源/身份：装配期与请求期的 env 探针（上一条用例）+ 服务层构造期身份（本文件 3 条 r3 用例）',
    '',
    '【未覆盖 / 已知盲区（静态判据一律抓不到，只能由运行期闸门兜底）】',
    'a. 被测文件之外的入口层：services/api/src/server.ts、tools/**、scripts/** 或任何调用方自行铸造批准的包装 —— 静态扫描只认文件内的调用点名字（片 W2 起 server.ts 由 real-ports 的启动参数驱动，其「是否该接」由运行期拒绝原因兜底，不由本判据判定）。',
    'b. 自造等价构造：改名/包装工厂、自建 makeObjectStore() 返回真实适配器、monkey-patch 已审工厂 —— 只认对象身份与调用点名字的文本判据无感。',
    'c. 动态取用：import { env } from \'node:process\'、globalThis[\'pro\'+\'cess\'].env、eval/Function 构造 —— AST 规则只识别已枚举的 process 根与字面键。',
    'd. 模拟/伪造测试环境：把 approveRealMediaWiring 换成同名伪造导出、篡改 WeakSet、在测试进程里预置批准 —— 单测无法自证「测试环境本身没被替换」。',
    'e. 真实 COS/S3 往返、桶侧 ACL/生命周期、预签名有效期与撤销 —— 本任务不授权真实外呼，一律未取得。',
    'f. 采样盲区：运行时探针只覆盖「一次装配 + 一轮请求」，未触达的惰性分支不会被记录。',
    'g. 时间窗：构造之后的进程级篡改只在一定程度上被服务层构造期身份兜底；批准能力一旦被真实接线方持有，其后续用途不在此判据范围内。',
  ];
  console.log(coverage.join('\n'));
});
