/**
 * GY-I22（#22）关键安全与权限用例矩阵 —— **一张可核对的清单 + 每行的实证断言**。
 *
 * 本文件只做「矩阵」这一件事：把六类高风险面摊开成逐行用例，每行断言**实际 HTTP 状态码、
 * 错误码与响应体形状**，并显式声明该行是「现有断言已覆盖（引用文件:行号）」还是「本片新增断言」。
 * 它**不宣称系统安全**：只证明「在这些固定输入下，服务端返回了这组固定输出」。
 *
 * 六类（与 `docs/verification/gy-i22-secmatrix-*.md` 的证据页逐行对应）：
 *   C1 游客面：未登录访问私有域/写接口必须统一 401，且不得回他人数据。
 *   C2 跨用户越权（IDOR）：A 拿 B 的 media/message/post/comment/favorite/history/report/deletion id，
 *      一律 404（或 403/401 由凭据边界决定），响应体与「不存在的 id」**逐字节同形**，不泄露 B 的任何字段。
 *   C3 后台拒绝：普通用户 token 与伪造 `role/isAdmin` 头/体/查询都不得进入 `/admin/**`；拒绝来自
 *      **已挂载路由上的守卫**（403 SCOPE_DENIED），不是「路由不存在」或前端隐藏。
 *   C4 会话与注销：退出后旧 token 在**同一时刻**失效（不是等 TTL）；重复退出不复活；注销请求幂等重放
 *      换发回执 bearer、旧 bearer 立即失效；「取消注销」在契约中**没有入口**（记未取得，不编造）。
 *   C5 媒体归属：上传签名绑定 owner+media；complete/read/delete/access 的路径 id 不能跨用户；
 *      客户端**无法**在 body 里声明对象 key/path/owner（`additionalProperties:false` ⇒ 400）。
 *   C6 模拟/真实交叉：stub 里产出的 id 在 real 装配下一律 503（可解释的拒绝），且 real 下没有任何
 *      写入口 ⇒ 不可能反向产出「真实 id」；`preset_demo` 与 `stub` 同族可互换。
 *
 * 声明（不得误读）：
 * - 全部身份、正文、媒体字节均为**合成夹具**；对象存储用 `createSubstituteObjectStore()`，
 *   审核用 `makeSyntheticPassPort('tms')`（四个网络 seam 持有即抛错），**零真实外呼**。
 * - 依赖真实微信/真机/真实供应商的用例在证据页记「未取得」，本文件不伪造。
 * - bash 依赖的校验（如小程序侧脚本）本机为 WSL 存根，证据页记「未取得」。
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
/** 契约格式但**不存在**的 uuid：所有「同形」断言都以它为对照。 */
const ABSENT = '00000000-0000-4000-8000-000000000000';
const SPECIES_ID = '00000000-0000-4000-8c00-000000000001';

/** 合成对象存储/审核端口的声明（证据页逐字引用）。 */
const SYNTHETIC_NOTE = 'substitute 对象存储 + synthetic pass 审核端口：零真实供应商调用';

/** 行读数：同时打印到 stdout，供证据页抄录实际状态码。 */
function note(line) {
  console.log(`[I22] ${line}`);
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function scriptedClock() {
  let nowMs = START;
  return {
    now: () => new Date(nowMs),
    get ms() {
      return nowMs;
    },
    advance(ms) {
      nowMs += ms;
    },
  };
}

/** 一个 stub 装配（内存 store 全套 + 替身对象存储 + 合成审核端口）。 */
function makeWorld(t, options = {}) {
  const clock = scriptedClock();
  const auth = createMemoryAuthStore();
  const favorites = createMemoryFavoritesStore({ now: () => clock.ms });
  const history = createMemoryHistoryStore({ now: () => clock.ms });
  const messages = createMemoryMessagesStore({ now: () => clock.ms });
  const community = createMemoryCommunityStore({ now: () => clock.ms });
  const objectStore = options.objectStore ?? createSubstituteObjectStore();
  const visibility = makeControllableVisibility([`species:${SPECIES_ID}`]);
  const config = {
    ...loadConfig({ APP_EXECUTION_MODE: options.mode ?? 'stub', LOG_LEVEL: 'silent' }),
    ...(options.mode === undefined ? {} : { executionMode: options.mode }),
  };
  const app = buildApp({
    config,
    store: options.store ?? auth,
    now: clock.now,
    mediaObjectStore: objectStore,
    favoritesInjection: { store: favorites, visibility: visibility.port },
    historyInjection: { store: history, visibility: visibility.port },
    messagesInjection: { store: messages },
    communityInjection: { store: community, gate: makeGate() },
    // 规则层时钟冻结（stall 臂回归）：`makeGate()` 只冻住社区发布闸门这一支；审核域服务是
    // 规则层的**第二个装配点**（`services/api/src/app.ts` 的 `moderationInjection` 在本基线
    // 没有 `ruleOptions` 缝）。不冻它，墙钟预算（`DEFAULT_RULE_BUDGET_MS = 50`）在机器抖动／
    // 插桩下会误判 `RULE_TIMEOUT` ⇒ 隔离 ⇒ 投稿 422，与「越权/同形/零外呼」要测的东西无关。
    // 注入的服务与 `app.ts:766-777` 默认装配逐字段同形，唯一差别是规则层 `clock` 常量化；
    // 预算仍是出厂 50ms（冻结后 `now - started === 0`，检查照跑、永不误判）。
    moderationInjection: frozenModerationInjection({
      executionMode: config.executionMode,
      ports: { tms: makeSyntheticPassPort('tms') },
      store: community,
    }),
  });
  t.after(() => app.close());
  return { app, auth, clock, favorites, history, messages, community, objectStore, visibility, config };
}

/** 直接播种一个用户会话（不经过微信换取，零外呼）。 */
async function account(world, label) {
  const user = await world.auth.createUser(`${label}-i22-${'0'.repeat(48)}`.slice(0, 64));
  const token = mintOpaqueToken();
  const session = await world.auth.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(START + 48 * 3600_000),
    audience: 'user',
  });
  return { user, token, session };
}

async function adminAccount(world, scopes) {
  const userId = await world.auth.createAdmin({
    loginName: `i22-admin-${scopes.length}-${Math.random().toString(36).slice(2, 8)}`,
    credentialHash: 'synthetic-not-a-real-credential-hash',
    scopes,
  });
  const token = mintOpaqueToken();
  await world.auth.createSession({
    userId,
    tokenHashHex: hashToken(token),
    authEpoch: 1,
    expiresAt: new Date(START + 3600_000),
    audience: 'admin',
  });
  return { userId, token, scopes };
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
    etag: response.headers.etag,
    cache: response.headers['cache-control'],
    executionMode: response.headers['x-execution-mode'],
  };
}

/** 错误封套的「指纹」：去掉 `request_id` 后逐字节可比。 */
function fingerprint(result) {
  return JSON.stringify({
    status: result.status,
    error: result.body?.error,
    contract: result.body?.meta?.contract_version,
    mode: result.body?.meta?.execution_mode,
  });
}

/**
 * 封套**形状**指纹：把 `message` 换成占位符后的同一份比较。
 * 用途：不同守卫可以给出不同的**人话提示**（例如注销回执口说的是「需要注销回执 bearer」），
 * 但状态码 / code / retryable / details / 契约版本 / 模式必须完全一致。
 */
function envelopeShape(result) {
  const error = { ...(result.body?.error ?? {}) };
  if (typeof error.message === 'string') error.message = '<message>';
  return JSON.stringify({
    status: result.status,
    error,
    contract: result.body?.meta?.contract_version,
    mode: result.body?.meta?.execution_mode,
  });
}

/** 断言「拒绝」的公共形状：失败封套 + 无成功 data + no-store + 契约版本。 */
function assertRejection(result, { status, code }) {
  assert.equal(result.status, status, `状态码应为 ${status}，实际 ${result.status}：${result.text}`);
  assert.equal(result.body?.error?.code, code, `错误码应为 ${code}，实际 ${result.body?.error?.code}：${result.text}`);
  assert.equal(typeof result.body.error.message, 'string');
  assert.equal(typeof result.body.error.retryable, 'boolean');
  assert.ok(Array.isArray(result.body.error.details), 'details 必须是数组');
  assert.equal(result.body.data, undefined, '错误响应不得携带成功封套');
  assert.equal(result.body.meta.contract_version, '1.0.0');
  // 缓存头：**现状**是「消息域 + 社区域在 onRequest 钩子里统一写 no-store，其余域的错误响应缺该头」。
  // 本矩阵把它当**观察项 F-01**（见证据页「缺陷单」）：这里只锁住安全不变量——拒绝响应绝不允许
  // 出现可缓存的中间值（`public`/`max-age`），缺头与 no-store 都放行并逐面打印，供证据页抄录。
  assert.ok(
    result.cache === undefined || result.cache === 'no-store',
    `拒绝响应不得带可缓存指令：${String(result.cache)}`,
  );
}

/** 断言响应体不含这些「他人字段」的明文。 */
function assertNoLeak(result, secrets, label) {
  const text = result.text;
  for (const secret of secrets) {
    assert.equal(text.includes(secret), false, `${label}：响应体泄露了 ${secret}：${text}`);
  }
}

