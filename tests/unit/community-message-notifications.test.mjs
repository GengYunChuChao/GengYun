/**
 * GY-I17（#17）第 7 片 · **他人评论 / 他人点赞**通知 + 「系统事件首版不虚构」守卫。
 *
 * 覆盖（issue #17 验收第 1、2、3、4 条）：
 *   N1 他人评论 ⇒ 被评论帖子的作者收到**恰好一条** `comment` 消息（跳转目标 = 该帖子、
 *      版本 = 评论发生时刻的父帖版本、未读、事件键含评论 id）；
 *   N2 自评不通知（自己给自己发消息是脏数据）；
 *   N3 他人点赞 ⇒ 被赞内容的作者收到**恰好一条** `like` 消息；评论被赞时目标是那条评论；
 *   N4 自赞不通知；
 *   N5 重复调度不重复创建：换幂等键重复 PUT、取消再赞、同事件直接重放 ⇒ 行数不变；
 *   N6 被下架的对象：评论/点赞在落库前就 404，作者的消息数不变（不给不可见对象新增消息）；
 *   N7 端到端（HTTP）：`GET /messages` 里 comment/like 与审核消息并存、`unread-count` 可复核、
 *      标读幂等且单调、他人无权读 404；
 *   N8 守卫：`type: 'system'` 首版**无真实触发源**，本域**永不**产出 `system`（今天全仓
 *      零生产赋值；将来有人加了会红，提醒同时补验收）。
 *
 * 声明：模型端口是**合成替身**（`passingPort`），不发起任何真实模型/付费调用。
 * 跳转可用性（`reference_state`）本片**仍为未接线**（`app.ts` 端口未接，属下一片 G4），
 * 本文件只断言消息**类型/接收者/去重/未读**语义，不把 `unavailable` 说成可用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  communityEventKey,
  communityEventMessageType,
  createMessagesCommunityEventsPort,
} from '../../services/api/src/community/events.ts';
import {
  API,
  USER_A,
  USER_B,
  idem,
  makeWiredHarness,
  passingPort,
  postInput,
} from './community-moderation-fixtures.mjs';

const SRC_ROOT = new URL('../../services/api/src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** 收件箱投影成 `type:target_type`，并**排序**：同一毫秒内的两条消息按 uuid 决序，不比顺序。 */
function inboxOf(rows, type) {
  const picked = type === undefined ? rows : rows.filter((row) => row.type === type);
  return picked.map((row) => `${row.type}:${row.target_ref?.type}`).sort();
}

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

// ---------------------------------------------------------------------------
// N1 / N2 评论通知
// ---------------------------------------------------------------------------

test('N1. 他人评论 ⇒ 被评论帖子的作者收到恰好一条 comment 消息（跳转目标=该帖子、未读）', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(1) });
  const before = await h.messages.listMessagesByOwner(USER_A.userId);
  assert.deepEqual(inboxOf(before), ['moderation:post'], '改前口径：作者只有自己投稿的审核结果');

  const comment = await h.service.createComment(USER_B, post.id, { body: '按标签说明处理，注意轮换。' }, {
    idempotencyKey: idem(2),
    ifMatch: '"1"',
  });

  const after = await h.messages.listMessagesByOwner(USER_A.userId);
  assert.deepEqual(inboxOf(after), ['comment:post', 'moderation:post'], '他人评论必须通知帖子作者');
  const commentMessages = after.filter((row) => row.type === 'comment');
  assert.equal(commentMessages.length, 1);
  const [message] = commentMessages;
  // 接收者是**帖子作者**（由服务端从内容行取），不是评论者。
  assert.equal(message.owner_id, USER_A.userId);
  // 跳转目标是**帖子**（评论行对他人未必可读），版本取评论发生时刻的父帖版本。
  assert.deepEqual(message.target_ref, { type: 'post', id: post.id, revision: 1 });
  assert.equal(message.read_at, null, '新消息必须是未读（创建不当已读）');
  // 去重键含评论 id：同一帖子下不同评论各自通知一次。
  assert.equal(message.event_key, `community:comment_created:post:${post.id}:r1:c${comment.id}`);
  assert.ok(message.event_key.length <= 200, '事件键不得超消息域 200 上界');
  // 评论者自己没有 comment 类消息（只有自己评论的审核结果）。
  const bInbox = await h.messages.listMessagesByOwner(USER_B.userId);
  assert.deepEqual(inboxOf(bInbox), ['moderation:comment']);
});

