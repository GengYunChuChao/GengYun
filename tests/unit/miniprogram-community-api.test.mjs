/**
 * GY-I15（#15）阶段 2 · 小程序社区适配层的**契约消费回归**（Node + 模拟 wx）。
 *
 * 为什么需要：小程序侧无法在本仓库用真实微信编译器或真机验证（未取得），
 * 因此这里用 vm 载入**真实的** `miniprogram/utils/community-api.js`，把 `wx.request`
 * 换成受控替身，逐条核对：
 *   - 请求方法/路径/查询串/头部（`Idempotency-Key`、`If-Match: "<revision>"`）；
 *   - 成功封套只认 200/201，实体形状/闭集不符即 `INVALID_RESPONSE`（不"尽力解析"）；
 *   - 错误封套按契约错误码抛出，并保留规则层原因码（供页面如实展示"未通过审核"）；
 *   - 401 清本地会话并报 `SESSION_REQUIRED`；403 按契约码原样带出且**不**清会话
 *     （GY-I04 登录链路盘点后口径：403 是「登录了但不给你」，不是登录失效）；
 *     例外：`ACCOUNT_INACTIVE` 按统一层口径**清会话、码保留**（`auth.RETIRED_SESSION_CODES`，
 *     见 `tests/unit/miniprogram-auth-failure-attribution.test.mjs`）；
 *     非本会话世代的迟到响应被丢弃。
 *
 * 末节追加**页面口径**回归（切片 B2-1，Refs #15／#14）：把**真实**投稿页接到同一个真实适配层
 * 与合成 `wx` 上，核对 201 之后的提示只按服务端返回的 `visibility`/`audit_state` 如实给出，
 * 并与**真实**详情页／列表页的既有标注逐字对照（不另写一套期望文案）。门禁、真机渲染与
 * 真实审核能力不在该节范围（门禁另有 miniprogram-login-return-to.test.mjs 覆盖）。
 *
 * 边界：替身 `wx` 是**合成**的；本文件不证明页面视觉、真机或真实审核能力。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');
// GY-I04 登录链路盘点：401/403 归因的**真实**实现在 `miniprogram/utils/auth.js`（单一事实源）。
// 载入它是**纯函数**用法：`attribution()` 只读 `utils/states.js` 的码表，不碰存储、不发请求。
const realAuth = createRequire(import.meta.url)('../../miniprogram/utils/auth.js');

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

/** 让用例自行应答（`respond` 返回该哨兵时替身不代替用例回答）；既有用例不返回它，行为不变。 */
const DEFER = Symbol('defer');

