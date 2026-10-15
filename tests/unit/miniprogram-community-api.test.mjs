/**
 * GY-I15（#15）阶段 2 · 小程序社区适配层的**契约消费回归**（Node + 模拟 wx）。
 *
 * 为什么需要：小程序侧无法在本仓库用真实微信编译器或真机验证（未取得），
 * 因此这里用 vm 载入**真实的** `miniprogram/utils/community-api.js`，把 `wx.request`
 * 换成受控替身，逐条核对：
 *   - 请求方法/路径/查询串/头部（`Idempotency-Key`、`If-Match: "<revision>"`）；
 *   - 成功封套只认 200/201，实体形状/闭集不符即 `INVALID_RESPONSE`（不"尽力解析"）；
 *   - 错误封套按契约错误码抛出，并保留规则层原因码（供页面如实展示"未通过审核"）；
 *   - 401/403 清本地会话并报 `SESSION_REQUIRED`；非本会话世代的迟到响应被丢弃。
 *
 * 边界：替身 `wx` 是**合成**的；本文件不证明页面视觉、真机或真实审核能力。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');

const POST_ID = '11111111-1111-4111-8111-111111111111';
const COMMENT_ID = '22222222-2222-4222-8222-222222222222';
const REPORT_ID = '33333333-3333-4333-8333-333333333333';
const MEDIA_ID = '44444444-4444-4444-8444-444444444444';

function author() {
  return { display_name: '耕云用户abcd', display_id: 'gy-abcdef012345', state: 'active', avatar_media_id: null, revision: 1, avatar_media: null };
}
function post(over = {}) {
  return {
    id: POST_ID, revision: 1, author: author(), title: '稗草防除经验交流', body: '按标签说明选择登记药剂。',
    crop_id: 'crop_rice', region_code: '330100', media_ids: [], visibility: 'published', audit_state: 'approved',
    created_at: '2026-10-20T04:00:00.000Z', updated_at: '2026-10-20T04:00:00.000Z', media: [],
    linked_knowledge_ref: null, linked_knowledge: null, ...over,
  };
}
function comment(over = {}) {
  return {
    id: COMMENT_ID, revision: 1, post_id: POST_ID, author: author(), body: '也遇到过类似情况。',
    visibility: 'published', audit_state: 'approved', created_at: '2026-10-20T04:05:00.000Z', ...over,
  };
}
function envelope(data, mode = 'stub') {
  return {
    data,
    meta: { request_id: '99999999-9999-4999-8999-999999999999', contract_version: '1.0.0', execution_mode: mode },
  };
}
function errorEnvelope(code, details = []) {
  return {
    error: { code, message: 'm', retryable: false, details },
    meta: { request_id: '99999999-9999-4999-8999-999999999999', contract_version: '1.0.0', execution_mode: 'stub' },
  };
}

/** 载入真实适配层；`respond` 决定每个请求的替身响应。 */
function load(respond, file = 'miniprogram/utils/community-api.js', options = {}) {
  const loggedIn = options.loggedIn !== false;
  const calls = [];
  const cleared = { count: 0 };
  const auth = {
    isLoggedIn: () => loggedIn,
    getSession: () => loggedIn ? { accessToken: 'synthetic-token', audience: 'user', expiresAt: '2099-01-01T00:00:00.000Z', executionMode: 'stub' } : null,
    sessionEpoch: () => '7:3',
    networkEnabled: () => true,
    clearSession: () => { cleared.count += 1 },
  };
  const wx = {
    request(options) {
      calls.push(options);
      const result = respond(options, calls.length);
      if (result && result.fail) { options.fail({ errMsg: 'synthetic network failure' }); return }
      options.success(result);
    },
  };
  const box = { exports: {} };
  vm.runInNewContext(readFileSync(resolve(root, file), 'utf8'), {
    module: box,
    wx,
    require: (id) => (id === './auth' ? auth : { apiBaseUrl: 'http://127.0.0.1:4318/api/v1' }),
  });
  return { api: box.exports, calls, cleared };
}

