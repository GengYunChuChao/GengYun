/**
 * GY-I22（#22）· C3 覆盖缺口收口：`x-role` / `x-user-id` 请求头**不得**改变生效身份。
 *
 * 起因（必须如实写在代码里，否则下一个人会以为这组用例多余）：
 * `#297` 安全矩阵的审查者造了 7 组 mutant，其中 **M4 存活**——在**已认证会话**上同时给
 * `x-role: admin` 与 `x-user-id: <他人 id>` 时，矩阵里没有一条用例锁住「请求头不得提升/改变身份」。
 * 为什么已有矩阵锁不住它：`tests/unit/gy-i22-secmatrix.test.mjs` 的 C3 只把伪造头打在
 * **后台面**（`/admin/sources`），而用户令牌打后台面的 403 `SCOPE_DENIED` 在
 * `authenticateAdmin` 里就抛了（`services/api/src/auth/middleware.ts:110-120`，`loadLiveSession`
 * 的 `audience:'admin'` 查不到 → 复用该令牌按 `audience:'user'` 查得到 ⇒ SCOPE_DENIED），
 * **`applyIdentity` 根本没被调用**。于是把「身份覆盖」注入 `applyIdentity`/`readIdentity`
 * 的 mutant 在旧矩阵下全绿存活——它不是「后台面被采信」，而是「用户面身份被替换」。
 *
 * 本文件的用例只做一件事：在**用户面**（认证已通过、`applyIdentity` 已执行之后）比
 * 「带身份头」与「不带头」的响应，断言两者**逐字节同形**（`request_id` 除外），
 * 并用**数据归属**（自己的行在、他人的行不在、他人资源 404）证明生效身份仍是会话身份。
 *
 * 为什么另起一个文件而不是扩进 `gy-i22-secmatrix.test.mjs`（理由同时抄在证据页）：
 * 1. 既有矩阵的证据页 `docs/verification/gy-i22-secmatrix-20261019.md` 逐行索引 146 条
 *    `[I22]` 打印行，并公开声明「tests 6 / 146 条」；扩进那个文件会让那份证据页的读数失真，
 *    而本片没有重写它的授权。
 * 2. 矩阵文件已 1076 行、类目编号 C1–C6 与证据页 §2–§7 一一对应；新增第七类会迫使那份
 *    证据页重排编号，收益不抵风险。
 * 3. 本文件独立可跑（聚焦跑即 `node --test "tests/unit/gy-i22-identity-headers.test.mjs"`），
 *    M4 的红/绿定位到本文件一行用例，且不与矩阵的夹具共享可变状态。
 *
 * 声明（不得误读）：
 * - 全部身份、令牌、目标引用均为**合成夹具**；`executionMode=stub` + 内存 store，
 *   **零真实外呼**（不连 PG／微信／对象存储）。
 * - 本文件只证明「在这些固定输入下，服务端对带头与不带头给出同一组固定输出」，
 *   **不宣称系统安全**。
 * - `/me/profile` 在本装配下没有 PG（`pool=null`），正向读为 503 `PROVIDER_UNAVAILABLE`；
 *   因此「读自己的资料」以收藏／历史／消息的**归属行**为身份回显面，`/me/profile` 只作为
 *   「头部不能把未接线域变成 200，也不能把 503 变 403」的对照行（证据页记未取得）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import { createMemoryCommunityStore } from '../../services/api/src/community/store.ts';
import { makeGate, makeSyntheticPassPort } from './community-fixtures.mjs';
import { makeControllableVisibility, scriptedClock } from './favorites-history-fixtures.mjs';
import { frozenModerationInjection } from './stall-hygiene-fixtures.mjs';

const API = '/api/v1';
const START = Date.UTC(2026, 9, 19, 4, 0, 0);
/** 契约格式但**不存在**的 uuid：404 同形断言的对照。 */
const ABSENT = '00000000-0000-4000-8000-000000000000';
/** 两个都在可见集合里的物种引用：让 A / B 的收藏行在**内容上**也能区分。 */
const SPECIES_A = '00000000-0000-4000-8c00-0000000000a1';
const SPECIES_B = '00000000-0000-4000-8c00-0000000000b1';

/** 行读数：打印到 stdout，证据页逐条抄录。前缀与矩阵的 `[I22]` 区分开，便于各自计数。 */
function note(line) {
  console.log(`[I22-M4] ${line}`);
}

// ---------------------------------------------------------------------------
// 夹具（与矩阵同口径的最小副本：只注入身份相关域，不碰媒体/审核）
// ---------------------------------------------------------------------------

