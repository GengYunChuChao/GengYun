/**
 * GY-R28 W10 · 社区投稿面 `public_posting` 用途闸（三条负控制 + 未挂清单）。
 *
 * 闸只挂在**向公众发布**的 4 个写入口上（`PUBLIC_POSTING_GATED_ROUTES`）：
 *   POST   /posts                  createPost
 *   PATCH  /posts/:id              editPost
 *   POST   /posts/:id/comments     createComment
 *   PATCH  /comments/:id           editComment
 *
 * 本文件证明（每条都有读数，不是"跑过就算"）：
 *   1. **无授权 ⇒ 403 `CONSENT_REQUIRED`，且零内容写入**（帖子/评论行不落库、幂等账本不落）；
 *   2. **有授权（真实 `consentStore.grant`）⇒ 201/200**；
 *   3. **撤回授权（真实 `consentStore.withdraw`）⇒ 同一请求再 403**；
 *   4. 读列表／读详情／点赞／举报／删除**不挂**该闸：同样的无授权账号打这 12 条入口
 *      **不会**拿到 `CONSENT_REQUIRED`（否则既有社区用例会被凭空误伤）。
 *
 * 合成声明：账号、正文、授权记录都是合成值；不读真实 `.env`、不连真实库、零真实外发。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createMemoryCommunityStore } from '../../services/api/src/community/store.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import { PUBLIC_POSTING_GATED_ROUTES } from '../../services/api/src/routes/community.ts';
import { CLEAN_BODY, CLEAN_TITLE, makeGate, makeSyntheticPassPort } from './community-fixtures.mjs';
import { frozenModerationInjection } from './stall-hygiene-fixtures.mjs';
import { createPublicPostingConsent } from './community-posting-consent-fixtures.mjs';

const API = '/api/v1';
const START = Date.UTC(2026, 9, 21, 4, 0, 0);

/** 写头：`Idempotency-Key`（8..128）+ 可选 `If-Match`（强 ETag）。 */
function write(key, version) {
  return { 'idempotency-key': key, ...(version === undefined ? {} : { 'if-match': version }) };
}

function postBody(over = {}) {
  return { title: CLEAN_TITLE, body: CLEAN_BODY, media_ids: [], ...over };
}

/**
 * 装配：**不自动授权**。调用方自己决定 grant / withdraw —— 这正是负控制要观察的那个开关。
 * （其余与 `tests/unit/community-http.test.mjs` 的既有夹具同形：合成 pass 端口让内容可发布、
 * 规则层时钟冻结避免机器抖动变成 422 隔离。）
 */
async function makeHarness(t) {
  const auth = createMemoryAuthStore();
  const community = createMemoryCommunityStore({ now: () => new Date(START) });
  const messages = createMemoryMessagesStore({ now: () => new Date(START) });
  const consent = createPublicPostingConsent();
  const config = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
  const app = buildApp({
    config,
    store: auth,
    now: () => new Date(START),
    privacyInjection: { consent: consent.gate },
    communityInjection: { store: community, gate: makeGate() },
    messagesInjection: { store: messages },
    moderationInjection: frozenModerationInjection({
      executionMode: config.executionMode,
      ports: { tms: makeSyntheticPassPort('tms') },
      store: community,
    }),
  });
  t.after(() => app.close());

  async function session(subject) {
    const created = await auth.createUser(String(subject).repeat(64));
    const token = `synthetic-w10-token-${subject}`;
    await auth.createSession({
      userId: created.id,
      tokenHashHex: hashToken(token),
      authEpoch: created.authEpoch,
      expiresAt: new Date(START + 48 * 3600_000),
      audience: 'user',
    });
    return { userId: created.id, token, authEpoch: created.authEpoch };
  }

  async function call(method, path, actor, { headers = {}, payload } = {}) {
    const response = await app.inject({
      method,
      url: path,
      headers: {
        ...(actor === undefined || actor === null ? {} : { authorization: `Bearer ${actor.token}` }),
        ...headers,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { payload }),
    });
    const text = response.body;
    return {
      status: response.statusCode,
      body: text === '' ? null : JSON.parse(text),
      cache: response.headers['cache-control'],
    };
  }

  return { app, auth, community, consent, session, call };
}

