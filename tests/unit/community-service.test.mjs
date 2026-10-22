/**
 * GY-I15（#15）阶段 1 · 社区域服务层用例。
 *
 * 覆盖：先审后发（含 fail-closed）、版本绑定重审、归属与可见性、幂等并发、
 * 点赞幂等与不为负、举报本人可读、分页与参数校验。
 *
 * 断言纪律：**先判 `typeof` 再判值**。
 * 证据边界：合成夹具上的确定性回归，**不是**模型准确率／召回率证据，也不代表
 * 社区已端到端可用（无 HTTP 路由、无数据库迁移、无图片审核）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommunityService } from '../../services/api/src/community/service.ts';
import { createPublishGate } from '../../services/api/src/community/moderation-gate.ts';
import { RULES } from '../../packages/moderation/index.mjs';
import { buildScanLimitText, makeExtraRule, scriptedClock } from '../moderation/_fixtures.mjs';
import {
  ADMIN,
  CLEAN_BODY,
  CLEAN_BODY_NO_HIT,
  CLEAN_TITLE,
  CLEAN_TITLE_NO_HIT,
  DANGEROUS_BODY,
  TEST_SIGNING_KEY,
  USER_A,
  USER_B,
  assertApiError,
  assertApiErrorShape,
  captureError,
  idem,
  makeHarness,
  publishPost,
  withGate,
} from './community-fixtures.mjs';

const MISSING_ID = '00000000-0000-4000-8500-00000000dead';

function postBody(overrides = {}) {
  return { title: CLEAN_TITLE, body: CLEAN_BODY, media_ids: [], ...overrides };
}

/** 断言一条 Post 的契约关键字段类型（先 typeof 再判值）。 */
function assertPostShape(item) {
  assert.equal(typeof item.id, 'string');
  assert.equal(typeof item.revision, 'number');
  assert.equal(typeof item.title, 'string');
  assert.equal(typeof item.body, 'string');
  assert.equal(typeof item.visibility, 'string');
  assert.equal(typeof item.audit_state, 'string');
  assert.equal(typeof item.created_at, 'string');
  assert.equal(typeof item.updated_at, 'string');
  assert.ok(Array.isArray(item.media_ids));
  assert.ok(Array.isArray(item.media));
  assert.equal(typeof item.author, 'object');
  assert.equal(typeof item.author.display_id, 'string');
  assert.equal(typeof item.author.display_name, 'string');
  assert.equal(item.author.state, 'active');
  assert.equal('reporter_id' in item, false, '不得泄露举报人/内部字段');
}

// ---------------------------------------------------------------------------
// 正控制
// ---------------------------------------------------------------------------

test('正控制：干净帖子 ⇒ approved ⇒ published，可被本人与他人列表/详情读到', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(1));
  assertPostShape(post);
  assert.equal(post.visibility, 'published');
  assert.equal(post.audit_state, 'approved');
  assert.equal(post.revision, 1);
  assert.deepEqual(post.media, []);
  assert.equal(post.linked_knowledge_ref, null);
  assert.equal(post.linked_knowledge, null);
  assert.equal(post.crop_id, null);
  assert.equal(post.region_code, null);
  assert.equal(h.store.snapshotCounts().posts, 1);
  assert.equal(h.store.snapshotCounts().moderation, 1);

  for (const actor of [USER_A, USER_B]) {
    const feed = await h.service.listPosts(actor, {});
    assert.equal(feed.items.length, 1);
    assert.equal(feed.items[0].id, post.id);
    assert.equal(feed.next_cursor, null);
    const detail = await h.service.getPost(actor, post.id);
    assert.equal(detail.id, post.id);
    assert.equal(detail.body, CLEAN_BODY);
  }
});

test('正控制：同键同体重放返回同一结果，且不新增内容/审核行', async () => {
  const h = makeHarness();
  const body = postBody();
  const first = await h.service.createPost(USER_A, body, { idempotencyKey: idem(2) });
  const second = await h.service.createPost(USER_A, body, { idempotencyKey: idem(2) });
  assert.equal(second.id, first.id);
  assert.equal(second.revision, first.revision);
  assert.equal(second.created_at, first.created_at);
  assert.deepEqual(h.store.snapshotCounts(), { posts: 1, comments: 0, reports: 0, moderation: 1 });
});

test('正控制：作者编辑后重审通过 ⇒ 仍可见且 revision 递增（旧版本结论不被复用）', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(3));
  const edited = await h.service.editPost(
    USER_A,
    post.id,
    postBody({ body: `${CLEAN_BODY}补充：已按标签条件核对。` }),
    { idempotencyKey: idem(4), ifMatch: `"${post.revision}"` },
  );
  assert.equal(edited.revision, 2);
  assert.equal(edited.visibility, 'published');
  assert.equal(edited.audit_state, 'approved');
  assert.ok(edited.updated_at >= post.updated_at);
  assert.equal(h.store.snapshotCounts().moderation, 2, '新版本必须重新审核（不是复用旧结论）');
  assert.equal(h.store.snapshotCounts().posts, 1);

  const feed = await h.service.listPosts(USER_B, {});
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].revision, 2);
});

// ---------------------------------------------------------------------------
// 先审后发：未获批准一律不得可见
// ---------------------------------------------------------------------------

test('反例 1：确定性规则命中的帖子 ⇒ 拒绝发布（400 + reason_codes），不落任何内容行、不可见', async () => {
  const h = makeHarness();
  const error = await captureError(() =>
    h.service.createPost(USER_A, postBody({ body: DANGEROUS_BODY }), { idempotencyKey: idem(5) }),
  );
  assertApiErrorShape(error, 'INVALID_REQUEST', 400);
  assert.ok(Array.isArray(error.details));
  assert.ok(
    error.details.some((item) => item.code === 'DANGEROUS_MIX'),
    `details 应携带 reason_codes，实际 ${JSON.stringify(error.details)}`,
  );
  for (const detail of error.details) {
    assert.equal(typeof detail.field, 'string');
    assert.equal(typeof detail.code, 'string');
  }
  assert.deepEqual(h.store.snapshotCounts(), { posts: 0, comments: 0, reports: 0, moderation: 1 });
  const feed = await h.service.listPosts(USER_A, {});
  assert.equal(feed.items.length, 0, '被拒内容不得可见（连作者也不得有内容行）');
  const other = await h.service.listPosts(USER_B, {});
  assert.equal(other.items.length, 0);
});

