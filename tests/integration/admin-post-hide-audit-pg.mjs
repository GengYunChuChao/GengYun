/**
 * R64 · 后台「下架」审计**真落库** + fail-closed · 真实 PostgreSQL 17 集成臂
 *
 * ## 本片证的那一条
 * 基线里 `POST /admin/posts/{id}/hide` 的留痕只进进程内台账（`admin/ops/service.ts::hidePost`
 * 的 `appendAudit`）——换一个进程就是零。R64 把它改成：下架的可见性变更与审计行在**同一个事务**里，
 * 审计写不进去就整笔 `ROLLBACK`（帖子**不被隐藏**），并如实回 503。库层写入点只有一个：
 * 迁移 `0047_admin_post_hide_audit.sql` 的 `public.record_admin_post_hide_audit(uuid,uuid,integer,text,uuid)`，
 * 它自己校验「操作者存在 / state='active' / 现行持有 sources:write」，且 action/scope/result/target_ref
 * 全部在函数内写死（调用方只能给 actor 与帖子，改不了动作文本）。
 *
 * ## 覆盖的读数（前缀与派单 §4 对齐）
 *   [M] 迁移与装配：PG17 / 空库前提 / 迁移子集逐条 apply 且二连跑 0 条 / 0047 的函数真的在且是
 *       `SECURITY DEFINER` 且 PUBLIC 不可执行 / real + 真 pool ⇒ 社区帖子端口 `persistent === true`
 *       （= 下架路径放行的判据）/ 后台内容域台账仍是 `persistent === false`（读面闭集留给下一片）；
 *   [A] 隐藏成功 ⇒ `public.admin_audit_events` **恰好 1 行** `post.hide`：actor_id＝该管理员、
 *       scope=`sources:write`、result=`accepted`、reason_code=`post_hidden`、
 *       target_ref={type:'post',id,revision:**下架前**的 1}、target_hint=NULL、request_id 非空；
 *       **负控制**：把 0047 的 `action` 字面量改成 `post_hide` ⇒ 本条红（[A] 读的是真表里的值）；
 *   [A2] **读写面互不伤害**：不带 action 过滤的 `public.list_admin_audit_logs(...)` 必须**正常返回**、行数
 *       **恰好**等于真表行数且**含**这条 `post.hide`（R67-D10：原为 `>= 1`；期望值＝[A] 的真表读数）；
 *       **负控制**：去掉 0047 里的 `REVOKE`/把行写成 `reason_code=''` ⇒ 读面在 `p_reason_code`
 *       断言处红，而不是静默通过；
 *   [B] **同事务返修臂**：用 `BEFORE INSERT … WHEN (NEW.action='post.hide')` 触发器让审计写入失败 ⇒
 *       响应 **503 `PROVIDER_UNAVAILABLE`**、`retryable:false`、message 含「审计写入失败」；
 *       帖子 `visibility` **仍是 `published`**、`revision` **未变**、审计表**零新增**；
 *       **负控制**：把 `commitPost` 的审计调用挪到事务外（或吞掉异常）⇒ 本条红（行会变成 hidden）；
 *   [C] 幂等臂：已隐藏再隐藏 ⇒ 200、ETag 不变、`community_posts` 逐列不变、审计**不多出行**；
 *       **负控制**：让适配层在 `changed:false` 时也写审计 ⇒ 本条红。
 *
 * ## 未取得（如实登记）
 *   - 审计 HTTP 读面 `GET /admin/audit-events` 在 real 模式下仍 503（内容域 `persistent:false`）；
 *     本片**不动**读面闭集（`catalog.ts` 的 `AUDIT_ACTIONS` 与契约查询 enum 留给下一片，#652 在飞）；
 *   - 真实审核供应商（合成 gate 夹具）、真实 UI、下架后的运维值班流程；
 *   - 运行时角色的库级最小权限面（本脚本读数一律库 owner 身份；授权面由
 *     `deploy/postgres-cvm/sql/20-login-roles.sql` 与 `90-assert-least-privilege.sql` 的断言守）。
 *
 * ## 运行（专用测试库，必须是**空库**）
 *   createdb -h 127.0.0.1 -p <port> gengyun_admin_post_hide_audit_test
 *   node tests/integration/admin-post-hide-audit-pg.mjs \
 *     postgres://<owner>@127.0.0.1:<port>/gengyun_admin_post_hide_audit_test
 * 也接受 env `ADMIN_POST_HIDE_AUDIT_PG_TEST_URL`（argv 优先）。未设置 ⇒ 打印 SKIP 并以 **77** 退出：
 * 本次运行**没有**取得读数，不是通过；本机明知无真库时可显式 `--allow-skip` 取 0（⛔ 不得进门禁）。
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';

import { loadConfig } from '../../services/api/src/config.ts';
import { buildApp } from '../../services/api/src/app.ts';
import { createPool } from '../../services/api/src/db/pool.ts';
import { applyMigrations, discoverMigrations } from '../../services/api/src/db/migrate.ts';
import { COMMUNITY_POST_SQL, createPostgresCommunityStore } from '../../services/api/src/community/store-pg.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { makeGate } from '../unit/community-fixtures.mjs';

const API = '/api/v1';
const DB = 'gengyun_admin_post_hide_audit_test';
const ENV = 'ADMIN_POST_HIDE_AUDIT_PG_TEST_URL';
/** 契约 `OPS_SCOPES.hidePost`（`admin/ops/service.ts`）。 */
const HIDE_SCOPE = 'sources:write';
/**
 * 本脚本只 apply 它**真正依赖**的迁移：
 *   0001 身份底座（`users`/`admin_accounts`/`admin_scopes` 与枚举）；
 *   0017 `admin_audit_events`（0047 的 `INSERT` 依赖它）；
 *   0022 社区表（`community_posts` + 结论行，读面 `effectiveState()` 需要）；
 *   0030/0032 作者/举报者注销引用列（`POST_COLUMNS` 口径，缺它社区域 42703 ⇒ 503）；
 *   0045 `community_moderation_decisions.decided_by`（结论快照列，缺它审核写面 503）；
 *   0047 本片的主角：`record_admin_post_hide_audit(...)`（缺它 ⇒ 下架 42883 ⇒ 503「审计写入失败」）；
 *   0027 `admin_audit_events` 的 `before_value`/`after_value` 两列 + 0033 只读函数
 *        `list_admin_audit_logs(...)` —— **[A2] 段的依赖**：本片不新增读面（读面闭集留给下一片），
 *        但要证明「下架写进去的那一行，用**既有**库内读函数按 `action='post.hide'` 筛得出来」。
 *        0033 的函数体直接投影 `e.before_value, e.after_value`，所以 0027 必须先在它上面 apply
 *        （缺 0033 ⇒ 42883；缺 0027 ⇒ 0033 建函数时 42703）。
 */
