// GY-R74 · 媒体保留期限回收（单测）。
//
// 缺陷（本片的存在理由）：`expireInitiated()` 只扫 `initiated`（`service.ts:1412`），`cleanupOrphans()`
// 只扫 `rejected`/`deleted`（`service.ts:1424`）——**`ready` 行没有任何扫描面**。而 `expiresAt` 在建行时
// 被写成「建行 + 24h」（上传句柄窗口），完成上传时既不清空也不重算，于是每条 `ready` 媒体行都带着一个
// 早已过去 24h 的假期限、却永远不会被任何清理路径碰到：用户为识别上传的照片，字节与数据库行一直留着。
//
// 本片口径（逐字依据见 `services/api/src/media/retention.ts` 文件头）：
//   - `expiresAt` = 该行对象的**保留截止时刻**（绝对时刻）；`null` = **无日历到期**；
//   - 活账号的私有媒体「原则保存至注销」（`docs/implementation-requirements.md:277`）⇒ 完成上传时置 `null`；
//   - 注销受理后「在线个人数据／私有原媒体 7 日内删除」（同文件 `:278`）⇒ 注销链写 `now + 7×24h`；
//   - 仓内**没有**「活跃账号的 ready 媒体按 N 天老化」的成文数字 ⇒ 本文件里出现的唯一期限是上面那两条。
//
// 断言口径：
//   [1] `ready` 到期 ⇒ `reclaimExpired()` 推进 `ready → deleting → deleted` + `failure_code=retention_expired`，
//       同一轮 `cleanupOrphans()` 把两个对象键删净、台账清空，三段读数齐备；
//   [2] `expiresAt === null`（活账号）与**未到期**的 `ready` 行一条都不许动（本条是 NC1 的判定面）；
//   [3] 分账可区分：过期回收的三段与孤儿重试的三段**不是同一个数**；
//   [4] 过期回收撤销的授权也进分账（`retention.grants`），且授权表里确实撤销了；
//   [5] `purgeRetiredRows()` 只物理删「对象引用已清空」的终态行；还持有引用的行计入
//       `rowsRetainedByReference`（残余，⛔ 不是已清）；
//   [6] 驱动层全链：到期 ready 行 ⇒ `reclaimed=1`、对象删净、终态行物理删除、退出码 0；
//   [7] 只实现旧三方法（R74 之前的端口形状）⇒ 驱动层退 2 + `MISSING_MEDIA_PORT`（NC2 的判定面）；
//   [8] 注销链：`purgeOwnedMedia()` 把该 owner 的 ready 行截止时刻写成 `now + 7×24h`（逐字依据那条），
//       未到期不回收、到期才回收。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSubstituteObjectStore } from '../../services/api/src/media/object-store.ts';
import { approveRealMediaWiring, createAppMediaService } from '../../services/api/src/media/service.ts';
import { createMemoryMediaStore } from '../../services/api/src/media/store.ts';
import {
  MEDIA_ONLINE_RETENTION_DAYS,
  MEDIA_ONLINE_RETENTION_MS,
  MEDIA_RETENTION_EXPIRED,
} from '../../services/api/src/media/retention.ts';
import {
  MEDIA_PURGE_EXIT,
  MEDIA_PURGE_PHASES,
  runMediaPurge,
} from '../../services/api/src/media/purge-driver.ts';
import { MEDIA_INITIATED_TTL_MS } from '../../packages/media/constants.mjs';

