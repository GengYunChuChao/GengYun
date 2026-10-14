/**
 * GY-I14（#14）⇄ GY-I15（#15）联动接线 · **读取时重查**（`Refs #14`, `Refs #15`）。
 *
 * 覆盖（派单 §2 第 1 组"公开面不可见"与第 3 组"读取一致"的**时序**面）：
 *   - 内容**已经公开**之后，审核域台账（例如迟到的模型层结论/回调 block）对该**同一版本**
 *     给出**明确驳回** ⇒ 读取面临即降级（`hidden` + `rejected`），**不需要**等写路径；
 *   - 该降级**不是**"替身说了算"：社区自己的结论台账（写入时那份）保持原样，证明降级来自
 *     审核域读取重查（`service.ts` 的 `domainVetoOf`），而不是社区写路径被改写；
 *   - 反向门：审核域**没有**结论（未接线/未送审）时**不得**降级——"没有结论"既不是通过，也不是驳回。
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
  postInput,
} from './community-moderation-fixtures.mjs';

const POST_TEXT = `${CLEAN_TITLE}\n${CLEAN_BODY}`;

test('G1e. 读取时重查：已公开内容此后被审核域明确驳回 ⇒ 读取面临即退出公开面（无需等写路径）', async () => {
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
  assert.equal(conclusion.decision, 'rejected');

  // 读取面：立即退出公开面（他人 404 / 列表为空 / 作者显式 hidden + rejected）。
  await expectApiError(() => h.service.getPost(USER_B, post.id), 'NOT_FOUND', 404);
  assert.deepEqual(await h.service.listPosts(USER_B), { items: [], next_cursor: null });
  const mine = await h.service.getPost(USER_A, post.id);
  assert.equal(mine.visibility, 'hidden');
  assert.equal(mine.audit_state, 'rejected');
  const mineFeed = await h.service.listPosts(USER_A, { mine: true });
  assert.equal(mineFeed.items.length, 1);
  assert.equal(mineFeed.items[0].visibility, 'hidden');
  // 存储行本身没有被读写路径改写（"退出公开面"是**投影口径**，不是偷偷改库）。
  const row = await h.store.getPost(post.id);
  assert.equal(row.visibility, 'published', '读取重查不得改写存储行');
  assert.equal(row.revision, 1);
  // 社区写入时那份结论保持原样 ⇒ 降级确实来自审核域读取重查。
  assert.equal((await h.store.getModeration('post', post.id, 1)).decision, 'approved');
  // 也没有建立第二条内容行。
  assert.equal(h.store.snapshotCounts().posts, 1);
});

test('G1f. 【反向门】审核域对该版本**没有**结论时不得降级（"没有结论"既不是通过也不是驳回）', async () => {
  // 用一个**不被社区送审**的版本号来检验"无结论不降级"：这里改用 mutable 端口先 unsure。
  // 说明：本用例只断言"审核域台账里没有明确驳回 ⇒ 读取面不因该版本被降级"，
  // 不声称任何"模型已通过"（`not_wired`/`unsure` 都不是通过）。
  const mutable = mutablePort({ initial: 'unsure' });
  const h = makeWiredHarness({ ports: { tms: mutable.port } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });

  const screened = h.calls.screen[0].result;
  assert.equal(screened.model_concluded, false, '前提：端口给出的是无结论');
  assert.equal(screened.vetoed, false, '无结论不是驳回');
  const conclusion = h.link.conclusionFor({ type: 'post', id: post.id, revision: 1 });
  assert.equal(conclusion.vetoed, false, '台账里没有明确驳回 ⇒ 读取重查不得降级');
  // 可见性主判据仍是社区自己的结论台账（本接线不把"未接线"变成"一律不可公开"）。
  assert.equal((await h.service.getPost(USER_B, post.id)).visibility, 'published');
  assert.equal((await h.service.listPosts(USER_B)).items.length, 1);
});
