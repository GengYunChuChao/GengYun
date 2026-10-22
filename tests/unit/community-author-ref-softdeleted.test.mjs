/**
 * GY-R31 · F13 P2 返修（PR #483 · 监工 [P2]）：**已软删行的作者关联必须一并清除**。
 *
 * 缺陷（监工批复原文，reviewed_sha=`50255826`，已验 base=`1fbe7572`）：
 * `community/store-pg.ts` 与 `community/store.ts` 的 `purgeOwnerData` 以 `visibility <> 'deleted'`
 * 筛待处理行 ⇒ 作者主动删除的行**不在**作者指针替换清单里；`community/purge.ts` 又只以
 * `authorRefsReplaced`（+ retained/redacted）判 blocked ⇒ 同主体「普通行 + 已软删行」时普通行
 * 替换成功、`blocked = 0`，处理器把社区模块记为 `completed`，**而已软删行仍以原 `author_id`
 * 直接关联账户**；「仅已软删行」的主体一行都没替换，同样报 `completed`。
 *
 * 本文件断言的是**监工给的验收口径**（两条路径都允许：覆盖剩余关联 / 如实 blocked；本片走前者）：
 *   1. `visibility='deleted'` **保持不变**（不复活作者主动删除的内容），正文 / revision /
 *      `updated_at` 一字不动；
 *   2. 但作者关联必须清掉：`author_id = NULL` + 行内 `anonymized_author_ref`（迁移 0030 的
 *      「恰好一个非空」）；同一主体的普通行与软删行共用**同一个**注销引用（不分叉）；
 *   3. 端口必须**核对剩余 owner 引用**（`authorRefsRemaining`），而不是只看「换了几行」：
 *      清理后仍有行指向该账户 ⇒ `blocked` + `author-row-reference-not-replaced`，⛔ 不得 completed。
 *
 * 用例：
 *   A. 内存实现 · 同主体「普通行 + 已软删行」（走真实注销协调器，同时核对端口读数与回执）；
 *   B. 内存实现 · **仅**已软删行（同上）；
 *   C. 端口判据的反向控制：存储报告「还剩 1 行」⇒ 必须 blocked；报告 0 ⇒ completed
 *      （证明判据不是「恒 blocked」，也不是「只看 authorRefsReplaced」）；
 *   D1/D2. PG 实现（PGlite 内核真跑 SQL）· A/B 两种情形（证明 SQL 侧的筛选与替换都覆盖软删行）。
 *
 * ⚠️ PGlite 只证明 **SQL 语义**（本机无真 PG 17.11）：真库臂仍是
 * `tests/integration/community-pg.mjs`（未设 `COMMUNITY_PG_TEST_URL` ⇒ EXITCODE=77 = 未取得）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import {
  COMMUNITY_DELETION_MODULE,
  createUserDataDeletion,
} from '../../services/api/src/privacy/user-data-deletion.ts';
import { createCommunityOwnerPurgePort } from '../../services/api/src/community/purge.ts';
import { createPostgresCommunityStore } from '../../services/api/src/community/store-pg.ts';
import {
  CLEAN_BODY,
  CLEAN_TITLE,
  USER_A,
  USER_B,
  idem,
  makeHarness,
  publishPost,
} from './community-fixtures.mjs';
import {
  PG_MIGRATIONS_WITH_COMMUNITY,
  pglitePool,
  scriptedClock,
} from './favorites-history-fixtures.mjs';

const REF_PATTERN = /^gy-anon-[0-9a-f]{16}$/;
const PG_USER = USER_A.userId;
const PG_REF = 'gy-anon-0123456789abcdef';

/** 造四个非社区域存储（本文件不碰它们的内容，只要不缺席即可）。 */
function otherStores() {
  const clock = scriptedClock();
  return {
    favoritesStore: createMemoryFavoritesStore({ now: () => clock.ms }),
    historyStore: createMemoryHistoryStore({ now: () => clock.ms }),
    messagesStore: createMemoryMessagesStore({ now: () => clock.ms }),
    conversationsStore: createMemoryConversationStore(),
  };
}

