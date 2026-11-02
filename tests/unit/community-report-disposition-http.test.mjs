/**
 * R72 · 举报处置的 **HTTP 接线** 回归（本文件全新增，不改任何既有断言）。
 *
 * 被测链路（真实 `buildApp`，不 mock 路由/服务/外壳）：
 *   `POST /admin/reports/{id}/disposition` → 守卫（`requireAdmin` + `requireScope('sources:write')`）
 *   → `admin/ops/service.ts::advanceReport`（`runIdempotentWrite` 包一层幂等）
 *   → `admin/ops/community-posts.ts::createReportDispositionAdapter`
 *   → `CommunityService.advanceReport`（转移表 `community/report-state.ts` + CAS `commitReportIfCurrent`）。
 *
 * 钉住七件事（T1–T7，对应派单 §1.6）：
 *  T1 正控制：`received` + `triage` ⇒ 200、`revision` 恰好 +1、封套 `data` 是契约 `Report`、`meta` 齐全；
 *  T2 非法转移：`isolated` + `reject` ⇒ 409（**而不是**静默成功或 500），库内一字未变；
 *  T3 版本失配：`expected_revision` 落后 ⇒ 409，且**库内 state/revision 一字未变**（CAS 不是无条件写）；
 *  T4 终态单向门：`closed` 上再处置 ⇒ 409（话术与 `advanceReport` 现有分支逐字一致），库内不变；
 *  T5 守卫：无会话 ⇒ 401；有 admin 但缺 `sources:write` ⇒ 403，**两种都零写入**；
 *  T6 零副作用钉：处置**不写审计行**、**不动目标帖的可见性**（行内读数逐字不变）；
 *  T7 契约钉子：「契约里真的有这条 op、而且形状是本片要的那个形状」（不是读实现猜）。
 *
 * ## 为什么 T2 用 `isolated + reject`
 *
 * 派单原文写的是「`received → closed`（`resolve` 直接从 `received`）按 `report-state.ts` 的规则拒绝」，
 * 但仓库事实相反：`community/report-state.ts` 的转移表是
 * `resolve.from = ['received', 'isolated']`（待受理也可以直接处置完毕），**不是**非法转移。
 * 本片以仓库为准，取真正非法的那条：`reject.from = ['received']` ⇒ `isolated + reject` 是
 * `ILLEGAL_TRANSITION`。差异已登记进交付报告。
 *
 * ## 与 `hidePost` 的两处刻意差异（本片如实登记，不是遗漏）
 *
 *  1. **不落审计行**：`post.hide` 的审计要么走库层同一事务（迁移），要么走内存台账；本片两样都不做
 *     ——要落审计得先扩 `admin/audit/catalog.ts` 的 `AUDIT_ACTIONS` 闭集（+ 迁移 +
 *     `20-login-roles.sql` / `90-assert-least-privilege.sql` 三处同步），属迁移片另批。
 *     T6 把「审计写入次数 === 0」钉成**事实**，免得后来者以为只是没写。
 *  2. **不改社区可见性**：处置只推进举报行自己的 `state`/`revision`
 *     （`community/store-pg.ts:563-564` 自述"只写 revision/state 两列，不需要新增 GRANT"），
 *     目标内容是否进隔离/下架归审核与下架链路。T6 用「目标帖行内读数逐字不变」钉住。
 *
 * ⚠ 本文件**不**证明真库行为：存储是内存实现（`persistent: false`）。真库臂在
 * `tests/integration/community-pg.mjs`（需 `COMMUNITY_PG_TEST_URL`，缺库记 77）。
 * ⚠ 本文件**不**证明 `closed` 的两种含义（成立 / 驳回）可区分：`closed` 一值两义是本片
 * 已登记的**已知弱化**（要区分得加列 ⇒ 迁移），用例不敢假装能反查结论。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { CONTRACT_VERSION } from '../../services/api/src/contract.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { createMemoryCommunityStore } from '../../services/api/src/community/store.ts';

const API = '/api/v1';
const dispositionUrl = (id) => `${API}/admin/reports/${id}/disposition`;

/** 与 `admin-hide-post-gate.test.mjs` 同形的 `stub` 环境（本片不碰真实后端）。 */
const STUB_ENV = { APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' };

/** 权威 scope：本片复用既有 `sources:write`，⛔ 不新造 scope。 */
const WRITE_SCOPES = ['sources:write'];
const READ_ONLY_SCOPES = ['sources:read'];

const REPORTER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AUTHOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** 一条"已发布 + 审核通过"的社区帖子（作为举报目标；本片只读它、⛔ 不改它）。 */
function publishedPost(id, authorId) {
  return {
    id,
    revision: 1,
    author_id: authorId,
    title: '水稻田稗草防除记录',
    body: '结构性示例正文：先看苗情，再按标签说明选择登记药剂。',
    crop_id: 'crop-rice',
    region_code: '330100',
    media_ids: [],
    linked_knowledge_ref: null,
    visibility: 'published',
    audit_state: 'approved',
    created_at: '2026-10-22T02:00:00.000Z',
    updated_at: '2026-10-22T02:00:00.000Z',
  };
}

/** 一行举报（形状与 `ReportRecord` 逐字段对齐；`state`/`revision` 由用例给）。 */
function reportRow({ id, postId, state = 'received', revision = 1 }) {
  return {
    id,
    revision,
    reporter_id: REPORTER_ID,
    target_ref: { type: 'post', id: postId, revision: 1 },
    state,
    reason_code: 'other',
    detail: null,
    created_at: '2026-10-22T02:05:00.000Z',
    anonymized_author_ref: null,
  };
}

/** 内存社区 store + 一条已发布帖子 + 一行举报；store 引用留给"库内有没有变"的复核。 */
async function seed({ state = 'received', revision = 1 } = {}) {
  const store = createMemoryCommunityStore({ now: () => Date.now() });
  const post = publishedPost(randomUUID(), AUTHOR_ID);
  assert.equal(await store.insertPost(post, null), true, '夹具：帖子必须先落库');
  const row = reportRow({ id: randomUUID(), postId: post.id, state, revision });
  await store.insertReport(row);
  return { store, post, row };
}

function makeApp(store) {
  const authStore = createMemoryAuthStore();
  const app = buildApp({
    config: loadConfig(STUB_ENV),
    store: authStore,
    communityInjection: { store },
  });
  return { app, authStore };
}

async function seedAdmin(authStore, scopes) {
  const adminId = await authStore.createAdmin({
    loginName: `gyr72-report-${Math.random().toString(36).slice(2, 10)}`,
    credentialHash: 'synthetic-not-a-real-credential-hash',
    scopes,
  });
  const token = mintOpaqueToken();
  await authStore.createSession({
    userId: adminId,
    tokenHashHex: hashToken(token),
    authEpoch: 1,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    audience: 'admin',
  });
  return { token, adminId };
}

/** 处置请求：版本前置条件在 **body** 里（契约 `x-version-required: false`，⛔ 无 If-Match）。 */
function dispositionRequest(app, token, reportId, body) {
  return app.inject({
    method: 'POST',
    url: dispositionUrl(reportId),
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      'content-type': 'application/json',
      'idempotency-key': `gyr72-report-${randomUUID()}`,
    },
    payload: body,
  });
}

