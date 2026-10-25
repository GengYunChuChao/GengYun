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
import { createMemoryAdminJobPort } from '../../services/api/src/admin/ops/jobs.ts';
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
/**
 * 转写种子专用媒体引用（固定 uuid，替身 ASR 的**可复现分桶**输入）。
 *
 * 为什么不是 `uploadReadyMedia` 的媒体：替身 ASR 按 `bucketOf(mediaId, 6)` 选脚本
 * （`services/api/src/speech/provider.ts:67`：sha256(mediaId) 首字节 % 6），只有 bucket 0/1
 * 产出可用文本、才落转写记录；上传得到的 mediaId 是随机 uuid，桶位不可控。
 * 这个 uuid 的桶位实测 = 0（正常转写 + 2 个不确定区间）。替身媒体端口不校验归属
 * （`services/api/src/speech/media.ts:48-59`，仅 stub/preset_demo 接线），所以播种只需合法 uuid。
 */
export const SPEECH_MEDIA_ID = '00000000-0000-4000-8a00-000000000001';
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
    // 后台注入点（`app.ts:392-395`）：缺省不传 ⇒ 与改动前逐字相同（作业端口未接线 ⇒ 503）。
    // S-6 的过滤腿要一个**已接线**作业端口，用 `createJobFilterWorld` 单独建第二个 app，
    // ⛔ 不给默认世界接线：`C3-20` 的 503 必须继续成立。
    ...(options.adminInjection === undefined ? {} : { adminInjection: options.adminInjection }),
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

/**
 * 发一条 loopback **真实 HTTP** 请求并归一化成与 `inject` 完全同形的读数。
 * `origin` 是 `app.listen({ host: '127.0.0.1', port: 0 })` 返回的 base URL。
 *
 * 与 `inject` 的差别只在传输层：这里真的走 TCP（覆盖真实 body 大小上限、真实网络超时
 * 与连接生命周期），其余字段逐字段对齐，`run.mjs` 的 `judge` 才能两臂共用同一套判定。
 */
