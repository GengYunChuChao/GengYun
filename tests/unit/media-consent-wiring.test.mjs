/**
 * GY-I27 第三片（C7）· **媒体上传受理接用途授权**的接线回归（方案 A）。
 *
 * 方案 A 的边界（本文件逐条证明，不做第 8 条以外的事）：
 *  1. 只有 `POST /media/uploads`（`createUpload`）挂授权前置；`GET` 读句柄/删除/授权/社区读面
 *     **一律不挂** —— 撤回用途后用户仍必须能取回并删除自己的数据；
 *  2. 无授权 ⇒ 403 `CONSENT_REQUIRED` 且**零写入**（媒体记录、幂等账本、对象存储预签名与对象数
 *     前后完全一致）；错用途 ⇒ 403 `SCOPE_DENIED`；已授权 ⇒ 201（与未挂门同形）；
 *  3. 资料类型随**请求体 `purpose`** 变化：`weed_recognition` 要 `media_processing` +
 *     `external_inference`；`community_image` 还要 `public_posting` —— 拒绝信息必须**指名**缺的那一码；
 *  4. **未注入 ⇒ passthrough**，既有 stub 行为逐字不变（可回退对照）；
 *  5. 鉴权先于授权：未登录 ⇒ 401 `SESSION_REQUIRED`，授权端口**一次都不被问**。
 *
 * 全部为合成身份（替身微信登录 + 内存 auth store）、替身对象存储与合成媒体字节；
 * **不连接真实数据库、不调用真实第三方、不产生费用**。真库上的「零授权 ⇒ media 零新增行」
 * 与真实对象存储的零 presign **未验证**（本机无 PG，见交接的「未取得项」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createSubstituteObjectStore } from '../../services/api/src/media/object-store.ts';
import { createGuardConsentGate } from '../../services/api/src/privacy/egress.ts';
import { createConsentStore } from '../../packages/privacy/consent.mjs';
import { createPrivacyGuard } from '../../packages/privacy/guard.mjs';
import { sha256Hex } from '../../packages/media/validate.mjs';
import { createAccountProvider, VERIFIED_RECIPIENT } from '../privacy/_fixtures.mjs';
import { jpegWithExif } from '../media/_fixtures.mjs';

const API = '/api/v1';
const JPEG = jpegWithExif();
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 合法 `UploadInput`（图片用途不接受 `duration_ms`）。 */
function uploadBody(purpose, overrides = {}) {
  return { purpose, mime: 'image/jpeg', bytes: JPEG.length, sha256: sha256Hex(JPEG), ...overrides };
}

/** 计数用的对象存储替身：**只统计**预签名/写入次数，行为仍是替身端口（不发起任何网络请求）。 */
function createCountingObjectStore() {
  const inner = createSubstituteObjectStore();
  const counts = { presignUpload: 0, presignDownload: 0, put: 0 };
  return {
    counts,
    store: {
      get kind() {
        return inner.kind;
      },
      get note() {
        return inner.note;
      },
      get externalRequestCount() {
        return inner.externalRequestCount;
      },
      async putObject(key, bytes, contentType) {
        counts.put += 1;
        return inner.putObject(key, bytes, contentType);
      },
      getObject: (key) => inner.getObject(key),
      hasObject: (key) => inner.hasObject(key),
      deleteObject: (key) => inner.deleteObject(key),
      objectCount: () => inner.objectCount(),
      async presignUpload(input) {
        counts.presignUpload += 1;
        return inner.presignUpload(input);
      },
      async presignDownload(input) {
        counts.presignDownload += 1;
        return inner.presignDownload(input);
      },
    },
  };
}

/** 记录「授权端口被问了几次、问了哪些要求」的包装（被测的仍是真实 `ConsentGate` 实现）。 */
function recordingGate(inner) {
  const requirements = [];
  return {
    requirements,
    gate: (requirement) => {
      requirements.push(requirement);
      return inner(requirement);
    },
  };
}

function makeApp({ consent, objectStore } = {}) {
  const authStore = createMemoryAuthStore();
  const app = buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    store: authStore,
    mediaObjectStore: objectStore ?? createSubstituteObjectStore(),
    ...(consent === undefined ? {} : { privacyInjection: { consent } }),
  });
  return { app, authStore };
}

async function login(app, code) {
  const r = await app.inject({
    method: 'POST',
    url: `${API}/auth/wechat`,
    headers: { 'content-type': 'application/json', 'idempotency-key': `login-key-${code}` },
    payload: { code },
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().data.access_token;
}

async function userIdFor(authStore, token) {
  const session = await authStore.findSession(hashToken(token), 'user');
  assert.ok(session, '合成会话必须存在');
  return session.userId;
}

async function call(app, method, url, token, { payload, headers } = {}) {
  const r = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers ?? {}) },
  });
  let body = null;
  try {
    body = r.json();
  } catch {
    body = null;
  }
  return { status: r.statusCode, body, etag: r.headers.etag, cache: r.headers['cache-control'] };
}