/**
 * 库内逐字快照：处置被拒时用来钉"一字未变"。
 *
 * 为什么连 `target` 一起拍：本 op 若误伤目标内容（改了可见性/审核态），只比举报行是看不出来的。
 */
async function snapshot(store, row, post) {
  return { report: await store.getReport(row.id), target: await store.getPost(post.id) };
}

test('T1 正控制：received → isolated（triage）⇒ 200、revision 恰好 +1、封套 data/meta 齐全且 data 是契约 Report', async () => {
  const { store, row } = await seed({ state: 'received', revision: 1 });
  const { app, authStore } = makeApp(store);
  try {
    const { token } = await seedAdmin(authStore, WRITE_SCOPES);
    const res = await dispositionRequest(app, token, row.id, { action: 'triage', expected_revision: 1 });
    assert.equal(res.statusCode, 200, res.body);

    const body = res.json();
    // 封套 = 契约 `ReportEnvelope`：`data` 是 `Report`、`meta` 是 `Meta`，两者都必填。
    assert.equal(body.error, undefined, '成功响应不得带 error');
    assert.equal(typeof body.data, 'object');
    assert.equal(body.data.id, row.id);
    assert.equal(body.data.state, 'isolated', 'triage 的目标状态是 isolated');
    assert.equal(body.data.revision, 2, 'revision 恰好 +1（不是 +2、不是不动）');
    assert.deepEqual(body.data.target_ref, row.target_ref, 'target_ref 原样回传');
    assert.equal(body.data.reason_code, row.reason_code, 'reason_code 原样保留（处置不改举报理由）');
    assert.deepEqual(
      Object.keys(body.data).sort(),
      ['id', 'reason_code', 'revision', 'state', 'target_ref'],
      'data 的字段集必须与契约 Report 逐字一致（多一个字段就是契约漂移）',
    );

    assert.equal(typeof body.meta.request_id, 'string');
    assert.equal(body.meta.contract_version, CONTRACT_VERSION);
    assert.equal(body.meta.execution_mode, 'stub');

    assert.equal(res.headers.etag, '"2"', 'ETag 必须等于推进后的 revision（强 ETag）');
    assert.equal(res.headers['cache-control'], 'no-store', '私有/授权访问不得缓存');

    // 业务结果不只是"返 200"：库里那一行真的推进了，且只推进 revision/state。
    const after = await store.getReport(row.id);
    assert.equal(after.state, 'isolated');
    assert.equal(after.revision, 2);
    assert.equal(after.reporter_id, row.reporter_id);
    assert.deepEqual(after.target_ref, row.target_ref);
    assert.equal(after.reason_code, row.reason_code);
    assert.equal(after.created_at, row.created_at);
  } finally {
    await app.close();
  }
});

