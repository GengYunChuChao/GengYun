// GY-I06（#6）「每帖 ≤3 张」的**上传侧保守上限**：计数器未接线时按 owner 存活记录数判定。
//
// 为什么需要本文件：`attachmentLimitFor` 原先在「图片槽位计数器未接线」时直接 503
// `PROVIDER_UNAVAILABLE`；而 real 模式下计数器**默认就是未接线**（`createAppMediaService`
// 的 `createUnwiredAttachmentCounter()`），于是社区配图在 real 环境恒不可上传。
// 本单（派单 `.pg17/dispatch/fix-i06-media-attachment-limit.md` D1）把**未接线分支**改为复用
// `liveCommunityImageCount()`：同一 owner 名下存活的 `community_image` 记录数。
//
// 口径（写死在此，勿随实现漂移）：该计数是**上传侧保守上限**——按 owner 累计 ⇒ 恒 ≥ 单帖真实
// 张数（宁紧不松），**不是**「每帖」权威计数；权威判定属 GY-I15 附件挂载。本文件不断言、
// 也不暗示已实现「每帖」计数。
//
// 负控制（改坏任一处，本文件必须失败）：
//   - 未接线分支改回直接 503 ⇒ 用例 1／2／3 失败（首张即 503，而非 201）；
//   - 去掉 live 过滤（把 rejected／expired 也算作占用）⇒ 用例 2 失败（第 3 张被误拒）；
//   - 去掉 owner 过滤（把别人名下的记录也算作自己占用）⇒ 用例 3 失败（他人记录把首张顶成 400）；
//   - 把「已接线仍走端口」改成一律走本地计数 ⇒ 用例 4 失败（injected 的 400／503 被吞）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createS3CompatibleObjectStore, createSubstituteObjectStore } from '../../services/api/src/media/object-store.ts';
import { approveRealMediaWiring, createInjectedAttachmentCounter } from '../../services/api/src/media/service.ts';
import { sha256Hex } from '../../packages/media/validate.mjs';
import { pngPlain } from '../media/_fixtures.mjs';

const T0 = 1_700_000_000_000;
const KEY = (name) => `media-attach-${name}-0000`;
const png = pngPlain();
/** community_image 的声明载荷（`bytes`／`sha256` 与夹具一致；createUpload 只做声明，不上传字节）。 */
const DECLARED_COMMUNITY = { purpose: 'community_image', mime: 'image/png', bytes: png.length, sha256: sha256Hex(png) };

/** 合成的 s3_compatible 端口：构造与预签名都是纯本地计算，`externalRequestCount` 恒为 0。 */
function syntheticS3() {
  return createS3CompatibleObjectStore({
    endpoint: 'https://cos.ap-shanghai.myqcloud.com',
    bucket: 'gengyun-media-placeholder',
    accessKey: 'synthetic-access-key-id',
    secretKey: 'synthetic-secret-key-value',
    region: 'ap-shanghai',
    forcePathStyle: false,
  });
}

/** real 模式下的合成会话（real 模式微信登录 fail-closed ⇒ 直接落一条会话行；不代表真实登录已验收）。 */
async function synthesizeSession(store, token) {
  const user = await store.createUser('synthetic-subject-attachment-limit');
  await store.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    // 会话活到 72h：本文件会用 `advance()` 越过 24h 的上传句柄 TTL（判过期记录不计入）。
    expiresAt: new Date(Date.now() + 72 * 3600 * 1000),
    audience: 'user',
  });
  return token;
}

/** real 模式 + 显式批准能力 + s3_compatible 端口；**不注入**计数器 ⇒ 走默认的 unwired 分支。 */
async function realApp() {
  let nowMs = T0;
  const store = createMemoryAuthStore();
  const objectStore = syntheticS3();
  const app = buildApp({
    config: { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), executionMode: 'real' },
    store,
    mediaObjectStore: objectStore,
    realMediaApproval: approveRealMediaWiring({ reason: 'i06 测试夹具：未接线计数器的上传侧保守上限（合成端点，零外呼）' }),
    now: () => new Date(nowMs),
  });
  const token = await synthesizeSession(store, 'synthetic-attachment-limit-token');
  return { app, store, objectStore, token, advance: (ms) => { nowMs += ms; } };
}

/** stub 模式 + 显式注入的计数器（用于证明「已接线路径语义不变」）。 */
async function stubAppWithCounter(counter) {
  const store = createMemoryAuthStore();
  const app = buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    store,
    mediaObjectStore: createSubstituteObjectStore(),
    mediaAttachmentCounter: counter,
    now: () => new Date(T0),
  });
  const token = await synthesizeSession(store, `synthetic-counter-${counter.kind}-token`);
  return { app, token };
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

const upload = (app, token, key) =>
  call(app, 'POST', '/api/v1/media/uploads', token, { payload: DECLARED_COMMUNITY, headers: { 'idempotency-key': key } });

/** 逐张断言 201（成功封套形状）或 400 `post_image_limit`；不放宽为「非 500 即过」。 */
function expectAccepted(reply, label) {
  assert.equal(reply.status, 201, `${label} 应被接受：${JSON.stringify(reply.body)}`);
  assert.equal(reply.body.data.media.purpose, 'community_image', label);
  assert.equal(reply.body.data.media.state, 'initiated', label);
}

function expectPostImageLimit(reply, label) {
  assert.equal(reply.status, 400, `${label} 应被拒（400）：${JSON.stringify(reply.body)}`);
  assert.equal(reply.body.error.code, 'INVALID_REQUEST', label);
  assert.deepEqual(reply.body.error.details[0], { field: '/purpose', code: 'post_image_limit' }, label);
}

