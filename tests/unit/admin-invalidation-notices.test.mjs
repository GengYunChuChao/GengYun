/**
 * GY-R73（#17）· 「来源/条目被撤回 ⇒ 通知收藏过它的用户」——**生产链**单测。
 *
 * 这里断言的是**真实链路**（不是替换掉的一层）：后台管理服务的真撤回
 * （`admin/service.ts` 的 `withdrawDraft`：真改 lifecycle + 真写审计）→ 真影响面判定
 * （复用 `admin/reference-integrity.ts` 的裁决）→ 真收藏反查（favorites 存储两臂）→
 * 真幂等键 → 消息域公开创建口（本文件用记录型替身，PG 语义在 `favorites-history-store-pg`
 * 那套 PGlite 用例与 `tests/integration/*-pg.mjs` 里另证）。
 *
 * 明确**不**声称的事（诚实边界）：
 *   1. 本文件不证明「生产上真有活着的用户读得到这两条通知」——那需要真机/真实令牌验收；
 *   2. 后台内容域（`admin_content_*`）与公开读面（`catalog_read.current_knowledge`）今天
 *      **没有桥**（`0036` 注释 :19-33），所以「后台 knowledge 实体 id 恰好是某条公开资料的 id」
 *      在今天的仓库里没有数据源；本文件只证明**给定 id 空间重合时**通知链闭合。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAdminContentStore } from '../../services/api/src/admin/store.ts';
import { createAdminContentService } from '../../services/api/src/admin/service.ts';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createPostgresFavoritesStore } from '../../services/api/src/favorites/store-pg.ts';
import {
  createPostgresActiveOwnersPort,
  createStoreImpactPort,
  createWithdrawalInvalidationNotices,
  invalidationEventKey,
  withInvalidationNotices,
} from '../../services/api/src/admin/ops/invalidation-events.ts';
import {
  FAMILY_CASES,
  SIGNING_KEY,
  context,
  createClock,
  createDraft,
  publishRevision,
  validKnowledgeInput,
  withdrawRevision,
} from './admin-fixtures.mjs';
import { pglitePool } from './favorites-history-fixtures.mjs';

const SOURCES = FAMILY_CASES.find((entry) => entry.name === 'sources');
const KNOWLEDGE = FAMILY_CASES.find((entry) => entry.name === 'knowledge');
const SOURCE_VERSION = '2026-09';

const OWNER_ACTIVE_A = '11111111-1111-4111-8111-1111111111a1';
const OWNER_ACTIVE_B = '22222222-2222-4222-8222-2222222222b2';
const OWNER_SUSPENDED = '33333333-3333-4333-8333-3333333333c3';

function favoriteRecord(ownerId, targetRef) {
  return {
    id: randomUUID(),
    revision: 1,
    owner_id: ownerId,
    target_ref: targetRef,
    created_at: '2026-10-12T00:00:00.000Z',
  };
}

/**
 * 装配一个「真 store + 真收藏存储 + 记录型消息口」的撤回装饰体。
 * `activeOwners` 用可控替身，模拟 PG 侧 `state='active'` 过滤（真 SQL 在下面 PGlite 用例里证）。
 */
function makeHarness({ active = [], messages } = {}) {
  const clock = createClock('2026-10-12T00:00:00.000Z', 1000);
  const store = createAdminContentStore();
  const service = createAdminContentService({ store, now: clock.now, signingKey: SIGNING_KEY });
  const favorites = createMemoryFavoritesStore({ now: () => clock.peek().getTime() });

  const appended = [];
  const appendPort =
    messages === undefined
      ? {
          async appendMessage(input) {
            appended.push(input);
            return { created: true, message: { id: `msg-${appended.length}` } };
          },
        }
      : messages;

  const logLines = [];
  const activeSet = new Set(active);
  const notices = createWithdrawalInvalidationNotices({
    store,
    favorites,
    messages: appendPort,
    activeOwners: {
      wired: true,
      note: '测试替身：只放行本用例登记的 active 账号（不是真实用户表读取）',
      filterActive: async (ownerIds) => ownerIds.filter((ownerId) => activeSet.has(ownerId)),
    },
    log: { warn: (payload, message) => logLines.push({ payload, message }) },
  });
  const wired = withInvalidationNotices(service, notices);
  return { clock, store, service, wired, favorites, notices, appended, logLines };
}

/** 建「已发布来源 + 已发布引用它的 knowledge 条目」，返回两个 id。 */
async function seedSourceAndEntry(wired) {
  const source = await createDraft(SOURCES, wired);
  const sourceId = source.body.data.id;
  await publishRevision(SOURCES, wired, sourceId, 1);

  const knowledge = await createDraft(
    KNOWLEDGE,
    wired,
    context(),
    validKnowledgeInput({ source_id: sourceId, source_version: SOURCE_VERSION }),
  );
  const entryId = knowledge.body.data.id;
  await publishRevision(KNOWLEDGE, wired, entryId, 1);
  return { sourceId, entryId };
}

