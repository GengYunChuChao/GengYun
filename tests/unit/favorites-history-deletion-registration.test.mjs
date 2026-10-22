// GY-I16 阶段 2（#16）· **注销清空真的打到 PG 表上**（不是内存替身，也不只看"调用过"）。
//
// 与 `tests/unit/user-data-deletion.test.mjs` 的分工（那个文件继续锁**协议语义**，本文件只补
// 阶段 2 新增的那一层）：
//   * 那里用内存 store 证明「按主体清空、他人不受影响、证据行数、备份如实 pending」；
//   * 这里用 `buildApp` 的**生产装配**（`real` + 真 SQL 引擎的 pool）证明
//     「`app.ts` 传进注销协调器的是**同一批 PG store**」——清空后**真表**行数为 0，
//     且协调器记录的行数＝真实删除行数（`audit().onlineRemoved`）。
// 计数不是猜的：`deleteAllByOwner` 的实现是 `DELETE … RETURNING id` 计行数，行数直接进证据。
//
// 监工 P1 返修（2026-10-17）：正文表之外，`favorites_idempotency`／`history_idempotency` 的
// `scope` 第一段就是主体 uuid（+ 方法 + 路径），注销清空也必须**精确**清掉，且行数出现在证据里；
// 否则"局部清空"会被写成模块在线清除完成。下面同时锁：本主体两域归 0、他人两域各留 1 行。
//
// PGlite 只证明 SQL 语义与装配；真库覆盖在 `tests/integration/favorites-history-pg.mjs`
// （那边是同一批 `deleteAllByOwner` 断言 + 真 PG17）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createPostgresFavoritesStore } from '../../services/api/src/favorites/store-pg.ts';
import { createPostgresHistoryStore } from '../../services/api/src/history/store-pg.ts';
import { createPostgresMessagesStore } from '../../services/api/src/messages/store-pg.ts';
import {
  COMMUNITY_DELETION_MODULE,
  USER_DATA_DELETION_MODULES,
} from '../../services/api/src/privacy/user-data-deletion.ts';
import { PG_MIGRATIONS_WITH_COMMUNITY, pglitePool } from './favorites-history-fixtures.mjs';

const realConfig = () => ({
  ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
  executionMode: 'real',
  requiresRealCredentials: true,
});