test('T2 非法转移：isolated + reject ⇒ 409 REVISION_CONFLICT（state 不接受该动作话术），库内一字未变', async () => {
  const { store, row, post } = await seed({ state: 'isolated', revision: 2 });
  const { app, authStore } = makeApp(store);
  try {
    const { token } = await seedAdmin(authStore, WRITE_SCOPES);
    const before = await snapshot(store, row, post);
    const res = await dispositionRequest(app, token, row.id, { action: 'reject', expected_revision: 2 });
    assert.equal(res.statusCode, 409, res.body);
    const body = res.json();
    assert.equal(body.error.code, 'REVISION_CONFLICT', '非法转移折叠为 409（契约 409 闭集里没有 STATE_CONFLICT）');
    assert.equal(body.error.message, '举报当前状态不接受该处置动作');
    assert.equal(body.data, undefined, '被拒的处置不得返回成功封套');

    const after = await snapshot(store, row, post);
    assert.deepEqual(after, before, '被拒的非法转移必须零写入（举报行与目标帖逐字不变）');
  } finally {
    await app.close();
  }
});

test('T3 版本失配：expected_revision 落后 ⇒ 409 REVISION_CONFLICT（目标版本已变化），库内 state/revision 一字未变', async () => {
  const { store, row, post } = await seed({ state: 'received', revision: 3 });
  const { app, authStore } = makeApp(store);
  try {
    const { token } = await seedAdmin(authStore, WRITE_SCOPES);
    const before = await snapshot(store, row, post);
    // 转移本身合法（received + triage），失败的只能是 CAS 那一步。
    const res = await dispositionRequest(app, token, row.id, { action: 'triage', expected_revision: 1 });
    assert.equal(res.statusCode, 409, res.body);
    const body = res.json();
    assert.equal(body.error.code, 'REVISION_CONFLICT');
    assert.equal(body.error.message, '目标版本已变化，请刷新后重试', '与 community/service.ts 的 commitRefusal 逐字一致');

    const after = await snapshot(store, row, post);
    assert.deepEqual(after, before, 'CAS 失败必须零写入');
    assert.equal(after.report.revision, 3, '落后一个版本**不得**被"顺手推进到 4"');
    assert.equal(after.report.state, 'received');
  } finally {
    await app.close();
  }
});

