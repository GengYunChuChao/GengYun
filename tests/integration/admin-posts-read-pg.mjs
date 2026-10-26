/**
 * R59 · 后台帖子读面（`GET /admin/posts` / `GET /admin/posts/{id}`）· 真实 PostgreSQL 17 集成臂
 *
 * ## 为什么要有这一条（缺口）
 * 契约里 `/admin/posts` 原本只有一条写面 `POST /admin/posts/{id}/hide`（operationId `hidePost`）：
 * 管理员能让帖子消失，却没有任何办法「看到有哪些帖子、看到某条帖子详情」——「先审后发」落不了地。
 * R59 补了两条读面：`listAdminPosts`（scope `sources:read`）与 `getAdminPost`（同 scope）。
 * 本脚本证明这两条读面在**真库**上的读数，而不是合成 store 上的自说自话。
 *
 * ## 这一条最要紧的读数：后台读面的可见性谓词 ≠ 用户读面
 * 用户读面（`/posts`）判的是**生效值**：`effectiveState()` 每次读取都回查审核结论，
 * 无结论/结论过期一律按 `pending` 降级，`hidden`/`deleted`/`private` 全部读不到。
 * 后台读面判的是**库内存储值 + 后台 scope**：`hidden`、`deleted`、`private`、待审的行
 * **必须**都看得到，否则管理员看不到自己要处置的那一行。本脚本用**同一批真库行**同时打两道
 * 读面并把差异逐条打成读数（[P] 节），⛔ 不把「用户读不到」写成「库里没有」。
 *
 * ## 只调用既有代码
 * - 读面：`GET /api/v1/admin/posts`、`GET /api/v1/admin/posts/{id}`（既有路由，real 模式真装配）；
 * - 存储：`createPostgresCommunityStore({pool})` 的既有 `listPosts`（`scope:'admin'` + `state`/`auditState`
 *   下推，R59 在 `community/store-pg.ts` 里加的两个等值条件，SQL 参数化，无字符串拼接）；
 * - 对照臂：脚本自己写 `SELECT`（`ORDER BY created_at DESC, id DESC`）与读面逐位比对。
 *
 * ## 覆盖的读数
 *   [M] PG 主版本 17 / 空库前提 / 迁移子集 0001+0022+0030+0032+0045 逐条 apply 且二连跑 0 条 /
 *       `community_posts.{visibility,audit_state,anonymized_author_ref}` 与
 *       `community_moderation_decisions.text_digest` 在位 / real+真 pool ⇒ `adminPostReadService` 与
 *       `communityService` 都在；
 *   [L] 列表：无筛选的 id 序列与真库 `SELECT ... ORDER BY created_at DESC, id DESC` **逐位相等**；
 *       `state=hidden` / `audit_state=pending` / `state+audit_state` 组合各自与 SQL 对账；
 *       `limit=2` 逐页遍历覆盖全集、无重无漏、末页 `next_cursor:null`；
 *   [D] 单条：字段集合与契约 `AdminPost`（`additionalProperties:false`）**恰好相等**、值与真库行逐列相等、
 *       `ETag` = `"<revision>"`；随机 uuid ⇒ 404 `NOT_FOUND`（⛔ 不是 403，不泄露存在性）；
 *   [S] 鉴权：只有 `sources:write` 的后台会话 ⇒ 403 `SCOPE_DENIED`；无会话 ⇒ 401；
 *   [P] 谓词差异（本节是本片的核心理由）：同一批真库行上，后台读面 6 条全在（含 hidden/deleted/private/待审），
 *       用户读面只有**既 published 又有真实 approved 结论**的那几条；`hidden` 行在用户详情面 404、
 *       在后台详情面 200。
 *
 * ## 未取得（如实登记）
 * - 审核供应商为仓内**合成** gate 夹具（不联网、无凭据）：本脚本证的是存储/路由/谓词，不是审核能力；
 * - 真实媒体、真实 UI、后台前端（另开片）、审核**动作**（本片只读，不写）；
 * - 运行时角色的库级最小权限面（既有各臂已各自证明，本片读数一律库 owner 身份）。
 *
 * ## 运行（专用测试库，必须**空库**；脚本开头断言 `public` 下 0 张表）
 *   createdb -h 127.0.0.1 -p <port> gengyun_admin_posts_read_test
 *   node tests/integration/admin-posts-read-pg.mjs postgres://<owner>@127.0.0.1:<port>/gengyun_admin_posts_read_test
 * 也接受 env `ADMIN_POSTS_READ_PG_TEST_URL`（argv 优先）。未设置 ⇒ 打印 `SKIP` 并以 **77** 退出
 * （POSIX 惯例 skipped；本次运行**没有**取得读数，不是通过）。`--allow-skip` 仅供本机开发取 0，⛔ 不得进门禁。
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

import { loadConfig } from '../../services/api/src/config.ts';
import { buildApp } from '../../services/api/src/app.ts';
import { createPool } from '../../services/api/src/db/pool.ts';
import { applyMigrations, discoverMigrations } from '../../services/api/src/db/migrate.ts';
import { createPostgresCommunityStore } from '../../services/api/src/community/store-pg.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { makeGate } from '../unit/community-fixtures.mjs';

const API = '/api/v1';
const DB = 'gengyun_admin_posts_read_test';
const ENV = 'ADMIN_POSTS_READ_PG_TEST_URL';
/** 契约两条 operation 的 scope（`admin/posts/service.ts::ADMIN_POST_READ_SCOPE`）。 */
const READ_SCOPE = 'sources:read';
/**
 * 只 apply **真正依赖**的迁移：
 * 0001 身份底座（`users`、`visibility` / `audit_state` 枚举）；0022 社区六表
 * （`community_moderation_decisions` 是用户读面 `effectiveState()` 的必需依赖）；
 * 0030 帖/评行级作者注销引用（`POST_COLUMNS` 含 `anonymized_author_ref`，缺它 ⇒ 42703 ⇒ 503）；
 * 0032 举报者行内注销引用（与社区域同形，保持列口径一致）；0045 审核台账 `community_moderation_decisions.decided_by`（人工 approve/reject 的运营者快照列，审核台账 INSERT/SELECT 都写读它，缺它 ⇒ 42703 ⇒ 读面 503）。
 */
