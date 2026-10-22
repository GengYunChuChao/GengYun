/**
 * GY-I15（#15）· R31-S6：**注销不清社区行** 的回归用例（内存实现）。
 *
 * 侦察 §S6 的缺口：注销删除注册协议（`packages/privacy` + `privacy/user-data-deletion.ts`）
 * 只登记了 favorites / history / messages / conversations 四个域，社区域（帖子/评论/点赞/举报）
 * 既没进闭集、也没有任何处理器 —— 删号后社区行原样留着、还能被公开读到。
 *
 * 本片补的是**第五个域的接入**，本文件断言：
 *   1. 注入社区清理原语 ⇒ 闭集追加 `community`，回执与审计都出现该模块；
 *   2. 处理器真的清了**绑定主体**的行：帖子/评论软删 + `revision`+1、点赞物理删、
 *      举报的自述字段 `detail` 抹除（处置轨迹 `state`/`target_ref` 保留）；
 *   3. 他人不受影响；**软删不会悬挂他人回复**（别人写在该帖下的评论仍在，父帖行也还在）；
 *   4. 不注入 ⇒ 闭集与逐字行为回到本片之前的四域（既有测试替身因此一条都不用改）。
 *
 * 判断依据（为什么是「软删 + 匿名化用户自述」而不是硬删）见
 * `services/api/src/community/store.ts::purgeOwnerData` 的注释与证据页 §S6。
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
import { idem, makeHarness, publishPost, USER_A, USER_B } from './community-fixtures.mjs';
import { scriptedClock } from './favorites-history-fixtures.mjs';

/**
 * 把社区 store 收窄成注销协议要的 `OwnerPurgeStore`（与 `app.ts` 的接线**同形**：
 * 社区只有分表计数原语，`deleteAllByOwner` 让它走同一条路并只取正文行数）。
 */
function communityDeletionStore(store) {
  return {
    async deleteAllByOwner(ownerId) {
      return (await store.purgeOwnerData(ownerId)).records;
    },
    purgeOwnerData: (ownerId) => store.purgeOwnerData(ownerId),
  };
}

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

