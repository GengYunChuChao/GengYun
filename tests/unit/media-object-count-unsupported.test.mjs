// GY-R72 · W15（#6 缺口 G1）· #795 返工 —— 「对象枚举」这条**诊断**能力不可用时的读数面
//
// 为什么需要本文件：#795 的阻塞点是——真实 S3 适配器的 `objectCount()` **固定抛** `PROVIDER_UNAVAILABLE`
// （真实清单需要 list 权限，未接线），而 `cleanupOrphans()` 过去在完成对象与台账清理后又无条件调它
// （`services/api/src/media/service.ts` 的「剩余对象数」尾巴），于是**每轮已经成功的清理**都被折成一次
// `cleanup-orphans` 失败并退出 1；`--dry-run` 的 `stats()` 也调同一个固定抛错接口，跑不干净。
//
// 本片的口径（父 agent 定的设计，⛔ 不新增契约错误码）：
//   - 适配器用 `objectCountSupported: false` **显式声明**这条能力不可用（`services/api/src/media/object-store.ts`）；
//   - 服务层据声明把计数读成 `null`（⛔ 不是失败，见 `diagnosticObjectCount`）；
//   - 驱动层把 `null` 当「读数未知」（⛔ 不是失败，见 `services/api/src/media/purge-driver.ts`）。
//
// 本文件钉四件事：
//   [1] 真实 `s3_compatible` 适配器声明 `objectCountSupported === false`，且**直接调它的 `objectCount()`
//       仍然抛** `PROVIDER_UNAVAILABLE` —— 声明是显式的，不是「把异常吞掉」；
//   [2] 替身端口**不声明**该字段（未声明 = 支持），它的 `objectCount()` 照常给数字；
//   [3] `createAppMediaService()` 配这种「声明不支持枚举」的适配器时：`cleanupOrphans()` 返回
//       `remainingObjects: null` **且不抛**，同一轮**仍然真的删了对象**；`stats()` 返回
//       `objectCount: null` **且不抛**；
//   [4] 失败语义**没被放宽**：删除未确认（端口返回 `false`）⇒ 仍然 `pendingObjects += 1`、
//       引用与台账行都留着，只是「清扫后还剩几个」这条诊断读数是 `null`。
//
// 本文件**不**证明（见报告「诚实边界」）：真实桶的 `DeleteObject`/版本化语义、S3 list 权限接线、
// 真 PG 上的并发行为。上面的「真实适配器」只用保留域 `https://storage.example.test` 构造，
// 构造与预签名都是纯本地计算，**不发任何请求**（`externalRequestCount` 全程为 0）。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MediaError } from '../../packages/media/index.mjs';
import {
  createS3CompatibleObjectStore,
  createSubstituteObjectStore,
} from '../../services/api/src/media/object-store.ts';
import { approveRealMediaWiring, createAppMediaService } from '../../services/api/src/media/service.ts';
import { createMemoryMediaStore } from '../../services/api/src/media/store.ts';

const AT = Date.parse('2026-10-31T00:00:00.000Z');
const OWNER = '0193a0f0-0000-4000-8000-00000000e001';
const MEDIA_ID = '0193a0f0-0000-4000-8000-00000000d001';
const TOKEN_SECRET = 'synthetic-not-a-real-signing-key';

/** 真实适配器的合成配置：保留域 + 明显合成的凭据，构造函数不发请求。 */
function syntheticStorageConfig() {
  return {
    endpoint: 'https://storage.example.test',
    bucket: 'gy-media',
    accessKey: 'AKIDW15SYNTHETICONLY',
    secretKey: 'w15-synthetic-secret-do-not-log',
    region: 'ap-shanghai',
    forcePathStyle: true,
  };
}

/**
 * 「真实适配器的能力声明 + 替身做删除」的组合端口。
 *
 * - `kind: 's3_compatible'` ⇒ 过得了 `createAppMediaService` 的 real 闸门（那一步只认 kind）；
 * - `objectCountSupported: false` 与**复用真实适配器那条固定抛错的 `objectCount()`** ⇒ 形状与生产一致；
 * - `put/get/delete` 走替身（进程内内存），所以「这一轮真的删掉了对象」可以被断言。
 */