const MIGRATIONS = ['0001', '0022', '0030', '0032', '0045'];

const argvUrl = process.argv.slice(2).find((value) => /^postgres(ql)?:\/\//.test(value));
const rawUrl = argvUrl ?? process.env[ENV];
const ALLOW_SKIP = process.argv.includes('--allow-skip') || process.env.GY_ALLOW_SKIP === '1';
if (rawUrl === undefined || rawUrl.trim() === '') {
  console.log(`SKIP real PG17: ${ENV} 未设置（argv 里也没有 postgres URL）——本次运行没有取得后台帖子读面的真库读数（不是通过）。`);
  if (ALLOW_SKIP) {
    console.log('EXITCODE=0（--allow-skip / GY_ALLOW_SKIP=1 已显式授权：仅本机开发，⛔ 不得接进门禁）。');
    process.exit(0);
  }
  console.log('EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped）。');
  process.exit(77);
}

const url = new URL(rawUrl);
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), `${ENV} 必须是 postgres URL`);
assert.equal(url.search, '', '连接参数由脚本控制，测试 URL 不带查询串');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), `只允许回环地址，实际 ${url.hostname}`);
assert.equal(url.pathname, `/${DB}`, `只允许专用测试库 ${DB}（现状 ${url.pathname}）`);

let readings = 0;
const note = (message) => {
  readings += 1;
  console.log(message);
};
const digest = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
/** 夹具时间戳：相差 1 分钟 ⇒ `created_at DESC` 次第唯一确定（不靠 uuid 排序碰运气）。 */
const AT = (minutes) => new Date(Date.parse('2026-10-20T02:00:00.000Z') + minutes * 60_000).toISOString();

const openapi = JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'));
const ADMIN_POST_SCHEMA = openapi.components.schemas.AdminPost;
assert.notEqual(ADMIN_POST_SCHEMA, undefined, '契约必须已有 AdminPost');
/** 契约 `AdminPost`（`additionalProperties:false`）：字段集合即闭集，多一列/少一列都算越界。 */
const ADMIN_POST_KEYS = Object.keys(ADMIN_POST_SCHEMA.properties).sort();

