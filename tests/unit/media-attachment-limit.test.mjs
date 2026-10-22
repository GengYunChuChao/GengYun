// GY-I06（#6）「每帖 ≤3 张」的上传侧判定：**判定只认计数器端口**；每帖上限计数缺位即 503 fail-closed。
//
// 为什么需要本文件（两次返修的正反两面都钉在这里）：
//   * 原先 `attachmentLimitFor` 在「图片槽位计数器未接线」时直接 503；而 real 模式下计数器
//     **默认就是未接线**（`createAppMediaService` 的 `createUnwiredAttachmentCounter()`）。
//   * 上一轮（1ec6449）曾把未接线分支改成「按同一 owner 名下存活 `community_image` 记录数兜底」。
//     复审实测否掉了它：那是**生命周期累计**口径 —— 清理器（`expireInitiated`／`cleanupOrphans`）
//     与权威每帖计数（GY-I15 附件挂载）今天都没有生产调用者 ⇒ 用户传满 3 张后**永久锁死**
//     （只能手删）；并且「先数后写」之间存在 TOCTOU，12 并发可打出 12×201。
//   * 本片按裁定 `.pg17/ruling-i06-d1-substitute-rework-20261017.md` **方案 A** 撤回该兜底：
//     未接线仍 503，但文案明确到「每帖上限计数未接线」；并用结构性断言禁止后人再拿累计数顶替
//     （「缺清理器／权威计数器时**不得放行**」）。
//
// 能力缺位的如实口径：本文件**不**断言、也**不**暗示「每帖」计数已实现；权威判定属 GY-I15。
// 用例 2／3 用**探针计数器**（`injected`）只观察端口的入参 `liveCommunityImages`／`ownerId`，
// 不借它放行未接线路径，也不改判定口径。
//
// 负控制（改坏任一处，本文件必须失败）：
//   - 把未接线分支改回「按存活记录数放行」⇒ 用例 1 失败（首张即 201 而非 503），用例 6 的结构性
//     断言同时失败（`attachmentLimitFor` 里出现早于 `counted === null` 的 return）；
//   - 把 503 文案泛化成「服务不可用／请稍后重试」⇒ 用例 1（逐字响应体）、用例 4（injected null）
//     与用例 6（文案常量）失败；
//   - 去掉 live 过滤（把 rejected／expired 也算作占用）⇒ 用例 2 失败（探针收到的 live 数多 1）；
//   - 去掉 owner 过滤（把别人名下的记录也算作自己占用）⇒ 用例 3 失败（探针序列整体错位）；
//   - 把「已接线仍走端口」改成一律走本地计数 ⇒ 用例 4 失败（injected 的 400／503 被吞）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createS3CompatibleObjectStore, createSubstituteObjectStore } from '../../services/api/src/media/object-store.ts';
import {
  approveRealMediaWiring,
  createInjectedAttachmentCounter,
  createUnwiredAttachmentCounter,
} from '../../services/api/src/media/service.ts';
import { sha256Hex } from '../../packages/media/validate.mjs';
import { pngPlain } from '../media/_fixtures.mjs';

const T0 = 1_700_000_000_000;
const KEY = (name) => `media-attach-${name}-0000`;
const png = pngPlain();
/** community_image 的声明载荷（`bytes`／`sha256` 与夹具一致；createUpload 只做声明，不上传字节）。 */
const DECLARED_COMMUNITY = { purpose: 'community_image', mime: 'image/png', bytes: png.length, sha256: sha256Hex(png) };
/**
 * 「每帖上限计数未接线」的 503 文案，**逐字**钉在这里（故意不 import 常量，避免自证同义）。
 * 改文案必须同时改本行——这是有意的摩擦：泛化成「服务不可用」会掩盖能力未装配。
 */
const UNWIRED_MESSAGE =
  '每帖上限计数未接线：无法判定「每帖 ≤3 张」图片槽位（缺权威每帖计数，社区图片上传暂不可用）';

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

/**
 * real 模式 + 显式批准能力 + s3_compatible 端口。
 * 不传 `counter` ⇒ **不注入**计数器 ⇒ 走默认的 `unwired` 分支（用例 1 的前提）。
 */
