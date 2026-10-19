/**
 * GY-I14（#14）· **发布闸门接进社区产品路径**（`Refs #14`）。
 *
 * 覆盖（派单 §2 第 4、5 组 / P1-1）：
 *   W1 安全内容的**行为不变**：同一请求内完成"筛查 → 发布"，返回 `published` + `approved`；
 *      但发布是由审核域的发布闸门写成功的（计数端口证明 `publish` 恰好被调用一次），
 *      且**发布之前**社区行是 `private` + `pending`（本域不再写死 `approved`）；
 *   W2 筛查放行、发布闸门拒绝 ⇒ **行保留为待审**（`private` + `pending`，不静默丢弃、也不留
 *      `published`），错误原样上抛，读面（他人详情/公开列表）一律不可见；
 *   W3 编辑产生**新 revision** ⇒ 重新经发布闸门发布（`target_ref.revision` 是新版本，
 *      `published_revision` 也是新版本），旧版本结论不被套用；
 *   W4 编辑的发布被拒 ⇒ 新版本停在待审、公开面消失（旧版本结论不得继续放行新内容）。
 *   W5 评论与发帖**同一口径**：安全评论先落 `private` + `pending`，经审核域 `publish` 才 `published`
 *      + `approved`（发布那一刻的行快照为证）；
 *   W6 评论的发布闸门拒绝 ⇒ 评论行停在待审、读面不可见、错误原样上抛；
 *   W7 命中规则的违规评论 ⇒ 直接拒绝、零落库、**零发布调用**（短路的不是闸门而是规则层）；
 *   W8 评论编辑产生新 revision ⇒ 重新过发布闸门（发布的是新版本）；
 *   W9 评论编辑的发布被拒 ⇒ 新 revision 停在待审、公开面消失。
 *
 * 声明：模型端口是**明确标注的合成替身**（`provider.synthetic === true`，本文件不发起任何真实
 * 模型/付费调用）；本文件证明的是**接线与失败语义**，不证明任何真实 AI 供应商能力。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryCommunityStore } from '../../services/api/src/community/store.ts';
import { ApiError } from '../../services/api/src/errors.ts';
import { idem } from './community-fixtures.mjs';
import {
  OTHER_SAFE_BODY,
  START,
  USER_A,
  USER_B,
  expectApiError,
  makeWiredHarness,
  markerPort,
  passingPort,
  postInput,
} from './community-moderation-fixtures.mjs';

/** 合成模型端口的拦截标记（与 `community-moderation-publish.test.mjs` 的 G1b 同值）。 */
const BLOCK_MARKER = 'S9-MODEL-BLOCK';
const SAFE_COMMENT = '换一种说法：按标签说明处理，注意轮换。';

// ---------------------------------------------------------------------------
// W1 安全内容：同一请求内发布，但**经审核域发布闸门**（发布前不得已是 published/approved）
// ---------------------------------------------------------------------------

test('W1. 安全内容经发布闸门发布：发布前落 private/pending，发布后才 published/approved', async () => {
  const store = createMemoryCommunityStore({ now: () => START });
  const rowsAtPublish = [];
  const h = makeWiredHarness({
    store,
    ports: { tms: passingPort() },
    // 在**发布闸门被调用的那一刻**取行快照：证明本域没有先把它写成公开。
    communityLinkWrapper: (inner) => ({
      ...inner,
      async publish(input) {
        rowsAtPublish.push(await store.getPost(input.content.target_ref.id));
        return inner.publish(input);
      },
    }),
  });

  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });

  // 对调用方行为不变：同一请求内拿到已发布结果。
  assert.equal(post.visibility, 'published');
  assert.equal(post.audit_state, 'approved');

  // 但确实走了发布闸门（不是本域直接写死 approved）。
  assert.equal(h.calls.publish.length, 1, '产品路径必须调用审核域 publish（至少一次）');
  assert.deepEqual(h.calls.publish[0].input.content.target_ref, { type: 'post', id: post.id, revision: 1 });
  assert.equal(h.calls.publish[0].result.published, true);

  // 发布**之前**的行状态：私有 + 待审。
  assert.equal(rowsAtPublish.length, 1, '发布闸门必须在行落库之后被调用（发布写的是真实行）');
  assert.equal(rowsAtPublish[0].visibility, 'private', '发布前不得是 published');
  assert.equal(rowsAtPublish[0].audit_state, 'pending', '发布前不得是 approved');

  // 发布成功后才变成 published + approved。
  const row = await store.getPost(post.id);
  assert.equal(row.visibility, 'published');
  assert.equal(row.audit_state, 'approved');
  assert.equal((await h.service.listPosts(USER_B)).items.length, 1);
  assert.equal(h.store.snapshotCounts().posts, 1);
});