/**
 * 走**真实注销协调器**清理一次，并捕获端口从存储拿到的读数。
 *
 * 为什么要包一层捕获（而不是再直接调一次 `purgeOwnerData`）：直接调第二次是**重放**，
 * 那时主体名下已经没有行，读数全为 0 —— 那不是"这次注销的结果"。捕获的 `counts` 与回执
 * 来自**同一次**处理，才能对齐"读数 ⇒ blocked ⇒ online_state"这条链。
 */
async function purgeThroughCoordinator(h, userId) {
  const observed = [];
  const inner = createCommunityOwnerPurgePort({ store: h.store, authors: h.authors });
  // 捕获**端口**的返回值（= 存储读数 + blocked/blockedReasons）：注销协调器消费的正是它，
  // 所以"读数 ⇒ blocked ⇒ online_state"这条链上的每一环都来自同一次处理。
  const communityStore = {
    deleteAllByOwner: (ownerId) => inner.deleteAllByOwner(ownerId),
    async purgeOwnerData(ownerId) {
      const result = await inner.purgeOwnerData(ownerId);
      observed.push(result);
      return result;
    },
  };
  const deletion = createUserDataDeletion({ ...otherStores(), communityStore });
  const request = deletion.requestDeletionFor(userId);
  await deletion.executeHandlers(String(request.id));
  const row = deletion
    .receipt(String(request.id))
    .handlers.find((entry) => entry.module === COMMUNITY_DELETION_MODULE);
  assert.ok(row !== undefined, '回执必须含 community 行');
  assert.equal(observed.length, 1, '注销协调器应恰好调用一次社区清理（否则读数与回执不是同一次处理）');
  return { counts: observed[0], row, deletion, request };
}