async function grantPurposes(consentStore, userId, purposes) {
  for (const purpose of purposes) {
    await consentStore.grant({ userId, purpose, policyVersion: '1.0.0', recipientIds: [VERIFIED_RECIPIENT.id] });
  }
}

/** 每个用例一份全新装配（授权是账号维度的，不能跨用例复用）。 */
function wiringApp() {
  const account = createAccountProvider();
  const consentStore = createConsentStore();
  const base = createGuardConsentGate(createPrivacyGuard({ account, consentStore }));
  const { gate, requirements } = recordingGate(base);
  const counting = createCountingObjectStore();
  const { app, authStore } = makeApp({ consent: gate, objectStore: counting.store });
  // 另四个已接线域（识别/转写/合成/OCR）在**注册期**就问过授权端口（资料类型是常量）；
  // 媒体域的资料类型随请求体变化，只可能在**请求期**问 ⇒ 断言只看装配之后的询问。
  const atRegistration = requirements.length;
  return {
    app,
    authStore,
    consentStore,
    counts: counting.counts,
    requestRequirements: () => requirements.slice(atRegistration),
  };
}

test('接线生效·未登录 ⇒ 401 SESSION_REQUIRED，且授权端口一次都不被问（鉴权先于授权）', async () => {
  const { app, counts, requestRequirements } = wiringApp();
  try {
    const anon = await call(app, 'POST', `${API}/media/uploads`, null, {
      payload: uploadBody('weed_recognition'),
      headers: { 'idempotency-key': 'idem-media-anon-0001' },
    });
    assert.equal(anon.status, 401, JSON.stringify(anon.body));
    assert.equal(anon.body.error.code, 'SESSION_REQUIRED');
    assert.equal(anon.body.data, undefined, '不得返回成功封套');
    assert.deepEqual(requestRequirements(), [], '未登录时不得进入授权判定（授权端口零询问）');
    assert.equal(counts.presignUpload, 0, '未登录不得签出上传句柄');
  } finally {
    await app.close();
  }
});

test('接线生效·零授权 ⇒ 403 CONSENT_REQUIRED（retryable=false / details=[]）且**零写入零 presign**', async () => {
  const { app, authStore, consentStore, counts } = wiringApp();
  const token = await login(app, 'synthetic-media-wire-a');
  const userId = await userIdFor(authStore, token);
  const bodyA = uploadBody('weed_recognition');
  const bodyB = uploadBody('weed_recognition', { sha256: 'b'.repeat(64) });
  try {
    const denied = await call(app, 'POST', `${API}/media/uploads`, token, {
      payload: bodyA,
      headers: { 'idempotency-key': 'idem-media-deny-0001' },
    });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'CONSENT_REQUIRED');
    assert.match(String(denied.body.error.message), /media_processing/, '拒绝信息必须指名缺的那一码');
    assert.equal(denied.body.error.retryable, false, '缺授权不是暂时性故障（重试同一请求不会成功）');
    assert.deepEqual(denied.body.error.details, [], '授权拒绝不带字段级 details');
    assert.equal(denied.body.data, undefined, '不得返回成功封套');
    // 零写入：媒体记录/幂等账本不落库、对象存储不预签名、不写对象。
    assert.equal(counts.presignUpload, 0, '被拒的上传受理不得签出任何上传句柄');
    assert.equal(counts.put, 0, '被拒的上传受理不得写入任何对象');
    assert.equal(await app.mediaObjectStore.objectCount(), 0, '对象存储必须仍然为空');

    // 零写入的**可判据证明**：授权补齐后，用同一个 Idempotency-Key 提交**不同**请求体，
    // 若被拒那次曾在服务层落过幂等账本，这里会 409 IDEMPOTENCY_CONFLICT；实测必须 201。
    await grantPurposes(consentStore, userId, ['media_processing', 'external_inference']);
    const reused = await call(app, 'POST', `${API}/media/uploads`, token, {
      payload: bodyB,
      headers: { 'idempotency-key': 'idem-media-deny-0001' },
    });
    assert.equal(reused.status, 201, `被拒请求必须零写入（同键新体仍应受理）：${JSON.stringify(reused.body)}`);
    assert.ok(reused.body.data?.media?.id, '成功封套必须带 media');
    // 反向自证：同一键换回原请求体 ⇒ 409（证明幂等账本确实在写，上一条不是空断言）。
    const conflict = await call(app, 'POST', `${API}/media/uploads`, token, {
      payload: bodyA,
      headers: { 'idempotency-key': 'idem-media-deny-0001' },
    });
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  } finally {
    await app.close();
  }
});

