/**
 * R59 · 后台帖子读面（`GET /admin/posts` / `GET /admin/posts/{id}`）单元测试。
 *
 * 钉住四类判定（对应派单 §测试）：
 * 1. **列表分页**：`limit` 缺省 20 / 上限 50（契约 `Limit` 参数），keyset 游标翻页不重不漏，
 *    最后一页 `next_cursor: null`；越界与非整数一律 400 且 `details[].field` 指向入参本身。
 * 2. **过滤**：`state`（`Visibility` 四值）与 `audit_state`（`AuditState` 四值）各自下推；
 *    闭集外取值 ⇒ 400 `INVALID_REQUEST`（⛔ 不静默返回空页：那会把拼错的状态说成"平台没有这类记录"）。
 * 3. **单条 404**：不存在 ⇒ 404 `NOT_FOUND`（⛔ 不用 403：403 会泄露"这个 id 存在但你无权看"，
 *    而本读面的 scope 是**入口级**的，没有按目标的行级授权）。
 * 4. **可见性谓词与用户读面不同**：同一份 store 里 `hidden` / `deleted` / 待审的帖子，
 *    后台读面**必须看得到**（否则管理员看不到自己要处置的那一行，"先审后发"落不了地），
 *    而用户读面（`/posts`、`/posts/{id}`）按**生效值**判定，一律读不到。
 *
 * 声明（不得误读）：本文件是**合成夹具**——账号、正文、行值全部为结构性示例；
 * 它证明的是"两道读面的判定不同"，**不是**真库行为——本文件用内存 store + 假端口，**不需要**数据库，
 * 也不读任何 `*_PG_TEST_URL`（真库臂见 `tests/integration/admin-posts-read-pg.mjs`：那里要 `ADMIN_POSTS_READ_PG_TEST_URL`，缺库打印 `SKIP` 并以 77 退出）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createMemoryCommunityStore } from '../../services/api/src/community/store.ts';
import { ADMIN_POST_SPEC_GROUPS } from '../../services/api/src/admin/posts/fields.ts';
import { makeGate, makeSyntheticPassPort } from './community-fixtures.mjs';
import { frozenModerationInjection } from './stall-hygiene-fixtures.mjs';

const API = '/api/v1';
const LIST = `${API}/admin/posts`;
const DETAIL = (id) => `${API}/admin/posts/${id}`;
const READ_SCOPE = 'sources:read';

/** 这一片要读的 scope：与 `admin/posts/service.ts` 的 `ADMIN_POST_READ_SCOPE` 同值。 */
const BASE_AT = Date.UTC(2026, 9, 20, 10, 0, 0);

/** 一行社区帖子（`PostRecord` 形状）。`created_at` 递增 ⇒ 列表里**新行在前**。 */
function postRow(index, overrides = {}) {
  const iso = new Date(BASE_AT + index * 1000).toISOString();
  return {
    id: `00000000-0000-4000-8000-00000000000${index}`,
    revision: 1,
    author_id: '11111111-1111-4111-8111-111111111111',
    anonymized_author_ref: null,
    title: `结构性示例标题 ${index}`,
    body: `结构性示例正文 ${index}：先看苗情，再按标签说明选择登记药剂。`,
    crop_id: 'crop-rice',
    region_code: '330100',
    media_ids: [],
    linked_knowledge_ref: null,
    visibility: 'published',
    audit_state: 'approved',
    created_at: iso,
    updated_at: iso,
    ...overrides,
  };
}

/**
 * 五行覆盖（`state` × `audit_state`）：
 * 1 visible             published / approved  ← 用户读面的"应该可见"，但**没有审核结论时仍是不可见**
 * 2 hidden              hidden    / approved
 * 3 deleted             deleted   / rejected
 * 4 private             private   / pending
 * 5 pending-published   published / pending
 */
const SEED = [
  postRow(1, { visibility: 'published', audit_state: 'approved' }),
  postRow(2, { visibility: 'hidden', audit_state: 'approved' }),
  postRow(3, { visibility: 'deleted', audit_state: 'rejected' }),
  postRow(4, { visibility: 'private', audit_state: 'pending' }),
  postRow(5, { visibility: 'published', audit_state: 'pending' }),
];

