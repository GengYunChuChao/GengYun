/**
 * R27-S8 · S3 兼容对象存储适配器的**真实代码路径**（Refs #6）。
 *
 * 背景：`createS3CompatibleObjectStore` / `presignS3Url` 此前在本仓库内只有**结构断言**
 * （https 前缀、必需 `X-Amz-*` 查询参数、未发起网络请求），`putObject` / `getObject` /
 * `hasObject` / `deleteObject` / `presignUpload` / `presignDownload` 的**一行可执行语句都没被执行过**。
 *
 * 本文件做两件事：
 * 1. 用**进程内 `fetch` 替身**（替换 `globalThis.fetch`，`try/finally` 还原）把上述真实代码路径跑起来，
 *    并对替身收到的**每一次**调用的方法/头/体/URL 做断言；
 * 2. 用**测试内独立重算**的 SigV4（自写规范化查询串 + `HMAC-SHA256` 链，只用 `node:crypto`）
 *    与 `presignS3Url` / `presignUpload` / `presignDownload` 产出的 `X-Amz-Signature` **逐字节比对**
 *    —— 不从被测文件 import 任何中间量，避免「自己验自己」。
 *
 * 硬边界（如实，务必随证据页一起读）：
 * - **合成本地 `fetch` 替身，非真实供应商**：没有对接任何真实 COS/S3 桶、没有真实签名往返，
 *   也没有任何真实网络请求（`globalThis.fetch` 与 `http(s).request/get` 在本文件内一律被替身/绊线接管）。
 * - 被测适配器**一行产品可执行语句都没有改**；本文件只补断言。
 * - 沙箱约束：本机默认隔离跑法会 `spawn EPERM`，故用 `node --test --test-isolation=none <本文件>`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { createHash, createHmac } from 'node:crypto';

import { MediaError } from '../../packages/media/index.mjs';
import { createS3CompatibleObjectStore, presignS3Url } from '../../services/api/src/media/object-store.ts';

// ---------------------------------------------------------------- 合成配置与固定输入

/** 合成配置：桶名/凭据都是占位值，不对应任何真实账号或桶。 */
const CONFIG = {
  endpoint: 'https://cos.ap-shanghai.myqcloud.com',
  bucket: 'gengyun-media-placeholder',
  accessKey: 'synthetic-access-key-id',
  secretKey: 'synthetic-secret-key-value',
  region: 'ap-shanghai',
  forcePathStyle: false,
};
const PATH_STYLE_CONFIG = { ...CONFIG, forcePathStyle: true };
/** 含非 ASCII 与空格的对象键：用来证明 RFC3986 百分号编码真的走了一遍。 */
const OBJECT_KEY = 'media/2026/10/用户 头像 v1.jpg';
const OBJECT_KEY_ENCODED_PATH = '/media/2026/10/%E7%94%A8%E6%88%B7%20%E5%A4%B4%E5%83%8F%20v1.jpg';
const FIXED_NOW = new Date('2026-10-20T06:30:12.345Z');
const FIXED_AMZ_DATE = '20261020T063012Z';

// ---------------------------------------------------------------- 独立重算的 SigV4（不复用被测代码）