function declaredUnsupportedStore({ deleteObject } = {}) {
  const substitute = createSubstituteObjectStore({ note: 'W15 单测替身：真实能力声明 + 内存删除（零外呼）' });
  const realAdapter = createS3CompatibleObjectStore(syntheticStorageConfig());
  const store = {
    ...substitute,
    kind: 's3_compatible',
    // 能力声明**照抄真实适配器**（不在这里写死 false）：这样一旦生产去掉声明，本文件的
    // [3] 就会走到「objectCount() 抛错」那条分支并转红 —— 负控制才有判定面。
    objectCountSupported: realAdapter.objectCountSupported,
    // 直接借用真实适配器的方法：它固定抛 PROVIDER_UNAVAILABLE。
    objectCount: () => realAdapter.objectCount(),
  };
  // 覆盖删除行为时**包住**替身自己的删除（而不是凭空造一个），否则「桶侧还剩几个」会失真。
  if (deleteObject !== undefined) store.deleteObject = deleteObject(substitute.deleteObject);
  return { store, substitute, realAdapter };
}

/** 一条 `rejected` 记录：两个对象引用都在（`cleanupOrphans` 的第一段扫的就是它）。 */
function rejectedRecord(overrides = {}) {
  return {
    id: MEDIA_ID,
    ownerId: OWNER,
    revision: 2,
    purpose: 'community_image',
    mime: 'image/jpeg',
    bytes: 3,
    duration_ms: null,
    sha256: 'a'.repeat(64),
    state: 'rejected',
    failure_code: 'REJECTED_BY_OWNER',
    rawRef: 'objects/raw-1',
    derivativeRef: 'objects/der-1',
    createdAt: AT,
    updatedAt: AT,
    expiresAt: AT,
    ...overrides,
  };
}

/** 装配一份 real 模式的媒体服务（批准能力在 tools/ 与测试里铸造是既有先例）。 */
function realServiceWith(store) {
  const persistence = createMemoryMediaStore({ now: () => AT });
  const service = createAppMediaService({
    executionMode: 'real',
    objectStore: store,
    tokenSecret: TOKEN_SECRET,
    persistence,
    now: () => new Date(AT),
    realMediaApproval: approveRealMediaWiring({
      reason: 'W15 单测：真实适配器的 objectCount 能力声明 + 替身做删除，零外呼',
    }),
  });
  return { service, persistence };
}

// ---------------------------------------------------------------------------- [1]

test('[1] 真实 s3_compatible 适配器：声明 objectCountSupported=false，直接调 objectCount() 仍抛', async () => {
  const adapter = createS3CompatibleObjectStore(syntheticStorageConfig());

  assert.equal(adapter.kind, 's3_compatible');
  assert.equal(adapter.objectCountSupported, false, '能力声明必须是显式的 false（不是「没写」）');
  assert.equal(adapter.externalRequestCount, 0, '构造不发起任何请求');

  // 声明是「调用方别用它」，**不是**「把异常吞掉」：绕过声明直接调，照样拿不到假数字。
  await assert.rejects(
    () => adapter.objectCount(),
    (error) => {
      assert.equal(error instanceof MediaError, true);
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      return true;
    },
  );
  assert.equal(adapter.externalRequestCount, 0, 'objectCount() 抛错也没有外呼（本地就拒了）');
});

// ---------------------------------------------------------------------------- [2]

test('[2] 替身端口不声明该字段（未声明 = 支持），objectCount() 照常给数字', async () => {
  const substitute = createSubstituteObjectStore();
  assert.equal(substitute.objectCountSupported, undefined);
  assert.equal(await substitute.objectCount(), 0);
  await substitute.putObject('objects/one', new Uint8Array([1, 2, 3]), 'image/jpeg');
  assert.equal(await substitute.objectCount(), 1);
});

// ---------------------------------------------------------------------------- [3]