async function fixture() {
  const auth = createMemoryAuthStore();
  const community = createMemoryCommunityStore({ now: () => BASE_AT });
  for (const row of SEED) {
    assert.equal(await community.insertPost(row, null), true, '合成存量行必须落库');
  }
  const config = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
  const app = buildApp({
    config,
    store: auth,
    now: () => new Date(BASE_AT),
    communityInjection: { store: community, gate: makeGate() },
    // 社区读面会走「读取时重查」：审核域未接线时该联动为 null，等于"无额外扣留"。
    // 这里注入**明确标注的合成 pass 端口**（不联网、不冒充真实供应商），让读路径可判定。
    moderationInjection: frozenModerationInjection({
      executionMode: config.executionMode,
      ports: { tms: makeSyntheticPassPort('tms') },
      store: community,
    }),
  });

  /** 管理员会话（`scopes` 即后台 scope 闭集的子集）。 */
  async function admin(scopes = [READ_SCOPE]) {
    const userId = await auth.createAdmin({
      loginName: `r59-admin-${Math.random().toString(36).slice(2, 10)}`,
      credentialHash: 'synthetic-not-a-real-credential-hash',
      scopes,
    });
    const token = `synthetic-r59-admin-token-${userId.slice(0, 8)}`;
    await auth.createSession({
      userId,
      tokenHashHex: hashToken(token),
      authEpoch: 1,
      expiresAt: new Date(BASE_AT + 3600_000),
      audience: 'admin',
    });
    return { userId, token };
  }

  /** 普通用户会话（用于对照用户读面）。 */
  async function user(seed = 'r59-reader') {
    const created = await auth.createUser((seed + '-'.repeat(64)).slice(0, 64));
    const token = `synthetic-r59-user-token-${created.id.slice(0, 8)}`;
    await auth.createSession({
      userId: created.id,
      tokenHashHex: hashToken(token),
      authEpoch: created.authEpoch,
      expiresAt: new Date(BASE_AT + 3600_000),
      audience: 'user',
    });
    return { userId: created.id, token };
  }

  const call = (method, path, actor) =>
    app.inject({
      method,
      url: path,
      headers: actor === null ? {} : { authorization: `Bearer ${actor.token}` },
    });

  return { app, auth, community, admin, user, call };
}

test('列表：keyset 游标翻页不重不漏，最后一页 next_cursor 为 null', async (t) => {
  const { app, admin, call } = await fixture();
  t.after(() => app.close());
  const reader = await admin();

  const first = await call('GET', `${LIST}?limit=2`, reader);
  assert.equal(first.statusCode, 200, first.body);
  const page1 = first.json();
  assert.equal(page1.data.items.length, 2);
  assert.equal(typeof page1.data.next_cursor, 'string', '未到末页必须给出游标');
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.equal(first.headers.etag, undefined, '列表响应不带 ETag（契约只给单资源）');
  assert.equal(page1.meta.contract_version, '1.0.0');

  const second = await call('GET', `${LIST}?limit=2&cursor=${encodeURIComponent(page1.data.next_cursor)}`, reader);
  assert.equal(second.statusCode, 200, second.body);
  const page2 = second.json();
  assert.equal(page2.data.items.length, 2);

  const third = await call('GET', `${LIST}?limit=2&cursor=${encodeURIComponent(page2.data.next_cursor)}`, reader);
  assert.equal(third.statusCode, 200, third.body);
  const page3 = third.json();
  assert.equal(page3.data.items.length, 1, '五行数据分三页取完');
  assert.equal(page3.data.next_cursor, null, '末页不得再给游标');

  // 不重不漏：三页并起来恰好是库里那五行（后台读面在**未过滤**时不丢 hidden/deleted）。
  const walked = [...page1.data.items, ...page2.data.items, ...page3.data.items].map((item) => item.id);
  assert.equal(new Set(walked).size, 5, '翻页不得出现重复行');
  assert.deepEqual(new Set(walked), new Set(SEED.map((row) => row.id)));

  // 缺省 limit = 20（契约 `Limit` 默认值）⇒ 五行一次取完，且没有下一页。
  const unpaged = await call('GET', LIST, reader);
  assert.equal(unpaged.statusCode, 200);
  assert.equal(unpaged.json().data.items.length, 5);
  assert.equal(unpaged.json().data.next_cursor, null);

  // 上限 50 / 下界 1 / 非整数：一律 400，且 field 指回入参本身。
  for (const bad of ['51', '0', '-1', 'abc', '1.5']) {
    const res = await call('GET', `${LIST}?limit=${bad}`, reader);
    assert.equal(res.statusCode, 400, `limit=${bad} 必须 400`);
    assert.equal(res.json().error.code, 'INVALID_REQUEST');
    assert.equal(res.json().error.details[0].field, 'limit');
  }
  const atCap = await call('GET', `${LIST}?limit=50`, reader);
  assert.equal(atCap.statusCode, 200, 'limit=50 是契约上限，必须放行');
});