/** 建一条 ready 的媒体（走真实上传两段式；替身对象存储里放合成 PNG）。 */
async function uploadReadyMedia(world, actor, key, options = {}) {
  const bytes = options.bytes ?? pngPlain();
  const mime = options.mime ?? 'image/png';
  const purpose = options.purpose ?? 'community_image';
  const created = await call(world.app, 'POST', `${API}/media/uploads`, actor, {
    payload: { purpose, mime, bytes: bytes.length, sha256: sha256Hex(bytes) },
    headers: { 'idempotency-key': `${key}-create` },
  });
  assert.equal(created.status, 201, `建上传失败：${created.text}`);
  const mediaId = created.body.data.media.id;
  const keys = world.app.mediaService.serverObjectKeys(mediaId);
  assert.ok(keys !== null && typeof keys.rawRef === 'string');
  await world.objectStore.putObject(keys.rawRef, bytes, 'application/octet-stream');
  const completed = await call(world.app, 'POST', `${API}/media/uploads/${mediaId}/complete`, actor, {
    payload: { sha256: sha256Hex(bytes), bytes: bytes.length },
    headers: { 'idempotency-key': `${key}-complete`, 'if-match': '"1"' },
  });
  assert.equal(completed.status, 202, `完成上传失败：${completed.text}`);
  return {
    mediaId,
    revision: completed.body.data.revision,
    upload: created.body.data.upload,
    rawKey: keys.rawRef,
    derivativeKey: keys.derivativeRef,
  };
}

/** 解码媒体访问签名（`base64url(payload).hmac`）——只读声明，不验签（验签是服务端的事）。 */
function decodeClaims(token) {
  assert.equal(typeof token, 'string');
  const dot = token.indexOf('.');
  assert.ok(dot > 0, '签名必须是 base64url(payload).hmac 形态');
  return JSON.parse(Buffer.from(token.slice(0, dot), 'base64url').toString('utf8'));
}