test('接线生效·只授 media_processing ⇒ 403 且 message 指 external_inference；补授 ⇒ 201（与未挂门同形）', async () => {
  const { app, authStore, consentStore, requestRequirements, counts } = wiringApp();
  const token = await login(app, 'synthetic-media-wire-b');
  const userId = await userIdFor(authStore, token);
  try {
    await grantPurposes(consentStore, userId, ['media_processing']);
    const partial = await call(app, 'POST', `${API}/media/uploads`, token, {
      payload: uploadBody('weed_recognition'),
      headers: { 'idempotency-key': 'idem-media-partial-0001' },
    });
    assert.equal(partial.status, 403, JSON.stringify(partial.body));
    assert.equal(partial.body.error.code, 'CONSENT_REQUIRED');
    assert.match(String(partial.body.error.message), /external_inference/, '必须指名缺的第二码');
    assert.equal(counts.presignUpload, 0, '缺授权时仍不得预签名');

    await grantPurposes(consentStore, userId, ['external_inference']);
    const granted = await call(app, 'POST', `${API}/media/uploads`, token, {
      payload: uploadBody('weed_recognition'),
      headers: { 'idempotency-key': 'idem-media-granted-0001' },
    });
    assert.equal(granted.status, 201, JSON.stringify(granted.body));
    assert.equal(granted.body.data.media.purpose, 'weed_recognition');
    assert.equal(granted.body.data.media.state, 'initiated');
    assert.equal(granted.etag, '"1"', '成功响应仍带资源 revision 强 ETag');
    assert.equal(granted.cache, 'no-store', '私有响应仍 no-store');
    assert.equal(counts.presignUpload, 1, '放行后恰好签出一个上传句柄');
    // 资料类型由**请求体**决定，且以 `media_processing` 为公有码去问授权端口。
    const asked = requestRequirements();
    assert.ok(asked.length >= 1, '放行请求必须问过授权端口');
    assert.ok(
      asked.every((r) => r.purpose === 'media_processing' && r.dataType === 'weed_recognition'),
      `媒体路由只以 media_processing + 请求体资料类型去问：${JSON.stringify(asked)}`,
    );
  } finally {
    await app.close();
  }
});

test('接线生效·community_image 还要 public_posting：缺则 403 指名，补授后 201', async () => {
  const { app, authStore, consentStore, requestRequirements } = wiringApp();
  const token = await login(app, 'synthetic-media-wire-c');
  const userId = await userIdFor(authStore, token);
  try {
    await grantPurposes(consentStore, userId, ['media_processing', 'external_inference']);
    const denied = await call(app, 'POST', `${API}/media/uploads`, token, {
      payload: uploadBody('community_image'),
      headers: { 'idempotency-key': 'idem-media-community-0001' },
    });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'CONSENT_REQUIRED');
    assert.match(String(denied.body.error.message), /public_posting/, 'community_image 必须额外要 public_posting');

    await grantPurposes(consentStore, userId, ['public_posting']);
    const granted = await call(app, 'POST', `${API}/media/uploads`, token, {
      payload: uploadBody('community_image'),
      headers: { 'idempotency-key': 'idem-media-community-0002' },
    });
    assert.equal(granted.status, 201, JSON.stringify(granted.body));
    assert.equal(granted.body.data.media.purpose, 'community_image');
    assert.deepEqual(requestRequirements().at(-1), {
      purpose: 'media_processing',
      dataType: 'community_image',
    });
  } finally {
    await app.close();
  }
});

test('接线生效·错用途 ⇒ 403 SCOPE_DENIED（message ≤200 字符，不泄露内部细节）', async () => {
  // 替身门：无论路由问什么，一律以 `public_posting` 去核 `weed_recognition` ⇒ 必须判错用途。
  const account = createAccountProvider();
  const consentStore = createConsentStore();
  const base = createGuardConsentGate(createPrivacyGuard({ account, consentStore }));
  const wrongGate = (requirement) => base({ purpose: 'public_posting', dataType: requirement.dataType });
  const { app, authStore } = makeApp({ consent: wrongGate });
  const token = await login(app, 'synthetic-media-wire-d');
  const userId = await userIdFor(authStore, token);
  const denied = await call(app, 'POST', `${API}/media/uploads`, token, {
    payload: uploadBody('weed_recognition'),
    headers: { 'idempotency-key': 'idem-media-scope-0001' },
  });
  try {
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'SCOPE_DENIED');
    assert.ok(
      String(denied.body.error.message).length <= 200,
      `契约要求 message ≤200 字符，实测 ${String(denied.body.error.message).length}`,
    );
    assert.equal(denied.body.error.retryable, false);
    // 负向对照：把同一批用途授全也不影响判定（错用途与「授没授」无关）。
    await grantPurposes(consentStore, userId, ['media_processing', 'external_inference', 'public_posting']);
    const stillWrong = await call(app, 'POST', `${API}/media/uploads`, token, {
      payload: uploadBody('weed_recognition'),
      headers: { 'idempotency-key': 'idem-media-scope-0002' },
    });
    assert.equal(stillWrong.status, 403, JSON.stringify(stillWrong.body));
    assert.equal(stillWrong.body.error.code, 'SCOPE_DENIED');
  } finally {
    await app.close();
  }
});