// ---------------------------------------------------------------------------
// W2 筛查放行 / 发布闸门拒绝 ⇒ 待审行保留，读面不可见（fail-closed）
// ---------------------------------------------------------------------------

test('W2. 筛查放行但发布闸门拒绝 ⇒ 行停在待审（private/pending），读面不可见，错误原样上抛', async () => {
  let attemptedId = null;
  const h = makeWiredHarness({
    ports: { tms: passingPort() },
    communityLinkWrapper: (inner) => ({
      ...inner,
      async publish(input) {
        attemptedId = input.content.target_ref.id;
        throw new ApiError('REVISION_CONFLICT', '合成：审核域发布闸门拒绝（测试替身）');
      },
    }),
  });

  const error = await expectApiError(
    () => h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) }),
    'REVISION_CONFLICT',
    409,
  );
  assert.equal(error.retryable, false);

  // 前提：拒绝来自**发布闸门**，不是规则/模型层（筛查已放行）。
  assert.equal(h.calls.screen.length, 1);
  assert.equal(h.calls.screen[0].result.publishable, true);
  assert.equal(h.calls.publish.length, 0, 'communityLinkWrapper 在 observeLink 之外，计数端口只看真实调用');

  // 不静默丢弃：行保留为待审，且**不是** published/approved。
  const row = await h.store.getPost(attemptedId);
  assert.notEqual(row, null, '发布失败不得静默丢弃内容行');
  assert.equal(row.visibility, 'private');
  assert.equal(row.audit_state, 'pending');
  assert.equal(h.store.snapshotCounts().posts, 1);

  // 读面：他人详情 404、公开列表为空、作者自己也看不到"已发布"。
  await expectApiError(() => h.service.getPost(USER_B, attemptedId), 'NOT_FOUND', 404);
  assert.deepEqual(await h.service.listPosts(USER_B), { items: [], next_cursor: null });
  assert.equal((await h.service.getPost(USER_A, attemptedId)).visibility, 'private', '不得报成已发布');
});

// ---------------------------------------------------------------------------
// W3 编辑新 revision ⇒ 重新过发布闸门（旧结论不套用）
// ---------------------------------------------------------------------------

test('W3. 编辑新 revision ⇒ 重新经发布闸门发布（发布的是新版本，不是旧结论）', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });

  const edited = await h.service.editPost(USER_A, post.id, postInput({ body: OTHER_SAFE_BODY }), {
    idempotencyKey: idem(2),
    ifMatch: '"1"',
  });

  assert.equal(edited.revision, 2);
  assert.equal(edited.visibility, 'published');
  assert.equal(edited.audit_state, 'approved');
  assert.equal(h.calls.publish.length, 2, '新 revision 必须重新发布（旧版本结论不得复用）');
  assert.equal(h.calls.publish[1].input.content.target_ref.revision, 2);
  assert.equal(h.calls.publish[1].result.published_revision, 2);
});

// ---------------------------------------------------------------------------
// W4 编辑的发布被拒 ⇒ 新版本停在待审，旧版本结论不得继续放行
// ---------------------------------------------------------------------------

test('W4. 编辑的发布被拒 ⇒ 新版本停在待审，公开面消失（旧版本结论不得套用）', async () => {
  let rejectedRevision = null;
  const h = makeWiredHarness({
    ports: { tms: passingPort() },
    communityLinkWrapper: (inner) => ({
      ...inner,
      async publish(input) {
        if (input.content.target_ref.revision === 2) {
          rejectedRevision = input.content.target_ref.revision;
          throw new ApiError('REVISION_CONFLICT', '合成：新 revision 发布闸门拒绝（测试替身）');
        }
        return inner.publish(input);
      },
    }),
  });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  assert.equal(post.visibility, 'published');

  await expectApiError(
    () =>
      h.service.editPost(USER_A, post.id, postInput({ body: OTHER_SAFE_BODY }), {
        idempotencyKey: idem(2),
        ifMatch: '"1"',
      }),
    'REVISION_CONFLICT',
    409,
  );
  assert.equal(rejectedRevision, 2, '被拒绝的是**新版本**的发布');

  const row = await h.store.getPost(post.id);
  assert.equal(row.revision, 2);
  assert.equal(row.visibility, 'private', '待审的新版本不得是 published');
  assert.equal(row.audit_state, 'pending');

  // 旧版本（rev1）曾公开，但新版本未发布 ⇒ 公开面必须消失（不得回退复用旧结论）。
  await expectApiError(() => h.service.getPost(USER_B, post.id), 'NOT_FOUND', 404);
  assert.deepEqual(await h.service.listPosts(USER_B), { items: [], next_cursor: null });
  assert.equal(h.store.snapshotCounts().posts, 1);
});

