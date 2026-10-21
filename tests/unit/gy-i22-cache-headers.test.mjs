/**
 * GY-I22（#22）F-01 回归锁：**鉴权失败/拒绝类响应统一 `Cache-Control: no-store`**，
 * 且该收口不得波及公共只读的 2xx 语义。
 *
 * 缺陷出典：I22 安全矩阵（`docs/verification/gy-i22-secmatrix-20261019.md` §9/§10，观察项 F-01）
 * 实测 37 个游客面里 **23 面的 401 响应没有 `Cache-Control`**——消息域（3 面）与社区域（11 面）
 * 在 `onRequest` 钩子里统一写头，所以它们的错误响应也带头；其余域把 `Cache-Control` 写在**成功分支**，
 * 鉴权失败抛错后改走 `app.setErrorHandler`，于是 401/403/404/503 全部**丢失**该头。
 *
 * 修复口径（`services/api/src/app.ts`，唯一产品代码改动）：在应用级加**一个** `onSend` 出口钩子，
 * 对 `statusCode >= 400` 且尚未写该头的响应补 `no-store`。`setErrorHandler` 覆盖不到
 * `setNotFoundHandler` 的未匹配 404 与将来直接 `reply.status(4xx).send()` 的拒绝面，`onSend` 是
 * 三者共同唯一出口，所以选它；只认 `>= 400`，因此**本修复对任何 2xx 响应体、头部逐字节无影响**。
 *
 * 本文件四组断言（对应派单 ②(a)-(e) 与「公共只读保持可缓存」边界）：
 *   1. 游客 401：F-01 缺口的 23 个面 + 2 个本来就带头的面，**逐面**断言恰好等于 `no-store`。
 *   2. 拒绝家族：403 后台拒绝 / 404 跨用户同形拒绝 / 未匹配 404 / 400 校验 / 415 媒体类型 /
 *      503 域门——全部带 `no-store`（即「不只 401」）。
 *   3. 2xx 边界：私有成功响应仍是 `no-store`（既有语义，未变）；**公共只读** `GET /health` 的 200
 *      **不带**任何 `Cache-Control`——这是「没有一律关掉公共缓存」的负控制，必须一直是 `undefined`。
 *   4. 出口健壮性（合成路由，仅测试内注册）：抛 `Error` 的 500、直接 `reply.status(409).send()`
 *      的拒绝都补到 `no-store`；路由自己写的值**不被覆盖**；合成的 200 公共路由不被加头。
 *
 * 声明：身份、正文、媒体字节全为合成夹具；对象存储 `createSubstituteObjectStore()`、审核
 * `makeSyntheticPassPort('tms')`（四个网络 seam 持有即抛错），**零真实外呼**。夹具与
 * `tests/unit/gy-i22-secmatrix.test.mjs` 同源（该矩阵文件在 `feat/gy-i22-secmatrix` 分支上，
 * 未在本分支提交，故此处自带一份最小夹具，不跨文件 import）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import { createMemoryCommunityStore } from '../../services/api/src/community/store.ts';
import { createSubstituteObjectStore } from '../../services/api/src/media/object-store.ts';
import { sha256Hex } from '../../packages/media/validate.mjs';
import { pngPlain } from '../media/_fixtures.mjs';
import { CLEAN_BODY, CLEAN_TITLE, makeGate, makeSyntheticPassPort } from './community-fixtures.mjs';
import { frozenModerationInjection } from './stall-hygiene-fixtures.mjs';
import { makeControllableVisibility } from './favorites-history-fixtures.mjs';

const API = '/api/v1';
const START = Date.UTC(2026, 9, 25, 4, 0, 0);
/** 契约格式但**不存在**的 uuid：与「跨用户同形」读数对照。 */
const ABSENT = '00000000-0000-4000-8000-000000000000';
const SPECIES_ID = '00000000-0000-4000-8c00-000000000001';