/** 跨 vm realm 的形状比较：对象的原型来自另一个 realm，deepStrictEqual 会因此失败。 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function rejects(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('期望抛出错误，但没有抛出');
}

test('列表：查询串绑定筛选、GET 与授权头正确，空页与分页游标原样透传', async () => {
  const h = load(() => ({ statusCode: 200, data: envelope({ items: [post()], next_cursor: 'cursor-1' }) }));
  const page = await h.api.listPosts({ crop_id: 'crop_rice', region_code: '330100', mine: true, limit: 20 });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, 'GET');
  assert.equal(h.calls[0].url, 'http://127.0.0.1:4318/api/v1/posts?crop_id=crop_rice&limit=20&mine=true&region_code=330100');
  assert.equal(h.calls[0].header.authorization, 'Bearer synthetic-token');
  assert.equal(h.calls[0].header['Idempotency-Key'], undefined, '读路径不带幂等键');
  assert.equal(page.items.length, 1);
  assert.equal(page.nextCursor, 'cursor-1');
  assert.equal(page.mode, 'stub');
  assert.match(h.api.modeNote('stub'), /替身/);
});

test('成功封套：实体形状/闭集不符即 INVALID_RESPONSE（不"尽力解析"）', async () => {
  const cases = [
    ['契约外字段', post({ like_count: 3 })],
    ['可见性不在闭集', post({ visibility: 'archived' })],
    ['审核状态不在闭集', post({ audit_state: 'ok' })],
    ['id 非 uuid', post({ id: 'not-a-uuid' })],
    ['时间戳非法', post({ created_at: '2026-10-20 04:00' })],
    ['关联投影与 ref 不一致', post({ linked_knowledge_ref: { type: 'herbicide', id: 'mat-1', revision: 1 }, linked_knowledge: null })],
    ['关联可用却没有 summary', post({
      linked_knowledge_ref: { type: 'herbicide', id: 'mat-1', revision: 1 },
      linked_knowledge: { target_ref: { type: 'herbicide', id: 'mat-1', revision: 1 }, reference_state: 'available', unavailable_reason: null, summary: null },
    })],
  ];
  for (const [label, item] of cases) {
    const h = load(() => ({ statusCode: 200, data: envelope({ items: [item], next_cursor: null }) }));
    const error = await rejects(h.api.listPosts({}));
    assert.equal(error.code, 'INVALID_RESPONSE', label);
  }
  // 契约内的关联投影（不可用）必须被接受：ref 保留 + 粗粒度状态 + summary null。
  const ok = load(() => ({
    statusCode: 200,
    data: envelope({
      items: [post({
        linked_knowledge_ref: { type: 'herbicide', id: 'mat-1', revision: 3 },
        linked_knowledge: { target_ref: { type: 'herbicide', id: 'mat-1', revision: 3 }, reference_state: 'unavailable', unavailable_reason: 'TARGET_UNAVAILABLE', summary: null },
      })],
      next_cursor: null,
    }),
  }));
  const page = await ok.api.listPosts({});
  assert.equal(page.items[0].linked_knowledge.reference_state, 'unavailable');
});

test('写路径头部：Idempotency-Key 合规、If-Match 为强 ETag 形态、方法与路径逐项正确', async () => {
  const h = load((options) => {
    if (options.method === 'POST' && options.url.endsWith('/posts')) return { statusCode: 201, data: envelope(post()) };
    if (options.method === 'PATCH') return { statusCode: 200, data: envelope(post({ revision: 2 })) };
    if (options.method === 'DELETE' && options.url.endsWith('/like')) return { statusCode: 200, data: envelope({ accepted: true }) };
    if (options.method === 'PUT') return { statusCode: 200, data: envelope({ accepted: true }) };
    if (options.method === 'DELETE') return { statusCode: 200, data: envelope({ accepted: true }) };
    if (options.url.includes('/comments')) return { statusCode: 201, data: envelope(comment()) };
    return { statusCode: 201, data: envelope({ id: REPORT_ID, revision: 1, target_ref: { type: 'post', id: POST_ID, revision: 1 }, state: 'received', reason_code: 'advertising' }) };
  });

  const created = await h.api.createPost({ title: 't', body: 'b', media_ids: [] });
  assert.equal(created.post.id, POST_ID);
  const createCall = h.calls[h.calls.length - 1];
  assert.equal(createCall.method, 'POST');
  assert.ok(createCall.header['Idempotency-Key'].length >= 8 && createCall.header['Idempotency-Key'].length <= 128);
  assert.equal(createCall.header['content-type'], 'application/json');
  assert.equal(createCall.header['If-Match'], undefined, '创建不需要 If-Match');
  assert.deepEqual(plain(createCall.data), { title: 't', body: 'b', media_ids: [] });

  await h.api.editPost(POST_ID, { title: 't2', body: 'b2', media_ids: [] }, 1);
  const editCall = h.calls[h.calls.length - 1];
  assert.equal(editCall.method, 'PATCH');
  assert.equal(editCall.url, 'http://127.0.0.1:4318/api/v1/posts/' + POST_ID);
  assert.equal(editCall.header['If-Match'], '"1"');
  assert.match(editCall.header['If-Match'], /^"[1-9][0-9]*"$/);
  // 契约：编辑遗漏 linked_knowledge_ref ⇒ 保留旧值。适配层不得替调用方补 null。
  assert.equal('linked_knowledge_ref' in editCall.data, false);

  await h.api.deletePost(POST_ID, 2);
  const deleteCall = h.calls[h.calls.length - 1];
  assert.equal(deleteCall.method, 'DELETE');
  assert.equal(deleteCall.header['If-Match'], '"2"');

  await h.api.likePost(POST_ID, 1);
  assert.equal(h.calls[h.calls.length - 1].method, 'PUT');
  assert.equal(h.calls[h.calls.length - 1].url, 'http://127.0.0.1:4318/api/v1/posts/' + POST_ID + '/like');
  await h.api.unlikePost(POST_ID, 1);
  assert.equal(h.calls[h.calls.length - 1].method, 'DELETE');
  await h.api.likeComment(COMMENT_ID, 1);
  assert.equal(h.calls[h.calls.length - 1].url, 'http://127.0.0.1:4318/api/v1/comments/' + COMMENT_ID + '/like');

  await h.api.createComment(POST_ID, '看苗情再决定。', 1);
  const commentCall = h.calls[h.calls.length - 1];
  assert.equal(commentCall.url, 'http://127.0.0.1:4318/api/v1/posts/' + POST_ID + '/comments');
  assert.equal(commentCall.header['If-Match'], '"1"', 'If-Match = 父帖当前 revision');
  assert.deepEqual(plain(commentCall.data), { body: '看苗情再决定。' });

  const report = await h.api.createReport({ type: 'post', id: POST_ID, revision: 1 }, 'advertising', '');
  assert.equal(report.report.state, 'received');
  const reportCall = h.calls[h.calls.length - 1];
  assert.deepEqual(plain(reportCall.data), { target_ref: { type: 'post', id: POST_ID, revision: 1 }, reason_code: 'advertising' },
    '空 detail 不得进入请求体');
});

test('错误封套：契约错误码与规则层原因码如实透传；未通过审核不得被当成成功', async () => {
  const refused = load(() => ({
    statusCode: 400,
    data: errorEnvelope('INVALID_REQUEST', [{ field: 'reason_codes', code: 'DANGEROUS_MIX' }, { field: 'reason_codes', code: 'NOT_PUBLISHABLE' }]),
  }));
  const error = await rejects(refused.api.createPost({ title: 't', body: 'b', media_ids: [] }));
  assert.equal(error.code, 'INVALID_REQUEST');
  assert.deepEqual(plain(refused.api.reasonCodes(error)), ['DANGEROUS_MIX', 'NOT_PUBLISHABLE']);
  assert.match(refused.api.message(error), /未通过先行审核/);
  assert.match(refused.api.message(error), /DANGEROUS_MIX/);

  // 契约 503（real 模式未接真实存储/供应商）必须如实报"服务暂不可用"，不得当作成功。
  const unavailable = load(() => ({ statusCode: 503, data: errorEnvelope('PROVIDER_UNAVAILABLE') }));
  const downError = await rejects(unavailable.api.listPosts({}));
  assert.equal(downError.code, 'PROVIDER_UNAVAILABLE');
  assert.match(unavailable.api.message(downError), /暂不可用/);

  // 目标不可用（关联资料/已下架）：OBJECT_UNAVAILABLE 原样抛出。
  const unavailable2 = load(() => ({ statusCode: 409, data: errorEnvelope('OBJECT_UNAVAILABLE') }));
  assert.equal((await rejects(unavailable2.api.createPost({ title: 't', body: 'b', media_ids: [] }))).code, 'OBJECT_UNAVAILABLE');

  // 形状异常的"错误"响应不得被猜成成功。
  const malformed = load(() => ({ statusCode: 500, data: { unexpected: true } }));
  assert.equal((await rejects(malformed.api.getPost(POST_ID))).code, 'INVALID_RESPONSE');
});

test('会话：401/403 清本地会话并报 SESSION_REQUIRED；网络失败按 SESSION_CHANGED 折叠', async () => {
  const unauthorized = load(() => ({ statusCode: 401, data: errorEnvelope('SESSION_REQUIRED') }));
  const error = await rejects(unauthorized.api.listPosts({}));
  assert.equal(error.code, 'SESSION_REQUIRED');
  assert.equal(unauthorized.cleared.count, 1, '401 必须清理本地会话，避免缓存被当成登录态');

  const forbidden = load(() => ({ statusCode: 403, data: errorEnvelope('SCOPE_DENIED') }));
  assert.equal((await rejects(forbidden.api.getPost(POST_ID))).code, 'SESSION_REQUIRED');
  assert.equal(forbidden.cleared.count, 1);

  const offline = load(() => ({ fail: true }));
  assert.equal((await rejects(offline.api.getPost(POST_ID))).code, 'NETWORK_UNCERTAIN');
  assert.match(offline.api.message({ code: 'NETWORK_UNCERTAIN' }), /网络/);
});

test('入参预检：非法 uuid / 非闭集举报原因 / 超长正文在本地即拒绝，不发请求', async () => {
  const h = load(() => ({ statusCode: 200, data: envelope(post()) }));
  assert.equal((await rejects(h.api.getPost('x'))).code, 'INVALID_INPUT');
  assert.equal((await rejects(h.api.createReport({ type: 'post', id: POST_ID, revision: 1 }, 'spam', ''))).code, 'INVALID_INPUT');
  assert.equal((await rejects(h.api.createReport({ type: 'comment', id: POST_ID, revision: 0 }, 'other', ''))).code, 'INVALID_INPUT');
  assert.equal((await rejects(h.api.createComment(POST_ID, 'x'.repeat(4001), 1))).code, 'INVALID_INPUT');
  // 合法入参照常发出（证明上面的拒绝来自预检而不是"一律拒绝"）。
  const created = await h.api.createPost({ title: 't', body: 'b', media_ids: [] });
  assert.equal(created.post.id, POST_ID);
  assert.equal(h.calls.length, 1, '只有 createPost 真正发出（其余在本地被拒）');
});

// ---------------------------------------------------------------------------
// GY-I17（#17）消息读面：契约**既有 3 条 operation** 的客户端消费回归（与社区同口径：
// 封套/实体形状/闭集/头部逐项核对，不符即 INVALID_RESPONSE；不新增契约、不发明字段）。
//   - `Message` 的键**恰为 7 项**，契约里没有 title/body/actor ⇒ 适配层不得靠猜补字段；
//   - 未读数是**派生量**：适配层只转发服务端每次现算的值，本地不维护计数器；
//   - real 未接线 ⇒ 503 `PROVIDER_UNAVAILABLE` 如实上报，**不得**被当成"空列表/暂无消息"。
// ---------------------------------------------------------------------------
const MESSAGE_ID = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
const loadMessages = (respond, options) => load(respond, 'miniprogram/utils/messages-api.js', options);
function msg(over = {}) {
  return {
    id: MESSAGE_ID, revision: 1, type: 'moderation', target_ref: { type: 'post', id: 'post-1', revision: 2 },
    reference_state: 'unavailable', read_at: null, created_at: '2026-10-16T04:00:00.000Z', ...over,
  };
}

test('消息：3 条契约 operation 的方法/路径/头部逐项正确（读路径无幂等键；写路径带幂等键与强 ETag）', async () => {
  const h = loadMessages((options) => {
    if (options.url.includes('/unread-count')) return { statusCode: 200, data: envelope({ count: 2 }) };
    if (options.method === 'PUT') return { statusCode: 200, data: envelope(msg({ revision: 2, read_at: '2026-10-16T05:00:00.000Z' })) };
    return { statusCode: 200, data: envelope({ items: [msg()], next_cursor: 'cursor-1' }) };
  });
  const page = await h.api.listMessages({ cursor: 'c1', limit: 20 });
  assert.equal(h.calls[0].method, 'GET');
  assert.equal(h.calls[0].url, 'http://127.0.0.1:4318/api/v1/messages?cursor=c1&limit=20');
  assert.equal(h.calls[0].header.authorization, 'Bearer synthetic-token');
  assert.equal(h.calls[0].header['Idempotency-Key'], undefined, '读路径不带幂等键');
  assert.equal(page.items.length, 1);
  assert.equal(page.nextCursor, 'cursor-1');
  assert.equal(page.mode, 'stub');
  assert.match(h.api.modeNote('stub'), /替身/);

  const unread = await h.api.getUnreadCount();
  assert.equal(h.calls[1].method, 'GET');
  assert.equal(h.calls[1].url, 'http://127.0.0.1:4318/api/v1/messages/unread-count', '未读数路径无查询参数');
  assert.equal(h.calls[1].header['Idempotency-Key'], undefined, '读路径不带幂等键');
  assert.equal(unread.count, 2);

  const marked = await h.api.markMessageRead(MESSAGE_ID, 1);
  const call = h.calls[2];
  assert.equal(call.method, 'PUT');
  assert.equal(call.url, 'http://127.0.0.1:4318/api/v1/messages/' + MESSAGE_ID + '/read');
  assert.equal(call.header['If-Match'], '"1"', 'If-Match 必须是目标当前强 ETag');
  assert.match(call.header['Idempotency-Key'], /^gyc-/);
  assert.ok(call.header['Idempotency-Key'].length >= 8 && call.header['Idempotency-Key'].length <= 128);
  assert.equal(call.data, undefined, '契约 markMessageRead 没有请求体');
  assert.equal(marked.message.read_at, '2026-10-16T05:00:00.000Z');
  assert.equal(marked.message.revision, 2);
});

test('消息：Message 键集恰 7 项／闭集／时间戳不符即 INVALID_RESPONSE（缺键、多键、闭集外）', async () => {
  const cases = [
    ['契约外字段（title）——契约 Message 没有 title/body/actor', msg({ title: '审核通过' })],
    ['缺 read_at', (() => { const m = msg(); delete m.read_at; return m; })()],
    ['type 不在闭集', msg({ type: 'promo' })],
    ['reference_state 不在闭集', msg({ reference_state: 'maybe' })],
    ['id 非 uuid', msg({ id: 'not-a-uuid' })],
    ['revision 非正整数', msg({ revision: 0 })],
    ['created_at 非法时间戳', msg({ created_at: '2026-10-16 04:00' })],
    ['read_at 非 null 且非时间戳', msg({ read_at: 'now' })],
    ['target_ref 缺 revision', msg({ target_ref: { type: 'post', id: 'post-1' } })],
    ['target_ref.type 不在 16 项闭集', msg({ target_ref: { type: 'poster', id: 'post-1', revision: 1 } })],
    ['无目标却声称 target 可用（服务端 fail-closed 不变式）', msg({ target_ref: null, reference_state: 'available' })],
  ];
  for (const [label, item] of cases) {
    const h = loadMessages(() => ({ statusCode: 200, data: envelope({ items: [item], next_cursor: null }) }));
    assert.equal((await rejects(h.api.listMessages({}))).code, 'INVALID_RESPONSE', label);
  }
  // 契约内的形状（无目标 + unavailable；已读 + 时间戳）必须被接受。
  const ok = loadMessages(() => ({
    statusCode: 200,
    data: envelope({ items: [msg({ target_ref: null, read_at: '2026-10-16T06:00:00.000Z', type: 'system' })], next_cursor: null }),
  }));
  const page = await ok.api.listMessages({});
  assert.equal(page.items[0].target_ref, null);
  assert.equal(page.items[0].reference_state, 'unavailable');
  // 同一页里重复 id 不得被静默接受（游标分页去重的契约纪律，与社区同口径）。
  const dup = loadMessages(() => ({ statusCode: 200, data: envelope({ items: [msg(), msg()], next_cursor: null }) }));
  assert.equal((await rejects(dup.api.listMessages({}))).code, 'INVALID_RESPONSE');
});

test('消息：未读数是派生量 ⇒ 只转发服务端值（本地不递减），角标文案 0 不显示、>99 显示 99+', async () => {
  const h = loadMessages((options) => options.url.includes('/unread-count')
    ? { statusCode: 200, data: envelope({ count: 5 }) }
    : { statusCode: 200, data: envelope(msg({ revision: 2, read_at: '2026-10-16T05:00:00.000Z' })) });
  assert.equal((await h.api.getUnreadCount()).count, 5);
  await h.api.markMessageRead(MESSAGE_ID, 1);
  // 标记已读不会在客户端"减一"：仍以服务端下一次现算为准（这里替身恒返回 5）。
  assert.equal((await h.api.getUnreadCount()).count, 5, '客户端不得维护本地未读计数器');
  assert.equal(h.calls.filter((call) => call.url.includes('/unread-count')).length, 2, '每次都重新读取服务端派生值');

  // count 形状不符即 INVALID_RESPONSE（不把 1.5/-1/"x" 当未读数）。
  for (const count of [1.5, -1, '2', null]) {
    const bad = loadMessages(() => ({ statusCode: 200, data: envelope({ count }) }));
    assert.equal((await rejects(bad.api.getUnreadCount())).code, 'INVALID_RESPONSE', String(count));
  }
  // 角标文案：0 不显示数字；>99 折叠为 99+（口径的唯一实现处）。
  assert.equal(h.api.unreadText(0), '');
  assert.equal(h.api.unreadText(1), '1');
  assert.equal(h.api.unreadText(99), '99');
  assert.equal(h.api.unreadText(100), '99+');
  assert.equal(h.api.unreadText(150), '99+');
});

test('消息：real 未接线 503 如实上报（绝不折叠成空列表），401/403 清会话，网络失败按 NETWORK_UNCERTAIN', async () => {
  const down = loadMessages(() => ({ statusCode: 503, data: errorEnvelope('PROVIDER_UNAVAILABLE') }));
  const listError = await rejects(down.api.listMessages({}));
  assert.equal(listError.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(down.api.unwired(listError), true, 'real 未接线必须可被页面识别为「服务未接线」');
  assert.match(down.api.stateTitle(listError), /未接线/);
  assert.match(down.api.message(listError), /未接线/);
  assert.doesNotMatch(down.api.message(listError), /暂无消息/, '未接线不得被说成「暂无消息」');
  assert.equal((await rejects(down.api.getUnreadCount())).code, 'PROVIDER_UNAVAILABLE');

  const unauthorized = loadMessages(() => ({ statusCode: 401, data: errorEnvelope('SESSION_REQUIRED') }));
  assert.equal((await rejects(unauthorized.api.listMessages({}))).code, 'SESSION_REQUIRED');
  assert.equal(unauthorized.cleared.count, 1, '401 必须清理本地会话，避免缓存被当成登录态');
  const forbidden = loadMessages(() => ({ statusCode: 403, data: errorEnvelope('SCOPE_DENIED') }));
  assert.equal((await rejects(forbidden.api.getUnreadCount())).code, 'SESSION_REQUIRED');
  assert.equal(forbidden.cleared.count, 1);
  assert.match(forbidden.api.message({ code: 'SCOPE_DENIED' }), /无权/, 'SCOPE_DENIED 文案沿用既有口径');

  const offline = loadMessages(() => ({ fail: true }));
  assert.equal((await rejects(offline.api.listMessages({}))).code, 'NETWORK_UNCERTAIN');
  assert.match(offline.api.message({ code: 'NETWORK_UNCERTAIN' }), /网络/);

  const malformed = loadMessages(() => ({ statusCode: 500, data: { unexpected: true } }));
  assert.equal((await rejects(malformed.api.listMessages({}))).code, 'INVALID_RESPONSE');

  // 未登录（无绑定）⇒ SESSION_REQUIRED 且**一次请求都不发**（门禁拦截口径）。
  const guest = loadMessages(() => ({ statusCode: 200, data: envelope({ items: [], next_cursor: null }) }), { loggedIn: false });
  assert.equal((await rejects(guest.api.listMessages({}))).code, 'SESSION_REQUIRED');
  assert.equal(guest.calls.length, 0, '未登录不得发出任何消息请求');
  assert.equal((await rejects(guest.api.getUnreadCount())).code, 'SESSION_REQUIRED');
  assert.equal(guest.calls.length, 0);
});

test('消息：入参预检（非法 uuid / revision）在本地即拒绝，不发请求', async () => {
  const h = loadMessages(() => ({ statusCode: 200, data: envelope(msg()) }));
  assert.equal((await rejects(h.api.markMessageRead('x', 1))).code, 'INVALID_INPUT');
  assert.equal((await rejects(h.api.markMessageRead(MESSAGE_ID, 0))).code, 'INVALID_INPUT');
  assert.equal((await rejects(h.api.markMessageRead(MESSAGE_ID, 1.5))).code, 'INVALID_INPUT');
  assert.equal(h.calls.length, 0, '本地拒绝不得发出任何请求');
});
