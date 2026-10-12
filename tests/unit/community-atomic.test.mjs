/**
 * GY-I15（#15）阶段 1 · 返修 1：编辑/删除的**原子性**反例（回应监工 5487924826 行内 4245800577）。
 *
 * 监工指出（P1）：`replacePost` 只检查 id 存在后**无条件覆盖**；`editPost` 在 `await` 之前
 * 已检查 revision，**之后用旧快照写回 `published`** ⇒ 与删除交错时**已删除内容被迟到编辑重新公开**。
 *
 * 本文件用"把一条请求停在已读、未写的窗口里，让另一条请求先完成"的方式复现该缺陷，
 * 并对每条路径给出可单独指出的反例。断言一律**先判 `typeof` 再判值**。
 *
 * 反例在修复前必须失败（原始输出见 PR 正文「返修 1」章节），修复后必须通过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES } from '../../packages/moderation/index.mjs';
import { makeExtraRule } from '../moderation/_fixtures.mjs';
import {
  CLEAN_BODY,
  CLEAN_BODY_NO_HIT,
  CLEAN_TITLE_NO_HIT,
  USER_A,
  USER_B,
  assertApiError,
  assertApiErrorShape,
  captureError,
  idem,
  makeHarness,
  makePausePoint,
  publishPost,
  withGate,
} from './community-fixtures.mjs';

function postBody(overrides = {}) {
  return { title: CLEAN_TITLE_NO_HIT, body: CLEAN_BODY, media_ids: [], ...overrides };
}

/** 迟到写入被拒绝时允许的契约码（写路径 CAS 冲突）。 */
const WRITE_CONFLICT_CODES = ['REVISION_CONFLICT', 'OBJECT_UNAVAILABLE', 'NOT_FOUND'];

function assertWriteConflict(error, label) {
  assert.equal(typeof error, 'object');
  assert.equal(typeof error.code, 'string', `${label}：错误码必须是字符串`);
  assert.equal(typeof error.status, 'number', `${label}：HTTP 状态必须是数字`);
  assert.ok(
    WRITE_CONFLICT_CODES.includes(error.code),
    `${label}：必须落在契约冲突码闭集 ${JSON.stringify(WRITE_CONFLICT_CODES)}，实际 ${error.code}`,
  );
  assert.ok(error.status === 409 || error.status === 404, `${label}：状态应为 409/404，实际 ${error.status}`);
}

test('返修反例 1（主反例）：编辑在写入前暂停时，另一幂等键的删除不得被迟到编辑重新公开', async () => {
  const pause = makePausePoint();
  const h = makeHarness({
    // 编辑路径在"读完记录、校验完版本"之后、写入之前会先投影作者：把这里当作暂停点。
    authorsWrapper: (base) => ({
      resolve: async (userId) => {
        await pause.pauseOnce();
        return base.resolve(userId);
      },
    }),
  });
  const post = await publishPost(h.service, USER_A, {}, idem(300));
  assert.equal(typeof post.revision, 'number');
  assert.equal(post.revision, 1);

  // 目标版本是 revision=2 的编辑：先跑到"已校验、未写入"的位置停住。
  pause.arm();
  const editing = h.service.editPost(USER_A, post.id, postBody({ body: `${CLEAN_BODY}（编辑版本）` }), {
    idempotencyKey: idem(301),
    ifMatch: '"1"',
  });
  await pause.entered;

  // 同一帖子用 **If-Match:"1" + 不同幂等键** 先删除成功。
  const deleted = await h.service.deletePost(USER_A, post.id, { idempotencyKey: idem(302), ifMatch: '"1"' });
  assert.equal(typeof deleted.accepted, 'boolean');
  assert.equal(deleted.accepted, true);

  pause.release();
  const editError = await captureError(() => editing);
  assertWriteConflict(editError, '迟到编辑');

  const stored = await h.store.getPost(post.id);
  assert.equal(typeof stored.visibility, 'string');
  assert.notEqual(stored.visibility, 'published', '已删除内容不得被迟到编辑重新公开');
  assert.equal(stored.visibility, 'deleted');
  assert.equal(stored.revision, 1, '被拒的编辑不得把版本推进到 2');

  await assert.rejects(h.service.getPost(USER_B, post.id), assertApiError('NOT_FOUND', 404));
  const feed = await h.service.listPosts(USER_B, {});
  assert.equal(feed.items.length, 0, '已删除内容不得回到任何列表');
});