test('注销清空·装配：real + pool ⇒ 协调器拿到的是 PG store，清空后真表为 0 且行数进证据', async (t) => {
  const { db, pool } = await pglitePool(t, PG_MIGRATIONS_WITH_COMMUNITY);
  const auth = createMemoryAuthStore();
  // `requests: null` 是 `app.ts` 支持的**显式关闭**口：本用例只锁"清空接线"，不锁
  // GY-I19 的持久化受理（那条链路由 `account-deletion-*.test.mjs` 覆盖）。
  const app = buildApp({
    config: realConfig(),
    store: auth,
    pool,
    now: () => new Date(),
    userDataDeletionInjection: { requests: null },
  });
  t.after(() => app.close());

  const mine = await auth.createUser('e'.repeat(64));
  const others = await auth.createUser('f'.repeat(64));
  for (const user of [mine, others]) await db.query('INSERT INTO users (id) VALUES ($1::uuid)', [user.id]);

  // 造行用**同一个 PG 实现**（不是内存替身）：行落在 app 装配读写的同一批表上。
  const favorites = createPostgresFavoritesStore(pool);
  const history = createPostgresHistoryStore(pool);
  const messages = createPostgresMessagesStore({ pool });
  assert.equal(
    await favorites.insertFavorite({
      id: randomUUID(),
      revision: 1,
      owner_id: mine.id,
      target_ref: { type: 'species', id: 'spc-del-1', revision: 1 },
      created_at: new Date().toISOString(),
    }),
    'inserted',
  );
  for (const [index, kind] of ['recognition', 'ocr'].entries()) {
    assert.equal(
      await history.insertHistory({
        id: randomUUID(),
        revision: 1,
        owner_id: mine.id,
        kind,
        target_ref: { type: kind, id: `rec-del-${index}`, revision: 1 },
        job_id: `job-del-${index}`,
        job_state: index === 0 ? 'succeeded' : 'timed_out',
        created_at: new Date(Date.now() + index).toISOString(),
        event_key: `evt-del-${index}`,
      }),
      'inserted',
    );
  }
  // 他人的行：清空必须**碰不到**。
  assert.equal(
    await favorites.insertFavorite({
      id: randomUUID(),
      revision: 1,
      owner_id: others.id,
      target_ref: { type: 'species', id: 'spc-del-1', revision: 1 },
      created_at: new Date().toISOString(),
    }),
    'inserted',
  );
  // #17 消息域（C1b 起进闭集）：本主体 1 条、他人 1 条 —— 注销必须真删 `public.messages`，
  // 不能只删收藏/历史（那正是 #17 的原缺口）。
  for (const ownerId of [mine.id, others.id]) {
    assert.equal(
      await messages.insertMessage({
        id: randomUUID(),
        revision: 1,
        owner_id: ownerId,
        type: 'system',
        target_ref: null,
        read_at: null,
        created_at: new Date().toISOString(),
        event_key: `msg-del-${ownerId}`,
      }),
      'inserted',
    );
  }
  assert.equal((await db.query('SELECT count(*)::int n FROM favorites')).rows[0].n, 2);
  assert.equal((await db.query('SELECT count(*)::int n FROM history')).rows[0].n, 2);
  assert.equal((await db.query('SELECT count(*)::int n FROM messages')).rows[0].n, 2);

  // 也造**幂等台账**行（监工 P1 返修）：`scope` 第一段就是主体 uuid，注销清空必须一起精确删掉，
  // 不能等 `expires_at` 过期。本主体：收藏域 2 行（1 已完成 + 1 只认领未完成）、历史域 1 行；
  // 他人：两域各 1 行，必须原样保留。
  const scopeOf = (subject, method, path) => `${subject}\n${method}\n${path}`;
  const expiresAt = Date.now() + 60_000;
  const claim = (store, scope, key) =>
    store.claimIdempotency(scope, key, { request_hash: 'h'.repeat(64), response_status: 200, expires_at: expiresAt });
  const ledgerRows = async (table, subject) =>
    (
      await db.query(
        `SELECT count(*)::int n FROM ${table}
          WHERE left(scope, char_length($1::text) + 1) = $1::text || chr(10)`,
        [subject],
      )
    ).rows[0].n;

  const mineFavPost = scopeOf(mine.id, 'POST', '/api/v1/favorites');
  assert.equal(await claim(favorites, mineFavPost, 'a'.repeat(64)), true);
  assert.equal(
    await favorites.completeIdempotency(mineFavPost, 'a'.repeat(64), {
      response_status: 201,
      outcome: { kind: 'favorite', id: randomUUID(), revision: 1 },
    }),
    true,
  );
  assert.equal(await claim(favorites, scopeOf(mine.id, 'DELETE', `/api/v1/favorites/${randomUUID()}`), 'b'.repeat(64)), true);
  assert.equal(await claim(history, scopeOf(mine.id, 'DELETE', `/api/v1/history/${randomUUID()}`), 'c'.repeat(64)), true);
  assert.equal(await claim(favorites, scopeOf(others.id, 'POST', '/api/v1/favorites'), 'd'.repeat(64)), true);
  assert.equal(await claim(history, scopeOf(others.id, 'DELETE', `/api/v1/history/${randomUUID()}`), 'e'.repeat(64)), true);
  assert.equal(await ledgerRows('favorites_idempotency', mine.id), 2);
  assert.equal(await ledgerRows('history_idempotency', mine.id), 1);

  // 共享台账 `public.idempotency_keys`（消息域**没有**独立台账表，靠 scope 首段=主体 uuid 前缀删）：
  // 直接插真行，证明「前缀删」在真表上生效，而不是只对内存 Map 生效。
  const sharedLedgerRows = async (subject) =>
    (
      await db.query(
        `SELECT count(*)::int n FROM public.idempotency_keys
          WHERE left(scope, char_length($1::text) + 1) = $1::text || chr(10)`,
        [subject],
      )
    ).rows[0].n;
  for (const [subject, digit] of [
    [mine.id, '1'],
    [others.id, '2'],
  ]) {
    await db.query(
      `INSERT INTO public.idempotency_keys (scope, key_hash, request_hash, response_status, expires_at)
       VALUES ($1, decode($2, 'hex'), $3, 200, now() + interval '1 hour')`,
      [`${subject}\nPOST\n/api/v1/messages`, digit.repeat(64), 'f'.repeat(64)],
    );
  }
  assert.equal(await sharedLedgerRows(mine.id), 1);
  assert.equal(await sharedLedgerRows(others.id), 1);

  // #15 社区域（R31-S6 / R32-P2）：注销按 F13 处理社区五张表上的**该主体**行。这里用真表 INSERT
  // 造行（不经过内存替身），处理完按真表**行数**与**形态**核对，而不是"调用过就算"：
  //   帖子/评论 ⇒ **保留**（`visibility='published'`、`revision` 不动；安全正文不因注销消失）；
  //   点赞 ⇒ 物理删；举报 ⇒ 行与 `state` 保留、只清自由文本 `detail`；
  //   本域幂等台账 ⇒ 按主体清空。作者投影去身份与 blocked 读数为单独断言（见下）。
  // 每张表都给他人留 1 行：处理**不得越界**。
  const communityIds = {
    minePost: randomUUID(),
    mineComment: randomUUID(),
    mineReport: randomUUID(),
    othersPost: randomUUID(),
    othersComment: randomUUID(),
    othersReport: randomUUID(),
  };
  const communityAt = new Date(Date.now() + 1_000).toISOString();
  const insertCommunityPost = (id, authorId) =>
    db.query(
      `INSERT INTO community_posts
         (id, author_id, revision, title, body, visibility, audit_state, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 1, '合成标题（不是真实内容）', '合成正文（不是真实内容）',
               'published'::visibility, 'approved'::audit_state, $3::timestamptz, $3::timestamptz)`,
      [id, authorId, communityAt],
    );
  const insertCommunityComment = (id, postId, authorId) =>
    db.query(
      `INSERT INTO community_comments
         (id, post_id, author_id, revision, body, visibility, audit_state, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 1, '合成评论（不是真实内容）',
               'published'::visibility, 'approved'::audit_state, $4::timestamptz)`,
      [id, postId, authorId, communityAt],
    );
  const insertCommunityReport = (id, reporterId, targetId, detail) =>
    db.query(
      `INSERT INTO community_reports
         (id, revision, reporter_id, target_type, target_id, target_revision, state, reason_code, detail, created_at)
       VALUES ($1::uuid, 1, $2::uuid, 'post', $3::uuid, 1, 'received', 'dangerous', $4::text, $5::timestamptz)`,
      [id, reporterId, targetId, detail, communityAt],
    );
  const insertCommunityLike = (userId, targetId) =>
    db.query(
      `INSERT INTO community_likes (user_id, target_type, target_id, created_at)
       VALUES ($1::uuid, 'post', $2::uuid, $3::timestamptz)`,
      [userId, targetId, communityAt],
    );
  await insertCommunityPost(communityIds.minePost, mine.id);
  await insertCommunityComment(communityIds.mineComment, communityIds.minePost, mine.id);
  await insertCommunityReport(communityIds.mineReport, mine.id, communityIds.minePost, '合成举报叙述（自由文本）');
  await insertCommunityLike(mine.id, communityIds.othersPost);
  await insertCommunityPost(communityIds.othersPost, others.id);
  await insertCommunityComment(communityIds.othersComment, communityIds.othersPost, others.id);
  await insertCommunityReport(communityIds.othersReport, others.id, communityIds.othersPost, '他人举报叙述');
  await insertCommunityLike(others.id, communityIds.minePost);

  // 社区**本域**幂等台账（`community_idempotency`，与收藏/历史同形）：本主体 2 行（1 已完成 +
  // 1 只认领未完成）、他人 1 行；`scope` 首段是主体 uuid + 方法 + 路径。
  const communityLedgerRows = async (subject) =>
    (
      await db.query(
        `SELECT count(*)::int n FROM community_idempotency
          WHERE left(scope, char_length($1::text) + 1) = $1::text || chr(10)`,
        [subject],
      )
    ).rows[0].n;
  for (const [subject, scopePath, digit] of [
    [mine.id, '/api/v1/community/posts', '3'],
    [mine.id, `/api/v1/community/posts/${communityIds.minePost}/comments`, '4'],
    [others.id, '/api/v1/community/posts', '5'],
  ]) {
    await db.query(
      `INSERT INTO community_idempotency (scope, key_hash, request_hash, response_status, expires_at)
       VALUES ($1, decode($2, 'hex'), $3, 201, now() + interval '1 hour')`,
      [`${subject}\nPOST\n${scopePath}`, digit.repeat(64), 'e'.repeat(128)],
    );
  }
  assert.equal(await communityLedgerRows(mine.id), 2);
  assert.equal(await communityLedgerRows(others.id), 1);

  // 模块闭集（C1b / C1b-3 起扩到含 messages 与 conversations；R31-S6 起再扩到 community）：
  // 既没有把 favorites/history 从闭集里摘掉，也不是"随便加了个名字"——消息域、会话域与社区域
  // 必须真的在闭集内（同一条路、同一 requestId、同一回执行）。社区是**装配期无条件注入**的
  // （`app.ts:1556-1567`），所以真实注销路径的闭集就是 5 项。
  assert.deepEqual(app.userDataDeletion.requiredModules(), [
    ...USER_DATA_DELETION_MODULES,
    COMMUNITY_DELETION_MODULE,
  ]);
  assert.deepEqual(app.userDataDeletion.requiredModules(), [
    'favorites',
    'history',
    'messages',
    'conversations',
    'community',
  ]);
  for (const legacy of ['favorites', 'history']) {
    assert.ok(app.userDataDeletion.requiredModules().includes(legacy), `闭集不得丢掉既有模块 ${legacy}`);
  }

  const request = app.userDataDeletion.requestDeletionFor(mine.id);
  const requestId = String(request.id);
  assert.ok(requestId.length > 0);
  await app.userDataDeletion.executeHandlers(requestId);

  // 真表：本主体清空、他人完好（行数是**真删**的结果，不是"调用了就算"）。
  assert.equal((await db.query('SELECT count(*)::int n FROM favorites WHERE owner_id = $1', [mine.id])).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int n FROM history WHERE owner_id = $1', [mine.id])).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int n FROM messages WHERE owner_id = $1', [mine.id])).rows[0].n, 0, '#17：消息行必须真删');
  assert.equal((await db.query('SELECT count(*)::int n FROM favorites WHERE owner_id = $1', [others.id])).rows[0].n, 1);
  assert.equal((await db.query('SELECT count(*)::int n FROM messages WHERE owner_id = $1', [others.id])).rows[0].n, 1, '他人消息行不动');
  assert.equal((await favorites.listFavoritesByOwner(others.id)).length, 1);
  // 幂等台账：本主体两域都归 0（含只认领未完成、不会自己过期的那行），他人一行不动。
  assert.equal(await ledgerRows('favorites_idempotency', mine.id), 0, '注销清空后本主体收藏台账残留 0 行');
  assert.equal(await ledgerRows('history_idempotency', mine.id), 0, '注销清空后本主体历史台账残留 0 行');
  assert.equal(await ledgerRows('favorites_idempotency', others.id), 1, '他人收藏台账不动');
  assert.equal(await ledgerRows('history_idempotency', others.id), 1, '他人历史台账不动');
  // 共享台账：本主体 0 行、他人 1 行（前缀删不越界）。
  assert.equal(await sharedLedgerRows(mine.id), 0, '注销清空后本主体共享幂等台账残留 0 行');
  assert.equal(await sharedLedgerRows(others.id), 1, '他人共享幂等台账不动');

  // 社区域（R31-S6）：**本主体清零、他人行保留** —— 形态与行数一起核（不是只看"调用过"）。
  const communityRowCount = async (table, column, ownerId) =>
    (await db.query(`SELECT count(*)::int n FROM ${table} WHERE ${column} = $1::uuid`, [ownerId])).rows[0].n;
  // 帖子/评论：**F13 保留**（行还在、`visibility='published'`、`revision` 不动）——
  // 内容安全、无个人信息、无媒体，注销不得把它软删（监工 `supervisor-1022-0932-pr474` P2）。
  const minePostRow = (
    await db.query('SELECT visibility::text v, revision, body FROM community_posts WHERE id = $1::uuid', [
      communityIds.minePost,
    ])
  ).rows[0];
  assert.equal(minePostRow?.v, 'published', 'F13：本主体安全帖子必须保留公开，不得软删');
  assert.equal(minePostRow?.revision, 1, '保留行不得为"标记"推进 revision（否则旧审核结论对不上）');
  const mineCommentRow = (
    await db.query('SELECT visibility::text v, revision FROM community_comments WHERE id = $1::uuid', [
      communityIds.mineComment,
    ])
  ).rows[0];
  assert.equal(mineCommentRow?.v, 'published', 'F13：本主体安全评论必须保留公开');
  assert.equal(mineCommentRow?.revision, 1);
  // 点赞：物理删（集合语义、没有历史价值，留着等于保留"点过哪些帖"的痕迹）。
  assert.equal(await communityRowCount('community_likes', 'user_id', mine.id), 0, '本主体点赞必须物理删');
  // 举报：行与 `state` 保留（处置依据/轨迹要留痕），只清自由文本 `detail`。
  const mineReportRow = (
    await db.query('SELECT state, detail FROM community_reports WHERE id = $1::uuid', [communityIds.mineReport])
  ).rows[0];
  assert.equal(mineReportRow?.state, 'received', '举报行不得物理删：state 轨迹要留');
  assert.equal(mineReportRow?.detail, null, '举报自由文本 detail 必须清空（该行唯一的 PII 面）');
  // 他人：一行不动、形态不变（清空不得越界）。
  assert.equal(await communityRowCount('community_posts', 'author_id', others.id), 1, '他人帖子不动');
  assert.equal(
    (await db.query('SELECT visibility::text v FROM community_posts WHERE id = $1::uuid', [communityIds.othersPost]))
      .rows[0]?.v,
    'published',
    '他人帖子可见性不被注销波及',
  );
  assert.equal(await communityRowCount('community_comments', 'author_id', others.id), 1, '他人评论不动');
  assert.equal(await communityRowCount('community_likes', 'user_id', others.id), 1, '他人点赞不动');
  assert.equal(
    (await db.query('SELECT detail FROM community_reports WHERE id = $1::uuid', [communityIds.othersReport])).rows[0]
      ?.detail,
    '他人举报叙述',
    '他人举报文本不动',
  );
  // 社区**本域**台账：本主体 0 行、他人 1 行（前缀删不越界，且不等 `expires_at` 过期）。
  assert.equal(await communityLedgerRows(mine.id), 0, '注销清空后本主体社区台账残留 0 行');
  assert.equal(await communityLedgerRows(others.id), 1, '他人社区台账不动');

  // 行数进证据：favorites 1 行、history 2 行、messages 1 行、conversations 0 行、
  // community **2 行真实改动**（1 举报自述 + 1 点赞；帖子/评论是保留，不是删除，故不进 online-purged）。
  // 会话域本用例没造行，但**必须**照实出现 0 —— 缺项说明该域没被驱动。
  const audit = app.userDataDeletion.audit().filter((entry) => entry.requestId === requestId);
  const removed = Object.fromEntries(audit.map((entry) => [entry.module, entry.onlineRemoved]));
  assert.deepEqual(removed, { favorites: 1, history: 2, messages: 1, conversations: 0, community: 2 });
  const communityAudit = audit.find((entry) => entry.module === 'community');
  assert.equal(communityAudit.retained, 2, 'F13：1 帖 + 1 评论保留（单列读数）');
  assert.equal(communityAudit.redacted, 0);
  assert.equal(communityAudit.hiddenMedia, 0);
  assert.equal(communityAudit.blocked, 1, '行级作者引用/引用持久化未完成 ⇒ 如实 blocked');
  assert.deepEqual(
    audit.map((entry) => entry.userId),
    [mine.id, mine.id, mine.id, mine.id, mine.id],
    '审计只记目标主体',
  );

  // 回执：四个既有模块在线行如实 `completed`；社区域因"行级作者引用未替换/引用未持久化"
  // **如实 blocked**（不是 completed）——F13 的保留/脱敏已完成，但作者引用这条要求未完成。
  const receipt = app.userDataDeletion.receipt(requestId);
  const byModule = new Map(receipt.handlers.map((row) => [row.module, row]));
  for (const module of ['favorites', 'history', 'messages', 'conversations']) {
    assert.equal(byModule.get(module).online_state, 'completed');
    assert.equal(byModule.get(module).backup_state, 'pending');
    assert.equal(byModule.get(module).error_code, null);
  }
  assert.equal(byModule.get('community').online_state, 'blocked', '未完成项 ⇒ 不得冒充 completed');
  assert.equal(byModule.get('community').error_code, 'POLICY_BLOCKED');
  assert.equal(byModule.get('community').backup_state, 'pending');
  assert.equal(app.userDataDeletion.completionStatus(requestId).completed, false);

  // 证据里**看得见**台账被清了几行（模块完成状态覆盖到新数据，不是只看正文表）。
  // 契约回执形状按 openapi 固定（不含 evidence），证据走同源的诊断视图；社区有独立台账表。
  const evidence = app.userDataDeletion.evidenceOf(requestId);
  assert.equal(evidence.favorites, 'favorites:online-purged:1;favorites:idempotency-purged:2');
  assert.equal(evidence.history, 'history:online-purged:2;history:idempotency-purged:1');
  assert.equal(evidence.messages, 'messages:online-purged:1;messages:idempotency-purged:1');
  assert.equal(evidence.conversations, 'conversations:online-purged:0');
  assert.ok(
    evidence.community.startsWith(
      'community:online-purged:2;community:idempotency-purged:2;community:retained:2;community:redacted:0;community:media-hidden:0;community:blocked:1',
    ),
    `社区证据串必须分开报改动/保留/blocked：${evidence.community}`,
  );
  // 装配路径的作者目录必须**真的能去身份**：blocked 只允许来自"行级引用/持久化"两条事实，
  // 不允许出现"能力缺失/调用失败"（那说明 app 没接上 `anonymize`，或它抛错了）。
  assert.ok(evidence.community.includes('author-row-reference-not-replaced'), evidence.community);
  assert.ok(evidence.community.includes('author-reference-not-durable'), evidence.community);
  assert.equal(evidence.community.includes('author-reference-unavailable'), false, evidence.community);
  assert.equal(evidence.community.includes('author-reference-failed'), false, evidence.community);
});