/** 载入真实适配层；`respond` 决定每个请求的替身响应。`options.source` 只给负控制注入改动过的源码。 */
function load(respond, file = 'miniprogram/utils/community-api.js', options = {}) {
  const loggedIn = options.loggedIn !== false;
  const calls = [];
  const cleared = { count: 0 };
  const toasts = [];
  const routes = [];
  const auth = {
    isLoggedIn: () => loggedIn,
    getSession: () => loggedIn ? { accessToken: 'synthetic-token', audience: 'user', expiresAt: '2099-01-01T00:00:00.000Z', executionMode: 'stub' } : null,
    sessionEpoch: () => '7:3',
    networkEnabled: () => true,
    clearSession: () => { cleared.count += 1 },
    // 归因用**真实**实现（不在替身里另写一份码表）；只有「清会话」换成本用例的计数器，
    // 这样 401 清会话 / 403 不清会话的差异仍然被真实判定驱动、被本文件的计数器观测。
    attribution: (statusCode, payload) => realAuth.attribution(statusCode, payload),
    // 页面收口用的两个**委托**判定同样取真实实现（`community-api` 的 `sessionFailure` / `forbidden`
    // 只转发到这里，不在适配层另立码表）：闭集来自 `states.CODE_KIND`，不是本文件写的字面量。
    isSessionLossCode: (code) => realAuth.isSessionLossCode(code),
    isForbiddenCode: (code) => realAuth.isForbiddenCode(code),
    failureFor: (makeFailure, statusCode, payload) => {
      const a = realAuth.attribution(statusCode, payload);
      if (a.clearsSession) cleared.count += 1;
      const error = makeFailure(a.code);
      error.status = a.status;
      error.retryable = a.retryable;
      return error;
    },
  };
  const wx = {
    request(options) {
      calls.push(options);
      const result = respond(options, calls.length);
      if (result === DEFER) return;
      if (result && result.fail) { options.fail({ errMsg: 'synthetic network failure' }); return }
      options.success(result);
    },
    // 页面级用例：只记录，不外发（适配层本身不弹提示）。
    showToast(options) { toasts.push(options); },
  };
  const box = { exports: {} };
  // 适配层的**完整说明符登记表**（登记项逐字取自被加载源码里的 require）：
  // `miniprogram/utils/community-api.js:11` `require('./auth')`、`:12` `require('../config/runtime')`。
  // 改前是 `(id) => (id === './auth' ? auth : { apiBaseUrl: … })` 的 else 兜底 —— 适配层将来 require
  // 任何第三个模块（例如某个新 `./util`），都会被**静默喂成 runtime 替身**，用例仍绿、看着在测真实适配层。
  // 未登记 ⇒ 显式失败并带依赖名（沿用仓库既有口径）。已登记项取值与改前逐字相同。
  const dependencies = new Map([
    ['./auth', auth],
    ['../config/runtime', { apiBaseUrl: 'http://127.0.0.1:4318/api/v1' }],
  ]);
  vm.runInNewContext(options.source ?? readFileSync(resolve(root, file), 'utf8'), {
    module: box,
    wx,
    require: (id) => { if (!dependencies.has(id)) throw Error('Unexpected page dependency ' + id); return dependencies.get(id) },
  });
  return { api: box.exports, calls, cleared, toasts, routes, wx };
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

test('文案：422 INPUT_UNCERTAIN（审核隔离/未结论）与 503 PROVIDER_UNAVAILABLE 必须明确区分', async () => {
  // 契约实读（改本用例前先读这几行）：
  //   - 422 的允许错误码含 INPUT_UNCERTAIN：packages/contracts/states.json:137-141、services/api/src/contract.ts:22；
  //   - 社区域语义 = 审核域「隔离/未结论」（services/api/src/community/service.ts:389-396），
  //     与 400 INVALID_REQUEST 的「明确驳回」刻意分开（service.ts:373-381、:383-388 注释）；
  //   - 503 的允许错误码是 PROVIDER_UNAVAILABLE（states.json:149-150），语义 = 社区整域未接线真实存储；
  //   - `Retry-After` 只随 409/429/503 下发（packages/contracts/openapi.json:16733-16740）⇒ 422 不是"稍后再试"型。
  const isolated = load(() => ({
    statusCode: 422,
    data: errorEnvelope('INPUT_UNCERTAIN', [{ field: 'reason_codes', code: 'NOT_SCREENED' }]),
  }));
  const isolatedError = await rejects(isolated.api.createPost({ title: 't', body: 'b', media_ids: [] }));
  assert.equal(isolatedError.code, 'INPUT_UNCERTAIN', '错误码如实透传，不得被改写成别的码');
  assert.deepEqual(plain(isolated.api.reasonCodes(isolatedError)), ['NOT_SCREENED'], '契约 details 的原因码保留（供页面按需展示）');
  const isolatedText = isolated.api.message(isolatedError);
  assert.match(isolatedText, /审核|筛查|复核/, '422 必须收口到审核类提示');
  assert.match(isolatedText, /(不会公开|不会发布|不能发布|不得发布|暂不能发布)/, '必须如实说明本条不会被公开');
  assert.doesNotMatch(isolatedText, /暂不可用/, '422 不得冒充"服务暂不可用"（那是 503 的口径）');
  assert.doesNotMatch(isolatedText, /请(稍后)?重试|稍后再试|再试一次|重新提交/, '422 不得给出"重试即可"式暗示：重试注定同样结果');

  // 503 文案保持既有口径（见上一个用例的 /暂不可用/ 断言），且与 422 不是同一句。
  const down = load(() => ({ statusCode: 503, data: errorEnvelope('PROVIDER_UNAVAILABLE') }));
  const downError = await rejects(down.api.listPosts({}));
  assert.equal(downError.code, 'PROVIDER_UNAVAILABLE');
  assert.match(down.api.message(downError), /暂不可用/, '503 仍为"服务暂不可用"');
  assert.notEqual(isolatedText, down.api.message(downError), '422 与 503 不得共用同一句文案');
});

test('会话：401 清本地会话并报 SESSION_REQUIRED；403 原样带出且不清会话；网络失败按 SESSION_CHANGED 折叠', async () => {
  const unauthorized = load(() => ({ statusCode: 401, data: errorEnvelope('SESSION_REQUIRED') }));
  const error = await rejects(unauthorized.api.listPosts({}));
  assert.equal(error.code, 'SESSION_REQUIRED');
  assert.equal(unauthorized.cleared.count, 1, '401 必须清理本地会话，避免缓存被当成登录态');

  // GY-I04 登录链路盘点：403 SCOPE_DENIED 是「登录了，但这件事不给你」，不是登录失效。
  // 折叠成 SESSION_REQUIRED 并清会话会让用户被踢回登录页反复重登（B7 文档 :26-28 已判定的语义缺口）。
  const forbidden = load(() => ({ statusCode: 403, data: errorEnvelope('SCOPE_DENIED') }));
  assert.equal((await rejects(forbidden.api.getPost(POST_ID))).code, 'SCOPE_DENIED');
  assert.equal(forbidden.cleared.count, 0, '403 权限拒绝不得销毁仍然有效的会话');

  // 403 且封套读不到原因：仍按「服务端拒绝了，但没说原因」处理，不假装是登录问题。
  const bare = load(() => ({ statusCode: 403, data: {} }));
  assert.equal((await rejects(bare.api.getPost(POST_ID))).code, 'SCOPE_DENIED');
  assert.equal(bare.cleared.count, 0);

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
    ['target_ref.type 不在客户端闭集', msg({ target_ref: { type: 'poster', id: 'post-1', revision: 1 } })],
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

test('消息：real 未接线 503 如实上报（绝不折叠成空列表）；401 清会话、403 不折叠成「未登录」（ACCOUNT_INACTIVE 例外清会话）；网络失败按 NETWORK_UNCERTAIN', async () => {
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
  // 403 **不得**折叠成「请重新登录」（B7 口径：`utils/states.js` 明确要求 denied 与 guest 分开）。
  // 会话还在、只是这件事不给 ⇒ 不清会话 + 透出契约真实码；折叠会让用户反复登录仍过不去，
  // 也会让 `MESSAGES.SCOPE_DENIED` 成为永不执行的死字符串。
  const forbidden = loadMessages(() => ({ statusCode: 403, data: errorEnvelope('SCOPE_DENIED') }));
  assert.equal((await rejects(forbidden.api.getUnreadCount())).code, 'SCOPE_DENIED',
    '403 必须原样透出契约码，不得折叠成 SESSION_REQUIRED');
  assert.equal(forbidden.cleared.count, 0, '403 权限拒绝不得销毁仍然有效的会话（「登录了但不给」不是「没登录」）');
  // 统一层唯一例外（D1 口径）：`ACCOUNT_INACTIVE` 是「令牌永久失效」，码保留、会话清。
  const retired = loadMessages(() => ({ statusCode: 403, data: errorEnvelope('ACCOUNT_INACTIVE') }));
  assert.equal((await rejects(retired.api.getUnreadCount())).code, 'ACCOUNT_INACTIVE',
    'ACCOUNT_INACTIVE 必须保留码（不归一成 SESSION_REQUIRED）');
  assert.equal(retired.cleared.count, 1, 'ACCOUNT_INACTIVE 必须清会话（令牌不可再用）');
  assert.match(forbidden.api.message({ code: 'SCOPE_DENIED' }), /无权/, 'SCOPE_DENIED 文案沿用既有口径');
  assert.doesNotMatch(forbidden.api.message({ code: 'SCOPE_DENIED' }), /登录状态已失效/,
    '403 不得被说成「登录已失效」');

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

// ---------------------------------------------------------------------------
// 切片 B2-1（Refs #15, Refs #14）：投稿页不得无条件宣称"已通过先行审核"。
//
// 断点（侦察实测）：`communitycreate.js` 的成功分支此前**无条件**
// `wx.showToast({ title: '已发布并通过先行审核', icon: 'success' })`；而服务端返回的
// `Post.audit_state` 可能是 `pending`/`quarantined`/`rejected`、`visibility` 也可能不是
// `published` —— 那句"已通过"是服务端没说过的话。
//
// 口径来源＝**唯一一处**（`community-api.js` 的 `OUTCOMES` / `outcomeOf`），三页都从它取：
//   - 详情页 `_decoratePost`：`stateLabel` = 结论标签（通过时为空串，让 pill 落到 `publicLabel`），
//     `publicLabel` = 结论标签，`outcomeDesc` = 整句解释（「待人工复核」与「未通过」在这里分开）；
//   - 列表页 `_decorate`：`stateLabel` 同判据、同措辞；
//   - 投稿页：toast 用同一句结论标签。
// 因此这里在同一个 vm 里装载**真实的**三页，用**同一份**服务端返回做对照：三页必须逐字一致，
// 只有真正通过时才允许出现"已通过"。
// 注：本段改前登记的「口径来源」是既有三页各自的三元组（三档文案），该缺口已由
// fix/gy-r68-moderation-outcome-copy 收敛到单一来源——对照关系不变，只是来源换了位置。
// ---------------------------------------------------------------------------
const dataCache = new Map();
/** 真实数据目录（`miniprogram/data/*.js` 只做 `module.exports`，无 wx 依赖）。 */
function dataModule(name) {
  if (!dataCache.has(name)) {
    const box = { exports: {} };
    vm.runInNewContext(readFileSync(resolve(root, `miniprogram/data/${name}.js`), 'utf8'), { module: box });
    dataCache.set(name, box.exports);
  }
  return dataCache.get(name);
}

/**
 * 装载**真实页面**（投稿页／详情页／列表页）：接到同一份真实适配层与同一份合成 `wx`。
 * 门禁/字体/导航用最小替身：本用例只驱动提交流程本身，受保护页门禁另有单列用例覆盖。
 */
function loadPage(h, name) {
  const stubs = {
    '../../utils/community-api': h.api,
    '../../utils/auth': { requireLogin() {} },
    '../../utils/page-gate': { start() {}, cancel() {} },
    '../../utils/font-scale': { DEFAULT_FONT_SCALE: 1, applyFontScale() {}, currentFontScale() { return 1 } },
    '../../utils/navigation': {
      openTarget(url, resume, done) { h.routes.push({ url: url, resume: resume }); if (done) done(); },
    },
    '../../data/crops': dataModule('crops'),
    '../../data/regions': dataModule('regions'),
  };
  let definition = null;
  vm.runInNewContext(readFileSync(resolve(root, `miniprogram/pages/${name}/${name}.js`), 'utf8'), {
    Page: (value) => { definition = value; },
    wx: h.wx,
    require: (id) => {
      if (!Object.prototype.hasOwnProperty.call(stubs, id)) throw new Error('未预期的依赖：' + id);
      return stubs[id];
    },
  });
  assert.ok(definition && typeof definition === 'object', `${name} 未注册 Page`);
  const page = Object.assign({}, definition);
  page.data = Object.assign({}, definition.data);
  page.setData = function (patch) { Object.assign(this.data, patch); };
  return page;
}

/** 发起一次投稿提交（替身按 `DEFER` 不代替用例回答）：先钉住"服务端还没回话"的中间态。 */
function submit(h) {
  const page = loadPage(h, 'communitycreate');
  page.setData({ title: '稗草防除的一次记录', body: '按标签说明选择登记药剂。' });
  page.onSubmit();
  assert.equal(h.calls.length, 1, '提交必须真的发出请求（不得本地乐观成功）');
  const request = h.calls[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.url, 'http://127.0.0.1:4318/api/v1/posts');
  assert.ok(request.header['Idempotency-Key'].length >= 8, '写路径必须带幂等键');
  assert.equal(request.header['If-Match'], undefined, '创建不需要 If-Match');
  assert.deepEqual(plain(request.data), { title: '稗草防除的一次记录', body: '按标签说明选择登记药剂。', media_ids: [] });
  assert.deepEqual(h.toasts, [], '服务端回话之前不得预告任何结果');
  assert.deepEqual(h.routes, [], '服务端回话之前不得跳详情页');
  assert.equal(page.data.submitting, true);
  return page;
}

function flush() { return new Promise((resolve) => setImmediate(resolve)); }

/**
 * 六种服务端返回：页面必须按 `visibility`/`audit_state` 如实说，**且两种结论不许同形**。
 *
 * 改前这里六种的期望值只有三档措辞（通过 / 已下架 / 其余一律 `待审／未公开`），
 * 于是 `quarantined`（隔离待复核）与 `rejected`（明确驳回）对用户是同一句话。
 * 现在的口径见 `community-api.js` 的 `OUTCOMES`（唯一一处），本表只是它的期望值快照。
 */
const AUDIT_CASES = [
  ['通过（published ∧ approved）', 'published', 'approved', '已通过先行审核', 'success'],
  ['待审（审核未结论）', 'published', 'pending', '待审／未公开', 'none'],
  ['隔离待复核（quarantined）', 'published', 'quarantined', '待人工复核（未公开）', 'none'],
  ['明确驳回（rejected）', 'published', 'rejected', '未通过审核（未公开）', 'none'],
  ['未公开（private ∧ approved）', 'private', 'approved', '未公开（仅本人可见）', 'none'],
  ['已下架（hidden）', 'hidden', 'approved', '已下架（仅本人可见）', 'none'],
];
for (const [label, visibility, audit_state, expectedTitle, expectedIcon] of AUDIT_CASES) {
  test(`投稿页 B2-1：${label} ⇒ 按服务端返回如实提示，且与详情页／列表页标注逐字一致`, async () => {
    const h = load(() => DEFER);
    const page = submit(h);
    h.calls[0].success({ statusCode: 201, data: envelope(post({ visibility, audit_state })) });
    await flush();

    assert.equal(h.toasts.length, 1, '一次提交只应有一个结果提示');
    assert.equal(h.toasts[0].title, expectedTitle);
    assert.equal(h.toasts[0].icon, expectedIcon);
    assert.equal(page.data.submitting, false);
    assert.equal(page.data.errorText, '');
    assert.deepEqual(h.routes, [{ url: '/pages/communitydetail/communitydetail?id=' + POST_ID, resume: true }],
      '受理后仍进详情页（成功路径行为不回归）');

    // 同一份服务端返回，三个页面必须说同一件事（对照**既有**实现，而不是另写一套期望文案）。
    const item = post({ visibility, audit_state });
    const detail = loadPage(h, 'communitydetail')._decoratePost(item);
    const list = loadPage(h, 'community')._decorate([item])[0];
    assert.equal(detail.stateLabel, list.stateLabel, '详情页与列表页本就必须同口径');
    if (visibility === 'published' && audit_state === 'approved') {
      assert.equal(detail.publicLabel, '已通过先行审核');
      assert.equal(detail.stateLabel, '', '真正通过时详情页不显示失效标签');
      assert.equal(h.toasts[0].title, detail.publicLabel, '只有真正通过才可提示通过，且逐字等于详情页的公开标签');
    } else {
      assert.equal(h.toasts[0].title, detail.stateLabel, '与详情页作者侧标签逐字一致');
      assert.equal(h.toasts[0].title, list.stateLabel, '与列表页作者侧标签逐字一致');
      assert.doesNotMatch(h.toasts[0].title, /已通过/, '未通过审核时不得出现"已通过"');
      assert.doesNotMatch(JSON.stringify(page.data), /已通过/, '页面整体（含 errorText）不得出现"已通过"');
    }
  });
}

/** 失败路径：错误码路径仍只走 `errorText`（页面不得改成"已通过"式成功提示）。 */
const FAILURE_CASES = [
  ['422 审核隔离／未结论', { statusCode: 422, data: errorEnvelope('INPUT_UNCERTAIN', [{ field: 'reason_codes', code: 'NOT_SCREENED' }]) },
    { code: 'INPUT_UNCERTAIN', details: ['NOT_SCREENED'] }],
  ['400 明确驳回', { statusCode: 400, data: errorEnvelope('INVALID_REQUEST', [{ field: 'reason_codes', code: 'DANGEROUS_MIX' }]) },
    { code: 'INVALID_REQUEST', details: ['DANGEROUS_MIX'] }],
  ['409 目标不可用', { statusCode: 409, data: errorEnvelope('OBJECT_UNAVAILABLE') }, { code: 'OBJECT_UNAVAILABLE' }],
  ['503 未接线真实存储', { statusCode: 503, data: errorEnvelope('PROVIDER_UNAVAILABLE') }, { code: 'PROVIDER_UNAVAILABLE' }],
];
for (const [label, reply, error] of FAILURE_CASES) {
  test(`投稿页 B2-1 失败路径不回归：${label} ⇒ 只展示适配层的如实文案，不弹任何成功提示`, async () => {
    const h = load(() => DEFER);
    const page = submit(h);
    h.calls[0].success(reply);
    await flush();
    assert.deepEqual(h.toasts, [], '未被受理时不得弹任何提示');
    assert.deepEqual(h.routes, [], '未被受理时不得跳详情页');
    assert.equal(page.data.submitting, false);
    assert.equal(page.data.errorText, h.api.message(error), '页面展示的就是适配层的如实文案');
    assert.doesNotMatch(page.data.errorText, /已通过/);
  });
}
test('投稿页 B2-1 失败路径不回归：网络未能确认时同样不弹成功提示', async () => {
  const h = load(() => DEFER);
  const page = submit(h);
  h.calls[0].fail({ errMsg: 'synthetic network failure' });
  await flush();
  assert.deepEqual(h.toasts, []);
  assert.deepEqual(h.routes, []);
  assert.equal(page.data.submitting, false);
  assert.equal(page.data.errorText, h.api.message({ code: 'NETWORK_UNCERTAIN' }));
  assert.doesNotMatch(page.data.errorText, /已通过/);
});
// 负控制：登记的说明符是**完整且唯一**的。把真实适配层源码的两条 require 换成相近写法后重跑
// **本站点自己的**装载器（`load()` 第三参 `options.source`）⇒ 必须显式失败并带原名，不得近似命中。
// 改前是 `(id) => (id === './auth' ? auth : { apiBaseUrl: … })` 的 else 兜底：除 `'./auth'` 外的**任何**
// 说明符（含适配层将来新增的第三个依赖）都会被**静默喂成 runtime 替身** —— "看着在测真实适配层，
// 其实依赖拿了替身"，用例照样绿。
test('适配层未登记说明符：显式失败并带名，零近似命中', () => {
  const apiSource = readFileSync(resolve(root, 'miniprogram/utils/community-api.js'), 'utf8');
  const respond = () => ({ statusCode: 200, data: envelope({ items: [], next_cursor: null }) });
  const withSpec = (from, spec) => apiSource.replace(from, "require('" + spec + "')");
  assert.ok(apiSource.includes("const auth = require('./auth')") && apiSource.includes("require('../config/runtime')"),
    '真实源码的 require 说明符变了，登记表须同步');
  assert.doesNotThrow(() => load(respond, undefined, { source: apiSource }), '已登记项必须照常装载');
  for (const spec of ['./auth.js', './Auth', './utils/auth', './auth/', '../utils/auth']) {
    assert.throws(() => load(respond, undefined, { source: withSpec("require('./auth')", spec) }),
      new RegExp('Unexpected page dependency ' + spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
      '近似说明符 ' + spec + ' 未被显式拒绝');
  }
  for (const spec of ['../config/runtime.js', './runtime', '../../config/runtime']) {
    assert.throws(() => load(respond, undefined, { source: withSpec("require('../config/runtime')", spec) }),
      new RegExp('Unexpected page dependency ' + spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
      '近似说明符 ' + spec + ' 未被显式拒绝');
  }
});

// ---------------------------------------------------------------------------
// 片C（Refs #19）：社区帖子/评论「已注销用户」前端展示面 —— 默认头像 + 「已注销用户」显示
// + 正文脱敏投影，与已合服务端（`community/authors.ts::anonymize`、`community/personal-info.ts`、
// `community/purge.ts` 的 `anonymized_author_ref`）对齐。
//
// 服务端去身份后的数据形状（本片不改服务端，只按契约消费）：
//   - 注销作者：`display_name='已注销用户'`、`state='anonymized'`、`avatar_media_id=null`、
//     `avatar_media=null`；`display_id` 是 `gy-anon-<16hex>`（内部引用，前台**不展示**）；
//   - 正文个人信息被替换为 `_[个人信息已清除]_`，不能可靠脱敏的媒体 `media_ids` 被移除。
// 本片断言的只是**展示投影**（单一实现 `community-api.authorView` + 三个页面的 `_decorate*`），
// 不把服务端行为复制到客户端；真机/微信工具渲染未取得（本仓库无真实微信编译器）。
// ---------------------------------------------------------------------------
function anonAuthor() {
  return { display_name: '已注销用户', display_id: 'gy-anon-0123456789abcdef', state: 'anonymized', avatar_media_id: null, revision: 1, avatar_media: null };
}

test('片C authorView：注销作者投影为「已注销用户」+ 固定默认头像；活跃假名取显示名首字', () => {
  const h = load(() => ({ statusCode: 200, data: envelope({ items: [], next_cursor: null }) }));
  assert.deepEqual(plain(h.api.authorView(anonAuthor())), { name: '已注销用户', anonymized: true, avatar: '已' });
  assert.deepEqual(plain(h.api.authorView(author())), { name: '耕云用户abcd', anonymized: false, avatar: '耕' });
});

test('片C 列表/详情/评论投影：注销作者显示「已注销用户」+ 默认头像，正文脱敏占位原样透传、不投影附件', async () => {
  const h = load(() => DEFER);
  const anonPost = post({ author: anonAuthor(), body: '联系电话：_[个人信息已清除]_，欢迎交流。' });
  const list = loadPage(h, 'community')._decorate([anonPost])[0];
  assert.equal(list.author, '已注销用户');
  assert.equal(list.authorAvatar, '已');
  assert.equal(list.authorAnonymized, true);
  assert.equal(list.body, '联系电话：_[个人信息已清除]_，欢迎交流。');
  assert.equal('media_ids' in list, false, '附件引用不得进入展示投影');
  assert.equal('authorState' in list, false, '旧的死字段 authorState 已被 authorAvatar/authorAnonymized 取代');

  const detail = loadPage(h, 'communitydetail')._decoratePost(anonPost);
  assert.equal(detail.author, '已注销用户');
  assert.equal(detail.authorAvatar, '已');
  assert.equal(detail.authorAnonymized, true);
  assert.equal(detail.body, '联系电话：_[个人信息已清除]_，欢迎交流。');

  const row = loadPage(h, 'communitydetail')._decorateComments([comment({ author: anonAuthor(), body: '也遇到过，手机 13800000000。' })])[0];
  assert.equal(row.author, '已注销用户');
  assert.equal(row.authorAvatar, '已');
  assert.equal(row.authorAnonymized, true);
  assert.equal(row.body, '也遇到过，手机 13800000000。');
});

test('片C 负控制：活跃作者的展示投影不出现任何「已注销」标记', async () => {
  const h = load(() => DEFER);
  const list = loadPage(h, 'community')._decorate([post()])[0];
  assert.equal(list.author, '耕云用户abcd');
  assert.equal(list.authorAvatar, '耕');
  assert.equal(list.authorAnonymized, false);
  const row = loadPage(h, 'communitydetail')._decorateComments([comment()])[0];
  assert.equal(row.author, '耕云用户abcd');
  assert.equal(row.authorAnonymized, false);
});

// ---------------------------------------------------------------------------
// 切片 S5（fix/gy-r68-moderation-outcome-copy）：用户侧必须能分清
// 「隔离待复核（quarantined）」与「明确驳回（rejected）」。
//
// 断点（侦察 S3，本次逐条复核）：
//   - `Post`/`Comment` 契约只有四值 `audit_state`（`packages/contracts/openapi.json` 的
//     `AuditState`），用户侧却只有**三档**文案（通过 / 已下架 / 其余一律 `待审／未公开`）
//     ⇒ `quarantined` 与 `rejected` 同形，且被驳回的还被告知「待审」；
//   - 服务端**是**给理由码的：`community/service.ts` 的 `domainRefusal()`（400，明确驳回）与
//     `domainIsolation()`（422，隔离）都把 `reason_codes` 逐条塞进 `details[].code`
//     （`field: 'reason_codes'`）；改前客户端只在一处把码拼成英文裸码（`原因码：A、B`），
//     422 那条根本不带码 ⇒ 用户读不到任何可理解的理由。
//
// 本段四例只测**展示层**（不改服务端判定、不改契约）：
//   ① 隔离 ⇒ 出现「复核 / 稍后再看」类文案，**不出现**「未通过」；
//   ② 驳回 + 已知理由码 ⇒ 出现该码的人话（并保留原码便于对账，不是英文裸码单传）；
//   ③ 驳回 + 未知理由码 ⇒ 「未知原因（码：X）」，不许说成通过、也不许说成系统错误；
//   ④ 负控制：把两种结论映射成同一句文案 ⇒ ① / ② 必红（证明上面三条有牙）。
// ---------------------------------------------------------------------------

test('① 隔离待复核（quarantined）⇒ 详情页说「等待复核 / 稍后再看」，且不出现「未通过」', async () => {
  const h = load((request, index) => index === 1
    ? { statusCode: 200, data: envelope(post({ audit_state: 'quarantined', visibility: 'published' })) }
    : { statusCode: 200, data: envelope({ items: [], next_cursor: null }) });
  const page = loadPage(h, 'communitydetail');
  page.onLoad({ id: POST_ID });
  // 本文件的 `page-gate` 替身**不**回调（门禁语义另有用例覆盖），这里直接驱动读路径。
  page.load();
  await flush();
  assert.equal(page.data.status, 'ready');
  assert.equal(page.data.post.outcomeKey, 'quarantined', '隔离必须有自己的结论标识，不得折成 pending/rejected');
  assert.match(page.data.post.stateLabel, /复核/, '隔离必须明确说「复核」（不是只说「待审」）');
  assert.doesNotMatch(page.data.post.stateLabel, /未通过/, '隔离**还没有结论**，不得说成「未通过」');
  assert.match(page.data.post.outcomeDesc, /稍后再来看/, '隔离要给出「稍后再看」的期待');
  assert.match(page.data.post.outcomeDesc, /人工复核/);
  assert.doesNotMatch(page.data.post.outcomeDesc, /未通过/, '隔离的整句解释里不得出现驳回口径');

  // 页面必须把这句话真的渲染出来（模板绑定就是断言来源，不在用例里另写一份期望）。
  const wxml = readFileSync(resolve(root, 'miniprogram/pages/communitydetail/communitydetail.wxml'), 'utf8');
  assert.match(wxml, /\{\{post\.outcomeDesc\}\}/, '详情页没有渲染审核结论的整句解释');
});

test('② 明确驳回（rejected）+ 已知理由码 ⇒ 出现该码的人话，且保留原码便于对账', async () => {
  const h = load(() => DEFER);
  const page = submit(h);
  h.calls[0].success({ statusCode: 400, data: errorEnvelope('INVALID_REQUEST', [{ field: 'reason_codes', code: 'DANGEROUS_MIX' }]) });
  await flush();

  assert.equal(h.toasts.length, 0, '被驳回时不得弹成功提示');
  assert.deepEqual(h.routes, [], '被驳回时不得跳详情页');
  assert.equal(page.data.errorCode, 'INVALID_REQUEST');
  assert.match(page.data.errorText, /明确驳回/, '400 必须说清这是「明确驳回」结论');
  assert.match(page.data.errorText, /危险混配/, '已知理由码必须翻成人话（不得只给英文裸码）');
  assert.match(page.data.errorText, /码：DANGEROUS_MIX/, '人话之外保留原码，便于用户与客服对账');
  assert.doesNotMatch(page.data.errorText, /未知原因/, '已知码不得落到未知码兜底');
  assert.doesNotMatch(page.data.errorText, /已通过/, '驳回不得说成通过');
  assert.doesNotMatch(page.data.errorText, /系统错误/, '驳回是结论，不是故障');

  // 同一张表也驱动**渲染面**（详情页 pill），不是报错时临时拼一句。
  const detail = loadPage(h, 'communitydetail')._decoratePost(post({ audit_state: 'rejected' }));
  assert.equal(detail.outcomeKey, 'rejected');
  assert.match(detail.stateLabel, /未通过/);
  assert.doesNotMatch(detail.stateLabel, /复核/, '驳回不得说成「待复核」（用户会一直等一个不会来的复核）');
});

test('③ 明确驳回（rejected）+ 未知理由码 ⇒ 「未知原因（码：X）」，不得说成通过或系统错误', async () => {
  const h = load(() => DEFER);
  const page = submit(h);
  h.calls[0].success({ statusCode: 400, data: errorEnvelope('INVALID_REQUEST', [{ field: 'reason_codes', code: 'SOMETHING_NEW_IN_2027' }]) });
  await flush();

  assert.equal(page.data.errorCode, 'INVALID_REQUEST');
  assert.match(page.data.errorText, /未知原因（码：SOMETHING_NEW_IN_2027）/, '未知码必须如实说「未知原因」并带原码');
  assert.doesNotMatch(page.data.errorText, /已通过|审核通过/, '未知码不得被说成通过');
  assert.doesNotMatch(page.data.errorText, /系统错误|服务端故障/, '未知码不得被说成系统错误（那会把审核结论说成故障）');

  // 兜底也是**单一实现**：适配层对任何没登记的码都给同一句，页面不各自兜底。
  assert.equal(h.api.reasonLabel('SOMETHING_NEW_IN_2027'), '未知原因（码：SOMETHING_NEW_IN_2027）');
  assert.equal(h.api.reasonLabel('DANGEROUS_MIX'), '疑似危险混配（处方混配或超量用药）（码：DANGEROUS_MIX）');
  // 表本身冻结：页面/调用方不能就地篡改口径。
  assert.equal(Object.isFrozen(h.api.OUTCOMES), true);
  assert.equal(Object.isFrozen(h.api.OUTCOMES.quarantined), true);
  assert.equal(Object.isFrozen(h.api.REASON_LABELS), true);
});

test('④ 负控制：把两种结论映射成同一句文案 ⇒ ① 与 ② 的判据必红', async () => {
  const apiSource = readFileSync(resolve(root, 'miniprogram/utils/community-api.js'), 'utf8');
  // 突变点必须逐字存在，否则负控制会退化成空转（源码一改，本用例会先在这里红）。
  const mutationPoint = "  if (auditState === 'quarantined') return OUTCOMES.quarantined";
  assert.equal(apiSource.includes(mutationPoint), true,
    '负控制的突变点不存在了：`outcomeOf` 的隔离分支被改写 ⇒ 请同步本用例（⛔ 不要删掉这条负控制）。');
  const collapsed = apiSource.replace(mutationPoint, "  if (auditState === 'quarantined') return OUTCOMES.rejected");
  assert.notEqual(collapsed, apiSource, '突变没有生效（源码未变）');

  const h = load(() => DEFER, undefined, { source: collapsed });
  // 两种状态此时被映射成同一句 ⇒ ① 的「不得出现未通过」当场不成立。
  const quarantined = loadPage(h, 'communitydetail')._decoratePost(post({ audit_state: 'quarantined' }));
  const rejected = loadPage(h, 'communitydetail')._decoratePost(post({ audit_state: 'rejected' }));
  assert.equal(quarantined.stateLabel, rejected.stateLabel, '负控制前提：突变后两者文案确实合并成了一句');
  assert.match(quarantined.stateLabel, /未通过/,
    '突变后隔离被说成「未通过」⇒ ① 的 doesNotMatch(/未通过/) 必红，说明 ① 有牙');
  assert.equal(quarantined.outcomeKey, 'rejected', '突变后结论标识也合并 ⇒ ② 的 outcomeKey 断言必红');

  // 反向确认：未突变的真实源码下两者不同（否则 ① / ② 就是假绿）。
  const real = load(() => DEFER);
  assert.notEqual(
    loadPage(real, 'communitydetail')._decoratePost(post({ audit_state: 'quarantined' })).stateLabel,
    loadPage(real, 'communitydetail')._decoratePost(post({ audit_state: 'rejected' })).stateLabel,
    '真实源码下隔离与驳回的文案必须不同',
  );
});

// ---------------------------------------------------------------------------
// 独立审查 7d27727d 的阻塞项：`hidden` **不是**终态判据。
//
// 服务端读面（`community/service.ts:583-616` 的 `effectiveState`）把「已发布后被驳回/被隔离」
// 一律降成 `hidden` 并**原样带 `audit_state`**：迟到驳回 ⇒ `{hidden, rejected}`，
// 迟到隔离/未结论 ⇒ `{hidden, quarantined}`；`listPosts(mine=true)` 包含未公开版本
// ⇒ 作者在自己的列表/详情里真的看得到。本片第一版先判 `hidden` 就返回
// 「已下架（仅本人可见）」⇒ 这两种又被折成同一句、且一个理由都不给（只是把「两态同形」
// 从「待审」挪到了「已下架」）。⑤⑥⑦ 就是把这条路钉住。
// ---------------------------------------------------------------------------

const OTHER_COMMENT_ID = '44444444-4444-4444-8444-444444444444';

test('⑤ {hidden,rejected} 与 {hidden,quarantined} 不得同形（帖子与评论两条通道）', () => {
  const h = load(() => DEFER);
  const detail = loadPage(h, 'communitydetail');
  const rejected = detail._decoratePost(post({ visibility: 'hidden', audit_state: 'rejected' }));
  const quarantined = detail._decoratePost(post({ visibility: 'hidden', audit_state: 'quarantined' }));

  assert.equal(rejected.outcomeKey, 'hidden_rejected');
  assert.equal(quarantined.outcomeKey, 'hidden_quarantined');
  assert.notEqual(rejected.stateLabel, quarantined.stateLabel, '下架+驳回 与 下架+隔离 的标签必须不同');
  assert.notEqual(rejected.outcomeDesc, quarantined.outcomeDesc, '整句解释也必须不同');
  assert.match(rejected.stateLabel, /未通过/, '下架+驳回 必须说「未通过」（用户得知道不会再等）');
  assert.doesNotMatch(rejected.stateLabel, /复核/, '下架+驳回 不得说成「复核」');
  assert.match(quarantined.stateLabel, /复核/, '下架+隔离 必须说「复核」');
  assert.doesNotMatch(quarantined.stateLabel, /未通过/, '下架+隔离 不得说成「未通过」');
  assert.match(quarantined.outcomeDesc, /稍后再来看/, '下架+隔离 要给出「稍后再看」的期待');

  // 列表页对同一份数据必须说同一句话（跨页一致性）。
  const list = loadPage(h, 'community')._decorate([
    post({ visibility: 'hidden', audit_state: 'rejected' }),
    post({ visibility: 'hidden', audit_state: 'quarantined' }),
  ]);
  assert.equal(list[0].stateLabel, rejected.stateLabel);
  assert.equal(list[1].stateLabel, quarantined.stateLabel);

  // 评论：同一套分档，措辞换成「已隐藏」。改前两种都是「已隐藏（仅本人可见）」。
  const rows = detail._decorateComments([
    comment({ id: COMMENT_ID, visibility: 'hidden', audit_state: 'rejected' }),
    comment({ id: OTHER_COMMENT_ID, visibility: 'hidden', audit_state: 'quarantined' }),
  ]);
  assert.notEqual(rows[0].stateLabel, rows[1].stateLabel, '评论的两种下架结论也不得同形');
  assert.match(rows[0].stateLabel, /已隐藏/);
  assert.match(rows[0].stateLabel, /未通过/);
  assert.match(rows[1].stateLabel, /已隐藏/);
  assert.match(rows[1].stateLabel, /复核/);

  // 下架本身仍能单独说清（下架是处置动作，不等于审核不通过）。
  const plain = detail._decoratePost(post({ visibility: 'hidden', audit_state: 'approved' }));
  assert.equal(plain.stateLabel, '已下架（仅本人可见）');
  assert.equal(plain.outcomeKey, 'hidden');
});

test('⑥ 理由码接进结论文案：给了就翻人话，没给就只说结论（不编理由）', () => {
  const h = load(() => DEFER);
  const target = post({ visibility: 'hidden', audit_state: 'rejected' });

  // 读面拿不到码（契约 Post 没有理由码字段）⇒ 只说结论，**一个理由都不许编**。
  const without = h.api.outcomeOf(target);
  assert.doesNotMatch(without.desc, /原因：|未知原因|（码：/, '没有理由码时不得凭空写原因');
  assert.match(without.desc, /未通过/);

  // 调用方手上有码（现存的唯一通道：错误封套 details[].code）⇒ 翻成人话挂上去，结论不变。
  const withCode = h.api.outcomeOf(target, { reasonCodes: ['DANGEROUS_MIX', 'PRIVACY_PII'] });
  assert.equal(withCode.key, without.key, '理由码不得改变结论本身');
  assert.equal(withCode.title, without.title);
  assert.match(withCode.desc, /原因：/);
  assert.match(withCode.desc, /危险混配/);
  assert.match(withCode.desc, /码：DANGEROUS_MIX/);
  assert.match(withCode.desc, /隐私信息/);
  assert.doesNotMatch(withCode.desc, /未知原因/, '已知码不得落未知码兜底');

  // 隔离/待审用「审核侧说明：」——同一批码在这两处含义不同，不许混说。
  const quarantined = h.api.outcomeOf(post({ audit_state: 'quarantined' }), { reasonCodes: ['MODEL_NOT_EVALUATED'] });
  assert.match(quarantined.desc, /审核侧说明：/);
  assert.doesNotMatch(quarantined.desc, /原因：/);

  // 审查指出闭集漏项中**真实可达**的 6 条，必须有人话而不是兜底。
  for (const code of ['MODEL_QUOTA_EXCEEDED', 'MODEL_AUTH_FAILED', 'MODEL_LAYER_INPUT_BINDING_MISMATCH',
    'MODEL_LAYER_INVARIANT_VIOLATION', 'MODEL_MERGE_INPUT_INVALID', 'RULE_CATALOG_INVALID']) {
    assert.doesNotMatch(h.api.reasonLabel(code), /未知原因/, code + ' 必须有人话，不得落兜底');
  }

  // 冻结：withReasons 返回新对象，表里那条原条目不被就地追加污染。
  assert.equal(Object.isFrozen(without), true);
  assert.notEqual(h.api.HIDDEN_OUTCOMES.rejected.desc, withCode.desc);
  assert.equal(h.api.HIDDEN_OUTCOMES.rejected.desc, without.desc, '表里的原条目不得被追加内容污染');
});

test('⑦ 负控制：hidden 路径把两态折回同一句 ⇒ ⑤ 必红', () => {
  const apiSource = readFileSync(resolve(root, 'miniprogram/utils/community-api.js'), 'utf8');
  const mutationPoint = "  if (auditState === 'rejected') return HIDDEN_OUTCOMES.rejected\n"
    + "  if (auditState === 'quarantined') return HIDDEN_OUTCOMES.quarantined";
  assert.equal(apiSource.includes(mutationPoint), true,
    '负控制的突变点不存在了：`hiddenOutcomeOf` 的两条分支被改写 ⇒ 请同步本用例（⛔ 不要删掉这条负控制）。');
  const collapsed = apiSource.replace(mutationPoint,
    "  if (auditState === 'rejected') return HIDDEN_OUTCOMES.plain\n"
    + "  if (auditState === 'quarantined') return HIDDEN_OUTCOMES.plain");
  assert.notEqual(collapsed, apiSource, '突变没有生效（源码未变）');

  const h = load(() => DEFER, undefined, { source: collapsed });
  const detail = loadPage(h, 'communitydetail');
  const rejected = detail._decoratePost(post({ visibility: 'hidden', audit_state: 'rejected' }));
  const quarantined = detail._decoratePost(post({ visibility: 'hidden', audit_state: 'quarantined' }));
  assert.equal(rejected.stateLabel, quarantined.stateLabel, '负控制前提：折叠后两者确实同句');
  assert.doesNotMatch(rejected.stateLabel, /未通过/, '折叠后「未通过」消失 ⇒ ⑤ 的 match(/未通过/) 必红');
  assert.doesNotMatch(quarantined.stateLabel, /复核/, '折叠后「复核」消失 ⇒ ⑤ 的 match(/复核/) 必红');
  assert.equal(rejected.outcomeKey, quarantined.outcomeKey, '折叠后结论标识也合并 ⇒ ⑤ 的 outcomeKey 断言必红');
});

// ---------------------------------------------------------------------------
// ⑧ 理由码表**不许自造**：每个键都必须来自仓库既有闭集（或本域专有的 3 条 + 前缀族）。
//
// 这条是「人话表」的防漂移闸：以后谁想加一条码，必须先在 `packages/moderation` 的闭集里
// 有它（或写进下面这张显式白名单并说明出处），否则就是**编了一个服务端不会给的码**。
// 白名单逐条有据（都由服务端在社区读面上产出，见 `community/service.ts`）：
//   - `IMAGE_MODERATION_UNAVAILABLE`：`:426` 定义、`:632` 追加进 details；
//   - `MEDIA_NOT_EVALUATED_BY_RULE_LAYER`：`:429`（规则层不评估媒体的跨片声明码）；
//   - `RESCREEN_REQUIRED`：`moderation/visibility.ts:36`（读面「需重新审核」）。
// 前缀族 `NOT_SCREENED:<kind>`：`moderation/service.ts:913`。
// ---------------------------------------------------------------------------
test('⑧ 理由码表不自造：键集合 ⊆ 服务端闭集 ∪ 三条本域专有码，且前缀族只登记一处', async () => {
  const constants = await import('../../packages/moderation/constants.mjs');
  const modelCodes = await import('../../packages/moderation/model-reason-codes.mjs');
  const closed = new Set([
    ...constants.RULE_REASON_CODES,
    ...constants.FAIL_CLOSED_REASON_CODES,
    ...modelCodes.MODEL_REASON_CODES,
  ]);
  const SERVICE_SPECIFIC = ['IMAGE_MODERATION_UNAVAILABLE', 'MEDIA_NOT_EVALUATED_BY_RULE_LAYER', 'RESCREEN_REQUIRED'];

  const h = load(() => DEFER);
  const invented = Object.keys(h.api.REASON_LABELS)
    .filter((code) => !closed.has(code) && SERVICE_SPECIFIC.indexOf(code) === -1);
  assert.deepEqual(invented, [], '理由码表里出现了服务端闭集之外的码（等于编了一个不会来的码）');

  // 反向：闭集里的码**不必**全有人话（漏的落「未知原因（码：X）」是可接受的兜底），但已知码必须真的翻出人话。
  for (const code of SERVICE_SPECIFIC) {
    assert.equal(Object.prototype.hasOwnProperty.call(h.api.REASON_LABELS, code), true, code + ' 必须有对应人话');
    assert.doesNotMatch(h.api.reasonLabel(code), /未知原因/);
  }
  // 前缀族只登记一条，且拼法仍是同一个 `withCode`（`（码：X）`）。
  assert.equal(h.api.reasonLabel('NOT_SCREENED:text'), '这一版内容没有完成送审（码：NOT_SCREENED:text）');
  assert.match(h.api.reasonLabel('NOT_SCREENED'), /（码：NOT_SCREENED）/);
});