test('N2. 自评不通知：作者评论自己的帖子不产生 comment 消息', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(11) });
  await h.service.createComment(USER_A, post.id, { body: '补充一句：雨后隔两天再喷。' }, {
    idempotencyKey: idem(12),
    ifMatch: '"1"',
  });
  const inbox = await h.messages.listMessagesByOwner(USER_A.userId);
  assert.equal(inbox.filter((row) => row.type === 'comment').length, 0, '自己给自己发通知是脏数据');
  assert.deepEqual(inboxOf(inbox), ['moderation:comment', 'moderation:post']);
});

// ---------------------------------------------------------------------------
// N3 / N4 / N5 点赞通知与幂等
// ---------------------------------------------------------------------------

test('N3. 他人点赞 ⇒ 被赞内容的作者收到恰好一条 like 消息；被赞对象是评论时目标是该评论', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(21) });
  await h.service.likePosts(USER_B, post.id, { idempotencyKey: idem(22), ifMatch: '"1"' });

  const postLikes = (await h.messages.listMessagesByOwner(USER_A.userId)).filter((row) => row.type === 'like');
  assert.equal(postLikes.length, 1, '他人点赞必须通知被赞帖子作者');
  assert.equal(postLikes[0].owner_id, USER_A.userId);
  assert.deepEqual(postLikes[0].target_ref, { type: 'post', id: post.id, revision: 1 });
  assert.equal(postLikes[0].read_at, null);
  assert.equal(postLikes[0].event_key, `community:like_created:post:${post.id}:r1:u${USER_B.userId}`);

  // 评论被赞 ⇒ 接收者是**评论作者**（USER_A 的帖子下，USER_B 的评论被 USER_A 赞）。
  const comment = await h.service.createComment(USER_B, post.id, { body: '我这边雨后隔两天喷，效果还行。' }, {
    idempotencyKey: idem(23),
    ifMatch: '"1"',
  });
  await h.service.likeComments(USER_A, comment.id, { idempotencyKey: idem(24), ifMatch: '"1"' });
  const commentLikes = (await h.messages.listMessagesByOwner(USER_B.userId)).filter((row) => row.type === 'like');
  assert.equal(commentLikes.length, 1, '评论被赞通知评论作者');
  assert.deepEqual(commentLikes[0].target_ref, { type: 'comment', id: comment.id, revision: 1 });
});

test('N4. 自赞不通知：作者赞自己的帖子/评论不产生 like 消息', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(31) });
  await h.service.likePosts(USER_A, post.id, { idempotencyKey: idem(32), ifMatch: '"1"' });
  const comment = await h.service.createComment(USER_A, post.id, { body: '自己补充：注意安全间隔期。' }, {
    idempotencyKey: idem(33),
    ifMatch: '"1"',
  });
  await h.service.likeComments(USER_A, comment.id, { idempotencyKey: idem(34), ifMatch: '"1"' });
  const inbox = await h.messages.listMessagesByOwner(USER_A.userId);
  assert.equal(inbox.filter((row) => row.type === 'like').length, 0, '自赞不得产生通知');
});

test('N5. 重复调度不重复创建：换幂等键重放 / 取消再赞 / 同事件重投 ⇒ 行数不变', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(41) });
  await h.service.likePosts(USER_B, post.id, { idempotencyKey: idem(42), ifMatch: '"1"' });
  const first = (await h.messages.listMessagesByOwner(USER_A.userId)).filter((row) => row.type === 'like');
  assert.equal(first.length, 1);

  // 换幂等键重复 PUT：`addLike` 返回 false（集合语义 no-op）⇒ 不重复调度。
  await h.service.likePosts(USER_B, post.id, { idempotencyKey: idem(43), ifMatch: '"1"' });
  assert.equal((await h.messages.listMessagesByOwner(USER_A.userId)).filter((row) => row.type === 'like').length, 1);

  // 取消再赞：真的重新 addLike，但事件键相同 ⇒ 命中去重索引，不产生第二行。
  await h.service.unlikePosts(USER_B, post.id, { idempotencyKey: idem(44), ifMatch: '"1"' });
  await h.service.likePosts(USER_B, post.id, { idempotencyKey: idem(45), ifMatch: '"1"' });
  const after = (await h.messages.listMessagesByOwner(USER_A.userId)).filter((row) => row.type === 'like');
  assert.equal(after.length, 1, '同一 (被赞对象, 版本, 点赞人) 只允许一条');
  assert.equal(after[0].id, first[0].id, '命中去重键 ⇒ 既有行 id 不变（不新建第二行）');

  // 同事件直接重放（装配层重试/重复调度）：端口如实回报 created:false。
  const port = createMessagesCommunityEventsPort({ messages: h.app.messagesService });
  const event = {
    event: 'like_created',
    ownerId: USER_A.userId,
    target: { type: 'post', id: post.id, revision: 1 },
    actorId: USER_B.userId,
  };
  const replay = await port.publish(event);
  assert.equal(replay.created, false);
  assert.equal(replay.delivered, true);
  assert.equal((await h.messages.listMessagesByOwner(USER_A.userId)).filter((row) => row.type === 'like').length, 1);
});

