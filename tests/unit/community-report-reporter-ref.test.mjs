/**
 * GY-R32 · #15 在 PR #483 合入之后的**去身份残留**：`community_reports.reporter_id`。
 *
 * ## 残留是什么（本文件的红灯对象）
 *
 * `#483` 把 `community_posts`/`community_comments` 的行级作者引用换成「`author_id` 可空 OR
 * `anonymized_author_ref` 恰好一个非空」，注销时同事务替换；完成判据是**清理后重新测量**的
 * `authorRefsRemaining`。但举报表没跟着走：
 *   · 注销清理只 `UPDATE community_reports SET detail = NULL`（`store-pg.ts` 的 purge），
 *     `reporter_id` **原样保留** ⇒ 已注销账户与「谁举报了什么」之间仍有一条直接关联面；
 *   · `authorRefsRemaining` 只数 `community_posts` + `community_comments` ⇒ 即使 `reporter_id`
 *     残留，读数仍是 0，端口判 `completed`。**这就是缺口**：关联面在、读数看不见。
 *
 * ## 本文件断言什么（口径与 #483 同构，⛔ 不另创）
 *
 *   1. 有举报的主体（同时有帖/评）注销后：`reporter_id` 断开关联、行内落注销引用，
 *      且**与帖/评共用同一串**（逐主体独立，不逐行随机）；`detail` 照旧清空；
 *   2. **仅有举报、无帖评**的主体同样被处理（这正是旧代码 `records`/`authorRefsReplaced`
 *      都为 0、看起来"没什么可清"的那一形态）；
 *   3. 举报的**业务语义不被破坏**：行仍在、`state`/`reason_code`/`target_ref`/`created_at` 不动，
 *      处置状态机照旧可推进；清理**不推进 revision**（除非同一次还要清 `detail`）；
 *   4. 重跑幂等：第二次替换 0 行、不换串、不报错；
 *   5. 完成判据覆盖举报：**只剩举报的残留 ⇒ `authorRefsRemaining = 1` ⇒ `blocked`**
 *      （⛔ 不得因为"读数只数帖评"而静默 completed —— 这是本片修的那条 fail-open）；
 *   6. 正常路径不被误判 blocked：真实内存实现 + 真实端口 ⇒ `completed`。
 *
 * 内存实现与 PG 实现**同口径**：PG 臂在 `tests/integration/community-pg.mjs`（真库）与
 * `tests/unit/community-author-refs-remaining-failclosed.test.mjs` 的 F 组（读数三表）里断言；
 * 迁移结构（可空 + 形状 CHECK + exactly_one）在 `tests/unit/community-report-reporter-ref-migration.test.mjs`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommunityOwnerPurgePort } from '../../services/api/src/community/purge.ts';
import { CLEAN_BODY, CLEAN_TITLE, USER_A, USER_B, idem, makeHarness, publishPost } from './community-fixtures.mjs';

/** 注销引用的形状（与迁移 CHECK、`authors.ts` 的 `ANONYMIZED_AUTHOR_REF_PATTERN` 同源）。 */
const REF_PATTERN = /^gy-anon-[0-9a-f]{16}$/;
const ROW_REASON = 'author-row-reference-not-replaced';
const UNAVAILABLE_REASON = 'author-reference-unavailable';

/** 走真实端口的注销（与 `app.ts` 同形：同一个 store + 同一个作者目录）。 */
async function purge(h, ownerId) {
  const port = createCommunityOwnerPurgePort({ store: h.store, authors: h.authors });
  return port.purgeOwnerData(ownerId);
}

/** 用**没有** `anonymize` 能力的作者目录跑注销 ⇒ 存储侧完全不替换行级引用（fail-closed 形态）。 */
async function purgeWithoutAnonymize(h, ownerId) {
  const port = createCommunityOwnerPurgePort({
    store: h.store,
    authors: { resolve: async () => null },
  });
  return port.purgeOwnerData(ownerId);
}

/** 让 `actor` 举报一条**当前公开可见**的帖子；返回契约 `Report`。 */
async function report(actor, service, post, detail, key) {
  return service.createReport(
    actor,
    {
      target_ref: { type: 'post', id: post.id, revision: post.revision },
      reason_code: 'dangerous',
      detail,
    },
    { idempotencyKey: idem(key) },
  );
}

