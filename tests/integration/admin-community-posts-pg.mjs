/**
 * GY-I18（#18）· 后台「社区帖」域 · 真实 PostgreSQL 17.11 集成臂
 * （读面：列表/单条；处置：下架；失败隔离）
 *
 * ## 缺口（本片要补的那一条）
 * 基线 `765b6a31` 的真库臂里，后台**只有三条**：`admin-accounts-read-pg.mjs`（账号读面）、
 * `admin-flags-pg.mjs`（开关）、`admin-jobs-pg.mjs`（作业台）——
 * **社区帖域没有自己的真库臂**。它的处置路径是契约 operationId 109 的
 * `POST /admin/posts/{id}/hide`（scope `sources:write`），实现＝
 * `admin/ops/service.ts::hidePost` → `admin/ops/community-posts.ts::createHidePostAdapter`
 * → 社区 store 的**唯一更新原语** `commitPostIfCurrent`（迁移 0022 的 `community_posts`）。
 * 此前这条链只在 `community-pg.mjs` 的第 13 节被**顺带**读到（那是社区域脚本，且明确声明
 * 不证明审计留痕）；后台域自己没有一条 CI 会跑的读数。监工 #18 因此把「后台四域真 PG 联调」
 * 列为未交付。
 *
 * ## 本脚本只调用既有代码，不改产品行为
 * 全部读数都走**既有装配**与**既有路由**：
 *   - 读面：`GET /api/v1/posts`（契约 `listPosts`）、`GET /api/v1/posts/{id}`（契约 `getPost`）——
 *     后台契约里社区帖**没有独立的列表/详情 operationId**（`operations.json` 只有 109 = hide），
 *     后台「社区帖」页读的就是社区这两条面，故读面读数按它们取；
 *   - 处置：`POST /api/v1/admin/posts/{id}/hide`（real 模式下由
 *     `admin/ops/accounts-only.ts` 的 `hidePostWired`（= `communityPostPortForAdmin.persistent === true`）
 *     放行）；
 *   - 审计：`admin/ops/service.ts::appendAudit` 写进**同一个** `AdminRuntime` 的只可追加台账
 *     （`app.ts:1094-1098` 让内容 store 与 ops store 共用一份），本脚本用它的读 API 读回。
 *
 * ## 覆盖的读数（前缀与派单 §3 对齐）
 *   [M] 迁移与装配：PG 主版本 17 / 空库前提 / 迁移子集 0001+0022+0028+0030+0032 逐条 apply 且二连跑 0 条 /
 *       `community_posts` 与本脚本依赖的列真的在（`anonymized_author_ref` 只在 0030 之后存在）/
 *       real + 真 pool ⇒ 社区服务与后台运营服务都在，且社区帖子端口 `persistent === true`；
 *   [L] 列表读面（真库夹具）：无筛选 / `crop_id` / `region_code` / 两者组合 / `mine=true` 的 id 序列
 *       与**真库同条件 SELECT 逐位相等**（含 `created_at DESC, id DESC` 次序）；`limit=2` 逐页遍历
 *       覆盖公开集合且无重无漏；条数读数与 `count(*)` 对账；每条 item 的字段集合与契约
 *       `Post`（`additionalProperties:false`）**恰好相等**；
 *   [D] 单条读面：字段形状；**越权与不存在同形**（他人读 hidden / deleted / 随机 uuid 三者的
 *       `error` 对象逐字相等、`meta` 除 `request_id` 外逐字相等）；作者读自己的 hidden/private 仍 200；
 *       游客 401、后台会话读社区面 403（面与面之间的权限边界）；
 *   [H] 下架处置（real 模式、真库 CAS）：200 Ack + ETag 新版本；`community_posts` 行
 *       `visibility='hidden'`、`revision` 1→2、`updated_at` 真前进、`audit_state`/正文未被动；
 *       审计台账**恰好新增一条** `post.hide`（`target_ref` 带**下架前** revision、`result:'accepted'`、
 *       `actor_id`＝该管理员）；社区可见性联动（他人列表剔除、他人详情 404、作者仍读得到 hidden、
 *       `mine=true` 仍含该帖 ⇒ 是「隐藏」不是「删除」）；
 *   [F] 失败隔离：If-Match 不符 / 缺失 / 帖子已删除 / 未公开 / 不存在 / 无 scope / 用户会话 / 游客
 *       八条被拒路径**逐条**证明「真库行逐列一字不动 + `post.hide` 审计条数不增」；
 *       并发两笔同 If-Match 的下架 ⇒ 恰好一笔成功、一笔 409，`revision` 只前进一次、审计只多一条。
 *
 * ## 未取得（如实登记，见证据页）
 *   - **库内审计**：`appendAudit` 落的是进程内只可追加台账（`adminOpsService.store.persistent === false`），
 *     重启即丢；real 模式下内容域 fail-closed ⇒ `GET /admin/audit-events` **503**（本脚本把这条
 *     如实证成读数，⛔ 不把「HTTP 读面 503」写成「审计不存在」）；
 *   - 真实审核供应商（全程注入仓内合成 gate 夹具，不联网）、真实媒体、下架后的**真实 UI**、
 *     来源 real 写面；
 *   - 运行时角色的库级最小权限面（账号/开关/作业三条既有臂已各自证明，本片的读数一律库 owner 身份）。
 *
 * ## 运行（专用测试库，必须是**空库**；脚本开头断言 `public` 下 0 张表）
 *   createdb -h 127.0.0.1 -p <port> gengyun_admin_community_posts_test
 *   node tests/integration/admin-community-posts-pg.mjs \
 *     postgres://<owner>@127.0.0.1:<port>/gengyun_admin_community_posts_test
 * 也接受 env：`ADMIN_COMMUNITY_POSTS_PG_TEST_URL`（argv 优先，与 `messages-pg.mjs` 一族同义）。
 * 未设置（且 argv 里没有 `postgres://`）⇒ 打印 `SKIP` 并以 **77** 退出：本次运行**没有**取得读数，
 * 不是通过（POSIX 惯例 skipped）；本机明知无真库时可显式 `--allow-skip` 取 0（⛔ 不得进门禁）。
 * `npm run test:integration:http` 不包含本文件（它需要真库），须显式运行。
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
const DB = 'gengyun_admin_community_posts_test';
const ENV = 'ADMIN_COMMUNITY_POSTS_PG_TEST_URL';
/** 契约 `OPS_SCOPES.hidePost`（`admin/ops/service.ts`）；本脚本不接受更宽的 scope 假设。 */
const HIDE_SCOPE = 'sources:write';
/**
 * 本脚本只 apply 它**真正依赖**的迁移（⛔ 不是 `discoverMigrations()` 全链）：
 *   0001 身份底座（`users` 与 `visibility`/`audit_state` 枚举、`linked_target_type`）；
 *   0022 社区六表——其中 `community_moderation_decisions` 是**读面的必需依赖**
 *        （`effectiveState()` 每次读取都 `store.getModeration()` 并比对 `text_digest`；缺它 ⇒ 42703 ⇒ 503）；
 *   0030 帖/评行级作者注销引用（`POST_COLUMNS` 含 `anonymized_author_ref`，缺它 ⇒ 42703 ⇒ 503）；
 *   0032 举报者行内注销引用（同一套列口径的一致性；本脚本不写举报，但保持与社区域同形）。
 * 刻意**不**引 0007（`CREATE EXTENSION pgcrypto`）等与本域无关的迁移，也不引 0028（审核**域**的
 * `moderation_decisions` 台账——本脚本的可见性判据来自社区自己的 `community_moderation_decisions`）：
 * 本脚本的读数是社区帖域，不是迁移链完整性（后者由跑全链的 `media-persistence-pg` / `ocr-jobs-pg` 等臂守住）。
 */
