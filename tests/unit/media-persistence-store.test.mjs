// GY-R28 W12 媒体持久化 · 登记册/授权/幂等台账端口（单测）。
//
// 断言口径（本片的存在理由，逐条对应验收）：
//   1. 服务**不再持有**任何进程内事实：同一份 `MediaStore` 换一个服务实例（模拟重启）后，
//      上传句柄、状态、revision、对象键都还在；非 owner 仍然 NOT_FOUND。
//   2. 幂等：同一 `Idempotency-Key` 重复 `complete` **不产生第二行、不重复派生**（用计数桶证明
//      `putObject` 没被再调一次），换键重复也不重复派生。
//   3. 台账三段（claim/settle/release）语义与 0008 同口径：占位中读到 `mediaId === null`、
//      占位可过期、结算后不可再结算。
//
// 这里刻意**不**断言「real + 内存端口 ⇒ 503」：那条门禁在装配层（`app.ts` 的
// `mediaPersistenceRefusal`，需要真实数据库池才会触发），由真库集成测试覆盖；
// 在服务层加同名门禁会与既有 r3 用例（real + 注入真实端口 + 无池 ⇒ 201）冲突。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createSubstituteObjectStore } from '../../services/api/src/media/object-store.ts';
import {
  MEDIA_IDEMPOTENCY_CLAIM_TTL_MS,
  MEDIA_IDEMPOTENCY_PATHS,
  MEDIA_IDEMPOTENCY_TTL_MS,
  createMemoryMediaStore,
  mediaIdempotencyKeyHash,
  mediaIdempotencyScope,
} from '../../services/api/src/media/store.ts';
import { sha256Hex } from '../../packages/media/validate.mjs';
import { jpegWithExif } from '../media/_fixtures.mjs';

const NOW_MS = 1_700_000_000_000;
const KEY = (name) => `media-persist-${name}-0000`;

function makeApp({ mediaStore, objectStore } = {}) {
  return buildApp({
    config: { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), executionMode: 'stub' },
    mediaObjectStore: objectStore,
    ...(mediaStore === undefined ? {} : { mediaStore }),
    now: () => new Date(NOW_MS),
  });
}

/** 在替身桶外面套一层计数：用来证明「没有第二次派生」。 */
function countingObjectStore() {
  const inner = createSubstituteObjectStore();
  const calls = { puts: [], deletes: [] };
  return {
    calls,
    store: {
      ...inner,
      async putObject(key, bytes, contentType) {
        calls.puts.push(key);
        return inner.putObject(key, bytes, contentType);
      },
      async deleteObject(key) {
        calls.deletes.push(key);
        return inner.deleteObject(key);
      },
    },
  };
}

/**
 * 可挂起的替身桶：让 `complete` 精确停在「已读快照、衍生件 putObject 还没落地」的窗口里。
 *
 * 这是监工 1927 轮 P1 复现的最小工具——不挂起就必然靠 `setTimeout` 抢时序，那是脆的。
 * `arm()` 只拦**下一次** `putObject`；拦到后立刻解除，避免把后续回收路径也挂住。
 *
 * 监工 1022-0203 轮 P1 追加 `failDelete(key)`：把**指定键**的 `deleteObject` 钉成返回 `false`
 * （端口契约里 `false` = 未能确认删除），用来复现「桶侧暂时删不掉」。`unfailDelete()` 恢复。
 */
function gatedObjectStore() {
  const inner = createSubstituteObjectStore();
  const calls = { puts: [], deletes: [], failedDeletes: [] };
  const failing = new Set();
  let armed = null;
  const store = {
    ...inner,
    async putObject(key, bytes, contentType) {
      calls.puts.push(key);
      const held = armed;
      if (held !== null) {
        armed = null;
        held.entered(key);
        await held.released;
      }
      return inner.putObject(key, bytes, contentType);
    },
    async deleteObject(key) {
      calls.deletes.push(key);
      if (failing.has(key)) {
        calls.failedDeletes.push(key);
        return false;
      }
      return inner.deleteObject(key);
    },
  };
  return {
    calls,
    store,
    arm() {
      let entered;
      const enteredPromise = new Promise((resolve) => { entered = resolve; });
      let release;
      const released = new Promise((resolve) => { release = resolve; });
      armed = { entered, released };
      return { enteredPromise, release: () => { release(); } };
    },
    failDelete(key) { failing.add(key); },
    unfailDelete() { failing.clear(); },
  };
}