// ---------------------------------------------------------------------------
// W5 评论：与发帖同一口径（先 private/pending，再经发布闸门）
// ---------------------------------------------------------------------------

test('W5. 安全评论同样经发布闸门：发布前落 private/pending，发布后才 published/approved', async () => {
  const store = createMemoryCommunityStore({ now: () => START });
  const commentRowsAtPublish = [];
  const h = makeWiredHarness({
    store,
    ports: { tms: passingPort() },
    communityLinkWrapper: (inner) => ({
      ...inner,
      async publish(input) {
        if (input.content.target_ref.type === 'comment') {
          commentRowsAtPublish.push(await store.getComment(input.content.target_ref.id));
        }
        return inner.publish(input);
      },
    }),
  });

  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  const comment = await h.service.createComment(
    USER_B,
    post.id,
    { body: SAFE_COMMENT },
    { idempotencyKey: idem(2), ifMatch: '"1"' },
  );

  // 对调用方行为不变：同一请求内拿到已发布结果。
  assert.equal(comment.visibility, 'published');
  assert.equal(comment.audit_state, 'approved');

  // 但确实走了发布闸门（帖子一次 + 评论一次），且发布的是这条评论的 revision 1。
  assert.equal(h.calls.publish.length, 2, '评论必须经审核域 publish 发布（不是本域写死 approved）');
  assert.deepEqual(h.calls.publish[1].input.content.target_ref, {
    type: 'comment',
    id: comment.id,
    revision: 1,
  });
  assert.equal(h.calls.publish[1].result.published, true);
  assert.equal(h.calls.publish[1].input.content.media.length, 0);

  // 发布**之前**的评论行状态：私有 + 待审。
  assert.equal(commentRowsAtPublish.length, 1, '发布闸门必须在评论行落库之后被调用');
  assert.equal(commentRowsAtPublish[0].visibility, 'private', '发布前不得是 published');
  assert.equal(commentRowsAtPublish[0].audit_state, 'pending', '发布前不得是 approved');

  // 发布成功后才变成 published + approved，且对他人可见。
  const row = await store.getComment(comment.id);
  assert.equal(row.visibility, 'published');
  assert.equal(row.audit_state, 'approved');
  assert.equal((await h.service.listComments(USER_B, post.id)).items.length, 1);
  assert.equal(h.store.snapshotCounts().comments, 1);
});

// ---------------------------------------------------------------------------
// W6 评论的发布闸门拒绝 ⇒ 待审行保留、读面不可见（fail-closed）
// ---------------------------------------------------------------------------

test('W6. 评论发布闸门拒绝 ⇒ 评论行停在待审（private/pending），读面不可见，错误原样上抛', async () => {
  let attemptedCommentId = null;
  const h = makeWiredHarness({
    ports: { tms: passingPort() },
    communityLinkWrapper: (inner) => ({
      ...inner,
      async publish(input) {
        if (input.content.target_ref.type === 'comment') {
          attemptedCommentId = input.content.target_ref.id;
          throw new ApiError('REVISION_CONFLICT', '合成：评论发布闸门拒绝（测试替身）');
        }
        return inner.publish(input);
      },
    }),
  });

  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  await expectApiError(
    () =>
      h.service.createComment(USER_B, post.id, { body: SAFE_COMMENT }, { idempotencyKey: idem(2), ifMatch: '"1"' }),
    'REVISION_CONFLICT',
    409,
  );

  // 前提：拒绝来自**发布闸门**，不是规则/模型层（筛查已放行）。
  assert.equal(h.calls.screen.length, 2);
  assert.equal(h.calls.screen[1].result.publishable, true);

  // 不静默丢弃：评论行保留为待审，且**不是** published/approved。
  const row = await h.store.getComment(attemptedCommentId);
  assert.notEqual(row, null, '发布失败不得静默丢弃评论行');
  assert.equal(row.visibility, 'private');
  assert.equal(row.audit_state, 'pending');
  assert.equal(h.store.snapshotCounts().comments, 1);

  // 读面：他人看不到、公开评论列表为空；作者本人读到的是待审（不得报成已发布）。
  await expectApiError(() => h.service.getComment(USER_A, attemptedCommentId), 'NOT_FOUND', 404);
  assert.deepEqual(await h.service.listComments(USER_A, post.id), { items: [], next_cursor: null });
  assert.equal((await h.service.getComment(USER_B, attemptedCommentId)).visibility, 'private');
});

