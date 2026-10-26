/**
 * S3 · 社区帖子**人工通过 / 驳回**（`approvePost` / `rejectPost`）单元回归。
 *
 * 被测链路（真服务层 + 真内存社区 store，不 mock 适配层内部）：
 *   `admin/ops/service.ts::commitPostReview` → `admin/ops/community-posts.ts::createPostReviewAdapter`
 *   → 社区**唯一** CAS 原语 `commitPostIfCurrent`（结论随内容同一次提交写入）。
 *
 * 钉住的事情（按"最容易被写错"排序）：
 *  1. **状态真的变了**：`approve` 把 `private`+`pending` 推向 `published`+`approved`
 *     （先审后发的出口），`reject` 推向 `hidden`+`rejected`；不只是"返 200"。
 *  2. **结论带人**：`community_moderation_decisions` 的 `decided_by` 是会话管理员 id（迁移 0045）。
 *  3. **幂等**：同一状态重复通过 ⇒ `changed:false`、`revision` 不动、**不写第二条审计**、
 *     不重复通知。
 *  4. **闭集**：`reason_code` 不在 `POST_REVIEW_REASON_CODES` 里 ⇒ 400 `INVALID_REQUEST` 且零副作用。
 *  5. **硬规则红线**：硬规则否决的内容**不可**人工放行（422 `INPUT_UNCERTAIN` + 机器码 details）。
 *  6. **不伪造结论**：规则集版本取不到 ⇒ 503（写进去也会被读面判失效）。
 *  7. **单向门**：`deleted` 不可复活；`hidden` 不会因"通过"被翻回来。
 *  8. **通知是副作用**：投递抛错 ⇒ 200 + `notified:false`，结论**不回滚**。
 *  9. **未接线 fail-closed**：没有审核端口 ⇒ 503 `retryable:false`，零副作用。
 * 10. **契约形状**：响应与 `openapi.json` 的 `PostReviewOutcome` 同形（走本片镜像表校验）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostReviewAdapter } from '../../services/api/src/admin/ops/community-posts.ts';
import { createMemoryCommunityStore } from '../../services/api/src/community/store.ts';
import {
  USER_A,
  assertOpsContract,
  createOpsHarness,
  expectApiError,
  makeUuid,
  opsContext,
  opsKey,
} from './admin-ops-fixtures.mjs';

/** 一条**待审未发布**的帖子：库里就是 `private` + `pending`（先审后发的队列）。 */
function pendingPost(overrides = {}) {
  return {
    id: randomUUID(),
    revision: 1,
    author_id: USER_A.userId,
    anonymized_author_ref: null,
    title: '苗期观察记录',
    body: '这段时间天气转凉，我记录了田间长势，准备按标签说明处理。',
    crop_id: 'crop-rice',
    region_code: '330100',
    media_ids: [],
    linked_knowledge_ref: null,
    visibility: 'private',
    audit_state: 'pending',
    created_at: '2026-10-22T02:00:00.000Z',
    updated_at: '2026-10-22T02:00:00.000Z',
    ...overrides,
  };
}

/** 事件端口探针：记录投递、可注入失败。 */
function spyEvents({ failing = false } = {}) {
  const calls = [];
  return {
    calls,
    port: Object.freeze({
      wired: true,
      note: 'synthetic spy',
      publish: async (event) => {
        calls.push(event);
        if (failing) throw new Error('synthetic delivery failure');
        return { delivered: true, messageId: randomUUID(), created: true };
      },
    }),
  };
}

/** 一套"真的能审"的装配：内存社区 store + 审核适配器（门/事件可注入）。 */
function makeReviewHarness({ events, gate, store: seedStore } = {}) {
  const store = seedStore ?? createMemoryCommunityStore({ now: () => Date.now() });
  const adapter = createPostReviewAdapter({
    port: store,
    ...(events === undefined ? {} : { events }),
    ...(gate === undefined ? {} : { gate }),
  });
  const harness = createOpsHarness({ communityStore: store, postReview: adapter });
  return { ...harness, community: store };
}

function approveCtx(ifMatch = '"1"', overrides = {}) {
  return { ...opsContext(), idempotencyKey: opsKey('approve'), ifMatch, ...overrides };
}