test('T4 终态单向门：closed 上再处置 ⇒ 409（已处置完毕话术），库内一字未变', async () => {
  const { store, row, post } = await seed({ state: 'closed', revision: 2 });
  const { app, authStore } = makeApp(store);
  try {
    const { token } = await seedAdmin(authStore, WRITE_SCOPES);
    const before = await snapshot(store, row, post);
    for (const action of ['triage', 'resolve', 'reject']) {
      const res = await dispositionRequest(app, token, row.id, { action, expected_revision: 2 });
      assert.equal(res.statusCode, 409, `${action}: ${res.body}`);
      assert.equal(res.json().error.code, 'REVISION_CONFLICT');
      assert.equal(res.json().error.message, '举报已处置完毕，不可再次处置');
    }
    const after = await snapshot(store, row, post);
    assert.deepEqual(after, before, '终态之后三个动作都不得写入（单向门）');
  } finally {
    await app.close();
  }
});

test('T5 守卫：无会话 ⇒ 401；有 admin 但缺 sources:write ⇒ 403 SCOPE_DENIED；两种都零写入', async () => {
  const { store, row, post } = await seed({ state: 'received', revision: 1 });
  const { app, authStore } = makeApp(store);
  try {
    const body = { action: 'triage', expected_revision: 1 };
    const before = await snapshot(store, row, post);

    // ① 无会话：`requireAdmin` 先拦（不是 404、更不是 200）。
    const anonymous = await dispositionRequest(app, null, row.id, body);
    assert.equal(anonymous.statusCode, 401, anonymous.body);
    assert.equal(anonymous.json().error.code, 'SESSION_REQUIRED');
    assert.deepEqual(await snapshot(store, row, post), before, '无会话必须零写入');

    // ② 有 admin 会话但缺 `sources:write`：门在 `requireScope`，缺权限一律 403。
    const { token } = await seedAdmin(authStore, READ_ONLY_SCOPES);
    const denied = await dispositionRequest(app, token, row.id, body);
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(denied.json().error.code, 'SCOPE_DENIED');
    assert.deepEqual(await snapshot(store, row, post), before, '缺 scope 必须零写入');

    // ③ 负控制的正向对照：同一个账号补上 scope 之后同一请求就能过 —— 证明 ② 拦的是权限而不是形状。
    const { token: writeToken } = await seedAdmin(authStore, WRITE_SCOPES);
    const allowed = await dispositionRequest(app, writeToken, row.id, body);
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal((await store.getReport(row.id)).state, 'isolated');
  } finally {
    await app.close();
  }
});