const AT = Date.parse('2026-10-31T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const OWNER = '0193a0f0-0000-4000-8000-00000000e001';
const TOKEN_SECRET = 'synthetic-not-a-real-signing-key';

let seq = 0;
/** 每行一个稳定但互不相同的 uuid（`purge_owner_media(uuid)` 与内存实现的键都要求 uuid 形状）。 */
function uuid(tag) {
  seq += 1;
  return `0193a0f0-0000-4000-8000-${tag}${String(seq).padStart(11, '0')}`;
}

/**
 * 装配：可推进的假时钟 + 内存持久化端口 + 替身对象存储。
 *
 * `kind: 's3_compatible'` 是为了过 `createAppMediaService()` 的 real 闸门（那一步只认 `kind`，
 * 见 `service.ts:601`）；删除仍走替身（内存），所以「这一轮对象真的没了」可以被断言、且零外呼。
 */
function makeWorld() {
  const clock = { ms: AT };
  const persistence = createMemoryMediaStore({ now: () => clock.ms });
  const substitute = createSubstituteObjectStore({ note: 'R74 单测替身：保留期限回收（零外呼）' });
  const objectStore = { ...substitute, kind: 's3_compatible' };
  const service = createAppMediaService({
    executionMode: 'real',
    objectStore,
    tokenSecret: TOKEN_SECRET,
    persistence,
    now: () => new Date(clock.ms),
    realMediaApproval: approveRealMediaWiring({ reason: 'R74 单测：保留期限回收（替身做删除，零外呼）' }),
  });
  return { clock, persistence, substitute, objectStore, service };
}

/** 一条媒体行（服务层视图）。默认是「活账号的私有 ready 媒体」：`expiresAt === null`。 */
function record(overrides = {}) {
  const id = uuid('a');
  return {
    id,
    ownerId: OWNER,
    revision: 3,
    purpose: 'weed_recognition',
    mime: 'image/jpeg',
    bytes: 3,
    duration_ms: null,
    sha256: 'a'.repeat(64),
    state: 'ready',
    failure_code: null,
    rawRef: `objects/raw-${id}`,
    derivativeRef: `objects/der-${id}`,
    createdAt: AT,
    updatedAt: AT,
    expiresAt: null,
    ...overrides,
  };
}

/** 把一条媒体行的两个对象键真的放进（替身）桶里——只有「桶里确实有东西」时删除断言才有意义。 */
async function putObjects(world, row) {
  await world.substitute.putObject(row.rawRef, new Uint8Array([1, 2, 3]), 'image/jpeg');
  if (row.derivativeRef !== null) {
    await world.substitute.putObject(row.derivativeRef, new Uint8Array([4, 5, 6]), 'image/jpeg');
  }
}

// ---------------------------------------------------------------------------- [1]

test('[1] ready 到期：推进到 deleted + retention_expired，同轮把两个对象键删净、三段读数齐备', async () => {
  const world = makeWorld();
  const row = await (async () => {
    const due = record({ expiresAt: AT - 1 });
    await putObjects(world, due);
    await world.persistence.createMedia(due);
    return due;
  })();
  assert.equal(await world.substitute.objectCount(), 2, '前提：桶里此刻确实有两个对象');

  const { reclaimed } = await world.service.reclaimExpired();

  assert.equal(reclaimed, 1, '到期且落库成功才算回收了一条');
  const afterReclaim = await world.persistence.getMedia(row.id);
  assert.equal(afterReclaim.state, 'deleted', '状态机的路径是 ready → deleting → deleted，不能停在中间态');
  assert.equal(afterReclaim.failure_code, MEDIA_RETENTION_EXPIRED, '终止原因必须能区分「过期回收」与「孤儿」');
  assert.ok(afterReclaim.revision > row.revision, '状态推进必须走条件写（revision 递增）');
  assert.equal(
    await world.substitute.objectCount(),
    2,
    '回收这一段只推进状态、不删对象：删除只由 cleanupOrphans 做（全仓一份删除实现）',
  );

  const swept = await world.service.cleanupOrphans();

  assert.equal(swept.removedObjects, 2, 'raw + derivative 两个键都被确认删除');
  assert.equal(swept.pendingObjects, 0);
  assert.equal(await world.substitute.objectCount(), 0, '桶里确实空了（不是「记成删了」）');
  assert.deepEqual(swept.retention, { objects: 2, pending: 0, grants: 0 }, '这三段就是「过期回收」的那两笔');
  const final = await world.persistence.getMedia(row.id);
  assert.equal(final.rawRef, null);
  assert.equal(final.derivativeRef, null);

  // 台账行按 R72 的句柄闸门留到「登记时刻 + 上传窗口」：句柄还可能被 PUT，清理线索不许提前丢。
  assert.equal(
    (await world.persistence.listObjectCleanup()).length,
    2,
    '窗口内的台账行是重试依据，⛔ 不是「没删干净」',
  );
  world.clock.ms = AT + MEDIA_INITIATED_TTL_MS + 1;
  await world.service.cleanupOrphans();
  assert.deepEqual(await world.persistence.listObjectCleanup(), [], '窗口过后台账行才收敛为空');
});

// ---------------------------------------------------------------------------- [2]

test('[2] expiresAt === null（活账号）与未到期的 ready 行：一条都不许回收（NC1 判定面）', async () => {
  const world = makeWorld();
  const live = record({ expiresAt: null }); // 「私有…原则保存至注销」⇒ 无日历到期
  const notYet = record({ expiresAt: AT + DAY_MS }); // 注销链写下的 7 日截止时刻，还没到
  await putObjects(world, live);
  await putObjects(world, notYet);
  await world.persistence.createMedia(live);
  await world.persistence.createMedia(notYet);

  const { reclaimed } = await world.service.reclaimExpired();

  assert.equal(
    reclaimed,
    0,
    'expiresAt 为 null 或无到期时刻的行绝不能被当成「到期」——否则活账号的照片会被无故删掉',
  );
  assert.equal((await world.persistence.getMedia(live.id)).state, 'ready');
  assert.equal((await world.persistence.getMedia(live.id)).failure_code, null);
  assert.equal((await world.persistence.getMedia(notYet.id)).state, 'ready');
  assert.equal(await world.substitute.objectCount(), 4, '对象一个都不许被碰');

  // 时钟推过截止时刻之后，同一条行才进入回收路径（证明上一条的「不动」不是因为判据失效）。
  world.clock.ms = AT + DAY_MS + 1;
  const later = await world.service.reclaimExpired();
  assert.equal(later.reclaimed, 1, '只有 notYet 到期；live 仍然无期限');
  assert.equal((await world.persistence.getMedia(live.id)).state, 'ready', '无期限行永远不老化');
  assert.equal((await world.persistence.getMedia(notYet.id)).state, 'deleted');
});

// ---------------------------------------------------------------------------- [3]

test('[3] 分账：过期回收三段与孤儿重试三段不是同一个数（⛔ 不许混成一个读数）', async () => {
  const world = makeWorld();
  // 一条到期的 ready 行（走 reclaimExpired ⇒ failure_code=retention_expired）
  const due = record({ expiresAt: AT - 1 });
  // 一条孤儿：被拒收的行，对象键还在（它的 failure_code 不是 retention_expired）
  const orphan = record({ state: 'rejected', failure_code: 'REJECTED_BY_OWNER', expiresAt: AT - 1 });
  await putObjects(world, due);
  await putObjects(world, orphan);
  await world.persistence.createMedia(due);
  await world.persistence.createMedia(orphan);

  assert.equal((await world.service.reclaimExpired()).reclaimed, 1, '只有 ready 行会被保留期限回收');
  const swept = await world.service.cleanupOrphans();

  assert.equal(swept.removedObjects, 4, '总共四个对象键都删掉了');
  assert.deepEqual(
    swept.retention,
    { objects: 2, pending: 0, grants: 0 },
    '过期回收只认那条 retention_expired 的行（2 个键）；孤儿那 2 个键不算',
  );
  assert.equal(swept.removedObjects - swept.retention.objects, 2, '差值就是孤儿重试的两笔');
});

// ---------------------------------------------------------------------------- [4]

test('[4] 过期回收撤销的授权进分账（retention.grants），且授权表里确实撤销了', async () => {
  const world = makeWorld();
  const due = record({ expiresAt: AT - 1, purpose: 'community_image' });
  await putObjects(world, due);
  await world.persistence.createMedia(due);
  await world.persistence.createGrant({
    grantId: uuid('b'),
    tokenHash: 'b'.repeat(64),
    requesterId: '0193a0f0-0000-4000-8000-0000000000ff',
    sessionRef: 'sess-r74',
    requesterAuthEpoch: 1,
    mediaId: due.id,
    mediaRevision: due.revision,
    contentRef: { type: 'post', id: '0193a0f0-0000-4000-8000-0000000000aa', revision: 1 },
    slot: 'attachment',
    authorRevision: null,
    expiresAt: AT + DAY_MS,
    revokedAt: null,
  });
  assert.equal(await world.persistence.countGrants(), 1);

  await world.service.reclaimExpired();
  const swept = await world.service.cleanupOrphans();

  assert.equal(swept.revokedGrants, 1, '删除路径上的授权必须撤销（不是留着等过期）');
  assert.deepEqual(swept.retention, { objects: 2, pending: 0, grants: 1 }, '撤销数也归到「过期回收」那两笔');
  assert.equal(await world.persistence.countGrants(), 0, '授权表里确实没了');
});

// ---------------------------------------------------------------------------- [5]

test('[5] purgeRetiredRows()：只删「引用已清空」的终态行；还持有引用的行计入残余', async () => {
  const world = makeWorld();
  // ① 终态且引用已清空（真实删除路径走完的样子）⇒ 可以物理删
  const settled = record({ state: 'deleted', rawRef: null, derivativeRef: null, failure_code: MEDIA_RETENTION_EXPIRED });
  // ② 终态但仍持有对象引用（上一轮桶删除未确认，台账行在重试）⇒ 不许删行，否则丢清理线索
  const stillHeld = record({ state: 'deleted', failure_code: 'OBJECT_DELETE_PENDING' });
  await world.persistence.createMedia(settled);
  await world.persistence.createMedia(stillHeld);

  const purged = await world.service.purgeRetiredRows();

  assert.equal(purged.ownersScanned, 1, '两条行同属一个 owner');
  assert.equal(purged.ownersPurged, 1);
  assert.equal(purged.rowsDeleted, 1, '只有引用清空的那条被删');
  assert.equal(purged.rowsRetainedByReference, 1, '还持有对象的行是**残余**，⛔ 不许并进「已删」');
  assert.equal(purged.failedOwners, 0);
  assert.equal(purged.lastFailureCode, null);
  assert.equal(await world.persistence.getMedia(settled.id), null);
  assert.notEqual(await world.persistence.getMedia(stillHeld.id), null, '被引用的行必须还在（台账行才找得回它）');
});

// ---------------------------------------------------------------------------- [6]

test('[6] 驱动层全链：到期 ready 行 ⇒ reclaimed=1、对象删净、终态行物理删除、退出码 0', async () => {
  const world = makeWorld();
  const due = record({ expiresAt: AT - 1 });
  await putObjects(world, due);
  await world.persistence.createMedia(due);

  const report = await runMediaPurge({ mediaService: world.service, now: () => new Date(world.clock.ms) });

  assert.equal(report.exitCode, MEDIA_PURGE_EXIT.OK, JSON.stringify(report.failures));
  assert.deepEqual(report.failures, []);
  assert.equal(report.expired, 0, '「上传窗口过期」与「保留期限到期」是两笔，不许混');
  assert.equal(report.reclaimed, 1);
  assert.equal(report.deleted, 2);
  assert.equal(report.retained, 0);
  assert.deepEqual(report.retention, { objects: 2, pending: 0, grants: 0 });
  assert.equal(report.rowsDeleted, 1, '引用已清空 ⇒ 终态行被物理删除');
  assert.equal(report.rowsRetainedByReference, 0);
  assert.equal(report.failedRowPurges, 0);
  assert.equal(await world.substitute.objectCount(), 0);
  assert.equal(await world.persistence.getMedia(due.id), null);
  assert.equal(MEDIA_PURGE_PHASES.RECLAIM_EXPIRED, 'reclaim-expired');
  assert.equal(MEDIA_PURGE_PHASES.PURGE_RETIRED_ROWS, 'purge-retired-rows');
});

// ---------------------------------------------------------------------------- [7]

test('[7] 只实现旧三方法的端口 ⇒ 退 2 + MISSING_MEDIA_PORT（⛔ 不记成「跑了 0 条」）', async () => {
  const world = makeWorld();
  // R74 之前的端口形状：有 expireInitiated/cleanupOrphans/stats，但没有保留期限两段。
  const oldShape = {
    expireInitiated: () => world.service.expireInitiated(),
    cleanupOrphans: () => world.service.cleanupOrphans(),
    stats: () => world.service.stats(),
  };

  const report = await runMediaPurge({ mediaService: oldShape, now: () => new Date(world.clock.ms) });

  assert.equal(report.exitCode, MEDIA_PURGE_EXIT.CONFIG, '缺端口 = 没跑 ⇒ 2（cron 必须能看见）');
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].code, 'MISSING_MEDIA_PORT');
  assert.equal(report.failures[0].phase, MEDIA_PURGE_PHASES.CONFIG);
  assert.equal(report.reclaimed, 0, '没跑过就不许报读数（0 在这里只表示「没有读数」）');
  assert.equal(report.deleted, 0);

  // 只缺**一个**新方法也必须退 2：否则「R74 的两段没装配」会被静默吞成「跑了 0 条」。
  // 这条正是 NC2 的判定面（把 `'reclaimExpired'` 从必填清单里删掉 ⇒ 这里必须红）。
  for (const missing of ['reclaimExpired', 'purgeRetiredRows']) {
    const partial = { ...oldShape };
    partial.reclaimExpired = () => world.service.reclaimExpired();
    partial.purgeRetiredRows = () => world.service.purgeRetiredRows();
    delete partial[missing];

    const partialReport = await runMediaPurge({ mediaService: partial, now: () => new Date(world.clock.ms) });
    assert.equal(partialReport.exitCode, MEDIA_PURGE_EXIT.CONFIG, `只缺 ${missing} 也必须退 2`);
    assert.equal(partialReport.failures.length, 1);
    assert.equal(partialReport.failures[0].code, 'MISSING_MEDIA_PORT');
    assert.equal(
      partialReport.failures[0].message.includes(missing),
      true,
      `失败读数必须点名缺的是哪个方法（缺 ${missing}），而不是只报一句「端口坏了」`,
    );
  }
});

