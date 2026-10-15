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

/** 让用例自行应答（`respond` 返回该哨兵时替身不代替用例回答）；既有用例不返回它，行为不变。 */
const DEFER = Symbol('defer');

/** 载入真实适配层；`respond` 决定每个请求的替身响应。 */
function load(respond) {
  const calls = [];
  const cleared = { count: 0 };
  const toasts = [];
  const routes = [];
  const auth = {
    isLoggedIn: () => true,
    getSession: () => ({ accessToken: 'synthetic-token', audience: 'user', expiresAt: '2099-01-01T00:00:00.000Z', executionMode: 'stub' }),
    sessionEpoch: () => '7:3',
    networkEnabled: () => true,
    clearSession: () => { cleared.count += 1 },
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
  vm.runInNewContext(readFileSync(resolve(root, 'miniprogram/utils/community-api.js'), 'utf8'), {
    module: box,
    wx,
    require: (id) => (id === './auth' ? auth : { apiBaseUrl: 'http://127.0.0.1:4318/api/v1' }),
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
// 切片 B2-1（Refs #15, Refs #14）：投稿页不得无条件宣称"已通过先行审核"。
//
// 断点（侦察实测）：`communitycreate.js` 的成功分支此前**无条件**
// `wx.showToast({ title: '已发布并通过先行审核', icon: 'success' })`；而服务端返回的
// `Post.audit_state` 可能是 `pending`/`quarantined`/`rejected`、`visibility` 也可能不是
// `published` —— 那句"已通过"是服务端没说过的话。
//
// 口径来源＝**既有**的正确实现，不另立第二套：
//   - 详情页 `communitydetail.js:105-108`：`publicLabel` = `published ∧ approved` ?
//     '已通过先行审核' : '未公开／待审'；`stateLabel` = hidden ? '已下架（仅本人可见）' :
//     (`published ∧ approved` ? '' : '待审／未公开')；
//   - 列表页 `community.js:130-133`：`stateLabel` 同判据、同措辞。
// 因此这里在同一个 vm 里装载**真实的**三页，用**同一份**服务端返回做对照：投稿页的提示必须与
// 详情页／列表页的作者侧标签（`stateLabel`）逐字一致，只有真正通过时才允许出现"已通过"。
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

/** 四种审核结论＋两种非公开组合：服务端返回什么，页面就说什么。 */
const AUDIT_CASES = [
  ['通过（published ∧ approved）', 'published', 'approved', '已通过先行审核', 'success'],
  ['待审（审核未结论）', 'published', 'pending', '待审／未公开', 'none'],
  ['隔离（quarantined）', 'published', 'quarantined', '待审／未公开', 'none'],
  ['拒绝（rejected）', 'published', 'rejected', '待审／未公开', 'none'],
  ['未公开（private ∧ approved）', 'private', 'approved', '待审／未公开', 'none'],
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
    { code: 'INPUT_UNCERTAIN' }],
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