test('GY-I06 未接线计数器（real 默认）：0 条 ⇒ 201；第 3 张仍 201；第 4 张 400 post_image_limit', async (t) => {
  const { app, token, objectStore } = await realApp();
  t.after(() => app.close());

  // 前提守卫：确实是「未接线」这条分支（若装配层改了默认计数器，本用例必须立刻暴露）。
  assert.equal(app.mediaService.attachmentCounter.kind, 'unwired');
  assert.equal(app.mediaService.executionMode, 'real');
  assert.equal(app.mediaService.failClosedReason, null);

  const first = await upload(app, token, KEY('unwired-1'));
  expectAccepted(first, '0 条 live 时的第 1 张');
  assert.equal(first.body.meta.execution_mode, 'real');

  expectAccepted(await upload(app, token, KEY('unwired-2')), '第 2 张');
  expectAccepted(await upload(app, token, KEY('unwired-3')), '第 3 张');
  // 3 条已占用 ⇒ 第 4 张被拒（与 stub 的保守替身口径一致）。
  expectPostImageLimit(await upload(app, token, KEY('unwired-4')), '第 4 张');

  // 本分支不该触发任何真实对象存储调用。
  assert.equal(objectStore.externalRequestCount, 0);
});

test('GY-I06 边界：1 条已过期（rejected:expired）＋2 条 live ⇒ 第 3 张仍 201，第 4 张 400', async (t) => {
  const { app, token, advance } = await realApp();
  t.after(() => app.close());

  expectAccepted(await upload(app, token, KEY('expired-1')), '过期前第 1 张');
  // 越过 24h 上传句柄 TTL 后再跑过期清理 ⇒ 该记录变 rejected（failure_code: 'expired'）。
  advance(25 * 60 * 60 * 1000);
  assert.deepEqual(await app.mediaService.expireInitiated(), { expired: 1 }, '必须真的把 1 条记录判为过期');

  expectAccepted(await upload(app, token, KEY('expired-2')), '过期后第 2 张（live=0）');
  expectAccepted(await upload(app, token, KEY('expired-3')), '过期后第 3 张（live=2）');
  // live 只有 2 条 ⇒ 第 3 条 live 记录仍应被接受；过期那条**不得**计入占用。
  expectAccepted(await upload(app, token, KEY('expired-4')), '第 3 条 live 记录（过期那条不计入）');
  expectPostImageLimit(await upload(app, token, KEY('expired-5')), '第 4 条 live 记录');
});

test('GY-I06 跨账号隔离：他人 3 条 live 时本人仍可上传 3 张、第 4 张 400', async (t) => {
  const { app, store } = await realApp();
  t.after(() => app.close());
  const meToken = 'synthetic-attachment-limit-me-token';
  await synthesizeSession(store, meToken);
  const otherToken = await synthesizeSession(store, 'synthetic-attachment-limit-other-token');

  expectAccepted(await upload(app, otherToken, KEY('other-1')), '他人第 1 张');
  expectAccepted(await upload(app, otherToken, KEY('other-2')), '他人第 2 张');
  expectAccepted(await upload(app, otherToken, KEY('other-3')), '他人第 3 张');
  expectPostImageLimit(await upload(app, otherToken, KEY('other-4')), '他人第 4 张');

  expectAccepted(await upload(app, meToken, KEY('me-1')), '本人第 1 张（他人已满不影响）');
  expectAccepted(await upload(app, meToken, KEY('me-2')), '本人第 2 张');
  expectAccepted(await upload(app, meToken, KEY('me-3')), '本人第 3 张');
  expectPostImageLimit(await upload(app, meToken, KEY('me-4')), '本人第 4 张');
  // 双向：他人仍停在「已满」状态（证明计数按 owner 分开累计，而不是全局共享一个计数器）。
  expectPostImageLimit(await upload(app, otherToken, KEY('other-5')), '他人第 5 张（仍满）');
});

test('GY-I06 已接线计数器语义不变：injected 返回值仍是唯一判据（7 ⇒ 400；null ⇒ 503 fail-closed）', async (t) => {
  const capped = await stubAppWithCounter(createInjectedAttachmentCounter(() => 7));
  t.after(() => capped.app.close());
  assert.equal(capped.app.mediaService.attachmentCounter.kind, 'injected');
  expectPostImageLimit(await upload(capped.app, capped.token, KEY('injected-7')), 'injected 返回 7 时的第 1 张');

  const blind = await stubAppWithCounter(createInjectedAttachmentCounter(() => null));
  t.after(() => blind.app.close());
  const refused = await upload(blind.app, blind.token, KEY('injected-null'));
  assert.equal(refused.status, 503, `已接线但无法判定仍须 fail-closed：${JSON.stringify(refused.body)}`);
  assert.equal(refused.body.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(refused.body.error.retryable, false);
});

test('GY-I06 stub 默认（substitute 计数器）口径不变：3 张 201，第 4 张 400', async (t) => {
  const store = createMemoryAuthStore();
  const app = buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    store,
    mediaObjectStore: createSubstituteObjectStore(),
    now: () => new Date(T0),
  });
  t.after(() => app.close());
  const token = await synthesizeSession(store, 'synthetic-substitute-token');
  assert.equal(app.mediaService.attachmentCounter.kind, 'substitute');

  expectAccepted(await upload(app, token, KEY('sub-1')), '第 1 张');
  expectAccepted(await upload(app, token, KEY('sub-2')), '第 2 张');
  expectAccepted(await upload(app, token, KEY('sub-3')), '第 3 张');
  expectPostImageLimit(await upload(app, token, KEY('sub-4')), '第 4 张');
});