// ---------------------------------------------------------------------------
// W7 命中规则的违规评论 ⇒ 直接拒绝、零落库、零发布调用
// ---------------------------------------------------------------------------

test('W7. 命中规则的违规评论 ⇒ 直接拒绝且零落库，未走到发布闸门', async () => {
  const { port } = markerPort({ blockMarker: BLOCK_MARKER });
  const h = makeWiredHarness({ ports: { tms: port } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  const publishesBefore = h.calls.publish.length;
  assert.equal(publishesBefore, 1, '前提：父帖发布一次');

  await expectApiError(
    () =>
      h.service.createComment(
        USER_B,
        post.id,
        { body: `按标签说明处理，${BLOCK_MARKER} 所以我想这样用。` },
        { idempotencyKey: idem(2), ifMatch: '"1"' },
      ),
    'INVALID_REQUEST',
    400,
  );

  assert.equal(h.calls.publish.length, publishesBefore, '被驳回的评论不得进入发布闸门');
  assert.equal(h.store.snapshotCounts().comments, 0, '被驳回的评论不得留下内容行');
  assert.deepEqual(await h.service.listComments(USER_A, post.id), { items: [], next_cursor: null });
});

// ---------------------------------------------------------------------------
// W8 评论编辑新 revision ⇒ 重新过发布闸门（旧结论不套用）
// ---------------------------------------------------------------------------

test('W8. 评论编辑新 revision ⇒ 重新经发布闸门发布（发布的是新版本）', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  const comment = await h.service.createComment(
    USER_B,
    post.id,
    { body: SAFE_COMMENT },
    { idempotencyKey: idem(2), ifMatch: '"1"' },
  );

  const edited = await h.service.editComment(
    USER_B,
    comment.id,
    { body: OTHER_SAFE_BODY },
    { idempotencyKey: idem(3), ifMatch: '"1"' },
  );

  assert.equal(edited.revision, 2);
  assert.equal(edited.visibility, 'published');
  assert.equal(edited.audit_state, 'approved');
  assert.equal(h.calls.publish.length, 3, '评论新 revision 必须重新发布（旧版本结论不得复用）');
  assert.equal(h.calls.publish[2].input.content.target_ref.revision, 2);
  assert.equal(h.calls.publish[2].input.content.target_ref.type, 'comment');
  assert.equal(h.calls.publish[2].result.published_revision, 2);
  assert.equal((await h.service.listComments(USER_A, post.id)).items[0].revision, 2);
});

// ---------------------------------------------------------------------------
// W9 评论编辑的发布被拒 ⇒ 新 revision 停在待审，公开面消失
// ---------------------------------------------------------------------------

test('W9. 评论编辑的发布被拒 ⇒ 新 revision 停在待审，公开面消失（旧结论不得套用）', async () => {
  let rejectedRevision = null;
  const h = makeWiredHarness({
    ports: { tms: passingPort() },
    communityLinkWrapper: (inner) => ({
      ...inner,
      async publish(input) {
        if (input.content.target_ref.type === 'comment' && input.content.target_ref.revision === 2) {
          rejectedRevision = 2;
          throw new ApiError('REVISION_CONFLICT', '合成：评论新 revision 发布闸门拒绝（测试替身）');
        }
        return inner.publish(input);
      },
    }),
  });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  const comment = await h.service.createComment(
    USER_B,
    post.id,
    { body: SAFE_COMMENT },
    { idempotencyKey: idem(2), ifMatch: '"1"' },
  );
  assert.equal(comment.visibility, 'published');

  await expectApiError(
    () =>
      h.service.editComment(
        USER_B,
        comment.id,
        { body: OTHER_SAFE_BODY },
        { idempotencyKey: idem(3), ifMatch: '"1"' },
      ),
    'REVISION_CONFLICT',
    409,
  );
  assert.equal(rejectedRevision, 2, '被拒绝的是**新版本**的评论发布');

  const row = await h.store.getComment(comment.id);
  assert.equal(row.revision, 2);
  assert.equal(row.visibility, 'private', '待审的新版本不得是 published');
  assert.equal(row.audit_state, 'pending');

  // 旧版本（rev1）曾公开，但新版本未发布 ⇒ 公开评论列表必须为空。
  assert.deepEqual(await h.service.listComments(USER_A, post.id), { items: [], next_cursor: null });
  assert.equal(h.store.snapshotCounts().comments, 1);
});
