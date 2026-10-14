/**
 * GY-I14（#14）⇄ GY-I15（#15）联动接线 · **编辑重审**（`Refs #14`, `Refs #15`）。
 *
 * 覆盖（派单 §2 第 2 组）：编辑生成**新版本** ⇒ 旧版本的审核结论**不得套用**到新版本（负例），
 * 且反向同样成立：新版本的驳回**不得误伤**旧版本。
 *
 *   1. 新版本必须**重新送审**并建立**自己的**版本级任务（不同 `job_id`、绑定新 revision）；
 *   2. 新版本被审核域**明确驳回** ⇒ 编辑被拒、旧版本原样保留、旧版本结论不被覆盖；
 *   3. 审核域台账按 revision 分别持有结论：读取面用**当前** revision 的结论（既不吃旧的，也不被新的误伤）；
 *   4. 评论编辑同口径（新 revision 必须先送审）。
 *
 * 声明：模型端口全是**合成替身**（`provider.synthetic === true`），不发起任何真实模型/付费调用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLEAN_BODY, idem } from './community-fixtures.mjs';
import {
  OTHER_SAFE_BODY,
  USER_A,
  USER_B,
  expectApiError,
  makeWiredHarness,
  passingPort,
  postInput,
  revisionGatedPort,
} from './community-moderation-fixtures.mjs';

// ---------------------------------------------------------------------------
// G2-a 新版本必须重新送审、且拿到自己的版本级任务
// ---------------------------------------------------------------------------

test('G2a. 编辑生成新版本 ⇒ 必须重新送审（新 job_id、绑定新 revision），旧版本结论不被覆盖', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  assert.equal(post.revision, 1);

  const edited = await h.service.editPost(USER_A, post.id, postInput({ body: OTHER_SAFE_BODY }), {
    idempotencyKey: idem(2),
    ifMatch: '"1"',
  });
  assert.equal(edited.revision, 2, '编辑必须生成新版本');

  // 送审两次、第二次绑定的**就是**新 revision（不是把旧版本的结论搬过来）。
  assert.equal(h.calls.screen.length, 2, '每个版本都必须送审一次');
  assert.equal(h.calls.screen[0].input.content.target_ref.revision, 1);
  assert.equal(h.calls.screen[1].input.content.target_ref.revision, 2);
  assert.equal(
    h.calls.screen[1].input.content.target_ref.id,
    post.id,
    '新版本仍是同一个目标 id（版本级绑定靠 revision 区分）',
  );
  assert.equal(
    h.calls.screen[1].input.content.text,
    `${postInput({ body: OTHER_SAFE_BODY }).title}\n${OTHER_SAFE_BODY}`,
    '新版本的送审文本必须是新正文',
  );

  // 版本级任务各自独立：不同 job_id、绑定各自的 revision；未送审的版本**没有**任务。
  const v1 = h.moderation.tasks({ type: 'post', id: post.id, revision: 1 });
  const v2 = h.moderation.tasks({ type: 'post', id: post.id, revision: 2 });
  assert.equal(v1.length, 1);
  assert.equal(v2.length, 1);
  assert.notEqual(v1[0].job_id, v2[0].job_id, '新版本必须有自己的版本级任务');
  assert.equal(v2[0].target_ref.revision, 2);
  assert.equal(v2[0].decision, 'approved');
  assert.equal(h.moderation.tasks({ type: 'post', id: post.id, revision: 3 }).length, 0, '未送审的版本不得凭空有任务');
  // 旧版本的结论仍在（不是"新版本覆盖旧版本"）。
  assert.equal(v1[0].decision, 'approved');
  assert.equal(v1[0].target_ref.revision, 1);

  // 公开面：列表与详情都是新版本的正文。
  const detail = await h.service.getPost(USER_B, post.id);
  assert.equal(detail.revision, 2);
  assert.equal(detail.body, OTHER_SAFE_BODY);
});

// ---------------------------------------------------------------------------
// G2-b 新版本被明确驳回 ⇒ 不得套用旧版本的通过结论（负例）
// ---------------------------------------------------------------------------

test('G2b. 新版本被审核域明确驳回 ⇒ 编辑被拒、旧版本原样保留、旧版本结论不被覆盖（负例）', async () => {
  const { port } = revisionGatedPort({ blockFrom: 2 });
  const h = makeWiredHarness({ ports: { tms: port } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });

  const error = await expectApiError(
    () => h.service.editPost(USER_A, post.id, postInput({ body: OTHER_SAFE_BODY }), { idempotencyKey: idem(2), ifMatch: '"1"' }),
    'INVALID_REQUEST',
    400,
  );
  assert.ok(
    error.details.some((detail) => detail.field === 'reason_codes'),
    `必须回传审核域原因码，实际 ${JSON.stringify(error.details)}`,
  );

  // 旧版本原样保留：不推进 revision、正文不变、仍公开可见。
  const row = await h.store.getPost(post.id);
  assert.equal(row.revision, 1, '被拒编辑不得推进 revision');
  assert.equal(row.body, CLEAN_BODY, '被拒编辑不得改动已发布正文');
  const still = await h.service.getPost(USER_B, post.id);
  assert.equal(still.revision, 1);
  assert.equal(still.visibility, 'published');
  assert.equal(still.audit_state, 'approved');
  assert.equal((await h.service.listPosts(USER_B)).items.length, 1);
  assert.equal(h.store.snapshotCounts().posts, 1, '被拒编辑不得再落一条内容行');

  // **旧版本的通过结论没有被新版本吃掉，也没有被新版本覆盖**。
  const oldVerdict = await h.store.getModeration('post', post.id, 1);
  assert.equal(oldVerdict.decision, 'approved');
  const newVerdict = await h.store.getModeration('post', post.id, 2);
  assert.notEqual(newVerdict, null, '被驳回的新版本必须如实留档拒绝结论');
  assert.equal(newVerdict.decision, 'rejected');
  assert.equal(newVerdict.target_ref.revision, 2);
  assert.notEqual(newVerdict.text_digest, oldVerdict.text_digest, '结论必须绑定各自的版本正文');

  // 审核域台账按 revision 分别持有结论：rev1 通过、rev2 明确驳回。
  const c1 = h.link.conclusionFor({ type: 'post', id: post.id, revision: 1 });
  const c2 = h.link.conclusionFor({ type: 'post', id: post.id, revision: 2 });
  assert.equal(c1.vetoed, false);
  assert.equal(c1.decision, 'approved');
  assert.equal(c2.vetoed, true);
  assert.equal(c2.decision, 'rejected');

  // 反向：新版本的驳回**不得误伤**旧版本（读取面用**当前** revision 的结论）。
  assert.equal((await h.service.getPost(USER_A, post.id)).visibility, 'published');
  // 送审只发生两次（新版本一次），且第二次确实带着新 revision。
  assert.equal(h.calls.screen.length, 2);
  assert.equal(h.calls.screen[1].input.content.target_ref.revision, 2);
});

// ---------------------------------------------------------------------------
// G2-c 评论编辑同口径
// ---------------------------------------------------------------------------

test('G2c. 评论编辑的新 revision 同样必须先送审：被驳回 ⇒ 不改动旧评论、旧结论不被套用', async () => {
  const { port } = revisionGatedPort({ blockFrom: 2 });
  const h = makeWiredHarness({ ports: { tms: port } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  const comment = await h.service.createComment(
    USER_B,
    post.id,
    { body: '按标签说明处理，注意轮换。' },
    { idempotencyKey: idem(2), ifMatch: '"1"' },
  );
  assert.equal(comment.revision, 1);

  await expectApiError(
    () => h.service.editComment(USER_B, comment.id, { body: OTHER_SAFE_BODY }, { idempotencyKey: idem(3), ifMatch: '"1"' }),
    'INVALID_REQUEST',
    400,
  );

  const row = await h.store.getComment(comment.id);
  assert.equal(row.revision, 1, '被拒编辑不得推进评论 revision');
  assert.equal(row.body, '按标签说明处理，注意轮换。');
  const list = await h.service.listComments(USER_A, post.id);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].body, '按标签说明处理，注意轮换。');
  assert.equal(list.items[0].audit_state, 'approved');
  // 评论 rev1 结论仍在，rev2 是被驳回的独立结论。
  assert.equal((await h.store.getModeration('comment', comment.id, 1)).decision, 'approved');
  assert.equal((await h.store.getModeration('comment', comment.id, 2)).decision, 'rejected');
  assert.equal(h.calls.screen.at(-1).input.content.target_ref.revision, 2);
});