test('返修反例 2：不同幂等键的并发编辑 ⇒ 恰好一个成功、另一个冲突，且最终只有一个版本与一条结论', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(310));

  const settled = await Promise.allSettled([
    h.service.editPost(USER_A, post.id, postBody({ body: `${CLEAN_BODY}（甲版本）` }), {
      idempotencyKey: idem(311),
      ifMatch: '"1"',
    }),
    h.service.editPost(USER_A, post.id, postBody({ body: `${CLEAN_BODY}（乙版本）` }), {
      idempotencyKey: idem(312),
      ifMatch: '"1"',
    }),
  ]);
  const fulfilled = settled.filter((item) => item.status === 'fulfilled');
  const rejected = settled.filter((item) => item.status === 'rejected');
  assert.equal(fulfilled.length, 1, '必须恰好一个编辑成功');
  assert.equal(rejected.length, 1, '必须恰好一个编辑冲突失败');
  assertWriteConflict(rejected[0].reason, '并发编辑的失败方');

  const stored = await h.store.getPost(post.id);
  assert.equal(typeof stored.revision, 'number');
  assert.equal(stored.revision, 2, '只应产生一个版本');
  assert.equal(stored.body, fulfilled[0].value.body, '落库正文必须是成功者的正文');
  assert.equal(h.store.snapshotCounts().posts, 1);
  // 失败方不得留下"孤儿结论"：rev1 + rev2 各一条。
  assert.equal(h.store.snapshotCounts().moderation, 2);
  // 成功者的内容必须仍然公开可见（不能被失败方的结论压成不可见）。
  const feed = await h.service.listPosts(USER_B, {});
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].body, fulfilled[0].value.body);
  assert.equal(feed.items[0].visibility, 'published');
});

test('返修反例 3：重审写回与删除交错 ⇒ 重审不得复活已删除内容', async () => {
  const pause = makePausePoint();
  const h = makeHarness({
    storeWrapper: (base) => ({
      ...base,
      // 重审在"读完成、写回前"会先取既有结论：把这里当作暂停点。
      getModeration: async (kind, id, revision) => {
        await pause.pauseOnce();
        return base.getModeration(kind, id, revision);
      },
    }),
  });
  const post = await publishPost(h.service, USER_A, { title: CLEAN_TITLE_NO_HIT, body: CLEAN_BODY_NO_HIT }, idem(320));

  // 规则集升级 ⇒ 旧结论失效 ⇒ 重审必须写回（不是"无需写回"的快路径）。
  const upgraded = withGate(h, { rules: [...RULES, makeExtraRule()] });
  pause.arm();
  const reviewing = upgraded.reReviewContent(USER_A, { type: 'post', id: post.id, revision: 1 });
  await pause.entered;

  const deleted = await h.service.deletePost(USER_A, post.id, { idempotencyKey: idem(321), ifMatch: '"1"' });
  assert.equal(deleted.accepted, true);

  pause.release();
  const report = await reviewing;
  assert.equal(typeof report.visibility, 'string');
  assert.notEqual(report.visibility, 'published', '重审不得把已删除内容重新置为 published');
  assert.equal(report.visibility, 'deleted');
  assert.equal(report.publishable, false);

  const stored = await h.store.getPost(post.id);
  assert.equal(typeof stored.visibility, 'string');
  assert.equal(stored.visibility, 'deleted');
  await assert.rejects(h.service.getPost(USER_B, post.id), assertApiError('NOT_FOUND', 404));
  assert.equal((await h.service.listPosts(USER_B, {})).items.length, 0);
});