test('反例 2：带图片的帖子 ⇒ 图片未审 ⇒ 422 INPUT_UNCERTAIN，不得发布', async () => {
  const h = makeHarness();
  const mediaId = '00000000-0000-4000-8500-0000000000aa';
  const error = await captureError(() =>
    h.service.createPost(USER_A, postBody({ media_ids: [mediaId] }), { idempotencyKey: idem(6) }),
  );
  assertApiErrorShape(error, 'INPUT_UNCERTAIN', 422);
  assert.ok(error.details.some((item) => item.code === 'MEDIA_NOT_EVALUATED_BY_RULE_LAYER'));
  assert.equal(h.store.snapshotCounts().posts, 0);
});

test('反例 3：扫描截断 ⇒ 不得发布（fail-closed：未检查的尾部不算"未命中"）', async () => {
  const h = makeHarness();
  const error = await captureError(() =>
    h.service.createPost(USER_A, postBody({ body: buildScanLimitText(64) }), { idempotencyKey: idem(7) }),
  );
  assertApiErrorShape(error, 'INPUT_UNCERTAIN', 422);
  assert.ok(error.details.some((item) => item.code === 'RULE_SCAN_TRUNCATED'));
  assert.equal(h.store.snapshotCounts().posts, 0);
});

test('反例 4：规则求值超时 ⇒ 不得发布（"没跑"不等于"通过"）', async () => {
  const h = makeHarness();
  const timedOut = createCommunityService({
    store: h.store,
    authors: h.authors,
    gate: createPublishGate({ budget_ms: 50, clock: scriptedClock([0, 1000, 1000]) }),
    signingKey: TEST_SIGNING_KEY,
    now: h.now,
    newId: h.newId,
  });
  const error = await captureError(() => publishPost(timedOut, USER_A, {}, idem(8)));
  assertApiErrorShape(error, 'INPUT_UNCERTAIN', 422);
  assert.ok(error.details.some((item) => item.code === 'RULE_TIMEOUT'));
  assert.equal(h.store.snapshotCounts().posts, 0);
});

test('反例 5：规则层抛错 ⇒ 即使正文干净也不得发布', async () => {
  const h = makeHarness();
  const broken = createCommunityService({
    store: h.store,
    authors: h.authors,
    gate: createPublishGate({
      matchers: new Proxy(
        {},
        {
          get() {
            throw new Error('boom: matcher lookup');
          },
        },
      ),
    }),
    signingKey: TEST_SIGNING_KEY,
    now: h.now,
    newId: h.newId,
  });
  const error = await captureError(() => publishPost(broken, USER_A, {}, idem(9)));
  assertApiErrorShape(error, 'INPUT_UNCERTAIN', 422);
  assert.ok(error.details.some((item) => item.code === 'RULE_ENGINE_ERROR'));
  assert.equal(h.store.snapshotCounts().posts, 0);
});

test('反例 6：契约合法但规则层无法求值（标题与正文均为空白）⇒ 422，不得发布', async () => {
  const h = makeHarness();
  const error = await captureError(() =>
    h.service.createPost(USER_A, postBody({ title: '   ', body: '    ' }), { idempotencyKey: idem(10) }),
  );
  assertApiErrorShape(error, 'INPUT_UNCERTAIN', 422);
  assert.ok(error.details.some((item) => item.code === 'INPUT_TEXT_EMPTY'));
  assert.equal(h.store.snapshotCounts().posts, 0);
});

test('反例 7：正文在 revision 未变时被改写（绕过服务层）⇒ 立即不可见，作者视角降级为 hidden/pending', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(11));
  const stored = await h.store.getPost(post.id);
  // 模拟"旁路/迁移式写入"：用 CAS 改正文但**不推进 revision**（结论因此不再绑定这份正文）。
  const tampered = await h.store.commitPostIfCurrent(
    post.id,
    { revision: stored.revision },
    { body: `${CLEAN_BODY}（被旁路改写）` },
    null,
  );
  assert.equal(tampered.ok, true, 'CAS 允许"同版本改正文"，靠结论绑定正文摘要来兜底不可见');

  const feed = await h.service.listPosts(USER_B, {});
  assert.equal(feed.items.length, 0, '结论绑定的是正文摘要，正文变了就不得再可见');
  await assert.rejects(h.service.getPost(USER_B, post.id), assertApiError('NOT_FOUND', 404));
  const mine = await h.service.getPost(USER_A, post.id);
  assert.equal(mine.visibility, 'hidden');
  assert.equal(mine.audit_state, 'pending');
});

