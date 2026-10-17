/**
 * GY-I14（#14）⇄ GY-I15（#15）联动接线 · **事件只走消息中心公开端口**与 **`real` fail-closed 反例**
 * （`Refs #14`, `Refs #15`）。
 *
 * 覆盖（派单 §2 第 5、6 组）：
 *   G5-a 审核结果（投稿/评论）与下架事件**只经消息中心公开创建口**投递；审核域自己的
 *        `moderation.takedown` 事件**不会**另开一条投递（下架消息只可能来自社区观测口）；
 *   G5-b 同一事件身份重复投递命中去重键 ⇒ 不产生第二条消息（公开端口幂等）；
 *   G5-c **结构性**保证：`services/api/src/community/**` 对 `services/api/src/messages/**` **零 import**
 *        （不修改消息域实现；只调用其结构性端口）；
 *   G6-a 【反例】`real` 未接真实供应商：装配级整域 503 `PROVIDER_UNAVAILABLE`（`retryable`），
 *        注入的合成端口被**忽略**（零调用、零替身、零任务），不返回成功封套、不落内容行；
 *   G6-b 【反例·服务边界】`real` 下投稿在**送审审核域**这一步就 fail-closed（不吞错、不降级成 400）；
 *   G6-c 【对照】`stub` 下同一条请求正常通过（证明 `real` 的拒绝来自 fail-closed，而非一律拒绝）。
 *
 * 声明：模型端口是**合成替身**；本文件**不发起任何真实模型/付费调用**（`real` 用例恰恰断言
 * 端口零调用）。real 的 503 是"未接线即不可用"，**不是**真实供应商证据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { communityEventKey, createMessagesCommunityEventsPort } from '../../services/api/src/community/events.ts';
import { idem } from './community-fixtures.mjs';
import {
  API,
  CLEAN_BODY,
  CLEAN_TITLE,
  USER_A,
  USER_B,
  countingPort,
  expectApiError,
  makeHarness,
  makeServiceHarness,
  makeWiredHarness,
  passingPort,
  postInput,
} from './community-moderation-fixtures.mjs';

/** 契约错误封套逐项核对（含 `retryable` 与 `Cache-Control: no-store`）。 */
function errorEnvelope(result, status, code, { retryable } = {}) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  assert.equal(result.body.error.code, code, JSON.stringify(result.body));
  assert.equal(typeof result.body.error.message, 'string');
  assert.equal(typeof result.body.error.retryable, 'boolean');
  if (retryable !== undefined) assert.equal(result.body.error.retryable, retryable, '必须如实声明 retryable');
  assert.ok(Array.isArray(result.body.error.details));
  assert.equal(result.body.data, undefined, '错误响应不得携带成功封套');
  assert.equal(result.body.meta.contract_version, '1.0.0');
  assert.equal(result.cacheControl, 'no-store');
}

// ---------------------------------------------------------------------------
// G5 事件只走消息中心公开端口
// ---------------------------------------------------------------------------

