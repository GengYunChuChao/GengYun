/**
 * GY-I22（#22）失败回归矩阵 · 世界装配（夹具层）。
 *
 * 为什么用 `app.inject` 而不是 loopback HTTP：
 * - 每条用例都要**可重复、零外呼、零端口**。`inject` 直接进 Fastify 的请求生命周期
 *   （`onRequest` 钩子 → schema 校验 → `preHandler` 守卫 → 处理器 → `onSend` 钩子），
 *   与 loopback 的差别只在 TCP 编解码；本轮没有一条用例要验证传输层。
 * - loopback 需要选端口、处理并发端口占用、还要在 CI 的 18 项里额外开 socket；
 *   `inject` 一条命令跑完，失败可复现到行。
 * - 代价（如实写进证据页）：不覆盖反向代理、真实 TLS、真实 body 大小限制与真实网络超时。
 *
 * 全部身份/正文/媒体字节都是**合成夹具**：内存 auth store + 内存业务 store + 替身对象存储 +
 * 合成审核端口（四个网络 seam 持有即抛错），**零真实供应商调用**。
 */
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
import { CLEAN_BODY, CLEAN_TITLE, makeGate, makeSyntheticPassPort } from '../unit/community-fixtures.mjs';
import { frozenModerationInjection } from '../unit/stall-hygiene-fixtures.mjs';
import { makeControllableVisibility } from '../unit/favorites-history-fixtures.mjs';

export const API = '/api/v1';
export const START = Date.UTC(2026, 9, 25, 4, 0, 0);
/** 契约格式但**不存在**的 uuid：所有「同形」对照都以它为准。 */
export const ABSENT = '00000000-0000-4000-8000-000000000000';
export const SPECIES_ID = '00000000-0000-4000-8c00-000000000001';
export { CLEAN_BODY, CLEAN_TITLE };

export function scriptedClock(startMs = START) {
  let nowMs = startMs;
  return {
    now: () => new Date(nowMs),
    get ms() {
      return nowMs;
    },
  };
}

/** 一个 stub 装配（全套内存 store + 替身对象存储 + 合成审核端口）。 */
export function createWorld(options = {}) {
  const clock = options.clock ?? scriptedClock();
  const auth = options.store ?? createMemoryAuthStore();
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
    store: auth,
    now: clock.now,
    mediaObjectStore: objectStore,
    favoritesInjection: { store: favorites, visibility: visibility.port },
    historyInjection: { store: history, visibility: visibility.port },
    messagesInjection: { store: messages },
    communityInjection: { store: community, gate: makeGate() },
    moderationInjection: frozenModerationInjection({
      executionMode: config.executionMode,
      ports: { tms: makeSyntheticPassPort('tms') },
      store: community,
    }),
  });
  return { app, auth, clock, favorites, history, messages, community, objectStore, visibility, config };
}

/** 直接播种一个用户会话（不经过微信换取 ⇒ 零外呼）。 */
export async function createAccount(world, label, options = {}) {
  const user = await world.auth.createUser(`${label}-i22-${'0'.repeat(48)}`.slice(0, 64));
  const token = mintOpaqueToken();
  const session = await world.auth.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: options.authEpoch ?? user.authEpoch,
    expiresAt: new Date(options.expiresAt ?? START + 48 * 3600_000),
    audience: 'user',
  });
  return { kind: 'user', user, userId: user.id, token, session };
}

/** 直接播种一个后台会话（含 scope 列表）。 */
export async function createAdmin(world, scopes, label = 'admin') {
  const userId = await world.auth.createAdmin({
    loginName: `i22-${label}-${Math.random().toString(36).slice(2, 8)}`,
    credentialHash: 'synthetic-not-a-real-credential-hash',
    scopes,
  });
  const token = mintOpaqueToken();
  const session = await world.auth.createSession({
    userId,
    tokenHashHex: hashToken(token),
    authEpoch: 1,
    expiresAt: new Date(START + 3600_000),
    audience: 'admin',
  });
  return { kind: 'admin', userId, token, session, scopes };
}

/** 发一条请求并归一化成「读数」。 */
export async function inject(app, { method, path, actor = null, body, headers = {} }) {
  const merged = {
    ...(actor && actor.token ? { authorization: `Bearer ${actor.token}` } : {}),
    ...headers,
  };
  const response = await app.inject({
    method,
    url: path,
    headers: merged,
    ...(body === undefined ? {} : { payload: body }),
  });
  let parsed = null;
  try {
    parsed = response.json();
  } catch {
    parsed = null;
  }
  return {
    status: response.statusCode,
    body: parsed,
    text: response.body,
    bytes: response.rawPayload?.length ?? null,
    headers: response.headers,
    etag: response.headers.etag,
    cache: response.headers['cache-control'],
    mode: response.headers['x-execution-mode'],
    contentType: response.headers['content-type'],
  };
}