// ---------------------------------------------------------------------------
// A. 同主体「普通行 + 已软删行」
// ---------------------------------------------------------------------------
test('A. 内存实现 · 同主体「普通行 + 已软删行」：软删行作者关联也必须清掉，否则不得报 completed', async () => {
  const h = makeHarness();
  // 普通行：1 帖 + 1 评。
  const keptPost = await publishPost(h.service, USER_A, {}, idem(500));
  const keptComment = await h.service.createComment(
    USER_A,
    keptPost.id,
    { body: '补充：按标签说明处理即可。' },
    { idempotencyKey: idem(501), ifMatch: `"${keptPost.revision}"` },
  );
  // 已软删行：1 帖 + 1 评（作者主动删除）。
  const deletedPost = await publishPost(h.service, USER_A, {}, idem(502));
  await h.service.deletePost(USER_A, deletedPost.id, {
    idempotencyKey: idem(503),
    ifMatch: `"${deletedPost.revision}"`,
  });
  const deletedComment = await h.service.createComment(
    USER_A,
    keptPost.id,
    { body: '这条我也会自己删掉。' },
    { idempotencyKey: idem(504), ifMatch: `"${keptPost.revision}"` },
  );
  await h.service.deleteComment(USER_A, deletedComment.id, {
    idempotencyKey: idem(505),
    ifMatch: `"${deletedComment.revision}"`,
  });

  const deletedPostBefore = await h.store.getPost(deletedPost.id);
  const deletedCommentBefore = await h.store.getComment(deletedComment.id);
  assert.equal(deletedPostBefore.visibility, 'deleted', '前置：帖子已软删');
  assert.equal(deletedCommentBefore.visibility, 'deleted', '前置：评论已软删');
  // 缺陷面：基线里这两行仍以原 author_id 直接关联账户（修复后必须清空，但那是被测行为）。
  assert.equal(deletedPostBefore.author_id, USER_A.userId, '前置：软删帖仍关联原账户');
  assert.equal(deletedCommentBefore.author_id, USER_A.userId, '前置：软删评仍关联原账户');

  const { counts, row } = await purgeThroughCoordinator(h, USER_A.userId);

  // 1) 缺陷面先钉死：回执在线阶段 completed，而软删行仍以原 author_id 关联账户 —— 两者不能同时成立。
  assert.equal(row.online_state, 'completed', '本片走「覆盖剩余关联」路径 ⇒ 全部清掉后回执为 completed');
  const deletedPostAfter = await h.store.getPost(deletedPost.id);
  assert.equal(
    deletedPostAfter.author_id,
    null,
    `回执 online_state=${row.online_state}／blocked=${counts.blocked}，但软删帖仍以原 author_id 关联账户`
      + `（实际 ${String(deletedPostAfter.author_id)}，读数 ${JSON.stringify(counts)}）`,
  );
  const deletedCommentAfter = await h.store.getComment(deletedComment.id);
  assert.equal(
    deletedCommentAfter.author_id,
    null,
    `回执 online_state=${row.online_state}／blocked=${counts.blocked}，但软删评仍以原 author_id 关联账户`
      + `（实际 ${String(deletedCommentAfter.author_id)}）`,
  );

  // 2) 软删帖：可见性 / 正文 / 版本 / 删除时间都不动，只清作者关联。
  assert.equal(deletedPostAfter.visibility, 'deleted', '作者主动删除的可见性必须保留（不复活内容）');
  assert.equal(deletedPostAfter.revision, deletedPostBefore.revision, '清作者关联不得推进版本');
  assert.equal(deletedPostAfter.title, deletedPostBefore.title, '标题一字不动');
  assert.equal(deletedPostAfter.body, deletedPostBefore.body, '正文一字不动');
  assert.equal(deletedPostAfter.updated_at, deletedPostBefore.updated_at, '不得改写删除时间（没复活、也不是一次新编辑）');
  assert.match(
    String(deletedPostAfter.anonymized_author_ref),
    REF_PATTERN,
    '必须落行内注销引用（迁移 0030 的「恰好一个非空」）',
  );
  assert.equal(deletedCommentAfter.visibility, 'deleted', '评论的删除语义同样保留');
  assert.equal(deletedCommentAfter.revision, deletedCommentBefore.revision);
  assert.equal(deletedCommentAfter.body, deletedCommentBefore.body);
  assert.match(String(deletedCommentAfter.anonymized_author_ref), REF_PATTERN);

  // 3) 端口读数：4 行（2 普通 + 2 软删）全部换掉，剩余 owner 引用 0，未完成项 0。
  assert.equal(
    counts.authorRefsReplaced,
    4,
    `普通帖/评 2 行 + 软删帖/评 2 行都必须换成注销引用（实际 ${JSON.stringify(counts)}）`,
  );
  assert.equal(
    counts.authorRefsRemaining,
    0,
    `清理后不得再有行以原 author_id 关联本主体（实际 ${JSON.stringify(counts)}）`,
  );
  assert.equal(counts.blocked, 0, `两侧都清干净 ⇒ 不得 blocked（现场 ${JSON.stringify(counts.blockedReasons)}）`);
  assert.equal(counts.retained, 2, '保留读数只算正文原样保留的普通行；软删行既不算保留也不算删除');

  // 4) 普通行照旧替换，且与软删行**共用同一个**注销引用（逐主体独立，不分叉）。
  const keptPostAfter = await h.store.getPost(keptPost.id);
  assert.equal(keptPostAfter.author_id, null);
  assert.equal(keptPostAfter.visibility, 'published', '普通行仍按 F13 保留可见');
  assert.equal(
    keptPostAfter.anonymized_author_ref,
    deletedPostAfter.anonymized_author_ref,
    '同一主体的普通行与软删行必须共用同一个注销引用',
  );
  assert.equal(
    (await h.store.getComment(keptComment.id)).anonymized_author_ref,
    deletedPostAfter.anonymized_author_ref,
    '评论行同口径',
  );

  // 5) 回执：全部关联已清 ⇒ completed 才是诚实的。
  assert.equal(row.online_state, 'completed', '四行都已去身份 ⇒ 回执 completed（不再是「残留却报完成」）');
  assert.equal(row.error_code, null, 'completed 不得带阻断码');
});