// ---------------------------------------------------------------------------- [8]

test('[8] 注销链：purgeOwnedMedia() 把 ready 行的截止时刻写成 now + 7×24h；未到期不回收、到期才回收', async () => {
  const world = makeWorld();
  // 私有媒体（不是社区图片）：注销时**不软隐藏**，状态仍是 ready ⇒ 它的收口完全靠 expiresAt 这条期限。
  const row = record({ purpose: 'weed_recognition', expiresAt: null });
  await putObjects(world, row);
  await world.persistence.createMedia(row);

  const purged = await world.persistence.purgeOwnedMedia(OWNER);
  assert.equal(purged.softHidden, 0, '私有媒体不做社区图片那套软隐藏，它靠保留期限收口');
  assert.equal(purged.objectsRegistered, 2, '两个对象键在注销时就被登记进清理台账');

  const afterDeletion = await world.persistence.getMedia(row.id);
  assert.equal(
    afterDeletion.expiresAt,
    AT + MEDIA_ONLINE_RETENTION_MS,
    '注销受理时写下的截止时刻 = 受理时刻 + 7×24h（docs/implementation-requirements.md:278）',
  );
  assert.equal(afterDeletion.state, 'ready', '注销那一刻它还是 ready —— 回收判据必须是 expiresAt，不是状态');
  assert.equal(MEDIA_ONLINE_RETENTION_DAYS, 7);
  assert.equal(MEDIA_ONLINE_RETENTION_MS, 7 * DAY_MS);
  assert.equal(afterDeletion.rawRef, null, '对象引用在注销时就被清空（内容不可达），行本身留到期限届满');

  // 6 天后：还没到期 ⇒ 不回收。
  world.clock.ms = AT + 6 * DAY_MS;
  assert.equal((await world.service.reclaimExpired()).reclaimed, 0, '7 日内不许提前删（期限是上界不是目标）');

  // 第 7 天 + 1ms：到期 ⇒ 回收并物理删行。
  world.clock.ms = AT + 7 * DAY_MS + 1;
  assert.equal((await world.service.reclaimExpired()).reclaimed, 1);
  await world.service.cleanupOrphans();
  const purgeRows = await world.service.purgeRetiredRows();
  assert.equal(purgeRows.rowsDeleted, 1);
  assert.equal(await world.persistence.getMedia(row.id), null, '注销满 7 日后媒体行确实从库里消失');
});