const MIGRATIONS = ['0001', '0022', '0030', '0032'];

const argvUrl = process.argv.slice(2).find((value) => /^postgres(ql)?:\/\//.test(value));
const rawUrl = argvUrl ?? process.env[ENV];
const ALLOW_SKIP = process.argv.includes('--allow-skip') || process.env.GY_ALLOW_SKIP === '1';
if (rawUrl === undefined || rawUrl.trim() === '') {
  console.log(`SKIP real PG17: ${ENV} 未设置（argv 里也没有 postgres URL）——本次运行没有取得后台社区帖域的真库读数（不是通过）。`);
  if (ALLOW_SKIP) {
    console.log('EXITCODE=0（--allow-skip / GY_ALLOW_SKIP=1 已显式授权：仅本机开发，⛔ 不得接进门禁）。');
    process.exit(0);
  }
  console.log('EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；显式 --allow-skip 才可取 0）。');
  process.exit(77);
}

const url = new URL(rawUrl);
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), `${ENV} 必须是 postgres URL`);
assert.equal(url.search, '', '连接参数由脚本控制，测试 URL 不带查询串');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), `只允许回环地址，实际 ${url.hostname}`);
assert.equal(url.pathname, `/${DB}`, `只允许专用测试库 ${DB}`);

let readings = 0;
const note = (message) => {
  readings += 1;
  console.log(message);
};
const detail = (message) => console.log(`      ${message}`);

const digest = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
/** 夹具时间戳：相差 1 分钟，保证 `created_at DESC` 的次第唯一确定（不靠 uuid 排序碰运气）。 */
const AT = (minutes) => new Date(Date.parse('2026-10-18T02:00:00.000Z') + minutes * 60_000).toISOString();

const openapi = JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'));
const POST_SCHEMA = openapi.components.schemas.Post;
/** 契约 `Post`（`additionalProperties:false`）：字段集合即闭集，多一列/少一列都算越界。 */
const POST_KEYS = Object.keys(POST_SCHEMA.properties).sort();
const POST_REQUIRED = [...POST_SCHEMA.required].sort();

const gate = makeGate();
const RULE_VERSION = gate.currentRuleVersion();
assert.equal(typeof RULE_VERSION, 'string', '合成规则集必须派生出当前规则版本（否则任何内容都无法公开可见）');