function rejectCtx(ifMatch = '"1"', overrides = {}) {
  return { ...opsContext(), idempotencyKey: opsKey('reject'), ifMatch, ...overrides };
}

test('approve 正控制：private+pending ⇒ published+approved，结论带 decided_by，审计一条', async () => {
  const events = spyEvents();
  const harness = makeReviewHarness({ events: events.port });
  const store = harness.community;
  const post = pendingPost();
  assert.equal(await store.insertPost(post, null), true);

  const res = await harness.service.approvePost(approveCtx(), post.id, undefined);
  assert.equal(res.status, 200);
  assert.equal(res.headers.ETag, '"2"', '审核后 ETag 必须是新 revision（1→2）');
  assertOpsContract('PostReviewOutcome', res.body.data);
  assert.equal(res.body.data.changed, true);

  const after = await store.getPost(post.id);
  assert.equal(after.visibility, 'published', '待审帖人工通过后必须真的可见（先审后发的出口）');
  assert.equal(after.audit_state, 'approved');
  assert.equal(after.revision, 2);
  assert.equal(after.author_id, post.author_id, '审核不改作者归属');
  assert.equal(after.title, post.title, '审核不改正文');

  const verdict = await store.getModeration('post', post.id, 2);
  assert.notEqual(verdict, null, '结论必须与新 revision 同版本落库');
  assert.equal(verdict.decision, 'approved');
  assert.equal(verdict.hard_rule_passed, true, 'approved ⇒ hard_rule_passed 必须 true（审核域硬约束）');
  assert.equal(verdict.decided_by, opsContext().identity.userId, '人工结论必须带操作者（迁移 0045）');

  const audits = harness.store.audit.list();
  assert.equal(audits.length, 1, '一次真变更 ⇒ 一条内存审计（与 hidePost 同款）');
  assert.equal(audits[0].action, 'post.approve');
  assert.equal(audits[0].reason_code, 'post_approved');
  assert.equal(events.calls.length, 1, '通过一次 ⇒ 一条 moderation_result 通知');
});

test('approve 幂等：同状态重复通过 ⇒ changed:false、revision/审计/通知都不变', async () => {
  const events = spyEvents();
  const harness = makeReviewHarness({ events: events.port });
  const post = pendingPost();
  await harness.community.insertPost(post, null);

  const first = await harness.service.approvePost(approveCtx(), post.id, undefined);
  assert.equal(first.status, 200);
  assert.equal(first.body.data.changed, true);
  const auditAfterFirst = harness.store.audit.list().length;
  assert.equal(auditAfterFirst, 1);
  assert.equal(events.calls.length, 1, '通过一次 ⇒ 一条 moderation_result 通知');

  const second = await harness.service.approvePost(approveCtx('"2"'), post.id, undefined);
  assert.equal(second.status, 200);
  assert.equal(second.body.data.changed, false, '状态本来就如此 ⇒ 幂等命中');
  assert.equal(second.headers.ETag, '"2"', '幂等命中不得推进 revision');
  assert.equal((await harness.community.getPost(post.id)).revision, 2);
  assert.equal(harness.store.audit.list().length, auditAfterFirst, '幂等命中不得写第二条审计');
  assert.equal(events.calls.length, 1, '幂等命中不得重复通知作者');
});

test('approve 不翻案：hidden 的帖子通过后仍 hidden（下架是另一条决定）', async () => {
  const harness = makeReviewHarness({ events: spyEvents().port });
  const post = pendingPost({ visibility: 'hidden', audit_state: 'rejected' });
  await harness.community.insertPost(post, null);

  const res = await harness.service.approvePost(approveCtx(), post.id, undefined);
  assert.equal(res.status, 200);
  const after = await harness.community.getPost(post.id);
  assert.equal(after.visibility, 'hidden', '人工通过不等于撤销下架');
  assert.equal(after.audit_state, 'approved');
  assert.equal(harness.store.audit.list().length, 1);
});