// ---------------------------------------------------------------------------
// N6 被下架对象不新增消息
// ---------------------------------------------------------------------------

test('N6. 对象下架后：他人评论/点赞在落库前 404，作者消息数不增', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  const admin = await h.adminSession();
  const post = await h.service.createPost(USER_A, postInput(), { idempotencyKey: idem(51) });
  const hidden = await h.inject('POST', `${API}/admin/posts/${post.id}/hide`, {
    token: admin.token,
    headers: { 'idempotency-key': 'gy-i17-notify-hide-0001', 'if-match': '"1"' },
    payload: { reason: '内容不符合社区规范' },
  });
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
  const before = (await h.messages.listMessagesByOwner(USER_A.userId)).length;
  assert.ok(before >= 1, '下架消息必须已投递');

  await assert.rejects(
    () => h.service.likePosts(USER_B, post.id, { idempotencyKey: idem(52), ifMatch: '"1"' }),
    (error) => error?.code === 'NOT_FOUND',
  );
  await assert.rejects(
    () => h.service.createComment(USER_B, post.id, { body: '下架后还能评论吗？' }, {
      idempotencyKey: idem(53),
      ifMatch: '"1"',
    }),
    (error) => error?.code === 'NOT_FOUND',
  );
  const after = await h.messages.listMessagesByOwner(USER_A.userId);
  assert.equal(after.length, before, '不可见对象不得新增互动消息');
  assert.equal(after.filter((row) => row.type === 'like' || row.type === 'comment').length, 0);
});

// ---------------------------------------------------------------------------
// N7 端到端：列表 / 未读 / 已读 / 越权
// ---------------------------------------------------------------------------

test('N7. 端到端：GET /messages 含 comment+like+moderation，unread-count 可复核，标读幂等，他人 404', async () => {
  const h = makeWiredHarness({ ports: { tms: passingPort() } });
  const a = await h.session('a');
  const b = await h.session('b');
  const post = await h.service.createPost(a.actor, postInput(), { idempotencyKey: idem(61) });
  const comment = await h.service.createComment(b.actor, post.id, { body: '同问，我也想知道轮换周期。' }, {
    idempotencyKey: idem(62),
    ifMatch: '"1"',
  });
  await h.service.likePosts(b.actor, post.id, { idempotencyKey: idem(63), ifMatch: '"1"' });

  const list = await h.inject('GET', `${API}/messages`, { token: a.token });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const items = list.body.data.items;
  assert.deepEqual(
    items.map((item) => `${item.type}:${item.target_ref.type}`).sort(),
    ['comment:post', 'like:post', 'moderation:post'],
    '三类事件都在同一个收件箱里，且接收者都是内容作者',
  );
  assert.equal(items.every((item) => item.read_at === null), true, '创建不当已读');
  // 未读是可复核的派生量：等于未读行数，不是客户端自报。
  const unread = await h.inject('GET', `${API}/messages/unread-count`, { token: a.token });
  assert.equal(unread.body.data.count, 3);
  assert.equal(unread.body.data.count, items.filter((item) => item.read_at === null).length);

  // 标读：只影响那一条，未读减一；重复标读幂等（不推进版本、不改变 read_at）。
  const target = items.find((item) => item.type === 'comment');
  const marked = await h.inject('PUT', `${API}/messages/${target.id}/read`, {
    token: a.token,
    headers: { 'if-match': `"${target.revision}"`, 'idempotency-key': 'gy-i17-notify-read-0001' },
  });
  assert.equal(marked.status, 200, JSON.stringify(marked.body));
  assert.equal(marked.body.data.read_at === null, false);
  assert.equal((await h.inject('GET', `${API}/messages/unread-count`, { token: a.token })).body.data.count, 2);

  const again = await h.inject('PUT', `${API}/messages/${target.id}/read`, {
    token: a.token,
    headers: { 'if-match': `"${marked.body.data.revision}"`, 'idempotency-key': 'gy-i17-notify-read-0002' },
  });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.data.revision, marked.body.data.revision, '已读状态单调：重复标读不推进版本');
  assert.equal((await h.inject('GET', `${API}/messages/unread-count`, { token: a.token })).body.data.count, 2);

  // 他人（包括被通知对象的互动者）读不到别人的消息：一律 404，不区分"不存在/不是你的"。
  const foreign = await h.inject('PUT', `${API}/messages/${target.id}/read`, {
    token: b.token,
    headers: { 'if-match': `"${target.revision}"`, 'idempotency-key': 'gy-i17-notify-read-0003' },
  });
  assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
  // 评论者 b 的收件箱里没有 a 的互动消息。
  const bList = await h.inject('GET', `${API}/messages`, { token: b.token });
  assert.equal(
    bList.body.data.items.some((item) => item.id === target.id),
    false,
    '消息按属主隔离',
  );
});