test('反例 8：规则集升级 ⇒ 旧结论立即失效（退出列表、作者视角 hidden/pending），重审后才可能恢复', async () => {
  const h = makeHarness();
  const clean = await publishPost(h.service, USER_A, { title: CLEAN_TITLE_NO_HIT, body: CLEAN_BODY_NO_HIT }, idem(12));
  const hitByNewRule = await publishPost(h.service, USER_A, {}, idem(13));

  // 规则集升级：新增一条命中"稗草"的规则（真实改变派生 rule_version）。
  const upgraded = withGate(h, { rules: [...RULES, makeExtraRule()] });

  const feed = await upgraded.listPosts(USER_B, {});
  assert.equal(feed.items.length, 0, '规则版本变化后，未重审的旧内容一律不得继续可见');
  for (const id of [clean.id, hitByNewRule.id]) {
    const mine = await upgraded.getPost(USER_A, id);
    assert.equal(mine.visibility, 'hidden');
    assert.equal(mine.audit_state, 'pending');
  }

  const reReviewedClean = await upgraded.reReviewContent(USER_A, { type: 'post', id: clean.id, revision: 1 });
  assert.equal(reReviewedClean.re_reviewed, true);
  assert.equal(reReviewedClean.publishable, true);
  assert.equal(reReviewedClean.visibility, 'published');

  const reReviewedHit = await upgraded.reReviewContent(USER_A, { type: 'post', id: hitByNewRule.id, revision: 1 });
  assert.equal(reReviewedHit.re_reviewed, true);
  assert.equal(reReviewedHit.publishable, false);
  assert.equal(reReviewedHit.decision, 'rejected');
  assert.equal(reReviewedHit.visibility, 'hidden');

  const after = await upgraded.listPosts(USER_B, {});
  assert.equal(after.items.length, 1, '只有重审通过的那条回到列表');
  assert.equal(after.items[0].id, clean.id);

  // 再次重审：结论已新鲜 ⇒ 不重复审核（不是"每次调用都重跑"）。
  const again = await upgraded.reReviewContent(USER_A, { type: 'post', id: clean.id, revision: 1 });
  assert.equal(again.re_reviewed, false);
  assert.equal(again.publishable, true);
});

test('反例 9：编辑被审核拒绝 ⇒ 编辑不生效，旧版本保持其自身已审状态，未审内容不得可见', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(14));
  const error = await captureError(() =>
    h.service.editPost(USER_A, post.id, postBody({ body: DANGEROUS_BODY }), {
      idempotencyKey: idem(15),
      ifMatch: `"${post.revision}"`,
    }),
  );
  assertApiErrorShape(error, 'INVALID_REQUEST', 400);
  const detail = await h.service.getPost(USER_A, post.id);
  assert.equal(detail.revision, 1, '被拒的编辑不得产生新版本');
  assert.equal(detail.body, CLEAN_BODY);
  assert.equal(detail.visibility, 'published');
  const feed = await h.service.listPosts(USER_B, {});
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].body, CLEAN_BODY, '危险新正文不得出现在任何读出');
  assert.ok(!JSON.stringify(feed).includes('草甘膦'));
});

// ---------------------------------------------------------------------------
// 归属与可见性
// ---------------------------------------------------------------------------

test('反例 10：他人 edit/delete/get 一律 NOT_FOUND（不泄露存在性）', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(16));

  const editError = await captureError(() =>
    h.service.editPost(USER_B, post.id, postBody(), { idempotencyKey: idem(17), ifMatch: `"${post.revision}"` }),
  );
  assertApiErrorShape(editError, 'NOT_FOUND', 404);

  const deleteError = await captureError(() =>
    h.service.deletePost(USER_B, post.id, { idempotencyKey: idem(18), ifMatch: `"${post.revision}"` }),
  );
  assertApiErrorShape(deleteError, 'NOT_FOUND', 404);

  const missing = await captureError(() => h.service.getPost(USER_B, MISSING_ID));
  assertApiErrorShape(missing, 'NOT_FOUND', 404);
  // 不存在与"存在但无权限"必须给出同一个错误（不可区分）。
  assert.equal(missing.message, editError.message);
});

test('反例 11：隐藏内容退出列表；删除后连作者也 NOT_FOUND；删除保留记录（软删除）', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(19));
  const ack = await h.service.deletePost(USER_A, post.id, {
    idempotencyKey: idem(20),
    ifMatch: `"${post.revision}"`,
  });
  assert.equal(ack.accepted, true);
  assert.equal(h.store.snapshotCounts().posts, 1, '软删除保留审计证据，不物理销毁');
  const stored = await h.store.getPost(post.id);
  assert.equal(stored.visibility, 'deleted');
  for (const actor of [USER_A, USER_B]) {
    await assert.rejects(h.service.getPost(actor, post.id), assertApiError('NOT_FOUND', 404));
    const list = await h.service.listPosts(actor, { mine: actor === USER_A });
    assert.equal(list.items.length, 0);
  }
});

test('反例 12：作者目录不可用 ⇒ 拒绝投影（503），不伪造作者；且不留下投影不了的内容行', async () => {
  const h = makeHarness({ authors: { resolve: async () => null } });
  const error = await captureError(() => publishPost(h.service, USER_A, {}, idem(21)));
  assertApiErrorShape(error, 'PROVIDER_UNAVAILABLE', 503);
  assert.equal(h.store.snapshotCounts().posts, 0, '作者不可解析时不得落内容行');
});

// ---------------------------------------------------------------------------
// 幂等与并发
// ---------------------------------------------------------------------------

test('反例 13：同键异体 ⇒ IDEMPOTENCY_CONFLICT（并发与串行都算）', async () => {
  const h = makeHarness();
  await h.service.createPost(USER_A, postBody(), { idempotencyKey: idem(22) });
  const serial = await captureError(() =>
    h.service.createPost(USER_A, postBody({ body: `${CLEAN_BODY}改了` }), { idempotencyKey: idem(22) }),
  );
  assertApiErrorShape(serial, 'IDEMPOTENCY_CONFLICT', 409);

  const h2 = makeHarness();
  const results = await Promise.allSettled([
    h2.service.createPost(USER_A, postBody(), { idempotencyKey: idem(23) }),
    h2.service.createPost(USER_A, postBody({ body: `${CLEAN_BODY}并发改了` }), { idempotencyKey: idem(23) }),
  ]);
  const rejected = results.filter((item) => item.status === 'rejected');
  assert.equal(rejected.length, 1, '并发同键异体必须恰好一个失败');
  assertApiErrorShape(rejected[0].reason, 'IDEMPOTENCY_CONFLICT', 409);
  assert.deepEqual(h2.store.snapshotCounts(), { posts: 1, comments: 0, reports: 0, moderation: 1 });
});

