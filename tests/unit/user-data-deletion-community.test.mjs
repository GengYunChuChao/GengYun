/**
 * GY-I15（#15）· R31-S6：社区域接入注销保留规则（F13）的回归用例（内存实现）。
 *
 * 历史：本文件最初锁的是"注销把作者帖子/评论软删"。监工 `supervisor-1022-0932-pr474` 指出
 * 那与已确认的 F13 保留规则冲突（`docs/implementation-requirements.md:279-280`：帖子评论保留、
 * 作者换不可反查注销引用、保留正文清个人信息、不能可靠脱敏的媒体隐藏/移除）。
 *
 * 现在断言的是**保留口径**：
 *   1. 注入社区清理端口 ⇒ 闭集追加 `community`，回执与审计都出现该模块；
 *   2. 处理器按 F13 处理**绑定主体**的行：安全正文保留（可见性不变）、个人信息清除、
 *      媒体引用移除、点赞物理删、举报自述抹除（处置轨迹 `state` 保留）；
 *   3. 他人不受影响；
 *   4. 行级作者引用/引用持久化未完成 ⇒ 如实 `blocked`（⛔ 不拿保留行数冒充 completed）；
 *   5. 不注入 ⇒ 闭集与逐字行为回到四域（既有测试替身因此一条都不用改）。
 *
 * 细则（a–d 四类判定）见 `community-account-deletion-retention.test.mjs`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import {
  COMMUNITY_DELETION_MODULE,
  USER_DATA_DELETION_MODULES,
  createUserDataDeletion,
} from '../../services/api/src/privacy/user-data-deletion.ts';
import { createCommunityOwnerPurgePort } from '../../services/api/src/community/purge.ts';
import { idem, makeHarness, publishPost, USER_A, USER_B } from './community-fixtures.mjs';
import { scriptedClock } from './favorites-history-fixtures.mjs';

/** 造四个非社区域的存储（本片不碰它们的内容，只要不缺席即可）。 */
function otherStores() {
  const clock = scriptedClock();
  return {
    favoritesStore: createMemoryFavoritesStore({ now: () => clock.ms }),
    historyStore: createMemoryHistoryStore({ now: () => clock.ms }),
    messagesStore: createMemoryMessagesStore({ now: () => clock.ms }),
    conversationsStore: createMemoryConversationStore(),
  };
}

/** 与 `app.ts` 的同形接线：社区 store + 作者目录 ⇒ 注销端口。 */
function communityDeletionPort(h) {
  return createCommunityOwnerPurgePort({ store: h.store, authors: h.authors });
}

/**
 * 播一段社区数据：
 *   - A 发帖 P1；B 在 P1 下发评论（他人的回复 —— 保留口径下它当然还在）；
 *   - B 发帖 P2；A 在 P2 下发评论、给 P2 点赞；B 也给 P2 点赞（用于验证只清本人）；
 *   - A 举报 P2；B 举报 P1（用于验证只清 A 的举报自述）。
 */
async function seedCommunity() {
  const h = makeHarness();
  const postA = await publishPost(h.service, USER_A, {}, idem(200));
  const postB = await publishPost(h.service, USER_B, {}, idem(210));
  const commentByB = await h.service.createComment(
    USER_B,
    postA.id,
    { body: '这条帖子里提到的轮换顺序我想确认一下。' },
    { idempotencyKey: idem(220), ifMatch: `"${postA.revision}"` },
  );
  const commentByA = await h.service.createComment(
    USER_A,
    postB.id,
    { body: '我这两天也遇到同样的情况，先记录苗情。' },
    { idempotencyKey: idem(221), ifMatch: `"${postB.revision}"` },
  );
  await h.service.likePosts(USER_A, postB.id, { idempotencyKey: idem(230), ifMatch: `"${postB.revision}"` });
  await h.service.likePosts(USER_B, postB.id, { idempotencyKey: idem(231), ifMatch: `"${postB.revision}"` });
  const reportByA = await h.service.createReport(
    USER_A,
    {
      target_ref: { type: 'post', id: postB.id, revision: postB.revision },
      reason_code: 'other',
      detail: '这是举报人自己写的说明，注销时必须抹掉',
    },
    { idempotencyKey: idem(240) },
  );
  await h.service.createReport(
    USER_B,
    {
      target_ref: { type: 'post', id: postA.id, revision: postA.revision },
      reason_code: 'other',
      detail: '别人的举报说明，不应被他人注销带走',
    },
    { idempotencyKey: idem(241) },
  );
  // 处置一条举报，证明注销**不动**处置轨迹（state 保留）。
  const triaged = await h.service.advanceReport(reportByA.id, { action: 'triage', expected_revision: 1 });
  return { h, postA, postB, commentByB, commentByA, reportByA, triaged };
}