test('1. 有帖/评/举报的主体注销后：reporter_id 断开关联、落行内注销引用且与帖评共用同一串', async () => {
  const h = makeHarness();
  const ownPost = await publishPost(h.service, USER_A, {}, idem(900));
  const ownComment = await h.service.createComment(
    USER_A,
    ownPost.id,
    { body: '补充一下：按标签说明处理即可。' },
    { idempotencyKey: idem(901), ifMatch: `"${ownPost.revision}"` },
  );
  // 举报必须指向**他人**的公开内容（举报自己的帖子在业务上没有意义）。
  const otherPost = await publishPost(h.service, USER_B, {}, idem(902));
  const filed = await report(USER_A, h.service, otherPost, '这个混配说法很危险，建议核一下。', 903);

  const counts = await purge(h, USER_A.userId);
  assert.equal(counts.blocked, 0, `正常路径不得 blocked（现场 ${JSON.stringify(counts.blockedReasons)}）`);
  assert.equal(counts.authorRefsReplaced, 3, '1 帖 + 1 评 + 1 举报 = 3 行行级引用被替换');
  assert.equal(counts.records, 1, '只有举报的 detail 被清空算"改写正文"；替换引用不算');
  assert.equal(counts.retained, 2, '帖 + 评仍计入保留（保留读数说的是正文是否原样）');
  assert.equal(counts.authorRefsRemaining, 0, '清理后不得再有行以原账户 id 关联该主体（含举报）');

  const storedReport = await h.store.getReport(filed.id);
  assert.equal(storedReport.reporter_id, null, '举报者指针必须断开（这就是本片要修的残留）');
  assert.match(String(storedReport.anonymized_author_ref), REF_PATTERN, '行内必须留下形状合法的注销引用');
  assert.equal(storedReport.detail, null, '举报自由文本照旧清空（既有口径不变）');

  const storedPost = await h.store.getPost(ownPost.id);
  assert.equal(storedPost.author_id, null);
  assert.equal(
    storedReport.anonymized_author_ref,
    storedPost.anonymized_author_ref,
    '同一注销主体的帖/评/举报必须共用**同一个**引用（逐主体独立，不逐行随机）',
  );
  assert.equal(
    storedReport.anonymized_author_ref,
    (await h.store.getComment(ownComment.id)).anonymized_author_ref,
    '评论也必须是同一串',
  );

  // 他人内容一行不动。
  const otherPostStored = await h.store.getPost(otherPost.id);
  assert.equal(otherPostStored.author_id, USER_B.userId, '被举报内容的作者不得被"举报人的注销"带走');
});

test('2. 仅有举报、无帖评的主体：同样被处理（旧实现里这一形态看起来"没什么可清"）', async () => {
  const h = makeHarness();
  const otherPost = await publishPost(h.service, USER_B, {}, idem(910));
  const filed = await report(USER_A, h.service, otherPost, '剂量写错了，容易药害。', 911);

  const counts = await purge(h, USER_A.userId);
  assert.equal(counts.blocked, 0, `不得 blocked（现场 ${JSON.stringify(counts.blockedReasons)}）`);
  assert.equal(counts.retained, 0, '该主体名下没有帖评 ⇒ 保留读数为 0');
  assert.equal(counts.records, 1, '举报 detail 被清空 ⇒ 1 行真实改动');
  assert.equal(counts.authorRefsReplaced, 1, '仅有举报 ⇒ 必须替换那 1 行（旧实现这里是 0）');
  assert.equal(counts.authorRefsRemaining, 0);

  const stored = await h.store.getReport(filed.id);
  assert.equal(stored.reporter_id, null, '只有举报的主体也必须断开举报者关联');
  assert.match(String(stored.anonymized_author_ref), REF_PATTERN);
});

test('3. 举报的**业务语义**不被破坏：行仍在、状态/理由/目标/时间不动，处置状态机照旧可推进', async () => {
  const h = makeHarness();
  const otherPost = await publishPost(h.service, USER_B, {}, idem(920));
  const filed = await report(USER_A, h.service, otherPost, '看起来像广告。', 921);
  // 注销**之前**先处置到 isolated：注销不得推翻审核结论，也不得把状态机锁死。
  await h.service.advanceReport(filed.id, { action: 'triage', expected_revision: filed.revision });
  const before = await h.store.getReport(filed.id);
  assert.equal(before.state, 'isolated');

  await purge(h, USER_A.userId);

  const after = await h.store.getReport(filed.id);
  assert.notEqual(after, null, '举报行必须仍然存在（处置轨迹是审核域留痕，注销不删行）');
  assert.equal(after.state, before.state, 'state 原样保留（注销只断作者关联）');
  assert.equal(after.reason_code, before.reason_code, '理由码原样保留');
  assert.deepEqual(after.target_ref, before.target_ref, '举报目标与目标版本原样保留');
  assert.equal(after.created_at, before.created_at, 'created_at 原样保留');
  assert.equal(after.revision, before.revision + 1, '唯一推进 revision 的原因是清 detail（既有口径不变）');
  assert.equal((await h.store.snapshotCounts()).reports, 1, '举报行数不变（只断关联、不删行）');

  // 状态机照旧可推进：isolated → closed 仍然合法（CAS 只比较 revision/state，不看 reporter）。
  const closed = await h.service.advanceReport(filed.id, {
    action: 'resolve',
    expected_revision: after.revision,
  });
  assert.equal(closed.state, 'closed', '注销不得让处置流程失效');
  assert.equal((await h.store.getReport(filed.id)).state, 'closed');

  // 该主体已无法从"举报者本人"这一面读到这条举报（关联已断，不是 500、不是泄漏）。
  await assert.rejects(
    () => h.service.getOwnReport(USER_A, filed.id),
    (error) => error?.code === 'NOT_FOUND',
    '账号映射断了 ⇒ 该主体不再能按"举报者本人"读到它',
  );
});