test('反例 14：同键同体并发 ⇒ 恰好 1 条内容 + 恰好 1 次审核（两次调用拿到同一结果）', async () => {
  const h = makeHarness();
  const body = postBody();
  const [first, second] = await Promise.all([
    h.service.createPost(USER_A, body, { idempotencyKey: idem(24) }),
    h.service.createPost(USER_A, body, { idempotencyKey: idem(24) }),
  ]);
  assert.equal(typeof first.id, 'string');
  assert.equal(typeof second.id, 'string');
  assert.equal(first.id, second.id);
  assert.equal(first.created_at, second.created_at);
  assert.deepEqual(h.store.snapshotCounts(), { posts: 1, comments: 0, reports: 0, moderation: 1 });
});

test('反例 15：同键并发且占位者长时间未完成 ⇒ 409 REQUEST_IN_PROGRESS（有界等待，不重复落库）', async () => {
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  const h = makeHarness({
    storeWrapper: (base) => ({
      ...base,
      insertPost: async (record, moderation) => {
        await blocker;
        return base.insertPost(record, moderation);
      },
    }),
    idempotencyWaitMs: 20,
  });
  const body = postBody();
  const first = h.service.createPost(USER_A, body, { idempotencyKey: idem(25) });
  const second = h.service.createPost(USER_A, body, { idempotencyKey: idem(25) });
  const error = await captureError(() => second);
  assertApiErrorShape(error, 'REQUEST_IN_PROGRESS', 409);
  release();
  const done = await first;
  assert.equal(typeof done.id, 'string');
  assert.deepEqual(h.rawStore.snapshotCounts(), { posts: 1, comments: 0, reports: 0, moderation: 1 });
});

test('反例 16：发布被拒后释放占位（同键重试不被永久挡住，且重新审核）', async () => {
  const h = makeHarness();
  const bad = postBody({ body: DANGEROUS_BODY });
  await assert.rejects(
    h.service.createPost(USER_A, bad, { idempotencyKey: idem(26) }),
    assertApiError('INVALID_REQUEST', 400),
  );
  // 同键同体重试：占位已释放 ⇒ 重新走审核（仍拒绝），而不是回放"失败"或被 REQUEST_IN_PROGRESS 卡住。
  await assert.rejects(
    h.service.createPost(USER_A, bad, { idempotencyKey: idem(26) }),
    assertApiError('INVALID_REQUEST', 400),
  );
  assert.equal(h.store.snapshotCounts().posts, 0);
  assert.equal(h.store.snapshotCounts().moderation, 2, '失败不入幂等台账，重试会重新审核并留两条隔离结论');
});

// ---------------------------------------------------------------------------
// 点赞 / 投诉
// ---------------------------------------------------------------------------

test('反例 17：重复 PUT like 不重复计数（串行与并发）；点赞不改内容 revision', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(27));
  const ifMatch = `"${post.revision}"`;
  for (let i = 0; i < 5; i += 1) {
    const ack = await h.service.likePosts(USER_B, post.id, { idempotencyKey: idem(28 + i), ifMatch });
    assert.equal(typeof ack.accepted, 'boolean');
    assert.equal(ack.accepted, true);
  }
  assert.equal(await h.service.countLikes('post', post.id), 1);

  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      h.service.likePosts(USER_A, post.id, { idempotencyKey: idem(40 + i), ifMatch }),
    ),
  );
  assert.equal(await h.service.countLikes('post', post.id), 2);
  const after = await h.service.getPost(USER_A, post.id);
  assert.equal(after.revision, post.revision, '点赞不是内容编辑，不得抬高 revision/ETag');
});

test('反例 18：unlike 幂等且不为负（未点赞目标计数恒为 0）', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(50));
  const ifMatch = `"${post.revision}"`;
  await h.service.likePosts(USER_B, post.id, { idempotencyKey: idem(51), ifMatch });
  assert.equal(await h.service.countLikes('post', post.id), 1);
  for (let i = 0; i < 4; i += 1) {
    await h.service.unlikePosts(USER_B, post.id, { idempotencyKey: idem(52 + i), ifMatch });
  }
  assert.equal(await h.service.countLikes('post', post.id), 0);
  assert.equal(await h.service.countLikes('post', MISSING_ID), 0);
  assert.equal(await h.service.countLikes('comment', post.id), 0);
});

test('反例 19：对不可见目标点赞/举报 ⇒ NOT_FOUND；版本不匹配 ⇒ REVISION_CONFLICT', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(60));
  await assert.rejects(
    h.service.likePosts(USER_B, MISSING_ID, { idempotencyKey: idem(61), ifMatch: '"1"' }),
    assertApiError('NOT_FOUND', 404),
  );
  await assert.rejects(
    h.service.likePosts(USER_B, post.id, { idempotencyKey: idem(62), ifMatch: '"9"' }),
    assertApiError('REVISION_CONFLICT', 409),
  );
  await assert.rejects(
    h.service.createReport(
      USER_B,
      { target_ref: { type: 'post', id: MISSING_ID, revision: 1 }, reason_code: 'other' },
      { idempotencyKey: idem(63) },
    ),
    assertApiError('NOT_FOUND', 404),
  );
  await assert.rejects(
    h.service.createReport(
      USER_B,
      { target_ref: { type: 'post', id: post.id, revision: 7 }, reason_code: 'other' },
      { idempotencyKey: idem(64) },
    ),
    assertApiError('REVISION_CONFLICT', 409),
  );
  assert.equal(h.store.snapshotCounts().reports, 0);
});

