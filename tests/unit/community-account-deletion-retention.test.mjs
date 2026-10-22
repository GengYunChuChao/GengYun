/**
 * GY-I15（#15）· 注销保留规则（F13）· **P2 返修红测**。
 *
 * 背景（监工 `supervisor-1022-0932-pr474` P2）：本片上一版把作者所有帖子/评论无条件
 * `visibility='deleted'`，与已确认的 F13 保留规则冲突。F13 第 279–280 行原文：
 *   - 「帖子评论保留，头像默认，前台显示名／ID为"已注销用户"；内部作者换不可反查原账户的
 *      注销引用，删除账号映射，不把所有作者主键混为一个账号。」
 *   - 「保留正文／附件清除联系方式、精确位置等个人信息；不能可靠脱敏的媒体隐藏／移除。」
 *
 * 本文件断言的是**要求本身**，不是"实现顺手做了什么"：
 *   a. 已审核、无个人信息的纯文字帖子/评论 ⇒ 注销后仍公开可见；作者变为不可反查的注销引用；
 *      正文原样保留（且**不得**为了"保留"去推进 revision —— 审核结论绑定 revision + 正文摘要）。
 *   b. 含个人信息 / 不可靠脱敏媒体的内容 ⇒ 个人信息清除、媒体引用隐藏/移除；脱敏后旧审核
 *      结论不再成立 ⇒ 该行退出公开面（保留在库、等重审），与本仓"先审后发"一致。
 *   c. 未完成/无法判定的处理 ⇒ `blocked` 计数，且回执 `online_state` 为 `blocked`（不是 completed）。
 *   d. 原账户 ID 不可从注销引用反查：引用是**随机**的（不是 userId 的摘要）、逐作者独立
 *      （不共用主键）、解析稳定，且不包含原 ID。
 *
 * **这是红测**：它先于实现落地；在实现补齐前必须失败（`community/purge.ts`、`personal-info.ts`
 * 与保留语义尚不存在）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import {
  COMMUNITY_DELETION_MODULE,
  createUserDataDeletion,
} from '../../services/api/src/privacy/user-data-deletion.ts';
import { createCommunityOwnerPurgePort } from '../../services/api/src/community/purge.ts';
import { redactPersonalInfo } from '../../services/api/src/community/personal-info.ts';
import { CLEAN_BODY, CLEAN_TITLE, USER_A, USER_B, idem, makeHarness, publishPost } from './community-fixtures.mjs';
import { scriptedClock } from './favorites-history-fixtures.mjs';

/** 第三个主体：只用于"逐作者独立引用"的对照（不参与其它用例）。 */
const USER_C = Object.freeze({ userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', role: 'user', authEpoch: 1 });

/** 契约要求 `media_ids` 每项是 uuid；这里用固定合成值（不代表任何真实媒体）。 */
const MEDIA_PII = '00000000-0000-4000-8000-00000000c001';
const MEDIA_CLEAN = '00000000-0000-4000-8000-00000000c002';

/** 规则层**拦不到**的个人信息形态（邮箱/座机/小区门牌），用于"已通过审核、事后仍含 PII"的存量行。 */
const PII_BODY = '有事联系我：邮箱 nongyou@example.com，座机 0571-88886666，住址 阳光小区3栋2单元501室。';
const PII_TITLE = '苗情记录（含联系方式）';

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

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
 * 直接落一条"已审核通过"的存量内容行（**合成夹具**）：模拟"审核当时通过、事后发现含 PII"。
 * 规则层现在会拦 MR-04/MR-05，但存量行与规则外形态（邮箱/座机/小区门牌）必须仍能被注销处理。
 *
 * 结论按 `gate.currentRuleVersion()` 造，正文摘要按帖子口径 `title + LF + body` 绑定 ——
 * 与 `service.ts::postModerationText` 同源，不是另编一套。
 */
async function insertApprovedPost(h, { id, authorId, title, body, mediaIds = [], createdAt = '2026-10-12T04:00:00.000Z' }) {
  const record = {
    id,
    revision: 1,
    author_id: authorId,
    title,
    body,
    crop_id: null,
    region_code: null,
    media_ids: [...mediaIds],
    linked_knowledge_ref: null,
    visibility: 'published',
    audit_state: 'approved',
    created_at: createdAt,
    updated_at: createdAt,
  };
  const moderation = {
    id: `${id.slice(0, 24)}0e01`,
    target_ref: { type: 'post', id, revision: 1 },
    decision: 'approved',
    reason_codes: [],
    hard_rule_passed: true,
    rule_version: h.gate.currentRuleVersion(),
    text_digest: sha256Hex(`${title}\n${body}`),
    contract_complete: false,
    missing_contract_fields: [],
    created_at: createdAt,
  };
  assert.equal(await h.store.insertPost(record, moderation), true, '合成存量行必须落库');
  return record;
}

/** 走**真实装配路径**的社区注销端口（与 `app.ts` 的接线同形：purge + 作者目录去身份）。 */
function deletionWithCommunity(h) {
  const communityStore = createCommunityOwnerPurgePort({ store: h.store, authors: h.authors });
  const deletion = createUserDataDeletion({ ...otherStores(), communityStore });
  return { deletion, communityStore };
}

async function purgeOwner(h, ownerId) {
  const { deletion, communityStore } = deletionWithCommunity(h);
  const request = deletion.requestDeletionFor(ownerId);
  await deletion.executeHandlers(String(request.id));
  return { deletion, communityStore, request };
}

function communityRow(deletion, requestId) {
  const receipt = deletion.receipt(String(requestId));
  const row = receipt.handlers.find((entry) => entry.module === COMMUNITY_DELETION_MODULE);
  assert.ok(row !== undefined, '回执必须含 community 行');
  return row;
}

// ---------------------------------------------------------------------------
// a. 安全帖子/评论保留
// ---------------------------------------------------------------------------
test('a. 保留：已审核、无个人信息的纯文字帖子/评论，注销后仍公开可见，作者为注销引用，正文原样', async () => {
  const h = makeHarness();
  const postA = await publishPost(h.service, USER_A, {}, idem(300));
  const postB = await publishPost(h.service, USER_B, {}, idem(301));
  const commentA = await h.service.createComment(
    USER_A,
    postB.id,
    { body: '我这边苗情也差不多，按标签说明处理。' },
    { idempotencyKey: idem(302), ifMatch: `"${postB.revision}"` },
  );

  // 注销前基线：B 能公开读到 A 的帖子与评论。
  assert.equal((await h.service.getPost(USER_B, postA.id)).id, postA.id);
  assert.equal((await h.service.getComment(USER_B, commentA.id)).id, commentA.id);

  const { deletion, request } = await purgeOwner(h, USER_A.userId);

  // 存储行：可见性、正文、附件**都不因注销改变**（保留，不是软删）。
  const stored = await h.store.getPost(postA.id);
  assert.equal(stored.visibility, 'published', 'F13：安全帖子保留公开，不得软删');
  assert.equal(stored.revision, postA.revision, '保留行不得为"标记"推进 revision（那会让审核结论对不上）');
  assert.equal(stored.title, CLEAN_TITLE);
  assert.equal(stored.body, CLEAN_BODY);
  assert.deepEqual(stored.media_ids, []);

  // 公开读取：仍可见，作者为注销引用，正文原样。
  const after = await h.service.getPost(USER_B, postA.id);
  assert.equal(after.title, CLEAN_TITLE);
  assert.equal(after.body, CLEAN_BODY);
  assert.equal(after.visibility, 'published');
  assert.equal(after.author.display_name, '已注销用户');
  assert.equal(after.author.state, 'anonymized');
  assert.equal(after.author.avatar_media_id, null, 'F13：默认头像（不保留原头像）');

  const commentAfter = await h.service.getComment(USER_B, commentA.id);
  assert.equal(commentAfter.body, '我这边苗情也差不多，按标签说明处理。');
  assert.equal(commentAfter.author.state, 'anonymized');
  assert.equal(commentAfter.author.display_name, '已注销用户');

  // 他人的内容与作者不受影响（对照）。
  const postBAfter = await h.service.getPost(USER_A, postB.id);
  assert.equal(postBAfter.author.state, 'active', 'B 的作者投影不得被 A 的注销带去身份');

  // 计数：保留行如实计数；blocked 单列（见 c）。
  const audit = deletion.audit().find((entry) => entry.module === COMMUNITY_DELETION_MODULE);
  assert.equal(audit.retained, 2, `A 的 1 帖 + 1 评论都应算保留，实际 ${JSON.stringify(audit)}`);
  assert.equal(audit.redacted, 0);
  assert.equal(audit.hiddenMedia, 0);

  const row = communityRow(deletion, request.id);
  assert.equal(row.online_state, 'blocked', '见 c：行级作者映射未替换 ⇒ 不得冒充 completed');
});

// ---------------------------------------------------------------------------
// b. 个人信息 / 媒体
// ---------------------------------------------------------------------------
test('b. 个人信息：正文个人信息清除、不可可靠脱敏媒体移除；脱敏后旧审核失效 ⇒ 退出公开面（保留待重审）', async () => {
  const h = makeHarness();
  const piiPost = await insertApprovedPost(h, {
    id: '00000000-0000-4000-8000-0000000f0001',
    authorId: USER_A.userId,
    title: PII_TITLE,
    body: PII_BODY,
    mediaIds: [MEDIA_PII],
  });
  const cleanMediaPost = await insertApprovedPost(h, {
    id: '00000000-0000-4000-8000-0000000f0002',
    authorId: USER_A.userId,
    title: CLEAN_TITLE,
    body: CLEAN_BODY,
    mediaIds: [MEDIA_CLEAN],
  });

  // 基线：两行都公开可见（合成存量行，结论按当前规则版本绑定）。
  assert.equal((await h.service.getPost(USER_B, piiPost.id)).id, piiPost.id);
  assert.equal((await h.service.getPost(USER_B, cleanMediaPost.id)).id, cleanMediaPost.id);

  const { deletion, request } = await purgeOwner(h, USER_A.userId);

  // 1) 个人信息：正文里不再有邮箱/座机/门牌；替换为显式占位符（不是"静默改字"）。
  const storedPii = await h.store.getPost(piiPost.id);
  for (const secret of ['nongyou@example.com', '0571-88886666', '阳光小区3栋2单元501室']) {
    assert.equal(storedPii.body.includes(secret), false, `个人信息必须清除：${secret} 仍在正文里`);
  }
  assert.ok(storedPii.body.includes('个人信息已清除'), '清除必须可见（占位符），不能静默改字');
  assert.deepEqual(storedPii.media_ids, [], '不可可靠脱敏的媒体引用必须移除');
  assert.equal(storedPii.revision, 2, '正文改了 ⇒ 必须推进 revision（旧 ETag 失效，避免读到旧审核结论）');
  // 行仍在（保留，不是删除）。
  assert.equal(storedPii.visibility, 'published', '行保留在库（不是软删）；是否公开由"先审后发"重算');

  // 2) 脱敏后旧结论按摘要绑定 ⇒ 不再公开（保留待重审），不是"删掉了"。
  await assert.rejects(h.service.getPost(USER_B, piiPost.id), (error) => error?.code === 'NOT_FOUND');
  const listed = await h.service.listPosts(USER_B, { limit: 50 });
  assert.equal(listed.items.some((item) => item.id === piiPost.id), false, '脱敏行在重审前不得再公开');

  // 3) 仅媒体（正文安全）：正文保留、仍可见；媒体隐藏，revision 不变（正文摘要未变，结论仍有效）。
  const storedClean = await h.store.getPost(cleanMediaPost.id);
  assert.equal(storedClean.body, CLEAN_BODY, '正文安全 ⇒ 保留原样');
  assert.deepEqual(storedClean.media_ids, [], '媒体引用移除');
  assert.equal(storedClean.revision, 1, '媒体移除不改正文摘要 ⇒ 不推进 revision（否则安全正文会因查不到结论而消失）');
  const visibleClean = await h.service.getPost(USER_B, cleanMediaPost.id);
  assert.equal(visibleClean.visibility, 'published', '正文安全的内容不因"隐藏附件"整条消失');
  assert.deepEqual(visibleClean.media_ids, []);

  // 4) 计数：redacted / hiddenMedia 分开报，不混进"全部软删"。
  const audit = deletion.audit().find((entry) => entry.module === COMMUNITY_DELETION_MODULE);
  assert.equal(audit.redacted, 1, '1 条正文脱敏');
  assert.equal(audit.hiddenMedia, 2, '两条媒体引用被移除（PII 行 1 + 安全行 1）');
  assert.equal(audit.retained, 1, '仅媒体行仍算正文保留');

  const row = communityRow(deletion, request.id);
  assert.equal(row.online_state, 'blocked');
});

// ---------------------------------------------------------------------------
// c. blocked 计数与"不得冒充 completed"
// ---------------------------------------------------------------------------
test('c. blocked：未完成的处理项单列计数，回执 online_state=blocked，且不得把保留计数当完成证据', async () => {
  const h = makeHarness();
  await publishPost(h.service, USER_A, {}, idem(320));
  const { deletion, request, communityStore } = await purgeOwner(h, USER_A.userId);

  const audit = deletion.audit().find((entry) => entry.module === COMMUNITY_DELETION_MODULE);
  assert.equal(audit.blocked, 1, '行级内部作者引用无法替换（FK users + 无 UPDATE(author_id) 列授权）⇒ blocked=1');
  assert.ok(
    String(audit.blockedReasons ?? '').includes('author-row-reference-not-replaced'),
    `blocked 必须带可核对的理由，实际 ${JSON.stringify(audit.blockedReasons)}`,
  );

  const row = communityRow(deletion, request.id);
  assert.equal(row.online_state, 'blocked', '有未完成项 ⇒ online_state 必须是 blocked');
  assert.equal(row.error_code, 'POLICY_BLOCKED', '失败码必须在协议安全码闭集内');
  assert.equal(deletion.completionStatus(String(request.id)).completed, false, '不得判完成');

  const evidence = deletion.evidenceOf(String(request.id))[COMMUNITY_DELETION_MODULE];
  assert.ok(evidence.includes('community:online-purged:'), `证据串必须保留真实处理读数：${evidence}`);
  assert.ok(evidence.includes('community:retained:1'), `证据串必须单列保留读数：${evidence}`);
  assert.ok(evidence.includes('community:blocked:1'), `证据串必须单列 blocked：${evidence}`);

  // 直接读取：端口返回的三类计数（不依赖回执形状）。
  const counts = await communityStore.purgeOwnerData(USER_A.userId);
  assert.equal(counts.retained, 1);
  assert.equal(counts.redacted, 0);
  assert.equal(counts.hiddenMedia, 0);
  assert.equal(counts.blocked, 1);
});

test('c2. 处理失败：存储清理抛错 ⇒ 该模块 blocked + HANDLER_FAILED，不出现 completed 证据', async () => {
  const deletion = createUserDataDeletion({
    ...otherStores(),
    communityStore: {
      async deleteAllByOwner() {
        throw new Error('模拟存储失败');
      },
      async purgeOwnerData() {
        throw new Error('模拟存储失败');
      },
    },
  });
  const request = deletion.requestDeletionFor(USER_A.userId);
  await deletion.executeHandlers(String(request.id));
  const receipt = deletion.receipt(String(request.id));
  const row = receipt.handlers.find((entry) => entry.module === COMMUNITY_DELETION_MODULE);
  assert.equal(row.online_state, 'blocked');
  assert.equal(row.error_code, 'HANDLER_FAILED');
  assert.equal(deletion.evidenceOf(String(request.id))[COMMUNITY_DELETION_MODULE], undefined, '失败不得留下"已完成"证据');
});

// ---------------------------------------------------------------------------
// d. 注销引用不可反查
// ---------------------------------------------------------------------------
test('d. 注销引用：随机（不是原 ID 的摘要）、逐作者独立、解析稳定、不包含原 ID', async () => {
  const h = makeHarness();
  await publishPost(h.service, USER_A, {}, idem(330));
  await publishPost(h.service, USER_C, {}, idem(331));

  await purgeOwner(h, USER_A.userId);
  await purgeOwner(h, USER_C.userId);

  const anonA = await h.authors.resolve(USER_A.userId);
  const anonC = await h.authors.resolve(USER_C.userId);
  assert.equal(anonA.state, 'anonymized');
  assert.equal(anonA.display_name, '已注销用户');
  assert.equal(anonA.avatar_media_id, null);
  assert.equal(anonC.state, 'anonymized');
  assert.notEqual(anonA.display_id, anonC.display_id, '不同注销作者不得共用同一个引用（F13：不混为一个账号）');

  for (const [label, author, userId] of [
    ['A', anonA, USER_A.userId],
    ['C', anonC, USER_C.userId],
  ]) {
    assert.equal(author.display_id.includes(userId), false, `${label}：引用不得包含原账户 ID`);
    assert.equal(author.display_id.includes(userId.slice(0, 8)), false, `${label}：引用不得包含原 ID 前缀`);
    // 旧实现是 userId 的 sha256 截断；"可反查/可确认"即不合格。
    const digest = createHash('sha256')
      .update(`gengyun.community.pseudonymous-author.v1\u0000${userId}`, 'utf8')
      .digest('hex');
    assert.notEqual(author.display_id, `gy-anon-${digest.slice(0, 10)}`, `${label}：引用不得由原 ID 摘要派生`);
    assert.equal(author.display_id.includes(digest.slice(0, 10)), false, `${label}：引用不得包含原 ID 摘要`);
    // 稳定：同一作者反复解析得到同一引用（不能每次读都换一个）。
    assert.equal((await h.authors.resolve(userId)).display_id, author.display_id, `${label}：引用必须稳定`);
    assert.ok(author.display_id.length >= 1 && author.display_id.length <= 80, '契约 display_id 1..80');
  }

  // 未注销的 B 保持原样（不得被"统一改成已注销"）。
  const activeB = await h.authors.resolve(USER_B.userId);
  assert.equal(activeB.state, 'active');
  assert.notEqual(activeB.display_name, '已注销用户');
});

// ---------------------------------------------------------------------------
// 边界：作者主动删除的旧路径不得被改写/复活
// ---------------------------------------------------------------------------
test('边界：作者主动删除（visibility=deleted）的内容，注销后仍是 deleted，不复活、不重复计数', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(340));
  await h.service.deletePost(USER_A, post.id, { idempotencyKey: idem(341), ifMatch: `"${post.revision}"` });
  const deleted = await h.store.getPost(post.id);
  assert.equal(deleted.visibility, 'deleted');

  const { deletion } = await purgeOwner(h, USER_A.userId);

  const after = await h.store.getPost(post.id);
  assert.equal(after.visibility, 'deleted', '注销不得复活作者已删除的内容');
  assert.equal(after.revision, deleted.revision, '注销不得改写作者删除路径的版本');
  const audit = deletion.audit().find((entry) => entry.module === COMMUNITY_DELETION_MODULE);
  assert.equal(audit.retained, 0, '已删除行不计入保留');
  assert.equal(audit.redacted, 0);
});

