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
 *   4. 行级作者指针在同一事务里换成**行内注销引用**（迁移 0030）⇒ 正常路径 `blocked = 0`、
 *      回执 `online_state = completed`；能力缺失/生成失败仍如实 `blocked`
 *      （反向控制见 `community-account-deletion-retention.test.mjs` 的 c2/c3）；
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
  // 迁移 0030：作者指针已在**行级**替换（不再是"只靠投影层去身份"）。
  assert.equal(storedPostA.author_id, null, 'F13：行级 account 指针必须置空（删除账号映射）');
  assert.match(String(storedPostA.anonymized_author_ref), /^gy-anon-[0-9a-f]{16}$/, '行内必须留下注销引用');
  const storedPostB = await h.store.getPost(postB.id);
  assert.equal(storedPostB.visibility, 'published', 'B 的帖子不受影响');
  assert.equal(storedPostB.author_id, USER_B.userId, 'B 的作者指针不得被 A 的注销带走');

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
  // 迁移 0032（R32 · #15 残留）：举报者指针也必须断开，并落行内注销引用（与帖/评同一串）。
  assert.equal(storedReportByA.reporter_id, null, '举报者指针必须置空（否则已注销账户仍关联到"谁举报了什么"）');
  assert.match(
    String(storedReportByA.anonymized_author_ref),
    /^gy-anon-[0-9a-f]{16}$/,
    '举报行必须落形状合法的注销引用',
  );
  assert.equal(
    storedReportByA.anonymized_author_ref,
    storedPostA.anonymized_author_ref,
    '同一注销主体的帖与举报必须共用同一个引用（不分裂成两个注销身份）',
  );
  const otherReport = (await h.store.listReportsByReporter?.(USER_B.userId) ?? [])[0];
  if (otherReport !== undefined) {
    assert.equal(otherReport.detail, '别人的举报说明，不应被他人注销带走', '他人的举报说明不受影响');
  }

  // 5) 作者投影：A 已去身份（注销引用），B 仍是原假名。
  const anon = await h.authors.resolve(USER_A.userId);
  assert.equal(anon.state, 'anonymized');
  assert.equal(anon.display_name, '已注销用户');
  assert.equal((await h.authors.resolve(USER_B.userId)).state, 'active');

  // 6) 回执：作者指针已替换、引用已持久化 ⇒ 社区模块**如实 completed**（不再是 blocked）。
  const receipt = deletion.receipt(String(request.id));
  const row = receipt.handlers.find((entry) => entry.module === COMMUNITY_DELETION_MODULE);
  assert.ok(row !== undefined, '回执必须含 community 行');
  assert.equal(row.online_state, 'completed', '迁移 0030 后正常路径不得再 blocked');
  assert.equal(row.error_code, null, 'completed 时不得带阻断码');
  assert.equal(row.backup_state, 'pending', '备份副本清除未接线 ⇒ 如实 pending，不谎称完成');

  // 7) 证据串：真实改动行数（点赞 + 举报）+ 保留读数 + 作者指针替换行数，各自分列。
  const evidence = deletion.evidenceOf(String(request.id))[COMMUNITY_DELETION_MODULE];
  assert.ok(evidence.includes('community:retained:2'), `保留 1 帖 + 1 评论：${evidence}`);
  assert.ok(evidence.includes('community:online-purged:2'), `点赞 1 + 举报自述 1：${evidence}`);
  assert.ok(
    evidence.includes('community:author-refs-replaced:3'),
    `A 的 1 帖 + 1 评论 + 1 举报 = 3 行行级账户引用被替换（迁移 0032 起举报计入）：${evidence}`,
  );
  assert.equal(evidence.includes('community:blocked'), false, `归零后不得再写 blocked 段：${evidence}`);
  const communityAudit = deletion.audit().find((entry) => entry.module === COMMUNITY_DELETION_MODULE);
  assert.equal(communityAudit.retained, 2);
  assert.equal(communityAudit.redacted, 0);
  assert.equal(communityAudit.hiddenMedia, 0);
  assert.equal(communityAudit.authorRefsReplaced, 3, '1 帖 + 1 评论 + 1 举报（迁移 0032 起举报计入）');
  assert.equal(communityAudit.blocked, undefined, '没有未完成项 ⇒ 审计行不带 blocked');
});

test('幂等：同一主体再注销一次，真实改动归零；作者指针已替换 ⇒ 重跑不重复替换、不再 blocked', async () => {
  const { h } = await seedCommunity();
  const deletion = createUserDataDeletion({
    ...otherStores(),
    communityStore: communityDeletionPort(h),
  });
  const first = deletion.requestDeletionFor(USER_A.userId);
  await deletion.executeHandlers(String(first.id));
  const firstAudit = deletion.audit().find((entry) => entry.module === COMMUNITY_DELETION_MODULE);
  assert.ok(firstAudit.retained >= 2);
  assert.equal(
    firstAudit.authorRefsReplaced,
    3,
    '首轮把 A 的 1 帖 + 1 评论 + 1 举报的行级账户引用都替换掉（迁移 0032 起举报计入）',
  );

  const second = deletion.requestDeletionFor(USER_A.userId);
  await deletion.executeHandlers(String(second.id));
  const secondAudit = deletion
    .audit()
    .filter((entry) => entry.module === COMMUNITY_DELETION_MODULE)
    .at(-1);
  assert.equal(secondAudit.onlineRemoved, 0, '已清过的点赞/自述不重复计数');
  // 迁移 0030 的后果：A 名下已没有行（author_id 已置空）⇒ 重跑的 retained **如实为 0**。
  // 保留结果记录在首轮回执的证据串（`community:retained:*`），不是"每跑一次都要重报一遍保留"。
  assert.equal(secondAudit.retained, 0, '重跑时主体名下无行 ⇒ retained 如实为 0（不是虚报，也不是丢账）');
  assert.equal(secondAudit.redacted, 0, '没有新的个人信息可清');
  assert.equal(secondAudit.authorRefsReplaced, 0, '已匿名行不得被第二次替换（引用不分裂）');
  assert.equal(secondAudit.blocked, undefined, '正常路径重跑同样不产生未完成项');
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