// ---------------------------------------------------------------------------
// B. 仅已软删行
// ---------------------------------------------------------------------------
test('B. 内存实现 · 仅已软删行：主体只剩软删帖评时同样必须去身份，不得以 completed 掩盖残留关联', async () => {
  const h = makeHarness();
  // 评论挂在他人帖子下，随后作者自己删掉 —— 保证 A 名下**没有**未删除行。
  const otherPost = await publishPost(h.service, USER_B, {}, idem(510));
  const deletedComment = await h.service.createComment(
    USER_A,
    otherPost.id,
    { body: '这条评论我会自己删。' },
    { idempotencyKey: idem(511), ifMatch: `"${otherPost.revision}"` },
  );
  await h.service.deleteComment(USER_A, deletedComment.id, {
    idempotencyKey: idem(512),
    ifMatch: `"${deletedComment.revision}"`,
  });
  const deletedPost = await publishPost(h.service, USER_A, {}, idem(513));
  await h.service.deletePost(USER_A, deletedPost.id, {
    idempotencyKey: idem(514),
    ifMatch: `"${deletedPost.revision}"`,
  });

  // 前置：A 名下只剩已软删行（「我的发布」为空）。
  const mine = await h.service.listPosts(USER_A, { mine: true, limit: 10 });
  assert.equal(mine.items.length, 0, '前置：A 没有未删除的帖子');
  const deletedPostBefore = await h.store.getPost(deletedPost.id);
  assert.equal(deletedPostBefore.author_id, USER_A.userId, '前置：软删帖仍关联原账户');

  const { counts, row } = await purgeThroughCoordinator(h, USER_A.userId);

  // 1) 缺陷面先钉死：主体一行都没被替换（authorRefsReplaced=0），回执却是 completed。
  assert.equal(row.online_state, 'completed', '本片走「覆盖剩余关联」路径 ⇒ 全部清掉后回执为 completed');
  const deletedPostAfter = await h.store.getPost(deletedPost.id);
  assert.equal(
    deletedPostAfter.author_id,
    null,
    `回执 online_state=${row.online_state}／authorRefsReplaced=${counts.authorRefsReplaced}／blocked=${counts.blocked}，`
      + `但软删帖仍以原 author_id 关联账户（实际 ${String(deletedPostAfter.author_id)}，读数 ${JSON.stringify(counts)}）`,
  );
  const deletedCommentAfter = await h.store.getComment(deletedComment.id);
  assert.equal(
    deletedCommentAfter.author_id,
    null,
    `回执 online_state=${row.online_state}，但软删评仍以原 author_id 关联账户（实际 ${String(deletedCommentAfter.author_id)}）`,
  );

  // 2) 软删行只清作者关联：可见性 / 正文 / 版本不动。
  assert.equal(deletedPostAfter.visibility, 'deleted', '不复活内容');
  assert.equal(deletedPostAfter.revision, deletedPostBefore.revision);
  assert.equal(deletedPostAfter.body, deletedPostBefore.body);
  assert.match(String(deletedPostAfter.anonymized_author_ref), REF_PATTERN);

  assert.equal(deletedCommentAfter.visibility, 'deleted');
  assert.match(String(deletedCommentAfter.anonymized_author_ref), REF_PATTERN);
  assert.equal(
    deletedCommentAfter.anonymized_author_ref,
    deletedPostAfter.anonymized_author_ref,
    '同一主体的行共用同一个注销引用',
  );

  // 3) 端口读数：只有软删行时 retained/redacted 为 0，但替换行数与剩余引用必须如实。
  assert.equal(counts.retained, 0, '没有正文保留行 ⇒ retained 如实为 0');
  assert.equal(counts.redacted, 0);
  assert.equal(
    counts.authorRefsReplaced,
    2,
    `软删帖 1 + 软删评 1 = 2 行作者关联必须清掉（实际 ${JSON.stringify(counts)}）`,
  );
  assert.equal(
    counts.authorRefsRemaining,
    0,
    `清理后不得再有行以原 author_id 关联本主体（实际 ${JSON.stringify(counts)}）`,
  );
  assert.equal(counts.blocked, 0, `已去身份 ⇒ 不得 blocked（现场 ${JSON.stringify(counts.blockedReasons)}）`);

  assert.equal(row.error_code, null);

  // 他人内容不受影响（对照）。
  const otherPostAfter = await h.store.getPost(otherPost.id);
  assert.equal(otherPostAfter.author_id, USER_B.userId, 'B 的作者指针不得被 A 的注销带走');
  assert.equal(otherPostAfter.anonymized_author_ref, null);
});