/** 错误封套指纹：去掉 `request_id`／`message` 后的形状（逐字节可比）。 */
export function envelopeShape(result) {
  const error = { ...(result.body?.error ?? {}) };
  if (typeof error.message === 'string') error.message = '<message>';
  return JSON.stringify({
    status: result.status,
    error,
    contract: result.body?.meta?.contract_version,
    mode: result.body?.meta?.execution_mode,
  });
}

/** 值路径读取（`body.data.id` 之类）。 */
export function getPath(value, path) {
  let cursor = value;
  for (const key of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/** 建一条 ready 的媒体（走真实上传两段式；替身对象存储里放合成 PNG）。 */
export async function uploadReadyMedia(world, actor, key, options = {}) {
  const bytes = options.bytes ?? pngPlain();
  const mime = options.mime ?? 'image/png';
  const purpose = options.purpose ?? 'community_image';
  const created = await inject(world.app, {
    method: 'POST',
    path: `${API}/media/uploads`,
    actor,
    body: { purpose, mime, bytes: bytes.length, sha256: sha256Hex(bytes) },
    headers: { 'idempotency-key': `${key}-create` },
  });
  if (created.status !== 201) throw new Error(`建上传失败 ${created.status}：${created.text}`);
  const mediaId = created.body.data.media.id;
  // [R28-W12 合流订正] 媒体端口的 `serverObjectKeys` 自 W12 起改为查持久化台账 ⇒ 返回 Promise；
  // 本文件在 main 上按同步签名调用，会拿到 Promise 再取 `.rawRef` ⇒ undefined ⇒ 往桶里写 null 键。
  const keys = await world.app.mediaService.serverObjectKeys(mediaId);
  if (keys === null) throw new Error('服务端未给出对象键');
  await world.objectStore.putObject(keys.rawRef, bytes, 'application/octet-stream');
  const completed = await inject(world.app, {
    method: 'POST',
    path: `${API}/media/uploads/${mediaId}/complete`,
    actor,
    body: { sha256: sha256Hex(bytes), bytes: bytes.length },
    headers: { 'idempotency-key': `${key}-complete`, 'if-match': '"1"' },
  });
  if (completed.status !== 202) throw new Error(`完成上传失败 ${completed.status}：${completed.text}`);
  return {
    mediaId,
    revision: completed.body.data.revision,
    upload: created.body.data.upload,
    rawKey: keys.rawRef,
    derivativeKey: keys.derivativeRef,
    bytes,
  };
}

/** 播种「另一个用户」的全部私有行（media/message/post/comment/favorite/history/report）。 */
export async function seedOwnerRows(world, owner) {
  const media = await uploadReadyMedia(world, owner, 'i22-seed-owner');

  const favorite = await inject(world.app, {
    method: 'POST',
    path: `${API}/favorites`,
    actor: owner,
    body: { target_ref: { type: 'species', id: SPECIES_ID, revision: 1 } },
    headers: { 'idempotency-key': 'i22-seed-fav' },
  });
  if (favorite.status !== 201) throw new Error(`播种收藏失败 ${favorite.status}：${favorite.text}`);

  const history = await world.app.historyService.appendHistory({
    owner_id: owner.userId,
    kind: 'recognition',
    target_ref: { type: 'recognition', id: '00000000-0000-4000-8a00-0000000000b1', revision: 1 },
    job_id: '00000000-0000-4000-8b00-0000000000b1',
    job_state: 'succeeded',
    event_key: 'i22-seed-hist',
  });
  const message = await world.app.messagesService.appendMessage({
    owner_id: owner.userId,
    type: 'comment',
    target_ref: null,
    event_key: 'i22-seed-msg',
  });

  const post = await inject(world.app, {
    method: 'POST',
    path: `${API}/posts`,
    actor: owner,
    body: { title: CLEAN_TITLE, body: CLEAN_BODY, media_ids: [] },
    headers: { 'idempotency-key': 'i22-seed-post' },
  });
  if (post.status !== 201) throw new Error(`播种帖子失败 ${post.status}：${post.text}`);
  const postId = post.body.data.id;

  const comment = await inject(world.app, {
    method: 'POST',
    path: `${API}/posts/${postId}/comments`,
    actor: owner,
    body: { body: '这是属主 B 的评论正文，不得出现在他人响应里。' },
    headers: { 'idempotency-key': 'i22-seed-comment', 'if-match': '"1"' },
  });
  if (comment.status !== 201) throw new Error(`播种评论失败 ${comment.status}：${comment.text}`);

  const report = await inject(world.app, {
    method: 'POST',
    path: `${API}/reports`,
    actor: owner,
    body: { target_ref: { type: 'post', id: postId, revision: 1 }, reason_code: 'other', detail: '属主 B 的举报细节' },
    headers: { 'idempotency-key': 'i22-seed-report' },
  });
  if (report.status !== 201) throw new Error(`播种举报失败 ${report.status}：${report.text}`);

  return {
    media,
    favoriteId: favorite.body.data.id,
    historyId: history.history.id,
    messageId: message.message.id,
    postId,
    commentId: comment.body.data.id,
    reportId: report.body.data.id,
  };
}
