/**
 * GY-I15（#15）阶段 2 · 社区**实际 HTTP** 用例（真实 loopback，合成账号与合成文本）。
 *
 * 覆盖（按派单 §4）：
 *   1. 投稿/评论/点赞幂等/编辑删除/举报与处理状态 + 封套与头部；
 *   2. 游客与越权（401/403/404 同形，不泄露存在性）；
 *   3. **先审后发隔离**：规则先挡、未通过不公开、编辑重审、旧版本结果不套新版本、
 *      下架后列表/详情引用一致；
 *   4. **读取时重查**：隐藏／失效／注销不因缓存或旧链接复活（负例）；
 *   5. **消息事件**投递（审核结果 + 下架）到已合并消息域的公开创建口；
 *   6. `real` 模式未接真实持久存储 ⇒ 整域 fail-closed（503 `PROVIDER_UNAVAILABLE`）+ `stub` 对照；
 *   7. 杂草／药剂关联：默认未接线 fail-closed、已接线正例、模拟/未核对资料不可用、
 *      编辑遗漏保留旧值／显式 null 解除／替换需当前可用。
 *
 * 声明（不得误读）：账号、正文与知识行都是**合成夹具**；本文件**不是**审核准确率／召回率证据，
 * 也不代表模型层（LLM）审核或图片审核已接入。规则集用冻结时钟，避免机器负载把判决变成超时隔离。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createMemoryCommunityStore } from '../../services/api/src/community/store.ts';
import { createKnowledgeAvailabilityPort } from '../../services/api/src/community/knowledge.ts';
import { createMessagesCommunityEventsPort, communityEventKey } from '../../services/api/src/community/events.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import { CLEAN_BODY, CLEAN_TITLE, DANGEROUS_BODY, makeGate } from './community-fixtures.mjs';

const API = '/api/v1';
const START = Date.UTC(2026, 9, 20, 4, 0, 0);
const ABSENT = '00000000-0000-4000-8000-000000000000';
const POST_KEYS = ['id', 'revision', 'author', 'title', 'body', 'crop_id', 'region_code', 'media_ids',
  'visibility', 'audit_state', 'created_at', 'updated_at', 'media', 'linked_knowledge_ref', 'linked_knowledge'];
const COMMENT_KEYS = ['id', 'revision', 'post_id', 'author', 'body', 'visibility', 'audit_state', 'created_at'];
const REPORT_KEYS = ['id', 'revision', 'target_ref', 'state', 'reason_code'];

/** 写头：`Idempotency-Key`（required，8..128）+ 可选 `If-Match`（`^"[1-9][0-9]*"$`）。 */
function write(key, version) {
  return { 'idempotency-key': key, ...(version === undefined ? {} : { 'if-match': version }) };
}

function postBody(over = {}) {
  return { title: CLEAN_TITLE, body: CLEAN_BODY, media_ids: [], ...over };
}

async function fixture(t, options = {}) {
  let time = START;
  const auth = createMemoryAuthStore();
  const community = options.store ?? createMemoryCommunityStore({ now: () => time });
  const messages = createMemoryMessagesStore({ now: () => time });
  const config = {
    ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    ...(options.real === true ? { executionMode: 'real', requiresRealCredentials: true } : {}),
  };
  const app = buildApp({
    config,
    store: auth,
    now: () => new Date(time),
    communityInjection: {
      store: community,
      gate: options.gate ?? makeGate(),
      ...(options.knowledge === undefined ? {} : { knowledge: options.knowledge }),
    },
    messagesInjection: { store: messages },
  });
  async function user(subject) {
    const created = await auth.createUser(subject.repeat(64));
    const token = `synthetic-community-token-${subject}`;
    const session = await auth.createSession({
      userId: created.id,
      tokenHashHex: hashToken(token),
      authEpoch: created.authEpoch,
      expiresAt: new Date(START + 48 * 3600_000),
      audience: 'user',
    });
    return { user: created, token, session };
  }
  const a = await user('a');
  const b = await user('b');
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => app.close());
  async function call(method, path, actor = a, { headers = {}, payload } = {}) {
    const response = await fetch(url + path, {
      method,
      headers: {
        ...(actor === null || actor === undefined ? {} : { authorization: `Bearer ${actor.token}` }),
        ...headers,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text === '' ? null : JSON.parse(text),
      etag: response.headers.get('etag'),
      cache: response.headers.get('cache-control'),
    };
  }
  async function admin(scopes = ['sources:write', 'audit:read']) {
    const userId = await auth.createAdmin({
      loginName: `community-admin-${Math.random().toString(36).slice(2, 8)}`,
      credentialHash: 'synthetic-not-a-real-credential-hash',
      scopes,
    });
    const token = `synthetic-community-admin-token-${userId.slice(0, 8)}`;
    await auth.createSession({
      userId,
      tokenHashHex: hashToken(token),
      authEpoch: 1,
      expiresAt: new Date(START + 3600_000),
      audience: 'admin',
    });
    return { userId, token };
  }
  /** 建一条已通过的帖子（返回契约 `Post`）。 */
  async function publish(actor = a, over = {}, key = 'gy-http-post-0001') {
    const result = await call('POST', `${API}/posts`, actor, { headers: write(key), payload: postBody(over) });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.data;
  }
  return { app, auth, community, messages, a, b, admin, call, publish, url, advance: (ms) => { time += ms; } };
}

/** 断言契约错误封套（状态码 + 错误码 + `Cache-Control: no-store`，且**无成功封套**）。 */
function error(result, status, code) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  assert.equal(result.body.error.code, code, JSON.stringify(result.body));
  assert.equal(typeof result.body.error.message, 'string');
  assert.equal(typeof result.body.error.retryable, 'boolean');
  assert.ok(Array.isArray(result.body.error.details));
  assert.equal(result.body.data, undefined, '错误响应不得携带成功封套');
  assert.equal(result.body.meta.contract_version, '1.0.0');
  assert.equal(result.cache, 'no-store');
}

