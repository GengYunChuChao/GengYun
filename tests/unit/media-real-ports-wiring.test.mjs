// GY-R28 · W2 —— 媒体域 `real` 模式真实端口接线的**正向读数**。
//
// 与 `media-real-mode-fail-closed.test.mjs`（负控制：未接线一律 503）互补，本文件断言：
//   1. `--approve-real-media-wiring` + `OBJECT_STORAGE_*` 齐备 ⇒ 媒体域**不再是 503**：上传三段式
//      （`POST /media/uploads` → 客户端 PUT 字节 → `/complete`）在 `real` 下走通，且字节**真的**进了
//      对象存储适配器的 HTTP 写路径（预签名 PUT + `x-amz-content-sha256`）；
//   2. 图片仍走「读原始对象 → `stripImageMetadata` → 写衍生物」：`derivativeRef` 非 null，
//      EXIF/GPS 在衍生物里被真的剥掉，原始对象原样保留；
//   3. owner 私有字节读（服务层内部函数 `readOwnerMediaContent`，**无外部出口**）在 `real` 下可取回衍生物；
//   4. 负控制：**同样的真实配置**但不给启动参数 ⇒ 端口仍 `unwired`、媒体域仍 503
//      `PROVIDER_UNAVAILABLE`（`retryable: false`），与零注入的 main 行为一致。
//
// 本地数据面（不含真实凭据/真实桶/外呼）：
//   - endpoint 用保留域 `https://storage.example.test`（RFC 6761，永不解析）；
//   - 测试把 `globalThis.fetch` 换成「转本机 loopback `node:http` 桶替身」的代理：TCP socket、HTTP 帧、
//     请求头（含 SigV4 预签名 query）、body 字节都是真的，只有主机名映射是替身
//     （TLS 与真实桶未取得，属未授权外呼）。
//   - `real` 模式要求在持久会话存储上签发会话；单测不连 PG，故注入**自称 persistent 的内存存储**
//     （只影响 auth 域，不影响任何媒体断言；真库读数见证据页）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import {
  createS3CompatibleObjectStore,
  createSubstituteObjectStore,
} from '../../services/api/src/media/object-store.ts';
import { approveRealMediaWiring, readOwnerMediaContent } from '../../services/api/src/media/service.ts';
import {
  MEDIA_REAL_WIRING_FLAG,
  MEDIA_REAL_WIRING_REFUSALS,
  MediaRealWiringError,
  createMediaRealPorts,
  mediaRealPortsAssemblyOptions,
  resolveMediaRealPorts,
} from '../../services/api/src/media/real-ports.ts';
import { sha256Hex } from '../../packages/media/validate.mjs';
import { jpegWithExif } from '../media/_fixtures.mjs';

const STORAGE_HOST = 'storage.example.test';
const BUCKET = 'gy-media';
const SECRET_MARKER = 'w2-test-secret-do-not-log';
const UPLOAD_KEY = 'media-real-create-0000';

/** `OBJECT_STORAGE_*` 齐备的真实配置（凭据是**明显合成的测试值**，不是任何真实 AK/SK）。 */
function realEnv(overrides = {}) {
  return {
    APP_EXECUTION_MODE: 'real',
    LOG_LEVEL: 'silent',
    // `real` 模式的其余必填项（与 `tests/unit/admin-real-mode-fail-closed.test.mjs:30-42` 同形的合成占位，
    // 不是任何真实凭据；`DATABASE_URL` 指向永不可达的合成库，测试只在内存存储上跑）。
    DATABASE_URL: 'postgres://synthetic_local_only@127.0.0.1:5432/gengyun_synthetic_never_connected',
    SESSION_SIGNING_KEY: 'synthetic-not-a-real-signing-key',
    DELETION_LEDGER_KEY: 'synthetic-not-a-real-ledger-key',
    WECHAT_APP_ID: 'synthetic-not-a-real-appid',
    WECHAT_APP_SECRET: 'synthetic-not-a-real-appsecret',
    OBJECT_STORAGE_ENDPOINT: `https://${STORAGE_HOST}`,
    OBJECT_STORAGE_BUCKET: BUCKET,
    OBJECT_STORAGE_ACCESS_KEY: 'AKIDW2SYNTHETICONLY',
    OBJECT_STORAGE_SECRET_KEY: SECRET_MARKER,
    OBJECT_STORAGE_REGION: 'ap-shanghai',
    OBJECT_STORAGE_FORCE_PATH_STYLE: 'true',
    MEDIA_ACCESS_GRANT_ORIGIN: 'https://media.example.test',
    ...overrides,
  };
}

/**
 * 自称 `persistent` 的内存 auth 存储（real 模式的会话闸门要求；见文件头说明）。
 */