export async function loopbackInject(origin, { method, path, actor = null, body, headers = {} }) {
  const merged = {
    ...(actor && actor.token ? { authorization: `Bearer ${actor.token}` } : {}),
    ...headers,
  };
  const hasBody = body !== undefined;
  if (hasBody) merged['content-type'] = merged['content-type'] ?? 'application/json';
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: merged,
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  // `inject` 的 `response.headers` 是普通对象、缺头时读数为 `undefined`；这里用 `?? undefined`
  // 把 fetch 的 `null` 缺头归一化掉，保证 `judge` 里 `exp.etag === false` 等判定两臂一致。
  const header = (name) => response.headers.get(name) ?? undefined;
  const rawHeaders = {};
  for (const [key, value] of response.headers.entries()) rawHeaders[key] = value;
  return {
    status: response.status,
    body: parsed,
    text,
    bytes: Buffer.byteLength(text),
    headers: rawHeaders,
    etag: header('etag'),
    cache: header('cache-control'),
    mode: header('x-execution-mode'),
    contentType: header('content-type'),
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

// ---------------------------------------------------------------------------
// S-6 · 作业过滤的拒绝/降级语义（`/admin/jobs?state=…&error_code=…`）
//
// 为什么需要**第二个 app**：服务层的顺序是「鉴权(401/403) → 端口接线(503) → 入参闭集(400)」
// （`services/api/src/admin/ops/service.ts:718-724`），默认世界的作业端口未接线 ⇒ 一律 503，
// **永远到不了 400**。而 `C3-20` 必须继续证明「未接线 ⇒ 503」，所以不能把默认世界接线。
// 这里另建一个共享同一 auth store 的 app（`adminInjection.jobPort` 注入内存参考实现），
// 只给 S-6 的用例使用；令牌因此两臂通用，`C3-20` 的读数一字不动。
// ---------------------------------------------------------------------------

/** 种子的目标引用 id（`TargetRef.id` 只要求 1..80 字符串，不必是真资源）。 */
const JOB_SEED_TARGET_ID = '00000000-0000-4000-8d00-0000000000b1';

/**
 * 一条契约合法的 `AdminJob`（`services/api/src/admin/ops/fields.ts:101-118` 的字段闭集：
 * `additionalProperties:false` + 9 个必填位，`result` 恒 `null`）。
 * `created_at` 随序号递增 ⇒ 读取顺序确定（端口按 `created_at` 降序、再按 `id` 降序）。
 */
function seedJob(ordinal, state, errorCode) {
  return Object.freeze({
    id: `00000000-0000-4000-8d00-00000000000${ordinal}`,
    revision: 1,
    kind: 'recognition',
    target_ref: { type: 'recognition', id: JOB_SEED_TARGET_ID, revision: 1 },
    state,
    deadline_at: new Date(START + 3600_000).toISOString(),
    created_at: new Date(START + ordinal * 1000).toISOString(),
    error_code: errorCode,
    result: null,
  });
}

/**
 * 6 条作业、5 个状态：
 * - `queued` 正好 2 条（够撑出 `limit=1` 的第二页 ⇒ 真游标，而不是硬编码串）；
 * - `timed_out` **一条都没有** ⇒ 合法但无匹配的降级腿（200 空页，⛔ 不是 503）；
 * - 只有 1 条带 `error_code`（`PROVIDER_TIMEOUT`，503 段闭集成员）⇒ `error_code` 过滤的正控制。
 */
export const ADMIN_JOB_SEED = Object.freeze([
  seedJob(1, 'queued', null),
  seedJob(2, 'queued', null),
  seedJob(3, 'running', null),
  seedJob(4, 'succeeded', null),
  seedJob(5, 'failed', 'PROVIDER_TIMEOUT'),
  seedJob(6, 'cancelled', null),
]);

/**
 * 建 S-6 专用 app：与 `base` **共享 auth store 与时钟**，作业端口换成内存参考实现
 * （`createMemoryAdminJobPort(ADMIN_JOB_SEED)`，`wired: true`）。
 * 其余 store 各自独立（本组用例只读 `/admin/jobs`，不依赖默认世界的业务行）。
 */
export function createJobFilterWorld(base, options = {}) {
  const seed = options.seed ?? ADMIN_JOB_SEED;
  const jobPort = createMemoryAdminJobPort(seed);
  const world = createWorld({ store: base.auth, clock: base.clock, adminInjection: { jobPort } });
  return { ...world, jobPort, jobSeed: seed };
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

  // ── 异步 AI 域的属主行（C11 归属面要证明「他人资源确实存在」，不能拿不存在的东西当越权证据）──
  // 识别 / OCR 用属主自己的就绪媒体；转写用 SPEECH_MEDIA_ID（替身 ASR 的可复现桶位，见常量注释）。
  const recognitionJob = await inject(world.app, {
    method: 'POST',
    path: `${API}/recognitions`,
    actor: owner,
    body: { media_id: media.mediaId, media_revision: media.revision },
    headers: { 'idempotency-key': 'i22-seed-recognition' },
  });
  if (recognitionJob.status !== 202) throw new Error(`播种识别作业失败 ${recognitionJob.status}：${recognitionJob.text}`);

  const ocrJob = await inject(world.app, {
    method: 'POST',
    path: `${API}/ocr`,
    actor: owner,
    body: { media_id: media.mediaId, media_revision: media.revision },
    headers: { 'idempotency-key': 'i22-seed-ocr' },
  });
  if (ocrJob.status !== 202) throw new Error(`播种 OCR 作业失败 ${ocrJob.status}：${ocrJob.text}`);

  const transcriptionJob = await inject(world.app, {
    method: 'POST',
    path: `${API}/speech/transcriptions`,
    actor: owner,
    body: { media_id: SPEECH_MEDIA_ID, media_revision: 1 },
    headers: { 'idempotency-key': 'i22-seed-transcription' },
  });
  if (transcriptionJob.status !== 202) throw new Error(`播种转写作业失败 ${transcriptionJob.status}：${transcriptionJob.text}`);

  // 替身提供者是异步的：不 settle 就只有作业行、没有识别 / OCR / 转写记录可读。
  for (const service of [world.app.recognitionService, world.app.ocrService, world.app.speechService]) {
    if (typeof service?.settle === 'function') await service.settle();
  }

  const jobId = recognitionJob.body.data.id;
  const recognitionId = recognitionJob.body.data.target_ref.id;
  const ocrId = ocrJob.body.data.target_ref.id;
  const transcriptionId = transcriptionJob.body.data.target_ref.id;

  const conversation = await inject(world.app, {
    method: 'POST',
    path: `${API}/conversations`,
    actor: owner,
    body: {},
    headers: { 'idempotency-key': 'i22-seed-conversation' },
  });
  if (conversation.status !== 201) throw new Error(`播种会话失败 ${conversation.status}：${conversation.text}`);
  const conversationId = conversation.body.data.id;
  const conversationRead = await inject(world.app, { method: 'GET', path: `${API}/conversations/${conversationId}`, actor: owner });
  const conversationEtag = conversationRead.etag ?? `"${conversation.body.data.revision}"`;
  const turn = await inject(world.app, {
    method: 'POST',
    path: `${API}/conversations/${conversationId}/turns`,
    actor: owner,
    body: { input_type: 'text', text: '属主 B 的合成提问：稻田稗草三到五叶期该用什么药？' },
    headers: { 'idempotency-key': 'i22-seed-turn', 'if-match': conversationEtag },
  });
  if (turn.status !== 202) throw new Error(`播种会话轮次失败 ${turn.status}：${turn.text}`);

  return {
    media,
    favoriteId: favorite.body.data.id,
    historyId: history.history.id,
    messageId: message.message.id,
    postId,
    commentId: comment.body.data.id,
    reportId: report.body.data.id,
    jobId,
    recognitionId,
    ocrId,
    transcriptionId,
    conversationId,
    conversationEtag,
    turnId: turn.body.data.id,
  };
}