test('R73-1 撤回来源 ⇒ 只给「收藏了受影响条目且状态正常」的用户各发一条 system 消息', async () => {
  const harness = makeHarness({ active: [OWNER_ACTIVE_A, OWNER_ACTIVE_B] });
  const { sourceId, entryId } = await seedSourceAndEntry(harness.wired);

  for (const ownerId of [OWNER_ACTIVE_A, OWNER_ACTIVE_B, OWNER_SUSPENDED]) {
    const inserted = await harness.favorites.insertFavorite(
      favoriteRecord(ownerId, { type: 'herbicide', id: entryId, revision: 1 }),
    );
    assert.equal(inserted, 'inserted');
  }

  const withdrawn = await withdrawRevision(SOURCES, harness.wired, sourceId, 1);
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.body.data.changed, true, '真撤回必须自报 changed: true');

  assert.equal(harness.appended.length, 2, '两个 active 收藏者各一条；停用账号一条都不给');
  const recipients = harness.appended.map((input) => input.owner_id).sort();
  assert.deepEqual(recipients, [OWNER_ACTIVE_A, OWNER_ACTIVE_B].sort());

  for (const input of harness.appended) {
    assert.equal(input.type, 'system');
    assert.deepEqual(input.target_ref, { type: 'herbicide', id: entryId, revision: 1 }, 'target_ref 指向受影响条目');
    assert.match(input.event_key, /^system:invalidate:src:/);
    assert.ok(input.event_key.length <= 200, 'event_key 必须落在消息域 200 字符上限内');
  }
  // 同一批投递共用一个键：一条通知只有一个幂等键（不是每个收件人一个）。
  assert.equal(new Set(harness.appended.map((input) => input.event_key)).size, 1);

  assert.equal(harness.notices.counters.delivered, 2);
  assert.equal(harness.notices.counters.failed, 0);
  assert.deepEqual(harness.logLines, [], '正常路径不许打 warn');
});

test('R73-2 重复撤回（幂等短路 changed:false）不产生第二条消息', async () => {
  const harness = makeHarness({ active: [OWNER_ACTIVE_A] });
  const { sourceId, entryId } = await seedSourceAndEntry(harness.wired);
  await harness.favorites.insertFavorite(favoriteRecord(OWNER_ACTIVE_A, { type: 'herbicide', id: entryId, revision: 1 }));

  await withdrawRevision(SOURCES, harness.wired, sourceId, 1);
  assert.equal(harness.appended.length, 1);
  const firstKey = harness.appended[0].event_key;

  const replay = await withdrawRevision(SOURCES, harness.wired, sourceId, 1);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.changed, false, '已撤回再撤回应是幂等短路');

  assert.equal(harness.appended.length, 1, '重放不许新增消息');
  assert.equal(harness.notices.counters.delivered, 1);
});

test('R73-3 重新发布后再撤回是**第二次真实事件**（令牌变 ⇒ 新消息），没被幂等键吞掉', async () => {
  const harness = makeHarness({ active: [OWNER_ACTIVE_A] });
  const { sourceId, entryId } = await seedSourceAndEntry(harness.wired);
  await harness.favorites.insertFavorite(favoriteRecord(OWNER_ACTIVE_A, { type: 'herbicide', id: entryId, revision: 1 }));

  await withdrawRevision(SOURCES, harness.wired, sourceId, 1);
  const firstKey = harness.appended[0].event_key;

  const republished = await publishRevision(SOURCES, harness.wired, sourceId, 1);
  assert.equal(republished.body.data.changed, true, 'withdrawn → published 是真实迁移');

  await withdrawRevision(SOURCES, harness.wired, sourceId, 1);
  assert.equal(harness.appended.length, 2, '第二次撤回必须再发一条');
  assert.notEqual(harness.appended[1].event_key, firstKey, '两次撤回的令牌必须不同');
});

test('R73-4 条目自身撤回 ⇒ 通知收藏了该条目的用户（ent 键）', async () => {
  const harness = makeHarness({ active: [OWNER_ACTIVE_A] });
  const { entryId } = await seedSourceAndEntry(harness.wired);
  await harness.favorites.insertFavorite(favoriteRecord(OWNER_ACTIVE_A, { type: 'herbicide', id: entryId, revision: 1 }));

  const withdrawn = await withdrawRevision(KNOWLEDGE, harness.wired, entryId, 1);
  assert.equal(withdrawn.body.data.changed, true);
  assert.equal(harness.appended.length, 1);
  assert.match(harness.appended[0].event_key, /^system:invalidate:ent:/);
  assert.equal(harness.appended[0].target_ref.id, entryId);
});