function persistentAuthStore() {
  const memory = createMemoryAuthStore();
  const store = Object.create(memory);
  Object.defineProperty(store, 'persistent', { value: true, enumerable: true });
  return store;
}

/**
 * 直接签一份会话（不经微信登录路由：`real` 模式下该路由会外呼真实供应商，
 * 单测不发出任何外呼）。手法同 `tests/unit/admin-real-mode-fail-closed.test.mjs:132`。
 */
async function authenticate(store, subjectHex) {
  const user = await store.createUser(subjectHex);
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

/** 本机 loopback 桶替身：按路径存取字节（签名正确性由 s3-paths 用例独立逐字节复算）。 */
function startBucket() {
  const objects = new Map();
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://loopback');
      const key = decodeURIComponent(url.pathname.replace(new RegExp(`^/${BUCKET}/`), ''));
      const body = Buffer.concat(chunks);
      requests.push({
        method: request.method,
        key,
        contentType: request.headers['content-type'] ?? null,
        payloadHash: request.headers['x-amz-content-sha256'] ?? null,
        signed: url.searchParams.get('X-Amz-Signature') !== null,
        bytes: body.length,
      });
      if (request.method === 'PUT') {
        objects.set(key, { bytes: body, contentType: request.headers['content-type'] ?? 'application/octet-stream' });
        response.writeHead(200, { etag: '"w2-test-etag"' });
        response.end();
        return;
      }
      if (request.method === 'DELETE') {
        objects.delete(key);
        response.writeHead(204);
        response.end();
        return;
      }
      const stored = objects.get(key);
      if (request.method === 'GET' && stored !== undefined) {
        response.writeHead(200, { 'content-type': stored.contentType, 'content-length': String(stored.bytes.length) });
        response.end(stored.bytes);
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('missing');
    });
  });
  return { server, objects, requests };
}

/**
 * 把 `globalThis.fetch` 指向 loopback 桶替身（只拦保留域主机，其余原样放行）。
 * 保留签名身份：请求行与 `host` 头都保持**签名时的**主机名，适配器看到的响应与真实端点同形。
 */
function installStorageProxy(port) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.host !== STORAGE_HOST) return original(input, init);
    seen.push({ method: init.method ?? 'GET', path: `${url.pathname}${url.search}` });
    const payload = init.body === undefined ? undefined : Buffer.from(init.body);
    const result = await new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: init.method ?? 'GET',
          path: `${url.pathname}${url.search}`,
          headers: { ...(init.headers ?? {}), host: url.host },
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, headers: response.headers, bytes: Buffer.concat(chunks) }),
          );
        },
      );
      request.on('error', reject);
      if (payload !== undefined) request.write(payload);
      request.end();
    });
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      headers: { get: (name) => result.headers[String(name).toLowerCase()] ?? null },
      arrayBuffer: async () => {
        const { bytes } = result;
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
      },
    };
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
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
  return { status: response.statusCode, body, raw: response.rawPayload };
}