test('闭集：注入社区清理端口 ⇒ 追加 community（五域）；不注入 ⇒ 仍是四域（既有替身零改动）', async () => {
  const { h } = await seedCommunity();
  const withoutCommunity = createUserDataDeletion({ ...otherStores() });
  assert.deepEqual(withoutCommunity.requiredModules(), [...USER_DATA_DELETION_MODULES]);
  assert.deepEqual(withoutCommunity.requiredModules(), ['favorites', 'history', 'messages', 'conversations']);

  const withCommunity = createUserDataDeletion({
    ...otherStores(),
    communityStore: communityDeletionPort(h),
  });
  assert.deepEqual(withCommunity.requiredModules(), [...USER_DATA_DELETION_MODULES, COMMUNITY_DELETION_MODULE]);
  assert.equal(COMMUNITY_DELETION_MODULE, 'community');
  assert.deepEqual(withCommunity.coordinator.missingRegistrations(), []);
});

test('正控制：安全帖子/评论保留、A 的点赞与举报自述清理，B 的不受影响；未完成项如实 blocked', async () => {
  const { h, postA, postB, commentByB, commentByA, reportByA, triaged } = await seedCommunity();
  const deletion = createUserDataDeletion({
    ...otherStores(),
    communityStore: communityDeletionPort(h),
  });

  const request = deletion.requestDeletionFor(USER_A.userId);
  await deletion.executeHandlers(String(request.id));

  // 1) 帖子：A 的 P1 **保留**（可见性/版本/正文不动）；B 的 P2 原样。
  const storedPostA = await h.store.getPost(postA.id);
  assert.equal(storedPostA.visibility, 'published', 'F13：安全帖子保留公开，不得软删');
  assert.equal(storedPostA.revision, postA.revision, '保留行不得为"标记"推进 revision');
  assert.equal(storedPostA.author_id, USER_A.userId, '保留行仍在库（作者去身份在投影层）');
  const storedPostB = await h.store.getPost(postB.id);
  assert.equal(storedPostB.visibility, 'published', 'B 的帖子不受影响');

  // 2) 评论：A 的保留，B 的也在（他人回复不得被注销带走）。
  const storedCommentByA = await h.store.getComment(commentByA.id);
  assert.equal(storedCommentByA.visibility, 'published');
  assert.equal(storedCommentByA.revision, commentByA.revision);
  const storedCommentByB = await h.store.getComment(commentByB.id);
  assert.equal(storedCommentByB.visibility, 'published', '他人的回复不受影响');

  // 3) 点赞：A 的物理删除，B 的保留（2 → 1）。
  assert.equal(await h.store.countLikes('post', postB.id), 1, '只清本人那一条点赞');

  // 4) 举报：A 的自述字段抹掉、state 保留；B 的举报一字不动。
  const storedReportByA = await h.store.getReport(reportByA.id);
  assert.equal(storedReportByA.detail, null, '举报人自述必须抹除');
  assert.equal(storedReportByA.state, 'isolated', '处置轨迹保留（注销不推翻审核结论）');
  assert.equal(storedReportByA.revision, triaged.revision + 1);
  const otherReport = (await h.store.listReportsByReporter?.(USER_B.userId) ?? [])[0];
  if (otherReport !== undefined) {
    assert.equal(otherReport.detail, '别人的举报说明，不应被他人注销带走', '他人的举报说明不受影响');
  }

  // 5) 作者投影：A 已去身份（注销引用），B 仍是原假名。
  const anon = await h.authors.resolve(USER_A.userId);
  assert.equal(anon.state, 'anonymized');
  assert.equal(anon.display_name, '已注销用户');
  assert.equal((await h.authors.resolve(USER_B.userId)).state, 'active');

  // 6) 回执：社区模块**因未完成项 blocked**（不是 completed，也不是失败）。
  const receipt = deletion.receipt(String(request.id));
  const row = receipt.handlers.find((entry) => entry.module === COMMUNITY_DELETION_MODULE);
  assert.ok(row !== undefined, '回执必须含 community 行');
  assert.equal(row.online_state, 'blocked', '行级作者引用未替换 ⇒ 如实 blocked');
  assert.equal(row.error_code, 'POLICY_BLOCKED');
  assert.equal(row.backup_state, 'pending', '备份副本清除未接线 ⇒ 如实 pending，不谎称完成');

  // 7) 证据串：真实改动行数（点赞 + 举报）+ 保留读数 + blocked 分列。
  const evidence = deletion.evidenceOf(String(request.id))[COMMUNITY_DELETION_MODULE];
  assert.ok(evidence.includes('community:retained:2'), `保留 1 帖 + 1 评论：${evidence}`);
  assert.ok(evidence.includes('community:online-purged:2'), `点赞 1 + 举报自述 1：${evidence}`);
  assert.ok(evidence.includes('community:blocked:1'), `未完成项单列：${evidence}`);
  const communityAudit = deletion.audit().find((entry) => entry.module === COMMUNITY_DELETION_MODULE);
  assert.equal(communityAudit.retained, 2);
  assert.equal(communityAudit.redacted, 0);
  assert.equal(communityAudit.hiddenMedia, 0);
  assert.equal(communityAudit.blocked, 1);
});