function note(line) {
  console.log(`[I22-CACHE] ${line}`);
}

// ---------------------------------------------------------------------------
// 夹具（与 gy-i22-secmatrix.test.mjs 同源的最小副本）
// ---------------------------------------------------------------------------

function scriptedClock() {
  let nowMs = START;
  return {
    now: () => new Date(nowMs),
    get ms() {
      return nowMs;
    },
  };
}

function makeWorld(t, options = {}) {
  const clock = scriptedClock();
  const auth = createMemoryAuthStore();
  const favorites = createMemoryFavoritesStore({ now: () => clock.ms });
  const history = createMemoryHistoryStore({ now: () => clock.ms });
  const messages = createMemoryMessagesStore({ now: () => clock.ms });
  const community = createMemoryCommunityStore({ now: () => clock.ms });
  const objectStore = options.objectStore ?? createSubstituteObjectStore();
  const visibility = makeControllableVisibility([`species:${SPECIES_ID}`]);
  const config = { ...loadConfig({ APP_EXECUTION_MODE: options.mode ?? 'stub', LOG_LEVEL: 'silent' }) };
  const app = buildApp({
    config,
    store: auth,
    now: clock.now,
    mediaObjectStore: objectStore,
    favoritesInjection: { store: favorites, visibility: visibility.port },
    historyInjection: { store: history, visibility: visibility.port },
    messagesInjection: { store: messages },
    communityInjection: { store: community, gate: makeGate() },
    // 规则层时钟冻结（stall 臂回归）：`makeGate()` 只冻住社区发布闸门这一支，审核域服务是
    // 规则层的**第二个装配点**（`app.ts` 无 `ruleOptions` 缝）。不冻它，墙钟预算
    // （`DEFAULT_RULE_BUDGET_MS = 50`）在机器抖动下会误判 `RULE_TIMEOUT` ⇒ 隔离 ⇒ 422，
    // 与"缓存头/读取时重查"要测的东西无关。注入的服务与 `app.ts:766-777` 默认装配逐字段同形。
    moderationInjection: frozenModerationInjection({
      executionMode: config.executionMode,
      ports: { tms: makeSyntheticPassPort('tms') },
      store: community,
    }),
  });
  t.after(() => app.close());
  return { app, auth, clock, favorites, history, messages, community, objectStore, visibility, config };
}

async function account(world, label) {
  const user = await world.auth.createUser(`${label}-i22ch-${'0'.repeat(48)}`.slice(0, 64));
  const token = mintOpaqueToken();
  await world.auth.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(START + 48 * 3600_000),
    audience: 'user',
  });
  return { user, token };
}