test('GY-R28 W2 真实端口接线：real 下上传三段式 200、衍生物去 EXIF、owner 内部读面可取字节', async (t) => {
  const bucket = startBucket();
  await new Promise((resolve) => bucket.server.listen(0, '127.0.0.1', resolve));
  const { port } = bucket.server.address();
  const proxy = installStorageProxy(port);
  t.after(async () => {
    proxy.restore();
    await new Promise((resolve) => bucket.server.close(resolve));
  });

  const config = loadConfig(realEnv());
  assert.equal(config.executionMode, 'real');
  assert.notEqual(config.objectStorage, null, '四键齐备时 config.objectStorage 必须非 null');

  const ports = resolveMediaRealPorts({ config, argv: ['node', 'server.ts', MEDIA_REAL_WIRING_FLAG] });
  assert.notEqual(ports, null, '给了启动参数就必须解析出真实端口');
  assert.equal(ports.objectStore.kind, 's3_compatible');
  assert.equal(ports.persistence, 'process_memory');

  const authStore = persistentAuthStore();
  const app = buildApp({ config, store: authStore, ...mediaRealPortsAssemblyOptions(ports) });
  t.after(() => app.close());
  assert.equal(app.mediaObjectStore.kind, 's3_compatible', '媒体域必须拿到 S3 兼容端口');
  assert.equal(app.mediaService.failClosedReason, null, '接线后媒体域不得再有 fail-closed 原因');

  const { token, user } = await authenticate(authStore, 'ab'.repeat(32));
  const jpeg = jpegWithExif();
  const declared = { purpose: 'weed_recognition', mime: 'image/jpeg', bytes: jpeg.length, sha256: sha256Hex(jpeg) };

  // ---- ① createUpload ----
  const created = await call(app, 'POST', '/api/v1/media/uploads', token, {
    payload: declared,
    headers: { 'idempotency-key': UPLOAD_KEY },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.meta.execution_mode, 'real');
  assert.equal(created.body.data.media.state, 'initiated');
  assert.equal(created.body.data.media.revision, 1);
  const serialized = JSON.stringify(created.body);
  // 注意：预签名 URL 的 `X-Amz-Credential` 里**必然**带 access key id（SigV4 凭据范围，非机密）；
  // 机密是 secret key，故只断言后者不出现。
  for (const forbidden of ['OBJECT_STORAGE', SECRET_MARKER, 'rawRef', 'derivativeRef']) {
    assert.ok(!serialized.includes(forbidden), `响应泄露 ${forbidden}`);
  }
  // 写路径的句柄是**直接指向对象存储端点**的预签名 URL（`service.ts:848/864` `objectStore.presignUpload`）；
  // `MEDIA_ACCESS_GRANT_ORIGIN` 只治理读路径的网关 URL（`service.ts:1089/1210`）。如实断言，不臆测。
  assert.ok(
    created.body.data.upload.url.startsWith(`https://${STORAGE_HOST}/${BUCKET}/`),
    `上传句柄必须指向真实对象存储端点：${created.body.data.upload.url}`,
  );
  assert.match(created.body.data.upload.url, /X-Amz-Signature=[0-9a-f]{64}/, '上传句柄必须是 SigV4 预签名 URL');
  const mediaId = created.body.data.media.id;

  // ---- ② 客户端 PUT 字节（真的经适配器 HTTP 写路径落到对象存储） ----
  const keys = await app.mediaService.serverObjectKeys(mediaId);
  assert.ok(keys !== null && typeof keys.rawRef === 'string', '必须签发原始对象键');
  assert.equal(keys.derivativeRef, null, '未 complete 前不得有衍生物');
  await app.mediaObjectStore.putObject(keys.rawRef, jpeg, 'image/jpeg');
  const storedRaw = bucket.objects.get(keys.rawRef);
  assert.ok(storedRaw !== undefined, '字节必须已经落到对象存储');
  assert.deepEqual([...storedRaw.bytes], [...jpeg], '落库字节必须与上传字节逐字节一致');
  const putRecord = bucket.requests.find((entry) => entry.method === 'PUT' && entry.key === keys.rawRef);
  assert.ok(putRecord !== undefined, '必须观察到一次真实的适配器 PUT');
  assert.equal(putRecord.signed, true, 'PUT 必须是 SigV4 预签名 URL');
  assert.equal(putRecord.payloadHash, 'UNSIGNED-PAYLOAD', 'PUT 必须带 x-amz-content-sha256');
  assert.equal(putRecord.contentType, 'image/jpeg');

  // ---- ③ complete：读回原始对象 → stripImageMetadata → 写衍生物 ----
  const completed = await call(app, 'POST', `/api/v1/media/uploads/${mediaId}/complete`, token, {
    payload: { sha256: sha256Hex(jpeg), bytes: jpeg.length },
    headers: { 'idempotency-key': 'media-real-complete-0000', 'if-match': '"1"' },
  });
  // 契约 `completeUpload` 是 **202 Accepted** + `MediaEnvelope`（`routes/media.ts:9`），不是 200。
  assert.equal(completed.status, 202, JSON.stringify(completed.body));
  assert.equal(completed.body.data.state, 'ready');
  assert.equal(completed.body.meta.execution_mode, 'real');

  const after = await app.mediaService.serverObjectKeys(mediaId);
  assert.equal(typeof after.derivativeRef, 'string', '`derivativeRef` 必须非 null');
  assert.notEqual(after.derivativeRef, after.rawRef, '衍生物必须是独立对象');
  const storedDerivative = bucket.objects.get(after.derivativeRef);
  assert.ok(storedDerivative !== undefined, '衍生物必须真的写进对象存储');
  assert.deepEqual([...bucket.objects.get(after.rawRef).bytes], [...jpeg], '原始对象必须原样保留');

  const rawBytes = storedDerivative === undefined ? Buffer.alloc(0) : bucket.objects.get(after.rawRef).bytes;
  assert.equal(rawBytes.includes(Buffer.from('Exif', 'latin1')), true, '原始对象应保留 EXIF（夹具带 GPS/EXIF）');
  assert.equal(storedDerivative.bytes.includes(Buffer.from('Exif', 'latin1')), false, '衍生物必须不含 EXIF 标记');
  assert.equal(storedDerivative.bytes.includes(Buffer.from('GPS', 'latin1')), false, '衍生物必须不含 GPS 标记');
  assert.ok(
    storedDerivative.bytes.length > 0 && storedDerivative.bytes.length < rawBytes.length,
    `衍生物应比原始对象小（元数据被剥掉）：raw=${rawBytes.length} derivative=${storedDerivative.bytes.length}`,
  );

  // ---- ④ owner 私有字节读（服务层内部函数，无外部出口） ----
  assert.ok(typeof user.id === 'string' && user.id.length > 0, '必须拿到 owner 身份');
  const ownerRead = await readOwnerMediaContent(app.mediaService, {
    actor: { ownerId: user.id, authEpoch: user.authEpoch, sessionRef: 'w2-test-session' },
    mediaId,
  });
  assert.equal(ownerRead.status, 200);
  assert.equal(ownerRead.source, 'derivative', '有衍生物时只取衍生物（原始对象永不出网）');
  assert.equal(ownerRead.contentType, 'image/jpeg');
  assert.deepEqual([...ownerRead.bytes], [...storedDerivative.bytes], '内部读面取到的必须是衍生物字节');

  await assert.rejects(
    async () =>
      readOwnerMediaContent(app.mediaService, {
        actor: { ownerId: 'someone-else', authEpoch: 1, sessionRef: 'w2-test-session' },
        mediaId,
      }),
    (error) => error.code === 'NOT_FOUND' || error.statusCode === 404,
    '非 owner 读私有字节必须拒绝',
  );

  // ---- ⑤ 负控制：同样的真实配置、不给启动参数 ⇒ 端口仍 unwired、媒体域仍 503 ----
  assert.equal(resolveMediaRealPorts({ config, argv: ['node', 'server.ts'] }), null);
  const plainStore = persistentAuthStore();
  const plainApp = buildApp({ config, store: plainStore });
  try {
    assert.equal(plainApp.mediaObjectStore.kind, 'unwired', '零注入 + 真实配置仍必须是 unwired');
    assert.equal(typeof plainApp.mediaService.failClosedReason, 'string');
    const { token: plainToken } = await authenticate(plainStore, 'cd'.repeat(32));
    const closed = await call(plainApp, 'POST', '/api/v1/media/uploads', plainToken, {
      payload: declared,
      headers: { 'idempotency-key': 'media-real-zero-0000' },
    });
    assert.equal(closed.status, 503, JSON.stringify(closed.body));
    assert.equal(closed.body.error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(closed.body.error.retryable, false, '未接线＝能力未装配，重试无用');
    assert.equal(closed.body.data, undefined);
    assert.equal(closed.body.meta.execution_mode, 'real');
  } finally {
    await plainApp.close();
  }
});

test('GY-R28 W2 接线拒绝：闭集 6 条原因逐条落定，对外码唯一、retryable=false', () => {
  const config = loadConfig(realEnv());
  const flag = ['node', 'server.ts', MEDIA_REAL_WIRING_FLAG];
  const realStore = createS3CompatibleObjectStore(config.objectStorage);

  const observed = [];
  const attempt = (label, run) => {
    try {
      run();
      observed.push([label, null]);
    } catch (error) {
      assert.ok(error instanceof MediaRealWiringError, `${label} 必须是 MediaRealWiringError，实为 ${String(error)}`);
      assert.equal(error.errorCode, 'PROVIDER_UNAVAILABLE', `${label} 对外码必须是契约闭集里的值`);
      assert.equal(error.retryable, false, `${label} 重试无用`);
      observed.push([label, error.refusal]);
    }
  };

  attempt('模式不是 real', () => resolveMediaRealPorts({ config: { ...config, executionMode: 'stub' }, argv: flag }));
  attempt('四键不齐', () => resolveMediaRealPorts({ config: { ...config, objectStorage: null }, argv: flag }));
  attempt('网关原点仍是占位域', () =>
    resolveMediaRealPorts({ config: { ...config, mediaAccessGrantOrigin: null }, argv: flag }),
  );
  attempt('未铸造的批准能力', () =>
    createMediaRealPorts({ objectStore: realStore, approval: { reason: 'forged' }, persistence: 'process_memory' }),
  );
  attempt('替身端口冒充真实存储', () =>
    createMediaRealPorts({
      objectStore: createSubstituteObjectStore(),
      approval: approveRealMediaWiring({ reason: 'w2-test' }),
      persistence: 'process_memory',
    }),
  );
  attempt('持久化口径不受支持', () =>
    createMediaRealPorts({
      objectStore: realStore,
      approval: approveRealMediaWiring({ reason: 'w2-test' }),
      persistence: 'postgres',
    }),
  );

  assert.deepEqual(
    observed.map(([, refusal]) => refusal),
    [
      'execution_mode_not_real',
      'object_storage_not_configured',
      'access_grant_origin_not_deployable',
      'approval_not_minted',
      'object_store_not_s3_compatible',
      'persistence_unsupported',
    ],
    '拒绝原因必须逐条命中闭集',
  );
  assert.deepEqual(
    [...observed.map(([, refusal]) => refusal)].sort(),
    [...MEDIA_REAL_WIRING_REFUSALS].sort(),
    '闭集每一条都必须被至少一条反例覆盖（闭集扩张即红）',
  );
});