async function login(app, code) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/wechat',
    headers: { 'content-type': 'application/json', 'idempotency-key': `login-key-${code}` },
    payload: { code },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().data.access_token;
}

async function call(app, method, url, token, { payload, headers } = {}) {
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(headers ?? {}),
    },
  });
  let body = null;
  try { body = response.json(); } catch { body = null; }
  return { status: response.statusCode, body, etag: response.headers.etag };
}

test('GY-R28 W12 持久化端口：换实例（模拟重启）后登记册/对象键/幂等回执仍在，非 owner 仍 404', async (t) => {
  const mediaStore = createMemoryMediaStore({ now: () => NOW_MS });
  const { store: objectStore, calls } = countingObjectStore();
  const jpeg = jpegWithExif();
  const declare = { purpose: 'weed_recognition', mime: 'image/jpeg', bytes: jpeg.length, sha256: sha256Hex(jpeg) };

  const first = makeApp({ mediaStore, objectStore });
  t.after(async () => { await first.close(); });
  const ownerToken = await login(first, 'persist-owner');
  const strangerToken = await login(first, 'persist-stranger');

  let mediaId;
  let recreateKeys;
  let createKeyUsed;

  await t.test('三段式：POST /media/uploads 201 → 客户端 PUT → complete 202（state=ready, revision=2）', async () => {
    const created = await call(first, 'POST', '/api/v1/media/uploads', ownerToken, {
      payload: declare,
      headers: { 'idempotency-key': KEY('create') },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    mediaId = created.body.data.media.id;
    assert.equal(created.body.data.media.state, 'initiated');
    createKeyUsed = KEY('create');

    const keys = await first.mediaService.serverObjectKeys(mediaId);
    assert.ok(keys !== null && typeof keys.rawRef === 'string');
    await objectStore.putObject(keys.rawRef, jpeg, 'image/jpeg');
    assert.equal(calls.puts.length, 1, '客户端直传算一次 put');

    const completed = await call(first, 'POST', `/api/v1/media/uploads/${mediaId}/complete`, ownerToken, {
      payload: { sha256: declare.sha256, bytes: declare.bytes },
      headers: { 'idempotency-key': KEY('complete'), 'if-match': '"1"' },
    });
    assert.equal(completed.status, 202, JSON.stringify(completed.body));
    assert.equal(completed.body.data.state, 'ready');
    assert.equal(completed.body.data.revision, 2);
    assert.equal(completed.etag, '"2"');
    assert.equal(calls.puts.length, 2, 'complete 派生一个剥离元数据的对象');
    assert.equal(await mediaStore.countMedia(), 1);
  });

  await t.test('owner 读 200；非 owner 读 404 NOT_FOUND（归属来自持久化登记册，不是进程内缓存）', async () => {
    const mine = await call(first, 'GET', `/api/v1/media/${mediaId}`, ownerToken);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.equal(mine.body.data.id, mediaId);
    assert.equal(mine.body.data.revision, 2);

    const other = await call(first, 'GET', `/api/v1/media/${mediaId}`, strangerToken);
    assert.equal(other.status, 404, JSON.stringify(other.body));
    assert.equal(other.body.error.code, 'NOT_FOUND');
  });

  await t.test('同一幂等键重复 complete ⇒ 202 回放，不产第二行、不再派生（put 计数不变）', async () => {
    const replay = await call(first, 'POST', `/api/v1/media/uploads/${mediaId}/complete`, ownerToken, {
      payload: { sha256: declare.sha256, bytes: declare.bytes },
      headers: { 'idempotency-key': KEY('complete'), 'if-match': '"1"' },
    });
    assert.equal(replay.status, 202, JSON.stringify(replay.body));
    assert.equal(replay.body.data.revision, 2);
    assert.equal(calls.puts.length, 2, '回放不得再派生');
    assert.equal(await mediaStore.countMedia(), 1, '回放不得产生第二行媒体记录');
  });

  await t.test('同一幂等键但请求体不同 ⇒ 409 IDEMPOTENCY_CONFLICT（不静默回放）', async () => {
    const conflict = await call(first, 'POST', `/api/v1/media/uploads/${mediaId}/complete`, ownerToken, {
      payload: { sha256: 'f'.repeat(64), bytes: declare.bytes },
      headers: { 'idempotency-key': KEY('complete'), 'if-match': '"1"' },
    });
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  });

  await t.test('同一幂等键重复 initiate ⇒ 回放同一媒体 id（不新增行）', async () => {
    const replay = await call(first, 'POST', '/api/v1/media/uploads', ownerToken, {
      payload: declare,
      headers: { 'idempotency-key': createKeyUsed },
    });
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.equal(replay.body.data.media.id, mediaId);
    assert.equal(await mediaStore.countMedia(), 1);
  });

  recreateKeys = await first.mediaService.serverObjectKeys(mediaId);
  assert.ok(recreateKeys !== null);

  await t.test('模拟重启：新服务实例 + 同一端口 ⇒ 同一 uploadId 仍可读，键逐字相同（来自台账而非内存）', async () => {
    // 「重启」在这里是**新服务实例**：`makeApp` 每调一次都是全新的 AppMediaService。
    // 认证侧的内存用户表也随实例消失，所以这一段直接走服务端口（HTTP 面已在上面验过），
    // 断言点仍是「同一个 uploadId 能不能读、读到的键与字节是否一致」。
    const record = await mediaStore.getMedia(mediaId);
    const actor = { ownerId: record.ownerId, authEpoch: 1, sessionRef: '99999999-9999-4999-8999-999999999999' };
    const second = makeApp({ mediaStore, objectStore });
    try {
      const afterRestart = await second.mediaService.getMedia({ actor, mediaId });
      assert.equal(afterRestart.status, 200);
      assert.equal(afterRestart.media.state, 'ready');
      assert.equal(afterRestart.media.revision, 2);

      const keysAfterRestart = await second.mediaService.serverObjectKeys(mediaId);
      assert.deepEqual(keysAfterRestart, recreateKeys, '重启前后对象键必须一致');
      assert.notEqual(keysAfterRestart.rawRef, keysAfterRestart.derivativeRef, 'raw 与衍生物是两个对象键');

      await assert.rejects(
        () => second.mediaService.getMedia({ actor: { ...actor, ownerId: '00000000-0000-4000-8000-000000000000' }, mediaId }),
        (error) => {
          assert.equal(error.code, 'NOT_FOUND');
          return true;
        },
        '非 owner 在重启后仍必须 NOT_FOUND',
      );

      // 重启后仍能读到真实字节（服务端记录的键确实指向桶里的对象）。
      const raw = await objectStore.getObject(keysAfterRestart.rawRef);
      const derivative = await objectStore.getObject(keysAfterRestart.derivativeRef);
      assert.ok(raw !== null && derivative !== null);
      assert.equal(raw.bytes.length, jpeg.length);
      assert.ok(derivative.bytes.length < raw.bytes.length, '衍生物应小于原图（已剥离元数据）');

      // 重启后换新键重复 complete：state 已 ready ⇒ 202，且不再派生。
      const replayNewKey = await second.mediaService.completeUpload({
        actor,
        mediaId,
        ifMatch: '"2"',
        input: { sha256: declare.sha256, bytes: declare.bytes },
        idempotencyKey: KEY('complete-after-restart'),
      });
      assert.equal(replayNewKey.status, 202);
      assert.equal(replayNewKey.media.revision, 2);
      assert.equal(calls.puts.length, 2, '换键回放也不得重复派生');
      assert.equal(await mediaStore.countMedia(), 1);
    } finally {
      await second.close();
    }
  });

  await t.test('删除：对象回收后键位清空（rawRef/derivativeRef ⇒ null），登记册仍留 deleted 行', async () => {
    const deleted = await call(first, 'DELETE', `/api/v1/media/${mediaId}`, ownerToken, {
      headers: { 'idempotency-key': KEY('delete'), 'if-match': '"2"' },
    });
    assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
    const keys = await first.mediaService.serverObjectKeys(mediaId);
    assert.deepEqual(keys, { rawRef: null, derivativeRef: null });
    const record = await mediaStore.getMedia(mediaId);
    assert.equal(record.state, 'deleted');
    assert.equal(record.rawRef, null);
    assert.equal(record.derivativeRef, null);
    assert.equal(await objectStore.getObject(recreateKeys.rawRef), null, '桶里的原图应已删除');
  });
});

test('GY-R28 W12 端口语义：台账三段、快照隔离、按状态枚举与授权计数', async (t) => {
  let nowMs = NOW_MS;
  const store = createMemoryMediaStore({ now: () => nowMs });
  const scope = mediaIdempotencyScope('11111111-1111-4111-8111-111111111111', 'POST', MEDIA_IDEMPOTENCY_PATHS.initiate);
  const keyHash = mediaIdempotencyKeyHash(scope, KEY('claim'));

  await t.test('键域：scope 含主体与路由模板，摘要随键变化；模板里的 {id} 不进键域', () => {
    assert.equal(scope, `11111111-1111-4111-8111-111111111111\nPOST\n${MEDIA_IDEMPOTENCY_PATHS.initiate}`);
    assert.match(keyHash, /^[0-9a-f]{64}$/);
    assert.notEqual(keyHash, mediaIdempotencyKeyHash(scope, KEY('other')));
    assert.equal(MEDIA_IDEMPOTENCY_PATHS.complete, '/api/v1/media/uploads/{id}/complete');
    assert.equal(MEDIA_IDEMPOTENCY_PATHS.remove, '/api/v1/media/{id}');
  });

  await t.test('claim 只能成功一次；占位中读到 mediaId=null；settle 后可读回结果；重复 settle 返回 false', async () => {
    assert.equal(await store.findIdempotency(scope, keyHash), null);
    assert.equal(await store.claimIdempotency(scope, keyHash, { requestHash: 'a'.repeat(64), expiresAt: nowMs + MEDIA_IDEMPOTENCY_TTL_MS }), true);
    assert.equal(await store.claimIdempotency(scope, keyHash, { requestHash: 'a'.repeat(64), expiresAt: nowMs + MEDIA_IDEMPOTENCY_TTL_MS }), false);
    assert.deepEqual(await store.findIdempotency(scope, keyHash), { requestHash: 'a'.repeat(64), mediaId: null });

    const mediaId = '33333333-3333-4333-8333-333333333333';
    assert.equal(await store.settleIdempotency(scope, keyHash, { mediaId, expiresAt: nowMs + MEDIA_IDEMPOTENCY_TTL_MS }), true);
    assert.deepEqual(await store.findIdempotency(scope, keyHash), { requestHash: 'a'.repeat(64), mediaId });
    assert.equal(await store.settleIdempotency(scope, keyHash, { mediaId, expiresAt: nowMs + MEDIA_IDEMPOTENCY_TTL_MS }), false);
    // release 只删「占位中」，已结算的不动。
    await store.releaseIdempotency(scope, keyHash);
    assert.deepEqual(await store.findIdempotency(scope, keyHash), { requestHash: 'a'.repeat(64), mediaId });
  });

  await t.test('占位会过期（崩溃不会把键钉死）：claim TTL 过后可重新占位，release 生效', async () => {
    const otherHash = mediaIdempotencyKeyHash(scope, KEY('expiring'));
    assert.equal(await store.claimIdempotency(scope, otherHash, { requestHash: 'b'.repeat(64), expiresAt: nowMs + MEDIA_IDEMPOTENCY_CLAIM_TTL_MS }), true);
    assert.equal(await store.claimIdempotency(scope, otherHash, { requestHash: 'b'.repeat(64), expiresAt: nowMs + MEDIA_IDEMPOTENCY_CLAIM_TTL_MS }), false);
    nowMs += MEDIA_IDEMPOTENCY_CLAIM_TTL_MS + 1;
    assert.equal(await store.findIdempotency(scope, otherHash), null);
    assert.equal(await store.claimIdempotency(scope, otherHash, { requestHash: 'b'.repeat(64), expiresAt: nowMs + MEDIA_IDEMPOTENCY_TTL_MS }), true);
    await store.releaseIdempotency(scope, otherHash);
    assert.equal(await store.findIdempotency(scope, otherHash), null);
  });

  await t.test('记录是快照：改返回值不影响库；saveMedia 未知 id 抛错', async () => {
    const record = {
      id: '44444444-4444-4444-8444-444444444444',
      ownerId: '11111111-1111-4111-8111-111111111111',
      revision: 1,
      purpose: 'community_image',
      mime: 'image/png',
      bytes: 12,
      duration_ms: null,
      sha256: 'c'.repeat(64),
      state: 'initiated',
      failure_code: null,
      rawRef: 'obj_raw_snapshot',
      derivativeRef: null,
      createdAt: nowMs,
      updatedAt: nowMs,
      expiresAt: nowMs + 60_000,
    };
    await store.createMedia(record);
    await assert.rejects(() => store.createMedia(record), /已存在该 id/);
    const read = await store.getMedia(record.id);
    read.state = 'ready';
    read.rawRef = 'tampered';
    assert.equal((await store.getMedia(record.id)).state, 'initiated', '读出的必须是快照');
    assert.equal((await store.getMedia(record.id)).rawRef, 'obj_raw_snapshot');

    await store.saveMedia({ ...record, state: 'ready' });
    assert.equal((await store.getMedia(record.id)).state, 'ready');
    await assert.rejects(() => store.saveMedia({ ...record, id: '55555555-5555-4555-8555-555555555555' }), /不存在该 id/);

    assert.deepEqual((await store.listMediaByState(['ready'])).map((row) => row.id), [record.id]);
    assert.equal(await store.countMedia(), 1);
    assert.equal(await store.liveCommunityImageCount(record.ownerId), 1);
    await store.saveMedia({ ...record, state: 'deleted' });
    assert.equal(await store.liveCommunityImageCount(record.ownerId), 0, '删除态不再占社区图位');
  });

  await t.test('授权行：写入/取回/撤销计数/陈旧枚举/删除', async () => {
    const grant = {
      grantId: '66666666-6666-4666-8666-666666666666',
      tokenHash: 'd'.repeat(64),
      requesterId: '11111111-1111-4111-8111-111111111111',
      sessionRef: '77777777-7777-4777-8777-777777777777',
      requesterAuthEpoch: 1,
      mediaId: '44444444-4444-4444-8444-444444444444',
      mediaRevision: 1,
      contentRef: { type: 'post', id: '88888888-8888-4888-8888-888888888888', revision: 1 },
      slot: 'attachment',
      authorRevision: null,
      expiresAt: nowMs + 300_000,
      revokedAt: null,
    };
    await store.createGrant(grant);
    await assert.rejects(() => store.createGrant(grant), /已存在该 id/);
    const read = await store.getGrant(grant.grantId);
    assert.deepEqual(read, grant);
    read.contentRef.revision = 9;
    assert.equal((await store.getGrant(grant.grantId)).contentRef.revision, 1, 'contentRef 也必须是快照');
    assert.equal(await store.countGrants(), 1);
    assert.deepEqual(await store.listStaleGrants(nowMs), []);
    assert.equal(await store.revokeGrantsForMedia(grant.mediaId, nowMs), 1);
    assert.equal(await store.revokeGrantsForMedia(grant.mediaId, nowMs), 0, '已撤销的不重复计数');
    assert.equal((await store.getGrant(grant.grantId)).revokedAt, nowMs);
    assert.equal((await store.listStaleGrants(nowMs)).length, 1);
    await store.deleteGrant(grant.grantId);
    assert.equal(await store.getGrant(grant.grantId), null);
    assert.equal(await store.countGrants(), 0);
  });
});

// ---------------------------------------------------------------------------
// 监工 1927 轮 P1：[P1] `complete` 与 `delete` 的幂等 scope 不同（`POST
// /media/uploads/{id}/complete` vs `DELETE /media/{id}` 是两把互不排斥的键），所以两者可以并发。
// `complete` 的窗口是「读快照 → 取回字节 → 生成衍生件 → 写回」，其中生成衍生件是异步的；
// 改前写回是 `WHERE id = $1` 的整行覆写 ⇒ 窗口内落地的 `delete` 被盖回 `ready`，已删除的媒体复活。
// 本片把窗口钉死（挂起衍生件 putObject），让 delete 在窗口内成功落库，再放行 complete：
// 它必须**可判定地失败**，且库里的 `deleted` 原样保留。
// ---------------------------------------------------------------------------
test('GY-R28 W12 竞态（监工 1927 轮 P1）：已删除的媒体不得被迟到的 complete 复活', async (t) => {
  const mediaStore = createMemoryMediaStore({ now: () => NOW_MS });
  const bucket = gatedObjectStore();
  const jpeg = jpegWithExif();
  const declare = { purpose: 'weed_recognition', mime: 'image/jpeg', bytes: jpeg.length, sha256: sha256Hex(jpeg) };
  const app = makeApp({ mediaStore, objectStore: bucket.store });
  t.after(async () => { await app.close(); });
  const token = await login(app, 'race-owner');

  const created = await call(app, 'POST', '/api/v1/media/uploads', token, {
    payload: declare,
    headers: { 'idempotency-key': KEY('race-create') },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const mediaId = created.body.data.media.id;
  const keys = await app.mediaService.serverObjectKeys(mediaId);
  await bucket.store.putObject(keys.rawRef, jpeg, 'image/jpeg');
  assert.equal(bucket.calls.puts.length, 1, '客户端直传算一次 put');

  const record = await mediaStore.getMedia(mediaId);
  const actor = { ownerId: record.ownerId, authEpoch: 1, sessionRef: '12121212-1212-4212-8212-121212121212' };

  // ① 挂住 complete 的衍生件 putObject：此刻它已读过快照（rev 1 / initiated），还没写回库。
  const gate = bucket.arm();
  const lateComplete = app.mediaService.completeUpload({
    actor,
    mediaId,
    ifMatch: '"1"',
    input: { sha256: declare.sha256, bytes: declare.bytes },
    idempotencyKey: KEY('race-complete'),
  });
  const derivativeKey = await gate.enteredPromise;
  assert.notEqual(derivativeKey, keys.rawRef, '窗口里落下的是衍生件，不是原图键');

  // ② 窗口内：删除成功落库（rev 1 → 2，state=deleted，对象键清空）。
  const deleted = await call(app, 'DELETE', `/api/v1/media/${mediaId}`, token, {
    headers: { 'idempotency-key': KEY('race-delete'), 'if-match': '"1"' },
  });
  assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
  const inWindow = await mediaStore.getMedia(mediaId);
  assert.equal(inWindow.state, 'deleted');
  assert.equal(inWindow.revision, 2);

  // ③ 放行迟到的 complete：必须失败，失败码可判定（不是 202 + ready）。
  gate.release();
  const outcome = await lateComplete.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  assert.equal(outcome.ok, false, '迟到的 complete 不得返回成功');
  assert.equal(outcome.error.code, 'OBJECT_UNAVAILABLE');
  assert.match(outcome.error.message, /已被删除/);

  // ④ 真行仍是 deleted / rev 2：没有被整行覆写回 ready。
  const after = await mediaStore.getMedia(mediaId);
  assert.equal(after.state, 'deleted', '已删除的媒体不得被迟到的 complete 复活');
  assert.equal(after.revision, 2);
  assert.equal(after.rawRef, null);
  assert.equal(after.derivativeRef, null);

  // ⑤ 窗口里落下的衍生件已被回收：不留没有登记册行承载的孤儿对象。
  assert.ok(bucket.calls.deletes.includes(derivativeKey), '迟到的衍生件必须被删掉');
  assert.equal(await bucket.store.getObject(derivativeKey), null);

  // ⑥ 对外读数一致：GET 仍是 deleted。
  const projection = await call(app, 'GET', `/api/v1/media/${mediaId}`, token);
  assert.equal(projection.status, 200, JSON.stringify(projection.body));
  assert.equal(projection.body.data.state, 'deleted');
  assert.equal(projection.body.data.revision, 2);

  t.diagnostic(`迟到的 complete ⇒ ${outcome.error.code}「${outcome.error.message}」；`
    + `库内 state=${after.state}/rev=${after.revision}；衍生件 ${derivativeKey.slice(0, 18)}… 已回收`
    + `（put=${bucket.calls.puts.length} delete=${bucket.calls.deletes.length}）`);
});

// ---------------------------------------------------------------------------
// 监工 1022-0203 / 1022-0541 / 1022-0659 三轮 P1（同一阻塞项）：
//
//   「CAS=0 失利者清理派生物时桶删除返回 false，随后父记录并发删除清空引用，
//     仍会丢失可恢复清理的持久线索。」
//
// 场景与上一测同源（挂起衍生件 putObject → 窗口内 delete 成功），差别只在于**桶侧删不掉**：
// `deleteObject(衍生键)` 返回 `false`（= 未能确认删除，不是成功）。此时：
//   - CAS=0 那一侧只剩一份进程内快照，它**没有任何持久化落点**（条件写 0 行 ⇒ 一个字节都不写）；
//   - 真行已被并发 delete 清空 `rawRef`/`derivativeRef`（`deleted` 是软删，行还在，但引用没了）；
//   ⇒ `cleanupOrphans` 只能枚举真行，永远找不到这个刚落下、且**未确认删除**的衍生对象。
//   一次失败的尽力删除就把「可重试的清理依据」永久丢掉了。
//
// 修法（不复活媒体、不覆盖新版本）：把「待清理」意图**先**落到独立于父行存活的清理台账
// （`public.media_object_cleanup`，迁移 0029 ⇒ 端口 `saveObjectCleanup`/`listObjectCleanup`/
// `deleteObjectCleanup`），**再**尝试桶删除；只有桶删除确认成功才删该行，父行被删也不级联。
// 重试器（`cleanupOrphans`）按清理行扫描，天然幂等。
// ---------------------------------------------------------------------------
test('GY-R28 W12 竞态（监工 1022-0659 轮 P1）：CAS=0 失利者删不掉衍生件时，清理线索不得丢', async (t) => {
  const mediaStore = createMemoryMediaStore({ now: () => NOW_MS });
  const bucket = gatedObjectStore();
  const jpeg = jpegWithExif();
  const declare = { purpose: 'weed_recognition', mime: 'image/jpeg', bytes: jpeg.length, sha256: sha256Hex(jpeg) };
  const app = makeApp({ mediaStore, objectStore: bucket.store });
  t.after(async () => { await app.close(); });
  const token = await login(app, 'orphan-owner');

  // ① 正常建行 + 客户端直传原图。
  const created = await call(app, 'POST', '/api/v1/media/uploads', token, {
    payload: declare,
    headers: { 'idempotency-key': KEY('orphan-create') },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const mediaId = created.body.data.media.id;
  const keys = await app.mediaService.serverObjectKeys(mediaId);
  await bucket.store.putObject(keys.rawRef, jpeg, 'image/jpeg');

  const record = await mediaStore.getMedia(mediaId);
  const actor = { ownerId: record.ownerId, authEpoch: 1, sessionRef: '34343434-3434-4434-8434-343434343434' };

  // ② 挂住衍生件 putObject：complete 此刻已读过快照（rev 1 / initiated），还没写回。
  const gate = bucket.arm();
  const lateComplete = app.mediaService.completeUpload({
    actor,
    mediaId,
    ifMatch: '"1"',
    input: { sha256: declare.sha256, bytes: declare.bytes },
    idempotencyKey: KEY('orphan-complete'),
  });
  const derivativeKey = await gate.enteredPromise;

  // ③ 窗口内 delete 成功落库：真行 deleted / rev 2 / 两个对象键都清空。
  const deleted = await call(app, 'DELETE', `/api/v1/media/${mediaId}`, token, {
    headers: { 'idempotency-key': KEY('orphan-delete'), 'if-match': '"1"' },
  });
  assert.equal(deleted.status, 202, JSON.stringify(deleted.body));

  // ④ 让「删掉衍生键」这件事**无法确认**（端口返回 false），再放行迟到的 complete。
  bucket.failDelete(derivativeKey);
  gate.release();
  const outcome = await lateComplete.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  assert.equal(outcome.ok, false, 'CAS=0 的迟到 complete 不得返回成功');
  assert.equal(outcome.error.code, 'OBJECT_UNAVAILABLE');
  assert.ok(bucket.calls.failedDeletes.includes(derivativeKey), '本次复现要求桶删除确实返回了 false');

  // ⑤ 线索无处可依：父行已被并发删除清空引用（这是本 P1 的「丢线索」成因，不是断言对象）。
  const tombstone = await mediaStore.getMedia(mediaId);
  assert.equal(tombstone.state, 'deleted');
  assert.equal(tombstone.rawRef, null);
  assert.equal(tombstone.derivativeRef, null);

  // ⑥ 桶侧仍删不掉时清扫一次：本次不收敛是**允许**的，但「可重试的清理线索」必须留存。
  //    改前这里 pendingObjects=0 / removedObjects=0 / remainingObjects=1 —— 线索已经丢了。
  const blocked = await app.mediaService.cleanupOrphans();
  t.diagnostic(`桶删除不可用时清扫读数：removed=${blocked.removedObjects} `
    + `pending=${blocked.pendingObjects} remaining=${blocked.remainingObjects}`);
  assert.equal(blocked.removedObjects, 0, '桶侧删不掉时不得报告已回收');
  assert.equal(
    blocked.pendingObjects,
    1,
    '未确认删除的衍生对象必须留下可重试的清理线索（pendingObjects 不得为 0）',
  );
  assert.equal(blocked.remainingObjects, 1, '对象此刻确实还在桶里（复现前提）');
  assert.notEqual(await bucket.store.getObject(derivativeKey), null, '对象此刻确实未被删掉（复现前提）');

  // ⑦ 恢复桶删除能力后重试：必须收敛到「对象真的没了、清理行也清空」。
  bucket.unfailDelete();
  const healed = await app.mediaService.cleanupOrphans();
  t.diagnostic(`恢复后清扫读数：removed=${healed.removedObjects} pending=${healed.pendingObjects} `
    + `remaining=${healed.remainingObjects}`);
  assert.equal(healed.removedObjects, 1, '恢复桶删除能力后，重试必须真的把这个对象删掉');
  assert.equal(healed.pendingObjects, 0);
  assert.equal(await bucket.store.getObject(derivativeKey), null, '重试后衍生对象必须已从桶里消失');
  assert.deepEqual(await mediaStore.listObjectCleanup(), [], '确认删除成功后清理行必须被清掉（不留残行）');

  // ⑧ 再扫一次：幂等（没有可删行时不做任何重复删除，也不新造行）。
  const again = await app.mediaService.cleanupOrphans();
  assert.equal(again.removedObjects, 0, '重复清扫不得重复计数');
  assert.equal(again.pendingObjects, 0);
  assert.deepEqual(await mediaStore.listObjectCleanup(), []);
});

test('GY-R28 W12 清理台账：成功删除不留行；同一对象重复登记只留一行且尝试次数递增（幂等）', async () => {
  const store = createMemoryMediaStore({ now: () => NOW_MS });
  const mediaId = '91919191-9191-4191-8191-919191919191';

  await store.saveObjectCleanup({ mediaId, objectRef: 'obj_cleanup_a', reason: 'cas_mismatch' }, NOW_MS);
  await store.saveObjectCleanup({ mediaId, objectRef: 'obj_cleanup_a', reason: 'cas_mismatch' }, NOW_MS + 1);
  const rows = await store.listObjectCleanup();
  assert.equal(rows.length, 1, '同一对象键只允许一行（重试器按行扫描，不能越重试越多）');
  assert.equal(rows[0].objectRef, 'obj_cleanup_a');
  assert.equal(rows[0].mediaId, mediaId);
  assert.equal(rows[0].reason, 'cas_mismatch', '原因要持久化，供人判断为何要清');
  assert.equal(rows[0].attempts, 2, '每次重新登记即一次尝试，次数要累计');

  assert.equal(await store.deleteObjectCleanup('obj_cleanup_a'), 1);
  assert.equal(await store.deleteObjectCleanup('obj_cleanup_a'), 0, '重复删除返回 0（幂等）');
  assert.deepEqual(await store.listObjectCleanup(), []);
});