test('过滤：state 闭集下推，闭集外 400（不静默返回空页）', async (t) => {
  const { app, admin, call } = await fixture();
  t.after(() => app.close());
  const reader = await admin();

  const hidden = await call('GET', `${LIST}?state=hidden`, reader);
  assert.equal(hidden.statusCode, 200, hidden.body);
  assert.deepEqual(hidden.json().data.items.map((item) => item.id), [SEED[1].id]);
  assert.equal(hidden.json().data.items[0].visibility, 'hidden');

  const deleted = await call('GET', `${LIST}?state=deleted`, reader);
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(deleted.json().data.items.map((item) => item.id), [SEED[2].id]);

  for (const bad of ['bogus', 'PUBLISHED', ' deleted']) {
    const res = await call('GET', `${LIST}?state=${encodeURIComponent(bad)}`, reader);
    assert.equal(res.statusCode, 400, `state=${bad} 必须 400`);
    assert.equal(res.json().error.code, 'INVALID_REQUEST');
    assert.equal(res.json().error.details[0].field, 'state');
  }
});

test('过滤：audit_state 独立下推，且与 state 组合后收窄到单条', async (t) => {
  const { app, admin, call } = await fixture();
  t.after(() => app.close());
  const reader = await admin();

  const pending = await call('GET', `${LIST}?audit_state=pending`, reader);
  assert.equal(pending.statusCode, 200, pending.body);
  assert.deepEqual(
    pending.json().data.items.map((item) => item.id).sort(),
    [SEED[3].id, SEED[4].id].sort(),
    'pending 两行（private / published-未审）都要在',
  );

  const combo = await call('GET', `${LIST}?state=published&audit_state=pending`, reader);
  assert.equal(combo.statusCode, 200);
  assert.deepEqual(combo.json().data.items.map((item) => item.id), [SEED[4].id]);

  for (const bad of ['bogus', 'Approved']) {
    const res = await call('GET', `${LIST}?audit_state=${bad}`, reader);
    assert.equal(res.statusCode, 400, `audit_state=${bad} 必须 400`);
    assert.equal(res.json().error.details[0].field, 'audit_state');
  }
});

test('游标与筛选组合绑定：换筛选后拿旧游标翻页 ⇒ INVALID_CURSOR', async (t) => {
  const { app, admin, call } = await fixture();
  t.after(() => app.close());
  const reader = await admin();

  const page1 = (await call('GET', `${LIST}?limit=2`, reader)).json();
  const reused = await call(
    'GET',
    `${LIST}?limit=2&state=hidden&cursor=${encodeURIComponent(page1.data.next_cursor)}`,
    reader,
  );
  assert.equal(reused.statusCode, 400, '换了筛选，旧游标不能再用来继续翻页（否则会跳行/重行）');
  assert.equal(reused.json().error.code, 'INVALID_CURSOR');

  const tampered = await call('GET', `${LIST}?limit=2&cursor=not-a-real-cursor`, reader);
  assert.equal(tampered.statusCode, 400);
  assert.equal(tampered.json().error.code, 'INVALID_CURSOR');
});

test('单条：存在 ⇒ 200 + ETag；不存在 ⇒ 404 NOT_FOUND（不用 403 泄露存在性）', async (t) => {
  const { app, admin, call } = await fixture();
  t.after(() => app.close());
  const reader = await admin();

  const found = await call('GET', DETAIL(SEED[3].id), reader);
  assert.equal(found.statusCode, 200, found.body);
  const item = found.json().data;
  assert.equal(item.id, SEED[3].id);
  assert.equal(found.headers.etag, `"${item.revision}"`, '单资源给强 ETag（= revision）');
  // 详情必须给出派单点名的字段（存储值，不是公开读面的生效值）。
  for (const field of ['visibility', 'audit_state', 'author_id', 'created_at', 'updated_at', 'media_ids', 'linked_knowledge_ref']) {
    assert.equal(Object.hasOwn(item, field), true, `详情缺字段 ${field}`);
  }

  const missingId = randomUUID();
  const missing = await call('GET', DETAIL(missingId), reader);
  assert.equal(missing.statusCode, 404, '不存在的帖子 ⇒ 404');
  assert.equal(missing.json().error.code, 'NOT_FOUND');
  assert.equal(missing.json().data, undefined, '404 不得返回任何 data');
  assert.notEqual(missing.statusCode, 403, '⛔ 不得用 403：那会泄露"id 存在但你无权看"');

  // 非法 uuid 属 HTTP 层 400（与 `admin-routes-nail` 的两层分工同口径）。
  const malformed = await call('GET', DETAIL('not-a-uuid'), reader);
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().error.code, 'INVALID_REQUEST');
});