test('正控制 + 反例 20：举报只给本人读；detail 不入响应（契约 Report 无该字段）', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(70));
  const report = await h.service.createReport(
    USER_B,
    {
      target_ref: { type: 'post', id: post.id, revision: post.revision },
      reason_code: 'dangerous',
      detail: '举报说明不应出现在契约 Report 里',
    },
    { idempotencyKey: idem(71) },
  );
  assert.equal(typeof report.id, 'string');
  assert.equal(typeof report.revision, 'number');
  assert.equal(report.state, 'received');
  assert.equal(report.reason_code, 'dangerous');
  assert.equal('detail' in report, false);
  assert.equal('reporter_id' in report, false, '举报者身份不得投影');
  assert.deepEqual(report.target_ref, { type: 'post', id: post.id, revision: 1 });

  const own = await h.service.getOwnReport(USER_B, report.id);
  assert.equal(own.id, report.id);
  await assert.rejects(h.service.getOwnReport(USER_A, report.id), assertApiError('NOT_FOUND', 404));
  await assert.rejects(h.service.getOwnReport(USER_B, MISSING_ID), assertApiError('NOT_FOUND', 404));

  const stored = await h.store.getReport(report.id);
  assert.equal(stored.detail, '举报说明不应出现在契约 Report 里', 'detail 只留审计，不回显');
  assert.equal(typeof stored.reporter_id, 'string');
});

test('S8 负控制：他人的点赞/举报不串到本人名下（跨用户隔离；同目标双举报互不可读）', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(220));
  const other = await publishPost(h.service, USER_A, {}, idem(221));
  const ifMatch = `"${post.revision}"`;

  // 1) 他人行为不改我的内容：revision / updated_at / visibility 一个都不动。
  await h.service.likePosts(USER_B, post.id, { idempotencyKey: idem(222), ifMatch });
  const afterLike = await h.service.getPost(USER_A, post.id);
  assert.equal(afterLike.revision, post.revision, '他人点赞不是内容编辑');
  assert.equal(afterLike.updated_at, post.updated_at);
  assert.equal(afterLike.visibility, 'published');

  // 2) 计数是"目标维度"的：只涨被点的那个目标，不串到我的其他内容上。
  assert.equal(await h.service.countLikes('post', post.id), 1);
  assert.equal(await h.service.countLikes('post', other.id), 0, '他人点赞不得串到我的其他内容上');

  // 3) 取消点赞按 user 作用域：B 撤赞不得替 A 撤（否则等于"他人能改我的行为账本"）。
  await h.service.likePosts(USER_A, post.id, { idempotencyKey: idem(223), ifMatch });
  assert.equal(await h.service.countLikes('post', post.id), 2);
  await h.service.unlikePosts(USER_B, post.id, { idempotencyKey: idem(224), ifMatch });
  assert.equal(await h.service.countLikes('post', post.id), 1, 'B 撤赞只能撤掉 B 自己那条');

  // 4) 举报：同一目标两账号各报一次 ⇒ 两条独立记录，且各自只能读自己的。
  const reportA = await h.service.createReport(
    USER_A,
    { target_ref: { type: 'post', id: post.id, revision: post.revision }, reason_code: 'other' },
    { idempotencyKey: idem(225) },
  );
  const reportB = await h.service.createReport(
    USER_B,
    { target_ref: { type: 'post', id: post.id, revision: post.revision }, reason_code: 'privacy' },
    { idempotencyKey: idem(226) },
  );
  assert.notEqual(reportA.id, reportB.id, '同一目标的双举报是两条独立记录');
  await assert.rejects(
    h.service.getOwnReport(USER_A, reportB.id),
    assertApiError('NOT_FOUND', 404),
    '不得读到他人的举报',
  );
  await assert.rejects(h.service.getOwnReport(USER_B, reportA.id), assertApiError('NOT_FOUND', 404));
  assert.equal((await h.service.getOwnReport(USER_A, reportA.id)).reason_code, 'other');
  assert.equal((await h.service.getOwnReport(USER_B, reportB.id)).reason_code, 'privacy');
  assert.equal((await h.store.getReport(reportA.id)).reporter_id, USER_A.userId);
  assert.equal((await h.store.getReport(reportB.id)).reporter_id, USER_B.userId);

  // 5) 他人的点赞/举报不改我的列表：条数与 id 集稳定。
  const mine = await h.service.listPosts(USER_A, { mine: true });
  assert.deepEqual(mine.items.map((item) => item.id), [other.id, post.id]);
});

// ---------------------------------------------------------------------------
// 评论
// ---------------------------------------------------------------------------

test('正控制 + 反例 21：干净评论可见；If-Match 指父帖当前 revision；父帖不可见则 NOT_FOUND', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(80));
  const comment = await h.service.createComment(USER_B, post.id, { body: '同感，注意轮换。' }, {
    idempotencyKey: idem(81),
    ifMatch: `"${post.revision}"`,
  });
  assert.equal(comment.post_id, post.id);
  assert.equal(comment.revision, 1);
  assert.equal(comment.visibility, 'published');
  assert.equal(comment.audit_state, 'approved');
  const page = await h.service.listComments(USER_A, post.id, {});
  assert.equal(page.items.length, 1);
  assert.equal(page.next_cursor, null);

  await assert.rejects(
    h.service.createComment(USER_B, post.id, { body: 'x 内容足够长' }, {
      idempotencyKey: idem(82),
      ifMatch: '"9"',
    }),
    assertApiError('REVISION_CONFLICT', 409),
  );
  await assert.rejects(
    h.service.createComment(USER_B, MISSING_ID, { body: 'x 内容足够长' }, {
      idempotencyKey: idem(83),
      ifMatch: '"1"',
    }),
    assertApiError('NOT_FOUND', 404),
  );
});

test('反例 22：被规则拒绝的评论不得存在；删除父帖后评论列表与详情均 NOT_FOUND', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(90));
  const error = await captureError(() =>
    h.service.createComment(USER_B, post.id, { body: DANGEROUS_BODY }, {
      idempotencyKey: idem(91),
      ifMatch: `"${post.revision}"`,
    }),
  );
  assertApiErrorShape(error, 'INVALID_REQUEST', 400);
  assert.equal(h.store.snapshotCounts().comments, 0);

  const comment = await h.service.createComment(USER_B, post.id, { body: '正常评论内容' }, {
    idempotencyKey: idem(92),
    ifMatch: `"${post.revision}"`,
  });
  assert.equal((await h.service.listComments(USER_A, post.id, {})).items.length, 1);

  await h.service.deletePost(USER_A, post.id, { idempotencyKey: idem(93), ifMatch: `"${post.revision}"` });
  await assert.rejects(h.service.listComments(USER_A, post.id, {}), assertApiError('NOT_FOUND', 404));
  await assert.rejects(h.service.getComment(USER_A, comment.id), assertApiError('NOT_FOUND', 404));
});