// ---------------------------------------------------------------------------
// 1. 正控制：投稿 / 列表与筛选 / 详情 / 评论 / 点赞幂等 / 举报
// ---------------------------------------------------------------------------

test('HTTP 正控制：投稿、作物地区筛选、详情、评论、点赞幂等、举报与处理状态', async (t) => {
  const h = await fixture(t);
  const created = await h.call('POST', `${API}/posts`, h.a, {
    headers: write('gy-http-post-0001'),
    payload: postBody({ crop_id: 'rice', region_code: '330100' }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.etag, '"1"');
  assert.equal(created.cache, 'no-store');
  assert.equal(created.body.meta.execution_mode, 'stub');
  assert.deepEqual(Object.keys(created.body.data).sort(), [...POST_KEYS].sort());
  assert.equal(created.body.data.visibility, 'published');
  assert.equal(created.body.data.audit_state, 'approved');
  assert.equal(created.body.data.crop_id, 'rice');
  assert.equal(created.body.data.region_code, '330100');
  assert.deepEqual(created.body.data.media, []);
  assert.equal(created.body.data.linked_knowledge_ref, null);
  assert.equal(created.body.data.linked_knowledge, null);
  assert.equal(created.body.data.author.state, 'active');
  assert.equal('reporter_id' in created.body.data, false, '不得泄露内部字段');
  const id = created.body.data.id;

  // 列表：本人与他人 feed 同形（已发布且已过审）；ETag 不写在列表上。
  for (const actor of [h.a, h.b]) {
    const feed = await h.call('GET', `${API}/posts`, actor);
    assert.equal(feed.status, 200);
    assert.equal(feed.etag, null, '契约：列表无 ETag');
    assert.deepEqual(Object.keys(feed.body.data).sort(), ['items', 'next_cursor']);
    assert.equal(feed.body.data.items.length, 1);
    assert.equal(feed.body.data.next_cursor, null);
  }
  // 作物地区筛选（契约 `crop_id` / `region_code`）。
  assert.equal((await h.call('GET', `${API}/posts?crop_id=rice&region_code=330100`)).body.data.items.length, 1);
  assert.equal((await h.call('GET', `${API}/posts?crop_id=wheat`)).body.data.items.length, 0);
  assert.equal((await h.call('GET', `${API}/posts?region_code=330200`)).body.data.items.length, 0);
  assert.equal((await h.call('GET', `${API}/posts?mine=true`, h.a)).body.data.items.length, 1);
  assert.equal((await h.call('GET', `${API}/posts?mine=true`, h.b)).body.data.items.length, 0);

  // 详情：强 ETag = 资源 revision。
  const detail = await h.call('GET', `${API}/posts/${id}`, h.b);
  assert.equal(detail.status, 200);
  assert.equal(detail.etag, '"1"');
  assert.equal(detail.body.data.body, CLEAN_BODY);

  // 评论：If-Match = 父帖当前 revision。
  const comment = await h.call('POST', `${API}/posts/${id}/comments`, h.b, {
    headers: write('gy-http-cmt-0001', '"1"'),
    payload: { body: '我也遇到过类似情况，按标签说明处理更稳妥。' },
  });
  assert.equal(comment.status, 201);
  assert.equal(comment.etag, '"1"');
  assert.deepEqual(Object.keys(comment.body.data).sort(), [...COMMENT_KEYS].sort());
  assert.equal(comment.body.data.post_id, id);
  const list = await h.call('GET', `${API}/posts/${id}/comments`, h.a);
  assert.equal(list.status, 200);
  assert.equal(list.etag, null);
  assert.equal(list.body.data.items.length, 1);

  // 点赞幂等：同键重放 + 不同键重复 PUT 都只留一条记录，且不改内容 revision。
  const like = await h.call('PUT', `${API}/posts/${id}/like`, h.b, { headers: write('gy-http-like-0001', '"1"') });
  assert.equal(like.status, 200);
  assert.deepEqual(like.body.data, { accepted: true });
  assert.equal(like.etag, null, 'Ack 不返回资源表示 ⇒ 不写 ETag');
  const replay = await h.call('PUT', `${API}/posts/${id}/like`, h.b, { headers: write('gy-http-like-0001', '"1"') });
  assert.deepEqual(replay.body.data, { accepted: true });
  const again = await h.call('PUT', `${API}/posts/${id}/like`, h.b, { headers: write('gy-http-like-0002', '"1"') });
  assert.deepEqual(again.body.data, { accepted: true });
  assert.equal(await h.community.countLikes('post', id), 1, '重复点赞不得产生第二条记录');
  const commentLike = await h.call('PUT', `${API}/comments/${comment.body.data.id}/like`, h.a, {
    headers: write('gy-http-like-0003', '"1"'),
  });
  assert.equal(commentLike.status, 200);
  assert.equal(await h.community.countLikes('comment', comment.body.data.id), 1);
  // 取消点赞幂等且不为负。
  await h.call('DELETE', `${API}/posts/${id}/like`, h.b, { headers: write('gy-http-unlike-0001', '"1"') });
  await h.call('DELETE', `${API}/posts/${id}/like`, h.b, { headers: write('gy-http-unlike-0002', '"1"') });
  assert.equal(await h.community.countLikes('post', id), 0);
  // 点赞不改内容 revision。
  assert.equal((await h.call('GET', `${API}/posts/${id}`)).etag, '"1"');

  // 举报：处理状态 `received`，只给举报人本人读。
  const report = await h.call('POST', `${API}/reports`, h.b, {
    headers: write('gy-http-report-0001'),
    payload: { target_ref: { type: 'post', id, revision: 1 }, reason_code: 'advertising', detail: '疑似导流' },
  });
  assert.equal(report.status, 201);
  assert.equal(report.etag, '"1"');
  assert.deepEqual(Object.keys(report.body.data).sort(), [...REPORT_KEYS].sort());
  assert.equal(report.body.data.state, 'received');
  assert.equal('detail' in report.body.data, false, '契约 Report 没有 detail 字段');
  assert.equal('reporter_id' in report.body.data, false, '举报者身份不对外投影');
  const ownReport = await h.call('GET', `${API}/reports/${report.body.data.id}`, h.b);
  assert.equal(ownReport.status, 200);
  assert.equal(ownReport.etag, '"1"');
  error(await h.call('GET', `${API}/reports/${report.body.data.id}`, h.a), 404, 'NOT_FOUND');
});

// ---------------------------------------------------------------------------
// 2. 游客与越权
// ---------------------------------------------------------------------------

test('HTTP 反例：游客/后台令牌/失效会话/越权（不泄露存在性，错误封套同形）', async (t) => {
  const h = await fixture(t);
  const post = await h.publish(h.a);

  for (const [method, path, options] of [
    ['GET', `${API}/posts`, {}],
    ['POST', `${API}/posts`, { headers: write('gy-http-guest-001'), payload: postBody() }],
    ['GET', `${API}/posts/${post.id}`, {}],
    ['GET', `${API}/posts/${post.id}/comments`, {}],
    ['PUT', `${API}/posts/${post.id}/like`, { headers: write('gy-http-guest-002', '"1"') }],
    ['POST', `${API}/reports`, { headers: write('gy-http-guest-003'), payload: { target_ref: { type: 'post', id: post.id, revision: 1 }, reason_code: 'other' } }],
  ]) {
    error(await h.call(method, path, null, options), 401, 'SESSION_REQUIRED');
  }

  // 后台会话令牌访问用户域（契约 security: userSession）⇒ 401（用户会话不存在）。
  const admin = await h.admin();
  error(await h.call('GET', `${API}/posts`, admin), 401, 'SESSION_EXPIRED');

  // 越权：他人编辑/删除/详情与他人不存在**同形**（逐字节相同的 error 对象）。
  const foreignEdit = await h.call('PATCH', `${API}/posts/${post.id}`, h.b, {
    headers: write('gy-http-foreign-001', '"1"'),
    payload: postBody({ body: '改别人的帖子' }),
  });
  const missingEdit = await h.call('PATCH', `${API}/posts/${ABSENT}`, h.b, {
    headers: write('gy-http-foreign-002', '"1"'),
    payload: postBody({ body: '改别人的帖子' }),
  });
  error(foreignEdit, 404, 'NOT_FOUND');
  error(missingEdit, 404, 'NOT_FOUND');
  assert.deepEqual(foreignEdit.body.error, missingEdit.body.error, '越权与不存在必须同形');
  const foreignDelete = await h.call('DELETE', `${API}/posts/${post.id}`, h.b, { headers: write('gy-http-foreign-003', '"1"') });
  error(foreignDelete, 404, 'NOT_FOUND');
  assert.deepEqual(foreignDelete.body.error, missingEdit.body.error);

  // 会话撤销后旧令牌立即失效（不得因客户端缓存继续可用）。
  await h.auth.revokeSession(h.b.session, 'user');
  error(await h.call('GET', `${API}/posts`, h.b), 401, 'SESSION_EXPIRED');

  // 账号 authEpoch 变化（停用/注销路径）⇒ 403 ACCOUNT_INACTIVE，旧令牌不复活。
  await h.auth.bumpUserAuthEpoch(h.a.user.id);
  error(await h.call('GET', `${API}/posts/${post.id}`, h.a), 403, 'ACCOUNT_INACTIVE');
  assert.equal(h.community.snapshotCounts().posts, 1, '鉴权失败不得产生任何写入');
});

// ---------------------------------------------------------------------------
// 3. 先审后发隔离
// ---------------------------------------------------------------------------

test('HTTP 先审后发：规则先挡（危险文本不落内容行、不公开），干净文本 stub 对照通过', async (t) => {
  const h = await fixture(t);
  const refused = await h.call('POST', `${API}/posts`, h.a, {
    headers: write('gy-http-danger-0001'),
    payload: postBody({ body: DANGEROUS_BODY }),
  });
  error(refused, 400, 'INVALID_REQUEST');
  assert.ok(refused.body.error.details.length > 0, '必须回传规则层原因码（不是空拒绝）');
  assert.ok(refused.body.error.details.every((item) => item.field === 'reason_codes'));
  assert.ok(refused.body.error.details.some((item) => item.code === 'DANGEROUS_MIX'), '必须如实回传命中的硬规则码');

  // 未通过内容**不公开**：他人与本人列表都为空、详情 404、存储里没有内容行。
  for (const actor of [h.a, h.b]) {
    const feed = await h.call('GET', `${API}/posts`, actor);
    assert.deepEqual(feed.body.data, { items: [], next_cursor: null });
  }
  assert.equal(h.community.snapshotCounts().posts, 0, '被拒内容不得落内容行');
  assert.equal(h.community.snapshotCounts().posts + h.community.snapshotCounts().comments, 0);
  // 但拒审结论如实留档（供复核），不是静默丢弃。
  assert.equal(h.community.snapshotCounts().moderation, 1);

  // stub 对照：同结构干净文本通过（证明上面的拒绝来自规则命中而非"一律拒绝"）。
  const ok = await h.call('POST', `${API}/posts`, h.a, {
    headers: write('gy-http-clean-0001'),
    payload: postBody(),
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.audit_state, 'approved');
  assert.equal((await h.call('GET', `${API}/posts`, h.b)).body.data.items.length, 1);
});

test('HTTP 编辑重审：旧版本审核结果不得套到新版本；被拒编辑不改动旧版本', async (t) => {
  const h = await fixture(t);
  const post = await h.publish(h.a);

  // 编辑成危险文本 ⇒ 新版本被规则挡住，**不落新版本**，旧版本原样保留。
  const refused = await h.call('PATCH', `${API}/posts/${post.id}`, h.a, {
    headers: write('gy-http-edit-danger-1', '"1"'),
    payload: postBody({ body: DANGEROUS_BODY }),
  });
  error(refused, 400, 'INVALID_REQUEST');
  const still = await h.call('GET', `${API}/posts/${post.id}`, h.b);
  assert.equal(still.status, 200);
  assert.equal(still.etag, '"1"', '被拒编辑不得推进 revision');
  assert.equal(still.body.data.body, CLEAN_BODY, '被拒编辑不得改动已发布正文');
  assert.equal((await h.call('GET', `${API}/posts`, h.b)).body.data.items.length, 1);

  // 通过的重审：新 revision 必须带**自己的**审核结论（正文摘要不同 ⇒ 旧结论不可复用）。
  const revised = await h.call('PATCH', `${API}/posts/${post.id}`, h.a, {
    headers: write('gy-http-edit-clean-1', '"1"'),
    payload: postBody({ body: '今年雨水偏多，我按标签说明轮换用药，并记录了施药日期。' }),
  });
  assert.equal(revised.status, 200);
  assert.equal(revised.etag, '"2"');
  assert.equal(revised.body.data.revision, 2);
  const v1 = await h.community.getModeration('post', post.id, 1);
  const v2 = await h.community.getModeration('post', post.id, 2);
  assert.notEqual(v1.text_digest, v2.text_digest, '结论必须绑定各自版本的正文摘要');
  assert.equal(v2.target_ref.revision, 2);
  assert.equal(v2.decision, 'approved');
  // 旧版本被拒结论不会被当成新版本结论：rev2 的结论只能来自 rev2 的提交。
  assert.equal(await h.community.getModeration('post', post.id, 3), null);

  // 编辑自己的内容仍受归属保护：他人拿到的是 404（不是 409，避免泄露存在性）。
  error(
    await h.call('PATCH', `${API}/posts/${post.id}`, h.b, { headers: write('gy-http-edit-foreign-1', '"2"'), payload: postBody() }),
    404,
    'NOT_FOUND',
  );
});

test('HTTP 下架一致性：admin hidePost 生效后列表与详情同时消失，旧链接不复活', async (t) => {
  const h = await fixture(t);
  const post = await h.publish(h.a);
  const admin = await h.admin();

  const hidden = await h.call('POST', `${API}/admin/posts/${post.id}/hide`, admin, {
    headers: write('gy-http-hide-0001', '"1"'),
    payload: { reason: '内容不符合社区规范' },
  });
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
  assert.deepEqual(hidden.body.data, { accepted: true });

  // 列表/详情**引用一致**：公开面（他人 feed / 他人详情 / 评论列表）一律 404 或空，
  // 不再有任何一处把它当成 published 展示。
  assert.deepEqual((await h.call('GET', `${API}/posts`, h.b)).body.data, { items: [], next_cursor: null });
  error(await h.call('GET', `${API}/posts/${post.id}`, h.b), 404, 'NOT_FOUND');
  error(await h.call('GET', `${API}/posts/${post.id}/comments`, h.b), 404, 'NOT_FOUND');
  // 作者视角仍可读**自己的**已下架版本，但必须**显式标注 hidden**（透明，不是"一处显示一处隐藏"）。
  const mine = await h.call('GET', `${API}/posts/${post.id}`, h.a);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.data.visibility, 'hidden');
  assert.notEqual(mine.body.data.visibility, 'published');
  const mineFeed = await h.call('GET', `${API}/posts?mine=true`, h.a);
  assert.equal(mineFeed.body.data.items.length, 1);
  assert.equal(mineFeed.body.data.items[0].visibility, 'hidden');
  assert.deepEqual((await h.call('GET', `${API}/posts`, h.a)).body.data, { items: [], next_cursor: null },
    '公开 feed 对作者同样不得展示已下架内容');
  // 旧链接重复访问结论不变（不因缓存/重放复活）。
  assert.equal((await h.call('GET', `${API}/posts/${post.id}`, h.a)).body.data.visibility, 'hidden');
  // 已下架内容不得被继续点赞/举报（目标必须当前公开可见）。
  error(await h.call('PUT', `${API}/posts/${post.id}/like`, h.b, { headers: write('gy-http-hide-like-1', '"2"') }), 404, 'NOT_FOUND');
  error(
    await h.call('POST', `${API}/reports`, h.b, {
      headers: write('gy-http-hide-report-1'),
      payload: { target_ref: { type: 'post', id: post.id, revision: 2 }, reason_code: 'other' },
    }),
    404,
    'NOT_FOUND',
  );
});

// ---------------------------------------------------------------------------
// 4. 读取时重查（负例）
// ---------------------------------------------------------------------------

test('HTTP 读取时重查负例：隐藏/删除/失效不因缓存或旧链接复活', async (t) => {
  const h = await fixture(t);
  const post = await h.publish(h.a);
  assert.equal((await h.call('GET', `${API}/posts/${post.id}`, h.b)).status, 200);

  // 站点外状态变化（例如合规下线）：读取时**重算**，下一次读就不可见。
  const hidden = await h.community.commitPostIfCurrent(
    post.id,
    { revision: 1, visibility: 'published' },
    { revision: 2, visibility: 'hidden' },
    null,
  );
  assert.equal(hidden.ok, true);
  error(await h.call('GET', `${API}/posts/${post.id}`, h.b), 404, 'NOT_FOUND');
  assert.deepEqual((await h.call('GET', `${API}/posts`, h.b)).body.data, { items: [], next_cursor: null });
  // 作者可见自己的已下架版本，但**必须**标注为 hidden（绝不投影成 published）。
  const mine = await h.call('GET', `${API}/posts/${post.id}`, h.a);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.data.visibility, 'hidden');
  assert.equal(mine.body.data.audit_state, 'pending');
  // 旧 ETag（"1"）已过期 ⇒ 写路径 409，不得借此把隐藏内容写回公开。
  const writeBack = await h.call('PATCH', `${API}/posts/${post.id}`, h.a, {
    headers: write('gy-http-recheck-01', '"1"'),
    payload: postBody({ body: '想把隐藏内容写回公开' }),
  });
  error(writeBack, 409, 'REVISION_CONFLICT');

  // 删除：软删除保留审计，但对外一律 404，且不可复活。
  const second = await h.publish(h.a, {}, 'gy-http-post-0002');
  const deleted = await h.call('DELETE', `${API}/posts/${second.id}`, h.a, { headers: write('gy-http-del-0001', '"1"') });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body.data, { accepted: true });
  error(await h.call('GET', `${API}/posts/${second.id}`, h.a), 404, 'NOT_FOUND');
  const resurrect = await h.call('PATCH', `${API}/posts/${second.id}`, h.a, {
    headers: write('gy-http-del-0002', '"1"'),
    payload: postBody(),
  });
  error(resurrect, 409, 'OBJECT_UNAVAILABLE');
  // 内部重审判定也不得复活已下架内容。
  const reReview = await h.app.communityService.reReviewContent(
    { userId: h.a.user.id, role: 'user', authEpoch: 1 },
    { type: 'post', id: second.id, revision: 1 },
  );
  assert.equal(reReview.re_reviewed, false);
  assert.equal(reReview.visibility, 'deleted');
  error(await h.call('GET', `${API}/posts/${second.id}`, h.a), 404, 'NOT_FOUND');
});