// ---------------------------------------------------------------------------
// C. 端口判据（反向控制）
// ---------------------------------------------------------------------------
test('C. 端口判据：仍剩 owner 引用 ⇒ 必须 blocked（不再只看「换了几行」），剩 0 ⇒ completed', async () => {
  const anonymize = async () => ({ display_id: PG_REF });
  const authors = { resolve: async () => null, anonymize };
  const countsWith = (extra) => ({
    records: 0,
    idempotency: 0,
    retained: 1,
    redacted: 0,
    hiddenMedia: 0,
    authorRefsReplaced: 1,
    ...extra,
  });

  // 存储如实报告「换了 1 行，但还剩 1 行仍指向该账户」⇒ 端口不得判 completed。
  const blockedPort = createCommunityOwnerPurgePort({
    store: {
      async purgeOwnerData() {
        return countsWith({ authorRefsRemaining: 1 });
      },
    },
    authors,
  });
  const blocked = await blockedPort.purgeOwnerData(USER_A.userId);
  assert.equal(blocked.blocked, 1, '「换了几行」不是完成判据：仍剩 owner 引用就必须 blocked');
  assert.deepEqual([...blocked.blockedReasons], ['author-row-reference-not-replaced']);

  // 反向：剩余 0 ⇒ 正常路径 completed（判据不是恒 blocked）。
  const cleanPort = createCommunityOwnerPurgePort({
    store: {
      async purgeOwnerData() {
        return countsWith({ authorRefsRemaining: 0 });
      },
    },
    authors,
  });
  const clean = await cleanPort.purgeOwnerData(USER_A.userId);
  assert.equal(clean.blocked, 0, '剩余 0 ⇒ 正常路径 completed');
  assert.deepEqual([...clean.blockedReasons], []);
});

// ---------------------------------------------------------------------------
// D. PG 实现（PGlite 内核）：同样的两种情形，走真 SQL
// ---------------------------------------------------------------------------
async function pgSeedPost(db, { id, authorId, visibility = 'published', revision = 1, title = CLEAN_TITLE, body = CLEAN_BODY }) {
  await db.query(
    `INSERT INTO community_posts
       (id, author_id, revision, title, body, visibility, audit_state, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::visibility, 'approved',
             '2026-10-22T00:00:00Z'::timestamptz, '2026-10-22T00:00:00Z'::timestamptz)`,
    [id, authorId, revision, title, body, visibility],
  );
}

async function pgSeedComment(db, { id, postId, authorId, visibility = 'published', revision = 1, body = '同问，我这边也差不多。' }) {
  await db.query(
    `INSERT INTO community_comments
       (id, post_id, author_id, revision, body, visibility, audit_state, created_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::visibility, 'approved', '2026-10-22T00:00:00Z'::timestamptz)`,
    [id, postId, authorId, revision, body, visibility],
  );
}

async function pgRowsById(db, table, id) {
  // `community_comments` 没有 `updated_at`（0022 的列形状），按表取列，⛔ 不用同一串套两表。
  const columns = table === 'community_posts'
    ? 'id, author_id, anonymized_author_ref, visibility, revision, body, updated_at'
    : 'id, author_id, anonymized_author_ref, visibility, revision, body';
  return (await db.query(
    `SELECT ${columns} FROM ${table} WHERE id = $1::uuid`,
    [id],
  )).rows[0];
}