test('R73-5 fail-open：消息口抛错时撤回仍然成功，只记 warn + failed', async () => {
  const boom = {
    async appendMessage() {
      const error = new Error('消息域不可用');
      error.code = 'PROVIDER_UNAVAILABLE';
      throw error;
    },
  };
  const harness = makeHarness({ active: [OWNER_ACTIVE_A], messages: boom });
  const { sourceId, entryId } = await seedSourceAndEntry(harness.wired);
  await harness.favorites.insertFavorite(favoriteRecord(OWNER_ACTIVE_A, { type: 'herbicide', id: entryId, revision: 1 }));

  const withdrawn = await withdrawRevision(SOURCES, harness.wired, sourceId, 1);
  assert.equal(withdrawn.status, 200, '通知失败不许把已提交的撤回翻成失败');
  assert.equal(withdrawn.body.data.changed, true);

  const entity = await harness.store.getEntity(sourceId);
  assert.equal(entity.lifecycle, 'withdrawn', '撤回真的落库了');
  assert.equal(harness.notices.counters.failed, 1);
  assert.equal(harness.logLines.length, 1);
  assert.equal(harness.logLines[0].payload.reason, 'PROVIDER_UNAVAILABLE');
  assert.match(harness.logLines[0].message, /fail-open/);
});

test('R73-6 fail-open：收藏反查抛错时撤回仍然成功（影响面查询也是 fail-open）', async () => {
  const harness = makeHarness({ active: [OWNER_ACTIVE_A] });
  const { sourceId, entryId } = await seedSourceAndEntry(harness.wired);
  const exploding = {
    async listOwnerIdsByTarget() {
      throw new Error('收藏库不可用');
    },
  };
  const notices = createWithdrawalInvalidationNotices({
    store: harness.store,
    favorites: exploding,
    messages: { appendMessage: async () => ({ created: true, message: { id: 'm' } }) },
    activeOwners: { wired: true, note: 'test', filterActive: async (ids) => ids },
  });
  const wired = withInvalidationNotices(harness.service, notices);
  await harness.favorites.insertFavorite(favoriteRecord(OWNER_ACTIVE_A, { type: 'herbicide', id: entryId, revision: 1 }));

  const withdrawn = await withdrawRevision(SOURCES, wired, sourceId, 1);
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.body.data.changed, true);
  assert.equal((await harness.store.getEntity(sourceId)).lifecycle, 'withdrawn');
});

test('R73-7 无人收藏 / 不可收藏型别 / 受众未接线 ⇒ 全部 skip，且不投递任何消息', async () => {
  const harness = makeHarness({ active: [OWNER_ACTIVE_A] });
  const { sourceId } = await seedSourceAndEntry(harness.wired);

  // 1) 无人收藏
  await withdrawRevision(SOURCES, harness.wired, sourceId, 1);
  assert.equal(harness.appended.length, 0, '没有收藏者就一条都不发');
  assert.ok(harness.notices.counters.skipped >= 1);

  // 2) 受众未接线（没有 pool、也没有显式 activeOwners）：宁可少发，也不往可能停用的账号堆消息。
  const store = createAdminContentStore();
  const clock = createClock('2026-10-12T00:00:00.000Z', 1000);
  const service = createAdminContentService({ store, now: clock.now, signingKey: SIGNING_KEY });
  const favorites = createMemoryFavoritesStore({ now: () => clock.peek().getTime() });
  const appended = [];
  const noticed = createWithdrawalInvalidationNotices({
    store,
    favorites,
    messages: { appendMessage: async (input) => { appended.push(input); return { created: true, message: { id: 'm' } }; } },
    log: { warn: () => {} },
  });
  const wired = withInvalidationNotices(service, noticed);
  const seeded = await seedSourceAndEntry(wired);
  await favorites.insertFavorite(favoriteRecord(OWNER_ACTIVE_A, { type: 'herbicide', id: seeded.entryId, revision: 1 }));

  const withdrawn = await withdrawRevision(SOURCES, wired, seeded.sourceId, 1);
  assert.equal(withdrawn.status, 200, '未接线不阻塞撤回');
  assert.equal(appended.length, 0, '受众未接线时一条都不投递（fail-closed 的受众侧）');
  assert.equal(noticed.activeOwners.wired, false);
});