// ---------------------------------------------------------------------------
// 5. 消息事件投递
// ---------------------------------------------------------------------------

test('HTTP 消息事件：投稿/评论/下架投递到消息域公开端口，同键不产生第二条', async (t) => {
  const h = await fixture(t);
  const post = await h.publish(h.a);
  const comment = await h.call('POST', `${API}/posts/${post.id}/comments`, h.b, {
    headers: write('gy-http-evt-cmt-01', '"1"'),
    payload: { body: '按标签说明处理，注意轮换。' },
  });
  assert.equal(comment.status, 201);

  const inbox = await h.call('GET', `${API}/messages`, h.a);
  assert.equal(inbox.status, 200);
  assert.deepEqual(
    inbox.body.data.items.map((item) => `${item.type}:${item.target_ref.type}:${item.target_ref.revision}`),
    ['moderation:post:1'],
    '投稿人（a）只收到自己内容的审核结果事件',
  );
  assert.equal(inbox.body.data.items.every((item) => item.read_at === null), true);
  assert.equal((await h.call('GET', `${API}/messages/unread-count`, h.a)).body.data.count, 1);
  // 事件不投递给无关用户（接收者由服务端决定，绝不来自客户端）。
  const other = await h.call('GET', `${API}/messages`, h.b);
  assert.deepEqual(
    other.body.data.items.map((item) => `${item.type}:${item.target_ref.type}:${item.target_ref.revision}`),
    ['moderation:comment:1'],
    '评论作者（b）只收到自己评论的审核结果事件',
  );

  // 下架 ⇒ takedown 事件（版本取**被处置的那一刻**）。
  const admin = await h.admin();
  const hidden = await h.call('POST', `${API}/admin/posts/${post.id}/hide`, admin, {
    headers: write('gy-http-evt-hide-1', '"1"'),
    payload: { reason: '内容不符合社区规范' },
  });
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
  const after = await h.call('GET', `${API}/messages`, h.a);
  const added = after.body.data.items.filter((item) => item.target_ref.revision === 2);
  assert.equal(added.length, 1, '下架必须投递一条事件');
  assert.equal(added[0].type, 'moderation');
  assert.equal(added[0].target_ref.type, 'post');
  assert.equal(added[0].reference_state, 'unavailable', '消息域目标读取端口未接线 ⇒ fail-closed 不可用');

  // 去重：同一事件重复投递命中去重键 ⇒ 不产生第二条消息、不重置读状态。
  const port = createMessagesCommunityEventsPort({ messages: h.app.messagesService });
  const event = {
    event: 'moderation_result',
    ownerId: h.a.user.id,
    target: { type: 'post', id: post.id, revision: 1 },
    decision: 'approved',
    reasonCodes: [],
  };
  const before = (await h.call('GET', `${API}/messages`, h.a)).body.data.items.length;
  const first = await port.publish(event);
  const second = await port.publish(event);
  assert.equal(first.created, false, '投稿时已投递过同一 (rev, decision) 事件');
  assert.equal(second.created, false);
  assert.equal(first.messageId, second.messageId);
  assert.equal((await h.call('GET', `${API}/messages`, h.a)).body.data.items.length, before);
  assert.equal(
    communityEventKey(event),
    `community:moderation_result:post:${post.id}:r1:approved`,
    '事件去重键必须由「事件身份 + 版本 + 结论」唯一确定',
  );
});