async function realApp({ counter } = {}) {
  let nowMs = T0;
  const store = createMemoryAuthStore();
  const objectStore = syntheticS3();
  const app = buildApp({
    config: { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), executionMode: 'real' },
    store,
    mediaObjectStore: objectStore,
    ...(counter === undefined ? {} : { mediaAttachmentCounter: counter }),
    realMediaApproval: approveRealMediaWiring({ reason: 'i06 测试夹具：每帖上限计数缺位的 fail-closed 口径（合成端点，零外呼）' }),
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

/**
 * 探针计数器：把端口的入参逐次记下来，判定值原样回传收到的 `liveCommunityImages`。
 * 只用来看「计数地基」是否正确（过期不计入、跨 owner 隔离），不参与未接线路径的放行。
 */
function probingCounter(seen) {
  return createInjectedAttachmentCounter((input) => {
    seen.push(input);
    return input.liveCommunityImages;
  });
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

/** 503「每帖上限计数未接线」的**逐字**判据：code／message／retryable／details 一个都不许漂。 */
function expectUnwiredRefusal(reply, label) {
  assert.equal(reply.status, 503, `${label} 必须以 503 fail-closed：${JSON.stringify(reply.body)}`);
  assert.deepEqual(
    reply.body.error,
    {
      code: 'PROVIDER_UNAVAILABLE',
      message: UNWIRED_MESSAGE,
      retryable: false,
      details: [{ field: '/purpose', code: 'post_image_limit_unwired' }],
    },
    `${label} 的错误封套必须点明「每帖上限计数未接线」`,
  );
}

test('GY-I06 未接线计数器（real 默认）：community_image 上传恒 503，文案明确到「每帖上限计数未接线」', async (t) => {
  const { app, token, objectStore } = await realApp();
  t.after(() => app.close());

  // 前提守卫：确实是「未接线」这条分支（若装配层改了默认计数器，本用例必须立刻暴露）。
  assert.equal(app.mediaService.attachmentCounter.kind, 'unwired');
  assert.match(app.mediaService.attachmentCounter.note, /每帖上限计数未接线/, '未接线计数器的 note 必须点明缺的是「每帖上限计数」');
  assert.equal(app.mediaService.executionMode, 'real');
  assert.equal(app.mediaService.failClosedReason, null);

  const first = await upload(app, token, KEY('unwired-1'));
  expectUnwiredRefusal(first, '未接线时的第 1 张');
  assert.equal(first.body.meta.execution_mode, 'real');

  // 换一个 Idempotency-Key 再打：仍是同一条 503 —— 不因「先数到 0」而放行第 1 张，也就没有「传满即锁死」。
  const second = await upload(app, token, KEY('unwired-2'));
  expectUnwiredRefusal(second, '未接线时的第 2 张（换 key）');
  assert.deepEqual(second.body.error, first.body.error, '未接线时两次请求的错误封套必须一致');

  // 不放行 ⇒ 不触达对象存储（零外呼；`externalRequestCount` 是合成端口的本地计数）。
  // 注：real 模式的 `stats()` 会如实抛「真实适配器不提供对象计数」，故这里不拿它当「零残留」的证据。
  assert.equal(objectStore.externalRequestCount, 0, '本分支不该触发任何真实对象存储调用');
});

test('GY-I06 计数地基·过期记录不计入：探针收到的 live 数逐次为 0,0,1,2,3，第 5 张 400', async (t) => {
  const seen = [];
  const { app, token, advance } = await realApp({ counter: probingCounter(seen) });
  t.after(() => app.close());

  expectAccepted(await upload(app, token, KEY('expired-1')), '过期前第 1 张');
  assert.deepEqual(seen.map((s) => s.liveCommunityImages), [0], '第 1 张时还没有 live 记录');

  // 越过 24h 上传句柄 TTL 后再跑过期清理 ⇒ 该记录变 rejected（failure_code: 'expired'）。
  advance(25 * 60 * 60 * 1000);
  assert.deepEqual(await app.mediaService.expireInitiated(), { expired: 1 }, '必须真的把 1 条记录判为过期');

  expectAccepted(await upload(app, token, KEY('expired-2')), '过期后第 2 张（live=0）');
  expectAccepted(await upload(app, token, KEY('expired-3')), '过期后第 3 张（live=1）');
  // live 只有 2 条 ⇒ 第 3 条 live 记录仍应被接受；过期那条**不得**计入占用。
  expectAccepted(await upload(app, token, KEY('expired-4')), '第 3 条 live 记录（过期那条不计入）');
  expectPostImageLimit(await upload(app, token, KEY('expired-5')), '第 4 条 live 记录');

  // 关键判据：过期那条**从未**计入占用（否则序列会从 1 起跳，第 4 张会被提前拒）。
  assert.deepEqual(
    seen.map((s) => s.liveCommunityImages),
    [0, 0, 1, 2, 3],
    'live 计数必须排除 rejected／expired 记录',
  );
  assert.equal(new Set(seen.map((s) => s.ownerId)).size, 1, '同一会话只应出现一个 owner');
});

test('GY-I06 计数地基·跨账号隔离：探针看到各自的 owner 与 live 数，他人满额不影响本人', async (t) => {
  const seen = [];
  const { app, store } = await realApp({ counter: probingCounter(seen) });
  t.after(() => app.close());
  const me = await synthesizeSession(store, 'synthetic-attachment-limit-me-token');
  const other = await synthesizeSession(store, 'synthetic-attachment-limit-other-token');
  assert.notEqual(me, other, '两个会话必须是不同令牌（否则下面的隔离断言什么都没证明）');

  expectAccepted(await upload(app, other, KEY('other-1')), '他人第 1 张');
  expectAccepted(await upload(app, other, KEY('other-2')), '他人第 2 张');
  expectAccepted(await upload(app, other, KEY('other-3')), '他人第 3 张');
  expectPostImageLimit(await upload(app, other, KEY('other-4')), '他人第 4 张');

  expectAccepted(await upload(app, me, KEY('me-1')), '本人第 1 张（他人已满不影响）');
  expectAccepted(await upload(app, me, KEY('me-2')), '本人第 2 张');
  expectAccepted(await upload(app, me, KEY('me-3')), '本人第 3 张');
  expectPostImageLimit(await upload(app, me, KEY('me-4')), '本人第 4 张');
  // 双向：他人仍停在「已满」（证明计数按 owner 分开累计，而不是全局共享一个计数器）。
  expectPostImageLimit(await upload(app, other, KEY('other-5')), '他人第 5 张（仍满）');

  assert.deepEqual(
    seen.map((s) => s.liveCommunityImages),
    [0, 1, 2, 3, 0, 1, 2, 3, 3],
    'live 数必须按 owner 各自累计',
  );
  const owners = seen.map((s) => s.ownerId);
  assert.equal(owners.length, 9, '探针必须恰好被调用 9 次（每次上传一次）');
  assert.equal(new Set(owners.slice(0, 4)).size, 1, '他人 4 次调用必须是同一 owner');
  assert.equal(new Set(owners.slice(4, 8)).size, 1, '本人 4 次调用必须是同一 owner');
  assert.notEqual(owners[0], owners[4], '两个会话必须是不同 owner');
  assert.equal(owners[8], owners[0], '第 5 次他人上传必须回到他人 owner');
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
  // 与未接线同一条文案：能力缺位就如实说缺的是什么，不退回「服务不可用」。
  assert.equal(refused.body.error.message, UNWIRED_MESSAGE);
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

// ---------------------------------------------------------------- 结构性断言
// 读源码文本、不另造解析器（与 `tests/unit/media-real-mode-fail-closed.test.mjs` 同一范式）：
// 锚点缺失或不唯一**必须抛错**，不得静默通过。

const SERVICE_SOURCE = readFileSync(new URL('../../services/api/src/media/service.ts', import.meta.url), 'utf8')
  // 换行归一：锚点切片按 `\n` 定位，Linux/Windows 检出都必须切在同一处。
  .replace(/\r\n/g, '\n');

/** 按唯一锚点切出 `attachmentLimitFor` 的函数体（去掉空白与纯注释行）。 */
function attachmentLimitBody(source) {
  // W12：`liveCommunityImageCount` 改成从持久化台账读（async），函数签名随之变成
  // `async … : Promise<number>`。锚点机械跟随签名，下面 1)~4) 的判据一条未改。
  const anchor = 'async function attachmentLimitFor(actor: MediaActor, purpose: unknown): Promise<number> {';
  const occurrences = source.split(anchor).length - 1;
  assert.equal(occurrences, 1, `锚点必须唯一出现，实际 ${occurrences} 次：${anchor}`);
  const start = source.indexOf(anchor) + anchor.length;
  const end = source.indexOf('\n  }\n', start);
  assert.ok(end > start, '找不到 attachmentLimitFor 的结束锚点');
  return source
    .slice(start, end)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//'))
    .join('\n');
}

test('GY-I06 结构闸门：attachmentLimitFor 只认计数器端口，缺「每帖上限计数」时不得放行', () => {
  const body = attachmentLimitBody(SERVICE_SOURCE);

  // 1) 不存在「未接线 ⇒ 拿本地累计数放行」的短路（正是上一轮被否掉的那一行）。
  assert.doesNotMatch(body, /kind\s*===\s*'unwired'/, 'attachmentLimitFor 不得对 unwired 另开分支');
  assert.doesNotMatch(body, /return\s+liveCommunityImages\s*;/, '不得把本地存活记录数直接当上限放行');
  assert.doesNotMatch(SERVICE_SOURCE, /kind\s*===\s*'unwired'/, '整个 media/service.ts 都不该有 unwired 短路');

  // 2) 早退只有「非 community_image 直接 0」这一条：`counted === null` 之前不得出现任何放行 return。
  const lines = body.split('\n');
  const nullCheck = lines.findIndex((line) => line.includes('counted === null'));
  assert.ok(nullCheck > 0, 'attachmentLimitFor 必须显式判定 counted === null');
  assert.deepEqual(
    lines.slice(0, nullCheck).filter((line) => line.includes('return')),
    ["if (purpose !== 'community_image') return 0;"],
    '缺清理器／权威计数器时不得放行：counted === null 之前不允许出现其他 return',
  );

  // 3) `counted === null` 必须 fail-closed：503 码、retryable false、机器可读 details。
  assert.match(
    body,
    /throw new ApiError\('PROVIDER_UNAVAILABLE', ATTACHMENT_LIMIT_UNWIRED_MESSAGE, \{/,
    '必须仍抛 503 闭集码 PROVIDER_UNAVAILABLE',
  );
  assert.match(body, /retryable: false/, '能力缺位不是瞬时故障：retryable 必须为 false');
  assert.match(body, /details: \[\{ field: '\/purpose', code: 'post_image_limit_unwired' \}\]/, '必须给出机器可读判别');

  // 4) 文案常量必须点明「每帖上限计数未接线」，且不得退回泛化的不可用话术。
  const messageBlock = SERVICE_SOURCE.slice(SERVICE_SOURCE.indexOf('const ATTACHMENT_LIMIT_UNWIRED_MESSAGE =')).split(';')[0];
  assert.match(messageBlock, /'每帖上限计数未接线：/, '503 文案常量必须以「每帖上限计数未接线」开头');
  assert.doesNotMatch(messageBlock, /服务不可用|稍后重试|暂时不可用|请稍候/, '不得用泛化的不可用文案顶替（会掩盖能力未装配）');

  // 5) 默认（real）计数器自身永不给出数字：未接线就是「无法判定」，不是「从 0 起算的累计数」。
  const unwired = createUnwiredAttachmentCounter();
  assert.equal(unwired.kind, 'unwired');
  assert.equal(unwired.countFor({ ownerId: 'any-owner', liveCommunityImages: 0 }), null);
  assert.equal(unwired.countFor({ ownerId: 'any-owner', liveCommunityImages: 3 }), null, '哪怕本地有 3 条 live 记录也必须返回 null');
  assert.match(unwired.note, /每帖上限计数未接线/, '未接线计数器的 note 必须点明缺的是「每帖上限计数」');
});