test('T6 零副作用钉：处置不写审计行、不动目标帖的可见性（行内读数逐字不变）', async () => {
  const { store, row, post } = await seed({ state: 'received', revision: 1 });
  const { app, authStore } = makeApp(store);
  try {
    const { token } = await seedAdmin(authStore, WRITE_SCOPES);
    assert.equal(app.adminOpsService.store.audit.list().length, 0, '前置：起始零审计');

    const res = await dispositionRequest(app, token, row.id, { action: 'triage', expected_revision: 1 });
    assert.equal(res.statusCode, 200, res.body);

    // ① 审计：本片刻意不落审计行（见文件头「两处刻意差异」）。这条断言是**事实钉子**，
    //    不是"还没测"——将来接上审计时，这个数会变成 1，届时必须同步改这条用例与台账。
    assert.equal(
      app.adminOpsService.store.audit.list().length,
      0,
      '举报处置刻意不写审计行（要写得先扩 AUDIT_ACTIONS 闭集 + 迁移，属迁移片）',
    );

    // ② 目标内容：处置只动举报行，不动帖子行（可见性/审核态/版本逐字不变）。
    const target = await store.getPost(post.id);
    assert.deepEqual(target, post, '处置不得改动目标帖的任何字段（含 visibility / audit_state / revision）');

    // ③ 举报行：只允许 state/revision 变，其余字段逐字不变（证明没有"顺手"写别的东西）。
    const after = await store.getReport(row.id);
    const { state: _state, revision: _revision, ...restAfter } = after;
    const { state: _s, revision: _r, ...restBefore } = row;
    assert.deepEqual(restAfter, restBefore, '举报行的非 state/revision 字段不得被改写');
  } finally {
    await app.close();
  }
});

test('T7 契约钉子：新 op 在 openapi/operations.json 里、500: Error500、action 闭集三值、expected_revision 必填', () => {
  const openapi = JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'));
  const operations = JSON.parse(readFileSync(new URL('../../packages/contracts/operations.json', import.meta.url), 'utf8'));

  const path = '/admin/reports/{id}/disposition';
  const item = openapi.paths[path];
  assert.equal(typeof item, 'object', `契约必须声明 ${path}`);
  const op = item.post;
  assert.equal(typeof op, 'object', '本 op 的 method 是 post（处置是写面，⛔ 不是 GET）');
  assert.equal(op.operationId, 'advanceReport');
  assert.equal(op['x-scope'], 'sources:write', '复用既有 scope，⛔ 不新造 reports:*');
  assert.equal(op['x-version-required'], false, '版本前置条件在 body 里 ⇒ 契约如实写 false');

  // 500 是 `tests/contract/contract-codes.test.mjs` 的逐 op 硬门禁；这里再钉一次，防"改契约时被顺手删掉"。
  assert.equal(op.responses['500'].$ref, '#/components/responses/Error500');
  assert.equal(op.responses['428'], undefined, 'x-version-required:false ⇒ ⛔ 不得声明 428（也没有 If-Match 参数）');
  assert.equal(
    (op.parameters ?? []).some((p) => p.$ref === '#/components/parameters/IfMatch'),
    false,
    '本 op 刻意不声明 If-Match（参数口径冻结在 body）',
  );

  // 请求体：action 是闭集三值、expected_revision 必填且是 >=1 的整数、不许多字段。
  const schemaRef = op.requestBody.content['application/json'].schema.$ref;
  const schemaName = schemaRef.split('/').pop();
  const schema = openapi.components.schemas[schemaName];
  assert.equal(typeof schema, 'object', `请求体必须以组件 schema 具名（${schemaRef}）`);
  assert.equal(schema.additionalProperties, false, '闭合对象：未知字段一律拒（与 validate.ts 的口径一致）');
  assert.deepEqual(schema.properties.action.enum, ['triage', 'resolve', 'reject'], 'action 必须是闭集三值');
  assert.equal(schema.properties.expected_revision.type, 'integer');
  assert.equal(schema.properties.expected_revision.minimum, 1);
  assert.deepEqual([...schema.required].sort(), ['action', 'expected_revision'], '两个字段都必填');

  // 台账：operations.json 必须与契约同一条（id/method/path/scope/version_required 五字段）。
  const entry = operations.operations.find((e) => e.id === 'advanceReport');
  assert.equal(typeof entry, 'object', 'operations.json 必须有这条 entry');
  assert.equal(entry.method, 'post');
  assert.equal(entry.path, path);
  assert.equal(entry.scope, 'sources:write');
  assert.equal(entry.version_required, false);
});
