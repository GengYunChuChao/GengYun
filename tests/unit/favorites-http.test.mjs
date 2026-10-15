// 收藏：真实回环 HTTP（合成账号/合成目标；无 PG、无真实资料读取实现）。
//
// 覆盖 issue #16 的收藏验收：增删、**去重（不产生第二行）**、取消（旧行不复活）、
// 归属与越权（同形 404）、契约形状（键集恰等、不出现"已使用"类字段）、
// 头部（no-store / 强 ETag / 列表无 ETag）、校验与幂等、real 模式整域关闭。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import {
  FAVORITE_KEYS,
  TARGET_REF_KEYS,
  USER_A,
  USER_B,
  makeControllableVisibility,
  scriptedClock,
} from './favorites-history-fixtures.mjs';

const START = Date.UTC(2026, 9, 14, 6);
const FAVORITES = '/api/v1/favorites';
const ABSENT = '00000000-0000-4000-8f00-0000000000ff';

async function fixture(t, options = {}) {
  const clock = scriptedClock(START);
  const auth = createMemoryAuthStore();
  const visibility = options.visibility ?? undefined;
  const config = {
    ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    ...(options.real === true ? { executionMode: 'real', requiresRealCredentials: true } : {}),
  };
  const app = buildApp({
    config,
    store: auth,
    now: clock.now,
    ...(visibility === undefined ? {} : { favoritesInjection: { visibility } }),
  });
  async function account(subject) {
    const user = await auth.createUser(subject.repeat(64));
    const token = `synthetic-i16-token-${subject}`;
    await auth.createSession({
      userId: user.id,
      tokenHashHex: hashToken(token),
      authEpoch: user.authEpoch,
      expiresAt: new Date(START + 48 * 3600_000),
      audience: 'user',
    });
    return { user, token };
  }
  const a = await account('a');
  const b = await account('b');
  const admin = await auth.createUser('d'.repeat(64));
  const adminToken = 'synthetic-i16-admin-token';
  await auth.createSession({
    userId: admin.id,
    tokenHashHex: hashToken(adminToken),
    authEpoch: admin.authEpoch,
    expiresAt: new Date(START + 48 * 3600_000),
    audience: 'admin',
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => app.close());

  async function call(method, path, actor = a, extra = {}) {
    // `contentType` 可**单独**声明 —— 无请求体也带 JSON 头，这正是真机形态：微信 `wx.request`
    // 默认注入 `content-type: application/json`，无体 `DELETE` 因此带着该头出门。
    // 旧版只在有 `payload` 时才加这个头（本处原第 70 行），结构上不可能覆盖「无体 + JSON 头」这一整类。
    const contentType = extra.contentType ?? (extra.payload === undefined ? undefined : 'application/json');
    // `rawBody` 用于发送**真实文本体**（空串 / 非法 JSON），不被 JSON.stringify 包一层。
    const requestBody = extra.rawBody ?? (extra.payload === undefined ? undefined : JSON.stringify(extra.payload));
    const headers = {
      ...(actor === null ? {} : { authorization: `Bearer ${actor.token}` }),
      ...(extra.headers ?? {}),
      ...(contentType === undefined ? {} : { 'content-type': contentType }),
    };
    const response = await fetch(base + path, {
      method,
      headers,
      ...(requestBody === undefined ? {} : { body: requestBody }),
    });
    const body = await response.json();
    return {
      status: response.status,
      body,
      etag: response.headers.get('etag'),
      cache: response.headers.get('cache-control'),
    };
  }
  return { app, auth, clock, a, b, adminToken, call, visibility };
}

function target(type, id, revision = 1) {
  return { target_ref: { type, id, revision } };
}

const create = (id = 'spc-1', seed = 1, type = 'species') => ({
  method: 'POST',
  path: FAVORITES,
  payload: target(type, id),
  headers: { 'idempotency-key': `fav-create-${String(seed).padStart(4, '0')}` },
});

test('收藏HTTP：增→列→取消 的契约形状、头部与"去重不产生第二行"', async (t) => {
  const h = await fixture(t);

  const empty = await h.call('GET', FAVORITES);
  assert.equal(empty.status, 200);
  assert.equal(empty.cache, 'no-store');
  assert.equal(empty.etag, null, '列表不得回 ETag（契约：资源revision强ETag；列表无此头）');
  assert.deepEqual(empty.body.data, { items: [], next_cursor: null });
  assert.deepEqual(Object.keys(empty.body.data).sort(), ['items', 'next_cursor']);

  const first = await h.call('POST', FAVORITES, h.a, create('spc-1', 1));
  assert.equal(first.status, 201);
  assert.equal(first.etag, '"1"');
  assert.equal(first.cache, 'no-store');
  assert.deepEqual(Object.keys(first.body.data).sort(), [...FAVORITE_KEYS].sort());
  assert.deepEqual(Object.keys(first.body.data.target_ref).sort(), [...TARGET_REF_KEYS].sort());
  // 「收藏不自动转成已使用事实」：投影里**不得**出现任何使用类字段。
  for (const forbidden of ['used', 'usage', 'used_at', 'last_used_at', 'count']) {
    assert.equal(Object.hasOwn(first.body.data, forbidden), false, `投影不应含 ${forbidden}`);
  }
  // 默认引用可用性端口已于 #167 接线，但本夹具不传 pool（`pool === null`）⇒ 公开读面核不到
  // ⇒ 如实 unavailable，绝不假装可用。
  assert.equal(first.body.data.reference_state, 'unavailable');
  assert.equal(typeof first.body.data.unavailable_reason, 'string');
  const createdId = first.body.data.id;
  const createdAt = first.body.data.created_at;

  // 重复收藏同一目标（换新幂等键）：仍返回**同一行**，不新建、不改 created_at。
  const dup = await h.call('POST', FAVORITES, h.a, create('spc-1', 2));
  assert.equal(dup.status, 201);
  assert.equal(dup.body.data.id, createdId);
  assert.equal(dup.body.data.created_at, createdAt);
  const list = await h.call('GET', FAVORITES);
  assert.equal(list.body.data.items.length, 1, '同一用户同一目标只能有一行');
  assert.equal(h.app.favoritesService !== null, true);

  // 同幂等键同体重放：返回同一行。
  const replayed = await h.call('POST', FAVORITES, h.a, create('spc-1', 2));
  assert.equal(replayed.body.data.id, createdId);
  // 同键异体（换目标）⇒ 409 IDEMPOTENCY_CONFLICT，绝不回放另一份请求的结果。
  const conflict = await h.call('POST', FAVORITES, h.a, {
    method: 'POST',
    path: FAVORITES,
    payload: target('species', 'spc-2'),
    headers: { 'idempotency-key': 'fav-create-0002' },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');

  // 取消（If-Match 必填）：200 Ack；列表清空。
  const removed = await h.call('DELETE', `${FAVORITES}/${createdId}`, h.a, {
    headers: { 'idempotency-key': 'fav-delete-0001', 'if-match': '"1"' },
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.data, { accepted: true });
  assert.equal(removed.cache, 'no-store');
  assert.equal((await h.call('GET', FAVORITES)).body.data.items.length, 0);

  // 取消后重新收藏：得到**新 id**（旧行不复活）。
  const again = await h.call('POST', FAVORITES, h.a, create('spc-1', 3));
  assert.equal(again.status, 201);
  assert.notEqual(again.body.data.id, createdId);
  assert.equal((await h.call('GET', FAVORITES)).body.data.items.length, 1);
});

test('收藏HTTP：归属/越权同形、If-Match 与幂等头部纪律', async (t) => {
  const h = await fixture(t);
  const mine = (await h.call('POST', FAVORITES, h.a, create('spc-9', 11))).body.data;

  // B 的列表看不到 A 的收藏。
  const bList = await h.call('GET', FAVORITES, h.b);
  assert.deepEqual(bList.body.data, { items: [], next_cursor: null });

  // B 取消 A 的收藏：404，且与"完全不存在的 id"**逐字节同形**（不泄露存在性）。
  const otherHeader = { headers: { 'idempotency-key': 'fav-b-0001', 'if-match': '"1"' } };
  const foreign = await h.call('DELETE', `${FAVORITES}/${mine.id}`, h.b, otherHeader);
  const absent = await h.call('DELETE', `${FAVORITES}/${ABSENT}`, h.b, {
    headers: { 'idempotency-key': 'fav-b-0002', 'if-match': '"1"' },
  });
  assert.equal(foreign.status, 404);
  assert.equal(absent.status, 404);
  assert.equal(foreign.body.error.code, 'NOT_FOUND');
  assert.deepEqual(foreign.body.error, absent.body.error, '他人收藏与不存在必须同形');
  // 非本人**不得**拿到 409（那会泄露"存在但不是你的"）。
  const foreignStale = await h.call('DELETE', `${FAVORITES}/${mine.id}`, h.b, {
    headers: { 'idempotency-key': 'fav-b-0003', 'if-match': '"7"' },
  });
  assert.equal(foreignStale.status, 404);

  // A 自己：缺 If-Match ⇒ 428；非法 ⇒ 400；版本不符 ⇒ 409。
  assert.equal(
    (await h.call('DELETE', `${FAVORITES}/${mine.id}`, h.a, { headers: { 'idempotency-key': 'fav-a-0001' } })).status,
    428,
  );
  const badEtag = await h.call('DELETE', `${FAVORITES}/${mine.id}`, h.a, {
    headers: { 'idempotency-key': 'fav-a-0002', 'if-match': '*' },
  });
  assert.equal(badEtag.status, 400);
  assert.equal(badEtag.body.error.code, 'INVALID_REQUEST');
  const stale = await h.call('DELETE', `${FAVORITES}/${mine.id}`, h.a, {
    headers: { 'idempotency-key': 'fav-a-0003', 'if-match': '"2"' },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'REVISION_CONFLICT');
  // 缺 Idempotency-Key ⇒ 400 IDEMPOTENCY_KEY_REQUIRED。
  const noKey = await h.call('DELETE', `${FAVORITES}/${mine.id}`, h.a, { headers: { 'if-match': '"1"' } });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  // 成功取消后，旧 ETag 重放（换新幂等键）⇒ 404（不复活）。
  const ok = await h.call('DELETE', `${FAVORITES}/${mine.id}`, h.a, {
    headers: { 'idempotency-key': 'fav-a-0004', 'if-match': '"1"' },
  });
  assert.equal(ok.status, 200);
  const second = await h.call('DELETE', `${FAVORITES}/${mine.id}`, h.a, {
    headers: { 'idempotency-key': 'fav-a-0005', 'if-match': '"1"' },
  });
  assert.equal(second.status, 404);
});

test('收藏HTTP：请求校验（闭集/未知字段/路径/查询参数）与后台会话隔离', async (t) => {
  const h = await fixture(t);

  // 非闭集目标类型（契约只允许 species|herbicide|scheme）。
  const badType = await h.call('POST', FAVORITES, h.a, {
    ...create('p-1', 21),
    payload: target('post', 'p-1'),
  });
  assert.equal(badType.status, 400);
  assert.equal(badType.body.error.code, 'INVALID_REQUEST');

  // 未知字段（包含任何"使用类"字段）一律拒绝，不静默丢弃。
  for (const payload of [
    { ...target('species', 'spc-1'), used: true },
    target('species', ''),
    { target_ref: { type: 'species', id: 'spc-1' } },
  ]) {
    const bad = await h.call('POST', FAVORITES, h.a, {
      method: 'POST',
      path: FAVORITES,
      payload,
      headers: { 'idempotency-key': 'fav-bad-0021' },
    });
    assert.equal(bad.status, 400, JSON.stringify(payload));
    assert.equal(bad.body.error.code, 'INVALID_REQUEST');
  }

  // 非法 uuid 路径参数 ⇒ 400。
  assert.equal((await h.call('DELETE', `${FAVORITES}/not-a-uuid`, h.a, {
    headers: { 'idempotency-key': 'fav-bad-0022', 'if-match': '"1"' },
  })).status, 400);

  // 契约没有按类型筛选的查询参数 ⇒ 多余字段 400（不静默忽略）。
  assert.equal((await h.call('GET', `${FAVORITES}?type=species`)).status, 400);
  assert.equal((await h.call('GET', `${FAVORITES}?limit=99`)).status, 400);

  // 后台会话不得访问用户域：用户门禁先以 401 拒绝（服务层还有第二道 SCOPE_DENIED，见域测试）。
  const adminFavorites = await h.call('GET', FAVORITES, { token: h.adminToken });
  assert.equal(adminFavorites.status, 401);
  assert.ok(['SESSION_REQUIRED', 'SESSION_EXPIRED'].includes(adminFavorites.body.error.code));

  // 未登录 ⇒ 401。
  assert.equal((await h.call('GET', FAVORITES, null)).status, 401);
  void USER_A;
  void USER_B;
});

test('收藏HTTP：分页稳定、游标签名与跨主体拒绝', async (t) => {
  const h = await fixture(t);
  for (let index = 0; index < 5; index += 1) {
    h.clock.advance(1000);
    await h.call('POST', FAVORITES, h.a, create(`spc-${index}`, 30 + index));
  }
  const page1 = await h.call('GET', `${FAVORITES}?limit=2`);
  assert.equal(page1.body.data.items.length, 2);
  assert.equal(typeof page1.body.data.next_cursor, 'string');
  const page2 = await h.call('GET', `${FAVORITES}?limit=2&cursor=${encodeURIComponent(page1.body.data.next_cursor)}`);
  assert.equal(page2.body.data.items.length, 2);
  const ids = new Set([...page1.body.data.items, ...page2.body.data.items].map((item) => item.id));
  assert.equal(ids.size, 4, '跨页不得重复');

  // 游标被篡改 ⇒ 400 INVALID_CURSOR。
  const tampered = `${page1.body.data.next_cursor.slice(0, -2)}zz`;
  const bad = await h.call('GET', `${FAVORITES}?limit=2&cursor=${encodeURIComponent(tampered)}`);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'INVALID_CURSOR');

  // 跨主体复用游标 ⇒ 400（游标签名绑定主体）。
  const crossed = await h.call('GET', `${FAVORITES}?limit=2&cursor=${encodeURIComponent(page1.body.data.next_cursor)}`, h.b);
  assert.equal(crossed.status, 400);
  assert.equal(crossed.body.error.code, 'INVALID_CURSOR');

  // 翻页期间取消一行 ⇒ 位置不可复现，如实 400 INVALID_CURSOR（不静默跳页）。
  const victim = page1.body.data.items[0];
  await h.call('DELETE', `${FAVORITES}/${victim.id}`, h.a, {
    headers: { 'idempotency-key': 'fav-page-0001', 'if-match': '"1"' },
  });
  const afterChange = await h.call('GET', `${FAVORITES}?limit=2&cursor=${encodeURIComponent(page1.body.data.next_cursor)}`);
  assert.equal(afterChange.status, 400);
  assert.equal(afterChange.body.error.code, 'INVALID_CURSOR');
});

test('收藏HTTP：real 模式整域关闭（内存存储不冒充持久化）', async (t) => {
  const h = await fixture(t, { real: true });
  for (const [method, path, extra] of [
    ['GET', FAVORITES, {}],
    ['POST', FAVORITES, { payload: target('species', 'spc-1'), headers: { 'idempotency-key': 'fav-real-0001' } }],
    ['DELETE', `${FAVORITES}/${ABSENT}`, { headers: { 'idempotency-key': 'fav-real-0002', 'if-match': '"1"' } }],
  ]) {
    const result = await h.call(method, path, h.a, extra);
    assert.equal(result.status, 503, `${method} ${path}`);
    assert.equal(result.body.error.code, 'PROVIDER_UNAVAILABLE');
  }
  assert.equal(h.app.favoritesService, null);
});

test('收藏HTTP：无体写请求带微信默认 JSON content-type 时不得被判成 400（且不放宽任何校验）', async (t) => {
  const h = await fixture(t);
  const mine = (await h.call('POST', FAVORITES, h.a, create('spc-nobody', 51))).body.data;

  // 真机形态（GY-I16 真机阻断缺陷）：`wx.request` 默认注入 `content-type: application/json`，
  // 而取消收藏的 `DELETE` **没有请求体**。修复前 Fastify 只凭该头就进 JSON 解析器 ⇒
  // `FST_ERR_CTP_EMPTY_JSON_BODY` ⇒ 400「请求体格式错误」，请求**到不了路由**：
  // 连 401/428/409 都会被它遮住（`_w61-probe-before.log` 的 G1–G6 逐条实测）。
  const withDefaultHeader = { contentType: 'application/json' };

  // 回归①：缺 If-Match **仍然** 428（不是 200，也不是解析错误顶掉的 400）。
  const missing = await h.call('DELETE', `${FAVORITES}/${mine.id}`, h.a, {
    ...withDefaultHeader,
    headers: { 'idempotency-key': 'fav-nobody-0001' },
  });
  assert.equal(missing.status, 428);
  assert.equal(missing.body.error.code, 'REVISION_REQUIRED');

  // 回归②：版本不符 **仍然** 409。
  const stale = await h.call('DELETE', `${FAVORITES}/${mine.id}`, h.a, {
    ...withDefaultHeader,
    headers: { 'idempotency-key': 'fav-nobody-0002', 'if-match': '"2"' },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'REVISION_CONFLICT');

  // 回归③：未登录 **仍然** 401 —— 鉴权必须在请求体解析之后照常拦下（不能被"无体"绕过）。
  const anonymous = await h.call('DELETE', `${FAVORITES}/${mine.id}`, null, {
    ...withDefaultHeader,
    headers: { 'idempotency-key': 'fav-nobody-0003', 'if-match': '"1"' },
  });
  assert.equal(anonymous.status, 401);
  assert.ok(['SESSION_REQUIRED', 'SESSION_EXPIRED'].includes(anonymous.body.error.code));

  // 回归④：幂等键要求与 `If-Match` 形状校验都**不**放宽。
  const noKey = await h.call('DELETE', `${FAVORITES}/${mine.id}`, h.a, {
    ...withDefaultHeader,
    headers: { 'if-match': '"1"' },
  });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  const badEtag = await h.call('DELETE', `${FAVORITES}/${mine.id}`, h.a, {
    ...withDefaultHeader,
    headers: { 'idempotency-key': 'fav-nobody-0004', 'if-match': '*' },
  });
  assert.equal(badEtag.status, 400);
  assert.equal(badEtag.body.error.code, 'INVALID_REQUEST');

  // 正例：无体 + JSON 头 ⇒ 200 Ack，且与"不带头"的同一请求逐字同形（无体就是无体）。
  const removed = await h.call('DELETE', `${FAVORITES}/${mine.id}`, h.a, {
    ...withDefaultHeader,
    headers: { 'idempotency-key': 'fav-nobody-0005', 'if-match': '"1"' },
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.data, { accepted: true });
  assert.equal(removed.cache, 'no-store');
  assert.equal((await h.call('GET', FAVORITES)).body.data.items.length, 0);

  // 负控制①：**需要**请求体的路由，空体 + JSON 头仍然 400（"空体≠无体"只在无体写面上成立，
  // 不是"任何空体都放行"）。带 schema.body 时按 schema 拒绝，语义更准。
  const emptyPost = await h.call('POST', FAVORITES, h.a, {
    ...withDefaultHeader,
    rawBody: '',
    headers: { 'idempotency-key': 'fav-nobody-0006' },
  });
  assert.equal(emptyPost.status, 400);
  assert.equal(emptyPost.body.error.code, 'INVALID_REQUEST');

  // 负控制②：非空的**非法 JSON** 仍然 400「请求体格式错误」——真实解析失败不得被顺带放宽。
  const malformed = await h.call('POST', FAVORITES, h.a, {
    ...withDefaultHeader,
    rawBody: '{',
    headers: { 'idempotency-key': 'fav-nobody-0007' },
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, 'INVALID_REQUEST');
  assert.equal(malformed.body.error.message, '请求体格式错误');
});

test('收藏HTTP：可控可见性替身下 可用/不可用 的投影与推荐资格', async (t) => {
  const visibility = makeControllableVisibility(['species:spc-visible']);
  const h = await fixture(t, { visibility: visibility.port });
  const created = await h.call('POST', FAVORITES, h.a, create('spc-visible', 41));
  assert.equal(created.body.data.reference_state, 'available');
  assert.equal(created.body.data.unavailable_reason, null, '可用时不得给不可用说明');

  // 目标转为不可见（隐藏/失效/删除/注销后不可读都折叠成这一条）：下一次读取立即反映。
  visibility.hide('species', 'spc-visible');
  const afterHide = await h.call('GET', FAVORITES);
  assert.equal(afterHide.body.data.items[0].reference_state, 'unavailable');
  assert.equal(typeof afterHide.body.data.items[0].unavailable_reason, 'string');
  assert.ok(
    afterHide.body.data.items[0].unavailable_reason.length <= 80,
    'unavailable_reason 必须落在契约 1..80 字符内',
  );
});