test('4. 重跑幂等：第二次替换 0 行、不换串、不报 blocked', async () => {
  const h = makeHarness();
  const otherPost = await publishPost(h.service, USER_B, {}, idem(930));
  const filed = await report(USER_A, h.service, otherPost, '重复举报的说明。', 931);
  const first = await purge(h, USER_A.userId);
  assert.equal(first.authorRefsReplaced, 1);
  const ref = (await h.store.getReport(filed.id)).anonymized_author_ref;
  assert.match(String(ref), REF_PATTERN);

  const second = await purge(h, USER_A.userId);
  assert.equal(second.blocked, 0, `重跑不得 blocked（现场 ${JSON.stringify(second.blockedReasons)}）`);
  assert.equal(second.authorRefsReplaced, 0, '已注销的行不得被第二次替换');
  assert.equal(second.records, 0, 'detail 已为 NULL ⇒ 没有可再次清空的自由文本');
  assert.equal(second.authorRefsRemaining, 0, '重放不产生新的未完成项');
  assert.equal((await h.store.getReport(filed.id)).anonymized_author_ref, ref, '引用不得被重放改成另一串');
});

test('5. 判据覆盖举报：只剩举报的残留 ⇒ authorRefsRemaining=1 且 blocked（⛔ 不得静默 completed）', async () => {
  // 形态：作者目录没有 `anonymize` 能力 ⇒ 端口明确传 `null` ⇒ 存储侧**完全不替换**行级引用。
  // 该主体**只**有举报（没有帖/评）：旧实现的 `authorRefsRemaining` 只数帖评 ⇒ 读到 0 ⇒
  // `blocked = 0`（fail-open：举报者关联仍在，回执却说 completed）。本片要求读数把它数进去。
  const h = makeHarness();
  const otherPost = await publishPost(h.service, USER_B, {}, idem(940));
  await report(USER_A, h.service, otherPost, '没有任何帖评，只有这条举报。', 941);

  const counts = await purgeWithoutAnonymize(h, USER_A.userId);
  assert.equal(
    counts.authorRefsRemaining,
    1,
    '举报行仍以原 reporter_id 关联该主体 ⇒ 剩余读数必须是 1（只数帖评就会谎报 0）',
  );
  assert.equal(counts.authorRefsReplaced, 0, '拿不到引用 ⇒ 不替换（自保：不写"两个字段都空"的行）');
  assert.equal(counts.blocked, 1, '仍有行指向该账户 ⇒ 必须 blocked');
  assert.equal(
    counts.blockedReasons.includes(ROW_REASON),
    true,
    `原因码必须含 ${ROW_REASON}（实际 ${JSON.stringify(counts.blockedReasons)}）`,
  );
  assert.equal(
    counts.blockedReasons.includes(UNAVAILABLE_REASON),
    true,
    '能力缺失也要如实上报（既有原因码，⛔ 不删除）',
  );
  // 旁证：记录本身没有被半途写坏（仍是活账户关联，等下一次带引用的清理）。
  const stored = (await h.store.snapshotCounts()).reports;
  assert.equal(stored, 1);
});

test('6. 正常路径不被误判 blocked：真实内存实现 + 真实端口 ⇒ completed 且读数为 0', async () => {
  const h = makeHarness();
  const ownPost = await publishPost(h.service, USER_A, {}, idem(950));
  const otherPost = await publishPost(h.service, USER_B, {}, idem(951));
  await report(USER_A, h.service, otherPost, '正常路径也要能归零。', 952);

  const counts = await purge(h, USER_A.userId);
  assert.equal(counts.authorRefsRemaining, 0, '所有三张表都清干净 ⇒ 读数 0');
  assert.equal(counts.blocked, 0, '正常路径必须 completed');
  assert.deepEqual([...counts.blockedReasons], [], '正常路径不得留任何原因码');
  assert.equal((await h.store.getPost(ownPost.id)).author_id, null);
});
