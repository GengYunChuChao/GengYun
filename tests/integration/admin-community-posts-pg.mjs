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
 *   - 审计：R64 之后 `post.hide` 由迁移 0047 的窄口径函数在**同一事务**里写进
 *     `public.admin_audit_events`（`admin/ops/service.ts::hidePost` 按 `hideAdapter.persistent` 二选一，
 *     不再重复记内存台账），本脚本直接读真表；`post.approve` 这类尚未落库的动作仍读
 *     `appendAudit` 那份进程内台账（`app.ts:1094-1098` 让内容 store 与 ops store 共用一份）。
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
 *       `public.admin_audit_events` **恰好新增一条** `post.hide`（迁移 0047 同事务写入；`target_ref` 带
 *       **下架前** revision、`result:'accepted'`、`actor_id`＝该管理员）；社区可见性联动（他人列表剔除、
 *       他人详情 404、作者仍读得到 hidden、
 *       `mine=true` 仍含该帖 ⇒ 是「隐藏」不是「删除」）；
 *   [F] 失败隔离：If-Match 不符 / 缺失 / 帖子已删除 / 未公开 / 不存在 / 无 scope / 用户会话 / 游客
 *       八条被拒路径**逐条**证明「真库行逐列一字不动 + `post.hide` 审计条数不增」；
 *       并发两笔同 If-Match 的下架 ⇒ 恰好一笔成功、一笔 409，`revision` 只前进一次、审计只多一条。
 *
 * ## 未取得（如实登记，见证据页）
 *   - **审计读面**：`GET /admin/audit-events` 在 real 模式下仍 **503**（`adminOpsService.store.persistent
 *     === false` ⇒ 内容域 fail-closed），本片**没有**动读面闭集（`catalog.ts` 的 `AUDIT_ACTIONS` 与
 *     契约查询 enum 留给下一片）；本脚本把这条如实证成读数，⛔ 不把「HTTP 读面 503」写成「审计不存在」
 *     —— 写面已由 0047 落库，那一行就在真表里；
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
 *   0032 举报者行内注销引用（同一套列口径的一致性；本脚本不写举报，但保持与社区域同形）；
 *   0045 `community_moderation_decisions.decided_by`（**人工**审核的运营者快照，S3 新增）。缺它 ⇒
 *        通过/驳回写结论行时 42703 ⇒ 两个动作都 503 —— 第 [R] 节的读数正是"真库确实记得是谁批的"。
 *   0017 `admin_audit_events`（R64 起下架审计**真的**写这张表；缺它 ⇒ 0047 的 `CREATE FUNCTION`
 *        里那条 `INSERT` 找不到关系 ⇒ 迁移当场失败，而不是运行时才 503）；
 *   0047 `record_admin_post_hide_audit(uuid,uuid,integer,text,uuid)`（R64 的库层写：下架与审计
 *        **同一事务**，审计写不进去连帖子一起 `ROLLBACK`；缺它 ⇒ 下架路径 42883 ⇒ 503「审计写入失败」）。
 * 刻意**不**引 0007（`CREATE EXTENSION pgcrypto`）等与本域无关的迁移，也不引 0028（审核**域**的
 * `moderation_decisions` 台账——本脚本的可见性判据来自社区自己的 `community_moderation_decisions`）：
 * 本脚本的读数是社区帖域，不是迁移链完整性（后者由跑全链的 `media-persistence-pg` / `ocr-jobs-pg` 等臂守住）。
 */