const gate = makeGate();
const RULE_VERSION = gate.currentRuleVersion();
assert.equal(typeof RULE_VERSION, 'string', '合成规则集必须派生出当前规则版本');

const postRecord = (id, authorId, overrides = {}) => ({
  id,
  revision: 1,
  author_id: authorId,
  anonymized_author_ref: null,
  title: `后台帖子读面真库夹具 ${overrides.tag ?? 'x'}`,
  body: `后台帖子读面真库夹具正文 ${overrides.tag ?? 'x'}`,
  crop_id: null,
  region_code: null,
  media_ids: [],
  linked_knowledge_ref: null,
  visibility: 'published',
  audit_state: 'approved',
  created_at: AT(0),
  updated_at: AT(0),
  ...overrides,
});

/** 逐条真实结论（`text_digest` = `title\\nbody` 的 sha256、`rule_version` = 当前版本），否则读面读取时降级。 */
const verdictFor = (record) => ({
  id: randomUUID(),
  target_ref: { type: 'post', id: record.id, revision: record.revision },
  decision: 'approved',
  reason_codes: [],
  hard_rule_passed: true,
  rule_version: RULE_VERSION,
  text_digest: digest(`${record.title}\n${record.body}`),
  contract_complete: true,
  missing_contract_fields: [],
  created_at: record.created_at,
});