test('反例 23：他人 edit/delete 评论 ⇒ NOT_FOUND；作者可用，且编辑后必须重审', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(100));
  const comment = await h.service.createComment(USER_B, post.id, { body: '第一条评论内容' }, {
    idempotencyKey: idem(101),
    ifMatch: `"${post.revision}"`,
  });
  await assert.rejects(
    h.service.editComment(USER_A, comment.id, { body: '他人改写' }, {
      idempotencyKey: idem(102),
      ifMatch: `"${comment.revision}"`,
    }),
    assertApiError('NOT_FOUND', 404),
  );
  await assert.rejects(
    h.service.deleteComment(USER_A, comment.id, { idempotencyKey: idem(103), ifMatch: `"${comment.revision}"` }),
    assertApiError('NOT_FOUND', 404),
  );
  const edited = await h.service.editComment(USER_B, comment.id, { body: '作者修订后的评论内容' }, {
    idempotencyKey: idem(104),
    ifMatch: `"${comment.revision}"`,
  });
  assert.equal(edited.revision, 2);
  assert.equal(edited.body, '作者修订后的评论内容');
  assert.equal(h.store.snapshotCounts().moderation, 3, '父帖 1 次 + 评论 2 个版本各 1 次');
});

// ---------------------------------------------------------------------------
// 参数与鉴权
// ---------------------------------------------------------------------------

test('反例 24：契约约束逐条（多余字段/长度/枚举/重复项/占位 id）⇒ 400 INVALID_REQUEST', async () => {
  const h = makeHarness();
  const cases = [
    ['多余字段', postBody({ extra: 1 }), 'UNKNOWN_FIELD'],
    ['缺 media_ids', { title: CLEAN_TITLE, body: CLEAN_BODY }, 'REQUIRED'],
    ['title 超长', postBody({ title: 'a'.repeat(121) }), 'TOO_LONG'],
    ['body 为空串', postBody({ body: '' }), 'TOO_SHORT'],
    ['region_code 不合模式', postBody({ region_code: '3301' }), 'PATTERN_MISMATCH'],
    ['media_ids 重复', postBody({ media_ids: [MISSING_ID, MISSING_ID] }), 'DUPLICATE_ITEM'],
    ['media_ids 超 3', postBody({ media_ids: [MISSING_ID, '00000000-0000-4000-8500-0000000000b1', '00000000-0000-4000-8500-0000000000b2', '00000000-0000-4000-8500-0000000000b3'] }), 'TOO_MANY_ITEMS'],
  ];
  let key = 110;
  for (const [name, body, expectedCode] of cases) {
    const error = await captureError(() => h.service.createPost(USER_A, body, { idempotencyKey: idem(key++) }));
    assertApiErrorShape(error, 'INVALID_REQUEST', 400);
    assert.ok(
      error.details.some((item) => item.code === expectedCode),
      `${name} 应带 ${expectedCode}，实际 ${JSON.stringify(error.details)}`,
    );
  }
  const reportError = await captureError(() =>
    h.service.createReport(
      USER_A,
      { target_ref: { type: 'post', id: MISSING_ID, revision: 1 }, reason_code: 'spam' },
      { idempotencyKey: idem(130) },
    ),
  );
  assertApiErrorShape(reportError, 'INVALID_REQUEST', 400);
  assert.ok(reportError.details.some((item) => item.code === 'INVALID_ENUM'));

  const badId = await captureError(() => h.service.getPost(USER_A, 'not-a-uuid'));
  assertApiErrorShape(badId, 'INVALID_REQUEST', 400);
  assert.equal(h.store.snapshotCounts().posts, 0);
});

test('反例 25：缺少/非法 Idempotency-Key 与 If-Match 的契约错误码', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, {}, idem(140));
  await assert.rejects(h.service.createPost(USER_A, postBody(), {}), assertApiError('IDEMPOTENCY_KEY_REQUIRED', 400));
  await assert.rejects(
    h.service.createPost(USER_A, postBody(), { idempotencyKey: 'short' }),
    assertApiError('IDEMPOTENCY_KEY_REQUIRED', 400),
  );
  await assert.rejects(
    h.service.editPost(USER_A, post.id, postBody(), { idempotencyKey: idem(141) }),
    assertApiError('REVISION_REQUIRED', 428),
  );
  await assert.rejects(
    h.service.editPost(USER_A, post.id, postBody(), { idempotencyKey: idem(142), ifMatch: '*' }),
    assertApiError('INVALID_REQUEST', 400),
  );
  await assert.rejects(
    h.service.likePosts(USER_A, post.id, { idempotencyKey: idem(143) }),
    assertApiError('REVISION_REQUIRED', 428),
  );
});

test('反例 26：非用户会话 / 缺会话必须拒绝（社区需要用户会话权限）', async () => {
  const h = makeHarness();
  await assert.rejects(h.service.listPosts(ADMIN, {}), assertApiError('SCOPE_DENIED', 403));
  await assert.rejects(h.service.listPosts(undefined, {}), assertApiError('SESSION_REQUIRED', 401));
  await assert.rejects(
    h.service.listPosts({ userId: USER_A.userId, role: 'user', authEpoch: 0 }, {}),
    assertApiError('SESSION_REQUIRED', 401),
  );
  await assert.rejects(
    h.service.createPost({ userId: USER_A.userId, role: 'admin', authEpoch: 1 }, postBody(), {
      idempotencyKey: idem(150),
    }),
    assertApiError('SCOPE_DENIED', 403),
  );
});