/** 契约错误封套断言（含 `no-store`，且**无成功封套**）。 */
function assertConsentDenied(result) {
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(result.body.error.code, 'CONSENT_REQUIRED', JSON.stringify(result.body));
  assert.match(String(result.body.error.message), /public_posting/, '拒绝信息必须指名缺的那一码');
  assert.equal(result.body.error.retryable, false, '缺授权不是暂时性故障');
  assert.deepEqual(result.body.error.details, []);
  assert.equal(result.body.data, undefined, '不得返回成功封套');
  assert.equal(result.cache, 'no-store');
}

// ---------------------------------------------------------------------------
// 0. 闸的清单本身就是证据：只这 4 条，多一条少一条都必须让本用例红
// ---------------------------------------------------------------------------

test('闸清单：`public_posting` 恰挂在 4 个投稿面（发帖/编辑帖/评论/编辑评论）', () => {
  assert.deepEqual([...PUBLIC_POSTING_GATED_ROUTES], [
    'POST /posts',
    'PATCH /posts/{id}',
    'POST /posts/{id}/comments',
    'PATCH /comments/{id}',
  ]);
});

// ---------------------------------------------------------------------------
// 1. 负控制一：无授权 ⇒ 403 CONSENT_REQUIRED，且零内容写入
// ---------------------------------------------------------------------------

test('负控制①：无授权投稿 ⇒ 403 CONSENT_REQUIRED，且帖子/评论/审核/幂等账本零写入', async (t) => {
  const h = await makeHarness(t);
  const author = await h.session('no-grant');

  const denied = await h.call('POST', `${API}/posts`, author, {
    headers: write('gy-w10-deny-0001'),
    payload: postBody(),
  });
  assertConsentDenied(denied);

  // 零写入：社区存储里没有帖子行、没有审核行。
  assert.equal((await h.community.listPosts()).length, 0, '被拒的投稿不得落帖子行');
  assert.equal(await h.community.countModeration(), 0, '被拒的投稿不得落审核行');

  // 零写入的**可判据证明**：补授权后用同一个 Idempotency-Key 提交**不同**请求体，
  // 若被拒那次曾落过幂等账本，这里会 409 IDEMPOTENCY_CONFLICT；实测必须 201。
  await h.consent.grant(author.userId);
  const reused = await h.call('POST', `${API}/posts`, author, {
    headers: write('gy-w10-deny-0001'),
    payload: postBody({ title: '补授权后的另一条标题' }),
  });
  assert.equal(reused.status, 201, `被拒请求必须零写入（同键新体仍应受理）：${JSON.stringify(reused.body)}`);
});

test('负控制①-补：无授权发评论 ⇒ 403，且评论行不落库（帖子是别人已经发出来的）', async (t) => {
  const h = await makeHarness(t);
  const author = await h.session('granted-author');
  const stranger = await h.session('no-grant-commenter');
  await h.consent.grant(author.userId);

  const post = await h.call('POST', `${API}/posts`, author, { headers: write('gy-w10-post-0001'), payload: postBody() });
  assert.equal(post.status, 201, JSON.stringify(post.body));
  const postId = post.body.data.id;

  const denied = await h.call('POST', `${API}/posts/${postId}/comments`, stranger, {
    headers: write('gy-w10-deny-comment-0001', '"1"'),
    payload: { body: '未授权账号的评论' },
  });
  assertConsentDenied(denied);
  assert.equal((await h.community.listComments(postId)).length, 0, '被拒的评论不得落评论行');
});

// ---------------------------------------------------------------------------
// 2. 正控制：有授权 ⇒ 201/200（与未挂闸同形）
// ---------------------------------------------------------------------------