// ---------------------------------------------------------------------------
// 6. real 模式 fail-closed（未接真实持久存储）
// ---------------------------------------------------------------------------

test('HTTP real 模式：16 条社区路由一律 503 PROVIDER_UNAVAILABLE（不返回空页、不假成功）', async (t) => {
  const h = await fixture(t, { real: true });
  assert.equal(h.app.communityService, null);
  const id = ABSENT;
  const rows = [
    ['GET', `${API}/posts`, h.a, {}],
    ['POST', `${API}/posts`, h.a, { headers: write('gy-real-post-01'), payload: postBody() }],
    ['GET', `${API}/posts/${id}`, h.a, {}],
    ['PATCH', `${API}/posts/${id}`, h.a, { headers: write('gy-real-post-02', '"1"'), payload: postBody() }],
    ['DELETE', `${API}/posts/${id}`, h.a, { headers: write('gy-real-post-03', '"1"') }],
    ['GET', `${API}/posts/${id}/comments`, h.a, {}],
    ['POST', `${API}/posts/${id}/comments`, h.a, { headers: write('gy-real-cmt-01', '"1"'), payload: { body: 'x' } }],
    ['GET', `${API}/comments/${id}`, h.a, {}],
    ['PATCH', `${API}/comments/${id}`, h.a, { headers: write('gy-real-cmt-02', '"1"'), payload: { body: 'x' } }],
    ['DELETE', `${API}/comments/${id}`, h.a, { headers: write('gy-real-cmt-03', '"1"') }],
    ['PUT', `${API}/posts/${id}/like`, h.a, { headers: write('gy-real-like-01', '"1"') }],
    ['DELETE', `${API}/posts/${id}/like`, h.a, { headers: write('gy-real-like-02', '"1"') }],
    ['PUT', `${API}/comments/${id}/like`, h.a, { headers: write('gy-real-like-03', '"1"') }],
    ['DELETE', `${API}/comments/${id}/like`, h.a, { headers: write('gy-real-like-04', '"1"') }],
    ['POST', `${API}/reports`, h.a, { headers: write('gy-real-rep-01'), payload: { target_ref: { type: 'post', id, revision: 1 }, reason_code: 'other' } }],
    ['GET', `${API}/reports/${id}`, h.a, {}],
  ];
  assert.equal(rows.length, 16, '必须覆盖契约 16 个社区 operationId');
  for (const [method, path, actor, options] of rows) {
    const result = await h.call(method, path, actor, options);
    error(result, 503, 'PROVIDER_UNAVAILABLE');
    assert.equal(result.body.error.retryable, true, `${method} ${path} 必须可重试`);
    // 游客仍然先被鉴权挡住（不得因为"域未接线"就放弃鉴权）。
    error(await h.call(method, path, null, options), 401, 'SESSION_REQUIRED');
  }
  assert.deepEqual(h.community.snapshotCounts(), { posts: 0, comments: 0, reports: 0, moderation: 0 }, 'real 下不得有任何内存副作用');
});