test('[3] 声明不支持的适配器：cleanupOrphans()/stats() 读数都是 null 且不抛，同一轮仍然真的删了对象', async () => {
  const { store, substitute } = declaredUnsupportedStore();
  const { service } = realServiceWith(store);

  assert.equal(service.failClosedReason, null, 'real + 批准 + s3_compatible 的 kind ⇒ 不是 fail-closed');

  // 先把两个对象真的放进（替身）存储，再让清扫去删它们。
  await substitute.putObject('objects/raw-1', new Uint8Array([1, 2, 3]), 'image/jpeg');
  await substitute.putObject('objects/der-1', new Uint8Array([4, 5, 6]), 'image/jpeg');
  assert.equal(await substitute.objectCount(), 2);

  // 记录也要在持久化端口里：`cleanupOrphans()` 的第一段扫的就是这类行。
  const memory = createMemoryMediaStore({ now: () => AT });
  await memory.createMedia(rejectedRecord());
  const wired = createAppMediaService({
    executionMode: 'real',
    objectStore: store,
    tokenSecret: TOKEN_SECRET,
    persistence: memory,
    now: () => new Date(AT),
    realMediaApproval: approveRealMediaWiring({ reason: 'W15 单测：诊断不可用不算失败（零外呼）' }),
  });

  const swept = await wired.cleanupOrphans();
  assert.equal(swept.remainingObjects, null, '适配器不枚举 ⇒ 诊断读数是 null，⛔ 不是 0，也⛔ 不是失败');
  assert.equal(swept.removedObjects, 2, '两个引用都确认删除（这一轮真的删了对象）');
  assert.equal(swept.pendingObjects, 0);
  assert.equal(await substitute.objectCount(), 0, '对象确实从存储里没了：null 不是「什么都没删」');

  const stats = await wired.stats();
  assert.equal(stats.objectCount, null, 'stats() 同样把不可用的诊断读成 null（--dry-run 靠它）');
  assert.equal(stats.mediaCount, 1);
  assert.equal(stats.grantCount, 0);
});

// ---------------------------------------------------------------------------- [4]

test('[4] 失败语义没被放宽：删除未确认 ⇒ 仍进 pendingObjects、引用与台账行都留着（诊断仍是 null）', async () => {
  const { store, substitute } = declaredUnsupportedStore({
    deleteObject: (innerDelete) => async (key) => (key === 'objects/raw-1' ? false : innerDelete(key)),
  });
  const memory = createMemoryMediaStore({ now: () => AT });
  await memory.createMedia(rejectedRecord());
  const wired = createAppMediaService({
    executionMode: 'real',
    objectStore: store,
    tokenSecret: TOKEN_SECRET,
    persistence: memory,
    now: () => new Date(AT),
    realMediaApproval: approveRealMediaWiring({ reason: 'W15 单测：未确认删除必须保留重试依据（零外呼）' }),
  });

  await substitute.putObject('objects/raw-1', new Uint8Array([1, 2, 3]), 'image/jpeg');
  await substitute.putObject('objects/der-1', new Uint8Array([4, 5, 6]), 'image/jpeg');

  const swept = await wired.cleanupOrphans();

  assert.equal(swept.pendingObjects, 1, '未确认删除不是删除成功（service.ts:708/742 的口径没变）');
  assert.equal(swept.removedObjects, 1);
  assert.equal(swept.remainingObjects, null, '诊断不可用与「有没有删干净」是两件事');

  const kept = await memory.getMedia(MEDIA_ID);
  assert.equal(kept.rawRef, 'objects/raw-1', '未确认删除的对象引用必须留着（重试依据）');
  assert.equal(kept.derivativeRef, null, '已确认删除的那一个引用被清掉');

  const ledger = await memory.listObjectCleanup();
  assert.deepEqual(
    ledger.map((row) => row.objectRef),
    ['objects/raw-1'],
    '台账行同样必须留着：父行一旦被清空引用，只有台账还记着这个对象',
  );
  assert.equal(await substitute.objectCount(), 1, '桶侧确实还留着那一个');
});