async function call(app, method, url, actor, options = {}) {
  const headers = {
    ...(actor && actor.token ? { authorization: `Bearer ${actor.token}` } : {}),
    ...(options.headers ?? {}),
  };
  const response = await app.inject({
    method,
    url,
    headers,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
  let body = null;
  try {
    body = response.json();
  } catch {
    body = null;
  }
  return {
    status: response.statusCode,
    body,
    text: response.body,
    headers: response.headers,
    cache: response.headers['cache-control'],
  };
}

/** 建一条 ready 的媒体（真实两段式上传 + 替身对象存储放合成 PNG）。 */
async function uploadReadyMedia(world, actor, key, bytes) {
  const created = await call(world.app, 'POST', `${API}/media/uploads`, actor, {
    payload: { purpose: 'community_image', mime: 'image/png', bytes: bytes.length, sha256: sha256Hex(bytes) },
    headers: { 'idempotency-key': `${key}-create` },
  });
  assert.equal(created.status, 201, `建上传失败：${created.text}`);
  const mediaId = created.body.data.media.id;
  const keys = await world.app.mediaService.serverObjectKeys(mediaId);
  assert.ok(keys !== null && typeof keys.rawRef === 'string');
  await world.objectStore.putObject(keys.rawRef, bytes, 'application/octet-stream');
  const completed = await call(world.app, 'POST', `${API}/media/uploads/${mediaId}/complete`, actor, {
    payload: { sha256: sha256Hex(bytes), bytes: bytes.length },
    headers: { 'idempotency-key': `${key}-complete`, 'if-match': '"1"' },
  });
  assert.equal(completed.status, 202, `完成上传失败：${completed.text}`);
  return { mediaId, revision: completed.body.data.revision };
}

/** 播种一个用户的私有行（media/favorite/history/message/post/comment/report）。 */
async function seedOwner(world, actor, tag) {
  const bytes = pngPlain();
  const media = await uploadReadyMedia(world, actor, `i22ch-${tag}`, bytes);

  const favorite = await call(world.app, 'POST', `${API}/favorites`, actor, {
    payload: { target_ref: { type: 'species', id: SPECIES_ID, revision: 1 } },
    headers: { 'idempotency-key': `i22ch-${tag}-fav` },
  });
  assert.equal(favorite.status, 201, favorite.text);

  const appended = await world.app.historyService.appendHistory({
    owner_id: actor.user.id,
    kind: 'recognition',
    target_ref: { type: 'recognition', id: '00000000-0000-4000-8a00-0000000000b1', revision: 1 },
    job_id: '00000000-0000-4000-8b00-0000000000b1',
    job_state: 'succeeded',
    event_key: `i22ch-${tag}-hist`,
  });
  const appendedMessage = await world.app.messagesService.appendMessage({
    owner_id: actor.user.id,
    type: 'comment',
    target_ref: null,
    event_key: `i22ch-${tag}-msg`,
  });

  const post = await call(world.app, 'POST', `${API}/posts`, actor, {
    payload: { title: CLEAN_TITLE, body: CLEAN_BODY, media_ids: [] },
    headers: { 'idempotency-key': `i22ch-${tag}-post` },
  });
  assert.equal(post.status, 201, post.text);
  const postId = post.body.data.id;

  const comment = await call(world.app, 'POST', `${API}/posts/${postId}/comments`, actor, {
    payload: { body: `这是 ${tag} 的评论正文，不得出现在他人越权响应里。` },
    headers: { 'idempotency-key': `i22ch-${tag}-comment`, 'if-match': '"1"' },
  });
  assert.equal(comment.status, 201, comment.text);

  const report = await call(world.app, 'POST', `${API}/reports`, actor, {
    payload: { target_ref: { type: 'post', id: postId, revision: 1 }, reason_code: 'other', detail: `${tag} 的举报细节` },
    headers: { 'idempotency-key': `i22ch-${tag}-report` },
  });
  assert.equal(report.status, 201, report.text);

  return {
    media,
    favoriteId: favorite.body.data.id,
    historyId: appended.history.id,
    messageId: appendedMessage.message.id,
    postId,
    commentId: comment.body.data.id,
    reportId: report.body.data.id,
  };
}

/**
 * 断言：拒绝/私有响应**恰好**是 `Cache-Control: no-store`。
 *
 * 为什么用全等而不是 `cache !== 'public'`：F-01 的实害是「缺该头」时共享缓存/中间代理
 * 理论上可存下一份 401。放宽成「不含 public」会再次放过缺头，本测试就是用来防这个回退的。
 */
function assertNoStore(result, label) {
  const value = result.cache;
  assert.equal(
    typeof value,
    'string',
    `${label}：拒绝/私有响应缺 Cache-Control（现状 ${result.status}）——F-01 回退：${result.text}`,
  );
  assert.equal(value, 'no-store', `${label}：Cache-Control 必须恰好是 no-store，实际 ${String(value)}`);
  const lower = value.toLowerCase();
  assert.equal(lower.includes('public'), false, `${label}：拒绝响应不得带 public，实际 ${value}`);
  assert.equal(lower.includes('max-age'), false, `${label}：拒绝响应不得带 max-age，实际 ${value}`);
}

/** 断言：该响应**没有**任何 `Cache-Control`（公共只读保持可缓存语义的负控制）。 */
function assertNoCacheHeader(result, label) {
  assert.equal(
    result.cache,
    undefined,
    `${label}：公共只读 2xx 不应被一律 no-store（现状 ${String(result.cache)}）`,
  );
}

// ===========================================================================
// 1. 游客 401：F-01 的 23 个缺口面逐面断言 no-store
// ===========================================================================

test('C1 游客 401：F-01 缺口面逐面带 Cache-Control: no-store（23 面 + 2 个既有带头面）', async (t) => {
  const world = makeWorld(t);
  const owner = await account(world, 'owner');
  const seeded = await seedOwner(world, owner, 'own');
  const wkey = (key, version) => ({
    'idempotency-key': key,
    ...(version === undefined ? {} : { 'if-match': version }),
  });

  // 面清单逐行对应证据页 §9「缺口面」：/favorites(3)、/history(2)、/media/*(5)、
  // /community/media-access、/community/media/{grant_id}/content、/knowledge(2)、/herbicides(2)、
  // /me/profile(2)、/catalog/crops、/auth/session、/auth/logout、/me/account/deletion、
  // /account/deletions/{id}；末尾两面（/messages、/posts）是 `onRequest` 域，修复前就带头，
  // 留着作「修复没有把它们弄坏」的对照。
  const faces = [
    ['GET /favorites', 'GET', `${API}/favorites`],
    ['POST /favorites', 'POST', `${API}/favorites`, { payload: { target_ref: { type: 'species', id: SPECIES_ID, revision: 1 } }, headers: wkey('i22ch-g-fav-1') }],
    ['DELETE /favorites/{id}', 'DELETE', `${API}/favorites/${seeded.favoriteId}`, { headers: wkey('i22ch-g-fav-2', '"1"') }],
    ['GET /history', 'GET', `${API}/history`],
    ['DELETE /history/{id}', 'DELETE', `${API}/history/${seeded.historyId}`, { headers: wkey('i22ch-g-hist-1', '"1"') }],
    ['POST /media/uploads', 'POST', `${API}/media/uploads`, { payload: { purpose: 'community_image', mime: 'image/png', bytes: 1024, sha256: 'a'.repeat(64) }, headers: wkey('i22ch-g-media-1') }],
    ['POST /media/uploads/{id}/complete', 'POST', `${API}/media/uploads/${seeded.media.mediaId}/complete`, { payload: { sha256: 'a'.repeat(64), bytes: 1024 }, headers: wkey('i22ch-g-media-2', '"1"') }],
    ['GET /media/{id}', 'GET', `${API}/media/${seeded.media.mediaId}`],
    ['DELETE /media/{id}', 'DELETE', `${API}/media/${seeded.media.mediaId}`, { headers: wkey('i22ch-g-media-3', `"${seeded.media.revision}"`) }],
    ['POST /media/{id}/access', 'POST', `${API}/media/${seeded.media.mediaId}/access`, { headers: wkey('i22ch-g-media-4', `"${seeded.media.revision}"`) }],
    ['POST /community/media-access', 'POST', `${API}/community/media-access`, { payload: { content_ref: { type: 'post', id: seeded.postId, revision: 1 }, media_ref: { media_id: seeded.media.mediaId, media_revision: seeded.media.revision }, slot: 'attachment', author_revision: 1 }, headers: wkey('i22ch-g-media-5', '"1"') }],
    ['GET /community/media/{grant_id}/content', 'GET', `${API}/community/media/${ABSENT}/content`, { headers: { 'x-media-access-token': 'synthetic-guest-grant-token' } }],
    ['GET /knowledge', 'GET', `${API}/knowledge`],
    ['GET /knowledge/{id}', 'GET', `${API}/knowledge/00000000-0000-4000-8d00-000000000001`],
    ['GET /herbicides', 'GET', `${API}/herbicides`],
    ['GET /herbicides/{id}', 'GET', `${API}/herbicides/00000000-0000-4000-8d00-000000000002`],
    ['GET /me/profile', 'GET', `${API}/me/profile`],
    ['PUT /me/profile', 'PUT', `${API}/me/profile`, { payload: { crop_id: 'rice', region_code: '330100', region_catalog_version: 'v1' }, headers: wkey('i22ch-g-profile-1', '"1"') }],
    ['GET /catalog/crops', 'GET', `${API}/catalog/crops`],
    ['GET /auth/session', 'GET', `${API}/auth/session`],
    ['POST /auth/logout', 'POST', `${API}/auth/logout`, { headers: wkey('i22ch-g-logout-1') }],
    ['POST /me/account/deletion', 'POST', `${API}/me/account/deletion`, { payload: { confirmation: 'delete_account' }, headers: wkey('i22ch-g-deletion-1') }],
    ['GET /account/deletions/{id}', 'GET', `${API}/account/deletions/${ABSENT}`],
    ['GET /messages（onRequest 域对照）', 'GET', `${API}/messages`],
    ['GET /posts（onRequest 域对照）', 'GET', `${API}/posts`],
  ];

  const readings = [];
  for (const [label, method, url, options] of faces) {
    const result = await call(world.app, method, url, null, options ?? {});
    assert.equal(result.status, 401, `${label}：游客必须 401，实际 ${result.status}：${result.text}`);
    assert.equal(result.body?.error?.code, 'SESSION_REQUIRED', `${label}：错误码必须是 SESSION_REQUIRED`);
    assertNoStore(result, label);
    assert.equal(result.body.error.retryable, false, `${label}：游客拒绝不得可重试`);
    readings.push(`${label}=no-store`);
    note(`C1 ${label} → 401 SESSION_REQUIRED，Cache-Control=${result.cache}`);
  }

  // 逐面读数（证据页直接抄这一行）：25 面，0 面缺头。
  note(`C1 合计 ${faces.length} 面，全部 Cache-Control=no-store；缺头 0 面（F-01 修复前为 23 面缺头）`);
  assert.equal(readings.length, faces.length);
  assert.equal(readings.length, 25, '面清单是 F-01 的 23 个缺口面 + 2 个 onRequest 对照面，不得悄悄减少');
});

// ===========================================================================
// 2. 拒绝家族：不只 401 —— 403 / 404 / 400 / 415 / 503 都带 no-store
// ===========================================================================

test('C2/C3 拒绝家族：403 后台拒绝、404 跨用户同形、未匹配 404、400 校验、415 媒体类型、503 域门全带 no-store', async (t) => {
  const world = makeWorld(t);
  const alice = await account(world, 'alice');
  const bob = await account(world, 'bob');
  const b = await seedOwner(world, bob, 'bob');
  const wkey = (key, version) => ({
    'idempotency-key': key,
    ...(version === undefined ? {} : { 'if-match': version }),
  });

  const cases = [];

  // (a) 403：普通用户 token 打后台面——由已挂载路由的守卫拒绝，不是「路由不存在」。
  for (const path of ['/admin/sources', '/admin/accounts']) {
    const result = await call(world.app, 'GET', `${API}${path}`, alice);
    assert.equal(result.status, 403, `GET ${path}：普通用户必须 403，实际 ${result.status}：${result.text}`);
    assert.equal(result.body?.error?.code, 'SCOPE_DENIED', `GET ${path}：错误码必须是 SCOPE_DENIED`);
    assertNoStore(result, `403 GET ${path}`);
    cases.push(`403 GET ${path}`);
  }

  // (b) 404 跨用户同形拒绝（IDOR 面）：alice 拿 bob 的 id，与「不存在的 id」逐字节同形。
  // 每行给两个 URL：bob 的真实 id（越权）与同形但**不存在**的 id（对照组）。
  const crossUser = [
    ['GET /media/{bob}', 'GET', `${API}/media/${b.media.mediaId}`, `${API}/media/${ABSENT}`, {}],
    ['DELETE /media/{bob}', 'DELETE', `${API}/media/${b.media.mediaId}`, `${API}/media/${ABSENT}`, { headers: wkey('i22ch-a-media-del', `"${b.media.revision}"`) }],
    ['PATCH /comments/{bob}', 'PATCH', `${API}/comments/${b.commentId}`, `${API}/comments/${ABSENT}`, { payload: { body: 'alice 改 bob 的评论' }, headers: wkey('i22ch-a-comment', '"1"') }],
    ['GET /reports/{bob}', 'GET', `${API}/reports/${b.reportId}`, `${API}/reports/${ABSENT}`, {}],
  ];
  for (const [label, method, url, absentUrl, options] of crossUser) {
    const result = await call(world.app, method, url, alice, options);
    const absentResult = await call(world.app, method, absentUrl, alice, options);
    assert.equal(result.status, 404, `${label}：跨用户必须 404，实际 ${result.status}：${result.text}`);
    assertNoStore(result, label);
    // 同形：状态码与错误封套（去掉 request_id 后）完全一致——不给存在性信号。
    assert.equal(absentResult.status, 404, `${label}：不存在的 id 也必须 404`);
    assertNoStore(absentResult, `${label}（不存在 id 对照）`);
    assert.deepEqual(
      { ...result.body, meta: { ...result.body.meta, request_id: undefined } },
      { ...absentResult.body, meta: { ...absentResult.body.meta, request_id: undefined } },
      `${label}：跨用户与不存在 id 必须逐字节同形`,
    );
    cases.push(`404 ${label}`);
  }

  // (c) 未匹配路径的 404：走 `setNotFoundHandler`，`setErrorHandler` 根本不会被调用——
  // 这是选 `onSend` 而不是只改 `setErrorHandler` 的实测理由。
  const unmatched = await call(world.app, 'GET', `${API}/__i22ch-no-such-route`);
  assert.equal(unmatched.status, 404, `未匹配路径必须 404，实际 ${unmatched.status}`);
  assertNoStore(unmatched, '404 未匹配路径');
  note(`404 未匹配路径封套：${unmatched.text}`);
  cases.push('404 未匹配路径');

  // (d) 400 校验失败（`setErrorHandler` 的 validation 分支）：游客 + 非法体。
  const invalid = await call(world.app, 'GET', `${API}/favorites?limit=not-a-number`);
  assert.equal(invalid.status, 400, `非法 query 必须 400，实际 ${invalid.status}：${invalid.text}`);
  assert.equal(invalid.body?.error?.code, 'INVALID_REQUEST');
  assertNoStore(invalid, '400 校验失败');
  cases.push('400 INVALID_REQUEST');

  // (e) 415 不支持的媒体类型（`FST_ERR_CTP_INVALID_MEDIA_TYPE` 分支）。
  // 注：`text/plain` 会被解析成字符串再落到 schema ⇒ 400；只有真的没有解析器（如 application/xml）
  // 才走 415 分支。两条分支都要带 no-store，这里各取一条实测。
  const unsupported = await call(world.app, 'POST', `${API}/favorites`, alice, {
    payload: '<target_ref/>',
    headers: { 'content-type': 'application/xml', 'idempotency-key': 'i22ch-415' },
  });
  assert.equal(unsupported.status, 415, `application/xml 体必须 415，实际 ${unsupported.status}：${unsupported.text}`);
  assertNoStore(unsupported, '415 媒体类型');
  cases.push('415 媒体类型');

  // (e2) `text/plain` ⇒ 解析成功但 schema 拒绝 ⇒ 400（同一 `setErrorHandler`，另一分支）。
  const plainBody = await call(world.app, 'POST', `${API}/favorites`, alice, {
    payload: 'target_ref=species',
    headers: { 'content-type': 'text/plain', 'idempotency-key': 'i22ch-400-plain' },
  });
  assert.equal(plainBody.status, 400, `text/plain 体必须 400，实际 ${plainBody.status}：${plainBody.text}`);
  assertNoStore(plainBody, '400 schema 拒绝（text/plain）');
  cases.push('400 schema 拒绝（text/plain）');

  // (f) 503 域门（`ApiError` 分支，stub 下资料库未接入）：私有面在有效会话下也不是 200。
  const unavailable = await call(world.app, 'GET', `${API}/me/profile`, alice);
  assert.equal(unavailable.status, 503, `stub 下 /me/profile 必须 503，实际 ${unavailable.status}：${unavailable.text}`);
  assert.equal(unavailable.body?.error?.code, 'PROVIDER_UNAVAILABLE');
  assertNoStore(unavailable, '503 域门');
  cases.push('503 PROVIDER_UNAVAILABLE');

  note(`C2/C3 拒绝家族合计 ${cases.length} 条：${cases.join('、')}，全部 Cache-Control=no-store`);
  assert.ok(cases.length >= 9, '拒绝家族样本不得少于 9 条');
});

// ===========================================================================
// 3. 2xx 边界：私有成功响应仍 no-store；公共只读 200 不被加头
// ===========================================================================

test('2xx 边界：私有成功响应保持 no-store，公共只读 GET /health 200 不带 Cache-Control', async (t) => {
  const world = makeWorld(t);
  const alice = await account(world, 'alice');
  const a = await seedOwner(world, alice, 'alice');

  // (a) 私有成功响应（含用户维度字段）：现状语义就是 `no-store`，本修复不动 2xx，逐面锁住。
  // 派单允许的弱形式是 `private` + 无 max-age；本仓既有口径严格到 `no-store`，这里锁严格值。
  const privateFaces = [
    ['GET /favorites', 'GET', `${API}/favorites`],
    ['GET /history', 'GET', `${API}/history`],
    ['GET /messages', 'GET', `${API}/messages`],
    ['GET /messages/unread-count', 'GET', `${API}/messages/unread-count`],
    ['GET /media/{id}', 'GET', `${API}/media/${a.media.mediaId}`],
    ['GET /posts', 'GET', `${API}/posts`],
    ['GET /posts/{id}', 'GET', `${API}/posts/${a.postId}`],
    ['GET /auth/session', 'GET', `${API}/auth/session`],
    ['GET /herbicides', 'GET', `${API}/herbicides`],
  ];
  for (const [label, method, url] of privateFaces) {
    const result = await call(world.app, method, url, alice);
    assert.equal(result.status, 200, `${label}：有效会话必须 200，实际 ${result.status}：${result.text}`);
    assertNoStore(result, `${label}（私有 2xx）`);
    note(`私有 2xx ${label} → 200，Cache-Control=${result.cache}`);
  }

  // (b) 公共只读成功响应的负控制：`GET /health` 未登录、只读、200，且**没有任何** Cache-Control。
  // 若哪天有人把收口写成「全局无条件 no-store」，这条会立刻红。
  const health = await call(world.app, 'GET', '/health', null);
  assert.equal(health.status, 200, `/health 必须 200，实际 ${health.status}：${health.text}`);
  assertNoCacheHeader(health, 'GET /health（公共只读 200）');
  assert.equal(health.body?.status, 'ok');
  note(`公共只读 GET /health → 200，Cache-Control=${String(health.cache)}（保持缺省，未被 no-store 波及）`);

  // (c) `/api/v1/public/home` 是公共内容面，本仓**既有**语义是路由自己写 `no-store`（本次不改它）；
  // stub 下资料库未接入 ⇒ 503，错误面同样应带 no-store。
  const publicHome = await call(world.app, 'GET', `${API}/public/home`, null);
  assert.equal(publicHome.status, 503, `stub 下 /public/home 必须 503，实际 ${publicHome.status}：${publicHome.text}`);
  assert.equal(publicHome.body?.error?.code, 'PROVIDER_UNAVAILABLE');
  assertNoStore(publicHome, 'GET /public/home（公共内容面，stub 503）');
  note('公共内容面 GET /public/home → 503 PROVIDER_UNAVAILABLE，Cache-Control=no-store（路由自己写，未被改）');
});

// ===========================================================================
// 4. 出口健壮性：合成路由（仅测试内注册）覆盖 500 兜底与「直接回 4xx」
// ===========================================================================

test('统一出口：抛错的 500 与路由直接 reply.status(4xx).send() 的拒绝也补 no-store，且不覆盖路由自己写的值', async (t) => {
  const world = makeWorld(t);

  // 合成路由必须在 `app.ready()`（第一次 inject）之前注册。它们只存在于本测试内，不进产品代码。
  world.app.get('/__i22ch/public-200', async () => ({ ok: true }));
  world.app.get('/__i22ch/throw', async () => {
    throw new Error('i22ch synthetic boom');
  });
  world.app.get('/__i22ch/reject-409', async (_request, reply) => reply.status(409).send({ error: { code: 'SYNTHETIC_CONFLICT' } }));
  world.app.get('/__i22ch/reject-with-own-header', async (_request, reply) => {
    reply.header('Cache-Control', 'private, max-age=0');
    return reply.status(403).send({ error: { code: 'SYNTHETIC_DENIED' } });
  });

  // (a) 抛错 → `setErrorHandler` 的 else 分支（500 + contract_gap），仍必须有 no-store。
  const thrown = await call(world.app, 'GET', '/__i22ch/throw', null);
  assert.equal(thrown.status, 500, `抛错必须 500，实际 ${thrown.status}：${thrown.text}`);
  assert.equal(thrown.body?.contract_gap, 'NO_CONTRACT_CODE_FOR_500', `500 兜底必须显式标记契约缺口：${thrown.text}`);
  assertNoStore(thrown, '500 兜底（合成抛错路由）');
  note(`500 兜底（合成抛错）→ ${thrown.status}，Cache-Control=${thrown.cache}`);

  // (b) 路由自己直接 `reply.status(409).send()`：`setErrorHandler` 看不到这条路径，
  // 全靠 `onSend` 出口兜住——这是「统一出口」而非「只补 errorHandler」的直接证据。
  const direct = await call(world.app, 'GET', '/__i22ch/reject-409', null);
  assert.equal(direct.status, 409, `直接回 409 必须原样 409，实际 ${direct.status}`);
  assertNoStore(direct, '409 直接 send（合成路由）');
  note(`409 直接 reply.status(409).send() → ${direct.status}，Cache-Control=${direct.cache}`);

  // (c) 路由已写自己的缓存值时不覆盖（收口只补缺省，不夺权）。
  const own = await call(world.app, 'GET', '/__i22ch/reject-with-own-header', null);
  assert.equal(own.status, 403);
  assert.equal(own.cache, 'private, max-age=0', `路由自写值不得被覆盖，实际 ${String(own.cache)}`);
  note(`路由自写 Cache-Control=${own.cache} 未被覆盖（403）`);

  // (d) 合成的公共 200：出口钩子不碰 2xx ⇒ 头保持缺省。
  const publicOk = await call(world.app, 'GET', '/__i22ch/public-200', null);
  assert.equal(publicOk.status, 200);
  assertNoCacheHeader(publicOk, '合成公共 200');
  note(`合成公共 200 → ${publicOk.status}，Cache-Control=${String(publicOk.cache)}（未被加头）`);
});