// ---------------------------------------------------------------------------
// 7. 杂草／药剂关联
// ---------------------------------------------------------------------------

function knowledgeRow(over = {}) {
  return {
    id: 'mat-1',
    revision: 3,
    type: 'herbicide',
    title: '示例除草剂在水稻田的使用要点',
    body: '合成夹具正文',
    source: {
      id: 'src-1', version: 'v1', title: '示例来源', url: 'https://example.invalid/a',
      publisher: '示例出版单位', source_kind: 'database', evidence_kind: 'research',
      validity: 'valid', review_status: 'verified', updated_at: '2026-09-01T00:00:00.000Z',
    },
    conditions: null,
    reference_state: 'available',
    dose_cards: [],
    ...over,
  };
}
const LINK = { type: 'herbicide', id: 'mat-1', revision: 3 };

async function fixtureWithKnowledge(t, rows) {
  const port = createKnowledgeAvailabilityPort({ read: async (target) => rows[`${target.type}:${target.id}:${target.revision}`] ?? null });
  return fixture(t, { knowledge: port });
}

test('HTTP 知识关联：默认未接线 fail-closed；已接线只认已核对非模拟资料', async (t) => {
  // 默认（未接线）：新增关联一律 OBJECT_UNAVAILABLE，**不静默丢弃关联**，且不落内容行。
  const h0 = await fixture(t);
  error(
    await h0.call('POST', `${API}/posts`, h0.a, { headers: write('gy-link-default-1'), payload: postBody({ linked_knowledge_ref: LINK }) }),
    409,
    'OBJECT_UNAVAILABLE',
  );
  assert.equal(h0.community.snapshotCounts().posts, 0, '关联不可用时不得落内容行');

  // 已接线 + 已核对有效资料 ⇒ 保存并可投影 summary。
  const h = await fixtureWithKnowledge(t, { 'herbicide:mat-1:3': knowledgeRow() });
  const created = await h.call('POST', `${API}/posts`, h.a, {
    headers: write('gy-link-ok-0001'),
    payload: postBody({ linked_knowledge_ref: LINK }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.data.linked_knowledge_ref, LINK);
  assert.equal(created.body.data.linked_knowledge.reference_state, 'available');
  assert.equal(created.body.data.linked_knowledge.unavailable_reason, null);
  assert.deepEqual(created.body.data.linked_knowledge.summary, { title: '示例除草剂在水稻田的使用要点' });
  assert.deepEqual(Object.keys(created.body.data.linked_knowledge).sort(),
    ['reference_state', 'summary', 'target_ref', 'unavailable_reason'].sort());

  // 模拟资料 / 未核对资料 / 版本不符 / 类型不符 ⇒ 一律不可用（不得作为关联依据）。
  for (const [label, row] of [
    ['simulation', knowledgeRow({ source: { ...knowledgeRow().source, source_kind: 'simulation' } })],
    ['unverified', knowledgeRow({ source: { ...knowledgeRow().source, review_status: 'unverified' } })],
    ['expired', knowledgeRow({ source: { ...knowledgeRow().source, validity: 'expired' }, reference_state: 'unavailable' })],
    ['revision-mismatch', knowledgeRow({ revision: 4 })],
    ['type-mismatch', knowledgeRow({ type: 'species' })],
  ]) {
    const hx = await fixtureWithKnowledge(t, { 'herbicide:mat-1:3': row });
    error(
      await hx.call('POST', `${API}/posts`, hx.a, { headers: write(`gy-link-neg-${label}`), payload: postBody({ linked_knowledge_ref: LINK }) }),
      409,
      'OBJECT_UNAVAILABLE',
    );
    assert.equal(hx.community.snapshotCounts().posts, 0, `${label} 不得被写成关联`);
  }
});

test('HTTP 知识关联编辑语义：遗漏保留旧值、显式 null 解除、替换需当前可用', async (t) => {
  // 读取实现可切换"当前是否可用"，用来验证"原已保存失效引用可原样保留，但只输出不可用投影"。
  let available = true;
  const port = createKnowledgeAvailabilityPort({ read: async () => (available ? knowledgeRow() : null) });
  const h = await fixture(t, { knowledge: port });
  const post = await h.call('POST', `${API}/posts`, h.a, {
    headers: write('gy-link-edit-0001'),
    payload: postBody({ linked_knowledge_ref: LINK }),
  });
  assert.equal(post.status, 201);
  assert.equal(post.body.data.linked_knowledge.reference_state, 'available');

  // 关联此刻失效：**遗漏**该字段的编辑必须保留旧值（不得静默清除），投影转为不可用。
  available = false;
  const kept = await h.call('PATCH', `${API}/posts/${post.body.data.id}`, h.a, {
    headers: write('gy-link-edit-0002', '"1"'),
    payload: postBody({ body: '同一份正文更新一次。' }),
  });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.deepEqual(kept.body.data.linked_knowledge_ref, LINK, '编辑遗漏关联必须保留旧值');
  assert.equal(kept.body.data.linked_knowledge.reference_state, 'unavailable');
  assert.equal(kept.body.data.linked_knowledge.unavailable_reason, 'TARGET_UNAVAILABLE');
  assert.equal(kept.body.data.linked_knowledge.summary, null);

  // 替换成另一个（当前不可用的）引用 ⇒ 需当前可用 ⇒ 拒绝。
  error(
    await h.call('PATCH', `${API}/posts/${post.body.data.id}`, h.a, {
      headers: write('gy-link-edit-0003', '"2"'),
      payload: postBody({ linked_knowledge_ref: { type: 'herbicide', id: 'mat-2', revision: 1 } }),
    }),
    409,
    'OBJECT_UNAVAILABLE',
  );
  // 未改变的引用（逐项相同，即使当前失效）不触发"需当前可用"闸门。
  const sameAgain = await h.call('PATCH', `${API}/posts/${post.body.data.id}`, h.a, {
    headers: write('gy-link-edit-0004', '"2"'),
    payload: postBody({ linked_knowledge_ref: LINK }),
  });
  assert.equal(sameAgain.status, 200, JSON.stringify(sameAgain.body));
  assert.equal(sameAgain.body.data.revision, 3);
  assert.deepEqual(sameAgain.body.data.linked_knowledge_ref, LINK);

  // 显式 null ⇒ 解除关联。
  const cleared = await h.call('PATCH', `${API}/posts/${post.body.data.id}`, h.a, {
    headers: write('gy-link-edit-0005', '"3"'),
    payload: postBody({ linked_knowledge_ref: null }),
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.data.linked_knowledge_ref, null);
  assert.equal(cleared.body.data.linked_knowledge, null);
});

// ---------------------------------------------------------------------------
// 8. 严格输入（契约闭集/长度/头部/游标）+ 图片（规则层媒体口径）
// ---------------------------------------------------------------------------

test('HTTP 严格输入：多余字段/长度/枚举/媒体清单/头部/游标一律契约错误码', async (t) => {
  const h = await fixture(t);
  const post = await h.publish(h.a);
  const url = `${API}/posts/${post.id}`;

  for (const [label, payload] of [
    ['extra-field', postBody({ author_id: h.b.user.id })],
    ['missing-required', { title: CLEAN_TITLE, body: CLEAN_BODY }],
    ['title-too-long', postBody({ title: 'x'.repeat(121) })],
    ['body-too-long', postBody({ body: 'x'.repeat(8001) })],
    ['region-pattern', postBody({ region_code: '3301' })],
    ['link-type-enum', postBody({ linked_knowledge_ref: { type: 'post', id: 'x', revision: 1 } })],
    ['media-too-many', postBody({ media_ids: [ABSENT, ABSENT.replace('0000', '0001'), ABSENT.replace('0000', '0002'), ABSENT.replace('0000', '0003')] })],
    ['media-duplicate', postBody({ media_ids: [ABSENT, ABSENT] })],
    ['media-not-uuid', postBody({ media_ids: ['not-a-uuid'] })],
  ]) {
    error(await h.call('POST', `${API}/posts`, h.a, { headers: write(`gy-strict-${label}`), payload }), 400, 'INVALID_REQUEST');
  }
  // 写头：Idempotency-Key 缺失/过短；If-Match 缺失（428）/非法（400）。
  error(await h.call('POST', `${API}/posts`, h.a, { payload: postBody() }), 400, 'IDEMPOTENCY_KEY_REQUIRED');
  error(await h.call('POST', `${API}/posts`, h.a, { headers: write('short'), payload: postBody() }), 400, 'IDEMPOTENCY_KEY_REQUIRED');
  error(await h.call('PATCH', url, h.a, { headers: { 'idempotency-key': 'gy-strict-ifmatch-1' }, payload: postBody() }), 428, 'REVISION_REQUIRED');
  error(await h.call('PATCH', url, h.a, { headers: write('gy-strict-ifmatch-2', '*'), payload: postBody() }), 400, 'INVALID_REQUEST');
  error(await h.call('PUT', `${url}/like`, h.a, { headers: write('gy-strict-like-01') }), 428, 'REVISION_REQUIRED');
  error(await h.call('GET', `${API}/posts/${url.split('/').pop()}/comments?limit=51`, h.a), 400, 'INVALID_REQUEST');
  // 查询参数：闭集外字段、越界 limit、非法布尔、篡改游标。
  error(await h.call('GET', `${API}/posts?owner_id=${h.b.user.id}`, h.a), 400, 'INVALID_REQUEST');
  error(await h.call('GET', `${API}/posts?limit=0`, h.a), 400, 'INVALID_REQUEST');
  error(await h.call('GET', `${API}/posts?mine=maybe`, h.a), 400, 'INVALID_REQUEST');
  // 评论入参闭集与长度。
  error(
    await h.call('POST', `${url}/comments`, h.a, { headers: write('gy-strict-cmt-01', '"1"'), payload: { body: 'x', post_id: post.id } }),
    400,
    'INVALID_REQUEST',
  );
  error(
    await h.call('POST', `${url}/comments`, h.a, { headers: write('gy-strict-cmt-02', '"1"'), payload: { body: 'x'.repeat(4001) } }),
    400,
    'INVALID_REQUEST',
  );
  // 举报枚举与目标形状。
  error(
    await h.call('POST', `${API}/reports`, h.a, {
      headers: write('gy-strict-rep-01'),
      payload: { target_ref: { type: 'post', id: post.id, revision: 1 }, reason_code: 'spam' },
    }),
    400,
    'INVALID_REQUEST',
  );
  // 篡改游标：服务端验签，客户端改不动。
  const many = await fixture(t);
  for (let i = 0; i < 3; i += 1) await many.publish(many.a, {}, `gy-cursor-post-000${i}`);
  const first = await many.call('GET', `${API}/posts?limit=1`, many.a);
  const cursor = first.body.data.next_cursor;
  assert.equal(typeof cursor, 'string');
  error(await many.call('GET', `${API}/posts?limit=1&cursor=${encodeURIComponent(cursor.slice(0, -2) + 'xx')}`, many.a), 400, 'INVALID_CURSOR');
  error(await many.call('GET', `${API}/posts?limit=1&cursor=${encodeURIComponent(cursor)}`, many.b), 400, 'INVALID_CURSOR');
  assert.equal((await many.call('GET', `${API}/posts?limit=1&cursor=${encodeURIComponent(cursor)}`, many.a)).body.data.items.length, 1);
});

test('HTTP 图片帖：规则层媒体口径未覆盖 ⇒ fail-closed（绝不把未审图片当通过发布）', async (t) => {
  const h = await fixture(t);
  // 逻辑上合法的 1 张附件（uuid 形态）：规则层遇媒体一律不判通过（`packages/moderation/merge.mjs`
  // 明确声明这是跨片依赖），因此这里必须**拒绝**而不是"没有图片审核也放行"。
  const result = await h.call('POST', `${API}/posts`, h.a, {
    headers: write('gy-media-post-0001'),
    payload: postBody({ media_ids: [ABSENT] }),
  });
  assert.equal(result.status, 422, JSON.stringify(result.body));
  assert.equal(result.body.error.code, 'INPUT_UNCERTAIN');
  assert.ok(result.body.error.details.length > 0);
  assert.equal(h.community.snapshotCounts().posts, 0, '带媒体内容不得落内容行');
  assert.deepEqual((await h.call('GET', `${API}/posts`, h.b)).body.data, { items: [], next_cursor: null });
});
