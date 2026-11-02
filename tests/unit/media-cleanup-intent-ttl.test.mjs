// GY-R72 媒体清理台账 · 预签名上传句柄 TTL 闸门（单测）。
//
// 缺陷（本片的存在理由）：上传句柄的寿命是 `MEDIA_INITIATED_TTL_MS`（24h）。删除/拒收时对象通常
// **还没被 PUT**，而对象存储对「键不存在」的删除返回**已确认成功**（内存版恒 `true`，S3 版 404 也算
// 成功）。于是 `dropObjects` 走「确认删除成功 ⇒ 清引用 + 删台账行」时，会把这行清理线索一起删掉；
// 而那张**仍然有效**的句柄随后完成 PUT，桶里就多出一个对象，三条收敛路径全都扫不到它：
//   · `expireInitiated` 只扫 `initiated`（该行已是 `deleted`）；
//   · `cleanupOrphans` 第一轮只扫 `rejected`/`deleted` 行，且该行的 `object_ref_cipher` 已被清空；
//   · `cleanupOrphans` 第二轮只扫台账行 —— 台账行恰好已被 forget 掉。
//
// 修法：台账行记下 `createdAt`（行上**首次**登记时刻），删除路径与清扫路径都以
// `createdAt + MEDIA_INITIATED_TTL_MS > now` 为闸门 —— 句柄还活着就**不**删台账行，清扫也不碰它
// （且不累加 `attempts`）；到期后照旧「删对象、删行、`removedObjects += 1`」。
//
// 断言口径（T1–T4，逐条对应验收）：
//   T1 建行后**不** PUT 直接删 ⇒ 行 `deleted` + 两个对象键皆 NULL，但**台账行仍在**；
//   T2 TTL 内清扫 ⇒ 台账行仍在、`attempts` **原地不动**（不是 0→1），且不计 removed/pending；
//   T3 时钟越过 `createdAt + TTL` 后用**同一** rawRef 迟到 PUT，再清扫 ⇒ 对象消失、行消失、removed ≥ 1；
//   T4 对象本来就不存在（正常删除路径），越过 TTL 后台账行**也会**被删（收敛不倒退）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createSubstituteObjectStore } from '../../services/api/src/media/object-store.ts';
import { createMemoryMediaStore } from '../../services/api/src/media/store.ts';
import { MEDIA_INITIATED_TTL_MS } from '../../packages/media/constants.mjs';
import { sha256Hex } from '../../packages/media/validate.mjs';
import { jpegWithExif } from '../media/_fixtures.mjs';

const NOW_MS = 1_700_000_000_000;

/** 可推进的假时钟：服务与 store **共用**同一个 `clock.ms`，因此「句柄寿命」与「台账 createdAt」同源。 */
function makeWorld() {
  const clock = { ms: NOW_MS };
  const mediaStore = createMemoryMediaStore({ now: () => clock.ms });
  const bucket = createSubstituteObjectStore();
  const app = buildApp({
    config: { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), executionMode: 'stub' },
    mediaObjectStore: bucket,
    mediaStore,
    now: () => new Date(clock.ms),
  });
  return { clock, mediaStore, bucket, app };
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

const jpeg = jpegWithExif();
const DECLARE = { purpose: 'weed_recognition', mime: 'image/jpeg', bytes: jpeg.length, sha256: sha256Hex(jpeg) };