/** RFC3986：AWS 要求只有 `A-Za-z0-9-_.~` 不编码。 */
function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hmacSha256(key, data) {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** `Date` ⇒ `YYYYMMDD'T'HHMMSS'Z'`（毫秒截断，与 SigV4 的 `X-Amz-Date` 同形）。 */
function toAmzDate(date) {
  return `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

/** `YYYYMMDD'T'HHMMSS'Z'` ⇒ `Date`（秒精度，UTC）。 */
function fromAmzDate(amzDate) {
  const matched = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  assert.ok(matched !== null, `X-Amz-Date 形状非法：${String(amzDate)}`);
  return new Date(
    Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]), Number(matched[4]), Number(matched[5]), Number(matched[6])),
  );
}

/**
 * 独立重算一条 SigV4 预签名（只读入「人给的输入」：config / method / key / expiresInSeconds / amzDate）。
 * 返回的不只是签名，还有**整条规范化查询串**与规范化请求明文，方便断言逐字节相等。
 */
function independentSigV4({ config, method, key, expiresInSeconds, amzDate }) {
  const endpoint = new URL(config.endpoint);
  const host = config.forcePathStyle ? endpoint.host : `${config.bucket}.${endpoint.host}`;
  const encodedKey = key.split('/').map(encodeRfc3986).join('/');
  const path = config.forcePathStyle ? `/${config.bucket}/${encodedKey}` : `/${encodedKey}`;
  const shortDate = amzDate.slice(0, 8);
  const scope = `${shortDate}/${config.region}/s3/aws4_request`;
  const pairs = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${config.accessKey}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresInSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ].map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)]);
  const canonicalQuery = pairs
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  const canonicalRequest = [method, path, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmacSha256(
    hmacSha256(hmacSha256(hmacSha256(`AWS4${config.secretKey}`, shortDate), config.region), 's3'),
    'aws4_request',
  );
  return {
    signature: createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex'),
    canonicalQuery,
    canonicalRequest,
    scope,
    host,
    path,
  };
}

/** 取一条预签名 URL 的 `X-Amz-Signature`。 */
function signatureOf(overrides) {
  const url = presignS3Url({
    config: CONFIG,
    method: 'GET',
    key: OBJECT_KEY,
    expiresInSeconds: 600,
    now: FIXED_NOW,
    ...overrides,
  });
  return new URL(url).searchParams.get('X-Amz-Signature');
}

// ---------------------------------------------------------------- 进程内 fetch 替身

/**
 * 安装 `fetch` 替身：记录每次调用的 `{ url, init }`，按预置队列返回 `Response`；
 * 同时把 `http(s).request/get` 换成绊线（真实外呼一律抛 `REAL_NETWORK_FORBIDDEN`）。
 * 调用方**必须**在 `finally` 里 `restore()`。
 */
function installFetchSubstitute() {
  const original = {
    fetch: globalThis.fetch,
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
  };
  const calls = [];
  const queue = [];
  const tripwire = () => {
    throw new Error('REAL_NETWORK_FORBIDDEN');
  };
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`fetch 替身没有预置响应（第 ${calls.length} 次调用：${String(init.method)} ${String(url)}）`);
    }
    return next;
  };
  http.request = tripwire;
  http.get = tripwire;
  https.request = tripwire;
  https.get = tripwire;
  return {
    calls,
    enqueue(response) {
      queue.push(response);
    },
    restore() {
      globalThis.fetch = original.fetch;
      http.request = original.httpRequest;
      http.get = original.httpGet;
      https.request = original.httpsRequest;
      https.get = original.httpsGet;
    },
  };
}

/** 断言替身收到的 URL 与「独立重算」逐字节一致（查询串含排序、签名都是同一个串）。 */
function assertUrlMatchesIndependentSignature(url, { config, method, key, expiresInSeconds }) {
  const parsed = new URL(url);
  const amzDate = parsed.searchParams.get('X-Amz-Date');
  assert.equal(typeof amzDate, 'string', 'URL 必须带 X-Amz-Date');
  const expected = independentSigV4({ config, method, key, expiresInSeconds, amzDate });
  assert.equal(parsed.searchParams.get('X-Amz-Signature'), expected.signature, '独立重算的签名逐字节相等');
  assert.equal(
    url.slice(url.indexOf('?') + 1),
    `${expected.canonicalQuery}&X-Amz-Signature=${expected.signature}`,
    '整条查询串（含参数排序）逐字节相等',
  );
  return expected;
}

// ---------------------------------------------------------------- 判据 1：签名可独立复算

test('R27-S8 判据 1：测试独立重算 SigV4（自写规范化串 + HMAC 链），与 presignS3Url 的签名逐字节相等', () => {
  const url = presignS3Url({ config: CONFIG, method: 'GET', key: OBJECT_KEY, expiresInSeconds: 600, now: FIXED_NOW });
  const parsed = new URL(url);

  // 时间戳形状与固定时钟一致（证明 now 参数真的被用上，而不是各自取墙上时钟）。
  assert.equal(parsed.searchParams.get('X-Amz-Date'), FIXED_AMZ_DATE);

  const expected = independentSigV4({
    config: CONFIG,
    method: 'GET',
    key: OBJECT_KEY,
    expiresInSeconds: 600,
    amzDate: FIXED_AMZ_DATE,
  });
  const actualSignature = parsed.searchParams.get('X-Amz-Signature');
  assert.match(actualSignature, /^[0-9a-f]{64}$/);
  assert.equal(actualSignature, expected.signature, '独立重算的签名必须与适配器产出的逐字节相等');

  // 整条查询串（含参数排序）也逐字节相等：签名是最后一个参数。
  assert.equal(url.slice(url.indexOf('?') + 1), `${expected.canonicalQuery}&X-Amz-Signature=${expected.signature}`);

  // 结构：恰好六个 `X-Amz-*` 参数，取值与输入自洽。
  assert.deepEqual([...parsed.searchParams.keys()].sort(), [
    'X-Amz-Algorithm',
    'X-Amz-Credential',
    'X-Amz-Date',
    'X-Amz-Expires',
    'X-Amz-Signature',
    'X-Amz-SignedHeaders',
  ]);
  assert.equal(parsed.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(parsed.searchParams.get('X-Amz-Expires'), '600');
  assert.equal(parsed.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.equal(
    parsed.searchParams.get('X-Amz-Credential'),
    `${CONFIG.accessKey}/20261020/ap-shanghai/s3/aws4_request`,
  );
  // 凭据边界：accessKey 进 URL（SigV4 要求），secretKey 绝不进 URL。
  assert.ok(url.includes('synthetic-access-key-id'));
  assert.ok(!url.includes(CONFIG.secretKey), '签名密钥绝不进 URL');
  // 非 ASCII 的键必须按 RFC3986 编码（不是原样塞进去、也不是 encodeURI 的宽松形态）。
  assert.ok(url.includes('%E7%94%A8%E6%88%B7%20%E5%A4%B4%E5%83%8F%20v1.jpg'));
});

// ---------------------------------------------------------------- 判据 2：签名对输入敏感

test('R27-S8 判据 2：key／method／expiresInSeconds／now 任一变更 ⇒ 签名必变（四个方向）', () => {
  const base = signatureOf({});
  assert.match(base, /^[0-9a-f]{64}$/);

  // ① 改 key
  assert.notEqual(signatureOf({ key: `${OBJECT_KEY}.bak` }), base, '改 key ⇒ 签名必变');

  // ② 改 method
  assert.notEqual(signatureOf({ method: 'PUT' }), base, 'GET⇒PUT ⇒ 签名必变');
  assert.notEqual(signatureOf({ method: 'DELETE' }), base, 'GET⇒DELETE ⇒ 签名必变');

  // ③ 改 expiresInSeconds
  assert.notEqual(signatureOf({ expiresInSeconds: 601 }), base, '600⇒601 秒 ⇒ 签名必变');

  // 四个方向都验完之后再补一次独立复算：防止「变是变了，但变得不对」。
  assertUrlMatchesIndependentSignature(
    presignS3Url({ config: CONFIG, method: 'GET', key: `${OBJECT_KEY}.bak`, expiresInSeconds: 600, now: FIXED_NOW }),
    { config: CONFIG, method: 'GET', key: `${OBJECT_KEY}.bak`, expiresInSeconds: 600 },
  );

  // ④ 改 now
  assert.notEqual(signatureOf({ now: new Date(FIXED_NOW.getTime() + 1000) }), base, 'now +1s ⇒ 签名必变');
  assert.notEqual(signatureOf({ now: new Date(FIXED_NOW.getTime() + 86400000) }), base, 'now +1d ⇒ 签名必变');
});

// ---------------------------------------------------------------- 判据 3：forcePathStyle 两分支

test('R27-S8 判据 3：forcePathStyle=true ⇒ host 不含桶且 path 以 /<bucket>/ 开头；false ⇒ host 为 <bucket>.<host>', () => {
  const virtualUrl = presignS3Url({ config: CONFIG, method: 'PUT', key: OBJECT_KEY, expiresInSeconds: 300, now: FIXED_NOW });
  const pathUrl = presignS3Url({
    config: PATH_STYLE_CONFIG,
    method: 'PUT',
    key: OBJECT_KEY,
    expiresInSeconds: 300,
    now: FIXED_NOW,
  });
  const virtual = new URL(virtualUrl);
  const path = new URL(pathUrl);

  // 虚拟主机样式（COS/S3 默认）
  assert.equal(virtual.host, `${CONFIG.bucket}.cos.ap-shanghai.myqcloud.com`);
  assert.equal(virtual.pathname, OBJECT_KEY_ENCODED_PATH);
  assert.ok(!virtual.pathname.startsWith(`/${CONFIG.bucket}/`), '虚拟主机样式不得把桶名放进 path');

  // 路径样式（自建 S3 兼容服务常用）
  assert.equal(path.host, 'cos.ap-shanghai.myqcloud.com');
  assert.equal(path.pathname, `/${CONFIG.bucket}${OBJECT_KEY_ENCODED_PATH}`);
  assert.ok(path.pathname.startsWith(`/${CONFIG.bucket}/`));
  assert.ok(!path.host.startsWith(`${CONFIG.bucket}.`), '路径样式的 host 不得含桶名');

  // 两种寻址的规范化请求不同 ⇒ 签名必须不同；且各自都能被独立复算命中。
  assert.notEqual(virtual.searchParams.get('X-Amz-Signature'), path.searchParams.get('X-Amz-Signature'));
  assertUrlMatchesIndependentSignature(virtualUrl, {
    config: CONFIG,
    method: 'PUT',
    key: OBJECT_KEY,
    expiresInSeconds: 300,
  });
  assertUrlMatchesIndependentSignature(pathUrl, {
    config: PATH_STYLE_CONFIG,
    method: 'PUT',
    key: OBJECT_KEY,
    expiresInSeconds: 300,
  });
});

// ---------------------------------------------------------------- 判据 4：putObject

test('R27-S8 判据 4：putObject 真实路径 —— 一次 PUT、头/体/六个查询参数齐备、externalRequestCount 恰好 +1', async () => {
  const store = createS3CompatibleObjectStore(CONFIG);
  assert.equal(store.externalRequestCount, 0);
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const substitute = installFetchSubstitute();
  try {
    substitute.enqueue(new Response(null, { status: 200 }));
    await store.putObject(OBJECT_KEY, bytes, 'image/jpeg');

    assert.equal(store.externalRequestCount, 1, 'putObject 恰好发起 1 次外部请求');
    assert.equal(substitute.calls.length, 1);
    const [call] = substitute.calls;

    assert.equal(call.init.method, 'PUT');
    assert.equal(call.init.headers['content-type'], 'image/jpeg', 'content-type 必须等于传入值');
    assert.equal(call.init.headers['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD');
    assert.ok(call.init.body instanceof Uint8Array, 'body 必须是原始字节');
    assert.deepEqual(Array.from(call.init.body), Array.from(bytes), 'body 字节必须等于传入字节');

    const parsed = new URL(call.url);
    for (const name of [
      'X-Amz-Algorithm',
      'X-Amz-Credential',
      'X-Amz-Date',
      'X-Amz-Expires',
      'X-Amz-SignedHeaders',
      'X-Amz-Signature',
    ]) {
      assert.ok(parsed.searchParams.has(name), `URL 必须带 ${name}`);
    }
    // send() 里的失效期是硬编码 300 秒：这是可审查的契约，不是随手值。
    assert.equal(parsed.searchParams.get('X-Amz-Expires'), '300');
    assertUrlMatchesIndependentSignature(call.url, {
      config: CONFIG,
      method: 'PUT',
      key: OBJECT_KEY,
      expiresInSeconds: 300,
    });

    // 第二次写：计数再 +1（证明是「每次外呼 +1」而不是「构造后恒 1」）。
    substitute.enqueue(new Response(null, { status: 204 }));
    await store.putObject(`${OBJECT_KEY}.2`, bytes, 'image/jpeg');
    assert.equal(store.externalRequestCount, 2);
  } finally {
    substitute.restore();
  }
});

// ---------------------------------------------------------------- 判据 5：getObject 三态

test('R27-S8 判据 5：getObject —— 200 逐字节/带 content-type、404 ⇒ null、500 ⇒ retryable、400 ⇒ 非 retryable', async () => {
  const store = createS3CompatibleObjectStore(CONFIG);
  const substitute = installFetchSubstitute();
  try {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xfe]);
    substitute.enqueue(new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } }));
    const fetched = await store.getObject(OBJECT_KEY);
    assert.deepEqual(Array.from(fetched.bytes), Array.from(bytes), '200 ⇒ 字节逐字节相等');
    assert.equal(fetched.contentType, 'image/png');

    // 缺 content-type 时回落 application/octet-stream（不伪造类型）。
    substitute.enqueue(new Response(Uint8Array.from([9]), { status: 200 }));
    const noType = await store.getObject(OBJECT_KEY);
    assert.equal(noType.contentType, 'application/octet-stream');

    substitute.enqueue(new Response(null, { status: 404 }));
    assert.equal(await store.getObject(OBJECT_KEY), null, '404 ⇒ null（不泄露存在性、不抛错）');

    substitute.enqueue(new Response(null, { status: 500 }));
    await assert.rejects(
      () => store.getObject(OBJECT_KEY),
      (error) => {
        assert.ok(error instanceof MediaError, `必须是 MediaError，实际 ${error?.name}`);
        assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
        assert.equal(error.retryable, true, '5xx ⇒ retryable');
        assert.equal(error.status, 503);
        return true;
      },
    );

    substitute.enqueue(new Response(null, { status: 400 }));
    await assert.rejects(
      () => store.getObject(OBJECT_KEY),
      (error) => {
        assert.ok(error instanceof MediaError);
        assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
        assert.equal(error.retryable, false, '4xx ⇒ 非 retryable');
        return true;
      },
    );

    assert.equal(store.externalRequestCount, 5);
    assert.deepEqual(
      substitute.calls.map((call) => call.init.method),
      ['GET', 'GET', 'GET', 'GET', 'GET'],
    );
  } finally {
    substitute.restore();
  }
});

// ---------------------------------------------------------------- 判据 6：hasObject

test('R27-S8 判据 6：hasObject —— 200 ⇒ true、404 ⇒ false（都经由 GET 探测）', async () => {
  const store = createS3CompatibleObjectStore(CONFIG);
  const substitute = installFetchSubstitute();
  try {
    substitute.enqueue(new Response(null, { status: 200 }));
    assert.equal(await store.hasObject(OBJECT_KEY), true);

    substitute.enqueue(new Response(null, { status: 404 }));
    assert.equal(await store.hasObject(OBJECT_KEY), false);

    assert.equal(store.externalRequestCount, 2);
    assert.deepEqual(
      substitute.calls.map((call) => call.init.method),
      ['GET', 'GET'],
    );
  } finally {
    substitute.restore();
  }
});

// ---------------------------------------------------------------- 判据 7：deleteObject

test('R27-S8 判据 7：deleteObject —— 204 ⇒ true、404 ⇒ true（幂等）、500 ⇒ 抛错且 retryable', async () => {
  const store = createS3CompatibleObjectStore(CONFIG);
  const substitute = installFetchSubstitute();
  try {
    substitute.enqueue(new Response(null, { status: 204 }));
    assert.equal(await store.deleteObject(OBJECT_KEY), true);

    // 幂等：对象本就不存在也算「已确认删除」，否则重试会永远返回 false、引用悬空。
    substitute.enqueue(new Response(null, { status: 404 }));
    assert.equal(await store.deleteObject(OBJECT_KEY), true);

    substitute.enqueue(new Response(null, { status: 500 }));
    await assert.rejects(
      () => store.deleteObject(OBJECT_KEY),
      (error) => {
        assert.ok(error instanceof MediaError);
        assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
        assert.equal(error.retryable, true, '5xx ⇒ 调用方保留引用以便重试');
        return true;
      },
    );

    assert.equal(store.externalRequestCount, 3);
    assert.deepEqual(
      substitute.calls.map((call) => call.init.method),
      ['DELETE', 'DELETE', 'DELETE'],
    );
  } finally {
    substitute.restore();
  }
});

// ---------------------------------------------------------------- 判据 8：objectCount

test('R27-S8 判据 8：objectCount 恒抛 PROVIDER_UNAVAILABLE，且一个请求都不发', async () => {
  const store = createS3CompatibleObjectStore(CONFIG);
  const substitute = installFetchSubstitute();
  try {
    await assert.rejects(
      () => store.objectCount(),
      (error) => {
        assert.ok(error instanceof MediaError);
        assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.equal(substitute.calls.length, 0, '未接 list 权限 ⇒ 不得先试一次再报错');
    assert.equal(store.externalRequestCount, 0);
  } finally {
    substitute.restore();
  }
});

// ---------------------------------------------------------------- 判据 9：presignUpload / presignDownload

test('R27-S8 判据 9：presignUpload/presignDownload —— 方法、expires_at 自洽、URL 与 presignS3Url 直调全串一致', async () => {
  const store = createS3CompatibleObjectStore(CONFIG);
  const upload = await store.presignUpload({ key: OBJECT_KEY, expiresInSeconds: 900 });
  const download = await store.presignDownload({ key: OBJECT_KEY, expiresInSeconds: 1800 });

  // 预签名是纯本地计算：不发起任何外部请求。
  assert.equal(store.externalRequestCount, 0);

  assert.equal(upload.method, 'PUT');
  assert.equal(download.method, 'GET');

  // URL：把产出 URL 里的 `X-Amz-Date` 喂回 `presignS3Url`，整串必须逐字节相同（时钟无关）。
  const uploadAmzDate = new URL(upload.url).searchParams.get('X-Amz-Date');
  assert.equal(
    upload.url,
    presignS3Url({
      config: CONFIG,
      method: 'PUT',
      key: OBJECT_KEY,
      expiresInSeconds: 900,
      now: fromAmzDate(uploadAmzDate),
    }),
  );
  const downloadAmzDate = new URL(download.url).searchParams.get('X-Amz-Date');
  assert.equal(
    download.url,
    presignS3Url({
      config: CONFIG,
      method: 'GET',
      key: OBJECT_KEY,
      expiresInSeconds: 1800,
      now: fromAmzDate(downloadAmzDate),
    }),
  );

  // 两个 URL 的签名各自都能被独立重算命中，且 PUT/GET 签名不同。
  assertUrlMatchesIndependentSignature(upload.url, {
    config: CONFIG,
    method: 'PUT',
    key: OBJECT_KEY,
    expiresInSeconds: 900,
  });
  assertUrlMatchesIndependentSignature(download.url, {
    config: CONFIG,
    method: 'GET',
    key: OBJECT_KEY,
    expiresInSeconds: 1800,
  });
  assert.notEqual(
    new URL(upload.url).searchParams.get('X-Amz-Signature'),
    new URL(download.url).searchParams.get('X-Amz-Signature'),
  );

  // expires_at 与 expiresInSeconds 自洽（留 5 秒时钟容差；上界 1 秒吸收取整）。
  for (const [handle, expiresInSeconds] of [
    [upload, 900],
    [download, 1800],
  ]) {
    assert.equal(new Date(handle.expires_at).toISOString(), handle.expires_at, 'expires_at 必须是标准化 ISO 串');
    const delta = Date.parse(handle.expires_at) - Date.now();
    assert.ok(
      delta > expiresInSeconds * 1000 - 5000 && delta <= expiresInSeconds * 1000 + 1000,
      `expires_at 偏移 ${delta}ms 与 expiresInSeconds=${expiresInSeconds} 不自洽`,
    );
  }
});

// ---------------------------------------------------------------- 判据 10：构造期拒绝（补齐既有用例未覆盖的字段）

test('R27-S8 判据 10：构造期拒绝 —— 必填字段为空/仅空白一律抛错（http:// 与空 bucket 复用既有用例）', () => {
  // 既有覆盖（不重复写）：`tests/unit/media-real-mode-fail-closed.test.mjs` 的用例
  // 「GY-I06 对象存储端口：如实标注、构造校验与配置读取」已断言 `bucket: ''` 与 `http://` endpoint 抛错。
  // 本用例只补它没覆盖的三个必填字段：endpoint / accessKey / secretKey。
  for (const field of ['endpoint', 'accessKey', 'secretKey']) {
    assert.throws(
      () => createS3CompatibleObjectStore({ ...CONFIG, [field]: '' }),
      /拒绝构造/,
      `${field} 为空必须拒绝构造`,
    );
    assert.throws(
      () => createS3CompatibleObjectStore({ ...CONFIG, [field]: '   ' }),
      /拒绝构造/,
      `${field} 仅空白必须拒绝构造`,
    );
  }
  // 缺协议的 endpoint：过了「非空」但仍不是 https ⇒ 必须拒绝，绝不退回替身。
  assert.throws(
    () => createS3CompatibleObjectStore({ ...CONFIG, endpoint: 'cos.ap-shanghai.myqcloud.com' }),
    /https endpoint/,
  );

  // 正向对照：齐备的合成配置可构造，且构造期零外呼（只有显式对象操作才会 fetch）。
  const store = createS3CompatibleObjectStore(CONFIG);
  assert.equal(store.kind, 's3_compatible');
  assert.equal(store.externalRequestCount, 0);
});

// ---------------------------------------------------------------- 如实标注（不许把「未对接真实桶」删掉）

test('R27-S8 如实标注：note 保留「未对接任何真实桶」「未做真实签名往返」，并点名替身跑通', () => {
  const store = createS3CompatibleObjectStore(CONFIG);
  assert.equal(store.kind, 's3_compatible');
  assert.equal(store.externalRequestCount, 0);
  // 这三句是「不许悄悄变成已对接真实存储」的护栏，缺一句就该红。
  assert.match(store.note, /未对接任何真实桶/);
  assert.match(store.note, /未做真实签名往返/);
  assert.match(store.note, /替身/);
  // 产品装配路径的口径：仍然从未被实际调用（跑通只发生在测试的进程内替身下）。
  assert.match(store.note, /从未被实际调用/);
  // note 会被证据文档/诊断引用 ⇒ 绝不能含密钥。
  assert.ok(!store.note.includes(CONFIG.secretKey));
  assert.ok(!store.note.includes(CONFIG.accessKey));
});