test('返修反例 4：评论编辑在写入前暂停时，另一幂等键的删除不得被迟到编辑重新公开', async () => {
  const pause = makePausePoint();
  const h = makeHarness({
    authorsWrapper: (base) => ({
      resolve: async (userId) => {
        await pause.pauseOnce();
        return base.resolve(userId);
      },
    }),
  });
  const post = await publishPost(h.service, USER_A, {}, idem(330));
  const comment = await h.service.createComment(USER_B, post.id, { body: '原始评论内容' }, {
    idempotencyKey: idem(331),
    ifMatch: `"${post.revision}"`,
  });
  assert.equal(typeof comment.revision, 'number');
  assert.equal(comment.revision, 1);

  pause.arm();
  const editing = h.service.editComment(USER_B, comment.id, { body: '被取消的编辑内容' }, {
    idempotencyKey: idem(332),
    ifMatch: '"1"',
  });
  await pause.entered;

  const deleted = await h.service.deleteComment(USER_B, comment.id, {
    idempotencyKey: idem(333),
    ifMatch: '"1"',
  });
  assert.equal(deleted.accepted, true);

  pause.release();
  const editError = await captureError(() => editing);
  assertWriteConflict(editError, '迟到评论编辑');

  const stored = await h.store.getComment(comment.id);
  assert.equal(typeof stored.visibility, 'string');
  assert.notEqual(stored.visibility, 'published', '已删除评论不得被迟到编辑重新公开');
  assert.equal(stored.visibility, 'deleted');
  assert.equal(stored.revision, 1);
  await assert.rejects(h.service.getComment(USER_A, comment.id), assertApiError('NOT_FOUND', 404));
  assert.equal((await h.service.listComments(USER_A, post.id, {})).items.length, 0);
});

test('返修反例 5：store 必须提供"比较并写入"的 CAS 原语（检查与写入同一临界区）', async () => {
  const h = makeHarness();
  assert.equal(typeof h.store.commitPostIfCurrent, 'function', 'store 必须提供 commitPostIfCurrent（CAS）');
  assert.equal(typeof h.store.commitCommentIfCurrent, 'function', 'store 必须提供 commitCommentIfCurrent（CAS）');

  const post = await publishPost(h.service, USER_A, {}, idem(340));

  // 版本不匹配 ⇒ 拒绝且**不改写**
  const staleRevision = await h.store.commitPostIfCurrent(post.id, { revision: 99 }, { body: '不应写入' });
  assert.equal(typeof staleRevision.ok, 'boolean');
  assert.equal(staleRevision.ok, false);
  assert.equal(staleRevision.reason, 'REVISION_CHANGED');
  assert.equal((await h.store.getPost(post.id)).body, CLEAN_BODY);

  // 作者不符 ⇒ 拒绝（不泄露存在性由上层映射为 NOT_FOUND）
  const wrongAuthor = await h.store.commitPostIfCurrent(
    post.id,
    { revision: 1, author_id: USER_B.userId },
    { body: '不应写入' },
  );
  assert.equal(wrongAuthor.ok, false);
  assert.equal(wrongAuthor.reason, 'AUTHOR_CHANGED');

  // 可见性期望不符 ⇒ 拒绝
  const wrongVisibility = await h.store.commitPostIfCurrent(
    post.id,
    { revision: 1, visibility: 'hidden' },
    { body: '不应写入' },
  );
  assert.equal(wrongVisibility.ok, false);
  assert.equal(wrongVisibility.reason, 'VISIBILITY_CHANGED');

  // 删除后 ⇒ 任何写入都不得复活（含"把 visibility 改回 published"）
  const deleted = await h.service.deletePost(USER_A, post.id, { idempotencyKey: idem(341), ifMatch: '"1"' });
  assert.equal(deleted.accepted, true);
  const resurrect = await h.store.commitPostIfCurrent(post.id, { revision: 1 }, { visibility: 'published' });
  assert.equal(resurrect.ok, false);
  assert.equal(resurrect.reason, 'DELETED');
  const stored = await h.store.getPost(post.id);
  assert.equal(stored.visibility, 'deleted');

  // 记录不存在 ⇒ NOT_FOUND
  const missing = await h.store.commitPostIfCurrent('00000000-0000-4000-8500-00000000dead', { revision: 1 }, { body: 'x' });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'NOT_FOUND');

  // 评论侧同口径
  const post2 = await publishPost(h.service, USER_A, {}, idem(342));
  const comment = await h.service.createComment(USER_B, post2.id, { body: '另一条评论内容' }, {
    idempotencyKey: idem(343),
    ifMatch: `"${post2.revision}"`,
  });
  const staleComment = await h.store.commitCommentIfCurrent(comment.id, { revision: 42 }, { body: '不应写入' });
  assert.equal(staleComment.ok, false);
  assert.equal(staleComment.reason, 'REVISION_CHANGED');
  assert.equal((await h.store.getComment(comment.id)).body, '另一条评论内容');
});