test('幂等：同一主体再注销一次，真实改动归零；保留读数稳定、blocked 不消失', async () => {
  const { h } = await seedCommunity();
  const deletion = createUserDataDeletion({
    ...otherStores(),
    communityStore: communityDeletionPort(h),
  });
  const first = deletion.requestDeletionFor(USER_A.userId);
  await deletion.executeHandlers(String(first.id));
  const firstAudit = deletion.audit().find((entry) => entry.module === COMMUNITY_DELETION_MODULE);
  assert.ok(firstAudit.retained >= 2);

  const second = deletion.requestDeletionFor(USER_A.userId);
  await deletion.executeHandlers(String(second.id));
  const secondAudit = deletion
    .audit()
    .filter((entry) => entry.module === COMMUNITY_DELETION_MODULE)
    .at(-1);
  assert.equal(secondAudit.onlineRemoved, 0, '已清过的点赞/自述不重复计数');
  assert.equal(secondAudit.retained, firstAudit.retained, '保留读数反映当前状态，不虚报为 0');
  assert.equal(secondAudit.redacted, 0, '没有新的个人信息可清');
  assert.equal(secondAudit.blocked, 1, '未完成项不会因为重跑而变成完成');
});

test('主体必须绑定：空主体在受理时就被拒（拿不到"清理范围未知"的请求，社区行一行不动）', async () => {
  const { h, postA } = await seedCommunity();
  const deletion = createUserDataDeletion({
    ...otherStores(),
    communityStore: communityDeletionPort(h),
  });
  assert.throws(() => deletion.requestDeletionFor(''), /必须绑定非空主体/);
  assert.throws(() => deletion.requestDeletionFor(null), /必须绑定非空主体/);
  const stored = await h.store.getPost(postA.id);
  assert.equal(stored.visibility, 'published', '没有主体就没有清理范围');
  assert.equal(stored.revision, postA.revision, '拒绝受理时一行都不动');
});