test('D1. PG 实现（PGlite）· 同主体「普通行 + 已软删行」：SQL 侧同样清空软删行的 author_id', async (t) => {
  const { db, pool } = await pglitePool(t, PG_MIGRATIONS_WITH_COMMUNITY);
  const store = createPostgresCommunityStore({ pool });
  await db.query('INSERT INTO users (id) VALUES ($1::uuid)', [PG_USER]);
  const keptPostId = '00000000-0000-4000-8000-00000000d101';
  const deletedPostId = '00000000-0000-4000-8000-00000000d102';
  const keptCommentId = '00000000-0000-4000-8000-00000000d103';
  const deletedCommentId = '00000000-0000-4000-8000-00000000d104';
  await pgSeedPost(db, { id: keptPostId, authorId: PG_USER });
  await pgSeedPost(db, { id: deletedPostId, authorId: PG_USER, visibility: 'deleted' });
  await pgSeedComment(db, { id: keptCommentId, postId: keptPostId, authorId: PG_USER });
  await pgSeedComment(db, { id: deletedCommentId, postId: keptPostId, authorId: PG_USER, visibility: 'deleted' });

  const counts = await store.purgeOwnerData(PG_USER, { anonymizedAuthorRef: PG_REF });
  const deletedPost = await pgRowsById(db, 'community_posts', deletedPostId);
  assert.equal(
    deletedPost.author_id,
    null,
    `软删帖 author_id 必须置空（实际 ${String(deletedPost.author_id)}，读数 ${JSON.stringify(counts)}）`,
  );
  assert.equal(counts.authorRefsReplaced, 4, `4 行（含 2 行软删）都必须换掉（实际 ${JSON.stringify(counts)}）`);
  assert.equal(counts.authorRefsRemaining, 0, `SQL 侧清理后不得再有 owner 引用残留（实际 ${JSON.stringify(counts)}）`);
  assert.equal(counts.retained, 2, '保留读数只算普通行');

  assert.equal(deletedPost.visibility, 'deleted', '不复活内容');
  assert.equal(deletedPost.anonymized_author_ref, PG_REF);
  assert.equal(Number(deletedPost.revision), 1, '不得推进版本');
  assert.equal(deletedPost.body, CLEAN_BODY, '正文一字不动');
  assert.equal(
    new Date(deletedPost.updated_at).toISOString(),
    '2026-10-22T00:00:00.000Z',
    '不得改写 updated_at',
  );

  const deletedComment = await pgRowsById(db, 'community_comments', deletedCommentId);
  assert.equal(deletedComment.visibility, 'deleted');
  assert.equal(deletedComment.author_id, null, '软删评 author_id 必须置空');
  assert.equal(deletedComment.anonymized_author_ref, PG_REF);
  assert.equal(Number(deletedComment.revision), 1);

  const keptPost = await pgRowsById(db, 'community_posts', keptPostId);
  assert.equal(keptPost.author_id, null);
  assert.equal(keptPost.anonymized_author_ref, PG_REF, '同一主体共用同一个引用（软删行也不得分叉）');
});

test('D2. PG 实现（PGlite）· 仅已软删行：同样必须清掉作者关联，且不报「替换 0 行」', async (t) => {
  const { db, pool } = await pglitePool(t, PG_MIGRATIONS_WITH_COMMUNITY);
  const store = createPostgresCommunityStore({ pool });
  await db.query('INSERT INTO users (id) VALUES ($1::uuid)', [PG_USER]);
  const deletedPostId = '00000000-0000-4000-8000-00000000d201';
  const deletedCommentId = '00000000-0000-4000-8000-00000000d202';
  await pgSeedPost(db, { id: deletedPostId, authorId: PG_USER, visibility: 'deleted' });
  await pgSeedComment(db, { id: deletedCommentId, postId: deletedPostId, authorId: PG_USER, visibility: 'deleted' });

  const counts = await store.purgeOwnerData(PG_USER, { anonymizedAuthorRef: PG_REF });
  const linkedRows = (await db.query(
    `SELECT 'post' AS kind, id, author_id FROM community_posts WHERE author_id = $1::uuid
     UNION ALL
     SELECT 'comment' AS kind, id, author_id FROM community_comments WHERE author_id = $1::uuid`,
    [PG_USER],
  )).rows;
  assert.deepEqual(
    linkedRows.map((row) => `${row.kind}:${row.id}`),
    [],
    `仅软删行时也不得留下 owner 引用（实际 ${JSON.stringify(linkedRows)}；读数 ${JSON.stringify(counts)}）`,
  );
  assert.equal(counts.retained, 0, '没有正文保留行');
  assert.equal(counts.authorRefsReplaced, 2, `仅软删行也必须换掉（实际 ${JSON.stringify(counts)}）`);
  assert.equal(counts.authorRefsRemaining, 0, `不得残留 owner 引用（实际 ${JSON.stringify(counts)}）`);

  for (const [table, id] of [
    ['community_posts', deletedPostId],
    ['community_comments', deletedCommentId],
  ]) {
    const row = await pgRowsById(db, table, id);
    assert.equal(row.visibility, 'deleted', `${table}：不复活内容`);
    assert.equal(row.author_id, null, `${table}：author_id 必须置空`);
    assert.equal(row.anonymized_author_ref, PG_REF, `${table}：必须落注销引用`);
    assert.equal(Number(row.revision), 1, `${table}：不得推进版本`);
  }
});