async function main() {
  const owner = new pg.Client({ connectionString: url.href });
  await owner.connect();
  let pool = null;
  let app = null;
  try {
    // ---------------- [M] 迁移与装配 ----------------
    const version = (await owner.query("SELECT current_setting('server_version') AS version")).rows[0].version;
    assert.match(version, /^17\./, `requires PostgreSQL 17，实际 ${version}`);
    const tables = (await owner.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'")).rows[0].n;
    assert.equal(tables, 0, '专用测试库必须是空库（非空库会让读数与别的脚本互相污染）');
    note(`[M] PG ${version} · 空库前提成立（public 下 0 张表）`);

    const discovered = discoverMigrations();
    const versions = discovered.map((migration) => migration.version);
    assert.equal(new Set(versions).size, versions.length, `迁移版本号重复：${versions.join(',')}`);
    const picked = discovered.filter((migration) => MIGRATIONS.includes(migration.version));
    assert.deepEqual(picked.map((migration) => migration.version), MIGRATIONS, '五段迁移必须按目录序取到');
    assert.deepEqual((await applyMigrations(owner, picked)).applied, MIGRATIONS, '五段迁移必须逐条真正应用');
    assert.equal((await applyMigrations(owner, picked)).applied.length, 0, '重跑迁移必须是 no-op');
    note(`[M] 迁移子集 ${MIGRATIONS.join('+')} 逐条 apply 成功、二连跑 0 条（目录共 ${versions.length} 个迁移）`);

    const columns = (await owner.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('community_posts', 'community_moderation_decisions')`,
    )).rows;
    const columnOf = (table, name) => columns.some((row) => row.table_name === table && row.column_name === name);
    for (const [table, name] of [
      ['community_posts', 'visibility'],
      ['community_posts', 'audit_state'],
      ['community_posts', 'anonymized_author_ref'],
      ['community_moderation_decisions', 'text_digest'],
    ]) {
      assert.equal(columnOf(table, name), true, `${table}.${name} 必须存在（否则读面 42703 ⇒ 503）`);
    }
    note('[M] 依赖列在位：community_posts.{visibility,audit_state,anonymized_author_ref} 与 community_moderation_decisions.text_digest');

    // ---------------- 夹具：两个真实用户 + 两个后台会话 ----------------
    const auth = createMemoryAuthStore();
    const account = async (tag) => {
      const user = await auth.createUser(tag.repeat(64));
      const token = mintOpaqueToken();
      await auth.createSession({
        userId: user.id,
        tokenHashHex: hashToken(token),
        authEpoch: user.authEpoch,
        expiresAt: new Date(Date.now() + 48 * 3600_000),
        audience: 'user',
      });
      await owner.query('INSERT INTO users (id) VALUES ($1::uuid)', [user.id]);
      return { user, token };
    };
    const authorA = await account('a');
    const otherB = await account('b');

    const adminSession = async (loginName, scopes) => {
      const userId = await auth.createAdmin({
        loginName,
        credentialHash: 'synthetic-not-a-real-credential-hash',
        scopes,
      });
      const token = mintOpaqueToken();
      await auth.createSession({
        userId,
        tokenHashHex: hashToken(token),
        authEpoch: 1,
        expiresAt: new Date(Date.now() + 3600_000),
        audience: 'admin',
      });
      return { userId, token };
    };
    const readAdmin = await adminSession('synthetic-r59-posts-read-admin', [READ_SCOPE]);
    const writeOnlyAdmin = await adminSession('synthetic-r59-posts-write-admin', ['sources:write']);

    pool = createPool(url.href);
    const store = createPostgresCommunityStore({ pool });
    assert.equal(store.persistent, true, 'PG 社区 store 必须自述持久化');

    // 六条真库行：published×2 + hidden + deleted + private + 「published 但没有审核结论」
    const P1 = postRecord(randomUUID(), authorA.user.id, { tag: 'pub-a', crop_id: 'crop-wheat', region_code: '330100', created_at: AT(1), updated_at: AT(1) });
    const P2 = postRecord(randomUUID(), otherB.user.id, { tag: 'pub-b', crop_id: 'crop-rice', region_code: '330200', created_at: AT(2), updated_at: AT(2) });
    const P3 = postRecord(randomUUID(), authorA.user.id, { tag: 'hidden', visibility: 'hidden', created_at: AT(3), updated_at: AT(3) });
    const P4 = postRecord(randomUUID(), authorA.user.id, { tag: 'deleted', visibility: 'deleted', audit_state: 'rejected', created_at: AT(4), updated_at: AT(4) });
    const P5 = postRecord(randomUUID(), authorA.user.id, { tag: 'draft', visibility: 'private', audit_state: 'pending', created_at: AT(5), updated_at: AT(5) });
    // P6 是「已经写进库、还没送审」的行：库内 `audit_state` 就是 `pending`，且**没有**审核结论
    // ⇒ 用户读面按无结论降级为 pending（不可见），后台读面照库里的原值显示 pending。
    const P6 = postRecord(randomUUID(), otherB.user.id, { tag: 'no-verdict', audit_state: 'pending', created_at: AT(6), updated_at: AT(6) });
    const FIXTURES = [P1, P2, P3, P4, P5, P6];
    for (const record of FIXTURES) {
      // P5 是刚落库的草稿、P6 是「published 但没送审」：两条都**不写结论** ⇒ 用户读面读取时降级为 pending。
      const moderation = record === P5 || record === P6 ? null : verdictFor(record);
      assert.equal(await store.insertPost(record, moderation), true, `夹具帖 ${record.id} 必须落库`);
    }
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM community_posts')).rows[0].n, 6, '六条夹具各占一行');
    note('[L] 夹具 6 条真落 community_posts：published×2（含 1 条缺审核结论）+ hidden + deleted + private/pending');

    const baseConfig = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
    const realConfig = { ...baseConfig, executionMode: 'real', requiresRealCredentials: true };
    app = buildApp({ config: realConfig, store: auth, pool, now: () => new Date(), communityInjection: { gate } });
    assert.notEqual(app.communityService, null, 'real + 真 pool ⇒ 社区服务必须开启（否则用户读面 503，谓词对照无效）');
    assert.notEqual(app.adminPostReadService, undefined, 'real + 真 pool ⇒ 后台帖子读面必须存在（R59 装配）');
    note('[M] real 模式装配：communityService 在、adminPostReadService 在（读面走真库，不是 fail-closed）');

    const call = async (token, method, path) => {
      const response = await app.inject({
        method,
        url: path,
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      });
      let body = null;
      try {
        body = response.json();
      } catch {
        body = null;
      }
      return { status: response.statusCode, headers: response.headers, body, text: response.body };
    };
    const idsOf = (body) => (Array.isArray(body?.data?.items) ? body.data.items.map((item) => item.id) : null);

    /** 后台读面的对照 SQL：**无可见性谓词**（管理视角），`state`/`audit_state` 只做等值收窄。 */
    const sqlAdmin = async ({ state = null, auditState = null } = {}) => (await owner.query(
      `SELECT id::text AS id FROM community_posts
        WHERE ($1::text IS NULL OR visibility::text = $1)
          AND ($2::text IS NULL OR audit_state::text = $2)
        ORDER BY created_at DESC, id DESC`,
      [state, auditState],
    )).rows.map((row) => row.id);

    // ---------------- [L] 列表读面 ----------------
    const listAll = await call(readAdmin.token, 'GET', `${API}/admin/posts`);
    assert.equal(listAll.status, 200, `后台列表 ⇒ ${listAll.status} ${listAll.text.slice(0, 300)}`);
    assert.deepEqual(idsOf(listAll.body), await sqlAdmin(), '无筛选时读面 id 序列必须与真库 SQL 逐位相等');
    assert.equal(listAll.body.data.items.length, 6, '后台读面必须看得到全部 6 条（含 hidden/deleted/private）');
    assert.equal(listAll.body.data.next_cursor, null, '6 < 缺省 20 ⇒ 不应有下一页');
    assert.ok(listAll.headers.etag === undefined, '列表响应不带 ETag（契约只给单资源）');
    note('[L] 列表（无筛选）：6/6 条与真库 SQL 逐位相等，含 hidden×1 / deleted×1 / private×1 / 待审×2');

    for (const [label, query, expected] of [
      ['state=hidden', '?state=hidden', { state: 'hidden' }],
      ['state=deleted', '?state=deleted', { state: 'deleted' }],
      ['audit_state=pending', '?audit_state=pending', { auditState: 'pending' }],
      ['state=published&audit_state=pending', '?state=published&audit_state=pending', { state: 'published', auditState: 'pending' }],
    ]) {
      const response = await call(readAdmin.token, 'GET', `${API}/admin/posts${query}`);
      assert.equal(response.status, 200, `${label} ⇒ ${response.status} ${response.text.slice(0, 200)}`);
      assert.deepEqual(idsOf(response.body), await sqlAdmin(expected), `${label} 必须与真库 SQL 对账`);
      assert.ok(response.body.data.items.length > 0, `${label} 在真库夹具里应至少命中 1 条（证明下推真的生效）`);
    }
    note('[L] 过滤下推：state=hidden / state=deleted / audit_state=pending / 两者组合 各自与真库 SQL 逐位相等');

    const walked = [];
    let cursor = null;
    for (let page = 0; page < 10; page += 1) {
      const suffix = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      const response = await call(readAdmin.token, 'GET', `${API}/admin/posts?limit=2${suffix}`);
      assert.equal(response.status, 200, `limit=2 第 ${page + 1} 页 ⇒ ${response.status}`);
      walked.push(...idsOf(response.body));
      cursor = response.body.data.next_cursor;
      if (cursor === null) break;
    }
    assert.equal(walked.length, 6, 'limit=2 逐页遍历必须取完 6 条');
    assert.equal(new Set(walked).size, 6, '翻页不得重复');
    assert.deepEqual(walked, await sqlAdmin(), '逐页拼起来必须与一次取全的 SQL 序列一致（keyset 不跳行）');
    note('[L] 分页：limit=2 逐页遍历 3 页取完 6 条，无重无漏，序列 = SQL 一次取全');

    // ---------------- [D] 单条读面 ----------------
    const rowOf = async (id) => (await owner.query(
      `SELECT id::text AS id, revision, author_id::text AS author_id, anonymized_author_ref,
              title, body, crop_id, region_code, media_ids, visibility::text AS visibility,
              audit_state::text AS audit_state, created_at::text AS created_at, updated_at::text AS updated_at,
              linked_knowledge_id::text AS linked_knowledge_id
         FROM community_posts WHERE id = $1::uuid`,
      [id],
    )).rows[0] ?? null;

    const detail = await call(readAdmin.token, 'GET', `${API}/admin/posts/${P3.id}`);
    assert.equal(detail.status, 200, `hidden 帖详情 ⇒ ${detail.status} ${detail.text.slice(0, 300)}`);
    assert.deepEqual(Object.keys(detail.body.data).sort(), ADMIN_POST_KEYS, '详情字段集合必须与契约 AdminPost 恰好相等');
    assert.equal(detail.body.data.visibility, 'hidden', '后台看到的是**存储值**（不是生效值）');
    assert.equal(detail.headers.etag, `"${detail.body.data.revision}"`, 'ETag = 强校验器（revision）');
    const row = await rowOf(P3.id);
    assert.equal(detail.body.data.id, row.id);
    assert.equal(detail.body.data.author_id, row.author_id);
    assert.equal(detail.body.data.title, row.title);
    assert.equal(detail.body.data.body, row.body);
    assert.equal(detail.body.data.audit_state, row.audit_state);
    assert.equal(detail.body.data.created_at, new Date(row.created_at).toISOString());
    // 库内 `linked_knowledge_id` 为空 ⇒ 读面的 `linked_knowledge_ref` 必须是 null（不是 `{}`、不是省略）。
    assert.equal(row.linked_knowledge_id, null);
    assert.equal(detail.body.data.linked_knowledge_ref, null, '未关联知识对象时必须显式 null');
    note('[D] 详情：字段集合 = 契约 AdminPost 闭集，visibility/author_id/title/body 与真库行逐列相等，ETag=revision');

    const missingId = randomUUID();
    const missing = await call(readAdmin.token, 'GET', `${API}/admin/posts/${missingId}`);
    assert.equal(missing.status, 404, `不存在 ⇒ ${missing.status}`);
    assert.equal(missing.body.error.code, 'NOT_FOUND');
    assert.equal(missing.body.data, undefined, '404 不得返回 data');
    note('[D] 不存在（随机 uuid）⇒ 404 NOT_FOUND、无 data（⛔ 不用 403：不泄露存在性）');

    // ---------------- [S] 鉴权 ----------------
    const denied = await call(writeOnlyAdmin.token, 'GET', `${API}/admin/posts`);
    assert.equal(denied.status, 403, `只有 sources:write ⇒ ${denied.status}`);
    assert.equal(denied.body.error.code, 'SCOPE_DENIED');
    const anonymous = await call(null, 'GET', `${API}/admin/posts`);
    assert.equal(anonymous.status, 401, `无会话 ⇒ ${anonymous.status}`);
    note('[S] 鉴权：只有 sources:write 的后台会话 ⇒ 403 SCOPE_DENIED；无会话 ⇒ 401');

    // ---------------- [P] 谓词差异（本片核心理由） ----------------
    const userList = await call(otherB.token, 'GET', `${API}/posts?limit=50`);
    assert.equal(userList.status, 200, `用户读面 ⇒ ${userList.status} ${userList.text.slice(0, 300)}`);
    const publicIds = new Set(idsOf(userList.body) ?? []);
    // 只有「published 且带真实 approved 结论」的行才对用户可见：P1、P2。
    assert.deepEqual([...publicIds].sort(), [P1.id, P2.id].sort(), '用户读面只应看到两条有真实结论的 published 行');
    for (const hiddenRecord of [P3, P4, P5, P6]) {
      assert.equal(publicIds.has(hiddenRecord.id), false, `用户读面不得出现 ${hiddenRecord.tag}`);
    }
    const adminIds = new Set(idsOf(listAll.body) ?? []);
    for (const record of [P3, P4, P5, P6]) {
      assert.equal(adminIds.has(record.id), true, `后台读面必须看得到 ${record.tag}`);
    }
    const userDetailHidden = await call(otherB.token, 'GET', `${API}/posts/${P3.id}`);
    assert.equal(userDetailHidden.status, 404, 'hidden 行在用户详情面必须 404');
    assert.equal(userDetailHidden.body.error.code, 'NOT_FOUND');
    const adminDetailHidden = await call(readAdmin.token, 'GET', `${API}/admin/posts/${P3.id}`);
    assert.equal(adminDetailHidden.status, 200, '同一行在后台详情面必须 200');
    note('[P] 谓词差异（同一批真库行）：后台 6/6 可见（hidden/deleted/private/待审都在）；用户读面只 2 条（P1/P2）；hidden 行用户 404、后台 200');

    console.log(`\nREADINGS=${readings}（全部为本次真库运行取得；SKIP 不在此列）`);
    console.log('EXITCODE=0');
  } finally {
    if (app !== null) await app.close();
    if (pool !== null) await pool.end();
    await owner.end();
  }
}

await main();