function makeWorld(t) {
  const clock = scriptedClock(START);
  const auth = createMemoryAuthStore();
  const favorites = createMemoryFavoritesStore({ now: () => clock.ms });
  const history = createMemoryHistoryStore({ now: () => clock.ms });
  const messages = createMemoryMessagesStore({ now: () => clock.ms });
  const community = createMemoryCommunityStore({ now: () => clock.ms });
  const visibility = makeControllableVisibility([`species:${SPECIES_A}`, `species:${SPECIES_B}`]);
  const config = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
  const app = buildApp({
    config,
    store: auth,
    now: clock.now,
    favoritesInjection: { store: favorites, visibility: visibility.port },
    historyInjection: { store: history, visibility: visibility.port },
    messagesInjection: { store: messages },
    // 社区域只用于「角色面」：`routes/community.ts:160-164` 的 `actorOf` 对
    // `identity.role !== 'user'` 一律 403 —— 若身份头被采信成 admin，读列表会从 200 变 403。
    communityInjection: { store: community, gate: makeGate() },
    // 与矩阵 `makeWorld` 逐字段同口径（`stall-hygiene-fixtures`）：规则层时钟冻结，避免
    // 50ms 预算在机器抖动下误判 `RULE_TIMEOUT` 而影响「身份头不改变结果」的对照。
    moderationInjection: frozenModerationInjection({
      executionMode: config.executionMode,
      ports: { tms: makeSyntheticPassPort('tms') },
      store: community,
    }),
  });
  t.after(() => app.close());
  return { app, auth, clock, favorites, history, messages, community, visibility, config };
}