test('只 gate 上传受理·撤回用途后 POST 被拒，但 GET 读句柄与 DELETE 仍可用（用户仍能取回/删除）', async () => {
  const { app, authStore, consentStore } = wiringApp();
  const token = await login(app, 'synthetic-media-wire-e');
  const userId = await userIdFor(authStore, token);
  try {
    await grantPurposes(consentStore, userId, ['media_processing', 'external_inference']);
    const created = await call(app, 'POST', `${API}/media/uploads`, token, {
      payload: uploadBody('weed_recognition'),
      headers: { 'idempotency-key': 'idem-media-read-0001' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const mediaId = created.body.data.media.id;

    // 撤回用途（合成撤回：直接作用于注入的授权存储；HTTP 撤回面需真实 PG）。
    await consentStore.withdraw({ userId, purpose: 'external_inference' });

    const blocked = await call(app, 'POST', `${API}/media/uploads`, token, {
      payload: uploadBody('weed_recognition'),
      headers: { 'idempotency-key': 'idem-media-read-0002' },
    });
    assert.equal(blocked.status, 403, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error.code, 'CONSENT_REQUIRED');

    const readable = await call(app, 'GET', `${API}/media/${mediaId}`, token);
    assert.equal(readable.status, 200, `读句柄不得被用途授权阻断：${JSON.stringify(readable.body)}`);
    assert.equal(readable.body.data.revision, 1);

    const deleted = await call(app, 'DELETE', `${API}/media/${mediaId}`, token, {
      headers: { 'if-match': '"1"', 'idempotency-key': 'idem-media-read-0003' },
    });
    assert.equal(deleted.status, 202, `删除不得被用途授权阻断：${JSON.stringify(deleted.body)}`);
    assert.equal(deleted.body.data.accepted, true);
  } finally {
    await app.close();
  }
});

test('可回退对照·未注入授权端口 ⇒ 无授权也 201（既有 stub 行为逐字不变）', async () => {
  const { app } = makeApp();
  const token = await login(app, 'synthetic-media-wire-f');
  try {
    const created = await call(app, 'POST', `${API}/media/uploads`, token, {
      payload: uploadBody('weed_recognition'),
      headers: { 'idempotency-key': 'idem-media-control-0001' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.media.state, 'initiated');
    assert.equal(created.etag, '"1"');
  } finally {
    await app.close();
  }
});

test('结构判据·app.ts 媒体装配传入同一 consentGate，media.ts 仅上传入口挂授权前置', () => {
  const appSource = readFileSync(`${REPO_ROOT}services/api/src/app.ts`, 'utf8');
  const mediaSource = readFileSync(`${REPO_ROOT}services/api/src/routes/media.ts`, 'utf8');

  assert.equal((appSource.match(/registerMediaRoutes\(/g) ?? []).length, 1, '媒体路由仍必须只有一处注册点');
  assert.match(
    appSource,
    /registerMediaRoutes\(app, config, guards, mediaService, \{\s*consent: consentGate\s*\}\)/,
    '媒体装配必须传入与其它域同源的 consentGate',
  );
  // 只 gate 上传受理：授权前置恰好出现在一条入口上，其余 6 条仍是裸 `guards.requireUser`。
  assert.equal(
    (mediaSource.match(/\[guards\.requireUser, uploadConsent\]/g) ?? []).length,
    1,
    '授权前置只允许挂在 POST /media/uploads 一条入口上',
  );
  assert.match(mediaSource, /deps\.consent === undefined/, '缺省必须是 passthrough（可回退）');
  assert.match(mediaSource, /purpose: 'media_processing'/, '授权要求必须带公有码 media_processing');
  assert.match(mediaSource, /dataType/, '授权要求必须带 dataType（否则丢 recording/public_posting 与错用途分支）');
});