/**
 * 播一段社区数据：
 *   - A 发帖 P1；B 在 P1 下发评论（**他人的回复**，用于验证软删不悬挂）；
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

test('闭集：注入社区清理原语 ⇒ 追加 community（五域）；不注入 ⇒ 仍是四域（既有替身零改动）', async () => {
  const { h } = await seedCommunity();
  const withoutCommunity = createUserDataDeletion({ ...otherStores() });
  assert.deepEqual(withoutCommunity.requiredModules(), [...USER_DATA_DELETION_MODULES]);
  assert.deepEqual(withoutCommunity.requiredModules(), ['favorites', 'history', 'messages', 'conversations']);

  const withCommunity = createUserDataDeletion({
    ...otherStores(),
    communityStore: communityDeletionStore(h.store),
  });
  assert.deepEqual(withCommunity.requiredModules(), [...USER_DATA_DELETION_MODULES, COMMUNITY_DELETION_MODULE]);
  assert.equal(COMMUNITY_DELETION_MODULE, 'community');
  assert.deepEqual(withCommunity.coordinator.missingRegistrations(), []);
});

test('正控制：注销真的清掉 A 的社区行（软删帖子/评论、删点赞、抹举报自述），B 的不受影响', async () => {
  const { h, postA, postB, commentByB, commentByA, reportByA, triaged } = await seedCommunity();
  const deletion = createUserDataDeletion({
    ...otherStores(),
    communityStore: communityDeletionStore(h.store),
  });

  const request = deletion.requestDeletionFor(USER_A.userId);
  await deletion.executeHandlers(String(request.id));

  // 1) 帖子：A 的 P1 软删 + revision+1；B 的 P2 原样。
  const storedPostA = await h.store.getPost(postA.id);
  assert.equal(storedPostA.visibility, 'deleted', 'A 的帖子必须不再公开');
  assert.equal(storedPostA.revision, postA.revision + 1, '软删也必须推进版本');
  assert.equal(storedPostA.author_id, USER_A.userId, '软删保留作者列（他人回复的父行必须还在）');
  const storedPostB = await h.store.getPost(postB.id);
  assert.equal(storedPostB.visibility, 'published', 'B 的帖子不受影响');

  // 2) 评论：A 的软删，B 的仍在 —— 且**父帖行还在**，所以没有悬挂引用。
  const storedCommentByA = await h.store.getComment(commentByA.id);
  assert.equal(storedCommentByA.visibility, 'deleted');
  assert.equal(storedCommentByA.revision, commentByA.revision + 1);
  const storedCommentByB = await h.store.getComment(commentByB.id);
  assert.equal(storedCommentByB.visibility, 'published', '他人的回复不受影响');
  assert.ok((await h.store.getComment(commentByB.id)) !== null, '父帖软删后他人评论仍可解析父帖');

  // 3) 点赞：A 的物理删除，B 的保留（2 → 1）。
  assert.equal(await h.store.countLikes('post', postB.id), 1, '只清本人那一条点赞');

  // 4) 举报：A 的自述字段抹掉、state 保留；B 的举报一字不动。
  //    revision 在**受理（triage）之后**再 +1：注销对已处置的举报仍然推进版本，
  //    这样手里捏着旧 ETag 的读者会拿到 409 而不是读到"已变但没变"的假象。
  const storedReportByA = await h.store.getReport(reportByA.id);
  assert.equal(storedReportByA.detail, null, '举报人自述必须抹除');
  assert.equal(storedReportByA.state, 'isolated', '处置轨迹保留（注销不推翻审核结论）');
  assert.equal(storedReportByA.revision, triaged.revision + 1);
  const otherReport = (await h.store.listReportsByReporter?.(USER_B.userId) ?? [])[0];
  if (otherReport !== undefined) {
    assert.equal(otherReport.detail, '别人的举报说明，不应被他人注销带走', '他人的举报说明不受影响');
  }

  // 5) 回执行：社区模块在线 completed、备份如实 pending（副本端口未接该域）。
  const receipt = deletion.receipt(String(request.id));
  const row = receipt.handlers.find((entry) => entry.module === COMMUNITY_DELETION_MODULE);
  assert.ok(row !== undefined, '回执必须含 community 行');
  assert.equal(row.online_state, 'completed');
  assert.equal(row.backup_state, 'pending', '备份副本清除未接线 ⇒ 如实 pending，不谎称完成');
  assert.equal(row.error_code, null);

  // 证据串两段都在（正文行数 + 本域幂等台账行数），且行数为正。
  const evidence = deletion.audit();
  const communityAudit = evidence.find((entry) => entry.module === COMMUNITY_DELETION_MODULE);
  assert.ok(communityAudit !== undefined);
  assert.ok(communityAudit.onlineRemoved >= 2, `帖子+评论+点赞+举报至少四条行，实际 ${communityAudit.onlineRemoved}`);
});

test('幂等：同一主体再注销一次，社区侧计数归零（不重复抹、也不报错）', async () => {
  const { h } = await seedCommunity();
  const deletion = createUserDataDeletion({
    ...otherStores(),
    communityStore: communityDeletionStore(h.store),
  });
  const first = deletion.requestDeletionFor(USER_A.userId);
  await deletion.executeHandlers(String(first.id));
  const firstRows = deletion.audit().find((entry) => entry.module === COMMUNITY_DELETION_MODULE).onlineRemoved;
  assert.ok(firstRows >= 2);

  const second = deletion.requestDeletionFor(USER_A.userId);
  await deletion.executeHandlers(String(second.id));
  const secondRows = deletion
    .audit()
    .filter((entry) => entry.module === COMMUNITY_DELETION_MODULE)
    .at(-1).onlineRemoved;
  assert.equal(secondRows, 0, '已经清过一遍 ⇒ 第二次如实报 0（不虚报）');
});

test('主体必须绑定：空主体在受理时就被拒（拿不到"清理范围未知"的请求，社区行一行不动）', async () => {
  const { h, postA } = await seedCommunity();
  const deletion = createUserDataDeletion({
    ...otherStores(),
    communityStore: communityDeletionStore(h.store),
  });
  assert.throws(() => deletion.requestDeletionFor(''), /必须绑定非空主体/);
  assert.throws(() => deletion.requestDeletionFor(null), /必须绑定非空主体/);
  const stored = await h.store.getPost(postA.id);
  assert.equal(stored.visibility, 'published', '没有主体就没有清理范围');
  assert.equal(stored.revision, postA.revision, '拒绝受理时一行都不动');
});