test('R73-8 装饰器只挂 sources/knowledge 两族，其余四族的函数引用原样不动', async () => {
  const harness = makeHarness({ active: [] });
  assert.equal(harness.wired.withdrawRegistration, harness.service.withdrawRegistration);
  assert.equal(harness.wired.withdrawRestriction, harness.service.withdrawRestriction);
  assert.notEqual(harness.wired.withdrawSource, harness.service.withdrawSource);
  assert.notEqual(harness.wired.withdrawKnowledge, harness.service.withdrawKnowledge);
  // 其余读面/写面也必须原样透传（装饰器不许顺手改别的行为）。
  assert.equal(harness.wired.listAdminSources, harness.service.listAdminSources);
  assert.equal(harness.wired.createSourceDraft, harness.service.createSourceDraft);
});

test('R73-9 invalidationEventKey：形状/大小写归一/长度上界', () => {
  const key = invalidationEventKey({
    kind: 'source',
    causeId: '  AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA ',
    token: 1760000000000,
    target: { type: 'herbicide', id: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB', revision: 2 },
  });
  assert.equal(
    key,
    'system:invalidate:src:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:t1760000000000:herbicide:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  );
  const worst = invalidationEventKey({
    kind: 'entry',
    causeId: randomUUID(),
    token: 4102444800000,
    target: { type: 'static_region', id: randomUUID(), revision: 1 },
  });
  assert.ok(worst.length <= 200, `最坏情况 ${worst.length} 字符必须 ≤ 200`);
});

test('R73-10 收藏反查两臂同形：内存臂与真 SQL（PGlite）给同一组 owner', async (t) => {
  const targetRef = { type: 'herbicide', id: randomUUID(), revision: 1 };
  const otherRef = { type: 'herbicide', id: randomUUID(), revision: 1 };

  const memory = createMemoryFavoritesStore();
  await memory.insertFavorite(favoriteRecord(OWNER_ACTIVE_B, targetRef));
  await memory.insertFavorite(favoriteRecord(OWNER_ACTIVE_A, targetRef));
  await memory.insertFavorite(favoriteRecord(OWNER_SUSPENDED, otherRef));
  const memoryOwners = await memory.listOwnerIdsByTarget('herbicide', targetRef.id);
  assert.deepEqual(memoryOwners, [OWNER_ACTIVE_A, OWNER_ACTIVE_B], '只回该对象的收藏者，按 owner_id 升序');

  const { db, pool } = await pglitePool(t, [
    '0001_initial_schema',
    '0018_favorites_history',
    '0054_favorites_target_lookup',
  ]);
  const store = createPostgresFavoritesStore(pool);
  const ids = {};
  for (const ownerId of [OWNER_ACTIVE_A, OWNER_ACTIVE_B, OWNER_SUSPENDED]) {
    await db.query('INSERT INTO users (id) VALUES ($1::uuid)', [ownerId]);
    ids[ownerId] = ownerId;
  }
  await store.insertFavorite(favoriteRecord(OWNER_ACTIVE_A, targetRef));
  await store.insertFavorite(favoriteRecord(OWNER_ACTIVE_B, targetRef));
  await store.insertFavorite(favoriteRecord(OWNER_SUSPENDED, otherRef));

  const pgOwners = await store.listOwnerIdsByTarget('herbicide', targetRef.id);
  assert.deepEqual(pgOwners, [OWNER_ACTIVE_A, OWNER_ACTIVE_B], 'PG 臂与内存臂逐字同序同集合');
  assert.deepEqual(pgOwners, memoryOwners, '两臂必须逐字一致');

  // 0054 的索引真的建出来了（列序就是查询谓词 + 输出列）。
  const index = await db.query(
    "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'favorites_target_lookup_idx'",
  );
  assert.equal(index.rows.length, 1, '迁移 0054 必须建出 favorites_target_lookup_idx');
  assert.match(String(index.rows[0].indexdef), /\(target_type, target_id, owner_id\)/);
});

test('R73-11 受众过滤真 SQL：只放行 state=active（停用/注销中的账号不收通知）', async (t) => {
  const { db, pool } = await pglitePool(t, ['0001_initial_schema']);
  const active = OWNER_ACTIVE_A;
  const suspended = OWNER_SUSPENDED;
  const deleted = '44444444-4444-4444-8444-4444444444d4';
  await db.query('INSERT INTO users (id, state) VALUES ($1::uuid, $2::user_state)', [active, 'active']);
  await db.query('INSERT INTO users (id, state) VALUES ($1::uuid, $2::user_state)', [suspended, 'suspended']);
  await db.query('INSERT INTO users (id, state) VALUES ($1::uuid, $2::user_state)', [deleted, 'deleted']);

  const port = createPostgresActiveOwnersPort({ pool });
  assert.equal(port.wired, true);
  const kept = await port.filterActive([active, suspended, deleted, active]);
  assert.deepEqual(kept, [active], '只回 active，且入参重复被去重');
  assert.deepEqual(await port.filterActive([]), [], '空入参不发查询');
});