/** 建行（`initiated`，拿到 upload 句柄）但**不** PUT —— 这正是缺陷的触发场景。 */
async function declareOnly(world, token, name) {
  const created = await call(world.app, 'POST', '/api/v1/media/uploads', token, {
    payload: DECLARE,
    headers: { 'idempotency-key': `media-ttl-${name}-0000` },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const mediaId = created.body.data.media.id;
  const keys = await world.app.mediaService.serverObjectKeys(mediaId);
  return { mediaId, rawRef: keys.rawRef };
}

// ---------------------------------------------------------------------------
// T1：建行后立刻删除（**不** PUT）⇒ 行没了引用、桶里也没有对象，但台账行**必须留下**。
//     改前这里台账行会被一起删掉（`dropObjects` 的 `forgetCleanupIntent`），而句柄还活着。
// ---------------------------------------------------------------------------
test('T1 建行后不 PUT 直接删除：行清空引用但清理台账行仍在（句柄未失效）', async (t) => {
  const world = makeWorld();
  t.after(async () => { await world.app.close(); });
  const token = await login(world.app, 'ttl-t1');

  const { mediaId, rawRef } = await declareOnly(world, token, 't1');
  assert.equal(await world.bucket.objectCount(), 0, '复现前提：对象此刻确实还没被 PUT');

  const deleted = await call(world.app, 'DELETE', `/api/v1/media/${mediaId}`, token, {
    headers: { 'idempotency-key': 'media-ttl-t1-delete-0000', 'if-match': '"1"' },
  });
  assert.equal(deleted.status, 202, JSON.stringify(deleted.body));

  const record = await world.mediaStore.getMedia(mediaId);
  assert.equal(record.state, 'deleted');
  assert.equal(record.rawRef, null, 'object_ref_cipher 必须已清空（引用不再可达）');
  assert.equal(record.derivativeRef, null);

  const ledger = await world.mediaStore.listObjectCleanup();
  t.diagnostic(`T1 台账行=${JSON.stringify(ledger)}`);
  assert.equal(ledger.length, 1, '句柄还活着 ⇒ 清理台账行不得被 forget（否则迟到 PUT 造出的对象无人清扫）');
  assert.equal(ledger[0].objectRef, rawRef);
  assert.equal(ledger[0].mediaId, mediaId);
  assert.equal(ledger[0].reason, 'owner_delete');
  assert.equal(ledger[0].createdAt, NOW_MS, 'createdAt 必须是登记时刻本身（不是稍后某次 upsert 的 updated_at）');
  assert.equal(await world.bucket.objectCount(), 0, '桶里确实没有对象（删除是幂等确认，不是真的移除）');
});

// ---------------------------------------------------------------------------
// T2：TTL 内的清扫 ⇒ 台账行仍在、`attempts` 原地不动，且不计入 removed/pending。
//     改前（或去掉闸门）这里会「删对象 → 删行」，把句柄寿命内的清理线索提前销账。
// ---------------------------------------------------------------------------
test('T2 TTL 内清扫：台账行仍在且 attempts 原地不动（不计 removed/pending）', async (t) => {
  const world = makeWorld();
  t.after(async () => { await world.app.close(); });
  const token = await login(world.app, 'ttl-t2');

  const { mediaId, rawRef } = await declareOnly(world, token, 't2');
  const deleted = await call(world.app, 'DELETE', `/api/v1/media/${mediaId}`, token, {
    headers: { 'idempotency-key': 'media-ttl-t2-delete-0000', 'if-match': '"1"' },
  });
  assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
  const before = await world.mediaStore.listObjectCleanup();
  assert.equal(before.length, 1, 'T1 的产出：台账行还在');
  assert.equal(before[0].attempts, 1);

  // 时钟仅推进 1 小时（仍远在 24h 句柄寿命之内）。
  world.clock.ms = NOW_MS + 60 * 60 * 1000;
  const swept = await world.app.mediaService.cleanupOrphans();
  t.diagnostic(`T2 清扫读数：removed=${swept.removedObjects} pending=${swept.pendingObjects} `
    + `remaining=${swept.remainingObjects}`);

  const after = await world.mediaStore.listObjectCleanup();
  t.diagnostic(`T2 台账行=${JSON.stringify(after)}`);
  assert.equal(after.length, 1, '未到期的台账行不得被清扫掉（句柄还能把对象写回来）');
  assert.equal(after[0].objectRef, rawRef);
  assert.equal(after[0].attempts, 1, '跳过时不得累加 attempts（不是 0→1，是原地不动）');
  assert.equal(after[0].createdAt, NOW_MS, 'createdAt 不因清扫而漂移（闸门依赖它稳定）');
  assert.equal(swept.removedObjects, 0, '没删掉任何对象，不得报告已回收');
  assert.equal(swept.pendingObjects, 0, '未到期 ≠ 删除失败，不得计入 pending');

  // 幂等：连扫三次读数完全一致。
  for (let i = 0; i < 2; i += 1) {
    const again = await world.app.mediaService.cleanupOrphans();
    assert.equal(again.removedObjects, 0);
    assert.equal(again.pendingObjects, 0);
    assert.equal((await world.mediaStore.listObjectCleanup())[0].attempts, 1);
  }
});

// ---------------------------------------------------------------------------
// T3：时钟越过 `createdAt + TTL` 后，用**同一**张句柄完成 PUT（迟到上传），再清扫 ⇒
//     对象必须被删掉（`objectCount` 减少）、台账行消失、`removedObjects ≥ 1`。
// ---------------------------------------------------------------------------
test('T3 过 TTL 后迟到 PUT 的对象会被清扫掉（行消失、removed ≥ 1）', async (t) => {
  const world = makeWorld();
  t.after(async () => { await world.app.close(); });
  const token = await login(world.app, 'ttl-t3');

  const { mediaId, rawRef } = await declareOnly(world, token, 't3');
  const deleted = await call(world.app, 'DELETE', `/api/v1/media/${mediaId}`, token, {
    headers: { 'idempotency-key': 'media-ttl-t3-delete-0000', 'if-match': '"1"' },
  });
  assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
  assert.equal((await world.mediaStore.listObjectCleanup()).length, 1);

  // 客户端手里那张句柄仍然有效——越过 TTL 之后才把字节 PUT 上去（这就是「删了还留一份」）。
  world.clock.ms = NOW_MS + MEDIA_INITIATED_TTL_MS + 1000;
  await world.bucket.putObject(rawRef, jpeg, 'image/jpeg');
  const beforeCount = await world.bucket.objectCount();
  assert.equal(beforeCount, 1, '复现前提：孤儿对象此刻确实躺在桶里');

  const swept = await world.app.mediaService.cleanupOrphans();
  t.diagnostic(`T3 清扫读数：removed=${swept.removedObjects} pending=${swept.pendingObjects} `
    + `remaining=${swept.remainingObjects}`);

  const afterCount = await world.bucket.objectCount();
  assert.ok(afterCount < beforeCount, `孤儿对象必须被删掉（objectCount ${beforeCount} → ${afterCount}）`);
  assert.equal(afterCount, 0);
  assert.equal(await world.bucket.getObject(rawRef), null);
  assert.ok(swept.removedObjects >= 1, '报告里必须计入这次回收');
  assert.deepEqual(await world.mediaStore.listObjectCleanup(), [], '到期后行必须被删掉（收敛）');
});

// ---------------------------------------------------------------------------
// T4：对象本来就不存在（正常删除路径），越过 TTL 后台账行**也会**被删 —— 收敛不倒退。
//     这是对 T1/T2「保留行」的收益边界的守门：只是延后，不是永不清理。
// ---------------------------------------------------------------------------

test('T4 对象本就不存在时，越过 TTL 后台账行同样会被删掉（收敛不倒退）', async (t) => {
  const world = makeWorld();
  t.after(async () => { await world.app.close(); });
  const token = await login(world.app, 'ttl-t4');

  const { mediaId } = await declareOnly(world, token, 't4');
  const deleted = await call(world.app, 'DELETE', `/api/v1/media/${mediaId}`, token, {
    headers: { 'idempotency-key': 'media-ttl-t4-delete-0000', 'if-match': '"1"' },
  });
  assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
  assert.equal(await world.bucket.objectCount(), 0, '复现前提：桶里本来就没有这个对象');
  assert.equal((await world.mediaStore.listObjectCleanup()).length, 1);

  world.clock.ms = NOW_MS + MEDIA_INITIATED_TTL_MS + 1000;
  const swept = await world.app.mediaService.cleanupOrphans();
  t.diagnostic(`T4 清扫读数：removed=${swept.removedObjects} pending=${swept.pendingObjects} `
    + `remaining=${swept.remainingObjects}`);

  assert.deepEqual(await world.mediaStore.listObjectCleanup(), [], '到期后即便对象本不存在，台账行也必须被删掉');
  assert.ok(swept.removedObjects >= 1, '幂等删除也算已确认删除 ⇒ 计入 removedObjects');
  assert.equal(await world.bucket.objectCount(), 0);

  // 再扫一次：幂等（无行可删，不再新造行）。
  const again = await world.app.mediaService.cleanupOrphans();
  assert.equal(again.removedObjects, 0);
  assert.equal(again.pendingObjects, 0);
  assert.deepEqual(await world.mediaStore.listObjectCleanup(), []);
});

// ---------------------------------------------------------------------------
// T6：「保留到 TTL」不得被误实现成「永远保留」—— 台账行不会无限增长。
//     ① 一条只 `initiate`、从不 PUT、也从未被删除的句柄：根本不该产生台账行（零增长）；
//     ② 若台账里确实有这种对象不存在的行，越过 TTL 后一轮清扫必须把它删掉（`deleteObject` 对
//        不存在的键返回已确认 ⇒ 删行 + 计一次回收），而不是永久沉淀。
// ---------------------------------------------------------------------------
test('T6 台账行不会无限增长：从未删除的句柄不产生行，已存在的行过 TTL 后必被清掉', async (t) => {
  const world = makeWorld();
  t.after(async () => { await world.app.close(); });
  const token = await login(world.app, 'ttl-t6');

  // ① 只建行、不 PUT、不删除。
  const { mediaId, rawRef } = await declareOnly(world, token, 't6');
  assert.deepEqual(await world.mediaStore.listObjectCleanup(), [], '从未删除 ⇒ 台账里本来就不该有行');

  world.clock.ms = NOW_MS + MEDIA_INITIATED_TTL_MS + 1000;
  const swept = await world.app.mediaService.cleanupOrphans();
  t.diagnostic(`T6 ① 清扫读数：removed=${swept.removedObjects} pending=${swept.pendingObjects}`);
  assert.deepEqual(await world.mediaStore.listObjectCleanup(), [], '句柄过期也不会凭空长出清理行');
  assert.equal(await world.bucket.objectCount(), 0, '从未 PUT ⇒ 桶里没有对象');

  // ② 手工造一条「对象不存在」的清理行（模拟删除路径留下的线索），确认它会被收敛掉。
  await world.mediaStore.saveObjectCleanup({ mediaId, objectRef: rawRef, reason: 'owner_delete' }, NOW_MS);
  assert.equal((await world.mediaStore.listObjectCleanup()).length, 1);

  const converged = await world.app.mediaService.cleanupOrphans();
  t.diagnostic(`T6 ② 清扫读数：removed=${converged.removedObjects} pending=${converged.pendingObjects}`);
  assert.deepEqual(await world.mediaStore.listObjectCleanup(), [], '对象不存在 ⇒ 幂等确认删除 ⇒ 行必须被清掉');
  assert.ok(converged.removedObjects >= 1, '幂等删除也算已确认删除');
  assert.equal(await world.bucket.objectCount(), 0);
});