const MIGRATIONS = ['0001', '0017', '0022', '0027', '0030', '0032', '0033', '0045', '0047'];

const argvUrl = process.argv.slice(2).find((value) => /^postgres(ql)?:\/\//.test(value));
const rawUrl = argvUrl ?? process.env[ENV];
const ALLOW_SKIP = process.argv.includes('--allow-skip') || process.env.GY_ALLOW_SKIP === '1';
if (rawUrl === undefined || rawUrl.trim() === '') {
  console.log(`SKIP real PG17: ${ENV} 未设置（argv 里也没有 postgres URL）——本次运行没有取得下架审计真库读数（不是通过）。`);
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
assert.equal(url.pathname, `/${DB}`, `只允许专用测试库 ${DB}`);

let readings = 0;
const note = (message) => {
  readings += 1;
  console.log(message);
};
const detail = (message) => console.log(`      ${message}`);

const digest = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const AT = (minutes) => new Date(Date.parse('2026-10-18T02:00:00.000Z') + minutes * 60_000).toISOString();

const gate = makeGate();
const RULE_VERSION = gate.currentRuleVersion();

/** 帖子存储记录（形状与 `tests/integration/admin-community-posts-pg.mjs` 同一套口径）。 */
const postRecord = (id, authorId, overrides = {}) => ({
  id,
  revision: 1,
  author_id: authorId,
  title: `下架审计真库夹具 ${overrides.tag ?? 'x'}`,
  body: `下架审计真库夹具正文 ${overrides.tag ?? 'x'}`,
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

/** 审核结论必须逐条真实，否则读取时被降级成 hidden+pending（假绿）。 */
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
    assert.equal(tables, 0, '专用测试库必须是空库（本脚本会建表/灌夹具；非空库会互相污染）');
    note(`[M] PG ${version} · 空库前提成立（public 下 0 张表）`);

    const discovered = discoverMigrations();
    for (const required of MIGRATIONS) {
      assert.ok(discovered.some((migration) => migration.version === required), `迁移目录必须含 ${required}`);
    }
    const picked = discovered.filter((migration) => MIGRATIONS.includes(migration.version));
    assert.deepEqual((await applyMigrations(owner, picked)).applied, MIGRATIONS, '七段迁移必须逐条真正应用');
    assert.equal((await applyMigrations(owner, picked)).applied.length, 0, '重跑迁移必须是 no-op');

    const fn = (await owner.query(
      `SELECT p.prosecdef, p.provolatile,
              pg_get_userbyid(p.proowner) AS owner,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_may_exec
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'record_admin_post_hide_audit'`,
    )).rows;
    assert.equal(fn.length, 1, '0047 必须只留下一份 record_admin_post_hide_audit');
    assert.equal(fn[0].prosecdef, true, '审计函数必须是 SECURITY DEFINER（写表要越过调用方的表权限）');
    assert.equal(fn[0].public_may_exec, false, 'PUBLIC 不得可执行（运行时角色按 name 精确授权）');
    note(`[M] 迁移子集 ${MIGRATIONS.join('+')} 逐条 apply、二连跑 0 条；0047 函数在且 SECURITY DEFINER、PUBLIC 不可执行`);

    const columns = (await owner.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('community_posts', 'admin_audit_events', 'admin_scopes')`,
    )).rows;
    const has = (table, name) => columns.some((row) => row.table_name === table && row.column_name === name);
    for (const [table, name] of [
      ['community_posts', 'visibility'],
      ['community_posts', 'revision'],
      ['community_posts', 'updated_at'],
      ['admin_audit_events', 'target_ref'],
      ['admin_audit_events', 'reason_code'],
      ['admin_audit_events', 'request_id'],
      ['admin_scopes', 'revoked_at'],
    ]) {
      assert.equal(has(table, name), true, `${table}.${name} 必须存在（否则不是 503 就是读数无意义）`);
    }
    note('[M] 依赖列在位：admin_audit_events.{target_ref,reason_code,request_id}、admin_scopes.revoked_at、community_posts.{visibility,revision,updated_at}');

    // -----------------------------------------------------------------------
    // 夹具：三个真实用户 + 一条后台管理员（内存认证 + 真库镜像）
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
    const author = await account('a');
    const other = await account('b');

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
      // 0047 的函数在**库里**再核一遍操作者（存在 / active / 现行 sources:write）：
      // 内存账号必须镜像到真库，否则函数 G0002/G0010 ⇒ 503（这不是补数据，是挡「进程里认了、库里不认」）。
      await owner.query(
        'INSERT INTO admin_accounts (id, login_name, credential_hash) VALUES ($1::uuid, $2, $3)',
        [userId, loginName, 'synthetic-not-a-real-credential-hash'],
      );
      for (const scope of scopes) {
        await owner.query('INSERT INTO admin_scopes (admin_id, scope) VALUES ($1::uuid, $2)', [userId, scope]);
      }
      return { userId, token };
    };
    const hideAdmin = await admin('synthetic-r64-posthide-admin', [HIDE_SCOPE]);

    pool = createPool(url.href);
    const store = createPostgresCommunityStore({ pool });
    assert.equal(store.persistent, true, 'PG 社区 store 必须自述持久化（= app.ts 的 hidePost 放行判据）');

    const P1 = postRecord(randomUUID(), author.user.id, { tag: 'audit-ok', created_at: AT(1), updated_at: AT(1) });
    const P2 = postRecord(randomUUID(), author.user.id, { tag: 'audit-fail', created_at: AT(2), updated_at: AT(2) });
    for (const record of [P1, P2]) {
      assert.equal(await store.insertPost(record, verdictFor(record)), true, `夹具帖 ${record.id} 必须落库`);
    }
    note('[M] 夹具 2 条 published 帖真落 community_posts；管理员镜像进 admin_accounts + admin_scopes(sources:write)');

    const baseConfig = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
    const realConfig = { ...baseConfig, executionMode: 'real', requiresRealCredentials: true };
    app = buildApp({
      config: realConfig,
      store: auth,
      pool,
      now: () => new Date(),
      communityInjection: { gate },
    });
    assert.notEqual(app.communityService, null, 'real + 真 pool ⇒ 社区服务必须开启');
    assert.notEqual(app.adminOpsService, null, 'real + 真 pool ⇒ 后台运营服务必须存在');
    assert.equal(app.adminOpsService.store.persistent, false,
      '如实标注：后台**内容域**台账仍是内存实现（读面闭集留给下一片 #652）——本脚本证的是写面落库');

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

    /** 行快照：下架是不是真的落库，只看这张表的真值。 */
    const snapshotOf = async (id) => (await owner.query(
      `SELECT visibility, revision, updated_at, audit_state, title, body, author_id
         FROM public.community_posts WHERE id = $1::uuid`,
      [id],
    )).rows[0];

    /** 审计行（真表，不是进程内台账）。 */
    const auditRows = async () => (await owner.query(
      `SELECT id, actor_id, action, scope, result, reason_code, request_id, target_ref, target_hint
         FROM public.admin_audit_events WHERE action = 'post.hide' ORDER BY created_at, id`,
    )).rows;

    // -----------------------------------------------------------------------
    // [A] 隐藏成功 ⇒ 审计**恰好 1 行**，逐项正确
    // -----------------------------------------------------------------------
    const before1 = await snapshotOf(P1.id);
    assert.equal(before1.visibility, 'published');
    assert.equal(before1.revision, 1);
    const hide1 = await hideOf(P1.id, { ifMatch: '"1"', key: 'r64-posthide-ok' });
    assert.equal(hide1.status, 200, hide1.text.slice(0, 300));
    assert.deepEqual(hide1.body.data, { accepted: true }, '契约 Ack 必须恰好是 {accepted:true}');
    assert.equal(hide1.headers.etag, '"2"', '下架把 revision 1→2 并回写 ETag');

    const after1 = await snapshotOf(P1.id);
    assert.equal(after1.visibility, 'hidden', '真库行必须真的变成 hidden');
    assert.equal(after1.revision, 2, '真库行 revision 必须 1→2');

    const rows1 = await auditRows();
    assert.equal(rows1.length, 1, `成功下架必须恰好新增一条 post.hide 审计（实际 ${rows1.length}）`);
    const [audit] = rows1;
    assert.equal(audit.action, 'post.hide');
    assert.equal(audit.scope, HIDE_SCOPE, '审计 scope 必须等于契约 OPS_SCOPES.hidePost');
    assert.equal(audit.result, 'accepted');
    assert.equal(audit.reason_code, 'post_hidden');
    assert.deepEqual(audit.target_ref, { type: 'post', id: P1.id, revision: 1 },
      'target_ref 必须带**下架前**的 revision（1），不是下架后的 2');
    assert.equal(audit.actor_id, hideAdmin.userId, '审计必须记在真正发起处置的管理员名下');
    assert.equal(audit.target_hint, null, 'post 在契约 TargetRef 闭集内 ⇒ 不写内部 target_hint');
    assert.equal(typeof audit.request_id, 'string');
    assert.match(audit.request_id, /^[0-9a-f-]{36}$/i, 'request_id 必须是真实请求 id（uuid），不是空串');
    note(`[A] 隐藏成功 ⇒ public.admin_audit_events 恰 1 行：actor=${audit.actor_id === hideAdmin.userId ? '该管理员' : '✗'} / scope=${audit.scope} / action=${audit.action} / result=${audit.result} / reason=${audit.reason_code} / target_ref={post,id,revision:1} / target_hint=NULL`);

    // 审计写入用的是同一份 SQL 常量（供真库臂与走查对齐：改函数名/参数序都会让这条先红）
    assert.match(COMMUNITY_POST_SQL.hideAudit, /record_admin_post_hide_audit\(\$1::uuid,\$2::uuid,\$3::integer,\$4::text,\$5::uuid\)/,
      '库层审计调用必须是字面量 SELECT，且参数序 =(actor, post, revision, reason, request)');
    note('[A] 库层调用口径：COMMUNITY_POST_SQL.hideAudit 是字面量 SELECT public.record_admin_post_hide_audit($1..$5)（无 FROM、不走调用方拼字符串）');

    // -----------------------------------------------------------------------
    // [A2] 读写面互不伤害：不带 action 过滤的审计读面必须能正常返回并**含**这条
    // -----------------------------------------------------------------------
    const listed = await owner.query(
      'SELECT id, action, scope, result, target_ref FROM public.list_admin_audit_logs(p_limit => 50)',
    );
    /*
     * 期望行数的来源（⛔ 不是魔数）：本臂到 [A2] 为止**只写过一次**审计——[A] 那笔成功下架。
     * 库层写入点只有 0047 的 `record_admin_post_hide_audit`，本脚本从不直接 INSERT
     * `public.admin_audit_events`；[B] 的失败路径按判据必须零留行、[C] 幂等臂排在它之后。
     * 所以此刻真表里应当恰好是 `rows1.length` 行（[A] 从**真表**读到的行数），而不带 action 过滤的
     * 读面必须把它们**一条不少、一条不多**地返回。此前这里写的是 `>= 1`：只要读面返回任意一行就绿，
     * 「读面漏行」和「读面重复行」两种翻车都会被放过。
     */
    const expectedListedRows = rows1.length;
    const trueAuditRows = (await owner.query(
      'SELECT count(*)::int AS n FROM public.admin_audit_events',
    )).rows[0].n;
    assert.equal(
      trueAuditRows,
      expectedListedRows,
      `真表 public.admin_audit_events 此刻必须恰好 ${expectedListedRows} 行（期望值 = [A] 的真表读数 rows1.length：`
        + `本臂只成功下架过 P1 一条，且 [B]/[C] 都在这一段之后），实际 ${trueAuditRows} 行；`
        + '这条同时钉住「本脚本没有第二个审计写入点」这个前提',
    );
    assert.equal(
      listed.rows.length,
      expectedListedRows,
      `list_admin_audit_logs 不带 action 过滤必须正常返回表里的**全部** ${expectedListedRows} 行`
        + '（期望值 = [A] 的真表读数 rows1.length，即本臂成功下架的次数；'
        + '写成「>= 1」时漏行/重复行都判绿，等于没判别力）'
        + `，实际 ${listed.rows.length} 行`,
    );
    const listedHide = listed.rows.filter((row) => row.action === 'post.hide');
    assert.equal(
      listedHide.length,
      expectedListedRows,
      `读面返回的 post.hide 行数必须等于本臂成功下架的次数 ${expectedListedRows}`
        + `（= [A] 的真表读数 rows1.length），实际 ${listedHide.length} 行`,
    );
    assert.equal(listedHide[0].id, audit.id, '读面返回的必须是同一行（同 id）');
    assert.deepEqual(listedHide[0].target_ref, { type: 'post', id: P1.id, revision: 1 });
    note(`[A2] 读面不受伤：public.list_admin_audit_logs(p_limit => 50) 正常返回 ${listed.rows.length} 行 = 真表全部 ${trueAuditRows} 行，其中 post.hide 恰 ${listedHide.length} 行且同 id（#654 的翻车点在这里钉住）`);

    // -----------------------------------------------------------------------
    // [B] 同事务返修臂：审计写不进去 ⇒ 整笔回滚、如实 503
    // -----------------------------------------------------------------------
    await owner.query(`
      CREATE FUNCTION public.r64_reject_post_hide_audit() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'r64 synthetic failure: refuse post.hide audit row';
      END $fn$;
      REVOKE ALL ON FUNCTION public.r64_reject_post_hide_audit() FROM PUBLIC;
      CREATE TRIGGER r64_reject_post_hide_audit
        BEFORE INSERT ON public.admin_audit_events
        FOR EACH ROW WHEN (NEW.action = 'post.hide')
        EXECUTE FUNCTION public.r64_reject_post_hide_audit();
    `);
    try {
      const before2 = await snapshotOf(P2.id);
      const auditCountBefore = (await auditRows()).length;
      const failed = await hideOf(P2.id, { ifMatch: '"1"', key: 'r64-posthide-audit-fail' });
      assert.equal(failed.status, 503,
        `审计写不进去必须 503（不是 409、不是 200），实际 ${failed.status} ${failed.text.slice(0, 240)}`);
      assert.equal(failed.body.error.code, 'PROVIDER_UNAVAILABLE', '错误码必须是 PROVIDER_UNAVAILABLE');
      assert.equal(failed.body.error.retryable, false, '审计写入失败不可重试（重试仍是同一笔写入）');
      assert.match(failed.body.error.message, /审计写入失败/, `message 必须含「审计写入失败」，实际 ${failed.body.error.message}`);

      const after2 = await snapshotOf(P2.id);
      assert.deepEqual(after2, before2,
        '审计失败 ⇒ 整笔 ROLLBACK：visibility 仍 published、revision 未变、其余列一字不动');
      assert.equal(after2.visibility, 'published', '帖子**不能**被隐藏（fail-closed）');
      assert.equal(after2.revision, 1, 'revision 不能前进');
      assert.equal((await auditRows()).length, auditCountBefore, '失败路径不得留下审计行');
      note(`[B] 返修臂：触发器令 post.hide 写入抛错 ⇒ 503 PROVIDER_UNAVAILABLE(retryable:false, message 含「审计写入失败」)；帖子 visibility 仍 ${after2.visibility}、revision=${after2.revision}、审计零新增`);
    } finally {
      await owner.query(`
        DROP TRIGGER IF EXISTS r64_reject_post_hide_audit ON public.admin_audit_events;
        DROP FUNCTION IF EXISTS public.r64_reject_post_hide_audit();
      `);
    }

    // 拆掉触发器后同一条路径必须恢复可写（证明上一条红的是触发器而不是坏掉的账号/scope）
    const recover = await hideOf(P2.id, { ifMatch: '"1"', key: 'r64-posthide-recover' });
    assert.equal(recover.status, 200, `拆掉触发器后必须恢复 200，实际 ${recover.status} ${recover.text.slice(0, 240)}`);
    assert.equal((await auditRows()).length, 2, '恢复后应恰好多出一条（共 2 条）');
    note('[B] 负控制的对照臂：拆掉触发器后同一路径恢复 200，审计 +1（说明被挡住的确实是审计写入，不是权限/账号）');

    // -----------------------------------------------------------------------
    // [C] 幂等臂：已隐藏再隐藏 ⇒ 不重复记处置
    // -----------------------------------------------------------------------
    const beforeReplay = await snapshotOf(P1.id);
    const auditCountBeforeReplay = (await auditRows()).length;
    const replay = await hideOf(P1.id, { ifMatch: '"2"', key: 'r64-posthide-replay' });
    assert.equal(replay.status, 200, `已隐藏再下架必须 200（changed:false），实际 ${replay.status}`);
    assert.deepEqual(replay.body.data, { accepted: true });
    assert.equal(replay.headers.etag, '"2"', 'changed:false 时 ETag 仍是当前版本');
    assert.deepEqual(await snapshotOf(P1.id), beforeReplay, 'changed:false 不得再改真库行');
    assert.equal((await auditRows()).length, auditCountBeforeReplay, 'changed:false 不得新增审计（不把幂等成功记成一次处置）');
    note('[C] 幂等：已隐藏再隐藏 ⇒ 200 accepted、ETag 不变、行逐列不变、post.hide 审计仍 2 条（不多出）');

    console.log('---------------------------------------------');
    console.log(`PASS admin-post-hide-audit-pg · 读数 ${readings} 条 · 全部断言通过`);
    console.log('---------------------------------------------');
  } finally {
    if (app !== null) await app.close();
    if (pool !== null) await pool.end();
    await owner.end();
  }
}

main().catch((error) => {
  console.error(`FAIL admin-post-hide-audit-pg: ${error?.stack ?? error}`);
  process.exit(1);
});