test('注销清空·再次清空：0 行也如实回 0（不省略、不当作失败）', async (t) => {
  const { db, pool } = await pglitePool(t, PG_MIGRATIONS_WITH_COMMUNITY);
  const auth = createMemoryAuthStore();
  const app = buildApp({
    config: realConfig(),
    store: auth,
    pool,
    now: () => new Date(),
    userDataDeletionInjection: { requests: null },
  });
  t.after(() => app.close());

  const user = await auth.createUser('g'.repeat(64));
  await db.query('INSERT INTO users (id) VALUES ($1::uuid)', [user.id]);

  const request = app.userDataDeletion.requestDeletionFor(user.id);
  const requestId = String(request.id);
  await app.userDataDeletion.executeHandlers(requestId);

  const audit = app.userDataDeletion.audit().filter((entry) => entry.requestId === requestId);
  const removed = Object.fromEntries(audit.map((entry) => [entry.module, entry.onlineRemoved]));
  assert.deepEqual(
    removed,
    { favorites: 0, history: 0, messages: 0, conversations: 0, community: 0 },
    '无行时五个模块都记 0（不是缺项）',
  );
  const receipt = app.userDataDeletion.receipt(requestId);
  for (const row of receipt.handlers) assert.equal(row.online_state, 'completed');
  // 台账计数同样如实给 0（不省略计数、也不因为在跑就假装清过台账）。
  const evidence = app.userDataDeletion.evidenceOf(requestId);
  assert.equal(evidence.favorites, 'favorites:online-purged:0;favorites:idempotency-purged:0');
  assert.equal(evidence.history, 'history:online-purged:0;history:idempotency-purged:0');
  assert.equal(evidence.messages, 'messages:online-purged:0;messages:idempotency-purged:0');
  assert.equal(evidence.conversations, 'conversations:online-purged:0');
  // 社区：0 行也照实回 0，保留/脱敏/媒体三段同样在（不是"表都没有"折叠成 blocked）。
  // 无保留内容 ⇒ 没有触发"作者引用"这条要求 ⇒ blocked=0、模块如实 completed。
  assert.equal(
    evidence.community,
    'community:online-purged:0;community:idempotency-purged:0;community:retained:0;community:redacted:0;community:media-hidden:0',
  );
});