/** 播种一个用户会话（不经过微信换取，零外呼）。 */
async function account(world, label) {
  const user = await world.auth.createUser(`${label}-m4-${'0'.repeat(48)}`.slice(0, 64));
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

/** 播种一个后台账号会话（scopes 逐条给定）。 */
async function adminAccount(world, scopes) {
  const userId = await world.auth.createAdmin({
    loginName: `m4-admin-${scopes.length}-${Math.random().toString(36).slice(2, 8)}`,
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
    cache: response.headers['cache-control'],
  };
}

/** 错误封套指纹：去掉 `request_id` 后逐字节可比（与矩阵 `fingerprint` 同口径）。 */
function fingerprint(result) {
  return JSON.stringify({
    status: result.status,
    error: result.body?.error,
    contract: result.body?.meta?.contract_version,
    mode: result.body?.meta?.execution_mode,
  });
}

/**
 * 响应体稳定化：只抹掉每次请求都会变的 `request_id`（Fastify 请求 id）。
 * 抹掉后**其余逐字节必须相同**——这是本文件「头部零影响」的主断言：
 * 不只状态码/错误码相同，连分页游标、字段顺序、时间戳都必须一致。
 */
function stable(result) {
  return result.text.replace(/"request_id"\s*:\s*"[^"]*"/g, '"request_id":"<request-id>"');
}

function assertRejection(result, { status, code }) {
  assert.equal(result.status, status, `状态码应为 ${status}，实际 ${result.status}：${result.text}`);
  assert.equal(result.body?.error?.code, code, `错误码应为 ${code}，实际 ${result.body?.error?.code}：${result.text}`);
  assert.equal(result.body.data, undefined, '错误响应不得携带成功封套');
  assert.equal(result.body.meta.contract_version, '1.0.0');
  assert.equal(typeof result.body.error.retryable, 'boolean');
  assert.ok(Array.isArray(result.body.error.details), 'details 必须是数组');
  assert.ok(
    result.cache === undefined || result.cache === 'no-store',
    `拒绝响应不得带可缓存指令：${String(result.cache)}`,
  );
}

function assertNoLeak(result, secrets, label) {
  for (const secret of secrets) {
    assert.equal(result.text.includes(secret), false, `${label}：响应体泄露了 ${secret}：${result.text}`);
  }
}

function wkey(key, version) {
  return { 'idempotency-key': key, ...(version === undefined ? {} : { 'if-match': version }) };
}

/** 播种 A / B 各自的收藏、历史、消息（数量刻意不同：A 两条消息、B 一条）。 */
async function seedBoth(world, a, b) {
  const aFavorite = await call(world.app, 'POST', `${API}/favorites`, a, {
    payload: { target_ref: { type: 'species', id: SPECIES_A, revision: 1 } },
    headers: wkey('m4-fav-a-0001'),
  });
  assert.equal(aFavorite.status, 201, `A 的收藏播种失败：${aFavorite.text}`);
  const bFavorite = await call(world.app, 'POST', `${API}/favorites`, b, {
    payload: { target_ref: { type: 'species', id: SPECIES_B, revision: 1 } },
    headers: wkey('m4-fav-b-0001'),
  });
  assert.equal(bFavorite.status, 201, `B 的收藏播种失败：${bFavorite.text}`);

  const aHistory = await world.app.historyService.appendHistory({
    owner_id: a.user.id,
    kind: 'recognition',
    target_ref: { type: 'recognition', id: '00000000-0000-4000-8a00-0000000000a1', revision: 1 },
    job_id: '00000000-0000-4000-8b00-0000000000a1',
    job_state: 'succeeded',
    event_key: 'm4-hist-a',
  });
  const bHistory = await world.app.historyService.appendHistory({
    owner_id: b.user.id,
    kind: 'recognition',
    target_ref: { type: 'recognition', id: '00000000-0000-4000-8a00-0000000000b1', revision: 1 },
    job_id: '00000000-0000-4000-8b00-0000000000b1',
    job_state: 'succeeded',
    event_key: 'm4-hist-b',
  });

  const messagesA = [];
  for (const key of ['m4-msg-a1', 'm4-msg-a2']) {
    const appended = await world.app.messagesService.appendMessage({
      owner_id: a.user.id,
      type: 'comment',
      target_ref: null,
      event_key: key,
    });
    messagesA.push(appended.message.id);
  }
  const bAppended = await world.app.messagesService.appendMessage({
    owner_id: b.user.id,
    type: 'comment',
    target_ref: null,
    event_key: 'm4-msg-b1',
  });

  return {
    favoriteA: aFavorite.body.data.id,
    favoriteB: bFavorite.body.data.id,
    historyA: aHistory.history.id,
    historyB: bHistory.history.id,
    messagesA,
    messageB: bAppended.message.id,
  };
}

// ===========================================================================
// 1 已认证用户会话 + x-role / x-user-id：生效身份仍是会话身份
// ===========================================================================

test('M4 已认证用户 + x-role:admin / x-user-id:他人 ⇒ 生效身份仍是会话身份（读自己/读他人/后台三面）', async (t) => {
  const world = makeWorld(t);
  const a = await account(world, 'm4-a');
  const b = await account(world, 'm4-b');
  const seeded = await seedBoth(world, a, b);
  const forged = { 'x-role': 'admin', 'x-user-id': b.user.id };
  const secretsB = [b.user.id, seeded.favoriteB, seeded.historyB, seeded.messageB, SPECIES_B];

  // ---- 1.1 读面：A 带双头读「自己的」列表，必须仍是 A 的行（正控制 + 零差异） ----
  const readFaces = [
    ['GET /favorites', `${API}/favorites`, (body) => body.data.items.map((row) => row.id)],
    ['GET /history', `${API}/history`, (body) => body.data.items.map((row) => row.id)],
    ['GET /messages', `${API}/messages`, (body) => body.data.items.map((row) => row.id)],
    ['GET /messages/unread-count', `${API}/messages/unread-count`, (body) => [String(body.data.count)]],
    ['GET /auth/session', `${API}/auth/session`, () => []],
    ['GET /posts', `${API}/posts`, (body) => (body.data.items ?? []).map((row) => row.id)],
  ];

  for (const [label, url, idOf] of readFaces) {
    const baseline = await call(world.app, 'GET', url, a);
    const withHeaders = await call(world.app, 'GET', url, a, { headers: forged });
    assert.equal(baseline.status, 200, `${label} 基准读必须 200（否则下面的同形断言是空断言）：${baseline.text}`);
    assert.equal(withHeaders.status, baseline.status, `${label} 带身份头后状态变了：${withHeaders.text}`);
    assert.equal(stable(withHeaders), stable(baseline), `${label} 带身份头后响应体与基准不同 ⇒ 头部被采信`);
    note(`1.1 ${label}：基准 ${baseline.status} ↔ 带头 ${withHeaders.status}，响应体逐字节同形`);
    // A 自己的行必须在（证明「读自己拿到自己」，不是一片空白）；
    // B 的 id 一个都不许出现（证明「没有变成 B」）。
    assert.equal(withHeaders.text.includes(b.user.id), false, `${label}：响应体出现 B 的账号 id`);
    assertNoLeak(withHeaders, secretsB, label);
    const ids = idOf(withHeaders.body);
    if (label === 'GET /favorites') {
      assert.deepEqual(ids, [seeded.favoriteA], `${label}：必须只回 A 的那条收藏`);
    }
    if (label === 'GET /history') {
      assert.deepEqual(ids, [seeded.historyA], `${label}：必须只回 A 的那条历史`);
    }
    if (label === 'GET /messages') {
      assert.equal(ids.length, 2, `${label}：A 应有 2 条消息，实际 ${ids.length}`);
      for (const id of seeded.messagesA) assert.equal(ids.includes(id), true, `${label}：缺 A 自己的消息 ${id}`);
      assert.equal(ids.includes(seeded.messageB), false, `${label}：混入 B 的消息`);
    }
    if (label === 'GET /auth/session') {
      // `currentIdentity` 的 role/scopes 决定这一行：用户会话恒为 ['user']。
      assert.deepEqual(withHeaders.body.data.scopes, ['user'], 'x-role:admin 头不得把用户会话的 scopes 变成后台 scope');
      assert.equal(withHeaders.body.data.audience, 'user', 'x-role:admin 头不得改变 audience');
    }
  }

  // 派生量面：A 的未读数必须与基准相同，且夹具保证 A≠B（否则本条没有区分力）。
  const aUnread = await call(world.app, 'GET', `${API}/messages/unread-count`, a);
  const bUnread = await call(world.app, 'GET', `${API}/messages/unread-count`, b);
  assert.notEqual(
    aUnread.body.data.count,
    bUnread.body.data.count,
    '夹具要求 A/B 未读数不同，否则「带头仍等于基准」没有区分力',
  );
  note(`1.2 未读派生量：A=${aUnread.body.data.count}、B=${bUnread.body.data.count}（刻意不同）`);

  // ---- 1.3 读他人资源：必须 404，且与「不存在的 id」逐字节同形 ----
  const foreignReads = [
    [
      'DELETE /favorites/{B.id}',
      'DELETE',
      `${API}/favorites/${seeded.favoriteB}`,
      `${API}/favorites/${ABSENT}`,
      wkey('m4-fav-del-b-0001', '"1"'),
    ],
    [
      'DELETE /history/{B.id}',
      'DELETE',
      `${API}/history/${seeded.historyB}`,
      `${API}/history/${ABSENT}`,
      wkey('m4-hist-del-b-0001', '"1"'),
    ],
    [
      'PUT /messages/{B.id}/read',
      'PUT',
      `${API}/messages/${seeded.messageB}/read`,
      `${API}/messages/${ABSENT}/read`,
      wkey('m4-msg-read-b-0001', '"1"'),
    ],
  ];
  for (const [label, method, url, missingUrl, headers] of foreignReads) {
    const foreign = await call(world.app, method, url, a, { headers: { ...headers, ...forged } });
    const missing = await call(world.app, method, missingUrl, a, { headers: { ...headers, ...forged } });
    assertRejection(foreign, { status: 404, code: 'NOT_FOUND' });
    assert.equal(fingerprint(foreign), fingerprint(missing), `${label}：越权与「不存在」必须同形`);
    assertNoLeak(foreign, secretsB, label);
    note(`1.3 ${label} 带双头 → 404 NOT_FOUND（与不存在 id 同形；头部没有把 A 变成 B）`);
  }

  // 拒绝无副作用：B 的三行原样在。
  const bAfter = {
    favorites: await call(world.app, 'GET', `${API}/favorites`, b),
    history: await call(world.app, 'GET', `${API}/history`, b),
    messages: await call(world.app, 'GET', `${API}/messages`, b),
  };
  assert.equal(bAfter.favorites.body.data.items.length, 1, 'B 的收藏被带头的越权请求删掉了');
  assert.equal(bAfter.history.body.data.items.length, 1, 'B 的历史被带头的越权请求删掉了');
  assert.equal(bAfter.messages.body.data.items[0].read_at, null, 'B 的消息被带头的越权请求标成已读');
  note('1.4 事后态：B 的收藏/历史/消息全部原样（带头越权无副作用）');

  // ---- 1.5 写面：A 带双头写收藏，行必须落在 A 头上（不是 B） ----
  const written = await call(world.app, 'POST', `${API}/favorites`, a, {
    payload: { target_ref: { type: 'species', id: SPECIES_B, revision: 1 } },
    headers: { ...wkey('m4-fav-write-a-0001'), ...forged },
  });
  assert.equal(written.status, 201, `带双头写收藏应成功（身份仍是 A）：${written.text}`);
  const newFavoriteId = written.body.data.id;
  const aList = await call(world.app, 'GET', `${API}/favorites`, a, { headers: forged });
  const bList = await call(world.app, 'GET', `${API}/favorites`, b, { headers: forged });
  assert.equal(aList.body.data.items.some((row) => row.id === newFavoriteId), true, '写入行没有落在 A 的列表里');
  assert.equal(aList.body.data.items.length, 2, `A 应有 2 条收藏，实际 ${aList.body.data.items.length}`);
  assert.equal(bList.body.data.items.some((row) => row.id === newFavoriteId), false, '写入行落到了 B 的列表里 ⇒ x-user-id 被采信');
  assert.equal(bList.body.data.items.length, 1, `B 的收藏数被带头的写请求改动了：${bList.text}`);
  note('1.5 写面：A 带 x-user-id:B 写收藏 → 201，行落在 A（A=2 条、B 仍 1 条）');

  // ---- 1.6 后台面：用户会话 + 双头 → 403 SCOPE_DENIED（升权失败） ----
  const adminBaseline = await call(world.app, 'GET', `${API}/admin/sources`, a);
  const adminForged = await call(world.app, 'GET', `${API}/admin/sources`, a, { headers: forged });
  assertRejection(adminBaseline, { status: 403, code: 'SCOPE_DENIED' });
  assertRejection(adminForged, { status: 403, code: 'SCOPE_DENIED' });
  assert.equal(stable(adminForged), stable(adminBaseline), '双头改变了后台拒绝的形状');
  assertNoLeak(adminForged, [a.user.id], 'GET /admin/sources 带头');
  note('1.6 后台面：A + x-role:admin + x-user-id:B → 403 SCOPE_DENIED（与基准同形，未升权）');

  // ---- 1.7 未接线的画像域：头部不能把 503 变成 200/403 ----
  const profileBaseline = await call(world.app, 'GET', `${API}/me/profile`, a);
  const profileForged = await call(world.app, 'GET', `${API}/me/profile`, a, { headers: forged });
  assert.equal(profileForged.status, profileBaseline.status, `画像域状态被头部改变：${profileForged.text}`);
  assert.equal(stable(profileForged), stable(profileBaseline), '画像域响应体被头部改变');
  assert.equal(profileBaseline.status, 503, `stub 装配无 PG ⇒ 期望 503 PROVIDER_UNAVAILABLE，实际 ${profileBaseline.status}：${profileBaseline.text}`);
  assert.equal(profileBaseline.body.error.code, 'PROVIDER_UNAVAILABLE');
  assertNoLeak(profileForged, secretsB, 'GET /me/profile 带头');
  note('1.7 画像域 /me/profile：基准与带头均 503 PROVIDER_UNAVAILABLE（头部不能让未接线域变为可用）');
});

// ===========================================================================
// 2 未认证 + 双头：仍是 401 SESSION_REQUIRED（头部造不出会话）
// ===========================================================================

test('M4 未认证 + x-role:admin / x-user-id:他人 ⇒ 仍 401 SESSION_REQUIRED（头部造不出会话）', async (t) => {
  const world = makeWorld(t);
  const a = await account(world, 'm4-guest-a');
  const b = await account(world, 'm4-guest-b');
  const seeded = await seedBoth(world, a, b);
  const forged = { 'x-role': 'admin', 'x-user-id': b.user.id };
  const secretsB = [b.user.id, seeded.favoriteB, seeded.messageB];

  const guestFaces = [
    ['GET /favorites', 'GET', `${API}/favorites`],
    ['POST /favorites', 'POST', `${API}/favorites`, { payload: { target_ref: { type: 'species', id: SPECIES_A, revision: 1 } }, headers: wkey('m4-guest-fav-0001') }],
    ['DELETE /favorites/{B.id}', 'DELETE', `${API}/favorites/${seeded.favoriteB}`, { headers: wkey('m4-guest-fav-0002', '"1"') }],
    ['GET /history', 'GET', `${API}/history`],
    ['GET /messages', 'GET', `${API}/messages`],
    ['GET /messages/unread-count', 'GET', `${API}/messages/unread-count`],
    ['PUT /messages/{B.id}/read', 'PUT', `${API}/messages/${seeded.messageB}/read`, { headers: wkey('m4-guest-msg-0001', '"1"') }],
    ['GET /auth/session', 'GET', `${API}/auth/session`],
    ['POST /auth/logout', 'POST', `${API}/auth/logout`],
    ['GET /me/profile', 'GET', `${API}/me/profile`],
    ['GET /posts', 'GET', `${API}/posts`],
    ['GET /admin/sources', 'GET', `${API}/admin/sources`],
  ];

  for (const [label, method, url, options] of guestFaces) {
    const plain = await call(world.app, method, url, null, options ?? {});
    const withHeaders = await call(world.app, method, url, null, {
      ...(options ?? {}),
      headers: { ...(options?.headers ?? {}), ...forged },
    });
    assertRejection(plain, { status: 401, code: 'SESSION_REQUIRED' });
    assertRejection(withHeaders, { status: 401, code: 'SESSION_REQUIRED' });
    assert.equal(stable(withHeaders), stable(plain), `${label}：带头后封套形状变了 ⇒ 头部被采信`);
    assertNoLeak(withHeaders, secretsB, label);
    note(`2 ${label} 游客 + 双头 → 401 SESSION_REQUIRED（与不带头同形）`);
  }

  // 头部不能替代 Bearer：也不产生「B 的视图」。
  const guestRead = await call(world.app, 'GET', `${API}/favorites`, null, { headers: forged });
  assert.equal(guestRead.text.includes(seeded.favoriteB), false, '游客带 x-user-id 读到了 B 的收藏');
  note('2 汇总：12 个用户/后台面在游客 + 双头下一律 401，且不含 B 的任何 id');
});

// ===========================================================================
// 3 管理端 9 面逐面：请求头被忽略，仍 403 SCOPE_DENIED 且与基准同形
// ===========================================================================

test('M4 管理端 9 面逐面：请求头不参与判定，仍 403 SCOPE_DENIED 且与基准逐字节同形', async (t) => {
  const world = makeWorld(t);
  const a = await account(world, 'm4-admin-face-a');
  const b = await account(world, 'm4-admin-face-b');
  const scoped = await adminAccount(world, ['sources:read', 'audit:read']);
  const forged = { 'x-role': 'admin', 'x-user-id': b.user.id, 'x-scopes': 'sources:write', 'x-auth-scopes': 'sources:write audit:read' };

  const adminFaces = [
    ['GET /admin/sources', 'GET', `${API}/admin/sources`],
    ['POST /admin/sources', 'POST', `${API}/admin/sources`, { payload: { name: '越权建源' }, headers: wkey('m4-face-src-0001') }],
    ['GET /admin/knowledge', 'GET', `${API}/admin/knowledge`],
    ['GET /admin/registrations', 'GET', `${API}/admin/registrations`],
    ['GET /admin/restrictions', 'GET', `${API}/admin/restrictions`],
    ['GET /admin/audit-events', 'GET', `${API}/admin/audit-events`],
    ['GET /admin/accounts', 'GET', `${API}/admin/accounts`],
    ['GET /admin/categories', 'GET', `${API}/admin/categories`],
    ['GET /admin/jobs', 'GET', `${API}/admin/jobs`],
  ];

  // 先证「路由真的挂载了」：403 必须是守卫说的，不是 404 假装没有。
  for (const [label, method, url] of adminFaces) {
    assert.equal(world.app.hasRoute({ method, url }), true, `${label} 未挂载（那 403 就失去意义）`);
  }

  for (const [label, method, url, options] of adminFaces) {
    const plain = await call(world.app, method, url, a, options ?? {});
    const withHeaders = await call(world.app, method, url, a, {
      ...(options ?? {}),
      headers: { ...(options?.headers ?? {}), ...forged },
    });
    assertRejection(plain, { status: 403, code: 'SCOPE_DENIED' });
    assertRejection(withHeaders, { status: 403, code: 'SCOPE_DENIED' });
    assert.equal(stable(withHeaders), stable(plain), `${label}：带头与不带头不同形 ⇒ 头部被采信`);
    assertNoLeak(withHeaders, [a.user.id, b.user.id], label);
    note(`3 ${label} 用户令牌 + 4 个身份头 → 403 SCOPE_DENIED（与基准同形）`);
  }

  // 后台令牌 + 降级/冒名头：头部既不能升权，也不能降权或冒名。
  const downgrade = { 'x-role': 'user', 'x-user-id': a.user.id };
  const adminPlain = await call(world.app, 'GET', `${API}/admin/sources`, scoped);
  const adminDowngraded = await call(world.app, 'GET', `${API}/admin/sources`, scoped, { headers: downgrade });
  assert.equal(adminPlain.status, 200, `有 sources:read 的后台令牌必须可读（否则上面 9 条 403 是假象）：${adminPlain.text}`);
  assert.equal(adminDowngraded.status, 200, `x-role:user 头不得把后台会话降权：${adminDowngraded.text}`);
  assert.equal(stable(adminDowngraded), stable(adminPlain), '降级头改变了后台响应体');
  note(`3 后台令牌 + x-role:user / x-user-id:A → 200（头部不能降权，也不能冒名成 ${a.user.id.slice(0, 8)}…）`);

  // 后台令牌 + 冒名头打用户面：头部造不出「用户会话」（受众隔离仍然生效）。
  const adminOnUserFacePlain = await call(world.app, 'GET', `${API}/messages`, scoped);
  const adminOnUserFaceForged = await call(world.app, 'GET', `${API}/messages`, scoped, { headers: downgrade });
  assertRejection(adminOnUserFacePlain, { status: 401, code: 'SESSION_EXPIRED' });
  assertRejection(adminOnUserFaceForged, { status: 401, code: 'SESSION_EXPIRED' });
  assert.equal(stable(adminOnUserFaceForged), stable(adminOnUserFacePlain), '冒名头改变了受众隔离的响应');
  note('3 后台令牌 + x-role:user 打用户面 → 401 SESSION_EXPIRED（头部不能把后台会话变成用户会话）');
});

// ===========================================================================
// 4 M4 相邻组合：单头 / 大小写 / 空值 / 多值 / 自指 / scope 头
// ===========================================================================

test('M4 相邻组合：单头、大小写、空值、多值、自指、scope 头都不能改变生效身份', async (t) => {
  const world = makeWorld(t);
  const a = await account(world, 'm4-combo-a');
  const b = await account(world, 'm4-combo-b');
  const seeded = await seedBoth(world, a, b);

  const combos = [
    ['仅 x-role:admin', { 'x-role': 'admin' }],
    ['仅 x-user-id:B', { 'x-user-id': b.user.id }],
    ['大写 X-Role / X-User-Id', { 'X-Role': 'admin', 'X-User-Id': b.user.id }],
    ['值大小写 x-role:ADMIN', { 'x-role': 'ADMIN' }],
    ['自指 x-role:user + x-user-id:A', { 'x-role': 'user', 'x-user-id': a.user.id }],
    ['空值 x-user-id:""', { 'x-user-id': '' }],
    ['不存在的 uuid', { 'x-user-id': ABSENT, 'x-role': 'admin' }],
    ['多值注入 "B, A"', { 'x-role': 'admin', 'x-user-id': `${b.user.id}, ${a.user.id}` }],
    ['scope 头冒充后台能力', { 'x-role': 'admin', 'x-scopes': 'sources:write', 'x-auth-scopes': 'sources:write audit:read' }],
  ];

  // 基准：不带头。
  const baseFavorites = await call(world.app, 'GET', `${API}/favorites`, a);
  const baseAdmin = await call(world.app, 'GET', `${API}/admin/sources`, a);
  const baseForeign = await call(world.app, 'DELETE', `${API}/favorites/${seeded.favoriteB}`, a, {
    headers: wkey('m4-combo-del-b-0001', '"1"'),
  });
  assert.equal(baseFavorites.status, 200, baseFavorites.text);
  assertRejection(baseAdmin, { status: 403, code: 'SCOPE_DENIED' });
  assertRejection(baseForeign, { status: 404, code: 'NOT_FOUND' });

  // 反例控制：证明「逐字节同形」不是空断言——真换了会话（B）内容就不同。
  const bFavorites = await call(world.app, 'GET', `${API}/favorites`, b);
  assert.notEqual(stable(bFavorites), stable(baseFavorites), '反例控制失败：A 与 B 的列表必须不同');

  for (const [label, headers] of combos) {
    const favorites = await call(world.app, 'GET', `${API}/favorites`, a, { headers });
    assert.equal(favorites.status, 200, `${label}：用户面状态被改变：${favorites.text}`);
    assert.equal(stable(favorites), stable(baseFavorites), `${label}：用户面响应体被改变`);
    assert.equal(favorites.text.includes(seeded.favoriteB), false, `${label}：读到 B 的收藏`);

    const admin = await call(world.app, 'GET', `${API}/admin/sources`, a, { headers });
    assertRejection(admin, { status: 403, code: 'SCOPE_DENIED' });
    assert.equal(stable(admin), stable(baseAdmin), `${label}：后台拒绝形状被改变`);

    const foreign = await call(world.app, 'DELETE', `${API}/favorites/${seeded.favoriteB}`, a, {
      headers: { ...wkey('m4-combo-del-b-0001', '"1"'), ...headers },
    });
    assertRejection(foreign, { status: 404, code: 'NOT_FOUND' });
    assert.equal(stable(foreign), stable(baseForeign), `${label}：他人资源拒绝形状被改变`);
    note(`4 ${label} → 用户面 200 同形 / 后台 403 同形 / 他人资源 404 同形`);
  }

  // 组合后仍无副作用：B 的收藏还在。
  const bAfter = await call(world.app, 'GET', `${API}/favorites`, b);
  assert.equal(bAfter.body.data.items.length, 1, '九种头部组合里有一条真的动了 B 的数据');
  note('4 汇总：9 种头部组合 × 3 个面（用户读 / 后台 / 他人资源）全部与基准逐字节同形，B 的数据原样');
});

// ===========================================================================
// 5 静态缝：身份只有**一个写入点**，身份头在鉴权层零出现
// ===========================================================================

test('M4 静态缝：request 身份字段只有一个写入点，鉴权层对身份头零引用', () => {
  const srcRoot = fileURLToPath(new URL('../../services/api/src/', import.meta.url));
  const files = readdirSync(srcRoot, { recursive: true })
    .map((entry) => String(entry).replaceAll('\\', '/'))
    .filter((rel) => rel.endsWith('.ts'))
    .map((rel) => ({ rel, text: readFileSync(srcRoot + rel.replaceAll('/', '\\'), 'utf8') }));
  assert.ok(files.length > 50, `源码扫描面过小（${files.length} 个 .ts），断言将失去意义`);

  // 5.1 身份头名在整个 API 源码里零出现（含注释）：行为层「恰好在这些输入下忽略」可能被
  //     未来的分支绕过，源码层直接锁死「鉴权层没有这条读取路径」。
  const identityHeaderPattern = /x-role|x-user-id|x-userid|x-is-admin|x-admin|x-actor|x-auth-scopes|x-user-role/i;
  const headerHits = files
    .filter((file) => identityHeaderPattern.test(file.text))
    .map((file) => file.rel);
  assert.deepEqual(headerHits, [], `身份头名出现在产品源码里 ⇒ 有人加了一条读取路径：${headerHits.join(', ')}`);

  // 5.2 `request.headers['x-...']` 的读取点只允许一个（媒体共享读的显式句柄）。
  const xHeaderReads = files.flatMap((file) =>
    [...file.text.matchAll(/headers\[['"]x-([a-z0-9-]+)['"]\]/gi)].map((match) => ({ rel: file.rel, name: match[1] })),
  );
  assert.deepEqual(
    xHeaderReads,
    [{ rel: 'routes/media.ts', name: 'media-access-token' }],
    `x-* 请求头读取点被改动：${JSON.stringify(xHeaderReads)}`,
  );

  // 5.3 身份字段的唯一写入点必须是 `applyIdentity`（服务端权威会话解析之后）。
  //     注意 `(?!=)`：排除 `request.userId === …` 这类判空比较，只数真正的赋值。
  const identityFields = ['userId', 'authEpoch', 'role', 'sessionId', 'sessionExpiresAt', 'accountRevision', 'authScopes'];
  const assignmentPattern = new RegExp(`request\\.(${identityFields.join('|')})\\s*=(?!=)`, 'g');
  const assignments = files.flatMap((file) =>
    [...file.text.matchAll(assignmentPattern)].map((match) => ({ rel: file.rel, field: match[1] })),
  );
  assert.deepEqual(
    [...new Set(assignments.map((row) => row.rel))],
    ['auth/middleware.ts'],
    `身份字段被 auth/middleware.ts 之外的文件写入：${assignments.map((row) => `${row.rel}:${row.field}`).join(', ')}`,
  );
  assert.equal(
    assignments.length,
    identityFields.length,
    `身份字段写入点应恰为 ${identityFields.length} 个（${identityFields.join('/')}），实际 ${assignments.length}`,
  );

  const middleware = files.find((file) => file.rel === 'auth/middleware.ts').text;
  const applyIdentityBody = /export function applyIdentity\([\s\S]*?\n\}/.exec(middleware);
  assert.ok(applyIdentityBody !== null, 'applyIdentity 的函数体没找到（静态断言失效）');
  for (const field of identityFields) {
    assert.equal(
      applyIdentityBody[0].includes(`request.${field} =`),
      true,
      `request.${field} 不是在 applyIdentity 里写入的`,
    );
  }

  // 5.4 `applyIdentity` 只有两个调用点：两个守卫（用户 / 后台），都在鉴权成功之后。
  const callSites = files.flatMap((file) =>
    [...file.text.matchAll(/applyIdentity\(/g)].map(() => file.rel),
  );
  assert.deepEqual(callSites, ['auth/middleware.ts', 'auth/middleware.ts', 'auth/middleware.ts'], `applyIdentity 调用点被改动：${callSites.join(', ')}`);

  note(
    `5 静态缝：扫 ${files.length} 个 .ts — 身份头名 0 命中；x-* 头读取仅 media-access-token；` +
      `身份字段写入 ${identityFields.length} 个全在 applyIdentity；applyIdentity 调用点 2 个守卫`,
  );
});