test('reject 正控制：hidden+rejected，reason_code 落结论与响应，审计一条', async () => {
  const events = spyEvents();
  const harness = makeReviewHarness({ events: events.port });
  const post = pendingPost({ visibility: 'published' });
  await harness.community.insertPost(post, null);

  const res = await harness.service.rejectPost(rejectCtx(), post.id, { reason_code: 'spam' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.ETag, '"2"');
  assertOpsContract('PostReviewOutcome', res.body.data);
  assert.equal(res.body.data.decision, 'rejected');
  assert.deepEqual(res.body.data.reason_codes, ['spam']);

  const after = await harness.community.getPost(post.id);
  assert.equal(after.visibility, 'hidden', '驳回的语义是"不可公开"');
  assert.equal(after.audit_state, 'rejected');

  const verdict = await harness.community.getModeration('post', post.id, 2);
  assert.equal(verdict.decision, 'rejected');
  assert.deepEqual(verdict.reason_codes, ['spam']);
  assert.equal(verdict.hard_rule_passed, false, 'rejected ⇒ hard_rule_passed 必须 false（审核域硬约束）');
  assert.equal(verdict.decided_by, opsContext().identity.userId);
  assert.equal(harness.store.audit.list().length, 1);
});

test('reject 闭集：理由码不在闭集里 / 缺失 ⇒ 400 且零副作用', async () => {
  const harness = makeReviewHarness({ events: spyEvents().port });
  const post = pendingPost({ visibility: 'published' });
  await harness.community.insertPost(post, null);

  await expectApiError(
    () => harness.service.rejectPost(rejectCtx(), post.id, { reason_code: 'not_a_real_code' }),
    'INVALID_REQUEST',
  );
  await expectApiError(
    () => harness.service.rejectPost(rejectCtx(), post.id, {}),
    'INVALID_REQUEST',
  );
  const after = await harness.community.getPost(post.id);
  assert.equal(after.audit_state, 'pending', '校验失败不得改动状态');
  assert.equal(after.revision, 1, '校验失败不得推进 revision');
  assert.equal(harness.store.audit.list().length, 0, '校验失败不得留审计');
});

test('approve 不接受请求体（契约里没有 requestBody）⇒ 400', async () => {
  const harness = makeReviewHarness({ events: spyEvents().port });
  const post = pendingPost();
  await harness.community.insertPost(post, null);
  await expectApiError(
    () => harness.service.approvePost(approveCtx(), post.id, { reason_code: 'spam' }),
    'INVALID_REQUEST',
  );
  assert.equal((await harness.community.getPost(post.id)).audit_state, 'pending');
});

test('硬规则否决：人工不得放行 ⇒ 422 INPUT_UNCERTAIN，行不变、无结论行', async () => {
  const harness = makeReviewHarness({ events: spyEvents().port });
  // 社区审核域的硬规则命中样例（混用两种农药），取自 `community-fixtures.mjs:DANGEROUS_BODY`。
  const post = pendingPost({ body: '我想把草甘膦和乙草胺一起打，效果会不会更好？' });
  await harness.community.insertPost(post, null);

  const error = await expectApiError(
    () => harness.service.approvePost(approveCtx(), post.id, undefined),
    'INPUT_UNCERTAIN',
  );
  assert.ok(Array.isArray(error.details) && error.details.length > 0, '必须把踩中的硬规则码带给运营');
  const after = await harness.community.getPost(post.id);
  assert.equal(after.audit_state, 'pending', '被硬规则否决的内容状态不得变化');
  assert.equal(after.revision, 1);
  assert.equal(await harness.community.getModeration('post', post.id, 2), null, '不得落"已通过"结论');
  assert.equal(harness.store.audit.list().length, 0);
});

test('规则集版本未知 ⇒ 503（不伪造"已审"），行不变', async () => {
  const unknownGate = {
    currentRuleVersion: () => null,
    evaluate: () => ({ hard_rule_passed: true, reason_codes: [], missing_contract_fields: [] }),
  };
  const harness = makeReviewHarness({ events: spyEvents().port, gate: unknownGate });
  const post = pendingPost();
  await harness.community.insertPost(post, null);

  const error = await expectApiError(
    () => harness.service.approvePost(approveCtx(), post.id, undefined),
    'PROVIDER_UNAVAILABLE',
  );
  assert.equal(error.retryable, false);
  assert.equal((await harness.community.getPost(post.id)).audit_state, 'pending', '写入也会被判失效 ⇒ 宁可不写');
});

test('未接线：没有审核端口 ⇒ 503 retryable:false，零副作用', async () => {
  const store = createMemoryCommunityStore({ now: () => Date.now() });
  const post = pendingPost();
  await store.insertPost(post, null);
  const harness = createOpsHarness({ communityStore: store }); // 不传 postReview

  const error = await expectApiError(
    () => harness.service.approvePost(approveCtx(), post.id, undefined),
    'PROVIDER_UNAVAILABLE',
  );
  assert.equal(error.retryable, false, '未接线是运维动作，原样重试不会成功');
  assert.equal((await store.getPost(post.id)).audit_state, 'pending');
  assert.equal(harness.store.audit.list().length, 0, '被拒的审核不得留审计（不占幂等位）');
});

test('If-Match：不匹配 ⇒ 409 REVISION_CONFLICT；缺失 ⇒ 428 REVISION_REQUIRED', async () => {
  const harness = makeReviewHarness({ events: spyEvents().port });
  const post = pendingPost();
  await harness.community.insertPost(post, null);

  await expectApiError(
    () => harness.service.rejectPost(rejectCtx('"9"'), post.id, { reason_code: 'spam' }),
    'REVISION_CONFLICT',
  );
  await expectApiError(
    // `null` 而不是 `undefined`：JS 默认参数对 `undefined` 生效，会把"缺失头"变回 `"1"`。
    () => harness.service.rejectPost(rejectCtx(null), post.id, { reason_code: 'spam' }),
    'REVISION_REQUIRED',
  );
  assert.equal((await harness.community.getPost(post.id)).visibility, 'private');
});

test('单向门：deleted 的帖子驳不回去也批不回来 ⇒ 409 OBJECT_UNAVAILABLE', async () => {
  const harness = makeReviewHarness({ events: spyEvents().port });
  const post = pendingPost({ visibility: 'deleted' });
  await harness.community.insertPost(post, null);

  for (const run of [
    () => harness.service.approvePost(approveCtx(), post.id, undefined),
    () => harness.service.rejectPost(rejectCtx(), post.id, { reason_code: 'spam' }),
  ]) {
    const error = await expectApiError(run, 'OBJECT_UNAVAILABLE');
    assert.equal(error.status, 409);
  }
  assert.equal((await harness.community.getPost(post.id)).visibility, 'deleted');
});

test('匿名帖（author_id=null）：结论照落，但不发通知（没可通知的人）', async () => {
  const events = spyEvents();
  const harness = makeReviewHarness({ events: events.port });
  const post = pendingPost({ author_id: null, anonymized_author_ref: makeUuid(1) });
  await harness.community.insertPost(post, null);

  const res = await harness.service.approvePost(approveCtx(), post.id, undefined);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.notified, false);
  assert.equal(events.calls.length, 0, '匿名帖不得向任何 owner 投递');
  assert.equal((await harness.community.getPost(post.id)).audit_state, 'approved', '通知不到人也不影响结论');
});