// ---------------------------------------------------------------------------
// 幂等 + 无内容路径
// ---------------------------------------------------------------------------
test('幂等：重跑不重复脱敏/不重复移除媒体；保留读数稳定；无内容主体如实 completed', async () => {
  const h = makeHarness();
  await publishPost(h.service, USER_A, {}, idem(350));
  const { deletion, communityStore } = await purgeOwner(h, USER_A.userId);
  const first = deletion.audit().find((entry) => entry.module === COMMUNITY_DELETION_MODULE);
  assert.equal(first.retained, 1);
  assert.equal(first.onlineRemoved, 0, '保留行没有"被删/被改"，online-purged（真实改动行数）如实为 0');

  const secondCounts = await communityStore.purgeOwnerData(USER_A.userId);
  assert.equal(secondCounts.records, 0);
  assert.equal(secondCounts.redacted, 0);
  assert.equal(secondCounts.hiddenMedia, 0);
  assert.equal(secondCounts.retained, 1, '保留读数反映当前状态，不虚报为 0');
  assert.equal(secondCounts.idempotency, 0);

  // 无社区内容的主体：没有需要保留/去身份的行 ⇒ blocked=0，模块如实 completed。
  const h2 = makeHarness();
  const { deletion: emptyDeletion, request } = await purgeOwner(h2, USER_B.userId);
  const row = communityRow(emptyDeletion, request.id);
  assert.equal(row.online_state, 'completed');
  assert.equal(row.error_code, null);
});

// ---------------------------------------------------------------------------
// 纯函数：个人信息识别（防止"只测了主流程、脱敏本身没测"）
// ---------------------------------------------------------------------------
test('redactPersonalInfo：手机/座机/邮箱/身份证/门牌被清除；干净文本一字不动', () => {
  const input = '联系 13800138000、0571-88886666、nongyou@example.com、身份证 330106199001011234，住阳光小区3栋2单元501室。';
  const result = redactPersonalInfo(input);
  assert.ok(result.removed >= 5, `至少 5 处个人信息，实际 ${result.removed}`);
  for (const secret of ['13800138000', '0571-88886666', 'nongyou@example.com', '330106199001011234', '阳光小区3栋2单元501室']) {
    assert.equal(result.text.includes(secret), false, `未清除：${secret}`);
  }
  assert.ok(result.text.includes('个人信息已清除'));

  const clean = redactPersonalInfo(CLEAN_BODY);
  assert.equal(clean.removed, 0);
  assert.equal(clean.text, CLEAN_BODY, '干净文本必须逐字不动');
});