test('G5a. 审核结果与下架事件只走消息中心公开端口；审核域自身事件不另开一条投递', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  await h.service.createComment(USER_B, post.id, { body: '按标签说明处理，注意轮换。' }, {
    idempotencyKey: idem(2),
    ifMatch: '"1"',
  });

  const aFeed = await h.service.listPosts(USER_A);
  assert.equal(aFeed.items.length, 1);
  // 投稿人只收到自己内容的审核结果事件（接收者由服务端决定）。
  const inboxA = await h.messages.listMessagesByOwner(USER_A.userId);
  assert.deepEqual(
    inboxA.map((item) => `${item.type}:${item.target_ref.type}:${item.target_ref.revision}`),
    ['moderation:post:1'],
  );
  const inboxB = await h.messages.listMessagesByOwner(USER_B.userId);
  assert.deepEqual(
    inboxB.map((item) => `${item.type}:${item.target_ref.type}:${item.target_ref.revision}`),
    ['moderation:comment:1'],
  );

  // 下架：审核域联动端口**也**返回了一条 `moderation.takedown` 事件，但事件只可能经**社区**观测口
  // 送进消息中心 ⇒ 恰好**一条**新消息、版本取社区处置后的 revision（而不是审核域事件里的 revision 1）。
  const admin = await h.adminSession();
  const hidden = await h.inject('POST', `${API}/admin/posts/${post.id}/hide`, {
    token: admin.token,
    headers: { 'idempotency-key': 'gy-i14i15-evt-hide-0001', 'if-match': '"1"' },
    payload: { reason: '内容不符合社区规范' },
  });
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
  assert.equal(h.calls.withdraw.length, 1);
  assert.equal(h.calls.withdraw[0].result.event.kind, 'moderation.takedown', '审核域确实产出了下架事件');
  assert.equal(h.calls.withdraw[0].result.event.target_ref.revision, 1, '审核域事件指向被处置前的那一版');

  const afterA = await h.messages.listMessagesByOwner(USER_A.userId);
  assert.equal(afterA.length, 2, '下架只允许新增一条消息（审核域事件不得另开一条投递）');
  const takedowns = afterA.filter((item) => item.target_ref.revision === 2);
  assert.equal(takedowns.length, 1, '下架消息恰好一条，且版本取**社区**处置后的 revision');
  assert.equal(takedowns[0].type, 'moderation');
  assert.equal(takedowns[0].target_ref.type, 'post');
  assert.equal(takedowns[0].read_at, null);
});

test('G5b. 同一事件身份重复投递命中去重键 ⇒ 不产生第二条消息（公开端口幂等）', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  const port = createMessagesCommunityEventsPort({ messages: h.app.messagesService });
  const event = {
    event: 'moderation_result',
    ownerId: USER_A.userId,
    target: { type: 'post', id: post.id, revision: 1 },
    decision: 'approved',
    reasonCodes: [],
  };
  const before = (await h.messages.listMessagesByOwner(USER_A.userId)).length;
  const first = await port.publish(event);
  const second = await port.publish(event);
  assert.equal(first.created, false, '投稿时已投递过同一 (rev, decision) 事件');
  assert.equal(second.created, false);
  assert.equal(first.messageId, second.messageId);
  assert.equal((await h.messages.listMessagesByOwner(USER_A.userId)).length, before);
  // 去重键由「事件身份 + 版本 + 结论」唯一确定，且不超消息域的键长上界（200）。
  const key = communityEventKey(event);
  assert.equal(key, `community:moderation_result:post:${post.id}:r1:approved`);
  assert.ok(key.length <= 200);
});

test('G5c. 结构性保证：community/** 对 messages/** 零 import（只经公开端口，不改消息域实现）', () => {
  const dir = new URL('../../services/api/src/community/', import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith('.ts'));
  assert.ok(files.length > 0, '前提：community 目录下有实现文件');
  const offenders = [];
  for (const name of files) {
    const source = readFileSync(new URL(name, dir), 'utf8');
    // 只允许"结构性端口"（形状相同的局部接口）；禁止任何对消息域实现的直接依赖。
    for (const pattern of [/from\s+'\.\.\/messages(?:\/[^']*)?\.ts'/, /from\s+'\.\.\/messages\/[^']*'/, /import\(\s*'\.\.\/messages[^']*'/]) {
      if (pattern.test(source)) offenders.push(`${name}: ${pattern}`);
    }
  }
  assert.deepEqual(offenders, [], '社区不得 import 消息域实现（事件只走公开创建口）');
});

// ---------------------------------------------------------------------------
// G6 real 未接真实供应商 ⇒ fail-closed
// ---------------------------------------------------------------------------