test('鉴权：缺 sources:read ⇒ 403 SCOPE_DENIED；无会话 ⇒ 401；用户会话不得进后台读面', async (t) => {
  const { app, admin, user, call } = await fixture();
  t.after(() => app.close());

  const writeOnly = await admin(['sources:write']);
  for (const path of [LIST, DETAIL(SEED[1].id)]) {
    const res = await call('GET', path, writeOnly);
    assert.equal(res.statusCode, 403, `${path} 缺 sources:read 必须 403`);
    assert.equal(res.json().error.code, 'SCOPE_DENIED');
  }

  const anonymous = await call('GET', LIST, null);
  assert.equal(anonymous.statusCode, 401);

  const reader = await user();
  const asUser = await call('GET', LIST, reader);
  assert.equal(asUser.statusCode, 403, '普通用户会话不得进后台读面（后台读面不是"另一个公开列表"）');

  // 正控制：同一个人补上 sources:read 就能读（证明 403 是缺权限，不是路由不存在）。
  const granted = await admin([READ_SCOPE]);
  assert.equal((await call('GET', LIST, granted)).statusCode, 200);
});

test('可见性谓词不同：后台读面看得到 hidden/deleted/待审，用户读面按生效值一律读不到', async (t) => {
  const { app, admin, user, call } = await fixture();
  t.after(() => app.close());
  const reader = await admin();
  const member = await user();

  // —— 后台读面（管理视角）：五行全在，且给的是**库内存储值** ——
  const adminList = await call('GET', LIST, reader);
  assert.equal(adminList.statusCode, 200, adminList.body);
  const adminItems = adminList.json().data.items;
  assert.equal(adminItems.length, SEED.length, '后台读面必须看得到 hidden/deleted/private/待审');
  const byId = new Map(adminItems.map((item) => [item.id, item]));
  assert.equal(byId.get(SEED[1].id).visibility, 'hidden', 'hidden 行在后台如实显示为 hidden');
  assert.equal(byId.get(SEED[2].id).visibility, 'deleted', 'deleted 行在后台如实显示为 deleted');
  assert.equal(byId.get(SEED[4].id).audit_state, 'pending', '待审行在后台如实显示为 pending');
  // 存储值 ≠ 生效值：这一行库里写着 published/approved，但它**没有审核结论**，
  // 用户读面会按生效值把它降级（见下）；后台必须显示库里的原值，否则管理员无法按真实状态处置。
  assert.equal(byId.get(SEED[0].id).visibility, 'published');
  assert.equal(byId.get(SEED[0].id).audit_state, 'approved');

  // —— 用户读面（同一份 store、同一个 app）：一行都读不到 ——
  const userList = await call('GET', `${API}/posts`, member);
  assert.equal(userList.statusCode, 200, userList.body);
  const userIds = new Set(userList.json().data.items.map((item) => item.id));
  assert.equal(userIds.size, 0, `用户读面不得出现这些行（实际命中：${[...userIds].join(',')}）`);

  // 单条同理：后台 200，用户 404（同形 404，不泄露存在性）。
  const asAdmin = await call('GET', DETAIL(SEED[1].id), reader);
  assert.equal(asAdmin.statusCode, 200);
  const asUserDetail = await call('GET', `${API}/posts/${SEED[1].id}`, member);
  assert.equal(asUserDetail.statusCode, 404, '用户读面对 hidden 行必须 404');
  assert.equal(asUserDetail.json().error.code, 'NOT_FOUND');

  // 反面：库里那行 published/approved 也读不到 —— 证明用户读面判的是**生效值**，
  // 而后台读面判的是**存储值 + 后台 scope**，两者不是同一谓词。
  const visibleButUnapproved = await call('GET', `${API}/posts/${SEED[0].id}`, member);
  assert.equal(visibleButUnapproved.statusCode, 404);
});

/* ------------------------------------------------------------------ *
 * 镜像表 ⇄ 契约（防漂移）
 *
 * 归一化助手照抄 `tests/unit/admin-ops-contract.test.mjs`（同一套口径：`anyOf [T, null]` → `nullable`、
 * `enum` 排序、只保留契约真用的键）。**不**把本片四张 schema 塞进那个文件：它的
 * `assert.equal(compared, 22)` 是「R34 ops 片恰好 22 张镜像」的钉子，本片另开一册不搅动它。
 * ------------------------------------------------------------------ */
const ROOT = new URL('../../', import.meta.url);
const openapi = JSON.parse(readFileSync(new URL('packages/contracts/openapi.json', ROOT), 'utf8'));

