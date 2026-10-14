/**
 * GY-I14（#14）⇄ GY-I15（#15）联动接线 · **先审后发**与**规则先挡不可绕开**（`Refs #14`, `Refs #15`）。
 *
 * 覆盖（派单 §2 第 1、7 组）：
 *   G1-a 投稿：审核域**明确驳回**（模型层 block）⇒ 内容行**不落库**、公开面不可见、驳回结论**如实留档**，
 *        且送审入参与社区"同一份文本/版本/媒体"口径逐条一致；
 *   G1-b 评论：同一口径（评论行不落库、评论列表空、父帖不受影响）；
 *   G1-c 规则层**未结论**（带媒体 ⇒ 规则层不评估图片）⇒ 内容行不落库、公开面不可见、**零模型外发**；
 *   G1-d **口径登记（如实）**：审核域"模型层未接线/无结论"**不是通过**、也不构成本实现的否决；
 *        公开与否仍由社区**规则层阶段**的结论决定（`community/moderation-link.ts` 文件头第 30–35 行已披露）；
 *   G7    不得绕开规则先挡：危险文本在**明确放行的**模型端口存在时仍被规则层拦住，且**零模型外发**、
 *        审核域**零任务**（规则先挡的记录口径仍是社区 `gate.evaluate`）。
 *
 * 声明（不得误读）：模型端口全是**合成替身**（`provider.synthetic === true`），本文件**不发起任何真实
 * 模型/付费调用**；用例只证明"接线与时序口径"，不构成审核准确率/召回率或真实供应商可用性证据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLEAN_TITLE, DANGEROUS_BODY, idem } from './community-fixtures.mjs';
import {
  CLEAN_BODY,
  USER_A,
  USER_B,
  blockingPort,
  deferringModerationPort,
  expectApiError,
  markerPort,
  makeWiredHarness,
  passingPort,
  postInput,
} from './community-moderation-fixtures.mjs';

const BLOCK_MARKER = 'S9-MODEL-BLOCK';

// ---------------------------------------------------------------------------
// G1-a 投稿：明确驳回 ⇒ 不落内容行
// ---------------------------------------------------------------------------

test('G1a. 投稿被审核域明确驳回 ⇒ 内容行不落库、公开面不可见、结论如实留档（送审入参同社区口径）', async () => {
  const h = makeWiredHarness({ ports: { tms: blockingPort() } });
  const actor = USER_A;

  const error = await expectApiError(
    () => h.service.createPost(actor, postInput(), { idempotencyKey: idem(1) }),
    'INVALID_REQUEST',
    400,
  );
  // 明确驳回 ⇒ 原因码逐条回传（不是空拒绝，也不是 503/409 的含糊映射）。
  assert.ok(
    error.details.some((detail) => detail.field === 'reason_codes' && typeof detail.code === 'string'),
    `必须回传审核域原因码，实际 ${JSON.stringify(error.details)}`,
  );

  // 送审入参：与社区**同一份**文本/版本/媒体口径（`postModerationText` = title + LF + body）。
  assert.equal(h.calls.screen.length, 1, '投稿必须先送审审核域一次');
  const sent = h.calls.screen[0].input;
  assert.deepEqual(sent.actor, { userId: actor.userId, role: 'user', authEpoch: actor.authEpoch });
  assert.equal(sent.content.text, `${CLEAN_TITLE}\n${CLEAN_BODY}`, '送审文本必须与社区口径逐字一致');
  assert.deepEqual(sent.content.media, [], '媒体必须**显式**声明（省略 ≠ 没有媒体）');
  assert.deepEqual(sent.content.target_ref, { type: 'post', id: sent.content.target_ref.id, revision: 1 });
  const attemptedId = sent.content.target_ref.id;

  // 结论口径：模型层明确驳回、规则层通过（不是"规则命中"也不是"无结论"）。
  const screened = h.calls.screen[0].result;
  assert.equal(screened.vetoed, true);
  assert.equal(screened.model_layer, 'rejected');
  assert.equal(screened.rule_layer, 'passed');
  assert.equal(screened.model_concluded, true);

  // **内容行不落库**：存储里没有帖子行，也没有任何内容行。
  assert.equal(await h.store.getPost(attemptedId), null, '被明确驳回的投稿不得留下内容行');
  assert.deepEqual(h.store.snapshotCounts(), { posts: 0, comments: 0, reports: 0, moderation: 1 });

  // **公开面不可见**：他人/本人列表都为空，详情 404（不泄露存在性）。
  for (const viewer of [actor, USER_B]) {
    const feed = await h.service.listPosts(viewer);
    assert.deepEqual(feed, { items: [], next_cursor: null }, '被驳回内容不得出现在任何列表');
  }
  await expectApiError(() => h.service.getPost(USER_B, attemptedId), 'NOT_FOUND', 404);

  // 驳回结论**如实留档**（不静默丢弃）：decision/revision 与本次送审一致。
  const record = await h.store.getModeration('post', attemptedId, 1);
  assert.notEqual(record, null, '明确驳回必须留下拒绝结论（供复核）');
  assert.equal(record.decision, 'rejected');
  assert.equal(record.target_ref.revision, 1);
  assert.ok(
    record.reason_codes.includes('MODEL_BLOCKED'),
    `留档原因码必须来自审核域，实际 ${JSON.stringify(record.reason_codes)}`,
  );
});

// ---------------------------------------------------------------------------
// G1-b 评论：明确驳回 ⇒ 不落评论行
// ---------------------------------------------------------------------------

test('G1b. 评论被审核域明确驳回 ⇒ 评论行不落库、评论列表为空、父帖不受影响', async () => {
  const { port } = markerPort({ blockMarker: BLOCK_MARKER });
  const h = makeWiredHarness({ ports: { tms: port } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  assert.equal(post.revision, 1);

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

  // 评论行不落库：列表为空、评论行不存在、存储计数里没有评论。
  const comments = await h.service.listComments(USER_A, post.id);
  assert.deepEqual(comments, { items: [], next_cursor: null }, '被驳回的评论不得出现在评论列表');
  assert.equal(h.store.snapshotCounts().comments, 0, '被驳回的评论不得留下内容行');
  // 父帖不受影响：仍然公开可见、仍是 revision 1。
  const stillThere = await h.service.getPost(USER_B, post.id);
  assert.equal(stillThere.revision, 1);
  assert.equal(stillThere.visibility, 'published');
  assert.equal(stillThere.audit_state, 'approved');

  // 对照：同一条装配下，不含标记词的评论正常通过（证明上面的拒绝来自审核域驳回而非"一律拒绝"）。
  const okComment = await h.service.createComment(
    USER_B,
    post.id,
    { body: '换一种说法：按标签说明处理，注意轮换。' },
    { idempotencyKey: idem(3), ifMatch: '"1"' },
  );
  assert.equal(okComment.revision, 1);
  assert.equal((await h.service.listComments(USER_A, post.id)).items.length, 1);
  // 评论也走版本级送审（评论 revision 1 的版本级任务）。
  const commentScreen = h.calls.screen.at(-1);
  assert.deepEqual(commentScreen.input.content.target_ref.type, 'comment');
  assert.equal(commentScreen.input.content.media.length, 0);
});

// ---------------------------------------------------------------------------
// G1-c 规则层未结论 ⇒ 不落内容行（且零模型外发）
// ---------------------------------------------------------------------------

test('G1c. 规则层未结论（带媒体：规则层不评估图片）⇒ 内容行不落库、公开面不可见、零模型外发', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort() } });

  const error = await expectApiError(
    () =>
      h.service.createPost(USER_A, postInput({ media_ids: ['00000000-0000-4000-8000-000000000000'] }), {
        idempotencyKey: idem(1),
      }),
    'INPUT_UNCERTAIN',
    422,
  );
  assert.ok(error.details.length > 0, '未结论也必须回传原因码');
  assert.equal(h.store.snapshotCounts().posts, 0, '未结论的投稿不得留下内容行');
  assert.deepEqual(await h.service.listPosts(USER_B), { items: [], next_cursor: null });
  // 规则层未结论 ⇒ **根本不送审**（更不外发给模型端口）：审核域零任务、零端口调用。
  assert.equal(h.calls.screen.length, 0, '规则层未放行时不得送审审核域');
  assert.equal(h.moderation.counts().tasks, 0, '审核域不得留下任何版本级任务');
});

// ---------------------------------------------------------------------------
// G1-d 隔离（未接线/无结论）⇒ 非公开；但与"驳回"分开表达
// ---------------------------------------------------------------------------

test('G1d. 审核域"未接线/无结论"（隔离）⇒ 内容行不落库、公开面不可见，且**不伪装成驳回**', async () => {
  // 出厂 `stub` 装配：文本端口是**明确标注的替身**，一律回报"无结论"（`not_wired`）。
  const h = makeWiredHarness({ ports: { tms: undefined } });

  const error = await expectApiError(
    () => h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) }),
    'INPUT_UNCERTAIN',
    422,
  );
  assert.ok(error.details.length > 0, '隔离也必须回传原因码');

  const attemptedId = h.calls.screen[0].input.content.target_ref.id;
  const screened = h.calls.screen[0].result;
  // (1) 审核域**没有**给出"通过"：既不 approve，也不是驳回，而是"未接线/无结论"⇒ **隔离**。
  assert.equal(screened.model_layer, 'not_wired', '替身端口必须如实标为未接线');
  assert.equal(screened.model_concluded, false, '"未接线"不得被当成已有结论');
  assert.equal(screened.publishable, false, '未接线/无结论**不得发布**（B09：无法判断不公开）');
  assert.equal(screened.vetoed, false, '"未接线"**不是驳回**（不伪装成驳回）');
  assert.equal(screened.isolation, true, '未接线/无结论落在"隔离"态');
  assert.ok(
    screened.provider_origins.every((origin) => origin !== 'injected' && origin !== 'callback'),
    `替身端口不得冒充已接线端口，实际 ${JSON.stringify(screened.provider_origins)}`,
  );

  // (2) **内容行不落库**、公开面不可见（本人/他人都看不到）。
  assert.equal(await h.store.getPost(attemptedId), null, '隔离内容不得留下内容行');
  assert.equal(h.store.snapshotCounts().posts, 0);
  for (const viewer of [USER_A, USER_B]) {
    assert.deepEqual(await h.service.listPosts(viewer), { items: [], next_cursor: null });
  }
  await expectApiError(() => h.service.getPost(USER_B, attemptedId), 'NOT_FOUND', 404);

  // (3) 台账**如实区分隔离与驳回**：结论记 `quarantined`（不是 `rejected`），规则层确实通过（故不是规则驳回）。
  const recorded = await h.store.getModeration('post', attemptedId, 1);
  assert.notEqual(recorded, null, '隔离结论同样必须留档');
  assert.equal(recorded.decision, 'quarantined', '隔离不得被写成 `rejected`（不伪装成驳回）');
  assert.equal(recorded.hard_rule_passed, true, '规则层是通过的 ⇒ 这是审核域层面的隔离');
  // 审核域台账侧同形：任务已登记但不可发布、也不是驳回。
  const conclusion = h.link.conclusionFor({ type: 'post', id: attemptedId, revision: 1 });
  assert.equal(conclusion.present, true, '版本级任务必须已登记（GET /jobs/{id} 可读）');
  assert.equal(conclusion.publishable, false);
  assert.equal(conclusion.vetoed, false);
  assert.equal(conclusion.isolation, true);
  assert.notEqual(conclusion.decision, 'approved', '审核域台账不得出现"替身冒充的通过"');
  assert.equal(h.moderation.counts().substitutes.includes('tms'), true, 'stub 下文本端口确为替身');
  assert.equal(h.link.counts().authority_origin, 'community_store');
});

test('G1g. 审核域返回 `pending`（异步供应商路径）⇒ 同样非公开，且台账记 `pending` 而非 `rejected`', async () => {
  // 用真实审核域 + 真实联动端口，只把"模型层留待回调"开关打开（异步供应商的正常形态）。
  const h = makeWiredHarness({ ports: { tms: passingPort() }, moderationPortWrapper: deferringModerationPort });

  const error = await expectApiError(
    () => h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) }),
    'INPUT_UNCERTAIN',
    422,
  );
  assert.ok(Array.isArray(error.details), '隔离的错误封套必须带 details 数组');
  // 说明：`pending` 是"等回调"，审核域此时可以不产出 `reason_codes`（任务里的 `reasons`
  // 记 `model_screening_pending`），因此这里**不**要求 details 非空——但必须**非公开**。

  const attemptedId = h.calls.screen[0].input.content.target_ref.id;
  const screened = h.calls.screen[0].result;
  assert.equal(screened.decision, 'pending', '异步路径必须如实落 `pending`');
  assert.equal(screened.publishable, false, '`pending` 不得发布');
  assert.equal(screened.vetoed, false, '`pending` 不是驳回');
  assert.equal(screened.isolation, true);

  // 不落库、公开面不可见。
  assert.equal(await h.store.getPost(attemptedId), null);
  assert.equal(h.store.snapshotCounts().posts, 0);
  assert.deepEqual(await h.service.listPosts(USER_B), { items: [], next_cursor: null });
  const recorded = await h.store.getModeration('post', attemptedId, 1);
  assert.equal(recorded.decision, 'pending', '待审核如实记 `pending`（不伪装成驳回）');
  assert.equal(recorded.hard_rule_passed, true);
});

test('G1i. 【正控制】明确标注的合成 `pass` 端口 ⇒ 审核域 `approved` ⇒ 社区可发布（不得用"未接线"冒充通过）', async () => {
  const syntheticPass = passingPort();
  // 前提：这个端口是**明确标注的合成端口**（不是真实供应商，也不是"未接线"）。
  assert.equal(syntheticPass.provider.synthetic, true, '合成端口必须显式标注 synthetic');
  assert.equal(syntheticPass.seams.liveGate.open, false, '合成端口不得持有可用网络 seam');
  const h = makeWiredHarness({ ports: { tms: syntheticPass } });

  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  assert.equal(post.visibility, 'published');
  assert.equal(post.audit_state, 'approved');

  const screened = h.calls.screen[0].result;
  assert.equal(screened.publishable, true, '审核域明确通过 ⇒ 可发布');
  assert.equal(screened.decision, 'approved');
  assert.equal(screened.model_layer, 'approved');
  assert.equal(screened.model_concluded, true, '这是**真实结论**（合成端口显式注入），不是"未接线"');
  assert.notEqual(screened.model_layer, 'not_wired');
  assert.equal(screened.vetoed, false);
  assert.equal(screened.isolation, false);
  // 文本端口不是替身（是显式注入的合成端口）⇒ "未接线"绝不被用来冒充通过。
  assert.equal(h.moderation.counts().substitutes.includes('tms'), false);
  assert.equal(h.moderation.counts().authority_origin, 'community_store');
  // 公开面确实可见（正控制闭环）。
  assert.equal((await h.service.getPost(USER_B, post.id)).visibility, 'published');
  assert.equal((await h.service.listPosts(USER_B)).items.length, 1);
});

// ---------------------------------------------------------------------------
// G7 不得绕开规则先挡
// ---------------------------------------------------------------------------

test('G7. 不得绕开规则先挡：危险文本在"明确放行"的模型端口下仍被规则拦住，零外发、审核域零任务', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  // 显式放行的端口确实"活着"（对照用例会证明它本来会放行干净文本）。
  const portCallsBefore = h.moderation.counts().tasks;

  const error = await expectApiError(
    () => h.service.createPost(USER_A, postInput({ body: DANGEROUS_BODY }), { idempotencyKey: idem(1) }),
    'INVALID_REQUEST',
    400,
  );
  assert.ok(
    error.details.some((detail) => detail.code === 'DANGEROUS_MIX'),
    `必须如实回传规则层命中码，实际 ${JSON.stringify(error.details)}`,
  );

  // 规则先挡 ⇒ 危险文本**不落内容行**、公开面不可见。
  assert.equal(h.store.snapshotCounts().posts, 0);
  assert.deepEqual(await h.service.listPosts(USER_B), { items: [], next_cursor: null });
  // 规则先挡 ⇒ 不送审：审核域零任务（记录口径仍是社区 gate.evaluate，不另起规则引擎）。
  assert.equal(h.moderation.counts().tasks, portCallsBefore, '规则先挡时不得建立审核域任务');
  assert.equal(h.calls.screen.length, 0, '规则先挡时不得送审审核域');

  // 评论同样不得绕开规则先挡。
  const cleanPost = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(2) });
  await expectApiError(
    () =>
      h.service.createComment(USER_B, cleanPost.id, { body: DANGEROUS_BODY }, { idempotencyKey: idem(3), ifMatch: '"1"' }),
    'INVALID_REQUEST',
    400,
  );
  assert.equal(h.store.snapshotCounts().comments, 0);

  // 对照：同一条装配下干净文本**确实**会被送审并建任务（证明上面的"零任务"来自规则先挡，
  // 而不是审核域整体不可用/端口是死的）。
  const tasksBefore = h.moderation.counts().tasks;
  const screensBefore = h.calls.screen.length;
  await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(4) });
  assert.equal(h.moderation.counts().tasks, tasksBefore + 1, '干净文本必须建立版本级审核任务');
  assert.equal(h.calls.screen.length, screensBefore + 1, '干净文本必须先送审');
});