const MIGRATIONS = ['0001', '0017', '0022', '0030', '0032', '0045', '0047'];

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
    assert.deepEqual(picked.map((migration) => migration.version), MIGRATIONS, '本脚本依赖的五段迁移必须按目录序取到');
    assert.deepEqual((await applyMigrations(owner, picked)).applied, MIGRATIONS, '五段迁移必须逐条真正应用');
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
      // 0045 才有：人工通过/驳回把运营者写进结论行；缺它 ⇒ 两个动作都 503（见 [R] 节）。
      ['community_moderation_decisions', 'decided_by'],
    ]) {
      assert.equal(columnOf(table, name), true, `${table}.${name} 必须存在（否则读面 42703 ⇒ 503）`);
    }
    note('[M] 依赖列在位：community_posts.{visibility,audit_state,revision,updated_at,anonymized_author_ref} 与 community_moderation_decisions.{text_digest,decided_by}');

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
      // 0047 的下架审计函数在**库里**再核一遍操作者（存在 / `state='active'` / 现行 `sources:write`），
      // 所以这里把内存账号镜像到真库：只镜像「谁存在、持有什么 scope」，凭据 hash 是合成的、不镜像。
      // ⛔ 这不是「为了让函数通过而补数据」：0047 的复核正是要挡住「进程里认了、库里不认」的账号。
      await owner.query(
        'INSERT INTO admin_accounts (id, login_name, credential_hash) VALUES ($1::uuid, $2, $3)',
        [userId, loginName, 'synthetic-not-a-real-credential-hash'],
      );
      for (const scope of scopes) {
        await owner.query('INSERT INTO admin_scopes (admin_id, scope) VALUES ($1::uuid, $2)', [userId, scope]);
      }
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

    /**
     * 进程内只可追加台账（`GET /admin/audit-events` 的同源实现）。R64 之后它**只**承载还没落库的动作
     * （`post.approve` / `post.reject` 等）；`post.hide` 已改由迁移 0047 在真库里写，下架读数一律走 DB。
     */
    const auditEntries = () => app.adminOpsService.store.audit.list();
    /**
     * 库内审计行 —— 迁移 0047 的窄口径函数写的就是这张表。列名与内存台账同名（`target_ref` 已是 jsonb
     * ⇒ pg 直接给对象），所以 [H] 的逐项断言两边可以照抄同一套口径。
     */
    const dbAuditEntries = async () => (await owner.query(
      `SELECT actor_id, action, scope, target_ref, target_hint, reason_code, request_id, result
         FROM public.admin_audit_events ORDER BY created_at, id`,
    )).rows;
    const hideAudits = async (id) => (await dbAuditEntries())
      .filter((entry) => entry.action === 'post.hide' && entry.target_ref?.id === id);
    const hideAuditCount = async () => (await dbAuditEntries()).filter((entry) => entry.action === 'post.hide').length;

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
    const auditBefore = await hideAuditCount();
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

    const newAudits = await hideAudits(P5.id);
    assert.equal(newAudits.length, 1, `成功下架必须恰好新增一条 post.hide 审计（实际 ${newAudits.length}）`);
    assert.equal(await hideAuditCount(), auditBefore + 1, '全部 post.hide 审计条数必须恰好 +1');
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
    note('[H] 读数分两半：GET /admin/audit-events = 503 PROVIDER_UNAVAILABLE(retryable:false)（读面闭集仍留给下一片）——但**写面已落库**：上面那条 post.hide 是从 public.admin_audit_events 真表读回来的，不是进程内台账');

    // -----------------------------------------------------------------------
    // [F] 失败隔离：被拒路径逐条证明「真库行一字不动 + 审计不增」
    // -----------------------------------------------------------------------
    /** 每条被拒路径都做同一件事：快照 → 调用 → 断言状态/错误码 → 快照逐列相等 + 审计条数不增。 */
    const expectRejected = async ({ label, id, request, status, code }) => {
      const before = id === null ? null : await snapshotOf(id);
      const auditCountBefore = await hideAuditCount();
      const response = await request();
      assert.equal(response.status, status, `${label}：期望 ${status}，实际 ${response.status} ${response.text.slice(0, 240)}`);
      assert.equal(response.body.error.code, code, `${label}：期望 ${code}，实际 ${response.body.error.code}`);
      if (id !== null) {
        assert.deepEqual(await snapshotOf(id), before, `${label}：被拒路径不得改动真库行（逐列比对）`);
      }
      assert.equal(await hideAuditCount(), auditCountBefore, `${label}：被拒路径不得新增 post.hide 审计`);
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
    assert.equal((await hideAudits(P5.id)).length, 1, '重放不得新增审计');
    note('[F] 幂等重放（同 idempotency-key 同体）：回放首次 200 + ETag "2"，rev 不再前进、审计不再增加');

    // 已隐藏再下架：changed:false 分支 ⇒ 200 但不是一次新处置，审计不增。
    const beforeSecond = await snapshotOf(P5.id);
    const secondHide = await hideOf(P5.id, { ifMatch: '"2"', key: 'i18-posts-hide-2' });
    assert.equal(secondHide.status, 200, `已隐藏再下架必须幂等成功，实际 ${secondHide.status}`);
    assert.deepEqual(secondHide.body.data, { accepted: true });
    assert.equal(secondHide.headers.etag, '"2"', 'changed:false 时 ETag 仍是当前版本');
    assert.deepEqual(await snapshotOf(P5.id), beforeSecond, 'changed:false 不得再改真库行');
    assert.equal((await hideAudits(P5.id)).length, 1, 'changed:false 不得新增审计（不把幂等成功记成一次处置）');
    note('[F] 已隐藏再下架：200 accepted、ETag 不变、rev 不变、审计不增（changed:false 不重复记处置）');

    // 并发两笔同 If-Match：真库 CAS 的原子性只能由 PG 证明。
    const beforeRace = await snapshotOf(P1.id);
    const raceAuditBefore = (await hideAudits(P1.id)).length;
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
    assert.equal((await hideAudits(P1.id)).length, raceAuditBefore + 1, '并发两笔只能留下**一条** post.hide 审计');
    assert.equal(await hideAuditCount(), auditBefore + 2, '至此 post.hide 审计总数 = 首次 1 + 并发成功 1（被拒与幂等路径一条不记）');
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

    // -----------------------------------------------------------------------
    // [R] 人工通过 / 驳回：真库写路径（S3-a —「社区先审后发」的审核动作变成真的）
    // -----------------------------------------------------------------------
    /**
     * 本节**只追加**读数：上面 [M]/[L]/[D]/[H]/[F] 的每条断言一字未动。
     *
     * 内存 store 证不了、只能由 PG 证的三件事：
     *   ① 运营者身份真的落进 `community_moderation_decisions.decided_by`（**迁移 0045 的列**），
     *      而且与帖子行**同一事务、同一版**（`community/store-pg.ts` 的 `writeModeration`）；
     *   ② approve 的 `private → published` 是**真库行迁移**，不是返回值的表演；
     *   ③ CAS 的原子性：同一 If-Match 并发只赢一笔，幂等重放不落第二条结论行、不动 revision。
     *
     * 位置说明：本节在 [F] 的「全表 8 行终态」自证**之后**才插入新帖 ⇒ 那条读数不受影响；
     * 本节不新增迁移（0045 已在 [M] 的迁移子集里），也不改上面的既有臂。
     */

    /** 通过一次（契约：`POST …/approve` **无请求体**；`if-match` 与 `idempotency-key` 都是必填）。 */
    const approveOf = (id, { token = hideAdmin.token, ifMatch, key } = {}) => call(
      token,
      'POST',
      `${API}/admin/posts/${id}/approve`,
      {
        headers: {
          ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }),
          ...(key === undefined ? {} : { 'idempotency-key': key }),
        },
      },
    );

    /** 驳回一次（契约：`reason_code` 是**必填**的闭集成员，见 `PostRejectionInput`）。 */
    const rejectOf = (id, { token = hideAdmin.token, ifMatch, key, reasonCode = 'spam' } = {}) => call(
      token,
      'POST',
      `${API}/admin/posts/${id}/reject`,
      {
        payload: { reason_code: reasonCode },
        headers: {
          ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }),
          ...(key === undefined ? {} : { 'idempotency-key': key }),
        },
      },
    );

    /**
     * 该帖的结论行。`community_moderation_decisions` 的主键是
     * `(target_type, target_id, target_revision)`（`0022_community_persistence.sql:172`）
     * ⇒ 每版最多一行：幂等重放与并发落败都**不得**让行数增加。
     */
    const decisionsOf = async (id) => (await owner.query(
      `SELECT target_revision, decision::text AS decision, hard_rule_passed,
              reason_codes, decided_by::text AS decided_by
         FROM public.community_moderation_decisions
        WHERE target_type = 'post' AND target_id = $1::uuid
        ORDER BY target_revision ASC`,
      [id],
    )).rows;
    const auditsOf = (action) => auditEntries().filter((entry) => entry.action === action);

    // 文案：与单测同一份「过得了硬规则层」的农事记录（不是随便写一句 —— 不过硬规则层的文案
    // 会让 approve 按设计回 422 RULE_VETOED，后面的读数就全部无意义）。
    const REVIEW_TITLE = '苗期观察记录';
    const REVIEW_BODY = '这段时间天气转凉，我记录了田间长势，准备按标签说明处理。';
    const reviewOutcome = gate.evaluate(
      { type: 'post', id: randomUUID(), revision: 1 },
      `${REVIEW_TITLE}\n${REVIEW_BODY}`,
      [],
    );
    assert.equal(reviewOutcome.hard_rule_passed, true,
      '本节文案必须过得了合成 gate 的硬规则层（否则 approve 被 422 拒绝，读数无意义）');

    // 四条新帖：R1/R2/R4 = 待审（private + pending，**不写结论行**，与 P8 同形）；
    // R3 = 已公开（用来证「通过不复活 hidden」）。
    const R1 = postRecord(randomUUID(), authorA.user.id, {
      tag: 'review-approve', visibility: 'private', audit_state: 'pending',
      title: REVIEW_TITLE, body: REVIEW_BODY, created_at: AT(20), updated_at: AT(20),
    });
    const R2 = postRecord(randomUUID(), otherB.user.id, {
      tag: 'review-reject', visibility: 'private', audit_state: 'pending',
      title: REVIEW_TITLE, body: REVIEW_BODY, created_at: AT(21), updated_at: AT(21),
    });
    const R3 = postRecord(randomUUID(), authorA.user.id, {
      tag: 'review-hidden', visibility: 'published',
      title: REVIEW_TITLE, body: REVIEW_BODY, created_at: AT(22), updated_at: AT(22),
    });
    const R4 = postRecord(randomUUID(), otherB.user.id, {
      tag: 'review-race', visibility: 'private', audit_state: 'pending',
      title: REVIEW_TITLE, body: REVIEW_BODY, created_at: AT(23), updated_at: AT(23),
    });
    for (const record of [R1, R2, R3, R4]) {
      const moderation = record === R3 ? verdictFor(record) : null;
      assert.equal(await store.insertPost(record, moderation), true, `审核臂夹具 ${record.id} 必须落库`);
    }
    assert.equal((await decisionsOf(R1.id)).length, 0, '待审帖入库时**没有**结论行（「先审」的起点）');

    // ---- ① 通过：private + pending ⇒ published + approved，且运营者落库 ----
    const approveAuditsBefore = auditsOf('post.approve').length;
    const approveRes = await approveOf(R1.id, { ifMatch: '"1"', key: 'i18-posts-approve-1' });
    assert.equal(approveRes.status, 200, `通过必须 200，实际 ${approveRes.status} ${approveRes.text.slice(0, 240)}`);
    assert.deepEqual(Object.keys(approveRes.body.data).sort(),
      Object.keys(openapi.components.schemas.PostReviewOutcome.properties).sort(),
      '回执字段集合必须与契约 PostReviewOutcome 逐字相等（不多不少）');
    assert.equal(approveRes.body.data.id, R1.id);
    assert.equal(approveRes.body.data.revision, 2, '通过把 revision 1→2');
    assert.equal(approveRes.body.data.audit_state, 'approved');
    assert.equal(approveRes.body.data.visibility, 'published', '通过同时承担发布语义（private → published）');
    assert.equal(approveRes.body.data.decision, 'approved');
    assert.equal(approveRes.body.data.changed, true);
    assert.equal(approveRes.body.data.notified, false,
      '本臂迁移子集里没有 0019 的消息表 ⇒ 通知如实为 false（不假装通知成功）');
    assert.deepEqual(approveRes.body.data.reason_codes, []);
    assert.equal(approveRes.headers.etag, '"2"', '通过把 revision 1→2 并回写 ETag');
    assert.deepEqual(approveRes.body.meta.execution_mode, 'real');

    const r1After = await snapshotOf(R1.id);
    assert.equal(r1After.visibility, 'published', '真库行必须 private → published（不是只改返回值）');
    assert.equal(r1After.audit_state, 'approved');
    assert.equal(r1After.revision, 2);
    assert.equal(r1After.title, R1.title, '通过不得改写标题');
    assert.equal(r1After.body, R1.body, '通过不得改写正文');
    assert.equal(r1After.author_id, authorA.user.id, '通过不得改写作者');

    const r1Decisions = await decisionsOf(R1.id);
    assert.equal(r1Decisions.length, 1, '通过后该帖恰好一条结论行');
    assert.equal(r1Decisions[0].target_revision, 2, '结论行绑定**结论生效**的那一版（2），不是送审版（1）');
    assert.equal(r1Decisions[0].decision, 'approved');
    assert.equal(r1Decisions[0].hard_rule_passed, true, 'approved ⇒ hard_rule_passed 必须 true');
    assert.deepEqual(r1Decisions[0].reason_codes, [], 'approved 不得带理由码');
    assert.equal(r1Decisions[0].decided_by, hideAdmin.userId,
      'decided_by 必须是发起该动作的管理员 id（0045 的列 —— 进程内台账替代不了的留痕）');
    assert.equal(auditsOf('post.approve').length, approveAuditsBefore + 1, '成功通过恰好新增一条 post.approve 审计');
    note('[R] 通过：private+pending ⇒ published+approved（rev 1→2、ETag "2"）；真库结论行 target_revision=2、decision=approved、decided_by=该管理员；post.approve 审计 +1');

    assert.equal((await detailOf(R1.id)).status, 200, '通过后他人读得到（公开读面要求 published 且 approved，两条都真变了）');
    assert.equal((await detailOf(R1.id, authorA.token)).body.data.visibility, 'published');
    assert.equal(idsOf(await getList(`${API}/posts`)).includes(R1.id), true, '通过后出现在公开列表');
    note('[R] 通过后的可见性：他人详情 200、公开列表含该帖、作者读到 visibility=published');

    // ---- ② 幂等重放：同一动作再来一次（带当前 If-Match）⇒ changed:false，不落第二行 ----
    const approveReplay = await approveOf(R1.id, { ifMatch: '"2"', key: 'i18-posts-approve-2' });
    assert.equal(approveReplay.status, 200,
      `已通过再通过必须幂等成功，实际 ${approveReplay.status} ${approveReplay.text.slice(0, 240)}`);
    assert.equal(approveReplay.body.data.changed, false, '已通过且已公开 ⇒ changed:false，而不是再迁一版');
    assert.equal(approveReplay.headers.etag, '"2"', 'changed:false 时 ETag 仍是当前版本');
    assert.deepEqual(await snapshotOf(R1.id), r1After, '幂等重放不得再改真库行（逐列相等）');
    assert.equal((await decisionsOf(R1.id)).length, 1, '幂等重放不得落第二条结论行（PK 同一版）');
    assert.equal(auditsOf('post.approve').length, approveAuditsBefore + 1, '幂等重放不得新增审计（不把幂等成功记成一次处置）');
    note('[R] 幂等重放：200 changed:false、ETag "2"、真库行逐列不变、结论行仍 1 条、审计不增');

    // ---- ③ CAS 负例：拿旧版去通过 ⇒ 409，且一行不动 ----
    const staleApprove = await approveOf(R1.id, { ifMatch: '"1"', key: 'i18-posts-approve-stale' });
    assert.equal(staleApprove.status, 409, `旧 If-Match 必须 409，实际 ${staleApprove.status}`);
    assert.equal(staleApprove.body.error.code, 'REVISION_CONFLICT');
    assert.deepEqual(await snapshotOf(R1.id), r1After, 'CAS 落败不得改动真库行');
    assert.equal((await decisionsOf(R1.id)).length, 1, 'CAS 落败不得落结论行');
    note('[R] CAS 负例：旧版 If-Match ⇒ 409 REVISION_CONFLICT，真库行与结论行一字不动');

    // ---- ④ 驳回：private + pending ⇒ hidden + rejected，理由码原样落库 ----
    const rejectRes = await rejectOf(R2.id, {
      ifMatch: '"1"', key: 'i18-posts-reject-1', reasonCode: 'misleading_agronomy',
    });
    assert.equal(rejectRes.status, 200, `驳回必须 200，实际 ${rejectRes.status} ${rejectRes.text.slice(0, 240)}`);
    assert.equal(rejectRes.body.data.id, R2.id);
    assert.equal(rejectRes.body.data.decision, 'rejected');
    assert.equal(rejectRes.body.data.audit_state, 'rejected');
    assert.equal(rejectRes.body.data.visibility, 'hidden', '驳回 ⇒ 不可公开：visibility 必须 hidden');
    assert.equal(rejectRes.body.data.revision, 2);
    assert.equal(rejectRes.body.data.changed, true);
    assert.deepEqual(rejectRes.body.data.reason_codes, ['misleading_agronomy'], '理由码必须原样回执');
    assert.equal(rejectRes.headers.etag, '"2"');

    const r2After = await snapshotOf(R2.id);
    assert.equal(r2After.visibility, 'hidden');
    assert.equal(r2After.audit_state, 'rejected');
    assert.equal(r2After.revision, 2);
    const r2Decisions = await decisionsOf(R2.id);
    assert.equal(r2Decisions.length, 1);
    assert.equal(r2Decisions[0].target_revision, 2);
    assert.equal(r2Decisions[0].decision, 'rejected');
    assert.equal(r2Decisions[0].hard_rule_passed, false, 'rejected ⇒ hard_rule_passed 必须 false（Review 的硬约束）');
    assert.deepEqual(r2Decisions[0].reason_codes, ['misleading_agronomy'], '理由码必须落进结论行（不是只回执）');
    assert.equal(r2Decisions[0].decided_by, hideAdmin.userId, '驳回同样留运营者快照');
    assert.equal((await detailOf(R2.id, otherB.token)).body.data.visibility, 'hidden', '作者读到自己被驳回的帖子仍是 200 + hidden');
    assert.equal((await detailOf(R2.id, authorA.token)).status, 404, '他人的会话读不到被驳回的帖子');
    note('[R] 驳回：private+pending ⇒ hidden+rejected（rev 1→2）；结论行 decision=rejected、hard_rule_passed=false、reason_codes=["misleading_agronomy"]、decided_by=该管理员；作者 200/他人 404');

    // ---- ⑤ 不翻案：通过**不得**把已下架（hidden）的帖子复活 ----
    const r3HiddenRes = await hideOf(R3.id, { ifMatch: '"1"', key: 'i18-posts-review-hide-1' });
    assert.equal(r3HiddenRes.status, 200, `先下架必须 200，实际 ${r3HiddenRes.status}`);
    const r3AfterHide = await snapshotOf(R3.id);
    assert.equal(r3AfterHide.visibility, 'hidden');
    const resurrect = await approveOf(R3.id, { ifMatch: '"2"', key: 'i18-posts-approve-hidden' });
    assert.equal(resurrect.status, 200, `对已下架的帖子通过必须幂等成功，实际 ${resurrect.status}`);
    assert.equal(resurrect.body.data.changed, false, '下架是单向门：通过不得为它翻案');
    assert.equal(resurrect.body.data.visibility, 'hidden');
    assert.deepEqual(await snapshotOf(R3.id), r3AfterHide, '不复活：真库行一字不动');
    note('[R] 不翻案：已 hidden 的帖子再通过 ⇒ 200 changed:false、visibility 仍 hidden、真库行一字不动');

    // ---- ⑥ 并发：两笔同 If-Match 的通过 ⇒ 恰好一笔 200 / 一笔 409，结论行只有一条 ----
    const [raceApproveA, raceApproveB] = await Promise.all([
      approveOf(R4.id, { ifMatch: '"1"', key: 'i18-posts-approve-race-a' }),
      approveOf(R4.id, { ifMatch: '"1"', key: 'i18-posts-approve-race-b' }),
    ]);
    const raceApproveStatuses = [raceApproveA.status, raceApproveB.status].sort();
    assert.deepEqual(raceApproveStatuses, [200, 409],
      `并发两笔通过必须恰好一笔 200、一笔 409，实际 ${raceApproveStatuses.join('/')}`
      + `（${raceApproveA.status}:${raceApproveA.body?.error?.code ?? 'ok'} /`
      + ` ${raceApproveB.status}:${raceApproveB.body?.error?.code ?? 'ok'}）`);
    const approveLoser = raceApproveA.status === 409 ? raceApproveA : raceApproveB;
    assert.equal(approveLoser.body.error.code, 'REVISION_CONFLICT', '并发落败的一笔必须是 REVISION_CONFLICT（不是 500/503）');
    const r4After = await snapshotOf(R4.id);
    assert.equal(r4After.revision, 2, '并发两笔只能让 revision 前进**一次**');
    assert.equal(r4After.visibility, 'published');
    assert.equal((await decisionsOf(R4.id)).length, 1, '并发两笔只能留下**一条**结论行（真库 CAS 的原子性）');
    note('[R] 并发隔离：两笔同 If-Match 的通过 ⇒ 恰好一笔 200 / 一笔 409 REVISION_CONFLICT；rev 只前进一次、结论行只一条');
    note(`[R] 全节读数：审核臂 4 条新帖 + ${auditsOf('post.approve').length} 条 post.approve 审计；结论行由 community_moderation_decisions 逐列核对`);

    // -----------------------------------------------------------------------
    // [U] 下架后四类读面**立即**同步 + 无缓存复活路径（issue #18 的末项读数）
    // -----------------------------------------------------------------------
    /**
     * 本节**只追加**读数：上面 [M]/[L]/[D]/[H]/[F] 的每一条断言一字未动。
     *
     * 补的是 issue #18「下架后详情/列表/收藏/消息同步」：
     *   ① 下架**立即**（同一进程、同一个 pg pool、无 sleep、无重连）对四类读面生效；
     *   ② 不存在"缓存复活"路径 —— 用**下架前捕获的 ETag** 去打条件请求，不得出现 304。
     *
     * ## 为什么另建一个 app 实例（同进程 / 同 pool / 同内存 auth store）
     * 第 [M] 节的迁移子集刻意不含 0028（审核域台账），而 `real` 模式的审核域是 fail-closed 的
     * （`app.ts:879-895`：未接真实 tms/ims ⇒ 没有明确放行结论），于是 `community/service.ts` 的
     * `requireDomainClearance`（`community/service.ts:407` 起）会把**任何**投稿判成 422
     * `INPUT_UNCERTAIN` —— 那样永远拿不到"一条公开的帖"，也就无从证明"下架前能看到"。
     * 所以这个实例显式关掉**审核域联动**（`communityInjection.moderation: null`，
     * `app.ts:533` 就是为这种对照提供的开关）。
     *
     * 关掉审核域联动**不削弱**本节要证的链路：下架通知走另一条线 —— `app.ts:1277` 在交给
     * 后台的社区 store 上套 `withTakedownObserver`（`community/takedown.ts:58-95`），与本开关无关；
     * 消息的可用性则来自 `messages/reference-community.ts:45-59` 的**读时重查**端口。
     *
     * 另两处注入同样是**本域之外**的替身，逐条标注：
     *   - `communityInjection.gate`：合成审核闸门（与第 [M] 节**同一个实例**），不联网、无凭据；
     *   - `privacyInjection.consent`：投稿面的 `public_posting` 授权闸（`routes/community.ts:417-423`）
     *     依赖 `0003`/`0009` 的授权表，**不在**本臂迁移子集内；本读数与授权域无关，故注入放行替身
     *     （类型见 `app.ts:447-452`：`consent?: ConsentGate`，该键注释即"仅测试或已核验的读取口"）。
     */
    // 0018（收藏/历史）与 0019（消息）是本节的**真实依赖**：缺表 ⇒ 读面 42703 ⇒ 503，
    // 那样的读数不能证明"读面看不到该帖"。两段只 FK 到 `public.users`（0018:48/73、0019:51），
    // 与已应用的 0001 组合即可，且台账 `schema_migrations` 只追加，先前五段不受影响。
    // ⛔ 刻意**不加** 0008（`idempotency_keys`）：那张表只服务 `PUT /messages/{id}/read` 的
    // 幂等台账（`messages/service.ts:169-207` → `messages/store-pg.ts:349-420`），而"下架后消息同步"
    // 走的是 `appendMessage`（`messages/service.ts:422-444`：`findByEventKey` 查的是 `public.messages`，
    // 不碰台账）。本节不依赖它 ⇒ 不把无依赖的迁移算进子集。
    const EXTRA_MIGRATIONS = ['0018', '0019'];
    const extraPicked = discovered.filter((migration) => EXTRA_MIGRATIONS.includes(migration.version));
    assert.deepEqual(extraPicked.map((migration) => migration.version), EXTRA_MIGRATIONS,
      '收藏/消息两段迁移必须按目录序取到（本节依赖 0019 的 messages 表与 0018 的 favorites 表）');
    assert.deepEqual((await applyMigrations(owner, extraPicked)).applied, EXTRA_MIGRATIONS,
      '0018/0019 必须逐条真正应用');
    const extraTables = (await owner.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('messages', 'favorites', 'history')
        ORDER BY table_name`,
    )).rows.map((row) => row.table_name);
    assert.deepEqual(extraTables, ['favorites', 'history', 'messages'],
      '收藏/消息两个读面的表必须在位（否则本节读到的是 503，而不是"看不到该帖"）');
    note('[U] 追加迁移 0018+0019：messages/favorites/history 三表在位 ⇒ 收藏与消息两个读面能如实回答（不是 503）');

    const primaryApp = app;
    let syncApp = null;
    try {
      syncApp = buildApp({
        config: realConfig,
        store: auth,
        pool,
        now: () => new Date(),
        communityInjection: { gate, moderation: null },
        privacyInjection: { consent: () => async () => {} },
      });
      assert.notEqual(syncApp.messagesService, null,
        'real + 真 pool ⇒ 消息持久存储必须接线（否则 GET /messages 503，本节读数无效）');
      assert.notEqual(syncApp.favoritesService, null,
        'real + 真 pool ⇒ 收藏域必须接线（否则 GET /favorites 503，收藏读面无法读数）');
      assert.notEqual(syncApp.communityService, null, '社区服务必须在（读面）');
      assert.equal(typeof syncApp.communityService.visibility?.isPubliclyVisible, 'function',
        '社区公开可读判据必须在：它是消息域"读时重查"的唯一来源（messages/reference-community.ts:18-19）');
      // 复用同一个 `call()`（同形注入、同形 headers），⛔ 不复制辅助函数。
      app = syncApp;

      // ---- ① 走真实写面建一条帖：POST /posts（契约 createPost）⇒ 201 ----
      // 只追加、不改既有 import 行：本节要的干净文本从**同一份**权威夹具模块动态取，
      // ⛔ 不复制字符串、不新增依赖（`CLEAN_TITLE`/`CLEAN_BODY` 见 `tests/unit/community-fixtures.mjs:86-87`）。
      const { CLEAN_BODY, CLEAN_TITLE } = await import('../unit/community-fixtures.mjs');
      // 先用**同一个**合成闸门预演一次：让 201 的前提是"干净文本真被放行"，而不是碰巧。
      const cleanOutcome = gate.evaluate({ type: 'post', id: randomUUID(), revision: 1 }, `${CLEAN_TITLE}\n${CLEAN_BODY}`, []);
      assert.equal(cleanOutcome.publishable, true, '合成闸门必须放行无命中的干净文本（否则 201 无从谈起）');
      const created = await call(authorA.token, 'POST', `${API}/posts`, {
        payload: { title: CLEAN_TITLE, body: CLEAN_BODY, media_ids: [] },
        headers: { 'idempotency-key': 'i18-unpublish-create-1' },
      });
      assert.equal(created.status, 201, `POST ${API}/posts ⇒ ${created.status} ${created.text.slice(0, 400)}`);
      const livePostId = created.body.data.id;
      assert.equal(typeof livePostId, 'string');
      assert.equal(created.body.data.revision, 1, '新建帖的初始版本必须是 1');
      assert.equal(created.body.data.visibility, 'published', '干净文本 + 未接审核域联动 ⇒ 落 published');
      assert.equal(created.body.data.audit_state, 'approved');
      assert.equal(created.headers.etag, '"1"', '真实写面回写强 ETag "<revision>"（routes/community.ts:212-221）');
      assert.equal(created.headers['cache-control'], 'no-store',
        'onRequest 钩子让成功与失败响应都带 no-store（routes/community.ts:182 的 noStoreHook）');
      const createdRow = await snapshotOf(livePostId);
      assert.equal(createdRow.visibility, 'published', '库内同一行必须是 published（不是只在响应里）');
      assert.equal(createdRow.revision, 1);
      assert.equal(createdRow.author_id, authorA.user.id, '作者取会话主体，不取入参');
      note(`[U] 真实写面建帖：POST ${API}/posts ⇒ 201（published/approved，revision=1，ETag "1"，no-store）；库内同一行 published:1`);

      // ---- ② 下架前基线：四类读面都能看到它（或结构上不可能持有它） ----
      const detailBefore = await call(otherB.token, 'GET', `${API}/posts/${livePostId}`);
      assert.equal(detailBefore.status, 200, detailBefore.text.slice(0, 300));
      assert.equal(detailBefore.headers.etag, '"1"', '详情是资源表示 ⇒ 强 ETag "<revision>"（routes/community.ts:224-231）');
      assert.equal(detailBefore.headers['cache-control'], 'no-store', '详情同样 no-store');
      assert.equal(detailBefore.headers['last-modified'], undefined, '不得给可复用的 Last-Modified');
      /** 下架**前**捕获的验证器：下架后拿它打条件请求，见 ④。 */
      const preHideEtag = detailBefore.headers.etag;

      const listBefore = await call(otherB.token, 'GET', `${API}/posts`);
      assert.equal(listBefore.status, 200);
      assert.equal(idsOf(listBefore.body).includes(livePostId), true, '下架前他人列表必须含该帖');
      assert.equal(listBefore.headers.etag, undefined, '契约明写"列表无此头"（routes/community.ts:202-210）');
      assert.equal(listBefore.headers['last-modified'], undefined, '列表也不得给可复用的 Last-Modified');
      assert.equal(listBefore.headers['cache-control'], 'no-store');

      const favBefore = await call(authorA.token, 'GET', `${API}/favorites`);
      assert.equal(favBefore.status, 200, favBefore.text.slice(0, 300));
      assert.deepEqual(favBefore.body.data.items, [], '夹具主体没有收藏行');
      assert.equal(favBefore.headers['cache-control'], 'no-store', '收藏列表全响应 no-store（routes/favorites.ts:89-92）');
      assert.equal(favBefore.headers.etag, undefined, '收藏列表不给 ETag（只有单条 POST 才回写）');
      const FAVORITE_TYPES = openapi.components.schemas.FavoriteTarget.properties.type.enum;
      assert.deepEqual([...FAVORITE_TYPES], ['species', 'herbicide', 'scheme'],
        '契约 FavoriteTarget.type 闭集只有资料类型（favorites/types.ts:24 同口径）');
      assert.equal(FAVORITE_TYPES.includes('post'), false,
        '收藏读面结构上不可能持有社区帖 ⇒ 下架不涉及该面，也没有任何收藏残留可"复活"');
      assert.equal(JSON.stringify(favBefore.body).includes(livePostId), false, '收藏读面里不得出现该帖 id');

      const msgBefore = await call(authorA.token, 'GET', `${API}/messages`);
      assert.equal(msgBefore.status, 200, msgBefore.text.slice(0, 300));
      const msgRowsBefore = msgBefore.body.data.items.filter((item) => item.target_ref?.id === livePostId);
      assert.equal(msgRowsBefore.length, 1,
        '建帖时投递的 moderation_result 必须落成**恰好一条**消息（community/events.ts:164-196 + messages/service.ts:422-444 同键去重）');
      const liveMessage = msgRowsBefore[0];
      assert.equal(liveMessage.type, 'moderation', '社区域只产出 comment/like/moderation（community/events.ts:136-140）');
      assert.deepEqual(liveMessage.target_ref, { type: 'post', id: livePostId, revision: 1 });
      assert.equal(liveMessage.reference_state, 'available',
        '下架前目标当前公开可读 ⇒ available（messages/reference-community.ts:49-59）');
      assert.equal(msgBefore.headers['cache-control'], 'no-store', '消息三个操作都挂 no-store（routes/messages.ts:21-23）');
      assert.equal(msgBefore.headers.etag, undefined, '消息列表不给 ETag');
      assert.equal(msgBefore.headers['last-modified'], undefined);
      const unreadBefore = await call(authorA.token, 'GET', `${API}/messages/unread-count`);
      assert.equal(unreadBefore.status, 200);
      assert.equal(unreadBefore.body.data.count,
        msgBefore.body.data.items.filter((item) => item.read_at === null).length,
        '未读数是派生量（messages/service.ts:349-352 现算）⇒ 必须等于列表里 read_at=null 的条数');
      note(`[U] 下架前基线：详情 200 + ETag ${preHideEtag}（no-store）/ 列表含该帖且无 ETag、无 Last-Modified / 收藏 200 空集且闭集不含 post / 消息 ${msgRowsBefore.length} 条 reference_state=available（未读 ${unreadBefore.body.data.count}）`);

      // ---- ③ 走真实处置端点下架（scope sources:write，If-Match = 当前版本） ----
      const hideLive = await hideOf(livePostId, { ifMatch: preHideEtag, key: 'i18-unpublish-hide-1' });
      assert.equal(hideLive.status, 200, hideLive.text.slice(0, 300));
      assert.deepEqual(hideLive.body.data, { accepted: true }, '契约 Ack 必须恰好是 {accepted:true}');
      assert.equal(hideLive.headers.etag, '"2"', '下架把 revision 1→2 并回写 ETag');

      // ---- ④ 下架后**立即**四类读面：同一进程、同一个 pool、没有任何等待或重连 ----
      const detailAfter = await call(otherB.token, 'GET', `${API}/posts/${livePostId}`);
      assert.equal(detailAfter.status, 404, `下架后他人读详情必须立即 404，实际 ${detailAfter.status}`);
      assert.notEqual(detailAfter.status, 304, '不得用 304 回放旧表示');
      assert.equal(detailAfter.body.error.code, 'NOT_FOUND');
      assert.deepEqual(detailAfter.body.error, unknownByOther.body.error, '下架后的 404 必须与"不存在"逐字同形（不泄露存在性）');
      assert.equal(detailAfter.headers['cache-control'], 'no-store',
        '连 404 也带 no-store（onRequest 钩子对成功与失败一视同仁）');
      assert.equal(detailAfter.headers.etag, undefined, '已不可读的资源不得再给强 ETag（没有"当前版本"可指）');

      // 缓存复活反证 A：拿**下架前**捕获的 ETag 打条件请求 ⇒ 必须仍是 404，绝不是 304。
      const detailRevalidate = await call(otherB.token, 'GET', `${API}/posts/${livePostId}`, {
        headers: { 'if-none-match': preHideEtag },
      });
      assert.equal(detailRevalidate.status, 404,
        `带下架前 ETag(${preHideEtag}) 的条件请求必须 404，实际 ${detailRevalidate.status}`);
      assert.notEqual(detailRevalidate.status, 304,
        '全仓无 if-none-match 读取点（ETag 只写不读）⇒ 条件请求不得被当成缓存命中');
      assert.equal(detailRevalidate.headers.etag, undefined);
      assert.equal(detailRevalidate.headers['cache-control'], 'no-store');

      // 缓存复活反证 B：作者自己的详情仍是 200，但版本已前进 ⇒ 旧验证器不可能命中任何可读状态。
      const authorAfterU = await call(authorA.token, 'GET', `${API}/posts/${livePostId}`);
      assert.equal(authorAfterU.status, 200, '作者读自己被下架的内容必须 200（隐藏不是删除）');
      assert.equal(authorAfterU.body.data.visibility, 'hidden');
      assert.equal(authorAfterU.body.data.revision, 2, '读到的是下架后的版本');
      assert.equal(authorAfterU.headers.etag, '"2"', 'ETag 绑 revision（routes/community.ts:32-46）');
      assert.notEqual(authorAfterU.headers.etag, preHideEtag, '下架前后不得共用同一个强 ETag');
      const authorRevalidate = await call(authorA.token, 'GET', `${API}/posts/${livePostId}`, {
        headers: { 'if-none-match': preHideEtag },
      });
      assert.equal(authorRevalidate.status, 200, '旧验证器在作者视角也必须 200 全量返回（不得 304）');
      assert.notEqual(authorRevalidate.status, 304);

      const listAfter = await call(otherB.token, 'GET', `${API}/posts`);
      assert.equal(listAfter.status, 200);
      assert.equal(idsOf(listAfter.body).includes(livePostId), false, '下架后列表必须立即剔除该帖');
      assert.deepEqual(idsOf(listAfter.body), await sqlPublic(), '仍与真库同条件 SELECT 逐位相等（读时重查，无缓存层）');
      assert.equal(listAfter.headers.etag, undefined);
      assert.equal(listAfter.headers['last-modified'], undefined);
      assert.equal(listAfter.headers['cache-control'], 'no-store');
      const listAgain = await call(otherB.token, 'GET', `${API}/posts`);
      assert.deepEqual(idsOf(listAgain.body), idsOf(listAfter.body),
        '同进程内连续两次读取必须一致（不存在"第一次读到旧缓存"的假同步）');
      const listRevalidate = await call(otherB.token, 'GET', `${API}/posts`, { headers: { 'if-none-match': preHideEtag } });
      assert.equal(listRevalidate.status, 200);
      assert.notEqual(listRevalidate.status, 304);
      assert.equal(idsOf(listRevalidate.body).includes(livePostId), false, '带旧验证器的列表请求也不得把它带回来');

      const favAfter = await call(authorA.token, 'GET', `${API}/favorites`);
      assert.equal(favAfter.status, 200);
      assert.deepEqual(favAfter.body.data.items, [], '收藏读面仍为空');
      assert.equal(JSON.stringify(favAfter.body).includes(livePostId), false,
        '下架后收藏读面不得出现该帖 id（也不存在"下架前收藏过"的路径：闭集不含 post）');
      assert.equal(favAfter.headers['cache-control'], 'no-store');

      const msgAfter = await call(authorA.token, 'GET', `${API}/messages`);
      assert.equal(msgAfter.status, 200);
      const msgRowsAfter = msgAfter.body.data.items.filter((item) => item.target_ref?.id === livePostId);
      const sameMessage = msgRowsAfter.find((item) => item.id === liveMessage.id);
      assert.ok(sameMessage !== undefined, '同一条消息（同一个 id）必须仍在列表里 ⇒ 没有"下架即删消息"的假同步');
      assert.equal(sameMessage.reference_state, 'unavailable',
        '下架后同一条消息的目标立即不可得：可用性由读时重查派生（messages/reference-community.ts:18-19）');
      assert.deepEqual(sameMessage.target_ref, liveMessage.target_ref,
        'reference_state 变了、target_ref 一字未变 ⇒ 是同一引用的重算，不是换了一条消息');
      assert.equal(sameMessage.revision, liveMessage.revision, '消息行自身的 revision 不因目标下架而变（可用性不是存储字段）');
      const takedownMessages = msgRowsAfter.filter((item) => item.id !== liveMessage.id);
      assert.equal(takedownMessages.length, 1, '下架本身也向作者投递一条消息（community/takedown.ts:77-92，去重键带 reason）');
      assert.equal(takedownMessages[0].type, 'moderation', 'takedown 在契约里就是 moderation，不虚构 system（community/events.ts:129-140）');
      assert.equal(takedownMessages[0].reference_state, 'unavailable', '新投递的下架通知同样立即不可跳转（目标已 hidden）');
      assert.deepEqual(takedownMessages[0].target_ref, { type: 'post', id: livePostId, revision: 1 },
        'takedown 的 target.revision 取**下架前**那一版（community/takedown.ts:49-57/85）');
      assert.equal(msgRowsAfter.every((item) => item.reference_state === 'unavailable'), true);
      assert.equal(msgAfter.headers['cache-control'], 'no-store');
      const unreadAfter = await call(authorA.token, 'GET', `${API}/messages/unread-count`);
      assert.equal(unreadAfter.body.data.count, unreadBefore.body.data.count + 1,
        '未读数是派生量：下架通知让它恰好 +1（同键重放不会再加）');

      // ---- ⑤ 库内状态必须与读面一致（不是"接口说没了、库里还 published"） ----
      const rowAfter = await snapshotOf(livePostId);
      assert.equal(rowAfter.visibility, 'hidden', '库内必须是 hidden');
      assert.equal(rowAfter.revision, 2);
      assert.equal(rowAfter.title, CLEAN_TITLE, '下架不得改写标题');
      assert.equal(rowAfter.body, CLEAN_BODY, '下架不得改写正文');
      const messageRows = (await owner.query(
        `SELECT id::text AS id, type::text AS type, event_key,
                target_ref->>'id' AS target_id, (target_ref->>'revision')::int AS target_revision
           FROM public.messages WHERE owner_id = $1::uuid ORDER BY created_at ASC, id ASC`,
        [authorA.user.id],
      )).rows;
      const liveRows = messageRows.filter((row) => row.target_id === livePostId);
      assert.equal(liveRows.length, 2, '库内该帖的消息恰好两条（moderation_result + takedown，同键去重 ⇒ 不会更多）');
      assert.equal(liveRows.every((row) => row.type === 'moderation'), true, '两条都是 moderation 类');
      assert.equal(liveRows.every((row) => row.target_revision === 1), true, '两条都指向**下架前**那一版');
      assert.equal(liveRows.some((row) => row.event_key === `community:takedown:post:${livePostId}:r1:admin_hide`), true,
        'takedown 去重键＝community:<event>:<type>:<id>:r<revision>:<reason 前 80 字>（community/events.ts:100-118）');
      assert.equal(liveRows.some((row) => row.event_key === `community:moderation_result:post:${livePostId}:r1:approved`), true);
      const mineAfterUnpublish = await getList(`${API}/posts?mine=true`, authorA.token);
      assert.equal(idsOf(mineAfterUnpublish).includes(livePostId), true,
        '作者 mine 仍含该帖 ⇒ 处置是「隐藏」不是「删除」（与 [H] 同口径，独立再证一次）');
      note(`[U] 库内对账：community_posts.visibility=hidden / revision=2 / 正文未动；public.messages 该帖恰好两条（target revision 均为 1，event_key 含 takedown:…:admin_hide）`);
      note('[U] 下架后四类读面**立即**同步：详情 404（与不存在同形）/ 列表剔除且与真库 SELECT 相等 / 收藏空集（闭集不含 post）/ 消息同一条 reference_state available→unavailable；用下架前 ETag 打条件请求 ⇒ 404 与 200 全量，**零 304**');
    } finally {
      // 交回既有 `finally`：它关的是第一个实例；这里只负责关本节新建的那个。
      app = primaryApp;
      if (syncApp !== null) await syncApp.close().catch(() => {});
    }

    console.log('[ALL PASS] 后台社区帖域真库臂：读面 / 单条 / 下架处置 / 人工通过驳回 / 失败隔离 全部读数通过');
    detail(`读数 ${readings} 组（[M]/[L]/[D]/[H]/[F]/[R]）；下架（\`post.hide\`）审计写面已由迁移 0047 **真落库**，`
      + '[H] 段那一条是从 `public.admin_audit_events` 读回来的真行（⛔ 不是进程内台账）；'
      + '人工通过/驳回的审计仍只落进程内追加台账，且实模式下 `GET /admin/audit-events` 仍 503'
      + '（读面闭集留给下一片）——「HTTP 读面 503」不等于「审计不存在」');
  } finally {
    if (app !== null) await app.close().catch(() => {});
    if (pool !== null) await pool.end().catch(() => {});
    await owner.end().catch(() => {});
  }
}

await main();