test('正控制：有授权 ⇒ 发帖 201、编辑 200、评论 201、编辑评论 200（强 ETag 不变）', async (t) => {
  const h = await makeHarness(t);
  const author = await h.session('granted-writer');
  await h.consent.grant(author.userId);
  assert.equal(await h.consent.isGranted(author.userId), true, '授权记录必须真的落进了授权账本');

  const post = await h.call('POST', `${API}/posts`, author, { headers: write('gy-w10-allow-post-0001'), payload: postBody() });
  assert.equal(post.status, 201, JSON.stringify(post.body));
  assert.equal(post.body.data.visibility, 'published');
  assert.equal(post.body.data.audit_state, 'approved');

  const edited = await h.call('PATCH', `${API}/posts/${post.body.data.id}`, author, {
    headers: write('gy-w10-allow-edit-0001', '"1"'),
    payload: postBody({ body: '补授权后的正文' }),
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.data.revision, 2);

  const comment = await h.call('POST', `${API}/posts/${post.body.data.id}/comments`, author, {
    headers: write('gy-w10-allow-comment-0001', '"2"'),
    payload: { body: '有授权的评论' },
  });
  assert.equal(comment.status, 201, JSON.stringify(comment.body));

  const editedComment = await h.call('PATCH', `${API}/comments/${comment.body.data.id}`, author, {
    headers: write('gy-w10-allow-edit-comment-0001', '"1"'),
    payload: { body: '有授权的评论（改过）' },
  });
  assert.equal(editedComment.status, 200, JSON.stringify(editedComment.body));
});

// ---------------------------------------------------------------------------
// 3. 负控制二：撤回授权 ⇒ 同一请求再 403
// ---------------------------------------------------------------------------

test('负控制②：撤回 `public_posting` ⇒ 发帖/评论/编辑三条面同时再 403（撤回前是 201/200）', async (t) => {
  const h = await makeHarness(t);
  const author = await h.session('withdraw-writer');
  await h.consent.grant(author.userId);

  const post = await h.call('POST', `${API}/posts`, author, { headers: write('gy-w10-w1-post-0001'), payload: postBody() });
  assert.equal(post.status, 201, JSON.stringify(post.body));
  const postId = post.body.data.id;
  const comment = await h.call('POST', `${API}/posts/${postId}/comments`, author, {
    headers: write('gy-w10-w1-comment-0001', '"1"'),
    payload: { body: '撤回前的评论' },
  });
  assert.equal(comment.status, 201, JSON.stringify(comment.body));
  const commentId = comment.body.data.id;

  await h.consent.withdraw(author.userId);
  assert.equal(await h.consent.isGranted(author.userId), false, '撤回后账本必须回到未授权');

  assertConsentDenied(
    await h.call('POST', `${API}/posts`, author, { headers: write('gy-w10-w2-post-0001'), payload: postBody({ title: '撤回后再发' }) }),
  );
  assertConsentDenied(
    await h.call('PATCH', `${API}/posts/${postId}`, author, {
      headers: write('gy-w10-w2-edit-0001', '"1"'),
      payload: postBody({ body: '撤回后再改' }),
    }),
  );
  assertConsentDenied(
    await h.call('POST', `${API}/posts/${postId}/comments`, author, {
      headers: write('gy-w10-w2-comment-0001', '"1"'),
      payload: { body: '撤回后的评论' },
    }),
  );
  assertConsentDenied(
    await h.call('PATCH', `${API}/comments/${commentId}`, author, {
      headers: write('gy-w10-w2-edit-comment-0001', '"1"'),
      payload: { body: '撤回后改评论' },
    }),
  );

  // 撤回不清既有内容（授权管的是"再发布"，不是"把已发布的内容抹掉"）。
  assert.equal((await h.community.listPosts()).length, 1, '撤回不得删掉已发布的帖子');
});

// ---------------------------------------------------------------------------
// 4. 负控制三（防误伤）：读/赞/举报/删除这 12 条入口**不挂**该闸
// ---------------------------------------------------------------------------

test('负控制③：同样的无授权账号打读/赞/举报/删除 12 条入口 ⇒ 无一条 403 CONSENT_REQUIRED', async (t) => {
  const h = await makeHarness(t);
  const author = await h.session('untouched-author');
  const other = await h.session('untouched-other');
  await h.consent.grant(author.userId);

  const post = await h.call('POST', `${API}/posts`, author, { headers: write('gy-w10-n1-post-0001'), payload: postBody() });
  assert.equal(post.status, 201, JSON.stringify(post.body));
  const postId = post.body.data.id;
  const comment = await h.call('POST', `${API}/posts/${postId}/comments`, author, {
    headers: write('gy-w10-n1-comment-0001', '"1"'),
    payload: { body: '给点赞用的评论' },
  });
  assert.equal(comment.status, 201, JSON.stringify(comment.body));
  const commentId = comment.body.data.id;

  // `other` 从未授权；`author` 也已撤回 —— 两条腿都是"无 public_posting"。
  await h.consent.withdraw(author.userId);
  assert.equal(await h.consent.isGranted(other.userId), false);

  const satisfied = [
    ['GET', `${API}/posts`, other, {}],
    ['GET', `${API}/posts/${postId}`, other, {}],
    ['GET', `${API}/posts/${postId}/comments`, other, {}],
    ['GET', `${API}/comments/${commentId}`, other, {}],
    ['PUT', `${API}/posts/${postId}/like`, other, { headers: write('gy-w10-n1-like-0001', '"1"') }],
    ['DELETE', `${API}/posts/${postId}/like`, other, { headers: write('gy-w10-n1-unlike-0001', '"1"') }],
    ['PUT', `${API}/comments/${commentId}/like`, other, { headers: write('gy-w10-n1-clike-0001', '"1"') }],
    ['DELETE', `${API}/comments/${commentId}/like`, other, { headers: write('gy-w10-n1-cunlike-0001', '"1"') }],
  ];
  for (const [method, path, actor, options] of satisfied) {
    const result = await h.call(method, path, actor, options);
    assert.equal(result.status, 200, `${method} ${path} 不该被投稿闸波及：${JSON.stringify(result.body)}`);
  }

  const report = await h.call('POST', `${API}/reports`, other, {
    headers: write('gy-w10-n1-report-0001'),
    payload: { target_ref: { type: 'post', id: postId, revision: 1 }, reason_code: 'dangerous' },
  });
  assert.equal(report.status, 201, JSON.stringify(report.body));
  const ownReport = await h.call('GET', `${API}/reports/${report.body.data.id}`, other);
  assert.equal(ownReport.status, 200, JSON.stringify(ownReport.body));

  // 删除自己的内容同样不是"投稿"：无授权也必须能删（不是 403 CONSENT_REQUIRED）。
  const deleteComment = await h.call('DELETE', `${API}/comments/${commentId}`, author, {
    headers: write('gy-w10-n1-del-comment-0001', '"1"'),
  });
  assert.notEqual(deleteComment.body?.error?.code, 'CONSENT_REQUIRED', JSON.stringify(deleteComment.body));
  assert.equal(deleteComment.status, 200, JSON.stringify(deleteComment.body));

  const deletePost = await h.call('DELETE', `${API}/posts/${postId}`, author, {
    headers: write('gy-w10-n1-del-post-0001', '"1"'),
  });
  assert.notEqual(deletePost.body?.error?.code, 'CONSENT_REQUIRED', JSON.stringify(deletePost.body));
  assert.equal(deletePost.status, 200, JSON.stringify(deletePost.body));

  // 逐条再兜一遍：任何入口都不得吐 `CONSENT_REQUIRED`（除上面已被覆盖的 4 条投稿面）。
  const nonPosting = [
    ['GET', `${API}/posts`],
    ['GET', `${API}/posts/${postId}`],
    ['GET', `${API}/posts/${postId}/comments`],
    ['GET', `${API}/comments/${commentId}`],
  ];
  for (const [method, path] of nonPosting) {
    const result = await h.call(method, path, other);
    assert.notEqual(result.body?.error?.code, 'CONSENT_REQUIRED', `${method} ${path} 不得挂投稿闸`);
  }
});