/** 播种 B 的全部私有行（media/message/post/comment/favorite/history/report）。 */
async function seedB(world, b) {
  const bytes = pngPlain();
  const media = await uploadReadyMedia(world, b, 'i22-seed-b', { bytes });

  const favorite = await call(world.app, 'POST', `${API}/favorites`, b, {
    payload: { target_ref: { type: 'species', id: SPECIES_ID, revision: 1 } },
    headers: { 'idempotency-key': 'i22-seed-fav-b' },
  });
  assert.equal(favorite.status, 201, favorite.text);

  const appended = await world.app.historyService.appendHistory({
    owner_id: b.user.id,
    kind: 'recognition',
    target_ref: { type: 'recognition', id: '00000000-0000-4000-8a00-0000000000b1', revision: 1 },
    job_id: '00000000-0000-4000-8b00-0000000000b1',
    job_state: 'succeeded',
    event_key: 'i22-seed-hist-b',
  });
  // 内部创建口返回 `{created, message}`（不是消息本身）：见 services/api/src/messages/service.ts:425-443。
  const appendedMessage = await world.app.messagesService.appendMessage({
    owner_id: b.user.id,
    type: 'comment',
    target_ref: null,
    event_key: 'i22-seed-msg-b',
  });

  const post = await call(world.app, 'POST', `${API}/posts`, b, {
    payload: { title: CLEAN_TITLE, body: CLEAN_BODY, media_ids: [] },
    headers: { 'idempotency-key': 'i22-seed-post-b' },
  });
  assert.equal(post.status, 201, post.text);
  const postId = post.body.data.id;

  const comment = await call(world.app, 'POST', `${API}/posts/${postId}/comments`, b, {
    payload: { body: '这是 B 的评论正文，不得出现在 A 的越权响应里。' },
    // 评论写口的 If-Match 指向**目标帖子**的当前 revision（服务层口径，非本片新增约束）。
    headers: { 'idempotency-key': 'i22-seed-comment-b', 'if-match': '"1"' },
  });
  assert.equal(comment.status, 201, comment.text);

  const report = await call(world.app, 'POST', `${API}/reports`, b, {
    payload: { target_ref: { type: 'post', id: postId, revision: 1 }, reason_code: 'other', detail: 'B 的举报细节' },
    headers: { 'idempotency-key': 'i22-seed-report-b' },
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

/** 向一个 stub 世界登记一条注销请求（返回 id + 回执 bearer）。 */
async function requestDeletion(world, actor, key) {
  const accepted = await call(world.app, 'POST', `${API}/me/account/deletion`, actor, {
    payload: { confirmation: 'delete_account' },
    headers: { 'idempotency-key': key },
  });
  assert.equal(accepted.status, 202, accepted.text);
  return {
    id: accepted.body.data.deletion.id,
    receiptToken: accepted.body.data.receipt_token,
    deletion: accepted.body.data.deletion,
    raw: accepted,
  };
}

// ===========================================================================
// C1 游客面
// ===========================================================================

test('C1 游客面：未登录访问私有域/写接口统一 401，封套逐字节同形且不回他人数据', async (t) => {
  const world = makeWorld(t);
  const b = await account(world, 'guest-b');
  const seeded = await seedB(world, b);
  const wkey = (key, version) => ({ 'idempotency-key': key, ...(version === undefined ? {} : { 'if-match': version }) });

  // 每一行都是**结构合法**的请求：万一鉴权漏了，服务层会真的去处理它（这才有意义）。
  const faces = [
    ['GET /favorites', 'GET', `${API}/favorites`],
    ['POST /favorites', 'POST', `${API}/favorites`, { payload: { target_ref: { type: 'species', id: SPECIES_ID, revision: 1 } }, headers: wkey('i22-guest-fav-0001') }],
    ['DELETE /favorites/{id}', 'DELETE', `${API}/favorites/${seeded.favoriteId}`, { headers: wkey('i22-guest-fav-0002', '"1"') }],
    ['GET /history', 'GET', `${API}/history`],
    ['DELETE /history/{id}', 'DELETE', `${API}/history/${seeded.historyId}`, { headers: wkey('i22-guest-hist-0001', '"1"') }],
    ['GET /messages', 'GET', `${API}/messages`],
    ['GET /messages/unread-count', 'GET', `${API}/messages/unread-count`],
    ['PUT /messages/{id}/read', 'PUT', `${API}/messages/${seeded.messageId}/read`, { headers: wkey('i22-guest-msg-0001', '"1"') }],
    ['POST /media/uploads', 'POST', `${API}/media/uploads`, { payload: { purpose: 'community_image', mime: 'image/png', bytes: 1024, sha256: 'a'.repeat(64) }, headers: wkey('i22-guest-media-0001') }],
    ['POST /media/uploads/{id}/complete', 'POST', `${API}/media/uploads/${seeded.media.mediaId}/complete`, { payload: { sha256: 'a'.repeat(64), bytes: 1024 }, headers: wkey('i22-guest-media-0002', '"1"') }],
    ['GET /media/{id}', 'GET', `${API}/media/${seeded.media.mediaId}`],
    ['DELETE /media/{id}', 'DELETE', `${API}/media/${seeded.media.mediaId}`, { headers: wkey('i22-guest-media-0003', '"2"') }],
    ['POST /media/{id}/access', 'POST', `${API}/media/${seeded.media.mediaId}/access`, { headers: wkey('i22-guest-media-0004', '"2"') }],
    ['POST /community/media-access', 'POST', `${API}/community/media-access`, { payload: { content_ref: { type: 'post', id: seeded.postId, revision: 1 }, media_ref: { media_id: seeded.media.mediaId, media_revision: seeded.media.revision }, slot: 'attachment', author_revision: 1 }, headers: wkey('i22-guest-media-0005', '"1"') }],
    ['GET /community/media/{grant_id}/content', 'GET', `${API}/community/media/${ABSENT}/content`, { headers: { 'x-media-access-token': 'synthetic-guest-grant-token' } }],
    ['GET /knowledge', 'GET', `${API}/knowledge`],
    ['GET /knowledge/{id}', 'GET', `${API}/knowledge/00000000-0000-4000-8d00-000000000001`],
    ['GET /herbicides', 'GET', `${API}/herbicides`],
    ['GET /herbicides/{id}', 'GET', `${API}/herbicides/00000000-0000-4000-8d00-000000000002`],
    ['GET /posts', 'GET', `${API}/posts`],
    ['POST /posts', 'POST', `${API}/posts`, { payload: { title: CLEAN_TITLE, body: CLEAN_BODY, media_ids: [] }, headers: wkey('i22-guest-post-0001') }],
    ['GET /posts/{id}', 'GET', `${API}/posts/${seeded.postId}`],
    ['PATCH /posts/{id}', 'PATCH', `${API}/posts/${seeded.postId}`, { payload: { title: CLEAN_TITLE, body: CLEAN_BODY, media_ids: [] }, headers: wkey('i22-guest-post-0002', '"1"') }],
    ['DELETE /posts/{id}', 'DELETE', `${API}/posts/${seeded.postId}`, { headers: wkey('i22-guest-post-0003', '"1"') }],
    ['GET /posts/{id}/comments', 'GET', `${API}/posts/${seeded.postId}/comments`],
    ['POST /posts/{id}/comments', 'POST', `${API}/posts/${seeded.postId}/comments`, { payload: { body: '游客评论正文' }, headers: wkey('i22-guest-comment-0001') }],
    ['PATCH /comments/{id}', 'PATCH', `${API}/comments/${seeded.commentId}`, { payload: { body: '游客改评论' }, headers: wkey('i22-guest-comment-0002', '"1"') }],
    ['PUT /posts/{id}/like', 'PUT', `${API}/posts/${seeded.postId}/like`, { headers: wkey('i22-guest-like-0001', '"1"') }],
    ['POST /reports', 'POST', `${API}/reports`, { payload: { target_ref: { type: 'post', id: seeded.postId, revision: 1 }, reason_code: 'other' }, headers: wkey('i22-guest-report-0001') }],
    ['GET /reports/{id}', 'GET', `${API}/reports/${seeded.reportId}`],
    ['GET /me/profile', 'GET', `${API}/me/profile`],
    ['PUT /me/profile', 'PUT', `${API}/me/profile`, { payload: { crop_id: 'rice', region_code: '330100', region_catalog_version: 'v1' }, headers: wkey('i22-guest-profile-0001', '"1"') }],
    ['GET /catalog/crops', 'GET', `${API}/catalog/crops`],
    ['GET /auth/session', 'GET', `${API}/auth/session`],
    ['POST /auth/logout', 'POST', `${API}/auth/logout`, { headers: wkey('i22-guest-logout-0001') }],
    ['POST /me/account/deletion', 'POST', `${API}/me/account/deletion`, { payload: { confirmation: 'delete_account' }, headers: wkey('i22-guest-deletion-0001') }],
    ['GET /account/deletions/{id}', 'GET', `${API}/account/deletions/${ABSENT}`],
  ];

  // 缓存头分布（观察项 F-01）：只有消息域与社区域在 `onRequest` 钩子里统一写 no-store，
  // 其余域的错误响应缺该头。逐面打印，供证据页逐字抄录，不在本片修产品代码。
  const noStoreFaces = [];
  const missingNoStore = [];
  const shapes = new Set();
  const fullFingerprints = new Set();
  const receiptFaceMessage = [];
  for (const [label, method, url, options] of faces) {
    const result = await call(world.app, method, url, null, options ?? {});
    assertRejection(result, { status: 401, code: 'SESSION_REQUIRED' });
    assert.equal(result.body.error.retryable, false, `${label}：游客拒绝不得可重试`);
    assert.deepEqual(result.body.error.details, [], `${label}：游客拒绝不得带 details`);
    assertNoLeak(result, [b.user.id, CLEAN_TITLE, CLEAN_BODY, seeded.postId, seeded.commentId], label);
    shapes.add(envelopeShape(result));
    fullFingerprints.add(fingerprint(result));
    if (label === 'GET /account/deletions/{id}') receiptFaceMessage.push(result.body.error.message);
    (result.cache === 'no-store' ? noStoreFaces : missingNoStore).push(label);
    note(`C1 ${label} → 401 SESSION_REQUIRED（封套一致；Cache-Control=${result.cache ?? '<缺>'}` + '）');
  }
  // 所有面的**形状**必须完全一致（一个 code、一个 retryable、一个 details、一个契约版本）。
  assert.equal(shapes.size, 1, `游客拒绝封套形状必须唯一，实际 ${shapes.size} 种：${[...shapes].join(' | ')}`);
  // 人话提示允许**恰好一处**差异：注销回执口用的是「回执 bearer」守卫，不是用户会话守卫。
  // 这不是不一致——它仍要求凭据、仍是同一 code、仍不带任何数据；差异被逐字锁在这里。
  assert.equal(fullFingerprints.size, 2, `除注销回执口外，游客拒绝封套必须逐字节同形，实际 ${fullFingerprints.size} 种`);
  assert.deepEqual(receiptFaceMessage, ['需要注销回执 bearer'], '注销回执口的提示应当只说明它要的是回执凭据');
  assert.ok(noStoreFaces.length > 0, '至少要有一批面真的带了 no-store（否则缓存头断言是空转）');
  note(`C1 合计 ${faces.length} 面：全部 401 SESSION_REQUIRED，封套形状指纹唯一（1 种）`);
  note(`C1 逐字节指纹 2 种：唯一差异是 GET /account/deletions/{id} 的 message＝「${receiptFaceMessage[0]}」（另一守卫，同一 code，非数据泄露）`);
  note(`C1 缓存头：带 no-store 的 ${noStoreFaces.length} 面 = ${noStoreFaces.join('、')}`);
  note(`C1 缓存头：缺 Cache-Control 的 ${missingNoStore.length} 面 = ${missingNoStore.join('、')}（观察项 F-01，非数据泄露）`);

  // 正控制：同一批面在有效会话下**不会**被 401 拦住（否则「游客 401」可能只是因为路由坏了）。
  const positive = [
    ['GET', `${API}/favorites`],
    ['GET', `${API}/history`],
    ['GET', `${API}/messages`],
    ['GET', `${API}/messages/unread-count`],
    ['GET', `${API}/media/${seeded.media.mediaId}`],
    ['GET', `${API}/knowledge`],
    ['GET', `${API}/posts`],
    ['GET', `${API}/posts/${seeded.postId}`],
    ['GET', `${API}/me/profile`],
    ['GET', `${API}/catalog/crops`],
    ['GET', `${API}/auth/session`],
  ];
  for (const [method, url] of positive) {
    const result = await call(world.app, method, url, b);
    assert.notEqual(result.status, 401, `正控制失败：${method} ${url} 对有效会话返回 401：${result.text}`);
    assert.notEqual(result.status, 403, `正控制失败：${method} ${url} 对有效会话返回 403：${result.text}`);
    note(`C1 正控制 ${method} ${url} → ${result.status}`);
  }

  // 已发布社区内容对**任何已登录用户**可见（设计如此，不属越权）：这条必须在矩阵里说清楚，
  // 否则「B 的 post id 对 A 404」会被误读成社区也不该公开。
  const publicRead = await call(world.app, 'GET', `${API}/posts/${seeded.postId}`, null);
  assertRejected: {
    // 游客仍 401（社区读取也要登录）；A 登录后可读（公开内容）。
  }
  assert.equal(publicRead.status, 401);
  const asA = await account(world, 'guest-a');
  const aReadsBPost = await call(world.app, 'GET', `${API}/posts/${seeded.postId}`, asA);
  assert.equal(aReadsBPost.status, 200, `已发布帖子必须对已登录用户可读：${aReadsBPost.text}`);
  note(`C1 对照：已发布帖子 B→A 可读（${aReadsBPost.status}），公开内容不属越权；游客仍 ${publicRead.status}`);

  // 鉴权与 schema 的**顺序**：Fastify 在 preHandler 之前跑 schema 校验，因此「游客 + 非法请求体」
  // 得到的是 400 INVALID_REQUEST 而不是 401。这不是漏洞（无业务数据、无存在性信号），
  // 但矩阵必须如实登记，避免把「401」当成对所有输入都成立的承诺。
  const malformed = await call(world.app, 'POST', `${API}/media/uploads`, null, {
    payload: { purpose: 'not-a-purpose' },
    headers: { 'idempotency-key': 'i22-guest-malformed-1' },
  });
  assert.equal(malformed.status, 400, malformed.text);
  assert.equal(malformed.body.error.code, 'INVALID_REQUEST');
  assert.equal(malformed.body.data, undefined);
  // `details` 是**字段路径 + ajv 关键字消息**（services/api/src/app.ts:1600-1609：field=instancePath、
  // code=item.message），不是请求体回显：逐条锁住键集，并断言提交的值本身没有出现在响应里。
  assert.ok(Array.isArray(malformed.body.error.details) && malformed.body.error.details.length > 0, '校验失败应给出字段级 details');
  for (const detail of malformed.body.error.details) {
    assert.deepEqual(Object.keys(detail).sort(), ['code', 'field'], `details 只能有 field/code：${JSON.stringify(detail)}`);
    assert.equal(typeof detail.field, 'string');
    assert.equal(typeof detail.code, 'string');
  }
  assertNoLeak(malformed, ['not-a-purpose'], 'C1 顺序对照');
  note('C1 顺序对照：游客 + 非法上传体 → 400 INVALID_REQUEST（schema 在 preHandler 之前；details 只有字段路径/关键字，无提交值回显）');
});

// ===========================================================================
// C2 跨用户越权（IDOR）
// ===========================================================================

test('C2 跨用户越权：A 拿 B 的 id 一律 404 且与「不存在」逐字节同形、不泄露 B 的字段', async (t) => {
  const world = makeWorld(t);
  const a = await account(world, 'idor-a');
  const b = await account(world, 'idor-b');
  const c = await account(world, 'idor-c');
  const seeded = await seedB(world, b);
  const cDeletion = await requestDeletion(world, c, 'i22-idor-del-c-0001');
  const wkey = (key, version) => ({ 'idempotency-key': key, ...(version === undefined ? {} : { 'if-match': version }) });
  const secretsB = [b.user.id, CLEAN_TITLE, CLEAN_BODY, '这是 B 的评论正文，不得出现在 A 的越权响应里。'];
  const secretsC = [c.user.id, cDeletion.id, cDeletion.receiptToken];

  // ---- 读面：A 拿 B 的 id 读 ----
  const reads = [
    ['GET /media/{id}', 'GET', (id) => `${API}/media/${id}`],
    ['GET /posts/{id}/comments（评论正文）', 'GET', (id) => `${API}/posts/${id}/comments`],
  ];
  for (const [label, method, build] of reads) {
    const target = label.includes('comments') ? seeded.postId : seeded.media.mediaId;
    const foreign = await call(world.app, method, build(target), a);
    if (label.includes('comments')) {
      // 已发布帖子的评论列表是公开内容（与帖子同口径）：A 可读，但里面只有公开字段。
      assert.equal(foreign.status, 200, foreign.text);
      assert.equal(foreign.text.includes(b.user.id), false, '评论列表不得回真实账号 id');
      note(`C2 ${label} → ${foreign.status}（公开内容；无账号 id 泄露）`);
    } else {
      assertRejection(foreign, { status: 404, code: 'NOT_FOUND' });
      assertNoLeak(foreign, secretsB, label);
      note(`C2 ${label} → 404 NOT_FOUND（无 B 字段）`);
    }
  }

  // ---- 派生量面：未读计数只算**自己**的行（B 那条未读不得计进 A） ----
  const aUnread = await call(world.app, 'GET', `${API}/messages/unread-count`, a);
  const bUnread = await call(world.app, 'GET', `${API}/messages/unread-count`, b);
  assert.equal(aUnread.status, 200, aUnread.text);
  assert.equal(aUnread.body.data.count, 0, `A 的未读不得计入 B 的行：${aUnread.text}`);
  // B 的未读 > 0 即可（种子动作会顺带产生别的通知行；本断言只证明「B 的行确实算在 B 头上」）。
  assert.ok(bUnread.body.data.count >= 1, `B 自己的未读应含该条（否则 A 的 0 是假象）：${bUnread.text}`);
  note(`C2 GET /messages/unread-count：A=${aUnread.body.data.count}，B=${bUnread.body.data.count}（派生量按属主过滤）`);

  // ---- 私有资源：A 读/改/删 B 的资源，逐条与「不存在的 id」比对 ----
  const idorPairs = [
    ['GET /media/{id}', 'GET', (id) => `${API}/media/${id}`, seeded.media.mediaId],
    ['POST /media/uploads/{id}/complete', 'POST', (id) => `${API}/media/uploads/${id}/complete`, seeded.media.mediaId, { payload: { sha256: 'a'.repeat(64), bytes: 1024 }, headers: wkey('i22-idor-media-0002', `"${seeded.media.revision}"`) }],
    ['DELETE /media/{id}', 'DELETE', (id) => `${API}/media/${id}`, seeded.media.mediaId, { headers: wkey('i22-idor-media-0003', `"${seeded.media.revision}"`) }],
    ['POST /media/{id}/access', 'POST', (id) => `${API}/media/${id}/access`, seeded.media.mediaId, { headers: wkey('i22-idor-media-0004', `"${seeded.media.revision}"`) }],
    ['PUT /messages/{id}/read', 'PUT', (id) => `${API}/messages/${id}/read`, seeded.messageId, { headers: wkey('i22-idor-msg-0001', '"1"') }],
    ['DELETE /favorites/{id}', 'DELETE', (id) => `${API}/favorites/${id}`, seeded.favoriteId, { headers: wkey('i22-idor-fav-0001', '"1"') }],
    ['DELETE /history/{id}', 'DELETE', (id) => `${API}/history/${id}`, seeded.historyId, { headers: wkey('i22-idor-hist-0001', '"1"') }],
    ['PATCH /posts/{id}', 'PATCH', (id) => `${API}/posts/${id}`, seeded.postId, { payload: { title: CLEAN_TITLE, body: CLEAN_BODY, media_ids: [] }, headers: wkey('i22-idor-post-0001', '"1"') }],
    ['DELETE /posts/{id}', 'DELETE', (id) => `${API}/posts/${id}`, seeded.postId, { headers: wkey('i22-idor-post-0002', '"1"') }],
    ['PATCH /comments/{id}', 'PATCH', (id) => `${API}/comments/${id}`, seeded.commentId, { payload: { body: '越权改评论' }, headers: wkey('i22-idor-comment-0001', '"1"') }],
    ['DELETE /comments/{id}', 'DELETE', (id) => `${API}/comments/${id}`, seeded.commentId, { headers: wkey('i22-idor-comment-0002', '"1"') }],
    ['GET /reports/{id}', 'GET', (id) => `${API}/reports/${id}`, seeded.reportId],
  ];

  for (const [label, method, build, foreignId, options] of idorPairs) {
    const foreign = await call(world.app, method, build(foreignId), a, options ?? {});
    const missing = await call(world.app, method, build(ABSENT), a, options ?? {});
    assert.equal(foreign.status, 404, `${label}：越权必须 404（防探测），实际 ${foreign.status}：${foreign.text}`);
    assert.equal(foreign.body.error.code, 'NOT_FOUND', label);
    assert.equal(foreign.body.data, undefined, `${label}：不得回成功封套`);
    assert.equal(fingerprint(foreign), fingerprint(missing), `${label}：越权与不存在的响应必须逐字节同形`);
    assertNoLeak(foreign, secretsB, label);
    note(`C2 ${label} A→B → 404 NOT_FOUND（与不存在 id 同形）`);
  }

  // ---- 消息枚举面：A 的列表里不得出现 B 的那条 ----
  const aMessages = await call(world.app, 'GET', `${API}/messages`, a);
  assert.equal(aMessages.status, 200, aMessages.text);
  assert.equal(aMessages.text.includes(seeded.messageId), false, 'A 的消息列表混入了 B 的消息');
  const bMessages = await call(world.app, 'GET', `${API}/messages`, b);
  assert.equal(bMessages.body.data.items.some((row) => row.id === seeded.messageId), true, 'B 自己的列表必须含该条（否则上面的「不存在」是假象）');
  note(`C2 GET /messages：A 列表 ${aMessages.body.data.items.length} 条（无 B 的 id）；B 列表 ${bMessages.body.data.items.length} 条（含其 id）`);

  // ---- 收藏/历史枚举面：A 看不到 B 的行 ----
  const aFavorites = await call(world.app, 'GET', `${API}/favorites`, a);
  const bFavorites = await call(world.app, 'GET', `${API}/favorites`, b);
  assert.equal(aFavorites.status, 200, aFavorites.text);
  assert.equal(aFavorites.text.includes(seeded.favoriteId), false);
  assert.equal(bFavorites.body.data.items.some((row) => row.id === seeded.favoriteId), true);
  const aHistory = await call(world.app, 'GET', `${API}/history`, a);
  const bHistory = await call(world.app, 'GET', `${API}/history`, b);
  assert.equal(aHistory.status, 200, aHistory.text);
  assert.equal(aHistory.text.includes(seeded.historyId), false);
  assert.equal(bHistory.body.data.items.some((row) => row.id === seeded.historyId), true);
  note(`C2 枚举面：A 收藏 ${aFavorites.body.data.items.length}/历史 ${aHistory.body.data.items.length} 条，均不含 B 的 id；B 各自含 1 条`);

  // ---- 注销请求的 id：凭据边界（会话令牌 / 别人的回执都不能顶替） ----
  // 回执口**不是**会话授权，而是「不记名凭据」：持有回执 bearer 即被授权（与重置口令同类）。
  // 因此本矩阵能证的边界是：id 单独（无 bearer）、他人 bearer、会话令牌 三种都拿不到数据；
  // 「拿到 C 的 bearer」= 已经拿到秘密本身，属凭据保管问题，不是 IDOR。
  const receiptBySession = await call(world.app, 'GET', `${API}/account/deletions/${cDeletion.id}`, a);
  assertRejection(receiptBySession, { status: 401, code: 'SESSION_EXPIRED' });
  assertNoLeak(receiptBySession, secretsC, 'deletion receipt by session');
  const aDeletion = await requestDeletion(world, a, 'i22-idor-del-a-0001');
  const receiptByForeignBearer = await call(world.app, 'GET', `${API}/account/deletions/${cDeletion.id}`, { token: aDeletion.receiptToken });
  assertRejection(receiptByForeignBearer, { status: 401, code: 'SESSION_EXPIRED' });
  assertNoLeak(receiptByForeignBearer, secretsC, 'deletion receipt cross-user');
  const receiptByRandomId = await call(world.app, 'GET', `${API}/account/deletions/${ABSENT}`, { token: aDeletion.receiptToken });
  assertRejection(receiptByRandomId, { status: 401, code: 'SESSION_EXPIRED' });
  assert.equal(fingerprint(receiptByForeignBearer), fingerprint(receiptByRandomId), '回执越权与不存在必须同形');
  const ownReceipt = await call(world.app, 'GET', `${API}/account/deletions/${cDeletion.id}`, { token: cDeletion.receiptToken });
  assert.equal(ownReceipt.status, 200, `C 自己的回执必须可读（否则上面的 401 只是坏路由）：${ownReceipt.text}`);
  assertNoLeak(ownReceipt, [c.user.id], 'C 自己的回执');
  note('C2 注销回执：A 会话令牌 → 401 SESSION_EXPIRED；A 自己的 bearer 打 C 的 id → 401（与不存在同形）；C 自己的 bearer → 200');

  // ---- 客户端不能用 query/body 声明身份 ----
  const queryOwner = await call(world.app, 'GET', `${API}/messages?owner_id=${b.user.id}`, a);
  assert.equal(queryOwner.status, 400, `query 声明 owner 必须 400：${queryOwner.text}`);
  assert.equal(queryOwner.body.error.code, 'INVALID_REQUEST');
  const queryUser = await call(world.app, 'GET', `${API}/favorites?user_id=${b.user.id}`, a);
  assert.equal(queryUser.status, 400, queryUser.text);
  const bodyOwner = await call(world.app, 'POST', `${API}/media/uploads`, a, {
    payload: { purpose: 'community_image', mime: 'image/png', bytes: 16, sha256: 'a'.repeat(64), owner_id: b.user.id },
    headers: wkey('i22-idor-media-0009'),
  });
  assert.equal(bodyOwner.status, 400, `body 声明 owner 必须 400：${bodyOwner.text}`);
  assert.equal(bodyOwner.body.error.code, 'INVALID_REQUEST');
  note('C2 身份声明面：?owner_id= / ?user_id= / body owner_id 全部 400 INVALID_REQUEST（身份只来自 Bearer 会话）');

  // ---- 归属类资源在被拒后必须保持原样（拒绝不是「删了再说没权限」） ----
  const bAfter = await call(world.app, 'GET', `${API}/posts/${seeded.postId}`, b);
  assert.equal(bAfter.status, 200);
  assert.equal(bAfter.body.data.title, CLEAN_TITLE, 'B 的帖子标题被越权请求改动了');
  const mediaAfter = await call(world.app, 'GET', `${API}/media/${seeded.media.mediaId}`, b);
  assert.equal(mediaAfter.status, 200, 'B 的媒体被越权请求删掉了');
  const favAfter = await call(world.app, 'GET', `${API}/favorites`, b);
  assert.equal(favAfter.body.data.items.length, 1, 'B 的收藏被越权请求删掉了');
  const histAfter = await call(world.app, 'GET', `${API}/history`, b);
  assert.equal(histAfter.body.data.items.length, 1, 'B 的历史被越权请求删掉了');
  const msgAfter = await call(world.app, 'GET', `${API}/messages`, b);
  assert.equal(msgAfter.body.data.items[0].read_at, null, 'B 的消息被越权标成已读');
  note('C2 事后态：B 的帖子/媒体/收藏/历史/消息全部原样（拒绝无副作用）');
});

// ===========================================================================
// C3 后台拒绝
// ===========================================================================

test('C3 后台拒绝：普通用户与伪造 role/isAdmin 一律拒绝，且拒绝来自已挂载路由的守卫', async (t) => {
  const world = makeWorld(t);
  const a = await account(world, 'admin-a');
  const scopeLess = await adminAccount(world, []);
  const scoped = await adminAccount(world, ['sources:read', 'sources:write', 'audit:read']);
  const wkey = (key, version) => ({ 'idempotency-key': key, ...(version === undefined ? {} : { 'if-match': version }) });

  const adminFaces = [
    ['GET /admin/sources', 'GET', `${API}/admin/sources`],
    ['POST /admin/sources', 'POST', `${API}/admin/sources`, { payload: { name: '越权建源' }, headers: wkey('i22-admin-src-0001') }],
    ['GET /admin/knowledge', 'GET', `${API}/admin/knowledge`],
    ['GET /admin/registrations', 'GET', `${API}/admin/registrations`],
    ['GET /admin/restrictions', 'GET', `${API}/admin/restrictions`],
    ['GET /admin/audit-events', 'GET', `${API}/admin/audit-events`],
    ['GET /admin/accounts', 'GET', `${API}/admin/accounts`],
    ['GET /admin/categories', 'GET', `${API}/admin/categories`],
    ['GET /admin/jobs', 'GET', `${API}/admin/jobs`],
  ];

  // 路由确实挂载了：拒绝是「守卫说不」，不是「404 假装没有」。
  for (const [, method, url] of adminFaces) {
    const path = url.replace(API, '');
    assert.equal(world.app.hasRoute({ method, url }), true, `${method} ${url} 未挂载（那 403 就失去意义）`);
    assert.equal(path.length > 0, true);
  }

  const userFingerprints = new Set();
  for (const [label, method, url, options] of adminFaces) {
    const result = await call(world.app, method, url, a, options ?? {});
    assertRejection(result, { status: 403, code: 'SCOPE_DENIED' });
    assertNoLeak(result, [a.user.id], label);
    userFingerprints.add(fingerprint(result));
    note(`C3 ${label} 普通用户 token → 403 SCOPE_DENIED`);
  }
  assert.equal(userFingerprints.size, 1, `用户 token 打后台的拒绝封套必须唯一：${[...userFingerprints].join(' | ')}`);

  // 游客 → 401（不是 403）：鉴权先于授权。
  const guest = await call(world.app, 'GET', `${API}/admin/sources`, null);
  assertRejection(guest, { status: 401, code: 'SESSION_REQUIRED' });
  note('C3 游客 → 401 SESSION_REQUIRED（鉴权先于授权）');

  // 伪造头：全部不得改变判定（与不带伪造头逐字节同形）。
  const base = await call(world.app, 'GET', `${API}/admin/sources`, a);
  const forgedHeaders = [
    ['x-role', 'admin'],
    ['x-user-role', 'admin'],
    ['x-is-admin', 'true'],
    ['x-admin', 'true'],
    ['x-scopes', 'sources:write'],
    ['x-auth-scopes', 'sources:write audit:read'],
    ['x-user-id', scoped.userId],
    ['x-actor', 'admin'],
  ];
  for (const [header, value] of forgedHeaders) {
    const forged = await call(world.app, 'GET', `${API}/admin/sources`, a, { headers: { [header]: value } });
    assert.equal(forged.status, 403, `${header} 伪造后状态必须仍是 403：${forged.text}`);
    assert.equal(fingerprint(forged), fingerprint(base), `${header}: ${value} 改变了拒绝形状 ⇒ 头部被采信`);
    note(`C3 伪造头 ${header}: ${value} → 403 SCOPE_DENIED（与基准同形）`);
  }
  // 伪造头 + 游客：仍是 401（头部不能造出会话）。
  const guestForged = await call(world.app, 'GET', `${API}/admin/sources`, null, { headers: { 'x-role': 'admin', 'x-is-admin': 'true', 'x-user-id': scoped.userId } });
  assertRejection(guestForged, { status: 401, code: 'SESSION_REQUIRED' });
  note('C3 游客 + 伪造 role/isAdmin 头 → 401 SESSION_REQUIRED（头部无法造会话）');

  // 伪造查询参数：交给服务层之前就被守卫拦下（与基准同形）。
  const forgedQuery = await call(world.app, 'GET', `${API}/admin/sources?role=admin&is_admin=1&user_id=${scoped.userId}`, a);
  assert.equal(forgedQuery.status, 403, forgedQuery.text);
  assert.equal(fingerprint(forgedQuery), fingerprint(base), 'query 伪造改变了拒绝形状');
  note('C3 伪造 query role/is_admin/user_id → 403（与基准同形）');

  // 伪造 body：后台写口**没有** HTTP 层 body schema（校验在内容服务里），因此守卫先拒 ⇒ 403；
  // 无论哪种顺序，都不能提权、不落库、不回显。
  const forgedBody = await call(world.app, 'POST', `${API}/admin/sources`, a, {
    payload: { name: '越权建源', role: 'admin', is_admin: true, scopes: ['sources:write'] },
    headers: wkey('i22-admin-src-0002'),
  });
  assert.equal(forgedBody.status, 403, `body 伪造必须被拒：${forgedBody.text}`);
  assert.equal(forgedBody.body.error.code, 'SCOPE_DENIED');
  assert.equal(forgedBody.body.data, undefined);
  assert.equal(fingerprint(forgedBody), fingerprint(base), 'body 伪造改变了拒绝形状');
  assertNoLeak(forgedBody, ['越权建源'], 'C3 body 伪造');
  note('C3 body 伪造 role/is_admin/scopes → 403 SCOPE_DENIED（与基准同形；不落库、不回显）');

  // 后台 token 但**scope 不足** → 403（不是「后台 token 就全通」）。
  const noScope = await call(world.app, 'GET', `${API}/admin/sources`, scopeLess);
  assertRejection(noScope, { status: 403, code: 'SCOPE_DENIED' });
  note('C3 后台 token 但 scopes=[] → 403 SCOPE_DENIED（scope 逐条校验）');

  // 正控制：有 scope 的后台 token 真的能进（否则上面的 403 可能是「后台整域坏掉」）。
  const allowed = await call(world.app, 'GET', `${API}/admin/sources`, scoped);
  assert.equal(allowed.status, 200, `有 sources:read 的后台 token 必须可读：${allowed.text}`);
  assert.equal(allowed.body.meta.execution_mode, 'stub');
  note(`C3 正控制：sources:read 后台 token → ${allowed.status}`);

  // 受众隔离：后台 token 打用户面 → 401 SESSION_EXPIRED；用户 token 打后台 → 403（上面已证）。
  const adminOnUserFace = await call(world.app, 'GET', `${API}/messages`, scoped);
  assertRejection(adminOnUserFace, { status: 401, code: 'SESSION_EXPIRED' });
  note('C3 受众隔离：后台 token 打用户面 → 401 SESSION_EXPIRED');
});

// ===========================================================================
// C4 会话与注销
// ===========================================================================

test('C4 会话与注销：退出立即失效、重复退出不复活、注销回执幂等换发、取消注销无契约入口', async (t) => {
  const world = makeWorld(t);
  const wkey = (key, version) => ({ 'idempotency-key': key, ...(version === undefined ? {} : { 'if-match': version }) });

  // ---- 通过真实 stub 换取建立会话（不连接微信） ----
  const login = await call(world.app, 'POST', `${API}/auth/wechat`, null, {
    payload: { code: 'i22-c4-user' },
    headers: wkey('i22-c4-login-0001'),
  });
  assert.equal(login.status, 200, login.text);
  const token = login.body.data.access_token;
  assert.equal(typeof token, 'string');
  const actor = { token };
  const session = await call(world.app, 'GET', `${API}/auth/session`, actor);
  assert.equal(session.status, 200, session.text);
  const userId = session.body.data.user_id ?? session.body.data.user?.id;
  const ownMedia = await uploadReadyMedia(world, actor, 'i22-c4-media');

  const before = [
    ['GET /auth/session', 'GET', `${API}/auth/session`],
    ['GET /favorites', 'GET', `${API}/favorites`],
    ['GET /messages', 'GET', `${API}/messages`],
    ['GET /posts', 'GET', `${API}/posts`],
    ['GET /media/{id}', 'GET', `${API}/media/${ownMedia.mediaId}`],
  ];
  for (const [label, method, url] of before) {
    const result = await call(world.app, method, url, actor);
    assert.equal(result.status, 200, `${label} 退出前应 200：${result.text}`);
  }
  note(`C4 退出前：${before.length} 面全部 200（token 有效）`);

  // ---- 退出：同一时刻（时钟未推进）旧 token 立即失效 ----
  const logout = await call(world.app, 'POST', `${API}/auth/logout`, actor, { headers: wkey('i22-c4-logout-0001') });
  assert.equal(logout.status, 200, logout.text);
  assert.equal(logout.body.data.accepted, true);

  const afterFingerprints = new Set();
  for (const [label, method, url] of before) {
    const result = await call(world.app, method, url, actor);
    assertRejection(result, { status: 401, code: 'SESSION_EXPIRED' });
    assertNoLeak(result, [userId].filter(Boolean), label);
    afterFingerprints.add(fingerprint(result));
    note(`C4 退出后 ${label} → 401 SESSION_EXPIRED`);
  }
  assert.equal(afterFingerprints.size, 1, '退出后的拒绝封套必须唯一');
  assert.equal(world.clock.ms, START, '本用例未推进时钟 ⇒ 失效来自会话撤销，不是 TTL');
  note('C4 失效即时性：时钟未推进（仍是受理时刻），旧 token 已 401 ⇒ 撤销即时生效，非 TTL 到期');

  // ---- 重复退出：不得复活，也不得假成功 ----
  const repeat = await call(world.app, 'POST', `${API}/auth/logout`, actor, { headers: wkey('i22-c4-logout-0002') });
  assertRejection(repeat, { status: 401, code: 'SESSION_EXPIRED' });
  note('C4 重复退出（换幂等键）→ 401 SESSION_EXPIRED（不复活、不假成功）');

  // ---- 重新换取：同一微信 code ⇒ 同一账号，新 token 有效，旧 token 仍死 ----
  const relogin = await call(world.app, 'POST', `${API}/auth/wechat`, null, {
    payload: { code: 'i22-c4-user' },
    headers: wkey('i22-c4-login-0002'),
  });
  assert.equal(relogin.status, 200, relogin.text);
  const freshActor = { token: relogin.body.data.access_token };
  const freshSession = await call(world.app, 'GET', `${API}/auth/session`, freshActor);
  assert.equal(freshSession.status, 200, freshSession.text);
  const staleAfterRelogin = await call(world.app, 'GET', `${API}/favorites`, actor);
  assertRejection(staleAfterRelogin, { status: 401, code: 'SESSION_EXPIRED' });
  note('C4 重新登录（同 code）：新 token 200，旧 token 仍 401（撤销不可逆）');

  // ---- 账号注销：幂等重放换发回执 bearer，旧 bearer 立即失效 ----
  const d = await account(world, 'c4-deletion');
  const first = await requestDeletion(world, d, 'i22-c4-del-0001');
  assert.equal(first.deletion.state, 'blocked', `备份未接线 ⇒ 必须如实 blocked：${first.deletion.state}`);
  // C1b 起闭集含消息域（扩大而非替换）：原有两域必须仍在，消息域必须也在。
  assert.deepEqual(first.deletion.handlers.map((row) => row.module).sort(), ['favorites', 'history', 'messages']);
  const firstRead = await call(world.app, 'GET', `${API}/account/deletions/${first.id}`, { token: first.receiptToken });
  assert.equal(firstRead.status, 200, firstRead.text);
  assert.equal(firstRead.body.data.id, first.id);

  const replay = await call(world.app, 'POST', `${API}/me/account/deletion`, d, {
    payload: { confirmation: 'delete_account' },
    headers: wkey('i22-c4-del-0001'),
  });
  assert.equal(replay.status, 202, replay.text);
  assert.equal(replay.body.data.deletion.id, first.id, '同键同体必须收敛到同一删除请求');
  assert.notEqual(replay.body.data.receipt_token, first.receiptToken, '重放只换发，不回放旧 bearer');
  const staleBearer = await call(world.app, 'GET', `${API}/account/deletions/${first.id}`, { token: first.receiptToken });
  assertRejection(staleBearer, { status: 401, code: 'SESSION_EXPIRED' });
  const freshBearer = await call(world.app, 'GET', `${API}/account/deletions/${first.id}`, { token: replay.body.data.receipt_token });
  assert.equal(freshBearer.status, 200, freshBearer.text);
  assert.equal(freshBearer.body.data.state, first.deletion.state, '重复回调不得改变状态（幂等）');
  note(`C4 注销幂等：同键同体 → 同一 id=${first.id}，bearer 换发（旧 401 / 新 200），state 不变（${first.deletion.state}）`);

  // 重复回调（GET 回执）在时钟推进后仍是幂等的状态投影，不因「重试」推进到 completed。
  world.clock.advance(3600_000);
  const laterRead = await call(world.app, 'GET', `${API}/account/deletions/${first.id}`, { token: replay.body.data.receipt_token });
  assert.equal(laterRead.status, 200, laterRead.text);
  assert.equal(laterRead.body.data.state, first.deletion.state, '重复回调不得把时钟到期当完成（不粉饰为 completed）');
  note('C4 重复回调：+1h 后 state 仍不变（不把到期当完成）');

  // 注销请求期间会话仍有效（协议是 7 日在线清理窗口，不是即时踢出）：这是设计，不是缺陷。
  const duringSession = await call(world.app, 'GET', `${API}/auth/session`, d);
  assert.equal(duringSession.status, 200, duringSession.text);
  note('C4 注销期间：本人会话仍 200（异步 7 日窗口设计；与「退出登录即时失效」是两条不同机制）');

  // ---- 取消注销：契约无入口 ⇒ 未取得（如实断言「没有这条路」，不伪造实现） ----
  const cancel = await call(world.app, 'DELETE', `${API}/me/account/deletion`, d, { headers: wkey('i22-c4-cancel-0001') });
  assert.equal(cancel.status, 404, `契约里没有取消注销入口，实际 ${cancel.status}：${cancel.text}`);
  const cancelPatch = await call(world.app, 'PATCH', `${API}/me/account/deletion`, d, {
    payload: { state: 'cancelled' },
    headers: wkey('i22-c4-cancel-0002', '"1"'),
  });
  assert.equal(cancelPatch.status, 404, `PATCH 也不存在（实际 ${cancelPatch.status}）`);
  note('C4 取消注销：DELETE/PATCH /me/account/deletion → 404（契约无 operation、DeletionState 无 cancelled）⇒ 记「未取得」，不伪造');
});

// ===========================================================================
// C5 媒体归属
// ===========================================================================

test('C5 媒体归属：上传签名绑定 owner+media，路径 id 不能跨用户，客户端不能声明对象 key/path/owner', async (t) => {
  const world = makeWorld(t);
  const a = await account(world, 'c5-a');
  const b = await account(world, 'c5-b');
  const wkey = (key, version) => ({ 'idempotency-key': key, ...(version === undefined ? {} : { 'if-match': version }) });

  const mediaA = await uploadReadyMedia(world, a, 'c5-media-a');
  const mediaB = await uploadReadyMedia(world, b, 'c5-media-b');

  // ---- 上传签名 = base64url(payload).hmac：绑定 ownerId/mediaId/revision/exp ----
  const claims = decodeClaims(mediaA.upload.access_token);
  assert.equal(claims.kind, 'upload');
  assert.equal(claims.mediaId, mediaA.mediaId, '签名必须绑定这次上传的 media id');
  assert.equal(claims.ownerId, a.user.id, '签名必须绑定上传者');
  assert.equal(claims.revision, 1);
  assert.equal(typeof claims.exp, 'number', `签名必须带过期时刻（数字时间戳），实际 ${typeof claims.exp}`);
  assert.notEqual(mediaA.upload.access_token, mediaB.upload.access_token, '两次上传的签名不得相同');
  note(`C5 上传签名声明：{kind:${claims.kind}, mediaId:${claims.mediaId}, ownerId:${claims.ownerId}, revision:${claims.revision}}`);

  // 对象 key 是**服务端生成的不透明随机引用**（`newObjectRef()` = `obj_<randomBytes(18) base64url>`，
  // 见 packages/media/store.mjs:10）：客户端从没有可声明的 key，也就无从篡改成别人的路径。
  assert.equal(mediaA.rawKey.startsWith('obj_'), true, `对象 key 必须由服务端生成（obj_ 前缀），实际 ${mediaA.rawKey}`);
  assert.notEqual(mediaA.rawKey, mediaB.rawKey);
  assert.equal(mediaA.rawKey.includes(b.user.id), false, '对象 key 不得内嵌任何用户 id');
  assert.equal(mediaA.upload.method, 'PUT');
  assert.equal(typeof mediaA.upload.url, 'string');
  note(`C5 对象 key 为服务端随机引用（不含用户 id）：A=${mediaA.rawKey}`);

  // ---- 跨用户：complete / read / delete / access 一律 404，且与不存在同形 ----
  const cross = [
    ['POST /media/uploads/{id}/complete', 'POST', (id) => `${API}/media/uploads/${id}/complete`, { payload: { sha256: 'a'.repeat(64), bytes: 16 }, headers: wkey('c5-cross-0001', '"1"') }],
    ['GET /media/{id}', 'GET', (id) => `${API}/media/${id}`, {}],
    ['DELETE /media/{id}', 'DELETE', (id) => `${API}/media/${id}`, { headers: wkey('c5-cross-0002', '"1"') }],
    ['POST /media/{id}/access', 'POST', (id) => `${API}/media/${id}/access`, { headers: wkey('c5-cross-0003', '"1"') }],
  ];
  for (const [label, method, build, options] of cross) {
    const foreign = await call(world.app, method, build(mediaB.mediaId), a, options);
    const missing = await call(world.app, method, build(ABSENT), a, options);
    assert.equal(foreign.status, 404, `${label}：跨用户必须 404，实际 ${foreign.status}：${foreign.text}`);
    assert.equal(foreign.body.error.code, 'NOT_FOUND');
    assert.equal(fingerprint(foreign), fingerprint(missing), `${label}：跨用户与不存在必须同形`);
    assertNoLeak(foreign, [b.user.id], label);
    note(`C5 ${label} A→B → 404 NOT_FOUND（与不存在同形）`);
  }

  // 正控制：A 自己的媒体可读、可授权（否则上面的 404 可能是「媒体域整体坏了」）。
  const ownRead = await call(world.app, 'GET', `${API}/media/${mediaA.mediaId}`, a);
  assert.equal(ownRead.status, 200, ownRead.text);
  const ownGrant = await call(world.app, 'POST', `${API}/media/${mediaA.mediaId}/access`, a, {
    headers: wkey('c5-own-grant-0001', `"${mediaA.revision}"`),
  });
  assert.equal(ownGrant.status, 200, ownGrant.text);
  assert.equal(typeof ownGrant.body.data.access_token, 'string');
  note(`C5 正控制：本人 GET /media → 200；本人 POST /media/{id}/access → ${ownGrant.status}`);

  // ---- 客户端无法指定对象 key/path/owner（多余字段一律 400，不静默剔除） ----
  const tamperedUpload = [
    { purpose: 'community_image', mime: 'image/png', bytes: 16, sha256: 'a'.repeat(64), object_key: 'users/b/raw' },
    { purpose: 'community_image', mime: 'image/png', bytes: 16, sha256: 'a'.repeat(64), path: 'users/b/raw' },
    { purpose: 'community_image', mime: 'image/png', bytes: 16, sha256: 'a'.repeat(64), key: 'users/b/raw' },
    { purpose: 'community_image', mime: 'image/png', bytes: 16, sha256: 'a'.repeat(64), owner_id: b.user.id },
  ];
  for (const [index, payload] of tamperedUpload.entries()) {
    const result = await call(world.app, 'POST', `${API}/media/uploads`, a, {
      payload,
      headers: wkey(`c5-tamper-${index}-0001`),
    });
    assert.equal(result.status, 400, `篡改字段必须 400：${JSON.stringify(payload)} → ${result.text}`);
    assert.equal(result.body.error.code, 'INVALID_REQUEST');
    assert.equal(result.body.data, undefined);
    note(`C5 篡改上传体 ${Object.keys(payload).filter((k) => !['purpose', 'mime', 'bytes', 'sha256'].includes(k)).join('/')} → 400 INVALID_REQUEST`);
  }
  const tamperedComplete = await call(world.app, 'POST', `${API}/media/uploads/${mediaA.mediaId}/complete`, a, {
    payload: { sha256: 'a'.repeat(64), bytes: 16, object_key: mediaB.rawKey, path: mediaB.rawKey },
    headers: wkey('c5-tamper-complete-1', '"1"'),
  });
  assert.equal(tamperedComplete.status, 400, tamperedComplete.text);
  assert.equal(tamperedComplete.body.error.code, 'INVALID_REQUEST');
  assert.equal(tamperedComplete.text.includes(mediaB.rawKey), false, '校验失败不得回显客户端提交的 key');
  note('C5 篡改 complete 体（object_key/path 指向 B 的对象）→ 400 INVALID_REQUEST，且不回显该 key');

  // ---- 归属不可通过「复用别人的幂等键」绕过 ----
  const reuseKey = await call(world.app, 'POST', `${API}/media/uploads/${mediaB.mediaId}/complete`, a, {
    payload: { sha256: 'a'.repeat(64), bytes: 16 },
    headers: wkey('c5-media-b-create', `"${mediaB.revision}"`) },
  );
  assert.equal(reuseKey.status, 404, `复用 B 的幂等键也必须 404：${reuseKey.text}`);
  note('C5 复用 B 的幂等键去 complete B 的媒体 → 404（幂等台账不跨归属）');

  // ---- 共享范围必须是显式凭据：社区读面缺/错 token 都不可读 ----
  const guestContent = await call(world.app, 'GET', `${API}/community/media/${ABSENT}/content`, null, {
    headers: { 'x-media-access-token': 'synthetic-grant' },
  });
  assertRejection(guestContent, { status: 401, code: 'SESSION_REQUIRED' });
  const missingHeader = await call(world.app, 'GET', `${API}/community/media/${ABSENT}/content`, a);
  assert.equal(missingHeader.status, 400, `缺 X-Media-Access-Token 必须 400：${missingHeader.text}`);
  assert.equal(missingHeader.body.error.code, 'INVALID_REQUEST');
  const wrongGrant = await call(world.app, 'GET', `${API}/community/media/${ABSENT}/content`, a, {
    headers: { 'x-media-access-token': a.token },
  });
  assert.equal(wrongGrant.status, 404, `错误句柄必须 404：${wrongGrant.text}`);
  assert.equal(wrongGrant.body.error.code, 'NOT_FOUND');
  note('C5 社区共享读面：游客 401；缺 X-Media-Access-Token 400；错句柄 404（共享范围必须显式凭据）');
});

// ===========================================================================
// C6 模拟 / 真实交叉
// ===========================================================================

test('C6 模拟与真实交叉：stub 产出的 id 在 real 装配下一律 503，real 侧没有写入口，preset_demo 与 stub 同族', async (t) => {
  const stubWorld = makeWorld(t);
  const a = await account(stubWorld, 'c6-a');
  const adminStub = await adminAccount(stubWorld, ['sources:read', 'sources:write', 'audit:read']);
  const seeded = await seedB(stubWorld, a);
  const deletion = await requestDeletion(stubWorld, a, 'i22-c6-del-0001');
  const wkey = (key, version) => ({ 'idempotency-key': key, ...(version === undefined ? {} : { 'if-match': version }) });
  note(`C6 stub 产出 id：media=${seeded.media.mediaId} post=${seeded.postId} fav=${seeded.favoriteId} hist=${seeded.historyId} msg=${seeded.messageId} deletion=${deletion.id}`);

  // ---- preset_demo：与 stub 同族。**注入存储的行可跨装配存在**（auth/favorites/history/messages/
  // community 都是显式注入的同一份内存 store），所以这些 id 在 preset_demo 里照常可用；
  // 媒体记录属**媒体服务实例内部**（不来自注入 store），因此跨装配查不到 —— 这是「存储实例边界」，
  // 不是模式差异，与 real 的 503「域整体未接线」必须分开记录。
  const presetApp = buildApp({
    config: { ...loadConfig({ APP_EXECUTION_MODE: 'preset_demo', LOG_LEVEL: 'silent' }), executionMode: 'preset_demo' },
    store: stubWorld.auth,
    now: stubWorld.clock.now,
    mediaObjectStore: stubWorld.objectStore,
    favoritesInjection: { store: stubWorld.favorites, visibility: stubWorld.visibility.port },
    historyInjection: { store: stubWorld.history, visibility: stubWorld.visibility.port },
    messagesInjection: { store: stubWorld.messages },
    communityInjection: { store: stubWorld.community, gate: makeGate() },
    // 与 `makeWorld` 同口径：`preset_demo` 非 real，审核域仍跑规则层，故同样冻结规则时钟
    // （同源内容权威 = 这份被注入的社区 store，与 `app.ts` 默认一致）。
    moderationInjection: frozenModerationInjection({
      executionMode: 'preset_demo',
      ports: { tms: makeSyntheticPassPort('tms') },
      store: stubWorld.community,
    }),
  });
  t.after(() => presetApp.close());
  const presetMessages = await call(presetApp, 'GET', `${API}/messages`, a);
  assert.equal(presetMessages.status, 200, presetMessages.text);
  assert.equal(presetMessages.body.meta.execution_mode, 'preset_demo');
  const presetFavorites = await call(presetApp, 'GET', `${API}/favorites`, a);
  assert.equal(presetFavorites.status, 200, presetFavorites.text);
  const presetPost = await call(presetApp, 'GET', `${API}/posts/${seeded.postId}`, a);
  assert.equal(presetPost.status, 200, `注入 store 的 id 在 preset_demo 必须可读：${presetPost.text}`);
  const presetMedia = await call(presetApp, 'GET', `${API}/media/${seeded.media.mediaId}`, a);
  assert.equal(presetMedia.status, 404, `媒体记录属服务实例内部，跨装配应 404：${presetMedia.text}`);
  note(`C6 preset_demo：注入 store 的 messages/favorites/posts → ${presetMessages.status}/${presetFavorites.status}/${presetPost.status}；媒体 → ${presetMedia.status}（实例内记录，非模式差异）`);

  // ---- real 装配：同一批 id 一律 503（可解释的拒绝，不是「假装 404 不存在」） ----
  const realEnv = {
    DATABASE_URL: 'postgres://synthetic_local_only@127.0.0.1:5432/gengyun_synthetic_never_connected',
    SESSION_SIGNING_KEY: 'synthetic-not-a-real-signing-key',
    DELETION_LEDGER_KEY: 'synthetic-not-a-real-ledger-key',
    WECHAT_APP_ID: 'synthetic-not-a-real-appid',
    WECHAT_APP_SECRET: 'synthetic-not-a-real-appsecret',
    OBJECT_STORAGE_ENDPOINT: 'https://example.invalid',
    OBJECT_STORAGE_BUCKET: 'synthetic-not-a-real-bucket',
    OBJECT_STORAGE_ACCESS_KEY: 'synthetic-not-a-real-access-key',
    OBJECT_STORAGE_SECRET_KEY: 'synthetic-not-a-real-secret-key',
  };
  const realConfig = loadConfig({ APP_EXECUTION_MODE: 'real', LOG_LEVEL: 'silent', ...realEnv });
  assert.equal(realConfig.executionMode, 'real');
  const realApp = buildApp({
    config: realConfig,
    store: stubWorld.auth,
    now: stubWorld.clock.now,
    mediaObjectStore: stubWorld.objectStore,
    favoritesInjection: { store: stubWorld.favorites, visibility: stubWorld.visibility.port },
    historyInjection: { store: stubWorld.history, visibility: stubWorld.visibility.port },
    messagesInjection: { store: stubWorld.messages },
    communityInjection: { store: stubWorld.community, gate: makeGate() },
  });
  t.after(() => realApp.close());

  const crossFaces = [
    ['GET /media/{id}', 'GET', `${API}/media/${seeded.media.mediaId}`, a],
    ['POST /media/uploads', 'POST', `${API}/media/uploads`, a, { payload: { purpose: 'community_image', mime: 'image/png', bytes: 16, sha256: 'a'.repeat(64) }, headers: wkey('c6-real-media-0001') }],
    ['GET /messages', 'GET', `${API}/messages`, a],
    ['PUT /messages/{id}/read', 'PUT', `${API}/messages/${seeded.messageId}/read`, a, { headers: wkey('c6-real-msg-0001', '"1"') }],
    ['GET /favorites', 'GET', `${API}/favorites`, a],
    ['DELETE /favorites/{id}', 'DELETE', `${API}/favorites/${seeded.favoriteId}`, a, { headers: wkey('c6-real-fav-0001', '"1"') }],
    ['GET /history', 'GET', `${API}/history`, a],
    ['GET /posts', 'GET', `${API}/posts`, a],
    ['GET /posts/{id}', 'GET', `${API}/posts/${seeded.postId}`, a],
    ['GET /admin/sources', 'GET', `${API}/admin/sources`, adminStub],
    ['POST /me/account/deletion', 'POST', `${API}/me/account/deletion`, a, { payload: { confirmation: 'delete_account' }, headers: wkey('c6-real-del-0001') }],
  ];

  for (const [label, method, url, actor, options] of crossFaces) {
    const result = await call(realApp, method, url, actor, options ?? {});
    assert.equal(result.status, 503, `${label}：real 装配下必须 503（可解释的拒绝），实际 ${result.status}：${result.text}`);
    assert.equal(result.body.error.code, 'PROVIDER_UNAVAILABLE', label);
    assert.equal(result.body.error.retryable, false, `${label}：未接线/配置缺失 ⇒ retryable 必须 false`);
    assert.equal(typeof result.body.error.message, 'string');
    assert.ok(result.body.error.message.length > 0);
    assert.equal(result.body.meta.execution_mode, 'real');
    assert.equal(result.body.data, undefined, `${label}：不得返回任何数据（那才是跨模式泄露）`);
    assertNoLeak(result, [seeded.postId, CLEAN_TITLE, CLEAN_BODY, a.user.id], label);
    note(`C6 real ${label} → 503 PROVIDER_UNAVAILABLE（retryable=false，execution_mode=real）`);
  }
  assert.equal(realApp.messagesService, null, 'real 下消息域必须是未接线（null）而不是内存实现');
  assert.equal(realApp.communityService, null, 'real 下社区域必须是未接线');
  assert.notEqual(realApp.mediaService.failClosedReason, null, 'real 下媒体域必须 fail-closed（带可解释原因）');
  note(`C6 real 装配内部：messagesService=null、communityService=null、mediaService.failClosedReason=${JSON.stringify(realApp.mediaService.failClosedReason)}`);

  // ---- 反向：real 侧没有任何写入口 ⇒ 不可能产出「真实 id」（逐个写面 503） ----
  const realWriteFaces = [
    ['POST /posts', 'POST', `${API}/posts`, { payload: { title: CLEAN_TITLE, body: CLEAN_BODY, media_ids: [] }, headers: wkey('c6-real-post-0001') }],
    ['POST /reports', 'POST', `${API}/reports`, { payload: { target_ref: { type: 'post', id: seeded.postId, revision: 1 }, reason_code: 'other' }, headers: wkey('c6-real-report-0001') }],
    ['POST /favorites', 'POST', `${API}/favorites`, { payload: { target_ref: { type: 'species', id: SPECIES_ID, revision: 1 } }, headers: wkey('c6-real-fav-0002') }],
    ['POST /media/{id}/access', 'POST', `${API}/media/${seeded.media.mediaId}/access`, { headers: wkey('c6-real-media-0002', '"1"') }],
    ['POST /admin/sources', 'POST', `${API}/admin/sources`, { payload: { name: 'real 建源' }, headers: wkey('c6-real-admin-0001') }],
  ];
  for (const [label, method, url, options] of realWriteFaces) {
    const result = await call(realApp, method, url, adminStub.token && label.includes('admin') ? adminStub : a, options);
    assert.equal(result.status, 503, `${label}：real 写面必须 503，实际 ${result.status}：${result.text}`);
    assert.equal(result.body.error.code, 'PROVIDER_UNAVAILABLE');
    note(`C6 real 写面 ${label} → 503（无写入口 ⇒ 反向不产生真实 id）`);
  }

  // ---- 模式标注：同一批请求在两种模式下 `meta.execution_mode` 不同（客户端可解释） ----
  const stubSession = await call(stubWorld.app, 'GET', `${API}/auth/session`, a);
  assert.equal(stubSession.body.meta.execution_mode, 'stub');
  const realSession = await call(realApp, 'GET', `${API}/auth/session`, a);
  assert.equal(realSession.status, 200, `会话本身不按模式切分（是同一 auth store 的会话）：${realSession.text}`);
  assert.equal(realSession.body.meta.execution_mode, 'real');
  note('C6 模式标注：同一 token 的 /auth/session 在 stub/real 都 200，但 meta.execution_mode 分别为 stub/real（数据面由域门拒绝）');

  // ---- 知识/资料域不是「模式豁免」：它依赖资料库，未配置即 503（stub 与 real 同形） ----
  // 这条纠正一个常见误设：知识域**不是**打包静态资料，real 下不会因为「反正是公共资料」而放行。
  const stubKnowledge = await call(stubWorld.app, 'GET', `${API}/knowledge`, a);
  const realKnowledge = await call(realApp, 'GET', `${API}/knowledge`, a);
  assert.equal(stubKnowledge.status, 503, `stub 下资料库未配置也应 503：${stubKnowledge.text}`);
  assert.equal(realKnowledge.status, 503, `real 下资料库未配置也应 503：${realKnowledge.text}`);
  assert.equal(realKnowledge.body.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(realKnowledge.body.error.retryable, false);
  assertNoLeak(realKnowledge, [seeded.postId, CLEAN_TITLE, a.user.id], 'C6 knowledge');
  note('C6 知识/资料域：stub 与 real 均为 503 PROVIDER_UNAVAILABLE（资料库未配置；不是「公共资料就放行」）');
});