// ---------------------------------------------------------------------------
// N8 守卫：系统事件首版不虚构
// ---------------------------------------------------------------------------

test('N8. 守卫：`type: system` 首版无生产赋值；社区事件类型映射永不产出 system', () => {
  // (a) 代码级：全仓 `services/api/src/**` 没有任何 `type: 'system'` 赋值。
  const offenders = sourceFiles(SRC_ROOT)
    .flatMap((path) => readFileSync(path, 'utf8').split('\n').map((line, index) => ({ path, line, no: index + 1 })))
    .filter((hit) => /type:\s*['"]system['"]/.test(hit.line))
    .map((hit) => `${hit.path}:${hit.no}`);
  assert.deepEqual(offenders, [], '首版无真实系统事件触发源；新增时必须先补 #17 验收与证据');

  // (b) 语义级：社区事件的四个成员都映射到闭集内、且**都不**是 system。
  const events = [
    { event: 'moderation_result', ownerId: 'a', target: { type: 'post', id: 'b', revision: 1 }, decision: 'approved', reasonCodes: [] },
    { event: 'takedown', ownerId: 'a', target: { type: 'post', id: 'b', revision: 1 }, reason: '内容不符合社区规范' },
    { event: 'comment_created', ownerId: 'a', target: { type: 'post', id: 'b', revision: 1 }, commentId: 'c', actorId: 'd' },
    { event: 'like_created', ownerId: 'a', target: { type: 'comment', id: 'b', revision: 2 }, actorId: 'd' },
  ];
  assert.deepEqual(
    events.map((event) => `${event.event}⇒${communityEventMessageType(event)}`),
    ['moderation_result⇒moderation', 'takedown⇒moderation', 'comment_created⇒comment', 'like_created⇒like'],
    'takedown 本质是平台处置结论 ⇒ moderation（改判 system 会动既有断言且语义更差）',
  );
  // 去重键：每个分支都不超 200 上界，且「事件身份 + 版本」参与。
  for (const event of events) {
    const key = communityEventKey(event);
    assert.ok(key.length <= 200, `${key} 超 200 上界`);
    assert.ok(key.includes(`:r${event.target.revision}`), '版本必须参与去重键');
  }
  // 去重键的**区分力**（这才是"不重复创建"同时"不误合并"的两面）：
  // 版本 / 点赞人 / 评论 id 任一不同 ⇒ 必须是不同的键。
  const likeBase = { event: 'like_created', ownerId: 'a', target: { type: 'post', id: 'p', revision: 1 }, actorId: 'u1' };
  assert.equal(
    new Set([
      communityEventKey(likeBase),
      communityEventKey({ ...likeBase, target: { type: 'post', id: 'p', revision: 2 } }),
      communityEventKey({ ...likeBase, actorId: 'u2' }),
    ]).size,
    3,
    '（版本, 点赞人）任一不同都必须是不同的去重键',
  );
  const commentBase = {
    event: 'comment_created', ownerId: 'a', target: { type: 'post', id: 'p', revision: 1 }, commentId: 'c1', actorId: 'u1',
  };
  assert.notEqual(
    communityEventKey(commentBase),
    communityEventKey({ ...commentBase, commentId: 'c2' }),
    '同一帖子下的不同评论各自通知一次（不得合并成一条）',
  );
});