function normalizeContractSchema(node) {
  assert.equal(typeof node, 'object');
  assert.notEqual(node, null);
  if (node.$ref !== undefined) {
    assert.ok(node.$ref.startsWith('#/components/schemas/'), `非本地 schema 引用：${node.$ref}`);
    return { ref: node.$ref.slice('#/components/schemas/'.length) };
  }
  if (node.anyOf !== undefined) {
    assert.equal(node.anyOf.length, 2, 'anyOf 只支持 [T, null]');
    assert.deepEqual(node.anyOf[1], { type: 'null' });
    return { ...normalizeContractSchema(node.anyOf[0]), nullable: true };
  }
  const out = {};
  for (const key of ['type', 'const', 'format', 'pattern', 'minLength', 'maxLength', 'minimum', 'minItems', 'maxItems', 'required']) {
    if (node[key] !== undefined) out[key] = node[key];
  }
  if (node.enum !== undefined) out.enum = [...node.enum].sort();
  if (node.items !== undefined) out.items = normalizeContractSchema(node.items);
  if (node.properties !== undefined) {
    out.properties = {};
    for (const [key, value] of Object.entries(node.properties)) out.properties[key] = normalizeContractSchema(value);
  }
  if (node.additionalProperties === false) out.additionalProperties = false;
  return out;
}

function normalizeMirror(spec) {
  const out = {};
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'enum') out.enum = [...value].sort();
    else if (key === 'items') out.items = normalizeMirror(value);
    else if (key === 'properties') {
      out.properties = {};
      for (const [k, v] of Object.entries(value)) out.properties[k] = normalizeMirror(v);
    } else out[key] = value;
  }
  return out;
}

function assertNoUndefined(value, path) {
  if (value === undefined) assert.fail(`镜像表在 ${path} 处出现 undefined`);
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) assertNoUndefined(child, `${path}.${key}`);
}

test('本片镜像表（AdminPost 四张）与契约逐字相等', () => {
  let compared = 0;
  for (const [groupName, group] of Object.entries(ADMIN_POST_SPEC_GROUPS)) {
    for (const [name, spec] of Object.entries(group)) {
      assertNoUndefined(spec, `${groupName}.${name}`);
      const contract = openapi.components.schemas[name];
      assert.notEqual(contract, undefined, `契约里没有 ${name}`);
      assert.deepStrictEqual(normalizeMirror(spec), normalizeContractSchema(contract), `${groupName}.${name} 与契约不同形`);
      compared += 1;
    }
  }
  // 6 = 本片新增 4（AdminPost / AdminPostPage / 2 张信封）+ 2 张**仓内镜像表原本没有**、
  // 但契约已有且本域必需的（`AuditState` 枚举、`KnowledgeTarget` 引用目标）。
  // `Visibility` 直接复用 `admin/fields.ts` 的 `ALL_SPECS`，本域不重复定义。
  assert.equal(compared, 6, '本域镜像表的 schema 数量应恰好 6');

  // 两条 operation 的 scope 必须与实现常量一致，且都在 13 项后台 scope 闭集内（⛔ 不许自创）。
  for (const [path, method] of [['/admin/posts', 'get'], ['/admin/posts/{id}', 'get']]) {
    const operation = openapi.paths[path]?.[method];
    assert.notEqual(operation, undefined, `契约缺 ${method.toUpperCase()} ${path}`);
    assert.equal(operation['x-scope'], 'sources:read', `${path} 的 scope 必须是 sources:read`);
    assert.equal(operation['x-version-required'], false);
  }
  // 详情不得用 403（会泄露存在性）：契约里必须有 404，且 200 只给单资源。
  const detail = openapi.paths['/admin/posts/{id}'].get;
  assert.notEqual(detail.responses['404'], undefined, '详情必须声明 404');
  assert.equal(detail.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/AdminPostEnvelope');
  const list = openapi.paths['/admin/posts'].get;
  assert.equal(list.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/AdminPostPageEnvelope');
  // 复用组件参数的写法是 `$ref: '#/components/parameters/Limit'`：先解引用再读 name/in。
  const paramOf = (param) =>
    param.$ref === undefined
      ? param
      : (assert.ok(param.$ref.startsWith('#/components/parameters/'), `非本地参数引用：${param.$ref}`),
        openapi.components.parameters[param.$ref.slice('#/components/parameters/'.length)]);
  assert.deepEqual(
    list.parameters.map(paramOf).filter((p) => p.in === 'query').map((p) => p.name).sort(),
    ['audit_state', 'cursor', 'limit', 'state'],
    '列表的 query 参数集合不得多/少',
  );
});