test('G6a. 【反例】real 未接真实供应商：整域 503 PROVIDER_UNAVAILABLE（retryable）；注入端口被忽略（不得以替身冒充）', async () => {
  const counted = countingPort(passingPort());
  const h = makeHarness({ executionMode: 'real', ports: { tms: counted.port } });
  // real ⇒ 社区整域未装配（不返回空页、不假成功）。
  assert.equal(h.service, null);
  // 审核域 real ⇒ 未接线权威、零替身、零任务。
  const counts = h.moderation.counts();
  assert.equal(h.moderation.execution_mode, 'real');
  assert.equal(counts.authority_origin, 'unwired');
  assert.equal(counts.tasks, 0);
  assert.deepEqual(counts.substitutes, [], 'real 下不得有任何替身端口');
  assert.equal(h.link.counts().execution_mode, 'real');
  assert.equal(h.link.counts().authority_origin, 'unwired');

  const session = await h.session('a');
  const created = await h.inject('POST', `${API}/posts`, {
    token: session.token,
    headers: { 'idempotency-key': 'gy-i14i15-real-post-0001' },
    payload: postInput(),
  });
  errorEnvelope(created, 503, 'PROVIDER_UNAVAILABLE', { retryable: false });
  // 零内容行、零端口调用、零任务：不得用内存/替身返回成功封套。
  assert.deepEqual(h.store.snapshotCounts(), { posts: 0, comments: 0, reports: 0, moderation: 0 });
  assert.equal(counted.requests.length, 0, 'real 下注入的合成端口必须被**忽略**（零调用）');
  assert.equal(h.moderation.counts().tasks, 0);

  // 审核域联动端口的送审同样 fail-closed（503 retryable），不会被吞掉、也不会降级成 400。
  const error = await expectApiError(
    () =>
      h.link.screen({
        actor: { userId: session.userId, role: 'user', authEpoch: 1 },
        content: { target_ref: { type: 'post', id: '00000000-0000-4000-8000-000000000000', revision: 1 }, text: 'x', media: [] },
      }),
    'PROVIDER_UNAVAILABLE',
    503,
  );
  assert.equal(error.retryable, false);
  assert.equal(counted.requests.length, 0);
});

test('G6b. 【反例·服务边界】real 下投稿在送审审核域这一步 fail-closed（不吞错、不降级成 400、不落内容行）', async () => {
  const h = makeServiceHarness({ executionMode: 'real' });
  const error = await expectApiError(
    () => h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) }),
    'PROVIDER_UNAVAILABLE',
    503,
  );
  assert.equal(error.retryable, false, 'real 的不可用必须如实标 retryable');
  // 内容行与**拒绝结论**都没有：失败发生在规则的放行之后、审核域 seam 上（不是规则拒绝、不是未结论）。
  assert.deepEqual(h.store.snapshotCounts(), { posts: 0, comments: 0, reports: 0, moderation: 0 });
  assert.equal(h.moderation.counts().tasks, 0);
  assert.equal(h.moderation.counts().authority_origin, 'unwired');
  assert.deepEqual(h.moderation.counts().substitutes, []);
  // 同一端口在 real 下也不给任何"未接线即通过"的错觉。
  await expectApiError(
    () =>
      h.link.screen({
        actor: USER_A,
        content: { target_ref: { type: 'post', id: '00000000-0000-4000-8000-000000000000', revision: 1 }, text: 'x', media: [] },
      }),
    'PROVIDER_UNAVAILABLE',
    503,
  );
});

test('G6c. 【对照】stub 下同一条投稿正常通过与留档（real 的拒绝来自 fail-closed，而非一律拒绝）', async () => {
  // 服务层对照：stub + 显式注入的**明确标注合成**端口 ⇒ 通过。
  const service = makeServiceHarness({ executionMode: 'stub', ports: { tms: passingPort() } });
  const post = await service.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  assert.equal(post.visibility, 'published');
  assert.equal(post.audit_state, 'approved');
  assert.equal(service.moderation.counts().tasks, 1);
  assert.equal(service.moderation.counts().substitutes.includes('tms'), false, '注入端口不是替身');

  // 装配级对照：stub 的 HTTP 面返回 201（同一路径、同一请求体）。
  const h = makeHarness({ ports: { tms: passingPort() } });
  const session = await h.session('a');
  const created = await h.inject('POST', `${API}/posts`, {
    token: session.token,
    headers: { 'idempotency-key': 'gy-i14i15-stub-post-0001' },
    payload: postInput(),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.title, CLEAN_TITLE);
  assert.equal(created.body.data.body, CLEAN_BODY);
  assert.equal(created.body.meta.execution_mode, 'stub');
  assert.equal(h.moderation.counts().authority_origin, 'community_store', 'stub 下审核域权威端口是**同源社区权威**');
});