test('反例 27：显式知识关联 ⇒ 409 OBJECT_UNAVAILABLE（未接线可用性核验，不静默丢弃关联）', async () => {
  const h = makeHarness();
  const error = await captureError(() =>
    h.service.createPost(
      USER_A,
      postBody({ linked_knowledge_ref: { type: 'herbicide', id: 'hb-1', revision: 1 } }),
      { idempotencyKey: idem(151) },
    ),
  );
  assertApiErrorShape(error, 'OBJECT_UNAVAILABLE', 409);
  assert.equal(h.store.snapshotCounts().posts, 0);
  // 显式 null 与省略等价：都不建立关联。
  const explicitNull = await publishPost(h.service, USER_A, { linked_knowledge_ref: null }, idem(152));
  assert.equal(explicitNull.linked_knowledge_ref, null);
  assert.equal(explicitNull.linked_knowledge, null);
});

// ---------------------------------------------------------------------------
// 分页
// ---------------------------------------------------------------------------

test('反例 28 + 正控制：分页 items+next_cursor 稳定；limit 超上限/游标篡改/跨主体均被拒', async () => {
  const h = makeHarness();
  for (let i = 0; i < 3; i += 1) {
    await publishPost(h.service, USER_A, { body: `${CLEAN_BODY}（第 ${i} 条）` }, idem(160 + i));
  }
  const page1 = await h.service.listPosts(USER_A, { limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.equal(typeof page1.next_cursor, 'string');
  assert.ok(page1.next_cursor.length <= 2048);
  const page2 = await h.service.listPosts(USER_A, { limit: 2, cursor: page1.next_cursor });
  assert.equal(page2.items.length, 1);
  assert.equal(page2.next_cursor, null);
  const ids = new Set([...page1.items, ...page2.items].map((item) => item.id));
  assert.equal(ids.size, 3, '翻页不得重复或漏项');
  for (let i = 1; i < page1.items.length; i += 1) {
    assert.ok(page1.items[i - 1].created_at >= page1.items[i].created_at, '列表按 created_at 降序');
  }

  // 游标不绑定 limit：改 limit 语义上是"下一段更短"，不改变过滤条件（仍可用）。
  const shorterPage = await h.service.listPosts(USER_A, { limit: 1, cursor: page1.next_cursor });
  assert.equal(shorterPage.items.length, 1);
  assert.equal(shorterPage.items[0].id, page2.items[0].id);

  await assert.rejects(h.service.listPosts(USER_A, { limit: 51 }), assertApiError('INVALID_REQUEST', 400));
  await assert.rejects(h.service.listPosts(USER_A, { limit: 0 }), assertApiError('INVALID_REQUEST', 400));
  await assert.rejects(
    h.service.listPosts(USER_A, { cursor: `${page1.next_cursor}tampered` }),
    assertApiError('INVALID_CURSOR', 400),
  );
  await assert.rejects(
    h.service.listPosts(USER_B, { cursor: page1.next_cursor }),
    assertApiError('INVALID_CURSOR', 400),
    '游标绑定主体，不得跨主体复用',
  );
  await assert.rejects(
    h.service.listPosts(USER_A, { cursor: page1.next_cursor, region_code: '330100' }),
    assertApiError('INVALID_CURSOR', 400),
    '游标绑定过滤条件，不得跨过滤复用',
  );
});

test('反例 28b（#444 §S5 回归）：下推的 LIMIT 落在发布口径复核之后 —— 被降级的新行不截短整页', async () => {
  const h = makeHarness();
  const posts = [];
  for (let i = 0; i < 3; i += 1) {
    posts.push(await publishPost(h.service, USER_A, { body: `${CLEAN_BODY}（下推算例第 ${i} 条）` }, idem(200 + i)));
  }
  // 人为制造"更新的、但版本级审核结论缺失"的内容行：内容行是 published，台账行没有。
  // 读取时复核（effectiveState）必须把它们降级为不可公开，而它们占着最新的排序窗口 ——
  // 所以"先按 LIMIT 截一页、再在应用层过滤"会直接掉行；下推 + 复核后补齐才不会。
  const orphanAt = '2026-10-12T05:00:00.000Z';
  for (const id of ['00000000-0000-4000-8500-0000000a0001', '00000000-0000-4000-8500-0000000a0002']) {
    assert.equal(
      await h.rawStore.insertPost(
        {
          id,
          revision: 1,
          author_id: USER_A.userId,
          title: CLEAN_TITLE,
          body: CLEAN_BODY,
          crop_id: null,
          region_code: null,
          media_ids: [],
          linked_knowledge_ref: null,
          visibility: 'published',
          audit_state: 'approved',
          created_at: orphanAt,
          updated_at: orphanAt,
        },
        null,
      ),
      true,
    );
  }
  const page1 = await h.service.listPosts(USER_A, { limit: 2 });
  assert.deepEqual(
    page1.items.map((item) => item.id),
    [posts[2].id, posts[1].id],
    '前两个页位被降级行占掉时必须继续下取补齐，不得返回残页',
  );
  assert.equal(typeof page1.next_cursor, 'string');
  const page2 = await h.service.listPosts(USER_A, { limit: 2, cursor: page1.next_cursor });
  assert.deepEqual(page2.items.map((item) => item.id), [posts[0].id]);
  assert.equal(page2.next_cursor, null);
  const ids = [...page1.items, ...page2.items].map((item) => item.id);
  assert.equal(new Set(ids).size, 3, '翻页既不重复也不漏项');
  assert.equal(
    ids.some((id) => id.startsWith('00000000-0000-4000-8500-0000000a00')),
    false,
    '复核降级的行不得出现在公开列表',
  );
});

test('正控制：作物/地区筛选在存储层生效（下推谓词与逐条比较等价，且不与分页互相干扰）', async () => {
  const h = makeHarness();
  const wheatHz = await publishPost(h.service, USER_A, { crop_id: 'crop-wheat', region_code: '330100' }, idem(210));
  const riceHz = await publishPost(h.service, USER_A, { crop_id: 'crop-rice', region_code: '330100' }, idem(211));
  const wheatBj = await publishPost(h.service, USER_B, { crop_id: 'crop-wheat', region_code: '330200' }, idem(212));
  const full = await h.service.listPosts(USER_A, {});
  assert.deepEqual(full.items.map((item) => item.id), [wheatBj.id, riceHz.id, wheatHz.id]);

  const cases = [
    [{ crop_id: 'crop-wheat' }, [wheatBj.id, wheatHz.id]],
    [{ region_code: '330100' }, [riceHz.id, wheatHz.id]],
    [{ crop_id: 'crop-wheat', region_code: '330200' }, [wheatBj.id]],
    [{ crop_id: 'crop-rice', region_code: '330200' }, []],
  ];
  for (const [filter, expected] of cases) {
    const page = await h.service.listPosts(USER_A, filter);
    assert.deepEqual(page.items.map((item) => item.id), expected, `筛选 ${JSON.stringify(filter)} 的结果集`);
    // 与"全量取回再逐条比较"的参照实现比对：下推不得改变语义。
    const reference = full.items
      .filter((item) => (filter.crop_id === undefined || item.crop_id === filter.crop_id))
      .filter((item) => (filter.region_code === undefined || item.region_code === filter.region_code))
      .map((item) => item.id);
    assert.deepEqual(page.items.map((item) => item.id), reference);
  }

  // 筛选 + 分页：同一过滤集内按 keyset 前进，取尽后不再给游标。
  const firstPage = await h.service.listPosts(USER_A, { crop_id: 'crop-wheat', limit: 1 });
  assert.deepEqual(firstPage.items.map((item) => item.id), [wheatBj.id]);
  const secondPage = await h.service.listPosts(USER_A, {
    crop_id: 'crop-wheat',
    limit: 1,
    cursor: firstPage.next_cursor,
  });
  assert.deepEqual(secondPage.items.map((item) => item.id), [wheatHz.id]);
  assert.equal(secondPage.next_cursor, null);
});

test('反例 29：游标过期（>15 分钟）⇒ INVALID_CURSOR', async () => {  let epoch = Date.UTC(2026, 9, 12, 3, 0, 0);
  const h = makeHarness({ now: () => new Date(epoch) });
  for (let i = 0; i < 3; i += 1) {
    epoch += 1000;
    await publishPost(h.service, USER_A, { body: `${CLEAN_BODY}（过期用例第 ${i} 条）` }, idem(180 + i));
  }
  const page1 = await h.service.listPosts(USER_A, { limit: 2 });
  assert.equal(typeof page1.next_cursor, 'string');
  // 仍在有效期内可翻页
  const ok = await h.service.listPosts(USER_A, { limit: 2, cursor: page1.next_cursor });
  assert.equal(ok.items.length, 1);
  epoch += 16 * 60 * 1000;
  await assert.rejects(
    h.service.listPosts(USER_A, { cursor: page1.next_cursor }),
    assertApiError('INVALID_CURSOR', 400),
  );
});

test('反例 30：已下架内容不得被重审/旧回调复活（删除 + 规则集升级 + 重审后仍不可见）', async () => {
  const h = makeHarness();
  const post = await publishPost(h.service, USER_A, { title: CLEAN_TITLE_NO_HIT, body: CLEAN_BODY_NO_HIT }, idem(190));
  const comment = await h.service.createComment(USER_B, post.id, { body: '待删除的评论内容' }, {
    idempotencyKey: idem(191),
    ifMatch: `"${post.revision}"`,
  });
  await h.service.deleteComment(USER_B, comment.id, { idempotencyKey: idem(192), ifMatch: `"${comment.revision}"` });
  await h.service.deletePost(USER_A, post.id, { idempotencyKey: idem(193), ifMatch: `"${post.revision}"` });

  const upgraded = withGate(h, { rules: [...RULES, makeExtraRule()] });
  const postReview = await upgraded.reReviewContent(USER_A, { type: 'post', id: post.id, revision: 1 });
  assert.equal(postReview.re_reviewed, false, '已下架对象不做重审，更不得复活');
  assert.equal(postReview.visibility, 'deleted');
  assert.equal(postReview.publishable, false);
  const commentReview = await upgraded.reReviewContent(USER_B, { type: 'comment', id: comment.id, revision: 1 });
  assert.equal(commentReview.re_reviewed, false);
  assert.equal(commentReview.visibility, 'deleted');

  await assert.rejects(upgraded.getPost(USER_A, post.id), assertApiError('NOT_FOUND', 404));
  await assert.rejects(upgraded.getComment(USER_B, comment.id), assertApiError('NOT_FOUND', 404));
  assert.equal((await h.store.getPost(post.id)).visibility, 'deleted');
  assert.equal((await h.store.getComment(comment.id)).visibility, 'deleted');
  assert.equal((await upgraded.listPosts(USER_A, { mine: true })).items.length, 0, '已下架内容不得回到任何列表');
});

test('正控制：mine=true 只返回本人的非删除内容（含未公开版本），他人 feed 不含', async () => {
  const h = makeHarness();
  const mine = await publishPost(h.service, USER_A, {}, idem(170));
  const other = await publishPost(h.service, USER_B, {}, idem(171));
  // 让 USER_A 的那条因规则集升级而失效（对读者不可见，但作者仍可在 mine 里看到）
  const upgraded = withGate(h, { rules: [...RULES, makeExtraRule()] });
  const publicFeed = await upgraded.listPosts(USER_A, {});
  assert.equal(publicFeed.items.length, 0);
  const ownFeed = await upgraded.listPosts(USER_A, { mine: true });
  assert.equal(ownFeed.items.length, 1);
  assert.equal(ownFeed.items[0].id, mine.id);
  assert.equal(ownFeed.items[0].visibility, 'hidden');
  assert.equal(ownFeed.items[0].audit_state, 'pending');
  const otherOwn = await upgraded.listPosts(USER_B, { mine: true });
  assert.equal(otherOwn.items.length, 1);
  assert.equal(otherOwn.items[0].id, other.id);
});