test('通知失败不回滚：投递抛错 ⇒ 200 + notified:false，状态已是终态', async () => {
  const harness = makeReviewHarness({ events: spyEvents({ failing: true }).port });
  const post = pendingPost();
  await harness.community.insertPost(post, null);

  const res = await harness.service.approvePost(approveCtx(), post.id, undefined);
  assert.equal(res.status, 200, '通知是副作用：投递失败不得把已提交的结论变成 5xx');
  assert.equal(res.body.data.notified, false);
  const after = await harness.community.getPost(post.id);
  assert.equal(after.audit_state, 'approved');
  assert.equal(after.visibility, 'published');
});

test('scope：缺少 sources:write ⇒ 403 SCOPE_DENIED，且零副作用', async () => {
  const harness = makeReviewHarness({ events: spyEvents().port });
  const post = pendingPost();
  await harness.community.insertPost(post, null);
  const identity = { ...opsContext().identity, scopes: ['sources:read'] };

  await expectApiError(
    () =>
      harness.service.approvePost(
        { ...opsContext({ identity }), idempotencyKey: opsKey('noscope'), ifMatch: '"1"' },
        post.id,
        undefined,
      ),
    'SCOPE_DENIED',
  );
  assert.equal((await harness.community.getPost(post.id)).audit_state, 'pending');
  assert.equal(harness.store.audit.list().length, 0);
});