/** 帖子存储记录（形状照 `tests/unit/community-fixtures.mjs` 的同一套口径）。 */
const postRecord = (id, authorId, overrides = {}) => ({
  id,
  revision: 1,
  author_id: authorId,
  title: `后台社区帖真库夹具 ${overrides.tag ?? 'x'}`,
  body: `后台社区帖真库夹具正文 ${overrides.tag ?? 'x'}`,
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

/**
 * 审核结论：必须**逐条真实**（`target_ref` 对齐、`text_digest` ＝ `title\nbody` 的 sha256、
 * `rule_version` ＝ 当前合成规则版本、`contract_complete`），否则 `effectiveState()` 会在**读取时**
 * 把它降级为 `hidden`+`pending` ⇒ 列表读数的对照臂会变成恒空，整节假绿。
 */
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
    // -----------------------------------------------------------------------
    // [M] 迁移与装配
    // -----------------------------------------------------------------------
    const version = (await owner.query("SELECT current_setting('server_version') AS version")).rows[0].version;
    assert.match(version, /^17\./, `requires PostgreSQL 17，实际 ${version}`);
    const tables = (await owner.query(
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'",
    )).rows[0].n;
    assert.equal(tables, 0, '专用测试库必须是空库（本脚本会建表/灌夹具；非空库会让读数与别的脚本互相污染）');
    note(`[M] PG ${version} · 空库前提成立（public 下 0 张表）`);

    const discovered = discoverMigrations();
    const versions = discovered.map((migration) => migration.version);
    assert.equal(new Set(versions).size, versions.length, `迁移版本号重复：${versions.join(',')}`);
    for (const required of MIGRATIONS) {
      assert.ok(versions.includes(required), `迁移目录必须含 ${required}`);
    }
    const picked = discovered.filter((migration) => MIGRATIONS.includes(migration.version));
    assert.deepEqual(picked.map((migration) => migration.version), MIGRATIONS, '本脚本依赖的四段迁移必须按目录序取到');
    assert.deepEqual((await applyMigrations(owner, picked)).applied, MIGRATIONS, '四段迁移必须逐条真正应用');
    assert.equal((await applyMigrations(owner, picked)).applied.length, 0, '重跑迁移必须是 no-op');
    note(`[M] 迁移子集 ${MIGRATIONS.join('+')} 逐条 apply 成功、二连跑 0 条（目录共 ${versions.length} 个迁移，版本号无重复）`);

    const columns = (await owner.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('community_posts', 'community_moderation_decisions', 'users')`,
    )).rows;
    const columnOf = (table, name) => columns.some((row) => row.table_name === table && row.column_name === name);
    for (const [table, name] of [
      ['community_posts', 'visibility'],
      ['community_posts', 'audit_state'],
      ['community_posts', 'revision'],
      ['community_posts', 'updated_at'],
      // 0030 才有：`POST_COLUMNS` 含它 ⇒ 缺它社区域整域 503（本条把「为什么必须带 0030」变成机器读数）。
      ['community_posts', 'anonymized_author_ref'],
      // 0022 才有：读面的可见性判据（`effectiveState()`）要拿它比对结论，缺它整域 503。
      ['community_moderation_decisions', 'text_digest'],
    ]) {
      assert.equal(columnOf(table, name), true, `${table}.${name} 必须存在（否则读面 42703 ⇒ 503）`);
    }
    note('[M] 依赖列在位：community_posts.{visibility,audit_state,revision,updated_at,anonymized_author_ref} 与 community_moderation_decisions.text_digest');

    // -----------------------------------------------------------------------
    // 夹具：三个真实用户（作者 A / 他人 B / 作者 C）＋ 一条后台管理员
    // -----------------------------------------------------------------------
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
    const authorC = await account('c');

    const admin = async (loginName, scopes) => {
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
    const hideAdmin = await admin('synthetic-i18-posts-hide-admin', [HIDE_SCOPE]);
    const auditAdmin = await admin('synthetic-i18-posts-audit-admin', ['audit:read']);

    // -----------------------------------------------------------------------
    // 真库夹具：8 条帖（公开 5 / hidden 1 / deleted 1 / private+pending 1）
    // -----------------------------------------------------------------------
    pool = createPool(url.href);
    const store = createPostgresCommunityStore({ pool });
    assert.equal(store.persistent, true, 'PG 社区 store 必须自述持久化（= app.ts 的 hidePost 放行判据）');

    const P1 = postRecord(randomUUID(), authorA.user.id, {
      tag: 'wheat-a', crop_id: 'crop-wheat', region_code: '330100', created_at: AT(1), updated_at: AT(1),
    });
    const P2 = postRecord(randomUUID(), authorA.user.id, {
      tag: 'rice-a', crop_id: 'crop-rice', region_code: '330200', created_at: AT(2), updated_at: AT(2),
    });
    const P3 = postRecord(randomUUID(), otherB.user.id, {
      tag: 'wheat-b', crop_id: 'crop-wheat', region_code: '330100', created_at: AT(3), updated_at: AT(3),
    });
    const P4 = postRecord(randomUUID(), authorC.user.id, {
      tag: 'plain-c', created_at: AT(4), updated_at: AT(4),
    });
    const P5 = postRecord(randomUUID(), authorA.user.id, {
      tag: 'wheat-a-hide-me', crop_id: 'crop-wheat', region_code: '330100', created_at: AT(5), updated_at: AT(5),
    });
    const P6 = postRecord(randomUUID(), authorA.user.id, {
      tag: 'wheat-a-already-hidden', crop_id: 'crop-wheat', region_code: '330100',
      visibility: 'hidden', created_at: AT(6), updated_at: AT(6),
    });
    const P7 = postRecord(randomUUID(), authorA.user.id, {
      tag: 'wheat-a-deleted', crop_id: 'crop-wheat', region_code: '330100',
      visibility: 'deleted', created_at: AT(7), updated_at: AT(7),
    });
    const P8 = postRecord(randomUUID(), authorA.user.id, {
      tag: 'wheat-a-draft', crop_id: 'crop-wheat', region_code: '330100',
      visibility: 'private', audit_state: 'pending', created_at: AT(8), updated_at: AT(8),
    });
    const FIXTURES = [P1, P2, P3, P4, P5, P6, P7, P8];
    for (const record of FIXTURES) {
      // P8 是「刚落库、还没送审」的草稿：**不写审核结论** ⇒ 读面按无结论降级为 `pending`（fail-closed），
      // 这正是「先审后发」在读取时的口径；其余夹具写**逐条真实**的 approved 结论。
      const moderation = record === P8 ? null : verdictFor(record);
      assert.equal(await store.insertPost(record, moderation), true, `夹具帖 ${record.id} 必须落库`);
    }
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM community_posts')).rows[0].n, 8,
      '八条夹具各占一行（重复插入不得覆盖）');
    note('[L] 夹具 8 条真落 community_posts：published×5（作物/地区/作者各不相同）+ hidden×1 + deleted×1 + private+pending×1');

    // -----------------------------------------------------------------------
    // 真实装配：real 模式 + 真库池（后台走能力外壳，社区读面走真库）
    // -----------------------------------------------------------------------
    const baseConfig = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
    const realConfig = { ...baseConfig, executionMode: 'real', requiresRealCredentials: true };
    // 审核门用仓内**合成** gate 夹具（不联网、无凭据）：本脚本证的是存储/路由/审计链，不是审核供应商。
    app = buildApp({
      config: realConfig,
      store: auth,
      pool,
      now: () => new Date(),
      communityInjection: { gate },
    });
    assert.notEqual(app.communityService, null, 'real + 真 pool ⇒ 社区服务必须开启（否则读面 503，读数无效）');
    assert.notEqual(app.adminOpsService, null, 'real + 真 pool ⇒ 后台运营服务必须存在（能力外壳）');
    assert.equal(app.adminOpsService.store.persistent, false,
      '如实标注：后台审计台账仍是内存实现（persistent:false）⇒ 本脚本**不**构成「审计已落库」');

    const call = async (token, method, path, extra = {}) => {
      const response = await app.inject({
        method,
        url: path,
        headers: {
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...(extra.payload === undefined ? {} : { 'content-type': 'application/json' }),
          ...(extra.headers ?? {}),
        },
        ...(extra.payload === undefined ? {} : { payload: extra.payload }),
      });
      let body = null;
      try {
        body = response.json();
      } catch {
        body = null;
      }
      return { status: response.statusCode, headers: response.headers, body, text: response.body };
    };

    /** 下架一次（既有路由的唯一调用形态；`idempotency-key` 与 `if-match` 都是必填）。 */
    const hideOf = (id, { token = hideAdmin.token, ifMatch, key } = {}) => call(
      token,
      'POST',
      `${API}/admin/posts/${id}/hide`,
      {
        payload: { reason: '结构性文本：管理员下架违规社区帖（本脚本不评估理由内容）' },
        headers: {
          ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }),
          ...(key === undefined ? {} : { 'idempotency-key': key }),
        },
      },
    );

    const idsOf = (body) => (Array.isArray(body?.data?.items) ? body.data.items.map((item) => item.id) : null);

    /** 真库行快照（**逐列**，用于「被拒路径一字不动」；时间戳取 text 形态，避免 JS Date 丢精度）。 */
    const snapshotOf = async (id) => (await owner.query(
      `SELECT id::text AS id, revision, visibility::text AS visibility, audit_state::text AS audit_state,
              title, body, crop_id, region_code, media_ids, author_id::text AS author_id,
              anonymized_author_ref, created_at::text AS created_at, updated_at::text AS updated_at
         FROM community_posts WHERE id = $1::uuid`,
      [id],
    )).rows[0] ?? null;

    /** 审计台账（与 `GET /admin/audit-events` 同源的那一份只可追加台账）。 */
    const auditEntries = () => app.adminOpsService.store.audit.list();
    const hideAudits = (id) => auditEntries().filter((entry) => entry.action === 'post.hide' && entry.target_ref?.id === id);
    const hideAuditCount = () => auditEntries().filter((entry) => entry.action === 'post.hide').length;

    // -----------------------------------------------------------------------
    // [L] 列表读面
    // -----------------------------------------------------------------------
    /** 公开列表口径（与 `community/service.ts::listPosts` 的公开分支同条件、同序）。 */
    const sqlPublic = async ({ cropId = null, regionCode = null } = {}) => (await owner.query(
      `SELECT id::text AS id FROM community_posts
        WHERE visibility = 'published'
          AND ($1::text IS NULL OR crop_id = $1)
          AND ($2::text IS NULL OR region_code = $2)
        ORDER BY created_at DESC, id DESC`,
      [cropId, regionCode],
    )).rows.map((row) => row.id);
    /** `mine` 口径：本人 + 非删除（含 hidden / private 版本）。 */
    const sqlMine = async (userId, { cropId = null } = {}) => (await owner.query(
      `SELECT id::text AS id FROM community_posts
        WHERE author_id = $1::uuid
          AND visibility <> 'deleted'
          AND ($2::text IS NULL OR crop_id = $2)
        ORDER BY created_at DESC, id DESC`,
      [userId, cropId],
    )).rows.map((row) => row.id);

    const getList = async (path, token = otherB.token) => {
      const response = await call(token, 'GET', path);
      assert.equal(response.status, 200, `${path} ⇒ ${response.status} ${response.text.slice(0, 300)}`);
      return response.body;
    };
    const expectList = async (path, expected, token = otherB.token) => {
      const body = await getList(path, token);
      assert.deepEqual(idsOf(body), expected, `${path} 的 id 序列必须与真库同条件 SELECT 逐位相等`);
      return body;
    };

    const publicIds = await sqlPublic();
    assert.deepEqual(publicIds, [P5.id, P4.id, P3.id, P2.id, P1.id], '真库公开集合（created_at DESC）＝ P5,P4,P3,P2,P1');
    const noFilter = await expectList(`${API}/posts`, publicIds);
    assert.equal(noFilter.data.items.length, 5);
    for (const item of noFilter.data.items) {
      assert.deepEqual(Object.keys(item).sort(), POST_KEYS,
        `item 字段集合必须与契约 Post 恰好相等（现场：${Object.keys(item).join(',')}）`);
    }
    assert.deepEqual(POST_KEYS, POST_REQUIRED, '契约 Post 的 required 必须覆盖全部字段（additionalProperties:false ⇒ 闭集）');
    assert.equal(noFilter.data.next_cursor, null, '5 条 < 默认 limit=20 ⇒ 不应有 next_cursor');
    note(`[L] GET ${API}/posts ⇒ 200，5 条公开帖（hidden/deleted/private 一律不出现）；每条字段集合与契约 Post 恰好相等（${POST_KEYS.length} 列）`);

    await expectList(`${API}/posts?crop_id=crop-wheat`, [P5.id, P3.id, P1.id]);
    await expectList(`${API}/posts?crop_id=crop-rice`, [P2.id]);
    await expectList(`${API}/posts?crop_id=crop-maize`, []);
    await expectList(`${API}/posts?region_code=330100`, [P5.id, P3.id, P1.id]);
    await expectList(`${API}/posts?region_code=330200`, [P2.id]);
    await expectList(`${API}/posts?crop_id=crop-wheat&region_code=330100`, [P5.id, P3.id, P1.id]);
    await expectList(`${API}/posts?crop_id=crop-rice&region_code=330100`, []);
    note('[L] 过滤：crop_id / region_code / 组合四种形态的 id 序列与真库同条件 SELECT 逐位相等（含空集合非 404）');

    await expectList(`${API}/posts?mine=true`, await sqlMine(authorA.user.id), authorA.token);
    await expectList(`${API}/posts?mine=true`, await sqlMine(otherB.user.id), otherB.token);
    await expectList(`${API}/posts?mine=true&crop_id=crop-wheat`, await sqlMine(authorA.user.id, { cropId: 'crop-wheat' }), authorA.token);
    const mineA = await getList(`${API}/posts?mine=true`, authorA.token);
    assert.deepEqual(idsOf(mineA), [P8.id, P6.id, P5.id, P2.id, P1.id],
      'A 的 mine 集合（作者 A 的全部非删除内容：private 草稿 / hidden / 两条公开，created_at DESC）');
    assert.equal(idsOf(mineA).includes(P6.id), true, 'mine 必须含作者自己的 hidden 版本（否则「隐藏」被读成「删除」）');
    assert.equal(idsOf(mineA).includes(P7.id), false, 'mine 不得含已删除内容');
    assert.notDeepEqual(idsOf(mineA), idsOf(await getList(`${API}/posts?mine=true`, otherB.token)),
      '同一请求换主体读数必须不同（防「忽略 mine 参数」的假实现）');
    note('[L] mine=true：三个主体各自与真库同条件 SELECT 逐位相等；A 的集合含自己的 hidden/private、不含 deleted');

    /** 逐页遍历：返回 `{ pages, ids }`；同时断言每页 ≤ pageSize、游标真前进、末页 `next_cursor=null`。 */
    const walk = async (path, pageSize) => {
      const pages = [];
      const ids = [];
      let cursor = null;
      for (let guard = 0; guard < 20; guard += 1) {
        const separator = path.includes('?') ? '&' : '?';
        const body = await getList(`${path}${separator}limit=${pageSize}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
        pages.push(idsOf(body));
        ids.push(...idsOf(body));
        assert.ok(idsOf(body).length <= pageSize, `每页不得超过 limit=${pageSize}`);
        cursor = body.data.next_cursor;
        if (cursor === null) return { pages, ids };
        assert.equal(typeof cursor, 'string', 'next_cursor 必须是字符串或 null');
      }
      throw new Error(`${path} 分页超过 20 页仍未结束（游标可能不前进）`);
    };

    const publicWalk = await walk(`${API}/posts`, 2);
    assert.deepEqual(publicWalk.pages.map((page) => page.length), [2, 2, 1], 'limit=2 必须分三页：2/2/1');
    assert.deepEqual(publicWalk.ids, publicIds, '逐页拼接必须与一次性读到的公开集合逐位相等（无重、无漏、同序）');
    assert.equal(new Set(publicWalk.ids).size, publicWalk.ids.length, '分页不得出现重复行');
    const filterWalk = await walk(`${API}/posts?crop_id=crop-wheat`, 2);
    assert.deepEqual(filterWalk.ids, [P5.id, P3.id, P1.id], '带筛选的分页必须绑定同一筛选集合');
    note('[L] 分页：limit=2 逐页遍历 ＝ 2/2/1 三页，拼接结果与公开集合逐位相等（无重无漏）；带筛选的游标同样绑定筛选集');

    const counts = (await owner.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE visibility = 'published')::int AS published,
              count(*) FILTER (WHERE visibility = 'hidden')::int AS hidden,
              count(*) FILTER (WHERE visibility = 'deleted')::int AS deleted,
              count(*) FILTER (WHERE visibility = 'private')::int AS private
         FROM community_posts`,
    )).rows[0];
    assert.deepEqual(counts, { total: 8, published: 5, hidden: 1, deleted: 1, private: 1 }, '真库条数分布必须与夹具一致');
    assert.equal(publicIds.length, counts.published, '公开列表条数必须等于库内 published 条数');
    assert.notEqual(publicIds.length, counts.total, '公开列表条数必须小于库内总数（否则「过滤」只是「截断」）');
    note(`[L] 计数对账：库内 total=8 / published=5 / hidden=1 / deleted=1 / private=1；公开列表 5 条 = published，且 5 ≠ 8`);

    const badLimit = await call(otherB.token, 'GET', `${API}/posts?limit=0`);
    assert.equal(badLimit.status, 400, `limit=0 必须 400（契约 1..50），实际 ${badLimit.status}`);
    const badRegion = await call(otherB.token, 'GET', `${API}/posts?region_code=999999`);
    assert.equal(badRegion.status, 400, `region_code 越出 ^33[0-9]{4}$ 必须 400，实际 ${badRegion.status}`);
    note('[L] 参数闭集：limit=0 与 region_code=999999 都 400（筛选参数不被静默忽略）');

    // -----------------------------------------------------------------------
    // [D] 单条读面：字段 + 权限（越权/不存在同形）
    // -----------------------------------------------------------------------
    const detailOf = async (id, token = otherB.token) => call(token, 'GET', `${API}/posts/${id}`);
    const visible = await detailOf(P5.id);
    assert.equal(visible.status, 200, visible.text.slice(0, 300));
    assert.deepEqual(Object.keys(visible.body.data).sort(), POST_KEYS, '详情字段集合必须与契约 Post 恰好相等');
    assert.equal(visible.body.data.id, P5.id);
    assert.equal(visible.body.data.revision, 1);
    assert.equal(visible.body.data.visibility, 'published');
    assert.equal(visible.body.data.audit_state, 'approved');
    assert.equal(visible.body.data.crop_id, 'crop-wheat');
    assert.equal(visible.body.data.region_code, '330100');
    assert.deepEqual(visible.body.data.media_ids, []);
    assert.equal(visible.body.data.linked_knowledge_ref, null);
    assert.equal(typeof visible.body.meta.request_id, 'string', '响应必须带 meta.request_id');
    assert.equal(visible.body.meta.execution_mode, 'real', 'real 装配下 meta.execution_mode 必须如实为 real');
    note(`[D] GET ${API}/posts/{id} ⇒ 200，字段集合与契约 Post 恰好相等，execution_mode=real，revision/visibility/audit_state 与库一致`);

    const hiddenByOther = await detailOf(P6.id);
    const deletedByOther = await detailOf(P7.id);
    const unknownByOther = await detailOf(randomUUID());
    for (const [label, response] of [
      ['hidden', hiddenByOther],
      ['deleted', deletedByOther],
      ['不存在', unknownByOther],
    ]) {
      assert.equal(response.status, 404, `他人读 ${label} 必须 404，实际 ${response.status} ${response.text.slice(0, 200)}`);
      assert.equal(response.body.error.code, 'NOT_FOUND', `他人读 ${label} 的错误码必须 NOT_FOUND`);
    }
    // 同形：`error` 对象逐字相等；`meta` 除 `request_id` 外逐字相等 ⇒ 无法靠差异探测「目标是否存在」。
    assert.deepEqual(hiddenByOther.body.error, unknownByOther.body.error, 'hidden 与不存在的 error 对象必须逐字相等');
    assert.deepEqual(deletedByOther.body.error, unknownByOther.body.error, 'deleted 与不存在的 error 对象必须逐字相等');
    const metaWithoutRequestId = (body) => {
      const { request_id: _ignored, ...rest } = body.meta;
      return rest;
    };
    assert.deepEqual(metaWithoutRequestId(hiddenByOther.body), metaWithoutRequestId(unknownByOther.body), 'meta 除 request_id 外必须逐字相等');
    note(`[D] 越权/不存在同形：他人读 hidden / deleted / 随机 uuid 三者都是 404 NOT_FOUND，error 对象逐字相等、meta 除 request_id 外逐字相等`);

    const ownHidden = await detailOf(P6.id, authorA.token);
    assert.equal(ownHidden.status, 200, '作者读自己的 hidden 内容必须 200');
    assert.equal(ownHidden.body.data.visibility, 'hidden', '作者视角必须如实显示 hidden');
    const ownDraft = await detailOf(P8.id, authorA.token);
    assert.equal(ownDraft.status, 200, '作者读自己的 private 草稿必须 200');
    assert.equal(ownDraft.body.data.visibility, 'private', 'private 草稿不得被投影成 published');
    assert.equal(ownDraft.body.data.audit_state, 'pending');
    const foreignDraft = await detailOf(P8.id, otherB.token);
    assert.equal(foreignDraft.status, 404, '他人读 private 草稿必须 404');
    note('[D] 作者读自己的 hidden/private 都 200 且状态如实（hidden / private+pending）；他人读 private 草稿 404');

    const guest = await call(null, 'GET', `${API}/posts`);
    assert.equal(guest.status, 401, `游客读列表必须 401，实际 ${guest.status}`);
    assert.equal(guest.body.error.code, 'SESSION_REQUIRED');
    const adminOnCommunity = await call(hideAdmin.token, 'GET', `${API}/posts`);
    // 实测口径（如实记录）：后台令牌不是**用户会话**，社区面按「会话无效」拒绝 ⇒ 401 `SESSION_EXPIRED`。
    // （`routes/community.ts` 的头部注释写的是 403 `SCOPE_DENIED`；两者都是拒绝、都不泄露目标，
    //  本脚本只如实读数，⛔ 不改产品行为、也不替注释"修正"读数。）
    assert.equal(adminOnCommunity.status, 401, `后台会话读社区面必须被拒（实测 401），实际 ${adminOnCommunity.status}`);
    assert.equal(adminOnCommunity.body.error.code, 'SESSION_EXPIRED');
    const userOnAdmin = await call(otherB.token, 'POST', `${API}/admin/posts/${P5.id}/hide`, {
      payload: { reason: '结构性文本' },
      headers: { 'if-match': '"1"', 'idempotency-key': 'i18-posts-user-on-admin' },
    });
    assert.equal(userOnAdmin.status, 403, `用户会话调后台下架必须 403，实际 ${userOnAdmin.status}`);
    assert.equal(userOnAdmin.body.error.code, 'SCOPE_DENIED');
    note('[D] 面间权限边界：游客读列表 401 SESSION_REQUIRED；后台会话读社区面 401 SESSION_EXPIRED（后台令牌不是用户会话）；用户会话调后台下架 403 SCOPE_DENIED');

    // -----------------------------------------------------------------------
    // [H] 下架处置（real 模式、真库 CAS）
    // -----------------------------------------------------------------------
    const beforeHide = await snapshotOf(P5.id);
    const auditBefore = hideAuditCount();
    const hidden = await hideOf(P5.id, { ifMatch: '"1"', key: 'i18-posts-hide-1' });
    assert.equal(hidden.status, 200, hidden.text.slice(0, 300));
    assert.deepEqual(hidden.body.data, { accepted: true }, '契约 Ack 必须恰好是 {accepted:true}');
    assert.equal(hidden.headers.etag, '"2"', '下架把 revision 1→2 并回写 ETag');
    assert.deepEqual(hidden.body.meta.execution_mode, 'real');

    const afterHide = await snapshotOf(P5.id);
    assert.equal(afterHide.visibility, 'hidden', '真库行的 visibility 必须变成 hidden（不是只改返回值）');
    assert.equal(afterHide.revision, 2, '真库行的 revision 必须 1→2');
    assert.ok(Date.parse(afterHide.updated_at) > Date.parse(beforeHide.updated_at), 'updated_at 必须真前进');
    assert.equal(afterHide.audit_state, beforeHide.audit_state, '下架不得改写 audit_state（审核结论不是处置动作的产物）');
    assert.equal(afterHide.title, beforeHide.title, '下架不得改写标题');
    assert.equal(afterHide.body, beforeHide.body, '下架不得改写正文');
    assert.equal(afterHide.author_id, beforeHide.author_id, '下架不得改写作者');
    note(`[H] POST ${API}/admin/posts/{id}/hide ⇒ 200 {accepted:true} + ETag "2"；真库行 visibility=hidden、revision 1→2、updated_at 前进，正文/审核态/作者一字未动`);

    const newAudits = hideAudits(P5.id);
    assert.equal(newAudits.length, 1, `成功下架必须恰好新增一条 post.hide 审计（实际 ${newAudits.length}）`);
    assert.equal(hideAuditCount(), auditBefore + 1, '全部 post.hide 审计条数必须恰好 +1');
    const [audit] = newAudits;
    assert.equal(audit.action, 'post.hide');
    assert.equal(audit.scope, HIDE_SCOPE, '审计 scope 必须等于契约 OPS_SCOPES.hidePost');
    assert.equal(audit.result, 'accepted');
    assert.equal(audit.reason_code, 'post_hidden');
    assert.deepEqual(audit.target_ref, { type: 'post', id: P5.id, revision: 1 },
      'target_ref 必须带**下架前**的 revision（1），不是下架后的 2');
    assert.equal(audit.actor_id, hideAdmin.userId, '审计必须记在真正发起处置的管理员名下');
    assert.equal(typeof audit.request_id, 'string');
    assert.equal(audit.target_hint, null, 'post 在契约 TargetRef 闭集内 ⇒ 不写内部 target_hint');
    note(`[H] 审计留痕：恰好 +1 条 post.hide（scope=${audit.scope} / reason_code=${audit.reason_code} / result=${audit.result} / target_ref={post,id,revision:1} / actor=该管理员）`);

    await expectList(`${API}/posts`, [P4.id, P3.id, P2.id, P1.id]);
    assert.equal((await call(otherB.token, 'GET', `${API}/posts?crop_id=crop-wheat`)).status, 200);
    assert.deepEqual(idsOf((await call(otherB.token, 'GET', `${API}/posts?crop_id=crop-wheat`)).body), [P3.id, P1.id],
      '下架后带筛选的公开列表同样剔除该帖');
    const afterHideDetail = await detailOf(P5.id);
    assert.equal(afterHideDetail.status, 404, '下架后他人读详情必须 404');
    assert.deepEqual(afterHideDetail.body.error, unknownByOther.body.error, '下架后的 404 必须与「不存在」同形');
    const authorAfterHide = await detailOf(P5.id, authorA.token);
    assert.equal(authorAfterHide.status, 200, '作者读自己被下架的内容必须 200');
    assert.equal(authorAfterHide.body.data.visibility, 'hidden');
    assert.equal(authorAfterHide.body.data.revision, 2, '作者读到的 revision 必须是下架后的版本');
    const mineAfterHide = await getList(`${API}/posts?mine=true`, authorA.token);
    assert.equal(idsOf(mineAfterHide).includes(P5.id), true, 'mine 仍含该帖 ⇒ 是「隐藏」而不是「删除」');
    const sqlAfterHide = await sqlPublic();
    assert.deepEqual(idsOf(await getList(`${API}/posts`)), sqlAfterHide, '下架后公开列表与真库同条件 SELECT 仍然逐位相等');
    note(`[H] 社区可见性联动：他人列表剔除（含带筛选的列表）、他人详情 404 且与不存在同形、作者仍 200 且 visibility=hidden/revision=2、mine 仍含该帖`);

    const auditRead = await call(auditAdmin.token, 'GET', `${API}/admin/audit-events`);
    assert.equal(auditRead.status, 503, `real 模式下后台内容域 fail-closed ⇒ 审计 HTTP 读面必须 503，实际 ${auditRead.status}`);
    assert.equal(auditRead.body.error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(auditRead.body.error.retryable, false);
    note('[H] 如实登记：real 模式下 `GET /admin/audit-events` = 503 PROVIDER_UNAVAILABLE(retryable:false) ⇒ 审计留痕只能由进程内台账读回，**未**落库、无 HTTP 读面');

    // -----------------------------------------------------------------------
    // [F] 失败隔离：被拒路径逐条证明「真库行一字不动 + 审计不增」
    // -----------------------------------------------------------------------
    /** 每条被拒路径都做同一件事：快照 → 调用 → 断言状态/错误码 → 快照逐列相等 + 审计条数不增。 */
    const expectRejected = async ({ label, id, request, status, code }) => {
      const before = id === null ? null : await snapshotOf(id);
      const auditCountBefore = hideAuditCount();
      const response = await request();
      assert.equal(response.status, status, `${label}：期望 ${status}，实际 ${response.status} ${response.text.slice(0, 240)}`);
      assert.equal(response.body.error.code, code, `${label}：期望 ${code}，实际 ${response.body.error.code}`);
      if (id !== null) {
        assert.deepEqual(await snapshotOf(id), before, `${label}：被拒路径不得改动真库行（逐列比对）`);
      }
      assert.equal(hideAuditCount(), auditCountBefore, `${label}：被拒路径不得新增 post.hide 审计`);
      return response;
    };

    await expectRejected({
      label: 'If-Match 不符（revision 9 vs 2）',
      id: P5.id,
      request: () => hideOf(P5.id, { ifMatch: '"9"', key: 'i18-posts-hide-conflict' }),
      status: 409,
      code: 'REVISION_CONFLICT',
    });
    await expectRejected({
      label: '缺 If-Match',
      id: P5.id,
      request: () => hideOf(P5.id, { key: 'i18-posts-hide-no-ifmatch' }),
      status: 428,
      code: 'REVISION_REQUIRED',
    });
    await expectRejected({
      label: '帖子已删除（不可复活）',
      id: P7.id,
      request: () => hideOf(P7.id, { ifMatch: '"1"', key: 'i18-posts-hide-deleted' }),
      status: 409,
      code: 'OBJECT_UNAVAILABLE',
    });
    await expectRejected({
      label: '帖子未公开（private 草稿）',
      id: P8.id,
      request: () => hideOf(P8.id, { ifMatch: '"1"', key: 'i18-posts-hide-private' }),
      status: 409,
      code: 'OBJECT_UNAVAILABLE',
    });
    await expectRejected({
      label: '帖子不存在',
      id: null,
      request: () => hideOf(randomUUID(), { ifMatch: '"1"', key: 'i18-posts-hide-unknown' }),
      status: 404,
      code: 'NOT_FOUND',
    });
    await expectRejected({
      label: '缺 sources:write scope',
      id: P1.id,
      request: () => hideOf(P1.id, { token: auditAdmin.token, ifMatch: '"1"', key: 'i18-posts-hide-noscope' }),
      status: 403,
      code: 'SCOPE_DENIED',
    });
    await expectRejected({
      label: '用户会话',
      id: P1.id,
      request: () => hideOf(P1.id, { token: authorA.token, ifMatch: '"1"', key: 'i18-posts-hide-user' }),
      status: 403,
      code: 'SCOPE_DENIED',
    });
    await expectRejected({
      label: '游客（无令牌）',
      id: P1.id,
      request: () => hideOf(P1.id, { token: null, ifMatch: '"1"', key: 'i18-posts-hide-guest' }),
      status: 401,
      code: 'SESSION_REQUIRED',
    });
    note('[F] 八条被拒路径（版本不符/缺 If-Match/已删除/未公开/不存在/缺 scope/用户会话/游客）逐条：状态与错误码正确、真库行**逐列**一字不动、post.hide 审计条数不增');

    // 幂等重放：同键同体必须回放首次结果，不再推进 revision、不再记审计。
    const beforeReplay = await snapshotOf(P5.id);
    const replay = await hideOf(P5.id, { ifMatch: '"1"', key: 'i18-posts-hide-1' });
    assert.equal(replay.status, 200, `同键重放必须回放首次结果，实际 ${replay.status} ${replay.text.slice(0, 200)}`);
    assert.deepEqual(replay.body.data, { accepted: true });
    assert.equal(replay.headers.etag, '"2"', '重放必须回放首次的 ETag');
    assert.deepEqual(await snapshotOf(P5.id), beforeReplay, '重放不得再改真库行');
    assert.equal(hideAudits(P5.id).length, 1, '重放不得新增审计');
    note('[F] 幂等重放（同 idempotency-key 同体）：回放首次 200 + ETag "2"，rev 不再前进、审计不再增加');

    // 已隐藏再下架：changed:false 分支 ⇒ 200 但不是一次新处置，审计不增。
    const beforeSecond = await snapshotOf(P5.id);
    const secondHide = await hideOf(P5.id, { ifMatch: '"2"', key: 'i18-posts-hide-2' });
    assert.equal(secondHide.status, 200, `已隐藏再下架必须幂等成功，实际 ${secondHide.status}`);
    assert.deepEqual(secondHide.body.data, { accepted: true });
    assert.equal(secondHide.headers.etag, '"2"', 'changed:false 时 ETag 仍是当前版本');
    assert.deepEqual(await snapshotOf(P5.id), beforeSecond, 'changed:false 不得再改真库行');
    assert.equal(hideAudits(P5.id).length, 1, 'changed:false 不得新增审计（不把幂等成功记成一次处置）');
    note('[F] 已隐藏再下架：200 accepted、ETag 不变、rev 不变、审计不增（changed:false 不重复记处置）');

    // 并发两笔同 If-Match：真库 CAS 的原子性只能由 PG 证明。
    const beforeRace = await snapshotOf(P1.id);
    const raceAuditBefore = hideAudits(P1.id).length;
    const [raceA, raceB] = await Promise.all([
      hideOf(P1.id, { ifMatch: '"1"', key: 'i18-posts-race-a' }),
      hideOf(P1.id, { ifMatch: '"1"', key: 'i18-posts-race-b' }),
    ]);
    const raceStatuses = [raceA.status, raceB.status].sort();
    assert.deepEqual(raceStatuses, [200, 409], `并发两笔必须恰好一笔 200、一笔 409，实际 ${raceStatuses.join('/')}`
      + `（${raceA.status}:${raceA.body?.error?.code ?? 'ok'} / ${raceB.status}:${raceB.body?.error?.code ?? 'ok'}）`);
    const loser = raceA.status === 409 ? raceA : raceB;
    assert.equal(loser.body.error.code, 'REVISION_CONFLICT', '并发落败的一笔必须是 REVISION_CONFLICT（不是 500/503）');
    const afterRace = await snapshotOf(P1.id);
    assert.equal(afterRace.revision, beforeRace.revision + 1, '并发两笔只能让 revision 前进**一次**');
    assert.equal(afterRace.visibility, 'hidden');
    assert.equal(hideAudits(P1.id).length, raceAuditBefore + 1, '并发两笔只能留下**一条** post.hide 审计');
    assert.equal(hideAuditCount(), auditBefore + 2, '至此 post.hide 审计总数 = 首次 1 + 并发成功 1（被拒与幂等路径一条不记）');
    note('[F] 并发隔离：两笔同 If-Match 的下架 ⇒ 恰好一笔 200 / 一笔 409 REVISION_CONFLICT；rev 只前进一次、审计只多一条（真库 CAS 的原子性）');

    // 收尾自证：被拒路径没有留下"半写"的中间态 —— 全表逐列再核一次。
    const finalRows = (await owner.query(
      `SELECT id::text AS id, visibility::text AS visibility, revision FROM community_posts ORDER BY created_at ASC`,
    )).rows;
    assert.deepEqual(
      finalRows.map((row) => `${row.id}:${row.visibility}:${row.revision}`),
      [
        `${P1.id}:hidden:2`,
        `${P2.id}:published:1`,
        `${P3.id}:published:1`,
        `${P4.id}:published:1`,
        `${P5.id}:hidden:2`,
        `${P6.id}:hidden:1`,
        `${P7.id}:deleted:1`,
        `${P8.id}:private:1`,
      ],
      '结束后全表状态必须恰好是「两次成功下架 + 其余原样」，没有任何被拒路径留下中间态',
    );
    note('[F] 收尾自证：全表 8 行终态 = 两次成功下架（P1/P5 → hidden:2）+ 六条原样，无半写状态');

    console.log('[ALL PASS] 后台社区帖域真库臂：读面 / 单条 / 下架处置 / 失败隔离 全部读数通过');
    detail(`读数 ${readings} 组（[M]/[L]/[D]/[H]/[F]）；库内审计**未取得**（appendAudit 落进程内台账，real 下 HTTP 读面 503）`);
  } finally {
    if (app !== null) await app.close().catch(() => {});
    if (pool !== null) await pool.end().catch(() => {});
    await owner.end().catch(() => {});
  }
}

await main();
