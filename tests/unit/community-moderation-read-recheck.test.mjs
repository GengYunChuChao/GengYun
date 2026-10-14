/**
 * GY-I14（#14）⇄ GY-I15（#15）联动接线 · **读取时重查**（`Refs #14`, `Refs #15`）。
 *
 * 覆盖（派单 §2 第 1 组"公开面不可见"与第 3 组"读取一致"的**时序**面，依据 B09）：
 *   - 内容**已经公开**之后，审核域台账对该**同一版本**退回**非放行** ⇒ 读取面临即降级、退出公开面
 *     （**驳回** G1e 与 **隔离·未结论** G1h 两条路径都要退），不需要等写路径；
 *   - 降级后的 `audit_state` **如实区分** `rejected`（驳回）与 `pending`/`quarantined`（隔离），
 *     即"待审核"**不伪装成"驳回"**；
 *   - 该降级不是偷偷改库：社区存储行与"写入时那份结论"保持原样 ⇒ 证明确实来自审核域读取重查；
 *   - 已登记边界 G1j：台账里**完全没有**该版本任务（`present:false`）时**不**降级 ——
 *     没有结论可"退回"；接线后**新建**内容不存在这种状态（送审先于落库）。
 *
 * 声明：模型端口是**合成替身**（`provider.synthetic === true`），不发起任何真实模型/付费调用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idem } from './community-fixtures.mjs';
import {
  CLEAN_BODY,
  CLEAN_TITLE,
  USER_A,
  USER_B,
  expectApiError,
  makeWiredHarness,
  mutablePort,
  noTaskConclusionLink,
  passingPort,
  postInput,
} from './community-moderation-fixtures.mjs';

const POST_TEXT = `${CLEAN_TITLE}\n${CLEAN_BODY}`;

test('G1e. 读取时重查：已公开内容此后被审核域**明确驳回** ⇒ 读取面临即退出公开面（无需等写路径）', async () => {
  const mutable = mutablePort({ initial: 'pass' });
  const h = makeWiredHarness({ ports: { tms: mutable.port } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  // 前提：此刻确实公开可见（否则下面的"退出公开面"没有意义）。
  assert.equal((await h.service.getPost(USER_B, post.id)).visibility, 'published');
  assert.equal((await h.service.listPosts(USER_B)).items.length, 1);

  // **之后**审核域对同一版本给出明确驳回（走审核域自己的公开送审口，不经过社区写路径）。
  mutable.setMode('block');
  const outcome = await h.moderation.submitScreening({
    actor: USER_A,
    content: { target_ref: { type: 'post', id: post.id, revision: 1 }, text: POST_TEXT, media: [] },
  });
  assert.equal(outcome.overall.decision, 'rejected', '前提：审核域此刻给出明确驳回');
  const conclusion = h.link.conclusionFor({ type: 'post', id: post.id, revision: 1 });
  assert.equal(conclusion.vetoed, true);
  assert.equal(conclusion.publishable, false);
  assert.equal(conclusion.decision, 'rejected');

  // 读取面：立即退出公开面（他人 404 / 列表为空 / 作者显式 hidden + rejected）。
  await expectApiError(() => h.service.getPost(USER_B, post.id), 'NOT_FOUND', 404);
  assert.deepEqual(await h.service.listPosts(USER_B), { items: [], next_cursor: null });
  const mine = await h.service.getPost(USER_A, post.id);
  assert.equal(mine.visibility, 'hidden');
  assert.equal(mine.audit_state, 'rejected');
  // 存储行本身没有被读写路径改写（"退出公开面"是**投影口径**，不是偷偷改库）。
  const row = await h.store.getPost(post.id);
  assert.equal(row.visibility, 'published', '读取重查不得改写存储行');
  assert.equal(row.revision, 1);
  // 社区写入时那份结论保持原样 ⇒ 降级确实来自审核域读取重查。
  assert.equal((await h.store.getModeration('post', post.id, 1)).decision, 'approved');
  assert.equal(h.store.snapshotCounts().posts, 1);
});

test('G1h. 读取时重查：已公开内容此后**退回隔离**（迟到 `pending` / 迟到无结论）⇒ 同样退出公开面，且不伪装成驳回', async () => {
  // ---- (A) 迟到 `pending`（异步供应商路径：该版本级任务被取代为"待回调"）----
  const pendingHarness = makeWiredHarness({ ports: { tms: passingPort() } });
  const pendingPost = await pendingHarness.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  assert.equal((await pendingHarness.service.getPost(USER_B, pendingPost.id)).visibility, 'published');

  const deferred = await pendingHarness.moderation.submitScreening({
    actor: USER_A,
    content: { target_ref: { type: 'post', id: pendingPost.id, revision: 1 }, text: POST_TEXT, media: [] },
    defer_model: true,
  });
  assert.equal(deferred.overall.decision, 'pending', '前提：该版本当前结论为 `pending`');
  const pendingConclusion = pendingHarness.link.conclusionFor({ type: 'post', id: pendingPost.id, revision: 1 });
  assert.equal(pendingConclusion.publishable, false);
  assert.equal(pendingConclusion.vetoed, false, '`pending` 不是驳回');
  assert.equal(pendingConclusion.isolation, true);

  await expectApiError(() => pendingHarness.service.getPost(USER_B, pendingPost.id), 'NOT_FOUND', 404);
  assert.deepEqual(await pendingHarness.service.listPosts(USER_B), { items: [], next_cursor: null });
  const pendingMine = await pendingHarness.service.getPost(USER_A, pendingPost.id);
  assert.equal(pendingMine.visibility, 'hidden', '迟到隔离必须退出公开面');
  assert.equal(pendingMine.audit_state, 'pending', '隔离如实投影为 `pending`（不伪装成 `rejected`）');
  assert.notEqual(pendingMine.audit_state, 'rejected');
  // 存储行与写入时结论同样未被改写。
  assert.equal((await pendingHarness.store.getPost(pendingPost.id)).visibility, 'published');
  assert.equal((await pendingHarness.store.getModeration('post', pendingPost.id, 1)).decision, 'approved');

  // ---- (B) 迟到**无结论**（端口此后回报 unsure ⇒ 隔离）----
  const mutable = mutablePort({ initial: 'pass' });
  const quarantineHarness = makeWiredHarness({ ports: { tms: mutable.port } });
  const post = await quarantineHarness.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  assert.equal((await quarantineHarness.service.getPost(USER_B, post.id)).visibility, 'published');

  mutable.setMode('unsure');
  const screened = await quarantineHarness.moderation.submitScreening({
    actor: USER_A,
    content: { target_ref: { type: 'post', id: post.id, revision: 1 }, text: POST_TEXT, media: [] },
  });
  assert.equal(screened.overall.decision, 'quarantined', '前提：该版本当前结论为隔离');
  const conclusion = quarantineHarness.link.conclusionFor({ type: 'post', id: post.id, revision: 1 });
  assert.equal(conclusion.publishable, false);
  assert.equal(conclusion.vetoed, false, '无结论不是驳回');
  assert.equal(conclusion.decision, 'quarantined');

  await expectApiError(() => quarantineHarness.service.getPost(USER_B, post.id), 'NOT_FOUND', 404);
  const mine = await quarantineHarness.service.getPost(USER_A, post.id);
  assert.equal(mine.visibility, 'hidden');
  assert.equal(mine.audit_state, 'quarantined', '隔离如实投影为 `quarantined`（不伪装成 `rejected`）');
  assert.equal(quarantineHarness.store.snapshotCounts().posts, 1, '读取重查不得新建/删除内容行');
});

test('G1j. 【已登记边界】台账里**完全没有**该版本任务（present:false）⇒ 没有结论可"退回"⇒ 不降级', async () => {
  // 该替身只改"读取面是否声称有该版本任务"，**不会**产出任何"通过"（见夹具注释）。
  const h = makeWiredHarness({
    ports: { tms: passingPort() },
    communityLinkWrapper: noTaskConclusionLink,
  });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  const conclusion = h.link.conclusionFor({ type: 'post', id: post.id, revision: 1 });
  assert.equal(conclusion.present, false, '前提：读取面声称台账里没有该版本任务');
  assert.equal(conclusion.readable, true);
  assert.equal(conclusion.publishable, false, '"没有任务"绝不算可发布');

  // 边界口径：没有结论可"退回"，可见性的主判据仍是社区自己的结论台账 ⇒ 不降级。
  // （接线后**新建**内容不存在这种状态：送审先于落库；此处只登记边界，供监工裁定是否加严。）
  assert.equal((await h.service.getPost(USER_B, post.id)).visibility, 'published');
  assert.equal((await h.service.listPosts(USER_B)).items.length, 1);
});