test('返修反例 6：创建评论时父帖被并发删除 ⇒ 拒绝且不产生孤儿评论（父帖校验与插入同临界区）', async () => {
  const pause = makePausePoint();
  const h = makeHarness({
    authorsWrapper: (base) => ({
      resolve: async (userId) => {
        await pause.pauseOnce();
        return base.resolve(userId);
      },
    }),
  });
  const post = await publishPost(h.service, USER_A, {}, idem(360));
  pause.arm();
  const creating = h.service.createComment(USER_B, post.id, { body: '并发提交的评论内容' }, {
    idempotencyKey: idem(361),
    ifMatch: `"${post.revision}"`,
  });
  await pause.entered;

  const deleted = await h.service.deletePost(USER_A, post.id, { idempotencyKey: idem(362), ifMatch: '"1"' });
  assert.equal(deleted.accepted, true);

  pause.release();
  const error = await captureError(() => creating);
  assert.equal(typeof error.code, 'string');
  assert.equal(error.code, 'REVISION_CONFLICT');
  assert.equal(error.status, 409);
  assert.equal(h.store.snapshotCounts().comments, 0, '父帖已删除时不得插入孤儿评论');
});

test('返修反例 7：写路径对已删除对象的错误码口径（写 409 OBJECT_UNAVAILABLE / 读 404；非作者一律 404）', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(370));
  const comment = await h.service.createComment(USER_B, post.id, { body: '将被删除的评论内容' }, {
    idempotencyKey: idem(371),
    ifMatch: '"1"',
  });
  await h.service.deleteComment(USER_B, comment.id, { idempotencyKey: idem(372), ifMatch: '"1"' });
  await h.service.deletePost(USER_A, post.id, { idempotencyKey: idem(373), ifMatch: '"1"' });

  // 读路径：已删除 ⇒ NOT_FOUND（不泄露存在性）
  await assert.rejects(h.service.getPost(USER_A, post.id), assertApiError('NOT_FOUND', 404));
  await assert.rejects(h.service.getComment(USER_B, comment.id), assertApiError('NOT_FOUND', 404));

  // 写路径：作者本人对已删除对象 ⇒ 409 OBJECT_UNAVAILABLE（顺序调用与并发交错同一口径）
  const editError = await captureError(() =>
    h.service.editPost(USER_A, post.id, postBody(), { idempotencyKey: idem(374), ifMatch: '"1"' }),
  );
  assertApiErrorShape(editError, 'OBJECT_UNAVAILABLE', 409);
  const deleteError = await captureError(() =>
    h.service.deletePost(USER_A, post.id, { idempotencyKey: idem(375), ifMatch: '"1"' }),
  );
  assertApiErrorShape(deleteError, 'OBJECT_UNAVAILABLE', 409);
  const commentEditError = await captureError(() =>
    h.service.editComment(USER_B, comment.id, { body: '不应写入的评论' }, {
      idempotencyKey: idem(376),
      ifMatch: '"1"',
    }),
  );
  assertApiErrorShape(commentEditError, 'OBJECT_UNAVAILABLE', 409);

  // 非作者：读/写一律 NOT_FOUND，绝不因"已删除"而给出可区分的码
  const otherEdit = await captureError(() =>
    h.service.editPost(USER_B, post.id, postBody(), { idempotencyKey: idem(377), ifMatch: '"1"' }),
  );
  assertApiErrorShape(otherEdit, 'NOT_FOUND', 404);
  const otherDelete = await captureError(() =>
    h.service.deletePost(USER_B, post.id, { idempotencyKey: idem(378), ifMatch: '"1"' }),
  );
  assertApiErrorShape(otherDelete, 'NOT_FOUND', 404);
});

test('返修正控制：CAS 允许正常提交（revision 递增），且内容与审核结论同一次提交写入', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(350));
  const edited = await h.service.editPost(USER_A, post.id, postBody({ body: `${CLEAN_BODY}（正常编辑）` }), {
    idempotencyKey: idem(351),
    ifMatch: '"1"',
  });
  assert.equal(typeof edited.revision, 'number');
  assert.equal(edited.revision, 2);
  assert.equal(edited.visibility, 'published');
  assert.equal(edited.audit_state, 'approved');

  const stored = await h.store.getPost(post.id);
  assert.equal(stored.revision, 2);
  const verdict = await h.store.getModeration('post', post.id, 2);
  assert.equal(typeof verdict.rule_version, 'string');
  assert.equal(verdict.target_ref.revision, 2);
  // 结论与内容同原子提交 ⇒ 一次编辑只新增 1 条结论（rev1 + rev2 = 2）。
  assert.equal(h.store.snapshotCounts().moderation, 2);
  const feed = await h.service.listPosts(USER_B, {});
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].revision, 2);
});
